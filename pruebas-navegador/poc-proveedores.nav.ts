import { writeFile } from 'node:fs/promises';
import { test, expect, request as apiRequest } from './apoyo/fixture';
import { ESTADOS } from './apoyo/sesion';
import { entornoLocalE2E, getLocalE2E } from '../scripts/ci/e2e/entorno-local.mjs';
import type { APIRequestContext, Download } from '@playwright/test';
import * as XLSX from 'xlsx';

const TENANT = '11111111-1111-1111-1111-111111111111';
const sello = Date.now();
const id = (n: number) => `ffffffff-1000-4000-8000-${(sello + n).toString(16).padStart(12, '0')}`;
const APROBADA = id(0), RECHAZADA = id(1), PENDIENTE = id(2);
const IDS = [APROBADA, RECHAZADA, PENDIENTE];
const DESCRIPCION = `PoC Innovativos proveedor ${sello}`;
let admin: APIRequestContext;
let corridasPrevias = new Set<string>();
let puedeLimpiarCorridas = false;

async function filas() {
  const r = await admin.get('factura_proveedor', { params: { tenant_id: `eq.${TENANT}`, id: `in.(${IDS.join(',')})`, select: 'id,estado,decidido_por,decidido_en,exportada_en', order: 'id' }, maxRedirects: 0 });
  expect(r.ok()).toBeTruthy();
  return r.json() as Promise<Array<{ id: string; estado: string; decidido_por: string | null; decidido_en: string | null; exportada_en: string | null }>>;
}
async function corridas() {
  const r = await admin.get('agente_corrida', { params: { tenant_id: `eq.${TENANT}`, agente: 'eq.proveedores', select: 'id,resumen', order: 'inicio.desc', limit: '100' }, maxRedirects: 0 });
  expect(r.ok()).toBeTruthy();
  return r.json() as Promise<Array<{ id: string; resumen: { accion?: string; formato?: string } }>>;
}
async function textoDescarga(download: Download) {
  expect(await download.failure()).toBeNull();
  const stream = await download.createReadStream();
  if (!stream) throw new Error('La descarga no produjo un archivo');
  const partes: Buffer[] = [];
  for await (const parte of stream) partes.push(Buffer.from(parte));
  return Buffer.concat(partes).toString('utf8');
}

// La PoC comienza con documentos sintéticos YA en bandeja. No demuestra intake,
// SAT, correo, OCR ni una importación certificada a una instancia SAP del cliente.
test.describe('PoC B: decisión humana de proveedor y CSV SAP con marca de exportación', () => {
  test.use({ storageState: ESTADOS.contador });
  test.beforeAll(async () => {
    const { supabase } = entornoLocalE2E();
    const llave = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!llave) throw new Error('Falta llave local para la PoC de proveedores');
    admin = await apiRequest.newContext({ baseURL: `${supabase}/rest/v1/`, extraHTTPHeaders: { apikey: llave, Authorization: `Bearer ${llave}` } });
    // El export abarca TODAS las aprobadas: no marcar fixtures ajenas por accidente.
    const existentes = await admin.get('factura_proveedor', { params: { tenant_id: `eq.${TENANT}`, estado: 'eq.aprobada', select: 'id' }, maxRedirects: 0 });
    expect(existentes.ok()).toBeTruthy();
    expect(await existentes.json(), 'esta prueba requiere bandeja sin otras aprobadas').toEqual([]);
    corridasPrevias = new Set((await corridas()).map(c => c.id));
    puedeLimpiarCorridas = true;
    const r = await admin.post('factura_proveedor', { data: IDS.map((facturaId, i) => ({
      id: facturaId, tenant_id: TENANT, cfdi_uuid: facturaId,
      emisor_rfc: 'AAA010101AAA', emisor_nombre: 'Proveedor sintético Innovativos', receptor_rfc: 'XAXX010101000', receptor_es_flota: null,
      fecha: '2026-06-15', sub_total: 1000 + i * 100, iva: 160 + i * 16, total: 1160 + i * 116,
      descripcion: `${DESCRIPCION} ${i}`, conceptos: 1, estado: 'pendiente', origen: 'subida', estado_sat: null,
      xml_crudo: `<Comprobante sintetico="true" UUID="${facturaId}"/>`,
    })), maxRedirects: 0 });
    expect(r.ok(), `siembra de facturas: ${await r.text()}`).toBeTruthy();
  });
  test.afterAll(async () => {
    if (!admin) return;
    try {
      const r = await admin.delete('factura_proveedor', { params: { tenant_id: `eq.${TENANT}`, id: `in.(${IDS.join(',')})` }, maxRedirects: 0 });
      expect(r.ok()).toBeTruthy();
      if (puedeLimpiarCorridas) {
        // Ejecución serial: sólo retirar las corridas SAP creadas durante esta PoC.
        const propias = (await corridas()).filter(c => !corridasPrevias.has(c.id) && c.resumen?.accion === 'export' && c.resumen?.formato === 'sap_b1');
        expect(propias.length).toBeLessThanOrEqual(2);
        if (propias.length) {
          const limpieza = await admin.delete('agente_corrida', { params: { tenant_id: `eq.${TENANT}`, id: `in.(${propias.map(c => c.id).join(',')})` }, maxRedirects: 0 });
          expect(limpieza.ok()).toBeTruthy();
        }
      }
    } finally { await admin.dispose(); }
  });

  test('aprobar/rechazar por UI → sólo aprobada en CSV → re-descarga conserva primer sello', async ({ page, browser }, info) => {
    const errores: string[] = [];
    page.on('pageerror', error => errores.push(error.message));
    await page.goto('/dashboard/agentes/proveedores');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'La bandeja', exact: true })).toBeVisible();
    const aprobada = page.locator('tr', { hasText: `${DESCRIPCION} 0` });
    const rechazada = page.locator('tr', { hasText: `${DESCRIPCION} 1` });
    await expect(aprobada.getByRole('button', { name: 'Aprobar', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('bandeja-sintetica.png'), fullPage: true });
    await aprobada.getByRole('button', { name: 'Aprobar', exact: true }).click();
    await expect(aprobada.getByText('Aprobada', { exact: true })).toBeVisible();
    await rechazada.getByRole('button', { name: 'Rechazar', exact: true }).click();
    await rechazada.getByRole('button', { name: 'No', exact: true }).click();
    expect((await filas()).find(f => f.id === RECHAZADA)?.estado).toBe('pendiente');
    await rechazada.getByRole('button', { name: 'Rechazar', exact: true }).click();
    await rechazada.getByRole('button', { name: 'Sí', exact: true }).click();
    await expect(rechazada.getByText('Rechazada', { exact: true })).toBeVisible();
    const antes = await filas();
    expect(antes.map(f => f.estado)).toEqual(['aprobada', 'rechazada', 'pendiente']);
    expect(antes[0].decidido_por).toBe('Contador E2E');
    expect(antes[0].decidido_en).toBeTruthy();
    expect(antes.every(f => f.exportada_en === null)).toBe(true);
    const enlace = page.getByRole('link', { name: 'Exportar aprobadas (CSV SAP B1)', exact: true });
    const href = await enlace.getAttribute('href');
    expect(href).toBe('/api/export/facturas-proveedor?formato=sap_b1');
    const negativa = await browser.newContext({ storageState: ESTADOS.encargado });
    try {
      expect((await getLocalE2E(negativa.request, href!)).status()).toBe(403);
      const ajena = await negativa.newPage();
      await ajena.goto('/dashboard/agentes/proveedores?rol=flota_admin');
      await expect(ajena).toHaveURL(/\/dashboard$/);
      await expect(ajena.locator('body')).not.toContainText(DESCRIPCION);
      expect(await filas()).toEqual(antes);
    } finally { await negativa.close(); }
    const descargar = async () => {
      const promesa = page.waitForEvent('download');
      await enlace.click();
      const download = await promesa;
      expect(download.suggestedFilename()).toBe('facturas_proveedor_sap_b1_likida.csv');
      return textoDescarga(download);
    };
    const csv = await descargar();
    const libro = XLSX.read(csv, { type: 'string' });
    const registros = XLSX.utils.sheet_to_json<Record<string, unknown>>(libro.Sheets[libro.SheetNames[0]], { defval: '', raw: false });
    expect(registros).toHaveLength(1);
    expect(registros[0]).toEqual({
      DocDate: '20260615', DocDueDate: '', CardCode: '', CardName: 'Proveedor sintético Innovativos', FederalTaxID: 'AAA010101AAA',
      NumAtCard: APROBADA, Comments: `${DESCRIPCION} 0`, DocTotal: '1160', ItemDescription: `${DESCRIPCION} 0`, LineTotal: '1000', TaxCode: '',
    });
    expect(csv).not.toContain(RECHAZADA);
    expect(csv).not.toContain(PENDIENTE);
    const primeraRuta = info.outputPath('sap-b1-sintetico-primera-descarga.csv');
    // Ruta generada por Playwright, sin entrada externa.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(primeraRuta, csv);
    await info.attach('sap-b1-sintetico-primera-descarga', { path: primeraRuta, contentType: 'text/csv' });
    const despues = await filas();
    expect(despues[0].exportada_en).toBeTruthy();
    expect(despues.slice(1).every(f => f.exportada_en === null)).toBe(true);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(aprobada.getByText('Exportada', { exact: true })).toBeVisible();
    await expect(page.locator('body')).toContainText('Lo exportado queda marcado en la bandeja.');
    await expect(page.locator('body')).toContainText('no una compatibilidad certificada');
    // Re-descargar es contrato explícito: mismas filas y primer sello inmutable.
    // La marca avisa al contador; esto no prueba exactly-once dentro de SAP.
    const repetido = await descargar();
    expect(repetido).toBe(csv);
    expect(await filas()).toEqual(despues);
    const segundaRuta = info.outputPath('sap-b1-sintetico-segunda-descarga.csv');
    // Ruta generada por Playwright, sin entrada externa.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(segundaRuta, repetido);
    await info.attach('sap-b1-sintetico-segunda-descarga', { path: segundaRuta, contentType: 'text/csv' });
    await aprobada.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('decision-y-exportada.png'), fullPage: true });
    expect(errores).toEqual([]);
  });
});
