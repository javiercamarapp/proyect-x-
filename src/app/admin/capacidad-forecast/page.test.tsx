import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/capacidad-forecast — CERO cobertura. La puerta (requireSuperadmin)
// vive en el layout de /admin (src/app/admin/layout.tsx), no aquí — esta
// página no repite el gate. Lo que sí es de esta página: la extrapolación
// lineal HONESTA (proyectar(), local, no exportada) y que sin muestra no se
// inventa un escenario con base fantasma.
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({
  getResumenNegocio: vi.fn(),
  getUnidadesMedidas: vi.fn(),
}));

vi.mock('@/lib/admin/negocio', () => ({ getResumenNegocio: dobles.getResumenNegocio }));
vi.mock('@/lib/admin/capacidad', async (importar) => ({
  ...(await importar<typeof import('@/lib/admin/capacidad')>()),
  getUnidadesMedidas: dobles.getUnidadesMedidas,
}));

import CapacidadForecastPage from './page';
async function renderizar() { return renderToStaticMarkup(await CapacidadForecastPage()); }

beforeEach(() => {
  vi.clearAllMocks();
  dobles.getUnidadesMedidas.mockResolvedValue(null);
});

it('sin ningún día de costo registrado, no inventa una proyección — dice que no hay base', async () => {
  dobles.getResumenNegocio.mockResolvedValue({ porDia: [], porModelo: [] });
  const html = await renderizar();
  expect(html).toContain('Sin datos de costo de IA registrados todavía');
});

it('proyecta el promedio diario × 30 sobre la VENTANA DE CALENDARIO, no solo días con actividad', async () => {
  // Dos días de actividad con un hueco de un día en medio: la ventana real
  // es 3 días de calendario (1,2,3-ene), no 2 (solo los días con fila).
  dobles.getResumenNegocio.mockResolvedValue({
    porDia: [{ dia: '2026-01-01', costoUsd: 30 }, { dia: '2026-01-03', costoUsd: 30 }],
    porModelo: [],
  });
  const html = await renderizar();
  // total 60 / 3 días de ventana = 20/día; × 30 = 600.
  expect(html).toContain('últimos 3 días');
  expect(html).toMatch(/\$?20\b/); // promedio diario
  expect(html).toMatch(/\$?600\b/); // proyección a 30 días
});

it('con menos de 7 días de historia, avisa que la cifra es apenas indicativa', async () => {
  dobles.getResumenNegocio.mockResolvedValue({ porDia: [{ dia: '2026-01-01', costoUsd: 10 }], porModelo: [] });
  const html = await renderizar();
  expect(html).toContain('apenas indicativa');
});

it('sin unidades medidas (lectura caída), no pinta escenarios con base fantasma', async () => {
  dobles.getResumenNegocio.mockResolvedValue({ porDia: [{ dia: '2026-01-01', costoUsd: 10 }], porModelo: [] });
  dobles.getUnidadesMedidas.mockRejectedValueOnce(new Error('caída'));
  const html = await renderizar();
  expect(html).toContain('No se pudieron leer las unidades medidas');
  expect(html).not.toContain('Viajes/día');
});

it('con unidades medidas, el escenario dice "sin base medida" para costo IA cuando no hay liquidaciones en 30d', async () => {
  dobles.getResumenNegocio.mockResolvedValue({ porDia: [{ dia: '2026-01-01', costoUsd: 10 }], porModelo: [] });
  dobles.getUnidadesMedidas.mockResolvedValue({ costoIaPorViaje: null, muestraViajes: 0 });
  const html = await renderizar();
  expect(html).toContain('Sin liquidaciones en 30d');
  expect(html).toContain('sin base medida');
});
