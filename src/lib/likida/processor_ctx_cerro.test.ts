import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 8 · CRÍTICO de pruebas (superviviente de la ronda 6, 3ª ronda sin
// tocar) — `ctxCerro = closed` en el camino feliz (processor.ts:742) no tenía
// ninguna prueba que lo cubriera. Mutado a comentario, 1299/1300 pruebas
// seguían pasando.
//
// `ctxCerro` es el ÚNICO campo que el log del catch general trae para
// distinguir "no pasó nada" de "la liquidación YA se cerró y el operador se
// quedó sin nada" — la señal de que alguien tiene que entrar a mano. Si algo
// truena DESPUÉS del cierre exitoso (aquí: `saveConversation`), el log tiene
// que decir `cerroSinEntregar: true`, no `false`.
// ═══════════════════════════════════════════════════════════════════════════

const runAgent = vi.fn();
const saveConversation = vi.fn();
const claimMessage = vi.fn<(id: string) => Promise<'nuevo' | 'duplicado' | 'indeterminado'>>(async () => 'nuevo');
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

vi.mock('@/lib/agents/run', () => ({ runAgent: (...a: unknown[]) => runAgent(...a) }));
vi.mock('@/lib/likida/conv', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveOperador: vi.fn(async () => ({ tenantId: 't1', operadorId: 'o1' })),
  viajeAbiertoDesdeMs: vi.fn(async () => null),
  getOpenViaje: vi.fn(async () => 'v1'),
  getTenantContext: vi.fn(async () => ({ nombre: 'Flota' })),
  // `cierreSinComprobantes: true` deja pasar el freno de "cierre sin
  // comprobantes" (processor.ts): este archivo prueba que `ctxCerro` sobrevive
  // a un fallo posterior al cierre exitoso, no ese freno.
  loadConversation: vi.fn(async () => ({ id: 'c1', turns: [], cierreSinComprobantes: true })),
  saveConversation: (...a: unknown[]) => saveConversation(...a),
  claimMessage: (...a: unknown[]) => claimMessage(...(a as [string])),
  acquireViajeLock: vi.fn(async () => true), intentarLockViaje: vi.fn(async () => 'obtenido' as const), releaseViajeLock: vi.fn(),
  releaseMessageClaim: vi.fn(),
  fotoAnteriorSinProcesar: vi.fn(async () => false),
  intakeDelta: vi.fn(async () => 0), esperarIntake: vi.fn(async () => true),
}));
vi.mock('@/lib/likida/repo', () => ({
  ubicarGastoPorHash: vi.fn(async () => null),
  // Sala de espera de comprobantes sin viaje (mig. 0040). Sin estas cuatro,
  // `getHuerfanos` llega `undefined` y el processor truena en el `.length`.
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
}));
vi.mock('@/lib/likida/costos', () => ({
  registrarCosto: vi.fn(), registrarCostoWhatsApp: vi.fn(),
  faseDeModelo: vi.fn(() => 'cuadre'), vincularCostosALiquidacion: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    // El PDF falla en llegar (sin storage en pruebas) — no interfiere: es un
    // try/catch propio que ya se traga su propio error y sigue de largo.
    storage: { from: () => ({ upload: async () => ({ error: null }), createSignedUrl: async () => ({ data: null, error: { message: 'sin storage' } }) }) },
  }),
}));
vi.mock('@/lib/logger', () => ({ logger }));

const { processInbound } = await import('./processor');

const listo = { from: '5219993700779', type: 'text' as const, text: 'listo', timestampMs: 1788534000000, waMessageId: 'wa1' };

describe('processInbound — ctxCerro sobrevive a un fallo posterior al cierre exitoso', () => {
  beforeEach(() => {
    runAgent.mockReset(); saveConversation.mockReset();
    logger.error.mockReset(); logger.warn.mockReset(); logger.info.mockReset();
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ messages: [{ id: 'wamid.TEST' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } })));
    process.env.WHATSAPP_ACCESS_TOKEN = 'tok-de-prueba';
    process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
    // guardar_liquidacion CORRIÓ SIN ERROR: closed = true en el camino feliz.
    runAgent.mockResolvedValue({
      finalText: 'Listo, cuadré tu viaje 👇', model: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0,
      toolCalls: [{ toolName: 'guardar_liquidacion', error: undefined, result: { liquidacion_id: 'L1', pdf_generado: false } }],
    });
    // Lo que truena DESPUÉS del cierre — el ejemplo que el propio comentario
    // del código señala como el caso que ctxCerro tiene que sobrevivir.
    saveConversation.mockRejectedValue(new Error('saveConversation reventó en pruebas'));
  });

  it('el log del catch general dice cerroSinEntregar: true, no false', async () => {
    await processInbound(listo);
    expect(logger.error).toHaveBeenCalled();
    const llamadaConCtx = logger.error.mock.calls.find((c) => c[0] === 'processInbound.fail');
    expect(llamadaConCtx, 'se esperaba un log processInbound.fail con el error de saveConversation').toBeTruthy();
    expect((llamadaConCtx![1] as { cerroSinEntregar?: boolean }).cerroSinEntregar).toBe(true);
  });
});
