import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28, TC-A3 — el flujo de ENTREVISTA fiscal es el consumidor real
// del bug de `generateResponse` (`openrouter.ts`): antes de este arreglo, una
// respuesta cortada por `finish_reason: 'length'` volvía como si fuera texto
// completo, y este archivo la presentaba al dueño de la flota como una
// explicación entera de la norma — a media frase, sin decirlo. El catch de
// `responderEntrevista` YA sabía caer a "no voy a inventar la norma" ante
// CUALQUIER error del LLM; lo que faltaba era que el truncamiento SÍ fuera
// un error. Esta prueba es la integración de los dos: mockea el SDK (no
// `generateResponse`) para probar el camino real, extremo a extremo.
// ═══════════════════════════════════════════════════════════════════════════
const create = vi.fn();
const rpc = vi.fn();
vi.mock('openai', () => ({
  default: class { chat = { completions: { create: (...a: unknown[]) => create(...a) } }; },
}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ rpc }) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

process.env.OPENROUTER_API_KEY = 'test-key';
const { responderEntrevista } = await import('./entrevista-agente');

const PREGUNTA = '¿por qué me preguntan el umbral de ingresos?';

describe('responderEntrevista — no presenta una respuesta truncada como completa', () => {
  beforeEach(() => {
    create.mockReset();
    rpc.mockReset();
    rpc.mockImplementation(async (fn: string) => ({ data: fn === 'reservar_presupuesto_llm' ? 'ok' : true, error: null }));
  });

  it('finish_reason=length: NO devuelve el texto cortado, cae al mensaje seguro', async () => {
    create.mockResolvedValue({
      choices: [{ finish_reason: 'length', message: { content: 'El artículo 29 del CFF dice que las facturas deben' } }],
      usage: { prompt_tokens: 200, completion_tokens: 400 },
      model: 'google/gemini-3.5-flash-lite',
    });

    const r = await responderEntrevista({
      tenantId: 'tenant-1',
      userId: null,
      perfilCrudo: {},
      texto: PREGUNTA,
    });

    // NUNCA el texto cortado del modelo tal cual.
    expect(r.texto).not.toContain('El artículo 29 del CFF dice que las facturas deben');
    // El mensaje explícito de "no invento" — la regla de dominio del repo.
    expect(r.texto).toContain('no voy a inventar la norma');
    expect(r.guardado).toBe(false);
  });

  it('una respuesta completa (finish_reason=stop) SÍ se devuelve tal cual', async () => {
    create.mockResolvedValue({
      choices: [{ finish_reason: 'stop', message: { content: 'Se pregunta porque el umbral de $300M decide si aplican ciertos estímulos.' } }],
      usage: { prompt_tokens: 200, completion_tokens: 40 },
      model: 'google/gemini-3.5-flash-lite',
    });

    const r = await responderEntrevista({
      tenantId: 'tenant-1',
      userId: null,
      perfilCrudo: {},
      texto: PREGUNTA,
    });

    expect(r.texto).toBe('Se pregunta porque el umbral de $300M decide si aplican ciertos estímulos.');
  });

  it('un fallo de red también cae al mensaje seguro (cobertura previa, no debe romperse)', async () => {
    create.mockRejectedValue(new Error('fetch failed'));

    const r = await responderEntrevista({
      tenantId: 'tenant-1',
      userId: null,
      perfilCrudo: {},
      texto: PREGUNTA,
    });

    expect(r.texto).toContain('no voy a inventar la norma');
  });
});
