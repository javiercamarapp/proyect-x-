import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA PROD (22-ago-2026) · RES-3 y RES-4 — el OCR caído se degradaba en
// SILENCIO.
//
// Lo que pasaba: todo fallo técnico salía como UN `logger.error` con el mismo
// mensaje y sin `status`, así que en Sentry los 25 fallos del 20-ago eran un
// solo issue que ya no notificaba. Un 402 (saldo de OpenRouter agotado) no es
// transitorio —ningún fallback lo arregla— y aun así no le avisaba a nadie:
// el OCR de WhatsApp quedaba muerto y el operador solo veía "no pude leer tu
// foto".
//
// Lo que se fija aquí:
//   1. el log lleva `status` y `codigo` como CAMPOS (Sentry agrupa por causa);
//   2. 401/402/403 → correo al operador DE INMEDIATO (credencial/saldo);
//   3. N fallos técnicos SEGUIDOS → correo 'ocr.caido'; un éxito reinicia;
//   4. un abort (nuestro presupuesto) NO cuenta como caída del proveedor y su
//      costo se marca `noMedido` en vez de reportar $0, que el tablero de
//      costo de IA leería como "esta llamada fue gratis".
// ═══════════════════════════════════════════════════════════════════════════

const generateStructured = vi.fn();
vi.mock('@/lib/llm/openrouter', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, generateStructured: (...a: unknown[]) => generateStructured(...a) };
});

const alertarOperador = vi.fn(async (_evento: string, _detalle: Record<string, unknown>) => { void _evento; void _detalle; });
vi.mock('@/lib/observability/alerta', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    alertarOperador: (e: string, d: Record<string, unknown>) => alertarOperador(e, d),
    // El vigilante REAL: lo que se prueba es que ocr.ts cuenta los seguidos,
    // no una reimplementación del contador.
  };
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger, redactarTexto: (s: string) => s, huellaId: (s: string) => s }));

// El contador de fallos seguidos es estado DE MÓDULO (por instancia, como en
// producción), así que cada prueba arranca con el módulo fresco: heredar la
// cuenta de la prueba anterior mediría cualquier cosa menos el umbral.
async function cargar() {
  vi.resetModules();
  return import('./ocr');
}
const { UMBRAL_OCR_CAIDO, codigoYStatus } = await import('./ocr');

const IMG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const bueno = {
  data: {
    concepto: 'diesel', producto: null, monto: 1000, subtotal: null, iva_monto: null,
    iva_tasa: null, litros: null, precio_unitario: null, forma_pago: 'tarjeta',
    fecha: '2026-07-27', folio: '1404755', web_id: null, estacion: null,
    rfc_emisor: null, cfdi_uuid: null, confianza: 0.95, legible: true,
  },
  raw: '{}', model: 'google/gemini-3.6-flash', tokensIn: 100, tokensOut: 200, cost: 0.01,
};

/** Un fallo del proveedor, con el status enterrado en `.cause` como lo entrega
 *  el SDK de OpenAI. */
function fallo(status: number, code?: string) {
  const causa = Object.assign(new Error('Provider returned error'), { status, code });
  return Object.assign(new Error('Falló generación estructurada'), { cause: causa });
}

beforeEach(() => {
  generateStructured.mockReset();
  alertarOperador.mockClear();
  logger.error.mockClear(); logger.warn.mockClear();
});

describe('codigoYStatus — la causa como campos, no como texto', () => {
  it('saca el status y el code de la cadena de .cause', () => {
    expect(codigoYStatus(fallo(402, 'insufficient_credits'))).toEqual({ status: 402, codigo: 'insufficient_credits' });
  });
  it('sin nada que sacar, no inventa', () => {
    expect(codigoYStatus(new Error('pum'))).toEqual({ status: undefined, codigo: undefined });
  });
});

describe('el log del fallo técnico distingue QUÉ falló', () => {
  it('lleva status y codigo como campos', async () => {
    const { extraerComprobante } = await cargar();
    generateStructured.mockImplementation(() => { throw fallo(503, 'provider_down'); });
    await extraerComprobante(IMG);
    expect(logger.error).toHaveBeenCalledWith('ocr.fallo_tecnico', expect.objectContaining({ status: 503, codigo: 'provider_down' }));
  });
});

describe('401/402/403 — no son transitorios: se avisa de inmediato', () => {
  it.each([401, 402, 403])('un %i manda correo al operador en el PRIMER fallo', async (status) => {
    const { extraerComprobante } = await cargar();
    generateStructured.mockImplementation(() => { throw fallo(status); });
    const r = await extraerComprobante(IMG);
    expect(r.motivo).toBe('fallo_tecnico');
    expect(alertarOperador).toHaveBeenCalledWith('ocr.credencial', expect.objectContaining({ status }));
  });

  it('un 503 NO usa ese canal: es transitorio y tiene fallback', async () => {
    const { extraerComprobante } = await cargar();
    generateStructured.mockImplementation(() => { throw fallo(503); });
    await extraerComprobante(IMG);
    expect(alertarOperador).not.toHaveBeenCalledWith('ocr.credencial', expect.anything());
  });
});

describe('el contador de fallos seguidos — "a veces" vs "está caído"', () => {
  it(`${UMBRAL_OCR_CAIDO} fallos seguidos avisan 'ocr.caido'; antes del umbral, no`, async () => {
    const { extraerComprobante } = await cargar();
    generateStructured.mockImplementation(() => { throw fallo(500); });
    for (let i = 0; i < UMBRAL_OCR_CAIDO - 1; i++) await extraerComprobante(IMG);
    expect(alertarOperador).not.toHaveBeenCalled();

    await extraerComprobante(IMG);
    expect(alertarOperador).toHaveBeenCalledWith('ocr.caido', expect.objectContaining({
      status: 500, fallosSeguidos: UMBRAL_OCR_CAIDO,
    }));
  });

  it('un éxito reinicia la cuenta: cuatro fallos, una foto buena, cuatro fallos → sin alerta', async () => {
    const { extraerComprobante } = await cargar();
    generateStructured.mockImplementation(() => { throw fallo(500); });
    for (let i = 0; i < UMBRAL_OCR_CAIDO - 1; i++) await extraerComprobante(IMG);

    generateStructured.mockResolvedValue(bueno);
    const ok = await extraerComprobante(IMG);
    expect(ok.legible).toBe(true);

    generateStructured.mockImplementation(() => { throw fallo(500); });
    for (let i = 0; i < UMBRAL_OCR_CAIDO - 1; i++) await extraerComprobante(IMG);
    expect(alertarOperador).not.toHaveBeenCalled();
  });
});

describe('RES-4 — un abort es NUESTRO presupuesto, no el proveedor', () => {
  it('no cuenta para el contador de caída', async () => {
    const { extraerComprobante } = await cargar();
    const ctrl = new AbortController();
    ctrl.abort();
    generateStructured.mockImplementation(() => { throw Object.assign(new Error('Request was aborted.'), { name: 'AbortError' }); });
    for (let i = 0; i < UMBRAL_OCR_CAIDO + 2; i++) await extraerComprobante(IMG, ctrl.signal);
    expect(alertarOperador).not.toHaveBeenCalled();
  });

  it('y su costo se marca `noMedido`: un 0 se leería como "esta llamada fue gratis"', async () => {
    const { extraerComprobante } = await cargar();
    const ctrl = new AbortController();
    ctrl.abort();
    generateStructured.mockImplementation(() => { throw Object.assign(new Error('Request was aborted.'), { name: 'AbortError' }); });
    const r = await extraerComprobante(IMG, ctrl.signal);
    expect(r.costo.noMedido).toBe(true);
    expect(r.costo.modelo).toBe('ocr:no_medido');
    expect(logger.warn).toHaveBeenCalledWith('ocr.costo_no_medido', expect.anything());
  });

  it('un fallo CON usage sí trae el costo real y no se marca', async () => {
    const { extraerComprobante } = await cargar();
    const { StructuredError } = await import('@/lib/llm/openrouter');
    generateStructured.mockImplementation(() => {
      throw new StructuredError('JSON parse falló', new Error('x'), '{', {
        model: 'google/gemini-3.6-flash', tokensIn: 2000, tokensOut: 10, cost: 0.013,
      });
    });
    const r = await extraerComprobante(IMG);
    expect(r.costo.costoUsd).toBe(0.013);
    expect(r.costo.noMedido).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28, REN-A2 — el freno de PRESUPUESTO (techo diario de IA de la
// flota) no es un fallo del proveedor ni de la foto.
//
// `reserveLlmBudget` corre FUERA del try que envuelve al proveedor
// (openrouter.ts:712-731), así que `LlmBudgetExceededError` llega DESNUDA al
// catch de `extraerComprobante`. Antes de este cambio caía en el resto del
// catch como cualquier `fallo_tecnico`: 'ocr.caido' al 5.º seguido y un
// reenvío que falla IDÉNTICO hasta la medianoche de México (el corte del día
// de la RPC de presupuesto).
// ═══════════════════════════════════════════════════════════════════════════
describe('RES-4 sigue vivo: un AbortError NO se confunde con presupuesto', () => {
  it('un abort sigue siendo fallo_tecnico + noMedido (no sin_presupuesto)', async () => {
    const { extraerComprobante } = await cargar();
    const ctrl = new AbortController();
    ctrl.abort();
    generateStructured.mockImplementation(() => { throw Object.assign(new Error('Request was aborted.'), { name: 'AbortError' }); });
    const r = await extraerComprobante(IMG, ctrl.signal);
    expect(r.motivo).toBe('fallo_tecnico');
    expect(r.costo.noMedido).toBe(true);
  });
});

describe('AUDITORÍA 28, REN-A2 — el techo de IA agotado NO es "OCR caído"', () => {
  it('LlmBudgetExceededError desnuda → motivo "sin_presupuesto", costo 0 SIN noMedido, y warn (no error)', async () => {
    const { extraerComprobante } = await cargar();
    const { LlmBudgetExceededError } = await import('@/lib/llm/budget');
    generateStructured.mockImplementation(() => { throw new LlmBudgetExceededError('tenant', 0.05, 5); });
    const r = await extraerComprobante(IMG);
    expect(r.legible).toBe(false);
    expect(r.motivo).toBe('sin_presupuesto');
    expect(r.costo.costoUsd).toBe(0);
    expect(r.costo.noMedido).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('ocr.sin_presupuesto', expect.objectContaining({ scope: 'tenant', requestedUsd: 0.05, limitUsd: 5 }));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('el mismo error ENVUELTO (cause) da lo mismo', async () => {
    const { extraerComprobante } = await cargar();
    const { LlmBudgetExceededError } = await import('@/lib/llm/budget');
    const envuelto = Object.assign(new Error('agent.fail'), { cause: new LlmBudgetExceededError('proposito', 0.02, 2) });
    generateStructured.mockImplementation(() => { throw envuelto; });
    const r = await extraerComprobante(IMG);
    expect(r.motivo).toBe('sin_presupuesto');
    expect(logger.warn).toHaveBeenCalledWith('ocr.sin_presupuesto', expect.objectContaining({ scope: 'proposito', requestedUsd: 0.02, limitUsd: 2 }));
  });

  it('NO cuenta como fallo del proveedor: ni vigilante.fallo, ni ocr.caido, ni ocr.credencial', async () => {
    const { extraerComprobante } = await cargar();
    const { LlmBudgetExceededError } = await import('@/lib/llm/budget');
    generateStructured.mockImplementation(() => { throw new LlmBudgetExceededError('tenant', 0.05, 5); });
    for (let i = 0; i < UMBRAL_OCR_CAIDO + 2; i++) await extraerComprobante(IMG);
    expect(alertarOperador).not.toHaveBeenCalled();
  });

  it('no acumula con fallos técnicos: tres sin_presupuesto no cuentan hacia el umbral de ocr.caido', async () => {
    const { extraerComprobante } = await cargar();
    const { LlmBudgetExceededError } = await import('@/lib/llm/budget');
    generateStructured.mockImplementation(() => { throw new LlmBudgetExceededError('tenant', 0.05, 5); });
    for (let i = 0; i < 3; i++) await extraerComprobante(IMG);
    expect(alertarOperador).not.toHaveBeenCalled();

    // El contador de fallos SEGUIDOS del proveedor sigue en cero: hacen falta
    // los UMBRAL_OCR_CAIDO fallos técnicos completos para disparar la alerta,
    // no menos porque antes hubo sin_presupuesto.
    generateStructured.mockImplementation(() => { throw fallo(503); });
    for (let i = 0; i < UMBRAL_OCR_CAIDO - 1; i++) await extraerComprobante(IMG);
    expect(alertarOperador).not.toHaveBeenCalled();
    await extraerComprobante(IMG);
    expect(alertarOperador).toHaveBeenCalledWith('ocr.caido', expect.objectContaining({ fallosSeguidos: UMBRAL_OCR_CAIDO }));
  });
});
