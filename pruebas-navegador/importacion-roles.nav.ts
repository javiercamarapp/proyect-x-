import { test, expect, request as apiRequest } from './apoyo/fixture';
import { ESTADOS } from './apoyo/sesion';
import { entornoLocalE2E } from '../scripts/ci/e2e/entorno-local.mjs';

for (const [rol, financiero] of [['duena', true], ['encargado', true], ['encargado', false]] as const) {
  test.describe(`importación CSV ${financiero ? "financiera" : "operativa"} (${rol})`, () => {
    test.use({ storageState: ESTADOS[rol] });
    const folio = `E2E-IMP-${rol}-${financiero ? "fin" : "op"}-${Date.now().toString(36)}`;
    test.afterAll(async () => {
      const { supabase } = entornoLocalE2E();
      const llave = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!llave) throw new Error('Falta llave local para limpiar el viaje sintético');
      const ctx = await apiRequest.newContext();
      try {
        const r = await ctx.delete(`${supabase}/rest/v1/viaje`, {
          params: { tenant_id: 'eq.11111111-1111-1111-1111-111111111111', folio: `eq.${folio}` }, maxRedirects: 0,
          headers: { apikey: llave, Authorization: `Bearer ${llave}` },
        });
        expect(r.ok()).toBeTruthy();
      } finally { await ctx.dispose(); }
    });
    test(!financiero ? 'el encargado conserva la importación operativa' : rol === 'duena' ? 'permite importar datos financieros al dueño' : 'rechaza columnas financieras del encargado sin crear viajes', async ({ page, browser }) => {
      await page.goto('/dashboard/viajes');
      await page.locator('summary').filter({ hasText: 'Importar desde tu TMS' }).click();
      await page.getByLabel('CSV o Excel con los viajes').setInputFiles({
        name: 'viajes-financieros.csv', mimeType: 'text/csv',
        buffer: Buffer.from(financiero
          ? `folio,origen,destino,anticipo,operador,ingreso\n${folio},Silao,Monterrey,7890,Fernando Aguilar Cruz,12345\n`
          : `folio,origen,destino,operador\n${folio},Silao,Monterrey,Fernando Aguilar Cruz\n`),
      });
      const enviada = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/dashboard/viajes');
      await page.getByRole('button', { name: 'Importar viajes', exact: true }).click();
      expect((await enviada).status()).toBe(200);
      const cuerpo = page.locator('body');
      if (rol === 'duena' || !financiero) await expect(cuerpo).toContainText('1 viajes creados');
      else {
        await page.screenshot({ path: 'pruebas-navegador/.artefactos/importacion-encargado.png', fullPage: true });
        await expect(cuerpo).not.toContainText('1 viajes creados');
        await expect(cuerpo).toContainText(/Tu rol|permiso|dinero/);
      }
      // El resultado se verifica con la sesión del dueño, que sí ve dinero.
      const duena = await browser.newContext({ storageState: ESTADOS.duena });
      try {
        const registro = await duena.newPage();
        await registro.goto(`/dashboard/viajes?q=${folio}`);
        const fila = registro.locator('tr', { hasText: folio });
        if (rol === 'duena') await expect(fila).toContainText('7,890');
        else if (!financiero) await expect(fila).toContainText('Abierto');
        else await expect(fila).toHaveCount(0);
      } finally { await duena.close(); }
    });
  });
}
