import { describe, it, expect, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28, REN-M1/TC-M5 — el analista responde EN VIVO al chat del
// dashboard ("Pregunta a tus datos", /api/dashboard/chat: una persona
// esperando la respuesta en el navegador), pero pedía su presupuesto de IA
// con el propósito 'fondo' — el carril de los agentes de back office
// (runner, redactor) que NO tienen a nadie esperando y por eso solo gastan
// hasta (tope_tenant − reserva). Con 'fondo', el analista podía quedarse sin
// servicio porque un lote de fondo AJENO (el runner, el redactor) ya había
// tocado esa reserva recortada — exactamente lo que el contrato de
// budget.ts dice que NO le debe pasar a un camino interactivo.
//
// Este test fija el propósito real con el que `ejecutarAnalista` pide su
// presupuesto: espía `createLlmBudget` (no reimplementa la lógica de
// budget.ts, que ya tiene su propia cobertura en budget.test.ts) y verifica
// que el analista lo llama con 'interactivo', no con 'fondo'.
// ═══════════════════════════════════════════════════════════════════════════

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => { throw new Error('sin base en pruebas'); } }));

const generateWithTools = vi.fn(async (..._a: unknown[]) => ({
  finalText: 'Listo.',
  toolCalls: [],
  model: 'flash', tokensIn: 10, tokensOut: 5, cost: 0.0001, costoPorModelo: {},
}));
vi.mock('@/lib/llm/openrouter', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, generateWithTools: (...a: unknown[]) => generateWithTools(...(a as [never])) };
});

const createLlmBudget = vi.fn((..._a: unknown[]) => ({
  tenantId: 't-1', runId: 'r-1', proposito: 'interactivo',
  origenTope: 'piso', topeTenantResuelto: false,
  maxRunUsd: 0.5, maxTenantDailyUsd: 1, reservaInteractivoUsd: 1, reservadoRunUsd: 0,
}));
vi.mock('@/lib/llm/budget', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, createLlmBudget: (...a: unknown[]) => createLlmBudget(...(a as [never])) };
});

const { ejecutarAnalista } = await import('./analista');

describe('REN-M1/TC-M5 — el analista pide su presupuesto en el carril interactivo', () => {
  it("createLlmBudget se llama con proposito 'interactivo', no 'fondo'", async () => {
    createLlmBudget.mockClear();

    await ejecutarAnalista({
      tenantId: 't-1', nombreFlota: 'Flota', usuario: { nombre: 'Ana', rol: 'flota_admin' },
      mensajes: [{ rol: 'usuario', texto: '¿cuánto gasté este mes?' }],
    });

    expect(createLlmBudget).toHaveBeenCalledTimes(1);
    const [, , proposito] = createLlmBudget.mock.calls[0];
    expect(proposito).toBe('interactivo');
    expect(proposito).not.toBe('fondo');
  });
});
