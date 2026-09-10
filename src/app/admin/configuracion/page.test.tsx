import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/configuracion — CERO cobertura de la página. getResumenNegocio ya
// tiene prueba propia. Lo que se vigila: el plan mostrado es el de CADA
// flota real (tenant.plan), "sin flotas" se dice cuando de verdad no hay
// ninguna, y la corrección ADM-5 (auditoría 24) sigue en pantalla — la
// lógica de límites SÍ existe (suscripcion.ts), sólo que esta pantalla no
// la muestra todavía.
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({ getResumenNegocio: vi.fn() }));
vi.mock('@/lib/admin/negocio', () => ({ getResumenNegocio: dobles.getResumenNegocio }));

import ConfiguracionPage from './page';

beforeEach(() => { vi.clearAllMocks(); });

it('sin flotas dadas de alta, lo dice — no una lista vacía sin explicación', async () => {
  dobles.getResumenNegocio.mockResolvedValue({ flotas: [] });
  const html = renderToStaticMarkup(await ConfiguracionPage());
  expect(html).toContain('Sin flotas dadas de alta todavía');
});

it('con flotas reales, muestra el nombre y el plan de CADA una', async () => {
  dobles.getResumenNegocio.mockResolvedValue({
    flotas: [{ id: 'f-1', nombre: 'Transportes García', plan: 'pro' }, { id: 'f-2', nombre: 'Fletes del Sur', plan: 'basico' }],
  });
  const html = renderToStaticMarkup(await ConfiguracionPage());
  expect(html).toContain('Transportes García');
  expect(html).toContain('pro');
  expect(html).toContain('Fletes del Sur');
  expect(html).toContain('basico');
});

it('ADM-24 (auditoría 24): declara que la lógica de límites SÍ existe en suscripcion.ts, sólo que esta pantalla no la muestra', async () => {
  dobles.getResumenNegocio.mockResolvedValue({ flotas: [] });
  const html = renderToStaticMarkup(await ConfiguracionPage());
  expect(html).toContain('lib/saas/suscripcion.ts');
  expect(html).toContain('esta pantalla todavía no la muestra por');
});
