'use server';

import { appUrl } from '@/lib/env';
import { revalidatePath } from 'next/cache';
import type { SessionTenant } from '@/lib/auth/session';
import { getSessionTenant } from '@/lib/auth/session';
import { veredictoMfaDeSesion } from '@/lib/auth/superadmin-mfa';
import { MSG_MFA_SUPERADMIN } from '@/lib/auth/mfa';
import {
  validarProspecto,
  crearProspecto,
  asignarProspecto,
  cambiarEstadoProspecto,
  actualizarNotasProspecto,
  invitarVendedor,
  asignarPendientes,
} from '@/lib/likida/vendedores';
import { redactarCorreoFrio } from '@/lib/likida/agentes/redactor';
import { descifrarErrorProvision } from '@/lib/auth/invitar';
import { mensajeParaPantalla } from '@/lib/likida/errores';
import type { ResultadoAccion } from './tablero';
import type { ResultadoForma } from './formas';

const RUTA = '/admin/vendedores';
const ERROR_ACCESO = 'Solo el superadmin administra la zona de vendedores.';

type ResultadoNoNulo = ResultadoAccion | Exclude<ResultadoForma, null>;

/**
 * Toda mutación de la consola pasa por esta puerta. La sesión, el rol y MFA
 * se resuelven antes de invocar `hacer`; por eso un rechazo no alcanza ni la
 * validación del payload ni la base, el LLM o Auth Admin.
 */
async function ejecutarComoSuperadmin<T extends ResultadoNoNulo>(
  hacer: (sesion: SessionTenant) => Promise<T>,
  operacion: string,
  errorAcceso = ERROR_ACCESO,
  traducirError?: (error: unknown) => unknown,
): Promise<T | { ok: false; error: string }> {
  const sesion = await getSessionTenant();
  if (sesion?.rol !== 'superadmin') return { ok: false, error: errorAcceso };

  const veredicto = await veredictoMfaDeSesion(sesion);
  if (veredicto !== 'ok') return { ok: false, error: MSG_MFA_SUPERADMIN[veredicto] };

  try {
    const resultado = await hacer(sesion);
    revalidatePath(RUTA);
    return resultado;
  } catch (error) {
    return {
      ok: false,
      error: mensajeParaPantalla(traducirError ? traducirError(error) : error, operacion),
    };
  }
}

export async function accionMover(id: string, a: string): Promise<ResultadoAccion> {
  return ejecutarComoSuperadmin(async () => {
    await cambiarEstadoProspecto(String(id), String(a));
    return { ok: true };
  }, 'mover el prospecto');
}

export async function accionAsignar(id: string, vendedorId: string): Promise<ResultadoAccion> {
  return ejecutarComoSuperadmin(async () => {
    await asignarProspecto(String(id), vendedorId === '' ? null : String(vendedorId));
    return { ok: true };
  }, 'asignar el prospecto');
}

export async function accionNota(id: string, nota: string): Promise<ResultadoAccion> {
  return ejecutarComoSuperadmin(async () => {
    await actualizarNotasProspecto(String(id), String(nota));
    return { ok: true };
  }, 'guardar la nota');
}

export async function accionRedactar(id: string): Promise<ResultadoAccion> {
  return ejecutarComoSuperadmin(async (sesion) => {
    // El superadmin de LIKIDA no tiene tenant: su gasto es de plataforma
    // (c5-10), con el techo del runner sobre el gasto medido del día.
    const r = await redactarCorreoFrio(
      String(id),
      sesion.nombre ?? 'Javier',
      'manual',
      sesion.tenantId ? { tenantId: sesion.tenantId } : { plataforma: true },
    );
    return {
      ok: true,
      mensaje: `«${r.asunto}» quedó en la cola — apruébala en Aprobaciones.${r.aviso ? ` OJO: ${r.aviso}` : ''}`,
    };
  }, 'redactar el correo');
}

export async function accionCrearProspecto(
  _previo: ResultadoForma,
  fd: FormData,
): Promise<ResultadoForma> {
  return ejecutarComoSuperadmin(async () => {
    const v = validarProspecto({
      empresa: String(fd.get('empresa') ?? ''),
      contactoNombre: String(fd.get('contacto') ?? ''),
      telefono: String(fd.get('telefono') ?? ''),
      correo: String(fd.get('correo') ?? ''),
      ciudad: String(fd.get('ciudad') ?? ''),
      vacante: String(fd.get('vacante') ?? ''),
      notas: String(fd.get('notas') ?? ''),
      vendedorId: String(fd.get('vendedor') ?? ''),
    });
    await crearProspecto(v, 'manual');
    return {
      ok: true,
      mensaje: `${v.empresa} entró al tablero${v.vendedorId ? '' : ' sin vendedor — lo puede tomar el asignador'}.`,
    };
  }, 'dar de alta el prospecto', 'Solo el superadmin da de alta prospectos.');
}

export async function accionInvitar(
  _previo: ResultadoForma,
  fd: FormData,
): Promise<ResultadoForma> {
  return ejecutarComoSuperadmin(async () => {
    const { email } = await invitarVendedor(
      String(fd.get('email') ?? ''),
      String(fd.get('nombre') ?? ''),
    );
    // La verdad del flujo, igual que en /dashboard/usuarios: no se emite
    // correo de invitación todavía — prometer "le llegó" sería mentira.
    const liga = appUrl();
    return {
      ok: true,
      mensaje: `${email} ya puede entrar con su correo (enlace mágico) y aterriza en /vendedor. `
        + `No le llega invitación por correo todavía — pásale tú la liga: ${liga}/login`,
    };
  }, 'invitar al vendedor', 'Solo el superadmin invita vendedores.',
  (error) => descifrarErrorProvision(error) ?? error);
}

// Sin parámetros a propósito: el botón no captura nada — una función de
// menos parámetros es asignable a `AccionForma`.
export async function accionRepartir(): Promise<ResultadoForma> {
  return ejecutarComoSuperadmin(async () => {
    const r = await asignarPendientes();
    if (r.apagado) {
      return { ok: false, error: 'El asignador (agente:ventas) está apagado desde Observabilidad. Enciéndelo para repartir.' };
    }
    if (r.sinVendedores) {
      return { ok: false, error: 'No hay vendedores a quienes repartir. Invita al primero aquí abajo y vuelve a correr.' };
    }
    if (r.pendientes === 0) {
      return { ok: true, mensaje: 'No había prospectos pendientes (sin vendedor y en Nuevo) que repartir.' };
    }
    if (r.repartidos === 0) {
      return { ok: false, error: 'No se pudo repartir ninguno — revisa la bitácora del asignador aquí abajo.' };
    }
    const detalle = r.porVendedor.map((v) => `${v.nombre} (${v.n})`).join(', ');
    return {
      ok: true,
      mensaje: `Repartió ${r.repartidos} de ${r.pendientes}: ${detalle}. La corrida quedó en la bitácora.`,
    };
  }, 'repartir los pendientes', 'Solo el superadmin corre el asignador.');
}
