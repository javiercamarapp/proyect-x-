// ═══════════════════════════════════════════════════════════════════════════
// SEGUNDA CAPA DE AUTORIZACIÓN — la que no depende de un regex.
//
// Mismo criterio que la versión anterior (passcode): el proxy es la primera
// capa (barata, por matcher de ruta); esta es la segunda, y viaja CON la
// página en vez de con la configuración de rutas. Las dos tienen que fallar a
// la vez para que una página del panel se sirva sin autorización.
//
// Ahora la fuente de verdad es `app_user` vía `getSessionTenant()`, no un
// passcode compartido: sin sesión de Supabase, a /login; con sesión pero sin
// fila en `app_user` (alta pendiente), a /sin-acceso — nunca se sirve el
// panel sin un tenantId real.
//
// SUPERADMIN ES EL CASO APARTE. `app_user.tenant_id` nulo es AMBIGUO por
// diseño (0001_init.sql:17): puede ser "sin alta" o puede ser "superadmin,
// no pertenece a ningún tenant". Hasta el 16-ago-2026 aquí vivía el tenant
// IMPLÍCITO: sin selector de flota, un superadmin caía a `tenantDemo()` en
// silencio — el hallazgo #1 de la auditoría externa. Ahora la flota que mira
// un superadmin SIEMPRE es explícita (ver `admin-context.ts`): o la eligió
// en /admin/elegir-flota (cookie firmada), o viene del "ver como" auditado
// (`?tenant=`/`?vista=demo`/`?rol=`, el flujo de tenant-efectivo.ts que se
// firma en bitácora) — y sin ninguna de las dos, se le enseña el selector en
// vez de una flota que no pidió.
// ═══════════════════════════════════════════════════════════════════════════
import { redirect } from 'next/navigation';
import { tenantDemo } from './tenant-demo';
import { leerSeleccionFlota } from './admin-context';
import { mfaSuperadminObligatorio } from './mfa';
import { veredictoMfaDeSesion } from './superadmin-mfa';
import { logger } from '@/lib/logger';
import { getSessionTenant, type SessionTenant } from './session';

/**
 * DÓNDE SE INSCRIBE EL SEGUNDO FACTOR. Es la única pantalla EXENTA de la
 * exigencia de SEG-3: gatearla también sería un círculo perfecto — «para
 * inscribir tu factor, inscribe tu factor».
 */
const RUTA_MFA = '/dashboard/mi-perfil';

/**
 * MFA OBLIGATORIO PARA SUPERADMIN (auditoría 24, SEG-3). En producción está
 * encendido por default; `desactivado-temporal` es exclusivamente una vía de
 * recuperación. Fuera de producción solo `obligatorio` lo enciende (ver
 * `mfa.ts` y DEPLOY.md). Cuando no aplica, no hace ninguna llamada.
 *
 * Rebota a Mi perfil con el veredicto en el query string para que la pantalla
 * diga QUÉ falta —inscribirlo, verificarlo, o que no se pudo preguntar— en vez
 * de dejar a alguien girando sin saber qué hacer. `no_verificable` también
 * rebota: fallar cerrado, igual que las acciones 'doble'.
 */
async function exigirMfaSuperadmin(destino: string): Promise<void> {
  if (!mfaSuperadminObligatorio()) return;
  if (destino.startsWith(RUTA_MFA)) return;
  const veredicto = await veredictoMfaDeSesion({ rol: 'superadmin' });
  if (veredicto === 'ok') return;
  logger.warn('mfa.superadmin_exigido', { veredicto, destino });
  redirect(`${RUTA_MFA}?exige=${veredicto}`);
}


export async function requireSessionTenant(
  destino: string,
  /**
   * Los searchParams de previsualización, cuando la página los tiene
   * (`resolverTenantEfectivo` los pasa). Su ÚNICO efecto: un superadmin que
   * llega con intención de "ver como" (`?tenant=`, `?vista=demo` o `?rol=`)
   * conserva el flujo auditado de tenant-efectivo.ts — la base demo que ese
   * flujo siempre usó, con `?tenant=` resolviendo la flota real encima y la
   * impersonación firmada allá. Para cualquier otro rol no hace nada.
   */
  sp?: { vista?: string; tenant?: string; rol?: string },
): Promise<SessionTenant & { tenantId: string }> {
  const s = await getSessionTenant();
  if (!s) redirect(`/login?next=${encodeURIComponent(destino)}`);
  if (s.rol === 'superadmin') await exigirMfaSuperadmin(destino);
  if (!s.tenantId) {
    if (s.rol === 'superadmin') {
      // "Ver como" (previsualización auditada): la base sigue siendo la demo
      // — `resolverTenantEfectivo` resuelve `?tenant=` encima y firma.
      if (sp?.tenant || sp?.vista === 'demo') return { ...s, tenantId: tenantDemo() };
      // Selección EXPLÍCITA de /admin/elegir-flota (cookie httpOnly firmada,
      // admin-context.ts). Puede ser una flota real o la demo — pero elegida.
      const seleccion = await leerSeleccionFlota();
      if (seleccion) return { ...s, tenantId: seleccion };
      // ADM-11 (auditoría 24): `?rol=` SOLO —sin `?tenant=` ni `?vista=`— es
      // "ver el panel con los ojos de otro rol", no "cambiar de flota". Antes
      // se resolvía arriba junto a los otros dos y devolvía la demo AUNQUE
      // hubiera flota elegida: un link con solo `?rol=contador` te sacaba de
      // Innovativos a la demo sin cinta que lo dijera. Ahora la cookie manda,
      // y `?rol=` sin cookie sigue cayendo a la demo — que es de dónde
      // vienen esos links (`/admin/selector-vista.tsx`).
      if (sp?.rol) return { ...s, tenantId: tenantDemo() };
      // La pantalla donde se inscribe el factor no puede exigir haber elegido
      // flota: con SEG-3 encendido, el rebote a /admin/elegir-flota y el
      // rebote a Mi perfil se perseguirían el uno al otro. Solo con la
      // palanca puesta, y solo para esa ruta.
      if (mfaSuperadminObligatorio() && destino.startsWith(RUTA_MFA)) {
        return { ...s, tenantId: tenantDemo() };
      }
      // SIN selección NO hay tenant implícito: al selector, con el destino
      // para volver. Este redirect es el que mató el fallback a demo.
      redirect(`/admin/elegir-flota?next=${encodeURIComponent(destino)}`);
    }
    // El vendedor (0105) no tiene tenant NI pantalla en /dashboard: su casa
    // es /vendedor. Sin esta rama, el aterrizaje post-login (que por default
    // apunta a /dashboard) lo mandaba a /sin-acceso TENIENDO acceso — la
    // pantalla le decía "pide tu alta" a una cuenta ya dada de alta.
    if (s.rol === 'vendedor') redirect('/vendedor');
    redirect('/sin-acceso');
  }
  return s as SessionTenant & { tenantId: string };
}

/**
 * Puerta de /admin — la consola de negocio de Likida. Ningún otro rol la ve,
 * ni flota_admin: lo que vive aquí (cuántos tenants, cuánto gasta Likida en
 * IA) es de Javier, no de un cliente. Un rol≠superadmin va a /dashboard —
 * SÍ tiene panel, es otro.
 */
export async function requireSuperadmin(): Promise<SessionTenant> {
  const s = await getSessionTenant();
  if (!s) redirect(`/login?next=${encodeURIComponent('/admin')}`);
  if (s.rol !== 'superadmin') redirect('/dashboard');
  // SEG-3: la consola de negocio es justo lo que un phishing con enlace
  // mágico buscaría. Obligatorio por default en producción.
  await exigirMfaSuperadmin('/admin');
  return s;
}

/**
 * Puerta de /vendedor — la zona de vendedores de Likida (0105). Entra el
 * rol `vendedor` y el superadmin (soporte: es la consola de SU equipo de
 * ventas, no la de un cliente). Cualquier otro rol se va a SU casa vía
 * `inicioDe` — que también resuelve al rol sin fila (`SIN_ROL` →
 * /sin-acceso): fail closed, no un rebote a un panel que no le toca.
 *
 * QUIÉN VE QUÉ ADENTRO lo decide la página con la sesión devuelta: el
 * vendedor consulta con SU userId (solo sus prospectos); el superadmin ve
 * todos. Esta puerta solo decide si la pantalla existe para ese rol.
 */
export async function requireVendedor(): Promise<SessionTenant> {
  const s = await getSessionTenant();
  if (!s) redirect(`/login?next=${encodeURIComponent('/vendedor')}`);
  if (s.rol !== 'vendedor' && s.rol !== 'superadmin') {
    const { inicioDe } = await import('./visibilidad');
    redirect(inicioDe(s.rol));
  }
  if (s.rol === 'superadmin') await exigirMfaSuperadmin('/vendedor');
  return s;
}

/**
 * Gate de PANTALLA por rol, para las páginas que no pasan por
 * `resolverTenantEfectivo` — los stubs sin datos.
 *
 * Existe porque un stub también filtra: "Cobranza" y "Rentabilidad", aunque
 * estén vacías, le anuncian a un jefe de tráfico qué mira su patrón. Y el día
 * que dejen de ser stubs, el gate ya está puesto en vez de ser algo que
 * alguien tenga que acordarse de agregar.
 */
export async function exigirVerRuta(destino: string): Promise<SessionTenant> {
  const { puedeVerRuta, inicioDe } = await import('./visibilidad');
  const s = await requireSessionTenant(destino);
  if (!puedeVerRuta(s.rol, destino)) redirect(inicioDe(s.rol));
  return s;
}
