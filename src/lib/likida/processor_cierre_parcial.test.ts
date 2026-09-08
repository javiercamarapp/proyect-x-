import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 21 · CRÍTICO (C1) — un `PartialExecutionError` posterior a
// `guardar_liquidacion` dejaba al chofer con "se me trabó" sobre un viaje que
// YA cerró de verdad, y su reintento le mentía que no existe.
//
// El escenario completo, con la base diciendo una cosa y el chofer creyendo
// otra: `runAgent` ejecuta `guardar_liquidacion` con éxito (viaje `liquidado`,
// PDFs generados) pero una ronda posterior del ciclo truena y lanza
// `PartialExecutionError` CON esa tool exitosa en `partialToolCalls`. La
// recuperación existía desde AUDIT_V3… detrás de un flag opt-in APAGADO por
// default (`LIKIDA_RECUPERAR_CIERRE_PARCIAL === '1'`). De fábrica:
//
//   1. el chofer recibía "Perdón, se me trabó el sistema tantito. ¿Me reenvías
//      tu último mensaje?" — sobre una liquidación REAL ya persistida;
//   2. obedecía, `getOpenViaje` devolvía null (el viaje ya es `liquidado`) y
//      el fallback le afirmaba "No tienes un viaje abierto para liquidar" —
//      la negación de un cierre que sí existe, con PDF y cifras reales;
//   3. la bandeja durable sellaba el mensaje como 'procesado': ningún
//      mecanismo automático cerraba la brecha.
//
// El arreglo tiene dos piezas y este archivo fija las dos:
//   · la recuperación decide por EVIDENCIA, no por flag: si `partialToolCalls`
//     trae `guardar_liquidacion` exitoso, el cierre ocurrió y se le dice la
//     verdad (default ENCENDIDO; `LIKIDA_RECUPERAR_CIERRE_PARCIAL=0` es el
//     apagador de emergencia);
//   · el reintento sin viaje abierto consulta si hay una liquidación RECIENTE
//     del operador y confirma el cierre en vez de sugerir que no pasó nada.
// ═══════════════════════════════════════════════════════════════════════════

const runAgent = vi.fn();
const createSignedUrl = vi.fn();
const saveConversation = vi.fn();
const loadConversation = vi.fn(async () => ({
  id: 'c1',
  turns: [] as { role: 'user' | 'assistant'; content: string }[],
  // La mayoría de estas pruebas cubren lo que pasa DESPUÉS del intento de
  // cierre; con `false` el "listo" se queda en el freno y nunca llega al agente.
  cierreSinComprobantes: true,
}));
const getOpenViaje = vi.fn<(tenantId: string, operadorId: string) => Promise<string | null>>(async () => 'v1');
type Reciente = { viajeId: string; liquidacionId: string; pdfUrl: string | null; entregadaOperadorEn: string | null; avisadaOficinaEn: string | null };
const liquidacionReciente = vi.fn<(tenantId: string, operadorId: string) => Promise<Reciente | null>>(async () => null);
/** AGEN-4: los sellos de entrega que el processor escribe (0279). */
const sellarEntregaLiquidacion = vi.fn(async (_t: string, _l: string | null | undefined, _s: string) => true);
const claimMessage = vi.fn<(id: string) => Promise<'nuevo' | 'duplicado' | 'indeterminado'>>(async () => 'nuevo');
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// ── EL ÚNICO BORDE: la Graph API ────────────────────────────────────────────
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

/** Los mensajes de texto que salieron hacia Meta, en orden. */
const textos = () => salientes.filter((s) => s.body.type === 'text').map((s) => String((s.body.text as { body: string }).body));
const documentos = () => salientes.filter((s) => s.body.type === 'document');

vi.mock('@/lib/agents/run', () => ({ runAgent: (...a: unknown[]) => runAgent(...a) }));
vi.mock('@/lib/likida/conv', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveOperador: vi.fn(async () => ({ tenantId: 't1', operadorId: 'o1' })),
  getOpenViaje: (t: string, o: string) => getOpenViaje(t, o),
  liquidacionRecienteDe: (t: string, o: string) => liquidacionReciente(t, o),
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
  // AUDITORÍA 28, TC-A1: la fotografía archivada que `confirmarCierreEnBase`
  // (processor.ts) lee para poblar `registro.result.liq`. `resumenCuadre` está
  // mockeado a una constante en este archivo (no le importa el contenido de
  // `liq`, solo `cerrado`), así que un valor por defecto cualquiera basta para
  // no romper las pruebas existentes de este archivo — el contraste
  // snapshot-vs-recálculo se prueba con `resumenCuadre` REAL en
  // `processor_cierre_recuperado_snapshot.test.ts`.
  getSnapshotCierreLiquidacion: (...a: unknown[]) => getSnapshotCierreLiquidacion(...(a as [string, string])),
}));
type SnapshotCierre = {
  totalComprobado: number; totalAnticipo: number; diferencia: number; diferencias: never[];
  litrosDieselAcreditables: number; ivaAcreditable: number; peajeAcreditable: number;
};
const getSnapshotCierreLiquidacion = vi.fn<(t: string, id: string) => Promise<SnapshotCierre | null>>(async () => ({
  totalComprobado: 8000, totalAnticipo: 8000, diferencia: 0, diferencias: [],
  litrosDieselAcreditables: 0, ivaAcreditable: 0, peajeAcreditable: 0,
}));
/** AUDITORÍA 24, AGEN-1/AGEN-A1: la lectura de la BASE que decide si cerró. */
const getLiquidacionDeViaje = vi.fn<(t: string, v: string) => Promise<{ id: string; pdfUrl: string | null } | undefined>>(async () => undefined);
const lecturaCierre = vi.fn<(t: string, v: string) => Promise<{ data: unknown; error: { message: string } | null }>>();
const consultasCierre: Array<{ campos: string; filtros: Array<[string, unknown]> }> = [];
const vincularCostosALiquidacion = vi.fn();
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
          consultasCierre.push(consulta);
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

// ── El motor determinístico, mockeado en su borde (mismo criterio que
// `processor_llm_caido.test.ts`): lo que se prueba es que el processor lo usa
// para decirle la VERDAD al chofer, no la aritmética del cuadre. ─────────────
const cuadrarDesdeDB = vi.fn(async () => ({ totalComprobado: 1234 }));
vi.mock('@/lib/likida/cuadre/desde_db', () => ({
  cuadrarDesdeDB: (...a: unknown[]) => cuadrarDesdeDB(...(a as [])),
  ventanaDesdeDB: vi.fn(async () => null),
}));
vi.mock('@/lib/likida/cuadre/resumen', () => ({
  resumenCuadre: (_liq: unknown, cerrado: boolean) => `CUADRE REAL (cerrado=${cerrado})`,
}));

type ResultadoAvisoJefeMock = {
  enviado: boolean;
  pdfEnviado?: boolean | null;
  /** AG-A1 (auditoría 28, agentico.md:32): ver `avisar_cierre.ts`. */
  pdfEstado?: 'enviado' | 'encolado' | 'definitivo' | null;
  motivo?: string;
};
const avisarCierreAlJefe = vi.fn(async (_a: unknown): Promise<ResultadoAvisoJefeMock> => ({ enviado: true }));
vi.mock('./avisar_cierre', async (original) => ({
  // AG-A1: `pdfListoParaSellar`/`pdfEstadoDe` son puras (sin I/O) y se
  // prueban aparte en `avisar_cierre.test.ts` — se dejan REALES aquí para que
  // el cableado con `entregarCierrePendiente` sea el de verdad, y solo se
  // sustituye `avisarCierreAlJefe` (que sí hace red/DB) por el mock.
  ...(await original<Record<string, unknown>>()),
  avisarCierreAlJefe: (a: unknown) => avisarCierreAlJefe(a),
}));

// AG-A1-b: el sello «definitivo» dispara una alerta operativa UNA vez. No se
// mockeaba `@/lib/observability/alerta` en este archivo porque nada la
// afirmaba directamente — los demás casos ya la disparan (p. ej.
// `pdf.no_entregado`) contra la implementación real, que es un no-op seguro
// sin `ALERTA_EMAIL` (ver el comentario de cabecera de `alerta.ts`). Aquí sí
// hace falta espiarla.
const alertarOperador = vi.fn(async (..._args: unknown[]) => {});
vi.mock('@/lib/observability/alerta', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  alertarOperador: (...a: unknown[]) => alertarOperador(...a),
}));

const { processInbound, olvidarReentregasCierre } = await import('./processor');
const { PartialExecutionError } = await import('@/lib/llm/openrouter');

const listo = { from: '5219993700779', type: 'text' as const, text: 'listo', timestampMs: 1788534000000, waMessageId: 'wa1' };

/** El agente MURIÓ a media ronda, pero `guardar_liquidacion` YA había corrido
 *  con éxito: la liquidación existe en la base, con sus dos PDFs. */
// `liq`: en producción `guardar_liquidacion` SIEMPRE lo devuelve (AG-3,
// tools.ts) — es el snapshot que ya imprimió en los dos PDF. Sin él aquí, la
// prueba simularía un tool call que no existe en el código real.
const LIQ_TOOL: SnapshotCierre = {
  totalComprobado: 1234, totalAnticipo: 1234, diferencia: 0, diferencias: [],
  litrosDieselAcreditables: 0, ivaAcreditable: 0, peajeAcreditable: 0,
};
const cierreParcial = () => new PartialExecutionError(
  'timeout del proveedor',
  new Error('timeout del proveedor'),
  [{ toolName: 'guardar_liquidacion', args: {}, result: { liquidacion_id: 'L1', pdf_url: 't1/v1.pdf', pdf_generado: true, pdf_contralor_generado: true, liq: LIQ_TOOL }, durationMs: 5 }],
  10, 10, 0,
);

beforeEach(() => {
  salientes.length = 0;
  runAgent.mockReset(); createSignedUrl.mockReset();
  createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://x/liq.pdf' }, error: null });
  logger.info.mockReset(); logger.warn.mockReset(); logger.error.mockReset();
  getOpenViaje.mockReset(); getOpenViaje.mockResolvedValue('v1');
  liquidacionReciente.mockReset(); liquidacionReciente.mockResolvedValue(null);
  claimMessage.mockReset(); claimMessage.mockResolvedValue('nuevo');
  saveConversation.mockReset(); saveConversation.mockResolvedValue(undefined);
  loadConversation.mockReset();
  loadConversation.mockResolvedValue({ id: 'c1', turns: [], cierreSinComprobantes: true });
  vincularCostosALiquidacion.mockReset();
  getLiquidacionDeViaje.mockReset(); getLiquidacionDeViaje.mockResolvedValue(undefined);
  getSnapshotCierreLiquidacion.mockReset();
  getSnapshotCierreLiquidacion.mockResolvedValue({
    totalComprobado: 8000, totalAnticipo: 8000, diferencia: 0, diferencias: [],
    litrosDieselAcreditables: 0, ivaAcreditable: 0, peajeAcreditable: 0,
  });
  consultasCierre.length = 0;
  lecturaCierre.mockReset();
  lecturaCierre.mockImplementation(async (t, v) => {
    // Los casos históricos representan cierres commiteados. La consulta nueva
    // exige ahora esos estados explícitos además del id/puntero que simulaban.
    const liq = await getLiquidacionDeViaje(t, v);
    return { data: liq ? { id: liq.id, pdf_url: liq.pdfUrl, revision: 'pendiente', viaje: { estatus: 'liquidado' } } : null, error: null };
  });
  cuadrarDesdeDB.mockReset(); cuadrarDesdeDB.mockResolvedValue({ totalComprobado: 1234 });
  avisarCierreAlJefe.mockClear();
  alertarOperador.mockClear();
  sellarEntregaLiquidacion.mockClear();
  // AG-A1-d: el techo de reentregas es un Map de módulo (mismo patrón que
  // `olvidarRafagas`) y varios casos de este archivo reutilizan el mismo
  // `liquidacionId` ('L1'): sin este reset, un caso contamina el conteo del
  // siguiente.
  olvidarReentregasCierre();
  vi.stubGlobal('fetch', fetchSpy);
  fetchSpy.mockClear();
  process.env.WHATSAPP_ACCESS_TOKEN = 'tok-de-prueba';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
  // DE FÁBRICA: sin el flag configurado. Es exactamente el entorno donde la
  // auditoría 21 encontró el hallazgo — el default tiene que decir la verdad.
  delete process.env.LIKIDA_RECUPERAR_CIERRE_PARCIAL;
});

describe('C1 — el cierre que SÍ ocurrió se recupera DE FÁBRICA, sin flag', () => {
  it('el chofer recibe la verdad (cierre confirmado con cifras del motor), no "se me trabó"', async () => {
    runAgent.mockRejectedValue(cierreParcial());
    await processInbound(listo);

    const dichos = textos().join(' | ');
    expect(dichos, 'le pidió reenviar sobre un viaje ya liquidado').not.toContain('reenvías');
    expect(dichos).toContain('CUADRE REAL (cerrado=true)');
    expect(logger.warn).toHaveBeenCalledWith('agent.cierre_parcial_recuperado', expect.objectContaining({ viaje: 'v1', liqId: 'L1' }));
  });

  it('y recibe su PDF: la liquidación existe y el documento también', async () => {
    runAgent.mockRejectedValue(cierreParcial());
    await processInbound(listo);
    expect(documentos()).toHaveLength(1);
  });

  it('el jefe también se entera — el circuito del cierre se completa igual que en el camino feliz', async () => {
    runAgent.mockRejectedValue(cierreParcial());
    await processInbound(listo);
    expect(avisarCierreAlJefe).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', viajeId: 'v1' }));
  });

  it('los costos del ciclo se vinculan a la liquidación recuperada', async () => {
    runAgent.mockRejectedValue(cierreParcial());
    await processInbound(listo);
    expect(vincularCostosALiquidacion).toHaveBeenCalledWith('t1', 'v1', 'L1');
  });

  it('LIKIDA_RECUPERAR_CIERRE_PARCIAL=0 sigue siendo el apagador de emergencia', async () => {
    process.env.LIKIDA_RECUPERAR_CIERRE_PARCIAL = '0';
    runAgent.mockRejectedValue(cierreParcial());
    await processInbound(listo);
    expect(logger.warn).not.toHaveBeenCalledWith('agent.cierre_parcial_recuperado', expect.anything());
    expect(documentos()).toHaveLength(0);
  });

  it('control: un PartialExecutionError SIN guardar_liquidacion no inventa un cierre', async () => {
    runAgent.mockRejectedValue(new PartialExecutionError(
      'boom', new Error('boom'),
      [{ toolName: 'cuadrar_viaje', args: {}, result: {}, durationMs: 5 }],
      10, 10, 0,
    ));
    await processInbound(listo);
    expect(logger.warn).not.toHaveBeenCalledWith('agent.cierre_parcial_recuperado', expect.anything());
    expect(documentos()).toHaveLength(0);
    // No se afirma cierre en ningún texto saliente.
    expect(textos().join(' | ')).not.toContain('cerrado=true');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24 · AGEN-1 (CRÍTICO, 3ª ronda) — la base es la autoridad TAMBIÉN
// en el camino feliz. `guardar_liquidacion_tx` commitea; `acotada` se rindió a
// los 8 s; la tool reporta `error`; el ciclo sigue normal (SIN excepción) y el
// modelo escribe «No pude cerrar». El viaje está `liquidado`.
// ═══════════════════════════════════════════════════════════════════════════
describe('AGEN-1 — un guardar_liquidacion que reporta fallo sin tumbar el ciclo se coteja con la base', () => {
  const resultadoConToolFallida = () => ({
    finalText: 'No pude cerrar tu liquidación, ¿me reenvías *listo*?',
    toolCalls: [{ toolName: 'guardar_liquidacion', args: {}, error: 'saveLiquidacion: sin respuesta en 8000 ms (tope de consulta)', durationMs: 9500 }],
    model: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0, costoPorModelo: {},
  });

  it('si la base dice `liquidado`, el chofer recibe el cierre con cifras del motor, su PDF, y el jefe se entera', async () => {
    runAgent.mockResolvedValue(resultadoConToolFallida());
    getLiquidacionDeViaje.mockResolvedValue({ id: 'L1', pdfUrl: 't1/v1.pdf' });
    await processInbound(listo);

    expect(getLiquidacionDeViaje).toHaveBeenCalledWith('t1', 'v1');
    const dichos = textos().join(' | ');
    expect(dichos, 'narró «no cerré» sobre un viaje liquidado').not.toContain('No pude cerrar');
    expect(dichos).toContain('CUADRE REAL (cerrado=true)');
    expect(documentos(), 'el PDF existe y no se mandó').toHaveLength(1);
    expect(avisarCierreAlJefe).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', viajeId: 'v1' }));
    expect(logger.error).toHaveBeenCalledWith('agent.cierre_commiteado_tras_fallo_tool', expect.objectContaining({ viaje: 'v1', liquidacion: 'L1' }));
    expect(logger.error).not.toHaveBeenCalledWith('pdf.contralor_no_generado', expect.anything());
    // La conversación se desancla del viaje cerrado (igual que en el camino feliz).
    expect(saveConversation).toHaveBeenCalledWith('c1', expect.anything(), null, expect.anything());
  });

  it('si la base dice que NO hay liquidación, se le dice que el viaje sigue abierto y no se inventa un cierre', async () => {
    runAgent.mockResolvedValue(resultadoConToolFallida());
    getLiquidacionDeViaje.mockResolvedValue(undefined);
    await processInbound(listo);
    const dichos = textos().join(' | ');
    expect(dichos).toMatch(/sigue abierto/);
    expect(dichos).not.toContain('cerrado=true');
    expect(documentos()).toHaveLength(0);
    expect(avisarCierreAlJefe).not.toHaveBeenCalled();
  });

  it('si la base no contesta, NI «cerré» NI «no cerré»: se pide reintentar y se registra', async () => {
    runAgent.mockResolvedValue(resultadoConToolFallida());
    getLiquidacionDeViaje.mockRejectedValue(new Error('getLiquidacionDeViaje: sin respuesta'));
    await processInbound(listo);
    const dichos = textos().join(' | ');
    expect(dichos).toMatch(/No pude confirmar/);
    expect(dichos).not.toContain('cerrado=true');
    expect(dichos).not.toContain('No pude cerrar');
    expect(logger.error).toHaveBeenCalledWith('agent.cierre_no_verificable', expect.objectContaining({ viaje: 'v1' }));
  });

  it('control: con la tool exitosa no se consulta la base (el snapshot de la tool manda)', async () => {
    runAgent.mockResolvedValue({
      finalText: 'Listo', model: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0, costoPorModelo: {},
      toolCalls: [{ toolName: 'guardar_liquidacion', args: {}, result: { liquidacion_id: 'L1', pdf_url: 't1/v1.pdf', pdf_generado: true, pdf_contralor_generado: true }, durationMs: 5 }],
    });
    await processInbound(listo);
    expect(getLiquidacionDeViaje).not.toHaveBeenCalled();
    expect(documentos()).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24 · AGEN-A1 / BE-1 (ALTO, 2ª ronda) — la recuperación por base
// del `catch` fabricaba un registro con `pdf_url` (vocabulario de la tabla) que
// nadie leía, y conservaba el registro con `error:'Timeout'`: al chofer se le
// negaba un PDF que sí existía y se logueaban dos errores falsos.
// ═══════════════════════════════════════════════════════════════════════════
describe('AGEN-A1 — el cierre que abortó con la tool en vuelo y commiteó entrega el PDF que existe', () => {
  const abortoConToolEnVuelo = () => new PartialExecutionError(
    'timeout del agente', new Error('timeout del agente'),
    [{ toolName: 'guardar_liquidacion', args: {}, result: null, error: 'Timeout', durationMs: 40_000 }],
    10, 10, 0,
  );

  it('manda el PDF, avisa al jefe, y NO registra `pdf.contralor_no_generado`', async () => {
    runAgent.mockRejectedValue(abortoConToolEnVuelo());
    getLiquidacionDeViaje.mockResolvedValue({ id: 'L-77', pdfUrl: 't1/v1.pdf' });
    await processInbound(listo);

    const dichos = textos().join(' | ');
    expect(dichos).toContain('CUADRE REAL (cerrado=true)');
    expect(dichos, 'negó el PDF').not.toMatch(/no pude generarte el PDF/);
    expect(documentos()).toHaveLength(1);
    expect(avisarCierreAlJefe).toHaveBeenCalledWith(expect.objectContaining({ viajeId: 'v1', urlPdf: 'https://x/liq.pdf' }));
    expect(logger.error).not.toHaveBeenCalledWith('pdf.contralor_no_generado', expect.anything());
    expect(logger.error).not.toHaveBeenCalledWith('pdf.no_entregado', expect.anything());
    expect(vincularCostosALiquidacion).toHaveBeenCalledWith('t1', 'v1', 'L-77');
  });

  it('si la liquidación existe pero sin `pdf_url`, se dice que el PDF falta (no se firma un objeto inexistente)', async () => {
    runAgent.mockRejectedValue(abortoConToolEnVuelo());
    getLiquidacionDeViaje.mockResolvedValue({ id: 'L-78', pdfUrl: null });
    await processInbound(listo);
    expect(documentos()).toHaveLength(0);
    expect(textos().join(' | ')).toMatch(/no pude generarte el PDF/);
  });
});

describe('recierre rechazado: la fila histórica no confirma un cierre nuevo', () => {
  const toolFallida = { toolName: 'guardar_liquidacion', args: {}, result: null, error: 'saveLiquidacion: 23514: viaje liquidado con liquidación rechazada', durationMs: 20 };
  const ciclo = () => ({ finalText: 'Ya quedó cerrada', toolCalls: [toolFallida], model: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0, costoPorModelo: {} });
  const version = 't1/v1-version-00000000-0000-4000-8000-000000000046.pdf';
  const fila = (revision: string, viaje: unknown) => ({ id: 'L-rechazada', pdf_url: version, revision, viaje });

  it.each(['normal', 'aborto'])('%s: rechazo23514 no anuncia cierre, no entrega PDF viejo y mantiene conversación anclada', async (camino) => {
    lecturaCierre.mockResolvedValue({ data: fila('rechazada', { estatus: 'en_cuadre' }), error: null });
    if (camino === 'normal') runAgent.mockResolvedValue(ciclo());
    else runAgent.mockRejectedValue(new PartialExecutionError('timeout', new Error('timeout'), [toolFallida], 0, 0, 0));
    await processInbound(listo);
    const dicho = textos().join(' | ');
    expect(dicho).toContain('Tu liquidación sigue rechazada');
    expect(dicho).toContain('corrige o completa los comprobantes');
    expect(dicho).not.toMatch(/cerrado=true|ya quedó cerrada|Ya cerré/);
    expect(documentos()).toHaveLength(0);
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(avisarCierreAlJefe).not.toHaveBeenCalled();
    expect(saveConversation).toHaveBeenCalledWith('c1', expect.anything(), 'v1', expect.anything());
    expect(consultasCierre).toEqual([{ campos: 'id,pdf_url,revision,viaje:viaje_id(estatus)', filtros: [['tenant_id', 't1'], ['viaje_id', 'v1']] }]);
  });

  it.each([
    ['rechazada', { estatus: 'liquidado' }],
    ['pendiente', { estatus: 'en_cuadre' }],
    ['aprobada', null],
    ['ajustada', [{ estatus: 'liquidado' }]],
    ['desconocida', { estatus: 'liquidado' }],
  ])('estado incoherente o incompleto %s/%j se declara no verificable', async (revision, viaje) => {
    lecturaCierre.mockResolvedValue({ data: fila(String(revision), viaje), error: null });
    runAgent.mockResolvedValue(ciclo());
    await processInbound(listo);
    expect(textos().join(' | ')).toContain('No pude confirmar');
    expect(textos().join(' | ')).not.toMatch(/cerrado=true|ya quedó cerrada/);
    expect(avisarCierreAlJefe).not.toHaveBeenCalled();
    expect(documentos()).toHaveLength(0);
  });

  it.each(['pendiente', 'aprobada', 'ajustada'])('recupera cierre vigente %s/liquidado y su versión PDF', async revision => {
    lecturaCierre.mockResolvedValue({ data: fila(revision, { estatus: 'liquidado' }), error: null });
    runAgent.mockResolvedValue(ciclo());
    await processInbound(listo);
    expect(textos().join(' | ')).toContain('cerrado=true');
    expect(createSignedUrl).toHaveBeenCalledWith(version.replace('.pdf', '-operador.pdf'), expect.any(Number));
    expect(createSignedUrl).toHaveBeenCalledWith(version, expect.any(Number));
    expect(avisarCierreAlJefe).toHaveBeenCalled();
  });

  it('aborto con lectura indeterminada no confirma ni niega el cierre', async () => {
    lecturaCierre.mockResolvedValue({ data: null, error: { message: 'lectura sin respuesta' } });
    runAgent.mockRejectedValue(new PartialExecutionError('timeout', new Error('timeout'), [toolFallida], 0, 0, 0));
    await processInbound(listo);
    const dicho = textos().join(' | ');
    expect(dicho).toContain('No pude confirmar');
    expect(dicho).not.toMatch(/cerrado=true|ya quedó cerrada|sigue abierto|NO.*cerr/);
    expect(avisarCierreAlJefe).not.toHaveBeenCalled();
    expect(documentos()).toHaveLength(0);
  });
});

describe('C1 — el reintento sin viaje abierto no niega un cierre reciente', () => {
  beforeEach(() => { getOpenViaje.mockResolvedValue(null); });

  it('con una liquidación reciente del operador, se le CONFIRMA el cierre', async () => {
    liquidacionReciente.mockResolvedValue({ viajeId: 'v1', liquidacionId: 'L1', pdfUrl: null, entregadaOperadorEn: null, avisadaOficinaEn: null });
    await processInbound(listo);
    const dichos = textos().join(' | ');
    expect(dichos, 'negó un cierre que sí existe').not.toMatch(/No tienes un viaje abierto para liquidar/i);
    expect(dichos).toMatch(/liquidad/i);
    expect(dichos).toMatch(/contralor|panel/i);
  });

  // ── AUDITORÍA 24 · AGEN-4 (ALTO) ──────────────────────────────────────────
  // Toda muerte posterior al commit (kill de Vercel antes de `say`, del PDF o
  // del aviso al jefe) aterriza aquí. Antes: «pídeselo a tu contralor» sin
  // mandar el PDF que existe y sin avisar al jefe — nunca.
  const cerradaSinEntregar = (): Reciente => ({ viajeId: 'v1', liquidacionId: 'L1', pdfUrl: 't1/v1.pdf', entregadaOperadorEn: null, avisadaOficinaEn: null });

  it('AGEN-4: con PDF en la base y sin sellos, ENTREGA el PDF, avisa al jefe con el ejemplar del contralor y sella los dos', async () => {
    liquidacionReciente.mockResolvedValue(cerradaSinEntregar());
    // El PDF que se le pasa SÍ llega al jefe (agentico.md:526): sin esto,
    // `avisada_oficina_en` no se sella con el mock genérico de `{enviado:true}`.
    avisarCierreAlJefe.mockResolvedValueOnce({ enviado: true, pdfEnviado: true });
    await processInbound(listo);
    // El PDF del operador salió por WhatsApp, firmado en storage.
    expect(documentos()).toHaveLength(1);
    expect(createSignedUrl).toHaveBeenCalledWith('t1/v1-operador.pdf', expect.any(Number));
    // El jefe se entera, con el ejemplar completo.
    expect(avisarCierreAlJefe).toHaveBeenCalledTimes(1);
    expect(avisarCierreAlJefe).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', viajeId: 'v1', urlPdf: 'https://x/liq.pdf', telefonoOperador: listo.from }));
    // Y quedó sellado, para que el siguiente «listo» no lo repita.
    const sellos = sellarEntregaLiquidacion.mock.calls.map((c) => c[2]);
    expect(sellos).toEqual(expect.arrayContaining(['entregada_operador_en', 'avisada_oficina_en']));
    // El texto dice lo que pasó de verdad: el PDF va, no «pídeselo».
    const dichos = textos().join(' | ');
    expect(dichos).toMatch(/liquidado/i);
    expect(dichos).toMatch(/PDF/);
    expect(dichos).not.toMatch(/pídeselo a tu contralor/i);
  });

  // AG-A1-f (auditoría 28, agentico.md:32): antes esto SEGUÍA llamando a
  // `entregarCierrePendiente` (que resolvía ambas patas en 'ya_entregado'/
  // 'ya_avisado' sin red, por los sellos ya puestos) y el chofer leía «ya te
  // lo había mandado». Ahora el llamador filtra el caso «los dos sellos
  // puestos» ANTES de invocarla — mismo resultado observable (nada de red,
  // nada de log de reentrega), pero con un texto corto y distinto.
  it('AGEN-4/AG-A1-f: con los dos sellos puestos NO repite nada: ni documento ni aviso al jefe, y lo dice', async () => {
    liquidacionReciente.mockResolvedValue({ ...cerradaSinEntregar(), entregadaOperadorEn: '2026-09-01T10:41:20Z', avisadaOficinaEn: '2026-09-01T10:41:25Z' });
    await processInbound(listo);
    expect(documentos()).toHaveLength(0);
    expect(avisarCierreAlJefe).not.toHaveBeenCalled();
    expect(sellarEntregaLiquidacion).not.toHaveBeenCalled();
    expect(textos().join(' | ')).toMatch(/ya quedó liquidado/i);
    expect(textos().join(' | ')).not.toMatch(/No tienes un viaje abierto para liquidar/i);
  });

  it('AGEN-4: sin `pdf_url` no se firma un objeto inexistente; el jefe se avisa igual (sin PDF) y al chofer se le dice que el PDF no se generó', async () => {
    liquidacionReciente.mockResolvedValue({ ...cerradaSinEntregar(), pdfUrl: null });
    await processInbound(listo);
    expect(documentos()).toHaveLength(0);
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(avisarCierreAlJefe).toHaveBeenCalledWith(expect.objectContaining({ urlPdf: null }));
    expect(sellarEntregaLiquidacion.mock.calls.map((c) => c[2])).toEqual(['avisada_oficina_en']);
    expect(textos().join(' | ')).toMatch(/no se generó/i);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AUDITORÍA 25 (MEDIO, agentico.md:526) — una firma de PDF fallida (o un
  // `sendDocument` que Meta rechaza DENTRO de `avisarCierreAlJefe`) sellaba
  // `avisada_oficina_en` de todos modos si el TEXTO había salido — el
  // ejemplar del contralor se perdía para siempre porque el sello le decía
  // a `entregarCierrePendiente` que ya no había nada pendiente.
  // ═══════════════════════════════════════════════════════════════════════

  it('agentico.md:526: si createSignedUrl falla para el PDF del jefe, NO se sella avisada_oficina_en aunque el texto sí saliera', async () => {
    liquidacionReciente.mockResolvedValue(cerradaSinEntregar());
    // Firma el PDF del OPERADOR bien; falla SOLO la del ejemplar del jefe.
    createSignedUrl.mockImplementation(async (path: string) => (
      path === 't1/v1.pdf'
        ? { data: null, error: { message: 'blip de Storage' } }
        : { data: { signedUrl: 'https://x/liq.pdf' }, error: null }
    ));
    // El texto SÍ sale (el WhatsApp al jefe no depende del papel, M27) —
    // `avisarCierreAlJefe` recibe `urlPdf: null` y no intenta el PDF aquí.
    avisarCierreAlJefe.mockResolvedValueOnce({ enviado: true, pdfEnviado: null });
    await processInbound(listo);

    expect(avisarCierreAlJefe).toHaveBeenCalledWith(expect.objectContaining({ urlPdf: null }));
    // El PDF del operador SÍ se selló — ese sí llegó.
    const sellos = sellarEntregaLiquidacion.mock.calls.map((c) => c[2]);
    expect(sellos).toContain('entregada_operador_en');
    // Pero el del jefe NO: sigue pendiente para el siguiente reintento.
    expect(sellos).not.toContain('avisada_oficina_en');
  });

  it('agentico.md:526: si sendDocument falla DENTRO de avisarCierreAlJefe (Meta rechaza el adjunto al jefe), tampoco se sella', async () => {
    liquidacionReciente.mockResolvedValue(cerradaSinEntregar());
    // La firma sale bien — el fallo es que Meta rechaza el documento al
    // jefe, algo que solo `avisarCierreAlJefe` sabe (aquí, mockeado).
    avisarCierreAlJefe.mockResolvedValueOnce({ enviado: true, pdfEnviado: false });
    await processInbound(listo);

    expect(avisarCierreAlJefe).toHaveBeenCalledWith(expect.objectContaining({ urlPdf: 'https://x/liq.pdf' }));
    expect(sellarEntregaLiquidacion.mock.calls.map((c) => c[2])).not.toContain('avisada_oficina_en');
  });

  it('AGEN-4: si Meta rechaza el PDF, NO se sella la entrega y al chofer no se le afirma que ya lo tiene', async () => {
    liquidacionReciente.mockResolvedValue(cerradaSinEntregar());
    fetchSpy.mockImplementationOnce(async (url: string, init?: RequestInit) => {
      salientes.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ error: { code: 131053, message: 'Media upload error' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    });
    await processInbound(listo);
    expect(sellarEntregaLiquidacion.mock.calls.map((c) => c[2])).not.toContain('entregada_operador_en');
    expect(textos().join(' | ')).toMatch(/no se te pudo entregar/i);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AUDITORÍA 28 · AG-A1 (ALTO, reincidente desde la 26, agentico.md:32) —
  // el sello de grano grueso de la 25 (arriba) resolvía «el PDF llegó o no»,
  // pero dejaba fuera dos casos que TAMPOCO se arreglan reintentando desde
  // el chat: `encolado` (el outbox ya tiene el payload) y `definitivo` (Meta
  // rechazó con un código que nunca va a cambiar, p. ej. 131030). Sin esto,
  // cada «gracias» del chofer volvía a firmar Storage y a pegarle a la Graph
  // API — hasta por 24 h — sobre algo que ya no iba a resolverse solo.
  // ═══════════════════════════════════════════════════════════════════════
  it('AG-A1-b: PDF del jefe ENCOLADO (red caída, sin código) también sella avisada_oficina_en', async () => {
    liquidacionReciente.mockResolvedValue(cerradaSinEntregar());
    avisarCierreAlJefe.mockResolvedValueOnce({ enviado: true, pdfEnviado: false, pdfEstado: 'encolado' });
    await processInbound(listo);
    expect(sellarEntregaLiquidacion.mock.calls.map((c) => c[2])).toContain('avisada_oficina_en');
    expect(alertarOperador).not.toHaveBeenCalledWith('cierre.pdf_jefe_definitivo', expect.anything());
  });

  it('AG-A1-b: PDF del jefe DEFINITIVO (código no reintentable) sella avisada_oficina_en y alerta UNA vez', async () => {
    liquidacionReciente.mockResolvedValue(cerradaSinEntregar());
    avisarCierreAlJefe.mockResolvedValueOnce({
      enviado: true, pdfEnviado: false, pdfEstado: 'definitivo',
      motivo: 'WhatsApp rechazó el documento: número inválido (131030)',
    });
    await processInbound(listo);
    expect(sellarEntregaLiquidacion.mock.calls.map((c) => c[2])).toContain('avisada_oficina_en');
    expect(alertarOperador).toHaveBeenCalledTimes(1);
    expect(alertarOperador).toHaveBeenCalledWith('cierre.pdf_jefe_definitivo', expect.objectContaining({ viaje: 'v1' }));
  });

  it('AG-A1-e: PDF del CHOFER encolado (falla de red, sin código) sella entregada_operador_en', async () => {
    liquidacionReciente.mockResolvedValue(cerradaSinEntregar());
    // Sin `codigo`: el mismo camino de red que `sendDocument` ya encola por
    // su cuenta (ver `meta/client.ts`) antes de devolver `{ok:false}`.
    fetchSpy.mockImplementationOnce(async () => { throw new Error('fetch failed'); });
    await processInbound(listo);
    expect(sellarEntregaLiquidacion.mock.calls.map((c) => c[2])).toContain('entregada_operador_en');
    expect(textos().join(' | ')).toMatch(/liquidado/i);
  });

  // AUDITORÍA 28 · AG-A1-d — el techo EN PROCESO. Una flota sin teléfono de
  // oficina nunca va a sellar `avisada_oficina_en` (nadie recibió nada), así
  // que sin techo cada «gracias» del chofer dentro de las 24 h repetiría el
  // intento de avisar al jefe (y su log de error) para siempre.
  it('AG-A1-d: técho en proceso — tras el techo, ya no se vuelve a llamar avisarCierreAlJefe para la misma liquidación', async () => {
    liquidacionReciente.mockResolvedValue(cerradaSinEntregar());
    avisarCierreAlJefe.mockResolvedValue({ enviado: false, motivo: 'Esa flota no tiene un teléfono de oficina registrado.', pdfEnviado: null, pdfEstado: null });

    await processInbound(listo);
    await processInbound(listo);
    await processInbound(listo);

    // TECHO_REENTREGAS_POR_PROCESO = 2: la 3ª vuelta ya no llama.
    expect(avisarCierreAlJefe).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith('cierre.reentrega_agotada', expect.objectContaining({ liq: 'L1' }));
  });

  it('sin liquidación reciente, el mensaje de siempre (regresión)', async () => {
    liquidacionReciente.mockResolvedValue(null);
    await processInbound(listo);
    expect(textos().join(' | ')).toMatch(/No tienes un viaje abierto/i);
  });

  it('si la consulta de la liquidación reciente truena, no se cae el turno: mensaje de siempre', async () => {
    liquidacionReciente.mockRejectedValue(new Error('base caída'));
    await processInbound(listo);
    expect(textos().join(' | ')).toMatch(/No tienes un viaje abierto/i);
  });
});
