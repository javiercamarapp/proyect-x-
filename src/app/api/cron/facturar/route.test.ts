import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// EL CRON DE FACTURACIÓN — el cable, que es donde estaba el agujero.
//
// Las piezas existían todas —el adaptador de CAPUFE, el registro por flota, el
// navegador de verdad— y ninguna estaba conectada: la ruta llamaba a
// `facturarAlVuelo` sin haber registrado un solo adaptador, así que cada ticket
// salía "sin_adaptador" y el cron respondía 200. Verde en el panel de Vercel,
// cero facturas. Un cron en verde que no hace nada es peor que uno en rojo.
//
// Lo que estas pruebas fijan es el CABLE, no la lógica de facturar (esa vive en
// `al_vuelo.test.ts` y `capufe.test.ts`):
//
//   1. Se abre UN navegador POR FLOTA, no uno por ticket. Es la decisión de
//      costo del producto.
//   2. Nunca se comparte navegador ENTRE flotas: el contexto lleva las cookies y
//      CAPUFE podría recordar el RFC de la anterior.
//   3. Si Chromium no arranca —que es HOY, en Vercel— la respuesta es 503 con el
//      motivo, y los tickets NO se tocan: `facturarAlVuelo` es quien pone el
//      sello de intentado, así que no llamarlo es lo que los deja para la
//      corrida siguiente.
//   4. La cola se pide en el orden de la 0063, o los mismos ocho tickets que no
//      proceden se llevan todas las corridas.
//   5. Antes de abrir CADA navegador nuevo se comprueba el reloj contra el
//      presupuesto de la invocación (`MARGEN_LOTE_MS` en `route.ts`). Si ya no
//      alcanza para otra sesión completa, el lote se corta ahí —no se abre la
//      sesión— y esa flota queda sin marcar, igual que cuando Chromium no
//      arranca. Es el hallazgo ALTO de `docs/auditoria-10/rendimiento.md`: el
//      comentario decía "ocho sesiones caben con margen en 300s" y eran 480s.
// ═══════════════════════════════════════════════════════════════════════════

const SECRETO = 'cron-secreto-de-prueba';
process.env.CRON_SECRET = SECRETO;
delete process.env.FACTURACION_MODO;

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger }));

// El canal de alerta al operador (auditoría 4, D1) se mockea: aquí se prueba
// que el cron LO DISPARA al fallar, no el canal (observability/alerta.test.ts).
const alertarOperador = vi.fn(async () => {});
vi.mock('@/lib/observability/alerta', () => ({
  alertarOperador: (...a: unknown[]) => alertarOperador(...(a as [])),
}));

// El kill switch (0110). Default: sin fila = encendido (false) — así TODAS
// las pruebas existentes prueban de paso que sin interruptor el cron corre.
const estaApagado = vi.fn(async (nombre: string) => nombre === '__ninguno_apagado__');
/** AUDITORÍA 18 (A17): los crons leen `leerInterruptor`, que distingue
 *  apagado de ILEGIBLE. `estaApagado` sigue siendo la palanca de las pruebas
 *  viejas (true = apagado); `ilegibles` marca qué lecturas fallan. */
const ilegibles = new Set<string>();
vi.mock('@/lib/likida/interruptores', () => ({
  leerInterruptor: async (nombre: string) =>
    ilegibles.has(nombre) ? 'ilegible' : (await estaApagado(nombre)) ? 'apagado' : 'encendido',
}));

/** Lo que devuelve la consulta de la cola. */
let cola: { data: Array<Record<string, unknown>> | null; error: { message: string } | null };
/** ESC-5: lo que devuelve el CONTEO del backlog (`select(id,{count,head})`).
 *  `null` = el default honesto: tantos como filas tenga la cola. */
let backlog: { count: number | null; error: { message: string } | null } | null;
const consulta: Array<[string, unknown[]]> = [];

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      const nodo: Record<string, unknown> = {};
      /** El conteo del backlog no trae filas: `head: true` y devuelve `count`. */
      let esConteo = false;
      for (const m of ['select', 'eq', 'is', 'not', 'gte', 'order', 'limit']) {
        nodo[m] = (...a: unknown[]) => {
          consulta.push([`${tabla}.${m}`, a]);
          if (m === 'select' && (a[1] as { head?: boolean } | undefined)?.head) esConteo = true;
          return nodo;
        };
      }
      nodo.then = (r: (v: unknown) => unknown) => Promise.resolve(
        esConteo
          ? (backlog ?? { count: cola.data?.length ?? 0, error: cola.error })
          : cola,
      ).then(r);
      return nodo;
    },
  }),
}));

/** ESC-5: QStash. Sin `UPSTASH_QSTASH_TOKEN` el cron va por el camino
 *  síncrono —el que ejercitan casi todas las pruebas de este archivo—; con
 *  token, encola UN mensaje por flota y este doble los captura. */
const publishJSON = vi.fn(async (_m: Record<string, unknown>) => ({ messageId: `msg-${publishJSON.mock.calls.length}` }));
vi.mock('@upstash/qstash', () => ({
  Client: class { publishJSON = (...a: unknown[]) => publishJSON(...(a as [Record<string, unknown>])); },
  Receiver: class { verify = async () => true; },
}));

const facturarAlVuelo = vi.fn(async (a: { gastoId: string }) => ({
  intentado: true, facturado: false, detalle: `ensayo de ${a.gastoId}`,
}));
/**
 * Los tickets CON portal automatizable van por AQUÍ, no por `facturarAlVuelo`:
 * es el camino que agrupa por portal dentro de la flota (ver el comentario de
 * `correrLote` en `route.ts`). El default de este archivo (`fila()`) es un
 * ticket de CAPUFE, así que hasta las pruebas de un solo ticket pasan por el
 * lote.
 */
/** El renglón por gasto que devuelve el lote: `motivo` es opcional y es lo
 *  que RES-21 cuenta, así que el tipo tiene que admitirlo. */
type RenglonLote = { gastoId: string; intentado: boolean; facturado: boolean; detalle?: string; motivo?: string };
const facturarLoteAlVuelo = vi.fn(async (a: { gastoIds: string[] }): Promise<{
  porGasto: RenglonLote[];
  facturados: number;
  bloqueados: Array<{ gastoId: string; motivo: string }>;
}> => ({
  porGasto: a.gastoIds.map((gastoId) => ({
    intentado: true, facturado: false, detalle: `ensayo de ${gastoId}`, gastoId,
  })),
  facturados: 0,
  bloqueados: [],
}));
vi.mock('@/lib/likida/facturacion/al_vuelo', () => ({ facturarAlVuelo, facturarLoteAlVuelo }));

/** Qué datos fiscales tiene cada flota. */
let fiscalPorFlota: Record<string, { flota: unknown; falta: string[] }>;
const getFiscalDeFlota = vi.fn(async (t: string) =>
  fiscalPorFlota[t] ?? { flota: null, falta: ['sin ficha'] });
vi.mock('@/lib/likida/facturacion/flota_fiscal', () => ({ getFiscalDeFlota }));

/** `null` = Chromium arranca. Un string = no arranca, con ese mensaje. */
let navegadorRoto: string | null = null;
const navegadoresAbiertos: number[] = [];
/**
 * Cuánto "tarda" cada sesión de navegador, en el orden en que se abren (FIFO).
 * Vacío por default: el reloj no avanza y ninguna prueba existente se entera
 * de este mecanismo. Lo usa el presupuesto de tiempo del lote (más abajo) para
 * simular, sin esperar de verdad, que una sesión se comió los segundos que dice
 * el peor caso medido en `docs/auditoria-10/rendimiento.md`.
 */
const duracionSesionesMs: number[] = [];
const conNavegador = vi.fn(async (
  fn: (abrir: unknown, sesion: unknown) => Promise<unknown>,
  _op?: { storageState?: string; pagina?: unknown },
) => {
  // `conNavegador` arranca Chromium ANTES de correr el cuerpo. Si lanza aquí, el
  // cuerpo no se ejecuta — que es justo lo que la ruta usa para distinguir "no
  // hay navegador" de "el lote falló".
  if (navegadorRoto) throw new Error(navegadorRoto);
  const dura = duracionSesionesMs.shift();
  if (dura) vi.setSystemTime(Date.now() + dura);
  navegadoresAbiertos.push(Date.now());
  // El segundo argumento es la `SesionNavegador`: la ruta le pide el
  // `storageState` al terminar para volver a guardarlo (cookies rotadas).
  return fn(async () => ({}), { estadoDeSesion: async () => null });
});
vi.mock('@/lib/likida/facturacion/adaptadores/pagina_playwright', () => ({ conNavegador }));

/**
 * EL VÍNCULO CON LOS PORTALES. Se mockea entero porque toca el cofre y la
 * tabla `portal_estado`, y estas pruebas miden el CRON —qué se abre, qué se
 * marca, qué se corta por reloj—, no el cifrado.
 *
 * El default es "esta flota no tiene ninguna sesión guardada", que es el
 * estado en el que corren todas las pruebas de este archivo: ninguna de ellas
 * vincula nada, y el comportamiento que fijan es el de siempre.
 */
let vigentes = { porComercio: new Map<string, unknown>(), storageState: null as string | null, vencidasPorEdad: [] as string[] };
const sesionesVigentes = vi.fn(async () => vigentes);
const refrescarSesiones = vi.fn(async (_a: { portales: ReadonlyMap<string, string> }) => [] as string[]);
const invalidarVinculo = vi.fn(async (_a: { comercio: string; clase: string }) => {});
vi.mock('@/lib/likida/facturacion/vinculo_portal', () => ({
  sesionesVigentes: (...a: unknown[]) => sesionesVigentes(...(a as [])),
  refrescarSesiones: (...a: unknown[]) => refrescarSesiones(...(a as [Parameters<typeof refrescarSesiones>[0]])),
  invalidarVinculo: (...a: unknown[]) => invalidarVinculo(...(a as [Parameters<typeof invalidarVinculo>[0]])),
}));

const conPortales = vi.fn(async (_op: unknown, fn: (r: unknown) => Promise<unknown>) =>
  fn({ registrados: ['capufe'], problemas: [] }));
vi.mock('@/lib/likida/facturacion/adaptadores/registro', () => ({
  conPortales,
  PORTALES_CONOCIDOS: ['capufe'] as readonly string[],
  // El piloto de visión queda APAGADO en estas pruebas: miden el camino de
  // los adaptadores escritos. Con la palanca apagada, operables == conocidos.
  portalesOperables: () => ['capufe'] as readonly string[],
  pilotoHabilitado: () => false,
}));

/**
 * El cierre de corridas se mockea para poder MIRAR qué mapa le llega: es donde
 * viaja la marca de «fallo de plataforma» (B8). Y `avisar` también (B2): es
 * por donde sale el aviso de cola atorada, y estas pruebas necesitan VER la
 * llamada —a qué flota, con qué magnitud— sin arrastrar la base que el motor
 * real toca por dentro. Todo lo demás del módulo se queda real —en particular
 * `FalloDePlataforma`, que la ruta usa para marcar— porque mockear la clase
 * rompería el `instanceof` que se está probando.
 */
/** RES-21: el historial que decide si ÉSTA es la tercera corrida seca. */
const ultimasCorridas = vi.fn(async (): Promise<Array<{ resumen: Record<string, unknown> | null }>> => []);
const registrarCorrida = vi.fn(async () => {});
vi.mock('@/lib/likida/agentes/corridas', () => ({
  registrarCorrida: (...a: unknown[]) => registrarCorrida(...(a as [])),
  ultimasCorridas: (...a: unknown[]) => ultimasCorridas(...(a as [])),
}));

const avisarCorridasPorFlota = vi.fn(async () => {});
const avisar = vi.fn(async (..._a: unknown[]) => ({ avisado: true, porque: 'ok', destinatarios: 1, magnitud: 1 }));
vi.mock('@/lib/likida/agentes/notificaciones', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/likida/agentes/notificaciones')>()),
  avisarCorridasPorFlota: (...a: unknown[]) => avisarCorridasPorFlota(...(a as [])),
  avisar: (...a: unknown[]) => avisar(...(a as [])),
}));

/** El aviso por WhatsApp al encargado (`avisarALasPersonas`) resuelve su
 *  teléfono por aquí. `null` = flota sin teléfono capturado: ese camino se
 *  corta solo y sin tocar más base — lo que estas pruebas miran es el aviso
 *  de CORREO de la cola (B2), no el de WhatsApp. */
const telefonoJefeDe = vi.fn(async (): Promise<string | null> => null);
vi.mock('@/lib/likida/contactos', () => ({
  telefonoJefeDe: (...a: unknown[]) => telefonoJefeDe(...(a as [])),
}));

/** AUDITORÍA 24 (BE-6): el latido y su lectura, observables. Todo lo demás
 *  de `salud` (la puerta) se queda real. */
const registrarLatido = vi.fn(async (..._a: unknown[]) => {});
const leerLatido = vi.fn(async (..._a: unknown[]): Promise<{ ultimoLatido: string; estado: string; detalle: Record<string, unknown> } | null> => null);
vi.mock('@/lib/admin/salud', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin/salud')>()),
  registrarLatido: (...a: unknown[]) => registrarLatido(...a),
  leerLatido: (...a: unknown[]) => leerLatido(...a),
}));

const { GET } = await import('./route');
const { FalloDePlataforma } = await import('@/lib/likida/agentes/notificaciones');
const { appUrl } = await import('@/lib/env');

/** Una fila de la cola. Por default, un ticket de CAPUFE. */
const CAPUFE = { urlFacturacion: 'https://facturacioncapufe.com.mx/Capufe/', codigo: 'X' };
/** OXXO Gas exige cuenta: no lo opera ningún adaptador. */
const OTRO = { urlFacturacion: 'https://facturacion.oxxogas.com/' };

const fila = (o: Record<string, unknown> = {}) => ({
  id: 'g-1', tenant_id: 't-1', concepto: 'caseta', monto: 180, fecha: '2026-08-03',
  folio: 'CAPUFE000000000001', rfc_emisor: null, cfdi_uuid: null, ocr_extra: CAPUFE,
  ...o,
});

const FISCAL = {
  tenantId: 't-1', rfc: 'XAA010101000', nombre: 'FLOTA DE PRUEBA SA DE CV',
  codigoPostal: '37000', regimenFiscal: '601', usoCfdi: 'G03', correo: 'f@x.mx',
};

const pedir = (auth = `Bearer ${SECRETO}`) =>
  GET(new Request('https://app.likida.ai/api/cron/facturar', { headers: { authorization: auth } }));

beforeEach(() => {
  cola = { data: [fila()], error: null };
  backlog = null;
  delete process.env.UPSTASH_QSTASH_TOKEN;
  delete process.env.QSTASH_CURRENT_SIGNING_KEY;
  delete process.env.QSTASH_NEXT_SIGNING_KEY;
  registrarLatido.mockClear();
  leerLatido.mockReset();
  leerLatido.mockResolvedValue(null);
  publishJSON.mockClear();
  publishJSON.mockImplementation(async () => ({ messageId: `msg-${publishJSON.mock.calls.length}` }));
  consulta.length = 0;
  navegadorRoto = null;
  navegadoresAbiertos.length = 0;
  duracionSesionesMs.length = 0;
  fiscalPorFlota = { 't-1': { flota: FISCAL, falta: [] }, 't-2': { flota: { ...FISCAL, tenantId: 't-2' }, falta: [] } };
  facturarAlVuelo.mockClear();
  facturarLoteAlVuelo.mockClear();
  getFiscalDeFlota.mockClear();
  conNavegador.mockClear();
  conPortales.mockClear();
  vigentes = { porComercio: new Map(), storageState: null, vencidasPorEdad: [] };
  sesionesVigentes.mockClear();
  refrescarSesiones.mockClear();
  invalidarVinculo.mockClear();
  avisarCorridasPorFlota.mockClear();
  registrarCorrida.mockClear();
  ultimasCorridas.mockReset();
  ultimasCorridas.mockResolvedValue([]);
  delete process.env.FACTURACION_MANDATO_ACEPTADO;
  telefonoJefeDe.mockClear();
  avisar.mockReset();
  avisar.mockResolvedValue({ avisado: true, porque: 'ok', destinatarios: 1, magnitud: 1 });
  estaApagado.mockReset().mockResolvedValue(false);
  ilegibles.clear();
  for (const f of Object.values(logger)) f.mockReset();
});

describe('la puerta', () => {
  it('sin CRON_SECRET la ruta devuelve 500 y NO corre', async () => {
    const antes = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    const res = await pedir();
    process.env.CRON_SECRET = antes;

    expect(res.status).toBe(500);
    expect(facturarAlVuelo).not.toHaveBeenCalled();
  });

  it('con el bearer equivocado, 401', async () => {
    expect((await pedir('Bearer otro')).status).toBe(401);
    expect(facturarAlVuelo).not.toHaveBeenCalled();
  });
});

describe('el kill switch (0110)', () => {
  it("con 'global' apagado: 200 con {saltado}, sin tocar la cola ni abrir navegador", async () => {
    estaApagado.mockImplementation(async (n: string) => n === 'global');
    const res = await pedir();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ corrio: false, saltado: 'interruptor global' });
    // Ni la consulta de la cola (los tickets no se marcan), ni navegador, ni
    // el camino de "sin adaptadores": la ruta se detiene ANTES de todo eso.
    expect(consulta).toHaveLength(0);
    expect(conNavegador).not.toHaveBeenCalled();
    expect(facturarAlVuelo).not.toHaveBeenCalled();
    expect(facturarLoteAlVuelo).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('cron.facturar.saltado', { interruptor: 'global' });
  });

  it("con 'agente:facturas' apagado (y global encendido): salta igual, y dice CUÁL palanca fue", async () => {
    estaApagado.mockImplementation(async (n: string) => n === 'agente:facturas');
    const res = await pedir();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ corrio: false, saltado: 'interruptor agente:facturas' });
    expect(facturarLoteAlVuelo).not.toHaveBeenCalled();
  });

  it("con 'global' ILEGIBLE: 500 con `codigo`, sin tocar la cola ni abrir navegador (A17)", async () => {
    ilegibles.add('global');
    const res = await pedir();

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ corrio: false, codigo: 'interruptor_ilegible', interruptor: 'global' });
    expect(consulta).toHaveLength(0);
    expect(conNavegador).not.toHaveBeenCalled();
    expect(facturarLoteAlVuelo).not.toHaveBeenCalled();
  });

  it("con 'agente:facturas' ILEGIBLE (y global encendido): 500 y dice CUÁL palanca no se pudo leer", async () => {
    ilegibles.add('agente:facturas');
    const res = await pedir();

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ codigo: 'interruptor_ilegible', interruptor: 'agente:facturas' });
    expect(facturarLoteAlVuelo).not.toHaveBeenCalled();
  });

  it('sin fila (el default) el cron corre — las palancas se consultaron y estaban en encendido', async () => {
    const cuerpo = await (await pedir()).json();

    expect(cuerpo.corrio).toBe(true);
    const consultados = estaApagado.mock.calls.map((c) => c[0]);
    expect(consultados).toEqual(['global', 'agente:facturas']);
  });

  it('con el bearer equivocado el interruptor NI SE LEE: la puerta va primero', async () => {
    await pedir('Bearer otro');
    expect(estaApagado).not.toHaveBeenCalled();
  });
});

describe('el día del cron es el de México (RES-13)', () => {
  it('a las 20:00 de México, `hoy` sigue siendo ese día, aunque en UTC ya sea mañana', async () => {
    // Antes: `toISOString().slice(0, 10)` — el día UTC. De las 18:00 a
    // medianoche hora de México el cron calculaba la caducidad con un día de
    // más y daba por vencido lo que vencía HOY.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-23T02:00:00Z')); // 22-ago 20:00 en CDMX
    try {
      await pedir();
    } finally {
      vi.useRealTimers();
    }
    const llamada = facturarLoteAlVuelo.mock.calls[0]?.[0] as { hoy?: string } | undefined;
    expect(llamada?.hoy).toBe('2026-08-22');
  });

  it('ningún archivo del agente de facturas vuelve a calcular el día en UTC', async () => {
    const { readFileSync } = await import('node:fs');
    for (const ruta of [
      'src/app/api/cron/facturar/route.ts',
      'src/app/api/cron/facturar/cola/route.ts',
      'src/lib/likida/facturacion/al_vuelo.ts',
      'src/lib/likida/facturacion/pendientes.ts',
    ]) {
      const fuente = readFileSync(ruta, 'utf8');
      expect(fuente, ruta).toContain("import { hoyMx } from '@/lib/formato'");
      // El patrón prohibido es EL DÍA DE HOY en UTC (`new Date()`), no toda
      // aritmética de fechas: `desdeVentana` sí resta días sobre una
      // fecha-solo en UTC, donde no hay zona que cruzar.
      expect(fuente.replace(/\/\/.*$/gm, ''), ruta).not.toMatch(/new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
    }
  });
});

describe('la cola', () => {
  it('se pide en el orden de la 0063: los nunca intentados primero', async () => {
    // Sin este orden, los ocho tickets más viejos que NO proceden salen elegidos
    // en cada corrida y los nuevos no entran nunca. La columna existía desde la
    // 0063 y la consulta la ignoraba.
    await pedir();

    const ordenes = consulta.filter(([m]) => m === 'gasto.order').map(([, a]) => a);
    expect(ordenes[0]).toEqual(['autofactura_intentada_en', { ascending: true, nullsFirst: true }]);
    expect(ordenes[1]).toEqual(['created_at', { ascending: true }]);
  });

  it('anuncia lo que NO cupo en el lote', async () => {
    // Un tope que no se anuncia se lee como "ya se facturó todo".
    cola = { data: Array.from({ length: 9 }, (_, i) => fila({ id: `g-${i}` })), error: null };
    const cuerpo = await (await pedir()).json();

    expect(cuerpo.intentados).toBe(8);
    expect(cuerpo.quedaron).toBe(1);
  });
});

describe('un navegador por flota, no uno por ticket', () => {
  it('tres tickets de la misma flota comparten UN navegador', async () => {
    cola = { data: [fila({ id: 'g-1' }), fila({ id: 'g-2' }), fila({ id: 'g-3' })], error: null };

    const cuerpo = await (await pedir()).json();

    expect(conNavegador).toHaveBeenCalledTimes(1);
    expect(conPortales).toHaveBeenCalledTimes(1);
    // Los tres comparten portal, así que van en UN lote, no en tres llamadas
    // sueltas a `facturarAlVuelo`.
    expect(facturarAlVuelo).not.toHaveBeenCalled();
    expect(facturarLoteAlVuelo).toHaveBeenCalledTimes(1);
    expect((facturarLoteAlVuelo.mock.calls[0][0] as { gastoIds: string[] }).gastoIds).toEqual(['g-1', 'g-2', 'g-3']);
    expect(cuerpo.corrio).toBe(true);
    expect(cuerpo.intentados).toBe(3);
  });

  it('dos flotas NO comparten navegador: el contexto lleva las cookies del portal', async () => {
    // `SesionNavegador` usa un solo BrowserContext para todas sus pestañas. Que
    // CAPUFE reconozca la sesión entre códigos es lo que se quiere DENTRO de una
    // flota y exactamente lo que no se quiere entre dos: podría recordar el RFC
    // de la anterior.
    cola = { data: [fila({ id: 'g-1', tenant_id: 't-1' }), fila({ id: 'g-2', tenant_id: 't-2' })], error: null };

    await pedir();

    expect(conNavegador).toHaveBeenCalledTimes(2);
    expect(conPortales).toHaveBeenCalledTimes(2);
    // Y cada lote se registró con los datos fiscales de SU flota.
    const flotas = conPortales.mock.calls.map((c) => (c[0] as { flota: { tenantId: string } }).flota.tenantId);
    expect(flotas.sort()).toEqual(['t-1', 't-2']);
  });

  it('los tickets van agrupados por portal dentro de la flota', async () => {
    // Con un solo portal escrito esto se ve poco, pero el orden es el del
    // agrupamiento y no el de la consulta: es lo que permite que una sesión de
    // CAPUFE reciba varios códigos seguidos en vez de intercalados con otro
    // portal.
    cola = {
      data: [
        fila({ id: 'capufe-1' }),
        fila({ id: 'sin-portal', ocr_extra: OTRO }),
        fila({ id: 'capufe-2' }),
      ],
      error: null,
    };

    await pedir();

    // El de portal desconocido se despacha primero, sin navegador, por
    // `facturarAlVuelo` suelto.
    expect(facturarAlVuelo).toHaveBeenCalledTimes(1);
    expect((facturarAlVuelo.mock.calls[0][0] as { gastoId: string }).gastoId).toBe('sin-portal');
    // Los dos de CAPUFE van juntos y en orden, en UN lote.
    expect(facturarLoteAlVuelo).toHaveBeenCalledTimes(1);
    expect((facturarLoteAlVuelo.mock.calls[0][0] as { gastoIds: string[] }).gastoIds).toEqual(['capufe-1', 'capufe-2']);
  });

  it('sin ticket de portal automatizable NO se abre navegador', async () => {
    // Arrancar Chromium para descubrir que no hay a dónde entrar cuesta segundos
    // de una invocación de 300.
    cola = { data: [fila({ id: 'g-1', ocr_extra: OTRO })], error: null };

    const cuerpo = await (await pedir()).json();

    expect(conNavegador).not.toHaveBeenCalled();
    expect(facturarAlVuelo).toHaveBeenCalledTimes(1);
    expect(cuerpo.corrio).toBe(true);
  });

  it('una flota sin datos fiscales no gasta navegador, y se dice qué le falta', async () => {
    // El portal pide los seis datos del receptor antes que nada: el intento
    // terminaría igual, con un Chromium de más. Los tickets SÍ se despachan para
    // que queden sellados y no acaparen el lote siguiente.
    fiscalPorFlota = { 't-1': { flota: null, falta: ['la flota no tiene RFC'] } };
    const cuerpo = await (await pedir()).json();

    expect(conNavegador).not.toHaveBeenCalled();
    expect(facturarAlVuelo).toHaveBeenCalledTimes(1);
    expect(cuerpo.flotas[0].falta).toEqual(['la flota no tiene RFC']);
  });
});

describe('cuando Chromium no arranca —que es HOY, en Vercel—', () => {
  beforeEach(() => {
    navegadorRoto = "browserType.launch: Executable doesn't exist at /ms-playwright/chromium/chrome-linux/chrome";
  });

  it('responde 503, no un 200 que se vea verde', async () => {
    const res = await pedir();
    const cuerpo = await res.json();

    expect(res.status).toBe(503);
    expect(cuerpo.corrio).toBe(false);
    // El motivo tiene que decir QUÉ hacer, no solo que falló.
    expect(cuerpo.motivo).toContain('LIKIDA_CHROMIUM_PATH');
    // Y el error del navegador tal cual: es lo que identifica el fallo.
    expect(cuerpo.error).toContain("Executable doesn't exist");
  });

  it('NO toca los tickets: se recogen enteros en la corrida en que sí se pueda', async () => {
    // `facturarAlVuelo` es quien escribe `autofactura_intentada_en`. No llamarlo
    // es lo que deja el ticket sin marcar; marcarlo aquí los mandaría al final de
    // la cola sin haberlo intentado nunca.
    const cuerpo = await (await pedir()).json();

    expect(facturarAlVuelo).not.toHaveBeenCalled();
    expect(cuerpo.sinIntentar).toBe(1);
    expect(cuerpo.intentados).toBe(0);
  });

  it('no lo reintenta flota por flota: un arranque fallido vale para toda la corrida', async () => {
    cola = { data: [fila({ id: 'g-1', tenant_id: 't-1' }), fila({ id: 'g-2', tenant_id: 't-2' })], error: null };

    const cuerpo = await (await pedir()).json();

    expect(conNavegador).toHaveBeenCalledTimes(1);
    expect(cuerpo.sinIntentar).toBe(2);
  });

  it('lo que SÍ se pudo hacer sin navegador se hizo, y se reporta', async () => {
    // El 503 no puede leerse como "no pasó nada": los tickets sin portal
    // automatizable ya quedaron intentados y sellados.
    cola = { data: [fila({ id: 'sin-portal', ocr_extra: OTRO }), fila({ id: 'capufe-1' })], error: null };

    const res = await pedir();
    const cuerpo = await res.json();

    expect(res.status).toBe(503);
    expect(facturarAlVuelo).toHaveBeenCalledTimes(1);
    expect((facturarAlVuelo.mock.calls[0][0] as { gastoId: string }).gastoId).toBe('sin-portal');
    expect(cuerpo.intentados).toBe(1);
    expect(cuerpo.sinIntentar).toBe(1);
  });

  it('lo grita en el log: sin esto el 503 se ve en Vercel y no dice por qué', async () => {
    await pedir();
    expect(logger.error).toHaveBeenCalledWith('cron.facturar.sin_navegador', expect.objectContaining({ sinIntentar: 1 }));
  });

  it('el fallo viaja marcado como DE PLATAFORMA para TODAS las flotas del lote (B8)', async () => {
    // Es la marca que hace que el correo de cada flota diga «el problema es de
    // Likida, tu información está bien» en vez del genérico que la manda a
    // revisar sus datos — con Chromium caído lo reciben hasta 20 flotas a la
    // vez, incluidas las que ni alcanzaron a intentar (el arranque se descubre
    // en la primera y vale para toda la corrida).
    cola = { data: [fila({ id: 'g-1', tenant_id: 't-1' }), fila({ id: 'g-2', tenant_id: 't-2' })], error: null };

    await pedir();

    expect(avisarCorridasPorFlota).toHaveBeenCalledTimes(1);
    const [agente, corridas] = avisarCorridasPorFlota.mock.calls[0] as unknown as [string, Map<string, unknown>];
    expect(agente).toBe('facturas');
    expect(corridas.size).toBe(2);
    for (const [tenant, fallo] of corridas) {
      expect(fallo, tenant).toBeInstanceOf(FalloDePlataforma);
    }
  });
});

describe('el cierre de corridas distingue el origen del fallo', () => {
  it('una corrida buena cierra con null: sin marca, sin fallo', async () => {
    // Control de B8: el camino feliz no puede quedar marcado como fallo de
    // plataforma — eso mandaría el correo tranquilizador a quien no espera
    // ningún correo.
    await pedir();

    expect(avisarCorridasPorFlota).toHaveBeenCalledTimes(1);
    const [, corridas] = avisarCorridasPorFlota.mock.calls[0] as unknown as [string, Map<string, unknown>];
    expect(corridas.get('t-1')).toBeNull();
  });

  it('una flota sin datos fiscales NO cuenta como corrida fallida ni como fallo de plataforma', async () => {
    // Es un hueco de captura del cliente, no un agente caído: la corrida
    // terminó. Ya estaba decidido así; B8 no lo cambia.
    fiscalPorFlota = { 't-1': { flota: null, falta: ['la flota no tiene RFC'] } };
    await pedir();

    const [, corridas] = avisarCorridasPorFlota.mock.calls[0] as unknown as [string, Map<string, unknown>];
    expect(corridas.get('t-1')).toBeNull();
  });
});

describe('la cola atorada de Facturas (B2): lo que la máquina ya no va a intentar sola avisa por correo', () => {
  // `avisoColaAtorada` existía desde el 14-ago sin llamador — el hallazgo de
  // la pestaña: interruptores que no podían dispararse nunca. Su primer emisor
  // real es este cron: los tickets que ESTA corrida bloqueó (requiere_cuenta,
  // CAPTCHA) salieron de la cola automática y esperan a una persona. Aquí se
  // fija el CABLE; el anti-ruido (marcas, piso de una hora) vive en `avisar`
  // y se prueba en `agentes/notificaciones.test.ts` — no se duplica.

  /** Un lote cuyo portal bloquea TODOS sus tickets. `mockImplementationOnce`
   *  para no dejarle la implementación pegada a las demás pruebas. */
  const loteBloqueado = () =>
    facturarLoteAlVuelo.mockImplementationOnce(async (a: { gastoIds: string[] }) => ({
      porGasto: a.gastoIds.map((gastoId) => ({
        intentado: true, facturado: false, detalle: 'el portal exige cuenta', gastoId,
      })),
      facturados: 0,
      bloqueados: a.gastoIds.map((gastoId) => ({ gastoId, motivo: 'requiere_cuenta' })),
    }));

  it('un lote con bloqueados dispara el aviso POR FLOTA, con la magnitud medida', async () => {
    cola = { data: [fila({ id: 'g-1', tenant_id: 't-1' }), fila({ id: 'g-2', tenant_id: 't-2' })], error: null };
    loteBloqueado();
    loteBloqueado();

    const cuerpo = await (await pedir()).json();
    expect(cuerpo.corrio).toBe(true);

    const deCola = avisar.mock.calls.filter((c) => c[2] === 'cola_atorada');
    expect(deCola).toHaveLength(2);   // una por flota, no una por ticket
    const deT1 = deCola.find((c) => c[0] === 't-1')!;
    expect(deT1.slice(1, 4)).toEqual(['facturas', 'cola_atorada', { hayProblema: true, magnitud: 1 }]);
    expect(deCola.find((c) => c[0] === 't-2')![3]).toEqual({ hayProblema: true, magnitud: 1 });

    // El armador produce el correo REAL (`avisoColaAtorada`), con el nombre y
    // la ruta que `avisar` resuelve del catálogo, y SIN días inventados:
    // `diasSinBajar: null` es la verdad — esta cola no tiene serie histórica.
    type Armador = (d: {
      flota: string | null; agente: string; ruta: string; magnitud: number; cuando: string;
    }) => { asunto: string; datos?: Array<[string, string]> };
    const correo = (deT1[4] as unknown as Armador)({
      flota: null, agente: 'Agente de Facturas', ruta: '/dashboard/agentes/facturas',
      magnitud: 1, cuando: 'hoy 09:00',
    });
    expect(correo.asunto).toBe('Agente de Facturas: 1 pendiente sin avanzar');
    expect(correo.datos).toEqual([['Agente', 'Agente de Facturas'], ['Pendientes', '1']]);
  });

  it('un lote sin bloqueados CIERRA el incidente en vez de dispararlo (AG-A5, auditoría 28)', async () => {
    // El default de `facturarLoteAlVuelo` no bloquea nada. Hasta la auditoría
    // 28 esto significaba CERO llamadas a `avisar` para `cola_atorada` — el
    // filo de ese aviso nunca se re-armaba (AG-A5): un incidente que llegara a
    // su tercera marca de insistencia se quedaba mudo para siempre, aunque la
    // cola ya no tuviera nada. Ahora SÍ se llama, con `hayProblema: false`,
    // para cada flota que la corrida procesó — es lo que re-arma el filo.
    const cuerpo = await (await pedir()).json();
    expect(cuerpo.corrio).toBe(true);
    const deCola = avisar.mock.calls.filter((c) => c[2] === 'cola_atorada');
    expect(deCola.length).toBeGreaterThan(0);
    for (const c of deCola) expect(c[3]).toEqual({ hayProblema: false, magnitud: 0 });
  });

  it('el aviso jamás tumba la corrida, y el cierre de corrida_fallida sale igual', async () => {
    // `avisar` promete no lanzar; la ruta no cuelga de esa promesa — se prueba
    // con la forma de fallo que la promesa NO cubre.
    loteBloqueado();
    avisar.mockRejectedValue(new Error('canal de correo caído'));

    const res = await pedir();
    const cuerpo = await res.json();

    expect(res.status).toBe(200);
    expect(cuerpo.corrio).toBe(true);
    expect(avisarCorridasPorFlota).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('cron.facturar.aviso_cola_roto',
      expect.objectContaining({ tenant: 't-1' }));
  });
});

describe('el presupuesto de tiempo del lote', () => {
  // El comentario de `maxDuration` decía "a 60s el peor caso, ocho llenan 300s
  // con margen" — 8 × 60s = 480s, 180s de MÁS (hallazgo ALTO de
  // docs/auditoria-10/rendimiento.md). El `for` de flotas no consultaba el
  // reloj antes de abrir el siguiente navegador, así que nada impedía entrar a
  // una sesión número dos o tres sin tiempo real para terminarla.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('corta el lote ANTES de abrir una sesión que no le va a dar tiempo, en vez de abrirla y dejarla a medias', async () => {
    // Dos flotas con ticket de portal. La primera sesión "tarda" 250s —dentro
    // del peor caso real que documenta la auditoría (~147s por sesión, y basta
    // que una se acerque a ese techo)—, así que cuando el `for` llega a la
    // segunda flota ya pasaron 250s de los 300s de `maxDuration`: no alcanzan
    // los 60s de colchón (`MARGEN_LOTE_MS`) que hacen falta para abrir otra.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    duracionSesionesMs.push(250_000);

    cola = {
      data: [fila({ id: 'g-1', tenant_id: 't-1' }), fila({ id: 'g-2', tenant_id: 't-2' })],
      error: null,
    };

    const cuerpo = await (await pedir()).json();

    // Solo se abrió UN navegador: el de la segunda flota se cortó ANTES de
    // abrirse. Si el arreglo fuera "abrirla y dejarla a medias", este número
    // sería 2.
    expect(conNavegador).toHaveBeenCalledTimes(1);
    expect(facturarLoteAlVuelo).toHaveBeenCalledTimes(1);
    expect((facturarLoteAlVuelo.mock.calls[0][0] as unknown as { tenantId: string }).tenantId).toBe('t-1');

    // La segunda flota queda SIN marcar como intentada: se recoge entera en la
    // corrida siguiente, mismo principio que un Chromium que no arranca.
    expect(cuerpo.corrio).toBe(true);
    expect(cuerpo.intentados).toBe(1);
    expect(cuerpo.sinTiempo).toBe(1);
    const flotaCortada = (cuerpo.flotas as Array<{ tenantId: string; falta?: string[] }>)
      .find((f) => f.tenantId === 't-2');
    expect(flotaCortada?.falta?.[0]).toContain('tiempo');
  });

  it('sin el corte de tiempo, dos flotas rápidas SÍ se intentan las dos: el corte es por presupuesto, no por tener varias flotas', async () => {
    // Control negativo: confirma que lo que cortó la prueba de arriba fue el
    // reloj y no, por ejemplo, un límite oculto de "una flota por corrida".
    vi.useFakeTimers();
    vi.setSystemTime(0);
    duracionSesionesMs.push(5_000); // una sesión rápida, muy lejos del colchón

    cola = {
      data: [fila({ id: 'g-1', tenant_id: 't-1' }), fila({ id: 'g-2', tenant_id: 't-2' })],
      error: null,
    };

    const cuerpo = await (await pedir()).json();

    expect(conNavegador).toHaveBeenCalledTimes(2);
    expect(cuerpo.sinTiempo).toBe(0);
    expect(cuerpo.intentados).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ESC-5 — UN MENSAJE DE QSTASH POR FLOTA, Y EL BACKLOG MEDIDO
//
// Con lote de 8 cada hora el techo eran 192 tickets/día contra ~170-340
// sueltos/día: la cola crecía y `limit(9)` solo sabía si "sobró uno".
// ═══════════════════════════════════════════════════════════════════════════

describe('el despacho por flota con QStash (ESC-5)', () => {
  beforeEach(() => {
    // BE-6 (a): las TRES variables, como exige el callback. Con una sola el
    // cron ya no encola (ver el describe de la auditoría 24).
    process.env.UPSTASH_QSTASH_TOKEN = 'tok';
    process.env.QSTASH_CURRENT_SIGNING_KEY = 'cur';
    process.env.QSTASH_NEXT_SIGNING_KEY = 'nxt';
  });

  it('encola UN mensaje POR FLOTA — no un solo lote con las flotas mezcladas', async () => {
    // Un mensaje = un navegador = una sesión por portal, en su propia
    // invocación. Mezclar flotas en un mensaje era volver a meter ocho
    // sesiones en los 300 s de una sola función.
    cola = { data: [fila({ id: 'a', tenant_id: 't-1' }), fila({ id: 'b', tenant_id: 't-2' }), fila({ id: 'c', tenant_id: 't-1' })], error: null };

    const cuerpo = await (await pedir()).json();

    expect(publishJSON).toHaveBeenCalledTimes(2);
    const porMensaje = publishJSON.mock.calls.map(([m]) => (m.body as { lote: Array<{ id: string; tenant_id: string }> }).lote);
    expect(porMensaje.map((l) => l.map((g) => g.id))).toEqual([['a', 'c'], ['b']]);
    // Cada mensaje lleva UNA sola flota.
    for (const l of porMensaje) expect(new Set(l.map((g) => g.tenant_id)).size).toBe(1);
    expect(cuerpo).toMatchObject({ corrio: true, encolado: true, flotas: 2, tickets: 3 });
  });

  it('el lote por flota se topa en 20 tickets, no en 8', async () => {
    cola = { data: Array.from({ length: 25 }, (_, i) => fila({ id: `g-${i}` })), error: null };

    await pedir();

    const lote = (publishJSON.mock.calls[0][0].body as { lote: unknown[] }).lote;
    expect(lote).toHaveLength(20);
  });

  it('EL BACKLOG ES UN CONTEO REAL (count head), no "sobró uno"', async () => {
    // Es el número que dice si la cola crece. Antes se derivaba de `limit+1`,
    // así que 9 pendientes y 9,000 se veían exactamente igual.
    cola = { data: [fila({ id: 'a' })], error: null };
    backlog = { count: 4321, error: null };

    const cuerpo = await (await pedir()).json();

    expect(consulta).toContainEqual(['gasto.select', ['id', { count: 'exact', head: true }]]);
    expect(cuerpo.backlog).toBe(4321);
    expect(cuerpo.quedaron).toBe(4320);
  });

  it('si el conteo falla, `backlog` es null y se DICE — no un cero inventado', async () => {
    backlog = { count: null, error: { message: 'timeout' } };

    const cuerpo = await (await pedir()).json();

    expect(cuerpo.backlog).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith('cron.facturar.backlog_sin_contar', { err: 'timeout' });
  });

  it('la cola va acotada en periodo: nada de barrer la tabla entera', async () => {
    await pedir();
    const gte = consulta.filter(([m]) => m === 'gasto.gte').map(([, a]) => a[0]);
    expect(gte).toContain('created_at');
    // Y el conteo mide LO MISMO que la lectura: dos filtros distintos harían
    // que `quedaron` mintiera.
    expect(gte).toHaveLength(2);
  });

  it('el mismo cuarto de hora no encola dos veces la misma flota (Vercel Cron es at-least-once)', async () => {
    await pedir();
    const dedup = publishJSON.mock.calls[0][0].deduplicationId as string;
    // REN-5: la ranura es por (flota, portal).
    expect(dedup).toMatch(/^facturar-t-1-capufe-\d+$/);
    // Un segundo disparo del MISMO cuarto de hora reusa la ranura.
    publishJSON.mockClear();
    await pedir();
    expect(publishJSON.mock.calls[0][0].deduplicationId).toBe(dedup);
  });

  it('si QStash no acepta NINGÚN lote, se procesa aquí mismo en vez de perder la corrida', async () => {
    publishJSON.mockRejectedValue(new Error('qstash caído'));

    const cuerpo = await (await pedir()).json();

    expect(cuerpo.encolado).toBeUndefined();
    expect(cuerpo.corrio).toBe(true);
    expect(facturarLoteAlVuelo).toHaveBeenCalled();
  });

  it('si QStash acepta unas flotas y otras no, las que fallaron quedan SIN marcar y se avisa al operador', async () => {
    cola = { data: [fila({ id: 'a', tenant_id: 't-1' }), fila({ id: 'b', tenant_id: 't-2' })], error: null };
    publishJSON.mockImplementation(async (m: Record<string, unknown>) => {
      const lote = m.body as { lote: Array<{ tenant_id: string }> };
      if (lote.lote[0].tenant_id === 't-2') throw new Error('rechazado');
      return { messageId: 'msg-1' };
    });

    const cuerpo = await (await pedir()).json();

    expect(cuerpo.flotas).toBe(1);
    expect(cuerpo.sinEncolar).toEqual([{ tenantId: 't-2', portal: 'capufe', tickets: 1, error: 'rechazado' }]);
    expect(alertarOperador).toHaveBeenCalledWith('cron.facturar', expect.objectContaining({ codigo: 'encolado_parcial' }));
  });

  it('RES-23: un QStash colgado NO se come la invocación — el publish tiene su propio tope', async () => {
    // `publishJSON` no trae tope propio: sin esto, una publicación colgada se
    // comía los 300 s del cron y la corrida moría sin encolar nada.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    publishJSON.mockImplementation(() => new Promise(() => {})); // nunca resuelve
    try {
      const enVuelo = pedir();
      await vi.advanceTimersByTimeAsync(11_000);
      const cuerpo = await (await enVuelo).json();
      // Cayó al camino síncrono (falla-cerrado), no colgó.
      expect(cuerpo.corrio).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(logger.error).toHaveBeenCalledWith('cron.facturar.encolado_fallo', expect.objectContaining({
      err: expect.stringContaining('sin respuesta'),
    }));
  });

  // ── AUDITORÍA 24 ────────────────────────────────────────────────────────

  it('BE-6 (a): con SOLO el token —una signing key ausente o rotada— NO se encola: se factura síncrono y se grita', async () => {
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    // Antes: 25 lotes publicados, latido `ok`, y cada callback contestaba 503.
    const cuerpo = await (await pedir()).json();
    expect(publishJSON).not.toHaveBeenCalled();
    expect(cuerpo.encolado).toBeUndefined();
    expect(facturarLoteAlVuelo).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('cron.facturar.qstash_a_medias', { token: true, current: false, next: true });
    expect(alertarOperador).toHaveBeenCalledWith('cron.facturar', expect.objectContaining({ codigo: 'qstash_config_incompleta' }));
  });

  it('BE-6 (c): si el último latido sigue siendo «encolé» de la corrida anterior, nadie procesó — se factura síncrono, latido `parcial` con la causa y alerta', async () => {
    leerLatido.mockResolvedValue({
      ultimoLatido: new Date(Date.now() - 15 * 60_000).toISOString(), estado: 'ok',
      detalle: { encolado: true, sesiones: 3, tickets: 40 },
    });
    const cuerpo = await (await pedir()).json();
    expect(publishJSON).not.toHaveBeenCalled();
    expect(facturarLoteAlVuelo).toHaveBeenCalled();
    expect(cuerpo.parcialPor).toBe('cola_sin_procesar');
    expect(alertarOperador).toHaveBeenCalledWith('cron.facturar', expect.objectContaining({ codigo: 'cola_sin_procesar' }));
    expect(registrarLatido).toHaveBeenCalledWith('facturar', 'parcial', expect.objectContaining({ parcialPor: 'cola_sin_procesar' }));
  });

  it('BE-6 (c): el latido de encolar dice `encolado: true` — es lo que la corrida siguiente cruza', async () => {
    await pedir();
    expect(registrarLatido).toHaveBeenCalledWith('facturar', 'ok', expect.objectContaining({ encolado: true, sesiones: 1, tickets: 1 }));
  });

  it('BE-6 (c): con el último latido escrito por el callback (sin `encolado`), se encola normal', async () => {
    leerLatido.mockResolvedValue({ ultimoLatido: new Date().toISOString(), estado: 'ok', detalle: { modo: 'ensayo', intentados: 20, facturados: 0 } });
    await pedir();
    expect(publishJSON).toHaveBeenCalledTimes(1);
  });

  it('REN-5: una flota con tickets de TRES portales encola TRES mensajes, no uno', async () => {
    // Un mensaje = un navegador. Con uno por flota, los tres portales iban
    // en serie dentro de un solo navegador de 150 s: 2-5 tickets por corrida.
    const GOGAS = { urlFacturacion: 'https://facturasgas.com/facturacion/autofactura.php' };
    cola = { data: [
      fila({ id: 'c-1' }), fila({ id: 'c-2' }),
      fila({ id: 'g-1', ocr_extra: GOGAS }), fila({ id: 'g-2', ocr_extra: GOGAS }),
      fila({ id: 'x-1', ocr_extra: {} }),
    ], error: null };
    const cuerpo = await (await pedir()).json();
    expect(publishJSON).toHaveBeenCalledTimes(3);
    const lotes = publishJSON.mock.calls.map(([m]) => (m.body as { lote: Array<{ id: string }> }).lote.map((g) => g.id));
    expect(lotes).toEqual([['c-1', 'c-2'], ['g-1', 'g-2'], ['x-1']]);
    expect(cuerpo).toMatchObject({ flotas: 1, sesiones: 3, tickets: 5 });
    expect(cuerpo.mensajes.map((m: { portal: string }) => m.portal)).toEqual(['capufe', 'gogas', 'sin_portal']);
  });

  it('REN-5: el backlog por encima de dos días de demanda se AVISA, no solo se mide', async () => {
    backlog = { count: 1_001, error: null };
    await pedir();
    expect(alertarOperador).toHaveBeenCalledWith('cron.facturar', expect.objectContaining({ codigo: 'backlog_facturacion' }));
  });

  it('BE-32: la URL del callback sale de appUrl(), no de la cabecera Host', async () => {
    await pedir();
    expect(String(publishJSON.mock.calls[0][0].url)).toBe(`${appUrl()}/api/cron/facturar/cola`);
  });

  it('el cron corre cada 15 minutos: el techo de 192 tickets/día era el hallazgo', async () => {
    const { readFileSync } = await import('node:fs');
    const crons = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: Array<{ path: string; schedule: string }> };
    const facturar = crons.crons.find((c) => c.path === '/api/cron/facturar');
    expect(facturar?.schedule).toBe('*/15 * * * *');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RES-21 — "INTENTA Y NO FACTURA NADA" TIENE QUE DEJAR SEÑAL
//
// `autofactura.no_procede` vive en `info` (alto volumen, por ticket). Lo que
// faltaba era la señal agregada: tres corridas seguidas intentando sin timbrar.
// ═══════════════════════════════════════════════════════════════════════════

describe('la señal de corridas secas (RES-21)', () => {
  /** Una corrida que intentó y no facturó, como la guarda `registrarCorrida`. */
  const seca = { resumen: { intentados: 3, facturados: 0 } };

  const conEmitir = () => {
    process.env.FACTURACION_MODO = 'emitir';
    process.env.FACTURACION_MANDATO_ACEPTADO = 'si';
  };
  afterEach(() => { delete process.env.FACTURACION_MODO; });

  it('la corrida guarda su medición: intentados, facturados y los motivos', async () => {
    // El resumen iba en `null`, así que la ficha del agente no podía decir si
    // la corrida hizo algo — ni la siguiente corrida saber si ésta fue seca.
    facturarLoteAlVuelo.mockResolvedValueOnce({
      porGasto: [{ gastoId: 'g-1', intentado: true, facturado: false, motivo: 'requiere_cuenta' }],
      facturados: 0, bloqueados: [],
    });

    await pedir();

    const [, , corrida] = registrarCorrida.mock.calls[0] as unknown as [string, string, { resumen?: Record<string, unknown> }];
    expect(corrida.resumen).toEqual({ intentados: 1, facturados: 0, motivos: { requiere_cuenta: 1 } });
  });

  it('en EMITIR, dos corridas secas previas + ésta = warn accionable', async () => {
    conEmitir();
    ultimasCorridas.mockResolvedValue([seca, seca]);
    facturarLoteAlVuelo.mockResolvedValueOnce({
      porGasto: [{ gastoId: 'g-1', intentado: true, facturado: false, motivo: 'sin_adaptador' }],
      facturados: 0, bloqueados: [],
    });

    await pedir();

    expect(logger.warn).toHaveBeenCalledWith('cron.facturar.sin_facturar_3_corridas', {
      tenant: 't-1', intentados: 1, motivos: { sin_adaptador: 1 },
    });
  });

  it('con UNA sola corrida seca previa NO avisa: una corrida sin facturar es rutina', async () => {
    conEmitir();
    ultimasCorridas.mockResolvedValue([seca]);
    facturarLoteAlVuelo.mockResolvedValueOnce({
      porGasto: [{ gastoId: 'g-1', intentado: true, facturado: false, motivo: 'sin_adaptador' }],
      facturados: 0, bloqueados: [],
    });

    await pedir();

    expect(logger.warn).not.toHaveBeenCalledWith('cron.facturar.sin_facturar_3_corridas', expect.anything());
  });

  it('en ENSAYO —el modo por defecto— NO avisa: facturados=0 es lo que TIENE que pasar', async () => {
    // Sin esto, el modo normal de hoy gritaría cada tres corridas para cada
    // flota: la forma más rápida de enseñar a ignorar el canal.
    ultimasCorridas.mockResolvedValue([seca, seca]);

    await pedir();

    expect(logger.warn).not.toHaveBeenCalledWith('cron.facturar.sin_facturar_3_corridas', expect.anything());
  });

  it('si el historial no se puede leer, la corrida cierra igual', async () => {
    conEmitir();
    ultimasCorridas.mockRejectedValue(new Error('base caída'));
    facturarLoteAlVuelo.mockResolvedValueOnce({
      porGasto: [{ gastoId: 'g-1', intentado: true, facturado: false, motivo: 'sin_adaptador' }],
      facturados: 0, bloqueados: [],
    });

    const r = await pedir();

    expect(r.status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith('cron.facturar.historial_ilegible', expect.objectContaining({ tenant: 't-1' }));
  });

  it('el desglose de motivos va en el log de cierre, no solo en N líneas de info', async () => {
    facturarLoteAlVuelo.mockResolvedValueOnce({
      porGasto: [
        { gastoId: 'g-1', intentado: true, facturado: false, motivo: 'requiere_cuenta' },
        { gastoId: 'g-2', intentado: true, facturado: false, motivo: 'requiere_cuenta' },
      ],
      facturados: 0, bloqueados: [],
    });

    await pedir();

    expect(logger.info).toHaveBeenCalledWith('cron.facturar.ok', expect.objectContaining({
      motivos: { requiere_cuenta: 2 },
    }));
  });
});

describe('el modo', () => {
  it('EL DEFAULT ES ENSAYO: el cron no emite CFDI por su cuenta', async () => {
    // La prueba más importante del archivo. Un cron corriendo solo, sin nadie
    // mirando, es donde un selector equivocado emite cincuenta facturas malas.
    const cuerpo = await (await pedir()).json();

    expect(cuerpo.modo).toBe('ensayo');
    // El ticket default es de CAPUFE: va por el lote, no por `facturarAlVuelo`.
    expect((facturarLoteAlVuelo.mock.calls[0][0] as unknown as { modo: string }).modo).toBe('ensayo');
  });

  it('solo emite con las DOS llaves: FACTURACION_MODO=emitir Y el mandato aceptado', async () => {
    // D7 (auditoría 4): el modo del cron pasa por `modoEfectivo`, así que el
    // candado legal del runbook (docs/encender-emision.md) aplica también
    // aquí — una sola llave no basta, y el JSON reporta el modo REAL.
    process.env.FACTURACION_MODO = 'emitir';
    process.env.FACTURACION_MANDATO_ACEPTADO = 'si';
    const cuerpo = await (await pedir()).json();
    delete process.env.FACTURACION_MODO;
    delete process.env.FACTURACION_MANDATO_ACEPTADO;

    expect(cuerpo.modo).toBe('emitir');
    expect((facturarLoteAlVuelo.mock.calls[0][0] as unknown as { modo: string }).modo).toBe('emitir');
  });

  it('FACTURACION_MODO=emitir SIN el mandato corre en ensayo Y LO DICE (antes mentía "emitir")', async () => {
    process.env.FACTURACION_MODO = 'emitir';
    const cuerpo = await (await pedir()).json();
    delete process.env.FACTURACION_MODO;

    // El hallazgo D7 exacto: corría en ensayo (bien) y reportaba "emitir".
    expect(cuerpo.modo).toBe('ensayo');
    expect((facturarLoteAlVuelo.mock.calls[0][0] as unknown as { modo: string }).modo).toBe('ensayo');
  });

  it('cualquier otro valor es ensayo', async () => {
    process.env.FACTURACION_MODO = 'EMITIR';
    const cuerpo = await (await pedir()).json();
    delete process.env.FACTURACION_MODO;
    expect(cuerpo.modo).toBe('ensayo');
  });
});

describe('cuando la base no contesta', () => {
  it('devuelve 500 con el error, no un lote vacío que parezca "no había nada"', async () => {
    cola = { data: null, error: { message: 'timeout' } };
    const res = await pedir();

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('timeout');
    expect(facturarAlVuelo).not.toHaveBeenCalled();
  });

  it('el fallo lleva código estable y dispara la alerta al operador (auditoría 4, D1/D2)', async () => {
    alertarOperador.mockClear();
    logger.error.mockClear();
    cola = { data: null, error: { message: 'timeout' } };
    await pedir();

    expect(logger.error).toHaveBeenCalledWith('cron.facturar.falló', expect.objectContaining({ codigo: expect.any(String) }));
    expect(alertarOperador).toHaveBeenCalledWith('cron.facturar', expect.objectContaining({ codigo: expect.any(String) }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LA SESIÓN PERSISTENTE, CONECTADA (27-ago-2026).
//
// `sesion_portal.ts` sabía guardar y leer la sesión cifrada desde el
// 21-ago-2026 y nadie la usaba: `SesionNavegador.abrir()` creaba el contexto
// SIN `storageState`. Este bloque es el cable, mirado desde el cron:
//
//   1. lo guardado entra al navegador ANTES de abrirlo;
//   2. al terminar bien se vuelve a guardar (cookies rotadas);
//   3. si el portal nos sacó, la sesión se APAGA en la misma corrida — no en
//      la siguiente, que volvería a estrellarse con la misma cookie muerta;
//   4. lo que el pre-cheque de EDAD descartó NO se apaga: el pre-cheque decide
//      si vale la pena intentarla, jamás si está muerta (c7-9).
// ═══════════════════════════════════════════════════════════════════════════
describe('la sesión persistente de portales', () => {
  const ESTADO = JSON.stringify({ cookies: [{ name: 's', value: '1', domain: 'capufe.gob.mx', path: '/' }], origins: [] });

  it('lo guardado se le pasa al navegador, y los portales con sesión se declaran al registro', async () => {
    vigentes = {
      porComercio: new Map([['capufe', { storageState: ESTADO, capturadaEn: '2026-08-27T17:59:00.000Z' }]]),
      storageState: ESTADO,
      vencidasPorEdad: [],
    };

    await pedir();

    // (1) El contexto arranca CON la sesión: es el hueco que dejaba muerta la
    // pieza entera.
    const opNavegador = conNavegador.mock.calls[0][1]!;
    expect(opNavegador.storageState).toBe(ESTADO);
    // Y el registro sabe cuáles entraron con sesión, que es lo que separa
    // «caducó» de «nunca se vinculó» en el reporte.
    const opRegistro = conPortales.mock.calls[0][0] as { sesiones?: ReadonlySet<string> };
    expect([...(opRegistro.sesiones ?? [])]).toEqual(['capufe']);
  });

  it('sin nada guardado, el navegador arranca limpio — como siempre', async () => {
    await pedir();
    expect(conNavegador.mock.calls[0][1]!).not.toHaveProperty('storageState');
    expect([...((conPortales.mock.calls[0][0] as { sesiones?: ReadonlySet<string> }).sesiones ?? [])]).toEqual([]);
  });

  it('el lote que terminó BIEN refresca su sesión: las cookies rotadas valen más que las que entraron', async () => {
    vigentes = {
      porComercio: new Map([['capufe', { storageState: ESTADO, capturadaEn: '2026-08-27T17:59:00.000Z' }]]),
      storageState: ESTADO, vencidasPorEdad: [],
    };

    await pedir();

    expect(refrescarSesiones).toHaveBeenCalledTimes(1);
    const arg = refrescarSesiones.mock.calls[0][0];
    expect([...arg.portales.keys()]).toEqual(['capufe']);
    // La URL sale del catálogo: es de donde se recorta la bolsa de cookies.
    expect(arg.portales.get('capufe')).toMatch(/^https?:\/\//);
  });

  it('si el portal nos SACÓ, la sesión se apaga en ESTA corrida y no se refresca', async () => {
    vigentes = {
      porComercio: new Map([['capufe', { storageState: ESTADO, capturadaEn: '2026-08-27T17:59:00.000Z' }]]),
      storageState: ESTADO, vencidasPorEdad: [],
    };
    facturarLoteAlVuelo.mockImplementationOnce(async (a: { gastoIds: string[] }) => ({
      porGasto: a.gastoIds.map((gastoId) => ({ gastoId, intentado: true, facturado: false, motivo: 'bloqueado' })),
      facturados: 0, bloqueados: [],
      vinculo: { clase: 'sesion_caducada' as const, motivo: 'el portal enseña un campo de contraseña' },
    }));

    await pedir();

    expect(invalidarVinculo).toHaveBeenCalledWith(expect.objectContaining({
      comercio: 'capufe', clase: 'sesion_caducada',
    }));
    // Y NO se vuelve a guardar: refrescarla aquí resucitaría la cookie muerta
    // que se acaba de invalidar.
    const arg = refrescarSesiones.mock.calls[0][0];
    expect(arg.portales.size).toBe(0);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // c7-9 · LAS PRUEBAS QUE FALTABAN: «esta sesión caducó» ≠ «esta vuelta no
  // había trabajo».
  //
  // Hasta el ciclo 7 aquí vivía una sola prueba —«lo que el pre-cheque de EDAD
  // descartó se apaga sin gastar un navegador»— que CONSAGRABA el bug: usaba
  // el pre-cheque de edad como veredicto, que es exactamente lo que el
  // encabezado de `sesion_portal.ts` prohíbe. Y lo probaba con el portal que
  // SÍ tenía tickets, así que nunca vio el caso real: el portal ocioso.
  // ═════════════════════════════════════════════════════════════════════════

  it('c7-9 · una sesión vieja de un portal SIN tickets esta vuelta NO se destruye', async () => {
    // La flota tiene G500 y La Gas vinculados y esta vuelta solo llegaron
    // tickets de CAPUFE. `porPortal` se arma desde la cola de gastos y
    // `refrescarSesiones` solo toca los portales que tuvieron trabajo, así que
    // los otros dos envejecen sin que nadie los use. Antes, a los 31 minutos
    // entraban en `vencidasPorEdad` y SE DESTRUÍAN LAS DOS — cada media hora,
    // para siempre, con su «tu portal caducó, vuelve a entrar» al contralor.
    // La sesión la vincula una persona pasando un captcha: es lo más caro que
    // tiene este circuito, y se tiraba sola por no haber tenido trabajo.
    vigentes = { porComercio: new Map(), storageState: null, vencidasPorEdad: ['g500', 'la_gas'] };

    await pedir();

    expect(invalidarVinculo, 'nadie intentó esas sesiones: no hay veredicto que sellar').not.toHaveBeenCalled();
  });

  it('c7-9 · tampoco se apaga la del portal CON tickets antes de intentarla: el veredicto lo da el portal', async () => {
    // El lote corre y el portal NO nos sacó (`vinculo` ausente). Que la sesión
    // guardada fuera vieja no autoriza a matarla: la única prueba de que una
    // sesión murió es que el portal la rechace.
    vigentes = { porComercio: new Map(), storageState: null, vencidasPorEdad: ['capufe'] };

    await pedir();

    expect(invalidarVinculo).not.toHaveBeenCalled();
  });

  it('c7-9 · cuando el portal SÍ nos manda al login, entonces sí se apaga — con la clase REAL', async () => {
    vigentes = { porComercio: new Map(), storageState: null, vencidasPorEdad: ['capufe'] };
    facturarLoteAlVuelo.mockImplementationOnce(async (a: { gastoIds: string[] }) => ({
      porGasto: a.gastoIds.map((gastoId) => ({ gastoId, intentado: true, facturado: false, motivo: 'bloqueado' })),
      facturados: 0, bloqueados: [],
      vinculo: { clase: 'requiere_vinculacion' as const, motivo: 'el portal enseña la pantalla de login' },
    }));

    await pedir();

    // La clase la dice el intento, no el reloj: `requiere_vinculacion` es lo
    // que dispara el re-login de la 0233, y `sesion_caducada` inventada por el
    // pre-cheque lo habría tapado.
    expect(invalidarVinculo).toHaveBeenCalledWith(expect.objectContaining({
      comercio: 'capufe', clase: 'requiere_vinculacion',
    }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24, BE-9 (ALTO): el navegador abre, el portal revienta a media
// escritura, `if (arranco) throw e` salía del bucle SIN `corridas.set`, y
// como todo el cierre itera `corridas`/`bloqueadosPorFlota`, la flota
// desaparecía de correo, bitácora y aviso de cola — con sus tickets ya
// marcados «emisión en curso» y fuera de la cola automática para siempre.
// ═══════════════════════════════════════════════════════════════════════════
describe('BE-9 — la flota cuyo portal reventó a media escritura NO desaparece del cierre', () => {
  it('la corrida de esa flota se anota como fallida, sus tickets sin reportar quedan como «emisión interrumpida» y el error nombra flota y tickets', async () => {
    cola = { data: [fila({ id: 'g-1' }), fila({ id: 'g-2' })], error: null };
    conPortales.mockRejectedValueOnce(new Error('page.click: Target closed'));

    const res = await pedir();
    expect(res.status).toBe(500);
    const cuerpo = await res.json();
    expect(cuerpo).toMatchObject({ tenant: 't-1', gastos: ['g-1', 'g-2'] });

    // El cierre por flota la nombra, y no como fallo de plataforma: el navegador SÍ abrió.
    expect(avisarCorridasPorFlota).toHaveBeenCalledTimes(1);
    const [, corridas] = avisarCorridasPorFlota.mock.calls[0] as unknown as [string, Map<string, unknown>];
    expect(corridas.get('t-1')).toBeInstanceOf(Error);
    expect(corridas.get('t-1')).not.toBeInstanceOf(FalloDePlataforma);
    expect(registrarCorrida).toHaveBeenCalledWith('t-1', 'facturas', expect.objectContaining({ estado: 'fallo' }));
    // Los tickets cuya suerte no se sabe van al aviso de cola atorada.
    expect(avisar).toHaveBeenCalledWith('t-1', 'facturas', 'cola_atorada', { hayProblema: true, magnitud: 2 }, expect.any(Function));
    expect(cuerpo.error).toContain('Target closed');
    expect(logger.error).toHaveBeenCalledWith('cron.facturar.falló', expect.objectContaining({ tenant: 't-1', gastos: ['g-1', 'g-2'] }));
    expect(registrarLatido).toHaveBeenCalledWith('facturar', 'fallo', expect.objectContaining({ tenant: 't-1' }));
  });

  it('los tickets que SÍ se alcanzaron a reportar antes del reventón no se duplican como bloqueados', async () => {
    cola = { data: [fila({ id: 'g-1' }), fila({ id: 'g-2' })], error: null };
    // El lote reportó g-1 (g-2 no alcanzó a reportarse) y el navegador
    // revienta después, al refrescar la sesión — todavía dentro de `conNavegador`.
    facturarLoteAlVuelo.mockResolvedValueOnce({ porGasto: [{ gastoId: 'g-1', intentado: true, facturado: false }], facturados: 0, bloqueados: [] });
    refrescarSesiones.mockRejectedValueOnce(new Error('Target closed'));

    const res = await pedir();
    expect(res.status).toBe(500);
    // Solo g-2: la suerte de g-1 ya está en el parte.
    expect(avisar).toHaveBeenCalledWith('t-1', 'facturas', 'cola_atorada', { hayProblema: true, magnitud: 1 }, expect.any(Function));
    expect(registrarCorrida).toHaveBeenCalledWith('t-1', 'facturas', expect.objectContaining({ estado: 'fallo', resumen: expect.objectContaining({ intentados: 1 }) }));
  });
});
