// ═══════════════════════════════════════════════════════════════════════════
// EL BACK OFFICE RESTANTE (0219) — los cuatro que quedaban en 'disenado':
//
//   · vigilante_calidad — audita a los OTROS agentes con datos reales.
//   · documentacion     — el drift del catálogo vivo contra lo ya registrado.
//   · legal_compliance  — los relojes legales de LIKIDA-empresa.
//   · talento           — el registro de vacantes y la criba, cableada.
//
// LAS REGLAS QUE GOBIERNAN EL ARCHIVO ENTERO:
//
//  1. CERO LLM. Igual que los financieros (0215) y la dirección (0216): las
//     reglas calculan Y redactan con plantilla fija. Un agente que audita a
//     otros agentes no puede permitirse alucinar el hallazgo que acusa; el
//     modo más barato de no inventarlo es no tener quién lo invente.
//     (`presupuesto_dia_usd` se declara igual: el candado 3 del runner lo
//     exige, y el día que alguno redacte con modelo el freno ya está puesto.)
//  2. NULL ≠ 0. Un `costo_usd` nulo es «esta corrida no midió su gasto», no
//     «gastó cero»: se excluye del promedio y el parte dice cuántas quedaron
//     fuera. Un conteo que PostgREST no devolvió no es un cero.
//  3. FAIL-CLOSED Y DICHO. Cada lectura del parte legal va POR VALOR
//     (`Lectura<T>`): una fuente ciega se escribe «no se pudo leer», jamás se
//     colapsa a «no hay nada». En los motores de una sola fuente (calidad,
//     documentación) el fallo tumba la corrida y queda anotado como `fallo` —
//     un parte de calidad sobre una bitácora ilegible diría «nadie falló».
//  4. EL HUMANO DECIDE. Ninguno de los cuatro apaga un agente, descarta a un
//     candidato, firma un documento ni le contesta a una autoridad. Miden,
//     citan la evidencia y dejan la pieza en la bandeja.
//  5. IDEMPOTENCIA POR CONSTRAINT. Un parte por (agente, periodo): el título
//     es determinista y el árbitro es el índice único parcial
//     `cola_parte_backoffice_por_periodo` (0219), no un `if` (estándar §7).
//
// LO QUE ESTE ARCHIVO NO HACE, A PROPÓSITO: el vigilante NO re-audita código
// (eso es del auditor de código, departamento de ingeniería) y el de
// documentación NO lee el paquete de blueprints en el Escritorio de Javier —
// mide el catálogo VIVO (`agente_definicion`) contra lo que él mismo registró
// la vez pasada, que es la única fuente que el runner puede leer de verdad.
// ═══════════════════════════════════════════════════════════════════════════
import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { acotada } from '../presupuesto';
import { traerTodo } from '../pg';
import { hoyMx, usd, numero, round2 } from '@/lib/formato';
import { appUrl } from '@/lib/env';
import { estadoLegalProduccion } from '@/lib/legal/config';
import { alertarOperador } from '@/lib/observability/alerta';
import { encolarPieza } from './cola';
import { registrarCorrida, type DisparoCorrida } from './corridas';
import { logger } from '@/lib/logger';

export const AGENTES_BACK_OFFICE = ['vigilante_calidad', 'documentacion', 'legal_compliance', 'talento'] as const;
export type AgenteBackOffice = (typeof AGENTES_BACK_OFFICE)[number];

export function esAgenteBackOffice(id: string): id is AgenteBackOffice {
  return (AGENTES_BACK_OFFICE as readonly string[]).includes(id);
}

/** Lo que una corrida de back office le reporta al runner. */
export interface ResultadoBackOffice {
  /** Piezas fabricadas hacia la bandeja (0 o 1 — un parte por periodo). */
  piezas: number;
  /** Por qué no se fabricó, cuando piezas = 0 y no es un fallo. */
  motivo?: string;
  /** EL RELOJ DE LA VUELTA se agotó a media faena y quedó trabajo sin hacer.
   *  No es fallo ni es «no había nada»: es la tercera cosa. El runner la sube a
   *  `saltadosPorReloj` (regla de la #152) y por eso el latido dice `'parcial'`
   *  en vez de `'ok'` — que es toda la diferencia entre enterarse y no. */
  sinTurno?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// EL RELOJ DE LA VUELTA — Y POR QUÉ AQUÍ TAMPOCO SE LLAMA `venceEn`
// (auditoría ciclo 7, c7-1).
//
// Mismo choque de nombres que en `exito.ts`, con otra tabla: en este módulo
// `venceEn` YA SIGNIFICA la fecha límite legal de una SOLICITUD ARCO
// (`solicitud_arco.vence_en`, 0053) — los 20 días hábiles que la LFPDPPP le da
// a la empresa para contestarle a un titular. Es un plazo de CALENDARIO, en
// días, y con consecuencias legales.
//
// Lo que este archivo no tenía es el otro reloj: el presupuesto de tiempo de
// ESTA INVOCACIÓN de Vercel, un epoch en milisegundos que se apaga a los
// ~270 s. Para que nadie los mezcle se llama `venceEnVuelta`. Poner un
// `venceEn: number` al lado de un `venceEn: string` que significa un plazo
// legal es sembrar el bug para el siguiente que toque el archivo.
//
// Los dos incidentes que lo justifican: 25-ago-2026 («Sin latido: runner hace
// 286 min») y 28-ago-2026 00:03 UTC (32 corridas, todas en `ok`, y ni un
// latido escrito). En los dos, un motor que iteraba por dentro entró UNA vez
// por la puerta del reloj del despacho y no volvió a mirarlo.
//
// Se redefine aquí en vez de importarlo de `runner.ts` por lo mismo que en
// `direccion.ts` y `leads.ts` (#158): el runner carga este módulo por import
// dinámico justo para no arrastrarlo en cada vuelta, y un import de vuelta
// cerraría el ciclo.
// ═══════════════════════════════════════════════════════════════════════════
function relojAgotado(venceEnVuelta: number | undefined): boolean {
  return venceEnVuelta !== undefined && Date.now() >= venceEnVuelta;
}

// ── Aritmética de fechas (UTC pura; el día de México lo da `hoyMx`) ────────
//
// Se define aquí y no se importa de finanzas.ts/reportes.ts a propósito: esos
// dos módulos arrastran los lectores de /admin y de facturación, y el runner
// los carga por import dinámico justo para no pagarlos en cada vuelta. Cuatro
// líneas de aritmética no justifican arrastrar el árbol entero.

/** El lunes de la semana de `dia` ('YYYY-MM-DD'). */
export function lunesDe(dia: string): string {
  const d = new Date(`${dia}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** `dia` desplazado `n` días (n negativo = hacia atrás). */
export function masDias(dia: string, n: number): string {
  const d = new Date(`${dia}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Días calendario entre dos fechas ISO 'YYYY-MM-DD' (b − a). */
export function diasEntre(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** El instante ISO del inicio del día de México de `dia` (offset fijo −06:00,
 *  el mismo criterio que el resto del repo: México ya no cambia de horario). */
function inicioDia(dia: string): string {
  return new Date(`${dia}T00:00:00-06:00`).toISOString();
}

// ── La pieza hacia la bandeja, con su idempotencia por constraint ──────────

/** ¿Ya existe el parte de este periodo (cualquier estado)? LANZA si no se
 *  puede saber: sin poder verificar, no se fabrica (fail closed). */
async function parteExistente(agente: AgenteBackOffice, titulo: string): Promise<boolean> {
  const { count, error } = await acotada(supabaseAdmin()
    .from('cola_aprobacion')
    .select('id', { count: 'exact', head: true })
    .eq('agente', agente)
    .eq('titulo', titulo), 'backoffice.parte_existente');
  if (error) throw new Error(`parteExistente(${agente}): ${error.message}`);
  if (typeof count !== 'number') throw new Error(`parteExistente(${agente}): PostgREST no devolvió el conteo — no se afirma un 0 que nadie midió.`);
  return count > 0;
}

/** Encola el parte. El índice único parcial de la 0219 es el árbitro real: si
 *  otra corrida ganó la carrera del mismo periodo, el duplicado rebota y se
 *  trata como «ya existía», no como fallo. */
async function encolarParte(
  agente: AgenteBackOffice, tipo: string, titulo: string, cuerpo: string,
  fuentes: Record<string, unknown>,
): Promise<'encolada' | 'ya_existia'> {
  try {
    await encolarPieza({ tipo, prioridad: 'normal', agente, titulo, cuerpo, fuentes });
    return 'encolada';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('duplicate key') || msg.includes('cola_parte_backoffice_por_periodo')) return 'ya_existia';
    throw e;
  }
}

/** Registra la corrida — `registrarCorrida` jamás lanza (contrato 0102). */
async function anotar(
  agente: AgenteBackOffice, inicio: Date, estado: 'ok' | 'fallo', disparo: DisparoCorrida,
  resumen: Record<string, unknown>, extra?: { tareasHechas: number; tareasTotal: number; error?: string },
): Promise<void> {
  await registrarCorrida(null, agente, {
    inicio, fin: new Date(), estado, disparo, costoUsd: 0,
    ...(extra?.tareasHechas !== undefined ? { tareasHechas: extra.tareasHechas, tareasTotal: extra.tareasTotal } : {}),
    resumen,
    ...(extra?.error ? { error: extra.error } : {}),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · VIGILANTE DE CALIDAD — audita a los otros agentes con datos REALES.
//
// La ventana es la SEMANA CERRADA (los 7 días anteriores al lunes en curso):
// auditar la semana a medio correr produciría hallazgos que se desmienten
// solos el jueves. El título ancla el periodo auditado, así que la semana
// tiene exactamente un parte lo fabrique la pasada del runner que lo fabrique.
// ═══════════════════════════════════════════════════════════════════════════

export interface CorridaAuditada {
  agente: string;
  estado: 'ok' | 'parcial' | 'fallo';
  inicio: string;
  tareasHechas: number | null;
  tareasTotal: number | null;
  /** `null` = la corrida no midió su gasto. JAMÁS se lee como 0. */
  costoUsd: number | null;
  error: string | null;
}

export interface PiezaResuelta {
  agente: string;
  estado: 'aprobado' | 'rechazado';
  titulo: string;
  motivoRechazo: string | null;
}

/** El costo por corrida de un agente en su propia historia previa (la vara
 *  contra la que se compara la semana). `n` = corridas CON costo medido. */
export interface BaseCosto { agente: string; promedioUsd: number; n: number }

export type SemaforoHallazgo = 'ROJO' | 'AMBAR' | 'NOTA';

export interface HallazgoCalidad {
  semaforo: SemaforoHallazgo;
  /** V1 fallos · V2 verde vacío · V3 costo anómalo · V4 rechazo humano. */
  codigo: 'V1' | 'V2' | 'V3' | 'V4' | 'V0';
  agente: string;
  detalle: string;
  /** La cita: números y fechas de las filas que lo sostienen. */
  evidencia: string;
}

/** Corridas mínimas de la historia previa para que su promedio sea una vara y
 *  no una anécdota (el mismo criterio del piso de U2 en 0215). */
const MIN_BASE_COSTO = 5;
/** Cuántas veces su propia media dispara V3. */
const FACTOR_COSTO_ANOMALO = 2;
/** Piso de dinero de V3: gritar por un salto de $0.004 a $0.01 es ruido. */
const PISO_COSTO_SEMANA_USD = 0.5;
/** Resoluciones mínimas para que una TASA de rechazo signifique algo. */
const MIN_RESUELTAS_TASA = 3;

function recortar(t: string | null, n: number): string {
  const s = (t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Los cuatro detectores del vigilante, PUROS sobre filas ya leídas. Cada
 * hallazgo sale con su evidencia — un hallazgo sin cita es una opinión, y de
 * opiniones ya hay bastantes.
 */
export function evaluarCalidad(
  corridas: CorridaAuditada[],
  base: BaseCosto[],
  piezas: PiezaResuelta[],
): HallazgoCalidad[] {
  const hallazgos: HallazgoCalidad[] = [];

  if (corridas.length === 0 && piezas.length === 0) {
    // El silencio ES el hallazgo: o nadie corrió, o la bitácora no guardó lo
    // que corrió. Las dos posibilidades se nombran; no se elige la cómoda.
    hallazgos.push({
      semaforo: 'AMBAR', codigo: 'V0', agente: '(toda la compañía agente)',
      detalle: 'ninguna corrida y ninguna pieza resuelta en la ventana auditada.',
      evidencia: 'agente_corrida y cola_aprobacion contestaron, y vinieron vacías: o nadie corrió, o lo que corrió no dejó rastro. Las dos cosas son noticia.',
    });
  }

  const porAgente = new Map<string, CorridaAuditada[]>();
  for (const c of corridas) {
    const lista = porAgente.get(c.agente) ?? [];
    lista.push(c);
    porAgente.set(c.agente, lista);
  }
  const baseporAgente = new Map(base.map((b) => [b.agente, b]));

  for (const agente of [...porAgente.keys()].sort()) {
    const lista = porAgente.get(agente) as CorridaAuditada[];

    // V1 — TASA DE FALLO. Absolutos siempre; la tasa solo como contexto.
    const fallos = lista.filter((c) => c.estado === 'fallo');
    if (fallos.length > 0) {
      const tasa = fallos.length / lista.length;
      const primero = fallos[fallos.length - 1];
      hallazgos.push({
        semaforo: tasa >= 0.5 && lista.length >= 2 ? 'ROJO' : 'AMBAR',
        codigo: 'V1', agente,
        detalle: `${numero(fallos.length)} de ${numero(lista.length)} corrida(s) terminaron en fallo.`,
        evidencia: `la más antigua de la ventana: ${primero.inicio.slice(0, 10)} — «${recortar(primero.error, 160) || 'sin texto de error anotado'}».`,
      });
    }

    // V2 — VERDE VACÍO: dijo ok y no hizo nada de lo que se propuso. Es LA
    // lección de las ~216 corridas verdes con el motor roto; por eso es ROJO
    // aunque no haya un solo fallo en la ventana.
    const vacias = lista.filter((c) => c.estado === 'ok' && c.tareasHechas === 0 && (c.tareasTotal ?? 0) > 0);
    if (vacias.length > 0) {
      hallazgos.push({
        semaforo: 'ROJO', codigo: 'V2', agente,
        detalle: `${numero(vacias.length)} corrida(s) VERDE VACÍO: dijeron ok y produjeron 0 tareas de las que se propusieron.`,
        evidencia: `fechas: ${vacias.slice(0, 3).map((c) => `${c.inicio.slice(0, 10)} (0 de ${c.tareasTotal})`).join(' · ')}${vacias.length > 3 ? ` y ${numero(vacias.length - 3)} más` : ''}.`,
      });
    }

    // V3 — COSTO POR CORRIDA CONTRA SU PROPIA HISTORIA. Nunca contra el de
    // otro agente: un investigador cuesta órdenes de magnitud más que un
    // reportero determinista, y compararlos no diría nada.
    const conCosto = lista.filter((c) => c.costoUsd !== null) as Array<CorridaAuditada & { costoUsd: number }>;
    const sinCosto = lista.length - conCosto.length;
    const vara = baseporAgente.get(agente);
    if (conCosto.length > 0 && vara && vara.n >= MIN_BASE_COSTO && vara.promedioUsd > 0) {
      const gastoSemana = conCosto.reduce((s, c) => s + c.costoUsd, 0);
      const promSemana = gastoSemana / conCosto.length;
      if (promSemana >= vara.promedioUsd * FACTOR_COSTO_ANOMALO && gastoSemana >= PISO_COSTO_SEMANA_USD) {
        hallazgos.push({
          semaforo: 'AMBAR', codigo: 'V3', agente,
          detalle: `el costo por corrida se multiplicó por ${(promSemana / vara.promedioUsd).toFixed(1)} contra su propia historia.`,
          evidencia: `${usd(round2(promSemana))}/corrida esta ventana (${numero(conCosto.length)} corridas con costo medido, ${usd(round2(gastoSemana))} en total) contra ${usd(round2(vara.promedioUsd))}/corrida en su historia previa (${numero(vara.n)} corridas medidas).`,
        });
      }
    }
    // LA NOTA SALE AUNQUE NINGUNA CORRIDA HAYA MEDIDO (c6-12). El `&&
    // conCosto.length > 0` de antes callaba justo el caso peor: un agente que
    // dejó de anotar su gasto POR COMPLETO desaparecía de esta nota y el
    // parte no decía nada — se leía como «sin novedad en costos», que es
    // exactamente la lectura falsa que NULL ≠ 0 existe para impedir.
    if (sinCosto > 0) {
      hallazgos.push({
        semaforo: 'NOTA', codigo: 'V3', agente,
        detalle: `${numero(sinCosto)} de ${numero(lista.length)} corrida(s) no anotaron costo.`,
        evidencia: conCosto.length === 0
          ? 'NINGUNA corrida de este agente midió su gasto en la ventana: no hay costo por corrida que comparar contra su historia. costo_usd NULL es «no se midió», NUNCA $0 — este parte no afirma que no gastó.'
          : 'costo_usd NULL se excluye del promedio; NO se cuenta como $0 — el costo por corrida de arriba se calcula solo sobre las medidas.',
      });
    }
  }

  // V4 — LO QUE EL HUMANO RECHAZÓ. Es la única señal de calidad que no sale
  // del propio agente: alguien miró la pieza y dijo que no.
  const porProductor = new Map<string, PiezaResuelta[]>();
  for (const p of piezas) {
    const lista = porProductor.get(p.agente) ?? [];
    lista.push(p);
    porProductor.set(p.agente, lista);
  }
  for (const agente of [...porProductor.keys()].sort()) {
    const lista = porProductor.get(agente) as PiezaResuelta[];
    const rechazadas = lista.filter((p) => p.estado === 'rechazado');
    if (rechazadas.length === 0) continue;
    const tasaSignificativa = lista.length >= MIN_RESUELTAS_TASA && rechazadas.length / lista.length >= 0.5;
    const motivos = rechazadas.slice(0, 2)
      .map((p) => `«${recortar(p.titulo, 60)}»: ${recortar(p.motivoRechazo, 120) || 'sin motivo anotado'}`)
      .join(' · ');
    hallazgos.push({
      semaforo: rechazadas.length >= 3 || tasaSignificativa ? 'ROJO' : 'AMBAR',
      codigo: 'V4', agente,
      detalle: `${numero(rechazadas.length)} de ${numero(lista.length)} pieza(s) resueltas fueron RECHAZADAS por un humano.`,
      evidencia: `${motivos}${rechazadas.length > 2 ? ` (y ${numero(rechazadas.length - 2)} rechazo(s) más)` : ''}.`,
    });
  }

  return hallazgos;
}

/** El parte de calidad, PURO. Sin hallazgos es corto a propósito: media
 *  página para decir «todo bien» enseña a no leerlo. */
/** Corridas que UNA ventana de auditoría lee como máximo. Si se llena, el
 *  parte lo DICE (c6-12): un parte de calidad sobre una ventana recortada en
 *  silencio afirma «nadie falló» sobre las corridas que sí leyó y calla las
 *  que no miró — y las que no miró son, por el `order` descendente, las más
 *  viejas de la semana. */
export const TOPE_CORRIDAS_AUDITADAS = 5000;

export function armarParteCalidad(
  hallazgos: HallazgoCalidad[], desde: string, hasta: string,
  corridas: number, agentes: number, piezas: number,
  truncado = false,
): string {
  const rojos = hallazgos.filter((h) => h.semaforo === 'ROJO');
  const ambar = hallazgos.filter((h) => h.semaforo === 'AMBAR');
  const lineas = [
    `CALIDAD — semana del ${desde} (ventana auditada: ${desde} a ${hasta}, cerrada)`,
    '',
    `Auditados: ${numero(agentes)} agente(s) con corrida · ${numero(corridas)} corrida(s) · ${numero(piezas)} pieza(s) resueltas por un humano.`,
    `Hallazgos: ${numero(rojos.length)} ROJO · ${numero(ambar.length)} ÁMBAR · ${numero(hallazgos.length - rojos.length - ambar.length)} nota(s).`,
    '',
  ];
  if (truncado) {
    lineas.push(`VENTANA TRUNCADA A ${numero(TOPE_CORRIDAS_AUDITADAS)} CORRIDAS: la semana tuvo más de las que este parte alcanzó a leer, y las que faltan son las MÁS VIEJAS de la ventana (se lee en orden descendente). Todo lo de abajo se afirma sobre las ${numero(corridas)} leídas — un fallo, un verde vacío o un rechazo que viva en las no leídas NO aparece aquí.`);
    lineas.push('');
  }
  if (hallazgos.length === 0) {
    lineas.push('Nada disparó umbral: ningún fallo, ningún verde vacío, ningún costo fuera de su propia banda y ningún rechazo humano en la ventana.');
  } else {
    for (const h of hallazgos) {
      lineas.push(`[${h.semaforo}]  ${h.codigo} · ${h.agente} — ${h.detalle}`);
      lineas.push(`         evidencia: ${h.evidencia}`);
    }
  }
  lineas.push('');
  lineas.push('LO QUE ESTE PARTE NO AUDITA: el código. Los hallazgos de código (deps, secretos, IDOR, deuda) son del auditor de código y del agente de seguridad, departamento de ingeniería — este vigilante mira la CONDUCTA de los agentes en producción, no sus fuentes.');
  lineas.push('LO QUE ESTE PARTE NO DICE: un agente sin corridas en la ventana no aparece aquí; «no corrió» lo detecta el orquestador (0216, sección 2) contra la lista de habilitados del runner.');
  lineas.push('Fuentes: agente_corrida (ventana + historia previa de 28 días para la vara de costo) · cola_aprobacion (piezas resueltas en la ventana).');
  return lineas.join('\n');
}

/** Las corridas de una ventana. LANZA si la bitácora no se puede leer: un
 *  parte de calidad sobre una bitácora ciega afirmaría «nadie falló». */
async function leerCorridas(desdeIso: string, hastaIso: string): Promise<{ corridas: CorridaAuditada[]; truncado: boolean }> {
  const { data, error, count } = await acotada(supabaseAdmin()
    .from('agente_corrida')
    // `count: 'exact'` y no un `length === tope`: PostgREST recorta a
    // `max_rows` sin avisar (la lección ESC-8 de proveedores.ts), así que
    // comparar el largo contra el `.limit()` no detecta NADA. El total real
    // viene en la misma respuesta y no cuesta un viaje extra.
    .select('agente, estado, inicio, tareas_hechas, tareas_total, costo_usd, error', { count: 'exact' })
    .gte('inicio', desdeIso)
    .lt('inicio', hastaIso)
    .order('inicio', { ascending: false })
    .limit(TOPE_CORRIDAS_AUDITADAS), 'backoffice.calidad_corridas');
  if (error) throw new Error(`leerCorridas: ${error.message}`);
  const filas = (data ?? []) as Array<Record<string, unknown>>;
  // Sin `count` no se puede afirmar que esté completa: se declara truncada si
  // el lote llegó lleno. No saber nunca se lee como "sí, está todo".
  const truncado = typeof count === 'number' ? count > filas.length : filas.length >= TOPE_CORRIDAS_AUDITADAS;
  const corridas = filas.map((f) => ({
    agente: String(f.agente),
    estado: f.estado as CorridaAuditada['estado'],
    inicio: String(f.inicio),
    tareasHechas: f.tareas_hechas === null || f.tareas_hechas === undefined ? null : Number(f.tareas_hechas),
    tareasTotal: f.tareas_total === null || f.tareas_total === undefined ? null : Number(f.tareas_total),
    costoUsd: f.costo_usd === null || f.costo_usd === undefined ? null : Number(f.costo_usd),
    error: (f.error as string | null) ?? null,
  })) as CorridaAuditada[];
  return { corridas, truncado };
}

/** La vara: costo por corrida de cada agente en los 28 días ANTERIORES a la
 *  ventana. Solo corridas con costo medido — las nulas no promedian. */
async function leerBaseCosto(desdeIso: string, hastaIso: string): Promise<BaseCosto[]> {
  const admin = supabaseAdmin();
  // CAP-2 (re-auditoría 25, MEDIO): `.limit(5000)` recortaba en silencio a los
  // 1,000 que PostgREST entrega por default — `traerTodo` pagina y LANZA en
  // vez de devolver una base de costo truncada.
  const data = await traerTodo<{ agente: string; costo_usd: unknown }>(
    (d, h) => acotada(admin.from('agente_corrida')
      .select('agente, costo_usd')
      .not('costo_usd', 'is', null)
      .gte('inicio', desdeIso)
      .lt('inicio', hastaIso)
      .order('id')
      .range(d, h), 'backoffice.calidad_base'),
    'backoffice.calidad_base',
  );
  const acc = new Map<string, { suma: number; n: number }>();
  for (const f of data) {
    const a = acc.get(f.agente) ?? { suma: 0, n: 0 };
    a.suma += Number(f.costo_usd);
    a.n += 1;
    acc.set(f.agente, a);
  }
  return [...acc.entries()].map(([agente, a]) => ({ agente, promedioUsd: a.suma / a.n, n: a.n }));
}

/** Las piezas que un humano resolvió en la ventana. LANZA si no se leen. */
async function leerPiezasResueltas(desdeIso: string, hastaIso: string): Promise<PiezaResuelta[]> {
  const admin = supabaseAdmin();
  // CAP-2 (re-auditoría 25, MEDIO): `.limit(2000)` recortaba en silencio a los
  // 1,000 que PostgREST entrega por default.
  const data = await traerTodo<Record<string, unknown>>(
    (d, h) => acotada(admin.from('cola_aprobacion')
      .select('agente, estado, titulo, motivo_rechazo')
      .neq('estado', 'pendiente')
      .gte('resuelto_en', desdeIso)
      .lt('resuelto_en', hastaIso)
      .order('id')
      .range(d, h), 'backoffice.calidad_piezas'),
    'backoffice.calidad_piezas',
  );
  return data.map((f) => ({
    agente: String(f.agente),
    estado: f.estado as PiezaResuelta['estado'],
    titulo: String(f.titulo ?? ''),
    motivoRechazo: (f.motivo_rechazo as string | null) ?? null,
  }));
}

async function correrVigilanteCalidad(disparo: DisparoCorrida, hoy: string): Promise<ResultadoBackOffice> {
  const inicio = new Date();
  const agente = 'vigilante_calidad';
  const lunes = lunesDe(hoy);
  const desde = masDias(lunes, -7);
  const titulo = `Calidad — semana del ${desde}`;
  try {
    if (await parteExistente(agente, titulo)) {
      await anotar(agente, inicio, 'ok', disparo, { parte: 'ya_existia', titulo });
      return { piezas: 0, motivo: 'el parte de la semana auditada ya está en la bandeja' };
    }
    const desdeIso = inicioDia(desde);
    const hastaIso = inicioDia(lunes);
    const [lote, base, piezas] = await Promise.all([
      leerCorridas(desdeIso, hastaIso),
      leerBaseCosto(inicioDia(masDias(desde, -28)), desdeIso),
      leerPiezasResueltas(desdeIso, hastaIso),
    ]);
    const { corridas, truncado } = lote;
    const hallazgos = evaluarCalidad(corridas, base, piezas);
    const agentesVistos = new Set(corridas.map((c) => c.agente)).size;
    const cuerpo = armarParteCalidad(hallazgos, desde, masDias(lunes, -1), corridas.length, agentesVistos, piezas.length, truncado);

    // El ROJO no espera a que alguien abra la bandeja (mismo criterio 0215).
    const rojos = hallazgos.filter((h) => h.semaforo === 'ROJO');
    if (rojos.length > 0) {
      await alertarOperador('backoffice.vigilante_calidad', {
        error: rojos.map((h) => `${h.codigo}/${h.agente}: ${h.detalle}`).join(' | ').slice(0, 900),
        codigo: 'calidad_hallazgo_rojo',
      });
    }
    const res = await encolarParte(agente, 'parte_calidad', titulo, cuerpo, {
      ventana: { desde, hasta: lunes }, truncado,
      hallazgos: hallazgos.map((h) => ({ semaforo: h.semaforo, codigo: h.codigo, agente: h.agente })),
      consultas: ['agente_corrida (ventana)', 'agente_corrida (historia 28d)', 'cola_aprobacion (resueltas)'],
    });
    await anotar(agente, inicio, 'ok', disparo,
      { parte: res, rojos: rojos.length, hallazgos: hallazgos.length, corridas: corridas.length },
      { tareasHechas: 1, tareasTotal: 1 });
    return { piezas: res === 'encolada' ? 1 : 0, motivo: res === 'ya_existia' ? 'otra corrida ganó el periodo' : undefined };
  } catch (e) {
    await anotar(agente, inicio, 'fallo', disparo, { titulo }, {
      tareasHechas: 0, tareasTotal: 1,
      error: `No se pudo armar el parte de calidad: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500),
    });
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2 · DOCUMENTACIÓN — el drift entre el catálogo VIVO y lo ya registrado.
//
// La persistencia es propia: cada parte deja en sus `fuentes` un CENSO del
// catálogo (estado, si está en el runner, y una huella de la descripción).
// El parte siguiente compara el catálogo de hoy contra ese censo. Sin censo
// previo el parte es la LÍNEA BASE y lo dice — jamás inventa un delta.
// ═══════════════════════════════════════════════════════════════════════════

export interface FichaAgente {
  id: string;
  nombre: string;
  departamento: string;
  estado: string;
  runnerHabilitado: boolean;
  descripcion: string | null;
  promptRef: string | null;
  /** El rol de modelo (models.ts) con el que corre, o NULL si es determinista
   *  (0125). Un agente determinista no llama a un modelo con un prompt
   *  externo, así que no tiene `prompt_ref` que documentar — exigírselo
   *  produce una alarma que nadie puede apagar nunca (auditoría 25, DATOS-M1). */
  modeloRol: string | null;
}

/** Una entrada del censo: estado, runner y HUELLA de la descripción (no el
 *  texto: el censo viaja en el jsonb de la pieza y sesenta descripciones
 *  completas lo engordarían sin decir nada más que «cambió o no cambió»). */
export interface EntradaCenso { e: string; r: boolean; d: string }
export type Censo = Record<string, EntradaCenso>;

export function huellaDescripcion(d: string | null): string {
  return createHash('sha256').update(d ?? '').digest('hex').slice(0, 12);
}

export function censoDe(fichas: FichaAgente[]): Censo {
  const censo: Censo = {};
  for (const f of fichas) censo[f.id] = { e: f.estado, r: f.runnerHabilitado, d: huellaDescripcion(f.descripcion) };
  return censo;
}

/** Descripción demasiado corta para servirle a alguien que llega nuevo. El
 *  corte es una convención declarada, no una medida — y el parte lo dice. */
const MIN_DESCRIPCION_UTIL = 40;

export interface CambioDocumental {
  tipo: 'alta' | 'baja' | 'flip_estado' | 'flip_runner' | 'descripcion' | 'sin_descripcion';
  agente: string;
  detalle: string;
}

/** El comparador PURO. `previo === null` = no hay censo anterior: se devuelven
 *  solo los huecos de descripción (que no necesitan historia) y el llamador
 *  redacta la línea base. */
export function compararCatalogo(actual: FichaAgente[], previo: Censo | null): CambioDocumental[] {
  const cambios: CambioDocumental[] = [];
  const porId = new Map(actual.map((f) => [f.id, f]));

  if (previo) {
    for (const f of [...actual].sort((a, b) => a.id.localeCompare(b.id))) {
      const antes = previo[f.id];
      if (!antes) {
        cambios.push({
          tipo: 'alta', agente: f.id,
          detalle: `ALTA: «${f.nombre}» (${f.departamento}, estado ${f.estado}) no estaba en el censo anterior.`,
        });
        continue;
      }
      const huella = huellaDescripcion(f.descripcion);
      if (antes.e !== f.estado) {
        // EL HALLAZGO QUE JUSTIFICA AL AGENTE: se encendió un agente y su
        // descripción sigue contando el diseño, no lo construido.
        const nota = antes.d === huella
          ? ' — y su descripción NO cambió: el catálogo sigue diciendo lo de antes (flip sin nota).'
          : ' (con descripción actualizada).';
        cambios.push({ tipo: 'flip_estado', agente: f.id, detalle: `ESTADO: ${antes.e} → ${f.estado}${nota}` });
      }
      if (antes.r !== f.runnerHabilitado) {
        cambios.push({
          tipo: 'flip_runner', agente: f.id,
          detalle: `RUNNER: ${antes.r ? 'habilitado → APAGADO' : 'apagado → HABILITADO'} en el runner.`,
        });
      }
      if (antes.e === f.estado && antes.d !== huella) {
        cambios.push({ tipo: 'descripcion', agente: f.id, detalle: 'DESCRIPCIÓN: cambió el texto del catálogo (mismo estado).' });
      }
    }
    for (const id of Object.keys(previo).sort()) {
      if (!porId.has(id)) {
        cambios.push({ tipo: 'baja', agente: id, detalle: 'BAJA: estaba en el censo anterior y ya no está en el catálogo.' });
      }
    }
  }

  // Huecos de documentación, con o sin historia: solo sobre los VIVOS — un
  // agente en 'disenado' sin descripción larga es un blueprint por escribir,
  // no un drift; uno VIVO sin descripción útil es un agente corriendo en
  // producción que nadie sabe explicar.
  for (const f of [...actual].sort((a, b) => a.id.localeCompare(b.id))) {
    if (f.estado !== 'vivo') continue;
    const d = (f.descripcion ?? '').trim();
    const faltas: string[] = [];
    if (d.length === 0) faltas.push('sin descripción');
    else if (d.length < MIN_DESCRIPCION_UTIL) faltas.push(`descripción de ${numero(d.length)} caracteres (mínimo útil declarado: ${MIN_DESCRIPCION_UTIL})`);
    if (f.modeloRol && (!f.promptRef || !f.promptRef.trim())) faltas.push('sin prompt_ref al blueprint');
    if (faltas.length > 0) {
      cambios.push({ tipo: 'sin_descripcion', agente: f.id, detalle: `VIVO Y SIN DOCUMENTAR: ${faltas.join(' · ')}.` });
    }
  }
  return cambios;
}

/** El resumen citable: qué cambió esta semana en la compañía agente. */
export function armarParteDocumentacion(
  fichas: FichaAgente[], cambios: CambioDocumental[], lunes: string, hayCensoPrevio: boolean, tituloCensoPrevio: string | null,
): string {
  const porEstado = new Map<string, number>();
  const porDepto = new Map<string, number>();
  for (const f of fichas) {
    porEstado.set(f.estado, (porEstado.get(f.estado) ?? 0) + 1);
    porDepto.set(f.departamento, (porDepto.get(f.departamento) ?? 0) + 1);
  }
  const enRunner = fichas.filter((f) => f.estado === 'vivo' && f.runnerHabilitado).length;
  const lineas = [
    `QUÉ CAMBIÓ ESTA SEMANA EN LA COMPAÑÍA AGENTE — semana del ${lunes}`,
    '',
    `Catálogo hoy: ${numero(fichas.length)} agente(s) declarados · ${[...porEstado.entries()].sort().map(([e, n]) => `${e} ${numero(n)}`).join(' · ')}.`,
    `Por departamento: ${[...porDepto.entries()].sort().map(([d, n]) => `${d} ${numero(n)}`).join(' · ')}.`,
    `Vivos y habilitados en el runner: ${numero(enRunner)}.`,
    '',
  ];
  if (!hayCensoPrevio) {
    lineas.push('LÍNEA BASE: no hay censo anterior registrado por este agente, así que esta semana NO se declara ningún cambio — los deltas empiezan la próxima. (Este parte deja el censo; sin él, decir «nada cambió» sería afirmar algo que nadie midió.)');
  } else {
    const deltas = cambios.filter((c) => c.tipo !== 'sin_descripcion');
    lineas.push(deltas.length === 0
      ? `CAMBIOS: ninguno contra el censo del ${tituloCensoPrevio ?? 'parte anterior'} — mismo catálogo, mismos estados, mismas descripciones.`
      : `CAMBIOS contra el censo del ${tituloCensoPrevio ?? 'parte anterior'} (${numero(deltas.length)}):`);
    for (const c of deltas) lineas.push(`  · ${c.agente}: ${c.detalle}`);
  }
  const huecos = cambios.filter((c) => c.tipo === 'sin_descripcion');
  lineas.push('');
  lineas.push(huecos.length === 0
    ? 'DEUDA DOCUMENTAL: ninguna — todos los agentes VIVOS traen descripción útil y prompt_ref.'
    : `DEUDA DOCUMENTAL (agentes VIVOS, ${numero(huecos.length)}):`);
  for (const c of huecos) lineas.push(`  · ${c.agente}: ${c.detalle}`);
  lineas.push('');
  lineas.push('LO QUE ESTE PARTE NO MIRA: los archivos del paquete de blueprints (viven fuera del repo y el runner no los puede leer). Mide el catálogo VIVO de la base contra el censo que este mismo agente dejó la vez pasada — si un blueprint y el catálogo divergen, lo que aquí se ve es el catálogo.');
  lineas.push('Fuente: agente_definicion (censo completo) · el censo del parte anterior de este agente (cola_aprobacion.fuentes).');
  return lineas.join('\n');
}

/** El catálogo completo. LANZA si no se puede leer. */
async function leerCatalogo(): Promise<FichaAgente[]> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('agente_definicion')
    .select('id, nombre, departamento, estado, runner_habilitado, descripcion, prompt_ref, modelo_rol')
    .order('id')
    .limit(500), 'backoffice.catalogo');
  if (error) throw new Error(`leerCatalogo: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((f) => ({
    id: String(f.id),
    nombre: String(f.nombre),
    departamento: String(f.departamento),
    estado: String(f.estado),
    runnerHabilitado: f.runner_habilitado === true,
    descripcion: (f.descripcion as string | null) ?? null,
    promptRef: (f.prompt_ref as string | null) ?? null,
    modeloRol: (f.modelo_rol as string | null) ?? null,
  }));
}

/** El censo del parte ANTERIOR de este agente (el más reciente, no «el del
 *  lunes pasado»): si una semana no salió parte, el delta se mide contra el
 *  último que sí salió — comparar contra el vacío inventaría altas masivas. */
async function leerCensoPrevio(): Promise<{ censo: Censo | null; titulo: string | null }> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('cola_aprobacion')
    .select('titulo, fuentes')
    .eq('agente', 'documentacion')
    .eq('tipo', 'parte_documentacion')
    .order('creado_en', { ascending: false })
    .limit(1), 'backoffice.censo_previo');
  if (error) throw new Error(`leerCensoPrevio: ${error.message}`);
  const fila = ((data ?? []) as Array<Record<string, unknown>>)[0];
  if (!fila) return { censo: null, titulo: null };
  const fuentes = (fila.fuentes as Record<string, unknown> | null) ?? {};
  const censo = fuentes.censo as Censo | undefined;
  // Un parte previo cuyo censo no se puede leer NO es «no había censo»: se
  // trata como ausente pero se dice en el log; el parte lo declarará como
  // línea base, que es lo honesto (no se inventan altas de sesenta agentes).
  if (!censo || typeof censo !== 'object') {
    logger.warn('backoffice.censo_previo_ilegible', { titulo: String(fila.titulo ?? '') });
    return { censo: null, titulo: null };
  }
  return { censo, titulo: String(fila.titulo ?? '') };
}

async function correrDocumentacion(disparo: DisparoCorrida, hoy: string): Promise<ResultadoBackOffice> {
  const inicio = new Date();
  const agente = 'documentacion';
  const lunes = lunesDe(hoy);
  const titulo = `Documentación — semana del ${lunes}`;
  try {
    if (await parteExistente(agente, titulo)) {
      await anotar(agente, inicio, 'ok', disparo, { parte: 'ya_existia', titulo });
      return { piezas: 0, motivo: 'el resumen de esta semana ya está en la bandeja' };
    }
    const [fichas, previo] = await Promise.all([leerCatalogo(), leerCensoPrevio()]);
    const cambios = compararCatalogo(fichas, previo.censo);
    const cuerpo = armarParteDocumentacion(fichas, cambios, lunes, previo.censo !== null, previo.titulo);
    const res = await encolarParte(agente, 'parte_documentacion', titulo, cuerpo, {
      // EL CENSO ES LA PERSISTENCIA DEL AGENTE: sin él, el parte siguiente no
      // tiene contra qué comparar y volvería a ser línea base para siempre.
      censo: censoDe(fichas),
      cambios: cambios.map((c) => ({ tipo: c.tipo, agente: c.agente })),
      consultas: ['agente_definicion', 'cola_aprobacion (censo del parte anterior)'],
    });
    await anotar(agente, inicio, 'ok', disparo,
      { parte: res, agentes: fichas.length, cambios: cambios.length, linea_base: previo.censo === null },
      { tareasHechas: 1, tareasTotal: 1 });
    return { piezas: res === 'encolada' ? 1 : 0, motivo: res === 'ya_existia' ? 'otra corrida ganó el periodo' : undefined };
  } catch (e) {
    await anotar(agente, inicio, 'fallo', disparo, { titulo }, {
      tareasHechas: 0, tareasTotal: 1,
      error: `No se pudo armar el resumen documental: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500),
    });
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3 · LEGAL Y COMPLIANCE — los relojes legales de LIKIDA-EMPRESA.
//
// NO los del producto (vigilancia normativa / experto fiscal) ni los de las
// flotas (pólizas, permisos SICT — Fase 6). Aquí: el aviso publicado, los
// datos que la ley obliga a exhibir, el plazo ARCO del art. 31 LFPDPPP y los
// pendientes societarios que Javier declaró bloqueados.
//
// PREPARA; JAMÁS FIRMA NI CONTESTA A UNA AUTORIDAD (blueprint). El parte
// pone el reloj enfrente; quien responde es una persona.
// ═══════════════════════════════════════════════════════════════════════════

/** Lectura POR VALOR: una fuente ciega se dice, jamás se colapsa a «vacío». */
export interface Lectura<T> { valor: T | null; error: string | null }

async function porValor<T>(nombre: string, fn: () => Promise<T>): Promise<Lectura<T>> {
  try {
    return { valor: await fn(), error: null };
  } catch (e) {
    logger.warn('backoffice.fuente_ciega', { fuente: nombre, err: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    return { valor: null, error: nombre };
  }
}

export type EstadoPublicacion = 'publicado' | 'no_responde' | 'no_comprobado';
export interface Publicacion { ruta: string; estado: EstadoPublicacion; detalle: string }

/** Las dos rutas legales de LIKIDA como responsable (no las de cada flota). */
export const RUTAS_LEGALES = ['/privacidad', '/aviso/prospectos'] as const;

const TIMEOUT_PUBLICACION_MS = 5_000;

/**
 * ¿Está PUBLICADO el aviso? Se comprueba pidiéndolo de verdad — que el
 * archivo exista en el repo no prueba que la ruta responda en producción, y
 * lo que la ley exige es que el titular pueda leerlo.
 *
 * TRES RAMAS, nunca dos: publicado (200) · no responde (contestó otra cosa) ·
 * NO SE PUDO COMPROBAR (red caída, timeout). La tercera jamás se escribe como
 * «publicado»: afirmar que un aviso está en línea sin haberlo visto es
 * exactamente la clase de afirmación que este agente existe para no hacer.
 */
export async function comprobarPublicacion(
  rutas: readonly string[] = RUTAS_LEGALES,
  base: string = appUrl(),
  buscar: typeof fetch = fetch,
): Promise<Publicacion[]> {
  return Promise.all(rutas.map(async (ruta): Promise<Publicacion> => {
    const url = `${base}${ruta}`;
    try {
      const r = await buscar(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_PUBLICACION_MS) });
      return r.status === 200
        ? { ruta, estado: 'publicado', detalle: `${url} respondió 200.` }
        : { ruta, estado: 'no_responde', detalle: `${url} respondió ${r.status} — la ruta legal no está sirviendo el aviso.` };
    } catch (e) {
      return {
        ruta, estado: 'no_comprobado',
        detalle: `no se pudo pedir ${url} (${(e instanceof Error ? e.message : String(e)).slice(0, 120)}) — NO se afirma que esté publicado.`,
      };
    }
  }));
}

export interface ArcoPendiente {
  id: string;
  tipo: string;
  estado: string;
  recibidaEn: string;
  venceEn: string;
}

export interface PendienteSocietario {
  id: string;
  titulo: string;
  detalle: string | null;
  estado: string;
  /** `null` = SIN FECHA DECLARADA. El parte lo dice; no inventa una. */
  fechaObjetivo: string | null;
}

export interface DatosLegal {
  hoy: string;
  lunes: string;
  publicaciones: Lectura<Publicacion[]>;
  entidad: ReturnType<typeof estadoLegalProduccion>;
  arco: Lectura<ArcoPendiente[]>;
  societarios: Lectura<PendienteSocietario[]>;
}

/** El plazo del art. 31 LFPDPPP: 20 días para comunicar la determinación. La
 *  fecha ya viene calculada en `solicitud_arco.vence_en` (0053) — aquí solo
 *  se lee el reloj contra el día de México. */
export const DIAS_PLAZO_ARCO = 20;

export function armarParteLegal(d: DatosLegal): { cuerpo: string; vencidas: number } {
  const lineas = [`LEGAL Y COMPLIANCE — semana del ${d.lunes} (corte: ${d.hoy})`, ''];

  // 1 · El aviso publicado.
  lineas.push('1 · AVISO DE PRIVACIDAD PUBLICADO');
  if (d.publicaciones.error || !d.publicaciones.valor) {
    lineas.push('  NO SE PUDO COMPROBAR ninguna ruta — este parte no afirma que los avisos estén en línea.');
  } else {
    for (const p of d.publicaciones.valor) lineas.push(`  ${p.ruta}: ${p.estado.toUpperCase().replace('_', ' ')} — ${p.detalle}`);
  }

  // 2 · Los datos que la ley obliga a exhibir.
  lineas.push('');
  lineas.push('2 · DATOS LEGALES DECLARADOS (LEGAL_* del entorno)');
  if (d.entidad.listo) {
    lineas.push('  Completos: entidad y los cuatro documentos tienen versión declarada.');
  } else {
    if (d.entidad.faltantesEntidad.length > 0) {
      lineas.push(`  BLOQUEANTE — faltan datos de la ENTIDAD: ${d.entidad.faltantesEntidad.join(', ')}. Sin ellos el aviso publicado sale con marcadores 🔴 y el build de producción se detiene (exigirLegalEnProduccion).`);
    }
    if (d.entidad.faltantesDocumentos.length > 0) {
      lineas.push(`  Sin versión declarada (no bloquean el deploy, sí la venta enterprise): ${d.entidad.faltantesDocumentos.join(', ')}.`);
    }
  }

  // 3 · El reloj ARCO.
  lineas.push('');
  lineas.push(`3 · SOLICITUDES ARCO PENDIENTES (plazo LFPDPPP art. 31: ${DIAS_PLAZO_ARCO} días hábiles)`);
  let vencidas = 0;
  if (d.arco.error || !d.arco.valor) {
    lineas.push('  NO SE PUDO LEER solicitud_arco — puede haber plazos corriendo sin que este parte los vea. Es un hallazgo, no un cero.');
  } else if (d.arco.valor.length === 0) {
    lineas.push('  Ninguna pendiente (conteo real sobre solicitud_arco, no un supuesto).');
  } else {
    for (const s of d.arco.valor) {
      const restan = diasEntre(d.hoy, s.venceEn);
      if (restan < 0) vencidas += 1;
      const reloj = restan < 0 ? `VENCIDA hace ${numero(-restan)} día(s)` : restan === 0 ? 'VENCE HOY' : `restan ${numero(restan)} día(s)`;
      lineas.push(`  ${s.id.slice(0, 8)} · ${s.tipo} · ${s.estado} · recibida ${s.recibidaEn.slice(0, 10)} · vence ${s.venceEn} — ${reloj}.`);
    }
    lineas.push('  Likida es ENCARGADA: la responsable frente al titular es la flota. Este reloj existe porque un plazo que nadie mira se vence igual.');
  }

  // 4 · Los pendientes societarios declarados.
  lineas.push('');
  lineas.push('4 · PENDIENTES SOCIETARIOS DECLARADOS');
  if (d.societarios.error || !d.societarios.valor) {
    lineas.push('  NO SE PUDO LEER pendiente_societario — no se afirma que no haya pendientes.');
  } else if (d.societarios.valor.length === 0) {
    lineas.push('  Ninguno abierto en el registro.');
  } else {
    for (const p of d.societarios.valor) {
      // SIN INVENTAR FECHAS: si Javier no declaró una, el parte lo dice tal
      // cual. Una fecha objetivo puesta por el agente sería un compromiso que
      // nadie asumió.
      const fecha = p.fechaObjetivo ? `objetivo ${p.fechaObjetivo}` : 'SIN FECHA DECLARADA (el agente no inventa una)';
      lineas.push(`  ${p.titulo} [${p.estado}] — ${fecha}.${p.detalle ? ` ${p.detalle}` : ''}`);
    }
  }

  lineas.push('');
  lineas.push('LO QUE ESTE AGENTE NO HACE: no firma, no contesta a una autoridad, no publica el aviso ni cambia una variable de entorno. Prepara y pone el reloj enfrente; quien responde es una persona.');
  lineas.push('Fuentes: fetch a las rutas legales de la app · estadoLegalProduccion() (LEGAL_* del entorno) · solicitud_arco (0053/0197) · pendiente_societario (0219).');
  return { cuerpo: lineas.join('\n'), vencidas };
}

async function leerArcoPendientes(): Promise<ArcoPendiente[]> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('solicitud_arco')
    .select('id, tipo, estado, recibida_en, vence_en')
    .in('estado', ['recibida', 'en_proceso'])
    .order('vence_en', { ascending: true })
    .limit(200), 'backoffice.arco');
  if (error) throw new Error(`leerArcoPendientes: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((f) => ({
    id: String(f.id),
    tipo: String(f.tipo),
    estado: String(f.estado),
    recibidaEn: String(f.recibida_en),
    venceEn: String(f.vence_en),
  }));
}

async function leerSocietarios(): Promise<PendienteSocietario[]> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('pendiente_societario')
    .select('id, titulo, detalle, estado, fecha_objetivo')
    .neq('estado', 'cerrado')
    .order('id')
    .limit(100), 'backoffice.societarios');
  if (error) throw new Error(`leerSocietarios: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((f) => ({
    id: String(f.id),
    titulo: String(f.titulo),
    detalle: (f.detalle as string | null) ?? null,
    estado: String(f.estado),
    fechaObjetivo: (f.fecha_objetivo as string | null) ?? null,
  }));
}

async function correrLegalCompliance(disparo: DisparoCorrida, hoy: string): Promise<ResultadoBackOffice> {
  const inicio = new Date();
  const agente = 'legal_compliance';
  const lunes = lunesDe(hoy);
  const titulo = `Legal — semana del ${lunes}`;
  try {
    if (await parteExistente(agente, titulo)) {
      await anotar(agente, inicio, 'ok', disparo, { parte: 'ya_existia', titulo });
      return { piezas: 0, motivo: 'el parte legal de esta semana ya está en la bandeja' };
    }
    const [publicaciones, arco, societarios] = await Promise.all([
      porValor('publicación de los avisos', () => comprobarPublicacion()),
      porValor('solicitudes ARCO', () => leerArcoPendientes()),
      porValor('pendientes societarios', () => leerSocietarios()),
    ]);
    const datos: DatosLegal = { hoy, lunes, publicaciones, entidad: estadoLegalProduccion(), arco, societarios };
    const { cuerpo, vencidas } = armarParteLegal(datos);

    // Un plazo legal vencido no espera a que alguien abra la bandeja.
    if (vencidas > 0) {
      await alertarOperador('backoffice.legal_compliance', {
        error: `${vencidas} solicitud(es) ARCO con el plazo del art. 31 LFPDPPP VENCIDO. El parte está en la bandeja.`,
        codigo: 'legal_arco_vencida',
      });
    }
    const ciegas = [publicaciones, arco, societarios].filter((f) => f.error !== null).map((f) => f.error as string);
    const res = await encolarParte(agente, 'parte_legal', titulo, cuerpo, {
      arco_pendientes: arco.valor?.length ?? null,
      arco_vencidas: arco.valor ? vencidas : null,
      faltantes_legales: datos.entidad.faltantes,
      fuentes_ciegas: ciegas,
      consultas: ['fetch rutas legales', 'estadoLegalProduccion', 'solicitud_arco', 'pendiente_societario'],
    });
    await anotar(agente, inicio, 'ok', disparo,
      { parte: res, arco_vencidas: arco.valor ? vencidas : null, fuentes_ciegas: ciegas },
      { tareasHechas: 1, tareasTotal: 1 });
    return { piezas: res === 'encolada' ? 1 : 0, motivo: res === 'ya_existia' ? 'otra corrida ganó el periodo' : undefined };
  } catch (e) {
    await anotar(agente, inicio, 'fallo', disparo, { titulo }, {
      tareasHechas: 0, tareasTotal: 1,
      error: `No se pudo armar el parte legal: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500),
    });
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4 · TALENTO — el registro, y la criba cableada esperando la primera vacante.
//
// HOY HAY CERO VACANTES, y eso decide el diseño: el motor real de esta ola es
// el REGISTRO (`vacante`, `candidato` — datos personales, deny-all) y la
// criba DETERMINISTA que ya queda cableada y probada. Con cero vacantes
// abiertas el agente no fabrica pieza: anota su corrida diciendo «sin
// vacantes abiertas» y se va. Un parte semanal que dice «nada» todas las
// semanas entrena a Javier a no abrir la bandeja, y esa costumbre se paga el
// día que el parte sí trae algo.
//
// LA CRIBA NUNCA DESCARTA. Marca `cribado` con puntaje y motivo, y encola la
// terna para que el humano decida. Sin requisitos declarados en la vacante no
// hay vara: el puntaje es NULL y se dice — jamás un 0 que parezca medición.
// ═══════════════════════════════════════════════════════════════════════════

export interface RequisitosVacante { obligatorios: string[]; deseables: string[] }

export interface VacanteAbierta {
  id: string;
  clave: string;
  titulo: string;
  requisitos: RequisitosVacante | null;
}

export interface CandidatoCrudo {
  id: string;
  vacanteId: string;
  nombre: string;
  correo: string;
  perfil: string | null;
}

export interface Criba {
  /** `null` = la vacante no declara requisitos: no hay vara que aplicar. */
  puntaje: number | null;
  cumpleObligatorios: boolean | null;
  cumplidos: string[];
  faltantes: string[];
  motivo: string;
}

/** Minúsculas sin acentos: «Camión» y «camion» son la misma palabra. */
export function normalizar(t: string): string {
  return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * La criba, PURA y determinista. Cuenta requisitos presentes en el texto del
 * perfil; los obligatorios pesan doble. Ni modelo ni heurística oculta: si
 * alguien pregunta por qué un candidato sacó 60, la respuesta es la lista de
 * palabras que se encontraron y las que no.
 */
export function evaluarCandidato(perfil: string | null, req: RequisitosVacante | null): Criba {
  const obligatorios = (req?.obligatorios ?? []).map((x) => x.trim()).filter(Boolean);
  const deseables = (req?.deseables ?? []).map((x) => x.trim()).filter(Boolean);
  if (obligatorios.length === 0 && deseables.length === 0) {
    return {
      puntaje: null, cumpleObligatorios: null, cumplidos: [], faltantes: [],
      motivo: 'la vacante no declara requisitos: no hay vara. Se registra al candidato SIN puntaje — un 0 aquí sería una calificación que nadie midió.',
    };
  }
  if (!perfil || !perfil.trim()) {
    return {
      puntaje: null, cumpleObligatorios: null, cumplidos: [], faltantes: [...obligatorios, ...deseables],
      motivo: 'el candidato no trae perfil capturado: no se puede cribar contra los requisitos. Se registra sin puntaje.',
    };
  }
  const texto = normalizar(perfil);
  const tiene = (r: string) => texto.includes(normalizar(r));
  const oblCumplidos = obligatorios.filter(tiene);
  const desCumplidos = deseables.filter(tiene);
  const maximo = obligatorios.length * 2 + deseables.length;
  const puntaje = Math.round((100 * (oblCumplidos.length * 2 + desCumplidos.length)) / maximo);
  const faltantes = [
    ...obligatorios.filter((r) => !tiene(r)),
    ...deseables.filter((r) => !tiene(r)),
  ];
  const cumpleObligatorios = oblCumplidos.length === obligatorios.length;
  return {
    puntaje,
    cumpleObligatorios,
    cumplidos: [...oblCumplidos, ...desCumplidos],
    faltantes,
    motivo: `${cumpleObligatorios ? 'cumple los obligatorios' : `le faltan obligatorios: ${obligatorios.filter((r) => !tiene(r)).join(', ')}`}. Coincidencias: ${[...oblCumplidos, ...desCumplidos].join(', ') || 'ninguna'}.`,
  };
}

export interface CandidatoCribado extends CandidatoCrudo { criba: Criba }

/** El parte de talento, PURO: la terna por vacante y qué decide el humano. */
export function armarParteTalento(
  vacantes: VacanteAbierta[], cribados: CandidatoCribado[], pendientes: number, lunes: string,
): string {
  const lineas = [`TALENTO — semana del ${lunes}`, '', `Vacantes abiertas: ${numero(vacantes.length)}.`, ''];
  for (const v of vacantes) {
    const suyos = cribados.filter((c) => c.vacanteId === v.id);
    lineas.push(`· ${v.titulo} (${v.clave})`);
    if (!v.requisitos || (v.requisitos.obligatorios.length === 0 && v.requisitos.deseables.length === 0)) {
      lineas.push('    SIN REQUISITOS DECLARADOS: los candidatos se registran sin puntaje. Declara `requisitos` en la vacante para que la criba tenga vara.');
    }
    if (suyos.length === 0) {
      lineas.push('    Sin candidatos nuevos por cribar esta semana.');
      continue;
    }
    // Sin puntaje van al final: no se ordena un NULL como si fuera un 0.
    const orden = [...suyos].sort((a, b) => (b.criba.puntaje ?? -1) - (a.criba.puntaje ?? -1));
    for (const c of orden.slice(0, 5)) {
      const p = c.criba.puntaje === null ? 'sin puntaje' : `${numero(c.criba.puntaje)}/100`;
      lineas.push(`    ${c.nombre} — ${p}. ${c.criba.motivo}`);
    }
    if (orden.length > 5) lineas.push(`    (y ${numero(orden.length - 5)} candidato(s) más cribados, en la tabla)`);
  }
  lineas.push('');
  lineas.push(`Quedan ${numero(pendientes)} candidato(s) sin cribar tras esta corrida (tope por corrida).`);
  lineas.push('LA CRIBA NO DESCARTA A NADIE: marca `cribado` con puntaje y motivo. Avanzar, entrevistar o descartar es decisión humana, y el motivo queda escrito.');
  lineas.push('DATOS PERSONALES: `candidato` es deny-all (RLS sin policies, solo el servidor) y entra al circuito ARCO como cualquier titular.');
  lineas.push('Fuentes: vacante (abiertas) · candidato (estado recibido) · criba determinista por palabras clave declaradas en la vacante.');
  return lineas.join('\n');
}

/** Tope de candidatos cribados por corrida — el mismo criterio del runner. */
const TOPE_CRIBA_POR_CORRIDA = 25;

async function leerVacantesAbiertas(): Promise<VacanteAbierta[]> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('vacante')
    .select('id, clave, titulo, requisitos')
    .eq('estado', 'abierta')
    .order('clave')
    .limit(50), 'backoffice.vacantes');
  if (error) throw new Error(`leerVacantesAbiertas: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((f) => {
    const r = (f.requisitos as Record<string, unknown> | null) ?? null;
    const lista = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return {
      id: String(f.id),
      clave: String(f.clave),
      titulo: String(f.titulo),
      requisitos: r ? { obligatorios: lista(r.obligatorios), deseables: lista(r.deseables) } : null,
    };
  });
}

async function leerCandidatosPorCribar(vacanteIds: string[], limite: number): Promise<CandidatoCrudo[]> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('candidato')
    .select('id, vacante_id, nombre, correo, perfil')
    .eq('estado', 'recibido')
    .in('vacante_id', vacanteIds)
    .order('recibido_en', { ascending: true })
    .limit(limite), 'backoffice.candidatos');
  if (error) throw new Error(`leerCandidatosPorCribar: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((f) => ({
    id: String(f.id),
    vacanteId: String(f.vacante_id),
    nombre: String(f.nombre),
    correo: String(f.correo),
    perfil: (f.perfil as string | null) ?? null,
  }));
}

/** Escribe la criba de UN candidato, anclada a `estado = 'recibido'`: dos
 *  corridas simultáneas no se pisan — la segunda toca cero filas (el mismo
 *  patrón de `reclamarEscalacion`). LANZA si la escritura falla. */
async function guardarCriba(id: string, c: Criba): Promise<void> {
  const { error } = await acotada(supabaseAdmin()
    .from('candidato')
    .update({
      estado: 'cribado',
      puntaje: c.puntaje,
      motivo: c.motivo.slice(0, 1000),
      criba: { cumplidos: c.cumplidos, faltantes: c.faltantes, cumple_obligatorios: c.cumpleObligatorios },
      cribado_en: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('estado', 'recibido'), 'backoffice.guardar_criba');
  if (error) throw new Error(`guardarCriba(${id}): ${error.message}`);
}

async function correrTalento(disparo: DisparoCorrida, hoy: string, venceEnVuelta?: number): Promise<ResultadoBackOffice> {
  const inicio = new Date();
  const agente = 'talento';
  const lunes = lunesDe(hoy);
  const titulo = `Talento — semana del ${lunes}`;
  try {
    const vacantes = await leerVacantesAbiertas();
    if (vacantes.length === 0) {
      // La corrida SÍ se anota (0 de 0 tareas: no dispara el detector de
      // «verde vacío», que exige tareas_total > 0) para que el orquestador no
      // acuse «NO HA CORRIDO» a un agente que sí corrió y no tenía trabajo.
      await anotar(agente, inicio, 'ok', disparo, {
        vacantes_abiertas: 0,
        parte: 'sin vacantes abiertas — el agente despierta cuando declares una en la tabla `vacante`',
      }, { tareasHechas: 0, tareasTotal: 0 });
      return { piezas: 0, motivo: 'sin vacantes abiertas — el agente despierta cuando declares una (tabla `vacante`)' };
    }
    // ── LA CRIBA CORRE SIEMPRE (c6-6) ────────────────────────────────────
    //
    // Antes, `parteExistente` cortaba la corrida ENTERA: fabricado el parte
    // del lunes, los candidatos que llegaban de martes a domingo se quedaban
    // en 'recibido' hasta la semana siguiente — el agente se declaraba «ok»
    // sin haber mirado a nadie. Lo SEMANAL es la fabricación del parte, no el
    // trabajo. La criba es idempotente por estado (`guardarCriba` ancla el
    // UPDATE en `estado='recibido'`, y `leerCandidatosPorCribar` solo pide
    // esos), así que correrla de más no re-evalúa a nadie ni pisa una criba
    // hecha: toca cero filas.
    const porCribar = await leerCandidatosPorCribar(vacantes.map((v) => v.id), TOPE_CRIBA_POR_CORRIDA + 1);
    const lote = porCribar.slice(0, TOPE_CRIBA_POR_CORRIDA);
    const reqPorVacante = new Map(vacantes.map((v) => [v.id, v.requisitos]));
    const cribados: CandidatoCribado[] = [];
    let sinCribar = 0;
    for (let i = 0; i < lote.length; i++) {
      const c = lote[i];
      // ── EL RELOJ, ANTES DE ESCRIBIR LA CRIBA (c7-1 + criterio #160) ────────
      // Un UPDATE por candidato, hasta 25 por corrida, en serie. Talento es el
      // último de los cuatro del back office por orden alfabético, así que
      // llega con el presupuesto de la vuelta ya mordido por los otros tres.
      //
      // El punto seguro es ANTES de `guardarCriba`, nunca después de evaluar y
      // antes de escribir: `evaluarCandidato` es puro y tirarlo no cuesta nada,
      // pero cortar entre la evaluación y su escritura perdería el veredicto
      // sin dejar rastro. Cortar aquí no deja nada a medias — `guardarCriba`
      // ancla el UPDATE en `estado='recibido'` (idempotente por estado, c6-6),
      // así que los ya cribados quedan cribados y los que faltan siguen
      // esperando exactamente igual que antes de esta corrida.
      if (relojAgotado(venceEnVuelta)) {
        sinCribar = lote.length - i;
        logger.warn('backoffice.talento.corte_por_reloj', { sinCribar, cribados: cribados.length });
        break;
      }
      const criba = evaluarCandidato(c.perfil, reqPorVacante.get(c.vacanteId) ?? null);
      await guardarCriba(c.id, criba);
      cribados.push({ ...c, criba });
    }

    // EL PARTE SEMANAL NO SE SELLA CON LA CRIBA A MEDIAS. `armarParteTalento`
    // presenta a los cribados como los candidatos de la semana, y el título
    // `Talento — semana del <lunes>` es idempotente por SIETE DÍAS: un parte
    // armado con 6 de 25 candidatos no lo corrige la pasada de dentro de cuatro
    // horas ni la de mañana — se queda así hasta el lunes que viene, y los
    // candidatos que no entraron quedan invisibles una semana entera. Las
    // cribas ya escritas NO se pierden (son idempotentes por estado) y entran
    // al parte en cuanto una pasada alcance a terminar la lista.
    if (sinCribar > 0) {
      await anotar(agente, inicio, 'ok', disparo,
        { parte: 'sin_turno', cribados: cribados.length, sin_cribar: sinCribar },
        { tareasHechas: cribados.length, tareasTotal: lote.length });
      return {
        piezas: 0, sinTurno: true,
        motivo: `el reloj de la vuelta cortó la criba con ${numero(sinCribar)} candidato(s) sin mirar — lo cribado queda; el parte SEMANAL no se selló a medias (dejaría fuera a esos candidatos hasta el lunes que viene) y sale completo en la próxima pasada`,
      };
    }

    // Y AHORA sí, lo semanal: el parte. Si el de esta semana ya está, la
    // corrida no fue en balde — cribó lo que llegó desde entonces, y eso es
    // lo que se anota.
    if (await parteExistente(agente, titulo)) {
      await anotar(agente, inicio, 'ok', disparo,
        { parte: 'ya_existia', titulo, cribados: cribados.length },
        { tareasHechas: cribados.length, tareasTotal: cribados.length });
      return {
        piezas: 0,
        motivo: cribados.length === 0
          ? 'el parte de talento de esta semana ya está en la bandeja y no había candidatos nuevos por cribar'
          : `el parte de talento de esta semana ya está en la bandeja; se cribaron ${numero(cribados.length)} candidato(s) nuevo(s) — entran al parte de la semana que viene`,
      };
    }

    const cuerpo = armarParteTalento(vacantes, cribados, Math.max(0, porCribar.length - lote.length), lunes);
    const res = await encolarParte(agente, 'parte_talento', titulo, cuerpo, {
      vacantes: vacantes.map((v) => v.clave),
      cribados: cribados.length,
      consultas: ['vacante (abiertas)', 'candidato (recibidos)'],
    });
    await anotar(agente, inicio, 'ok', disparo,
      { parte: res, vacantes: vacantes.length, cribados: cribados.length },
      { tareasHechas: 1, tareasTotal: 1 });
    return { piezas: res === 'encolada' ? 1 : 0, motivo: res === 'ya_existia' ? 'otra corrida ganó el periodo' : undefined };
  } catch (e) {
    await anotar(agente, inicio, 'fallo', disparo, { titulo }, {
      tareasHechas: 0, tareasTotal: 1,
      error: `No se pudo correr talento: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500),
    });
    throw e;
  }
}

// ── El despacho que el runner llama ────────────────────────────────────────

export async function correrAgenteBackOffice(
  id: AgenteBackOffice,
  disparo: DisparoCorrida,
  hoy: string = hoyMx(),
  /** EL RELOJ DE LA VUELTA del runner (epoch ms) — no el plazo legal de una
   *  solicitud ARCO; ver la nota de `relojAgotado`. Opcional: sin él los cuatro
   *  se comportan igual que siempre, que es lo que quieren el copiloto y las
   *  pruebas. Solo el cron corre contra un `maxDuration`.
   *
   *  De los cuatro, hoy únicamente `talento` itera una lista de trabajo con I/O
   *  por elemento; los otros tres arman su parte con un juego fijo de consultas
   *  (`Promise.all`) y no tienen bucle que cronometrar. El parámetro se recibe
   *  para los cuatro de todas formas para que el día que uno crezca un bucle,
   *  el reloj ya esté a la mano y no haya que acordarse de cablearlo. */
  venceEnVuelta?: number,
): Promise<ResultadoBackOffice> {
  logger.info('backoffice.corrida', { agente: id, disparo });
  switch (id) {
    case 'vigilante_calidad': return correrVigilanteCalidad(disparo, hoy);
    case 'documentacion': return correrDocumentacion(disparo, hoy);
    case 'legal_compliance': return correrLegalCompliance(disparo, hoy);
    case 'talento': return correrTalento(disparo, hoy, venceEnVuelta);
  }
}
