import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { acotada } from './presupuesto';
import { traerTodo, traerPorIds, conteo } from './pg';
import { sendText } from '@/lib/meta/client';
import { telefonoJefeDe, telefonoParaDineroDe } from './contactos';
import { anotarEventoIncidencia } from './asistencia_wa';
import { hazmatDeclarado } from './perfil/preguntas';
import { DIAS_AVISO } from './vigencias';
import { hoyMx } from '@/lib/formato';

// ═══════════════════════════════════════════════════════════════════════════
// LOS RELOJES LEGALES (Fase 6 del plan de back office — etapa 14 del ciclo).
//
// Puro reloj sobre datos que Likida YA tiene, y los montos son brutales:
// una sustitución de CFDI hecha en el orden equivocado, un aviso de matpel
// que no se presentó en 3 días hábiles (hasta 500 UMA por omitirlo), o una
// verificación vencida que un inspector encuentra primero.
//
// TRES RELOJES, UN PRINCIPIO: Likida AVISA con el plazo y el paso exacto;
// jamás ejecuta el acto legal (no cancela CFDI, no presenta avisos ante
// SICT/ASEA, no marca a nadie). El mismo principio del circuito de
// siniestros: una llamada o un trámite automático es un acto jurídico, y
// esos son de la flota.
//
// ── POR QUÉ LOS TELÉFONOS DE EMERGENCIA SON SOLO DOS ──────────────────────
// SETIQ (800 002 1400) y CENACOM (55 5128 0000) están verificados por triple
// fuente y la NOM-005 obliga a llevar el primero a bordo. El 088 de Guardia
// Nacional, el 078 de Ángeles Verdes y el 800 de PROFEPA NO se pudieron
// confirmar — y un teléfono equivocado en una emergencia es peor que
// ninguno: NO entran a ningún texto hasta confirmarse por teléfono.
// ═══════════════════════════════════════════════════════════════════════════

// ── 1. El aviso preventivo de ValorMercancia (pantalla de Carta Porte) ─────

/**
 * El dato que nadie le dice a la flota ANTES del siniestro: `ValorMercancia`
 * es opcional para el SAT pero define la indemnización. Sin valor declarado
 * (y sin prima pactada), el tope legal es 15 UMA por tonelada — con la UMA
 * 2026 ($117.31/día), $1,759.65 por tonelada. Una carga de 20 toneladas que
 * valía $2,000,000 se indemniza con ~$35,193.
 *
 * Fundamento: Ley de Caminos, Puentes y Autotransporte Federal (la regla de
 * las 15 UMA/ton por pérdida de carga general). OJO — el corpus de
 * `normas/` NO tiene ficha verificada de este artículo todavía: por eso el
 * texto se presenta como dato de la LCPAF con su cifra, no como veredicto
 * del motor, y no entra a `guardiaFundamento`. Al verificarse la ficha, la
 * cita se endurece.
 */
export const AVISO_VALOR_MERCANCIA = {
  titulo: 'Sin ValorMercancia declarado, la indemnización legal es de $1,759.65 por tonelada',
  cuerpo:
    'El campo ValorMercancia del complemento es opcional para el SAT, pero define cuánto ' +
    'respondería el transportista si la carga se pierde: sin valor declarado y sin prima ' +
    'pactada, el tope legal es 15 UMA por tonelada (~$1,759.65/t con la UMA 2026) — no el ' +
    'valor real de la mercancía. Con valor declarado y prima pagada, se responde por el ' +
    'total incluso ante caso fortuito. Y del seguro, el CFDI solo obliga a declarar el de ' +
    'responsabilidad civil: el de CARGA es opcional — justo el que importa cuando la ' +
    'mercancía se pierde. Likida hoy no captura ValorMercancia: decláralo al emitir con tu PAC.',
  fundamento: 'Ley de Caminos, Puentes y Autotransporte Federal (tope de 15 UMA/ton; sin ficha verificada en el corpus todavía — no es un veredicto del motor)',
} as const;

// ── 2. Textos de los relojes por incidencia (puros, probados solos) ────────

/**
 * La sustitución de un CFDI por siniestro/robo tiene un ORDEN obligatorio que
 * al revés deja a la flota sin comprobante válido: primero el CFDI nuevo
 * relacionado con `TipoRelacion 04` (sustitución de los CFDI previos), y SOLO
 * DESPUÉS cancelar el original con motivo 01 ("comprobante emitido con
 * errores con relación"). Cancelar primero rompe la relación que el motivo 01
 * exige. Likida NO emite ni cancela: prepara el paso exacto para quien sí.
 */
export function mensajeSustitucionCfdi(folioViaje: string | null, folioFactura: string | null): string {
  const viaje = folioViaje ? `del viaje ${folioViaje}` : 'del viaje afectado';
  const factura = folioFactura ? ` (factura ${folioFactura})` : '';
  return (
    `📄 Por el siniestro/robo ${viaje}: el CFDI emitido${factura} no se cancela a secas — el SAT ordena SUSTITUIR, en este orden:\n` +
    `1) Emitir el CFDI nuevo relacionándolo al original con TipoRelacion 04 (sustitución).\n` +
    `2) Solo DESPUÉS, cancelar el original con motivo 01 (emitido con errores CON relación).\n` +
    `Al revés, la cancelación queda sin relación válida y el cliente sin comprobante. Lo emite tu PAC — Likida no timbra ni cancela.`
  );
}

/**
 * Los relojes de materiales peligrosos, con plazo y ventanilla. Solo se
 * mandan si la flota DECLARÓ hazmat en su perfil: un reloj que no aplica
 * entrena a ignorar los que sí.
 */
export function mensajeRelojesMatpel(folioViaje: string | null): string {
  const viaje = folioViaje ? `del viaje ${folioViaje}` : 'del viaje afectado';
  return (
    `⏱️ Tu flota declaró mover materiales peligrosos. Si el incidente ${viaje} involucró la carga, estos relojes YA CORREN:\n` +
    `· SICT + SEMARNAT: aviso en ≤3 días hábiles (RTTMRP 57 Bis; omitirlo alcanza multa de hasta 500 UMA).\n` +
    `· PROFEPA: aviso inmediato y formalización en 3 días hábiles (trámite PROFEPA-03-017 mod. B).\n` +
    `· ASEA: informe inicial en 6 h (Tipo 3) o 12 h (Tipo 2), y cierre en ≤10 días naturales ANEXANDO copia de la Carta Porte (art. 14 Sexies) — la Carta Porte de este viaje vive en Likida.\n` +
    `Emergencia química en curso: SETIQ 800 002 1400 (24 h, sin WhatsApp — es llamada). CENACOM 55 5128 0000.\n` +
    `Los avisos los presenta la flota; Likida te da el plazo y el papel, no presenta trámites.`
  );
}

/**
 * Lo que conviene saber ANTE un retén/detención de la unidad — puro dato
 * legal informativo, sin tabla de multas detrás (no existe todavía; construir
 * el módulo completo de multas es el siguiente paso, no esta fase).
 */
export function mensajeMultasReten(folioViaje: string | null): string {
  const viaje = folioViaje ? `del viaje ${folioViaje}` : 'de la unidad detenida';
  return (
    `⚖️ Sobre la detención ${viaje}, tres datos que valen dinero:\n` +
    `· Multa de tránsito: −25% por reconocer la falta y −25% adicional pagando en 15 días hábiles (aplica a tránsito, no al tabulador de báscula).\n` +
    `· Hay 30 días hábiles para pagar antes de que el vehículo se turne a la autoridad fiscal.\n` +
    `· Art. 76 de la Ley de Caminos: se puede garantizar el monto y pedir que el vehículo quede EN DEPÓSITO del conductor o del propietario — la unidad sigue trabajando mientras se resuelve.\n` +
    `Guarda el folio del acta: reincidir dos veces en 2 años faculta a la SICT a revocar el permiso.`
  );
}

// ── 3. El reloj por incidencia: escanea, arma, manda UNA vez ───────────────

/** Evento de bitácora que sella "los relojes legales de esta incidencia ya se
 *  avisaron" — la idempotencia del escaneo horario. */
const EVENTO_RELOJ = 'reloj_legal_avisado';

/** Tipos de incidencia que traen relojes legales colgando. `varado` y
 *  `emergencia_medica` no: no hay acto fiscal ni trámite con plazo. */
const TIPOS_CON_RELOJ = ['siniestro', 'robo', 'bloqueo'] as const;

/** 72 h: más que cualquier arranque de emergencia real, y no reprocesa el
 *  histórico completo en cada corrida — el mismo corte que el expediente
 *  único de asistencia. */
const VENTANA_MS = 72 * 3_600_000;

export interface ResultadoRelojes {
  /** Incidencias con reloj en la ventana, ya descontadas las selladas. */
  revisadas: number;
  avisadas: number;
  fallos: number;
  /** BE-7: las que no alcanzaron turno porque el reloj del cron venció. Se
   *  recogen enteras en la corrida siguiente (no se sellan). */
  cortadasPorReloj: number;
}

/** El reloj que los barridos reciben del cron (BE-7, auditoría 24). Sin él
 *  corren hasta acabar — como en la Mac o en una prueba. */
export interface OpcionesBarrido {
  /** Instante (ms) a partir del cual NO se arranca otro envío. */
  venceEn?: number;
}

interface IncidenciaConReloj {
  id: string;
  tenantId: string;
  tipo: string;
  viajeId: string | null;
}

/**
 * El barrido horario: incidencias recientes de siniestro/robo/bloqueo que aún
 * no recibieron su aviso de relojes legales. Corre dentro del cron de
 * escalar (cada hora — los plazos más cortos son de horas-días, no de
 * minutos: el cron de asistencia de 5 min es para la emergencia humana, no
 * para el trámite).
 *
 * Best-effort POR INCIDENCIA y declarado: un aviso que no salió se loguea y
 * se reintenta a la siguiente corrida (el sello solo se pone tras mandar).
 */
export async function avisarRelojesLegales(ahora: Date = new Date(), opts: OpcionesBarrido = {}): Promise<ResultadoRelojes> {
  const desde = new Date(ahora.getTime() - VENTANA_MS).toISOString();
  const admin = supabaseAdmin();
  // AUDITORÍA 24, BE-31: esto era `limit(100)` sin `order` y sin descontar
  // las ya selladas — 130 incidencias en 72 h devolvían 100 arbitrarias, las
  // selladas gastaban ranura y las 30 restantes salían de la ventana sin
  // aviso, con `revisadas = 100` y latido `ok`. Ahora se leen TODAS las de la
  // ventana (`traerTodo`, orden único por `abierta_en, id`) y los sellos se
  // descuentan de un golpe, en tandas, antes de repartir turnos.
  const data = await traerTodo<{ id: unknown; tenant_id: unknown; tipo: unknown; viaje_id: unknown }>(
    (d, h) => acotada(admin
      .from('incidencia')
      .select('id, tenant_id, tipo, viaje_id', conteo(d))
      .in('tipo', [...TIPOS_CON_RELOJ])
      .neq('estado', 'resuelta')
      .gte('abierta_en', desde)
      .order('abierta_en', { ascending: true }).order('id', { ascending: true })
      .range(d, h), 'relojes.incidencias'),
    'relojes.incidencias',
  );

  const todas: IncidenciaConReloj[] = data.map((f) => ({
    id: f.id as string,
    tenantId: f.tenant_id as string,
    tipo: f.tipo as string,
    viajeId: (f.viaje_id as string) || null,
  }));

  // El anti-join con los sellos: una lectura por tanda, no una por incidencia.
  // El sello vive en la bitácora de la incidencia — el mismo expediente que
  // lee el panel, no un estado paralelo.
  //
  // El barrido es CROSS-TENANT a propósito (un cron sobre todas las flotas),
  // igual que la lectura de `incidencia` de arriba: no hay un `tenant_id`
  // único que filtrar. Lo que sí se hace —y por eso `tenant_id` viaja en el
  // select— es casar el sello con el PAR (flota, incidencia): un sello solo
  // descuenta a la incidencia de SU flota, nunca a una homónima de otra.
  //
  // AUDITORÍA 28 (REN-M4): el sello va POR CANAL, no como un booleano único.
  // Una incidencia con dinero+operación puede tener UN canal fallido y el
  // otro entregado — antes, con que UNO saliera se sellaba la incidencia
  // ENTERA (`alguienRecibio`) y el canal que falló no se volvía a intentar
  // JAMÁS. Puede haber más de un evento `EVENTO_RELOJ` por incidencia (uno
  // parcial, otro completando lo que faltó): se OR-mergean. Un evento SIN
  // `detalle` legible (el formato del sello antes de este arreglo, o el
  // `{ aviso: 'sin_relojes_aplicables' }` de cuando nada aplica) se trata
  // como sellado por completo — no hay nada que reintentar por canal si el
  // sello es previo a que existiera el desglose.
  const sellos = todas.length === 0 ? [] : await traerPorIds<{ incidencia_id: unknown; tenant_id: unknown; detalle: unknown }>(
    todas.map((i) => i.id),
    (tanda) => acotada(admin
      .from('incidencia_evento')
      .select('incidencia_id, tenant_id, detalle')
      .eq('tipo', EVENTO_RELOJ)
      .in('incidencia_id', tanda), 'relojes.sellos'),
    'relojes.sellos',
  );
  const selloPorClave = new Map<string, SelloCanales>();
  for (const s of sellos) {
    const clave = `${String(s.tenant_id)}:${String(s.incidencia_id)}`;
    const previo = selloPorClave.get(clave) ?? { dinero: false, operacion: false };
    const d = s.detalle as { dinero?: unknown; operacion?: unknown; aviso?: unknown } | null;
    // Legado: sello sin desglose leíble (formato viejo, o "nada aplicaba") —
    // se toma como sellado por completo, no como "ningún canal enviado".
    const sinDesglose = d == null || d.aviso === 'sin_relojes_aplicables' || typeof d.dinero !== 'boolean';
    selloPorClave.set(clave, {
      dinero: previo.dinero || sinDesglose || d?.dinero === true,
      operacion: previo.operacion || sinDesglose || d?.operacion === true,
    });
  }
  const pendientes = todas
    .map((inc) => ({ inc, sello: selloPorClave.get(`${inc.tenantId}:${inc.id}`) ?? { dinero: false, operacion: false } }))
    .filter(({ sello }) => !(sello.dinero && sello.operacion));

  const r: ResultadoRelojes = { revisadas: pendientes.length, avisadas: 0, fallos: 0, cortadasPorReloj: 0 };
  for (const [n, { inc, sello }] of pendientes.entries()) {
    // BE-7: el reloj se mira ANTES de cada incidencia, no después. Un aviso
    // que arranca sin presupuesto muere a media escritura: WhatsApp fuera y
    // sello sin poner, o sea el reenvío de la hora siguiente.
    if (opts.venceEn !== undefined && Date.now() >= opts.venceEn) {
      r.cortadasPorReloj = pendientes.length - n;
      logger.warn('relojes.cortado_por_reloj', { pendientes: r.cortadasPorReloj });
      break;
    }
    try {
      const hecho = await avisarRelojesDeIncidencia(inc, sello);
      if (hecho) r.avisadas++;
    } catch (e) {
      r.fallos++;
      logger.error('relojes.incidencia_fallo', { incidencia: inc.id, err: e instanceof Error ? e.message : String(e) });
    }
  }
  return r;
}

/** Qué canales de aviso de una incidencia ya quedaron resueltos — enviados
 *  con éxito, o simplemente no aplicables. `false` es lo único que pide
 *  reintento. */
interface SelloCanales { dinero: boolean; operacion: boolean }

/** `true` si ESTA corrida mandó AL MENOS UN aviso nuevo (la que no tenía
 *  nada pendiente, o cuyos envíos volvieron a fallar, devuelve false). */
async function avisarRelojesDeIncidencia(
  inc: IncidenciaConReloj,
  yaAvisado: SelloCanales = { dinero: false, operacion: false },
): Promise<boolean> {
  // El sello ya se descontó en `avisarRelojesLegales` (una lectura por tanda,
  // BE-31): aquí solo llegan incidencias sin aviso.
  const folio = inc.viajeId ? await folioDelViaje(inc.tenantId, inc.viajeId) : null;

  // Qué relojes aplican a ESTA incidencia. Cada uno con su canal correcto:
  // la sustitución del CFDI es un acto fiscal → quien ve dinero (dueño,
  // contador); matpel y retén son operación → el jefe.
  const partesDinero: string[] = [];
  const partesOperacion: string[] = [];

  if (inc.tipo === 'siniestro' || inc.tipo === 'robo') {
    const factura = inc.viajeId ? await facturaEmitidaDelViaje(inc.tenantId, inc.viajeId) : null;
    // Sin CFDI emitido no hay nada que sustituir — y no se avisa un trámite
    // que no existe.
    if (factura) partesDinero.push(mensajeSustitucionCfdi(folio, factura));

    const hazmat = await flotaDeclaraHazmat(inc.tenantId);
    if (hazmat === true) partesOperacion.push(mensajeRelojesMatpel(folio));
  }
  if (inc.tipo === 'bloqueo') {
    partesOperacion.push(mensajeMultasReten(folio));
  }

  if (partesDinero.length === 0 && partesOperacion.length === 0) {
    // Nada que avisar (p.ej. siniestro sin factura y sin hazmat). Se sella
    // igual: volver a evaluar lo mismo cada hora no va a cambiar la respuesta,
    // y el sello dice POR QUÉ no hubo aviso.
    await anotarEventoIncidencia(inc.tenantId, inc.id, EVENTO_RELOJ, { aviso: 'sin_relojes_aplicables' });
    return false;
  }

  // POR CANAL (REN-M4): el que ya salió en una corrida previa NO se reintenta
  // — reenviar un aviso ya entregado no es el problema que este barrido
  // resuelve. El que sigue pendiente (nunca aplicó, o aplicó y falló) sí se
  // intenta, sin que el estado del OTRO canal lo condicione en ningún sentido.
  let dineroEnviadoAhora = false;
  if (partesDinero.length > 0 && !yaAvisado.dinero) {
    const tel = await telefonoParaDineroDe(inc.tenantId);
    if (tel && await sendText(tel, partesDinero.join('\n\n'))) dineroEnviadoAhora = true;
    else logger.warn('relojes.dinero_sin_destinatario', { incidencia: inc.id, tenia_telefono: Boolean(tel) });
  }
  let operacionEnviadoAhora = false;
  if (partesOperacion.length > 0 && !yaAvisado.operacion) {
    const tel = await telefonoJefeDe(inc.tenantId);
    if (tel && await sendText(tel, partesOperacion.join('\n\n'))) operacionEnviadoAhora = true;
    else logger.warn('relojes.operacion_sin_destinatario', { incidencia: inc.id, tenia_telefono: Boolean(tel) });
  }

  // El sello SOLO si algo salió NUEVO esta corrida: un canal que vuelve a
  // fallar no se sella (se reintenta a la siguiente), y uno que no tenía
  // nada pendiente no genera una fila de bitácora vacía. El desglose que se
  // escribe es el estado FINAL de cada canal — sellado ya sea porque no
  // aplicaba, porque venía sellado de antes, o porque se acaba de enviar —
  // para que el próximo anti-join sepa exactamente qué queda pendiente.
  if (dineroEnviadoAhora || operacionEnviadoAhora) {
    await anotarEventoIncidencia(inc.tenantId, inc.id, EVENTO_RELOJ, {
      dinero: yaAvisado.dinero || partesDinero.length === 0 || dineroEnviadoAhora,
      operacion: yaAvisado.operacion || partesOperacion.length === 0 || operacionEnviadoAhora,
    });
    logger.info('relojes.avisado', { incidencia: inc.id, tipo: inc.tipo });
    return true;
  }
  return false;
}

async function folioDelViaje(tenantId: string, viajeId: string): Promise<string | null> {
  try {
    const { data } = await acotada(supabaseAdmin()
      .from('viaje').select('folio')
      .eq('id', viajeId).eq('tenant_id', tenantId).maybeSingle(), 'relojes.folio');
    return (data?.folio as string) || null;
  } catch {
    return null; // el folio es un rótulo — sin él, el aviso sale igual
  }
}

/** El folio de la factura EMITIDA (con CFDI timbrado) que ampara el viaje —
 *  por la liga directa `viaje_id` o por `factura_viaje`. `null` = no hay
 *  nada que sustituir. */
async function facturaEmitidaDelViaje(tenantId: string, viajeId: string): Promise<string | null> {
  const admin = supabaseAdmin();
  const { data: directa, error: e1 } = await acotada(admin
    .from('factura_emitida')
    .select('folio, cfdi_uuid')
    .eq('tenant_id', tenantId).eq('viaje_id', viajeId)
    .not('cfdi_uuid', 'is', null)
    .limit(1), 'relojes.factura_directa');
  if (e1) throw new Error(`relojes.factura: ${e1.message}`);
  if ((directa ?? []).length > 0) return (directa![0].folio as string) || 'sin folio';

  const { data: liga, error: e2 } = await acotada(admin
    .from('factura_viaje')
    .select('factura_id')
    .eq('viaje_id', viajeId)
    .limit(5), 'relojes.factura_liga');
  if (e2) throw new Error(`relojes.factura_liga: ${e2.message}`);
  const ids = (liga ?? []).map((f) => f.factura_id as string);
  if (ids.length === 0) return null;
  const { data: facturas, error: e3 } = await acotada(admin
    .from('factura_emitida')
    .select('folio, cfdi_uuid')
    .eq('tenant_id', tenantId).in('id', ids)
    .not('cfdi_uuid', 'is', null)
    .limit(1), 'relojes.factura_por_liga');
  if (e3) throw new Error(`relojes.factura_por_liga: ${e3.message}`);
  if ((facturas ?? []).length > 0) return (facturas![0].folio as string) || 'sin folio';
  return null;
}

/** ALT-176 (auditoría 25, REINCIDENTE): antes tragaba el `error` de
 *  supabase-js y devolvía `null` — el MISMO valor que "la flota no declaró
 *  hazmat". `avisarRelojesDeIncidencia` no distingue esos dos casos, así que
 *  un blip de red sellaba `sin_relojes_aplicables` PARA SIEMPRE (el anti-join
 *  de sellos lo descarta en cada corrida futura). Ahora se LANZA ante
 *  `error`, igual que la hermana `facturaEmitidaDelViaje`: el `try/catch` de
 *  `avisarRelojesLegales` lo cuenta como `fallos` y reintenta en la próxima
 *  corrida, en vez de sellar. */
async function flotaDeclaraHazmat(tenantId: string): Promise<boolean | null> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('tenant').select('perfil')
    .eq('id', tenantId).maybeSingle(), 'relojes.hazmat');
  if (error) throw new Error(`relojes.hazmat: ${error.message}`);
  return hazmatDeclarado(data?.perfil ?? null);
}

// ── 4. Vencimientos de flota: 30/7/0 días, un aviso por umbral ─────────────

/** Los tres umbrales. 30 es `DIAS_AVISO` de vigencias.ts — el MISMO número
 *  que pinta la pastilla "por vencer" en el panel: el WhatsApp y la pantalla
 *  tienen que empezar a avisar el mismo día o uno de los dos miente. */
export const UMBRALES_VIGENCIA = [DIAS_AVISO, 7, 0] as const;

/** El umbral MÁS APRETADO que los días restantes ya cruzaron. `null` = aún
 *  lejos. Vencido (negativo) sigue siendo umbral 0: el aviso de vencido se
 *  manda una vez, no uno diario a perpetuidad. */
export function umbralCruzado(diasRestantes: number): 0 | 7 | 30 | null {
  if (diasRestantes <= 0) return 0;
  if (diasRestantes <= 7) return 7;
  if (diasRestantes <= DIAS_AVISO) return 30;
  return null;
}

/** Diferencia en días entre dos fechas ISO `YYYY-MM-DD`, a mediodía UTC para
 *  esquivar husos — el mismo truco de `ventanaDelViaje`. */
export function diasEntreIso(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T12:00:00Z`) - Date.parse(`${desde}T12:00:00Z`)) / 86_400_000);
}

export interface VencimientoPorAvisar {
  tenantId: string;
  objeto: 'unidad' | 'operador' | 'flota_poliza';
  objetoId: string;
  documento: 'poliza' | 'permiso_sict' | 'verificacion' | 'licencia' | 'poliza_flota';
  rotulo: string;
  vence: string;
  dias: number;
  umbral: 0 | 7 | 30;
}

const ROTULO_DOC: Record<VencimientoPorAvisar['documento'], string> = {
  poliza: 'Póliza de la unidad',
  permiso_sict: 'Permiso SICT',
  verificacion: 'Verificación físico-mecánica',
  licencia: 'Licencia federal',
  poliza_flota: 'Póliza de la flota',
};

export interface ResultadoVencimientos {
  candidatos: number;
  avisados: number;
  fallos: number;
  /** BE-7: vencimientos (no flotas) que quedaron sin aviso porque el reloj
   *  del cron venció. Sin sello: la corrida siguiente los recoge. */
  cortadosPorReloj: number;
}

/**
 * El barrido de vencimientos. Cada (documento, umbral, fecha) avisa UNA sola
 * vez — el sello vive en `aviso_vigencia` (0202) con la fecha en la llave:
 * el documento RENOVADO (fecha nueva) vuelve a avisar en su propio ciclo,
 * que es exactamente lo que se quiere.
 *
 * La verificación físico-mecánica es ANUAL (no semestral) — el dato ya vivía
 * en `vigencias.ts`; aquí solo se le pone WhatsApp al mismo reloj. Y el
 * permiso SICT importa doble: reincidir dos veces en 2 años en ciertas
 * faltas faculta a la SICT a REVOCAR el permiso.
 */
export async function avisarVencimientos(ahora: Date = new Date(), opts: OpcionesBarrido = {}): Promise<ResultadoVencimientos> {
  const hoy = hoyMx(ahora);
  const admin = supabaseAdmin();

  // Solo lo que está a ≤ DIAS_AVISO (o vencido) entra al cálculo — el resto
  // de la flota no se recorre. `lte` sobre fecha usa los índices existentes.
  const horizonte = new Date(Date.parse(`${hoy}T12:00:00Z`) + DIAS_AVISO * 86_400_000)
    .toISOString().slice(0, 10);
  // AUDITORÍA FABLE CICLO 2 (c2-7): las consultas llevaban `limit(500)` sin
  // `order` ni piso — con los años, las 500 filas se llenarían de vencidos
  // históricos (ya avisados y sellados) y los vencimientos NUEVOS quedarían
  // fuera del corte sin declararlo. El piso corta el arrastre: un documento
  // vencido hace más de un año ya recibió su aviso de umbral 0 en su momento
  // (el sello 0202 lo prueba), y el recordatorio hourly dejó de ser la
  // herramienta — eso vive en el panel de Unidades/Operadores.
  const piso = new Date(Date.parse(`${hoy}T12:00:00Z`) - 366 * 86_400_000)
    .toISOString().slice(0, 10);

  // AUDITORÍA 24, BE-10 (ALTO): las tres lecturas llevaban `limit(500)` — y la
  // de unidades ni `order`. El filtro matchea si CUALQUIERA de los tres
  // documentos cae en 13 meses, o sea la mayor parte de una flota activa: con
  // 800 tractocamiones volvían 500 en orden de plan, ECO-114 con la póliza a
  // 7 días quedaba en la posición 620 y nunca entraba a `candidatos`; el
  // latido salía `ok` y el sello decía «no había aviso pendiente». Ahora las
  // tres se leen COMPLETAS con `traerTodo` (orden único por `id`; lanza si la
  // lectura sale corta), que es la única forma de que «Likida avisa» sea
  // verdad a la escala del piloto.
  const [unidades, operadores, polizas] = await Promise.all([
    traerTodo<Record<string, unknown>>((d, h) => acotada(admin.from('unidad')
      .select('id, tenant_id, numero_economico, poliza_vence, permiso_sict_vence, verificacion_vence', conteo(d))
      .eq('activo', true)
      .or([
        `and(poliza_vence.gte.${piso},poliza_vence.lte.${horizonte})`,
        `and(permiso_sict_vence.gte.${piso},permiso_sict_vence.lte.${horizonte})`,
        `and(verificacion_vence.gte.${piso},verificacion_vence.lte.${horizonte})`,
      ].join(','))
      .order('id', { ascending: true })
      .range(d, h), 'vencimientos.unidades'), 'vencimientos.unidades'),
    traerTodo<Record<string, unknown>>((d, h) => acotada(admin.from('operador')
      .select('id, tenant_id, nombre, licencia_vence', conteo(d))
      .gte('licencia_vence', piso)
      .lte('licencia_vence', horizonte)
      .order('id', { ascending: true })
      .range(d, h), 'vencimientos.operadores'), 'vencimientos.operadores'),
    traerTodo<Record<string, unknown>>((d, h) => acotada(admin.from('flota_poliza')
      .select('id, tenant_id, aseguradora, vigencia_hasta', conteo(d))
      .gte('vigencia_hasta', piso)
      .lte('vigencia_hasta', horizonte)
      .order('id', { ascending: true })
      .range(d, h), 'vencimientos.polizas'), 'vencimientos.polizas'),
  ]);

  const candidatos: VencimientoPorAvisar[] = [];
  const empuja = (tenantId: string, objeto: VencimientoPorAvisar['objeto'], objetoId: string,
    documento: VencimientoPorAvisar['documento'], quien: string, vence: unknown) => {
    if (typeof vence !== 'string' || !vence) return;
    const dias = diasEntreIso(hoy, vence.slice(0, 10));
    const umbral = umbralCruzado(dias);
    if (umbral === null) return;
    candidatos.push({
      tenantId, objeto, objetoId, documento, vence: vence.slice(0, 10), dias, umbral,
      rotulo: `${ROTULO_DOC[documento]} de ${quien}`,
    });
  };
  for (const u of unidades) {
    const quien = (u.numero_economico as string) || 'unidad';
    empuja(u.tenant_id as string, 'unidad', u.id as string, 'poliza', quien, u.poliza_vence);
    empuja(u.tenant_id as string, 'unidad', u.id as string, 'permiso_sict', quien, u.permiso_sict_vence);
    empuja(u.tenant_id as string, 'unidad', u.id as string, 'verificacion', quien, u.verificacion_vence);
  }
  for (const o of operadores) {
    empuja(o.tenant_id as string, 'operador', o.id as string, 'licencia', (o.nombre as string) || 'operador', o.licencia_vence);
  }
  for (const p of polizas) {
    empuja(p.tenant_id as string, 'flota_poliza', p.id as string, 'poliza_flota', (p.aseguradora as string) || 'la flota', p.vigencia_hasta);
  }

  const r: ResultadoVencimientos = { candidatos: candidatos.length, avisados: 0, fallos: 0, cortadosPorReloj: 0 };
  if (candidatos.length === 0) return r;

  // ¿Cuáles ya se avisaron? Una consulta por corrida, no una por candidato.
  // AUDITORÍA FABLE CICLO 2 (c2-4): esto era un select plano — PostgREST lo
  // recorta a 1,000 filas EN SILENCIO (el riesgo que pg.ts documenta), y los
  // sellos solo crecen: al pasar el corte, `sellados` quedaba incompleto y
  // los vencimientos ya avisados se RE-avisaban por WhatsApp cada hora — lo
  // exacto que la 0202 existe para impedir. `traerTodo` pagina y lanza si la
  // lectura sale corta, y el filtro por los `vence` de los candidatos acota
  // el conjunto a lo que esta corrida de verdad va a consultar.
  const fechasVence = [...new Set(candidatos.map((c) => c.vence))];
  const tenantsConCandidato = [...new Set(candidatos.map((c) => c.tenantId))];
  const sellos = await traerTodo<{ tenant_id: unknown; objeto: unknown; objeto_id: unknown; documento: unknown; umbral: unknown; vence: unknown }>(
    (d, h) => acotada(admin
      .from('aviso_vigencia')
      .select('tenant_id, objeto, objeto_id, documento, umbral, vence', conteo(d))
      .in('tenant_id', tenantsConCandidato)
      .in('vence', fechasVence)
      .order('tenant_id').order('objeto_id').order('documento').order('umbral').order('vence')
      .range(d, h), 'vencimientos.sellos'),
    'vencimientos.sellos',
  );
  const sellados = new Set(sellos.map((s) =>
    `${s.tenant_id}|${s.objeto}|${s.objeto_id}|${s.documento}|${s.umbral}|${String(s.vence).slice(0, 10)}`));
  const porAvisar = candidatos.filter((c) =>
    !sellados.has(`${c.tenantId}|${c.objeto}|${c.objetoId}|${c.documento}|${c.umbral}|${c.vence}`));
  if (porAvisar.length === 0) return r;

  // UN mensaje por flota con todos sus vencimientos nuevos — diez WhatsApps
  // seguidos entrenan a ignorar el canal; una lista se lee.
  const porTenant = new Map<string, VencimientoPorAvisar[]>();
  for (const c of porAvisar) {
    (porTenant.get(c.tenantId) ?? porTenant.set(c.tenantId, []).get(c.tenantId)!).push(c);
  }

  const flotas = [...porTenant.entries()];
  for (const [n, [tenantId, items]] of flotas.entries()) {
    // BE-7 (auditoría 24): el reloj se mira ANTES de cada flota. Este barrido
    // sella DESPUÉS de mandar (patrón 0202): si Vercel mata la lambda entre
    // el WhatsApp y el sello, la corrida siguiente REENVÍA «la póliza de
    // ECO-114 vence en 7 días» a la misma flota, cada hora. Lo que no alcanza
    // turno no se manda ni se sella, y se dice.
    if (opts.venceEn !== undefined && Date.now() >= opts.venceEn) {
      r.cortadosPorReloj = flotas.slice(n).reduce((s, [, i]) => s + i.length, 0);
      logger.warn('vencimientos.cortado_por_reloj', { flotasPendientes: flotas.length - n, vencimientos: r.cortadosPorReloj });
      break;
    }
    try {
      const tel = await telefonoJefeDe(tenantId);
      if (!tel) {
        logger.warn('vencimientos.sin_destinatario', { tenant: tenantId, items: items.length });
        r.fallos++;
        continue;
      }
      const lineas = items.map((i) =>
        i.dias <= 0
          ? `· ${i.rotulo}: VENCIÓ el ${i.vence}. La unidad/el operador no debería estar en carretera con esto vencido.`
          : `· ${i.rotulo}: vence el ${i.vence} (en ${i.dias} día${i.dias === 1 ? '' : 's'}).`);
      const texto =
        `📋 Papeles de la flota por vencer:\n${lineas.join('\n')}\n` +
        `Renovar toma días hábiles (cita, taller, pago) — por eso el aviso sale con tiempo. Los detalles están en Unidades y Operadores del panel.`;
      const enviado = await sendText(tel, texto);
      if (!enviado) {
        r.fallos++;
        logger.warn('vencimientos.no_enviado', { tenant: tenantId });
        continue; // sin sello: se reintenta a la siguiente corrida
      }
      // El sello, después de mandar. `ON CONFLICT DO NOTHING` (upsert con
      // ignoreDuplicates) hace inofensiva la carrera de dos crons solapados.
      const { error: errIns } = await acotada(admin.from('aviso_vigencia').upsert(
        items.map((i) => ({
          tenant_id: i.tenantId, objeto: i.objeto, objeto_id: i.objetoId,
          documento: i.documento, umbral: i.umbral, vence: i.vence,
        })),
        { onConflict: 'tenant_id,objeto,objeto_id,documento,umbral,vence', ignoreDuplicates: true },
      ), 'vencimientos.sellar');
      if (errIns) {
        // El aviso YA salió; el sello fallido significa un posible duplicado
        // mañana — se dice, no se esconde.
        logger.error('vencimientos.sello_fallo', { tenant: tenantId, err: errIns.message });
      }
      r.avisados += items.length;
    } catch (e) {
      r.fallos++;
      logger.error('vencimientos.tenant_fallo', { tenant: tenantId, err: e instanceof Error ? e.message : String(e) });
    }
  }
  return r;
}
