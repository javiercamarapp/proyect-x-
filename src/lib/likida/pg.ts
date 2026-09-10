// ═══════════════════════════════════════════════════════════════════════════
// LOS DOS BORDES DE POSTGREST — extraídos de analytics.ts para que el módulo
// de operación (operacion.ts) no los reimplemente.
//
// Reimplementarlos habría sido peor que moverlos: son exactamente los dos
// fallos que CLAUDE.md llama "la familia de bugs más repetida del repo", y una
// segunda copia es una segunda oportunidad de escribirla mal.
// ═══════════════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';

// ── Los fallos de Supabase llegan POR VALOR, no lanzando ────────────────────
// `shouldThrowOnError` es false por defecto en postgrest-js, así que un host
// inalcanzable, un 500, una llave rotada o un `grant` que le cierre la tabla al
// service-role devuelven `{ data: null, error }` y siguen. Desestructurar solo
// `data` convierte cualquiera de esos fallos en "no hay nada": el panel pintaba
// "Aún no hay liquidaciones" con la base caída y el contralor concluía que la
// flota nunca ha liquidado un viaje (auditoría 5, frontend, CRÍTICO).
//
// El panel ya sabe distinguir null de dato —`safe()` en dashboard/page.tsx
// atrapa excepciones—, así que lo único que faltaba era TRADUCIR el error por
// valor a una excepción. Se hace aquí, en el borde, y no en cada llamador.
export type RespuestaPg<T> = {
  data: T | null;
  error: { message: string } | null;
  /** Cuántas filas hay DE VERDAD del otro lado del filtro. PostgREST solo lo
   *  manda si la consulta lo pidió (`.select(cols, { count: 'exact' })`); si no,
   *  llega `null` o ni siquiera llega. Es lo único que permite comprobar que una
   *  lectura paginada quedó COMPLETA sin pagar un viaje de red extra. */
  count?: number | null;
};

export function exigir<T>(res: RespuestaPg<T>, consulta: string): T | null {
  if (res.error) throw new Error(`${consulta}: ${res.error.message}`);
  return res.data;
}

// AUDITORÍA 8, ALTO REINCIDENTE: PostgREST recorta en silencio a `max_rows`
// (1,000 por default) sin avisar — no lanza, no loguea, simplemente devuelve
// menos filas. Para un tenant que ya lleva un trimestre operando, eso apagaba
// `detectarAnomalias` (el detector de fraude entre viajes) justo cuando más
// datos hay que mirar, sin que el panel supiera que la lectura estaba
// incompleta. `getAcumuladoCombustible` (repo.ts) ya paginaba así desde la
// ronda 6; aquí no se había movido.
export const PAGINA = 1_000;
/** 100 páginas son 100,000 filas. Un tenant que las pase necesita un `sum()`
 *  en SQL, no más vueltas: se corta — pero se LANZA, no se devuelve el recorte. */
export const MAX_PAGINAS = 100;

/** Segundo argumento de `.select()` cuando lo que se quiere es el total. */
export type ConteoPagina = { count?: 'exact' };

/**
 * `.select(COLUMNAS, conteo(desde))` dentro de un `traerTodo`: pide el total
 * SOLO en la primera página.
 *
 * Por qué el llamador y no `traerTodo`: la opción va dentro de `.select()`, que
 * solo el llamador construye. Se intentó pasarla como tercer argumento del
 * callback y TypeScript deja de aceptar los llamadores de dos parámetros
 * (`fiscal.ts:701` con sus columnas concatenadas en runtime) — un cambio de
 * firma que rompe compilación a cambio de nada, porque `desde === 0` ya
 * identifica la primera página sin argumento nuevo.
 *
 * En las páginas siguientes va vacío: el total viene en la primera respuesta y
 * pedirlo en cada vuelta haría contar de más. Mismo patrón que
 * `getAcumuladoCombustible` (repo.ts).
 */
export const conteo = (desde: number): ConteoPagina => (desde === 0 ? { count: 'exact' } : {});

/**
 * La lectura paginada no pudo demostrar que trajo TODO.
 *
 * Tipo propio para que un llamador que de verdad quiera una cifra parcial pueda
 * distinguirla de un fallo de red — pero el default es que nadie la atrape y el
 * panel enseñe su estado de error, que es lo honesto: media tabla sumada se ve
 * exactamente igual que la tabla entera, solo que más barata.
 */
export class LecturaIncompleta extends Error {
  constructor(
    readonly consulta: string,
    readonly leidas: number,
    readonly esperadas: number | null,
  ) {
    super(
      esperadas === null
        ? `${consulta}: lectura incompleta — se agotaron las ${MAX_PAGINAS} páginas con ${leidas} filas y la base seguía devolviendo más. No se devuelve una cifra parcial: hace falta agregar en SQL.`
        : `${consulta}: lectura incompleta — solo se leyeron ${leidas} de ${esperadas} filas. No se devuelve una cifra parcial.`,
    );
    this.name = 'LecturaIncompleta';
  }
}

/**
 * Trae TODAS las filas de una consulta, o lanza. No hay tercera salida.
 *
 * LA VERSIÓN ANTERIOR TENÍA EL MISMO BUG QUE VINO A CURAR, con el techo más
 * alto: al agotar las 100 páginas hacía `return filas` normal —100,000 filas,
 * sin lanzar, sin loguear, sin marcar la lectura como incompleta—. Con 240,000
 * gastos al año, la pantalla de valor-ahorro reportaba 100,000 y el detector de
 * anomalías decía "0 anomalías" sobre el 41% de los datos. Un recorte silencioso
 * a 100,000 es el mismo error que uno a 1,000; solo tarda más en aparecer.
 *
 * Y había un segundo modo del mismo fallo: cortaba con `pag.length < PAGINA`,
 * que da por hecho que el servidor entrega todo lo que se le pide. No lo hace:
 * `max_rows` es un ajuste de proyecto en el panel de Supabase, y bajarlo a 500
 * hacía que TODA lectura paginada del repo se detuviera en la primera página y
 * devolviera 500 filas como si fueran todas. Por eso el cursor ya no avanza por
 * número de página (`pagina * PAGINA`) sino por filas REALMENTE leídas: una
 * página corta ahora significa "pide la siguiente desde donde te quedaste", no
 * "ya terminamos".
 *
 * ══ EL CONTRATO ══
 * Devuelve las filas SOLO si pudo demostrar que están todas. La prueba es una
 * de dos:
 *   1. el `count` de PostgREST (leídas ≥ esperadas) — exacto y GRATIS: viene en
 *      la misma respuesta de la primera página. Es el modelo de
 *      `getAcumuladoCombustible` (repo.ts), que ya lo hacía bien.
 *   2. una página vacía — demuestra que no hay nada después del cursor.
 * Si no logra ninguna de las dos, LANZA `LecturaIncompleta`.
 *
 * El `count` solo llega si el llamador lo pide en su propio `.select()`, para lo
 * que existe el helper `conteo()`:
 *
 *     traerTodo((d, h) => admin.from('gasto').select('monto', conteo(d))
 *       .eq('tenant_id', t).order('id').range(d, h), 'loQueSea')
 *
 * Un llamador que no lo pida sigue siendo CORRECTO —cae a la prueba 2—, pero
 * paga un viaje de red extra: la página vacía que demuestra el final. Ese es el
 * precio de no poder distinguir "vinieron 5 filas porque hay 5" de "vinieron 5
 * porque el servidor no da más".
 *
 * LA CONSULTA TIENE QUE VENIR ORDENADA POR ALGO ÚNICO. El cursor es un `range`
 * por posición: con un `order` que empate (una fecha, un rol), dos páginas
 * pueden repetir una fila y saltarse otra. Todos los llamadores desempatan con
 * `id`.
 */
/** Cuántos ids viajan por tanda en `traerPorIds`. 200 UUIDs son ~7.5 KB de
 *  URL — debajo del techo típico de un proxy (8 KB) — y devuelven a lo más
 *  200 filas en un lookup por PK: nunca tocan el recorte de 1,000. */
export const IDS_POR_TANDA = 200;
/** Tandas en vuelo a la vez. El mismo criterio que el pool del webhook
 *  (route.ts:40): acotado para no abrir cientos de conexiones, >1 para que
 *  un periodo grande no pague las tandas en serie. */
const TANDAS_EN_PARALELO = 5;

/**
 * Trae las filas de un `.in('id', ids)` SIN el techo silencioso.
 *
 * Un `.in()` con miles de ids tiene DOS modos de falla, y los dos son mudos:
 * PostgREST recorta el resultado a `max_rows` (1,000) igual que en cualquier
 * select — con 15,000 viajes/mes, el contexto de folio/operador de
 * `getGastosFiscales` (fiscal.ts) dejaba sin folio a todo lo que pasara de
 * mil — y la lista entera viaja EN LA URL, así que además puede rebotar en el
 * proxy antes de llegar. Se parte en tandas de `IDS_POR_TANDA`: cada tanda es
 * un lookup por PK que devuelve a lo más su propio tamaño, y ninguna puede
 * tocar ninguno de los dos techos.
 *
 * El resultado conserva el orden de las tandas (no el de llegada de la red):
 * los llamadores construyen Maps y no les importa, pero un orden que cambia
 * entre corridas es la clase de sorpresa que este archivo existe para no dar.
 */
export async function traerPorIds<T>(
  ids: string[],
  construir: (tanda: string[]) => PromiseLike<RespuestaPg<T[]>>,
  consulta: string,
): Promise<T[]> {
  const tandas: string[][] = [];
  for (let i = 0; i < ids.length; i += IDS_POR_TANDA) tandas.push(ids.slice(i, i + IDS_POR_TANDA));
  const porTanda: T[][] = new Array(tandas.length);

  let siguiente = 0;
  const obrero = async () => {
    for (;;) {
      const i = siguiente++;
      if (i >= tandas.length) return;
      porTanda[i] = exigir(await construir(tandas[i]), consulta) ?? [];
    }
  };
  await Promise.all(Array.from({ length: Math.min(TANDAS_EN_PARALELO, tandas.length) }, obrero));
  return porTanda.flat();
}

export async function traerTodo<T>(
  construir: (desde: number, hasta: number) => PromiseLike<RespuestaPg<T[]>>,
  consulta: string,
): Promise<T[]> {
  const filas: T[] = [];
  let esperadas: number | null = null;

  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    // Por filas leídas, NO por número de página: con `max_rows` bajo las páginas
    // vienen cortas y saltar de mil en mil se brincaría las filas de en medio.
    const desde = filas.length;
    const res = await construir(desde, desde + PAGINA - 1);
    const pag = exigir(res, consulta) ?? [];
    // Solo en la primera vuelta: el total viene en la misma respuesta, así que
    // saber cuántas filas hay de verdad no cuesta un viaje de red extra, pero
    // pedirlo en cada página sí haría contar de más.
    if (pagina === 0 && typeof res.count === 'number') esperadas = res.count;
    filas.push(...pag);

    // Completa Y DEMOSTRADA. (`>=`, no `===`: entre la primera página y la
    // última pudo entrar una fila nueva; sobrar no es el fallo que se persigue.)
    if (esperadas !== null && filas.length >= esperadas) return filas;

    if (pag.length === 0) {
      // Una página vacía prueba que no hay nada después del cursor. Es la única
      // prueba disponible cuando el llamador no pidió `count`.
      if (esperadas === null) return filas;
      // Con `count` conocido y filas faltantes no es el final: o el servidor
      // dejó de entregar, o alguien borró debajo. En los dos casos la cifra
      // saldría corta, y a la baja es la dirección que nadie revisa.
      break;
    }
  }

  // Fail-closed, igual que `getAcumuladoCombustible`: el log es lo que permite
  // saber a la mañana siguiente CUÁL pantalla estaba midiendo de menos.
  logger.error('pg.lectura_incompleta', { consulta, leidas: filas.length, esperadas });
  throw new LecturaIncompleta(consulta, filas.length, esperadas);
}

/**
 * Trae TODAS las filas de una consulta ordenada por `id` ASCENDENTE, con
 * cursor por FILA (`id > última leída`), no por posición.
 *
 * AUDITORÍA 24, MEDIO REINCIDENTE: `traerTodo` pagina con `range(desde,
 * hasta)` — una POSICIÓN sobre una tabla VIVA. Con `.order('id')` ascendente
 * sobre un id no correlacionado con el tiempo (UUID v4), un INSERT o DELETE
 * en cualquier parte de la tabla mientras se pagina desplaza qué fila cae en
 * cada posición: la página siguiente puede repetir una fila ya leída (si algo
 * se insertó antes del cursor) o saltarse una sin leer (si algo se borró
 * antes del cursor) — en los dos casos con `leidas` terminando igual a
 * `esperadas`, así que `LecturaIncompleta` no lo nota. Para una suma fiscal,
 * una fila duplicada infla la cifra sin que nada avise.
 *
 * El cursor por `id` no tiene ese problema PORQUE no depende de la posición:
 * "tráeme lo que tenga `id` mayor al último que vi" sigue siendo verdad sin
 * importar qué se insertó o borró en cualquier otra parte de la tabla. Mismo
 * principio que el keyset `(created_at, id)` de `export/liquidaciones/route.ts`
 * (auditoría 21) — aquí en su forma más simple, un solo cursor, para cuando
 * `id` YA es el único orden que importa (el caso de `candidatosDb` en
 * `intake/consolidado.ts`, REN-C1 auditoría 29).
 *
 * Mismo contrato de `traerTodo`: se demuestra con el `count` EXACTO de la
 * primera página, o se LANZA `LecturaIncompleta` — nunca una cifra parcial.
 * `construir` recibe el cursor (`null` en la primera vuelta) y es quien pone
 * `.order('id')` + `.limit(PAGINA)` + `.gt('id', cursor)` si aplica: la forma
 * exacta de esas tres llamadas depende del resto de filtros de cada llamador.
 */
export async function traerTodoDesdeId<T extends { id: string }>(
  construir: (despuesDe: string | null) => PromiseLike<RespuestaPg<T[]>>,
  consulta: string,
): Promise<T[]> {
  const filas: T[] = [];
  let esperadas: number | null = null;
  let cursor: string | null = null;

  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const res = await construir(cursor);
    const pag = exigir(res, consulta) ?? [];
    // Solo en la primera vuelta, igual que `traerTodo`: el total viene gratis
    // en la misma respuesta y pedirlo de nuevo en cada página contaría de más.
    if (pagina === 0 && typeof res.count === 'number') esperadas = res.count;
    filas.push(...pag);

    if (esperadas !== null && filas.length >= esperadas) return filas;
    if (pag.length === 0) {
      // Página vacía: no hay nada después del cursor. Prueba válida con o sin
      // `count` — a diferencia de `range()`, aquí no hay ambigüedad de si el
      // servidor "dejó de entregar": con cursor por fila, vacío es vacío.
      return filas;
    }
    cursor = pag[pag.length - 1].id;
  }

  logger.error('pg.lectura_incompleta', { consulta, leidas: filas.length, esperadas });
  throw new LecturaIncompleta(consulta, filas.length, esperadas);
}
