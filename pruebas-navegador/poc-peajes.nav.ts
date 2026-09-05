import { test, expect, request as apiRequest } from './apoyo/fixture';
import { ESTADOS } from './apoyo/sesion';
import { entornoLocalE2E, getLocalE2E } from '../scripts/ci/e2e/entorno-local.mjs';
import { writeFile } from 'node:fs/promises';
import type { APIRequestContext } from '@playwright/test';

const TENANT = '11111111-1111-1111-1111-111111111111';
const sello = Date.now();
const id = (n: number) => `eeeeeeee-1000-4000-8000-${(sello + n).toString(16).padStart(12, '0')}`;
const OPERADOR = id(0), VIAJE = id(1), GASTO_EXACTO = id(2), GASTO_DISTINTO = id(3);
const FOLIO = `E2E-POC-PEAJES-${sello}`;
const ARCHIVO = `${FOLIO}.csv`;
let admin: APIRequestContext;

// Datos propios de esta prueba; no modifica seed.sql ni estados de otras pruebas.
test.describe('PoC A: conciliación de peajes con base real', () => {
  test.use({ storageState: ESTADOS.contador });
  test.beforeAll(async () => {
    const { supabase } = entornoLocalE2E();
    const llave = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!llave) throw new Error('Falta llave local para sembrar la prueba de peajes');
    admin = await apiRequest.newContext({ baseURL: `${supabase}/rest/v1/`, extraHTTPHeaders: { apikey: llave, Authorization: `Bearer ${llave}` } });
    for (const [tabla, datos] of [
      ['operador', { id: OPERADOR, tenant_id: TENANT, nombre: 'Operador sintético PoC peajes', telefono: '+529999990801' }],
      ['viaje', { id: VIAJE, tenant_id: TENANT, operador_id: OPERADOR, folio: FOLIO, origen: 'Silao E2E', destino: 'Monterrey E2E', fecha_inicio: '2026-06-01', estatus: 'abierto', anticipo: 1500 }],
      ['gasto', [
        { id: GASTO_EXACTO, tenant_id: TENANT, viaje_id: VIAJE, concepto: 'caseta', monto: 431.27, fecha: '2026-06-01' },
        { id: GASTO_DISTINTO, tenant_id: TENANT, viaje_id: VIAJE, concepto: 'caseta', monto: 900, fecha: '2026-06-04' },
      ]],
    ] as const) {
      const r = await admin.post(tabla, { data: datos, maxRedirects: 0 });
      expect(r.ok(), `siembra ${tabla}: ${await r.text()}`).toBeTruthy();
    }
  });
  test.afterAll(async () => {
    if (!admin) return;
    try {
      for (const [tabla, params] of [
        ['desglose_peaje', { tenant_id: `eq.${TENANT}`, archivo_nombre: `eq.${ARCHIVO}` }],
        ['gasto', { tenant_id: `eq.${TENANT}`, viaje_id: `eq.${VIAJE}` }],
        ['viaje', { tenant_id: `eq.${TENANT}`, id: `eq.${VIAJE}` }],
        ['operador', { tenant_id: `eq.${TENANT}`, id: `eq.${OPERADOR}` }],
      ] as const) {
        const r = await admin.delete(tabla, { params, maxRedirects: 0 });
        expect(r.ok(), `limpieza ${tabla}: ${await r.text()}`).toBeTruthy();
      }
    } finally { await admin.dispose(); }
  });

  test('desglose → tres cubetas → confirmación humana → bitácora CSV sólo de lo conciliado', async ({ page, browser }, info) => {
    await page.goto('/dashboard/agentes/peajes');
    await page.getByLabel('Desglose del proveedor de peaje (Excel, CSV o PDF)').setInputFiles({
      name: ARCHIVO, mimeType: 'text/csv', buffer: Buffer.from([
        'fecha,caseta,importe,tag',
        '2026-06-01,Caseta exacta PoC,431.27,TAG-POC-A',
        '2026-06-04,Caseta discrepante PoC,888,TAG-POC-A',
        '2026-06-20,Caseta sin gasto PoC,123.45,TAG-POC-A',
      ].join('\n')),
    });
    await page.getByLabel('Proveedor del desglose (opcional)').fill(FOLIO);
    await page.getByRole('button', { name: 'Importar y cruzar', exact: true }).click();
    await expect(page.locator('body')).toContainText('Desglose importado (3 líneas) y cruzado: 1 cuadran · 1 con discrepancia · 1 sin contraparte');
    await page.getByRole('link').filter({ hasText: FOLIO }).click();
    await expect(page.getByText('Caseta exacta PoC', { exact: true })).toBeVisible();
    await expect(page.getByText('Caseta discrepante PoC', { exact: true })).toBeVisible();
    await expect(page.getByText('Caseta sin gasto PoC', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/[?&]desglose=[a-f0-9-]{36}/);
    const desgloseId = new URL(page.url()).searchParams.get('desglose');
    expect(desgloseId).toMatch(/^[a-f0-9-]{36}$/);
    const estados = async () => {
      const r = await admin.get('desglose_peaje_linea', { params: { tenant_id: `eq.${TENANT}`, desglose_id: `eq.${desgloseId}`, select: 'indice,estatus,viaje_id,diferencia', order: 'indice' }, maxRedirects: 0 });
      expect(r.ok()).toBeTruthy();
      return r.json();
    };
    const antes = await estados();
    expect(antes.map((l: { estatus: string }) => l.estatus)).toEqual(['cuadra', 'no_cuadra', 'sin_contraparte']);
    expect(antes[0].viaje_id).toBe(VIAJE);
    expect(Number(antes[0].diferencia)).toBe(0);
    expect(Math.abs(Number(antes[1].diferencia))).toBe(12);
    expect(antes[2].viaje_id).toBeNull();
    // Cancelar no reescribe; confirmar recalcula y conserva las tres cubetas.
    await page.getByRole('button', { name: 'Conciliar', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sí, cruzar', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    expect(await estados()).toEqual(antes);
    await page.getByRole('button', { name: 'Conciliar', exact: true }).click();
    await page.getByRole('button', { name: 'Sí, cruzar', exact: true }).click();
    await expect(page.locator('body')).toContainText('Crucé 3 líneas: 1 cuadran, 1 con discrepancia, 1 sin contraparte');
    expect(await estados()).toEqual(antes);
    const enlace = page.getByRole('link', { name: 'Bitácora RMF 9.1.8 (CSV)', exact: true });
    const href = await enlace.getAttribute('href');
    expect(href).toContain(`/api/export/bitacora-peaje?desglose=${desgloseId}`);
    const respuesta = await getLocalE2E(page.request, href!);
    expect(respuesta.status()).toBe(200);
    expect(respuesta.headers()['content-type']).toContain('text/csv');
    const csv = await respuesta.text();
    expect(csv).toContain(FOLIO);
    expect(csv).toContain('Caseta exacta PoC');
    expect(csv).toContain('431.27');
    expect(csv).toContain('Silao E2E');
    expect(csv).toContain('Monterrey E2E');
    expect(csv).toContain('sin datos');
    expect(csv).not.toContain('Caseta discrepante PoC');
    expect(csv).not.toContain('Caseta sin gasto PoC');
    const archivoCsv = info.outputPath('bitacora-sintetica.csv');
    // Ruta generada por Playwright, sin entrada externa.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(archivoCsv, csv);
    await info.attach('bitacora-sintetica', { path: archivoCsv, contentType: 'text/csv' });
    await page.screenshot({ path: info.outputPath('tres-cubetas.png'), fullPage: true });
    for (const [rol, codigo] of [['encargado', 403], ['intrusa', 404]] as const) {
      const otro = await browser.newContext({ storageState: ESTADOS[rol] });
      try { expect((await getLocalE2E(otro.request, href!)).status()).toBe(codigo); }
      finally { await otro.close(); }
    }
  });
});
