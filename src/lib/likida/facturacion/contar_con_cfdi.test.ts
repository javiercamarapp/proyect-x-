import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// `contarConCfdi` (auditoría 28, PRU-B2 — tercera vez). El contrato del
// comentario es explícito: «`null` ≠ 0: si no se pudo contar, se dice». La
// función ya lo respeta (falla cerrado, devuelve `null` en vez de un 0 que
// se leería como "cero gastos con CFDI" cuando en realidad la base no
// contestó). `pendientes.test.ts` nunca la nombra, así que mutar
// `return null` → `return 0` deja la suite verde. Aquí se le pone candado.
//
// El consumidor (`facturas/page.tsx` ~:48 → `vista.tsx:168-192`) YA distingue
// `null` de `0` en pantalla (`extra.conCfdi !== null` / `=== null` / `=== 0`):
// verificado línea por línea, no es el bug que el prompt pedía cazar — se
// prueba tal cual, sin tocar producción ahí.
// ═══════════════════════════════════════════════════════════════════════════

type Resp = { count: number | null; error: { message: string } | null };
let respuesta: Resp = { count: 3, error: null };
const filtros: Array<[string, unknown[]]> = [];

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      filtros.push(['from', [tabla]]);
      const b: Record<string, unknown> = {};
      b.select = (...a: unknown[]) => { filtros.push(['select', a]); return b; };
      b.eq = (...a: unknown[]) => { filtros.push(['eq', a]); return b; };
      b.not = (...a: unknown[]) => { filtros.push(['not', a]); return b; };
      b.then = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve().then(() => respuesta).then(res, rej);
      return b;
    },
  }),
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const { contarConCfdi } = await import('./pendientes');

beforeEach(() => { filtros.length = 0; respuesta = { count: 3, error: null }; });

describe('contarConCfdi — null nunca se confunde con 0', () => {
  it('cuenta con head:true, eq(tenant_id) y not(cfdi_uuid, is, null)', async () => {
    const n = await contarConCfdi('tenant-1');
    expect(n).toBe(3);
    expect(filtros).toContainEqual(['from', ['gasto']]);
    expect(filtros).toContainEqual(['select', ['id', { count: 'exact', head: true }]]);
    expect(filtros).toContainEqual(['eq', ['tenant_id', 'tenant-1']]);
    expect(filtros).toContainEqual(['not', ['cfdi_uuid', 'is', null]]);
  });

  it('count: 0 (de verdad cero) sigue siendo 0, no null', async () => {
    respuesta = { count: 0, error: null };
    expect(await contarConCfdi('tenant-1')).toBe(0);
  });

  it('error de la base — EL CANDADO: devuelve null, JAMÁS 0', async () => {
    respuesta = { count: null, error: { message: 'la base no contestó' } };
    const n = await contarConCfdi('tenant-1');
    expect(n).toBeNull();
    // Falso ⇒ verde con la mutación `return null` → `return 0`. Es el
    // candado que PRU-B2 pide demostrar.
    expect(n).not.toBe(0);
  });

  it('count: null sin error — también null, no 0', async () => {
    respuesta = { count: null, error: null };
    expect(await contarConCfdi('tenant-1')).toBeNull();
  });
});
