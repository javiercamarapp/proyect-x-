import { test, expect } from './apoyo/fixture';
import { ESTADOS } from './apoyo/sesion';

test.use({ storageState: ESTADOS.duena });

const formularios = [
  { ruta: '/dashboard/viajes', etiqueta: 'CSV o Excel con los viajes', nombre: 'viajes.csv', mime: 'text/csv' },
  { ruta: '/dashboard/agentes/peajes', etiqueta: 'Desglose del proveedor de peaje (Excel, CSV o PDF)', nombre: 'peajes.csv', mime: 'text/csv' },
  { ruta: '/dashboard/agentes/proveedores', etiqueta: 'Foto de la factura de proveedor', nombre: 'factura.png', mime: 'image/png' },
];

for (const formulario of formularios) {
  test(`${formulario.ruta}: avisa del archivo excesivo antes de enviarlo`, async ({ page }) => {
    await page.goto(formulario.ruta);
    if (formulario.ruta === '/dashboard/viajes') {
      await page.locator('summary').filter({ hasText: 'Importar desde tu TMS' }).click();
    }
    const archivo = page.getByLabel(formulario.etiqueta, { exact: true });
    await expect(archivo).toBeVisible();

    // Una regresión tampoco debe invocar OCR ni crear registros durante el test.
    let envios = 0;
    await page.route('**/*', async (ruta) => {
      if (ruta.request().method() === 'POST') { envios++; await ruta.abort(); }
      else await ruta.fallback();
    });
    await archivo.evaluate((elemento) => {
      elemento.addEventListener('invalid', () => { elemento.setAttribute('data-rechazado', 'true'); });
    });
    await archivo.setInputFiles({ name: formulario.nombre, mimeType: formulario.mime, buffer: Buffer.alloc(5 * 1024 * 1024) });
    await expect(archivo).toHaveJSProperty('validationMessage', 'Máximo 4 MB por archivo. Divide el archivo en partes más pequeñas o reduce la foto.');
    await archivo.locator('xpath=..').getByRole('button').click();
    await expect(archivo).toHaveAttribute('data-rechazado', 'true');
    expect(envios).toBe(0);

    // Cambiar a un archivo admisible elimina el error anterior sin enviarlo.
    await archivo.setInputFiles({ name: formulario.nombre, mimeType: formulario.mime, buffer: Buffer.from('archivo pequeño') });
    await expect(archivo).toHaveJSProperty('validationMessage', '');
    expect(await archivo.evaluate((elemento) => (elemento as HTMLInputElement).validity.valid)).toBe(true);
  });
}
