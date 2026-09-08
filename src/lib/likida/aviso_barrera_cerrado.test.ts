import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InboundMessage } from './processor';

// P0 0321 — Ninguna incertidumbre causal autoriza una liquidación. El mensaje
// "listo" permanece durable (sin consumir intento) hasta que intake, la cola de
// fotos y los incidentes OCR confirmen que los insumos están completos.
//
// AUDITORÍA 28 · BE-A4 (ALTO) + BE-A3 (ALTO): un "listo" sin hora de Meta
// aplazaba PARA SIEMPRE (sin consumir intento) y una foto que agotó sus
// intentos (carta muerta) bloqueaba en silencio, también para siempre. Ahora:
//   · `recibidoMs` (la hora de NUESTRO servidor) es la cota superior honesta
//     que se usa cuando Meta no mandó `timestampMs` — y si NINGUNA de las dos
//     existe, el aplazamiento consume el intento (tope real) en vez de ser
//     eterno.
//   · una carta muerta (foto que agotó sus intentos) se avisa una vez, al
//     chofer y al operador, y se sella — deja de bloquear para siempre.

const runAgent = vi.fn();
const esperarIntake = vi.fn(async () => true);
const fotoAnteriorSinProcesar = vi.fn<() => Promise<{ vivas: number; muertas: Array<{ id: string; recibidoMs: number | null; timestampMs: number | null }> } | null>>(async () => ({ vivas: 0, muertas: [] }));
const releaseMessageClaim = vi.fn(async () => undefined);
const getHuerfanos = vi.fn(async (_t: string, _o: string, _op?: Record<string, unknown>) => [] as Array<{ id: string }>);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const sendText = vi.fn<(to: string, body: string) => Promise<string | null>>(async () => 'wamid.OUT');
const alertarOperador = vi.fn<(evento: string, detalle: Record<string, unknown>) => Promise<void>>(async () => undefined);
const descartarCartaMuerta = vi.fn<(id: string, motivo: string) => Promise<boolean>>(async () => true);

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
vi.mock('@/lib/meta/client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  sendText: (...a: unknown[]) => sendText(...(a as [string, string])),
}));
vi.mock('@/lib/observability/alerta', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  alertarOperador: (...a: unknown[]) => alertarOperador(...(a as [string, Record<string, unknown>])),
}));
vi.mock('@/lib/likida/wa_pendientes', () => ({
  MAX_INTENTOS_PENDIENTE: 5,
  descartarCartaMuerta: (...a: unknown[]) => descartarCartaMuerta(...(a as [string, string])),
}));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    storage: { from: () => ({ upload: async () => ({ error: null }), createSignedUrl: async () => ({ data: null, error: { message: 'sin storage' } }) }) },
  }),
}));
vi.mock('@/lib/logger', () => ({ logger }));

const { processInbound } = await import('./processor');

const listo = (timestampMs?: unknown, recibidoMs?: unknown): InboundMessage => ({
  from: '5219993700779', type: 'text', text: 'listo', waMessageId: 'wa1',
  timestampMs: timestampMs as number | undefined,
  recibidoMs: recibidoMs as number | undefined,
});

beforeEach(() => {
  runAgent.mockReset();
  // Sólo hace falta cuando el turno de verdad llega al agente (las pruebas de
  // BE-A4 que verifican que el cierre SIGUE su curso, no que se aplaza).
  runAgent.mockResolvedValue({ finalText: 'Listo', toolCalls: [], model: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0 });
  esperarIntake.mockReset(); esperarIntake.mockResolvedValue(true);
  fotoAnteriorSinProcesar.mockReset(); fotoAnteriorSinProcesar.mockResolvedValue({ vivas: 0, muertas: [] });
  releaseMessageClaim.mockReset(); releaseMessageClaim.mockResolvedValue(undefined);
  getHuerfanos.mockReset(); getHuerfanos.mockResolvedValue([]);
  sendText.mockReset(); sendText.mockResolvedValue('wamid.OUT');
  alertarOperador.mockReset(); alertarOperador.mockResolvedValue(undefined);
  descartarCartaMuerta.mockReset(); descartarCartaMuerta.mockResolvedValue(true);
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
    // Hora válida a propósito: esto prueba la barrera de INTAKE, no la de la
    // hora (BE-A4, más abajo) — sin hora ninguna, el turno ni llegaría aquí.
    await esperaSinCerrar(listo(1_756_000_001_100));
  });

  it('foto anterior pendiente (vivas > 0) => cero cierre', async () => {
    fotoAnteriorSinProcesar.mockResolvedValue({ vivas: 1, muertas: [] });
    await esperaSinCerrar(listo(1_756_000_001_100));
    expect(logger.warn).toHaveBeenCalledWith('cierre.foto_anterior_pendiente', expect.anything());
  });

  it('falla de lectura de la foto anterior => indeterminado y cero cierre', async () => {
    fotoAnteriorSinProcesar.mockResolvedValue(null);
    await esperaSinCerrar(listo(1_756_000_001_100));
    expect(logger.warn).toHaveBeenCalledWith('cierre.foto_anterior_indeterminada', expect.anything());
  });

  it('vivas=1 => sin mensaje al chofer (hoy y siempre)', async () => {
    fotoAnteriorSinProcesar.mockResolvedValue({ vivas: 1, muertas: [] });
    await esperaSinCerrar(listo(1_756_000_001_100));
    expect(sendText).not.toHaveBeenCalled();
  });

  it('incidente OCR conocido del viaje => cero cierre', async () => {
    getHuerfanos.mockImplementation(async (_t, _o, op) => op?.soloFalloOcr ? [{ id: 'h1' }] : []);
    await esperaSinCerrar(listo(1_756_000_001_100));
    expect(logger.warn).toHaveBeenCalledWith('cierre.ocr_pendiente', expect.anything());
  });

  it('falla la lectura de incidentes OCR => cero cierre', async () => {
    getHuerfanos.mockImplementation(async (_t, _o, op) => {
      if (op?.soloFalloOcr) throw new Error('503');
      return [];
    });
    await esperaSinCerrar(listo(1_756_000_001_100));
    expect(logger.error).toHaveBeenCalledWith('cierre.ocr_pendiente_ilegible', expect.anything());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28 · BE-A4 — LA HORA: `timestampMs` (Meta) primero, `recibidoMs`
// (nuestro servidor) como cota superior de último recurso, y SIN NINGUNA de
// las dos, el aplazamiento consume el intento (ya no es eterno).
// ═══════════════════════════════════════════════════════════════════════════
describe('BE-A4 · la hora del cierre', () => {
  it('timestampMs ausente pero recibidoMs válido => SÍ consulta con recibidoMs, logea por_recepcion, y el cierre sigue su curso', async () => {
    const resultado = await processInbound(listo(undefined, 1_756_000_005_000));
    expect(resultado).toBe('procesado');
    expect(fotoAnteriorSinProcesar).toHaveBeenCalledWith('5219993700779', 1_756_000_005_000);
    expect(logger.warn).toHaveBeenCalledWith('cierre.timestamp_por_recepcion', expect.objectContaining({ recibidoMs: 1_756_000_005_000 }));
    expect(logger.error).not.toHaveBeenCalledWith('cierre.timestamp_indeterminado', expect.anything());
  });

  it.each([
    ['cero', 0],
    ['NaN', Number.NaN],
    ['texto malformado', 'ayer'],
  ])('timestampMs %s con recibidoMs válido => se usa recibidoMs', async (_caso, timestampMs) => {
    const resultado = await processInbound(listo(timestampMs, 1_756_000_006_000));
    expect(resultado).toBe('procesado');
    expect(fotoAnteriorSinProcesar).toHaveBeenCalledWith('5219993700779', 1_756_000_006_000);
  });

  it('ni timestampMs ni recibidoMs => consume el intento (NO es "sin_tiempo") y logger.error', async () => {
    const resultado = await processInbound(listo(undefined, undefined));
    expect(resultado).toBe('reintentable');
    expect(fotoAnteriorSinProcesar).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('cierre.timestamp_indeterminado', expect.anything());
    expect(runAgent).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28 · BE-A3 — LA CARTA MUERTA: se avisa una vez y se sella; deja
// de bloquear al chofer para siempre.
// ═══════════════════════════════════════════════════════════════════════════
describe('BE-A3 · la carta muerta', () => {
  const muerta = { id: 'wamid.MUERTA', recibidoMs: 1_756_000_000_000, timestampMs: null };

  it('vivas=0, muertas=1 => avisa al chofer, alerta al operador, sella, y aplaza UNA vuelta', async () => {
    fotoAnteriorSinProcesar.mockResolvedValue({ vivas: 0, muertas: [muerta] });
    await esperaSinCerrar(listo(1_756_000_001_100));

    expect(descartarCartaMuerta).toHaveBeenCalledTimes(1);
    expect(descartarCartaMuerta).toHaveBeenCalledWith('wamid.MUERTA', expect.stringContaining('carta muerta'));
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(alertarOperador).toHaveBeenCalledWith('cierre.carta_muerta', expect.objectContaining({ fotoId: 'wamid.MUERTA' }));
    expect(logger.error).toHaveBeenCalledWith('cierre.carta_muerta', expect.anything());
    // El teléfono va enmascarado, nunca crudo, a la alerta.
    const [, detalleAlerta] = alertarOperador.mock.calls[0];
    expect(JSON.stringify(detalleAlerta)).not.toContain('5219993700779');
  });

  it('mismo caso con sello fallido => ni say ni alerta, aplaza como indeterminado', async () => {
    fotoAnteriorSinProcesar.mockResolvedValue({ vivas: 0, muertas: [muerta] });
    descartarCartaMuerta.mockResolvedValue(false);
    await esperaSinCerrar(listo(1_756_000_001_100));

    expect(sendText).not.toHaveBeenCalled();
    expect(alertarOperador).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('cierre.carta_muerta_no_sellada', expect.anything());
  });
});
