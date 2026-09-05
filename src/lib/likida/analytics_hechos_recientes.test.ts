import { beforeEach, expect, it, vi } from 'vitest';

type Fila = Record<string, unknown>;
const estado = vi.hoisted(() => ({ filas: [] as Fila[], errorCampo: '', limites: [] as number[] }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: (tabla: string) => {
  if (tabla !== 'viaje') throw new Error(`Tabla inesperada ${tabla}`);
  const filtros: Array<(f: Fila) => boolean> = [];
  let orden = ''; let ascendente = false; let limite = Infinity;
  const q = {
    select: () => q,
    eq: (campo: string, valor: unknown) => { filtros.push((f) => f[campo] === valor); return q; },
    not: (campo: string, op: string, valor: unknown) => {
      if (op !== 'is' || valor !== null) throw new Error('Filtro inesperado');
      filtros.push((f) => f[campo] != null); return q;
    },
    or: () => { filtros.push((f) => f.escalado_en != null || f.recordatorio_comprobacion_en != null); return q; },
    order: (campo: string, opts: { ascending: boolean }) => { orden = campo; ascendente = opts.ascending; return q; },
    limit: (n: number) => { limite = n; estado.limites.push(n); return q; },
    then: (res: (v: unknown) => unknown) => Promise.resolve({
      data: estado.filas.filter((f) => filtros.every((p) => p(f)))
        .sort((a,b) => (ascendente ? 1 : -1) * String(a[orden]).localeCompare(String(b[orden])))
        .slice(0, limite),
      error: estado.errorCampo === orden ? { message: 'lectura falló' } : null,
    }).then(res),
  };
  return q;
} }) }));
vi.mock('./presupuesto', () => ({ acotada: (q: unknown) => q }));
vi.mock('./cuadre/desde_db', () => ({ cuadrarDesdeDB: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { getHechosSolos } from './analytics';

const fila = (id: string, extras: Fila = {}): Fila => ({
  id, tenant_id: 'A', folio: id, escalado_en: null, recordatorio_comprobacion_en: null,
  operador: { nombre: 'Operador sintético' }, ...extras,
});
beforeEach(() => { estado.filas = []; estado.errorCampo = ''; estado.limites = []; });

it('un hecho reciente con UUID menor no desaparece detrás de más de 60 viajes antiguos', async () => {
  estado.filas = [
    ...Array.from({ length: 80 }, (_, i) => fila(`ffffffff-0000-4000-8000-${String(i).padStart(12,'0')}`, { escalado_en: '2026-08-01T00:00:00Z' })),
    fila('00000000-0000-4000-8000-000000000001', { folio: 'RECIENTE', recordatorio_comprobacion_en: '2026-09-05T12:00:00Z' }),
  ];
  const hechos = await getHechosSolos('A');
  expect(hechos).toHaveLength(8);
  expect(hechos[0]).toMatchObject({ folio: 'RECIENTE', tipo: 'recordatorio' });
  expect(estado.limites).toEqual([8,8]);
});

it('mezcla dos sellos del mismo viaje sin duplicarlos, con aislamiento y fallbacks', async () => {
  estado.filas = [fila('a', { folio: null, operador: null, escalado_en: '2026-09-05T13:00:00Z', recordatorio_comprobacion_en: '2026-09-05T12:00:00Z' }),
    fila('b', { escalado_en: '2026-09-05T12:30:00Z' }),
    fila('otro', { tenant_id: 'B', escalado_en: '2026-09-06T00:00:00Z' })];
  expect(await getHechosSolos('A', 3)).toEqual([
    { folio: '—', operador: null, tipo: 'escalado', cuando: '2026-09-05T13:00:00Z' },
    { folio: 'b', operador: 'Operador sintético', tipo: 'escalado', cuando: '2026-09-05T12:30:00Z' },
    { folio: '—', operador: null, tipo: 'recordatorio', cuando: '2026-09-05T12:00:00Z' },
  ]);
});

it.each(['escalado_en', 'recordatorio_comprobacion_en'])('fallo de %s no devuelve un feed parcial como completo', async (campo) => {
  estado.errorCampo = campo;
  await expect(getHechosSolos('A')).rejects.toThrow('lectura falló');
});

it('sin eventos conserva el feed vacío', async () => {
  estado.filas = [fila('sin-sello')];
  expect(await getHechosSolos('A')).toEqual([]);
});
