// ═══════════════════════════════════════════════════════════════════════════
// LOS 4 AGENTES FINANCIEROS DEL BACK OFFICE (0215) — analista_metricas,
// control_costos, tesoreria y cierre_mensual, vivos en el runner nivel 2.
//
// Los blueprints viven en 13-Agentes-de-AI/08-Financieros/. La decisión de
// construcción que los cuatro comparten y que NO está en los blueprints:
// CERO LLM. La regla de la casa es «las reglas deterministas calculan, el
// modelo solo redacta» — y aquí ni la redacción necesita modelo: la salida de
// cada agente es un PARTE con formato fijo (el de su blueprint), armado por
// una función pura sobre cifras que ya calculó el sistema. Un agente
// financiero que pudiera alucinar una cifra sería exactamente el agente que
// el blueprint prohíbe; uno que no puede, porque no hay modelo en el camino,
// cumple «cada número sale de una consulta real» por construcción.
// (El presupuesto_dia_usd declarado en la 0215 sigue siendo obligatorio para
// el candado 3 del runner; el gasto medido de estas corridas es $0.)
//
// LA SALIDA es la cola de aprobación (0117), como todo agente del runner: el
// parte entra como pieza (tipo parte_*) a la bandeja de /admin/aprobaciones.
// Aprobar un parte = darlo por visto; no hay envío (no hay prospecto). Los
// hallazgos ROJOS además van por el canal del operador (alertarOperador) en
// el momento — la alerta jamás espera a que alguien abra la bandeja.
//
// IDEMPOTENCIA POR PERIODO: cada parte lleva un título determinista por
// periodo («Costos — 2026-08-27», «Cierre — 2026-07»). El árbitro es el
// índice único parcial de la 0215 sobre (agente, titulo) — el pre-check de
// aquí es cortesía para no gastar lecturas; la garantía es el constraint
// (estándar técnico §7: nunca un `if` solo).
//
// LO QUE NINGUNO HACE SOLO (los cuatro blueprints coinciden): no mueven
// dinero, no tocan variables de entorno, no cambian precios, no mandan nada
// fuera de Likida. Calculan, citan la fuente, y dejan el parte.
// ═══════════════════════════════════════════════════════════════════════════
import { supabaseAdmin } from '@/lib/supabase/admin';
import { acotada } from '../presupuesto';
import { hoyMx, round2, usd, mxn, numero } from '@/lib/formato';
import { modelFor, type ModelRole } from '@/lib/llm/models';
import {
  getResumenNegocio, getCostoPorFaseModelo, getConteosPlataforma,
  costoIaMesActual, costoIaVentana,
  type ResumenNegocio, type CostoPorFaseModelo, type ConteosPlataforma,
} from '@/lib/admin/negocio';
import { getPorCobrar } from '@/lib/saas/transferencia';
import { getPlanes } from '@/lib/saas/suscripcion';
import { alertarOperador } from '@/lib/observability/alerta';
import { encolarPieza } from './cola';
import { registrarCorrida, type DisparoCorrida } from './corridas';
import { insumosPendientes, marcarInsumosProcesados, type InsumoAgente } from './insumos';
import { logger } from '@/lib/logger';
import {
  ESTADOS_PROSPECTO,
  ESTADOS_PROSPECTO_PERSISTIDOS,
  normalizarConteosProspecto,
} from '@/lib/likida/vendedores';

export const AGENTES_FINANCIEROS = ['analista_metricas', 'control_costos', 'tesoreria', 'cierre_mensual'] as const;
export type AgenteFinanciero = (typeof AGENTES_FINANCIEROS)[number];

export function esAgenteFinanciero(id: string): id is AgenteFinanciero {
  return (AGENTES_FINANCIEROS as readonly string[]).includes(id);
}

/** Lo que una corrida financiera le reporta al runner. */
export interface ResultadoFinanciero {
  /** Piezas fabricadas hacia la bandeja (0 o 1 — un parte por periodo). */
  piezas: number;
  /** Por qué no se fabricó, cuando piezas = 0 y no es un fallo. */
  motivo?: string;
}

// ── La configuración declarada (finanzas_config, 0215) ─────────────────────
//
// TODO es anulable y NULL significa «Javier no lo ha declarado» — nunca un
// default inventado. Los valores que los blueprints proponen ($6,500 de
// fijos P10, $65,000 de costo de vida P11, $150 USD/mes de presupuesto de
// IA) son PROPUESTAS pendientes de firma [DECISIÓN DE JAVIER]; sembrarlos
// aquí los convertiría en política vigente sin que nadie la firmara. El
// agente reporta el hueco y qué declarar, que es su trabajo.

export interface ConfigFinanzas {
  /** Saldo en caja declarado por Javier, MXN. El agente JAMÁS lee el banco. */
  saldoMxn: number | null;
  /** La fecha del estado de cuenta del saldo — sin ella el saldo no vale. */
  saldoFecha: string | null;
  costoVidaMxn: number | null;
  fijosMxn: number | null;
  presupuestoIaMesUsd: number | null;
  tipoCambioMxnUsd: number | null;
}

/** LANZA si la base no responde — una config ilegible no es una config vacía. */
export async function leerConfigFinanzas(): Promise<ConfigFinanzas> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('finanzas_config')
    .select('saldo_mxn, saldo_fecha, costo_vida_mxn, fijos_mxn, presupuesto_ia_mes_usd, tipo_cambio_mxn_usd')
    .maybeSingle(), 'finanzas.config');
  if (error) throw new Error(`leerConfigFinanzas: ${error.message}`);
  const f = (data ?? {}) as Record<string, unknown>;
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    saldoMxn: n(f.saldo_mxn),
    saldoFecha: (f.saldo_fecha as string | null) ?? null,
    costoVidaMxn: n(f.costo_vida_mxn),
    fijosMxn: n(f.fijos_mxn),
    presupuestoIaMesUsd: n(f.presupuesto_ia_mes_usd),
    tipoCambioMxnUsd: n(f.tipo_cambio_mxn_usd),
  };
}

// ── Periodos (día de México, aritmética UTC pura — `hoy` es inyectable) ────

/** El lunes de la semana de `hoy` ('YYYY-MM-DD'), como ancla del parte
 *  semanal: el runner corre cada 4 horas y el título por lunes hace que la
 *  semana tenga UN parte, lo fabrique la corrida que lo fabrique. */
export function lunesDeSemana(hoy: string): string {
  const d = new Date(`${hoy}T00:00:00Z`);
  const dia = d.getUTCDay(); // 0 = domingo
  d.setUTCDate(d.getUTCDate() - ((dia + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** El mes ANTERIOR al de `hoy`, 'YYYY-MM' — el mes que el cierre cierra. */
export function mesAnterior(hoy: string): string {
  const d = new Date(`${hoy.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

/** Días entre dos fechas ISO 'YYYY-MM-DD' (b − a). */
function diasEntre(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

// ── El parte hacia la bandeja, con su idempotencia ─────────────────────────

/** ¿Ya existe el parte de este periodo (cualquier estado)? LANZA si no se
 *  puede saber: sin poder verificar, no se fabrica (fail closed). */
async function parteExistente(agente: AgenteFinanciero, titulo: string): Promise<boolean> {
  const { count, error } = await acotada(supabaseAdmin()
    .from('cola_aprobacion')
    .select('id', { count: 'exact', head: true })
    .eq('agente', agente)
    .eq('titulo', titulo), 'finanzas.parte_existente');
  if (error) throw new Error(`parteExistente(${agente}): ${error.message}`);
  if (typeof count !== 'number') throw new Error(`parteExistente(${agente}): PostgREST no devolvió el conteo.`);
  return count > 0;
}

/** Encola el parte. El índice único de la 0215 es el árbitro real: si otra
 *  corrida ganó la carrera del mismo periodo, el duplicado rebota y se trata
 *  como «ya existía», no como fallo. */
async function encolarParte(
  agente: AgenteFinanciero, tipo: string, titulo: string, cuerpo: string,
  fuentes: Record<string, unknown>,
): Promise<'encolada' | 'ya_existia'> {
  try {
    await encolarPieza({ tipo, prioridad: 'normal', agente, titulo, cuerpo, fuentes });
    return 'encolada';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('duplicate key') || msg.includes('cola_parte_por_periodo')) return 'ya_existia';
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTROL DE COSTOS — el parte diario (blueprint agente-control-de-costos.md)
// ═══════════════════════════════════════════════════════════════════════════

export type SemaforoHallazgo = 'ROJO' | 'AMBAR' | 'NOTA';
export interface HallazgoCosto { semaforo: SemaforoHallazgo; umbral: string; detalle: string }

/** Fase de `llm_costo` → rol de models.ts que dicta su modelo ESPERADO.
 *  `whatsapp` no es un modelo y `router` no tiene rol propio declarado en
 *  models.ts — esas fases no participan del chequeo U1 y se dice por qué. */
const ROL_POR_FASE: Record<string, ModelRole> = {
  ocr: 'ocr',
  cuadre: 'cuadre',
  chat: 'chat',
  escalacion: 'cuadre_fallback',
  transcripcion: 'transcripcion',
};

/** El piso de U2: un 30% de salto sobre menos de $5 USD/semana es ruido de
 *  base chica, no una fuga — y una alerta que grita por ruido se deja de
 *  leer (blueprint U2). */
const PISO_TENDENCIA_USD = 5;
/** La banda medida del costo por viaje ($0.037 USD, unit-economics §1.2) y
 *  su tolerancia ×1.6 (blueprint U3). */
const BANDA_COSTO_VIAJE_USD = 0.037;
const TOPE_COSTO_VIAJE_USD = 0.06;

/**
 * Los umbrales U1–U5, PUROS sobre cifras ya leídas. U1 es el que importa:
 * compara el modelo con el que CORRIÓ cada fase contra el que models.ts
 * resuelve HOY para esa fase. Un override de Vercel caído deja las filas
 * históricas con el modelo bueno y la resolución actual con el default — la
 * discrepancia es exactamente la señal; y una fase corriendo con DOS modelos
 * en la ventana delata el cambio a mitad de camino.
 */
export function evaluarUmbralesCostos(
  r: Pick<ResumenNegocio, 'costoIaUsd' | 'viajesProcesados' | 'porDia' | 'tendenciaCosto'>,
  porFaseModelo: CostoPorFaseModelo[],
  cfg: Pick<ConfigFinanzas, 'presupuestoIaMesUsd'>,
  modeloEsperado: (rol: ModelRole) => string,
  hoy: string,
): HallazgoCosto[] {
  const hallazgos: HallazgoCosto[] = [];

  // U1 — el modelo equivocado en una fase (la alerta de FORMA, no de monto).
  for (const [fase, rol] of Object.entries(ROL_POR_FASE)) {
    const esperado = modeloEsperado(rol);
    const corridos = porFaseModelo.filter((f) => f.fase === fase);
    const ajenos = corridos.filter((f) => f.modelo !== esperado);
    if (ajenos.length > 0) {
      const detalle = ajenos.map((f) => `${f.modelo} en ${numero(f.n)} llamadas (${usd(round2(f.costoUsd))})`).join(' · ');
      hallazgos.push({
        semaforo: 'ROJO', umbral: 'U1',
        detalle: `la fase \`${fase}\` corrió con un modelo distinto del esperado (${esperado}): ${detalle}. `
          + 'Si el esperado viene de un override de Vercel, verifica que la variable siga puesta — el agente no toca el entorno.',
      });
    }
  }

  // U2 — salto de tendencia CON piso de dinero.
  const costo7d = r.porDia.reduce((s, d) => s + d.costoUsd, 0);
  if (r.tendenciaCosto !== null && r.tendenciaCosto >= 30 && costo7d >= PISO_TENDENCIA_USD) {
    hallazgos.push({
      semaforo: 'AMBAR', umbral: 'U2',
      detalle: `el costo de IA subió ${numero(Math.round(r.tendenciaCosto))}% (7d vs 7d anteriores) con ${usd(round2(costo7d))} en la semana — revisar el desglose por fase del parte.`,
    });
  }

  // U3 — costo por viaje fuera de banda. Sin viajes NO se divide.
  if (r.viajesProcesados > 0) {
    const unitario = r.costoIaUsd / r.viajesProcesados;
    if (unitario > TOPE_COSTO_VIAJE_USD) {
      hallazgos.push({
        semaforo: 'AMBAR', umbral: 'U3',
        detalle: `costo de IA por viaje en ${usd(round2(unitario))} (banda medida: ${usd(BANDA_COSTO_VIAJE_USD)}). `
          + 'Es UNA observación — la persistencia se lee comparando este parte contra los anteriores en la bandeja.',
      });
    }
  }

  // U4 — la proyección del mes contra el presupuesto DECLARADO.
  if (r.porDia.length > 0) {
    const proyeccion = (costo7d / r.porDia.length) * 30;
    if (cfg.presupuestoIaMesUsd !== null && proyeccion > cfg.presupuestoIaMesUsd) {
      hallazgos.push({
        semaforo: 'AMBAR', umbral: 'U4',
        detalle: `la proyección a 30 días (${usd(round2(proyeccion))}, ventana de ${r.porDia.length} días) rebasa el presupuesto declarado de ${usd(cfg.presupuestoIaMesUsd)}/mes.`,
      });
    } else if (cfg.presupuestoIaMesUsd === null) {
      hallazgos.push({
        semaforo: 'NOTA', umbral: 'U4',
        detalle: 'sin presupuesto mensual de IA declarado (finanzas_config.presupuesto_ia_mes_usd) — la proyección se reporta pero no se compara contra nada.',
      });
    }
  }

  // U5 — la alerta DE CALENDARIO: el precio intro de Sonnet vence el 31-ago-2026.
  if (hoy >= '2026-09-01' && hoy <= '2026-09-07') {
    hallazgos.push({
      semaforo: 'NOTA', umbral: 'U5',
      detalle: 'desde el 1-sep el precio intro de Sonnet venció: un alza ~50% en el componente de cuadre contra la línea base de agosto es lo ESPERADO; más que eso es otra cosa.',
    });
  }

  return hallazgos;
}

/**
 * La sección "lo que Javier dejó en la bandeja" (Fase D, la bandeja de
 * contexto universal, 0267) — PURA, para poder probarla sin base. Vacía
 * cuando no hay insumos pendientes: un parte no debe cargar una sección
 * fantasma. Un `link`/`texto` enseña su contenido recortado (200
 * caracteres — el parte es para leerse, no para transcribir un documento
 * entero); un `documento`/`imagen`/`video` solo el título, porque su
 * contenido vive en Storage y este parte es texto plano.
 */
export function formatearSeccionInsumos(insumos: Pick<InsumoAgente, 'tipo' | 'titulo' | 'contenidoTexto'>[]): string[] {
  if (insumos.length === 0) return [];
  const lineas = ['INSUMOS QUE JAVIER DEJÓ EN LA BANDEJA:'];
  for (const i of insumos) {
    const extra = i.contenidoTexto ? `: ${i.contenidoTexto.slice(0, 200)}${i.contenidoTexto.length > 200 ? '…' : ''}` : '';
    lineas.push(`  · [${i.tipo}] ${i.titulo}${extra}`);
  }
  lineas.push('');
  return lineas;
}

/** El parte de una pantalla (formato del blueprint). Si nada disparó umbral,
 *  el parte es corto a propósito: media página para decir «todo bien» enseña
 *  a no leerlo. */
export function armarParteCostos(
  r: Pick<ResumenNegocio, 'costoIaUsd' | 'viajesProcesados' | 'porDia' | 'tendenciaCosto'>,
  porFaseModelo: CostoPorFaseModelo[],
  hallazgos: HallazgoCosto[],
  hoy: string,
  insumos: Pick<InsumoAgente, 'tipo' | 'titulo' | 'contenidoTexto'>[] = [],
): string {
  const costo7d = round2(r.porDia.reduce((s, d) => s + d.costoUsd, 0));
  const tendencia = r.tendenciaCosto === null
    ? 'sin base (menos de 14 días con datos — no se inventa una tendencia de dos puntos)'
    : `${r.tendenciaCosto >= 0 ? '+' : ''}${numero(Math.round(r.tendenciaCosto))}%`;
  const unitario = r.viajesProcesados > 0
    ? `${usd(round2(r.costoIaUsd / r.viajesProcesados))} sobre ${numero(r.viajesProcesados)} viajes`
    : 'sin viajes en la ventana — no hay costo unitario que afirmar';
  const proyeccion = r.porDia.length > 0
    ? `${usd(round2((costo7d / r.porDia.length) * 30))} (ventana de ${r.porDia.length} días con actividad)`
    : 'sin base para proyectar';
  const porFase = porFaseModelo.length > 0
    ? [...new Map(porFaseModelo.map((f) => [f.fase, 0])).keys()]
      .map((fase) => `${fase} ${usd(round2(porFaseModelo.filter((x) => x.fase === fase).reduce((s, x) => s + x.costoUsd, 0)))}`)
      .join(' · ')
    : 'sin llamadas registradas';

  const lineas = [
    `COSTOS — ${hoy}`,
    '',
    `Gasto de IA: ${usd(round2(r.costoIaUsd))} histórico · ${usd(costo7d)} en los últimos 7 días (tendencia: ${tendencia})`,
    `Por fase (histórico): ${porFase}`,
    `Costo por viaje: ${unitario}`,
    `Proyección a 30 días: ${proyeccion}`,
    '',
  ];
  const disparados = hallazgos.filter((h) => h.semaforo !== 'NOTA');
  for (const h of hallazgos) lineas.push(`[${h.semaforo}]  ${h.umbral} — ${h.detalle}`);
  if (disparados.length === 0) lineas.push('Nada disparó umbral.');
  lineas.push('', ...formatearSeccionInsumos(insumos));
  lineas.push('Fuentes: getResumenNegocio()/getCostoPorFaseModelo() (RPC resumen_costo_ia, mig. 0062) · umbrales del blueprint agente-control-de-costos.md.');
  return lineas.join('\n');
}

async function correrControlCostos(disparo: DisparoCorrida, hoy: string): Promise<ResultadoFinanciero> {
  const inicio = new Date();
  const agente = 'control_costos';
  const titulo = `Costos — ${hoy}`;
  try {
    if (await parteExistente(agente, titulo)) {
      await registrarCorrida(null, agente, {
        inicio, fin: new Date(), estado: 'ok', disparo, costoUsd: 0,
        resumen: { parte: 'ya_existia', titulo },
      });
      return { piezas: 0, motivo: 'el parte de hoy ya está en la bandeja' };
    }

    // U1 mira una ventana de 7 días, no el histórico (c5-8): una migración
    // legítima de modelo dejaba las filas viejas disparando ROJO en cada
    // parte diario, para siempre — la alerta que grita por ruido se deja de
    // leer. Siete días delatan el override caído Y el cambio a mitad de
    // camino sin arrastrar la historia entera.
    const desde7d = new Date(Date.parse(`${hoy}T12:00:00Z`) - 7 * 86_400_000).toISOString();
    // La bandeja de contexto universal (Fase D, 0267): lo que Javier dejó
    // pendiente para ESTE agente entra en el mismo Promise.all que el resto
    // de las lecturas — si insumosPendientes truena, la corrida entera falla
    // (fail-closed, mismo contrato que el resto de este archivo).
    const [r, porFaseModelo, cfg, insumos] = await Promise.all([
      getResumenNegocio(hoy), getCostoPorFaseModelo(desde7d), leerConfigFinanzas(), insumosPendientes(agente),
    ]);
    const hallazgos = evaluarUmbralesCostos(r, porFaseModelo, cfg, modelFor, hoy);

    // El ROJO no espera a la bandeja: va por el canal del operador YA. La
    // alerta sale ANTES de encolar a propósito — si el parte no pudiera
    // entrar (carrera del periodo, bandeja caída), el hallazgo ya salió.
    const rojos = hallazgos.filter((h) => h.semaforo === 'ROJO');
    if (rojos.length > 0) {
      await alertarOperador('finanzas.control_costos', {
        error: rojos.map((h) => `${h.umbral}: ${h.detalle}`).join(' | ').slice(0, 900),
        codigo: 'finanzas_u1_modelo_inesperado',
      });
    }

    const cuerpo = armarParteCostos(r, porFaseModelo, hallazgos, hoy, insumos);
    const res = await encolarParte(agente, 'parte_costos', titulo, cuerpo, {
      hallazgos: hallazgos.map((h) => ({ semaforo: h.semaforo, umbral: h.umbral })),
      consultas: ['getResumenNegocio', 'getCostoPorFaseModelo', 'finanzas_config', 'agente_insumo (pendientes)'],
    });
    // El insumo solo se marca procesado si el parte de verdad quedó en la
    // bandeja CON él adentro — si otra corrida ganó el periodo (res ===
    // 'ya_existia'), este insumo sigue pendiente para la siguiente vez que
    // de verdad se arme un parte nuevo.
    let insumosMarcados = 0;
    if (res === 'encolada' && insumos.length > 0) {
      insumosMarcados = await marcarInsumosProcesados(
        insumos.map((i) => i.id),
        `Incluido en el parte de Costos — ${hoy}.`,
      );
    }
    await registrarCorrida(null, agente, {
      inicio, fin: new Date(), estado: 'ok', disparo, costoUsd: 0,
      tareasHechas: 1, tareasTotal: 1,
      resumen: { parte: res, rojos: rojos.length, ambar: hallazgos.filter((h) => h.semaforo === 'AMBAR').length, insumosMarcados },
    });
    return { piezas: res === 'encolada' ? 1 : 0, motivo: res === 'ya_existia' ? 'otra corrida ganó el periodo' : undefined };
  } catch (e) {
    // Fail closed y DICHO: sin lecturas completas no hay parte — un parte de
    // $0 sobre una base caída se leería como «la IA salió gratis».
    await registrarCorrida(null, agente, {
      inicio, fin: new Date(), estado: 'fallo', disparo, costoUsd: 0,
      error: `No se pudo armar el parte de costos: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500),
    });
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ANALISTA DE MÉTRICAS — el parte semanal (agente-analista-de-metricas.md).
// El chat bajo demanda del blueprint es el copiloto (dirección); lo que el
// runner agenda es el PARTE de las consultas nombradas, con cada cifra y su
// fuente en la misma línea.
// ═══════════════════════════════════════════════════════════════════════════

interface SuscripcionActiva { plan_clave: string }

/** Suscripciones activas (todas las flotas). LANZA si no se puede leer.
 *
 *  PRIMERA PASADA REAL DEL RUNNER (18:03, producción): esta consulta pedía
 *  `plan` y Postgres contestó `column suscripcion.plan does not exist` (42703)
 *  — el parte semanal de métricas nacía muerto en TODAS las corridas. La
 *  columna real de la 0052 es `plan_clave` (FK a `plan.clave`); `plan` a secas
 *  existe, pero en `tenant`, que es otra tabla. La suite pasaba porque el mock
 *  de `select()` ignoraba sus argumentos y fabricaba la fuente (mismo patrón
 *  que el hallazgo c5-9 en reportes.ts). La prueba estructural de abajo lee el
 *  esquema REAL de la migración y compara: una columna inventada ya no pasa. */
async function leerSuscripcionesActivas(): Promise<SuscripcionActiva[]> {
  // AGB-10 (auditoría 24): los tenants "ZZZ QA …" (sembrados a propósito
  // para pruebas) no deben contar hacia el MRR ni las suscripciones activas
  // del parte semanal — mismo criterio que `exito.ts leerFlotas`. `!inner`
  // porque el filtro va sobre la tabla embebida (regla de embeds del repo).
  const { data, error } = await acotada(supabaseAdmin()
    .from('suscripcion')
    .select('plan_clave, tenant:tenant_id!inner(nombre)')
    .eq('estado', 'activa')
    .not('tenant.nombre', 'ilike', 'ZZZ QA %')
    .limit(1000), 'finanzas.suscripciones');
  if (error) throw new Error(`leerSuscripcionesActivas: ${error.message}`);
  return (data ?? []) as SuscripcionActiva[];
}

/** El embudo por estado — conteos EN LA BASE (head+exact), jamás el largo de
 *  una lista con ventana (la trampa §6.2 del diccionario de KPIs). */
export async function contarPipeline(): Promise<Array<{ estado: string; n: number }>> {
  const crudos = await Promise.all(ESTADOS_PROSPECTO_PERSISTIDOS.map(async (estado) => {
    const { count, error } = await acotada(supabaseAdmin()
      .from('prospecto')
      .select('id', { count: 'exact', head: true })
      .is('duplicado_de', null)
      .eq('estado', estado), `finanzas.pipeline.${estado}`);
    if (error) throw new Error(`contarPipeline(${estado}): ${error.message}`);
    if (typeof count !== 'number') throw new Error(`contarPipeline(${estado}): sin conteo — no se afirma un 0 que nadie midió.`);
    return { estado, n: count };
  }));
  const canonicos = normalizarConteosProspecto(crudos);
  return ESTADOS_PROSPECTO.map(({ valor: estado }) => ({ estado, n: canonicos[estado] }));
}

export interface CifrasMetricas {
  activas: number;
  mrrMxn: number | null;          // null = hay activas sin precio configurado
  activasSinPrecio: number;
  pipeline: Array<{ estado: string; n: number }>;
  conteos: ConteosPlataforma;
  costoIaUsd: number;
  viajesProcesados: number;
  porCobrar: number;
  porCobrarMonto: number;
}

/** El parte semanal, PURO. Cada línea: cifra + absoluto + fuente — y lo que
 *  la cifra NO dice, cuando el blueprint lo exige (churn con base 0). */
export function armarParteMetricas(c: CifrasMetricas, lunes: string): string {
  const mrr = c.activas === 0
    ? 'MRR: $0 — 0 suscripciones activas (getSuscripcion/suscripcion; valor real, no placeholder)'
    : c.mrrMxn === null
      ? `MRR: SIN CIFRA COMPLETA — ${numero(c.activas)} activas pero ${numero(c.activasSinPrecio)} sin precio configurado en su plan (Plan.precioMensual = null se lee de Stripe, no se inventa)`
      : `MRR: ${mxn(c.mrrMxn)} — ${numero(c.activas)} suscripciones activas × precio del plan (suscripcion + getPlanes)`;
  const churn = c.activas === 0
    ? 'Churn: SIN DATO — bajas/mes ÷ base activa; base activa = 0 (dividir entre cero no da 0%, no da nada)'
    : `Churn: se reportan bajas ABSOLUTAS con base < 10 clientes (base activa: ${numero(c.activas)})`;
  // Acepta partes históricos que aún traían aliases, pero el texto nuevo
  // siempre usa las 11 etapas canónicas y suma cerrado→won.
  const pipelineNormalizado = normalizarConteosProspecto(c.pipeline);
  const embudo = ESTADOS_PROSPECTO
    .map(({ valor: estado }) => `${estado} ${numero(pipelineNormalizado[estado])}`).join(' · ');
  const cerrados = pipelineNormalizado.won;
  return [
    `MÉTRICAS — semana del ${lunes}`,
    '',
    mrr,
    churn,
    `Conversión del pipeline: ${cerrados === 0 ? 'DESCONOCIDA — cero cerrados; es LA variable que manda' : `${numero(cerrados)} cerrados (absoluto; el % espera 20 cuentas trabajadas a desenlace)`}`,
    `Pipeline por estado: ${embudo}  (tabla prospecto, conteos en base)`,
    `Por cobrar: ${numero(c.porCobrar)} facturas · ${mxn(c.porCobrarMonto)} (getPorCobrar — factura_saas pendiente/fallida)`,
    '',
    `Plataforma: ${numero(c.conteos.liquidaciones)} liquidaciones · ${numero(c.conteos.operadores)} operadores · ${numero(c.conteos.usuarios)} usuarios (getConteosPlataforma, conteos en base)`,
    `Costo de IA histórico: ${usd(round2(c.costoIaUsd))} · viajes procesados: ${numero(c.viajesProcesados)} (getResumenNegocio)`,
    '',
    'LO QUE ESTE PARTE NO DICE: nada de aquí es una serie — son fotografías de hoy; la tendencia se lee comparando partes.',
    'Fuentes: las consultas nombradas del catálogo del blueprint agente-analista-de-metricas.md, cada una citada en su línea.',
  ].join('\n');
}

async function correrAnalistaMetricas(disparo: DisparoCorrida, hoy: string): Promise<ResultadoFinanciero> {
  const inicio = new Date();
  const agente = 'analista_metricas';
  const lunes = lunesDeSemana(hoy);
  const titulo = `Métricas — semana del ${lunes}`;
  try {
    if (await parteExistente(agente, titulo)) {
      await registrarCorrida(null, agente, {
        inicio, fin: new Date(), estado: 'ok', disparo, costoUsd: 0,
        resumen: { parte: 'ya_existia', titulo },
      });
      return { piezas: 0, motivo: 'el parte de esta semana ya está en la bandeja' };
    }

    const [activasFilas, planes, pipeline, conteos, r, porCobrar] = await Promise.all([
      leerSuscripcionesActivas(), getPlanes(), contarPipeline(), getConteosPlataforma(),
      getResumenNegocio(hoy), getPorCobrar(),
    ]);
    const precioPorPlan = new Map(planes.map((p) => [p.clave, p.precioMensual]));
    let mrr = 0; let sinPrecio = 0;
    for (const s of activasFilas) {
      const precio = precioPorPlan.get(s.plan_clave) ?? null;
      if (precio === null) sinPrecio += 1; else mrr += precio;
    }
    const cifras: CifrasMetricas = {
      activas: activasFilas.length,
      mrrMxn: sinPrecio > 0 ? null : round2(mrr),
      activasSinPrecio: sinPrecio,
      pipeline, conteos,
      costoIaUsd: r.costoIaUsd,
      viajesProcesados: r.viajesProcesados,
      porCobrar: porCobrar.length,
      porCobrarMonto: round2(porCobrar.reduce((s, f) => s + f.monto, 0)),
    };
    const res = await encolarParte(agente, 'parte_metricas', titulo, armarParteMetricas(cifras, lunes), {
      consultas: ['suscripcion', 'getPlanes', 'prospecto (conteos)', 'getConteosPlataforma', 'getResumenNegocio', 'getPorCobrar'],
    });
    await registrarCorrida(null, agente, {
      inicio, fin: new Date(), estado: 'ok', disparo, costoUsd: 0,
      tareasHechas: 1, tareasTotal: 1,
      resumen: { parte: res, activas: cifras.activas, porCobrar: cifras.porCobrar },
    });
    return { piezas: res === 'encolada' ? 1 : 0, motivo: res === 'ya_existia' ? 'otra corrida ganó el periodo' : undefined };
  } catch (e) {
    await registrarCorrida(null, agente, {
      inicio, fin: new Date(), estado: 'fallo', disparo, costoUsd: 0,
      error: `No se pudo armar el parte de métricas: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500),
    });
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TESORERÍA — el parte semanal de runway (agente-tesoreria.md)
// ═══════════════════════════════════════════════════════════════════════════

export interface CifrasTesoreria {
  cfg: ConfigFinanzas;
  hoy: string;
  cobradoMesMxn: number;
  porCobrar: number;
  porCobrarMonto: number;
  costoIaMesUsd: number;
}

export type SemaforoRunway = 'VERDE' | 'AMARILLO' | 'AMBAR' | 'ROJO' | 'SIN_SALDO';

export function semaforoDeRunway(meses: number): Exclude<SemaforoRunway, 'SIN_SALDO'> {
  if (meses < 3) return 'ROJO';
  if (meses < 6) return 'AMBAR';
  if (meses < 9) return 'AMARILLO';
  return 'VERDE';
}

/** El runway, PURO. La regla que lo hace honesto: sin saldo declarado NO hay
 *  runway (un runway sin saldo es un número inventado), y una quema sin
 *  fijos+costo de vida declarados es una quema incompleta y se dice. */
export function armarParteTesoreria(c: CifrasTesoreria, lunes: string): { cuerpo: string; semaforo: SemaforoRunway; runwayMeses: number | null } {
  const lineas: string[] = [`TESORERÍA — semana del ${lunes}`, ''];
  const { cfg } = c;

  // COGS del mes: IA real; a MXN solo con tipo de cambio DECLARADO.
  const cogsMxn = cfg.tipoCambioMxnUsd !== null ? round2(c.costoIaMesUsd * cfg.tipoCambioMxnUsd) : null;
  const cogsLinea = cogsMxn !== null
    ? `${mxn(cogsMxn)} (IA del mes ${usd(round2(c.costoIaMesUsd))} × ${cfg.tipoCambioMxnUsd} declarado)`
    : `${usd(round2(c.costoIaMesUsd))} de IA del mes — SIN tipo de cambio declarado (finanzas_config.tipo_cambio_mxn_usd), no se convierte a MXN`;

  let semaforo: SemaforoRunway = 'SIN_SALDO';
  let runwayMeses: number | null = null;

  if (cfg.saldoMxn === null || cfg.saldoFecha === null) {
    lineas.push('RUNWAY: SIN SALDO DECLARADO — no se calcula. Un runway sin saldo es un número inventado.');
    lineas.push('Declara saldo_mxn y saldo_fecha en finanzas_config (el agente jamás lee el banco: es diseño, no límite).');
  } else {
    const antiguedad = diasEntre(cfg.saldoFecha, c.hoy);
    if (antiguedad > 10) {
      lineas.push(`⚠ El saldo declarado tiene ${numero(antiguedad)} días (${cfg.saldoFecha}) — el runway de abajo carga esa vejez.`);
    }
    const quemaCompleta = cfg.fijosMxn !== null && cfg.costoVidaMxn !== null && cogsMxn !== null;
    if (!quemaCompleta) {
      const faltan = [
        cfg.fijosMxn === null ? 'fijos_mxn' : null,
        cfg.costoVidaMxn === null ? 'costo_vida_mxn' : null,
        cogsMxn === null ? 'tipo_cambio_mxn_usd' : null,
      ].filter(Boolean).join(', ');
      lineas.push(`RUNWAY: INCOMPLETO — la quema mensual no se puede armar sin: ${faltan} (finanzas_config).`);
      lineas.push(`Saldo declarado (${cfg.saldoFecha}): ${mxn(cfg.saldoMxn)}`);
    } else {
      const quema = round2((cfg.fijosMxn as number) + (cfg.costoVidaMxn as number) + (cogsMxn as number) - c.cobradoMesMxn);
      if (quema <= 0) {
        semaforo = 'VERDE';
        lineas.push(`El mes va en POSITIVO por ${mxn(-quema)} (cobrado ${mxn(c.cobradoMesMxn)} > salidas). No se declara «runway infinito»: `
          + 'el runway sobre promedio exige 3 meses de historia y la serie aún no existe — se lee comparando partes.');
      } else {
        runwayMeses = Math.round((cfg.saldoMxn / quema) * 10) / 10;
        semaforo = semaforoDeRunway(runwayMeses);
        lineas.push(`RUNWAY: ${runwayMeses} meses  [${semaforo}]`);
        lineas.push(`Saldo declarado (${cfg.saldoFecha}): ${mxn(cfg.saldoMxn)}`);
        lineas.push(`Quema mensual: ${mxn(quema)}  (fijos ${mxn(cfg.fijosMxn as number)} + vida ${mxn(cfg.costoVidaMxn as number)} + COGS ${mxn(cogsMxn as number)} − cobrado ${mxn(c.cobradoMesMxn)})`);
        lineas.push('El runway se calcula con el saldo declarado, NO con el por-cobrar: una factura emitida no es caja.');
      }
    }
  }

  lineas.push('');
  lineas.push(`ENTRA (emitido vivo, no caja): ${numero(c.porCobrar)} facturas · ${mxn(c.porCobrarMonto)} (getPorCobrar)`);
  lineas.push(`Cobrado del mes en curso: ${mxn(c.cobradoMesMxn)} (factura_saas pagada con pagada_en en el mes)`);
  lineas.push(`COGS del mes: ${cogsLinea}`);
  lineas.push('');
  lineas.push('Fuentes: finanzas_config (declarados) · getPorCobrar/factura_saas · costoIaMesActual (RPC 0062). Cortes del semáforo: propuesta del blueprint [DECISIÓN DE JAVIER].');
  return { cuerpo: lineas.join('\n'), semaforo, runwayMeses };
}

/** Facturas SaaS COBRADAS (pagada + pagada_en) dentro de la ventana; también
 *  cuenta las `pagada` SIN fecha — conciliación incompleta que el cierre
 *  lista aparte, jamás como cobrado. */
async function cobradoVentana(desdeIso: string, hastaIso: string): Promise<{ totalMxn: number; n: number; sinFecha: number; porTenant: Map<string, number> }> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('factura_saas')
    .select('tenant_id, monto, pagada_en')
    .eq('estado', 'pagada')
    .gte('pagada_en', desdeIso)
    .lt('pagada_en', hastaIso)
    // 1,000 mensualidades en una ventana de un mes son >80 años de un
    // cliente o >80 clientes — muy por encima de la escala actual; si algún
    // día se recorta, el conteo de abajo contra `length` lo delataría.
    .limit(1000), 'finanzas.cobrado');
  if (error) throw new Error(`cobradoVentana: ${error.message}`);
  const filas = (data ?? []) as Array<{ tenant_id: string; monto: unknown }>;
  const porTenant = new Map<string, number>();
  let total = 0;
  for (const f of filas) {
    const m = Number(f.monto);
    total += m;
    porTenant.set(f.tenant_id, (porTenant.get(f.tenant_id) ?? 0) + m);
  }
  const { count, error: errSinFecha } = await acotada(supabaseAdmin()
    .from('factura_saas')
    .select('id', { count: 'exact', head: true })
    .eq('estado', 'pagada')
    .is('pagada_en', null), 'finanzas.cobrado_sin_fecha');
  if (errSinFecha) throw new Error(`cobradoVentana(sin fecha): ${errSinFecha.message}`);
  return { totalMxn: round2(total), n: filas.length, sinFecha: typeof count === 'number' ? count : 0, porTenant };
}

async function correrTesoreria(disparo: DisparoCorrida, hoy: string): Promise<ResultadoFinanciero> {
  const inicio = new Date();
  const agente = 'tesoreria';
  const lunes = lunesDeSemana(hoy);
  const titulo = `Tesorería — semana del ${lunes}`;
  try {
    if (await parteExistente(agente, titulo)) {
      await registrarCorrida(null, agente, {
        inicio, fin: new Date(), estado: 'ok', disparo, costoUsd: 0,
        resumen: { parte: 'ya_existia', titulo },
      });
      return { piezas: 0, motivo: 'el parte de esta semana ya está en la bandeja' };
    }

    const mesInicio = new Date(`${hoy.slice(0, 7)}-01T00:00:00-06:00`).toISOString();
    const [cfg, porCobrar, costoMes, cobrado] = await Promise.all([
      leerConfigFinanzas(), getPorCobrar(), costoIaMesActual(),
      cobradoVentana(mesInicio, new Date().toISOString()),
    ]);
    const { cuerpo, semaforo, runwayMeses } = armarParteTesoreria({
      cfg, hoy,
      cobradoMesMxn: cobrado.totalMxn,
      porCobrar: porCobrar.length,
      porCobrarMonto: round2(porCobrar.reduce((s, f) => s + f.monto, 0)),
      costoIaMesUsd: costoMes.mesUsd,
    }, lunes);

    // El ROJO (< 3 meses) no espera al lunes ni a la bandeja (blueprint §5).
    if (semaforo === 'ROJO') {
      await alertarOperador('finanzas.tesoreria', {
        error: `Runway en ${runwayMeses} meses — por debajo del corte de decisión (3). El parte está en la bandeja.`,
        codigo: 'finanzas_runway_rojo',
      });
    }

    const res = await encolarParte(agente, 'parte_tesoreria', titulo, cuerpo, {
      semaforo, runwayMeses,
      consultas: ['finanzas_config', 'getPorCobrar', 'costoIaMesActual', 'factura_saas (cobrado del mes)'],
    });
    await registrarCorrida(null, agente, {
      inicio, fin: new Date(), estado: 'ok', disparo, costoUsd: 0,
      tareasHechas: 1, tareasTotal: 1,
      resumen: { parte: res, semaforo, runwayMeses },
    });
    return { piezas: res === 'encolada' ? 1 : 0, motivo: res === 'ya_existia' ? 'otra corrida ganó el periodo' : undefined };
  } catch (e) {
    await registrarCorrida(null, agente, {
      inicio, fin: new Date(), estado: 'fallo', disparo, costoUsd: 0,
      error: `No se pudo armar el parte de tesorería: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500),
    });
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CIERRE MENSUAL — el mes anterior, en cinco bloques (agente-cierre-mensual.md)
// ═══════════════════════════════════════════════════════════════════════════

/** El cierre corre desde el día 3 del mes (aprox. en día CALENDARIO del «día
 *  hábil 3» del blueprint — la aproximación se declara aquí y en el parte:
 *  antes del 3, una transferencia del último día del mes aún no concilia). */
export function tocaCerrar(hoy: string): boolean {
  return Number(hoy.slice(8, 10)) >= 3;
}

export interface CifrasCierre {
  mes: string; // 'YYYY-MM'
  cobradoMxn: number;
  cobradasN: number;
  pagadasSinFecha: number;
  pendientes: number;
  pendientesMonto: number;
  costoIaMesUsd: number;
  llamadasIa: number;
  porFase: Array<{ fase: string; n: number; costoUsd: number }>;
  porTenant: Array<{ nombre: string; costoUsd: number; cobradoMxn: number }>;
  fijosMxn: number | null;
  tipoCambio: number | null;
}

export function armarCierreMensual(c: CifrasCierre): string {
  const noCerrado: string[] = [];
  if (c.pagadasSinFecha > 0) noCerrado.push(`${numero(c.pagadasSinFecha)} facturas marcadas pagadas SIN pagada_en — conciliación incompleta; no cuentan como cobrado`);
  if (c.fijosMxn === null) noCerrado.push('costos fijos sin declarar (finanzas_config.fijos_mxn) — el neto sale sin ellos');
  if (c.tipoCambio === null) noCerrado.push('tipo de cambio sin declarar — el COGS queda en USD, sin fundir con el cobrado MXN');

  const cogsMxn = c.tipoCambio !== null ? round2(c.costoIaMesUsd * c.tipoCambio) : null;
  const neto = cogsMxn !== null && c.fijosMxn !== null
    ? `${mxn(round2(c.cobradoMxn - cogsMxn - c.fijosMxn))}  (cobrado ${mxn(c.cobradoMxn)} − COGS ${mxn(cogsMxn)} − fijos ${mxn(c.fijosMxn)})`
    : 'NO SE PUEDE ARMAR — ver «no se pudo cerrar»';

  const flotas = c.porTenant.length === 0
    ? '  (sin flotas con actividad en el mes)'
    : c.porTenant.map((t) => {
      const etiqueta = t.cobradoMxn === 0 && t.costoUsd > 0 ? '  [piloto/demo — cobrado $0]' : '';
      return `  ${t.nombre}: cobrado ${mxn(t.cobradoMxn)} · IA ${usd(round2(t.costoUsd))} (real, RPC por tenant)${etiqueta}`;
    }).join('\n');

  return [
    `CIERRE — ${c.mes}`,
    '',
    '1 · INGRESOS COBRADOS (no facturados)',
    `  Mensualidades cobradas: ${numero(c.cobradasN)} facturas · ${mxn(c.cobradoMxn)}`,
    `  Emitidas y NO cobradas al cierre: ${numero(c.pendientes)} · ${mxn(c.pendientesMonto)}`,
    '',
    '2 · COGS DEL MES',
    `  IA: ${usd(round2(c.costoIaMesUsd))} en ${numero(c.llamadasIa)} llamadas (resumen_costo_ia acotado al mes)`,
    `  Por fase: ${c.porFase.length ? c.porFase.map((f) => `${f.fase} ${usd(round2(f.costoUsd))}`).join(' · ') : 'sin llamadas'}`,
    '  WhatsApp por flota: NO SE PRORRATEA — wa_mensaje_procesado no tiene tenant_id; la fase whatsapp de arriba es el global y así se declara.',
    '',
    '3 · MARGEN POR CLIENTE (con < 3 clientes se reportan clientes, no promedio)',
    flotas,
    '  La infra fija NO se reparte entre clientes: va al cierre global, no al margen unitario.',
    '',
    '4 · COMISIONES: NO SE DEVENGAN — el esquema (50% primer mes / 20% recurrente) sigue pendiente de firma [DECISIÓN DE JAVIER].',
    '',
    '5 · NETO DEL MES',
    `  ${neto}`,
    '',
    'BORRADOR DEL UPDATE (lo malo primero; Javier lo edita y lo manda — nunca sale solo):',
    `  TL;DR: mes cerrado con ${mxn(c.cobradoMxn)} cobrados y ${usd(round2(c.costoIaMesUsd))} de IA. [Javier completa]`,
    '  MÉTRICAS: las del parte de métricas de la semana. LO QUE SE CONSTRUYÓ / APRENDIMOS / VIENE / ASKS: [Javier completa]',
    '',
    `NO SE PUDO CERRAR${noCerrado.length ? ':' : ': nada — lista vacía (y se dice igual).'}`,
    ...noCerrado.map((x) => `  · ${x}`),
    '',
    'Nota: «día 3» es día CALENDARIO (aproximación declarada del día hábil 3 del blueprint).',
    'Fuentes: factura_saas (cobrado del mes) · resumen_costo_ia con ventana (0062) · getPorCobrar · finanzas_config.',
  ].join('\n');
}

async function correrCierreMensual(disparo: DisparoCorrida, hoy: string): Promise<ResultadoFinanciero> {
  const inicio = new Date();
  const agente = 'cierre_mensual';
  if (!tocaCerrar(hoy)) {
    // No es un fallo ni amerita corrida: antes del día 3 el cierre está
    // incompleto por construcción (blueprint: la transferencia del último
    // día concilia en los primeros del siguiente).
    return { piezas: 0, motivo: 'antes del día 3 el cierre está incompleto por construcción' };
  }
  const mes = mesAnterior(hoy);
  const titulo = `Cierre — ${mes}`;
  try {
    if (await parteExistente(agente, titulo)) {
      await registrarCorrida(null, agente, {
        inicio, fin: new Date(), estado: 'ok', disparo, costoUsd: 0,
        resumen: { parte: 'ya_existia', titulo },
      });
      return { piezas: 0, motivo: `el cierre de ${mes} ya está en la bandeja` };
    }

    const desde = new Date(`${mes}-01T00:00:00-06:00`).toISOString();
    const hasta = new Date(`${hoy.slice(0, 7)}-01T00:00:00-06:00`).toISOString();
    const [cfg, cobrado, costo, porCobrar] = await Promise.all([
      leerConfigFinanzas(), cobradoVentana(desde, hasta), costoIaVentana(desde, hasta), getPorCobrar(),
    ]);

    // Nombres de flota para el margen por cliente — cortesía de lectura; si
    // esta consulta falla, el cierre entero falla (el margen sin saber de
    // quién es no cierra nada).
    const tenantIds = [...new Set([...costo.porTenant.map((t) => t.tenantId), ...cobrado.porTenant.keys()])];
    const nombres = new Map<string, string>();
    if (tenantIds.length > 0) {
      const { data, error } = await acotada(supabaseAdmin()
        .from('tenant').select('id, nombre').in('id', tenantIds), 'finanzas.tenants');
      if (error) throw new Error(`cierre.tenants: ${error.message}`);
      for (const t of (data ?? []) as Array<{ id: string; nombre: string }>) nombres.set(t.id, t.nombre);
    }
    const costoPorTenant = new Map(costo.porTenant.map((t) => [t.tenantId, t.costoUsd]));
    const porTenant = tenantIds.map((id) => ({
      nombre: nombres.get(id) ?? id.slice(0, 8),
      costoUsd: costoPorTenant.get(id) ?? 0,
      cobradoMxn: round2(cobrado.porTenant.get(id) ?? 0),
    })).sort((a, b) => b.cobradoMxn - a.cobradoMxn);

    const cuerpo = armarCierreMensual({
      mes,
      cobradoMxn: cobrado.totalMxn,
      cobradasN: cobrado.n,
      pagadasSinFecha: cobrado.sinFecha,
      pendientes: porCobrar.length,
      pendientesMonto: round2(porCobrar.reduce((s, f) => s + f.monto, 0)),
      costoIaMesUsd: costo.totales.costoUsd,
      llamadasIa: costo.totales.n,
      porFase: costo.porFase,
      porTenant,
      fijosMxn: cfg.fijosMxn,
      tipoCambio: cfg.tipoCambioMxnUsd,
    });
    const res = await encolarParte(agente, 'cierre_mensual', titulo, cuerpo, {
      mes, consultas: ['factura_saas', 'resumen_costo_ia (ventana)', 'getPorCobrar', 'finanzas_config', 'tenant'],
    });
    await registrarCorrida(null, agente, {
      inicio, fin: new Date(), estado: 'ok', disparo, costoUsd: 0,
      tareasHechas: 1, tareasTotal: 1,
      resumen: { parte: res, mes, cobradoMxn: cobrado.totalMxn, iaUsd: round2(costo.totales.costoUsd) },
    });
    return { piezas: res === 'encolada' ? 1 : 0, motivo: res === 'ya_existia' ? 'otra corrida ganó el periodo' : undefined };
  } catch (e) {
    await registrarCorrida(null, agente, {
      inicio, fin: new Date(), estado: 'fallo', disparo, costoUsd: 0,
      error: `No se pudo armar el cierre de ${mes}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500),
    });
    throw e;
  }
}

// ── El despacho que el runner llama ────────────────────────────────────────

export async function correrAgenteFinanciero(
  id: AgenteFinanciero,
  disparo: DisparoCorrida,
  hoy: string = hoyMx(),
): Promise<ResultadoFinanciero> {
  logger.info('finanzas.corrida', { agente: id, disparo });
  switch (id) {
    case 'control_costos': return correrControlCostos(disparo, hoy);
    case 'analista_metricas': return correrAnalistaMetricas(disparo, hoy);
    case 'tesoreria': return correrTesoreria(disparo, hoy);
    case 'cierre_mensual': return correrCierreMensual(disparo, hoy);
  }
}
