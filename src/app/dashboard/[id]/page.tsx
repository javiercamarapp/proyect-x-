import { requireSessionTenant } from '@/lib/auth/guard';
import { puedeVerArea, inicioDe, rolEfectivo } from '@/lib/auth/visibilidad';
import { notFound, redirect } from 'next/navigation';
import { getLiquidacionDetalle } from '@/lib/likida/analytics';
import { etiquetaConcepto } from '@/lib/likida/cuadre/engine';
import { puedeExportar, puedeAsignar, puedeAdministrar } from '@/lib/auth/permisos';
import { reasignarOperador, buscarCatalogo, contarCatalogo, type OpcionCatalogo, type TipoCatalogo } from '@/lib/likida/repo';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { resolverTenantPedido } from '@/lib/auth/tenant-api';
import { revalidatePath } from 'next/cache';
import { reabrirViaje, mensajeParaPantalla } from '@/lib/likida/administracion';
import type { ResultadoAccion } from '../../admin/ui/forma';
import { sufijoTenant } from '../sufijo';
import { estadoDeColor } from './vista';
import { DetalleLiquidacion } from './detalle';
import { etiquetaEstatus } from '../estatus';
import {
  leerRevision, revisarLiquidacion, normalizarAjustes, puedeFirmarLiquidacion,
  type AccionRevision, type RevisionDetalle,
} from '@/lib/likida/revision';
import { mxn } from '@/lib/formato';
import { reintentarPdfAjustado } from '@/lib/likida/revision_recalculo';

export const dynamic = 'force-dynamic';

// Este mapa YA NO pinta el renglón: lo pinta `etiquetaGasto` (abajo), que
// delega en el motor. Se queda como traducción de respaldo y como el mapa que
// `etiquetas_sincronizadas.test.ts` mantiene a la par de `label()` del motor.
// Se desincronizó una vez al partir 'viaticos' en tres: el contralor veía
// "hospedaje" en minúscula cruda en su tabla.
const CONCEPTO: Record<string, string> = {
  diesel: 'Diésel', caseta: 'Caseta', factura: 'Factura',
  alimentacion: 'Alimentación', hospedaje: 'Hospedaje', transporte: 'Transporte', flete: 'Flete',
  viaticos: 'Viáticos', otro: 'Otro',
};

/** `https://wa.me/52…` con el teléfono del operador tal como está en su
 *  ficha: solo dígitos, y la lada de México una sola vez. Sin teléfono no
 *  hay botón — nunca un link a un número inventado. */
function hrefWhatsApp(telefono: string | null): string | null {
  if (!telefono) return null;
  const digitos = telefono.replace(/\D/g, '');
  if (digitos.length < 10) return null;
  return `https://wa.me/52${digitos.replace(/^52/, '')}`;
}

export default async function Detalle({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ tenant?: string; vista?: string; rol?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;

  // Segunda capa (ver dashboard/page.tsx). El id va en la ruta de vuelta para
  // que tras el passcode aterrice en la liquidación que pidió.
  //
  // `sp` VIAJA A LA PUERTA, como en `resolverTenantEfectivo`: sin él, un
  // superadmin en `?vista=demo` caía al tenant de su selección explícita
  // (admin/elegir-flota) y esta página respondía 404 — la liquidación del
  // demo no existe bajo la flota elegida. Esta página no puede usar
  // `resolverTenantEfectivo` directo porque su ruta es dinámica
  // (`/dashboard/<uuid>`) y `puedeVerRuta` no la conoce; el área se gatea a
  // mano abajo.
  const { tenantId: tenantIdDemo, rol: rolReal } = await requireSessionTenant(`/dashboard/${id}`, sp);
  // AUDITORÍA 13, MEDIO (arquitectura): esta página era la única de datos que
  // no pasaba por rolEfectivo — la previsualización 'ver como' (?rol=contador)
  // gateaba con el rol REAL (superadmin) y el formulario 'Reasignar'/'Reabrir'
  // (acciones destructivas) se pintaban y se EJECUTABAN como superadmin. El rol
  // efectivo solo QUITA visibilidad; las escrituras re-chequean abajo con el
  // rol real.
  const rol = rolEfectivo(rolReal, sp.rol);

  // ESTA PANTALLA ES DINERO, no la ficha operativa del viaje: enseña
  // comprobado contra anticipo, la deducibilidad y el desglose de IVA/IEPS.
  // El área se comprueba a mano y no por `puedeVerRuta` porque la ruta es
  // dinámica (`/dashboard/<uuid>`) y no puede estar en el mapa de rutas.
  if (!puedeVerArea(rol, 'dinero')) redirect(inicioDe(rol));

  // Mismo criterio de dashboard/page.tsx: un superadmin viendo la flota X
  // desde "Ver dashboard" (admin/flotas) necesita que ESTA página de detalle
  // también resuelva a X, no al tenant demo — si no, el link de la tabla
  // llevaría a un 404 (la liquidación no existe bajo el tenant equivocado).
  let tenantId = tenantIdDemo;
  if (rolReal === 'superadmin' && sp?.tenant) {
    tenantId = await resolverTenantPedido(supabaseAdmin(), tenantId, sp.tenant);
  }

  // `vista`, `rol` y `tenant` TIENEN QUE VIAJAR EN LA VUELTA: el mismo
  // contrato de sufijo que el sidebar y el resto de las páginas
  // (`sufijoTenant`). Sin él, "Viajes" durante el demo caía en `/dashboard`
  // pelón, donde un superadmin sin vista ni tenant rebota a /admin — y la
  // consola interna se proyectaba delante del director de la flota.
  const sufijo = sufijoTenant(sp);

  const d = await getLiquidacionDetalle(id, tenantId);
  if (!d) notFound();
  const e = etiquetaEstatus(d.estatus);
  const puedeReasignar = puedeAsignar(rol);
  // Reabrir es del dueño, no del encargado ni del contador: borra la
  // liquidación y el PDF que quizá ya se entregó.
  // (Se conserva la condición original: `d.estatus` es el de la LIQUIDACIÓN
  // —cuadrada / con_diferencias / revisar—, así que hoy esto no se pinta
  // nunca; queda anotado en el resumen de la rama para decidirlo aparte.)
  const puedeReabrir = puedeAdministrar(rol) && d.estatus === 'liquidado';

  /**
   * Reabre el viaje. NO BASTA CAMBIAR `viaje.estatus` — el trigger de la 0036
   * mira si EXISTE la fila de `liquidacion`, y mientras esté no entra ni un
   * gasto. Eso lo resuelve `reabrirViaje`; aquí solo se comprueba el permiso y
   * se exige la confirmación explícita, porque es destructivo.
   */
  async function reabrir(_previo: ResultadoAccion, fd: FormData): Promise<ResultadoAccion> {
    'use server';
    const s = await requireSessionTenant(`/dashboard/${id}`, sp);
    if (!puedeAdministrar(s.rol)) {
      return { error: 'Tu rol no puede reabrir un viaje liquidado. Pídeselo al dueño de la flota.' };
    }
    let t = s.tenantId;
    if (s.rol === 'superadmin' && sp?.tenant) {
      t = await resolverTenantPedido(supabaseAdmin(), t, sp.tenant);
    }

    try {
      const { pdfPerdido } = await reabrirViaje(t, d!.folio, fd.get('confirmar') === 'on', { id: s.userId });
      revalidatePath(`/dashboard/${id}`);
      return {
        ok: `${d!.folio} quedó abierto y vuelve a aceptar comprobantes.${pdfPerdido ? ' El PDF anterior ya no es válido.' : ''}`,
      };
    } catch (err) {
      return { error: mensajeParaPantalla(err, 'reabrir el viaje') };
    }
  }

  /**
   * FE-11: devuelve el rechazo, no lo lanza.
   *
   * Antes esto era `(fd) => Promise<void>` con un `await reasignarOperador`
   * pelón: un chofer dado de baja o un fallo de red lanzaba DENTRO de la
   * action y `error.tsx` se llevaba la pantalla entera —«No se pudo cargar el
   * panel»— por un cambio de chofer. Y el rechazo de permiso era un `redirect`
   * mudo: la pantalla volvía igual, sin decir que no se hizo.
   */
  async function reasignar(_previo: ResultadoAccion, formData: FormData): Promise<ResultadoAccion> {
    'use server';
    // Repite la comprobación de permiso EN el server action: el `puedeAsignar`
    // de arriba solo decide si el <form> se pinta. Sin este segundo chequeo,
    // un contador que arme la petición a mano (misma sesión válida, sin el
    // botón) podría reasignar igual — el mismo criterio que ya usa
    // `requireSessionTenant` para no confiar solo en lo que el proxy filtra.
    const { tenantId: tDemo, rol: r } = await requireSessionTenant(`/dashboard/${id}`, sp);
    if (!puedeAsignar(r)) return { error: 'Tu rol no puede reasignar choferes.' };
    let t = tDemo;
    if (r === 'superadmin' && sp?.tenant) {
      t = await resolverTenantPedido(supabaseAdmin(), t, sp.tenant);
    }
    const operadorId = String(formData.get('operadorId') ?? '');
    if (!operadorId) {
      return { error: 'Elige un chofer de la lista: escribir un nombre a medias no basta, y adivinar a quién te referías no es cosa de este panel.' };
    }
    try {
      await reasignarOperador(t, d!.viajeId, operadorId);
      revalidatePath(`/dashboard/${id}`);
      return { ok: 'Listo: el viaje quedó a nombre del chofer que elegiste.' };
    } catch (err) {
      return { error: mensajeParaPantalla(err, 'reasignar el chofer') };
    }
  }

  /**
   * FE-2: el `<select>` de "Reasignar chofer" traía el catálogo COMPLETO
   * (`listOperadores` sin `.limit()`), que PostgREST recortaba a 1,000 en
   * silencio — con 7,500 choferes, reasignar al 1,001 era imposible desde la
   * pantalla y nada lo decía. Ahora se busca en el servidor, 20 a la vez; el
   * chofer ACTUAL se pinta desde `d.operadorNombre`, que ya viene con el
   * detalle, así que el control arranca diciendo la verdad sin catálogo.
   *
   * Guardia idéntica a `reasignar` (el server action de al lado): esto es
   * alcanzable por POST directo y devuelve nombres de UNA flota. Lanza ante
   * rechazo o fallo — una lista vacía afirmaría "ningún chofer se llama así".
   */
  async function buscarOperadores(tipo: TipoCatalogo, q: string): Promise<OpcionCatalogo[]> {
    'use server';
    const s = await requireSessionTenant(`/dashboard/${id}`, sp);
    if (!puedeAsignar(s.rol)) throw new Error('Tu rol no puede reasignar choferes.');
    if (tipo !== 'operador') throw new Error('Catálogo desconocido.');
    let t = s.tenantId;
    if (s.rol === 'superadmin' && sp?.tenant) {
      t = await resolverTenantPedido(supabaseAdmin(), t, sp.tenant);
    }
    return buscarCatalogo(t, 'operador', typeof q === 'string' ? q : '');
  }

  // ── LA FIRMA HUMANA (auditoría 24, BLOQ-6 — mig. 0299) ──────────────────
  //
  // Hasta hoy no había NI UN `update` sobre `liquidacion` en toda la app: el
  // agente cerraba y nadie firmaba. `leerRevision` degrada solo — si no se
  // pudo leer, el panel NO se pinta: unos botones sin saber si la liquidación
  // ya está firmada invitan a firmarla dos veces.
  const revisionEstado: RevisionDetalle | null = await leerRevision(tenantId, id).catch(() => null);
  const puedeFirmar = puedeFirmarLiquidacion(rol);

  /**
   * Aprobar / ajustar / rechazar. TODO pasa por la RPC `revisar_liquidacion`
   * (la tabla rebota cualquier otro camino con LR003), que deja la bitácora en
   * la misma transacción. Aquí solo se re-gatea el permiso con el rol REAL —
   * el `puedeFirmar` de arriba decide si el panel se pinta, no si la petición
   * se acepta — y se traducen los rechazos a mensajes para la persona.
   */
  async function revisar(_previo: ResultadoAccion, fd: FormData): Promise<ResultadoAccion> {
    'use server';
    const s = await requireSessionTenant(`/dashboard/${id}`, sp);
    if (!puedeVerArea(s.rol, 'dinero') || !puedeFirmarLiquidacion(s.rol)) {
      return { error: 'Tu rol no firma liquidaciones. Pídeselo al dueño de la flota o a tu contador.' };
    }
    let t = s.tenantId;
    if (s.rol === 'superadmin' && sp?.tenant) {
      t = await resolverTenantPedido(supabaseAdmin(), t, sp.tenant);
    }
    const accion = String(fd.get('accion') ?? '') as AccionRevision;
    try {
      // Los ajustes viajan como `monto:<gastoId>`; los vacíos se saltan en
      // `normalizarAjustes` — un campo en blanco es "no lo toques", no un cero.
      const ajustes = accion === 'ajustar'
        ? normalizarAjustes([...fd.entries()]
          .filter(([k]) => k.startsWith('monto:'))
          .map(([k, v]) => ({ gastoId: k.slice('monto:'.length), montoNuevo: v })))
        : null;
      const r = await revisarLiquidacion({
        tenantId: t, liquidacionId: id, accion, ajustes,
        motivo: String(fd.get('motivo') ?? ''),
        // El correo lo resuelve la RPC desde `app_user` con este id (y lo
        // copia a la fila para que sobreviva a la baja del usuario).
        actor: { id: s.userId },
      });
      revalidatePath(`/dashboard/${id}`);
      revalidatePath('/dashboard/agentes/liquidacion');
      if (r.revision === 'rechazada') {
        return {
          ok: `${r.folio} se rechazó y el viaje volvió a cuadre.${
            r.choferAvisado ? ' Al operador ya le llegó el motivo por WhatsApp.'
              : ' No se le pudo avisar al operador por WhatsApp: márcale tú.'}`,
        };
      }
      if (r.revision === 'ajustada') {
        const cuantos = r.ajustes.length;
        return {
          ok: `${r.folio}: ${cuantos === 1 ? 'se corrigió 1 comprobante' : `se corrigieron ${cuantos} comprobantes`}. `
            + `El comprobado quedó en ${mxn(r.totalComprobado)} y la diferencia en ${mxn(r.diferencia)}.`
            + (r.pdfPendiente ? ' El ajuste y tu firma se guardaron; el PDF sigue pendiente. Usa Reintentar PDF para generarlo sin volver a ajustar.' : ''),
        };
      }
      return { ok: `${r.folio} quedó aprobada con tu firma.` };
    } catch (err) {
      return { error: mensajeParaPantalla(err, 'firmar la liquidación') };
    }
  }

  async function reintentarPdf(_previo: ResultadoAccion, _fd: FormData): Promise<ResultadoAccion> {
    'use server';
    const s = await requireSessionTenant(`/dashboard/${id}`, sp);
    if (!puedeVerArea(s.rol, 'dinero') || !puedeFirmarLiquidacion(s.rol)) {
      return { error: 'Tu rol no puede regenerar el PDF de una liquidación firmada.' };
    }
    let t = s.tenantId;
    if (s.rol === 'superadmin' && sp?.tenant) t = await resolverTenantPedido(supabaseAdmin(), t, sp.tenant);
    try {
      const r = await reintentarPdfAjustado(t, id);
      revalidatePath(`/dashboard/${id}`);
      return r.regenerado ? { ok: 'Los dos PDF ya están disponibles. Tu firma y las cifras se conservaron.' }
        : { error: 'El PDF sigue pendiente. Tu firma y las cifras se conservaron; vuelve a intentarlo o avisa a soporte.' };
    } catch (error) { return { error: mensajeParaPantalla(error, 'regenerar el PDF') }; }
  }

  // Cuántos choferes activos hay — `count exact, head`, cero filas de vuelta.
  // Solo para la pista "20 de N" y para no pintar el control cuando de verdad
  // no hay ninguno. `null` (no se pudo contar) NO apaga el control: no saber
  // cuántos hay no es saber que no hay.
  const totalOperadores = puedeAsignar(rol) ? await contarCatalogo(tenantId, 'operador') : 0;

  return (
    <DetalleLiquidacion
      d={d}
      sufijo={sufijo}
      estatus={{ label: e.label, estado: estadoDeColor(e.color) }}
      etiqueta={etiquetaGasto}
      pdfHref={d.pdfPath && puedeExportar(rol) ? `/api/export/pdf/${d.id}` : null}
      reintentarPdf={!d.pdfPath && revisionEstado?.revision === 'ajustada' && puedeFirmar ? reintentarPdf : null}
      wa={hrefWhatsApp(d.viaje.operadorTelefono)}
      reasignar={puedeReasignar && totalOperadores !== 0
        ? {
          buscar: buscarOperadores, total: totalOperadores,
          actual: d.operadorId, actualNombre: d.operadorNombre, accion: reasignar,
        }
        : null}
      reabrir={puedeReabrir ? reabrir : null}
      revision={revisionEstado ? {
        estado: revisionEstado,
        // Solo los comprobantes CON id se pueden ajustar: sin id no hay a qué
        // fila apuntarle, y la RPC lo rebotaría (LR017).
        gastos: d.gastos.filter((g) => g.id).map((g) => ({
          id: g.id as string, etiqueta: etiquetaGasto(g), monto: g.monto,
        })),
        accion: puedeFirmar ? revisar : null,
      } : null}
    />
  );
}

/**
 * La etiqueta del renglón tiene que decir lo MISMO que el renglón del PDF.
 *
 * El PDF imprime `etiquetaConcepto`, que para combustible se salta el mapa y
 * respeta el producto impreso en el ticket: "Combustible Magna". El panel usaba
 * su copia literal y del mismo comprobante decía "Diésel" (auditoría 5,
 * arquitectura, ALTO 1). No es cosmética: el estímulo de IEPS es SOLO diésel
 * (LIF 20-A fr. IV), así que etiquetar gasolina como diésel invita a acreditar
 * algo que no aplica — exactamente lo que el motor documenta querer evitar.
 *
 * `etiquetaConcepto` devuelve la clave cruda cuando su mapa no conoce el
 * concepto; ahí —y solo ahí— entra el mapa local como red.
 */
function etiquetaGasto(g: { concepto: string; ocrExtra?: Record<string, unknown> }): string {
  const delMotor = etiquetaConcepto(g.concepto, g.ocrExtra);
  return delMotor === g.concepto ? (CONCEPTO[g.concepto] ?? g.concepto) : delMotor;
}
