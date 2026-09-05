import { describe, it, expect, vi, beforeEach } from 'vitest';
import { peticionStream } from '@/lib/pruebas/peticion_stream';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 21, BAJO-MEDIO — esta ruta no tenía ninguna prueba. Fija la
// puerta de origen (CSRF explícito, SEG-9 generalizado) en POST (sube fotos)
// y PATCH (firma la verdad-de-terreno) — ambas autenticadas solo por cookie.
// ═══════════════════════════════════════════════════════════════════════════

let sesion: { userId: string; tenantId: string | null; rol: string } | null = null;
vi.mock('../puerta', () => ({
  sesionSuperadmin: async () => (sesion
    ? { error: null, sesion }
    : { error: new Response(null, { status: 401 }), sesion: null }),
}));

const subirFotos = vi.fn(async () => ({ ok: true, datos: { fotos: [], resultados: [] } }));
const confirmarVerdadTerreno = vi.fn(async () => ({ ok: true, datos: { path: 'p/1.jpg' } }));
vi.mock('@/lib/admin/qa-storage', () => ({
  leerManifiesto: async () => ({ ok: true, datos: [] }),
  subirFotos: (...a: unknown[]) => subirFotos(...(a as [])),
  firmarRuta: async () => 'https://firmada/1',
  firmarRutas: async () => new Map(),
  confirmarVerdadTerreno: (...a: unknown[]) => confirmarVerdadTerreno(...(a as [])),
  BUCKET_QA_FOTOS: 'qa-fotos',
}));
vi.mock('@/lib/admin/qa-tipos', () => ({
  validarVerdadTerreno: (v: unknown) => ({ ok: true, datos: v }),
}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({}) }));

const { POST, PATCH } = await import('./route');

function postearForm(cabeceras: Record<string, string> = {}) {
  const form = new FormData();
  form.set('archivo', new File(['x'], 'ticket.jpg', { type: 'image/jpeg' }));
  return POST(new Request('https://app.likida.ai/api/admin/qa/fotos', { method: 'POST', headers: cabeceras, body: form }));
}

function patchear(cuerpo: unknown, cabeceras: Record<string, string> = {}) {
  return PATCH(new Request('https://app.likida.ai/api/admin/qa/fotos', {
    method: 'PATCH', headers: { 'content-type': 'application/json', ...cabeceras }, body: JSON.stringify(cuerpo),
  }));
}

const UUID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  sesion = { userId: 'u-1', tenantId: 't-1', rol: 'superadmin' };
  subirFotos.mockClear(); confirmarVerdadTerreno.mockClear();
});

it('cuenta también campos de texto multipart y cancela sin subir fotos', async () => {
  const form = new FormData();
  form.set('texto', 'x'.repeat(4 * 1024 * 1024 + 200_000));
  form.set('archivo', new File(['abc'], 'foto.jpg', { type: 'image/jpeg' }));
  const codificado = new Response(form);
  const bytes = new Uint8Array(await codificado.arrayBuffer());
  let leidos = 0;
  let cancelado = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (leidos === bytes.length) { c.close(); return; }
      const fin = Math.min(leidos + 65_536, bytes.length);
      c.enqueue(bytes.slice(leidos, fin)); leidos = fin;
    }, cancel() { cancelado = true; },
  }, { highWaterMark: 0 });
  const req = new Request('https://app.likida.ai/api/admin/qa/fotos', {
    method: 'POST', headers: codificado.headers, body: stream, duplex: 'half',
  } as RequestInit);
  expect((await POST(req)).status).toBe(413);
  expect(cancelado).toBe(true);
  expect(leidos).toBeLessThan(bytes.length);
  expect(subirFotos).not.toHaveBeenCalled();
});

it('un archivo binario conserva cada byte después del parser multipart', async () => {
  const bytes = new Uint8Array([0, 255, 192, 128, 13, 10, 239, 0]);
  const form = new FormData();
  form.set('archivo', new File([bytes], 'foto.jpg', { type: 'image/jpeg' }));
  expect((await POST(new Request('https://app.likida.ai/api/admin/qa/fotos', {
    method: 'POST', body: form,
  }))).status).toBe(200);
  expect(subirFotos).toHaveBeenCalledWith(expect.anything(), [
    { nombre: 'foto.jpg', mime: 'image/jpeg', bytes: Buffer.from(bytes) },
  ]);
});

it.each([200, 201])('conserva el límite de cantidad: %s archivos', async (cantidad) => {
  const form = new FormData();
  for (let i = 0; i < cantidad; i++) form.append('archivo', new File(['x'], `f${i}.jpg`));
  expect((await POST(new Request('https://app.likida.ai/api/admin/qa/fotos', {
    method: 'POST', body: form,
  }))).status).toBe(cantidad === 200 ? 200 : 413);
  expect(subirFotos).toHaveBeenCalledTimes(cantidad === 200 ? 1 : 0);
});

it('PATCH chunked excesivo no firma verdad de terreno', async () => {
  const p = peticionStream('https://app.likida.ai/api/admin/qa/fotos', JSON.stringify({
    fotoId: UUID, verdad: {}, ignorado: 'x'.repeat(50_000),
  }), 17_000);
  expect((await PATCH(p.req)).status).toBe(413);
  expect(confirmarVerdadTerreno).not.toHaveBeenCalled();
  expect(p.estado().cancelado).toBe(true);
  expect(p.estado().leidos).toBe(17_000);
});

describe('POST — la puerta de origen (auditoría 21, BAJO-MEDIO)', () => {
  it('desde otro sitio: 403 y nada se sube', async () => {
    const r = await postearForm({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(subirFotos).not.toHaveBeenCalled();
  });

  it('desde el panel (same-origin) sí sube', async () => {
    const r = await postearForm({ 'sec-fetch-site': 'same-origin' });
    expect(r.status).toBe(200);
    expect(subirFotos).toHaveBeenCalledTimes(1);
  });
});

describe('PATCH — la puerta de origen (auditoría 21, BAJO-MEDIO)', () => {
  it('desde otro sitio: 403 y no se firma nada', async () => {
    const r = await patchear({ fotoId: UUID, verdad: {} }, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(confirmarVerdadTerreno).not.toHaveBeenCalled();
  });

  it('desde el panel (same-origin) sí firma', async () => {
    const r = await patchear({ fotoId: UUID, verdad: {} }, { 'sec-fetch-site': 'same-origin' });
    expect(r.status).toBe(200);
    expect(confirmarVerdadTerreno).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24, BE-25 — el rótulo prometía 120 MB por lote sobre un runtime
// que corta el cuerpo en 4.5 MB ANTES de que la ruta exista: el lote moría con
// el 413 de la plataforma, sin nuestro texto y sin una línea de log. Un número
// que la plataforma no respeta no es un tope, es una promesa falsa.
// ═══════════════════════════════════════════════════════════════════════════
describe('BE-25 — el tope del lote es el que la plataforma respeta', () => {
  it('REPRO: un lote que declara 8 MB se rechaza con NUESTRO texto, sin leerlo', async () => {
    const form = new FormData();
    form.set('archivo', new File(['x'], 'ticket.jpg', { type: 'image/jpeg' }));
    const r = await POST(new Request('https://app.likida.ai/api/admin/qa/fotos', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-length': String(8 * 1024 * 1024) },
      body: form,
    }));

    expect(r.status).toBe(413);
    const j = await r.json() as { error: string };
    expect(j.error).toContain('4 MB');
    expect(j.error).not.toContain('120');
    expect(subirFotos).not.toHaveBeenCalled();
  });

  it('un lote normal sigue pasando', async () => {
    expect((await postearForm({ 'sec-fetch-site': 'same-origin' })).status).toBe(200);
  });
});
