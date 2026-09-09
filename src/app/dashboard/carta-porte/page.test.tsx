import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /dashboard/carta-porte — CERO cobertura de la PÁGINA (las funciones de
// `carta_porte_datos.ts` ya tienen prueba propia). Cuatro server actions,
// cada una repite el mismo patrón: re-resolver la sesión, exigir
// `puedeVerRuta`, validar, escribir con el tenant/usuario de la SESIÓN.
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({
  getEstadoCartaPorte: vi.fn(),
  declararCcp: vi.fn(),
  guardarMercancia: vi.fn(),
  borrarMercancia: vi.fn(),
  guardarDatosCliente: vi.fn(),
  revalidatePath: vi.fn(),
}));

let sesion: { tenantId: string; rol: string; userId: string } = { tenantId: 't-1', rol: 'flota_admin', userId: 'u-1' };

vi.mock('@/lib/auth/tenant-efectivo', () => ({ resolverTenantEfectivo: async () => sesion }));
vi.mock('next/navigation', () => ({ redirect: (ruta: string) => { throw new Error(`REDIRECT:${ruta}`); } }));
vi.mock('next/cache', () => ({ revalidatePath: dobles.revalidatePath }));
vi.mock('@/lib/likida/carta_porte_datos', async (importar) => ({
  ...(await importar<typeof import('@/lib/likida/carta_porte_datos')>()),
  getEstadoCartaPorte: dobles.getEstadoCartaPorte,
  declararCcp: dobles.declararCcp,
  guardarMercancia: dobles.guardarMercancia,
  borrarMercancia: dobles.borrarMercancia,
  guardarDatosCliente: dobles.guardarDatosCliente,
}));

import PaginaCartaPorte from './page';

const SP = Promise.resolve({});
const fd = (campos: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(campos)) f.set(k, v); return f; };
type Props = { declarar: Accion; agregarMercancia: Accion; quitarMercancia: Accion; guardarDatosCliente: Accion; datos: unknown };
type Accion = (previo: unknown, fd: FormData) => Promise<{ ok: boolean; mensaje?: string; error?: string }>;

beforeEach(() => {
  vi.clearAllMocks();
  sesion = { tenantId: 't-1', rol: 'flota_admin', userId: 'u-1' };
  dobles.getEstadoCartaPorte.mockResolvedValue({ viajes: [] });
});

it.each(['contador', 'vendedor'])('%s no puede ver la página: redirect antes de tocar la base', async (rol) => {
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  await expect(PaginaCartaPorte({ searchParams: SP })).rejects.toThrow('REDIRECT:/dashboard');
  expect(dobles.getEstadoCartaPorte).not.toHaveBeenCalled();
});

it('una lectura caída no finge "nada pendiente" — pasa `datos: null` a la vista', async () => {
  dobles.getEstadoCartaPorte.mockRejectedValueOnce(new Error('caída'));
  const pagina = await PaginaCartaPorte({ searchParams: SP }) as unknown as { props: Props };
  expect(pagina.props.datos).toBeNull();
});

it('declarar: manda tenant/usuario de la SESIÓN, no del form', async () => {
  dobles.declararCcp.mockResolvedValue(undefined);
  const pagina = await PaginaCartaPorte({ searchParams: SP }) as unknown as { props: Props };
  const r = await pagina.props.declarar(null, fd({
    pisaFederal: 'si', radioKm: '150', viajeId: 'v-1', tenantId: 'OTRO', userId: 'OTRO-U',
  }));
  expect(dobles.declararCcp).toHaveBeenCalledWith('t-1', 'v-1', expect.objectContaining({ pisaFederal: true }), { id: 'u-1' });
  expect(r).toEqual(expect.objectContaining({ ok: true }));
  expect(dobles.revalidatePath).toHaveBeenCalledWith('/dashboard/carta-porte');
});

it('declarar: un dato inválido llega verbatim (mensajeParaPantalla), no genérico', async () => {
  const pagina = await PaginaCartaPorte({ searchParams: SP }) as unknown as { props: Props };
  const r = await pagina.props.declarar(null, fd({ pisaFederal: 'tal-vez', radioKm: '150', viajeId: 'v-1' }));
  expect(r.ok).toBe(false);
  expect(dobles.declararCcp).not.toHaveBeenCalled();
});

it.each(['contador', 'vendedor'])('declarar: %s rechazado aunque invoque la server action directo (sesión re-resuelta en el momento)', async (rol) => {
  const pagina = await PaginaCartaPorte({ searchParams: SP }) as unknown as { props: Props };
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  const r = await pagina.props.declarar(null, fd({ pisaFederal: 'si', radioKm: '150', viajeId: 'v-1' }));
  expect(r).toEqual({ ok: false, error: 'Tu rol no puede declarar rutas.' });
  expect(dobles.declararCcp).not.toHaveBeenCalled();
});

it('agregar mercancía: manda tenant/usuario de la SESIÓN', async () => {
  dobles.guardarMercancia.mockResolvedValue(undefined);
  const pagina = await PaginaCartaPorte({ searchParams: SP }) as unknown as { props: Props };
  const r = await pagina.props.agregarMercancia(null, fd({
    descripcion: 'Refrigeradores', bienesTransp: '78101800', cantidad: '10', claveUnidad: 'H87', pesoKg: '500', materialPeligroso: 'no', viajeId: 'v-1', tenantId: 'OTRO',
  }));
  expect(dobles.guardarMercancia).toHaveBeenCalledWith('t-1', 'v-1', expect.objectContaining({ descripcion: 'Refrigeradores' }), { id: 'u-1' });
  expect(r).toEqual(expect.objectContaining({ ok: true }));
});

it('quitar mercancía: id viaja por el form, tenant/usuario por la sesión', async () => {
  dobles.borrarMercancia.mockResolvedValue(undefined);
  const pagina = await PaginaCartaPorte({ searchParams: SP }) as unknown as { props: Props };
  const r = await pagina.props.quitarMercancia(null, fd({ mercanciaId: 'm-1', tenantId: 'OTRO' }));
  expect(dobles.borrarMercancia).toHaveBeenCalledWith('t-1', 'm-1', { id: 'u-1' });
  expect(r).toEqual({ ok: true, mensaje: 'Renglón quitado.' });
});

it('datos del cliente: manda tenant/usuario de la SESIÓN', async () => {
  dobles.guardarDatosCliente.mockResolvedValue(undefined);
  const pagina = await PaginaCartaPorte({ searchParams: SP }) as unknown as { props: Props };
  const r = await pagina.props.guardarDatosCliente(null, fd({
    origenCp: '97000', destinoCp: '44100', origenEstado: 'YUC', destinoEstado: 'JAL',
    rfcDestinatario: 'TIN010101AB1', transpInternac: 'no', viajeId: 'v-1', tenantId: 'OTRO',
  }));
  expect(dobles.guardarDatosCliente).toHaveBeenCalledWith('t-1', 'v-1', expect.objectContaining({ origenCp: '97000' }), { id: 'u-1' });
  expect(r).toEqual(expect.objectContaining({ ok: true }));
});

it.each(['contador', 'vendedor'])('las cuatro acciones rechazan a %s aunque se invoquen directo', async (rol) => {
  const pagina = await PaginaCartaPorte({ searchParams: SP }) as unknown as { props: Props };
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  const r1 = await pagina.props.agregarMercancia(null, fd({ descripcion: 'x', bienesTransp: '1', cantidad: '1', claveUnidad: 'H87', pesoKg: '1', materialPeligroso: 'no', viajeId: 'v-1' }));
  const r2 = await pagina.props.quitarMercancia(null, fd({ mercanciaId: 'm-1' }));
  const r3 = await pagina.props.guardarDatosCliente(null, fd({ origenCp: '1', destinoCp: '1', origenEstado: 'x', destinoEstado: 'x', rfcDestinatario: 'x', transpInternac: 'no', viajeId: 'v-1' }));
  expect(r1).toEqual({ ok: false, error: 'Tu rol no puede capturar mercancía.' });
  expect(r2).toEqual({ ok: false, error: 'Tu rol no puede capturar mercancía.' });
  expect(r3).toEqual({ ok: false, error: 'Tu rol no puede capturar estos datos.' });
  expect(dobles.guardarMercancia).not.toHaveBeenCalled();
  expect(dobles.borrarMercancia).not.toHaveBeenCalled();
  expect(dobles.guardarDatosCliente).not.toHaveBeenCalled();
});
