import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/equipo — CERO cobertura. La puerta (requireSuperadmin) vive en
// layout.tsx, compartida por todo /admin — no se repite aquí. Esta página no
// tiene server actions: es sólo lectura, cruzada de TODOS los tenants a
// propósito (getEquipo() sin filtro). Lo real que se vigila: el orden por
// jerarquía operativa (no alfabético), y que el rótulo "los 5 roles reales"
// no mienta si algún día cambia el dominio.
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({ getEquipo: vi.fn() }));
vi.mock('@/lib/admin/negocio', () => ({ getEquipo: dobles.getEquipo }));

import PaginaEquipo from './page';

const SP = Promise.resolve({});
async function renderizar(sp = SP) { return renderToStaticMarkup(await PaginaEquipo({ searchParams: sp })); }
const miembro = (over: Partial<{ id: string; email: string; nombre: string | null; rol: string; tenantId: string | null; tenantNombre: string | null; operadorId: string | null }>) => ({
  id: 'u-1', email: 'x@x.com', nombre: 'X', rol: 'contador', tenantId: 't-1', tenantNombre: 'Flota X', operadorId: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  dobles.getEquipo.mockResolvedValue([]);
});

it('lee el roster COMPLETO sin filtrar por tenant — getEquipo() sin argumentos', async () => {
  await renderizar();
  expect(dobles.getEquipo).toHaveBeenCalledWith();
});

it('ordena por jerarquía operativa, no alfabético: superadmin, vendedor, flota_admin, encargado, contador', async () => {
  dobles.getEquipo.mockResolvedValue([
    miembro({ id: 'c', rol: 'contador', nombre: 'Contador' }),
    miembro({ id: 's', rol: 'superadmin', nombre: 'Super', tenantId: null, tenantNombre: null }),
    miembro({ id: 'e', rol: 'encargado', nombre: 'Encargado' }),
    miembro({ id: 'f', rol: 'flota_admin', nombre: 'Dueno' }),
    miembro({ id: 'v', rol: 'vendedor', nombre: 'Vendedor', tenantId: null, tenantNombre: null }),
  ]);
  const html = await renderizar();
  const posiciones = ['Super', 'Vendedor', 'Dueno', 'Encargado', 'Contador'].map((n) => html.indexOf(n));
  expect(posiciones).toEqual([...posiciones].sort((a, b) => a - b));
  expect(posiciones.every((p) => p !== -1)).toBe(true);
});

it('un rol fuera del dominio conocido no revienta el orden — se manda al final, no se pierde', async () => {
  dobles.getEquipo.mockResolvedValue([
    miembro({ id: 'x', rol: 'rol_invalido', nombre: 'Raro' }),
    miembro({ id: 's', rol: 'superadmin', nombre: 'Super', tenantId: null, tenantNombre: null }),
  ]);
  const html = await renderizar();
  expect(html.indexOf('Super')).toBeLessThan(html.indexOf('Raro'));
});

it('superadmin sin flota se dice explícitamente, no un guion ambiguo', async () => {
  dobles.getEquipo.mockResolvedValue([miembro({ id: 's', rol: 'superadmin', nombre: 'Super', tenantId: null, tenantNombre: null })]);
  const html = await renderizar();
  expect(html).toContain('superadmin, sin flota');
});

it('cero cuentas dice "sin usuarios dados de alta" — no una tabla vacía muda', async () => {
  const html = await renderizar();
  expect(html).toContain('Sin usuarios dados de alta');
});

it('el rótulo declara los 5 roles reales del dominio, con vendedor incluido (no los 4 de antes)', async () => {
  const html = await renderizar();
  expect(html).toContain('Los 5 roles reales del sistema');
  expect(html).toContain('vendedor');
  expect(html).toContain('contador');
});

it('la búsqueda (?q=) filtra también por nombre de flota, no sólo por nombre/correo de la persona', async () => {
  dobles.getEquipo.mockResolvedValue([
    miembro({ id: 'a', nombre: 'Ana', tenantNombre: 'Transportes Norte' }),
    miembro({ id: 'b', nombre: 'Beto', tenantNombre: 'Fletes Sur' }),
  ]);
  const html = await renderizar(Promise.resolve({ q: 'Norte' }));
  expect(html).toContain('Ana');
  expect(html).not.toContain('Beto');
});
