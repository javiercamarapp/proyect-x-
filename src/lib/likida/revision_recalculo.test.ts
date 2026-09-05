import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 25, BE-C1a + BE-C1b + DATOS-C1 (CRÍTICO, reincidente de la 24).
//
// `recalcularParaAjuste` prueba el lado del MOTOR: que el override en
// memoria de verdad reemplaza SOLO el monto del comprobante ajustado (el
// resto de sus campos —incluido `sub_total`/`iva_traslado`, el HECHO del
// CFDI— viaja intacto al motor), y que el resultado se traduce a la forma
// EXACTA de `p_recalculo` que `revisar_liquidacion` (mig. 0306) espera.
//
// La pareja se sube a rutas inmutables y se publica con un CAS único. Los
// fallos de subida o persistencia dejan PDF pendiente y preservan los
// ejemplares previos. La conservación legacy ocurre antes del ajuste; el
// reintento reutiliza la firma y exige las mismas cifras persistidas.
// ═══════════════════════════════════════════════════════════════════════════

const getGastos = vi.fn();
const getViaje = vi.fn();
const getOperador = vi.fn();
const cuadrarDesdeDB = vi.fn();
const generarLiquidacionPDF = vi.fn();
const getDatosFiscales = vi.fn();

vi.mock('./repo', () => ({
  getGastos: (...a: unknown[]) => getGastos(...a),
  getViaje: (...a: unknown[]) => getViaje(...a),
  getOperador: (...a: unknown[]) => getOperador(...a),
}));
vi.mock('./cuadre/desde_db', () => ({ cuadrarDesdeDB: (...a: unknown[]) => cuadrarDesdeDB(...a) }));
vi.mock('./liquidacion/pdf', () => ({ generarLiquidacionPDF: (...a: unknown[]) => generarLiquidacionPDF(...a) }));
vi.mock('@/lib/saas/fiscal', () => ({ getDatosFiscales: (...a: unknown[]) => getDatosFiscales(...a) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./presupuesto', () => ({ acotada: (q: unknown) => q }));

const copy = vi.fn();
const upload = vi.fn();
const rpc = vi.fn();
const updateCalls: Array<Record<string, unknown>> = [];
let fila: Record<string, unknown> | null = null;

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    rpc: (...a: unknown[]) => rpc(...a),
    storage: {
      from: () => ({
        copy: (...a: unknown[]) => copy(...a),
        upload: (...a: unknown[]) => upload(...a),
      }),
    },
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: fila, error: null }) }) }) }),
      update: (v: Record<string, unknown>) => {
        updateCalls.push(v);
        return {
          eq: () => ({
            eq: () => Promise.resolve({ data: null, error: null }),
          }),
        };
      },
    }),
  }),
}));

const { recalcularParaAjuste, regenerarPdfTrasAjuste, conservarPdfAntesDeAjuste, reintentarPdfAjustado } = await import('./revision_recalculo');

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

beforeEach(() => {
  vi.clearAllMocks();
  updateCalls.length = 0;
  copy.mockResolvedValue({ data: { path: 'x' }, error: null });
  upload.mockResolvedValue({ data: { path: 'x' }, error: null });
  rpc.mockResolvedValue({ data: true, error: null });
});

function gasto(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: U(3), concepto: 'diesel', monto: 800, subTotal: 6896.55, ivaTraslado: 1103.45,
    cfdiUuid: 'uuid-1', xmlVerificado: true, formaPago: '01',
    ...over,
  };
}

describe('recalcularParaAjuste', () => {
  it('reemplaza SOLO el monto del comprobante ajustado — sub_total/iva_traslado (el hecho del CFDI) viajan intactos al motor', async () => {
    getGastos.mockResolvedValueOnce([gasto(), gasto({ id: U(4), monto: 500, subTotal: null, ivaTraslado: null })]);
    cuadrarDesdeDB.mockResolvedValueOnce({
      viajeId: U(9), totalComprobado: 8500, totalAnticipo: 9000, diferencia: 500, estatus: 'con_diferencias',
      diferencias: [], gastos: [], totalDeducible: 0, totalNoDeducible: 0, totalPorConfirmar: 0,
      iepsAcreditable: 0, litrosDieselAcreditables: 12, ivaAcreditable: 1103.45, peajeAcreditable: 0,
    });

    const r = await recalcularParaAjuste('t1', U(9), [{ gastoId: U(3), montoNuevo: 8000 }]);

    expect(cuadrarDesdeDB).toHaveBeenCalledTimes(1);
    const [, , override] = cuadrarDesdeDB.mock.calls[0] as [string, string, Array<Record<string, unknown>>];
    expect(override).toHaveLength(2);
    expect(override[0]).toMatchObject({ id: U(3), monto: 8000, subTotal: 6896.55, ivaTraslado: 1103.45 });
    expect(override[1]).toMatchObject({ id: U(4), monto: 500 }); // el gasto NO ajustado, intacto

    expect(r.recalculo).toEqual({
      totalComprobado: 8500, diferencia: 500, estatus: 'con_diferencias', diferencias: [],
      iepsAcreditable: 0, litrosDieselAcreditables: 12, ivaAcreditable: 1103.45, peajeAcreditable: 0,
    });
  });

  it('litrosDieselAcreditables ausente/null se manda como 0 — nunca `undefined` en el jsonb que ve la RPC', async () => {
    getGastos.mockResolvedValueOnce([gasto()]);
    cuadrarDesdeDB.mockResolvedValueOnce({
      viajeId: U(9), totalComprobado: 8000, totalAnticipo: 9000, diferencia: 1000, estatus: 'cuadrada',
      diferencias: [], gastos: [], totalDeducible: 0, totalNoDeducible: 0, totalPorConfirmar: 0,
      iepsAcreditable: 0, litrosDieselAcreditables: undefined, ivaAcreditable: 0, peajeAcreditable: 0,
    });
    const r = await recalcularParaAjuste('t1', U(9), [{ gastoId: U(3), montoNuevo: 8000 }]);
    expect(r.recalculo.litrosDieselAcreditables).toBe(0);
  });

  it('un gastoId que no es de este viaje LANZA antes de gastar el recálculo completo del motor', async () => {
    getGastos.mockResolvedValueOnce([gasto()]);
    await expect(recalcularParaAjuste('t1', U(9), [{ gastoId: U(999), montoNuevo: 100 }]))
      .rejects.toThrow(/999.*no es de este viaje/i);
    expect(cuadrarDesdeDB).not.toHaveBeenCalled();
  });
});

describe('PDF0346: pareja inmutable y publicación condicionada', () => {
  const CUADRE = {
    viajeId: U(9), totalComprobado: 8000, totalAnticipo: 9000, diferencia: 1000, estatus: 'con_diferencias' as const,
    diferencias: [], gastos: [], totalDeducible: 0, totalNoDeducible: 0, totalPorConfirmar: 0,
    iepsAcreditable: 0, litrosDieselAcreditables: 0, ivaAcreditable: 1200, peajeAcreditable: 0,
  };
  const FECHA = '2026-09-05T00:00:00Z';
  beforeEach(() => {
    getViaje.mockResolvedValue({ id: U(9), anticipo: 9000, operadorId: U(5) });
    getOperador.mockResolvedValue({ id: U(5), nombre: 'Sintético', telefono: '000' });
    getDatosFiscales.mockResolvedValue(null);
    generarLiquidacionPDF.mockResolvedValue(new Uint8Array([8]));
    fila = { id: U(1), viaje_id: U(9), pdf_url: null, pdf_versionada: true, revision: 'ajustada', revisada_en: FECHA, revisada_por_email: 'synthetic@test' };
  });
  const regenerate = () => regenerarPdfTrasAjuste('t1', U(9), U(1), CUADRE, 'synthetic@test', FECHA);
  it('sube ambas versiones sin upsert y publica un único puntero con CAS de revisión/cifras', async () => {
    expect(await regenerate()).toEqual({ regenerado: true });
    const paths = upload.mock.calls.map((call) => String(call[0]));
    expect(paths[0]).toMatch(new RegExp(`^t1/${U(9)}-version-[0-9a-f-]{36}\\.pdf$`));
    expect(paths[1]).toBe(paths[0].replace('.pdf', '-operador.pdf'));
    for (const call of upload.mock.calls) expect(call[2]).toMatchObject({ upsert: false });
    expect(rpc).toHaveBeenCalledWith('publicar_pdf_liquidacion', expect.objectContaining({ p_tenant: 't1', p_liquidacion: U(1), p_anterior: null, p_pdf: paths[0], p_revision: 'ajustada', p_revisada_en: FECHA, p_cifras: expect.objectContaining({ totalComprobado: 8000, ivaAcreditable: 1200 }) }));
    expect(updateCalls).toHaveLength(0);
    expect(copy).not.toHaveBeenCalled();
  });
  it.each(['contralor', 'operador'])('fallo %s no sobrescribe ninguna ruta vigente ni publica la mitad', async (fails) => {
    const objects = new Map([[`t1/${U(9)}.pdf`, '800'], [`t1/${U(9)}-operador.pdf`, '800']]);
    upload.mockImplementation(async (path: string) => {
      if ((path.endsWith('-operador.pdf') ? 'operador' : 'contralor') === fails) return { error: { message: 'synthetic failure' } };
      objects.set(path, '8000'); return { error: null };
    });
    expect(await regenerate()).toEqual({ regenerado: false });
    expect(objects.get(`t1/${U(9)}.pdf`)).toBe('800');
    expect(objects.get(`t1/${U(9)}-operador.pdf`)).toBe('800');
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each([{ data: null, error: { message: 'persistencia' } }, { data: false, error: null }, { data: null, error: null }])('error o CAS sin publicación jamás es éxito: %j', async (result) => {
    rpc.mockResolvedValueOnce(result);
    expect(await regenerate()).toEqual({ regenerado: false });
  });
  it('fallo de lectura/generación deja la firma persistida a cargo de la RPC, sin UPDATE compensador', async () => {
    getViaje.mockRejectedValueOnce(new Error('fallo'));
    expect(await regenerate()).toEqual({ regenerado: false });
    expect(updateCalls).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('conserva ambos legacy antes de ajustar; copia parcial o CAS perdido rechazan antes de firmar', async () => {
    fila = { ...fila, pdf_url: `t1/${U(9)}.pdf`, pdf_versionada: false, revision: 'pendiente', revisada_en: null };
    await conservarPdfAntesDeAjuste('t1', U(1));
    expect(copy).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith('publicar_pdf_liquidacion', expect.objectContaining({ p_anterior: `t1/${U(9)}.pdf`, p_revision: 'pendiente' }));
    rpc.mockClear(); copy.mockResolvedValueOnce({ error: { message: 'copy' } });
    await expect(conservarPdfAntesDeAjuste('t1', U(1))).rejects.toThrow('no se aplicó');
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(conservarPdfAntesDeAjuste('t1', U(1))).rejects.toThrow('no se aplicó');
  });
  it('reintenta el papel con la firma original; una respuesta false no inventa éxito', async () => {
    cuadrarDesdeDB.mockResolvedValue(CUADRE);
    rpc.mockResolvedValueOnce({ data: false, error: null });
    expect(await reintentarPdfAjustado('t1', U(1))).toEqual({ regenerado: false });
    expect(await reintentarPdfAjustado('t1', U(1))).toEqual({ regenerado: true });
    expect(generarLiquidacionPDF.mock.calls[0][0]).toMatchObject({ revisadaEn: FECHA, revisadaPor: 'synthetic@test' });
    expect(rpc.mock.calls.every(([name]) => name === 'publicar_pdf_liquidacion')).toBe(true);
  });
});
