import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA FABLE CICLO 3 (c3-2) — el briefing y la aceptación POR ACTIVIDAD.
//
// El chofer que ignora la pregunta de confirmación y manda su primera foto
// acepta el viaje por actividad ("una foto es una aceptación más fuerte que un
// va") — y su mensaje ACABA de abrir la ventana de 24 h. Antes de este cableado
// el reintento del briefing solo vivía en `atenderConfirmacion`, así que para
// ese chofer el briefing fallido del despacho no se reintentaba jamás: salía a
// carretera sin avisos de papeles ni teléfonos verificados, permanentemente.
//
// Lo que estas pruebas fijan es el CABLEADO en el dispatcher (la unidad de
// `enviarBriefingInicio` ya prueba el sello): la foto que acepta dispara el
// briefing, y un briefing que truena no rompe el camino del comprobante.
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
let n = 0;
function foto(from: string, caption?: string) {
  return { from, type: 'image' as const, mediaId: 'media-1', text: caption, waMessageId: `wa-${n++}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveOperador.mockResolvedValue({ tenantId: 't1', operadorId: 'o1' });
  resolverCuentaOficina.mockResolvedValue(null);
  sendText.mockResolvedValue('wamid.TXT');
  intakeDelta.mockResolvedValue(1);
  subirComprobante.mockResolvedValue('comprobantes/t1/v1/x.jpg');
  extraerComprobante.mockResolvedValue({
    legible: true,
    gasto: { id: 'g-ocr', concepto: 'otro', monto: 950, ocrConfianza: 0.9 },
    costo: { modelo: 'vision', tokensIn: 10, tokensOut: 5, costoUsd: 0.001 },
  });
  decidirFoto.mockReturnValue({ accion: 'registrar' });
  aceptarPorActividad.mockResolvedValue(undefined);
  enviarBriefingInicio.mockResolvedValue('enviado');
});

describe('el briefing en la aceptación por actividad (c3-2)', () => {
  it('la primera foto del chofer dispara el briefing del viaje que aceptó', async () => {
    await processInbound(foto(CHOFER_TEL));
    expect(aceptarPorActividad).toHaveBeenCalledWith('t1', 'v1', 'o1');
    expect(enviarBriefingInicio).toHaveBeenCalledWith('t1', 'v1');
  });

  it('un briefing que truena NO rompe el camino del comprobante — se anota y sigue', async () => {
    enviarBriefingInicio.mockRejectedValue(new Error('meta caída'));
    await processInbound(foto(CHOFER_TEL));
    expect(addGasto).toHaveBeenCalled();          // el comprobante entró igual
    expect(logger.warn).toHaveBeenCalledWith('briefing.actividad_fallo', expect.objectContaining({ viaje: 'v1' }));
  });
});
