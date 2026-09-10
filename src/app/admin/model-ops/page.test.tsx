import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/model-ops — CERO cobertura. Sólo lectura, sin server actions (puerta
// en layout.tsx). Lo real que se vigila: "sin llamadas" vs una fase con
// llamadas reales no se confunden (un $0 medido no es lo mismo que "nunca
// corrió"), y el roadmap declara honestamente lo que NO existe (versionado,
// rollback, selector de modelo por fase) en vez de aparentarlo.
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({ getResumenNegocio: vi.fn(), getCostoPorFaseModelo: vi.fn() }));
vi.mock('@/lib/admin/negocio', () => ({ getResumenNegocio: dobles.getResumenNegocio, getCostoPorFaseModelo: dobles.getCostoPorFaseModelo }));

import ModelOpsPage from './page';

async function renderizar() { return renderToStaticMarkup(await ModelOpsPage()); }

beforeEach(() => {
  vi.clearAllMocks();
  dobles.getResumenNegocio.mockResolvedValue({ porFase: [], porModelo: [] });
  dobles.getCostoPorFaseModelo.mockResolvedValue([]);
});

it('sin actividad de ninguna fase: dice "sin llamadas" en las tres, no un $0 que parezca medición real', async () => {
  const html = await renderizar();
  expect((html.match(/sin llamadas/g) ?? []).length).toBeGreaterThanOrEqual(3);
  expect(html).toContain('Todavía no hay actividad de IA registrada');
  expect(html).toContain('Sin llamadas registradas todavía');
});

it('una fase con llamadas reales muestra su costo y conteo verdaderos, desglosados por modelo', async () => {
  dobles.getResumenNegocio.mockResolvedValue({
    porFase: [{ fase: 'ocr', costoUsd: 12.5, n: 340 }],
    porModelo: [{ modelo: 'gpt-5-mini', costoUsd: 12.5 }],
  });
  dobles.getCostoPorFaseModelo.mockResolvedValue([{ fase: 'ocr', modelo: 'gpt-5-mini', costoUsd: 12.5, n: 340 }]);
  const html = await renderizar();
  expect(html).toContain('340');
  expect(html).toContain('gpt-5-mini');
  // Las otras dos fases (cuadre, whatsapp) siguen sin llamadas — no se les
  // atribuye por error el costo/n de OCR.
  expect(html).toContain('Sin llamadas registradas para esta fase todavía.');
});

it('el roadmap declara lo que NO existe hoy — no aparenta versionado/selector de modelo', async () => {
  const html = await renderizar();
  expect(html).toContain('sin historial de versiones ni UI de edición');
  expect(html).toContain('No existe tampoco un selector de modelo por fase ni tenant');
});

it('pide el resumen y el costo por fase/modelo en paralelo, sin argumentos de tenant — es cross-tenant a propósito', async () => {
  await renderizar();
  expect(dobles.getResumenNegocio).toHaveBeenCalledWith();
  expect(dobles.getCostoPorFaseModelo).toHaveBeenCalledWith();
});
