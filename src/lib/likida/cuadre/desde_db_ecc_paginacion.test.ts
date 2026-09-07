import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28, ARQ-A1/ARQ-A2 (CRÍTICO, RMF 3.3.1.7): `lineasEccParaCuadre`
// (desde_db.ts) traía las líneas ECC con un `.select()` SIN `traerTodo` — sin
// `.order()`/`.range()` — así que PostgREST recortaba EN SILENCIO a
// `max_rows` (1,000 filas). Una flota con más de 1,000 líneas de estado de
// cuenta del monedero en la ventana de un cuadre perdía el camino B de
// `evidenciaMonedero` para las líneas que sobraban del corte, y ni el
// operador ni el contralor se enteraban: el gasto simplemente no se marcaba
// `ticket_monedero` — el ticket de bomba (que RMF 3.3.1.7 prohíbe facturar
// cuando hay evidencia de monedero) quedaba con cara de comprobante fiscal
// válido para acreditar IVA que no procede.
//
// Esta prueba simula 1,560 líneas ECC —más de PAGINA (1,000)— con la línea
// que hace match puesta a propósito en la fila #1,500, bien pasado el corte
// de 1,000. Si `lineasEccParaCuadre` no paginara de verdad, esta prueba
// fallaría EXACTAMENTE como falló en producción: el motor devolvería el
// gasto sin `ticket_monedero`.
// ═══════════════════════════════════════════════════════════════════════════

const getViaje = vi.fn();
const getGastos = vi.fn();
const getOperador = vi.fn();
const getAcumuladoCombustible = vi.fn();
const getPerfilCrudo = vi.fn();
const getConfig = vi.fn();

vi.mock('../repo', () => ({
  getViaje: (...a: unknown[]) => getViaje(...a),
  getGastos: (...a: unknown[]) => getGastos(...a),
  getOperador: (...a: unknown[]) => getOperador(...a),
  getAcumuladoCombustible: (...a: unknown[]) => getAcumuladoCombustible(...a),
  getPerfilCrudo: (...a: unknown[]) => getPerfilCrudo(...a),
}));
vi.mock('../config', () => ({ getConfig: (...a: unknown[]) => getConfig(...a) }));
vi.mock('../perfil/preguntas', () => ({
  calificaEstimuloPeaje: () => ({ elegible: undefined }),
  facilidad15Declarada: () => null,
  // AUDITORÍA 28, FIS-A3 (#385): con facilidad15Declarada -> null y el fixture
  // de getConfig sin facilidadCombustibleEfectivo, la función real devolvería
  // undefined — se replica aquí en vez de solo silenciar el mock.
  facilidad15Vigente: () => undefined,
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../presupuesto', () => ({ acotada: (q: unknown) => q }));

const TOTAL_LINEAS_ECC = 1_560;
/** Bien pasado el corte silencioso de PostgREST (1,000 filas). */
const INDICE_LINEA_QUE_EMPAREJA = 1_500;
const FECHA_GASTO = '2026-09-03';
// RFC fuera de la semilla de `padron_monederos.json` a propósito — así el
// único camino que puede afirmar `ticket_monedero` aquí es el B (línea ECC),
// no el A (padrón), y la prueba de verdad ejercita la paginación.
const ESTACION_RFC = 'EKU9003173C9';
const MONTO_GASTO = 987.65;

/** Las 1,560 líneas simuladas. Solo la #1,500 hace match en monto — las
 *  demás comparten estación y fecha pero un monto distinto, para que
 *  `evidenciaMonedero` no pudiera pegarle por accidente a cualquiera. */
const TODAS_LAS_LINEAS = Array.from({ length: TOTAL_LINEAS_ECC }, (_, i) => ({
  fecha: FECHA_GASTO,
  monto: i === INDICE_LINEA_QUE_EMPAREJA ? MONTO_GASTO : 50 + (i % 40),
  estacion_rfc: ESTACION_RFC,
}));

// La cadena simulada de Supabase: a diferencia de otras pruebas del archivo
// (que ignoran `range`), ÉSTA sí lo respeta — es la única forma de demostrar
// que `traerTodo` pide de verdad la SEGUNDA página y no se conforma con la
// primera. `count` solo viaja en la primera página, igual que el contrato
// real de `conteo(d)` en pg.ts.
let ultimoRango: { desde: number; hasta: number } | null = null;
const eccCadena: Record<string, unknown> = {};
for (const metodo of ['select', 'eq', 'not', 'gte', 'lte', 'order']) {
  eccCadena[metodo] = () => eccCadena;
}
eccCadena.range = (desde: number, hasta: number) => {
  ultimoRango = { desde, hasta };
  return eccCadena;
};
/** `max_rows` de PostgREST (pg.ts::PAGINA). Sin `.range(...)` explícito —
 *  como hacía el código viejo, sin `traerTodo` — un `.select()` real se
 *  recorta EN SILENCIO a esto desde la fila 0, no devuelve la tabla entera.
 *  El fallback imita justo eso: es lo que hace que esta prueba SÍ falle
 *  contra el código de antes de la AUDITORÍA 28 (verificado con
 *  `git stash` sobre desde_db.ts) en vez de pasar por accidente. */
const MAX_ROWS_SIN_RANGE = 1_000;
eccCadena.then = (resolve: (valor: unknown) => unknown) => {
  const { desde, hasta } = ultimoRango ?? { desde: 0, hasta: MAX_ROWS_SIN_RANGE - 1 };
  const pagina = TODAS_LAS_LINEAS.slice(desde, hasta + 1);
  const respuesta = { data: pagina, error: null, count: desde === 0 ? TOTAL_LINEAS_ECC : undefined };
  return Promise.resolve(respuesta).then(resolve);
};

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: () => eccCadena }) }));

const { cuadrarDesdeDB } = await import('./desde_db');

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

beforeEach(() => {
  vi.clearAllMocks();
  ultimoRango = null;
  getViaje.mockResolvedValue({ id: U(9), anticipo: 9000, operadorId: null, fechaInicio: FECHA_GASTO, destino: 'CDMX' });
  getOperador.mockResolvedValue(null);
  getConfig.mockResolvedValue({
    politica: [], agentes: { liquidacion: { umbralConfianza: 0.85 } }, empresa: {}, hidrocarburos: undefined, estimulos: undefined,
    validacion: { fechaToleranciaDiasAntes: 3 },
  });
  getPerfilCrudo.mockResolvedValue({});
  getAcumuladoCombustible.mockResolvedValue({ efectivo: 0, totalCombustible: 0 });
});

describe('lineasEccParaCuadre — 1,560 líneas ECC, todas leídas (AUDITORÍA 28)', () => {
  it('lee las 1,560 líneas completas (dos páginas) y no se detiene en la primera de 1,000', async () => {
    // Un gasto CON fecha, para que `lineasEccParaCuadre` de verdad dispare la
    // consulta (sin gastos con fecha, la función regresa `[]` antes de tocar
    // la base — caso ya cubierto en `desde_db_override.test.ts`). Este gasto
    // a propósito no empareja con nada (RFC fuera de la ventana de match).
    getGastos.mockResolvedValue([{ id: U(2), concepto: 'diesel' as const, monto: 1, fecha: FECHA_GASTO }]);
    await cuadrarDesdeDB('t1', U(9), undefined, { modo: 'cierre' });
    // Si el código no pidiera la segunda página, `ultimoRango` se habría
    // quedado en la primera (`{ desde: 0, hasta: 999 }`) y nunca en la que
    // cubre la fila #1,500.
    expect(ultimoRango).toEqual({ desde: 1_000, hasta: 1_999 });
  });

  it('el gasto que empareja con la línea ECC #1,500 sale marcado ticket_monedero, no como CFDI válido', async () => {
    const gasto = {
      id: U(1),
      concepto: 'diesel' as const,
      monto: MONTO_GASTO,
      fecha: FECHA_GASTO,
      rfcEmisor: ESTACION_RFC,
    };
    getGastos.mockResolvedValue([gasto]);

    const liq = await cuadrarDesdeDB('t1', U(9), undefined, { modo: 'cierre' });

    const diferencia = liq.diferencias.find((d) => d.tipo === 'ticket_monedero' && d.gastoId === U(1));
    expect(
      diferencia,
      'con 1,560 líneas ECC (más de las 1,000 que PostgREST recorta en silencio), el camino B ' +
      'de RMF 3.3.1.7 tiene que seguir viendo la línea #1,500 y marcar el gasto — si esto falla, ' +
      'la paginación se rompió otra vez y el ticket de bomba se cuela como comprobante fiscal válido.',
    ).toBeDefined();
    expect(diferencia?.nota).toContain(FECHA_GASTO);
    expect(diferencia?.nota).toContain(ESTACION_RFC);
  });

  it('control: sin la línea #1,500 (menos de 1,560 en la ventana) el mismo gasto NO se marca', async () => {
    // Prueba negativa: demuestra que el `ticket_monedero` del caso anterior
    // vino de verdad de la línea #1,500 y no de una coincidencia accidental
    // en otra fila con el mismo día/estación.
    const gasto = {
      id: U(1),
      concepto: 'diesel' as const,
      monto: MONTO_GASTO,
      fecha: FECHA_GASTO,
      rfcEmisor: ESTACION_RFC,
    };
    getGastos.mockResolvedValue([gasto]);
    const original = TODAS_LAS_LINEAS[INDICE_LINEA_QUE_EMPAREJA].monto;
    TODAS_LAS_LINEAS[INDICE_LINEA_QUE_EMPAREJA] = { ...TODAS_LAS_LINEAS[INDICE_LINEA_QUE_EMPAREJA], monto: 1 };
    try {
      const liq = await cuadrarDesdeDB('t1', U(9), undefined, { modo: 'cierre' });
      expect(liq.diferencias.find((d) => d.tipo === 'ticket_monedero' && d.gastoId === U(1))).toBeUndefined();
    } finally {
      TODAS_LAS_LINEAS[INDICE_LINEA_QUE_EMPAREJA] = { ...TODAS_LAS_LINEAS[INDICE_LINEA_QUE_EMPAREJA], monto: original };
    }
  });
});
