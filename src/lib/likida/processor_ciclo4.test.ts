import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA FABLE CICLO 4 — el cableado del pin (c4-6) y del proveedor que
// manda audio (c4-5) en el dispatcher.
//
// c4-6: el pin que el propio bot pide ("mándame tu ubicación") no llegaba
// nunca a la incidencia — la cascada juraba "sin ubicación del incidente" con
// el pin ya en el sistema, y el chofer varado SIN viaje recibía "no tienes un
// viaje abierto para liquidar 👍" en plena emergencia.
//
// c4-5: el gruero con gestión viva que contesta con nota de voz caía al
// "no te tengo registrado como operador" — la cotización se perdía en
// silencio. Las unidades de cada módulo ya prueban la lógica; esto fija que
// el dispatcher las llama en el orden correcto.
// ═══════════════════════════════════════════════════════════════════════════

const resolveOperador = vi.fn();
const resolverCuentaOficina = vi.fn();
const aceptarPorActividad = vi.fn();
const enviarBriefingInicio = vi.fn();
const extraerComprobante = vi.fn();
const subirComprobante = vi.fn();
const decidirFoto = vi.fn();
const addGasto = vi.fn();
const intakeDelta = vi.fn();
const sendText = vi.fn();
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

vi.mock('@/lib/agents/run', () => ({ runAgent: vi.fn() }));
const anclarUbicacionIncidencia = vi.fn();
vi.mock('@/lib/likida/asistencia_wa', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  anclarUbicacionIncidencia: (...a: unknown[]) => anclarUbicacionIncidencia(...a),
}));
const atenderMedioProveedorSinTexto = vi.fn();
const atenderMensajeProveedor = vi.fn();
vi.mock('@/lib/likida/asistencia_coordinacion', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  atenderMensajeProveedor: (...a: unknown[]) => atenderMensajeProveedor(...a),
  atenderMedioProveedorSinTexto: (...a: unknown[]) => atenderMedioProveedorSinTexto(...a),
}));
vi.mock('@/lib/likida/briefing_inicio_wa', () => ({
  enviarBriefingInicio: (...a: unknown[]) => enviarBriefingInicio(...a),
}));
vi.mock('@/lib/likida/confirmar_viaje', () => ({
  atenderConfirmacion: vi.fn(async () => ({ mensaje: null, estado: 'nada' })),
  aceptarPorActividad: (...a: unknown[]) => aceptarPorActividad(...a),
}));
vi.mock('@/lib/likida/contactos', () => ({
  resolverCuentaOficina: (...a: unknown[]) => resolverCuentaOficina(...a),
  telefonoJefeDe: vi.fn(async () => null),
  telefonosJefe: vi.fn(async () => ({})),
}));
vi.mock('@/lib/likida/conv', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveOperador: (...a: unknown[]) => resolveOperador(...a),
  getOpenViaje: vi.fn(async () => 'v1'),
  getTenantContext: vi.fn(async () => ({ nombre: 'Flota' })),
  loadConversation: vi.fn(async () => ({ id: 'c1', turns: [] })),
  saveConversation: vi.fn(),
  claimMessage: vi.fn(async () => 'nuevo' as const),
  acquireViajeLock: vi.fn(async () => true), intentarLockViaje: vi.fn(async () => 'obtenido' as const), releaseViajeLock: vi.fn(),
  releaseMessageClaim: vi.fn(),
  intakeDelta: (...a: unknown[]) => intakeDelta(...a),
  esperarIntake: vi.fn(async () => true),
  buscarOperadorPorTelefono: vi.fn(async () => null),
}));
vi.mock('@/lib/likida/intake/ocr', () => ({
  extraerComprobante: (...a: unknown[]) => extraerComprobante(...a),
}));
vi.mock('@/lib/likida/intake/almacen', () => ({
  subirComprobante: (...a: unknown[]) => subirComprobante(...a),
}));
vi.mock('@/lib/likida/intake/decidir', () => ({
  decidirFoto: (...a: unknown[]) => decidirFoto(...a),
}));
vi.mock('@/lib/likida/cuadre/desde_db', () => ({
  cuadrarDesdeDB: vi.fn(),
  ventanaDesdeDB: vi.fn(async () => undefined),
}));
vi.mock('@/lib/likida/repo', () => ({
  ubicarGastoPorHash: vi.fn(async () => null),
  getHuerfanos: vi.fn(async () => []), guardarHuerfano: vi.fn(async () => true),
  resolverHuerfanos: vi.fn(), marcarHuerfanosOfrecidos: vi.fn(),
  addGasto: (...a: unknown[]) => addGasto(...a),
  getGastos: vi.fn(async () => []), updateGastoCfdiXml: vi.fn(),
  saveCfdiXmlRaw: vi.fn(), gastoExistePorHash: vi.fn(async () => false),
  gastoPorHash: vi.fn(async () => null), corregirFechaGasto: vi.fn(),
  enriquecerGastoConCodigo: vi.fn(), guardarCodigoPendiente: vi.fn(),
  getCodigosPendientes: vi.fn(async () => []), reclamarCodigoPendiente: vi.fn(),
  getDatosResponsable: vi.fn(async () => ({
    razonSocial: 'FLOTA SA DE CV', domicilio: 'Calle 1, Mérida', urlAvisoIntegral: 'https://flota.mx/p',
  })),
  reclamarEnvioAviso: vi.fn(async () => false), confirmarEnvioAviso: vi.fn(),
  liberarEnvioAviso: vi.fn(), registrarSolicitudArco: vi.fn(),
  getViaje: vi.fn(async () => ({ id: 'v1', anticipo: 0 })),
}));
vi.mock('@/lib/likida/costos', () => ({
  registrarCosto: vi.fn(), registrarCostoWhatsApp: vi.fn(),
  faseDeModelo: vi.fn(() => 'cuadre'), vincularCostosALiquidacion: vi.fn(),
}));
vi.mock('@/lib/meta/client', () => ({
  MAX_CUERPO_BOTONES: 1024,
  sendText: (...a: unknown[]) => sendText(...a),
  // AGEN-5: el aviso al jefe sale por `avisarOficina` (texto → plantilla).
  enviarTexto: vi.fn(async () => ({ ok: true, id: 'wamid.JEFE' })),
  sendTemplate: vi.fn(async () => ({ ok: true, id: 'wamid.PLANTILLA' })),
  motivoDeFalloWhatsApp: (e: string) => e,
  sendButtons: vi.fn(async () => 'wamid.BTN'),
  sendDocument: vi.fn(async () => 'wamid.DOC'),
  downloadMediaAsDataUrl: vi.fn(async () => 'data:image/jpeg;base64,QUJDREVGRw=='),
  downloadMediaAsText: vi.fn(async () => null),
}));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    storage: { from: () => ({ upload: async () => ({ error: null }), createSignedUrl: async () => ({ data: null, error: { message: 'sin storage' } }) }) },
  }),
}));
vi.mock('@/lib/logger', () => ({ logger }));

const { processInbound } = await import('./processor');

const CHOFER_TEL = '5219993700779';
const GRUERO_TEL = '5299911122233';
let n = 0;
function pin(from: string) {
  return { from, type: 'location' as const, lat: 19.4326, lng: -99.1332, waMessageId: `wa-${n++}` };
}
function audio(from: string) {
  return { from, type: 'audio' as const, mediaId: 'media-a', waMessageId: `wa-${n++}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveOperador.mockResolvedValue({ tenantId: 't1', operadorId: 'o1', nombre: 'Juan' });
  resolverCuentaOficina.mockResolvedValue(null);
  sendText.mockResolvedValue('wamid.TXT');
  intakeDelta.mockResolvedValue(1);
  aceptarPorActividad.mockResolvedValue(undefined);
  enviarBriefingInicio.mockResolvedValue('enviado');
  anclarUbicacionIncidencia.mockResolvedValue(null);
  atenderMensajeProveedor.mockResolvedValue(null);
  atenderMedioProveedorSinTexto.mockResolvedValue(null);
});

describe('c4-6: el pin del chofer se ancla a su expediente vivo', () => {
  it('con viaje: el pin intenta el ancla y la confirmación dice la verdad completa', async () => {
    anclarUbicacionIncidencia.mockResolvedValue('inc-1');
    await processInbound(pin(CHOFER_TEL));
    expect(anclarUbicacionIncidencia).toHaveBeenCalledWith('t1', 'o1', 19.4326, -99.1332);
    const alChofer = sendText.mock.calls.filter((c) => c[0] === CHOFER_TEL).map((c) => String(c[1]));
    expect(alChofer.some((t) => t.includes('reporte de emergencia'))).toBe(true);
  });

  it('con viaje pero sin expediente vivo: la confirmación de siempre, sin inventar emergencia', async () => {
    anclarUbicacionIncidencia.mockResolvedValue(null);
    await processInbound(pin(CHOFER_TEL));
    const alChofer = sendText.mock.calls.filter((c) => c[0] === CHOFER_TEL).map((c) => String(c[1]));
    expect(alChofer.some((t) => t.includes('queda registrada en tu viaje'))).toBe(true);
    expect(alChofer.some((t) => t.includes('reporte de emergencia'))).toBe(false);
  });
});

describe('c4-5: el proveedor que manda audio no es "un desconocido"', () => {
  it('con gestión viva recibe el "¿me lo escribe?" y NO el "no te tengo registrado"', async () => {
    resolveOperador.mockResolvedValue(null);
    atenderMedioProveedorSinTexto.mockResolvedValue('¿Me lo escribe por texto, por favor? 🙏');
    await processInbound(audio(GRUERO_TEL));
    expect(atenderMedioProveedorSinTexto).toHaveBeenCalledWith(GRUERO_TEL, 'audio');
    const respuestas = sendText.mock.calls.map((c) => String(c[1]));
    expect(respuestas.some((t) => t.includes('¿Me lo escribe por texto'))).toBe(true);
    expect(respuestas.some((t) => t.includes('no te tengo registrado'))).toBe(false);
  });

  it('sin gestión viva sigue el camino de siempre', async () => {
    resolveOperador.mockResolvedValue(null);
    await processInbound(audio(GRUERO_TEL));
    const respuestas = sendText.mock.calls.map((c) => String(c[1]));
    expect(respuestas.some((t) => t.includes('no te tengo registrado'))).toBe(true);
  });
});
