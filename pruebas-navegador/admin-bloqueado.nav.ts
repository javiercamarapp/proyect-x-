/**
 * ═══════════════════════════════════════════════════════════════════════════
 * /admin BLOQUEADO — prueba de AISLAMIENTO, no de UI.
 *
 * No se comprueba que el enlace no aparezca en el menú (esconder el botón no
 * es controlar el acceso): se pide /admin POR URL DIRECTA con credenciales
 * reales de flota, y se afirma que la respuesta rebota al panel del tenant
 * sin haber servido nada de la consola. Las dos flotas sembradas lo
 * intentan, y también el anónimo. La puerta que se está probando es
 * `requireSuperadmin()` en admin/layout.tsx, que cubre todo /admin/*.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { test, expect } from './apoyo/fixture';
import { ESTADOS } from './apoyo/sesion';

/** Las rutas que se atacan: la raíz y dos hondas, elegidas porque enseñan lo
 *  más caro de la consola (dinero de Likida y datos cruzados de tenants). */
const OBJETIVOS = ['/admin', '/admin/analitica', '/admin/consumo'];

test.describe('con credenciales de la Flota Demo (flota_admin)', () => {
  test.use({ storageState: ESTADOS.duena });

  for (const ruta of OBJETIVOS) {
    test(`${ruta} por URL directa rebota a /dashboard sin pintar la consola`, async ({ page }) => {
      await page.goto(ruta);
      await expect(page).toHaveURL(/\/dashboard/);
      await expect(page.locator('body')).not.toContainText('Consola de Likida');
    });
  }
});

test.describe('con credenciales de la otra flota (Flota E2E B)', () => {
  test.use({ storageState: ESTADOS.intrusa });

  test('/admin por URL directa rebota a /dashboard', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.locator('body')).not.toContainText('Consola de Likida');
  });
});

test.describe('sin sesión', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('/admin manda a /login, no a una consola vacía', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('body')).not.toContainText('Consola de Likida');
  });
});

test.describe('el superadmin sí entra (el candado no está soldado)', () => {
  test.use({ storageState: ESTADOS.superadmin });

  test('/admin sirve la consola al único rol que la posee', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin/);
    await expect(page.locator('body')).toContainText('Consola de Likida');
  });
});
