#!/usr/bin/env node
/**
 * Smoke de navegador sin credenciales: solo rutas públicas y señales de
 * render/hidratación. La suite no crea usuarios, no toca Supabase y no llama
 * proveedores externos.
 */
import chromiumBinary from '@sparticuz/chromium';
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { validateBrowserCookie, validateLanding } from './production-candidate.mjs';

const base = (process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const routes = ['/', '/terminos', '/privacidad'];
const browserPath = await chromiumBinary.executablePath();
const browser = await chromium.launch({
  executablePath: browserPath,
  args: chromiumBinary.args,
  headless: true,
});

try {
  if (process.env.PLAYWRIGHT_PROTECTION_COOKIE) {
    const cookie = validateBrowserCookie(JSON.parse(readFileSync(process.env.PLAYWRIGHT_PROTECTION_COOKIE, 'utf8')), base); // eslint-disable-line security/detect-non-literal-fs-filename -- archivo0600 propio del wrapper de CI; nunca un path recibido por la app.
    const context = await browser.newContext();
    await context.addCookies([cookie]);
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (!['GET', 'HEAD'].includes(request.method())
        || (request.isNavigationRequest() && new URL(request.url()).origin !== new URL(base).origin)) await route.abort();
      else await route.continue();
    });
  }
  const page = browser.contexts().length ? await browser.contexts()[0].newPage() : await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  for (const route of routes) {
    const response = await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!response || !response.ok()) throw new Error(`${route}: HTTP ${response?.status() ?? 'sin respuesta'}`);
    const text = await page.locator('body').innerText();
    validateLanding(page.url(), base, text);
    if (text.trim().length < 20) throw new Error(`${route}: body vacío o sin contenido útil`);
    if (await page.locator('[data-nextjs-dialog], .next-error-h1, #webpack-dev-server-client-overlay').count()) {
      throw new Error(`${route}: overlay de error detectado`);
    }
  }

  if (consoleErrors.length || pageErrors.length) {
    throw new Error(JSON.stringify({ consoleErrors, pageErrors }));
  }
  console.log(`Playwright smoke OK: ${routes.length} rutas públicas, sin secretos, sin errores de consola.`);
} finally {
  await browser.close();
}
