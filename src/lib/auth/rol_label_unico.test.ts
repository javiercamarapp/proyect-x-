import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fuentesDeProduccion, sinComentarios } from '@/lib/pruebas/codigo';
import { ROL_LABEL, ROL_BADGE, type RolAppUser } from './provisionar';

// ═══════════════════════════════════════════════════════════════════════════
// ARQUITECTURA 25 (BAJO, REINCIDENTE) — cuatro copias de `ROL_LABEL` que ya
// habían divergido: dos seguían nombrando `operador` (retirado en la 0086) y
// las tres sin tipar no traían `vendedor` (0105) — un superadmin `vendedor`
// salía con su rol crudo en pantalla. `provisionar.ts` ahora exporta la
// ÚNICA `ROL_LABEL`, exhaustiva (`Record<RolAppUser, string>`, TypeScript
// avisa si falta un rol). Este barrido evita que nazca una quinta copia
// declarada en otra pantalla.
//
// AUDITORÍA 28, ARQ-B5 (BAJO, reincidente 26/27) — `ROL_BADGE` (el badge
// corto en mayúsculas del sidebar) era la QUINTA copia del dominio de roles,
// declarada en `dashboard/chrome.tsx`, y este mismo barrido no la veía
// porque cazaba por el NOMBRE `ROL_LABEL`. Ahora también prohíbe `ROL_BADGE`
// fuera de `provisionar.ts` y, más general, cualquier objeto literal de
// producción que junte las cinco claves del dominio de rol — para que la
// SEXTA copia, con el nombre que sea, tampoco nazca invisible.
// ═══════════════════════════════════════════════════════════════════════════

/** `grep -rln` de un patrón `(const|let) <NOMBRE>` sobre `src`, sin test files. */
function archivosQueDeclaran(nombre: string): string[] {
  let salida = '';
  try {
    salida = execSync(
      `grep -rln --include='*.ts' --include='*.tsx' --exclude='*.test.*' --exclude='*.fixture.*' -E '(const|let) ${nombre}' src`,
      { encoding: 'utf8' },
    );
  } catch (e) {
    // grep sale 1 cuando no encuentra nada — es el caso BUENO.
    const err = e as { status?: number; stdout?: string };
    if (err.status !== 1) throw e;
    salida = err.stdout ?? '';
  }
  return salida.split('\n').map((l) => l.trim()).filter(Boolean);
}

const CLAVES_ROL = ['superadmin', 'flota_admin', 'contador', 'encargado', 'vendedor'] as const;

/**
 * ¿El archivo tiene un objeto literal que junta las cinco claves del dominio
 * de rol, cada una apuntando DIRECTO a un string (`clave: 'texto'`, la forma
 * de `ROL_LABEL`/`ROL_BADGE`)? No es un parser: busca, para cada aparición de
 * `superadmin: '…'`, la ocurrencia más cercana de cada una de las otras
 * cuatro claves con la misma forma y considera "el mismo objeto" si las
 * cinco caben en una ventana corta de texto (800 caracteres — de sobra para
 * un `Record` de 5 entradas, muy poco para que dos objetos distintos del
 * mismo archivo se confundan). Exige el valor string a propósito: no atrapa
 * `ROTULOS_ROL` (`roles.ts`) — sus claves apuntan a un OBJETO `{nombre,
 * detalle}`, un dominio distinto y ya con su propia fuente única
 * (auditoría 24, H18/ADM-7).
 */
function tieneObjetoConLasCincoClaves(fuente: string): boolean {
  const posiciones = CLAVES_ROL.map((c) => [...fuente.matchAll(new RegExp(`\\b${c}\\s*:\\s*['"]`, 'g'))].map((m) => m.index ?? -1));
  if (posiciones.some((p) => p.length === 0)) return false;
  for (const p0 of posiciones[0]) {
    let min = p0;
    let max = p0;
    for (let i = 1; i < posiciones.length; i++) {
      const masCercana = posiciones[i].reduce((mejor, p) => (Math.abs(p - p0) < Math.abs(mejor - p0) ? p : mejor));
      min = Math.min(min, masCercana);
      max = Math.max(max, masCercana);
    }
    if (max - min < 800) return true;
  }
  return false;
}

describe('ROL_LABEL/ROL_BADGE tienen UNA sola fuente', () => {
  it('ningún archivo fuera de provisionar.ts declara su propio ROL_LABEL', () => {
    // `(const|let)` para no atrapar `ROL_LABEL[` (el USO, que sí debe estar
    // en varios archivos) ni nombres parecidos.
    const archivos = archivosQueDeclaran('ROL_LABEL').filter((f) => !f.endsWith('src/lib/auth/provisionar.ts'));
    expect(archivos, `estos archivos declaran su propio ROL_LABEL en vez de importar el de provisionar.ts: ${archivos.join(', ')}`).toEqual([]);
  });

  it('ningún archivo fuera de provisionar.ts declara su propio ROL_BADGE', () => {
    const archivos = archivosQueDeclaran('ROL_BADGE').filter((f) => !f.endsWith('src/lib/auth/provisionar.ts'));
    expect(archivos, `estos archivos declaran su propio ROL_BADGE en vez de importar el de provisionar.ts: ${archivos.join(', ')}`).toEqual([]);
  });

  it('ningún archivo de producción fuera de provisionar.ts declara un objeto con las cinco claves de rol juntas', () => {
    const culpables = fuentesDeProduccion('src')
      .filter((f) => !f.endsWith('/lib/auth/provisionar.ts') && !f.includes('fixture'))
      // `f` sale del propio barrido de `fuentesDeProduccion` sobre `src/`.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      .filter((f) => tieneObjetoConLasCincoClaves(sinComentarios(readFileSync(f, 'utf8'))));
    expect(culpables, `estos archivos declaran su propia copia del dominio de rol: ${culpables.join(', ')}`).toEqual([]);
  });

  it('cubre TODO RolAppUser, incluye vendedor y NO nombra operador (retirado en la 0086)', () => {
    const roles: RolAppUser[] = ['superadmin', 'flota_admin', 'contador', 'encargado', 'vendedor'];
    for (const r of roles) expect(ROL_LABEL[r], `falta el rótulo de "${r}"`).toBeTruthy();
    expect(Object.keys(ROL_LABEL)).not.toContain('operador');
  });

  it('ROL_BADGE cubre TODO RolAppUser, incluye vendedor y NO nombra operador', () => {
    const roles: RolAppUser[] = ['superadmin', 'flota_admin', 'contador', 'encargado', 'vendedor'];
    for (const r of roles) expect(ROL_BADGE[r], `falta el badge de "${r}"`).toBeTruthy();
    expect(Object.keys(ROL_BADGE)).not.toContain('operador');
  });
});
