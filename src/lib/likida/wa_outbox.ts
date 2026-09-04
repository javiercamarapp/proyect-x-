import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { acotada } from './presupuesto';

export interface SalidaOutbox {
  id: string;
  payload: Record<string, unknown>;
  intentos: number;
  leaseToken: string;
}

export interface SalidaOutboxDedupe {
  id: string;
  estado: 'pending' | 'sending' | 'sent' | 'dead';
  providerMessageId: string | null;
}

/** Persiste una intención de envío ANTES de tocar Meta. La llave estable
 * vuelve idempotente el reintento tras timeout/kill del proceso. */
export async function encolarSalidaWhatsAppDedupe(
  dedupeKey: string,
  payload: Record<string, unknown>,
  motivo: string,
): Promise<SalidaOutboxDedupe | null> {
  const { data, error } = await acotada(supabaseAdmin().rpc('encolar_wa_outbox_dedupe', {
    p_dedupe_key: dedupeKey,
    p_payload: payload,
    p_error: motivo.slice(0, 500),
  }), 'wa.outbox.encolar_dedupe');
  const fila = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (error || !fila || typeof fila.id !== 'string') {
    logger.error('wa.outbox_dedupe_no_encolado', { err: error?.message ?? 'respuesta inválida' });
    return null;
  }
  const estado = String(fila.estado);
  if (!['pending', 'sending', 'sent', 'dead'].includes(estado)) {
    logger.error('wa.outbox_dedupe_no_encolado', { err: 'estado inválido' });
    return null;
  }
  return {
    id: fila.id,
    estado: estado as SalidaOutboxDedupe['estado'],
    providerMessageId: fila.provider_message_id == null ? null : String(fila.provider_message_id),
  };
}

/**
 * AUDITORÍA 20 (R-1, CRÍTICO): este lease vivía en 120s mientras
 * `wa-outbox/route.ts` mide 155.5s reales y puede correr hasta los 300s de
 * su `maxDuration` — el TECHO que Vercel permite, no el promedio de hoy. Con
 * lease < techo, el cron que corre cada minuto (`vercel.json`) reclamaba las
 * mismas filas mientras la corrida anterior seguía viva y las reenviaba a un
 * teléfono real, hasta 8 veces (tope de reintentos, 0180).
 *
 * El lease tiene que sobrevivir al PEOR CASO POSIBLE (el `maxDuration` de la
 * ruta), no a la medición de hoy — el promedio ya creció una vez (60s→155.5s)
 * y puede volver a crecer. Mismo margen (1.5×) que ya usa `WA_LEASE_SECONDS`
 * en `wa_pendientes.ts` frente a su propio `maxDuration` (180 vs 120).
 * `wa_outbox.test.ts` fija este invariante contra el `maxDuration` real leído
 * de `route.ts` — si alguien baja este número, o vuelve a subir el de la
 * ruta sin ajustar este, la prueba se pone roja.
 */
export const WA_OUTBOX_LEASE_SECONDS = 450; // 1.5 × maxDuration (300) de wa-outbox/route.ts

/**
 * AUDITORÍA E.28 (H1, MEDIO): cuánto espera el PRIMER reintento de una salida
 * que se encoló porque la respuesta de Meta NUNCA LLEGÓ (timeout o socket
 * caído en `client.ts`) — no porque Meta la haya rechazado.
 *
 * LA DIFERENCIA QUE IMPORTA: un `!res.ok` (429, 5xx, lo que sea) es Meta
 * CONTESTANDO que no aceptó el mensaje — ahí no hay ambigüedad, y esas
 * salidas se encolan con `proximo_intento_en = now()` como siempre. Pero
 * cuando el `catch` de la red dispara, la petición pudo haber llegado a Meta
 * y ser aceptada IGUAL — el timeout es de ESTE lado, y WhatsApp Cloud API no
 * ofrece un idempotency-key para mensajes con el que se pueda preguntar
 * después "¿de verdad me quedaste debiendo éste?". Sin ese candado, encolar
 * con reintento INMEDIATO significa que el cron de outbox (corre cada minuto,
 * `vercel.json`) puede reenviar el ORIGINAL que Meta sí entregó, apenas
 * segundos después de que el operador ya lo recibió.
 *
 * NO SE PUEDE ELIMINAR EL REENVÍO: la alternativa —no reintentar nunca ante
 * un timeout— perdería mensajes reales con más frecuencia de la que evita
 * duplicados, y esta casa ya decidió (0180) que un envío que no se sabe si
 * salió se reintenta, no se abandona. Lo que SÍ se puede mitigar es LA
 * VENTANA: sin este retraso, el primer reintento podía ocurrir en el mismo
 * minuto que el timeout original — la peor combinación posible, porque es
 * exactamente cuando es MÁS probable que la respuesta de Meta esté a punto de
 * llegar tarde. Cinco minutos no prueban nada por sí solos, pero alejan el
 * reintento de la ventana donde la carrera es más aguda, sin demorar de forma
 * perceptible un mensaje que de verdad no salió — ningún camino de este
 * archivo es una alerta de segundos (POD, cierre, cobranza).
 */
export const RETRASO_AMBIGUO_SEGUNDOS = 5 * 60;

/**
 * Guarda una salida que Meta no aceptó (o de la que nunca se supo) por un
 * error transitorio. Nunca lanza: el caller ya devolvió su resultado normal;
 * fallar al respaldo solo se grita.
 *
 * `retrasoSegundos` es CERO para un rechazo explícito de Meta (`!res.ok`,
 * llamador de `client.ts`) y `RETRASO_AMBIGUO_SEGUNDOS` para un timeout o un
 * socket caído — ver el comentario de esa constante. El default (0) preserva
 * el comportamiento de siempre para quien no lo pase.
 */
export async function encolarSalidaWhatsApp(
  payload: Record<string, unknown>,
  motivo: string,
  retrasoSegundos = 0,
): Promise<void> {
  try {
    const retraso = Number.isFinite(retrasoSegundos) ? Math.max(0, retrasoSegundos) : 0;
    const { error } = await acotada(supabaseAdmin().from('wa_outbox').insert({
      payload, ultimo_error: motivo.slice(0, 500),
      // Con retraso 0 se omite la llave: el default de la columna (`now()`)
      // es exactamente lo mismo, y así el insert de siempre no cambia de
      // forma para quien ya lo prueba.
      ...(retraso > 0 ? { proximo_intento_en: new Date(Date.now() + retraso * 1000).toISOString() } : {}),
    }), 'wa.outbox.encolar');
    if (error) logger.error('wa.outbox_no_encolado', { err: error.message });
  } catch (e) {
    logger.error('wa.outbox_no_encolado', { err: e instanceof Error ? e.message : String(e) });
  }
}

export async function reclamarSalidasWhatsApp(limite = 25): Promise<SalidaOutbox[]> {
  const { data, error } = await acotada(supabaseAdmin().rpc('reclamar_wa_outbox', {
    p_limite: limite, p_lease_seconds: WA_OUTBOX_LEASE_SECONDS,
  }), 'wa.outbox.reclamar');
  if (error) throw new Error(`reclamarSalidasWhatsApp: ${error.message}`);
  return ((data ?? []) as Array<{ id: string; payload: Record<string, unknown>; intentos: number; lease_token: string }>).map((f) => ({
    id: String(f.id), payload: f.payload, intentos: Number(f.intentos), leaseToken: String(f.lease_token),
  }));
}

/**
 * `ok: false` distingue una RPC fallida/claim perdido de una finalización real;
 * el caller no puede afirmar que envió una fila que no logró sellar.
 * `muerta: true` cuando esta salida agotó sus 8 reintentos (0180) y quedó en
 * `estado='dead'` — nadie la va a volver a intentar. AUDITORÍA 19 (OP-19c2-3):
 * antes de la 0189 esto no se podía saber desde la app (la RPC devolvía solo
 * `boolean`), así que un mensaje que muere aquí se perdía en silencio: el cron
 * seguía en verde porque procesó la fila con éxito, solo que el resultado fue
 * enterrarla. El llamador (`route.ts`) es quien decide avisar.
 */
export async function finalizarSalidaWhatsApp(s: SalidaOutbox, messageId?: string, error?: string): Promise<{ ok: boolean; muerta: boolean }> {
  const { data, error: err } = await acotada(supabaseAdmin().rpc('finalizar_wa_outbox', {
    p_id: s.id, p_token: s.leaseToken, p_message_id: messageId ?? null, p_error: error ?? null,
  }), 'wa.outbox.finalizar');
  const fila = (data as Array<{ ok: boolean; muerta: boolean }> | null)?.[0];
  if (err || !fila?.ok) {
    logger.error('wa.outbox_no_finalizado', { id: s.id, err: err?.message ?? 'claim perdido' });
    return { ok: false, muerta: false };
  }
  return { ok: true, muerta: fila.muerta === true };
}

/** Los receipts pertenecen al outbox: una respuesta inválida jamás equivale
 * a cero trabajo. El cron conserva la observabilidad y decide si continuar. */
async function mantenerReceiptsWhatsApp(
  operacion: 'reconciliar_wa_meta_receipts' | 'purgar_wa_meta_receipts',
  limite: number,
): Promise<number> {
  const { data, error } = await acotada(supabaseAdmin().rpc(operacion, { p_limite: limite }), operacion);
  if (error) throw new Error(error.message);
  if (!Number.isInteger(data) || data < 0) throw new Error('respuesta inválida');
  return data;
}

export function reconciliarReceiptsWhatsApp(limite = 100): Promise<number> {
  return mantenerReceiptsWhatsApp('reconciliar_wa_meta_receipts', limite);
}

export function purgarReceiptsWhatsApp(limite = 100): Promise<number> {
  return mantenerReceiptsWhatsApp('purgar_wa_meta_receipts', limite);
}
