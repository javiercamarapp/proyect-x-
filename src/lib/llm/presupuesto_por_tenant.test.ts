import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24, TC-N1 / WA-1 / OP-P7 (CRÍTICO) — EL TECHO DIARIO DE IA ES POR
// FLOTA, y el error de tope se reconoce aunque venga envuelto.
//
// Antes: UNA env global ($5.00) para todas las flotas; con 500 viajes/día el
// tope caía a media mañana y subirlo arrastraba a todas. Aquí se fija:
//   · `tenant.config.presupuestoLlmUsdDia` gana a la env;
//   · sin llave, el techo se DERIVA del plan (viajes/día × costo por viaje),
//     acotado entre el piso y `LIKIDA_LLM_TENANT_DAILY_BUDGET_MAX_USD`;
//   · sin plan, el piso de siempre; base caída → piso y se dice;
//   · un límite explícito del llamador (runner) no se toca;
//   · el primer `tope_tenant` del día por flota avisa al operador, UNA vez;
//   · `esErrorDePresupuesto` atraviesa el envoltorio.
// ═══════════════════════════════════════════════════════════════════════════

const rpc = vi.hoisted(() => vi.fn());
const tablas = vi.hoisted(() => new Map<string, { data: unknown; error: { message: string } | null }>());
const alertar = vi.hoisted(() => vi.fn(async () => {}));
const loggerError = vi.hoisted(() => vi.fn());

function consulta(tabla: string) {
  const responder = async () => tablas.get(tabla) ?? { data: null, error: null };
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: () => b, eq: () => b, in: () => b,
    maybeSingle: () => responder(),
  });
  return b;
}
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ rpc, from: (t: string) => consulta(t) }) }));
vi.mock('@/lib/likida/presupuesto', () => ({ acotada: (query: unknown) => query }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: loggerError } }));
vi.mock('@/lib/observability/alerta', () => ({ alertarOperador: alertar }));

const {
  createLlmBudget, reserveLlmBudget, LlmBudgetExceededError, esErrorDePresupuesto,
  topeDerivadoDelPlan, topeDiarioDelTenant, olvidarTopesDeTenant, LLAVE_PRESUPUESTO_LLM_TENANT,
} = await import('./budget');
const { COSTO_ESTIMADO_USD } = await import('./models');

const RUN = '00000000-0000-4000-8000-0000000000a1';
const reservaEnviada = () => rpc.mock.calls.find((c) => c[0] === 'reservar_presupuesto_llm')?.[1] as
  | { p_tope_tenant_usd: number; p_reserva_interactivo_usd: number }
  | undefined;

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: 'ok', error: null });
  tablas.clear();
  alertar.mockClear();
  loggerError.mockClear();
  olvidarTopesDeTenant();
  vi.unstubAllEnvs();
});

describe('el techo diario que llega a la RPC sale de la FLOTA, no de una env global', () => {
  it('tenant.config.presupuestoLlmUsdDia gana a la env: la RPC recibe el de la flota', async () => {
    vi.stubEnv('LIKIDA_LLM_TENANT_DAILY_BUDGET_USD', '5');
    tablas.set('tenant', { data: { config: { [LLAVE_PRESUPUESTO_LLM_TENANT]: 40 } }, error: null });
    const budget = createLlmBudget('innovativos', RUN, 'interactivo');
    await reserveLlmBudget(budget, 0.05);
    expect(reservaEnviada()?.p_tope_tenant_usd).toBe(40);
    // La reserva interactiva se recalcula sobre el techo REAL (0.4 × 40).
    expect(reservaEnviada()?.p_reserva_interactivo_usd).toBeCloseTo(16, 6);
    expect(budget.origenTope).toBe('tenant');
  });

  it('sin llave, el techo se deriva del plan: viajes/día × costo por viaje, dentro de [piso, techo]', async () => {
    vi.stubEnv('LIKIDA_LLM_TENANT_DAILY_BUDGET_USD', '5');
    vi.stubEnv('LIKIDA_LLM_TENANT_DAILY_BUDGET_MAX_USD', '60');
    tablas.set('tenant', { data: { config: { politica: [{ concepto: 'diesel' }] } }, error: null });
    // AUDITORÍA 25 (REND-A4): con la constante corregida ($0.18, medida —antes
    // $0.05, banda de diseño) 15,000 viajes/mes YA PASA el techo por defecto de
    // $60/día (ver la prueba de abajo). Aquí se usa un plan más chico para
    // seguir probando el camino sin acotar: derivado > piso y < techo.
    tablas.set('suscripcion', { data: { plan: { limite_viajes_mes: 8_000 } }, error: null });
    const budget = createLlmBudget('innovativos', RUN, 'interactivo');
    await reserveLlmBudget(budget, 0.05);
    const esperado = (8_000 / 30) * COSTO_ESTIMADO_USD.viajeCompleto;
    expect(esperado).toBeGreaterThan(5);
    expect(esperado).toBeLessThan(60);
    expect(reservaEnviada()?.p_tope_tenant_usd).toBeCloseTo(esperado, 4);
    expect(budget.origenTope).toBe('plan');
  });

  // AUDITORÍA 25, ALTO (REND-A4): éste es el escenario exacto de la auditoría
  // — una flota de 15,000 viajes/mes. Con el $0.05 declarado (falso) el
  // derivado daba ~$27/día y CABÍA cómodo bajo el techo de $60, dando una
  // falsa sensación de holgura. Con el costo MEDIDO ($0.18/liquidación) el
  // derivado real es ~$92/día: pasa el techo, y `topeDerivadoDelPlan` lo
  // acota ahí — a la vista, no en silencio. Subir el techo por defecto es una
  // decisión de producto (cuánto puede gastar una flota grande por día) que
  // esta auditoría no toca; lo que sí corrige es que el número del que ese
  // techo se deriva ya no mienta.
  it('REND-A4: una flota de 15,000 viajes/mes con el costo medido pasa el techo por defecto, y queda acotada ahí', async () => {
    vi.stubEnv('LIKIDA_LLM_TENANT_DAILY_BUDGET_USD', '5');
    vi.stubEnv('LIKIDA_LLM_TENANT_DAILY_BUDGET_MAX_USD', '60');
    tablas.set('tenant', { data: { config: { politica: [{ concepto: 'diesel' }] } }, error: null });
    tablas.set('suscripcion', { data: { plan: { limite_viajes_mes: 15_000 } }, error: null });
    const budget = createLlmBudget('innovativos', RUN, 'interactivo');
    await reserveLlmBudget(budget, 0.05);
    const derivadoReal = (15_000 / 30) * COSTO_ESTIMADO_USD.viajeCompleto;
    expect(derivadoReal).toBeGreaterThan(60); // el punto de esta prueba
    expect(reservaEnviada()?.p_tope_tenant_usd).toBeCloseTo(60, 6);
    expect(budget.origenTope).toBe('plan');
  });

  it('el derivado se acota: un plan chico no baja del piso y uno enorme no pasa del techo', () => {
    vi.stubEnv('LIKIDA_LLM_TENANT_DAILY_BUDGET_USD', '5');
    vi.stubEnv('LIKIDA_LLM_TENANT_DAILY_BUDGET_MAX_USD', '60');
    expect(topeDerivadoDelPlan(100)).toBe(5);          // 3.3 viajes/día ≈ $0.18 → piso
    expect(topeDerivadoDelPlan(1_000_000)).toBe(60);   // → techo
    expect(topeDerivadoDelPlan(0)).toBe(5);
    expect(topeDerivadoDelPlan(Number.NaN)).toBe(5);
  });

  // RE-AUDITORÍA 25, FASE 3 (CAP-1, MEDIO): el techo por defecto (sin la env
  // MAX fijada) ya no es el $60 puesto a mano que la auditoría 25 midió y no
  // subió — se deriva de `COSTO_ESTIMADO_USD.viajeCompleto` con margen. Una
  // flota de 15,000 viajes/mes (~500/día, el volumen objetivo de
  // docs/escala-15k.md) YA NO se acota en el freno por defecto.
  it('CAP-1: sin env MAX fijada, una flota de 15,000 viajes/mes no se acota en el techo por defecto', async () => {
    vi.stubEnv('LIKIDA_LLM_TENANT_DAILY_BUDGET_USD', '5');
    tablas.set('tenant', { data: { config: { politica: [{ concepto: 'diesel' }] } }, error: null });
    tablas.set('suscripcion', { data: { plan: { limite_viajes_mes: 15_000 } }, error: null });
    const budget = createLlmBudget('innovativos', RUN, 'interactivo');
    await reserveLlmBudget(budget, 0.05);
    const derivadoReal = (15_000 / 30) * COSTO_ESTIMADO_USD.viajeCompleto;
    expect(derivadoReal).toBeGreaterThan(60); // el $60 viejo ya no alcanza
    expect(reservaEnviada()?.p_tope_tenant_usd).toBeCloseTo(derivadoReal, 4);
    expect(budget.origenTope).toBe('plan');
  });

  it('sin llave y sin plan (o plan sin límite) queda el piso de siempre', async () => {
    vi.stubEnv('LIKIDA_LLM_TENANT_DAILY_BUDGET_USD', '7');
    tablas.set('tenant', { data: { config: null }, error: null });
    tablas.set('suscripcion', { data: { plan: { limite_viajes_mes: null } }, error: null });
    const budget = createLlmBudget('g3m', RUN, 'interactivo');
    await reserveLlmBudget(budget, 0.05);
    expect(reservaEnviada()?.p_tope_tenant_usd).toBe(7);
    expect(budget.origenTope).toBe('piso');
  });

  it('una llave inválida (texto, cero, negativo) no cuenta: cae al plan/piso, no a NaN', async () => {
    vi.stubEnv('LIKIDA_LLM_TENANT_DAILY_BUDGET_USD', '5');
    for (const malo of ['40', 0, -3, null]) {
      olvidarTopesDeTenant();
      rpc.mockClear();
      tablas.set('tenant', { data: { config: { [LLAVE_PRESUPUESTO_LLM_TENANT]: malo } }, error: null });
      const budget = createLlmBudget('flota-x', RUN, 'interactivo');
      await reserveLlmBudget(budget, 0.05);
      expect(reservaEnviada()?.p_tope_tenant_usd, String(malo)).toBe(5);
    }
  });

  it('base caída al leer el techo: se aplica el PISO y se dice (fallar cerrado es gastar menos)', async () => {
    vi.stubEnv('LIKIDA_LLM_TENANT_DAILY_BUDGET_USD', '5');
    tablas.set('tenant', { data: null, error: { message: 'connection refused' } });
    const budget = createLlmBudget('flota-caida', RUN, 'interactivo');
    await reserveLlmBudget(budget, 0.05);
    expect(reservaEnviada()?.p_tope_tenant_usd).toBe(5);
    expect(loggerError).toHaveBeenCalledWith('presupuesto_llm.tope_tenant_ilegible', expect.objectContaining({ tenantId: 'flota-caida' }));
  });

  it('un límite EXPLÍCITO del llamador (el runner) no se toca ni se consulta la base', async () => {
    tablas.set('tenant', { data: { config: { [LLAVE_PRESUPUESTO_LLM_TENANT]: 40 } }, error: null });
    const budget = createLlmBudget('flota-runner', RUN, 'fondo', { maxTenantDailyUsd: 2 });
    await reserveLlmBudget(budget, 0.05);
    expect(reservaEnviada()?.p_tope_tenant_usd).toBe(2);
    expect(budget.origenTope).toBe('explicito');
  });

  it('el techo se lee UNA vez por flota y se cachea: dos budgets, una lectura', async () => {
    tablas.set('tenant', { data: { config: { [LLAVE_PRESUPUESTO_LLM_TENANT]: 40 } }, error: null });
    const a = await topeDiarioDelTenant('flota-cache');
    tablas.set('tenant', { data: { config: { [LLAVE_PRESUPUESTO_LLM_TENANT]: 99 } }, error: null });
    const b = await topeDiarioDelTenant('flota-cache');
    expect(a).toEqual({ topeUsd: 40, origen: 'tenant' });
    expect(b).toEqual(a);
    olvidarTopesDeTenant();
    expect(await topeDiarioDelTenant('flota-cache')).toEqual({ topeUsd: 99, origen: 'tenant' });
  });
});

describe('el primer tope_tenant del día avisa al operador — una vez por flota', () => {
  it('tope_tenant → LlmBudgetExceededError(tenant) con el techo de la flota, y una alerta', async () => {
    tablas.set('tenant', { data: { config: { [LLAVE_PRESUPUESTO_LLM_TENANT]: 40 } }, error: null });
    rpc.mockResolvedValue({ data: 'tope_tenant', error: null });
    const budget = createLlmBudget('innovativos', RUN, 'interactivo');
    await expect(reserveLlmBudget(budget, 0.05)).rejects.toMatchObject({ scope: 'tenant', limitUsd: 40 });
    expect(alertar).toHaveBeenCalledTimes(1);
    expect(alertar).toHaveBeenCalledWith('presupuesto_ia.tope_tenant', expect.objectContaining({ tenantId: 'innovativos', topeUsd: 40, origenTope: 'tenant' }));

    // Los cientos de rebotes que siguen al primero NO vuelven a avisar.
    await expect(reserveLlmBudget(budget, 0.05)).rejects.toBeInstanceOf(LlmBudgetExceededError);
    await expect(reserveLlmBudget(createLlmBudget('innovativos', RUN, 'interactivo'), 0.05)).rejects.toBeInstanceOf(LlmBudgetExceededError);
    expect(alertar).toHaveBeenCalledTimes(1);
  });

  it('otra flota que toca su tope el mismo día SÍ avisa: el piso es por tenant', async () => {
    rpc.mockResolvedValue({ data: 'tope_tenant', error: null });
    await expect(reserveLlmBudget(createLlmBudget('flota-a', RUN, 'interactivo'), 0.05)).rejects.toBeInstanceOf(LlmBudgetExceededError);
    await expect(reserveLlmBudget(createLlmBudget('flota-b', RUN, 'interactivo'), 0.05)).rejects.toBeInstanceOf(LlmBudgetExceededError);
    expect(alertar.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      expect.objectContaining({ tenantId: 'flota-a' }),
      expect.objectContaining({ tenantId: 'flota-b' }),
    ]);
  });

  it('una alerta que truena no tapa el error de presupuesto', async () => {
    rpc.mockResolvedValue({ data: 'tope_tenant', error: null });
    alertar.mockRejectedValueOnce(new Error('SMTP caído'));
    await expect(reserveLlmBudget(createLlmBudget('flota-c', RUN, 'interactivo'), 0.05)).rejects.toBeInstanceOf(LlmBudgetExceededError);
  });
});

describe('esErrorDePresupuesto — reconoce el tope aunque venga envuelto', () => {
  it('desnudo, envuelto en cause, y envuelto dos veces', () => {
    const tope = new LlmBudgetExceededError('tenant', 0.056, 5);
    expect(esErrorDePresupuesto(tope)).toBe(true);
    const envuelto = Object.assign(new Error(tope.message), { cause: tope });
    expect(esErrorDePresupuesto(envuelto)).toBe(true);
    const dosVeces = Object.assign(new Error('agent.fail'), { cause: envuelto });
    expect(esErrorDePresupuesto(dosVeces)).toBe(true);
  });

  it('por NOMBRE cuando la clase viene de otra copia del módulo', () => {
    const ajeno = Object.assign(new Error('presupuesto de IA del día agotado'), { name: 'LlmBudgetExceededError' });
    expect(esErrorDePresupuesto({ cause: ajeno })).toBe(true);
  });

  it('un TypeError, un 503 o un cause circular NO son presupuesto', () => {
    expect(esErrorDePresupuesto(new TypeError('x is undefined'))).toBe(false);
    expect(esErrorDePresupuesto(Object.assign(new Error('503'), { status: 503 }))).toBe(false);
    const circular: { cause?: unknown } = {};
    circular.cause = circular;
    expect(esErrorDePresupuesto(circular)).toBe(false);
    expect(esErrorDePresupuesto(null)).toBe(false);
    expect(esErrorDePresupuesto('presupuesto')).toBe(false);
  });
});
