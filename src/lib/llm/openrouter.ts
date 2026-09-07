// ═══════════════════════════════════════════════════════════════════════════
// MOTOR LLM de Likida — gateway model-agnostic sobre OpenRouter.
//
// Adaptado del chasis de atiende.ai, con mejoras para Likida:
//   + Visión nativa en generateStructured (OCR de comprobantes → JSON tipado).
//   + Ruteo por rol desde ./models (no reglas médicas hardcodeadas).
//   + Fallback cross-provider automático en errores transient.
//   + Loop-guard + dedup + PartialExecutionError en el ciclo de tools
//     (para que un fallback NUNCA re-ejecute una mutación = no duplica liquidaciones).
// ═══════════════════════════════════════════════════════════════════════════

import OpenAI from 'openai';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import { modelFor, type ModelRole } from './models';
import { reserveLlmBudget, settleLlmBudget, type LlmBudget, type LlmBudgetReservation } from './budget';
// AUDITORÍA 24, TC-N1: el processor decide el degradado a cuadre con este
// helper —que atraviesa el `cause` de `PartialExecutionError`— y no con un
// `instanceof` sobre el envoltorio, que era `false` en producción.
export { esErrorDePresupuesto } from './budget';
import { runWithToolSignal } from './runtime-signal';

let _client: OpenAI | null = null;

/**
 * Tope por petición al proveedor. Ajustable por env sin deploy porque es el
 * número que hay que mover si un modelo de razonamiento entra al ruteo.
 */
export const TIMEOUT_LLM_MS = Number(process.env.LIKIDA_TIMEOUT_LLM_MS) || 30_000;

export function getClient(): OpenAI {
  if (_client) return _client;
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY no configurada');
  _client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: key,
    // ── EL SDK NO PUEDE REINTENTAR POR SU CUENTA (auditoría prod, RES-4) ───
    //
    // Por default el SDK de OpenAI reintenta DOS veces cada llamada y, ante un
    // 429, respeta el `Retry-After` del proveedor — que OpenRouter manda en
    // 60 s. Encima de eso, este archivo ya tiene su PROPIA escalera: intento,
    // reintento con nota, y fallback cross-provider. Multiplicado da hasta
    // NUEVE peticiones y minutos de espera dentro de una invocación que tiene
    // 120 s en total y que va a morir con el webhook a medio camino: Meta ya
    // recibió su 200 y no reintenta, así que la ráfaga entera se pierde.
    //
    // Los reintentos se quedan en UNA sola capa —la de aquí, que además sabe
    // cambiar de proveedor, cosa que el SDK no— y el timeout es explícito.
    // 30 s: el OCR de un comprobante contesta en 2-6 s; 30 ya es "algo está
    // mal", y deja aire para que el fallback alcance a correr.
    maxRetries: 0,
    timeout: TIMEOUT_LLM_MS,
    defaultHeaders: {
      // El fallback era `cuadra.mx`, que es un dominio PARKEADO de un tercero.
      // Aquí solo viaja en una cabecera hacia OpenRouter, así que el daño era
      // atribuirle nuestro consumo a un desconocido — pero es el mismo valor
      // equivocado que estaba impreso en el PDF.
      'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'https://likida.ai',
      'X-Title': 'Likida',
    },
  });
  return _client;
}

/**
 * Tope de salida por defecto para respuestas estructuradas.
 *
 * Estaba en 1200 y truncaba comprobantes REALES: Gemini Flash gasta 1,000–1,800
 * tokens de razonamiento invisible antes de escribir la primera llave, así que
 * el JSON (≈100 tokens) se cortaba a media línea y el ticket se reportaba como
 * "foto ilegible". Medido con 5 tickets de campo (27-jul-2026): 3 de 5 cortados
 * con `finish_reason: 'length'`; los 5 pasan con holgura arriba de 2,000.
 *
 * `max_tokens` es un TECHO, no un cargo: subirlo no cuesta nada si el modelo no
 * lo usa. Se paga lo generado.
 */
const DEFAULT_MAX_TOKENS = 4000;

// Fallback cross-provider por modelo. El primario cae a un proveedor distinto
// para que un provider caído nunca sea un error visible para el operador.
const FALLBACK: Record<string, string> = {
  // ESTA TABLA SE INDEXA POR SLUG, así que apuntar `LIKIDA_MODEL_OCR` a un
  // modelo que no esté aquí APAGA el respaldo entre proveedores EN SILENCIO.
  // Pasó el 4-ago-2026: se cambió el OCR a `gemini-3.1-flash-lite` —medido 12×
  // más barato y más certero— y `PRICES` sí se actualizó, pero esta tabla no.
  // Durante unas horas, un Gemini caído significaba dos intentos al mismo
  // proveedor muerto y un "tu foto salió ilegible" para el chofer, en vez de
  // caer a Anthropic. Quien cambie un modelo por variable de entorno tiene que
  // pasar por aquí: no hay error, no hay log, solo deja de haber plan B.
  'google/gemini-3.1-flash-lite': 'anthropic/claude-haiku-4.5',
  'google/gemini-3.6-flash': 'anthropic/claude-haiku-4.5',
  'google/gemini-3.5-flash-lite': 'openai/gpt-5.6-luna',
  // El conserje del chat del panel (chat_ligero): si OpenAI se cae, el
  // saludo lo contesta flash-lite — cruce de proveedor, texto puro.
  'openai/gpt-5-nano': 'google/gemini-3.5-flash-lite',
  'anthropic/claude-sonnet-5': 'openai/gpt-5.6-terra',
  'anthropic/claude-opus-5': 'anthropic/claude-sonnet-5',
  // Mismo hueco, dormido: `53492a3` (4-ago-2026) agregó estos tres a PRICES
  // como candidatos del MISMO benchmark de OCR que dio 3.1-flash-lite (ver
  // arriba) — no son de texto (chat/router), son de VISIÓN. Si algún día
  // `LIKIDA_MODEL_OCR` apunta a uno de ellos, el respaldo tiene que seguir
  // leyendo imagen: mismo criterio que 3.6-flash y 3.1-flash-lite
  // (claude-haiku-4.5 hace visión), no el de 3.5-flash-lite (texto puro →
  // gpt-5.6-luna, que no necesita leer un comprobante).
  'google/gemini-2.5-flash-lite': 'anthropic/claude-haiku-4.5',
  'google/gemini-2.5-flash': 'anthropic/claude-haiku-4.5',
  'google/gemini-3-flash-preview': 'anthropic/claude-haiku-4.5',
  // Los roles por área (16-ago-2026) — cruce de proveedor en cada uno.
  // REGLA FINAL de ese día: TODO el stack del repo —defaults Y respaldos—
  // es de proveedores USA; un fallback fuera de esa lista violaría la
  // regla justo cuando el primario está caído.
  'openai/gpt-5.6-luna': 'google/gemini-3.5-flash-lite',
  'openai/gpt-oss-120b': 'google/gemini-3.5-flash-lite',
  'openai/gpt-oss-20b': 'google/gemini-3.5-flash-lite',
};

/**
 * Modelos de `PRICES` AISLADOS de la red de respaldo: ni tienen su propia
 * entrada en `FALLBACK` (pueden ser el primario y caer a otro proveedor) ni
 * aparecen como destino de la de alguien más (son ya el plan B de otro
 * modelo, y ahí termina la cadena a propósito — encadenar fallback tras
 * fallback no tiene fin). Un modelo AISLADO es el mismo bug que `cc2d6b8`,
 * dormido: `FALLBACK[model] ?? null` cae a `null` en cuanto ese modelo se
 * vuelva el override activo de un rol — sin error, sin log, solo deja de
 * haber plan B. Exportado solo para que la prueba de cobertura lo enumere
 * sin exponer las tablas completas.
 */
export function modelosAisladosDeFallback(): string[] {
  const enLaRed = new Set([...Object.keys(FALLBACK), ...Object.values(FALLBACK)]);
  return Object.keys(PRICES).filter((modelo) => !enLaRed.has(modelo));
}

/**
 * Un resumen legible de POR QUÉ falló una llamada al modelo, cavando en la
 * cadena de `.cause` (el SDK de OpenAI entierra ahí el detalle real: status,
 * mensaje del provider, el `fetch failed` de undici). Devuelve algo como
 * "401 Unauthorized" o "getaddrinfo ENOTFOUND" en vez de perder la causa.
 *
 * AUDITORÍA 1 (Operabilidad + tool-calling): sin esto, todo fallo de OCR/tools
 * salía al log como el mismo string fijo y era indistinguible en Sentry.
 */
export function resumenCausa(err: unknown, profundidad = 3): string {
  const partes: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < profundidad && cur; i++) {
    const o = cur as { status?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    if (typeof o?.status === 'number' || typeof o?.status === 'string') partes.push(`status=${o.status}`);
    if (typeof o?.code === 'string') partes.push(o.code);
    const m = cur instanceof Error ? cur.message : typeof cur === 'string' ? cur : undefined;
    if (m && !partes.includes(m)) partes.push(m);
    cur = o?.cause;
  }
  const txt = [...new Set(partes)].filter(Boolean).join(' · ').slice(0, 300);
  return txt || 'sin detalle de causa';
}

export function isTransientError(err: unknown): boolean {
  // POR TIPO ANTES QUE POR TEXTO. El SDK de OpenAI aplasta CUALQUIER fallo de
  // conexión —DNS, TCP rechazado, TLS, `fetch failed` de undici— en un
  // `APIConnectionError` con el mensaje literal "Connection error."; el detalle
  // real vive en `err.cause`. Clasificar solo por el mensaje dejaba fuera justo
  // el caso para el que existe el fallback: el proveedor caído. Los 503 sí
  // pasaban, y por eso los tests no lo vieron.
  const e = err as { name?: unknown; status?: unknown; cause?: unknown } | null;
  if (e && typeof e === 'object') {
    if (typeof e.name === 'string' && /^APIConnection(Timeout)?Error$/.test(e.name)) return true;
    if (typeof e.status === 'number' && (e.status >= 500 || e.status === 429 || e.status === 408)) return true;
  }
  const texto = [err, e?.cause]
    .map((x) => (x instanceof Error ? x.message : typeof x === 'string' ? x : ''))
    .join(' ')
    .toLowerCase();
  // EL CÓDIGO HTTP TIENE QUE VERSE COMO CÓDIGO, NO COMO SUBCADENA. `\b5\d\d\b`
  // solo. Un folio (`FOLIO-502`) o un monto de un `check constraint`
  // (`monto 503.00 excede el tope`) contienen tres dígitos que empiezan en 5 con
  // frontera de palabra a los dos lados —"-" y "." NO son caracteres de
  // palabra—, así que el error de UN DATO se leía como el 502/503 de un
  // PROVEEDOR caído y el fallback cruzaba de proveedor por un ticket, no por una
  // caída real. Se excluye cuando el dígito viene pegado a `$`/`-` (folio o
  // importe con signo) o seguido de `.dígito` (importe decimal): un código HTTP
  // de verdad no aparece así en un mensaje.
  return (
    /(?<![$\-\w])(5\d\d|429|408)(?!\.\d)\b/.test(texto) ||
    /timeout|timed out|connection error|fetch failed|network|econnreset|enotfound|rate.?limit|overloaded|capacity/i.test(texto)
  );
}

// Precios [in, out] por 1M tokens — safety net; ver models.ts para el stack.
const PRICES: Record<string, [number, number]> = {
  'google/gemini-3.6-flash': [1.5, 7.5],
  // Verificado contra el catálogo público de OpenRouter el 12-ago-2026.
  'openai/gpt-5-nano': [0.05, 0.4],
  'google/gemini-3.5-flash-lite': [0.3, 2.5],
  // Añadidos el 4-ago-2026 al medir OCR: sin ellos, `calcCost` caía a la red de
  // seguridad (tarifa más cara) y reportaba ~$0.030 por comprobante donde el
  // costo real es ~$0.0016. La red hizo su trabajo —salió alto y por eso se
  // miró— pero un modelo sin precio no se puede comparar contra otro.
  'google/gemini-3.1-flash-lite': [0.25, 1.5],
  'google/gemini-2.5-flash-lite': [0.1, 0.4],
  'google/gemini-2.5-flash': [0.3, 2.5],
  'google/gemini-3-flash-preview': [0.5, 3],
  // $2/$10 es el precio ESTÁNDAR de Sonnet 5: el aumento a $3/$15 anunciado
  // para el 1-sep-2026 fue cancelado (verificado el 23-ago; ver models.ts).
  // Aquí decía "revertir a [3,15] después del 31-ago" — dos verdades sobre el
  // mismo precio, y la de aquí subía 50 % la reserva del cuadre (TC-N6).
  'anthropic/claude-sonnet-5': [2, 10],
  'anthropic/claude-opus-5': [5, 25],
  'anthropic/claude-haiku-4.5': [1, 5],
  'openai/gpt-5.6-terra': [1, 6],
  // Luna re-verificada el 16-ago-2026: bajó a $0.10/$0.60 (la entrada
  // anterior [1,6] era de su lanzamiento) — es el rol `analisis`.
  'openai/gpt-5.6-luna': [0.10, 0.60],
  // El stack barato del back office (open-weight de OpenAI) — verificado
  // contra el catálogo público de OpenRouter el 16-ago-2026.
  'openai/gpt-oss-120b': [0.03, 0.17],
  'openai/gpt-oss-20b': [0.03, 0.13],
};

/**
 * Costo en USD de una llamada.
 *
 * Un modelo sin precio NO cuesta $0. Antes devolvía 0 en silencio, y eso pasa de
 * verdad: OpenRouter a veces devuelve el slug con sufijo de proveedor
 * (`:nitro`, `:floor`), y sobre todo pasa cada vez que alguien cambia de modelo
 * y no toca la tabla. El resultado era una liquidación que parecía gratis.
 *
 * Para un negocio que va a cobrar POR LIQUIDACIÓN, un costo que se subestima en
 * silencio es peor que uno que se equivoca ruidosamente: nadie mira lo que
 * parece correcto.
 */
/**
 * El costo REAL de una llamada: el que reporta el proveedor si viene, y solo si
 * no viene se recalcula con la tabla.
 *
 * POR QUÉ ESTE ORDEN. `calcCost` multiplica tokens por tarifa de lista, y eso es
 * ciego a todo lo que el proveedor descuenta. Medido el 4-ago-2026 contra
 * OpenRouter con el mismo system de 9,543 tokens dos veces seguidas:
 *
 *     llamada 1  cache_write_tokens 9543   cost $0.0239715
 *     llamada 2  cached_tokens      9543   cost $0.0020226   (-91.6%)
 *
 * La tabla decía $0.0181 en las dos. O sea que la caché de prompt SÍ estaba
 * funcionando y el contador no podía verla: se habría reportado "0% de ahorro"
 * sobre una optimización que ahorra el 92%, y lo lógico habría sido revertirla.
 *
 * Arregla además dos cosas que ya habían mordido: un modelo que no está en
 * `PRICES` (se estimaba con la tarifa más cara, 20× de más) y los precios que
 * caducan — el intro de Sonnet vence el 31-ago-2026 y la tabla no se entera.
 */
export function costoReal(
  usage: { cost?: number } | undefined,
  model: string,
  tokIn: number,
  tokOut: number,
): number {
  const delProveedor = usage?.cost;
  if (typeof delProveedor === 'number' && Number.isFinite(delProveedor) && delProveedor >= 0) {
    return delProveedor;
  }
  return calcCost(model, tokIn, tokOut);
}

export function calcCost(model: string, tokIn: number, tokOut: number): number {
  // El sufijo de proveedor no cambia el precio del modelo.
  const limpio = model.split(':')[0];
  const r = PRICES[model] ?? PRICES[limpio];
  if (r) return (tokIn * r[0] + tokOut * r[1]) / 1_000_000;

  // Desconocido: se estima con la tarifa MÁS CARA de la tabla y se avisa. Que
  // salga alto es justo lo que hace que alguien lo mire.
  const caro = Object.values(PRICES).reduce(
    (max, p) => [Math.max(max[0], p[0]), Math.max(max[1], p[1])] as [number, number],
    [0, 0] as [number, number],
  );
  logger.warn('llm.modelo_sin_precio', { model, estimadoCon: 'tarifa más cara de la tabla' });
  return (tokIn * caro[0] + tokOut * caro[1]) / 1_000_000;
}

// OpenRouter: no retener input (compliance de datos fiscales).
const PROVIDER_OPTS = {
  provider: { data_collection: 'deny' },
  // Pide el desglose REAL de consumo, incluido `cost` y los tokens de caché.
  // Sin esto OpenRouter no manda el costo y hay que recalcularlo a mano — que
  // es justo lo que ocultaba el ahorro de la caché (ver `costoReal`).
  usage: { include: true },
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// EL RAZONAMIENTO DEL CONTADOR — apagado, no medido (E.26).
//
// Hallazgo del primer examen real (28-ago-2026): con el corpus completo en
// el prompt (~74k tokens) y sin desactivar el razonamiento oculto de Sonnet
// 5, `max_tokens: 900` se lo comió ENTERO en "reasoning" —
// `finish_reason: 'length'`, `content: null` — y la corrida calificó 15/23
// fácticas como «abstención» cuando el modelo nunca llegó a escribir una
// respuesta. Es el vicio que la regla 6 del encargo prohíbe: una falla de
// infraestructura silenciada y leída como comportamiento del examinado.
//
// Al contrario del OCR (arriba), aquí no hace falta medir contra un conjunto
// dorado antes de apagarlo: el FORMATO del prompt (RESPUESTA/FUNDAMENTO/
// CERTEZA) YA es el andamiaje de razonamiento, expuesto y auditable — el
// razonamiento oculto no le agrega nada que el examen pueda calificar, y si
// algún día se quisiera medir si ayuda, se hace con el mismo método: conjunto
// dorado antes y después, nunca "se ve mejor".
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// EL RAZONAMIENTO DEL OCR — la palanca de costo más grande, y la más peligrosa.
//
// MEDIDO el 4-ago-2026 sobre las 57 llamadas de OCR en producción: la salida
// promedia 1,536 tokens, con 51 de 57 entre 1,015 y 1,976. El JSON del schema
// son ~300. El resto son tokens de RAZONAMIENTO del modelo, que OpenRouter
// cobra como salida — y la salida cuesta varias veces más que la entrada.
//
// Que la distribución sea UNA sola joroba es lo que lo demuestra: si fueran
// reintentos (que este archivo suma en `gastado`) habría dos o tres grupos
// separados, no una campana. No los hay.
//
// Apagarlo bajaría la salida ~80% y el costo del OCR a la mitad o menos.
//
// POR QUÉ VIENE APAGADO POR DEFECTO. El razonamiento es probablemente lo que
// hace que lea un ticket térmico arrugado, con sol encima, fotografiado en una
// gasolinera. Y en ESTE producto un OCR peor no es "menor calidad": es un monto
// mal leído dentro de un documento fiscal — exactamente lo que la regla número
// uno del repo prohíbe. Un ahorro del 50% que introduce un error de captura
// cada tantos tickets sale carísimo.
//
// CÓMO SE ENCIENDE, BIEN: se mide primero contra un conjunto dorado de tickets
// reales etiquetados a mano (precisión del monto y del folio, tasa de esquema
// inválido), y solo se deja si NO pierde exactitud. Sin ese set, "se ve bien"
// no es evidencia. Existe la skill `conjunto-dorado` para armarlo.
//
// Se controla por entorno para poder probarlo sin desplegar:
//   LLM_RAZONAMIENTO_OCR=off    → sin razonamiento (barato, sin verificar)
//   LLM_RAZONAMIENTO_OCR=low    → razonamiento mínimo
//   (sin variable)              → como hoy, sin tocar nada
// ═══════════════════════════════════════════════════════════════════════════
function opcionesDeRazonamiento(role: ModelRole): Record<string, unknown> {
  // El contador (E.26) también apaga el razonamiento oculto — ver la nota
  // «EL RAZONAMIENTO DEL CONTADOR» arriba de este archivo para el porqué.
  if (role === 'contador') return { reasoning: { enabled: false } };
  if (role !== 'ocr') return {};
  const v = (process.env.LLM_RAZONAMIENTO_OCR ?? '').trim().toLowerCase();
  if (v === 'off' || v === 'none' || v === '0') return { reasoning: { enabled: false } };
  if (v === 'low' || v === 'minimal') return { reasoning: { effort: 'low' } };
  return {};
}

// ── generateResponse: chat simple con fallback ──────────────────────────────
export async function generateResponse(opts: {
  role: ModelRole;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  budget?: LlmBudget;
}) {
  const model = modelFor(opts.role);
  const fallback = FALLBACK[model] ?? null;

  const once = async (m: string) => {
    opts.signal?.throwIfAborted();
    // CACHÉ DE PROMPT — la misma palanca (y el mismo razonamiento medido) que
    // en `generateWithTools`: si el modelo es de Anthropic, el SYSTEM se marca
    // con el breakpoint y las llamadas siguientes con el mismo prefijo pagan
    // la lectura al 10%. Importa aquí porque el CONTADOR (E.26) manda el
    // corpus normativo completo (~45k tokens) idéntico en cada una de sus 32
    // preguntas — sin la marca, el examen re-paga el corpus entero 32 veces.
    // Un modelo que no entiende `cache_control` la ignora — no rompe.
    const sistema = /anthropic\//.test(m)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? ({ role: 'system', content: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }] } as any)
      : { role: 'system' as const, content: opts.system };
    const body = {
      model: m,
      messages: [sistema, ...opts.messages],
      max_tokens: opts.maxTokens ?? 500,
      temperature: opts.temperature ?? 0.4,
      ...opcionesDeRazonamiento(opts.role),
      ...PROVIDER_OPTS,
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
    const reservation = opts.budget
      ? await reserveLlmBudget(opts.budget, calcCost(m, Math.max(1, cotaEntradaEnTokens(body.messages)), Number(body.max_tokens ?? 500)))
      : null;
    let settled = false;
    const settle = async (amount: number) => {
      if (!reservation || settled) return;
      settled = true;
      try { await settleLlmBudget(opts.budget!, reservation, amount); }
      catch (e) { logger.error('llm.presupuesto_no_liquidado', { runId: opts.budget?.runId, err: e instanceof Error ? e.message : String(e) }); }
    };
    try {
      const res = await getClient().chat.completions.create(body, opts.signal ? { signal: opts.signal } : undefined);
      const tokensIn = res.usage?.prompt_tokens ?? 0;
      const tokensOut = res.usage?.completion_tokens ?? 0;
      const costo = costoReal(res.usage as { cost?: number } | undefined, m, tokensIn, tokensOut);
      const usageValido = Boolean(res.usage && (tokensIn > 0 || tokensOut > 0 || typeof (res.usage as { cost?: unknown }).cost === 'number'));
      const costoContabilizado = usageValido ? costo : reservation?.amountUsd ?? costo;
      await settle(costoContabilizado);
      // Si el proveedor omite `usage`, el ledger conserva la reserva por
      // seguridad. El resultado público debe reflejar lo mismo; devolver 0
      // aquí haría que el Redactor/runner subestimara su gasto aunque la RPC
      // central ya hubiera retenido la reserva.
      //
      // TOOL-CALLING-19C2-1 (barrido MEDIO/BAJO): `costoContabilizado` en
      // ese caso es la RESERVA (una cota conservadora), no lo medido de
      // verdad — mismo patrón que `noMedido` en `intake/ocr.ts`. Sin la
      // marca, un consumidor (p.ej. `redactor.ts`) lo escribía en
      // `llm_costo` como si fuera una cifra real.
      return {
        text: (res.choices[0]?.message?.content ?? '').trim(), model: res.model || m, tokensIn, tokensOut, cost: costoContabilizado,
        ...(usageValido ? {} : { noMedido: true as const }),
      };
    } catch (e) {
      // BACKEND-19C2-1: antes se liquidaba aquí al monto RESERVADO (el
      // estimado, no lo que de verdad se gastó) — una racha de
      // timeouts/red inestable podía agotar el tope diario del tenant sin
      // que se hubiera consumido nada real. Ahora se deja la fila en
      // 'reservado': la 0193 (expira_en) la excluye sola del tope diario
      // tras el margen de gracia si de verdad nunca hubo uso.
      if (reservation) logger.error('llm.reserva_sin_liquidar_por_error', { runId: opts.budget?.runId, reservaId: reservation.id, err: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  };

  try {
    return await once(model);
  } catch (err) {
    if (!fallback || !isTransientError(err)) throw err;
    logger.warn('llm.fallback', { from: model, to: fallback });
    return await once(fallback);
  }
}

// Extrae el objeto JSON de una respuesta: quita fences markdown (```json) y
// recorta prosa alrededor, tolerando modelos que no respetan response_format.
function extractJson(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return s;
}

// ── generateStructured: JSON garantizado por schema, con VISIÓN opcional ─────
export class StructuredError extends Error {
  constructor(
    message: string,
    public cause?: unknown,
    public raw?: string,
    /** Consumo de la llamada que falló: se cobra igual, hay que contabilizarlo. */
    public usage?: { model: string; tokensIn: number; tokensOut: number; cost: number },
  ) {
    super(message);
    this.name = 'StructuredError';
  }
}

/**
 * La respuesta se CORTÓ por presupuesto (`finish_reason: 'length'`), no vino
 * malformada. Distinguirlo importa: un JSON truncado no se arregla pidiéndole
 * al modelo que "responda solo JSON" (ya lo hacía), ni es culpa de la imagen.
 * Los modelos con razonamiento gastan cientos de tokens invisibles antes de
 * escribir la primera llave, así que el tope se agota sin producir salida.
 */
export class TruncatedError extends StructuredError {
  constructor(
    message: string,
    public tokensUsados: number,
    public tope: number,
    raw?: string,
    usage?: { model: string; tokensIn: number; tokensOut: number; cost: number },
  ) {
    super(message, undefined, raw, usage);
    this.name = 'TruncatedError';
  }
}

/**
 * Cota superior de tokens de entrada para RESERVAR antes de llamar al proveedor.
 *
 * Se sigue contando el texto a razón de UN token por carácter: es una cota
 * conservadora deliberada (~4× de más) que evita que un retry o un fallback
 * gasten sin autorización previa, y liquidar al costo real la corrige después.
 *
 * Lo que NO se puede contar así es una imagen. `generateStructured` mete el
 * data-URL base64 completo dentro de `messages`, y un modelo de visión cobra
 * una imagen a TARIFA FIJA de unos cientos de tokens, no por byte. Contarla por
 * carácter hacía que una foto de 3 MB —la que `api/dashboard/ingesta/limites.ts`
 * admite por escrito diciendo «una foto de celular normal cabe»— pidiera una
 * reserva de $0.75 contra un techo de $0.50 y muriera ANTES de tocar al
 * proveedor. El chofer mandaba su ticket y leía «fallo técnico»; el costo real
 * de esa llamada, medido en las tarifas de arriba, es ~$0.0016.
 *
 * `TOKENS_POR_IMAGEN` es holgado a propósito: los modelos de visión que este
 * repo usa cobran del orden de cientos de tokens por imagen, así que 4,000
 * sigue sobre-reservando sin volver a hacerlo por byte.
 */
export const TOKENS_POR_IMAGEN = 4_000;

/**
 * `input_audio.data` es, igual que la imagen, base64 crudo cuyo TAMAÑO no
 * tiene relación con lo que el proveedor cobra: el audio se cobra por
 * duración (~32 tok/s medido, ver tabla 2 de `docs/auditoria-25/rendimiento.md`),
 * no por byte. Contarlo a un token por carácter (como el resto del texto)
 * hacía que 1.24 MB de audio —una nota de 78 s cuyo costo real es ~$0.0008—
 * reservaran el tope entero de la corrida ($0.50, `budget.ts`) y el chofer en
 * emergencia se quedara sin canal de voz.
 *
 * Se estima la duración asumiendo el bitrate comprimido MÁS BAJO razonable
 * para voz (16 kbps): una cota conservadora, no una medición. WhatsApp manda
 * sus notas nativas en opus a ~24-32 kbps y un audio reenviado suele ir más
 * alto (128 kbps o más); asumir el piso hace que la duración estimada quede
 * SIEMPRE por arriba de la real, así que la reserva sigue sobre-cotizando el
 * costo real — solo que ya no por un factor de cientos.
 */
const BITS_POR_SEGUNDO_AUDIO_MIN = 16_000;
/** ~32 tok/s medido; ×3 de margen deliberado sobre la medición. */
const TOKENS_POR_SEGUNDO_AUDIO = 100;

function tokensPorAudioBase64(base64: string): number {
  const bytes = (base64.length * 3) / 4;
  const segundos = (bytes * 8) / BITS_POR_SEGUNDO_AUDIO_MIN;
  return Math.ceil(segundos * TOKENS_POR_SEGUNDO_AUDIO);
}

export function cotaEntradaEnTokens(messages: unknown): number {
  let imagenes = 0;
  let tokensAudio = 0;
  const sinDataUrl = JSON.stringify(messages, (clave, valor) => {
    // Solo el `url` de una parte `image_url`; cualquier otro string se cuenta
    // entero, que es lo que mantiene la cota conservadora para el texto.
    if (clave === 'url' && typeof valor === 'string' && valor.startsWith('data:')) {
      imagenes += 1;
      return '';
    }
    // Una parte `input_audio`: su `data` se descuenta del conteo por
    // carácter y se reemplaza por la estimación por duración de arriba.
    if (
      valor &&
      typeof valor === 'object' &&
      (valor as { type?: unknown }).type === 'input_audio' &&
      typeof (valor as { input_audio?: { data?: unknown } }).input_audio?.data === 'string'
    ) {
      const audio = valor as { input_audio: { data: string; format?: string } };
      tokensAudio += tokensPorAudioBase64(audio.input_audio.data);
      return { type: 'input_audio', input_audio: { data: '', format: audio.input_audio.format } };
    }
    return valor;
  });
  return (sinDataUrl?.length ?? 0) + imagenes * TOKENS_POR_IMAGEN + tokensAudio;
}

export async function generateStructured<T>(opts: {
  role: ModelRole;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  schema: z.ZodType<T>;
  schemaName: string;
  /**
   * Corta la llamada cuando el presupuesto de la invocación se acaba.
   *
   * Sin esto se cae al default del SDK de OpenAI —10 minutos—, y el webhook solo
   * tiene 60s: una foto lenta se lleva por delante la invocación entera,
   * incluido el "listo" que sí venía bien medido. Y como Meta ya recibió su 200,
   * no reintenta: el mensaje se pierde en silencio.
   */
  signal?: AbortSignal;
  /** Data-URLs de imágenes (OCR de comprobantes). Se adjuntan al último mensaje user. */
  images?: string[];
  /**
   * Audios en base64 (transcripción de notas de voz, Capa E1). Mismo viaje que
   * `images`: se adjuntan al último mensaje user como partes `input_audio`.
   * `format` es el de OpenRouter ('ogg', 'mp3', 'wav', 'mp4'…) — el tipo del
   * SDK de OpenAI solo enumera wav/mp3, pero OpenRouter pasa el formato al
   * proveedor tal cual (Gemini acepta el OGG/Opus de WhatsApp); por eso el
   * cast de abajo. Un modelo sin oído devuelve 400 — no transitorio, no hay
   * fallback: el llamador decide qué decirle al usuario.
   */
  audios?: { data: string; format: string }[];
  maxTokens?: number;
  temperature?: number;
  /** Reserva dura por corrida/tenant antes de cada intento, incluido fallback. */
  budget?: LlmBudget;
}): Promise<{ data: T; raw: string; model: string; tokensIn: number; tokensOut: number; cost: number }> {
  const model = modelFor(opts.role);
  const fallback = FALLBACK[model] ?? null;
  const jsonSchema = z.toJSONSchema(opts.schema, { target: 'draft-7' }) as Record<string, unknown>;

  // OpenRouter/OpenAI json_schema exige additionalProperties:false en cada objeto.
  const strictify = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    if (o.type === 'object' && o.additionalProperties === undefined) o.additionalProperties = false;
    for (const v of Object.values(o)) {
      if (Array.isArray(v)) v.forEach(strictify);
      else if (typeof v === 'object') strictify(v);
    }
  };
  strictify(jsonSchema);

  // Construir mensajes; si hay imágenes, el último user lleva content multimodal.
  const built: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: opts.system },
    ...opts.messages.map((m) => ({ role: m.role, content: m.content })),
  ];
  if (opts.images?.length || opts.audios?.length) {
    const lastUserIdx = [...built].map((m) => m.role).lastIndexOf('user');
    const parts: OpenAI.Chat.ChatCompletionContentPart[] = [
      { type: 'text', text: typeof built[lastUserIdx]?.content === 'string' ? (built[lastUserIdx].content as string) : 'Extrae los datos de estas imágenes.' },
      ...(opts.images ?? []).map((url) => ({ type: 'image_url' as const, image_url: { url } })),
      // El cast: el SDK de OpenAI enumera solo wav/mp3 en `format`, pero
      // OpenRouter reenvía el formato al proveedor (Gemini sí recibe 'ogg').
      ...(opts.audios ?? []).map((a) => ({ type: 'input_audio', input_audio: { data: a.data, format: a.format } }) as unknown as OpenAI.Chat.ChatCompletionContentPart),
    ];
    if (lastUserIdx >= 0) built[lastUserIdx] = { role: 'user', content: parts };
    else built.push({ role: 'user', content: parts });
  }

  // OpenRouter cobra la llamada aunque el JSON venga truncado o no valide. El
  // `usage` ya viajaba dentro del error para eso, pero cuando el reintento salía
  // bien ese error se descartaba y su consumo con él: se reportaba UN intento
  // habiendo pagado dos, tres o cuatro. Likida va a cobrar por liquidación, así
  // que un costo unitario subestimado se propaga directo al precio.
  const gastado = { tokensIn: 0, tokensOut: 0, cost: 0 };
  const cobrar = (u: { tokensIn: number; tokensOut: number; cost: number }) => {
    gastado.tokensIn += u.tokensIn;
    gastado.tokensOut += u.tokensOut;
    gastado.cost += u.cost;
  };

  const attempt = async (m: string, note?: string, tope?: number): Promise<{ data: T; raw: string; model: string; tokensIn: number; tokensOut: number; cost: number }> => {
    // Si el presupuesto ya se agotó, no se paga una llamada que se va a cortar a
    // media respuesta.
    opts.signal?.throwIfAborted();
    const msgs = note
      ? [{ role: 'system' as const, content: `${opts.system}\n\n${note}` }, ...built.slice(1)]
      : built;
    const maxTokens = tope ?? opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    // Si el presupuesto ya se agotó, no se paga una llamada que se va a cortar a
    // media respuesta.
    opts.signal?.throwIfAborted();
    const body = {
      model: m,
      messages: msgs,
      max_tokens: maxTokens,
      temperature: opts.temperature ?? 0,
      response_format: {
        type: 'json_schema',
        json_schema: { name: opts.schemaName, strict: true, schema: jsonSchema },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      ...opcionesDeRazonamiento(opts.role),
      ...PROVIDER_OPTS,
    };
    const reservation = opts.budget
      ? await reserveLlmBudget(opts.budget, calcCost(m, Math.max(1, cotaEntradaEnTokens(body.messages) + JSON.stringify(jsonSchema).length), maxTokens))
      : null;
    let settled = false;
    const settle = async (amount: number) => {
      if (!reservation || settled) return;
      settled = true;
      try { await settleLlmBudget(opts.budget!, reservation, amount); }
      catch (e) { logger.error('llm.presupuesto_no_liquidado', { runId: opts.budget?.runId, err: e instanceof Error ? e.message : String(e) }); }
    };
    let res: OpenAI.Chat.ChatCompletion;
    try {
      res = await getClient().chat.completions.create(body, opts.signal ? { signal: opts.signal } : undefined);
    } catch (e) {
      // BACKEND-19C2-1: ver el mismo fix en `generateResponse` — no liquidar
      // al monto reservado en error/abort, dejar la fila 'reservado' para
      // que la 0193 (expira_en) la excluya sola del tope diario.
      if (reservation) logger.error('llm.reserva_sin_liquidar_por_error', { runId: opts.budget?.runId, reservaId: reservation.id, err: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    const raw = res.choices[0]?.message?.content || '';
    // La llamada se cobra aunque falle: el consumo viaja EN el error para que el
    // contador por liquidación no reporte $0 en los intentos fallidos.
    const tokIn = res.usage?.prompt_tokens ?? 0;
    const tokOut = res.usage?.completion_tokens ?? 0;
    const usage = { model: res.model || m, tokensIn: tokIn, tokensOut: tokOut, cost: costoReal(res.usage as { cost?: number } | undefined, m, tokIn, tokOut) };
    const usageValido = Boolean(res.usage && (tokIn > 0 || tokOut > 0 || typeof (res.usage as { cost?: unknown }).cost === 'number'));
    await settle(usageValido ? usage.cost : reservation?.amountUsd ?? usage.cost);
    // Se cobra AQUÍ, antes de cualquier salida: pase lo que pase debajo —
    // truncado, JSON roto, schema inválido— esta llamada ya se pagó.
    cobrar(usage);

    // Se cortó por presupuesto: NO es JSON malformado ni una foto mala. Se
    // detecta ANTES de parsear, porque el parseo también falla y confunde el
    // diagnóstico (era el bug: truncamiento disfrazado de "ilegible").
    if (res.choices[0]?.finish_reason === 'length') {
      throw new TruncatedError(
        `Respuesta truncada: se agotaron los ${maxTokens} tokens de salida (usó ${tokOut}) antes de cerrar el JSON`,
        tokOut,
        maxTokens,
        raw,
        usage,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(raw));
    } catch (e) {
      throw new StructuredError('JSON parse falló', e, raw, usage);
    }
    const v = opts.schema.safeParse(parsed);
    if (!v.success) throw new StructuredError(`Validación falló: ${v.error.message}`, v.error, raw, usage);
    // Se devuelve el ACUMULADO del turno, no el de este intento: el llamador
    // quiere saber qué costó extraer este comprobante, no qué costó el último
    // reintento.
    return { data: v.data, raw, model: usage.model, ...gastado };
  };

  /**
   * Deja el consumo ACUMULADO del turno en el error que sale a la superficie.
   * Sin esto el llamador solo veía el del último intento y descontaba de menos
   * justo en el caso más caro: el que falló varias veces antes de rendirse.
   */
  const conGastado = (e: unknown, msg: string): StructuredError => {
    // AUDITORÍA 1, CRÍTICO (Operabilidad) + tool-calling: el mensaje llevaba
    // solo "Falló generación estructurada", y la causa real (401 por llave rota,
    // provider caído, schema roto) quedaba enterrada en `.cause` — indistinguible
    // en el log y en Sentry. Se sube al MENSAJE, que es lo único que casi todos
    // los `logger.error({ err: e.message })` del repo leen.
    const err = e instanceof StructuredError ? e : new StructuredError(`${msg}: ${resumenCausa(e)}`, e);
    err.usage = { model, ...gastado };
    return err;
  };

  const note = 'IMPORTANTE: responde EXCLUSIVAMENTE con JSON válido que cumpla el schema, sin markdown ni texto extra.';
  const tope = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  try {
    return await attempt(model);
  } catch (e1) {
    // Truncamiento: reintentar con la nota NO sirve — el modelo ya estaba
    // respondiendo JSON, se quedó sin presupuesto a media escritura. Lo único
    // que falta es techo, así que el reintento sube el tope en vez de regañarlo.
    if (e1 instanceof TruncatedError) {
      logger.warn('llm.truncado', { fn: 'generateStructured', model, tope: e1.tope, usados: e1.tokensUsados, reintentoCon: tope * 2 });
      try {
        return await attempt(model, undefined, tope * 2);
      } catch (eT) {
        // Si el doble tampoco alcanza, el problema es real: no lo disfraces
        // pasándolo por la escalera de "formato malo". Se relanza tal cual para
        // conservar el diagnóstico, pero con el consumo de AMBOS intentos: el
        // error trae el suyo, y el del primero se perdía.
        if (eT instanceof TruncatedError) { eT.usage = { model, ...gastado }; throw eT; }
      }
    }
    // Reintento con el MISMO modelo + nota (típicamente errores de formato JSON).
    try {
      return await attempt(model, note);
    } catch (e2) {
      // CR-5: si el fallo es transient (provider caído/429/timeout) y hay
      // fallback cross-provider, intentar con OTRO proveedor antes de rendirse.
      if (fallback && (isTransientError(e1) || isTransientError(e2))) {
        logger.warn('llm.fallback', { fn: 'generateStructured', from: model, to: fallback });
        try {
          return await attempt(fallback, note);
        } catch (e3) {
          throw conGastado(e3, 'Falló generación estructurada (fallback)');
        }
      }
      throw conGastado(e2, 'Falló generación estructurada');
    }
  }
}

// ── generateWithTools: ciclo agéntico completo ──────────────────────────────
export type ToolExecResult = { success: boolean; result: unknown; error?: string; durationMs: number };
export type ToolExecutor = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolExecResult>;
export type ToolCallRecord = { toolName: string; args: Record<string, unknown>; result: unknown; durationMs: number; error?: string };

export class LoopGuardError extends Error {
  constructor(public rounds: number) {
    super(`Ciclo de tools excedió ${rounds} rondas`);
    this.name = 'LoopGuardError';
  }
}

export class PartialExecutionError extends Error {
  constructor(
    message: string,
    public cause: unknown,
    public partialToolCalls: ToolCallRecord[],
    /**
     * Lo que YA se pagó en las rondas que sí corrieron.
     *
     * Antes no viajaba, y el processor —en su rama de recuperación de cierre
     * parcial, con el flag activo por default— tampoco llamaba `registrarCosto`.
     * La liquidación salía con su PDF y lo gastado en OpenRouter para producirla
     * quedaba invisible. En un negocio que cobra POR LIQUIDACIÓN, el costo
     * unitario se subestima justo en el caso que más consume.
     */
    public tokensIn = 0,
    public tokensOut = 0,
    public cost = 0,
  ) {
    super(message);
    this.name = 'PartialExecutionError';
  }
}

// Prefijos de tools que SOLO LEEN, para poder cachear su resultado dentro de un
// turno. `cuadrar_` está aquí porque `cuadrar_viaje` calcula y no escribe nada —
// caía entre dos rejillas: no matcheaba ningún prefijo y tampoco es `isMutation`,
// así que si el modelo la llamaba dos veces en un turno ("cómo voy, y ciérralo
// si está bien") repetía las tres lecturas del cuadre MÁS el acumulado del
// ejercicio, que barre el año entero del tenant.
// B17 (auditoría 18): `estado_` también — `estado_viaje`, `estado_agentes` y
// `estado_runner` son lectura pura y caían en el mismo hueco que `cuadrar_`.
// Las tools nombradas por SUSTANTIVO (`kpis_flota`, `bandeja`, `guardia`…) no
// se pueden adivinar por prefijo: el llamador las declara en `readOnlyTools`.
const READ_PREFIXES = ['get_', 'check_', 'list_', 'find_', 'consultar_', 'validar_', 'cuadrar_', 'estado_'];
const isReadOnly = (n: string) => READ_PREFIXES.some((p) => n.startsWith(p));

/**
 * AUDITORÍA 25 (MEDIO, tool-calling.md:141) — `exec.success` solo dice "el
 * handler no lanzó", no "la entrega aterrizó". Las tools terminales del repo
 * (`entregar_respuesta`, `entregar_respuesta_admin`) NO lanzan cuando sus
 * bloques no validan: devuelven `{ ok: false, error: '...' }` como resultado
 * — un contrato deliberado, para que el mensaje de error viaje al modelo
 * como `content` de la tool y no como una excepción que el ciclo atrapa
 * distinto. Con solo `exec.success`, ese `ok: false` cerraba el turno igual
 * que un `ok: true`: el mensaje que le pide al modelo "vuelve a llamar
 * entregar_respuesta" quedaba escrito pero era, por construcción,
 * inalcanzable — nadie más lo iba a leer.
 *
 * Se lee el campo `ok` del resultado SOLO cuando existe: una tool terminal
 * que no siga esta convención (no declara `ok` en su resultado) conserva el
 * criterio de antes — `exec.success` basta — para no exigirle un contrato
 * que nunca prometió.
 */
function entregaTerminalAterrizo(result: unknown): boolean {
  if (result && typeof result === 'object' && 'ok' in result) return Boolean((result as { ok: unknown }).ok);
  return true;
}

/**
 * Nombres de tools cuyo schema NO declara ni un solo parámetro.
 *
 * PARA ELLAS, LOS `arguments` NO SIGNIFICAN NADA: el handler recibe `_args` y no
 * lo usa —es la regla estructural de Likida, el modelo decide CUÁNDO y nunca CON
 * QUÉ DATOS—, así que dos llamadas con `{}` y con `{"viaje_id":"v1"}` producen
 * exactamente el mismo resultado.
 *
 * La caché de lectura se llaveaba con `nombre:JSON.stringify(args)` y por eso no
 * acertaba nunca: nada obliga a que `arguments` sea `{}` (los schemas de tools
 * no llevan `strict: true`), así que el modelo variaba el JSON y `cuadrar_viaje`
 * volvía a correr entero. Medido con el ciclo real: tres rondas con `{}`,
 * `{"viaje_id":"v1"}` y `{"incluir_periodo":true}` → 3 ejecuciones, 0 aciertos.
 * Cada una son tres lecturas del cuadre MÁS `getAcumuladoCombustible`, que barre
 * todas las cargas de diésel del EJERCICIO del tenant, dentro de un turno
 * acotado a 40 s.
 *
 * Con parámetros de verdad la llave vuelve a incluirlos: entonces sí describen
 * el efecto.
 */
function llaveDeCache(tools: OpenAI.Chat.ChatCompletionTool[]) {
  const sinParametros = new Set(
    // `flatMap` y no `filter().map()`: el filtro no estrecha el tipo, y
    // `ChatCompletionCustomTool` no tiene `.function`.
    tools.flatMap((t) => {
      if (t.type !== 'function') return [];
      const props = (t.function.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
      return props && Object.keys(props).length > 0 ? [] : [t.function.name];
    }),
  );
  return (name: string, args: Record<string, unknown>) =>
    sinParametros.has(name) ? name : `${name}:${JSON.stringify(args)}`;
}

export async function generateWithTools(opts: {
  role: ModelRole;
  system: string;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  tools: OpenAI.Chat.ChatCompletionTool[];
  toolExecutor: ToolExecutor;
  maxToolRounds?: number;
  maxTokens?: number;
  temperature?: number;
  /** Esfuerzo de razonamiento (OpenRouter unified reasoning). Si se pasa, se
   *  omite temperature (los modelos de razonamiento la ignoran/rechazan). */
  reasoning?: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
  /** Aviso EN VIVO de cada tool que el ciclo ejecuta (13-ago-2026: la
   *  secuencia de pensamiento del chat). `inicio` al disparar la ejecución
   *  real, `fin` al terminar; un acierto de caché emite solo `fin` — fue
   *  instantáneo de verdad, no se le inventa un "pensando". */
  onTool?: (ev: { fase: 'inicio' | 'fin'; tool: string }) => void;
  /**
   * Tools TERMINALES (A30, auditoría 18): su resultado NO lo lee el modelo en
   * la ronda siguiente, lo lee el orquestador por un canal lateral
   * (`entregar_respuesta` → `CAPTURAS`). Con ellas el supuesto del loop-guard
   * ("no hay ronda siguiente que consuma el resultado") es falso, así que:
   *  (a) en la última ronda permitida SÍ se ejecutan —solo ellas— en vez de
   *      tirar `LoopGuardError` con la respuesta ya redactada y pagada;
   *  (b) en cuanto una corre con éxito, el ciclo termina ahí: no se paga otra
   *      completion para que el modelo diga "listo".
   */
  terminalTools?: readonly string[];
  /**
   * Tools de SOLO LECTURA por nombre (B17): las que no siguen la convención
   * de prefijo (`kpis_flota`, `metrica_negocio`, `bandeja`…) y aun así deben
   * entrar a la caché entre rondas del turno.
   */
  readOnlyTools?: readonly string[];
  /** Reserva monetaria antes de cada completion del ciclo. */
  budget?: LlmBudget;
}): Promise<{
  finalText: string;
  toolCalls: ToolCallRecord[];
  model: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  /**
   * El mismo total de `cost`, pero partido por el modelo que de verdad
   * respondió cada ronda. `model`/`cost` arriba son el resumen de UNA fila para
   * el llamador que no necesita más — pero cuando el ciclo cruzó de proveedor a
   * medio camino, esa fila sola miente: dice que TODO corrió en el modelo de la
   * última ronda. Esto es lo que le permite al llamador (`processor.ts`, vía
   * `registrarCosto`) escribir una fila de `llm_costo` POR MODELO en vez de
   * una sola con la etiqueta equivocada.
   */
  costoPorModelo: Record<string, { tokensIn: number; tokensOut: number; cost: number }>;
}> {
  const model = modelFor(opts.role);
  const fallback = FALLBACK[model] ?? null;
  const maxRounds = opts.maxToolRounds ?? 6;
  const client = getClient();
  const executed: ToolCallRecord[] = [];
  let tokIn = 0, tokOut = 0;
  // Sin inicializar a `model`: la única asignación real es la de la línea de
  // abajo (`used = res.model || activeModel`, antes de cualquier `return`),
  // y un valor de arranque nunca leído solo escondía que la corrida completa
  // podía terminar sin haber corrido ni una ronda.
  let used: string;
  // B23: el costo se acumula POR RONDA, con el modelo que de verdad respondió
  // esa ronda. Acumulando solo tokens y precificando una vez al final, un ciclo
  // que corre tres rondas en el primario y cae al fallback en la cuarta cobraba
  // las cuatro al precio del fallback.
  let costo = 0;
  // MEDIO (auditoría 10, reincidente): el desglose que hace atribuible el
  // costo. `model`/`cost` del return final siguen siendo el resumen de la
  // ÚLTIMA ronda —lo que ya consumía `processor.ts`—, pero cuando el ciclo
  // corrió mezclado (primario + fallback) esa etiqueta sola atribuye TODO el
  // dinero al modelo que solo respondió la ronda final. Este mapa es lo que le
  // permite al llamador partir la fila en una por modelo real.
  const costoPorModelo: Record<string, { tokensIn: number; tokensOut: number; cost: number }> = {};
  const acumularCosto = (m: string, tIn: number, tOut: number, c: number) => {
    const prev = costoPorModelo[m] ?? { tokensIn: 0, tokensOut: 0, cost: 0 };
    costoPorModelo[m] = { tokensIn: prev.tokensIn + tIn, tokensOut: prev.tokensOut + tOut, cost: prev.cost + c };
  };
  let activeModel = model; // cambia a fallback si el primario cae (persiste el resto del ciclo)

  // ═════════════════════════════════════════════════════════════════════════
  // CACHÉ DE PROMPT — dejar de pagar por reenviar lo mismo en cada vuelta.
  //
  // MEDIDO el 4-ago-2026 sobre las 4 liquidaciones reales: el ciclo NO gasta 6
  // llamadas fijas, escala con los comprobantes (2, 4, 8 y 10), y la entrada
  // crece con la conversación hasta 21,224 tokens. Una liquidación de 21
  // comprobantes reenvía ~72,000 tokens de entrada en 8 vueltas — y el system
  // prompt con las reglas fiscales viaja idéntico en TODAS.
  //
  // Anthropic cobra la lectura de caché al 10% de la entrada normal, así que
  // marcar el prefijo estable convierte ese reenvío en calderilla. NO cambia
  // el modelo, ni el prompt, ni la salida: es el mismo Sonnet dando la misma
  // respuesta. Es la única optimización del cuadre que no toca la calidad, y
  // por eso es la que se hace aquí — el modelo se queda.
  //
  // El breakpoint va en el SYSTEM, que es el bloque grande e invariante. Los
  // mensajes que siguen sí cambian entre vueltas y no se marcan.
  //
  // `as any` porque `cache_control` es una extensión de Anthropic vía
  // OpenRouter; el tipo del SDK de OpenAI no la contempla. Un modelo que no la
  // entienda la ignora — no rompe.
  const soportaCache = /anthropic\//.test(model);
  const sistema = soportaCache
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? ({ role: 'system', content: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }] } as any)
    : { role: 'system' as const, content: opts.system };

  const convo: OpenAI.Chat.ChatCompletionMessageParam[] = [
    sistema,
    ...opts.messages,
  ];
  // `args` viaja CON el resultado cacheado, no solo el resultado suelto: sin él,
  // un acierto de caché registraba los args de ESTA llamada junto al `result` de
  // la llamada ANTERIOR que de verdad llenó la caché — dos cosas que no tienen
  // por qué coincidir para una tool sin parámetros (el handler los ignora, así
  // que el modelo puede variarlos entre rondas sin que cambie el efecto; ver
  // `llaveDeCache`). El registro quedaba describiendo una llamada que nunca
  // corrió con esos args. Guardar los args ORIGINALES es lo que hace auditable
  // `ToolCallRecord`: de qué llamada real salió cada resultado.
  const crossRound = new Map<string, ToolExecResult & { args: Record<string, unknown> }>();
  const llave = llaveDeCache(opts.tools);
  const terminales = new Set(opts.terminalTools ?? []);
  const lecturas = new Set(opts.readOnlyTools ?? []);
  const esLectura = (n: string) => isReadOnly(n) || lecturas.has(n);

  // CR-5: completado con fallback cross-provider. Reintentar SÓLO la llamada de
  // completado (las tools se ejecutan DESPUÉS, en nuestro código) es seguro: una
  // caída del provider nunca re-ejecuta una mutación ni duplica una liquidación.
  const reservarCompletion = async (body: Record<string, unknown>, modelForRequest: string): Promise<LlmBudgetReservation | null> => {
    if (!opts.budget) return null;
    const maxTokens = Number(body.max_tokens ?? DEFAULT_MAX_TOKENS);
    // Cota conservadora: cada carácter puede representar un token en entradas
    // JSON/URLs. Se sobre-reserva y luego se liquida al costo real; nunca se
    // deja que un retry o fallback gaste sin autorización previa.
    // `cotaEntradaEnTokens` (no el largo crudo del JSON) para que, si algún día
    // este ciclo de tools carga una imagen (p.ej. un adaptador de facturación
    // con captura de pantalla), la reserva no infle por el base64 de la
    // data-URL de la misma forma en que lo hacía `generateStructured` antes
    // del fix de AGEN-19C2-4/OCR.
    const inputUpperBound = Math.max(1, cotaEntradaEnTokens(body.messages ?? '') + JSON.stringify(body.tools ?? '').length);
    // RENDIMIENTO-19C2-1: dentro de `runWithToolSignal` para que un cliente
    // de red profundo (Supabase) herede la señal — sin esto, esta RPC podía
    // seguir corriendo después de que el reloj de la invocación ya se acabó.
    return runWithToolSignal(opts.signal, () => reserveLlmBudget(opts.budget!, calcCost(modelForRequest, inputUpperBound, maxTokens)));
  };

  const completion = async (body: Record<string, unknown>, signalOpt: { signal: AbortSignal } | undefined) => {
    const reservation = await reservarCompletion(body, activeModel);
    try {
      // AUDITORÍA prod 25-ago-2026, CRÍTICO: extraer `create` sin `.bind()`
      // pierde el `this` del método — el SDK de OpenAI guarda su cliente en
      // `this._client` dentro de cada `APIResource` (`chat.completions` es
      // uno) y lo usa para hacer la petición HTTP. Llamando a la función
      // suelta, `this` es `undefined` en modo estricto y revienta con
      // "Cannot read properties of undefined (reading '_client')" — DESPUÉS
      // de reservar presupuesto y ANTES de tocar la red, así que cae en
      // `agent.fail` como cualquier otro error no transitorio. Invisible a la
      // suite: los mocks de prueba son funciones sueltas que no leen `this`,
      // así que ninguna prueba con el cliente MOCKEADO puede reproducirlo —
      // solo el SDK real lo revienta. Verificado en logs reales de producción
      // el 25-ago mandando "Hola" por WhatsApp.
      const create = client.chat.completions.create.bind(client.chat.completions) as unknown as (
        request: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ) => PromiseLike<OpenAI.Chat.ChatCompletion>;
      const response = await create(body, signalOpt);
      if (reservation) {
        try {
          const usage = response.usage as (typeof response.usage & { cost?: number }) | undefined;
          const usageCompleta = usage
            && Number.isFinite(usage.prompt_tokens)
            && Number.isFinite(usage.completion_tokens)
            && (usage.prompt_tokens > 0 || usage.completion_tokens > 0 || typeof usage.cost === 'number');
          // Si el proveedor omite usage no conocemos el costo real. Conservar
          // la reserva es la única opción segura: liquidar a cero abriría la
          // puerta a que el siguiente completion rebase el tope duro.
          const costo = usageCompleta
            ? costoReal(usage as { cost?: number }, activeModel, usage.prompt_tokens, usage.completion_tokens)
            : reservation.amountUsd;
          // RENDIMIENTO-19C2-1: mismo motivo que `reservarCompletion` — la
          // RPC de liquidación hereda la señal en vez de poder seguir
          // corriendo sola después de que el reloj de la invocación terminó.
          await runWithToolSignal(opts.signal, () => settleLlmBudget(opts.budget!, reservation, costo));
        } catch (e) {
          logger.error('llm.presupuesto_no_liquidado', { runId: opts.budget?.runId, err: e instanceof Error ? e.message : String(e) });
        }
      }
      return response;
    } catch (err) {
      // AUDITORÍA 24, TC-6 (reincidente de la 22/23): aquí se LIQUIDABA la
      // reserva COMPLETA ante cualquier error —un 503, un timeout, un
      // `fetch failed` que nunca llegó al proveedor— mientras sus dos
      // hermanas (`generateResponse`, `generateStructured`, BACKEND-19C2-1)
      // dejan la fila en 'reservado' para que la 0193 (`expira_en`) la
      // excluya sola del tope diario si de verdad nunca hubo uso. A $0.056
      // por reserva de cuadre, 20 minutos de 503 con 40 turnos eran $2.24 de
      // cargo fantasma que adelantaban el `tope_tenant` de TC-N1. Mismo
      // trato que las hermanas: se deja la fila reservada y se dice.
      if (reservation) {
        logger.error('llm.reserva_sin_liquidar_por_error', {
          fn: 'generateWithTools', runId: opts.budget?.runId, reservaId: reservation.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  };

  const complete = async (msgs: OpenAI.Chat.ChatCompletionMessageParam[]) => {
    const body = () => ({
      model: activeModel,
      messages: msgs,
      tools: opts.tools.length ? opts.tools : undefined,
      tool_choice: opts.tools.length ? ('auto' as const) : undefined,
      // El MISMO techo que las respuestas estructuradas, y por la misma razón
      // (ver DEFAULT_MAX_TOKENS): con `reasoning: 'high'` —que es como corre el
      // rol `cuadre`— el razonamiento invisible y la respuesta comparten este
      // presupuesto. Estaba en 1000: el modelo se quedaba sin techo pensando y
      // devolvía content vacío. `max_tokens` es un TECHO, no un cargo.
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      // reasoning y temperature son mutuamente excluyentes; van por spread para
      // no chocar con el tipado del SDK (igual que PROVIDER_OPTS).
      ...(opts.reasoning ? { reasoning: { effort: opts.reasoning } } : { temperature: opts.temperature ?? 0.3 }),
      ...PROVIDER_OPTS,
    });
    const signalOpt = opts.signal ? { signal: opts.signal } : undefined;
    try {
      return await completion(body(), signalOpt);
    } catch (err) {
      if (fallback && activeModel === model && !opts.signal?.aborted && isTransientError(err)) {
        logger.warn('llm.fallback', { fn: 'generateWithTools', from: model, to: fallback });
        activeModel = fallback;
        return await completion(body(), signalOpt);
      }
      throw err;
    }
  };

  try {
    for (let round = 0; round < maxRounds; round++) {
      // RENDIMIENTO-19C2-1: si la señal ya se disparó mientras corría la
      // ronda anterior (ejecución de tools, sobre todo), no arrancar una
      // completion completa más — cortar aquí y no después de pagarla.
      opts.signal?.throwIfAborted();
      const res = await complete(convo);
      const rIn = res.usage?.prompt_tokens ?? 0;
      const rOut = res.usage?.completion_tokens ?? 0;
      tokIn += rIn;
      tokOut += rOut;
      // `activeModel` ya refleja quién respondió ESTA ronda: `complete` lo mueve
      // al fallback antes de devolver.
      const costoRonda = costoReal(res.usage as { cost?: number } | undefined, activeModel, rIn, rOut);
      costo += costoRonda;
      acumularCosto(activeModel, rIn, rOut, costoRonda);
      used = res.model || activeModel;
      const choice = res.choices[0];
      const calls = choice?.message?.tool_calls;

      // SE CORTÓ ≠ TERMINÓ. Sin esta comprobación una respuesta a medias se
      // enviaba como completa, y —peor— una respuesta VACÍA por truncamiento
      // llegaba a `processor.ts` como finalText '' y se convertía en
      // "Listo. 👍": una confirmación afirmativa de un turno en el que no se
      // cuadró nada ni se cerró nada. El chofer deja de mandar comprobantes y
      // el viaje se queda abierto sin que nadie vea un error.
      //
      // B16 (auditoría 18): va ANTES de mirar si hay tool_calls. Vivía dentro
      // de la rama "cerró con texto", así que un `length` a media escritura de
      // `arguments` caía al JSON.parse, fallaba, y al modelo se le reportaba
      // "argumentos JSON inválidos" — el diagnóstico falso que `generateStructured`
      // ya había corregido en el camino hermano: truncamiento disfrazado de ilegible.
      if (choice?.finish_reason === 'length') {
        throw new TruncatedError(
          `Respuesta truncada en el ciclo de tools: se agotaron los ${opts.maxTokens ?? DEFAULT_MAX_TOKENS} tokens de salida (usó ${tokOut})`,
          tokOut,
          opts.maxTokens ?? DEFAULT_MAX_TOKENS,
          choice?.message?.content ?? undefined,
          { model: used, tokensIn: tokIn, tokensOut: tokOut, cost: costo },
        );
      }

      if (!calls || calls.length === 0) {
        // El costo ya viene sumado ronda a ronda, cada una al precio del modelo
        // que la respondió. (Antes se precificaba aquí, de una vez, con el
        // modelo activo al final: correcto solo si el ciclo entero corrió en el
        // mismo modelo.)
        return { finalText: choice?.message?.content ?? '', toolCalls: executed, model: used, tokensIn: tokIn, tokensOut: tokOut, cost: costo, costoPorModelo };
      }

      // LOOP-GUARD: CORTAR ANTES DE GASTAR LA RONDA, NO DESPUÉS.
      //
      // Esta es la ÚLTIMA ronda permitida (`round === maxRounds - 1`). Si el
      // modelo TODAVÍA pide tools en vez de cerrar con texto, no hay una ronda
      // siguiente que vaya a leer el resultado de esas tools — el ciclo iba a
      // tirar `LoopGuardError` de todos modos en cuanto el `for` terminara.
      // Ejecutarlas de todas formas paga una ronda completa (llamadas de red,
      // y si el modelo pide `guardar_liquidacion`, una MUTACIÓN) por un
      // resultado que nadie va a consumir. Se corta AQUÍ, antes del
      // `Promise.all` que las dispara, no después de pagarlas.
      //
      // EXCEPCIÓN (A30): la tool TERMINAL. Su resultado no lo lee el modelo, lo
      // lee el orquestador (`CAPTURAS`); cortarla aquí tiraba una respuesta ya
      // redactada y pagada, y el route contestaba "no pude responder". En la
      // última ronda se ejecutan SOLO las terminales: las lecturas que nadie
      // va a consumir siguen sin correr.
      const esTerminal = (c: (typeof calls)[number]) => c.type === 'function' && terminales.has(c.function.name);
      let llamadas = calls;
      if (round === maxRounds - 1) {
        llamadas = calls.filter(esTerminal);
        if (llamadas.length === 0) throw new LoopGuardError(maxRounds);
      }

      convo.push({ role: 'assistant', content: choice.message.content ?? null, tool_calls: llamadas });
      const inRound = new Map<string, { args: Record<string, unknown>; promise: Promise<ToolExecResult> }>();
      let entregada = false;

      const results = await Promise.all(
        llamadas.map(async (call) => {
          if (call.type !== 'function') {
            return { role: 'tool' as const, tool_call_id: call.id, content: JSON.stringify({ error: 'tipo de tool no soportado' }) };
          }
          let args: Record<string, unknown> = {};
          try {
            args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            executed.push({ toolName: call.function.name, args: {}, result: null, durationMs: 0, error: 'args_parse' });
            return { role: 'tool' as const, tool_call_id: call.id, content: JSON.stringify({ error: 'argumentos JSON inválidos' }) };
          }
          const key = llave(call.function.name, args);
          if (esLectura(call.function.name) && crossRound.has(key)) {
            const c = crossRound.get(key)!;
            // `c.args`, NO `args`: lo que produjo `c.result` fue la llamada que
            // llenó la caché, y esa pudo traer args distintos a los de ESTA
            // invocación (mismo caso de arriba). El registro tiene que decir qué
            // llamada produjo qué resultado, no la llamada actual con el
            // resultado de otra.
            executed.push({ toolName: call.function.name, args: c.args, result: c.result, durationMs: c.durationMs, error: c.error });
            opts.onTool?.({ fase: 'fin', tool: call.function.name });
            return { role: 'tool' as const, tool_call_id: call.id, content: JSON.stringify(c.success ? c.result : { error: c.error }) };
          }
          // `inRound` dedupea llamadas de la MISMA ronda con la misma llave —el
          // caso real: "cómo voy, y ciérralo si está bien" pide `cuadrar_viaje`
          // dos veces en un solo turno. Se guarda junto a la promesa QUÉ args la
          // dispararon, por la misma razón que en `crossRound`: la segunda
          // llamada de la ronda puede traer args distintos y de todos modos
          // reusar la ejecución de la primera.
          let entry = inRound.get(key);
          let laCreo = false;
          if (!entry) {
            laCreo = true;
            opts.onTool?.({ fase: 'inicio', tool: call.function.name });
            entry = { args, promise: opts.toolExecutor(call.function.name, args, opts.signal) };
            inRound.set(key, entry);
          }
          const exec = await entry.promise;
          if (laCreo) opts.onTool?.({ fase: 'fin', tool: call.function.name });
          // Solo se cachea el ÉXITO, igual que la rejilla de mutaciones
          // (`tool-executor.ts`). Guardar el fracaso convierte un blip de un
          // segundo en un fallo permanente del turno: el modelo reintenta, se le
          // sirve el mismo error desde memoria, y nadie vuelve a preguntarle a
          // una base que ya se curó sola.
          if (esLectura(call.function.name) && exec.success) crossRound.set(key, { ...exec, args: entry.args });
          if (exec.success && terminales.has(call.function.name) && entregaTerminalAterrizo(exec.result)) entregada = true;
          executed.push({ toolName: call.function.name, args: entry.args, result: exec.result, durationMs: exec.durationMs, error: exec.error });
          return { role: 'tool' as const, tool_call_id: call.id, content: JSON.stringify(exec.success ? exec.result : { error: exec.error }) };
        }),
      );
      convo.push(...results);
      // A30 (b): la entrega ya está en manos del orquestador. La ronda
      // siguiente solo serviría para que el modelo dijera "listo" — una
      // completion entera (con toda la conversación de entrada) por una
      // palabra que nadie lee.
      if (entregada) {
        return { finalText: choice.message.content ?? '', toolCalls: executed, model: used, tokensIn: tokIn, tokensOut: tokOut, cost: costo, costoPorModelo };
      }
    }
    throw new LoopGuardError(maxRounds);
  } catch (err) {
    if (err instanceof PartialExecutionError) throw err;
    throw new PartialExecutionError(err instanceof Error ? err.message : String(err), err, executed, tokIn, tokOut, costo);
  }
}
