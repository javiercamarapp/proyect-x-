import { describe, it, expect } from 'vitest';
import { resumirFiscal, type GastoFiscal, type OpcionesFiscales } from './fiscal';
import { cuadrarViaje } from './cuadre/engine';
import type { Gasto } from '@/types/likida';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 25 · FIS-C1 + FIS-C2 + ARQ-C1 (CRÍTICO, reincidente de la 23 y la
// 24). `resumirFiscal` (el panel del contador Y `resumen_fiscal` en
// `mcp/herramientas/dinero.ts`) llenaba `proporciones` SOLO con la proporción
// de alimentación (LISR 28-V) y dejaba el diésel en efectivo fuera del mapa:
// `proporciones.get(g.id) ?? 1` acreditaba el IVA COMPLETO de un comprobante
// que el motor (`cuadre/engine.ts`, el mismo que arma el PDF) solo acredita en
// la proporción dentro del 15% del ejercicio (RFA 2026 regla 2.9).
//
// Esta prueba compara, sobre el MISMO acumulado del ejercicio, la cifra del
// panel (`resumirFiscal`) contra la SUMA de lo que el motor (`cuadrarViaje`)
// acredita al cerrar dos viajes EN ORDEN. Antes del arreglo el panel decía el
// IVA completo de los dos comprobantes; el motor, la fracción correcta.
// ═══════════════════════════════════════════════════════════════════════════

const OPTS: OpcionesFiscales = {
  efectivoTopeMxn: 2000,
  clavesCombustible: ['15101505'],
  clavesDieselIeps: ['15101505'],
  viaticosTopeFiscalDiarioMxn: 750,
  elegible15: true,
};

/** Un CFDI de diésel pagado en efectivo ('01'), IVA desglosado al 16%. */
function diesel(id: string, subTotal: number): GastoFiscal {
  const ivaTraslado = Math.round(subTotal * 0.16 * 100) / 100;
  return {
    id, viajeId: id, concepto: 'diesel', monto: subTotal + ivaTraslado,
    fecha: '2026-07-15', folio: id, rfcEmisor: 'AAA010101AAA',
    cfdiUuid: `uuid-${id}`, cfdiValido: true, estadoSat: 'vigente',
    efos: false, efosRevisar: null, formaPago: '01',
    subTotal, ivaTraslado, iepsTraslado: null,
    claveProdServ: null, tipoComprobante: 'I', xmlVerificado: true,
    ocrConfianza: 0.95, viajeFolio: `VJ-${id}`, operadorNombre: 'Juan',
    plazoVencido: null, liquidacionFirmada: true,
    rfcReceptor: 'REC010101AA1', monedaExtranjera: false, renglonesAjenos: false,
    consumoBar: false, complementoHidrocarburosFalta: false, otroEjercicio: false,
  };
}

/** El MISMO comprobante, visto por el motor que arma el PDF. */
function dieselMotor(id: string, subTotal: number): Gasto {
  const ivaTraslado = Math.round(subTotal * 0.16 * 100) / 100;
  return {
    id, concepto: 'diesel', monto: subTotal + ivaTraslado, subTotal, folio: id,
    fecha: '2026-07-15', ocrConfianza: 0.95, cfdiUuid: `uuid-${id}`,
    xmlVerificado: true, rfcReceptor: 'REC010101AA1', tipoComprobante: 'I',
    ivaTraslado, formaPago: '01',
  };
}

const estimulos = { peajeFactor: 0.5, viaticosTopeFiscalDiarioMxn: 750, efectivoTopeMxn: 2000, clavesDieselIeps: [] };

describe('FIS-C1/FIS-C2/ARQ-C1 · el panel y el motor acreditan la MISMA proporción del 15%', () => {
  it('dos CFDI de diésel en efectivo que cruzan el 15% del ejercicio: el panel SUMA lo mismo que el motor viaje por viaje', () => {
    // Ejercicio: $1,000,000 de combustible total, tope del 15% = $150,000.
    // Dos CFDI de $100,000 (subtotal $86,206.90, IVA $13,793.10 c/u) pagados
    // en efectivo — $200,000 en total, $50,000 de excedente sobre el tope.
    const g1 = diesel('g1', 86206.90);
    const g2 = diesel('g2', 86206.90);

    const opciones: OpcionesFiscales = {
      ...OPTS,
      combustibleEjercicio: { efectivo: 200000, totalCombustible: 1000000 },
    };
    const panel = resumirFiscal([g1, g2], opciones).ivaAcreditable;

    // El motor, EN ORDEN: el viaje 1 cierra primero (cupo lleno: acredita
    // completo); el viaje 2 cierra después con el cupo ya casi agotado.
    const motor1 = cuadrarViaje({
      viajeId: 'g1', anticipo: g1.monto, politica: [{ concepto: 'diesel', topeMonto: 200000 }],
      estimulos, gastos: [dieselMotor('g1', 86206.90)],
      facilidad15: true, totalCombustibleEjercicio: 1000000, efectivoPrevEjercicio: 0, anioEjercicio: '2026',
    }).ivaAcreditable;
    const motor2 = cuadrarViaje({
      viajeId: 'g2', anticipo: g2.monto, politica: [{ concepto: 'diesel', topeMonto: 200000 }],
      estimulos, gastos: [dieselMotor('g2', 86206.90)],
      facilidad15: true, totalCombustibleEjercicio: 1000000, efectivoPrevEjercicio: g1.monto, anioEjercicio: '2026',
    }).ivaAcreditable;

    // Antes del arreglo: `panel` era 13,793.10 + 13,793.10 = 27,586.20 (el IVA
    // COMPLETO de los dos) — ni siquiera el orden importaba, todo pasaba de
    // largo con `?? 1`.
    expect(panel).toBeCloseTo(motor1 + motor2, 1);
    expect(panel).toBeCloseTo(20689.65, 1); // 0.75 · (13,793.10 + 13,793.10)
    // RE-AUDITORÍA 25, FIS-REAUD-3 (ALTO): hubo crédito vía el 15% en vivo —
    // el panel tiene que decirlo, porque el motor de un viaje ANTERIOR de
    // este mismo ejercicio pudo haber fijado su reparto contra un acumulado
    // más chico que el de hoy.
    expect(resumirFiscal([g1, g2], opciones).combustible15SujetoADeriva).toBe(true);
  });

  it('sin `combustibleEjercicio` (periodo que cruza años, ej. «todo»): NO se acredita — fail closed, no el `?? 1` de antes', () => {
    const g1 = diesel('g1', 86206.90);
    const r = resumirFiscal([g1], OPTS); // OPTS no trae combustibleEjercicio
    expect(r.ivaAcreditable).toBe(0);
    expect(r.ivaNoAcreditable).toBeCloseTo(g1.ivaTraslado!, 2);
    // RE-AUDITORÍA 25, FIS-REAUD-3: nada se acreditó vía el 15% — no hay
    // cifra que pudiera contradecir a un PDF archivado.
    expect(r.combustible15SujetoADeriva).toBe(false);
  });

  it('el mismo CFDI pagado por transferencia (03) sigue acreditando completo — el arreglo no toca el medio SÍ admitido', () => {
    const g = diesel('g1', 86206.90);
    g.formaPago = '03';
    const opciones: OpcionesFiscales = { ...OPTS, combustibleEjercicio: { efectivo: 0, totalCombustible: 1000000 } };
    const r = resumirFiscal([g], opciones);
    expect(r.ivaAcreditable).toBeCloseTo(g.ivaTraslado!, 2);
    // RE-AUDITORÍA 25, FIS-REAUD-3: transferencia no pasa por el 15% en
    // absoluto (solo el efectivo/medio no admitido lo hace) — sin deriva.
    expect(r.combustible15SujetoADeriva).toBe(false);
  });
});

// ── RE-AUDITORÍA 25, FIS-REAUD-3 (ALTO) ─────────────────────────────────────
describe('FIS-REAUD-3 — el panel avisa cuándo su IVA acreditable depende del acumulado de HOY', () => {
  it('con excedente sobre el 15% (algo se niega Y algo se acredita vía la proporción), sigue habiendo deriva', () => {
    const g = diesel('g1', 86206.90); // IVA 13,793.10
    const opciones: OpcionesFiscales = {
      ...OPTS,
      // 15% de 1,000,000 = 150,000; efectivo acumulado 200,000 → excedente
      // 50,000 → proporción = 1 − 50,000/200,000 = 0.75 (no 0, no 1).
      combustibleEjercicio: { efectivo: 200000, totalCombustible: 1000000 },
    };
    const r = resumirFiscal([g], opciones);
    expect(r.ivaAcreditable).toBeGreaterThan(0);
    expect(r.ivaNoAcreditable).toBeGreaterThan(0);
    expect(r.combustible15SujetoADeriva).toBe(true);
  });

  it('un residuo de redondeo no cuenta como deriva', () => {
    // Proporción positiva pero ínfima (tope $1.50 contra $500,000 de
    // efectivo): el crédito por combustible15 redondea a $0.00 y no debe
    // encender la bandera (round2 > 0, no !== 0).
    const g = diesel('g1', 6250); // ivaTraslado = 1,000.00
    const opciones: OpcionesFiscales = {
      ...OPTS,
      combustibleEjercicio: { efectivo: 500000, totalCombustible: 10 },
    };
    const r = resumirFiscal([g], opciones);
    expect(r.combustible15SujetoADeriva).toBe(false);
  });

  it('sin ningún gasto de combustible en efectivo en el periodo, no hay deriva aunque el elegible15 esté declarado', () => {
    const g = diesel('g1', 1000);
    g.formaPago = '04'; // tarjeta de crédito — medio admitido, no toca el 15%
    const opciones: OpcionesFiscales = { ...OPTS, combustibleEjercicio: { efectivo: 200000, totalCombustible: 1000000 } };
    expect(resumirFiscal([g], opciones).combustible15SujetoADeriva).toBe(false);
  });
});
