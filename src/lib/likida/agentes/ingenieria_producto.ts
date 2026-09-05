// ═══════════════════════════════════════════════════════════════════════════
// INGENIERÍA, LA MITAD QUE NO MIRA EL ESQUEMA (0234):
//
//   · pruebas              — los RESULTADOS que sí llegan a la base, y el
//                            ENCARGO de la rutina local que este servidor no
//                            puede correr.
//   · auditor_codigo       — el ARTEFACTO DESPLEGADO contra la base.
//   · producto             — señal real → backlog priorizado. Propone, no decide.
//   · datos_instrumentacion— qué pregunta del negocio NO tiene dato hoy.
//
// Viven aparte de `ingenieria.ts` por lo mismo que `faq.ts` se separó de
// `exito.ts`: el runner carga el módulo por import dinámico y no tiene por qué
// pagar los cuatro de aquí cuando le toca despachar `seguridad`. Los helpers
// compartidos (aritmética, bandeja, semáforo, lecturas por valor) se importan
// del hermano en vez de duplicarse: dos copias del mismo helper divergen en
// silencio, y este es justo el departamento que se supone caza eso.
//
// ── LO QUE ESTOS CUATRO NO PUEDEN HACER, Y LO DICEN ───────────────────────
//
// `pruebas` NO corre la suite y `auditor_codigo` NO lee el código. Desde una
// función serverless no hay repo, no hay `vitest`, no hay `tsc`, no hay `git`
// y no hay linter. Fingir lo contrario sería la mentira más cara que un
// producto como éste puede contar sobre sí mismo.
//
// Lo que SÍ hacen, y que nadie más está haciendo hoy:
//   · `pruebas` mira lo único que la suite deja atrás cuando pasa a producción
//     —el comportamiento REAL de las corridas— y arma el encargo exacto para
//     la rutina local, ANCLADO AL SHA que está corriendo.
//   · `auditor_codigo` audita el artefacto DESPLEGADO contra la base: agentes
//     que la base declara vivos y que el bundle no sabe despachar, ramas del
//     bundle que la base no tiene vivas, y el drift entre la lista
//     INTERRUPTORES del código y el dominio del CHECK. Las tres son formas del
//     «mergeado no es desplegado» y las tres SÍ se ven desde aquí.
// ═══════════════════════════════════════════════════════════════════════════
import { supabaseAdmin } from '@/lib/supabase/admin';
import { acotada } from '../presupuesto';
import { traerTodo } from '../pg';
import { numero } from '@/lib/formato';
import { INTERRUPTORES } from '../interruptores';
import { type DisparoCorrida } from './corridas';
import { logger } from '@/lib/logger';
import {
  type AgenteIngenieria, type ResultadoIngenieria, type Hallazgo,
  type FichaAgente, type ModuloRunner, type Perfil,
  lunesDe, masDias, inicioDia, muestra, recortar, pintarHallazgos,
  porValor, lineaFuentesCiegas, type Lectura,
  parteExistente, encolarParte, anotar, alertarRojos, censoPrevio,
  leerCatalogo, autonomos, leerPerfil, PIE_ALCANCE, shaDesplegado, entornoDesplegado,
  leerDespliegueVisto,
} from './ingenieria';

// ═══════════════════════════════════════════════════════════════════════════
// 5 · PRUEBAS — la conducta que la suite ya no ve.
//
// LA HONESTIDAD DE ESTE AGENTE ES SU RAZÓN DE SER. Su blueprint (0125) decía
// «mantiene la suite — ESCRIBE código de prueba». Eso no se puede hacer desde
// Vercel, y en vez de fingirlo el motor hace lo que sí vale desde aquí: mirar
// los RESULTADOS que llegan a la base y convertirlos en el encargo de la
// rutina local, con el SHA que está corriendo escrito en el parte para que lo
// que se corra en la Mac sea el mismo código.
// ═══════════════════════════════════════════════════════════════════════════

export interface CorridaVista {
  agente: string;
  estado: 'ok' | 'parcial' | 'fallo';
  inicio: string;
  tareasHechas: number | null;
  tareasTotal: number | null;
  error: string | null;
}

/** Corridas que UNA ventana lee como máximo. Si se llena, el parte lo DICE. */
export const TOPE_CORRIDAS = 5000;

/** Las corridas de la ventana. LANZA si la bitácora no se puede leer: un parte
 *  de pruebas sobre una bitácora ciega afirmaría «nadie falló». */
export async function leerCorridas(desdeIso: string, hastaIso: string): Promise<{ corridas: CorridaVista[]; truncado: boolean }> {
  const { data, error, count } = await acotada(supabaseAdmin()
    .from('agente_corrida')
    // `count: 'exact'` y no `length === tope`: PostgREST recorta a `max_rows`
    // sin avisar (lección ESC-8), así que comparar el largo contra el `.limit()`
    // no detecta nada.
    .select('agente, estado, inicio, tareas_hechas, tareas_total, error', { count: 'exact' })
    .gte('inicio', desdeIso)
    .lt('inicio', hastaIso)
    .order('inicio', { ascending: false })
    .limit(TOPE_CORRIDAS), 'ingenieria.pruebas_corridas');
  if (error) throw new Error(`leerCorridas: ${error.message}`);
  const filas = (data ?? []) as Array<Record<string, unknown>>;
  const truncado = typeof count === 'number' ? count > filas.length : filas.length >= TOPE_CORRIDAS;
  return {
    truncado,
    corridas: filas.map((f) => ({
      agente: String(f.agente),
      estado: f.estado as CorridaVista['estado'],
      inicio: String(f.inicio),
      tareasHechas: f.tareas_hechas === null || f.tareas_hechas === undefined ? null : Number(f.tareas_hechas),
      tareasTotal: f.tareas_total === null || f.tareas_total === undefined ? null : Number(f.tareas_total),
      error: (f.error as string | null) ?? null,
    })),
  };
}

/**
 * La FIRMA de un error: el texto normalizado a lo que lo hace repetible.
 * Se borran uuids, números, fechas y comillas — dos fallos del mismo bug traen
 * distinto folio y la misma forma, y agruparlos por texto crudo daría cien
 * «patrones» de una sola ocurrencia cada uno.
 */
export function firmaDeError(texto: string | null): string | null {
  const s = (texto ?? '').trim();
  if (s === '') return null;
  // CADA PASADA ES DE ALTURA DE ESTRELLA 1, a propósito: la versión con
  // grupos opcionales anidados (`\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?`)
  // la marca `security/detect-unsafe-regex`, y esto corre sobre texto de error
  // que puede venir de cualquier lado. De lo más específico a lo más general,
  // que es lo que hace que el orden importe.
  return s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g, '<fecha>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/g, '<fecha>')
    .replace(/\d{4}-\d{2}-\d{2}/g, '<fecha>')
    .replace(/\d+[.,]\d+/g, '<n>')
    .replace(/\d+/g, '<n>')
    .replace(/[«»"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

export interface PatronError { firma: string; veces: number; agentes: string[]; ejemplo: string }

/** Agrupa los errores por firma. Solo los que se REPITEN son patrón: un fallo
 *  único puede ser un bache de red, y tratarlo como patrón enseña a ignorar la
 *  sección entera. */
export const MIN_REPETICIONES_PATRON = 2;

export function patronesDeError(corridas: CorridaVista[]): PatronError[] {
  const acc = new Map<string, { veces: number; agentes: Set<string>; ejemplo: string }>();
  for (const c of corridas) {
    if (c.estado !== 'fallo') continue;
    const firma = firmaDeError(c.error);
    if (firma === null) continue;
    const a = acc.get(firma) ?? { veces: 0, agentes: new Set<string>(), ejemplo: c.error ?? '' };
    a.veces += 1;
    a.agentes.add(c.agente);
    acc.set(firma, a);
  }
  return [...acc.entries()]
    .filter(([, a]) => a.veces >= MIN_REPETICIONES_PATRON)
    .map(([firma, a]) => ({ firma, veces: a.veces, agentes: [...a.agentes].sort(), ejemplo: a.ejemplo }))
    .sort((x, y) => y.veces - x.veces);
}

export interface LatidoCron { id: string; estado: string; ultimo: string }

/** El latido de los crons. LANZA si no se lee. */
export async function leerLatidos(): Promise<LatidoCron[]> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('cron_latido')
    .select('id, estado, ultimo_latido')
    .order('id')
    .limit(50), 'ingenieria.latidos');
  if (error) throw new Error(`leerLatidos: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((f) => ({
    id: String(f.id), estado: String(f.estado), ultimo: String(f.ultimo_latido),
  }));
}

/** El corte de despliegue que acota los conteos de fallos: desde cuándo corre
 *  el SHA vigente, según `despliegue_visto`. `null` = no se pudo acotar (sin
 *  SHA, o el SHA aún no consta) y el parte LO DICE. */
export interface CorteDespliegue { sha: string; primeraVista: string }

/** La ventana declarada del parte, en fechas 'YYYY-MM-DD' (cerrada en hasta). */
export interface VentanaPruebas { desde: string; hasta: string }

export function evaluarPruebas(
  corridas: CorridaVista[],
  truncado: boolean,
  catalogo: Lectura<FichaAgente[]>,
  latidos: Lectura<LatidoCron[]>,
  ahoraMs: number,
  ventana: VentanaPruebas,
  corte: CorteDespliegue | null,
): Hallazgo[] {
  const hallazgos: Hallazgo[] = [];

  if (truncado) {
    hallazgos.push({
      semaforo: 'NOTA', codigo: 'T0', objeto: `ventana truncada a ${numero(TOPE_CORRIDAS)}`,
      detalle: 'la semana tuvo más corridas de las que este parte alcanzó a leer.',
      evidencia: 'las que faltan son las MÁS VIEJAS de la ventana (se lee en orden descendente). Un fallo que viva en las no leídas NO aparece aquí.',
    });
  }

  // ── LA VENTANA SE ACOTA AL DESPLIEGUE VIGENTE (incidente 28-ago-2026) ────
  //
  // La noche del 28-ago este agente mandó un «Urgente» por 12 fallos con la
  // misma firma… que eran historia ya arreglada: los PR que los cerraron
  // estaban mergeados y desplegados, y en las últimas 24 h el agente acusado
  // llevaba todas sus corridas en ok. Un fallo del CÓDIGO ANTERIOR no es una
  // herida: es un cadáver, y reportarlo como herida enseña a ignorar el canal.
  //
  // Desde entonces T1/T2/T3 solo cuentan corridas INICIADAS DESPUÉS de la
  // primera vista del SHA vigente (`despliegue_visto`, que `releases` ya
  // escribe). Lo anterior al corte no desaparece: se declara como NOTA (T6),
  // con su conteo — si la firma reaparece bajo el código vigente, vuelve a
  // contar sola. T4 (agentes mudos) y T5 (latidos) siguen sobre la ventana
  // completa: la AUSENCIA de corridas necesita la ventana larga para
  // significar algo, y el latido se mide contra el reloj de ahora.
  const corteMs = corte === null ? null : Date.parse(corte.primeraVista);
  const hayCorte = corteMs !== null && !Number.isNaN(corteMs);
  const vigentes = !hayCorte ? corridas : corridas.filter((c) => {
    const t = Date.parse(c.inicio);
    // Un inicio ilegible se queda DENTRO: excluirlo callaría un fallo real.
    return Number.isNaN(t) || t >= corteMs;
  });
  const desdeEfectivo = hayCorte && corte !== null && corte.primeraVista.slice(0, 10) > ventana.desde
    ? corte.primeraVista.slice(0, 10) : ventana.desde;
  const periodo = `entre el ${desdeEfectivo} y el ${ventana.hasta}`;

  const porAgente = new Map<string, CorridaVista[]>();
  for (const c of vigentes) {
    const l = porAgente.get(c.agente) ?? [];
    l.push(c);
    porAgente.set(c.agente, l);
  }

  // T1 — fallos por agente, absolutos primero y la tasa solo como contexto.
  // El conteo SIEMPRE lleva su periodo: un número sin fechas no se puede
  // refutar, y lo irrefutable no es evidencia.
  for (const agente of [...porAgente.keys()].sort()) {
    const lista = porAgente.get(agente) as CorridaVista[];
    const fallos = lista.filter((c) => c.estado === 'fallo');
    if (fallos.length === 0) continue;
    const tasa = fallos.length / lista.length;
    hallazgos.push({
      semaforo: tasa >= 0.5 && lista.length >= 2 ? 'ROJO' : 'AMBAR',
      codigo: 'T1', objeto: agente,
      detalle: `${numero(fallos.length)} de ${numero(lista.length)} corrida(s) en fallo ${periodo}${hayCorte && corte !== null ? ` (bajo el SHA vigente ${corte.sha.slice(0, 7)})` : ''}.`,
      evidencia: `la más reciente: ${fallos[0].inicio.slice(0, 10)} — «${recortar(fallos[0].error, 180) || 'sin texto de error anotado'}». Una prueba de regresión sobre este camino es exactamente lo que falta.`,
    });
  }

  // T2 — VERDE VACÍO: dijo ok y no hizo nada de lo que se propuso. Es LA
  // lección de las ~216 corridas verdes con el motor roto.
  for (const agente of [...porAgente.keys()].sort()) {
    const lista = porAgente.get(agente) as CorridaVista[];
    const vacias = lista.filter((c) => c.estado === 'ok' && c.tareasHechas === 0 && (c.tareasTotal ?? 0) > 0);
    if (vacias.length === 0) continue;
    hallazgos.push({
      semaforo: 'ROJO', codigo: 'T2', objeto: agente,
      detalle: `${numero(vacias.length)} corrida(s) VERDE VACÍO ${periodo}: dijeron ok y produjeron 0 tareas de las que se propusieron.`,
      evidencia: `${muestra(vacias.slice(0, 3).map((c) => `${c.inicio.slice(0, 10)} (0 de ${c.tareasTotal})`), 3)}. Una suite que solo mira el estado de salida no ve esto: la prueba que falta es la que afirma el EFECTO, no el «ok».`,
    });
  }

  // T3 — patrones repetidos: el bug que ya se ganó su prueba. Solo sobre las
  // corridas del código vigente, y con el periodo escrito en el detalle.
  for (const p of patronesDeError(vigentes).slice(0, 5)) {
    hallazgos.push({
      semaforo: p.veces >= 5 ? 'ROJO' : 'AMBAR',
      codigo: 'T3', objeto: muestra(p.agentes, 4),
      detalle: `${numero(p.veces)} fallos con la MISMA firma de error ${periodo}.`,
      evidencia: `«${recortar(p.ejemplo, 200)}». Repetido ${numero(p.veces)} veces no es un bache: es un camino sin prueba.`,
    });
  }

  // T6 — lo que quedó FUERA del conteo y por qué. No es un hallazgo contra
  // nadie: es la constancia de que la historia del código anterior existe y
  // de que NO se contó como alerta.
  if (hayCorte && corte !== null) {
    const excluidos = corridas.length - vigentes.length;
    const fallosExcluidos = corridas.filter((c) => {
      const t = Date.parse(c.inicio);
      return c.estado === 'fallo' && !Number.isNaN(t) && t < corteMs;
    }).length;
    if (fallosExcluidos > 0) {
      hallazgos.push({
        semaforo: 'NOTA', codigo: 'T6', objeto: `${numero(fallosExcluidos)} fallo(s) anteriores al despliegue vigente`,
        detalle: `quedaron FUERA del conteo de T1/T3: ocurrieron antes de que este servidor viera el SHA ${corte.sha.slice(0, 7)} (${corte.primeraVista.slice(0, 19).replace('T', ' ')} UTC).`,
        evidencia: `${numero(excluidos)} corrida(s) de la ventana son del código anterior. Un fallo ya arreglado y desplegado no es una alerta — es historia; si su firma reaparece bajo el código vigente, T3 la vuelve a contar sola. (Es la corrección del incidente del 28-ago-2026: 12 fallos ya cerrados por PR salieron como «Urgente».)`,
      });
    }
  } else {
    hallazgos.push({
      semaforo: 'NOTA', codigo: 'T6', objeto: 'ventana sin acotar al despliegue',
      detalle: corte === null
        ? 'no se pudo saber desde cuándo corre el código vigente: los conteos de arriba pueden incluir fallos de código anterior ya arreglado.'
        : 'la primera vista del SHA vigente no trae un instante legible: los conteos no se acotaron.',
      evidencia: 'sin SHA declarado o sin fila en despliegue_visto (la escribe el agente releases). Se dice para que ningún conteo se lea como «reproducible hoy» sin serlo.',
    });
  }

  // T4 — el agente vivo que no corrió NUNCA en la ventana COMPLETA. Distinto
  // de fallar: no hay ni el dato de que se intentó. (A propósito sin acotar
  // al despliegue: la ausencia necesita la ventana larga para ser señal.)
  if (catalogo.valor) {
    const vistos = new Set(corridas.map((c) => c.agente));
    const mudos = autonomos(catalogo.valor).filter((f) => !vistos.has(f.id)).map((f) => f.id);
    if (mudos.length > 0) {
      hallazgos.push({
        semaforo: 'AMBAR', codigo: 'T4', objeto: muestra(mudos, 10),
        detalle: `${numero(mudos.length)} agente(s) vivos y habilitados en el runner SIN una sola corrida en la ventana.`,
        evidencia: 'no fallaron: no consta que se hayan intentado. O el runner no llegó a ellos (corte por reloj), o el kill switch está abierto, o su rama de despacho no existe en el bundle desplegado — las tres se distinguen en el parte de auditor_codigo y en el log del cron.',
      });
    }
  }

  // T5 — el latido del cron. Si el runner está mudo, todo lo de arriba está
  // midiendo una semana en la que el orquestador ni corrió.
  if (latidos.valor) {
    const viejos = latidos.valor.filter((l) => {
      const t = Date.parse(l.ultimo);
      return !Number.isNaN(t) && ahoraMs - t > 24 * 3_600_000;
    });
    const enFallo = latidos.valor.filter((l) => l.estado === 'fallo');
    if (viejos.length > 0 || enFallo.length > 0) {
      hallazgos.push({
        semaforo: 'ROJO', codigo: 'T5', objeto: muestra([...new Set([...viejos, ...enFallo].map((l) => l.id))]),
        detalle: `${numero(viejos.length)} cron(es) sin latido en más de 24 h y ${numero(enFallo.length)} con último estado 'fallo'.`,
        evidencia: [...viejos, ...enFallo].slice(0, 5).map((l) => `${l.id}: ${l.estado}, último ${l.ultimo.slice(0, 19).replace('T', ' ')}`).join(' · ')
          + '. Un cron mudo hace que TODO conteo de corridas de esta ventana sea un piso, no una medida.',
      });
    }
  }

  return hallazgos;
}

/** El encargo para la Mac. Es la parte del agente que NO puede correr aquí y
 *  por eso se escribe entera, con el SHA para que se corra sobre este código. */
export function encargoLocal(sha: string | null): string[] {
  return [
    'ENCARGO PARA LA RUTINA LOCAL (esto NO lo corrió este agente y no puede correrlo):',
    `  Sobre el commit: ${sha ? sha : 'SIN SHA DECLARADO — verifica en qué commit está producción antes de correr nada'}`,
    '  1. npx tsc --noEmit -p .',
    '  2. npx vitest run                  (la suite completa)',
    '  3. npx vitest run --coverage       (el trinquete: líneas/statements 78, ramas 69, funciones 82)',
    '  4. npm run lint:ratchet            (cero warnings nuevos)',
    '  5. La batería SQL: andamio_ci.sql + las migraciones una por una + ',
    '     node scripts/ci/correr-verificaciones.mjs supabase/pruebas-aislamiento/capa1_auditoria_estatica.sql supabase/verificaciones.sql',
    '  6. Por cada hallazgo T1/T2/T3 de arriba: la prueba de regresión que ese camino no tenía.',
  ];
}

export function armarPartePruebas(
  hallazgos: Hallazgo[], corridas: number, agentes: number, desde: string, hasta: string,
  sha: string | null, ciegas: string | null, corte: CorteDespliegue | null = null,
): string {
  const lineas = [
    `PRUEBAS — semana del ${desde} (ventana: ${desde} a ${hasta}, cerrada)`,
    '',
    `Observado: ${numero(agentes)} agente(s) con corrida · ${numero(corridas)} corrida(s) en la ventana.`,
    corte
      ? `LOS FALLOS SE CUENTAN DESDE EL DESPLIEGUE VIGENTE: SHA ${corte.sha.slice(0, 7)}, visto por primera vez el ${corte.primeraVista.slice(0, 19).replace('T', ' ')} UTC. Lo anterior a esa marca es historia del código anterior y va como nota, no como alerta (incidente 28-ago-2026).`
      : 'VENTANA SIN ACOTAR AL DESPLIEGUE: no consta desde cuándo corre el código vigente, así que los conteos pueden incluir fallos ya arreglados — y se dice en vez de callarse.',
    '',
  ];
  if (ciegas) { lineas.push(ciegas, ''); }
  lineas.push(...pintarHallazgos(hallazgos, 'Nada disparó umbral en la conducta observada: ningún fallo, ningún verde vacío, ningún patrón repetido y todos los crons con latido fresco. Eso NO dice que la suite pase — dice que producción no se quejó.'));
  lineas.push('');
  lineas.push(...encargoLocal(sha));
  lineas.push('');
  lineas.push('LO QUE ESTE AGENTE NO HIZO, TAL CUAL: no corrió una sola prueba. Desde una función serverless de Vercel no hay repo, no hay vitest y no hay tsc — este parte mide la CONDUCTA de producción, que es la otra mitad, y deja escrito el encargo de la mitad que vive en la Mac. Un parte que dijera «la suite pasa» sería mentira.');
  lineas.push('DIFERENCIA CON EL VIGILANTE DE CALIDAD (0219): aquél audita a los agentes como PRODUCTO (rechazos humanos, costo fuera de banda). Éste mira lo mismo desde el lado de la INGENIERÍA: qué camino no tiene prueba.');
  lineas.push(PIE_ALCANCE);
  lineas.push('Fuentes: agente_corrida (ventana cerrada) · agente_definicion (los habilitados) · cron_latido · despliegue_visto (desde cuándo corre el SHA vigente).');
  return lineas.join('\n');
}

async function correrPruebas(disparo: DisparoCorrida, hoy: string): Promise<ResultadoIngenieria> {
  const inicio = new Date();
  const agente = 'pruebas';
  const lunes = lunesDe(hoy);
  const desde = masDias(lunes, -7);
  const titulo = `Pruebas — semana del ${desde}`;
  try {
    if (await parteExistente(agente, titulo)) {
      await anotar(agente, inicio, 'ok', disparo, { parte: 'ya_existia', titulo });
      return { resultado: 'saltado', piezas: 0, costoUsd: 0, motivo: 'el parte de la semana auditada ya está en la bandeja' };
    }
    const lote = await leerCorridas(inicioDia(desde), inicioDia(lunes));
    const sha = shaDesplegado();
    const [catalogo, latidos, despliegue] = await Promise.all([
      porValor('catálogo de agentes', leerCatalogo),
      porValor('latido de los crons', leerLatidos),
      // Desde cuándo corre el SHA vigente (lo escribe `releases`; aquí SOLO se
      // lee). Es el corte que separa herida de cadáver: sin él, este agente
      // volvió a acusar como «Urgente» 12 fallos ya arreglados (28-ago-2026).
      porValor('despliegue vigente (despliegue_visto)', async () => (sha ? leerDespliegueVisto(sha) : null)),
    ]);
    const corte: CorteDespliegue | null = sha && despliegue.valor
      ? { sha, primeraVista: despliegue.valor.primeraVista }
      : null;
    const hallazgos = evaluarPruebas(
      lote.corridas, lote.truncado, catalogo, latidos, Date.now(),
      { desde, hasta: masDias(lunes, -1) }, corte,
    );
    const agentesVistos = new Set(lote.corridas.map((c) => c.agente)).size;
    const cuerpo = armarPartePruebas(
      hallazgos, lote.corridas.length, agentesVistos, desde, masDias(lunes, -1), sha,
      lineaFuentesCiegas([catalogo, latidos, despliegue]), corte,
    );
    await alertarRojos(agente, hallazgos);
    const res = await encolarParte(agente, 'parte_pruebas', titulo, cuerpo, {
      ventana: { desde, hasta: lunes },
      corte: corte ? { sha: corte.sha, primera_vista: corte.primeraVista } : null,
      corridas: lote.corridas.length, truncado: lote.truncado, sha: sha ?? null,
      hallazgos: hallazgos.map((h) => ({ semaforo: h.semaforo, codigo: h.codigo, objeto: h.objeto })),
      consultas: ['agente_corrida (ventana)', 'agente_definicion', 'cron_latido', 'despliegue_visto (el corte)'],
    });
    await anotar(agente, inicio, 'ok', disparo,
      { parte: res, hallazgos: hallazgos.length, corridas: lote.corridas.length },
      { tareasHechas: 1, tareasTotal: 1 });
    return {
      resultado: 'corrio', piezas: res === 'encolada' ? 1 : 0, costoUsd: 0,
      ...(res === 'ya_existia' ? { motivo: 'otra corrida ganó el periodo' } : {}),
    };
  } catch (e) {
    await anotar(agente, inicio, 'fallo', disparo, { titulo }, {
      tareasHechas: 0, tareasTotal: 1,
      error: `No se pudo armar el parte de pruebas: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500),
    });
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 6 · AUDITOR DE CÓDIGO — el ARTEFACTO DESPLEGADO contra la base.
//
// El blueprint (0125) lo describe leyendo fuentes y registrando hallazgos, con
// el motor viviendo en la Mac (`scripts/mejora-diaria/auditor.mjs`, launchd
// 05:30). ESE MOTOR SIGUE SIENDO EL QUE AUDITA CÓDIGO y este agente no lo
// reemplaza: lo dice en cada parte.
//
// Lo que este servidor SÍ puede auditar, y que la rutina local NO puede, es
// justo lo contrario: el artefacto que está EJECUTÁNDOSE contra la base que
// está EN PRODUCCIÓN. El repo en la Mac no sabe qué está desplegado; esta
// función sí, porque ella misma es lo desplegado. De ahí salen las tres formas
// del «mergeado no es desplegado» que ya mordieron aquí.
// ═══════════════════════════════════════════════════════════════════════════

/** Los ids que el CHECK del interruptor admite, extraídos de su definición.
 *  Se parsea el texto porque es lo que la base devuelve; si el CHECK cambia de
 *  forma, el resultado es una lista vacía y el llamador lo trata como «no se
 *  pudo leer», nunca como «no admite ninguno». */
export function palancasDelCheck(definicion: string | null): string[] | null {
  if (!definicion) return null;
  const encontrados = definicion.match(/'([^']+)'/g);
  if (!encontrados || encontrados.length === 0) return null;
  return [...new Set(encontrados.map((s) => s.slice(1, -1)))].sort();
}

export function evaluarAuditorCodigo(
  catalogo: FichaAgente[],
  despachables: readonly string[] | null,
  palancasBase: string[] | null,
): Hallazgo[] {
  const hallazgos: Hallazgo[] = [];
  const vivos = autonomos(catalogo);

  // C1 — la base los declara vivos y este bundle no sabe despacharlos. El
  // runner los salta con «sin motor despachable» en cada vuelta: vivos en el
  // catálogo, muertos en la práctica.
  if (despachables === null) {
    hallazgos.push({
      semaforo: 'NOTA', codigo: 'C0', objeto: 'runner.AGENTES_DESPACHABLES',
      detalle: 'no se pudo leer la lista de ramas de despacho del bundle.',
      evidencia: 'sin ella no se puede comparar el artefacto contra el catálogo. NO se afirma que estén todos cableados.',
    });
  } else {
    const sinMotor = vivos.filter((f) => !despachables.includes(f.id)).map((f) => f.id);
    if (sinMotor.length > 0) {
      hallazgos.push({
        semaforo: 'ROJO', codigo: 'C1', objeto: muestra(sinMotor, 10),
        detalle: `${numero(sinMotor.length)} agente(s) vivos y habilitados que ESTE BUNDLE no sabe despachar.`,
        evidencia: `el runner desplegado despacha ${numero(despachables.length)} ids y estos no están entre ellos: cada vuelta los salta con «sin motor despachable en el runner todavía». La base dice vivo; el código desplegado dice que no existe. Casi siempre significa que la migración se aplicó y el deploy del código no.`,
      });
    }
    const sinCatalogo = despachables.filter((id) => !catalogo.some((f) => f.id === id));
    if (sinCatalogo.length > 0) {
      hallazgos.push({
        semaforo: 'AMBAR', codigo: 'C2', objeto: muestra(sinCatalogo, 10),
        detalle: `${numero(sinCatalogo.length)} rama(s) de despacho del bundle apuntan a ids que NO existen en agente_definicion.`,
        evidencia: 'código que nunca se va a ejecutar: el runner consulta el catálogo y esos ids no salen. O se renombró el agente en la base sin tocar el runner, o la rama quedó de una ola anterior.',
      });
    }
    const dormidos = despachables.filter((id) => {
      const f = catalogo.find((x) => x.id === id);
      return f !== undefined && !(f.estado === 'vivo' && f.runnerHabilitado && f.disparador === 'cron');
    });
    if (dormidos.length > 0) {
      hallazgos.push({
        semaforo: 'NOTA', codigo: 'C2', objeto: muestra(dormidos, 10),
        detalle: `${numero(dormidos.length)} agente(s) con rama en el bundle y APAGADOS en la base.`,
        evidencia: 'no es un hallazgo por sí solo —apagar un agente en la base sin deploy es exactamente para lo que sirve el catálogo— pero se lista para que un apagado de emergencia que nadie volvió a encender se vea.',
      });
    }
  }

  // C3 — el drift de palancas. La lista del CÓDIGO y el dominio del CHECK
  // tienen que decir lo mismo: el runner exige que el interruptor esté en la
  // lista del bundle (candado 1) y la base rebota lo que no esté en el CHECK.
  if (palancasBase === null) {
    // NOTA y no ROJO (28-ago-2026, el mismo criterio que C0): no poder LEER el
    // CHECK no es un drift verificado — es una fuente ciega, y una fuente
    // ciega se declara, no se grita. El drift real (abajo) sí escala, porque
    // ese está comparado contra el texto que la base devolvió.
    hallazgos.push({
      semaforo: 'NOTA', codigo: 'C3', objeto: 'interruptor_id_dominio',
      detalle: 'no se pudo leer el dominio del CHECK del interruptor desde la base.',
      evidencia: 'sin él no hay contra qué comparar la lista INTERRUPTORES del bundle. NO se afirma que haya drift ni que no lo haya — no se pudo mirar (fail-closed y dicho); si la lectura sigue ciega la próxima semana, eso sí es una avería de la función contrato_de_esquema().',
    });
  } else {
    const enCodigo = new Set<string>(INTERRUPTORES as readonly string[]);
    const enBase = new Set(palancasBase);
    const soloCodigo = [...enCodigo].filter((x) => !enBase.has(x)).sort();
    const soloBase = [...enBase].filter((x) => x.startsWith('agente:') || x === 'global').filter((x) => !enCodigo.has(x)).sort();
    if (soloCodigo.length > 0) {
      hallazgos.push({
        semaforo: 'ROJO', codigo: 'C3', objeto: muestra(soloCodigo),
        detalle: `${numero(soloCodigo.length)} palanca(s) declaradas en el código que la base NO admite.`,
        evidencia: 'el panel de Observabilidad y el ⌘K las enseñan como apagables, y el día que alguien las use el INSERT rebota con check_violation. Apagar un agente durante un incidente es el peor momento para descubrirlo (es el incidente que la 0227 corrigió).',
      });
    }
    if (soloBase.length > 0) {
      hallazgos.push({
        semaforo: 'AMBAR', codigo: 'C4', objeto: muestra(soloBase),
        detalle: `${numero(soloBase.length)} palanca(s) que la base admite y el bundle desplegado NO conoce.`,
        evidencia: 'el runner exige que el interruptor esté en su propia lista (candado 1): un agente cuya palanca solo exista en la base se salta en cada vuelta con «sin kill switch declarado». La base va adelante del código desplegado.',
      });
    }
  }

  // C5 — el agente vivo sin palanca en el bundle: candado 1 lo salta siempre.
  const enCodigo = new Set<string>(INTERRUPTORES as readonly string[]);
  const sinPalanca = vivos.filter((f) => !enCodigo.has(`agente:${f.id}`)).map((f) => f.id);
  if (sinPalanca.length > 0) {
    hallazgos.push({
      semaforo: 'ROJO', codigo: 'C5', objeto: muestra(sinPalanca, 10),
      detalle: `${numero(sinPalanca.length)} agente(s) vivos y habilitados SIN kill switch en la lista del bundle.`,
      evidencia: 'candado 1 del runner: «un autónomo inapagable no corre». Estos agentes están vivos en el catálogo y el runner los salta en TODAS las vueltas — parecen encendidos y no producen nada.',
    });
  }

  return hallazgos;
}

export function armarParteAuditor(
  hallazgos: Hallazgo[], catalogo: FichaAgente[], despachables: readonly string[] | null,
  sha: string | null, lunes: string, ciegas: string | null,
): string {
  const vivos = autonomos(catalogo);
  const lineas = [
    `AUDITOR DE CÓDIGO — semana del ${lunes}`,
    '',
    `Artefacto auditado: ${sha ? `commit ${sha.slice(0, 7)}` : 'SIN SHA DECLARADO'} · entorno ${entornoDesplegado()}.`,
    `Contra la base: ${numero(catalogo.length)} agente(s) en el catálogo, ${numero(vivos.length)} vivos y habilitados por reloj. El bundle despacha ${despachables ? numero(despachables.length) : 'no consta'} id(s) y declara ${numero(INTERRUPTORES.length)} palanca(s).`,
    '',
  ];
  if (ciegas) { lineas.push(ciegas, ''); }
  lineas.push(...pintarHallazgos(hallazgos, 'Nada disparó umbral: el bundle desplegado sabe despachar a todos los agentes que la base declara vivos, y su lista de palancas coincide con el dominio del CHECK.'));
  lineas.push('');
  lineas.push('QUÉ AUDITÓ ESTE AGENTE, EXACTAMENTE: el ARTEFACTO DESPLEGADO contra la BASE EN PRODUCCIÓN. No leyó una sola línea de código fuente y no puede — desde una función serverless no hay repo, no hay git y no hay linter. Lo que sí puede, y la Mac NO, es preguntarle a la cosa que está corriendo qué sabe hacer, y compararlo con lo que la base dice que debería estar haciendo.');
  lineas.push('LA AUDITORÍA DE CÓDIGO SIGUE VIVIENDO EN LA RUTINA LOCAL: scripts/mejora-diaria/auditor.mjs (launchd 05:30) para los hallazgos de fuente, `npm run audit:dev` para dependencias, `npm run lint:ratchet` para el trinquete y la revisión del PR para lo que ninguna máquina caza. Este parte NO los reemplaza y no los da por hechos.');
  lineas.push(PIE_ALCANCE);
  lineas.push('Fuentes: agente_definicion · contrato_de_esquema() (el texto del CHECK) · la lista AGENTES_DESPACHABLES y la constante INTERRUPTORES del propio bundle en ejecución.');
  return lineas.join('\n');
}

/** La lista de ramas del runner DESPLEGADO. Import dinámico a propósito: el
 *  runner importa este módulo (por la vía de `ingenieria.ts`), y un import
 *  estático cerraría el ciclo. Además, cuando este agente corre, `runner.ts` ya
 *  está en memoria: leerlo no cuesta nada. */
async function despachablesDelBundle(): Promise<readonly string[]> {
  const mod = (await import('./runner')) as unknown as ModuloRunner;
  const lista = mod.AGENTES_DESPACHABLES;
  if (!Array.isArray(lista) || lista.length === 0) {
    throw new Error('el runner desplegado no expuso AGENTES_DESPACHABLES: no se afirma qué sabe despachar.');
  }
  return lista;
}

async function correrAuditorCodigo(disparo: DisparoCorrida, hoy: string): Promise<ResultadoIngenieria> {
  const inicio = new Date();
  const agente = 'auditor_codigo';
  const lunes = lunesDe(hoy);
  const titulo = `Auditoría del artefacto — semana del ${lunes}`;
  try {
    if (await parteExistente(agente, titulo)) {
      await anotar(agente, inicio, 'ok', disparo, { parte: 'ya_existia', titulo });
      return { resultado: 'saltado', piezas: 0, costoUsd: 0, motivo: 'el parte de esta semana ya está en la bandeja' };
    }
    const catalogo = await leerCatalogo();
    const [despachables, contrato] = await Promise.all([
      porValor('ramas de despacho del bundle', despachablesDelBundle),
      porValor('contrato de esquema', async () => {
        const { leerContrato } = await import('./ingenieria');
        return leerContrato();
      }),
    ]);
    const palancas = palancasDelCheck(contrato.valor?.interruptor_check ?? null);
    const hallazgos = evaluarAuditorCodigo(catalogo, despachables.valor ?? null, palancas);
    const sha = shaDesplegado();
    const cuerpo = armarParteAuditor(hallazgos, catalogo, despachables.valor ?? null, sha, lunes,
      lineaFuentesCiegas([despachables, contrato]));
    await alertarRojos(agente, hallazgos);
    const res = await encolarParte(agente, 'parte_auditor_codigo', titulo, cuerpo, {
      semana: lunes, sha: sha ?? null,
      despachables: despachables.valor?.length ?? null,
      palancas_bundle: INTERRUPTORES.length,
      palancas_base: palancas?.length ?? null,
      hallazgos: hallazgos.map((h) => ({ semaforo: h.semaforo, codigo: h.codigo, objeto: h.objeto })),
      consultas: ['agente_definicion', 'contrato_de_esquema()', 'runner.AGENTES_DESPACHABLES'],
    });
    await anotar(agente, inicio, 'ok', disparo,
      { parte: res, hallazgos: hallazgos.length, sha: sha ?? null },
      { tareasHechas: 1, tareasTotal: 1 });
    return {
      resultado: 'corrio', piezas: res === 'encolada' ? 1 : 0, costoUsd: 0,
      ...(res === 'ya_existia' ? { motivo: 'otra corrida ganó el periodo' } : {}),
    };
  } catch (e) {
    await anotar(agente, inicio, 'fallo', disparo, { titulo }, {
      tareasHechas: 0, tareasTotal: 1,
      error: `No se pudo armar la auditoría del artefacto: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500),
    });
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 7 · PRODUCTO — señal real → backlog priorizado. PROPONE, NO DECIDE.
//
// Traduce en puntos de backlog lo que ya existe y nadie está agregando: lo que
// un humano RECHAZÓ (la única señal de calidad que no sale del propio agente),
// las incidencias abiertas por tipo, los agentes que nadie usa y la bandeja
// que se acumula. Cada punto lleva su evidencia; ninguno lleva una decisión.
// ═══════════════════════════════════════════════════════════════════════════

export interface PiezaResuelta { agente: string; estado: string; titulo: string; motivo: string | null }
export interface PendienteBandeja { tipo: string; agente: string; creado: string }
export interface IncidenciaAbierta { tipo: string; prioridad: string }

export async function leerResueltas(desdeIso: string): Promise<PiezaResuelta[]> {
  const admin = supabaseAdmin();
  // CAP-2 (re-auditoría 25, MEDIO): `.limit(2000)` recortaba en silencio a los
  // 1,000 que PostgREST entrega por default — `traerTodo` pagina y LANZA en
  // vez de devolver un backlog truncado.
  const data = await traerTodo<Record<string, unknown>>(
    (d, h) => acotada(admin.from('cola_aprobacion')
      .select('agente, estado, titulo, motivo_rechazo')
      .neq('estado', 'pendiente')
      .gte('resuelto_en', desdeIso)
      .order('id')
      .range(d, h), 'ingenieria.producto_resueltas'),
    'ingenieria.producto_resueltas',
  );
  return data.map((f) => ({
    agente: String(f.agente), estado: String(f.estado), titulo: String(f.titulo ?? ''),
    motivo: (f.motivo_rechazo as string | null) ?? null,
  }));
}

export async function leerPendientes(): Promise<PendienteBandeja[]> {
  const admin = supabaseAdmin();
  const data = await traerTodo<Record<string, unknown>>(
    (d, h) => acotada(admin.from('cola_aprobacion')
      .select('tipo, agente, creado_en')
      .eq('estado', 'pendiente')
      .order('creado_en', { ascending: true })
      .order('id', { ascending: true })
      .range(d, h), 'ingenieria.producto_pendientes'),
    'ingenieria.producto_pendientes',
  );
  return data.map((f) => ({
    tipo: String(f.tipo), agente: String(f.agente), creado: String(f.creado_en),
  }));
}

/** Incidencias abiertas, AGREGADAS por tipo. Cross-tenant a propósito (mide al
 *  producto, no a una flota) y sin un solo dato de nadie: tipo y prioridad. */
export async function leerIncidencias(): Promise<IncidenciaAbierta[]> {
  const admin = supabaseAdmin();
  // CAP-2 (re-auditoría 25, MEDIO): `.limit(2000)` recortaba en silencio a los
  // 1,000 que PostgREST entrega por default.
  const data = await traerTodo<Record<string, unknown>>(
    (d, h) => acotada(admin.from('incidencia')
      .select('tipo, prioridad')
      .eq('estado', 'abierta')
      .order('id')
      .range(d, h), 'ingenieria.producto_incidencias'),
    'ingenieria.producto_incidencias',
  );
  return data.map((f) => ({
    tipo: String(f.tipo), prioridad: String(f.prioridad),
  }));
}

/** Rechazos mínimos por agente para que valga un punto de backlog: un rechazo
 *  suelto puede ser el criterio de un día. */
export const MIN_RECHAZOS_BACKLOG = 2;
/** Días que una pieza pendiente lleva sin que nadie la toque para ser señal. */
export const DIAS_BANDEJA_ATORADA = 7;

export function evaluarProducto(
  resueltas: Lectura<PiezaResuelta[]>,
  pendientes: Lectura<PendienteBandeja[]>,
  incidencias: Lectura<IncidenciaAbierta[]>,
  catalogo: Lectura<FichaAgente[]>,
  agentesConCorrida: Set<string> | null,
  ahoraMs: number,
): Hallazgo[] {
  const hallazgos: Hallazgo[] = [];

  // P1 — lo que un humano rechazó. Es la señal más cara de conseguir y la que
  // más directo apunta a lo que hay que cambiar.
  if (resueltas.valor) {
    const porAgente = new Map<string, PiezaResuelta[]>();
    for (const p of resueltas.valor) {
      const l = porAgente.get(p.agente) ?? [];
      l.push(p);
      porAgente.set(p.agente, l);
    }
    for (const agente of [...porAgente.keys()].sort()) {
      const lista = porAgente.get(agente) as PiezaResuelta[];
      const rechazadas = lista.filter((p) => p.estado === 'rechazado');
      if (rechazadas.length < MIN_RECHAZOS_BACKLOG) continue;
      // ÁMBAR como techo (28-ago-2026): este agente PROPONE, y una propuesta
      // no es urgente por definición. Un ROJO aquí mandaba correo «Urgente»
      // por una señal que es backlog — revisar un criterio se decide el lunes
      // en la bandeja, no a medianoche en el teléfono.
      hallazgos.push({
        semaforo: 'AMBAR',
        codigo: 'P1', objeto: agente,
        detalle: `${numero(rechazadas.length)} de ${numero(lista.length)} pieza(s) resueltas fueron RECHAZADAS por un humano.`,
        evidencia: `${muestra(rechazadas.slice(0, 3).map((p) => `«${recortar(p.titulo, 50)}»: ${recortar(p.motivo, 100) || 'sin motivo anotado'}`), 3)}. PROPUESTA: revisar el criterio de este agente antes de subirle el volumen; lo que produce se está tirando.`,
      });
    }
  }

  // P2 — la bandeja atorada. Un humano que no aprueba es señal de parar, no de
  // insistir (es el candado 4 del runner escrito como punto de backlog).
  if (pendientes.valor) {
    const viejas = pendientes.valor.filter((p) => {
      const t = Date.parse(p.creado);
      return !Number.isNaN(t) && ahoraMs - t > DIAS_BANDEJA_ATORADA * 86_400_000;
    });
    if (viejas.length > 0) {
      const porTipo = new Map<string, number>();
      for (const p of viejas) porTipo.set(p.tipo, (porTipo.get(p.tipo) ?? 0) + 1);
      // Mismo techo ÁMBAR que P1 (28-ago-2026): la bandeja atorada es la señal
      // de que el humano NO está urgido — mandarla como correo urgente sería
      // exactamente el contrasentido.
      hallazgos.push({
        semaforo: 'AMBAR',
        codigo: 'P2', objeto: `${numero(viejas.length)} pieza(s) sin resolver`,
        detalle: `hay piezas pendientes de más de ${numero(DIAS_BANDEJA_ATORADA)} días en la bandeja.`,
        evidencia: `${muestra([...porTipo.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}: ${numero(n)}`), 6)}. PROPUESTA: o el tipo que más se acumula no le sirve a nadie y hay que apagarlo, o le falta la pantalla para resolverlo rápido. Las dos son decisiones de producto, no de este agente.`,
      });
    }
  }

  // P3 — el agente que nadie usa. Vivo, habilitado y sin una sola corrida, o
  // corriendo y sin una sola pieza aprobada nunca.
  if (catalogo.valor && agentesConCorrida) {
    const mudos = autonomos(catalogo.valor).filter((f) => !agentesConCorrida.has(f.id)).map((f) => f.id);
    if (mudos.length > 0) {
      hallazgos.push({
        semaforo: 'NOTA', codigo: 'P3', objeto: muestra(mudos, 10),
        detalle: `${numero(mudos.length)} agente(s) vivos sin una sola corrida en la ventana.`,
        evidencia: 'PROPUESTA: decidir explícitamente si siguen. Un agente vivo que no corre ocupa lugar en el catálogo, en el CHECK del interruptor y en la cabeza de quien lee /admin/agentes, y no produce nada. La causa técnica la dice el parte de auditor_codigo.',
      });
    }
  }

  // P4 — dónde duele el producto según las flotas. Agregado por tipo, sin un
  // solo dato de ninguna flota ni de ninguna persona.
  if (incidencias.valor && incidencias.valor.length > 0) {
    const porTipo = new Map<string, number>();
    for (const i of incidencias.valor) porTipo.set(i.tipo, (porTipo.get(i.tipo) ?? 0) + 1);
    const top = [...porTipo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const altas = incidencias.valor.filter((i) => i.prioridad === 'alta' || i.prioridad === 'critica').length;
    hallazgos.push({
      semaforo: altas > 0 ? 'AMBAR' : 'NOTA',
      codigo: 'P4', objeto: muestra(top.map(([t]) => t), 5),
      detalle: `${numero(incidencias.valor.length)} incidencia(s) abiertas en las flotas (${numero(altas)} de prioridad alta o crítica).`,
      evidencia: `por tipo: ${top.map(([t, n]) => `${t} ${numero(n)}`).join(' · ')}. Agregado y sin un solo dato de ninguna flota. PROPUESTA: el tipo que encabeza es el candidato natural del siguiente ciclo — atacarlo en el producto reduce trabajo manual en TODAS las flotas a la vez.`,
    });
  }

  return hallazgos;
}

export function armarParteProducto(hallazgos: Hallazgo[], desde: string, lunes: string, ciegas: string | null): string {
  const lineas = [
    `PRODUCTO — backlog propuesto, semana del ${lunes}`,
    '',
    `Ventana de señal: del ${desde} al ${lunes} (28 días).`,
    '',
  ];
  if (ciegas) { lineas.push(ciegas, ''); }
  lineas.push(...pintarHallazgos(hallazgos, 'Ningún punto de backlog salió de la señal de esta ventana: nadie rechazó lo suficiente como para pedir un cambio, la bandeja no se atoró, todos los agentes vivos corrieron y no hay incidencias abiertas. Un backlog vacío es una noticia, no un error.'));
  lineas.push('');
  lineas.push('CÓMO SE LEE ESTE PARTE: cada punto es una PROPUESTA con su evidencia, no una prioridad. Este agente no cierra incidencias, no apaga agentes, no reordena el roadmap y no decide qué entra al siguiente ciclo. Decide Javier.');
  lineas.push('DE DÓNDE NO SALE LA SEÑAL: no hay entrevistas, ni NPS, ni sesiones grabadas, ni analítica de producto dentro de la app (hoy sitio_evento solo cubre el sitio público). Lo que falta para poder contestar preguntas de producto con datos lo enumera el parte de datos_instrumentacion.');
  lineas.push(PIE_ALCANCE);
  lineas.push('Fuentes: cola_aprobacion (resueltas y pendientes) · incidencia (abiertas, agregadas por tipo) · agente_corrida · agente_definicion.');
  return lineas.join('\n');
}

/** Los agentes que corrieron en la ventana. LANZA si no se lee. */
async function agentesQueCorrieron(desdeIso: string): Promise<Set<string>> {
  const admin = supabaseAdmin();
  // CAP-2 (re-auditoría 25, MEDIO): `.limit(5000)` recortaba en silencio a los
  // 1,000 que PostgREST entrega por default — `traerTodo` pagina y LANZA en
  // vez de dejar «agentes mudos» falsos por corridas que no llegaron a leerse.
  const data = await traerTodo<{ id: unknown; agente: string }>(
    (d, h) => acotada(admin.from('agente_corrida')
      .select('id, agente')
      .gte('inicio', desdeIso)
      .order('id')
      .range(d, h), 'ingenieria.producto_corridas'),
    'ingenieria.producto_corridas',
  );
  return new Set(data.map((f) => f.agente));
}

async function correrProducto(disparo: DisparoCorrida, hoy: string): Promise<ResultadoIngenieria> {
  const inicio = new Date();
  const agente = 'producto';
  const lunes = lunesDe(hoy);
  const desde = masDias(lunes, -28);
  const titulo = `Producto — backlog de la semana del ${lunes}`;
  try {
    if (await parteExistente(agente, titulo)) {
      await anotar(agente, inicio, 'ok', disparo, { parte: 'ya_existia', titulo });
      return { resultado: 'saltado', piezas: 0, costoUsd: 0, motivo: 'el backlog de esta semana ya está en la bandeja' };
    }
    const desdeIso = inicioDia(desde);
    const [resueltas, pendientes, incidencias, catalogo, corrieron] = await Promise.all([
      porValor('piezas resueltas', () => leerResueltas(desdeIso)),
      porValor('bandeja pendiente', leerPendientes),
      porValor('incidencias abiertas', leerIncidencias),
      porValor('catálogo de agentes', leerCatalogo),
      porValor('agentes con corrida', () => agentesQueCorrieron(desdeIso)),
    ]);
    const hallazgos = evaluarProducto(resueltas, pendientes, incidencias, catalogo, corrieron.valor ?? null, Date.now());
    const cuerpo = armarParteProducto(hallazgos, desde, lunes,
      lineaFuentesCiegas([resueltas, pendientes, incidencias, catalogo, corrieron]));
    await alertarRojos(agente, hallazgos);
    const res = await encolarParte(agente, 'parte_producto', titulo, cuerpo, {
      ventana: { desde, hasta: lunes },
      hallazgos: hallazgos.map((h) => ({ semaforo: h.semaforo, codigo: h.codigo, objeto: h.objeto })),
      consultas: ['cola_aprobacion (resueltas)', 'cola_aprobacion (pendientes)', 'incidencia', 'agente_corrida', 'agente_definicion'],
    });
    await anotar(agente, inicio, 'ok', disparo,
      { parte: res, puntos: hallazgos.length },
      { tareasHechas: 1, tareasTotal: 1 });
    return {
      resultado: 'corrio', piezas: res === 'encolada' ? 1 : 0, costoUsd: 0,
      ...(res === 'ya_existia' ? { motivo: 'otra corrida ganó el periodo' } : {}),
    };
  } catch (e) {
    await anotar(agente, inicio, 'fallo', disparo, { titulo }, {
      tareasHechas: 0, tareasTotal: 1,
      error: `No se pudo armar el backlog de producto: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500),
    });
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 8 · DATOS E INSTRUMENTACIÓN — qué pregunta del negocio NO tiene dato hoy.
//
// Es el que destraba A7 del plan. El método es el `sinFuenteDeDatos` del panel
// de adquisición, generalizado: se declara un CATÁLOGO DE PREGUNTAS que el
// negocio necesita contestar, cada una con la FUENTE que la contestaría, y se
// verifica CONTRA LA BASE si esa fuente existe y tiene filas. Lo que no tiene
// fuente se convierte en la spec del evento mínimo que habría que instrumentar.
//
// NADA SE INVENTA: si la tabla existe pero está vacía, la pregunta NO se da por
// contestada — se dice «la fuente existe y no tiene una sola fila», que es una
// respuesta distinta y más útil que «no hay dato».
// ═══════════════════════════════════════════════════════════════════════════

export interface PreguntaDeNegocio {
  /** Código estable para seguirla entre semanas. */
  id: string;
  pregunta: string;
  /** La tabla de `public` que la contestaría. */
  fuente: string;
  /** Qué habría que emitir si la fuente no alcanza. */
  eventoPropuesto: string;
  /** Dónde se emitiría — el punto exacto del producto. */
  donde: string;
}

/**
 * EL CATÁLOGO DECLARADO. Es una declaración de intención del negocio, no una
 * medición: por eso vive en el código, revisable en un PR, y no se genera. Lo
 * que SÍ se mide es si su fuente existe y tiene filas.
 */
export const PREGUNTAS: readonly PreguntaDeNegocio[] = [
  {
    id: 'Q1',
    pregunta: '¿Cuántos visitantes del sitio público terminan siendo una flota que firma?',
    fuente: 'sitio_evento',
    eventoPropuesto: 'un evento `alta_flota` en sitio_evento con la página de origen, para poder unir el embudo público con el alta.',
    donde: 'en el alta de tenant, con la misma minimización que el resto de sitio_evento (sin IP, sin UA, sin cookies).',
  },
  {
    id: 'Q2',
    pregunta: '¿Cuánto tarda una flota nueva desde que firma hasta su primera liquidación cerrada? (activación)',
    fuente: 'viaje',
    eventoPropuesto: 'ninguno nuevo: se deriva de tenant.creado_en contra la primera liquidacion del tenant. Falta la CONSULTA, no el dato.',
    donde: 'panel de éxito del cliente; el agente onboarding_cliente ya mira parte de esto.',
  },
  {
    id: 'Q3',
    pregunta: '¿Qué pantalla del producto usa de verdad un operador, y cuál nadie abre?',
    fuente: 'producto_evento',
    eventoPropuesto: 'ninguno nuevo desde la 0251: el pulso del panel ya emite pageview por pantalla. Si la pregunta pide más grano (qué se COMPLETA, no solo qué se abre), se amplía el dominio de `accion` en la base y en el escritor, juntos — nunca se infiere de lo que no se emitió.',
    donde: 'ya se emite: PulsoProducto (layout de /dashboard) → /api/dashboard/evento, con la misma minimización que sitio_evento (solo la flota y la pantalla del catálogo; sin usuario, sin IP).',
  },
  {
    id: 'Q4',
    pregunta: '¿Las flotas que entraron el mismo mes se comportan igual? (cohortes de retención)',
    fuente: 'producto_evento',
    eventoPropuesto: 'ninguno nuevo: se deriva de producto_evento (0251) contra tenant.created_at — la RPC uso_producto_mensual() ya agrupa en la base.',
    donde: 'la matriz vive en /admin/crecimiento, con la regla de que un mes anterior al primer evento es «no medido», jamás 0. Sigue siendo cierto que cohortear por viajes mediría operación y no uso.',
  },
  {
    id: 'Q5',
    pregunta: '¿Qué le cuesta a Likida atender a cada flota? (margen por cliente)',
    fuente: 'llm_costo',
    eventoPropuesto: 'ninguno nuevo para IA. Falta el costo de INFRA por tenant, que hoy no se atribuye a nadie.',
    donde: 'el agente control_costos ya lee llm_costo; la parte de infra no tiene fuente y no se puede repartir sin inventar.',
  },
  {
    id: 'Q6',
    pregunta: '¿Cuántas piezas de agente aprueba un humano y cuántas edita antes de aprobar?',
    fuente: 'cola_aprobacion',
    eventoPropuesto: 'ninguno nuevo: cuerpo vs cuerpo_final ya permite derivar la edición (0117).',
    donde: 'falta la consulta y la pantalla, no el dato.',
  },
];

export interface EstadoFuente { tabla: string; existe: boolean; filas: number | null }

/** El estado de cada fuente según el perfil de almacenamiento. `filas` es el
 *  ESTIMADO de `reltuples`: −1 significa «nunca analizada» y se pasa como null,
 *  que es lo honesto — no es cero. */
export function estadoDeFuentes(perfil: Perfil, preguntas: readonly PreguntaDeNegocio[]): Map<string, EstadoFuente> {
  const porTabla = new Map(perfil.tablas.map((t) => [t.tabla, t]));
  const salida = new Map<string, EstadoFuente>();
  for (const p of preguntas) {
    const t = porTabla.get(p.fuente);
    salida.set(p.fuente, {
      tabla: p.fuente,
      existe: t !== undefined,
      filas: t === undefined || t.filas_estimadas < 0 ? null : Math.round(t.filas_estimadas),
    });
  }
  return salida;
}

export interface CoberturaSitio { paginas: string[]; eventos: string[]; filas: number }

/** Qué cubre HOY sitio_evento, medido y no supuesto. LANZA si no se lee. */
export async function leerCoberturaSitio(desdeIso: string): Promise<CoberturaSitio> {
  const admin = supabaseAdmin();
  // CAP-2 (re-auditoría 25, MEDIO): `.limit(5000)` recortaba en silencio a los
  // 1,000 que PostgREST entrega por default — la cuenta de `filas` que este
  // parte declara «medida y no supuesta» quedaba subestimada sin avisar.
  const filas = await traerTodo<{ pagina: string; evento: string }>(
    (d, h) => acotada(admin.from('sitio_evento')
      .select('pagina, evento')
      .gte('created_at', desdeIso)
      .order('id')
      .range(d, h), 'ingenieria.cobertura_sitio'),
    'ingenieria.cobertura_sitio',
  );
  return {
    filas: filas.length,
    paginas: [...new Set(filas.map((f) => f.pagina))].sort(),
    eventos: [...new Set(filas.map((f) => f.evento))].sort(),
  };
}

export interface CoberturaProducto { pantallas: string[]; filas: number }

/** Qué cubre HOY producto_evento (0251), medido y no supuesto. LANZA si no se
 *  lee — que la tabla no exista todavía en la base TAMBIÉN es un lanzamiento,
 *  y el parte lo dice como «no se pudo leer», no como «cero uso». */
export async function leerCoberturaProducto(desdeIso: string): Promise<CoberturaProducto> {
  const admin = supabaseAdmin();
  // CAP-2 (re-auditoría 25, MEDIO): `.limit(5000)` recortaba en silencio a los
  // 1,000 que PostgREST entrega por default.
  const filas = await traerTodo<{ pantalla: string }>(
    (d, h) => acotada(admin.from('producto_evento')
      .select('pantalla')
      .gte('created_at', desdeIso)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(d, h), 'ingenieria.cobertura_producto'),
    'ingenieria.cobertura_producto',
  );
  return {
    filas: filas.length,
    pantallas: [...new Set(filas.map((f) => f.pantalla))].sort(),
  };
}

export function evaluarInstrumentacion(
  fuentes: Map<string, EstadoFuente>,
  preguntas: readonly PreguntaDeNegocio[] = PREGUNTAS,
  /** El censo de fuentes del parte ANTERIOR de este agente (`null` = no hay).
   *  Separa el hueco CONOCIDO de la REGRESIÓN — ver el comentario de abajo. */
  previas: Map<string, EstadoFuente> | null = null,
): Hallazgo[] {
  const hallazgos: Hallazgo[] = [];
  for (const p of preguntas) {
    const f = fuentes.get(p.fuente);
    if (!f || !f.existe) {
      // ── HUECO CONOCIDO ≠ FALLO ROJO (incidente 28-ago-2026) ──────────────
      // La primera versión marcaba ROJO toda fuente inexistente, y la primera
      // noche mandó un «Urgente» por producto_evento — una tabla que NUNCA ha
      // existido, que este mismo catálogo declara como «el hueco más grande
      // del tablero», y que seguirá sin existir hasta que alguien la
      // construya. Un hueco declarado es BACKLOG: el parte lo sigue diciendo
      // entero (eso está bien y no se toca), pero escalarlo cada noche
      // entrena a ignorar el canal. ROJO queda reservado para la REGRESIÓN:
      // una fuente que el parte anterior vio EXISTIR y que ya no está — eso
      // sí es «algo se rompió», con la evidencia del censo previo.
      const existiaAntes = previas?.get(p.fuente)?.existe === true;
      hallazgos.push(existiaAntes
        ? {
          semaforo: 'ROJO', codigo: p.id, objeto: p.fuente,
          detalle: `REGRESIÓN: la fuente ${p.fuente} EXISTÍA en el censo del parte anterior y YA NO ESTÁ — «${p.pregunta}» se quedó sin dato por una rotura, no por backlog.`,
          evidencia: 'el censo previo de este agente la registró con existe=true y perfil_almacenamiento() ya no la devuelve: alguien la borró o una migración la tumbó. Esto sí es un incidente, no un hueco conocido.',
        }
        : {
          semaforo: 'AMBAR', codigo: p.id, objeto: p.fuente,
          detalle: `SIN DATO (HUECO CONOCIDO): «${p.pregunta}» no se puede contestar — la fuente ${p.fuente} NO EXISTE en la base. Es backlog de instrumentación, no un fallo: nada que existiera se rompió.`,
          evidencia: `EVENTO MÍNIMO PROPUESTO: ${p.eventoPropuesto} Dónde: ${p.donde}`,
        });
      continue;
    }
    if (f.filas === null) {
      hallazgos.push({
        semaforo: 'NOTA', codigo: p.id, objeto: p.fuente,
        detalle: `«${p.pregunta}» — la fuente existe y su volumen NO CONSTA.`,
        evidencia: 'reltuples vino −1: la tabla nunca se analizó. NO se lee como «vacía»; se lee como «no medido». Un `analyze` la pone en la vara.',
      });
      continue;
    }
    if (f.filas === 0) {
      hallazgos.push({
        semaforo: 'AMBAR', codigo: p.id, objeto: p.fuente,
        detalle: `«${p.pregunta}» — la fuente EXISTE y no tiene una sola fila.`,
        evidencia: `es una respuesta distinta de «no hay dato»: la instrumentación está puesta y nada la está alimentando. Verificar quién debería escribir en ${p.fuente} antes de proponer un evento nuevo. Propuesta si de verdad no se está emitiendo: ${p.eventoPropuesto}`,
      });
      continue;
    }
    hallazgos.push({
      semaforo: 'NOTA', codigo: p.id, objeto: p.fuente,
      detalle: `«${p.pregunta}» — CON DATO: ${numero(f.filas)} fila(s) estimadas en ${p.fuente}.`,
      evidencia: `lo que falta aquí no es el dato: ${p.eventoPropuesto}`,
    });
  }
  return hallazgos;
}

export function armarParteInstrumentacion(
  hallazgos: Hallazgo[], cobertura: Lectura<CoberturaSitio>, lunes: string, ciegas: string | null,
  coberturaProducto: Lectura<CoberturaProducto>,
): string {
  const c = cobertura.valor;
  const cp = coberturaProducto.valor;
  const lineas = [
    `DATOS E INSTRUMENTACIÓN — semana del ${lunes}`,
    '',
    `Preguntas del catálogo revisadas: ${numero(PREGUNTAS.length)}. Cada una se verificó CONTRA LA BASE, no contra una suposición.`,
    c
      ? `Lo que sitio_evento cubre HOY (últimos 28 días, ${numero(c.filas)} fila(s)): páginas ${muestra(c.paginas, 8)} · eventos ${muestra(c.eventos, 6)}. Solo el sitio PÚBLICO, y sin un solo dato del visitante (ni IP, ni UA, ni cookies — minimización LFPDPPP).`
      : 'Cobertura de sitio_evento: NO SE PUDO LEER. No se afirma qué cubre.',
    // La analítica DENTRO de la app (0251): la línea que hasta el 28-ago-2026
    // decía «no existe» hoy se MIDE — y si no se puede leer, se dice eso.
    !cp
      ? 'Cobertura de producto_evento: NO SE PUDO LEER. No se afirma qué cubre — «no se pudo leer» y «cero uso» son cosas distintas.'
      : cp.filas === 0
        ? 'producto_evento (0251) existe y NO registró uso en los últimos 28 días. Su único escritor es el pulso del panel: si el panel se está usando y esto sigue en cero, el pulso no está llegando — eso es un cable suelto, no una flota inactiva.'
        : `Lo que producto_evento cubre HOY (últimos 28 días, ${numero(cp.filas)} fila(s)): pantallas ${muestra(cp.pantallas, 8)}. Solo la FLOTA y la PANTALLA — sin usuario, sin IP (misma minimización que sitio_evento).`,
    '',
  ];
  if (ciegas) { lineas.push(ciegas, ''); }
  lineas.push(...pintarHallazgos(hallazgos, 'Todas las preguntas del catálogo tienen fuente con datos. (Si esto sale así, el catálogo se quedó corto: la siguiente tarea es ampliarlo, no celebrarlo.)'));
  lineas.push('');
  lineas.push('EL HUECO GRANDE, ACTUALIZADO (0251, 28-ago-2026): la analítica de producto dentro de la app ya tiene tabla y pulso — producto_evento registra pageview por pantalla, por flota. Lo que SIGUE sin existir, dicho con su razón: acciones de grano fino (qué se completa, no solo qué se abre) — el dominio de `accion` se amplía cuando alguien las necesite — y cualquier dimensión de USUARIO, cuya ausencia es a propósito (minimización): la pregunta que la necesite (DAU por usuario) debe declararla en vez de suponerla recolectada.');
  lineas.push('CÓMO SE CLASIFICA UN HUECO (desde el 28-ago-2026): una fuente que NUNCA ha existido es BACKLOG de instrumentación (ámbar) — el parte lo dice completo, pero no despierta a nadie. El rojo queda reservado para la REGRESIÓN: una fuente que el censo del parte anterior vio existir y que desapareció. Eso sí es «algo se rompió».');
  lineas.push('LO QUE ESTE AGENTE NO HACE: no instrumenta nada, no crea tablas y no emite eventos. Propone la spec mínima —qué evento, dónde, con qué campos— y la deja en la bandeja. Cada evento nuevo es dato personal potencial: el diseño de la tabla pasa por la misma minimización que sitio_evento y por RLS por tenant.');
  lineas.push(PIE_ALCANCE);
  lineas.push('Fuentes: perfil_almacenamiento() (existencia y volumen estimado de cada fuente) · sitio_evento (cobertura real del sitio público) · producto_evento (cobertura real del panel, 0251) · el catálogo de preguntas declarado en el código.');
  return lineas.join('\n');
}

async function correrInstrumentacion(disparo: DisparoCorrida, hoy: string): Promise<ResultadoIngenieria> {
  const inicio = new Date();
  const agente = 'datos_instrumentacion';
  const lunes = lunesDe(hoy);
  const titulo = `Datos e instrumentación — semana del ${lunes}`;
  try {
    if (await parteExistente(agente, titulo)) {
      await anotar(agente, inicio, 'ok', disparo, { parte: 'ya_existia', titulo });
      return { resultado: 'saltado', piezas: 0, costoUsd: 0, motivo: 'el parte de esta semana ya está en la bandeja' };
    }
    const perfil = await leerPerfil(1);
    const [cobertura, coberturaProducto, previo] = await Promise.all([
      porValor('cobertura de sitio_evento', () => leerCoberturaSitio(inicioDia(masDias(lunes, -28)))),
      // La analítica DENTRO de la app (0251) — el hueco que este agente
      // declaró cada noche hasta que se construyó. Ahora se mide.
      porValor('cobertura de producto_evento', () => leerCoberturaProducto(inicioDia(masDias(lunes, -28)))),
      // El censo del parte anterior: es lo que separa «hueco conocido» (ámbar,
      // backlog) de «la fuente existía y desapareció» (rojo, incidente). Sin
      // él, todo hueco se trata como conocido — el lado que no grita en falso.
      porValor('censo de fuentes del parte anterior', () => censoPrevio<EstadoFuente[]>(agente, 'parte_instrumentacion', 'fuentes')),
    ]);
    const previas = Array.isArray(previo.valor?.censo)
      ? new Map(previo.valor.censo
        .filter((f): f is EstadoFuente => !!f && typeof f === 'object' && typeof (f as EstadoFuente).tabla === 'string')
        .map((f) => [f.tabla, f]))
      : null;
    const fuentes = estadoDeFuentes(perfil, PREGUNTAS);
    const hallazgos = evaluarInstrumentacion(fuentes, PREGUNTAS, previas);
    const cuerpo = armarParteInstrumentacion(
      hallazgos, cobertura, lunes, lineaFuentesCiegas([cobertura, coberturaProducto, previo]), coberturaProducto,
    );
    await alertarRojos(agente, hallazgos);
    const res = await encolarParte(agente, 'parte_instrumentacion', titulo, cuerpo, {
      semana: lunes,
      fuentes: [...fuentes.values()],
      hallazgos: hallazgos.map((h) => ({ semaforo: h.semaforo, codigo: h.codigo, objeto: h.objeto })),
      consultas: ['perfil_almacenamiento()', 'sitio_evento', 'producto_evento'],
    });
    await anotar(agente, inicio, 'ok', disparo,
      // `sin_fuente` cuenta HUECOS (fuente inexistente), no rojos: desde el
      // 28-ago-2026 el rojo está reservado a la regresión.
      { parte: res, preguntas: PREGUNTAS.length, sin_fuente: [...fuentes.values()].filter((f) => !f.existe).length },
      { tareasHechas: 1, tareasTotal: 1 });
    return {
      resultado: 'corrio', piezas: res === 'encolada' ? 1 : 0, costoUsd: 0,
      ...(res === 'ya_existia' ? { motivo: 'otra corrida ganó el periodo' } : {}),
    };
  } catch (e) {
    await anotar(agente, inicio, 'fallo', disparo, { titulo }, {
      tareasHechas: 0, tareasTotal: 1,
      error: `No se pudo armar el parte de instrumentación: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500),
    });
    throw e;
  }
}

// ── El despacho que `ingenieria.ts` llama ──────────────────────────────────

export async function correrAgenteIngenieriaProducto(
  id: AgenteIngenieria,
  disparo: DisparoCorrida,
  hoy: string,
): Promise<ResultadoIngenieria> {
  logger.info('ingenieria_producto.corrida', { agente: id, disparo });
  switch (id) {
    case 'pruebas': return correrPruebas(disparo, hoy);
    case 'auditor_codigo': return correrAuditorCodigo(disparo, hoy);
    case 'producto': return correrProducto(disparo, hoy);
    case 'datos_instrumentacion': return correrInstrumentacion(disparo, hoy);
    default:
      // Los cuatro de `ingenieria.ts` no llegan aquí: el switch de allá los
      // atiende antes. Si algún día llega uno, se dice — no se finge una
      // corrida vacía.
      throw new Error(`correrAgenteIngenieriaProducto: ${id} no vive en este módulo — su rama está en ingenieria.ts.`);
  }
}
