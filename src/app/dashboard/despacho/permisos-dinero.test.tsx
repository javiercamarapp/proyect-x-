import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentProps, ReactElement } from 'react';
import type { VistaDespacho } from './vista';
import { FormaViaje } from '../forma-viaje';

const m = vi.hoisted(() => ({
  rol: 'encargado', tenant: 't1',
  crear: vi.fn(async (..._args: unknown[]) => undefined), contar: vi.fn(async (..._args: unknown[]) => 4), buscar: vi.fn(async (..._args: unknown[]) => []),
}));
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));
vi.mock('@/lib/auth/tenant-efectivo', () => ({ resolverTenantEfectivo: async () => ({ tenantId: 't1', rol: m.rol }) }));
vi.mock('@/lib/auth/guard', () => ({ requireSessionTenant: async () => ({ tenantId: m.tenant, rol: m.rol, userId: 'u1' }) }));
vi.mock('@/lib/likida/operacion', () => ({
  getTableroOperacion: async () => null, getViajesSinAsignar: async () => [], getCargaOperadores: async () => [],
  crearViaje: (...args: unknown[]) => m.crear(...args), avisarAlChofer: vi.fn(), asignarUnidad: vi.fn(),
}));
vi.mock('@/lib/likida/repo', () => ({
  reasignarOperador: vi.fn(), buscarCatalogo: (...args: unknown[]) => m.buscar(...args), contarCatalogo: (...args: unknown[]) => m.contar(...args),
}));
vi.mock('@/lib/likida/administracion', () => ({ crearOperador: vi.fn() }));
vi.mock('@/lib/likida/repo_paginado', () => ({ viajesEnCursoPaginados: async () => ({ filas: [], total: 0, error: null }) }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => { throw new Error('DB inesperada'); } }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
const { default: PaginaDespacho } = await import('./page');
const props = async () => (await PaginaDespacho({ searchParams: Promise.resolve({}) }) as ReactElement<ComponentProps<typeof VistaDespacho>>).props;
const datos = () => { const fd = new FormData(); fd.set('operadorId', 'op1'); fd.set('folio', 'V-1'); return fd; };

beforeEach(() => { vi.clearAllMocks(); m.rol = 'encargado'; m.tenant = 't1'; });
describe('despacho: dinero autorizado por rol vivo', () => {
  it('encargado no recibe ni consulta conteo comercial y formulario sólo ofrece operación', async () => {
    const p = await props();
    expect(m.contar).not.toHaveBeenCalledWith('t1', 'cliente');
    const html = renderToStaticMarkup(<FormaViaje action={p.crear} buscarCatalogo={p.buscarCatalogo} totalOperadores={4} totalClientes={p.totalClientes} totalUnidades={4} puedeCapturarDinero={p.puedeCapturarDinero} />);
    for (const campo of ['anticipo', 'ingresoFlete', 'clienteId']) expect(html).not.toContain(`name="${campo}"`);
    expect(html).toContain('name="operadorId"');
  });
  it.each(['anticipo', 'ingresoFlete', 'clienteId'])('POST manual de encargado con %s se rechaza antes de mutar', async campo => {
    const p = await props(); const fd = datos(); fd.set(campo, campo === 'clienteId' ? 'c1' : '8000');
    await expect(p.crear(null, fd)).resolves.toMatchObject({ error: expect.stringMatching(/rol/i) });
    expect(m.crear).not.toHaveBeenCalled();
  });
  it('campos prohibidos vacíos/duplicados tampoco pasan como operación', async () => {
    const p = await props(); const fd = datos(); fd.append('anticipo', ''); fd.append('anticipo', '900');
    await expect(p.crear(null, fd)).resolves.toHaveProperty('error'); expect(m.crear).not.toHaveBeenCalled();
  });
  it('encargado sigue creando operación con anticipo por defecto y sin datos comerciales', async () => {
    const p = await props(); await expect(p.crear(null, datos())).rejects.toThrow('REDIRECT:');
    expect(m.crear).toHaveBeenCalledWith('t1', expect.objectContaining({ operadorId: 'op1', anticipo: 0, clienteId: null, ingresoFlete: null }));
  });
  it('búsqueda manual del catálogo cliente se rechaza y operador sigue funcionando', async () => {
    const p = await props(); await expect(p.buscarCatalogo('cliente', 'x')).rejects.toThrow(/rol/i);
    expect(m.buscar).not.toHaveBeenCalled(); await p.buscarCatalogo('operador', 'x');
    expect(m.buscar).toHaveBeenCalledWith('t1', 'operador', 'x');
  });
  it('revocación de dueño a encargado entre render y POST aplica el permiso actual', async () => {
    m.rol = 'flota_admin'; const p = await props(); m.rol = 'encargado';
    const fd = datos(); fd.set('anticipo', '900'); await expect(p.crear(null, fd)).resolves.toHaveProperty('error');
    expect(m.crear).not.toHaveBeenCalled();
  });
  it('dueño conserva captura financiera y catálogo de clientes', async () => {
    m.rol = 'flota_admin'; const p = await props();
    const fd = datos(); fd.set('anticipo', '900'); fd.set('ingresoFlete', '2000');
    await expect(p.crear(null, fd)).rejects.toThrow('REDIRECT:');
    expect(m.crear).toHaveBeenCalledWith('t1', expect.objectContaining({ anticipo: 900, ingresoFlete: 2000 }));
    await p.buscarCatalogo('cliente', 'x'); expect(m.buscar).toHaveBeenCalledWith('t1', 'cliente', 'x');
  });
});
