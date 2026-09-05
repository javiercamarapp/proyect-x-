import { instanteRFC3339 } from '@/lib/formato';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { secretoEntornoSeguro, valorEntornoReal } from '@/lib/env';

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

function hostPrivado(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::' || host === '::1'
      || host.endsWith('.localhost') || host.endsWith('.local')
      || host.endsWith('.internal') || host.endsWith('.localdomain')) return true;
  // WHATWG normaliza `::ffff:127.0.0.1` como `::ffff:7f00:1`. Si sólo se
  // inspecciona la notación decimal, una URL aparentemente IPv6 vuelve a
  // alcanzar loopback, RFC1918 o el metadata endpoint mediante IPv4-mapped.
  const mapeada = /^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (mapeada) {
    const alta = Number.parseInt(mapeada[1], 16);
    const baja = Number.parseInt(mapeada[2], 16);
    return hostPrivado(`${alta >>> 8}.${alta & 255}.${baja >>> 8}.${baja & 255}`);
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const octetos = ipv4.slice(1).map(Number);
    if (octetos.some((n) => n > 255)) return true;
    const [a, b] = octetos;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
  return false;
}

function urlPublicaHttps(valor: string): boolean {
  try {
    const url = new URL(valor);
    return url.protocol === 'https:' && !url.username && !url.password
      && Boolean(url.hostname) && !hostPrivado(url.hostname);
  } catch {
    return false;
  }
}

export function calcomConfigurado(config = calcomConfig()): boolean {
  return valorEntornoReal(config.apiKey)
    && /^cal_[A-Za-z0-9_-]{20,}$/.test(config.apiKey.trim())
    && secretoEntornoSeguro(config.webhookSecret)
    && urlPublicaHttps(config.apiUrl);
}

export function secretoCalcomConfigurado(secreto = calcomConfig().webhookSecret): boolean {
  return secretoEntornoSeguro(secreto);
}

export function verificarFirmaCalcom(body: string, firma: string | null, secreto = calcomConfig().webhookSecret): boolean {
  if (!firma || !secretoCalcomConfigurado(secreto)) return false;
  const esperado = createHmac('sha256', secreto).update(body).digest('hex');
  const recibido = firma.replace(/^sha256=/i, '').trim();
  if (!/^[a-f0-9]{64}$/i.test(recibido)) return false;
  return timingSafeEqual(Buffer.from(esperado, 'hex'), Buffer.from(recibido, 'hex'));
}

export type CalcomProvisionResult = { configured: true; id: string | null } | { configured: false; reason: string };

const CALCOM_TRIGGERS = [
  'BOOKING_CREATED',
  'BOOKING_RESCHEDULED',
  'BOOKING_REQUESTED',
  'BOOKING_CANCELLED',
  'BOOKING_REJECTED',
  'BOOKING_NO_SHOW_UPDATED',
] as const;

type CalcomWebhook = { id?: string | number; subscriberUrl?: string };

function idDeRespuesta(respuesta: unknown): string | null {
  const r = respuesta as { id?: string | number; data?: { id?: string | number } };
  const id = r?.data?.id ?? r?.id;
  return id === undefined ? null : String(id);
}

async function respuestaJson(response: Response, operacion: string): Promise<unknown> {
  if (!response.ok) throw new Error(`Cal.com ${operacion} failed (${response.status})`);
  return response.status === 204 ? {} : response.json().catch(() => ({}));
}

const REINTENTOS_GET_CALCOM = 1;
const ESPERA_REINTENTO_MAX_MS = 1_000;

function esperaRetryAfterMs(response: Response): number {
  const valor = response.headers.get('retry-after')?.trim();
  if (!valor) return 100;
  const segundos = Number(valor);
  const fecha = Date.parse(valor);
  const calculada = Number.isFinite(segundos)
    ? Math.max(0, segundos * 1_000)
    : Number.isFinite(fecha) ? Math.max(0, fecha - Date.now()) : 100;
  return Math.min(ESPERA_REINTENTO_MAX_MS, calculada);
}

async function esperarReintento(ms: number, venceEn: number | undefined): Promise<void> {
  if (venceEn !== undefined && Date.now() + ms + 250 >= venceEn) {
    throw new Error('Cal.com sin presupuesto de tiempo para reintento');
  }
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sólo reintenta GET, que es idempotente. POST/PATCH/DELETE podrían haber sido
 * aceptados por Cal.com antes de un 5xx y se mantienen fail-closed para no
 * duplicar ni borrar recursos sin una llave idempotente del proveedor. */
async function obtenerJsonCalcom(
  input: string | URL,
  init: Omit<RequestInit, 'method' | 'signal'>,
  operacion: string,
  venceEn: number | undefined,
  timeoutMs: number,
): Promise<unknown> {
  for (let intento = 0; ; intento += 1) {
    const response = await fetch(input, {
      ...init,
      redirect: 'error',
      signal: signalAcotada(venceEn, timeoutMs),
    });
    const transitorio = response.status === 429 || response.status >= 500;
    if (!response.ok && transitorio && intento < REINTENTOS_GET_CALCOM) {
      await response.body?.cancel().catch(() => undefined);
      await esperarReintento(esperaRetryAfterMs(response), venceEn);
      continue;
    }
    return respuestaJson(response, operacion);
  }
}

function signalAcotada(venceEn: number | undefined, maximoMs: number): AbortSignal {
  const restante = venceEn === undefined ? maximoMs : Math.min(maximoMs, venceEn - Date.now());
  if (restante < 250) throw new Error('Cal.com sin presupuesto de tiempo');
  return AbortSignal.timeout(restante);
}

/** Provisioning hook for deploys. It is deliberately opt-in: without a
 * Cal.com API key it reports configuration rather than making a fake call. */
export async function provisionarWebhookCalcom(
  callbackUrl: string,
  config = calcomConfig(),
  opciones: { venceEn?: number } = {},
): Promise<CalcomProvisionResult> {
  if (!calcomConfigurado(config)) return { configured: false, reason: 'Cal.com exige API key/secret fuertes y un origen público por HTTPS.' };
  if (!urlPublicaHttps(callbackUrl)) throw new Error('Cal.com callback debe ser una URL pública por HTTPS');
  const endpointScope = config.eventTypeId
    ? `${config.apiUrl}/v2/event-types/${encodeURIComponent(config.eventTypeId)}/webhooks`
    : `${config.apiUrl}/v2/webhooks`;
  const headers = { Authorization: `Bearer ${config.apiKey}` };
  const encontrados: CalcomWebhook[] = [];
  for (let skip = 0; skip <= 10_000; skip += 250) {
    const json = await obtenerJsonCalcom(
      `${endpointScope}?take=250&skip=${skip}`,
      { headers },
      'webhook listing',
      opciones.venceEn,
      15_000,
    ) as { data?: unknown };
    if (!Array.isArray(json.data)) throw new Error('Cal.com webhook listing sin data[]');
    encontrados.push(...json.data as CalcomWebhook[]);
    if (json.data.length < 250) break;
    if (skip === 10_000) throw new Error('Cal.com webhook listing excedió paginación segura');
  }

  const cuerpo = {
    subscriberUrl: callbackUrl,
    triggers: [...CALCOM_TRIGGERS],
    active: true,
    // Sin este mismo secreto Cal.com entrega el webhook, pero nuestra ruta
    // lo rechaza: el alta parecía exitosa y nunca podía procesar un evento.
    secret: config.webhookSecret,
    version: '2021-10-20',
  };
  const coincidentes = encontrados.filter((w) => w.subscriberUrl === callbackUrl && w.id !== undefined);

  if (coincidentes.length === 0) {
    const creado = await fetch(endpointScope, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
      redirect: 'error',
      signal: signalAcotada(opciones.venceEn, 15_000),
    });
    return { configured: true, id: idDeRespuesta(await respuestaJson(creado, 'webhook provisioning')) };
  }

  const conservar = coincidentes[0];
  const id = String(conservar.id);
  const actualizado = await fetch(`${endpointScope}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
    redirect: 'error',
    signal: signalAcotada(opciones.venceEn, 15_000),
  });
  await respuestaJson(actualizado, 'webhook update');

  // Una sola suscripción por subscriberUrl dentro del scope. Las de otras
  // URLs se respetan: pueden pertenecer a integraciones distintas.
  for (const duplicado of coincidentes.slice(1)) {
    const eliminado = await fetch(`${endpointScope}/${encodeURIComponent(String(duplicado.id))}`, {
      method: 'DELETE', headers, redirect: 'error', signal: signalAcotada(opciones.venceEn, 15_000),
    });
    await respuestaJson(eliminado, 'duplicate webhook deletion');
  }
  return { configured: true, id };
}

type BookingCalcom = Record<string, unknown> & {
  id?: string | number;
  uid?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  rescheduledFromUid?: string;
  attendees?: Array<Record<string, unknown>>;
};

type EventoSnapshotCalcom = { evento: Record<string, unknown>; meta?: CalcomIngestMeta };

function eventosDeBooking(booking: BookingCalcom): EventoSnapshotCalcom[] {
  if ((booking.uid === undefined || booking.uid === '') && booking.id === undefined) {
    throw new Error('Cal.com booking sin uid/id');
  }
  // La reconciliación no tiene un sobre firmado del webhook. Exige ambos
  // relojes del recurso para no inventar createdAt con startTime ni con el
  // reloj local, y falla cerrada si Cal.com devuelve datos incompletos.
  for (const campo of ['createdAt', 'updatedAt'] as const) {
    const valor = booking[campo];
    if (typeof valor !== 'string' || !instanteRFC3339(valor)) {
      throw new Error(`Cal.com booking sin ${campo} válido (reloj)`);
    }
  }
  const attendees: Array<Record<string, unknown> & { noShow: boolean }> = Array.isArray(booking.attendees)
    ? booking.attendees.map((a) => ({ ...a, noShow: a.absent === true }))
    : [];
  const status = String(booking.status ?? '').trim().toLowerCase();
  if (!['accepted', 'pending', 'cancelled', 'rejected'].includes(status)) {
    throw new Error(`Cal.com status no soportado: ${status || '(vacío)'}`);
  }
  const noShow = attendees.some((a) => a.noShow === true);
  const payload = {
    ...booking,
    uid: booking.uid,
    bookingId: booking.id,
    rescheduleUid: booking.rescheduledFromUid,
    attendees,
  };
  const evento = (triggerEvent: string, createdAt: string | undefined): EventoSnapshotCalcom => ({ evento: {
    triggerEvent, createdAt,
    payload: {
      ...payload,
    },
  } });
  const base = status === 'pending' || status === 'rejected' ? 'BOOKING_REQUESTED' : 'BOOKING_CREATED';
  const eventos: EventoSnapshotCalcom[] = [evento(base, booking.createdAt ?? booking.updatedAt)];
  if (status === 'cancelled') eventos.push(evento('BOOKING_CANCELLED', booking.updatedAt ?? booking.createdAt));
  if (status === 'rejected') eventos.push(evento('BOOKING_REJECTED', booking.updatedAt ?? booking.createdAt));
  if (status === 'accepted' && booking.rescheduledFromUid) {
    eventos.push(evento('BOOKING_RESCHEDULED', booking.updatedAt ?? booking.createdAt));
  }
  if (status === 'accepted' && noShow) {
    eventos.push(evento('BOOKING_NO_SHOW_UPDATED', booking.updatedAt ?? booking.createdAt));
  } else if (status === 'accepted') {
    const attendeePresente = attendees.find((a) => a.absent === false && typeof a.email === 'string');
    if (attendeePresente) eventos.push({
      evento: {
        triggerEvent: 'BOOKING_NO_SHOW_UPDATED',
        createdAt: booking.updatedAt ?? booking.createdAt,
        payload: { ...payload, bookingUid: booking.uid, attendees: [{ ...attendeePresente, noShow: false }] },
      },
      meta: { soloSiNoShowVigente: true },
    });
  }
  return eventos;
}



function sinTiempo(venceEn: number | undefined): boolean {
  return venceEn !== undefined && Date.now() + 250 >= venceEn;
}

function resultadoParcial(revisadas: number, cursor: string | null) {
  return { configured: true, revisadas, completa: false, cursor };
}

function combinarLedger(
  inicial: CalcomReconciliacionPendiente,
  final: CalcomReconciliacionPendiente,
): CalcomReconciliacionPendiente {
  const combinado: CalcomReconciliacionPendiente = {
    configured: inicial.configured && final.configured,
    revisados: inicial.revisados + final.revisados,
    recuperados: inicial.recuperados + final.recuperados,
    restantes: final.restantes,
  };
  if (final.elegibles !== undefined) combinado.elegibles = final.elegibles;
  return combinado;
}

export type CalcomIngestMeta = { soloSiNoShowVigente?: boolean };
export type CalcomReconciliacionOpciones = {
  hasta?: string;
  cursor?: string | null;
  venceEn?: number;
  maxPaginas?: number;
  guardarCursor?: (cursor: string) => Promise<void>;
};

/** Recorre todos los cambios desde un watermark externo y alimenta el mismo
 * ledger idempotente que el webhook. No inventa tipos ajenos a la ruta. */
export async function reconciliarReservasCalcom(
  desde: string,
  ingest: (event: Record<string, unknown>, meta?: CalcomIngestMeta) => Promise<void>,
  config = calcomConfig(),
  opciones: CalcomReconciliacionOpciones = {},
): Promise<{ configured: boolean; revisadas: number; completa: boolean; cursor: string | null }> {
  if (!calcomConfigurado(config)) return { configured: false, revisadas: 0, completa: false, cursor: opciones.cursor ?? null };
  let cursor: string | null = opciones.cursor ?? null;
  let revisadas = 0;
  let paginas = 0;
  const vistos = new Set<string>();
  do {
    if (paginas >= (opciones.maxPaginas ?? 10) || sinTiempo(opciones.venceEn)) {
      return resultadoParcial(revisadas, cursor);
    }
    const url = new URL(`${config.apiUrl}/v2/bookings`);
    url.searchParams.set('afterUpdatedAt', desde);
    if (opciones.hasta) url.searchParams.set('beforeUpdatedAt', opciones.hasta);
    url.searchParams.set('limit', '100');
    if (config.eventTypeId) url.searchParams.set('eventTypeId', config.eventTypeId);
    if (cursor) url.searchParams.set('cursor', cursor);
    const pagina = await obtenerJsonCalcom(url, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'cal-api-version': '2026-05-01',
      },
    }, 'reconciliation', opciones.venceEn, 20_000) as {
      data?: unknown;
      pagination?: { hasMore?: boolean; nextCursor?: string | null };
    };
    if (!Array.isArray(pagina.data)) throw new Error('Cal.com reconciliation sin data[]');
    for (const booking of pagina.data as BookingCalcom[]) {
      if (sinTiempo(opciones.venceEn)) return resultadoParcial(revisadas, cursor);
      const eventos = eventosDeBooking(booking);
      for (const { evento, meta } of eventos) {
        if (sinTiempo(opciones.venceEn)) return resultadoParcial(revisadas, cursor);
        await ingest(evento, meta);
      }
      revisadas += 1;
    }
    paginas += 1;
    if (!pagina.pagination?.hasMore) {
      return { configured: true, revisadas, completa: true, cursor: null };
    }
    const siguiente = pagina.pagination.nextCursor;
    if (!siguiente) throw new Error('Cal.com pagination hasMore sin cursor');
    if (vistos.has(siguiente)) throw new Error('Cal.com pagination repitió cursor');
    vistos.add(siguiente);
    await opciones.guardarCursor?.(siguiente);
    cursor = siguiente;
  } while (true);
}

export type CalcomReconciliacionPendiente = {
  configured: boolean;
  revisados: number;
  recuperados: number;
  restantes: number;
  /** Deuda que puede reclamarse ahora. `restantes` conserva toda la deuda
   * durable, incluso backoff y cuarentena futura, para observabilidad. */
  elegibles?: number;
};

/** Claim durable de sin_prospecto/cuarentena. Vive en PostgreSQL para que dos
 * cron solapados usen SKIP LOCKED y no dupliquen transiciones. */
export async function reconciliarEventosCalcomPendientes(
  limite = 250,
  _config = calcomConfig(),
): Promise<CalcomReconciliacionPendiente> {
  const { data, error } = await supabaseAdmin().rpc('reconciliar_eventos_calcom_pendientes', {
    p_limite: limite,
  });
  if (error) throw new Error(`Cal.com pending reconciliation: ${error.message}`);
  const fila = (Array.isArray(data) ? data[0] : data) as {
    revisados?: number; recuperados?: number; restantes?: number; elegibles?: number;
  } | null;
  if (!fila) throw new Error('Cal.com pending reconciliation: respuesta vacía');
  const resultado: CalcomReconciliacionPendiente = {
    configured: true,
    revisados: Number(fila.revisados ?? 0),
    recuperados: Number(fila.recuperados ?? 0),
    restantes: Number(fila.restantes ?? 0),
  };
  // Compatibilidad con una RPC anterior durante rollout: no fabrica un cero
  // observable ni altera la forma exacta de respuestas legacy.
  if (fila.elegibles !== undefined) resultado.elegibles = Number(fila.elegibles ?? 0);
  return resultado;
}

type EstadoSincronizacionCalcom = {
  claim_token: string;
  desde_en: string;
  ventana_hasta_en: string;
  cursor_siguiente: string | null;
  debe_provisionar: boolean;
};

async function rpcBooleana(nombre: string, args: Record<string, unknown>): Promise<void> {
  const { data, error } = await supabaseAdmin().rpc(nombre, args);
  if (error) throw new Error(`${nombre}: ${error.message}`);
  if (data !== true) throw new Error(`${nombre}: fencing rechazó callback`);
}

function datosReservaEvento(evento: Record<string, unknown>): {
  correo: string | null;
  aliases: string[];
} {
  const payload = (evento.payload && typeof evento.payload === 'object')
    ? evento.payload as Record<string, unknown> : {};
  const attendees = Array.isArray(payload.attendees) ? payload.attendees : [];
  const primero = attendees.find((a) => a && typeof a === 'object') as Record<string, unknown> | undefined;
  const correo = typeof primero?.email === 'string' ? primero.email.trim().toLowerCase() : null;
  const aliases = [
    payload.uid ? `uid:${String(payload.uid).trim()}` : null,
    payload.bookingUid ? `uid:${String(payload.bookingUid).trim()}` : null,
    payload.bookingId !== undefined ? `id:${String(payload.bookingId).trim()}` : null,
  ].filter((v): v is string => Boolean(v));
  return { correo, aliases: [...new Set(aliases)] };
}

/** Entrega dentro del mismo proceso por la ruta firmada real: no crea otra
 * invocación Vercel ni una segunda implementación del ledger. */
async function entregarEventoCalcomLocal(
  evento: Record<string, unknown>,
  meta: CalcomIngestMeta | undefined,
  config: CalcomConfig,
  callbackUrl: string,
): Promise<void> {
  if (meta?.soloSiNoShowVigente) {
    const { correo, aliases } = datosReservaEvento(evento);
    if (!correo || aliases.length === 0) return;
    // CRM global de LIKIDA (0105): el prospecto aún no pertenece a una flota.
    // orden-no-importa: limit(2) distingue cero, una o varias coincidencias; sólo se inspecciona la fila cuando es única.
    const { data, error } = await supabaseAdmin().from('prospecto')
      .select('id,estado,calcom_booking_id,calcom_booking_aliases')
      .eq('correo_normalizado', correo).is('duplicado_de', null).limit(2);
    if (error) throw new Error(`Cal.com no-show reconciliation lookup: ${error.message}`);
    const filas = (data ?? []) as Array<{
      estado?: string; calcom_booking_id?: string | null; calcom_booking_aliases?: string[] | null;
    }>;
    if (filas.length === 1) {
      if (filas[0].estado !== 'no-show') return;
      const vigentes = new Set([filas[0].calcom_booking_id, ...(filas[0].calcom_booking_aliases ?? [])]);
      if (!aliases.some((a) => vigentes.has(a))) return;
    }
    // 0 o >1 no se descartan: la ruta real los deja como sin_prospecto /
    // correo_ambiguo y el barrido durable los reanuda cuando el vínculo sea
    // inequívoco. Sólo la reserva sana conocida se omite sin crear ruido.
  }
  const raw = JSON.stringify(evento);
  const firma = createHmac('sha256', config.webhookSecret).update(raw).digest('hex');
  const { POST } = await import('@/app/api/webhook/calcom/route');
  const response = await POST(new Request(callbackUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cal-signature-256': firma },
    body: raw,
  }));
  if (response.status >= 400) throw new Error(`Cal.com entrega local falló (${response.status})`);
}

export type CalcomMantenimientoOpciones = {
  venceEn: number;
  callbackUrl: string;
  config?: CalcomConfig;
  entregar?: (evento: Record<string, unknown>, meta?: CalcomIngestMeta) => Promise<void>;
};

/** Pipeline productivo del cron: ledger local, claim durable, webhook y
 * Bookings v2. Watermark sólo avanza tras consumir la ventana completa. */
export async function ejecutarMantenimientoCalcom(opciones: CalcomMantenimientoOpciones): Promise<{
  configured: boolean;
  completa: boolean;
  provisionado: boolean;
  revisadas: number;
  cortadasPorReloj: number;
  ledger: CalcomReconciliacionPendiente;
}> {
  const config = opciones.config ?? calcomConfig();
  const ledgerInicial = await reconciliarEventosCalcomPendientes(250, config);
  if (!calcomConfigurado(config)) {
    throw new Error('Cal.com no configurado: faltan API key o webhook secret');
  }
  const { data, error } = await supabaseAdmin().rpc('iniciar_sincronizacion_calcom', {
    p_lease_seconds: 100,
  });
  if (error) throw new Error(`iniciar_sincronizacion_calcom: ${error.message}`);
  const estado = (Array.isArray(data) ? data[0] : data) as EstadoSincronizacionCalcom | null;
  if (!estado?.claim_token) {
    return { configured: true, completa: false, provisionado: false, revisadas: 0, cortadasPorReloj: 1, ledger: ledgerInicial };
  }

  const claim = estado.claim_token;
  let provisionado = false;
  try {
    if (estado.debe_provisionar) {
      const provision = await provisionarWebhookCalcom(opciones.callbackUrl, config, { venceEn: opciones.venceEn });
      if (!provision.configured || !provision.id) throw new Error('Cal.com provisionamiento sin id');
      await rpcBooleana('registrar_webhook_sincronizacion_calcom', {
        p_claim_token: claim, p_webhook_id: provision.id,
      });
      provisionado = true;
    }
    const entregar = opciones.entregar ?? ((evento, meta) =>
      entregarEventoCalcomLocal(evento, meta, config, opciones.callbackUrl));
    const reservas = await reconciliarReservasCalcom(
      estado.desde_en,
      entregar,
      config,
      {
        hasta: estado.ventana_hasta_en,
        cursor: estado.cursor_siguiente,
        venceEn: opciones.venceEn,
        maxPaginas: 10,
        guardarCursor: async (cursor) => rpcBooleana('guardar_cursor_sincronizacion_calcom', {
          p_claim_token: claim, p_cursor: cursor, p_lease_seconds: 100,
        }),
      },
    );
    const cortadoAntesSegundoBarrido = sinTiempo(opciones.venceEn);
    const ledgerFinal = cortadoAntesSegundoBarrido
      ? ledgerInicial
      : combinarLedger(ledgerInicial, await reconciliarEventosCalcomPendientes(250, config));
    const cortadoDespuesSegundoBarrido = !cortadoAntesSegundoBarrido && sinTiempo(opciones.venceEn);
    // Si no hubo reloj para comprobar el ledger recién producido, no existe
    // evidencia para avanzar el watermark aunque la página dijera hasMore=false.
    // Una deuda con backoff o cuarentena futura sigue visible en `restantes`,
    // pero no congela para siempre el watermark de Bookings. Sólo la deuda que
    // era reclamable y quedó sin consumir impide cerrar esta ventana.
    const deudaReclamable = ledgerFinal.elegibles ?? ledgerFinal.restantes;
    const completa = reservas.completa
      && !cortadoAntesSegundoBarrido
      && !cortadoDespuesSegundoBarrido
      && deudaReclamable === 0;
    await rpcBooleana(
      completa ? 'finalizar_sincronizacion_calcom' : 'pausar_sincronizacion_calcom',
      { p_claim_token: claim },
    );
    return {
      configured: true,
      completa,
      provisionado,
      revisadas: reservas.revisadas,
      cortadasPorReloj: completa && ledgerFinal.restantes === 0 ? 0 : 1,
      ledger: ledgerFinal,
    };
  } catch (e) {
    const mensaje = e instanceof Error ? e.message : String(e);
    await supabaseAdmin().rpc('fallar_sincronizacion_calcom', {
      p_claim_token: claim, p_error: mensaje,
    });
    throw e;
  }
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
