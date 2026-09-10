import { expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /dashboard/integraciones — CERO cobertura. Pantalla fusionada a Conexiones:
// solo redirige, conservando el sufijo de previsualización del superadmin
// (?tenant=&vista=&rol=) para no sacarlo de la flota que estaba mirando.
// ═══════════════════════════════════════════════════════════════════════════

vi.mock('next/navigation', () => ({ redirect: (ruta: string) => { throw new Error(`REDIRECT:${ruta}`); } }));

import PaginaIntegraciones from './page';

it('redirige a /dashboard/conexiones sin sufijo cuando no hay previsualización', async () => {
  await expect(PaginaIntegraciones({ searchParams: Promise.resolve({}) })).rejects.toThrow('REDIRECT:/dashboard/conexiones');
});

it('conserva el sufijo de previsualización del superadmin (no lo saca de la flota que miraba)', async () => {
  await expect(PaginaIntegraciones({ searchParams: Promise.resolve({ tenant: 't-otra', vista: 'demo', rol: 'contador' }) }))
    .rejects.toThrow(/^REDIRECT:\/dashboard\/conexiones\?.*tenant=t-otra/);
});
