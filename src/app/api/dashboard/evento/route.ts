// ═══════════════════════════════════════════════════════════════════════════
// EL PAGEVIEW DEL PANEL → producto_evento (0251).
//
// El hermano autenticado de /api/marketing/evento (0223), con las mismas
// reglas y una más:
//   · CERO datos del usuario: se guarda (tenant, pantalla, 'pageview') y ya.
//     Ni quién, ni IP, ni UA — la minimización no es opcional en el producto
//     de una empresa que trata datos fiscales.
//   · Lista CERRADA de pantallas: el pathname se convierte contra el catálogo
//     de rutas (pantallaDesdeRuta); lo que no es del catálogo se descarta
//     sin error. Esta ruta jamás le contesta un problema al panel: 204
//     siempre. Un fallo del INSERT se loguea y no estorba.
//   · La regla nueva: SESIÓN obligatoria con tenant real. Sin sesión no hay
//     tenant que anotar; y el superadmin en preview NO cuenta — su pageview
//     mediría a Javier mirando la flota, no a la flota usando el producto.
// ═══════════════════════════════════════════════════════════════════════════
import { getSessionTenant } from '@/lib/auth/session';
import { rateLimit, bodyExcede } from '@/lib/ratelimit';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { pantallaDesdeRuta } from '@/app/dashboard/pantalla-evento';
import { logger } from '@/lib/logger';
import { vieneDeNuestroSitio } from '@/lib/auth/csrf';
import { leerTextoAcotado } from '@/lib/http/cuerpo_acotado';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (bodyExcede(req, 1_000)) return new Response(null, { status: 204 });
  // Auditoría 21, BAJO-MEDIO: el chequeo CSRF explícito (SEG-9) solo cubría
  // /api/admin/palette y /v1/*. Esta ruta ya "jamás contesta un problema al
  // panel" (204 siempre) — el rechazo por origen ajeno sigue esa misma regla.
  if (!vieneDeNuestroSitio(req)) {
    logger.warn('producto.pageview_origen_ajeno', { origen: req.headers.get('origin'), sitio: req.headers.get('sec-fetch-site') });
    return new Response(null, { status: 204 });
  }

  const s = await getSessionTenant();
  if (!s || !s.tenantId || s.rol === 'superadmin') return new Response(null, { status: 204 });

  // Por usuario y no por IP: es tráfico autenticado, y 60/min cubre holgado a
  // quien navega — nadie abre una pantalla por segundo.
  if (!(await rateLimit(`producto-evento:${s.userId}`, 60, 60_000))) {
    return new Response(null, { status: 204 });
  }

  const lectura = await leerTextoAcotado(req, 1_000);
  if (!lectura.ok) return new Response(null, { status: 204 });
  let ruta: unknown = null;
  try {
    const c = JSON.parse(lectura.texto) as { ruta?: unknown };
    ruta = c.ruta;
  } catch {
    return new Response(null, { status: 204 });
  }
  const pantalla = pantallaDesdeRuta(ruta);
  if (pantalla === null) return new Response(null, { status: 204 });

  const { error } = await supabaseAdmin()
    .from('producto_evento')
    .insert({ tenant_id: s.tenantId, pantalla, accion: 'pageview' });
  if (error) logger.warn('producto.pageview_fallo', { error: error.message });
  return new Response(null, { status: 204 });
}
