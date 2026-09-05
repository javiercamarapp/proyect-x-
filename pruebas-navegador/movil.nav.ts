/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LA VISTA MÓVIL — el panel en un teléfono real de catálogo (Pixel 7:
 * 412×915, DPR 2.625, táctil, user-agent móvil; proyecto `movil` del
 * playwright.config, NO una ventana de escritorio encogida).
 *
 * HUECO DECLARADO — LA VISTA DEL CHOFER NO EXISTE COMO WEB. El chofer
 * (rol `operador`) perdió el login web el 7-ago-2026 a propósito: su
 * interfaz es WhatsApp (ver lib/auth/permisos.ts: «su interfaz es WhatsApp,
 * no exporta nada desde la web», e invitar.ts, que rebota el rol). No se
 * escribe aquí una prueba que finja probarla. Lo que SÍ existe en un
 * teléfono — y aquí se prueba — es el panel del dueño/encargado, que
 * despacha desde la cabina o el patio con el celular. La conversación del
 * chofer se prueba donde vive: los arneses de WhatsApp.
 *
 * Otro hueco declarado: solo Chromium (el navegador del andamio del smoke);
 * la vista iOS/WebKit no está cubierta.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { test, expect, type Page } from './apoyo/fixture';
import { ESTADOS } from './apoyo/sesion';

test.use({ storageState: ESTADOS.duena });

/** La página entera no debe scrollear de lado: lo ancho (tablas) scrollea
 *  dentro de su propio contenedor. Un desborde horizontal en móvil es la
 *  pantalla rota clásica que el escritorio nunca enseña. */
async function sinDesbordeHorizontal(page: Page): Promise<void> {
  const desborde = await page.evaluate(() => {
    const raiz = document.scrollingElement ?? document.documentElement;
    return raiz.scrollWidth - window.innerWidth;
  });
  expect(desborde, 'la página scrollea horizontal en un viewport de teléfono').toBeLessThanOrEqual(1);
}

test('el resumen carga en el teléfono sin desborde y con la navegación a mano', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.locator('a[href^="/dashboard/viajes"]').first()).toBeVisible();
  await sinDesbordeHorizontal(page);
});

test('del resumen al registro navegando con el dedo, y la tabla es legible', async ({ page }) => {
  await page.goto('/dashboard');
  // El rail de navegación colapsa a íconos bajo `lg` (MARCO_SIDEBAR): el
  // destino se toca, no se lee — como lo haría el pulgar.
  await page.locator('aside a[href^="/dashboard/viajes"]').first().tap();
  await expect(page).toHaveURL(/\/dashboard\/viajes/);
  await expect(page.locator('body')).toContainText('VJ-2026-0001');
  await sinDesbordeHorizontal(page);
});

test('los filtros del registro también funcionan a dedo', async ({ page }) => {
  await page.goto('/dashboard/viajes');
  await page.getByRole('link', { name: 'Liquidados', exact: true }).tap();
  await expect(page).toHaveURL(/f=liquidados/);
  await expect(page.locator('body')).toContainText('VJ-2026-0844');
  await expect(page.locator('body')).not.toContainText('VJ-2026-0001');
  await sinDesbordeHorizontal(page);
});
