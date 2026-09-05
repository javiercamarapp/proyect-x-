import { revalidatePath } from 'next/cache';
import { Hourglass } from 'lucide-react';
import { resolverTenantEfectivo } from '@/lib/auth/tenant-efectivo';
import { puedeVerRuta } from '@/lib/auth/visibilidad';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { mensajeParaPantalla } from '@/lib/likida/errores';
import {
  getEstadias, guardarPoliticaDetencion, vincularSitioCliente, VENTANA_ESTADIAS_DIAS,
  type EstadiasPanel,
} from '@/lib/likida/estadias/lector';
import type { EpisodioEstadia, FaseEpisodio, MotivoSinMonto } from '@/lib/likida/estadias/motor';
import { mxn, fechaHoraMx } from '@/lib/formato';
import { FormaConAviso, Campo, Selector, type ResultadoAccion } from '../../admin/ui/forma';

/**
 * ESTADÍAS Y DETENCIÓN (0207, ficha §8.3) — la sección del contralor.
 *
 * Vive en facturación por la misma razón que el auditor de cobranza: el
 * episodio que excede el pacto es un ACCESORIO COBRABLE del viaje, y quien
 * decide si se factura es el contralor — el agente prepara el renglón con su
 * evidencia, el humano factura (jamás se emite un CFDI desde aquí).
 *
 * El reloj es el de los hitos del chofer (0090) y la pantalla LO DICE: la
 * hora es la del mensaje de WhatsApp, no telemetría. Cuando el cliente tiene
 * su sitio dibujado (geocerca) y el GPS está conectado, la llegada/salida
 * MEDIDAS acompañan al reloj como evidencia independiente — las dos se
 * enseñan, ninguna se funde con la otra.
 */

const RUTA = '/dashboard/facturacion';

/** h:mm para minutos medidos. Los null no llegan aquí: se pintan aparte. */
function duracion(minutos: number): string {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return `${h}:${String(m).padStart(2, '0')} h`;
}

const ROTULO_FASE: Record<FaseEpisodio, string> = {
  corriendo: 'el reloj corre',
  cerrado: 'cerrado',
  sin_salida_medible: 'sin salida medible',
  sellos_incoherentes: 'sellos incoherentes',
};

const ROTULO_SIN_MONTO: Record<MotivoSinMonto, string> = {
  sin_minutos: 'sin ventana medible — el viaje cerró sin hito de regreso, los minutos no se inventan',
  sin_horas_libres_pactadas: 'sin horas libres pactadas — captura el pacto abajo para que el excedente se pueda afirmar',
  dentro_de_horas_libres: 'dentro de las horas libres pactadas — no hay cobro que proponer',
  sin_tarifa_pactada: 'excedido, pero sin tarifa pactada — el monto no se inventa',
};

function Evidencia({ e }: { e: EpisodioEstadia }) {
  if (e.evidencia.tipo === 'medida') {
    return (
      <span>
        GPS en {e.sitioNombre ?? 'el sitio'}: primera posición {fechaHoraMx(e.evidencia.primeraEnSitio)},
        {' '}última {fechaHoraMx(e.evidencia.ultimaEnSitio)} ({e.evidencia.posiciones} posiciones en el radio).
      </span>
    );
  }
  const motivo = {
    sin_sitio_del_cliente: 'el cliente no tiene sitio dibujado — vincúlale una geocerca abajo para medir con GPS',
    sin_unidad: 'el viaje no tiene unidad asignada',
    sin_posiciones_en_sitio: 'sin posiciones GPS dentro del radio del sitio en la ventana — GPS sin conectar, o hueco de señal',
  }[e.evidencia.motivo];
  return <span>Sin medición GPS: {motivo}. El reloj mostrado es el de los avisos por WhatsApp.</span>;
}

function Renglon({ e }: { e: EpisodioEstadia }) {
  const d = e.detencion;
  return (
    <details className="rounded-xl hairline px-3.5 py-2.5">
      <summary className="cursor-pointer flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <span className="font-medium">{e.folio ?? `viaje ${e.viajeId.slice(0, 8)}`}</span>
        <span style={{ color: 'var(--muted)' }}>{e.clienteNombre ?? 'sin cliente'}</span>
        {e.unidadEconomico && <span style={{ color: 'var(--muted)' }}>unidad {e.unidadEconomico}</span>}
        <span style={{ color: 'var(--muted)' }}>
          {e.minutosSitio !== null ? duracion(e.minutosSitio) : ROTULO_FASE[e.fase]}
          {e.fase === 'corriendo' && ' · corriendo'}
        </span>
        <span className="ml-auto font-medium">
          {d.monto !== null ? `${mxn(d.monto)} propuestos` : '—'}
        </span>
      </summary>
      <div className="mt-2.5 flex flex-col gap-1 text-xs" style={{ color: 'var(--muted)' }}>
        <span>
          Ruta: {e.origen ?? '—'} → {e.destino ?? '—'}. Sitio: {e.sitioNombre ?? 'sin sitio dibujado'}.
        </span>
        <span>
          Llegada (aviso del chofer): {fechaHoraMx(e.llegadaEn)}.
          {e.descargaEn && <> Descargando desde: {fechaHoraMx(e.descargaEn)}.</>}
          {' '}Salida: {e.regresoEn ? fechaHoraMx(e.regresoEn) : ROTULO_FASE[e.fase]}.
        </span>
        <span><Evidencia e={e} /></span>
        {d.monto !== null ? (
          <span>
            Horas libres pactadas: {d.horasLibres} h ({e.origenPolitica === 'cliente' ? 'pacto del cliente' : 'pacto de flota'}).
            {' '}Excedente: {duracion(d.minutosExcedentes as number)} → {d.horasCobrables} h cobrables (hora o fracción)
            {' '}× tarifa pactada = <strong>{mxn(d.monto)}</strong>. Renglón PROPUESTO: lo factura el contralor, no el agente.
          </span>
        ) : (
          <span>{ROTULO_SIN_MONTO[d.motivoSinMonto as MotivoSinMonto]}</span>
        )}
      </div>
    </details>
  );
}

// Referencia de módulo: las Server Actions sólo capturan `sp`, serializable.
// Una función local quedaría en sus argumentos cifrados y rompería el render.
// Vacío conserva null: nadie pactó cero por dejar el campo sin llenar.
function perilla(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? '').trim();
  return s === '' ? null : Number(s.replace(',', '.'));
}

export async function BloqueEstadias({
  sp,
}: {
  sp: { tenant?: string; rol?: string; vista?: string };
}) {
  const { tenantId, rol } = await resolverTenantEfectivo(RUTA, sp);
  if (!puedeVerRuta(rol, RUTA)) return null;

  // Lecturas independientes de la cartera: su fallo pinta el error dicho, no
  // una sección vacía que se leería como "sin estadías".
  let panel: EstadiasPanel | null = null;
  let clientes: Array<{ id: string; nombre: string; geocercaId: string | null }> = [];
  let geocercas: Array<{ id: string; nombre: string }> = [];
  let leyoOk = true;
  try {
    panel = await getEstadias(tenantId);
    const admin = supabaseAdmin();
    const [c, g] = await Promise.all([
      admin.from('cliente').select('id, nombre, geocerca_id')
        .eq('tenant_id', tenantId).eq('activo', true).order('nombre').limit(500),
      admin.from('geocerca').select('id, nombre')
        .eq('tenant_id', tenantId).eq('activa', true).order('nombre').limit(500),
    ]);
    if (c.error || g.error) throw new Error(c.error?.message ?? g.error?.message);
    clientes = (c.data ?? []).map((x) => ({
      id: String(x.id), nombre: String(x.nombre), geocercaId: (x.geocerca_id as string | null) ?? null,
    }));
    geocercas = (g.data ?? []).map((x) => ({ id: String(x.id), nombre: String(x.nombre) }));
  } catch (e) {
    leyoOk = false;
    logger.warn('estadias.no_leido', { tenantId, err: e instanceof Error ? e.message : String(e) });
  }

  async function pactarFlota(_previo: ResultadoAccion, fd: FormData): Promise<ResultadoAccion> {
    'use server';
    const s = await resolverTenantEfectivo(RUTA, sp);
    if (!puedeVerRuta(s.rol, RUTA)) return { error: 'Tu rol no puede pactar la detención.' };
    try {
      await guardarPoliticaDetencion(s.tenantId, null, {
        horasLibres: perilla(fd.get('horasLibres')),
        tarifaHora: perilla(fd.get('tarifaHora')),
      }, s.userId);
    } catch (e) {
      return { error: mensajeParaPantalla(e, 'pactar la detención de flota') };
    }
    revalidatePath(RUTA);
    return { ok: 'Pacto de flota guardado. Los episodios sin pacto propio ya se valoran contra él.' };
  }

  async function pactarCliente(_previo: ResultadoAccion, fd: FormData): Promise<ResultadoAccion> {
    'use server';
    const s = await resolverTenantEfectivo(RUTA, sp);
    if (!puedeVerRuta(s.rol, RUTA)) return { error: 'Tu rol no puede pactar la detención.' };
    const clienteId = String(fd.get('clienteId') ?? '');
    if (!clienteId) return { error: 'Elige el cliente del pacto.' };
    try {
      await guardarPoliticaDetencion(s.tenantId, clienteId, {
        horasLibres: perilla(fd.get('horasLibres')),
        tarifaHora: perilla(fd.get('tarifaHora')),
      }, s.userId);
      // El sitio se vincula en el mismo envío porque es el mismo gesto de
      // configuración; '' = no tocar el vínculo, 'ninguno' = desvincular.
      const sitio = String(fd.get('geocercaId') ?? '');
      if (sitio === 'ninguno') await vincularSitioCliente(s.tenantId, clienteId, null);
      else if (sitio !== '') await vincularSitioCliente(s.tenantId, clienteId, sitio);
    } catch (e) {
      return { error: mensajeParaPantalla(e, 'pactar la detención del cliente') };
    }
    revalidatePath(RUTA);
    return { ok: 'Pacto del cliente guardado — gana sobre el de flota.' };
  }

  return (
    <section className="mt-3 rounded-2xl px-5 py-4 flex flex-col gap-3 hairline" style={{ background: 'var(--surface)' }}>
      <div className="flex items-start gap-2.5">
        <Hourglass width={16} height={16} strokeWidth={1.75} className="mt-0.5 shrink-0" style={{ color: 'var(--muted)' }} />
        <div className="min-w-0">
          <p className="text-sm font-medium">Estadías y detención</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
            El reloj abre con el aviso del chofer (&ldquo;ya llegué&rdquo;) y cierra con &ldquo;voy de
            regreso&rdquo; — hora del mensaje, no telemetría. Al exceder las horas libres pactadas, el
            excedente sale como renglón propuesto: facturarlo lo decides tú. Ventana: llegadas de los
            últimos {VENTANA_ESTADIAS_DIAS} días{panel ? ` (${panel.ventana.desde} → ${panel.ventana.hasta})` : ''}.
          </p>
        </div>
      </div>

      {!leyoOk || panel === null ? (
        <p className="text-xs" style={{ color: 'var(--bad)' }}>
          No pude leer las estadías — recarga. Sin lectura no se afirma que no haya episodios.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--muted)' }}>
            <span><strong>{panel.resumen.total}</strong> episodios en la ventana</span>
            <span><strong>{panel.resumen.corriendo}</strong> con el reloj corriendo</span>
            <span>
              detención propuesta:{' '}
              <strong>{panel.resumen.montoPropuesto !== null ? mxn(panel.resumen.montoPropuesto) : 'sin montos que proponer'}</strong>
              {panel.resumen.conMonto > 0 && ` (${panel.resumen.conMonto} episodios)`}
            </span>
            {panel.resumen.sinPolitica > 0 && (
              <span>{panel.resumen.sinPolitica} sin pacto — se miden pero no se valoran</span>
            )}
            {panel.resumen.sinSalidaMedible > 0 && (
              <span>{panel.resumen.sinSalidaMedible} sin salida medible</span>
            )}
          </div>

          {panel.episodios.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Ningún viaje selló llegada en la ventana. Los hitos del chofer por WhatsApp son los que
              abren episodios.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {panel.episodios.slice(0, 40).map((e) => <Renglon key={e.viajeId} e={e} />)}
              {panel.episodios.length > 40 && (
                <p className="text-xs" style={{ color: 'var(--muted)' }}>
                  Se muestran los primeros 40 de {panel.episodios.length} (ordenados por monto propuesto);
                  el resumen de arriba cuenta TODOS.
                </p>
              )}
            </div>
          )}

          <details className="rounded-xl hairline px-4 py-3">
            <summary className="text-xs font-medium cursor-pointer">
              Pactos de detención — flota y por cliente
            </summary>
            <div className="mt-3 flex flex-col gap-4">
              <div>
                <p className="text-xs mb-2" style={{ color: 'var(--muted)' }}>
                  Pacto de flota (aplica a cualquier cliente sin pacto propio).
                  {panel.politicaFlota
                    ? ` Vigente: ${panel.politicaFlota.horasLibres ?? 'sin'} h libres, tarifa ${panel.politicaFlota.tarifaHora !== null ? mxn(panel.politicaFlota.tarifaHora) : 'sin pactar'}/h.`
                    : ' Sin pacto de flota todavía.'}
                </p>
                <FormaConAviso accion={pactarFlota} boton="Guardar pacto de flota">
                  <Campo nombre="horasLibres" etiqueta="Horas libres" tipo="number"
                    valorInicial={panel.politicaFlota?.horasLibres?.toString() ?? ''}
                    ayuda="Vacío = no pactado: el episodio se mide, no se valora." />
                  <Campo nombre="tarifaHora" etiqueta="Tarifa MXN por hora (o fracción) excedente" tipo="number"
                    valorInicial={panel.politicaFlota?.tarifaHora?.toString() ?? ''}
                    ayuda="Vacío = sin tarifa: el excedente se dice en minutos, sin monto." />
                </FormaConAviso>
              </div>
              <div>
                <p className="text-xs mb-2" style={{ color: 'var(--muted)' }}>
                  Pacto por cliente — gana sobre el de flota. Vincular su sitio (geocerca) permite
                  medir la llegada/salida con GPS, además del aviso por WhatsApp.
                </p>
                {clientes.length === 0 ? (
                  <p className="text-xs" style={{ color: 'var(--muted)' }}>
                    No tienes clientes dados de alta — el pacto por cliente se captura cuando exista alguno.
                  </p>
                ) : (
                  <FormaConAviso accion={pactarCliente} boton="Guardar pacto del cliente">
                    <Selector nombre="clienteId" etiqueta="Cliente" requerido
                      opciones={[{ valor: '', texto: 'Elige…' }, ...clientes.map((c) => ({ valor: c.id, texto: c.nombre }))]} />
                    <Campo nombre="horasLibres" etiqueta="Horas libres" tipo="number"
                      ayuda="Vacío = no pactado." />
                    <Campo nombre="tarifaHora" etiqueta="Tarifa MXN por hora excedente" tipo="number"
                      ayuda="Vacío = sin tarifa." />
                    <Selector nombre="geocercaId" etiqueta="Sitio del cliente (geocerca)"
                      opciones={[
                        { valor: '', texto: 'No cambiar' },
                        { valor: 'ninguno', texto: 'Quitar vínculo' },
                        ...geocercas.map((g) => ({ valor: g.id, texto: g.nombre })),
                      ]}
                      ayuda="Se dibujan en el mapa; sin sitio, la estadía se mide solo con los hitos." />
                  </FormaConAviso>
                )}
              </div>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
