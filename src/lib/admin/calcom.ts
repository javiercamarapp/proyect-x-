import { createHmac, timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';

export type CalcomConfig = {
  apiUrl: string;
  apiKey: string;
  webhookSecret: string;
  eventTypeId: string | null;
};

/** Read configuration only from the server environment. Never expose keys to
 * the browser or silently fall back to a demo endpoint. */
export function calcomConfig(env: Partial<NodeJS.ProcessEnv> = {
  CALCOM_API_URL: process.env.CALCOM_API_URL,
  CALCOM_API_KEY: process.env.CALCOM_API_KEY,
  CALCOM_WEBHOOK_SECRET: process.env.CALCOM_WEBHOOK_SECRET,
  CALCOM_EVENT_TYPE_ID: process.env.CALCOM_EVENT_TYPE_ID,
}): CalcomConfig {
  return {
    apiUrl: (env.CALCOM_API_URL ?? 'https://api.cal.com').replace(/\/$/, ''),
    apiKey: env.CALCOM_API_KEY ?? '',
    webhookSecret: env.CALCOM_WEBHOOK_SECRET ?? '',
    eventTypeId: env.CALCOM_EVENT_TYPE_ID ?? null,
  };
}

export function calcomConfigurado(config = calcomConfig()): boolean {
  return Boolean(config.apiKey && config.webhookSecret);
}

export function verificarFirmaCalcom(body: string, firma: string | null, secreto = calcomConfig().webhookSecret): boolean {
  if (!firma || !secreto) return false;
  const esperado = createHmac('sha256', secreto).update(body).digest('hex');
  const recibido = firma.replace(/^sha256=/i, '').trim();
  if (!/^[a-f0-9]{64}$/i.test(recibido)) return false;
  return timingSafeEqual(Buffer.from(esperado, 'hex'), Buffer.from(recibido, 'hex'));
}

export type CalcomProvisionResult = { configured: true; id: string | null } | { configured: false; reason: string };

/** Provisioning hook for deploys. It is deliberately opt-in: without a
 * Cal.com API key it reports configuration rather than making a fake call. */
export async function provisionarWebhookCalcom(callbackUrl: string, config = calcomConfig()): Promise<CalcomProvisionResult> {
  if (!calcomConfigurado(config)) return { configured: false, reason: 'CALCOM_API_KEY y CALCOM_WEBHOOK_SECRET son obligatorias.' };
  const endpoint = config.eventTypeId
    ? `${config.apiUrl}/v2/event-types/${encodeURIComponent(config.eventTypeId)}/webhooks`
    : `${config.apiUrl}/v2/webhooks`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscriberUrl: callbackUrl,
      triggers: ['BOOKING_CREATED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED', 'BOOKING_NO_SHOW_UPDATED'],
      active: true,
      // Sin este mismo secreto Cal.com entrega el webhook, pero nuestra ruta
      // lo rechaza: el alta parecía exitosa y nunca podía procesar un evento.
      secret: config.webhookSecret,
      version: '2021-10-20',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Cal.com webhook provisioning failed (${response.status})`);
  const respuesta = await response.json().catch(() => ({})) as { id?: string | number; data?: { id?: string | number } };
  const id = respuesta.data?.id ?? respuesta.id;
  return { configured: true, id: id === undefined ? null : String(id) };
}

/** Utilidad manual, hoy sin caller ni cron: no es una garantía de entrega.
 * Los estados recuperables del webhook solicitan reintento con HTTP 503; si un
 * operador ejecuta esta utilidad, debe alimentar el mismo ledger idempotente. */
export async function reconciliarReservasCalcom(
  desde: string,
  ingest: (event: Record<string, unknown>) => Promise<void>,
  config = calcomConfig(),
): Promise<{ configured: boolean; revisadas: number }> {
  if (!calcomConfigurado(config)) return { configured: false, revisadas: 0 };
  const url = new URL(`${config.apiUrl}/v2/bookings`);
  url.searchParams.set('afterStart', desde);
  if (config.eventTypeId) url.searchParams.set('eventTypeId', config.eventTypeId);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Cal.com reconciliation failed (${response.status})`);
  const data = await response.json() as { data?: Array<Record<string, unknown>> };
  for (const event of data.data ?? []) await ingest({ triggerEvent: 'BOOKING_RECONCILED', payload: event });
  return { configured: true, revisadas: data.data?.length ?? 0 };
}

export async function registrarEventoComercial(input: {
  claveIdempotencia: string;
  fuente: string;
  tipo: string;
  externoId?: string | null;
  prospectoId?: string | null;
  payload: Record<string, unknown>;
  ocurridoEn?: string;
}): Promise<'nuevo' | 'repetido'> {
  const { data, error } = await supabaseAdmin().from('comercial_evento').insert({
    clave_idempotencia: input.claveIdempotencia,
    fuente: input.fuente,
    tipo: input.tipo,
    externo_id: input.externoId ?? null,
    prospecto_id: input.prospectoId ?? null,
    payload: input.payload,
    ocurrido_en: input.ocurridoEn ?? new Date().toISOString(),
  }).select('id').maybeSingle();
  if (!error && data) return 'nuevo';
  if (error && /23505|duplicate key|unique constraint/i.test(error.message)) return 'repetido';
  throw new Error(`comercial_evento: ${error?.message ?? 'no devolvió id'}`);
}
