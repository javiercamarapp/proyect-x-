import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// El protocolo de las DOS FOTOS, medido en campo el 27-jul-2026: la foto del
// ticket completo no suelta ningún código (doblez, papel térmico, encuadre),
// pero un acercamiento al mismo código entra en ~100 ms. En vez de insistir
// sobre una sola imagen, el intake acepta varias por comprobante: los códigos
// salen de la que los tenga, el OCR corre sobre la del ticket completo, y el
// operador no tiene que etiquetar nada.
const generateStructured = vi.fn();
vi.mock('@/lib/llm/openrouter', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, generateStructured: (...a: unknown[]) => generateStructured(...a) };
});

// AUDITORÍA 25 (REND-A9) / 28 (REN-B1): `extraerComprobante` ahora reusa la
// reducida que `decodificarCodigosYReducir` calcula al buscar códigos, en vez
// de redimensionar la foto principal por separado (ver `cfdi_imagen.test.ts`
// para la prueba de ESE comportamiento con `sharp` real). Aquí se conserva la
// detección de códigos REAL (CERCA sí trae código de verdad, y varias pruebas
// de este archivo dependen de leerlo) pero se sustituye la `reducida` por el
// buffer TAL CUAL, para que las pruebas de ESTE archivo —qué foto se ELIGE
// como principal— sigan comparando por igualdad de bytes sin acoplarse a la
// codificación jpeg que produce un resize real.
vi.mock('./cfdi_imagen', async (orig) => {
  const actual = (await orig()) as typeof import('./cfdi_imagen');
  return {
    ...actual,
    decodificarCodigosYReducir: async (buf: Buffer) => {
      const { codigos } = await actual.decodificarCodigosYReducir(buf);
      return { codigos, reducida: buf };
    },
    redimensionarParaVision: async (buf: Buffer) => buf,
  };
});

const { extraerComprobante } = await import('./ocr');

// Acercamiento real al ticket de Office Depot: QR con la liga (folio y total en
// base64) + Code93 con el folio interno.
const CERCA = `data:image/jpeg;base64,${readFileSync(join(__dirname, '__fixtures__', 'ticket-codigos.jpg')).toString('base64')}`;
// 1x1 PNG: hace de "foto del ticket completo" — válida y sin ningún código.
const TICKET =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const respuesta = (over: Record<string, unknown> = {}) => ({
  data: {
    concepto: 'otro', producto: null, monto: 4000, subtotal: null, iva_monto: null,
    iva_tasa: null, litros: null, precio_unitario: null, forma_pago: 'tarjeta',
    fecha: '2026-07-25', folio: '999', web_id: null, estacion: null,
    rfc_emisor: null, cfdi_uuid: null, url_facturacion: null,
    confianza: 0.95, legible: true, ...over,
  },
  raw: '{}', model: 'google/gemini-3.6-flash', tokensIn: 100, tokensOut: 200, cost: 0.01,
});

describe('extraerComprobante — varias fotos del mismo comprobante', () => {
  beforeEach(() => { generateStructured.mockReset(); });

  it('el total del código manda sobre el que leyó el OCR', async () => {
    // El OCR dice 4000; el QR del acercamiento trae 4027.10 codificado. El del
    // código es exacto: no pasó por visión.
    generateStructured.mockResolvedValue(respuesta({ monto: 4000 }));
    const r = await extraerComprobante([TICKET, CERCA]);
    expect(r.gasto.monto).toBe(4027.1);
  });

  it('guarda el folio del portal y el código de barras que el OCR no vio', async () => {
    // Son los identificadores que la oficina teclea para timbrar. El OCR leyó el
    // mismo ticket con folios distintos en cada corrida; estos no pasaron por
    // visión, así que no bailan.
    generateStructured.mockResolvedValue(respuesta());
    const r = await extraerComprobante([TICKET, CERCA]);
    const extra = r.gasto.ocrExtra as Record<string, unknown>;
    expect(extra.folioPortal).toBe('2026072500402011000207172POSA9');
    expect(extra.codigoBarras).toBe('T1131KH1131GQH74C1QJ3');
  });

  it('el folio del QR NO pisa al impreso: son cadenas DISTINTAS', async () => {
    // Comprobado contra el ticket real (mirando el papel, no solo la corrida):
    //   impreso "ITU:"  20260725004020110000207172POSA9   (31)
    //   dentro del QR   2026072500402011000207172POSA9    (30)
    // El OCR NO se equivocó: leyó exacto lo que dice el papel. El QR carga otra
    // cadena, más corta, que es la llave del deep-link del portal.
    //
    // Por eso NO se pisa uno con otro: el impreso es el que una persona teclea
    // en el formulario, y sustituirlo por el del QR rompería justo el caso que
    // se quería arreglar. Se guardan LOS DOS, cada uno en su campo.
    generateStructured.mockResolvedValue(respuesta({ folio: '20260725004020110000207172POSA9' }));
    const r = await extraerComprobante([TICKET, CERCA]);
    expect(r.gasto.folio).toBe('20260725004020110000207172POSA9');
    expect((r.gasto.ocrExtra as Record<string, unknown>).folioPortal).toBe('2026072500402011000207172POSA9');
  });

  it('marca la discrepancia cuando el OCR y el código no dicen el mismo total', async () => {
    // El código manda (es exacto), pero que no cuadren significa que algo se
    // leyó mal —otro ticket, una propina, un renglón que el OCR se comió— y eso
    // lo tiene que ver una persona, no taparse eligiendo uno en silencio.
    generateStructured.mockResolvedValue(respuesta({ monto: 4000 }));
    const r = await extraerComprobante([TICKET, CERCA]);
    const extra = r.gasto.ocrExtra as Record<string, unknown>;
    expect(extra.montoDiscrepante).toBe(true);
    expect(extra.montoOcr).toBe(4000);
  });

  it('no marca discrepancia cuando ambos coinciden', async () => {
    generateStructured.mockResolvedValue(respuesta({ monto: 4027.1 }));
    const r = await extraerComprobante([TICKET, CERCA]);
    const extra = r.gasto.ocrExtra as Record<string, unknown>;
    expect(extra.montoDiscrepante).toBeUndefined();
  });

  it('el OCR corre UNA sola vez aunque lleguen varias fotos', async () => {
    // Cada llamada de visión se cobra. Tres fotos del mismo ticket no pueden
    // costar tres OCR: los códigos se buscan en todas (gratis), el OCR va una.
    generateStructured.mockResolvedValue(respuesta());
    await extraerComprobante([TICKET, CERCA, CERCA]);
    expect(generateStructured).toHaveBeenCalledTimes(1);
  });

  it('el OCR corre sobre la foto del ticket completo, no sobre el acercamiento', async () => {
    // El acercamiento se tomó PARA el código: casi no trae texto. Se reconoce
    // sin etiquetas porque es el que SÍ soltó código.
    //
    // El redimensionado (REND-A9, mockeado arriba como identidad) reenvuelve
    // el mismo buffer en un data-URL `image/jpeg`, así que se compara el
    // payload base64 —los bytes— y no el prefijo del mime.
    generateStructured.mockResolvedValue(respuesta());
    await extraerComprobante([CERCA, TICKET]);
    const args = generateStructured.mock.calls[0][0] as { images: string[] };
    expect(args.images).toHaveLength(1);
    expect(args.images[0].split(',')[1]).toBe(TICKET.split(',')[1]);
  });

  it('una sola foto sigue funcionando igual que antes', async () => {
    generateStructured.mockResolvedValue(respuesta({ monto: 1234.5 }));
    const r = await extraerComprobante(TICKET);
    expect(r.legible).toBe(true);
    expect(r.gasto.monto).toBe(1234.5);
  });
});

describe('extraerComprobante — el acercamiento que llega SOLO', () => {
  beforeEach(() => { generateStructured.mockReset(); });

  it('una foto que solo trae el código NO es un comprobante completo', async () => {
    // El caso peligroso del protocolo de dos fotos: en WhatsApp cada foto es su
    // propio mensaje, así que el acercamiento puede llegar suelto. Su código da
    // el total exacto — y si eso bastara para dar de alta un gasto, cuando
    // llegue la foto del ticket completo el MISMO gasto se contaría dos veces y
    // la liquidación saldría inflada. Se marca aparte para que el processor lo
    // pegue al gasto que le toca en vez de crear uno nuevo.
    generateStructured.mockResolvedValue(respuesta({ monto: null, legible: true }));
    const r = await extraerComprobante(CERCA);
    expect(r.motivo).toBe('solo_codigo');
    expect(r.legible).toBe(false);
  });

  it('conserva el total y el folio del código para poder pegarlo al gasto', async () => {
    generateStructured.mockResolvedValue(respuesta({ monto: null, legible: true }));
    const r = await extraerComprobante(CERCA);
    expect(r.gasto.monto).toBe(4027.1);
    expect((r.gasto.ocrExtra as Record<string, unknown>).folioPortal).toBe('2026072500402011000207172POSA9');
  });

  it('si el OCR SÍ leyó el ticket, no es "solo código" aunque haya código', async () => {
    // Una foto buena del ticket completo que además trae el QR legible es un
    // comprobante entero: no debe irse por el camino de enriquecimiento.
    generateStructured.mockResolvedValue(respuesta({ monto: 4027.1 }));
    const r = await extraerComprobante(CERCA);
    expect(r.motivo).toBeUndefined();
    expect(r.legible).toBe(true);
  });
});
