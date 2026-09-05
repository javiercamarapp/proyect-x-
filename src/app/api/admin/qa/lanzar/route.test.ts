import { peticionStream } from '@/lib/pruebas/peticion_stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 21, BAJO-MEDIO — esta ruta no tenía ninguna prueba. Fija la
// puerta de origen (CSRF explícito, SEG-9 generalizado) que se agregó aquí:
// lanza una corrida que gasta dinero real, autenticada solo por cookie.
// ═══════════════════════════════════════════════════════════════════════════

let sesion: { userId: string; tenantId: string | null; rol: string } | null = null;
vi.mock('../puerta', () => ({
  sesionSuperadmin: async () => (sesion
    ? { error: null, sesion }
    : { error: new Response(null, { status: 401 }), sesion: null }),
}));

vi.mock('@/lib/admin/qa-tipos', () => ({
  validarLanzar: (body: unknown) => ({ ok: true, datos: (body as { escenario: string; params: { fotoIds: string[] }; carril: string }) }),
}));
const crearCorrida = vi.fn(() => ({ id: 'corrida-1', carril: 'rapido', parametros: { fotoIds: [] } }));
const ejecutarCorridaRapida = vi.fn(async () => undefined);
vi.mock('@/lib/admin/qa-motor', () => ({
  crearCorrida: (...a: unknown[]) => crearCorrida(...(a as [])),
  ejecutarCorridaRapida: (...a: unknown[]) => ejecutarCorridaRapida(...(a as [])),
  TOPE_DIA_USD: 5,
}));
const guardarCorrida = vi.fn(async () => undefined);
vi.mock('@/lib/admin/qa-storage', () => ({
  gastoHoyUsd: async () => ({ ok: true, datos: 0 }),
  guardarCorrida: (...a: unknown[]) => guardarCorrida(...(a as [])),
  leerManifiesto: async () => ({ ok: true, datos: [{ id: 'foto-1' }] }),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('next/server', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, after: (fn: () => unknown) => { void fn; } };
});

const { POST } = await import('./route');

function postear(cuerpo: unknown, cabeceras: Record<string, string> = {}) {
  return POST(new Request('https://app.likida.ai/api/admin/qa/lanzar', {
    method: 'POST', headers: { 'content-type': 'application/json', ...cabeceras }, body: JSON.stringify(cuerpo),
  }));
}

const LANZAR = { escenario: 'x', params: { fotoIds: ['foto-1'] }, carril: 'rapido' };

beforeEach(() => {
  sesion = { userId: 'u-1', tenantId: 't-1', rol: 'superadmin' };
  crearCorrida.mockClear(); guardarCorrida.mockClear(); ejecutarCorridaRapida.mockClear();
});

describe('la puerta de origen (auditoría 21, BAJO-MEDIO)', () => {
  it('desde otro sitio: 403 y ninguna corrida se lanza', async () => {
    const r = await postear(LANZAR, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(guardarCorrida).not.toHaveBeenCalled();
  });

  it('desde el panel (same-origin) sí lanza', async () => {
    const r = await postear(LANZAR, { 'sec-fetch-site': 'same-origin' });
    expect(r.status).toBe(200);
    expect(guardarCorrida).toHaveBeenCalledTimes(1);
  });
});

describe('cuerpo acotado durante lectura', () => {
 it('cancela el exceso sin efectos', async()=>{
  const p=peticionStream('https://app.likida.ai/api/admin/qa/lanzar',JSON.stringify({...LANZAR,ignorado:'x'.repeat(100000)}),8192);
  expect((await POST(p.req)).status).toBe(413);
  expect(p.estado().cancelado).toBe(true);expect(p.estado().leidos).toBeLessThan(p.estado().total);
  expect(guardarCorrida).not.toHaveBeenCalled();
 });
 it.each([null, [], 'texto', 42].map((valor) => [valor]))('rechaza cuerpo no objeto %j antes de efectos', async(cuerpo)=>{
  const p=peticionStream('https://app.likida.ai/api/admin/qa/lanzar',JSON.stringify(cuerpo));
  expect((await POST(p.req)).status).toBe(400);expect(guardarCorrida).not.toHaveBeenCalled();
 });
});
