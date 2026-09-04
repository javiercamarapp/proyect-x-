import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { inicioDiaMx, finDiaMx } from '@/lib/formato';
import { acotada } from '../presupuesto';
import { asegurarDiaJornada, asentarMarca, diaMxDe } from './repo';
// AUDITORÍA 24, LEG-1: la compuerta vive en privacidad.ts y la comparten
// jornada, poller de GPS y poller de cámara.
import { tieneAvisoPrevio } from '../privacidad';

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
// ── Y POR QUÉ LA DECLARACIÓN LE GANA SIN UN SOLO `if` ────────────────────
//
// El índice `jornada_asiento_marca_unica` (0241) admite UN inicio y UN fin
// vivos por día. Si el operador ya declaró el suyo, el insert derivado rebota
// con 23505 y `asentarMarca` devuelve `ya_estaba`. La precedencia es una
// restricción de la base, no una comparación en este archivo.
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
  dia: string;
  /** El instante de `aceptado_en` si cae en este día. */
  aceptadoEn: string | null;
  viajeId: string;
  claimToken: string;
}

/**
 * Arma la lista de trabajo: un renglón por (operador, día) tocado por un viaje
 * de la ventana.
 *
 * La RPC 0319 sincroniza `viaje`, deduplica por expediente y reclama con
 * `FOR UPDATE SKIP LOCKED`. El progreso se confirma por claim, después del
 * intento; un corte libera el resto y una caída se recupera al vencer el lease.
 */
async function listaDeTrabajo(
  desde: string,
  hasta: string,
): Promise<{ trabajos: Trabajo[]; truncada: boolean; owner: string; error: string | null }> {
  const owner = `jornada:${randomUUID()}`;
  const { data, error } = await acotada(
    supabaseAdmin().rpc('reclamar_jornadas_por_derivar', {
      p_desde: inicioDiaMx(desde),
      p_hasta: finDiaMx(hasta),
      p_limite: TOPE_VIAJES_POR_CORRIDA,
      p_owner: owner,
      p_lease_seconds: LEASE_JORNADA_SECONDS,
    }),
    'jornada.derivar.viajes',
  );
  if (error) return { trabajos: [], truncada: false, owner, error: error.message };

  type Fila = {
    id: string; tenant_id: string; operador_id: string;
    unidad_id: string | null; aceptado_en: string; dia: string;
    claim_token: string; hay_mas: boolean;
  };
  const filas = (data ?? []) as unknown as Fila[];
  const truncada = filas.some((f) => f.hay_mas === true);
  const trabajos: Trabajo[] = filas.map((f) => {
    // `dia` viene calculado por Postgres en America/Mexico_City. El fallback
    // mantiene compatibilidad con una respuesta vieja durante deploy.
    const dia = f.dia || diaMxDe(new Date(f.aceptado_en));
    return {
      tenantId: String(f.tenant_id),
      operadorId: String(f.operador_id),
      unidadId: f.unidad_id ? String(f.unidad_id) : null,
      dia,
      aceptadoEn: f.aceptado_en,
      viajeId: String(f.id),
      claimToken: String(f.claim_token),
    };
  });
  return { trabajos, truncada, owner, error: null };
}

async function finalizarTrabajo(
  t: Trabajo,
  owner: string,
  exito: boolean,
  error: string | null,
): Promise<boolean> {
  const { data, error: falloRpc } = await acotada(supabaseAdmin().rpc('finalizar_jornada_derivacion', {
    p_claim_token: t.claimToken,
    p_owner: owner,
    p_exito: exito,
    p_error: error,
    p_retraso_seconds: exito ? REVISITA_EXITOSA_SECONDS : REINTENTO_FALLO_SECONDS,
  }), 'jornada.derivar.finalizar');
  if (falloRpc) return false;
  return data === true || (Array.isArray(data) && data[0] === true);
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

/**
 * ¿A este operador ya se le puso el aviso de privacidad a disposición?
 *
 * AUDITORÍA 22, LEG-C1 (CRÍTICO). Fallar cerrado en los dos bordes: si la
 * lectura falla, la respuesta es NO. Un error de red no puede volverse permiso
 * para construirle a alguien un expediente laboral sin haberle avisado.
 *
 * Memoiza por corrida: la lista de trabajo trae un renglón por (operador, día)
 * y el mismo operador aparece muchas veces en la ventana.
 */
const avisoPorOperador = new Map<string, boolean>();

/** La primera y la última posición de una unidad en un día de México. */
async function extremosGps(
  tenantId: string,
  unidadId: string,
  dia: string,
): Promise<{ primera: string | null; ultima: string | null; error: string | null }> {
  const admin = supabaseAdmin();
  const desde = inicioDiaMx(dia);
  const hasta = finDiaMx(dia);
  const base = () => admin.from('posicion').select('medida_en')
    .eq('tenant_id', tenantId).eq('unidad_id', unidadId)
    .gte('medida_en', desde).lte('medida_en', hasta);

  // REN-A2: las dos consultas son INDEPENDIENTES —la primera posición del día y
  // la última— y se hacían en serie. En un bucle que ya es N+1 y con un reloj
  // de 45 s encima, cada viaje de red de más sale de la cuota de trabajos que
  // la corrida alcanza a derivar.
  const [pri, ult] = await Promise.all([
    acotada(base().order('medida_en', { ascending: true }).limit(1).maybeSingle(), 'jornada.gps.primera'),
    acotada(base().order('medida_en', { ascending: false }).limit(1).maybeSingle(), 'jornada.gps.ultima'),
  ]);
  if (pri.error) return { primera: null, ultima: null, error: pri.error.message };
  if (ult.error) return { primera: null, ultima: null, error: ult.error.message };

  return {
    primera: pri.data ? String((pri.data as { medida_en: string }).medida_en) : null,
    ultima: ult.data ? String((ult.data as { medida_en: string }).medida_en) : null,
    error: null,
  };
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
  const hasta = diaMxDe(ahora);
  const desde = diaMxDe(new Date(ahora.getTime() - (dias - 1) * 86_400_000));

  const r: ResultadoDerivacion = {
    revisados: 0, asentados: 0, yaEstaban: 0, fallos: [], cortadosPorReloj: 0,
    diasSinGps: 0, listaTruncada: false, sinAvisoPrevio: 0,
  };

  // La memo es por CORRIDA: entre una y otra el aviso pudo haberse puesto.
  avisoPorOperador.clear();

  const { trabajos, truncada, owner, error } = await listaDeTrabajo(desde, hasta);
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

  let intentados = 0;
  try {
    for (const t of trabajos) {
      if (args.venceEn !== undefined && Date.now() >= args.venceEn) {
        r.cortadosPorReloj = trabajos.length - intentados;
        logger.warn('jornada.derivar.corte_por_reloj', { pendientes: r.cortadosPorReloj, desde, hasta });
        break;
      }
      intentados++;
      const fallosAntes = r.fallos.length;
      const sinAvisoAntes = r.sinAvisoPrevio;
      try {

    // ── LEG-C1: NO SE TRATA ANTES DE AVISAR ───────────────────────────────
    // Fallar cerrado. Derivar la jornada de alguien que nunca recibió el aviso
    // es exactamente lo que el art. 16 prohíbe, y el expuesto es el operador
    // mientras la sancionable es la flota (art. 14). No se deriva y se cuenta.
    //
    // Va ANTES de `asegurarDiaJornada` a propósito: crear el expediente ya es
    // tratamiento, aunque no lleve marcas.
        if (!(await tieneAvisoPrevio(t.tenantId, t.operadorId, avisoPorOperador))) {
          r.sinAvisoPrevio++;
          continue;
        }

        const expediente = await asegurarDiaJornada(t.tenantId, t.operadorId, t.dia);
        if ('error' in expediente) {
          r.fallos.push(`expediente ${t.operadorId}/${t.dia}: ${expediente.error}`);
          continue;
        }
        const jornadaId = expediente.id;

    // ── (a) El inicio derivado del hito de aceptación del viaje ───────────
        if (t.aceptadoEn) {
          const res = await asentarMarca({
        jornadaId,
        tenantId: t.tenantId,
        tipo: 'inicio_jornada',
        momento: new Date(t.aceptadoEn),
        procedencia: 'hito_viaje',
        origenRef: `viaje:${t.viajeId}:aceptado_en`,
        viajeId: t.viajeId,
        unidadId: t.unidadId,
        detalle: { hecho: 'el operador aceptó el viaje por WhatsApp', cota: 'inferior' },
          });
          contar(r, res, `inicio hito ${t.viajeId}`);
        }

    // ── (b) Los extremos del GPS de la unidad ─────────────────────────────
        if (!t.unidadId) continue;
        const gps = await extremosGps(t.tenantId, t.unidadId, t.dia);
        if (gps.error) {
          r.fallos.push(`gps ${t.unidadId}/${t.dia}: ${gps.error}`);
          continue;
        }
        if (gps.primera === null) {
      // Se CUENTA. Que no haya posiciones no significa que no hubo jornada:
      // significa que no hubo de dónde derivarla, y el panel lo dice.
          r.diasSinGps++;
          continue;
        }

        const res1 = await asentarMarca({
      jornadaId,
      tenantId: t.tenantId,
      tipo: 'inicio_jornada',
      momento: new Date(gps.primera),
      procedencia: 'gps',
      origenRef: `gps:${t.unidadId}:${t.dia}:primera`,
      unidadId: t.unidadId,
      viajeId: t.viajeId,
      detalle: { hecho: 'primera posición de la unidad ese día', cota: 'inferior' },
        });
        contar(r, res1, `inicio gps ${t.unidadId}/${t.dia}`);

        if (gps.ultima !== null && gps.ultima !== gps.primera) {
          const res2 = await asentarMarca({
        jornadaId,
        tenantId: t.tenantId,
        tipo: 'fin_jornada',
        momento: new Date(gps.ultima),
        procedencia: 'gps',
        origenRef: `gps:${t.unidadId}:${t.dia}:ultima`,
        unidadId: t.unidadId,
        viajeId: t.viajeId,
        detalle: { hecho: 'última posición de la unidad ese día', cota: 'inferior' },
          });
          contar(r, res2, `fin gps ${t.unidadId}/${t.dia}`);
        }
      } catch (e) {
        r.fallos.push(`trabajo ${t.operadorId}/${t.dia}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        const exito = r.fallos.length === fallosAntes && r.sinAvisoPrevio === sinAvisoAntes;
        const detalle = exito ? null : r.fallos.at(-1) ?? 'aviso de privacidad pendiente';
        if (!(await finalizarTrabajo(t, owner, exito, detalle))) {
          r.fallos.push(`ack ${t.operadorId}/${t.dia}: claim perdido o base ilegible`);
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

function contar(r: ResultadoDerivacion, res: 'asentado' | 'ya_estaba' | 'fallo', etiqueta: string): void {
  if (res === 'asentado') r.asentados++;
  else if (res === 'ya_estaba') r.yaEstaban++;
  else r.fallos.push(etiqueta);
}
