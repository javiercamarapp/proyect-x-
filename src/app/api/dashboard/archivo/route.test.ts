import { describe, it, expect, vi, beforeEach } from 'vitest';
import { peticionStream } from '@/lib/pruebas/peticion_stream';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA PROD (22-ago-2026) · ESC-14 — 16 MB prometidos contra 4.5 reales.
//
// El lector de archivos del chat aceptaba ~12 MB (16 MB en base64). El cuerpo
// de una función serverless de Vercel se corta en 4.5 MB, en la plataforma:
// todo lo que pasara de ahí moría con un 413 ajeno, sin nuestro texto y sin
// log, mientras el número de este archivo prometía doce megas. Y el xlsx se
// arma ENTERO en memoria, así que el tope también protege la invocación.
//
// De paso, esta ruta no tenía NINGUNA prueba: la puerta (sesión + área
// dinero) es lo primero que se fija aquí — es alcanzable por POST directo
// porque el proxy no cubre /api.
// ═══════════════════════════════════════════════════════════════════════════

let sesion: { userId: string; tenantId: string | null; rol: string; nombre: string } | null = null;
vi.mock('@/lib/auth/session', () => ({ getSessionTenant: async () => sesion }));
vi.mock('@/lib/auth/visibilidad', () => ({ puedeVerArea: (rol: string) => rol !== 'operador' }));

const leer = vi.fn(async () => ({ clase: 'excel', extracto: 'A1: 100', meta: [] as Array<[string, string]> }));
vi.mock('@/lib/likida/intake/archivo', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, leerArchivoUniversal: (...a: unknown[]) => leer(...(a as [])) };
});
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { POST } = await import('./route');
  const { MAX_BASE64, LECTURAS_POR_MINUTO } = await import('./limites');

function postear(cuerpo: unknown, cabeceras: Record<string, string> = {}) {
  return POST(new Request('https://app.likida.ai/api/dashboard/archivo', {
    method: 'POST', headers: { 'content-type': 'application/json', ...cabeceras }, body: JSON.stringify(cuerpo),
  }) as never);
}

beforeEach(() => {
  sesion = { userId: 'u-1', tenantId: 't-1', rol: 'contador', nombre: 'C' };
  leer.mockClear();
});

it('corta campos ignorados del JSON chunked antes de materializar el cuerpo', async () => {
  sesion = { userId: 'u-stream', tenantId: 't-1', rol: 'contador', nombre: 'C' };
  const p = peticionStream('https://app.likida.ai/api/dashboard/archivo', JSON.stringify({
    nombre: 'a.csv', contenido: 'data:text/csv;base64,QUJD', ignorado: 'x'.repeat(MAX_BASE64 + 200_000),
  }));
  const res = await POST(p.req as never);
  expect(res.status).toBe(413);
  expect(leer).not.toHaveBeenCalled();
  expect(p.estado().cancelado).toBe(true);
  expect(p.estado().leidos).toBeLessThan(p.estado().total);
});

it('JSON null se rechaza con400 sin intentar leer un archivo', async () => {
  expect((await postear(null)).status).toBe(400);
  expect(leer).not.toHaveBeenCalled();
});

describe('la puerta de origen (auditoría 21, BAJO-MEDIO)', () => {
  it('desde otro sitio: 403 y no se lee nada', async () => {
    const r = await postear({ nombre: 'a.csv', contenido: 'x' }, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(leer).not.toHaveBeenCalled();
  });
});

describe('la puerta', () => {
  it('sin sesión: 401 y no se lee nada', async () => {
    sesion = null;
    expect((await postear({ nombre: 'a.csv', contenido: 'x' })).status).toBe(401);
    expect(leer).not.toHaveBeenCalled();
  });

  it('sin área de dinero: 403 — el archivo del contralor trae montos', async () => {
    sesion = { userId: 'u-2', tenantId: 't-1', rol: 'operador', nombre: 'O' };
    expect((await postear({ nombre: 'a.csv', contenido: 'x' })).status).toBe(403);
    expect(leer).not.toHaveBeenCalled();
  });
});

describe('el freno de FRECUENCIA (auditoría 21 — la ruta calcó la autorización de ingesta pero no su rateLimit)', () => {
  // Sin mock del ratelimit a propósito: en pruebas no hay credenciales de
  // Redis y el módulo cae a su Map local — la ráfaga de verdad se topa.
  it(`la petición ${LECTURAS_POR_MINUTO + 1} dentro del minuto: 429 y el archivo NO se parsea`, async () => {
    sesion = { userId: 'u-rafaga', tenantId: 't-1', rol: 'contador', nombre: 'C' };
    for (let i = 0; i < LECTURAS_POR_MINUTO; i++) {
      expect((await postear({ nombre: 'a.csv', contenido: 'data:text/csv;base64,QUJD' })).status).toBe(200);
    }
    const extra = await postear({ nombre: 'a.csv', contenido: 'data:text/csv;base64,QUJD' });
    expect(extra.status).toBe(429);
    expect((await extra.json()).error).toMatch(/demasiadas lecturas/i);
    expect(leer).toHaveBeenCalledTimes(LECTURAS_POR_MINUTO); // la N+1 no llegó al lector
  });
});

describe('el tope cabe DENTRO del límite real de Vercel (ESC-14)', () => {
  const LIMITE_VERCEL = 4.5 * 1024 * 1024;

  it('lo que esta ruta acepta siempre llega a esta ruta', () => {
    expect(MAX_BASE64).toBeLessThan(LIMITE_VERCEL);
    expect(MAX_BASE64).toBeLessThanOrEqual(LIMITE_VERCEL - 400_000);
  });

  it('un archivo por encima del tope: 413, con nuestras palabras y sin armar el xlsx en memoria', async () => {
    const r = await postear({ nombre: 'gordo.xlsx', contenido: `data:application/vnd.ms-excel;base64,${'A'.repeat(MAX_BASE64 + 1)}` });
    expect(r.status).toBe(413);
    expect((await r.json()).error).toMatch(/parte que importa|hoja|rango/i);
    expect(leer).not.toHaveBeenCalled();
  });

  it('CONTROL — uno normal sí se lee', async () => {
    const r = await postear({ nombre: 'chico.csv', contenido: 'data:text/csv;base64,QUJD' });
    expect(r.status).toBe(200);
    expect(leer).toHaveBeenCalled();
  });
});
