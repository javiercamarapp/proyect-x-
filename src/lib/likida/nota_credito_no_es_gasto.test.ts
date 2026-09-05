import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 25, ALTO FISCAL (fiscal.md línea 218) — UNA NOTA DE CRÉDITO
// (TipoDeComprobante="E") ENTRABA COMO GASTO DEDUCIBLE Y ACREDITABA SU IVA.
//
// Nada en el camino del dinero miraba `tipoComprobante`: el intake 1:1 solo
// distinguía el REP ('P'); cualquier otro tipo — incluida una nota de crédito
// de egreso — se trataba como un comprobante normal de ingreso. Un CFDI de
// egreso documenta una DEVOLUCIÓN o BONIFICACIÓN: resta una deducción y
// restituye IVA ya acreditado (LIVA art. 7); no ampara una erogación nueva
// (LIVA art. 5 fr. I).
//
// Dos caminos, los dos probados aquí:
//   · sin ticket previo → `addGasto` creaba un gasto nuevo desde el XML.
//   · con ticket previo del mismo total → `emparejarXmlConTicket` lo casaba
//     y `updateGastoCfdiXml` lo marcaba `xml_verificado: true`.
// Los dos tienen que quedar bloqueados.
// ═══════════════════════════════════════════════════════════════════════════

const addGasto = vi.fn();
const updateGastoCfdiXml = vi.fn();
const saveCfdiXmlRaw = vi.fn();
const parseCfdiXml = vi.fn();
const intakeDelta = vi.fn();
const resolveOperador = vi.fn(async (): Promise<{ tenantId: string; operadorId: string } | null> => ({ tenantId: 't1', operadorId: 'o1' }));
const getOpenViaje = vi.fn(async (): Promise<string | null> => 'v1');
const resolverCuentaOficina = vi.fn(async (): Promise<Record<string, unknown> | null> => null);
const guardarConsolidado = vi.fn(async () => ({ cfdiXmlId: 'xml', totalLineas: 3, conciliadas: 3, porConciliar: 0 }));
const getGastos = vi.fn(async (..._a: unknown[]) => [] as unknown[]);

vi.mock('@/lib/agents/run', () => ({ runAgent: vi.fn() }));
vi.mock('@/lib/likida/intake/cfdi_xml', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  parseCfdiXml: (...a: unknown[]) => parseCfdiXml(...a),
}));
vi.mock('./contactos', async (original) => ({ ...(await original<Record<string, unknown>>()), resolverCuentaOficina: (...a: []) => resolverCuentaOficina(...a) }));
vi.mock('./intake/consolidado', async (original) => ({ ...(await original<Record<string, unknown>>()), guardarYConciliarConsolidado: (...a: []) => guardarConsolidado(...a) }));
vi.mock('@/lib/likida/conv', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveOperador: (...a: []) => resolveOperador(...a),
  getOpenViaje: (...a: []) => getOpenViaje(...a),
  getTenantContext: vi.fn(async () => ({ nombre: 'Flota' })),
  loadConversation: vi.fn(async () => ({ id: 'c1', turns: [] })),
  saveConversation: vi.fn(),
  claimMessage: vi.fn(async () => 'nuevo' as const),
  acquireViajeLock: vi.fn(async () => true), intentarLockViaje: vi.fn(async () => 'obtenido' as const), releaseViajeLock: vi.fn(),
  releaseMessageClaim: vi.fn(), completarMessageClaim: vi.fn(),
  intakeDelta: (...a: unknown[]) => intakeDelta(...a), esperarIntake: vi.fn(async () => true),
}));
vi.mock('@/lib/likida/repo', () => ({
  ubicarGastoPorHash: vi.fn(async () => null),
  getHuerfanos: vi.fn(async () => []), guardarHuerfano: vi.fn(async () => true),
  resolverHuerfanos: vi.fn(), marcarHuerfanosOfrecidos: vi.fn(),
  addGasto: (...a: unknown[]) => addGasto(...a),
  getGastos: (...a: unknown[]) => getGastos(...a), updateGastoCfdiXml: (...a: unknown[]) => updateGastoCfdiXml(...a),
  saveCfdiXmlRaw: (...a: unknown[]) => saveCfdiXmlRaw(...a),
  gastoExistePorHash: vi.fn(async () => false), gastoPorHash: vi.fn(async () => null),
  enriquecerGastoConCodigo: vi.fn(), guardarCodigoPendiente: vi.fn(),
  getCodigosPendientes: vi.fn(async () => []), reclamarCodigoPendiente: vi.fn(),
  getDatosResponsable: vi.fn(async () => ({
    razonSocial: 'FLOTA SA DE CV', domicilio: 'Calle 1, Mérida', urlAvisoIntegral: 'https://flota.mx/p',
  })),
  reclamarEnvioAviso: vi.fn(async () => false), liberarEnvioAviso: vi.fn(),
  getViaje: vi.fn(async () => ({ id: 'v1', anticipo: 0 })),
  getOperador: vi.fn(async () => ({ id: 'o1', nombre: 'Operador', telefono: '5219993700779' })),
  saveLiquidacion: vi.fn(async () => 'L1'),
  getAcumuladoCombustible: vi.fn(async () => { throw new Error('sin base en pruebas'); }),
}));
vi.mock('@/lib/likida/config', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getConfig: vi.fn(async () => ({
    hidrocarburos: { claves: ['15101514'] },
    estimulos: { clavesPeaje: ['78111808'], peajeFactor: 0.5 },
  })),
}));
vi.mock('@/lib/likida/costos', () => ({
  registrarCosto: vi.fn(), registrarCostoWhatsApp: vi.fn(),
  faseDeModelo: vi.fn(() => 'cuadre'), vincularCostosALiquidacion: vi.fn(),
}));
const downloadMediaAsText = vi.fn(async () => '<cfdi:Comprobante/>');
const metadatosMedia = vi.fn(async () => ({ mimeType: 'text/xml', fileSize: 2048 } as { mimeType: string; fileSize: number | null } | null));
vi.mock('@/lib/meta/client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  downloadMediaAsText: (...a: unknown[]) => downloadMediaAsText(...(a as [])),
  metadatosMedia: (...a: unknown[]) => metadatosMedia(...(a as [])),
}));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  }),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { processInbound } = await import('./processor');

const salientes: string[] = [];
const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  salientes.push(String((body.text as { body?: string } | undefined)?.body ?? ''));
  return new Response(JSON.stringify({ messages: [{ id: 'wamid.TEST' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
});

const xmlMsg = { from: '5219993700779', type: 'document' as const, mediaId: 'doc1', waMessageId: 'wa-xml-1' };

/** La nota de crédito del escenario del hallazgo: SubTotal $10,000, IVA
 *  $1,600, Total $11,600, TipoDeComprobante="E". */
function notaCredito() {
  return {
    uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    fecha: '2026-08-01T10:00:00',
    total: 11600,
    subTotal: 10000,
    rfcEmisor: 'AAA010101AAA',
    rfcReceptor: 'BBB020202BB1',
    iepsTraslado: 0, ivaTraslado: 1600,
    conceptos: [], lineas: [],
    claveProdServ: '15101505', claveUnidad: 'LTR', cantidad: 100,
    tipoComprobante: 'E', formaPago: '03',
    complementoHidrocarburos: false, esquemaAlterno: false,
  };
}

beforeEach(() => {
  salientes.length = 0;
  resolveOperador.mockResolvedValue({ tenantId: 't1', operadorId: 'o1' });
  getOpenViaje.mockResolvedValue('v1');
  resolverCuentaOficina.mockResolvedValue(null);
  guardarConsolidado.mockClear();
  addGasto.mockReset(); addGasto.mockResolvedValue(undefined);
  updateGastoCfdiXml.mockReset(); updateGastoCfdiXml.mockResolvedValue(undefined);
  saveCfdiXmlRaw.mockReset(); saveCfdiXmlRaw.mockResolvedValue(true);
  parseCfdiXml.mockReset();
  getGastos.mockReset(); getGastos.mockResolvedValue([]);
  intakeDelta.mockReset(); intakeDelta.mockResolvedValue(1);
  vi.stubGlobal('fetch', fetchSpy);
  fetchSpy.mockClear();
  process.env.WHATSAPP_ACCESS_TOKEN = 'tok-de-prueba';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
});

describe('una nota de crédito (TipoDeComprobante=E) no es un gasto deducible', () => {
  it('sin ticket previo: NO se da de alta un gasto nuevo', async () => {
    parseCfdiXml.mockReturnValue(notaCredito());
    await processInbound(xmlMsg);
    expect(addGasto, 'una nota de crédito no documenta una erogación').not.toHaveBeenCalled();
  });

  it('con un ticket previo del MISMO total: no lo casa ni lo marca xml_verificado', async () => {
    getGastos.mockResolvedValue([
      { id: 'g1', viajeId: 'v1', concepto: 'diesel', monto: 11600, fecha: '2026-08-01', cfdiUuid: undefined },
    ]);
    parseCfdiXml.mockReturnValue(notaCredito());
    await processInbound(xmlMsg);
    expect(updateGastoCfdiXml, 'el ticket no debe quedar marcado como verificado por una E').not.toHaveBeenCalled();
    expect(addGasto).not.toHaveBeenCalled();
  });

  it('el XML SÍ se conserva (CFF 30) sin ligarlo a ningún gasto', async () => {
    parseCfdiXml.mockReturnValue(notaCredito());
    await processInbound(xmlMsg);
    expect(saveCfdiXmlRaw).toHaveBeenCalledWith('t1', notaCredito().uuid, null, expect.any(String));
  });

  it('se le dice al operador que es una nota de crédito, no un gasto', async () => {
    parseCfdiXml.mockReturnValue(notaCredito());
    await processInbound(xmlMsg);
    expect(salientes).toHaveLength(1);
    expect(salientes[0]).toMatch(/nota de crédito/i);
  });

  it('CONTROL — un CFDI de INGRESO (tipoComprobante I) con el mismo total sigue entrando normal', async () => {
    parseCfdiXml.mockReturnValue({ ...notaCredito(), tipoComprobante: 'I' });
    await processInbound(xmlMsg);
    expect(addGasto).toHaveBeenCalledTimes(1);
  });
});


describe('nota de crédito multiconcepto: las tres puertas conservan sin conciliar', () => {
  function puerta(nombre: string) {
    if (nombre === 'oficina') {
      resolveOperador.mockResolvedValue(null);
      resolverCuentaOficina.mockResolvedValue({ tenantId: 't1', userId: 'of-1', rol: 'flota_admin', nombre: 'Oficina', email: 'sintetico@example.invalid' });
    }
    if (nombre === 'sin viaje') getOpenViaje.mockResolvedValue(null);
    parseCfdiXml.mockReturnValue({ ...notaCredito(), lineas: [1,2,3].map((indice) => ({ indice, monto: 8000, cantidad: 320, fuente: 'ecc12' })) });
  }
  it.each(['oficina', 'sin viaje', 'con viaje'])('%s: el consolidado de ingreso conserva su camino de conciliación', async (p) => {
    puerta(p);
    parseCfdiXml.mockReturnValue({ ...notaCredito(), tipoComprobante: 'I', lineas: [1,2,3].map((indice) => ({ indice, monto: 8000, cantidad: 320, fuente: 'ecc12' })) });
    await processInbound(xmlMsg);
    expect(guardarConsolidado).toHaveBeenCalledTimes(1);
    expect(saveCfdiXmlRaw).not.toHaveBeenCalled();
    expect(salientes).toHaveLength(1);
  });
  it.each(['oficina', 'sin viaje', 'con viaje'])('%s: conserva XML y acusa nota de crédito sin gasto/IVA/litros conciliados', async (p) => {
    puerta(p);
    await processInbound(xmlMsg);
    expect(guardarConsolidado).not.toHaveBeenCalled();
    expect(addGasto).not.toHaveBeenCalled();
    expect(updateGastoCfdiXml).not.toHaveBeenCalled();
    expect(saveCfdiXmlRaw).toHaveBeenCalledExactlyOnceWith('t1', notaCredito().uuid, null, '<cfdi:Comprobante/>');
    expect(salientes).toHaveLength(1);
    expect(salientes[0]).toMatch(/nota de crédito/i);
    expect(salientes[0]).toMatch(/guard[eé].*archivo/i);
    expect(salientes[0]).not.toMatch(/conciliad[oa]|aplica desde el panel/i);
  });
  it.each(['oficina', 'sin viaje', 'con viaje'])('%s: una excepción al persistir también produce acuse honesto', async (p) => {
    puerta(p);
    saveCfdiXmlRaw.mockRejectedValueOnce(new Error('timeout sintético'));
    await processInbound(xmlMsg);
    expect(guardarConsolidado).not.toHaveBeenCalled();
    expect(salientes).toHaveLength(1);
    expect(salientes[0]).toMatch(/no pude guardar/i);
  });
  it.each(['oficina', 'sin viaje', 'con viaje'])('%s: si no persiste no promete guardar ni conciliar', async (p) => {
    puerta(p);
    saveCfdiXmlRaw.mockResolvedValue(false);
    await processInbound(xmlMsg);
    expect(guardarConsolidado).not.toHaveBeenCalled();
    expect(addGasto).not.toHaveBeenCalled();
    expect(updateGastoCfdiXml).not.toHaveBeenCalled();
    expect(salientes).toHaveLength(1);
    expect(salientes[0]).toMatch(/no pude guardar/i);
    expect(salientes[0]).not.toMatch(/guard[eé] el archivo|quedó guardado/i);
  });
});
