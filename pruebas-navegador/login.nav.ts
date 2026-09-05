/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LOGIN Y SESIÓN — el flujo real de producción, correo incluido.
 *
 * Lo que se afirma y por qué:
 *   · Sin sesión, el panel rebota a /login CON el destino (las dos capas:
 *     proxy.ts por matcher y requireSessionTenant en la página).
 *   · El magic link entero: formulario → correo (Mailpit) → enlace → sesión
 *     → panel. Nada inyecta cookies a mano.
 *   · El superadmin debe inscribir y verificar un segundo factor real.
 *     El magic link por sí solo no permite entrar a /admin. El helper usa
 *     el secreto mostrado por la UI local, como una app de autenticación;
 *     GoTrue valida el código y entrega la sesión AAL2.
 *   · El anti-oráculo (auditoría 18, M24): un correo sin cuenta ve la misma
 *     confirmación Y no recibe correo — sin esperar por reloj: el testigo es
 *     un correo real pedido DESPUÉS por el mismo SMTP; cuando ése ya llegó,
 *     el del inexistente tuvo su oportunidad y no está.
 *
 * Estas pruebas piden 4 de los 7 correos del presupuesto (ver apoyo/sesion).
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { test, expect } from './apoyo/fixture';
import { CORREOS, entrar, pedirEnlace, mensajesDe, enlaceDelCorreo } from './apoyo/sesion';
import { completarMfaSuperadmin } from './apoyo/mfa';

test('sin sesión, /dashboard rebota a /login y conserva el destino', async ({ page }) => {
  await page.goto('/dashboard/viajes');
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard%2Fviajes/);
  await expect(page.locator('input[type="email"]')).toBeVisible();
});

test('la dueña entra por el enlace del correo y ve el panel de SU flota', async ({ page }) => {
  await entrar(page, CORREOS.duena);
  await expect(page).toHaveURL(/\/dashboard/);
  // Contenido real del tenant sembrado, no una cáscara: el chrome del panel
  // saluda con el nombre de la flota o de la persona.
  await expect(page.locator('body')).toContainText(/Flota Demo|Dueña E2E/);
});

test('el superadmin debe verificar el segundo factor antes de abrir su consola', async ({ page }) => {
  await entrar(page, CORREOS.superadmin);
  await expect(page).toHaveURL(/\/dashboard\/mi-perfil\?exige=retar/);
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/dashboard\/mi-perfil\?exige=retar/);
  await completarMfaSuperadmin(page);
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.locator('body')).toContainText('Consola de Likida');
});

test('un correo sin cuenta: misma pantalla, ningún correo (anti-oráculo)', async ({ page }) => {
  const fantasma = 'no.existe.e2e@likida.test';
  const desde = Date.now();

  // 1. El inexistente ve EXACTAMENTE la confirmación de "enviado" — la
  //    afirmación vive dentro de pedirEnlace; si la pantalla distinguiera,
  //    sería un oráculo para enumerar contralores.
  await pedirEnlace(page, fantasma);

  // 2. El testigo: un correo real pedido DESPUÉS. Se espera a que ÉSE llegue
  //    (condición, no reloj): pasó por el mismo GoTrue y el mismo SMTP, así
  //    que el del fantasma — pedido antes — ya tuvo su oportunidad.
  await pedirEnlace(page, CORREOS.duena);
  await enlaceDelCorreo(page.request, CORREOS.duena, desde);

  expect(await mensajesDe(page.request, fantasma, desde)).toHaveLength(0);
});
