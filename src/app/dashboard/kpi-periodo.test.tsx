import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { Calculator } from 'lucide-react';
import { KpiPeriodo } from './kpi-periodo';
import type { SeriesKpiCards, ComparativoPeriodo } from '@/lib/likida/analytics';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 18 (M9 / A12) — la tarjeta "Costo por viaje" del Resumen, vista
// desde su LLAMADOR real. `StatCard` ya sabía pintar `null` como "—"
// (auditoría 1); lo que faltaba era fijar que `KpiPeriodo` no lo colapse a 0
// por el camino (`valor={valorActual ?? 0}` era el bug), y que sin periodo
// comparable no se invente un "0% · sin movimiento".
// ═══════════════════════════════════════════════════════════════════════════

const bucket = (p: Partial<ComparativoPeriodo>): ComparativoPeriodo => ({
  gastoTotal: 0, totalViajes: 0, costoPorViaje: null, liquidado: 0, viajesLiquidados: 0, ...p,
} as ComparativoPeriodo);

const ICONO = <Calculator width={15} height={15} />;

describe('KpiPeriodo — semana sin viajes pero con gasto', () => {
  // Puente: $41,200 de taller y casetas, cero viajes → costoPorViaje es
  // división indefinida, no "$0.00".
  const series: SeriesKpiCards = {
    semanal: [bucket({ gastoTotal: 41200, totalViajes: 0, costoPorViaje: null }), bucket({ gastoTotal: 0 })],
    mensual: [bucket({ gastoTotal: 41200 }), bucket({})],
    historico: [bucket({ gastoTotal: 41200 })],
  };

  it('costo por viaje null se sirve como "—" y dice por qué, nunca "$0.00"', () => {
    const html = renderToStaticMarkup(
      <KpiPeriodo icono={ICONO} nombre="Costo por viaje" campo="costoPorViaje" formato="mxn" subeEsBueno={false} series={series} />,
    );
    expect(html).toContain('—');
    expect(html).toContain('sin viajes en el periodo');
    expect(html).not.toContain('$0.00');
  });

  it('gasto total $41,200 contra una semana anterior en $0: sin "0% · sin movimiento"', () => {
    const html = renderToStaticMarkup(
      <KpiPeriodo icono={ICONO} nombre="Gasto total" campo="gastoTotal" formato="mxn" subeEsBueno={false} series={series} />,
    );
    expect(html).toContain('$41,200.00');
    expect(html).not.toContain('sin movimiento');
    expect(html).not.toMatch(/>0%/);
    expect(html).toContain('sin periodo comparable');
  });
});

// ── FE-M5 (auditoría 28) ────────────────────────────────────────────────
// Las flechas ‹ › de periodo eran `w-4 h-4` (16×16 CSS px, blanco de toque
// por debajo del mínimo 24×24 de WCAG 2.5.8) y el literal vivía copiado en
// `kpi-periodo.tsx` y en `motor-fiscal-periodo.tsx` — la mitad de las veces
// que se auditó ya habían divergido. El arreglo comparte una sola constante
// (`BOTON_PERIODO` en `admin/ui/kit.tsx`) con una caja real de 24px.
describe('KpiPeriodo — blanco de toque de las flechas de periodo', () => {
  const series: SeriesKpiCards = {
    semanal: [bucket({}), bucket({})],
    mensual: [bucket({}), bucket({})],
    historico: [bucket({})],
  };

  it('las flechas miden ≥24px (w-6/h-6) y ya no traen el w-4 h-4 viejo', () => {
    const html = renderToStaticMarkup(
      <KpiPeriodo icono={ICONO} nombre="Gasto total" campo="gastoTotal" formato="mxn" subeEsBueno={false} series={series} />,
    );
    expect(html).toMatch(/aria-label="Periodo más corto"[^>]*class="[^"]*\bw-6\b[^"]*\bh-6\b/);
    expect(html).toMatch(/aria-label="Periodo más largo"[^>]*class="[^"]*\bw-6\b[^"]*\bh-6\b/);
    expect(html).not.toMatch(/\bw-4 h-4 rounded flex items-center justify-center\b/);
  });

  it('no hay un segundo literal `w-4 h-4 rounded` copiado en los dos archivos de flechas', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- lee los .tsx HERMANOS de esta prueba, resueltos de import.meta.url en tiempo de prueba; no vienen de entrada de usuario.
    const kpi = readFileSync(new URL('./kpi-periodo.tsx', import.meta.url), 'utf8');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- lee los .tsx HERMANOS de esta prueba, resueltos de import.meta.url en tiempo de prueba; no vienen de entrada de usuario.
    const motor = readFileSync(new URL('./motor-fiscal-periodo.tsx', import.meta.url), 'utf8');
    expect(kpi).not.toMatch(/w-4 h-4 rounded/);
    expect(motor).not.toMatch(/w-4 h-4 rounded/);
    // Los dos importan la MISMA constante — no un segundo literal paralelo.
    expect(kpi).toMatch(/BOTON_PERIODO/);
    expect(motor).toMatch(/BOTON_PERIODO/);
  });
});
