import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 21 · CRÍTICO (C2) — nada volvía a mirar el reloj DESPUÉS del
// agente, y el margen de cierre se dimensionó contra costos típicos.
//
// Después de `runAgent` (la última consulta a `reloj.*` era su `timeoutMs`),
// la cola de cierre corría ENTERA a ciegas: say(reply), URL firmada + PDF al
// chofer, URL firmada + aviso + PDF al jefe, saveConversation, release del
// lock. Si Meta o Supabase están LENTOS —no caídos— y cada paso tarda cerca
// de su techo duro (10s por envío, 8s+1.5s por consulta) en vez de su costo
// nominal (1.5s/0.3s), la cola suma 70-90s reales contra los 17s reservados.
// Vercel mata el proceso a los 120s en un punto intermedio: sin excepción, sin
// catch, sin logger.error — la base dice «liquidado» y nadie lo sabe.
//
// Lo que se fija aquí:
//   1. después del agente se vuelve a mirar el reloj, y si el margen real ya
//      no alcanza, queda un `cierre.sin_margen` RUIDOSO (la muerte del proceso
//      no deja rastro; esto sí);
//   2. en ese modo se OMITEN, explícitamente y con log, los pasos accesorios
//      (el aviso al jefe, el aviso de barrera) para gastar lo que queda en los
//      irrenunciables: la respuesta y el PDF del chofer;
//   3. los irrenunciables se intentan IGUAL — recortar la verdad al chofer
//      sería el mismo silencio que se viene a evitar;
//   4. con margen de sobra (el caso normal), nada cambia.
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
const esperarIntake = vi.fn(async () => true);
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
  return ok({ url: 'https://media.test/x', mime_type: 'text/xml' });
});

const textos = () => salientes.filter((s) => s.body.type === 'text').map((s) => String((s.body.text as { body: string }).body));
const documentos = () => salientes.filter((s) => s.body.type === 'document');

vi.mock('@/lib/agents/run', () => ({ runAgent: (...a: unknown[]) => runAgent(...a) }));
vi.mock('@/lib/likida/conv', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveOperador: vi.fn(async () => ({ tenantId: 't1', operadorId: 'o1' })),
  getOpenViaje: (t: string, o: string) => getOpenViaje(t, o),
  getTenantContext: vi.fn(async () => ({ nombre: 'Flota' })),
  loadConversation: (...a: unknown[]) => loadConversation(...(a as [])),
  saveConversation: (...a: unknown[]) => saveConversation(...a),
  claimMessage: (...a: unknown[]) => claimMessage(...(a as [string])),
  acquireViajeLock: vi.fn(async () => true), intentarLockViaje: vi.fn(async () => 'obtenido' as const),
  releaseViajeLock: vi.fn(), releaseMessageClaim: vi.fn(),
  intakeDelta: vi.fn(async () => 0), esperarIntake: (...a: unknown[]) => esperarIntake(...(a as [])),
  fotoAnteriorSinProcesar: vi.fn(async () => false),
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
}));
vi.mock('@/lib/likida/costos', () => ({
  registrarCosto: vi.fn(), registrarCostoWhatsApp: vi.fn(),
  faseDeModelo: vi.fn(() => 'cuadre'), vincularCostosALiquidacion: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (_tabla: string) => {
      const b: Record<string, unknown> = {};
      const self = () => b;
      for (const m of ['select', 'eq', 'gte', 'lte', 'or', 'order', 'in', 'is', 'limit']) b[m] = self;
      b.range = async () => ({ data: [], error: null, count: 0 });
      b.maybeSingle = async () => ({ data: null, error: null });
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
      return b;
    },
    storage: { from: () => ({ createSignedUrl: (...a: unknown[]) => createSignedUrl(...a), upload: async () => ({ error: null }) }) },
  }),
}));
vi.mock('@/lib/logger', () => ({ logger }));

const avisarCierreAlJefe = vi.fn(async (_a: unknown) => ({ enviado: true }));
vi.mock('./avisar_cierre', () => ({ avisarCierreAlJefe: (a: unknown) => avisarCierreAlJefe(a) }));

const { processInbound } = await import('./processor');

const listo = {
  from: '5219993700779', type: 'text' as const, text: 'listo', waMessageId: 'wa1',
  timestampMs: 1_756_000_001_100,
};

const cierre = () => ({
  finalText: 'Listo, cerré tu viaje',
  toolCalls: [{ toolName: 'guardar_liquidacion', args: {}, result: { liquidacion_id: 'L1', pdf_generado: true, pdf_contralor_generado: true }, durationMs: 5 }],
  model: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0,
});

/** El agente devuelve el cierre, pero DEVORÁNDOSE el reloj: al salir quedan
 *  ~`quedanMs` reales antes de que Vercel mate el proceso (`maxDuration`). */
const agenteQueTarda = (quedanMs: number) => {
  runAgent.mockImplementation(async () => {
    vi.setSystemTime(Date.now() + 120_000 - quedanMs);
    return cierre();
  });
};

beforeEach(() => {
  // SOLO la fecha: los `setTimeout` de `acotada` y compañía siguen reales.
  vi.useFakeTimers({ toFake: ['Date'] });
  salientes.length = 0;
  runAgent.mockReset(); createSignedUrl.mockReset();
  createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://x/liq.pdf' }, error: null });
  logger.info.mockReset(); logger.warn.mockReset(); logger.error.mockReset();
  getOpenViaje.mockReset(); getOpenViaje.mockResolvedValue('v1');
  esperarIntake.mockReset(); esperarIntake.mockResolvedValue(true);
  claimMessage.mockReset(); claimMessage.mockResolvedValue('nuevo');
  saveConversation.mockReset(); saveConversation.mockResolvedValue(undefined);
  loadConversation.mockReset();
  loadConversation.mockResolvedValue({ id: 'c1', turns: [], cierreSinComprobantes: true });
  avisarCierreAlJefe.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
  fetchSpy.mockClear();
  process.env.WHATSAPP_ACCESS_TOKEN = 'tok-de-prueba';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
  delete process.env.LIKIDA_RECUPERAR_CIERRE_PARCIAL;
});

afterEach(() => { vi.useRealTimers(); });

describe('C2 — el reloj se vuelve a mirar DESPUÉS del agente', () => {
  it('si el agente devoró el presupuesto, queda un cierre.sin_margen ruidoso', async () => {
    agenteQueTarda(12_000);
    await processInbound(listo);
    expect(logger.error).toHaveBeenCalledWith('cierre.sin_margen', expect.objectContaining({ viaje: 'v1', cerro: true }));
  });

  it('y el aviso al jefe se OMITE explícitamente — no se arriesga el PDF del chofer a que Vercel mate el proceso a media cola', async () => {
    agenteQueTarda(12_000);
    await processInbound(listo);
    expect(avisarCierreAlJefe).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('cierre.jefe_omitido_sin_margen', expect.objectContaining({ viaje: 'v1' }));
  });

  it('los irrenunciables se intentan igual: el chofer recibe su respuesta y su PDF', async () => {
    agenteQueTarda(12_000);
    await processInbound(listo);
    expect(textos().length).toBeGreaterThan(0);
    expect(documentos()).toHaveLength(1);
  });

  it('la barrera vencida aplaza durablemente: no agente, cierre ni aviso', async () => {
    esperarIntake.mockResolvedValue(false);
    agenteQueTarda(12_000);
    const resultado = await processInbound(listo);
    const avisos = textos().filter((t) => /Ojo: cuadré con los/i.test(t));
    expect(resultado).toBe('sin_tiempo');
    expect(runAgent).not.toHaveBeenCalled();
    expect(avisos).toHaveLength(0);
    expect(documentos()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith('intake.barrera_timeout', expect.objectContaining({ viaje: 'v1', cierreSolicitado: true }));
  });

  it('control: con margen de sobra, el jefe recibe su aviso y no hay sin_margen', async () => {
    runAgent.mockResolvedValue(cierre());
    await processInbound(listo);
    expect(avisarCierreAlJefe).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalledWith('cierre.sin_margen', expect.anything());
  });

  it('control: aun con margen, una barrera vencida nunca se convierte en permiso de cierre', async () => {
    esperarIntake.mockResolvedValue(false);
    runAgent.mockResolvedValue(cierre());
    expect(await processInbound(listo)).toBe('sin_tiempo');
    expect(runAgent).not.toHaveBeenCalled();
    expect(textos()).toHaveLength(0);
    expect(documentos()).toHaveLength(0);
  });
});
