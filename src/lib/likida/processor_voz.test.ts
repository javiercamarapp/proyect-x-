import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// CAPA E1 — el CABLEADO de la nota de voz en el dispatcher. La unidad del
// transcriptor vive en voz_transcrita.test.ts; aquí se fija lo que importa del
// enchufe: la transcripción entra al MISMO camino que el texto (el ROJO usa el
// reconocedor REAL de léxico cerrado, sin dobles), y todo fallo de escucha
// termina en un "¿me lo escribes?" — jamás en silencio ni en adivinanza.
//
// AUDITORÍA E.28, LEG-C1 (CRÍTICO legal): la nota de voz se mandaba a
// OpenRouter (`transcribirNotaDeVoz`) ANTES de la compuerta del aviso de
// privacidad (`ponerAvisoADisposicion`, processor.ts) — el dato personal
// salía hacia un proveedor externo sin que el aviso estuviera confirmado. La
// compuerta se movió a evaluarse ANTES de transcribir; estas pruebas fijan
// que, con el aviso puesto (el caso normal, mockeado por default abajo), nada
// cambia, y que con el aviso SIN PONER, el modelo JAMÁS se llama.
// ═══════════════════════════════════════════════════════════════════════════

const resolveOperador = vi.fn();
const resolverCuentaOficina = vi.fn();
const transcribirNotaDeVoz = vi.fn();
const atenderAsistenciaChofer = vi.fn();
const sendText = vi.fn();
const getDatosResponsable = vi.fn();
const reclamarEnvioAviso = vi.fn();
const confirmarEnvioAviso = vi.fn();
const liberarEnvioAviso = vi.fn();
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

vi.mock('@/lib/agents/run', () => ({ runAgent: vi.fn() }));
vi.mock('@/lib/likida/voz_transcrita', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  transcribirNotaDeVoz: (...a: unknown[]) => transcribirNotaDeVoz(...a),
}));
// El reconocedor ROJO/ámbar es el REAL (léxico cerrado contra habla mexicana);
// solo la atención de la incidencia —que toca base y WhatsApp— se dobla.
vi.mock('@/lib/likida/asistencia_wa', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  atenderAsistenciaChofer: (...a: unknown[]) => atenderAsistenciaChofer(...a),
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
  intakeDelta: vi.fn(async () => 1),
  esperarIntake: vi.fn(async () => true),
  buscarOperadorPorTelefono: vi.fn(async () => null),
}));
vi.mock('@/lib/likida/repo', () => ({
  // El único camino que estas pruebas ejercitan de `repo` es la compuerta del
  // aviso (`ponerAvisoADisposicion`, real, definida en processor.ts). Nada
  // más de `repo` se llama: los cuatro escenarios de audio o disparan ROJO
  // (que no toca `repo`) o se cortan antes de llegar a talacha/gasto.
  getDatosResponsable: (...a: unknown[]) => getDatosResponsable(...a),
  reclamarEnvioAviso: (...a: unknown[]) => reclamarEnvioAviso(...a),
  confirmarEnvioAviso: (...a: unknown[]) => confirmarEnvioAviso(...a),
  liberarEnvioAviso: (...a: unknown[]) => liberarEnvioAviso(...a),
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
  downloadMediaAsDataUrl: vi.fn(async () => null),
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
const { RESPUESTA_NO_ENTENDI, RESPUESTA_SIN_PRESUPUESTO } = await import('./voz_transcrita');

const CHOFER_TEL = '5219993700779';
let n = 0;
function notaDeVoz() {
  return { from: CHOFER_TEL, type: 'audio' as const, mediaId: 'audio-1', waMessageId: `wa-voz-${n++}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveOperador.mockResolvedValue({ tenantId: 't1', operadorId: 'o1' });
  resolverCuentaOficina.mockResolvedValue(null);
  sendText.mockResolvedValue('wamid.TXT');
  atenderAsistenciaChofer.mockResolvedValue({ atendida: true, respuesta: 'Ya le avisé a tu jefe 🚨' });
  // Caso NORMAL: la flota YA configuró su aviso de privacidad, así que la
  // compuerta (evaluada ANTES de transcribir, auditoría E.28) deja pasar sin
  // fricción. `reclamarEnvioAviso` en `false` es el atajo "ya se le había
  // puesto antes" — el mismo que usa aviso_bloqueo.test.ts — para no exigirle
  // a este archivo simular `sendText`+`confirmarEnvioAviso` del aviso mismo.
  getDatosResponsable.mockResolvedValue({
    razonSocial: 'FLOTA SA DE CV', domicilio: 'Calle 1, Mérida', urlAvisoIntegral: 'https://flota.mx/p',
  });
  reclamarEnvioAviso.mockResolvedValue(false);
});

describe('la nota de voz del chofer (capa E1)', () => {
  it('un audio que dice "chocamos" dispara el protocolo ROJO con el reconocedor real', async () => {
    transcribirNotaDeVoz.mockResolvedValue({ ok: true, texto: 'chocamos en la carretera, hay un herido' });
    await processInbound(notaDeVoz());
    // El transcriptor recibió el tenant del chofer (el presupuesto es suyo).
    expect(transcribirNotaDeVoz).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', mediaId: 'audio-1' }));
    // La transcripción entró al MISMO camino que el texto: interpretarAsistencia
    // REAL la clasificó rojo y la atención recibió el texto transcrito.
    expect(atenderAsistenciaChofer).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1', operadorId: 'o1',
      texto: 'chocamos en la carretera, hay un herido',
    }));
    expect(sendText).toHaveBeenCalledWith(CHOFER_TEL, 'Ya le avisé a tu jefe 🚨');
  });

  it('audio ininteligible → "¿me lo escribes?" y NINGÚN protocolo disparado', async () => {
    transcribirNotaDeVoz.mockResolvedValue({ ok: false, motivo: 'ilegible' });
    await processInbound(notaDeVoz());
    expect(sendText).toHaveBeenCalledWith(CHOFER_TEL, RESPUESTA_NO_ENTENDI);
    expect(atenderAsistenciaChofer).not.toHaveBeenCalled();
  });

  it('presupuesto agotado → el mensaje honesto de presupuesto, no un regaño genérico', async () => {
    transcribirNotaDeVoz.mockResolvedValue({ ok: false, motivo: 'presupuesto' });
    await processInbound(notaDeVoz());
    expect(sendText).toHaveBeenCalledWith(CHOFER_TEL, RESPUESTA_SIN_PRESUPUESTO);
  });

  it('audio sin mediaId (webhook raro) → también "¿me lo escribes?", jamás silencio', async () => {
    await processInbound({ from: CHOFER_TEL, type: 'audio', waMessageId: `wa-voz-${n++}` });
    expect(sendText).toHaveBeenCalledWith(CHOFER_TEL, RESPUESTA_NO_ENTENDI);
    expect(transcribirNotaDeVoz).not.toHaveBeenCalled();
  });

  // ═════════════════════════════════════════════════════════════════════════
  // AUDITORÍA E.28, LEG-C1 (CRÍTICO legal) — LA COMPUERTA FIJADA PARA SIEMPRE.
  //
  // Antes de este arreglo, `transcribirNotaDeVoz` (que manda el audio del
  // chofer a OpenRouter) se llamaba SIN mirar si el aviso de privacidad ya
  // estaba a disposición del operador — el dato personal salía hacia un
  // proveedor externo antes de que la LFPDPPP art. 16-II estuviera cumplida.
  // Estas dos pruebas usan el doble de `transcribirNotaDeVoz` como testigo:
  // si el turno con aviso SIN PONER llama al modelo aunque sea una vez, la
  // aserción de abajo revienta.
  // ═════════════════════════════════════════════════════════════════════════
  describe('LEG-C1 — sin aviso de privacidad puesto, la nota de voz NUNCA llega al modelo', () => {
    it('flota sin datos del responsable (sin_datos): NO llama a OpenRouter, avisa y no libera el claim', async () => {
      getDatosResponsable.mockResolvedValue(null);
      await processInbound(notaDeVoz());
      expect(transcribirNotaDeVoz, 'sin aviso puesto, la nota de voz no debe llegar al modelo').not.toHaveBeenCalled();
      expect(atenderAsistenciaChofer).not.toHaveBeenCalled();
      expect(sendText).toHaveBeenCalledWith(CHOFER_TEL, expect.stringMatching(/aviso de privacidad/i));
      expect(logger.error).toHaveBeenCalledWith('privacidad.tratamiento_bloqueado',
        expect.objectContaining({ tenant: 't1', operador: 'o1', motivo: 'sin_datos', canal: 'audio' }));
    });

    it('fallo transitorio nuestro al poner el aviso (error): tampoco llama a OpenRouter, y el mensaje no culpa a la flota', async () => {
      getDatosResponsable.mockRejectedValue(new Error('timeout de red'));
      await processInbound(notaDeVoz());
      expect(transcribirNotaDeVoz, 'un blip nuestro tampoco autoriza mandar la nota al modelo').not.toHaveBeenCalled();
      expect(sendText).toHaveBeenCalledWith(CHOFER_TEL, expect.stringMatching(/se me trabó/i));
      expect(logger.error).toHaveBeenCalledWith('privacidad.tratamiento_bloqueado',
        expect.objectContaining({ tenant: 't1', motivo: 'error', canal: 'audio' }));
    });

    it('control: CON aviso puesto (el default de este archivo), SÍ transcribe — para que "no llama" no sea un mock roto', async () => {
      transcribirNotaDeVoz.mockResolvedValue({ ok: true, texto: 'ya llegué' });
      await processInbound(notaDeVoz());
      expect(transcribirNotaDeVoz).toHaveBeenCalled();
    });
  });
});
