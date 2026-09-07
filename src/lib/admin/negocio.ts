// ═══════════════════════════════════════════════════════════════════════════
// RESUMEN DE NEGOCIO — la consola de superadmin, no el panel de una flota.
//
// Cruza TODOS los tenants a propósito: es la única función del repo con
// permiso de ver toda la base a la vez. `usd()` (formato.ts) ya lo advierte
// en su propio comentario — "nunca para el cliente" — y esta es la primera
// pantalla que de verdad lo pinta: costo de IA en dólares, por fase, de
// Likida completa. Vive fuera de analytics.ts (tenant-scoped en cada línea)
// para que nadie copie un patrón de aquí a una consulta de cliente y filtre
// de menos.
//
// PAGINADO DESDE EL 4-AGO-2026. El comentario anterior decía "hoy son 131
// filas de llm_costo y 1 tenant; el día que crezca de verdad, esto necesita el
// mismo `traerTodo` que ya usa analytics.ts — no antes". Ese día es el mes 1:
// `llm_costo` recibe una fila POR LLAMADA al modelo (OCR de cada foto, cuadre,
// router), así que una sola flota operando en serio lo pasa de mil en semanas.
// Y estas cuatro consultas iban SIN paginar y SIN `limit`, cruzando todos los
// tenants: PostgREST las recortaba a `max_rows` en silencio y la consola de
// superadmin reportaba una fracción del gasto de IA —la cifra con la que se
// decide el precio del producto— sin marca de que estuviera incompleta.
//
// Y AGREGADO EN SQL DESDE EL 5-AGO-2026 (mig. 0062). Paginar arregló el recorte
// silencioso pero no el fondo: `traerTodo` LANZA al agotar sus 100 páginas
// (100,000 filas), y `llm_costo` recibe ~2,000 filas diarias. 100,000 / 2,000 =
// **día 50**. La consola no iba a mentir, iba a dejar de cargar, y la fecha se
// puede calcular con una división. `resumen_costo_ia()` suma en la base y cruza
// la red UNA fila: el tamaño del payload pasa a depender del número de GRUPOS
// (fases, modelos, días, flotas), no del número de llamadas al modelo.
//
// Y `viaje`/`gasto` TAMBIÉN EN SQL DESDE EL 22-AGO-2026 (mig. 0153). El párrafo
// de arriba decía que `gasto` "es la siguiente en la fila (~240 mil al año)";
// con un cliente de 50,000 viajes/mes son 300,000 gastos AL MES: `traerTodo`
// rebasaba sus 100,000 filas al **día ~10** y las ~17 páginas de /admin que
// leen `getResumenNegocio` dejaban de cargar (docs/escala-50k/MAPA.md §/admin).
// `resumen_negocio()` cuenta en la base (por flota, por día local MX) y cruza
// la red UNA fila. Es CROSS-TENANT a propósito y revocada a anon/authenticated
// — ver la cabecera de la migración antes de copiar el molde a otro lado.
//
// Y CON CACHÉ DE 60 SEGUNDOS DESDE EL 22-AGO-2026 (ESC-10). Agregar en SQL
// bajó el payload, no el número de veces que se agrega: las ~17 páginas de
// /admin llaman a `getResumenNegocio` en CADA carga, y cada llamada dispara
// los dos recorridos completos (`llm_costo` y `viaje`+`gasto`). Navegar entre
// cinco pantallas de la consola son diez agregaciones de la base entera para
// enseñar cifras que no cambiaron en ese minuto.
//
// SE CACHEAN LAS DOS RPC, NO EL CATÁLOGO DE FLOTAS, y la distinción es de
// producto: `llm_costo`, `viaje` y `gasto` los escribe el pipeline (nadie los
// edita desde /admin), así que un minuto de retraso en esas cifras no
// contradice a nadie. `tenant` SÍ se edita desde la consola —dar de alta una
// flota, cambiar su plan, declarar la facilidad del 15%— y ahí un minuto de
// caché haría que el `revalidatePath` de la acción se viera no hacer nada.
// Por eso esa lectura sigue en vivo: la flota nueva aparece en el acto, con
// sus cifras en cero, que es la verdad.
//
// Toda consulta de este archivo va envuelta en `acotada()` (presupuesto.ts):
// la consola no tiene el presupuesto del webhook, pero un `Promise.all` de
// dieciséis lecturas sin techo colgado en una sola es toda la página en blanco.
// `acotada_guardiana.test.ts` lo exige archivo por archivo.
// ═══════════════════════════════════════════════════════════════════════════

import { unstable_cache } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { conteo, traerTodo } from '@/lib/likida/pg';
import { acotada } from '@/lib/likida/presupuesto';
import { round2, TZ_MX, hoyMx } from '@/lib/formato';
import { anotarBitacora } from '@/lib/likida/bitacora_escritura';
import { DatoInvalido } from '@/lib/likida/errores';
import { facilidad15Vigente } from '@/lib/likida/perfil/preguntas';
// Solo TIPOS: `import type` se borra al compilar, así que esto no arrastra el
// módulo de corridas (que carga supabaseAdmin/logger al importarse) — aquí
// nada más se quiere el dominio del CHECK de la 0102 escrito una vez.
import type { AgenteConCorridas, EstadoCorrida } from '@/lib/likida/agentes/corridas';

// ═══════════════════════════════════════════════════════════════════════════
// LA CACHÉ DE LA CONSOLA (ESC-10)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Sesenta segundos: lo que tarda Javier en pasar de una pantalla de /admin a
 * otra, y menos de lo que tarda cualquiera en notar que una cifra de gasto de
 * IA no se movió. No es un número de rendimiento, es un número de producto —
 * más arriba empezaría a contradecir al reloj del sidebar.
 */
export const SEGUNDOS_CACHE_CONSOLA = 60;

/**
 * `unstable_cache` cuando hay un Next debajo, y la función PELADA cuando no.
 *
 * El guard no es cosmético: fuera de una petición de Next, `unstable_cache`
 * lanza `Invariant: incrementalCache missing` — o sea, importar este módulo
 * desde una prueba (o desde un script) reventaría en la primera llamada. El
 * mismo interruptor que usa `instrumentation.ts` (`process.env.NEXT_RUNTIME`,
 * que Next sustituye en tiempo de build) distingue los dos mundos.
 *
 * Consecuencia declarada: en las pruebas NO hay caché, y es lo correcto —
 * memorizar entre casos haría que el fixture del segundo `it` no se leyera.
 */
function conCacheDeConsola<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  llaves: string[],
): (...args: A) => Promise<R> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return fn;
  return unstable_cache(fn, llaves, { revalidate: SEGUNDOS_CACHE_CONSOLA, tags: ['admin-consola'] });
}

// ═══════════════════════════════════════════════════════════════════════════
// LA AGREGACIÓN DE `llm_costo`, EN SQL
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Lo que devuelve `resumen_costo_ia()` (mig. 0062): las seis agregaciones de
 * `llm_costo` en un solo `jsonb`, calculadas en UN recorrido de la tabla.
 *
 * Los costos vienen SIN REDONDEAR, en la precisión completa del `numeric(10,6)`
 * sumado en la base. El redondeo a centavos sigue siendo de `round2()`
 * (formato.ts), que es el único sitio del repo donde se redondea dinero;
 * redondear en los dos lados sería redondear dos veces.
 */
interface ResumenCostoIa {
  /** `n` distingue "no hay NI UNA llamada registrada" de "las llamadas costaron
   *  $0" — la misma distinción que exige `ResumenCosto` en costos.ts. */
  totales: { n: number; costoUsd: number; tokensIn: number; tokensOut: number };
  porFase: Array<{ fase: string; n: number; costoUsd: number }>;
  porModelo: Array<{ modelo: string; n: number; costoUsd: number }>;
  porFaseModelo: Array<{ fase: string; modelo: string; n: number; costoUsd: number }>;
  /** DISPERSA: solo los días con actividad, igual que cuando se agrupaba en JS. */
  porDia: Array<{ dia: string; costoUsd: number; tokens: number }>;
  porTenant: Array<{ tenantId: string; costoUsd: number }>;
}

/**
 * Llama a la agregación y **falla cerrado**.
 *
 * Dos comprobaciones, no una. La primera es la de siempre: supabase-js reporta
 * el error POR VALOR, así que sin mirar `.error` una base caída se leería como
 * "$0 de gasto de IA".
 *
 * La segunda es nueva y hace falta justo por haber movido esto a la base: si la
 * función no existe todavía (una rama sin la 0062 aplicada) o devuelve otra
 * forma, `data` llega como algo que no es este objeto y cada `?? 0` de abajo
 * pintaría un cero que nadie midió. Por eso se valida la FORMA antes de leerla:
 * el modo de fallo que importa aquí no es "se cayó", es "bajó sola".
 */
async function leerResumenCostoIa(
  desde: string | null,
  hasta: string | null,
): Promise<ResumenCostoIa> {
  const { data, error } = await acotada(
    supabaseAdmin().rpc('resumen_costo_ia', { p_desde: desde, p_hasta: hasta }),
    'resumen_costo_ia',
  );
  if (error) throw new Error(`resumen_costo_ia: ${error.message}`);

  const r = data as Partial<ResumenCostoIa> | null;
  const t = r?.totales;
  if (
    !t || typeof t.n !== 'number' || typeof t.costoUsd !== 'number'
    || typeof t.tokensIn !== 'number' || typeof t.tokensOut !== 'number'
    || !Array.isArray(r?.porFase) || !Array.isArray(r?.porModelo)
    || !Array.isArray(r?.porFaseModelo) || !Array.isArray(r?.porDia)
    || !Array.isArray(r?.porTenant)
  ) {
    throw new Error(
      'resumen_costo_ia: la respuesta no tiene la forma esperada (¿migración 0062 sin aplicar?). '
      + 'No se devuelve un resumen a medias: un cero aquí se lee como "la IA salió gratis".',
    );
  }
  return r as ResumenCostoIa;
}

const resumenCostoIaCacheado = conCacheDeConsola(leerResumenCostoIa, ['admin', 'resumen_costo_ia']);

/**
 * La misma lectura, con 60 s de caché. El wrapper conserva los defaults a
 * propósito: `unstable_cache` mete los argumentos en la llave, y llamarla
 * unas veces con `()` y otras con `(null, null)` guardaría DOS entradas con
 * el mismo contenido — dos recorridos de `llm_costo` en vez de uno.
 */
async function traerResumenCostoIa(
  desde: string | null = null,
  hasta: string | null = null,
): Promise<ResumenCostoIa> {
  return resumenCostoIaCacheado(desde, hasta);
}

/**
 * Lo que devuelve `resumen_negocio()` (mig. 0153): los conteos de `viaje` y
 * `gasto` de TODAS las flotas, en un solo `jsonb`. `facturasPorDia` viene
 * DISPERSA (solo los días con actividad, día LOCAL de México) y acotada a
 * `p_desde`; los dos totales son históricos a propósito (así los rotula la
 * consola).
 */
interface ResumenNegocioSql {
  viajesTotal: number;
  viajesPorTenant: Array<{ tenantId: string; n: number }>;
  facturasTotal: number;
  facturasPorDia: Array<{ dia: string; n: number }>;
}

const esConteo = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * Llama a la agregación cross-tenant y **falla cerrado** — mismas dos
 * comprobaciones que `traerResumenCostoIa`: el error por valor, y la FORMA.
 * Si la 0153 no está aplicada, PostgREST responde 404 y se lanza; si
 * responde otra cosa (un NULL donde iba un array, un conteo que no es
 * entero), también: un `?? 0` aquí pintaría "0 viajes procesados" como si
 * alguien los hubiera contado.
 */
async function leerResumenNegocio(desde: string | null): Promise<ResumenNegocioSql> {
  const { data, error } = await acotada(
    supabaseAdmin().rpc('resumen_negocio', { p_desde: desde }),
    'resumen_negocio',
  );
  if (error) throw new Error(`resumen_negocio: ${error.message}`);
  const r = data as Partial<ResumenNegocioSql> | null;
  const tenantsOk = Array.isArray(r?.viajesPorTenant)
    && r.viajesPorTenant.every((t) => typeof t?.tenantId === 'string' && esConteo(t?.n));
  const diasOk = Array.isArray(r?.facturasPorDia)
    && r.facturasPorDia.every((d) => typeof d?.dia === 'string' && esConteo(d?.n));
  if (!r || !esConteo(r.viajesTotal) || !esConteo(r.facturasTotal) || !tenantsOk || !diasOk) {
    throw new Error(
      'resumen_negocio: la respuesta no tiene la forma esperada (¿migración 0153 sin aplicar?). '
      + 'No se devuelve un resumen a medias: un cero aquí se lee como "no se ha procesado nada".',
    );
  }
  return r as ResumenNegocioSql;
}

/** Misma lectura, 60 s de caché (ESC-10). Ver `conCacheDeConsola`. */
const traerResumenNegocio = conCacheDeConsola(leerResumenNegocio, ['admin', 'resumen_negocio']);

/**
 * El costo de IA del MES EN CURSO (mes de México) — alimenta el widget de
 * uso del sidebar de /admin (16-ago-2026, ref. shadcn-dashboard). Reusa la
 * MISMA agregación en SQL que la consola; LANZA si la base no responde y el
 * llamador degrada diciéndolo — el widget jamás pinta $0 sin medición.
 */
export async function costoIaMesActual(): Promise<{ mesUsd: number; llamadas: number; etiquetaMes: string }> {
  const ahora = new Date();
  // El MES de México, no el UTC — misma trampa que ya cobró en facturasPorDia.
  const mesMx = hoyMx(ahora).slice(0, 7);
  const desde = new Date(`${mesMx}-01T00:00:00-06:00`).toISOString();
  const r = await traerResumenCostoIa(desde, null);
  const etiquetaMes = new Intl.DateTimeFormat('es-MX', { timeZone: TZ_MX, month: 'long' }).format(ahora);
  return { mesUsd: round2(r.totales.costoUsd), llamadas: r.totales.n, etiquetaMes };
}

/**
 * El costo de IA de TODAS las flotas desde un instante — para el modelo de
 * capacidad (capacidad.ts), que antes sumaba `llm_costo` en JS con un
 * `.limit(10000)` que recortaba en silencio. Misma agregación, sin redondear
 * (el llamador divide entre viajes antes de mostrar). LANZA si no se pudo leer.
 */
export async function costoIaDesde(desdeIso: string): Promise<{ n: number; costoUsd: number }> {
  const r = await traerResumenCostoIa(desdeIso, null);
  return { n: r.totales.n, costoUsd: r.totales.costoUsd };
}

/**
 * El costo de IA de UNA flota (histórico y 30 días) — para la ficha 360.
 * Reusa la agregación SQL global y toma la fila del tenant: dos llamadas al
 * RPC, cero recorridos de llm_costo por JS. LANZA si la base no responde.
 */
export async function costoIaDeTenant(tenantId: string): Promise<{ historicoUsd: number; d30Usd: number }> {
  const hace30d = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [historico, d30] = await Promise.all([
    traerResumenCostoIa(null, null),
    traerResumenCostoIa(hace30d, null),
  ]);
  const de = (r: ResumenCostoIa) => r.porTenant.find((t) => t.tenantId === tenantId)?.costoUsd ?? 0;
  return { historicoUsd: round2(de(historico)), d30Usd: round2(de(d30)) };
}

export interface CostoIaVentana {
  totales: { n: number; costoUsd: number; tokensIn: number; tokensOut: number };
  porFase: Array<{ fase: string; n: number; costoUsd: number }>;
  porTenant: Array<{ tenantId: string; costoUsd: number }>;
}

/**
 * El costo de IA ACOTADO a una ventana [desde, hasta) — para el cierre
 * mensual (agentes financieros, 0215), que cierra el mes ANTERIOR y no puede
 * usar los totales históricos de `getResumenNegocio`. Es la MISMA agregación
 * de siempre (RPC 0062, que sí acepta la ventana; `llm_costo` NO se purga —
 * 0072 la consolida sin borrar, así que el mes anterior está completo);
 * LANZA si la base no responde — el cierre no se arma con la base ciega.
 */
export async function costoIaVentana(desdeIso: string, hastaIso: string): Promise<CostoIaVentana> {
  const r = await traerResumenCostoIa(desdeIso, hastaIso);
  return { totales: r.totales, porFase: r.porFase, porTenant: r.porTenant };
}

export interface ResumenNegocio {
  tenants: number;
  flotas: Array<{
    id: string; nombre: string; plan: string; viajes: number; costoIaUsd: number;
    facilidad15?: { dedicacionExclusivaCarga?: boolean; regimenElegible?: boolean };
    /** ¿La flota guardó SU política de gastos? Se mide sobre el OVERRIDE crudo
     *  (`tenant.config.politica`) y no sobre `getConfig()` a propósito:
     *  `getConfig` fusiona con `DEMO_CONFIG` y su resultado no distingue "la
     *  flota decidió estos topes" de "corren los defaults de demo". Un array
     *  vacío cuenta como configurada — `fusionarConfig` lo documenta como una
     *  decisión, no un hueco. */
    politicaPropia: boolean;
  }>;
  viajesProcesados: number;
  costoIaUsd: number;
  tokensIn: number;
  tokensOut: number;
  porFase: Array<{ fase: string; n: number; costoUsd: number }>;
  porModelo: Array<{ modelo: string; n: number; costoUsd: number }>;
  porDia: Array<{ dia: string; costoUsd: number; tokens: number }>;
  /** Facturas (filas de `gasto` — cada una es un comprobante que pasó por
   *  OCR/CFDI) procesadas por día, ventana de `ventanaDias` (default 7) —
   *  siempre TODAS las fechas de la ventana, con `n: 0` en las que no hubo
   *  actividad, para que la gráfica de barras no comprima el periodo a un
   *  solo día real. El día es el DE MÉXICO, no el UTC (14-ago-2026): con el
   *  corte UTC, a las 6pm de CDMX la última barra ya rotulaba mañana y un
   *  comprobante de la tarde caía en la barra del día siguiente. */
  facturasPorDia: Array<{ dia: string; n: number }>;
  /** Total histórico de facturas (todas las filas de `gasto`, sin filtro
   *  de fecha) — para el contador retro junto al saludo. */
  facturasTotal: number;
  /** % de cambio de los últimos 7 días vs los 7 anteriores — `null` sin
   *  suficiente historia (menos de 14 días con datos) para no inventar una
   *  tendencia de dos puntos. */
  tendenciaCosto: number | null;
  tendenciaTokens: number | null;
}

/**
 * `hoy` es inyectable (default: fecha real) — mismo criterio que
 * `cuadrarViaje({ hoy })` en el motor: una prueba de tendencia no puede
 * depender del reloj del sistema el día que corra.
 *
 * `ventanaDias` (default 7) es lo que mueve el `<GlobalFilter>` de Inicio
 * (7d/30d) — solo afecta `facturasPorDia`; el resto de los números
 * (costoIaUsd, tendencias, etc.) son totales o comparativos de 7 días fijos
 * a propósito, no se re-derivan por ventana todavía.
 *
 * Esa deuda NO la salda la 0062. `resumen_costo_ia()` acepta `p_desde`/`p_hasta`
 * y aquí se le mandan NULL a propósito: acotar el costo de IA a la ventana
 * cambiaría la cifra con la que se pone el precio del producto, y eso es un
 * cambio de producto, no de rendimiento. El día que se decida, es un argumento.
 */
export async function getResumenNegocio(
  // El día de MÉXICO, no `toISOString().slice(0, 10)` (que es el día UTC): a
  // las 6pm de CDMX ya es mañana en UTC, y la ventana de `facturasPorDia`
  // terminaba en una fecha que el usuario todavía no vive (hallazgo 13-ago).
  hoy: string = hoyMx(),
  ventanaDias: number = 7,
): Promise<ResumenNegocio> {
  const admin = supabaseAdmin();
  // Las fechas de la ventana se calculan sobre `hoy` (día MX) en UTC puro —
  // aritmética de calendario, sin zona— para que "hoy" sea inyectable en las
  // pruebas en vez de depender del reloj real.
  const cortes = (diasAtras: number) => {
    const d = new Date(`${hoy}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - diasAtras);
    return d.toISOString().slice(0, 10);
  };
  // El corte de `facturasPorDia`: la MEDIANOCHE DE MÉXICO del primer día de la
  // ventana, como instante (`-06:00`: México no tiene horario de verano desde
  // 2022 — el mismo supuesto que `costoIaMesActual`). La RPC bucketea por día
  // local MX, así que lo que entra por este corte cae exactamente en las
  // `ventanaDias` barras que se pintan abajo.
  const desdeVentana = new Date(`${cortes(ventanaDias - 1)}T00:00:00-06:00`).toISOString();

  // `tenant` SÍ se trae con `traerTodo` (una fila por flota — cientos, no
  // cientos de miles): cubre el error por valor y el recorte a `max_rows`, y
  // LANZA si no completa. `llm_costo` (0062) y `viaje`/`gasto` (0153) no se
  // traen: se cuentan en la base. Ver la cabecera.
  //
  // AUDITORÍA 24, ADM-3 (ALTO): `not.ilike('nombre', 'ZZZ %')` — una corrida
  // de QA abortada CONSERVA su tenant sintético a propósito (es evidencia
  // para inspección, ver qa-motor.ts), y sin este filtro entraba aquí como
  // una flota real hasta que alguien la limpiara a mano. El prefijo 'ZZZ '
  // es la misma llave que usa el guard de borrado del ejército de QA
  // (`scripts/qa-agentes/config.qa.ts`) — no una convención nueva.
  const [tenantsData, costoIa, negocio] = await Promise.all([
    traerTodo<{ id: string; nombre: string; plan: string; config: unknown; perfil: unknown }>(
      (d, h) => acotada(
        // AUDITORÍA 28, FIS-A3: `perfil` viaja junto con `config` — la
        // facilidad del 15% que se muestra/edita aquí tiene que leer la MISMA
        // fuente única (perfil primero) que `desde_db.ts`/`fiscal.ts`/
        // `tools.ts`, no solo el legado de `tenant.config`.
        admin.from('tenant').select('id, nombre, plan, config, perfil', conteo(d)).not('nombre', 'ilike', 'ZZZ %').order('id').range(d, h),
        'getResumenNegocio/tenant',
      ),
      'getResumenNegocio/tenant',
    ),
    traerResumenCostoIa(),
    traerResumenNegocio(desdeVentana),
  ]);
  const costoIaUsd = costoIa.totales.costoUsd;
  const tokensIn = costoIa.totales.tokensIn;
  const tokensOut = costoIa.totales.tokensOut;
  const costoPorTenant = new Map<string, number>(
    costoIa.porTenant.map((t) => [t.tenantId, t.costoUsd]),
  );
  // El orden ya viene de SQL (costo desc, y el día ascendente), así que aquí
  // solo se redondea. Reordenar en JS sobre la cifra YA redondeada es lo que
  // hacía la versión anterior, y con dos fases que redondeen al mismo centavo
  // el desempate quedaba a merced del orden de un `Map`.
  const porFase = costoIa.porFase.map((f) => ({ ...f, costoUsd: round2(f.costoUsd) }));
  const porModelo = costoIa.porModelo.map((m) => ({ ...m, costoUsd: round2(m.costoUsd) }));
  // `dia` es el corte UTC que hace la 0062 (`created_at at time zone 'UTC'`),
  // el mismo que daba el viejo `created_at.slice(0, 10)`: es una gráfica de
  // tendencia, no un dato fiscal, y moverlo a hora de México cambiaría la serie
  // histórica sin que nadie lo pidiera.
  const porDia = costoIa.porDia.map((d) => ({ ...d, costoUsd: round2(d.costoUsd) }));

  // Tendencia real, no de adorno: si la ventana ANTERIOR está vacía (Likida
  // lleva menos de 7 días con actividad), "creció ∞%" no dice nada — se
  // calla en vez de inventar una flecha.
  const [inicioActual, inicioAnterior] = [cortes(7), cortes(14)];
  const sumaEnVentana = (desde: string, hasta: string, campo: 'costoUsd' | 'tokens') =>
    porDia.filter((d) => d.dia >= desde && d.dia < hasta).reduce((s, d) => s + d[campo], 0);
  const tendencia = (campo: 'costoUsd' | 'tokens'): number | null => {
    const actual = sumaEnVentana(inicioActual, cortes(0), campo);
    const anterior = sumaEnVentana(inicioAnterior, inicioActual, campo);
    if (anterior === 0) return null;
    return round2(((actual - anterior) / anterior) * 100);
  };

  const viajesPorTenant = new Map<string, number>(
    negocio.viajesPorTenant.map((t) => [t.tenantId, t.n]),
  );
  // Últimos `ventanaDias` días, SIEMPRE todas las fechas (0 donde no hubo
  // facturas): la RPC manda la serie dispersa y aquí se rellena contra el
  // calendario de `cortes()`. Un día sin fila es un CERO medido — la
  // agregación corrió sobre la ventana entera—, no un hueco.
  //
  // El bucket es el DÍA DE MÉXICO, calculado en SQL (`at time zone
  // 'America/Mexico_City'`, mig. 0153) — el mismo corte que `diaMx` hacía en
  // JS: una factura procesada a las 7pm de CDMX cuenta en la barra de HOY,
  // no en la de mañana. (`porDia` del costo de IA sí se queda en UTC a
  // propósito — su comentario de arriba explica por qué no se mueve la serie.)
  const facturasPorDiaMap = new Map<string, number>(
    negocio.facturasPorDia.map((d) => [d.dia, d.n]),
  );
  const facturasPorDia = [...new Array(ventanaDias).keys()].map((i) => {
    const dia = cortes(ventanaDias - 1 - i);
    return { dia, n: facturasPorDiaMap.get(dia) ?? 0 };
  });

  const flotas = tenantsData.map((t) => {
    const cfg = (t.config as { facilidadCombustibleEfectivo?: { dedicacionExclusivaCarga?: boolean; regimenElegible?: boolean }; politica?: unknown } | null) ?? null;
    return {
      id: t.id, nombre: t.nombre, plan: t.plan,
      viajes: viajesPorTenant.get(t.id) ?? 0,
      costoIaUsd: round2(costoPorTenant.get(t.id) ?? 0),
      // La declaración del 15% (RFA 2.9) viaja al panel para verse y
      // corregirse — AUDITORÍA 28, FIS-A3: la MISMA fuente única que
      // `desde_db.ts`/`fiscal.ts`/`tools.ts` (perfil primero, `tenant.config`
      // como legado), no solo el legado leído aquí solo.
      facilidad15: facilidad15Vigente(t.perfil, cfg),
      // Sobre el override CRUDO, no sobre getConfig() — ver el comentario del tipo.
      politicaPropia: Array.isArray(cfg?.politica),
    };
  });
  return {
    tenants: flotas.length,
    flotas,
    viajesProcesados: negocio.viajesTotal,
    costoIaUsd: round2(costoIaUsd),
    tokensIn,
    tokensOut,
    porFase,
    porModelo,
    porDia,
    facturasPorDia,
    facturasTotal: negocio.facturasTotal,
    tendenciaCosto: tendencia('costoUsd'),
    tendenciaTokens: tendencia('tokens'),
  };
}

export interface CostoPorFaseModelo { fase: string; modelo: string; n: number; costoUsd: number }

/**
 * `llm_costo` agrupado por fase Y modelo A LA VEZ (no cada uno por separado
 * como en `getResumenNegocio`) — para Model Ops y Agente OCR, que necesitan
 * saber qué modelo corrió DENTRO de una fase específica (p. ej. "¿qué costó
 * OCR, desglosado por modelo?"), algo que `porFase`/`porModelo` no pueden
 * responder solos porque cada uno agrupa por un solo eje. Mismo dato real
 * de siempre, solo agrupado más fino — nada nuevo que instrumentar.
 *
 * Sale del MISMO `resumen_costo_ia()` que `getResumenNegocio` (mig. 0062), como
 * un sexto corte del `grouping sets`. Antes esto volvía a arrastrar `llm_costo`
 * entera por segunda vez en las páginas que piden las dos cosas (Model Ops,
 * Agente OCR): dos recorridos de la tabla que más rápido crece para pintar una
 * sola pantalla. Ahora el corte (fase, modelo) sale del recorrido que ya se
 * estaba pagando; el costo extra es una llave de hash más sobre ~60 grupos.
 */
export async function getCostoPorFaseModelo(
  /** AUDITORÍA FABLE CICLO 5 (c5-8): sin ventana, el corte es el HISTÓRICO
   *  completo — y el umbral U1 de control_costos comparaba TODA la historia
   *  contra el modelo esperado de hoy: cualquier migración legítima de
   *  modelo disparaba ROJO en cada parte diario, para siempre. El agente
   *  pasa una ventana reciente; las pantallas que quieren el histórico
   *  siguen llamando sin argumento. */
  desdeIso: string | null = null,
): Promise<CostoPorFaseModelo[]> {
  const { porFaseModelo } = await traerResumenCostoIa(desdeIso, null);
  // Ya viene ordenado por costo desc (y fase, modelo como desempate estable):
  // aquí solo se redondea a centavos.
  return porFaseModelo.map((v) => ({ ...v, costoUsd: round2(v.costoUsd) }));
}

export interface TurnoConversacion { role: 'user' | 'assistant'; content: string }

export interface ConversacionActiva {
  telefono: string;
  /** FE-23: `wa_conversacion` está anclada por (tenant, teléfono) — el mismo
   *  número puede aparecer en dos flotas (un chofer que cambia de patrón, un
   *  número de oficina compartido). Sin el tenant, la llave de React de la
   *  lista se repetía y las dos filas se pisaban al renderizar. */
  tenantId: string | null;
  tenantNombre: string;
  turns: TurnoConversacion[];
  actualizadaEn: string;
}

/** Cuántas conversaciones se listan. Es un TOPE, no un total: `contar
 *  ConversacionesActivas` da el de verdad y la pantalla dice "20 de N". */
export const TOPE_CONVERSACIONES = 20;

/**
 * CORRECCIÓN (2-ago-2026, tras verla mal renderizada): `wa_conversacion.
 * estado` SÍ trae el historial de mensajes — `{ turns: ConvTurn[] }`, la
 * misma forma que `conv.ts` (`loadConversation`/`saveConversation`) lee y
 * escribe, acotada a `MAX_TURNS` recientes. El comentario anterior de esta
 * función decía que Likida "no guarda el texto de la conversación" — estaba
 * mal: sí lo guarda, solo que en una ventana rodante, no para siempre.
 */
export async function getConversacionesActivas(): Promise<ConversacionActiva[]> {
  const admin = supabaseAdmin();
  const { data, error } = await acotada(admin
    .from('wa_conversacion')
    .select('telefono, tenant_id, estado, updated_at, tenant:tenant_id(nombre)')
    .order('updated_at', { ascending: false })
    .limit(TOPE_CONVERSACIONES), 'getConversacionesActivas');
  if (error) throw new Error(`getConversacionesActivas: ${error.message}`);
  return (data ?? []).map(mapFilaConversacion);
}

/** La misma fila cruda de `wa_conversacion` (+ join a `tenant`) a
 *  `ConversacionActiva`, compartida por `getConversacionesActivas`,
 *  `buscarConversaciones` y `getConversacion` — antes duplicada en la
 *  primera y a punto de triplicarse con ADM-1. */
function mapFilaConversacion(c: Record<string, unknown>): ConversacionActiva {
  const estado = (c.estado as { turns?: TurnoConversacion[] }) ?? {};
  return {
    telefono: c.telefono as string,
    tenantId: (c.tenant_id as string | null) ?? null,
    tenantNombre: ((c.tenant as { nombre?: string } | null)?.nombre) ?? '—',
    turns: Array.isArray(estado.turns) ? estado.turns : [],
    actualizadaEn: c.updated_at as string,
  };
}

/** Filas por página de `buscarConversaciones` — mismo criterio que
 *  `paginar-registro.ts` del dashboard (25 se lee sin scroll infinito). */
export const CONVERSACIONES_POR_PAGINA = 25;

export interface PaginaConversaciones {
  filas: ConversacionActiva[];
  pagina: number;
  paginas: number;
  /** Cuántas conversaciones pasan el filtro actual — `count exact`, nunca
   *  `filas.length`. */
  total: number;
}

/**
 * ADM-1: `getConversacionesActivas` es un TOPE de 20 sin filtro — con
 * cientos de choferes activos las 20 filas rotan en minutos y no hay forma
 * de abrir la conversación de un teléfono concreto sin ir a la base. Esta
 * función SÍ filtra (`?q=` por teléfono, `?tenant=`) y SÍ pagina con
 * `count exact` real, nunca `filas.length` como total.
 *
 * `q` se normaliza a solo dígitos ANTES de armar el `ilike` — el mismo
 * criterio que `bitacora.ts` (sanear antes de que `%`/`_` entren como
 * comodines de LIKE) y el mismo que espera un teléfono mexicano en
 * `wa_conversacion.telefono` (dígitos, sin `+`/espacios).
 */
export async function buscarConversaciones(params: {
  q?: string;
  tenantId?: string | null;
  pagina?: number;
}): Promise<PaginaConversaciones> {
  const porPagina = CONVERSACIONES_POR_PAGINA;
  const paginaPedida = Math.trunc(params.pagina ?? 1);
  const pagina = Number.isFinite(paginaPedida) && paginaPedida >= 1 ? paginaPedida : 1;
  const q = (params.q ?? '').replace(/[^\d]/g, '').slice(0, 20);

  let consulta = supabaseAdmin()
    .from('wa_conversacion')
    .select('telefono, tenant_id, estado, updated_at, tenant:tenant_id(nombre)', { count: 'exact' })
    .order('updated_at', { ascending: false })
    .order('telefono'); // desempata `updated_at` repetido entre páginas
  if (q) consulta = consulta.ilike('telefono', `%${q}%`);
  if (params.tenantId) consulta = consulta.eq('tenant_id', params.tenantId);

  const desde = (pagina - 1) * porPagina;
  const { data, error, count } = await acotada(
    consulta.range(desde, desde + porPagina - 1), 'buscarConversaciones',
  );
  if (error) throw new Error(`buscarConversaciones: ${error.message}`);
  const total = count ?? 0;
  const paginas = Math.max(1, Math.ceil(total / porPagina));
  return {
    filas: ((data ?? []) as Array<Record<string, unknown>>).map(mapFilaConversacion),
    pagina: Math.min(pagina, paginas),
    paginas,
    total,
  };
}

/**
 * Una sola conversación por (tenant, teléfono) — la llave real de
 * `wa_conversacion` (ver el comentario de `ConversacionActiva.tenantId`).
 * `null` = no existe esa conversación (no un error: el link vino de un id
 * viejo o manipulado, y la página de detalle lo trata como 404, no como
 * "la base falló").
 */
export async function getConversacion(tenantId: string, telefono: string): Promise<ConversacionActiva | null> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('wa_conversacion')
    .select('telefono, tenant_id, estado, updated_at, tenant:tenant_id(nombre)')
    .eq('tenant_id', tenantId)
    .eq('telefono', telefono)
    .maybeSingle(), 'getConversacion');
  if (error) throw new Error(`getConversacion: ${error.message}`);
  if (!data) return null;
  return mapFilaConversacion(data as Record<string, unknown>);
}

/**
 * Cuántas conversaciones hay DE VERDAD (`count exact, head`: cero filas de
 * vuelta) — FE-9.
 *
 * `getConversacionesActivas` devuelve 20 y ese 20 se pintaba como KPI
 * ("Conversaciones activas: 20"), como alerta de la campana ("20
 * conversación(es) con actividad reciente") y como el total de la sección.
 * Con 21 conversaciones vivas los tres decían 20; con 4,000, también. Es un
 * tope disfrazado de medición.
 *
 * `null` = no se pudo contar. Nunca 0: un cero aquí se leería como "el bot no
 * está hablando con nadie", que es la pregunta que esta pantalla contesta.
 */
export async function contarConversacionesActivas(): Promise<number | null> {
  const { count, error } = await acotada(supabaseAdmin()
    .from('wa_conversacion')
    .select('telefono', { count: 'exact', head: true }), 'contarConversacionesActivas');
  if (error) {
    logger.warn('contarConversacionesActivas', { err: error.message });
    return null;
  }
  return count ?? null;
}

export interface MiembroEquipo {
  id: string;
  email: string;
  nombre: string | null;
  rol: string;
  tenantId: string | null;
  tenantNombre: string | null;
  operadorId: string | null;
}

/**
 * Roster real de `app_user` para la página Equipo/RBAC — mismo patrón de
 * error que el resto del archivo (falla por valor, se revisa `.error` a
 * mano). `tenant_id` es nullable (superadmin no pertenece a ninguna flota,
 * 0001_init.sql:21), así que el join a `tenant` viene NULL en esas filas —
 * no un error, un superadmin de verdad no tiene flota.
 */
export async function getEquipo(): Promise<MiembroEquipo[]> {
  const admin = supabaseAdmin();
  // Paginado como el resto del archivo. El orden es `rol, id` y no solo `rol`:
  // el rol se repite muchísimo, y paginar por un campo con empates puede
  // repetir o saltarse filas entre páginas. `id` desempata.
  const data = await traerTodo<Record<string, unknown>>(
    (d, h) => acotada(admin
      .from('app_user')
      .select('id, tenant_id, rol, nombre, email, operador_id, tenant:tenant_id(nombre)', conteo(d))
      .order('rol', { ascending: true }).order('id').range(d, h), 'getEquipo'),
    'getEquipo',
  );
  return data.map((u) => ({
    id: u.id as string,
    email: u.email as string,
    nombre: (u.nombre as string | null) ?? null,
    rol: u.rol as string,
    tenantId: (u.tenant_id as string | null) ?? null,
    tenantNombre: ((u.tenant as { nombre?: string } | null)?.nombre) ?? null,
    operadorId: (u.operador_id as string | null) ?? null,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTEOS DE PLATAFORMA — los números chicos del Inicio de /admin que no
// salen de `llm_costo`: cuánta gente y cuánto papel hay en TODA la base.
// ═══════════════════════════════════════════════════════════════════════════

export interface ConteosPlataforma {
  /** Filas de `operador` — choferes dados de alta, de todas las flotas. */
  operadores: number;
  /** Filas de `liquidacion` — liquidaciones generadas por el motor, histórico. */
  liquidaciones: number;
  /** Filas de `wa_conversacion` — una por teléfono con conversación viva
   *  (ventana rodante de turnos, ver `getConversacionesActivas`). */
  conversacionesWa: number;
  /** Filas de `app_user` — cuentas que pueden entrar a algún panel. */
  usuarios: number;
  /** El mismo total, desglosado por rol (dominio de `app_user.rol`:
   *  superadmin, flota_admin, contador, operador, encargado). Orden
   *  alfabético por rol — el orden estable de la consulta, no uno inventado. */
  usuariosPorRol: Array<{ rol: string; n: number }>;
}

/**
 * `head: true` + `count: 'exact'`: PostgREST cuenta en la base y no manda NI
 * UNA fila — el conteo de una tabla que va a crecer (operador, liquidacion)
 * no puede pagarse arrastrando las filas como hace `traerTodo`.
 *
 * Y se exige que `count` venga como número: un `head` sin conteo devolvería
 * `data: null, count: null` sin error, y leerle `?? 0` pintaría un cero que
 * nadie midió — NULL no es 0, es "no se pudo contar".
 */
async function contarFilas(tabla: 'operador' | 'liquidacion' | 'wa_conversacion'): Promise<number> {
  const { count, error } = await acotada(supabaseAdmin()
    .from(tabla)
    .select('id', { count: 'exact', head: true }), `getConteosPlataforma/${tabla}`);
  if (error) throw new Error(`getConteosPlataforma/${tabla}: ${error.message}`);
  if (typeof count !== 'number') {
    throw new Error(`getConteosPlataforma/${tabla}: PostgREST no devolvió el conteo — no se afirma un 0 que nadie midió.`);
  }
  return count;
}

export async function getConteosPlataforma(): Promise<ConteosPlataforma> {
  const admin = supabaseAdmin();
  const [operadores, liquidaciones, conversacionesWa, usuariosData] = await Promise.all([
    contarFilas('operador'),
    contarFilas('liquidacion'),
    contarFilas('wa_conversacion'),
    // `app_user` sí se trae (solo la columna `rol`) porque además del total se
    // quiere el desglose por rol, y son pocas filas — el día que deje de
    // serlo, esto se vuelve un `group by` en SQL como la 0062. `rol` empata
    // muchísimo, así que `id` desempata la paginación (mismo porqué que
    // `getEquipo`).
    traerTodo<{ rol: string }>(
      (d, h) => acotada(
        admin.from('app_user').select('rol', conteo(d)).order('rol', { ascending: true }).order('id').range(d, h),
        'getConteosPlataforma/app_user',
      ),
      'getConteosPlataforma/app_user',
    ),
  ]);
  const porRol = new Map<string, number>();
  for (const u of usuariosData) porRol.set(u.rol, (porRol.get(u.rol) ?? 0) + 1);
  return {
    operadores,
    liquidaciones,
    conversacionesWa,
    usuarios: usuariosData.length,
    usuariosPorRol: [...porRol].map(([rol, n]) => ({ rol, n })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LA BITÁCORA DE CORRIDAS, VISTA DESDE ARRIBA — `agente_corrida` (0102)
// cruzada por TODOS los tenants, para la sección de orquestación del Inicio.
// La lectura tenant-scoped de la misma tabla es `ultimasCorridas`
// (lib/likida/agentes/corridas.ts); esta vive aquí porque cruzar tenants es
// el permiso exclusivo de este archivo.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El dominio del CHECK `agente_corrida_agente_dominio` (0102, ampliado por la
 * 0105 con `ventas`), escrito una vez y atado por `satisfies` al tipo de
 * corridas.ts: si el CHECK crece, el tipo crece y esta lista se revisa a mano
 * — el CHECK vive en SQL y ningún tipo lo puede leer solo. Los agentes de
 * PLATAFORMA del sidebar de /admin (OCR, Cuadre, WhatsApp) NO están aquí a
 * propósito: corren por webhook dentro del pipeline y su rastro es
 * `llm_costo.fase`, no esta bitácora.
 */
export const AGENTES_BITACORA = [
  'liquidacion', 'facturas', 'cobranza', 'conductores', 'peajes', 'proveedores', 'ventas',
] as const satisfies readonly AgenteConCorridas[];

export interface CorridaCruzada {
  estado: EstadoCorrida;
  disparo: 'cron' | 'manual';
  inicio: string;
  fin: string | null;
  /** Ambos o ninguno — un numerador sin denominador no dice nada (0102). */
  tareasHechas: number | null;
  tareasTotal: number | null;
  /** De QUÉ flota fue la corrida — la fila es (corrida × flota), y una vista
   *  cross-tenant que no diga la flota mezclaría historias de clientes
   *  distintos como si fueran una. NULL desde la 0105: la corrida fue para
   *  LIKIDA misma (negocio, no flota — hoy solo el agente `ventas`). */
  tenantId: string | null;
  tenantNombre: string;
}

export interface CorridaReciente extends CorridaCruzada {
  agente: string;
}

export interface UltimaCorridaAgente {
  agente: AgenteConCorridas;
  /** `null` = la bitácora no tiene NI UNA corrida de este agente — que con
   *  la base en cero es lo esperado, y la UI lo dice en vez de esconderlo. */
  ultima: CorridaCruzada | null;
}

/** La forma cruda de PostgREST → `CorridaCruzada`, con el join de tenant
 *  aplanado. Compartido por las dos lecturas para que el "cuándo/tareas" no
 *  se mapee distinto en dos pantallas. */
function mapearCorrida(f: Record<string, unknown>): CorridaCruzada {
  const tenantId = (f.tenant_id as string | null) ?? null;
  return {
    estado: f.estado as EstadoCorrida,
    disparo: f.disparo as 'cron' | 'manual',
    inicio: f.inicio as string,
    fin: (f.fin as string | null) ?? null,
    tareasHechas: (f.tareas_hechas as number | null) ?? null,
    tareasTotal: (f.tareas_total as number | null) ?? null,
    tenantId,
    // Sin tenant NO es un hueco: la 0105 lo define como "corrió para Likida
    // misma". Un tenant que SÍ existe pero cuyo join no trajo nombre se
    // pinta '—' — visible, no inventado.
    tenantNombre: tenantId === null
      ? 'Likida (negocio)'
      : ((f.tenant as { nombre?: string } | null)?.nombre) ?? '—',
  };
}

const COLUMNAS_CORRIDA = 'agente, estado, disparo, inicio, fin, tareas_hechas, tareas_total, tenant_id, tenant:tenant_id(nombre)';

/**
 * Las últimas N corridas de CUALQUIER agente en CUALQUIER flota — el feed de
 * "qué acaban de hacer los agentes" del Inicio. LANZA ante error de lectura:
 * un feed vacío sobre una base caída afirmaría "nadie ha corrido", que es
 * exactamente lo que esta bitácora existe para desmentir (misma regla que
 * `ultimasCorridas`).
 */
export async function getCorridasRecientes(limite = 8): Promise<CorridaReciente[]> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('agente_corrida')
    .select(COLUMNAS_CORRIDA)
    .order('inicio', { ascending: false })
    .limit(limite), 'getCorridasRecientes');
  if (error) throw new Error(`getCorridasRecientes: ${error.message}`);
  return (data ?? []).map((f) => {
    const r = f as Record<string, unknown>;
    return { agente: String(r.agente), ...mapearCorrida(r) };
  });
}

/**
 * La ÚLTIMA corrida de cada agente del dominio — el estado de la sección de
 * orquestación. Seis consultas `limit 1` en paralelo y no una sola con
 * dedupe en JS a propósito: deduplicar sobre "las últimas N" mentiría con un
 * agente que no corre desde hace semanas ("sin corridas" cuando SÍ tiene,
 * solo que fuera de la ventana), y traer la tabla entera para seis filas es
 * el patrón que la 0062 vino a matar.
 */
export async function getUltimaCorridaPorAgente(): Promise<UltimaCorridaAgente[]> {
  const admin = supabaseAdmin();
  return Promise.all(AGENTES_BITACORA.map(async (agente) => {
    const { data, error } = await acotada(admin
      .from('agente_corrida')
      .select(COLUMNAS_CORRIDA)
      .eq('agente', agente)
      .order('inicio', { ascending: false })
      .limit(1), `getUltimaCorridaPorAgente/${agente}`);
    if (error) throw new Error(`getUltimaCorridaPorAgente/${agente}: ${error.message}`);
    const fila = (data ?? [])[0] as Record<string, unknown> | undefined;
    return { agente, ultima: fila ? mapearCorrida(fila) : null };
  }));
}

/**
 * Las corridas en `fallo` — la vista para la bandeja de escalaciones: cada
 * una es un agente que NO terminó su trabajo y nadie más se va a enterar si
 * esta lectura no lo dice. Mismo mapeo y mismas columnas que
 * `getCorridasRecientes` (una corrida no puede contarse distinto en dos
 * pantallas); solo cambia el filtro. LANZA ante error de lectura — "0
 * fallos" sobre una base caída afirmaría que todo corrió bien.
 */
export const TOPE_CORRIDAS_FALLIDAS = 20;

/**
 * Cuántas corridas en `fallo` hay DE VERDAD (`count exact, head`) — FE-9.
 *
 * `getCorridasFallidas(20)` devuelve 20 y ese 20 se pintaba como el conteo
 * de la campana y de la bandeja de escalaciones: con 500 agentes caídos
 * seguía diciendo 20, que es la cifra que decide si alguien va a mirar.
 *
 * `null` = no se pudo contar. Nunca 0: un cero afirmaría que todo corrió bien.
 */
export async function contarCorridasFallidas(): Promise<number | null> {
  const { count, error } = await acotada(supabaseAdmin()
    .from('agente_corrida')
    .select('id', { count: 'exact', head: true })
    .eq('estado', 'fallo'), 'contarCorridasFallidas');
  if (error) {
    logger.warn('contarCorridasFallidas', { err: error.message });
    return null;
  }
  return count ?? null;
}

export async function getCorridasFallidas(limite = TOPE_CORRIDAS_FALLIDAS): Promise<CorridaReciente[]> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('agente_corrida')
    .select(COLUMNAS_CORRIDA)
    .eq('estado', 'fallo')
    .order('inicio', { ascending: false })
    .limit(limite), 'getCorridasFallidas');
  if (error) throw new Error(`getCorridasFallidas: ${error.message}`);
  return (data ?? []).map((f) => {
    const r = f as Record<string, unknown>;
    return { agente: String(r.agente), ...mapearCorrida(r) };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// LIQUIDACIONES EN `revisar`, CRUZADAS — la versión cross-tenant de lo que
// `getKpis` (analytics.ts) cuenta por-tenant con `estatus === 'revisar'`.
// ═══════════════════════════════════════════════════════════════════════════

export interface LiquidacionEnRevision {
  id: string;
  creadaEn: string;
  /** Folio del viaje (join a `viaje.folio`) — NULL para viajes despachados
   *  por WhatsApp, que nacen sin folio (0092). */
  folio: string | null;
  tenantId: string;
  tenantNombre: string;
}

/** Las N más recientes que trae la bandeja. Con un cliente de 50k viajes/mes
 *  la cola humana puede tener miles; la bandeja pinta las últimas y el
 *  TOTAL lo da `contarLiquidacionesEnRevisar` (count head, sin filas). */
export const LIMITE_LIQUIDACIONES_REVISAR = 200;

const COLUMNAS_LIQ_REVISAR = 'id, created_at, tenant_id, tenant:tenant_id(nombre), viaje:viaje_id(folio)';

/**
 * Las liquidaciones que AHORA están en `revisar`, de todas las flotas — las
 * `limite` MÁS RECIENTES (`created_at desc`, `id desc` desempata).
 *
 * ACOTADA DESDE EL 22-AGO-2026 (escala 50k): antes era `traerTodo` cross-tenant
 * sin fecha ni tope —toda la cola humana a JS en cada carga de /admin y de la
 * bandeja—, con la misma fecha de caducidad que `getResumenNegocio`. Ahora son
 * `limite` filas por el índice parcial de la 0153 (`where estatus =
 * 'revisar'`), y el conteo real sale aparte, por `head`. La firma se conserva
 * (el array); quien necesite el total, que lo CUENTE — `items.length` ya no
 * lo es.
 *
 * HONESTIDAD DEL DATO: `liquidacion.estatus` (dominio de la 0025: cuadrada |
 * con_diferencias | revisar) es el estado ACTUAL, no una historia.
 * `guardar_liquidacion_tx` hace UPSERT: un re-cuadre REESCRIBE el estatus sin
 * dejar rastro de que la liquidación pasó por la bandeja. Por eso ninguna
 * pantalla puede afirmar "cerrada sin haber pasado nunca por un humano" —
 * solo "hoy no está en la bandeja". El rótulo de la consola lo dice así.
 */
export async function getLiquidacionesEnRevisar(
  limite: number = LIMITE_LIQUIDACIONES_REVISAR,
): Promise<LiquidacionEnRevision[]> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('liquidacion')
    .select(COLUMNAS_LIQ_REVISAR)
    .eq('estatus', 'revisar')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limite), 'getLiquidacionesEnRevisar');
  if (error) throw new Error(`getLiquidacionesEnRevisar: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((f) => ({
    id: f.id as string,
    creadaEn: f.created_at as string,
    folio: ((f.viaje as { folio?: string | null } | null)?.folio) ?? null,
    tenantId: f.tenant_id as string,
    // Join sin nombre → '—', visible, no inventado (mismo criterio que
    // `mapearCorrida`).
    tenantNombre: ((f.tenant as { nombre?: string } | null)?.nombre) ?? '—',
  }));
}

/**
 * CUÁNTAS están en `revisar` ahora, todas las flotas — `head: true` +
 * `count: 'exact'`: la base cuenta y no manda NI UNA fila (mismo patrón y
 * misma exigencia que `contarFilas`: un `count` que no llega como número no
 * es 0, es "no se pudo contar", y se lanza).
 */
export async function contarLiquidacionesEnRevisar(): Promise<number> {
  const { count, error } = await acotada(supabaseAdmin()
    .from('liquidacion')
    .select('id', { count: 'exact', head: true })
    .eq('estatus', 'revisar'), 'contarLiquidacionesEnRevisar');
  if (error) throw new Error(`contarLiquidacionesEnRevisar: ${error.message}`);
  if (typeof count !== 'number') {
    throw new Error('contarLiquidacionesEnRevisar: PostgREST no devolvió el conteo — no se afirma un 0 que nadie midió.');
  }
  return count;
}

// ═══════════════════════════════════════════════════════════════════════════
// EL MRR (ADM-5, auditoría 24) — antes una constante `0` en `consola.tsx` y
// `ejecutivo/page.tsx`, aunque `saas/suscripcion.ts` (0052) ya trae
// `suscripcion.estado` y `plan.precio_mensual` reales. El día 1 del piloto
// (Innovativos con una suscripción activa) la consola habría seguido
// diciendo "$0 MRR" — una cifra que el código nunca calculó, justo lo que la
// regla #1 del producto prohíbe.
// ═══════════════════════════════════════════════════════════════════════════

export interface ResumenMrr {
  /**
   * Suma de `plan.precio_mensual` de las suscripciones en estado 'activa'.
   * `null` = NO SE PUDO MEDIR — o falló la lectura, o alguna suscripción
   * activa cuelga de un plan sin precio configurado (`precio_mensual` NULL,
   * ver `plan.ts` — "un precio de ejemplo termina en una propuesta
   * comercial"). Nunca se resta esa suscripción en silencio: un MRR
   * incompleto sin decirlo es peor que decir "sin medir".
   */
  totalMxn: number | null;
  /** Cuántas suscripciones activas hay — se pinta aunque `totalMxn` sea
   *  `null`, para distinguir "cero clientes" de "clientes sin precio". */
  suscripcionesActivas: number;
}

/** El MRR de TODA la plataforma, cruzando tenants (mismo permiso que el resto
 *  de este archivo). `traerTodo` + `count` real: mismo contrato que `tenant`
 *  arriba, para que 800 flotas no se recorten en silencio. */
export async function getMrr(): Promise<ResumenMrr> {
  const admin = supabaseAdmin();
  const filas = await traerTodo<{ id: string; plan: { precio_mensual: number | null } | Array<{ precio_mensual: number | null }> | null }>(
    (d, h) => acotada(
      admin.from('suscripcion').select('id, plan:plan_clave(precio_mensual)', conteo(d))
        .eq('estado', 'activa').order('id').range(d, h),
      'getMrr',
    ),
    'getMrr',
  );
  let total = 0;
  let medible = true;
  for (const f of filas) {
    const planRel = f.plan;
    const p = Array.isArray(planRel) ? planRel[0] : planRel;
    if (!p || p.precio_mensual === null) { medible = false; continue; }
    total += Number(p.precio_mensual);
  }
  return { totalMxn: medible ? round2(total) : null, suscripcionesActivas: filas.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// INTERRUPTORES DEL PIPELINE DEL CHOFER, POR FLOTA (ADM-6, auditoría 24;
// tabla `interruptor_tenant`, mig. 0297).
//
// `lib/likida/interruptores.ts` (0110) es GLOBAL por agente — las 58
// palancas + `global` son de agentes de back office, y apagar 'global'
// apagaría TODAS las flotas de golpe. El pipeline que un chofer ejercita por
// WhatsApp (recepción, OCR, cuadre) corre por WEBHOOK, una flota a la vez, y
// hasta esta migración no tenía NINGUNA palanca propia.
//
// MISMO CONTRATO que el interruptor global: SIN FILA = ENCENDIDO, apagar
// exige motivo, LANZA si la escritura falla ("apagué" que no apagó es el
// peor resultado posible). Vive aquí (lib/admin) y no en lib/likida porque
// hoy solo lo toca /admin/flotas/[id] — si algún día el webhook necesita
// LEERLO (ver la nota de la migración: falta que `processor.ts` lo
// consulte), esa lectura puede mudarse a lib/likida sin tocar la tabla.
// ═══════════════════════════════════════════════════════════════════════════

export type PipelineChofer = 'whatsapp' | 'ocr' | 'cuadre';
export const PIPELINES_CHOFER: readonly PipelineChofer[] = ['whatsapp', 'ocr', 'cuadre'];

export interface InterruptorPipelineTenant {
  pipeline: PipelineChofer;
  apagado: boolean;
  motivo: string | null;
  cambiadoPorNombre: string | null;
  cambiadoEn: string | null;
}

function esPipelineValido(p: string): p is PipelineChofer {
  return (PIPELINES_CHOFER as readonly string[]).includes(p);
}

/** Los tres pipelines de UNA flota, con los que no tienen fila en su estado
 *  default (encendidos) — mismo patrón que `listarInterruptores` (0110).
 *  LANZA ante un error de lectura: es de panel, y "todo encendido" sobre
 *  una base caída afirmaría que nada está apagado sin haber podido mirar. */
export async function getInterruptoresPipelineDeTenant(tenantId: string): Promise<InterruptorPipelineTenant[]> {
  const admin = supabaseAdmin();
  const { data, error } = await acotada(admin
    .from('interruptor_tenant')
    .select('pipeline, apagado, motivo, cambiado_por, cambiado_en')
    .eq('tenant_id', tenantId), 'getInterruptoresPipelineDeTenant');
  if (error) throw new Error(`getInterruptoresPipelineDeTenant: ${error.message}`);

  const filas = new Map<string, Record<string, unknown>>();
  for (const f of (data ?? []) as Array<Record<string, unknown>>) filas.set(String(f.pipeline), f);

  const actorIds = [...new Set(
    [...filas.values()].map((f) => f.cambiado_por as string | null).filter((v): v is string => v !== null),
  )];
  const nombresPorId = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: actores } = await acotada(
      admin.from('app_user').select('id, nombre, email').in('id', actorIds),
      'getInterruptoresPipelineDeTenant/actores',
    );
    for (const a of (actores ?? []) as Array<{ id: string; nombre: string | null; email: string }>) {
      nombresPorId.set(a.id, a.nombre ?? a.email);
    }
  }

  return PIPELINES_CHOFER.map((pipeline) => {
    const f = filas.get(pipeline);
    if (!f) return { pipeline, apagado: false, motivo: null, cambiadoPorNombre: null, cambiadoEn: null };
    const cambiadoPor = f.cambiado_por as string | null;
    return {
      pipeline,
      apagado: Boolean(f.apagado),
      motivo: (f.motivo as string | null) ?? null,
      cambiadoPorNombre: cambiadoPor ? (nombresPorId.get(cambiadoPor) ?? 'cuenta borrada') : null,
      cambiadoEn: (f.cambiado_en as string | null) ?? null,
    };
  });
}

/** Apaga UN pipeline de UNA flota. Motivo obligatorio (mismo CHECK que la
 *  0297 en base). LANZA si la escritura falla. */
export async function apagarPipelineDeTenant(tenantId: string, pipeline: string, motivo: string, userId: string): Promise<void> {
  if (!esPipelineValido(pipeline)) {
    throw new DatoInvalido(`"${pipeline}" no es un pipeline del catálogo (whatsapp/ocr/cuadre).`);
  }
  const m = motivo.trim();
  if (!m) {
    throw new DatoInvalido('Apagar exige un motivo: sin nota, en tres semanas nadie sabe si ya se puede encender.');
  }
  const { error } = await acotada(supabaseAdmin()
    .from('interruptor_tenant')
    .upsert(
      { tenant_id: tenantId, pipeline, apagado: true, motivo: m, cambiado_por: userId, cambiado_en: new Date().toISOString() },
      { onConflict: 'tenant_id,pipeline' },
    ), 'apagarPipelineDeTenant');
  if (error) throw new Error(`apagarPipelineDeTenant(${tenantId}, ${pipeline}): ${error.message}`);
  await anotarBitacora(
    { tenantId, actor: { id: userId }, accion: 'interruptor.pipeline_apagado', entidad: 'interruptor', entidadId: `${tenantId}:${pipeline}`, detalle: { pipeline, motivo: m } },
    { evento: 'admin.interruptor_pipeline_no_bitacorado', contexto: { tenantId, pipeline } },
  );
}

/** Enciende UN pipeline de UNA flota (vuelve al default). LANZA si la
 *  escritura falla. */
export async function encenderPipelineDeTenant(tenantId: string, pipeline: string, userId: string): Promise<void> {
  if (!esPipelineValido(pipeline)) {
    throw new DatoInvalido(`"${pipeline}" no es un pipeline del catálogo (whatsapp/ocr/cuadre).`);
  }
  const { error } = await acotada(supabaseAdmin()
    .from('interruptor_tenant')
    .upsert(
      { tenant_id: tenantId, pipeline, apagado: false, motivo: null, cambiado_por: userId, cambiado_en: new Date().toISOString() },
      { onConflict: 'tenant_id,pipeline' },
    ), 'encenderPipelineDeTenant');
  if (error) throw new Error(`encenderPipelineDeTenant(${tenantId}, ${pipeline}): ${error.message}`);
  await anotarBitacora(
    { tenantId, actor: { id: userId }, accion: 'interruptor.pipeline_encendido', entidad: 'interruptor', entidadId: `${tenantId}:${pipeline}`, detalle: { pipeline } },
    { evento: 'admin.interruptor_pipeline_no_bitacorado', contexto: { tenantId, pipeline } },
  );
}
