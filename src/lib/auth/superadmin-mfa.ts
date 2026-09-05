import {
  mfaSuperadminObligatorio,
  veredictoMfaSuperadmin,
  type VeredictoMfaSuperadmin,
} from './mfa';

/**
 * Puerta MFA reutilizable para cualquier superficie autenticada.
 *
 * Es deliberadamente ajena a NextResponse/redirect: así sirve igual en
 * layouts, route handlers y Server Actions. Los roles tenant no pagan una
 * llamada a Supabase MFA; la exigencia solo aplica al superadmin.
 */
export async function veredictoMfaDeSesion(
  sesion: { rol: string },
): Promise<VeredictoMfaSuperadmin> {
  if (sesion.rol !== 'superadmin' || !mfaSuperadminObligatorio()) return 'ok';
  const { supabaseServer } = await import('@/lib/supabase/server');
  return veredictoMfaSuperadmin(await supabaseServer());
}
