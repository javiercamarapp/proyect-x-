import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA DE ESCALA 15-AGO-2026 (mig. 0112): getSerieComparativa PASÓ DE
// TRES `traerTodo` + BUCKETEO EN JS A `serie_comparativa_tenant` EN SQL.
//
// La vista "histórico" de `getSeriesKpiCards` (ventana ~10 años) leía
// prácticamente toda `gasto` del tenant — caducaba ~mes 2.2 con 15,000
// viajes/mes (docs/escala-15k.md §6) y corre en CADA carga del Resumen y del
// panel del contador (semanal/mensual/histórico, tres llamadas).
//
// Lo que este archivo prueba:
//   1. EQUIVALENCIA — el bucketeo JS VIEJO (`legacySerieJs`, copia congelada
//      de analytics.ts antes de la 0112) contra la función NUEVA (con la RPC
//      mockeada por un reductor SQL escrito de forma independiente,
//      `sqlSerieEquivalente`) — sobre el MISMO dataset sintético de las TRES
//      tablas: `gasto` (SIN filtro de monto>0 — es un total operativo, no el
//      denominador fiscal del 15%), `viaje` y `liquidacion` (bucketeada por
//      DÍA LOCAL DE MÉXICO, el caso que motivó `diaLocalMx` en primer
//      lugar: un cierre de las 20:00 hora MX cae al día siguiente en UTC).
//   2. Fail-closed: error de la RPC o forma inesperada (longitud distinta a
//      `pasos`) → LANZAN.
//   3. Aislamiento entre tenants y `costoPorViaje: null` sin viajes (no
//      dividir entre cero).
// ═══════════════════════════════════════════════════════════════════════════

type Gasto = { tenant_id: string; fecha: string; monto: number };
type Viaje = { tenant_id: string; fecha_inicio: string | null; estatus: string };
type Liq = { tenant_id: string; created_at: string; total_comprobado: number; revision?: string | null };

const TZ_MX = 'America/Mexico_City';

function round2(n: number): number {
  return Math.sign(n) * Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100;
}

function limitesDe(ventanaDias: number, pasos: number, hoy: string) {
  return Array.from({ length: pasos }, (_, i) => {
    const hastaD = new Date(`${hoy}T00:00:00Z`);
    hastaD.setUTCDate(hastaD.getUTCDate() - i * ventanaDias);
    const hasta = hastaD.toISOString().slice(0, 10);
    const desdeD = new Date(hastaD);
    desdeD.setUTCDate(desdeD.getUTCDate() - (ventanaDias - 1));
    return { desde: desdeD.toISOString().slice(0, 10), hasta };
  });
}

const diaLocalMx = (iso: string): string => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ_MX });
const enRango = (dia: string, desde: string, hasta: string) => dia >= desde && dia <= hasta;

/** LA REDUCCIÓN JS VIEJA — copia congelada de `getSerieComparativa` tal como
 *  vivía en analytics.ts ANTES de la 0112. Es el oráculo. */
function legacySerieJs(gastos: Gasto[], viajes: Viaje[], liquidaciones: Liq[], tenantId: string, ventanaDias: number, pasos: number, hoy: string) {
  const limites = limitesDe(ventanaDias, pasos, hoy);
  const gastosT = gastos.filter((g) => g.tenant_id === tenantId);
  const viajesT = viajes.filter((v) => v.tenant_id === tenantId);
  const liqT = liquidaciones.filter((l) => l.tenant_id === tenantId);
  return limites.map(({ desde, hasta }) => {
    const gastoTotal = round2(gastosT.filter((g) => enRango(g.fecha, desde, hasta)).reduce((s, g) => s + Number(g.monto ?? 0), 0));
    const viajesDelPeriodo = viajesT.filter((v) => v.fecha_inicio && enRango(v.fecha_inicio, desde, hasta));
    const n = viajesDelPeriodo.length;
    const viajesLiquidados = viajesDelPeriodo.filter((v) => v.estatus === 'liquidado').length;
    const liquidado = round2(liqT.filter((l) => enRango(diaLocalMx(l.created_at), desde, hasta)).reduce((s, l) => s + Number(l.total_comprobado ?? 0), 0));
    return {
      desde, hasta, gastoTotal, totalViajes: n,
      costoPorViaje: n === 0 ? null : round2(gastoTotal / n),
      liquidado, viajesLiquidados,
    };
  });
}

/** EL REDUCTOR SQL — escrito de forma INDEPENDIENTE (bucles explícitos, no
 *  filter/reduce encadenados) espejando `serie_comparativa_tenant` (0112):
 *  MISMO orden de redondeo (round(sum,2) primero, costoPorViaje divide sobre
 *  ESE valor). Simula lo que la RPC devolvería — es lo que el mock de
 *  `.rpc()` usa como respuesta. */
function sqlSerieEquivalente(gastos: Gasto[], viajes: Viaje[], liquidaciones: Liq[], tenantId: string, ventanaDias: number, pasos: number, hoy: string) {
  const limites = limitesDe(ventanaDias, pasos, hoy);
  return limites.map(({ desde, hasta }) => {
    let gastoTotal = 0;
    for (const g of gastos) {
      if (g.tenant_id !== tenantId) continue;
      if (g.fecha >= desde && g.fecha <= hasta) gastoTotal += g.monto;
    }
    gastoTotal = round2(gastoTotal);

    let n = 0;
    let liquidados = 0;
    for (const v of viajes) {
      if (v.tenant_id !== tenantId || !v.fecha_inicio) continue;
      if (v.fecha_inicio >= desde && v.fecha_inicio <= hasta) {
        n += 1;
        if (v.estatus === 'liquidado') liquidados += 1;
      }
    }

    let liquidado = 0;
    for (const l of liquidaciones) {
      if (l.tenant_id !== tenantId) continue;
      if (l.revision === 'rechazada') continue; // 0348 (BE-A2/DAT-M1)
      const dia = diaLocalMx(l.created_at);
      if (dia >= desde && dia <= hasta) liquidado += l.total_comprobado;
    }
    liquidado = round2(liquidado);

    return {
      desde, hasta, gastoTotal, totalViajes: n,
      costoPorViaje: n === 0 ? null : round2(gastoTotal / n),
      liquidado, viajesLiquidados: liquidados,
    };
  });
}

const servidor: { gastos: Gasto[]; viajes: Viaje[]; liquidaciones: Liq[] } = { gastos: [], viajes: [], liquidaciones: [] };
const llamadasRpc: Array<{ fn: string; args: Record<string, unknown> }> = [];
let forzarError: { message: string } | null = null;
let forzarFormaRota: unknown = undefined;

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      llamadasRpc.push({ fn, args });
      if (forzarError) return Promise.resolve({ data: null, error: forzarError });
      if (forzarFormaRota !== undefined) return Promise.resolve({ data: forzarFormaRota, error: null });
      if (fn === 'serie_comparativa_tenant') {
        const r = sqlSerieEquivalente(
          servidor.gastos, servidor.viajes, servidor.liquidaciones,
          args.p_tenant as string, args.p_ventana_dias as number, args.p_pasos as number, args.p_hoy as string,
        );
        return Promise.resolve({ data: r, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  }),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { getSerieComparativa } = await import('./analytics');

beforeEach(() => {
  servidor.gastos = [];
  servidor.viajes = [];
  servidor.liquidaciones = [];
  llamadasRpc.length = 0;
  forzarError = null;
  forzarFormaRota = undefined;
});

describe('getSerieComparativa — equivalencia JS viejo vs RPC nueva (mig. 0112)', () => {
  it('un periodo (7 días): gasto SIN filtro de monto, viajes y liquidados, costoPorViaje', async () => {
    servidor.gastos = [
      { tenant_id: 't1', fecha: '2026-08-12', monto: 1500 },
      { tenant_id: 't1', fecha: '2026-08-13', monto: 800 },
      { tenant_id: 't1', fecha: '2026-08-13', monto: -200 },   // NO se filtra aquí — a diferencia de sumar_combustible_ejercicio
    ];
    servidor.viajes = [
      { tenant_id: 't1', fecha_inicio: '2026-08-12', estatus: 'liquidado' },
      { tenant_id: 't1', fecha_inicio: '2026-08-13', estatus: 'abierto' },
    ];
    servidor.liquidaciones = [
      { tenant_id: 't1', created_at: '2026-08-13T18:00:00Z', total_comprobado: 1200 },
    ];
    const hoy = '2026-08-15';
    const legacy = legacySerieJs(servidor.gastos, servidor.viajes, servidor.liquidaciones, 't1', 7, 1, hoy);
    const nuevo = await getSerieComparativa('t1', 7, 1, hoy);
    expect(nuevo).toEqual(legacy);
    expect(nuevo).toEqual([{
      desde: '2026-08-09', hasta: '2026-08-15',
      gastoTotal: 2100, totalViajes: 2, costoPorViaje: 1050,
      liquidado: 1200, viajesLiquidados: 1,
    }]);
  });

  it('dos periodos consecutivos SIN traslape (semanal actual vs anterior)', async () => {
    servidor.gastos = [
      { tenant_id: 't1', fecha: '2026-08-14', monto: 1000 },   // periodo 0 (actual): [08-09, 08-15]
      { tenant_id: 't1', fecha: '2026-08-05', monto: 500 },    // periodo 1 (anterior): [08-02, 08-08]
    ];
    const hoy = '2026-08-15';
    const legacy = legacySerieJs(servidor.gastos, servidor.viajes, servidor.liquidaciones, 't1', 7, 2, hoy);
    const nuevo = await getSerieComparativa('t1', 7, 2, hoy);
    expect(nuevo).toEqual(legacy);
    expect(nuevo[0]).toMatchObject({ desde: '2026-08-09', hasta: '2026-08-15', gastoTotal: 1000 });
    expect(nuevo[1]).toMatchObject({ desde: '2026-08-02', hasta: '2026-08-08', gastoTotal: 500 });
  });

  it('sin viajes en el periodo: costoPorViaje es null, no Infinity ni división entre cero', async () => {
    servidor.gastos = [{ tenant_id: 't1', fecha: '2026-08-14', monto: 900 }];
    const hoy = '2026-08-15';
    const legacy = legacySerieJs(servidor.gastos, servidor.viajes, servidor.liquidaciones, 't1', 7, 1, hoy);
    const nuevo = await getSerieComparativa('t1', 7, 1, hoy);
    expect(nuevo).toEqual(legacy);
    expect(nuevo[0].costoPorViaje).toBeNull();
    expect(nuevo[0].totalViajes).toBe(0);
  });

  it('el bucket de liquidacion respeta el DÍA LOCAL DE MÉXICO, no el día UTC', async () => {
    // 2026-08-15T02:00:00Z son las 20:00 del 14-ago en México (UTC-6): si el
    // bucket usara UTC a secas, esta liquidación caería en el periodo del
    // 15, no en el del 14 — el bug que `diaLocalMx` existe para no repetir.
    servidor.liquidaciones = [
      { tenant_id: 't1', created_at: '2026-08-15T02:00:00Z', total_comprobado: 777 },
    ];
    const hoy = '2026-08-14';
    const legacy = legacySerieJs(servidor.gastos, servidor.viajes, servidor.liquidaciones, 't1', 1, 1, hoy);
    const nuevo = await getSerieComparativa('t1', 1, 1, hoy);
    expect(nuevo).toEqual(legacy);
    expect(nuevo[0]).toMatchObject({ desde: '2026-08-14', hasta: '2026-08-14', liquidado: 777 });
  });

  it('aislamiento: otro tenant no contamina ninguna de las tres sumas', async () => {
    servidor.gastos = [
      { tenant_id: 't1', fecha: '2026-08-14', monto: 100 },
      { tenant_id: 't2', fecha: '2026-08-14', monto: 99999 },
    ];
    servidor.viajes = [
      { tenant_id: 't1', fecha_inicio: '2026-08-14', estatus: 'liquidado' },
      { tenant_id: 't2', fecha_inicio: '2026-08-14', estatus: 'liquidado' },
    ];
    servidor.liquidaciones = [
      { tenant_id: 't1', created_at: '2026-08-14T12:00:00Z', total_comprobado: 50 },
      { tenant_id: 't2', created_at: '2026-08-14T12:00:00Z', total_comprobado: 88888 },
    ];
    const hoy = '2026-08-15';
    const nuevo = await getSerieComparativa('t1', 7, 1, hoy);
    expect(nuevo[0]).toMatchObject({ gastoTotal: 100, totalViajes: 1, liquidado: 50 });
  });

  it('un tenant sin actividad da ceros MEDIDOS por periodo, no huecos', async () => {
    const r = await getSerieComparativa('t1', 7, 2, '2026-08-15');
    expect(r).toHaveLength(2);
    for (const p of r) {
      expect(p.gastoTotal).toBe(0);
      expect(p.totalViajes).toBe(0);
      expect(p.costoPorViaje).toBeNull();
      expect(p.liquidado).toBe(0);
      expect(p.viajesLiquidados).toBe(0);
    }
  });
});

describe('getSerieComparativa — fail-closed (mig. 0112)', () => {
  it('un error de la RPC LANZA', async () => {
    forzarError = { message: 'TypeError: fetch failed (ENOTFOUND db.supabase.co)' };
    await expect(getSerieComparativa('t1', 7, 2, '2026-08-15')).rejects.toThrow(/fetch failed/);
  });

  it('una forma inesperada (longitud distinta a `pasos`, ¿migración 0112 sin aplicar?) LANZA', async () => {
    forzarFormaRota = [{ desde: '2026-08-09', hasta: '2026-08-15' }]; // 1 elemento, pasos=2
    await expect(getSerieComparativa('t1', 7, 2, '2026-08-15')).rejects.toThrow(/0112/);
  });

  it('data null LANZA', async () => {
    forzarFormaRota = null;
    await expect(getSerieComparativa('t1', 7, 1, '2026-08-15')).rejects.toThrow(/0112/);
  });
});

describe('getSerieComparativa — los argumentos viajan tal cual a la RPC', () => {
  it('manda p_tenant, p_ventana_dias, p_pasos, p_hoy', async () => {
    await getSerieComparativa('t1', 30, 2, '2026-08-15');
    const llamada = llamadasRpc.find((l) => l.fn === 'serie_comparativa_tenant')!;
    expect(llamada.args).toEqual({ p_tenant: 't1', p_ventana_dias: 30, p_pasos: 2, p_hoy: '2026-08-15' });
  });
});
