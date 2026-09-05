import { describe, it, expect, vi, beforeEach } from 'vitest';
import filasSql342 from './fixtures/poliza342_rpc.json';
import { parseCfdiXml } from '@/lib/likida/intake/cfdi_xml';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 22 · PRU-C1 (CRÍTICO) — la ruta que exporta el asiento contable no
// tenía UNA sola prueba que ejecutara su salida.
//
// Su único archivo (`rol_dinero.test.ts`) tiene cuatro casos y los cuatro son
// de ROL: se cortan ANTES de leer el catálogo a propósito. Así que los dos
// frenos de dinero de la ruta —el de base gravable desconocida
// (`route.ts:182`) y el 409 de pólizas incompletas (`:204`)— se podían BORRAR
// con la suite entera en verde.
//
// Y no es teórico: es la MISMA ruta que carga el crítico fiscal FIS-C1, y
// explica cómo el arreglo `010a7f5` pudo convertir un bloqueo en una
// exportación sin que nadie se enterara. Ahí no había red.
//
// Lo que esta suite fija:
//   1. Una base gravable desconocida BLOQUEA, y el mensaje dice cuál concepto.
//   2. Un catálogo incompleto BLOQUEA con 409 y nombra qué cuenta falta.
//   3. El archivo feliz SALE, y lleva las cuentas declaradas — no unas
//      plausibles.
//   4. FIS-C1: un gasto NO DEDUCIBLE no se asienta en la cuenta de gasto
//      deducible. Es la regresión que costó el crítico.
// ═══════════════════════════════════════════════════════════════════════════

const resolverTenantApi = vi.fn(async () => ({
  ok: true as const, tenantId: 'tenant-1', rol: 'contador' as string,
}));
vi.mock('@/lib/auth/tenant-api', () => ({
  resolverTenantApi: (...a: unknown[]) => resolverTenantApi(...(a as [])),
}));
vi.mock('@/lib/ratelimit', () => ({ rateLimit: async () => true, clientIp: () => '203.0.113.7' }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const CATALOGO_COMPLETO = {
  gastos: { diesel: '5010-001', hospedaje: '5010-004', alimentacion: '5020-001', flete: '5030-001' },
  ivaAcreditable: '1180-001',
  ivaNoAcreditable: '1180-002',
  gastoNoDeducible: '5990-001',
  gastoPorConfirmar: '5990-002',
  retencionesPorPagar: '2015-001',
  anticipoOperador: '1190-001',
  porCobrarOperador: '1190-002',
  porPagarOperador: '2010-001',
};

let catalogo: unknown = { ok: true, catalogo: CATALOGO_COMPLETO };
vi.mock('@/lib/likida/contabilidad/catalogo', async (orig) => ({
  ...(await orig<typeof import('@/lib/likida/contabilidad/catalogo')>()),
  catalogoDeclarado: async () => catalogo,
}));
// Un perfil CONTPAQi CONFIRMADO: sin él la ruta contesta 409
// `perfil_erp_sin_confirmar` y nunca llega a armar el archivo — que es
// justamente lo que esta suite viene a ejercitar.
const PERFIL_CONTPAQI = {
  sistema: 'contpaqi' as const,
  confirmadoEn: '2026-08-01T00:00:00.000Z',
  opciones: { tipo: 'Dr', numero: 1, separador: ',', encabezado: undefined },
};
// AUDITORÍA 24, PRU-A1: la rama `sap_b1` de la ruta (route.ts:405-424) nunca
// se pedía en una prueba — cobertura 81.72% con esas líneas SIN ejecutar—, así
// que intercambiar los dos archivos del DTW pasaba la suite entera en verde.
// El perfil se vuelve mutable para poder pedirla.
const PERFIL_SAP = {
  sistema: 'sap_b1' as const,
  confirmadoEn: '2026-08-01T00:00:00.000Z',
  plantilla: {
    cabeceraTecnica: ['JdtNum', 'RefDate', 'DueDate', 'TaxDate', 'Memo'],
    cabeceraVisible: ['Número', 'Fecha', 'Vencimiento', 'Fecha fiscal', 'Concepto'],
    lineasTecnica: ['JdtNum', 'Line_ID', 'Account', 'Debit', 'Credit', 'LineMemo', 'Ref1'],
    lineasVisible: ['Número', 'Renglón', 'Cuenta', 'Cargo', 'Abono', 'Concepto', 'Referencia'],
  },
};
let perfil: unknown = PERFIL_CONTPAQI;
vi.mock('@/lib/likida/contabilidad/perfiles', () => ({
  perfilExportacionDeclarado: async () => perfil,
}));

/** Lo que la RPC `poliza_datos_tenant` devuelve. */
let filas: unknown[] = [];
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ rpc: async () => ({ data: filas, error: null }) }),
}));
vi.mock('@/lib/likida/presupuesto', () => ({ acotada: async (p: unknown) => p }));

const { GET } = await import('./route');

const URL_POLIZA = 'https://app.likida.ai/api/export/poliza?desde=2026-08-01&hasta=2026-08-24&formato=contpaqi';
const pedir = () => GET(new Request(URL_POLIZA));

/** Una liquidación sana: diésel deducible 3,000 + IVA 480, devuelve 1,520. */
const SANA = {
  liquidacionId: 'l-1', folioViaje: 'VJ-1', operador: 'Juan', fecha: '2026-08-20',
  anticipo: 5000, comprobado: 3480, diferencia: 1520, ivaAcreditable: 480,
  porConcepto: [{ concepto: 'diesel', subtotal: 3000, baseConocida: true }],
  baseDesconocida: 0,
  // Forma de la RPC 0281 (auditoría 24): `version` y los insumos por comprobante.
  version: 342, revision: 'aprobada',
  gastos: [{ id: 'g1', concepto: 'diesel', monto: 3480, subtotal: 3000, descuento: null, tieneCfdi: true, cfdiUuid: 'u-g1', formaPago: '03' }],
  diferencias: [],
  retenciones: 0,
};

beforeEach(() => {
  catalogo = { ok: true, catalogo: CATALOGO_COMPLETO };
  perfil = PERFIL_CONTPAQI;
  filas = [SANA];
  resolverTenantApi.mockResolvedValue({ ok: true as const, tenantId: 'tenant-1', rol: 'contador' });
});

describe('póliza y revisión humana: no inventar impuestos ni asentar sin firma', () => {
  it('un periodo mixto no entrega un archivo parcial ni acredita una pendiente', async () => {
    filas = [
      { ...SANA, version: 342, revision: 'aprobada' },
      { ...SANA, version: 342, liquidacionId: 'pendiente', folioViaje: 'SIN-FIRMA', revision: 'pendiente' },
    ];
    const r = await pedir();
    expect(r.status).toBe(409);
    const contenido = await r.text();
    expect(contenido).toContain('SIN-FIRMA');
    expect(contenido).toMatch(/firma|revis/i);
    expect(r.headers.get('content-disposition')).toBeNull();
  });

  it.each([5480, 1480])('nombra el ajuste incompatible a %s sin inventar un impuesto ni llamarlo dato roto', async (monto) => {
    filas = [{
      ...SANA, version: 342, revision: 'ajustada',
      comprobado: monto, diferencia: SANA.anticipo - monto,
      gastos: [{ ...SANA.gastos[0], monto, ivaTraslado: 480, iepsTraslado: 0 }],
    }];
    const r = await pedir();
    expect(r.status).toBe(409);
    const contenido = await r.text();
    expect(contenido).toMatch(/ajuste/i);
    expect(contenido).toContain('g1');
    expect(contenido).not.toContain('es menor que la base');
  });

  it.each([2000, 4000])('permite corregir un monto anterior de %s al desglose real 3000 + 480', async (montoAnterior) => {
    filas = [{
      ...SANA, revision: 'ajustada',
      ajustes: [{ gasto_id: 'g1', monto_anterior: montoAnterior, monto_nuevo: 3480 }],
      gastos: [{ ...SANA.gastos[0], ivaTraslado: 480, iepsTraslado: 0 }],
    }];
    const r = await pedir();
    expect(r.status).toBe(200);
    const contenido = await r.text();
    expect(contenido).toContain('1180-001');
    expect(contenido).not.toContain('1180-002');
  });

  it('el preflight tampoco llama listo a un periodo sin firma', async () => {
    filas = [{ ...SANA, revision: 'pendiente' }];
    const r = await GET(new Request(`${URL_POLIZA}&preflight=1`));
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('liquidaciones_sin_firma');
  });

  it('una RPC sin revisión no se interpreta como aprobada', async () => {
    filas = [{ ...SANA, revision: undefined }];
    const r = await pedir();
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('rpc_desactualizada');
  });

  it('no reconstruye impuestos ausentes de una liquidación ajustada', async () => {
    filas = [{ ...SANA, revision: 'ajustada' }];
    const r = await pedir();
    expect(r.status).toBe(409);
    expect(await r.text()).toContain('desglose fiscal completo');
  });
});

describe('PRU-C1: el export de póliza, ejecutado de verdad', () => {
  it('el camino feliz SALE, con las cuentas que la flota declaró', async () => {
    const r = await pedir();
    expect(r.status).toBe(200);
    const txt = await r.text();
    expect(txt).toContain('5010-001');   // la cuenta de diésel declarada
    expect(txt).toContain('1190-001');   // el anticipo que se cancela
  });

  // El freno de `route.ts:182`. Sin esta prueba se podía borrar entero.
  it('una base gravable DESCONOCIDA bloquea, y dice de qué concepto', async () => {
    filas = [{ ...SANA, porConcepto: [{ concepto: 'diesel', subtotal: null, baseConocida: false }] }];
    const r = await pedir();
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error).toBe('polizas_incompletas');
    expect(JSON.stringify(j.bloqueos)).toContain('diesel');
    expect(JSON.stringify(j.bloqueos)).toMatch(/base gravable/i);
  });

  // El 409 de `route.ts:204`. El otro freno que nadie ejercitaba.
  it('sin la cuenta declarada NO se inventa una: 409 nombrando qué falta', async () => {
    catalogo = { ok: true, catalogo: { ...CATALOGO_COMPLETO, gastos: {} } };
    const r = await pedir();
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(JSON.stringify(j.bloqueos)).toContain('diesel');
  });

  it('un solo folio bloqueado tira el archivo completo — a propósito', async () => {
    filas = [SANA, { ...SANA, folioViaje: 'VJ-2', porConcepto: [{ concepto: 'diesel', subtotal: null, baseConocida: false }] }];
    const r = await pedir();
    // Media póliza importada es peor que ninguna: el contador cuadra a medias
    // y lo que falta no aparece por ningún lado.
    expect(r.status).toBe(409);
  });

  // ── FIS-C1, la regresión que costó el crítico ───────────────────────────
  it('un gasto NO DEDUCIBLE no se asienta en la cuenta de gasto deducible', async () => {
    filas = [{
      ...SANA,
      folioViaje: 'VJ-ND',
      anticipo: 10_000, comprobado: 8000, diferencia: 2000, ivaAcreditable: 0,
      porConcepto: [{ concepto: 'hospedaje', subtotal: 8000, baseConocida: true }],
      gastos: [{ id: 'g9', concepto: 'hospedaje', monto: 8000, subtotal: 8000, descuento: null, tieneCfdi: true, cfdiUuid: 'u-g9', formaPago: '01' }],
      diferencias: [{ tipo: 'efectivo_sobre_tope', gastoId: 'g9', concepto: 'hospedaje', monto: 0 }],
    }];
    const r = await pedir();
    expect(r.status).toBe(200);
    const txt = await r.text();
    // Lo que rompía: 5010-004 (hospedaje DEDUCIBLE) cargaba los $8,000.
    expect(txt).not.toContain('5010-004');
    expect(txt).toContain('5990-001');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24 · FIS-2 / FIS-3 (CRÍTICOS, reincidentes) + FIS-4 (fallar cerrado)
// — lo que la ruta hace con la RPC 0281, ejecutado de verdad.
// ═══════════════════════════════════════════════════════════════════════════
const cargosDe = (txt: string) => {
  // CONTPAQi (`filasContpaqi`): …,cuenta,0|1,importe,… — 0 = cargo, 1 = abono.
  const out: Record<string, number> = {};
  for (const fila of txt.split('\n')) {
    const m = /,(\d{4}-\d{3}),(0|1),([0-9]+\.[0-9]{2}),/.exec(fila);
    if (m && m[2] === '0') out[m[1]] = (out[m[1]] ?? 0) + Number(m[3]);
  }
  return out;
};

describe('FIS-4: sin la RPC correcta NO hay póliza — se dice qué migración falta', () => {
  it('la RPC anterior a la 0272 (sin `gastos`) contesta 409 rpc_desactualizada, nunca un archivo', async () => {
    const { gastos: _g, version: _v, ...vieja } = SANA;
    void _g; void _v;
    filas = [vieja];
    const r = await pedir();
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error).toBe('rpc_desactualizada');
    expect(j.migracionEsperada).toContain('0342');
  });

  it('la RPC 0272 (con `gastos` pero sin `version`) también: sin monto ni forma de pago no se clasifica', async () => {
    const { version: _v, ...v0272 } = SANA;
    void _v;
    filas = [{ ...v0272, gastos: [{ id: 'g1', concepto: 'diesel', subtotal: 3000, descuento: null, tieneCfdi: true }] }];
    const r = await pedir();
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('rpc_desactualizada');
  });
});

describe('FIS-2: lo parcialmente deducible se asienta EN PROPORCIÓN, como el PDF', () => {
  it('comida de $2,000 con tope de $750: 5020-001 cargo 646.55 y 5990-001 cargo 1,077.59', async () => {
    // Motor: proporción 0.375 (750/2,000); IVA acreditable 275.86 × 0.375 = 103.45.
    filas = [{
      ...SANA, folioViaje: 'VJ-COMIDA',
      anticipo: 5000, comprobado: 2000, diferencia: 3000, ivaAcreditable: 103.45,
      porConcepto: [{ concepto: 'alimentacion', subtotal: 1724.14, baseConocida: true }],
      gastos: [{ id: 'c1', concepto: 'alimentacion', monto: 2000, fecha: '2026-08-10', subtotal: 1724.14, descuento: null, tieneCfdi: true, cfdiUuid: 'u-c1', formaPago: '04' }],
      diferencias: [{ tipo: 'viatico_excede_fiscal', gastoId: 'c1', concepto: 'alimentacion', esperado: 750, real: 2000, monto: 1250, nota: '' }],
    }];
    const r = await pedir();
    expect(r.status).toBe(200);
    const c = cargosDe(await r.text());
    expect(c['5020-001']).toBeCloseTo(646.55, 2);   // lo que rompía: 1,724.14 entero
    expect(c['5990-001']).toBeCloseTo(1077.59, 2);
    expect(c['1180-001']).toBeCloseTo(103.45, 2);
  });

  it('diésel en efectivo con la mitad dentro del 15%: mitad y mitad', async () => {
    filas = [{
      ...SANA, folioViaje: 'VJ-15',
      anticipo: 5000, comprobado: 3480, diferencia: 1520, ivaAcreditable: 240,
      gastos: [{ id: 'd1', concepto: 'diesel', monto: 3480, subtotal: 3000, descuento: null, tieneCfdi: true, cfdiUuid: 'u-d1', formaPago: '01' }],
      diferencias: [{ tipo: 'efectivo_sobre_15', gastoId: 'd1', concepto: 'diesel', esperado: 1740, monto: 1740, nota: '' }],
    }];
    const r = await pedir();
    expect(r.status).toBe(200);
    const c = cargosDe(await r.text());
    expect(c['5010-001']).toBeCloseTo(1500, 2);
    expect(c['5990-001']).toBeCloseTo(1500, 2);
  });
});

describe('FIS-3: una deducción por comprobante, no por fotografía', () => {
  it('dos fotos del mismo UUID de $8,000 → UN solo cargo de 6,896.55', async () => {
    const foto = { concepto: 'flete' as const, monto: 8000, subtotal: 6896.55, descuento: null, tieneCfdi: true, cfdiUuid: 'U-FLETE', formaPago: '03' };
    filas = [{
      ...SANA, folioViaje: 'VJ-DUP',
      anticipo: 10_000, comprobado: 8000, diferencia: 2000, ivaAcreditable: 1103.45,
      porConcepto: [{ concepto: 'flete', subtotal: 13793.10, baseConocida: true }],
      gastos: [{ id: 'f1', ...foto }, { id: 'f2', ...foto, cfdiUuid: 'u-flete' }],
      diferencias: [{ tipo: 'duplicado', gastoId: 'f1', concepto: 'flete', monto: 8000, nota: '' }],
    }];
    const r = await pedir();
    expect(r.status).toBe(200);
    const c = cargosDe(await r.text());
    expect(c['5030-001']).toBeCloseTo(6896.55, 2);  // lo que rompía: 13,793.10
  });

  it('el duplicado y el IVA no acreditado del mismo importe NO se compensan en silencio', async () => {
    // Antes: la copia inflaba la base y el residuo negativo la "absorbía".
    // Ahora la copia no entra, y el IVA no acreditado sale con su renglón.
    const foto = { concepto: 'flete' as const, monto: 1160, subtotal: 1000, descuento: null, tieneCfdi: true, cfdiUuid: 'u-x', formaPago: '03' };
    filas = [{
      ...SANA, folioViaje: 'VJ-COMP',
      anticipo: 5000, comprobado: 1160, diferencia: 3840, ivaAcreditable: 0,
      porConcepto: [{ concepto: 'flete', subtotal: 2000, baseConocida: true }],
      gastos: [{ id: 'f1', ...foto }, { id: 'f2', ...foto }],
      diferencias: [],
    }];
    const r = await pedir();
    expect(r.status).toBe(200);
    const c = cargosDe(await r.text());
    expect(c['5030-001']).toBeCloseTo(1000, 2);
    expect(c['1180-002']).toBeCloseTo(160, 2);   // el IVA no acreditado, con nombre
  });

  it('las retenciones se suman SIN copias, no del crudo de la RPC', async () => {
    const foto = { concepto: 'flete' as const, monto: 11_200, subtotal: 10_000, descuento: null, tieneCfdi: true, cfdiUuid: 'u-r', formaPago: '03', ivaRetenido: 400, isrRetenido: 0 };
    filas = [{
      ...SANA, folioViaje: 'VJ-RET',
      anticipo: 20_000, comprobado: 11_200, diferencia: 8800, ivaAcreditable: 1600,
      porConcepto: [{ concepto: 'flete', subtotal: 20_000, baseConocida: true }],
      gastos: [{ id: 'f1', ...foto }, { id: 'f2', ...foto }],
      diferencias: [],
      retenciones: 800, // el crudo, con la copia: si la ruta lo leyera, descuadra
    }];
    const r = await pedir();
    expect(r.status).toBe(200);
    const txt = await r.text();
    expect(txt).toContain('2015-001');
    expect(cargosDe(txt)['5030-001']).toBeCloseTo(10_000, 2);
  });

  it('FIS-6: un CFDI a crédito sin complemento de pago va a la cuenta POR CONFIRMAR', async () => {
    filas = [{
      ...SANA, folioViaje: 'VJ-99',
      anticipo: 5000, comprobado: 3480, diferencia: 1520, ivaAcreditable: 0,
      gastos: [{ id: 'g1', concepto: 'diesel', monto: 3480, subtotal: 3000, descuento: null, tieneCfdi: true, cfdiUuid: 'u-g1', formaPago: '99', pagadoEn: null }],
      diferencias: [],
    }];
    const r = await pedir();
    expect(r.status).toBe(200);
    const c = cargosDe(await r.text());
    expect(c['5010-001']).toBeUndefined();
    expect(c['5990-002']).toBeCloseTo(3000, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24 · PRU-A1 + PRU-A2 (ALTOS, reincidentes 23) — el arnés del
// export contable: el formato que el contador de Innovativos importa a SAP.
//
// Las dos mutaciones de la 23 siguen VIVAS y se re-corrieron hoy:
//   · M16 (`route.ts:315-316`): intercambiar `oJournalEntries.txt` con
//     `JournalEntries_Lines.txt`. Suite completa VERDE — la rama `sap_b1`
//     nunca se pedía (cobertura 81.72%, esas líneas sin ejecutar).
//   · M14 (`formatos.ts:167`): `Line_ID` fijo en 0 en todos los renglones.
//     Suite completa VERDE con `formatos.ts` al 100.00% de LÍNEAS — la
//     cobertura mide que la línea corrió, no que alguien mirara su salida.
//     El DTW rechaza (o peor, colapsa) un asiento con `Line_ID` repetido
//     dentro del mismo `JdtNum`.
//
// Se descubre DENTRO del ERP del cliente, que es el peor sitio posible.
// ═══════════════════════════════════════════════════════════════════════════
const URL_SAP = 'https://app.likida.ai/api/export/poliza?desde=2026-08-01&hasta=2026-08-24&formato=sap_b1';
const pedirSap = () => GET(new Request(URL_SAP));

/** Los renglones de datos de un archivo DTW: sin las dos filas de encabezado. */
const renglones = (archivo: string) =>
  archivo.split('\n').slice(2).filter((l) => l.trim() !== '').map((l) => l.split('\t'));

describe('PRU-A1: los DOS archivos del DTW de SAP, cada uno con su encabezado', () => {
  beforeEach(() => { perfil = PERFIL_SAP; });

  it('oJournalEntries lleva la CABECERA y JournalEntries_Lines los RENGLONES', async () => {
    const r = await pedirSap();
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.formato).toBe('sap_b1_dtw');

    const cab = j.archivos['oJournalEntries.txt'] as string;
    const lin = j.archivos['JournalEntries_Lines.txt'] as string;

    // La aserción que mata M16: cada archivo empieza por SU encabezado técnico.
    expect(cab.split('\n')[0]).toBe('JdtNum\tRefDate\tDueDate\tTaxDate\tMemo');
    expect(lin.split('\n')[0]).toBe('JdtNum\tLine_ID\tAccount\tDebit\tCredit\tLineMemo\tRef1');
    // Y la SEGUNDA fila es la descriptiva de la plantilla confirmada: omitirla
    // es el error más común del DTW, y también se puede intercambiar.
    expect(cab.split('\n')[1]).toBe('Número\tFecha\tVencimiento\tFecha fiscal\tConcepto');
    expect(lin.split('\n')[1]).toBe('Número\tRenglón\tCuenta\tCargo\tAbono\tConcepto\tReferencia');

    // La cabecera es UNA fila por póliza; las líneas son varias. Si estuvieran
    // cambiados, la de 5 columnas traería los movimientos.
    expect(renglones(cab)).toHaveLength(1);
    expect(renglones(lin).length).toBeGreaterThan(1);
    expect(renglones(cab)[0]).toHaveLength(5);
    // Y las cuentas declaradas están en el archivo de LÍNEAS, no en el otro.
    expect(lin).toContain('5010-001');
    expect(cab).not.toContain('5010-001');
  });

  it('un formato desconocido no se exporta «por si acaso»', async () => {
    const r = await GET(new Request('https://app.likida.ai/api/export/poliza?desde=2026-08-01&hasta=2026-08-24&formato=quickbooks'));
    expect(r.status).toBe(400);
  });
});

describe('PRU-A2: `Line_ID` numera los renglones dentro de cada JdtNum', () => {
  beforeEach(() => { perfil = PERFIL_SAP; });

  it('con DOS pólizas, cada JdtNum lleva Line_ID 0..n-1 sin repetir', async () => {
    // Dos liquidaciones = dos asientos = dos JdtNum. Es donde M14 (Line_ID
    // fijo en 0) y una numeración global (0..n sin reiniciar) se distinguen.
    filas = [
      { ...SANA, liquidacionId: 'l-1', folioViaje: 'VJ-1' },
      {
        ...SANA, liquidacionId: 'l-2', folioViaje: 'VJ-2',
        anticipo: 8000, comprobado: 5800, diferencia: 2200, ivaAcreditable: 800,
        porConcepto: [{ concepto: 'hospedaje', subtotal: 5000, baseConocida: true }],
        gastos: [{ id: 'g2', concepto: 'hospedaje', monto: 5800, subtotal: 5000, descuento: null, tieneCfdi: true, cfdiUuid: 'u-g2', formaPago: '03' }],
      },
    ];
    const r = await pedirSap();
    expect(r.status).toBe(200);
    const j = await r.json();

    const porAsiento = new Map<string, string[]>();
    for (const fila of renglones(j.archivos['JournalEntries_Lines.txt'] as string)) {
      const [jdtNum, lineId] = fila;
      porAsiento.set(jdtNum, [...(porAsiento.get(jdtNum) ?? []), lineId]);
    }

    expect([...porAsiento.keys()].sort()).toEqual(['1', '2']);
    for (const [jdtNum, ids] of porAsiento) {
      // 0..n-1, en orden y SIN repetir. `new Set` mata M14 por sí solo; la
      // igualdad contra la secuencia mata también la numeración global.
      expect(new Set(ids).size, `JdtNum ${jdtNum} repite Line_ID`).toBe(ids.length);
      expect(ids).toEqual(ids.map((_, i) => String(i)));
      expect(ids.length).toBeGreaterThan(1);
    }

    // El JdtNum de la cabecera es el mismo que liga las líneas: sin esto los
    // dos archivos no se importan juntos.
    expect(renglones(j.archivos['oJournalEntries.txt'] as string).map((f) => f[0])).toEqual(['1', '2']);
  });
});

// Captura sintética real de supabase/tests/0342_poliza_revision_y_desglose.sql.
// Se crea por guardar_liquidacion_tx → revisar_liquidacion → poliza_datos_tenant.
// El transporte devuelve esa captura; la clasificación y el archivo son reales.
describe('contrato SQL 0342 hasta la salida contable', () => {
  it('el periodo real con pendiente no genera archivo parcial', async () => {
    filas = filasSql342;
    const r = await pedir();
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: 'liquidaciones_sin_firma', folios: ['PENDIENTE'] });
    expect(r.headers.get('content-disposition')).toBeNull();
  });

  it.each(['AJUSTE-SUBE-INCOMPATIBLE', 'AJUSTE-BAJA-INCOMPATIBLE'])(
    '%s conserva tributos del CFDI y bloquea el asiento', async (folio) => {
      filas = filasSql342.filter((f) => f.folioViaje === folio);
      expect(filas).toHaveLength(1);
      const r = await pedir();
      expect(r.status).toBe(409);
      const body = JSON.stringify(await r.json());
      expect(body).toContain(folio);
      expect(body).toContain('no coincide con el desglose fiscal 3480.00');
      expect(r.headers.get('content-disposition')).toBeNull();
    },
  );

  it.each(['APROBADA', 'AJUSTE-SUBE-COHERENTE', 'AJUSTE-BAJA-COHERENTE'])(
    '%s permite el asiento con los impuestos documentados', async (folio) => {
      filas = filasSql342.filter((f) => f.folioViaje === folio);
      expect(filas).toHaveLength(1);
      const r = await pedir();
      expect(r.status).toBe(200);
      const archivo = await r.text();
      expect(archivo).toContain('1180-001');
      expect(archivo).not.toContain('1180-002');
      expect(archivo).toContain('480.00');
    },
  );
});


it.each(['ivaTraslado', 'iepsTraslado'])('un traslado NULL (%s) no equivale a cero conocido', async (campo) => {
  filas = [{ ...SANA, revision: 'ajustada', comprobado: 3000, diferencia: 2000, ivaAcreditable: 0,
    gastos: [{ ...SANA.gastos[0], monto: 3000, ivaTraslado: 0, iepsTraslado: 0, [campo]: null }] }];
  const r = await pedir();
  expect(r.status).toBe(409);
  expect(JSON.stringify(await r.json())).toContain('desglose fiscal completo');
  expect(r.headers.get('content-disposition')).toBeNull();
});


it('XML sin traslado IEPS produce cero conocido, coincide con SQL y permite la corrección', async () => {
  const xml = `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" TipoDeComprobante="I" SubTotal="3000" Total="3480" FormaPago="03">
    <cfdi:Emisor Rfc="XAXX010101000"/><cfdi:Receptor Rfc="XEXX010101000"/>
    <cfdi:Conceptos><cfdi:Concepto ClaveProdServ="15101505" Cantidad="1" ValorUnitario="3000" Importe="3000"/></cfdi:Conceptos>
    <cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Impuesto="002" Importe="480" TipoFactor="Tasa" TasaOCuota="0.160000"/></cfdi:Traslados></cfdi:Impuestos>
    <cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"/></cfdi:Complemento>
  </cfdi:Comprobante>`;
  const parsed = parseCfdiXml(xml)!;
  expect(parsed).not.toBeNull();
  expect(parsed.iepsTraslado).toBe(0);
  expect(parsed.ivaTraslado).toBe(480);
  // La captura SQL real ya recorrió la corrección 2000→3480 y conservó
  // exactamente estos tributos (repo_escritura prueba que el cero no es NULL).
  const sql = filasSql342.find((f) => f.folioViaje === 'AJUSTE-SUBE-COHERENTE')!;
  expect(sql.gastos[0].iepsTraslado).toBe(parsed.iepsTraslado);
  expect(sql.gastos[0].ivaTraslado).toBe(parsed.ivaTraslado);
  filas = [sql];
  const r = await pedir();
  expect(r.status).toBe(200);
  expect(await r.text()).not.toContain('1180-002');
});
