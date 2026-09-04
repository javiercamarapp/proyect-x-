import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { acotada } from '../presupuesto';

// ═══════════════════════════════════════════════════════════════════════════
// EL DERIVADOR — convertir lo que Likida YA sabe en marcas con origen.
//
// La flota tiene hitos de viaje y posiciones de GPS desde hace meses. Lo que no
// tenía es un registro de jornada. Este motor cierra esa distancia SIN inventar
// una hora: cada marca que asienta lleva `procedencia` y `origen_ref`, o sea el
// hecho exacto del que se dedujo, y el resto del sistema la trata como lo que
// es — una observación, no una declaración del operador.
//
// ── LO QUE DERIVA, Y LO QUE SE NIEGA A DERIVAR ───────────────────────────
//
//   · `viaje.aceptado_en` → inicio_jornada. Aceptar un viaje por WhatsApp ES un
//     acto de trabajo con hora exacta. Se deriva.
//   · Primera y última posición GPS del día → inicio y fin de jornada. Prueban
//     que la unidad se movió; son una COTA INFERIOR de la jornada real.
//   · `llegada_en` / `descarga_en` / `regreso_en` → NADA. «Ya llegué» no es
//     «empecé a trabajar»: el chofer manejó horas antes de llegar. Derivar el
//     inicio de un hito de llegada acortaría la jornada registrada, y una
//     jornada acortada por el sistema es un documento que favorece al patrón
//     con una hora que nadie declaró. Es exactamente lo que no se hace.
//
// ── POR QUÉ UNA MARCA DERIVADA NO PUEDE DAR CARTA LIMPIA ─────────────────
//
// Una cota inferior sirve para probar el exceso y NO para descartarlo: si con
// la primera posición del GPS ya salen trece horas, la jornada real fue de
// trece o más. Pero si salen nueve, la real pudo ser de catorce. Por eso
// `riesgo.ts` NUNCA emite `sin_senal_de_exceso` sobre un día con puntas
// derivadas — devuelve `dato_insuficiente`. La derivación levanta banderas;
// nunca las baja.
//
// ── Y POR QUÉ LA DECLARACIÓN LE GANA ─────────────────────────────────────
//
// La RPC `asentar_extremo_jornada_derivado` (0319) serializa sobre el
// expediente: puede versionar otra cota automática, pero devuelve `ya_estaba`
// ante una declaración/captura humana. El índice
// `jornada_asiento_marca_unica` (0241) sigue impidiendo dos extremos vivos.
// ═══════════════════════════════════════════════════════════════════════════

/** Cuántos días hacia atrás barre una corrida. Los hitos y las posiciones no
 *  cambian retroactivamente; tres días cubren un fin de semana con el cron
 *  caído sin volver a recorrer el mes entero cada hora. */
export const DIAS_QUE_BARRE = 3;

/** Tope de pares (operador, día) reclamados por corrida. La RPC 0319 entrega
 * claims con lease; sólo un ACK posterior reconoce cada trabajo intentado. */
export const TOPE_VIAJES_POR_CORRIDA = 400;

/**
 * El margen que la derivación deja libre del `maxDuration` del cron para lo
 * que corre después en la misma invocación. Mismo criterio que
 * `PLAZO_ESCALACION_MS` de `escalar_viaje.ts`.
 */
export const PLAZO_DERIVACION_MS = 45_000;
const LEASE_JORNADA_SECONDS = 180;
const REINTENTO_FALLO_SECONDS = 300;
const REVISITA_EXITOSA_SECONDS = 3_600;
const TAMANO_LOTE_PROCESO = 50;

export interface ResultadoDerivacion {
  /** Pares (operador, día) que la corrida se propuso revisar. */
  revisados: number;
  asentados: number;
  yaEstaban: number;
  fallos: string[];
  /** Pares que el reloj de la corrida dejó SIN intentar. No se pierden: nada
   *  se les marcó y la corrida siguiente los encabeza. */
  cortadosPorReloj: number;
  /** Días con unidad asignada y CERO posiciones de GPS. Se cuenta y se dice:
   *  «no hubo de dónde derivar» no es lo mismo que «no había jornada». */
  diasSinGps: number;
  /**
   * AUDITORÍA 22, LEG-C1 (CRÍTICO). Pares (operador, día) que NO se derivaron
   * porque el operador nunca recibió el aviso de privacidad.
   *
   * `ponerAvisoADisposicion` cuelga del camino del MENSAJE ENTRANTE, y un
   * chofer que recibe sus viajes por radio puede no escribir nunca: su
   * `operador.aviso_privacidad_en` se queda en NULL mientras el cron le
   * construye un expediente laboral —horas, banderas del art. 61 y del 68—
   * que él nunca supo que existía. El art. 16 de la LFPDPPP obliga a poner el
   * aviso a disposición ANTES del tratamiento, y el propio `privacidad.ts`
   * escribe ese principio: «esperar a que haya filas sería avisar después de
   * tratar».
   *
   * Se cuenta para que el cron lo pinte y la flota pueda cerrarlo: sin la
   * lista, el hueco es invisible.
   */
  sinAvisoPrevio: number;
  /**
   * `true` si quedan pares elegibles fuera de este lote. No implica pérdida:
   * los no intentados se liberan y los ACK pendientes sobreviven en la cola.
   */
  listaTruncada: boolean;
}

interface Trabajo {
  tenantId: string;
  operadorId: string;
  unidadId: string | null;
  unidadIds: string[];
  dia: string;
  /** El instante de `aceptado_en` si cae en este día. */
  aceptadoEn: string | null;
  viajeId: string;
  claimToken: string;
  zonaHoraria: string;
}

/** Día natural de un instante en una zona IANA. Postgres es la autoridad para
 * persistir el bucket; este helper sólo cubre el fallback de despliegue y hace
 * explícito que el servidor no debe usar su zona local. */
export function diaEnZona(momento: Date, zonaHoraria: string): string {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: zonaHoraria, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(momento);
  const valor = (tipo: Intl.DateTimeFormatPartTypes) =>
    partes.find((p) => p.type === tipo)?.value;
  const dia = `${valor('year')}-${valor('month')}-${valor('day')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) throw new Error(`zona IANA inválida: ${zonaHoraria}`);
  return dia;
}

/**
 * Arma la lista de trabajo: un renglón por (operador, día) tocado por un viaje
 * de la ventana.
 *
 * La 0325 separa la sincronización del claim. El UPSERT de fuentes termina
 * antes de intentar `SKIP LOCKED`, de modo que dos crons no esperan el mismo
 * transactionid antes de llegar al candado no bloqueante.
 */
async function listaDeTrabajo(
  ahora: Date,
  dias: number,
): Promise<{ trabajos: Trabajo[]; truncada: boolean; owner: string; error: string | null }> {
  const owner = `jornada:${randomUUID()}`;
  const sincronizada = await acotada(
    supabaseAdmin().rpc('sincronizar_jornadas_por_derivar', {
      p_ahora: ahora.toISOString(), p_dias: dias,
    }),
    'jornada.derivar.sincronizar',
  );
  if (sincronizada.error) {
    return { trabajos: [], truncada: false, owner, error: sincronizada.error.message };
  }

  const { data, error } = await acotada(
    supabaseAdmin().rpc('reclamar_jornadas_por_derivar', {
      p_limite: TOPE_VIAJES_POR_CORRIDA,
      p_owner: owner,
      p_lease_seconds: LEASE_JORNADA_SECONDS,
    }),
    'jornada.derivar.viajes',
  );
  if (error) return { trabajos: [], truncada: false, owner, error: error.message };

  type Fila = {
    id: string; tenant_id: string; operador_id: string;
    unidad_id: string | null; unidad_ids?: string[] | null; aceptado_en: string; dia: string;
    zona_horaria?: string | null; claim_token: string; hay_mas: boolean;
  };
  const filas = (data ?? []) as unknown as Fila[];
  const truncada = filas.some((f) => f.hay_mas === true);
  const trabajos: Trabajo[] = filas.map((f) => {
    const zonaHoraria = f.zona_horaria || 'America/Mexico_City';
    const dia = f.dia || diaEnZona(new Date(f.aceptado_en), zonaHoraria);
    return {
      tenantId: String(f.tenant_id),
      operadorId: String(f.operador_id),
      unidadId: f.unidad_id ? String(f.unidad_id) : null,
      unidadIds: Array.isArray(f.unidad_ids)
        ? f.unidad_ids.map(String)
        : f.unidad_id ? [String(f.unidad_id)] : [],
      dia,
      aceptadoEn: f.aceptado_en,
      viajeId: String(f.id),
      claimToken: String(f.claim_token),
      zonaHoraria,
    };
  });
  return { trabajos, truncada, owner, error: null };
}

async function liberarNoIntentados(owner: string, trabajos: Trabajo[]): Promise<boolean> {
  if (trabajos.length === 0) return true;
  const { data, error } = await acotada(supabaseAdmin().rpc('liberar_jornadas_por_derivar', {
    p_owner: owner,
    p_claim_tokens: trabajos.map((t) => t.claimToken),
  }), 'jornada.derivar.liberar');
  if (error) return false;
  const liberados = Number(Array.isArray(data) ? data[0] : data);
  return Number.isFinite(liberados) && liberados === trabajos.length;
}

interface ResultadoLote {
  claim_token: string;
  exito: boolean;
  asentados: number;
  ya_estaban: number;
  dia_sin_gps: boolean;
  sin_aviso: boolean;
  error: string | null;
}

async function procesarLote(owner: string, lote: Trabajo[]): Promise<{
  filas: ResultadoLote[]; error: string | null;
}> {
  const { data, error } = await acotada(supabaseAdmin().rpc('procesar_jornadas_derivadas', {
    p_owner: owner,
    p_claim_tokens: lote.map((t) => t.claimToken),
    p_retraso_exito_seconds: REVISITA_EXITOSA_SECONDS,
    p_retraso_fallo_seconds: REINTENTO_FALLO_SECONDS,
  }), 'jornada.derivar.procesar_lote');
  if (error) return { filas: [], error: error.message };
  return { filas: (data ?? []) as unknown as ResultadoLote[], error: null };
}

/**
 * Corre la derivación sobre la ventana.
 *
 * ── EL RELOJ (patrón del PR #152 / ESC-3) ────────────────────────────────
 *
 * `venceEn` es el `Date.now()` a partir del cual la corrida deja de tomar
 * trabajo NUEVO. El corte va ANTES de tocar un par (operador, día), nunca a
 * medias: lo que no alcanzó queda intacto y la corrida siguiente lo encabeza.
 *
 * Y LO DICE. `cortadosPorReloj` viaja en el resultado y el cron lo pone en la
 * respuesta HTTP, no solo en el log. El runner de producción ya murió mudo dos
 * veces por un motor que se quedaba sin turno sin que nadie se enterara: una
 * corrida que no termina su trabajo y contesta 200 es un cron verde que miente.
 */
export async function derivarJornadas(args: {
  ahora?: Date;
  venceEn?: number;
  dias?: number;
} = {}): Promise<ResultadoDerivacion> {
  const ahora = args.ahora ?? new Date();
  const dias = args.dias ?? DIAS_QUE_BARRE;
  const hasta = diaEnZona(ahora, 'America/Mexico_City');
  const desde = diaEnZona(new Date(ahora.getTime() - (dias - 1) * 86_400_000), 'America/Mexico_City');

  const r: ResultadoDerivacion = {
    revisados: 0, asentados: 0, yaEstaban: 0, fallos: [], cortadosPorReloj: 0,
    diasSinGps: 0, listaTruncada: false, sinAvisoPrevio: 0,
  };

  const { trabajos, truncada, owner, error } = await listaDeTrabajo(ahora, dias);
  if (error) {
    // Fallar cerrado y DECIRLO: sin la lista de trabajo no hay nada que
    // derivar, y devolver un resultado en ceros se leería como «no había nada
    // que hacer». Lanza para que el cron pinte rojo.
    throw new Error(`derivarJornadas: no se pudo leer la lista de trabajo: ${error}`);
  }
  r.revisados = trabajos.length;
  r.listaTruncada = truncada;
  if (truncada) {
    // WARN, no info: es una corrida que NO barrió su ventana. El cron la pinta
    // `parcial` para que no salga verde una pasada que dejó días sin derivar.
    logger.warn('jornada.derivar.lista_truncada', {
      tope: TOPE_VIAJES_POR_CORRIDA, desde, hasta,
    });
  }

  const intentables: Trabajo[] = [];
  for (const t of trabajos) {
    if (args.venceEn !== undefined && Date.now() >= args.venceEn) break;
    intentables.push(t);
  }
  const intentados = intentables.length;
  r.cortadosPorReloj = trabajos.length - intentados;
  if (r.cortadosPorReloj > 0) {
    logger.warn('jornada.derivar.corte_por_reloj', { pendientes: r.cortadosPorReloj, desde, hasta });
  }

  try {
    for (let i = 0; i < intentables.length; i += TAMANO_LOTE_PROCESO) {
      const lote = intentables.slice(i, i + TAMANO_LOTE_PROCESO);
      const procesado = await procesarLote(owner, lote);
      if (procesado.error) {
        // Respuesta ambigua: no liberar. Si Postgres sí confirmó, ya quedó ACK;
        // si no, el lease recupera. Reintentar aquí abriría doble escritor.
        for (const t of lote) r.fallos.push(`ack ${t.operadorId}/${t.dia}: ${procesado.error}`);
        continue;
      }
      const recibidos = new Set<string>();
      for (const fila of procesado.filas) {
        recibidos.add(String(fila.claim_token));
        r.asentados += Number(fila.asentados) || 0;
        r.yaEstaban += Number(fila.ya_estaban) || 0;
        if (fila.dia_sin_gps) r.diasSinGps++;
        if (fila.sin_aviso) r.sinAvisoPrevio++;
        else if (!fila.exito || fila.error) r.fallos.push(`trabajo ${fila.claim_token}: ${fila.error ?? 'fallo sin detalle'}`);
      }
      for (const t of lote) {
        if (!recibidos.has(t.claimToken)) {
          r.fallos.push(`ack ${t.operadorId}/${t.dia}: claim perdido o lease vencido`);
        }
      }
    }
  } finally {
    const noIntentados = trabajos.slice(intentados);
    if (!(await liberarNoIntentados(owner, noIntentados))) {
      r.fallos.push(`liberación: no se liberaron ${noIntentados.length} claim(s) no intentados; el lease los recuperará`);
    }
  }

  return r;
}
