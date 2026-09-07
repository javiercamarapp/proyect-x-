// ═══════════════════════════════════════════════════════════════════════════
// REGISTRO DE TOOLS — cada tool se registra al importarse (registerTool).
// executeTool mide tiempo, captura excepciones (nunca tumba el loop) y aplica
// scoping por tenant vía ToolContext. Las mutaciones llevan idempotencia.
// ═══════════════════════════════════════════════════════════════════════════

import type OpenAI from 'openai';
import { logger } from '@/lib/logger';
import type { ToolExecResult } from './openrouter';
import { combineAbortSignals, runWithToolSignal, timeoutSignal } from './runtime-signal';
import { claimMutation, completeMutation, failMutation, renewMutation } from './tool-idempotency';

/** Contexto inyectado a cada handler: IDs scoped para no pedírselos al LLM. */
export interface ToolContext {
  tenantId: string;
  operadorId?: string;
  viajeId?: string;
  conversationId?: string;
  /**
   * Identidad de la corrida. SÍ forma parte de la llave del efecto (D.21,
   * frente de escala): sin ella, la fila `succeeded` de un
   * `guardar_liquidacion` vivía para siempre y un viaje REABIERTO
   * (`reabrirViaje` → `reabrir_viaje_tx`, 0159) no se podía volver a liquidar
   * NUNCA — el segundo cierre recibía `cached` con el PDF viejo, en silencio.
   */
  runId?: string;
  /** Override explícito para una mutación cuyo efecto no se identifica por viaje. */
  mutationKey?: string;
  telefono?: string;
  /**
   * El operador YA confirmó (dos veces, vía el freno del processor) que quiere
   * cerrar SIN comprobantes. Sin esta marca, `guardar_liquidacion` se niega a
   * cerrar en ceros — el hallazgo crítico del QA del 16-ago-2026: "ya subí
   * todo" sin fotos no disparaba `pareceCierre`, el freno nunca corría y el
   * LLM cerraba solo con el anticipo entero en contra del chofer,
   * irreversible. El candado vive en la TOOL porque la detección de frases es
   * exactamente lo que el ataque esquivó.
   */
  cierreEnCerosConfirmado?: boolean;
  /**
   * EL OPERADOR PIDIÓ CERRAR EN ESTE TURNO (DAT-22).
   *
   * `guardar_liquidacion` estaba disponible en TODOS los turnos del agente, y
   * es la única acción irreversible del sistema (los triggers 0036/0037
   * bloquean después cualquier alta o corrección sobre ese viaje). El único
   * freno era el del cierre EN CEROS, así que un viaje CON comprobantes se
   * podía cerrar en el turno de un "¿cuánto llevo?" —bastaba que el modelo se
   * adelantara— y el chofer se quedaba sin poder mandar el resto de su fajo.
   *
   * La marca la calcula el processor sobre el texto del turno (`pidioCerrar`),
   * no el modelo: el punto es justamente que la decisión de cerrar no dependa
   * de lo que el modelo interprete. Sin ella la tool LANZA.
   */
  cierrePedidoPorTexto?: boolean;
  /** Señal del turno; el executor también la instala como señal ambiental. */
  signal?: AbortSignal;
}

export interface RegisteredTool {
  schema: OpenAI.Chat.ChatCompletionTool;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
  isMutation?: boolean;
}

function timeoutGenericoMs(): number {
  const value = Number(process.env.LIKIDA_TOOL_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 15_000;
}

export function timeoutToolMs(isMutation?: boolean): number {
  if (!isMutation) return timeoutGenericoMs();
  const value = Number(process.env.LIKIDA_TOOL_MUTATION_TIMEOUT_MS);
  if (Number.isFinite(value) && value > 0) return Math.round(value);
  // AGEN-19C2-3 (corregido tras auditoría Fable-5): una tool marcada
  // `isMutation` (p.ej. `guardar_liquidacion`) hace 2 generaciones de PDF +
  // 2 subidas + 2 RPCs en serie — del mismo orden de magnitud que el
  // deadline genérico, y no se puede reintentar sin riesgo de duplicar
  // efectos si el timeout la corta a medio camino. Sin
  // `LIKIDA_TOOL_MUTATION_TIMEOUT_MS`, el piso es el MAYOR entre el genérico
  // y 40s — no un 40s fijo que podía darle MENOS margen que una tool de
  // sólo lectura si un deployment ya traía `LIKIDA_TOOL_TIMEOUT_MS` subido
  // por encima de eso.
  return Math.max(timeoutGenericoMs(), 40_000);
}

const REGISTRY = new Map<string, RegisteredTool>();

export function registerTool(name: string, tool: RegisteredTool): void {
  if (REGISTRY.has(name)) logger.warn('tool.reregister', { name });
  REGISTRY.set(name, tool);
}

/**
 * Devuelve los schemas (ChatCompletionTool) para los nombres dados.
 *
 * AUDITORÍA 25 (BAJO, tool-calling.md:176): un nombre sin handler registrado
 * antes desaparecía en silencio — sin `logger.warn`, sin que el llamador
 * pudiera comparar largos. Las tools del agente de dinero se registran por
 * un import de puro efecto colateral (`processor.ts`, `import
 * '@/lib/likida/tools'`); si ese import se pierde algún día (un pase de
 * "quitar imports sin usar", un bundler con `sideEffects:false`),
 * `toolSchemas` devolvía `[]`, el agente se quedaba sin tools y contestaba
 * prosa — cero errores, cero logs, el viaje nunca se cierra. Este `warn` es
 * la única señal que existiría de que "pedí N y me dieron menos".
 */
export function toolSchemas(names: string[]): OpenAI.Chat.ChatCompletionTool[] {
  const faltantes: string[] = [];
  const schemas = names
    .map((n) => {
      const s = REGISTRY.get(n)?.schema;
      if (!s) faltantes.push(n);
      return s;
    })
    .filter((s): s is OpenAI.Chat.ChatCompletionTool => Boolean(s));
  if (faltantes.length > 0) {
    logger.warn('tool.schema_faltante', { pedidos: names.length, encontrados: schemas.length, faltantes });
  }
  return schemas;
}

// BAJO (auditoría 10, reincidente) — EL ERROR CRUDO DE POSTGRES NO CRUZA HACIA
// EL MODELO.
//
// `repo.ts` envuelve el error de PostgREST como `Error("saveLiquidacion: " +
// error.message)` (mismo patrón en ~14 funciones del archivo) y lo LANZA.
// Sin filtrar aquí, ese `.message` —tal cual lo manda Postgres— llegaba a
// `ToolExecResult.error` y de ahí, sin más escalas, al `content` del mensaje
// `role: 'tool'` que el modelo LEE (`openrouter.ts`:
// `JSON.stringify(exec.success ? exec.result : { error: exec.error })`). Un
// mensaje de Postgres nombra tablas, columnas y constraints — el mismo criterio
// que ya aplica el repo para no exponer lo interno (`guardiaFundamento` filtra
// qué norma se puede citar, `redactarTexto` filtra qué PII sale en los logs)
// dice que esto tampoco debería cruzar tal cual.
//
// Se distingue por VOCABULARIO, no por origen (`err.code` ya se perdió: el
// `throw new Error(...)` de repo.ts solo conserva `.message`), así que un
// mensaje de negocio deliberado ("sin viaje activo", "el operador no
// pertenece a esta flota") pasa intacto — el modelo lo necesita para
// reaccionar — y solo se acota lo que suena a Postgres de verdad.
const VOCABULARIO_POSTGRES = /\b(relation|column|constraint|violates|duplicate key|syntax error|permission denied|invalid input syntax|null value in)\b/i;

/** El detalle completo SIGUE en el log (`logger.error`, abajo) — solo se acota lo que ve el modelo. */
function mensajeParaElModelo(mensaje: string): string {
  return VOCABULARIO_POSTGRES.test(mensaje)
    ? 'la operación no se pudo completar por un error interno de datos'
    : mensaje;
}

/** Ejecuta una tool por nombre con timing + captura de errores. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  signal?: AbortSignal,
): Promise<ToolExecResult> {
  const started = Date.now();
  const tool = REGISTRY.get(name);
  if (!tool) {
    return { success: false, result: null, error: `tool desconocida: ${name}`, durationMs: 0 };
  }
  const toolSignal = combineAbortSignals(ctx.signal, signal, timeoutSignal(timeoutToolMs(tool.isMutation)));
  const effectiveCtx = { ...ctx, signal: toolSignal };
  let durable: Awaited<ReturnType<typeof claimMutation>> | null = null;
  if (tool.isMutation && !ctx.runId) {
    logger.error('tool.mutacion_sin_run_id', { name, tenantId: ctx.tenantId });
    return { success: false, result: null, error: 'la mutación requiere una corrida identificada; no se ejecutó', durationMs: Date.now() - started };
  }
  let leaseTimer: ReturnType<typeof setInterval> | undefined;
  let keepLeaseUntilSettled = false;
  const stopLease = () => {
    if (leaseTimer) clearInterval(leaseTimer);
    leaseTimer = undefined;
  };
  if (tool.isMutation && ctx.runId) {
    try {
      durable = await runWithToolSignal(toolSignal, () => claimMutation(ctx.tenantId, mutationEffectKey(name, ctx), name));
    } catch (err) {
      const detalle = err instanceof Error ? err.message : String(err);
      if (process.env.NODE_ENV === 'test') {
        // El runtime real no entra aquí: la migración 0186 y el cliente
        // service-role proporcionan la tabla. Los tests de cadena usan un
        // mock mínimo de Supabase, por lo que ejercitan el handler sin falsear
        // una garantía de producción.
        logger.warn('tool.idempotencia_mock', { name, err: detalle });
        durable = null;
      } else {
        logger.error('tool.idempotencia_no_disponible', { name, err: detalle });
        return { success: false, result: null, error: 'la operación no se pudo proteger contra reintentos; inténtalo de nuevo', durationMs: Date.now() - started };
      }
    }
  }
  if (durable?.kind === 'cached') {
    return { success: true, result: durable.result, durationMs: Date.now() - started };
  }
  if (durable?.kind === 'busy') {
    // AGEN-19C2-8 (barrido MEDIO/BAJO): este texto es el `content` del
    // mensaje `role:'tool'` que el MODELO lee para decidir cómo
    // parafrasearlo — no un log técnico. El lease dura hasta 120s
    // (`LIKIDA_TOOL_IDEMPOTENCY_LEASE_MS`); redactado para que el modelo lo
    // traduzca a "espera un minuto y vuelve a intentar", no a un error crudo.
    return { success: false, result: null, error: 'esto ya se está procesando en otro turno tuyo; dile al operador que espere un minuto y vuelva a intentar, no que hubo un error', durationMs: Date.now() - started };
  }

  if (durable?.kind === 'execute') {
    const leaseMs = Number(process.env.LIKIDA_TOOL_IDEMPOTENCY_LEASE_MS) || 120_000;
    const renewEveryMs = Math.max(1_000, Math.floor(leaseMs / 3));
    // TOOL-CALLING-19C2-2 (barrido MEDIO/BAJO): si el handler NUNCA asienta
    // su promesa (no un timeout — de verdad colgado), el `.finally(stopLease)`
    // encadenado más abajo nunca corre, y este `setInterval` (con `.unref()`,
    // así que no sostiene el proceso él solo) sigue renovando el lease en la
    // base mientras el proceso viva por OTRA razón — un contenedor caliente
    // reusado deja ese viaje en `busy` para siempre. 10 renovaciones (~10
    // leases de margen) es un techo absoluto independiente de si el handler
    // llegó a asentar.
    const MAX_RENOVACIONES = 10;
    let renovaciones = 0;
    leaseTimer = setInterval(() => {
      renovaciones += 1;
      if (renovaciones > MAX_RENOVACIONES) {
        logger.error('tool.lease_renovacion_techo', { name, renovaciones });
        stopLease();
        return;
      }
      void runWithToolSignal(undefined, () => renewMutation(ctx.tenantId, mutationEffectKey(name, ctx), durable!.token))
        .then((ok) => { if (!ok) logger.error('tool.lease_renovacion_rechazada', { name }); })
        .catch((err) => logger.error('tool.lease_renovacion_error', { name, err: err instanceof Error ? err.message : String(err) }));
    }, renewEveryMs);
    // El lease protege el efecto, pero no debe mantener vivo por sí solo un
    // worker que ya devolvió timeout y cuyo SDK nunca resolvió su promesa.
    leaseTimer.unref?.();
  }

  let handlerSettled = true;
  let handlerPromise: Promise<unknown> | undefined;
  try {
    toolSignal?.throwIfAborted();
    // AbortSignal solo convence a un handler que coopera. El race hace que el
    // contrato del executor también tenga un deadline real para una tool que
    // olvidó pasar la señal a su SDK; la promesa subyacente queda observada y
    // no puede producir un unhandled rejection si termina después.
    handlerSettled = false;
    handlerPromise = runWithToolSignal(toolSignal, () => tool.handler(args, effectiveCtx))
      .then((result) => { handlerSettled = true; return result; }, (err) => { handlerSettled = true; throw err; });
    const result = await raceAbort(handlerPromise, toolSignal);
    // Si el handler terminó después del deadline, todavía hay que persistir el
    // éxito de una mutación antes de devolverlo: marcarla fallida abriría la
    // puerta a repetir un side effect que sí alcanzó a committear.
    if (durable?.kind === 'execute') {
      stopLease();
      // El handler puede haber terminado justo cuando venció la señal. El
      // commit del fencing debe poder archivarse para no repetir el side effect.
      //
      // Y su fallo NO puede tener la misma voz que el fallo del efecto. Cuando
      // esto vivía dentro del `try` que decide el éxito de la tool, un
      // `complete_agente_mutacion` que se pasaba del tope de 8 s de `acotada`
      // —o un fencing token que otro worker se llevó— hacía que
      // `guardar_liquidacion` respondiera `success: false` sobre un viaje que
      // ya estaba `liquidado` e irreversible por los triggers 0036/0037: el
      // PDF no se mandaba, el jefe no recibía aviso, y el modelo le explicaba
      // al chofer que su cierre no se pudo. El camino de ERROR de abajo ya
      // protegía `failMutation` así (`:208`); el de éxito era el que no.
      //
      // Perder el sello degrada a repetir trabajo, no a perder el efecto: el
      // reintento vuelve a entrar por `claim` y el backstop de dinero sigue
      // siendo la DB (`unique(viaje_id)` + upsert).
      try {
        await runWithToolSignal(undefined, () => completeMutation(ctx.tenantId, mutationEffectKey(name, ctx), durable.token, result));
      } catch (e) {
        logger.error('tool.idempotencia_sello_fallido', { name, err: e instanceof Error ? e.message : String(e) });
      }
    }
    return { success: true, result, durationMs: Date.now() - started };
  } catch (err) {
    const crudo = err instanceof Error ? err.message : String(err);
    // El log SÍ se queda con el mensaje completo — es el canal de
    // observabilidad, no el que lee el modelo.
    logger.error('tool.error', { name, err: crudo });
    if (durable?.kind === 'execute') {
      if (toolSignal?.aborted && !handlerSettled && handlerPromise) {
        keepLeaseUntilSettled = true;
        // Un handler que ignora AbortSignal puede haber committeado después de
        // que el executor devolvió timeout. Mantener el lease evita abrir una
        // ventana para duplicar el efecto; el callback confirma o sella el
        // resultado cuando la promesa real termine.
        void handlerPromise.then(
          (lateResult) => runWithToolSignal(undefined, () => completeMutation(ctx.tenantId, mutationEffectKey(name, ctx), durable!.token, lateResult)),
          (lateError) => runWithToolSignal(undefined, () => failMutation(ctx.tenantId, mutationEffectKey(name, ctx), durable!.token, lateError instanceof Error ? lateError.message : String(lateError))),
        ).catch((latePersistError) => logger.error('tool.idempotencia_fallo', { name, err: latePersistError instanceof Error ? latePersistError.message : String(latePersistError) }))
          .finally(stopLease);
      } else {
        stopLease();
        try { await runWithToolSignal(undefined, () => failMutation(ctx.tenantId, mutationEffectKey(name, ctx), durable!.token, crudo)); }
        catch (e) { logger.error('tool.idempotencia_fallo', { name, err: e instanceof Error ? e.message : String(e) }); }
      }
    }
    return {
      success: false,
      result: null,
      error: mensajeParaElModelo(crudo),
      durationMs: Date.now() - started,
    };
  } finally {
    if (!keepLeaseUntilSettled) stopLease();
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('Tool abortada', 'AbortError'));
    };
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => { if (!settled) { settled = true; cleanup(); resolve(value); } },
      (error) => { if (!settled) { settled = true; cleanup(); reject(error); } },
    );
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// LA LLAVE DEL EFECTO LLEVA `runId` — D.21 (frente de escala, 28-ago-2026).
//
// Sin él, la llave era (tool, tenant, viaje, operador) y la fila `succeeded`
// de `agente_mutacion_idempotencia` no vence nunca: un viaje que se REABRE
// (`reabrirViaje`) no se podía volver a liquidar JAMÁS — el claim devolvía
// `cached` con el resultado del cierre anterior (PDF viejo, cifras viejas) y
// el handler ni corría. En silencio, que es lo peor.
//
// Por qué `runId` en la llave y no un vencimiento de la fila:
//   · La propiedad que la llave protege es "un reintento del MISMO run no
//     cobra dos veces" — y `runId` es idéntico dentro de un run, así que esa
//     propiedad queda INTACTA (claim/lease/fencing por corrida, igual que hoy).
//   · Un TTL largo sigue bloqueando el caso real (se reabre hoy para corregir
//     y se cierra HOY); un TTL corto ya no protege ni al reintento tardío del
//     mismo run. El vencimiento no conserva ninguna de las dos propiedades.
//   · Entre corridas DISTINTAS el dinero nunca dependió de esta rejilla: lo
//     protege la base (`liquidacion_viaje_uidx` unique(viaje_id) + el upsert
//     de `guardar_liquidacion_tx`, invariante de la casa), y la concurrencia
//     real la serializa `acquireViajeLock` (processor/reabrirViaje).
// Se consideró también borrar la fila al reabrir (`reabrir_viaje_tx`): casaría
// la base con el formato de esta llave TS — un acoplamiento que se rompe en
// silencio el día que la llave cambie. Descartado por eso mismo.
//
// El executor ya rechaza mutaciones sin `runId` (arriba, fail-closed), así que
// el `?? '-'` de aquí no ocurre en una mutación real.
function mutationEffectKey(name: string, ctx: ToolContext): string {
  return ctx.mutationKey ?? [name, ctx.tenantId, ctx.viajeId ?? '-', ctx.operadorId ?? '-', ctx.runId ?? '-'].join(':');
}

/**
 * Fabrica un ToolExecutor cerrado sobre un ToolContext (para generateWithTools).
 * IDEMPOTENCIA DE MUTACIONES: una tool marcada `isMutation` no se re-ejecuta si el
 * agente la llama otra vez en el MISMO run — se devuelve el resultado cacheado.
 * Evita, p. ej., un doble guardar_liquidacion (doble PDF/costo). Solo se cachea el
 * éxito (un fallo sí puede reintentarse). El backstop de dinero sigue siendo la
 * DB (unique(viaje_id) + upsert), pero es un backstop: esta rejilla es la que
 * evita el trabajo, no solo la fila duplicada.
 */
export function makeExecutor(ctx: ToolContext) {
  // SE CACHEA LA PROMESA, NO EL RESULTADO — y por eso el tipo es Promise<…>.
  //
  // Con `ToolExecResult` la secuencia era `get` … `await` … `set`: una ventana
  // de check-then-act tan ancha como el handler. `generateWithTools` lanza TODAS
  // las tool_calls de una ronda con `Promise.all` (openrouter.ts), así que dos
  // invocaciones concurrentes pasaban las dos por el `if` con la caché vacía, el
  // handler corría dos veces y `tool.mutation_dedup` NO se disparaba: en el log
  // parecía que la rejilla había funcionado.
  //
  // Medido sobre `guardar_liquidacion`: 2 cuadres completos, 4 PDFs, 4 subidas a
  // Storage sobre las mismas dos rutas y 2 RPC de escritura. La otra rejilla
  // (`inRound`, en openrouter.ts) no lo tapaba: se llavea con
  // `nombre:JSON.stringify(args)` y basta un `{"confirmar":true}` para esquivarla
  // — nada obliga a que `arguments` sea `{}`, los schemas de tools no llevan
  // `strict: true`.
  //
  // Registrando la promesa ANTES del await, el segundo llamador se engancha a la
  // MISMA ejecución. No hay ventana: entre el `get` y el `set` no hay await.
  // La llave del mapa es un objeto por llamada (no la promesa misma): comparar
  // la promesa sin `await` en la línea de abajo activaba una alerta de CodeQL
  // (js/redundant-await-comparison) aunque la comparación es a propósito —
  // identidad de LA EJECUCIÓN, nunca de su valor resuelto. Un objeto fresco
  // por llamada preserva exactamente la misma semántica de identidad sin ese
  // patrón.
  const mutacionesHechas = new Map<string, { p: Promise<ToolExecResult> }>();
  return async (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecResult> => {
    if (REGISTRY.get(name)?.isMutation) {
      // LA LLAVE ES EL NOMBRE, no los args. Ninguna tool de Likida tiene
      // parámetros a propósito —el modelo decide CUÁNDO, nunca CON QUÉ DATOS, y
      // el efecto sale de ctx.tenantId/ctx.viajeId—, así que meter `args` en la
      // llave describía la llamada y no el efecto: un byte de diferencia, o las
      // mismas claves en otro orden, y la mutación corría dos veces. Si algún día
      // una tool sí decide sobre datos, esta llave tiene que volver a incluirlos
      // — y ese día habrá que revisar la regla de `properties: {}` antes que esta
      // línea.
      const key = name;
      const cache = mutacionesHechas.get(key);
      if (cache) { logger.warn('tool.mutation_dedup', { name }); return cache.p; }
      // `executeTool` nunca rechaza (captura y devuelve `success:false`), así que
      // esta promesa no puede quedar como rejection sin manejar.
      const entrada = { p: executeTool(name, args, ctx, signal) };
      mutacionesHechas.set(key, entrada);
      const res = await entrada.p;
      // Un FALLO no se queda cacheado: un blip de un segundo no puede convertirse
      // en un fallo permanente del turno. Se compara la entrada antes de borrar
      // para no tirar el reintento de otro llamador que ya ocupó la llave.
      if (!res.success && mutacionesHechas.get(key) === entrada) mutacionesHechas.delete(key);
      return res;
    }
    return executeTool(name, args, ctx, signal);
  };
}
