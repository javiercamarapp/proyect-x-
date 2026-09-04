// La puerta compartida de TODAS las rutas /api/admin/* — mapa-prospectos, qa
// y copiloto la reexportan. Las rutas /api no pasan por el layout de /admin
// (su `requireSuperadmin()` no las cubre), así que cada familia re-chequea
// sesión, y hasta esta migración cada una traía su PROPIA copia del chequeo.
//
// AUDITORÍA 25, SEGURIDAD (ALTO, línea 166, REINCIDENTE). SEG-3 (auditoría
// 24) cierra /admin con el segundo factor cuando
// `LIKIDA_SUPERADMIN_MFA=obligatorio` (`guard.ts`, `requireSuperadmin`), pero
// las TRES copias de esta puerta solo comprobaban `rol === 'superadmin'` —
// nunca el veredicto del factor. Una cookie de superadmin phishada (sin el
// factor) seguía entregando la cartera comercial completa
// (mapa-prospectos), las corridas de QA con gasto real de modelo, y el
// historial del copiloto. Consolidar las tres copias en un solo archivo es
// lo que impide que la próxima ruta /api/admin/* vuelva a copiar la versión
// vieja: hay un solo sitio que decide "¿esta sesión de API es un superadmin
// verificado?", y `guard.ts` es la fuente del mismo veredicto para /admin.
//
// Sin sesión: 401. Otro rol: 403. Con MFA exigido y sin verificar: 403.
// Ninguna respuesta dice qué hay detrás.
import { NextResponse } from 'next/server';
import { getSessionTenant, type SessionTenant } from './session';
import { veredictoMfaDeSesion } from './superadmin-mfa';
import { logger } from '@/lib/logger';

/**
 * Adaptador HTTP de la puerta MFA. Se usa también en APIs tenant: para un rol
 * distinto de superadmin devuelve null sin consultar MFA.
 */
export async function rechazoMfaSuperadminApi(sesion: SessionTenant): Promise<NextResponse | null> {
  const veredicto = await veredictoMfaDeSesion(sesion);
  if (veredicto === 'ok') return null;
  logger.warn('mfa.superadmin_exigido_api', { veredicto });
  return new NextResponse(null, { status: 403 });
}

export async function sesionSuperadmin(): Promise<
  { error: NextResponse; sesion: null } | { error: null; sesion: SessionTenant }
> {
  const s = await getSessionTenant();
  if (!s) return { error: new NextResponse(null, { status: 401 }), sesion: null };
  if (s.rol !== 'superadmin') return { error: new NextResponse(null, { status: 403 }), sesion: null };
  const rechazoMfa = await rechazoMfaSuperadminApi(s);
  if (rechazoMfa) return { error: rechazoMfa, sesion: null };
  return { error: null, sesion: s };
}
