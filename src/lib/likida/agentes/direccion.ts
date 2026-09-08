// ═══════════════════════════════════════════════════════════════════════════
// DIRECCIÓN — LOS TRES QUE FALTABAN (0235).
//
// El departamento ya tenía cuatro vivos desde la 0216, y viven aparte
// (`src/lib/likida/direccion/reportes.ts`) porque MANDAN CORREO: su salida es
// el canal del operador y su sello es `reporte_direccion`. Estos tres tienen
// otro contrato de salida —la bandeja de aprobación, como crecimiento y como
// éxito del cliente—, y por eso viven aquí y no allá: mezclar «esto sale solo
// por correo» con «esto espera el tap de Javier» en un archivo sería mezclar
// las dos únicas cosas que un agente de dirección puede hacer con su parte.
//
//   · automejora              — la telemetría de la propia compañía agente:
//                               qué se está rompiendo solo y qué palanca mover.
//   · especialistas_incidente — con un incidente abierto: a quién hay que
//                               llamar y con qué datos, con los teléfonos que
//                               YA están en la base.
//   · fundraising             — el parte de métricas para inversionistas con
//                               las cifras REALES, y la lista explícita de las
//                               que todavía no existen.
//
// ── LAS REGLAS QUE GOBIERNAN A LOS TRES ───────────────────────────────────
//
//  1. NINGUNO EJECUTA NADA. `automejora` PROPONE mover una palanca; no la
//     mueve. `especialistas_incidente` PREPARA la llamada; no marca — una
//     llamada automática a una aseguradora abre un siniestro, que es dinero y
//     acto jurídico (la razón escrita en la 0198). `fundraising` deja el parte
//     en la bandeja; mandarlo a un inversionista es de Javier.
//  2. NI UN TELÉFONO QUE NO ESTÉ EN LA BASE. Los números del parte de
//     incidente salen de `flota_poliza.telefono_siniestros` y
//     `proveedor_emergencia.telefono`, y cada uno se rotula con si alguien lo
//     verificó (`verificado_en`). Este archivo no contiene una sola cadena que
//     parezca un número. Desde la auditoría 28 (LEG-A5), `contacto_emergencia`
//     (los familiares del operador) ya NO se consulta aquí: ver la cabecera
//     de la sección 2.
//  3. NULL ≠ 0 Y «NO SE PUDO LEER» ≠ «NO HAY». Un MRR sobre una suscripción
//     con `precio_mensual` NULL no es un MRR parcial: es un MRR INDETERMINADO,
//     y así sale. Una fuente que no contesta se nombra; no se rellena.
//  4. CERO LLM. Los tres son deterministas: las reglas calculan y redactan con
//     plantilla fija. El techo se declara igual (candado 3 del runner).
//  5. IDEMPOTENCIA POR CONSTRAINT. Título determinista por periodo contra el
//     índice único parcial `cola_pieza_direccion_por_periodo` (0235).
// ═══════════════════════════════════════════════════════════════════════════
import { supabaseAdmin } from '@/lib/supabase/admin';
import { acotada } from '../presupuesto';
import { hoyMx, numero, mxn, usd, fechaMx, fechaHoraMx, inicioDiaMx } from '@/lib/formato';
import { estadoLatidos, CRONS, type CronId, type SaludCron } from '@/lib/admin/salud';
import { INTERRUPTORES } from '../interruptores';
import { encolarPieza } from './cola';
import { registrarCorrida, type DisparoCorrida } from './corridas';
import { logger } from '@/lib/logger';

export const AGENTES_DIRECCION_BANDEJA = [
  'automejora', 'especialistas_incidente', 'fundraising',
] as const;
export type AgenteDireccionBandeja = (typeof AGENTES_DIRECCION_BANDEJA)[number];

export function esAgenteDireccionBandeja(id: string): id is AgenteDireccionBandeja {
  return (AGENTES_DIRECCION_BANDEJA as readonly string[]).includes(id);
}

/** Lo que una corrida de estos tres le reporta al runner. Misma forma que la
 *  de crecimiento (0230). */
export interface ResultadoDireccionBandeja {
  resultado: 'corrio' | 'saltado';
  piezas: number;
  motivo?: string;
  costoUsd: number;
  /** El reloj de la vuelta se agotó a media BÚSQUEDA de expediente y quedaron
   *  incidentes sin mirar. No es un fallo y tampoco es «no había ninguno
   *  abierto»: es la tercera cosa, y en este agente en particular importa —
   *  «no hay emergencias» es una afirmación tranquilizadora que nadie debería
   *  leer si lo que pasó es que no dio tiempo de revisar. El runner la sube a
   *  `saltadosPorReloj` (regla de la #152). */
  sinTurno?: boolean;
}

/** El reloj de la vuelta. Se redefine aquí en vez de importarse de `runner.ts`
 *  por lo mismo que en `leads.ts`: el runner carga ESTE módulo por import
 *  dinámico justo para no pagarlo en cada vuelta, y un import de vuelta
 *  cerraría el ciclo. */
function relojAgotado(venceEn: number | undefined): boolean {
  return venceEn !== undefined && Date.now() >= venceEn;
}

/** El lunes de la semana de `dia`. Anclado a mediodía UTC: el propio cálculo
 *  del día de la semana no puede cruzar de fecha. */
export function lunesDe(dia: string): string {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** `dia` desplazado `n` días (n negativo = hacia atrás). */
export function masDias(dia: string, n: number): string {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** El primero del mes de `dia`. */
export function mesDe(dia: string): string {
  return `${dia.slice(0, 7)}-01`;
}

// ── La pieza hacia la bandeja, con su idempotencia por constraint ──────────

export async function piezaExistente(agente: AgenteDireccionBandeja, titulo: string): Promise<boolean> {
  const { count, error } = await acotada(supabaseAdmin()
    .from('cola_aprobacion')
    .select('id', { count: 'exact', head: true })
    .eq('agente', agente)
    .eq('titulo', titulo), 'direccion.pieza_existente');
  if (error) throw new Error(`piezaExistente(${agente}): ${error.message}`);
  if (typeof count !== 'number') throw new Error(`piezaExistente(${agente}): PostgREST no devolvió el conteo — no se afirma un 0 que nadie midió.`);
  return count > 0;
}

export async function encolarPiezaDireccion(
  agente: AgenteDireccionBandeja, tipo: string, titulo: string, cuerpo: string,
  fuentes: Record<string, unknown>, tenantId?: string | null,
): Promise<'encolada' | 'ya_existia'> {
  try {
    await encolarPieza({ tipo, prioridad: agente === 'especialistas_incidente' ? 'urgente' : 'normal', agente, titulo, cuerpo, fuentes, tenantId: tenantId ?? null });
    return 'encolada';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('duplicate key') || msg.includes('cola_pieza_direccion_por_periodo')) return 'ya_existia';
    throw e;
  }
}

/** Registra la corrida — `registrarCorrida` jamás lanza (contrato 0102).
 *  Tenant NULL: los tres barren la plataforma entera de una pasada. */
export async function anotarCorrida(
  agente: AgenteDireccionBandeja, inicio: Date, estado: 'ok' | 'fallo', disparo: DisparoCorrida,
  resumen: Record<string, unknown>, extra?: { error?: string },
): Promise<void> {
  await registrarCorrida(null, agente, {
    inicio, fin: new Date(), estado, disparo,
    costoUsd: 0,
    ...(estado === 'ok' ? { tareasHechas: 1, tareasTotal: 1 } : { tareasHechas: 0, tareasTotal: 1 }),
    resumen,
    ...(extra?.error ? { error: extra.error } : {}),
  });
}

const PIE_NO_EJECUTA = 'Este parte NO ejecutó nada: ni movió una palanca, ni marcó un teléfono, ni mandó un correo. Es una propuesta y actuar sobre ella es el tap de una persona.';

function yaEstaba(agente: AgenteDireccionBandeja, que: string): ResultadoDireccionBandeja {
  logger.info('direccion_bandeja.ya_existia', { agente });
  return { resultado: 'corrio', piezas: 0, motivo: `${que} ya está en la bandeja`, costoUsd: 0 };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · AUTOMEJORA — la compañía agente mirándose a sí misma.
//
// El blueprint (0125) la definía leyendo los diffs `cuerpo` vs `cuerpo_final`
// para proponer cambios de prompt. Este motor v1 lee algo más urgente y más
// medible: LA TELEMETRÍA DE OPERACIÓN. Con 52 agentes vivos, lo que se rompe
// no es el tono de un prompt — es un agente que lleva una semana fallando en
// silencio, uno que corre todos los días sin producir una sola pieza, o un
// cron que dejó de latir sin que nadie lo notara hasta que llegó la alerta.
//
// LAS CUATRO SEÑALES, TODAS MEDIDAS:
//
//   · FALLOS — corridas con `estado='fallo'` en la ventana, por agente, con
//     el `error` real que la corrida anotó (no un resumen inventado).
//   · CORRIDAS SIN PIEZAS — agentes que corrieron 'ok' y no dejaron NADA en
//     `cola_aprobacion` en toda la ventana. Ojo con la lectura: para muchos
//     agentes eso es CORRECTO (un vigía sin señales no fabrica), así que el
//     parte lo reporta como pregunta, no como falla.
//   · COSTO — el gasto MEDIDO por agente (`costo_usd`, lo que reportó el
//     proveedor). Las corridas con `costo_usd` NULL se cuentan aparte: NULL
//     es «no se midió», y sumarlas como 0 diría que salieron gratis.
//   · CRONS QUE NO LATEN — `estadoLatidos()` (0155), que ya sabe juzgar
//     vencido / sin latido contra la cadencia declarada de cada cron.
//
// LA PALANCA QUE PROPONE es siempre una del catálogo de `INTERRUPTORES`: si
// el nombre que saldría no está en el catálogo, el parte lo dice en vez de
// proponer apagar algo que no se puede apagar.
// ═══════════════════════════════════════════════════════════════════════════

/** Días de telemetría que el parte mira. Siete: una semana cerrada es el
 *  periodo más corto en el que un patrón se distingue de un mal martes. */
export const DIAS_TELEMETRIA = 7;

/** Corridas que una ventana lee como máximo. Si se llena, el parte lo DICE. */
export const TOPE_CORRIDAS = 5_000;

export interface FilaCorrida {
  agente: string;
  estado: string;
  /** `null` = la corrida no midió su costo. NO es cero (estándar §2). */
  costoUsd: number | null;
  error: string | null;
}

export interface SaludAgente {
  agente: string;
  corridas: number;
  fallos: number;
  /** Gasto MEDIDO del periodo. `null` cuando NINGUNA corrida midió: sumar
   *  nulos como cero afirmaría que el agente salió gratis. */
  costoUsd: number | null;
  /** Cuántas corridas no midieron su costo. */
  sinMedir: number;
  /** El último error real que anotó una corrida fallida. */
  ultimoError: string | null;
  /** Piezas que dejó en la bandeja en la ventana. MEDIDO. */
  piezas: number;
}

/** La salud por agente, PURA. Ordenada por fallos descendente y, en empate,
 *  por nombre — determinista para que la misma semana produzca el mismo texto. */
export function saludPorAgente(corridas: FilaCorrida[], piezasPorAgente: Map<string, number>): SaludAgente[] {
  const acc = new Map<string, { corridas: number; fallos: number; costo: number; medidas: number; sinMedir: number; ultimoError: string | null }>();
  for (const c of corridas) {
    const a = acc.get(c.agente) ?? { corridas: 0, fallos: 0, costo: 0, medidas: 0, sinMedir: 0, ultimoError: null };
    a.corridas += 1;
    if (c.estado === 'fallo') {
      a.fallos += 1;
      if (a.ultimoError === null && c.error) a.ultimoError = c.error;
    }
    if (c.costoUsd === null) a.sinMedir += 1;
    else { a.costo += c.costoUsd; a.medidas += 1; }
    acc.set(c.agente, a);
  }
  return [...acc.entries()].map(([agente, a]): SaludAgente => ({
    agente,
    corridas: a.corridas,
    fallos: a.fallos,
    costoUsd: a.medidas === 0 ? null : Math.round(a.costo * 10_000) / 10_000,
    sinMedir: a.sinMedir,
    ultimoError: a.ultimoError,
    piezas: piezasPorAgente.get(agente) ?? 0,
  })).sort((x, y) => y.fallos - x.fallos || y.corridas - x.corridas || x.agente.localeCompare(y.agente));
}

export interface Palanca {
  agente: string;
  /** El id del interruptor, cuando existe en el catálogo. `null` = ese agente
   *  no tiene palanca declarada, que es un hallazgo por sí mismo. */
  interruptor: string | null;
  porque: string;
}

/** Qué palanca proponer, PURO. Solo se propone apagar a quien falló MÁS de la
 *  mitad de sus corridas: un fallo aislado se reintenta solo, y apagar por uno
 *  convertiría el kill switch en un disyuntor con el umbral mal puesto. */
export const UMBRAL_FALLO_PARA_PALANCA = 0.5;

export function palancasPropuestas(salud: SaludAgente[]): Palanca[] {
  return salud
    .filter((s) => s.corridas > 0 && s.fallos / s.corridas > UMBRAL_FALLO_PARA_PALANCA)
    .map((s): Palanca => {
      const id = `agente:${s.agente}`;
      const existe = (INTERRUPTORES as readonly string[]).includes(id);
      return {
        agente: s.agente,
        interruptor: existe ? id : null,
        porque: existe
          ? `falló ${numero(s.fallos)} de ${numero(s.corridas)} corridas de la ventana. Apagarlo en /admin/observabilidad detiene el reintento cada 4 horas mientras se arregla, y no exige un deploy.`
          : `falló ${numero(s.fallos)} de ${numero(s.corridas)} corridas — y NO TIENE PALANCA DECLARADA en el catálogo de interruptores. Eso es un hallazgo mayor que el fallo: un agente autónomo que no se puede apagar no debería estar corriendo, y el candado 1 del runner debería estar saltándoselo.`,
      };
    });
}

/** El cuerpo del parte de automejora. PURO. */
export function armarParteAutomejora(
  salud: SaludAgente[], palancas: Palanca[], latidos: Record<CronId, SaludCron>,
  apagados: string[], desde: string, hasta: string, corridasLeidas: number, truncado: boolean,
): string {
  const l: string[] = [
    `AUTOMEJORA — qué se está rompiendo solo (ventana ${desde} a ${hasta})`,
    '',
  ];

  if (salud.length === 0) {
    l.push('NI UNA SOLA CORRIDA en `agente_corrida` en la ventana.');
    l.push('Eso NO se lee como «todo estuvo tranquilo»: la tabla contestó y vino vacía, y las dos lecturas posibles son «ningún agente corrió en siete días» y «los agentes corrieron y no anotaron su corrida». La primera significa que el cron del runner está muerto; la segunda, que la telemetría lo está. Las dos son la noticia principal de este parte.');
  } else {
    const conFallos = salud.filter((s) => s.fallos > 0);
    l.push(`Agentes con actividad en la ventana: ${numero(salud.length)}. Corridas leídas: ${numero(corridasLeidas)}.`);
    l.push('');
    if (conFallos.length === 0) {
      l.push('SIN UN SOLO FALLO en la ventana. Es un resultado medido sobre las corridas que SÍ se anotaron, no una afirmación sobre las que no.');
    } else {
      l.push('LO QUE ESTÁ FALLANDO (con el error que la propia corrida anotó, sin resumir):');
      for (const s of conFallos.slice(0, 20)) {
        l.push(`  · ${s.agente} — ${numero(s.fallos)} fallo(s) de ${numero(s.corridas)} corrida(s)`);
        if (s.ultimoError) l.push(`     último error: ${s.ultimoError.slice(0, 300)}`);
      }
      if (conFallos.length > 20) l.push(`  … y ${numero(conFallos.length - 20)} agente(s) más con fallos, no listados aquí.`);
    }

    const mudos = salud.filter((s) => s.fallos === 0 && s.piezas === 0);
    l.push('');
    if (mudos.length === 0) {
      l.push('TODOS LOS QUE CORRIERON SIN FALLAR DEJARON AL MENOS UNA PIEZA.');
    } else {
      l.push('CORRIERON SIN FALLAR Y NO DEJARON NI UNA PIEZA (esto es una PREGUNTA, no una acusación):');
      for (const s of mudos.slice(0, 20)) {
        l.push(`  · ${s.agente} — ${numero(s.corridas)} corrida(s) 'ok', 0 piezas en la bandeja.`);
      }
      if (mudos.length > 20) l.push(`  … y ${numero(mudos.length - 20)} más.`);
      l.push('  POR QUÉ ES UNA PREGUNTA: para varios agentes esto es el comportamiento CORRECTO — un vigía sin señales, un cazador sin celdas nuevas o un preparador de demos sin demos agendadas no tienen nada que fabricar, y fabricar algo para no salir en esta lista sería peor. La pregunta que este parte deja es si alguno de estos debería haber producido y su guarda lo está frenando de más.');
    }

    l.push('');
    l.push('EL GASTO MEDIDO (lo que reportó el proveedor del modelo, no una estimación):');
    const conCosto = salud.filter((s) => s.costoUsd !== null && (s.costoUsd as number) > 0)
      .sort((a, b) => (b.costoUsd as number) - (a.costoUsd as number));
    if (conCosto.length === 0) {
      l.push('  Ninguna corrida de la ventana midió un gasto mayor que cero. La mayoría de los agentes de la casa son deterministas y anotan 0 MEDIDO; los que gastan modelo son pocos.');
    } else {
      for (const s of conCosto.slice(0, 10)) {
        l.push(`  · ${s.agente} — ${usd(s.costoUsd as number)} en ${numero(s.corridas)} corrida(s)`);
      }
    }
    const sinMedir = salud.filter((s) => s.sinMedir > 0);
    if (sinMedir.length > 0) {
      l.push(`  CORRIDAS SIN COSTO MEDIDO: ${numero(sinMedir.reduce((n, s) => n + s.sinMedir, 0))}, en ${numero(sinMedir.length)} agente(s) (${sinMedir.slice(0, 6).map((s) => s.agente).join(', ')}${sinMedir.length > 6 ? '…' : ''}). NULL no es cero: significa que la corrida no anotó lo que gastó, así que el total de arriba es un PISO del gasto real, no el gasto.`);
    }
  }

  l.push('');
  l.push('LOS CRONS Y SU LATIDO:');
  const problemas = (Object.keys(latidos) as CronId[]).filter((c) => latidos[c].estado !== 'ok');
  if (problemas.length === 0) {
    l.push(`  Los ${numero(CRONS.length)} crons declarados laten dentro de su cadencia.`);
  } else {
    for (const c of problemas) {
      const s = latidos[c];
      l.push(s.estado === 'sin_latido'
        ? `  · \`${c}\` — SIN UN SOLO LATIDO REGISTRADO. Eso no es «lleva mucho sin correr»: es que nunca escribió uno, y las dos causas típicas son que el cron no está dado de alta o que muere antes de llegar a registrar el latido.`
        : `  · \`${c}\` — VENCIDO: ${s.haceMin === null ? 'sin minutos que contar' : `hace ${numero(s.haceMin)} minuto(s)`}, último estado \`${s.ultimoEstado ?? 'desconocido'}\`.`);
    }
  }

  l.push('');
  l.push('QUÉ PALANCA MOVER:');
  if (palancas.length === 0) {
    l.push(`  NINGUNA. Ningún agente falló más del ${numero(Math.round(UMBRAL_FALLO_PARA_PALANCA * 100))}% de sus corridas, que es el umbral declarado para proponer un apagón. Un fallo aislado se reintenta solo en la próxima pasada del runner; apagar por uno convertiría el kill switch en un disyuntor con el umbral mal puesto.`);
  } else {
    for (const p of palancas) {
      l.push(p.interruptor === null
        ? `  · ${p.agente} — ⚠️ ${p.porque}`
        : `  · Apagar \`${p.interruptor}\` — ${p.porque}`);
    }
  }
  if (apagados.length > 0) {
    l.push(`  YA APAGADOS AHORA MISMO: ${apagados.join(', ')}. Si alguno lleva apagado más de lo que duró el incidente que lo apagó, encenderlo también es una decisión pendiente.`);
  }

  if (truncado) {
    l.push('');
    l.push(`VENTANA TRUNCADA A ${numero(TOPE_CORRIDAS)} CORRIDAS: la semana tuvo más de las que este parte alcanzó a leer. Todo lo de arriba se afirma sobre las leídas; los conteos son un PISO, no el total.`);
  }

  l.push('');
  l.push('LO QUE ESTE PARTE NO MIRA (y hay que decirlo): no lee los diffs de `cuerpo` contra `cuerpo_final` ni los motivos de rechazo, que es lo que el blueprint de este agente pedía para proponer cambios de prompt. Eso exige un corpus de rechazos que hoy no existe con volumen suficiente, y un patrón sacado de tres casos sería una superstición con porcentajes.');
  l.push('Fuentes: `agente_corrida` (ventana cerrada, con su costo MEDIDO) · `cola_aprobacion` (piezas por agente en la ventana) · `cron_latido` vía el juez de cadencias (0155) · el catálogo de `interruptor`.');
  l.push(PIE_NO_EJECUTA);
  return l.join('\n');
}

/** Las corridas de la ventana. LANZA ante error: un parte de salud sobre una
 *  tabla ciega afirmaría «no falló nada». */
async function leerCorridas(desdeIso: string, hastaIso: string): Promise<{ filas: FilaCorrida[]; truncado: boolean }> {
  const { data, error, count } = await acotada(supabaseAdmin()
    .from('agente_corrida')
    .select('agente, estado, costo_usd, error', { count: 'exact' })
    .gte('inicio', desdeIso)
    .lt('inicio', hastaIso)
    .order('inicio', { ascending: false })
    .limit(TOPE_CORRIDAS), 'direccion.automejora.corridas');
  if (error) throw new Error(`leerCorridas: ${error.message}`);
  const crudas = (data ?? []) as Array<Record<string, unknown>>;
  const truncado = typeof count === 'number' ? count > crudas.length : crudas.length >= TOPE_CORRIDAS;
  return {
    filas: crudas.map((f): FilaCorrida => ({
      agente: String(f.agente),
      estado: String(f.estado),
      // NULL se preserva: `Number(null)` es 0 y aquí un 0 diría «salió gratis».
      costoUsd: f.costo_usd === null || f.costo_usd === undefined ? null : Number(f.costo_usd),
      error: (f.error as string | null) ?? null,
    })),
    truncado,
  };
}

/** Piezas por agente en la ventana. LANZA ante error: un mapa vacío por fallo
 *  pondría a TODOS los agentes en «corrió y no produjo». */
async function leerPiezasPorAgente(desdeIso: string, hastaIso: string): Promise<Map<string, number>> {
  const mapa = new Map<string, number>();
  const { data, error } = await acotada(supabaseAdmin()
    .from('cola_aprobacion')
    .select('agente')
    .gte('creado_en', desdeIso)
    .lt('creado_en', hastaIso)
    .limit(TOPE_CORRIDAS), 'direccion.automejora.piezas');
  if (error) throw new Error(`leerPiezasPorAgente: ${error.message}`);
  for (const f of (data ?? []) as Array<{ agente: string }>) {
    mapa.set(f.agente, (mapa.get(f.agente) ?? 0) + 1);
  }
  return mapa;
}

/** Los interruptores ya apagados. LANZA ante error: proponer apagar algo que
 *  YA está apagado haría que el parte se contradijera con la pantalla. */
async function leerApagados(): Promise<string[]> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('interruptor')
    .select('id')
    .eq('apagado', true)
    .limit(200), 'direccion.automejora.apagados');
  if (error) throw new Error(`leerApagados: ${error.message}`);
  return ((data ?? []) as Array<{ id: string }>).map((f) => f.id).sort();
}

async function correrAutomejora(disparo: DisparoCorrida, hoy: string): Promise<ResultadoDireccionBandeja> {
  const inicio = new Date();
  const agente = 'automejora';
  const lunes = lunesDe(hoy);
  const desde = masDias(lunes, -DIAS_TELEMETRIA);
  const titulo = `Automejora — semana del ${desde}`;
  try {
    if (await piezaExistente(agente, titulo)) {
      await anotarCorrida(agente, inicio, 'ok', disparo, { pieza: 'ya_existia', titulo });
      return yaEstaba(agente, 'el parte de telemetría de la semana cerrada');
    }
    const desdeIso = inicioDiaMx(desde);
    const hastaIso = inicioDiaMx(lunes);
    const [{ filas, truncado }, piezas, apagados, latidos] = await Promise.all([
      leerCorridas(desdeIso, hastaIso),
      leerPiezasPorAgente(desdeIso, hastaIso),
      leerApagados(),
      estadoLatidos(),
    ]);
    const salud = saludPorAgente(filas, piezas);
    const palancas = palancasPropuestas(salud);
    const cuerpo = armarParteAutomejora(salud, palancas, latidos, apagados, desde, masDias(lunes, -1), filas.length, truncado);
    const res = await encolarPiezaDireccion(agente, 'parte_automejora', titulo, cuerpo, {
      ventana: { desde, hasta: lunes },
      agentes: salud.length,
      corridas: filas.length,
      fallos: salud.reduce((n, s) => n + s.fallos, 0),
      palancas: palancas.map((p) => p.interruptor ?? `${p.agente} (sin palanca)`),
      crons_con_problema: (Object.keys(latidos) as CronId[]).filter((c) => latidos[c].estado !== 'ok'),
      truncado,
      consultas: ['agente_corrida (ventana cerrada)', 'cola_aprobacion (piezas por agente)', 'cron_latido', 'interruptor'],
    });
    await anotarCorrida(agente, inicio, 'ok', disparo, { pieza: res, agentes: salud.length, corridas: filas.length, palancas: palancas.length });
    return { resultado: 'corrio', piezas: res === 'encolada' ? 1 : 0, motivo: res === 'ya_existia' ? 'otra corrida ganó la semana' : undefined, costoUsd: 0 };
  } catch (e) {
    await anotarCorrida(agente, inicio, 'fallo', disparo, { titulo }, {
      error: `No se pudo armar el parte de automejora: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500),
    });
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2 · ESPECIALISTAS DE INCIDENTE — a quién llamar y con qué datos.
//
// LIKIDA NUNCA MARCA. Está escrito en la 0198 y aquí se respeta a la letra:
// «una llamada automática abre un siniestro, que es dinero y acto jurídico».
// Este agente pone el dato EN LA MANO del humano y se hace a un lado.
//
// LA REGLA DEL TELÉFONO. Cada número del parte sale de una fila de la base y
// se rotula con lo que la base sabe de él:
//   · `flota_poliza.telefono_siniestros` — el 800 de la aseguradora.
//   · `proveedor_emergencia.telefono` — con `verificado_en`: NULL se imprime
//     como «CAPTURADO PERO NO VERIFICADO», nunca se calla.
//
// AUDITORÍA 28 (LEG-A5, ALTO, REINCIDENTE): este agente YA NO lee ni imprime
// `contacto_emergencia` de ningún operador. Hasta la 28, la línea de familia
// SOLO existía cuando `hay_lesionados === true` — su sola PRESENCIA en el
// parte (que se encola en `cola_aprobacion`, bandeja interna sin purga ni
// alcance ARCO) delataba el dato de salud del operador, con nombre completo,
// aunque el texto dijera «no se reproduce el dato». Ocultar el valor no
// bastaba si la EXISTENCIA del renglón ya lo afirmaba. El parte ahora imprime
// SIEMPRE la misma línea neutra que remite al expediente — con o sin
// lesionados, con o sin contactos capturados — y no consulta la tabla: no
// leer un dato personal que el parte no va a poder usar es minimización
// (LFPDPPP), no una optimización.
//
// A QUÉ INCIDENTES ATIENDE: los de tipo de emergencia (0198) que siguen sin
// resolver. Un `retraso` no necesita un especialista; un `siniestro` sí.
// ═══════════════════════════════════════════════════════════════════════════

/** Los tipos de incidencia que son emergencia (0198). Un retraso o un
 *  faltante se atienden por el circuito normal de operación. */
export const TIPOS_EMERGENCIA: readonly string[] = ['siniestro', 'robo', 'emergencia_medica', 'varado', 'bloqueo'];

/** Qué proveedor pide cada tipo de emergencia. La correspondencia es
 *  declarativa a propósito: el catálogo de `proveedor_emergencia.tipo` (0198)
 *  tiene cinco valores y ninguno se inventa aquí. `null` = para este tipo no
 *  hay un proveedor obvio y el parte no va a fingir uno. */
export const PROVEEDOR_POR_TIPO: Record<string, string[]> = {
  siniestro: ['grua', 'medico'],
  robo: [],
  emergencia_medica: ['medico'],
  varado: ['grua', 'mecanico', 'llantera'],
  bloqueo: [],
};

export interface Telefono {
  quien: string;
  numero: string;
  /** Qué tan comprobado está. Sale de la base, no de una opinión. */
  respaldo: string;
}

export interface Incidente {
  id: string;
  tenantId: string;
  tipo: string;
  prioridad: string;
  estado: string;
  descripcion: string | null;
  abiertaEn: string;
  /** `null` = NO PREGUNTADO (0198). Jamás se lee como `false`. */
  hayLesionados: boolean | null;
  unidadMovible: boolean | null;
  reconocidaEn: string | null;
  nivelEscalado: number;
  operadorId: string | null;
  operadorNombre: string | null;
  unidadEconomico: string | null;
  flota: string;
  poliza: { aseguradora: string; numeroPoliza: string; telefono: string; vigenciaHasta: string | null } | null;
  proveedores: Array<{ tipo: string; nombre: string; telefono: string; verificadoEn: string | null }>;
}

/** La lista de a quién llamar, PURA. El orden es el del protocolo, no el de
 *  la base: primero quien atiende a la persona, luego quien mueve el fierro,
 *  luego quien paga. */
export function aQuienLlamar(inc: Incidente): Telefono[] {
  const t: Telefono[] = [];

  // AUDITORÍA 28 (LEG-A5, ALTO, REINCIDENTE): esta función solía incluir a la
  // familia del operador SOLO con lesionados CONFIRMADOS — y esa condición es
  // justo el problema: la sola PRESENCIA del renglón delataba el dato de
  // salud a quien leyera `cola_aprobacion` (bandeja sin purga ni alcance
  // ARCO), aunque el texto ocultara nombre y número. `aQuienLlamar` tiene un
  // único consumidor (`armarParteIncidente`, grep verificado en la 28): la
  // línea neutra sobre contactos de emergencia ahora vive ahí, fija, sin
  // depender de `hayLesionados` — no en esta lista.

  // 1. La aseguradora — el 800 de siniestros es EL dato de la 0198.
  if (inc.poliza !== null) {
    const venc = inc.poliza.vigenciaHasta;
    t.push({
      quien: `${inc.poliza.aseguradora} — siniestros (póliza ${inc.poliza.numeroPoliza})`,
      numero: inc.poliza.telefono,
      respaldo: venc === null
        ? 'flota_poliza. La póliza NO tiene fecha de vigencia capturada: no se puede afirmar que esté vigente, y tampoco que no. Confírmalo antes de reportar.'
        : `flota_poliza. Vigencia capturada hasta el ${fechaMx(venc)}.`,
    });
  }

  // 2. Los proveedores que este tipo de emergencia pide.
  const pide = PROVEEDOR_POR_TIPO[inc.tipo] ?? [];
  for (const tipo of pide) {
    for (const p of inc.proveedores.filter((x) => x.tipo === tipo)) {
      t.push({
        quien: `${p.nombre} (${p.tipo})`,
        numero: p.telefono,
        respaldo: p.verificadoEn === null
          ? 'proveedor_emergencia — CAPTURADO PERO NO VERIFICADO: nadie ha confirmado por teléfono que este número siga siendo de este proveedor.'
          : `proveedor_emergencia — verificado el ${fechaMx(p.verificadoEn)}.`,
      });
    }
  }
  return t;
}

/** El cuerpo del parte de incidente. PURO. */
export function armarParteIncidente(inc: Incidente, telefonos: Telefono[], dia: string): string {
  const l: string[] = [
    `INCIDENTE ABIERTO — ${inc.flota} · ${inc.tipo} (parte al ${dia})`,
    '',
    `Expediente abierto el ${fechaHoraMx(inc.abiertaEn)} · prioridad \`${inc.prioridad}\` · estado \`${inc.estado}\` · nivel de escalado ${numero(inc.nivelEscalado)}.`,
    inc.reconocidaEn === null
      ? 'NADIE LO HA RECONOCIDO todavía: no hay `reconocida_en` en el expediente. Si alguien ya está encima, el sistema no se enteró.'
      : `Reconocido el ${fechaHoraMx(inc.reconocidaEn)}.`,
    '',
    'LO QUE SE SABE (y lo que NO se preguntó):',
    `  · Operador: ${inc.operadorNombre ?? 'NO CONSTA en el expediente'}`,
    `  · Unidad: ${inc.unidadEconomico ?? 'NO CONSTA en el expediente'}`,
    // AUDITORÍA 24, LEG-5: este parte se encola en `cola_aprobacion` — la
    // bandeja INTERNA de Likida, no un canal en tiempo real hacia quien
    // responde la emergencia. Reproducir aquí la descripción cruda del
    // incidente (que puede llevar datos de salud) y los teléfonos de
    // contactos de emergencia (que pueden ser familiares) sacaba ese dato
    // sensible de la base del tenant hacia la bandeja de Likida, sin
    // purga ni alcance de la cancelación ARCO — remite al expediente en
    // vez de repetirlo.
    `  · Descripción: revísala en el panel de tu flota (expediente ${inc.id}) — este parte no la reproduce.`,
    // AUDITORÍA 28 (LEG-A5, ALTO, REINCIDENTE): esta línea se imprime SIEMPRE
    // — con o sin lesionados, con o sin contactos capturados — precisamente
    // para que su EXISTENCIA no delate si hay lesionados. Antes, el renglón
    // de familia solo aparecía cuando `hayLesionados === true`: su sola
    // presencia en `cola_aprobacion` (bandeja sin purga ni alcance ARCO) era
    // el dato de salud, aunque el texto no lo dijera con todas sus letras.
    `  · Contactos de emergencia del operador: en el expediente ${inc.id}, en el panel de la flota — el parte no los reproduce ni dice si procede avisarles.`,
  ];
  // AUDITORÍA 25 (ALTO, REINCIDENTE): el estado de salud es dato SENSIBLE
  // (LFPDPPP art. 2 fr. VI, agravado por el art. 59 fr. IV) y esta pieza
  // vive en `cola_aprobacion`, sin alcance de purga ni de ARCO — mismo
  // criterio que la descripción, arriba: se remite al expediente en vez de
  // afirmar el valor aquí. El caso NULL se queda igual: "no se preguntó" no
  // es un dato de salud, es la ausencia de uno.
  l.push(inc.hayLesionados === null
    ? '  · ¿Hay lesionados? NO SE PREGUNTÓ. La columna está en NULL, y NULL aquí significa exactamente eso — no significa «no hay». Es la PRIMERA pregunta de la llamada.'
    : `  · ¿Hay lesionados? Ya se contestó en el expediente (${inc.id}) — revísalo en el panel de tu flota; este parte no reproduce el dato de salud.`);
  l.push(inc.unidadMovible === null
    ? '  · ¿La unidad se puede mover? NO SE PREGUNTÓ. De la respuesta depende si hace falta grúa.'
    : inc.unidadMovible
      ? '  · ¿La unidad se puede mover? SÍ.'
      : '  · ¿La unidad se puede mover? NO — hace falta grúa.');

  l.push('');
  l.push('A QUIÉN HAY QUE LLAMAR (todos estos números salen de la base de esta flota; ni uno se buscó afuera ni se dedujo):');
  if (telefonos.length === 0) {
    l.push('  NO HAY UN SOLO TELÉFONO CAPTURADO PARA ESTE INCIDENTE.');
    l.push('  Esto NO es «no hay a quién llamar»: es que esta flota no tiene póliza registrada en `flota_poliza` ni proveedores en `proveedor_emergencia`, o el tipo de emergencia no tiene proveedor asociado. Un número inventado aquí sería peor que no tener ninguno — mandaría a alguien a marcar a un desconocido en el peor momento.');
    l.push('  EL SIGUIENTE PASO ES DE UNA PERSONA: capturar el 800 de siniestros de la aseguradora y al menos una grúa de la zona, y volver a mirar este expediente.');
  } else {
    // AUDITORÍA 28 (LEG-A5): `aQuienLlamar` ya no devuelve contactos
    // familiares (ver su cabecera) — todo lo que llega aquí es aseguradora y
    // proveedores, contactos de negocio necesarios para que esta pieza sirva
    // de verdad en una emergencia, y se reproducen sin remitir a ningún
    // expediente.
    for (let i = 0; i < telefonos.length; i++) {
      const t = telefonos[i];
      l.push(`  ${numero(i + 1)}. ${t.quien}`);
      l.push(`     tel: ${t.numero}`);
      l.push(`     respaldo: ${t.respaldo}`);
    }
  }

  l.push('');
  l.push('QUÉ DECIR AL LLAMAR (los datos del expediente, para no tener que buscarlos):');
  l.push(`  · Flota: ${inc.flota}`);
  l.push(`  · Póliza: ${inc.poliza ? `${inc.poliza.numeroPoliza} con ${inc.poliza.aseguradora}` : 'NO CONSTA — la flota no tiene póliza capturada'}`);
  l.push(`  · Unidad: ${inc.unidadEconomico ?? 'NO CONSTA'}`);
  l.push(`  · Operador: ${inc.operadorNombre ?? 'NO CONSTA'}`);
  l.push(`  · Hora de apertura: ${fechaHoraMx(inc.abiertaEn)}`);

  l.push('');
  l.push('LIKIDA NO MARCÓ Y NO VA A MARCAR. Está escrito en la migración que creó estas tablas: una llamada automática abre un siniestro, y un siniestro es dinero y un acto jurídico. Este parte deja el dato en la mano; marcar es de una persona.');
  l.push('Fuentes: `incidencia` (expediente abierto) · `flota_poliza` · `proveedor_emergencia` (con su marca de verificación) · `operador` · `unidad`. Los contactos de emergencia del operador viven en el expediente — este parte no los consulta.');
  return l.join('\n');
}

/** El título es determinista POR EXPEDIENTE: un parte por incidente, no uno
 *  por día — el índice único de la 0235 impide que dos pasadas lo dupliquen, y
 *  un incidente que sigue abierto mañana no necesita un parte nuevo con los
 *  mismos teléfonos. */
export function tituloIncidente(incidenciaId: string): string {
  return `Incidente — expediente ${incidenciaId}`;
}

/** El incidente de emergencia abierto más urgente sin parte. LANZA ante
 *  error. `null` = no hay ninguno. */
async function incidenteSinParte(venceEn?: number): Promise<{ incidente: Incidente | null; sinTurno: boolean }> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('incidencia')
    .select('id, tenant_id, tipo, prioridad, estado, descripcion, abierta_en, hay_lesionados, unidad_movible, reconocida_en, nivel_escalado, operador_id, operador:operador_id(nombre), unidad:unidad_id(numero_economico), flota:tenant_id(nombre)')
    .in('tipo', TIPOS_EMERGENCIA)
    .neq('estado', 'resuelta')
    .order('abierta_en', { ascending: true })
    .limit(30), 'direccion.incidente.abiertos');
  if (error) throw new Error(`incidenteSinParte: ${error.message}`);
  const filas = (data ?? []) as Array<Record<string, unknown>>;
  for (const f of filas) {
    // Una consulta a la bandeja POR EXPEDIENTE: con 30 incidentes ya
    // reportados, buscar el que falta cuesta 30 idas a la base. El reloj de la
    // vuelta manda sobre la búsqueda igual que sobre el despacho (#152).
    if (relojAgotado(venceEn)) return { incidente: null, sinTurno: true };
    const id = String(f.id);
    if (await piezaExistente('especialistas_incidente', tituloIncidente(id))) continue;
    const tenantId = String(f.tenant_id);
    const operadorId = (f.operador_id as string | null) ?? null;
    const hayLesionados = f.hay_lesionados === null || f.hay_lesionados === undefined ? null : f.hay_lesionados === true;
    // AUDITORÍA 28 (LEG-A5): ya no se lee `contacto_emergencia` aquí — el
    // parte no consulta ni reproduce contactos familiares (ver la cabecera de
    // la sección 2 y de `aQuienLlamar`). `operadorId` se conserva en el tipo
    // porque otros consumidores del expediente sí lo usan.
    const [poliza, proveedores] = await Promise.all([
      leerPoliza(tenantId),
      leerProveedores(tenantId),
    ]);
    const op = f.operador as { nombre?: string } | null;
    const un = f.unidad as { numero_economico?: string } | null;
    const fl = f.flota as { nombre?: string } | null;
    return { sinTurno: false, incidente: {
      id, tenantId,
      tipo: String(f.tipo),
      prioridad: String(f.prioridad),
      estado: String(f.estado),
      descripcion: (f.descripcion as string | null) ?? null,
      abiertaEn: String(f.abierta_en),
      hayLesionados,
      unidadMovible: f.unidad_movible === null || f.unidad_movible === undefined ? null : f.unidad_movible === true,
      reconocidaEn: (f.reconocida_en as string | null) ?? null,
      nivelEscalado: Number(f.nivel_escalado ?? 0),
      operadorId,
      operadorNombre: op?.nombre?.trim() || null,
      unidadEconomico: un?.numero_economico?.trim() || null,
      flota: fl?.nombre?.trim() || `flota ${tenantId}`,
      poliza, proveedores,
    } };
  }
  return { incidente: null, sinTurno: false };
}

async function leerPoliza(tenantId: string): Promise<Incidente['poliza']> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('flota_poliza')
    .select('aseguradora, numero_poliza, telefono_siniestros, vigencia_hasta')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(1), 'direccion.incidente.poliza');
  if (error) throw new Error(`leerPoliza: ${error.message}`);
  const f = ((data ?? []) as Array<Record<string, unknown>>)[0];
  if (!f) return null;
  return {
    aseguradora: String(f.aseguradora),
    numeroPoliza: String(f.numero_poliza),
    telefono: String(f.telefono_siniestros),
    vigenciaHasta: (f.vigencia_hasta as string | null) ?? null,
  };
}

async function leerProveedores(tenantId: string): Promise<Incidente['proveedores']> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('proveedor_emergencia')
    .select('tipo, nombre, telefono, verificado_en')
    .eq('tenant_id', tenantId)
    .limit(100), 'direccion.incidente.proveedores');
  if (error) throw new Error(`leerProveedores: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((f) => ({
    tipo: String(f.tipo),
    nombre: String(f.nombre),
    telefono: String(f.telefono),
    verificadoEn: (f.verificado_en as string | null) ?? null,
    // Los verificados primero: si hay dos grúas y una está confirmada, esa es
    // la que se marca antes.
  })).sort((a, b) => Number(a.verificadoEn === null) - Number(b.verificadoEn === null) || a.nombre.localeCompare(b.nombre));
}

async function correrEspecialistasIncidente(disparo: DisparoCorrida, hoy: string, venceEn?: number): Promise<ResultadoDireccionBandeja> {
  const inicio = new Date();
  const agente = 'especialistas_incidente';
  try {
    const { incidente: inc, sinTurno } = await incidenteSinParte(venceEn);
    if (inc === null) {
      await anotarCorrida(agente, inicio, 'ok', disparo, { pieza: sinTurno ? 'sin_turno' : 'sin_incidente' });
      // AQUÍ LA DISTINCIÓN NO ES ACADÉMICA: «ningún incidente abierto» es una
      // frase que tranquiliza, y nadie debería leerla cuando lo que pasó es que
      // no dio tiempo de revisar los expedientes.
      return sinTurno
        ? {
            resultado: 'corrio', piezas: 0, costoUsd: 0, sinTurno: true,
            motivo: 'el reloj de la vuelta se agotó buscando expediente — quedaron incidentes sin revisar; esto NO significa que no haya ninguno abierto',
          }
        : {
            resultado: 'corrio', piezas: 0, costoUsd: 0,
            motivo: 'ningún incidente de emergencia abierto sin parte — es el estado normal, no un fallo',
          };
    }
    const telefonos = aQuienLlamar(inc);
    // La pieza lleva el tenant del incidente: es de esa flota y así se ve en
    // la bandeja. Los teléfonos NO viajan en `fuentes` — el cuerpo ya los
    // lleva para quien lo lee, y duplicarlos en el jsonb de trazabilidad
    // esparciría datos personales por una columna que nadie mira.
    //
    // AUDITORÍA 25 (ALTO, REINCIDENTE): por la misma razón, `lesionados`
    // (dato de salud, art. 2 fr. VI) NO viaja aquí — se retiró. `fuentes`
    // es de `cola_aprobacion`, sin alcance de purga ni de ARCO; `hay_lesionados`
    // SÍ vive dentro de ese ciclo en `incidencia`, que es de donde se lee.
    const res = await encolarPiezaDireccion(agente, 'parte_incidente', tituloIncidente(inc.id), armarParteIncidente(inc, telefonos, hoy), {
      incidencia: inc.id,
      tipo: inc.tipo,
      prioridad: inc.prioridad,
      telefonos_disponibles: telefonos.length,
      con_poliza: inc.poliza !== null,
      consultas: ['incidencia (emergencias sin resolver)', 'flota_poliza', 'proveedor_emergencia'],
    }, inc.tenantId);
    await anotarCorrida(agente, inicio, 'ok', disparo, { pieza: res, incidencia: inc.id, telefonos: telefonos.length });
    return { resultado: 'corrio', piezas: res === 'encolada' ? 1 : 0, motivo: res === 'ya_existia' ? 'otra corrida ganó el expediente' : undefined, costoUsd: 0 };
  } catch (e) {
    await anotarCorrida(agente, inicio, 'fallo', disparo, {}, {
      error: `No se pudo armar el parte de incidente: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500),
    });
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3 · FUNDRAISING — las cifras que existen, y la lista de las que no.
//
// LA MITAD DE ESTE PARTE ES LA LISTA DE HUECOS, y es la mitad que importa. Un
// investor update que solo enseña lo que sí hay es el que hace que en la
// segunda llamada alguien pregunte por el churn y no haya respuesta. Aquí las
// dos listas van juntas y la de huecos va con su razón.
//
// EL MRR SE CALCULA COMO EN `finanzas.ts` Y POR LA MISMA RAZÓN: suma de
// `plan.precio_mensual` sobre las suscripciones ACTIVAS, y si una sola activa
// tiene el precio en NULL el resultado entero es NULL — no un MRR parcial. Un
// MRR al que le falta un cliente no es un MRR conservador: es un número que
// alguien va a citar en una junta de consejo.
//
// LO QUE ESTE PARTE JAMÁS VA A TRAER: proyecciones, TAM, runway, CAC, LTV y
// crecimiento mes contra mes. Ninguno se puede derivar de lo que hay, y los
// cinco son exactamente las cifras que un deck inventa primero.
// ═══════════════════════════════════════════════════════════════════════════

export interface Suscripciones {
  /** Por estado del dominio de la 0052. Conteo MEDIDO. */
  porEstado: Array<{ estado: string; n: number }>;
  /** Las activas, con el precio de su plan. `precio` NULL = sin declarar. */
  activas: Array<{ plan: string; precio: number | null }>;
}

export interface CifrasFundraising {
  flotas: number;
  suscripciones: Suscripciones;
  /** Facturas SaaS pagadas y su suma, ventana histórica completa. */
  facturasPagadas: number;
  cobradoMxn: number;
  /** Pipeline por etapa del CRM. Conteo MEDIDO. */
  pipeline: Array<{ etapa: string; n: number }>;
  /** Viajes procesados por el motor, histórico. */
  liquidaciones: number;
  /** Alguna de las dos lecturas agregadas no cupo entera. Un investor update
   *  con una cifra truncada sin decirlo es peor que uno sin la cifra. */
  truncado: boolean;
}

export interface Mrr {
  /** `null` = INDETERMINADO. Ver la cabecera: no es cero y no es parcial. */
  mxn: number | null;
  activas: number;
  sinPrecio: number;
  motivo: string | null;
}

/** El MRR, PURO. */
export function calcularMrr(activas: Array<{ plan: string; precio: number | null }>): Mrr {
  const sinPrecio = activas.filter((a) => a.precio === null);
  if (activas.length === 0) {
    return {
      mxn: null, activas: 0, sinPrecio: 0,
      motivo: 'NO HAY UNA SOLA SUSCRIPCIÓN ACTIVA. El MRR de cero suscripciones no es «$0 de MRR»: es que todavía no hay negocio recurrente que medir. Decir «$0» invitaría a leerlo como una caída desde algo.',
    };
  }
  if (sinPrecio.length > 0) {
    return {
      mxn: null, activas: activas.length, sinPrecio: sinPrecio.length,
      motivo: `INDETERMINADO: ${numero(sinPrecio.length)} de ${numero(activas.length)} suscripción(es) activas están en un plan con \`precio_mensual\` NULL (${[...new Set(sinPrecio.map((a) => a.plan))].join(', ')}). Sumar solo las que sí tienen precio daría un MRR al que le faltan clientes — y ese número acabaría citado en una junta como si fuera el total.`,
    };
  }
  return {
    mxn: Math.round(activas.reduce((s, a) => s + (a.precio as number), 0) * 100) / 100,
    activas: activas.length, sinPrecio: 0, motivo: null,
  };
}

/** Las cifras que NO existen todavía, con su razón. PURO y declarativo: la
 *  lista es el contrato del parte, no una nota al pie. */
export const HUECOS: ReadonlyArray<{ metrica: string; porque: string }> = [
  { metrica: 'Churn', porque: 'exige al menos dos periodos con clientes de pago para comparar bajas contra base. `suscripcion.cancelada_en` existe, pero sin historia suficiente el porcentaje sería una división entre números de un solo dígito.' },
  { metrica: 'CAC (costo de adquisición)', porque: 'no hay una sola tabla de gasto de marketing ni de nómina comercial en esta base. Estimarlo exigiría inventar el numerador.' },
  { metrica: 'LTV', porque: 'se deriva del churn y del ticket promedio. Sin el primero, el segundo no alcanza.' },
  { metrica: 'Runway', porque: 'exige saldo en banco y burn mensual. Ninguno de los dos está en esta base: `llm_costo_mensual` mide el gasto de modelo, que es una fracción del burn, no el burn.' },
  { metrica: 'TAM / SAM / SOM', porque: 'es una estimación de mercado, no una lectura. Este parte solo cuenta filas que existen; un TAM sacado de aquí sería un número con cara de dato.' },
  { metrica: 'Crecimiento mes contra mes', porque: 'exige una serie con al menos dos meses de cifras estables. Cuando la haya, sale de `factura_saas` sin que nadie tenga que estimarla.' },
];

/** El cuerpo del parte. PURO. */
export function armarParteFundraising(c: CifrasFundraising, mrr: Mrr, mes: string): string {
  const l: string[] = [
    `FUNDRAISING — el parte de métricas del mes ${mes.slice(0, 7)}`,
    '',
    'LAS CIFRAS REALES (cada una es un conteo o una suma sobre filas que existen; ninguna está estimada):',
    '',
    'INGRESO RECURRENTE',
  ];
  l.push(mrr.mxn === null
    ? `  · MRR: SIN CIFRA. ${mrr.motivo}`
    : `  · MRR: ${mxn(mrr.mxn)} MXN sobre ${numero(mrr.activas)} suscripción(es) activa(s), sumando el \`precio_mensual\` declarado de cada plan.`);
  l.push(`  · Cobrado histórico (facturas SaaS en estado 'pagada'): ${mxn(c.cobradoMxn)} MXN en ${numero(c.facturasPagadas)} factura(s). Esto es dinero que de verdad entró, no facturado.`);

  l.push('');
  l.push('CLIENTES');
  l.push(`  · Flotas dadas de alta en la plataforma: ${numero(c.flotas)}.`);
  if (c.suscripciones.porEstado.length === 0) {
    l.push('  · Suscripciones: NI UNA SOLA FILA en `suscripcion`. Eso no es «cero clientes de pago», es que nadie ha creado una suscripción todavía — el alta de una flota y su suscripción son dos cosas distintas.');
  } else {
    l.push(`  · Suscripciones por estado: ${c.suscripciones.porEstado.map((s) => `${s.estado} ${numero(s.n)}`).join(' · ')}.`);
    l.push('    OJO CON LA LECTURA: `prueba` no es cliente de pago y `morosa` sí lo era. Los dos cuentan distinto en cualquier conversación de inversión.');
  }

  l.push('');
  l.push('PIPELINE COMERCIAL');
  if (c.pipeline.length === 0) {
    l.push('  · NI UNA FILA en `prospecto`. La tabla contestó y vino vacía.');
  } else {
    for (const p of c.pipeline) l.push(`  · ${p.etapa}: ${numero(p.n)}`);
    l.push('    Son CONTEOS de prospectos por etapa, no valor de pipeline: no hay monto pactado por prospecto en la base, así que «$X en pipeline» no se puede decir.');
  }

  l.push('');
  l.push('OPERACIÓN (la tracción de producto, que no es ingreso pero sí es uso)');
  l.push(`  · Liquidaciones generadas por el motor, histórico: ${numero(c.liquidaciones)}.`);

  if (c.truncado) {
    l.push('');
    l.push(`⚠️ ALGUNA LECTURA AGREGADA SE TRUNCÓ EN ${numero(TOPE_FILAS_AGREGADO)} FILAS: el cobrado histórico y/o el pipeline de arriba son un PISO, no el total. Se dice porque una cifra recortada sin avisar es peor que una cifra ausente — la primera se cita, la segunda se pregunta.`);
  }

  l.push('');
  l.push('LAS CIFRAS QUE UN INVERSIONISTA VA A PEDIR Y QUE HOY NO EXISTEN:');
  for (const h of HUECOS) {
    l.push(`  · ${h.metrica} — NO EXISTE. ${h.porque}`);
  }
  l.push('');
  l.push('POR QUÉ ESTA LISTA VA EN EL PARTE Y NO EN UNA NOTA AL PIE: enseñar solo lo que sí hay es lo que hace que en la segunda llamada alguien pregunte por el churn y no haya respuesta. Decir «todavía no lo medimos, y esto es lo que falta para medirlo» es una respuesta; un número inventado no lo es, y además no se puede sostener dos preguntas.');
  l.push('');
  l.push('Y UNA FRASE QUE ESTE PARTE NO VA A ESCRIBIR: «clientes reales». Ninguna empresa ha firmado, y la única forma honesta de decirlo es «en pláticas con transportistas».');
  l.push('Fuentes: `suscripcion` × `plan` (MRR) · `factura_saas` (cobrado) · `tenant` (flotas) · `prospecto` (pipeline por etapa) · `liquidacion` (uso).');
  l.push(PIE_NO_EJECUTA);
  return l.join('\n');
}

/** Conteo exacto de una tabla. LANZA si PostgREST no devuelve el número: un
 *  `?? 0` pintaría un cero que nadie midió. */
async function contar(tabla: string, etiqueta: string): Promise<number> {
  const { count, error } = await acotada(supabaseAdmin()
    .from(tabla)
    .select('id', { count: 'exact', head: true }), etiqueta);
  if (error) throw new Error(`${etiqueta}: ${error.message}`);
  if (typeof count !== 'number') throw new Error(`${etiqueta}: PostgREST no devolvió el conteo — no se afirma un 0 que nadie midió.`);
  return count;
}

async function leerCifras(): Promise<CifrasFundraising> {
  const [flotas, liquidaciones, suscripciones, facturas, pipeline] = await Promise.all([
    contar('tenant', 'direccion.fundraising.flotas'),
    contar('liquidacion', 'direccion.fundraising.liquidaciones'),
    leerSuscripciones(),
    leerFacturas(),
    leerPipeline(),
  ]);
  return {
    flotas, liquidaciones, suscripciones,
    facturasPagadas: facturas.n, cobradoMxn: facturas.total,
    pipeline: pipeline.etapas,
    truncado: facturas.truncado || pipeline.truncado,
  };
}

async function leerSuscripciones(): Promise<Suscripciones> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('suscripcion')
    .select('estado, plan_clave, plan:plan_clave(precio_mensual)')
    .limit(2_000), 'direccion.fundraising.suscripciones');
  if (error) throw new Error(`leerSuscripciones: ${error.message}`);
  const filas = (data ?? []) as Array<Record<string, unknown>>;
  const porEstado = new Map<string, number>();
  const activas: Array<{ plan: string; precio: number | null }> = [];
  for (const f of filas) {
    const estado = String(f.estado);
    porEstado.set(estado, (porEstado.get(estado) ?? 0) + 1);
    if (estado === 'activa') {
      const p = f.plan as { precio_mensual?: unknown } | null;
      const precio = p?.precio_mensual;
      activas.push({
        plan: String(f.plan_clave),
        // NULL se preserva: es lo que dispara el «MRR indeterminado».
        precio: precio === null || precio === undefined ? null : Number(precio),
      });
    }
  }
  return {
    porEstado: [...porEstado.entries()].map(([estado, n]) => ({ estado, n }))
      .sort((a, b) => b.n - a.n || a.estado.localeCompare(b.estado)),
    activas,
  };
}

/** Filas que las dos lecturas agregadas del parte leen como máximo. Se comparan
 *  contra el `count: 'exact'` de PostgREST y NO contra el largo del arreglo:
 *  PostgREST recorta a `max_rows` sin avisar, así que un arreglo más corto que
 *  el `.limit()` no prueba que se leyó todo (la lección ESC-8). */
export const TOPE_FILAS_AGREGADO = 20_000;

async function leerFacturas(): Promise<{ n: number; total: number; truncado: boolean }> {
  const { data, error, count } = await acotada(supabaseAdmin()
    .from('factura_saas')
    .select('monto', { count: 'exact' })
    .eq('estado', 'pagada')
    .limit(TOPE_FILAS_AGREGADO), 'direccion.fundraising.facturas');
  if (error) throw new Error(`leerFacturas: ${error.message}`);
  const filas = (data ?? []) as Array<{ monto: unknown }>;
  return {
    n: filas.length,
    total: Math.round(filas.reduce((s, f) => s + Number(f.monto ?? 0), 0) * 100) / 100,
    truncado: typeof count === 'number' ? count > filas.length : filas.length >= TOPE_FILAS_AGREGADO,
  };
}

async function leerPipeline(): Promise<{ etapas: Array<{ etapa: string; n: number }>; truncado: boolean }> {
  const { data, error, count } = await acotada(supabaseAdmin()
    .from('prospecto')
    .select('estado', { count: 'exact' })
    .is('duplicado_de', null)
    .limit(TOPE_FILAS_AGREGADO), 'direccion.fundraising.pipeline');
  if (error) throw new Error(`leerPipeline: ${error.message}`);
  const filas = (data ?? []) as Array<{ estado: string }>;
  const m = new Map<string, number>();
  for (const f of filas) m.set(f.estado, (m.get(f.estado) ?? 0) + 1);
  return {
    etapas: [...m.entries()].map(([etapa, n]) => ({ etapa, n }))
      .sort((a, b) => b.n - a.n || a.etapa.localeCompare(b.etapa)),
    truncado: typeof count === 'number' ? count > filas.length : filas.length >= TOPE_FILAS_AGREGADO,
  };
}

async function correrFundraising(disparo: DisparoCorrida, hoy: string): Promise<ResultadoDireccionBandeja> {
  const inicio = new Date();
  const agente = 'fundraising';
  const mes = mesDe(hoy);
  const titulo = `Fundraising — parte de ${mes.slice(0, 7)}`;
  try {
    if (await piezaExistente(agente, titulo)) {
      await anotarCorrida(agente, inicio, 'ok', disparo, { pieza: 'ya_existia', titulo });
      return yaEstaba(agente, 'el parte de métricas de este mes');
    }
    const c = await leerCifras();
    const mrr = calcularMrr(c.suscripciones.activas);
    const res = await encolarPiezaDireccion(agente, 'parte_inversionistas', titulo, armarParteFundraising(c, mrr, mes), {
      mes,
      flotas: c.flotas,
      suscripciones_activas: mrr.activas,
      mrr_mxn: mrr.mxn,
      mrr_indeterminado: mrr.mxn === null,
      facturas_pagadas: c.facturasPagadas,
      huecos: HUECOS.map((h) => h.metrica),
      consultas: ['suscripcion × plan', 'factura_saas (pagadas)', 'tenant', 'prospecto (por etapa)', 'liquidacion'],
    });
    await anotarCorrida(agente, inicio, 'ok', disparo, { pieza: res, mrr_indeterminado: mrr.mxn === null, flotas: c.flotas });
    return { resultado: 'corrio', piezas: res === 'encolada' ? 1 : 0, motivo: res === 'ya_existia' ? 'otra corrida ganó el mes' : undefined, costoUsd: 0 };
  } catch (e) {
    await anotarCorrida(agente, inicio, 'fallo', disparo, { titulo }, {
      error: `No se pudo armar el parte de fundraising: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500),
    });
    throw e;
  }
}

// ── El despacho que el runner llama ────────────────────────────────────────

/** UNA corrida de uno de los tres. Deterministas: no hay import dinámico que
 *  hacer aquí — el módulo entero no arrastra un cliente de modelo. */
export async function correrAgenteDireccionBandeja(
  id: AgenteDireccionBandeja,
  disparo: DisparoCorrida = 'cron',
  hoy: string = hoyMx(),
  /** El vencimiento de la vuelta del runner (0123 + #152). Solo lo mira el de
   *  incidentes, que BUSCA expediente uno por uno; automejora y fundraising
   *  hacen sus lecturas de una y no tienen dónde cortar sin dejar el parte a
   *  medias — y medio parte de métricas es peor que ninguno. */
  venceEn?: number,
): Promise<ResultadoDireccionBandeja> {
  logger.info('direccion_bandeja.corrida', { agente: id, disparo });
  switch (id) {
    case 'automejora': return correrAutomejora(disparo, hoy);
    case 'especialistas_incidente': return correrEspecialistasIncidente(disparo, hoy, venceEn);
    case 'fundraising': return correrFundraising(disparo, hoy);
  }
}
