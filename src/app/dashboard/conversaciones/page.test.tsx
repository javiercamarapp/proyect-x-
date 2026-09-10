import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /dashboard/conversaciones — CERO cobertura de la PÁGINA (getHilosDeFlota ya
// tiene prueba de aislamiento propia). Página de sólo lectura, área
// `administracion` (SOLO dueño/superadmin, ni siquiera el encargado — un
// hilo de WhatsApp es dinero en prosa). Lo que se vigila aquí: fail-cerrado
// real (un error de lectura no se ve como "el bot no ha hablado con nadie"),
// y que el tope de hilos (`TOPE_HILOS`) se declare en vez de esconderse.
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({
  getHilosDeFlota: vi.fn(),
  contarHilosDeFlota: vi.fn(),
}));

let sesion: { tenantId: string; rol: string; userId: string } = { tenantId: 't-1', rol: 'flota_admin', userId: 'u-1' };

vi.mock('@/lib/auth/tenant-efectivo', () => ({ resolverTenantEfectivo: async () => sesion }));
vi.mock('next/navigation', () => ({ redirect: (ruta: string) => { throw new Error(`REDIRECT:${ruta}`); } }));
vi.mock('@/lib/likida/conversaciones', async (importar) => ({
  ...(await importar<typeof import('@/lib/likida/conversaciones')>()),
  getHilosDeFlota: dobles.getHilosDeFlota,
  contarHilosDeFlota: dobles.contarHilosDeFlota,
}));

import { TOPE_HILOS } from '@/lib/likida/conversaciones';
import ConversacionesFlotaPage from './page';

const SP = Promise.resolve({});
async function renderizar() { return renderToStaticMarkup(await ConversacionesFlotaPage({ searchParams: SP })); }
const HILO = { telefono: '5219991234567', operadorNombre: 'Juan', viajeFolio: 'VJ-1', actualizadaEn: '2026-01-01T00:00:00Z', turns: [{ role: 'user', content: '¿Ya está liquidado?' }, { role: 'assistant', content: 'Sí, VJ-1 se cerró ayer.' }] };

beforeEach(() => {
  vi.clearAllMocks();
  sesion = { tenantId: 't-1', rol: 'flota_admin', userId: 'u-1' };
  dobles.getHilosDeFlota.mockResolvedValue([]);
  dobles.contarHilosDeFlota.mockResolvedValue(0);
});

it.each(['encargado', 'contador', 'vendedor'])('%s no puede ver conversaciones (área administracion, no dinero ni operacion): redirect', async (rol) => {
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  await expect(ConversacionesFlotaPage({ searchParams: SP })).rejects.toThrow('REDIRECT:/dashboard');
  expect(dobles.getHilosDeFlota).not.toHaveBeenCalled();
});

it.each(['flota_admin', 'superadmin'])('%s sí puede ver conversaciones', async (rol) => {
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  await expect(ConversacionesFlotaPage({ searchParams: SP })).resolves.toBeTruthy();
});

it('lee los hilos y el conteo del tenant de la SESIÓN', async () => {
  await renderizar();
  expect(dobles.getHilosDeFlota).toHaveBeenCalledWith('t-1');
  expect(dobles.contarHilosDeFlota).toHaveBeenCalledWith('t-1');
});

it('una lectura caída se DICE — nunca se ve como "el bot no ha hablado con nadie"', async () => {
  dobles.getHilosDeFlota.mockRejectedValueOnce(new Error('la base no contestó'));
  const html = await renderizar();
  expect(html).toContain('No se pudieron leer las conversaciones');
  expect(html).not.toContain('todavía no ha conversado');
});

it('cero hilos DE VERDAD (lectura ok) sí dice "todavía no ha conversado"', async () => {
  const html = await renderizar();
  expect(html).toContain('todavía no ha conversado con ningún número');
});

it('un conteo que no se pudo leer se dice explícitamente, no se confunde con cero', async () => {
  dobles.contarHilosDeFlota.mockRejectedValueOnce(new Error('caída'));
  // getHilosDeFlota y contarHilosDeFlota van en el mismo Promise.all: si uno
  // falla, el catch cubre a los dos y errorCarga se activa para ambos.
  const html = await renderizar();
  expect(html).toContain('No se pudieron leer las conversaciones');
});

it(`con más hilos de los que se listan (recorte de ${TOPE_HILOS}), lo dice — no presenta el recorte como el total`, async () => {
  dobles.getHilosDeFlota.mockResolvedValue([HILO]);
  dobles.contarHilosDeFlota.mockResolvedValue(50);
  const html = await renderizar();
  expect(html).toContain(`Los ${TOPE_HILOS} más recientes de 50`);
});

it('sin recorte, dice "Todos tus hilos"', async () => {
  dobles.getHilosDeFlota.mockResolvedValue([HILO]);
  dobles.contarHilosDeFlota.mockResolvedValue(1);
  const html = await renderizar();
  expect(html).toContain('Todos tus hilos');
});

it('un hilo con turnos declara la ventana rodante — no promete el historial completo', async () => {
  dobles.getHilosDeFlota.mockResolvedValue([HILO]);
  dobles.contarHilosDeFlota.mockResolvedValue(1);
  const html = await renderizar();
  expect(html).toContain('¿Ya está liquidado?');
  expect(html).toContain('VJ-1 se cerró ayer');
  expect(html).toContain('no el historial completo desde el primer día');
});
