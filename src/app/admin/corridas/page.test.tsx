import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/corridas — CERO cobertura de la PÁGINA (corridasFiltradas ya tiene
// prueba propia). Tiene su PROPIA llamada a requireSuperadmin() —redundante
// con el layout, a propósito, mismo patrón que otras páginas de /admin—, sin
// server actions (filtros por GET). Se vigila: fallo de lectura ≠ "no
// existen"; vacío-por-filtro ≠ vacío-real; costoUsd null (no midió) ≠ $0.00
// (gastó cero); "tareas" ambos-o-ninguno; el error de una corrida se pinta
// en la lista, no sólo en su traza.
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({
  requireSuperadmin: vi.fn(),
  corridasFiltradas: vi.fn(),
}));

vi.mock('@/lib/auth/guard', () => ({ requireSuperadmin: dobles.requireSuperadmin }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('@/lib/admin/corridas-cruzadas', async (importar) => ({
  ...(await importar<typeof import('@/lib/admin/corridas-cruzadas')>()),
  corridasFiltradas: dobles.corridasFiltradas,
}));

import IndiceCorridas from './page';

async function renderizar(sp: Record<string, string> = {}) {
  return renderToStaticMarkup(await IndiceCorridas({ searchParams: Promise.resolve(sp) }));
}
const CORRIDA_OK = {
  id: 'c-1', agente: 'cobranza', tenantNombre: 'Transportes Uno', estado: 'ok',
  inicio: '2026-01-01T00:00:00Z', duracionMs: 5000, tareasHechas: 3, tareasTotal: 3,
  costoUsd: 0.0042, error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  dobles.requireSuperadmin.mockResolvedValue({ nombre: 'Javier', avatarUrl: null });
  dobles.corridasFiltradas.mockResolvedValue({ corridas: [], pagina: 1, paginas: 1, total: 0 });
});

it('exige superadmin ANTES de leer corridas — puerta propia, redundante con el layout', async () => {
  await renderizar();
  expect(dobles.requireSuperadmin).toHaveBeenCalled();
});

it('sin filtro, cero corridas dice "aún no hay corridas" — vacío REAL', async () => {
  const html = await renderizar();
  expect(html).toContain('Aún no hay corridas');
});

it('con filtro, cero corridas dice "ninguna coincide" — distinto del vacío real', async () => {
  const html = await renderizar({ agente: 'cobranza' });
  expect(dobles.corridasFiltradas).toHaveBeenCalledWith({ agente: 'cobranza', estado: undefined, tenantId: undefined, pagina: 1 });
  expect(html).toContain('Ninguna corrida coincide con el filtro');
});

it('una lectura caída dice "la consulta falló", nunca "no existen"', async () => {
  dobles.corridasFiltradas.mockRejectedValueOnce(new Error('la base no contestó'));
  const html = await renderizar();
  expect(html).toContain('No se pudieron leer las corridas');
  expect(html).toContain('no es que no existan');
});

it('costoUsd NULL se pinta "—" con su porqué, nunca como $0.00 (no midió ≠ gastó cero)', async () => {
  dobles.corridasFiltradas.mockResolvedValue({ corridas: [{ ...CORRIDA_OK, costoUsd: null }], pagina: 1, paginas: 1, total: 1 });
  const html = await renderizar();
  expect(html).toContain('no midió su gasto');
  expect(html).not.toContain('$0.00');
});

it('tareasHechas/tareasTotal es ambos-o-ninguno: si uno falta, se pinta "—" completo', async () => {
  dobles.corridasFiltradas.mockResolvedValue({ corridas: [{ ...CORRIDA_OK, tareasHechas: 3, tareasTotal: null }], pagina: 1, paginas: 1, total: 1 });
  const html = await renderizar();
  expect(html).not.toContain('3 de');
});

it('el error de una corrida se pinta en la LISTA, no sólo en su traza', async () => {
  dobles.corridasFiltradas.mockResolvedValue({ corridas: [{ ...CORRIDA_OK, estado: 'fallo', error: 'timeout al llamar al PAC' }], pagina: 1, paginas: 1, total: 1 });
  const html = await renderizar();
  expect(html).toContain('timeout al llamar al PAC');
});

it('la página pedida (?p=) viaja al filtro; una página inválida cae a 1', async () => {
  await renderizar({ p: '4' });
  expect(dobles.corridasFiltradas).toHaveBeenCalledWith(expect.objectContaining({ pagina: 4 }));

  await renderizar({ p: 'nan' });
  expect(dobles.corridasFiltradas).toHaveBeenLastCalledWith(expect.objectContaining({ pagina: 1 }));
});
