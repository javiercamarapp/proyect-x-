import { describe, it, expect, vi, beforeEach } from 'vitest';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger }));

// ── El doble de la base ────────────────────────────────────────────────────
//
// Registra la OPERACIÓN y su orden, que es de lo que dependen los dos
// hallazgos del ciclo 7 sobre este archivo: que el sello se RESERVE antes de
// mandar (c7-17) y que un error de configuración no se lea como una
// configuración (c7-8). Un mock que devolviera el builder e ignorara todo —el
// patrón que la auditoría señaló como la única red bajo cinco archivos— no
// puede ver ni el orden ni el error.
type Op = {
  tabla: string; op: string; payload?: unknown; eq: Array<[string, unknown]>;
  /** Las columnas por las que se pidió orden. El corte de una lectura que se
   *  trunca depende de esto: sin `order` la rebanada es el orden FÍSICO de la
   *  tabla y qué flota se queda sin aviso es azar del heap. */
  order: string[];
  /** El `.range(desde, hasta)` que pidió esta vuelta de `traerTodo`. */
  range?: [number, number];
};
const ops: Op[] = [];
const respuestas = new Map<string, Array<{ data?: unknown; error?: { message: string; code?: string } | null }>>();

// ── El doble PAGINADO de `gasto` ────────────────────────────────────────────
//
// AUDITORÍA 28, MEDIO (REN-A4): `peaje_cierre.ts` leía `gasto` con
// `traerTodo`, que pide páginas reales por `.range(desde, hasta)`. El doble de
// arriba (`respuestas`) entrega TODO en una sola respuesta y deja que la
// SEGUNDA llamada — que cae al default `{ data: [], error: null }` — pruebe el
// final: eso basta para los fixtures chicos de este archivo, pero NUNCA
// ejercita que `traerTodo` de verdad ensambla páginas ni que el cursor avanza
// por filas leídas. `gastoFuente` simula el recorte real de PostgREST: cada
// `.range()` recibe SOLO su rebanada del dataset sembrado.
let gastoFuente: ((desde: number, hasta: number) => { data: unknown[]; count?: number }) | null = null;

function builder(tabla: string) {
  const o: Op = { tabla, op: 'select', eq: [], order: [] };
  const responder = () => {
    ops.push(o);
    if (tabla === 'gasto' && gastoFuente) {
      const [desde, hasta] = o.range ?? [0, Number.MAX_SAFE_INTEGER];
      return gastoFuente(desde, hasta);
    }
    const cola = respuestas.get(`${tabla}:${o.op}`) ?? respuestas.get(tabla);
    return cola && cola.length > 0 ? cola.shift()! : { data: [], error: null };
  };
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: () => b, eq: (c: string, v: unknown) => { o.eq.push([c, v]); return b; },
    is: () => b, in: () => b, gte: () => b, lte: () => b, limit: () => b,
    order: (c: string) => { o.order.push(c); return b; },
    range: (desde: number, hasta: number) => { o.range = [desde, hasta]; return b; },
    insert: (p: unknown) => { o.op = 'insert'; o.payload = p; return b; },
    delete: () => { o.op = 'delete'; return b; },
    maybeSingle: async () => responder(),
    then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve().then(responder).then(res, rej),
  });
  return b;
}
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: (t: string) => builder(t) }) }));
vi.mock('@/lib/likida/presupuesto', () => ({ acotada: (q: unknown) => q }));

const sendText = vi.fn(async (_t: string, _b: string) => 'wamid-1' as string | null);
vi.mock('@/lib/meta/client', () => ({ sendText: (t: string, b: string) => sendText(t, b) }));

const telefonoParaDineroDe = vi.fn(async (_t: string) => '5215500000000' as string | null);
vi.mock('../contactos', () => ({ telefonoParaDineroDe: (t: string) => telefonoParaDineroDe(t) }));

// Import DINÁMICO y no estático: los `vi.mock` de arriba se izan al tope del
// archivo y sus fábricas cierran sobre constantes de este módulo (`logger`,
// `sendText`). Con un `import` estático el módulo bajo prueba se evalúa antes
// que esas constantes existan y la fábrica revienta con «Cannot access
// 'logger' before initialization».
const {
  ultimoDiaDelMes, primerDiaDelMes, diasHastaCierre, umbralDeHoy,
  mensajeCierrePeaje, avisarCierrePeaje, DIAS_AVISO_DEFECTO, MAX_LINEAS,
} = await import('./peaje_cierre');

describe('el calendario del cierre de mes', () => {
  it('el último día del mes sale bien en meses de 30, 31 y en febrero', () => {
    expect(ultimoDiaDelMes('2026-09-10')).toBe('2026-09-30');
    expect(ultimoDiaDelMes('2026-08-01')).toBe('2026-08-31');
    expect(ultimoDiaDelMes('2026-02-05')).toBe('2026-02-28');
    // 2028 es bisiesto: la cuenta no se hace con una tabla escrita a mano.
    expect(ultimoDiaDelMes('2028-02-05')).toBe('2028-02-29');
    expect(ultimoDiaDelMes('2026-12-31')).toBe('2026-12-31');
  });

  it('el periodo del sello es el día 1: un mes es UN ciclo, no treinta', () => {
    expect(primerDiaDelMes('2026-09-17')).toBe('2026-09-01');
  });

  it('los días que faltan cuentan hasta el cierre, y el último día son cero', () => {
    expect(diasHastaCierre('2026-09-23')).toBe(7);
    expect(diasHastaCierre('2026-09-30')).toBe(0);
    expect(diasHastaCierre('2026-09-01')).toBe(29);
  });
});

describe('umbralDeHoy — dos avisos, no treinta', () => {
  it('avisa con la anticipación de la flota', () => {
    expect(umbralDeHoy('2026-09-23')).toBe(7); // default
    expect(DIAS_AVISO_DEFECTO).toBe(7);
  });

  it('avisa SIEMPRE el último día, sea cual sea la anticipación configurada', () => {
    // Es el aviso que ya no admite postergarse: mañana el derecho no existe.
    expect(umbralDeHoy('2026-09-30', 15)).toBe(0);
    expect(umbralDeHoy('2026-09-30', 1)).toBe(0);
  });

  it('CUALQUIER otro día calla — un aviso diario entrena a ignorarlo', () => {
    expect(umbralDeHoy('2026-09-15')).toBeNull();
    expect(umbralDeHoy('2026-09-22')).toBeNull();
    expect(umbralDeHoy('2026-09-24')).toBeNull();
  });

  it('respeta la anticipación declarada por la flota', () => {
    expect(umbralDeHoy('2026-09-15', 15)).toBe(15);
    expect(umbralDeHoy('2026-09-23', 15)).toBeNull();
  });
});

describe('mensajeCierrePeaje', () => {
  const gastos = [
    { id: 'a', monto: 300, fecha: '2026-09-03' },
    { id: 'b', monto: 450.5, fecha: '2026-09-08' },
  ];

  it('dice el plazo, la lista y el paso exacto — y cita la regla', () => {
    const m = mensajeCierrePeaje(gastos, 7, 750.5);
    expect(m).toMatch(/Faltan 7 días/);
    expect(m).toMatch(/2 cruces de caseta sin CFDI/);
    expect(m).toMatch(/2026-09-03/);
    expect(m).toMatch(/último día del mes en curso/);
    // Likida AVISA; el acto sigue siendo de la flota.
    expect(m).toMatch(/Entra a tu portal/);
  });

  it('el último día habla distinto: HOY vence', () => {
    const m = mensajeCierrePeaje(gastos, 0, 750.5);
    expect(m).toMatch(/HOY vence/);
    expect(m).not.toMatch(/Faltan 0/);
  });

  it('con muchos cruces corta la lista y dice cuántos faltan', () => {
    const muchos = Array.from({ length: 14 }, (_, i) => ({
      id: String(i), monto: 100, fecha: '2026-09-05',
    }));
    const m = mensajeCierrePeaje(muchos, 7, 1400);
    expect(m.match(/^· /gm)).toHaveLength(MAX_LINEAS);
    expect(m).toMatch(/y 4 cruces más/);
  });

  it('un solo cruce se dice en singular', () => {
    const m = mensajeCierrePeaje([gastos[0]], 7, 300);
    expect(m).toMatch(/1 cruce de caseta/);
    expect(m).not.toMatch(/cruces más/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LAS PRUEBAS QUE FALTABAN — auditoría adversarial del ciclo 7.
//
// El archivo tenía 95 líneas y solo ejercitaba las funciones puras. `avisarCierrePeaje`
// —el barrido entero: la configuración, el sello, el envío— NO tenía ni una
// prueba, y ahí vivían los dos hallazgos.
// ═══════════════════════════════════════════════════════════════════════════

/** El 23 de septiembre de 2026: faltan 7 días para el cierre (umbral default). */
const DIA_UMBRAL_7 = new Date('2026-09-23T18:00:00Z');
/** El 15 de septiembre: faltan 15. Solo avisa a quien configuró 15. */
const DIA_UMBRAL_15 = new Date('2026-09-15T18:00:00Z');
/** El 30 de septiembre: HOY vence, para todas. */
const DIA_CIERRE = new Date('2026-09-30T18:00:00Z');

const GASTOS_T1 = [
  { id: 'g1', tenant_id: 't-1', monto: 300, fecha: '2026-09-03' },
  { id: 'g2', tenant_id: 't-1', monto: 450.5, fecha: '2026-09-08' },
];

function sembrar(
  { gastos = GASTOS_T1, config = [] as unknown[], errorConfig = null as { message: string } | null }:
  { gastos?: unknown[]; config?: unknown[]; errorConfig?: { message: string } | null } = {},
) {
  respuestas.set('gasto', [{ data: gastos, error: null }]);
  respuestas.set('sat_descarga_config', [{ data: errorConfig ? null : config, error: errorConfig }]);
}

const insertsDeSello = () => ops.filter((o) => o.tabla === 'peaje_cierre_aviso' && o.op === 'insert');
const deletesDeSello = () => ops.filter((o) => o.tabla === 'peaje_cierre_aviso' && o.op === 'delete');

beforeEach(() => {
  ops.length = 0;
  respuestas.clear();
  gastoFuente = null;
  sendText.mockClear();
  sendText.mockResolvedValue('wamid-1');
  telefonoParaDineroDe.mockClear();
  telefonoParaDineroDe.mockResolvedValue('5215500000000');
  for (const f of Object.values(logger)) f.mockClear();
});

describe('c7-17 · el sello se RESERVA antes de mandar: la idempotencia es la PK, no un `if`', () => {
  it('el orden es reservar → mandar, nunca mandar → sellar', async () => {
    sembrar();
    const r = await avisarCierrePeaje(DIA_UMBRAL_7);

    expect(r.avisadas).toBe(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    // EL ORDEN, que es la invariante entera: el insert del sello ocurre ANTES
    // del envío. Con «consulto, mando y sello», dos invocaciones solapadas del
    // cron leían las dos «no hay sello», las dos mandaban el WhatsApp, y la
    // segunda rebotaba con 23505 cuando el mensaje duplicado YA estaba en el
    // teléfono de la flota — en el canal del dinero, que es el que el resto
    // del repo protege con pisos horarios para que nadie aprenda a ignorarlo.
    const iSello = ops.findIndex((o) => o.tabla === 'peaje_cierre_aviso' && o.op === 'insert');
    expect(iSello).toBeGreaterThanOrEqual(0);
    expect(telefonoParaDineroDe.mock.invocationCallOrder[0])
      .toBeGreaterThan(0); // el teléfono se pide después de ganar la reserva
    expect(insertsDeSello()[0].payload).toMatchObject({
      tenant_id: 't-1', periodo: '2026-09-01', umbral: 7, gastos: 2,
    });
    expect(deletesDeSello()).toHaveLength(0);
  });

  it('la corrida que PIERDE la carrera (23505) no manda nada', async () => {
    sembrar();
    respuestas.set('peaje_cierre_aviso:insert', [
      { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } },
    ]);
    const r = await avisarCierrePeaje(DIA_UMBRAL_7);

    expect(sendText, 'la PK es el árbitro: la que pierde se calla').not.toHaveBeenCalled();
    expect(r.avisadas).toBe(0);
  });

  it('un error de base que NO es el duplicado tampoco manda: no se avisa con la duda', async () => {
    // Antes, `const { data: sello }` no leía `error`: un timeout de `acotada`
    // devolvía `data: null`, se leía como «todavía no se ha avisado» y
    // REENVIABA.
    sembrar();
    respuestas.set('peaje_cierre_aviso:insert', [
      { data: null, error: { message: 'sin respuesta en 8000 ms (tope de consulta)' } },
    ]);
    const r = await avisarCierrePeaje(DIA_UMBRAL_7);

    expect(sendText).not.toHaveBeenCalled();
    expect(r.sinReserva).toBe(1);
    expect(r.avisadas).toBe(0);
    expect(logger.error).toHaveBeenCalledWith('peaje_cierre.sin_reserva', expect.anything());
  });

  it('si el WhatsApp no sale, la reserva se SUELTA: la corrida siguiente reintenta', async () => {
    sembrar();
    sendText.mockResolvedValue(null);
    const r = await avisarCierrePeaje(DIA_UMBRAL_7);

    expect(r.avisadas).toBe(0);
    // El umbral es un día exacto que no vuelve: una reserva sobre un mensaje
    // que nunca salió enterraría el aviso del mes entero.
    expect(deletesDeSello()).toHaveLength(1);
    expect(deletesDeSello()[0].eq).toEqual([['tenant_id', 't-1'], ['periodo', '2026-09-01'], ['umbral', 7]]);
  });

  it('sin destinatario tampoco queda sello: el día que registren al contador, el aviso todavía puede salir', async () => {
    sembrar();
    telefonoParaDineroDe.mockResolvedValue(null);
    const r = await avisarCierrePeaje(DIA_UMBRAL_7);

    expect(r.sinDestinatario).toBe(1);
    expect(r.avisadas).toBe(0);
    expect(deletesDeSello()).toHaveLength(1);
  });

  it('una reserva que no se pudo soltar se GRITA y se cuenta: es un aviso perdido', async () => {
    sembrar();
    sendText.mockResolvedValue(null);
    respuestas.set('peaje_cierre_aviso:delete', [{ data: null, error: { message: 'base caída' } }]);
    const r = await avisarCierrePeaje(DIA_UMBRAL_7);

    expect(r.reservasAtoradas).toBe(1);
    expect(logger.error).toHaveBeenCalledWith('peaje_cierre.reserva_atorada', expect.anything());
  });

  it('el canal de UNA flota que truena no le cuesta el aviso a las demás', async () => {
    sembrar({
      gastos: [
        ...GASTOS_T1,
        { id: 'g3', tenant_id: 't-2', monto: 100, fecha: '2026-09-04' },
      ],
    });
    sendText.mockRejectedValueOnce(new Error('Meta devolvió 500'));
    const r = await avisarCierrePeaje(DIA_UMBRAL_7);

    expect(r.flotas).toBe(2);
    expect(r.avisadas, 'la segunda flota sí recibió el suyo').toBe(1);
    expect(deletesDeSello(), 'la reserva de la que tronó se soltó').toHaveLength(1);
  });
});

describe('c7-8 · «no pude leer tu configuración» NO es «tu configuración es 7»', () => {
  it('con la configuración ILEGIBLE no se inventa el default: se salta y se LANZA', async () => {
    // El escenario del hallazgo: una flota configuró `peaje_dias_aviso = 10`.
    // El día que faltan 10, la lectura de configuración falla; antes, `diasDe`
    // venía vacío, el `?? DIAS_AVISO_DEFECTO` inventaba un 7 y `umbralDeHoy`
    // —que solo dispara con `faltan === diasAviso` EXACTO— devolvía null.
    // Mañana faltan 9, tampoco es 7: NO HAY SEGUNDA OPORTUNIDAD. La flota
    // perdía su aviso de 10 días entero y solo recibía el de «HOY vence»,
    // demasiado tarde para entrar al portal de PASE. Dinero que ya no se
    // puede facturar, por un valor inventado a partir de un error tragado.
    sembrar({ errorConfig: { message: 'sin respuesta en 8000 ms (tope de consulta)' } });

    await expect(avisarCierrePeaje(DIA_UMBRAL_15)).rejects.toThrow(/no se pudo leer sat_descarga_config/);
    expect(sendText, 'no se manda un aviso calculado con un umbral inventado').not.toHaveBeenCalled();
    expect(insertsDeSello(), 'y no se sella nada que no salió').toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith('peaje_cierre.config_ilegible', expect.anything());
  });

  it('con la configuración ilegible, el aviso del ÚLTIMO DÍA sí sale: no depende de ella', async () => {
    // Fail-closed no es «no hacer nada»: el umbral 0 es el cierre para TODAS
    // las flotas, lo hayan configurado o no, y es el que ya no admite
    // postergarse.
    sembrar({ errorConfig: { message: 'base caída' } });

    await expect(avisarCierrePeaje(DIA_CIERRE)).rejects.toThrow(/El aviso del último día del mes no depende de esa configuración y sí salió: 1 enviado/);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0][1]).toMatch(/HOY vence/);
    expect(insertsDeSello()[0].payload).toMatchObject({ umbral: 0 });
  });

  it('con la configuración LEÍDA, la anticipación declarada por la flota manda', async () => {
    sembrar({ config: [{ tenant_id: 't-1', peaje_dias_aviso: 15 }] });
    const r = await avisarCierrePeaje(DIA_UMBRAL_15);

    expect(r.avisadas).toBe(1);
    expect(insertsDeSello()[0].payload).toMatchObject({ umbral: 15 });
    // Y ese mismo día NO le toca a quien usa el default de 7.
    ops.length = 0;
    sembrar({ config: [] });
    expect((await avisarCierrePeaje(DIA_UMBRAL_15)).avisadas).toBe(0);
  });

  it('sin casetas sin CFDI no se toca la configuración ni el sello', async () => {
    sembrar({ gastos: [] });
    const r = await avisarCierrePeaje(DIA_UMBRAL_7);
    expect(r).toMatchObject({ corrio: true, flotas: 0, avisadas: 0, gastos: 0, sinReserva: 0, reservasAtoradas: 0 });
    expect(sendText).not.toHaveBeenCalled();
  });

  it('un error leyendo los GASTOS sigue lanzando: no se avisa sobre un mes que no se leyó', async () => {
    respuestas.set('gasto', [{ data: null, error: { message: 'base caída' } }]);
    await expect(avisarCierrePeaje(DIA_UMBRAL_7)).rejects.toThrow(/base caída/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EL RELOJ DE LA VUELTA, Y LA LECTURA QUE SE TRUNCA EN SILENCIO.
//
// Las dos son del rebase del ciclo 7, no del commit original, y las dos son la
// misma clase de fallo: un barrido que hace MENOS trabajo del que cree y no lo
// dice. `avisarCierrePeaje` itera flota por flota con dos viajes de red de por
// medio (el teléfono y el WhatsApp) y corre DESPUÉS de `correrDescargaSat`
// dentro de los mismos 300 s. El runner ya murió mudo dos veces por bucles que
// no preguntaban la hora — 25-ago-2026 y 28-ago-2026, con correo de alerta de
// por medio— y este bucle era el siguiente de la lista.
// ═══════════════════════════════════════════════════════════════════════════

/** Casetas de tres flotas distintas: el barrido tiene tres vueltas que dar. */
const GASTOS_TRES_FLOTAS = [
  { id: 'g1', tenant_id: 't-1', monto: 300, fecha: '2026-09-03' },
  { id: 'g2', tenant_id: 't-2', monto: 120, fecha: '2026-09-04' },
  { id: 'g3', tenant_id: 't-3', monto: 90, fecha: '2026-09-05' },
];

describe('el reloj de la vuelta, adentro del motor (patrón #152)', () => {
  it('sin `venceEn` el barrido corre completo, como siempre', async () => {
    sembrar({ gastos: GASTOS_TRES_FLOTAS });
    const r = await avisarCierrePeaje(DIA_UMBRAL_7);
    expect(r.avisadas).toBe(3);
    expect(r.sinTurno, 'nadie se quedó sin turno: no había reloj').toBe(0);
  });

  it('con el reloj YA vencido no se manda un solo WhatsApp, y se DICE cuántas quedaron', async () => {
    sembrar({ gastos: GASTOS_TRES_FLOTAS });
    const r = await avisarCierrePeaje(DIA_UMBRAL_7, { venceEn: Date.now() - 1 });

    expect(sendText, 'el reloj se pregunta ANTES del primer envío').not.toHaveBeenCalled();
    expect(r.sinTurno, 'las tres flotas quedaron sin mirar, y el número sale en el resumen').toBe(3);
    expect(r.avisadas).toBe(0);
    // LO QUE DE VERDAD IMPORTA: el corte ocurre antes de RESERVAR. Un sello
    // tomado sobre un mensaje que no salió entierra el aviso del mes —el
    // umbral es un día exacto y no vuelve—, así que cortar entre la reserva y
    // el envío sería peor que no cortar.
    expect(insertsDeSello(), 'ni una reserva tomada: cortar con el sello puesto enterraría el aviso').toHaveLength(0);
    expect(deletesDeSello(), 'y por lo tanto tampoco hay ninguna que soltar').toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith('peaje_cierre.corte_por_reloj', expect.objectContaining({ sinTurno: 3 }));
  });

  it('la flota que YA ganó su reserva se termina: el corte no deja un sello a medias', async () => {
    sembrar({ gastos: GASTOS_TRES_FLOTAS });
    // El reloj se agota DURANTE la primera flota: pedir el teléfono "tarda"
    // lo suficiente para pasarse del límite. La primera tiene que llegar hasta
    // el final —ya había reservado— y las otras dos no deben ni empezar.
    const t0 = Date.now();
    let ahora = t0;
    const reloj = vi.spyOn(Date, 'now').mockImplementation(() => ahora);
    telefonoParaDineroDe.mockImplementation(async (_t: string) => {
      ahora = t0 + 60_000; // se acabó el tiempo mientras se atendía a t-1
      return '5215500000000';
    });
    const r = await avisarCierrePeaje(DIA_UMBRAL_7, { venceEn: t0 + 30_000 });
    reloj.mockRestore();

    expect(r.avisadas, 'la primera se completó: reservó, mandó y selló').toBe(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(r.sinTurno, 'las dos siguientes ni se empezaron').toBe(2);
    expect(deletesDeSello(), 'el sello de la que sí mandó se queda puesto').toHaveLength(0);
  });
});

describe('la lectura de casetas: `traerTodo` pagina de verdad, ya no hay «5,000 y ya»', () => {
  it('más de una página de casetas se ENSAMBLA completa: ninguna flota se pierde entre páginas', async () => {
    // AUDITORÍA 28, MEDIO (REN-A4). Antes esto era UNA página con
    // `.limit(5_000)`: a 200 flotas con casetas diarias los 5,000 cruces del
    // mes se agotaban y las flotas fuera del corte no recibían NINGÚN aviso,
    // declarado solo como `truncado: true` mientras el barrido seguía con el
    // subconjunto. El mock de un solo tiro nunca ejercitaba el ensamblado real
    // de páginas —devolvía las 5,000 de golpe—, así que un `range()` mal
    // pasado no se habría notado. Aquí van 2,500 filas (más de dos páginas de
    // `PAGINA = 1_000`) REPARTIDAS entre tres flotas straddling el corte de
    // página, y `gastoFuente` sólo entrega la rebanada que `.range()` pidió.
    const TOTAL = 2_500;
    const dataset = Array.from({ length: TOTAL }, (_, i) => ({
      // tenant_id ordena PRIMERO: t-0 cae en la página 1, t-1 straddling la
      // 1/2, t-2 en la 2/3 — las tres deben sobrevivir el ensamblado.
      id: String(i).padStart(6, '0'),
      tenant_id: `t-${i % 3}`,
      monto: 10,
      fecha: '2026-09-03',
    }));
    gastoFuente = (desde, hasta) => ({
      data: dataset.slice(desde, hasta + 1),
      count: TOTAL,
    });
    respuestas.set('sat_descarga_config', [{ data: [], error: null }]);

    const r = await avisarCierrePeaje(DIA_UMBRAL_7);

    // Se pidieron varias páginas de verdad — no una respuesta de un solo tiro.
    const lecturas = ops.filter((o) => o.tabla === 'gasto');
    expect(lecturas.length, 'TOTAL/PAGINA = 2.5 páginas → 3 vueltas de traerTodo').toBe(3);
    expect(lecturas.map((o) => o.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    // Las TRES flotas —incluida la que cae partida entre dos páginas— avisan.
    expect(r.flotas).toBe(3);
    expect(r.avisadas).toBe(3);
    expect(r.gastos).toBe(TOTAL);
    expect(r.truncado).toBe(false);
  });

  it('la lectura va ORDENADA con desempate por `id`: el corte de página es determinista', async () => {
    // Sin un desempate único, dos filas con el mismo `(tenant_id, fecha)`
    // pueden empatar el orden y el corte de página deja de ser reproducible.
    sembrar({ gastos: GASTOS_TRES_FLOTAS });
    await avisarCierrePeaje(DIA_UMBRAL_7);
    const lectura = ops.find((o) => o.tabla === 'gasto');
    expect(lectura?.order).toEqual(['tenant_id', 'fecha', 'id']);
  });

  it('una lectura que nunca puede demostrar que trajo todo LANZA en vez de seguir con un subconjunto', async () => {
    // El reemplazo honesto del viejo `truncado: true`: si la fuente nunca
    // entrega una página vacía ni un `count`, `traerTodo` no puede demostrar
    // que terminó y se niega a devolver una cifra parcial — agota sus 100
    // páginas (100,000 filas) y LANZA `LecturaIncompleta`, fail-closed, igual
    // que `configIlegible` en este mismo archivo. Antes esto habría sido
    // `truncado: true` con el barrido avisando de todos modos sobre un
    // subconjunto arbitrario de flotas.
    gastoFuente = (desde, hasta) => ({
      data: Array.from({ length: hasta - desde + 1 }, (_, i) => ({
        id: String(desde + i), tenant_id: 't-interminable', monto: 1, fecha: '2026-09-03',
      })),
      // Sin `count`: nunca se demuestra el total.
    });
    respuestas.set('sat_descarga_config', [{ data: [], error: null }]);

    await expect(avisarCierrePeaje(DIA_UMBRAL_7)).rejects.toThrow(/avisarCierrePeaje/);
    expect(sendText, 'no se avisa sobre una lectura que no se pudo demostrar completa').not.toHaveBeenCalled();
    expect(insertsDeSello()).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith('pg.lectura_incompleta', expect.objectContaining({
      consulta: 'peaje_cierre.gastos',
    }));
  });

  it('una lectura chica (una sola página) sigue funcionando y no se declara truncada', async () => {
    sembrar({ gastos: GASTOS_TRES_FLOTAS });
    expect((await avisarCierrePeaje(DIA_UMBRAL_7)).truncado).toBe(false);
  });
});
