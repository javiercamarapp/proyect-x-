import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 18 · DAT-27 — LA COMPENSACIÓN DEL ALTA DE FACTURA BORRABA.
//
// `crearFactura` escribe en dos pasos (PostgREST no da transacciones): la
// factura y después sus ligas a viajes. Si las ligas fallaban, el alta se
// deshacía con un `.delete()` sobre `factura_emitida`.
//
// Y borrar una `factura_emitida` es justo lo que la 0158 dejó de permitir a la
// ligera: su FK con `pago_recibido` pasó de CASCADE a NO ACTION porque el
// borrado se llevaba por delante los abonos —dinero que entró al banco—. Esta
// factura recién nacida no tiene abonos y el DELETE habría funcionado; lo que
// no funciona es la ASIMETRÍA: un folio que existió y desapareció sin dejar
// rastro, dentro de un consecutivo fiscal.
//
// Se compensa CANCELANDO. La fila queda contando la verdad: se intentó y no se
// completó. Esta prueba era ROJA antes del arreglo (llamaba a `.delete()`).
// ═══════════════════════════════════════════════════════════════════════════

type Fila = Record<string, unknown>;
const llamadas: Array<{ tabla: string; op: string; datos?: Fila }> = [];
/** El insert de las ligas falla; todo lo demás pasa. */
let ligasFallan = true;

const VIAJE = '99999999-2222-3333-4444-555555555555';

/** Lo mínimo de PostgREST que `crearFactura` encadena, sin más ceremonia. */
interface Cadena {
  eq: () => Cadena;
  in: () => Promise<{ data: unknown; error: null }>;
  maybeSingle: () => Promise<{ data: unknown; error: null }>;
}
const cadena = (fila: unknown, lista: unknown[]): Cadena => {
  const c: Cadena = {
    eq: () => c,
    in: async () => ({ data: lista, error: null }),
    maybeSingle: async () => ({ data: fila, error: null }),
  };
  return c;
};

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./bitacora', () => ({ anotar: vi.fn(async () => undefined) }));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from(tabla: string) {
      return {
        // `cliente` trae sus días de crédito (de ahí sale `vence_en`) y
        // `viaje` contesta que el viaje marcado sí es de la flota.
        select: () => (tabla === 'cliente'
          ? cadena({ id: 'cli-1', dias_credito: 30 }, [])
          : cadena(null, [{ id: VIAJE }])),
        insert(datos: Fila) {
          llamadas.push({ tabla, op: 'insert', datos });
          if (tabla === 'factura_viaje' && ligasFallan) {
            return Promise.resolve({ error: { message: 'viaje de otra flota' } });
          }
          return { select: () => ({ single: async () => ({ data: { id: 'fac-1' }, error: null }) }) };
        },
        update(datos: Fila) {
          llamadas.push({ tabla, op: 'update', datos });
          return { eq: () => ({ eq: async () => ({ error: null }) }) };
        },
        delete() {
          llamadas.push({ tabla, op: 'delete' });
          return { eq: () => ({ eq: async () => ({ error: null }) }) };
        },
      };
    },
  }),
}));

const { crearFactura } = await import('./facturacion_escritura');

const FACTURA = {
  clienteId: '11111111-2222-3333-4444-555555555555',
  fecha: '2026-08-14',
  subtotal: 10000,
  iva: 1600,
  retencion: 0,
  total: 11600,
  serie: null,
  folio: 'F-1',
  cfdiUuid: null,
  estatus: 'borrador' as const,
  viajeIds: [VIAJE],
};

beforeEach(() => { llamadas.length = 0; ligasFallan = true; });

describe('si las ligas a viajes fallan, la factura se CANCELA (no se borra)', () => {
  it('no hay un solo DELETE contra factura_emitida', async () => {
    await expect(crearFactura('t1', FACTURA, undefined)).rejects.toThrow(/ligar los viajes/);
    expect(llamadas.some((l) => l.tabla === 'factura_emitida' && l.op === 'delete')).toBe(false);
  });

  it('queda una fila `cancelada`: el folio que se usó no desaparece del consecutivo', async () => {
    await expect(crearFactura('t1', FACTURA, undefined)).rejects.toThrow();
    const compensacion = llamadas.find((l) => l.tabla === 'factura_emitida' && l.op === 'update');
    expect(compensacion?.datos).toEqual({ estatus: 'cancelada' });
  });

  it('y el fallo se reporta COMPLETO: nadie se queda creyendo que facturó', async () => {
    await expect(crearFactura('t1', FACTURA, undefined)).rejects.toThrow(/no se pudieron ligar/);
  });

  it('cuando las ligas entran, no se compensa nada', async () => {
    ligasFallan = false;
    await expect(crearFactura('t1', FACTURA, undefined)).resolves.toBe('fac-1');
    expect(llamadas.some((l) => l.tabla === 'factura_emitida' && l.op !== 'insert')).toBe(false);
  });
});
