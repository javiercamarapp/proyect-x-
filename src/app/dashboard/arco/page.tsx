import { ShieldCheck, CheckCircle2, CircleAlert } from 'lucide-react';
import { EstadoVacio, KpiTile } from '../../admin/ui/kit';
import { FormaConAviso, type ResultadoAccion } from '../../admin/ui/forma';
import { requireSessionTenant } from '@/lib/auth/guard';
import { resolverTenantEfectivo } from '@/lib/auth/tenant-efectivo';
import { puedeVerRuta } from '@/lib/auth/visibilidad';
import { puedeAdministrar } from '@/lib/auth/permisos';
import { revalidatePath } from 'next/cache';
import {
  listarSolicitudesArco, resolverSolicitudArco, ejecutarCancelacionArco, ejecutarOposicionArco,
} from '@/lib/likida/repo';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { mensajeParaPantalla } from '@/lib/likida/administracion';
import { fechaMx, hoyMx } from '@/lib/formato';
import { venceDentroDe, yaVencio, DIAS_VENCE_PRONTO } from './vencimiento';

export const dynamic = 'force-dynamic';

const ETIQUETA_TIPO: Record<string, string> = {
  acceso: 'Acceso', rectificacion: 'Rectificación', cancelacion: 'Cancelación', oposicion: 'Oposición',
};

type Params = { tenant?: string; vista?: string; rol?: string };
const RUTA = '/dashboard/arco';
const ALCANCE_CANCELACION = 'Se sustituyeron el nombre y el teléfono del registro operativo y se eliminaron sus conversaciones. Se conservan el identificador del operador, el correo de la cuenta, la referencia del titular en la solicitud y la documentación fiscal. Requieren revisión de privacidad para determinar los pasos pendientes.';

/**
 * AUDITORÍA 24 — las tres acciones de esta pantalla se gateaban con
 * `requireSessionTenant` a secas: solo «hay sesión y tiene flota». La PÁGINA
 * sí gatea (`resolverTenantEfectivo` corre `puedeVerRuta`), pero una server
 * action es un endpoint POST que no hereda esa puerta, y un encargado —que ve
 * el área `operacion`, y por tanto esta ruta— podía resolver una solicitud
 * ARCO, sustituir datos del registro operativo y borrar conversaciones con un
 * POST a mano. Contestarle a un titular en nombre del responsable obligado
 * (LFPDPPP art. 31) es CONTROL de la cuenta: `puedeAdministrar`.
 */
const NO_AUTORIZADO = 'Tu rol no puede responder solicitudes ARCO: es una respuesta legal que firma el dueño de la flota.';
function puedeResponderArco(rol: string): boolean {
  return puedeVerRuta(rol, RUTA) && puedeAdministrar(rol);
}

/**
 * Solicitudes ARCO de ESTA flota — la responsable obligada a contestar en 20
 * días hábiles (LFPDPPP 2025 art. 31). AUDITORÍA 16: antes vivía solo en /admin
 * (superadmin), y la flota no tenía dónde ver sus solicitudes ni responderlas.
 */
export default async function ArcoPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const { tenantId } = await resolverTenantEfectivo(RUTA, sp);
  // AUDITORÍA 16, ALTO (arquitectura): `Date.now()` en el render rompe la
  // puerta de pureza del repo; la fecha se inyecta desde el servidor.
  //
  // DAT-08 (auditoría prod): y ese día tiene que ser el DE MÉXICO. Con el día
  // UTC, a partir de las 18:00 una solicitud ARCO que vence HOY se pintaba
  // como vencida —el plazo del art. 31 de la LFPDPPP corre en días hábiles de
  // México, no de Londres— y la de mañana entraba en "vencen pronto" un día
  // antes de tiempo.
  const hoy = hoyMx();

  async function accionResponder(_previo: ResultadoAccion, fd: FormData): Promise<ResultadoAccion> {
    'use server';
    // AUDITORÍA 16, MEDIO: el superadmin que previsualiza una flota real
    // (?tenant=t-otra) no podía resolver — el action usaba el tenant de sesión.
    const s = await requireSessionTenant(RUTA);
    if (!puedeResponderArco(s.rol)) return { error: NO_AUTORIZADO };
    const sp = await searchParams;
    let tenantEfectivo = s.tenantId;
    if (s.rol === 'superadmin' && sp?.tenant) {
      const { resolverTenantPedido } = await import('@/lib/auth/tenant-api');
      tenantEfectivo = await resolverTenantPedido(supabaseAdmin(), tenantEfectivo, sp.tenant);
    }
    const resolucion = String(fd.get('resolucion') ?? '').trim();
    const solicitudId = String(fd.get('solicitudId') ?? '');
    if (!solicitudId) return { error: 'Falta la solicitud.' };
    if (resolucion.length < 5) return { error: 'Escribe la respuesta que se entrega al titular (qué se resolvió y cómo).' };
    try {
      const r = await resolverSolicitudArco(tenantEfectivo, solicitudId, resolucion);
      revalidatePath(RUTA);
      return r.enviada
        ? { ok: 'Solicitud resuelta y la respuesta se envió al titular por WhatsApp.' }
        : { ok: `Solicitud resuelta. La respuesta NO se pudo enviar por WhatsApp${r.error ? ` (${r.error})` : ''} — entrégala al titular por otro canal.` };
    } catch (e) {
      return { error: mensajeParaPantalla(e, 'resolver la solicitud') };
    }
  }

  // AUDITORÍA 19 (legal, reincidente #5): `ejecutar_arco_cancelacion` (0178)
  // existía sin un solo llamador — una cancelación se "resolvía" escribiendo
  // prosa sin que la base cambiara. Este botón la ejecuta DE VERDAD:
  // sustituye nombre y teléfono del registro operativo, borra conversaciones y la
  // RPC misma deja la solicitud resuelta con la evidencia de qué tocó. El
  // humano firma (aprieta el botón); el sistema ejecuta — en ese orden.
  async function accionEjecutarCancelacion(_previo: ResultadoAccion, fd: FormData): Promise<ResultadoAccion> {
    'use server';
    const s = await requireSessionTenant(RUTA);
    if (!puedeResponderArco(s.rol)) return { error: NO_AUTORIZADO };
    const sp = await searchParams;
    let tenantEfectivo = s.tenantId;
    if (s.rol === 'superadmin' && sp?.tenant) {
      const { resolverTenantPedido } = await import('@/lib/auth/tenant-api');
      tenantEfectivo = await resolverTenantPedido(supabaseAdmin(), tenantEfectivo, sp.tenant);
    }
    const solicitudId = String(fd.get('solicitudId') ?? '');
    if (!solicitudId) return { error: 'Falta la solicitud.' };
    try {
      const r = await ejecutarCancelacionArco(tenantEfectivo, solicitudId);
      revalidatePath(RUTA);
      if (!r.ok) return { error: `No se ejecutó la cancelación: ${r.motivo}` };
      return r.avisada
        ? { ok: `${ALCANCE_CANCELACION} Se confirmó por WhatsApp.` }
        : { ok: `${ALCANCE_CANCELACION} La confirmación NO salió por WhatsApp${r.errorAviso ? ` (${r.errorAviso})` : ''} — entrégasela por otro canal.` };
    } catch (e) {
      return { error: mensajeParaPantalla(e, 'ejecutar la cancelación') };
    }
  }

  // AUDITORÍA 20 (legal, reincidente #5 OTRA VEZ): `ejecutar_arco_oposicion`
  // es la gemela de la de arriba —misma migración 0178, mismo grant— y
  // también nació sin llamador. Una oposición se cerraba escribiendo "listo"
  // y no quedaba evidencia estructurada de nada.
  //
  // NO CIERRA LA SOLICITUD, y por eso este botón convive con el de Responder
  // en vez de sustituirlo: la RPC deja la solicitud `en_proceso` con
  // `oposicion_automatizada_vigente` y declara que requiere revisión humana.
  // Primero se registra la constancia, después la persona contesta al titular.
  async function accionRegistrarOposicion(_previo: ResultadoAccion, fd: FormData): Promise<ResultadoAccion> {
    'use server';
    const s = await requireSessionTenant(RUTA);
    if (!puedeResponderArco(s.rol)) return { error: NO_AUTORIZADO };
    const sp = await searchParams;
    let tenantEfectivo = s.tenantId;
    if (s.rol === 'superadmin' && sp?.tenant) {
      const { resolverTenantPedido } = await import('@/lib/auth/tenant-api');
      tenantEfectivo = await resolverTenantPedido(supabaseAdmin(), tenantEfectivo, sp.tenant);
    }
    const solicitudId = String(fd.get('solicitudId') ?? '');
    if (!solicitudId) return { error: 'Falta la solicitud.' };
    try {
      const r = await ejecutarOposicionArco(tenantEfectivo, solicitudId);
      revalidatePath(RUTA);
      if (!r.ok) return { error: `No se registró la oposición: ${r.motivo}` };
      return {
        ok: 'Oposición registrada en el expediente: queda en proceso, con la constancia de que la '
          + 'oposición del titular está vigente. Falta que revises el caso y le contestes con el botón de Responder.',
      };
    } catch (e) {
      return { error: mensajeParaPantalla(e, 'registrar la oposición') };
    }
  }

  // AUDITORÍA 16, ALTO (operabilidad): fail-cerrado — una base caída NO se
  // pinta como "Ninguna solicitud registrada" (la regla del repo). El error de
  // lectura se muestra; solo el vacío REAL es vacío.
  let solicitudes: Awaited<ReturnType<typeof listarSolicitudesArco>> = [];
  let errorCarga: string | null = null;
  try {
    solicitudes = await listarSolicitudesArco(tenantId);
  } catch (e) {
    errorCarga = e instanceof Error ? e.message : String(e);
  }
  const pendientes = solicitudes.filter((s) => s.estado === 'recibida' || s.estado === 'en_proceso');
  // AUDITORÍA 18, ALTO (A14): antes era `venceEn <= hoy` — "ya venció", no
  // "faltan ≤ 5 días". Lo vencido se cuenta APARTE: es incumplimiento del
  // art. 31, no algo que esté por pasar.
  const vencenPronto = pendientes.filter((s) => venceDentroDe(s.venceEn, hoy, DIAS_VENCE_PRONTO));
  const vencidas = pendientes.filter((s) => yaVencio(s.venceEn, hoy));

  return (
    <div className="flex flex-col gap-4">
      <header className="glass-panel flex items-center gap-2.5 px-5 py-4">
        <ShieldCheck width={16} height={16} strokeWidth={1.75} />
        <div>
          <span className="text-sm font-medium block">Privacidad (ARCO)</span>
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            Solicitudes de tus operadores y cómo responderlas a tiempo (LFPDPPP art. 31: 20 días hábiles)
          </span>
        </div>
      </header>

      {/* H7 (auditoría 24): las tres cifras salían de `solicitudes`, que es
          `[]` TANTO si de verdad no hay solicitudes COMO si la lectura de
          arriba falló (`errorCarga`, catch → `solicitudes = []`). Antes de
          este arreglo las tres KPI pintaban "0" en los dos casos: con la
          base caída, "0 vencidas sin responder" es exactamente la mentira
          que un responsable obligado por el art. 31 no se puede permitir —
          puede haber solicitudes vencidas de verdad y la pantalla las
          esconde bajo un cero con cara de medición. `null` es NO MEDIBLE
          (KpiTile lo pinta "—", no "0"); la caja roja de `errorCarga` de
          abajo ya explica por qué. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiTile icono={<CircleAlert width={15} height={15} strokeWidth={1.75} />} etiqueta="Por responder" valor={errorCarga ? null : pendientes.length} />
        <KpiTile icono={<CheckCircle2 width={15} height={15} strokeWidth={1.75} />} etiqueta={`Vencen pronto (≤ ${DIAS_VENCE_PRONTO} días)`} valor={errorCarga ? null : vencenPronto.length} />
        <KpiTile icono={<CircleAlert width={15} height={15} strokeWidth={1.75} />} etiqueta="Vencidas sin responder" valor={errorCarga ? null : vencidas.length} />
      </div>

      <div className="glass-panel overflow-hidden">
        <section className="p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide mb-3" style={{ color: 'var(--muted)' }}>
            Solicitudes de tus operadores
          </h2>
          {errorCarga ? (
            <div className="rounded-lg p-3 text-sm" style={{ background: 'color-mix(in srgb, var(--color-warn) 10%, transparent)', color: 'var(--color-warn)' }}>
              No se pudieron leer las solicitudes ahora mismo ({errorCarga.slice(0, 120)}). Recarga en un momento — no hay
              forma de saber si hay solicitudes pendientes hasta que la base responda.
            </div>
          ) : solicitudes.length === 0 ? (
            <EstadoVacio>
              Ninguna solicitud ARCO registrada. Cuando un operador escribe *PRIVACIDAD* por WhatsApp, la solicitud
              queda registrada aquí y tú —la responsable— tienes 20 días hábiles para responder.
            </EstadoVacio>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ color: 'var(--muted)' }} className="text-left">
                    <th className="px-3 py-2.5 font-medium">Recibida</th>
                    <th className="px-3 py-2.5 font-medium">Derecho</th>
                    <th className="px-3 py-2.5 font-medium">Titular</th>
                    <th className="px-3 py-2.5 font-medium">Vence</th>
                    <th className="px-3 py-2.5 font-medium">Estado</th>
                    <th className="px-3 py-2.5 font-medium">Respuesta</th>
                  </tr>
                </thead>
                <tbody>
                  {solicitudes.map((s) => (
                    <tr key={s.id} className="border-t align-top" style={{ borderColor: 'var(--line)' }}>
                      <td className="px-3 py-3">{fechaMx(s.recibidaEn)}</td>
                      <td className="px-3 py-3 font-medium">{ETIQUETA_TIPO[s.tipo] ?? s.tipo}</td>
                      <td className="px-3 py-3">
                        {s.operadorNombre ?? '—'}
                        <span className="block text-xs font-mono" style={{ color: 'var(--muted)' }}>{s.titularRef}</span>
                      </td>
                      <td className="px-3 py-3 tabular">{fechaMx(s.venceEn)}</td>
                      <td className="px-3 py-3">
                        <span className="text-xs font-semibold" style={{ color: s.estado === 'resuelta' || s.estado === 'improcedente' ? 'var(--color-ok)' : 'var(--color-warn)' }}>
                          {s.estado === 'resuelta' ? 'Resuelta' : s.estado === 'en_proceso' ? 'En proceso' : s.estado === 'improcedente' ? 'Improcedente' : 'Recibida'}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        {s.estado === 'resuelta' || s.estado === 'improcedente' ? (
                          <span className="text-xs" style={{ color: 'var(--muted)' }}>{s.resolucion ?? '—'}</span>
                        ) : s.tipo === 'cancelacion' ? (
                          <div className="flex flex-col gap-2">
                            {/* La cancelación NO se resuelve con prosa: se
                                EJECUTA sobre datos concretos. El botón dice
                                lo que hace antes de que alguien lo apriete. */}
                            <FormaConAviso accion={accionEjecutarCancelacion} boton="Ejecutar cancelación" columnas="auto">
                              <input type="hidden" name="solicitudId" value={s.id} />
                            </FormaConAviso>
                            <span className="text-xs" style={{ color: 'var(--muted)' }}>
                              Sustituye nombre y teléfono del registro operativo y elimina conversaciones. Se conservan
                              el identificador del operador, el correo de la cuenta, la referencia del titular en la solicitud
                              y la documentación fiscal; requieren revisión de privacidad para determinar los pasos pendientes.
                              No se puede deshacer la eliminación de conversaciones.
                            </span>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-2">
                            {/* La oposición SÍ tiene un acto que dejar
                                asentado antes de la prosa: la constancia de
                                que está vigente. Se ofrece arriba de
                                Responder porque ése es el orden — primero la
                                evidencia, después la contestación. */}
                            {s.tipo === 'oposicion' && (
                              <>
                                <FormaConAviso accion={accionRegistrarOposicion} boton="Registrar la oposición" columnas="auto">
                                  <input type="hidden" name="solicitudId" value={s.id} />
                                </FormaConAviso>
                                <span className="text-xs" style={{ color: 'var(--muted)' }}>
                                  Deja constancia en el expediente de que la oposición del titular está vigente
                                  (queda «en proceso»). No cancela ni borra ningún dato y no cierra la solicitud:
                                  eso lo haces tú al responder.
                                </span>
                              </>
                            )}
                            <FormaConAviso accion={accionResponder} boton="Responder" columnas="260px auto">
                              <input type="hidden" name="solicitudId" value={s.id} />
                              <input name="resolucion" placeholder="Qué se resolvió y cómo se entrega al titular" style={{ width: 260 }} />
                            </FormaConAviso>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
