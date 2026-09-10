import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/calidad-evals — CERO cobertura de la PÁGINA (getEstadoEvals y
// getCalidadCorridas/getCalidadOcr ya tienen prueba propia). Sólo lectura,
// sin server actions (requireSuperadmin lo hace el layout). Lo real que se
// vigila: las cuatro fuentes caen CADA UNA por su lado (.catch(() => null))
// — una base caída en una no debe tumbar ni ocultar las otras tres, y cada
// null se dice explícitamente en vez de pintarse como cero o vacío real.
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({
  getEstadoEvals: vi.fn(),
  getCalidadCorridas: vi.fn(),
  getCalidadOcr: vi.fn(),
}));

vi.mock('@/lib/admin/evals', () => ({ getEstadoEvals: dobles.getEstadoEvals }));
vi.mock('@/lib/admin/calidad', () => ({ getCalidadCorridas: dobles.getCalidadCorridas, getCalidadOcr: dobles.getCalidadOcr }));

import CalidadEvalsPage from './page';

async function renderizar() { return renderToStaticMarkup(await CalidadEvalsPage()); }

const EVALS_OK = { driftDePrompt: false, ultima: { veredicto: 'paso', iniciadaEn: '2026-01-01T00:00:00Z', casos: 32, notas: null }, casosActivos: 32 };
const CORRIDAS_OK = { total: 10, ok: 9, parcial: 1, fallo: 0, porAgente: [] };
const OCR_OK = { fotosMedidas: 5, precisionPct: 0.9, camposOk: 90, camposMal: 10, camposNoMedidos: 0, alucinaciones: 0, ultimaMedicionEn: '2026-01-01T00:00:00Z' };

beforeEach(() => {
  vi.clearAllMocks();
  dobles.getEstadoEvals.mockResolvedValue(EVALS_OK);
  dobles.getCalidadCorridas.mockResolvedValue(CORRIDAS_OK);
  dobles.getCalidadOcr.mockResolvedValue(OCR_OK);
});

it('pide el examen del analista Y el del contador por separado (dos exámenes distintos, E.26 fase 2)', async () => {
  await CalidadEvalsPage();
  expect(dobles.getEstadoEvals).toHaveBeenCalledWith('analista');
  expect(dobles.getEstadoEvals).toHaveBeenCalledWith('contador');
});

it('si el examen del analista falla, el del contador se sigue leyendo (no comparten catch)', async () => {
  dobles.getEstadoEvals.mockImplementation(async (quien: string) => {
    if (quien === 'analista') throw new Error('caído');
    return EVALS_OK;
  });
  const html = await renderizar();
  expect(html).toContain('No se pudo leer el estado del examen');
  expect(html).toContain('32 caso(s) activos en el banco');
});

it('una base caída de corridas no se ve como "cero corridas" (son dos afirmaciones distintas)', async () => {
  dobles.getCalidadCorridas.mockRejectedValueOnce(new Error('caída'));
  const html = await renderizar();
  expect(html).toContain('No se pudieron leer las corridas — esto NO significa que no haya fallos');
  expect(html).not.toContain('Cero corridas en la ventana');
});

it('cero corridas DE VERDAD (lectura ok, total=0) dice que no corrieron, no que estén sanos', async () => {
  dobles.getCalidadCorridas.mockResolvedValue({ total: 0, ok: 0, parcial: 0, fallo: 0, porAgente: [] });
  const html = await renderizar();
  expect(html).toContain('Eso no dice que los agentes estén sanos');
});

it('una falla del OCR no se confunde con "banco vacío, cero fotos medidas"', async () => {
  dobles.getCalidadOcr.mockRejectedValueOnce(new Error('caída'));
  const html = await renderizar();
  expect(html).toContain('No se pudo leer la medición del OCR');
  expect(html).not.toContain('ninguna foto tiene medición todavía');
});

it('las cuatro fuentes caídas a la vez no tumban la página — cada tarjeta dice su propio "no se pudo"', async () => {
  dobles.getEstadoEvals.mockRejectedValue(new Error('caída'));
  dobles.getCalidadCorridas.mockRejectedValueOnce(new Error('caída'));
  dobles.getCalidadOcr.mockRejectedValueOnce(new Error('caída'));
  const html = await renderizar();
  expect((html.match(/No se pud[oi]/g) ?? []).length).toBeGreaterThanOrEqual(4);
});

it('un fallo/parcial real de una corrida de agente se lista con su nombre, no se agrega en silencio', async () => {
  dobles.getCalidadCorridas.mockResolvedValue({
    total: 5, ok: 3, parcial: 1, fallo: 1,
    porAgente: [{ agente: 'analista', ok: 3, parcial: 0, fallo: 1 }, { agente: 'contador', ok: 0, parcial: 1, fallo: 0 }],
  });
  const html = await renderizar();
  expect(html).toContain('analista');
  expect(html).toContain('contador');
});
