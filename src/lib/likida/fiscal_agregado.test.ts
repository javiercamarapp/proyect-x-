import { describe, it, expect, vi, beforeEach } from 'vitest';
import { armar as armarPorFacturar } from './facturacion/pendientes';
import { calcularCaducidad, type Plazo } from './facturacion/caducidad';
import { COMERCIOS } from './facturacion/comercios';

// ═══════════════════════════════════════════════════════════════════════════
// ESCALA 50k VIAJES/MES (mig. 0151): getGastosFiscales PASÓ DE `traerTodo`
// SOBRE TODO EL EJERCICIO (+ traerPorIds sobre los viajes) A UNA RPC QUE
// DEVUELVE CELDAS AGREGADAS POR DIMENSIÓN FISCAL.
//
// La ley (resumirFiscal/resumirPerdidas/…) NO se movió a SQL: recibe las
// celdas como `GastoFiscal` con `celda.n` y las pesa. Lo que este archivo
// prueba es LA EQUIVALENCIA: la misma ley, sobre las filas crudas (el camino
// viejo, congelado aquí como `legacyMapear`) y sobre las celdas (el camino
// nuevo, con la RPC mockeada por `sqlAgregadoEquivalente`, un reductor
// escrito de forma independiente que emula el `group by` de la 0151), tiene
// que dar EXACTAMENTE las mismas cifras visibles en el dataset sintético —
// que cubre cada dimensión que la ley mira: EFOS, cancelado, por validar,
// efectivo sobre y bajo el tope, combustible en efectivo, IEPS de diésel,
// casetas con y sin base, alimentación timbrada sobre el tope (mismo viaje y
// día, y un día igual en OTRO viaje), tickets sin CFDI con comercio
// reconocido por liga/RFC/texto y sin reconocer, recientes y vencidos, y
// uno sin fecha (solo entra en 'todo').
//
// También: fail-closed (error de la RPC, forma rota, celda malformada →
// LANZAN), aislamiento entre tenants, y que los cortes de plazo reproducen
// `calcularCaducidad` día por día para cada plazo del catálogo.
// ═══════════════════════════════════════════════════════════════════════════

type Fila = {
  id: string; tenant_id: string; viaje_id: string; concepto: string; monto: number;
  fecha: string | null; folio: string | null; rfc_emisor: string | null; cfdi_uuid: string | null;
  cfdi_valido: boolean | null; estado_sat: string | null; efos: boolean | null; efos_revisar: boolean | null;
  forma_pago: string | null; sub_total: number | null; iva_traslado: number | null; ieps_traslado: number | null;
  clave_prod_serv: string | null; tipo_comprobante: string | null; xml_verificado: boolean | null;
  ocr_confianza: number | null; ocr_extra: Record<string, unknown> | null;
  /** RE-AUDITORÍA 25, FIS-REAUD-1 (mig. 0316): el viaje de este gasto ya
   *  tiene liquidación firmada (aprobada|ajustada) — de pie por el
   *  `left join liquidacion` que la RPC hace de verdad; aquí, un campo
   *  directo alcanza para probar la equivalencia. */
  liquidacion_firmada: boolean;
  /** RE-AUDITORÍA 25, FIS-REAUD-2 (mig. 0317). */
  rfc_receptor: string | null;
  complemento_hidrocarburos: boolean | null;
  cfdi_esquema_alterno: boolean | null;
};

/** MISMO umbral y patrón que engine.ts (`UMBRAL_RENGLONES_AJENOS`,
 *  `SENAL_BAR`) — se importan de verdad en fiscal.ts; aquí, literales
 *  escritos de forma independiente alcanzan para probar la equivalencia. */
const UMBRAL_RENGLONES = 0.15;
const PATRON_BAR = /\b(bar|bares|cantina|cervecer[ií]a|pulquer[ií]a|antro|cabaret|table\s*dance|vinos\s+y\s+licores)\b/i;

const HOY = '2026-08-22';
const T = 'tenant-a';
const OTRO = 'tenant-b';

let seq = 0;
function fila(over: Partial<Fila>): Fila {
  seq += 1;
  return {
    id: `g${String(seq).padStart(3, '0')}`, tenant_id: T, viaje_id: 'v1', concepto: 'diesel', monto: 1000,
    fecha: '2026-08-10', folio: `F${seq}`, rfc_emisor: null, cfdi_uuid: `uuid-${seq}`, cfdi_valido: true,
    estado_sat: 'vigente', efos: false, efos_revisar: null, forma_pago: '04', sub_total: null,
    iva_traslado: null, ieps_traslado: null, clave_prod_serv: null, tipo_comprobante: 'I',
    xml_verificado: true, ocr_confianza: 0.9, ocr_extra: null,
    liquidacion_firmada: true,
    rfc_receptor: 'REC010101AA1', complemento_hidrocarburos: null, cfdi_esquema_alterno: null,
    ...over,
  };
}

function dataset(): Fila[] {
  seq = 0;
  const sinCfdi = { cfdi_uuid: null, estado_sat: null, efos: null, forma_pago: null, cfdi_valido: null, xml_verificado: null };
  return [
    // ── con CFDI, cada suerte fiscal ──
    fila({ iva_traslado: 137.93, ieps_traslado: 60, clave_prod_serv: '15101505', sub_total: 862.07 }),
    fila({ iva_traslado: 137.93, ieps_traslado: 60, clave_prod_serv: '15101505', sub_total: 862.07 }), // misma celda
    fila({ concepto: 'diesel', forma_pago: '01', iva_traslado: 68.97, ieps_traslado: 30, clave_prod_serv: '15101505', monto: 500 }),
    fila({ concepto: 'diesel', forma_pago: '01', iva_traslado: 68.97, ieps_traslado: null, clave_prod_serv: '15101505', monto: 500 }),
    fila({ concepto: 'otro', clave_prod_serv: '15101514', iva_traslado: 10, monto: 80 }), // gasolina: combustible por clave, sin IEPS
    fila({ concepto: 'otro', efos: true, iva_traslado: 41.38, monto: 300 }),
    fila({ concepto: 'otro', efos: null, efos_revisar: true, iva_traslado: 20, monto: 145 }),
    fila({ concepto: 'otro', estado_sat: 'cancelado', iva_traslado: 27.59, monto: 200 }),
    fila({ concepto: 'otro', estado_sat: null, iva_traslado: 16, monto: 116 }),            // por validar
    fila({ concepto: 'otro', estado_sat: 'pendiente', iva_traslado: 16, monto: 116 }),     // por validar, no sostiene IVA
    fila({ concepto: 'otro', forma_pago: '01', iva_traslado: 344.83, monto: 2500 }),       // efectivo SOBRE tope
    fila({ concepto: 'otro', forma_pago: '01', iva_traslado: 206.9, monto: 1500 }),        // efectivo BAJO tope
    fila({ concepto: 'otro', forma_pago: '01', iva_traslado: 0, monto: 2001 }),            // sobre tope, iva 0
    fila({ concepto: 'caseta', iva_traslado: 48, sub_total: 300, monto: 348 }),
    fila({ concepto: 'caseta', iva_traslado: null, sub_total: null, monto: 232 }),
    fila({ concepto: 'caseta', iva_traslado: 48, sub_total: 300, monto: 348, fecha: '2026-08-11' }),
    fila({ concepto: 'flete', iva_traslado: 800, monto: 5800 }),
    fila({ concepto: 'otro', monto: 0, iva_traslado: 5 }), // monto cero con IVA: no entra al tope 15 ni a días
    // ── alimentación: el tope de $750 por (viaje, día) ──
    fila({ viaje_id: 'v2', concepto: 'alimentacion', monto: 500, iva_traslado: 68.97, fecha: '2026-08-12' }),
    fila({ viaje_id: 'v2', concepto: 'alimentacion', monto: 400, iva_traslado: 55.17, fecha: '2026-08-12' }),
    fila({ viaje_id: 'v2', concepto: 'alimentacion', monto: 300, iva_traslado: 41.38, fecha: '2026-08-12', ...sinCfdi }), // no timbrado: no entra al prorrateo
    fila({ viaje_id: 'v3', concepto: 'alimentacion', monto: 700, iva_traslado: 96.55, fecha: '2026-08-12' }), // otro viaje, bajo tope
    fila({ viaje_id: 'v3', concepto: 'viaticos', monto: 900, iva_traslado: 124.14, fecha: '2026-08-13' }),    // solo, sobre tope
    fila({ viaje_id: 'v3', concepto: 'alimentacion', monto: 820, iva_traslado: 113.1, fecha: '2026-08-13', forma_pago: '01' }), // sobre tope Y efectivo: no sostiene
    fila({ viaje_id: 'v4', concepto: 'alimentacion', monto: 760, iva_traslado: 104.83, fecha: null }), // sin fecha: propio día, sobre tope
    // ── sin CFDI: el plazo del portal ──
    fila({ concepto: 'diesel', monto: 800, fecha: '2026-08-20', ...sinCfdi, ocr_extra: { urlFacturacion: 'https://facturacion.oxxogas.com/?folio=A1', emisor: 'OXXO GAS' } }),
    fila({ concepto: 'diesel', monto: 810, fecha: '2026-08-21', ...sinCfdi, ocr_extra: { urlFacturacion: 'https://facturacion.oxxogas.com/?folio=A2', emisor: 'OXXO GAS' } }),
    fila({ concepto: 'diesel', monto: 700, fecha: '2026-07-15', ...sinCfdi, ocr_extra: { urlFacturacion: 'https://facturacion.oxxogas.com/?folio=B1' } }), // julio: mes_natural vencido
    fila({ concepto: 'otro', monto: 150, fecha: '2026-07-15', ...sinCfdi, ocr_extra: { urlFacturacion: 'https://facturacion.officedepot.com.mx/x?t=9' } }), // mes_siguiente: vigente
    fila({ concepto: 'otro', monto: 160, fecha: '2026-06-20', ...sinCfdi, ocr_extra: { urlFacturacion: 'https://facturacion.officedepot.com.mx/x?t=10' } }), // mes_siguiente: vencido
    fila({ concepto: 'otro', monto: 90, fecha: '2026-08-18', ...sinCfdi, rfc_emisor: 'CCO8605231N4' }), // OXXO por RFC
    fila({ concepto: 'otro', monto: 95, fecha: '2026-07-30', ...sinCfdi, ocr_extra: { emisor: 'GASOLINERA LA ESQUINA' } }), // sin comercio → default
    fila({ concepto: 'otro', monto: 2200, fecha: '2026-08-18', ...sinCfdi, forma_pago: '01' }), // sin CFDI y efectivo sobre tope
    fila({ concepto: 'otro', monto: 50, fecha: null, ...sinCfdi }),                              // sin fecha
    // ── otra flota: no debe contaminar ──
    fila({ tenant_id: OTRO, monto: 9999, iva_traslado: 999 }),
    fila({ tenant_id: OTRO, monto: 9998, ...sinCfdi, fecha: '2026-07-01' }),
  ];
}

// RE-AUDITORÍA 25, FIS-REAUD-2: las fórmulas de las 7 causas nuevas, UNA vez
// —lo que este archivo prueba es que la AGREGACIÓN (legacy fila-por-fila vs.
// SQL-emulado-y-celdas) no cambia ninguna cifra visible; que la FÓRMULA de
// cada causa es correcta ya lo prueba `fiscal.test.ts` directo contra
// `ivaSostenible`, con datasets propios por causa.
function monedaExtranjeraDe(f: Fila): boolean {
  const m = f.ocr_extra?.moneda;
  return typeof m === 'string' && m !== '' && m !== 'MXN';
}
function renglonesAjenosDe(f: Fila): boolean {
  const renglones = f.ocr_extra?.renglones;
  if (!Array.isArray(renglones) || !(f.monto > 0)) return false;
  const suma = renglones
    .filter((r): r is { ajenoAlViaje: boolean; importe: number } =>
      Boolean(r) && typeof r === 'object' && (r as { ajenoAlViaje?: unknown }).ajenoAlViaje === true
      && typeof (r as { importe?: unknown }).importe === 'number' && Number.isFinite((r as { importe: number }).importe))
    .reduce((s, r) => s + r.importe, 0);
  return suma > 0 && suma / f.monto >= UMBRAL_RENGLONES;
}
function consumoBarDe(f: Fila): boolean {
  if (f.concepto !== 'alimentacion') return false;
  const textos = [f.ocr_extra?.emisor, f.ocr_extra?.producto].filter((v): v is string => typeof v === 'string' && v.length > 0);
  return textos.some((t) => PATRON_BAR.test(t));
}
function complementoHidrocarburosFaltaDe(f: Fila, clavesCombustible: string[], vigenteDesde: string, exigibleDesde: string | null): boolean {
  const esCombustible = f.concepto === 'diesel' || clavesCombustible.includes(f.clave_prod_serv ?? '');
  if (!esCombustible) return false;
  if (f.tipo_comprobante !== 'I' && f.tipo_comprobante !== 'E') return false;
  const miraElComplemento = f.fecha === null || f.fecha >= vigenteDesde;
  if (!miraElComplemento) return false;
  if (f.cfdi_esquema_alterno) return false;
  if (f.complemento_hidrocarburos) return false;
  if (f.xml_verificado !== true) return false;
  if (exigibleDesde === null) return false;
  return f.fecha === null || f.fecha >= exigibleDesde;
}
function otroEjercicioDe(f: Fila, hoy: string): boolean {
  if (f.fecha === null) return false;
  const ejercicioHoy = Number(hoy.slice(0, 4));
  const ejercicioGasto = Number(f.fecha.slice(0, 4));
  const enero = hoy.slice(5, 7) === '01';
  return ejercicioGasto < ejercicioHoy - (enero ? 1 : 0);
}
/** Config sintética de hidrocarburos para las pruebas de este archivo — sin
 *  fecha de exigibilidad respaldada, como en producción hoy (`NORMAS`). */
const HIDROCARBUROS = { claves: ['15101505', '15101514', '15101515'], vigenteDesde: '2026-04-24', exigibleDesde: null as string | null };

// ── EL CAMINO VIEJO, congelado: el mapeo fila→GastoFiscal de getGastosFiscales
//    antes de la 0151 (sin el contexto de viaje, que ninguna cifra usa). ──
import type { GastoFiscal, OpcionesFiscales } from './fiscal';
function legacyMapear(filas: Fila[], tenantId: string, desde: string | null, hasta: string | null, hoy: string): GastoFiscal[] {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const bool = (v: unknown): boolean | null => (v === null || v === undefined ? null : Boolean(v));
  return filas
    .filter((f) => f.tenant_id === tenantId)
    .filter((f) => (desde === null || (f.fecha !== null && f.fecha >= desde)) && (hasta === null || (f.fecha !== null && f.fecha <= hasta)))
    .map((f) => {
      const cfdiUuid = f.cfdi_uuid || null;
      let plazoVencido: boolean | null = null;
      if (!cfdiUuid) {
        const c = armarPorFacturar({
          id: f.id, concepto: f.concepto ?? 'otro', monto: Number(f.monto ?? 0), fecha: f.fecha || null,
          folio: f.folio || null, rfc_emisor: f.rfc_emisor || null, cfdi_uuid: null, ocr_extra: f.ocr_extra,
        }, hoy).caducidad;
        plazoVencido = c.desconocido ? null : c.vencido;
      }
      return {
        id: f.id, viajeId: f.viaje_id ?? '', concepto: f.concepto ?? 'otro', monto: Number(f.monto ?? 0),
        fecha: f.fecha || null, folio: f.folio || null, rfcEmisor: f.rfc_emisor || null, cfdiUuid,
        cfdiValido: bool(f.cfdi_valido), estadoSat: f.estado_sat || null, efos: bool(f.efos),
        efosRevisar: bool(f.efos_revisar), formaPago: f.forma_pago || null, subTotal: num(f.sub_total),
        ivaTraslado: num(f.iva_traslado), iepsTraslado: num(f.ieps_traslado), claveProdServ: f.clave_prod_serv || null,
        tipoComprobante: f.tipo_comprobante || null, xmlVerificado: bool(f.xml_verificado), ocrConfianza: num(f.ocr_confianza),
        viajeFolio: null, operadorNombre: null, plazoVencido,
        liquidacionFirmada: f.liquidacion_firmada,
        rfcReceptor: f.rfc_receptor || null,
        monedaExtranjera: monedaExtranjeraDe(f),
        renglonesAjenos: renglonesAjenosDe(f),
        consumoBar: consumoBarDe(f),
        complementoHidrocarburosFalta: complementoHidrocarburosFaltaDe(f, HIDROCARBUROS.claves, HIDROCARBUROS.vigenteDesde, HIDROCARBUROS.exigibleDesde),
        otroEjercicio: otroEjercicioDe(f, hoy),
      };
    });
}

// ── EL SQL, emulado de forma independiente (lo que la RPC de la 0151 hace). ──
type ArgsRpc = {
  p_tenant: string; p_desde: string | null; p_hasta: string | null;
  p_tope_efectivo: number; p_tope_alimentacion: number | null;
  p_conceptos_alimentacion: string[]; p_cortes: string[];
  p_claves_combustible: string[]; p_vigente_desde: string | null; p_exigible_desde: string | null;
  p_umbral_renglones_ajenos: number; p_patron_bar: string; p_hoy: string;
};
function hostDe(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  const m = url.toLowerCase().match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/?#]+)/);
  return m ? m[1] : null;
}
function sqlAgregadoEquivalente(filas: Fila[], a: ArgsRpc): unknown[] {
  const nz = (s: string | null) => (s === null || s === '' ? null : s);
  const base = filas
    .filter((f) => f.tenant_id === a.p_tenant)
    .filter((f) => (a.p_desde === null || (f.fecha !== null && f.fecha >= a.p_desde)) && (a.p_hasta === null || (f.fecha !== null && f.fecha <= a.p_hasta)))
    .map((f) => ({
      ...f,
      rfc_emisor: nz(f.rfc_emisor), cfdi_uuid: nz(f.cfdi_uuid), estado_sat: nz(f.estado_sat),
      forma_pago: nz(f.forma_pago), clave_prod_serv: nz(f.clave_prod_serv),
      tiene_cfdi: nz(f.cfdi_uuid) !== null,
      dia: f.fecha ?? `sin-fecha:${f.id}`,
      sobre_tope: f.monto > a.p_tope_efectivo,
      iva_estado: f.iva_traslado === null ? 'nulo' : f.iva_traslado > 0 ? 'positivo' : 'no_positivo',
    }));
  // dias: (viaje, dia) de alimentación cuyo total timbrado rebasa el tope
  const dias = new Map<string, number>();
  if (a.p_tope_alimentacion !== null) {
    const acc = new Map<string, number>();
    for (const b of base) {
      if (!a.p_conceptos_alimentacion.includes(b.concepto) || !(b.monto > 0)) continue;
      const k = `${b.viaje_id}|${b.dia}`;
      acc.set(k, (acc.get(k) ?? 0) + (b.tiene_cfdi ? b.monto : 0));
    }
    for (const [k, t] of acc) if (t > a.p_tope_alimentacion) dias.set(k, t);
  }
  const celdas = new Map<string, Record<string, unknown> & { n: number; monto: number; iva: number; ieps: number; iepsNulos: number; subTotal: number; subTotalNulos: number; muestraId: string; muestraCfdi: string | null; fechaMax: string | null }>();
  for (const b of base) {
    const sinCfdi = !b.tiene_cfdi;
    const banda = sinCfdi && b.fecha !== null ? a.p_cortes.filter((c) => b.fecha! < c).length : null;
    const enDia = b.tiene_cfdi && b.monto > 0 && a.p_conceptos_alimentacion.includes(b.concepto) && dias.has(`${b.viaje_id}|${b.dia}`);
    const dims = {
      concepto: b.concepto, claveProdServ: b.clave_prod_serv, formaPago: b.forma_pago, efos: b.efos, efosRevisar: b.efos_revisar,
      estadoSat: b.estado_sat, tieneCfdi: b.tiene_cfdi, sinFecha: b.fecha === null, ivaEstado: b.iva_estado, sobreTopeEfectivo: b.sobre_tope,
      banda, rfcEmisor: sinCfdi ? b.rfc_emisor : null, host: sinCfdi ? hostDe(b.ocr_extra?.urlFacturacion) : null,
      // AUDITORÍA 19 (REND-19c2-2, mig. 0192): normalizado — mismo criterio
      // que `identificarComercio` (.toUpperCase() sobre textoTicket), para
      // que "OXXO"/"Oxxo"/" OXXO " dejen de ser tres celdas.
      emisor: sinCfdi ? nz(((b.ocr_extra?.emisor as string | undefined)?.trim().toUpperCase()) ?? null) : null,
      diaViaje: enDia ? b.viaje_id : null, diaDia: enDia ? b.dia : null,
      totalTimbradoDia: enDia ? dias.get(`${b.viaje_id}|${b.dia}`)! : null,
      liquidacionFirmada: b.liquidacion_firmada,
      rfcReceptor: nz(b.rfc_receptor),
      monedaExtranjera: monedaExtranjeraDe(b),
      renglonesAjenos: renglonesAjenosDe(b),
      consumoBar: consumoBarDe(b),
      complementoHidrocarburosFalta: complementoHidrocarburosFaltaDe(b, a.p_claves_combustible, a.p_vigente_desde ?? HIDROCARBUROS.vigenteDesde, a.p_exigible_desde),
      otroEjercicio: otroEjercicioDe(b, a.p_hoy),
    };
    const k = JSON.stringify(dims);
    const c = celdas.get(k) ?? { ...dims, n: 0, monto: 0, iva: 0, ieps: 0, iepsNulos: 0, subTotal: 0, subTotalNulos: 0, muestraId: b.id, muestraCfdi: b.cfdi_uuid, fechaMax: b.fecha };
    c.n += 1; c.monto += b.monto; c.iva += b.iva_traslado ?? 0; c.ieps += b.ieps_traslado ?? 0;
    if (b.ieps_traslado === null) c.iepsNulos += 1;
    c.subTotal += b.sub_total ?? 0; if (b.sub_total === null) c.subTotalNulos += 1;
    if (b.id < c.muestraId) c.muestraId = b.id;
    if (b.cfdi_uuid !== null && (c.muestraCfdi === null || b.cfdi_uuid < c.muestraCfdi)) c.muestraCfdi = b.cfdi_uuid;
    if (b.fecha !== null && (c.fechaMax === null || b.fecha > c.fechaMax)) c.fechaMax = b.fecha;
    celdas.set(k, c);
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return [...celdas.values()].map(({ diaViaje, diaDia, ...c }) => ({ ...c, monto: round2(c.monto), iva: round2(c.iva), ieps: round2(c.ieps), subTotal: round2(c.subTotal) }));
}
function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }

const servidor: { filas: Fila[] } = { filas: [] };
const llamadasRpc: Array<{ fn: string; args: ArgsRpc }> = [];
let forzarError: { message: string } | null = null;
let forzarForma: unknown = undefined;

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    rpc: (fn: string, args: ArgsRpc) => {
      llamadasRpc.push({ fn, args });
      if (forzarError) return Promise.resolve({ data: null, error: forzarError });
      if (forzarForma !== undefined) return Promise.resolve({ data: forzarForma, error: null });
      return Promise.resolve({ data: sqlAgregadoEquivalente(servidor.filas, args), error: null });
    },
  }),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const {
  getGastosFiscales, resumirFiscal, resumirPerdidas, resumirCombustibleCasetas, tope15DeGastos,
  diagnosticoRetencion, cortesDePlazo, resolverPeriodo,
} = await import('./fiscal');

const OPTS: OpcionesFiscales = {
  efectivoTopeMxn: 2000,
  clavesCombustible: ['15101505', '15101514', '15101515'],
  clavesDieselIeps: ['15101505'],
  viaticosTopeFiscalDiarioMxn: 750,
  elegible15: true,
};

beforeEach(() => {
  servidor.filas = dataset();
  llamadasRpc.length = 0;
  forzarError = null;
  forzarForma = undefined;
});

/** Todo lo que las pantallas y el chat leen, sobre un mismo arreglo de GastoFiscal. */
function cifras(gastos: GastoFiscal[], o: OpcionesFiscales) {
  const p = resumirPerdidas(gastos, o);
  // `filas` es la ÚNICA salida por comprobante (sin consumidor vivo): se excluye.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { filas, ...perdidas } = p;
  return {
    fiscal: resumirFiscal(gastos, o),
    perdidas,
    combustible: resumirCombustibleCasetas(gastos),
    tope15: tope15DeGastos(gastos, o),
    retencion: diagnosticoRetencion(gastos),
  };
}

describe('getGastosFiscales — equivalencia: la ley sobre filas crudas vs sobre celdas (mig. 0151)', () => {
  it.each([
    ['ejercicio', '2026-01-01', '2026-12-31'],
    ['mes', '2026-08-01', '2026-08-31'],
    ['7 días', '2026-08-16', '2026-08-22'],
    ['todo (sin cota: entran los sin fecha)', null, null],
  ])('%s: ninguna cifra visible cambia', async (_n, desde, hasta) => {
    const crudo = legacyMapear(servidor.filas, T, desde, hasta, HOY);
    const celdas = await getGastosFiscales(T, { clave: 'mes', desde, hasta, etiqueta: 'x' }, HOY, OPTS);
    const viejo = cifras(crudo, OPTS);
    const nuevo = cifras(celdas, OPTS);
    expect(nuevo).toEqual(viejo);
    // Control: el dataset sí ejercita lo que importa.
    expect(viejo.fiscal.n).toBeGreaterThan(0);
  });

  it('el dataset ejercita cada cubeta (control de que la equivalencia no es trivial)', () => {
    const v = cifras(legacyMapear(servidor.filas, T, null, null, HOY), OPTS);
    expect(v.perdidas.montoPerdido).toBeGreaterThan(0);
    expect(v.perdidas.montoEnRiesgo).toBeGreaterThan(0);
    expect(v.perdidas.montoRecuperable).toBeGreaterThan(0);
    expect(v.perdidas.porCausa.map((c) => c.causa).sort()).toEqual([
      'cfdi_cancelado', 'combustible_efectivo', 'efectivo_sobre_tope', 'efos', 'efos_indeterminado', 'plazo_vencido', 'sin_cfdi',
    ]);
    expect(v.fiscal.ivaNoAcreditable).toBeGreaterThan(0);
    expect(v.fiscal.iepsDieselDocumentado).toBe(120);
    expect(v.fiscal.casetasSinSubTotal).toBe(1);
    expect(v.fiscal.porValidar).toBe(2);
    expect(v.perdidas.sinFecha).toBe(2);
    expect(v.tope15.razon).toBeGreaterThan(0);
    expect(v.retencion.candidatos).toBe(1);
  });

  it('la proporción de alimentación es la del motor: 900 timbrados en el día → 750/900 de su IVA', async () => {
    // El tope es por (viaje, DÍA) y sobre lo TIMBRADO, con el criterio del
    // motor (`diasSobreTope`). Se compara contra el cálculo hecho a mano, no
    // contra el camino viejo, para que un bug compartido no se esconda:
    //   · v2, 12-ago: 500 + 400 timbrados = 900 > 750 → 750/900 para los dos.
    //     El de $300 SIN CFDI del mismo día NO infla el denominador
    //     (auditoría 8, CRÍTICO) ni recibe proporción.
    //   · v3, 12-ago: $700 solo, bajo el tope → acredita entero.
    //   · v3, 13-ago: $900 (viáticos) + $820 (alimentación en efectivo, bajo
    //     el tope de efectivo, así que SÍ sostiene IVA) comparten el día:
    //     1,720 timbrados > 750 → 750/1720 para los dos. Es el mismo día y el
    //     mismo viaje: el tope es por beneficiario y por día, no por
    //     comprobante ni por concepto.
    const celdas = await getGastosFiscales(T, { clave: 'mes', desde: '2026-08-12', hasta: '2026-08-13', etiqueta: 'x' }, HOY, OPTS);
    const r = resumirFiscal(celdas, OPTS);
    const esperado = (68.97 + 55.17) * (750 / 900) + 96.55 + (124.14 + 113.1) * (750 / 1720);
    expect(r.ivaAcreditable).toBeCloseTo(esperado, 2);
    expect(r.ivaAcreditable + r.ivaNoAcreditable).toBeCloseTo(68.97 + 55.17 + 41.38 + 96.55 + 124.14 + 113.1, 2);
  });

  it('cientos de celdas, no millones de filas: 10,000 comprobantes repetidos caben en las mismas celdas', async () => {
    const base = dataset().filter((f) => f.tenant_id === T);
    const grande: Fila[] = [];
    for (let i = 0; i < 300; i++) {
      for (const f of base) grande.push({ ...f, id: `${f.id}-${i}`, cfdi_uuid: f.cfdi_uuid ? `${f.cfdi_uuid}-${i}` : null, viaje_id: `${f.viaje_id}-${i}` });
    }
    servidor.filas = grande;
    const celdas = await getGastosFiscales(T, resolverPeriodo('todo', HOY), HOY, OPTS);
    expect(grande.length).toBe(base.length * 300);
    // Cada celda nueva por viaje-día sobre tope (4 por copia) es lo único que
    // crece con el volumen: todo lo demás son las mismas dimensiones.
    expect(celdas.length).toBeLessThan(base.length + 4 * 300);
    expect(resumirFiscal(celdas, OPTS).n).toBe(grande.length);
    expect(cifras(celdas, OPTS)).toEqual(cifras(legacyMapear(grande, T, null, null, HOY), OPTS));
  });

  it('aislamiento: la otra flota no contamina ninguna celda', async () => {
    const celdas = await getGastosFiscales(T, resolverPeriodo('todo', HOY), HOY, OPTS);
    expect(celdas.some((c) => c.monto >= 9998)).toBe(false);
    expect(resumirFiscal(celdas, OPTS).gastoTotal).toBe(resumirFiscal(legacyMapear(servidor.filas, T, null, null, HOY), OPTS).gastoTotal);
  });

  it('un tenant sin gastos: cero celdas, n=0 medido', async () => {
    const celdas = await getGastosFiscales('nadie', resolverPeriodo('todo', HOY), HOY, OPTS);
    expect(celdas).toEqual([]);
    expect(resumirFiscal(celdas, OPTS).n).toBe(0);
  });

  it('AUDITORÍA 19 (REND-19c2-2, mig. 0192): "OXXO", "Oxxo" y " OXXO " son UNA celda, no tres', async () => {
    // `emisor` no se expone en `GastoFiscal` (solo alimenta `plazoVencido`
    // internamente — ver `aGastoFiscal`), así que lo observable es el
    // AGRUPAMIENTO: sin normalizar, las 3 filas de abajo habrían salido
    // como 3 celdas de n=1; con la 0192, salen como UNA de n=3. La cuarta
    // fila (emisor real distinto) confirma que no se está fusionando de más.
    const sinCfdi = { cfdi_uuid: null, estado_sat: null, efos: null, forma_pago: null, cfdi_valido: null, xml_verificado: null };
    servidor.filas = [
      fila({ tenant_id: T, monto: 100, ...sinCfdi, ocr_extra: { emisor: 'OXXO' } }),
      fila({ tenant_id: T, monto: 200, ...sinCfdi, ocr_extra: { emisor: 'Oxxo' } }),
      fila({ tenant_id: T, monto: 300, ...sinCfdi, ocr_extra: { emisor: ' OXXO ' } }),
      fila({ tenant_id: T, monto: 400, ...sinCfdi, ocr_extra: { emisor: 'GASOLINERA LA ESQUINA' } }),
    ];
    const celdas = await getGastosFiscales(T, resolverPeriodo('todo', HOY), HOY, OPTS);
    expect(celdas).toHaveLength(2);
    const fundida = celdas.find((c) => c.monto === 600)!;
    expect(fundida.celda?.n).toBe(3);
    expect(celdas.some((c) => c.monto === 400 && c.celda?.n === 1)).toBe(true);
  });
});

describe('getGastosFiscales — FIS-REAUD-1 (mig. 0316): sin liquidación firmada, la celda no acredita su IVA', () => {
  it('un comprobante de un viaje SIN liquidación firmada llega marcado y `ivaSostenible` lo niega', async () => {
    servidor.filas = [
      fila({ tenant_id: T, monto: 1160, iva_traslado: 160, liquidacion_firmada: false }),
      fila({ tenant_id: T, monto: 1160, iva_traslado: 160, liquidacion_firmada: true }),
    ];
    const celdas = await getGastosFiscales(T, resolverPeriodo('todo', HOY), HOY, OPTS);
    expect(celdas).toHaveLength(2);
    const r = resumirFiscal(celdas, OPTS);
    expect(r.ivaAcreditable).toBe(160);
    expect(r.ivaNoAcreditable).toBe(160);
    expect(cifras(celdas, OPTS)).toEqual(cifras(legacyMapear(servidor.filas, T, null, null, HOY), OPTS));
  });
});

describe('getGastosFiscales — los argumentos viajan a la RPC', () => {
  it('manda tenant, periodo, los topes de la config y los cortes ascendentes', async () => {
    await getGastosFiscales(T, resolverPeriodo('ejercicio', HOY), HOY, OPTS);
    const a = llamadasRpc[0];
    expect(a.fn).toBe('gastos_fiscales_agregados_tenant');
    expect(a.args.p_tenant).toBe(T);
    expect(a.args.p_desde).toBe('2026-01-01');
    expect(a.args.p_hasta).toBe('2026-12-31');
    expect(a.args.p_tope_efectivo).toBe(2000);
    expect(a.args.p_tope_alimentacion).toBe(750);
    expect(a.args.p_conceptos_alimentacion).toEqual(['alimentacion', 'viaticos']);
    expect(a.args.p_cortes).toEqual([...a.args.p_cortes].sort());
    expect(a.args.p_cortes.length).toBeGreaterThan(0);
  });

  it('sin tope de alimentación configurado, manda null (el motor tampoco prorratea)', async () => {
    await getGastosFiscales(T, resolverPeriodo('mes', HOY), HOY, { ...OPTS, viaticosTopeFiscalDiarioMxn: null });
    expect(llamadasRpc[0].args.p_tope_alimentacion).toBeNull();
  });

  it('RE-AUDITORÍA 25, FIS-REAUD-2: manda las claves de combustible, el umbral, el patrón de bar traducido a `\\y` y `hoy`', async () => {
    await getGastosFiscales(T, resolverPeriodo('mes', HOY), HOY, OPTS);
    const a = llamadasRpc[0].args;
    expect(a.p_claves_combustible).toEqual(OPTS.clavesCombustible);
    expect(a.p_umbral_renglones_ajenos).toBe(UMBRAL_RENGLONES);
    expect(a.p_patron_bar).not.toContain('\\b');
    expect(a.p_hoy).toBe(HOY);
  });

  it('sin RFC/hidrocarburos declarados en OpcionesFiscales, manda null (el panel no restringe de más)', async () => {
    await getGastosFiscales(T, resolverPeriodo('mes', HOY), HOY, OPTS);
    const a = llamadasRpc[0].args;
    expect(a.p_vigente_desde).toBeNull();
    expect(a.p_exigible_desde).toBeNull();
  });
});

describe('getGastosFiscales — fail-closed (mig. 0151)', () => {
  it('un error de la RPC LANZA', async () => {
    forzarError = { message: 'function gastos_fiscales_agregados_tenant does not exist' };
    await expect(getGastosFiscales(T, resolverPeriodo('mes', HOY), HOY, OPTS)).rejects.toThrow(/does not exist/);
  });
  it('data que no es arreglo LANZA (¿migración sin aplicar?)', async () => {
    forzarForma = null;
    await expect(getGastosFiscales(T, resolverPeriodo('mes', HOY), HOY, OPTS)).rejects.toThrow(/0151/);
  });
  it('una celda sin `n` o con `monto` que no es número LANZA — nunca `?? 0`', async () => {
    forzarForma = [{ concepto: 'diesel', monto: '12' }];
    await expect(getGastosFiscales(T, resolverPeriodo('mes', HOY), HOY, OPTS)).rejects.toThrow(/forma esperada/);
    forzarForma = [{ ...(sqlAgregadoEquivalente(dataset(), {
      p_tenant: T, p_desde: null, p_hasta: null, p_tope_efectivo: 2000, p_tope_alimentacion: 750,
      p_conceptos_alimentacion: ['alimentacion'], p_cortes: [],
      p_claves_combustible: HIDROCARBUROS.claves, p_vigente_desde: HIDROCARBUROS.vigenteDesde, p_exigible_desde: null,
      p_umbral_renglones_ajenos: UMBRAL_RENGLONES, p_patron_bar: PATRON_BAR.source, p_hoy: HOY,
    })[0] as object), n: 0 }];
    await expect(getGastosFiscales(T, resolverPeriodo('mes', HOY), HOY, OPTS)).rejects.toThrow(/`n`/);
  });
});

describe('cortesDePlazo — reproduce calcularCaducidad día por día, para cada plazo del catálogo', () => {
  const plazos: Plazo[] = ['mes_natural'];
  for (const c of COMERCIOS) if (!plazos.some((p) => JSON.stringify(p) === JSON.stringify(c.plazo))) plazos.push(c.plazo);

  it.each(['2026-08-22', '2026-08-01', '2026-08-31', '2026-01-03', '2026-03-01', '2026-12-31'])('hoy=%s', (hoy) => {
    const cortes = cortesDePlazo(hoy);
    for (let atras = -5; atras <= 200; atras++) {
      const d = new Date(`${hoy}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - atras);
      const fecha = d.toISOString().slice(0, 10);
      const banda = cortes.cortes.filter((c) => fecha < c).length;  // lo que SQL cuenta
      for (const plazo of plazos) {
        expect(cortes.vencido(plazo, banda), `plazo ${JSON.stringify(plazo)} fecha ${fecha}`)
          .toBe(calcularCaducidad({ fechaTicket: fecha, plazo, hoy }).vencido);
      }
    }
  });

  it('hay un corte por plazo distinto (los siete del catálogo hoy)', () => {
    // Este bloque es el CANARIO del catálogo: se dispara en cuanto entra un
    // plazo de una forma que no existía, para que alguien mire si la dimensión
    // agrupable sigue teniendo sentido en vez de que crezca sola.
    //
    // Y se disparó. Hasta el banco de tickets reales el catálogo solo conocía
    // dos formas —'mes_natural' y 'mes_siguiente'—, ambas con corte a día 1 de
    // algún mes. Los comprobantes fotografiados en campo trajeron tres plazos
    // que están IMPRESOS EN EL PAPEL y que no caen en día 1:
    //
    //   2026-06-23 → { dias: 60 }   Home Depot: "USTED TIENE 60 DIAS PARA ESTE
    //                               TRAMITE", literal en los siete tickets.
    //   2026-07-01 → 'mes_siguiente'
    //   2026-08-01 → 'mes_natural'
    //   2026-08-19 → { horas: 72 }  BPT Group / Boston's Pizza.
    //   2026-08-21 → { horas: 24 }  Conekta 360, el plazo más corto que se ha
    //                               visto: un ticket de ayer ya venció.
    //
    // NO hace falta migración por esto: `cortesDePlazo` calcula los cortes con
    // el reloj real a partir del catálogo y se los pasa a SQL como parámetro
    // —la RPC solo cuenta cuántos cortes quedan por encima de la fecha—, así
    // que la base nunca supo cuáles eran ni cuántos. Que todas las formas
    // sigan coincidiendo con `calcularCaducidad` día por día lo prueba el
    // bloque `hoy=%s` de arriba, que es la garantía de verdad; esto solo fija
    // el número y el orden para que el próximo plazo nuevo vuelva a avisar.
    //
    // ── VOLVIÓ A DISPARARSE: EL RECON DE PORTALES (28-ago-2026) ─────────────
    //
    // Se visitaron los 37 portales y nueve declaran su plazo con palabras
    // propias en la página. Dos formas NUEVAS entran a la dimensión:
    //
    //   2025-08-22 → { dias: 365 }  Red Vía Corta: "los tickets […] tienen
    //                               vigencia dentro del año fiscal al cruce o
    //                               compra". Es el corte más antiguo del
    //                               catálogo y por eso aparece primero.
    //   2026-07-23 → { dias: 30 }   Circuito Exterior: "cuentas con 30 días a
    //                               partir de la fecha de emisión de tu ticket".
    //
    // Y DOS FORMAS NUEVAS QUE HOY **NO** AÑADEN CORTE, lo cual es en sí el dato
    // interesante y conviene no leerlo como que dan igual:
    //
    //   · `{ mesDeCompraMas: { dias: 7 } }`  (ADO)
    //   · `{ mesDeCompraMas: { horas: 72 } }` (Primera Plus)
    //
    //     Un 22 de agosto los dos colapsan en el corte de 'mes_natural'
    //     (2026-08-01): a mitad de mes, "el mes de compra" y "el mes de compra
    //     más una cola" no se distinguen todavía. **Se separan del 1 al 7 de
    //     septiembre**, que es justo la ventana donde el plazo decide algo: un
    //     boleto de agosto sigue siendo facturable el 5-sep y 'mes_natural' lo
    //     habría dado por muerto. El bloque `hoy=%s` de arriba recorre 200 días
    //     hacia atrás desde seis fechas distintas, así que esa separación sí
    //     está cubierta — aquí solo no se ve porque este día no la muestra.
    //
    //   · `{ dias: 3 }` (Grupo Centra, el plazo más corto del catálogo) tampoco
    //     añade corte: coincide exactamente con `{ horas: 72 }` de Boston's, que
    //     es el mismo plazo dicho en otras unidades. Que colapsen es correcto.
    expect(cortesDePlazo('2026-08-22').cortes).toEqual([
      '2025-08-22', '2026-06-23', '2026-07-01', '2026-07-23',
      '2026-08-01', '2026-08-19', '2026-08-21',
    ]);
  });

  // El comentario de arriba afirma que ADO y Primera Plus se SEPARAN de
  // 'mes_natural' en los primeros días de septiembre. Eso se mide, no se
  // asegura: es la única ventana del año donde la variante nueva cambia una
  // respuesta, y por tanto la única donde un error se vería.
  it('la cola de ADO se separa del mes natural justo cuando decide algo', () => {
    const HOY = '2026-09-05';
    const c = cortesDePlazo(HOY);

    // Un boleto de ADO comprado el 20-ago: el portal lo acepta hasta el 7-sep.
    const boleto = '2026-08-20';
    const banda = c.cortes.filter((x) => boleto < x).length;

    expect(c.vencido({ mesDeCompraMas: { dias: 7 } }, banda), 'el 5-sep todavía se puede facturar').toBe(false);
    expect(c.vencido('mes_natural', banda), 'con el default se habría dado por muerto el 31-ago').toBe(true);

    // Y coincide con el reloj de verdad, que es la garantía que importa.
    expect(calcularCaducidad({ fechaTicket: boleto, plazo: { mesDeCompraMas: { dias: 7 } }, hoy: HOY }).vencido).toBe(false);
    expect(calcularCaducidad({ fechaTicket: boleto, plazo: 'mes_natural', hoy: HOY }).vencido).toBe(true);
  });
});
