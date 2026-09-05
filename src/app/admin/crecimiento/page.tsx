import Link from 'next/link';
import { getResumenNegocio } from '@/lib/admin/negocio';
import { getAdquisicion } from '@/lib/admin/adquisicion';
import { listarCampanas, estadoIntegracionAds } from '@/lib/admin/campanas';
import { ControlCampanas } from './campanas';
import { accionPausarCampana, accionRefrescarGasto } from './acciones';
import { tenantDemo } from '@/lib/auth/tenant-demo';
import { listarProspectos, ESTADOS_PROSPECTO, conteosVacios, normalizarEstadoProspecto } from '@/lib/likida/vendedores';
import { getEmbudoActivacion, getCohortesUso } from '@/lib/admin/instrumentacion';
import { usd } from '@/lib/utils';
import { numero, fechaCorta } from '@/lib/formato';
import { ahoraMs } from '@/lib/saludo';
import { TrendingUp, CheckCircle2, DollarSign, Filter, Megaphone } from 'lucide-react';
import { BarraPagina, TituloSeccion } from '../../dashboard/resumen-visual';
import { AreaChartSimple } from '../charts';
import { HBars } from '../ui/graficas';
import { KpiTile, ChartCard } from '../ui/kit';

export const dynamic = 'force-dynamic';

/**
 * Crecimiento — con 1 solo tenant y sin instrumentación de producto (no hay
 * tabla de eventos, ni funnel, ni cohortes), casi todo lo que un board
 * esperaría ver aquí (DAU/WAU/MAU, NPS, embudo, retención) es honestamente
 * inexistente. Lo único real y relevante: el gasto de IA por día
 * (`resumen.porDia`) como proxy de "cuánto se está usando la plataforma" —
 * etiquetado así a propósito, nunca como "crecimiento de usuarios", porque
 * no hay una sola métrica de usuario real detrás.
 *
 * Anatomía de página (14-ago): BarraPagina + tarjetas sobre el lienzo tenue
 * (--g1), como consola.tsx. El H1 honesto y su párrafo se quedan — son la
 * tesis de la página — solo cambian de glass-panel a tarjeta.
 */
export default async function CrecimientoPage() {
  // FE-14 (22-ago-2026): las cuatro se pedían EN SERIE —cuatro viajes a la
  // base sumados en el reloj de la página— sin que ninguna dependiera de la
  // anterior. Salen juntas; cada una conserva su propio catch, o sea su
  // propia leyenda honesta.
  const [r, prospectos, adquisicion, campanas, embudoActivacion, cohortes] = await Promise.all([
    getResumenNegocio(),
    // El embudo de ADQUISICIÓN sí es real desde la 0105: los prospectos del
    // censo por estado del kanban. Cae por su lado a null y se DICE — un
    // embudo vacío por base caída afirmaría que no hay pipeline.
    listarProspectos().catch(() => null),
    // Costo por lead + alertas de adquisición (panel-de-adquisicion §2/§5):
    // cae por su lado a null y se DICE.
    getAdquisicion(ahoraMs()).catch(() => null),
    // El control de campañas (0123, §4) — leer y pausar; jamás crear ni subir.
    listarCampanas().catch(() => null),
    // La mitad de PRODUCTO del funnel (0251): altas → activadas → de pago,
    // contada en la base sobre tenant/liquidacion/suscripcion. null = no se
    // pudo leer, y se dice.
    getEmbudoActivacion().catch(() => null),
    // Retención por cohortes sobre producto_evento (0251). La regla vive en
    // el lib: mes sin medición = null, jamás un 0% inventado.
    getCohortesUso().catch(() => null),
  ]);
  const integracionAds = estadoIntegracionAds();

  const datosCosto = r.porDia.map((d) => ({ dia: d.dia, valor: d.costoUsd }));
  const chipsTokens = r.porDia.slice(-8).map((d) => d.tokens);
  // AUDITORÍA 10, ALTO — el H1 y el párrafo de abajo decían "Con 1 flota
  // dada de alta" y "solo existe el tenant demo" como texto fijo: con la
  // base en 0 tenants (5-ago-2026) seguían afirmando que había una.
  const esSoloDemo = r.tenants === 1 && r.flotas[0]?.id === tenantDemo();

  // El embudo activados → de pago y la retención por cohortes SALIERON de
  // esta lista el 28-ago-2026 (0251): ya se miden abajo. Lo que queda tiene
  // cada uno su razón, no un genérico «falta instrumentación».
  const sinInstrumentacion = [
    'DAU / WAU / MAU — producto_evento registra a propósito solo la FLOTA, nunca al usuario (minimización); contar usuarios activos exigiría una dimensión que hoy se decidió no recolectar',
    'NPS — necesita encuestas que no existen',
    'Adopción por feature — producto_evento mide qué pantalla se ABRE; qué se completa necesita acciones de grano fino que aún no se emiten',
  ];

  return (
    <main className="h-full">
      <div className="rounded-2xl overflow-hidden min-h-full flex flex-col hairline" style={{ background: 'var(--g1)' }}>
        <BarraPagina
          icono={<TrendingUp width={15} height={15} strokeWidth={1.75} style={{ color: 'var(--muted)' }} />}
          titulo="Crecimiento"
        />

        <div className="px-5 py-5 flex-1 space-y-2.5">
          <div className="card p-4">
            <h1 className="text-base font-semibold tracking-tight">
              {r.tenants === 0
                ? 'Sin flotas dadas de alta, todavía no hay "crecimiento" que medir'
                : `Con ${r.tenants} flota${r.tenants === 1 ? '' : 's'} dada${r.tenants === 1 ? '' : 's'} de alta, todavía no hay "crecimiento" que medir`}
            </h1>
            <p className="text-sm mt-1.5 leading-relaxed" style={{ color: 'var(--muted)' }}>
              {r.tenants === 0
                ? 'No hay ninguna flota dada de alta para graficar su historial de altas'
                : esSoloDemo
                  ? 'No hay historial de altas de flota que graficar (solo existe el tenant demo)'
                  : 'No hay historial de altas de flota que graficar todavía'}, y Likida no
              tiene instrumentación de producto — ningún conteo de usuarios activos ni embudo de registro.
              Con {r.tenants === 0 ? 'cero flotas' : `n=${r.tenants}`} cualquier tendencia de crecimiento sería un número inventado, no una señal real.
            </p>
          </div>

          {/* ── El embudo de ADQUISICIÓN — real desde la 0105 (Fase 2) ─────
              Los prospectos del censo por estado del kanban. Es pipeline de
              PROSPECTOS, no de usuarios: la conversión que se muestra es
              cerrados/total, y con cero cerrados se dice "sin cierres
              todavía" — jamás un 0% con cara de medición. */}
          {prospectos === null ? (
            <div className="card p-4">
              <TituloSeccion>Embudo de adquisición</TituloSeccion>
              <p className="text-sm mt-2" style={{ color: 'var(--bad)' }}>
                No se pudo leer el pipeline — esto NO significa que no haya prospectos.
              </p>
            </div>
          ) : prospectos.length > 0 && (() => {
            const porEstado = conteosVacios();
            for (const p of prospectos) {
              const estado = normalizarEstadoProspecto(p.estado);
              if (estado !== null) porEstado[estado]++;
            }
            const embudo = ESTADOS_PROSPECTO
              .filter((e) => e.valor !== 'lost')
              .map((e) => ({ etiqueta: e.rotulo, valor: porEstado[e.valor] }));
            return (
              <div className="card p-4">
                <div className="flex items-center gap-2">
                  <Filter width={15} height={15} strokeWidth={1.75} style={{ color: 'var(--muted)' }} />
                  <TituloSeccion>Embudo de adquisición — {numero(prospectos.length)} prospectos del censo</TituloSeccion>
                </div>
                <div className="mt-3">
                  <HBars datos={embudo} formato="entero" />
                </div>
                <p className="text-xs mt-2" style={{ color: 'var(--muted)' }}>
                  {porEstado.won > 0
                    ? `Conversión a cierre: ${porEstado.won} de ${numero(prospectos.length)}.`
                    : 'Sin cierres todavía — la conversión no se inventa con cero cerrados.'}
                  {porEstado.lost > 0 && ` ${numero(porEstado.lost)} perdidos.`}
                  {' '}El detalle por vendedor vive en <Link href="/admin/vendedores" className="underline">Vendedores</Link>;
                  lo que espera tu aprobación, en <Link href="/admin/aprobaciones" className="underline">Aprobaciones</Link>.
                </p>
              </div>
            );
          })()}

          {/* ── Costo por lead + alertas (panel-de-adquisicion §2 y §5) ────
              La regla del §2: costo real solo donde es $0 POR DISEÑO; donde
              falta la integración de gasto se dice, jamás un $0 de encuadre.
              Las alertas heredan sus umbrales de los documentos que ya los
              fijaron; las dos sin fuente de datos se declaran por nombre. */}
          {adquisicion === null ? (
            <div className="card p-4">
              <TituloSeccion>Costo por lead y alertas de adquisición</TituloSeccion>
              <p className="text-sm mt-2" style={{ color: 'var(--bad)' }}>
                No se pudo leer la adquisición — esto NO significa que no haya alertas.
              </p>
            </div>
          ) : (
            <>
              {adquisicion.alertas.length > 0 && (
                <div className="space-y-1.5">
                  {adquisicion.alertas.map((a) => (
                    <div key={`${a.id}-${a.titulo}`} className="card p-3 flex items-start gap-2.5" style={{ borderColor: 'var(--warn)' }}>
                      <span className="inline-block w-1.5 h-1.5 rounded-full mt-1.5 shrink-0" style={{ background: 'var(--warn)' }} />
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium m-0">{a.titulo}</p>
                        <p className="text-[12px] m-0 mt-0.5" style={{ color: 'var(--muted)' }}>{a.detalle}</p>
                        <p className="text-[11px] m-0 mt-0.5 etiqueta-mono" style={{ color: 'var(--faint)' }}>{a.regla}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="card p-4">
                <TituloSeccion>Costo por lead, por fuente</TituloSeccion>
                {/* FE-19: scrollea dentro de su tarjeta, no estira la página. */}
                <div className="overflow-x-auto mt-2">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="text-left border-b" style={{ borderColor: 'var(--line)' }}>
                      <th className="py-1.5 text-[11px] uppercase font-semibold" style={{ color: 'var(--muted)' }}>Fuente</th>
                      <th className="py-1.5 text-[11px] uppercase font-semibold text-right" style={{ color: 'var(--muted)' }}>Leads</th>
                      <th className="py-1.5 text-[11px] uppercase font-semibold text-right" style={{ color: 'var(--muted)' }}>Último</th>
                      <th className="py-1.5 text-[11px] uppercase font-semibold text-right" style={{ color: 'var(--muted)' }}>Costo por lead</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adquisicion.porFuente.map((f) => (
                      <tr key={f.fuente} className="border-b last:border-b-0" style={{ borderColor: 'var(--line2)' }}>
                        <td className="py-2 cifra-mono">{f.fuente}</td>
                        <td className="py-2 text-right tabular">{numero(f.leads)}</td>
                        <td className="py-2 text-right" style={{ color: 'var(--muted)' }}>{f.ultimoCapturado ? fechaCorta(f.ultimoCapturado) : '—'}</td>
                        <td className="py-2 text-right">
                          {f.costo ? <span className="tabular">{usd(f.costo.usd)}</span> : <span style={{ color: 'var(--muted)' }}>no disponible</span>}
                          <span className="block text-[10.5px]" style={{ color: 'var(--faint)' }}>{f.costoNota}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
                {adquisicion.sinFuenteDeDatos.length > 0 && (
                  <p className="text-[11px] mt-2 m-0" style={{ color: 'var(--faint)' }}>
                    Alertas del blueprint sin fuente de datos todavía: {adquisicion.sinFuenteDeDatos.map((s) => `${s.alerta} (${s.falta})`).join(' · ')}.
                  </p>
                )}
              </div>
              <div className="card p-4">
                <div className="flex items-center gap-2">
                  <Megaphone width={15} height={15} strokeWidth={1.75} style={{ color: 'var(--muted)' }} />
                  <TituloSeccion>Control de campañas</TituloSeccion>
                </div>
                {campanas === null ? (
                  <p className="text-sm mt-2 m-0" style={{ color: 'var(--bad)' }}>
                    No se pudieron leer las campañas — esto NO significa que no haya.
                  </p>
                ) : (
                  <ControlCampanas
                    campanas={campanas}
                    integracion={integracionAds}
                    leadsAds={adquisicion.porFuente
                      .filter((f) => f.fuente === 'ads' || f.fuente === 'ads-meta' || f.fuente === 'ads-google')
                      .reduce((n, f) => n + f.leads, 0)}
                    pausar={accionPausarCampana}
                    refrescar={accionRefrescarGasto}
                  />
                )}
              </div>
            </>
          )}

          {/* ── El embudo de ACTIVACIÓN — la mitad de producto (0251) ──────
              Contado en la base (embudo_activacion()): altas → con al menos
              una liquidación → con suscripción de pago activa. Con null se
              dice «no se pudo leer»; con ceros se dicen los ceros — son
              conteos reales, no encuadre. */}
          {embudoActivacion === null ? (
            <div className="card p-4">
              <TituloSeccion>Embudo de activación</TituloSeccion>
              <p className="text-sm mt-2" style={{ color: 'var(--bad)' }}>
                No se pudo leer el embudo de activación — esto NO significa que haya cero flotas.
              </p>
            </div>
          ) : (
            <div className="card p-4">
              <div className="flex items-center gap-2">
                <Filter width={15} height={15} strokeWidth={1.75} style={{ color: 'var(--muted)' }} />
                <TituloSeccion>Embudo de activación — de alta a de pago</TituloSeccion>
              </div>
              <div className="mt-3">
                <HBars
                  datos={[
                    { etiqueta: 'Flotas dadas de alta', valor: embudoActivacion.altas },
                    { etiqueta: 'Activadas (≥1 liquidación)', valor: embudoActivacion.activadas },
                    { etiqueta: 'De pago (suscripción activa)', valor: embudoActivacion.dePago },
                  ]}
                  formato="entero"
                />
              </div>
              <p className="text-xs mt-2" style={{ color: 'var(--muted)' }}>
                Contado en la base sobre tenant / liquidacion / suscripcion — las altas incluyen el tenant demo.
                {embudoActivacion.dePago === 0 && ' El cero de «de pago» es un conteo real: ninguna suscripción está en estado activo todavía.'}
              </p>
            </div>
          )}

          {/* ── Retención por COHORTES — producto_evento (0251) ────────────
              La regla de honestidad vive en construirCohortes(): un mes
              anterior al primer evento registrado es «no medido» (null),
              jamás un 0% — la tabla nació con la 0251 y pintarle churn a los
              meses pre-medición sería inventar. */}
          {cohortes === null ? (
            <div className="card p-4">
              <TituloSeccion>Retención por cohortes</TituloSeccion>
              <p className="text-sm mt-2" style={{ color: 'var(--bad)' }}>
                No se pudieron leer las cohortes — esto NO significa que no haya uso.
              </p>
            </div>
          ) : (
            <div className="card p-4">
              <TituloSeccion>Retención por cohortes — uso del panel por mes de alta</TituloSeccion>
              {cohortes.filas.length === 0 ? (
                <p className="text-sm mt-2 m-0" style={{ color: 'var(--muted)' }}>
                  Sin flotas dadas de alta: no hay cohorte que armar.
                </p>
              ) : (
                <div className="overflow-x-auto mt-2">
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="text-left border-b" style={{ borderColor: 'var(--line)' }}>
                        <th className="py-1.5 text-[11px] uppercase font-semibold" style={{ color: 'var(--muted)' }}>Cohorte (mes de alta)</th>
                        <th className="py-1.5 text-[11px] uppercase font-semibold text-right" style={{ color: 'var(--muted)' }}>Flotas</th>
                        <th className="py-1.5 text-[11px] uppercase font-semibold" style={{ color: 'var(--muted)' }}>Flotas con uso, mes a mes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cohortes.filas.map((f) => (
                        <tr key={f.cohorte} className="border-b last:border-b-0" style={{ borderColor: 'var(--line2)' }}>
                          <td className="py-2 cifra-mono">{f.cohorte}</td>
                          <td className="py-2 text-right tabular">{numero(f.flotas)}</td>
                          <td className="py-2">
                            <div className="flex flex-wrap gap-1.5">
                              {f.celdas.map((c) => (
                                <span
                                  key={c.mes}
                                  className="inline-block rounded px-1.5 py-0.5 text-[11px] tabular"
                                  style={{
                                    background: 'var(--g2)',
                                    color: c.activas === null ? 'var(--faint)' : undefined,
                                  }}
                                  title={c.mes}
                                >
                                  {c.mes.slice(5)}{' · '}
                                  {c.activas === null ? 'no medido' : `${numero(c.activas)}/${numero(f.flotas)}`}
                                  {c.enCurso && c.activas !== null ? ' (en curso)' : ''}
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-xs mt-2 m-0" style={{ color: 'var(--muted)' }}>
                {cohortes.desdeMedicion === null
                  ? 'producto_evento (0251) todavía no registra un solo evento: cada celda dice «no medido», que no es un 0% — la matriz se llena sola conforme el panel se use.'
                  : `La medición empezó en ${cohortes.desdeMedicion}; los meses anteriores se pintan «no medido», nunca 0. El mes en curso está incompleto por definición.`}
                {' '}Con pocas flotas la cohorte describe, no concluye — necesita más de 1 cliente real para decir algo general.
              </p>
            </div>
          )}

          {/* ChartCard (design system v2, ui/kit.tsx) — mismo AreaChartSimple
              de siempre (charts.tsx sigue vigente para esta forma de dato:
              una sola serie continua en el tiempo); `tamano="L"` porque es
              la única gráfica real de la página, la pieza dominante. */}
          <ChartCard
            titulo="Uso de la plataforma en el tiempo"
            subtitulo="No es una métrica de usuarios — es el gasto real de IA por día, el proxy más honesto que existe hoy de cuánto se está usando Likida."
            tamano="L"
          >
            {datosCosto.length > 1 ? (
              <AreaChartSimple datos={datosCosto} etiquetaValor={usd} />
            ) : (
              <div className="text-sm py-10 text-center" style={{ color: 'var(--muted)' }}>
                Sin historial suficiente todavía.
              </div>
            )}
          </ChartCard>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            <KpiTile
              icono={<CheckCircle2 width={15} height={15} strokeWidth={1.75} style={{ color: 'var(--marca)' }} />}
              etiqueta="Viajes procesados" valor={r.viajesProcesados} formato="entero"
            />
            <KpiTile
              icono={<DollarSign width={15} height={15} strokeWidth={1.75} style={{ color: 'var(--marca)' }} />}
              etiqueta="Tokens usados" valor={r.tokensIn + r.tokensOut} formato="numero"
              tendencia={r.tendenciaTokens} sparkline={chipsTokens}
            />
          </div>

          <div className="card p-4">
            <TituloSeccion>Lo que esta página todavía no puede mostrar</TituloSeccion>
            <ul className="space-y-2 text-sm mt-3">
              {sinInstrumentacion.map((item) => (
                <li key={item} className="flex items-start gap-2.5">
                  <span className="w-1 h-1 rounded-full mt-2 shrink-0" style={{ background: 'var(--muted)' }} />
                  <span style={{ color: 'var(--muted)' }}>{item}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs mt-3" style={{ color: 'var(--muted)' }}>
              Cada renglón dice su propia razón — desde la 0251 ya NO es un genérico «falta instrumentación»:
              el embudo de activación y las cohortes se miden arriba.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
