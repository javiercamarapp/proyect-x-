import { logger } from '@/lib/logger';

// ═══════════════════════════════════════════════════════════════════════════
// LÍMITE DE TASA — Redis (Upstash) cuando hay credenciales; Map en memoria de
// esta instancia cuando no las hay o cuando Redis falla a media petición.
//
// AUDITORÍA EXTERNA DEL 15-AGO-2026, P1: hasta esta versión `buckets` era la
// ÚNICA fuente. En Vercel cada instancia concurrente arranca con su propio Map
// vacío, así que el techo real de `login:` no era 10 intentos / 5 min: era
// 10 × (instancias que el atacante consiga abrir en paralelo). Ver el
// historial de este archivo para el razonamiento original — sigue siendo
// válido para TODO lo que caiga al Map, que ahora es el respaldo, no el todo.
//
// ── POR QUÉ REDIS Y NO EL SDK ────────────────────────────────────────────
//
// REST puro, sin `@upstash/redis`: mismo criterio que `lib/saas/stripe.ts`
// (cuatro rutas y un HMAC no justifican una dependencia con su propio agente
// HTTP). Un solo `fetch` por intento, contra la REST API de Upstash.
//
// ── POR QUÉ EVAL Y NO UN PIPELINE DE INCR + EXPIRE ───────────────────────
//
// La documentación de Upstash lo dice sin rodeos: "pipeline execution is not
// atomic — other clients' commands can interleave". Un pipeline de dos
// comandos deja exactamente la misma ventana de carrera que este módulo vino
// a cerrar: dos instancias podrían leer el mismo INCR intermedio. Un script
// Lua vía `EVAL` SÍ es atómico — Redis lo ejecuta entero sin soltar el hilo —
// y es la opción que la propia auditoría sugiere ("INCR + EXPIRE en una sola
// llamada o script Lua").
//
// El script incrementa y, SOLO en el primer incremento (`n == 1`), pone el
// TTL. Sin el "solo la primera vez": cada request dentro de la ventana
// volvería a poner `PEXPIRE`, la ventana se alargaría con cada petición y una
// llave con tráfico continuo NUNCA caducaría — un bloqueo permanente
// disfrazado de límite de tasa.
//
// ── VENTANA FIJA, NO DESLIZANTE (diferencia real con el Map) ─────────────
//
// El Map de abajo desliza de verdad: descarta cada sello que salió de los
// últimos `windowMs`. Redis aquí cuenta por VENTANA FIJA (un contador que
// nace en el primer hit y caduca `windowMs` después): más barato —un solo
// EVAL, sin guardar cada timestamp— pero admite hasta 2× el límite pegado al
// borde de dos ventanas consecutivas (N al final de una, N al principio de la
// siguiente). Aceptable a propósito: esto protege contra abuso y ráfagas, no
// factura nada — la precisión de una ventana deslizante no vale el costo
// (una estructura ordenada en Redis, más comandos, más latencia en cada
// petición que este módulo gatea).
//
// ── LA DECISIÓN DE FALLO: ¿QUÉ PASA SI REDIS NO CONTESTA? ────────────────
//
// Dos averías DISTINTAS, con respuestas distintas:
//
//  1. SIN CREDENCIALES (`UPSTASH_REDIS_REST_URL`/`TOKEN` ausentes). Esperado
//     en local y válido en producción si aún no se configuró. Se degrada al
//     Map SIEMPRE, y se avisa UNA VEZ por instancia fría en `avisarBackend()`
//     — nunca en silencio, que es justo lo que la auditoría 5 encontró con
//     `SENTRY_DSN` (ver `observability/sentry.ts`).
//
//  2. CON CREDENCIALES, PERO EL INTENTO FALLA (timeout, red caída, Upstash
//     devuelve 5xx). Aquí SÍ hay una decisión que tomar, y se pensó así:
//
//     · DEFAULT (cambió en la auditoría 24, SEG-4): esa misma avería NIEGA
//       la petición — fail-CLOSED. Antes el default degradaba al Map local y
//       el interruptor `RATELIMIT_REDIS_FALLA_CERRADO=true` había que
//       acordarse de ponerlo: en producción nadie lo puso, y con Upstash
//       caído dos minutos el techo de `/api/mcp/oauth/token`, `/api/lead`,
//       el reenvío de magic link y `/api/demo` se volvía N × instancias
//       frías — spam de correos, filas en `prospecto`, tokens del demo. Un
//       límite que se apaga solo cuando su backend falla no es un límite.
//       Nótese que en el webhook de WhatsApp "negar" NO es "tirar": un
//       `false` de `rateLimit` ahí se APLAZA (429, Meta reintenta) — ver la
//       nota de `route.ts`. Fail-closed ahí cuesta latencia, no
//       comprobantes, MIENTRAS la avería sea transitoria.
//     · CONFIGURABLE A FAIL-OPEN ACOTADO — `RATELIMIT_REDIS_FALLA_CERRADO=false`
//       (global) o `rateLimit(key, n, ms, { fallaCerrado: false })` (por
//       llamada) degrada esa petición al Map local: sigue habiendo un tope
//       por instancia, nunca cero. Es la elección razonable para un llamador
//       con sesión válida —un contralor no debería quedarse fuera de su
//       propio login por un blip de un proveedor ajeno— y ese llamador lo
//       decide a la vista, no un default que nadie recuerda.
//     · Lo que NUNCA pasa: que un fallo de Redis tire una excepción hacia el
//       llamador. `intentarRedis` atrapa todo y devuelve `null` — la petición
//       del operador jamás se rompe por telemetría de otro proveedor.
//
// ── POR QUÉ `rateLimit` AHORA ES ASYNC ────────────────────────────────────
//
// La versión anterior no podía serlo: varios llamadores la usaban en un `if`
// síncrono y un `Promise` ahí es siempre truthy — el límite quedaría apagado
// en silencio. Se migraron los ~15 llamadores (rutas de API, el login por
// server action, el webhook de WhatsApp) a `await rateLimit(...)`; todos
// corrían YA dentro de una función async, así que el cambio es mecánico y no
// hay ningún `if` síncrono que arreglar dos veces.
//
// ── LO QUE NO CAMBIÓ (sigue siendo cierto) ────────────────────────────────
//
//  · `bodyExcede` es sólo la preselección por cabecera. Las rutas nuevas que
//    aceptan body usan `leerTextoAcotado`, que corta el stream por bytes.
//  · UN `false` DE AQUÍ NO AUTORIZA A TIRAR NADA. Ver la nota del webhook de
//    WhatsApp: sobre una entrada YA AUTENTICADA, aplazar con un código que
//    provoque reintento — nunca descartar en silencio. Descartar solo es
//    aceptable donde el que insiste es un desconocido (`acceso:`, `login:`).
// ═══════════════════════════════════════════════════════════════════════════

/** Sellos de tiempo vivos de una llave, y cuándo deja de importar la llave. */
type Cubeta = { sellos: number[]; expiraEn: number };

const buckets = new Map<string, Cubeta>();
const MAX_KEYS = 5000;              // backstop de memoria
const OBJETIVO_TRAS_PODA = Math.floor(MAX_KEYS * 0.75);

/**
 * El backend LOCAL, por instancia — sliding window de verdad (descarta cada
 * sello fuera de la ventana). Es el módulo entero de antes de esta ronda:
 * sigue siendo el único backend cuando no hay Redis, y el respaldo cuando sí
 * lo hay pero falla. Devuelve true si la petición se PERMITE.
 */
function limiteLocal(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const prev = buckets.get(key);
  const vivos = (prev?.sellos ?? []).filter((t) => now - t < windowMs);

  // La cubeta deja de decir nada cuando su sello más nuevo sale de la ventana.
  const guardar = (sellos: number[]) =>
    buckets.set(key, { sellos, expiraEn: (sellos.length ? Math.max(...sellos) : now) + windowMs });

  if (vivos.length >= limit) {
    guardar(vivos);
    return false;
  }
  vivos.push(now);
  guardar(vivos);

  if (buckets.size > MAX_KEYS) podar(now);
  return true;
}

/**
 * Poda por CADUCIDAD, no por orden de alta.
 *
 * La versión anterior borraba «el primer cuarto de las llaves» recorriendo el
 * Map, que conserva el orden de INSERCIÓN — y `set` sobre una llave existente no
 * la mueve al final. O sea: borraba las primeras que se vieron, estuvieran vivas
 * o no. Una llave bloqueada desde hace un minuto podía desaparecer (y con ella
 * su bloqueo) mientras se conservaban cinco mil cubetas ya caducadas.
 *
 * Ahora se tira primero lo que ya no dice nada, y solo si con eso no basta se
 * tira lo que caduca antes.
 */
function podar(now: number): void {
  for (const [k, c] of buckets) {
    if (c.expiraEn <= now) buckets.delete(k);
  }
  if (buckets.size <= MAX_KEYS) return;

  const porCaducidad = [...buckets.entries()].sort((a, b) => a[1].expiraEn - b[1].expiraEn);
  const sobran = buckets.size - OBJETIVO_TRAS_PODA;
  for (let i = 0; i < sobran; i++) buckets.delete(porCaducidad[i][0]);
}

// ── Backend distribuido (Upstash Redis, REST) ───────────────────────────────

const PREFIJO_LLAVE = 'likida:rl:';
const TIMEOUT_REDIS_MS = 1200; // la REST API de Upstash contesta en decenas de
                                // ms; 1.2 s ya es "algo está mal", no "está lento".

/**
 * Incrementa `KEYS[1]` y, SOLO la primera vez (`n == 1`), le pone TTL en ms.
 * Ver la cabecera del archivo: sin el `if`, cada hit alargaría la ventana.
 */
const SCRIPT_INCR_CON_TTL = `
local n = redis.call("INCR", KEYS[1])
if n == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return n
`;

/** Exportada para `/admin/salud-sistema`: el renglón mide lo mismo que decide
 *  este módulo, no una copia — dos mediciones del mismo hecho se desincronizan
 *  al primer cambio (mismo criterio que el resto de esa pantalla). */
export function redisConfigurado(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

/**
 * Un intento contra Redis. `null` = no se pudo saber (sin credenciales, red
 * caída, timeout, respuesta rara) — NUNCA LANZA: `rateLimit` decide qué hacer
 * con un `null`, este helper solo mide.
 */
async function intentarRedis(key: string, limit: number, windowMs: number): Promise<boolean | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      // Comando crudo como array JSON — la forma que la REST API de Upstash
      // documenta para no reescribir cada verbo como un path distinto.
      body: JSON.stringify(['EVAL', SCRIPT_INCR_CON_TTL, 1, `${PREFIJO_LLAVE}${key}`, windowMs]),
      signal: AbortSignal.timeout(TIMEOUT_REDIS_MS),
    });
    const json = (await r.json()) as { result?: number; error?: string };
    if (!r.ok || typeof json.result !== 'number') {
      logger.error('ratelimit.redis_fallo', { llave: categoria(key), status: r.status, err: json.error });
      return null;
    }
    return json.result <= limit;
  } catch (e) {
    // Timeout (AbortError) o red caída: mismo tratamiento, es "no se pudo saber".
    logger.error('ratelimit.redis_fallo', { llave: categoria(key), err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** SEG-4 (auditoría 24, reincidente de la 22): la llave entera lleva IP o id
 *  de usuario; al log solo va su CATEGORÍA (`login`, `health`, `demo`…). */
function categoria(key: string): string {
  return key.split(':')[0] || 'sin-categoria';
}

let avisadoBackend = false;

/**
 * Deja constancia en el arranque de qué backend está activo. Se dispara UNA
 * vez por instancia fría, en el PRIMER uso — no hay un `instrumentation.ts`
 * enganchado desde este módulo (fuera del alcance de esta entrega, que solo
 * toca `ratelimit.ts`, sus llamadores, `next.config.ts` y su migración), así
 * que el primer `rateLimit()` de la instancia hace las veces de arranque: es,
 * de hecho, cuándo una función serverless arranca de verdad — con el primer
 * request que la despierta.
 *
 * Mismo criterio que `avisarObservabilidad`: solo suena en un despliegue real
 * (`VERCEL_ENV` o `NODE_ENV=production`); en local y en pruebas sería ruido
 * diario por algo que ahí es el default esperado.
 */
function avisarBackend(): void {
  if (avisadoBackend) return;
  avisadoBackend = true;

  const desplegado = !!process.env.VERCEL_ENV || process.env.NODE_ENV === 'production';
  if (!desplegado) return;

  if (redisConfigurado()) {
    logger.info('startup.ratelimit_backend', { backend: 'redis' });
  } else {
    const err = 'UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN ausentes: el límite vive en la memoria de CADA instancia — en Vercel, N intentos se vuelven N × instancias abiertas en paralelo. No hay límite global.';
    logger.error('startup.ratelimit_backend', { backend: 'memoria', err });
    // SEG-4 (auditoría 24): en PRODUCCIÓN esto no es un log que nadie lee —
    // es la única defensa de cuatro endpoints públicos apagada. Sale por el
    // canal del operador (piso de una hora, nunca lanza). Import dinámico
    // para no cargar el árbol del correo en cada instancia que solo limita.
    if (process.env.VERCEL_ENV === 'production') {
      void import('@/lib/observability/alerta')
        .then((m) => m.alertarOperador('ratelimit.sin_redis', { error: err, codigo: 'ratelimit_sin_redis' }))
        .catch(() => { /* el aviso es de mejor esfuerzo; el log de arriba ya quedó */ });
    }
  }
}

export interface OpcionesRateLimit {
  /**
   * Qué hacer si Redis está configurado y el intento FALLA a media petición
   * (timeout, red, 5xx). `true` niega; `false` degrada al Map local. Sin
   * indicar, manda `RATELIMIT_REDIS_FALLA_CERRADO`, cuyo default es CERRADO
   * (SEG-4, auditoría 24).
   */
  fallaCerrado?: boolean;
}

/** El default de la avería de Redis: cerrado, salvo que la env diga «false». */
export function fallaCerradoPorDefault(): boolean {
  return process.env.RATELIMIT_REDIS_FALLA_CERRADO !== 'false';
}

/**
 * Devuelve true si la petición se PERMITE, false si excede el límite.
 *
 * Con Redis configurado, el conteo es GLOBAL (mismo resultado sin importar
 * cuántas instancias de Vercel atiendan la ráfaga). Sin credenciales, o si el
 * intento contra Redis falla, cae al Map local — ver la cabecera del archivo
 * para la justificación completa de esa degradación.
 */
export async function rateLimit(key: string, limit: number, windowMs: number, opciones: OpcionesRateLimit = {}): Promise<boolean> {
  avisarBackend();

  if (redisConfigurado()) {
    const resultado = await intentarRedis(key, limit, windowMs);
    if (resultado !== null) return resultado;

    const cerrado = opciones.fallaCerrado ?? fallaCerradoPorDefault();
    if (cerrado) {
      logger.warn('ratelimit.redis_falla_cerrado', { llave: categoria(key) });
      return false;
    }
    return limiteLocal(key, limit, windowMs);
  }

  return limiteLocal(key, limit, windowMs);
}

/** Solo para pruebas: el Map y el aviso de arranque son de módulo y se
 *  comparten entre casos. */
export function reiniciarLimites(): void {
  buckets.clear();
  avisadoBackend = false;
}

/** IP del cliente desde las cabeceras de proxy (Vercel: x-forwarded-for). */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  return (xff ? xff.split(',')[0].trim() : req.headers.get('x-real-ip')) || 'desconocida';
}

/**
 * true si el body excede el tope SEGÚN `content-length`, ANTES de leerlo.
 *
 * OJO CON LO QUE ESTO NO ES. Sin `content-length` —`Transfer-Encoding: chunked`—
 * `Number(null || 0)` da 0 y esta función dice "cabe". No es un descuido que se
 * pueda arreglar aquí: la cabecera es lo único que hay antes de leer el cuerpo.
 * Quien llame a esto TIENE que combinarlo con una lectura streaming acotada;
 * `leerTextoAcotado` es la frontera reusable para ese contrato. Se conserva
 * esta preselección para multipart y compatibilidad con WhatsApp.
 */
export function bodyExcede(req: Request, maxBytes: number): boolean {
  const len = Number(req.headers.get('content-length') || 0);
  return len > maxBytes;
}
