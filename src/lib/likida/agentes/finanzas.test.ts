import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

// ═══════════════════════════════════════════════════════════════════════════
// LOS 4 AGENTES FINANCIEROS (0215) — los contratos que el código sostiene:
//  · CERO modelo: cada cifra del parte la calculó el sistema — el agente no
//    puede alucinar porque no hay quién alucine.
//  · Fail closed y DICHO: una lectura caída ⇒ corrida en fallo y NINGÚN
//    parte — jamás un parte de $0 sobre una base ciega.
//  · Un parte por periodo: el pre-check corta; el índice único de la 0215 es
//    el árbitro real y su rebote se trata como «ya existía», no como fallo.
//  · Los ROJOS (U1 de costos, runway < 3 meses) van al operador YA, sin
//    esperar a que alguien abra la bandeja.
//  · NULL ≠ 0 en todos lados: sin viajes no hay costo unitario; sin saldo
//    declarado no hay runway; churn sin base es SIN DATO.
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// EL MOCK QUE NO FABRICA LA FUENTE (primera pasada real del runner, 18:03).
//
// `leerSuscripcionesActivas` pedía `suscripcion.plan` — una columna que NO
// existe (la real es `plan_clave`, 0052) — y producción contestó 42703: el
// parte de métricas nacía muerto en TODAS las corridas. La suite pasaba
// porque este `select()` ignoraba sus argumentos y devolvía filas felices;
// es el mismo pecado del hallazgo c5-9.
//
// Desde aquí el mock LEE EL ESQUEMA REAL de la migración y se comporta como
// Postgres: una columna que la tabla no tiene devuelve el 42703 de verdad.
// Una consulta inventada ya no puede pasar verde.
// ═══════════════════════════════════════════════════════════════════════════

/** Columnas declaradas por `create table public.<tabla>` en una migración. */
function columnasDeMigracion(sql: string, tabla: string): Set<string> {
  const inicio = sql.indexOf(`create table if not exists public.${tabla} (`);
  if (inicio < 0) throw new Error(`No se encontró el create table de ${tabla} en la migración`);
  const cuerpo = sql.slice(sql.indexOf('(', inicio) + 1, sql.indexOf('\n);', inicio));
  const cols = new Set<string>();
  for (const linea of cuerpo.split('\n')) {
    const l = linea.replace(/--.*$/, '').trim();
    const m = l.match(/^([a-z_][a-z0-9_]*)\s+(uuid|text|int|integer|boolean|date|timestamptz|numeric|jsonb)\b/i);
    if (m) cols.add(m[1]);
  }
  if (cols.size === 0) throw new Error(`Esquema vacío para ${tabla} — el parser de la migración se rompió`);
  return cols;
}

/** El esquema REAL de las tablas que este módulo consulta por nombre de
 *  columna. Se lee del SQL, no de una lista escrita a mano que se desincroniza. */
const ESQUEMA_REAL: Record<string, Set<string>> = {
  suscripcion: columnasDeMigracion(
    readFileSync('supabase/migrations/0052_saas_plan_suscripcion.sql', 'utf8'), 'suscripcion'),
};

/** Las columnas de un `.select(...)` de PostgREST, sin embebidos ni alias. */
function columnasPedidas(expr: string): string[] {
  return expr
    .replace(/\([^)]*\)/g, '')          // embebidos: plan(nombre)
    .replace(/!(inner|left)\b/g, '')    // AGB-10: el hint de join, tenant_id!inner
    .split(',')
    .map((c) => c.split(':').pop()!.trim())
    .filter((c) => c && c !== '*');
}

// Una cola de respuestas por tabla: cada elemento es la respuesta COMPLETA
// ({ data, error } o { count, error }) que la siguiente consulta a esa tabla
// se lleva. Vacía ⇒ éxito sin filas (y conteo 0), para no fallar por omisión.
const respuestas = new Map<string, Array<Record<string, unknown>>>();
/** Cada `.select()` que corrió, para las pruebas estructurales. */
const selects: Array<{ tabla: string; columnas: string }> = [];
/** AGB-10: cada `.not(...)` que corrió — para afirmar el filtro de tenants QA. */
const llamadasNot: Array<{ tabla: string; args: unknown[] }> = [];
function responderDe(tabla: string) {
  const cola = respuestas.get(tabla);
  return cola && cola.length > 0 ? cola.shift()! : { data: [], count: 0, error: null };
}
function builder(tabla: string) {
  const b: Record<string, unknown> = {};
  let error42703: { message: string; code: string } | null = null;
  Object.assign(b, {
    select: (expr?: string) => {
      if (typeof expr === 'string') {
        selects.push({ tabla, columnas: expr });
        const esquema = ESQUEMA_REAL[tabla];
        if (esquema) {
          const fantasma = columnasPedidas(expr).find((c) => !esquema.has(c));
          // El mensaje EXACTO de Postgres: es el que salió en producción.
          if (fantasma) error42703 = { message: `column ${tabla}.${fantasma} does not exist`, code: '42703' };
        }
      }
      return b;
    },
    eq: () => b, is: () => b, gte: () => b, lt: () => b,
    not: (...args: unknown[]) => { llamadasNot.push({ tabla, args }); return b; },
    in: () => b, limit: () => b, maybeSingle: () => b, order: () => b,
    // `update` — solo lo usa `marcarInsumosProcesados` (insumos.ts) al
    // marcar un insumo consumido. No dispara el guardia de columnas
    // fantasma (eso es cosa de `select`); la respuesta sale de la MISMA
    // cola por tabla, en el orden en que la corrida las llama.
    update: () => b,
    then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(() => (error42703 ? { data: null, count: null, error: error42703 } : responderDe(tabla)))
        .then(res, rej),
  });
  return b;
}
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: (t: string) => builder(t) }) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const registrarCorrida = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('./corridas', () => ({ registrarCorrida: (...a: unknown[]) => registrarCorrida(...a) }));
const encolarPieza = vi.fn(async (..._a: unknown[]) => 'pieza-1');
vi.mock('./cola', () => ({ encolarPieza: (...a: unknown[]) => encolarPieza(...a) }));
const alertarOperador = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('@/lib/observability/alerta', () => ({ alertarOperador: (...a: unknown[]) => alertarOperador(...a) }));

// El modelo esperado por rol, fijo en la prueba — lo que models.ts resuelva
// en el entorno de CI no puede decidir si U1 pasa o truena.
vi.mock('@/lib/llm/models', () => ({ modelFor: (rol: string) => `modelo-${rol}` }));

const RESUMEN_VACIO = {
  costoIaUsd: 0, viajesProcesados: 0, porDia: [] as Array<{ dia: string; costoUsd: number; tokens: number }>,
  tendenciaCosto: null as number | null,
};
const getResumenNegocio = vi.fn(async (..._a: unknown[]): Promise<unknown> => RESUMEN_VACIO);
const getCostoPorFaseModelo = vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []);
const getConteosPlataforma = vi.fn(async (): Promise<unknown> => ({
  operadores: 0, liquidaciones: 0, conversacionesWa: 0, usuarios: 0, usuariosPorRol: [],
}));
const costoIaMesActual = vi.fn(async () => ({ mesUsd: 0, llamadas: 0, etiquetaMes: 'agosto' }));
const costoIaVentana = vi.fn(async (..._a: unknown[]) => ({
  totales: { n: 0, costoUsd: 0, tokensIn: 0, tokensOut: 0 },
  porFase: [], porTenant: [],
}));
vi.mock('@/lib/admin/negocio', () => ({
  getResumenNegocio: (...a: unknown[]) => getResumenNegocio(...a),
  getCostoPorFaseModelo: (...a: unknown[]) => getCostoPorFaseModelo(...a),
  getConteosPlataforma: () => getConteosPlataforma(),
  costoIaMesActual: () => costoIaMesActual(),
  costoIaVentana: (...a: unknown[]) => costoIaVentana(...a),
}));
const getPorCobrar = vi.fn(async (): Promise<Array<{ monto: number }>> => []);
vi.mock('@/lib/saas/transferencia', () => ({ getPorCobrar: () => getPorCobrar() }));
const getPlanes = vi.fn(async (): Promise<unknown[]> => []);
vi.mock('@/lib/saas/suscripcion', () => ({ getPlanes: () => getPlanes() }));

const {
  lunesDeSemana, mesAnterior, tocaCerrar,
  evaluarUmbralesCostos, armarParteTesoreria, armarParteMetricas, armarCierreMensual,
  correrAgenteFinanciero, semaforoDeRunway, contarPipeline,
} = await import('./finanzas');

beforeEach(() => {
  respuestas.clear();
  selects.length = 0;
  llamadasNot.length = 0;
  vi.clearAllMocks();
  getResumenNegocio.mockResolvedValue(RESUMEN_VACIO);
  getCostoPorFaseModelo.mockResolvedValue([]);
});

const CFG_VACIA = {
  saldoMxn: null, saldoFecha: null, costoVidaMxn: null, fijosMxn: null,
  presupuestoIaMesUsd: null, tipoCambioMxnUsd: null,
};

describe('los periodos (día de México, aritmética pura)', () => {
  it('el lunes ancla la semana: jueves, lunes y domingo caen al mismo lunes… de SU semana', () => {
    expect(lunesDeSemana('2026-08-27')).toBe('2026-08-24'); // jueves
    expect(lunesDeSemana('2026-08-24')).toBe('2026-08-24'); // el propio lunes
    expect(lunesDeSemana('2026-08-30')).toBe('2026-08-24'); // domingo cierra la semana, no la abre
  });
  it('el mes anterior cruza el año', () => {
    expect(mesAnterior('2026-01-15')).toBe('2025-12');
    expect(mesAnterior('2026-08-27')).toBe('2026-07');
  });
  it('el cierre no corre antes del día 3 (aproximación calendario, declarada)', () => {
    expect(tocaCerrar('2026-09-02')).toBe(false);
    expect(tocaCerrar('2026-09-03')).toBe(true);
  });
});

describe('evaluarUmbralesCostos — los umbrales del blueprint, puros', () => {
  const esperado = (rol: string) => `modelo-${rol}`;

  it('U1: una fase corriendo con un modelo distinto del esperado es ROJO con nombre y costo', () => {
    const h = evaluarUmbralesCostos(RESUMEN_VACIO, [
      { fase: 'ocr', modelo: 'modelo-caro-equivocado', n: 40, costoUsd: 1.76 },
      { fase: 'cuadre', modelo: 'modelo-cuadre', n: 10, costoUsd: 0.2 },
    ], CFG_VACIA, esperado, '2026-08-27');
    const u1 = h.filter((x) => x.umbral === 'U1');
    expect(u1).toHaveLength(1);
    expect(u1[0].semaforo).toBe('ROJO');
    expect(u1[0].detalle).toContain('ocr');
    expect(u1[0].detalle).toContain('modelo-caro-equivocado');
  });

  it('U1: fases con su modelo esperado no gritan', () => {
    const h = evaluarUmbralesCostos(RESUMEN_VACIO, [
      { fase: 'ocr', modelo: 'modelo-ocr', n: 40, costoUsd: 0.06 },
    ], CFG_VACIA, esperado, '2026-08-27');
    expect(h.filter((x) => x.umbral === 'U1')).toHaveLength(0);
  });

  it('U2 exige el salto Y el piso de dinero — 30% sobre centavos es ruido, no fuga', () => {
    const porDiaGrande = [{ dia: 'd', costoUsd: 6, tokens: 0 }];
    const conPiso = evaluarUmbralesCostos(
      { ...RESUMEN_VACIO, tendenciaCosto: 35, porDia: porDiaGrande }, [], CFG_VACIA, esperado, '2026-08-27');
    expect(conPiso.some((x) => x.umbral === 'U2')).toBe(true);
    const sinPiso = evaluarUmbralesCostos(
      { ...RESUMEN_VACIO, tendenciaCosto: 35, porDia: [{ dia: 'd', costoUsd: 0.4, tokens: 0 }] },
      [], CFG_VACIA, esperado, '2026-08-27');
    expect(sinPiso.some((x) => x.umbral === 'U2')).toBe(false);
  });

  it('U3: sin viajes NO se divide (null no es 0); con viajes y banda rebasada, ámbar', () => {
    const sinViajes = evaluarUmbralesCostos(
      { ...RESUMEN_VACIO, costoIaUsd: 5, viajesProcesados: 0 }, [], CFG_VACIA, esperado, '2026-08-27');
    expect(sinViajes.some((x) => x.umbral === 'U3')).toBe(false);
    const fueraDeBanda = evaluarUmbralesCostos(
      { ...RESUMEN_VACIO, costoIaUsd: 1, viajesProcesados: 10 }, [], CFG_VACIA, esperado, '2026-08-27');
    expect(fueraDeBanda.some((x) => x.umbral === 'U3' && x.semaforo === 'AMBAR')).toBe(true);
  });

  it('U4: sin presupuesto declarado es NOTA (no se compara contra nada inventado); rebasado es ámbar', () => {
    const porDia = [{ dia: 'd', costoUsd: 10, tokens: 0 }];
    const sinPresupuesto = evaluarUmbralesCostos(
      { ...RESUMEN_VACIO, porDia }, [], CFG_VACIA, esperado, '2026-08-27');
    expect(sinPresupuesto.some((x) => x.umbral === 'U4' && x.semaforo === 'NOTA')).toBe(true);
    const rebasado = evaluarUmbralesCostos(
      { ...RESUMEN_VACIO, porDia }, [], { presupuestoIaMesUsd: 150 }, esperado, '2026-08-27');
    // 10/día × 30 = 300 > 150
    expect(rebasado.some((x) => x.umbral === 'U4' && x.semaforo === 'AMBAR')).toBe(true);
  });

  it('U5 es de calendario: solo la semana del vencimiento del precio intro', () => {
    const en = evaluarUmbralesCostos(RESUMEN_VACIO, [], CFG_VACIA, esperado, '2026-09-02');
    expect(en.some((x) => x.umbral === 'U5')).toBe(true);
    const fuera = evaluarUmbralesCostos(RESUMEN_VACIO, [], CFG_VACIA, esperado, '2026-08-27');
    expect(fuera.some((x) => x.umbral === 'U5')).toBe(false);
  });
});

describe('armarParteTesoreria — el runway honesto', () => {
  const base = { hoy: '2026-08-27', cobradoMesMxn: 0, porCobrar: 0, porCobrarMonto: 0, costoIaMesUsd: 2 };

  it('sin saldo declarado NO hay runway — y el parte dice qué declarar', () => {
    const { cuerpo, semaforo, runwayMeses } = armarParteTesoreria({ ...base, cfg: CFG_VACIA }, '2026-08-24');
    expect(semaforo).toBe('SIN_SALDO');
    expect(runwayMeses).toBeNull();
    expect(cuerpo).toContain('SIN SALDO DECLARADO');
    expect(cuerpo).toContain('finanzas_config');
    expect(cuerpo).not.toMatch(/RUNWAY: \d/);
  });

  it('con todo declarado calcula la quema, el runway y el semáforo — y el ROJO es < 3 meses', () => {
    const cfg = {
      saldoMxn: 150_000, saldoFecha: '2026-08-25', costoVidaMxn: 65_000,
      fijosMxn: 6_500, presupuestoIaMesUsd: null, tipoCambioMxnUsd: 18.5,
    };
    const { semaforo, runwayMeses, cuerpo } = armarParteTesoreria({ ...base, cfg }, '2026-08-24');
    // quema = 6500 + 65000 + 37 − 0 = 71,537 → 150,000/71,537 ≈ 2.1 meses
    expect(runwayMeses).toBe(2.1);
    expect(semaforo).toBe('ROJO');
    expect(cuerpo).toContain('una factura emitida no es caja');
  });

  it('el saldo viejo (> 10 días) se advierte en la primera parte del parte', () => {
    const cfg = {
      saldoMxn: 500_000, saldoFecha: '2026-08-01', costoVidaMxn: 65_000,
      fijosMxn: 6_500, presupuestoIaMesUsd: null, tipoCambioMxnUsd: 18.5,
    };
    const { cuerpo } = armarParteTesoreria({ ...base, cfg }, '2026-08-24');
    expect(cuerpo).toContain('26 días');
  });

  it('quema ≤ 0 no es «runway infinito»: es el mes en positivo, con la serie pendiente', () => {
    const cfg = {
      saldoMxn: 100_000, saldoFecha: '2026-08-25', costoVidaMxn: 0,
      fijosMxn: 0, presupuestoIaMesUsd: null, tipoCambioMxnUsd: 18.5,
    };
    const { cuerpo, runwayMeses } = armarParteTesoreria({ ...base, cfg, cobradoMesMxn: 9_500 }, '2026-08-24');
    expect(runwayMeses).toBeNull();
    expect(cuerpo).toContain('POSITIVO');
    // La frase explica que NO se declara infinito; lo que no puede existir es
    // un runway numérico afirmado sobre un solo mes bueno.
    expect(cuerpo).not.toMatch(/RUNWAY: \d/);
  });

  it('los cortes del semáforo son 9/6/3', () => {
    expect(semaforoDeRunway(9.5)).toBe('VERDE');
    expect(semaforoDeRunway(7)).toBe('AMARILLO');
    expect(semaforoDeRunway(4)).toBe('AMBAR');
    expect(semaforoDeRunway(2.9)).toBe('ROJO');
  });
});

describe('armarParteMetricas — cifra + absoluto + fuente, y el $0 verdadero', () => {
  it('consulta los 14 valores persistidos y los agrupa en los 11 canónicos', async () => {
    respuestas.set('prospecto', Array.from({ length: 14 }, () => ({ count: 1, error: null })));

    expect(await contarPipeline()).toEqual([
      { estado: 'nuevo', n: 1 }, { estado: 'contactado', n: 1 },
      { estado: 'appointment', n: 1 }, { estado: 'rescheduled', n: 1 },
      { estado: 'cancelled', n: 1 }, { estado: 'no-show', n: 1 },
      { estado: 'demo', n: 1 }, { estado: 'proposal', n: 2 },
      { estado: 'pilot', n: 1 }, { estado: 'won', n: 2 },
      { estado: 'lost', n: 2 },
    ]);
  });

  it('con base cero: MRR $0 real (no placeholder) y churn SIN DATO (no 0%)', () => {
    const parte = armarParteMetricas({
      activas: 0, mrrMxn: 0, activasSinPrecio: 0,
      pipeline: [{ estado: 'nuevo', n: 829 }, { estado: 'won', n: 0 }],
      conteos: { operadores: 0, liquidaciones: 0, conversacionesWa: 0, usuarios: 3, usuariosPorRol: [] },
      costoIaUsd: 12.34, viajesProcesados: 0, porCobrar: 0, porCobrarMonto: 0,
    }, '2026-08-24');
    expect(parte).toContain('MRR: $0 — 0 suscripciones activas');
    expect(parte).toContain('Churn: SIN DATO');
    expect(parte).toContain('DESCONOCIDA — cero cerrados');
    expect(parte).not.toContain('Churn: 0%');
  });

  it('won y cerrado histórico se suman como cierres', () => {
    const parte = armarParteMetricas({
      activas: 1, mrrMxn: 9_500, activasSinPrecio: 0,
      pipeline: [{ estado: 'won', n: 2 }, { estado: 'cerrado', n: 1 }],
      conteos: { operadores: 0, liquidaciones: 0, conversacionesWa: 0, usuarios: 0, usuariosPorRol: [] },
      costoIaUsd: 0, viajesProcesados: 0, porCobrar: 0, porCobrarMonto: 0,
    }, '2026-08-24');
    expect(parte).toContain('3 cerrados');
  });

  it('activas sin precio configurado ⇒ el MRR se declara incompleto, no se inventa', () => {
    const parte = armarParteMetricas({
      activas: 2, mrrMxn: null, activasSinPrecio: 1,
      pipeline: [], conteos: { operadores: 0, liquidaciones: 0, conversacionesWa: 0, usuarios: 0, usuariosPorRol: [] },
      costoIaUsd: 0, viajesProcesados: 0, porCobrar: 0, porCobrarMonto: 0,
    }, '2026-08-24');
    expect(parte).toContain('SIN CIFRA COMPLETA');
    expect(parte).toContain('sin precio configurado');
  });
});

describe('armarCierreMensual — el cierre que también cierra un mes de $0', () => {
  it('lista lo que no se pudo cerrar (pagadas sin fecha, config sin declarar) y marca al piloto', () => {
    const cierre = armarCierreMensual({
      mes: '2026-07', cobradoMxn: 0, cobradasN: 0, pagadasSinFecha: 2,
      pendientes: 1, pendientesMonto: 9_500, costoIaMesUsd: 3.5, llamadasIa: 120,
      porFase: [{ fase: 'ocr', n: 100, costoUsd: 3 }],
      porTenant: [{ nombre: 'Flota Demo', costoUsd: 3.5, cobradoMxn: 0 }],
      fijosMxn: null, tipoCambio: null,
    });
    expect(cierre).toContain('NO SE PUDO CERRAR:');
    expect(cierre).toContain('conciliación incompleta');
    expect(cierre).toContain('fijos_mxn');
    expect(cierre).toContain('[piloto/demo — cobrado $0]');
    expect(cierre).toContain('NO SE PRORRATEA');
    expect(cierre).toContain('pendiente de firma');
  });

  it('con todo declarado arma el neto con su desglose', () => {
    const cierre = armarCierreMensual({
      mes: '2026-07', cobradoMxn: 9_500, cobradasN: 1, pagadasSinFecha: 0,
      pendientes: 0, pendientesMonto: 0, costoIaMesUsd: 10, llamadasIa: 50,
      porFase: [], porTenant: [], fijosMxn: 6_500, tipoCambio: 18.5,
    });
    expect(cierre).toContain('nada — lista vacía');
    // 9500 − 185 − 6500 = 2815
    expect(cierre).toContain('$2,815.00');
  });
});

describe('las corridas — fail closed, idempotencia y el ROJO que no espera', () => {
  it('una lectura caída ⇒ corrida en FALLO y ningún parte (jamás $0 sobre base ciega)', async () => {
    getResumenNegocio.mockRejectedValueOnce(new Error('resumen_costo_ia: base caída'));
    await expect(correrAgenteFinanciero('control_costos', 'cron', '2026-08-27')).rejects.toThrow('base caída');
    expect(encolarPieza).not.toHaveBeenCalled();
    expect(registrarCorrida).toHaveBeenCalledWith(null, 'control_costos',
      expect.objectContaining({ estado: 'fallo' }));
  });

  it('el parte del periodo ya en bandeja ⇒ no fabrica otro y la corrida lo dice', async () => {
    respuestas.set('cola_aprobacion', [{ count: 1, error: null }]);
    const r = await correrAgenteFinanciero('control_costos', 'cron', '2026-08-27');
    expect(r.piezas).toBe(0);
    expect(r.motivo).toContain('ya está en la bandeja');
    expect(encolarPieza).not.toHaveBeenCalled();
    expect(registrarCorrida).toHaveBeenCalledWith(null, 'control_costos',
      expect.objectContaining({ estado: 'ok', resumen: expect.objectContaining({ parte: 'ya_existia' }) }));
  });

  it('si la bandeja no se puede LEER, no se fabrica (fail closed del pre-check)', async () => {
    respuestas.set('cola_aprobacion', [{ count: null, error: { message: 'timeout' } }]);
    await expect(correrAgenteFinanciero('control_costos', 'cron', '2026-08-27')).rejects.toThrow('timeout');
    expect(encolarPieza).not.toHaveBeenCalled();
  });

  it('U1 dispara la alerta al operador ADEMÁS del parte — y la corrida cuenta el rojo', async () => {
    respuestas.set('cola_aprobacion', [{ count: 0, error: null }]);
    respuestas.set('finanzas_config', [{ data: null, error: null }]);
    getCostoPorFaseModelo.mockResolvedValueOnce([
      { fase: 'ocr', modelo: 'otro-modelo', n: 10, costoUsd: 0.5 },
    ]);
    const r = await correrAgenteFinanciero('control_costos', 'cron', '2026-08-27');
    expect(r.piezas).toBe(1);
    expect(alertarOperador).toHaveBeenCalledWith('finanzas.control_costos',
      expect.objectContaining({ codigo: 'finanzas_u1_modelo_inesperado' }));
    expect(encolarPieza).toHaveBeenCalledWith(expect.objectContaining({
      tipo: 'parte_costos', agente: 'control_costos', titulo: 'Costos — 2026-08-27',
    }));
    expect(registrarCorrida).toHaveBeenCalledWith(null, 'control_costos',
      expect.objectContaining({ estado: 'ok', resumen: expect.objectContaining({ rojos: 1 }) }));
  });

  it('la carrera del periodo la gana la base: el rebote del índice único se trata como «ya existía»', async () => {
    respuestas.set('cola_aprobacion', [{ count: 0, error: null }]);
    respuestas.set('finanzas_config', [{ data: null, error: null }]);
    encolarPieza.mockRejectedValueOnce(new Error(
      'encolarPieza: duplicate key value violates unique constraint "cola_parte_por_periodo"'));
    const r = await correrAgenteFinanciero('control_costos', 'cron', '2026-08-27');
    expect(r.piezas).toBe(0);
    expect(r.motivo).toContain('otra corrida ganó el periodo');
    expect(registrarCorrida).toHaveBeenCalledWith(null, 'control_costos',
      expect.objectContaining({ estado: 'ok' }));
  });

  it('DEMOSTRACIÓN: un insumo subido a la bandeja (Fase D, 0267) SÍ llega al agente en su siguiente corrida y queda marcado', async () => {
    respuestas.set('cola_aprobacion', [{ count: 0, error: null }]);
    respuestas.set('finanzas_config', [{ data: null, error: null }]);
    // Lo que Javier "subió" en /admin/agentes/control_costos/insumos: una
    // idea en texto libre, pendiente (procesado_en: null). Dos respuestas
    // en cola para `agente_insumo` — la del SELECT de `insumosPendientes`
    // y la del UPDATE de `marcarInsumosProcesados`, en el orden real en que
    // `correrControlCostos` las dispara.
    respuestas.set('agente_insumo', [
      {
        data: [{
          id: 'insumo-1', agente: 'control_costos', tenant_id: null, tipo: 'texto',
          titulo: 'Ojo con la renovación del plan de Vercel', storage_path: null,
          contenido_texto: 'Sube de $20 a $150/mes en octubre, revisar si compensa el uso real.',
          subido_por: 'u1', subido_en: '2026-08-26T10:00:00Z', procesado_en: null, resumen_uso: null,
        }],
        error: null,
      },
      { data: [{ id: 'insumo-1' }], error: null },
    ]);

    const r = await correrAgenteFinanciero('control_costos', 'cron', '2026-08-27');

    expect(r.piezas).toBe(1);
    // El insumo SÍ llegó al cuerpo del parte que se encoló — no se quedó
    // en la tabla sin que el agente lo leyera.
    expect(encolarPieza).toHaveBeenCalledWith(expect.objectContaining({
      tipo: 'parte_costos', agente: 'control_costos',
      cuerpo: expect.stringContaining('Ojo con la renovación del plan de Vercel'),
    }));
    const cuerpo = (encolarPieza.mock.calls[0][0] as { cuerpo: string }).cuerpo;
    expect(cuerpo).toContain('INSUMOS QUE JAVIER DEJÓ EN LA BANDEJA');
    expect(cuerpo).toContain('Sube de $20 a $150/mes en octubre');
    // Y quedó marcado procesado — "qué usó, qué aprendió de eso".
    expect(registrarCorrida).toHaveBeenCalledWith(null, 'control_costos',
      expect.objectContaining({ estado: 'ok', resumen: expect.objectContaining({ insumosMarcados: 1 }) }));
  });

  it('un insumo NO se marca procesado si el periodo ya lo ganó otra corrida (queda pendiente para la próxima vez de verdad)', async () => {
    respuestas.set('cola_aprobacion', [{ count: 0, error: null }]);
    respuestas.set('finanzas_config', [{ data: null, error: null }]);
    respuestas.set('agente_insumo', [
      { data: [{ id: 'insumo-2', agente: 'control_costos', tenant_id: null, tipo: 'texto', titulo: 't', storage_path: null, contenido_texto: 'c', subido_por: 'u', subido_en: '2026-08-26T00:00:00Z', procesado_en: null, resumen_uso: null }], error: null },
    ]);
    encolarPieza.mockRejectedValueOnce(new Error(
      'encolarPieza: duplicate key value violates unique constraint "cola_parte_por_periodo"'));
    const r = await correrAgenteFinanciero('control_costos', 'cron', '2026-08-27');
    expect(r.piezas).toBe(0);
    // Solo UNA respuesta se puso en cola para `agente_insumo` (el SELECT):
    // si el código llamara al UPDATE de todos modos, la cola vacía le daría
    // el default `{ data: [], count: 0, error: null }` — 0 marcados es
    // exactamente lo que se afirma abajo, así que la prueba real es que
    // NADA se marcó procesado cuando el periodo ya lo ganó otra corrida.
    expect(registrarCorrida).toHaveBeenCalledWith(null, 'control_costos',
      expect.objectContaining({ resumen: expect.objectContaining({ insumosMarcados: 0 }) }));
  });

  it('el cierre no corre antes del día 3 — sin corrida y sin pieza, con el motivo dicho', async () => {
    const r = await correrAgenteFinanciero('cierre_mensual', 'cron', '2026-09-02');
    expect(r.piezas).toBe(0);
    expect(r.motivo).toContain('día 3');
    expect(registrarCorrida).not.toHaveBeenCalled();
    expect(encolarPieza).not.toHaveBeenCalled();
  });

  it('tesorería con runway ROJO alerta al operador sin esperar al lunes', async () => {
    respuestas.set('cola_aprobacion', [{ count: 0, error: null }]);
    respuestas.set('finanzas_config', [{
      data: {
        saldo_mxn: 100_000, saldo_fecha: '2026-08-25', costo_vida_mxn: 65_000,
        fijos_mxn: 6_500, presupuesto_ia_mes_usd: null, tipo_cambio_mxn_usd: 18.5,
      },
      error: null,
    }]);
    respuestas.set('factura_saas', [
      { data: [], error: null },          // cobradas del mes
      { count: 0, error: null },          // pagadas sin fecha
    ]);
    const r = await correrAgenteFinanciero('tesoreria', 'cron', '2026-08-27');
    expect(r.piezas).toBe(1);
    expect(alertarOperador).toHaveBeenCalledWith('finanzas.tesoreria',
      expect.objectContaining({ codigo: 'finanzas_runway_rojo' }));
  });

  it('el analista arma su parte con la base en cero — cifras reales, no placeholders', async () => {
    respuestas.set('cola_aprobacion', [{ count: 0, error: null }]);
    respuestas.set('suscripcion', [{ data: [], error: null }]);
    respuestas.set('prospecto', [
      { count: 3, error: null }, { count: 0, error: null }, { count: 0, error: null },
      { count: 0, error: null }, { count: 0, error: null }, { count: 0, error: null },
    ]);
    const r = await correrAgenteFinanciero('analista_metricas', 'cron', '2026-08-27');
    expect(r.piezas).toBe(1);
    const pieza = encolarPieza.mock.calls[0][0] as { titulo: string; cuerpo: string };
    expect(pieza.titulo).toBe('Métricas — semana del 2026-08-24');
    expect(pieza.cuerpo).toContain('MRR: $0');
    expect(pieza.cuerpo).toContain('nuevo 3');
  });

  it('el cierre del día 3 arma el mes anterior y lo encola una vez', async () => {
    respuestas.set('cola_aprobacion', [{ count: 0, error: null }]);
    respuestas.set('finanzas_config', [{ data: null, error: null }]);
    respuestas.set('factura_saas', [
      { data: [{ tenant_id: 't-1', monto: 9500, pagada_en: '2026-08-15' }], error: null },
      { count: 0, error: null },
    ]);
    respuestas.set('tenant', [{ data: [{ id: 't-1', nombre: 'Flota Uno' }], error: null }]);
    const r = await correrAgenteFinanciero('cierre_mensual', 'cron', '2026-09-03');
    expect(r.piezas).toBe(1);
    const pieza = encolarPieza.mock.calls[0][0] as { titulo: string; cuerpo: string };
    expect(pieza.titulo).toBe('Cierre — 2026-08');
    expect(pieza.cuerpo).toContain('Flota Uno');
    expect(pieza.cuerpo).toContain('$9,500.00');
  });
});

describe('c5-8 — U1 mira una VENTANA de 7 días, no el histórico', () => {
  it('el parte de costos pide el desglose fase×modelo acotado (una migración legítima de modelo no grita ROJO para siempre)', async () => {
    respuestas.set('cola_aprobacion', [
      { count: 0, error: null },                // ¿parte del día ya existe?
      { data: { id: 'pieza-1' }, error: null }, // el encolado
    ]);
    await correrAgenteFinanciero('control_costos', 'cron');
    expect(getCostoPorFaseModelo).toHaveBeenCalledTimes(1);
    const [desde] = getCostoPorFaseModelo.mock.calls[0] as [string];
    expect(typeof desde).toBe('string');
    // ~7 días atrás (con margen por el mediodía UTC del cálculo).
    const dias = (Date.now() - Date.parse(desde)) / 86_400_000;
    expect(dias).toBeGreaterThan(6);
    expect(dias).toBeLessThan(8.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PRIMERA PASADA REAL DEL RUNNER (18:03, producción) — el analista de métricas
// murió con «leerSuscripcionesActivas: column suscripcion.plan does not exist».
// La columna de la 0052 es `plan_clave`; `plan` a secas vive en `tenant`.
// ═══════════════════════════════════════════════════════════════════════════
describe('el analista de métricas consulta las columnas REALES de suscripcion', () => {
  const CON_ACTIVAS = () => {
    respuestas.set('cola_aprobacion', [{ count: 0, error: null }]);
    respuestas.set('suscripcion', [{
      data: [{ plan_clave: 'flota' }, { plan_clave: 'flota' }, { plan_clave: 'empresa' }],
      error: null,
    }]);
    respuestas.set('prospecto', Array.from({ length: 6 }, () => ({ count: 0, error: null })));
    getPlanes.mockResolvedValue([
      { clave: 'flota', precioMensual: 9_500 },
      { clave: 'empresa', precioMensual: null },
    ]);
  };

  it('el esquema de la migración es el que manda: `plan_clave` sí, `plan` no', () => {
    const cols = ESQUEMA_REAL.suscripcion;
    expect(cols.has('plan_clave')).toBe(true);
    expect(cols.has('plan')).toBe(false);
    expect(cols.has('estado')).toBe(true);
  });

  it('la corrida arma el parte y el select pedido existe en la tabla', async () => {
    CON_ACTIVAS();
    const r = await correrAgenteFinanciero('analista_metricas', 'cron', '2026-08-27');
    expect(r.piezas).toBe(1);
    const s = selects.find((x) => x.tabla === 'suscripcion');
    // AGB-10: ahora también trae el tenant embebido — para poder excluir los
    // "ZZZ QA …" del MRR (`!inner` porque el filtro va sobre esa tabla).
    expect(s?.columnas).toBe('plan_clave, tenant:tenant_id!inner(nombre)');
  });

  it('el MRR se calcula cruzando plan_clave con el precio del plan (2 × $9,500; 1 sin precio ⇒ SIN CIFRA)', async () => {
    CON_ACTIVAS();
    await correrAgenteFinanciero('analista_metricas', 'cron', '2026-08-27');
    const pieza = encolarPieza.mock.calls[0][0] as { cuerpo: string };
    expect(pieza.cuerpo).toContain('MRR: SIN CIFRA COMPLETA');
    expect(pieza.cuerpo).toContain('3 activas pero 1 sin precio configurado');
  });

  it('AGB-10: la consulta de suscripciones activas excluye los tenants "ZZZ QA …"', async () => {
    CON_ACTIVAS();
    await correrAgenteFinanciero('analista_metricas', 'cron', '2026-08-27');
    const filtro = llamadasNot.find((l) => l.tabla === 'suscripcion');
    expect(filtro?.args).toEqual(['tenant.nombre', 'ilike', 'ZZZ QA %']);
  });

  it('LA REGRESIÓN: pedir una columna fantasma devuelve el 42703 real y la corrida queda en FALLO, sin parte', async () => {
    // El mock ya no fabrica la fuente: se comporta como Postgres. Esta es la
    // consulta que corría en producción antes del arreglo.
    respuestas.set('suscripcion', [{ data: [{ plan_clave: 'flota' }], error: null }]);
    const consulta = builder('suscripcion') as unknown as {
      select: (e: string) => PromiseLike<{ error: { message: string; code: string } | null }>;
    };
    const { error } = await consulta.select('plan');
    expect(error?.code).toBe('42703');
    expect(error?.message).toBe('column suscripcion.plan does not exist');
  });
});
