import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// EL VIAJE QUE NADIE ACEPTÓ — y la marca que impide repetir el aviso.
//
// Lo que este archivo protege, en orden de importancia:
//
//   1. SE ESCALA UNA SOLA VEZ, incluso entre dos corridas SOLAPADAS del cron.
//      El claim (`reclamarEscalacion`) pone `escalado_en` ANTES de mandar
//      cualquier mensaje, con el mismo mecanismo que `al_vuelo.ts` usa contra
//      el doble CFDI: un UPDATE condicional que solo la corrida que gana la
//      fila puede pasar. La que pierde no reintenta ningún mensaje.
//
//   2. SE ESCALA UNA SOLA VEZ dentro de la MISMA corrida. `escalado_en` se
//      marca AUNQUE EL AVISO AL JEFE FALLE, y eso parece un bug hasta que se
//      piensa el caso contrario: con un teléfono de jefe mal capturado, no
//      marcar significa reintentar y fallar cada hora para siempre, y que el
//      registro no distinga "no revisado" de "revisado y no había a quién
//      avisar". La prueba lo fija para que nadie lo "arregle" a la vuelta de
//      seis meses. Y se prueba en las DOS formas de fallar —por valor
//      (`{ok:false}`) y por excepción—, porque una invariante que solo aguanta
//      una de las dos no es una invariante.
//
//   3. UN ERROR NO ES UNA LISTA VACÍA. `viajesSinAceptar` lanza. Sin eso, una
//      base caída se leería como "hoy nadie dejó de aceptar" — el cron correría
//      verde mientras los viajes se pierden, que es el modo de falla que
//      CLAUDE.md manda cerrar con `exigir()`.
//
//   4. EL CORTE DE 5 H SE MIDE CONTRA `ahora` INYECTADO, no contra el reloj de
//      quien corre las pruebas.
//
// Se mockea `sendTemplate`, no `motivoDeFalloWhatsApp`: lo que hace útil un
// fallo es que el código de Meta se traduzca a algo que alguien pueda accionar.
// ═══════════════════════════════════════════════════════════════════════════

const { sendText, sendTemplate, avisarAlChofer, telefonosJefe, avisar, avisarCorridasPorFlota, registrarCorrida } = vi.hoisted(() => ({
  sendText: vi.fn(),
  sendTemplate: vi.fn(),
  avisarAlChofer: vi.fn(),
  telefonosJefe: vi.fn(),
  avisar: vi.fn(),
  avisarCorridasPorFlota: vi.fn(),
  registrarCorrida: vi.fn(),
}));

vi.mock('@/lib/meta/client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  sendText,
  sendTemplate,
  // RES-1: la escalación pide el CÓDIGO de Meta para decidir si el sello se
  // libera. `enviarTexto` es `sendText` con el contrato completo, así que el
  // mock delega en el de siempre y las pruebas viejas siguen midiendo lo mismo.
  enviarTexto: async (to: string, body: string) => {
    const id = await sendText(to, body);
    return id ? { ok: true, id } : { ok: false, error: 'rechazado por Meta' };
  },
}));
vi.mock('./operacion', () => ({ avisarAlChofer }));
vi.mock('./contactos', () => ({ telefonosJefe }));
// El motor de avisos se mockea ENTERO: desde que el escalado emite su propio
// aviso (`conductores:escalado`), estas pruebas necesitan VER las llamadas —
// a quién, con qué magnitud y con qué folios — sin arrastrar la base que el
// motor real toca por dentro.
vi.mock('./agentes/notificaciones', () => ({ avisar, avisarCorridasPorFlota }));
// La bitácora (B3) se mockea para poder afirmar su cableado Y para probar que
// un fallo suyo no tumba la corrida: el motor real ya promete no lanzar
// (corridas.test.ts fija esa promesa), pero la corrida no cuelga de ella.
vi.mock('./agentes/corridas', () => ({ registrarCorrida }));

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger }));

// ── La base ────────────────────────────────────────────────────────────────
/** Lo que devuelve el SELECT de viajes vencidos. */
let lectura: { data: unknown; error: { message: string } | null } = { data: [], error: null };
/**
 * Lo que devuelve cada UPDATE (el claim), en orden. La última se repite si se
 * acaban. `data` simula lo que el `.select('id')` del claim ve: una fila
 * significa que esta corrida ganó, `[]` que otra corrida se adelantó.
 */
let resultadosUpdate: Array<{ data?: unknown; error: { message: string } | null }> = [];
/** Cada método de la cadena de lectura, con sus argumentos. */
const filtros: Array<[string, unknown[]]> = [];
/** Cada update ejecutado: qué se escribió y con qué filtros. */
const updates: Array<{ fila: Record<string, unknown>; por: Array<[string, unknown]> }> = [];
/**
 * La estrategia por flota (B4): lo que `getConfig` lee de `tenant.config` vía
 * `.from('tenant').select('rfc, config').eq('id', t).maybeSingle()`. Sin
 * entrada = flota sin fila → defaults de demo (5 h de escalación), así que
 * ninguna prueba vieja se entera del mecanismo. Un `Error` como valor hace
 * LANZAR la lectura de config de esa flota.
 */
let configPorTenant: Record<string, { data: unknown; error: { message: string } | null } | Error> = {};

function cadenaLectura() {
  const nodo: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'not', 'lte', 'gte', 'limit', 'order']) {
    nodo[m] = (...a: unknown[]) => { filtros.push([m, a]); return nodo; };
  }
  nodo.then = (r: (v: unknown) => unknown) => Promise.resolve(lectura).then(r);
  return nodo;
}

/** La cadena de `getConfig` sobre `tenant` (B4): captura el id del `.eq` y
 *  contesta con `configPorTenant`. */
function cadenaTenant() {
  let id = '';
  const nodo: Record<string, unknown> = {};
  nodo.select = () => nodo;
  nodo.eq = (_col: string, val: unknown) => { id = String(val); return nodo; };
  nodo.maybeSingle = () => {
    const r = configPorTenant[id] ?? { data: null, error: null };
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  };
  return nodo;
}

const from = vi.fn((tabla: string) => tabla === 'tenant' ? cadenaTenant() : ({
  select: (...a: unknown[]) => { filtros.push([`select ${tabla}`, a]); return cadenaLectura(); },
  // El update encadena `.eq()` cuantas veces haga falta y solo se resuelve al
  // esperarlo: así la prueba ve TODOS los filtros con que se acotó, no el
  // primero. Un mock que se resolviera en el primer `.eq` haría pasar en verde
  // justo el descuido que hay que vigilar — un update sin acotar por tenant.
  // `.is()` y `.select()` son parte del claim (`reclamarEscalacion`): se
  // encadenan sin registrarse en `por` porque las pruebas de acotación por
  // tenant solo verifican los `.eq()`.
  update: (fila: Record<string, unknown>) => {
    const por: Array<[string, unknown]> = [];
    const nodo: Record<string, unknown> = {};
    nodo.eq = (col: string, val: unknown) => { por.push([col, val]); return nodo; };
    nodo.is = () => nodo;
    nodo.select = () => nodo;
    nodo.then = (r: (v: unknown) => unknown) => {
      updates.push({ fila, por });
      const res = resultadosUpdate[updates.length - 1] ?? resultadosUpdate.at(-1) ?? { error: null };
      return Promise.resolve(res).then(r);
    };
    return nodo;
  },
}));

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ from: (...a: unknown[]) => from(...(a as [string])) }),
}));

const { viajesSinAceptar, armarAvisoJefe, escalarViajesSinAceptar, HORAS_PARA_ESCALAR } =
  await import('./escalar_viaje');

const AHORA = new Date('2026-08-04T18:00:00.000Z');
/** El instante exacto en que un viaje avisado empieza a contar como vencido. */
const LIMITE = '2026-08-04T13:00:00.000Z';

/** Una fila como la devuelve PostgREST para la consulta de `viajesSinAceptar`. */
const fila = (o: Record<string, unknown> = {}) => ({
  id: 'v-1', tenant_id: 't-1', folio: 'VJ-104', operador_id: 'o-1',
  avisado_en: '2026-08-04T08:00:00.000Z', avisos_enviados: 1,
  operador: { nombre: 'Juan Pérez' },
  ...o,
});

beforeEach(() => {
  lectura = { data: [], error: null };
  // Por defecto el claim GANA: una fila en `data` es lo que `reclamarEscalacion`
  // lee como "esta corrida se quedó con el viaje".
  resultadosUpdate = [{ data: [{ id: 'v-1' }], error: null }];
  filtros.length = 0;
  updates.length = 0;
  configPorTenant = {};
  from.mockClear();
  registrarCorrida.mockReset();
  registrarCorrida.mockResolvedValue(undefined);
  sendText.mockReset();
  // `null` por defecto: fuera de la ventana de 24 h, que es el caso probable de
  // alguien que lleva 5 horas sin contestar. Así se ejerce la ruta real —texto
  // rechazado, cae a la plantilla— en vez de dejar el mock siempre en éxito.
  sendText.mockResolvedValue(null);
  sendTemplate.mockReset();
  sendTemplate.mockResolvedValue({ ok: true, id: 'wamid.TEST' });
  avisarAlChofer.mockReset();
  avisarAlChofer.mockResolvedValue(undefined);
  telefonosJefe.mockReset();
  telefonosJefe.mockResolvedValue({});
  avisar.mockReset();
  avisar.mockResolvedValue({ avisado: true, porque: 'ok', destinatarios: 1, magnitud: 1 });
  avisarCorridasPorFlota.mockReset();
  avisarCorridasPorFlota.mockResolvedValue(undefined);
  for (const f of Object.values(logger)) f.mockReset();
});

/** Los argumentos con que se llamó un método de la cadena. */
const args = (metodo: string) => filtros.filter(([m]) => m === metodo).map(([, a]) => a);

// ═══════════════════════════════════════════════════════════════════════════
// viajesSinAceptar
// ═══════════════════════════════════════════════════════════════════════════

describe('viajesSinAceptar', () => {
  it('pide solo los abiertos, sin aceptar, sin escalar y ya avisados', async () => {
    await viajesSinAceptar(AHORA);
    expect(from).toHaveBeenCalledWith('viaje');
    expect(args('eq')).toContainEqual(['estatus', 'abierto']);
    // Sin `aceptado_en is null` se le insistiría a quien ya contestó.
    expect(args('is')).toContainEqual(['aceptado_en', null]);
    // Sin `escalado_en is null` el jefe recibe el mismo aviso cada hora, que es
    // como se entrena a un canal para que se ignore.
    expect(args('is')).toContainEqual(['escalado_en', null]);
    // Un viaje que nunca se avisó no ha empezado a correr ningún reloj.
    expect(args('not')).toContainEqual(['avisado_en', 'is', null]);
    expect(args('limit')).toContainEqual([100]);
  });

  it('el corte son 5 h EXACTAS contadas desde el `ahora` que se le pasa', async () => {
    await viajesSinAceptar(AHORA);
    const [[columna, limite]] = args('lte') as Array<[string, string]>;
    expect(columna).toBe('avisado_en');
    expect(limite).toBe(LIMITE);
    expect(HORAS_PARA_ESCALAR).toBe(5);

    // El filtro lo aplica PostgREST, así que lo que se puede fijar aquí es el
    // parámetro — y contra él sí se puede comprobar el borde con aritmética de
    // fechas, que es donde vive el error de una hora.
    const avisadoHace = (h: number, m = 0) =>
      new Date(AHORA.getTime() - (h * 3_600_000 + m * 60_000)).toISOString();

    expect(avisadoHace(4, 59) <= limite).toBe(false);   // 4 h 59 → todavía no
    expect(avisadoHace(5, 0) <= limite).toBe(true);     // 5 h en punto → sí (lte)
    expect(avisadoHace(5, 1) <= limite).toBe(true);     // 5 h 01 → sí
  });

  it('sin `ahora` usa el reloj, pero sigue restando 5 h', async () => {
    // RELOJ CONGELADO (flake real del CI, 28-ago-2026): antes se medía contra
    // el reloj de pared — `antes = Date.now()` y luego el `new Date()` interno
    // de `viajesSinAceptar` un instante DESPUÉS. Si el milisegundo avanzaba
    // entre las dos capturas, la resta salía 17,999,999 y la prueba caía por
    // 1 ms. La ironía: la prueba se llama «sin `ahora` usa el reloj» y probaba
    // justo el camino que no controlaba. Con el reloj del sistema congelado el
    // propósito SE CONSERVA — se ejercita el default (sin `ahora`), que toma
    // el reloj del sistema — y la resta es EXACTA, sin margen puesto a ojo.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-28T12:00:00.000Z'));
      await viajesSinAceptar();
      const [[, limite]] = args('lte') as Array<[string, string]>;
      expect(Date.now() - Date.parse(limite)).toBe(5 * 3_600_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('UN ERROR NO ES UNA LISTA VACÍA: lanza en vez de decir que no hay viajes', async () => {
    lectura = { data: null, error: { message: 'timeout' } };
    await expect(viajesSinAceptar(AHORA)).rejects.toThrow(/timeout/);
  });

  it('sin filas devuelve [] y no revienta', async () => {
    lectura = { data: null, error: null };
    expect(await viajesSinAceptar(AHORA)).toEqual([]);
  });

  it('mapea el nombre del operador venga como objeto o como arreglo', async () => {
    // PostgREST devuelve la relación embebida como objeto o como arreglo según
    // cómo infiera la cardinalidad; el mismo `select` cambia de forma entre
    // versiones. Si esto se leyera de una sola manera, el aviso al jefe diría
    // "Tu chofer" en vez del nombre, sin fallar.
    lectura = { data: [fila({ id: 'a' }), fila({ id: 'b', operador: [{ nombre: 'Ana Ruiz' }] })], error: null };
    const r = await viajesSinAceptar(AHORA);
    expect(r.map((v) => v.operadorNombre)).toEqual(['Juan Pérez', 'Ana Ruiz']);
  });

  it('lo que no está capturado viaja como null, no como texto inventado', async () => {
    lectura = { data: [fila({ folio: null, operador_id: null, operador: null, avisos_enviados: null })], error: null };
    const [v] = await viajesSinAceptar(AHORA);
    expect(v).toMatchObject({ folio: null, operadorId: null, operadorNombre: null, avisosEnviados: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// armarAvisoJefe
// ═══════════════════════════════════════════════════════════════════════════

const VIAJE = {
  id: 'v-1', tenantId: 't-1', folio: 'VJ-104', operadorId: 'o-1',
  operadorNombre: 'Juan Pérez', operadorTelefono: '5219993700779',
  avisadoEn: '2026-08-04T08:00:00.000Z', avisosEnviados: 1,
};

describe('armarAvisoJefe', () => {
  it('dice quién, cuál viaje, cuánto lleva y qué puede hacer', () => {
    const t = armarAvisoJefe(VIAJE);
    expect(t).toContain('Juan Pérez');
    expect(t).toContain('VJ-104');
    expect(t).toContain('5 horas');
    // Sin la acción es una notificación; con ella es una decisión que se puede
    // tomar desde el teléfono.
    expect(t).toMatch(/reasignarlo desde Despacho/i);
    expect(t).toMatch(/insistimos/i);
  });

  it('sin nombre capturado no deja un hueco ni escribe "null"', () => {
    const t = armarAvisoJefe({ ...VIAJE, operadorNombre: null });
    expect(t).toMatch(/^El chofer asignado/);
    expect(t).not.toMatch(/null|undefined/);
  });

  it('sin folio se refiere al viaje sin inventarle uno', () => {
    const t = armarAvisoJefe({ ...VIAJE, folio: null });
    expect(t).toContain('el viaje que le asignaste');
    expect(t).not.toMatch(/null|undefined|sin folio/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// escalarViajesSinAceptar
// ═══════════════════════════════════════════════════════════════════════════

const TEL = { 't-1': '529993700779' };

describe('escalarViajesSinAceptar', () => {
  it('insiste al chofer, avisa al jefe y marca el viaje', async () => {
    lectura = { data: [fila()], error: null };
    const r = await escalarViajesSinAceptar({ telefonoJefePorTenant: TEL, ahora: AHORA });

    expect(avisarAlChofer).toHaveBeenCalledWith('t-1', 'o-1', 'v-1');
    const [to, plantilla, opciones] = sendTemplate.mock.calls[0] as [string, string, { parametros: string[] }];
    expect(to).toBe(TEL['t-1']);
    expect(plantilla).toBe('recordatorio_cierre');
    expect(opciones.parametros).toEqual(['Juan Pérez', 'VJ-104']);

    expect(updates).toHaveLength(1);
    expect(updates[0].por).toEqual([['id', 'v-1'], ['tenant_id', 't-1']]);
    expect(typeof updates[0].fila.escalado_en).toBe('string');
    expect(updates[0].fila.avisos_enviados).toBe(2);   // el que ya llevaba + este
    expect(r).toEqual({ revisados: 1, reintentados: 1, escalados: 1, fallos: [], cortadosPorReloj: 0, rechazosReintentables: 0 });
  });

  it('SE MARCA AUNQUE EL AVISO AL JEFE FALLE — y el fallo queda dicho', async () => {
    // Es la decisión del encabezado, y es la que un refactor "de limpieza"
    // rompe primero: sin la marca, un teléfono mal capturado hace que el cron
    // reintente y falle cada hora, para siempre, sobre el mismo viaje.
    sendTemplate.mockResolvedValue({ ok: false, error: 'Template name does not exist', codigo: 132001 });
    lectura = { data: [fila()], error: null };

    const r = await escalarViajesSinAceptar({ telefonoJefePorTenant: TEL, ahora: AHORA });

    expect(updates).toHaveLength(1);
    expect(updates[0].fila).toHaveProperty('escalado_en');
    expect(r.escalados).toBe(1);
    // Traducido, no en crudo: el 132001 de Meta no le dice nada a nadie.
    expect(r.fallos[0]).toMatch(/no está aprobada/i);
    expect(r.fallos[0]).not.toContain('Template name does not exist');
  });

  it('sin teléfono de jefe se le insiste al chofer, se dice el hueco y SE MARCA igual', async () => {
    lectura = { data: [fila()], error: null };
    const r = await escalarViajesSinAceptar({ telefonoJefePorTenant: {}, ahora: AHORA });

    expect(sendTemplate).not.toHaveBeenCalled();
    expect(avisarAlChofer).toHaveBeenCalledTimes(1);
    expect(r.fallos[0]).toMatch(/no tiene teléfono de jefe registrado/i);
    expect(r.escalados).toBe(1);
    // Y va al log como ERROR, no como un fallo más de la lista: esa flota no va
    // a recibir NINGUNA escalación hasta que alguien capture el teléfono, y el
    // viaje se marca igual — o sea que nadie se va a enterar por otro lado.
    expect(logger.error).toHaveBeenCalledWith('escalacion.sin_telefono_de_jefe', {
      tenantId: 't-1', viaje: 'v-1',
    });
  });

  it('si el reaviso al chofer falla, el jefe SE ENTERA igual', async () => {
    // La mitad que importa es la del jefe: es el único que puede cambiar de
    // personal. Que WhatsApp rechace el mensaje del chofer no puede tragarse la
    // decisión que sí se puede tomar.
    avisarAlChofer.mockRejectedValue(new Error('132001 plantilla en revisión'));
    lectura = { data: [fila()], error: null };

    const r = await escalarViajesSinAceptar({ telefonoJefePorTenant: TEL, ahora: AHORA });

    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(r.reintentados).toBe(0);
    expect(r.escalados).toBe(1);
    expect(r.fallos.join(' ')).toMatch(/reaviso VJ-104: 132001/);
  });

  it('un viaje sin chofer asignado no intenta el reaviso, pero sí avisa y marca', async () => {
    lectura = { data: [fila({ operador_id: null, operador: null })], error: null };
    const r = await escalarViajesSinAceptar({ telefonoJefePorTenant: TEL, ahora: AHORA });
    expect(avisarAlChofer).not.toHaveBeenCalled();
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ revisados: 1, reintentados: 0, escalados: 1 });
  });

  it('si el claim (la marca) NO se pudo escribir, no se cuenta como escalado ni se manda nada', async () => {
    // Y esto es lo que hace que el reintento de la siguiente corrida sea
    // correcto: el viaje sigue sin `escalado_en`, así que vuelve a salir en la
    // consulta. Contarlo como escalado aquí sería perderlo.
    resultadosUpdate = [{ error: { message: 'deadlock detected' } }];
    lectura = { data: [fila()], error: null };

    const r = await escalarViajesSinAceptar({ telefonoJefePorTenant: TEL, ahora: AHORA });

    expect(r.escalados).toBe(0);
    expect(r.revisados).toBe(1);
    expect(r.fallos.join(' ')).toMatch(/marcar v-1: deadlock detected/);
    // Se falla CERRADO: sin claim confirmado no se toca ningún canal. Antes el
    // envío pasaba primero y la marca al final; ahora, si la marca ni siquiera
    // se pudo intentar con éxito, no se manda el recordatorio ni el aviso.
    expect(avisarAlChofer).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('una flota con varios viajes vencidos: se procesan todos, y uno malo no tumba al resto', async () => {
    lectura = {
      data: [
        fila({ id: 'v-1', folio: 'VJ-1' }),
        fila({ id: 'v-2', folio: 'VJ-2', operador: { nombre: 'Ana Ruiz' }, avisos_enviados: 3 }),
        fila({ id: 'v-3', folio: 'VJ-3' }),
      ],
      error: null,
    };
    // El del medio pierde el claim (el UPDATE falla); los otros dos tienen que
    // salir enteros. Al perder el claim, v-2 tampoco manda NINGÚN mensaje: la
    // marca va ANTES del envío, no después.
    resultadosUpdate = [
      { data: [{}], error: null },
      { error: { message: 'deadlock' } },
      { data: [{}], error: null },
    ];

    const r = await escalarViajesSinAceptar({ telefonoJefePorTenant: TEL, ahora: AHORA });

    expect(sendTemplate).toHaveBeenCalledTimes(2);
    expect(avisarAlChofer).toHaveBeenCalledTimes(2);
    expect(updates.map((u) => u.por[0][1])).toEqual(['v-1', 'v-2', 'v-3']);
    // El contador de avisos es POR VIAJE, no global: el segundo llevaba 3. Se
    // sigue escribiendo en el mismo UPDATE que intenta el claim, aunque falle.
    expect(updates[1].fila.avisos_enviados).toBe(4);
    expect(r).toMatchObject({ revisados: 3, reintentados: 2, escalados: 2 });
    expect(r.fallos).toHaveLength(1);
    expect(r.fallos[0]).toMatch(/marcar v-2: deadlock/);
  });

  it('DOS CORRIDAS SOLAPADAS sobre el mismo viaje vencido: solo UNA gana el claim y manda el aviso', async () => {
    // Esto es lo que motiva el fix: Vercel Cron entrega at-least-once, así que
    // dos corridas pueden llamar `escalarViajesSinAceptar` con el MISMO
    // `ahora` sobre el MISMO viaje sin que ninguna haya visto todavía el
    // `escalado_en` que pone la otra — el `lectura` mockeado se queda igual
    // entre las dos llamadas, exactamente como se vería en la base real si la
    // segunda corrida leyó antes de que la primera terminara de escribir.
    lectura = { data: [fila()], error: null };

    // Corrida 1: el UPDATE condicional del claim le devuelve la fila. Gana.
    resultadosUpdate = [{ data: [{ id: 'v-1' }], error: null }];
    const r1 = await escalarViajesSinAceptar({ telefonoJefePorTenant: TEL, ahora: AHORA });

    expect(r1.escalados).toBe(1);
    expect(avisarAlChofer).toHaveBeenCalledTimes(1);
    expect(sendTemplate).toHaveBeenCalledTimes(1);

    sendText.mockClear();
    sendTemplate.mockClear();
    avisarAlChofer.mockClear();

    // Corrida 2, "solapada": mismo viaje sin escalar en la lectura, mismo
    // `ahora`. Pero pierde: el claim ya no encuentra `escalado_en IS NULL`
    // porque la corrida 1 ya lo puso, así que el UPDATE condicional devuelve
    // cero filas.
    resultadosUpdate = [{ data: [], error: null }];
    const r2 = await escalarViajesSinAceptar({ telefonoJefePorTenant: TEL, ahora: AHORA });

    expect(r2.escalados).toBe(0);
    expect(r2.fallos).toEqual([]);   // perder la carrera no es un fallo
    // Lo que importa: NO reintenta ningún mensaje. Ni el recordatorio al
    // chofer ni el aviso al jefe (por texto o por plantilla) se mandan una
    // segunda vez sobre el mismo viaje.
    expect(avisarAlChofer).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('cada flota recibe el aviso en SU teléfono, y la que no tiene no le roba el de otra', async () => {
    lectura = {
      data: [fila({ id: 'v-1', tenant_id: 't-1' }), fila({ id: 'v-2', tenant_id: 't-2' })],
      error: null,
    };
    const r = await escalarViajesSinAceptar({
      telefonoJefePorTenant: { 't-1': '5211111111', 't-2': '5222222222' },
      ahora: AHORA,
    });
    expect(sendTemplate.mock.calls.map((c) => c[0])).toEqual(['5211111111', '5222222222']);
    expect(r.fallos).toEqual([]);
  });

  it('sin el mapa de teléfonos lo resuelve él, y solo para las flotas que salieron', async () => {
    // El mapa se deriva de la MISMA lista de viajes a propósito: con dos
    // consultas independientes, un viaje que cruce las 5 h entre una y otra se
    // marcaría como escalado sin que nadie le hubiera avisado al jefe.
    lectura = {
      data: [fila({ id: 'v-1', tenant_id: 't-1' }), fila({ id: 'v-2', tenant_id: 't-2' })],
      error: null,
    };
    telefonosJefe.mockResolvedValue({ 't-1': '5211111111', 't-2': '5222222222' });

    const r = await escalarViajesSinAceptar({ ahora: AHORA });

    expect(telefonosJefe).toHaveBeenCalledWith(['t-1', 't-2']);
    expect(sendTemplate.mock.calls.map((c) => c[0])).toEqual(['5211111111', '5222222222']);
    expect(r.escalados).toBe(2);
  });

  it('una flota sin jefe capturado en la base tampoco bloquea la marca', async () => {
    lectura = { data: [fila()], error: null };
    telefonosJefe.mockResolvedValue({});
    const r = await escalarViajesSinAceptar({ ahora: AHORA });
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(r.escalados).toBe(1);
    expect(r.fallos[0]).toMatch(/no tiene teléfono de jefe registrado/i);
  });

  it('un mapa pasado a mano gana: no se consulta la base de contactos', async () => {
    lectura = { data: [fila()], error: null };
    await escalarViajesSinAceptar({ telefonoJefePorTenant: TEL, ahora: AHORA });
    expect(telefonosJefe).not.toHaveBeenCalled();
  });

  it('sin viajes vencidos no manda nada ni escribe nada', async () => {
    lectura = { data: [], error: null };
    const r = await escalarViajesSinAceptar({ telefonoJefePorTenant: TEL, ahora: AHORA });
    expect(r).toEqual({ revisados: 0, reintentados: 0, escalados: 0, fallos: [], cortadosPorReloj: 0, rechazosReintentables: 0 });
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it('un error de la base no se traga: la corrida entera falla ruidosamente', async () => {
    lectura = { data: null, error: { message: 'connection refused' } };
    await expect(escalarViajesSinAceptar({ telefonoJefePorTenant: TEL, ahora: AHORA }))
      .rejects.toThrow(/connection refused/);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('deja en el log el resumen de la corrida', async () => {
    lectura = { data: [fila()], error: null };
    await escalarViajesSinAceptar({ telefonoJefePorTenant: TEL, ahora: AHORA });
    expect(logger.info).toHaveBeenCalledWith('viaje.escalacion', { revisados: 1, escalados: 1, fallos: 0 });
  });

  it('el UPDATE va acotado por tenant, no solo por id', async () => {
    // El id es la PK, así que hoy esto no evita ninguna fuga. Se acota igual
    // porque es la disciplina del repo (`acotada`, `reasignarOperador`): un
    // update sin acotar que hoy es inofensivo es el que mañana se copia a uno
    // que sí puede cruzar flotas.
    lectura = { data: [fila({ tenant_id: 't-9' })], error: null };
    await escalarViajesSinAceptar({ telefonoJefePorTenant: { 't-9': '52999' }, ahora: AHORA });
    expect(updates[0].por).toContainEqual(['tenant_id', 't-9']);
  });

  it('una EXCEPCIÓN de `sendTemplate` tampoco impide marcar ni corta el lote', async () => {
    // La invariante es "se marca pase lo que pase con el envío", y antes solo
    // aguantaba los fallos POR VALOR: con un `await` desnudo, una excepción
    // —JSON inválido, un timeout que cambie de forma— dejaba el viaje EN CURSO
    // sin marcar y los siguientes sin mirar. Una invariante que solo aguanta
    // una de las dos formas de fallar no es una invariante.
    sendTemplate.mockRejectedValue(new Error('socket hang up'));
    lectura = { data: [fila({ id: 'v-1', folio: 'VJ-1' }), fila({ id: 'v-2', folio: 'VJ-2' })], error: null };

    const r = await escalarViajesSinAceptar({ telefonoJefePorTenant: TEL, ahora: AHORA });

    // Los dos viajes se procesaron y los dos quedaron marcados.
    expect(avisarAlChofer).toHaveBeenCalledTimes(2);
    expect(updates.map((u) => u.por[0][1])).toEqual(['v-1', 'v-2']);
    expect(r.escalados).toBe(2);
    // Y el fallo NO se traga: dice a qué viaje y qué pasó.
    expect(r.fallos).toEqual(['jefe VJ-1: socket hang up', 'jefe VJ-2: socket hang up']);
  });

  it('una excepción sin mensaje también se reporta, no queda en blanco', async () => {
    sendTemplate.mockRejectedValue('se cayó');   // ni siquiera es un Error
    lectura = { data: [fila()], error: null };
    const r = await escalarViajesSinAceptar({ telefonoJefePorTenant: TEL, ahora: AHORA });
    expect(r.escalados).toBe(1);
    expect(r.fallos[0]).toMatch(/error inesperado al enviar/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// El aviso de `escalado` — el correo que sus plantillas esperaban desde el
// 14-ago sin llamador. El par `conductores:escalado` entró a CON_EMISOR en el
// mismo commit que este emisor; la contraprueba vive en
// `agentes/notificaciones.test.ts` ('`escalado` SÍ se guarda en conductores').
// ═══════════════════════════════════════════════════════════════════════════

describe('el aviso de escalados por flota', () => {
  /** Lo que `avisar` le entrega al armador; aquí se fabrica para poder abrir
   *  el correo real que el closure produce. */
  const datos = (magnitud: number) => ({
    flota: null, agente: 'Agente de Conductores', ruta: '/dashboard/agentes/conductores',
    magnitud, cuando: '14 ago 2026, 12:00',
  });
  type Armador = (d: ReturnType<typeof datos>) => { asunto: string; datos?: Array<[string, string]> };

  it('cada flota con escalados recibe UN aviso, con la magnitud medida y sus folios', async () => {
    lectura = {
      data: [
        fila({ id: 'v-1', tenant_id: 't-1', folio: 'VJ-1' }),
        fila({ id: 'v-2', tenant_id: 't-1', folio: 'VJ-2', operador: { nombre: 'Ana Ruiz' } }),
        // Sin folio capturado: el correo lo nombra por su id corto, nunca
        // le inventa un folio.
        fila({ id: 'aabbccdd-4444-4444-4444-444444444444', tenant_id: 't-2', folio: null }),
      ],
      error: null,
    };

    const r = await escalarViajesSinAceptar({
      telefonoJefePorTenant: { 't-1': '5211111111', 't-2': '5222222222' }, ahora: AHORA,
    });

    expect(r.escalados).toBe(3);
    expect(avisar).toHaveBeenCalledTimes(2);   // una por flota, no una por viaje

    const deT1 = avisar.mock.calls.find((c) => c[0] === 't-1')!;
    expect(deT1.slice(1, 4)).toEqual(['conductores', 'escalado', { hayProblema: true, magnitud: 2 }]);
    // El armador produce el correo REAL (`avisoEscalados`) con los folios de
    // ESA flota. El nombre de la flota se lo pasa `avisar` (d.flota) — el
    // closure no lo inventa.
    const correo = (deT1[4] as Armador)(datos(2));
    expect(correo.asunto).toBe('2 viajes escalados');
    expect(correo.datos).toEqual([['Viaje', 'VJ-1'], ['Viaje', 'VJ-2']]);

    const deT2 = avisar.mock.calls.find((c) => c[0] === 't-2')!;
    expect(deT2[3]).toEqual({ hayProblema: true, magnitud: 1 });
    expect((deT2[4] as Armador)(datos(1)).datos).toEqual([['Viaje', 'aabbccdd']]);
  });

  it('un fallo del aviso NO tumba la corrida ni se traga el cierre de corrida_fallida', async () => {
    // `avisar` promete no lanzar; la corrida no cuelga de esa promesa — se
    // prueba con la forma de fallo que la promesa NO cubre (misma razón que
    // el try del envío al jefe: una invariante que solo aguanta fallos por
    // valor no es una invariante).
    avisar.mockRejectedValue(new Error('canal de correo caído'));
    lectura = { data: [fila()], error: null };

    const r = await escalarViajesSinAceptar({ telefonoJefePorTenant: TEL, ahora: AHORA });

    expect(r.escalados).toBe(1);
    expect(r.fallos).toEqual([]);   // el aviso es observabilidad, no el trabajo
    expect(logger.error).toHaveBeenCalledWith('escalacion.aviso_escalados_roto',
      expect.objectContaining({ tenantId: 't-1' }));
    expect(avisarCorridasPorFlota).toHaveBeenCalledTimes(1);
  });

  it('una flota sin escalados CIERRA el incidente de "escalado" (AG-A5, auditoría 28): un claim que no se pudo escribir no es un viaje escalado', async () => {
    resultadosUpdate = [{ error: { message: 'deadlock' } }];
    lectura = { data: [fila()], error: null };

    const r = await escalarViajesSinAceptar({ telefonoJefePorTenant: TEL, ahora: AHORA });

    expect(r.escalados).toBe(0);
    // Hasta la auditoría 28 esto era `expect(avisar).not.toHaveBeenCalled()`:
    // una flota SIN escalados exitosos nunca mandaba `hayProblema: false`, así
    // que el filo de `escalado` no se re-armaba y tras la tercera marca de
    // insistencia quedaba mudo para siempre. Ahora SÍ se llama —con la
    // magnitud real, cero— porque esta flota SÍ fue evaluada esta corrida
    // (tuvo un candidato, aunque el claim fallara). El fallo del claim en sí
    // se cuenta aparte, como `corrida_fallida` (ver abajo).
    expect(avisar).toHaveBeenCalledTimes(1);
    expect(avisar.mock.calls[0].slice(0, 4)).toEqual(
      ['t-1', 'conductores', 'escalado', { hayProblema: false, magnitud: 0 }],
    );
    // Pero SÍ entra al cierre de corrida_fallida: la escritura del claim
    // falló, y eso es "el agente no pudo trabajar" para esa flota.
    expect(avisarCorridasPorFlota).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B4 — el corte de horas es ESTRATEGIA de cada flota (tenant.config), no una
// constante. La consulta global trae candidatos desde el piso (1 h) y el corte
// fino lo pone `agentes.conductores.horasEscalacion`; sin fila de config, el
// default de demo son las 5 h de siempre.
// ═══════════════════════════════════════════════════════════════════════════

describe('B4 — las horas de escalación se leen de la estrategia de cada flota', () => {
  /** Los dos viajes llevan 3 h avisados: dentro del corte de una flota
   *  configurada a 2 h, fuera del default de 5. */
  const HACE_3H = '2026-08-04T15:00:00.000Z';

  it('la flota con 2 h configuradas escala a las 3 h; la del default (5 h) todavía no', async () => {
    lectura = {
      data: [
        fila({ id: 'v-rapida', tenant_id: 't-rapida', folio: 'VJ-R', avisado_en: HACE_3H }),
        fila({ id: 'v-default', tenant_id: 't-default', folio: 'VJ-D', avisado_en: HACE_3H }),
      ],
      error: null,
    };
    configPorTenant = {
      't-rapida': { data: { rfc: null, config: { agentes: { conductores: { horasEscalacion: 2 } } } }, error: null },
      // 't-default' sin entrada: sin fila de config → defaults de demo (5 h).
    };

    const r = await escalarViajesSinAceptar({
      telefonoJefePorTenant: { 't-rapida': '5211111111', 't-default': '5222222222' }, ahora: AHORA,
    });

    // La consulta global pide candidatos desde el PISO (1 h), no desde 5: el
    // corte fino es de cada flota.
    expect(args('lte')).toContainEqual(['avisado_en', '2026-08-04T17:00:00.000Z']);
    // Solo el viaje de la flota rápida entra a la corrida; el otro ni cuenta
    // como revisado — su reloj de 5 h todavía no vence.
    expect(r.revisados).toBe(1);
    expect(r.escalados).toBe(1);
    expect(updates.map((u) => u.por[0][1])).toEqual(['v-rapida']);
    // Y el texto del jefe cita las horas de SU flota, no las 5 fijas.
    expect(sendText.mock.calls[0][1]).toContain('en 2 horas');
  });

  it('si la config de una flota no se puede leer, SUS viajes se saltan la corrida y se grita', async () => {
    // Escalar contra una estrategia que no se pudo consultar es escalar con
    // los datos equivocados: la flota no escala, no cuenta en revisados, y NO
    // entra al cierre de corridas (ni éxito ni fallo) — la corrida de la
    // siguiente hora la levanta entera.
    lectura = {
      data: [
        fila({ id: 'v-rota', tenant_id: 't-rota', folio: 'VJ-X' }),
        fila({ id: 'v-sana', tenant_id: 't-sana', folio: 'VJ-S' }),
      ],
      error: null,
    };
    configPorTenant = { 't-rota': new Error('PostgREST 503') };

    const r = await escalarViajesSinAceptar({
      telefonoJefePorTenant: { 't-rota': '5211111111', 't-sana': '5222222222' }, ahora: AHORA,
    });

    expect(r.revisados).toBe(1);
    expect(r.escalados).toBe(1);
    expect(updates.map((u) => u.por[0][1])).toEqual(['v-sana']);
    expect(logger.error).toHaveBeenCalledWith('escalacion.config_ilegible',
      expect.objectContaining({ tenant: 't-rota' }));
    // El cierre de corridas solo lleva a la flota que SÍ corrió.
    const [, cierre] = avisarCorridasPorFlota.mock.calls[0] as [string, Map<string, unknown>];
    expect([...cierre.keys()]).toEqual(['t-sana']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B6 — la bitácora de corridas (B3) es observabilidad, no el trabajo: su
// cableado queda fijado y su fallo no puede tumbar la escalación.
// ═══════════════════════════════════════════════════════════════════════════

describe('la bitácora de corridas no puede tumbar la escalación', () => {
  it('se anota una corrida por flota, con el agente y el estado correctos', async () => {
    lectura = { data: [fila()], error: null };
    await escalarViajesSinAceptar({ telefonoJefePorTenant: TEL, ahora: AHORA });

    expect(registrarCorrida).toHaveBeenCalledTimes(1);
    expect(registrarCorrida).toHaveBeenCalledWith('t-1', 'conductores', expect.objectContaining({
      estado: 'ok', disparo: 'cron', tareasHechas: 1, tareasTotal: 1,
    }));
  });

  it('un fallo de `registrarCorrida` no tumba la corrida ni se traga los avisos', async () => {
    // `registrarCorrida` promete no lanzar (corridas.test.ts fija esa
    // promesa); la corrida no cuelga de ella — se prueba con la forma de
    // fallo que la promesa NO cubre, el mismo criterio que el try del envío
    // al jefe: una invariante que solo aguanta fallos por valor no es una
    // invariante.
    registrarCorrida.mockRejectedValue(new Error('bitácora caída'));
    lectura = { data: [fila()], error: null };

    const r = await escalarViajesSinAceptar({ telefonoJefePorTenant: TEL, ahora: AHORA });

    expect(r.escalados).toBe(1);
    expect(r.fallos).toEqual([]);
    // El cierre de corrida_fallida y el aviso de escalado salieron igual.
    expect(avisarCorridasPorFlota).toHaveBeenCalledTimes(1);
    expect(avisar).toHaveBeenCalledTimes(1);
  });
});
