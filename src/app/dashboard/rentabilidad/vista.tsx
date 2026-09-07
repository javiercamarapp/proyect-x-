import Link from 'next/link';
import {
  ChartNoAxesCombined, Banknote, ReceiptText, TrendingUp, Wallet, CalendarClock,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import type { Rentabilidad, Cobranza } from '@/lib/likida/comercial';
import { StatCard, EstadoVacio, EstadoError } from '@/app/admin/ui/kit';
import { mxn, fechaCorta, numero, porcentaje } from '@/lib/formato';
import { BarraPagina } from '../resumen-visual';

const BTN_PAGINA = 'inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12.5px] font-medium hairline transition-colors hover:bg-[var(--canvas)]';

/** El href de otra página de la cartera, conservando el sufijo de
 *  previsualización (`?tenant=`/`?vista=`/`?rol=`): si un link lo pierde, el
 *  siguiente clic devuelve al superadmin a otra flota sin avisar. */
export function hrefPagina(sufijo: string, pagina: number): string {
  const params = new URLSearchParams(sufijo.startsWith('?') ? sufijo.slice(1) : sufijo);
  if (pagina > 1) params.set('p', String(pagina)); else params.delete('p');
  const qs = params.toString();
  return `/dashboard/rentabilidad${qs ? `?${qs}` : ''}`;
}

/**
 * La vista de Rentabilidad y cobranza — pura props para poder verificarla
 * mirando con fixtures. Tres estados por bloque: datos reales, vacío que
 * explica qué lo enciende, o el error dicho (nunca un vacío fingido sobre
 * una tabla ilegible).
 */
export function VistaRentabilidad({
  rentabilidad, cobranza, sufijo = '',
}: {
  rentabilidad: Rentabilidad | null;
  cobranza: Cobranza | null;
  /** El `?tenant=`/`?vista=`/`?rol=` que hay que conservar al pasar de página. */
  sufijo?: string;
}) {
  const sinNada = rentabilidad !== null && cobranza !== null
    && rentabilidad.viajesConIngreso === 0 && cobranza.total === 0;

  // El rango de la página, para decirlo en palabras. `desde` y `hasta` son lo
  // que se IMPRIME: los dos son 0 cuando la página quedó vacía (alguien tecleó
  // `?p=99`), y entonces el renglón dice "0–0 de N", que es la verdad, en vez
  // de un rango inventado — `(99−1)·100 + 0` imprimía "0–9,800 de 350".
  // `hayMas` NO se calcula sobre lo impreso sino sobre el desplazamiento real
  // (`consumidas`), para no ofrecer "Siguientes" hacia otra página vacía.
  const consumidas = cobranza
    ? (cobranza.pagina - 1) * cobranza.porPagina + cobranza.facturas.length : 0;
  const desde = cobranza && cobranza.facturas.length
    ? (cobranza.pagina - 1) * cobranza.porPagina + 1 : 0;
  const hasta = cobranza && cobranza.facturas.length ? consumidas : 0;
  const hayMas = cobranza ? consumidas < cobranza.total : false;

  return (
    <main className="h-full">
      <div className="rounded-2xl min-h-full hairline flex flex-col" style={{ background: 'var(--g1)' }}>
        <BarraPagina
          icono={<ChartNoAxesCombined width={15} height={15} strokeWidth={1.75} style={{ color: 'var(--muted)' }} />}
          titulo="Rentabilidad y cobranza"
        />
        <div className="px-5 py-5 flex-1 space-y-4">
          {sinNada ? (
            <EstadoVacio>
              Esta pantalla trabaja con dos datos que tu cuenta todavía no tiene: el{' '}
              <strong>ingreso de cada flete</strong> y las <strong>facturas que le emites a tus
              clientes</strong>. En cuanto existan, aquí se mide — margen real contra lo comprobado
              (no contra el anticipo), cartera por cobrar y lo vencido por cliente. Nada de esta
              pantalla se estima: si el dato no está, se dice.
            </EstadoVacio>
          ) : (
            <>
              {/* ── Rentabilidad ─────────────────────────────────────── */}
              {rentabilidad === null ? (
                <EstadoError mensaje="No pude leer los viajes y liquidaciones para medir la rentabilidad." />
              ) : rentabilidad.viajesConIngreso === 0 ? (
                <EstadoVacio>
                  Ningún viaje trae ingreso de flete capturado todavía — sin ese dato el margen
                  no se calcula (y no se estima con el anticipo: eso es lo que la empresa le
                  adelanta al operador, no lo que cobra).
                </EstadoVacio>
              ) : (
                <section className="space-y-2">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <StatCard
                      icono={<Banknote width={14} height={14} strokeWidth={1.75} />}
                      etiqueta="Ingreso de fletes capturado" valor={rentabilidad.ingreso} formato="mxn"
                    />
                    <StatCard
                      icono={<ReceiptText width={14} height={14} strokeWidth={1.75} />}
                      etiqueta="Costo comprobado por operadores" valor={rentabilidad.costoComprobado} formato="mxn"
                    />
                    <StatCard
                      icono={<TrendingUp width={14} height={14} strokeWidth={1.75} />}
                      etiqueta="Contribución (ingreso − comprobado)" valor={rentabilidad.contribucion} formato="mxn"
                    />
                  </div>
                  <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
                    {rentabilidad.margenPct !== null
                      ? `Margen: ${porcentaje(rentabilidad.margenPct)} — medido solo sobre los ${numero(rentabilidad.viajesConIngreso)} viajes con ingreso capturado.`
                      : 'Sin ingreso capturado, el margen no se calcula.'}
                    {rentabilidad.viajesSinIngreso > 0
                      && ` ${numero(rentabilidad.viajesSinIngreso)} viajes sin ingreso quedan fuera de esta medición.`}
                  </p>
                  {/* Qué NO trae esa cifra. Va aquí y no en un tooltip porque
                      es la diferencia entre "este viaje dejó dinero" y "este
                      viaje dejó dinero ANTES de pagar al operador y el taller",
                      y de esa distinción dependen decisiones de tarifa. */}
                  <p className="text-[11px]" style={{ color: 'var(--faint)' }}>
                    Contribución NO es utilidad: es el ingreso menos lo que se comprobó en el viaje.
                    Todavía no resta sueldo del operador, mantenimiento, llantas, seguro, depreciación
                    ni administración. Un viaje puede salir con contribución sana y aun así haber
                    perdido dinero — para eso hace falta tu costo por kilómetro, que Likida no conoce.
                  </p>
                </section>
              )}

              {/* ── Cobranza a clientes ──────────────────────────────── */}
              {cobranza === null ? (
                <EstadoError mensaje="No pude leer las facturas emitidas para armar la cartera." />
              ) : cobranza.total === 0 ? (
                <EstadoVacio>
                  Aún no hay facturas emitidas registradas — al registrar la primera, aquí
                  aparece la cartera: cuánto te deben, qué ya venció y qué factura no tiene
                  condiciones de crédito pactadas.
                </EstadoVacio>
              ) : (
                <section className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <StatCard
                      icono={<Wallet width={14} height={14} strokeWidth={1.75} />}
                      etiqueta="Por cobrar (facturas vivas)" valor={cobranza.porCobrar} formato="mxn"
                    />
                    <StatCard
                      icono={<CalendarClock width={14} height={14} strokeWidth={1.75} />}
                      etiqueta="Vencido" valor={cobranza.vencido} formato="mxn"
                    />
                  </div>
                  {cobranza.sinCondiciones > 0 && (
                    <p className="text-[12px]" style={{ color: 'var(--warn)' }}>
                      {cobranza.sinCondiciones === 1
                        ? '1 factura no tiene fecha de vencimiento porque su cliente no tiene crédito pactado — no entra al conteo de vencidas.'
                        : `${cobranza.sinCondiciones} facturas no tienen fecha de vencimiento porque su cliente no tiene crédito pactado — no entran al conteo de vencidas.`}
                    </p>
                  )}
                  {cobranza.facturas.length === 0 ? (
                    // `total > 0` pero esta página no trajo filas: es un `?p=`
                    // fuera de rango, NO una cartera vacía — las tarjetas de
                    // arriba (de la cartera completa) siguen siendo ciertas.
                    // El renglón de paginación de abajo ya trae "Anteriores".
                    <p className="text-[13px] py-4 text-center" style={{ color: 'var(--muted)' }}>
                      Esta página no tiene facturas — hay {numero(cobranza.total)} en la cartera completa.
                    </p>
                  ) : (
                    <div className="card overflow-x-auto">
                      <table className="w-full text-[12.5px]">
                        <thead>
                          <tr className="text-left" style={{ color: 'var(--muted)' }}>
                            <th className="px-3 py-2 font-medium">Folio</th>
                            <th className="px-3 py-2 font-medium">Cliente</th>
                            <th className="px-3 py-2 font-medium">Fecha</th>
                            <th className="px-3 py-2 font-medium text-right">Total</th>
                            <th className="px-3 py-2 font-medium text-right">Pagado</th>
                            <th className="px-3 py-2 font-medium text-right">Saldo</th>
                            <th className="px-3 py-2 font-medium">Vence</th>
                          </tr>
                        </thead>
                        <tbody>
                          {cobranza.facturas.map((f) => (
                            <tr key={f.id} className="border-t" style={{ borderColor: 'var(--line2)' }}>
                              <td className="px-3 py-2">{f.folio ?? '—'}</td>
                              <td className="px-3 py-2">{f.cliente}</td>
                              <td className="px-3 py-2 whitespace-nowrap">{fechaCorta(f.fecha)}</td>
                              <td className="px-3 py-2 text-right tabular">{mxn(f.total)}</td>
                              <td className="px-3 py-2 text-right tabular">{mxn(f.pagado)}</td>
                              <td className="px-3 py-2 text-right tabular font-medium">{mxn(f.saldo)}</td>
                              <td className="px-3 py-2 whitespace-nowrap">
                                {f.vencida
                                  ? <span style={{ color: 'var(--bad)' }}>venció {fechaCorta(f.venceEn)}</span>
                                  : (f.venceEn ? fechaCorta(f.venceEn) : 'sin condiciones')}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* ── La cartera viene PAGINADA (mig. 0152) ──────────────
                      Se dice el rango Y el total: recortar la lista está
                      bien, recortar la cifra sin decirlo no. Las tarjetas de
                      arriba (por cobrar, vencido) son de TODAS las facturas,
                      no de esta página — por eso el renglón lo aclara. */}
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-[11.5px]" style={{ color: 'var(--faint)' }}>
                      {`Facturas ${numero(desde)}–${numero(hasta)} de ${numero(cobranza.total)}, `}
                      {'las vencidas primero. Por cobrar y vencido de arriba son de la cartera completa.'}
                    </span>
                    {(cobranza.pagina > 1 || hayMas) && (
                      <div className="flex items-center gap-1.5">
                        {cobranza.pagina > 1 && (
                          <Link href={hrefPagina(sufijo, cobranza.pagina - 1)} className={BTN_PAGINA} style={{ background: 'var(--surface)' }}>
                            <ChevronLeft width={13} height={13} strokeWidth={1.75} aria-hidden /> Anteriores
                          </Link>
                        )}
                        {hayMas && (
                          <Link href={hrefPagina(sufijo, cobranza.pagina + 1)} className={BTN_PAGINA} style={{ background: 'var(--surface)' }}>
                            Siguientes <ChevronRight width={13} height={13} strokeWidth={1.75} aria-hidden />
                          </Link>
                        )}
                      </div>
                    )}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
