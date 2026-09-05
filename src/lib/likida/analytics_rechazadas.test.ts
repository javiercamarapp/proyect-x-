import { beforeEach, expect, it, vi } from 'vitest';
const estado = vi.hoisted(() => ({ filas: [] as Array<Record<string, unknown>> }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({
  from: (tabla: string) => {
    if (tabla !== 'liquidacion') throw new Error(`Tabla inesperada ${tabla}`);
    const filtros: Array<(r: Record<string, unknown>) => boolean> = [];
    let campos = ''; let limite = Infinity; let descendente = false;
    const q = {
      select: (s: string) => { campos = s; return q; },
      eq: (k: string, v: unknown) => { filtros.push((r) => r[k] === v); return q; },
      neq: (k: string, v: unknown) => { filtros.push((r) => r[k] !== v); return q; },
      in: (k: string, v: unknown[]) => { filtros.push((r) => v.includes(r[k])); return q; },
      order: (_k: string, opts?: { ascending: boolean }) => { descendente = !opts?.ascending; return q; },
      limit: (n: number) => { limite = n; return q; },
      then: (res: (v: unknown) => unknown) => {
        let filas = estado.filas.filter((r) => filtros.every((f) => f(r)));
        if (descendente) filas = filas.sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)));
        // La proyección importa: no leer revision reproduce el bug aunque
        // la fixture completa sí la tenga. Los filtros ocurren antes del límite.
        const data = filas.slice(0, limite).map((r) => Object.fromEntries(Object.entries(r)
          .filter(([k]) => campos.includes(k) || k === 'viaje')));
        return Promise.resolve({ data, error: null }).then(res);
      },
    };
    return q;
  },
}) }));
vi.mock('./presupuesto', () => ({ acotada: (q: unknown) => q }));
vi.mock('./cuadre/desde_db', () => ({ cuadrarDesdeDB: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { getLiquidaciones, getLiquidacionesDeViajes } from './analytics';

const fila = (id: string, revision = 'aprobada', tenant = 'A') => ({
  id, tenant_id: tenant, viaje_id: `viaje-${id}`, viaje: { folio: `F-${id}` },
  revision, estatus: 'cuadrada', total_comprobado: revision === 'rechazada' ? 98765.43 : 120,
  diferencia: revision === 'rechazada' ? 4567.89 : 0, created_at: '2026-09-05T12:00:00Z',
});
beforeEach(() => { estado.filas = []; });

it('últimos cierres excluye rechazadas antes del límite50 y aísla flota', async () => {
  estado.filas = [
    ...Array.from({ length: 55 }, (_, i) => fila(`rechazada-${i}`, 'rechazada')),
    { ...fila('valida'), created_at: '2026-09-04T12:00:00Z' }, fila('ajena', 'aprobada', 'B'),
  ];
  const filas = await getLiquidaciones('A');
  expect(filas.map((r) => r.id)).toEqual(['valida']);
  expect(filas[0].comprobado).toBe(120);
});

it('pendiente, aprobada y ajustada siguen siendo cierres vigentes', async () => {
  estado.filas = ['pendiente', 'aprobada', 'ajustada'].map((r) => fila(r, r));
  expect((await getLiquidaciones('A')).map((r) => r.id).sort()).toEqual(['ajustada', 'aprobada', 'pendiente']);
});

it('registro conserva el enlace a rechazo y su estado, sin publicar importes invalidados', async () => {
  estado.filas = [fila('rechazo', 'rechazada'), fila('valida'), fila('ajena', 'aprobada', 'B')];
  const filas = await getLiquidacionesDeViajes('A', ['viaje-rechazo', 'viaje-valida', 'viaje-ajena']);
  expect(filas).toEqual([
    { id: 'rechazo', viajeId: 'viaje-rechazo', estatus: 'rechazada', comprobado: null, diferencia: null },
    { id: 'valida', viajeId: 'viaje-valida', estatus: 'cuadrada', comprobado: 120, diferencia: 0 },
  ]);
  // Sólo la proyección operativa cambia; el histórico completo sigue intacto.
  expect(estado.filas[0]).toMatchObject({ total_comprobado: 98765.43, diferencia: 4567.89, revision: 'rechazada' });
});

it('el viaje solicitado no autoriza leer la liquidación de otra flota', async () => {
  estado.filas = [fila('ajena', 'rechazada', 'B')];
  expect(await getLiquidacionesDeViajes('A', ['viaje-ajena'])).toEqual([]);
  expect(await getLiquidacionesDeViajes('B', ['viaje-ajena'])).toEqual([
    { id: 'ajena', viajeId: 'viaje-ajena', estatus: 'rechazada', comprobado: null, diferencia: null },
  ]);
});
