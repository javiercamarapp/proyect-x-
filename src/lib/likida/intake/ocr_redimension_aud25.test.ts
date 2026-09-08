// ═══════════════════════════════════════════════════════════════════════════
// AUD25 · rendimiento BAJO línea 465 (REND-A9, REINCIDENTE) — la foto iba al
// modelo de visión a resolución NATIVA aunque el repo ya calculó (y tiró) la
// de 1600 px dos líneas antes, dentro de `decodeCodigosFromImage`. Un ticket
// de iPhone reciente (4032×3024) sube 5.3-6.7 MB de base64, reenviados hasta
// cuatro veces por la escalera de reintentos.
//
// Esta prueba usa `sharp` DE VERDAD (no mockeado) para fabricar una foto
// grande (4000×3000) y comprueba que lo que `extraerComprobante` manda al
// modelo ya viene reducido a `ANCHO_PRINCIPAL_PX` (1600), no al tamaño
// original.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';

const generateStructured = vi.fn();
vi.mock('@/lib/llm/openrouter', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, generateStructured: (...a: unknown[]) => generateStructured(...a) };
});

// AUDITORÍA 28, REN-B1: `redimensionarParaVision` mockeado para LANZAR SIEMPRE.
// Si `extraerComprobante` todavía necesitara esa función en el camino feliz
// (foto grande, sharp funcionando), las pruebas de abajo tronarían. Que sigan
// verdes demuestra que la reducida sale de `decodificarCodigosYReducir` —la
// MISMA pasada que ya se usó para buscar códigos— y no de una tercera pasada.
const redimensionarParaVision = vi.fn(async (..._a: unknown[]) => {
  throw new Error('no debería llamarse en el camino feliz: la reducida ya salió de decodificarCodigosYReducir');
});
vi.mock('./cfdi_imagen', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, redimensionarParaVision: (...a: unknown[]) => redimensionarParaVision(...a) };
});

const { extraerComprobante } = await import('./ocr');
const { ANCHO_PRINCIPAL_PX } = await import('./cfdi_imagen');

const respuesta = {
  data: {
    concepto: 'otro', producto: null, monto: 100, subtotal: null, iva_monto: null,
    iva_tasa: null, litros: null, precio_unitario: null, forma_pago: 'efectivo',
    fecha: '2026-07-25', folio: '1', web_id: null, estacion: null,
    rfc_emisor: null, cfdi_uuid: null, url_facturacion: null,
    confianza: 0.9, legible: true,
  },
  raw: '{}', model: 'google/gemini-3.6-flash', tokensIn: 100, tokensOut: 200, cost: 0.01,
};

describe('AUD25 rendimiento BAJO L465: extraerComprobante manda la foto REDIMENSIONADA, no a resolución nativa', () => {
  beforeEach(() => { generateStructured.mockReset(); generateStructured.mockResolvedValue(respuesta); redimensionarParaVision.mockClear(); });

  it('una foto de 4000×3000 llega al modelo con ancho ≤ ANCHO_PRINCIPAL_PX (1600)', async () => {
    const fotoGrandeJpeg = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).jpeg().toBuffer();
    const dataUrl = `data:image/jpeg;base64,${fotoGrandeJpeg.toString('base64')}`;

    await extraerComprobante(dataUrl);

    const args = generateStructured.mock.calls[0][0] as { images: string[] };
    const enviada = args.images[0];
    const bufEnviado = Buffer.from(enviada.split(',')[1], 'base64');
    const meta = await sharp(bufEnviado).metadata();

    expect(meta.width, 'la foto enviada al modelo sigue a resolución nativa').toBeLessThanOrEqual(ANCHO_PRINCIPAL_PX);
    // Control: la reducción es real, no un accidente de igual tamaño.
    expect(bufEnviado.length).toBeLessThan(fotoGrandeJpeg.length);
  });

  // AUDITORÍA 28, REN-B1 (reincidente): la prueba de arriba ya demuestra el
  // ancho correcto; ÉSTA demuestra CÓMO se logró. `redimensionarParaVision`
  // está mockeado para LANZAR SIEMPRE (arriba del describe): si el test de
  // arriba sigue verde es porque la reducida vino de
  // `decodificarCodigosYReducir` —la pasada de 1600 que ya corrió para buscar
  // códigos— y NO de una tercera pasada de `sharp` que aquí ni existe.
  it('la reducida sale de la decodificación de códigos, no de una tercera pasada (redimensionarParaVision NUNCA se llama en el camino feliz)', async () => {
    const fotoGrandeJpeg = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).jpeg().toBuffer();
    const dataUrl = `data:image/jpeg;base64,${fotoGrandeJpeg.toString('base64')}`;

    await extraerComprobante(dataUrl);

    expect(redimensionarParaVision).not.toHaveBeenCalled();
    const args = generateStructured.mock.calls[0][0] as { images: string[] };
    const bufEnviado = Buffer.from(args.images[0].split(',')[1], 'base64');
    const meta = await sharp(bufEnviado).metadata();
    expect(meta.width).toBeLessThanOrEqual(ANCHO_PRINCIPAL_PX);
  });

  it('si el redimensionado falla, se manda la foto ORIGINAL — nunca se pierde por un problema de sharp', async () => {
    const dataUrlRota = 'data:image/jpeg;base64,no-es-una-imagen-de-verdad';
    await extraerComprobante(dataUrlRota);
    const args = generateStructured.mock.calls[0][0] as { images: string[] };
    expect(args.images).toEqual([dataUrlRota]);
  });
});
