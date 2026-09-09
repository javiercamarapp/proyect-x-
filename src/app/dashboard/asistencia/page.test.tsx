import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /dashboard/asistencia (Mesa de control) — CERO cobertura de la PÁGINA
// (mesa_control.ts ya tiene prueba). Tres server actions detrás de la puerta
// compartida gate(): tomar control, reescalar, cerrar con nota. Nada de esto
// marca 911 ni la aseguradora — sólo decide sobre el expediente.
// ═══════════════════════════════════════════════════════════════════════════

type Elemento = ReactElement<Record<string, unknown>>;

const dobles = vi.hoisted(() => ({
  listarMesaAsistencia: vi.fn(),
  tomarControlMesa: vi.fn(),
  resolverDesdeMesa: vi.fn(),
  reescalarDesdeMesa: vi.fn(),
  revalidatePath: vi.fn(),
}));

let sesion: { tenantId: string; rol: string; userId: string } = { tenantId: 't-1', rol: 'flota_admin', userId: 'u-1' };

vi.mock('@/lib/auth/tenant-efectivo', () => ({ resolverTenantEfectivo: async () => sesion }));
vi.mock('next/navigation', () => ({ redirect: (ruta: string) => { throw new Error(`REDIRECT:${ruta}`); } }));
vi.mock('next/cache', () => ({ revalidatePath: dobles.revalidatePath }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/likida/mesa_control', async (importar) => ({
  ...(await importar<typeof import('@/lib/likida/mesa_control')>()),
  listarMesaAsistencia: dobles.listarMesaAsistencia,
  tomarControlMesa: dobles.tomarControlMesa,
  resolverDesdeMesa: dobles.resolverDesdeMesa,
  reescalarDesdeMesa: dobles.reescalarDesdeMesa,
}));

import { FormaConAviso } from '../../admin/ui/forma';
import PaginaMesaControl from './page';

function formularios(nodo: ReactNode, salida: Elemento[] = []): Elemento[] {
  if (Array.isArray(nodo)) { for (const hijo of nodo) formularios(hijo, salida); return salida; }
  if (!isValidElement<Record<string, unknown>>(nodo)) return salida;
  if (nodo.type === 'form') salida.push(nodo);
  formularios(nodo.props.children as ReactNode, salida);
  return salida;
}
function formasConAviso(nodo: ReactNode, salida: Elemento[] = []): Elemento[] {
  if (Array.isArray(nodo)) { for (const hijo of nodo) formasConAviso(hijo, salida); return salida; }
  if (!isValidElement<Record<string, unknown>>(nodo)) return salida;
  if (nodo.type === FormaConAviso) salida.push(nodo);
  formasConAviso(nodo.props.children as ReactNode, salida);
  return salida;
}

const SP = Promise.resolve({});
const fd = (campos: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(campos)) f.set(k, v); return f; };
const INC = {
  id: 'i-1', tipo: 'accidente', prioridad: 'critica', nivelEscalado: 1, operadorNombre: 'Juan',
  unidadRotulo: null, viajeFolio: null, abiertaEn: '2026-01-01T00:00:00Z', hayLesionados: false,
  soloCamara: false, descripcion: null, reconocidaEn: null, reconocidaPorNombre: null, eventos: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  sesion = { tenantId: 't-1', rol: 'flota_admin', userId: 'u-1' };
  dobles.listarMesaAsistencia.mockResolvedValue([]);
});

it.each(['contador', 'vendedor'])('%s no puede ver la página: redirect antes de tocar la base', async (rol) => {
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  await expect(PaginaMesaControl({ searchParams: SP })).rejects.toThrow('REDIRECT:/dashboard');
  expect(dobles.listarMesaAsistencia).not.toHaveBeenCalled();
});

it('una lectura caída no ofrece botones de intervención — no se decide sobre lo que no se ve', async () => {
  dobles.listarMesaAsistencia.mockRejectedValueOnce(new Error('caída'));
  const pagina = await PaginaMesaControl({ searchParams: SP });
  expect(formularios(pagina)).toHaveLength(0);
  expect(formasConAviso(pagina)).toHaveLength(0);
});

it('tomar el control: manda tenant/usuario de la SESIÓN, id por el form', async () => {
  dobles.listarMesaAsistencia.mockResolvedValue([INC]);
  dobles.tomarControlMesa.mockResolvedValue({ ok: true });
  const pagina = await PaginaMesaControl({ searchParams: SP });
  const [tomarControl] = formularios(pagina);
  await (tomarControl.props.action as (fd: FormData) => Promise<void>)(fd({ id: 'i-1', tenantId: 'OTRO' }));
  expect(dobles.tomarControlMesa).toHaveBeenCalledWith('t-1', 'i-1', 'u-1');
  expect(dobles.revalidatePath).toHaveBeenCalledWith('/dashboard/asistencia');
});

it('reescalar: manda tenant/usuario de la SESIÓN, id y nivel por el form', async () => {
  dobles.listarMesaAsistencia.mockResolvedValue([INC]);
  dobles.reescalarDesdeMesa.mockResolvedValue({ ok: true });
  const pagina = await PaginaMesaControl({ searchParams: SP });
  const [, reescalar] = formularios(pagina);
  await (reescalar.props.action as (fd: FormData) => Promise<void>)(fd({ id: 'i-1', nivel: '2', tenantId: 'OTRO' }));
  expect(dobles.reescalarDesdeMesa).toHaveBeenCalledWith('t-1', 'i-1', 'u-1', 2);
});

it('cerrar con nota: manda tenant/usuario de la SESIÓN, nota obligatoria por el form', async () => {
  dobles.listarMesaAsistencia.mockResolvedValue([INC]);
  dobles.resolverDesdeMesa.mockResolvedValue({ ok: 'Cerrada.' });
  const pagina = await PaginaMesaControl({ searchParams: SP });
  const [cerrar] = formasConAviso(pagina);
  const accion = cerrar.props.accion as (previo: unknown, fd: FormData) => Promise<{ ok?: string; error?: string }>;
  const r = await accion(null, fd({ id: 'i-1', nota: 'Se atendió, sin lesionados.', tenantId: 'OTRO' }));
  expect(dobles.resolverDesdeMesa).toHaveBeenCalledWith('t-1', 'i-1', 'u-1', 'Se atendió, sin lesionados.');
  expect(r).toEqual({ ok: 'Cerrada.' });
});

it('cerrar con nota: un error de la mesa (p. ej. sin control tomado) llega verbatim', async () => {
  dobles.listarMesaAsistencia.mockResolvedValue([INC]);
  dobles.resolverDesdeMesa.mockResolvedValue({ error: 'Toma el control antes de cerrar.' });
  const pagina = await PaginaMesaControl({ searchParams: SP });
  const [cerrar] = formasConAviso(pagina);
  const accion = cerrar.props.accion as (previo: unknown, fd: FormData) => Promise<{ ok?: string; error?: string }>;
  const r = await accion(null, fd({ id: 'i-1', nota: 'x' }));
  expect(r).toEqual({ error: 'Toma el control antes de cerrar.' });
});

it.each(['contador', 'vendedor'])('la puerta compartida gate() rechaza a %s en las tres acciones, aunque se invoquen directo', async (rol) => {
  dobles.listarMesaAsistencia.mockResolvedValue([INC]);
  const pagina = await PaginaMesaControl({ searchParams: SP });
  const [tomarControl, reescalar] = formularios(pagina);
  const [cerrar] = formasConAviso(pagina);
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };

  await (tomarControl.props.action as (fd: FormData) => Promise<void>)(fd({ id: 'i-1' }));
  await (reescalar.props.action as (fd: FormData) => Promise<void>)(fd({ id: 'i-1', nivel: '2' }));
  const r = await (cerrar.props.accion as (previo: unknown, fd: FormData) => Promise<{ error?: string }>)(null, fd({ id: 'i-1', nota: 'x' }));

  expect(r).toEqual({ error: 'Tu rol no puede intervenir desde la mesa de control.' });
  expect(dobles.tomarControlMesa).not.toHaveBeenCalled();
  expect(dobles.reescalarDesdeMesa).not.toHaveBeenCalled();
  expect(dobles.resolverDesdeMesa).not.toHaveBeenCalled();
});
