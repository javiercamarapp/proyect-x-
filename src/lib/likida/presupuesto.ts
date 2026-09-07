import { logger } from '@/lib/logger';

// ═══════════════════════════════════════════════════════════════════════════
// EL PRESUPUESTO DE TIEMPO DE UNA INVOCACIÓN.
//
// El webhook responde 200 de inmediato y hace el trabajo en `after()`. Meta ya
// recibió su acuse, así que NO reintenta nunca. Si Vercel mata la función al
// llegar a `maxDuration`, el trabajo se pierde EN SILENCIO: el operador no
// recibe nada, no hay reintento, y el único rastro es que el mensaje nunca llegó.
//
// Encima las etapas se comían el presupuesto a ciegas. La barrera de intake
// espera hasta 20s y el mutex hasta 12s, cada una con su tope fijo, sin saber
// que comparten los 60s con el agente —que es la parte cara—. En el peor caso
// son 32s consumidos antes de empezar a pensar.
//
// Esto no acorta ningún timeout: le da a todas las etapas el mismo reloj, para
// que la que llega tarde pida menos en vez de pedir lo mismo.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * LOS PASOS DE RED DEL CIERRE, UNO POR UNO.
 *
 * Esto era un comentario, y el comentario mentía: enumeraba SEIS pasos y sumaba
 * "~7s en un día malo". Contados contra `processor.ts` después de que `runAgent`
 * devuelve, son TRECE viajes de red secuenciales y suman 8.9s. La cuenta seguía
 * cabiendo en los 12s reservados, pero con 3.1s de holgura y no con los ~5s que
 * sugería. Nadie se enteró porque una lista en prosa no se puede verificar.
 *
 * Ahora es una tabla, y `presupuesto.test.ts` compara su suma contra
 * `MARGEN_CIERRE_MS`. Meter un paso más al cierre sin ampliar el margen deja de
 * ser un descuido silencioso y pasa a ser una prueba en rojo — el mismo
 * mecanismo que ya protege la sincronía con `maxDuration`. Y desde la
 * auditoría 18 la prueba también LEE `avisar_cierre.ts`: cada `sendText` /
 * `sendDocument` de ese archivo tiene que tener su renglón aquí.
 *
 * Los costos unitarios son los que este archivo ya usaba: 0.3s una consulta,
 * 1.5s un `sendText`, 2.5s un `sendDocument`, 0.5s una URL firmada.
 *
 * AUDITORÍA 21, CRÍTICO (C2): cada paso lleva además su TECHO duro — el peor
 * caso que el propio sistema le impone: `SEND_TIMEOUT_MS` (10s, con
 * `AbortSignal.timeout` real en `meta/client.ts`) para un envío de WhatsApp, y
 * `TOPE_CONSULTA_MS` + la gracia de la red de seguridad (8s + 1.5s) para una
 * consulta a Supabase o a Storage. `critico: true` marca los pasos que le
 * ENTREGAN LA VERDAD al chofer — la respuesta, la URL firmada y el PDF —, los
 * que no se pueden omitir sin repetir el silencio que este archivo combate.
 */
export const TECHO_ENVIO_WHATSAPP_MS = 10_000; // = SEND_TIMEOUT_MS de meta/client.ts (prueba compara el fuente)

/**
 * TECHO DURO DE UNA CONSULTA A SUPABASE. Lo impone `repo.ts` en cada llamada.
 *
 * `supabaseAdmin()` construye el cliente sin `fetch` propio, así que hasta aquí
 * NINGUNA consulta ni RPC del sistema llevaba señal de aborto. El default del
 * `fetch` global de Node (undici) es `headersTimeout`/`bodyTimeout` de 300 000
 * ms: un socket aceptado que no contesta bloquea 300s. Medido en esta máquina
 * contra un servidor que acepta y calla, `fetch` seguía bloqueado a los 20s sin
 * el menor síntoma.
 *
 * Vercel mata la función a los 120s (`route.ts:27`), o sea 180s ANTES de que ese
 * fetch se rinda. Y morir así es el peor final posible: la liquidación ya quedó
 * escrita en la base, el operador no recibe ni resumen ni PDF, el
 * `logger.error('pdf.no_entregado')` tampoco se escribe porque el proceso muere
 * antes del `catch`, y Meta —que recibió su 200 en `route.ts:78`— no reintenta.
 *
 * ¿Por qué 8s y no menos? Una consulta de este sistema cuesta ~0.3s en la
 * contabilidad de arriba, así que 8s son 26× lo típico: ninguna consulta sana lo
 * toca ni con un p99 diez veces peor. Y ¿por qué no más? Porque el peor caso
 * sumado de la ruta son ~90.8s contra 120: cada consulta colgada gasta
 * `TOPE − 0.3`s de esa holgura, y con 8s la invocación sobrevive a TRES colgadas
 * antes de tocar el límite. Con el default de undici no sobrevive a una.
 *
 * Se puede subir por entorno sin desplegar (`LIKIDA_TOPE_CONSULTA_MS`): la
 * latencia real Vercel ↔ Supabase no está medida, y si resulta peor que la
 * documentada hay que poder aflojarlo desde el panel y no desde un commit.
 */
export const TOPE_CONSULTA_MS = Number(process.env.LIKIDA_TOPE_CONSULTA_MS) || 8_000;

/** Margen sobre el tope antes de que dispare la red de seguridad. */
const GRACIA_TOPE_MS = 1_500;

/** El peor caso real de un paso de consulta: el tope MÁS la gracia con la que
 *  la red de seguridad de `acotada` lo deja correr antes de rendirse. */
export const TECHO_PASO_CONSULTA_MS = TOPE_CONSULTA_MS + GRACIA_TOPE_MS;

export interface PasoCierre { paso: string; donde: string; ms: number; techoMs: number; critico?: true }

export const PASOS_CIERRE: ReadonlyArray<PasoCierre> = [
  { paso: 'registrarCosto del turno',              donde: 'processor.ts:591',  ms: 300,   techoMs: TECHO_PASO_CONSULTA_MS },
  { paso: 'vincularCostosALiquidacion',            donde: 'processor.ts:595',  ms: 300,   techoMs: TECHO_PASO_CONSULTA_MS },
  { paso: 'guardiaCifras → cuadrarDesdeDB',        donde: 'processor.ts:658',  ms: 300,   techoMs: TECHO_PASO_CONSULTA_MS },
  { paso: 'sendText de la respuesta',              donde: 'processor.ts:715',  ms: 1_500, techoMs: TECHO_ENVIO_WHATSAPP_MS, critico: true },
  { paso: 'registrarCostoWhatsApp de la respuesta', donde: 'costos.ts',        ms: 300,   techoMs: TECHO_PASO_CONSULTA_MS },
  { paso: 'getGastos para el aviso de barrera',    donde: 'processor.ts:734',  ms: 300,   techoMs: TECHO_PASO_CONSULTA_MS },
  { paso: 'sendText del aviso de barrera',         donde: 'processor.ts:735',  ms: 1_500, techoMs: TECHO_ENVIO_WHATSAPP_MS },
  { paso: 'registrarCostoWhatsApp de ese aviso',   donde: 'costos.ts',         ms: 300,   techoMs: TECHO_PASO_CONSULTA_MS },
  { paso: 'createSignedUrl del PDF',               donde: 'processor.ts:755',  ms: 500,   techoMs: TECHO_PASO_CONSULTA_MS, critico: true },
  { paso: 'sendDocument del PDF',                  donde: 'processor.ts:757',  ms: 2_500, techoMs: TECHO_ENVIO_WHATSAPP_MS, critico: true },
  { paso: 'registrarCostoWhatsApp del PDF',        donde: 'processor.ts:758',  ms: 300,   techoMs: TECHO_PASO_CONSULTA_MS },
  // AUDITORÍA 25, ALTO (REND-A2, REINCIDENTE): AGEN-4 (auditoría 24) añadió
  // los DOS sellos de `sellarEntregaLiquidacion` (`0279`) sin su renglón —
  // cada uno es un UPDATE real sobre `liquidacion`, envuelto en `acotada`
  // igual que cualquier otra consulta. La tabla se quedó en 18 pasos con el
  // cierre real haciendo 20 desde que `4f94490` llegó a `master`.
  { paso: 'sellarEntregaLiquidacion (PDF operador)', donde: 'processor.ts:4266', ms: 300, techoMs: TECHO_PASO_CONSULTA_MS },
  // AUDITORÍA 18, ALTO (A24): `avisarCierreAlJefe` añadió CINCO viajes de red
  // al cierre y la tabla no los tenía — la prueba comparaba la tabla consigo
  // misma. 13.5s de cierre real contra 12s de reserva. Ahora están, y
  // `presupuesto.test.ts` cuenta los envíos de `avisar_cierre.ts` en el fuente.
  { paso: 'createSignedUrl del PDF completo (jefe)', donde: 'processor.ts',     ms: 500,  techoMs: TECHO_PASO_CONSULTA_MS },
  { paso: 'telefonoParaDineroDe',                  donde: 'contactos.ts',      ms: 300,   techoMs: TECHO_PASO_CONSULTA_MS },
  { paso: 'resumenDeCierre (2 consultas en paralelo)', donde: 'avisar_cierre.ts', ms: 300, techoMs: TECHO_PASO_CONSULTA_MS },
  { paso: 'sendText del aviso al jefe',            donde: 'avisar_cierre.ts',  ms: 1_500, techoMs: TECHO_ENVIO_WHATSAPP_MS },
  { paso: 'sendDocument del PDF al jefe',          donde: 'avisar_cierre.ts',  ms: 2_500, techoMs: TECHO_ENVIO_WHATSAPP_MS },
  // AUDITORÍA 25, ALTO (REND-A2, REINCIDENTE): el segundo sello, el del aviso
  // a la oficina (`processor.ts:4338`) — mismo hallazgo que el de arriba.
  { paso: 'sellarEntregaLiquidacion (aviso oficina)', donde: 'processor.ts:4338', ms: 300, techoMs: TECHO_PASO_CONSULTA_MS },
  { paso: 'saveConversation',                      donde: 'processor.ts:774',  ms: 500,   techoMs: TECHO_PASO_CONSULTA_MS },
  { paso: 'releaseViajeLock',                      donde: 'processor.ts:814',  ms: 300,   techoMs: TECHO_PASO_CONSULTA_MS },
];

/** Suma nominal de la tabla de arriba. 14.0s con los costos unitarios de este archivo. */
export const COSTO_CIERRE_MS = PASOS_CIERRE.reduce((s, p) => s + p.ms, 0);

/**
 * El peor caso ABSOLUTO del cierre: los 18 pasos, cada uno a su techo duro.
 * Suma ~173s — NO CABE en un `maxDuration` de 120s, y por eso ningún margen
 * puede prometer que la cola completa sobrevive a un mal día generalizado.
 * Existe para que esa imposibilidad esté escrita y probada, no supuesta: es la
 * razón de que el processor VUELVA A MIRAR el reloj después del agente
 * (`margenDuro()`) y recorte los pasos accesorios en vez de correr a ciegas.
 */
export const TECHO_CIERRE_MS = PASOS_CIERRE.reduce((s, p) => s + p.techoMs, 0);

/**
 * Tiempo que se aparta para CERRAR, o sea para todo lo que va DESPUÉS del
 * agente. Sin este margen se gasta hasta el último milisegundo y no queda
 * tiempo ni de responder — que es el fallo que esto viene a evitar.
 *
 * AUDITORÍA 21, CRÍTICO (C2): eran 17s dimensionados contra los costos
 * TÍPICOS (14.0s nominales, 3s de holgura) — pero una reserva solo vale lo
 * que valga el techo de cada paso que la consume, y los techos reales son
 * `SEND_TIMEOUT_MS` = 10s por envío y `TOPE_CONSULTA_MS` + gracia = 9.5s por
 * consulta. El cierre normal hace 5 envíos y ~13 consultas: si Meta o
 * Supabase están LENTOS —no caídos— la cola suma 70-90s contra 17s
 * reservados, y Vercel mata el proceso a media cola sin excepción ni log.
 *
 * El margen ahora se DERIVA de la tabla: los pasos `critico` (los que le
 * entregan la verdad al chofer: respuesta, URL firmada, PDF) a su TECHO duro,
 * el resto a su costo nominal — 39.0s con los números de hoy. Cubrir los 18 a
 * techo es imposible (`TECHO_CIERRE_MS` ~173s > 120s), así que el resto de la
 * garantía no es este número: es el re-chequeo del reloj después del agente
 * (`margenDuro()` en `processor.ts`), que omite los pasos accesorios — con
 * log, no en silencio — cuando el margen real ya no alcanza.
 *
 * El coste de subirlo: el agente pierde techo cuando llega tarde (en el peor
 * caso barrera+mutex al máximo le quedan ~49s de los 40 que pide) y una
 * invocación por lotes declara `sin_tiempo` antes — la bandeja durable
 * recupera esos mensajes, que es el camino diseñado para eso.
 */
export const MARGEN_CIERRE_MS = PASOS_CIERRE.reduce((s, p) => s + (p.critico ? p.techoMs : p.ms), 0);

/**
 * Lo IRRENUNCIABLE del cierre: solo los pasos críticos, a su techo duro.
 *
 * ── AUDITORÍA 22, AGEN-A1 (ALTO) ──────────────────────────────────────────
 * `MARGEN_CIERRE_MS` es la RESERVA: `restante()` ya lo descuenta antes de
 * dárselo al agente. Volver a exigirlo DESPUÉS del agente es contarlo dos
 * veces, y el resultado no es un borde raro sino una identidad:
 *
 *     margenDuro() = restante() + MARGEN_CIERRE_MS
 *
 * El agente pide `min(40_000, restante())`. Siempre que ese `min` lo gana
 * `restante()` —o sea, siempre que el turno llegó con menos de 41 s
 * utilizables— y el agente consume su tope, `restante()` aterriza en 0 y
 * `margenDuro()` en `MARGEN_CIERRE_MS − ε`. El chequeo daba FALSO
 * determinísticamente, y con él se suprimía el único aviso de que la
 * liquidación salió corta: la alarma se apagaba justo en el caso que existe
 * para vigilar.
 *
 * Lo que el chequeo tiene que responder no es «¿me queda la reserva entera?»
 * sino «¿alcanzo a hacer lo que no puedo dejar de hacer?»: mandar la
 * respuesta, firmar el PDF y entregarlo. Eso es esto.
 */
export const MARGEN_CIERRE_CRITICO_MS = PASOS_CIERRE.reduce((s, p) => s + (p.critico ? p.techoMs : 0), 0);

// ═══════════════════════════════════════════════════════════════════════════
// TODA CONSULTA DE ESTE ARCHIVO TIENE TECHO.
//
// `supabaseAdmin()` crea el cliente sin `fetch` propio, así que hasta aquí
// ninguna consulta ni RPC llevaba señal de aborto y todas heredaban el default
// de undici: 300 000 ms. Vercel mata la función a los 120s, o sea que el fetch
// se rendía 180s después de que ya no había nadie escuchando. Medido contra un
// servidor que acepta y calla: `fetch()` seguía bloqueado a los 20s, y `getViaje`
// a los 12s (ver `repo_tope.test.ts`).
//
// Morir así es el peor final que tiene este producto: la liquidación ya quedó
// escrita, el operador no recibe ni resumen ni PDF, ni siquiera se escribe el
// `logger.error` porque el proceso muere antes del `catch`, y Meta no reintenta.
//
// El tope se impone en DOS capas a propósito:
//
//   1. `abortSignal` cuando el builder lo acepta —que es el caso en producción—,
//      porque eso CANCELA el socket de verdad. Sin cancelar, una instancia
//      caliente de Lambda se queda con la conexión colgada hasta los 300s.
//   2. Una carrera contra un temporizador, como red de seguridad, porque la
//      señal solo cubre lo que el SDK decida pasarle al fetch: si reintenta por
//      dentro, o si el cuelgue está antes (DNS, TLS), la señal sola no basta.
//
// Y sobre todo: agotar el tope entra por el MISMO camino que un error de
// Postgres —`{ data: null, error }`—, no por uno nuevo. Así cada llamador
// conserva la semántica que ya tenía y que está probada: `getGastos` lanza,
// `gastoExistePorHash` devuelve false, `saveCfdiXmlRaw` deja un warn. Un tope
// que además cambiara cómo falla cada función sería dos cambios disfrazados de
// uno, en el archivo por el que pasa todo el dinero.
// ═══════════════════════════════════════════════════════════════════════════
//
// AUDITORÍA 8, ALTO REINCIDENTE: esto vivía en `repo.ts`, así que solo protegía
// lo que pasaba por ahí. `costos.ts`, `conv.ts` y `config.ts` llamaban a
// `supabaseAdmin()` en crudo — ONCE de los trece pasos del cierre, incluido el
// mutex del viaje y la barrera de ráfaga. Un cuelgue ahí no tenía techo y se
// comía los 120 s de la función entera.
//
// Vive aquí, junto a `TOPE_CONSULTA_MS`, para que cualquier archivo lo importe
// sin volver a copiarlo.
// ═══════════════════════════════════════════════════════════════════════════

/** Margen sobre el tope antes de que dispare la red de seguridad. */
export async function acotada<T>(consulta: PromiseLike<T>, etiqueta: string): Promise<T> {
  const conSenal = consulta as PromiseLike<T> & { abortSignal?: (s: AbortSignal) => unknown };
  if (typeof conSenal.abortSignal === 'function') conSenal.abortSignal(AbortSignal.timeout(TOPE_CONSULTA_MS));

  let temporizador: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      consulta,
      new Promise<T>((resolver) => {
        temporizador = setTimeout(() => {
          logger.error('supabase.tope_agotado', { consulta: etiqueta, topeMs: TOPE_CONSULTA_MS });
          resolver({
            data: null,
            error: { message: `sin respuesta en ${TOPE_CONSULTA_MS} ms (tope de consulta)` },
          } as unknown as T);
        }, TOPE_CONSULTA_MS + GRACIA_TOPE_MS);
      }),
    ]);
  } finally {
    clearTimeout(temporizador);
  }
}

/**
 * Presupuesto de la invocación del webhook, en ms.
 *
 * TIENE QUE COINCIDIR con el `maxDuration` de
 * `src/app/api/webhook/whatsapp/route.ts`. Next exige que aquel sea un literal
 * estático —no se puede importar—, así que hay un test que compara los dos y
 * falla si se desincronizan. Sin él, subir uno y olvidar el otro deja el
 * presupuesto mintiendo y vuelve el fallo silencioso.
 *
 * 120s desde el 28-jul-2026. El plan del equipo `likida` se verificó contra la
 * API de Vercel —es **pro**, tope 300s—, y el peor caso de la ruta son ~72s:
 * lock (≤12s) + espera de intake (20s) + cuadre (~40s). Con 60 se cortaba a
 * media liquidación, y como Meta ya recibió su 200 no reintenta.
 *
 * El comentario anterior decía "60s es el tope de Hobby, solo sube si se
 * confirma Pro": la condición se cumplió y quedó comprobada, no supuesta.
 */
export const PRESUPUESTO_WEBHOOK_MS = 120_000;

export interface Presupuesto {
  /** Milisegundos utilizables que quedan, ya descontado el margen de cierre. */
  restante(): number;
  /** `true` si ya no queda tiempo para trabajo nuevo. */
  agotado(): boolean;
  /** El tope que pide una etapa, recortado a lo que de verdad queda. */
  acotar(topeDeseado: number): number;
  /** ¿Cabe una etapa que se estima en `costoMs`? */
  alcanza(costoMs: number): boolean;
  /** Milisegundos transcurridos desde el inicio. Para el log. */
  gastado(): number;
  /**
   * Milisegundos que quedan hasta que Vercel MATE el proceso (`maxDuration`),
   * SIN descontar el margen de cierre — a diferencia de `restante()`, que lo
   * descuenta porque mide lo utilizable para trabajo nuevo.
   *
   * AUDITORÍA 21, CRÍTICO (C2): es lo que el processor consulta DESPUÉS del
   * agente y ANTES de la cola de cierre. Si esto ya es menor que
   * `MARGEN_CIERRE_MS`, la cola completa no cabe con sus techos reales: se
   * recortan los pasos accesorios —con log, no en silencio— y lo que queda se
   * gasta en los irrenunciables.
   */
  margenDuro(): number;
  /**
   * Señal que se aborta cuando se acaba lo que queda (o antes, si `topeMs` es
   * menor). Para pasarla a los SDK que aceptan `AbortSignal` y que si no caen a
   * sus defaults —el de OpenAI son 10 minutos contra un webhook de 60s.
   */
  senal(topeMs?: number): AbortSignal;
}

/**
 * @param totalMs  presupuesto de la invocación (el `maxDuration` de la ruta).
 * @param reloj    inyectable para poder probarlo sin esperar de verdad.
 * @param inicio   cuándo ARRANCÓ LA INVOCACIÓN (no este mensaje). Por default
 *                 es "ahora", que solo es verdad cuando un webhook = un mensaje.
 *
 * AUDITORÍA 18, CRÍTICO (C4): el presupuesto era por MENSAJE y el
 * `maxDuration` es por INVOCACIÓN. El webhook procesa N mensajes con un pool
 * de 5 y el cron drena 10 en serie, y cada `processInbound` arrancaba su reloj
 * en su propio `Date.now()`: la foto 6 de un fajo de 8 se creía dueña de 120s
 * cuando la invocación ya llevaba 62 gastados, pedía sus 25s de visión
 * completos y Vercel mataba la función con las fotos 6-8 en vuelo. Los
 * llamadores pasan ahora el inicio de SU invocación y cada mensaje pide lo que
 * de verdad queda — o no arranca (`processInbound` devuelve `sin_tiempo` y la
 * bandeja durable lo recupera).
 */
export function crearPresupuesto(totalMs: number, reloj: () => number = Date.now, inicio: number = reloj()): Presupuesto {
  const restante = () => Math.max(0, totalMs - MARGEN_CIERRE_MS - (reloj() - inicio));
  return {
    restante,
    agotado: () => restante() <= 0,
    acotar: (topeDeseado: number) => Math.min(topeDeseado, restante()),
    alcanza: (costoMs: number) => restante() >= costoMs,
    gastado: () => reloj() - inicio,
    margenDuro: () => Math.max(0, totalMs - (reloj() - inicio)),
    senal: (topeMs?: number) => {
      const ms = Math.min(topeMs ?? Number.POSITIVE_INFINITY, restante());
      // `AbortSignal.timeout(0)` no aborta de inmediato: se agenda. Cuando ya no
      // queda nada se devuelve una señal YA abortada, para que la llamada ni
      // salga.
      if (!(ms > 0)) { const ac = new AbortController(); ac.abort(); return ac.signal; }
      return AbortSignal.timeout(ms);
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EL MARGEN DE RELOJ DE UN CRON ITERATIVO (auditoría 28, REN-A4 + REN-A5).
//
// `crearPresupuesto` de arriba es para el WEBHOOK: un `venceEn` implícito con
// margen de CIERRE (responder, sellar, entregar el PDF). Los crons que barren
// una lista de trabajo (`gps`, `descarga-sat`, y sus hermanos desde el PR
// #152) usan un patrón más simple pero con el MISMO riesgo: `venceEn` se
// consulta ANTES de despachar cada "unidad atómica" (una flota, un evento, un
// XML del paquete SAT) y, una vez despachada, esa unidad corre hasta el final
// SIN que nadie vuelva a mirar el reloj — no hay forma de cortarla a medias.
// El margen sobre `maxDuration` tiene que cubrir el PEOR CASO de una sola
// unidad, no un número copiado de otro cron.
//
// `cron/gps/route.ts` (REN-A4) y `cron/descarga-sat/route.ts` (REN-A5)
// llevaban los dos el mismo literal (`20_000`) copiado uno del otro sin
// derivarlo de nada: 20s no cubre ni de lejos la cadena real de un evento
// grave de cámara (verificada en `asistencia_camara.ts` — ver el comentario
// junto a `MARGEN_RELOJ_MS` en `cron/gps/route.ts`) ni la del aviso de cierre
// de peaje (`peaje_cierre.ts`). Un margen corto no es conservador: dispara el
// `venceEn` DEMASIADO TARDE, deja que se despache una unidad que no le va a dar
// tiempo, y Vercel mata la función a medio hacer — exactamente el silencio que
// el reloj existe para evitar.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Lo que queda DESPUÉS de que la última unidad atómica termina: registrar el
 * latido (`registrarLatido`) y devolver la respuesta HTTP. Sin este colchón el
 * margen cubriría justo el trabajo y no la prueba de que el trabajo se hizo.
 */
export const COLCHON_LATIDO_CRON_MS = 5_000;

export interface CostoUnidadAtomica {
  /** Consultas a Supabase envueltas en `acotada()` — cada una cuesta, en el
   *  peor caso, `TECHO_PASO_CONSULTA_MS`. Cuenta SOLO los viajes de red que de
   *  verdad esperan una respuesta (un `select`/`insert`/`update`/`rpc`), no las
   *  ramas que no se ejecutan siempre: usa el conteo del camino MÁS CARO. */
  consultas: number;
  /** Envíos SÍNCRONOS a la Cloud API de WhatsApp (`sendText`, `sendButtons`,
   *  `enviarTexto`) — cada uno cuesta, en el peor caso, `TECHO_ENVIO_WHATSAPP_MS`.
   *  NO cuenta un encolado a `wa_outbox` (`encolarBotonesWhatsApp` /
   *  `encolarSalidaWhatsAppDedupe`): eso es una consulta MÁS (un `rpc` que
   *  inserta en la tabla), no un envío — la entrega real la hace el worker
   *  aparte de `cron/wa-outbox/route.ts`, fuera de esta unidad atómica. */
  envios: number;
  /** Costo adicional fijo, para lo que no encaja en las dos categorías de
   *  arriba (p. ej. trabajo de CPU medido que no es red). */
  extraMs?: number;
}

/**
 * El margen de reloj que un cron ITERATIVO tiene que reservar sobre su
 * `maxDuration`, derivado de los TECHOS duros de la unidad atómica más cara
 * que puede despachar — no de un número copiado.
 *
 * `venceEn = Date.now() + maxDuration*1000 - margenUnidadAtomicaMs(...)`: con
 * eso, una unidad que arranca justo antes de `venceEn` siempre tiene, como
 * mínimo, exactamente su peor caso completo ANTES del `maxDuration`, más el
 * colchón para latir y responder.
 *
 * Cambiar `LIKIDA_TOPE_CONSULTA_MS` por entorno mueve el margen de cada cron
 * que use este helper sin tocar código (vía `TECHO_PASO_CONSULTA_MS`).
 */
export function margenUnidadAtomicaMs({ consultas, envios, extraMs = 0 }: CostoUnidadAtomica): number {
  return consultas * TECHO_PASO_CONSULTA_MS + envios * TECHO_ENVIO_WHATSAPP_MS + extraMs + COLCHON_LATIDO_CRON_MS;
}
