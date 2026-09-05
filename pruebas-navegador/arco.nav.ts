import { test, expect, request as apiRequest } from './apoyo/fixture';
import { ESTADOS } from './apoyo/sesion';
import { entornoLocalE2E } from '../scripts/ci/e2e/entorno-local.mjs';
import type { APIRequestContext } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const TENANT = '11111111-1111-1111-1111-111111111111';
const sello = Date.now();
const id = (n: number) => `eeeeeeee-2000-4000-8000-${(sello + n).toString(16).padStart(12, '0')}`;
const OPERADOR = id(0), SOLICITUD = id(1);
const NOMBRE = `Operador sintético ARCO ${sello}`;
const TELEFONO = `999${String(sello).slice(-10)}`;
const PROMESA_EXCESIVA = /quedó anonimizado en la base|desligad[ao]s? (de su persona|del titular)|sin vincularse a tu persona/;
let admin: APIRequestContext;

async function solicitud() {
  const r = await admin.get('solicitud_arco', { params: { tenant_id: `eq.${TENANT}`, id: `eq.${SOLICITUD}`, select: 'id,operador_id,titular_ref,estado,resolucion,ejecutada_en,evidencia' }, maxRedirects: 0 });
  expect(r.ok()).toBeTruthy();
  const filas = await r.json();
  expect(filas).toHaveLength(1);
  return filas[0];
}

// Sólo dos UUID propios, sin viajes, mensajes ni evidencia fiscal. titular_ref
// nulo evita incluso intentar el envío de WhatsApp después de ejecutar la RPC.
test.describe('ARCO: alcance explícito de la cancelación sintética', () => {
  test.use({ storageState: ESTADOS.duena });
  test.beforeAll(async () => {
    const { supabase } = entornoLocalE2E();
    const llave = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!llave) throw new Error('Falta llave local para fixture ARCO');
    admin = await apiRequest.newContext({ baseURL: `${supabase}/rest/v1/`, extraHTTPHeaders: { apikey: llave, Authorization: `Bearer ${llave}` } });
    // La RPC también busca mensajes por teléfono: no debe haber filas ajenas
    // con el número sintético antes de ejecutar el caso propio.
    for (const tabla of ['wa_conversacion', 'envio_mensaje']) {
      const r = await admin.get(tabla, { params: { tenant_id: `eq.${TENANT}`, telefono: `in.(${TELEFONO},+${TELEFONO})`, select: 'id' }, maxRedirects: 0 });
      expect(r.ok()).toBeTruthy();
      expect(await r.json()).toEqual([]);
    }
    for (const [tabla, datos] of [
      ['operador', { id: OPERADOR, tenant_id: TENANT, nombre: NOMBRE, telefono: TELEFONO }],
      ['solicitud_arco', { id: SOLICITUD, tenant_id: TENANT, operador_id: OPERADOR, titular_ref: null, tipo: 'cancelacion', canal: 'panel', estado: 'recibida', vence_en: '2026-10-01' }],
    ] as const) {
      const r = await admin.post(tabla, { data: datos, maxRedirects: 0 });
      expect(r.ok(), `fixture ${tabla}: ${await r.text()}`).toBeTruthy();
    }
  });
  test.afterAll(async () => {
    if (!admin) return;
    try {
      for (const [tabla, propio] of [['solicitud_arco', SOLICITUD], ['operador', OPERADOR]]) {
        const r = await admin.delete(tabla, { params: { tenant_id: `eq.${TENANT}`, id: `eq.${propio}` }, maxRedirects: 0 });
        expect(r.ok()).toBeTruthy();
      }
    } finally { await admin.dispose(); }
  });
  test('dueño ejecuta sólo su fixture; UI y resolución reconocen retención sin prometer desvinculación total', async ({ page, browser }, info) => {
    const errores: string[] = [];
    page.on('pageerror', e => errores.push(e.message));
    await page.goto('/dashboard/arco');
    await page.waitForLoadState('networkidle');
    const fila = page.locator('tr', { hasText: NOMBRE });
    await expect(fila.getByRole('button', { name: 'Ejecutar cancelación', exact: true })).toBeVisible();
    await expect(fila).not.toContainText(PROMESA_EXCESIVA);
    await expect(fila).toContainText(/conserv|reten/i);
    const antes = await solicitud();
    expect(antes.titular_ref).toBeNull();
    const encargado = await browser.newContext({ storageState: ESTADOS.encargado });
    try {
      const vista = await encargado.newPage();
      await vista.goto('/dashboard/arco');
      const otraFila = vista.locator('tr', { hasText: NOMBRE });
      await otraFila.getByRole('button', { name: 'Ejecutar cancelación', exact: true }).click();
      await expect(otraFila).toContainText('Tu rol no puede responder solicitudes ARCO');
      expect(await solicitud()).toEqual(antes);
    } finally { await encargado.close(); }
    // Capturar bytes en cuanto llegan: la revalidación puede reemplazar la
    // navegación antes de que termine click().
    const respuesta = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/dashboard/arco')
      .then(async r => ({ status: r.status(), cuerpoUtf8: (await r.body()).toString('utf8') }));
    await fila.getByRole('button', { name: 'Ejecutar cancelación', exact: true }).click();
    const post = await respuesta;
    expect(post.status).toBe(200);
    // Este motivo sólo sale del retorno temprano anterior a importar/enviar WhatsApp.
    // El RSC observado representa el acento con mojibake; se conserva el
    // fragmento y se identifica la rama por sus dos partes ASCII estables.
    const cuerpoUtf8 = post.cuerpoUtf8;
    const motivoSinEnvio = cuerpoUtf8.match(/sin tel.{1,2}fono del titular\)/)?.[0];
    expect(motivoSinEnvio).toBeDefined();
    // La vista inmediatamente posterior al POST también debe leer bien; la
    // comprobación no depende de la recarga explícita que viene después.
    await expect(page.locator('body')).toContainText('Se sustituyeron el nombre y el teléfono del registro operativo');
    await expect(page.locator('body')).not.toContainText(/telÃ©fono|sustituyÃ/);
    const avisosDespuesPost = (await page.locator('[aria-live="polite"]').allTextContents()).filter(t => t.trim());
    await page.screenshot({ path: info.outputPath('arco-inmediatamente-post.png'), fullPage: true });
    const transporte = { motivoSinEnvio, decodificacion: 'body UTF-8', avisosDespuesPost };
    const despues = await solicitud();
    expect(despues.estado).toBe('resuelta');
    expect(despues.operador_id).toBe(OPERADOR);
    expect(despues.titular_ref).toBeNull();
    expect(despues.ejecutada_en).toBeTruthy();
    expect(despues.resolucion).toMatch(/conserv|reten/i);
    expect(despues.resolucion).not.toMatch(PROMESA_EXCESIVA);
    expect(despues.evidencia).toMatchObject({
      evidencia_fiscal_retenida: true, operador_anonimizado: 1,
      wa_conversacion: 0, envio_mensaje: 0, app_user_anonimizado: 0,
      incidencia_texto_anonimizado: 0, incidencia_evento_texto_anonimizado: 0,
    });
    const r = await admin.get('operador', { params: { tenant_id: `eq.${TENANT}`, id: `eq.${OPERADOR}`, select: 'id,nombre,telefono,anonimizado_en' }, maxRedirects: 0 });
    expect(r.ok()).toBeTruthy();
    const operadores = await r.json();
    expect(operadores).toHaveLength(1);
    expect(operadores[0].id).toBe(OPERADOR);
    expect(operadores[0].nombre).toMatch(/^Operador [A-F0-9]{6}$/);
    expect(operadores[0].telefono).toMatch(/^anon:[a-f0-9]{16}$/);
    await page.reload();
    const resuelta = page.locator('tr', { hasText: operadores[0].nombre });
    await expect(resuelta).toContainText('Resuelta');
    await expect(resuelta).toContainText(despues.resolucion);
    await resuelta.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('arco-alcance-real.png'), fullPage: true });
    const evidencia = info.outputPath('arco-resolucion-sintetica.json');
    // Ruta generada por Playwright, sin entrada externa.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(evidencia, JSON.stringify({ solicitud: despues, transporte }, null, 2));
    await info.attach('arco-resolucion-sintetica', { path: evidencia, contentType: 'application/json' });
    expect(errores).toEqual([]);
  });
});
