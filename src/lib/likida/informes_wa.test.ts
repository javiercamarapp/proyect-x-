import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// El informe del jefe ("¿cómo van?"): cifras REALES de consultas
// estructuradas, sin modelo. Lo más probado: que el dinero solo salga para
// el rol que lo ve en el panel, y que una consulta caída se DIGA — nunca un
// cero que parezca medición.
// ═══════════════════════════════════════════════════════════════════════════

const getTableroOperacion = vi.fn();
vi.mock('./operacion', () => ({ getTableroOperacion: (...a: unknown[]) => getTableroOperacion(...a) }));

// Los anticipos: la única consulta directa del módulo (viaje, paginada).
let filasAnticipo: Array<{ anticipo: number | null }> | null;
let errorAnticipo: { message: string } | null;
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      if (tabla !== 'viaje') throw new Error(`informes_wa solo consulta viaje; pidió ${tabla}`);
      const b = {
        select: () => b, eq: () => b, in: () => b, order: () => b,
        // `traerTodo` pagina con `.range(d, h)`: el mock rebana como lo haría
        // el servidor — la página que empieza más allá del final llega vacía
        // y con eso el bucle sabe que terminó.
        range: async (d: number, h: number) => ({
          data: filasAnticipo === null ? null : filasAnticipo.slice(d, h + 1),
          error: errorAnticipo,
        }),
      };
      return b;
    },
  }),
}));
vi.mock('./presupuesto', async (orig) => ({
  ...(await orig() as object),
  acotada: (q: unknown) => q,
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { interpretarInforme, armarInforme, atenderInformeOficina } = await import('./informes_wa');

const TABLERO = {
  viajesActivos: 3, sinUnidad: 1,
  unidadesDisponibles: 4, unidadesEnTaller: 1,
  incidenciasAbiertas: 2, podPendientes: 1,
};

beforeEach(() => {
  getTableroOperacion.mockReset();
  getTableroOperacion.mockResolvedValue({ ...TABLERO });
  filasAnticipo = [{ anticipo: 8000 }, { anticipo: 10600 }, { anticipo: null }];
  errorAnticipo = null;
});

describe('interpretarInforme — anclado, como consulta_chofer', () => {
  it('reconoce las formas reales de pedir el resumen', () => {
    for (const t of ['¿cómo van?', 'como vamos', 'resumen', 'informe de hoy', 'reporte',
      'cuántos viajes abiertos hay', 'cuantos viajes en curso van', 'qué pendientes hay', 'estado de la flota']) {
      expect(interpretarInforme(t), t).toBe(true);
    }
  });

  it('NO se traga lo que no es el informe', () => {
    for (const t of ['hola', 'nuevo viaje para Juan, Puebla a Monterrey', 'como va Juan con su viaje',
      'asígnale la unidad 12 al viaje de Juan', 'autorizo', 'cuánto llevo']) {
      expect(interpretarInforme(t), t).toBe(false);
    }
  });
});

describe('armarInforme — cifras reales por rol', () => {
  it('al dueño le salen los conteos Y el dinero', async () => {
    const r = await armarInforme('t1', 'flota_admin');
    expect(r).toContain('3 viajes en curso');
    expect(r).toContain('(1 sin unidad asignada)');
    expect(r).toContain('4 disponibles, 1 en taller');
    expect(r).toContain('2 incidencias abiertas');
    expect(r).toContain('1 viaje sin evidencia de entrega (POD)');
    // 8000 + 10600 + null→0 en la suma… no: null suma 0 PERO el viaje cuenta.
    expect(r).toContain('$18,600.00');
    expect(r).toContain('3 viajes sin liquidar');
  });

  it('al ENCARGADO no le salen pesos — la matriz de visibilidad manda también aquí', async () => {
    const r = await armarInforme('t1', 'encargado');
    expect(r).toContain('3 viajes en curso');
    expect(r).not.toContain('$');
    expect(r).not.toContain('Anticipos');
  });

  it('al contador sí le salen (su área es dinero)', async () => {
    const r = await armarInforme('t1', 'contador');
    expect(r).toContain('$18,600.00');
  });

  it('el singular se escribe en singular: "1 incidencia abierta", no "1 incidencias"', async () => {
    getTableroOperacion.mockResolvedValue({ ...TABLERO, incidenciasAbiertas: 1, viajesActivos: 1, sinUnidad: 0 });
    const r = await armarInforme('t1', 'encargado');
    expect(r).toContain('1 viaje en curso');
    expect(r).toContain('1 incidencia abierta');
    expect(r).not.toContain('1 incidencias');
  });

  it('tablero ilegible: se dice que no se pudo — CERO números', async () => {
    getTableroOperacion.mockRejectedValue(new Error('base caída'));
    const r = await armarInforme('t1', 'flota_admin');
    expect(r).toContain('No pude leer');
    expect(r).not.toMatch(/\d viajes/);
    expect(r).not.toContain('$');
  });

  it('solo el dinero caído: los conteos salen y la línea de pesos dice la verdad', async () => {
    // Fiel a supabase-js: con `error` presente, `data` viaja `null` — nunca
    // un array. `range()` del mock lo refleja para que esta prueba SÍ pase
    // por la rama `filasAnticipo === null` de la línea 26.
    filasAnticipo = null;
    errorAnticipo = { message: 'boom' };
    const r = await armarInforme('t1', 'flota_admin');
    expect(r).toContain('3 viajes en curso');
    expect(r).toContain('no los pude leer');
    expect(r).not.toContain('$0');
  });

  it('sin viajes sin liquidar el dinero lo dice, sin inventar un $0.00 medido', async () => {
    filasAnticipo = [];
    const r = await armarInforme('t1', 'flota_admin');
    expect(r).toContain('no hay viajes sin liquidar');
    expect(r).not.toContain('$0.00');
  });
});

describe('atenderInformeOficina', () => {
  it('lo que no es informe devuelve null sin consultar nada', async () => {
    const r = await atenderInformeOficina({ tenantId: 't1', rol: 'flota_admin' }, 'hola buenas');
    expect(r).toBeNull();
    expect(getTableroOperacion).not.toHaveBeenCalled();
  });

  it('superadmin sin flota: null — no hay flota que resumir', async () => {
    const r = await atenderInformeOficina({ tenantId: null, rol: 'superadmin' }, 'resumen');
    expect(r).toBeNull();
  });
});
