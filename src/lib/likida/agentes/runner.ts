// ═══════════════════════════════════════════════════════════════════════════
// EL RUNNER NIVEL 2 (0123) — la autonomía ACOTADA que Javier ordenó el
// 16-ago-2026, anulando el diferimiento del diseño del copiloto §4.
//
// EL ORQUESTADOR ES DETERMINISTA A PROPÓSITO — cero LLM en el despacho
// (la mitad determinista del mismo diseño: "las reglas calculan, el LLM
// redacta"). Quien gasta modelo es el AGENTE despachado, con su rol barato
// (models.ts `back_office`), y este módulo lo frena por CUATRO candados,
// todos fail-closed:
//   1. Kill switch global y por agente (interruptores 0110). Un agente
//      autónomo SIN kill switch declarado no corre — punto.
//   2. Opt-in `runner_habilitado` + estado 'vivo' + disparador 'cron'
//      (agente_definicion 0123) — apagable en la base sin deploy.
//   3. TECHO DE DINERO: presupuesto_dia_usd DECLARADO (NULL = no corre
//      solo) y reservado de forma atómica en el ledger central por tenant.
//      Sin tenant explícito o sin reserva durable, no se corre.
//   4. BACKPRESSURE: si la bandeja de aprobación ya acumula piezas sin
//      resolver, el runner no fabrica más — un humano que no aprueba es la
//      señal de parar, no de insistir.
//
// La SALIDA de todo agente del runner es la cola de aprobación — el runner
// jamás toca un canal de envío. El tope de ENVÍO diario vive aparte, en la
// única puerta de salida (cola.ts).
//
// Los cuatro candados son de DINERO y de SEGURIDAD. Aparte de ellos, y desde
// el 25-ago-2026, la vuelta trae un PRESUPUESTO DE TIEMPO (ver
// `MARGEN_RELOJ_MS` más abajo): no decide si un agente puede correr, decide si
// TODAVÍA CABE en la invocación. Lo que no cabe se dice; no se muere.
// ═══════════════════════════════════════════════════════════════════════════
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { acotada } from '../presupuesto';
import { estaApagado, INTERRUPTORES, type NombreInterruptor } from '../interruptores';
import { hoyMx } from '@/lib/formato';
import { esErrorDePresupuesto, createLlmBudget, type LlmBudget } from '@/lib/llm/budget';
import { alertarOperador } from '@/lib/observability/alerta';
import { DatoInvalido } from '../errores';
import { redactarCorreoFrio } from './redactor';
import { AGENTES_FINANCIEROS, correrAgenteFinanciero, esAgenteFinanciero } from './finanzas';
import { candidatosSinDossier, investigarProspecto } from './investigador';
import { correrSdr } from './sdr';
import { correrEnviador } from './enviador';
import { logger } from '@/lib/logger';

/** Piezas que una corrida del runner fabrica como máximo por agente. */
export function topePiezasPorCorrida(): number {
  const v = Number(process.env.LIKIDA_RUNNER_PIEZAS_POR_CORRIDA);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 5;
}

/** Pendientes en la bandeja a partir de los cuales el runner deja de
 *  fabricar (backpressure): aprobar es humano, y una bandeja desbordada es
 *  la señal de parar. */
export function topePendientesBandeja(): number {
  const v = Number(process.env.LIKIDA_RUNNER_TOPE_PENDIENTES);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 20;
}

// ═══════════════════════════════════════════════════════════════════════════
// AGB-5 (auditoría 24, 1-sep-2026) — CONTRAPRESIÓN GLOBAL de la bandeja.
//
// Antes SOLO el Redactor miraba su propia bandeja (`correo_frio` pendientes,
// candado de arriba); los otros 44 agentes que encolan un parte no miraban
// nada. Medido en producción: 107 pendientes, CERO resoluciones humanas en
// 15 días, y la vuelta seguía fabricando partes con el latido en verde. El
// candado de abajo mira la bandeja ENTERA (todos los tipos) y por DOS
// razones: demasiadas piezas sin resolver, o la más vieja lleva demasiado
// tiempo esperando (una bandeja que "solo" tiene 10 piezas pero la más vieja
// tiene un mes tampoco se está atendiendo). Fail closed: sin poder leerla,
// no se fabrica encima.
// ═══════════════════════════════════════════════════════════════════════════

/** El tope de pendientes TOTALES (cualquier tipo) a partir del cual ningún
 *  agente que encola un parte sigue fabricando. */
export function topeBandejaGlobal(): number {
  const v = Number(process.env.LIKIDA_RUNNER_TOPE_BANDEJA_GLOBAL);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 40;
}

/** Los días que una pieza pendiente puede esperar antes de que la bandeja se
 *  considere "sin atender" — el VENCIMIENTO de la pieza (AGB-5): pasado este
 *  plazo, ya no importa cuántas haya, la señal es que nadie está mirando. */
export function diasVencimientoPieza(): number {
  const v = Number(process.env.LIKIDA_RUNNER_DIAS_VENCIMIENTO_PIEZA);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 7;
}

/** La parte PURA: dado lo que la base contestó, ¿la bandeja está sin
 *  atender, y por qué? Separada de la lectura para poder probarla sin base.
 *  `pendientesVistos` es lo que trajo una consulta con `.limit(tope)`
 *  ordenada por `creado_en` ascendente — no hace falta un COUNT aparte:
 *  llegar al tope ya contesta "sí, hay al menos `tope`", y la PRIMERA fila
 *  de esa misma consulta YA es la más vieja de toda la bandeja. Una sola
 *  consulta, dos preguntas. */
export function motivoBandejaGlobalSinAtender(
  pendientesVistos: number,
  piezaMasViejaCreadaEn: string | null,
  ahoraMs: number = Date.now(),
): string | null {
  const tope = topeBandejaGlobal();
  if (pendientesVistos >= tope) {
    return `bandeja con ≥ ${tope} piezas pendientes (cualquier tipo) — aprobar es humano; el runner no fabrica encima ("bandeja sin atender")`;
  }
  if (piezaMasViejaCreadaEn) {
    const edadDias = (ahoraMs - new Date(piezaMasViejaCreadaEn).getTime()) / 86_400_000;
    const plazo = diasVencimientoPieza();
    if (edadDias > plazo) {
      return `la pieza pendiente más vieja de la bandeja lleva ${edadDias.toFixed(1)} días esperando (> ${plazo}) — vencida sin que nadie la haya mirado ("bandeja sin atender")`;
    }
  }
  return null;
}

/** La parte con I/O: UNA consulta —`creado_en` de las pendientes, más viejas
 *  primero, topada al mismo `topeBandejaGlobal()`— basta para las dos
 *  preguntas de arriba. Fail closed: sin poder leerla, se trata como
 *  "sin atender", el mismo criterio que el resto del runner. */
async function leerBandejaGlobalSinAtender(): Promise<string | null> {
  const tope = topeBandejaGlobal();
  const { data, error } = await supabaseAdmin()
    .from('cola_aprobacion')
    .select('creado_en')
    .eq('estado', 'pendiente')
    .order('creado_en', { ascending: true })
    .order('id', { ascending: true })
    .limit(tope);
  if (error) {
    return 'no se pudo leer la bandeja global — fail closed ("bandeja sin atender")';
  }
  const filas = (data ?? []) as Array<{ creado_en: string }>;
  return motivoBandejaGlobalSinAtender(filas.length, filas[0]?.creado_en ?? null);
}

/** Los cuatro reporteros de dirección (0216). Se sube a constante —antes era
 *  un literal dentro de su propia rama— porque `AGENTES_DESPACHABLES` la
 *  necesita: una lista paralela para el auditor podría divergir del despacho
 *  real, que es justo lo que ese agente existe para cazar. */
const DIRECCION: readonly string[] = ['kpi_whatsapp', 'desempeno_startup', 'orquestador', 'orquestador_semanal'];

/** Los cuatro del back office restante (0219). La lista se escribe AQUÍ como
 *  literal —y no importando `AGENTES_BACK_OFFICE`— por la misma razón que la
 *  de dirección: el módulo del motor se carga por import dinámico dentro de
 *  su rama, y un import estático para leer cuatro cadenas lo traería en cada
 *  vuelta del runner. `runner.test.ts` compara esta lista contra la del
 *  motor: si divergen, falla. */
const BACK_OFFICE_RESTANTE: readonly string[] = ['vigilante_calidad', 'documentacion', 'legal_compliance', 'talento'];

/** Los seis del departamento de éxito del cliente (0218). La lista se repite
 *  aquí como literal —en vez de importar `AGENTES_EXITO` de `./exito`— por lo
 *  mismo que la de dirección: importar el catálogo arrastraría el módulo
 *  entero al bundle del runner y la gracia del despacho es que solo se cargue
 *  cuando de verdad toca. La verdad de quién existe la manda `agente_definicion`. */
const AGENTES_EXITO_CLIENTE: readonly string[] = [
  'onboarding_cliente', 'exito_cliente', 'retencion',
  'cobranza_saas', 'soporte', 'atencion_faq',
];
type AgenteDeExito = 'onboarding_cliente' | 'exito_cliente' | 'retencion'
  | 'cobranza_saas' | 'soporte' | 'atencion_faq';

/** Los diez de crecimiento (0230). Literal aquí por lo mismo que las listas de
 *  arriba: el motor entra por import dinámico dentro de su rama, y un import
 *  estático para leer diez cadenas arrastraría el módulo —con la calculadora y
 *  el índice de normas— a cada vuelta del runner. `runner.test.ts` compara
 *  esta lista contra la del motor: si divergen, falla. */
const CRECIMIENTO: readonly string[] = [
  'contenido_fiscal', 'lead_magnet', 'seo_distribucion',
  'guiones', 'noticias_mercado', 'promos_diarias',
  'visuales', 'video_demo', 'video_marketing', 'alianzas',
];

/** Los ocho de ingeniería (0234). Literal aquí por lo mismo que las listas de
 *  arriba: el motor entra por import dinámico dentro de su rama, y un import
 *  estático para leer ocho cadenas arrastraría los dos módulos —con sus
 *  lectores del catálogo de PostgreSQL— a cada vuelta del runner.
 *  `runner.test.ts` compara esta lista contra la del motor: si divergen, falla. */
const INGENIERIA: readonly string[] = [
  'migraciones', 'seguridad', 'rendimiento', 'pruebas',
  'auditor_codigo', 'releases', 'producto', 'datos_instrumentacion',
];

/** Los tres de dirección que van a la BANDEJA (0235). NO son los cuatro de la
 *  0216: aquéllos mandan correo y se despachan por `../direccion/reportes`.
 *  Literal aquí por lo mismo que las listas de arriba — el motor entra por
 *  import dinámico dentro de su rama—, y `runner.test.ts` compara esta lista
 *  contra la del motor: si divergen, falla. */
const DIRECCION_BANDEJA: readonly string[] = ['automejora', 'especialistas_incidente', 'fundraising'];

/** Los seis de leads (0235), los últimos que quedaban en 'disenado' del
 *  catálogo entero. Mismo trato literal que las demás listas. */
const LEADS: readonly string[] = ['scorer', 'dossier', 'vigia', 'demo_prep', 'propuestas', 'cazador'];
/**
 * TODOS los ids que ESTE BUNDLE sabe despachar — la unión de las ramas de
 * `correrRunner`, en el mismo orden en que el `for` las prueba.
 *
 * NO ES DECORACIÓN: la lee el agente `auditor_codigo` (0234) por import
 * dinámico para comparar el ARTEFACTO DESPLEGADO contra lo que la base declara
 * vivo. Un agente que la base tiene en 'vivo' + runner_habilitado + 'cron' y
 * que no está aquí se salta en cada vuelta con «sin motor despachable»: vivo en
 * el catálogo, muerto en la práctica. Ese es el «mergeado ≠ desplegado» que ya
 * mordió a este proyecto, y desde una función serverless es LO ÚNICO que se
 * puede auditar del código con honestidad.
 *
 * Se arma de las mismas constantes que usa el despacho —no de una lista
 * paralela— justo para que no puedan divergir.
 */
export const AGENTES_DESPACHABLES: readonly string[] = [
  'redactor',
  ...AGENTES_FINANCIEROS,
  ...DIRECCION,
  ...BACK_OFFICE_RESTANTE,
  ...AGENTES_EXITO_CLIENTE,
  ...CRECIMIENTO,
  ...INGENIERIA,
  ...DIRECCION_BANDEJA,
  ...LEADS,
  'enriquecedor', 'sdr', 'enviador',
];

export interface AgenteDelRunner {
  agente: string;
  resultado: 'corrio' | 'saltado';
  motivo?: string;
  piezas?: number;
  saltados?: number;
  /** `null` = el agente llamó al modelo y NO se pudo medir cuánto gastó
   *  (c7-11). No es 0: el 0 significa «no gastó», y confundirlos dejaba ciego
   *  al único techo de gasto de los diez de crecimiento. */
  costoUsd?: number | null;
}

export interface ResultadoRunner {
  apagadoGlobal: boolean;
  agentes: AgenteDelRunner[];
  /** Los agentes a los que EL RELOJ LES QUITÓ TRABAJO. La lista, no el conteo:
   *  el operador necesita saber CUÁLES se quedaron sin correr, no cuántos.
   *  Vacía en una vuelta que cupo entera.
   *
   *  Desde el 28-ago-2026 (c7-1) la lista incluye DOS clases, porque las dos
   *  significan lo mismo para el operador —«a este le falta trabajo, le toca en
   *  la próxima pasada»— y las dos tienen que hacer que el latido diga
   *  `'parcial'`:
   *    · los que no alcanzaron TURNO (el candado 0 cortó antes de despacharlos);
   *    · los que SÍ arrancaron y su lote se cortó A LA MITAD por el reloj.
   *  Antes solo existía la primera, así que un Redactor cortado a la mitad
   *  —que es el caso real, porque `ordenarPorCosto` lo despacha AL FINAL— dejaba
   *  la lista vacía y el latido decía `'ok'`: el runner reportaba una pasada
   *  limpia mientras agonizaba. El motivo de cada uno distingue las dos clases. */
  saltadosPorReloj: string[];
  /** `true` cuando la vuelta no terminó por su cuenta y el RELOJ DURO de la
   *  ruta la cortó por fuera (ver `conRelojDuro`). Es la única señal fiable
   *  cuando el corte ocurre tan temprano que no hay ni un agente que nombrar
   *  —p. ej. colgado en la propia lectura de `agente_definicion`—: sin ella,
   *  `saltadosPorReloj` saldría vacía y el latido volvería a mentir `'ok'`. */
  cortadaPorRelojDuro?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// EL PARTE EN VIVO DE LA VUELTA (c7-1, 28-ago-2026).
//
// `correrRunner` devuelve su resultado AL FINAL. Eso basta cuando la vuelta
// termina; no basta cuando la matan a la mitad, que es justo el caso que este
// archivo existe para evitar. Por eso la vuelta ya no solo DEVUELVE lo que
// pasó: lo va ESCRIBIENDO en un objeto compartido conforme pasa, para que quien
// la acota por fuera pueda decir la verdad de lo que alcanzó a ocurrir aunque
// el motor en vuelo nunca devuelva nada.
//
// Sin esto, el `Promise.race` de la ruta solo podría reportar «se acabó el
// tiempo» sin saber a quién le tocaba ni quién se quedó a medias — o sea, un
// latido que late pero no dice nada. Decir «no sé» donde sí se sabe es
// exactamente lo que este producto no hace.
// ═══════════════════════════════════════════════════════════════════════════
export interface AvanceRunner {
  apagadoGlobal: boolean;
  /** Los MISMOS arreglos que `correrRunner` devuelve — se comparten por
   *  referencia, no se copian: un espejo que hay que acordarse de actualizar se
   *  desincroniza el día que alguien agrega una rama de despacho y se olvida. */
  agentes: AgenteDelRunner[];
  saltadosPorReloj: string[];
  /** Los ids que TODAVÍA no se despachan, en orden de despacho. */
  pendientes: string[];
  /** El id del agente que se está despachando AHORA MISMO, o `null` si la
   *  vuelta no está dentro de ningún motor. */
  enVuelo: string | null;
}

export function nuevoAvanceRunner(): AvanceRunner {
  return { apagadoGlobal: false, agentes: [], saltadosPorReloj: [], pendientes: [], enVuelo: null };
}

// ═══════════════════════════════════════════════════════════════════════════
// EL PRESUPUESTO DE TIEMPO (alerta de prod 25-ago-2026, 18:46 — "Sin latido:
// runner hace 286 min").
//
// Con 34 agentes habilitados, la pasada de las 18:00 despachó ~15 EN SERIE y
// Vercel la mató en el `maxDuration` de 120 s: los agentes del final ni
// corrieron, y —lo grave— la ruta murió ANTES de `registrarLatido`, así que
// el orquestador quedó MUDO. Cuatro horas después la alerta de latido vencido
// fue la primera noticia. El mismo modo de falla que la cobranza global ya
// había resuelto (REND-C2/ESC-3): trabajo serial sin reloj bajo un
// `maxDuration` que nadie mira.
//
// La cura es la misma que allá: un vencimiento ÚNICO para toda la vuelta, que
// se consulta ANTES de despachar cada agente. Si no alcanza, se corta LIMPIO
// —los que faltan quedan dichos, no desaparecidos— y la ruta alcanza a
// escribir su latido `'parcial'`. Una pasada cortada con latido es
// infinitamente mejor que una pasada completa que muere muda.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * LA COLA DEL LATIDO, PASO POR PASO, con su tope REAL.
 *
 * Misma técnica que `PASOS_CIERRE` en `presupuesto.ts`, y por la misma razón:
 * un margen justificado en prosa no se puede verificar, y este ya se quedó
 * corto una vez. El comentario viejo decía «20 s: el latido es un upsert (tope
 * de `acotada`, 8 s) más el `leerLatido` de la racha y el correo del tercer
 * corte seguido» — cuatro pasos EN SERIE descritos con un solo número, y la
 * suma real de esos cuatro es 25.2 s, no 20 (auditoría ciclo 7, c7-31).
 *
 * Los topes no son estimaciones: `TOPE_CONSULTA_MS` son 8 000 más 1 500 de
 * gracia (`presupuesto.ts`), la reserva del piso de alerta es un viaje a Redis
 * y `TIMEOUT_CORREO_MS` son 5 000 (`correo/enviar.ts`).
 *
 * El orden de la tabla ES el orden de la ruta, y ese orden cambió: el latido se
 * escribe ANTES del correo al operador. Era al revés, así que en el peor caso
 * —el tercer corte seguido, el único momento en que entra el correo— el latido
 * quedaba ÚLTIMO de la fila: lo primero que se perdía era precisamente lo que
 * el margen existe para proteger. Ahora, aunque el margen se quedara corto de
 * nuevo, lo que se sacrifica es el correo (que además ya quedó en Sentry por
 * `logger.error`) y no el latido.
 *
 * `runner.test.ts` compara esta suma contra `MARGEN_RELOJ_MS`: meter un paso más
 * a la cola del latido sin ampliar el margen deja de ser un descuido silencioso
 * y pasa a ser una prueba en rojo.
 */
export const PASOS_LATIDO: ReadonlyArray<{ paso: string; donde: string; ms: number }> = [
  { paso: 'leerLatido de la racha (8 000 + 1 500 de gracia)', donde: 'salud.ts:100', ms: 9_500 },
  { paso: 'registrarLatido — el upsert que NO se puede perder', donde: 'salud.ts:86', ms: 9_500 },
  { paso: 'reservarPiso en Redis (SET NX) del correo al operador', donde: 'alerta.ts:133', ms: 1_200 },
  { paso: 'enviarCorreo al operador (TIMEOUT_CORREO_MS)', donde: 'correo/enviar.ts:42', ms: 5_000 },
];

/** Suma de la tabla de arriba: 25.2 s. */
export const COSTO_LATIDO_MS = PASOS_LATIDO.reduce((s, p) => s + p.ms, 0);

/** Lo que se le deja a la ruta para responder y ESCRIBIR EL LATIDO después del
 *  corte.
 *
 *  30 s contra los 25.2 s de `COSTO_LATIDO_MS`: 4.8 s de holgura, la misma
 *  proporción que `MARGEN_CIERRE_MS` se da en `presupuesto.ts`. Eran 20 s, o
 *  sea 5.2 s de DEUDA — el margen no cubría su propia cola.
 *
 *  Lo que cuesta: la vuelta pierde 10 s de sus 280. Es barato al lado de lo
 *  que compra, porque el latido de los 30 s no protege una pasada: protege la
 *  capacidad de enterarse de que las pasadas se están muriendo. */
export const MARGEN_RELOJ_MS = 30_000;

/** El reloj por default cuando el llamador no impone uno: el `maxDuration`
 *  de 300 s del cron menos el margen. El cron pasa el suyo explícito —esta
 *  constante es la red para el copiloto y las pruebas. */
export const PLAZO_RUNNER_MS = 300_000 - MARGEN_RELOJ_MS;

/** ¿Ya no cabe nada más en esta vuelta? Una función y no un `Date.now() >=
 *  venceEn` suelto: es la MISMA pregunta en el despacho y dentro de cada motor
 *  que itera, y tenerla escrita una sola vez es lo que hace que buscarla en el
 *  fuente encuentre a todos los que la hacen — y a los que no. */
export function relojAgotado(venceEn: number): boolean {
  return Date.now() >= venceEn;
}

/** Los agentes que GASTAN MODELO. Se despachan AL FINAL a propósito: si el
 *  reloj corta, lo que se sacrifica es lo caro y lo lento, no los partes
 *  deterministas (financieros, dirección, back office, éxito) que salen en
 *  milisegundos y son los que Javier lee cada mañana. Antes el orden era
 *  `ORDER BY id` —o sea, el alfabeto— y `atencion_faq` con `enriquecedor`
 *  encabezaban la vuelta comiéndose el reloj de los otros treinta. */
export function llamaAlModelo(agente: string): boolean {
  return agente === 'redactor' || agente === 'enriquecedor'
    || agente === 'sdr' || agente === 'atencion_faq'
    // El único de los diez de crecimiento (0230) que gasta modelo: redacta el
    // borrador del siguiente artículo del blog. Los otros nueve son
    // deterministas y salen en milisegundos, así que van con los baratos.
    || agente === 'contenido_fiscal';
}

/** El orden de despacho: baratos primero, caros al final, y DENTRO de cada
 *  grupo el orden estable que ya traía la consulta (`ORDER BY id`) — `sort`
 *  es estable por spec desde ES2019, así que dos vueltas con los mismos
 *  agentes despachan en el mismo orden. */
export function ordenarPorCosto<T extends { id: string }>(agentes: readonly T[]): T[] {
  return [...agentes].sort((a, b) => Number(llamaAlModelo(a.id)) - Number(llamaAlModelo(b.id)));
}

/** El gasto MEDIDO del agente hoy (día de México), USD. LANZA si la base no
 *  responde — el techo no se verifica a ciegas. */
export async function gastoDelDiaUsd(agente: string): Promise<number> {
  const diaMx = hoyMx();
  const inicioDia = new Date(`${diaMx}T00:00:00-06:00`).toISOString();
  const { data, error } = await acotada(supabaseAdmin()
    .from('agente_corrida')
    .select('costo_usd')
    .eq('agente', agente)
    .not('costo_usd', 'is', null)
    .gte('inicio', inicioDia)
    .limit(1000), 'runner.gasto_dia');
  if (error) throw new Error(`gastoDelDiaUsd: ${error.message}`);
  return ((data ?? []) as Array<{ costo_usd: unknown }>).reduce((s, f) => s + Number(f.costo_usd ?? 0), 0);
}

/**
 * Cuántas corridas de HOY de este agente NO tienen costo medido (`costo_usd`
 * NULL). LANZA si la base no responde, por lo mismo que su hermana.
 *
 * AUDITORÍA CICLO 7, c7-11 (alto). `gastoDelDiaUsd` filtra `.not('costo_usd',
 * 'is', null)` —correcto: no puede sumar lo que no sabe—, pero eso hace que un
 * gasto no medido sea INVISIBLE para el techo, no incierto. Con el proveedor
 * omitiendo `usage` una tarde, el agente redactaba, gastaba de verdad, y el
 * techo comparaba $0.00 contra $1.00 y nunca cortaba.
 *
 * Va aparte y no dentro de `gastoDelDiaUsd` a propósito: aquella devuelve una
 * SUMA y esto es otra pregunta —«¿hay algo que no pude sumar?»—. Meterlas en
 * el mismo número obligaría a inventar un valor para lo desconocido, que es
 * justo el error que este hallazgo describe. El llamador decide qué hacer con
 * la duda; hoy, el único que la consulta es `contenido_fiscal` (el único de
 * los diez de crecimiento que anota NULL), y falla cerrado.
 */
export async function corridasSinCostoMedidoHoy(agente: string): Promise<number> {
  const diaMx = hoyMx();
  const inicioDia = new Date(`${diaMx}T00:00:00-06:00`).toISOString();
  const { count, error } = await acotada(supabaseAdmin()
    .from('agente_corrida')
    .select('id', { count: 'exact', head: true })
    .eq('agente', agente)
    .is('costo_usd', null)
    .gte('inicio', inicioDia), 'runner.gasto_dia_sin_medir');
  if (error) throw new Error(`corridasSinCostoMedidoHoy: ${error.message}`);
  if (typeof count !== 'number') {
    throw new Error('corridasSinCostoMedidoHoy: PostgREST no devolvió el conteo — no se afirma un 0 que nadie midió.');
  }
  return count;
}

/** El lote del Redactor: fabrica hasta N piezas para prospectos en `nuevo`
 *  (los más viejos primero — los del SLA), cortando por la reserva/run central.
 *  Las guardas por prospecto (cadencia 48h, pieza pendiente, estado) viven
 *  DENTRO de redactarCorreoFrio — aquí solo se seleccionan candidatos. */
/** AGB-11 (auditoría 24): el tope de fallos SEGUIDOS del modelo (no de
 *  guardas — una guarda que rebota es la máquina funcionando, no rota) antes
 *  de cortar el lote. Medido en producción: 21 de 48 corridas en fallo, el
 *  mismo error ("sin variante A legible"), y el runner seguía pagando el
 *  modelo cuatro veces más aunque las tres primeras ya hubieran reventado
 *  igual — 100 s de reloj por 0 piezas. */
const TOPE_FALLOS_MODELO_SEGUIDOS = 3;

async function loteRedactor(
  budget: LlmBudget | null,
  /** EL RELOJ DE LA VUELTA, adentro del motor (c7-1). Ver la nota del `for`. */
  venceEn: number,
): Promise<{ piezas: number; saltados: number; costoUsd: number | null; sinTurno: number; motivoCorte: string | null }> {
  const tope = topePiezasPorCorrida();
  // ── EL OVERFETCH: era ×4 (20 candidatos para 5 piezas), ahora ×2 (10) ──────
  //
  // La razón original del overfetch SIGUE SIENDO VÁLIDA y por eso no se quita:
  // varios candidatos rebotan en las guardas del redactor (pieza pendiente,
  // cadencia de 48 h) y eso NO es fallo, es la guarda operando; sin colchón el
  // lote entregaría dos piezas donde caben cinco. Y esos rebotes son BARATOS:
  // `redactarCorreoFrio` verifica estado, cadencia e historial ANTES de tocar
  // el modelo (redactor.ts:251-294), así que un rebote de guarda son tres
  // consultas, no una llamada al LLM.
  //
  // Lo que cambió es el otro lado de la cuenta. Un candidato que pasa las
  // guardas y REVIENTA EN EL MODELO también cae en el `catch` de abajo, cuenta
  // como `saltados += 1` y el lote sigue — y ese sí ya costó la llamada. En la
  // pasada del 28-ago-2026 los tres fallos fueron exactamente de esa clase
  // («el Redactor devolvió una salida sin variante A legible»), medidos en
  // 26.95 s, 20.96 s y 24.21 s. Con 32,996 prospectos en `nuevo` la consulta
  // SIEMPRE trae su límite completo, así que el peor caso del ×4 no era teórico:
  // 20 llamadas × 25 s = 500 s dentro de un `maxDuration` de 300.
  //
  // Con ×2 el peor caso baja a 10 intentos y el colchón sigue siendo del doble
  // de lo que se quiere producir — suficiente para los rebotes de guarda, que
  // son la razón por la que el colchón existe. Lo que no se produzca en esta
  // pasada no se pierde: la cola tiene 32,996 filas y el cron vuelve en 4 horas.
  //
  // Y el número ya no es el freno: el freno es el reloj del `for`. El límite
  // ahora solo dimensiona la pila de candidatos; el que decide cuándo parar es
  // el tiempo, que es lo que de verdad se acaba.
  // AGB-3 (auditoría 24): antes esta consulta no filtraba por correo — medido
  // en producción, muchos de los "N más viejos" en `nuevo` son prospectos SIN
  // correo capturado (redactarCorreoFrio los deja pasar con AVISO, pero la
  // pieza que producen no se puede enviar ni resolver, AGB-4/AGB-5), así que
  // esa parte de la ventana se re-fabricaba sin avanzar. `.not(...)` los
  // excluye en la CONSULTA — la ventana avanza sola hacia los enviables, y
  // los que quedan fuera no vuelven a aparecer mientras no tengan correo.
  const { data, error } = await acotada(supabaseAdmin()
    .from('prospecto')
    .select('id, vendedor:vendedor_id(nombre)')
    .is('duplicado_de', null)
    .eq('estado', 'nuevo')
    .not('correo', 'is', null)
    .order('created_at', { ascending: true })
    .limit(tope * 2), 'runner.candidatos');
  if (error) throw new Error(`loteRedactor.candidatos: ${error.message}`);
  const candidatos = (data ?? []) as Array<{ id: string; vendedor: { nombre?: string } | null }>;

  // ARQ-2: `null` es PEGAJOSO. Sumar un desconocido con `+=` lo convertía en
  // cero y el agregado salía con cara de medido.
  let piezas = 0, saltados = 0, sinTurno = 0;
  let costoUsd: number | null = 0;
  // AGB-11: fallos SEGUIDOS del modelo — se resetea con cualquier resultado
  // que no sea uno (éxito o rebote de guarda), así que solo cuenta una racha
  // real de "el modelo no está contestando", no fallos intercalados con
  // guardas rebotando con normalidad.
  let fallosModeloSeguidos = 0;
  let motivoCorte: string | null = null;
  for (let i = 0; i < candidatos.length; i++) {
    const c = candidatos[i];
    // ── EL RELOJ, ADENTRO DEL MOTOR (auditoría ciclo 7, c7-1) ───────────────
    // El candado 0 del despacho pregunta esto ANTES de cada agente, pero el
    // reloj no entraba a ningún motor: este `for` no lo recibía ni lo miraba, y
    // sus únicas salidas eran cinco ÉXITOS o el techo de dinero. Los fallos no
    // contaban (`saltados += 1` y seguir), y el techo de dinero tampoco frenaba
    // —cada corrida costó ~$0.0002 USD contra un presupuesto diario de $1.00—.
    // Peor: `ordenarPorCosto` despacha al Redactor AL FINAL a propósito por
    // caro, así que el único motor sin freno propio era justo el que heredaba
    // todo el presupuesto de tiempo restante.
    //
    // Resultado en producción: Vercel mató la función DENTRO de este bucle. No
    // corrió ni el `try` ni el `catch` de la ruta, así que no se escribió
    // latido — el silencio del 25-ago-2026 («Sin latido: runner hace 286 min»)
    // y el del 28-ago-2026 00:03 UTC.
    //
    // Se pregunta ANTES de cada candidato y no después: lo que se protege es el
    // tiempo de la ruta para latir, y una llamada al modelo puede costar hasta
    // ~120 s (TIMEOUT_LLM_MS de 30 s × los cuatro intentos que encadena
    // `generateStructured`). Los que no alcanzaron turno se CUENTAN y suben al
    // resultado del agente: un lote cortado que lo dice es infinitamente mejor
    // que uno que reporta `resultado: 'corrio', piezas: 0` mientras agoniza.
    if (relojAgotado(venceEn)) {
      sinTurno = candidatos.length - i;
      logger.warn('runner.redactor.corte_por_reloj', { sinTurno, piezas, saltados });
      break;
    }
    if (piezas >= tope) break;
    if (budget && budget.reservadoRunUsd >= budget.maxRunUsd) break;
    try {
      // Sin budget = modo PLATAFORMA (c5-10): gasto de Likida, techo vigilado
      // por el runner contra el gasto medido del día — el mismo contrato que
      // investigador/SDR/enviador.
      const r = await redactarCorreoFrio(c.id, c.vendedor?.nombre?.trim() || 'Javier', 'cron', budget ? {
        tenantId: budget.tenantId,
        budget,
      } : { plataforma: true });
      piezas += 1;
      costoUsd = (costoUsd === null || r.costoUsd === null) ? null : costoUsd + r.costoUsd;
      fallosModeloSeguidos = 0;
    } catch (e) {
      // La RPC central ya hizo la decisión atómica. No se trata como un
      // prospecto inválido ni se sigue fabricando: el techo es de la corrida.
      //
      // AUDITORÍA 28, TC-B3: antes este `instanceof` era código muerto —
      // `redactarCorreoFrio` aplanaba TODO error, incluido el tope de
      // presupuesto, en `DatoInvalido` — y el tope se contaba como fallo del
      // modelo (`fallosModeloSeguidos` de abajo), disparando una alerta que
      // culpaba al modelo por quedarse sin presupuesto. `esErrorDePresupuesto`
      // reconoce el tope aunque venga envuelto por el ciclo de reintentos de
      // `generateStructured` (mismo criterio que ya usa el processor).
      if (esErrorDePresupuesto(e)) {
        motivoCorte = `el lote se cortó por presupuesto de IA agotado (${e instanceof Error ? e.message.slice(0, 160) : String(e)}) — lo que se fabricó queda; el resto le toca en la próxima corrida con techo disponible`;
        break;
      }
      // Guarda legítima o fallo puntual: se cuenta y se sigue — un prospecto
      // atorado no puede parar el lote entero. El detalle ya quedó en la
      // corrida/log del redactor.
      saltados += 1;
      const motivo = e instanceof Error ? e.message.slice(0, 160) : String(e);
      logger.info('runner.redactor.saltado', { prospecto: c.id, motivo });
      // AGB-11: solo las llamadas que de verdad tocaron el modelo y
      // reventaron cuentan para la racha — `redactarCorreoFrio` envuelve
      // ESE fallo, y solo ESE, en este mensaje exacto (redactor.ts:437); una
      // guarda (cadencia, ICP, pieza pendiente) tiene su propio texto y no
      // cuenta como "el modelo no está contestando".
      const esFalloDeModelo = e instanceof DatoInvalido && e.message.includes('no pudo escribir en este momento');
      if (esFalloDeModelo) {
        fallosModeloSeguidos += 1;
        if (fallosModeloSeguidos >= TOPE_FALLOS_MODELO_SEGUIDOS) {
          motivoCorte = `el lote se cortó tras ${fallosModeloSeguidos} fallos del modelo SEGUIDOS — pagar más llamadas contra un modelo que no está contestando no produce piezas, y sí gasta`;
          logger.error('runner.redactor.fallos_seguidos', { fallosModeloSeguidos, prospecto: c.id });
          await alertarOperador('redactor.fallos_seguidos', {
            error: `El Redactor falló ${fallosModeloSeguidos} veces seguidas contra el modelo ("${motivo.slice(0, 200)}") — el lote se cortó antes de seguir pagando llamadas que no producen nada.`,
            codigo: 'redactor_fallos_modelo_seguidos',
          });
          break;
        }
      } else {
        fallosModeloSeguidos = 0;
      }
    }
  }
  return { piezas, saltados, costoUsd, sinTurno, motivoCorte };
}

/** El motivo que lleva un agente cuyo LOTE se cortó a la mitad por el reloj.
 *  Se escribe una vez y se usa en las dos ramas (Redactor y enriquecedor) para
 *  que el operador lea la misma frase venga de donde venga. */
function motivoLoteCortado(sinTurno: number): string {
  return `el reloj de la vuelta cortó el lote con ${sinTurno} candidato(s) sin turno — lo que se fabricó queda; el resto le toca en la próxima pasada`;
}

/**
 * UNA vuelta del runner: despacha cada agente habilitado que pase los cuatro
 * candados. Cada agente falla POR SU LADO — un agente roto no tumba a los
 * demás, y el motivo de cada salto queda dicho.
 */
export async function correrRunner(
  /**
   * M30 (auditoría 18): acotar la vuelta a UN agente. El copiloto enseñaba
   * "Voy a ejecutar `redactor`" y despachaba a todos los habilitados. Sin
   * argumento sigue siendo la vuelta completa del cron.
   */
  soloAgente?: string,
  /** Tenant autenticado/explicitamente asignado que paga esta corrida.
   *  `null`/ausente bloquea al Redactor; nunca se usa un env global. */
  budgetTenantId?: string | null,
  /** El presupuesto de TIEMPO de esta vuelta. `venceEn` es el instante
   *  (epoch ms) a partir del cual ya no se despacha a nadie más — el cron le
   *  pasa su `maxDuration` menos `MARGEN_RELOJ_MS`.
   *
   *  `avance` es el parte EN VIVO (ver `AvanceRunner`): quien acota esta vuelta
   *  por fuera lo pasa para poder decir la verdad de lo que alcanzó a pasar si
   *  la corta. Sin él la vuelta se comporta igual — el objeto se crea local. */
  opts: { venceEn?: number; avance?: AvanceRunner } = {},
): Promise<ResultadoRunner> {
  // Los arreglos del resultado SON los del parte en vivo: compartidos por
  // referencia, para que cada `push` de las veinte ramas de despacho de abajo
  // se vea desde fuera sin que ninguna tenga que acordarse de espejarlo.
  const avance = opts.avance ?? nuevoAvanceRunner();
  const agentes: AgenteDelRunner[] = avance.agentes;
  const saltadosPorReloj: string[] = avance.saltadosPorReloj;
  // AGB-5: la contrapresión global se lee UNA vez por vuelta, no una vez por
  // agente — memoizada localmente a esta llamada (nunca a nivel de módulo:
  // dos vueltas concurrentes no deben compartir la lectura de la otra).
  let bandejaGlobalCache: string | null | undefined;
  const bandejaGlobalSinAtender = async (): Promise<string | null> => {
    if (bandejaGlobalCache === undefined) bandejaGlobalCache = await leerBandejaGlobalSinAtender();
    return bandejaGlobalCache;
  };

  if (await estaApagado('global')) {
    avance.apagadoGlobal = true;
    return { apagadoGlobal: true, agentes, saltadosPorReloj };
  }

  const { data, error } = await acotada(supabaseAdmin()
    .from('agente_definicion')
    .select('id, presupuesto_dia_usd, experimental')
    .eq('estado', 'vivo')
    .eq('runner_habilitado', true)
    .eq('disparador', 'cron')
    .order('id'), 'runner.agentes');
  if (error) throw new Error(`correrRunner: ${error.message}`);
  const habilitados = ordenarPorCosto(((data ?? []) as Array<{ id: string; presupuesto_dia_usd: number | null; experimental: boolean | null }>)
    .filter((a) => !soloAgente || a.id === soloAgente));

  const venceEn = opts.venceEn ?? Date.now() + PLAZO_RUNNER_MS;
  avance.pendientes = habilitados.map((a) => a.id);
  for (let i = 0; i < habilitados.length; i++) {
    const a = habilitados[i];
    // El parte en vivo, antes de tocar nada: quién está en vuelo y quiénes
    // quedan. Se pone AQUÍ y no dentro de cada rama porque las ramas terminan
    // en `continue` por veinte caminos distintos, y una bitácora que hay que
    // acordarse de escribir en veinte lugares es una bitácora que miente.
    avance.enVuelo = a.id;
    avance.pendientes = habilitados.slice(i + 1).map((x) => x.id);
    // Candado 0 — EL RELOJ. Se pregunta ANTES de despachar, no después: la
    // gracia es que el corte deje a la ruta tiempo de escribir el latido. Los
    // que faltan se dicen uno por uno —con nombre— en vez de desaparecer con
    // la invocación, que es exactamente lo que pasó el 25-ago.
    if (relojAgotado(venceEn)) {
      avance.enVuelo = null;
      avance.pendientes = [];
      for (const pendiente of habilitados.slice(i)) {
        saltadosPorReloj.push(pendiente.id);
        agentes.push({
          agente: pendiente.id,
          resultado: 'saltado',
          motivo: 'saltado por reloj — la vuelta se quedó sin presupuesto de tiempo; le toca en la próxima pasada',
        });
      }
      logger.warn('runner.corte_por_reloj', { saltados: saltadosPorReloj.length, desde: a.id });
      break;
    }

    // Candado 1 — el kill switch. Sin interruptor declarado NO corre: un
    // agente autónomo que no se puede apagar no existe en este producto.
    const interruptor = `agente:${a.id}`;
    if (!(INTERRUPTORES as readonly string[]).includes(interruptor)) {
      agentes.push({ agente: a.id, resultado: 'saltado', motivo: 'sin kill switch declarado (interruptores.ts + CHECK 0110) — un autónomo inapagable no corre' });
      continue;
    }
    // Candado 2 — EXPERIMENTAL (auditoría 24, "agentes teatro", 0301). Nueve
    // agentes del catálogo (cazador, seo_distribucion, guiones,
    // noticias_mercado, promos_diarias, visuales, video_demo,
    // video_marketing, pruebas) prometen un motor que el código no tiene
    // todavía — producen texto sin motor detrás, o su promesa no
    // corresponde con lo que corre. Siguen `vivo` en el organigrama (Javier
    // los puede ver y graduar) pero el runner NO los despacha por default:
    // presentarlos junto a los agentes reales como "back office completo"
    // fue justo lo que esta auditoría vino a corregir.
    if (a.experimental) {
      agentes.push({ agente: a.id, resultado: 'saltado', motivo: 'experimental (agente_definicion.experimental) — el catálogo promete un motor que el código no tiene todavía; no se despacha en automático hasta que se gradúe' });
      continue;
    }
    try {
      if (await estaApagado(interruptor as NombreInterruptor)) {
        agentes.push({ agente: a.id, resultado: 'saltado', motivo: 'apagado desde Observabilidad/⌘K' });
        continue;
      }
    } catch {
      agentes.push({ agente: a.id, resultado: 'saltado', motivo: 'no se pudo leer el interruptor — fail closed' });
      continue;
    }

    // Candado 3 — el techo de dinero, declarado y medido.
    if (a.presupuesto_dia_usd === null || a.presupuesto_dia_usd <= 0) {
      agentes.push({ agente: a.id, resultado: 'saltado', motivo: 'sin presupuesto_dia_usd declarado — el runner no corre agentes sin techo' });
      continue;
    }
    // Candado 4 — backpressure de la bandeja (solo agentes que encolan).
    if (a.id === 'redactor') {
      const { count, error: errPend } = await supabaseAdmin()
        .from('cola_aprobacion')
        .select('id', { count: 'exact', head: true })
        .eq('estado', 'pendiente')
        .eq('tipo', 'correo_frio');
      if (errPend || typeof count !== 'number') {
        agentes.push({ agente: a.id, resultado: 'saltado', motivo: 'no se pudo leer la bandeja — fail closed' });
        continue;
      }
      if (count >= topePendientesBandeja()) {
        agentes.push({ agente: a.id, resultado: 'saltado', motivo: `bandeja con ${count} piezas sin resolver — aprobar es humano; el runner no fabrica encima` });
        continue;
      }

      // AUDITORÍA FABLE CICLO 5 (c5-10): sin tenant explícito, la corrida es
      // de PLATAFORMA (gasto de Likida) — antes este camino era "saltado —
      // fail closed" en toda pasada del cron y del copiloto, así que ninguna
      // pieza se fabricaba sola y la máquina completa dependía del botón
      // manual. El techo sigue: gasto MEDIDO del día vs presupuesto
      // declarado, el mismo candado que investigador/SDR/enviador.
      if (!budgetTenantId) {
        try {
          const gastado = await gastoDelDiaUsd(a.id);
          if (gastado >= a.presupuesto_dia_usd) {
            agentes.push({ agente: a.id, resultado: 'saltado', motivo: `techo diario alcanzado (${gastado.toFixed(2)} de ${a.presupuesto_dia_usd} USD)` });
            continue;
          }
        } catch (e) {
          agentes.push({ agente: a.id, resultado: 'saltado', motivo: `no se pudo leer el gasto del día — fail closed (${e instanceof Error ? e.message.slice(0, 120) : 'error'})` });
          continue;
        }
      }

      try {
        const budget = budgetTenantId
          ? createLlmBudget(budgetTenantId, randomUUID(), 'fondo', { maxTenantDailyUsd: a.presupuesto_dia_usd })
          : null;
        const { sinTurno, motivoCorte, ...cifras } = await loteRedactor(budget, venceEn);
        agentes.push({
          agente: a.id, resultado: 'corrio', ...cifras,
          // AGB-11: el corte por fallos seguidos manda sobre el de reloj —
          // son mutuamente excluyentes en la práctica (el corte de fallos
          // sale de un `break` propio, antes de que el reloj lo alcance),
          // pero si algún día coincidieran, la RAZÓN real (el modelo no
          // contesta) es más útil que "sin turno".
          ...(motivoCorte ? { motivo: motivoCorte } : sinTurno > 0 ? { motivo: motivoLoteCortado(sinTurno) } : {}),
        });
        // Un lote cortado a la mitad ES trabajo que el reloj le quitó a este
        // agente, y tiene que hacer que el latido diga `'parcial'` igual que un
        // agente que no alcanzó turno. Antes no subía a ninguna lista, y como
        // el Redactor se despacha AL FINAL, cortarlo dejaba `saltadosPorReloj`
        // vacía y el latido decía `'ok'` sobre una pasada agonizante (c7-1).
        if (sinTurno > 0) saltadosPorReloj.push(a.id);
      } catch (e) {
        agentes.push({ agente: a.id, resultado: 'saltado', motivo: e instanceof Error ? e.message.slice(0, 200) : 'fallo del lote' });
      }
      continue;
    }

    // Candado 5 — CONTRAPRESIÓN GLOBAL de la bandeja (AGB-5). Todo lo que
    // sigue de aquí en adelante ENCOLA UN PARTE en `cola_aprobacion`, salvo
    // los cuatro de `DIRECCION` (mandan correo directo a Javier, 0216) y
    // `enviador`/`enriquecedor` (no encolan ahí: mandan correo o escriben el
    // dossier). El Redactor ya se despachó arriba con su propio candado más
    // estrecho (solo mira `correo_frio`); este es el candado ANCHO, y
    // aplicarlo también a `redactor` de nuevo aquí no aplica porque ya hizo
    // `continue`.
    if (!DIRECCION.includes(a.id) && a.id !== 'enviador' && a.id !== 'enriquecedor') {
      const motivo = await bandejaGlobalSinAtender();
      if (motivo) {
        agentes.push({ agente: a.id, resultado: 'saltado', motivo });
        continue;
      }
    }

    // Los 4 financieros (0215): deterministas, gasto de modelo $0 (el techo
    // declarado queda como candado formal). Su backpressure vive DENTRO del
    // motor — un parte del periodo sin resolver frena al siguiente — y su
    // salida es la misma bandeja que la del Redactor.
    if (esAgenteFinanciero(a.id)) {
      try {
        const r = await correrAgenteFinanciero(a.id, 'cron');
        agentes.push({ agente: a.id, resultado: 'corrio', piezas: r.piezas, costoUsd: 0, ...(r.motivo ? { motivo: r.motivo } : {}) });
      } catch (e) {
        agentes.push({ agente: a.id, resultado: 'saltado', motivo: e instanceof Error ? e.message.slice(0, 200) : 'fallo de la corrida financiera' });
      }
      continue;
    }

    // ── Dirección (0216): los cuatro reporteros deterministas ──────────────
    // Import dinámico a propósito: el módulo arrastra los lectores de /admin
    // (negocio, escalaciones, salud) y solo se paga cuando de verdad se
    // despacha un agente de dirección — no en cada carga del runner.
    if (DIRECCION.includes(a.id)) {
      try {
        const { correrAgenteDireccion } = await import('../direccion/reportes');
        const r = await correrAgenteDireccion(a.id as 'kpi_whatsapp' | 'desempeno_startup' | 'orquestador' | 'orquestador_semanal');
        agentes.push({ agente: a.id, resultado: r.resultado, motivo: r.motivo, piezas: r.piezas, costoUsd: r.costoUsd });
      } catch (e) {
        agentes.push({ agente: a.id, resultado: 'saltado', motivo: e instanceof Error ? e.message.slice(0, 200) : 'fallo del motor de dirección' });
      }
      continue;
    }

    // ── EL BACK OFFICE RESTANTE (0219) — vigilante, documentación, legal
    // y talento. Deterministas (gasto de modelo $0), pero el techo se mide
    // igual contra el gasto REAL del día: si algún día uno de ellos redacta
    // con modelo, el candado ya está puesto y no hay que acordarse de ponerlo.
    // Fail closed: si el gasto no se puede leer, el agente no corre.
    // Import dinámico por la misma razón que el de dirección: el módulo
    // arrastra los lectores legales y de la cola, y solo se paga cuando de
    // verdad se despacha uno de estos cuatro.
    if (BACK_OFFICE_RESTANTE.includes(a.id)) {
      try {
        const gastado = await gastoDelDiaUsd(a.id);
        if (gastado >= a.presupuesto_dia_usd) {
          agentes.push({ agente: a.id, resultado: 'saltado', motivo: `techo diario alcanzado (${gastado.toFixed(2)} de ${a.presupuesto_dia_usd} USD)` });
          continue;
        }
      } catch (e) {
        agentes.push({ agente: a.id, resultado: 'saltado', motivo: `no se pudo leer el gasto del día — fail closed (${e instanceof Error ? e.message.slice(0, 120) : 'error'})` });
        continue;
      }
      try {
        const { correrAgenteBackOffice, esAgenteBackOffice } = await import('./backoffice');
        // El estrechamiento de verdad lo hace el predicado del motor, no la
        // lista literal de arriba: si alguna vez divergen, aquí se ve.
        if (!esAgenteBackOffice(a.id)) {
          agentes.push({ agente: a.id, resultado: 'saltado', motivo: 'la lista del runner y la del motor de back office divergen — no se despacha a ciegas' });
          continue;
        }
        const r = await correrAgenteBackOffice(a.id, 'cron', undefined, venceEn);
        agentes.push({ agente: a.id, resultado: 'corrio', piezas: r.piezas, costoUsd: 0, ...(r.motivo ? { motivo: r.motivo } : {}) });
        // El reloj le quitó trabajo a este agente: sube a `saltadosPorReloj` por
        // lo mismo que el `sinTurno` del Redactor, el SDR, dirección y leads —
        // el latido tiene que decir `'parcial'`, no pintar la vuelta completa.
        if (r.sinTurno) saltadosPorReloj.push(a.id);
      } catch (e) {
        agentes.push({ agente: a.id, resultado: 'saltado', motivo: e instanceof Error ? e.message.slice(0, 200) : 'fallo del motor de back office' });
      }
      continue;
    }

    // ── ÉXITO DEL CLIENTE (0218): los seis de la flota que ya firmó ───────
    // Cinco son deterministas (gasto de modelo $0, el techo declarado es el
    // candado formal); `atencion_faq` SÍ redacta con LLM, así que se le
    // aplica el mismo candado de gasto MEDIDO que a la máquina de
    // prospección. Import dinámico por la misma razón que dirección: el
    // módulo arrastra los lectores de /admin y, en la rama del FAQ, el corpus
    // de normas y el cliente del modelo — no se paga en cada carga del runner.
    if (AGENTES_EXITO_CLIENTE.includes(a.id)) {
      if (a.id === 'atencion_faq') {
        try {
          // AUDITORÍA 24, ARQ-2 / AGB-9 (ALTO, reincidente 22→23→24): `faq.ts`
          // anota `costo_usd = NULL` cuando el proveedor omite `usage`, y
          // `gastoDelDiaUsd` SOLO suma lo medido — así que 30 llamadas/día con
          // el proveedor callado leían $0.00 contra $1.00 y el techo nunca
          // cortaba. Un costo no medido no es cero: si hay corridas de hoy sin
          // medir, el gasto real del día es desconocido y no se despacha contra
          // un techo que no se puede verificar (mismo candado que
          // `contenido_fiscal`, más abajo).
          const sinMedir = await corridasSinCostoMedidoHoy(a.id);
          if (sinMedir > 0) {
            agentes.push({ agente: a.id, resultado: 'saltado', motivo: `${sinMedir} corrida(s) de hoy con costo NO MEDIDO: el gasto real del día es desconocido y un costo desconocido no es cero — no se despacha contra un techo que no se puede verificar` });
            continue;
          }
          const gastado = await gastoDelDiaUsd(a.id);
          if (gastado >= a.presupuesto_dia_usd) {
            agentes.push({ agente: a.id, resultado: 'saltado', motivo: `techo diario alcanzado (${gastado.toFixed(2)} de ${a.presupuesto_dia_usd} USD)` });
            continue;
          }
        } catch (e) {
          agentes.push({ agente: a.id, resultado: 'saltado', motivo: `no se pudo leer el gasto del día — fail closed (${e instanceof Error ? e.message.slice(0, 120) : 'error'})` });
          continue;
        }
      }
      try {
        const { correrAgenteExito } = await import('./exito');
        // `undefined` en `hoy` y `ahora` = sus defaults de siempre; el cuarto y
        // el quinto argumento son posicionales y el reloj es el quinto.
        const r = await correrAgenteExito(a.id as AgenteDeExito, 'cron', undefined, undefined, venceEn);
        agentes.push({ agente: a.id, resultado: r.resultado, motivo: r.motivo, piezas: r.piezas, costoUsd: r.costoUsd });
        // Igual que arriba: un agente de éxito cortado a la mitad es trabajo que
        // el reloj le quitó, y el latido tiene que decirlo. `atencion_faq` es el
        // que más lo necesita — gasta modelo por ticket y `ordenarPorCosto` lo
        // despacha AL FINAL, o sea que hereda el presupuesto de tiempo que quede.
        if (r.sinTurno) saltadosPorReloj.push(a.id);
      } catch (e) {
        agentes.push({ agente: a.id, resultado: 'saltado', motivo: e instanceof Error ? e.message.slice(0, 200) : 'fallo del motor de éxito del cliente' });
      }
      continue;
    }

    // ── CRECIMIENTO (0230): los diez que fabrican material de marca ───────
    // Nueve son deterministas (gasto de modelo $0, el techo declarado es el
    // candado formal); `contenido_fiscal` SÍ redacta con LLM, así que se le
    // aplica el mismo candado de gasto MEDIDO que al FAQ y a la prospección.
    // Import dinámico por la misma razón que dirección y éxito: el módulo
    // arrastra el motor de la calculadora, el índice de normas y —en la rama
    // del contenido— el cliente del modelo; no se paga en cada vuelta.
    //
    // Ninguno de los diez toca un canal de salida: los diez encolan y ya. El
    // backpressure de cada uno vive DENTRO de su motor (una pieza por periodo,
    // arbitrada por el índice único de la 0230), así que no hace falta el
    // conteo de bandeja que sí lleva el Redactor.
    if (CRECIMIENTO.includes(a.id)) {
      if (a.id === 'contenido_fiscal') {
        try {
          // EL TECHO SE COMPARA CONTRA GASTO MEDIDO, y una corrida sin medir
          // NO es una corrida gratis (c7-11). Se pregunta ANTES de sumar: con
          // una sola corrida de hoy sin costo, el gasto real del día es
          // desconocido y comparar la suma de lo demás contra $1.00 afirmaría
          // un techo que nadie verificó. Se salta hasta el día siguiente —el
          // agente propone UN borrador por pasada, así que el costo de esperar
          // es un artículo, y el de no esperar es gastar sin tope.
          const sinMedir = await corridasSinCostoMedidoHoy(a.id);
          if (sinMedir > 0) {
            agentes.push({ agente: a.id, resultado: 'saltado', motivo: `${sinMedir} corrida(s) de hoy con costo NO MEDIDO: el gasto real del día es desconocido y un costo desconocido no es cero — no se despacha contra un techo que no se puede verificar` });
            continue;
          }
          const gastado = await gastoDelDiaUsd(a.id);
          if (gastado >= a.presupuesto_dia_usd) {
            agentes.push({ agente: a.id, resultado: 'saltado', motivo: `techo diario alcanzado (${gastado.toFixed(2)} de ${a.presupuesto_dia_usd} USD)` });
            continue;
          }
        } catch (e) {
          agentes.push({ agente: a.id, resultado: 'saltado', motivo: `no se pudo leer el gasto del día — fail closed (${e instanceof Error ? e.message.slice(0, 120) : 'error'})` });
          continue;
        }
      }
      try {
        const { correrAgenteCrecimiento, esAgenteCrecimiento } = await import('./crecimiento');
        // El estrechamiento de verdad lo hace el predicado del motor, no la
        // lista literal de arriba: si alguna vez divergen, aquí se ve (mismo
        // criterio que el back office).
        if (!esAgenteCrecimiento(a.id)) {
          agentes.push({ agente: a.id, resultado: 'saltado', motivo: 'la lista del runner y la del motor de crecimiento divergen — no se despacha a ciegas' });
          continue;
        }
        const r = await correrAgenteCrecimiento(a.id, 'cron');
        agentes.push({ agente: a.id, resultado: r.resultado, motivo: r.motivo, piezas: r.piezas, costoUsd: r.costoUsd });
      } catch (e) {
        agentes.push({ agente: a.id, resultado: 'saltado', motivo: e instanceof Error ? e.message.slice(0, 200) : 'fallo del motor de crecimiento' });
      }
      continue;
    }

    // ── INGENIERÍA (0234): los ocho que cuidan la máquina por dentro ──────
    // Los ocho son DETERMINISTAS y no llaman a ningún modelo (gasto de modelo
    // $0 MEDIDO, no NULL): el techo declarado es el candado formal, y el día
    // que alguno redacte con modelo el freno ya está puesto sin acordarse.
    // Import dinámico por la misma razón que dirección, éxito y crecimiento:
    // los dos módulos arrastran los lectores del catálogo de PostgreSQL y del
    // despliegue; no se pagan en cada vuelta.
    //
    // Ninguno toca un canal de salida: los ocho encolan un parte semanal y ya.
    // El backpressure de cada uno vive DENTRO de su motor (un parte por
    // periodo, arbitrado por el índice único de la 0234), así que no hace
    // falta el conteo de bandeja que sí lleva el Redactor.
    if (INGENIERIA.includes(a.id)) {
      try {
        const { correrAgenteIngenieria, esAgenteIngenieria } = await import('./ingenieria');
        // El estrechamiento de verdad lo hace el predicado del motor, no la
        // lista literal de arriba: si alguna vez divergen, aquí se ve (mismo
        // criterio que el back office y crecimiento).
        if (!esAgenteIngenieria(a.id)) {
          agentes.push({ agente: a.id, resultado: 'saltado', motivo: 'la lista del runner y la del motor de ingeniería divergen — no se despacha a ciegas' });
          continue;
        }
        const r = await correrAgenteIngenieria(a.id, 'cron');
        agentes.push({ agente: a.id, resultado: r.resultado, motivo: r.motivo, piezas: r.piezas, costoUsd: r.costoUsd });
      } catch (e) {
        agentes.push({ agente: a.id, resultado: 'saltado', motivo: e instanceof Error ? e.message.slice(0, 200) : 'fallo del motor de ingeniería' });
      }
      continue;
    }

    // ── DIRECCIÓN A LA BANDEJA (0235): automejora, especialistas de
    // incidente y fundraising. Van en una rama APARTE de la de la 0216 —y no
    // en la de arriba— porque su salida es otra: aquéllos MANDAN correo y
    // sellan `reporte_direccion`; éstos encolan y esperan el tap de Javier.
    // Meterlos en la misma rama obligaría al motor de allá a distinguir dos
    // contratos de salida, que es justo lo que la separación de archivos evita.
    //
    // Deterministas: gasto de modelo $0 y ninguno arrastra el cliente del
    // modelo, así que el import dinámico es por el mismo motivo que el de
    // crecimiento —no cargar `@/lib/admin/salud` ni los lectores de la cola en
    // cada vuelta—, no por costo de tokens.
    if (DIRECCION_BANDEJA.includes(a.id)) {
      try {
        const { correrAgenteDireccionBandeja, esAgenteDireccionBandeja } = await import('./direccion');
        // El estrechamiento de verdad lo hace el predicado del motor, no la
        // lista literal de arriba (mismo criterio que el back office).
        if (!esAgenteDireccionBandeja(a.id)) {
          agentes.push({ agente: a.id, resultado: 'saltado', motivo: 'la lista del runner y la del motor de dirección-bandeja divergen — no se despacha a ciegas' });
          continue;
        }
        const r = await correrAgenteDireccionBandeja(a.id, 'cron', undefined, venceEn);
        agentes.push({ agente: a.id, resultado: r.resultado, motivo: r.motivo, piezas: r.piezas, costoUsd: r.costoUsd });
        // Se quedó sin reloj a media búsqueda de candidato: el agente corrió,
        // pero no alcanzó a mirarlos todos. Sube a `saltadosPorReloj` por lo
        // mismo que el `sinTurno` del Redactor y del SDR — el latido tiene que
        // decir que la vuelta quedó a medias, no pintarla completa.
        if (r.sinTurno) saltadosPorReloj.push(a.id);
      } catch (e) {
        agentes.push({ agente: a.id, resultado: 'saltado', motivo: e instanceof Error ? e.message.slice(0, 200) : 'fallo del motor de dirección' });
      }
      continue;
    }

    // ── LEADS (0235): los seis que cierran el catálogo en 60/60 ───────────
    // Los seis son deterministas (gasto de modelo $0; el techo declarado es el
    // candado formal, y el runner lo mediría contra el gasto REAL el día que
    // alguno redacte con modelo). Ninguno escribe a nadie ni muta el CRM: los
    // seis encolan y ya. Su backpressure vive DENTRO de cada motor —una pieza
    // por periodo o por empresa, arbitrada por el índice único de la 0235—,
    // así que no hace falta el conteo de bandeja que sí lleva el Redactor.
    if (LEADS.includes(a.id)) {
      try {
        const { correrAgenteLeads, esAgenteLeads } = await import('./leads');
        if (!esAgenteLeads(a.id)) {
          agentes.push({ agente: a.id, resultado: 'saltado', motivo: 'la lista del runner y la del motor de leads divergen — no se despacha a ciegas' });
          continue;
        }
        const r = await correrAgenteLeads(a.id, 'cron', undefined, venceEn);
        agentes.push({ agente: a.id, resultado: r.resultado, motivo: r.motivo, piezas: r.piezas, costoUsd: r.costoUsd });
        // Se quedó sin reloj a media búsqueda de candidato: el agente corrió,
        // pero no alcanzó a mirarlos todos. Sube a `saltadosPorReloj` por lo
        // mismo que el `sinTurno` del Redactor y del SDR — el latido tiene que
        // decir que la vuelta quedó a medias, no pintarla completa.
        if (r.sinTurno) saltadosPorReloj.push(a.id);
      } catch (e) {
        agentes.push({ agente: a.id, resultado: 'saltado', motivo: e instanceof Error ? e.message.slice(0, 200) : 'fallo del motor de leads' });
      }
      continue;
    }

    // ── LA MÁQUINA DE PROSPECCIÓN (0217) — investigador, SDR y enviador ──
    // Los tres corren para LIKIDA (tenant null), así que su techo de dinero
    // no pasa por el ledger por-tenant del Redactor: se compara el gasto
    // MEDIDO del día (agente_corrida.costo_usd, que sus corridas escriben)
    // contra el presupuesto declarado. Menos fino que la reserva atómica —
    // dos vueltas simultáneas podrían leer el mismo gasto — pero el cron
    // corre cada 4 horas y cada corrida anota su costo: la ventana real es
    // minutos, y el fallo es visible en la ficha, no silencioso. Fail
    // closed: si el gasto del día no se puede leer, el agente no corre.
    if (a.id === 'enriquecedor' || a.id === 'sdr' || a.id === 'enviador') {
      try {
        const gastado = await gastoDelDiaUsd(a.id);
        if (gastado >= a.presupuesto_dia_usd) {
          agentes.push({ agente: a.id, resultado: 'saltado', motivo: `techo diario alcanzado (${gastado.toFixed(2)} de ${a.presupuesto_dia_usd} USD)` });
          continue;
        }
      } catch (e) {
        agentes.push({ agente: a.id, resultado: 'saltado', motivo: `no se pudo leer el gasto del día — fail closed (${e instanceof Error ? e.message.slice(0, 120) : 'error'})` });
        continue;
      }
      try {
        if (a.id === 'enriquecedor') {
          const ids = await candidatosSinDossier(topePiezasPorCorrida());
          let piezas = 0, saltados = 0, costoUsd = 0, sinTurno = 0;
          for (let j = 0; j < ids.length; j++) {
            // El mismo reloj del lote del Redactor, por la misma razón (c7-1):
            // `investigarProspecto` gasta modelo y este `for` no lo miraba. Es
            // el segundo motor que itera dentro de este archivo; los dos
            // preguntan lo mismo con la misma función, y el `Promise.race` de
            // la ruta cubre a cualquier tercero que se agregue sin preguntar.
            if (relojAgotado(venceEn)) {
              sinTurno = ids.length - j;
              logger.warn('runner.enriquecedor.corte_por_reloj', { sinTurno, piezas, saltados });
              break;
            }
            const id = ids[j];
            try {
              const r = await investigarProspecto(id, 'cron');
              piezas += 1;
              costoUsd += r.costoUsd;
            } catch (e) {
              saltados += 1;
              logger.info('runner.investigador.saltado', { prospecto: id, motivo: e instanceof Error ? e.message.slice(0, 160) : String(e) });
            }
          }
          agentes.push({
            agente: a.id, resultado: 'corrio', piezas, saltados, costoUsd,
            ...(sinTurno > 0 ? { motivo: motivoLoteCortado(sinTurno) } : {}),
          });
          if (sinTurno > 0) saltadosPorReloj.push(a.id);
        } else if (a.id === 'sdr') {
          const r = await correrSdr('cron', topePiezasPorCorrida(), venceEn);
          agentes.push({
            agente: a.id, resultado: 'corrio', piezas: r.piezas, saltados: r.saltados, costoUsd: r.costoUsd,
            ...(r.sinTurno > 0 ? { motivo: motivoLoteCortado(r.sinTurno) } : {}),
          });
          if (r.sinTurno > 0) saltadosPorReloj.push(a.id);
        } else {
          const r = await correrEnviador('cron', topePiezasPorCorrida() * 2, venceEn);
          agentes.push({
            agente: a.id, resultado: 'corrio', piezas: r.piezasEnviadas, saltados: r.saltadas, costoUsd: 0,
            ...(r.sinTurno > 0 ? { motivo: motivoLoteCortado(r.sinTurno) } : {}),
          });
          if (r.sinTurno > 0) saltadosPorReloj.push(a.id);
        }
      } catch (e) {
        agentes.push({ agente: a.id, resultado: 'saltado', motivo: e instanceof Error ? e.message.slice(0, 200) : 'fallo del lote' });
      }
      continue;
    }

    // Un agente habilitado sin motor despachable: se dice, no se finge.
    agentes.push({ agente: a.id, resultado: 'saltado', motivo: 'sin motor despachable en el runner todavía — habilitarlo aquí exige su rama de despacho' });
  }

  avance.enVuelo = null;
  avance.pendientes = [];
  return { apagadoGlobal: false, agentes, saltadosPorReloj };
}

// ═══════════════════════════════════════════════════════════════════════════
// EL TECHO ESTRUCTURAL DE LA VUELTA (auditoría ciclo 7, c7-1).
//
// EL PROBLEMA QUE ESTO RESUELVE, Y POR QUÉ EL RELOJ DE ARRIBA NO BASTABA.
// El candado 0 y los relojes de cada motor son COOPERATIVOS: funcionan porque
// alguien se acordó de preguntar. El 25-ago-2026 se acordaron en el despacho y
// no en `loteRedactor`; el resultado fue una función muerta a los 300 s DENTRO
// del bucle, sin `try` ni `catch` de la ruta y por lo tanto SIN LATIDO — la
// alerta «Sin latido: runner hace 286 min» y, tres días después, el mismo
// silencio del 28-ago-2026 00:03 UTC. Arreglar los motores que hoy existen no
// impide que el motor número once, escrito el mes que viene por alguien que no
// leyó este archivo, vuelva a hacerlo exactamente igual.
//
// Así que el techo deja de ser una disciplina y pasa a ser una RESTRICCIÓN: la
// ruta no espera a la vuelta, espera a la CARRERA entre la vuelta y el reloj. Un
// motor que ignore su `venceEn`, que se cuelgue en un `fetch` sin tope o que
// simplemente no exista todavía ya no puede quitarle a la ruta su margen para
// latir, porque la ruta deja de esperarlo pase lo que pase. `route.test.ts`
// verifica que la ruta siga envuelta en esto leyendo su fuente: quitarla es una
// prueba en rojo, no un descuido silencioso.
//
// Lo que esto NO hace, dicho para que nadie lo suponga: no CANCELA la vuelta.
// La promesa perdedora sigue corriendo hasta que Vercel apaga la invocación —
// no hay forma de matar un `await` a la mitad en JS. Lo que sí hace es que la
// invocación termine por la puerta de la ruta (respondiendo y latiendo) en vez
// de por el hachazo del `maxDuration`. Un agente que quedó a medias no pierde
// trabajo: sus escrituras son idempotentes o no ocurrieron.
// ═══════════════════════════════════════════════════════════════════════════

/** El testigo del corte. Un `Symbol` y no `null`/`undefined` para que una
 *  vuelta que legítimamente resolviera a nulo no se confunda con un corte. */
const CORTE_DURO = Symbol('runner.corte_duro');

export async function conRelojDuro<T>(
  trabajo: PromiseLike<T>,
  /** El MISMO instante que se le pasó a la vuelta como `venceEn`. Que sea el
   *  mismo es lo que hace que el corte duro sea la RED y no el freno normal:
   *  con todos los motores portándose bien, la vuelta termina antes y este
   *  temporizador nunca gana. */
  venceEn: number,
  /** Qué devolver cuando el reloj gana. Se pasa como función y no como valor
   *  porque el parte de lo que alcanzó a pasar solo se puede leer DESPUÉS. */
  alVencer: () => T,
): Promise<T> {
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race<T | typeof CORTE_DURO>([
      trabajo,
      new Promise<typeof CORTE_DURO>((resolver) => {
        // `Math.max(0, …)`: un `venceEn` ya pasado corta de inmediato en vez de
        // programar un temporizador negativo (que en Node dispara al instante,
        // sí, pero depender de eso sería depender de un detalle).
        temporizador = setTimeout(() => resolver(CORTE_DURO), Math.max(0, venceEn - Date.now()));
      }),
    ]);
    return r === CORTE_DURO ? alVencer() : r;
  } finally {
    clearTimeout(temporizador);
  }
}

/** El parte de una vuelta que el reloj duro cortó por fuera: convierte lo que
 *  el `AvanceRunner` alcanzó a registrar en un `ResultadoRunner` honesto.
 *
 *  Nombra a los dos grupos que el corte deja: el que estaba EN VUELO (el motor
 *  dentro del cual murió la invocación — el Redactor, en los dos incidentes) y
 *  los que ni siquiera llegaron a su turno. Los dos suben a `saltadosPorReloj`,
 *  así que el latido dice `'parcial'` y la racha de cortes cuenta. */
export function cerrarPorRelojDuro(avance: AvanceRunner): ResultadoRunner {
  // Dedupe: `enVuelo` puede haber quedado apuntando a un agente que ya se
  // reportó (se despachó y se saltó por otro candado, y el corte cayó entre esa
  // iteración y la siguiente). Nombrarlo dos veces sería inventar un agente.
  const yaDichos = new Set(avance.agentes.map((x) => x.agente));
  if (avance.enVuelo && !yaDichos.has(avance.enVuelo)) {
    avance.agentes.push({
      agente: avance.enVuelo,
      resultado: 'saltado',
      motivo: 'CORTADO EN VUELO — el reloj duro de la vuelta venció mientras este motor corría; lo que alcanzó a fabricar queda, el resto le toca en la próxima pasada',
    });
    avance.saltadosPorReloj.push(avance.enVuelo);
    yaDichos.add(avance.enVuelo);
  }
  for (const id of avance.pendientes) {
    if (yaDichos.has(id)) continue;
    avance.agentes.push({
      agente: id,
      resultado: 'saltado',
      motivo: 'saltado por reloj — la vuelta se cortó antes de llegarle; le toca en la próxima pasada',
    });
    avance.saltadosPorReloj.push(id);
  }
  logger.error('runner.corte_duro', {
    enVuelo: avance.enVuelo,
    saltadosPorReloj: avance.saltadosPorReloj,
    corridos: avance.agentes.filter((x) => x.resultado === 'corrio').length,
  });
  return {
    apagadoGlobal: avance.apagadoGlobal,
    agentes: avance.agentes,
    saltadosPorReloj: avance.saltadosPorReloj,
    cortadaPorRelojDuro: true,
  };
}
