import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/elegir-flota — CERO cobertura de la PÁGINA (admin-context.ts y
// guard.ts ya tienen prueba propia de sus piezas). El layout ya gatea con
// requireSuperadmin(); las DOS server actions (elegirFlota, quitarSeleccion)
// lo RE-CHEQUEAN (comentario propio: "una action es un endpoint POST, no
// hereda la puerta de la página"). Lo real que se vigila: un tenant no
// verificado NUNCA se firma en la cookie (fallar cerrado), y el destino de
// salida siempre pasa por destinoSeguro (protección de open-redirect).
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({
  requireSuperadmin: vi.fn(),
  leerSeleccionFlota: vi.fn(),
  guardarSeleccionFlota: vi.fn(),
  limpiarSeleccionFlota: vi.fn(),
  anotarSeleccionEnBitacora: vi.fn(),
  supabaseFrom: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: (ruta: string) => { throw new Error(`REDIRECT:${ruta}`); } }));
vi.mock('@/lib/auth/guard', () => ({ requireSuperadmin: dobles.requireSuperadmin }));
vi.mock('@/lib/auth/tenant-demo', () => ({ tenantDemo: () => 'demo-tenant-id' }));
vi.mock('@/lib/auth/admin-context', async (importar) => ({
  ...(await importar<typeof import('@/lib/auth/admin-context')>()),
  leerSeleccionFlota: dobles.leerSeleccionFlota,
  guardarSeleccionFlota: dobles.guardarSeleccionFlota,
  limpiarSeleccionFlota: dobles.limpiarSeleccionFlota,
  anotarSeleccionEnBitacora: dobles.anotarSeleccionEnBitacora,
}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: dobles.supabaseFrom }) }));
vi.mock('./contenido', () => ({ ElegirFlotaContenido: (props: unknown) => props }));

import PaginaElegirFlota from './page';

type Accion0 = () => Promise<void>;
type Accion1 = (fd: FormData) => Promise<void>;
type Props = { accionElegir: Accion1; accionQuitar: Accion0; flotas: Array<{ id: string; nombre: string }>; errorLista: boolean };
const fd = (campos: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(campos)) f.set(k, v); return f; };
const SP = Promise.resolve({});

function cadenaTenant(filas: Array<{ id: string; nombre?: string }>, error: unknown = null) {
  return { select: () => ({ order: () => ({ data: filas, error }), eq: () => ({ maybeSingle: async () => ({ data: filas[0] ?? null, error }) }) }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  dobles.requireSuperadmin.mockResolvedValue({ userId: 'u-1', rol: 'superadmin', nombre: 'Javier', avatarUrl: null });
  dobles.leerSeleccionFlota.mockResolvedValue(null);
  dobles.supabaseFrom.mockReturnValue(cadenaTenant([{ id: 't-1', nombre: 'Flota Uno' }]));
});

it('un no-superadmin es redirigido al renderizar', async () => {
  dobles.requireSuperadmin.mockImplementationOnce(() => { throw new Error('REDIRECT:/dashboard'); });
  await expect(PaginaElegirFlota({ searchParams: SP })).rejects.toThrow('REDIRECT:/dashboard');
});

it('la flota demo se excluye de la lista elegible (tiene su propio botón aparte)', async () => {
  dobles.supabaseFrom.mockReturnValue(cadenaTenant([{ id: 'demo-tenant-id', nombre: 'Demo' }, { id: 't-1', nombre: 'Flota Uno' }]));
  const pagina = await PaginaElegirFlota({ searchParams: SP }) as unknown as { props: Props };
  expect(pagina.props.flotas).toEqual([{ id: 't-1', nombre: 'Flota Uno' }]);
});

it('un error de lectura de flotas se DICE (errorLista), nunca se ve como "no hay flotas"', async () => {
  dobles.supabaseFrom.mockReturnValue(cadenaTenant([], { message: 'caída' }));
  const pagina = await PaginaElegirFlota({ searchParams: SP }) as unknown as { props: Props };
  expect(pagina.props.errorLista).toBe(true);
  expect(pagina.props.flotas).toEqual([]);
});

it('elegir una flota real: se verifica en la base ANTES de firmar la cookie, y ancla el bitácora con el actor real', async () => {
  dobles.guardarSeleccionFlota.mockResolvedValue(true);
  dobles.anotarSeleccionEnBitacora.mockResolvedValue(undefined);
  const pagina = await PaginaElegirFlota({ searchParams: SP }) as unknown as { props: Props };
  await expect(pagina.props.accionElegir(fd({ flota: 't-1', next: '/admin/flotas' })))
    .rejects.toThrow(/^REDIRECT:\/admin\/flotas\?tenant=t-1$/);
  expect(dobles.guardarSeleccionFlota).toHaveBeenCalledWith('t-1');
  expect(dobles.anotarSeleccionEnBitacora).toHaveBeenCalledWith('u-1', 't-1', false);
});

it('un id de flota que NO resuelve en la base nunca se firma — fallar cerrado', async () => {
  dobles.supabaseFrom.mockReturnValueOnce(cadenaTenant([{ id: 't-1' }])).mockReturnValueOnce(cadenaTenant([]));
  const pagina = await PaginaElegirFlota({ searchParams: SP }) as unknown as { props: Props };
  await expect(pagina.props.accionElegir(fd({ flota: 'id-inventado', next: '/admin/flotas' })))
    .rejects.toThrow(/^REDIRECT:\/admin\/elegir-flota\?next=.*&error=flota$/);
  expect(dobles.guardarSeleccionFlota).not.toHaveBeenCalled();
});

it('la opción "demo" no se verifica contra la base — usa tenantDemo() directo', async () => {
  dobles.guardarSeleccionFlota.mockResolvedValue(true);
  const pagina = await PaginaElegirFlota({ searchParams: SP }) as unknown as { props: Props };
  await expect(pagina.props.accionElegir(fd({ flota: 'demo', next: '/admin' })))
    .rejects.toThrow(/^REDIRECT:\/admin\?vista=demo$/);
  expect(dobles.guardarSeleccionFlota).toHaveBeenCalledWith('demo-tenant-id');
  expect(dobles.anotarSeleccionEnBitacora).toHaveBeenCalledWith('u-1', 'demo-tenant-id', true);
});

it('si la cookie no se puede firmar, se dice con ?error=firma — no se avanza como si hubiera quedado', async () => {
  dobles.guardarSeleccionFlota.mockResolvedValue(false);
  const pagina = await PaginaElegirFlota({ searchParams: SP }) as unknown as { props: Props };
  await expect(pagina.props.accionElegir(fd({ flota: 't-1', next: '/admin' })))
    .rejects.toThrow(/error=firma/);
  expect(dobles.anotarSeleccionEnBitacora).not.toHaveBeenCalled();
});

it('un `next` fuera del panel (open-redirect) se sustituye por /dashboard vía destinoSeguro', async () => {
  dobles.guardarSeleccionFlota.mockResolvedValue(true);
  const pagina = await PaginaElegirFlota({ searchParams: SP }) as unknown as { props: Props };
  await expect(pagina.props.accionElegir(fd({ flota: 't-1', next: 'https://evil.com' })))
    .rejects.toThrow(/^REDIRECT:\/dashboard\?tenant=t-1$/);
});

it('elegir: re-chequea superadmin de forma independiente al render', async () => {
  const pagina = await PaginaElegirFlota({ searchParams: SP }) as unknown as { props: Props };
  dobles.requireSuperadmin.mockImplementationOnce(() => { throw new Error('REDIRECT:/dashboard'); });
  await expect(pagina.props.accionElegir(fd({ flota: 't-1' }))).rejects.toThrow('REDIRECT:/dashboard');
  expect(dobles.guardarSeleccionFlota).not.toHaveBeenCalled();
});

it('quitar selección: limpia la cookie y manda siempre a /admin', async () => {
  dobles.limpiarSeleccionFlota.mockResolvedValue(undefined);
  const pagina = await PaginaElegirFlota({ searchParams: SP }) as unknown as { props: Props };
  await expect(pagina.props.accionQuitar()).rejects.toThrow('REDIRECT:/admin');
  expect(dobles.limpiarSeleccionFlota).toHaveBeenCalled();
});

it('quitar: re-chequea superadmin de forma independiente al render', async () => {
  const pagina = await PaginaElegirFlota({ searchParams: SP }) as unknown as { props: Props };
  dobles.requireSuperadmin.mockImplementationOnce(() => { throw new Error('REDIRECT:/dashboard'); });
  await expect(pagina.props.accionQuitar()).rejects.toThrow('REDIRECT:/dashboard');
  expect(dobles.limpiarSeleccionFlota).not.toHaveBeenCalled();
});
