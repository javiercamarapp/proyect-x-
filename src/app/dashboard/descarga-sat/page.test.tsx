import { isValidElement } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /dashboard/descarga-sat — página delgada: la puerta y el dato real viven en
// resolverTenantEfectivo (que ya gatea internamente con puedeVerRuta) y en
// VistaDescargaSat. Aquí sólo se prueba el cableado: qué le pasa a la vista.
// ═══════════════════════════════════════════════════════════════════════════

let sesion: { tenantExiste: boolean } = { tenantExiste: true };

vi.mock('@/lib/auth/tenant-efectivo', () => ({ resolverTenantEfectivo: async () => sesion }));

import { VistaDescargaSat } from './vista';
import DescargaSatPage from './page';

const SP = Promise.resolve({ vista: 'demo' });

beforeEach(() => { sesion = { tenantExiste: true }; });

it('pasa tenantExiste y searchParams tal cual a VistaDescargaSat', async () => {
  const pagina = await DescargaSatPage({ searchParams: SP });
  expect(isValidElement(pagina)).toBe(true);
  const props = (pagina as unknown as { type: unknown; props: { tenantExiste: boolean; searchParams: unknown } });
  expect(props.type).toBe(VistaDescargaSat);
  expect(props.props.tenantExiste).toBe(true);
  expect(props.props.searchParams).toEqual({ vista: 'demo' });
});

it('una flota que ya no existe se lo dice a la vista, no lo esconde', async () => {
  sesion = { tenantExiste: false };
  const pagina = await DescargaSatPage({ searchParams: SP });
  const props = (pagina as unknown as { props: { tenantExiste: boolean } });
  expect(props.props.tenantExiste).toBe(false);
});
