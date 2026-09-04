import { NextResponse } from 'next/server';
import { bodyExcede } from '@/lib/ratelimit';
import { logger } from '@/lib/logger';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { calcomConfig, verificarFirmaCalcom } from '@/lib/admin/calcom';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY = 256 * 1024;
const EVENTOS_SOPORTADOS = new Set([
  'BOOKING_CREATED',
  'BOOKING_RESCHEDULED',
  'BOOKING_CANCELLED',
  'BOOKING_NO_SHOW',
]);

type CalcomEvent = {
  triggerEvent?: string;
  /** Instante del webhook en el sobre oficial de Cal.com. Forma parte del
   * cuerpo cuya firma se verificó antes de parsearlo. */
  createdAt?: string;
  id?: string;
  bookingId?: string | number;
  payload?: Record<string, unknown>;
};

type ProspectoActual = { id: string };
type ResultadoRpc = { resultado?: string; estado_prospecto?: string | null };

function texto(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 320) : null;
}

function bookingId(evt: CalcomEvent): string | null {
  const p = evt.payload ?? {};
  const value = evt.bookingId ?? evt.id ?? p.bookingId ?? p.id ?? p.uid;
  return value === undefined || value === null ? null : String(value);
}

/** Cal.com manda el uid anterior al reprogramar. Sólo se usa para enlazar la
 * reserva nueva con la que sigue vigente; jamás como sustituto del bookingId
 * del evento. */
function bookingAnterior(evt: CalcomEvent): string | null {
  const p = evt.payload ?? {};
  const value = p.rescheduleUid ?? p.oldBookingUid ?? p.previousBookingUid;
  return value === undefined || value === null ? null : String(value);
}

/** Solo acepta el `createdAt` del sobre firmado, nunca startTime (hora de la
 * cita) ni un reloj local. Un payload antiguo sin este campo sigue entrando,
 * pero queda sujeto a la precedencia conservadora de estado. */
function instanteFirmado(evt: CalcomEvent): string | null {
  const valor = texto(evt.createdAt);
  if (!valor) return null;
  const ms = Date.parse(valor);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function emailDelEvento(evt: CalcomEvent): string | null {
  const p = evt.payload ?? {};
  const attendees = Array.isArray(p.attendees) ? p.attendees : [];
  const first = attendees[0] as Record<string, unknown> | undefined;
  return texto(p.email) ?? texto(first?.email) ?? texto((p.booking as Record<string, unknown> | undefined)?.email);
}

export async function POST(req: Request) {
  const config = calcomConfig();
  if (!config.webhookSecret) return new NextResponse('Cal.com webhook no configurado', { status: 503 });
  if (bodyExcede(req, MAX_BODY)) return new NextResponse('Payload too large', { status: 413 });
  const raw = await req.text();
  if (raw.length > MAX_BODY) return new NextResponse('Payload too large', { status: 413 });
  const firma = req.headers.get('x-cal-signature-256')
    ?? req.headers.get('x-cal-webhook-signature')
    ?? req.headers.get('cal-signature')
    ?? req.headers.get('x-cal-signature');
  if (!verificarFirmaCalcom(raw, firma, config.webhookSecret)) {
    logger.warn('calcom.webhook.firma_invalida', {});
    return new NextResponse('Firma inválida', { status: 401 });
  }

  let evt: CalcomEvent;
  try { evt = JSON.parse(raw) as CalcomEvent; } catch { return new NextResponse('JSON inválido', { status: 400 }); }
  const tipo = texto(evt.triggerEvent)?.toUpperCase();
  const externo = bookingId(evt);
  if (!tipo || !externo) return new NextResponse('Evento Cal.com incompleto', { status: 400 });
  if (!EVENTOS_SOPORTADOS.has(tipo)) return new NextResponse('Evento Cal.com no soportado', { status: 400 });
  const clave = `calcom:${tipo}:${externo}`;
  const ocurridoEn = instanteFirmado(evt);

  try {
    // Lookup is inside the retryable path too: a transient CRM read failure
    // must be a loud 500, never an unhandled rejection or a false 2xx.
    const prospecto = await encontrarProspecto(emailDelEvento(evt));
    // 0323: ledger, orden, vínculo de booking y cambio de embudo viven en UNA
    // transacción PostgreSQL. Un error/rollback nunca queda sellado como 200 y
    // un duplicado concurrente espera a saber si el dueño hizo COMMIT.
    const { data, error } = await supabaseAdmin().rpc('aplicar_evento_calcom_tx', {
      p_clave: clave,
      p_tipo: tipo,
      p_externo: externo,
      p_prospecto: prospecto?.id ?? null,
      p_payload: evt.payload ?? {},
      p_creado_en: ocurridoEn,
      p_externo_anterior: bookingAnterior(evt),
    });
    if (error) throw new Error(`calcom tx: ${error.message}`);
    const fila = (Array.isArray(data) ? data[0] : data) as ResultadoRpc | null;
    if (!fila?.resultado) throw new Error('calcom tx: respuesta vacía');
    if (fila.resultado === 'repetido') {
      return NextResponse.json({ ok: true, repetido: true, resultado: fila.resultado });
    }
    return NextResponse.json({
      ok: true,
      resultado: fila.resultado,
      prospectoId: prospecto?.id ?? null,
    });
  } catch (error) {
    logger.error('calcom.webhook.fallo', { tipo, externo, err: String(error) });
    return new NextResponse('Error al aplicar evento', { status: 500 });
  }
}

async function encontrarProspecto(email: string | null): Promise<ProspectoActual | null> {
  if (!email) return null;
  const { data, error } = await supabaseAdmin().from('prospecto').select('id')
    .eq('correo', email.toLowerCase()).is('duplicado_de', null).order('updated_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`prospecto lookup: ${error.message}`);
  return data as ProspectoActual | null;
}
