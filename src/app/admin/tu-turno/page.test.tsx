import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/tu-turno — CERO cobertura de la PÁGINA (bus.ts/bus.io.ts ya tienen
// prueba propia). Dos server actions con su PROPIA requireSuperadmin() —
// defensa extra sobre el gate de admin/layout.tsx, ya que una action es
// alcanzable por POST directo. Lo real: ADM-12 — el actor que se graba es un
// CORREO legible, nunca un uuid crudo salvo que el correo no se pudo
// resolver (y entonces se dice explícitamente, no se finge).
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({
  requireSuperadmin: vi.fn(),
  getEstadoBus: vi.fn(),
  getPrsAbiertos: vi.fn(),
  crearOrden: vi.fn(),
  resolverPieza: vi.fn(),
  emailDeActor: vi.fn(),
  getBandejaEscalaciones: vi.fn(),
  bandejaPendiente: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

vi.mock('@/lib/auth/guard', () => ({ requireSuperadmin: dobles.requireSuperadmin }));
vi.mock('next/navigation', () => ({ redirect: dobles.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: dobles.revalidatePath }));
vi.mock('@/lib/admin/bus', async (importar) => ({
  ...(await importar<typeof import('@/lib/admin/bus')>()),
  getEstadoBus: dobles.getEstadoBus,
  getPrsAbiertos: dobles.getPrsAbiertos,
  crearOrden: dobles.crearOrden,
  resolverPieza: dobles.resolverPieza,
  emailDeActor: dobles.emailDeActor,
}));
vi.mock('@/lib/admin/escalaciones', () => ({ getBandejaEscalaciones: dobles.getBandejaEscalaciones }));
vi.mock('@/lib/likida/agentes/cola', () => ({ bandejaPendiente: dobles.bandejaPendiente }));
vi.mock('./vista', () => ({ VistaTuTurno: (props: Record<string, unknown>) => props }));

import PaginaTuTurno from './page';

type Props = {
  accionPieza: (fd: FormData) => Promise<void>;
  accionOrden: (fd: FormData) => Promise<void>;
};
const SP = Promise.resolve({});
const fd = (campos: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(campos)) f.set(k, v); return f; };

beforeEach(() => {
  vi.clearAllMocks();
  dobles.requireSuperadmin.mockResolvedValue({ userId: 'u-1', nombre: 'Javier' });
  dobles.getEstadoBus.mockResolvedValue({ piezas: [] });
  dobles.getPrsAbiertos.mockResolvedValue([]);
  dobles.getBandejaEscalaciones.mockResolvedValue([]);
  dobles.bandejaPendiente.mockResolvedValue([]);
  dobles.emailDeActor.mockResolvedValue('javier@likida.ai');
});

async function pagina() { return ((await PaginaTuTurno({ searchParams: SP })) as unknown as { props: Props }).props; }

it('junta urgentes ANTES que normales, sin remezclar (misma cola que /admin/aprobaciones)', async () => {
  dobles.bandejaPendiente.mockImplementation(async (prioridad: string) =>
    prioridad === 'urgente' ? [{ id: 'e-urgente' }] : [{ id: 'e-normal' }]);
  const p = (await PaginaTuTurno({ searchParams: SP })) as unknown as { props: { envios: Array<{ id: string }> } };
  expect(p.props.envios.map((e) => e.id)).toEqual(['e-urgente', 'e-normal']);
});

it('resolver pieza: aprobada — graba el correo legible del actor, no el uuid', async () => {
  dobles.resolverPieza.mockResolvedValue(undefined);
  const p = await pagina();
  await expect(p.accionPieza(fd({ pieza: 'p-1', accion: 'aprobada' }))).rejects.toThrow(/REDIRECT:\/admin\/tu-turno\?aviso=/);
  expect(dobles.resolverPieza).toHaveBeenCalledWith('p-1', 'aprobada', 'javier@likida.ai');
  expect(dobles.revalidatePath).toHaveBeenCalledWith('/admin/tu-turno');
});

it('resolver pieza: sin correo resuelto, usa el uuid CON su porqué — nunca finge un correo', async () => {
  dobles.emailDeActor.mockResolvedValue(null);
  dobles.resolverPieza.mockResolvedValue(undefined);
  const p = await pagina();
  await expect(p.accionPieza(fd({ pieza: 'p-1', accion: 'descartada' }))).rejects.toThrow();
  expect(dobles.resolverPieza).toHaveBeenCalledWith('p-1', 'descartada', 'uuid:u-1 (correo no resuelto)');
});

it('resolver pieza: una acción desconocida no llega a resolverPieza — error explícito', async () => {
  const p = await pagina();
  await expect(p.accionPieza(fd({ pieza: 'p-1', accion: 'cualquier-otra-cosa' })))
    .rejects.toThrow(/REDIRECT:\/admin\/tu-turno\?error=/);
  expect(dobles.resolverPieza).not.toHaveBeenCalled();
});

it('resolver pieza: la puerta se re-verifica dentro de la action (requireSuperadmin llamado dos veces: render + action)', async () => {
  dobles.resolverPieza.mockResolvedValue(undefined);
  const p = await pagina();
  dobles.requireSuperadmin.mockClear();
  await expect(p.accionPieza(fd({ pieza: 'p-1', accion: 'aprobada' }))).rejects.toThrow();
  expect(dobles.requireSuperadmin).toHaveBeenCalledTimes(1);
});

it('crear orden: correo legible del actor, y el contenido SOLO viaja para editar_encargo', async () => {
  dobles.crearOrden.mockResolvedValue(undefined);
  const p = await pagina();
  await expect(p.accionOrden(fd({ tipo: 'correr_ahora', rutina: 'mejora-diaria', contenido: 'fantasma' })))
    .rejects.toThrow();
  expect(dobles.crearOrden).toHaveBeenCalledWith('correr_ahora', 'mejora-diaria', 'javier@likida.ai', {});
});

it('crear orden: editar_encargo SÍ lleva el contenido en el payload', async () => {
  dobles.crearOrden.mockResolvedValue(undefined);
  const p = await pagina();
  let mensaje = '';
  try { await p.accionOrden(fd({ tipo: 'editar_encargo', contenido: 'nuevo texto del encargo' })); }
  catch (e) { mensaje = decodeURIComponent((e as Error).message); }
  expect(mensaje).toContain('abre un PR chico');
  expect(dobles.crearOrden).toHaveBeenCalledWith('editar_encargo', null, 'javier@likida.ai', { contenido: 'nuevo texto del encargo' });
});

it('crear orden: un tipo que no existe en esOrdenUi no llega a crearOrden', async () => {
  const p = await pagina();
  await expect(p.accionOrden(fd({ tipo: 'algo-inventado' }))).rejects.toThrow(/REDIRECT:\/admin\/tu-turno\?error=/);
  expect(dobles.crearOrden).not.toHaveBeenCalled();
});
