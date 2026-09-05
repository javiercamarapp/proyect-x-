// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24 · FIS-A2 (ALTO, reincidente 23) y FIS-7 (MEDIO) — el panel del
// contador con la MISMA frontera de medio de pago que el motor, y con ojos
// para el complemento de pago.
//
// FIS-A2: «IEPS de diésel documentado» sumaba con `!== '01'`: entraban '06'
// (dinero electrónico, fuera de la lista) y '99' (no pagado). La ficha
// `normas/lif-2026-20-A.yaml` exige los medios de la LISR 27-III, lista
// CERRADA (`MEDIOS_LISR_27_III`), y `fiscal.ts` la tenía importada sin usarla.
//
// FIS-7: `ivaSostenible` negaba TODO '99', también el que su REP ya liquidó:
// «IVA acreditable documentado» $0 donde el PDF decía $8,000, mismo UUID.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import { resumirFiscal, resumirCombustibleCasetas, formaPagoEfectiva, type GastoFiscal, type OpcionesFiscales } from './fiscal';

const OPTS: OpcionesFiscales = {
  efectivoTopeMxn: 2000,
  clavesCombustible: ['15101505', '15101514', '15101515'],
  clavesDieselIeps: ['15101505'],
  viaticosTopeFiscalDiarioMxn: 750,
  elegible15: true,
};

function diesel(over: Partial<GastoFiscal> = {}): GastoFiscal {
  return {
    id: 'g1', viajeId: 'v1', concepto: 'diesel', monto: 11_600,
    fecha: '2026-07-15', folio: 'A1', rfcEmisor: 'AAA010101AAA',
    cfdiUuid: 'uuid-1', cfdiValido: null, estadoSat: 'vigente',
    efos: false, efosRevisar: null, formaPago: '03',
    subTotal: 10_000, ivaTraslado: 1600, iepsTraslado: 400,
    claveProdServ: '15101505', tipoComprobante: 'I', xmlVerificado: true,
    ocrConfianza: 0.9, viajeFolio: 'VJ-1', operadorNombre: 'Juan',
    plazoVencido: null, liquidacionFirmada: true,
    rfcReceptor: 'REC010101AA1', monedaExtranjera: false, renglonesAjenos: false,
    consumoBar: false, complementoHidrocarburosFalta: false, otroEjercicio: false,
    ...over,
  };
}

describe('FIS-A2: «IEPS de diésel documentado» usa la lista CERRADA de la LISR 27-III, con la forma efectiva', () => {
  it('«03» transferencia y «29» monedero suman', () => {
    expect(resumirFiscal([diesel({ formaPago: '03' })], OPTS).iepsDieselDocumentado).toBe(400);
    expect(resumirFiscal([diesel({ formaPago: '29' })], OPTS).iepsDieselDocumentado).toBe(400);
  });

  it('«06» dinero electrónico NO suma: no está en la lista (lo que rompía)', () => {
    expect(resumirFiscal([diesel({ formaPago: '06' })], OPTS).iepsDieselDocumentado).toBe(0);
  });

  it('«99» sin complemento de pago NO suma: no se ha pagado con ningún medio', () => {
    expect(resumirFiscal([diesel({ formaPago: '99' })], OPTS).iepsDieselDocumentado).toBe(0);
  });

  it('«99» + REP «03» SÍ suma; «99» + REP «01» no', () => {
    expect(resumirFiscal([diesel({ formaPago: '99', pagado: true, pagadoForma: '03' })], OPTS).iepsDieselDocumentado).toBe(400);
    expect(resumirFiscal([diesel({ formaPago: '99', pagado: true, pagadoForma: '01' })], OPTS).iepsDieselDocumentado).toBe(0);
  });

  it('«01» efectivo sigue fuera, y sin forma de pago no se afirma', () => {
    expect(resumirFiscal([diesel({ formaPago: '01' })], OPTS).iepsDieselDocumentado).toBe(0);
    expect(resumirFiscal([diesel({ formaPago: null })], OPTS).iepsDieselDocumentado).toBe(0);
  });

  it('pctElectronico tiene la misma frontera: «06» y «99» sin pagar no son «electrónico»', () => {
    const r = resumirCombustibleCasetas([diesel({ id: 'a', formaPago: '03' }), diesel({ id: 'b', formaPago: '06' }), diesel({ id: 'c', formaPago: '99' })]);
    expect(r.find((x) => x.concepto === 'diesel')!.pctElectronico).toBe(33);
  });
});

describe('FIS-7: el panel ve el complemento de pago', () => {
  it('«99» sin REP: IVA no sostenible (como antes)', () => {
    const r = resumirFiscal([diesel({ formaPago: '99' })], OPTS);
    expect(r.ivaAcreditable).toBe(0);
    expect(r.ivaNoAcreditable).toBe(1600);
  });

  it('«99» + REP que dice «03»: el IVA se sostiene — la misma cifra que el PDF', () => {
    const r = resumirFiscal([diesel({ formaPago: '99', pagado: true, pagadoForma: '03' })], OPTS);
    expect(r.ivaAcreditable).toBe(1600);
  });

  it('«99» + REP «01» sobre el tope en hospedaje: efectivo, no deducible, sin IVA (FIS-5 en el panel)', () => {
    const h = diesel({ concepto: 'hospedaje', claveProdServ: null, iepsTraslado: null, formaPago: '99', pagado: true, pagadoForma: '01' });
    expect(resumirFiscal([h], OPTS).ivaAcreditable).toBe(0);
  });

  it('`pagado` ausente (base anterior a la 0282) se lee como NO pagado: el lado conservador', () => {
    expect(formaPagoEfectiva({ formaPago: '99' })).toBeNull();
    expect(formaPagoEfectiva({ formaPago: '99', pagado: null, pagadoForma: '03' })).toBeNull();
    expect(formaPagoEfectiva({ formaPago: '99', pagado: true, pagadoForma: '03' })).toBe('03');
    expect(formaPagoEfectiva({ formaPago: '04' })).toBe('04');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24 · FE-8 (ALTO) — «Litros elegibles para el estímulo» se medía
// con dos ventanas distintas en dos pantallas bajo la misma cita legal.
// ═══════════════════════════════════════════════════════════════════════════
import { ventanaLitrosElegibles } from './fiscal';

describe('FE-8: la ventana de los litros elegibles es UNA, y va en el rótulo', () => {
  it('es el EJERCICIO en curso, no el histórico', () => {
    const v = ventanaLitrosElegibles('2026-08-24');
    expect(v.periodo.clave).toBe('ejercicio');
    expect(v.periodo.desde).toBe('2026-01-01');
    // 31+28+31+30+31+30+31+24 = 236 días, con hoy dentro (lo que `corteVentana`
    // cuenta): del 1-ene al 24-ago inclusive.
    expect(v.dias).toBe(236);
  });

  it('el primer día del ejercicio la ventana es de UN día, nunca de cero', () => {
    // Con `dias = 0`, `corteVentana` devuelve null y la cifra saltaría al
    // histórico completo justo el 1 de enero — el modo de falla del hallazgo.
    const v = ventanaLitrosElegibles('2026-01-01');
    expect(v.dias).toBe(1);
  });

  it('el rótulo dice el periodo: sin eso son dos cifras bajo la misma cita', () => {
    const v = ventanaLitrosElegibles('2026-08-24');
    expect(v.rotulo).toBe('Litros elegibles para el estímulo');
    expect(v.nota).toContain('LIF 2026, Art. 20-A');
    expect(v.nota).toContain('ejercicio 2026');
    expect(v.nota).toContain('2026-01-01');
  });
});
