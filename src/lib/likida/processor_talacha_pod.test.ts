import { describe, it, expect, vi, beforeEach } from 'vitest';

const gastoHoyUsd = 0;
vi.mock('@/app/api/dashboard/chat/tope', () => ({
  gastoChatHoyUsd: async () => gastoHoyUsd,
  topeDiaUsd: () => 5,
}));
vi.mock('@/lib/likida/costos', () => ({
  registrarCosto: async () => {},
  faseDeModelo: () => 'chat',
}));

// ═══════════════════════════════════════════════════════════════════════════
// El CABLEADO de F4 en el dispatcher — lo que las unidades no pueden probar:
//
//   · el caption "carta porte" saca la foto del camino de comprobantes (ni
//     visión ni gasto ni barrera) y la manda al POD;
//   · el caption de talacha deja que el gasto ENTRE por el camino normal y
//     después abre la solicitud con el gasto y la evidencia enlazados;
//   · en la oficina, la decisión de talacha corre ANTES que el despacho, y
//     el informe DESPUÉS — el orden es el contrato;
//   · el número desconocido sigue recibiendo su "no te tengo registrado".
// ═══════════════════════════════════════════════════════════════════════════

const runAgent = vi.fn();
const resolveOperador = vi.fn();
const resolverCuentaOficina = vi.fn();
const atenderTalachaChofer = vi.fn();
const atenderAutorizacionTalacha = vi.fn();
const atenderDespachoOficina = vi.fn();
const atenderAsignacionOficina = vi.fn();
const atenderInformeOficina = vi.fn();
const guardarPodDelChofer = vi.fn();
const extraerComprobante = vi.fn();
const subirComprobante = vi.fn();
const decidirFoto = vi.fn();
const addGasto = vi.fn();
const intakeDelta = vi.fn();
const sendText = vi.fn();
const sendButtons = vi.fn();
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

vi.mock('@/lib/agents/run', () => ({ runAgent: (...a: unknown[]) => runAgent(...a) }));
vi.mock('@/lib/likida/talacha_wa', async (original) => ({
  // El matcher es el REAL: lo mockeado es el efecto (DB + jefe).
  ...(await original<Record<string, unknown>>()),
  atenderTalachaChofer: (...a: unknown[]) => atenderTalachaChofer(...a),
  atenderAutorizacionTalacha: (...a: unknown[]) => atenderAutorizacionTalacha(...a),
}));
vi.mock('@/lib/likida/pod_wa', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  guardarPodDelChofer: (...a: unknown[]) => guardarPodDelChofer(...a),
}));
vi.mock('@/lib/likida/despacho_wa', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  atenderDespachoOficina: (...a: unknown[]) => atenderDespachoOficina(...a),
}));
vi.mock('@/lib/likida/asignar_wa', () => ({
  atenderAsignacionOficina: (...a: unknown[]) => atenderAsignacionOficina(...a),
}));
vi.mock('@/lib/likida/informes_wa', () => ({
  atenderInformeOficina: (...a: unknown[]) => atenderInformeOficina(...a),
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
  buscarTenantPorTelefono: vi.fn(async () => null),
}));
vi.mock('@/lib/likida/confirmar_viaje', () => ({
  atenderConfirmacion: vi.fn(async () => ({ mensaje: null, estado: 'nada' })),
  aceptarPorActividad: vi.fn(),
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
  sendButtons: (...a: unknown[]) => sendButtons(...a),
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
const OFICINA_TEL = '5215550000001';
const CUENTA = { userId: 'u-jefe', tenantId: 't1', rol: 'flota_admin', nombre: 'Rodrigo', email: 'j@x.mx' };

let n = 0;
function texto(from: string, t: string) {
  return { from, type: 'text' as const, text: t, waMessageId: `wa-${n++}` };
}
function foto(from: string, caption?: string) {
  return { from, type: 'image' as const, mediaId: 'media-1', text: caption, waMessageId: `wa-${n++}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveOperador.mockResolvedValue({ tenantId: 't1', operadorId: 'o1' });
  resolverCuentaOficina.mockResolvedValue(null);
  sendText.mockResolvedValue('wamid.TXT');
  sendButtons.mockResolvedValue('wamid.BTN');
  intakeDelta.mockResolvedValue(1);
  subirComprobante.mockResolvedValue('comprobantes/t1/v1/x.jpg');
  extraerComprobante.mockResolvedValue({
    legible: true,
    gasto: { id: 'g-ocr', concepto: 'otro', monto: 950, ocrConfianza: 0.9 },
    costo: { modelo: 'vision', tokensIn: 10, tokensOut: 5, costoUsd: 0.001 },
  });
  decidirFoto.mockReturnValue({ accion: 'registrar' });
  atenderTalachaChofer.mockResolvedValue('TALACHA_ANOTADA');
  atenderAutorizacionTalacha.mockResolvedValue(null);
  atenderDespachoOficina.mockResolvedValue(null);
  atenderAsignacionOficina.mockResolvedValue(null);
  atenderInformeOficina.mockResolvedValue(null);
  guardarPodDelChofer.mockResolvedValue('subido');
});

describe('el chofer — talacha por texto', () => {
  it('"se me ponchó una llanta, son 800" abre el circuito y NO corre el agente', async () => {
    await processInbound(texto(CHOFER_TEL, 'se me ponchó una llanta, la talacha son 800'));
    expect(atenderTalachaChofer).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1', viajeId: 'v1', operadorId: 'o1', monto: 800,
    }));
    expect(sendText.mock.calls.some((c) => String(c[1]).includes('TALACHA_ANOTADA'))).toBe(true);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('"ya llegué" sigue siendo un hito, no una talacha (la frontera vive)', async () => {
    await processInbound(texto(CHOFER_TEL, 'ya llegué'));
    expect(atenderTalachaChofer).not.toHaveBeenCalled();
  });
});

describe('el chofer — la foto con caption', () => {
  it('caption "carta porte sellada": va al POD, sin visión, sin gasto y sin barrera', async () => {
    await processInbound(foto(CHOFER_TEL, 'aquí la carta porte sellada'));
    expect(guardarPodDelChofer).toHaveBeenCalledWith('t1', 'v1', 'o1', 'comprobantes/t1/v1/x.jpg');
    expect(extraerComprobante).not.toHaveBeenCalled();   // la carta porte no paga visión
    expect(addGasto).not.toHaveBeenCalled();             // y no es un gasto
    expect(intakeDelta).not.toHaveBeenCalled();          // el "listo" no la espera
    expect(sendText.mock.calls.some((c) => String(c[1]).includes('carta porte sellada ✅'))).toBe(true);
  });

  it('caption de talacha: el gasto ENTRA por el camino normal y la solicitud sale con gasto+evidencia enlazados', async () => {
    await processInbound(foto(CHOFER_TEL, 'talacha, son 800'));
    expect(addGasto).toHaveBeenCalled();                 // la nota SÍ es un comprobante
    expect(atenderTalachaChofer).toHaveBeenCalledWith(expect.objectContaining({
      gastoId: 'g-ocr',
      evidenciaPath: 'comprobantes/t1/v1/x.jpg',
      monto: 800,                                        // el caption manda sobre el OCR (950)
    }));
    // La barrera se respeta: +1 al entrar, -1 al salir.
    expect(intakeDelta).toHaveBeenCalledWith('v1', 1);
    expect(intakeDelta).toHaveBeenCalledWith('v1', -1);
  });

  it('una foto sin caption sigue el camino de comprobante de siempre', async () => {
    await processInbound(foto(CHOFER_TEL));
    expect(addGasto).toHaveBeenCalled();
    expect(guardarPodDelChofer).not.toHaveBeenCalled();
    expect(atenderTalachaChofer).not.toHaveBeenCalled();
  });
});

describe('la oficina — identidad y orden de los atajos', () => {
  beforeEach(() => {
    resolveOperador.mockResolvedValue(null);
    resolverCuentaOficina.mockResolvedValue(CUENTA);
  });

  it('la decisión de talacha corre ANTES que el despacho', async () => {
    atenderAutorizacionTalacha.mockResolvedValue('DECIDIDA ✅');
    await processInbound(texto(OFICINA_TEL, 'tal_si:11111111-2222-3333-4444-555555555555'));
    expect(atenderAutorizacionTalacha).toHaveBeenCalledWith(
      { tenantId: 't1', rol: 'flota_admin', userId: 'u-jefe' },
      'tal_si:11111111-2222-3333-4444-555555555555',
    );
    expect(atenderDespachoOficina).not.toHaveBeenCalled();
    expect(sendText.mock.calls.some((c) => String(c[1]).includes('DECIDIDA'))).toBe(true);
  });

  it('el despacho sigue vivo y la asignación corre después de él', async () => {
    atenderAsignacionOficina.mockResolvedValue('ASIGNACION_PROPUESTA');
    await processInbound(texto(OFICINA_TEL, 'asígnale la unidad 12 al viaje de Juan'));
    expect(atenderDespachoOficina).toHaveBeenCalled();
    expect(atenderAsignacionOficina).toHaveBeenCalled();
    expect(sendText.mock.calls.some((c) => String(c[1]).includes('ASIGNACION_PROPUESTA'))).toBe(true);
  });

  it('"¿cómo van?" llega al informe cuando nadie más lo tomó', async () => {
    atenderInformeOficina.mockResolvedValue('INFORME 📊');
    await processInbound(texto(OFICINA_TEL, '¿cómo van?'));
    expect(atenderInformeOficina).toHaveBeenCalledWith({ tenantId: 't1', rol: 'flota_admin' }, '¿cómo van?');
    expect(sendText.mock.calls.some((c) => String(c[1]).includes('INFORME'))).toBe(true);
  });

  it('lo que ningún atajo toma cae al saludo — que ahora ofrece lo nuevo', async () => {
    await processInbound(texto(OFICINA_TEL, 'buenas tardes'));
    const saludo = String(sendText.mock.calls.at(-1)?.[1] ?? '');
    expect(saludo).toContain('te reconozco');
    expect(saludo).toContain('asígnale la unidad 12');
    expect(saludo).toContain('¿cómo van?');
  });

  it('el contador NO recibe la promesa de despachar en el saludo', async () => {
    resolverCuentaOficina.mockResolvedValue({ ...CUENTA, rol: 'contador' });
    await processInbound(texto(OFICINA_TEL, 'buenas tardes'));
    const saludo = String(sendText.mock.calls.at(-1)?.[1] ?? '');
    expect(saludo).not.toContain('despacharme viajes');
    expect(saludo).toContain('¿cómo van?');   // el informe sí es suyo (dinero)
  });

  it('el número desconocido sigue fallando cerrado', async () => {
    resolverCuentaOficina.mockResolvedValue(null);
    await processInbound(texto('5210000000000', 'hola'));
    const r = String(sendText.mock.calls.at(-1)?.[1] ?? '');
    expect(r).toContain('no te tengo registrado');
    expect(atenderDespachoOficina).not.toHaveBeenCalled();
    expect(atenderInformeOficina).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 18, ALTO (A10): una solicitud ARCO se perdía sin registro cuando
// a la flota le faltaba la razón social — el insert vivía dentro del `if`
// que decide el TEXTO de la respuesta.
// ═══════════════════════════════════════════════════════════════════════════
describe('ARCO sin datos del responsable', () => {
  it('la solicitud queda REGISTRADA aunque la flota no tenga razón social', async () => {
    const repo = await import('@/lib/likida/repo');
    const conv = await import('@/lib/likida/conv');
    vi.spyOn(conv, 'buscarOperadorPorTelefono').mockResolvedValue({ tenantId: 't1', operadorId: 'op1' });
    vi.mocked(repo.getDatosResponsable).mockResolvedValueOnce(null);
    vi.mocked(repo.registrarSolicitudArco).mockClear();
    await processInbound({ from: '5219993700779', type: 'text', text: 'quiero ejercer mis derechos ARCO y que borren mis datos', waMessageId: 'wa-arco' });
    expect(repo.registrarSolicitudArco).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', operadorId: 'op1', titularRef: '5219993700779', canal: 'whatsapp' }));
    // Y se le dice que quedó registrada, no solo "déjame checarlo".
    expect(sendText.mock.calls.some((c) => String(c[1]).includes('quedó registrada'))).toBe(true);
  });

  it('AUDITORÍA 28, LEG-C1: la oposición por esta ruta ya lleva el operadorId real, no null fijo', async () => {
    // Antes: esta ruta (operador resuelto solo por `buscarTenantPorTelefono`,
    // sin id) pasaba `operadorId: null` fijo a `atenderPrivacidad`, así que
    // "me opongo" nunca podía actualizar `operador.oposicion_automatizada`
    // para quien llegara por aquí — justo la población más probable de
    // ejercerla (operador dado de baja). El escritor real de
    // `oposicion_automatizada` ya tiene su propia cobertura de DB; aquí solo
    // se prueba que `operadorId` deja de ser null fijo en esta ruta.
    const repo = await import('@/lib/likida/repo');
    const conv = await import('@/lib/likida/conv');
    vi.spyOn(conv, 'buscarOperadorPorTelefono').mockResolvedValue({ tenantId: 't1', operadorId: 'op-baja' });
    vi.mocked(repo.getDatosResponsable).mockResolvedValueOnce(null);
    vi.mocked(repo.registrarSolicitudArco).mockClear();
    await processInbound({ from: '5219993700780', type: 'text', text: 'me opongo a que sigan usando mis datos', waMessageId: 'wa-oposicion' });
    expect(repo.registrarSolicitudArco).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', operadorId: 'op-baja', tipo: 'oposicion' }));
  });
});
