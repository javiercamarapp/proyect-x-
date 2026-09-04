/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LOGIN Y SESIÓN — el flujo real de producción, correo incluido.
 *
 * Lo que se afirma y por qué:
 *   · Sin sesión, el panel rebota a /login CON el destino (las dos capas:
 *     proxy.ts por matcher y requireSessionTenant en la página).
 *   · El magic link entero: formulario → correo (Mailpit) → enlace → sesión
 *     → panel. Nada inyecta cookies a mano.
 *   · El aterrizaje depende del rol — pero no como dice el comentario de
 *     `auth/callback/route.ts`. Ese código promete que "sin next explícito"
 *     el superadmin cae directo en /admin (`puertaDeEntrada`); en los
 *     HECHOS, el formulario de /login SIEMPRE manda `next=/dashboard`
 *     (`login/page.tsx:94`, sin `?next=` en la URL de origen), así que
 *     `destinoExplicito` nunca es null para un login real por el
 *     formulario — la puerta directa de `puertaDeEntrada` es HOY
 *     inalcanzable desde la UI. El superadmin aterriza en /dashboard,
 *     que sin tenant lo manda a /admin/elegir-flota (requireSessionTenant).
 *     Sigue siendo funcional (un clic en "Volver a la consola" y está en
 *     /admin) — hallazgo de E.27, no arreglado aquí: tocar el fallback de
 *     `next` en login/page.tsx es cambiar el login real de producción, y
 *     ese archivo no lo toca esta rama. flota_admin sí cae en /dashboard
 *     tal cual, porque ESE es su `puertaDeEntrada` de todos modos.
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

test('el superadmin aterriza en el selector de flota, y de ahí entra a su consola', async ({ page }) => {
  await entrar(page, CORREOS.superadmin);
  // Ver el comentario de cabecera: HOY aterriza en /admin/elegir-flota, no
  // directo en /admin — sigue siendo funcional, no un callejón sin salida.
  await expect(page).toHaveURL(/\/admin\/elegir-flota/);
  await expect(page.locator('body')).toContainText('¿Qué flota quieres ver?');
  await page.getByRole('link', { name: 'Volver a la consola' }).click();
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
