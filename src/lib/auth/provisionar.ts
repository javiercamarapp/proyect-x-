// ═══════════════════════════════════════════════════════════════════════════
// ALTA DE UN USUARIO DEL PANEL. `app_user.id` tiene que ser el mismo `id` de
// `auth.users`, así que la fila de `app_user` no se puede insertar antes de
// que exista el usuario de Auth. Se crea aquí con la Admin API (service-role,
// vía supabaseAdmin()) y `email_confirm: true` para que no haga falta un paso
// de confirmación aparte — el primer login real (magic link o Google) ya es
// la confirmación.
//
// `tenantId` acepta `null` porque `app_user.tenant_id` nulo es una fila
// válida: significa superadmin, no "sin asignar" (0001_init.sql:17). El
// default de `rol` es `flota_admin` porque es el caso común — dar de alta al
// contralor de una flota — y `superadmin` se pide explícito.
// ═══════════════════════════════════════════════════════════════════════════
import { supabaseAdmin } from '@/lib/supabase/admin';
import { destinatarioWhatsApp } from '@/lib/meta/client';
import { logger } from '@/lib/logger';

/** El dominio de `app_user_rol_dominio` menos `operador` (sin login desde el
 *  7-ago-2026). `vendedor` (0105) es rol de LIKIDA: siempre con tenantId
 *  null, como superadmin — su panel es /vendedor, no /dashboard. */
export type RolAppUser = 'superadmin' | 'flota_admin' | 'contador' | 'encargado' | 'vendedor';

/**
 * LA ÚNICA traducción de `RolAppUser` a texto de pantalla.
 *
 * ARQUITECTURA 25 (BAJO, REINCIDENTE). Había cuatro copias de este mapa
 * (`admin/equipo`, `admin/mi-perfil`, `dashboard/mi-perfil`,
 * `dashboard/sesiones-mcp`) y ya habían divergido: dos seguían nombrando
 * `operador` (retirado del dominio en la 0086, sin login desde el
 * 7-ago-2026) y ninguna de las tres copias sin tipar traía `vendedor`
 * (0105) — ese superadmin salía con su rol crudo, "vendedor", en vez de un
 * rótulo. `Record<RolAppUser, string>` (exhaustivo, TypeScript avisa si
 * falta un rol) es la forma correcta; las otras tres eran
 * `Record<string, string>` y caían a `?? s.rol` en silencio.
 */
export const ROL_LABEL: Record<RolAppUser, string> = {
  superadmin: 'Superadmin',
  flota_admin: 'Dueño / Admin de flota',
  encargado: 'Encargado',
  contador: 'Contador',
  vendedor: 'Vendedor (Likida)',
};

/**
 * LA ÚNICA forma corta —en mayúsculas, para el badge del sidebar— de
 * `RolAppUser`. Antes vivía como `ROL_BADGE` en `dashboard/chrome.tsx`.
 *
 * AUDITORÍA 28, ARQ-B5 (BAJO, reincidente 26/27). Era la QUINTA copia del
 * dominio de roles (después de las cuatro de `ROL_LABEL` arriba), y el
 * barrido que debía verla —`rol_label_unico.test.ts`— casa por NOMBRE
 * (`grep … '(const|let) ROL_LABEL'`), así que `ROL_BADGE` le era invisible.
 * Estaba sin tipar (`Record<string, string>`): un sexto rol pone `tsc` en
 * rojo aquí (falta la clave en `Record<RolAppUser, string>`, exhaustivo) y
 * NUNCA en `chrome.tsx` — el sidebar habría impreso la clave cruda, lo que
 * ya le pasó a `vendedor` antes de la 0105.
 *
 * Las cinco claves son el dominio REAL de `app_user.rol` (constraint
 * `app_user_rol_dominio`: 0044_rol_encargado.sql lo abrió,
 * 0086_retirar_rol_operador.sql retiró `operador` —el chofer ya no tiene
 * login, solo WhatsApp— y 0105_zona_vendedores.sql agregó `vendedor`) — no
 * una etiqueta de adorno: decía "FLOTA" fijo para todos, y quien entra es
 * un `flota_admin`, un contador o un encargado, que no ven lo mismo. Un rol
 * nuevo cae al `??` de `chrome.tsx` y sale con su clave cruda, nunca vacío.
 */
export const ROL_BADGE: Record<RolAppUser, string> = {
  flota_admin: 'ADMIN FLOTA',
  encargado: 'ENCARGADO',
  contador: 'CONTADOR',
  vendedor: 'VENDEDOR',
  superadmin: 'SUPERADMIN',
};

/**
 * Normaliza el teléfono de oficina EXACTAMENTE como el del operador
 * (`administracion.ts:registrarOperador`): solo dígitos, lada 52 si vienen 10,
 * y la forma canónica de `destinatarioWhatsApp` — que es la que
 * `resolverCuentaOficina` (contactos.ts) sabe volver a encontrar. Guardarlo
 * con otro formato es guardarlo donde el matcher no lo ve, que era
 * exactamente el hallazgo D5: la columna existía (0059), el lector existía, y
 * ningún escritor la llenaba — el dueño de una flota nueva no podía escribirle
 * al bot sin un UPDATE a mano.
 */
function normalizarTelefonoOficina(crudo: string): string {
  const soloDigitos = crudo.replace(/[^\d]/g, '');
  if (soloDigitos.length < 10) {
    throw new Error(`El teléfono "${crudo}" tiene ${soloDigitos.length} dígitos; un número mexicano necesita 10 más la lada 52.`);
  }
  return destinatarioWhatsApp(soloDigitos.length === 10 ? `52${soloDigitos}` : soloDigitos);
}

export async function provisionarUsuario(
  tenantId: string | null,
  email: string,
  nombre?: string,
  rol: RolAppUser = 'flota_admin',
  /** Opcional: el WhatsApp de esta persona de oficina, para que el bot la
   *  reconozca cuando escriba (D5, auditoría 4). Vacío = no se captura. */
  telefono?: string,
): Promise<{ userId: string }> {
  // Se normaliza ANTES de crear el usuario de Auth: un teléfono inválido no
  // debe dejar a medias un alta (usuario de Auth creado, fila sin teléfono).
  const telefonoCanonico = telefono?.trim() ? normalizarTelefonoOficina(telefono) : null;

  const admin = supabaseAdmin();
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(error?.message ?? 'no se pudo crear el usuario de Auth');

  const { error: errInsert } = await admin.from('app_user').insert({
    id: data.user.id, tenant_id: tenantId, email, nombre: nombre ?? null, rol,
    telefono: telefonoCanonico,
  });
  if (errInsert) {
    // ── ROLLBACK (auditoría 24, H6). Sin esto, un insert que rebota (el
    // teléfono ya identifica a otra cuenta — índice 0059—, un bache) dejaba
    // un usuario de Auth SIN fila en app_user: una cuenta que puede iniciar
    // sesión (magic link) y aterriza en /sin-acceso, y que además bloquea
    // para siempre un segundo alta con el mismo correo («already
    // registered»). Se borra el usuario de Auth que ESTA llamada creó; si el
    // borrado también falla, se dice en el log y el error original sigue su
    // camino — el llamador ya sabe que el alta no se completó.
    const { error: errBorrar } = await admin.auth.admin.deleteUser(data.user.id);
    if (errBorrar) {
      logger.error('provisionar.rollback_fallo', { userId: data.user.id, err: errBorrar.message, causa: errInsert.message });
    }
    throw new Error(errInsert.message);
  }

  return { userId: data.user.id };
}
