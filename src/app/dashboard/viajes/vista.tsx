import Link from 'next/link';
import { Truck, ArrowRight, Inbox, Search, FileUp, ChevronLeft, ChevronRight } from 'lucide-react';
import { numero, fechaMx, mxn } from '@/lib/formato';
import { EstadoVacio, StatusPill, type Estado } from '@/app/admin/ui/kit';
import { BarraPagina, PILL_ESTATUS } from '../resumen-visual';
import { PillAviso } from '../despacho/vista';
import { ImportarViajes, type AccionImportar } from './importar';

export type FiltroViajes = 'todos' | 'abiertos' | 'en_cuadre' | 'liquidados' | 'escalados';

/** La fila del registro v2 (22-ago-2026): la ficha operativa del viaje más,
 *  SOLO si la página lo permitió (`verDinero`), el anticipo y lo que su
 *  liquidación comprobó. Los tres pesos vienen `null` cuando el rol no ve
 *  finanzas — la página los deja en el servidor, la vista no los pinta. */
export interface FilaRegistroViaje {
  id: string; folio: string; origen: string | null; destino: string | null;
  estatus: string; operadorNombre: string | null; unidadEco: string | null;
  fechaInicio: string | null;
  intakePendientes: number;
  avisadoEn: string | null; aceptadoEn: string | null; escaladoEn: string | null;
  avisosEnviados: number;
  /** `null` = el rol no ve pesos (no "sin anticipo"). */
  anticipo: number | null;
  /** `null` = sin liquidación todavía, o sin permiso. */
  comprobado: number | null;
  diferencia: number | null;
  liqId: string | null;
  liqEstatus: string | null;
}

const ROTULO_FILTRO: Record<FiltroViajes, string> = {
  todos: 'Todos', abiertos: 'Abiertos', en_cuadre: 'En cuadre',
  liquidados: 'Liquidados', escalados: 'Escalados',
};

/** Arma un href a esta misma página conservando el sufijo de
 *  previsualización (`?tenant=`/`?vista=`/`?rol=`) y los controles (filtro,
 *  búsqueda, cursor de página). Un `null` quita el parámetro. El `p` de la
 *  paginación por número (hasta el 22-ago-2026) se BORRA siempre: cambiar de
 *  filtro o de búsqueda vuelve a la primera página, y un `p` heredado ya no
 *  significa nada (ver page.tsx). */
export function hrefRegistro(
  sufijo: string,
  controles: { f?: FiltroViajes | null; q?: string | null; c?: string | null },
): string {
  const params = new URLSearchParams(sufijo.startsWith('?') ? sufijo.slice(1) : sufijo);
  if (controles.f && controles.f !== 'todos') params.set('f', controles.f); else params.delete('f');
  if (controles.q) params.set('q', controles.q); else params.delete('q');
  if (controles.c) params.set('c', controles.c); else params.delete('c');
  params.delete('p');
  const qs = params.toString();
  return `/dashboard/viajes${qs ? `?${qs}` : ''}`;
}

const TH = 'etiqueta-mono text-left text-[10px] font-medium uppercase px-3 py-2 whitespace-nowrap';
const BTN_SEC = 'inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12.5px] font-medium hairline transition-colors hover:bg-[var(--canvas)]';

/**
 * El Registro de Viajes (F2), v2: navegable, filtrable, buscable y paginado
 * (nunca más de `porPagina` filas por render). Los pesos solo se pintan
 * cuando la página los mandó (`verDinero`); para el jefe de tráfico las
 * tres columnas no existen, ni vacías.
 */
export function VistaViajes({
  filas, filtro, conteos, sufijo, importar, puedeImportar, verDinero, q, cursor, siguiente, hayMas, porPagina,
}: {
  filas: FilaRegistroViaje[];
  filtro: FiltroViajes;
  conteos: {
    total: number | null; abiertos: number | null; enCuadre: number | null;
    liquidados: number | null; escalados: number | null;
  };
  sufijo: string;
  importar: AccionImportar;
  /** Solo quien puede crear viajes ve el botón de importar. */
  puedeImportar: boolean;
  /** `puedeVerArea(rol, 'dinero')`, decidido en la página. */
  verDinero: boolean;
  q: string;
  /** Cursor de ESTA página (`null` = la primera). Solo decide si se ofrece
   *  "Volver al inicio": el contenido ya vino paginado del servidor. */
  cursor: string | null;
  /** Cursor de la página siguiente; `null` si no la hay. */
  siguiente: string | null;
  hayMas: boolean;
  porPagina: number;
}) {
  const kpi = (n: number | null) => (n === null ? '—' : numero(n));
  const params = new URLSearchParams(sufijo.startsWith('?') ? sufijo.slice(1) : sufijo);
  const columnas = verDinero ? 10 : 7;

  return (
    <main className="h-full">
      <div className="rounded-2xl min-h-full hairline flex flex-col" style={{ background: 'var(--g1)' }}>
        <BarraPagina
          icono={<Truck width={15} height={15} strokeWidth={1.75} style={{ color: 'var(--muted)' }} />}
          titulo="Viajes"
        />
        <div className="px-5 py-5 flex-1 space-y-4">

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi titulo="Viajes en total" valor={kpi(conteos.total)} nota="histórico" />
            <Kpi titulo="Abiertos" valor={kpi(conteos.abiertos)} />
            <Kpi titulo="En cuadre" valor={kpi(conteos.enCuadre)} />
            <Kpi titulo="Escalados sin aceptar" valor={kpi(conteos.escalados)}
              tono={(conteos.escalados ?? 0) > 0 ? 'bad' : undefined} />
          </div>

          <section className="card p-4 relative">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
              <div className="flex items-center gap-1.5 flex-wrap">
                {(Object.keys(ROTULO_FILTRO) as FiltroViajes[]).map((f) => (
                  <Link key={f} href={hrefRegistro(sufijo, { f, q })}
                    className="px-2.5 h-7 inline-flex items-center rounded-lg text-[12px] font-medium transition-colors hairline"
                    style={filtro === f
                      ? { background: 'var(--marca)', color: 'var(--marca-fg)', borderColor: 'var(--marca)' }
                      : { background: 'var(--surface)', color: 'var(--muted)' }}>
                    {ROTULO_FILTRO[f]}
                  </Link>
                ))}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {/* GET puro: la búsqueda vive en la URL y sobrevive a recargar,
                    compartir y volver atrás. El sufijo y el filtro viajan como
                    campos ocultos para no perderse al enviar. */}
                <form method="get" action="/dashboard/viajes" className="flex items-center gap-1.5" role="search">
                  {[...params.entries()].map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
                  {filtro !== 'todos' && <input type="hidden" name="f" value={filtro} />}
                  <label className="relative">
                    <span className="sr-only">Buscar viaje</span>
                    <Search width={13} height={13} strokeWidth={1.75} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--faint)' }} aria-hidden />
                    <input type="search" name="q" defaultValue={q} placeholder="Folio, origen o destino"
                      className="h-8 pl-8 pr-3 rounded-lg hairline text-[12.5px] w-[220px] max-w-full"
                      style={{ background: 'var(--surface)' }} />
                  </label>
                  <button type="submit" className={BTN_SEC} style={{ background: 'var(--surface)' }}>Buscar</button>
                  {q && (
                    <Link href={hrefRegistro(sufijo, { f: filtro })} className="text-[12px] hover:opacity-70" style={{ color: 'var(--muted)' }}>
                      Limpiar
                    </Link>
                  )}
                </form>
                {puedeImportar && (
                  // Sin JavaScript ni estado: `<details>` abre y cierra solo.
                  // Cerrado es un botón secundario; abierto, el panel del
                  // import aparece debajo de la barra, a lo ancho.
                  <details className="group">
                    <summary className={`${BTN_SEC} list-none cursor-pointer select-none`} style={{ background: 'var(--surface)' }}>
                      <FileUp width={13} height={13} strokeWidth={1.75} aria-hidden /> Importar desde tu TMS
                    </summary>
                    <div className="absolute left-0 right-0 z-10 mt-2 px-4">
                      <div className="card p-4 shadow-[var(--shadow-pop)]">
                        <h2 className="font-display text-[15px] font-semibold mb-2">Importar desde tu TMS</h2>
                        <ImportarViajes importar={importar} verDinero={verDinero} />
                      </div>
                    </div>
                  </details>
                )}
              </div>
            </div>

            {filas.length === 0 ? (
              <EstadoVacio icono={<Inbox width={17} height={17} strokeWidth={1.75} style={{ color: 'var(--marca)' }} />}>
                {q
                  ? `Ningún viaje coincide con «${q}»${filtro !== 'todos' ? ` en «${ROTULO_FILTRO[filtro]}»` : ''}.`
                  : filtro === 'todos'
                    ? 'Aún no hay viajes registrados — el primero que despaches aparece aquí.'
                    : `Ningún viaje cae en «${ROTULO_FILTRO[filtro]}».`}
              </EstadoVacio>
            ) : (
              <div className="overflow-x-auto -mx-1">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr style={{ background: 'var(--canvas)' }}>
                      <th className={`${TH} rounded-l-lg`} style={{ color: 'var(--muted)' }}>Viaje</th>
                      <th className={TH} style={{ color: 'var(--muted)' }}>Operador</th>
                      <th className={TH} style={{ color: 'var(--muted)' }}>Unidad</th>
                      <th className={TH} style={{ color: 'var(--muted)' }}>Inicio</th>
                      {verDinero && (
                        <>
                          <th className={`${TH} text-right`} style={{ color: 'var(--muted)' }}>Anticipo</th>
                          <th className={`${TH} text-right`} style={{ color: 'var(--muted)' }}>Comprobado</th>
                          <th className={`${TH} text-right`} style={{ color: 'var(--muted)' }}>Diferencia</th>
                        </>
                      )}
                      <th className={TH} style={{ color: 'var(--muted)' }}>Aviso</th>
                      <th className={TH} style={{ color: 'var(--muted)' }}>Estatus</th>
                      <th className={`${TH} rounded-r-lg text-right`} style={{ color: 'var(--muted)' }}>Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filas.map((v) => {
                      const e = PILL_ESTATUS[v.estatus] ?? { etiqueta: v.estatus, estado: 'neutral' as Estado };
                      const ruta = v.origen && v.destino ? `${v.origen} → ${v.destino}` : v.origen ?? v.destino ?? null;
                      return (
                        <tr key={v.id} className="h-14 border-b transition-colors hover:bg-[var(--canvas)]" style={{ borderColor: 'var(--line2)' }}>
                          <td className="px-3 py-2 min-w-0">
                            <span className="font-medium block whitespace-nowrap">{v.folio}</span>
                            <span className="block text-[11px] truncate max-w-[240px]" style={{ color: 'var(--faint)' }}>
                              {ruta ?? 'sin ruta capturada'}
                            </span>
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {v.operadorNombre ?? <span style={{ color: 'var(--faint)' }}>Sin asignar</span>}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap cifra-mono" style={{ color: v.unidadEco ? 'var(--ink)' : 'var(--faint)' }}>
                            {v.unidadEco ?? '—'}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--muted)' }}>{v.fechaInicio ? fechaMx(v.fechaInicio) : '—'}</td>
                          {verDinero && (
                            <>
                              <td className="px-3 py-2 text-right cifra-mono whitespace-nowrap">{v.anticipo === null ? '—' : mxn(v.anticipo)}</td>
                              <td className="px-3 py-2 text-right cifra-mono whitespace-nowrap" style={{ color: v.comprobado === null ? 'var(--faint)' : undefined }}>
                                {v.comprobado === null ? '—' : mxn(v.comprobado)}
                              </td>
                              <td className="px-3 py-2 text-right cifra-mono whitespace-nowrap"
                                style={{ color: v.diferencia === null ? 'var(--faint)' : v.diferencia === 0 ? 'var(--ok)' : v.diferencia > 0 ? 'var(--warn)' : 'var(--bad)' }}>
                                {v.diferencia === null ? '—' : v.diferencia === 0 ? 'Exacta' : mxn(Math.abs(v.diferencia))}
                              </td>
                            </>
                          )}
                          <td className="px-3 py-2">
                            {v.estatus === 'liquidado'
                              ? <span style={{ color: 'var(--faint)' }}>—</span>
                              : <PillAviso v={v} />}
                          </td>
                          <td className="px-3 py-2"><StatusPill estado={e.estado}>{e.etiqueta}</StatusPill></td>
                          <td className="px-3 py-2 text-right">
                            {v.liqId ? (
                              <Link href={`/dashboard/${v.liqId}${sufijo}`}
                                className="inline-flex items-center gap-1 text-[12.5px] font-medium hover:opacity-70 transition-opacity whitespace-nowrap"
                                style={{ color: 'var(--marca)' }}>
                                Ver <ArrowRight width={12} height={12} strokeWidth={2} aria-hidden />
                              </Link>
                            ) : (
                              <span className="text-[12px]" style={{ color: 'var(--faint)' }}>—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {verDinero && (
                    <tfoot>
                      <tr>
                        <td colSpan={columnas} className="px-3 pt-2 text-[11px]" style={{ color: 'var(--faint)' }}>
                          Diferencia en ámbar = sobrante a favor de la empresa; en rojo = faltante a favor del operador.
                          Un guion en Comprobado es un viaje sin liquidación todavía.
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}

            {/* Paginación por CURSOR (escala 50k, 22-ago-2026): nunca más de
                `porPagina` filas por render. No se dice "página N de M":
                ni se cuenta el total de la consulta filtrada ni se numera —
                el cursor es la posición del último viaje visto, y "Siguientes"
                continúa desde ahí sin que la base relea lo anterior. Hacia
                atrás sirve el botón del navegador o "Volver al inicio". */}
            {(cursor || hayMas) && (
              <div className="flex items-center justify-between gap-3 mt-3 pt-3" style={{ borderTop: '1px dashed var(--line2)' }}>
                <span className="text-[11.5px]" style={{ color: 'var(--faint)' }}>
                  Hasta {numero(porPagina)} viajes por página, del más reciente al más antiguo.
                </span>
                <div className="flex items-center gap-1.5">
                  {cursor ? (
                    <Link href={hrefRegistro(sufijo, { f: filtro, q })} className={BTN_SEC} style={{ background: 'var(--surface)' }}>
                      <ChevronLeft width={13} height={13} strokeWidth={1.75} aria-hidden /> Volver al inicio
                    </Link>
                  ) : null}
                  {hayMas && siguiente ? (
                    <Link href={hrefRegistro(sufijo, { f: filtro, q, c: siguiente })} className={BTN_SEC} style={{ background: 'var(--surface)' }}>
                      Siguientes <ChevronRight width={13} height={13} strokeWidth={1.75} aria-hidden />
                    </Link>
                  ) : null}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function Kpi({ titulo, valor, nota, tono }: { titulo: string; valor: string; nota?: string; tono?: 'warn' | 'bad' }) {
  return (
    <div className="card p-3">
      <div className="etiqueta-mono text-[10px] uppercase" style={{ color: 'var(--faint)' }}>{titulo}</div>
      <div className="cifra-mono text-[18px] font-medium mt-0.5 leading-tight"
        style={tono ? { color: `var(--${tono})` } : undefined}>{valor}</div>
      {nota && <div className="text-[11px] mt-0.5" style={{ color: 'var(--faint)' }}>{nota}</div>}
    </div>
  );
}
