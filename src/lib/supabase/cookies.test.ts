import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { COOKIES_DE_SESION } from './cookies';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA PROD (22-ago-2026) · SEG-3 — la cookie de sesión era legible por
// JavaScript.
//
// `@supabase/ssr` la escribe con `httpOnly: false` por default porque su
// cliente de NAVEGADOR necesita leerla. Aquí no hay cliente de navegador, así
// que ese permiso solo servía para que un XSS —el CSP de `proxy.ts` todavía
// lleva `script-src 'unsafe-inline'`— se llevara el token de sesión completo
// del contralor.
//
// Las dos pruebas de abajo son de distinta naturaleza a propósito:
//   1. la opción está puesta (unitaria);
//   2. LA PREMISA SIGUE SIENDO CIERTA: nadie en el cliente lee la cookie. Es
//      la que importa dentro de un año — el día que alguien meta un
//      `createBrowserClient` para "hidratar la sesión en el navegador", la
//      sesión dejará de funcionar y esta prueba dice POR QUÉ, en vez de
//      dejar a alguien depurando un login que no entra.
// ═══════════════════════════════════════════════════════════════════════════

const RAIZ = join(__dirname, '..', '..', '..');
const SRC = join(RAIZ, 'src');

function fuentes(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { fuentes(p, out); continue; }
    if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

describe('la cookie de sesión no la lee el navegador', () => {
  it('se impone httpOnly sobre el default del SDK', () => {
    expect(COOKIES_DE_SESION.httpOnly).toBe(true);
    expect(COOKIES_DE_SESION.sameSite).toBe('lax');
    expect(COOKIES_DE_SESION.path).toBe('/');
    expect(COOKIES_DE_SESION.secure).toBe(process.env.NODE_ENV === 'production');
  });

  it('el default del SDK instalado SIGUE siendo httpOnly:false (si cambia, esto sobra)', () => {
    const constantes = readFileSync(
      join(RAIZ, 'node_modules/@supabase/ssr/dist/main/utils/constants.js'), 'utf8',
    );
    expect(constantes).toContain('httpOnly: false');
  });

  it('los DOS clientes de servidor la aplican: proxy.ts y supabase/server.ts', () => {
    for (const f of ['src/proxy.ts', 'src/lib/supabase/server.ts']) {
      const texto = readFileSync(join(RAIZ, f), 'utf8');
      expect(texto, `${f} no pasa cookieOptions`).toContain('cookieOptions: COOKIES_DE_SESION');
      // Y lo repite sobre `options` del SDK, que es la cookie que sale.
      expect(texto, `${f} no lo repite al escribir`).toContain('...COOKIES_DE_SESION');
    }
  });

  it('LA PREMISA: ningún archivo del repo lee la cookie desde el navegador', () => {
    const culpables = fuentes(SRC)
      .filter((f) => !f.endsWith(join('lib', 'supabase', 'cookies.ts')))
      .filter((f) => {
        const t = readFileSync(f, 'utf8')
          // Los comentarios hablan de esto justamente para explicarlo.
          .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        return /document\.cookie|createBrowserClient|from ['"]js-cookie['"]/.test(t);
      })
      .map((f) => f.replace(RAIZ + '/', ''));

    expect(culpables, 'alguien lee la cookie desde el cliente: httpOnly le va a romper la sesión').toEqual([]);
  });
});
