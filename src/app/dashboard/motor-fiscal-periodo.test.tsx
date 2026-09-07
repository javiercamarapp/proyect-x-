import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MotorFiscalPeriodo } from './motor-fiscal-periodo';

// ═══════════════════════════════════════════════════════════════════════════
// FE-M5 (auditoría 28) — mismo hallazgo que `kpi-periodo.test.tsx`: las
// flechas ‹ › de este componente compartían el literal `w-4 h-4 rounded ...`
// (16×16 CSS px) con `kpi-periodo.tsx`, por debajo del mínimo 24×24 de WCAG
// 2.5.8. No había ninguna prueba de render de este componente antes de este
// arreglo — se agrega el archivo completo.
// ═══════════════════════════════════════════════════════════════════════════

const SERIE = {
  semanal: { montoPerdido: 1000, montoEnRiesgo: 2000, montoRecuperable: 500 },
  mensual: { montoPerdido: 4000, montoEnRiesgo: 8000, montoRecuperable: 2000 },
  historico: { montoPerdido: 40000, montoEnRiesgo: 80000, montoRecuperable: 20000 },
};

describe('MotorFiscalPeriodo', () => {
  it('sin series: dice que no se pudo leer el motor fiscal, no un $0 fabricado', () => {
    const html = renderToStaticMarkup(<MotorFiscalPeriodo series={null} />);
    expect(html).toContain('No se pudo leer el motor fiscal');
  });

  it('con series: pinta las dos cifras del periodo semanal por defecto', () => {
    const html = renderToStaticMarkup(<MotorFiscalPeriodo series={SERIE} />);
    expect(html).toContain('$3,000.00'); // montoEnRiesgo + montoPerdido
    expect(html).toContain('$500.00'); // montoRecuperable
    expect(html).toContain('últimos 7 días');
  });

  it('las flechas miden ≥24px (w-6/h-6) y ya no traen el w-4 h-4 viejo', () => {
    const html = renderToStaticMarkup(<MotorFiscalPeriodo series={SERIE} />);
    expect(html).toMatch(/aria-label="Periodo más corto"[^>]*class="[^"]*\bw-6\b[^"]*\bh-6\b/);
    expect(html).toMatch(/aria-label="Periodo más largo"[^>]*class="[^"]*\bw-6\b[^"]*\bh-6\b/);
    expect(html).not.toMatch(/\bw-4 h-4 rounded flex items-center justify-center\b/);
  });
});
