import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

type Elemento = ReactElement<Record<string, unknown>>;

// ═══════════════════════════════════════════════════════════════════════════
// /dashboard/emergencias — CERO cobertura hasta esta prueba (ni componente ni
// navegador), pese a ser el directorio de vida-o-muerte que el escalamiento
// consulta (grúa, póliza de siniestros, contacto de un familiar). Las
// funciones de escritura ya están probadas (emergencias.test.ts); lo que
// falta es la PUERTA compartida `gate()` — las seis server actions deben
// rechazar un POST directo de un rol sin permiso, y ninguna debe ofrecer sus
// formularios cuando la lectura falló (capturar a ciegas invita a duplicar).
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({
  crearProveedorEmergencia: vi.fn(),
  borrarProveedorEmergencia: vi.fn(),
  marcarProveedorVerificado: vi.fn(),
  guardarPoliza: vi.fn(),
  crearContactoEmergencia: vi.fn(),
  borrarContactoEmergencia: vi.fn(),
  listarProveedoresEmergencia: vi.fn(),
  polizaVigenteDe: vi.fn(),
  listarContactosEmergencia: vi.fn(),
  revalidatePath: vi.fn(),
}));

let sesion: { tenantId: string; rol: string; userId: string } = { tenantId: 't-1', rol: 'flota_admin', userId: 'u-1' };

vi.mock('@/lib/auth/tenant-efectivo', () => ({ resolverTenantEfectivo: async () => sesion }));
vi.mock('next/navigation', () => ({ redirect: (ruta: string) => { throw new Error(`REDIRECT:${ruta}`); } }));
vi.mock('next/cache', () => ({ revalidatePath: dobles.revalidatePath }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            order: () => ({
              range: async () => ({ data: [{ id: 'op-1', nombre: 'Juan' }], error: null, count: 1 }),
            }),
          }),
        }),
      }),
    }),
  }),
}));
vi.mock('@/lib/likida/emergencias', async (importar) => ({
  ...(await importar<typeof import('@/lib/likida/emergencias')>()),
  crearProveedorEmergencia: dobles.crearProveedorEmergencia,
  borrarProveedorEmergencia: dobles.borrarProveedorEmergencia,
  marcarProveedorVerificado: dobles.marcarProveedorVerificado,
  guardarPoliza: dobles.guardarPoliza,
  crearContactoEmergencia: dobles.crearContactoEmergencia,
  borrarContactoEmergencia: dobles.borrarContactoEmergencia,
  listarProveedoresEmergencia: dobles.listarProveedoresEmergencia,
  polizaVigenteDe: dobles.polizaVigenteDe,
  listarContactosEmergencia: dobles.listarContactosEmergencia,
}));

import { FormaConAviso } from '../../admin/ui/forma';
import PaginaEmergencias from './page';

/** Aplana el árbol ya renderizado a la lista, EN ORDEN, de todo elemento
 *  `<form>` nativo — cada uno lleva su `action` (la server action real,
 *  cerrada por closure) tal como React la invocaría en un submit real. */
function formularios(nodo: ReactNode, salida: Elemento[] = []): Elemento[] {
  if (Array.isArray(nodo)) { for (const hijo of nodo) formularios(hijo, salida); return salida; }
  if (!isValidElement<Record<string, unknown>>(nodo)) return salida;
  if (nodo.type === 'form') salida.push(nodo);
  formularios(nodo.props.children as ReactNode, salida);
  return salida;
}

/** Todo `<FormaConAviso>` del árbol, con su `boton` (texto estable e
 *  inequívoco: "Guardar/Reemplazar póliza", "Agregar proveedor", "Agregar
 *  contacto") y su `accion` (la server action real cerrada por closure). */
function formasConAviso(nodo: ReactNode, salida: Elemento[] = []): Elemento[] {
  if (Array.isArray(nodo)) { for (const hijo of nodo) formasConAviso(hijo, salida); return salida; }
  if (!isValidElement<Record<string, unknown>>(nodo)) return salida;
  if (nodo.type === FormaConAviso) salida.push(nodo);
  formasConAviso(nodo.props.children as ReactNode, salida);
  return salida;
}

const SP = Promise.resolve({});
const fd = (campos: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(campos)) f.set(k, v); return f; };
type Accion2 = (fd: FormData) => Promise<void>;
type Accion1 = (previo: unknown, fd: FormData) => Promise<{ ok: string } | { error: string }>;

beforeEach(() => {
  vi.clearAllMocks();
  sesion = { tenantId: 't-1', rol: 'flota_admin', userId: 'u-1' };
  dobles.listarProveedoresEmergencia.mockResolvedValue([]);
  dobles.polizaVigenteDe.mockResolvedValue(null);
  dobles.listarContactosEmergencia.mockResolvedValue([]);
});

it.each(['contador', 'vendedor'])('%s no puede ver la página: redirect antes de tocar la base', async (rol) => {
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  await expect(PaginaEmergencias({ searchParams: SP })).rejects.toThrow('REDIRECT:/dashboard');
  expect(dobles.listarProveedoresEmergencia).not.toHaveBeenCalled();
});

it.each(['flota_admin', 'superadmin', 'encargado'])('%s sí puede ver la página (área operación)', async (rol) => {
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  await expect(PaginaEmergencias({ searchParams: SP })).resolves.toBeTruthy();
});

it('una lectura caída no ofrece los formularios — capturar a ciegas invita a duplicar', async () => {
  dobles.listarProveedoresEmergencia.mockRejectedValueOnce(new Error('caída'));
  const pagina = await PaginaEmergencias({ searchParams: SP });
  expect(formularios(pagina)).toHaveLength(0);
});

/** Distingue las tres `<FormaConAviso>` por su texto de botón, que es
 *  ESTABLE e inequívoco sin importar cuántos proveedores/contactos existan. */
function accionDelBoton(pagina: ReactNode, patron: RegExp): Accion1 {
  const forma = formasConAviso(pagina).find((f) => patron.test(String(f.props.boton)));
  if (!forma) throw new Error(`No se encontró un FormaConAviso con botón que matchee ${patron}`);
  return forma.props.accion as Accion1;
}

it('alta de proveedor: manda el tenant de la SESIÓN, ignora el del form', async () => {
  dobles.crearProveedorEmergencia.mockResolvedValue(undefined);
  const pagina = await PaginaEmergencias({ searchParams: SP });
  const accion = accionDelBoton(pagina, /Agregar proveedor/);
  const r = await accion(null, fd({
    tipo: 'grua', nombre: 'Grúas García', telefono: '3312345678', tenantId: 'OTRO',
  }));
  expect(dobles.crearProveedorEmergencia).toHaveBeenCalledWith('t-1', expect.objectContaining({
    tipo: 'grua', nombre: 'Grúas García', telefono: '3312345678',
  }));
  expect(r).toEqual(expect.objectContaining({ ok: expect.stringContaining('sin confirmar') }));
  expect(dobles.revalidatePath).toHaveBeenCalledWith('/dashboard/emergencias');
});

it('guardar póliza: manda el tenant de la SESIÓN, no el del form', async () => {
  dobles.guardarPoliza.mockResolvedValue(undefined);
  const pagina = await PaginaEmergencias({ searchParams: SP });
  const accion = accionDelBoton(pagina, /póliza/i);
  const r = await accion(null, fd({
    aseguradora: 'GNP', numeroPoliza: 'P-1', telefonoSiniestros: '8009999999', tenantId: 'OTRO',
  }));
  expect(dobles.guardarPoliza).toHaveBeenCalledWith('t-1', expect.objectContaining({ aseguradora: 'GNP', numeroPoliza: 'P-1' }));
  expect(r).toEqual(expect.objectContaining({ ok: expect.stringContaining('escalamiento') }));
});

it('verificar proveedor: el botón "Verificado" invoca marcarProveedorVerificado con el userId de la SESIÓN', async () => {
  dobles.listarProveedoresEmergencia.mockResolvedValue([
    { id: 'p-1', tipo: 'grua', nombre: 'Grúas García', telefono: '1', radioKm: null, verificadoEn: null, lat: null, lng: null, notas: null },
  ]);
  dobles.marcarProveedorVerificado.mockResolvedValue(undefined);
  const pagina = await PaginaEmergencias({ searchParams: SP });
  const fs = formularios(pagina);
  // Orden conocido con 1 proveedor SIN verificar: [verificar, borrar, ...].
  const verificar = fs[0].props.action as Accion2;
  await verificar(fd({ id: 'p-1', userId: 'OTRO-USUARIO' }));
  expect(dobles.marcarProveedorVerificado).toHaveBeenCalledWith('t-1', 'p-1', 'u-1');
  expect(dobles.revalidatePath).toHaveBeenCalledWith('/dashboard/emergencias');
});

it('borrar proveedor: id viaja por el form, tenant por la sesión', async () => {
  dobles.listarProveedoresEmergencia.mockResolvedValue([
    { id: 'p-1', tipo: 'grua', nombre: 'Grúas García', telefono: '1', radioKm: null, verificadoEn: '2026-01-01T00:00:00Z', lat: null, lng: null, notas: null },
  ]);
  dobles.borrarProveedorEmergencia.mockResolvedValue(undefined);
  const pagina = await PaginaEmergencias({ searchParams: SP });
  const fs = formularios(pagina);
  // Ya verificado: no hay form de "verificar", el primero es "borrar".
  const borrar = fs[0].props.action as Accion2;
  await borrar(fd({ id: 'p-1' }));
  expect(dobles.borrarProveedorEmergencia).toHaveBeenCalledWith('t-1', 'p-1');
});

it('alta de contacto: manda el tenant de la SESIÓN', async () => {
  dobles.crearContactoEmergencia.mockResolvedValue(undefined);
  const pagina = await PaginaEmergencias({ searchParams: SP });
  const accion = accionDelBoton(pagina, /Agregar contacto/);
  const r = await accion(null, fd({
    operadorId: 'op-1', nombre: 'Ana', telefono: '3312345678', avisarSiLesionados: 'si', tenantId: 'OTRO',
  }));
  expect(dobles.crearContactoEmergencia).toHaveBeenCalledWith('t-1', expect.objectContaining({ operadorId: 'op-1', avisarSiLesionados: true }));
  expect(r).toEqual({ ok: 'Contacto guardado.' });
});

it('borrar contacto: id viaja por el form, tenant por la sesión', async () => {
  dobles.listarContactosEmergencia.mockResolvedValue([
    { id: 'c-1', operadorId: 'op-1', operadorNombre: 'Juan', nombre: 'Ana', telefono: '1', parentesco: null, avisarSiLesionados: false },
  ]);
  dobles.borrarContactoEmergencia.mockResolvedValue(undefined);
  const pagina = await PaginaEmergencias({ searchParams: SP });
  const fs = formularios(pagina);
  const borrarContacto = fs.at(-1)!.props.action as Accion2;
  await borrarContacto(fd({ id: 'c-1' }));
  expect(dobles.borrarContactoEmergencia).toHaveBeenCalledWith('t-1', 'c-1');
});

it.each(['contador', 'vendedor'])('la puerta compartida `gate()` rechaza a %s en las seis acciones, aunque se invoquen directo', async (rol) => {
  dobles.listarProveedoresEmergencia.mockResolvedValue([
    { id: 'p-1', tipo: 'grua', nombre: 'G', telefono: '1', radioKm: null, verificadoEn: null, lat: null, lng: null, notas: null },
  ]);
  dobles.listarContactosEmergencia.mockResolvedValue([
    { id: 'c-1', operadorId: 'op-1', operadorNombre: 'Juan', nombre: 'Ana', telefono: '1', parentesco: null, avisarSiLesionados: false },
  ]);
  const pagina = await PaginaEmergencias({ searchParams: SP });
  const [verificar, borrarProv] = formularios(pagina).map((f) => f.props.action as Accion2);
  const altaProveedor = accionDelBoton(pagina, /Agregar proveedor/);
  const guardarPolizaAction = accionDelBoton(pagina, /póliza/i);

  sesion = { tenantId: 't-1', rol, userId: 'u-1' };

  expect(await altaProveedor(null, fd({ tipo: 'grua', nombre: 'x', telefono: '1' })))
    .toEqual({ error: 'Tu rol no puede editar el directorio de emergencia.' });
  expect(await guardarPolizaAction(null, fd({ aseguradora: 'x', numeroPoliza: 'x', telefonoSiniestros: 'x' })))
    .toEqual({ error: 'Tu rol no puede editar el directorio de emergencia.' });
  await verificar(fd({ id: 'p-1' }));
  await borrarProv(fd({ id: 'p-1' }));
  expect(dobles.crearProveedorEmergencia).not.toHaveBeenCalled();
  expect(dobles.guardarPoliza).not.toHaveBeenCalled();
  expect(dobles.marcarProveedorVerificado).not.toHaveBeenCalled();
  expect(dobles.borrarProveedorEmergencia).not.toHaveBeenCalled();
});
