import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  row: {} as Record<string, unknown>, filters: [] as Array<[string, unknown]>,
}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: () => {
  let patch: Record<string, unknown>;
  const q = {
    update: (value: Record<string, unknown>) => { patch = value; return q; },
    eq: (key: string, value: unknown) => { state.filters.push([key, value]); return q; },
    is: (key: string, value: unknown) => { state.filters.push([key, value]); return q; },
    select: () => q,
    maybeSingle: async () => {
      const matches = state.filters.every(([key, value]) => state.row[key] === value);
      if (matches) Object.assign(state.row, patch);
      return { data: matches ? { id: state.row.id } : null, error: null };
    },
  };
  return q;
} }) }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn() } }));
vi.mock('./presupuesto', () => ({ acotada: (q: unknown) => q, PRESUPUESTO_WEBHOOK_MS: 80000 }));
const { sellarEntregaLiquidacion } = await import('./conv');

beforeEach(() => {
  state.filters = [];
  state.row = { tenant_id: 't', id: 'l', pdf_url: 'version-nueva.pdf', entregada_operador_en: null };
});

it('un envío anterior no sella la versión recién publicada', async () => {
  expect(await sellarEntregaLiquidacion('t', 'l', 'entregada_operador_en', 'version-vieja.pdf')).toBe(false);
  expect(state.row.entregada_operador_en).toBeNull();
});
it('la entrega de la versión actual se sella una sola vez', async () => {
  expect(await sellarEntregaLiquidacion('t', 'l', 'entregada_operador_en', 'version-nueva.pdf')).toBe(true);
  const first = state.row.entregada_operador_en;
  state.filters = [];
  expect(await sellarEntregaLiquidacion('t', 'l', 'entregada_operador_en', 'version-nueva.pdf')).toBe(false);
  expect(state.row.entregada_operador_en).toBe(first);
});
it('un cierre pendiente no se confunde con una pareja publicada', async () => {
  expect(await sellarEntregaLiquidacion('t', 'l', 'entregada_operador_en', null)).toBe(false);
});
it('otra flota no puede sellar una entrega aunque conozca la ruta', async () => {
  expect(await sellarEntregaLiquidacion('otra', 'l', 'entregada_operador_en', 'version-nueva.pdf')).toBe(false);
  expect(state.row.entregada_operador_en).toBeNull();
});
