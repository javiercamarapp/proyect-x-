// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 18-c3 · FISC-C3-2 (CRÍTICO) — el panel del contador acreditaba el
// IVA de un CFDI que el motor ya rechazaba.
//
// `59c02ec` («fix(A2-fiscal CRÍTICO): el IVA acreditable exige pago efectivo,
// LIVA 5-III») puso el candado en `engine.ts:1116` y NO en el segundo
// consumidor del mismo criterio: `ivaSostenible` (`fiscal.ts`), que es lo que
// alimenta «IVA acreditable documentado» en `/dashboard/contador`.
//
// El resultado era la falla que `CLAUDE.md` nombra por escrito: «una cifra
// fiscal que se lee distinto en dos pantallas se lee como dos cálculos». Un
// CFDI PPD de refacciones ($50,000 + $8,000 de IVA, `FormaPago '99'`) daba
// $8,000 en el panel y $0.00 en el PDF de la misma operación. De los dos, el
// que se teclea en la declaración mensual es el del panel.
//
// LIVA 5-III exige que el impuesto esté «efectivamente pagado en el mes».
// `'99' Por definir` = la contraprestación NO se ha pagado (RMF 2.7.1.29
// fr. II). Se acreditará el mes en que se pague, con su complemento de pago.
//
// Se prueba contra `resumirFiscal` REAL, afirmando `ivaAcreditable` como
// SALIDA, y contra `cuadrarViaje` REAL en el mismo caso: la prueba que importa
// es que las DOS pantallas digan lo mismo.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { resumirFiscal, type GastoFiscal, type OpcionesFiscales } from './fiscal';
import { cuadrarViaje, type PoliticaGasto } from './cuadre/engine';
import type { Gasto } from '@/types/likida';

const OPTS: OpcionesFiscales = {
  efectivoTopeMxn: 2000,
  clavesCombustible: ['15101505'],
  clavesDieselIeps: ['15101505'],
  viaticosTopeFiscalDiarioMxn: 750,
  elegible15: true,
};

/** Un gasto 'otro' con CFDI vigente e IVA de $8,000. Solo cambia la forma de pago. */
function refaccion(formaPago: string | null): GastoFiscal {
  return {
    id: 'g1', viajeId: 'v1', concepto: 'otro', monto: 58000,
    fecha: '2026-08-10', folio: 'R-1', rfcEmisor: 'AAA010101AAA',
    cfdiUuid: 'uuid-ppd-1', cfdiValido: true, estadoSat: 'vigente',
    efos: false, efosRevisar: null, formaPago,
    subTotal: 50000, ivaTraslado: 8000, iepsTraslado: null,
    claveProdServ: null, tipoComprobante: 'I', xmlVerificado: true,
    ocrConfianza: 0.95, viajeFolio: 'VJ-1', operadorNombre: 'Juan',
    plazoVencido: null, liquidacionFirmada: true,
    rfcReceptor: 'REC010101AA1', monedaExtranjera: false, renglonesAjenos: false,
    consumoBar: false, complementoHidrocarburosFalta: false, otroEjercicio: false,
  };
}

const politica: PoliticaGasto[] = [{ concepto: 'otro', topeMonto: 100000 }];
const EST = { peajeFactor: 0.5, viaticosTopeFiscalDiarioMxn: 750, efectivoTopeMxn: 2000, clavesDieselIeps: [] };

/** El MISMO comprobante, visto por el motor que arma el PDF. */
function refaccionMotor(formaPago: string): Gasto {
  return {
    id: 'g1', concepto: 'otro', monto: 58000, subTotal: 50000, folio: 'R-1',
    fecha: '2026-08-10', ocrConfianza: 0.95, cfdiUuid: 'uuid-ppd-1',
    xmlVerificado: true, rfcReceptor: 'REC010101AA1', tipoComprobante: 'I',
    ivaTraslado: 8000, formaPago,
  };
}

describe('FISC-C3-2 · el panel del contador y el motor acreditan el MISMO IVA', () => {
  it('CFDI PPD (forma de pago 99, no pagado) → el panel NO acredita los $8,000', () => {
    // Sin el arreglo esto devuelve 8000: `ivaSostenible` no miraba '99'.
    expect(resumirFiscal([refaccion('99')], OPTS).ivaAcreditable).toBe(0);
  });

  it('y el MOTOR dice lo mismo sobre el mismo comprobante — una sola cifra, no dos', () => {
    const panel = resumirFiscal([refaccion('99')], OPTS).ivaAcreditable;
    const motor = cuadrarViaje({
      viajeId: 'v1', anticipo: 58000, politica, estimulos: EST,
      gastos: [refaccionMotor('99')],
    }).ivaAcreditable;
    expect(panel).toBe(motor);
    expect(panel).toBe(0);
  });

  it('el mismo CFDI pagado por transferencia (03) SÍ acredita, en las dos pantallas', () => {
    const panel = resumirFiscal([refaccion('03')], OPTS).ivaAcreditable;
    const motor = cuadrarViaje({
      viajeId: 'v1', anticipo: 58000, politica, estimulos: EST,
      gastos: [refaccionMotor('03')],
    }).ivaAcreditable;
    expect(panel).toBe(8000);
    expect(motor).toBe(8000);
  });

  it('sin forma de pago NO se supone impago: la columna desconocida no niega el IVA', () => {
    // Mismo criterio que el resto del módulo: un comprobante sin `forma_pago`
    // no es efectivo ni impago, es desconocido. Negarlo inflaría el «perdido»
    // contra la flota con una suposición.
    expect(resumirFiscal([refaccion(null)], OPTS).ivaAcreditable).toBe(8000);
  });
});
