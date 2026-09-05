// ═══════════════════════════════════════════════════════════════════════════
// EL POLLER DE EVENTOS DE SEGURIDAD — corre DENTRO del cron de GPS.
//
// No es un cron nuevo a propósito: cada cron fijo cuesta (la tabla de
// COSTO-VERCEL-50K lo mide), y el de GPS ya corre cada 5 minutos e itera
// las flotas con credencial. La ingesta comparte proveedor, credencial y
// cadencia con posiciones; el DRENAJE de choques ya persistidos es global e
// independiente del token para que desactivarlo no apague una alerta durable.
//
// ── LA VENTANA TRASLAPADA ─────────────────────────────────────────────────
// Cada flota mantiene dos watermarks: `tail` reciente, prioritario, y backfill
// histórico segmentado. Ambos se solapan cinco minutos y la idempotencia por
// `(tenant_id, proveedor, evento_id_externo)` absorbe las repeticiones. Sólo
// se confirma el watermark cuya ventana HTTP terminó completa.
//
// ── QUÉ DISPARA Y QUÉ SOLO SE REGISTRA ────────────────────────────────────
// Los datos de cámara sólo entran con aviso histórico acreditado. Un grave
// sin esa autorización conserva únicamente metadatos operativos mínimos. Sólo
// los GRAVES (`esEventoGrave`: crash/impacto/volcadura) disparan el circuito
// de asistencia — y el disparo es un BARRIDO idempotente sobre las filas
// `grave` con unidad y `procesado_en` NULL, no un efecto del INSERT.
//
// AUDITORÍA FABLE CICLO 2 (c2-1): antes se disparaba solo la fila recién
// insertada y se sellaba `procesado_en` INCONDICIONALMENTE — un disparo que
// fallaba (timeout de Supabase, kill de Vercel a mitad del loop: el cron trae
// maxDuration=300 y las posiciones solas ya toman ~180 s) dejaba el evento
// sellado-o-huérfano para siempre: el 🚨 de una colisión real jamás salía y
// nada lo rebarrería. Ahora el sello dice la verdad (solo tras un disparo que
// NO falló) y la siguiente corrida rebarre lo pendiente. La dedupe del 🚨 no
// vive aquí: vive en los índices 0201/0206 y en `expedienteAbierto`.
// ═══════════════════════════════════════════════════════════════════════════
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { diaEnZona, TZ_MX } from '@/lib/formato';
import { acotada } from '../presupuesto';
import { descifrar } from './cofre';
import { lectorEventosDe, LECTORES_EVENTOS, esEventoGrave, type EventoSeguridadLeido } from './eventos_seguridad';
import { dispararAsistenciaPorEventoCamara } from '../asistencia_camara';
import type { Http } from './tipos';
import { conPool } from '../lotes';
import { finalizarPoll, reclamarPolls } from './poll_durable';
import { createHash } from 'node:crypto';

/** 6× la cadencia del cron: cubre corridas saltadas sin estado por flota. */
const VENTANA_MS = 30 * 60 * 1000;
const SOLAPE_WATERMARK_MS = 5 * 60 * 1000;
const IDS_POR_CONSULTA = 200;
const EVENTOS_POR_UPSERT = 200;
// Un claim pequeño acota cuántos eventos quedan inmovilizados si Vercel mata
// al worker justo al vencer el presupuesto. Al terminar un lote se reclama el
// siguiente; el lease de 360 s sigue siendo mayor que toda la invocación.
const EVENTOS_POR_CLAIM = 50;
const ANCHO_FANOUT_FLOTAS = 4;

function horasConfiguradas(nombre: string, porDefecto: number, maximo: number): number {
  const n = Number(process.env[nombre]);
  return Number.isFinite(n) && n > 0 ? Math.min(n, maximo) : porDefecto;
}

function enTandas<T>(items: readonly T[], tamano: number): T[][] {
  const salida: T[][] = [];
  for (let i = 0; i < items.length; i += tamano) salida.push(items.slice(i, i + tamano));
  return salida;
}

export interface ResultadoSyncEventos {
  tenantId: string;
  proveedor: string;
  leidos: number;
  guardados: number;
  /** Eventos cuyo vehículo no lo reclama ninguna unidad. Se reportan. */
  huerfanos: number;
  /** Expedientes de asistencia abiertos o alimentados por esta corrida. */
  disparos: number;
  paginas?: number;
  ultimaMedidaEn?: string;
  backlog?: boolean;
  /** Payloads que no cruzaron la segunda barrera y quedaron en DLQ visible. */
  invalidos?: number;
  /** Referencias mínimas guardadas para reparación, sin video/coords/labels. */
  cuarentena?: number;
  referenciasIrrecuperables?: number;
  eventosEnCuarentena?: number;
  eventosCuarentenaMuertos?: number;
  eventosOutboxPendientes?: number;
  eventosOutboxMuertos?: number;
  avisosPendientes?: number;
  avisosMuertos?: number;
  /** El token sirve pero no trae el scope de eventos: el panel debe decirlo. */
  sinPermiso?: boolean;
  /**
   * AUDITORÍA 24, LEG-1 (CRÍTICO). Unidades cuyo operador point-in-time
   * no ha recibido el aviso de privacidad: sus eventos de cámara —conducta al
   * volante, con lat/lng y video— NO se guardan. Mismo criterio y misma
   * compuerta que el poller de posiciones (`privacidad.ts`).
   */
  sinAvisoPrevio?: number;
  /** La corrida se quedó sin presupuesto de tiempo ANTES de tocar esta flota.
   *  Sus watermarks no avanzan y el outbox durable se reintenta aparte. */
  sinTurno?: boolean;
  error?: string;
}

/** Segunda barrera (mismo criterio que `posicionValida`): lo que cruza a
 *  Postgres viene de un tercero y se valida aquí aunque el lector ya filtre. */
function eventoValido(e: EventoSeguridadLeido): boolean {
  return e.eventoId.trim().length > 0 && e.eventoId.length <= 200 &&
    Number.isFinite(Date.parse(e.ocurridoEn)) &&
    (e.lat === null || (Number.isFinite(e.lat) && e.lat >= -90 && e.lat <= 90)) &&
    (e.lng === null || (Number.isFinite(e.lng) && e.lng >= -180 && e.lng <= 180)) &&
    e.etiquetas.every((t) => t.length <= 100) && e.etiquetas.length <= 20;
}

interface GravePendiente {
  evento_id_externo: unknown;
  unidad_id: unknown;
  etiquetas: unknown;
  lat: unknown;
  lng: unknown;
  ocurrido_en: unknown;
  url_evento: unknown;
  max_g: unknown;
  claim_token?: unknown;
  viaje_id?: unknown;
  operador_id?: unknown;
  viaje_folio?: unknown;
  intentos?: unknown;
  privacidad_minima?: unknown;
}

interface EvaluacionPrivacidad {
  autorizado: boolean;
  motivo: 'sin_viaje_historico' | 'viaje_ambiguo' | 'sin_aviso_previo' | 'ok';
  viajeId?: string;
  operadorId?: string;
  viajeFolio?: string | null;
}

interface EventoConUnidad {
  evento: EventoSeguridadLeido;
  unidadId: string;
}

interface DrenajeGraves {
  disparos: number;
  backlog: boolean;
  error?: string;
}



/**
 * Resuelve al conductor point-in-time. `estatus` no participa: un backfill
 * histórico casi siempre pertenece a un viaje ya liquidado. Cero o más de un
 * viaje que cubra el día son ambiguos y se mandan a reparación, nunca se
 * sustituyen por el operador que conduce la unidad hoy.
 */
async function evaluarPrivacidadHistorica(
  tenantId: string,
  entradas: readonly EventoConUnidad[],
): Promise<{ porEvento: Map<string, EvaluacionPrivacidad>; error?: string }> {
  const porEvento = new Map<string, EvaluacionPrivacidad>();
  if (entradas.length === 0) return { porEvento };
  const { data: tenant, error: errorTenant } = await acotada(
    supabaseAdmin().from('tenant').select('zona_horaria').eq('id', tenantId).maybeSingle(),
    'eventos.privacidad_zona_tenant',
  );
  if (errorTenant) return { porEvento, error: `no se pudo leer la zona horaria del tenant: ${errorTenant.message}` };
  const zonaHoraria = String((tenant as { zona_horaria?: unknown } | null)?.zona_horaria ?? TZ_MX);
  try {
    diaEnZona(new Date(entradas[0].evento.ocurridoEn), zonaHoraria);
  } catch {
    return { porEvento, error: `zona horaria inválida: ${zonaHoraria}` };
  }
  const unidades = [...new Set(entradas.map((e) => e.unidadId))];
  const dias = entradas.map((e) => diaEnZona(new Date(e.evento.ocurridoEn), zonaHoraria)).sort();
  const maxOcurrido = entradas.map((e) => e.evento.ocurridoEn).sort().at(-1) as string;
  const viajes: Array<{
    id: unknown; folio: unknown; unidad_id: unknown; operador_id: unknown; fecha_inicio: unknown; fecha_fin: unknown; aceptado_en: unknown;
  }> = [];
  for (const tanda of enTandas(unidades, IDS_POR_CONSULTA)) {
    const { data, error } = await acotada(
      supabaseAdmin().from('viaje')
        .select('id, folio, unidad_id, operador_id, fecha_inicio, fecha_fin, aceptado_en')
        .eq('tenant_id', tenantId)
        .in('unidad_id', tanda)
        .or(`fecha_inicio.lte.${dias.at(-1)},and(fecha_inicio.is.null,aceptado_en.lte.${maxOcurrido})`)
        .or(`fecha_fin.is.null,fecha_fin.gte.${dias[0]}`),
      'eventos.privacidad_viajes_historicos',
    );
    if (error) return { porEvento, error: `no se pudo resolver el conductor histórico: ${error.message}` };
    viajes.push(...((data ?? []) as typeof viajes));
  }

  const operadores = [...new Set(viajes.map((v) => v.operador_id).filter(Boolean).map(String))];
  const avisos = new Map<string, string | null>();
  for (const tanda of enTandas(operadores, IDS_POR_CONSULTA)) {
    const { data, error } = await acotada(
      supabaseAdmin().from('operador')
        .select('id, aviso_privacidad_en')
        .eq('tenant_id', tenantId)
        .in('id', tanda),
      'eventos.privacidad_avisos_historicos',
    );
    if (error) return { porEvento, error: `no se pudo leer el aviso del conductor histórico: ${error.message}` };
    for (const o of (data ?? []) as Array<{ id: unknown; aviso_privacidad_en: unknown }>) {
      avisos.set(String(o.id), o.aviso_privacidad_en == null ? null : String(o.aviso_privacidad_en));
    }
  }

  for (const entrada of entradas) {
    const dia = diaEnZona(new Date(entrada.evento.ocurridoEn), zonaHoraria);
    const candidatos = viajes.filter((v) =>
      String(v.unidad_id) === entrada.unidadId && v.operador_id != null &&
      (v.fecha_inicio != null || v.aceptado_en != null) &&
      (v.fecha_inicio != null ? String(v.fecha_inicio) : diaEnZona(new Date(String(v.aceptado_en)), zonaHoraria)) <= dia &&
      (v.fecha_fin == null || String(v.fecha_fin) >= dia));
    if (candidatos.length === 0) {
      porEvento.set(entrada.evento.eventoId, { autorizado: false, motivo: 'sin_viaje_historico' });
      continue;
    }
    // La relación que se persiste es VIAJE→OPERADOR. Dos viajes que cubren el
    // mismo instante siguen siendo ambiguos aunque apunten al mismo chofer.
    if (candidatos.length !== 1) {
      porEvento.set(entrada.evento.eventoId, { autorizado: false, motivo: 'viaje_ambiguo' });
      continue;
    }
    const candidato = candidatos[0];
    const operadorId = String(candidato.operador_id);
    const aviso = avisos.get(operadorId);
    const autorizado = aviso != null && Date.parse(aviso) <= Date.parse(entrada.evento.ocurridoEn);
    porEvento.set(entrada.evento.eventoId, {
      autorizado,
      motivo: autorizado ? 'ok' : 'sin_aviso_previo',
      ...(autorizado ? {
        viajeId: String(candidato.id), operadorId,
        viajeFolio: candidato.folio == null ? null : String(candidato.folio),
      } : {}),
    });
  }
  return { porEvento };
}

function tokenCuarentena(tenantId: string, proveedor: string, eventoId: string): string {
  return `sha256:${createHash('sha256').update(`${tenantId}\n${proveedor}\n${eventoId}`).digest('hex')}`;
}

function horaOpaca(iso: string): string {
  const d = new Date(iso);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

async function guardarCuarentena(
  tenantId: string,
  proveedor: string,
  entradas: ReadonlyArray<{ evento: EventoSeguridadLeido; motivo: string; unidadId?: string | null }>,
): Promise<{ guardadas: number; error?: string }> {
  if (entradas.length === 0) return { guardadas: 0 };
  const filas = entradas.map(({ evento, motivo }) => ({
    tenant_id: tenantId,
    proveedor,
    evento_id_externo: tokenCuarentena(tenantId, proveedor, evento.eventoId),
    ocurrido_en: horaOpaca(evento.ocurridoEn),
    motivo,
    // Deliberadamente NO se guardan lat/lng, etiquetas, liga al video ni G.
    // La referencia permite releer al proveedor cuando se repare el mapeo o
    // la base legal, sin persistir el dato personal antes de autorizarlo.
    ...(motivo === 'payload_invalido' ? {
      muerto_en: new Date().toISOString(),
      ultimo_error: 'payload rechazado por validación defensiva',
    } : {}),
  }));
  const { data, error } = await acotada(
    supabaseAdmin().from('evento_seguridad_cuarentena')
      .upsert(filas, { onConflict: 'tenant_id,proveedor,evento_id_externo,motivo' })
      .select('evento_id_externo'),
    'eventos.cuarentena',
  );
  return error
    ? { guardadas: 0, error: `no se pudo dejar referencia durable en cuarentena: ${error.message}` }
    : { guardadas: (data ?? []).length };
}

interface CuarentenaReclamada {
  evento_id_externo: unknown;
  ocurrido_en: unknown;
  motivo: unknown;
  claim_token: unknown;
}

async function reclamarCuarentena(
  tenantId: string,
  proveedor: string,
): Promise<CuarentenaReclamada[]> {
  const admin = supabaseAdmin();
  if (typeof (admin as unknown as { rpc?: unknown }).rpc !== 'function') return [];
  const { data, error } = await acotada(admin.rpc('reclamar_cuarentena_eventos', {
    p_tenant: tenantId,
    p_proveedor: proveedor,
    p_limite: 10,
    p_worker: `${process.env.VERCEL_REGION ?? 'local'}:${process.pid}`,
    p_lease_segundos: 360,
  }), 'eventos.cuarentena_reclamar');
  if (error) throw new Error(`no se pudo reclamar cuarentena: ${error.message}`);
  return Array.isArray(data) ? data as CuarentenaReclamada[] : [];
}

async function finalizarCuarentena(
  tenantId: string,
  proveedor: string,
  claim: CuarentenaReclamada,
  resuelto: boolean,
  errorDetalle?: string,
): Promise<void> {
  const { data, error } = await acotada(supabaseAdmin().rpc('finalizar_cuarentena_evento', {
    p_tenant: tenantId,
    p_proveedor: proveedor,
    p_evento_id_externo: String(claim.evento_id_externo),
    p_motivo: String(claim.motivo),
    p_claim_token: String(claim.claim_token),
    p_resuelto: resuelto,
    p_error: errorDetalle?.slice(0, 1000) ?? null,
  }), 'eventos.cuarentena_finalizar');
  if (error || data !== true) {
    logger.warn('eventos.cuarentena_sello_fallo', {
      tenantId, proveedor, evento: claim.evento_id_externo,
      err: error?.message ?? 'lease vencido o ajeno',
    });
  }
}

async function releerCuarentena(
  tenantId: string,
  proveedor: string,
  lector: NonNullable<ReturnType<typeof lectorEventosDe>>,
  valores: Parameters<NonNullable<ReturnType<typeof lectorEventosDe>>>[0],
  http: Http,
  opciones: { venceEn?: number; ahoraMs: () => number; dormir?: (ms: number) => Promise<void> },
): Promise<{
  eventos: EventoSeguridadLeido[];
  claims: Map<string, CuarentenaReclamada[]>;
  paginas: number;
  backlog: boolean;
}> {
  const reclamadas = await reclamarCuarentena(tenantId, proveedor);
  const eventos: EventoSeguridadLeido[] = [];
  const claims = new Map<string, CuarentenaReclamada[]>();
  let paginas = 0;
  let backlog = false;
  for (const q of reclamadas) {
    if (opciones.venceEn !== undefined && opciones.ahoraMs() >= opciones.venceEn) {
      backlog = true;
      break;
    }
    const centro = Date.parse(String(q.ocurrido_en));
    const desde = new Date(centro - 5 * 60_000).toISOString();
    const hasta = new Date(centro + 65 * 60_000).toISOString();
    const r = await lector(valores, http, desde, {
      hastaIso: hasta, venceEn: opciones.venceEn, ahora: opciones.ahoraMs, dormir: opciones.dormir,
    });
    paginas += r.paginas ?? 0;
    if (!r.ok) {
      await finalizarCuarentena(tenantId, proveedor, q, false, r.motivo);
      continue;
    }
    const referencia = String(q.evento_id_externo);
    const encontrado = r.eventos.find((e) =>
      e.eventoId === referencia || tokenCuarentena(tenantId, proveedor, e.eventoId) === referencia);
    if (!encontrado) {
      await finalizarCuarentena(tenantId, proveedor, q, false, 'el proveedor no devolvió la referencia');
      continue;
    }
    eventos.push(encontrado);
    claims.set(encontrado.eventoId, [...(claims.get(encontrado.eventoId) ?? []), q]);
  }
  return { eventos, claims, paginas, backlog };
}

/** Claim atómico en producción. El camino sin RPC sólo mantiene compatibles
 * los dobles legacy de Vitest; fuera de test nunca se degrada a un SELECT. */
async function reclamarGraves(
  tenantId: string,
  proveedor: string,
): Promise<{ filas: GravePendiente[] } | { error: string }> {
  const admin = supabaseAdmin();
  const tieneRpc = typeof (admin as unknown as { rpc?: unknown }).rpc === 'function';
  if (tieneRpc) {
    const { data, error } = await acotada(admin.rpc('reclamar_eventos_seguridad', {
      p_tenant: tenantId,
      p_proveedor: proveedor,
      p_limite: EVENTOS_POR_CLAIM,
      p_worker: `${process.env.VERCEL_REGION ?? 'local'}:${process.pid}`,
      // Mayor que los 300 s máximos de la ruta, con recuperación del worker
      // muerto al minuto siguiente del kill duro.
      p_lease_segundos: 360,
    }), 'eventos.reclamar');
    if (error) return { error: error.message };
    if (!Array.isArray(data)) return { error: 'reclamar_eventos_seguridad devolvió otra forma' };
    return { filas: data as GravePendiente[] };
  }
  if (process.env.NODE_ENV !== 'test') return { error: 'el cliente Supabase no expone rpc' };
  const { data, error } = await acotada(
    admin.from('evento_seguridad_flota')
      .select('evento_id_externo, unidad_id, etiquetas, lat, lng, ocurrido_en, url_evento, max_g, viaje_id, operador_id, viaje_folio, intentos, privacidad_minima')
      .eq('tenant_id', tenantId)
      .eq('proveedor', proveedor)
      .eq('grave', true)
      .not('unidad_id', 'is', null)
      .is('procesado_en', null)
      .order('ocurrido_en', { ascending: true })
      .limit(EVENTOS_POR_CLAIM),
    'eventos.pendientes',
  );
  return error ? { error: error.message } : { filas: (data ?? []) as GravePendiente[] };
}

async function finalizarGrave(
  tenantId: string,
  proveedor: string,
  pendiente: GravePendiente,
  exito: boolean,
  incidenciaId: string | null,
  avisoEstado: 'no_requerido' | 'pending' | 'sent' | 'dead' | null,
  avisoOutboxId: string | null,
  avisoReceipt: string | null,
  errorDisparo: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = supabaseAdmin();
  if (typeof pendiente.claim_token === 'string') {
    const { data, error } = await acotada(admin.rpc('finalizar_evento_seguridad', {
      p_tenant: tenantId,
      p_proveedor: proveedor,
      p_evento_id_externo: String(pendiente.evento_id_externo),
      p_claim_token: pendiente.claim_token,
      p_exito: exito,
      p_incidencia_id: incidenciaId,
      p_aviso_estado: avisoEstado,
      p_aviso_outbox_id: avisoOutboxId,
      p_aviso_receipt: avisoReceipt,
      p_error: errorDisparo,
    }), 'eventos.finalizar');
    if (error) return { ok: false, error: error.message };
    return data === true ? { ok: true } : { ok: false, error: 'lease vencido o ajeno' };
  }
  if (!exito) return { ok: true };
  if (process.env.NODE_ENV !== 'test') return { ok: false, error: 'evento sin claim_token' };
  const { error } = await acotada(
    admin.from('evento_seguridad_flota')
      .update({
        procesado_en: avisoEstado === 'pending' ? null : new Date().toISOString(),
        incidencia_id: incidenciaId, aviso_estado: avisoEstado,
        aviso_outbox_id: avisoOutboxId, aviso_receipt: avisoReceipt,
      })
      .eq('tenant_id', tenantId)
      .eq('proveedor', proveedor)
      .eq('evento_id_externo', String(pendiente.evento_id_externo)),
    'eventos.sellar',
  );
  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * Outbox de asistencia independiente de la ingesta HTTP. Corre antes de leer
 * o descifrar credenciales: un 401/403/429 o un secreto corrupto jamás vuelve
 * a esconder un choque que Postgres ya recibió.
 */
async function drenarGravesPersistidos(
  tenantId: string,
  proveedor: string,
  opciones: { venceEn?: number; ahoraMs: () => number },
): Promise<DrenajeGraves> {
  const salida: DrenajeGraves = { disparos: 0, backlog: false };
  while (true) {
    if (opciones.venceEn !== undefined && opciones.ahoraMs() >= opciones.venceEn) {
      salida.backlog = true;
      return salida;
    }
    const pendientes = await reclamarGraves(tenantId, proveedor);
    if ('error' in pendientes) {
      logger.error('eventos.pendientes_ilegibles', { tenantId, proveedor, err: pendientes.error });
      return { ...salida, error: `no se pudieron reclamar los graves pendientes: ${pendientes.error}` };
    }
    if (pendientes.filas.length === 0) return salida;
    let falloSinBackoffSimulado = false;
    for (const p of pendientes.filas) {
      if (opciones.venceEn !== undefined && opciones.ahoraMs() >= opciones.venceEn) {
        salida.backlog = true;
        return salida;
      }
      const minimoInvalido = p.privacidad_minima === true && (
        typeof p.unidad_id !== 'string' || !p.unidad_id ||
        !Array.isArray(p.etiquetas) || p.etiquetas.length !== 0 ||
        [p.lat, p.lng, p.url_evento, p.max_g, p.viaje_id, p.operador_id, p.viaje_folio].some((v) => v !== null) ||
        !Number.isFinite(Date.parse(String(p.ocurrido_en))) ||
        Date.parse(String(p.ocurrido_en)) % 3_600_000 !== 0
      );
      const historicoInvalido = p.privacidad_minima === false && (!p.viaje_id || !p.operador_id);
      if (minimoInvalido || historicoInvalido) {
        await finalizarGrave(tenantId, proveedor, p, false, null, null, null, null,
          'el claim no cumple el contrato de privacidad');
        salida.backlog = true;
        salida.error = 'el claim no cumple el contrato de privacidad';
        if (typeof p.claim_token !== 'string') falloSinBackoffSimulado = true;
        continue;
      }
      const disparo = await dispararAsistenciaPorEventoCamara({
        tenantId,
        unidadId: String(p.unidad_id),
        proveedor,
        eventoIdExterno: String(p.evento_id_externo),
        etiquetas: (p.etiquetas as string[]) ?? [],
        lat: p.lat === null ? null : Number(p.lat),
        lng: p.lng === null ? null : Number(p.lng),
        ocurridoEn: String(p.ocurrido_en),
        urlEvento: (p.url_evento as string | null) ?? null,
        maxG: p.max_g === null ? null : Number(p.max_g),
        viajeId: p.viaje_id == null ? null : String(p.viaje_id),
        operadorId: p.operador_id == null ? null : String(p.operador_id),
        viajeFolio: p.viaje_folio == null ? null : String(p.viaje_folio),
        reintento: Number(p.intentos ?? 1) > 1,
      });
      if (disparo.resultado === 'fallo') {
        logger.warn('eventos.disparo_fallido', { tenantId, evento: p.evento_id_externo });
        const liberado = await finalizarGrave(
          tenantId, proveedor, p, false, disparo.incidenciaId ?? null,
          null, null, null, 'disparo fallido',
        );
        if (!liberado.ok) {
          logger.warn('eventos.liberacion_fallo', { tenantId, evento: p.evento_id_externo, err: liberado.error });
        }
        salida.backlog = true;
        // En producción el RPC impone siguiente_intento_en/DLQ. El fallback
        // de tests legacy no puede modelarlo: se termina DESPUÉS del lote para
        // no reclamar en caliente el mismo poison-pill.
        if (typeof p.claim_token !== 'string') falloSinBackoffSimulado = true;
        continue;
      }
      const sellado = await finalizarGrave(
        tenantId, proveedor, p, true, disparo.incidenciaId ?? null,
        disparo.avisoEstado === 'encolado' ? 'pending'
          : disparo.avisoEstado === 'enviado' ? 'sent'
            : disparo.avisoEstado === 'muerto' ? 'dead' : 'no_requerido',
        disparo.avisoOutboxId ?? null, disparo.avisoReceipt ?? null, null,
      );
      if (!sellado.ok) {
        logger.warn('eventos.sello_fallo', { tenantId, evento: p.evento_id_externo, err: sellado.error });
        salida.backlog = true;
        continue;
      }
      salida.disparos += 1;
    }
    if (falloSinBackoffSimulado) return salida;
  }
}

async function drenarOutboxesGlobales(
  opciones: { venceEn?: number; ahoraMs: () => number },
): Promise<ResultadoSyncEventos[]> {
  const admin = supabaseAdmin();
  if (typeof (admin as unknown as { rpc?: unknown }).rpc !== 'function') return [];
  const { data, error } = await acotada(admin.rpc('listar_outboxes_eventos_pendientes', {
    p_limite: 100,
  }), 'eventos.outboxes_globales');
  if (error) throw new Error(`no se pudieron listar outboxes de eventos: ${error.message}`);
  const pares = Array.isArray(data) ? data as Array<Record<string, unknown>> : [];
  const drenados = await conPool(pares, ANCHO_FANOUT_FLOTAS, async (par) => {
    const tenantId = String(par.tenant_id);
    const proveedor = String(par.proveedor);
    const drenaje = await drenarGravesPersistidos(tenantId, proveedor, opciones);
    return {
      tenantId, proveedor, leidos: 0, guardados: 0, huerfanos: 0,
      disparos: drenaje.disparos, backlog: drenaje.backlog,
      error: drenaje.error,
    } satisfies ResultadoSyncEventos;
  });
  return drenados.map((r, i) => 'ok' in r ? r.ok : ({
    tenantId: String(pares[i]?.tenant_id), proveedor: String(pares[i]?.proveedor),
    leidos: 0, guardados: 0, huerfanos: 0, disparos: 0, backlog: true,
    error: r.error instanceof Error ? r.error.message : String(r.error),
  }));
}

async function leerSaludOperativaEventos(): Promise<Array<Record<string, unknown>>> {
  const admin = supabaseAdmin();
  if (typeof (admin as unknown as { rpc?: unknown }).rpc !== 'function') return [];
  const { data, error } = await acotada(admin.rpc('estado_eventos_gps_operativo'), 'eventos.salud_operativa');
  if (error) throw new Error(`no se pudo leer la salud operativa de eventos: ${error.message}`);
  if (!Array.isArray(data)) throw new Error('estado_eventos_gps_operativo devolvió otra forma');
  return data as Array<Record<string, unknown>>;
}

/** Sincroniza los eventos de seguridad de UNA flota con UN proveedor. */
export async function sincronizarEventosDeFlota(
  tenantId: string,
  conectorId: string,
  valoresCifrados: string,
  http: Http,
  ahora: Date = new Date(),
  opciones: {
    desdeIso?: string;
    hastaIso?: string;
    venceEn?: number;
    ahoraMs?: () => number;
    dormir?: (ms: number) => Promise<void>;
    /** Sólo el carril tail drena el outbox al ejecutar dos ventanas seguidas. */
    drenarPendientes?: boolean;
  } = {},
): Promise<ResultadoSyncEventos> {
  const base: ResultadoSyncEventos = { tenantId, proveedor: conectorId, leidos: 0, guardados: 0, huerfanos: 0, disparos: 0 };

  const ahoraMs = opciones.ahoraMs ?? Date.now;
  if (opciones.drenarPendientes !== false) {
    const drenaje = await drenarGravesPersistidos(tenantId, conectorId, { venceEn: opciones.venceEn, ahoraMs });
    base.disparos = drenaje.disparos;
    if (drenaje.backlog) base.backlog = true;
    if (drenaje.error) return { ...base, error: drenaje.error };
  }
  if (opciones.venceEn !== undefined && ahoraMs() >= opciones.venceEn) {
    return { ...base, backlog: true, sinTurno: true };
  }

  const lector = lectorEventosDe(conectorId);
  if (!lector) return { ...base, error: `todavía no hay lector de eventos para ${conectorId}` };

  let valores;
  try {
    valores = descifrar(valoresCifrados);
  } catch (e) {
    return { ...base, error: `no se pudo descifrar la credencial: ${e instanceof Error ? e.message : String(e)}` };
  }

  const desde = opciones.desdeIso ?? new Date(ahora.getTime() - VENTANA_MS).toISOString();
  const hasta = opciones.hastaIso ?? ahora.toISOString();
  let recuperados: Awaited<ReturnType<typeof releerCuarentena>> = {
    eventos: [], claims: new Map(), paginas: 0, backlog: false,
  };
  try {
    recuperados = await releerCuarentena(
      tenantId, conectorId, lector, valores, http,
      { venceEn: opciones.venceEn, ahoraMs, dormir: opciones.dormir },
    );
  } catch (e) {
    logger.warn('eventos.cuarentena_relectura_fallo', {
      tenantId, proveedor: conectorId, err: e instanceof Error ? e.message : String(e),
    });
  }
  if (recuperados.backlog) base.backlog = true;
  if (opciones.venceEn !== undefined && ahoraMs() >= opciones.venceEn) {
    return { ...base, backlog: true, sinTurno: true };
  }
  const r = await lector(valores, http, desde, {
    hastaIso: hasta, venceEn: opciones.venceEn, ahora: ahoraMs, dormir: opciones.dormir,
  });
  if (!r.ok) {
    if (r.sinPermiso) {
      // No es un fallo de la corrida: es una credencial a la que le falta un
      // scope. Se reporta con nombre para que el panel y el dueño lo vean.
      logger.warn('eventos.sin_permiso', { tenantId, proveedor: conectorId });
      return { ...base, sinPermiso: true, paginas: r.paginas, backlog: r.backlog, error: r.motivo };
    }
    return { ...base, paginas: r.paginas, backlog: r.backlog, error: r.motivo };
  }

  base.paginas = r.paginas + recuperados.paginas;
  const combinados = [...new Map(
    [...recuperados.eventos, ...r.eventos].map((e) => [e.eventoId, e]),
  ).values()];
  const eventos = combinados.filter(eventoValido);
  const eventosInvalidos = combinados.filter((e) => !eventoValido(e));
  base.invalidos = (r.invalidos ?? 0) + eventosInvalidos.length;
  base.leidos = eventos.length;
  if ((base.invalidos ?? 0) > 0) {
    const cuarentena = await guardarCuarentena(
      tenantId, conectorId,
      eventosInvalidos.map((evento) => ({ evento, motivo: 'payload_invalido' })),
    );
    if (cuarentena.error) return { ...base, backlog: true, error: cuarentena.error };
    base.cuarentena = (base.cuarentena ?? 0) + cuarentena.guardadas;
    logger.error('eventos.payload_invalido_dlq', {
      tenantId, proveedor: conectorId, invalidos: base.invalidos,
    });
  }
  if (eventos.length > 0) {
    base.ultimaMedidaEn = eventos.reduce((max, e) => Date.parse(e.ocurridoEn) > Date.parse(max) ? e.ocurridoEn : max, eventos[0].ocurridoEn);
  }
  // OJO: una ventana vacía NO regresa temprano — el barrido de graves
  // pendientes (abajo) tiene que correr aunque hoy no haya eventos nuevos:
  // ahí es donde se reintenta el disparo que falló hace dos corridas.

  // ── ASSET → UNIDAD, filtrando por flota (mismo candado que posiciones) ──
  const ids = [...new Set(eventos.map((e) => e.assetId).filter((x): x is string => x !== null))];
  const porDevice = new Map<string, string>();
  for (let i = 0; i < ids.length; i += IDS_POR_CONSULTA) {
    if (opciones.venceEn !== undefined && ahoraMs() >= opciones.venceEn) {
      return { ...base, backlog: true, error: 'quedó mapeo de unidades pendiente al vencer el presupuesto' };
    }
    const { data: unidades, error: errU } = await acotada(
      supabaseAdmin().from('unidad')
        .select('id, gps_device_id')
        .eq('tenant_id', tenantId)
        .eq('gps_proveedor', conectorId)
        .in('gps_device_id', ids.slice(i, i + IDS_POR_CONSULTA)),
      'eventos.unidades',
    );
    if (errU) return { ...base, error: `no se pudieron leer las unidades: ${errU.message}` };
    for (const u of unidades ?? []) {
      if (u.gps_device_id) porDevice.set(String(u.gps_device_id), String(u.id));
    }
  }

  // La privacidad se decide con el viaje que cubría ocurrido_en, incluyendo
  // viajes liquidados. Nunca con el operador vivo actual de la unidad.
  const conUnidad: EventoConUnidad[] = eventos.flatMap((evento) => {
    const unidadId = evento.assetId ? porDevice.get(evento.assetId) : undefined;
    return unidadId ? [{ evento, unidadId }] : [];
  });
  const privacidad = await evaluarPrivacidadHistorica(tenantId, conUnidad);
  if (privacidad.error) {
    // La incertidumbre bloquea los datos de cámara y el watermark, pero no
    // impide registrar una alerta mínima por unidad para asistencia.
    base.backlog = true;
    base.error = privacidad.error;
  }

  const filas: Array<Record<string, unknown>> = [];
  const paraCuarentena: Array<{ evento: EventoSeguridadLeido; motivo: string; unidadId?: string | null }> = [];
  const unidadesSinAviso = new Set<string>();
  for (const e of eventos) {
    const unidadId = e.assetId ? porDevice.get(e.assetId) ?? null : null;
    if (!unidadId) {
      base.huerfanos += 1;
      const referenciaIncompleta = e.assetId === null;
      if (referenciaIncompleta) {
        base.referenciasIrrecuperables = (base.referenciasIrrecuperables ?? 0) + 1;
        base.backlog = true;
        base.error ??= 'Samsara devolvió una referencia sin asset; la ventana no puede declararse completa.';
      }
      paraCuarentena.push({ evento: e, motivo: referenciaIncompleta ? 'referencia_incompleta' : 'unidad_sin_mapear' });
      continue;
    }
    const evaluacion = privacidad.porEvento.get(e.eventoId);
    if (!evaluacion?.autorizado) {
      unidadesSinAviso.add(unidadId);
      paraCuarentena.push({
        evento: e,
        motivo: evaluacion?.motivo ?? 'sin_viaje_historico',
        unidadId,
      });
      if (esEventoGrave(e.etiquetas)) {
        filas.push({
          tenant_id: tenantId, proveedor: conectorId,
          // Clave operativa estable: evita una segunda asistencia cuando la
          // misma referencia reaparece con autorización. No es anonimización.
          evento_id_externo: e.eventoId, unidad_id: unidadId,
          privacidad_minima: true, grave: true, ocurrido_en: horaOpaca(e.ocurridoEn),
          asset_id: null, etiquetas: [], lat: null, lng: null,
          url_evento: null, max_g: null, viaje_id: null, operador_id: null, viaje_folio: null,
        });
      }
      continue;
    }
    filas.push({
      privacidad_minima: false,
      tenant_id: tenantId,
      proveedor: conectorId,
      evento_id_externo: e.eventoId,
      asset_id: e.assetId,
      unidad_id: unidadId,
      etiquetas: e.etiquetas,
      grave: esEventoGrave(e.etiquetas),
      lat: e.lat,
      lng: e.lng,
      ocurrido_en: e.ocurridoEn,
      url_evento: e.urlEvento,
      max_g: e.maxG,
      viaje_id: evaluacion.viajeId,
      operador_id: evaluacion.operadorId,
      viaje_folio: evaluacion.viajeFolio ?? null,
    });
  }

  if (unidadesSinAviso.size > 0) {
    base.sinAvisoPrevio = unidadesSinAviso.size;
    logger.warn('eventos.sin_aviso_previo', {
      tenantId, proveedor: conectorId, unidades: unidadesSinAviso.size,
    });
  }
  const cuarentena = await guardarCuarentena(tenantId, conectorId, paraCuarentena);
  if (cuarentena.error) return { ...base, backlog: true, error: cuarentena.error };
  base.cuarentena = (base.cuarentena ?? 0) + cuarentena.guardadas;

  // PostgREST recibe tandas: 5,000 eventos ya no son 5,000 round-trips. El
  // RETURNING permite contar sólo las filas insertadas; los duplicados de la
  // ventana quedan fuera por ignoreDuplicates.
  for (const tanda of enTandas(filas, EVENTOS_POR_UPSERT)) {
    if (opciones.venceEn !== undefined && ahoraMs() >= opciones.venceEn) {
      return { ...base, backlog: true, error: 'quedaron eventos por guardar al vencer el presupuesto' };
    }
    const { data: insertadas, error: errIns } = await acotada(
      supabaseAdmin().from('evento_seguridad_flota')
        .upsert(tanda, { onConflict: 'tenant_id,proveedor,evento_id_externo', ignoreDuplicates: true })
        .select('id, evento_id_externo'),
      'eventos.guardar',
    );
    if (errIns) {
      logger.error('eventos.tanda_no_guardada', { tenantId, proveedor: conectorId, eventos: tanda.length, err: errIns.message });
      // P0: una escritura fallida jamás puede finalizar el poll como completo
      // ni avanzar el watermark más allá de eventos que no llegaron a DB.
      return { ...base, backlog: true, error: `no se pudo guardar una tanda de eventos: ${errIns.message}` };
    }
    base.guardados += (insertadas ?? []).length;
  }

  // Una fila legacy con unidad_id=NULL ya ocupa la llave única. El upsert con
  // ignoreDuplicates no puede repararla, por eso los eventos recuperados
  // actualizan explícitamente esa misma fila después de pasar privacidad.
  // Una alerta mínima no resuelve el permiso del dato original. Tampoco
  // debe enriquecerse al reparar otra referencia del mismo evento.
  const persistidos = new Set(filas.filter((f) => f.privacidad_minima === false)
    .map((f) => String(f.evento_id_externo)));
  const recuperadosUnicos = [...new Map(
    recuperados.eventos.map((evento) => [evento.eventoId, evento]),
  ).values()];
  for (const e of recuperadosUnicos.filter((evento) => persistidos.has(evento.eventoId))) {
    const unidadId = e.assetId ? porDevice.get(e.assetId) : null;
    const { error } = await acotada(
      supabaseAdmin().from('evento_seguridad_flota')
        .update({
          unidad_id: unidadId, asset_id: e.assetId,
          viaje_id: privacidad.porEvento.get(e.eventoId)?.viajeId ?? null,
          operador_id: privacidad.porEvento.get(e.eventoId)?.operadorId ?? null,
          viaje_folio: privacidad.porEvento.get(e.eventoId)?.viajeFolio ?? null,
        })
        .eq('tenant_id', tenantId)
        .eq('proveedor', conectorId)
        .eq('evento_id_externo', e.eventoId)
        .eq('privacidad_minima', false),
      'eventos.reparar_legacy_null',
    );
    const claims = recuperados.claims.get(e.eventoId) ?? [];
    if (error) {
      for (const claim of claims) await finalizarCuarentena(tenantId, conectorId, claim, false, error.message);
    } else {
      for (const claim of claims) await finalizarCuarentena(tenantId, conectorId, claim, true);
    }
  }
  for (const [eventoId, claims] of recuperados.claims) {
    if (!persistidos.has(eventoId)) {
      for (const claim of claims) {
        await finalizarCuarentena(tenantId, conectorId, claim, false, 'mapeo o privacidad aún sin resolver');
      }
    }
  }

  // Segunda pasada: recoge los graves que esta misma ingesta acaba de
  // insertar. La primera pasada, arriba, garantiza que lo previamente durable
  // no dependa de que la credencial o el proveedor funcionen hoy.
  const drenajeNuevo = await drenarGravesPersistidos(
    tenantId, conectorId, { venceEn: opciones.venceEn, ahoraMs },
  );
  base.disparos += drenajeNuevo.disparos;
  if (drenajeNuevo.backlog) base.backlog = true;
  if (drenajeNuevo.error && !base.error) base.error = drenajeNuevo.error;

  if (base.huerfanos > 0) {
    logger.warn('eventos.huerfanos', { tenantId, proveedor: conectorId, huerfanos: base.huerfanos });
  }
  return base;
}

/**
 * Drena primero el outbox global y luego sincroniza las flotas con credencial
 * activa. Se llama desde el cron de GPS antes de las posiciones.
 *
 * ── EL RELOJ (patrón del PR #152 / `vigilarPortales`) ─────────────────────
 * El `venceEn` es EL MISMO que el de las posiciones (molde de `descarga-sat`:
 * un reloj compartido entre las dos fases en serie, para que ninguna se coma
 * a ciegas el presupuesto de la otra). El corte va ANTES de despachar cada
 * flota, nunca a media flota; una flota sin turno sale con `sinTurno: true` y
 * el cron late `parcial`. Es lo que faltaba del arreglo c2-1: la recuperación
 * idempotente ya existía (rebarrido de graves), pero el kill de Vercel a media
 * corrida seguía siendo posible y MUDO — sin latido y sin barrido de graves.
 */
export async function sincronizarEventosTodas(
  http: Http,
  opts: { venceEn?: number; ahora?: () => number } = {},
): Promise<ResultadoSyncEventos[]> {
  const ahora = opts.ahora ?? Date.now;
  // La primera ventana queda fijada DURABLEMENTE al crear el estado. Si el
  // token devuelve 403 durante días, la reparación retoma ese mismo punto en
  // vez de recalcular "ahora - 30 min" y perder historia. Samsara documenta
  // startTime RFC3339 sin máximo para este stream; acotamos cada segmento para
  // no intentar ingerir 30 días en una sola función.
  const backfillHoras = horasConfiguradas('GPS_EVENTOS_BACKFILL_HORAS', 24 * 30, 24 * 365);
  const segmentoHoras = horasConfiguradas('GPS_EVENTOS_SEGMENTO_HORAS', 6, 24);
  const instanteClaim = ahora();
  const bootstrapDesde = new Date(instanteClaim - backfillHoras * 60 * 60 * 1000).toISOString();
  // Primero el outbox global: no consulta credenciales y por tanto sigue
  // funcionando después de desactivar o borrar el token del proveedor.
  const outboxes = await drenarOutboxesGlobales({ venceEn: opts.venceEn, ahoraMs: ahora });
  const credenciales = await reclamarPolls(
    'eventos', Object.keys(LECTORES_EVENTOS), ANCHO_FANOUT_FLOTAS, { bootstrapDesde },
  );
  const resultados = await conPool(credenciales, ANCHO_FANOUT_FLOTAS, async (c) => {
    // El reloj se mira ANTES de despachar cada flota, no una vez al principio:
    // el patrón de `conRelojDuro`/`vigilarPortales`.
    if (opts.venceEn !== undefined && ahora() >= opts.venceEn) {
      const sinTurno = {
        tenantId: c.tenantId, proveedor: c.proveedor,
        leidos: 0, guardados: 0, huerfanos: 0, disparos: 0, sinTurno: true,
      } satisfies ResultadoSyncEventos;
      await finalizarPoll('eventos', c, { completo: false, error: 'sin turno por reloj' });
      return sinTurno;
    }
    const ahoraReal = ahora();

    // Carril reciente independiente y prioritario. Una credencial recién
    // activada ve el choque actual en esta primera corrida, aunque conserve
    // treinta días de backfill por recorrer.
    const tailWatermarkMs = c.tailWatermarkEn ? Date.parse(c.tailWatermarkEn) : NaN;
    const tailBaseMs = Number.isFinite(tailWatermarkMs)
      ? tailWatermarkMs
      : ahoraReal - VENTANA_MS;
    const tailDesdeIso = new Date(Math.max(
      0, tailBaseMs - (c.tailWatermarkEn ? SOLAPE_WATERMARK_MS : 0),
    )).toISOString();
    const tailHastaIso = new Date(ahoraReal).toISOString();
    const tail = await sincronizarEventosDeFlota(
      c.tenantId, c.proveedor, c.valoresCifrados, http, new Date(ahoraReal),
      {
        desdeIso: tailDesdeIso, hastaIso: tailHastaIso,
        venceEn: opts.venceEn, ahoraMs: ahora, drenarPendientes: false,
      },
    );
    const tailCompleto = !tail.error && !tail.sinTurno;

    const watermarkMs = c.watermarkEn ? Date.parse(c.watermarkEn) : NaN;
    const baseDesdeMs = Number.isFinite(watermarkMs)
      ? watermarkMs
      : ahoraReal - backfillHoras * 60 * 60 * 1000;
    const desdeIso = new Date(Math.max(0, baseDesdeMs - (c.watermarkEn ? SOLAPE_WATERMARK_MS : 0))).toISOString();
    const hastaMs = Math.min(ahoraReal, baseDesdeMs + segmentoHoras * 60 * 60 * 1000);
    const hastaIso = new Date(hastaMs).toISOString();
    let historico: ResultadoSyncEventos = {
      tenantId: c.tenantId, proveedor: c.proveedor,
      leidos: 0, guardados: 0, huerfanos: 0, disparos: 0,
      backlog: true,
    };
    if (tailCompleto && (opts.venceEn === undefined || ahora() < opts.venceEn)) {
      historico = await sincronizarEventosDeFlota(
        c.tenantId, c.proveedor, c.valoresCifrados, http, new Date(hastaMs),
        { desdeIso, hastaIso, venceEn: opts.venceEn, ahoraMs: ahora, drenarPendientes: false },
      );
    }
    // Huérfanos y bloqueos de privacidad tienen una referencia mínima en
    // cuarentena; un payload malformado queda en DLQ con métrica. Ninguno
    // congela el cursor de ingesta ni oculta los eventos posteriores.
    const completo = tailCompleto && !historico.error && !historico.sinTurno;
    const medidas = [tail.ultimaMedidaEn, historico.ultimaMedidaEn]
      .filter((v): v is string => !!v).sort();
    const resultado: ResultadoSyncEventos = {
      tenantId: c.tenantId,
      proveedor: c.proveedor,
      leidos: tail.leidos + historico.leidos,
      guardados: tail.guardados + historico.guardados,
      huerfanos: tail.huerfanos + historico.huerfanos,
      disparos: tail.disparos + historico.disparos,
      paginas: (tail.paginas ?? 0) + (historico.paginas ?? 0),
      invalidos: (tail.invalidos ?? 0) + (historico.invalidos ?? 0),
      cuarentena: (tail.cuarentena ?? 0) + (historico.cuarentena ?? 0),
      sinAvisoPrevio: (tail.sinAvisoPrevio ?? 0) + (historico.sinAvisoPrevio ?? 0),
      ultimaMedidaEn: medidas.at(-1),
      backlog: tail.backlog || historico.backlog || !completo,
      sinTurno: tail.sinTurno || historico.sinTurno,
      sinPermiso: tail.sinPermiso || historico.sinPermiso,
      error: tail.error ?? historico.error,
    };
    try {
      await finalizarPoll('eventos', c, {
        completo,
        watermarkEn: completo ? hastaIso : null,
        tailCompleto,
        tailWatermarkEn: tailCompleto ? tailHastaIso : null,
        ultimaMedidaEn: resultado.ultimaMedidaEn,
        paginas: resultado.paginas,
        elementos: resultado.leidos + (resultado.invalidos ?? 0),
        invalidos: resultado.invalidos,
        error: resultado.error ?? (!completo ? 'poll de eventos incompleto' : undefined),
      });
      if (!completo) resultado.backlog = true;
      return resultado;
    } catch (e) {
      return { ...resultado, backlog: true, error: `no se pudo finalizar el estado durable: ${e instanceof Error ? e.message : String(e)}` };
    }
  });
  const salida: ResultadoSyncEventos[] = resultados.map((r, i): ResultadoSyncEventos => {
    if ('ok' in r) return r.ok;
    const c = credenciales[i];
    return {
      tenantId: c.tenantId, proveedor: c.proveedor,
      leidos: 0, guardados: 0, huerfanos: 0, disparos: 0,
      error: r.error instanceof Error ? r.error.message : String(r.error),
    };
  });
  const outboxesPorPar = new Map(outboxes.map((r) => [`${r.tenantId}|${r.proveedor}`, r]));
  for (const r of salida) {
    const previo = outboxesPorPar.get(`${r.tenantId}|${r.proveedor}`);
    if (!previo) continue;
    r.disparos += previo.disparos;
    r.backlog = r.backlog || previo.backlog;
    r.error ??= previo.error;
    outboxesPorPar.delete(`${r.tenantId}|${r.proveedor}`);
  }
  salida.push(...outboxesPorPar.values());
  const salud = await leerSaludOperativaEventos();
  const saludPorPar = new Map(salud.map((m) => [`${String(m.tenant_id)}|${String(m.proveedor)}`, m]));
  const paresEnSalida = new Set(salida.map((r) => `${r.tenantId}|${r.proveedor}`));
  for (const [llave, m] of saludPorPar) {
    if (paresEnSalida.has(llave)) continue;
    salida.push({
      tenantId: String(m.tenant_id), proveedor: String(m.proveedor),
      leidos: 0, guardados: 0, huerfanos: 0, disparos: 0,
    });
  }
  for (const r of salida) {
    const m = saludPorPar.get(`${r.tenantId}|${r.proveedor}`);
    if (!m) continue;
    r.eventosEnCuarentena = Number(m.eventos_en_cuarentena ?? 0);
    r.eventosCuarentenaMuertos = Number(m.eventos_cuarentena_muertos ?? 0);
    r.eventosOutboxPendientes = Number(m.eventos_outbox_pendientes ?? 0);
    r.eventosOutboxMuertos = Number(m.eventos_outbox_muertos ?? 0);
    r.avisosPendientes = Number(m.avisos_pendientes ?? 0);
    r.avisosMuertos = Number(m.avisos_muertos ?? 0);
  }
  const sinTurno = salida.filter((r) => r.sinTurno).length;
  if (sinTurno > 0) {
    // WARN con nombre propio: aquí lo que se queda sin correr es el barrido de
    // graves (choque/volcadura). La corrida siguiente lo rebarre — pero se dice.
    logger.warn('eventos.corte_por_reloj', { sinTurno, flotas: salida.length });
  }
  return salida;
}
