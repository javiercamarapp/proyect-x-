// El tenant EFECTIVO de las rutas del chat — compartido por /chat,
// /conversaciones y /conversaciones/[id] para que las tres apliquen la MISMA
// regla (dos copias de una regla de autorización se desincronizan, y el modo
// de falla es un IDOR): el tenant de la sesión; superadmin sin flota cae al
// demo; y un `?tenant=` solo lo honra un superadmin, y solo si existe.
import type { SessionTenant } from '@/lib/auth/session';
import { tenantDemo } from '@/lib/auth/tenant-demo';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { acotada } from '@/lib/likida/presupuesto';
import { logger } from '@/lib/logger';
import { mfaSuperadminObligatorio, veredictoMfaSuperadmin } from '@/lib/auth/mfa';

export async function tenantEfectivoChat(
  sesion: SessionTenant,
  tenantPedido: string | null,
): Promise<{ tenantId: string; nombreFlota: string } | null> {
  let tenantId = sesion.tenantId;
  if (!tenantId) {
    if (sesion.rol !== 'superadmin') return null;
    tenantId = tenantDemo();
  }

  if (tenantPedido && sesion.rol === 'superadmin') {
    // AUDITORÍA 25, SEGURIDAD (ALTO, línea 166, REINCIDENTE, re-auditoría).
    // `resolverTenantApi` (tenant-api.ts) cerró este mismo bypass en el
    // commit c3e52ac2 — `?tenant=` de un superadmin sin el segundo factor
    // seguía entregando CUALQUIER flota — pero esa puerta no cubre las 5
    // rutas del chat, que llaman a ESTA función. Mismo veredicto que
    // `guard.ts` y `resolverTenantApi`, sin duplicar su lógica: fail cerrado
    // ante cualquier veredicto que no sea `ok`.
    if (mfaSuperadminObligatorio()) {
      const { supabaseServer } = await import('@/lib/supabase/server');
      const veredicto = await veredictoMfaSuperadmin(await supabaseServer());
      if (veredicto !== 'ok') {
        logger.warn('mfa.superadmin_exigido_api', { veredicto, ruta: 'chat.tenant' });
        return null;
      }
    }
    // BE-16 (auditoría 24): `error` SE MIRA. `acotada` resuelve por valor
    // —`{data:null,error}` en un timeout—, así que sin esta rama un parpadeo
    // de Supabase era indistinguible de «ese uuid no existe»: `tenantId` se
    // quedaba en el de la sesión (la demo, para un superadmin), la respuesta
    // salía con cifras de OTRA flota bajo un encabezado que no lo desmentía, y
    // `guardarIntercambio` persistía el historial en el tenant equivocado.
    // Se devuelve `null` —el mismo fail-closed de `resolverTenantApi`— y quien
    // llama corta. Un uuid que simplemente no existe SÍ sigue cayendo al de la
    // sesión: eso es un enlace viejo, no una lectura caída — y ese fallback se
    // VERIFICA abajo, igual que cualquier otro tenantId (MEDIO, reauditoría
    // 25: antes esta rama, al no encontrar `tenantPedido`, seguía de largo con
    // el `tenantId` original SIN comprobar que existiera — y para un
    // superadmin sin flota propia eso es `tenantDemo()`, el mismo uuid
    // fantasma que el resto de esta función acababa de aprender a rechazar).
    const { data: t, error } = await acotada(
      supabaseAdmin().from('tenant').select('id, nombre').eq('id', tenantPedido).maybeSingle(),
      'chat.tenant');
    if (error) {
      logger.error('chat.tenant_pedido_ilegible', { tenant: tenantPedido, err: error.message });
      return null;
    }
    if (t) return { tenantId: t.id as string, nombreFlota: (t.nombre as string) ?? 'tu flota' };
  }

  // Mismo fail-closed que BE-16 arriba, pero para el tenant que de verdad se
  // va a usar: el de la SESIÓN, el de `tenantDemo()`, o el de respaldo cuando
  // el `?tenant=` pedido no existe. Antes esta rama ni miraba `error` ni
  // comprobaba que `t` existiera: un `DEMO_TENANT_ID` fantasma (o una sesión
  // con un tenant ya borrado) pasaba de largo con `tenantId` intacto, y
  // `reservar_presupuesto_llm` tronaba por FK violation en cada turno — visto
  // en producción el 3-sep-2026 (`chat.analista.fallo`, 12 fallos en 5
  // minutos, siempre el mismo tenant_id inexistente).
  const { data: t, error } = await acotada(
    supabaseAdmin().from('tenant').select('nombre').eq('id', tenantId).maybeSingle(),
    'chat.tenant');
  if (error) {
    logger.error('chat.tenant_sesion_ilegible', { tenant: tenantId, err: error.message });
    return null;
  }
  if (!t) {
    logger.error('chat.tenant_sesion_fantasma', { tenant: tenantId });
    return null;
  }
  return { tenantId, nombreFlota: (t.nombre as string) ?? 'tu flota' };
}
