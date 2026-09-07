import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { Calculator } from 'lucide-react';
import { resolverTenantEfectivo } from '@/lib/auth/tenant-efectivo';
import { puedeVerRuta } from '@/lib/auth/visibilidad';
import { logger } from '@/lib/logger';
import { mensajeParaPantalla } from '@/lib/likida/errores';
import { mxn, porcentaje, fechaHoraMx, fechaMx, numero } from '@/lib/formato';
import { gananciaReal } from '@/lib/likida/cotizador/motor';
import {
  getPanelCotizador, guardarConfigCotizador, crearCotizacion, marcarEnviada, marcarPerdida,
  convertirEnViaje, type PanelCotizador, type CotizacionRow,
} from '@/lib/likida/cotizador/lector';
import { FormaConAviso, Campo, Selector, type ResultadoAccion, type AccionDeForma } from '../../admin/ui/forma';
import { FilaAccionesCotizacion } from './acciones';

export const dynamic = 'force-dynamic';

const RUTA = '/dashboard/cotizaciones';

/**
 * EL COTIZADOR DE GANANCIA REAL (0225, A8 del plan; decisión de Javier del
 * 27-ago-2026) — la etapa 1 del ciclo: saber si el viaje deja dinero ANTES
 * de aceptarlo.
 *
 * ── LA PUERTA ─────────────────────────────────────────────────────────────
 * Área `dinero` (`puedeVerRuta`), espejo de la RLS `ve_finanzas()` que la
 * 0051 le puso a `cotizacion`: aquí viven costos y márgenes. Todo corre con
 * `supabaseAdmin()`, así que ESTA es la puerta — y cada server action la
 * re-resuelve adentro, no confía en que la página ya la pasó.
 *
 * ── LO QUE ESTA PANTALLA NO HACE ──────────────────────────────────────────
 * No inventa precio: el sugerido sale de costos DECLARADOS y trae cada
 * supuesto en la línea (el que falta, se dice). No convierte sola: la
 * cotización se vuelve viaje con un clic HUMANO, y el doble clic lo
 * resuelve la base (claim en `decidida_en`, 0225).
 */
export default async function PaginaCotizaciones({
  searchParams,
}: {
  searchParams: Promise<{ tenant?: string; rol?: string; vista?: string }>;
}) {
  const sp = await searchParams;
  const { tenantId, rol } = await resolverTenantEfectivo(RUTA, sp);
  if (!puedeVerRuta(rol, RUTA)) redirect('/dashboard');

  let panel: PanelCotizador | null = null;
  try {
    panel = await getPanelCotizador(tenantId);
  } catch (e) {
    logger.warn('cotizador.no_leido', { tenantId, err: e instanceof Error ? e.message : String(e) });
  }

  // '' = no declarado (null). Number('') sería 0, y un costo de $0 inventado
  // es exactamente la cotización que pierde dinero con cara de ganancia.
  const perilla = (v: FormDataEntryValue | null): number | null => {
    const s = String(v ?? '').trim();
    return s === '' ? null : Number(s.replace(',', '.'));
  };

  async function guardarConfig(_p: ResultadoAccion, fd: FormData): Promise<ResultadoAccion> {
    'use server';
    const s = await resolverTenantEfectivo(RUTA, sp);
    if (!puedeVerRuta(s.rol, RUTA)) return { error: 'Tu rol no puede declarar costos.' };
    try {
      await guardarConfigCotizador(s.tenantId, {
        dieselPorKm: perilla(fd.get('dieselPorKm')),
        salarioDia: perilla(fd.get('salarioDia')),
        viaticosDia: perilla(fd.get('viaticosDia')),
        fijosPorKm: perilla(fd.get('fijosPorKm')),
        factorRegresoVacio: perilla(fd.get('factorRegresoVacio')),
        margenObjetivoPct: perilla(fd.get('margenObjetivoPct')),
      }, s.userId ?? null);
    } catch (e) {
      return { error: mensajeParaPantalla(e, 'guardar los costos declarados') };
    }
    revalidatePath(RUTA);
    return { ok: 'Costos declarados. Las cotizaciones NUEVAS ya se arman con ellos (las viejas conservan su desglose).' };
  }

  async function cotizar(_p: ResultadoAccion, fd: FormData): Promise<ResultadoAccion> {
    'use server';
    const s = await resolverTenantEfectivo(RUTA, sp);
    if (!puedeVerRuta(s.rol, RUTA)) return { error: 'Tu rol no puede cotizar.' };
    try {
      await crearCotizacion(s.tenantId, {
        clienteId: String(fd.get('clienteId') ?? '') || null,
        origen: String(fd.get('origen') ?? ''),
        destino: String(fd.get('destino') ?? ''),
        km: perilla(fd.get('km')),
        dias: perilla(fd.get('dias')),
        casetasManual: perilla(fd.get('casetasManual')),
        precio: perilla(fd.get('precio')),
        folio: String(fd.get('folio') ?? '') || null,
        vigenteHasta: String(fd.get('vigenteHasta') ?? '') || null,
      }, s.userId ?? null);
    } catch (e) {
      return { error: mensajeParaPantalla(e, 'crear la cotización') };
    }
    revalidatePath(RUTA);
    return { ok: 'Cotización creada con su desglose citable. Revísala abajo.' };
  }

  // FE-13b: las tres eran `(fd) => Promise<void>` — sin `useActionState` no
  // hay estado `pending` (doble clic manda dos veces) y el `catch` se tragaba
  // el error en el log; el humano solo veía la fila SIN cambiar tras el
  // `revalidatePath` y no sabía si su clic hizo algo. Ahora todas devuelven
  // `ResultadoAccion`, como el resto de las forms del panel.
  async function accionEnviada(_prev: ResultadoAccion, fd: FormData): Promise<ResultadoAccion> {
    'use server';
    const s = await resolverTenantEfectivo(RUTA, sp);
    if (!puedeVerRuta(s.rol, RUTA)) return { error: 'Tu rol no puede editar cotizaciones.' };
    try {
      await marcarEnviada(s.tenantId, String(fd.get('id') ?? ''));
    } catch (e) {
      return { error: mensajeParaPantalla(e, 'marcar la cotización como enviada') };
    }
    revalidatePath(RUTA);
    return { ok: 'Marcada como enviada.' };
  }

  async function accionPerdida(_prev: ResultadoAccion, fd: FormData): Promise<ResultadoAccion> {
    'use server';
    const s = await resolverTenantEfectivo(RUTA, sp);
    if (!puedeVerRuta(s.rol, RUTA)) return { error: 'Tu rol no puede editar cotizaciones.' };
    const como = String(fd.get('como')) === 'vencida' ? 'vencida' : 'perdida';
    try {
      await marcarPerdida(s.tenantId, String(fd.get('id') ?? ''), como, s.userId ?? null);
    } catch (e) {
      return { error: mensajeParaPantalla(e, como === 'vencida' ? 'marcar como vencida' : 'marcar como perdida') };
    }
    revalidatePath(RUTA);
    return { ok: como === 'vencida' ? 'Marcada como vencida.' : 'Marcada como perdida.' };
  }

  async function accionConvertir(_prev: ResultadoAccion, fd: FormData): Promise<ResultadoAccion> {
    'use server';
    const s = await resolverTenantEfectivo(RUTA, sp);
    if (!puedeVerRuta(s.rol, RUTA)) return { error: 'Tu rol no puede crear viajes desde aquí.' };
    try {
      await convertirEnViaje(s.tenantId, String(fd.get('id') ?? ''), s.userId ?? null);
    } catch (e) {
      // El motivo honesto (sin precio, ya decidida…) ahora también llega a
      // pantalla, no solo al log.
      return { error: mensajeParaPantalla(e, 'crear el viaje desde esta cotización') };
    }
    revalidatePath(RUTA);
    return { ok: 'Viaje creado desde esta cotización.' };
  }

  const c = panel?.config;
  const opcionesCliente = [
    { valor: '', texto: '— sin cliente (prospecto) —' },
    ...(panel?.clientes ?? []).map((x) => ({ valor: x.id, texto: x.nombre })),
  ];

  return (
    <div className="space-y-8">
      <header className="flex items-center gap-3">
        <Calculator className="h-6 w-6" style={{ color: 'var(--muted)' }} aria-hidden />
        <div>
          <h1 className="text-xl font-semibold">Cotizador</h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            La ganancia real del viaje antes de aceptarlo: costos declarados, casetas medidas
            en tus viajes liquidados, y cada supuesto a la vista.
          </p>
        </div>
      </header>

      {!panel && (
        <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          No se pudo leer el cotizador. No es que no haya cotizaciones: la lectura falló.
          Recarga; si sigue, es cosa nuestra.
        </p>
      )}

      {panel && (
        <>
          <section className="rounded-lg border p-4">
            <h2 className="mb-1 font-medium">Costos declarados de la flota</h2>
            <p className="mb-3 text-sm" style={{ color: 'var(--muted)' }}>
              Lo que TÚ declaras — nada se supone. Un campo vacío = sin declarar, y el
              cotizador entonces no sugiere precio: dice qué falta.
            </p>
            <FormaConAviso accion={guardarConfig} boton="Guardar costos">
              <Campo nombre="dieselPorKm" etiqueta="Diésel ($/km)" valorInicial={c?.dieselPorKm === null || c?.dieselPorKm === undefined ? '' : String(c.dieselPorKm)} ayuda="combustible por km, como lo calcules" />
              <Campo nombre="fijosPorKm" etiqueta="Fijos ($/km)" valorInicial={c?.fijosPorKm === null || c?.fijosPorKm === undefined ? '' : String(c.fijosPorKm)} ayuda="seguros, admin, depreciación prorrateados" />
              <Campo nombre="salarioDia" etiqueta="Salario operador ($/día)" valorInicial={c?.salarioDia === null || c?.salarioDia === undefined ? '' : String(c.salarioDia)} />
              <Campo nombre="viaticosDia" etiqueta="Viáticos ($/día)" valorInicial={c?.viaticosDia === null || c?.viaticosDia === undefined ? '' : String(c.viaticosDia)} ayuda="si no pagas viáticos, declara 0 — no lo dejes vacío" />
              <Campo nombre="factorRegresoVacio" etiqueta="Factor de regreso (1–3)" valorInicial={c?.factorRegresoVacio === null || c?.factorRegresoVacio === undefined ? '' : String(c.factorRegresoVacio)} ayuda="1 = regreso cargado; 2 = la ruta se cobra redonda" />
              <Campo nombre="margenObjetivoPct" etiqueta="Margen objetivo (%)" valorInicial={c?.margenObjetivoPct === null || c?.margenObjetivoPct === undefined ? '' : String(c.margenObjetivoPct)} ayuda="markup sobre el costo, 0–90" />
            </FormaConAviso>
          </section>

          <section className="rounded-lg border p-4">
            <h2 className="mb-1 font-medium">Nueva cotización</h2>
            <p className="mb-3 text-sm" style={{ color: 'var(--muted)' }}>
              Si esta ruta tiene viajes liquidados, las casetas salen MEDIDAS de ahí (y la
              captura manual se ignora — la medición gana y el desglose lo dice).
            </p>
            <FormaConAviso accion={cotizar} boton="Cotizar">
              <Selector nombre="clienteId" etiqueta="Cliente" opciones={opcionesCliente} />
              <Campo nombre="origen" etiqueta="Origen" requerido />
              <Campo nombre="destino" etiqueta="Destino" requerido />
              <Campo nombre="km" etiqueta="Km de la ruta" ayuda="de ida; el factor de regreso hace el resto" />
              <Campo nombre="dias" etiqueta="Días de viaje" ayuda="los declara quien cotiza; el desglose los cita" />
              <Campo nombre="casetasManual" etiqueta="Casetas ($, si no hay medición)" />
              <Campo nombre="precio" etiqueta="Precio a cotizar ($)" ayuda="tu decisión — el sugerido es referencia, no captura sola" />
              <Campo nombre="folio" etiqueta="Folio" />
              <Campo nombre="vigenteHasta" etiqueta="Vigente hasta" tipo="date" />
            </FormaConAviso>
          </section>

          <section className="rounded-lg border p-4">
            <h2 className="mb-3 font-medium">
              Cotizaciones ({panel.cotizaciones.length})
            </h2>
            {panel.cotizaciones.length === 0 && (
              <p className="text-sm" style={{ color: 'var(--muted)' }}>
                Aún no hay cotizaciones. La primera se arma arriba — con los costos
                declarados y, si la ruta ya se corrió, con las casetas medidas.
              </p>
            )}
            <ul className="space-y-3">
              {panel.cotizaciones.map((q) => <Fila key={q.id} q={q} enviada={accionEnviada} perdida={accionPerdida} convertir={accionConvertir} />)}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function Fila({
  q, enviada, perdida, convertir,
}: {
  q: CotizacionRow;
  enviada: AccionDeForma;
  perdida: AccionDeForma;
  convertir: AccionDeForma;
}) {
  const viva = q.estado === 'borrador' || q.estado === 'enviada';
  // EL NÚMERO QUE EL TÍTULO DE ESTA PANTALLA PROMETE. `null` = todavía no se
  // puede afirmar (falta el precio o falta un renglón del costo), y entonces
  // se dice eso — nunca "$0.00", que se leería como un viaje que sale a mano.
  const g = gananciaReal(q.precio, q.costoEstimado);
  return (
    <li className="rounded-md border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-sm">
          <span className="font-medium">{q.origen} → {q.destino}</span>
          {q.folio && <span className="ml-2" style={{ color: 'var(--muted)' }}>({q.folio})</span>}
          <span className="ml-2" style={{ color: 'var(--muted)' }}>{q.clienteNombre ?? 'sin cliente'}</span>
          {q.km !== null && <span className="ml-2" style={{ color: 'var(--muted)' }}>{numero(q.km)} km</span>}
        </div>
        <div className="text-sm">
          <span className="mr-3">costo: {q.costoEstimado !== null ? mxn(q.costoEstimado) : 'incompleto'}</span>
          <span className="mr-3 font-medium">precio: {q.precio !== null ? mxn(q.precio) : 'a medias — sin precio'}</span>
          <span className="mr-3 font-medium">
            ganancia:{' '}
            {g === null ? (
              <span className="font-normal" style={{ color: 'var(--muted)' }}>
                {q.precio === null ? 'falta el precio' : 'falta un dato del costo'}
              </span>
            ) : (
              <span style={{ color: g.pesos < 0 ? 'var(--color-bad)' : 'var(--color-ok)' }}>
                {mxn(g.pesos)}
                {g.margenPct !== null && (
                  <span className="font-normal"> ({porcentaje(g.margenPct)})</span>
                )}
              </span>
            )}
          </span>
          <span
            className="rounded px-2 py-0.5 text-xs uppercase"
            style={{ background: 'var(--canvas)', color: 'var(--ink2)' }}
          >{q.estado}</span>
        </div>
      </div>

      {q.desglose && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer" style={{ color: 'var(--ink2)' }}>Desglose citable (como se armó)</summary>
          <ul className="mt-2 space-y-1">
            {q.desglose.lineas.map((l, i) => (
              <li key={i} className="flex justify-between gap-4">
                <span>{l.concepto} <span style={{ color: 'var(--muted)' }}>— {l.supuesto}</span></span>
                <span className="whitespace-nowrap">{l.monto !== null ? mxn(l.monto) : '—'}</span>
              </li>
            ))}
            <li className="flex justify-between border-t pt-1 font-medium">
              <span>Costo total</span>
              <span>{q.desglose.costoTotal !== null ? mxn(q.desglose.costoTotal) : 'incompleto'}</span>
            </li>
            <li className="flex justify-between font-medium">
              <span>Precio sugerido</span>
              <span>{q.desglose.precioSugerido !== null ? mxn(q.desglose.precioSugerido) : 'sin sugerencia'}</span>
            </li>
          </ul>
          {q.tarifaCatalogo && (
            <p className="mt-2" style={{ color: 'var(--ink2)' }}>
              Tarifa del catálogo: {q.tarifaCatalogo.monto !== null ? mxn(q.tarifaCatalogo.monto) : 'sin monto (falta un dato de la tarifa)'}
              {' '}— {q.tarifaCatalogo.porque}{q.tarifaCatalogo.ambigua ? ' · ⚠️ el catálogo tiene dos verdades para esta ruta' : ''}
            </p>
          )}
          {q.desglose.faltantes.length > 0 && (
            <p className="mt-2" style={{ color: 'var(--color-warn)' }}>Falta: {q.desglose.faltantes.join(' · ')}</p>
          )}
          {q.desglose.notas.map((nota, i) => (
            <p key={i} className="mt-1" style={{ color: 'var(--muted)' }}>{nota}</p>
          ))}
        </details>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
        <span>creada {fechaHoraMx(q.creadaEn)}</span>
        {q.vigenteHasta && <span>· vigente hasta {fechaMx(q.vigenteHasta)}</span>}
        {q.viajeId && <span>· viaje creado</span>}
        {viva && (
          <span className="ml-auto">
            <FilaAccionesCotizacion
              id={q.id} puedeEnviar={q.estado === 'borrador'} precio={q.precio}
              enviada={enviada} convertir={convertir} perdida={perdida}
            />
          </span>
        )}
      </div>
    </li>
  );
}
