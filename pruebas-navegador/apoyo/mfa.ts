import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import { entornoLocalE2E } from '../../scripts/ci/e2e/entorno-local.mjs';
import { codigoTotp } from '../../scripts/ci/e2e/totp.mjs';

const archivo = 'pruebas-navegador/.estado/superadmin-mfa.json';

/** Inscripción y verificación reales por UI. La semilla sintética queda local,
 * junto a las cookies ignoradas por Git, con permisos 0600; nunca se imprime. */
export async function completarMfaSuperadmin(page: Page) {
  const entorno = entornoLocalE2E();
  await page.goto('/dashboard/mi-perfil');
  await expect(page.getByRole('heading', { name: 'Seguridad — segundo factor', exact: true })).toBeVisible();
  const activar = page.getByRole('link', { name: 'Activar segundo factor', exact: true });
  let estado: { secreto: string; app: string; supabase: string; ultimoPaso: number };
  let boton = 'Verificar sesión';
  if (await activar.isVisible()) {
    await activar.click();
    const texto = await page.getByText('Si no puedes escanear:').textContent();
    const secreto = texto?.match(/Si no puedes escanear:\s*([A-Z2-7]+)/)?.[1];
    if (!secreto) throw new Error('La UI no entregó la semilla del factor local');
    estado = { secreto, app: entorno.app, supabase: entorno.supabase, ultimoPaso: -1 };
    await mkdir('pruebas-navegador/.estado', { recursive: true });
    await writeFile(archivo, JSON.stringify(estado), { mode: 0o600 });
    boton = 'Activar';
  } else {
    estado = JSON.parse(await readFile(archivo, 'utf8'));
    if (estado.app !== entorno.app || estado.supabase !== entorno.supabase) {
      throw new Error('El factor guardado pertenece a otro entorno local');
    }
  }
  // GoTrue impide reutilizar el código anterior: esperar sólo si sigue vigente.
  await expect.poll(() => Math.floor(Date.now() / 30_000), { timeout: 31_000 })
    .toBeGreaterThan(estado.ultimoPaso);
  const paso = Math.floor(Date.now() / 30_000);
  const forma = page.locator('form').filter({ has: page.getByRole('button', { name: boton, exact: true }) });
  await forma.locator('input[name="codigo"]').fill(codigoTotp(estado.secreto, paso * 30_000));
  await forma.getByRole('button', { name: boton, exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/mi-perfil\?.*ok=mfa/);
  estado.ultimoPaso = paso;
  await writeFile(archivo, JSON.stringify(estado), { mode: 0o600 });
}
