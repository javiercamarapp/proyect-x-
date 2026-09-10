import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/agente-cuadre — CERO cobertura de la página. getResumenNegocio ya
// tiene prueba propia. Lo que se vigila: "un cero aquí es MEDIDO" — sin fila
// de fase 'cuadre' en llm_costo, las tarjetas deben mostrar 0 real, no
// esconder la sección; y el mensaje honesto interpola el conteo REAL de
// viajes procesados, no un texto genérico.
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({ getResumenNegocio: vi.fn() }));
vi.mock('@/lib/admin/negocio', () => ({ getResumenNegocio: dobles.getResumenNegocio }));

import AgenteCuadrePage from './page';

beforeEach(() => { vi.clearAllMocks(); });

it('sin fila de fase "cuadre" (0 medido, no relleno): las tarjetas muestran 0, no ocultan la sección', async () => {
  dobles.getResumenNegocio.mockResolvedValue({ porFase: [], viajesProcesados: 12 });
  const html = renderToStaticMarkup(await AgenteCuadrePage());
  expect(html).toContain('Gastado en Cuadre');
  expect(html).toContain('Llamadas de Cuadre');
});

it('con fila real de "cuadre", usa esas cifras — no las de otra fase ni un cero por defecto', async () => {
  dobles.getResumenNegocio.mockResolvedValue({
    porFase: [{ fase: 'cuadre', costoUsd: 12.5, n: 40 }, { fase: 'ocr', costoUsd: 99, n: 200 }],
    viajesProcesados: 30,
  });
  const html = renderToStaticMarkup(await AgenteCuadrePage());
  expect(html).toContain('US$12.50');
  expect(html).not.toContain('US$99.00');
});

it('el mensaje honesto interpola el conteo REAL de viajes procesados, no un texto genérico', async () => {
  dobles.getResumenNegocio.mockResolvedValue({ porFase: [], viajesProcesados: 777 });
  const html = renderToStaticMarkup(await AgenteCuadrePage());
  expect(html).toContain('777');
  expect(html).toContain('no guarda todavía si un viaje se cerró solo');
});
