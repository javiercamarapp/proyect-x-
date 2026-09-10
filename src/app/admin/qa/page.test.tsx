import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/qa — CERO cobertura de la PÁGINA (qa-storage.ts ya tiene prueba
// propia de cada función). Sólo lectura, sin server actions — el layout de
// /admin ya gatea con requireSuperadmin(). Lo real que se vigila: CUATRO
// fuentes independientes (banco de fotos, historial, gasto, lecturas de
// OCR), cada una con su propio `.catch()` — la caída de UNA no debe vaciar
// las otras tres, y cada `*Error` debe distinguirse de "no hay datos".
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({
  leerManifiesto: vi.fn(),
  listarCorridas: vi.fn(),
  gastoHoyUsd: vi.fn(),
  leerUltimasLecturas: vi.fn(),
  firmarRutas: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/admin/qa-storage', async (importar) => ({
  ...(await importar<typeof import('@/lib/admin/qa-storage')>()),
  leerManifiesto: dobles.leerManifiesto,
  listarCorridas: dobles.listarCorridas,
  gastoHoyUsd: dobles.gastoHoyUsd,
  leerUltimasLecturas: dobles.leerUltimasLecturas,
  firmarRutas: dobles.firmarRutas,
}));
vi.mock('./pantalla', () => ({ PantallaQa: (props: unknown) => props }));

import QaPage from './page';

type PropsQa = {
  fotos: unknown[]; bancoError: string | null;
  corridas: unknown[]; historialError: string | null;
  gastoHoy: number | null; gastoError: string | null;
  lecturasIniciales: Record<string, unknown>; lecturasError: string | null;
};

beforeEach(() => {
  vi.clearAllMocks();
  dobles.leerManifiesto.mockResolvedValue({ ok: true, datos: [] });
  dobles.firmarRutas.mockResolvedValue(new Map());
  dobles.listarCorridas.mockResolvedValue({ ok: true, datos: [] });
  dobles.gastoHoyUsd.mockResolvedValue({ ok: true, datos: 0 });
  dobles.leerUltimasLecturas.mockResolvedValue({ ok: true, datos: new Map() });
});

it('las cuatro fuentes en verde: cero errores, datos reales llegan a la pantalla', async () => {
  dobles.leerManifiesto.mockResolvedValue({ ok: true, datos: [{ path: 'a.jpg' }] });
  dobles.firmarRutas.mockResolvedValue(new Map([['a.jpg', 'https://firmada/a.jpg']]));
  dobles.gastoHoyUsd.mockResolvedValue({ ok: true, datos: 12.5 });
  const pagina = await QaPage() as unknown as { props: PropsQa };
  expect(pagina.props.fotos).toEqual([{ path: 'a.jpg', url: 'https://firmada/a.jpg' }]);
  expect(pagina.props.gastoHoy).toBe(12.5);
  expect(pagina.props.bancoError).toBeNull();
});

it('el banco de fotos caído no vacía historial/gasto/lecturas — cada fuente es independiente', async () => {
  dobles.leerManifiesto.mockRejectedValueOnce(new Error('storage caído'));
  dobles.listarCorridas.mockResolvedValue({ ok: true, datos: [{ id: 'c-1' }] });
  dobles.gastoHoyUsd.mockResolvedValue({ ok: true, datos: 5 });
  const pagina = await QaPage() as unknown as { props: PropsQa };
  expect(pagina.props.fotos).toEqual([]);
  expect(pagina.props.bancoError).toContain('storage caído');
  expect(pagina.props.corridas).toEqual([{ id: 'c-1' }]);
  expect(pagina.props.gastoHoy).toBe(5);
  expect(dobles.firmarRutas).not.toHaveBeenCalled(); // sin manifiesto, nada que firmar
});

it('un `{ok:false}` propio de gastoHoyUsd se distingue de "$0 real" — nunca se confunden', async () => {
  dobles.gastoHoyUsd.mockResolvedValue({ ok: false, error: 'no se pudo leer el gasto del día' });
  const pagina = await QaPage() as unknown as { props: PropsQa };
  expect(pagina.props.gastoHoy).toBeNull();
  expect(pagina.props.gastoError).toBe('no se pudo leer el gasto del día');
});

it('las lecturas de OCR (Map) se serializan a objeto plano para viajar al cliente', async () => {
  dobles.leerUltimasLecturas.mockResolvedValue({
    ok: true,
    datos: new Map([['foto-1', { corridaEn: '2026-01-01', modelo: 'gpt', medicion: {}, costoUsd: 0.01, motivo: null }]]),
  });
  const pagina = await QaPage() as unknown as { props: PropsQa };
  expect(pagina.props.lecturasIniciales).toEqual({
    'foto-1': { corridaEn: '2026-01-01', modelo: 'gpt', medicion: {}, costoUsd: 0.01, motivo: null },
  });
});

it('lecturas de OCR caídas no vacían el resto — fuente propia, mismo criterio', async () => {
  dobles.leerUltimasLecturas.mockRejectedValueOnce(new Error('caída'));
  dobles.listarCorridas.mockResolvedValue({ ok: true, datos: [{ id: 'c-1' }] });
  const pagina = await QaPage() as unknown as { props: PropsQa };
  expect(pagina.props.lecturasIniciales).toEqual({});
  expect(pagina.props.lecturasError).toContain('caída');
  expect(pagina.props.corridas).toEqual([{ id: 'c-1' }]);
});
