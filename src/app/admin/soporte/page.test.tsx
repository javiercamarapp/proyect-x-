import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/soporte — CERO cobertura de la PÁGINA (getTicketsCruzados/soporte.ts
// ya tienen prueba propia: admin/soporte.test.ts y likida/soporte.test.ts).
// Tres server actions (responder, tomar, cambiar estado), cada una re-exige
// `requireSuperadmin()` adentro — el patrón del repo: una server action es un
// endpoint POST alcanzable sin pasar por el render de la página.
// ═══════════════════════════════════════════════════════════════════════════

type Elemento = ReactElement<Record<string, unknown>>;

const dobles = vi.hoisted(() => ({
  requireSuperadmin: vi.fn(),
  getTicketsCruzados: vi.fn(),
  contarTickets: vi.fn(),
  resolverTicketCruzado: vi.fn(),
  getTicketDelTenant: vi.fn(),
  getHilo: vi.fn(),
  responderTicket: vi.fn(),
  tomarTicket: vi.fn(),
  cambiarEstadoTicket: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/auth/guard', () => ({ requireSuperadmin: dobles.requireSuperadmin }));
vi.mock('next/cache', () => ({ revalidatePath: dobles.revalidatePath }));
vi.mock('@/lib/admin/soporte', async (importar) => ({
  ...(await importar<typeof import('@/lib/admin/soporte')>()),
  getTicketsCruzados: dobles.getTicketsCruzados,
  contarTickets: dobles.contarTickets,
  resolverTicketCruzado: dobles.resolverTicketCruzado,
}));
vi.mock('@/lib/likida/soporte', async (importar) => ({
  ...(await importar<typeof import('@/lib/likida/soporte')>()),
  getTicketDelTenant: dobles.getTicketDelTenant,
  getHilo: dobles.getHilo,
  responderTicket: dobles.responderTicket,
  tomarTicket: dobles.tomarTicket,
  cambiarEstadoTicket: dobles.cambiarEstadoTicket,
}));

import { FormaConAviso } from '../ui/forma';
import SoportePage from './page';

function formasConAviso(nodo: ReactNode, salida: Elemento[] = []): Elemento[] {
  if (Array.isArray(nodo)) { for (const hijo of nodo) formasConAviso(hijo, salida); return salida; }
  if (!isValidElement<Record<string, unknown>>(nodo)) return salida;
  if (nodo.type === FormaConAviso) salida.push(nodo);
  formasConAviso(nodo.props.children as ReactNode, salida);
  return salida;
}
function accionDelBoton(pagina: ReactNode, patron: RegExp) {
  const forma = formasConAviso(pagina).find((f) => patron.test(String(f.props.boton)));
  if (!forma) throw new Error(`No se encontró un FormaConAviso con botón que matchee ${patron}`);
  return forma.props.accion as (previo: unknown, fd: FormData) => Promise<{ ok?: string; error?: string }>;
}

const fd = (campos: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(campos)) f.set(k, v); return f; };
const DETALLE = { id: 't-1', asunto: 'No puedo timbrar', categoria: 'fiscal', prioridad: 'alta', estado: 'abierto', abiertoEn: '2026-01-01T00:00:00Z', venceEn: null, asignadoA: null, asignadoNombre: null, descripcion: null };

async function paginaConTicketAbierto() {
  dobles.resolverTicketCruzado.mockResolvedValue({ id: 't-1', tenantId: 'tn-1', tenantNombre: 'Transportes ACME' });
  dobles.getTicketDelTenant.mockResolvedValue(DETALLE);
  dobles.getHilo.mockResolvedValue([]);
  return SoportePage({ searchParams: Promise.resolve({ ticket: 't-1' }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  dobles.requireSuperadmin.mockResolvedValue({ userId: 'u-1', tenantId: null, rol: 'superadmin' });
  dobles.getTicketsCruzados.mockResolvedValue([]);
  dobles.contarTickets.mockResolvedValue({ abiertos: 0, vencidos: 0, sinSla: 0, cerrados: 0 });
});

it('no-superadmin: requireSuperadmin ya redirige (lo prueba guard.test.ts) — aquí sólo confirmamos que la página lo invoca antes de leer la cola', async () => {
  dobles.requireSuperadmin.mockRejectedValueOnce(new Error('REDIRECT:/dashboard'));
  await expect(SoportePage({ searchParams: Promise.resolve({}) })).rejects.toThrow('REDIRECT:/dashboard');
  expect(dobles.getTicketsCruzados).not.toHaveBeenCalled();
});

it('una cola caída se dice — nunca se confunde con "nadie necesita nada"', async () => {
  dobles.getTicketsCruzados.mockRejectedValueOnce(new Error('caída'));
  const pagina = await SoportePage({ searchParams: Promise.resolve({}) });
  expect(formasConAviso(pagina)).toHaveLength(0);
});

it('responder: manda el userId de la SESIÓN, resuelve la flota del ticket por el form (no confía en un tenant suelto)', async () => {
  dobles.responderTicket.mockResolvedValue({ movioAEnProceso: true });
  const pagina = await paginaConTicketAbierto();
  const accion = accionDelBoton(pagina, /^Enviar$/);
  const r = await accion(null, fd({ ticket: 't-1', cuerpo: 'Ya lo revisamos', tenantId: 'OTRO' }));
  expect(dobles.resolverTicketCruzado).toHaveBeenCalledWith('t-1');
  expect(dobles.responderTicket).toHaveBeenCalledWith('t-1', 'tn-1', { tipo: 'likida', userId: 'u-1' }, { cuerpo: 'Ya lo revisamos', interna: false });
  expect(r).toEqual(expect.objectContaining({ ok: expect.stringContaining('en proceso') }));
});

it('responder con nota interna: NO cuenta como respuesta pública — el rótulo lo dice', async () => {
  dobles.responderTicket.mockResolvedValue({ movioAEnProceso: false });
  const pagina = await paginaConTicketAbierto();
  const accion = accionDelBoton(pagina, /^Enviar$/);
  const r = await accion(null, fd({ ticket: 't-1', cuerpo: 'nota', interna: '1' }));
  expect(dobles.responderTicket).toHaveBeenCalledWith('t-1', 'tn-1', expect.anything(), expect.objectContaining({ interna: true }));
  expect(r).toEqual(expect.objectContaining({ ok: expect.stringContaining('NO la ve') }));
});

it('un ticket que ya no existe: NO escribe a ciegas en el hilo de otro (falla cerrado, mensaje genérico porque flotaDelTicket lanza Error simple, no DatoInvalido)', async () => {
  const pagina = await paginaConTicketAbierto();
  const accion = accionDelBoton(pagina, /^Enviar$/);
  dobles.resolverTicketCruzado.mockResolvedValueOnce(null); // el POST llega DESPUÉS de que el ticket se borró
  const r = await accion(null, fd({ ticket: 't-borrado', cuerpo: 'x' }));
  expect(r).toEqual(expect.objectContaining({ error: expect.any(String) }));
  expect((r as { error: string }).error).not.toBe('');
  expect(dobles.responderTicket).not.toHaveBeenCalled();
});

it('tomar: manda el userId de la SESIÓN, id por el form', async () => {
  dobles.tomarTicket.mockResolvedValue({ estado: 'en_proceso' });
  const pagina = await paginaConTicketAbierto();
  const accion = accionDelBoton(pagina, /Tomar el ticket/);
  const r = await accion(null, fd({ ticket: 't-1' }));
  expect(dobles.tomarTicket).toHaveBeenCalledWith('t-1', 'tn-1', { tipo: 'likida', userId: 'u-1' });
  expect(r).toEqual(expect.objectContaining({ ok: expect.stringContaining('en_proceso') }));
});

it('cambiar estado: manda el userId de la SESIÓN; si la bitácora falló, lo DICE en vez de afirmar que sí quedó', async () => {
  dobles.cambiarEstadoTicket.mockResolvedValue({ estadoPrevio: 'abierto', estado: 'resuelto', anotado: false });
  const pagina = await paginaConTicketAbierto();
  const accion = accionDelBoton(pagina, /Cambiar estado/);
  const r = await accion(null, fd({ ticket: 't-1', estado: 'resuelto' }));
  expect(dobles.cambiarEstadoTicket).toHaveBeenCalledWith('t-1', 'tn-1', { tipo: 'likida', userId: 'u-1' }, 'resuelto');
  expect(r).toEqual(expect.objectContaining({ ok: expect.stringContaining('no se pudo escribir fue la entrada de bitácora') }));
});
