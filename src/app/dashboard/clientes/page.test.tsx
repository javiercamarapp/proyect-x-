import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /dashboard/clientes — CERO cobertura de la PÁGINA (clientes.ts ya tiene
// tres archivos de prueba). Dos puertas DISTINTAS a propósito: VER es área
// "dinero" (contador incluido), ESCRIBIR es `puedeAdministrar` (contador NO
// puede fijar precios, sólo leerlos). Las dos se repiten dentro de cada
// action, sin ayudante compartido — el propio comentario del archivo explica
// por qué (evitar publicar un endpoint POST de más).
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({
  getPanelClientes: vi.fn(),
  validarCliente: vi.fn(),
  validarTarifa: vi.fn(),
  crearCliente: vi.fn(),
  editarCliente: vi.fn(),
  crearTarifa: vi.fn(),
  editarTarifa: vi.fn(),
  buscarCatalogo: vi.fn(),
  contarCatalogo: vi.fn(),
  revalidatePath: vi.fn(),
}));

let sesion: { tenantId: string; rol: string; userId: string } = { tenantId: 't-1', rol: 'flota_admin', userId: 'u-1' };

vi.mock('@/lib/auth/tenant-efectivo', () => ({ resolverTenantEfectivo: async () => sesion }));
vi.mock('next/navigation', () => ({ redirect: (ruta: string) => { throw new Error(`REDIRECT:${ruta}`); } }));
vi.mock('next/cache', () => ({ revalidatePath: dobles.revalidatePath }));
vi.mock('@/lib/likida/clientes', async (importar) => ({
  ...(await importar<typeof import('@/lib/likida/clientes')>()),
  getPanelClientes: dobles.getPanelClientes,
  validarCliente: dobles.validarCliente,
  validarTarifa: dobles.validarTarifa,
  crearCliente: dobles.crearCliente,
  editarCliente: dobles.editarCliente,
  crearTarifa: dobles.crearTarifa,
  editarTarifa: dobles.editarTarifa,
}));
vi.mock('@/lib/likida/repo', async (importar) => ({
  ...(await importar<typeof import('@/lib/likida/repo')>()),
  buscarCatalogo: dobles.buscarCatalogo,
  contarCatalogo: dobles.contarCatalogo,
}));

import PaginaClientes from './page';

type PropsClientes = {
  panel: unknown; puedeEditar: boolean; totalClientes: number | null;
  buscarCliente: (tipo: string, q: string) => Promise<unknown>;
  guardarCliente: (previo: unknown, fd: FormData) => Promise<{ ok: boolean; mensaje?: string; error?: string }>;
  guardarTarifa: (previo: unknown, fd: FormData) => Promise<{ ok: boolean; mensaje?: string; error?: string }>;
};
const SP = Promise.resolve({});
const fd = (campos: Record<string, string | boolean>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(campos)) if (typeof v === 'boolean') { if (v) f.set(k, 'on'); } else f.set(k, v);
  return f;
};
const CLIENTE_VALIDADO = { nombre: 'ACME SA', rfc: 'ACM010101AB1', contacto: 'Juan', correo: 'juan@acme.com', telefono: '9991234567', diasCredito: 30, activo: true };
const TARIFA_VALIDADA = { clienteId: 'c-1', origen: 'Mérida', destino: 'CDMX', modo: 'plana', precio: 15000, moneda: 'MXN', vigenteDesde: '2026-01-01', vigenteHasta: null, activa: true };

beforeEach(() => {
  vi.clearAllMocks();
  sesion = { tenantId: 't-1', rol: 'flota_admin', userId: 'u-1' };
  dobles.getPanelClientes.mockResolvedValue({ clientes: [], tarifas: [] });
  dobles.contarCatalogo.mockResolvedValue(0);
  dobles.validarCliente.mockReturnValue(CLIENTE_VALIDADO);
  dobles.validarTarifa.mockReturnValue(TARIFA_VALIDADA);
});

it.each(['encargado', 'vendedor'])('%s no puede ver la página (VER es área dinero): redirect', async (rol) => {
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  await expect(PaginaClientes({ searchParams: SP })).rejects.toThrow('REDIRECT:/dashboard');
  expect(dobles.getPanelClientes).not.toHaveBeenCalled();
});

it.each(['flota_admin', 'superadmin', 'contador'])('%s sí puede VER (área dinero), pero puedeEditar sólo para admin/superadmin', async (rol) => {
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  const pagina = await PaginaClientes({ searchParams: SP }) as unknown as { props: PropsClientes };
  expect(pagina.props.puedeEditar).toBe(rol !== 'contador');
});

it('dar de alta un cliente: manda tenant/usuario de la SESIÓN, no del form', async () => {
  dobles.crearCliente.mockResolvedValue(undefined);
  const pagina = await PaginaClientes({ searchParams: SP }) as unknown as { props: PropsClientes };
  const r = await pagina.props.guardarCliente(null, fd({
    nombre: 'ACME SA', rfc: 'ACM010101AB1', contacto: 'Juan', correo: 'juan@acme.com',
    telefono: '9991234567', diasCredito: '30', activo: true, tenantId: 'OTRO',
  }));
  expect(dobles.crearCliente).toHaveBeenCalledWith('t-1', CLIENTE_VALIDADO, { id: 'u-1' });
  expect(dobles.editarCliente).not.toHaveBeenCalled();
  expect(r).toEqual(expect.objectContaining({ ok: true }));
  expect(dobles.revalidatePath).toHaveBeenCalledWith('/dashboard/clientes');
});

it('editar un cliente existente: con `id` en el form, edita en vez de crear', async () => {
  dobles.editarCliente.mockResolvedValue(undefined);
  const pagina = await PaginaClientes({ searchParams: SP }) as unknown as { props: PropsClientes };
  const r = await pagina.props.guardarCliente(null, fd({
    id: 'c-9', nombre: 'ACME SA', rfc: 'ACM010101AB1', contacto: 'Juan', correo: 'juan@acme.com', telefono: '9991234567', diasCredito: '30', activo: true,
  }));
  expect(dobles.editarCliente).toHaveBeenCalledWith('t-1', 'c-9', CLIENTE_VALIDADO, { id: 'u-1' });
  expect(dobles.crearCliente).not.toHaveBeenCalled();
  expect(r).toEqual(expect.objectContaining({ ok: true, mensaje: '"ACME SA" quedó actualizado.' }));
});

it('un dato inválido (DatoInvalido) llega verbatim, no genérico', async () => {
  const { DatoInvalido } = await import('@/lib/likida/errores');
  dobles.validarCliente.mockImplementation(() => { throw new DatoInvalido('El RFC no tiene un dígito verificador válido.'); });
  const pagina = await PaginaClientes({ searchParams: SP }) as unknown as { props: PropsClientes };
  const r = await pagina.props.guardarCliente(null, fd({ nombre: 'x', rfc: 'malo', contacto: '', correo: '', telefono: '', diasCredito: '0' }));
  expect(r).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining('dígito verificador') }));
  expect(dobles.crearCliente).not.toHaveBeenCalled();
});

it.each(['contador'])('guardar cliente: %s (VE dinero pero no administra) queda rechazado', async (rol) => {
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  const pagina = await PaginaClientes({ searchParams: Promise.resolve({}) }) as unknown as { props: PropsClientes };
  const r = await pagina.props.guardarCliente(null, fd({ nombre: 'x' }));
  expect(r).toEqual({ ok: false, error: 'Solo el dueño de la flota da de alta clientes y fija tarifas.' });
  expect(dobles.crearCliente).not.toHaveBeenCalled();
});

it('dar de alta una tarifa: manda tenant/usuario de la SESIÓN', async () => {
  dobles.crearTarifa.mockResolvedValue(undefined);
  const pagina = await PaginaClientes({ searchParams: SP }) as unknown as { props: PropsClientes };
  const r = await pagina.props.guardarTarifa(null, fd({
    clienteId: 'c-1', origen: 'Mérida', destino: 'CDMX', modo: 'plana', precio: '15000',
    moneda: 'MXN', vigenteDesde: '2026-01-01', vigenteHasta: '', activa: true, tenantId: 'OTRO',
  }));
  expect(dobles.crearTarifa).toHaveBeenCalledWith('t-1', TARIFA_VALIDADA, { id: 'u-1' });
  expect(r).toEqual(expect.objectContaining({ ok: true }));
});

it.each(['contador'])('guardar tarifa: %s queda rechazado (fijar precios es del dueño, no de quien factura)', async (rol) => {
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  const pagina = await PaginaClientes({ searchParams: Promise.resolve({}) }) as unknown as { props: PropsClientes };
  const r = await pagina.props.guardarTarifa(null, fd({ clienteId: 'c-1' }));
  expect(r).toEqual({ ok: false, error: 'Solo el dueño de la flota da de alta clientes y fija tarifas.' });
  expect(dobles.crearTarifa).not.toHaveBeenCalled();
});

it('buscar cliente (para el selector de tarifas): tenant de la SESIÓN; un tipo desconocido no se acepta', async () => {
  dobles.buscarCatalogo.mockResolvedValue([{ id: 'c-1', etiqueta: 'ACME' }]);
  const pagina = await PaginaClientes({ searchParams: SP }) as unknown as { props: PropsClientes };
  const r = await pagina.props.buscarCliente('cliente', 'ACM');
  expect(dobles.buscarCatalogo).toHaveBeenCalledWith('t-1', 'cliente', 'ACM');
  expect(r).toEqual([{ id: 'c-1', etiqueta: 'ACME' }]);
  await expect(pagina.props.buscarCliente('operador' as never, 'x')).rejects.toThrow('Catálogo desconocido.');
});

it.each(['encargado', 'vendedor'])('buscar cliente: %s rechazado aunque invoque directo (sesión re-resuelta en el momento)', async (rol) => {
  const pagina = await PaginaClientes({ searchParams: SP }) as unknown as { props: PropsClientes };
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  await expect(pagina.props.buscarCliente('cliente', 'x')).rejects.toThrow('Tu rol no puede ver la cartera de clientes.');
  expect(dobles.buscarCatalogo).not.toHaveBeenCalled();
});

it('una lectura del panel caída no finge "sin clientes" — pasa `panel: null` a la vista', async () => {
  dobles.getPanelClientes.mockRejectedValueOnce(new Error('caída'));
  const pagina = await PaginaClientes({ searchParams: SP }) as unknown as { props: PropsClientes };
  expect(pagina.props.panel).toBeNull();
});
