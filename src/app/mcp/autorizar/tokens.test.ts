import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

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
// La prueba no mira la línea: mira TODAS las referencias sin fallback del
// archivo contra los tokens que `globals.css` define. Una prueba de la línea
// sola sería decoración — volvería a pasar con el siguiente `var(--typo)`.
// ═══════════════════════════════════════════════════════════════════════════

const PAGINA = readFileSync('src/app/mcp/autorizar/page.tsx', 'utf8');
const CSS = readFileSync('src/app/globals.css', 'utf8');

/** Los tokens que `globals.css` declara en cualquiera de sus bloques. */
const DEFINIDOS = new Set(
  [...CSS.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)].map((m) => m[1]),
);

/**
 * Las referencias `var(--x)` SIN fallback. `var(--faint, var(--muted))` no
 * entra: ahí el token ausente es una elección declarada, no un descuido.
 */
function referenciasSinFallback(fuente: string): string[] {
  return [...new Set([...fuente.matchAll(/var\((--[a-zA-Z0-9-]+)\)/g)].map((m) => m[1]))];
}

describe('FE-4 · la pantalla de consentimiento MCP no referencia tokens que no existen', () => {
  it('globals.css define tokens (si esto falla, el lector del CSS se rompió, no la pantalla)', () => {
    expect(DEFINIDOS.size).toBeGreaterThan(20);
    expect(DEFINIDOS.has('--ink')).toBe(true);
    expect(DEFINIDOS.has('--bg')).toBe(true);
  });

  it('cada var(--x) sin fallback de page.tsx está definido en globals.css', () => {
    // `--font-*` los inyecta `next/font` en el <html>, no globals.css.
    const referencias = referenciasSinFallback(PAGINA).filter((t) => !t.startsWith('--font-'));
    const huerfanos = referencias.filter((t) => !DEFINIDOS.has(t));
    expect(huerfanos, `tokens referenciados que nadie define: ${huerfanos.join(', ')}`).toEqual([]);
  });

  it('el botón que concede el acceso se pinta invertido, con los dos tokens de la paleta', () => {
    const boton = PAGINA.slice(PAGINA.indexOf("value=\"autorizar\""));
    const estilo = boton.slice(0, boton.indexOf('>'));
    expect(estilo).toContain('var(--ink)');
    expect(estilo).toContain('var(--bg)');
  });
});
