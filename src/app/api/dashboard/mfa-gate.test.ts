import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rutas = [
  ['chat/route.ts', 'await rateLimit'],
  ['ingesta/route.ts', 'await rateLimit'],
  ['onboarding-chat/route.ts', 'await tenantEfectivoChat'],
  ['conversaciones/route.ts', 'await tenantEfectivoChat'],
  ['conversaciones/[id]/route.ts', 'await tenantEfectivoChat'],
  ['archivo/route.ts', 'await rateLimit'],
] as const;

describe('MFA del superadmin en todas las APIs del chat', () => {
  it.each(rutas)('%s aplica la puerta antes del primer trabajo sensible', (relativa, marcador) => {
    const ruta = fileURLToPath(new URL(relativa, import.meta.url));
    // Lista cerrada arriba; no recibe rutas del usuario ni de la red.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const fuente = readFileSync(ruta, 'utf8');
    const puerta = fuente.indexOf('await rechazoMfaSuperadminApi(sesion)');
    const sensible = fuente.indexOf(marcador);
    expect(puerta).toBeGreaterThan(-1);
    expect(sensible).toBeGreaterThan(puerta);
  });
});
