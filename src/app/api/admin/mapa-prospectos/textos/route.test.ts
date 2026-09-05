import { peticionStream } from '@/lib/pruebas/peticion_stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 21, BAJO-MEDIO — esta ruta no tenía ninguna prueba. Fija la
// puerta de origen (CSRF explícito, SEG-9 generalizado) que se agregó aquí:
// es de solo lectura, pero autenticada exclusivamente por cookie de sesión,
// como el resto de la familia mapa-prospectos.
// ═══════════════════════════════════════════════════════════════════════════

let sesion: { userId: string; tenantId: string | null; rol: string } | null = null;
vi.mock('../puerta', () => ({
  sesionSuperadmin: async () => (sesion
    ? { error: null, sesion }
    : { error: new Response(null, { status: 401 }), sesion: null }),
}));

const getTextosProspectos = vi.fn(async () => ({}));
vi.mock('@/lib/admin/prospectos-mapa', () => ({
  getTextosProspectos: (...a: unknown[]) => getTextosProspectos(...(a as [])),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { POST } = await import('./route');

function postear(cuerpo: unknown, cabeceras: Record<string, string> = {}) {
  return POST(new Request('https://app.likida.ai/api/admin/mapa-prospectos/textos', {
    method: 'POST', headers: { 'content-type': 'application/json', ...cabeceras }, body: JSON.stringify(cuerpo),
  }));
}

beforeEach(() => {
  sesion = { userId: 'u-1', tenantId: 't-1', rol: 'superadmin' };
  getTextosProspectos.mockClear();
});

describe('la puerta de origen (auditoría 21, BAJO-MEDIO)', () => {
  it('desde otro sitio: 403 y ni se lee', async () => {
    const r = await postear({ ids: ['11111111-1111-1111-1111-111111111111'] }, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(getTextosProspectos).not.toHaveBeenCalled();
  });

  it('desde el panel (same-origin) sí lee', async () => {
    const r = await postear({ ids: ['11111111-1111-1111-1111-111111111111'] }, { 'sec-fetch-site': 'same-origin' });
    expect(r.status).toBe(200);
    expect(getTextosProspectos).toHaveBeenCalledTimes(1);
  });
});

describe('cuerpo acotado durante lectura', () => {
 it('cancela el exceso sin efectos', async()=>{
  const p=peticionStream('https://app.likida.ai/api/admin/mapa-prospectos/textos',JSON.stringify({...{ids:['11111111-1111-1111-1111-111111111111']},ignorado:'x'.repeat(700000)}),8192);
  expect((await POST(p.req)).status).toBe(413);
  expect(p.estado().cancelado).toBe(true);expect(p.estado().leidos).toBeLessThan(p.estado().total);
  expect(getTextosProspectos).not.toHaveBeenCalled();
 });
 it.each([null, [], 'texto', 42].map((valor) => [valor]))('rechaza cuerpo no objeto %j antes de efectos', async(cuerpo)=>{
  const p=peticionStream('https://app.likida.ai/api/admin/mapa-prospectos/textos',JSON.stringify(cuerpo));
  expect((await POST(p.req)).status).toBe(400);expect(getTextosProspectos).not.toHaveBeenCalled();
 });
});

it('2000 UUIDs escapados caben completos en el transporte',async()=>{
 const ids=Array.from({length:2000},(_,i)=>`11111111-1111-1111-1111-${String(i).padStart(12,'0')}`);
 const crudo=JSON.stringify({ids}).replace(/[0-9-]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
 const p=peticionStream('https://app.likida.ai/api/admin/mapa-prospectos/textos',crudo);
 expect((await POST(p.req)).status).toBe(200);expect(getTextosProspectos).toHaveBeenCalledWith(ids);
});
