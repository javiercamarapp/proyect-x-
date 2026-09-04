import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import DashboardChrome from './chrome';

// La URL es una constante del propio test, no entrada del usuario.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const FUENTE = readFileSync(fileURLToPath(new URL('./chrome.tsx', import.meta.url)), 'utf8');

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => '/dashboard' }));

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 25, BAJO (línea 168) — `ROL_BADGE` traía `operador`, retirado del
// dominio de `app_user.rol` en la migración 0086 (el chofer solo tiene
// WhatsApp, ya no login), y le faltaba `vendedor`, agregado en la 0105. El
// comentario citaba solo 0044_rol_encargado.sql como "el dominio REAL" —
// cierto en su momento, desactualizado desde entonces. No rompía pantalla
// (`?? rol.toUpperCase()` cubre cualquier clave que falte) pero es deuda: el
// mapa debe reflejar el dominio vivo, igual que `admin/equipo/page.tsx`.
// ═══════════════════════════════════════════════════════════════════════════

describe('DashboardChrome — el badge de rol refleja el dominio VIVO de app_user.rol', () => {
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

  it('`operador` (retirado en 0086) ya no tiene entrada en ROL_BADGE', () => {
    const cuerpo = FUENTE.slice(FUENTE.indexOf('ROL_BADGE'), FUENTE.indexOf('};', FUENTE.indexOf('ROL_BADGE')));
    expect(cuerpo).not.toMatch(/operador\s*:/);
  });

  it('el comentario ya no cita SOLO 0044 como si fuera todo el dominio', () => {
    const comentario = FUENTE.slice(0, FUENTE.indexOf('const ROL_BADGE'));
    expect(comentario).toMatch(/0086/);
    expect(comentario).toMatch(/0105/);
  });
});
