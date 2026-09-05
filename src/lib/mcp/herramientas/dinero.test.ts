import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mxn, numero, porcentaje, fechaCorta } from '@/lib/formato';
import type { RenglonLibro } from '@/lib/likida/libro_viaje';
import type { TicketPorFacturar } from '@/lib/likida/facturacion/pendientes';
import type { ViajeOperativo } from './viajes';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA E.28, PRU-C2 (CRÍTICO pruebas) — las CUATRO herramientas de
// DINERO del servidor MCP (`cuadre_viaje`, `por_facturar`, `resumen_fiscal`,
// `metricas_flota`) medían, contra `coverage-final.json` del suite completo:
//
//     líneas: 11.26% (8/71)   ramas: 0% (0/66)   funciones: 0% (0/10)
//
// `herramientas.test.ts` solo prueba el DESPACHADOR (la llave de área y el
// catálogo); ninguna prueba en todo el repo llama `ejecutar()` de estas
// cuatro herramientas ni una sola vez. Cero ramas cubiertas en herramientas
// que le devuelven cifras de dinero de la flota a un modelo de terceros.
//
// El motor de cada una (`getLibroViaje`, `getPorFacturar`, `resumirFiscal`,
// `getKpis`) ya está probado en su propio archivo — el propio comentario de
// `dinero.ts` lo dice: "cada una pone un texto encima de un motor que ya
// existe". Lo que NUNCA se había probado es el WRAPPER: el texto que arma,
// las ramas de "sin datos", y la regla de la casa (`null` se DICE, nunca se
// convierte en 0 ni en "sin dato" con cara de medición).
// ═══════════════════════════════════════════════════════════════════════════

const resolverViaje = vi.fn();
const rotuloViaje = vi.fn((v: ViajeOperativo) => `Viaje ${v.folio}`);
const getLibroViaje = vi.fn();
const getPorFacturar = vi.fn();
const getGastosFiscales = vi.fn();
const resumirFiscal = vi.fn();
const resumirPerdidas = vi.fn();
const opcionesDe = vi.fn();
const opcionesFiscalesDelPeriodo = vi.fn();
const resolverPeriodo = vi.fn();
const getConfig = vi.fn();
const getKpis = vi.fn();

vi.mock('./viajes', () => ({
  resolverViaje: (...a: unknown[]) => resolverViaje(...a),
  rotuloViaje: (v: ViajeOperativo) => rotuloViaje(v),
}));
vi.mock('@/lib/likida/libro_viaje', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getLibroViaje: (...a: unknown[]) => getLibroViaje(...a),
}));
vi.mock('@/lib/likida/facturacion/pendientes', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getPorFacturar: (...a: unknown[]) => getPorFacturar(...a),
  // `resumen` (aliaseado a `resumenPorFacturar`) se deja REAL: es una
  // función pura sobre la lista de tickets y probarla de verdad —no un
  // doble que "ya sabe" la respuesta— es lo que fija el conteo/suma.
}));
vi.mock('@/lib/likida/fiscal', () => ({
  getGastosFiscales: (...a: unknown[]) => getGastosFiscales(...a),
  resumirFiscal: (...a: unknown[]) => resumirFiscal(...a),
  resumirPerdidas: (...a: unknown[]) => resumirPerdidas(...a),
  opcionesDe: (...a: unknown[]) => opcionesDe(...a),
  opcionesFiscalesDelPeriodo: (...a: unknown[]) => opcionesFiscalesDelPeriodo(...a),
  resolverPeriodo: (...a: unknown[]) => resolverPeriodo(...a),
}));
vi.mock('@/lib/likida/config', () => ({ getConfig: (...a: unknown[]) => getConfig(...a) }));
vi.mock('@/lib/likida/analytics', () => ({ getKpis: (...a: unknown[]) => getKpis(...a) }));

const {
  herramientaCuadreViaje, herramientaPorFacturar, herramientaResumenFiscal, herramientaMetricasFlota,
  contarRenglon,
} = await import('./dinero');

beforeEach(() => {
  vi.clearAllMocks();
  rotuloViaje.mockImplementation((v: ViajeOperativo) => `Viaje ${v.folio}`);
});

// ── contarRenglon — la función pura, RAMA por RAMA ──────────────────────────

const VIAJE: ViajeOperativo = { id: 'v1', folio: 'F-100', ruta: null, fechaInicio: null, estatus: 'abierto' };

function renglonBase(extra: Partial<RenglonLibro> = {}): RenglonLibro {
  return {
    viajeId: 'v1', folio: 'F-100', ruta: null, fechaInicio: null, estatus: 'abierto',
    cliente: null, unidad: null, operador: null, ingreso: null, comprobado: null,
    contribucion: null, margenPct: null, falta: null, liquidacionId: null,
    documental: { estado: 'sin_comprobantes', comprobantes: 0, conCfdi: 0, sinCfdi: 0, rotulo: 'Sin comprobantes' },
    observaciones: null,
    cobro: {
      estadoFacturacion: 'sin_factura', estadoCobro: 'sin_factura',
      totalFacturado: null, totalCobrado: null, saldo: null,
      diasPorCobrar: null, diasVencida: null, sinCondiciones: false,
      importesCompartidos: false, facturas: [],
    },
    ...extra,
  };
}

describe('contarRenglon — el renglón mínimo (todo en null/sin dato)', () => {
  it('dice "sin capturar" y "sin liquidación todavía" — nunca $0.00 disfrazado de medición', () => {
    const texto = contarRenglon(renglonBase());
    expect(texto).toContain('Ingreso del flete: sin capturar');
    expect(texto).toContain('Comprobado: sin liquidación todavía');
    expect(texto).not.toContain(mxn(0));
  });

  it('sin ruta/fecha/cliente/unidad, el encabezado no los inventa', () => {
    const texto = contarRenglon(renglonBase());
    expect(texto.split('\n')[0]).toBe('Viaje F-100');
  });

  it('con ruta, fecha, cliente y unidad, el encabezado los cita todos', () => {
    const texto = contarRenglon(renglonBase({
      ruta: 'Puebla → Monterrey', fechaInicio: '2026-08-10', cliente: 'ACME', unidad: '12',
    }));
    expect(texto.split('\n')[0]).toBe(`Viaje F-100 · Puebla → Monterrey · inició ${fechaCorta('2026-08-10')}`);
    expect(texto.split('\n')[1]).toBe('Estatus: abierto · Cliente: ACME · Unidad: 12');
  });

  it('"en_cuadre" se traduce a "en cuadre"; cualquier otro estatus se dice tal cual', () => {
    expect(contarRenglon(renglonBase({ estatus: 'en_cuadre' }))).toContain('Estatus: en cuadre');
    expect(contarRenglon(renglonBase({ estatus: 'liquidado' }))).toContain('Estatus: liquidado');
  });

  it('sin liquidación, "Observaciones fiscales" dice que aún no hay qué revisar', () => {
    const texto = contarRenglon(renglonBase({ observaciones: null }));
    expect(texto).toContain('Observaciones fiscales: aún no hay liquidación que revisar.');
  });

  it('con liquidación y CERO observaciones, dice que el cuadre salió limpio', () => {
    const texto = contarRenglon(renglonBase({ observaciones: [] }));
    expect(texto).toContain('Observaciones fiscales: ninguna — el cuadre salió limpio.');
  });
});

describe('contarRenglon — ingreso y comprobado con dato real', () => {
  it('formatea ingreso y comprobado en MXN cuando ambos existen', () => {
    const texto = contarRenglon(renglonBase({ ingreso: 15000, comprobado: 8200 }));
    expect(texto).toContain(`Ingreso del flete: ${mxn(15000)}`);
    expect(texto).toContain(`Comprobado: ${mxn(8200)}`);
  });

  it('ingreso en $0 real (no null) se muestra como $0.00, no como "sin capturar"', () => {
    const texto = contarRenglon(renglonBase({ ingreso: 0, comprobado: 0 }));
    expect(texto).toContain(`Ingreso del flete: ${mxn(0)}`);
    expect(texto).toContain(`Comprobado: ${mxn(0)}`);
  });
});

describe('contarRenglon — contribución, margen y "falta"', () => {
  it('con contribución Y margen, los muestra juntos', () => {
    const texto = contarRenglon(renglonBase({ contribucion: 3200, margenPct: 21.5 }));
    expect(texto).toContain(`Contribución: ${mxn(3200)} (margen ${porcentaje(21.5)})`);
  });

  it('sin contribución pero con "falta", explica qué falta en vez de omitir la línea', () => {
    const texto = contarRenglon(renglonBase({ contribucion: null, margenPct: null, falta: 'sin ingreso capturado' }));
    expect(texto).toContain('Contribución: no se puede afirmar — sin ingreso capturado');
  });

  it('sin contribución y sin "falta", NO inventa ninguna línea de contribución', () => {
    const texto = contarRenglon(renglonBase({ contribucion: null, margenPct: null, falta: null }));
    expect(texto).not.toContain('Contribución');
  });
});

describe('contarRenglon — observaciones fiscales, con el corte de 8', () => {
  function obs(n: number) {
    return Array.from({ length: n }, (_, i) => ({ tipo: `t${i}`, nota: `nota ${i}`, monto: null }));
  }

  it('con 3 observaciones, las lista todas y no menciona "más"', () => {
    const texto = contarRenglon(renglonBase({ observaciones: obs(3) }));
    expect(texto).toContain('Observaciones fiscales (3):');
    expect(texto).toContain('nota 0');
    expect(texto).toContain('nota 2');
    expect(texto).not.toContain('más en el panel');
  });

  it('con 12 observaciones, corta en 8 y avisa cuántas quedaron fuera', () => {
    const texto = contarRenglon(renglonBase({ observaciones: obs(12) }));
    expect(texto).toContain('Observaciones fiscales (12):');
    expect(texto).toContain('nota 7');
    expect(texto).not.toContain('nota 8');
    expect(texto).toContain('…y 4 más en el panel.');
  });

  it('exactamente 8 observaciones no dispara el aviso de "más"', () => {
    const texto = contarRenglon(renglonBase({ observaciones: obs(8) }));
    expect(texto).toContain('nota 7');
    expect(texto).not.toContain('más en el panel');
  });
});

describe('contarRenglon — facturación, cobro y saldo', () => {
  it('sin saldo pendiente, no menciona ningún saldo ni vencimiento', () => {
    const texto = contarRenglon(renglonBase({
      cobro: { ...renglonBase().cobro, estadoFacturacion: 'facturado', estadoCobro: 'cobrado', saldo: 0 },
    }));
    expect(texto).toContain('Facturado');
    expect(texto).toContain('Cobrado');
    expect(texto).not.toContain('saldo por cobrar');
  });

  it('con saldo > 0 y días vencida, los cita a ambos', () => {
    const texto = contarRenglon(renglonBase({
      cobro: { ...renglonBase().cobro, estadoFacturacion: 'facturado', estadoCobro: 'parcial', saldo: 4500, diasVencida: 12 },
    }));
    expect(texto).toContain(`saldo por cobrar ${mxn(4500)} (vencido hace 12 días)`);
  });

  it('con saldo > 0 y 1 día vencida, usa el singular ("1 día", no "1 días")', () => {
    const texto = contarRenglon(renglonBase({
      cobro: { ...renglonBase().cobro, saldo: 100, diasVencida: 1 },
    }));
    expect(texto).toContain('vencido hace 1 día)');
  });

  it('con saldo > 0 pero SIN días vencida (aún en plazo), no inventa un "vencido hace"', () => {
    const texto = contarRenglon(renglonBase({
      cobro: { ...renglonBase().cobro, saldo: 900, diasVencida: null },
    }));
    expect(texto).toContain(`saldo por cobrar ${mxn(900)}`);
    expect(texto).not.toContain('vencido hace');
  });

  it('con importesCompartidos, avisa que la factura ampara varios viajes', () => {
    const texto = contarRenglon(renglonBase({
      cobro: { ...renglonBase().cobro, importesCompartidos: true },
    }));
    expect(texto).toContain('hay una factura que ampara varios viajes');
  });
});

// ── cuadre_viaje ─────────────────────────────────────────────────────────

describe('herramientaCuadreViaje.ejecutar', () => {
  it('ningún candidato → dice que no encontró el viaje y no llama a getLibroViaje', async () => {
    resolverViaje.mockResolvedValue([]);
    const r = await herramientaCuadreViaje.ejecutar('t1', { viaje: 'F-999' }, { alcanza: () => true });
    expect(r.texto).toMatch(/No encontré ningún viaje «F-999»/);
    expect(getLibroViaje).not.toHaveBeenCalled();
  });

  it('dos candidatos → NO adivina: los lista y pide el id, sin llamar a getLibroViaje', async () => {
    resolverViaje.mockResolvedValue([VIAJE, { ...VIAJE, id: 'v2', folio: 'F-100' }]);
    const r = await herramientaCuadreViaje.ejecutar('t1', { viaje: 'F-100' }, { alcanza: () => true });
    expect(r.texto).toContain('Hay 2 viajes con el folio «F-100»');
    expect(r.estructurado).toMatchObject({ ambiguo: true });
    expect(getLibroViaje).not.toHaveBeenCalled();
  });

  it('un candidato pero getLibroViaje ya no lo encuentra (borrado entre las dos consultas) → mensaje honesto', async () => {
    resolverViaje.mockResolvedValue([VIAJE]);
    getLibroViaje.mockResolvedValue(null);
    const r = await herramientaCuadreViaje.ejecutar('t1', { viaje: 'F-100' }, { alcanza: () => true });
    expect(r.texto).toBe('No encontré ningún viaje «F-100» en tu flota.');
  });

  it('camino feliz: un candidato, un renglón → texto y estructurado con el renglón completo', async () => {
    resolverViaje.mockResolvedValue([VIAJE]);
    const renglon = renglonBase({ ingreso: 10000, comprobado: 6000 });
    getLibroViaje.mockResolvedValue(renglon);
    const r = await herramientaCuadreViaje.ejecutar('t1', { viaje: 'F-100' }, { alcanza: () => true });
    expect(getLibroViaje).toHaveBeenCalledWith('t1', 'v1');
    expect(r.texto).toBe(contarRenglon(renglon));
    expect(r.estructurado).toEqual({ viaje: renglon });
  });
});

// ── por_facturar ─────────────────────────────────────────────────────────

function ticket(extra: Partial<TicketPorFacturar> = {}): TicketPorFacturar {
  return {
    gastoId: 'g1', concepto: 'diesel', monto: 500, fecha: '2026-08-01', folio: 'F1',
    urlTicket: null, comercio: null, campos: [], camposPendientes: false,
    caducidad: { diasRestantes: 10, vencido: false, urgente: false, desconocido: false },
    plazoVerificado: true, bloqueo: null,
    ...extra,
  };
}

describe('herramientaPorFacturar.ejecutar', () => {
  it('sin tickets pendientes → mensaje de "nada que perder" y urgentes vacío', async () => {
    getPorFacturar.mockResolvedValue([]);
    const r = await herramientaPorFacturar.ejecutar('t1', {}, { alcanza: () => true });
    expect(r.texto).toMatch(/No hay comprobantes pendientes de facturar/);
    expect(r.estructurado).toMatchObject({ urgentes: [] });
  });

  it('con un ticket VENCIDO, lo marca VENCIDO y no como "vence en N días"', async () => {
    getPorFacturar.mockResolvedValue([ticket({
      caducidad: { diasRestantes: -3, vencido: true, urgente: false, desconocido: false },
    })]);
    const r = await herramientaPorFacturar.ejecutar('t1', {}, { alcanza: () => true });
    expect(r.texto).toContain('VENCIDO — el comercio ya no lo factura');
    expect(r.texto).toContain(`${numero(1)} comprobante sin factura por ${mxn(500)} en total.`);
  });

  it('con un ticket urgente a 1 día, usa el singular "1 día" y no "1 días"', async () => {
    getPorFacturar.mockResolvedValue([ticket({
      caducidad: { diasRestantes: 1, vencido: false, urgente: true, desconocido: false },
    })]);
    const r = await herramientaPorFacturar.ejecutar('t1', {}, { alcanza: () => true });
    expect(r.texto).toContain('vence en 1 día');
    expect(r.texto).not.toContain('vence en 1 días');
  });

  it('con dos tickets (uno normal, no listado; y varios urgentes), usa el plural "comprobantes"', async () => {
    getPorFacturar.mockResolvedValue([
      ticket({ gastoId: 'g1', monto: 100 }),
      ticket({ gastoId: 'g2', monto: 200, caducidad: { diasRestantes: 2, vencido: false, urgente: true, desconocido: false } }),
    ]);
    const r = await herramientaPorFacturar.ejecutar('t1', {}, { alcanza: () => true });
    expect(r.texto).toContain(`${numero(2)} comprobantes sin factura por ${mxn(300)} en total.`);
    expect(r.texto).toContain('vence en 2 días');
  });

  it('con más de 10 urgentes, solo lista los 10 más próximos a vencer (no los inventa ni trunca mal)', async () => {
    const tickets = Array.from({ length: 12 }, (_, i) => ticket({
      gastoId: `g${i}`, concepto: `ticket ${i}`,
      caducidad: { diasRestantes: 12 - i, vencido: false, urgente: true, desconocido: false },
    }));
    getPorFacturar.mockResolvedValue(tickets);
    const r = await herramientaPorFacturar.ejecutar('t1', {}, { alcanza: () => true });
    expect((r.estructurado?.urgentes as unknown[]).length).toBe(10);
    // El más próximo a vencer (g11, diasRestantes=1) tiene que quedar dentro
    // de los 10 — el `.sort()` por días restantes va ANTES del `.slice(10)`.
    expect(r.texto).toContain('ticket 11');
    expect(r.texto).not.toContain('ticket 0 de');
  });

  it('sin ningún ticket vencido o urgente, no imprime la sección "piden acción ya"', async () => {
    getPorFacturar.mockResolvedValue([ticket({
      caducidad: { diasRestantes: 20, vencido: false, urgente: false, desconocido: false },
    })]);
    const r = await herramientaPorFacturar.ejecutar('t1', {}, { alcanza: () => true });
    expect(r.texto).not.toContain('piden acción ya');
  });

  it('un ticket sin fecha no la inventa en la línea del reporte', async () => {
    getPorFacturar.mockResolvedValue([ticket({
      fecha: null, caducidad: { diasRestantes: 0, vencido: true, urgente: false, desconocido: false },
    })]);
    const r = await herramientaPorFacturar.ejecutar('t1', {}, { alcanza: () => true });
    const linea = r.texto.split('\n').find((l) => l.startsWith('• diesel'));
    expect(linea).not.toContain('(');
  });
});

// ── resumen_fiscal ─────────────────────────────────────────────────────────

function resumenFiscalBase() {
  return {
    n: 0, gastoTotal: 0, conCfdi: 0, sinCfdi: 0, ivaAcreditable: 0, ivaNoAcreditable: 0,
    conCfdiSinDesglose: 0, iepsDieselDocumentado: 0, subTotalCasetas: 0, casetasSinSubTotal: 0,
    porValidar: 0, vigentes: 0, cancelados: 0, combustible15SujetoADeriva: false,
  };
}
function perdidasBase() {
  return {
    montoTotal: 0, montoPerdido: 0, montoEnRiesgo: 0, montoRecuperable: 0,
    ivaPerdidoDocumentado: 0, sinDesgloseDeIva: 0, porCausa: [], filas: [],
    sinFormaPago: 0, sinFecha: 0,
  };
}

describe('herramientaResumenFiscal.ejecutar', () => {
  beforeEach(() => {
    resolverPeriodo.mockReturnValue({ clave: 'ejercicio', desde: null, hasta: null, etiqueta: 'el ejercicio 2026' });
    opcionesDe.mockReturnValue({});
    opcionesFiscalesDelPeriodo.mockResolvedValue({});
    getGastosFiscales.mockResolvedValue([]);
  });

  it('sin comprobantes en el periodo, dice que no hay nada fiscal que afirmar', async () => {
    resumirFiscal.mockReturnValue(resumenFiscalBase());
    resumirPerdidas.mockReturnValue(perdidasBase());
    const r = await herramientaResumenFiscal.ejecutar('t1', {}, { alcanza: () => true });
    expect(r.texto).toMatch(/No hay comprobantes leídos en el periodo «el ejercicio 2026»/);
  });

  it('con comprobantes con CFDI pero sin desglose, agrega la línea de aviso', async () => {
    resumirFiscal.mockReturnValue({ ...resumenFiscalBase(), n: 5, conCfdiSinDesglose: 2 });
    resumirPerdidas.mockReturnValue(perdidasBase());
    const r = await herramientaResumenFiscal.ejecutar('t1', {}, { alcanza: () => true });
    expect(r.texto).toContain('2 comprobantes con CFDI pero sin XML leído');
  });

  it('sin comprobantes sin desglose, NO agrega esa línea', async () => {
    resumirFiscal.mockReturnValue({ ...resumenFiscalBase(), n: 5, conCfdiSinDesglose: 0 });
    resumirPerdidas.mockReturnValue(perdidasBase());
    const r = await herramientaResumenFiscal.ejecutar('t1', {}, { alcanza: () => true });
    expect(r.texto).not.toContain('sin XML leído');
  });

  it('con pérdidas de deducibilidad, cita los tres montos (perdido/en riesgo/recuperable)', async () => {
    resumirFiscal.mockReturnValue({ ...resumenFiscalBase(), n: 3 });
    resumirPerdidas.mockReturnValue({
      ...perdidasBase(), montoTotal: 1000, montoPerdido: 400, montoEnRiesgo: 300, montoRecuperable: 300,
    });
    const r = await herramientaResumenFiscal.ejecutar('t1', {}, { alcanza: () => true });
    expect(r.texto).toContain(`perdido ${mxn(400)}, en riesgo ${mxn(300)}, recuperable pidiendo factura ${mxn(300)}`);
  });

  it('sin pérdidas, dice explícitamente que no se detectaron — no omite la línea', async () => {
    resumirFiscal.mockReturnValue({ ...resumenFiscalBase(), n: 3 });
    resumirPerdidas.mockReturnValue(perdidasBase());
    const r = await herramientaResumenFiscal.ejecutar('t1', {}, { alcanza: () => true });
    expect(r.texto).toContain('Sin pérdidas de deducibilidad detectadas en el periodo.');
  });

  it('RE-AUDITORÍA 25, FIS-REAUD-3: con IVA acreditable vía el 15% en vivo, avisa que puede no coincidir con una liquidación ya firmada', async () => {
    resumirFiscal.mockReturnValue({ ...resumenFiscalBase(), n: 3, ivaAcreditable: 500, combustible15SujetoADeriva: true });
    resumirPerdidas.mockReturnValue(perdidasBase());
    const r = await herramientaResumenFiscal.ejecutar('t1', {}, { alcanza: () => true });
    expect(r.texto).toContain('puede no coincidir con lo que ya firmó una liquidación vieja');
  });

  it('sin esa deriva, NO agrega el aviso del 15%', async () => {
    resumirFiscal.mockReturnValue({ ...resumenFiscalBase(), n: 3, ivaAcreditable: 500, combustible15SujetoADeriva: false });
    resumirPerdidas.mockReturnValue(perdidasBase());
    const r = await herramientaResumenFiscal.ejecutar('t1', {}, { alcanza: () => true });
    expect(r.texto).not.toContain('liquidación vieja');
  });

  it('pasa el `periodo` pedido a resolverPeriodo, y el resultado llega a getGastosFiscales', async () => {
    resumirFiscal.mockReturnValue(resumenFiscalBase());
    resumirPerdidas.mockReturnValue(perdidasBase());
    await herramientaResumenFiscal.ejecutar('t1', { periodo: 'mes_anterior' }, { alcanza: () => true });
    expect(resolverPeriodo).toHaveBeenCalledWith('mes_anterior', expect.any(String));
    expect(getGastosFiscales).toHaveBeenCalledWith('t1', expect.objectContaining({ etiqueta: 'el ejercicio 2026' }), expect.any(String), {});
  });
});

// ── metricas_flota ─────────────────────────────────────────────────────────

function kpisBase() {
  return { viajesLiquidados: 0, montoComprobado: 0, diferenciaDetectada: 0, conDiferencias: 0, porRevisar: 0, tasaCuadre: 0 };
}

describe('herramientaMetricasFlota.ejecutar', () => {
  it('sin liquidaciones, dice que no hay métricas que afirmar — con el rótulo de la ventana pedida', async () => {
    getKpis.mockResolvedValue(kpisBase());
    const r = await herramientaMetricasFlota.ejecutar('t1', { ventana_dias: 7 }, { alcanza: () => true });
    expect(r.texto).toBe('Sin liquidaciones en últimos 7 días. No hay métricas que afirmar sobre cero liquidaciones.');
  });

  it('sin ventana_dias, el rótulo es "todo el histórico"', async () => {
    getKpis.mockResolvedValue(kpisBase());
    const r = await herramientaMetricasFlota.ejecutar('t1', {}, { alcanza: () => true });
    expect(r.texto).toContain('Sin liquidaciones en todo el histórico.');
    expect(getKpis).toHaveBeenCalledWith('t1', undefined);
  });

  it('camino feliz: cita las cinco cifras con sus formatos reales (MXN, número, porcentaje)', async () => {
    getKpis.mockResolvedValue({
      viajesLiquidados: 42, montoComprobado: 385000, diferenciaDetectada: 1250,
      conDiferencias: 3, porRevisar: 2, tasaCuadre: 92.857,
    });
    const r = await herramientaMetricasFlota.ejecutar('t1', { ventana_dias: 30 }, { alcanza: () => true });
    expect(r.texto).toContain(`Viajes liquidados: ${numero(42)}.`);
    expect(r.texto).toContain(`Monto comprobado: ${mxn(385000)}.`);
    expect(r.texto).toContain(`Diferencias detectadas por el motor: ${mxn(1250)} en ${numero(3)} liquidaciones.`);
    expect(r.texto).toContain(`Por revisar: ${numero(2)}.`);
    expect(r.texto).toContain(`Tasa de cuadre limpio: ${porcentaje(92.857)}.`);
    expect(r.estructurado).toEqual({ ventana: 'últimos 30 días', kpis: expect.any(Object) });
  });
});
