import { NextResponse } from 'next/server';
import { bodyExcede } from '@/lib/ratelimit';
import { logger } from '@/lib/logger';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { calcomConfig, registrarEventoComercial, verificarFirmaCalcom } from '@/lib/admin/calcom';
import {
  normalizarEstadoProspecto,
  type EstadoProspecto,
} from '@/lib/likida/vendedores';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY = 256 * 1024;
const ESTADO_POR_EVENTO: Record<string, EstadoProspecto> = {
  BOOKING_CREATED: 'appointment',
  BOOKING_RESCHEDULED: 'rescheduled',
  BOOKING_CANCELLED: 'cancelled',
  BOOKING_NO_SHOW: 'no-show',
};

type CalcomEvent = {
  triggerEvent?: string;
  /** Instante del webhook en el sobre oficial de Cal.com. Forma parte del
   * cuerpo cuya firma se verificó antes de parsearlo. */
  createdAt?: string;
  id?: string;
  bookingId?: string | number;
  payload?: Record<string, unknown>;
};

type ProspectoActual = { id: string; estado: string };
type EventoOrdenable = {
  clave_idempotencia: string;
  tipo: string;
  externo_id: string | null;
  ocurrido_en: string;
};

const PRECEDENCIA_EVENTO: Record<string, number> = {
  BOOKING_CREATED: 0,
  BOOKING_RESCHEDULED: 1,
  BOOKING_CANCELLED: 2,
  BOOKING_NO_SHOW: 2,
};
const ESTADOS_NEGOCIO_PROTEGIDOS = new Set<EstadoProspecto>([
  'demo', 'proposal', 'pilot', 'won', 'lost',
]);
const ESTADOS_AGENDA_TERMINALES = new Set<EstadoProspecto>(['cancelled', 'no-show']);

function texto(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 320) : null;
}

function bookingId(evt: CalcomEvent): string | null {
  const p = evt.payload ?? {};
  const value = evt.bookingId ?? evt.id ?? p.bookingId ?? p.id ?? p.uid;
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
  const clave = `calcom:${tipo}:${externo}`;
  const estado = ESTADO_POR_EVENTO[tipo];
  const ocurridoEn = instanteFirmado(evt);

  try {
    // Lookup is inside the retryable path too: a transient CRM read failure
    // must be a loud 500, never an unhandled rejection or a false 2xx.
    const prospecto = await encontrarProspecto(emailDelEvento(evt));
    const resultado = await registrarEventoComercial({
      claveIdempotencia: clave, fuente: 'calcom', tipo, externoId: externo,
      prospectoId: prospecto?.id ?? null, payload: evt.payload ?? {},
      ...(ocurridoEn ? { ocurridoEn } : {}),
    });
    if (resultado === 'repetido') return NextResponse.json({ ok: true, repetido: true });
    if (prospecto && estado) {
      try {
        const secuencia = ocurridoEn
          ? await leerSecuenciaCalcom(prospecto.id, clave)
          : { vigente: true, anterior: null };
        await aplicarEstadoCalcom(prospecto, estado, externo, clave, ocurridoEn, secuencia);
      } catch (error) {
        // AUDITORÍA 24, BE-17: si algo falla después de sellar el evento, se
        // suelta la reclamación para que el reintento pueda volver a aplicarlo.
        await soltarReclamacion(clave, tipo, externo);
        throw error;
      }
    }
    return NextResponse.json({ ok: true, prospectoId: prospecto?.id ?? null });
  } catch (error) {
    logger.error('calcom.webhook.fallo', { tipo, externo, err: String(error) });
    return new NextResponse('Error al aplicar evento', { status: 500 });
  }
}

async function encontrarProspecto(email: string | null): Promise<ProspectoActual | null> {
  if (!email) return null;
  const { data, error } = await supabaseAdmin().from('prospecto').select('id, estado')
    .eq('correo', email.toLowerCase()).is('duplicado_de', null).order('updated_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`prospecto lookup: ${error.message}`);
  return data as ProspectoActual | null;
}

function compararEventos(a: EventoOrdenable, b: EventoOrdenable): number {
  const porInstante = Date.parse(b.ocurrido_en) - Date.parse(a.ocurrido_en);
  if (porInstante !== 0) return porInstante;
  const porPrecedencia = (PRECEDENCIA_EVENTO[b.tipo] ?? -1) - (PRECEDENCIA_EVENTO[a.tipo] ?? -1);
  if (porPrecedencia !== 0) return porPrecedencia;
  return b.clave_idempotencia.localeCompare(a.clave_idempotencia);
}

/** El ledger decide el orden por `createdAt` firmado, no por orden de llegada.
 * En empate exacto gana la consecuencia más conservadora (cancel/no-show).
 * Leer después del INSERT hace que dos entregas concurrentes se vean entre
 * sí; el UPDATE optimista de abajo resuelve la carrera restante. */
async function leerSecuenciaCalcom(
  prospectoId: string,
  claveActual: string,
): Promise<{ vigente: boolean; anterior: EventoOrdenable | null }> {
  const { data, error } = await supabaseAdmin().from('comercial_evento')
    .select('clave_idempotencia, tipo, externo_id, ocurrido_en')
    .eq('fuente', 'calcom')
    .eq('prospecto_id', prospectoId)
    .in('tipo', Object.keys(ESTADO_POR_EVENTO))
    .order('ocurrido_en', { ascending: false })
    .limit(50);
  if (error) throw new Error(`calcom secuencia: ${error.message}`);
  const eventos = ((data ?? []) as EventoOrdenable[])
    .filter((e) => Number.isFinite(Date.parse(e.ocurrido_en)))
    .sort(compararEventos);
  return {
    vigente: eventos[0]?.clave_idempotencia === claveActual,
    anterior: eventos.find((e) => e.clave_idempotencia !== claveActual) ?? null,
  };
}

function debeAplicarEstado(
  actualCrudo: string,
  destino: EstadoProspecto,
  externo: string,
  tieneInstanteFirmado: boolean,
  secuencia: { vigente: boolean; anterior: EventoOrdenable | null },
): boolean {
  const actual = normalizarEstadoProspecto(actualCrudo);
  if (actual === null || actual === destino || ESTADOS_NEGOCIO_PROTEGIDOS.has(actual)) return false;
  if (tieneInstanteFirmado && !secuencia.vigente) return false;

  // Un CREATED/RESCHEDULED sin orden firmado nunca reabre un desenlace de
  // agenda. Con orden firmado solo lo hace si pertenece a OTRA reserva más
  // nueva; un evento tardío de la misma reserva queda absorbido por el ledger.
  if ((destino === 'appointment' || destino === 'rescheduled')
      && (actual === 'rescheduled' || ESTADOS_AGENDA_TERMINALES.has(actual))) {
    return tieneInstanteFirmado
      && secuencia.vigente
      && secuencia.anterior?.externo_id !== externo;
  }
  return true;
}

async function leerProspecto(id: string): Promise<ProspectoActual | null> {
  const { data, error } = await supabaseAdmin().from('prospecto')
    .select('id, estado').eq('id', id).is('duplicado_de', null).maybeSingle();
  if (error) throw new Error(`prospecto relectura: ${error.message}`);
  return data as ProspectoActual | null;
}

/** Aplica con compare-and-swap por estado. Si otra entrega gana la carrera,
 * relee una vez y vuelve a decidir sobre el estado vigente; nunca pisa un
 * avance comercial que apareció entre lectura y escritura. */
async function aplicarEstadoCalcom(
  inicial: ProspectoActual,
  destino: EstadoProspecto,
  externo: string,
  clave: string,
  ocurridoEn: string | null,
  secuenciaInicial: { vigente: boolean; anterior: EventoOrdenable | null },
): Promise<void> {
  let prospecto: ProspectoActual | null = inicial;
  let secuencia = secuenciaInicial;
  for (let intento = 0; intento < 2 && prospecto; intento += 1) {
    if (!debeAplicarEstado(prospecto.estado, destino, externo, ocurridoEn !== null, secuencia)) return;
    const cambios = {
      estado: destino,
      cerrado_en: null,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabaseAdmin().from('prospecto').update(cambios)
      .eq('id', prospecto.id).eq('estado', prospecto.estado).select('id');
    if (error) throw new Error(`prospecto: ${error.message}`);
    if (Array.isArray(data) && data.length > 0) return;
    prospecto = await leerProspecto(prospecto.id);
    // La carrera pudo ser precisamente otra entrega de Cal.com. Volver a
    // decidir con la foto vieja repetiría el overwrite que el CAS evitó.
    if (prospecto && ocurridoEn) secuencia = await leerSecuenciaCalcom(prospecto.id, clave);
  }
}

/**
 * Borra el renglón del libro que acabamos de escribir (AUDITORÍA 24, BE-17).
 *
 * Se llama SOLO cuando la escritura del libro fue nuestra (`'nuevo'`) y lo que
 * venía después falló: sin esto, la clave escrita convierte el reintento de
 * Cal.com en un `repetido` que contesta 200 sin haber aplicado nada.
 *
 * Si el borrado también falla no hay nada más que hacer desde aquí —el 500
 * sale igual—, pero se nombra: es la única señal de que ese evento se quedó
 * sellado sin aplicar y hay que correr `reconciliarReservasCalcom`.
 */
async function soltarReclamacion(clave: string, tipo: string, externo: string): Promise<void> {
  const { error } = await supabaseAdmin().from('comercial_evento').delete().eq('clave_idempotencia', clave);
  if (error) {
    logger.error('calcom.webhook.reclamacion_atorada', { tipo, externo, clave, err: error.message });
  }
}
