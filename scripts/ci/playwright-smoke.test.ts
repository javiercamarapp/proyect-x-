import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const doubles = vi.hoisted(() => {
  const page = { on: vi.fn(), goto: vi.fn(), url: vi.fn(), locator: vi.fn() };
  const context = { addCookies: vi.fn(), route: vi.fn(), newPage: vi.fn(async () => page) };
  return { page, context, browser: { newContext: vi.fn(async () => context), contexts: vi.fn(), newPage: vi.fn(async () => page), close: vi.fn() } };
});
vi.mock('@sparticuz/chromium', () => ({ default: { executablePath: async () => '/synthetic-browser', args: [] } }));
vi.mock('playwright-core', () => ({ chromium: { launch: async () => doubles.browser } }));

describe('smoke ejecutable sin red ni navegador externo', () => {
  let dir: string;
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'likida-smoke-test-'));
    vi.stubEnv('PLAYWRIGHT_BASE_URL', 'http://127.0.0.1:3000');
    vi.stubEnv('PLAYWRIGHT_PROTECTION_COOKIE', '');
    doubles.page.goto.mockResolvedValue({ ok: () => true, status: () => 200 });
    doubles.page.url.mockReturnValue('http://127.0.0.1:3000');
    doubles.page.locator.mockReturnValue({ innerText: async () => 'Contenido público válido para el smoke', count: async () => 0 });
    doubles.browser.contexts.mockReturnValue([]);
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
  it('conserva las tres rutas locales sin cookie', async () => {
    await import('./playwright-smoke.mjs');
    expect(doubles.page.goto).toHaveBeenCalledTimes(3);
    expect(doubles.context.addCookies).not.toHaveBeenCalled();
    expect(doubles.browser.close).toHaveBeenCalled();
  });
  it('carga el archivo privado y limita cookie/navegación al host candidato', async () => {
    const base = 'https://candidate.vercel.app';
    const cookie = { name: '__vercel_live_token', value: 'synthetic', url: base, secure: true, httpOnly: true, sameSite: 'Lax' };
    const path = join(dir, 'cookie.json');
    writeFileSync(path, JSON.stringify(cookie), { mode: 0o600 }); // eslint-disable-line security/detect-non-literal-fs-filename -- fixture propio en mkdtemp, cleanup en afterEach.
    vi.stubEnv('PLAYWRIGHT_BASE_URL', base); vi.stubEnv('PLAYWRIGHT_PROTECTION_COOKIE', path);
    doubles.page.url.mockReturnValue(base); doubles.browser.contexts.mockReturnValue([doubles.context]);
    await import('./playwright-smoke.mjs');
    expect(doubles.context.addCookies).toHaveBeenCalledWith([cookie]);
    const intercept = doubles.context.route.mock.calls[0][1];
    for (const [method, url] of [['POST', base], ['GET', 'https://external.test']]) {
      const abort = vi.fn();
      await intercept({ request: () => ({ method: () => method, url: () => url, isNavigationRequest: () => true }), abort });
      expect(abort).toHaveBeenCalled();
    }
  });
  it('rechaza una puerta de autenticación aunque responda200', async () => {
    doubles.page.locator.mockReturnValue({ innerText: async () => 'Authentication Required: Log in to Vercel', count: async () => 0 });
    await expect(import('./playwright-smoke.mjs')).rejects.toThrow('Deployment Protection');
    expect(doubles.browser.close).toHaveBeenCalled();
  });
});
