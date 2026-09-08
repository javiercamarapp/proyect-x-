import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28, FE-M4 — el catch de `rastreoDe` (page.tsx) NO debe volver a
// entregar `e.message` (el error crudo de PostgREST que lanzan
// `getEstadoRastreo`/`getUltimasPosiciones`, comercial.ts) como
// `Rastreo.error`: ese string llega directo a `vista.tsx` y de ahí a la
// pantalla del contralor. Antes: `return { error: err, ... }` con
// `err = e.message`. Ahora: una frase fija; el mensaje real solo va al
// `logger.warn`.
// ═══════════════════════════════════════════════════════════════════════════

const resolverTenantEfectivo = vi.fn(async () => ({ tenantId: 't-1', rol: 'flota_admin' as string }));
vi.mock('@/lib/auth/tenant-efectivo', () => ({
  resolverTenantEfectivo: (...a: unknown[]) => resolverTenantEfectivo(...(a as [])),
}));
vi.mock('@/lib/auth/visibilidad', () => ({ puedeVerRuta: () => true }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

vi.mock('@/lib/likida/presupuesto', () => ({ acotada: (q: unknown) => q }));

/** Un `viaje`/`unidad` sin filas — lo que importa aquí es el bloque de GPS,
 *  no los viajes vivos. */
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => {
    const f: Record<string, unknown> = {};
    Object.assign(f, {
      select: () => f,
      eq: () => f,
      in: () => f,
      order: () => f,
      limit: () => f,
      then: (res: (x: unknown) => unknown) => Promise.resolve({ data: [], error: null, count: 0 }).then(res),
    });
    return { from: () => f };
  },
}));

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger }));

const getEstadoRastreo = vi.fn();
const getUltimasPosiciones = vi.fn();
vi.mock('@/lib/likida/comercial', () => ({
  getEstadoRastreo: (...a: unknown[]) => getEstadoRastreo(...a),
  getUltimasPosiciones: (...a: unknown[]) => getUltimasPosiciones(...a),
}));

vi.mock('@/lib/saludo', () => ({ ahoraMs: () => 1_700_000_000_000 }));

import PaginaMapa from './page';
import type { Rastreo } from './vista';

/** El default export es un componente de servidor: llamarlo directo devuelve
 *  el elemento de React (un objeto plano `{type, props}`) SIN renderizarlo —
 *  aquí basta para leer qué `rastreo` le tocó a `VistaMapa`. */
async function rastreoDeLaPagina(): Promise<Rastreo> {
  const el = (await PaginaMapa({ searchParams: Promise.resolve({}) })) as unknown as {
    props: { rastreo: Rastreo };
  };
  return el.props.rastreo;
}

describe('/dashboard/mapa — el rastreo caído no entrega el mensaje crudo de Postgres (FE-M4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolverTenantEfectivo.mockResolvedValue({ tenantId: 't-1', rol: 'flota_admin' });
  });

  it('getEstadoRastreo que lanza con un mensaje de PostgREST: `rastreo.error` es la frase fija, no el mensaje original', async () => {
    getEstadoRastreo.mockRejectedValue(new Error('permission denied for table unidad'));
    getUltimasPosiciones.mockResolvedValue([]);

    const rastreo = await rastreoDeLaPagina();

    expect(rastreo.error).toBe('no se pudo leer el rastreo de la flota');
    expect(rastreo.error).not.toMatch(/permission denied/);
    expect(rastreo.error).not.toMatch(/unidad/);
    expect(logger.warn).toHaveBeenCalledWith('mapa.rastreo', {
      tenantId: 't-1', err: 'permission denied for table unidad',
    });
  });

  it('sin error, `rastreo.error` sigue siendo `null`', async () => {
    getEstadoRastreo.mockResolvedValue({ unidadesConPosicion: 3, ultimaPosicion: null, proveedores: [], polls: [] });
    getUltimasPosiciones.mockResolvedValue([]);

    const rastreo = await rastreoDeLaPagina();

    expect(rastreo.error).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
