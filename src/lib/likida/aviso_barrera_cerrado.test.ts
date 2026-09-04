import { describe, it, expect, vi, beforeEach } from 'vitest';

// P0 0321 — Ninguna incertidumbre causal autoriza una liquidación. El mensaje
// "listo" permanece durable (sin consumir intento) hasta que intake, la cola de
// fotos y los incidentes OCR confirmen que los insumos están completos.

const runAgent = vi.fn();
const esperarIntake = vi.fn(async () => true);
const fotoAnteriorSinProcesar = vi.fn<() => Promise<boolean | null>>(async () => false);
const releaseMessageClaim = vi.fn(async () => undefined);
const getHuerfanos = vi.fn(async (_t: string, _o: string, _op?: Record<string, unknown>) => [] as Array<{ id: string }>);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

vi.mock('@/lib/agents/run', () => ({ runAgent: (...a: unknown[]) => runAgent(...a) }));
vi.mock('@/lib/likida/conv', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveOperador: vi.fn(async () => ({ tenantId: 't1', operadorId: 'o1' })),
  getOpenViaje: vi.fn(async () => 'v1'),
  viajeAbiertoDesdeMs: vi.fn(async () => null),
  getTenantContext: vi.fn(async () => ({ nombre: 'Flota' })),
  loadConversation: vi.fn(async () => ({ id: 'c1', turns: [], cierreSinComprobantes: true })),
  saveConversation: vi.fn(), claimMessage: vi.fn(async () => 'nuevo' as const),
  acquireViajeLock: vi.fn(async () => true), intentarLockViaje: vi.fn(async () => 'obtenido' as const),
  releaseViajeLock: vi.fn(),
  releaseMessageClaim: (...a: unknown[]) => releaseMessageClaim(...(a as [])),
  intakeDelta: vi.fn(async () => 0),
  esperarIntake: (...a: unknown[]) => esperarIntake(...(a as [])),
  fotoAnteriorSinProcesar: (...a: unknown[]) => fotoAnteriorSinProcesar(...(a as [])),
}));
vi.mock('@/lib/likida/repo', () => ({
  ubicarGastoPorHash: vi.fn(async () => null),
  getHuerfanos: (...a: unknown[]) => getHuerfanos(...(a as [string, string, Record<string, unknown>?])),
  guardarHuerfano: vi.fn(async () => true), resolverHuerfanos: vi.fn(), marcarHuerfanosOfrecidos: vi.fn(),
  addGasto: vi.fn(), getGastos: vi.fn(async () => [{ id: 'g1' }]), updateGastoCfdiXml: vi.fn(),
  saveCfdiXmlRaw: vi.fn(), gastoExistePorHash: vi.fn(async () => false),
  enriquecerGastoConCodigo: vi.fn(), guardarCodigoPendiente: vi.fn(),
  getCodigosPendientes: vi.fn(async () => []), reclamarCodigoPendiente: vi.fn(),
  getDatosResponsable: vi.fn(async () => ({ razonSocial: 'FLOTA', domicilio: 'Calle 1', urlAvisoIntegral: 'https://x/p' })),
  reclamarEnvioAviso: vi.fn(async () => false), liberarEnvioAviso: vi.fn(),
  getViaje: vi.fn(async () => ({ id: 'v1', anticipo: 1000 })),
  getOperador: vi.fn(async () => ({ id: 'o1', nombre: 'Operador', telefono: '5219993700779' })),
  saveLiquidacion: vi.fn(async () => 'L1'),
  getAcumuladoCombustible: vi.fn(async () => { throw new Error('sin base'); }),
  getPerfilCrudo: vi.fn(async () => ({})),
}));
vi.mock('@/lib/likida/costos', () => ({
  registrarCosto: vi.fn(), registrarCostoWhatsApp: vi.fn(),
  faseDeModelo: vi.fn(() => 'cuadre'), vincularCostosALiquidacion: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    storage: { from: () => ({ upload: async () => ({ error: null }), createSignedUrl: async () => ({ data: null, error: { message: 'sin storage' } }) }) },
  }),
}));
vi.mock('@/lib/logger', () => ({ logger }));

const { processInbound } = await import('./processor');

const listo = (timestampMs?: number) => ({
  from: '5219993700779', type: 'text' as const, text: 'listo', waMessageId: 'wa1', timestampMs,
});

beforeEach(() => {
  runAgent.mockReset();
  esperarIntake.mockReset(); esperarIntake.mockResolvedValue(true);
  fotoAnteriorSinProcesar.mockReset(); fotoAnteriorSinProcesar.mockResolvedValue(false);
  releaseMessageClaim.mockReset(); releaseMessageClaim.mockResolvedValue(undefined);
  getHuerfanos.mockReset(); getHuerfanos.mockResolvedValue([]);
  logger.info.mockReset(); logger.warn.mockReset(); logger.error.mockReset();
});

async function esperaSinCerrar(msg = listo()) {
  const resultado = await processInbound(msg);
  expect(resultado).toBe('sin_tiempo');
  expect(runAgent).not.toHaveBeenCalled();
  expect(releaseMessageClaim).toHaveBeenCalledTimes(1);
}

describe('cierre fail-closed y reintento durable', () => {
  it('timeout/lectura indeterminada de intake => cero agente y no consume intento', async () => {
    esperarIntake.mockResolvedValue(false);
    await esperaSinCerrar();
  });

  it('foto anterior pendiente, incluso dead-letter, => cero cierre', async () => {
    fotoAnteriorSinProcesar.mockResolvedValue(true);
    await esperaSinCerrar(listo(1_756_000_001_100));
    expect(logger.warn).toHaveBeenCalledWith('cierre.foto_anterior_pendiente', expect.anything());
  });

  it('falla de lectura de la foto anterior => indeterminado y cero cierre', async () => {
    fotoAnteriorSinProcesar.mockResolvedValue(null);
    await esperaSinCerrar(listo(1_756_000_001_100));
    expect(logger.warn).toHaveBeenCalledWith('cierre.foto_anterior_indeterminada', expect.anything());
  });

  it('incidente OCR conocido del viaje => cero cierre', async () => {
    getHuerfanos.mockImplementation(async (_t, _o, op) => op?.soloFalloOcr ? [{ id: 'h1' }] : []);
    await esperaSinCerrar();
    expect(logger.warn).toHaveBeenCalledWith('cierre.ocr_pendiente', expect.anything());
  });

  it('falla la lectura de incidentes OCR => cero cierre', async () => {
    getHuerfanos.mockImplementation(async (_t, _o, op) => {
      if (op?.soloFalloOcr) throw new Error('503');
      return [];
    });
    await esperaSinCerrar();
    expect(logger.error).toHaveBeenCalledWith('cierre.ocr_pendiente_ilegible', expect.anything());
  });
});
