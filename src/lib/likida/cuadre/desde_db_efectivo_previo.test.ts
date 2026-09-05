import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 26, FIS-C2 (CRÍTICO, reincidente de la 23, la 24 y la 25 — cierre
// PARCIAL). El cubo del 15% (RFA 2026 regla 2.9) tiene DOS términos que se
// restan entre sí y tienen que juzgar la forma de pago con el MISMO criterio:
//
//   · el acumulado del ejercicio, que devuelve `sumar_combustible_ejercicio`
//     (mig. 0305) y que desde esa migración juzga la forma EFECTIVA: un '99'
//     con REP cuenta por `pagado_forma`, un '99' sin REP no se juzga;
//   · `efectivoDeEsteViaje`, que `desde_db.ts` le RESTA a ese acumulado para
//     que los gastos del viaje que se está cuadrando no se cuenten dos veces.
//
// La 0305 movió el primero y dejó el segundo juzgando la forma CRUDA, con un
// comentario que decía que `Gasto` no traía `pagadoForma` — y sí lo trae
// (`repo.ts` lo mapea). Resultado: un diésel '99' que el REP revela pagado en
// efectivo entra al acumulado y NO se resta, así que el comprobante consume
// su propio cupo antes de evaluarse y el motor lo declara no deducible.
//
// La prueba mide el término de la resta donde ocurre, en el borde exacto de
// la regla: el efectivo es EXACTAMENTE el 15% del combustible del ejercicio,
// que es el caso que la RFA 2.9 sí ampara («siempre que estos no excedan»).
// ═══════════════════════════════════════════════════════════════════════════

const getViaje = vi.fn();
const getGastos = vi.fn();
const getOperador = vi.fn();
const getAcumuladoCombustible = vi.fn();
const getPerfilCrudo = vi.fn();
const getConfig = vi.fn();
const cuadrarViaje = vi.fn();

vi.mock('../repo', () => ({
  getViaje: (...a: unknown[]) => getViaje(...a),
  getGastos: (...a: unknown[]) => getGastos(...a),
  getOperador: (...a: unknown[]) => getOperador(...a),
  getAcumuladoCombustible: (...a: unknown[]) => getAcumuladoCombustible(...a),
  getPerfilCrudo: (...a: unknown[]) => getPerfilCrudo(...a),
}));
vi.mock('../config', () => ({ getConfig: (...a: unknown[]) => getConfig(...a) }));
vi.mock('../perfil/preguntas', () => ({
  calificaEstimuloPeaje: () => ({ elegible: undefined }),
  facilidad15Declarada: () => true,
}));
vi.mock('./engine', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  cuadrarViaje: (...a: unknown[]) => cuadrarViaje(...a),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: () => ({}) }) }));
vi.mock('../presupuesto', () => ({ acotada: (q: unknown) => q }));

const { cuadrarDesdeDB } = await import('./desde_db');

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** El único argumento con el que se llamó a `cuadrarViaje`. */
function entradaDelMotor(): Record<string, unknown> {
  expect(cuadrarViaje).toHaveBeenCalledTimes(1);
  return cuadrarViaje.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  getViaje.mockResolvedValue({ id: U(9), anticipo: 200000, operadorId: U(5), fechaInicio: '2026-02-15' });
  getOperador.mockResolvedValue({ id: U(5), nombre: 'Juan', rfc: undefined });
  getConfig.mockResolvedValue({
    politica: [], agentes: { liquidacion: { umbralConfianza: 0.85 } }, empresa: {},
    hidrocarburos: undefined, estimulos: undefined, validacion: { fechaToleranciaDiasAntes: 3 },
  });
  getPerfilCrudo.mockResolvedValue({});
  cuadrarViaje.mockReturnValue({
    viajeId: U(9), totalComprobado: 0, diferencia: 0, estatus: 'cuadrada', diferencias: [], gastos: [],
  });
});

describe('FIS-C2 · el previo del 15% juzga la forma de pago EFECTIVA, igual que la RPC', () => {
  it('un diésel «99» cuyo REP dice efectivo («01») SÍ se resta del acumulado: es de ESTE viaje, no del previo', async () => {
    // El único combustible no admitido del ejercicio es este comprobante:
    // SubTotal 150,000 de 1,000,000 de combustible = exactamente el 15%.
    getAcumuladoCombustible.mockResolvedValue({ efectivo: 150000, totalCombustible: 1000000 });
    getGastos.mockResolvedValue([
      {
        id: U(1), concepto: 'diesel', monto: 150000, fecha: '2026-02-15',
        formaPago: '99', metodoPago: 'PPD', pagadoEn: '2026-02-15', pagadoForma: '01',
        cfdiUuid: 'UUID-DIESEL', estadoSat: 'vigente',
      },
    ]);

    await cuadrarDesdeDB(U(7), U(9));

    // Sin el arreglo: `medioNoAdmitidoCombustible('99') === false` → no se
    // resta nada → 150,000. El comprobante se come su propio cupo y el motor
    // lo declara `efectivo_sobre_15`: $0 deducible, $0 de IVA acreditable.
    expect(entradaDelMotor().efectivoPrevEjercicio).toBe(0);
  });

  it('un diésel «99» SIN REP no se resta: la RPC tampoco lo cuenta, así que restarlo fabricaría un previo corto', async () => {
    getAcumuladoCombustible.mockResolvedValue({ efectivo: 40000, totalCombustible: 1000000 });
    getGastos.mockResolvedValue([
      {
        id: U(2), concepto: 'diesel', monto: 90000, fecha: '2026-03-01',
        formaPago: '99', metodoPago: 'PPD', cfdiUuid: 'UUID-SIN-REP', estadoSat: 'vigente',
      },
    ]);

    await cuadrarDesdeDB(U(7), U(9));

    expect(entradaDelMotor().efectivoPrevEjercicio).toBe(40000);
  });

  it('un diésel «99» cuyo REP dice transferencia («03») no se resta: la RPC no lo contó como efectivo', async () => {
    getAcumuladoCombustible.mockResolvedValue({ efectivo: 40000, totalCombustible: 1000000 });
    getGastos.mockResolvedValue([
      {
        id: U(3), concepto: 'diesel', monto: 90000, fecha: '2026-03-01',
        formaPago: '99', metodoPago: 'PPD', pagadoEn: '2026-03-05', pagadoForma: '03',
        cfdiUuid: 'UUID-REP-TRANSF', estadoSat: 'vigente',
      },
    ]);

    await cuadrarDesdeDB(U(7), U(9));

    expect(entradaDelMotor().efectivoPrevEjercicio).toBe(40000);
  });

  // ── REAUDITORÍA DEL ARREGLO (misma ronda) ──────────────────────────────
  // El `.filter` de TS tiene que espejar el `where` de la RPC en TODOS sus
  // términos, no solo en el de la forma de pago. La 0305 filtra
  // `fecha >= make_date(anio,1,1) and fecha <= make_date(anio,12,31)`, y una
  // `fecha` NULL falla las dos comparaciones: el gasto sin fecha NO entra al
  // acumulado. El `?? anioEjercicio` de TS hacía lo contrario —lo daba por
  // del ejercicio— y lo restaba de un total que nunca lo contó, dejando el
  // previo CORTO y regalando cupo del 15% que la RFA 2.9 no concede.
  //
  // No es un caso de laboratorio: el prompt del OCR (`intake/ocr.ts`) ordena
  // devolver la fecha en null cuando el ticket no la trae legible, y el
  // comentario de la AUDITORÍA 16 aquí arriba ya declaraba esta regla — dice
  // «un gasto de otro año (o sin fecha) no está en el contador». La mitad de
  // «otro año» estaba implementada; la de «sin fecha», no.
  it('un gasto de combustible SIN fecha no se resta: la RPC tampoco lo contó', async () => {
    getAcumuladoCombustible.mockResolvedValue({ efectivo: 145000, totalCombustible: 1000000 });
    getGastos.mockResolvedValue([
      {
        id: U(5), concepto: 'diesel', monto: 80000, // sin `fecha`: el OCR no la pudo leer
        formaPago: '01', cfdiUuid: 'UUID-SIN-FECHA', estadoSat: 'vigente',
      },
    ]);

    await cuadrarDesdeDB(U(7), U(9));

    expect(entradaDelMotor().efectivoPrevEjercicio).toBe(145000);
  });

  it('el efectivo en mano («01») se sigue restando: el arreglo no cambia el caso que ya funcionaba', async () => {
    getAcumuladoCombustible.mockResolvedValue({ efectivo: 150000, totalCombustible: 1000000 });
    getGastos.mockResolvedValue([
      {
        id: U(4), concepto: 'diesel', monto: 60000, fecha: '2026-02-15',
        formaPago: '01', cfdiUuid: 'UUID-EFECTIVO', estadoSat: 'vigente',
      },
    ]);

    await cuadrarDesdeDB(U(7), U(9));

    expect(entradaDelMotor().efectivoPrevEjercicio).toBe(90000);
  });
});
