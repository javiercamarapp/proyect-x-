// La lista del panel Historial del chat (13-ago-2026). Solo conversaciones
// del USUARIO de la sesión en su tenant efectivo — misma puerta que /chat
// (el matcher del proxy excluye /api: esta línea es la única).
import { NextResponse, type NextRequest } from 'next/server';
import { getSessionTenant } from '@/lib/auth/session';
import { rechazoMfaSuperadminApi } from '@/lib/auth/api-superadmin';
import { puedeVerArea } from '@/lib/auth/visibilidad';
import { listarConversaciones } from '@/lib/likida/chat/conversaciones';
import { logger } from '@/lib/logger';
import { tenantEfectivoChat } from '../chat/tenant';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const sesion = await getSessionTenant();
  if (!sesion) return NextResponse.json({ error: 'sin sesion' }, { status: 401 });
  const rechazoMfa = await rechazoMfaSuperadminApi(sesion);
  if (rechazoMfa) return rechazoMfa;
  if (!puedeVerArea(sesion.rol, 'dinero')) {
    return NextResponse.json({ error: 'sin acceso' }, { status: 403 });
  }
  const efectivo = await tenantEfectivoChat(sesion, req.nextUrl.searchParams.get('tenant'));
  // AUDITORÍA 24 (auth): `null` con `?tenant=` presente es "no se pudo
  // verificar la flota" (lectura caída), no "sin permiso" — 503, como
  // `resolverTenantApi`. Sin `?tenant=` sigue siendo 403 real.
  if (!efectivo) return NextResponse.json({ error: 'sin acceso' },
    { status: req.nextUrl.searchParams.get('tenant') ? 503 : 403 });

  try {
    const conversaciones = await listarConversaciones(efectivo.tenantId, sesion.userId);
    return NextResponse.json({ conversaciones });
  } catch (err) {
    // Fallar DICIENDO: una lista vacía por error afirmaría "no has chateado".
    logger.error('conversaciones.listar.fallo', { err: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'no se pudo leer el historial' }, { status: 502 });
  }
}
