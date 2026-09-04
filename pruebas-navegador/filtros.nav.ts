/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FILTROS DEL REGISTRO — "si un filtro está en pantalla, mueve TODO lo que
 * hay debajo" (regla de la casa). No basta con que el chip cambie de color:
 * se afirma que las FILAS cambian — lo que el filtro promete aparece y lo
 * que excluye desaparece. El seed deja 1 viaje abierto (VJ-2026-0001) y 3
 * liquidados (0844/0845/0846), así que cada filtro tiene un positivo y un
 * negativo conocidos.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { test, expect } from './apoyo/fixture';
import { ESTADOS } from './apoyo/sesion';

test.use({ storageState: ESTADOS.duena });

test('«Liquidados» enseña los liquidados y esconde el abierto', async ({ page }) => {
  await page.goto('/dashboard/viajes');
  await page.getByRole('link', { name: 'Liquidados', exact: true }).click();
  await expect(page).toHaveURL(/f=liquidados/);
  await expect(page.locator('body')).toContainText('VJ-2026-0844');
  await expect(page.locator('body')).toContainText('VJ-2026-0846');
  await expect(page.locator('body')).not.toContainText('VJ-2026-0001');
});

test('«Abiertos» enseña el abierto y esconde los liquidados', async ({ page }) => {
  await page.goto('/dashboard/viajes');
  await page.getByRole('link', { name: 'Abiertos', exact: true }).click();
  await expect(page).toHaveURL(/f=abiertos/);
  await expect(page.locator('body')).toContainText('VJ-2026-0001');
  await expect(page.locator('body')).not.toContainText('VJ-2026-0844');
});

test('el filtro también entra por URL directa (un marcador guardado filtra igual)', async ({ page }) => {
  await page.goto('/dashboard/viajes?f=liquidados');
  await expect(page.locator('body')).toContainText('VJ-2026-0845');
  await expect(page.locator('body')).not.toContainText('VJ-2026-0001');
});

test('la búsqueda por folio acota a esa fila y respeta el filtro', async ({ page }) => {
  await page.goto('/dashboard/viajes');
  const buscador = page.locator('input[name="q"]');
  await buscador.fill('VJ-2026-0845');
  await buscador.press('Enter');
  await expect(page).toHaveURL(/q=VJ-2026-0845/);
  await expect(page.locator('body')).toContainText('VJ-2026-0845');
  await expect(page.locator('body')).not.toContainText('VJ-2026-0844');
  await expect(page.locator('body')).not.toContainText('VJ-2026-0001');
});
