import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 26, FE-4 (ALTO). UN TOKEN QUE NO EXISTE NO ES UN COLOR FEO: ES
// NINGÚN COLOR.
//
// `contraste.test.ts` mide los tokens que `globals.css` DEFINE. No puede ver
// el defecto opuesto —una pantalla que REFERENCIA un token que nadie definió—
// y por eso el botón «Autorizar lectura» de la pantalla de consentimiento MCP
// llevaba `background: var(--fg)` sobre `color: var(--bg)` con `--fg`
// inexistente en todo el repo (la tinta de esta paleta se llama `--ink`).
// `var()` sin valor y sin fallback deja la declaración inválida: el botón se
// queda con el fondo de la página y su texto pintado del color de la página.
// Sobre `#fbfbfd` en claro y `#09090b` en oscuro eso es **1.00:1** — el único
// botón que hace algo en la pantalla donde alguien concede acceso de lectura a
// las cifras de su flota, invisible en los dos temas.
//
// AUDITORÍA 28, FE-B2 (BAJO, reincidente). Esta prueba nació mirando SOLO
// `mcp/autorizar/page.tsx` contra SOLO `globals.css`. Con ese recorte,
// `login.css` (y `login/page.tsx`, que la usa) salían como DOS «huérfanos»
// falsos: `--crema`/`--serif-marca`/`--sans-marca` SÍ están definidos, pero
// en `login.css`, no en `globals.css` — la prueba no los veía y habría
// reportado un defecto que no existe. El barrido se amplía a TODOS los
// `.tsx`/`.ts`/`.css` de producción bajo `src/app` (tokens definidos en
// CUALQUIER `.css` de ahí, referencias buscadas en TODOS los archivos), que
// hoy sale verde con 0 huérfanos reales — no es un blanco que se cumpla
// algún día, ya se cumple.
//
// La prueba no mira la línea: mira TODAS las referencias sin fallback contra
// TODOS los tokens que `src/app` define. Una prueba de la línea sola sería
// decoración — volvería a pasar con el siguiente `var(--typo)`.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Todos los `.tsx`/`.ts`/`.css` de PRODUCCIÓN bajo un directorio: sin
 * pruebas (`.test.`), sin `.d.ts`, sin previews temporales (`zzz-*`,
 * `sin_previews.test.ts` ya los prohíbe en el árbol, pero este barrido no
 * depende de esa prueba para estar limpio).
 *
 * `fuentesDeProduccion` (lib/pruebas/codigo.ts) hace lo mismo para
 * `.ts`/`.tsx`, pero NO incluye `.css` — aquí se recorren los tres tipos a
 * mano porque el defecto que este archivo vigila vive tanto en el CSS que
 * DEFINE tokens como en el TSX que los REFERENCIA.
 */
function archivosDeProduccion(dir: string): string[] {
  const salida: string[] = [];
  // `dir` recorre el árbol propio del repo (`src/app` y sus subcarpetas),
  // nunca entrada externa: es el mismo patrón de recorrido que
  // `fuentesDeProduccion` (lib/pruebas/codigo.ts).
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name.startsWith('zzz-')) continue;
      salida.push(...archivosDeProduccion(`${dir}/${e.name}`));
      continue;
    }
    if (!/\.(tsx?|css)$/.test(e.name)) continue;
    if (e.name.includes('.test.') || e.name.endsWith('.d.ts')) continue;
    salida.push(`${dir}/${e.name}`);
  }
  return salida;
}

const ARCHIVOS = archivosDeProduccion('src/app');
const ARCHIVOS_CSS = ARCHIVOS.filter((f) => f.endsWith('.css'));

/**
 * Los tokens que declara CUALQUIER `.css` de producción bajo `src/app` (hoy:
 * `globals.css` + `login.css`). Limitación conocida y aceptable: un token
 * definido en `login.css` cuenta como "definido" aunque se use fuera de
 * `login/` — hoy son 0 los casos así, y si mañana existe uno, `contraste.
 * test.ts` (que sí mide por pantalla) lo vería primero.
 */
const DEFINIDOS = new Set(
  ARCHIVOS_CSS.flatMap((f) => {
    // `f` sale del propio barrido de `archivosDeProduccion` de arriba, nunca
    // de entrada externa.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const fuente = readFileSync(f, 'utf8');
    return [...fuente.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)].map((m) => m[1]);
  }),
);

/**
 * Las referencias `var(--x)` SIN fallback. `var(--faint, var(--muted))` no
 * entra: ahí el token ausente es una elección declarada, no un descuido.
 */
function referenciasSinFallback(fuente: string): string[] {
  return [...new Set([...fuente.matchAll(/var\((--[a-zA-Z0-9-]+)\)/g)].map((m) => m[1]))];
}

describe('FE-4/FE-B2 · ninguna pantalla de src/app referencia un token que nadie define', () => {
  it('los .css de src/app definen tokens (si esto falla, el lector se rompió, no las pantallas)', () => {
    expect(ARCHIVOS_CSS.length).toBeGreaterThanOrEqual(2);
    expect(DEFINIDOS.size).toBeGreaterThan(20);
    expect(DEFINIDOS.has('--ink')).toBe(true);
    expect(DEFINIDOS.has('--bg')).toBe(true);
    // Definido en login.css, no en globals.css — la prueba de la 26 no lo veía.
    expect(DEFINIDOS.has('--crema')).toBe(true);
  });

  it('cada var(--x) sin fallback de TODOS los .tsx/.ts/.css de src/app está definido en algún .css de src/app', () => {
    // `--font-*` los inyecta `next/font` en el <html>, no un .css de aquí.
    const huerfanosPorArchivo: Record<string, string[]> = {};
    for (const archivo of ARCHIVOS) {
      // `archivo` sale del propio barrido de `archivosDeProduccion`.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const referencias = referenciasSinFallback(readFileSync(archivo, 'utf8')).filter((t) => !t.startsWith('--font-'));
      const huerfanos = referencias.filter((t) => !DEFINIDOS.has(t));
      if (huerfanos.length > 0) huerfanosPorArchivo[archivo] = huerfanos;
    }
    expect(huerfanosPorArchivo, `tokens referenciados que nadie define: ${JSON.stringify(huerfanosPorArchivo)}`).toEqual({});
  });

  it('el barrido no está ciego: encuentra ≥100 archivos con var(-- y sigue viendo mcp/autorizar/page.tsx', () => {
    // Medido el 6-sep-2026: 245 en `src/` completo, la mayoría en `src/app`.
    // Un barrido que "pasara" porque devolvió 0 archivos sería una prueba
    // verde por la razón equivocada.
    // `f` sale del propio barrido de `archivosDeProduccion`.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const conVar = ARCHIVOS.filter((f) => readFileSync(f, 'utf8').includes('var(--'));
    expect(conVar.length).toBeGreaterThanOrEqual(100);
    expect(conVar).toContain('src/app/mcp/autorizar/page.tsx');
  });

  it('el botón que concede el acceso (MCP) se pinta invertido, con los dos tokens de la paleta', () => {
    const PAGINA = readFileSync('src/app/mcp/autorizar/page.tsx', 'utf8');
    const boton = PAGINA.slice(PAGINA.indexOf('value="autorizar"'));
    const estilo = boton.slice(0, boton.indexOf('>'));
    expect(estilo).toContain('var(--ink)');
    expect(estilo).toContain('var(--bg)');
  });
});
