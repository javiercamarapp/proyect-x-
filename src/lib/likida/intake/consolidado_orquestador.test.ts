import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CfdiLineaXml, CfdiXmlData } from './cfdi_xml';

// ═══════════════════════════════════════════════════════════════════════════
// EL ORQUESTADOR IMPURO — `guardarYConciliarConsolidado` contra Supabase
// mockeado (auditoría 3, BE-A4). El hueco que la auditoría señaló: el motor
// puro (`conciliarLineas`) y la resolución manual tenían prueba; el
// orquestador de las DOS escrituras dependientes (sellar `gasto` + escribir
// `cfdi_consolidado_linea`) no tenía ninguna — y su modo de falla era un
// acuse que mentía ("están en el panel" con el panel en cero).
// ═══════════════════════════════════════════════════════════════════════════

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger }));

type Resp = { data: unknown; error: { message: string } | null };

let respXmlUpsert: Resp;
let respLineasExistentes: Resp;
let respSellados: Resp;
let respCandidatos: Resp;
let respGastoUpdate: Resp;
let respLineasUpsert: Resp;

/** Los `update` que llegaron a `gasto`: [vals, filtros...] por llamada. */
let xmlUpserts = 0;
let gastoUpdates: Array<Record<string, unknown>>;
/** El payload del upsert de `cfdi_consolidado_linea` (las filas de línea). */
let lineasUpsertPayload: Array<Record<string, unknown>> | null;

function thenable(resp: () => Resp) {
  const nodo: Record<string, unknown> = {};
  for (const m of ['eq', 'is', 'gte', 'lte', 'select', 'order']) nodo[m] = () => nodo;
  nodo.single = () => Promise.resolve(resp());
  // `traerTodo` pagina con `.range(d, h)`: el mock rebana como lo haría el
  // servidor — la página que empieza más allá del final llega vacía y con eso
  // el bucle de `traerTodo` sabe que terminó.
  nodo.range = (d: number, h: number) =>
    Promise.resolve(resp()).then((r) => ({
      ...r,
      data: Array.isArray(r.data) ? (r.data as unknown[]).slice(d, h + 1) : r.data,
    }));
  nodo.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
    Promise.resolve(resp()).then(onOk, onErr);
  return nodo;
}

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => ({
      upsert: (payload: unknown) => {
        if (tabla === 'cfdi_xml') { xmlUpserts += 1; return thenable(() => respXmlUpsert); }
        lineasUpsertPayload = payload as Array<Record<string, unknown>>;
        return thenable(() => respLineasUpsert);
      },
      select: (cols: string) => {
        if (tabla === 'cfdi_consolidado_linea') return thenable(() => respLineasExistentes);
        // `gasto`: dos lecturas distintas, distinguidas por sus columnas.
        return cols.includes('cfdi_orden')
          ? thenable(() => respSellados)
          : thenable(() => respCandidatos);
      },
      update: (vals: Record<string, unknown>) => {
        gastoUpdates.push(vals);
        return thenable(() => respGastoUpdate);
      },
    }),
  }),
}));

const { guardarYConciliarConsolidado } = await import('./consolidado');

const linea = (indice: number, monto: number, fecha?: string): CfdiLineaXml => ({
  indice, monto, fecha, fuente: fecha ? 'ecc12' : 'concepto_base',
});

const xmlConsolidado = (lineas: CfdiLineaXml[]): CfdiXmlData => ({
  uuid: 'UUID-CONSOLIDADO-1',
  iepsTraslado: 0, ivaTraslado: 0, ivaRetenido: 0, isrRetenido: 0, conceptos: [],
  complementoHidrocarburos: false, esquemaAlterno: false,
  lineas,
});

beforeEach(() => {
  respXmlUpsert = { data: { id: 'xml-1' }, error: null };
  respLineasExistentes = { data: [], error: null };
  respSellados = { data: [], error: null };
  respCandidatos = { data: [], error: null };
  respGastoUpdate = { data: [{ id: 'g' }], error: null };
  respLineasUpsert = { data: null, error: null };
  gastoUpdates = [];
  xmlUpserts = 0;
  lineasUpsertPayload = null;
  logger.error.mockClear();
});

describe('guardarYConciliarConsolidado — la segunda escritura NO se traga', () => {
  it('camino feliz: liga el gasto, escribe las líneas y el resumen dice la verdad', async () => {
    respCandidatos = { data: [{ id: 'g1', concepto: 'diesel', monto: 500, fecha: '2026-04-03' }], error: null };
    const r = await guardarYConciliarConsolidado('t1', xmlConsolidado([
      linea(1, 500, '2026-04-03T08:00:00'),
      linea(2, 900, '2026-04-05T10:00:00'),
    ]), '<xml/>');
    expect(r).toEqual({ cfdiXmlId: 'xml-1', totalLineas: 2, conciliadas: 1, porConciliar: 1 });
    expect(gastoUpdates).toHaveLength(1);
    expect(gastoUpdates[0]).toEqual({ cfdi_uuid: 'UUID-CONSOLIDADO-1', cfdi_orden: 1, xml_verificado: true });
    expect(lineasUpsertPayload).toHaveLength(2);
  });

  it('REPRO BE-A4: si el upsert de líneas falla, LANZA — nunca el resumen normal con la cola del contador perdida', async () => {
    respCandidatos = { data: [{ id: 'g1', concepto: 'diesel', monto: 500, fecha: '2026-04-03' }], error: null };
    respLineasUpsert = { data: null, error: { message: 'blip de red' } };
    await expect(guardarYConciliarConsolidado('t1', xmlConsolidado([
      linea(1, 500, '2026-04-03T08:00:00'),
      linea(2, 900, '2026-04-05T10:00:00'),
    ]), '<xml/>')).rejects.toThrow(/no se pudieron guardar las líneas/);
    expect(logger.error).toHaveBeenCalledWith('consolidado.guardar_lineas_error', expect.objectContaining({ cfdiXmlId: 'xml-1' }));
  });

  it('REANUDACIÓN: el reenvío tras la falla parcial NO reporta como huérfano lo que quedó sellado', async () => {
    // Corrida 1 selló g1 con este uuid (cfdi_orden = 1) y murió antes de
    // escribir líneas. En el reenvío: g1 ya NO es candidato (`cfdi_uuid`
    // dejó de ser null) — antes del arreglo su línea salía por_conciliar
    // con cero candidatos, "desligada" en apariencia.
    respSellados = { data: [{ id: 'g1', cfdi_orden: 1 }], error: null };
    respCandidatos = { data: [{ id: 'g2', concepto: 'diesel', monto: 900, fecha: '2026-04-05' }], error: null };
    const r = await guardarYConciliarConsolidado('t1', xmlConsolidado([
      linea(1, 500, '2026-04-03T08:00:00'),
      linea(2, 900, '2026-04-05T10:00:00'),
    ]), '<xml/>');
    expect(r).toEqual({ cfdiXmlId: 'xml-1', totalLineas: 2, conciliadas: 2, porConciliar: 0 });

    // La línea 1 se reconstruye desde el sello, sin re-ligar el gasto (ya
    // trae el sello — el único update es el de g2, la línea nueva).
    expect(gastoUpdates).toHaveLength(1);
    expect(gastoUpdates[0]).toEqual({ cfdi_uuid: 'UUID-CONSOLIDADO-1', cfdi_orden: 2, xml_verificado: true });
    const fila1 = lineasUpsertPayload?.find((f) => f.indice === 1);
    expect(fila1?.estatus).toBe('conciliada');
    expect(fila1?.gasto_id).toBe('g1');
  });

  it('si los sellos no se pueden LEER, falla cerrado — correr el JOIN a ciegas es lo que reportaba huérfanos falsos', async () => {
    respSellados = { data: null, error: { message: 'fetch failed' } };
    await expect(guardarYConciliarConsolidado('t1', xmlConsolidado([
      linea(1, 500, '2026-04-03T08:00:00'),
    ]), '<xml/>')).rejects.toThrow(/fetch failed/);
    expect(gastoUpdates).toHaveLength(0);
    expect(lineasUpsertPayload).toBeNull();
  });

  it('reenvío con las líneas YA escritas: devuelve lo registrado sin re-correr el JOIN ni tocar gastos', async () => {
    respLineasExistentes = { data: [{ estatus: 'conciliada' }, { estatus: 'por_conciliar' }], error: null };
    const r = await guardarYConciliarConsolidado('t1', xmlConsolidado([
      linea(1, 500, '2026-04-03T08:00:00'),
      linea(2, 900, '2026-04-05T10:00:00'),
    ]), '<xml/>');
    expect(r).toEqual({ cfdiXmlId: 'xml-1', totalLineas: 2, conciliadas: 1, porConciliar: 1 });
    expect(gastoUpdates).toHaveLength(0);
    expect(lineasUpsertPayload).toBeNull();
  });
});


it('rechaza una nota de crédito antes de persistir líneas o tocar gastos, incluso si llaman directo al escritor', async () => {
  respCandidatos = { data: [{ id: 'g1', concepto: 'diesel', monto: 500, fecha: '2026-04-03' }], error: null };
  const credito = { ...xmlConsolidado([linea(1,500,'2026-04-03T08:00:00'),linea(2,900,'2026-04-05T10:00:00')]), tipoComprobante: 'E' };
  await expect(guardarYConciliarConsolidado('t1', credito, '<xml/>')).rejects.toThrow(/nota de crédito/i);
  expect(xmlUpserts).toBe(0);
  expect(gastoUpdates).toHaveLength(0);
  expect(lineasUpsertPayload).toBeNull();
});
