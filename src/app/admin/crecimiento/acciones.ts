'use server';

import { revalidatePath } from 'next/cache';
import { getSessionTenant } from '@/lib/auth/session';
import { veredictoMfaDeSesion } from '@/lib/auth/superadmin-mfa';
import { MSG_MFA_SUPERADMIN } from '@/lib/auth/mfa';
import { pausarCampana, refrescarGastoMeta } from '@/lib/admin/campanas';
import { mensajeParaPantalla } from '@/lib/likida/errores';
import type { AccionCampana } from './campanas';

async function ejecutarComoSuperadmin(
  hacer: (userId: string) => Promise<AccionCampana>,
  errorAcceso: string,
): Promise<AccionCampana> {
  const sesion = await getSessionTenant();
  if (sesion?.rol !== 'superadmin') return { ok: false, error: errorAcceso };

  const veredicto = await veredictoMfaDeSesion(sesion);
  if (veredicto !== 'ok') return { ok: false, error: MSG_MFA_SUPERADMIN[veredicto] };

  return hacer(sesion.userId);
}

export async function accionPausarCampana(id: string): Promise<AccionCampana> {
  return ejecutarComoSuperadmin(async (userId) => {
    try {
      const r = await pausarCampana(String(id), userId);
      revalidatePath('/admin/crecimiento');
      return { ok: true, mensaje: r.mensaje };
    } catch (e) {
      return { ok: false, error: mensajeParaPantalla(e, 'pausar la campaña') };
    }
  }, 'Solo el superadmin pausa campañas.');
}

export async function accionRefrescarGasto(): Promise<AccionCampana> {
  return ejecutarComoSuperadmin(async () => {
    try {
      const r = await refrescarGastoMeta();
      revalidatePath('/admin/crecimiento');
      if (!r.configurada) {
        return { ok: false, error: 'META_ADS_TOKEN no está configurado — no hay de dónde leer el gasto.' };
      }
      const fallo = r.fallidas.length > 0
        ? ` · fallaron: ${r.fallidas.map((f) => `${f.nombre} (${f.motivo})`).join(', ')}`
        : '';
      return {
        ok: true,
        mensaje: `Gasto medido en ${r.medidas} campaña${r.medidas === 1 ? '' : 's'}${fallo}.`,
      };
    } catch (e) {
      return { ok: false, error: mensajeParaPantalla(e, 'medir el gasto') };
    }
  }, 'Solo el superadmin mide el gasto.');
}
