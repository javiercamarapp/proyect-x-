import { test, expect } from './apoyo/fixture';
import { ESTADOS } from './apoyo/sesion';
import { writeFile } from 'node:fs/promises';
import type { TestInfo } from '@playwright/test';

async function guardar(info: TestInfo, nombre: string, datos: object) {
  const archivo = info.outputPath(`${nombre}.json`);
  // Ruta generada por Playwright dentro de su directorio de artefactos, sin entrada del usuario.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await writeFile(archivo, JSON.stringify(datos, null, 2));
  await info.attach(nombre, { path: archivo, contentType: 'application/json' });
}

function evidencia(r: { status(): number; headers(): Record<string, string> }) {
  const h = r.headers();
  return { status: r.status(), cacheControl: h['cache-control'] ?? null, vary: h.vary ?? null, age: h.age ?? null, contentType: h['content-type'] ?? null };
}
for (const [rol, ruta, privado] of [
  ['duena', '/dashboard', 'Dueña E2E'],
  ['superadmin', '/admin', 'Consola de Likida'],
  ['vendedor', '/vendedor', 'Cartera propia E2E'],
] as const) {
  test.describe(`caché privada ${ruta}`, () => {
    test.use({ storageState: ESTADOS[rol] });
    test('contenido autenticado no se reutiliza en la respuesta anónima', async ({ page, browser }, info) => {
      const r = await page.request.get(ruta, { maxRedirects: 0 });
      expect(r.status()).toBe(200);
      expect(await r.text()).toContain(privado);
      // no-store prohíbe almacenar tanto a cachés privadas como compartidas.
      expect(r.headers()['cache-control']).toMatch(/no-store/);
      const anonimo = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      try {
        const anon = await anonimo.request.get(ruta, { maxRedirects: 0 });
        expect([302, 303, 307, 308]).toContain(anon.status());
        expect(anon.headers().location).toContain('/login');
        expect(await anon.text()).not.toContain(privado);
        await guardar(info, 'cache-observada', { ruta, autenticada: evidencia(r), anonima: evidencia(anon) });
      } finally { await anonimo.close(); }
    });
  });
}

test.describe('caché de PDF financiero privado', () => {
  test.use({ storageState: ESTADOS.duena });
  test('la puerta autenticada y la descarga conservan sus headers observables', async ({ page, browser }, info) => {
    await page.goto('/dashboard/viajes?f=liquidados');
    await page.locator('tr', { hasText: 'VJ-2026-0844' }).getByRole('link', { name: /Ver/ }).click();
    const enlace = page.locator('a', { hasText: 'Descargar PDF' });
    await expect(enlace).toBeVisible();
    const href = await enlace.getAttribute('href');
    expect(href).toMatch(/^\/api\/export\/pdf\//);
    const r = await page.request.get(href!, { maxRedirects: 0 });
    expect(r.status()).toBe(302);
    const url = new URL(r.headers().location);
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(url.hostname);
    const objeto = await page.request.get(url.href, { maxRedirects: 0 });
    expect(objeto.status()).toBe(200);
    expect((await objeto.body()).subarray(0, 5).toString()).toBe('%PDF-');
    const anonimo = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const anon = await anonimo.request.get(href!, { maxRedirects: 0 });
      expect(anon.status()).toBe(401);
      await guardar(info, 'cache-pdf-observada', { puerta: evidencia(r), objetoFirmado: evidencia(objeto), anonima: evidencia(anon) });
    } finally { await anonimo.close(); }
  });
});
