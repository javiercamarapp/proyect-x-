import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AUDITORÍA 28, FIS-M1 (MEDIO). La RFA 2026 regla 2.9 (normas/rfa-2026-2.9.yaml,
 * verificado_fuente_primaria) dice SOLO "carga federal". Este formulario
 * preguntaba "¿Dedicación exclusiva a transporte de carga federal / pasaje /
 * turismo?" — un "sí" de una flota de pasaje o turismo abría la facilidad del
 * 15% de combustible en efectivo (y el estímulo de peaje) sin que la regla la
 * cubriera. Pasaje/turismo foráneo es materia de la RFA 3.12, que no tiene
 * ficha en este repo: fail-closed hasta que exista.
 *
 * `forma.tsx` es un Client Component (JSX) sin infraestructura de render en
 * vitest (ver vitest.config.ts: las vistas de src/app se verifican mirando el
 * render, no con testing-library). Se prueba el texto tal cual vive en el
 * fuente — mismo patrón que panel_dueno_href.test.ts.
 */
describe('forma.tsx — la pregunta de dedicación exclusiva no cubre pasaje/turismo', () => {
  it('la etiqueta del selector "dedicacion" no menciona pasaje ni turismo', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/app/dashboard/onboarding/forma.tsx'), 'utf8');
    const m = /nombre="dedicacion"\s+etiqueta="([^"]+)"/.exec(src);
    expect(m, 'no se encontró el Selector nombre="dedicacion" en forma.tsx').not.toBeNull();
    const etiqueta = (m as RegExpExecArray)[1].toLowerCase();
    expect(etiqueta).not.toMatch(/pasaje|turismo/);
    expect(etiqueta).toMatch(/carga federal/);
  });
});
