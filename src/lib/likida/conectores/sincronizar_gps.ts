// ═══════════════════════════════════════════════════════════════════════════
// EL POLLER — el que convierte «conector configurado» en «fuente sincronizada».
//
// Hasta hoy `posicion` tenía UN escritor: el pin que un chofer manda a mano por
// WhatsApp. Los conectores de GPS existían, probaban su credencial y declaraban
// `leer_posiciones`, pero nadie los llamaba. La landing dice «el GPS de tu
// flota» entre las fuentes de dato, y esto es lo que faltaba para que lo sea.
//
// ── LO QUE NO HACE, Y ESO ES EL DISEÑO ────────────────────────────────────
// No da de alta unidades. Una posición llega con el id del dispositivo en el
// sistema del proveedor, y si NINGUNA unidad de la flota lo reclama
// (`unidad.gps_device_id`), la lectura se cuenta como huérfana y se REPORTA —
// no se inventa un camión. Dar de alta flota desde un feed ajeno es cómo se
// llena una base de vehículos fantasma que nadie mandó crear.
//
// ── LA IDEMPOTENCIA ───────────────────────────────────────────────────────
// El proveedor devuelve la ÚLTIMA posición conocida: dos corridas seguidas con
// el camión parado traen la misma lectura, con la misma `medida_en`. El único
// `uq_posicion_lectura` (0176) las colapsa, y aquí se hace `upsert` con
// `ignoreDuplicates` para que eso no cuente como error.
// ═══════════════════════════════════════════════════════════════════════════
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { acotada } from '../presupuesto';
import { descifrar } from './cofre';
import { lectorDe, LECTORES_POSICION } from './posiciones';
import { httpReal as crearHttpReal, type Http } from './tipos';
import { conPool } from '../lotes';
import { unidadesSinAvisoPrevio } from '../privacidad';
import { finalizarPoll, reclamarPolls } from './poll_durable';

// ── AUDITORÍA 24, REN-2 (ALTO): EL TOPE MUDO ─────────────────────────────
// Era `TOPE_POR_FLOTA = 500` con `.slice()` en silencio: con las 800 unidades
// de Innovativos, las MISMAS 300 quedaban fuera en las 288 corridas del día,
// sin posición, sin `gps_visto_en`, y el cron latía «ok» con `leidas = 500`.
// El conciliador de peajes las marcaba «sin evidencia GPS» — una afirmación
// falsa sobre el comprobante de otro. Ahora el techo es de seguridad (una
// ráfaga absurda del proveedor), no de dimensionamiento, y si se cruza SE
// DICE: `recortadas` en el resultado, `error` en el log y `parcial` en el cron.
/** Filas por `upsert`: el cuerpo viaja en POST, pero cada tanda es UNA
 *  transacción contra un índice único; 500 mantiene cortas las esperas. */
const FILAS_POR_UPSERT = 500;
/** UUIDs/ids por `.in()`: viajan en la URL. 200 son ~7.5 KB, debajo del techo
 *  típico de un proxy (misma cifra que `IDS_POR_TANDA` en pg.ts — REN-7:
 *  500 ids eran 19 KB y un 414 dejaba `gps_visto_en` nulo sin que nadie lo
 *  leyera). */
const IDS_POR_CONSULTA = 200;
/** Una lectura fechada más de una hora después de recibida es un reloj mal
 *  puesto, no una posición (CHECK `posicion_medida_en_no_futura`, 0287). Se
 *  descarta AQUÍ para que una unidad con reloj malo no tumbe la tanda de la
 *  flota entera contra ese CHECK. */
const TOLERANCIA_FUTURO_MS = 60 * 60 * 1000;
/** Evita que una instalación con muchas flotas abra una ráfaga ilimitada de
 * conexiones contra proveedores y PostgREST. */
const ANCHO_FANOUT_FLOTAS = 4;

export interface ResultadoSync {
  tenantId: string;
  proveedor: string;
  leidas: number;
  guardadas: number;
  /** Lecturas cuyo dispositivo no lo reclama ninguna unidad. Se reportan. */
  huerfanas: number;
  paginas?: number;
  ultimaMedidaEn?: string;
  /** true = el proveedor declaró más trabajo, pero no se pudo completar. */
  backlog?: boolean;
  /** Lecturas válidas que quedaron fuera por `TOPE_LECTURAS_POR_FLOTA`. Si es
   *  > 0 el cron NO puede latir «ok» (REN-2). */
  recortadas?: number;
  /** Lecturas que no cruzaron a Postgres: coordenadas fuera de dominio, fecha
   *  ilegible o fechada en el futuro (reloj del GPS). Se dicen. */
  descartadas?: number;
  /**
   * AUDITORÍA 24, LEG-1 (CRÍTICO). Unidades cuyo operador ACTUAL (viaje vivo)
   * no ha recibido el aviso de privacidad: sus posiciones NO se guardan. El
   * art. 16 LFPDPPP exige el aviso ANTES del tratamiento, y rastrear 288
   * veces al día a quien nunca lo recibió es el tratamiento principal del
   * piloto. Se cuenta para que el cron lo pinte y la flota pueda cerrarlo.
   */
  sinAvisoPrevio?: number;
  /** La corrida se quedó sin presupuesto de tiempo ANTES de tocar esta flota.
   *  No es un error de la flota: le toca en la corrida siguiente (cada 5 min),
   *  y el cron lo reporta como `parcial` — un verde aquí mentiría. */
  sinTurno?: boolean;
  error?: string;
}

type Lectura = { deviceId: string; lat: number; lng: number; medidaEn: string; velocidad: number | null; rumbo: number | null };

/** La frontera entre un proveedor ajeno y nuestra tabla es estricta: un id
 * vacío, una fecha inválida o números fuera de dominio no llegan a Postgres.
 * El lector valida su JSON, pero esta segunda barrera protege adaptadores
 * futuros y evita escribir NaN/fechas locales ambiguas. */
function posicionValida(p: Lectura, ahoraMs: number): boolean {
  const fecha = Date.parse(p.medidaEn);
  return p.deviceId.trim().length > 0 && p.deviceId.length <= 200 &&
    Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180 &&
    !(p.lat === 0 && p.lng === 0) && Number.isFinite(fecha) &&
    fecha <= ahoraMs + TOLERANCIA_FUTURO_MS &&
    // Es exactamente el CHECK de Postgres (`velocidad < 250`). Una lectura de
    // 257.5 se descarta sola; no tumba el upsert de las otras 4,999.
    (p.velocidad === null || (Number.isFinite(p.velocidad) && p.velocidad >= 0 && p.velocidad < 250)) &&
    (p.rumbo === null || (Number.isFinite(p.rumbo) && p.rumbo >= 0 && p.rumbo < 360));
}

function enTandas<T>(items: readonly T[], tamano: number): T[][] {
  const salida: T[][] = [];
  for (let i = 0; i < items.length; i += tamano) salida.push(items.slice(i, i + tamano));
  return salida;
}

/** El `Http` real. Se inyecta para poder probar sin red. */
export const httpReal: Http = crearHttpReal();

/**
 * Sincroniza las posiciones de UNA flota con UN proveedor.
 *
 * Devuelve el conteo en vez de lanzar: una flota cuyo GPS falla no puede tumbar
 * la corrida de las demás — es el mismo criterio que las purgas nocturnas
 * aprendieron a golpes en la 0165.
 */
export async function sincronizarGpsDeFlota(
  tenantId: string,
  conectorId: string,
  valoresCifrados: string,
  http: Http = httpReal,
  ahora: () => number = Date.now,
  opciones: { venceEn?: number; reloj?: () => number; dormir?: (ms: number) => Promise<void> } = {},
): Promise<ResultadoSync> {
  const base: ResultadoSync = { tenantId, proveedor: conectorId, leidas: 0, guardadas: 0, huerfanas: 0 };
  const reloj = opciones.reloj ?? ahora;
  const sinTiempo = () => opciones.venceEn !== undefined && reloj() >= opciones.venceEn;

  const lector = lectorDe(conectorId);
  if (!lector) {
    return { ...base, error: `todavía no hay lector de posiciones para ${conectorId}` };
  }

  let valores;
  try {
    valores = descifrar(valoresCifrados);
  } catch (e) {
    return { ...base, error: `no se pudo descifrar la credencial: ${e instanceof Error ? e.message : String(e)}` };
  }

  const r = await lector(valores, http, { venceEn: opciones.venceEn, ahora: opciones.reloj ?? ahora, dormir: opciones.dormir });
  if (!r.ok) return { ...base, paginas: r.paginas, backlog: r.backlog, error: r.motivo };
  base.paginas = r.paginas;
  const ahoraMs = ahora();
  const validas = r.posiciones.filter((p) => posicionValida(p, ahoraMs));
  const descartadas = r.invalidas + (r.posiciones.length - validas.length);
  if (descartadas > 0) {
    base.descartadas = descartadas;
    base.backlog = true;
    base.error = `${descartadas} lectura(s) GPS inválida(s); poll parcial`;
    logger.warn('gps.lecturas_descartadas', { tenantId, proveedor: conectorId, descartadas: base.descartadas });
  }
  const posiciones = validas;
  base.leidas = posiciones.length;
  if (posiciones.length > 0) {
    base.ultimaMedidaEn = posiciones.reduce((max, p) => Date.parse(p.medidaEn) > Date.parse(max) ? p.medidaEn : max, posiciones[0].medidaEn);
  }
  if (posiciones.length === 0) return base;

  // ── DEVICE ID → UNIDAD, filtrando por flota ───────────────────────────
  // El `.eq('tenant_id', …)` no es decorativo: `supabaseAdmin` salta RLS, así
  // que sin él una lectura podría asentarse en la unidad de otra flota que
  // usara el mismo número de dispositivo con otro proveedor.
  const ids = [...new Set(posiciones.map((p) => p.deviceId))];
  const porDevice = new Map<string, string>();
  for (const tanda of enTandas(ids, IDS_POR_CONSULTA)) {
    if (sinTiempo()) return { ...base, backlog: true, error: 'quedó mapeo de unidades pendiente al vencer el presupuesto' };
    const { data: unidades, error: errU } = await acotada(
      supabaseAdmin().from('unidad')
        .select('id, gps_device_id')
        .eq('tenant_id', tenantId)
        .eq('gps_proveedor', conectorId)
        .in('gps_device_id', tanda),
      'gps.unidades',
    );
    if (errU) return { ...base, error: `no se pudieron leer las unidades: ${errU.message}` };
    for (const u of unidades ?? []) {
      if (u.gps_device_id) porDevice.set(String(u.gps_device_id), String(u.id));
    }
  }

  let filas: Array<{ tenant_id: string; unidad_id: string; lat: number; lng: number; velocidad: number | null; rumbo: number | null; medida_en: string; proveedor: string }> = [];
  const unidadesVistas = new Set<string>();
  for (const p of posiciones) {
    const unidadId = porDevice.get(p.deviceId);
    if (!unidadId) { base.huerfanas += 1; continue; }
    unidadesVistas.add(unidadId);
    filas.push({
      tenant_id: tenantId,
      unidad_id: unidadId,
      lat: p.lat,
      lng: p.lng,
      velocidad: p.velocidad,
      rumbo: p.rumbo,
      medida_en: p.medidaEn,
      proveedor: conectorId,
    });
  }

  // ── LEG-1: NO SE TRATA ANTES DE AVISAR ──────────────────────────────────
  // Va ANTES del upsert a propósito: guardar la posición ya es tratamiento.
  // Si la base no contesta, no se guarda NADA de esta flota (fallar cerrado):
  // «no sé si avisé» no es permiso para rastrear.
  if (unidadesVistas.size > 0) {
    if (sinTiempo()) return { ...base, backlog: true, error: 'no se abrió la compuerta de privacidad: venció el presupuesto' };
    const compuerta = await unidadesSinAvisoPrevio(tenantId, [...unidadesVistas]);
    if (compuerta.error) {
      return { ...base, error: `no se guardó ninguna posición: ${compuerta.error}` };
    }
    if (compuerta.sinAviso.size > 0) {
      base.sinAvisoPrevio = compuerta.sinAviso.size;
      filas = filas.filter((f) => !compuerta.sinAviso.has(f.unidad_id));
      for (const u of compuerta.sinAviso) unidadesVistas.delete(u);
      logger.warn('gps.sin_aviso_previo', { tenantId, proveedor: conectorId, unidades: compuerta.sinAviso.size });
    }
  }

  if (filas.length > 0) {
    // `ignoreDuplicates`: la misma última posición entre corridas no es un
    // error, es lo normal cuando el camión está parado. En tandas de
    // FILAS_POR_UPSERT con ancho 2: 800 unidades son dos viajes, no uno de
    // 800 filas ni 800 de una.
    const tandas = enTandas(filas, FILAS_POR_UPSERT);
    for (const tanda of tandas) {
      if (sinTiempo()) return { ...base, backlog: true, error: 'quedaron posiciones por guardar al vencer el presupuesto' };
      const { data: insertadas, error: errIns } = await acotada(
        supabaseAdmin().from('posicion')
          .upsert(tanda, { onConflict: 'tenant_id,unidad_id,medida_en', ignoreDuplicates: true })
          .select('id'),
        'gps.guardar_posiciones',
      );
      if (errIns) return { ...base, error: `no se pudieron guardar las posiciones: ${errIns.message}` };
      base.guardadas += (insertadas ?? []).length;
    }

    // `gps_visto_en` es lo que distingue «credencial guardada» de «fuente que
    // de verdad está entrando». Sin esta marca, el panel no puede decir la
    // diferencia y la landing tampoco. REN-7: en tandas de 200 ids (la lista
    // viaja en la URL) y MIRANDO el error — antes se tiraba, y un 414 del
    // borde dejaba la flota entera en «la fuente todavía no entra».
    const sello = new Date(ahoraMs).toISOString();
    for (const tanda of enTandas([...unidadesVistas], IDS_POR_CONSULTA)) {
      if (sinTiempo()) return { ...base, backlog: true, error: 'quedaron unidades sin sellar gps_visto_en al vencer el presupuesto' };
      const { error: errSello } = await acotada(
        supabaseAdmin().from('unidad')
          .update({ gps_visto_en: sello })
          .eq('tenant_id', tenantId)
          .in('id', tanda),
        'gps.sellar_visto',
      );
      if (errSello) {
        return { ...base, error: `las posiciones se guardaron pero no se pudo sellar gps_visto_en: ${errSello.message}` };
      }
    }
  }

  if (base.huerfanas > 0) {
    // Se dice, no se calla: son camiones que el proveedor reporta y que nadie
    // ligó a una unidad. El dueño de la flota tiene que enterarse.
    logger.warn('gps.lecturas_huerfanas', { tenantId, proveedor: conectorId, huerfanas: base.huerfanas });
  }
  return base;
}

/**
 * Sincroniza TODAS las flotas con credencial de GPS activa.
 *
 * ── EL RELOJ (patrón del PR #152 / `vigilarPortales`) ─────────────────────
 * `venceEn` es el `Date.now()` a partir del cual la corrida deja de tomar
 * flotas NUEVAS. El corte va ANTES de despachar una flota, nunca a medias: la
 * flota en vuelo termina (es la unidad atómica) y las que no alcanzaron turno
 * salen con `sinTurno: true` — se DICEN, no desaparecen. Antes de esto el cron
 * de GPS era el único de los diez sin reloj duro, con la medición propia
 * (174-188 s reales contra 300 de techo, y las posiciones SOLAS ~180 s) ya
 * avisando que un kill de Vercel a media corrida era cosa de que N creciera.
 */
export async function sincronizarGpsTodas(
  http: Http = httpReal,
  opts: { venceEn?: number; ahora?: () => number } = {},
): Promise<ResultadoSync[]> {
  const ahora = opts.ahora ?? Date.now;
  // 0324: Postgres reclama primero las flotas menos recientemente iniciadas.
  // Dos invocaciones solapadas no tocan la misma, y cinco tenants lentos no
  // condenan al último por el orden físico de `conector_credencial`.
  // Sólo se reclama lo que el pool puede arrancar de inmediato. Reclamar 200
  // y luego expirar 196 como "sin turno" actualizaría su último inicio sin
  // haberlos atendido y reintroduciría hambre por el desempate fijo.
  const credenciales = await reclamarPolls(
    'posiciones', Object.keys(LECTORES_POSICION), ANCHO_FANOUT_FLOTAS,
  );
  const resultados = await conPool(credenciales, ANCHO_FANOUT_FLOTAS, async (c) => {
    // El reloj se mira ANTES de despachar cada flota, no una vez al principio:
    // el patrón de `conRelojDuro`/`vigilarPortales`. Lo que no alcanzó queda
    // intacto para la corrida siguiente.
    if (opts.venceEn !== undefined && ahora() >= opts.venceEn) {
      const sinTurno = {
        tenantId: c.tenantId, proveedor: c.proveedor,
        leidas: 0, guardadas: 0, huerfanas: 0, sinTurno: true,
      } satisfies ResultadoSync;
      await finalizarPoll('posiciones', c, { completo: false, error: 'sin turno por reloj' });
      return sinTurno;
    }
    const resultado = await sincronizarGpsDeFlota(
      c.tenantId, c.proveedor, c.valoresCifrados, http, Date.now,
      { venceEn: opts.venceEn, reloj: ahora },
    );
    const completo = !resultado.error && !resultado.backlog && !resultado.sinTurno &&
      resultado.huerfanas === 0 && (resultado.sinAvisoPrevio ?? 0) === 0;
    try {
      await finalizarPoll('posiciones', c, {
        completo,
        ultimaMedidaEn: resultado.ultimaMedidaEn,
        paginas: resultado.paginas,
        elementos: resultado.leidas,
        error: resultado.error ?? (!completo ? 'posiciones huérfanas o sin aviso previo' : undefined),
      });
      if (!completo) resultado.backlog = true;
      return resultado;
    } catch (e) {
      return { ...resultado, error: `no se pudo finalizar el estado durable: ${e instanceof Error ? e.message : String(e)}`, backlog: true };
    }
  });
  const salida = resultados.map((r, i) => {
    if ('ok' in r) return r.ok;
    const c = credenciales[i];
    return {
      tenantId: c.tenantId, proveedor: c.proveedor,
      leidas: 0, guardadas: 0, huerfanas: 0,
      error: r.error instanceof Error ? r.error.message : String(r.error),
    };
  });
  const sinTurno = salida.filter((r) => r.sinTurno).length;
  if (sinTurno > 0) {
    // WARN, no info: la corrida NO barrió su universo. El cron lo pinta
    // `parcial` — quedó trabajo declarado para la siguiente pasada.
    logger.warn('gps.corte_por_reloj', { sinTurno, flotas: salida.length });
  }
  return salida;
}
