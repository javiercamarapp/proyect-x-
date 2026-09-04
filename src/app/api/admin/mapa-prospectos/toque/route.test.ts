import { peticionStream } from '@/lib/pruebas/peticion_stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 21, BAJO-MEDIO — esta ruta no tenía ninguna prueba. Fija la
// puerta de origen (CSRF explícito, SEG-9 generalizado) que se agregó aquí:
// registra un toque con service_role, autenticada solo por cookie de sesión.
// ═══════════════════════════════════════════════════════════════════════════

let sesion: { userId: string; tenantId: string | null; rol: string } | null = null;
vi.mock('../puerta', () => ({
  sesionSuperadmin: async () => (sesion
    ? { error: null, sesion }
    : { error: new Response(null, { status: 401 }), sesion: null }),
}));

const insertados: Array<Record<string, unknown>> = [];
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      insert: (v: Record<string, unknown>) => { insertados.push(v); return Promise.resolve({ error: null }); },
    }),
  }),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { POST } = await import('./route');

function postear(cuerpo: unknown, cabeceras: Record<string, string> = {}) {
  return POST(new Request('https://app.likida.ai/api/admin/mapa-prospectos/toque', {
    method: 'POST', headers: { 'content-type': 'application/json', ...cabeceras }, body: JSON.stringify(cuerpo),
  }));
}

const TOQUE = { id: '11111111-1111-1111-1111-111111111111', canal: 'whatsapp', resumen: 'primer toque' };

beforeEach(() => {
  sesion = { userId: 'u-1', tenantId: 't-1', rol: 'superadmin' };
  insertados.length = 0;
});

describe('la puerta de origen (auditoría 21, BAJO-MEDIO)', () => {
  it('desde otro sitio: 403 y nada se inserta', async () => {
    const r = await postear(TOQUE, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(insertados).toHaveLength(0);
  });

  it('desde el panel (same-origin) sí registra', async () => {
    const r = await postear(TOQUE, { 'sec-fetch-site': 'same-origin' });
    expect(r.status).toBe(200);
    expect(insertados).toHaveLength(1);
  });
});

describe('la puerta de sesión sigue en pie', () => {
  it('sin sesión: 401 y nada se inserta', async () => {
    sesion = null;
    const r = await postear(TOQUE, { 'sec-fetch-site': 'same-origin' });
    expect(r.status).toBe(401);
    expect(insertados).toHaveLength(0);
  });
});

describe('cuerpo acotado durante lectura', () => {
 it('cancela el exceso sin efectos', async()=>{
  const p=peticionStream('https://app.likida.ai/api/admin/mapa-prospectos/toque',JSON.stringify({...TOQUE,ignorado:'x'.repeat(20000)}),8192);
  expect((await POST(p.req)).status).toBe(413);
  expect(p.estado().cancelado).toBe(true);expect(p.estado().leidos).toBeLessThan(p.estado().total);
  expect(insertados).toHaveLength(0);
 });
 it.each([null, [], 'texto', 42].map((valor) => [valor]))('rechaza cuerpo no objeto %j antes de efectos', async(cuerpo)=>{
  const p=peticionStream('https://app.likida.ai/api/admin/mapa-prospectos/toque',JSON.stringify(cuerpo));
  expect((await POST(p.req)).status).toBe(400);expect(insertados).toHaveLength(0);
 });
});

it.each([{...TOQUE,id:[TOQUE.id]},{...TOQUE,canal:['whatsapp']},{...TOQUE,resumen:42}])('tipos inválidos no escriben %j',async(cuerpo)=>{
 expect((await postear(cuerpo)).status).toBe(400);expect(insertados).toHaveLength(0);
});
