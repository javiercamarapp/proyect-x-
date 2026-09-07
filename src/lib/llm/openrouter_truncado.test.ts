import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// Regresión del bug encontrado con comprobantes REALES (27-jul-2026): la
// respuesta se cortaba en max_tokens y el ticket se reportaba como "foto
// ilegible". Se mockea el SDK de OpenAI para controlar finish_reason.
const create = vi.fn();
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: (...a: unknown[]) => create(...a) } };
  },
}));

process.env.OPENROUTER_API_KEY = 'test-key';
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const { generateStructured, generateResponse, TruncatedError } = await import('./openrouter');

const schema = z.object({ monto: z.number() });
const ok = (content: string) => ({
  choices: [{ finish_reason: 'stop', message: { content } }],
  usage: { prompt_tokens: 100, completion_tokens: 50 },
  model: 'google/gemini-3.6-flash',
});
const truncada = () => ({
  // Así se ve de verdad: JSON abierto a media línea, cortado por presupuesto.
  choices: [{ finish_reason: 'length', message: { content: '{\n  "monto": 1000.00' } }],
  usage: { prompt_tokens: 100, completion_tokens: 1184 },
  model: 'google/gemini-3.6-flash',
});

const llamar = () =>
  generateStructured({
    role: 'ocr',
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
    schema,
    schemaName: 'x',
  });

describe('generateStructured — respuesta truncada', () => {
  // Con llaves: si devuelve el mock, vitest lo usa como limpieza y lo invoca.
  beforeEach(() => { create.mockReset(); });

  it('finish_reason=length NO se reporta como JSON malformado', async () => {
    create.mockResolvedValue(truncada());
    await expect(llamar()).rejects.toBeInstanceOf(TruncatedError);
    await expect(llamar()).rejects.toThrow(/truncada/i);
  });

  it('reintenta con el DOBLE de presupuesto en vez de regañar al modelo', async () => {
    create.mockResolvedValueOnce(truncada()).mockResolvedValueOnce(ok('{"monto":507.65}'));
    const r = await llamar();
    expect(r.data.monto).toBe(507.65);
    expect(create).toHaveBeenCalledTimes(2);
    const tope1 = create.mock.calls[0][0].max_tokens;
    const tope2 = create.mock.calls[1][0].max_tokens;
    expect(tope2).toBe(tope1 * 2);
    // El reintento por truncamiento NO lleva la nota de "responde solo JSON":
    // el modelo ya obedecía, lo que le faltó fue techo.
    expect(create.mock.calls[1][0].messages[0].content).toBe('s');
  });

  it('si el doble tampoco alcanza, falla como truncamiento (no como formato)', async () => {
    create.mockResolvedValue(truncada());
    await expect(llamar()).rejects.toBeInstanceOf(TruncatedError);
    expect(create).toHaveBeenCalledTimes(2); // no sigue por la escalera de formato
  });

  it('el error carga el consumo: una llamada fallida SÍ se cobró', async () => {
    create.mockResolvedValue(truncada());
    let e: unknown;
    try { await llamar(); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(TruncatedError);
    const err = e as InstanceType<typeof TruncatedError>;
    // ACUMULADO de los dos intentos (el original y el del doble de presupuesto),
    // no solo el último: las dos llamadas se cobraron. Antes reportaba 1184 —el
    // del segundo— y descontaba de menos justo en el caso más caro.
    expect(create).toHaveBeenCalledTimes(2);
    expect(err.usage?.tokensOut).toBe(1184 * 2);
    expect(err.usage?.cost).toBeGreaterThan(0);
  });

  it('un JSON de verdad malformado sigue yendo por la escalera de formato', async () => {
    create.mockResolvedValue({
      choices: [{ finish_reason: 'stop', message: { content: 'no soy json' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      model: 'google/gemini-3.6-flash',
    });
    await expect(llamar()).rejects.toThrow(/JSON parse/);
    // primario + reintento con nota + fallback cross-provider
    expect(create.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28, TC-A3 — el mismo bug, pero en `generateResponse`.
//
// `generateStructured` y `generateWithTools` ya distinguían `finish_reason:
// 'length'` con `TruncatedError`; `generateResponse` (el chat simple, sin
// schema) no lo miraba: devolvía el texto cortado como si fuera la respuesta
// completa. En el flujo de entrevista fiscal (`entrevista-agente.ts`) eso es
// un texto a medio artículo presentado como una explicación entera de la
// norma — justo lo que la regla de "no inventar" del repo prohíbe, y su
// catch YA sabía caer a un mensaje seguro con cualquier error del LLM: solo
// hacía falta que el truncamiento SÍ fuera un error.
// ═══════════════════════════════════════════════════════════════════════════
describe('generateResponse — respuesta truncada', () => {
  beforeEach(() => { create.mockReset(); });

  const truncadaChat = (maxTokens?: number) => ({
    choices: [{ finish_reason: 'length', message: { content: 'El artículo 29 del CFF dice que las facturas deben' } }],
    usage: { prompt_tokens: 50, completion_tokens: maxTokens ?? 400 },
    model: 'openai/gpt-5-nano',
  });

  it('finish_reason=length lanza TruncatedError en vez de devolver el texto cortado', async () => {
    create.mockResolvedValue(truncadaChat());
    await expect(generateResponse({
      role: 'chat', system: 's', messages: [{ role: 'user', content: 'explica' }], maxTokens: 400,
    })).rejects.toBeInstanceOf(TruncatedError);
  });

  it('la llamada truncada se cobró: el error carga tokens y costo, no cero', async () => {
    create.mockResolvedValue(truncadaChat());
    const err = await generateResponse({
      role: 'chat', system: 's', messages: [{ role: 'user', content: 'explica' }], maxTokens: 400,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TruncatedError);
    expect(err.usage?.tokensOut).toBe(400);
    expect(err.usage?.cost).toBeGreaterThan(0);
  });

  it('un tope de 500 (el default) no confunde el truncamiento con un 5xx de proveedor: no reintenta con el fallback', async () => {
    // `openai/gpt-5-nano` (rol chat) SÍ tiene fallback en la tabla — si
    // `isTransientError` leyera el "500" de "se agotaron los 500 tokens" del
    // mensaje como un código HTTP, esto cruzaría de proveedor en silencio en
    // vez de fallar visiblemente con TruncatedError.
    create.mockResolvedValue({
      choices: [{ finish_reason: 'length', message: { content: 'texto cortado' } }],
      usage: { prompt_tokens: 50, completion_tokens: 500 },
      model: 'openai/gpt-5-nano',
    });
    const err = await generateResponse({
      role: 'chat', system: 's', messages: [{ role: 'user', content: 'explica' }],
    }).catch((e) => e); // sin maxTokens: usa el default 500
    expect(err).toBeInstanceOf(TruncatedError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('un texto completo (finish_reason=stop) sigue devolviéndose normal', async () => {
    create.mockResolvedValue({
      choices: [{ finish_reason: 'stop', message: { content: 'listo, aquí está' } }],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
      model: 'openai/gpt-5-nano',
    });
    const r = await generateResponse({ role: 'chat', system: 's', messages: [{ role: 'user', content: 'x' }] });
    expect(r.text).toBe('listo, aquí está');
  });
});
