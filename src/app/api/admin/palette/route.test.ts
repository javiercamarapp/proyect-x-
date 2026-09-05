import { peticionStream } from '@/lib/pruebas/peticion_stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// EL BACKEND DEL ⌘K — y por qué estrena pruebas hoy.
//
// AUDITORÍA PROD (22-ago-2026) · SEG-9. Este POST APAGA INTERRUPTORES: el kill
// switch global, el de WhatsApp, el de facturación. Se autentica con la
// cookie de sesión y no miraba de dónde venía la petición, así que una página
// cualquiera abierta en el navegador de Javier podía pedirle al navegador que
// apagara el sistema en su nombre (`sameSite: lax` lo mitiga; no lo decide
// esta app). La ruta no tenía ni una prueba: se fija la puerta entera.
// ═══════════════════════════════════════════════════════════════════════════

let sesion: { userId: string; tenantId: string | null; rol: string; nombre: string } | null = null;
vi.mock('@/lib/auth/session', () => ({ getSessionTenant: async () => sesion }));

const apagar = vi.fn(async (_id: string, _motivo: string, _quien: string) => { void _id; void _motivo; void _quien; });
const encender = vi.fn(async (_id: string, _quien: string) => { void _id; void _quien; });
vi.mock('@/lib/likida/interruptores', () => ({
  listarInterruptores: async () => [{ id: 'global', apagado: false, motivo: null }],
  apagar: (i: string, m: string, q: string) => apagar(i, m, q),
  encender: (i: string, q: string) => encender(i, q),
}));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => ({ select: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
  }),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// SEC-1 / RT-1 (auditoría 25, re-auditoría): `mfaSuperadminObligatorio` se
// deja REAL (lee el env, igual que `api-superadmin.test.ts`) para que la
// palanca sea la que se prueba; solo `veredictoMfaSuperadmin` se mockea.
const veredictoMfa = vi.fn(async (): Promise<string> => 'ok');
vi.mock('@/lib/auth/mfa', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  veredictoMfaSuperadmin: () => veredictoMfa(),
}));
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: async () => ({}) }));

const { POST, GET } = await import('./route');

const apagarGlobal = (cabeceras: Record<string, string>) =>
  POST(new Request('https://app.likida.ai/api/admin/palette', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'app.likida.ai', ...cabeceras },
    body: JSON.stringify({ operacion: 'apagar', id: 'global', motivo: 'prueba' }),
  }));

beforeEach(() => {
  sesion = { userId: 'u-javier', tenantId: 't-1', rol: 'superadmin', nombre: 'Javier' };
  apagar.mockClear(); encender.mockClear();
  veredictoMfa.mockReset();
  veredictoMfa.mockResolvedValue('ok');
  vi.unstubAllEnvs();
});

describe('la puerta de origen (SEG-9)', () => {
  it('desde otro sitio: 403 y NINGÚN interruptor se toca', async () => {
    const r = await apagarGlobal({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(apagar).not.toHaveBeenCalled();
  });

  it('y se contesta 403 sin mirar siquiera si el usuario es superadmin', async () => {
    // Que la respuesta no dependa de la sesión es lo que evita usar esta ruta
    // como oráculo de "¿este navegador tiene sesión de superadmin?".
    sesion = null;
    const conSesion = await apagarGlobal({ 'sec-fetch-site': 'cross-site' });
    sesion = { userId: 'u', tenantId: 't', rol: 'superadmin', nombre: 'J' };
    const sinSesion = await apagarGlobal({ 'sec-fetch-site': 'cross-site' });
    expect(conSesion.status).toBe(sinSesion.status);
  });

  it('desde el panel (same-origin) sí apaga', async () => {
    const r = await apagarGlobal({ 'sec-fetch-site': 'same-origin' });
    expect(r.status).toBe(200);
    expect(apagar).toHaveBeenCalledWith('global', 'prueba', 'u-javier');
  });
});

describe('la puerta de rol sigue en pie', () => {
  it('sin sesión: 401', async () => {
    sesion = null;
    expect((await apagarGlobal({ 'sec-fetch-site': 'same-origin' })).status).toBe(401);
    expect(apagar).not.toHaveBeenCalled();
  });

  it('con sesión de otro rol: 403 — /api no pasa por el layout de /admin', async () => {
    sesion = { userId: 'u-2', tenantId: 't-1', rol: 'flota_admin', nombre: 'Contralor' };
    expect((await apagarGlobal({ 'sec-fetch-site': 'same-origin' })).status).toBe(403);
    expect(apagar).not.toHaveBeenCalled();
  });

  it.each(['inscribir', 'retar', 'no_verificable'] as const)(
    'superadmin con MFA obligatorio y veredicto %s: 403 y cero mutaciones',
    async (resultado) => {
      vi.stubEnv('LIKIDA_SUPERADMIN_MFA', 'obligatorio');
      veredictoMfa.mockResolvedValue(resultado);
      expect((await apagarGlobal({ 'sec-fetch-site': 'same-origin' })).status).toBe(403);
      expect(apagar).not.toHaveBeenCalled();
      expect(encender).not.toHaveBeenCalled();
    },
  );
});

describe('cuerpo acotado durante lectura', () => {
 it('cancela el exceso sin efectos', async()=>{
  const p=peticionStream('https://app.likida.ai/api/admin/palette',JSON.stringify({...{ operacion:'apagar',id:'global',motivo:'prueba' },ignorado:'x'.repeat(32768)}),8192);
  expect((await POST(p.req)).status).toBe(413);
  expect(p.estado().cancelado).toBe(true);expect(p.estado().leidos).toBeLessThan(p.estado().total);
  expect(apagar).not.toHaveBeenCalled();expect(encender).not.toHaveBeenCalled();
 });
 it.each([null, [], 'texto', 42].map((valor) => [valor]))('rechaza cuerpo no objeto %j antes de efectos', async(cuerpo)=>{
  const p=peticionStream('https://app.likida.ai/api/admin/palette',JSON.stringify(cuerpo));
  expect((await POST(p.req)).status).toBe(400);expect(apagar).not.toHaveBeenCalled();expect(encender).not.toHaveBeenCalled();
 });
});

it.each([{operacion:'apagar',id:['global']},{operacion:'apagar',id:'global',motivo:42}])('tipos inválidos no cambian interruptores %j',async(cuerpo)=>{
 const p=peticionStream('https://app.likida.ai/api/admin/palette',JSON.stringify(cuerpo));
 expect((await POST(p.req)).status).toBe(400);expect(apagar).not.toHaveBeenCalled();expect(encender).not.toHaveBeenCalled();
});

// ═══════════════════════════════════════════════════════════════════════════
// SEC-1 / RT-1 (auditoría 25, SEGURIDAD, re-auditoría, encontrado dos veces).
// Esta ruta traía su PROPIA copia local de `sesionSuperadmin()` que solo
// comprobaba `rol === 'superadmin'`, sin preguntar por `veredictoMfaSuperadmin`
// — el mismo hueco que esta ronda ya cerró en mapa-prospectos/puerta.ts,
// qa/puerta.ts y copiloto/puerta.ts consolidándolos en
// `@/lib/auth/api-superadmin`. Una cookie de superadmin phishada (sin el
// segundo factor) seguía pudiendo apagar el kill switch global, WhatsApp o
// facturación con solo el POST same-origin.
// ═══════════════════════════════════════════════════════════════════════════
describe('SEC-1 / RT-1: el segundo factor gatea el palette también', () => {
  it('GET: palanca puesta, veredicto no ok: 403 — ni interruptores ni flotas se enseñan', async () => {
    vi.stubEnv('LIKIDA_SUPERADMIN_MFA', 'obligatorio');
    veredictoMfa.mockResolvedValue('retar');
    const r = await GET();
    expect(r.status).toBe(403);
  });

  it.each(['inscribir', 'retar', 'no_verificable'])(
    'POST: palanca puesta, veredicto %s: 403 y NINGÚN interruptor se toca',
    async (veredicto) => {
      vi.stubEnv('LIKIDA_SUPERADMIN_MFA', 'obligatorio');
      veredictoMfa.mockResolvedValue(veredicto);
      const r = await apagarGlobal({ 'sec-fetch-site': 'same-origin' });
      expect(r.status).toBe(403);
      expect(apagar).not.toHaveBeenCalled();
    });

  it('POST: palanca puesta, veredicto ok: sí apaga', async () => {
    vi.stubEnv('LIKIDA_SUPERADMIN_MFA', 'obligatorio');
    veredictoMfa.mockResolvedValue('ok');
    const r = await apagarGlobal({ 'sec-fetch-site': 'same-origin' });
    expect(r.status).toBe(200);
    expect(apagar).toHaveBeenCalledWith('global', 'prueba', 'u-javier');
  });

  it('palanca APAGADA (default): entra sin preguntar por el factor', async () => {
    const r = await apagarGlobal({ 'sec-fetch-site': 'same-origin' });
    expect(r.status).toBe(200);
    expect(veredictoMfa).not.toHaveBeenCalled();
  });
});
