import { test, expect, type Page } from './apoyo/fixture';
import { ESTADOS } from './apoyo/sesion';
import { getLocalE2E } from '../scripts/ci/e2e/entorno-local.mjs';

const AJENO = '22222222-eeee-4eee-8eee-222222222222';
async function paginaSana(page: Page, ruta: string, texto: string) {
  const errores: string[] = [];
  page.on('pageerror', (e) => errores.push(e.message));
  const respuesta = await page.goto(ruta);
  expect(respuesta?.status()).toBe(200);
  await expect(page).toHaveURL(ruta);
  await expect(page.locator('body')).toContainText(texto);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'No se pudo cargar el panel.' })).toHaveCount(0);
  await expect(page.locator('[data-nextjs-dialog], .next-error-h1')).toHaveCount(0);
  expect(errores).toEqual([]);
}

test.describe('encargado: operación sin cifras ni administración', () => {
  test.use({ storageState: ESTADOS.encargado });
  test('registro real, dinero omitido y navegación al despacho', async ({ page, browser }) => {
    await paginaSana(page, '/dashboard/viajes', 'VJ-2026-0001');
    expect(await page.content()).not.toMatch(/10,600|\\"anticipo\\":10600/);
    await expect(page.locator('body')).not.toContainText('10,600');
    await expect(page.getByRole('columnheader', { name: /Anticipo/i })).toHaveCount(0);
    await page.locator('a[href="/dashboard/despacho"]').first().click();
    await expect(page).toHaveURL(/\/dashboard\/despacho$/);
    await expect(page.getByRole('button', { name: 'Crear viaje', exact: true })).toBeVisible();
    await expect(page.locator('#anticipo')).toHaveCount(0);
    const propietario = await browser.newContext({ storageState: ESTADOS.duena });
    try {
      const control = await propietario.request.get('/dashboard/viajes?_rsc', { headers: { RSC: '1' }, maxRedirects: 0 });
      expect(control.status()).toBe(200);
      expect(await control.text(), 'control positivo: el dueño sí recibe el anticipo sembrado').toMatch(/\b10600\b|10,600/);
    } finally { await propietario.close(); }
    for (const ruta of ['/dashboard/despacho', '/dashboard/viajes']) {
      const documento = await page.request.get(ruta, { maxRedirects: 0 });
      expect(documento.status()).toBe(200);
      const html = await documento.text();
      expect(html).toContain('VJ-2026-0001');
      expect(html, `${ruta}: documento no debe transportar el anticipo canario`).not.toMatch(/\b10600\b|10,600/);
      const rsc = await page.request.get(`${ruta}?_rsc`, { headers: { RSC: '1' }, maxRedirects: 0 });
      expect(rsc.status()).toBe(200);
      expect(rsc.headers()['content-type']).toContain('text/x-component');
      const trama = await rsc.text();
      expect(trama).toContain('VJ-2026-0001');
      expect(trama, `${ruta}: Flight no debe transportar el anticipo canario`).not.toMatch(/\b10600\b|10,600/);
    }
    await page.screenshot({ path: 'pruebas-navegador/.artefactos/encargado-despacho.png', fullPage: true });
  });
  for (const ruta of ['/dashboard/contador', '/dashboard/rentabilidad', '/dashboard/usuarios', '/admin', '/vendedor']) {
    test(`niega URL directa ${ruta} incluso con rol manipulado`, async ({ page }) => {
      await page.goto(`${ruta}?rol=flota_admin&tenant=${AJENO}`);
      await expect(page).toHaveURL(/\/dashboard$/);
      await expect(page.locator('body')).not.toContainText('Consola de Likida');
    });
  }
  test('exports financieros niegan acceso por API', async ({ page }) => {
    for (const ruta of ['/api/export/liquidaciones', '/api/export/poliza', '/api/export/pdf/00000000-0000-4000-8000-000000000001']) {
      const r = await getLocalE2E(page.request, ruta);
      expect(r.status(), ruta).toBe(403);
    }
  });
});

test.describe('contador: dinero sin despacho ni administración', () => {
  test.use({ storageState: ESTADOS.contador });
  test('abre resumen fiscal y navega a facturación', async ({ page }) => {
    const errores: string[] = [];
    page.on('pageerror', (e) => errores.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });
    await paginaSana(page, '/dashboard/contador', 'Contador E2E');
    await expect(page.locator('a[href="/dashboard/despacho"]')).toHaveCount(0);
    await page.locator('a[href="/dashboard/facturacion"]').first().click();
    await expect(page).toHaveURL(/\/dashboard\/facturacion$/);
    await expect(page.locator('body')).toContainText('Facturación');
    await page.waitForLoadState('networkidle');
    await page.locator('summary').filter({ hasText: 'Pactos de detención' }).click();
    await expect(page.getByRole('button', { name: 'Guardar pacto de flota', exact: true })).toBeVisible();
    const pacto = page.locator('form').filter({ has: page.getByRole('button', { name: 'Guardar pacto de flota', exact: true }) });
    await pacto.locator('input[name="horasLibres"]').fill('-1');
    await pacto.evaluate((f) => { (f as HTMLFormElement).noValidate = true; });
    const respuesta = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/dashboard/facturacion');
    await pacto.getByRole('button', { name: 'Guardar pacto de flota', exact: true }).click();
    expect((await respuesta).status()).toBe(200);
    await expect(pacto).toContainText('Las horas libres deben ser un número entre 0 y 240');
    await expect(page.getByRole('heading', { name: 'No se pudo cargar el panel.' })).toHaveCount(0);
    await expect(pacto.getByRole('button', { name: 'Guardar pacto de flota', exact: true })).toBeEnabled();
    expect(errores, 'facturación debe hidratar completa, incluidas sus acciones').toEqual([]);
    await page.screenshot({ path: 'pruebas-navegador/.artefactos/contador-facturacion.png', fullPage: true });
  });
  test('descarga el PDF financiero de su propia flota', async ({ page, browser }) => {
    // Descubrir la URL con el recorrido del dueño; pedir los mismos bytes
    // con la sesión independiente del contador, sin sembrar sus cookies.
    const duena = await browser.newContext({ storageState: ESTADOS.duena });
    try {
      const panel = await duena.newPage();
      await panel.goto('/dashboard/viajes?f=liquidados');
      await panel.locator('tr', { hasText: 'VJ-2026-0844' }).getByRole('link', { name: /Ver/ }).click();
      const pdf = panel.locator('a', { hasText: 'Descargar PDF' });
      await expect(pdf).toBeVisible();
      const href = await pdf.getAttribute('href');
      expect(href).toMatch(/^\/api\/export\/pdf\//);
      const r = await getLocalE2E(page.request, href!);
      expect(r.status()).toBe(200);
      expect((await r.body()).subarray(0, 5).toString()).toBe('%PDF-');
    } finally { await duena.close(); }
  });
  for (const ruta of ['/dashboard/despacho', '/dashboard/viajes', '/dashboard/usuarios', '/admin', '/vendedor']) {
    test(`niega URL directa ${ruta} incluso con rol manipulado`, async ({ page }) => {
      await page.goto(`${ruta}?rol=flota_admin&tenant=${AJENO}`);
      await expect(page).toHaveURL(/\/dashboard\/contador$/);
      await expect(page.getByRole('button', { name: 'Crear viaje', exact: true })).toHaveCount(0);
    });
  }
});

test.describe('vendedor: sólo su cartera, ningún dato de flota', () => {
  test.use({ storageState: ESTADOS.vendedor });
  test('ve su prospecto y no el canario ajeno con parámetros manipulados', async ({ page }) => {
    await paginaSana(page, '/vendedor', 'Cartera propia E2E');
    await expect(page.locator('body')).not.toContainText('Cartera ajena E2E');
    await page.goto(`/vendedor?tenant=${AJENO}&rol=superadmin`);
    await expect(page.locator('body')).toContainText('Cartera propia E2E');
    await expect(page.locator('body')).not.toContainText('Cartera ajena E2E');
    await expect(page.locator('body')).toContainText('Mis prospectos');
    await page.screenshot({ path: 'pruebas-navegador/.artefactos/vendedor-cartera.png', fullPage: true });
  });
  test('guarda una nota propia y la conserva al recargar', async ({ page }) => {
    await page.goto('/vendedor');
    const tarjeta = page.locator('.card').filter({ has: page.getByText('Cartera propia E2E', { exact: true }) }).last();
    await tarjeta.locator('summary').click();
    const entrada = tarjeta.locator('textarea');
    const anterior = await entrada.inputValue();
    const nota = `Seguimiento sintético E2E ${Date.now()}`;
    try {
      await entrada.fill(nota);
      const respuesta = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/vendedor');
      await tarjeta.getByRole('button', { name: 'Guardar nota', exact: true }).click();
      expect((await respuesta).status()).toBe(200);
      await page.reload();
      await expect(tarjeta).toContainText(nota);
      await expect(page.locator('body')).not.toContainText('Cartera ajena E2E');
    } finally {
      if (!(await tarjeta.locator('textarea').isVisible())) await tarjeta.locator('summary').click();
      await tarjeta.locator('textarea').fill(anterior);
      const respuesta = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/vendedor');
      await tarjeta.getByRole('button', { name: 'Guardar nota', exact: true }).click();
      expect((await respuesta).status()).toBe(200);
    }
  });
  for (const ruta of ['/dashboard/viajes', '/dashboard/contador', '/dashboard/usuarios', '/admin', '/admin/vendedores']) {
    test(`niega URL directa ${ruta}`, async ({ page }) => {
      await page.goto(`${ruta}?rol=superadmin&tenant=${AJENO}`);
      await expect(page).toHaveURL(/\/vendedor$/);
      await expect(page.locator('body')).not.toContainText('VJ-2026-0844');
      await expect(page.locator('body')).not.toContainText('Consola de Likida');
    });
  }
});

for (const [rol, rutas] of [
  ['encargado', [['/dashboard/operadores', 'Operadores'], ['/dashboard/unidades', 'Unidades'], ['/dashboard/jornada', 'Jornada']]],
  ['contador', [['/dashboard/agentes/liquidacion', 'Liquidación'], ['/dashboard/agentes/peajes', 'Peajes'], ['/dashboard/agentes/proveedores', 'Proveedores']]],
] as const) {
  test.describe(`recorridos diarios del ${rol}`, () => {
    test.use({ storageState: ESTADOS[rol] });
    for (const [ruta, texto] of rutas) {
      test(`${ruta} carga completa sin errores de página`, async ({ page }) => {
        await paginaSana(page, ruta, texto);
      });
    }
  });
}
