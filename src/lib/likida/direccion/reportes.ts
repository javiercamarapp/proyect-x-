// ═══════════════════════════════════════════════════════════════════════════
// LA DIRECCIÓN (0216) — los cuatro agentes que le cuentan el negocio a Javier:
//
//   · kpi_whatsapp        — el diario corto (y el lunes largo) en su correo.
//   · desempeno_startup   — el diagnóstico contra el plan (artefacto citable).
//   · orquestador_semanal — las 6 secciones del ciclo (artefacto citable).
//   · orquestador         — el parte operativo del 80/20 (correo del lunes).
//
// LAS REGLAS QUE GOBIERNAN TODO EL ARCHIVO:
//
//  1. LAS REGLAS CALCULAN — Y AQUÍ TAMBIÉN REDACTAN. El motor v1 es
//     determinista de punta a punta: cada cifra sale de una lectura real y
//     el texto es plantilla fija. Cero modelo (modelo_rol NULL, 0216) — el
//     guardia `cifrasRespaldadas` protege a los agentes que redactan con
//     LLM; el modo más barato de no inventar una cifra es no tener quién la
//     invente.
//  2. UNA FUENTE ILEGIBLE SE DICE, JAMÁS SE COLAPSA A CERO. Cada lectura va
//     por valor (`Fuente<T>`) y el reporte escribe "no se pudo leer: X" —
//     la campana que miente (calcular-alertas) es exactamente lo que este
//     canal no puede repetir. Si NINGUNA fuente contesta, el reporte de una
//     línea ("no pude leer nada") ES la noticia y sale igual.
//  3. EL SELLO SE ESCRIBE DESPUÉS DE ENVIAR (lección c2-1, patrón 0202):
//     `reporte_direccion` unique (agente, periodo). Fallo de canal = sin
//     sello = se reintenta en la siguiente pasada del runner; el correo que
//     al fin sale dice "ayer no salió el reporte".
//  4. CANAL INTERINO DECLARADO: ALERTA_EMAIL (el correo del operador). El
//     WhatsApp de Javier espera el número verificado de Meta — bloqueado
//     fuera del código, y el propio reporte lo dice en el pie.
//  5. ESTOS AGENTES NO EJECUTAN NADA. Ni apagan palancas, ni corren agentes,
//     ni escriben a clientes. Miden, comparan y ponen decisiones enfrente.
// ═══════════════════════════════════════════════════════════════════════════
import { supabaseAdmin } from '@/lib/supabase/admin';
import { acotada } from '../presupuesto';
import { logger } from '@/lib/logger';
import { hoyMx, fechaHoraSat, fechaHoraMx, inicioDiaMx, usd } from '@/lib/formato';
import { registrarCorrida, type DisparoCorrida } from '../agentes/corridas';
import { listarInterruptores, type EstadoInterruptor } from '../interruptores';
import {
  getResumenNegocio, getConteosPlataforma, contarLiquidacionesEnRevisar,
  type ResumenNegocio, type ConteosPlataforma,
} from '@/lib/admin/negocio';
import { getBandejaEscalaciones, NOMBRE_FUENTE, type BandejaEscalaciones } from '@/lib/admin/escalaciones';
import { estadoLatidos, type CronId, type SaludCron } from '@/lib/admin/salud';
import { enviarCorreo } from '@/lib/correo/enviar';
import {
  ESTADOS_PROSPECTO,
  ESTADOS_PROSPECTO_PERSISTIDOS,
  normalizarConteosProspecto,
} from '@/lib/likida/vendedores';

export const AGENTES_DIRECCION = ['kpi_whatsapp', 'desempeno_startup', 'orquestador', 'orquestador_semanal'] as const;
export type AgenteDireccion = (typeof AGENTES_DIRECCION)[number];

/** Hora de México (0-23) a partir de la cual sale el reporte del día. El
 *  runner pasa cada 4 h: la primera pasada ≥ 8:00 lo manda — "8:00" es la
 *  aspiración del blueprint, no una promesa de minuto exacto. */
export const HORA_REPORTE_MX = 8;

// ── El reloj de México, sin deletrear la zona (el guardia de formato) ──────

export interface PartesMx { dia: string; hora: number; esLunes: boolean }

/** Día, hora y día-de-la-semana DE MÉXICO del instante dado. El día de la
 *  semana se calcula del día-calendario anclado a mediodía UTC: el propio
 *  cálculo no puede cruzar de fecha. */
export function partesMx(ahora: Date): PartesMx {
  const dia = hoyMx(ahora);
  const sello = fechaHoraSat(ahora.toISOString());
  const hora = sello ? Number(sello.slice(11, 13)) : NaN;
  const esLunes = new Date(`${dia}T12:00:00Z`).getUTCDay() === 1;
  return { dia, hora, esLunes };
}

/** El lunes (día de México) de la semana a la que pertenece `dia`. */
export function lunesDe(dia: string): string {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** El día anterior a `dia` (calendario de México). */
export function diaAnterior(dia: string): string {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── Lecturas por valor: una fuente ilegible se dice, no se rellena ─────────

export interface Fuente<T> { valor: T | null; error: string | null }

async function porValor<T>(nombre: string, fn: () => Promise<T>): Promise<Fuente<T>> {
  try {
    return { valor: await fn(), error: null };
  } catch (e) {
    const msj = e instanceof Error ? e.message : String(e);
    logger.warn('direccion.fuente_ciega', { fuente: nombre, err: msj.slice(0, 200) });
    return { valor: null, error: nombre };
  }
}

/** Conteo `head` exacto con la regla de conteos de negocio.ts: un `count`
 *  que no llegó como número NO es 0 — es "no se pudo contar", y se lanza. */
async function contarExacto(tabla: string, etiqueta: string, filtro: (b: unknown) => unknown): Promise<number> {
  const base = supabaseAdmin().from(tabla).select('id', { count: 'exact', head: true });
  const { count, error } = await acotada(
    filtro(base) as PromiseLike<{ count: number | null; error: { message: string } | null }>, etiqueta,
  );
  if (error) throw new Error(`${etiqueta}: ${error.message}`);
  if (typeof count !== 'number') throw new Error(`${etiqueta}: PostgREST no devolvió el conteo — no se afirma un 0 que nadie midió.`);
  return count;
}

const ESTADOS_FACTURA_SAAS = ['pendiente', 'pagada', 'fallida', 'cancelada'] as const;
/** Los cuatro estados "vivos" de `suscripcion` (0052) — cancelada no cuenta. */
const ESTADOS_SUSCRIPCION_VIVA = ['prueba', 'activa', 'morosa', 'pausada'];

async function contarSuscripcionesVivas(): Promise<number> {
  return contarExacto('suscripcion', 'direccion.suscripciones', (b) =>
    (b as { in: (c: string, v: string[]) => unknown }).in('estado', ESTADOS_SUSCRIPCION_VIVA));
}

async function contarPorEstado(tabla: string, estados: readonly string[], etiqueta: string): Promise<Record<string, number>> {
  const pares = await Promise.all(estados.map(async (e) => [
    e,
    await contarExacto(tabla, `${etiqueta}/${e}`, (b) => (b as { eq: (c: string, v: string) => unknown }).eq('estado', e)),
  ] as const));
  return Object.fromEntries(pares);
}

/** Lee los 14 valores aceptados por el CHECK y devuelve los 11 significados
 * canónicos. Exportada para fijar con prueba el contrato del reporte. */
export async function contarProspectosPorEstado(): Promise<Record<string, number>> {
  const crudos = await contarPorEstado('prospecto', ESTADOS_PROSPECTO_PERSISTIDOS, 'direccion.prospectos');
  return normalizarConteosProspecto(
    Object.entries(crudos).map(([estado, n]) => ({ estado, n })),
  );
}

// ── El estado reciente de TODOS los agentes con corrida ────────────────────

export interface CorridaMin {
  estado: 'ok' | 'parcial' | 'fallo';
  inicio: string;
  tareasHechas: number | null;
  tareasTotal: number | null;
  resumen: Record<string, unknown> | null;
}

/** Las últimas corridas agrupadas por agente (hasta 3 por agente, la más
 *  reciente primero). Lanza si la bitácora no se puede leer: un feed vacío
 *  sobre base caída afirmaría "nadie ha corrido". */
async function ultimasCorridasPorAgente(): Promise<Map<string, CorridaMin[]>> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('agente_corrida')
    .select('agente, estado, inicio, tareas_hechas, tareas_total, resumen')
    .order('inicio', { ascending: false })
    .limit(400), 'direccion.corridas');
  if (error) throw new Error(`direccion.corridas: ${error.message}`);
  const porAgente = new Map<string, CorridaMin[]>();
  for (const f of (data ?? []) as Array<Record<string, unknown>>) {
    const agente = String(f.agente);
    const lista = porAgente.get(agente) ?? [];
    if (lista.length < 3) {
      lista.push({
        estado: f.estado as CorridaMin['estado'],
        inicio: String(f.inicio),
        tareasHechas: f.tareas_hechas === null ? null : Number(f.tareas_hechas),
        tareasTotal: f.tareas_total === null ? null : Number(f.tareas_total),
        resumen: (f.resumen as Record<string, unknown> | null) ?? null,
      });
      porAgente.set(agente, lista);
    }
  }
  return porAgente;
}

async function agentesDelRunner(): Promise<Array<{ id: string }>> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('agente_definicion')
    .select('id')
    .eq('estado', 'vivo')
    .eq('runner_habilitado', true)
    .eq('disparador', 'cron')
    .order('id'), 'direccion.agentes_runner');
  if (error) throw new Error(`direccion.agentes_runner: ${error.message}`);
  return (data ?? []) as Array<{ id: string }>;
}

// ── El sello y el artefacto (reporte_direccion, 0216) ──────────────────────

interface ReporteGuardado { cuerpo: string; resumen: Record<string, unknown> | null; enviadoEn: string | null }

async function leerReporte(agente: AgenteDireccion, periodo: string): Promise<ReporteGuardado | null> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('reporte_direccion')
    .select('cuerpo, resumen, enviado_en')
    .eq('agente', agente)
    .eq('periodo', periodo)
    .limit(1), 'direccion.leer_reporte');
  if (error) throw new Error(`direccion.leer_reporte: ${error.message}`);
  const fila = ((data ?? []) as Array<Record<string, unknown>>)[0];
  if (!fila) return null;
  return {
    cuerpo: String(fila.cuerpo),
    resumen: (fila.resumen as Record<string, unknown> | null) ?? null,
    enviadoEn: (fila.enviado_en as string | null) ?? null,
  };
}

/** Inserta el reporte. `'ya_existia'` = otra corrida ganó el unique — el
 *  perdedor NO duplica nada (patrón 0202). */
async function guardarReporte(
  agente: AgenteDireccion, periodo: string, cuerpo: string,
  resumen: Record<string, unknown> | null, ciegas: string[], enviadoEn: string | null,
): Promise<'guardado' | 'ya_existia'> {
  const { error } = await acotada(supabaseAdmin()
    .from('reporte_direccion')
    .insert({ agente, periodo, cuerpo, resumen, fuentes_ciegas: ciegas, enviado_en: enviadoEn }), 'direccion.guardar_reporte');
  if (!error) return 'guardado';
  if (error.code === '23505' || /reporte_direccion_agente_periodo|duplicate key/.test(error.message)) return 'ya_existia';
  throw new Error(`direccion.guardar_reporte: ${error.message}`);
}

/** El artefacto de un productor (diagnóstico, secciones): se recoge si ya
 *  existe; si no, se arma, SE PERSISTE y se devuelve — así el consumidor y el
 *  productor de la misma semana citan EXACTAMENTE el mismo texto, corra quien
 *  corra primero en la pasada del runner. */
async function obtenerOArmarArtefacto(
  agente: AgenteDireccion, periodo: string,
  armar: () => Promise<{ cuerpo: string; resumen: Record<string, unknown> | null; ciegas: string[] }>,
): Promise<{ cuerpo: string; origen: 'previa' | 'esta_corrida' }> {
  const previo = await leerReporte(agente, periodo);
  if (previo) return { cuerpo: previo.cuerpo, origen: 'previa' };
  const nuevo = await armar();
  const r = await guardarReporte(agente, periodo, nuevo.cuerpo, nuevo.resumen, nuevo.ciegas, null);
  if (r === 'ya_existia') {
    const canonico = await leerReporte(agente, periodo);
    if (canonico) return { cuerpo: canonico.cuerpo, origen: 'previa' };
  }
  return { cuerpo: nuevo.cuerpo, origen: 'esta_corrida' };
}

// ═══════════════════════════════════════════════════════════════════════════
// LOS CONSTRUCTORES PUROS — datos adentro, texto afuera. Sin I/O, sin reloj.
// ═══════════════════════════════════════════════════════════════════════════

export interface DatosKpi {
  dia: string;
  interruptores: Fuente<EstadoInterruptor[]>;
  resumen: Fuente<Pick<ResumenNegocio, 'tenants' | 'costoIaUsd' | 'tendenciaCosto'>>;
  conteos: Fuente<Pick<ConteosPlataforma, 'liquidaciones'>>;
  revisar: Fuente<number>;
  bandeja: Fuente<BandejaEscalaciones>;
  suscripcionesVivas: Fuente<number>;
  /** ¿Salió el reporte del día hábil anterior? `null` = no se pudo saber. */
  ayerSalio: boolean | null;
}

/** La métrica norte con sus TRES ramas honestas (blueprint §3): medida /
 *  "aún no hay" / "no se pudo medir". Siempre absolutos, nunca el % solo. */
export function lineaNorte(conteos: DatosKpi['conteos'], revisar: Fuente<number>): string {
  if (conteos.error || revisar.error || !conteos.valor || revisar.valor === null) {
    return '⭐ Sin humano: no se pudo medir (fuente ilegible)';
  }
  const total = conteos.valor.liquidaciones;
  if (total === 0) return '⭐ Sin humano: aún no hay liquidaciones';
  const sinHumano = total - revisar.valor;
  const chica = total < 20 ? '; la base todavía es chica' : '';
  return `⭐ Sin humano: ${sinHumano} de ${total} liquidaciones (estatus de ahora, no historial${chica})`;
}

function lineaPalancas(interruptores: Fuente<EstadoInterruptor[]>): { linea: string | null; apagadas: EstadoInterruptor[] } {
  if (interruptores.error || !interruptores.valor) {
    return { linea: '⚠ No se pudo leer el estado de los interruptores — puede haber una palanca abajo sin que este reporte lo vea', apagadas: [] };
  }
  const apagadas = interruptores.valor.filter((i) => i.apagado);
  if (apagadas.length === 0) return { linea: null, apagadas };
  const primera = apagadas[0];
  const desde = primera.cambiadoEn ? ` desde ${fechaHoraMx(primera.cambiadoEn)}` : '';
  const motivo = primera.motivo ? ` — «${primera.motivo}»` : '';
  const extra = apagadas.length > 1 ? ` (y ${apagadas.length - 1} palanca(s) más abajo)` : '';
  return { linea: `⚠ ${primera.id} APAGADO${desde}${motivo}${extra}`, apagadas };
}

function lineaPendientes(bandeja: Fuente<BandejaEscalaciones>): { linea: string; ciegas: string[]; pendientes: number | null } {
  if (bandeja.error || !bandeja.valor) {
    return { linea: '📥 Pendientes: no se pudo leer la bandeja — pendientes invisibles', ciegas: ['bandeja completa'], pendientes: null };
  }
  const c = bandeja.valor.conteos;
  const partes: string[] = [];
  const ciegas: string[] = [];
  let pendientes = 0;
  const pinta = (n: number | null, rotulo: string, fuente: string) => {
    if (n === null) { ciegas.push(fuente); return; }
    pendientes += n;
    if (n > 0) partes.push(`${n} ${rotulo}`);
  };
  pinta(c.arco, 'ARCO', NOMBRE_FUENTE.arco);
  pinta(c.corridasFallo, 'corridas en fallo', NOMBRE_FUENTE.corridas);
  pinta(c.talachas, 'talachas', NOMBRE_FUENTE.talachas);
  pinta(c.facturasProveedor, 'facturas de proveedor', NOMBRE_FUENTE.facturas_proveedor);
  if (c.ticketsAbiertos === null) ciegas.push(NOMBRE_FUENTE.tickets);
  else {
    pendientes += c.ticketsAbiertos;
    if (c.ticketsAbiertos > 0) {
      partes.push(`${c.ticketsAbiertos} tickets${c.ticketsVencidos ? ` (${c.ticketsVencidos} con SLA vencido)` : ''}`);
    }
  }
  pinta(c.liquidacionesRevisar, 'liquidaciones por revisar', NOMBRE_FUENTE.liquidaciones);
  const cuerpo = partes.length > 0 ? partes.join(' · ') : 'nada en la bandeja';
  const coda = ciegas.length > 0 ? ` — no se pudo leer: ${ciegas.join(', ')}` : '';
  return { linea: `📥 Pendientes: ${cuerpo}${coda}`, ciegas, pendientes: ciegas.length > 0 ? null : pendientes };
}

function lineaIa(resumen: DatosKpi['resumen']): string {
  if (resumen.error || !resumen.valor) return '💸 IA: no se pudo leer el costo';
  const t = resumen.valor.tendenciaCosto;
  const tend = t === null
    ? 'sin tendencia (historia corta)'
    : `${t > 0 ? '+' : ''}${t.toFixed(0)}% 7d vs 7d${t > 0 ? ' — subir es malo' : ''}`;
  return `💸 IA: ${usd(resumen.valor.costoIaUsd)} histórico · ${tend}`;
}

function lineaFlotas(resumen: DatosKpi['resumen'], vivas: Fuente<number>): string {
  const flotas = resumen.error || !resumen.valor
    ? 'no se pudo leer cuántas flotas hay'
    : `${resumen.valor.tenants} flota(s)`;
  // MRR $0 FIJO Y REAL (consola.tsx): Likida no le cobra a nadie todavía. El
  // renglón cambia de fuente el día que `suscripcion` tenga filas vivas — y
  // si ya las hay, este mismo renglón lo grita en vez de seguir mintiendo.
  const mrr = vivas.valor !== null && vivas.valor > 0
    ? `⚠ hay ${vivas.valor} suscripción(es) viva(s): el renglón fijo de MRR $0 dejó de ser verdad — hay que cambiar su fuente`
    : 'MRR $0 — sigue sin clientes de pago';
  return `🏢 ${flotas} · ${mrr}`;
}

/** Las decisiones que el reporte pone enfrente (máximo 5 — una lista de 12
 *  decisiones es una lista de cero decisiones). */
export function derivarDecisiones(d: Pick<DatosKpi, 'interruptores' | 'bandeja'>): string[] {
  const decide: string[] = [];
  const { apagadas } = lineaPalancas(d.interruptores);
  for (const p of apagadas) {
    decide.push(`Reencender ${p.id} o confirmar que sigue apagado a propósito${p.motivo ? ` («${p.motivo}»)` : ''}.`);
  }
  const cola = d.bandeja.valor?.cola ?? [];
  for (const item of cola) {
    if (item.vence !== null) {
      decide.push(`${NOMBRE_FUENTE[item.fuente]}: «${item.titulo}» tiene plazo (${item.vence.slice(0, 10)}).`);
    }
  }
  const fallos = d.bandeja.valor?.conteos.corridasFallo;
  if (typeof fallos === 'number' && fallos > 0) {
    decide.push(`Revisar las ${fallos} corrida(s) de agentes en fallo — /admin/escalaciones.`);
  }
  return decide.slice(0, 5);
}

/** El diario corto (blueprint §5a): máximo 8 líneas, la primera es la peor
 *  noticia, y el día limpio se dice en tres líneas. */
export function armarKpiDiario(d: DatosKpi): string {
  const palancas = lineaPalancas(d.interruptores);
  const pendientes = lineaPendientes(d.bandeja);
  const norte = lineaNorte(d.conteos, d.revisar);
  const todasCiegas = d.interruptores.error && d.resumen.error && d.conteos.error && d.bandeja.error;
  if (todasCiegas) {
    // El silencio ES la noticia (blueprint §7).
    return `Likida · ${d.dia}\n\nNo pude leer nada del sistema hoy — revisa /admin/salud-sistema.`;
  }
  const limpio = palancas.linea === null && pendientes.pendientes === 0 && pendientes.ciegas.length === 0;
  if (limpio) {
    return `Likida · ${d.dia}\n\nTodo verde. ${norte}. Nada pendiente. Nada que decidas.`;
  }
  const lineas: string[] = [`Likida · ${d.dia}`, ''];
  lineas.push(palancas.linea ?? 'Sin mala noticia hoy.');
  lineas.push(norte);
  lineas.push(pendientes.linea);
  lineas.push(lineaIa(d.resumen));
  lineas.push(lineaFlotas(d.resumen, d.suscripcionesVivas));
  if (d.ayerSalio === false) lineas.push('Ayer no salió el reporte diario — este es el primero desde entonces.');
  const decide = derivarDecisiones(d);
  lineas.push('');
  lineas.push(decide.length === 0 ? 'Nada que decidas hoy.' : `Decide hoy: ${decide[0]}`);
  return lineas.join('\n');
}

// ── El diagnóstico del desempeño (blueprint desempeno-de-la-startup) ───────

export interface DatosDiagnostico {
  dia: string;
  suscripcionesVivas: Fuente<number>;
  conteos: Fuente<Pick<ConteosPlataforma, 'liquidaciones'>>;
  revisar: Fuente<number>;
}

export function armarDiagnostico(d: DatosDiagnostico): string {
  const noMedido: string[] = [];
  if (d.suscripcionesVivas.error) noMedido.push('suscripciones vivas');
  if (d.conteos.error || d.revisar.error) noMedido.push('métrica norte');
  const lineas: string[] = [];
  const vivas = d.suscripcionesVivas.valor;
  if (vivas === null || vivas === 0) {
    // El mes 1 es el mes en que se firma el primer cliente. Sin él, ESTE es
    // el diagnóstico completo — no se fuerza análisis sobre un negocio que
    // no arrancó (blueprint §4 paso 1).
    lineas.push('[DIAGNÓSTICO · mes 0 del plan]');
    lineas.push('Seguimos en el mes 0: el reloj de la corrida no ha empezado (0 suscripciones vivas; el MRR real es $0, fijo).');
    lineas.push('Bloqueantes que impiden el mes 1 — se nombran cada semana hasta que cierren:');
    lineas.push('1) WhatsApp: el número operativo sigue siendo el de prueba de Meta (verificación de negocio pendiente).');
    lineas.push('2) Emisión fiscal apagada: el timbrado se enciende al primer cliente.');
  } else {
    lineas.push('[DIAGNÓSTICO]');
    lineas.push(`Hay ${vivas} suscripción(es) viva(s). El comparador contra las palancas del plan (P1…P11) aún no está cableado: este diagnóstico se queda en absolutos a propósito — no se inventa un "vas X% abajo" sin la vara puesta.`);
    lineas.push(lineaNorte(d.conteos, d.revisar) + ' — entra como señal de riesgo de churn, no como métrica de negocio.');
  }
  lineas.push(`Lo que no pude medir: ${noMedido.length > 0 ? noMedido.join(', ') : 'nada'}.`);
  return lineas.join('\n');
}

// ── Las 6 secciones del ciclo (prompt orquestador-semanal) ─────────────────

export interface DatosCiclo {
  lunes: string;
  prospectos: Fuente<Record<string, number>>;
  /** Los conteos que la semana PASADA dejó en su resumen — para el delta.
   *  `null` = no hay semana anterior (y el delta no se inventa). */
  prospectosPrev: Record<string, number> | null;
  facturasSaas: Fuente<Record<string, number>>;
  piezasSemana: Fuente<number>;
  pendientesCola: Fuente<number>;
  conteos: Fuente<Pick<ConteosPlataforma, 'liquidaciones'>>;
  revisar: Fuente<number>;
}

const SIN_DATO = (que: string) => `sin dato esta semana: ${que}`;

export function armarSeccionesCiclo(d: DatosCiclo): string {
  const s: string[] = [`Semana del ${d.lunes}.`, ''];

  if (d.prospectos.error || !d.prospectos.valor) {
    s.push(`1. VENTAS — ${SIN_DATO('no se pudo leer el kanban de prospectos')}`);
  } else {
    const p = normalizarConteosProspecto(
      Object.entries(d.prospectos.valor).map(([estado, n]) => ({ estado, n })),
    );
    const previos = d.prospectosPrev === null ? null : normalizarConteosProspecto(
      Object.entries(d.prospectosPrev).map(([estado, n]) => ({ estado, n })),
    );
    const renglon = ESTADOS_PROSPECTO.map(({ valor: e }) => {
      const n = p[e];
      const prev = previos?.[e];
      const delta = typeof prev === 'number' && n !== prev ? ` (${n > prev ? '+' : ''}${n - prev})` : '';
      return `${e} ${n}${delta}`;
    }).join(' · ');
    const notaDelta = d.prospectosPrev ? '' : ' — sin resumen de la semana pasada: los deltas empiezan la próxima';
    s.push(`1. VENTAS — ${renglon}${notaDelta}`);
  }

  s.push(`2. ATENCIÓN — ${SIN_DATO('la instrumentación de consultas atendidas/resueltas (patrón Fin) no existe todavía')}`);

  if (d.facturasSaas.error || !d.facturasSaas.valor) {
    s.push(`3. COBRANZA SAAS — ${SIN_DATO('no se pudo leer factura_saas')}`);
  } else {
    const f = d.facturasSaas.valor;
    const total = ESTADOS_FACTURA_SAAS.reduce((acc, e) => acc + (f[e] ?? 0), 0);
    s.push(total === 0
      ? '3. COBRANZA SAAS — 0 facturas emitidas (sin clientes de pago todavía)'
      : `3. COBRANZA SAAS — ${ESTADOS_FACTURA_SAAS.map((e) => `${e} ${f[e] ?? 0}`).join(' · ')} (conteos; el desglose de montos aún no se lee)`);
  }

  s.push(`4. ONBOARDING — ${SIN_DATO('el checklist de onboarding por flota aún no lo lee este agente')}`);
  s.push(`5. RETENCIÓN — ${SIN_DATO('la señal de silencio por flota (5d/10d) aún no está instrumentada')}`);
  s.push(`6. PRODUCTO — ${lineaNorte(d.conteos, d.revisar)}`);
  s.push('');

  if (d.piezasSemana.error || d.piezasSemana.valor === null) {
    s.push(`% automatizado del ciclo: ${SIN_DATO('no se pudo leer la cola de aprobación')}`);
  } else {
    const piezas = d.piezasSemana.valor;
    const pend = d.pendientesCola.valor;
    // Base chica: absolutos y se dice — un porcentaje sobre 3 piezas no
    // significa nada (regla del prompt del orquestador semanal).
    s.push(`% automatizado del ciclo: ${piezas} pieza(s) fabricadas por agentes esta semana${pend !== null ? ` (${pend} esperando aprobación)` : ''} — base chica: solo absolutos, el porcentaje aún no significa nada.`);
  }
  return s.join('\n');
}

// ── El lunes largo del KPI (blueprint §5b): diagnóstico + secciones ────────

export function armarKpiLunes(dia: string, diagnostico: string, secciones: string, decide: string[]): string {
  const bloqueDecide = decide.length === 0
    ? '[ESTA SEMANA DECIDES] Nada pendiente de decisión.'
    : `[ESTA SEMANA DECIDES]\n${decide.map((x, i) => `${i + 1}. ${x}`).join('\n')}`;
  return `Likida · semana del ${lunesDe(dia)}\n\n${diagnostico}\n\n${secciones}\n\n${bloqueDecide}`;
}

// ── El parte operativo del orquestador (blueprint agente-orquestador) ──────

export interface DatosOperativo {
  lunes: string;
  latidos: Fuente<Record<CronId, SaludCron>>;
  interruptores: Fuente<EstadoInterruptor[]>;
  agentesRunner: Fuente<Array<{ id: string }>>;
  corridas: Fuente<Map<string, CorridaMin[]>>;
  bandeja: Fuente<BandejaEscalaciones>;
  /** Las 6 secciones del ciclo — el artefacto del orquestador semanal entra
   *  COMPLETO como sección 5 (el orquestador no lo reescribe). */
  ciclo: string;
}

/** Los cuatro detectores de la sección 2 — la razón de ser del orquestador
 *  (la lección de las ~216 corridas verdes con el motor roto). */
export function detectarAnomalias(
  agentes: Array<{ id: string }>, corridas: Map<string, CorridaMin[]>, ahoraMs: number,
): string[] {
  const anomalias: string[] = [];
  const SIETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;
  for (const a of agentes) {
    const lista = corridas.get(a.id) ?? [];
    const ultima = lista[0];
    if (!ultima) {
      anomalias.push(`${a.id}: NO HA CORRIDO nunca (habilitado en el runner, sin corrida en la bitácora).`);
      continue;
    }
    if (ahoraMs - new Date(ultima.inicio).getTime() > SIETE_DIAS_MS) {
      anomalias.push(`${a.id}: NO CORRIÓ en los últimos 7 días (última: ${ultima.inicio.slice(0, 10)}).`);
    }
    if (ultima.estado === 'fallo') {
      anomalias.push(`${a.id}: la última corrida FALLÓ (${ultima.inicio.slice(0, 10)}).`);
    }
    if (ultima.estado === 'ok' && ultima.tareasHechas === 0 && (ultima.tareasTotal ?? 0) > 0) {
      anomalias.push(`${a.id}: VERDE VACÍO — corrió, dijo ok, y no hizo nada (0 de ${ultima.tareasTotal}).`);
    }
    if (lista.length >= 3 && lista.every((c) => c.estado === 'parcial')) {
      anomalias.push(`${a.id}: PARCIAL CRÓNICO — tres corridas seguidas a medias.`);
    }
  }
  return anomalias;
}

export function armarParteOperativo(d: DatosOperativo, ahoraMs: number): string {
  const s: string[] = [`Parte operativo · semana del ${d.lunes}`, ''];

  // 1 · ¿El producto está vivo?
  if (d.latidos.error || !d.latidos.valor) {
    s.push('1. PRODUCTO VIVO — no se pudo leer el latido de los crons: las secciones 1 y 2 quedan CIEGAS, y eso va primero.');
  } else {
    const malos = Object.entries(d.latidos.valor)
      .filter(([, v]) => v.estado !== 'ok' || (v.ultimoEstado !== null && v.ultimoEstado !== 'ok'))
      .map(([cron, v]) => `${cron}: ${v.estado === 'ok' ? `último estado ${v.ultimoEstado}` : v.estado}`);
    s.push(malos.length === 0 ? '1. PRODUCTO VIVO — los crons laten y su último estado es ok.' : `1. PRODUCTO VIVO — ${malos.join(' · ')}`);
  }
  const palancas = lineaPalancas(d.interruptores);
  if (palancas.linea) s.push(`   ${palancas.linea}`);

  // 2 · Los cuatro detectores.
  if (d.corridas.error || !d.corridas.valor || d.agentesRunner.error || !d.agentesRunner.valor) {
    s.push('2. AGENTES — no se pudo leer la bitácora de corridas: "no corrió" y "verde vacío" quedan sin medir, y se dice.');
  } else {
    const anomalias = detectarAnomalias(d.agentesRunner.valor, d.corridas.valor, ahoraMs);
    s.push(anomalias.length === 0
      ? `2. AGENTES — ${d.agentesRunner.valor.length} habilitados en el runner, sin anomalías (corrieron, produjeron, sin fallos).`
      : `2. AGENTES —\n${anomalias.map((a) => `   · ${a}`).join('\n')}`);
  }

  // 3 · La cola humana.
  const pendientes = lineaPendientes(d.bandeja);
  s.push(`3. COLA HUMANA — ${pendientes.linea.replace('📥 Pendientes: ', '')}`);

  // 4 · ¿El dinero aguanta? — tal cual de los financieros; no se recalcula.
  const fin = ['tesoreria', 'control_costos', 'analista_metricas', 'cierre_mensual']
    .map((id) => {
      const ultima = d.corridas.valor?.get(id)?.[0];
      return ultima ? `${id}: corrió el ${ultima.inicio.slice(0, 10)} (${ultima.estado})` : `${id}: no ha corrido`;
    });
  s.push(`4. DINERO — ${fin.join(' · ')} — este parte no recalcula sus cifras: se leen en sus corridas.`);

  // 5 · El ciclo comercial, completo y sin cambios.
  s.push('5. CICLO COMERCIAL —');
  s.push(d.ciclo.split('\n').map((l) => `   ${l}`).join('\n'));

  // 6 y 7 · Calidad y documentación: sus agentes aún no corren, y se dice.
  s.push('6. CALIDAD — sin dato esta semana: el vigilante de calidad aún no corre.');
  s.push('7. DOCUMENTACIÓN — sin dato esta semana: el agente de documentación aún no corre.');

  // 8 · Lo único que hay que leer si solo se lee una sección.
  const decide = derivarDecisiones({ interruptores: d.interruptores, bandeja: d.bandeja });
  s.push('');
  s.push(decide.length === 0
    ? '[ESTA SEMANA DECIDES] Nada pendiente de decisión.'
    : `[ESTA SEMANA DECIDES]\n${decide.map((x, i) => `${i + 1}. ${x}`).join('\n')}`);
  return s.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// LAS LECTURAS — cada una por valor; el conjunto jamás lanza.
// ═══════════════════════════════════════════════════════════════════════════

async function leerDatosKpi(dia: string, esLunes: boolean): Promise<{ datos: DatosKpi; ciegas: string[] }> {
  const [interruptores, resumen, conteos, revisar, bandeja, vivas] = await Promise.all([
    porValor('interruptores', () => listarInterruptores()),
    porValor('resumen del negocio', () => getResumenNegocio()),
    porValor('conteos de plataforma', () => getConteosPlataforma()),
    porValor('liquidaciones en revisión', () => contarLiquidacionesEnRevisar()),
    porValor('bandeja de escalaciones', () => getBandejaEscalaciones(Date.now())),
    porValor('suscripciones vivas', () => contarSuscripcionesVivas()),
  ]);
  // ¿Salió el reporte de ayer? El lunes mira el de la semana pasada no — el
  // corto de ayer basta: el domingo también tiene diario.
  const ayer = diaAnterior(dia);
  const ayerFuePeriodoLunes = esLunes ? false : lunesDe(ayer) === ayer;
  const ayerSalio = await porValor('reporte de ayer', async () => {
    const r = await leerReporte('kpi_whatsapp', ayerFuePeriodoLunes ? `lun-${ayer}` : `dia-${ayer}`);
    // Con la reserva-antes-de-enviar (c5-15), "existe la fila" ya no implica
    // "salió": solo la FECHA de envío cuenta — un ayer ambiguo se reporta
    // como no-salido, que es exactamente decirlo en el siguiente reporte.
    return r?.enviadoEn != null;
  });
  const datos: DatosKpi = {
    dia, interruptores, resumen, conteos, revisar, bandeja,
    suscripcionesVivas: vivas,
    ayerSalio: ayerSalio.valor,
  };
  const ciegas = [interruptores, resumen, conteos, revisar, bandeja, vivas]
    .filter((f) => f.error !== null).map((f) => f.error as string);
  return { datos, ciegas };
}

async function leerDatosDiagnostico(dia: string): Promise<{ datos: DatosDiagnostico; ciegas: string[] }> {
  const [vivas, conteos, revisar] = await Promise.all([
    porValor('suscripciones vivas', () => contarSuscripcionesVivas()),
    porValor('conteos de plataforma', () => getConteosPlataforma()),
    porValor('liquidaciones en revisión', () => contarLiquidacionesEnRevisar()),
  ]);
  return {
    datos: { dia, suscripcionesVivas: vivas, conteos, revisar },
    ciegas: [vivas, conteos, revisar].filter((f) => f.error !== null).map((f) => f.error as string),
  };
}

async function leerDatosCiclo(lunes: string): Promise<{ datos: DatosCiclo; ciegas: string[] }> {
  const inicioSemana = inicioDiaMx(lunes);
  const [prospectos, facturas, piezas, pendientes, conteos, revisar, prev] = await Promise.all([
    porValor('prospectos por estado', () => contarProspectosPorEstado()),
    porValor('facturas SaaS por estado', () => contarPorEstado('factura_saas', ESTADOS_FACTURA_SAAS, 'direccion.factura_saas')),
    // c5-9: la columna de cola_aprobacion es `creado_en` (0117) — con
    // `created_at` PostgREST devolvía 42703 y esta fuente nacía MUERTA: el
    // reporte semanal decía «sin dato» todas las semanas. Hay una prueba
    // estructural que veta `created_at` en este archivo.
    porValor('piezas fabricadas esta semana', () => contarExacto('cola_aprobacion', 'direccion.piezas_semana', (b) =>
      (b as { gte: (c: string, v: string) => unknown }).gte('creado_en', inicioSemana))),
    porValor('piezas pendientes de aprobación', () => contarExacto('cola_aprobacion', 'direccion.pendientes', (b) =>
      (b as { eq: (c: string, v: string) => unknown }).eq('estado', 'pendiente'))),
    porValor('conteos de plataforma', () => getConteosPlataforma()),
    porValor('liquidaciones en revisión', () => contarLiquidacionesEnRevisar()),
    porValor('resumen de la semana pasada', async () => {
      const lunesPrevio = lunesDe(diaAnterior(lunes));
      return leerReporte('orquestador_semanal', `lun-${lunesPrevio}`);
    }),
  ]);
  const prospectosPrev = (prev.valor?.resumen?.prospectos as Record<string, number> | undefined) ?? null;
  const datos: DatosCiclo = {
    lunes, prospectos, prospectosPrev, facturasSaas: facturas,
    piezasSemana: piezas, pendientesCola: pendientes, conteos, revisar,
  };
  const ciegas = [prospectos, facturas, piezas, pendientes, conteos, revisar]
    .filter((f) => f.error !== null).map((f) => f.error as string);
  return { datos, ciegas };
}

async function leerDatosOperativo(lunes: string, ciclo: string): Promise<{ datos: DatosOperativo; ciegas: string[] }> {
  const [latidos, interruptores, agentes, corridas, bandeja] = await Promise.all([
    porValor('latido de los crons', () => estadoLatidos()),
    porValor('interruptores', () => listarInterruptores()),
    porValor('agentes del runner', () => agentesDelRunner()),
    porValor('bitácora de corridas', () => ultimasCorridasPorAgente()),
    porValor('bandeja de escalaciones', () => getBandejaEscalaciones(Date.now())),
  ]);
  const datos: DatosOperativo = { lunes, latidos, interruptores, agentesRunner: agentes, corridas, bandeja, ciclo };
  const ciegas = [latidos, interruptores, agentes, corridas, bandeja]
    .filter((f) => f.error !== null).map((f) => f.error as string);
  return { datos, ciegas };
}

// ═══════════════════════════════════════════════════════════════════════════
// EL ENVÍO Y LA CORRIDA — un correo al operador, sellado tras la aceptación.
// ═══════════════════════════════════════════════════════════════════════════

export interface CorridaDireccion {
  resultado: 'corrio' | 'saltado';
  motivo?: string;
  piezas?: number;
  costoUsd?: number;
}

const PIE_CANAL = 'Canal interino: correo del operador — el WhatsApp de Javier espera el número verificado de Meta.';

async function enviarReporte(asunto: string, titulo: string, cuerpo: string): Promise<{ ok: true } | { ok: false; motivo: string; definitivo: boolean }> {
  const para = process.env.ALERTA_EMAIL;
  if (!para) return { ok: false, motivo: 'ALERTA_EMAIL sin configurar — el reporte no tiene canal', definitivo: true };
  const r = await enviarCorreo(para, {
    asunto,
    avance: cuerpo.split('\n').find((l) => l.trim().length > 0)?.slice(0, 120) ?? titulo,
    titulo,
    parrafos: cuerpo.split('\n\n'),
    tono: 'neutral',
    porQueLoRecibes: `Recibes este reporte porque ALERTA_EMAIL apunta a esta dirección: es el canal del operador del sistema. ${PIE_CANAL}`,
  });
  if (r.ok) return { ok: true };
  // 'red' incluye el timeout: AMBIGUO — el correo pudo haber salido con la
  // respuesta perdida (c5-15). El llamador NO reintenta un ambiguo: reenvía
  // solo lo definitivamente no-enviado.
  return { ok: false, motivo: `el correo no salió (${r.motivo})`, definitivo: r.motivo !== 'red' };
}

/** Sella el envío de un reporte YA reservado (c5-15): el INSERT del periodo
 *  va ANTES del correo — la carrera de dos pasadas la gana una — y este
 *  UPDATE pone la fecha solo tras la aceptación del canal. */
async function marcarReporteEnviado(agente: AgenteDireccion, periodo: string): Promise<void> {
  const { error } = await supabaseAdmin().from('reporte_direccion')
    .update({ enviado_en: new Date().toISOString() })
    .eq('agente', agente).eq('periodo', periodo).is('enviado_en', null);
  if (error) logger.error('direccion.sello_no_escrito', { agente, periodo, err: error.message });
}

/** Borra la reserva de un periodo cuyo envío falló DEFINITIVAMENTE (el canal
 *  dijo que no; nada salió): la siguiente pasada vuelve a intentar. Jamás se
 *  llama tras un fallo ambiguo — ahí la reserva se queda como "generado,
 *  envío por confirmar" precisamente para que nadie reenvíe. */
async function borrarReservaReporte(agente: AgenteDireccion, periodo: string): Promise<void> {
  const { error } = await supabaseAdmin().from('reporte_direccion')
    .delete().eq('agente', agente).eq('periodo', periodo).is('enviado_en', null);
  if (error) logger.error('direccion.reserva_no_borrada', { agente, periodo, err: error.message });
}

/** Registra la corrida del agente — jamás lanza (contrato de corridas.ts). */
async function anotar(
  agente: AgenteDireccion, inicio: Date, estado: 'ok' | 'fallo', disparo: DisparoCorrida,
  resumen: Record<string, unknown>, error?: string,
): Promise<void> {
  await registrarCorrida(null, agente, {
    inicio, fin: new Date(), estado, disparo, costoUsd: 0,
    ...(estado === 'ok' ? { tareasHechas: 1, tareasTotal: 1 } : {}),
    resumen,
    ...(error ? { error } : {}),
  });
}

/**
 * UNA corrida de un agente de dirección, despachada por el runner. Decide si
 * TOCA (hora/día de México), si YA SALIÓ (el sello), arma con lo legible,
 * manda por el canal interino y sella después de la aceptación.
 */
export async function correrAgenteDireccion(
  agente: AgenteDireccion,
  ahora: Date = new Date(),
  disparo: DisparoCorrida = 'cron',
): Promise<CorridaDireccion> {
  const inicio = new Date();
  const { dia, hora, esLunes } = partesMx(ahora);
  const lunes = lunesDe(dia);
  const periodoSemanal = `lun-${lunes}`;

  try {
    // ── Los productores de artefactos: solo lunes, un artefacto por semana ──
    if (agente === 'desempeno_startup' || agente === 'orquestador_semanal') {
      if (!esLunes) return { resultado: 'saltado', motivo: 'corre los lunes (día de México)' };
      const previo = await leerReporte(agente, periodoSemanal);
      if (previo) {
        // c5-15: el artefacto puede haberlo fabricado OTRO agente (el kpi del
        // lunes lo arma vía obtenerOArmarArtefacto). Sin esta corrida, el
        // detector del orquestador acusaba «NO CORRIÓ» a un productor cuyo
        // trabajo de la semana SÍ está hecho — recogerlo también es correr.
        await anotar(agente, inicio, 'ok', disparo, { periodo: periodoSemanal, recogido: 'el artefacto de esta semana ya estaba generado' });
        return { resultado: 'saltado', motivo: 'el artefacto de esta semana ya está generado' };
      }
      const armado = agente === 'desempeno_startup'
        ? await (async () => {
          const { datos, ciegas } = await leerDatosDiagnostico(dia);
          return { cuerpo: armarDiagnostico(datos), resumen: null as Record<string, unknown> | null, ciegas };
        })()
        : await (async () => {
          const { datos, ciegas } = await leerDatosCiclo(lunes);
          return {
            cuerpo: armarSeccionesCiclo(datos),
            // Los conteos de HOY son el "semana pasada" del lunes que viene.
            resumen: { prospectos: datos.prospectos.valor } as Record<string, unknown>,
            ciegas,
          };
        })();
      const guardado = await guardarReporte(agente, periodoSemanal, armado.cuerpo, armado.resumen, armado.ciegas, null);
      if (guardado === 'ya_existia') {
        await anotar(agente, inicio, 'ok', disparo, { periodo: periodoSemanal, recogido: 'otra corrida generó el artefacto primero (unique)' });
        return { resultado: 'saltado', motivo: 'otra corrida generó el artefacto primero (unique)' };
      }
      await anotar(agente, inicio, 'ok', disparo, { periodo: periodoSemanal, fuentes_ciegas: armado.ciegas });
      return { resultado: 'corrio', piezas: 1, costoUsd: 0 };
    }

    // ── Los transportes (correo): kpi diario/lunes y el parte operativo ────
    if (Number.isNaN(hora) || hora < HORA_REPORTE_MX) {
      return { resultado: 'saltado', motivo: `antes de las ${HORA_REPORTE_MX}:00 de México — nada a las 2 AM porque un cron se atrasó` };
    }

    if (agente === 'orquestador') {
      if (!esLunes) return { resultado: 'saltado', motivo: 'corre los lunes (día de México)' };
      const sello = await leerReporte(agente, periodoSemanal);
      if (sello?.enviadoEn) return { resultado: 'saltado', motivo: 'el parte de esta semana ya salió' };
      // c5-15: una reserva SIN fecha de envío es un intento previo AMBIGUO
      // (el correo pudo haber salido) — no se reenvía; se dice.
      if (sello) return { resultado: 'saltado', motivo: 'el parte de esta semana quedó generado con envío por confirmar (fallo ambiguo del canal) — no se reenvía solo' };
      const ciclo = await obtenerOArmarArtefacto('orquestador_semanal', periodoSemanal, async () => {
        const { datos, ciegas } = await leerDatosCiclo(lunes);
        return { cuerpo: armarSeccionesCiclo(datos), resumen: { prospectos: datos.prospectos.valor }, ciegas };
      });
      const { datos, ciegas } = await leerDatosOperativo(lunes, ciclo.cuerpo);
      const cuerpo = armarParteOperativo(datos, ahora.getTime());
      // LA RESERVA VA ANTES DEL CORREO (c5-15): dos pasadas solapadas ya no
      // mandan el parte dos veces — el unique de (agente, periodo) elige una.
      const reserva = await guardarReporte(agente, periodoSemanal, cuerpo, null, ciegas, null);
      if (reserva === 'ya_existia') return { resultado: 'saltado', motivo: 'otra pasada reservó el parte primero (unique)' };
      const envio = await enviarReporte(`[Likida] Parte operativo · semana del ${lunes}`, 'El parte operativo del lunes', cuerpo);
      if (!envio.ok) {
        // Definitivo (el canal dijo que no): la reserva se libera y la
        // siguiente pasada reintenta. Ambiguo (timeout): la reserva se QUEDA
        // — reenviar un "no sé" duplica el correo; el estado es visible.
        if (envio.definitivo) await borrarReservaReporte(agente, periodoSemanal);
        await anotar(agente, inicio, 'fallo', disparo, { periodo: periodoSemanal, ambiguo: !envio.definitivo }, envio.motivo);
        return { resultado: 'corrio', piezas: 0, motivo: envio.motivo };
      }
      await marcarReporteEnviado(agente, periodoSemanal);
      await anotar(agente, inicio, 'ok', disparo, { periodo: periodoSemanal, canal: 'correo', fuentes_ciegas: ciegas });
      return { resultado: 'corrio', piezas: 1, costoUsd: 0 };
    }

    // kpi_whatsapp — el lunes largo reemplaza al corto (blueprint §2).
    const periodo = esLunes ? periodoSemanal : `dia-${dia}`;
    const sello = await leerReporte('kpi_whatsapp', periodo);
    if (sello?.enviadoEn) return { resultado: 'saltado', motivo: 'el reporte de este periodo ya salió' };
    // c5-15: reserva sin fecha = intento previo ambiguo — no se reenvía.
    if (sello) return { resultado: 'saltado', motivo: 'el reporte de este periodo quedó generado con envío por confirmar (fallo ambiguo del canal) — no se reenvía solo' };

    let cuerpo: string;
    let ciegas: string[];
    if (esLunes) {
      const diagnostico = await obtenerOArmarArtefacto('desempeno_startup', periodoSemanal, async () => {
        const lectura = await leerDatosDiagnostico(dia);
        return { cuerpo: armarDiagnostico(lectura.datos), resumen: null, ciegas: lectura.ciegas };
      });
      const secciones = await obtenerOArmarArtefacto('orquestador_semanal', periodoSemanal, async () => {
        const lectura = await leerDatosCiclo(lunes);
        return { cuerpo: armarSeccionesCiclo(lectura.datos), resumen: { prospectos: lectura.datos.prospectos.valor }, ciegas: lectura.ciegas };
      });
      const lectura = await leerDatosKpi(dia, esLunes);
      ciegas = lectura.ciegas;
      cuerpo = armarKpiLunes(dia, diagnostico.cuerpo, secciones.cuerpo, derivarDecisiones(lectura.datos));
    } else {
      const lectura = await leerDatosKpi(dia, esLunes);
      ciegas = lectura.ciegas;
      cuerpo = armarKpiDiario(lectura.datos);
    }

    const asunto = esLunes ? `[Likida] La semana, en un correo · ${lunes}` : `[Likida] El día en 10 segundos · ${dia}`;
    // LA RESERVA VA ANTES DEL CORREO (c5-15): el unique de (agente, periodo)
    // resuelve la carrera de dos pasadas — el correo doble a Javier era el
    // bug; la FECHA de envío se estampa solo tras la aceptación (c2-1/0202).
    const reserva = await guardarReporte('kpi_whatsapp', periodo, cuerpo, null, ciegas, null);
    if (reserva === 'ya_existia') return { resultado: 'saltado', motivo: 'otra pasada reservó el reporte primero (unique)' };
    const envio = await enviarReporte(asunto, esLunes ? 'El reporte del lunes' : 'El reporte del día', cuerpo);
    if (!envio.ok) {
      if (envio.definitivo) await borrarReservaReporte('kpi_whatsapp', periodo);
      await anotar('kpi_whatsapp', inicio, 'fallo', disparo, { periodo, ambiguo: !envio.definitivo }, envio.motivo);
      return { resultado: 'corrio', piezas: 0, motivo: envio.motivo };
    }
    await marcarReporteEnviado('kpi_whatsapp', periodo);
    await anotar('kpi_whatsapp', inicio, 'ok', disparo, { periodo, canal: 'correo', fuentes_ciegas: ciegas });
    return { resultado: 'corrio', piezas: 1, costoUsd: 0 };
  } catch (e) {
    // Un fallo del propio motor (el sello ilegible, p. ej.) se anota y se
    // dice — el runner lo pinta como corrida sin piezas, no como éxito.
    const msj = e instanceof Error ? e.message : String(e);
    await anotar(agente, inicio, 'fallo', disparo, { dia }, msj.slice(0, 300));
    return { resultado: 'corrio', piezas: 0, motivo: msj.slice(0, 200) };
  }
}
