// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 25 · DATOS-M3 (REINCIDENTE DATOS-24) — `on delete set null` de la
// FK compuesta `app_user_operador_tenant_fkey` trae SU lista de columnas.
//
// En Postgres, `ON DELETE SET NULL` sobre una FK COMPUESTA sin lista de
// columnas anula TODAS las columnas de la FK — aquí `operador_id` Y
// `tenant_id`. `app_user.tenant_id` es nullable a propósito (0001, «null =
// superadmin»): borrar un operador dejaba al encargado que lo tenía con la
// FORMA reservada al superadmin.
//
// Esta prueba NO consulta Postgres —aquí no hay base—: lee el SQL de la
// ÚLTIMA migración que define la FK (el idioma del repo es soltar y
// recrear) y exige que el `on delete set null` traiga su lista de columnas,
// igual que el propio repo hace en sus otras 20 FK compuestas (0145) y en
// `terminal_id` de la 0298. El comportamiento real —que el DELETE de verdad
// deje `tenant_id` intacto— lo prueba el bloque 254 de verificaciones.sql
// contra Postgres real.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRACIONES = join(process.cwd(), 'supabase', 'migrations');
const FK = 'app_user_operador_tenant_fkey';

/** La ÚLTIMA migración que define la FK, con su cláusula `on delete …`. */
function ultimaDefinicion(): { archivo: string; clausula: string } {
  const archivos = readdirSync(MIGRACIONES).filter((f) => f.endsWith('.sql')).sort();
  let ultima: { archivo: string; clausula: string } | null = null;

  for (const archivo of archivos) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- ruta derivada de readdirSync sobre un directorio fijo del repo
    const crudo = readFileSync(join(MIGRACIONES, archivo), 'utf8');
    const sinComentarios = crudo.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
    const m = sinComentarios.match(
      new RegExp(`alter table public\\.app_user add constraint ${FK}[\\s\\S]*?;`, 'i'),
    );
    if (m) ultima = { archivo, clausula: m[0] };
  }

  if (!ultima) throw new Error(`ninguna migración define la FK ${FK}`);
  return ultima;
}

describe('DATOS-M3 · app_user_operador_tenant_fkey anula UNA sola columna', () => {
  it('`on delete set null` trae su lista de columnas — no la FK entera', () => {
    const { archivo, clausula } = ultimaDefinicion();
    // Sin lista: `on delete set null` seguido de `not valid`/fin de sentencia,
    // sin un `(` antes. Con lista: `on delete set null (operador_id)`.
    expect(
      /on delete set null\s*\(/i.test(clausula),
      `${archivo} deja \`${FK}\` con \`on delete set null\` SIN lista de columnas ` +
        '(clausula: ' + clausula.trim() + '). En Postgres eso anula TODAS las ' +
        'columnas de la FK compuesta — aquí también `tenant_id`, que vacío ' +
        'significa "superadmin" (0001).',
    ).toBe(true);
  });

  it('la columna que se anula es `operador_id`, no `tenant_id`', () => {
    const { clausula } = ultimaDefinicion();
    expect(clausula.toLowerCase()).toMatch(/on delete set null\s*\(\s*operador_id\s*\)/);
  });
});
