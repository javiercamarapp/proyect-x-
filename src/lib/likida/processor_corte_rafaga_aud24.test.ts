import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24 · AGEN-A2 / BE-2 (ALTO, 2ª ronda) — `cerrarRafagasPorCorte()`
// cerraba y BORRABA la libreta de TODOS los choferes del proceso.
//
// Pool de 5 cadenas con reloj compartido (webhook y drenado). La cadena del
// chofer B se queda sin reloj (`sin_tiempo`); el bucle tomaba la bandeja del
// chofer A (4 fotos vistas, 2 ilegibles, OCR de la 4ª en vuelo), la borraba y
// le mandaba «De tus 4 fotos, 2 no las pude leer». Cuando la 4ª de A
// terminaba, `anotarIncidencia` recreaba la bandeja en cero y el cierre real
// le mandaba OTRO resumen «De tus 2 fotos…». Ninguna cifra era verdad, y la
// regla del canal del chofer es no inventar una.
//
// Lo que se fija: el corte cierra SOLO la libreta del teléfono del mensaje que
// se quedó sin presupuesto; la del otro chofer conserva sus `vistas`.
// ═══════════════════════════════════════════════════════════════════════════

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger }));
vi.mock('@/lib/agents/run', () => ({ runAgent: vi.fn() }));

// AG-B1 (auditoría 28, agentico.md:38): el corte por falta de reloj registra
// el costo del WhatsApp con el tenant de la bandeja. Este archivo NO mockeaba
// `@/lib/likida/costos`: sin el mock, un `registrarCostoWhatsApp` con tenant
// real intentaría tocar la base de verdad.
const registrarCostoWhatsApp = vi.fn();
vi.mock('@/lib/likida/costos', () => ({
  registrarCosto: vi.fn(), registrarCostoWhatsApp: (...a: unknown[]) => registrarCostoWhatsApp(...a),
  faseDeModelo: vi.fn(() => 'cuadre'), vincularCostosALiquidacion: vi.fn(),
}));

const salientes: { to: string; body: string }[] = [];
const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
  const b = JSON.parse(String(init?.body ?? '{}')) as { to: string; text?: { body: string } };
  salientes.push({ to: b.to, body: b.text?.body ?? '' });
  return new Response(JSON.stringify({ messages: [{ id: 'wamid.TEST' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
});

const { processInbound } = await import('./processor');
const rafaga = await import('./intake/rafaga');

const TEL_A = '5219991110001';
const TEL_B = '5219992220002';
const fotoDeB = { from: TEL_B, type: 'image' as const, mediaId: 'm-b-5', waMessageId: 'wa-b-5' };
/** La invocación arrancó hace 118 s: quedan 2 de 120 → `sin_tiempo`. */
const sinReloj = { inicioInvocacionMs: Date.now() - 118_000 };

beforeEach(() => {
  salientes.length = 0;
  logger.info.mockReset(); logger.warn.mockReset(); logger.error.mockReset();
  registrarCostoWhatsApp.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
  fetchSpy.mockClear();
  process.env.WHATSAPP_ACCESS_TOKEN = 'tok-de-prueba';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
  // Libretas limpias: son estado de módulo.
  for (const { viajeId } of rafaga.bandejasAbiertas()) rafaga.cerrarRafaga(viajeId);
});

describe('AGEN-A2 — el corte por falta de reloj cierra SOLO la libreta del chofer del mensaje', () => {
  it('la libreta del chofer A (en vuelo en otra cadena) conserva sus vistas; solo B recibe su resumen', async () => {
    // Chofer A: 4 fotos vistas, 2 ilegibles, la 4ª todavía en OCR en OTRA cadena.
    rafaga.anotarFoto('V-A', true, TEL_A);
    rafaga.anotarFoto('V-A', false, TEL_A);
    rafaga.anotarFoto('V-A', false, TEL_A);
    rafaga.anotarFoto('V-A', false, TEL_A);
    rafaga.anotarIncidencia('V-A', { tipo: 'ilegible' });
    rafaga.anotarIncidencia('V-A', { tipo: 'ilegible' });
    // Chofer B: 2 fotos vistas, 1 se trabó de nuestro lado; su 3ª ya no cabe.
    rafaga.anotarFoto('V-B', true, TEL_B);
    rafaga.anotarFoto('V-B', false, TEL_B);
    rafaga.anotarIncidencia('V-B', { tipo: 'fallo_tecnico' });

    expect(await processInbound(fotoDeB, sinReloj)).toBe('sin_tiempo');

    // A sigue viva, con sus 4 vistas y sus 2 incidencias.
    const abiertas = rafaga.bandejasAbiertas();
    expect(abiertas.map((b) => b.viajeId)).toEqual(['V-A']);
    const a = rafaga.cerrarRafaga('V-A');
    expect(a.vistas).toBe(4);
    expect(a.incidencias).toHaveLength(2);

    // Solo B recibió un mensaje, y con SU cuenta.
    expect(salientes.map((s) => s.to)).toEqual([expect.stringContaining('9992220002')]);
    expect(salientes[0].body).toContain('De las fotos que me mandaste,');
    expect(salientes.some((s) => s.to.includes('9991110001')), 'le escribió al chofer A').toBe(false);
  });

  it('sin libreta del teléfono del mensaje, el corte no habla con nadie', async () => {
    rafaga.anotarFoto('V-A', true, TEL_A);
    rafaga.anotarIncidencia('V-A', { tipo: 'ilegible' });
    expect(await processInbound(fotoDeB, sinReloj)).toBe('sin_tiempo');
    expect(salientes).toHaveLength(0);
    expect(rafaga.bandejasAbiertas().map((b) => b.viajeId)).toEqual(['V-A']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28 · AG-B1 (BAJO, 5ª ronda, agentico.md:38) — `cerrarRafagasPorCorte`
// mandaba el resumen con `sendText` directo, sin `registrarCostoWhatsApp`. La
// bandeja ahora guarda el `tenantId` (aditivo, junto al teléfono) y el corte
// lo usa para no dejar ese mensaje fuera del costo por flota/viaje.
// ═══════════════════════════════════════════════════════════════════════════
describe('AG-B1 — el corte registra el costo de WhatsApp con el tenant de la bandeja', () => {
  it('registrarCostoWhatsApp se llama con el tenant y el viaje de la bandeja que cerró', async () => {
    rafaga.anotarFoto('V-B', true, TEL_B, 't-b');
    rafaga.anotarIncidencia('V-B', { tipo: 'fallo_tecnico' });

    expect(await processInbound(fotoDeB, sinReloj)).toBe('sin_tiempo');

    expect(salientes).toHaveLength(1);
    expect(registrarCostoWhatsApp).toHaveBeenCalledTimes(1);
    expect(registrarCostoWhatsApp).toHaveBeenCalledWith('t-b', 'V-B');
  });

  it('sin tenantId en la bandeja (llamador viejo), NO se registra costo — pero el mensaje sí sale', async () => {
    // Mismo caso que las pruebas de arriba: `anotarFoto` sin el 4º argumento.
    rafaga.anotarFoto('V-B', true, TEL_B);
    rafaga.anotarIncidencia('V-B', { tipo: 'fallo_tecnico' });

    expect(await processInbound(fotoDeB, sinReloj)).toBe('sin_tiempo');

    expect(salientes).toHaveLength(1);
    expect(registrarCostoWhatsApp).not.toHaveBeenCalled();
  });
});
