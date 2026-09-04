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
  'BOOKING_NO_SHOW_UPDATED',
  // Nombre histórico aceptado por compatibilidad. El provisionamiento nuevo
  // sólo pide BOOKING_NO_SHOW_UPDATED, que es el trigger oficial de Cal.com.
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
type VinculoProspecto = {
  prospecto: ProspectoActual | null;
  correo: string | null;
  error: 'sin_correo' | 'sin_prospecto' | 'correo_ambiguo' | null;
};
type ResultadoRpc = { resultado?: string; estado_prospecto?: string | null };

function texto(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 320) : null;
}

type IdentidadReserva = { canonica: string; aliases: string[] };

function identidad(prefijo: 'uid' | 'id', valor: unknown): string | null {
  if (valor === undefined || valor === null) return null;
  const limpio = String(valor).trim();
  return limpio ? `${prefijo}:${limpio}` : null;
}

function unicas(valores: Array<string | null>): string[] {
  return [...new Set(valores.filter((v): v is string => v !== null))];
}

/** Todos los payloads se convierten al mismo espacio: UID cuando Cal.com lo
 * entrega, `id:` sólo como alias/fallback. Así bookingId=201 nunca se compara
 * accidentalmente con rescheduleUid=A. Conserva las formas antiguas de la
 * ruta (bookingId/id en el sobre o payload) como fallback namespaced. */
function reserva(evt: CalcomEvent): IdentidadReserva | null {
  const p = evt.payload ?? {};
  const uid = identidad('uid', p.uid ?? p.bookingUid);
  const id = identidad('id', p.bookingId ?? evt.bookingId ?? p.id ?? evt.id);
  const aliases = unicas([uid, id]);
  return aliases.length ? { canonica: uid ?? aliases[0], aliases } : null;
}

/** Cal.com manda el uid anterior al reprogramar. Sólo se usa para enlazar la
 * reserva nueva con la que sigue vigente; jamás como sustituto del bookingId
 * del evento. */
function reservaAnterior(evt: CalcomEvent): IdentidadReserva | null {
  const p = evt.payload ?? {};
  const uid = identidad('uid', p.rescheduleUid ?? p.oldBookingUid ?? p.previousBookingUid);
  const id = identidad('id', p.rescheduleId ?? p.oldBookingId ?? p.previousBookingId);
  const aliases = unicas([uid, id]);
  return aliases.length ? { canonica: uid ?? aliases[0], aliases } : null;
}

type ParticipanteEvento = { email: string | null; noShow: boolean | null };

/** En NO_SHOW_UPDATED el booleano y el correo son una sola observación. Para
 * citas grupales se prefiere el attendee señalado por payload.email; si no lo
 * hay, Cal.com entrega el attendee modificado y usamos ese mismo objeto. */
function participanteDelEvento(evt: CalcomEvent, tipo: string): ParticipanteEvento {
  const p = evt.payload ?? {};
  const attendees = Array.isArray(p.attendees) ? p.attendees : [];
  if (tipo === 'BOOKING_NO_SHOW_UPDATED') {
    const candidatos = attendees
      .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === 'object')
      .filter((a) => typeof a.noShow === 'boolean' && texto(a.email) !== null);
    const emailPreferido = texto(p.email)?.toLowerCase() ?? null;
    const elegido = candidatos.find((a) => texto(a.email)?.toLowerCase() === emailPreferido)
      ?? candidatos[0];
    return {
      email: texto(elegido?.email),
      noShow: typeof elegido?.noShow === 'boolean' ? elegido.noShow : null,
    };
  }
  const first = attendees[0] as Record<string, unknown> | undefined;
  return {
    email: texto(p.email) ?? texto(first?.email) ?? texto((p.booking as Record<string, unknown> | undefined)?.email),
    noShow: tipo === 'BOOKING_NO_SHOW' ? true : null,
  };
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
  const actual = reserva(evt);
  if (!tipo || !actual) return new NextResponse('Evento Cal.com incompleto', { status: 400 });
  if (!EVENTOS_SOPORTADOS.has(tipo)) return new NextResponse('Evento Cal.com no soportado', { status: 400 });
  const ocurridoEn = instanteFirmado(evt);
  const participante = participanteDelEvento(evt, tipo);
  if (tipo === 'BOOKING_NO_SHOW_UPDATED' && (participante.noShow === null || !participante.email)) {
    return new NextResponse('Evento Cal.com sin attendee/noShow coherente', { status: 400 });
  }
  const noShow = participante.noShow;
  const anterior = reservaAnterior(evt);
  const clave = tipo === 'BOOKING_NO_SHOW_UPDATED'
    ? `calcom:${tipo}:${actual.canonica}:${ocurridoEn ?? 'sin-reloj'}:${String(noShow)}`
    : `calcom:${tipo}:${actual.canonica}`;

  try {
    // Lookup is inside the retryable path too: a transient CRM read failure
    // must be a loud 500, never an unhandled rejection or a false 2xx.
    const vinculo = await encontrarProspecto(participante.email);
    // 0323: ledger, orden, vínculo de booking y cambio de embudo viven en UNA
    // transacción PostgreSQL. Un error/rollback nunca queda sellado como 200 y
    // un duplicado concurrente espera a saber si el dueño hizo COMMIT.
    const { data, error } = await supabaseAdmin().rpc('aplicar_evento_calcom_tx', {
      p_clave: clave,
      p_tipo: tipo,
      p_externo: actual.canonica,
      p_prospecto: vinculo.prospecto?.id ?? null,
      p_payload: evt.payload ?? {},
      p_creado_en: ocurridoEn,
      p_externo_anterior: anterior?.canonica ?? null,
      p_externos: actual.aliases,
      p_externos_anteriores: anterior?.aliases ?? [],
      p_no_show: noShow,
      p_vinculo_correo: vinculo.correo,
      p_error_vinculo: vinculo.error,
    });
    if (error) throw new Error(`calcom tx: ${error.message}`);
    const fila = (Array.isArray(data) ? data[0] : data) as ResultadoRpc | null;
    if (!fila?.resultado) throw new Error('calcom tx: respuesta vacía');
    if (fila.resultado === 'repetido') {
      return NextResponse.json({ ok: true, repetido: true, resultado: fila.resultado });
    }
    if (fila.resultado === 'sin_prospecto' || fila.resultado === 'cuarentena') {
      // Ya existe una fila durable con correo/createdAt original y el barrido
      // propio de 0323 puede reclamarla. Confirmamos recepción con 202: la
      // recuperación no depende de que Cal.com interprete/reintente un 503.
      return NextResponse.json(
        { ok: true, recuperable: true, resultado: fila.resultado },
        { status: 202 },
      );
    }
    return NextResponse.json({
      ok: true,
      resultado: fila.resultado,
      prospectoId: vinculo.prospecto?.id ?? null,
    });
  } catch (error) {
    logger.error('calcom.webhook.fallo', { tipo, externo: actual.canonica, err: String(error) });
    return new NextResponse('Error al aplicar evento', { status: 500 });
  }
}

async function encontrarProspecto(email: string | null): Promise<VinculoProspecto> {
  const correo = email?.trim().toLowerCase() || null;
  if (!correo) return { prospecto: null, correo: null, error: 'sin_correo' };
  // Dos filas bastan para distinguir 0/1/ambiguo. Nunca se decide por
  // `updated_at`: con correos duplicados eso vinculaba una cita a una empresa
  // arbitraria y la mutación parecía exitosa.
  const { data, error } = await supabaseAdmin().from('prospecto').select('id')
    .eq('correo_normalizado', correo).is('duplicado_de', null).limit(2);
  if (error) throw new Error(`prospecto lookup: ${error.message}`);
  const filas = (data ?? []) as ProspectoActual[];
  if (filas.length === 1) return { prospecto: filas[0], correo, error: null };
  if (filas.length > 1) {
    logger.warn('calcom.webhook.correo_ambiguo', { correo, coincidencias: filas.length });
    return { prospecto: null, correo, error: 'correo_ambiguo' };
  }
  return { prospecto: null, correo, error: 'sin_prospecto' };
}
