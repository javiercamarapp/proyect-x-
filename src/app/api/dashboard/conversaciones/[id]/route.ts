// Una conversación completa del historial del chat (13-ago-2026). El anclaje
// tenant+usuario vive en traerConversacion: un id ajeno devuelve 404, no la
// conversación de otro.
import { NextResponse, type NextRequest } from 'next/server';
import { getSessionTenant } from '@/lib/auth/session';
import { rechazoMfaSuperadminApi } from '@/lib/auth/api-superadmin';
import { puedeVerArea } from '@/lib/auth/visibilidad';
import { traerConversacion } from '@/lib/likida/chat/conversaciones';
import { logger } from '@/lib/logger';
import { validarConversacionId } from '../../chat/validacion';
import { tenantEfectivoChat } from '../../chat/tenant';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const id = validarConversacionId((await params).id);
  if (!id) return NextResponse.json({ error: 'id inválido' }, { status: 400 });

  try {
    const conversacion = await traerConversacion(efectivo.tenantId, sesion.userId, id);
    if (!conversacion) return NextResponse.json({ error: 'no existe' }, { status: 404 });
    return NextResponse.json(conversacion);
  } catch (err) {
    logger.error('conversaciones.traer.fallo', { err: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'no se pudo leer la conversación' }, { status: 502 });
  }
}
