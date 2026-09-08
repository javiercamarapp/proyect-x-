// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28, LEG-A4 [ALTO, reincidente desde la 26] — `ponerAvisoADisposicion`
// tiene que reclamar y confirmar con la firma VIGENTE (`versionAvisoVigente`,
// que cubre simplificado + integral), no con `versionAviso(texto)` a secas
// (que solo cubre el simplificado y por eso nunca vio cambiar el integral —
// el caso real: #401/LEG-B1 cambió el plazo de borrado de cámara del integral
// y ningún operador con constancia recibió el reenvío).
//
// Archivo hermano de `aviso_blip_de_red.test.ts`: mismos mocks de
// `getDatosResponsable`/`reclamarEnvioAviso`/`confirmarEnvioAviso`/`sendText`,
// pero llama `ponerAvisoADisposicion` directo en vez de pasar por
// `processInbound` — lo que se prueba aquí es la FIRMA que reciben las dos
// RPC, no el enrutamiento del mensaje entrante.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDatosResponsable = vi.fn();
const reclamarEnvioAviso = vi.fn();
const confirmarEnvioAviso = vi.fn();
const liberarEnvioAviso = vi.fn();
const sendText = vi.fn(async (_to: string, _t: string) => 'wamid.1');

vi.mock('@/lib/likida/tools', () => ({}));
vi.mock('@/lib/meta/client', () => ({
  MAX_CUERPO_BOTONES: 1024,
  sendText: (...a: unknown[]) => sendText(...(a as [string, string])),
  sendButtons: vi.fn(), sendDocument: vi.fn(),
  downloadMediaAsDataUrl: vi.fn(async () => 'data:image/jpeg;base64,AAAA'),
  downloadMediaAsText: vi.fn(),
}));
vi.mock('@/lib/likida/repo', () => ({
  getDatosResponsable: (...a: unknown[]) => getDatosResponsable(...a),
  reclamarEnvioAviso: (...a: unknown[]) => reclamarEnvioAviso(...a),
  confirmarEnvioAviso: (...a: unknown[]) => confirmarEnvioAviso(...a),
  liberarEnvioAviso: (...a: unknown[]) => liberarEnvioAviso(...a),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { ponerAvisoADisposicion } = await import('./processor');
const { avisoSimplificado, versionAviso, versionAvisoVigente } = await import('./privacidad');

const RESPONSABLE = {
  razonSocial: 'Transportes del Norte SA de CV',
  domicilio: 'Av. Vallarta 1234, Guadalajara',
  urlAvisoIntegral: 'https://ejemplo.mx/aviso',
  contactoPrivacidad: 'Depto. de Datos Personales, datos@transportesdelnorte.mx',
};

beforeEach(() => {
  getDatosResponsable.mockReset(); reclamarEnvioAviso.mockReset();
  confirmarEnvioAviso.mockReset(); liberarEnvioAviso.mockReset(); sendText.mockClear();
  getDatosResponsable.mockResolvedValue(RESPONSABLE);
  reclamarEnvioAviso.mockResolvedValue(true);
});

describe('ponerAvisoADisposicion reclama y confirma con la firma VIGENTE (LEG-A4)', () => {
  it('reclamarEnvioAviso recibe versionAvisoVigente(datos).version, NO versionAviso(avisoSimplificado(datos))', async () => {
    const vigente = versionAvisoVigente(RESPONSABLE)!;
    const soloSimplificado = versionAviso(avisoSimplificado(RESPONSABLE)!);
    // Los dos hash YA difieren aquí (el vigente cubre más texto: simplificado
    // + integral serializado) — la prueba real de que se cerró el hueco no es
    // que los números sean iguales o distintos en un caso suelto, sino que la
    // llamada real use `versionAvisoVigente`, verificado abajo con
    // `toHaveBeenCalledWith`. El caso que SÍ aísla el hueco (un dato que solo
    // vive en el integral) está más abajo, en su propio test.
    expect(soloSimplificado).not.toBe(vigente.version);

    await ponerAvisoADisposicion('t1', 'o1', '5219993700779');

    expect(reclamarEnvioAviso).toHaveBeenCalledWith('t1', 'o1', vigente.version);
  });

  it('confirmarEnvioAviso recibe la MISMA versión que reclamarEnvioAviso', async () => {
    await ponerAvisoADisposicion('t1', 'o1', '5219993700779');
    const versionReclamada = reclamarEnvioAviso.mock.calls[0][2];
    const versionConfirmada = confirmarEnvioAviso.mock.calls[0][2];
    expect(versionConfirmada).toBe(versionReclamada);
  });

  it('sendText recibe el texto SIMPLIFICADO (lo que de verdad sale por WhatsApp)', async () => {
    await ponerAvisoADisposicion('t1', 'o1', '5219993700779');
    expect(sendText).toHaveBeenCalledWith('5219993700779', avisoSimplificado(RESPONSABLE));
  });

  // ESTE ES EL CASO QUE DEMUESTRA EL HUECO CERRADO: un dato que solo vive en
  // el integral (contactoPrivacidad, art. 29) cambia la versión reclamada,
  // aunque el texto que sale por WhatsApp (el simplificado) sea IDÉNTICO.
  it('un cambio SOLO en el integral (contactoPrivacidad) mueve la versión reclamada', async () => {
    await ponerAvisoADisposicion('t1', 'o1', '5219993700779');
    const versionAntes = reclamarEnvioAviso.mock.calls[0][2];
    const textoAntes = sendText.mock.calls[0][1];

    reclamarEnvioAviso.mockClear(); sendText.mockClear();
    getDatosResponsable.mockResolvedValue({ ...RESPONSABLE, contactoPrivacidad: 'Otro contacto, otro@correo.mx' });
    await ponerAvisoADisposicion('t1', 'o1', '5219993700779');
    const versionDespues = reclamarEnvioAviso.mock.calls[0][2];
    const textoDespues = sendText.mock.calls[0][1];

    expect(textoDespues, 'el simplificado no declara el contacto: el texto que sale no cambia').toBe(textoAntes);
    expect(versionDespues, 'pero la firma vigente SÍ tiene que moverse').not.toBe(versionAntes);
  });

  it('sin razón social/domicilio, sigue devolviendo "sin_datos" sin llamar a reclamarEnvioAviso', async () => {
    getDatosResponsable.mockResolvedValue({ ...RESPONSABLE, razonSocial: '' });
    const r = await ponerAvisoADisposicion('t1', 'o1', '5219993700779');
    expect(r).toBe('sin_datos');
    expect(reclamarEnvioAviso).not.toHaveBeenCalled();
  });
});
