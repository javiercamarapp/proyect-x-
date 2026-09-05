// ═══════════════════════════════════════════════════════════════════════════
// LA BANDEJA DURABLE DEL WEBHOOK (`wa_evento_pendiente`, 0119).
//
// P1 de la auditoría externa (16-ago-2026): el webhook acusa 200 y DESPUÉS
// mira el kill switch — apagado, el mensaje se tiraba, y Meta no reintenta
// lo acusado. Este módulo convierte "apagado" en "pausado y durable":
//
//   webhook (apagado) → guardarEventosPendientes → 200 honesto
//   cron wa-pendientes (encendido) → reclamar → processInbound → marcar
//
// EL CLAIM ES UN UPDATE ANCLADO (patrón reclamarEscalacion): dos corridas
// del cron solapadas no procesan el mismo evento dos veces — y aunque lo
// hicieran, `claimMessage` (0002) aguas abajo deduplica por wamid. El
// intento se anota EN el claim: un evento que revienta el proceso ya quedó
// contado, y al tope se vuelve carta muerta visible, jamás borrada.
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { acotada } from './presupuesto';
import type { InboundMessage } from './processor';

/** Al tope de intentos la fila deja de reclamarse: carta muerta VISIBLE con
 *  su ultimo_error. 5 corridas del cron son ~25 min de reintentos. */
export const MAX_INTENTOS_PENDIENTE = 5;
export const WA_LEASE_SECONDS = 180;
export const WA_LEASE_RENEW_EVERY_MS = 60_000;
export const WA_CADENA_LEASE_SECONDS = 180;

export function crearLeaseOwner(prefijo: string): string {
  return `${prefijo}:${randomUUID()}`;
}

/** Abre la única cadena de fan-out WA. `null` significa que otro cron ya
 * mantiene una cadena viva; es control de concurrencia, no un error. */
export async function iniciarCadenaWa(): Promise<string | null> {
  const { data, error } = await acotada(supabaseAdmin().rpc('iniciar_cadena_wa', {
    p_lease_seconds: WA_CADENA_LEASE_SECONDS,
  }), 'iniciarCadenaWa');
  if (error) throw new Error(`iniciarCadenaWa: ${error.message}`);
  const valor = Array.isArray(data) ? data[0] : data;
  return typeof valor === 'string' && valor.length > 0 ? valor : null;
}

/** Renueva y valida el fence de una cadena recibida de QStash. */
export async function renovarCadenaWa(cadenaId: string): Promise<boolean> {
  try {
    const { data, error } = await acotada(supabaseAdmin().rpc('renovar_cadena_wa', {
      p_cadena_id: cadenaId,
      p_lease_seconds: WA_CADENA_LEASE_SECONDS,
    }), 'renovarCadenaWa');
    if (error) throw error;
    return data === true || (Array.isArray(data) && data[0] === true);
  } catch (e) {
    logger.warn('wa.cadena_no_renovada', { cadenaId, err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/** Libera la cadena sólo si el UUID sigue siendo el vigente (fencing). */
export async function finalizarCadenaWa(cadenaId: string): Promise<boolean> {
  try {
    const { data, error } = await acotada(supabaseAdmin().rpc('finalizar_cadena_wa', {
      p_cadena_id: cadenaId,
    }), 'finalizarCadenaWa');
    if (error) throw error;
    const ok = data === true || (Array.isArray(data) && data[0] === true);
    if (!ok) logger.warn('wa.cadena_final_fenced', { cadenaId });
    return ok;
  } catch (e) {
    logger.warn('wa.cadena_no_finalizada', { cadenaId, err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/**
 * Persiste los mensajes de una invocación ANTES del acuse a Meta. NUNCA
 * lanza: el llamador decide (503 si algo no se guardó, para que Meta
 * reentregue). Un insert fallido ES pérdida potencial y por eso se GRITA con
 * los ids completos: el log es lo único que queda para reconstruir a mano.
 *
 * UN SOLO VIAJE DE RED, con techo (auditoría 18, M22 + A23): esto corre en la
 * ruta SÍNCRONA, antes del 200. Antes era un insert por mensaje, en serie y
 * sin `acotada`: 22 fotos = 22 viajes (6.6s) antes de contestarle a Meta, y
 * uno colgado sin techo se llevaba la invocación entera. Ahora es un upsert
 * del lote con `ignoreDuplicates` (ON CONFLICT DO NOTHING sobre la PK = wamid:
 * la reentrega de Meta no es pérdida, es el dedup haciendo su trabajo) y el
 * tope de `TOPE_CONSULTA_MS`. Si el lote falla, fallan todos — y el webhook
 * contesta 503 para que Meta reentregue el POST completo.
 */
export async function guardarEventosPendientes(mensajes: InboundMessage[]): Promise<{
  guardados: number;
  fallidos: number;
  /** Cada mensaje con el id de SU fila durable (o `guardado: false`) — el
   *  inbox general (16-ago-2026) procesa reclamando por este id. */
  filas: Array<{ id: string; evento: InboundMessage; guardado: boolean }>;
}> {
  if (mensajes.length === 0) return { guardados: 0, fallidos: 0, filas: [] };
  // Sin wamid (no debería pasar en mensajes reales) se fabrica un id
  // determinista-ish para no perder el evento por falta de llave.
  const lote = mensajes.map((m, i) => ({ id: m.waMessageId ?? `sin-wamid:${m.from}:${Date.now()}:${i}`, evento: m }));
  try {
    const { error } = await acotada(supabaseAdmin()
      .from('wa_evento_pendiente')
      .upsert(lote, { onConflict: 'id', ignoreDuplicates: true }), 'guardarEventosPendientes');
    if (error) {
      logger.error('wa.pendiente_no_guardado', { ids: lote.map((f) => f.id), err: error.message });
      return { guardados: 0, fallidos: lote.length, filas: lote.map((f) => ({ ...f, guardado: false })) };
    }
    return { guardados: lote.length, fallidos: 0, filas: lote.map((f) => ({ ...f, guardado: true })) };
  } catch (e) {
    logger.error('wa.pendiente_no_guardado', { ids: lote.map((f) => f.id), err: e instanceof Error ? e.message : String(e) });
    return { guardados: 0, fallidos: lote.length, filas: lote.map((f) => ({ ...f, guardado: false })) };
  }
}

/**
 * ¿CUÁLES DE ESTOS WAMIDS YA ESTÁN EN LA BANDEJA? (DAT-34)
 *
 * El rate limit del webhook corría ANTES de cualquier deduplicación, y eso
 * convertía el arreglo del 4-ago —aplazar en vez de descartar— en una trampa:
 *
 *   1. llega un POST con 45 mensajes; caben 40, se contesta 429 y los 5
 *      restantes quedan para la reentrega;
 *   2. Meta reentrega el POST COMPLETO (así funciona: el payload entero, no el
 *      resto), y los 40 que ya están guardados vuelven a gastar los 40 cupos de
 *      la ventana;
 *   3. los 5 nuevos vuelven a diferirse. Y otra vez. Cada reentrega repite el
 *      ciclo hasta que Meta se rinde, y ahí sí se pierden.
 *
 * Un mensaje que YA está en `wa_evento_pendiente` no cuesta trabajo nuevo: su
 * fila existe, el cron la va a drenar, y el `claimMessage` del motor lo trata
 * como duplicado. Cobrarle cupo a lo ya guardado es cobrarle dos veces por el
 * mismo mensaje, y el que paga la cuenta es el comprobante nuevo.
 *
 * FAIL-OPEN: ante un error de lectura devuelve el conjunto VACÍO, o sea que el
 * límite se aplica a todos, como antes. No poder deduplicar no puede convertir
 * el techo en un permiso ilimitado — es la única dirección segura de fallar en
 * un limitador.
 */
export async function pendientesYaConocidos(ids: string[]): Promise<Set<string>> {
  const limpios = ids.filter(Boolean);
  if (limpios.length === 0) return new Set();
  const { data, error } = await acotada(supabaseAdmin()
    .from('wa_evento_pendiente')
    .select('id')
    .in('id', limpios), 'pendientesYaConocidos');
  if (error) {
    logger.warn('wa.dedup_previo_falló', { err: error.message, cuantos: limpios.length });
    return new Set();
  }
  return new Set((data ?? []).map((f) => String((f as { id: unknown }).id)));
}

export interface PendienteReclamado {
  id: string;
  evento: InboundMessage;
  intentos: number;
  leaseToken: string;
  leaseOwner: string;
}

/**
 * Los pendientes listos para drenar, en orden de llegada. LANZA ante error
 * de lectura: el cron debe reportar 500, no "no había nada".
 *
 * Trae `remitente` (el `from` del evento) porque el drenado paraleliza POR
 * CHOFER (ESC-1): los mensajes de una misma persona se procesan en serie —una
 * caption completa la foto anterior— y los de personas distintas, a la vez.
 *
 * Trae también `tipo` (mig. 0194, AGEN-19C2-1 corregido): el drenado necesita
 * saber cuáles mensajes de la cadena de un chofer son FOTOS para poder
 * armar `hayFotoAntesEnCadena`/`hayFotoDespuesEnCadena` — sin esto el fajo
 * que cae al cron (recuperación tras `sin_tiempo`, un claim perdido, la
 * bandeja apagada un rato) seguía produciendo un acuse por foto en vez de
 * un resumen, aunque el camino en vivo (route.ts) ya estuviera arreglado.
 */
export async function pendientesPorDrenar(limite = 10): Promise<Array<{ id: string; intentos: number; remitente: string; tipo: string }>> {
  const seguro = Math.max(1, Math.min(200, Math.floor(limite)));
  const { data, error } = await acotada(supabaseAdmin().rpc('listar_wa_pendientes', {
    p_limite: seguro,
  }), 'pendientesPorDrenar');
  if (error) throw new Error(`pendientesPorDrenar: ${error.message}`);
  return ((data ?? []) as Array<{ id: string; intentos: number; remitente?: string; tipo?: string }>).map((f) => ({
    id: String(f.id),
    intentos: Number(f.intentos),
    remitente: typeof f.remitente === 'string' && f.remitente ? f.remitente : String(f.id),
    tipo: typeof f.tipo === 'string' ? f.tipo : 'other',
  }));
}

/**
 * Reclama UN evento para esta corrida: anota el intento y devuelve el
 * evento SOLO si esta llamada ganó (cero filas = otra corrida lo tomó o ya
 * se procesó — no es error). El intento viaja EN el claim: si el proceso
 * revienta a media corrida, el conteo ya quedó.
 */
export async function reclamarPendiente(
  id: string,
  intentosLeidos: number,
  leaseOwner = crearLeaseOwner('wa-inline'),
): Promise<PendienteReclamado | null> {
  const { data, error } = await acotada(supabaseAdmin().rpc('reclamar_wa_pendiente', {
    p_id: id,
    p_intentos: intentosLeidos,
    p_owner: leaseOwner,
    p_lease_seconds: WA_LEASE_SECONDS,
  }), 'reclamarPendiente');
  if (error) throw new Error(`reclamarPendiente: ${error.message}`);
  const fila = (Array.isArray(data) ? data : data ? [data] : [])[0] as {
    id: string; evento: InboundMessage; intentos: number; claim_token: string;
  } | undefined;
  return fila ? {
    id: String(fila.id), evento: fila.evento, intentos: Number(fila.intentos),
    leaseToken: String(fila.claim_token), leaseOwner,
  } : null;
}

/** Sella el evento como procesado. Best-effort CON GRITO: el mensaje ya se
 *  procesó — si el sello falla, el reintento del cron rebotará aguas abajo
 *  en claimMessage (0002), no duplicará gastos. */
export async function marcarPendienteProcesado(id: string, leaseToken?: string, leaseOwner?: string): Promise<boolean> {
  if (!leaseToken || !leaseOwner) {
    logger.warn('wa.pendiente_sin_token', { id, operacion: 'complete' });
    return false;
  }
  try {
    const { data, error } = await acotada(supabaseAdmin().rpc('completar_wa_pendiente', {
      p_id: id, p_claim_token: leaseToken, p_owner: leaseOwner,
    }), 'marcarPendienteProcesado');
    if (error) throw error;
    const ok = data === true || (Array.isArray(data) && data[0] === true);
    if (!ok) logger.warn('wa.pendiente_sello_fenced', { id });
    return ok;
  } catch (e) {
    logger.error('wa.pendiente_sin_sellar', { id, err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/**
 * DEVUELVE el intento que este claim consumió (ESC-1).
 *
 * `sin_tiempo` significa que la invocación se quedó sin presupuesto ANTES de
 * empezar: el mensaje no se intentó, no falló. Contarlo como intento hacía que
 * cinco corridas cargadas convirtieran en CARTA MUERTA —visible, con su
 * `ultimo_error`, y jamás procesada— la foto de un chofer que nadie llegó a
 * mirar. El intento se devuelve anclado (`eq('intentos', …)`): si otra corrida
 * ya lo reclamó de nuevo, esta no le resta nada.
 */
export async function devolverIntentoPendiente(id: string, intentosDelClaim: number, leaseToken?: string, leaseOwner?: string): Promise<void> {
  if (!leaseToken || !leaseOwner) {
    logger.warn('wa.pendiente_sin_token', { id, operacion: 'requeue' });
    return;
  }
  try {
    const { data, error } = await acotada(supabaseAdmin().rpc('fallar_wa_pendiente', {
      p_id: id, p_claim_token: leaseToken, p_owner: leaseOwner,
      p_error: null, p_devolver_intento: true,
    }), 'devolverIntentoPendiente');
    if (error) throw error;
    if (data !== true && !(Array.isArray(data) && data[0] === true)) logger.warn('wa.pendiente_requeue_fenced', { id, intentosDelClaim });
  } catch (e) {
    logger.warn('wa.pendiente_intento_no_devuelto', { id, err: e instanceof Error ? e.message : String(e) });
  }
}

/** Anota y libera el fallo del intento, condicionado al token vigente. */
export async function anotarFalloPendiente(id: string, err: string, leaseToken?: string, leaseOwner?: string): Promise<void> {
  if (!leaseToken || !leaseOwner) {
    logger.warn('wa.pendiente_sin_token', { id, operacion: 'fail' });
    return;
  }
  try {
    const { data, error } = await acotada(supabaseAdmin().rpc('fallar_wa_pendiente', {
      p_id: id, p_claim_token: leaseToken, p_owner: leaseOwner,
      p_error: err.slice(0, 500), p_devolver_intento: false,
    }), 'anotarFalloPendiente');
    if (error) throw error;
    if (data !== true && !(Array.isArray(data) && data[0] === true)) logger.warn('wa.pendiente_fallo_fenced', { id });
  } catch (e) {
    logger.warn('wa.pendiente_fallo_sin_anotar', { id, err: e instanceof Error ? e.message : String(e) });
  }
}

export async function renovarLeasePendiente(id: string, leaseToken: string, leaseOwner: string): Promise<boolean> {
  try {
    const { data, error } = await acotada(supabaseAdmin().rpc('renovar_wa_pendiente', {
      p_id: id, p_claim_token: leaseToken, p_owner: leaseOwner,
      p_lease_seconds: WA_LEASE_SECONDS,
    }), 'renovarLeasePendiente');
    if (error) throw error;
    return data === true || (Array.isArray(data) && data[0] === true);
  } catch (e) {
    logger.warn('wa.pendiente_lease_no_renovado', { id, err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/** Heartbeat best-effort para OCR/LLM largos; el fence final sigue siendo
 * obligatorio aunque una renovación falle. */
export function iniciarRenovacionLease(id: string, leaseToken: string, leaseOwner: string): () => void {
  let enVuelo = false;
  const timer = setInterval(() => {
    if (enVuelo) return;
    enVuelo = true;
    void renovarLeasePendiente(id, leaseToken, leaseOwner).finally(() => { enVuelo = false; });
  }, WA_LEASE_RENEW_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Cuántas cartas muertas hay (al tope de intentos, sin procesar) — para la
 *  bandeja de escalaciones y el reporte del cron. LANZA ante error. */
export async function cartasMuertas(): Promise<number> {
  const { count, error } = await acotada(supabaseAdmin()
    .from('wa_evento_pendiente')
    .select('id', { count: 'exact', head: true })
    .is('procesado_en', null)
    .gte('intentos', MAX_INTENTOS_PENDIENTE), 'cartasMuertas');
  if (error) throw new Error(`cartasMuertas: ${error.message}`);
  if (typeof count !== 'number') throw new Error('cartasMuertas: la base no devolvió el conteo');
  return count;
}
