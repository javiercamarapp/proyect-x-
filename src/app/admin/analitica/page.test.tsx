import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/analitica — CERO cobertura. Sólo lectura (puerta en layout.tsx). Lo
// real que se vigila: los umbrales de "hay suficiente historia" están
// escritos a propósito por encima de cero — un solo día de costo NO alcanza
// para una gráfica de tendencia (necesita >1 punto), y eso es fácil de
// romper por accidente si alguien "simplifica" el `> 1` a `> 0`.
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({ getResumenNegocio: vi.fn() }));
vi.mock('@/lib/admin/negocio', () => ({ getResumenNegocio: dobles.getResumenNegocio }));

import AnaliticaPage from './page';

async function renderizar() { return renderToStaticMarkup(await AnaliticaPage()); }
const BASE = { facturasTotal: 0, porDia: [], porFase: [], porModelo: [], facturasPorDia: [], tenants: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  dobles.getResumenNegocio.mockResolvedValue({ ...BASE });
});

it('un solo día de costo NO es "suficiente historial" para la tendencia — el umbral es >1, no >0', async () => {
  dobles.getResumenNegocio.mockResolvedValue({ ...BASE, porDia: [{ dia: '2026-01-01', costoUsd: 5 }] });
  const html = await renderizar();
  expect(html).toContain('Sin historial suficiente todavía');
});

it('dos días sí muestran la gráfica de tendencia', async () => {
  dobles.getResumenNegocio.mockResolvedValue({ ...BASE, porDia: [{ dia: '2026-01-01', costoUsd: 5 }, { dia: '2026-01-02', costoUsd: 7 }] });
  const html = await renderizar();
  expect(html).not.toContain('Sin historial suficiente todavía');
});

it('facturas por día en cero de verdad (todas n=0) dice "aún sin datos", no una barra en cero que parezca medida', async () => {
  dobles.getResumenNegocio.mockResolvedValue({ ...BASE, facturasPorDia: [{ dia: '2026-01-01', n: 0 }, { dia: '2026-01-02', n: 0 }] });
  const html = await renderizar();
  expect(html).toContain('Aún sin datos suficientes');
});

it('si AL MENOS un día tiene facturas reales, sí se grafica (no exige que todos los días tengan datos)', async () => {
  dobles.getResumenNegocio.mockResolvedValue({ ...BASE, facturasPorDia: [{ dia: '2026-01-01', n: 0 }, { dia: '2026-01-02', n: 3 }] });
  const html = await renderizar();
  expect(html).not.toContain('Aún sin datos suficientes');
});

it('declara honestamente por qué faltan histogramas/mapa de calor — cita el número real de flotas, singular/plural correcto', async () => {
  dobles.getResumenNegocio.mockResolvedValue({ ...BASE, tenants: 1 });
  let html = await renderizar();
  expect(html).toContain('1 flota');
  expect(html).not.toContain('1 flotas');

  dobles.getResumenNegocio.mockResolvedValue({ ...BASE, tenants: 3 });
  html = await renderizar();
  expect(html).toContain('3 flotas');
});

it('el total histórico de facturas es la cifra real de getResumenNegocio, sin filtro de fecha', async () => {
  dobles.getResumenNegocio.mockResolvedValue({ ...BASE, facturasTotal: 12345 });
  await renderizar();
  expect(dobles.getResumenNegocio).toHaveBeenCalledWith();
});
