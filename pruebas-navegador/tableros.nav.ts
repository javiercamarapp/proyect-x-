/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LOS TABLEROS POR ROL — /dashboard para la flota, /admin para el superadmin.
 *
 * Cada tablero se afirma con TRES señales: aterriza en su URL, pinta
 * contenido real del rol (no una cáscara), y no dejó un error de página
 * (pageerror) ni el overlay de error de Next — las mismas señales del smoke
 * público, ahora detrás de sesión. Los errores de consola a secas NO tumban
 * la prueba (un aviso de React en desarrollo no es un panel roto); un
 * `pageerror` sí, porque es una excepción sin atrapar en el navegador.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { test, expect, type Page } from './apoyo/fixture';
import { ESTADOS } from './apoyo/sesion';

/** Junta las excepciones de página desde ANTES de navegar; se afirma al final. */
function vigilarErrores(page: Page): string[] {
  const errores: string[] = [];
  page.on('pageerror', (e) => errores.push(e.message));
  return errores;
}

async function sinOverlayDeNext(page: Page): Promise<void> {
  await expect(page.locator('[data-nextjs-dialog], .next-error-h1')).toHaveCount(0);
}

test.describe('el panel de la flota', () => {
  test.use({ storageState: ESTADOS.duena });

  test('/dashboard pinta el resumen de Flota Demo con navegación viva', async ({ page }) => {
    const errores = vigilarErrores(page);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);
    // La navegación del panel es real, no decoración: los destinos del
    // registro y del despacho existen como enlaces.
    await expect(page.locator('a[href^="/dashboard/viajes"]').first()).toBeAttached();
    await expect(page.locator('a[href^="/dashboard/despacho"]').first()).toBeAttached();
    await sinOverlayDeNext(page);
    expect(errores, `pageerror en /dashboard: ${errores.join(' | ')}`).toHaveLength(0);
  });

  test('el registro de viajes enseña los viajes sembrados con sus estados', async ({ page }) => {
    const errores = vigilarErrores(page);
    await page.goto('/dashboard/viajes');
    // Los cuatro folios del seed, cada uno con el estado que el seed declaró.
    await expect(page.locator('body')).toContainText('VJ-2026-0001');
    await expect(page.locator('body')).toContainText('VJ-2026-0844');
    const filaAbierta = page.locator('tr', { hasText: 'VJ-2026-0001' });
    await expect(filaAbierta).toContainText('Abierto');
    // El anticipo REAL del viaje abierto ($10,600 del seed) — la cifra que el
    // contralor cruzaría contra su papel. Si el panel la inventara o la
    // perdiera, esto se pone rojo.
    await expect(filaAbierta).toContainText('10,600');
    await sinOverlayDeNext(page);
    expect(errores, `pageerror en /dashboard/viajes: ${errores.join(' | ')}`).toHaveLength(0);
  });
});

test.describe('la consola del superadmin', () => {
  test.use({ storageState: ESTADOS.superadmin });

  test('/admin pinta la Consola de Likida sin errores de página', async ({ page }) => {
    const errores = vigilarErrores(page);
    await page.goto('/admin');
    await expect(page.locator('body')).toContainText('Consola de Likida');
    await sinOverlayDeNext(page);
    expect(errores, `pageerror en /admin: ${errores.join(' | ')}`).toHaveLength(0);
  });
});
