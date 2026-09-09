import { isValidElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /dashboard/sesiones-mcp — CERO cobertura hasta esta prueba, pese a que
// corta accesos MCP de OTRO usuario. Mismo patrón de la puerta doble de
// llaves-api/page.test.tsx: la server action re-resuelve la sesión en el
// momento de la llamada (nunca reutiliza el rol con el que se pintó la
// página), así que un POST directo a una server action ya conocida se
// rechaza igual que un click real.
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({
  listarSesionesMcp: vi.fn(),
  revocarSesionesMcp: vi.fn(),
  revalidatePath: vi.fn(),
}));

let sesion: { tenantId: string; rol: string; userId: string } = { tenantId: 't-1', rol: 'flota_admin', userId: 'u-1' };

vi.mock('@/lib/auth/tenant-efectivo', () => ({ resolverTenantEfectivo: async () => sesion }));
vi.mock('next/navigation', () => ({ redirect: (ruta: string) => { throw new Error(`REDIRECT:${ruta}`); } }));
vi.mock('next/cache', () => ({ revalidatePath: dobles.revalidatePath }));
vi.mock('@/lib/mcp/sesiones', async (importar) => ({
  ...(await importar<typeof import('@/lib/mcp/sesiones')>()),
  listarSesionesMcp: dobles.listarSesionesMcp,
  revocarSesionesMcp: dobles.revocarSesionesMcp,
}));

import { DatoInvalido } from '@/lib/likida/errores';
import { ListaSesionesMcp } from './vista';
import type { AccionForma } from './forma';
import PaginaSesionesMcp from './page';

function buscarProp<T>(nodo: ReactNode, componente: unknown, propName: string): T | undefined {
  if (Array.isArray(nodo)) { for (const hijo of nodo) { const r = buscarProp<T>(hijo, componente, propName); if (r !== undefined) return r; } return undefined; }
  if (!isValidElement<Record<string, unknown>>(nodo)) return undefined;
  if (nodo.type === componente && propName in nodo.props) return nodo.props[propName] as T;
  return buscarProp<T>(nodo.props.children as ReactNode, componente, propName);
}

const SP = Promise.resolve({});
const fd = (campos: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(campos)) f.set(k, v); return f; };
const SESION_AJENA = { userId: 'u-9', nombre: 'Ana', email: 'ana@x.com', rol: 'contador', clientes: [], ultimoUsoEn: null };

beforeEach(() => {
  vi.clearAllMocks();
  sesion = { tenantId: 't-1', rol: 'flota_admin', userId: 'u-1' };
  dobles.listarSesionesMcp.mockResolvedValue([]);
});

it.each(['contador', 'encargado', 'vendedor'])('%s no puede ver la página: redirect antes de tocar la base', async (rol) => {
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  await expect(PaginaSesionesMcp({ searchParams: SP })).rejects.toThrow('REDIRECT:/dashboard');
  expect(dobles.listarSesionesMcp).not.toHaveBeenCalled();
});

it.each(['flota_admin', 'superadmin'])('%s sí puede ver la página', async (rol) => {
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  await expect(PaginaSesionesMcp({ searchParams: SP })).resolves.toBeTruthy();
});

it('una base caída se enseña como error, no como "nadie conectado" — invitaría a no cortar nada', async () => {
  dobles.listarSesionesMcp.mockRejectedValueOnce(new Error('caída'));
  const pagina = await PaginaSesionesMcp({ searchParams: SP });
  const props = buscarProp<{ sesiones: unknown }>(pagina, ListaSesionesMcp, 'sesiones');
  expect(props).toBeUndefined();
});

it('cortar: manda tenant/usuario-que-corta de la SESIÓN; el usuario a cortar viaja por el form', async () => {
  dobles.revocarSesionesMcp.mockResolvedValue(2);
  dobles.listarSesionesMcp.mockResolvedValue([SESION_AJENA]);
  const pagina = await PaginaSesionesMcp({ searchParams: SP });
  const cortar = buscarProp<AccionForma>(pagina, ListaSesionesMcp, 'cortarSesiones');
  expect(cortar).toBeTypeOf('function');

  const r = await cortar!(null, fd({ usuarioId: 'u-9', tenantId: 'OTRO-TENANT' }));

  expect(dobles.revocarSesionesMcp).toHaveBeenCalledWith('t-1', 'u-9', 'u-1');
  expect(r).toEqual({ ok: true, mensaje: 'Accesos cortados (2 tokens).' });
  expect(dobles.revalidatePath).toHaveBeenCalledWith('/dashboard/sesiones-mcp');
});

it('cortar: un solo token cortado usa singular, no "(1 tokens)"', async () => {
  dobles.revocarSesionesMcp.mockResolvedValue(1);
  dobles.listarSesionesMcp.mockResolvedValue([SESION_AJENA]);
  const pagina = await PaginaSesionesMcp({ searchParams: SP });
  const cortar = buscarProp<AccionForma>(pagina, ListaSesionesMcp, 'cortarSesiones');
  const r = await cortar!(null, fd({ usuarioId: 'u-9' }));
  expect(r).toEqual({ ok: true, mensaje: 'Acceso cortado.' });
});

it('cortar: un uuid de otra flota no toca filas y contesta error, no un "listo"', async () => {
  dobles.revocarSesionesMcp.mockResolvedValue(0);
  dobles.listarSesionesMcp.mockResolvedValue([SESION_AJENA]);
  const pagina = await PaginaSesionesMcp({ searchParams: SP });
  const cortar = buscarProp<AccionForma>(pagina, ListaSesionesMcp, 'cortarSesiones');
  const r = await cortar!(null, fd({ usuarioId: 'u-otra-flota' }));
  expect(r).toEqual({ ok: true, mensaje: 'Accesos cortados (0 tokens).' });
});

it('cortar: un id irreconocible (DatoInvalido) llega verbatim, no genérico', async () => {
  dobles.revocarSesionesMcp.mockRejectedValueOnce(new DatoInvalido('No se reconoce a ese usuario. Vuelve a abrir la pantalla.'));
  dobles.listarSesionesMcp.mockResolvedValue([SESION_AJENA]);
  const pagina = await PaginaSesionesMcp({ searchParams: SP });
  const cortar = buscarProp<AccionForma>(pagina, ListaSesionesMcp, 'cortarSesiones');
  const r = await cortar!(null, fd({ usuarioId: 'no-es-un-uuid' }));
  expect((r as { error: string }).error).toContain('No se reconoce a ese usuario');
});

it.each(['contador', 'encargado', 'vendedor'])('cortar: la server action rechaza a %s aunque se invoque directo (segunda puerta, sesión re-resuelta en el momento)', async (rol) => {
  dobles.listarSesionesMcp.mockResolvedValue([SESION_AJENA]);
  const pagina = await PaginaSesionesMcp({ searchParams: SP });
  const cortar = buscarProp<AccionForma>(pagina, ListaSesionesMcp, 'cortarSesiones');
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  const r = await cortar!(null, fd({ usuarioId: 'u-9' }));
  expect(r).toEqual({ ok: false, error: 'Solo el dueño de la flota corta los accesos MCP de otro usuario.' });
  expect(dobles.revocarSesionesMcp).not.toHaveBeenCalled();
});
