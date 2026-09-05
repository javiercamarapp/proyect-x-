import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24, TC-N3 (MEDIO) — `viajes_flota`/`liquidaciones_flota` decían
// `total` = el LÍMITE de la consulta (100/50). Con 15,000 viajes el analista
// contestaba «llevan 100 viajes» y `cifrasRespaldadas` lo dejaba pasar porque
// la tool lo devolvió. Aquí: `total` sale de un `count` real; si el conteo
// falla, `null` con nota — la regla del repo, nunca inventar una cifra.
//
// TC-N6 (BAJO): la lista de tools del analista que las pruebas recorrían era
// una lista A MANO dos tools atrás (`consultar_carta_porte`,
// `consultar_normas`). Aquí se lee `TOOLS_LECTURA` del propio `analista.ts`
// y se exige que cada una esté registrada y cierre `additionalProperties`.
// ═══════════════════════════════════════════════════════════════════════════

const conteo = vi.hoisted(() => ({ viaje: { count: 15_000 as number | null, error: null as { message: string } | null }, liquidacion: { count: 14_000 as number | null, error: null as { message: string } | null } }));
const espias = {
  getViajes: vi.fn(async () => Array.from({ length: 100 }, (_, i) => ({
    folio: `VJ-${i}`, origen: 'Mérida', destino: 'Cancún', estatus: 'abierto', anticipo: 5_000, operadorNombre: 'Juan', fechaInicio: '2026-09-01',
  }))),
  getLiquidaciones: vi.fn(async () => Array.from({ length: 50 }, (_, i) => ({
    folio: `VJ-${i}`, comprobado: 4_800, diferencia: -200, estatus: 'con_diferencias', creadoEn: '2026-09-01',
  }))),
  getKpis: vi.fn(), getAcreditables: vi.fn(), detectarAnomalias: vi.fn(),
  getGastoPorSemanaSeries: vi.fn(), getLiquidadoPorSemanaSeries: vi.fn(), getTopRutasPorGastoSeries: vi.fn(),
};
vi.mock('@/lib/likida/analytics', () => espias);
vi.mock('@/lib/likida/config', () => ({ getConfig: vi.fn(async () => ({ politica: {} })) }));
vi.mock('@/lib/likida/fiscal', () => ({ resolverPeriodo: vi.fn(), getGastosFiscales: vi.fn(), resumirPerdidas: vi.fn(), opcionesDe: vi.fn() }));
vi.mock('@/lib/likida/carta_porte_datos', () => ({ getEstadoCartaPorte: vi.fn() }));
vi.mock('@/lib/saludo', () => ({ ahoraMs: () => Date.parse('2026-09-01T18:00:00Z') }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/likida/presupuesto', () => ({ acotada: (q: unknown) => q }));
const tablasConsultadas: string[] = [];
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (tabla: 'viaje' | 'liquidacion') => ({
      select: (_c: string, opts?: { count?: string; head?: boolean }) => ({
        eq: async (col: string, v: string) => {
          tablasConsultadas.push(`${tabla}:${col}=${v}:${opts?.count}/${opts?.head}`);
          return { data: null, ...conteo[tabla] };
        },
      }),
    }),
  }),
}));

await import('./chat-tools');
const { toolSchemas, makeExecutor } = await import('@/lib/llm/tool-executor');
const TENANT = 'flota-innovativos';
const correr = (nombre: string) => makeExecutor({ tenantId: TENANT })(nombre, {});

beforeEach(() => {
  tablasConsultadas.length = 0;
  conteo.viaje = { count: 15_000, error: null };
  conteo.liquidacion = { count: 14_000, error: null };
});

describe('TC-N3 · `total` es el conteo real de la flota, no el límite de la consulta', () => {
  it('viajes_flota: 100 filas cargadas, 15,000 en la flota → total 15000, mostrando 25', async () => {
    const r = await correr('viajes_flota');
    expect(r.error).toBeUndefined();
    const res = r.result as { total: number | null; mostrando: number; nota?: string; viajes: unknown[] };
    expect(res.total).toBe(15_000);
    expect(res.mostrando).toBe(25);
    expect(res.viajes).toHaveLength(25);
    expect(res.nota).toBeUndefined();
    // El conteo va anclado a la flota, con count exact y head (sin filas).
    expect(tablasConsultadas).toEqual([`viaje:tenant_id=${TENANT}:exact/true`]);
  });

  it('liquidaciones_flota: 50 cargadas, 14,000 en la flota → total 14000, mostrando 20', async () => {
    const r = await correr('liquidaciones_flota');
    const res = r.result as { total: number | null; mostrando: number };
    expect(res).toMatchObject({ filtro: 'sin_rechazadas', totalIncluyeRechazadas: true });
    expect(res.total).toBe(14_000);
    expect(res.mostrando).toBe(20);
  });

  it('si el conteo falla o PostgREST no lo devuelve: total null con nota, nunca el límite', async () => {
    conteo.viaje = { count: null, error: { message: 'connection refused' } };
    let res = (await correr('viajes_flota')).result as { total: number | null; nota?: string };
    expect(res.total).toBeNull();
    expect(res.nota).toMatch(/no se pudo contar/);

    conteo.liquidacion = { count: null, error: null };   // sin count
    res = (await correr('liquidaciones_flota')).result as { total: number | null; nota?: string };
    expect(res.total).toBeNull();
    expect(res.nota).toMatch(/no se pudo contar/);
  });

  it('la descripción le dice al modelo qué es `total` y qué es `mostrando`', () => {
    for (const s of toolSchemas(['viajes_flota', 'liquidaciones_flota'])) {
      if (s.type !== 'function') throw new Error('tool custom');
      expect(s.function.description).toMatch(/`total` es el conteo REAL/);
      expect(s.function.description).toMatch(/null si no se pudo contar/);
    }
  });
});

describe('TC-N6 · la lista del analista sale del código, no de una lista a mano', () => {
  /** `TOOLS_LECTURA` de analista.ts, leída del fuente: es la lista que el chat de verdad recibe. */
  const fuente = readFileSync('src/lib/agents/analista.ts', 'utf8');
  const bloque = /const TOOLS_LECTURA = \[([\s\S]*?)\];/.exec(fuente)?.[1] ?? '';
  const TOOLS = [...bloque.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

  it('se leyeron las tools del analista (si esto falla, el regex se quedó ciego)', () => {
    expect(TOOLS.length).toBeGreaterThanOrEqual(12);
    expect(TOOLS).toContain('consultar_carta_porte');
    expect(TOOLS).toContain('consultar_normas');
  });

  it('cada una está registrada y cierra additionalProperties', () => {
    const schemas = toolSchemas(TOOLS);
    expect(schemas.map((s) => (s.type === 'function' ? s.function.name : '?'))).toEqual(TOOLS);
    for (const s of schemas) {
      if (s.type !== 'function') throw new Error('tool custom');
      const p = s.function.parameters as { additionalProperties?: boolean; properties?: Record<string, { enum?: unknown[]; type?: string }> };
      expect(p.additionalProperties, s.function.name).toBe(false);
      // Ningún parámetro de texto libre: solo enums cerrados.
      for (const [nombre, def] of Object.entries(p.properties ?? {})) {
        expect(def.enum, `${s.function.name}.${nombre}`).toBeDefined();
      }
    }
  });
});
