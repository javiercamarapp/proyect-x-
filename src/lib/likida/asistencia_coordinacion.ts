import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { acotada } from './presupuesto';
import { strip_accents } from './cuadre/util';
import { variantesTelefono } from './conv';
import { telefonoJefeDe, telefonoDeUsuario } from './contactos';
import type { RolOficina } from './contactos';
import { sendText, sendButtons } from '@/lib/meta/client';
import { puedeAsignar } from '@/lib/auth/permisos';
import { mxn, hoyMx } from '@/lib/formato';
import { alertarOperador } from '@/lib/observability/alerta';
import { listarProveedoresEmergencia, telefonoE164Mx, type TipoProveedor } from './emergencias';
import { armarCascada, type ProveedorRecomendado } from './asistencia_proveedor';
import { anotarEventoIncidencia, cerrarCoordinacionesDeIncidencia, TIPOS_ASISTENCIA, type TipoAsistencia } from './asistencia_wa';
import { extraerMonto } from './talacha_wa';

// ═══════════════════════════════════════════════════════════════════════════
// COORDINACIÓN CON EL PROVEEDOR (Capa D del agente de ayuda en ruta, 0213).
//
// La Capa C recomienda; esta capa CONTACTA — con tres candados absolutos:
//
//  1. SOLO con autorización del jefe (botón `coo_ir:` del 🚨, o el comando
//     «contactar»). Sin ese acto, Likida jamás le escribe a un proveedor.
//  2. SOLO a un teléfono del directorio de la flota, y solo VERIFICADO — un
//     proveedor "SIN confirmar" se le deja al jefe, que sí puede marcar.
//  3. El dinero y el compromiso son del JEFE: la cotización del proveedor se
//     le presenta con botones y la confirmación es una firma atómica (el
//     UPDATE condicional `WHERE estado = 'cotizada'` — el patrón exacto del
//     circuito de talacha: gana un tap, el segundo recibe la verdad).
//
// ── EL HUECO DECLARADO: la plantilla de Meta ───────────────────────────────
// Iniciar una conversación de WhatsApp con quien no nos ha escrito exige una
// plantilla aprobada — y correr el script de plantillas es de la sección E
// (solo Javier). El circuito NO espera a eso: si Meta rechaza el mensaje, la
// coordinación queda `pendiente_plantilla` con el texto PREPARADO, el jefe lo
// recibe listo para reenviarlo él, y si el proveedor nos escribe (la ventana
// se abre), el mensaje sale en ese momento y el circuito sigue solo. El hueco
// es únicamente el disparo inicial, y siempre se dice.
//
// ── EL ETA ES EL QUE DIJO EL PROVEEDOR ─────────────────────────────────────
// Jamás se calcula ni se redondea a conveniencia: `eta_min` y `precio` solo
// se llenan si el texto los trae SIN ambigüedad (dos cifras distintas = no se
// adivina = NULL, mismo criterio que extraerMonto). La respuesta cruda del
// proveedor siempre se guarda y siempre es lo citable.
// ═══════════════════════════════════════════════════════════════════════════

function limpiar(texto: string): string {
  return strip_accents(texto.toLowerCase())
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── El parser conservador del ETA ──────────────────────────────────────────

/**
 * Minutos que el proveedor DIJO. Cerrado a las formas reales de contestar
 * ("40 min", "en una hora", "hora y media", "2 horas"); dos lecturas
 * distintas en el mismo texto = `null` (no se adivina cuál). El texto crudo
 * viaja aparte y es la verdad citable.
 */
export function leerEtaMin(texto: string): number | null {
  const t = limpiar(texto);
  // AUDITORÍA FABLE CICLO 4 (c4-7): el rango y la alternativa son AMBIGUOS
  // por definición — "de 40 a 50 minutos" no es 50, y "1 hora si acaso 2" no
  // es 60. Antes solo el número pegado a la unidad contaba y el otro se
  // ignoraba: el contrato ("dos cifras distintas = null") se violaba justo en
  // la forma más común de cotizar. Un número suelto adyacente a uno con
  // unidad (antes o después) también anula la lectura.
  if (/\b\d{1,3}\s*(?:a|o|u|-)\s*\d{1,3}\s*(?:min|mins|minutos|horas?|hrs?|hr)\b/.test(t)) return null;
  // La alternativa dicha DESPUÉS de la unidad ("1 hora si acaso 2", "2 horas
  // o 3"). Conectores en lista cerrada a propósito: un "cobro 1 500" tras el
  // "min" es un PRECIO (lo lee extraerMonto), no una segunda lectura de ETA.
  // Tras `limpiar` el espacio es SIEMPRE uno solo — espacios literales (sin
  // \s+ ni cuantificadores anidados: el ratchet de regex insegura tiene razón
  // en que aquí no hacen falta).
  if (/\b(?:min|mins|minutos|hr|hrs|hora|horas) (?:o|u|si acaso|a lo mucho|a lo mejor|hasta|maximo|quiza|quizas|igual y) (?:una |unas |como )?\d{1,2}\b/.test(t)) return null;
  const vistos = new Set<number>();
  for (const m of t.matchAll(/\b(\d{1,3})\s*(?:min|mins|minutos)\b/g)) {
    const n = Number(m[1]);
    if (n > 0) vistos.add(n);
  }
  for (const m of t.matchAll(/\b(\d{1,2})\s*(?:horas?|hrs?|hr)\b/g)) {
    const n = Number(m[1]);
    if (n > 0) vistos.add(n * 60);
  }
  if (/\bhora y media\b/.test(t)) vistos.add(90);
  if (/\bmedia hora\b/.test(t)) vistos.add(30);
  // "una hora" sin dígito — solo si ningún dígito ya lo dijo distinto.
  if (/\b(una|1) hora\b/.test(t)) vistos.add(60);
  if (vistos.size !== 1) return null;
  return [...vistos][0];
}

// ── El mensaje al proveedor (puro) ─────────────────────────────────────────

const SERVICIO_POR_TIPO: Record<TipoProveedor, string> = {
  grua: 'una grúa',
  llantera: 'un servicio de llantas',
  mecanico: 'un auxilio mecánico',
  medico: 'apoyo médico',
  otro: 'un auxilio en carretera',
};

export interface DatosMensajeProveedor {
  flota: string | null;
  tipoProveedor: TipoProveedor;
  unidad: string | null;
  lat: number | null;
  lng: number | null;
  telefonoJefe: string | null;
}

/**
 * El texto que se le manda al proveedor. Solo hechos que EXISTEN: sin
 * ubicación se dice que el jefe la comparte, sin unidad no se inventa placa.
 */
export function armarMensajeProveedor(d: DatosMensajeProveedor): string {
  const lineas = [
    `Le escribimos de ${d.flota ?? 'una flota que usa Likida'} 🚛 — necesitamos ${SERVICIO_POR_TIPO[d.tipoProveedor]}${d.unidad ? ` para la unidad ${d.unidad}` : ''}.`,
    d.lat != null && d.lng != null
      ? `Ubicación: https://maps.google.com/?q=${d.lat},${d.lng}`
      : 'La ubicación exacta se la comparte el jefe de tráfico al confirmar.',
    '¿Está disponible? Respóndanos por aquí con su tiempo de llegada y su precio.',
    d.telefonoJefe ? `Contacto directo del jefe de tráfico: ${d.telefonoJefe}.` : null,
  ].filter(Boolean);
  return lineas.join('\n');
}

// ── Los comandos del jefe ──────────────────────────────────────────────────

type ComandoCoordinacion =
  | { clase: 'iniciar_boton'; incidenciaId: string }
  | { clase: 'iniciar_palabra'; indice: number }
  | { clase: 'decidir'; coordinacionId: string; decision: 'confirmada' | 'descartada' };

/** `null` = el texto no es de este circuito y sigue su camino. Literales (no
 *  RegExp dinámicas): el mismo molde anclado de `tal_si:`/`asi_ok:`. */
export function leerComandoCoordinacion(texto: string): ComandoCoordinacion | null {
  const crudo = texto.trim();
  let m = /^coo_ir:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(crudo);
  if (m) return { clase: 'iniciar_boton', incidenciaId: m[1] };
  m = /^coo_(si|no):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(crudo);
  if (m) return { clase: 'decidir', coordinacionId: m[2], decision: m[1].toLowerCase() === 'si' ? 'confirmada' : 'descartada' };
  const p = /^contactar(?: ([1-9]))?$/.exec(limpiar(crudo));
  if (p) return { clase: 'iniciar_palabra', indice: p[1] ? Number(p[1]) : 1 };
  return null;
}

export interface CuentaCoordina {
  tenantId: string | null;
  rol: RolOficina;
  userId: string;
}

/**
 * El turno de OFICINA que puede ser de coordinación. `null` = no es de este
 * circuito (el processor sigue con despacho → informes → saludo).
 */
export async function atenderCoordinacionOficina(
  cuenta: CuentaCoordina,
  texto: string,
): Promise<string | null> {
  if (!texto?.trim()) return null;
  const cmd = leerComandoCoordinacion(texto);
  if (!cmd) return null;

  if (!cuenta.tenantId) return 'Esa emergencia no es de una flota tuya.';
  // El candado de rol ANTES de tocar nada — contactar proveedores compromete
  // a la flota: mismo perímetro que autorizar gastos de camino.
  if (!puedeAsignar(cuenta.rol)) {
    return 'Tu rol no coordina proveedores de camino — eso le toca al dueño o al jefe de tráfico.';
  }

  if (cmd.clase === 'decidir') {
    return decidirCotizacion(cuenta, cmd.coordinacionId, cmd.decision);
  }

  let incidenciaId: string;
  let indice = 1;
  if (cmd.clase === 'iniciar_boton') {
    incidenciaId = cmd.incidenciaId;
  } else {
    indice = cmd.indice;
    // Palabra sin id: solo si hay EXACTAMENTE una emergencia abierta. Con
    // cero se dice la verdad; con varias no se adivina cuál.
    const { data, error } = await acotada(supabaseAdmin()
      .from('incidencia').select('id')
      .eq('tenant_id', cuenta.tenantId)
      .in('tipo', [...TIPOS_ASISTENCIA])
      .neq('estado', 'resuelta')
      .limit(2), 'coordinacion.abiertasDeFlota');
    if (error) {
      logger.error('coordinacion.abiertas_ilegibles', { tenant: cuenta.tenantId, err: error.message });
      return 'No pude consultar las emergencias abiertas ahorita — inténtalo en un momento.';
    }
    const abiertas = data ?? [];
    if (abiertas.length === 0) return 'No tienes ninguna emergencia abierta que coordinar.';
    if (abiertas.length > 1) return 'Tienes varias emergencias abiertas — usa el botón «Contactar proveedor» del aviso de cada una para no confundirlas.';
    incidenciaId = abiertas[0].id as string;
  }
  return iniciarContacto(cuenta, incidenciaId, indice);
}

// ── Iniciar el contacto (la autorización del jefe) ─────────────────────────

interface IncidenciaCoordinable {
  id: string;
  tipo: TipoAsistencia;
  lat: number | null;
  lng: number | null;
  unidadId: string | null;
  operadorId: string | null;
}

async function leerIncidenciaCoordinable(
  tenantId: string, incidenciaId: string,
): Promise<IncidenciaCoordinable | string> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('incidencia')
    .select('id, tipo, estado, lat, lng, unidad_id, operador_id')
    .eq('id', incidenciaId).eq('tenant_id', tenantId)
    .maybeSingle(), 'coordinacion.incidencia');
  if (error) {
    logger.error('coordinacion.incidencia_ilegible', { incidencia: incidenciaId, err: error.message });
    return 'No pude leer esa emergencia ahorita — inténtalo en un momento.';
  }
  if (!data) return 'No encontré esa emergencia en tu flota.';
  const tipo = data.tipo as string;
  if (!(TIPOS_ASISTENCIA as readonly string[]).includes(tipo)) {
    return 'Esa incidencia no es una emergencia de asistencia — la coordinación de proveedores es solo para esas.';
  }
  // En robo/violencia NO se coordina nada: el protocolo mudo manda, igual que
  // en la cascada (un gruero despachado a un asalto es ruido peligroso).
  if (tipo === 'robo') {
    return 'En un robo o violencia NO contacto proveedores — coordina tú por fuera con la autoridad, y márcale al chofer solo cuando sepas que está seguro.';
  }
  if ((data.estado as string) === 'resuelta') return 'Esa emergencia ya está resuelta — no hay nada que coordinar.';
  return {
    id: data.id as string,
    tipo: tipo as TipoAsistencia,
    lat: data.lat == null ? null : Number(data.lat),
    lng: data.lng == null ? null : Number(data.lng),
    unidadId: (data.unidad_id as string) ?? null,
    operadorId: (data.operador_id as string) ?? null,
  };
}

/** Rótulos best-effort del mensaje al proveedor: son señas, no cifras. */
async function rotulosMensaje(tenantId: string, unidadId: string | null): Promise<{ flota: string | null; unidad: string | null; telefonoJefe: string | null }> {
  try {
    const admin = supabaseAdmin();
    const [rTenant, rUnidad, telefonoJefe] = await Promise.all([
      admin.from('tenant').select('nombre').eq('id', tenantId).maybeSingle(),
      unidadId
        ? admin.from('unidad').select('numero_economico, placas').eq('id', unidadId).eq('tenant_id', tenantId).maybeSingle()
        : Promise.resolve({ data: null }),
      telefonoJefeDe(tenantId).catch(() => null),
    ]);
    const u = rUnidad.data as { numero_economico?: string | null; placas?: string | null } | null;
    return {
      flota: (rTenant.data?.nombre as string) ?? null,
      unidad: u ? [u.numero_economico, u.placas].filter(Boolean).join(' · ') || null : null,
      telefonoJefe,
    };
  } catch (e) {
    logger.warn('coordinacion.rotulos_ilegibles', { tenant: tenantId, err: e instanceof Error ? e.message : String(e) });
    return { flota: null, unidad: null, telefonoJefe: null };
  }
}

/**
 * La autorización del jefe → el contacto. `indice` es la posición del
 * proveedor en la lista que el 🚨 le enseñó (la cascada se recalcula aquí con
 * el mismo motor — el nombre del elegido siempre viaja en la respuesta y en
 * la bitácora, así que no hay contacto "a ciegas").
 */
async function iniciarContacto(
  cuenta: CuentaCoordina, incidenciaId: string, indice: number,
): Promise<string> {
  const tenantId = cuenta.tenantId!;
  const inc = await leerIncidenciaCoordinable(tenantId, incidenciaId);
  if (typeof inc === 'string') return inc;

  let opciones: ProveedorRecomendado[];
  let proveedorIdPorTelefono: Map<string, string>;
  try {
    const proveedores = await listarProveedoresEmergencia(tenantId);
    const cascada = armarCascada({
      tipo: inc.tipo, lat: inc.lat, lng: inc.lng, proveedores, poliza: null, hoy: hoyMx(),
    });
    opciones = cascada.directorio.estado === 'con_opciones' ? cascada.directorio.opciones : [];
    proveedorIdPorTelefono = new Map(proveedores.map((p) => [p.telefono, p.id]));
  } catch (e) {
    logger.error('coordinacion.cascada_ilegible', { incidencia: incidenciaId, err: e instanceof Error ? e.message : String(e) });
    return 'No pude leer tu directorio de proveedores ahorita — inténtalo en un momento.';
  }

  if (opciones.length === 0) {
    return 'Tu directorio no tiene proveedores de este tipo de auxilio — captúralos en Emergencias, o marca tú al 800 de tu póliza.';
  }
  const elegido = opciones[indice - 1];
  if (!elegido) {
    return `Solo hay ${opciones.length} ${opciones.length === 1 ? 'proveedor' : 'proveedores'} en la lista del aviso — «contactar ${indice}» no apunta a ninguno.`;
  }
  // Candado: SOLO verificados. Al no confirmado le marca el jefe, no Likida.
  if (!elegido.verificado) {
    return `${elegido.nombre} está SIN confirmar en tu directorio — no le escribo yo. Márcale tú (${elegido.telefono}), o verifícalo en Emergencias y vuelve a intentar.`;
  }

  const rotulos = await rotulosMensaje(tenantId, inc.unidadId);
  const mensaje = armarMensajeProveedor({
    flota: rotulos.flota,
    tipoProveedor: elegido.tipo,
    unidad: rotulos.unidad,
    lat: inc.lat,
    lng: inc.lng,
    telefonoJefe: rotulos.telefonoJefe,
  });
  // A E.164 (c4-4): el directorio puede traer el número a 10 dígitos (lo que
  // el placeholder de captura invita) — así Meta lo rechaza y el rechazo se
  // diagnosticaba como "falta la plantilla". El snapshot y el envío van con
  // lada; el matching de la respuesta ya acepta ambas formas.
  const telefonoEnvio = telefonoE164Mx(elegido.telefono);

  // La fila nace ANTES del envío (pendiente_plantilla es el estado honesto de
  // "autorizado pero aún no sale"). El índice único resuelve la carrera de
  // dos jefes: gana exactamente uno y el segundo recibe la verdad.
  const { data: creada, error: errCrear } = await acotada(supabaseAdmin()
    .from('coordinacion_proveedor').insert({
      tenant_id: tenantId,
      incidencia_id: incidenciaId,
      proveedor_id: proveedorIdPorTelefono.get(elegido.telefono) ?? null,
      proveedor_nombre: elegido.nombre,
      proveedor_telefono: telefonoEnvio,
      autorizada_por: cuenta.userId,
      mensaje_preparado: mensaje,
    }).select('id').single(), 'coordinacion.crear');
  if (errCrear) {
    if (/coordinacion_viva_unica|duplicate key/i.test(errCrear.message)) {
      const { data: viva } = await acotada(supabaseAdmin()
        .from('coordinacion_proveedor').select('proveedor_nombre, estado')
        .eq('tenant_id', tenantId).eq('incidencia_id', incidenciaId)
        .neq('estado', 'descartada')
        .limit(1), 'coordinacion.viva');
      const v = (viva ?? [])[0] as { proveedor_nombre: string; estado: string } | undefined;
      return v
        ? (v.estado === 'confirmada'
          ? `Ya hay un proveedor CONFIRMADO para esta emergencia (${v.proveedor_nombre}) — no contacto a un segundo.`
          : `Ya hay una gestión en curso con ${v.proveedor_nombre} para esta emergencia — te paso su respuesta en cuanto llegue.`)
        : 'Ya hay una gestión en curso para esta emergencia.';
    }
    logger.error('coordinacion.crear_fallo', { incidencia: incidenciaId, err: errCrear.message });
    return 'No pude iniciar el contacto ahorita — inténtalo en un momento.';
  }
  const coordinacionId = (creada as { id: string }).id;
  await anotarEventoIncidencia(tenantId, incidenciaId, 'coordinacion_autorizada', {
    coordinacionId, proveedor: elegido.nombre, telefono: elegido.telefono, por: cuenta.userId,
  });

  // El envío. El sello `contactado` SOLO tras aceptación de Meta (lección
  // c2-1); el rechazo (ventana de 24 h cerrada — falta la plantilla) deja el
  // estado honesto y al jefe con el texto listo para reenviarlo él.
  const enviado = await sendText(telefonoEnvio, mensaje);
  if (enviado) {
    const { error: errSello } = await acotada(supabaseAdmin()
      .from('coordinacion_proveedor')
      .update({ estado: 'contactado', contactado_en: new Date().toISOString() })
      .eq('id', coordinacionId).eq('tenant_id', tenantId)
      .eq('estado', 'pendiente_plantilla'), 'coordinacion.sellarContacto');
    if (errSello) logger.warn('coordinacion.contacto_no_sellado', { coordinacion: coordinacionId, err: errSello.message });
    await anotarEventoIncidencia(tenantId, incidenciaId, 'contacto_enviado', { coordinacionId, proveedor: elegido.nombre });
    logger.info('coordinacion.contactado', { coordinacion: coordinacionId, incidencia: incidenciaId });
    return `Le escribí a ${elegido.nombre} ✅ — en cuanto responda con tiempo y precio, te lo paso con botones para confirmar.`;
  }
  await anotarEventoIncidencia(tenantId, incidenciaId, 'contacto_pendiente_plantilla', { coordinacionId, proveedor: elegido.nombre });
  logger.info('coordinacion.pendiente_plantilla', { coordinacion: coordinacionId, incidencia: incidenciaId });
  return (
    `No puedo iniciar yo la conversación con ${elegido.nombre} todavía — WhatsApp exige una plantilla aprobada que está pendiente de configuración. ` +
    `Aquí está el mensaje listo para que se lo reenvíes tú a ${telefonoEnvio}:\n\n${mensaje}\n\n` +
    `Si el proveedor nos escribe a este número, yo sigo la gestión desde ahí.`
  );
}

// ── La decisión del jefe sobre la cotización (la firma) ────────────────────

async function decidirCotizacion(
  cuenta: CuentaCoordina, coordinacionId: string, decision: 'confirmada' | 'descartada',
): Promise<string> {
  const tenantId = cuenta.tenantId!;
  // Candado (c4-3): la firma solo opera sobre una emergencia VIVA. El tap del
  // backlog del jefe sobre una cotización de una incidencia ya resuelta
  // comprometía dinero y despachaba un proveedor a una emergencia muerta —
  // cinturón y tirantes con el cierre de coordinaciones al resolver (c4-2).
  try {
    const { data: coo, error: errCoo } = await acotada(supabaseAdmin()
      .from('coordinacion_proveedor').select('incidencia_id')
      .eq('id', coordinacionId).eq('tenant_id', tenantId)
      .maybeSingle(), 'coordinacion.incidenciaDe');
    if (errCoo) throw new Error(errCoo.message);
    const incidenciaId = (coo?.incidencia_id as string) ?? null;
    if (incidenciaId) {
      const { data: inc, error: errInc } = await acotada(supabaseAdmin()
        .from('incidencia').select('estado')
        .eq('id', incidenciaId).eq('tenant_id', tenantId)
        .maybeSingle(), 'coordinacion.estadoIncidencia');
      if (errInc) throw new Error(errInc.message);
      if ((inc?.estado as string) === 'resuelta') {
        await cerrarCoordinacionesDeIncidencia(tenantId, incidenciaId, 'incidencia_ya_resuelta');
        return 'Esa emergencia ya está resuelta — no confirmé ni desperté nada. La gestión quedó cerrada en el expediente.';
      }
    }
  } catch (e) {
    // Sin lectura no se firma: comprometer dinero sin saber si la emergencia
    // vive sería exactamente el bug que este candado tapa.
    logger.error('coordinacion.candado_ilegible', { coordinacion: coordinacionId, err: e instanceof Error ? e.message : String(e) });
    return 'No pude verificar el estado de la emergencia — inténtalo de nuevo en un momento.';
  }
  const { data, error } = await acotada(supabaseAdmin()
    .from('coordinacion_proveedor')
    .update({ estado: decision, decidida_por: cuenta.userId, decidida_en: new Date().toISOString() })
    .eq('id', coordinacionId).eq('tenant_id', tenantId)
    .eq('estado', 'cotizada')  // la firma atómica: exactamente un ganador
    .select('id, incidencia_id, proveedor_nombre, proveedor_telefono, eta_min, precio, respuesta_cruda'),
  'coordinacion.decidir');
  if (error) {
    logger.error('coordinacion.decidir_fallo', { coordinacion: coordinacionId, err: error.message });
    return 'No pude registrar tu decisión ahorita — inténtalo de nuevo en un momento.';
  }
  const fila = (data ?? [])[0] as {
    id: string; incidencia_id: string; proveedor_nombre: string; proveedor_telefono: string;
    eta_min: number | null; precio: unknown; respuesta_cruda: string | null;
  } | undefined;
  if (!fila) {
    const { data: existente, error: errLee } = await acotada(supabaseAdmin()
      .from('coordinacion_proveedor').select('estado, proveedor_nombre')
      .eq('id', coordinacionId).eq('tenant_id', tenantId)
      .maybeSingle(), 'coordinacion.releer');
    if (errLee) return 'No pude registrar tu decisión ahorita — inténtalo de nuevo en un momento.';
    if (!existente) return 'No encontré esa gestión en tu flota.';
    const estado = existente.estado as string;
    if (estado === 'confirmada') return `Esa cotización ya estaba confirmada — no cambié nada.`;
    if (estado === 'descartada') return `Esa cotización ya estaba descartada — no cambié nada.`;
    return `${existente.proveedor_nombre} aún no manda su cotización — te la paso en cuanto llegue.`;
  }

  const precio = fila.precio == null ? null : Number(fila.precio);
  await anotarEventoIncidencia(tenantId, fila.incidencia_id,
    decision === 'confirmada' ? 'cotizacion_confirmada' : 'cotizacion_descartada',
    { coordinacionId, proveedor: fila.proveedor_nombre, etaMin: fila.eta_min, precio, por: cuenta.userId });

  if (decision === 'descartada') {
    // Al proveedor se le dice la verdad, sin promesas. Best-effort: la
    // decisión YA está firmada aunque este aviso no salga.
    try {
      await sendText(fila.proveedor_telefono, 'Gracias por responder — por ahora no vamos a tomar el servicio. Buen día. 🙏');
    } catch (e) {
      logger.warn('coordinacion.descarte_no_avisado', { coordinacion: coordinacionId, err: e instanceof Error ? e.message : String(e) });
    }
    return `Descartada ❌ la cotización de ${fila.proveedor_nombre}. Puedes contactar a otro de la lista con el botón del aviso o escribiendo «contactar 2».`;
  }

  // Confirmada: se cierra el loop — proveedor y chofer se enteran. El ETA que
  // se le dice al chofer es EL QUE DIJO el proveedor, con sus palabras cuando
  // no se pudo leer un número sin ambigüedad.
  const okProveedor = Boolean(await sendText(fila.proveedor_telefono,
    `Confirmado ✅ — adelante con el servicio${precio !== null ? ` en ${mxn(precio)}` : ''}. Cualquier cambio, escríbanos por aquí.`));

  let okChofer = false;
  try {
    const { data: inc } = await acotada(supabaseAdmin()
      .from('incidencia').select('operador_id')
      .eq('id', fila.incidencia_id).eq('tenant_id', tenantId)
      .maybeSingle(), 'coordinacion.incidenciaChofer');
    const operadorId = (inc?.operador_id as string) ?? null;
    if (operadorId) {
      const { data: op } = await acotada(supabaseAdmin()
        .from('operador').select('telefono')
        .eq('id', operadorId).eq('tenant_id', tenantId)
        .maybeSingle(), 'coordinacion.telefonoChofer');
      if (op?.telefono) {
        const eta = fila.eta_min != null
          ? `dice que llega en ~${fila.eta_min} min`
          : (fila.respuesta_cruda ? `dijo: «${fila.respuesta_cruda.replace(/\s+/g, ' ').trim().slice(0, 120)}»` : 'va en camino');
        okChofer = Boolean(await sendText(op.telefono as string,
          `Ayuda confirmada 🛠️ — ${fila.proveedor_nombre} ${eta}. Sigue aquí por cualquier cambio.`));
      }
    }
  } catch (e) {
    logger.warn('coordinacion.chofer_no_avisado', { coordinacion: coordinacionId, err: e instanceof Error ? e.message : String(e) });
  }
  await anotarEventoIncidencia(tenantId, fila.incidencia_id, 'chofer_avisado_proveedor', {
    coordinacionId, avisado: okChofer,
  });
  logger.info('coordinacion.confirmada', { coordinacion: coordinacionId, okProveedor, okChofer, precio });

  const partes = [
    `Confirmado ✅ con ${fila.proveedor_nombre}${precio !== null ? ` por ${mxn(precio)} (queda firmado con tu confirmación)` : ''}.`,
    okProveedor ? 'Ya le avisé al proveedor.' : 'NO le pude avisar al proveedor por WhatsApp — márcale tú para cerrarlo.',
    okChofer ? 'Al chofer ya le dije que va en camino.' : 'NO le pude avisar al chofer — márcale tú.',
  ];
  return partes.join(' ');
}

// ── El lado del PROVEEDOR: su respuesta cierra o avanza la gestión ─────────

interface CoordinacionActiva {
  id: string;
  tenantId: string;
  incidenciaId: string;
  estado: string;
  proveedorNombre: string;
  mensajePreparado: string;
  /** Quién autorizó ESTE contacto (`app_user.id`) — AUDITORÍA 28, AG-A4: el
   *  destinatario primario de la cotización y de los mensajes adicionales. */
  autorizadaPor: string | null;
}

/**
 * El destinatario del aviso de una gestión con proveedor: PRIMERO quien
 * autorizó el contacto (si sigue activo y tiene teléfono capturado) — es su
 * dinero y su compromiso, y es a él a quien se le prometió «te lo paso con
 * botones para confirmar». Solo si eso ya no es posible (dado de baja, sin
 * teléfono, o la lectura falla) cae al jefe por ROL — el destinatario de
 * ANTES del arreglo, que podía ser una persona distinta de quien autorizó.
 */
async function destinatarioAvisoCoordinacion(tenantId: string, autorizadaPor: string | null): Promise<string | null> {
  if (autorizadaPor) {
    try {
      const directo = await telefonoDeUsuario(autorizadaPor, tenantId);
      if (directo) return directo;
    } catch (e) {
      logger.warn('coordinacion.autorizada_por_ilegible', { tenant: tenantId, autorizadaPor, err: e instanceof Error ? e.message : String(e) });
    }
  }
  return telefonoJefeDe(tenantId);
}

/**
 * Las gestiones VIVAS de un teléfono: no descartadas Y de una incidencia no
 * resuelta (c4-2/c4-3 — una gestión de una emergencia muerta no debe capturar
 * los mensajes de ese número para siempre). Las que quedaron huérfanas de una
 * incidencia ya resuelta se cierran aquí mismo, de paso (autolimpieza de filas
 * de antes del cierre-al-resolver). Lanza ante lectura ilegible.
 */
async function activasDeTelefono(from: string): Promise<CoordinacionActiva[]> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('coordinacion_proveedor')
    .select('id, tenant_id, incidencia_id, estado, proveedor_nombre, mensaje_preparado, autorizada_por')
    .in('proveedor_telefono', variantesTelefono(from))
    .neq('estado', 'descartada')
    .order('created_at', { ascending: false })
    .limit(3), 'coordinacion.porTelefono');
  if (error) throw new Error(error.message);
  const todas: CoordinacionActiva[] = (data ?? []).map((f) => ({
    id: f.id as string,
    tenantId: f.tenant_id as string,
    incidenciaId: f.incidencia_id as string,
    estado: f.estado as string,
    proveedorNombre: f.proveedor_nombre as string,
    mensajePreparado: f.mensaje_preparado as string,
    autorizadaPor: (f.autorizada_por as string) ?? null,
  }));
  if (todas.length === 0) return todas;
  const { data: incs, error: errInc } = await acotada(supabaseAdmin()
    .from('incidencia').select('id, estado')
    .in('tenant_id', [...new Set(todas.map((c) => c.tenantId))])
    .in('id', [...new Set(todas.map((c) => c.incidenciaId))]), 'coordinacion.incidenciasVivas');
  if (errInc) throw new Error(errInc.message);
  const resueltas = new Set((incs ?? []).filter((i) => i.estado === 'resuelta').map((i) => i.id as string));
  const vivas = todas.filter((c) => !resueltas.has(c.incidenciaId));
  for (const muerta of todas.filter((c) => resueltas.has(c.incidenciaId))) {
    await cerrarCoordinacionesDeIncidencia(muerta.tenantId, muerta.incidenciaId, 'incidencia_ya_resuelta');
  }
  return vivas;
}

/**
 * El turno de un número DESCONOCIDO que puede ser un proveedor contactado.
 * `null` = este teléfono no tiene ninguna gestión viva y el processor sigue
 * su camino ("no te tengo registrado"). La rama es SOLO por teléfono-de-
 * proveedor-con-gestión-viva: no toca el camino del chofer ni el de oficina.
 */
export async function atenderMensajeProveedor(
  from: string,
  texto: string,
): Promise<string | null> {
  if (!texto?.trim()) return null;
  let activas: CoordinacionActiva[];
  try {
    activas = await activasDeTelefono(from);
  } catch (e) {
    // Fail-closed en la ATRIBUCIÓN, no en la respuesta: sin lectura no se
    // afirma que el número no es de nadie — pero tampoco se le contesta como
    // proveedor a quien quizá no lo es. El processor sigue su camino.
    logger.error('coordinacion.telefono_ilegible', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
  if (activas.length === 0) return null;

  if (activas.length > 1) {
    // Dos gestiones vivas con el mismo teléfono (dos emergencias, o dos
    // flotas con el mismo gruero): no se adivina a cuál contesta. El texto
    // crudo va a la bitácora y al jefe de CADA una — que el humano atribuya.
    for (const c of activas) {
      await anotarEventoIncidencia(c.tenantId, c.incidenciaId, 'proveedor_mensaje', {
        coordinacionId: c.id, texto: texto.slice(0, 500), atribucion: 'ambigua',
      });
      try {
        const jefe = await telefonoJefeDe(c.tenantId);
        if (jefe) {
          await sendText(jefe, `${c.proveedorNombre} escribió (tenemos más de una gestión activa con su número — atribúyelo tú):\n«${texto.replace(/\s+/g, ' ').trim().slice(0, 220)}»`);
        }
      } catch { /* best-effort declarado: la bitácora ya lo tiene */ }
    }
    return 'Gracias — tenemos más de una solicitud activa con este número, así que el jefe de tráfico le da seguimiento directo.';
  }

  const c = activas[0];

  // La ventana ACABA de abrirse: si el contacto seguía pendiente de
  // plantilla, el mensaje preparado sale AHORA — el circuito se autorrepara
  // en cuanto el proveedor nos escribe.
  if (c.estado === 'pendiente_plantilla') {
    const enviado = await sendText(from, c.mensajePreparado);
    if (enviado) {
      const { error } = await acotada(supabaseAdmin()
        .from('coordinacion_proveedor')
        .update({ estado: 'contactado', contactado_en: new Date().toISOString() })
        .eq('id', c.id).eq('tenant_id', c.tenantId)
        .eq('estado', 'pendiente_plantilla'), 'coordinacion.contactoTardio');
      if (error) logger.warn('coordinacion.contacto_tardio_no_sellado', { coordinacion: c.id, err: error.message });
      await anotarEventoIncidencia(c.tenantId, c.incidenciaId, 'contacto_enviado', {
        coordinacionId: c.id, proveedor: c.proveedorNombre, via: 'ventana_abierta_por_proveedor',
      });
      c.estado = 'contactado';
    }
  }

  if (c.estado === 'contactado') {
    // Su primer mensaje de fondo es la cotización: crudo SIEMPRE; cifras solo
    // sin ambigüedad. El avance es atómico (WHERE contactado) — la reentrega
    // del webhook no cotiza dos veces.
    const etaMin = leerEtaMin(texto);
    const precio = extraerMonto(texto);
    const { data, error } = await acotada(supabaseAdmin()
      .from('coordinacion_proveedor')
      .update({
        estado: 'cotizada',
        respuesta_cruda: texto.slice(0, 1000),
        cotizada_en: new Date().toISOString(),
        eta_min: etaMin,
        precio,
      })
      .eq('id', c.id).eq('tenant_id', c.tenantId)
      .eq('estado', 'contactado')
      .select('id'), 'coordinacion.cotizar');
    if (error) {
      logger.error('coordinacion.cotizar_fallo', { coordinacion: c.id, err: error.message });
      return 'Recibimos su mensaje — en un momento le confirmamos.';
    }
    if (((data ?? []).length) === 0) {
      // Perdió la carrera contra otra entrega del mismo turno: la ganadora ya
      // avisó al jefe. No se repite el aviso ni se pisa la cotización.
      return 'Recibimos su mensaje — el jefe de tráfico le confirma en breve. 🙏';
    }
    await anotarEventoIncidencia(c.tenantId, c.incidenciaId, 'cotizacion_recibida', {
      coordinacionId: c.id, proveedor: c.proveedorNombre, etaMin, precio, texto: texto.slice(0, 500),
    });
    // AUDITORÍA 28, ALTO (AG-A4): el destinatario primario es quien AUTORIZÓ
    // este contacto (`c.autorizadaPor`), no el jefe por rol — si el dueño
    // autorizó, la cotización con los botones de confirmar es SU decisión.
    let avisadoJefe = false;
    try {
      const jefe = await destinatarioAvisoCoordinacion(c.tenantId, c.autorizadaPor);
      if (jefe) {
        const cuerpo =
          `${c.proveedorNombre} respondió sobre la emergencia:\n«${texto.replace(/\s+/g, ' ').trim().slice(0, 220)}»\n\n` +
          `Tiempo leído: ${etaMin != null ? `~${etaMin} min` : 'no claro (léelo arriba)'} · ` +
          `Precio leído: ${precio != null ? mxn(precio) : 'no claro (léelo arriba)'}\n\n` +
          `¿Confirmas el servicio? Tu confirmación queda firmada.`;
        avisadoJefe = Boolean(await sendButtons(jefe, cuerpo, [
          { id: `coo_si:${c.id}`, titulo: 'Confirmar' },
          { id: `coo_no:${c.id}`, titulo: 'Descartar' },
        ]));
      }
    } catch (e) {
      logger.warn('coordinacion.jefe_no_avisado', { coordinacion: c.id, err: e instanceof Error ? e.message : String(e) });
    }
    // AUDITORÍA 28, ALTO (AG-A4): si el aviso NO salió, nadie se enteraba —
    // ni un `warn`, ni la bitácora, ni el operador de Likida. Ahora los tres
    // se enteran, y al proveedor no se le promete un «confirma en breve» que
    // nadie va a cumplir porque nadie recibió la cotización.
    if (!avisadoJefe) {
      logger.warn('coordinacion.cotizacion_no_avisada', { coordinacion: c.id, incidencia: c.incidenciaId, tenant: c.tenantId });
      await anotarEventoIncidencia(c.tenantId, c.incidenciaId, 'cotizacion_no_avisada', {
        coordinacionId: c.id, proveedor: c.proveedorNombre, etaMin, precio,
      });
      await alertarOperador('coordinacion.cotizacion_no_avisada', {
        error: `Cotización de ${c.proveedorNombre} (tenant ${c.tenantId}, incidencia ${c.incidenciaId}) llegó y NADIE fue avisado por WhatsApp.`,
        codigo: 'cotizacion_no_avisada',
      });
    }
    logger.info('coordinacion.cotizada', { coordinacion: c.id, etaMin, precio, avisadoJefe });
    return avisadoJefe
      ? 'Gracias — le pasé su tiempo y precio al jefe de tráfico; le confirmamos en breve. 🙏'
      : 'Gracias — quedó registrado y se le va a contactar.';
  }

  // cotizada (mensaje adicional antes de la decisión) o confirmada (avisos de
  // camino: "ya voy llegando"): bitácora + reenvío al jefe — en una
  // emergencia el jefe quiere cada mensaje, y aquí no se decide nada solo.
  await anotarEventoIncidencia(c.tenantId, c.incidenciaId, 'proveedor_mensaje', {
    coordinacionId: c.id, texto: texto.slice(0, 500),
  });
  let reenviado = false;
  try {
    // AUDITORÍA 28, ALTO (AG-A4): mismo destinatario primario que la
    // cotización — quien autorizó el contacto, no el jefe por rol.
    const jefe = await destinatarioAvisoCoordinacion(c.tenantId, c.autorizadaPor);
    if (jefe) {
      reenviado = Boolean(await sendText(jefe, `${c.proveedorNombre} escribió:\n«${texto.replace(/\s+/g, ' ').trim().slice(0, 220)}»`));
    }
  } catch (e) {
    logger.warn('coordinacion.adicional_no_reenviado', { coordinacion: c.id, err: e instanceof Error ? e.message : String(e) });
  }
  logger.info('coordinacion.proveedor_mensaje', { coordinacion: c.id, estado: c.estado, reenviado });
  return reenviado
    ? 'Anotado — se lo pasé al jefe de tráfico. 🙏'
    : 'Anotado. El jefe de tráfico le da seguimiento.';
}

/**
 * El medio SIN TEXTO (audio, foto, ubicación, documento) de un número con
 * gestión viva — AUDITORÍA FABLE CICLO 4 (c4-5): el gruero carretero contesta
 * con nota de voz como medio México, y recibía "no te tengo registrado como
 * operador" con la cotización en la mano. La transcripción E1 es SOLO para
 * choferes a propósito (presupuesto del tenant, léxico de emergencia); aquí
 * el mínimo honesto: pedirle el texto y dejar constancia en el expediente.
 * `null` = sin gestión viva y el processor sigue su camino.
 */
export async function atenderMedioProveedorSinTexto(
  from: string,
  tipoMsg: string,
): Promise<string | null> {
  let activas: CoordinacionActiva[];
  try {
    activas = await activasDeTelefono(from);
  } catch (e) {
    logger.error('coordinacion.telefono_ilegible', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
  if (activas.length === 0) return null;
  for (const c of activas) {
    await anotarEventoIncidencia(c.tenantId, c.incidenciaId, 'proveedor_mensaje', {
      coordinacionId: c.id, sinTexto: true, tipo: tipoMsg,
    });
  }
  logger.info('coordinacion.proveedor_medio_sin_texto', { tipo: tipoMsg, gestiones: activas.length });
  return '¿Me lo escribe por texto, por favor? 🙏 Así le paso su tiempo y precio tal cual al jefe de tráfico.';
}
