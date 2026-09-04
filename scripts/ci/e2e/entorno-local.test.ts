import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

// Ejecuta sólo descubrimiento: ninguna prueba ni servidor se inicia.
describe('Playwright rehúsa destinos externos antes de cargar las pruebas', () => {
  for (const variable of ['PLAYWRIGHT_BASE_URL', 'SUPABASE_URL', 'MAILPIT_URL']) {
    it(`${variable} remoto queda rechazado sin navegación`, () => {
      const r = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--list', '--reporter=list'], {
        env: { ...process.env, PLAYWRIGHT_BASE_URL: 'http://localhost:3000', SUPABASE_URL: 'http://127.0.0.1:54321', MAILPIT_URL: 'http://127.0.0.1:54324', [variable]: 'https://externo.example' },
        encoding: 'utf8', timeout: 15000,
      });
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toContain('E2E_LOCAL_REQUERIDO');
    });
  }
});

import { exigirUrlLocal, enlaceLocalE2E } from './entorno-local.mjs';

describe('frontera de URLs locales', () => {
  it.each(['http://localhost:3000', 'http://127.0.0.1:54321', 'http://[::1]:54324'])('admite loopback %s', (url) => {
    expect(exigirUrlLocal(url, 'prueba')).toBe(new URL(url).origin);
  });
  it.each(['https://externo.example', 'http://localhost.evil.test', 'http://localhost@externo.example', 'http://usuario:secreto@localhost:3000', 'https://localhost:3000', 'file:///tmp/prueba', 'http://localhost:3000/ruta', 'http://localhost:3000?destino=x', ''])('rechaza destino no permitido %s', (url) => {
    expect(() => exigirUrlLocal(url, 'prueba')).toThrow('E2E_LOCAL_REQUERIDO');
  });
  it('no incluye credenciales en el error', () => {
    try { exigirUrlLocal('http://usuario:secreto@localhost:3000', 'prueba'); } catch (e) {
      expect(String(e)).not.toContain('secreto');
    }
  });
  it('valida el destino y retorno del magic link antes de navegar', () => {
    expect(() => enlaceLocalE2E('https://externo.example/auth/v1/verify?token=x')).toThrow('E2E_LOCAL_REQUERIDO');
    expect(() => enlaceLocalE2E('http://127.0.0.1:54321/auth/v1/verify?redirect_to=https%3A%2F%2Fexterno.example')).toThrow('E2E_LOCAL_REQUERIDO');
    const enlace = 'http://127.0.0.1:54321/auth/v1/verify?token=x&redirect_to=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fcallback';
    expect(enlaceLocalE2E(enlace)).toBe(enlace);
  });
});

import * as guard from './entorno-local.mjs';
import { vi } from 'vitest';

it('el cliente de seed prohíbe redirects aunque el llamador pida follow', async () => {
  const transporte = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', transporte);
  try {
    await guard.fetchLocalE2E('http://127.0.0.1:55321/rest/v1/tenant', { redirect: 'follow', headers: { apikey: 'sintetica' } });
    expect(transporte).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ redirect: 'error' }));
    await expect(guard.fetchLocalE2E('https://externo.example', {})).rejects.toThrow('E2E_LOCAL_REQUERIDO');
    expect(transporte).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});

it('la descarga PDF no sigue Location externo ni repite headers contra ese origen', async () => {
  const get = vi.fn(async () => ({ status: () => 302, headers: () => ({ location: 'https://externo.example/documento' }) }));
  await expect(guard.getLocalE2E({ get }, 'http://localhost:3300/api/export/pdf/id')).rejects.toThrow('E2E_LOCAL_REQUERIDO');
  expect(get).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledWith(expect.any(String), { maxRedirects: 0 });
});
