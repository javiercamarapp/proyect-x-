import { isValidElement } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /dashboard/conocimiento — CERO cobertura. Página estática (sin lectura de
// base, sin server actions) pero con una puerta real: sólo área "dinero"
// (quien firma la declaración fiscal) la ve.
// ═══════════════════════════════════════════════════════════════════════════

let sesion: { tenantId: string; rol: string } = { tenantId: 't-1', rol: 'flota_admin' };

vi.mock('@/lib/auth/tenant-efectivo', () => ({ resolverTenantEfectivo: async () => sesion }));
vi.mock('next/navigation', () => ({ redirect: (ruta: string) => { throw new Error(`REDIRECT:${ruta}`); } }));

import { NORMAS } from '@/lib/likida/normas/corpus';
import { VistaConocimiento } from './vista';
import PaginaConocimiento from './page';

const SP = Promise.resolve({});

beforeEach(() => {
  vi.clearAllMocks();
  sesion = { tenantId: 't-1', rol: 'flota_admin' };
});

it.each(['encargado', 'vendedor'])('%s no puede ver el corpus normativo: redirect', async (rol) => {
  sesion = { tenantId: 't-1', rol };
  await expect(PaginaConocimiento({ searchParams: SP })).rejects.toThrow('REDIRECT:/dashboard');
});

it.each(['flota_admin', 'superadmin', 'contador'])('%s (área dinero) sí puede ver el corpus, IDÉNTICO para toda flota', async (rol) => {
  sesion = { tenantId: 't-1', rol };
  const pagina = await PaginaConocimiento({ searchParams: SP });
  expect(isValidElement(pagina)).toBe(true);
  expect((pagina as unknown as { type: unknown }).type).toBe(VistaConocimiento);
  // El corpus NO se filtra por tenant — es la ley, no un dato de la flota.
  expect((pagina as unknown as { props: { normas: unknown } }).props.normas).toBe(NORMAS);
});
