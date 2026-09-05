import { supabaseAdmin } from '@/lib/supabase/admin';
import { anotarBitacora } from '@/lib/likida/bitacora_escritura';
import { acotada } from '@/lib/likida/presupuesto';
import { DatoInvalido } from '@/lib/likida/errores';
import { esUuidValido } from '@/lib/likida/intake/cfdi';
import { enviarCorreo } from '@/lib/correo/enviar';
import { avisoInvitacion } from '@/lib/correo/avisos';
import { logger } from '@/lib/logger';
import { ROLES_INVITABLES, type RolInvitable } from './invitar';
import { nombreDeRol } from './roles';

// ═══════════════════════════════════════════════════════════════════════════
// GESTIÓN DEL EQUIPO DE UNA FLOTA — cambiar rol, dar de baja, reactivar,
// reenviar el acceso. Auditoría 24: SEG-1 (ALTO) + H5.
//
// Hasta hoy `/dashboard/usuarios` solo INVITABA. La pantalla decía, textual:
// «Cambiarle el rol a alguien o darlo de baja desde aquí todavía no existe».
// El contador externo que dejó de trabajar con la flota conservaba su cookie
// (400 días) y sus permisos, y la flota no tenía con qué cortarlo — los
// términos le cargan a la empresa «dar de baja a quien deja de trabajar ahí».
//
// ── LAS REGLAS QUE ESTE MÓDULO NO DEJA ROMPER ─────────────────────────────
//  · El `tenantId` viene de la SESIÓN, por argumento: todo UPDATE va anclado
//    a `tenant_id` y comprueba las filas devueltas (patrón `editarCliente`).
//    Con el id de alguien de OTRA flota toca cero filas y se dice.
//  · Un superadmin (fila con `rol = 'superadmin'`) NO se toca desde el panel
//    del cliente: no pertenece a la flota. Se rechaza aunque comparta tenant.
//  · Nadie se cambia el rol a sí mismo ni se da de baja a sí mismo: el dueño
//    que se degrada o se desactiva deja la cuenta sin quien la administre.
//  · El ÚLTIMO dueño activo de la flota no se degrada ni se da de baja por la
//    misma razón — una flota sin flota_admin es una flota que ya nadie puede
//    operar desde el panel, y arreglarlo exige a Likida.
//  · Los roles asignables son EXACTAMENTE los invitables (`ROLES_INVITABLES`):
//    `superadmin` y `operador` no se reparten desde aquí, ni por POST directo.
//
// ── LA BAJA ES DE VERDAD, EN TRES CAPAS ───────────────────────────────────
//  1. `app_user.activo = false` (0294) → `session.ts` devuelve null y las
//     cuatro funciones de RLS filtran `and activo`: panel y base cierran en
//     la siguiente petición, aunque el JWT siga vigente.
//  2. BAN en Supabase Auth (`updateUserById({ ban_duration })`): es lo que
//     mata el REFRESH del token — la cookie de 400 días muere en la siguiente
//     hora y la persona no puede pedir otro enlace mágico. El SDK no ofrece
//     «signOut por userId» (solo por JWT, que no tenemos), así que el ban es
//     la revocación real disponible; reactivar lo levanta (`'none'`).
//  3. Bitácora por acción, con quién y a quién. La baja SIN rastro era la
//     mitad del hallazgo.
// ═══════════════════════════════════════════════════════════════════════════

/** Un ban «para siempre» en la unidad que GoTrue entiende (100 años). */
export const BAN_PERMANENTE = '876600h';

export interface ActorEquipo {
  id: string;
  email?: string | null;
}

export interface UsuarioObjetivo {
  id: string;
  email: string;
  nombre: string | null;
  rol: string;
  activo: boolean;
}

function exigirUuid(usuarioId: string): void {
  if (!esUuidValido(usuarioId)) throw new DatoInvalido('No se reconoce esa cuenta. Vuelve a abrir la pantalla.');
}

function esRolAsignable(v: string): v is RolInvitable {
  return ROLES_INVITABLES.some((r) => r.valor === v);
}

/**
 * La fila objetivo, ANCLADA a la flota de la sesión. Un id ajeno o inexistente
 * es el mismo «no está en tu equipo»: distinguirlos le diría a quien prueba
 * ids cuáles existen en otra flota.
 */
async function leerObjetivo(tenantId: string, usuarioId: string): Promise<UsuarioObjetivo> {
  const { data, error } = await acotada(supabaseAdmin().from('app_user')
    .select('id, email, nombre, rol, activo')
    .eq('id', usuarioId)
    .eq('tenant_id', tenantId)
    .maybeSingle(), 'equipo.leerObjetivo');
  if (error) throw new Error(`equipo.leerObjetivo: ${error.message}`);
  if (!data) throw new DatoInvalido('Esa cuenta no está en tu equipo. Recarga la pantalla.');
  if (data.rol === 'superadmin') {
    throw new DatoInvalido('Esa cuenta es de Likida, no de tu flota: no se administra desde aquí.');
  }
  return {
    id: String(data.id),
    email: String(data.email),
    nombre: (data.nombre as string | null) ?? null,
    rol: String(data.rol),
    // Solo el `false` explícito es baja (base sin la 0294 → todos activos).
    activo: data.activo !== false,
  };
}

/** Cuántos dueños ACTIVOS quedan en la flota sin contar a `excluir`. `count`
 *  real, no `.length` de una lista topada. */
async function otrosDuenosActivos(tenantId: string, excluir: string): Promise<number> {
  const { count, error } = await acotada(supabaseAdmin().from('app_user')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('rol', 'flota_admin')
    .eq('activo', true)
    .neq('id', excluir), 'equipo.duenosActivos');
  if (error) throw new Error(`equipo.duenosActivos: ${error.message}`);
  return count ?? 0;
}

async function anotar(
  tenantId: string,
  accion: string,
  usuarioId: string,
  detalle: Record<string, unknown>,
  actor: ActorEquipo,
): Promise<void> {
  await anotarBitacora(
    { tenantId, actor: { id: actor.id, email: actor.email ?? null }, accion, entidad: 'app_user', entidadId: usuarioId, detalle },
    { evento: 'equipo.bitacora_no_escribio', contexto: { usuario: usuarioId } },
  );
}

/**
 * Cambia el rol de alguien del equipo. El UPDATE va anclado al rol ACTUAL
 * leído (optimista): si otro dueño lo cambió entre la lectura y el update,
 * toca cero filas y se pide recargar en vez de pisar en silencio.
 */
export async function cambiarRolUsuario(
  tenantId: string,
  usuarioId: string,
  rolNuevo: string,
  actor: ActorEquipo,
): Promise<{ de: string; a: RolInvitable }> {
  exigirUuid(usuarioId);
  if (!esRolAsignable(rolNuevo)) {
    throw new DatoInvalido('Elige el rol de la lista: contador, encargado o dueño. Ningún otro se asigna desde el panel.');
  }
  if (usuarioId === actor.id) {
    throw new DatoInvalido('No puedes cambiarte el rol a ti mismo: pídeselo a otro dueño de la flota.');
  }
  const objetivo = await leerObjetivo(tenantId, usuarioId);
  if (!objetivo.activo) throw new DatoInvalido('Esa cuenta está dada de baja. Reactívala primero si quieres cambiarle el rol.');
  if (objetivo.rol === rolNuevo) throw new DatoInvalido(`Esa cuenta ya es ${nombreDeRol(rolNuevo)}.`);
  if (objetivo.rol === 'flota_admin' && (await otrosDuenosActivos(tenantId, usuarioId)) === 0) {
    throw new DatoInvalido('Es el único dueño activo de la flota: nombra a otro dueño antes de cambiarle el rol.');
  }

  const { data, error } = await acotada(supabaseAdmin().from('app_user')
    .update({ rol: rolNuevo })
    .eq('id', usuarioId)
    .eq('tenant_id', tenantId)
    .eq('rol', objetivo.rol)
    .select('id'), 'equipo.cambiarRol');
  if (error) throw new Error(`equipo.cambiarRol: ${error.message}`);
  if (!Array.isArray(data) || data.length === 0) {
    throw new DatoInvalido('El rol de esa cuenta cambió mientras tanto. Recarga la pantalla y vuelve a intentarlo.');
  }

  await anotar(tenantId, 'usuario.rol_cambiado', usuarioId, { de: objetivo.rol, a: rolNuevo }, actor);
  return { de: objetivo.rol, a: rolNuevo };
}

export interface ResultadoBaja {
  /** `true` si Auth aceptó el ban (el refresh del token muere). `false` = la
   *  fila quedó desactivada (panel y RLS cerrados) pero el ban no entró: la
   *  pantalla lo dice para que alguien lo reintente, no lo esconde. */
  sesionRevocada: boolean;
}

/**
 * Da de baja: `activo = false` + ban en Auth + bitácora. NO borra la fila.
 */
export async function desactivarUsuario(
  tenantId: string,
  usuarioId: string,
  actor: ActorEquipo,
): Promise<ResultadoBaja> {
  exigirUuid(usuarioId);
  if (usuarioId === actor.id) {
    throw new DatoInvalido('No puedes darte de baja a ti mismo: pídeselo a otro dueño de la flota.');
  }
  const objetivo = await leerObjetivo(tenantId, usuarioId);
  if (!objetivo.activo) throw new DatoInvalido('Esa cuenta ya está dada de baja.');
  if (objetivo.rol === 'flota_admin' && (await otrosDuenosActivos(tenantId, usuarioId)) === 0) {
    throw new DatoInvalido('Es el único dueño activo de la flota: nombra a otro dueño antes de darlo de baja.');
  }

  const { data, error } = await acotada(supabaseAdmin().from('app_user')
    .update({ activo: false, desactivado_en: new Date().toISOString(), desactivado_por: actor.id })
    .eq('id', usuarioId)
    .eq('tenant_id', tenantId)
    // Dos clics no pisan el sello original de la baja.
    .eq('activo', true)
    .select('id'), 'equipo.desactivar');
  if (error) throw new Error(`equipo.desactivar: ${error.message}`);
  if (!Array.isArray(data) || data.length === 0) {
    throw new DatoInvalido('Esa cuenta ya no estaba activa. Recarga la pantalla.');
  }

  // La revocación REAL: sin el ban, la cookie sigue refrescándose cada hora
  // hasta 400 días. Best-effort DESPUÉS de la fila (la fila ya cerró panel y
  // RLS); si falla, se dice — no se finge.
  let sesionRevocada = true;
  try {
    const { error: errBan } = await supabaseAdmin().auth.admin.updateUserById(usuarioId, { ban_duration: BAN_PERMANENTE });
    if (errBan) {
      sesionRevocada = false;
      logger.error('equipo.ban_fallo', { usuario: usuarioId, err: errBan.message });
    }
  } catch (e) {
    sesionRevocada = false;
    logger.error('equipo.ban_fallo', { usuario: usuarioId, err: e instanceof Error ? e.message : String(e) });
  }

  // SEC-3 (auditoría 25, MEDIO, re-auditoría): el ban de arriba mata el
  // REFRESH de la cookie del panel, pero no toca un token MCP — un acceso
  // sigue vivo hasta 8h y su refresco hasta 60 días (0265), y sin esto la
  // baja dependía de que el SIGUIENTE refresco topara con
  // `mcp_oauth_usuario_vigente()` (que la migración 0318 hizo mirar
  // `activo`, pero eso solo cierra el refresco, no lo que ya estaba vivo).
  // `revocar_mcp_oauth_usuario` (la RPC hermana de la propia 0265) tumba de
  // un tiro TODOS los tokens vivos de esta persona en esta flota. Best-effort
  // como el ban: la baja de `app_user` ya cerró panel y RLS; si esto falla se
  // dice y se loguea, no se revierte la baja por ello.
  try {
    const { error: errMcp } = await supabaseAdmin().rpc('revocar_mcp_oauth_usuario', { p_tenant: tenantId, p_usuario: usuarioId });
    if (errMcp) logger.error('equipo.mcp_revocar_fallo', { usuario: usuarioId, err: errMcp.message });
  } catch (e) {
    logger.error('equipo.mcp_revocar_fallo', { usuario: usuarioId, err: e instanceof Error ? e.message : String(e) });
  }

  await anotar(tenantId, 'usuario.desactivado', usuarioId, { rol: objetivo.rol, sesion_revocada: sesionRevocada }, actor);
  return { sesionRevocada };
}

export interface ResultadoReactivacion {
  /** `true` si Auth levantó el ban. `false` = la fila quedó activa pero la
   *  persona sigue sin poder iniciar sesión: hay que reintentar. */
  accesoRestaurado: boolean;
}

export async function reactivarUsuario(
  tenantId: string,
  usuarioId: string,
  actor: ActorEquipo,
): Promise<ResultadoReactivacion> {
  exigirUuid(usuarioId);
  const objetivo = await leerObjetivo(tenantId, usuarioId);
  if (objetivo.activo) throw new DatoInvalido('Esa cuenta ya está activa.');

  const { data, error } = await acotada(supabaseAdmin().from('app_user')
    .update({ activo: true, desactivado_en: null, desactivado_por: null })
    .eq('id', usuarioId)
    .eq('tenant_id', tenantId)
    .eq('activo', false)
    .select('id'), 'equipo.reactivar');
  if (error) throw new Error(`equipo.reactivar: ${error.message}`);
  if (!Array.isArray(data) || data.length === 0) {
    throw new DatoInvalido('Esa cuenta ya estaba activa. Recarga la pantalla.');
  }

  let accesoRestaurado = true;
  try {
    const { error: errBan } = await supabaseAdmin().auth.admin.updateUserById(usuarioId, { ban_duration: 'none' });
    if (errBan) {
      accesoRestaurado = false;
      logger.error('equipo.desban_fallo', { usuario: usuarioId, err: errBan.message });
    }
  } catch (e) {
    accesoRestaurado = false;
    logger.error('equipo.desban_fallo', { usuario: usuarioId, err: e instanceof Error ? e.message : String(e) });
  }

  await anotar(tenantId, 'usuario.reactivado', usuarioId, { rol: objetivo.rol, acceso_restaurado: accesoRestaurado }, actor);
  return { accesoRestaurado };
}

export interface ContextoAcceso {
  /** El nombre de la flota, para el correo. `null` si no se pudo leer. */
  flotaNombre: string | null;
  /** Quién invita — el correo lo firma una persona. */
  invitaNombre: string | null;
}

export type ResultadoCorreoAcceso =
  | { enviado: true }
  /** Sin RESEND_API_KEY: no es un fallo, es que el canal no está encendido. */
  | { enviado: false; motivo: 'sin_configurar' }
  | { enviado: false; motivo: 'fallo' };

/**
 * El correo de acceso (`avisoInvitacion`, que existía como plantilla y nadie
 * emitía — auditoría 24). Lo usan el alta y «Reenviar acceso». Best-effort:
 * el resultado se DICE en pantalla; nunca se afirma «le llegó» sin `ok`.
 */
export async function enviarCorreoDeAcceso(
  email: string,
  rol: string,
  contexto: ContextoAcceso,
): Promise<ResultadoCorreoAcceso> {
  const r = await enviarCorreo(
    email,
    avisoInvitacion({ flota: contexto.flotaNombre, invitaNombre: contexto.invitaNombre, rol: nombreDeRol(rol) }),
    // De `acceso@`, como el magic link: es la llave de la cuenta, no un aviso.
    { remitenteLocal: 'acceso' },
  );
  if (r.ok) return { enviado: true };
  if (r.motivo === 'sin_configurar') return { enviado: false, motivo: 'sin_configurar' };
  logger.warn('equipo.correo_acceso_fallo', { motivo: r.motivo, detalle: r.detalle });
  return { enviado: false, motivo: 'fallo' };
}

/**
 * Reenvía el correo de acceso a alguien del equipo (solo activos), y lo anota.
 */
export async function reenviarAcceso(
  tenantId: string,
  usuarioId: string,
  actor: ActorEquipo,
  contexto: ContextoAcceso,
): Promise<ResultadoCorreoAcceso & { email: string }> {
  exigirUuid(usuarioId);
  const objetivo = await leerObjetivo(tenantId, usuarioId);
  if (!objetivo.activo) throw new DatoInvalido('Esa cuenta está dada de baja: reactívala antes de reenviarle el acceso.');

  const r = await enviarCorreoDeAcceso(objetivo.email, objetivo.rol, contexto);
  if (r.enviado) {
    await anotar(tenantId, 'usuario.acceso_reenviado', usuarioId, { rol: objetivo.rol }, actor);
  }
  return { ...r, email: objetivo.email };
}
