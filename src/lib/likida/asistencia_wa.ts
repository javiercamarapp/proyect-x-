import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { acotada } from './presupuesto';
import { strip_accents } from './cuadre/util';
import { crearIncidencia } from './operacion';
import { telefonoJefeDe } from './contactos';
import type { RolOficina } from './contactos';
import { sendText, sendButtons, MAX_CUERPO_BOTONES } from '@/lib/meta/client';
import { avisarOficina, parametrosAvisoOficina } from '@/lib/meta/aviso_oficina';
import { appUrl } from '@/lib/env';
import { puedeAsignar } from '@/lib/auth/permisos';
import { recomendacionCascada } from './asistencia_proveedor';
import { hoyMx } from '@/lib/formato';

/** El techo del 🚨 con botones — el de Meta, no una preferencia (c4-1). */
const MAX_CUERPO_AVISO = MAX_CUERPO_BOTONES;

// ═══════════════════════════════════════════════════════════════════════════
// ASISTENCIA EN CARRETERA Y SINIESTROS (0198, Fase 4 — núcleo).
//
// No es un conversador: es un DESPACHADOR. Su métrica es el tiempo hasta que
// un humano competente esté hablando con el chofer; un mensaje que no acorta
// ese reloj sobra. Por eso el orden es inamovible: (1) abrir la incidencia y
// su evento, (2) avisar al jefe SÍNCRONO en este mismo turno, (3) nada más.
// El modelo no participa en esta oleada — con COSTO_AGENTE_MS=15s el caso
// normal de un webhook cargado es que NO haya presupuesto para el modelo, así
// que el camino determinista tiene que estar completo por sí solo, no ser el
// plan B.
//
// ── LA ASIMETRÍA SE INVIERTE RESPECTO A TALACHA ────────────────────────────
// En talacha el falso positivo es barato (una incidencia de más que un humano
// descarta) y por eso su lista puede ser ancha. Aquí el caro es el NEGATIVO:
// un "chocamos" que siga su camino al agente de liquidación es una emergencia
// tratada como charla. Por eso: SIN tope de largo (quien describe un choque
// escribe largo; talacha corta a 220 y los hitos a 40), la pregunta NO
// descarta ("¿qué hago? choqué" es ROJO), y palabras ambiguas como "robo"
// entran a la lista — el costo de disparar de más es un aviso que el jefe
// descarta; el de disparar de menos, un chofer solo en la carretera.
//
// ── EL MODO MUDO (violencia activa) ────────────────────────────────────────
// En un asalto/secuestro/retén, el mejor producto es el que se calla: un bot
// escribiendo es un teléfono que vibra en la mano de alguien a quien están
// asaltando. UN solo mensaje corto y neutro, y silencio — y al jefe se le
// advierte "no le marques hasta saber que está seguro". Lesionados NO activa
// el modo mudo: un chofer con un herido necesita saber que alguien viene.
// ═══════════════════════════════════════════════════════════════════════════

/** El mismo aplanado que talacha/hitos: reconocer, no extraer. */
function limpiar(texto: string): string {
  return strip_accents(texto.toLowerCase())
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Alternancia EXPLÍCITA, no raíz con comodín: `choc\w*` atraparía "chocolate".
// Cada palabra nueva = una línea en la lista y un caso en el test.
//
// AUDITORÍA FABLE CICLO 1 (92-A/92-B): la primera lista omitía las formas más
// comunes del habla real mexicana ("nos volteamos", "se quemó la unidad",
// "nos están disparando", "hubo un accidente", "se murió un señor" — todas
// seguían su camino como charla), y a la vez `\brobo\b` a secas disparaba el
// protocolo completo de violencia con "es un robo" como queja de precio —
// la talacha del chofer se tragaba y al jefe se le ordenaba NO contactarlo.
// El robo ahora exige contexto VERBAL o de DESPOJO; el resto de la lista se
// amplió con las conjugaciones reales, cada una con su caso en el test.
const VIOLENCIA =
  /\b(asalto|asaltaron|asaltando|secuestro|secuestraron|balacera|disparos|disparan|disparando|balazos|armados|pistola|pistolas|encanonaron)\b|\b(nos|me|lo|la|los|las) (estan |esta |acaban de )?(roban|robando|robaron)\b|\brobo con violencia\b|\brobaron (el |la |un |una )?(camion|trailer|tracto|torton|unidad|caja|carga|diesel|remolque)\b|\bbajaron (del camion|de la unidad|del trailer|del tracto)\b/;
// El retén va aparte: "hay un retén raro" es ROJO mudo, pero "ya pasamos el
// retén sin problema" es un all-clear — tratarlo como violencia en curso le
// ordenaba al jefe no contactar a un chofer que iba bien (92-B).
const RETEN = /\breten\b/;
const RETEN_LIBRADO =
  /\b(ya )?(pasamos|pase|cruzamos|libramos|salimos)\b.*\breten\b|\breten\b.*\bsin (problema|problemas|novedad|pedo|bronca)\b/;
const LESIONADOS =
  /\b(lesionado|lesionados|herido|heridos|sangre|muerto|muertos|murio|murieron|fallecio|fallecieron)\b/;
// "accidente"/"volteo" pueden ser de un tercero o una maniobra — el falso
// positivo aquí es un 🚨 que el jefe descarta; el negativo, una emergencia
// tratada como charla. La asimetría del manifiesto manda: entran.
const SINIESTRO =
  /\b(choque|choques|chocamos|choco|chocaron|volcadura|volcamos|volco|volteamos|volteo|atropelle|atropellamos|atropello|incendio|fuego|derrame|accidente|accidentamos|estrellamos|estrelle|estampe|estampamos)\b|\bse (esta )?quema(ndo)?\b|\bse (quemo|quemaron|prendio|incendio)\b|\b(me|nos) pegaron (por|de) (atras|adelante|frente|lado|un lado)\b|\ble di a (un|una|otro|otra)\b|\b(me di|nos dimos) un llegue\b/;
const VIA_BLOQUEADA = /\b(bloqueo|bloqueada|bloqueado)\b/;
const EMERGENCIA_SUELTA = /\b911\b/;
const AMBAR =
  /\b(varado|varados|varada)\b|\bno (arranca|enciende|prende)\b|\bse salio del camino\b|\bse me fue el freno\b|\bsin frenos\b|\bhumo\b|\bse (sobre)?calento\b/;

/** ¿El texto trae violencia activa? El retén cuenta salvo que el propio
 *  mensaje diga que ya quedó atrás. */
function esViolencia(t: string): boolean {
  if (VIOLENCIA.test(t)) return true;
  return RETEN.test(t) && !RETEN_LIBRADO.test(t);
}

export type NivelAsistencia = 'rojo' | 'ambar';

export interface Asistencia {
  nivel: NivelAsistencia;
  /** Violencia activa: un solo mensaje neutro y silencio. */
  modoMudo: boolean;
}

/**
 * ¿El mensaje es una emergencia de carretera? `null` = no lo es y sigue su
 * camino (talacha, hitos, agente). ROJO gana sobre talacha EN EL ENRUTAMIENTO
 * (el check de asistencia corre antes), no aquí: este reconocedor solo dice
 * qué es, no qué le gana a qué.
 */
export function interpretarAsistencia(texto: string | undefined): Asistencia | null {
  if (typeof texto !== 'string' || !texto.trim()) return null;
  const t = limpiar(texto);
  if (esViolencia(t)) return { nivel: 'rojo', modoMudo: true };
  if (LESIONADOS.test(t) || SINIESTRO.test(t) || VIA_BLOQUEADA.test(t) || EMERGENCIA_SUELTA.test(t)) {
    return { nivel: 'rojo', modoMudo: false };
  }
  if (AMBAR.test(t)) return { nivel: 'ambar', modoMudo: false };
  return null;
}

/** Los tipos que este circuito abre — el filtro de "¿ya hay una abierta?". */
export const TIPOS_ASISTENCIA = ['siniestro', 'robo', 'emergencia_medica', 'varado', 'bloqueo'] as const;
export type TipoAsistencia = typeof TIPOS_ASISTENCIA[number];

/**
 * El tipo de incidencia sale del texto, con precedencia fija: violencia >
 * lesionados/médico > siniestro > vía bloqueada. "Nos asaltaron y hay un
 * herido" abre `robo` (la violencia manda el protocolo) y `hay_lesionados`
 * viaja aparte como columna.
 */
export function tipoDeAsistencia(texto: string, nivel: NivelAsistencia): TipoAsistencia {
  const t = limpiar(texto);
  if (nivel === 'ambar') return 'varado';
  if (esViolencia(t)) return 'robo';
  if (SINIESTRO.test(t)) return 'siniestro';
  if (LESIONADOS.test(t) || EMERGENCIA_SUELTA.test(t)) return 'emergencia_medica';
  if (VIA_BLOQUEADA.test(t)) return 'bloqueo';
  // Inalcanzable si `nivel` vino de interpretarAsistencia; el fallback dice
  // la verdad más conservadora en severidad.
  return 'siniestro';
}

/**
 * Qué tan grave es cada tipo, para decidir si un reporte nuevo ESCALA el
 * expediente abierto (auditoría Fable ciclo 1, 92-C). `emergencia_medica` y
 * `siniestro` empatan a propósito: un "chocamos" seguido de "hay un herido"
 * no cambia el tipo del expediente — sube `hay_lesionados`, que viaja aparte.
 */
export const RANGO_TIPO: Record<TipoAsistencia, number> = {
  robo: 4,
  emergencia_medica: 3,
  siniestro: 3,
  bloqueo: 2,
  varado: 1,
};

/** `true` SOLO si el texto lo dice; si no, NULL (no preguntado). JAMÁS false:
 *  un false es un parte médico que solo el chofer puede dar. */
export function lesionadosSegunTexto(texto: string): true | null {
  return LESIONADOS.test(limpiar(texto)) ? true : null;
}

// ── La bitácora por incidencia (0198) — best-effort, con idempotencia ──────

/**
 * Anota un evento. `duplicado` = ese mismo wa_message_id ya estaba (el índice
 * único parcial de la 0198): el webhook reentregó y NO hay que repetir nada.
 * Un evento que no se pudo anotar no detiene el circuito — la bitácora sirve
 * al post-mortem; el aviso al jefe sirve al chofer. Se loguea y se sigue.
 */
export async function anotarEventoIncidencia(
  tenantId: string,
  incidenciaId: string,
  tipo: string,
  detalle?: Record<string, unknown>,
  waMessageId?: string | null,
): Promise<'anotado' | 'duplicado' | 'fallo'> {
  try {
    const { error } = await acotada(supabaseAdmin().from('incidencia_evento').insert({
      tenant_id: tenantId,
      incidencia_id: incidenciaId,
      tipo,
      detalle: detalle ?? null,
      wa_message_id: waMessageId ?? null,
    }), 'asistencia.evento');
    if (!error) return 'anotado';
    if (/duplicate key|incidencia_evento_wa_unico/i.test(error.message)) return 'duplicado';
    logger.warn('asistencia.evento_no_anotado', { incidencia: incidenciaId, tipo, err: error.message });
    return 'fallo';
  } catch (e) {
    logger.warn('asistencia.evento_no_anotado', { incidencia: incidenciaId, tipo, err: e instanceof Error ? e.message : String(e) });
    return 'fallo';
  }
}

// ── El lado del CHOFER ─────────────────────────────────────────────────────

interface AbiertaExistente {
  id: string;
  tipo: string;
  prioridad: string;
  hayLesionados: boolean | null;
  abiertaEn: string;
}

/**
 * El EXPEDIENTE de asistencia abierto de este chofer, si lo hay — POR
 * OPERADOR, sin importar el viaje (auditoría Fable ciclo 1, 92-C/92-E).
 *
 * Antes se buscaba por viaje cuando lo había, y eso dejaba dos agujeros: un
 * varado del viaje pasado sin resolver se volvía invisible para el reporte
 * del viaje nuevo (dos filas, dos protocolos, un chofer), y la carrera
 * check-then-create podía abrir dos expedientes del mismo chofer. Ahora la
 * semántica es la del índice único parcial de la 0201: UN expediente abierto
 * por chofer; la severidad sube EN el mismo, no en una fila nueva.
 *
 * Lanza ante error de base: crear a ciegas duplicaría el 🚨 al jefe.
 */
async function abiertaDelChofer(
  tenantId: string, operadorId: string | null,
): Promise<AbiertaExistente | null> {
  if (!operadorId) return null; // el camino de oficina tiene su propia búsqueda
  const { data, error } = await acotada(supabaseAdmin()
    .from('incidencia')
    .select('id, tipo, prioridad, hay_lesionados, abierta_en')
    .eq('tenant_id', tenantId)
    .eq('operador_id', operadorId)
    .in('tipo', [...TIPOS_ASISTENCIA])
    .neq('estado', 'resuelta')
    .order('abierta_en', { ascending: false })
    .limit(1), 'asistencia.abiertaDelChofer');
  if (error) throw new Error(`asistencia.abiertaDelChofer: ${error.message}`);
  const f = (data ?? [])[0];
  if (!f) return null;
  return {
    id: f.id as string,
    tipo: f.tipo as string,
    prioridad: f.prioridad as string,
    hayLesionados: (f.hay_lesionados as boolean | null) ?? null,
    abiertaEn: f.abierta_en as string,
  };
}

/**
 * 72 horas: más que cualquier emergencia real sigue "en curso" (una grúa
 * tarda horas, un siniestro con ajustador un día), menos que el olvido — el
 * caso que esta ventana corta es el varado del lunes que nadie marcó
 * resuelto en el panel tragándose el choque del viernes (92-C). Al llegar
 * un reporte nuevo sobre un expediente más viejo que esto, el viejo se
 * RESUELVE con nota y el nuevo abre limpio con su propio 🚨.
 */
const VENTANA_EXPEDIENTE_MS = 72 * 3600 * 1000;

/** Cierra por antigüedad. Best-effort: si el UPDATE falla se sigue con el
 *  expediente viejo (peor duplicar el 🚨 que reusar una fila vieja). */
async function resolverPorAntiguedad(tenantId: string, incidenciaId: string): Promise<boolean> {
  const { error } = await acotada(supabaseAdmin()
    .from('incidencia')
    .update({ estado: 'resuelta', resuelta_en: new Date().toISOString() })
    .eq('id', incidenciaId).eq('tenant_id', tenantId)
    .neq('estado', 'resuelta'), 'asistencia.resolverAntigua');
  if (error) {
    logger.warn('asistencia.antigua_no_resuelta', { incidencia: incidenciaId, err: error.message });
    return false;
  }
  await anotarEventoIncidencia(tenantId, incidenciaId, 'resuelta_por_antiguedad', {
    nota: 'cerrada por antigüedad (>72 h) al llegar un reporte nuevo del mismo chofer',
  });
  await cerrarCoordinacionesDeIncidencia(tenantId, incidenciaId, 'resuelta_por_antiguedad');
  return true;
}

/**
 * Cierra las coordinaciones de proveedor (0213) que la incidencia dejó vivas
 * al resolverse — AUDITORÍA FABLE CICLO 4 (c4-2): sin esto, una `confirmada`
 * vivía para siempre, el mismo gruero jamás volvía a matchear una gestión
 * nueva sin ambigüedad, y sus mensajes se reenviaban al jefe eternamente.
 *
 * El estado terminal es `descartada` (la máquina de la 0213 no tiene otro y
 * agregar uno cambiaría CHECK, índices y lectores por igual valor): la VERDAD
 * de cómo terminó — "cerrada al resolver la incidencia, estaba confirmada" —
 * queda en la bitácora, que es lo citable. Al proveedor que sí fue contactado
 * se le avisa que la emergencia quedó atendida (best-effort: el cierre ya
 * está firmado aunque el aviso no salga). Nunca lanza: cerrar el expediente
 * no puede fallar por su limpieza.
 */
export async function cerrarCoordinacionesDeIncidencia(
  tenantId: string, incidenciaId: string, motivo: string,
): Promise<void> {
  try {
    const { data, error } = await acotada(supabaseAdmin()
      .from('coordinacion_proveedor')
      .update({ estado: 'descartada', decidida_en: new Date().toISOString() })
      .eq('tenant_id', tenantId).eq('incidencia_id', incidenciaId)
      .neq('estado', 'descartada')
      .select('id, estado, proveedor_nombre, proveedor_telefono, contactado_en'), 'asistencia.cerrarCoordinaciones');
    if (error) throw new Error(error.message);
    for (const f of (data ?? []) as Array<{ id: string; proveedor_nombre: string; proveedor_telefono: string; contactado_en: string | null }>) {
      await anotarEventoIncidencia(tenantId, incidenciaId, 'coordinacion_cerrada', {
        coordinacionId: f.id, proveedor: f.proveedor_nombre, motivo,
      });
      // Solo al que de verdad recibió nuestro mensaje (contactado_en sellado):
      // al de pendiente_plantilla nunca le escribimos y escribirle ahora sería
      // iniciar una conversación para decir "ya no".
      if (f.contactado_en) {
        try {
          await sendText(f.proveedor_telefono, 'La emergencia quedó atendida — gracias por responder. Si ya va en camino, márquele al jefe de tráfico. 🙏');
        } catch (e) {
          logger.warn('asistencia.coordinacion_cierre_no_avisado', { coordinacion: f.id, err: e instanceof Error ? e.message : String(e) });
        }
      }
    }
  } catch (e) {
    logger.warn('asistencia.coordinaciones_no_cerradas', { incidencia: incidenciaId, err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Ancla el pin del chofer a su expediente de asistencia VIVO (c4-6): la
 * cascada promete "cercanía real" y el mensaje al proveedor promete el link
 * del mapa — pero la incidencia del chofer nacía sin lat/lng y el pin que
 * Likida misma le pide ("mándame tu ubicación") solo llegaba al jefe como
 * texto. El pin más reciente PISA al anterior a propósito: el chofer que
 * reenvía su ubicación está corrigiendo la vieja.
 *
 * Best-effort: devuelve el id del expediente anclado o null — nunca lanza
 * (el flujo de posición/aviso al jefe no depende de esto).
 */
export async function anclarUbicacionIncidencia(
  tenantId: string, operadorId: string, lat: number, lng: number,
): Promise<string | null> {
  try {
    const { data, error } = await acotada(supabaseAdmin()
      .from('incidencia')
      .update({ lat, lng })
      .eq('tenant_id', tenantId)
      .eq('operador_id', operadorId)
      .in('tipo', [...TIPOS_ASISTENCIA])
      .neq('estado', 'resuelta')
      .select('id'), 'asistencia.anclarUbicacion');
    if (error) throw new Error(error.message);
    const id = ((data ?? [])[0]?.id as string) ?? null;
    if (id) await anotarEventoIncidencia(tenantId, id, 'ubicacion_anclada', { lat, lng });
    return id;
  } catch (e) {
    logger.warn('asistencia.ubicacion_no_anclada', { operador: operadorId, err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Rótulos del aviso. Best-effort declarado: si la lectura falla, "tu chofer"
 *  — detener un 🚨 por un rótulo dejaría la emergencia sin jefe. */
async function etiquetasAviso(tenantId: string, viajeId: string | null, operadorId: string | null): Promise<{ chofer: string; folio: string | null }> {
  try {
    const admin = supabaseAdmin();
    const [rOp, rViaje] = await Promise.all([
      operadorId
        ? admin.from('operador').select('nombre').eq('id', operadorId).eq('tenant_id', tenantId).maybeSingle()
        : Promise.resolve({ data: null }),
      viajeId
        ? admin.from('viaje').select('folio').eq('id', viajeId).eq('tenant_id', tenantId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    return {
      chofer: (rOp.data?.nombre as string) || 'Tu chofer',
      folio: (rViaje.data?.folio as string) || null,
    };
  } catch (e) {
    logger.warn('asistencia.etiquetas_ilegibles', { viaje: viajeId, err: e instanceof Error ? e.message : String(e) });
    return { chofer: 'Tu chofer', folio: null };
  }
}

const ROTULO_TIPO: Record<TipoAsistencia, string> = {
  siniestro: 'un SINIESTRO',
  robo: 'un ROBO / violencia',
  emergencia_medica: 'una EMERGENCIA MÉDICA',
  varado: 'que está varado',
  bloqueo: 'un bloqueo en la vía',
};

/**
 * El 🚨 al jefe, con botón de "Ya lo atiendo". `true` solo si Meta lo aceptó
 * — el llamador le dice al chofer la VERDAD de si su jefe ya lo sabe.
 *
 * ROJO ignora la ventana horaria SIEMPRE. Ámbar hoy también avisa inmediato:
 * la ventana con aviso diferido (`notificar_desde`) llega con el escalamiento
 * de la Fase 5 — hasta entonces, es preferible despertar al jefe por un
 * varado que callarse uno.
 */
async function avisarAlJefe(args: {
  tenantId: string;
  incidenciaId: string;
  tipo: TipoAsistencia;
  nivel: NivelAsistencia;
  modoMudo: boolean;
  hayLesionados: true | null;
  chofer: string;
  folio: string | null;
  descripcion: string;
}): Promise<boolean> {
  let telefono: string | null = null;
  try {
    telefono = await telefonoJefeDe(args.tenantId);
  } catch (e) {
    logger.error('asistencia.jefe_ilegible', { tenant: args.tenantId, err: e instanceof Error ? e.message : String(e) });
    return false;
  }
  if (!telefono) {
    logger.warn('asistencia.sin_jefe', { tenant: args.tenantId, incidencia: args.incidenciaId });
    return false;
  }
  const desc = args.descripcion.replace(/\s+/g, ' ').trim().slice(0, 220);
  const encabezado = args.nivel === 'rojo' ? '🚨' : '⚠️';
  // La parte FIJA del aviso se arma primero: lo que quede de los 1024 de Meta
  // es el presupuesto de la cascada (c4-1). Antes la cascada se pegaba sin
  // medir y con un directorio bien poblado el cuerpo rebasaba el límite —
  // Meta rechaza el mensaje ENTERO, así que el adorno se comía el 🚨.
  const armarCuerpo = (cascada: string | null): string =>
    `${encabezado} ${args.chofer} reporta ${ROTULO_TIPO[args.tipo]}${args.folio ? ` en el viaje ${args.folio}` : ''}:\n` +
    `«${desc}»\n` +
    (args.hayLesionados === true ? '\n⛑️ Menciona LESIONADOS.\n' : '') +
    (args.modoMudo
      ? '\n⚠️ Puede ser violencia EN CURSO: NO le marques ni le escribas hasta saber que está seguro — un teléfono sonando lo puede poner en riesgo. Nosotros tampoco le vamos a escribir más.\n'
      : '') +
    (cascada ?? '') +
    `\nMárcale en cuanto puedas${args.modoMudo ? ' a un tercero cercano (base, otro chofer de la zona), no a él' : ''} y aprieta el botón para que sepamos que ya lo estás atendiendo.`;
  // Capa C: la cascada del proveedor correcto (directorio verificado → 800 de
  // la póliza → recursos nacionales) viaja EN el mismo aviso — el jefe decide
  // y marca, Likida jamás. Best-effort adentro (devuelve null si algo falla o
  // en robo/violencia): la recomendación nunca puede costar el 🚨.
  const presupuestoCascada = MAX_CUERPO_AVISO - armarCuerpo(null).length;
  const cascada = args.modoMudo || presupuestoCascada <= 0
    ? null
    : await recomendacionCascada(args.tenantId, args.incidenciaId, args.tipo, hoyMx(), presupuestoCascada);
  let cuerpo = armarCuerpo(cascada);
  // Cinturón: si aun presupuestada la cascada no cupo (no debería pasar — el
  // recorte de textoCascadaParaJefe la deja caber o la anula), el aviso sale
  // SIN ella antes que no salir.
  if (cuerpo.length > MAX_CUERPO_AVISO) cuerpo = armarCuerpo(null);
  const enviado = await sendButtons(telefono, cuerpo, [
    { id: `asi_ok:${args.incidenciaId}`, titulo: 'Ya lo atiendo' },
    // Capa D (0213): el botón que AUTORIZA a Likida a escribirle al primer
    // proveedor VERIFICADO de la lista de arriba. En modo mudo no existe —
    // en violencia no se coordina nada (mismo candado que la cascada), y el
    // handler re-verifica tipo y directorio al apretarlo.
    ...(args.modoMudo ? [] : [{ id: `coo_ir:${args.incidenciaId}`, titulo: 'Contactar proveedor' }]),
  ]);
  if (enviado) return true;
  // Tirantes (c4-1): si los botones fallaron por lo que sea, el AVISO viaja en
  // texto plano (límite 4096) — sin botones, pero con las salidas que ya
  // existen dichas: la palabra «contactar» y la mesa de control del panel.
  const enviadoTexto = await sendText(telefono,
    `${cuerpo}\n\n(No pude mandarte los botones — atiéndela desde la Mesa de control del panel` +
    `${args.modoMudo ? '' : ', o escríbeme «contactar 1» para que le escriba yo al primer proveedor de la lista'}.)`);
  if (enviadoTexto) {
    logger.warn('asistencia.aviso_sin_botones', { incidencia: args.incidenciaId });
    return true;
  }
  return false;
}

/**
 * Dos mensajes cortos y neutros — nada de instrucciones, nada de preguntas: el
 * chofer en violencia activa no debe recibir más vibraciones nuestras. Pero
 * "menos vibración" no es licencia para mentir (AUDITORÍA 28, AG-M2): si el
 * aviso al jefe no salió, el chofer no puede quedarse creyendo que sí. Cada
 * rama que devuelve la respuesta muda elige entre las dos según si el aviso
 * de verdad salió — nunca la de AVISADO por default.
 */
const RESPUESTA_MUDA_AVISADO = 'Recibido. Tu jefe ya lo sabe.';
const RESPUESTA_MUDA_NO_AVISADO = 'Recibido. No pude avisar a tu jefe — si puedes, márcale tú.';

export interface ResultadoAsistencia {
  /** Lo que se le contesta al chofer. */
  respuesta: string;
  /** `true` cuando el circuito atendió el mensaje (el llamador hace return). */
  atendida: boolean;
}

/**
 * El turno de una emergencia del CHOFER. Quien llama ya decidió que el
 * mensaje es asistencia (`interpretarAsistencia`).
 *
 * UNA incidencia de asistencia abierta por chofer: el segundo mensaje de la
 * misma emergencia se anota como evento (con su wa_message_id — el índice
 * único absorbe la reentrega del webhook) y NO duplica el 🚨 al jefe.
 */
export async function atenderAsistenciaChofer(args: {
  tenantId: string;
  viajeId: string | null;
  operadorId: string;
  texto: string;
  asistencia: Asistencia;
  waMessageId?: string | null;
}): Promise<ResultadoAsistencia> {
  const { asistencia } = args;
  const tipo = tipoDeAsistencia(args.texto, asistencia.nivel);
  const hayLesionados = lesionadosSegunTexto(args.texto);

  let abierta: AbiertaExistente | null;
  try {
    abierta = await abiertaDelChofer(args.tenantId, args.operadorId);
  } catch (e) {
    logger.error('asistencia.abierta_ilegible', { operador: args.operadorId, err: e instanceof Error ? e.message : String(e) });
    // Fallar cerrado en la VERDAD, no en la atención: no se sabe si el jefe ya
    // tiene el aviso, así que no se afirma ni se duplica — se le da al chofer
    // la salida que no depende de nosotros.
    return {
      atendida: true,
      // No hubo NINGÚN intento de avisar al jefe (ni siquiera se supo si ya
      // había una emergencia abierta): la variante NO-AVISADO es la única verdad.
      respuesta: asistencia.modoMudo
        ? RESPUESTA_MUDA_NO_AVISADO
        : 'No pude registrar tu reporte ahorita 😕 — márcale DIRECTO a tu jefe, no esperes este chat. Si puedes, mándame el reporte de nuevo en un momento.',
    };
  }

  // El expediente más viejo que la ventana se cierra con nota y el reporte
  // nuevo abre limpio (92-C). Si el cierre falla, se sigue con el viejo:
  // reusar una fila rancia es menos malo que arriesgar un 🚨 duplicado.
  if (abierta && Date.now() - Date.parse(abierta.abiertaEn) > VENTANA_EXPEDIENTE_MS) {
    if (await resolverPorAntiguedad(args.tenantId, abierta.id)) abierta = null;
  }

  if (abierta) {
    return atenderConExpedienteAbierto(args, abierta, tipo, hayLesionados);
  }

  let incidenciaId: string;
  try {
    incidenciaId = await crearIncidencia(args.tenantId, {
      viajeId: args.viajeId,
      operadorId: args.operadorId,
      tipo,
      prioridad: asistencia.nivel === 'rojo' ? 'critica' : 'alta',
      descripcion: args.texto.slice(0, 500),
      hayLesionados,
    });
  } catch (e) {
    const msj = e instanceof Error ? e.message : String(e);
    // LA CARRERA (92-E): dos webhooks concurrentes del mismo chofer pasan
    // ambos el check de arriba; el índice único parcial de la 0201 deja
    // ganar exactamente a uno. El perdedor NO es un error — es el segundo
    // mensaje de la misma emergencia: se relee el expediente que el ganador
    // abrió y se sigue por el camino de siempre.
    if (/incidencia_asistencia_abierta_unica|duplicate key/i.test(msj)) {
      try {
        const ganadora = await abiertaDelChofer(args.tenantId, args.operadorId);
        if (ganadora) return atenderConExpedienteAbierto(args, ganadora, tipo, hayLesionados);
      } catch { /* cae al mensaje honesto de abajo */ }
    }
    logger.error('asistencia.crear_fallo', { operador: args.operadorId, err: msj });
    return {
      atendida: true,
      // Tampoco hubo aviso: la incidencia ni se pudo crear.
      respuesta: asistencia.modoMudo
        ? RESPUESTA_MUDA_NO_AVISADO
        : 'No pude registrar tu reporte ahorita 😕 — márcale DIRECTO a tu jefe, no esperes este chat.',
    };
  }

  await anotarEventoIncidencia(args.tenantId, incidenciaId, 'abierta', {
    nivel: asistencia.nivel, tipo, hayLesionados, modoMudo: asistencia.modoMudo,
  }, args.waMessageId);

  const etiquetas = await etiquetasAviso(args.tenantId, args.viajeId, args.operadorId);
  const avisado = await avisarAlJefe({
    tenantId: args.tenantId,
    incidenciaId,
    tipo,
    nivel: asistencia.nivel,
    modoMudo: asistencia.modoMudo,
    hayLesionados,
    chofer: etiquetas.chofer,
    folio: etiquetas.folio,
    descripcion: args.texto,
  });
  await anotarEventoIncidencia(args.tenantId, incidenciaId, avisado ? 'aviso_jefe_enviado' : 'aviso_jefe_fallido');
  logger.info('asistencia.abierta', { incidencia: incidenciaId, tipo, nivel: asistencia.nivel, avisado, lesionados: hayLesionados });

  if (asistencia.modoMudo) {
    // El DETALLE de si el jefe recibió no se le explica al chofer en violencia
    // activa (más texto es más vibración), pero la línea corta SÍ tiene que
    // ser verdad — nunca "ya lo sabe" si el aviso rebotó (AUDITORÍA 28, AG-M2).
    // El post-mortem completo vive en la bitácora y el escalamiento (Fase 5).
    return { atendida: true, respuesta: avisado ? RESPUESTA_MUDA_AVISADO : RESPUESTA_MUDA_NO_AVISADO };
  }
  if (!avisado) {
    return {
      atendida: true,
      respuesta: 'Registré tu emergencia 🚨 pero NO pude avisarle a tu jefe por WhatsApp — márcale DIRECTO ahora mismo. El reporte queda guardado.',
    };
  }
  return {
    atendida: true,
    respuesta: asistencia.nivel === 'rojo'
      ? 'Tu jefe ya tiene tu reporte 🚨 y le pedimos atenderlo YA. Si hay lesionados marca al 911 primero. Mándame tu ubicación (el clip 📎 → Ubicación) para pasársela también.'
      : 'Anotado ⚠️ — le avisé a tu jefe que estás varado para que te resuelvan. Mándame tu ubicación (el clip 📎 → Ubicación) y se la paso.',
  };
}

/**
 * El reporte que llega SOBRE un expediente ya abierto (auditoría Fable ciclo
 * 1, 92-C y 92-D — antes este camino solo anotaba en la bitácora del panel
 * mientras le decía al chofer "se lo paso": el "hay dos heridos" posterior a
 * un "chocamos" jamás llegaba al jefe, y un varado viejo se tragaba un choque
 * nuevo sin subirle la prioridad a nadie).
 *
 * Dos caminos:
 *  · ESCALA (el tipo nuevo es más grave, o un ROJO cae sobre un expediente
 *    ámbar): se ACTUALIZA la misma fila —tipo, prioridad, lesionados— y el
 *    jefe recibe un 🚨 NUEVO con botón. El reconocimiento anterior se borra:
 *    era del incidente menor, y dejarlo puesto le diría a la Fase 5 que la
 *    emergencia nueva ya está atendida.
 *  · NO escala: se anota el evento y el texto SE REENVÍA al jefe (sendText,
 *    sin botón) — en una emergencia real el jefe quiere cada mensaje, y la
 *    respuesta al chofer solo promete lo que de verdad pasó. Si además el
 *    texto trae lesionados por primera vez, la columna sube a true.
 */
async function atenderConExpedienteAbierto(
  args: { tenantId: string; viajeId: string | null; operadorId: string; texto: string; asistencia: Asistencia; waMessageId?: string | null },
  abierta: AbiertaExistente,
  tipo: TipoAsistencia,
  hayLesionados: true | null,
): Promise<ResultadoAsistencia> {
  const { asistencia } = args;
  const rangoNuevo = RANGO_TIPO[tipo];
  const rangoAbierto = RANGO_TIPO[abierta.tipo as TipoAsistencia] ?? 0;
  const escala = rangoNuevo > rangoAbierto
    || (asistencia.nivel === 'rojo' && abierta.prioridad !== 'critica');
  const lesionadosNuevos = hayLesionados === true && abierta.hayLesionados !== true;

  if (escala) {
    const { error } = await acotada(supabaseAdmin()
      .from('incidencia')
      .update({
        tipo,
        prioridad: 'critica',
        ...(lesionadosNuevos ? { hay_lesionados: true } : {}),
        reconocida_en: null,
        reconocida_por: null,
      })
      .eq('id', abierta.id).eq('tenant_id', args.tenantId)
      .neq('estado', 'resuelta'), 'asistencia.escalar');
    if (error) {
      // No se pudo subir la severidad: se dice la verdad y se da la salida
      // que no depende de nosotros — jamás un "ya lo sabe" sin respaldo. No
      // hubo intento de avisar (la escalada ni se guardó): variante NO-AVISADO.
      logger.error('asistencia.escalada_fallo', { incidencia: abierta.id, err: error.message });
      return {
        atendida: true,
        respuesta: asistencia.modoMudo
          ? RESPUESTA_MUDA_NO_AVISADO
          : 'No pude actualizar tu reporte ahorita 😕 — márcale DIRECTO a tu jefe, esto suena más grave que lo anterior.',
      };
    }
    await anotarEventoIncidencia(args.tenantId, abierta.id, 'escalada', {
      de: abierta.tipo, a: tipo, texto: args.texto.slice(0, 500),
    }, args.waMessageId);
    const etiquetas = await etiquetasAviso(args.tenantId, args.viajeId, args.operadorId);
    const avisado = await avisarAlJefe({
      tenantId: args.tenantId,
      incidenciaId: abierta.id,
      tipo,
      nivel: 'rojo',
      modoMudo: asistencia.modoMudo,
      hayLesionados: lesionadosNuevos ? true : abierta.hayLesionados === true ? true : null,
      chofer: etiquetas.chofer,
      folio: etiquetas.folio,
      descripcion: args.texto,
    });
    await anotarEventoIncidencia(args.tenantId, abierta.id, avisado ? 'aviso_jefe_enviado' : 'aviso_jefe_fallido');
    logger.info('asistencia.escalada', { incidencia: abierta.id, de: abierta.tipo, a: tipo, avisado });
    if (asistencia.modoMudo) {
      return { atendida: true, respuesta: avisado ? RESPUESTA_MUDA_AVISADO : RESPUESTA_MUDA_NO_AVISADO };
    }
    return {
      atendida: true,
      respuesta: avisado
        ? 'Subí la gravedad de tu reporte 🚨 y tu jefe acaba de recibir el aviso nuevo. Si hay lesionados marca al 911 primero.'
        : 'Subí la gravedad de tu reporte 🚨 pero NO pude avisarle a tu jefe por WhatsApp — márcale DIRECTO ahora mismo.',
    };
  }

  // No escala: evento + reenvío del texto al jefe. La columna de lesionados
  // sube si este mensaje los menciona por primera vez (92-D).
  const anotado = await anotarEventoIncidencia(args.tenantId, abierta.id, 'mensaje_adicional', { texto: args.texto.slice(0, 500) }, args.waMessageId);
  if (lesionadosNuevos) {
    const { error } = await acotada(supabaseAdmin()
      .from('incidencia')
      .update({ hay_lesionados: true })
      .eq('id', abierta.id).eq('tenant_id', args.tenantId), 'asistencia.lesionados');
    if (error) logger.warn('asistencia.lesionados_no_sellados', { incidencia: abierta.id, err: error.message });
  }
  let reenviado = false;
  try {
    const telefono = await telefonoJefeDe(args.tenantId);
    if (telefono) {
      const etiquetas = await etiquetasAviso(args.tenantId, args.viajeId, args.operadorId);
      const texto = `${lesionadosNuevos ? '⛑️ Ahora menciona LESIONADOS.\n' : ''}${etiquetas.chofer} sigue reportando sobre su emergencia:\n«${args.texto.replace(/\s+/g, ' ').trim().slice(0, 220)}»`;
      // AGEN-5 / WA-4: por texto y, fuera de la ventana de 24 h, por
      // plantilla. `reenviado` decide lo que se le dice al chofer.
      const r = await avisarOficina(telefono, texto, {
        parametros: parametrosAvisoOficina(etiquetas.chofer, `${lesionadosNuevos ? 'LESIONADOS · ' : ''}sigue reportando su emergencia`, `${appUrl()}/dashboard/emergencias`),
        contexto: { tenant: args.tenantId, incidencia: abierta.id, evento: 'asistencia.adicional' },
      });
      reenviado = r.ok;
      if (!r.ok) logger.warn('asistencia.adicional_no_reenviado', { incidencia: abierta.id, motivo: r.motivo, codigo: r.codigo });
    }
  } catch (e) {
    logger.warn('asistencia.adicional_no_reenviado', { incidencia: abierta.id, err: e instanceof Error ? e.message : String(e) });
  }
  logger.info('asistencia.mensaje_adicional', { incidencia: abierta.id, anotado, reenviado, lesionadosNuevos });
  if (asistencia.modoMudo) {
    return { atendida: true, respuesta: reenviado ? RESPUESTA_MUDA_AVISADO : RESPUESTA_MUDA_NO_AVISADO };
  }
  return {
    atendida: true,
    respuesta: reenviado
      ? 'Le acabo de pasar este mensaje a tu jefe también 🚨 — sigue escribiendo aquí lo que cambie.'
      : 'Quedó anotado en tu reporte, pero NO pude reenviárselo a tu jefe por WhatsApp — si es urgente, márcale directo.',
  };
}

// ── El lado del JEFE: "Ya lo atiendo" ──────────────────────────────────────

export interface CuentaReconoce {
  tenantId: string | null;
  rol: RolOficina;
  userId: string;
}

function leerBotonAsistencia(texto: string): string | null {
  const m = /^asi_ok:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(texto.trim());
  return m ? m[1] : null;
}

/**
 * El botón del jefe. `null` = no es de este circuito. La firma es atómica
 * (`where reconocida_en is null`): dos jefes o dos taps, gana exactamente uno
 * y el segundo recibe la verdad. Al chofer se le avisa "ya lo están
 * atendiendo" — SALVO en robo/violencia: ahí el silencio sigue mandando.
 */
export async function atenderReconocimientoAsistencia(
  cuenta: CuentaReconoce,
  texto: string,
  ahora: Date = new Date(),
): Promise<string | null> {
  if (!texto?.trim()) return null;
  const incidenciaId = leerBotonAsistencia(texto);
  if (!incidenciaId) return null;

  if (!cuenta.tenantId) return 'Esa emergencia no es de una flota tuya.';
  if (!puedeAsignar(cuenta.rol)) {
    return 'Tu rol no atiende emergencias de camino — eso le toca al dueño o al jefe de tráfico.';
  }

  const { data, error } = await acotada(supabaseAdmin()
    .from('incidencia')
    .update({ reconocida_en: ahora.toISOString(), reconocida_por: cuenta.userId })
    .eq('id', incidenciaId)
    .eq('tenant_id', cuenta.tenantId)   // tenant del LOOKUP, jamás del texto
    .is('reconocida_en', null)
    .select('id, tipo, viaje_id, operador_id'), 'asistencia.reconocer');
  if (error) {
    logger.error('asistencia.reconocer_fallo', { incidencia: incidenciaId, err: error.message });
    return 'No pude registrar que ya lo atiendes — inténtalo de nuevo en un momento.';
  }
  const fila = (data ?? [])[0] as { id: string; tipo: string; viaje_id: string | null; operador_id: string | null } | undefined;
  if (!fila) {
    const { data: existente, error: errLee } = await acotada(supabaseAdmin()
      .from('incidencia').select('reconocida_en')
      .eq('id', incidenciaId).eq('tenant_id', cuenta.tenantId)
      .maybeSingle(), 'asistencia.releer');
    if (errLee) return 'No pude registrar que ya lo atiendes — inténtalo de nuevo en un momento.';
    if (!existente) return 'No encontré esa emergencia en tu flota.';
    return existente.reconocida_en
      ? 'Alguien de tu equipo ya la está atendiendo — no cambié nada.'
      : 'Esa emergencia ya no se puede marcar desde aquí — revísala en el panel.';
  }

  await anotarEventoIncidencia(cuenta.tenantId, fila.id, 'reconocida', { por: cuenta.userId });

  // En robo/violencia el chofer NO recibe nada: el modo mudo no termina
  // cuando el jefe aprieta un botón — termina cuando el chofer está seguro.
  if (fila.tipo === 'robo') {
    logger.info('asistencia.reconocida', { incidencia: fila.id, por: cuenta.userId, avisadoChofer: false });
    return 'Anotado: la estás atendiendo. Al chofer NO le escribimos nada (puede seguir en riesgo) — coordina por fuera y márcale solo cuando sepas que está seguro.';
  }

  let avisado = false;
  try {
    const admin = supabaseAdmin();
    let operadorId = fila.operador_id;
    if (!operadorId && fila.viaje_id) {
      const { data: v } = await admin.from('viaje').select('operador_id')
        .eq('id', fila.viaje_id).eq('tenant_id', cuenta.tenantId).maybeSingle();
      operadorId = (v?.operador_id as string) ?? null;
    }
    if (operadorId) {
      const { data: op } = await admin.from('operador').select('telefono')
        .eq('id', operadorId).eq('tenant_id', cuenta.tenantId).maybeSingle();
      if (op?.telefono) {
        avisado = Boolean(await sendText(op.telefono as string, 'Tu jefe ya está atendiendo tu emergencia 🚨 — ayuda en camino. Sigue aquí por cualquier cambio.'));
      }
    }
  } catch (e) {
    logger.warn('asistencia.chofer_no_avisado', { incidencia: fila.id, err: e instanceof Error ? e.message : String(e) });
  }
  logger.info('asistencia.reconocida', { incidencia: fila.id, por: cuenta.userId, avisadoChofer: avisado });
  return avisado
    ? 'Anotado: la estás atendiendo ✅ — ya le avisé al chofer que vas.'
    : 'Anotado: la estás atendiendo ✅, pero NO le pude avisar al chofer por WhatsApp — márcale tú.';
}

// ── El lado de la OFICINA: el dueño que reporta sin ser chofer ─────────────

/**
 * Un ROJO escrito desde una cuenta de OFICINA (punto D del plano): el dueño
 * que choca sin viaje abierto. Sin esto, el analista le contesta como si
 * fuera una pregunta de negocio. Aquí NO se "avisa al jefe" — el que reporta
 * ES la oficina; lo que se necesita es que quede REGISTRADO (incidencia +
 * bitácora, visible en el panel) y una respuesta de emergencia, no de
 * negocio. La incidencia queda sin viaje ni operador: es del tenant.
 */
export async function atenderAsistenciaOficina(
  cuenta: CuentaReconoce,
  texto: string,
  asistencia: Asistencia,
  waMessageId?: string | null,
): Promise<string | null> {
  if (asistencia.nivel !== 'rojo') return null;   // ámbar de oficina no es de este circuito
  if (!cuenta.tenantId) return null;              // superadmin sin flota: nada que registrar

  const tipo = tipoDeAsistencia(texto, 'rojo');
  const hayLesionados = lesionadosSegunTexto(texto);

  // La "abierta de oficina": sin viaje ni operador. Un segundo mensaje de la
  // misma emergencia se anota como evento, no duplica la incidencia.
  let abiertaId: string | null = null;
  try {
    const { data, error } = await acotada(supabaseAdmin()
      .from('incidencia').select('id')
      .eq('tenant_id', cuenta.tenantId)
      .in('tipo', [...TIPOS_ASISTENCIA])
      .neq('estado', 'resuelta')
      .is('viaje_id', null).is('operador_id', null)
      .order('abierta_en', { ascending: false })
      .limit(1), 'asistencia.abiertaOficina');
    if (error) throw new Error(error.message);
    abiertaId = ((data ?? [])[0]?.id as string) ?? null;
  } catch (e) {
    logger.error('asistencia.oficina_abierta_ilegible', { tenant: cuenta.tenantId, err: e instanceof Error ? e.message : String(e) });
    return 'No pude registrar la emergencia ahorita 😕. Si hay lesionados marca 911 primero; el registro se puede hacer en el panel.';
  }

  if (abiertaId) {
    await anotarEventoIncidencia(cuenta.tenantId, abiertaId, 'mensaje_adicional', { texto: texto.slice(0, 500), de: 'oficina' }, waMessageId);
    return 'Anotado en la emergencia ya registrada 🚨 — el detalle queda en el panel.';
  }

  try {
    const incidenciaId = await crearIncidencia(cuenta.tenantId, {
      tipo,
      prioridad: 'critica',
      descripcion: texto.slice(0, 500),
      hayLesionados,
    });
    await anotarEventoIncidencia(cuenta.tenantId, incidenciaId, 'abierta', { nivel: 'rojo', tipo, de: 'oficina' }, waMessageId);
    logger.info('asistencia.oficina_abierta', { incidencia: incidenciaId, tipo, por: cuenta.userId });
  } catch (e) {
    logger.error('asistencia.oficina_crear_fallo', { tenant: cuenta.tenantId, err: e instanceof Error ? e.message : String(e) });
    return 'No pude registrar la emergencia ahorita 😕. Si hay lesionados marca 911 primero; el registro se puede hacer en el panel.';
  }
  return `Registrado como ${ROTULO_TIPO[tipo]} con prioridad crítica 🚨 — ya está en el panel de incidencias. Si hay lesionados marca 911 primero; el 800 de tu aseguradora está en tu póliza.`;
}
