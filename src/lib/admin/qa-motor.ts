// ═══════════════════════════════════════════════════════════════════════════
// PANEL DE QA — el motor del CARRIL RÁPIDO (Fase A). SOLO servidor.
//
// Corre EN PROCESO, dentro de la misma app de Next.js, el mismo camino que el
// agente Operador de la Fase 1 del ejército (scripts/qa-agentes/) ejercita
// bajo vitest: sembrar un tenant ZZZ QA, mandar fotos y textos por
// `processInbound` — LA función de producción, importada tal cual, jamás una
// copia — y dejar que los oráculos (funciones puras) juzguen la base.
//
// La diferencia con el ejército es UNA: aquí no hay vi.mock (no existe en el
// runtime de Next), así que la foto entra por `InboundMessage.mediaDataUrlQA`
// (el gancho aditivo documentado en processor.ts y en 00-PANEL-DE-QA.md §3).
// Los envíos salientes SÍ se interceptan (ADM-3, auditoría 24):
// `instalarInterceptorSalidaMeta` desvía cualquier POST a `graph.facebook.com`
// antes de que salga a la red — ya no depende de que el número esté en modo
// PRUEBA de Meta (#131030), condición que desaparece en cuanto la WABA del
// piloto pase a producción. Queda registrado en `wa_outbox` (`estado='dead'`,
// `ultimo_error` con prefijo `QA:`) y nunca lo reclama el cron real; la
// evidencia de qué contestó el sistema se sigue leyendo de
// `wa_conversacion.estado.turns`, que el pipeline persiste solo.
//
// Guard reutilizado tal cual del ejército: `exigirTenantZZZ` /
// `exigirPrefijoQA` (scripts/qa-agentes/config.qa.ts) ANTES de cualquier
// borrado en lote. La captura de bitácora se reimplementa mínima aquí (no se
// puede importar `capturarBitacora` de agentes/operador.qa.ts: ese módulo
// importa vitest en su primera línea).
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { processInbound } from '@/lib/likida/processor';
import { logger } from '@/lib/logger';
import { hoyMx } from '@/lib/formato';
import { ahoraMs } from '@/lib/saludo';
import {
  exigirTenantZZZ, exigirPrefijoQA, PREFIJO_QA, TOPE_CORRIDA_USD,
} from '../../../scripts/qa-agentes/config.qa';
import { relojAgotado } from '@/lib/likida/agentes/runner';
// La MISMA noción de firma que los agentes de ingeniería (PR #183): uuids,
// números y fechas fuera, para que 10 fallos del mismo bug sean UN patrón y no
// 10 fotos malas sueltas. Se importa en vez de reescribirse — dos copias del
// mismo normalizador divergen en silencio.
import { firmaDeError } from '@/lib/likida/agentes/ingenieria_producto';
import { porcentaje } from '@/lib/formato';
import { correrOraculos } from './qa-oraculos';
import { escenarioPorId, idsParaActoFotos, idFotoTrasCierre, type PasoGuion } from './qa-escenarios';
import { medirCorrida } from './qa-medicion';
import { agregar } from './qa-verdad';
import {
  dataUrlDeFoto, guardarCorrida, leerManifiesto, leerCorrida, gastoHoyUsd,
  tomarPasada, soltarPasada, tomarFoto, cerrarFoto, leerFotosDeCorrida,
  marcarInterrumpidas,
} from './qa-storage';
import {
  estadoFinalDe, resumirAvance, carrilPara, reservaPorFotoMs,
  motivoTopeDinero, motivoCorteReloj, MAX_EVENTOS_MEMORIA, TOPE_DIA_USD,
  type CorridaQA, type EscenarioId, type ParametrosCorrida, type PasoQA, type TurnoConversacion,
  type Carril, type CorteCorrida, type MemoriaCorrida, type AvanceFotos, type FotoBanco,
  type EstadoFotoCorrida,
} from './qa-tipos';

// El tope DIARIO vive en qa-tipos.ts (client-safe, el botón lo enseña); el
// tope POR corrida se reusa del ejército: TOPE_CORRIDA_USD (config.qa.ts, $2).
export { TOPE_DIA_USD } from './qa-tipos';

/** Techo de TIEMPO del carril rápido: por debajo del maxDuration de la ruta
 *  (120 s — el mismo techo probado del webhook), con margen para que el
 *  aborto se ESCRIBA en vez de que Vercel mate la función a media corrida.
 *  Si el plan de Vercel permite maxDuration mayor, esto sube junto con él. */
export const TECHO_CORRIDA_MS = 110_000;

/** Margen mínimo para arrancar un mensaje más: un processInbound puede tomar
 *  hasta su propio presupuesto (~60 s), así que no se arranca con menos que
 *  esto de sobra. */
const MARGEN_MENSAJE_MS = 20_000;

// ── Identidades sintéticas (puras, con prueba) ──────────────────────────────

/** Nombre del tenant de la corrida: SIEMPRE empieza con 'ZZZ ' — es la llave
 *  del guard del ejército y del criterio de limpieza. UUID nuevo por corrida
 *  (no el fijo de carga-15k.sql) para permitir corridas simultáneas. */
export function nombreTenantQa(corridaId: string): string {
  return `ZZZ QA ${corridaId.slice(0, 8)}`;
}

/** Teléfono del rango imposible 5215559xxxxxx (criterio de carga-15k.sql),
 *  derivado del id de la corrida en el sub-rango 1xxxxx–8xxxxx para no chocar
 *  ni con ZZZ CARGA (000001..000200) ni con el ejército (9xxxxx). Determinista
 *  por corrida; corridas distintas casi nunca chocan y, si chocaran,
 *  `resolveOperador` lo diría (OperadorAmbiguo) en vez de cruzar tenants. */
export function telefonoQa(corridaId: string, indice = 0): string {
  const hex = corridaId.replace(/-/g, '').slice(0, 10);
  const n = 100_000 + ((parseInt(hex, 16) + indice) % 800_000);
  return `5215559${String(n).padStart(6, '0')}`;
}

/** Prefijo de los waMessageId de UNA corrida — bajo el PREFIJO_QA del
 *  ejército, con el id corto para poder limpiar SOLO los claims propios. */
export function prefijoMensajes(corridaId: string): string {
  return `${PREFIJO_QA}P${corridaId.slice(0, 8)}-`;
}

/** La corrida recién nacida, lista para guardarse antes de ejecutar. El carril
 *  se pasa explícito (el validador ya lo decidió); sin él, el que le toque al
 *  número de fotos — la MISMA función que usa el formulario. */
export function crearCorrida(
  escenario: EscenarioId, params: ParametrosCorrida, carril?: Carril,
): CorridaQA {
  const id = randomUUID();
  const ahora = new Date().toISOString();
  return {
    id, escenario, carril: carril ?? carrilPara(params.fotoIds.length), parametros: params,
    estado: 'pendiente', motivo: null,
    tenantId: null, tenantNombre: nombreTenantQa(id),
    creadaEn: ahora, inicio: null, fin: null, latidoEn: ahora,
    pasos: [], costoUsdTotal: 0, veredicto: null, turnos: [], pdfs: [], limpieza: null,
    fase: 'siembra', corte: null, pasadas: 0, pasadaEnVuelo: null, memoria: null,
    avance: null,
  };
}

// ── Captura de bitácora (mínima; ver cabecera por qué no se importa) ────────

interface EventoCapturado { nivel: 'info' | 'warn' | 'error'; msg: string; meta?: Record<string, unknown> }

function capturarBitacora(): { eventos: EventoCapturado[]; restaurar: () => void } {
  const eventos: EventoCapturado[] = [];
  const originales = { info: logger.info, warn: logger.warn, error: logger.error };
  (['info', 'warn', 'error'] as const).forEach((nivel) => {
    logger[nivel] = (m: string, meta?: Record<string, unknown>) => {
      eventos.push({ nivel, msg: m, meta });
      return originales[nivel](m, meta);
    };
  });
  return {
    eventos,
    restaurar: () => {
      logger.info = originales.info;
      logger.warn = originales.warn;
      logger.error = originales.error;
    },
  };
}

// ── Interceptor de salida a Meta (ADM-3, auditoría 24) ──────────────────────
//
// Antes de esto, `processInbound` mandaba las respuestas de una corrida QA
// por `fetch` real a `graph.facebook.com` — la ÚNICA barrera era que el
// número de PRUEBA de Meta rechazara al destinatario sintético (#131030). En
// cuanto la WABA del piloto pase a producción esa barrera desaparece y cada
// corrida intenta mandar WhatsApp de verdad a números `5215559…`.
//
// Mismo patrón que `capturarBitacora`: instala, corre, `restaurar()` en el
// `finally` de la corrida — jamás una copia del cliente Meta, solo una
// desviación de `fetch` mientras el motor de QA está vivo. Cualquier POST a
// `graph.facebook.com` se desvía ANTES de tocar la red: se registra en
// `wa_outbox` con `estado='dead'` (valor ya permitido por el CHECK de la
// 0180 — no hace falta migración para esto) y `ultimo_error` con el prefijo
// `QA:`, así que nunca la reclama `reclamar_wa_outbox` (solo toma
// `pending`/`sending`) y queda distinguible de un fallo real de Meta. Se
// responde un 200 sintético con la forma que `client.ts` espera
// (`messages:[{id}]`) para que el resto del pipeline —que sí lee el
// wamid— no truene.
const HOST_META_GRAPH = 'graph.facebook.com';

export function instalarInterceptorSalidaMeta(corridaId: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    let host: string;
    try { host = new URL(url).hostname.replace(/\.$/, ''); } catch { return original(input, init); }
    const solicitud = input instanceof Request ? input : null;
    const metodo = (init?.method ?? solicitud?.method ?? 'GET').toUpperCase();
    if (host !== HOST_META_GRAPH || metodo !== 'POST') {
      return original(input, init);
    }
    let payload: Record<string, unknown> = {};
    try {
      // init prevalece como en fetch. Leer una copia conserva el Request
      // original para el llamador; nunca se envía a Meta para capturarlo.
      const cuerpo = init?.body != null ? await new Response(init.body).text()
        : solicitud ? await solicitud.clone().text() : '';
      payload = cuerpo ? JSON.parse(cuerpo) : {};
    } catch { /* cuerpo no-JSON: se registra vacío, no se aborta la corrida por esto */ }
    try {
      const { error } = await supabaseAdmin().from('wa_outbox').insert({
        payload,
        estado: 'dead',
        ultimo_error: `QA: corrida ${corridaId} — interceptado, nunca se mandó a Meta`.slice(0, 500),
      });
      if (error) logger.error('qa.interceptor_no_registrado', { corridaId, err: error.message });
    } catch (e) {
      logger.error('qa.interceptor_no_registrado', { corridaId, err: e instanceof Error ? e.message : String(e) });
    }
    return new Response(JSON.stringify({ messages: [{ id: `qa_${randomUUID()}` }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

// ── El renglón del paso de medición del OCR ─────────────────────────────────

/** Traduce el resultado de `medirCorrida` al renglón que la pantalla enseña.
 *  El número se dice con su denominador y sus fuera-de-denominador; un fallo
 *  se dice entero — jamás un paso "ok" sobre una medición que no se escribió. */
function detalleMedicion(r: Awaited<ReturnType<typeof medirCorrida>>): { estado: PasoQA['estado']; detalle: string } {
  if (!r.ok) {
    return { estado: 'bad', detalle: `la medición no se pudo hacer: ${r.error} — el gasto de la corrida quedó sin comparar contra la verdad-de-terreno` };
  }
  const res = agregar(r.datos.lecturas.map((l) => l.medicion));
  const exact = res.exactitud === null
    ? 'sin campos medidos — no hay porcentaje que decir'
    : `exactitud ${porcentaje(res.exactitud * 100)} sobre ${res.medidos} campos (✅ ${res.ok} · ❌ ${res.mal} · fuera del denominador ${res.noMedidos})`;
  const base = `${r.datos.medidas} lecturas nuevas, ${r.datos.yaMedidas} ya medidas · ${exact}`;
  return r.datos.fallos.length === 0
    ? { estado: 'ok', detalle: base }
    : { estado: 'warn', detalle: `${base} · ${r.datos.fallos.length} SIN escribir: ${r.datos.fallos.join('; ')}` };
}

// ── Siembra (mismo patrón que el orquestador del ejército) ──────────────────

async function sembrarTenant(db: SupabaseClient, corrida: CorridaQA): Promise<{
  tenantId: string; operadorId: string; viajeId: string; telefono: string;
  operador2Id: string | null; viaje2Id: string | null; telefono2: string | null;
}> {
  const tenantId = randomUUID();
  const p = corrida.parametros;
  const ins = await db.from('tenant').insert({
    id: tenantId,
    nombre: corrida.tenantNombre,
    plan: 'demo',
    // Con RFC real de la corrida la validación de receptor CORRE (con el
    // genérico del SAT, engine.ts la apaga — ver config.ts:204).
    rfc: p.rfcEmpresa,
    // Sin dígitos a propósito: el aviso de privacidad los imprime y el
    // oráculo #5 revisa todo mensaje saliente (criterio del ejército).
    razon_social: 'ZZZ QA SA DE CV',
    domicilio_fiscal: 'Carretera Sintetica QA SN, Monterrey NL',
    config: { politica: p.politica },
  });
  if (ins.error) throw new Error(`no se pudo sembrar el tenant QA: ${ins.error.message}`);

  const chofer1 = await sembrarChofer(db, tenantId, corrida, 0);

  // El segundo chofer SOLO si el guion lo usa: sembrar uno que nadie toca
  // ensucia el tenant sintético y confunde la evidencia.
  const def = escenarioPorId(corrida.escenario);
  const chofer2 = def?.segundoChofer ? await sembrarChofer(db, tenantId, corrida, 1) : null;

  return {
    tenantId,
    operadorId: chofer1.operadorId, viajeId: chofer1.viajeId, telefono: chofer1.telefono,
    operador2Id: chofer2?.operadorId ?? null, viaje2Id: chofer2?.viajeId ?? null, telefono2: chofer2?.telefono ?? null,
  };
}

/** Un chofer del tenant sintético con su unidad y su viaje ABIERTO. Se llama
 *  una vez, o dos cuando el guion cruza de viaje (el ataque de dedup necesita
 *  que la segunda foto entre por OTRO viaje: el pre-check del processor mira
 *  uno solo, así que solo así se obliga al índice de la base a ser el que
 *  rechace). */
async function sembrarChofer(
  db: SupabaseClient, tenantId: string, corrida: CorridaQA, indice: number,
): Promise<{ operadorId: string; viajeId: string; telefono: string }> {
  const p = corrida.parametros;
  const sufijo = `${corrida.id.slice(0, 8)}${indice === 0 ? '' : `-${indice + 1}`}`;
  const telefono = telefonoQa(corrida.id, indice);

  const op = await db.from('operador').insert({
    tenant_id: tenantId, nombre: `ZZZ QA Chofer ${indice + 1}`, telefono, activo: true,
  }).select('id').single();
  if (op.error) throw new Error(`no se pudo sembrar el operador QA ${indice + 1}: ${op.error.message}`);

  // LA CONSTANCIA DEL AVISO DE PRIVACIDAD, sembrada — el escenario modela un
  // operador YA onboardeado. Hallazgo REAL de la primera corrida del panel
  // (16-ago-2026): sin esto, `ponerAvisoADisposicion` intenta mandar el aviso
  // por el cliente Meta real, el envío rebota en la allowed-list del número de
  // prueba (#131030) y el gate de LFPDPPP 16-II BLOQUEA todo tratamiento —
  // fail-closed correcto de producción, pero deja al carril rápido sin poder
  // ejercitar nada. El ejército no lo ve porque su mock hace "exitoso" el
  // envío. La versión se calcula con las MISMAS funciones de producción
  // (getDatosResponsable → avisoSimplificado → versionAviso), no con una copia.
  const { getDatosResponsable } = await import('@/lib/likida/repo');
  const { avisoSimplificado, versionAviso } = await import('@/lib/likida/privacidad');
  const datos = await getDatosResponsable(tenantId);
  const texto = datos ? avisoSimplificado(datos) : null;
  if (!texto) throw new Error('no se pudo armar el aviso de privacidad del tenant QA (¿razón social/domicilio sembrados?)');
  const constancia = await db.from('operador')
    .update({ aviso_privacidad_en: new Date().toISOString(), aviso_privacidad_version: versionAviso(texto) })
    .eq('id', op.data.id).eq('tenant_id', tenantId);
  if (constancia.error) throw new Error(`no se pudo sembrar la constancia del aviso: ${constancia.error.message}`);

  const uni = await db.from('unidad').insert({
    tenant_id: tenantId, numero_economico: `ZZZ-QA-${sufijo}`, activo: true,
  });
  if (uni.error) throw new Error(`no se pudo sembrar la unidad QA: ${uni.error.message}`);

  // El AYER de México: `viaje.fecha_inicio` es `date` y la ventana del cuadre
  // (`ventanaDelViaje`) la juzga en días de México. Sembrar el día UTC hacía
  // que, corriendo QA de noche, el viaje sintético naciera fechado HOY.
  const ayer = hoyMx(new Date(ahoraMs() - 24 * 3600 * 1000));
  const viaje = await db.from('viaje').insert({
    tenant_id: tenantId,
    operador_id: op.data.id,
    folio: `ZZZQA-${sufijo}`,
    origen: p.ruta.origen,
    destino: p.ruta.destino,
    anticipo: p.anticipo,
    fecha_inicio: ayer, // hoy−1: bajo el primer tier de cobranza, y el viaje vive minutos
    estatus: 'abierto',
    // aceptado_en puesto para que el flujo de confirmación no secuestre los
    // mensajes del escenario; el constraint exige avisado_en junto (mismo
    // razonamiento, con su porqué completo, en el orquestador del ejército).
    aceptado_en: new Date().toISOString(),
    avisado_en: new Date().toISOString(),
  }).select('id').single();
  if (viaje.error) throw new Error(`no se pudo sembrar el viaje QA: ${viaje.error.message}`);

  return { operadorId: op.data.id as string, viajeId: viaje.data.id as string, telefono };
}

// ── Ledger: el costo REAL, leído de llm_costo (jamás un segundo medidor) ────

async function costoNuevoUsd(db: SupabaseClient, tenantId: string, vistos: Set<string>): Promise<number> {
  const { data, error } = await db.from('llm_costo')
    .select('id, fase, costo_usd').eq('tenant_id', tenantId);
  if (error) throw new Error(`no se pudo leer llm_costo: ${error.message}`);
  let suma = 0;
  for (const fila of data ?? []) {
    const id = String(fila.id);
    if (vistos.has(id)) continue;
    vistos.add(id);
    // 'whatsapp' fuera del ledger: en QA los envíos rebotan en la allowed-list
    // del número de prueba — no son gasto real (mismo criterio que el ejército).
    if (fila.fase === 'whatsapp') continue;
    suma += Number(fila.costo_usd);
  }
  return Math.round(suma * 1_000_000) / 1_000_000;
}

/** El costo ACUMULADO del tenant, USD, leído entero de `llm_costo`.
 *
 *  El carril rápido puede llevar el acumulado en memoria (`costoNuevoUsd` con
 *  su `Set` de ids ya vistos) porque vive en UNA invocación. El completo no: el
 *  `Set` nace vacío en cada pasada, así que sumar "lo nuevo" volvería a contar
 *  todo lo de las pasadas anteriores y el tope de $2 saltaría a la tercera
 *  pasada por una cifra que nadie gastó. Aquí se lee el TOTAL, que es
 *  idempotente por construcción y sigue siendo lo que reportó el proveedor del
 *  modelo — nunca una estimación ni un segundo medidor. */
async function costoTotalUsd(db: SupabaseClient, tenantId: string): Promise<number> {
  const { data, error } = await db.from('llm_costo')
    .select('fase, costo_usd').eq('tenant_id', tenantId);
  if (error) throw new Error(`no se pudo leer llm_costo: ${error.message}`);
  let suma = 0;
  for (const fila of data ?? []) {
    // 'whatsapp' fuera del ledger, mismo criterio que el carril rápido: en QA
    // los envíos rebotan en la allowed-list del número de prueba.
    if (fila.fase === 'whatsapp') continue;
    const v = Number(fila.costo_usd);
    if (Number.isFinite(v)) suma += v;
  }
  return Math.round(suma * 1_000_000) / 1_000_000;
}

// ── Lecturas de evidencia ───────────────────────────────────────────────────

async function turnosDelTenant(db: SupabaseClient, tenantId: string): Promise<TurnoConversacion[]> {
  const { data, error } = await db.from('wa_conversacion').select('estado').eq('tenant_id', tenantId);
  if (error) return [];
  const turnos: TurnoConversacion[] = [];
  for (const fila of data ?? []) {
    const estado = fila.estado as { turns?: Array<{ role?: string; content?: string }> } | null;
    for (const t of estado?.turns ?? []) {
      if ((t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string') {
        turnos.push({ rol: t.role, texto: t.content });
      }
    }
  }
  return turnos;
}

async function filasDelTenant(db: SupabaseClient, tenantId: string): Promise<Record<string, unknown[]>> {
  const dump: Record<string, unknown[]> = {};
  for (const tabla of ['viaje', 'gasto', 'liquidacion', 'comprobante_huerfano']) {
    const { data, error } = await db.from(tabla).select('*').eq('tenant_id', tenantId);
    dump[tabla] = error ? [{ error: error.message }] : (data ?? []);
  }
  return dump;
}

async function hayLiquidacion(db: SupabaseClient, tenantId: string, viajeId: string): Promise<boolean> {
  const { data } = await db.from('liquidacion').select('id')
    .eq('tenant_id', tenantId).eq('viaje_id', viajeId).maybeSingle();
  return Boolean(data);
}

async function pdfsDelTenant(db: SupabaseClient, tenantId: string): Promise<string[]> {
  try {
    const rutas: string[] = [];
    const raiz = await db.storage.from('liquidaciones').list(tenantId, { limit: 100 });
    for (const entrada of raiz.data ?? []) {
      if (entrada.id) { rutas.push(`${tenantId}/${entrada.name}`); continue; }
      const sub = await db.storage.from('liquidaciones').list(`${tenantId}/${entrada.name}`, { limit: 100 });
      for (const f of sub.data ?? []) rutas.push(`${tenantId}/${entrada.name}/${f.name}`);
    }
    return rutas;
  } catch {
    return [];
  }
}

// ── Limpieza (siempre detrás de los guards del ejército) ────────────────────

async function limpiarTenant(db: SupabaseClient, corrida: CorridaQA): Promise<string> {
  const tenantId = corrida.tenantId;
  if (!tenantId) return 'sin tenant que limpiar (la siembra no llegó a crear uno)';
  try {
    await exigirTenantZZZ(db, tenantId);
    const notas: string[] = [];
    for (const bucket of ['comprobantes', 'liquidaciones']) {
      try {
        const raiz = await db.storage.from(bucket).list(tenantId, { limit: 100 });
        if (raiz.error || !raiz.data?.length) continue;
        const rutas: string[] = [];
        for (const entrada of raiz.data) {
          if (entrada.id) { rutas.push(`${tenantId}/${entrada.name}`); continue; }
          const sub = await db.storage.from(bucket).list(`${tenantId}/${entrada.name}`, { limit: 200 });
          for (const f of sub.data ?? []) rutas.push(`${tenantId}/${entrada.name}/${f.name}`);
        }
        if (rutas.length) {
          const rm = await db.storage.from(bucket).remove(rutas);
          notas.push(rm.error
            ? `storage/${bucket}: no se pudieron borrar ${rutas.length} objetos (${rm.error.message})`
            : `storage/${bucket}: ${rutas.length} objetos borrados`);
        }
      } catch (e) {
        notas.push(`storage/${bucket}: limpieza best-effort falló (${e instanceof Error ? e.message : e})`);
      }
    }
    const del = await db.from('tenant').delete().eq('id', tenantId);
    if (del.error) return `❌ el DELETE del tenant falló: ${del.error.message}`;

    const patron = `${prefijoMensajes(corrida.id)}%`;
    exigirPrefijoQA(patron);
    await db.from('wa_mensaje_procesado').delete().like('wa_message_id', patron);

    const sobras: string[] = [];
    for (const tabla of ['operador', 'unidad', 'viaje', 'gasto', 'liquidacion', 'comprobante_huerfano', 'wa_conversacion', 'llm_costo']) {
      const { count, error } = await db.from(tabla).select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId);
      if (error) sobras.push(`${tabla}: no se pudo contar (${error.message})`);
      else if ((count ?? 0) > 0) sobras.push(`${tabla}: ${count} filas`);
    }
    const detalle = notas.length ? ` (${notas.join('; ')})` : '';
    return sobras.length === 0
      ? `✅ tenant "${corrida.tenantNombre}" borrado (cascada) y verificado en 0 filas${detalle}`
      : `⚠️ el tenant se borró pero quedaron sobras: ${sobras.join('; ')}${detalle}`;
  } catch (e) {
    return `❌ limpieza abortada por el guard o un error: ${e instanceof Error ? e.message : e}`;
  }
}

// ── N FALLOS CON LA MISMA FIRMA = UNA SEÑAL, NO N FOTOS MALAS ──────────────
//
// El incidente del 28-ago-2026 (corrida 46ad99ca): 10 de 90 fotos 'bad', las
// 10 con EXACTAMENTE el mismo error («Too many connections issued to the
// database»), y el panel las enseñaba como diez fotos malas sueltas. Diez
// fallos idénticos no son diez fotos con mala suerte: son UN problema
// sistémico (ahí, la saturación del pool de Storage por las firmas del
// panel), y la corrida debe levantarlo como una sola mano — el mismo criterio
// que el PR #183 instaló en los agentes de ingeniería.

export interface PatronFalloCorrida { firma: string; veces: number; ejemplo: string }

/** Dos, el mismo umbral que `MIN_REPETICIONES_PATRON` de los agentes: un
 *  fallo único puede ser un bache; dos con la misma forma ya son patrón. */
export const MIN_FALLOS_MISMA_FIRMA = 2;

/** Agrupa por firma los ítems 'bad' de una corrida (fotos del carril completo
 *  o pasos del rápido — cualquier cosa con estado y detalle). Puro. */
export function patronesDeFallo(
  items: ReadonlyArray<{ estado: string; detalle?: string | null }>,
): PatronFalloCorrida[] {
  const acc = new Map<string, { veces: number; ejemplo: string }>();
  for (const it of items) {
    if (it.estado !== 'bad') continue;
    const firma = firmaDeError(it.detalle ?? null);
    if (firma === null) continue;
    const a = acc.get(firma) ?? { veces: 0, ejemplo: it.detalle ?? '' };
    a.veces += 1;
    acc.set(firma, a);
  }
  return [...acc.entries()]
    .filter(([, a]) => a.veces >= MIN_FALLOS_MISMA_FIRMA)
    .map(([firma, a]) => ({ firma, veces: a.veces, ejemplo: a.ejemplo }))
    .sort((x, y) => y.veces - x.veces);
}

/** La frase que se le pega al motivo de la corrida. `null` si no hay patrón —
 *  no se grita sin evidencia (regla del #183: sin patrón verificado no hay
 *  hallazgo). */
export function fraseFallosMismaFirma(patrones: readonly PatronFalloCorrida[]): string | null {
  if (patrones.length === 0) return null;
  const partes = patrones.map((p) => `${p.veces} fallos con la MISMA firma: «${p.firma}»`);
  return `⚠ ${partes.join(' · ')} — patrón sistémico, no ${patrones.reduce((s, p) => s + p.veces, 0)} fotos malas sueltas; búscale UNA causa.`;
}

// ── LA CORRIDA ──────────────────────────────────────────────────────────────

/** Ejecuta el carril rápido de punta a punta, escribiendo cada paso en
 *  corridas/<id>/corrida.json (el ledger en vivo que el panel pollea).
 *  Nunca lanza: todo fallo termina ESCRITO en la corrida. */
export async function ejecutarCorridaRapida(corrida: CorridaQA): Promise<CorridaQA> {
  const db = supabaseAdmin();
  const t0 = Date.now();
  const costosVistos = new Set<string>();
  corrida.estado = 'corriendo';
  corrida.inicio = new Date().toISOString();

  let n = 0;
  const paso = async (nombre: string): Promise<PasoQA> => {
    const p: PasoQA = { n: ++n, nombre, estado: 'corriendo', costoUsd: 0, inicio: new Date().toISOString() };
    corrida.pasos.push(p);
    await guardarCorrida(db, corrida).catch(() => { /* el ledger es best-effort en vivo; el cierre sí exige escribirse */ });
    return p;
  };
  const cerrarPaso = async (p: PasoQA, estado: PasoQA['estado'], detalle?: string) => {
    p.estado = estado;
    p.fin = new Date().toISOString();
    if (detalle) p.detalle = detalle;
    if (corrida.tenantId) {
      try {
        p.costoUsd = await costoNuevoUsd(db, corrida.tenantId, costosVistos);
        corrida.costoUsdTotal = Math.round((corrida.costoUsdTotal + p.costoUsd) * 1_000_000) / 1_000_000;
      } catch (e) {
        p.detalle = `${p.detalle ? `${p.detalle} · ` : ''}costo no leído: ${e instanceof Error ? e.message : e}`;
      }
    }
    await guardarCorrida(db, corrida).catch(() => {});
  };
  const abortar = async (motivo: string) => {
    corrida.estado = 'abortada';
    corrida.motivo = motivo;
    corrida.fin = new Date().toISOString();
    // La fase también se cierra: una corrida abortada que dijera `fase:
    // 'fotos'` invitaría a que alguien intentara continuarla, y el carril
    // rápido no admite continuación.
    corrida.fase = 'terminada';
    // Un aborto por tope o por tiempo es EVIDENCIA: el tenant se queda para
    // inspección, no se borra (encargo Fase A, regla del tope).
    corrida.limpieza = `tenant "${corrida.tenantNombre}" CONSERVADO para inspección (aborto): límpialo a mano cuando termines de mirar`;
    await guardarCorrida(db, corrida);
  };
  const excedeTope = () => corrida.costoUsdTotal > TOPE_CORRIDA_USD;
  const sinTiempo = () => Date.now() - t0 > TECHO_CORRIDA_MS - MARGEN_MENSAJE_MS;

  const bit = capturarBitacora();
  const restaurarFetch = instalarInterceptorSalidaMeta(corrida.id);
  let viajeId = '';
  let telefono = '';
  let viaje2Id: string | null = null;
  let telefono2: string | null = null;
  /** Se llena si el guion repitió una foto: es lo que habilita el oráculo #3. */
  let dedup: { imgHash: string; viajeIntentoId: string } | undefined;
  /** Se llena si el guion mandó el ticket TARDÍO: habilita el oráculo #4. */
  let huerfano: MemoriaCorrida['huerfano'];
  /** Lo que ESTE motor vio de cada foto. El carril rápido no escribe
   *  `qa_corrida_foto`, así que la medición del OCR recibe esta evidencia en
   *  vez de leerla de la base. */
  const evidenciaFotos = new Map<string, { estado: EstadoFotoCorrida; detalle: string | null; costoUsd: number | null }>();
  const TEXTO_CIERRE = 'listo, ya subí todo';
  try {
    // 1 — siembra
    const p1 = await paso(`sembrar tenant "${corrida.tenantNombre}" (operador, unidad, política, viaje)`);
    try {
      const s = await sembrarTenant(db, corrida);
      corrida.tenantId = s.tenantId;
      viajeId = s.viajeId;
      telefono = s.telefono;
      viaje2Id = s.viaje2Id;
      telefono2 = s.telefono2;
      corrida.fase = 'fotos';
      await cerrarPaso(p1, 'ok');
    } catch (e) {
      await cerrarPaso(p1, 'bad', e instanceof Error ? e.message : String(e));
      corrida.estado = 'fallo';
      corrida.motivo = `la siembra falló: ${e instanceof Error ? e.message : e}`;
      corrida.fin = new Date().toISOString();
      corrida.fase = 'terminada';
      corrida.limpieza = await limpiarTenant(db, corrida);
      await guardarCorrida(db, corrida);
      return corrida;
    }

    // 2..N — EL GUION DEL ESCENARIO, por el camino REAL (processInbound +
    // mediaDataUrlQA). La Fase A mandaba siempre la misma secuencia; ahora la
    // secuencia la dicta el escenario, que es lo que distingue un ataque de
    // otro.
    const manifiesto = await leerManifiesto(db);
    if (!manifiesto.ok) {
      await abortar(`no se pudo leer el banco de fotos: ${manifiesto.error}`);
      return corrida;
    }
    const porId = new Map(manifiesto.datos.map((f) => [f.id, f]));
    const prefijo = prefijoMensajes(corrida.id);
    const guion = escenarioPorId(corrida.escenario)?.guion ?? [{ tipo: 'fotos' as const }, { tipo: 'cierre' as const }];
    let msg = 0;

    /** Manda UNA foto del banco por el camino real. Devuelve false si la
     *  corrida ya no puede seguir (falta la foto, se acabó el tiempo). */
    const mandarFoto = async (
      fotoId: string, rotulo: string, desde: string,
    ): Promise<boolean> => {
      msg += 1;
      const foto = porId.get(fotoId);
      const p = await paso(`${rotulo} — ${foto?.etiqueta ?? fotoId} → processInbound`);
      if (!foto) {
        await cerrarPaso(p, 'bad', `la foto ${fotoId} no está en el banco`);
        await abortar(`la foto ${fotoId} no está en el banco — corrida detenida`);
        return false;
      }
      if (sinTiempo()) {
        await cerrarPaso(p, 'bad', 'sin tiempo para otro mensaje');
        await abortar(`techo de tiempo del carril rápido (${TECHO_CORRIDA_MS / 1000}s) — corrida con menos fotos, o carril completo (Fase C)`);
        return false;
      }
      try {
        const { dataUrl, reintentos } = await dataUrlDeFoto(db, foto);
        await processInbound({
          from: desde,
          type: 'image',
          mediaId: `${prefijo}media-${msg}`,   // jamás llega a Meta: mediaDataUrlQA lo sustituye
          mediaDataUrlQA: dataUrl,
          waMessageId: `${prefijo}f${msg}`,
        });
        // El reintento por saturación se DECLARA aunque haya salido bien: es
        // la evidencia de que Storage anduvo apretado (incidente 28-ago-2026).
        await cerrarPaso(p, 'ok', reintentos > 0
          ? `la descarga se reintentó ${reintentos} vez(es) por saturación de Storage antes de salir`
          : undefined);
        // El costo del paso YA está medido por cerrarPaso; 0 aquí significa
        // "no se pudo leer del ledger", así que se guarda null — jamás un 0
        // que afirme "gratis".
        evidenciaFotos.set(fotoId, { estado: 'ok', detalle: null, costoUsd: p.costoUsd > 0 ? p.costoUsd : null });
      } catch (e) {
        const detalle = e instanceof Error ? e.message : String(e);
        await cerrarPaso(p, 'bad', detalle);
        evidenciaFotos.set(fotoId, { estado: 'bad', detalle, costoUsd: p.costoUsd > 0 ? p.costoUsd : null });
      }
      return true;
    };

    const fotoIds = corrida.parametros.fotoIds;
    for (const acto of guion) {
      if (acto.tipo === 'fotos') {
        // `menosUltima` reserva la última foto para el ticket tardío del #4.
        const idsActo = idsParaActoFotos(acto, fotoIds);
        let f = 0;
        for (const fotoId of idsActo) {
          f += 1;
          if (!(await mandarFoto(fotoId, `foto ${f}/${idsActo.length}`, telefono))) return corrida;
          if (excedeTope()) {
            await abortar(`TOPE DE CORRIDA excedido: $${corrida.costoUsdTotal.toFixed(4)} > $${TOPE_CORRIDA_USD} (config.qa.ts del ejército)`);
            return corrida;
          }
        }
        continue;
      }

      if (acto.tipo === 'foto_repetida') {
        const fotoId = fotoIds[acto.indice];
        const foto = fotoId ? porId.get(fotoId) : undefined;
        if (!foto) {
          await abortar(`el escenario repite la foto #${acto.indice + 1} y la corrida no la trae — elige al menos ${acto.indice + 1} foto(s)`);
          return corrida;
        }
        // El ataque de dedup vale SOLO cruzando de viaje: el pre-check del
        // processor mira un viaje, así que mandarla desde el mismo chofer
        // probaría el pre-check y no el índice de la base.
        const desde = acto.comoOtroChofer ? telefono2 : telefono;
        if (acto.comoOtroChofer && (!telefono2 || !viaje2Id)) {
          await abortar('el escenario necesita un segundo chofer y la siembra no lo creó');
          return corrida;
        }
        dedup = { imgHash: foto.hash, viajeIntentoId: (acto.comoOtroChofer ? viaje2Id : viajeId) as string };
        const rotulo = acto.comoOtroChofer
          ? `LA MISMA foto, desde el chofer 2 (otro viaje del mismo tenant)`
          : `LA MISMA foto, otra vez`;
        if (!(await mandarFoto(fotoId, rotulo, desde as string))) return corrida;
        if (excedeTope()) {
          await abortar(`TOPE DE CORRIDA excedido: $${corrida.costoUsdTotal.toFixed(4)} > $${TOPE_CORRIDA_USD}`);
          return corrida;
        }
        continue;
      }

      if (acto.tipo === 'foto_tras_cierre') {
        // EL ATAQUE DEL INVARIANTE #4: el viaje ya está liquidado y la última
        // foto llega tarde. Antes de gastar un centavo se comprueba que el
        // ataque se pueda JUZGAR: hace falta el monto etiquetado de esa foto
        // (la vara con la que #4 busca el huérfano) y los totales de la
        // liquidación de ANTES — mandar el ticket sin ellos sería pagar por
        // un veredicto imposible.
        const fotoId = idFotoTrasCierre(guion, fotoIds);
        const foto = fotoId ? porId.get(fotoId) : undefined;
        const monto = foto?.ocrEsperado?.monto ?? null;
        if (!fotoId || !foto || monto === null) {
          await abortar(!fotoId || !foto
            ? 'el escenario manda un ticket TRAS el cierre y la corrida no trae esa foto — elige al menos 2 fotos'
            : `la última foto elegida («${foto.etiqueta}») no tiene monto en su verdad-de-terreno: sin monto el oráculo #4 no puede buscar el huérfano, y mandarla sería gastar en un ataque que no se puede juzgar. Elige de última una foto con monto etiquetado.`);
          return corrida;
        }
        const liq = await db.from('liquidacion')
          .select('total_comprobado, total_anticipo, diferencia')
          .eq('tenant_id', corrida.tenantId!).eq('viaje_id', viajeId).maybeSingle();
        if (liq.error || !liq.data) {
          await abortar(`el cierre no dejó liquidación legible (${liq.error?.message ?? 'sin fila'}): el ataque post-cierre no tiene contra qué juzgarse`);
          return corrida;
        }
        huerfano = {
          liqSembrada: {
            totalComprobado: Number(liq.data.total_comprobado),
            totalAnticipo: Number(liq.data.total_anticipo),
            diferencia: Number(liq.data.diferencia),
          },
          montoTicket: monto,
        };
        if (!(await mandarFoto(fotoId, 'ticket TARDÍO — tras el cierre (ataque del invariante #4)', telefono))) return corrida;
        if (excedeTope()) {
          await abortar(`TOPE DE CORRIDA excedido: $${corrida.costoUsdTotal.toFixed(4)} > $${TOPE_CORRIDA_USD}`);
          return corrida;
        }
        continue;
      }

      // acto.tipo === 'cierre'
      const pC = await paso(`cierre — el chofer escribe «${TEXTO_CIERRE}»`);
      if (sinTiempo()) {
        await cerrarPaso(pC, 'bad', 'sin tiempo para el cierre');
        await abortar(`techo de tiempo del carril rápido (${TECHO_CORRIDA_MS / 1000}s) antes del cierre`);
        return corrida;
      }
      try {
        await processInbound({ from: telefono, type: 'text', text: TEXTO_CIERRE, waMessageId: `${prefijo}t1` });
        if (!(await hayLiquidacion(db, corrida.tenantId!, viajeId)) && !sinTiempo() && !excedeTope()) {
          pC.detalle = 'el primer «listo» no cerró; se insistió una vez (mismo criterio que el ejército)';
          await processInbound({ from: telefono, type: 'text', text: TEXTO_CIERRE, waMessageId: `${prefijo}t2` });
        }
        await cerrarPaso(pC, 'ok', pC.detalle);
      } catch (e) {
        await cerrarPaso(pC, 'bad', e instanceof Error ? e.message : String(e));
      }
      if (excedeTope()) {
        await abortar(`TOPE DE CORRIDA excedido: $${corrida.costoUsdTotal.toFixed(4)} > $${TOPE_CORRIDA_USD}`);
        return corrida;
      }
    }

    // N+1 — LA MEDICIÓN DEL OCR contra la verdad-de-terreno. Va ANTES de los
    // oráculos y de la limpieza: la evidencia son los `gasto` del tenant
    // sintético y la limpieza los borra en cascada. Escribe una fila por foto
    // en `qa_foto_lectura` (migs. 0239/0246) — el gasto de modelo de la
    // corrida COMPRÓ lecturas, y sin este paso la medición no existe (pasó el
    // 28-ago-2026: 90 fotos procesadas, $0.29 medidos, cero filas escritas).
    const pM = await paso(`medición del OCR contra la verdad-de-terreno — ${fotoIds.length} foto(s)`);
    const dm = detalleMedicion(await medirCorrida(db, corrida, evidenciaFotos));
    await cerrarPaso(pM, dm.estado, dm.detalle);

    // N+2 — evidencia + oráculos (funciones puras del ejército, importadas)
    const rotuloOraculos = ['#1 cuadre_balancea', '#5 cifras_con_fuente', dedup ? '#3 dedup_comprobante' : null, huerfano ? '#4 huerfano_post_cierre' : null, '#8 bitacora_registro']
      .filter(Boolean).join(' · ');
    const pO = await paso(`oráculos — ${rotuloOraculos}`);
    corrida.turnos = await turnosDelTenant(db, corrida.tenantId!);
    corrida.pdfs = await pdfsDelTenant(db, corrida.tenantId!);
    const filas = await filasDelTenant(db, corrida.tenantId!);
    const textosBot = corrida.turnos.filter((t) => t.rol === 'assistant').map((t) => t.texto);
    try {
      corrida.veredicto = await correrOraculos({
        tenantId: corrida.tenantId!,
        viajeId,
        textosBot,
        fuentesRespaldo: [filas, corrida.parametros, [TEXTO_CIERRE]],
        eventosBitacora: bit.eventos,
        eventosEsperados: ['agent.run'],
        dedup,
        huerfano,
      });
      const final = estadoFinalDe(corrida.veredicto);
      await cerrarPaso(pO, final === 'ok' ? 'ok' : final === 'parcial' ? 'warn' : 'bad');
      corrida.estado = final;
      if (final === 'parcial') corrida.motivo = 'al menos un oráculo quedó NO VERIFICADO — no se afirma que pasó';
      if (final === 'fallo') corrida.motivo = 'al menos un invariante FALLÓ — abre el veredicto';
    } catch (e) {
      await cerrarPaso(pO, 'bad', e instanceof Error ? e.message : String(e));
      corrida.estado = 'fallo';
      corrida.motivo = `los oráculos no pudieron correr: ${e instanceof Error ? e.message : e}`;
    }

    // N+3 — limpieza (salvo retención)
    const pL = await paso('limpieza del tenant sintético');
    if (corrida.parametros.retencion === 'conservar') {
      corrida.limpieza = `tenant "${corrida.tenantNombre}" (${corrida.tenantId}) CONSERVADO a pedido (retencion=conservar)`;
      await cerrarPaso(pL, 'warn', 'conservado a pedido');
    } else {
      corrida.limpieza = await limpiarTenant(db, corrida);
      await cerrarPaso(pL, corrida.limpieza.startsWith('✅') ? 'ok' : 'warn', corrida.limpieza);
    }

    // N fallos con la MISMA firma se levantan como UNA señal (ver la cabecera
    // de `patronesDeFallo`): aquí los ítems son los pasos del carril rápido.
    const patrones = patronesDeFallo(corrida.pasos);
    const frase = fraseFallosMismaFirma(patrones);
    if (frase) {
      corrida.motivo = corrida.motivo ? `${corrida.motivo} · ${frase}` : frase;
      logger.warn('qa.corrida.fallos_misma_firma', {
        corrida: corrida.id, carril: 'rapido',
        patrones: patrones.map((p) => ({ firma: p.firma, veces: p.veces })),
      });
    }

    corrida.fin = new Date().toISOString();
    corrida.fase = 'terminada';
    await guardarCorrida(db, corrida);
    return corrida;
  } catch (e) {
    // Red final: nada de este motor debe tumbar la función sin dejar rastro.
    corrida.estado = 'fallo';
    corrida.motivo = `error no anticipado: ${e instanceof Error ? e.message : String(e)}`;
    corrida.fin = new Date().toISOString();
    corrida.fase = 'terminada';
    if (!corrida.limpieza) {
      corrida.limpieza = `tenant "${corrida.tenantNombre}" posiblemente sembrado — revisar y limpiar a mano`;
    }
    await guardarCorrida(db, corrida).catch(() => {});
    return corrida;
  } finally {
    bit.restaurar();
    restaurarFetch();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EL CARRIL COMPLETO (Fase C, 27-ago-2026) — la corrida que NO cabe en una
// invocación.
//
// EL PROBLEMA, Y POR QUÉ NO ERA SUBIR UN NÚMERO. `MAX_FOTOS_CARRIL_RAPIDO`
// eran diez y el tope era honesto: el carril rápido corre entero dentro de una
// función serverless con `maxDuration`, así que subir la constante a 91 no
// daría 91 fotos procesadas — daría una corrida MUERTA A LA MITAD, que además
// mentiría (estado 'corriendo' para siempre y nadie sabiendo cuántas se
// midieron). Lo que faltaba era el otro carril, y es esto.
//
// LA FORMA: PASADAS. Cada pasada es una invocación con su propio reloj.
// Procesa las fotos que le alcancen, deja escrito CUÁLES, y suelta la llave.
// La siguiente continúa desde ahí. Lo que el número de fotos deja de limitar
// lo siguen limitando el reloj y el dinero, que es lo que de verdad se acaba.
//
// EL RELOJ, CON EL PATRÓN DEL PR #152 («El reloj entra a los motores»). Se
// pregunta `relojAgotado(...)` ANTES de empezar cada foto y NUNCA a la mitad de
// una, y las que no alcanzaron turno se CUENTAN y se DICEN. Esto no es
// decoración: el runner de producción murió mudo dos veces (25-ago-2026 18:46
// y 28-ago-2026 00:03 UTC, con correo de alerta de por medio) por motores que
// iteraban sin mirar el reloj. `relojAgotado` se IMPORTA de agentes/runner.ts
// en vez de reescribirse: tenerla escrita una sola vez es lo que hace que
// buscarla en el fuente encuentre a todos los que preguntan — y a los que no.
// La red de abajo es `conRelojDuro` en la ruta, que tampoco se copia.
//
// LA IDEMPOTENCIA ES UNA RESTRICCIÓN, NO UN `if`. Cada foto se TOMA con un
// insert contra la PK `(corrida_id, foto_id)` de `qa_corrida_foto` ANTES de
// mandarla. Dos pasadas solapadas piden la misma foto: una entra, la otra
// rebota con 23505 y sigue de largo. Un `if (yaProcesada)` leído antes sería
// una carrera, y perderla aquí significa mandar el mismo ticket dos veces al
// modelo — dinero real — y contarlo dos veces — una cifra inventada.
//
// LOS TOPES DE DINERO SE QUEDAN ENTEROS. `TOPE_DIA_USD` se vuelve a preguntar
// al principio de CADA pasada (una corrida larga puede cruzar el día), y
// `TOPE_CORRIDA_USD` después de cada foto, siempre contra el costo MEDIDO que
// reportó el proveedor (llm_costo). Cuando topa: para, lo dice con la cifra, y
// CONSERVA el tenant — un aborto por tope es evidencia, no basura.
// ═══════════════════════════════════════════════════════════════════════════

/** Los estados de los que ya no se sale. */
export const ESTADOS_TERMINALES: ReadonlySet<string> = new Set(['ok', 'parcial', 'fallo', 'abortada']);

export interface ResultadoPasada {
  /** `false` = no se pudo ni intentar y el motivo lo dice (base ilegible,
   *  corrida inexistente, carril equivocado). */
  ok: boolean;
  /** `true` sólo si esta invocación llegó a tomar la corrida y trabajar. */
  corrio: boolean;
  pasada: number | null;
  /** SIEMPRE dicho. Ni un solo camino de esta función devuelve un `false` mudo. */
  motivo: string;
  /** Fotos que ESTA pasada procesó (ok o bad). No incluye las que ya estaban. */
  fotosProcesadas: number;
  corte: CorteCorrida | null;
  /** Ya no queda nada por hacer: la corrida llegó a un estado terminal. */
  terminada: boolean;
  /** El avance al cerrar la pasada, para que quien llama no tenga que releer. */
  avance: AvanceFotos | null;
  corrida: CorridaQA | null;
}

/** Une los mensajes de bitácora de esta pasada con los que la corrida ya
 *  recordaba, sin repetir y con tope. Puro. */
export function mezclarEventos(previos: string[] | undefined, nuevos: string[]): string[] {
  const vistos = new Set(previos ?? []);
  for (const m of nuevos) {
    if (vistos.size >= MAX_EVENTOS_MEMORIA) break;
    vistos.add(m);
  }
  return [...vistos];
}

/**
 * UNA pasada del carril completo. Nunca lanza: todo fallo termina ESCRITO en la
 * corrida, que es lo que la pantalla pollea.
 *
 * `venceEn` es el instante en que esta pasada tiene que haber dejado de
 * trabajar — el MISMO que la ruta le pasa a `conRelojDuro`, para que el corte
 * duro sea la red y no el freno normal.
 */
export async function ejecutarPasada(corridaId: string, venceEn: number): Promise<ResultadoPasada> {
  const db = supabaseAdmin();
  const pasadaId = randomUUID();

  const sinCorrer = (motivo: string, ok: boolean, corrida: CorridaQA | null): ResultadoPasada => ({
    ok, corrio: false, pasada: null, motivo, fotosProcesadas: 0, corte: null,
    terminada: corrida ? ESTADOS_TERMINALES.has(corrida.estado) : false,
    avance: corrida?.avance ?? null, corrida,
  });

  const leida = await leerCorrida(db, corridaId);
  if (!leida.ok) return sinCorrer(leida.error, false, null);
  if (!leida.datos) return sinCorrer('corrida no encontrada — el id puede ser viejo', false, null);
  if (leida.datos.carril !== 'completo') {
    return sinCorrer('esta corrida es del carril rápido: corre entera en su propia invocación y no admite pasadas', false, leida.datos);
  }
  if (ESTADOS_TERMINALES.has(leida.datos.estado)) {
    return sinCorrer(`la corrida ya terminó (${leida.datos.estado}) — no hay más pasadas que dar`, true, leida.datos);
  }

  // ── LA LLAVE ─────────────────────────────────────────────────────────────
  // Un UPDATE condicional, no un `if` sobre lo que acabamos de leer: dos
  // pestañas abiertas piden a la vez, Postgres serializa, una gana y la otra
  // se va sin gastar un peso.
  const toma = await tomarPasada(db, corridaId, pasadaId);
  if (!toma.ok) return sinCorrer(toma.error, false, leida.datos);
  if (!toma.tomada) return sinCorrer(toma.motivo, true, leida.datos);
  const pasada = toma.pasada;

  // Se relee DESPUÉS de tener la llave: entre la primera lectura y la toma
  // pudo haber corrido una pasada entera, y trabajar sobre el estado viejo
  // sería reescribirlo.
  const fresca = await leerCorrida(db, corridaId);
  if (!fresca.ok || !fresca.datos) {
    await soltarPasada(db, corridaId, pasadaId).catch(() => {});
    return sinCorrer(fresca.ok ? 'la corrida desapareció entre la toma y la relectura' : fresca.error, false, null);
  }
  const corrida = fresca.datos;
  corrida.pasadas = pasada;
  corrida.pasadaEnVuelo = pasadaId;

  const bit = capturarBitacora();
  const restaurarFetch = instalarInterceptorSalidaMeta(corridaId);
  let fotosProcesadas = 0;
  let corte: CorteCorrida | null = null;

  /** Guarda la corrida ACORDÁNDOSE de la bitácora. `guardarCorrida` refresca
   *  `latido_en`, así que cada llamada es también el latido de la pasada. */
  const guardar = async () => {
    if (corrida.memoria) {
      corrida.memoria.eventos = mezclarEventos(corrida.memoria.eventos, bit.eventos.map((e) => e.msg));
    }
    await guardarCorrida(db, corrida);
  };

  let n = corrida.pasos.reduce((m, p) => Math.max(m, p.n), 0);
  const paso = async (nombre: string): Promise<PasoQA> => {
    const p: PasoQA = { n: ++n, nombre, estado: 'corriendo', costoUsd: 0, inicio: new Date().toISOString() };
    corrida.pasos.push(p);
    await guardar().catch(() => { /* el ledger en vivo es best-effort; el cierre sí exige escribirse */ });
    return p;
  };
  const cerrarPaso = async (p: PasoQA, estado: PasoQA['estado'], costoUsd: number | null, detalle?: string | null) => {
    p.estado = estado;
    p.fin = new Date().toISOString();
    // `costoUsd` null = NO SE MIDIÓ. La columna `qa_corrida_paso.costo_usd` es
    // NOT NULL, así que aquí va 0 — y por eso el detalle lo DICE en palabras:
    // un 0 sin explicación se leería como "salió gratis".
    p.costoUsd = costoUsd ?? 0;
    const nota = costoUsd === null && estado !== 'pendiente'
      ? `${detalle ? `${detalle} · ` : ''}costo NO medido (no es cero: no se pudo leer)`
      : detalle ?? undefined;
    if (nota) p.detalle = nota;
    await guardar().catch(() => {});
  };

  const cerrarPasada = (motivo: string, avance: AvanceFotos | null): ResultadoPasada => ({
    ok: true, corrio: true, pasada, motivo, fotosProcesadas, corte,
    terminada: ESTADOS_TERMINALES.has(corrida.estado), avance, corrida,
  });

  /** El avance MEDIDO ahora mismo, releído de la base. Si la lectura falla se
   *  devuelve `null` y quien lo use lo dice — jamás un avance inventado. */
  const avanceAhora = async (): Promise<AvanceFotos | null> => {
    const r = await leerFotosDeCorrida(db, corridaId);
    if (!r.ok) return null;
    const av = resumirAvance(corrida.parametros.fotoIds, r.datos);
    corrida.avance = av;
    return av;
  };

  const abortarPorDinero = async (cual: 'corrida' | 'dia', gastado: number, tope: number): Promise<ResultadoPasada> => {
    corte = 'dinero';
    const av = await avanceAhora();
    corrida.estado = 'abortada';
    corrida.corte = 'dinero';
    corrida.fin = new Date().toISOString();
    corrida.motivo = av
      ? motivoTopeDinero(cual, gastado, tope, av)
      : `${cual === 'corrida' ? 'TOPE DE CORRIDA' : 'TOPE DIARIO DEL PANEL'} alcanzado: $${gastado.toFixed(4)} USD medidos contra un tope de $${tope.toFixed(2)}. La corrida PARA aquí; el avance foto por foto no se pudo releer para decir cuántas quedaron — revísalo en la pantalla.`;
    // El tenant se CONSERVA: un aborto por tope es evidencia (regla del motor
    // desde la Fase A, respetada tal cual).
    corrida.limpieza = `tenant "${corrida.tenantNombre}" CONSERVADO para inspección (aborto por tope de dinero): límpialo a mano cuando termines de mirar`;
    await guardar();
    logger.warn('qa.pasada.tope_dinero', { corrida: corridaId, pasada, cual, gastado, tope });
    return cerrarPasada(corrida.motivo, av);
  };

  try {
    // ── EL TOPE DEL DÍA, RE-PREGUNTADO EN CADA PASADA ────────────────────
    // Una corrida de 91 fotos dura varias pasadas y puede cruzar la
    // medianoche de México; preguntarlo sólo al lanzar dejaría al panel
    // gastando el resto de la noche contra un candado que ya se movió.
    const gasto = await gastoHoyUsd(db);
    if (!gasto.ok) {
      corrida.motivo = `pasada ${pasada} no arrancó: no se pudo leer el gasto del día (${gasto.error}) — a ciegas no se gasta. La corrida sigue viva; reintenta.`;
      await guardar();
      return cerrarPasada(corrida.motivo, corrida.avance);
    }
    if (gasto.datos >= TOPE_DIA_USD) return await abortarPorDinero('dia', gasto.datos, TOPE_DIA_USD);

    // ── FASE 1: LA SIEMBRA ───────────────────────────────────────────────
    if (corrida.fase === 'siembra' || corrida.memoria === null) {
      if (relojAgotado(venceEn)) {
        corte = 'reloj';
        corrida.corte = 'reloj';
        corrida.motivo = `pasada ${pasada}: el reloj venció antes de poder sembrar el tenant sintético — no se hizo nada y nada se perdió; la siguiente pasada arranca de cero.`;
        await guardar();
        return cerrarPasada(corrida.motivo, corrida.avance);
      }
      const p1 = await paso(`sembrar tenant "${corrida.tenantNombre}" (operador, unidad, política, viaje) — pasada ${pasada}`);
      try {
        const s = await sembrarTenant(db, corrida);
        corrida.tenantId = s.tenantId;
        corrida.memoria = {
          tenantId: s.tenantId, viajeId: s.viajeId, telefono: s.telefono,
          viaje2Id: s.viaje2Id, telefono2: s.telefono2,
        };
        corrida.estado = 'corriendo';
        corrida.inicio ??= new Date().toISOString();
        corrida.fase = 'fotos';
        corrida.corte = null;
        await cerrarPaso(p1, 'ok', 0);
      } catch (e) {
        await cerrarPaso(p1, 'bad', null, e instanceof Error ? e.message : String(e));
        corrida.estado = 'fallo';
        corrida.motivo = `la siembra falló: ${e instanceof Error ? e.message : e}`;
        corrida.fin = new Date().toISOString();
        corrida.fase = 'terminada';
        corrida.limpieza = await limpiarTenant(db, corrida);
        await guardar();
        return cerrarPasada(corrida.motivo, corrida.avance);
      }
    }

    const memoria = corrida.memoria as MemoriaCorrida;
    const prefijo = prefijoMensajes(corrida.id);
    const fotoIds = corrida.parametros.fotoIds;
    // El guion se resuelve UNA vez y lo usan dos fases: la de fotos necesita
    // saber si la última está RESERVADA para el ticket tardío (#4), o se
    // quedaría esperando eternamente una foto que por guion no le toca.
    const guion = escenarioPorId(corrida.escenario)?.guion ?? [{ tipo: 'fotos' as const }, { tipo: 'cierre' as const }];
    const actoFotos = guion.find((a): a is Extract<PasoGuion, { tipo: 'fotos' }> => a.tipo === 'fotos');
    const idsFotos = actoFotos ? idsParaActoFotos(actoFotos, fotoIds) : [...fotoIds];
    const reservadaTarde = idFotoTrasCierre(guion, fotoIds);

    // ── FASE 2: LAS FOTOS, UNA POR UNA, CON EL RELOJ EN LA MANO ──────────
    if (corrida.fase === 'fotos') {
      const manifiesto = await leerManifiesto(db);
      if (!manifiesto.ok) {
        corrida.motivo = `pasada ${pasada} no pudo leer el banco de fotos (${manifiesto.error}) — la corrida sigue viva; reintenta.`;
        await guardar();
        return cerrarPasada(corrida.motivo, corrida.avance);
      }
      const porId = new Map<string, FotoBanco>(manifiesto.datos.map((f) => [f.id, f]));

      // Lo que una pasada MUERTA dejó en vuelo. Ni acierto ni fallo: se dice.
      const inter = await marcarInterrumpidas(db, corridaId, pasada);
      if (inter.ok && inter.datos > 0) {
        logger.warn('qa.pasada.fotos_interrumpidas', { corrida: corridaId, pasada, cuantas: inter.datos });
      }

      const previas = await leerFotosDeCorrida(db, corridaId);
      if (!previas.ok) {
        corrida.motivo = `pasada ${pasada} no pudo leer el avance (${previas.error}) — no se manda una foto sin saber si ya se mandó. La corrida sigue viva; reintenta.`;
        await guardar();
        return cerrarPasada(corrida.motivo, corrida.avance);
      }
      const conDueno = new Set(previas.datos.map((f) => f.fotoId));
      // Las duraciones MEDIDAS de esta misma corrida: son las que dimensionan
      // la reserva de tiempo por foto (ver `reservaPorFotoMs`).
      const duraciones: number[] = previas.datos
        .filter((f) => f.fin !== null)
        .map((f) => Date.parse(f.fin as string) - Date.parse(f.inicio))
        .filter((d) => Number.isFinite(d) && d > 0);

      for (let i = 0; i < idsFotos.length; i++) {
        const fotoId = idsFotos[i];
        // CINTURÓN 1 (ahorra red, NO es la garantía): lo que ya tiene dueño no
        // se vuelve a pedir.
        if (conDueno.has(fotoId)) continue;

        // ── EL RELOJ, ANTES DE EMPEZAR LA FOTO Y NUNCA A LA MITAD ────────
        if (relojAgotado(venceEn - reservaPorFotoMs(duraciones))) {
          corte = 'reloj';
          break;
        }

        // CINTURÓN 2 — LA GARANTÍA: la PK de qa_corrida_foto.
        const tomaFoto = await tomarFoto(db, corridaId, fotoId, i + 1, pasada);
        if (!tomaFoto.ok) {
          corrida.motivo = `pasada ${pasada} se detuvo: no se pudo registrar la toma de una foto (${tomaFoto.error}) — sin ese registro no se manda nada, porque no habría cómo saber que ya se mandó.`;
          await guardar();
          return cerrarPasada(corrida.motivo, await avanceAhora());
        }
        if (!tomaFoto.tomada) continue;   // otra pasada la tiene: no es error

        const foto = porId.get(fotoId);
        const p = await paso(`foto ${i + 1}/${fotoIds.length} — ${foto?.etiqueta ?? fotoId} → processInbound (pasada ${pasada})`);
        if (!foto) {
          // Una foto que salió del banco no puede detener a las otras 90: se
          // marca, se dice, y la corrida sigue.
          await cerrarFoto(db, corridaId, fotoId, 'bad', null, `la foto ${fotoId} ya no está en el banco`);
          await cerrarPaso(p, 'bad', null, `la foto ${fotoId} ya no está en el banco`);
          fotosProcesadas += 1;
          continue;
        }

        const t0Foto = Date.now();
        let estadoFoto: 'ok' | 'bad' = 'ok';
        let detalle: string | null = null;
        try {
          const { dataUrl, reintentos } = await dataUrlDeFoto(db, foto);
          if (reintentos > 0) {
            // Declarado aunque la foto salga 'ok': si Storage anduvo saturado,
            // la corrida lo dice foto por foto (incidente 28-ago-2026).
            detalle = `la descarga se reintentó ${reintentos} vez(es) por saturación de Storage antes de salir`;
          }
          await processInbound({
            from: memoria.telefono,
            type: 'image',
            mediaId: `${prefijo}media-${i + 1}`,   // jamás llega a Meta: mediaDataUrlQA lo sustituye
            mediaDataUrlQA: dataUrl,
            // Determinista por foto: si una pasada muriera después de mandarla,
            // un reenvío caería en el mismo claim de `wa_mensaje_procesado`.
            waMessageId: `${prefijo}f${i + 1}`,
          });
        } catch (e) {
          estadoFoto = 'bad';
          // Se CONSERVA la nota del reintento si la hubo: que la descarga
          // costó reintentos y AUN ASÍ algo falló es parte de la verdad.
          detalle = `${detalle ? `${detalle} · ` : ''}${e instanceof Error ? e.message : String(e)}`;
        }
        duraciones.push(Date.now() - t0Foto);

        // EL COSTO MEDIDO de esta foto: el delta del total leído de llm_costo.
        let costoFoto: number | null = null;
        try {
          const antes = corrida.costoUsdTotal;
          const total = await costoTotalUsd(db, memoria.tenantId);
          corrida.costoUsdTotal = total;
          costoFoto = Math.round((total - antes) * 1_000_000) / 1_000_000;
        } catch (e) {
          costoFoto = null;   // NO SE MIDIÓ. Jamás 0.
          detalle = `${detalle ? `${detalle} · ` : ''}costo no leído: ${e instanceof Error ? e.message : e}`;
        }
        await cerrarFoto(db, corridaId, fotoId, estadoFoto, costoFoto, detalle);
        await cerrarPaso(p, estadoFoto === 'ok' ? 'ok' : 'bad', costoFoto, detalle);
        fotosProcesadas += 1;

        if (corrida.costoUsdTotal > TOPE_CORRIDA_USD) {
          return await abortarPorDinero('corrida', corrida.costoUsdTotal, TOPE_CORRIDA_USD);
        }
      }

      const av = await avanceAhora();
      if (corte === 'reloj') {
        corrida.corte = 'reloj';
        corrida.motivo = av
          ? motivoCorteReloj(pasada, fotosProcesadas, av)
          : `RELOJ DE LA PASADA ${pasada} agotado tras ${fotosProcesadas} foto(s); el avance no se pudo releer para decir cuántas faltan.`;
        await guardar();
        logger.warn('qa.pasada.corte_por_reloj', { corrida: corridaId, pasada, fotosProcesadas, sinTurno: av?.sinTurno ?? null });
        return cerrarPasada(corrida.motivo, av);
      }
      if (av === null) {
        corrida.motivo = `pasada ${pasada}: las fotos se mandaron pero el avance no se pudo releer — no se afirma que estén todas. Reintenta.`;
        await guardar();
        return cerrarPasada(corrida.motivo, null);
      }
      // La foto RESERVADA para el ticket tardío no se espera aquí: por guion
      // se manda DESPUÉS del cierre, y esperarla dejaría la corrida pausada
      // para siempre por una foto que esta fase jamás va a mandar.
      const pendientes = av.sinTurnoIds.filter((id) => id !== reservadaTarde);
      if (pendientes.length > 0 || av.enVuelo > 0) {
        // Quedaron fotos que otra pasada tiene tomadas: no se sigue al cierre
        // con el viaje a medio llenar, porque el cuadre juzgaría un viaje
        // incompleto y ese veredicto sería mentira.
        corrida.motivo = `pasada ${pasada}: van ${av.ok} de ${av.total}; ${pendientes.length} sin turno y ${av.enVuelo} tomadas por otra pasada. El cierre espera a que estén todas.`;
        await guardar();
        return cerrarPasada(corrida.motivo, av);
      }
      corrida.fase = 'cierre';
      corrida.corte = null;
      await guardar();
    }

    // ── FASE 3: EL RESTO DEL GUION (foto repetida, cierre, ticket tardío) ──
    const TEXTO_CIERRE = 'listo, ya subí todo';
    if (corrida.fase === 'cierre') {
      if (relojAgotado(venceEn - reservaPorFotoMs([]))) {
        corte = 'reloj';
        corrida.corte = 'reloj';
        corrida.motivo = `pasada ${pasada}: las ${fotoIds.length} fotos están, pero no quedó reloj para el cierre. La siguiente pasada lo hace — nada se repite.`;
        await guardar();
        return cerrarPasada(corrida.motivo, corrida.avance);
      }
      for (const acto of guion) {
        if (acto.tipo === 'fotos') continue;   // ya quedó en la fase anterior

        if (acto.tipo === 'foto_repetida') {
          const fotoId = fotoIds[acto.indice];
          const manifiesto = await leerManifiesto(db);
          const foto = manifiesto.ok && fotoId ? manifiesto.datos.find((f) => f.id === fotoId) : undefined;
          if (!foto || (acto.comoOtroChofer && (!memoria.telefono2 || !memoria.viaje2Id))) {
            const p = await paso(`ataque de dedup — pasada ${pasada}`);
            await cerrarPaso(p, 'bad', null, foto
              ? 'el escenario necesita un segundo chofer y la siembra no lo creó'
              : `el escenario repite la foto #${acto.indice + 1} y la corrida no la trae`);
            corrida.estado = 'fallo';
            corrida.motivo = foto
              ? 'el escenario necesita un segundo chofer y la siembra no lo creó'
              : `el escenario repite la foto #${acto.indice + 1} y la corrida no la trae — elige al menos ${acto.indice + 1} foto(s)`;
            corrida.fase = 'terminada';
            corrida.fin = new Date().toISOString();
            await guardar();
            return cerrarPasada(corrida.motivo, corrida.avance);
          }
          memoria.dedup = {
            imgHash: foto.hash,
            viajeIntentoId: (acto.comoOtroChofer ? memoria.viaje2Id : memoria.viajeId) as string,
          };
          const desde = (acto.comoOtroChofer ? memoria.telefono2 : memoria.telefono) as string;
          const p = await paso(acto.comoOtroChofer
            ? `LA MISMA foto, desde el chofer 2 (otro viaje del mismo tenant) — pasada ${pasada}`
            : `LA MISMA foto, otra vez — pasada ${pasada}`);
          let detalle: string | null = null;
          let estado: PasoQA['estado'] = 'ok';
          try {
            const { dataUrl, reintentos } = await dataUrlDeFoto(db, foto);
            if (reintentos > 0) {
              detalle = `la descarga se reintentó ${reintentos} vez(es) por saturación de Storage antes de salir`;
            }
            await processInbound({
              from: desde, type: 'image',
              mediaId: `${prefijo}media-r1`, mediaDataUrlQA: dataUrl, waMessageId: `${prefijo}r1`,
            });
          } catch (e) {
            estado = 'bad';
            detalle = `${detalle ? `${detalle} · ` : ''}${e instanceof Error ? e.message : String(e)}`;
          }
          let costo: number | null = null;
          try {
            const antes = corrida.costoUsdTotal;
            corrida.costoUsdTotal = await costoTotalUsd(db, memoria.tenantId);
            costo = Math.round((corrida.costoUsdTotal - antes) * 1_000_000) / 1_000_000;
          } catch (e) {
            detalle = `${detalle ? `${detalle} · ` : ''}costo no leído: ${e instanceof Error ? e.message : e}`;
          }
          await cerrarPaso(p, estado, costo, detalle);
          if (corrida.costoUsdTotal > TOPE_CORRIDA_USD) {
            return await abortarPorDinero('corrida', corrida.costoUsdTotal, TOPE_CORRIDA_USD);
          }
          continue;
        }

        if (acto.tipo === 'foto_tras_cierre') {
          // EL ATAQUE DEL INVARIANTE #4 en el carril completo. Mismo criterio
          // que el rápido — no se gasta en un ataque que no se pueda juzgar —
          // más lo que las pasadas exigen: la vara (`liqSembrada` +
          // `montoTicket`) va a la MEMORIA ANTES de mandar el ticket, porque
          // si la pasada muere entre el envío y el juicio, la siguiente tiene
          // que juzgar con los totales de ANTES del ataque (releerlos después
          // mediría contra una liquidación que el bug, si existiera, ya habría
          // alterado); y el envío mismo es idempotente por la PK de
          // `qa_corrida_foto` — dos pasadas solapadas no pagan dos veces.
          const fotoId = reservadaTarde;
          const manifiestoTarde = await leerManifiesto(db);
          const foto = manifiestoTarde.ok && fotoId ? manifiestoTarde.datos.find((f) => f.id === fotoId) : undefined;
          const monto = foto?.ocrEsperado?.monto ?? null;
          if (!fotoId || !foto || monto === null) {
            const p = await paso(`ticket tardío — ataque del invariante #4 (pasada ${pasada})`);
            const motivo = !fotoId || !foto
              ? 'el escenario manda un ticket TRAS el cierre y la corrida no trae esa foto — elige al menos 2 fotos'
              : `la última foto elegida («${foto.etiqueta}») no tiene monto en su verdad-de-terreno: sin monto el oráculo #4 no puede buscar el huérfano, y mandarla sería gastar en un ataque que no se puede juzgar. Elige de última una foto con monto etiquetado.`;
            await cerrarPaso(p, 'bad', null, motivo);
            corrida.estado = 'fallo';
            corrida.motivo = motivo;
            corrida.fase = 'terminada';
            corrida.fin = new Date().toISOString();
            await guardar();
            return cerrarPasada(corrida.motivo, corrida.avance);
          }
          if (!memoria.huerfano) {
            const liq = await db.from('liquidacion')
              .select('total_comprobado, total_anticipo, diferencia')
              .eq('tenant_id', memoria.tenantId).eq('viaje_id', memoria.viajeId).maybeSingle();
            if (liq.error || !liq.data) {
              const p = await paso(`ticket tardío — ataque del invariante #4 (pasada ${pasada})`);
              const motivo = `el cierre no dejó liquidación legible (${liq.error?.message ?? 'sin fila'}): el ataque post-cierre no tiene contra qué juzgarse`;
              await cerrarPaso(p, 'bad', null, motivo);
              corrida.estado = 'fallo';
              corrida.motivo = motivo;
              corrida.fase = 'terminada';
              corrida.fin = new Date().toISOString();
              await guardar();
              return cerrarPasada(corrida.motivo, corrida.avance);
            }
            memoria.huerfano = {
              liqSembrada: {
                totalComprobado: Number(liq.data.total_comprobado),
                totalAnticipo: Number(liq.data.total_anticipo),
                diferencia: Number(liq.data.diferencia),
              },
              montoTicket: monto,
            };
            await guardar();
          }
          const tomaTarde = await tomarFoto(db, corridaId, fotoId, fotoIds.length, pasada);
          if (!tomaTarde.ok) {
            corrida.motivo = `pasada ${pasada} no pudo registrar la toma del ticket tardío (${tomaTarde.error}) — sin ese registro no se manda, porque no habría cómo saber que ya se mandó.`;
            await guardar();
            return cerrarPasada(corrida.motivo, corrida.avance);
          }
          if (tomaTarde.tomada) {
            const p = await paso(`ticket TARDÍO — ${foto.etiqueta} tras el cierre (ataque del invariante #4, pasada ${pasada})`);
            let estadoTarde: 'ok' | 'bad' = 'ok';
            let detalleTarde: string | null = null;
            try {
              const { dataUrl, reintentos } = await dataUrlDeFoto(db, foto);
              if (reintentos > 0) {
                detalleTarde = `la descarga se reintentó ${reintentos} vez(es) por saturación de Storage antes de salir`;
              }
              await processInbound({
                from: memoria.telefono, type: 'image',
                mediaId: `${prefijo}media-tarde`, mediaDataUrlQA: dataUrl, waMessageId: `${prefijo}tarde`,
              });
            } catch (e) {
              estadoTarde = 'bad';
              detalleTarde = `${detalleTarde ? `${detalleTarde} · ` : ''}${e instanceof Error ? e.message : String(e)}`;
            }
            let costoTarde: number | null = null;
            try {
              const antes = corrida.costoUsdTotal;
              corrida.costoUsdTotal = await costoTotalUsd(db, memoria.tenantId);
              costoTarde = Math.round((corrida.costoUsdTotal - antes) * 1_000_000) / 1_000_000;
            } catch (e) {
              detalleTarde = `${detalleTarde ? `${detalleTarde} · ` : ''}costo no leído: ${e instanceof Error ? e.message : e}`;
            }
            await cerrarFoto(db, corridaId, fotoId, estadoTarde, costoTarde, detalleTarde);
            await cerrarPaso(p, estadoTarde, costoTarde, detalleTarde);
            if (corrida.costoUsdTotal > TOPE_CORRIDA_USD) {
              return await abortarPorDinero('corrida', corrida.costoUsdTotal, TOPE_CORRIDA_USD);
            }
          }
          continue;
        }

        // acto.tipo === 'cierre'
        const pC = await paso(`cierre — el chofer escribe «${TEXTO_CIERRE}» (pasada ${pasada})`);
        let detalleC: string | null = null;
        let estadoC: PasoQA['estado'] = 'ok';
        try {
          await processInbound({ from: memoria.telefono, type: 'text', text: TEXTO_CIERRE, waMessageId: `${prefijo}t1` });
          if (!(await hayLiquidacion(db, memoria.tenantId, memoria.viajeId)) && !relojAgotado(venceEn)) {
            detalleC = 'el primer «listo» no cerró; se insistió una vez (mismo criterio que el ejército)';
            await processInbound({ from: memoria.telefono, type: 'text', text: TEXTO_CIERRE, waMessageId: `${prefijo}t2` });
          }
        } catch (e) {
          estadoC = 'bad';
          detalleC = `${detalleC ? `${detalleC} · ` : ''}${e instanceof Error ? e.message : String(e)}`;
        }
        let costoC: number | null = null;
        try {
          const antes = corrida.costoUsdTotal;
          corrida.costoUsdTotal = await costoTotalUsd(db, memoria.tenantId);
          costoC = Math.round((corrida.costoUsdTotal - antes) * 1_000_000) / 1_000_000;
        } catch (e) {
          detalleC = `${detalleC ? `${detalleC} · ` : ''}costo no leído: ${e instanceof Error ? e.message : e}`;
        }
        await cerrarPaso(pC, estadoC, costoC, detalleC);
        if (corrida.costoUsdTotal > TOPE_CORRIDA_USD) {
          return await abortarPorDinero('corrida', corrida.costoUsdTotal, TOPE_CORRIDA_USD);
        }
      }
      corrida.fase = 'oraculos';
      await guardar();
    }

    // ── FASE 4: LA MEDICIÓN DEL OCR + LOS ORÁCULOS ───────────────────────
    if (corrida.fase === 'oraculos') {
      // La medición va ANTES de los oráculos y de la limpieza: la evidencia
      // son los `gasto` del tenant sintético y la limpieza los borra en
      // cascada. Escribe una fila por foto en `qa_foto_lectura` (0239/0246);
      // repetirla (una pasada muerta a medias) no duplica nada — el índice
      // único parcial de la 0246 rebota y aquí se cuenta como "ya medida".
      // Sin este paso la medición NO existe: pasó el 28-ago-2026 — 90 fotos
      // procesadas, $0.29 de modelo medidos, cero lecturas escritas.
      const pM = await paso(`medición del OCR contra la verdad-de-terreno — ${fotoIds.length} fotos (pasada ${pasada})`);
      const dm = detalleMedicion(await medirCorrida(db, corrida));
      await cerrarPaso(pM, dm.estado, 0, dm.detalle);

      const rotulo = ['#1 cuadre_balancea', '#5 cifras_con_fuente', memoria.dedup ? '#3 dedup_comprobante' : null, memoria.huerfano ? '#4 huerfano_post_cierre' : null, '#8 bitacora_registro']
        .filter(Boolean).join(' · ');
      const pO = await paso(`oráculos — ${rotulo} (pasada ${pasada})`);
      corrida.turnos = await turnosDelTenant(db, memoria.tenantId);
      corrida.pdfs = await pdfsDelTenant(db, memoria.tenantId);
      const filas = await filasDelTenant(db, memoria.tenantId);
      const textosBot = corrida.turnos.filter((t) => t.rol === 'assistant').map((t) => t.texto);
      try {
        // LA BITÁCORA DE TODAS LAS PASADAS, no la de ésta. El oráculo #8 sólo
        // mira `msg`, así que el conjunto de mensajes que la corrida fue
        // recordando (`memoria.eventos`) es exactamente su material — juzgarlo
        // con los eventos de la última pasada diría "la bitácora registró lo
        // ocurrido" sabiendo nada más el final.
        const eventos = mezclarEventos(memoria.eventos, bit.eventos.map((e) => e.msg));
        memoria.eventos = eventos;
        corrida.veredicto = await correrOraculos({
          tenantId: memoria.tenantId,
          viajeId: memoria.viajeId,
          textosBot,
          fuentesRespaldo: [filas, corrida.parametros, [TEXTO_CIERRE]],
          eventosBitacora: eventos.map((msg) => ({ msg })),
          eventosEsperados: ['agent.run'],
          dedup: memoria.dedup,
          huerfano: memoria.huerfano,
        });
        const final = estadoFinalDe(corrida.veredicto);
        await cerrarPaso(pO, final === 'ok' ? 'ok' : final === 'parcial' ? 'warn' : 'bad', 0);
        corrida.estado = final;
        if (final === 'parcial') corrida.motivo = 'al menos un oráculo quedó NO VERIFICADO — no se afirma que pasó';
        if (final === 'fallo') corrida.motivo = 'al menos un invariante FALLÓ — abre el veredicto';
        if (final === 'ok') corrida.motivo = null;
      } catch (e) {
        await cerrarPaso(pO, 'bad', 0, e instanceof Error ? e.message : String(e));
        corrida.estado = 'fallo';
        corrida.motivo = `los oráculos no pudieron correr: ${e instanceof Error ? e.message : e}`;
      }
      corrida.fase = 'limpieza';
      await guardar();
    }

    // ── FASE 5: LA LIMPIEZA ──────────────────────────────────────────────
    if (corrida.fase === 'limpieza') {
      const pL = await paso(`limpieza del tenant sintético (pasada ${pasada})`);
      if (corrida.parametros.retencion === 'conservar') {
        corrida.limpieza = `tenant "${corrida.tenantNombre}" (${corrida.tenantId}) CONSERVADO a pedido (retencion=conservar)`;
        await cerrarPaso(pL, 'warn', 0, 'conservado a pedido');
      } else {
        corrida.limpieza = await limpiarTenant(db, corrida);
        await cerrarPaso(pL, corrida.limpieza.startsWith('✅') ? 'ok' : 'warn', 0, corrida.limpieza);
      }
      corrida.fase = 'terminada';
      corrida.fin = new Date().toISOString();
      await guardar();
    }

    const avFinal = await avanceAhora();

    // ── N FALLOS CON LA MISMA FIRMA = UNA SEÑAL (incidente 28-ago-2026) ──
    // La corrida 46ad99ca terminó 'parcial' con 10 fotos 'bad' que eran EL
    // MISMO error diez veces («Too many connections issued to the database»)
    // y nada lo decía como conjunto. Aquí se agrupan por firma (la del PR
    // #183) y se escriben en el motivo como UN patrón, con su log — así el
    // que mire la corrida busca UNA causa en vez de reabrir diez fotos.
    const filasFinal = await leerFotosDeCorrida(db, corridaId);
    if (filasFinal.ok) {
      const patrones = patronesDeFallo(filasFinal.datos);
      const frase = fraseFallosMismaFirma(patrones);
      if (frase) {
        corrida.motivo = corrida.motivo ? `${corrida.motivo} · ${frase}` : frase;
        logger.warn('qa.corrida.fallos_misma_firma', {
          corrida: corridaId, carril: 'completo',
          patrones: patrones.map((p) => ({ firma: p.firma, veces: p.veces })),
        });
      }
    }

    await guardar();
    return cerrarPasada(
      corrida.motivo ?? `corrida terminada en ${corrida.pasadas} pasada(s): ${avFinal?.ok ?? '?'} de ${avFinal?.total ?? corrida.parametros.fotoIds.length} fotos procesadas`,
      avFinal,
    );
  } catch (e) {
    // Red final: nada de este motor debe tumbar la invocación sin dejar rastro.
    corrida.estado = 'fallo';
    corrida.fase = 'terminada';
    corrida.motivo = `error no anticipado en la pasada ${pasada}: ${e instanceof Error ? e.message : String(e)}`;
    corrida.fin = new Date().toISOString();
    if (!corrida.limpieza) {
      corrida.limpieza = `tenant "${corrida.tenantNombre}" posiblemente sembrado — revisar y limpiar a mano`;
    }
    await guardar().catch(() => {});
    return cerrarPasada(corrida.motivo, corrida.avance);
  } finally {
    bit.restaurar();
    restaurarFetch();
    // La llave SIEMPRE se suelta, y sólo si sigue siendo nuestra. Si esto no
    // corre (Vercel mató la invocación), `PASADA_MUERTA_MS` la libera sola.
    await soltarPasada(db, corridaId, pasadaId).catch((err) => {
      logger.warn('qa.pasada.no_solto_llave', { corrida: corridaId, pasada, error: String(err) });
    });
  }
}
