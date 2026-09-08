// Registro y agregación del costo real de AI. Best-effort: registrar el costo
// NUNCA debe tumbar el flujo de la liquidación.
//
// ═══════════════════════════════════════════════════════════════════════════
// UN COSTO NO REGISTRADO TIENE QUE VERSE DISTINTO DE UN COSTO BAJO
// (auditoría 5, ALTO)
//
// Likida cobra POR LIQUIDACIÓN. El costo unitario no es una métrica de vanidad:
// es la cifra con la que se fija el precio del producto. Por eso el modo de
// fallo que importa aquí no es "se cayó", es "bajó sola y nadie lo notó".
//
// Este módulo tenía cuatro caminos hacia ese fallo, y los cuatro producían
// exactamente la misma salida que "salió barato":
//
//   1. Se asumió que `await` sobre el query builder de supabase-js LANZA. No lo
//      hace: resuelve con `{ data: null, error }`. Las 19 funciones de `repo.ts`
//      lo saben y desestructuran `{ error }`; `registrarCosto` era la única del
//      camino del dinero que no. Un fallo de RLS, una columna que no existe tras
//      una migración o un `check` violado pasaban sin excepción y sin log — el
//      `catch` solo cubría que reventara el `fetch`.
//   2. `LIKIDA_WHATSAPP_MSG_USD=` (puesta y vacía, que es lo que deja un copiado
//      de `.env.example` a medias en Vercel): `??` no cae al default porque `''`
//      no es `undefined`, y `Number('')` es 0. Cada mensaje saliente entraba a
//      $0.00 y el costo por liquidación bajaba sin que nada cambiara.
//   3. Un `costoUsd` NaN sobrevive a `toFixed(6)` y `JSON.stringify` lo manda
//      como `null`: la fila entra con `costo_usd` nulo y al leerla `Number(null)`
//      vale 0.
//   4. `getResumenCosto` descartaba el `error` de la consulta y devolvía ceros:
//      "la consulta falló" y "el mes costó $0" eran el mismo objeto.
//
// La regla que queda: **cero solo se pinta cuando cero es una medición**. Si no
// se pudo medir, el tipo no deja que exista una cifra (ver `ResumenCosto`), y si
// una liquidación se cierra sin un solo costo registrado, se dice en voz alta en
// el momento exacto en que se sabe (ver `vincularCostosALiquidacion`).
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { acotada } from './presupuesto';

export type FaseCosto = 'ocr' | 'cuadre' | 'escalacion' | 'chat' | 'router' | 'whatsapp' | 'transcripcion' | 'copiloto' | 'runner';

// Costo por mensaje SALIENTE de WhatsApp (los entrantes son GRATIS).
// Dentro de la ventana de servicio de 24h son gratis hasta el 1-oct-2026; después
// Meta cobra utility/servicio (~USD 0.0080 base MX). Override por env.
// ⚠️ Verificar rate card vigente de Meta antes de proyectar.
const WHATSAPP_MSG_USD_DEFAULT = 0.008;

// Se avisa una vez por valor inválido, no una vez por mensaje: la configuración
// no cambia dentro de una instancia, y repetir la misma línea miles de veces es
// como se entierra un aviso.
let avisadoPrecioInvalido: string | null = null;

/**
 * Precio de un mensaje saliente de WhatsApp, en USD.
 *
 * Se lee en cada envío y no en el import a propósito: como constante de módulo,
 * el valor quedaba congelado antes de que ninguna prueba (ni ningún arranque
 * tardío) pudiera verlo, y un error de configuración solo se manifestaba como
 * una cifra más baja en el panel.
 *
 * `'0'` explícito SÍ se respeta —dentro de la ventana de 24h Meta no cobra, y
 * ponerlo a cero es una decisión legítima—; `''` no, porque es un descuido. Esa
 * es toda la diferencia entre las dos ramas: cero a propósito vale, cero por
 * accidente no.
 */
export function precioMensajeWhatsAppUsd(): number {
  const crudo = process.env.LIKIDA_WHATSAPP_MSG_USD;
  if (crudo === undefined) return WHATSAPP_MSG_USD_DEFAULT;
  const n = Number(crudo);
  if (crudo.trim() === '' || !Number.isFinite(n) || n < 0) {
    if (avisadoPrecioInvalido !== crudo) {
      avisadoPrecioInvalido = crudo;
      logger.error('costo.precio_wa_invalido', {
        valor: crudo,
        usando: WHATSAPP_MSG_USD_DEFAULT,
        err: 'LIKIDA_WHATSAPP_MSG_USD no es un número válido: el costo por mensaje habría quedado en 0 y el costo por liquidación bajaría sin motivo',
      });
    }
    return WHATSAPP_MSG_USD_DEFAULT;
  }
  return n;
}

/** Registra el costo de UN mensaje saliente de WhatsApp (best-effort). */
export async function registrarCostoWhatsApp(tenantId: string, viajeId: string | null): Promise<void> {
  await registrarCosto({ tenantId, viajeId, fase: 'whatsapp', modelo: 'whatsapp-utility', tokensIn: 0, tokensOut: 0, costoUsd: precioMensajeWhatsAppUsd() });
}

export interface CostoLLM {
  tenantId: string;
  viajeId?: string | null;
  liquidacionId?: string | null;
  fase: FaseCosto;
  modelo: string;
  tokensIn: number;
  tokensOut: number;
  costoUsd: number;
}

/**
 * Deriva la fase a partir del slug del modelo: un cuadre que corrió en Opus es
 * `escalacion`. SOLO desde `cuadre` (B18, auditoría 18): el freno diario del
 * chat lee `.eq('fase','chat')`, y con `LIKIDA_MODEL_CHAT` apuntando a un
 * Opus cada turno se archivaba como `escalacion` — el tope de $1/día por
 * tenant dejaba de existir en silencio justo con el modelo más caro.
 */
export function faseDeModelo(modelo: string, base: FaseCosto): FaseCosto {
  if (base === 'cuadre' && modelo.includes('opus')) return 'escalacion';
  return base;
}

function entero(n: number): number {
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * Registra el costo de una llamada. Best-effort (no lanza) pero **nunca mudo**:
 * lo único que no puede pasar es que el costo desaparezca sin dejar línea.
 */
export async function registrarCosto(c: CostoLLM): Promise<void> {
  // Un NaN o un negativo NO se escriben. `JSON.stringify` manda NaN como `null`,
  // la fila entra con costo_usd nulo, y al leerla `Number(null)` es 0: una fila
  // que dice "esta llamada fue gratis" cuando lo que pasó es que no se supo
  // cuánto costó. Es preferible una línea de error y una fila menos.
  if (!Number.isFinite(c.costoUsd) || c.costoUsd < 0) {
    logger.error('costo.monto_invalido', {
      tenant: c.tenantId, viaje: c.viajeId ?? null, fase: c.fase, modelo: c.modelo,
      costoUsd: String(c.costoUsd),
      err: 'costo no finito o negativo: se descarta la fila en vez de escribir un 0 que se leería como barato',
    });
    return;
  }
  try {
    // `{ error }`, como las 19 funciones de repo.ts: supabase-js NO lanza ante un
    // error de la base. El `catch` de abajo solo cubre que reviente el `fetch`.
    const { error } = await acotada(supabaseAdmin().from('llm_costo').insert({
      tenant_id: c.tenantId,
      viaje_id: c.viajeId ?? null,
      liquidacion_id: c.liquidacionId ?? null,
      fase: c.fase,
      modelo: c.modelo,
      tokens_in: entero(c.tokensIn),
      tokens_out: entero(c.tokensOut),
      costo_usd: Number(c.costoUsd.toFixed(6)),
    }), 'registrarCosto');
    if (error) fallo(c, error.message, (error as { code?: string }).code);
  } catch (e) {
    fallo(c, e instanceof Error ? e.message : String(e));
  }
}

/**
 * La línea del costo perdido. Lleva tenant, viaje, fase, modelo y monto porque
 * sin ellos solo se sabe que "algo" no se registró: no cuánto se dejó de contar
 * ni de qué flota, que es lo único con lo que se puede corregir la cifra a mano.
 * (El logger huella los UUID: en el log salen como `id:xxxxxxxxxxxx`, cruzables
 * contra la base con `huellaId`.)
 */
function fallo(c: CostoLLM, err: string, code?: string): void {
  logger.error('costo.no_registrado', {
    tenant: c.tenantId, viaje: c.viajeId ?? null, fase: c.fase, modelo: c.modelo,
    costoUsd: Number(c.costoUsd.toFixed(6)), ...(code ? { code } : {}), err,
  });
}

/**
 * Al cerrar la liquidación, vincula los costos del viaje a su liquidacion_id.
 *
 * Es además el ÚNICO instante en que se puede afirmar si el costo unitario de
 * esa liquidación está medido: si no hay una sola fila de `llm_costo` para el
 * viaje, la liquidación se cerró sin costo y su precio no se puede razonar. Ese
 * caso se grita aquí, no en el panel semanas después.
 */
export async function vincularCostosALiquidacion(tenantId: string, viajeId: string, liquidacionId: string): Promise<void> {
  try {
    const { data, error } = await acotada(supabaseAdmin()
      .from('llm_costo')
      .update({ liquidacion_id: liquidacionId })
      .eq('tenant_id', tenantId)
      .eq('viaje_id', viajeId)
      .is('liquidacion_id', null)
      .select('id'), 'vincularCostosALiquidacion');
    if (error) {
      logger.error('costo.no_vinculado', {
        tenant: tenantId, viaje: viajeId, liquidacion: liquidacionId,
        code: (error as { code?: string }).code, err: error.message,
      });
      return;
    }
    const filas = data?.length ?? 0;
    if (filas > 0) {
      logger.info('costo.vinculado', { tenant: tenantId, viaje: viajeId, liquidacion: liquidacionId, filas });
      return;
    }
    // Cero filas actualizadas es ambiguo por el filtro `liquidacion_id IS NULL`:
    // o no había costos, o ya estaban vinculados (recierre / cierre parcial
    // recuperado). Se desambigua con UNA consulta más, y solo en esta rama rara,
    // porque una alarma que salta en cada recierre deja de leerse.
    await avisarSiNoHayCosto(tenantId, viajeId, liquidacionId);
  } catch (e) {
    logger.error('costo.no_vinculado', {
      tenant: tenantId, viaje: viajeId, liquidacion: liquidacionId,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

async function avisarSiNoHayCosto(tenantId: string, viajeId: string, liquidacionId: string): Promise<void> {
  const { count, error } = await acotada(supabaseAdmin()
    .from('llm_costo')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('viaje_id', viajeId), 'contarCostosDelViaje');
  if (error) {
    logger.warn('costo.conteo_ilegible', { tenant: tenantId, viaje: viajeId, err: error.message });
    return;
  }
  if ((count ?? 0) === 0) {
    logger.error('costo.liquidacion_sin_costo', {
      tenant: tenantId, viaje: viajeId, liquidacion: liquidacionId,
      err: 'la liquidación se cerró sin una sola fila de llm_costo: su costo unitario es DESCONOCIDO, no cero',
    });
    return;
  }
  logger.info('costo.vinculado', { tenant: tenantId, viaje: viajeId, liquidacion: liquidacionId, filas: 0, yaVinculados: count });
}

export interface CifrasCosto {
  totalUsd: number;
  liquidaciones: number;
  /** `null` cuando hay costo pero ninguna fila trae viaje: no hay a qué atribuirlo. */
  costoPromedioPorLiquidacion: number | null;
  tokensIn: number;
  tokensOut: number;
  registros: number;
  porFase: Record<string, number>;
}

/**
 * Tres estados, no uno.
 *
 * El tipo es una unión discriminada a propósito: fuera de `'medido'` no existe
 * `totalUsd`, así que **no se puede pintar un 0 que nadie midió**. Antes la
 * consulta podía fallar y el consumidor recibía `{ totalUsd: 0, liquidaciones: 0,
 * costoPromedioPorLiquidacion: 0 }`, idéntico a un mes sin gasto.
 *
 *   · `medido`         — hubo filas y las cifras son reales.
 *   · `sin_registros`  — la consulta funcionó y no hay NI UNA fila. No es $0: es
 *                        "no se está midiendo" (o el tenant no ha operado).
 *   · `no_medido`      — la consulta falló. No se sabe nada.
 */
export type ResumenCosto =
  | ({ estado: 'medido' } & CifrasCosto)
  | { estado: 'sin_registros' }
  | { estado: 'no_medido'; err: string };

// ═══════════════════════════════════════════════════════════════════════════
// EL QUINTO CAMINO, Y EL ÚNICO QUE YA ESTABA MAL EN VEZ DE ESPERAR A CRECER
//
// Los cuatro de arriba se cerraron en la auditoría 5. Este se encontró el
// 5-ago-2026 al mover a SQL la agregación de /admin (mig. 0062), y es peor que
// los cuatro juntos porque no necesita que pase nada para dar una cifra falsa:
//
//     .from('llm_costo').select('viaje_id, fase, …').eq('tenant_id', tenantId)
//
// Sin `traerTodo`, sin `range`, sin `count`. PostgREST recorta a `max_rows`
// (1,000) EN SILENCIO. A partir de la llamada 1,001 de una flota —semanas, no
// años— `totalUsd` y `costoPromedioPorLiquidacion` se quedaban cortos, y se
// entregaban con `estado: 'medido'`, que es una AFIRMACIÓN. Toda la unión
// discriminada de abajo existe para que un cero no medido no se pueda pintar, y
// esta consulta la burlaba por el otro lado: entregando una cifra INCOMPLETA
// con la etiqueta de buena.
//
// Se arregla agregando en SQL (`resumen_costo_ia_tenant`, mig. 0064), no
// paginando: traer 790 mil filas al año para sumarlas en JavaScript sigue
// siendo el patrón equivocado aunque ya no se recorten.
// ═══════════════════════════════════════════════════════════════════════════

/** Lo que devuelve `resumen_costo_ia_tenant()` (mig. 0064). Costos SIN
 *  redondear —los redondea `round6()` aquí abajo, que es quien siempre lo hizo. */
export interface ResumenCostoIaTenant {
  totales: { n: number; viajes: number; costoUsd: number; tokensIn: number; tokensOut: number };
  porFase: Array<{ fase: string; n: number; costoUsd: number }>;
}

/**
 * La agregación de `llm_costo` de UNA flota. La comparten `getResumenCosto` (de
 * aquí) y `getValorAhorro` (analytics.ts), que antes leían la misma tabla por su
 * cuenta: uno para sumar el costo y el otro para contar por fase.
 *
 * Vive en este módulo porque es el que escribe `llm_costo`, y en UN solo sitio
 * por la misma razón que `pg.ts` da para haber extraído sus dos bordes: una
 * segunda copia es una segunda oportunidad de escribirla mal.
 *
 * Devuelve `null` con el motivo cuando no se pudo leer O cuando la respuesta no
 * tiene la forma esperada. Ese segundo caso es nuevo y hace falta justo por
 * haber movido esto a la base: si la 0064 no está aplicada, `data` llega como
 * otra cosa y cada `?? 0` de abajo pintaría un cero que nadie midió.
 */
export async function traerResumenCostoIaTenant(
  tenantId: string,
  etiqueta: string,
): Promise<{ ok: ResumenCostoIaTenant } | { err: string }> {
  try {
    const { data, error } = await acotada(supabaseAdmin()
      .rpc('resumen_costo_ia_tenant', { p_tenant: tenantId, p_desde: null, p_hasta: null }), etiqueta);
    if (error) return { err: error.message };
    const r = data as Partial<ResumenCostoIaTenant> | null;
    const t = r?.totales;
    if (
      !t || typeof t.n !== 'number' || typeof t.viajes !== 'number'
      || typeof t.costoUsd !== 'number' || typeof t.tokensIn !== 'number'
      || typeof t.tokensOut !== 'number' || !Array.isArray(r?.porFase)
    ) {
      return { err: 'resumen_costo_ia_tenant devolvió otra forma (¿migración 0064 sin aplicar?)' };
    }
    return { ok: r as ResumenCostoIaTenant };
  } catch (e) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
}

/** Resumen de costo del tenant (para el panel: margen real). */
export async function getResumenCosto(tenantId: string): Promise<ResumenCosto> {
  const res = await traerResumenCostoIaTenant(tenantId, 'getResumenCosto');
  if ('err' in res) return ilegible(tenantId, res.err);
  const { totales, porFase: fases } = res.ok;

  // `n === 0` es la prueba de que la consulta corrió y no hay NI UNA fila. Antes
  // era `filas.length === 0`, que sobre una lectura recortada podía ser cierto
  // por la razón equivocada.
  if (totales.n === 0) return { estado: 'sin_registros' };

  const porFase: Record<string, number> = {};
  for (const f of fases) porFase[f.fase] = round6(f.costoUsd);
  return {
    estado: 'medido',
    totalUsd: round6(totales.costoUsd),
    liquidaciones: totales.viajes,
    // Dividir entre cero viajes daba 0, y un promedio de $0 por liquidación se
    // lee como "cada liquidación sale gratis". Si no hay denominador, no hay
    // promedio. (`count(distinct viaje_id)` ignora los NULL solo, igual que el
    // `new Set(...).filter(Boolean)` que sustituye.)
    costoPromedioPorLiquidacion: totales.viajes ? round6(totales.costoUsd / totales.viajes) : null,
    tokensIn: totales.tokensIn,
    tokensOut: totales.tokensOut,
    registros: totales.n,
    porFase,
  };
}

function ilegible(tenantId: string, err: string): ResumenCosto {
  logger.error('costo.resumen_ilegible', {
    tenant: tenantId,
    err: `no se pudo leer llm_costo: ${err}. El costo del tenant queda SIN MEDIR (no en cero)`,
  });
  return { estado: 'no_medido', err };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
