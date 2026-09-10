import { isValidElement } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/copiloto — CERO cobertura. requireSuperadmin ya tiene prueba propia
// (guard.test.ts); esta página no tiene datos ni server actions — TODO llega
// por tools del endpoint /api/admin/copiloto. Lo único suyo: que en efecto
// llama requireSuperadmin ANTES de renderizar (puerta doble a propósito con
// la del layout — una server action/API es alcanzable sin pasar por él).
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({ requireSuperadmin: vi.fn() }));
vi.mock('@/lib/auth/guard', () => ({ requireSuperadmin: dobles.requireSuperadmin }));
vi.mock('../copiloto', () => ({ default: () => null }));

import PaginaCopiloto from './page';

beforeEach(() => { vi.clearAllMocks(); });

it('llama requireSuperadmin antes de renderizar — segunda puerta a propósito', async () => {
  dobles.requireSuperadmin.mockResolvedValue({ userId: 'u-1', rol: 'superadmin' });
  const pagina = await PaginaCopiloto();
  expect(dobles.requireSuperadmin).toHaveBeenCalled();
  expect(isValidElement(pagina)).toBe(true);
});

it('si requireSuperadmin redirige (no es superadmin), la página nunca llega a renderizar Copiloto', async () => {
  dobles.requireSuperadmin.mockImplementation(() => { throw new Error('REDIRECT:/dashboard'); });
  await expect(PaginaCopiloto()).rejects.toThrow('REDIRECT:/dashboard');
});
