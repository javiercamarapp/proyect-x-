/**
 * Proyecto `preparar`: hace el login REAL (magic link vía Mailpit) una vez
 * por identidad y guarda las cookies en .estado/ para que el resto de la
 * suite no pague 3 correos por archivo. El login como flujo con sus
 * afirmaciones vive en login.nav.ts — aquí solo se exige que cada identidad
 * aterrice donde su rol manda, porque un estado guardado a medias haría
 * pasar en falso todo lo que dependa de él.
 */
import { test as preparar, expect } from './apoyo/fixture';
import { CORREOS, ESTADOS, entrar } from './apoyo/sesion';

preparar('dueña (flota_admin de Flota Demo) → /dashboard', async ({ page }) => {
  await entrar(page, CORREOS.duena);
  await expect(page).toHaveURL(/\/dashboard/);
  await page.context().storageState({ path: ESTADOS.duena });
});

preparar('superadmin → territorio /admin (hoy aterriza en el selector de flota — ver login.nav.ts)', async ({ page }) => {
  await entrar(page, CORREOS.superadmin);
  // Basta con "algo bajo /admin": las cookies son válidas de cualquier forma
  // — admin-bloqueado.nav.ts y tableros.nav.ts navegan a /admin directo con
  // este mismo estado y sí ven la consola. El detalle de A DÓNDE aterriza el
  // login recién hecho (spoiler: /admin/elegir-flota, no /admin) se afirma
  // en login.nav.ts, no aquí.
  await expect(page).toHaveURL(/\/admin/);
  await page.context().storageState({ path: ESTADOS.superadmin });
});

preparar('intrusa (flota_admin de Flota E2E B) → /dashboard', async ({ page }) => {
  await entrar(page, CORREOS.intrusa);
  await expect(page).toHaveURL(/\/dashboard/);
  await page.context().storageState({ path: ESTADOS.intrusa });
});
