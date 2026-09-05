import { writeFile } from 'node:fs/promises';
import type { APIRequestContext } from '@playwright/test';
import { test, expect, request as apiRequest } from './apoyo/fixture';
import { ESTADOS } from './apoyo/sesion';
import { entornoLocalE2E, getLocalE2E } from '../scripts/ci/e2e/entorno-local.mjs';

const TENANT = '11111111-1111-1111-1111-111111111111';
const sello = Date.now();
const id = (n: number) => `eeeeeeee-3460-4000-8000-${(sello + n).toString(16).padStart(12, '0')}`;
const OPERADOR = id(0), VIAJE = id(1), GASTO = id(2);
const FOLIO = `PDF-REINTENTO-${sello}`;
let liquidacion = '';
let admin: APIRequestContext;
let storage: APIRequestContext;
const objetos = new Set<string>();

async function fila() {
  const r = await admin.get('liquidacion', { params: {
    tenant_id: `eq.${TENANT}`, id: `eq.${liquidacion}`,
    select: 'id,pdf_url,pdf_versionada,revision,revisada_por,revisada_por_email,revisada_en,total_comprobado,total_anticipo,diferencia,estatus,diferencias,motivo,ajustes',
  }, maxRedirects: 0 });
  expect(r.ok()).toBeTruthy();
  const filas = await r.json();
  expect(filas).toHaveLength(1);
  return filas[0] as Record<string, unknown>;
}
function recordarPareja(path: unknown) {
  expect(typeof path).toBe('string');
  expect(path).toMatch(new RegExp(`^${TENANT}/${VIAJE}-version-[0-9a-f-]{36}\\.pdf$`));
  objetos.add(String(path));
  objetos.add(String(path).replace(/\.pdf$/, '-operador.pdf'));
}

// Firma real por UI. La inyección de fallo sólo retira pdf_url de esta fila
// propia ya ajustada; no falsifica firma, monto, cookies ni respuesta HTTP.
test.describe('PDF firmado: pendiente → reintento sin segunda firma', () => {
  test.use({ storageState: ESTADOS.duena });
  test.beforeAll(async () => {
    const { supabase } = entornoLocalE2E();
    const llave = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!llave) throw new Error('Falta llave local para fixture PDF');
    const extraHTTPHeaders = { apikey: llave, Authorization: `Bearer ${llave}` };
    admin = await apiRequest.newContext({ baseURL: `${supabase}/rest/v1/`, extraHTTPHeaders });
    storage = await apiRequest.newContext({ baseURL: `${supabase}/storage/v1/`, extraHTTPHeaders });
    for (const [tabla, datos] of [
      ['operador', { id: OPERADOR, tenant_id: TENANT, nombre: FOLIO, telefono: `999${String(sello).slice(-10)}` }],
      ['viaje', { id: VIAJE, tenant_id: TENANT, operador_id: OPERADOR, folio: FOLIO, anticipo: 1000 }],
      ['gasto', { id: GASTO, tenant_id: TENANT, viaje_id: VIAJE, concepto: 'otro', monto: 100, fecha: new Date().toISOString().slice(0, 10), folio: FOLIO, forma_pago: '03' }],
    ] as const) {
      const r = await admin.post(tabla, { data: datos, maxRedirects: 0 });
      expect(r.ok(), `fixture ${tabla}: ${await r.text()}`).toBeTruthy();
    }
    const cierre = await admin.post('rpc/guardar_liquidacion_tx', { data: {
      p_tenant: TENANT, p_viaje: VIAJE, p_total_comprobado: 100, p_total_anticipo: 1000,
      p_diferencia: 900, p_estatus: 'revisar', p_diferencias: [], p_ieps: 0, p_iva: 0,
      p_peaje: 0, p_pdf_url: null, p_litros_diesel: 0,
    }, maxRedirects: 0 });
    expect(cierre.ok(), await cierre.text()).toBeTruthy();
    liquidacion = await cierre.json();
  });
  test.afterAll(async () => {
    if (!admin) return;
    try {
      // También recoger una mitad que pudiera quedar tras una generación fallida.
      const listado = await storage.post('object/list/liquidaciones', { data: { prefix: TENANT, search: `${VIAJE}-version-`, limit: 100 }, maxRedirects: 0 });
      expect(listado.ok()).toBeTruthy();
      for (const objeto of await listado.json() as Array<{ name: string }>) {
        if (new RegExp(`^${VIAJE}-version-[0-9a-f-]{36}(-operador)?\\.pdf$`).test(objeto.name)) objetos.add(`${TENANT}/${objeto.name}`);
      }
      if (objetos.size) {
        const r = await storage.delete('object/liquidaciones', { data: { prefixes: [...objetos] }, maxRedirects: 0 });
        expect(r.ok(), 'limpieza de objetos sintéticos por Storage API').toBeTruthy();
      }
      for (const [tabla, columna, valor] of [
        ['bitacora_auditoria', 'entidad_id', liquidacion],
        ['liquidacion', 'id', liquidacion], ['gasto', 'id', GASTO],
        ['viaje', 'id', VIAJE], ['operador', 'id', OPERADOR],
      ]) {
        if (!valor) continue;
        const r = await admin.delete(tabla, { params: { tenant_id: `eq.${TENANT}`, [columna]: `eq.${valor}` }, maxRedirects: 0 });
        expect(r.ok(), `limpieza propia ${tabla}: ${await r.text()}`).toBeTruthy();
      }
    } finally { await admin.dispose(); await storage?.dispose(); }
  });
  test('ajuste real → PDF pendiente visible → ambos ejemplares nuevos con firma e importes intactos', async ({ page, browser }, info) => {
    const errores: string[] = [];
    page.on('pageerror', e => errores.push(e.message));
    await page.goto(`/dashboard/${liquidacion}`);
    await page.waitForLoadState('networkidle');
    // El input sr-only queda recortado; la persona activa su etiqueta visible.
    await page.getByRole('radiogroup', { name: 'Qué hacer con esta liquidación' }).getByText('Ajustar montos', { exact: true }).click();
    await page.getByRole('textbox', { name: /Monto correcto de/ }).fill('200');
    await page.getByRole('textbox', { name: /Motivo/ }).fill('Corrección sintética para verificar el reintento de PDF');
    await page.getByRole('button', { name: 'Ajustar montos', exact: true }).click();
    await expect.poll(async () => (await fila()).revision).toBe('ajustada');
    await expect.poll(async () => Boolean((await fila()).pdf_url), { timeout: 30000 }).toBe(true);
    const firmado = await fila();
    expect(firmado.total_comprobado).toBe(200);
    expect(firmado.revisada_por).toBeTruthy();
    expect(firmado.revisada_en).toBeTruthy();
    recordarPareja(firmado.pdf_url);

    const fallo = await admin.patch('liquidacion', { params: { tenant_id: `eq.${TENANT}`, id: `eq.${liquidacion}` }, data: { pdf_url: null }, maxRedirects: 0 });
    expect(fallo.ok()).toBeTruthy();
    const pendiente = await fila();
    expect(pendiente).toEqual({ ...firmado, pdf_url: null });
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('region', { name: 'PDF pendiente' })).toContainText('El ajuste y la firma están guardados');
    await expect(page.getByRole('button', { name: 'Reintentar PDF', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('pdf-pendiente.png'), fullPage: true });
    const encargado = await browser.newContext({ storageState: ESTADOS.encargado });
    try {
      const otra = await encargado.newPage();
      await otra.goto(`/dashboard/${liquidacion}`);
      await expect(otra.getByRole('button', { name: 'Reintentar PDF', exact: true })).toHaveCount(0);
      expect((await getLocalE2E(encargado.request, `/api/export/pdf/${liquidacion}`)).status()).toBe(403);
    } finally { await encargado.close(); }
    await page.getByRole('button', { name: 'Reintentar PDF', exact: true }).click();
    await expect.poll(async () => Boolean((await fila()).pdf_url), { timeout: 30000 }).toBe(true);
    const final = await fila();
    recordarPareja(final.pdf_url);
    expect(final.pdf_url).not.toBe(firmado.pdf_url);
    expect({ ...final, pdf_url: null }).toEqual(pendiente);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('button', { name: 'Reintentar PDF', exact: true })).toHaveCount(0);
    const pdf = await getLocalE2E(page.request, `/api/export/pdf/${liquidacion}`);
    expect(pdf.status()).toBe(200);
    expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');
    for (const [rol, path] of [['contralor', String(final.pdf_url)], ['operador', String(final.pdf_url).replace(/\.pdf$/, '-operador.pdf')]]) {
      const r = await storage.get(`object/authenticated/liquidaciones/${path}`, { maxRedirects: 0 });
      expect(r.ok()).toBeTruthy();
      const bytes = await r.body();
      expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
      // Ruta de evidencia producida por Playwright, sin entrada externa.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await writeFile(info.outputPath(`pdf-${rol}.pdf`), bytes);
    }
    await page.screenshot({ path: info.outputPath('pdf-regenerado.png'), fullPage: true });
    expect(errores).toEqual([]);
  });
});
