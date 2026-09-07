import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// EL MOTOR DEL COPILOTO — lo que se fija aquí es la CADENA de guardias en
// el camino nuevo (la guardia misma ya tiene sus pruebas en analista):
//
//  1. Una respuesta con una cifra que NINGUNA tool devolvió se tumba, y la
//     red final entrega la tabla determinista con lo que las tools SÍ
//     leyeron — jamás la cifra inventada.
//  2. La acción propuesta sobrevive con su previsualización DEL CATÁLOGO
//     (no del modelo) anexada al final de los bloques.
// ═══════════════════════════════════════════════════════════════════════════

const logs = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger: logs }));
// Las tools 🟢 tocan lib/admin (supabaseAdmin al importar): dobles vacíos —
// aquí no se ejecuta ninguna tool real, el ciclo entero se simula en
// generateWithTools.
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => { throw new Error('sin base en pruebas'); } }));

/** Cada llamada a generateWithTools consume el siguiente guion. */
type ToolCall = { toolName: string; result: unknown; error?: string | null };
/** El executor real de tool-executor.ts devuelve `ToolExecResult`
 *  (`{ success, result, error, durationMs }`) — las pruebas que llaman al
 *  executor directo (TC-M3, TC-B7, AG-B3) solo miran `.result`. */
type GenOpts = { toolExecutor: (n: string, a: Record<string, unknown>) => Promise<{ result: unknown }> };
type GenResult = {
  toolCalls: ToolCall[]; finalText: string; cost: number; tokensIn: number; tokensOut: number; model: string;
  costoPorModelo: Record<string, { tokensIn: number; tokensOut: number; cost: number }>;
};
let guiones: Array<{ toolCalls: ToolCall[]; finalText: string }>;
const generateWithTools = vi.fn(async (opts: GenOpts): Promise<GenResult> => {
  void opts;
  const g = guiones.shift() ?? { toolCalls: [], finalText: '' };
  return {
    toolCalls: g.toolCalls,
    finalText: g.finalText,
    cost: 0.001, tokensIn: 100, tokensOut: 50, model: 'prueba',
    costoPorModelo: { prueba: { tokensIn: 100, tokensOut: 50, cost: 0.001 } },
  };
});
// `PartialExecutionError` viaja REAL (no un doble) — es una clase plana sin
// efectos de importación, y las pruebas de AG-B3/TC-B1 necesitan que
// `e instanceof PartialExecutionError` funcione de verdad dentro de copiloto.ts.
vi.mock('@/lib/llm/openrouter', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, generateWithTools: (...a: unknown[]) => generateWithTools(...(a as [never])) };
});

// `estaApagado` real hace red (supabaseAdmin, mockeado arriba para TRONAR —
// eso lo deja fail-closed = 'apagado' por diseño de interruptores.ts). Para
// probar TC-B7 en ambos sentidos (encendido/apagado) sin depender de ese
// fail-closed, se dobla directo — default 'encendido' para no romper NADA
// de lo de arriba (ninguna otra prueba de este archivo propone apagar_agente).
const estaApagadoMock = vi.fn(async (_objetivo?: string) => false);
vi.mock('@/lib/likida/interruptores', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, estaApagado: (...a: unknown[]) => estaApagadoMock(...(a as [never])) };
});

const { ejecutarCopiloto } = await import('./copiloto');
const { PartialExecutionError } = await import('@/lib/llm/openrouter');

beforeEach(() => {
  guiones = [];
  logs.warn.mockClear();
  logs.error.mockClear();
  estaApagadoMock.mockClear();
  estaApagadoMock.mockImplementation(async () => false);
});

describe('la guardia de cifras en el camino del copiloto', () => {
  it('sin tenant de presupuesto falla cerrado antes de llamar al modelo', async () => {
    await expect(ejecutarCopiloto({ userId: 'u-1', mensajes: [{ rol: 'usuario', texto: '¿cómo vamos?' }] }))
      .rejects.toThrow(/tenant requerido/);
    expect(generateWithTools).not.toHaveBeenCalled();
  });

  it('una cifra que ninguna tool devolvió SE TUMBA, y la red final entrega lo que las tools sí leyeron', async () => {
    const llamada = {
      toolCalls: [{ toolName: 'bandeja', result: { conteos: { arco: 2 }, enCola: 2 }, error: null }],
      // 3847 no vino de ninguna tool: es la invención que la guardia existe
      // para no dejar pasar (y no es derivable de {2} ni del calendario).
      finalText: 'Tienes 3847 asuntos pendientes en la bandeja.',
    };
    guiones = [llamada, llamada]; // el turno + su reintento correctivo, ambos inventando
    const r = await ejecutarCopiloto({ userId: 'u-1', budgetTenantId: 'tenant-test-a', mensajes: [{ rol: 'usuario', texto: '¿qué espera decisión hoy?' }] });

    const todoElTexto = JSON.stringify(r.bloques);
    expect(todoElTexto).not.toContain('3847');
    // La red final: la tabla determinista con el resultado real de la tool.
    expect(r.bloques.some((b) => b.tipo === 'tabla')).toBe(true);
    expect(logs.warn).toHaveBeenCalledWith('copiloto.reintento_correctivo', expect.anything());
  });

  it('con las tools mudas y el texto inventando, sale el aviso honesto — nunca el número', async () => {
    const llamada = { toolCalls: [], finalText: 'El MRR es de $840,000.' };
    guiones = [llamada, llamada];
    const r = await ejecutarCopiloto({ userId: 'u-1', budgetTenantId: 'tenant-test-a', mensajes: [{ rol: 'usuario', texto: '¿cómo vamos?' }] });
    const texto = JSON.stringify(r.bloques);
    expect(texto).not.toContain('840');
    expect(texto).toMatch(/no pude armar esa respuesta/i);
  });

  it('una cifra QUE SÍ devolvió una tool pasa entera', async () => {
    guiones = [{
      toolCalls: [{ toolName: 'metrica_negocio', result: { flotas: 4, costoIaUsd: 123.45 }, error: null }],
      finalText: 'Tienes 4 flotas dadas de alta y el costo de IA va en 123.45 USD.',
    }];
    const r = await ejecutarCopiloto({ userId: 'u-1', budgetTenantId: 'tenant-test-a', mensajes: [{ rol: 'usuario', texto: '¿cómo va el negocio?' }] });
    expect(JSON.stringify(r.bloques)).toContain('123.45');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TC-M3 (auditoría 28) — dos `proponer_accion` en el MISMO turno. Antes, el
// segundo sobrescribía al primero en `ACCIONES_PROPUESTAS` con un `.set`
// silencioso: la primera tarjeta desaparecía sin que nadie lo dijera. Ahora
// el segundo se rechaza explícito y solo la primera sobrevive.
// ═══════════════════════════════════════════════════════════════════════════
describe('TC-M3 — una sola propuesta de acción viva por turno', () => {
  it('el segundo proponer_accion del mismo turno se rechaza con ok:false, y solo la primera tarjeta llega al final', async () => {
    let resultadoSegunda: unknown;
    generateWithTools.mockImplementationOnce(async (opts: GenOpts) => {
      const r1 = await opts.toolExecutor('proponer_accion', { accion: 'correr_runner', objetivo: 'redactor', motivo: 'demo' });
      expect((r1.result as { ok?: boolean }).ok).toBe(true);
      const r2 = await opts.toolExecutor('proponer_accion', { accion: 'correr_runner', objetivo: 'cobranza', motivo: 'otra' });
      resultadoSegunda = r2.result;
      await opts.toolExecutor('entregar_respuesta_admin', { bloques: [{ tipo: 'texto', texto: 'Va la primera propuesta.' }] });
      return {
        toolCalls: [], finalText: '',
        cost: 0.001, tokensIn: 10, tokensOut: 5, model: 'prueba', costoPorModelo: {},
      };
    });
    const r = await ejecutarCopiloto({
      userId: 'u-1', budgetTenantId: 'tenant-test-a',
      mensajes: [{ rol: 'usuario', texto: 'corre el runner de redactor y luego el de cobranza' }],
    });
    expect(resultadoSegunda).toMatchObject({ ok: false, error: expect.stringMatching(/ya hay una propuesta/i) });
    const accionBloques = r.bloques.filter((b) => b.tipo === 'accion');
    expect(accionBloques).toHaveLength(1);
    expect((accionBloques[0] as { objetivo: string }).objetivo).toBe('redactor');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TC-B7 (auditoría 28) — la previsualización de `apagar_agente` se valida
// contra el catálogo REAL de interruptores ANTES de armarse: un objetivo que
// no existe, o que ya está apagado, no se ofrece como si tuviera efecto.
// ═══════════════════════════════════════════════════════════════════════════
describe('TC-B7 — proponer_accion valida el objetivo contra INTERRUPTORES', () => {
  it('un objetivo que no es un interruptor del catálogo se rechaza sin armar tarjeta ni consultar el estado', async () => {
    let resultado: unknown;
    generateWithTools.mockImplementationOnce(async (opts: GenOpts) => {
      const r = await opts.toolExecutor('proponer_accion', { accion: 'apagar_agente', objetivo: 'agente:inventado', motivo: 'x' });
      resultado = r.result;
      await opts.toolExecutor('entregar_respuesta_admin', { bloques: [{ tipo: 'texto', texto: 'No se pudo.' }] });
      return { toolCalls: [], finalText: '', cost: 0.001, tokensIn: 10, tokensOut: 5, model: 'prueba', costoPorModelo: {} };
    });
    const r = await ejecutarCopiloto({ userId: 'u-1', budgetTenantId: 'tenant-test-a', mensajes: [{ rol: 'usuario', texto: 'apaga agente:inventado' }] });
    expect(resultado).toMatchObject({ ok: false, error: expect.stringMatching(/no es un interruptor/i) });
    expect(r.bloques.some((b) => b.tipo === 'accion')).toBe(false);
    expect(estaApagadoMock).not.toHaveBeenCalled();
  });

  it('un interruptor YA apagado no se ofrece como ejecutable', async () => {
    estaApagadoMock.mockResolvedValueOnce(true);
    let resultado: unknown;
    generateWithTools.mockImplementationOnce(async (opts: GenOpts) => {
      const r = await opts.toolExecutor('proponer_accion', { accion: 'apagar_agente', objetivo: 'agente:cobranza', motivo: 'x' });
      resultado = r.result;
      await opts.toolExecutor('entregar_respuesta_admin', { bloques: [{ tipo: 'texto', texto: 'Ya está apagado.' }] });
      return { toolCalls: [], finalText: '', cost: 0.001, tokensIn: 10, tokensOut: 5, model: 'prueba', costoPorModelo: {} };
    });
    const r = await ejecutarCopiloto({ userId: 'u-1', budgetTenantId: 'tenant-test-a', mensajes: [{ rol: 'usuario', texto: 'apaga cobranza' }] });
    expect(resultado).toMatchObject({ ok: false, error: expect.stringMatching(/ya está apagado/i) });
    expect(r.bloques.some((b) => b.tipo === 'accion')).toBe(false);
    expect(estaApagadoMock).toHaveBeenCalledWith('agente:cobranza');
  });

  it('un interruptor válido y encendido SÍ arma la tarjeta', async () => {
    let resultado: unknown;
    generateWithTools.mockImplementationOnce(async (opts: GenOpts) => {
      const r = await opts.toolExecutor('proponer_accion', { accion: 'apagar_agente', objetivo: 'agente:cobranza', motivo: 'manda de más' });
      resultado = r.result;
      await opts.toolExecutor('entregar_respuesta_admin', { bloques: [{ tipo: 'texto', texto: 'Va la tarjeta.' }] });
      return { toolCalls: [], finalText: '', cost: 0.001, tokensIn: 10, tokensOut: 5, model: 'prueba', costoPorModelo: {} };
    });
    const r = await ejecutarCopiloto({ userId: 'u-1', budgetTenantId: 'tenant-test-a', mensajes: [{ rol: 'usuario', texto: 'apaga cobranza' }] });
    expect(resultado).toMatchObject({ ok: true });
    const accionBloques = r.bloques.filter((b) => b.tipo === 'accion');
    expect(accionBloques).toHaveLength(1);
    expect((accionBloques[0] as { objetivo: string }).objetivo).toBe('agente:cobranza');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AG-B3 + TC-B1 (auditoría 28) — un `PartialExecutionError` a media corrida
// (el reintento correctivo truena) tiene que: (a) acumular el costo YA
// gastado en la primera ronda, mismo patrón que analista.ts:449-451, y (b)
// no borrar sin explicación una tarjeta de acción que ya se había armado —
// el copiloto la rescata del mapa antes de que el `finally` lo limpie y
// entrega una respuesta degradada pero honesta, en vez de tronar la
// función entera.
// ═══════════════════════════════════════════════════════════════════════════
describe('AG-B3 + TC-B1 — el costo se acumula y la tarjeta sobrevive a una excepción a media corrida', () => {
  it('el costo del PartialExecutionError incluye lo gastado en la ronda anterior, y la tarjeta ya propuesta llega en la respuesta degradada', async () => {
    generateWithTools
      .mockImplementationOnce(async (opts: GenOpts) => {
        await opts.toolExecutor('proponer_accion', { accion: 'correr_runner', objetivo: 'redactor', motivo: 'demo' });
        return {
          // Cifra inventada (9999 no vino de ninguna tool) — dispara el
          // reintento correctivo, que es donde AG-B3 vive.
          toolCalls: [], finalText: 'Ya bajé el gasto en 9999 USD.',
          cost: 0.01, tokensIn: 200, tokensOut: 80, model: 'prueba', costoPorModelo: {},
        };
      })
      .mockImplementationOnce(async () => {
        throw new PartialExecutionError('se agotaron las rondas de tools', new Error('loop-guard'), [], 30, 12, 0.002);
      });

    const r = await ejecutarCopiloto({
      userId: 'u-1', budgetTenantId: 'tenant-test-a',
      mensajes: [{ rol: 'usuario', texto: 'corre el runner de redactor' }],
    });

    // AG-B3: 0.01 (ronda 1) + 0.002 (lo que el PartialExecutionError ya traía).
    expect(r.costoUsd).toBeCloseTo(0.012, 6);
    expect(r.tokensIn).toBe(230);
    expect(r.tokensOut).toBe(92);

    // TC-B1: la función NO tronó — devolvió una respuesta degradada honesta,
    // con la tarjeta que `proponer_accion` ya había armado en la ronda 1.
    const texto = JSON.stringify(r.bloques);
    expect(texto).toMatch(/tropez/i);
    const accionBloques = r.bloques.filter((b) => b.tipo === 'accion');
    expect(accionBloques).toHaveLength(1);
    expect((accionBloques[0] as { objetivo: string }).objetivo).toBe('redactor');
    expect(logs.error).toHaveBeenCalledWith('copiloto.excepcion_a_media_corrida', expect.anything());
  });

  it('sin tarjeta pendiente, la excepción a media corrida igual entrega una respuesta honesta (sin bloque de acción)', async () => {
    generateWithTools
      .mockImplementationOnce(async () => ({
        toolCalls: [], finalText: 'El costo bajó a 9999 USD.',
        cost: 0.01, tokensIn: 200, tokensOut: 80, model: 'prueba', costoPorModelo: {},
      }))
      .mockImplementationOnce(async () => {
        throw new PartialExecutionError('timeout', new Error('abort'), [], 5, 5, 0.001);
      });
    const r = await ejecutarCopiloto({ userId: 'u-1', budgetTenantId: 'tenant-test-a', mensajes: [{ rol: 'usuario', texto: '¿cómo va el negocio?' }] });
    expect(r.bloques.some((b) => b.tipo === 'accion')).toBe(false);
    expect(r.bloques.length).toBeGreaterThan(0);
    expect(r.costoUsd).toBeCloseTo(0.011, 6);
  });
});
