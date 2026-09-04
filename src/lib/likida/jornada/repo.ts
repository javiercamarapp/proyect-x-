import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { hoyMx } from '@/lib/formato';
import { acotada } from '../presupuesto';
import { traerTodo, conteo } from '../pg';
import { violaIndice, UNIQUE_VIOLATION } from '../pg_errores';
import type { Asiento, Procedencia, TipoAsiento } from './modelo';
import type { PoliticaFlota } from './riesgo';

// ═══════════════════════════════════════════════════════════════════════════
// EL ÚNICO ESCRITOR DEL REGISTRO DE JORNADA (mig. 0241).
//
// Todo lo que toca `jornada_dia`, `jornada_asiento` y `jornada_politica` pasa
// por aquí. No es purismo: `momento` NUNCA se actualiza —corregir es anular e
// insertar— y esa garantía solo se puede sostener si hay un lugar donde
// mirarla. Un `update` suelto en otro archivo la rompería sin que nada avisara.
//
// LOS ERRORES DE supabase-js VIENEN POR VALOR. Cada consulta revisa `error`
// explícitamente: sin eso, una base caída se lee como «este día no tiene
// marcas», y el producto imprimiría «sin registro declarado» sobre un día que
// sí tenía registro. En esta feature esa confusión no es un bug de UI — es
// un documento laboral que dice algo falso.
// ═══════════════════════════════════════════════════════════════════════════

/** El día de México de un instante. La jornada se agrupa por el día del
 *  CHOFER, no por el UTC del servidor (misma lección de la 0193 y la 0205). */
export function diaMxDe(momento: Date): string {
  return hoyMx(momento);
}

export interface FilaJornadaDia {
  id: string;
  operadorId: string;
  dia: string;
  estado: 'abierto' | 'cerrado';
  cerradoEn: string | null;
  cerradoPorEmail: string | null;
  conformeOperadorEn: string | null;
  conformeWaMessageId: string | null;
  asientos: Asiento[];
}

type FilaAsientoDb = {
  id: string;
  tipo: string;
  momento: string;
  procedencia: string;
  origen_ref: string | null;
  wa_message_id: string | null;
  viaje_id: string | null;
  registrado_por_email: string | null;
  nota: string | null;
  corrige_a: string | null;
  anulado_en: string | null;
  anulado_por_email: string | null;
  anulado_motivo: string | null;
};

const CAMPOS_ASIENTO =
  'id, tipo, momento, procedencia, origen_ref, wa_message_id, viaje_id, ' +
  'registrado_por_email, nota, corrige_a, anulado_en, anulado_por_email, anulado_motivo';

function aAsiento(f: FilaAsientoDb): Asiento {
  return {
    id: f.id,
    tipo: f.tipo as TipoAsiento,
    momento: f.momento,
    procedencia: f.procedencia as Procedencia,
    origenRef: f.origen_ref,
    waMessageId: f.wa_message_id,
    viajeId: f.viaje_id,
    registradoPorEmail: f.registrado_por_email,
    nota: f.nota,
    corrigeA: f.corrige_a,
    anuladoEn: f.anulado_en,
    anuladoPorEmail: f.anulado_por_email,
    anuladoMotivo: f.anulado_motivo,
  };
}

/**
 * Se lanza cuando la base no pudo contestar. NO se convierte en «no hay
 * marcas»: la pantalla la atrapa y dice que no pudo leer, que es distinto de
 * decir que el operador no reportó.
 */
export class JornadaIlegible extends Error {
  constructor(detalle: string) {
    super(`No se pudo leer el registro de jornada: ${detalle}`);
    this.name = 'JornadaIlegible';
  }
}

/**
 * Abre (o encuentra) el expediente del día. Idempotente POR RESTRICCIÓN, no
 * por un `if`: el índice único `jornada_dia_unica` arbitra la carrera entre dos
 * corridas solapadas, y el perdedor relee la fila del ganador en vez de crear
 * un segundo expediente con la mitad de las marcas.
 */
export async function asegurarDiaJornada(
  tenantId: string,
  operadorId: string,
  dia: string,
): Promise<{ id: string } | { error: string }> {
  const admin = supabaseAdmin();

  const insertado = await acotada(
    admin.from('jornada_dia').insert({ tenant_id: tenantId, operador_id: operadorId, dia }).select('id').maybeSingle(),
    'jornada.dia.insert',
  );
  if (!insertado.error && insertado.data) return { id: String(insertado.data.id) };

  if (insertado.error && !violaIndice(insertado.error, 'jornada_dia_unica')) {
    logger.error('jornada.dia_no_abierto', { tenant: tenantId, operador: operadorId, dia, err: insertado.error.message });
    return { error: insertado.error.message };
  }

  // Perdió la carrera (o ya existía): se relee. Anclado al tenant SIEMPRE.
  const leido = await acotada(
    admin.from('jornada_dia').select('id')
      .eq('tenant_id', tenantId).eq('operador_id', operadorId).eq('dia', dia).maybeSingle(),
    'jornada.dia.select',
  );
  if (leido.error) {
    logger.error('jornada.dia_no_releido', { tenant: tenantId, operador: operadorId, dia, err: leido.error.message });
    return { error: leido.error.message };
  }
  if (!leido.data) return { error: 'el expediente del día no existe tras el conflicto de inserción' };
  return { id: String(leido.data.id) };
}

/** El id del expediente de un día, o `null` si no existe. Anclado al tenant. */
export async function idDeJornada(tenantId: string, operadorId: string, dia: string): Promise<string | null> {
  const { data, error } = await acotada(
    supabaseAdmin().from('jornada_dia').select('id')
      .eq('tenant_id', tenantId).eq('operador_id', operadorId).eq('dia', dia).maybeSingle(),
    'jornada.dia.id',
  );
  if (error) {
    logger.error('jornada.dia_id_ilegible', { tenant: tenantId, operador: operadorId, dia, err: error.message });
    return null;
  }
  return data ? String(data.id) : null;
}

/** Cuántas horas puede quedar abierta una jornada antes de que una marca de
 *  madrugada deje de poder atribuírsele. Más de 24 h no es una jornada larga:
 *  es una marca del día equivocado, y colgársela sería inventar la atribución. */
const MAX_HORAS_JORNADA_ABIERTA = 24;

/**
 * El expediente de AYER que esta marca podría estar cerrando.
 *
 * Devuelve la jornada del día anterior SOLO si tiene un `inicio_jornada` vivo,
 * NO tiene un `fin_jornada` vivo, y el `momento` cae a menos de 24 h de ese
 * inicio. Con cualquiera de las tres condiciones sin cumplir devuelve `null` y
 * la marca se queda en el día de su propio mensaje: la atribución al día
 * anterior es una decisión, y una decisión sin las tres pruebas es una
 * suposición.
 *
 * `error` distinto de null significa que la base no contestó — el llamador NO
 * lo trata como «no hay jornada anterior».
 */
export async function jornadaQueCierra(
  tenantId: string,
  operadorId: string,
  diaDelMensaje: string,
  momento: Date,
): Promise<{ jornada: { id: string; dia: string } | null; error: string | null }> {
  const ayer = diaAnterior(diaDelMensaje);
  if (ayer === null) return { jornada: null, error: null };

  // DOS CONSULTAS, NO UN EMBED de PostgREST. Las FK de la 0241 son COMPUESTAS
  // (id, tenant_id) y el embebido de PostgREST sobre una compuesta depende de
  // que resuelva la relación por nombre de constraint — una dependencia que no
  // se puede probar contra el Postgres pelón del CI, solo contra un proyecto
  // real. Dos consultas explícitas se prueban las dos y se anclan al tenant las
  // dos.
  const { data, error } = await acotada(
    supabaseAdmin().from('jornada_dia').select('id, dia')
      .eq('tenant_id', tenantId).eq('operador_id', operadorId).eq('dia', ayer).maybeSingle(),
    'jornada.dia.anterior',
  );
  if (error) return { jornada: null, error: error.message };
  if (!data) return { jornada: null, error: null };
  const fila = data as { id: string; dia: string };

  const marcas = await acotada(
    supabaseAdmin().from('jornada_asiento').select('tipo, momento')
      .eq('tenant_id', tenantId).eq('jornada_id', fila.id)
      .in('tipo', ['inicio_jornada', 'fin_jornada'])
      .is('anulado_en', null),
    'jornada.dia.anterior.marcas',
  );
  if (marcas.error) return { jornada: null, error: marcas.error.message };

  const vivos = (marcas.data ?? []) as Array<{ tipo: string; momento: string }>;
  const inicio = vivos.find((a) => a.tipo === 'inicio_jornada');
  const yaCerrada = vivos.some((a) => a.tipo === 'fin_jornada');
  if (!inicio || yaCerrada) return { jornada: null, error: null };

  const horas = (momento.getTime() - Date.parse(inicio.momento)) / 3_600_000;
  if (!Number.isFinite(horas) || horas < 0 || horas > MAX_HORAS_JORNADA_ABIERTA) {
    return { jornada: null, error: null };
  }
  return { jornada: { id: String(fila.id), dia: String(fila.dia) }, error: null };
}

/** El día natural anterior a un AAAA-MM-DD, o `null` si no es una fecha. */
export function diaAnterior(dia: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return null;
  const ms = Date.parse(`${dia}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - 86_400_000).toISOString().slice(0, 10);
}

export type ResultadoAsiento = 'asentado' | 'ya_estaba' | 'fallo';

export interface MarcaNueva {
  jornadaId: string;
  tenantId: string;
  tipo: TipoAsiento;
  momento: Date;
  procedencia: Procedencia;
  origenRef?: string | null;
  waMessageId?: string | null;
  viajeId?: string | null;
  unidadId?: string | null;
  detalle?: Record<string, unknown> | null;
  registradoPor?: string | null;
  registradoPorEmail?: string | null;
  nota?: string | null;
  corrigeA?: string | null;
}

/**
 * Asienta una marca.
 *
 * `ya_estaba` NO es un fallo: es el resultado esperado ante un mensaje
 * reentregado, el mismo extremo ya observado o una marca humana que prevalece.
 * Para extremos derivados, la RPC 0319 combina el lock del expediente con
 * `jornada_asiento_marca_unica`; las demás marcas conservan los candados 0241.
 */
export async function asentarMarca(m: MarcaNueva): Promise<ResultadoAsiento> {
  // Los extremos automáticos son revisables: una posición posterior o una
  // segunda unidad puede ampliar la cota del día. La RPC 0319 hace la
  // sustitución append-only (anula + inserta con `corrige_a`) bajo el lock del
  // expediente y rehúsa tocar cualquier declaración/captura humana.
  if ((m.procedencia === 'hito_viaje' || m.procedencia === 'gps')
      && (m.tipo === 'inicio_jornada' || m.tipo === 'fin_jornada')) {
    const { data, error } = await acotada(
      supabaseAdmin().rpc('asentar_extremo_jornada_derivado', {
        p_jornada_id: m.jornadaId,
        p_tenant_id: m.tenantId,
        p_tipo: m.tipo,
        p_momento: m.momento.toISOString(),
        p_procedencia: m.procedencia,
        p_origen_ref: m.origenRef ?? null,
        p_viaje_id: m.viajeId ?? null,
        p_unidad_id: m.unidadId ?? null,
        p_detalle: m.detalle ?? null,
      }),
      'jornada.asiento.extremo_derivado',
    );
    const resultado = Array.isArray(data) ? data[0] : data;
    if (!error && (resultado === 'asentado' || resultado === 'actualizado')) return 'asentado';
    if (!error && resultado === 'ya_estaba') return 'ya_estaba';
    logger.error('jornada.asiento_no_escrito', {
      jornada: m.jornadaId, tipo: m.tipo, procedencia: m.procedencia,
      err: error?.message ?? `resultado inesperado: ${String(resultado)}`,
    });
    return 'fallo';
  }

  const { data, error } = await acotada(
    supabaseAdmin().from('jornada_asiento').insert({
      tenant_id: m.tenantId,
      jornada_id: m.jornadaId,
      tipo: m.tipo,
      momento: m.momento.toISOString(),
      procedencia: m.procedencia,
      origen_ref: m.origenRef ?? null,
      wa_message_id: m.waMessageId ?? null,
      viaje_id: m.viajeId ?? null,
      unidad_id: m.unidadId ?? null,
      detalle: m.detalle ?? null,
      registrado_por: m.registradoPor ?? null,
      registrado_por_email: m.registradoPorEmail ?? null,
      nota: m.nota ?? null,
      corrige_a: m.corrigeA ?? null,
    }).select('id').maybeSingle(),
    'jornada.asiento.insert',
  );

  if (!error && data) return 'asentado';
  if (error && (error as { code?: string }).code === UNIQUE_VIOLATION) return 'ya_estaba';
  logger.error('jornada.asiento_no_escrito', {
    jornada: m.jornadaId, tipo: m.tipo, procedencia: m.procedencia,
    err: error?.message ?? 'insert sin fila ni error',
  });
  return 'fallo';
}

/** Tope de expedientes que una lectura de panel o de reporte trae de una vez.
 *  PostgREST recorta a 1,000 en SILENCIO (la trampa que `traerTodo` documenta
 *  en analytics.ts): pedir menos del tope y comprobar el borde es lo que
 *  permite DECIR que la ventana no cupo en vez de enseñar media lista. */
export const TOPE_EXPEDIENTES = 900;

export interface LecturaJornadas {
  dias: FilaJornadaDia[];
  /** `true` si la ventana tocó el tope: lo que se enseña está INCOMPLETO y hay
   *  que decirlo. Media lista se ve igual que la lista entera, solo más corta. */
  truncada: boolean;
}

/**
 * Lee los expedientes de una ventana, con sus asientos. Lanza `JornadaIlegible`
 * si la base no contesta — quedarse callado aquí produciría un documento que
 * afirma «sin registro declarado» sobre días que sí lo tienen, y ese documento
 * se enseña en un juicio.
 *
 * DOS CONSULTAS EN VEZ DE UN EMBED, por la razón que explica `jornadaQueCierra`:
 * las FK de la 0241 son compuestas y el embebido de PostgREST sobre una
 * compuesta no se puede probar contra el Postgres del CI.
 */
export async function leerJornadas(
  tenantId: string,
  desde: string,
  hasta: string,
  operadorId?: string | null,
): Promise<LecturaJornadas> {
  const admin = supabaseAdmin();
  let q = admin.from('jornada_dia')
    .select('id, operador_id, dia, estado, cerrado_en, cerrado_por_email, conforme_operador_en, conforme_wa_message_id')
    .eq('tenant_id', tenantId)
    .gte('dia', desde)
    .lte('dia', hasta)
    .order('dia', { ascending: true })
    .limit(TOPE_EXPEDIENTES);
  if (operadorId) q = q.eq('operador_id', operadorId);

  const { data, error } = await acotada(q, 'jornada.leer');
  if (error) throw new JornadaIlegible(error.message);

  type Fila = {
    id: string; operador_id: string; dia: string; estado: string;
    cerrado_en: string | null; cerrado_por_email: string | null;
    conforme_operador_en: string | null; conforme_wa_message_id: string | null;
  };
  const filas = (data ?? []) as unknown as Fila[];
  if (filas.length === 0) return { dias: [], truncada: false };

  const ids = filas.map((f) => String(f.id));
  // ── AUDITORÍA 22, REN-C2 (CRÍTICO) ────────────────────────────────────────
  // Esto era un `.in()` desnudo sobre hasta 900 expedientes. PostgREST recorta
  // a 1,000 filas EN SILENCIO —sin error, sin bandera— y cada expediente lleva
  // varias marcas: con ~4 por día, 900 expedientes son ~3,600 filas y se
  // perdían dos tercios. Lo que se pierde aquí no es una cifra de tablero: son
  // MARCAS DEL REGISTRO DE JORNADA, el documento del art. 132 fr. XXXIV de la
  // LFT. Un registro laboral al que le faltan horas, sin decir que le faltan,
  // es peor que no tenerlo.
  //
  // `traerTodo` pagina con `count` y LANZA `LecturaIncompleta` si no puede
  // demostrar que leyó todo — que es justo lo que este módulo necesita, porque
  // ya falla cerrado con `JornadaIlegible`.
  let asientosFilas: Array<Record<string, unknown>>;
  try {
    asientosFilas = await traerTodo<Record<string, unknown>>(
      (desde, hasta) => admin.from('jornada_asiento')
        .select(`jornada_id, ${CAMPOS_ASIENTO}`, { count: 'exact' })
        .eq('tenant_id', tenantId).in('jornada_id', ids)
        // REN-9 (auditoría 24): `.order('momento')` solo no es un orden
        // ÚNICO — dos marcas con el mismo `momento` (dos sellos en el mismo
        // milisegundo, no imposible en un flujo de WhatsApp) podían caer en
        // páginas distintas de `.range()` en cualquier orden, duplicándose o
        // saltándose entre vueltas. El desempate por `id` (contrato de
        // `pg.ts`: `traerTodo` necesita un orden determinista) lo vuelve
        // reproducible.
        .order('momento', { ascending: true })
        .order('id', { ascending: true })
        .range(desde, hasta),
      'jornada.leer.asientos',
    );
  } catch (e) {
    throw new JornadaIlegible(e instanceof Error ? e.message : String(e));
  }
  const asientos = { data: asientosFilas, error: null as { message: string } | null };

  const porJornada = new Map<string, Asiento[]>();
  for (const a of (asientos.data ?? []) as unknown as Array<FilaAsientoDb & { jornada_id: string }>) {
    const lista = porJornada.get(String(a.jornada_id)) ?? [];
    lista.push(aAsiento(a));
    porJornada.set(String(a.jornada_id), lista);
  }

  return {
    dias: filas.map((f) => ({
      id: String(f.id),
      operadorId: String(f.operador_id),
      dia: String(f.dia),
      estado: f.estado === 'cerrado' ? 'cerrado' : 'abierto',
      cerradoEn: f.cerrado_en,
      cerradoPorEmail: f.cerrado_por_email,
      conformeOperadorEn: f.conforme_operador_en,
      conformeWaMessageId: f.conforme_wa_message_id,
      asientos: porJornada.get(String(f.id)) ?? [],
    })),
    truncada: filas.length >= TOPE_EXPEDIENTES,
  };
}

/** Nombre y número de empleado de los operadores de una lectura. Se consulta
 *  aparte —no embebido— por la misma razón que los asientos, y anclado al
 *  tenant. Un operador que no aparezca se rotula, nunca se inventa. */
export async function nombresDeOperadores(
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, { nombre: string; numeroEmpleado: string | null }>> {
  const mapa = new Map<string, { nombre: string; numeroEmpleado: string | null }>();
  if (ids.length === 0) return mapa;
  const { data, error } = await acotada(
    supabaseAdmin().from('operador').select('id, nombre, numero_empleado')
      .eq('tenant_id', tenantId).in('id', [...new Set(ids)]),
    'jornada.operadores',
  );
  if (error) throw new JornadaIlegible(`nombres de operadores: ${error.message}`);
  for (const o of (data ?? []) as Array<{ id: string; nombre: string; numero_empleado: string | null }>) {
    mapa.set(String(o.id), { nombre: String(o.nombre), numeroEmpleado: o.numero_empleado });
  }
  return mapa;
}

/**
 * FE-19 (auditoría 24): el catálogo completo de operadores de la flota, para
 * el `<select>` del filtro de Jornada — antes el filtro `?operador=` existía
 * en el servidor pero no había de dónde elegirlo en la UI. `traerTodo` con
 * orden único (`nombre`, desempate por `id`): con cientos de choferes, un
 * `.limit()` desnudo recortaría en silencio.
 */
export async function catalogoDeOperadores(tenantId: string): Promise<Array<{ id: string; nombre: string }>> {
  const admin = supabaseAdmin();
  const filas = await traerTodo<{ id: string; nombre: string }>(
    (desde, hasta) => acotada(admin.from('operador').select('id, nombre', conteo(desde))
      .eq('tenant_id', tenantId).order('nombre').order('id').range(desde, hasta), 'jornada.catalogo_operadores'),
    'jornada.catalogo_operadores',
  );
  return filas.map((o) => ({ id: String(o.id), nombre: String(o.nombre) }));
}

/**
 * Los asientos de UN expediente. Devuelve `null` —no `[]`— cuando la base no
 * contestó: una lista vacía significaría «este día no tiene marcas», que es
 * exactamente la mentira que esta feature no puede permitirse.
 */
export async function asientosDeJornada(tenantId: string, jornadaId: string): Promise<Asiento[] | null> {
  const { data, error } = await acotada(
    supabaseAdmin().from('jornada_asiento').select(CAMPOS_ASIENTO)
      .eq('tenant_id', tenantId).eq('jornada_id', jornadaId)
      .order('momento', { ascending: true }),
    'jornada.asientos.leer',
  );
  if (error) {
    logger.error('jornada.asientos_ilegibles', { jornada: jornadaId, err: error.message });
    return null;
  }
  return ((data ?? []) as unknown as FilaAsientoDb[]).map(aAsiento);
}

/** La política de la flota, o `null` si no la ha declarado. `null` NO se
 *  vuelve un objeto de ceros: sin umbral propio el motor evalúa solo la ley. */
export async function leerPolitica(tenantId: string): Promise<PoliticaFlota | null> {
  const { data, error } = await acotada(
    supabaseAdmin().from('jornada_politica')
      .select('horas_max_jornada, minutos_min_descanso, horas_min_entre_jornadas, fundamento')
      .eq('tenant_id', tenantId).maybeSingle(),
    'jornada.politica.leer',
  );
  if (error) throw new JornadaIlegible(`política de jornada: ${error.message}`);
  if (!data) return null;
  const f = data as {
    horas_max_jornada: number | string | null;
    minutos_min_descanso: number | null;
    horas_min_entre_jornadas: number | string | null;
    fundamento: string | null;
  };
  // `numeric` llega como string desde PostgREST. `null` se conserva `null`.
  const num = (v: number | string | null) => (v === null ? null : Number(v));
  return {
    horasMaxJornada: num(f.horas_max_jornada),
    minutosMinDescanso: f.minutos_min_descanso,
    horasMinEntreJornadas: num(f.horas_min_entre_jornadas),
    fundamento: f.fundamento,
  };
}

/**
 * Anula una marca. NO la borra: le pone motivo, autor y hora, y la deja en el
 * expediente. Es la mitad de una corrección; la otra mitad es `asentarMarca`
 * con `corrigeA` apuntando a ésta.
 *
 * Anclada al tenant Y a `anulado_en is null`: anular dos veces no reescribe la
 * primera anulación con otro autor.
 */
export async function anularAsiento(args: {
  tenantId: string;
  asientoId: string;
  motivo: string;
  usuarioId: string | null;
  usuarioEmail: string;
  ahora?: Date;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const motivo = args.motivo.trim();
  if (motivo === '') return { ok: false, error: 'Una anulación sin motivo no es una anotación: es una edición anónima.' };

  const { data, error } = await acotada(
    supabaseAdmin().from('jornada_asiento').update({
      anulado_en: (args.ahora ?? new Date()).toISOString(),
      anulado_por: args.usuarioId,
      anulado_por_email: args.usuarioEmail,
      anulado_motivo: motivo,
    })
      .eq('id', args.asientoId)
      .eq('tenant_id', args.tenantId)
      .is('anulado_en', null)
      .select('id'),
    'jornada.asiento.anular',
  );
  if (error) {
    logger.error('jornada.anulacion_fallo', { asiento: args.asientoId, err: error.message });
    return { ok: false, error: error.message };
  }
  if (!data || data.length === 0) {
    return { ok: false, error: 'Esa marca no existe en tu flota o ya estaba anulada.' };
  }
  return { ok: true };
}

/** Cierra el día. El cierre no borra ni congela: una corrección posterior sigue
 *  siendo posible y sigue quedando anotada. */
export async function cerrarDia(args: {
  tenantId: string;
  jornadaId: string;
  usuarioId: string | null;
  usuarioEmail: string;
  ahora?: Date;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await acotada(
    supabaseAdmin().from('jornada_dia').update({
      estado: 'cerrado',
      cerrado_en: (args.ahora ?? new Date()).toISOString(),
      cerrado_por: args.usuarioId,
      cerrado_por_email: args.usuarioEmail,
    })
      .eq('id', args.jornadaId)
      .eq('tenant_id', args.tenantId)
      .eq('estado', 'abierto')
      .select('id'),
    'jornada.dia.cerrar',
  );
  if (error) {
    logger.error('jornada.cierre_fallo', { jornada: args.jornadaId, err: error.message });
    return { ok: false, error: error.message };
  }
  if (!data || data.length === 0) return { ok: false, error: 'Ese día no existe en tu flota o ya estaba cerrado.' };
  return { ok: true };
}

/**
 * Sella la conformidad del operador con su día (LFT 132 fr. XXXIV, párrafo
 * tercero: el registro «hará prueba plena si se acredita que fue acordado»).
 *
 * El `WHERE conforme_operador_en IS NULL` es el candado: el mismo mensaje
 * reentregado por Meta no mueve la hora del acuerdo, igual que `sellarHito`.
 */
export async function sellarConformidad(args: {
  tenantId: string;
  jornadaId: string;
  waMessageId: string;
  ahora?: Date;
}): Promise<'sellada' | 'ya_estaba' | 'fallo'> {
  const { data, error } = await acotada(
    supabaseAdmin().from('jornada_dia').update({
      conforme_operador_en: (args.ahora ?? new Date()).toISOString(),
      conforme_wa_message_id: args.waMessageId,
    })
      .eq('id', args.jornadaId)
      .eq('tenant_id', args.tenantId)
      .is('conforme_operador_en', null)
      .select('id'),
    'jornada.dia.conformidad',
  );
  if (error) {
    logger.error('jornada.conformidad_fallo', { jornada: args.jornadaId, err: error.message });
    return 'fallo';
  }
  return data && data.length > 0 ? 'sellada' : 'ya_estaba';
}

/**
 * Declara (o actualiza) los umbrales de la flota. Update-luego-insert apoyado
 * en `jornada_politica_flota_unica`: dos filas dirían dos umbrales del mismo
 * concepto y el reporte no sabría cuál enseñó.
 */
export async function guardarPolitica(args: {
  tenantId: string;
  horasMaxJornada: number | null;
  minutosMinDescanso: number | null;
  horasMinEntreJornadas: number | null;
  fundamento: string | null;
  usuarioId: string | null;
  usuarioEmail: string;
  ahora?: Date;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const fila = {
    tenant_id: args.tenantId,
    horas_max_jornada: args.horasMaxJornada,
    minutos_min_descanso: args.minutosMinDescanso,
    horas_min_entre_jornadas: args.horasMinEntreJornadas,
    fundamento: args.fundamento,
    declarada_por: args.usuarioId,
    declarada_por_email: args.usuarioEmail,
    declarada_en: (args.ahora ?? new Date()).toISOString(),
  };
  const admin = supabaseAdmin();

  const act = await acotada(
    admin.from('jornada_politica').update(fila).eq('tenant_id', args.tenantId).select('id'),
    'jornada.politica.update',
  );
  if (act.error) {
    logger.error('jornada.politica_no_actualizada', { tenant: args.tenantId, err: act.error.message });
    return { ok: false, error: act.error.message };
  }
  if (act.data && act.data.length > 0) return { ok: true };

  // `tenant_id` se deletrea aquí Y viene en `fila`: es redundante a propósito.
  // La vigilancia de `consultas_admin_filtran_tenant.test.ts` lee la CADENA de
  // la consulta, no el objeto que se le pasa, y un insert cuya flota no se ve
  // en el código es exactamente el olvido que esa prueba existe para cazar.
  const ins = await acotada(
    admin.from('jornada_politica').insert({ ...fila, tenant_id: args.tenantId }).select('id'),
    'jornada.politica.insert',
  );
  if (ins.error) {
    // Otra sesión la creó entre el update y el insert: el índice único la
    // rebota y el update de esa sesión ya dejó la fila. No es un fallo.
    if (violaIndice(ins.error, 'jornada_politica_flota_unica')) return { ok: true };
    logger.error('jornada.politica_no_creada', { tenant: args.tenantId, err: ins.error.message });
    return { ok: false, error: ins.error.message };
  }
  return { ok: true };
}
