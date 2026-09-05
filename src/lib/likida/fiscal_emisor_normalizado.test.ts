// ═══════════════════════════════════════════════════════════════════════════
// D.22 (frente de escala) — EL AGREGADO POR EMISOR SE NORMALIZA CONTRA EL
// CATÁLOGO (RFC / dominio), NO CONTRA EL TEXTO QUE LA VISIÓN LEYÓ.
//
// "PEMEX", "PEMEX SA DE CV" y "PEMEX  SA DE CV" eran TRES celdas para el
// agregado fiscal: la cifra que ve el contador quedaba partida sin que nadie
// lo notara. La 0192 normalizó mayúsculas/espacios y dejó dicho que unificar
// variantes de fondo exigía el matching del catálogo — esto es ese matching,
// en TS (`consolidarCeldasPorEmisor`), donde vive `identificarComercio`.
//
// Y el `null`: una celda cuyo emisor no resuelve a nada NO se agrupa con
// nadie. `null` es `null`, jamás un cubo "otros".
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OpcionesFiscales } from './fiscal';

let celdasRpc: unknown[] = [];
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    rpc: () => Promise.resolve({ data: celdasRpc, error: null }),
  }),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { getGastosFiscales } = await import('./fiscal');

const HOY = '2026-08-22';
const T = 'tenant-a';
const OPTS: OpcionesFiscales = {
  efectivoTopeMxn: 2000,
  clavesCombustible: ['15101505'],
  clavesDieselIeps: ['15101505'],
  viaticosTopeFiscalDiarioMxn: 750,
  elegible15: true,
};

let seq = 0;
/** Una celda SIN CFDI tal como la emite `gastos_fiscales_agregados_tenant`. */
function celdaSinCfdi(over: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  const n = (over.n as number | undefined) ?? 2;
  return {
    concepto: 'caseta', claveProdServ: null, formaPago: null,
    efos: null, efosRevisar: null, estadoSat: null,
    tieneCfdi: false, sinFecha: false, ivaEstado: 'nulo', sobreTopeEfectivo: false,
    banda: 0, rfcEmisor: null, host: null, emisor: null, totalTimbradoDia: null,
    liquidacionFirmada: true,
    rfcReceptor: null, monedaExtranjera: false, renglonesAjenos: false, consumoBar: false,
    complementoHidrocarburosFalta: false, otroEjercicio: false,
    n, monto: 100 * n, iva: 0, ieps: 0, iepsNulos: n,
    subTotal: 0, subTotalNulos: n,
    muestraId: `g${String(seq).padStart(3, '0')}`, muestraCfdi: null, fechaMax: '2026-08-10',
    ...over,
  };
}

async function traer() {
  return getGastosFiscales(T, { clave: 'mes', desde: '2026-08-01', hasta: '2026-08-31', etiqueta: 'x' }, HOY, OPTS);
}

beforeEach(() => { seq = 0; celdasRpc = []; });

describe('D.22 — consolidación de celdas sin CFDI por identidad canónica del emisor', () => {
  it('el MISMO RFC con dos ortografías de nombre es UNA cifra, no dos', async () => {
    celdasRpc = [
      celdaSinCfdi({ rfcEmisor: 'PEP970814SF3', emisor: 'PEMEX', n: 3, monto: 300, muestraId: 'g900' }),
      celdaSinCfdi({ rfcEmisor: 'PEP970814SF3', emisor: 'PEMEX SA DE CV', n: 2, monto: 200, muestraId: 'g100' }),
    ];
    const gastos = await traer();
    expect(gastos).toHaveLength(1);
    expect(gastos[0]!.celda!.n).toBe(5);
    expect(gastos[0]!.monto).toBe(500);
    expect(gastos[0]!.rfcEmisor).toBe('PEP970814SF3');
    expect(gastos[0]!.id).toBe('g100');   // la muestra es la MENOR de las fundidas
  });

  it('dos celdas que resuelven al MISMO comercio por señales distintas (dominio vs RFC) se funden', async () => {
    // Office Depot: una celda entra por el HOST de la liga y la otra por el
    // RFC del catálogo — `identificarComercio` resuelve las dos a la misma
    // ficha, así que son el mismo emisor por más que el texto difiera.
    celdasRpc = [
      celdaSinCfdi({ host: 'facturacion.officedepot.com.mx', emisor: 'OFFICE DEPOT DE MEXICO', n: 1, monto: 150 }),
      celdaSinCfdi({ rfcEmisor: 'ODM950324V2A', emisor: 'OFFICE DEPOT', n: 1, monto: 250 }),
    ];
    const gastos = await traer();
    expect(gastos).toHaveLength(1);
    expect(gastos[0]!.celda!.n).toBe(2);
    expect(gastos[0]!.monto).toBe(400);
  });

  it('null es null: sin comercio y sin RFC no se agrupa con nadie — ni entre sí', async () => {
    celdasRpc = [
      celdaSinCfdi({ emisor: 'GASOLINERA EL AMANECER', n: 1, monto: 100 }),
      celdaSinCfdi({ emisor: 'GAS EL AMANECER SA', n: 1, monto: 130 }),
    ];
    const gastos = await traer();
    expect(gastos).toHaveLength(2);   // dos filas: nadie juró que son el mismo emisor
  });

  it('la identidad no cruza las demás dimensiones: misma flota de RFC, banda distinta, celdas distintas', async () => {
    celdasRpc = [
      celdaSinCfdi({ rfcEmisor: 'PEP970814SF3', emisor: 'PEMEX', banda: 0, n: 1, monto: 100 }),
      celdaSinCfdi({ rfcEmisor: 'PEP970814SF3', emisor: 'PEMEX SA DE CV', banda: 1, n: 1, monto: 100 }),
    ];
    const gastos = await traer();
    expect(gastos).toHaveLength(2);   // fundirlas cambiaría el plazo, no la ortografía
  });

  it('las celdas CON CFDI no se tocan: su identidad es el UUID, no el emisor', async () => {
    celdasRpc = [
      celdaSinCfdi({ tieneCfdi: true, muestraCfdi: 'uuid-1', rfcEmisor: null, ivaEstado: 'positivo', iva: 16, n: 1, monto: 116 }),
      celdaSinCfdi({ tieneCfdi: true, muestraCfdi: 'uuid-2', rfcEmisor: null, ivaEstado: 'positivo', iva: 16, n: 1, monto: 116 }),
    ];
    const gastos = await traer();
    expect(gastos).toHaveLength(2);
  });

  it('los agregados fundidos conservan la aritmética de nulos (IVA/subtotal por conteo, no por ?? 0)', async () => {
    celdasRpc = [
      celdaSinCfdi({ rfcEmisor: 'PEP970814SF3', emisor: 'PEMEX', n: 2, monto: 200, ivaEstado: 'nulo', iva: 0, iepsNulos: 2, subTotalNulos: 2 }),
      celdaSinCfdi({ rfcEmisor: 'PEP970814SF3', emisor: 'PEMEX SA', n: 1, monto: 100, ivaEstado: 'nulo', iva: 0, iepsNulos: 1, subTotalNulos: 1 }),
    ];
    const gastos = await traer();
    expect(gastos).toHaveLength(1);
    // TODOS los comprobantes del grupo carecen de desglose → el GastoFiscal
    // fundido dice null, no 0 — el invariante de la casa.
    expect(gastos[0]!.subTotal).toBeNull();
    expect(gastos[0]!.iepsTraslado).toBeNull();
    expect(gastos[0]!.ivaTraslado).toBeNull();
  });
});
