import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentProps, ReactElement } from 'react';
import { utils, write } from 'xlsx';
import type { VistaViajes } from './vista';
import { ImportarViajes } from './importar';
import { interpretarFilasViajes } from '@/lib/likida/importar_viajes';

const m = vi.hoisted(() => ({
  rol: 'encargado', tenant: 't1', importar: vi.fn(async (..._args: unknown[]) => ({
    creados: 1, saltados: [], descartadas: [], operadoresSinAmarrar: [], sinOperador: [], operadorOcupado: [],
    unidadesSinAmarrar: [], sinUnidad: [], clientesSinAmarrar: [], sinCliente: [],
  })),
}));
vi.mock('next/navigation', () => ({ redirect: () => { throw new Error('REDIRECT'); }, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/auth/tenant-efectivo', () => ({ resolverTenantEfectivo: async () => ({ tenantId: 't1', rol: m.rol }) }));
vi.mock('@/lib/auth/guard', () => ({ requireSessionTenant: async () => ({ tenantId: m.tenant, rol: m.rol, userId: 'u1' }) }));
vi.mock('@/lib/likida/analytics', () => ({ getLiquidacionesDeViajes: async () => [] }));
vi.mock('@/lib/likida/viajes_registro', () => ({ getViajesRegistro: async () => ({ filas: [], hayMas: false, siguiente: null }), getConteosViajes: async () => null, TOPE_PAGINA: 25 }));
vi.mock('@/lib/likida/importar_viajes', async original => ({
  ...(await original<typeof import('@/lib/likida/importar_viajes')>()),
  importarViajes: (...args: unknown[]) => m.importar(...args),
}));
const { default: PaginaViajes } = await import('./page');
const props = async () => (await PaginaViajes({ searchParams: Promise.resolve({}) }) as ReactElement<ComponentProps<typeof VistaViajes>>).props;
const archivo = (matriz: unknown[][], excel = false) => {
  const fd = new FormData();
  if (excel) {
    const wb = utils.book_new(); utils.book_append_sheet(wb, utils.aoa_to_sheet(matriz));
    fd.set('archivo', new File([write(wb, { type: 'array', bookType: 'xlsx' })], 'viajes.xlsx'));
  } else fd.set('archivo', new File(['\uFEFF' + matriz.map(f => f.join(',')).join('\n')], 'viajes.csv'));
  return fd;
};
const OPERATIVA = [['folio', 'operador', 'unidad', 'km'], ['IMP-1', 'Operador', '', '400']];
beforeEach(() => { m.rol = 'encargado'; m.tenant = 't1'; vi.clearAllMocks(); });
describe('importación: el rol vivo autoriza también las columnas del archivo', () => {
  it.each(['anticipo', 'anticipo mxn', 'monto anticipo', 'cliente', 'nombre cliente', 'razón social', 'ingreso', 'flete', 'ingreso flete', 'precio flete', 'monto flete'])('encargado rechaza alias %s antes de importar', async columna => {
    const p = await props();
    const r = await p.importar(null, archivo([['folio', 'operador', columna], ['IMP-1', 'Operador', '900']]));
    expect(r).toMatchObject({ error: expect.stringMatching(/rol/i) }); expect(m.importar).not.toHaveBeenCalled();
  });
  it('Excel con columnas financieras vacías/duplicadas se rechaza entero', async () => {
    const p = await props(); const r = await p.importar(null, archivo([['folio', 'operador', 'anticipo', 'anticipo'], ['IMP-1', 'Operador', '', 900]], true));
    expect(r).toHaveProperty('error'); expect(m.importar).not.toHaveBeenCalled();
  });
  it('encargado conserva importación operacional sin datos financieros', async () => {
    const p = await props(); await expect(p.importar(null, archivo(OPERATIVA))).resolves.toHaveProperty('resumen.creados', 1);
    expect(m.importar).toHaveBeenCalledWith('t1', [expect.objectContaining({ folio: 'IMP-1', kmRecorridos: 400, anticipo: null, ingresoFlete: null, clienteNombre: null })]);
  });
  it('dueño conserva importación financiera', async () => {
    m.rol = 'flota_admin'; const p = await props();
    await expect(p.importar(null, archivo([['folio', 'operador', 'anticipo', 'ingreso'], ['IMP-1', 'Operador', 900, 2000]]))).resolves.toHaveProperty('resumen.creados', 1);
    expect(m.importar).toHaveBeenCalledWith('t1', [expect.objectContaining({ anticipo: 900, ingresoFlete: 2000 })]);
  });
  it('revocación después de render impide importar dinero', async () => {
    m.rol = 'flota_admin'; const p = await props(); m.rol = 'encargado';
    await expect(p.importar(null, archivo([['folio', 'anticipo'], ['IMP-1', 900]]))).resolves.toHaveProperty('error');
    expect(m.importar).not.toHaveBeenCalled();
  });
  it('el permiso financiero no reemplaza el tenant de la sesión', async () => {
    m.rol = 'flota_admin'; const p = await props(); m.tenant = 'ajeno';
    await expect(p.importar(null, archivo(OPERATIVA))).resolves.toHaveProperty('error'); expect(m.importar).not.toHaveBeenCalled();
  });
  it('el parser sin opciones conserva su contrato para llamadores existentes', () => {
    expect(interpretarFilasViajes([['folio', 'anticipo'], ['IMP-1', 900]]).viajes[0].anticipo).toBe(900);
  });
  it('la ayuda del encargado sólo ofrece columnas operativas', () => {
    const html = renderToStaticMarkup(<ImportarViajes importar={async () => null} verDinero={false} />);
    expect(html).toContain('operador'); expect(html).toContain('km');
    expect(html).not.toMatch(/anticipo|ingreso|cliente/);
  });
});
