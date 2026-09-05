import { describe, it, expect, vi, beforeEach } from 'vitest';
import { peticionStream } from '@/lib/pruebas/peticion_stream';

// El pageview del panel (0251): sesión con tenant real obligatoria, catálogo
// CERRADO de pantallas, el superadmin en preview NO cuenta, y 204 SIEMPRE —
// la analítica jamás le contesta un problema al operador. La fila que se
// escribe lleva (tenant, pantalla, 'pageview') y NADA del usuario.

let limiteOk = true;
vi.mock('@/lib/ratelimit', () => ({
  rateLimit: async () => limiteOk,
  bodyExcede: () => false,
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

type Sesion = { userId: string; tenantId: string | null; rol: string } | null;
let sesion: Sesion = null;
vi.mock('@/lib/auth/session', () => ({
  getSessionTenant: async () => sesion,
}));

const eventos: Array<Record<string, unknown>> = [];
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => ({ insert: async (v: Record<string, unknown>) => { eventos.push(v); return { error: null }; } }),
  }),
}));

const { POST } = await import('./route');

const pedir = (cuerpo: unknown, cabeceras?: Record<string, string>) =>
  new Request('https://x/api/dashboard/evento', { method: 'POST', headers: cabeceras, body: JSON.stringify(cuerpo) });

const FLOTA = { userId: 'u-1', tenantId: 't-1', rol: 'flota_admin' };

beforeEach(() => { limiteOk = true; eventos.length = 0; sesion = { ...FLOTA }; });

it('más de1000bytes chunked se cancela sin registrar pageview y conserva204', async () => {
  const p = peticionStream('https://x/api/dashboard/evento', JSON.stringify({
    ruta: '/dashboard/viajes', ignorado: 'x'.repeat(3000),
  }), 1100);
  expect((await POST(p.req)).status).toBe(204);
  expect(eventos).toHaveLength(0);
  expect(p.estado().cancelado).toBe(true);
  expect(p.estado().leidos).toBe(1100);
});

describe('la puerta de origen (auditoría 21, BAJO-MEDIO)', () => {
  it('desde otro sitio: 204 (esta ruta jamás contesta un problema) pero sin escribir', async () => {
    const r = await POST(pedir({ ruta: '/dashboard/viajes' }, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }));
    expect(r.status).toBe(204);
    expect(eventos).toHaveLength(0);
  });
});

describe('POST /api/dashboard/evento', () => {
  it('pageview de una pantalla del catálogo → 204 y fila SIN ningún dato del usuario', async () => {
    const res = await POST(pedir({ ruta: '/dashboard/viajes' }));
    expect(res.status).toBe(204);
    expect(eventos).toEqual([{ tenant_id: 't-1', pantalla: 'viajes', accion: 'pageview' }]);
    // Ni el userId ni nada del usuario tocan la fila — minimización.
    expect(JSON.stringify(eventos[0])).not.toContain('u-1');
  });

  it('sin sesión no hay tenant que anotar → 204 sin escribir', async () => {
    sesion = null;
    expect((await POST(pedir({ ruta: '/dashboard/viajes' }))).status).toBe(204);
    expect(eventos).toHaveLength(0);
  });

  it('sesión sin tenant (fila de app_user ilegible) → se descarta, no se inventa un tenant', async () => {
    sesion = { userId: 'u-1', tenantId: null, rol: 'flota_admin' };
    await POST(pedir({ ruta: '/dashboard/viajes' }));
    expect(eventos).toHaveLength(0);
  });

  it('el superadmin en preview NO cuenta: mediría a quien mira, no a la flota que usa', async () => {
    sesion = { userId: 'u-sa', tenantId: 't-1', rol: 'superadmin' };
    await POST(pedir({ ruta: '/dashboard/viajes' }));
    expect(eventos).toHaveLength(0);
  });

  it('ruta fuera del catálogo → 204 sin escribir (nada crudo llega al tablero)', async () => {
    await POST(pedir({ ruta: '/dashboard/lo-que-sea' }));
    await POST(pedir({ ruta: '/admin/flotas' }));
    await POST(pedir({ ruta: 42 }));
    expect(eventos).toHaveLength(0);
  });

  it('la subruta cuenta como su pantalla y el detalle de liquidación no guarda el uuid', async () => {
    await POST(pedir({ ruta: '/dashboard/viajes/9c1b2f00-aaaa-bbbb-cccc-000000000001' }));
    await POST(pedir({ ruta: '/dashboard/9c1b2f00-aaaa-bbbb-cccc-000000000001' }));
    expect(eventos.map((e) => e.pantalla)).toEqual(['viajes', 'liquidacion']);
    expect(JSON.stringify(eventos)).not.toContain('9c1b2f00');
  });

  it('límite de tasa o cuerpo roto → 204 sin escribir, jamás un error al panel', async () => {
    limiteOk = false;
    expect((await POST(pedir({ ruta: '/dashboard/viajes' }))).status).toBe(204);
    limiteOk = true;
    const roto = new Request('https://x/api/dashboard/evento', { method: 'POST', body: '{{{' });
    expect((await POST(roto)).status).toBe(204);
    expect(eventos).toHaveLength(0);
  });
});
