import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// ROMPER EL AISLAMIENTO A PROPÓSITO — la prueba que el encargo exige.
//
// Un mock que devuelve filas fijas probaría el mock. Aquí el Supabase falso
// EJECUTA los filtros (`eq`, `or` de folio/origen/destino, `order`, `limit`)
// sobre una tabla con viajes de DOS flotas. Si algún lector del MCP olvidara
// el `.eq('tenant_id', …)`, estas pruebas verían filas de la flota B con la
// credencial de la A — que es exactamente la fuga que el servidor no se
// puede permitir.
//
// Además se afirma ESTRUCTURALMENTE que cada consulta aplicó un filtro de
// tenant: no basta con que hoy los datos no crucen, tiene que ser porque el
// filtro está.
// ═══════════════════════════════════════════════════════════════════════════

interface Filtro { tipo: 'eq' | 'is' | 'or'; col: string; val: unknown }

const consultas: Array<{ tabla: string; filtros: Filtro[] }> = [];

/** Un PostgREST falso que FILTRA de verdad sobre las filas dadas. */
function motorFalso(tablas: Record<string, Array<Record<string, unknown>>>) {
  return {
    from(tabla: string) {
      const registro = { tabla, filtros: [] as Filtro[] };
      consultas.push(registro);
      let filas = [...(tablas[tabla] ?? [])];
      let limite: number | null = null;
      const cadena: Record<string, unknown> = {};
      const self = () => cadena;
      Object.assign(cadena, {
        select: self,
        eq(col: string, val: unknown) {
          registro.filtros.push({ tipo: 'eq', col, val });
          filas = filas.filter((f) => f[col] === val);
          return cadena;
        },
        is(col: string, val: unknown) {
          registro.filtros.push({ tipo: 'is', col, val });
          filas = filas.filter((f) => f[col] === val);
          return cadena;
        },
        neq(col: string, val: unknown) {
          filas = filas.filter((f) => f[col] !== val);
          return cadena;
        },
        gte(col: string, val: unknown) {
          filas = filas.filter((f) => String(f[col] ?? '') >= String(val));
          return cadena;
        },
        or(expr: string) {
          registro.filtros.push({ tipo: 'or', col: 'or', val: expr });
          // Solo el dialecto que los lectores del MCP usan: ilike con %…%.
          const ramas = expr.split(',').map((r) => {
            const m = /^([a-z_]+)\.ilike\.%(.*)%$/.exec(r);
            return m ? { col: m[1], texto: m[2].toLowerCase() } : null;
          });
          filas = filas.filter((f) =>
            ramas.some((rama) => rama !== null && String(f[rama.col] ?? '').toLowerCase().includes(rama.texto)));
          return cadena;
        },
        order(col: string, opts?: { ascending?: boolean }) {
          const asc = opts?.ascending !== false;
          filas.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
          return cadena;
        },
        limit(n: number) {
          limite = n;
          return cadena;
        },
        range(desde: number, hasta: number) {
          filas = filas.slice(desde, hasta + 1);
          return cadena;
        },
        maybeSingle() {
          const resultado = { data: filas[0] ?? null, error: null };
          return { ...cadena, then: (fn: (r: unknown) => unknown) => Promise.resolve(resultado).then(fn) };
        },
        then(fn: (r: unknown) => unknown) {
          const rebanada = limite !== null ? filas.slice(0, limite) : filas;
          return Promise.resolve({ data: rebanada, error: null, count: null }).then(fn);
        },
      });
      return cadena;
    },
  };
}

const sbMock = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => sbMock() }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { listarViajesOperativos, resolverViaje, buscarViajesTexto } from './herramientas/viajes';

const VIAJE_A = {
  id: '11111111-1111-4111-8111-111111111111', tenant_id: 'flota-A', folio: 'F-100',
  origen: 'Monterrey', destino: 'Querétaro', fecha_inicio: '2026-08-20', estatus: 'abierto',
  created_at: '2026-08-20T10:00:00Z',
};
const VIAJE_B = {
  id: '22222222-2222-4222-8222-222222222222', tenant_id: 'flota-B', folio: 'F-100',
  origen: 'Monterrey', destino: 'Guadalajara', fecha_inicio: '2026-08-21', estatus: 'abierto',
  created_at: '2026-08-21T10:00:00Z',
};

beforeEach(() => {
  consultas.length = 0;
  sbMock.mockReturnValue(motorFalso({ viaje: [VIAJE_A, VIAJE_B] }));
});

describe('con la credencial de la flota A se pide lo de la B', () => {
  it('listar: solo aparecen los viajes de A, aunque B tenga más', async () => {
    const viajes = await listarViajesOperativos('flota-A', undefined, 20);
    expect(viajes.map((v) => v.id)).toEqual([VIAJE_A.id]);
  });

  it('resolver por ID EXACTO de un viaje de B → vacío, no el viaje', async () => {
    const r = await resolverViaje('flota-A', VIAJE_B.id);
    expect(r).toEqual([]);
  });

  it('resolver por folio compartido («F-100» existe en las dos flotas) → SOLO el de A', async () => {
    const r = await resolverViaje('flota-A', 'F-100');
    expect(r.map((v) => v.id)).toEqual([VIAJE_A.id]);
  });

  it('buscar texto que matchea en las dos flotas → solo filas de A', async () => {
    const r = await buscarViajesTexto('flota-A', 'Monterrey');
    expect(r.map((v) => v.id)).toEqual([VIAJE_A.id]);
    const cruzada = await buscarViajesTexto('flota-A', 'Guadalajara');
    expect(cruzada).toEqual([]);
  });

  // Auditoría 28, SEG-M1: `,` `(` `)` son los metacaracteres del propio
  // `.or()` de PostgREST (separan condiciones / abren-cierran agrupaciones).
  // Un texto libre con una coma, como «Monterrey, NL», se mete crudo en la
  // expresión `folio.ilike.%…%,origen.ilike.%…%,destino.ilike.%…%` y la
  // revienta en más ramas de las tres que el lector espera — el mismo motor
  // falso de este archivo, que ejecuta el `.or()` de verdad, deja de
  // reconocer las tres ramas (cada una debe terminar en `%`) y la búsqueda
  // deja de encontrar NADA, ni siquiera lo que sí es de la flota A.
  it('buscar con una coma en el valor («Monterrey, NL») arma exactamente 3 ramas ilike, no más', async () => {
    consultas.length = 0;
    await buscarViajesTexto('flota-A', 'Monterrey, NL');
    const or = consultas.at(-1)?.filtros.find((f) => f.tipo === 'or');
    expect(or, 'la búsqueda no llegó a armar un .or()').toBeTruthy();
    const expr = String(or?.val);
    const ramas = expr.split(',');
    expect(ramas, `expresión .or() con ramas de más: ${expr}`).toHaveLength(3);
    for (const rama of ramas) {
      expect(rama, `rama rota, la coma del usuario se coló sin sanear: ${expr}`)
        .toMatch(/^[a-z_]+\.ilike\.%.*%$/);
    }
  });

  it('buscar con paréntesis en el valor tampoco rompe el filtro', async () => {
    consultas.length = 0;
    await buscarViajesTexto('flota-A', 'Monterrey (centro)');
    const or = consultas.at(-1)?.filtros.find((f) => f.tipo === 'or');
    const expr = String(or?.val);
    expect(expr.split(',')).toHaveLength(3);
    for (const rama of expr.split(',')) {
      expect(rama).toMatch(/^[a-z_]+\.ilike\.%.*%$/);
    }
  });

  it('ESTRUCTURAL: cada consulta que salió llevó su eq de tenant', async () => {
    await listarViajesOperativos('flota-A', 'abierto', 5);
    await resolverViaje('flota-A', VIAJE_B.id);
    await buscarViajesTexto('flota-A', 'F-100');
    expect(consultas.length).toBeGreaterThanOrEqual(3);
    for (const c of consultas) {
      const deTenant = c.filtros.find((f) => f.col === 'tenant_id');
      expect(deTenant, `consulta a «${c.tabla}» sin filtro de flota`).toBeTruthy();
      expect(deTenant?.val).toBe('flota-A');
    }
  });

  it('una flota INEXISTENTE no ve nada — jamás un fallback a otra', async () => {
    expect(await listarViajesOperativos('flota-que-no-existe', undefined, 20)).toEqual([]);
    expect(await resolverViaje('flota-que-no-existe', 'F-100')).toEqual([]);
  });
});
