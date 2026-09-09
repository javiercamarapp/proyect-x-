import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /dashboard/reglas — CERO cobertura de la PÁGINA (traductor/repo/catálogo ya
// tienen prueba propia). Las seis server actions comparten `sesionConPermiso`
// (helper de MÓDULO, no closure — server_actions_sin_closures.test.ts ya
// vigila eso); lo que faltaba es la puerta en sí: contador/superadmin sí,
// encargado no (VER y ESCRIBIR son la misma área "dinero"), y que el
// tenant/usuario que se graba sea siempre el de la SESIÓN.
// ═══════════════════════════════════════════════════════════════════════════

type Elemento = ReactElement<Record<string, unknown>>;

const dobles = vi.hoisted(() => ({
  interpretar: vi.fn(),
  interpretarAMano: vi.fn(),
  crearReglaPendiente: vi.fn(),
  confirmarRegla: vi.fn(),
  alternarPausa: vi.fn(),
  borrarRegla: vi.fn(),
  listarReglas: vi.fn(),
  revalidatePath: vi.fn(),
}));

let sesion: { tenantId: string; rol: string; userId: string } = { tenantId: 't-1', rol: 'flota_admin', userId: 'u-1' };

vi.mock('@/lib/auth/tenant-efectivo', () => ({ resolverTenantEfectivo: async () => sesion }));
vi.mock('next/navigation', () => ({ redirect: (ruta: string) => { throw new Error(`REDIRECT:${ruta}`); } }));
vi.mock('next/cache', () => ({ revalidatePath: dobles.revalidatePath }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/likida/reglas/traductor', () => ({ interpretar: dobles.interpretar, interpretarAMano: dobles.interpretarAMano }));
vi.mock('@/lib/likida/reglas/repo', async (importar) => ({
  ...(await importar<typeof import('@/lib/likida/reglas/repo')>()),
  crearReglaPendiente: dobles.crearReglaPendiente,
  confirmarRegla: dobles.confirmarRegla,
  alternarPausa: dobles.alternarPausa,
  borrarRegla: dobles.borrarRegla,
  listarReglas: dobles.listarReglas,
}));

import { FormaEscribirRegla, FormaElegirAMano, type AccionForma } from './forma';
import { ListaReglas } from './vista';
import PaginaReglas from './page';

function buscar(nodo: ReactNode, componente: unknown, salida: Elemento[] = []): Elemento[] {
  if (Array.isArray(nodo)) { for (const hijo of nodo) buscar(hijo, componente, salida); return salida; }
  if (!isValidElement<Record<string, unknown>>(nodo)) return salida;
  if (nodo.type === componente) salida.push(nodo);
  buscar(nodo.props.children as ReactNode, componente, salida);
  return salida;
}

const SP = Promise.resolve({});
const fd = (campos: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(campos)) f.set(k, v); return f; };
const NEGADO = { ok: false, error: 'Tu rol no puede declarar reglas de vigilancia — las declara quien recibe los avisos de dinero.' };

beforeEach(() => {
  vi.clearAllMocks();
  sesion = { tenantId: 't-1', rol: 'flota_admin', userId: 'u-1' };
  dobles.listarReglas.mockResolvedValue([]);
});

it.each(['encargado', 'vendedor'])('%s no puede ver la página: redirect antes de tocar la base', async (rol) => {
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  await expect(PaginaReglas({ searchParams: SP })).rejects.toThrow('REDIRECT:/dashboard');
  expect(dobles.listarReglas).not.toHaveBeenCalled();
});

it.each(['flota_admin', 'superadmin', 'contador'])('%s sí puede ver la página (área dinero)', async (rol) => {
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  await expect(PaginaReglas({ searchParams: SP })).resolves.toBeTruthy();
});

it('interpretar (IA): manda tenant/usuario de la SESIÓN y guarda pendiente, nunca activa', async () => {
  dobles.interpretar.mockResolvedValue({ ok: true, plantilla: 'p1', params: { x: 1 }, frase: 'avísame si...', modelo: 'gpt', costoUsd: 0.01 });
  dobles.crearReglaPendiente.mockResolvedValue({ ok: true, valor: { id: 'r-1' } });
  const pagina = await PaginaReglas({ searchParams: SP });
  const accion = buscar(pagina, FormaEscribirRegla)[0].props.accion as AccionForma;
  const r = await accion(null, fd({ texto: 'avísame si un gasto pasa de 5000', tenantId: 'OTRO' }));
  expect(dobles.interpretar).toHaveBeenCalledWith('avísame si un gasto pasa de 5000', { tenantId: 't-1', rol: 'flota_admin' });
  expect(dobles.crearReglaPendiente).toHaveBeenCalledWith('t-1', expect.objectContaining({ plantilla: 'p1' }), 'u-1');
  expect(r).toEqual(expect.objectContaining({ ok: true }));
});

it('interpretar: frase sin plantilla no inventa una vigilancia — se dice "no puedo" y no se guarda nada', async () => {
  dobles.interpretar.mockResolvedValue({ ok: false, motivo: 'No puedo vigilar eso todavía.', puedoVigilar: ['x'] });
  const pagina = await PaginaReglas({ searchParams: SP });
  const accion = buscar(pagina, FormaEscribirRegla)[0].props.accion as AccionForma;
  const r = await accion(null, fd({ texto: 'algo raro' }));
  expect(r).toEqual({ ok: false, error: 'No puedo vigilar eso todavía.', puedoVigilar: ['x'] });
  expect(dobles.crearReglaPendiente).not.toHaveBeenCalled();
});

it('elegir a mano: sin frase escrita, la cita es la interpretación misma (NOT NULL, no se inventa una frase)', async () => {
  dobles.interpretarAMano.mockReturnValue({ ok: true, plantilla: 'p2', params: { y: 2 }, frase: 'gasto > $5,000' });
  dobles.crearReglaPendiente.mockResolvedValue({ ok: true, valor: { id: 'r-2' } });
  const pagina = await PaginaReglas({ searchParams: SP });
  const accion = buscar(pagina, FormaElegirAMano)[0].props.accion as AccionForma;
  const r = await accion(null, fd({ plantilla: 'p2', p_monto: '5000' }));
  expect(dobles.crearReglaPendiente).toHaveBeenCalledWith('t-1', expect.objectContaining({
    textoOriginal: 'gasto > $5,000', frase: 'gasto > $5,000', modelo: null, costoUsd: 0,
  }), 'u-1');
  expect(r).toEqual(expect.objectContaining({ ok: true }));
});

it('confirmar/pausar/reanudar/borrar: manda tenant/usuario de la SESIÓN, id por el form', async () => {
  dobles.confirmarRegla.mockResolvedValue({ ok: true });
  dobles.alternarPausa.mockResolvedValue({ ok: true });
  dobles.borrarRegla.mockResolvedValue({ ok: true });
  const pagina = await PaginaReglas({ searchParams: SP });
  const { confirmar, pausar, reanudar, borrar } = buscar(pagina, ListaReglas)[0].props.acciones as Record<string, AccionForma>;

  await confirmar(null, fd({ id: 'r-1', tenantId: 'OTRO' }));
  expect(dobles.confirmarRegla).toHaveBeenCalledWith('t-1', 'r-1', { id: 'u-1' });

  await pausar(null, fd({ id: 'r-1' }));
  expect(dobles.alternarPausa).toHaveBeenCalledWith('t-1', 'r-1', true, { id: 'u-1' });

  await reanudar(null, fd({ id: 'r-1' }));
  expect(dobles.alternarPausa).toHaveBeenCalledWith('t-1', 'r-1', false, { id: 'u-1' });

  await borrar(null, fd({ id: 'r-1' }));
  expect(dobles.borrarRegla).toHaveBeenCalledWith('t-1', 'r-1', { id: 'u-1' });
});

it.each(['encargado', 'vendedor'])('las seis acciones rechazan a %s aunque se invoquen directo (sesión re-resuelta en el momento)', async (rol) => {
  dobles.listarReglas.mockResolvedValue([{ id: 'r-1', estado: 'pendiente' }]);
  const pagina = await PaginaReglas({ searchParams: SP });
  const interpretarAccion = buscar(pagina, FormaEscribirRegla)[0].props.accion as AccionForma;
  const aManoAccion = buscar(pagina, FormaElegirAMano)[0].props.accion as AccionForma;
  const { confirmar, pausar, reanudar, borrar } = buscar(pagina, ListaReglas)[0].props.acciones as Record<string, AccionForma>;

  sesion = { tenantId: 't-1', rol, userId: 'u-1' };

  expect(await interpretarAccion(null, fd({ texto: 'x' }))).toEqual(NEGADO);
  expect(await aManoAccion(null, fd({ plantilla: 'p1' }))).toEqual(NEGADO);
  expect(await confirmar(null, fd({ id: 'r-1' }))).toEqual(NEGADO);
  expect(await pausar(null, fd({ id: 'r-1' }))).toEqual(NEGADO);
  expect(await reanudar(null, fd({ id: 'r-1' }))).toEqual(NEGADO);
  expect(await borrar(null, fd({ id: 'r-1' }))).toEqual(NEGADO);
  expect(dobles.crearReglaPendiente).not.toHaveBeenCalled();
  expect(dobles.confirmarRegla).not.toHaveBeenCalled();
  expect(dobles.alternarPausa).not.toHaveBeenCalled();
  expect(dobles.borrarRegla).not.toHaveBeenCalled();
});

it('una lectura de reglas caída se pinta como error, no como "sin reglas" — invitaría a duplicar', async () => {
  dobles.listarReglas.mockRejectedValueOnce(new Error('caída'));
  const pagina = await PaginaReglas({ searchParams: SP });
  expect(buscar(pagina, ListaReglas)).toHaveLength(0);
});
