import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// La ruta de export del XML de Carta Porte (Fase D) con las MISMAS anclas que
// rutas_export.test.ts fijó tras la auditoría 18 (A21): la puerta del dato
// (área operacion vía puedeVerRuta, con el módulo REAL de visibilidad), la
// del verbo (puedeExportar REAL), y la consulta acotada al tenant. Lo que se
// dobla es la base, la sesión y el lector del borrador.
// ═══════════════════════════════════════════════════════════════════════════

let tenant: { ok: true; tenantId: string; rol: string } | { ok: false; status: 401 | 403 | 503; motivo: string } =
  { ok: true, tenantId: 't-1', rol: 'flota_admin' };
vi.mock('@/lib/auth/tenant-api', () => ({ resolverTenantApi: async () => tenant }));
vi.mock('@/lib/ratelimit', () => ({ rateLimit: async () => true, clientIp: () => '1.2.3.4' }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth/session', () => ({ getSessionTenant: async () => ({ userId: 'u-9' }) }));
vi.mock('@/lib/likida/presupuesto', () => ({ acotada: async (p: unknown) => p }));

// El lector del borrador y el generador: la ruta se prueba como PUERTA — el
// generador tiene su propia suite (carta_porte_xml.test.ts).
let viaje: unknown = null;
vi.mock('@/lib/likida/carta_porte_datos', () => ({ getBorradorViaje: async () => viaje }));
let resultadoXml: { ok: true; xml: string; nombreArchivo: string; idCcp: string; omitidos: string[] } | { ok: false; motivos: string[] } =
  { ok: true, xml: '<xml/>', nombreArchivo: 'carta-porte-F1.xml', idCcp: 'CCC0', omitidos: [] };
vi.mock('@/lib/likida/carta_porte_xml', () => ({ generarXmlCcp: () => resultadoXml }));

// La base: registra el UPDATE del sello y sus filtros.
const filtros: Array<[string, unknown]> = [];
let selloError: { message: string } | null = null;
const update = vi.fn();
function builder() {
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    update: (v: unknown) => { update(v); return b; },
    eq: (c: string, v: unknown) => { filtros.push([c, v]); return b; },
    then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve({ data: null, error: selloError }).then(res, rej),
  });
  return b;
}
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: () => builder() }) }));

const { GET } = await import('./route');
const URL_OK = 'https://x/api/export/carta-porte-xml?viaje=11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  tenant = { ok: true, tenantId: 't-1', rol: 'flota_admin' };
  viaje = { viajeId: 'v-1' };
  resultadoXml = { ok: true, xml: '<xml/>', nombreArchivo: 'carta-porte-F1.xml', idCcp: 'CCC0', omitidos: [] };
  selloError = null;
  filtros.length = 0;
  update.mockClear();
});

describe('GET /api/export/carta-porte-xml', () => {
  it('un operador NO baja el XML (área operacion lo permite a flota_admin/encargado, no al chofer)', async () => {
    tenant = { ok: true, tenantId: 't-1', rol: 'operador' };
    expect((await GET(new Request(URL_OK))).status).toBe(403);
  });

  it('un contador NO lo baja: exporta, pero no ve el área operacion', async () => {
    tenant = { ok: true, tenantId: 't-1', rol: 'contador' };
    expect((await GET(new Request(URL_OK))).status).toBe(403);
  });

  it('sin ?viaje= es 400; viaje de otra flota (lector devuelve null) es 404', async () => {
    expect((await GET(new Request('https://x/api/export/carta-porte-xml'))).status).toBe(400);
    viaje = null;
    expect((await GET(new Request(URL_OK))).status).toBe(404);
  });

  it('borrador que no genera = 409 con los motivos, sin sello', async () => {
    resultadoXml = { ok: false, motivos: ['Falta el peso.'] };
    const r = await GET(new Request(URL_OK));
    expect(r.status).toBe(409);
    expect(await r.text()).toContain('Falta el peso.');
    expect(update).not.toHaveBeenCalled();
  });

  it('éxito: XML como descarga, y el sello acotado al tenant con quién y cuándo', async () => {
    const r = await GET(new Request(URL_OK));
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Type')).toContain('application/xml');
    expect(r.headers.get('Content-Disposition')).toContain('carta-porte-F1.xml');
    // El XML es de un viaje/tenant concreto: un caché intermedio no debe
    // reutilizarlo para otra sesión.
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(await r.text()).toBe('<xml/>');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ ccp_xml_generado_por: 'u-9' }));
    expect(filtros).toContainEqual(['tenant_id', 't-1']);
    expect(filtros).toContainEqual(['id', '11111111-2222-4333-8444-555555555555']);
  });

  it('el sello caído NO le niega el archivo a la flota', async () => {
    selloError = { message: 'se cayó' };
    const r = await GET(new Request(URL_OK));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('<xml/>');
  });
});
