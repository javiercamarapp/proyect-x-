// ═══════════════════════════════════════════════════════════════════════════
// EL DRENADO DE LA BANDEJA — vive fuera del `route.ts` a propósito.
//
// Next.js solo admite sus propios exports en un route handler (`GET`,
// `runtime`, `maxDuration`…): cualquier otro rompe el TYPECHECK del build,
// no el lint, así que se descubre tarde. `cola/route.ts` (la vuelta por
// QStash) necesita esta función y sus constantes, de modo que tienen que ser
// importables desde otro módulo.
// ═══════════════════════════════════════════════════════════════════════════

import { Client as QstashClient } from '@upstash/qstash';
import { processInbound, type ResultadoInbound } from '@/lib/likida/processor';
import {
  pendientesPorDrenar, reclamarPendiente, marcarPendienteProcesado,
  anotarFalloPendiente, devolverIntentoPendiente, cartasMuertas,
  crearLeaseOwner, iniciarRenovacionLease, iniciarCadenaWa, renovarCadenaWa,
  finalizarCadenaWa,
} from '@/lib/likida/wa_pendientes';
import { conPool } from '@/lib/likida/lotes';
import { logger } from '@/lib/logger';
import { appUrl } from '@/lib/env';
import { codigoDeError } from '@/lib/observability/sentry';
import { registrarLatido } from '@/lib/admin/salud';
import { alertarOperador } from '@/lib/observability/alerta';

/** Mensajes por vuelta. 40 × 5 en vuelo entra de sobra en los 120 s. */
export const LOTE = 40;
/** Cuántos mensajes se procesan a la vez. Cinco: el techo lo pone el pool de
 *  PostgREST y el rate limit de Meta, no el CPU. */
export const ANCHO_POOL = 5;
/** Techo de generaciones QStash por cadena (hasta 40 × 20 = 800 mensajes
 * listados). No promete un minuto: cada generación espera el procesamiento de
 * la anterior y su duración depende del OCR/proveedor. */
export const MAX_VUELTAS_QSTASH = 20;

/** Los resultados de `processInbound` que dejan la fila SIN sellar. Local a
 *  propósito: la prueba de esta ruta mockea el processor entero, y `undefined`
 *  (el contrato viejo de `void`) cuenta como hecho. */
function quedoPendiente(r: ResultadoInbound | undefined): boolean {
  return r === 'sin_tiempo' || r === 'en_curso' || r === 'reintentable';
}

export interface ResultadoDrenado {
  procesados: number;
  fallidos: number;
  pospuestos: number;
  /** Claims que ESTA invocación ganó. A diferencia de `tomados`, no cuenta
   * filas que otro cron ya tenía arrendadas. */
  reclamados: number;
  /** Hay por lo menos una fila elegible DESPUÉS de terminar esta vuelta. */
  backlogDespues: boolean;
  /** Quién conserva la responsabilidad de continuar. Evita que `false`
   * disfrace como bandeja vacía la falta de token o el tope de generación. */
  continuacion: 'sin_claims' | 'sin_backlog' | 'cron' | 'tope' | 'encolada' |
    'cadena_activa' | 'cadena_obsoleta' | 'publicacion_fallida';
  cartasMuertas: number;
  /** El messageId de la vuelta que quedó encolada en QStash, si la hubo. */
  encolado?: string;
  error?: string;
}

/**
 * Drena UNA vuelta de la bandeja. La comparten el cron (cada minuto) y el
 * callback de QStash (`cola/route.ts`), que es quien encadena las vueltas
 * mientras el lote salga lleno.
 *
 * `vuelta` es el número de vueltas encadenadas que YA se hicieron en esta
 * cadena: al llegar a `MAX_VUELTAS_QSTASH` deja de reencolar y el cron del
 * minuto siguiente retoma.
 */
export async function drenarBandeja(
  inicioInvocacion: number,
  req: Request,
  vuelta = 0,
  cadenaId?: string,
): Promise<ResultadoDrenado> {
  let procesados = 0;
  let fallidos = 0;
  let pospuestos = 0;
  let huboFalloDeCron = false;
  let tomados = 0;
  let reclamados = 0;
  let backlogDespues = false;
  let encolado: string | undefined;
  let continuacion: ResultadoDrenado['continuacion'] = 'sin_claims';
  const leaseOwner = crearLeaseOwner('wa-cron');
  try {
    // Un callback sólo puede trabajar mientras conserve el fence de SU cadena.
    // Si el lease venció y otro cron abrió una nueva, este callback es viejo:
    // 200 sin efectos para que QStash no lo insista.
    if (vuelta > 0 && (!cadenaId || !(await renovarCadenaWa(cadenaId)))) {
      logger.warn('cron.wa_pendientes.cadena_obsoleta', { vuelta, cadenaId: cadenaId ?? null });
      await registrarLatido('wa-pendientes', 'parcial', { vuelta, continuacion: 'cadena_obsoleta' });
      return {
        procesados, fallidos, pospuestos, reclamados, backlogDespues,
        cartasMuertas: 0, continuacion: 'cadena_obsoleta',
      };
    }

    const lote = await pendientesPorDrenar(LOTE);
    tomados = lote.length;

    // ── EN PARALELO POR CHOFER, EN SERIE DENTRO DE CADA CHOFER (ESC-1) ────
    // El orden de llegada importa DENTRO de una conversación (la caption que
    // completa la foto anterior, el "listo" que cierra); entre conversaciones
    // distintas no importa nada. Agrupar por remitente es lo que permite
    // multiplicar el caudal sin romper esa garantía.
    const porChofer = new Map<string, typeof lote>();
    for (const p of lote) {
      const cadena = porChofer.get(p.remitente) ?? [];
      cadena.push(p);
      porChofer.set(p.remitente, cadena);
    }

    await conPool([...porChofer.values()], ANCHO_POOL, async (cadena) => {
      // AGEN-19C2-1 (corrección tras auditoría Fable-5 post-merge del
      // PR #72): el drenado también agrupa por chofer (ESC-1), así que
      // también necesita decirle a `processInbound` si hay otra FOTO
      // antes/después en la cadena — sin esto, un fajo que cae al cron
      // (recuperación, no el camino feliz) seguía produciendo un acuse por
      // foto en vez del resumen consolidado. `p.tipo` viene de la 0194.
      for (const [posicion, p] of cadena.entries()) {
        const hayFotoAntesEnCadena = cadena.slice(0, posicion).some((x) => x.tipo === 'image');
        const hayFotoDespuesEnCadena = cadena.slice(posicion + 1).some((x) => x.tipo === 'image');
        const claim = await reclamarPendiente(p.id, p.intentos, leaseOwner);
        if (!claim) {
          // Otra corrida tomó un mensaje ANTERIOR de esta conversación. Seguir
          // con el siguiente permitiría que dos invocaciones solapadas
          // procesaran a2 mientras la otra todavía trabaja a1, rompiendo el
          // orden por chofer que este agrupamiento promete. La cadena se retoma
          // completa en la siguiente vuelta; otros choferes siguen en paralelo.
          break;
        }
        reclamados++;
        const detenerRenovacion = claim.leaseToken && claim.leaseOwner
          ? iniciarRenovacionLease(claim.id, claim.leaseToken, claim.leaseOwner)
          : () => {};
        try {
          // El reloj es el de ESTA invocación, compartido por todo el lote
          // (auditoría 18, C4): el mensaje 7 pide lo que queda, no 120s nuevos.
          const resultado = await processInbound(claim.evento, {
            inicioInvocacionMs: inicioInvocacion,
            hayFotoAntesEnCadena,
            hayFotoDespuesEnCadena,
          });
          if (quedoPendiente(resultado)) {
            // NO SE SELLA (A3/A27): el motor no lo terminó — sin presupuesto,
            // en vuelo en otra invocación, o abandonado por un fallo nuestro.
            // La fila sigue pendiente y la siguiente corrida la vuelve a tomar.
            pospuestos++;
            logger.warn('cron.wa_pendientes.pospuesto', { id: claim.id, intento: claim.intentos, resultado });
            if (resultado === 'sin_tiempo') {
              // ESC-1: quedarse sin presupuesto NO es un intento fallido — el
              // mensaje ni se miró. Contarlo convertía en carta muerta, a las
              // cinco corridas cargadas, una foto que nadie llegó a procesar.
              // El resto de los pospuestos SÍ consumen: ahí el motor trabajó.
              if (claim.leaseToken && claim.leaseOwner) await devolverIntentoPendiente(claim.id, claim.intentos, claim.leaseToken, claim.leaseOwner);
              else await devolverIntentoPendiente(claim.id, claim.intentos);
              // Sin presupuesto para este mensaje tampoco lo hay para el
              // siguiente de la cadena: se corta y la vuelta siguiente sigue.
              return;
            }
            if (claim.leaseToken && claim.leaseOwner) await anotarFalloPendiente(claim.id, `pospuesto: ${resultado}`, claim.leaseToken, claim.leaseOwner);
            else await anotarFalloPendiente(claim.id, `pospuesto: ${resultado}`);
            // Un mensaje no terminado bloquea los posteriores de la misma
            // conversación. Procesar el siguiente rompería el orden por chofer.
            break;
          }
          const sellado = claim.leaseToken && claim.leaseOwner
            ? await marcarPendienteProcesado(claim.id, claim.leaseToken, claim.leaseOwner)
            : await marcarPendienteProcesado(claim.id);
          // undefined mantiene compatibilidad con mocks/implementaciones
          // antiguas; false significa fencing perdido o fallo de DB.
          if (sellado === false) {
            pospuestos++;
            break;
          }
          procesados++;
        } catch (e) {
          fallidos++;
          const err = e instanceof Error ? e.message : String(e);
          logger.error('cron.wa_pendientes.evento_fallo', { id: claim.id, intento: claim.intentos, err });
          if (claim.leaseToken && claim.leaseOwner) await anotarFalloPendiente(claim.id, err, claim.leaseToken, claim.leaseOwner);
          else await anotarFalloPendiente(claim.id, err);
          break;
        }
        finally {
          detenerRenovacion();
        }
      }
    });

    // ── EL AUTO-REENCOLADO (capacidad 800) ────────────────────────────────
    // La longitud del LISTADO no demuestra backlog: dos crons superpuestos
    // pueden ver las mismas 40 filas, uno gana los claims y el perdedor veía
    // igualmente `tomados = 40`. Antes, cada perdedor publicaba otra cadena y
    // multiplicaba callbacks sin haber hecho trabajo. Solo quien ganó por lo
    // menos un claim puede encadenar, y antes vuelve a preguntar por trabajo
    // ELEGIBLE. El cron del minuto siguiente sigue siendo el fallback durable.
    if (reclamados > 0) {
      backlogDespues = (await pendientesPorDrenar(1)).length > 0;
      if (backlogDespues) {
        if (!process.env.UPSTASH_QSTASH_TOKEN) {
          continuacion = 'cron';
          if (cadenaId) await finalizarCadenaWa(cadenaId);
        } else if (vuelta >= MAX_VUELTAS_QSTASH) {
          continuacion = 'tope';
          logger.error('cron.wa_pendientes.tope_con_backlog', { vuelta, reclamados });
          await alertarOperador('cron.wa_pendientes', {
            error: `La cadena alcanzó ${MAX_VUELTAS_QSTASH} vueltas y todavía hay mensajes elegibles`,
            codigo: 'tope_cadena_con_backlog',
          });
          if (cadenaId) await finalizarCadenaWa(cadenaId);
        } else {
          let cadenaParaPublicar = cadenaId;
          if (vuelta === 0) {
            cadenaParaPublicar = await iniciarCadenaWa() ?? undefined;
            if (!cadenaParaPublicar) continuacion = 'cadena_activa';
          }
          if (cadenaParaPublicar) {
            encolado = await encolarOtraVuelta(req, vuelta + 1, cadenaParaPublicar);
            continuacion = encolado ? 'encolada' : 'publicacion_fallida';
            // Un timeout es ambiguo: QStash pudo aceptar antes de perderse la
            // respuesta. Conservar el lease evita que el cron siguiente abra
            // otra generación mientras aquel callback puede estar en vuelo.
            // Si de verdad no se publicó, la recuperación queda acotada al
            // vencimiento del lease; nunca se pierde el backlog durable.
          }
        }
      } else {
        continuacion = 'sin_backlog';
        if (cadenaId) await finalizarCadenaWa(cadenaId);
      }
    } else if (cadenaId) {
      await finalizarCadenaWa(cadenaId);
    }

    // Las cartas muertas se GRITAN al operador: un mensaje de un chofer que
    // cinco intentos no pudieron procesar necesita ojos humanos, no otra
    // vuelta del cron.
    const muertas = await cartasMuertas();
    if (muertas > 0) {
      logger.error('cron.wa_pendientes.cartas_muertas', { muertas });
      await alertarOperador('cron.wa_pendientes', { error: `${muertas} mensaje(s) de WhatsApp agotaron sus reintentos en la bandeja del apagado`, codigo: 'cartas_muertas' });
    }
    // AUDITORÍA 24, BE-14: `pospuestos` no era del latido. Un lote de 40 fotos
    // donde la primera se come el presupuesto y 39 vuelven `sin_tiempo` latía
    // `ok` (procesados=0, fallidos=0) y la bandeja crecía minuto a minuto con
    // el tablero en verde. Lo pospuesto es trabajo que quedó: `parcial`,
    // como gps/jornada/facturar/runner en su corte.
    const estado = fallidos > 0 ? 'fallo'
      : muertas > 0 || pospuestos > 0 || (backlogDespues && continuacion !== 'encolada') ? 'parcial'
        : 'ok';
    await registrarLatido('wa-pendientes', estado, { procesados, fallidos, pospuestos, cartasMuertas: muertas, vuelta, backlogDespues, continuacion });
    return { procesados, fallidos, pospuestos, reclamados, backlogDespues, cartasMuertas: muertas, continuacion, encolado };
  } catch (e) {
    huboFalloDeCron = true;
    const error = e instanceof Error ? e.message : String(e);
    const codigo = codigoDeError(e);
    logger.error('cron.wa_pendientes.falló', { error, codigo });
    await alertarOperador('cron.wa_pendientes', { error, codigo });
    await registrarLatido('wa-pendientes', 'fallo', { codigo });
    return { procesados, fallidos, pospuestos, reclamados, backlogDespues, cartasMuertas: 0, continuacion, error };
  } finally {
    if (!huboFalloDeCron && (procesados > 0 || fallidos > 0 || pospuestos > 0)) {
      logger.info('cron.wa_pendientes.ok', { procesados, fallidos, pospuestos, tomados, vuelta });
    }
  }
}

/**
 * Encola la vuelta siguiente en QStash. Best-effort A PROPÓSITO: si no se
 * puede encolar, el cron del minuto siguiente toma exactamente el mismo lote
 * (nada se marcó de más), así que un QStash caído baja el caudal pero no
 * pierde un solo mensaje. Por eso no lanza ni cuenta como fallo.
 */
async function encolarOtraVuelta(req: Request, vuelta: number, cadenaId: string): Promise<string | undefined> {
  const token = process.env.UPSTASH_QSTASH_TOKEN;
  if (!token) return undefined;
  try {
    const q = new QstashClient({ token, baseUrl: process.env.QSTASH_URL ?? undefined });
    // `appUrl()` es el ÚNICO accesor de la URL base (env.ts, guardia A2); el
    // host de la petición queda de red de seguridad para un preview sin env.
    const base = appUrl() || `https://${req.headers.get('host')}`;
    const { messageId } = await q.publishJSON({
      url: `${base}/api/cron/wa-pendientes/cola`,
      body: { vuelta, cadenaId },
      // Sin reintentos: la bandeja es durable y el cron del minuto siguiente
      // ES el reintento. Insistir aquí solo duplicaría trabajo en vuelo.
      retries: 0,
      timeout: 120,
      // Vercel Cron y QStash son at-least-once. Todas las invocaciones del
      // mismo minuto comparten cadena; dos ganadores concurrentes pueden ver
      // backlog, pero QStash conserva una sola generación.
      deduplicationId: `wa-pendientes-${cadenaId}-${vuelta}`,
    });
    logger.info('cron.wa_pendientes.encolado', { messageId, vuelta });
    return messageId;
  } catch (e) {
    logger.warn('cron.wa_pendientes.encolado_fallo', { vuelta, err: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
}
