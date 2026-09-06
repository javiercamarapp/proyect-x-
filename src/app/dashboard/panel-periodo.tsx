'use client';

import { useState } from 'react';
import { Dona, AreaChartSimple } from '../admin/charts';
import { GastoSemanalChart } from './gasto-semanal-chart';
import { TopRutas } from './top-rutas';
import { TituloSeccion } from './resumen-visual';
import { Actividad, type ModoPeriodo } from './actividad';
import type { DiaViajes } from './serie-diaria';
import { mxn } from '@/lib/formato';
import { rotuloVentana, type BloquePeriodo } from './ventana-periodo';
import type {
  SeriesKpiCards, GastoSemanalSeries, LiquidadoSemanalSeries, TopRutasSeries,
} from '@/lib/likida/analytics';

const MODOS: ModoPeriodo[] = ['semanal', 'mensual', 'historico'];
const OPCIONES: Array<{ id: ModoPeriodo; etiqueta: string }> = [
  { id: 'semanal', etiqueta: 'Semanal' },
  { id: 'mensual', etiqueta: 'Mensual' },
  { id: 'historico', etiqueta: 'Histórico' },
];

/**
 * UN SOLO selector Semanal/Mensual/Histórico que mueve Viajes, Actividad,
 * Gasto por categoría, Liquidado por semana y Top rutas por gasto juntos —
 * dirección del 8-ago-2026 (antes cada gráfica tenía su propio estado, o
 * ninguno: "Gasto por categoría"/"Liquidado" vivían fijas a 5 semanas,
 * "Viajes" a todo el histórico siempre).
 *
 * Todos los datos llegan PRE-CALCULADOS por el servidor para las 3 vistas
 * (`*Series` en `analytics.ts`; `porDia` en `serie-diaria.ts` desde FE-5) —
 * este componente solo decide cuál mostrar. Ya no queda ningún bucketeo en
 * el cliente: `Actividad` recibía las 100 filas crudas de `getViajes` y las
 * contaba por día, que a 50k viajes/mes eran 90 minutos rotulados "7 días".
 */
export function PanelPeriodo({
  porDia, porMes, seriesKpis, gastoSemanalSeries, liquidadoSemanalSeries, topRutasSeries,
}: {
  /** Viajes iniciados por día, contados en SQL. `null` = no se pudo leer. */
  porDia: DiaViajes[] | null;
  /** Viajes por mes (histórico). `null` = no se pudo leer — ver `Actividad`. */
  porMes: Array<{ dia: string; valor: number }> | null;
  seriesKpis: SeriesKpiCards | null;
  gastoSemanalSeries: GastoSemanalSeries | null;
  liquidadoSemanalSeries: LiquidadoSemanalSeries | null;
  topRutasSeries: TopRutasSeries | null;
}) {
  const [modoIdx, setModoIdx] = useState(0);
  const modo = MODOS[modoIdx];

  const kpiModo = seriesKpis?.[modo]?.[0] ?? null;
  const gastoModo = gastoSemanalSeries?.[modo] ?? null;
  const liquidadoModo = liquidadoSemanalSeries?.[modo] ?? null;
  const rutasModo = topRutasSeries?.[modo] ?? null;
  const totalLiquidado = liquidadoModo?.reduce((s, d) => s + d.valor, 0) ?? 0;
  // A11: el pill rotula CINCO ventanas distintas (7 días, 35 días, 52 semanas,
  // sin cota…). Cada tarjeta imprime la suya, junto al título, para que
  // "Histórico" sobre "Liquidado" no prometa lo que no suma.
  const ventana = (b: BloquePeriodo) => (
    <span className="normal-case font-normal ml-1.5" style={{ color: 'var(--faint)' }}>· {rotuloVentana(b, modo)}</span>
  );

  return (
    // Cada bloque es una TARJETA blanca sobre el lienzo tenue
    // (12-ago-2026) — el padding horizontal lo pone el padre.
    <>
      <div className="flex items-center justify-end">
        <div className="inline-flex items-center gap-1 p-0.5 rounded-full shrink-0" style={{ background: 'var(--canvas)' }}>
          {OPCIONES.map((o) => (
            <button key={o.id} type="button" onClick={() => setModoIdx(MODOS.indexOf(o.id))}
              className="text-xs font-medium px-2.5 py-1 rounded-full transition-colors"
              style={modo === o.id ? { background: 'var(--marca)', color: 'var(--marca-fg)' } : { color: 'var(--muted)' }}>
              {o.etiqueta}
            </button>
          ))}
        </div>
      </div>

      {/* ── Viajes / Actividad ── */}
      <div className="pt-2 grid grid-cols-1 md:grid-cols-3 gap-2">
        <div className="card p-3 h-full flex flex-col">
          <TituloSeccion>Viajes{ventana('viajes')}</TituloSeccion>
          <div className="mt-2.5 flex-1 flex flex-col">
            {/* A13: `null` es consulta CAÍDA, no flota sin viajes — se dice,
                como ya hacían "Liquidado" y "Top rutas" en esta misma fila. */}
            {kpiModo === null ? (
              <div className="flex-1 min-h-[110px] w-full flex items-center justify-center"><p className="text-sm text-center max-w-[26ch]" style={{ color: 'var(--muted)' }}>No se pudo cargar esta gráfica.</p></div>
            ) : kpiModo.totalViajes > 0 ? (
              <Dona segmentos={[
                { etiqueta: 'Liquidados', valor: kpiModo.viajesLiquidados },
                { etiqueta: 'Pendientes', valor: Math.max(0, kpiModo.totalViajes - kpiModo.viajesLiquidados) },
              ]} />
            ) : (
              <div className="flex-1 min-h-[110px] w-full flex items-center justify-center"><p className="text-sm text-center max-w-[26ch]" style={{ color: 'var(--muted)' }}>Aún no hay viajes registrados en este periodo.</p></div>
            )}
          </div>
        </div>
        <div className="card p-3 md:col-span-2 h-full flex flex-col">
          <TituloSeccion>Actividad{ventana('actividad')}</TituloSeccion>
          <div className="mt-3 flex-1 flex flex-col">
            <Actividad porDia={porDia} porMes={porMes} modo={modo} />
          </div>
        </div>
      </div>

      {/* ── Gasto por categoría / Liquidado — mitad y mitad (12-ago) ── */}
      <div className="pt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
        <div className="card p-3 h-full flex flex-col">
          <TituloSeccion>Gasto por categoría{ventana('gasto')}</TituloSeccion>
          <div className="mt-3 flex-1 flex flex-col">
            {gastoModo === null ? (
              <div className="flex-1 min-h-[110px] w-full flex items-center justify-center"><p className="text-sm text-center max-w-[26ch]" style={{ color: 'var(--muted)' }}>No se pudo cargar esta gráfica.</p></div>
            ) : gastoModo.series.some((s) => s.valores.some((v) => v > 0)) ? (
              <GastoSemanalChart categorias={gastoModo.categorias} series={gastoModo.series} />
            ) : (
              <div className="flex-1 min-h-[110px] w-full flex items-center justify-center"><p className="text-sm text-center max-w-[26ch]" style={{ color: 'var(--muted)' }}>Aún no hay gastos capturados.</p></div>
            )}
          </div>
        </div>
        <div className="card p-3 h-full flex flex-col">
          <TituloSeccion>Liquidado{ventana('liquidado')}</TituloSeccion>
          {totalLiquidado > 0 && (
            <div className="text-2xl font-semibold tracking-tight tabular mt-1">{mxn(totalLiquidado)}</div>
          )}
          <div className="mt-2.5 flex-1 flex flex-col">
            {liquidadoModo === null ? (
              <div className="flex-1 min-h-[110px] flex items-center justify-center text-sm text-center" style={{ color: 'var(--muted)' }}>
                No se pudo cargar esta gráfica.
              </div>
            ) : liquidadoModo.some((d) => d.valor > 0) ? (
              <AreaChartSimple datos={liquidadoModo} etiquetaValor={mxn} />
            ) : (
              <div className="flex-1 min-h-[110px] flex items-center justify-center text-sm text-center" style={{ color: 'var(--muted)' }}>
                Sin cierres en este periodo.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Top rutas por gasto — hasta abajo, a TODO lo ancho (12-ago) ── */}
      <div className="pt-2">
        <div className="card p-3 flex flex-col">
          <TituloSeccion>Top rutas por gasto{ventana('rutas')}</TituloSeccion>
          <div className="mt-2 flex-1 flex flex-col">
            {rutasModo && rutasModo.length > 0 ? (
              <div className="overflow-x-auto"><TopRutas rutas={rutasModo} /></div>
            ) : (
              <div className="flex-1 min-h-[110px] w-full flex items-center justify-center">
                <p className="text-sm text-center max-w-[26ch]" style={{ color: 'var(--muted)' }}>
                  {rutasModo ? 'Aún no hay gasto asociado a una ruta.' : 'No se pudo cargar esta sección.'}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
