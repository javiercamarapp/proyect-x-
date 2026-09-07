import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28 · TC-A1 [ALTO] + TC-M1 [MEDIO] — el registro sintético del
// cierre RECUPERADO (`confirmarCierreEnBase`, processor.ts) tiraba el
// snapshot `liq`, y `guardiaCifras` (cuadre/guardia.ts) recalculaba el cuadre
// en `best_effort`: el PDF archivado (calculado en `cierre`) y el WhatsApp
// del MISMO cierre podían narrar dos cuadres distintos.
//
// Este archivo prueba el arreglo con `resumenCuadre` REAL (no mockeado a una
// constante, a diferencia de `processor_cierre_parcial.test.ts`): solo así se
// puede distinguir "narró la fila archivada" de "narró el recálculo" por el
// CONTENIDO del texto, no solo por la bandera `cerrado`.
// ═══════════════════════════════════════════════════════════════════════════

const runAgent = vi.fn();
const createSignedUrl = vi.fn();
const saveConversation = vi.fn();
const loadConversation = vi.fn(async () => ({
  id: 'c1',
  turns: [] as { role: 'user' | 'assistant'; content: string }[],
  cierreSinComprobantes: true,
}));
const getOpenViaje = vi.fn<(tenantId: string, operadorId: string) => Promise<string | null>>(async () => 'v1');
const sellarEntregaLiquidacion = vi.fn(async (_t: string, _l: string | null | undefined, _s: string) => true);
const claimMessage = vi.fn<(id: string) => Promise<'nuevo' | 'duplicado' | 'indeterminado'>>(async () => 'nuevo');
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

type Salida = { url: string; body: Record<string, unknown> };
const salientes: Salida[] = [];

const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
  const u = String(url);
  const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/messages')) {
    salientes.push({ url: u, body: JSON.parse(String(init?.body ?? '{}')) });
    return ok({ messages: [{ id: 'wamid.TEST' }] });
  }
  return ok({ url: `https://media.test/x`, mime_type: 'text/xml' });
});

const textos = () => salientes.filter((s) => s.body.type === 'text').map((s) => String((s.body.text as { body: string }).body));

vi.mock('@/lib/agents/run', () => ({ runAgent: (...a: unknown[]) => runAgent(...a) }));
vi.mock('@/lib/likida/conv', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveOperador: vi.fn(async () => ({ tenantId: 't1', operadorId: 'o1' })),
  getOpenViaje: (t: string, o: string) => getOpenViaje(t, o),
  liquidacionRecienteDe: vi.fn(async () => null),
  sellarEntregaLiquidacion: (...a: unknown[]) => sellarEntregaLiquidacion(...(a as [string, string, string])),
  getTenantContext: vi.fn(async () => ({ nombre: 'Flota' })),
  loadConversation: (...a: unknown[]) => loadConversation(...(a as [])),
  saveConversation: (...a: unknown[]) => saveConversation(...a),
  claimMessage: (...a: unknown[]) => claimMessage(...(a as [string])),
  acquireViajeLock: vi.fn(async () => true), intentarLockViaje: vi.fn(async () => 'obtenido' as const),
  releaseViajeLock: vi.fn(), releaseMessageClaim: vi.fn(),
  fotoAnteriorSinProcesar: vi.fn(async () => false),
  intakeDelta: vi.fn(async () => 0), esperarIntake: vi.fn(async () => true),
}));

/** La fila archivada: la NOTA de la facilidad del 15 % vigente. */
const NOTA_ARCHIVADA = 'Diésel en efectivo deducible por la facilidad del 15 %.';
/** Lo que `cuadrarDesdeDB` (recálculo) diría si LLEGARA a llamarse: otra
 *  cifra Y otra nota — si el arreglo funciona, ninguna de las dos aparece. */
const NOTA_RECALCULO = 'Diésel en efectivo: la facilidad del 15 % no se evaluó.';

const getSnapshotCierreLiquidacion = vi.fn<(t: string, id: string) => Promise<{
  totalComprobado: number; totalAnticipo: number; diferencia: number;
  diferencias: { tipo: 'complemento_no_verificable'; concepto: 'diesel'; monto: number; nota: string }[];
  litrosDieselAcreditables: number; ivaAcreditable: number; peajeAcreditable: number;
} | null>>(async () => ({
  totalComprobado: 8000, totalAnticipo: 8000, diferencia: 0,
  diferencias: [{ tipo: 'complemento_no_verificable', concepto: 'diesel', monto: 0, nota: NOTA_ARCHIVADA }],
  litrosDieselAcreditables: 0, ivaAcreditable: 0, peajeAcreditable: 0,
}));
const getLiquidacionDeViaje = vi.fn<(t: string, v: string) => Promise<{ id: string; pdfUrl: string | null } | undefined>>(async () => undefined);
const lecturaCierre = vi.fn<(t: string, v: string) => Promise<{ data: unknown; error: { message: string } | null }>>();
const vincularCostosALiquidacion = vi.fn();

vi.mock('@/lib/likida/repo', () => ({
  ubicarGastoPorHash: vi.fn(async () => null),
  getHuerfanos: vi.fn(async () => []), guardarHuerfano: vi.fn(async () => true),
  resolverHuerfanos: vi.fn(), marcarHuerfanosOfrecidos: vi.fn(),
  addGasto: vi.fn(), getGastos: vi.fn(async () => []), updateGastoCfdiXml: vi.fn(),
  saveCfdiXmlRaw: vi.fn(), gastoExistePorHash: vi.fn(async () => false),
  enriquecerGastoConCodigo: vi.fn(), guardarCodigoPendiente: vi.fn(),
  getCodigosPendientes: vi.fn(async () => []), reclamarCodigoPendiente: vi.fn(),
  getDatosResponsable: vi.fn(async () => ({
    razonSocial: 'FLOTA SA DE CV', domicilio: 'Calle 1, Mérida',
    urlAvisoIntegral: 'https://flota.mx/privacidad',
  })),
  reclamarEnvioAviso: vi.fn(async () => false), liberarEnvioAviso: vi.fn(),
  getViaje: vi.fn(async () => ({ id: 'v1', anticipo: 0 })),
  getOperador: vi.fn(async () => ({ id: 'o1', nombre: 'Operador', telefono: '5219993700779' })),
  saveLiquidacion: vi.fn(async () => 'L1'),
  getAcumuladoCombustible: vi.fn(async () => { throw new Error('sin base en pruebas'); }),
  getPerfilCrudo: vi.fn(async () => ({})),
  getLiquidacionDeViaje: (...a: unknown[]) => getLiquidacionDeViaje(...(a as [string, string])),
  getSnapshotCierreLiquidacion: (...a: unknown[]) => getSnapshotCierreLiquidacion(...(a as [string, string])),
}));

vi.mock('@/lib/likida/costos', () => ({
  registrarCosto: vi.fn(), registrarCostoWhatsApp: vi.fn(),
  faseDeModelo: vi.fn(() => 'cuadre'),
  vincularCostosALiquidacion: (...a: unknown[]) => vincularCostosALiquidacion(...a),
}));

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (_tabla: string) => {
      const b: Record<string, unknown> = {};
      const self = () => b;
      for (const m of ['select', 'eq', 'gte', 'lte', 'or', 'order', 'in', 'is', 'limit']) b[m] = self;
      const consulta = { campos: '', filtros: [] as Array<[string, unknown]> };
      b.select = (campos: string) => { consulta.campos = campos; return b; };
      b.eq = (campo: string, valor: unknown) => { consulta.filtros.push([campo, valor]); return b; };
      b.range = async () => ({ data: [], error: null, count: 0 });
      b.maybeSingle = async () => {
        if (_tabla === 'liquidacion' && consulta.campos.includes('viaje:viaje_id(estatus)')) {
          return lecturaCierre(String(consulta.filtros.find(([k]) => k === 'tenant_id')?.[1]), String(consulta.filtros.find(([k]) => k === 'viaje_id')?.[1]));
        }
        return { data: null, error: null };
      };
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
      return b;
    },
    storage: { from: () => ({ createSignedUrl: (...a: unknown[]) => createSignedUrl(...a), upload: async () => ({ error: null }) }) },
  }),
}));
vi.mock('@/lib/logger', () => ({ logger }));

// EL RECÁLCULO: mockeado para devolver una fila DELIBERADAMENTE distinta de
// la archivada (otra nota, otro total). Si el arreglo funciona, ninguna de
// las dos filtra al WhatsApp del cierre recuperado y `cuadrarDesdeDB` no se
// llama en ese camino.
const cuadrarDesdeDB = vi.fn(async () => ({
  totalComprobado: 500000, totalAnticipo: 8000, diferencia: -492000,
  diferencias: [{ tipo: 'complemento_no_verificable' as const, concepto: 'diesel' as const, monto: 0, nota: NOTA_RECALCULO }],
  litrosDieselAcreditables: 0, ivaAcreditable: 0, peajeAcreditable: 0,
}));
vi.mock('@/lib/likida/cuadre/desde_db', () => ({
  cuadrarDesdeDB: (...a: unknown[]) => cuadrarDesdeDB(...(a as [])),
  ventanaDesdeDB: vi.fn(async () => null),
}));
// `resumenCuadre` SIN mockear: es lo que distingue este archivo del hermano
// `processor_cierre_parcial.test.ts` y lo que hace visible, por CONTENIDO, si
// el texto narró la fila archivada o el recálculo.

const avisarCierreAlJefe = vi.fn(async (_a: unknown): Promise<{ enviado: boolean; pdfEnviado?: boolean | null }> => ({ enviado: true }));
vi.mock('./avisar_cierre', () => ({ avisarCierreAlJefe: (a: unknown) => avisarCierreAlJefe(a) }));

const { processInbound } = await import('./processor');
const { PartialExecutionError } = await import('@/lib/llm/openrouter');

const listo = { from: '5219993700779', type: 'text' as const, text: 'listo', timestampMs: 1788534000000, waMessageId: 'wa1' };

beforeEach(() => {
  salientes.length = 0;
  runAgent.mockReset(); createSignedUrl.mockReset();
  createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://x/liq.pdf' }, error: null });
  logger.info.mockReset(); logger.warn.mockReset(); logger.error.mockReset();
  getOpenViaje.mockReset(); getOpenViaje.mockResolvedValue('v1');
  claimMessage.mockReset(); claimMessage.mockResolvedValue('nuevo');
  saveConversation.mockReset(); saveConversation.mockResolvedValue(undefined);
  loadConversation.mockReset();
  loadConversation.mockResolvedValue({ id: 'c1', turns: [], cierreSinComprobantes: true });
  vincularCostosALiquidacion.mockReset();
  getLiquidacionDeViaje.mockReset(); getLiquidacionDeViaje.mockResolvedValue(undefined);
  getSnapshotCierreLiquidacion.mockReset();
  getSnapshotCierreLiquidacion.mockResolvedValue({
    totalComprobado: 8000, totalAnticipo: 8000, diferencia: 0,
    diferencias: [{ tipo: 'complemento_no_verificable', concepto: 'diesel', monto: 0, nota: NOTA_ARCHIVADA }],
    litrosDieselAcreditables: 0, ivaAcreditable: 0, peajeAcreditable: 0,
  });
  lecturaCierre.mockReset();
  lecturaCierre.mockImplementation(async (t, v) => {
    const liq = await getLiquidacionDeViaje(t, v);
    return { data: liq ? { id: liq.id, pdf_url: liq.pdfUrl, revision: 'pendiente', viaje: { estatus: 'liquidado' } } : null, error: null };
  });
  cuadrarDesdeDB.mockClear();
  avisarCierreAlJefe.mockClear();
  sellarEntregaLiquidacion.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
  fetchSpy.mockClear();
  process.env.WHATSAPP_ACCESS_TOKEN = 'tok-de-prueba';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
  delete process.env.LIKIDA_RECUPERAR_CIERRE_PARCIAL;
});

describe('TC-A1/TC-M1 — el cierre recuperado narra la fila ARCHIVADA, nunca el recálculo', () => {
  it('camino AGEN-1 (tool reporta error, RPC ya commiteada): narra el snapshot, no recalcula', async () => {
    runAgent.mockResolvedValue({
      finalText: 'No pude cerrar tu liquidación, ¿me reenvías *listo*?',
      toolCalls: [{ toolName: 'guardar_liquidacion', args: {}, error: 'saveLiquidacion: sin respuesta en 8000 ms (tope de consulta)', durationMs: 9500 }],
      model: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0, costoPorModelo: {},
    });
    getLiquidacionDeViaje.mockResolvedValue({ id: 'L1', pdfUrl: 't1/v1.pdf' });

    await processInbound(listo);

    const dichos = textos().join(' | ');
    expect(dichos, 'narró la fila archivada').toContain(NOTA_ARCHIVADA);
    expect(dichos, 'NUNCA el recálculo').not.toContain(NOTA_RECALCULO);
    expect(dichos).not.toContain('500,000');
    expect(cuadrarDesdeDB, 'TC-M1: el camino de recuperación ya no recalcula').not.toHaveBeenCalled();
  });

  it('camino PartialExecutionError (aborto con la tool en vuelo): narra el snapshot, no recalcula', async () => {
    runAgent.mockRejectedValue(new PartialExecutionError(
      'timeout del agente', new Error('timeout del agente'),
      [{ toolName: 'guardar_liquidacion', args: {}, result: null, error: 'Timeout', durationMs: 40_000 }],
      10, 10, 0,
    ));
    getLiquidacionDeViaje.mockResolvedValue({ id: 'L-77', pdfUrl: 't1/v1.pdf' });

    await processInbound(listo);

    const dichos = textos().join(' | ');
    expect(dichos).toContain(NOTA_ARCHIVADA);
    expect(dichos).not.toContain(NOTA_RECALCULO);
    expect(cuadrarDesdeDB).not.toHaveBeenCalled();
  });

  it('sin snapshot legible (fila no encontrada): texto neutro, nunca una cifra, y se registra el error', async () => {
    runAgent.mockResolvedValue({
      finalText: 'No pude cerrar tu liquidación, ¿me reenvías *listo*?',
      toolCalls: [{ toolName: 'guardar_liquidacion', args: {}, error: 'saveLiquidacion: sin respuesta en 8000 ms (tope de consulta)', durationMs: 9500 }],
      model: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0, costoPorModelo: {},
    });
    getLiquidacionDeViaje.mockResolvedValue({ id: 'L1', pdfUrl: 't1/v1.pdf' });
    getSnapshotCierreLiquidacion.mockResolvedValue(null);

    await processInbound(listo);

    const dichos = textos().join(' | ');
    expect(dichos).not.toMatch(/\$|\d{2,}/);
    expect(dichos).toMatch(/Ya cerré tu liquidación/);
    expect(cuadrarDesdeDB).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('agent.cierre_recuperado_sin_snapshot', expect.objectContaining({ viaje: 'v1', liquidacion: 'L1' }));
  });

  it('la lectura del snapshot truena: cierre igual confirmado (fail-closed, no "no sé si cerró"), texto neutro y error registrado', async () => {
    runAgent.mockResolvedValue({
      finalText: 'No pude cerrar tu liquidación, ¿me reenvías *listo*?',
      toolCalls: [{ toolName: 'guardar_liquidacion', args: {}, error: 'saveLiquidacion: sin respuesta en 8000 ms (tope de consulta)', durationMs: 9500 }],
      model: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0, costoPorModelo: {},
    });
    getLiquidacionDeViaje.mockResolvedValue({ id: 'L1', pdfUrl: 't1/v1.pdf' });
    getSnapshotCierreLiquidacion.mockRejectedValue(new Error('getSnapshotCierreLiquidacion: sin respuesta'));

    await processInbound(listo);

    const dichos = textos().join(' | ');
    expect(dichos, 'el cierre se confirma igual: la evidencia de arriba ya lo probó').not.toMatch(/No pude confirmar|sigue abierto/);
    expect(dichos).toMatch(/Ya cerré tu liquidación/);
    expect(logger.error).toHaveBeenCalledWith('agent.cierre_recuperado_sin_snapshot', expect.objectContaining({ viaje: 'v1', liquidacion: 'L1' }));
  });
});
