import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { acotada } from '@/lib/likida/presupuesto';
import { logger } from '@/lib/logger';
import { hoyMx } from '@/lib/formato';
import { COSTO_ESTIMADO_USD } from './models';

// ═══════════════════════════════════════════════════════════════════════════
// D.23 (frente de escala) — EL PRESUPUESTO TIENE DIMENSIÓN DE PROPÓSITO.
//
// Antes todo el gasto de modelo de un tenant salía de la misma bolsa diaria:
// el OCR barato de un lote grande podía vaciar el techo antes de que el
// chofer mandara su ticket, y el camino interactivo —el que tiene a una
// persona esperando— se quedaba sin servicio por un proceso de fondo.
//
// Tres propósitos (dominio cerrado, el mismo CHECK de la 0244):
//   · 'interactivo' — hay una persona esperando AHORA: el turno de WhatsApp
//     del chofer (agente, OCR de SU ticket, su audio), los chats del
//     dashboard y las subidas manuales.
//   · 'ocr_lote'    — extracción de comprobantes en fondo (piloto de visión).
//   · 'fondo'       — agentes de back office (runner, analista, redactor).
//
// La RESERVA: 'ocr_lote' y 'fondo' solo gastan hasta (tope_tenant − reserva);
// 'interactivo' puede usar el techo completo. Cuando el fondo toca su parte,
// la RPC devuelve 'tope_proposito' y aquí se FALLA CERRADO con nombre —
// jamás un número inventado ni un 0 silencioso. El propósito es un parámetro
// OBLIGATORIO de `createLlmBudget`: un llamador nuevo tiene que decidir en
// qué carril corre, no heredar uno en silencio.
// ═══════════════════════════════════════════════════════════════════════════

export type PropositoIa = 'interactivo' | 'ocr_lote' | 'fondo';

const MENSAJE_POR_SCOPE = {
  run: (pedido: string, limite: string) =>
    `presupuesto de IA agotado para esta corrida: se requieren ${pedido} USD y el límite es ${limite} USD`,
  tenant: (pedido: string, limite: string) =>
    `presupuesto de IA del día agotado para esta flota: se requieren ${pedido} USD y el techo diario es ${limite} USD`,
  proposito: (pedido: string, limite: string) =>
    `presupuesto de IA de fondo agotado por hoy (se requieren ${pedido} USD y la parte de fondo es ${limite} USD): ` +
    'la reserva restante es del camino interactivo — el chofer no se queda sin servicio por un lote de fondo. El trabajo de fondo reintenta en su siguiente corrida.',
} as const;

export class LlmBudgetExceededError extends Error {
  constructor(public scope: 'run' | 'tenant' | 'proposito', public requestedUsd: number, public limitUsd: number) {
    super(MENSAJE_POR_SCOPE[scope](`$${requestedUsd.toFixed(6)}`, `$${limitUsd.toFixed(6)}`));
    this.name = 'LlmBudgetExceededError';
  }
}

/**
 * ¿Este error ES (o ENVUELVE) un tope de presupuesto de IA?
 *
 * AUDITORÍA 24, TC-N1 (CRÍTICO). `generateWithTools` envuelve CUALQUIER
 * excepción del ciclo —incluida la de `reserveLlmBudget`— en
 * `PartialExecutionError` (openrouter.ts), así que el
 * `e instanceof LlmBudgetExceededError` del processor era `false` en
 * producción: la rama que degrada a cuadre determinístico (la del CRÍTICO de
 * la auditoría 19) era código muerto y el chofer recibía "se me trabó el
 * sistema" hasta medianoche. La prueba que la cubría rechazaba con el error
 * DESNUDO, que en producción nunca llega así.
 *
 * Atraviesa la cadena de `cause` (acotada, por si alguien la hace circular) y
 * reconoce el error por CLASE o por NOMBRE: un `instanceof` falla entre dos
 * copias del módulo (vitest con mocks parciales, bundles duplicados) y el
 * nombre es lo que `LlmBudgetExceededError` fija en su constructor.
 */
export function esErrorDePresupuesto(err: unknown): err is LlmBudgetExceededError {
  let actual: unknown = err;
  for (let profundidad = 0; profundidad < 6 && actual && typeof actual === 'object'; profundidad++) {
    if (actual instanceof LlmBudgetExceededError) return true;
    if ((actual as { name?: unknown }).name === 'LlmBudgetExceededError') return true;
    actual = (actual as { cause?: unknown }).cause;
  }
  return false;
}

export interface LlmBudget {
  tenantId: string;
  runId: string;
  /** En qué carril corre este gasto — decide qué techo lo frena. */
  proposito: PropositoIa;
  maxRunUsd: number;
  maxTenantDailyUsd: number;
  /** Parte del techo diario que SOLO el camino interactivo puede tocar. */
  reservaInteractivoUsd: number;
  reservadoRunUsd: number;
  /**
   * De dónde salió `maxTenantDailyUsd` (auditoría 24, TC-N1/WA-1):
   *   · 'explicito' — el llamador lo pasó en `limits` (runner de agentes).
   *   · 'tenant'    — `tenant.config.presupuestoLlmUsdDia` (mig. 0278).
   *   · 'plan'      — derivado de `plan.limite_viajes_mes` × costo por viaje.
   *   · 'piso'      — la env global `LIKIDA_LLM_TENANT_DAILY_BUDGET_USD` (o $5).
   * Hasta la primera reserva vale 'piso' salvo que sea explícito: la lectura
   * de la flota es asíncrona y se hace en `reserveLlmBudget`, no aquí.
   */
  origenTope?: OrigenTopeTenant;
  /** `true` cuando el techo de la flota ya se leyó (o era explícito). */
  topeTenantResuelto?: boolean;
}

export type OrigenTopeTenant = 'explicito' | 'tenant' | 'plan' | 'piso';

export interface LlmBudgetLimits {
  maxRunUsd?: number;
  maxTenantDailyUsd?: number;
}

export interface LlmBudgetReservation {
  id: string;
  amountUsd: number;
  persisted?: boolean;
  settled?: boolean;
}

function positiveEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * El tenant de presupuesto es parte de la frontera de seguridad, no una
 * configuración global. En producción también debe ser UUID porque la RPC
 * central recibe `uuid`; en tests aceptamos identificadores cortos para que
 * cada caso pueda inyectar su propio tenant sin levantar Postgres.
 */
// Mismo patrón que `esUuidValido` (`intake/cfdi.ts`) y el resto del repo
// (`viajes_registro.ts`, `operacion.ts`, `qa-tipos.ts`…): solo la FORMA
// 8-4-4-4-12 en hex. NO exigir el nibble de versión/variante RFC4122
// ([1-5].../[89ab]...) — `tenant.id` de G3M, la única flota en producción,
// es `11111111-1111-1111-1111-111111111111`, un UUID a propósito (ver
// `seed.sql`) que NO trae esos nibbles. La versión estricta de este check
// (añadida en el endurecimiento «Enterprise», 24-ago) rechazaba ese ID en
// producción con `NODE_ENV=production`, así que TODA llamada al agente que
// pidiera presupuesto de IA para G3M fallaba con "tenant inválido" y el
// operador recibía el genérico "se me trabó el sistema" — verificado en
// logs de producción el 25-ago (`agent.fail`, err "presupuesto_llm: tenant
// inválido", huella de tenant igual a `huellaId('11111111-...-111111111111')`).
export function requireLlmBudgetTenant(tenantId: string | null | undefined): string {
  const value = typeof tenantId === 'string' ? tenantId.trim() : '';
  if (!value) throw new Error('presupuesto_llm: tenant requerido');
  if (process.env.NODE_ENV === 'production'
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('presupuesto_llm: tenant inválido');
  }
  return value;
}

const PROPOSITOS: readonly PropositoIa[] = ['interactivo', 'ocr_lote', 'fondo'];

/**
 * Qué fracción del techo diario queda reservada para el camino interactivo.
 * 0.4 por defecto: con el techo default de $5.00/día, $2.00 que ningún lote
 * de fondo puede tocar. Ajustable sin desplegar; se acota a [0, 1].
 */
function fraccionReservaInteractivo(): number {
  const parsed = Number(process.env.LIKIDA_LLM_RESERVA_INTERACTIVO_PCT);
  if (!Number.isFinite(parsed)) return 0.4;
  return Math.min(1, Math.max(0, parsed));
}

/** Los topes vigentes por defecto — para que el panel /admin/consumo enseñe el techo real, no uno recordado. */
export function topesPresupuestoIa(): { topeTenantDiaUsd: number; reservaInteractivoUsd: number; fraccionReserva: number } {
  const topeTenantDiaUsd = positiveEnv(process.env.LIKIDA_LLM_TENANT_DAILY_BUDGET_USD, 5.00);
  const fraccionReserva = fraccionReservaInteractivo();
  return {
    topeTenantDiaUsd,
    reservaInteractivoUsd: Number((topeTenantDiaUsd * fraccionReserva).toFixed(6)),
    fraccionReserva,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EL TECHO DIARIO ES POR FLOTA, NO UNA ENV GLOBAL (auditoría 24, TC-N1 / WA-1).
//
// Hasta la 24 el techo era UNA variable (`LIKIDA_LLM_TENANT_DAILY_BUDGET_USD`,
// $5.00) para todas las flotas. Con el tráfico del piloto (500 viajes y 1,500
// fotos al día en UNA flota, ~$27/día de IA medidos con `COSTO_ESTIMADO_USD`)
// el tope caía hacia las 10 de la mañana; y subir la env a $60 para salvar el
// piloto subía el techo de TODAS las flotas — el freno de dinero dejaba de
// ser freno.
//
// El orden de prioridad, de más específico a más general:
//   1. `limits.maxTenantDailyUsd` explícito del llamador (el runner lo pasa
//      con `agente_definicion.presupuesto_dia_usd`).
//   2. `tenant.config.presupuestoLlmUsdDia` — la flota lo declara (mig. 0278
//      valida número > 0). Es la palanca para el piloto: se sube UNA flota.
//   3. Derivado del plan: `plan.limite_viajes_mes / 30` viajes/día × lo que
//      cuesta liquidar un viaje completo (`COSTO_ESTIMADO_USD.viajeCompleto`),
//      acotado entre el piso y `LIKIDA_LLM_TENANT_DAILY_BUDGET_MAX_USD`.
//   4. El piso: la env global de siempre, o $5.00 si no está.
//
// La lectura es asíncrona y `createLlmBudget` no lo es (lo llaman 14 sitios
// síncronos), así que el techo se resuelve UNA vez en la primera
// `reserveLlmBudget` del budget — antes de la RPC, que es la que lo aplica —
// y se cachea por flota un minuto: con 1,500 fotos/día una consulta por
// reserva sería ruido, y un minuto de retraso en aplicar un cambio de tope
// no le cuesta nada a nadie. Si la lectura falla se usa el PISO y se dice
// (`presupuesto_llm.tope_tenant_ilegible`): fallar cerrado es gastar MENOS,
// nunca más.
// ═══════════════════════════════════════════════════════════════════════════

/** La llave de `tenant.config` que declara el techo diario de IA de la flota (mig. 0278). */
export const LLAVE_PRESUPUESTO_LLM_TENANT = 'presupuestoLlmUsdDia';
const PISO_TOPE_TENANT_USD = 5.00;

// RE-AUDITORÍA 25, FASE 3 (CAP-1, MEDIO): el techo por defecto NO se sube a
// mano — se DERIVA del mismo costo medido (`COSTO_ESTIMADO_USD.viajeCompleto`,
// $0.1848 con el $0.18/liquidación medido en `models.ts`) para el volumen
// objetivo de escala (`docs/escala-15k.md`: 15,000 viajes/mes ≈ 500/día), con
// un margen operativo encima — picos de fotos por viaje y reintentos no
// promedian $0.1848 exacto. El $60 viejo era un número puesto a mano en la
// auditoría 24 que la 25 midió y no subió; con 500 viajes/día × $0.1848 =
// $92.40/día el freno se agotaba antes de que el día terminara, exactamente
// lo que `topeDerivadoDelPlan` acotaba en silencio (ver la prueba
// `REND-A4` en `presupuesto_por_tenant.test.ts`).
const VIAJES_DIA_OBJETIVO_ESCALA = 500;
const MARGEN_OPERATIVO_TECHO = 1.5;
/**
 * Techo del tope DERIVADO del plan (no del declarado): ver .env.example.
 *
 * Función y no una constante de módulo: `COSTO_ESTIMADO_USD` se calcula en
 * `models.ts`, y varias pruebas de este archivo mockean ese módulo sin
 * `COSTO_ESTIMADO_USD` (les basta `modelFor`). Una constante de módulo
 * evaluaría la cuenta AL IMPORTAR, y reventaría esas pruebas por un cambio
 * ajeno a lo que ellas verifican; como función, solo se evalúa cuando
 * `topeDerivadoDelPlan` de verdad la necesita.
 */
function techoDerivadoPorDefectoUsd(): number {
  return Number((VIAJES_DIA_OBJETIVO_ESCALA * COSTO_ESTIMADO_USD.viajeCompleto * MARGEN_OPERATIVO_TECHO).toFixed(2));
}
const TTL_TOPE_TENANT_MS = 60_000;
/** Los estados de `suscripcion` que cuentan como viva — el mismo criterio de `getSuscripcion`. */
const ESTADOS_SUSCRIPCION_VIVA = ['prueba', 'activa', 'morosa', 'pausada'];

export interface TopeTenantResuelto { topeUsd: number; origen: OrigenTopeTenant }

const topesPorTenant = new Map<string, { hasta: number; tope: TopeTenantResuelto }>();

/** Para pruebas y para que un cambio de tope en el panel se aplique al instante. */
export function olvidarTopesDeTenant(): void {
  topesPorTenant.clear();
  alertadoTopeTenant.clear();
}

/** El piso del techo diario: la env global de siempre, o $5.00. */
export function pisoTopeTenantUsd(): number {
  return positiveEnv(process.env.LIKIDA_LLM_TENANT_DAILY_BUDGET_USD, PISO_TOPE_TENANT_USD);
}

/**
 * El techo diario que le corresponde a una flota SIN llave declarada, a partir
 * del tamaño de su plan: viajes/día × costo de liquidar un viaje completo,
 * acotado entre el piso y `LIKIDA_LLM_TENANT_DAILY_BUDGET_MAX_USD`.
 * Puro, para que la prueba lo ancle con cifras.
 */
export function topeDerivadoDelPlan(limiteViajesMes: number, piso = pisoTopeTenantUsd()): number {
  const techo = positiveEnv(process.env.LIKIDA_LLM_TENANT_DAILY_BUDGET_MAX_USD, techoDerivadoPorDefectoUsd());
  if (!Number.isFinite(limiteViajesMes) || limiteViajesMes <= 0) return piso;
  const derivado = (limiteViajesMes / 30) * COSTO_ESTIMADO_USD.viajeCompleto;
  return Number(Math.min(Math.max(derivado, piso), Math.max(techo, piso)).toFixed(6));
}

type LectorTenant = {
  from?: (tabla: string) => {
    select: (cols: string) => {
      eq: (col: string, v: string) => {
        maybeSingle: () => PromiseLike<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
        in: (col: string, v: string[]) => {
          maybeSingle: () => PromiseLike<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
        };
      };
    };
  };
};

/**
 * El techo diario de IA de una flota, resuelto con el orden de arriba y
 * cacheado un minuto. NUNCA lanza: ante una base que no contesta devuelve el
 * piso y lo registra — el error real lo va a dar la RPC de reserva, que sí
 * es fail-closed y ruidosa.
 */
export async function topeDiarioDelTenant(tenantId: string): Promise<TopeTenantResuelto> {
  const ahora = Date.now();
  const cacheado = topesPorTenant.get(tenantId);
  if (cacheado && cacheado.hasta > ahora) return cacheado.tope;

  const piso = pisoTopeTenantUsd();
  let tope: TopeTenantResuelto = { topeUsd: piso, origen: 'piso' };
  const admin = supabaseAdmin() as unknown as LectorTenant;
  // Los tests de integración mockean Supabase solo con `rpc` (el contrato del
  // ledger). Sin lector no se finge una lectura: es el piso, igual que antes
  // de la auditoría 24. En producción el cliente real siempre trae `from`.
  if (typeof admin.from !== 'function') return tope;

  try {
    const rTenant = await acotada(admin.from('tenant').select('config').eq('id', tenantId).maybeSingle(), 'presupuestoLlm.tenant');
    if (rTenant.error) throw new Error(`tenant.config: ${rTenant.error.message}`);
    const config = (rTenant.data?.config ?? null) as Record<string, unknown> | null;
    const declarado = config && typeof config === 'object' ? config[LLAVE_PRESUPUESTO_LLM_TENANT] : undefined;
    if (typeof declarado === 'number' && Number.isFinite(declarado) && declarado > 0) {
      tope = { topeUsd: declarado, origen: 'tenant' };
    } else {
      const rSus = await acotada(
        admin.from('suscripcion').select('plan(limite_viajes_mes)').eq('tenant_id', tenantId)
          .in('estado', ESTADOS_SUSCRIPCION_VIVA).maybeSingle(),
        'presupuestoLlm.plan',
      );
      if (rSus.error) throw new Error(`suscripcion.plan: ${rSus.error.message}`);
      const rel = rSus.data?.plan as { limite_viajes_mes?: unknown } | Array<{ limite_viajes_mes?: unknown }> | null | undefined;
      const limite = Array.isArray(rel) ? rel[0]?.limite_viajes_mes : rel?.limite_viajes_mes;
      const n = typeof limite === 'number' ? limite : typeof limite === 'string' ? Number(limite) : NaN;
      if (Number.isFinite(n) && n > 0) tope = { topeUsd: topeDerivadoDelPlan(n, piso), origen: 'plan' };
    }
  } catch (e) {
    logger.error('presupuesto_llm.tope_tenant_ilegible', {
      tenantId, topeUsd: piso, err: e instanceof Error ? e.message : String(e),
      msg: 'No se pudo leer el techo diario de IA de la flota; se aplica el piso global. Es fallar cerrado: se gasta menos, no más.',
    });
    // Un fallo de lectura no se cachea el minuto entero: se reintenta pronto.
    topesPorTenant.set(tenantId, { hasta: ahora + 5_000, tope });
    return tope;
  }
  topesPorTenant.set(tenantId, { hasta: ahora + TTL_TOPE_TENANT_MS, tope });
  return tope;
}

/** tenantId → día MX en que ya se avisó el primer `tope_tenant`. */
const alertadoTopeTenant = new Map<string, string>();

/**
 * AUDITORÍA 24, TC-N1 (4): al PRIMER `tope_tenant` del día de cada flota se
 * avisa al operador. Antes el tope se veía en el log como un `agent.fail`
 * cualquiera y nadie en la oficina sabía por qué dejaron de cerrar viajes.
 * `alertarOperador` trae su propio piso por hora; este mapa evita hasta la
 * llamada en los cientos de rebotes que siguen al primero. Best-effort: un
 * correo que no sale no puede tapar el error de presupuesto que sí importa.
 */
async function avisarTopeTenant(budget: LlmBudget, pedidoUsd: number): Promise<void> {
  const dia = hoyMx();
  if (alertadoTopeTenant.get(budget.tenantId) === dia) return;
  alertadoTopeTenant.set(budget.tenantId, dia);
  try {
    // Import dinámico: `alerta.ts` arrastra el correo, y este módulo lo
    // importan 18 sitios (y sus pruebas) que no necesitan nada de eso.
    const { alertarOperador } = await import('@/lib/observability/alerta');
    await alertarOperador('presupuesto_ia.tope_tenant', {
      tenantId: budget.tenantId, dia, proposito: budget.proposito,
      topeUsd: budget.maxTenantDailyUsd, origenTope: budget.origenTope ?? 'piso', pedidoUsd,
      msg: 'La flota agotó su techo diario de IA: el cuadre degrada a determinístico y las fotos esperan. Sube `tenant.config.presupuestoLlmUsdDia` si el tope quedó corto.',
    });
  } catch (e) {
    logger.warn('presupuesto_llm.alerta_tope_fallo', { tenantId: budget.tenantId, err: e instanceof Error ? e.message : String(e) });
  }
}

export function createLlmBudget(
  tenantId: string | null | undefined,
  runId: string,
  proposito: PropositoIa,
  limits: LlmBudgetLimits = {},
): LlmBudget {
  const resolvedTenantId = requireLlmBudgetTenant(tenantId);
  // Fail-closed: un propósito fuera del dominio no se corrige a una cubeta —
  // se rechaza antes de gastar un centavo.
  if (!PROPOSITOS.includes(proposito)) {
    throw new Error(`presupuesto_llm: propósito desconocido: ${String(proposito)}`);
  }
  const explicito = Boolean(limits.maxTenantDailyUsd && limits.maxTenantDailyUsd > 0);
  const maxTenantDailyUsd = explicito
    ? (limits.maxTenantDailyUsd as number)
    : pisoTopeTenantUsd();
  return {
    tenantId: resolvedTenantId,
    runId,
    proposito,
    origenTope: explicito ? 'explicito' : 'piso',
    topeTenantResuelto: explicito,
    // Seis rondas de Sonnet con 4k de salida caben en este techo; el límite
    // sigue siendo duro y puede bajarse sin desplegar.
    maxRunUsd: limits.maxRunUsd && limits.maxRunUsd > 0
      ? limits.maxRunUsd
      : positiveEnv(process.env.LIKIDA_LLM_RUN_BUDGET_USD, 0.50),
    maxTenantDailyUsd,
    reservaInteractivoUsd: Number((maxTenantDailyUsd * fraccionReservaInteractivo()).toFixed(6)),
    reservadoRunUsd: 0,
  };
}

/** Reserva antes de llamar al proveedor. La RPC bloquea por tenant para evitar carreras entre workers. */
export async function reserveLlmBudget(budget: LlmBudget, amountUsd: number): Promise<LlmBudgetReservation> {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error('reserva de IA inválida');
  if (budget.reservadoRunUsd + amountUsd > budget.maxRunUsd + 1e-9) {
    throw new LlmBudgetExceededError('run', budget.reservadoRunUsd + amountUsd, budget.maxRunUsd);
  }
  // El techo de la FLOTA se resuelve aquí, una vez por budget, antes de que
  // la RPC lo aplique (ver el bloque de arriba: tenant → plan → piso).
  if (!budget.topeTenantResuelto) {
    const t = await topeDiarioDelTenant(budget.tenantId);
    budget.maxTenantDailyUsd = t.topeUsd;
    budget.origenTope = t.origen;
    budget.reservaInteractivoUsd = Number((t.topeUsd * fraccionReservaInteractivo()).toFixed(6));
    budget.topeTenantResuelto = true;
  }

  const id = randomUUID();
  const admin = supabaseAdmin() as unknown as {
    rpc?: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  };
  // Los tests de integración mockean Supabase con el contrato que necesitaba
  // el flujo anterior. En producción el cliente real siempre expone `rpc`; si
  // falta fuera de Vitest se falla cerrado y no se llama al proveedor.
  if (typeof admin.rpc !== 'function') {
    if (process.env.NODE_ENV === 'test') {
      budget.reservadoRunUsd += amountUsd;
      return { id, amountUsd, persisted: false };
    }
    throw new Error('reservar_presupuesto_llm: cliente Supabase sin RPC de presupuesto');
  }
  const { data, error } = await acotada(admin.rpc('reservar_presupuesto_llm', {
    p_reserva_id: id,
    p_tenant_id: budget.tenantId,
    p_run_id: budget.runId,
    p_reserva_usd: Number(amountUsd.toFixed(6)),
    p_tope_run_usd: Number(budget.maxRunUsd.toFixed(6)),
    p_tope_tenant_usd: Number(budget.maxTenantDailyUsd.toFixed(6)),
    // D.23 (0244): con los 8 argumentos nombrados, PostgREST resuelve el
    // overload nuevo — el que conoce el propósito y la reserva interactiva.
    p_proposito: budget.proposito,
    p_reserva_interactivo_usd: Number(budget.reservaInteractivoUsd.toFixed(6)),
  }), 'reservarPresupuestoLlm');
  if (error) throw new Error(`reservar_presupuesto_llm: ${error.message}`);
  // La RPC dice CUÁL techo frenó — y aquí se le pone el monto de ese techo,
  // no uno genérico. Cualquier respuesta fuera del contrato LANZA: tratarla
  // como éxito sería gastar sin reserva.
  if (data === 'tope_tenant') {
    await avisarTopeTenant(budget, amountUsd);
    throw new LlmBudgetExceededError('tenant', amountUsd, budget.maxTenantDailyUsd);
  }
  if (data === 'tope_proposito') {
    throw new LlmBudgetExceededError('proposito', amountUsd, Math.max(0, budget.maxTenantDailyUsd - budget.reservaInteractivoUsd));
  }
  if (data === 'tope_run') throw new LlmBudgetExceededError('run', amountUsd, budget.maxRunUsd);
  if (data !== 'ok') throw new Error(`reservar_presupuesto_llm: respuesta inesperada (${JSON.stringify(data)}) — ¿migración 0244 sin aplicar?`);
  budget.reservadoRunUsd += amountUsd;
  return { id, amountUsd, persisted: true };
}

/** Ajusta la reserva al costo real; ante una excepción conserva la reserva. */
export async function settleLlmBudget(
  budget: LlmBudget,
  reservation: LlmBudgetReservation,
  actualUsd: number,
): Promise<void> {
  if (reservation.settled) return;
  const real = Number.isFinite(actualUsd) && actualUsd >= 0 ? actualUsd : reservation.amountUsd;
  budget.reservadoRunUsd = Math.max(0, budget.reservadoRunUsd - reservation.amountUsd + real);
  if (reservation.persisted === false) return;
  const admin = supabaseAdmin() as unknown as {
    rpc?: (name: string, args: Record<string, unknown>) => PromiseLike<{ data?: unknown; error: { message: string } | null }>;
  };
  if (typeof admin.rpc !== 'function') throw new Error('liquidar_presupuesto_llm: cliente Supabase sin RPC de presupuesto');
  const { data, error } = await acotada(admin.rpc('liquidar_presupuesto_llm', {
    p_reserva_id: reservation.id,
    p_costo_real_usd: Number(real.toFixed(6)),
  }), 'liquidarPresupuestoLlm');
  if (error) throw new Error(`liquidar_presupuesto_llm: ${error.message}`);
  if (data === false) throw new Error('liquidar_presupuesto_llm: reserva no activa o inexistente');
  reservation.settled = true;
}
