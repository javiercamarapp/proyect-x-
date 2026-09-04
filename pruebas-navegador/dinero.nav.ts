/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EL CAMINO DEL DINERO, LO QUE EL NAVEGADOR PUEDE PROBAR DE ÉL.
 *
 * El camino completo del producto es subida (foto por WhatsApp) → OCR →
 * cuadre → PDF. Los dos tramos de en medio pasan por el webhook firmado de
 * Meta y por una llamada de modelo PAGADA — no se fingen aquí (los cubren
 * los arneses `pruebas-manuales/*.prueba.ts` y las pruebas offline del
 * webhook). Lo que SÍ vive en el navegador, y aquí se prueba con la pila
 * real, es cada punta que el cliente toca:
 *
 *   1. El viaje NACE en el panel (Despacho → server action → Postgres) y
 *      aparece en el registro como abierto — el punto de entrada real de la
 *      operación que después recibe comprobantes.
 *   2. Los gastos y cifras de un viaje YA cuadrado se enseñan tal cual están
 *      en la base ($10,200 = $10,200, diferencia 0 — VJ-2026-0844 del seed).
 *   3. El PDF de la liquidación SE ENTREGA: sesión → permiso de rol → filtro
 *      de tenant → URL firmada de vida corta → bytes de PDF. Y se NIEGA a la
 *      otra flota y al anónimo — la misma prueba, del lado del aislamiento.
 *      (El objeto del bucket lo sembró sembrar-e2e.mjs; la GENERACIÓN del
 *      PDF la cubren pdf.test.ts/pdf_cifras.test.ts — aquí se prueba la
 *      puerta, que solo existe con la pila completa.)
 *
 * MUNDO COMO SE ENCONTRÓ: el viaje creado se borra en el afterAll con el
 * service key del Supabase LOCAL (solo limpieza; ninguna prueba se
 * autentica con él). En CI además la pila entera es efímera.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { test, expect, request as apiRequest } from './apoyo/fixture';
import { ESTADOS } from './apoyo/sesion';
import { entornoLocalE2E, getLocalE2E } from '../scripts/ci/e2e/entorno-local.mjs';

/** Folio único por corrida: dos corridas locales seguidas no chocan. */
const FOLIO = `E2E-${Date.now().toString(36).toUpperCase()}`;

const SUPABASE_URL = entornoLocalE2E().supabase;

test.describe('alta del viaje en Despacho', () => {
  test.use({ storageState: ESTADOS.duena });

  test.afterAll(async () => {
    // Limpieza fail-closed: si el viaje quedó y no se pudo borrar, se dice.
    // (`request` de prueba no existe en afterAll; se abre un contexto propio.)
    // Revalida antes de crear el contexto incluso si cambió el entorno.
    entornoLocalE2E();
    const llave = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!llave) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY para la limpieza del viaje E2E.');
    const ctx = await apiRequest.newContext();
    try {
      const r = await ctx.delete(`${SUPABASE_URL}/rest/v1/viaje`, {
        params: { folio: `eq.${FOLIO}` },
        maxRedirects: 0,
        headers: { apikey: llave, Authorization: `Bearer ${llave}` },
      });
      if (!r.ok()) throw new Error(`La limpieza del viaje ${FOLIO} respondió ${r.status()}.`);
    } finally {
      await ctx.dispose();
    }
  });

  test('el viaje nace en el panel y el registro lo enseña abierto', async ({ page }) => {
    await page.goto('/dashboard/despacho');
    const forma = page.locator('form:has(button:has-text("Crear viaje"))');
    await forma.locator('#folio').fill(FOLIO);
    await forma.locator('#origen').fill('Silao, GTO');
    await forma.locator('#destino').fill('Monterrey, NL');
    await forma.locator('#anticipo').fill('8000');

    // El combo del chofer resuelve el id CONTRA lo que el servidor ofreció
    // (combo-catalogo.tsx): primero se teclea para disparar la búsqueda, y
    // cuando la opción ya llegó se teclea la etiqueta completa. La espera es
    // por condición: el <option> del datalist y el hidden con id resuelto.
    const combo = forma.locator('#operadorId');
    await combo.fill('Fernando');
    await expect(forma.locator('option[value="Fernando Aguilar Cruz"]')).toBeAttached();
    await combo.fill('Fernando Aguilar Cruz');
    await expect(forma.locator('input[type="hidden"][name="operadorId"]')).not.toHaveValue('');

    await forma.getByRole('button', { name: 'Crear viaje' }).click();
    // La señal de éxito es el dato en su fuente de verdad navegable, no un
    // toast: el registro, filtrado a abiertos y buscado por el folio único.
    await expect(async () => {
      await page.goto(`/dashboard/viajes?f=abiertos&q=${FOLIO}`);
      const fila = page.locator('tr', { hasText: FOLIO });
      await expect(fila).toContainText('Abierto');
      await expect(fila).toContainText('8,000');
    }).toPass({ timeout: 15_000 });
  });
});

test.describe('cifras y PDF de la liquidación cuadrada (VJ-2026-0844)', () => {
  test.use({ storageState: ESTADOS.duena });

  /** El href del PDF se descubre navegando, como el contralor; lo reusan las
   *  pruebas de negación de más abajo para atacar EXACTAMENTE el mismo id. */
  let pdfHref = '';

  test('el detalle enseña las cifras reales y ofrece el PDF', async ({ page }) => {
    await page.goto('/dashboard/viajes?f=liquidados');
    await page.locator('tr', { hasText: 'VJ-2026-0844' }).getByRole('link', { name: /Ver/ }).click();
    await expect(page).toHaveURL(/\/dashboard\/[0-9a-f-]{36}/);
    await expect(page.locator('body')).toContainText('VJ-2026-0844');
    // Anticipo = comprobado = $10,200 (seed): la cifra que cuadra el papel.
    await expect(page.locator('body')).toContainText('10,200');

    const enlace = page.locator('a', { hasText: 'Descargar PDF' });
    await expect(enlace).toBeVisible();
    pdfHref = (await enlace.getAttribute('href')) ?? '';
    expect(pdfHref).toMatch(/^\/api\/export\/pdf\//);

    // La descarga real: sesión → rol → tenant → URL firmada → bytes de PDF.
    const r = await getLocalE2E(page.request, pdfHref);
    expect(r.status()).toBe(200);
    const cuerpo = await r.body();
    expect(cuerpo.subarray(0, 5).toString()).toBe('%PDF-');
  });

  test('el MISMO PDF se niega a la otra flota (404) y al anónimo (401)', async ({ browser }) => {
    expect(pdfHref, 'la prueba anterior debió descubrir el href').not.toBe('');

    // La intrusa: sesión REAL de la Flota E2E B pidiendo el id exacto de la
    // liquidación de la Flota Demo. 404 y no 403 a propósito: quien pregunta
    // no debe poder distinguir "no existe" de "existe y no es tuyo".
    const contextoB = await browser.newContext({ storageState: ESTADOS.intrusa });
    try {
      const rIntrusa = await getLocalE2E(contextoB.request, pdfHref);
      expect(rIntrusa.status()).toBe(404);
    } finally {
      await contextoB.close();
    }

    // El anónimo: sin sesión no hay ni tenant que resolver.
    //
    // `storageState` EXPLÍCITO y vacío, no `browser.newContext()` a secas:
    // este describe trae `test.use({ storageState: ESTADOS.duena })` arriba,
    // y `newContext()` sin argumentos hereda esa opción del test como
    // default — un "anónimo" así en realidad seguía siendo la dueña, y la
    // ruta lo dejaba pasar de verdad (302 a la URL firmada, hallazgo real de
    // E.27, no un bug de la app: el mismo patrón que SÍ limpia la sesión en
    // admin-bloqueado.nav.ts, `test.use({ storageState: { cookies: [], origins: [] } })`,
    // pero declarado aquí porque hace falta DENTRO del test, no en todo el describe).
    const contextoAnon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const rAnon = await getLocalE2E(contextoAnon.request, pdfHref);
      expect(rAnon.status()).toBe(401);
    } finally {
      await contextoAnon.close();
    }
  });
});
