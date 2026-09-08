import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import DashboardChrome from './chrome';
import { ROL_BADGE } from '@/lib/auth/provisionar';

// La URL es una constante del propio test, no entrada del usuario.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const FUENTE_CHROME = readFileSync(fileURLToPath(new URL('./chrome.tsx', import.meta.url)), 'utf8');
// eslint-disable-next-line security/detect-non-literal-fs-filename
const FUENTE_PROVISIONAR = readFileSync(fileURLToPath(new URL('../../lib/auth/provisionar.ts', import.meta.url)), 'utf8');

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => '/dashboard' }));

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 25, BAJO (línea 168) — `ROL_BADGE` traía `operador`, retirado del
// dominio de `app_user.rol` en la migración 0086 (el chofer solo tiene
// WhatsApp, ya no login), y le faltaba `vendedor`, agregado en la 0105.
//
// AUDITORÍA 28, ARQ-B5 (BAJO, reincidente 26/27) — `ROL_BADGE` era la QUINTA
// copia del dominio de roles, declarada aquí mismo (`chrome.tsx`) sin tipar,
// y `rol_label_unico.test.ts` (que vigila `ROL_LABEL`) casaba por NOMBRE:
// no la veía. Esta prueba se reescribe a propósito para fijar la forma
// NUEVA: `chrome.tsx` ya NO declara `ROL_BADGE` — lo IMPORTA de
// `@/lib/auth/provisionar`, la misma fuente de `ROL_LABEL`, exhaustiva
// (`Record<RolAppUser, string>`) y sin `operador`.
// ═══════════════════════════════════════════════════════════════════════════

describe('DashboardChrome — el badge de rol viene de la fuente única (provisionar.ts)', () => {
  it('vendedor (0105) tiene su propio badge, no cae al fallback de mayúsculas', () => {
    const html = renderToStaticMarkup(
      <DashboardChrome nombre="Ana" rol="vendedor">
        <div />
      </DashboardChrome>,
    );
    expect(html).toContain('VENDEDOR');
  });

  it('cada uno de los cinco roles vivos pinta su badge explícito', () => {
    const ESPERADO: Record<string, string> = {
      superadmin: 'SUPERADMIN',
      flota_admin: 'ADMIN FLOTA',
      contador: 'CONTADOR',
      encargado: 'ENCARGADO',
      vendedor: 'VENDEDOR',
    };
    for (const [rol, badge] of Object.entries(ESPERADO)) {
      const html = renderToStaticMarkup(
        <DashboardChrome nombre="Ana" rol={rol}>
          <div />
        </DashboardChrome>,
      );
      expect(html, rol).toContain(badge);
    }
  });

  it('chrome.tsx NO declara su propio ROL_BADGE: lo importa de @/lib/auth/provisionar', () => {
    expect(FUENTE_CHROME).not.toMatch(/(const|let)\s+ROL_BADGE/);
    expect(FUENTE_CHROME).toMatch(/import\s*\{[^}]*ROL_BADGE[^}]*\}\s*from\s*['"]@\/lib\/auth\/provisionar['"]/);
  });

  it('ROL_BADGE (en provisionar.ts) cubre RolAppUser entero, sin `operador`', () => {
    expect(Object.keys(ROL_BADGE).sort()).toEqual(['contador', 'encargado', 'flota_admin', 'superadmin', 'vendedor']);
  });

  it('`operador` (retirado en 0086) ya no tiene entrada en ROL_BADGE', () => {
    const desde = FUENTE_PROVISIONAR.indexOf('export const ROL_BADGE');
    const cuerpo = FUENTE_PROVISIONAR.slice(desde, FUENTE_PROVISIONAR.indexOf('};', desde));
    expect(cuerpo).not.toMatch(/operador\s*:/);
  });

  it('el comentario de ROL_BADGE (provisionar.ts) cita 0086 y 0105', () => {
    const comentario = FUENTE_PROVISIONAR.slice(0, FUENTE_PROVISIONAR.indexOf('export const ROL_BADGE'));
    expect(comentario).toMatch(/0086/);
    expect(comentario).toMatch(/0105/);
  });
});
