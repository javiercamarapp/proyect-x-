import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// EL CANDADO ANTI-CARRERA DE `decidirFacturaProveedor` (auditoría 28, PRU-M6).
//
// El código YA está bien: `.eq('estado', 'pendiente')` es lo que impide que
// la segunda decisión pise `estado`/`decidido_por`/`decidido_en` de la
// primera — cifras que salen tal cual en el export contable (SAP B1/CONTPAQi).
// `proveedores.test.ts` solo cubre los layouts puros y el parseo de XML: esta
// función nunca se llamó desde una prueba. Sin una que la llame y mire la
// consulta armada, un refactor de buena fe puede borrar el `.eq('estado', …)`
// sin que la suite se entere.
// ═══════════════════════════════════════════════════════════════════════════

type Resp = { data: unknown; error: { message: string; code?: string } | null };
const respuestas = new Map<string, Resp>();

interface Llamada {
  tabla: string;
  op: 'update';
  fila: Record<string, unknown> | null;
  eq: Array<[string, unknown]>;
}
const llamadas: Llamada[] = [];

function crearBuilder(tabla: string) {
  const l: Llamada = { tabla, op: 'update', fila: null, eq: [] };
  llamadas.push(l);
  const resp = (): Resp => respuestas.get(`${tabla}#update`) ?? { data: [{ id: 'fp-1' }], error: null };
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: () => b,
    update: (fila: Record<string, unknown>) => { l.fila = fila; return b; },
    eq: (c: string, v: unknown) => { l.eq.push([c, v]); return b; },
    then: (res: (x: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve().then(() => resp()).then(res, rej),
  });
  return b;
}

vi.mock('./presupuesto', () => ({ acotada: <T,>(q: T) => q }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: (t: string) => crearBuilder(t) }) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { decidirFacturaProveedor } = await import('./proveedores');

const TENANT = 'tenant-1';

beforeEach(() => { llamadas.length = 0; respuestas.clear(); });

describe('decidirFacturaProveedor — el candado eq(estado, pendiente)', () => {
  it('ancla eq(id), eq(tenant_id) y eq(estado, pendiente) EN LA CONSULTA', async () => {
    const r = await decidirFacturaProveedor(TENANT, 'fp-1', 'aprobada', 'u1');
    expect(r).toEqual({});
    expect(llamadas).toHaveLength(1);
    const l = llamadas[0];
    expect(l.tabla).toBe('factura_proveedor');
    expect(l.fila).toMatchObject({ estado: 'aprobada', decidido_por: 'u1' });
    expect(l.eq).toContainEqual(['id', 'fp-1']);
    expect(l.eq).toContainEqual(['tenant_id', TENANT]);
    // EL CANDADO: sin este filtro, la segunda decisión pisa la primera en
    // vez de enterarse de que ya no está pendiente.
    expect(l.eq).toContainEqual(['estado', 'pendiente']);
  });

  it('data: [] — alguien más ya la decidió, y NO se afirma que se guardó', async () => {
    respuestas.set('factura_proveedor#update', { data: [], error: null });
    const r = await decidirFacturaProveedor(TENANT, 'fp-1', 'rechazada', 'u1');
    expect(r).toEqual({ error: 'Esa factura ya no está pendiente — alguien más la decidió. Recarga la página.' });
  });

  it('error de la base: mensaje genérico y logger.error, no el mensaje crudo de Postgres', async () => {
    respuestas.set('factura_proveedor#update', { data: null, error: { message: 'connection reset' } });
    const r = await decidirFacturaProveedor(TENANT, 'fp-1', 'aprobada', 'u1');
    expect(r).toEqual({ error: 'No se pudo guardar la decisión. Inténtalo de nuevo.' });
  });
});
