'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight, TriangleAlert, ReceiptText } from 'lucide-react';
import { mxn } from '@/lib/formato';
import { BOTON_PERIODO } from '../admin/ui/kit';

type Modo = 'semanal' | 'mensual' | 'historico';
const MODOS: Modo[] = ['semanal', 'mensual', 'historico'];
const ETIQUETA_MODO: Record<Modo, string> = {
  semanal: 'últimos 7 días', mensual: 'últimos 30 días', historico: 'histórico',
};

interface ResumenSimple { montoPerdido: number; montoEnRiesgo: number; montoRecuperable: number }

/**
 * "En riesgo/perdido" y "Recuperable pidiendo factura" a nivel de KPI, con
 * flechas ‹ › propias — dirección del 8-ago-2026: antes vivían solo dentro
 * de "Tu motor fiscal" (más abajo, fijas al ejercicio); Javier pidió
 * subirlas al mismo nivel de prominencia que Gasto total/Costo por viaje Y
 * que también ciclen semanal/mensual/histórico, igual que esas dos. En la
 * MISMA línea que "Diésel elegible", ocupando todo el ancho disponible
 * (`flex-1`, no anchos fijos) — por eso este componente NO envuelve las 2
 * tarjetas en su propio grid: `page.tsx` las mete junto con Diésel en un
 * solo `flex flex-wrap`, y cada una crece a lo que le toque.
 *
 * `series` ya trae los 3 `ResumenPerdidas` PRE-CALCULADOS por el servidor
 * (`page.tsx`) — este componente solo elige cuál mostrar. `resumirPerdidas`
 * vive en `fiscal.ts`, que importa `supabaseAdmin` a nivel de módulo: un
 * Client Component no puede importar ese archivo en tiempo de ejecución
 * (arrastraría el service-role al bundle del navegador), así que el cálculo
 * tiene que llegar ya hecho, como datos planos.
 */
export function MotorFiscalPeriodo({ series }: { series: Record<Modo, ResumenSimple> | null }) {
  const [modoIdx, setModoIdx] = useState(0);
  const modo = MODOS[modoIdx];

  if (!series) {
    return <p className="text-sm" style={{ color: 'var(--muted)' }}>No se pudo leer el motor fiscal en este momento.</p>;
  }
  const r = series[modo];

  const flechas = (
    <div className="flex items-center gap-3 shrink-0">
      <button type="button" aria-label="Periodo más corto" disabled={modoIdx <= 0}
        onClick={() => setModoIdx((i) => Math.max(i - 1, 0))} className={BOTON_PERIODO} style={{ color: 'var(--muted)' }}>
        <ChevronLeft width={12} height={12} strokeWidth={2} />
      </button>
      <button type="button" aria-label="Periodo más largo" disabled={modoIdx >= MODOS.length - 1}
        onClick={() => setModoIdx((i) => Math.min(i + 1, MODOS.length - 1))} className={BOTON_PERIODO} style={{ color: 'var(--muted)' }}>
        <ChevronRight width={12} height={12} strokeWidth={2} />
      </button>
    </div>
  );

  return (
    <>
      {/* Misma anatomía y altura las tres (pedido del 12-ago: simetría —
          el monto no queda arriba con un hueco abajo): ícono en chip blanco
          + rótulo con su ventana + cifra, todo centrado verticalmente; la
          fila las estira parejas (items-stretch del padre). */}
      <div className="rounded-xl px-3 py-2.5 flex-1 min-w-[190px] flex items-center gap-2.5" style={{ background: 'color-mix(in srgb, var(--color-bad) 10%, transparent)' }}>
        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--marca)', color: 'var(--marca-fg)' }}>
          <TriangleAlert width={15} height={15} strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-medium truncate" style={{ color: 'var(--muted)' }}>En riesgo / perdido · {ETIQUETA_MODO[modo]}</div>
{flechas}
          </div>
          <div className="font-display text-[20px] leading-tight font-semibold tabular mt-0.5" style={{ color: 'var(--color-bad)' }}>
            {mxn(r.montoEnRiesgo + r.montoPerdido)}
          </div>
        </div>
      </div>
      <div className="rounded-xl px-3 py-2.5 flex-1 min-w-[190px] flex items-center gap-2.5" style={{ background: 'color-mix(in srgb, var(--color-ok) 10%, transparent)' }}>
        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'var(--marca)', color: 'var(--marca-fg)' }}>
          <ReceiptText width={15} height={15} strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-medium truncate" style={{ color: 'var(--muted)' }}>Recuperable pidiendo factura · {ETIQUETA_MODO[modo]}</div>
            {flechas}
          </div>
          <div className="font-display text-[20px] leading-tight font-semibold tabular mt-0.5" style={{ color: 'var(--color-ok)' }}>
            {mxn(r.montoRecuperable)}
          </div>
        </div>
      </div>
    </>
  );
}
