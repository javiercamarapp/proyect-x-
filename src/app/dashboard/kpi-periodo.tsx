'use client';

import { useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { StatCard, BOTON_PERIODO } from '../admin/ui/kit';
import type { ComparativoPeriodo, SeriesKpiCards } from '@/lib/likida/analytics';
import { pctCambio } from '@/lib/formato';
import type { FormatoPreset } from '../admin/ui/formato-preset';

type Modo = 'semanal' | 'mensual' | 'historico';
const MODOS: Modo[] = ['semanal', 'mensual', 'historico'];
const ETIQUETA_MODO: Record<Modo, string> = {
  semanal: 'últimos 7 días',
  mensual: 'últimos 30 días',
  historico: 'histórico',
};

/**
 * `KpiDegradado` + ‹ › que ciclan semanal/mensual/histórico, INDEPENDIENTE
 * por tarjeta — dirección del 8-ago-2026: el filtro único (7d/30d/Todo) que
 * vivía arriba de las 4 tarjetas se quitó (`GlobalFilter` se movió junto a
 * "Liquidado", la única sección que aún depende de ese estado compartido);
 * cada tarjeta ahora cambia SU PROPIA granularidad con ‹ ›, confirmado con
 * Javier vía AskUserQuestion como tarjetas independientes, no sincronizadas,
 * y el 8-ago pidió explícito que las flechas ciclen estas tres vistas — no
 * periodos consecutivos del mismo tamaño (ver `SeriesKpiCards`).
 *
 * `histórico` no tiene "periodo anterior" que comparar (`series.historico`
 * trae un solo bucket) — sin tendencia ahí, igual que el 'todo' del filtro
 * único que reemplaza.
 */
export function KpiPeriodo({
  icono, nombre, campo, formato, subeEsBueno, series,
}: {
  icono: ReactNode;
  nombre: string;
  campo: 'gastoTotal' | 'totalViajes' | 'costoPorViaje' | 'liquidado';
  formato?: FormatoPreset;
  /** `true` cuando SUBIR esta métrica es una buena noticia — no es igual
   *  para las 4: más viajes/liquidado es bueno, más gasto/costo no. Un
   *  booleano, NO una función — este componente es cliente y `page.tsx` es
   *  servidor; una función no cruza esa frontera (React la rechaza en
   *  tiempo de ejecución, "Functions cannot be passed directly to Client
   *  Components" — TypeScript no marca este error, así que hay que
   *  acordarse: solo tipos serializables entre las dos mitades). */
  subeEsBueno: boolean;
  series: SeriesKpiCards;
}) {
  const [modoIdx, setModoIdx] = useState(0);
  const modo = MODOS[modoIdx];
  const serie: ComparativoPeriodo[] = series[modo];
  const actual = serie[0];
  const anterior = serie[1] ?? null;

  const valorActual = actual[campo];
  const valorAnterior = anterior ? anterior[campo] : null;
  const pct = valorActual === null || valorAnterior === null || valorAnterior === undefined
    ? null
    : pctCambio(valorActual, valorAnterior);

  return (
    <StatCard
      icono={icono}
      etiqueta={`${nombre} — ${ETIQUETA_MODO[modo]}`}
      // AUDITORÍA 1, CRÍTICO: se PRESERVA el `null` que el backend devuelve a
      // propósito (p. ej. costo por viaje con 0 viajes es división indefinida,
      // no cero). Colapsarlo a 0 pintaba un $0.00 inventado — la regla #1.
      valor={valorActual}
      sinDato="sin viajes en el periodo"
      formato={formato}
      delta={pct === null ? null : { pct, bueno: subeEsBueno ? pct >= 0 : pct <= 0 }}
      flechas={
        // Derecha = hacia histórico, izquierda = hacia semanal (pedido
        // explícito del 8-ago-2026 — antes estaba al revés).
        <div className="flex items-center gap-3 shrink-0" style={{ color: 'var(--muted)' }}>
          <button type="button" aria-label="Periodo más corto" disabled={modoIdx <= 0}
            onClick={() => setModoIdx((i) => Math.max(i - 1, 0))} className={BOTON_PERIODO}>
            <ChevronLeft width={13} height={13} strokeWidth={2} />
          </button>
          <button type="button" aria-label="Periodo más largo" disabled={modoIdx >= MODOS.length - 1}
            onClick={() => setModoIdx((i) => Math.min(i + 1, MODOS.length - 1))} className={BOTON_PERIODO}>
            <ChevronRight width={13} height={13} strokeWidth={2} />
          </button>
        </div>
      }
    />
  );
}
