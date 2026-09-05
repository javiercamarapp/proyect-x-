import { beforeEach, expect, it, vi } from 'vitest';
const upsert = vi.hoisted(() => vi.fn(async () => ({ error: null as { message: string } | null })));
const from = vi.hoisted(() => vi.fn(() => ({ upsert })));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from }) }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('./presupuesto', () => ({ acotada: (q: unknown) => q }));
import { saveCfdiXmlRaw } from './repo';
beforeEach(() => { vi.clearAllMocks(); upsert.mockResolvedValue({ error: null }); });
it('confirma el XML conservado, aislado por flota y con UUID normalizado', async () => {
  expect(await saveCfdiXmlRaw('tenant-A', ' ABCD-1234 ', null, '<credito/>')).toBe(true);
  expect(from).toHaveBeenCalledExactlyOnceWith('cfdi_xml');
  expect(upsert).toHaveBeenCalledExactlyOnceWith({ tenant_id: 'tenant-A', cfdi_uuid: 'abcd-1234', gasto_id: null, xml: '<credito/>' }, { onConflict: 'tenant_id,cfdi_uuid' });
});
it('un error de escritura devuelve false para no acusar persistencia inexistente', async () => {
  upsert.mockResolvedValue({ error: { message: 'base no disponible' } });
  expect(await saveCfdiXmlRaw('tenant-A', 'ABC', null, '<credito/>')).toBe(false);
});
