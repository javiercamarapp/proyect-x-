// ═══════════════════════════════════════════════════════════════════════════
// EL PAGEVIEW DEL SITIO PÚBLICO → sitio_evento (0223).
//
// La analítica mínima: página + 'pageview', nada más. CERO datos del
// visitante (ni IP persistida, ni UA, ni cookie) — la IP solo se usa en
// memoria para el límite de tasa y no se escribe.
//
// La lista de páginas es CERRADA por forma: 'blog', 'blog:<slug>' o
// 'calculadora'. Cualquier otra cosa se descarta sin error — esta ruta jamás
// le contesta un problema al visitante: 204 siempre que el límite lo deje.
// Las conversiones NO entran por aquí: las escribe el servidor en la ruta
// del prospecto, donde de verdad ocurren.
// ═══════════════════════════════════════════════════════════════════════════
import { rateLimit, clientIp } from '@/lib/ratelimit';
import { leerTextoAcotado } from '@/lib/http/cuerpo_acotado';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { articuloPorSlug } from '@/lib/likida/marketing/articulos';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// Validación LINEAL en dos pasos (el ratchet veta grupos opcionales
// cuantificados): base cerrada, y si hay sufijo, el slug contra el CATÁLOGO
// real de artículos (c5-13) — la forma sola dejaba insertar filas de basura
// para páginas que no existen, 30 por minuto por IP, directo al embudo.
function paginaValida(p: string): boolean {
  const [base, ...resto] = p.split(':');
  if (base !== 'blog' && base !== 'calculadora') return false;
  if (resto.length === 0) return true;
  if (resto.length > 1 || base !== 'blog') return false;
  const slug = resto[0];
  if (slug.length < 1 || slug.length > 60 || !/^[a-z0-9-]+$/.test(slug)) return false;
  return articuloPorSlug(slug) !== null;
}

export async function POST(req: Request) {
  if (!(await rateLimit(`marketing-evento:${clientIp(req)}`, 30, 60_000))) {
    return new Response(null, { status: 204 });
  }
  const lectura = await leerTextoAcotado(req, 1_000);
  if (!lectura.ok) return new Response(null, { status: 204 });


  let pagina = '';
  try {
    const c = JSON.parse(lectura.texto) as { pagina?: unknown; evento?: unknown };
    if (c.evento !== 'pageview') return new Response(null, { status: 204 });
    pagina = typeof c.pagina === 'string' ? c.pagina : '';
  } catch {
    return new Response(null, { status: 204 });
  }
  if (!paginaValida(pagina)) return new Response(null, { status: 204 });

  const { error } = await supabaseAdmin().from('sitio_evento').insert({ pagina, evento: 'pageview' });
  if (error) logger.warn('marketing.pageview_fallo', { error: error.message });
  return new Response(null, { status: 204 });
}
