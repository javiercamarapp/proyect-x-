import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DetalleLiquidacion, type PropsDetalle } from './detalle';
import { LEYENDA_PAGO_PENDIENTE } from '@/lib/likida/cuadre/engine';
import type { LiquidacionDetalle } from '@/lib/likida/analytics';

// ═══════════════════════════════════════════════════════════════════════════
// L07 (BE-A1/BE-M1/FE-M2) — `detalle.tsx` llamaba `filasDeducibilidad` SIN
// `gastos`. La función degrada bien sin ellos (no truena), pero pierde la
// única razón por la que "Por confirmar" puede decir ALGO más específico que
// "falta timbrar la factura": un comprobante a CRÉDITO (forma de pago '99')
// sin complemento de pago (REP). El PDF SÍ trae `gastos` (`filasDeducibilidad(liq)`
// con el objeto completo) y por eso ya imprimía la razón correcta — el panel
// imprimía otra. Dos papeles, dos razones distintas para el MISMO
// comprobante: exactamente lo que el motor documenta que no debe pasar.
// ═══════════════════════════════════════════════════════════════════════════

const D_BASE: LiquidacionDetalle = {
  id: 'liq-1', viajeId: 'viaje-1', folio: 'V-1041', estatus: 'cuadrada',
  operadorId: 'op-1', operadorNombre: 'Juan Pérez',
  creadoEn: '2026-08-25T18:00:00+00:00',
  totalComprobado: 1500, totalAnticipo: 1500, diferencia: 0,
  ieps: 0, litrosDiesel: 0, iva: 0, peaje: 0,
  diferencias: [],
  gastos: [
    // Único gasto: a crédito (forma de pago '99') y sin `pagadoEn` — el caso
    // que `pagoPendiente()` (cuadre/engine.ts) reconoce como pendiente.
    { id: 'g-1', concepto: 'factura', monto: 1500, formaPago: '99' },
  ],
  viaje: {
    origen: null, destino: null, fechaInicio: null, creadoEn: null,
    unidadEco: null, unidadPlacas: null, clienteNombre: null, operadorTelefono: null,
    avisadoEn: null, aceptadoEn: null, llegadaEn: null, descargaEn: null, regresoEn: null,
  },
  comprobantesEntre: { primero: null, ultimo: null, n: 1 },
  comprobantesExcluidos: 0,
  comprobantesCuadran: true,
  // Todo por confirmar: la única cubeta que trae el pie sensible a `gastos`.
  deducibilidad: { totalDeducible: 0, totalNoDeducible: 0, totalPorConfirmar: 1500 },
  laboral: null,
  pdfPath: null,
};

const PROPS_BASE: Omit<PropsDetalle, 'd'> = {
  sufijo: '', estatus: { label: 'Cuadrada', estado: 'ok' },
  etiqueta: (g) => g.concepto,
  pdfHref: null, wa: null, reasignar: null, reabrir: null, revision: null,
};

describe('DetalleLiquidacion — filasDeducibilidad recibe `gastos` (L07)', () => {
  it('un crédito (forma de pago 99) sin REP: el pie dice LA MISMA razón que el PDF', () => {
    const html = renderToStaticMarkup(<DetalleLiquidacion {...PROPS_BASE} d={D_BASE} />);
    // La leyenda es literal —el MISMO string que `pdf.ts` imprime, importado
    // de la misma constante— así que si aparece aquí es la misma razón, no
    // una redacción parecida.
    expect(html).toContain(LEYENDA_PAGO_PENDIENTE.slice(0, 40));
    expect(html).toContain('A crédito (forma de pago 99)');
  });

  it('sin el gasto (mismo total, cubeta idéntica) el pie cae a la razón genérica: la diferencia SÍ es `gastos`', () => {
    const sinGastos: LiquidacionDetalle = { ...D_BASE, gastos: [] };
    const html = renderToStaticMarkup(<DetalleLiquidacion {...PROPS_BASE} d={sinGastos} />);
    expect(html).not.toContain('A crédito (forma de pago 99)');
    expect(html).toContain('Falta timbrar la factura o acreditar el medio de pago');
  });

  it('el mismo gasto ya PAGADO (pagadoEn) no es pendiente: no imprime la leyenda de crédito', () => {
    const pagado: LiquidacionDetalle = {
      ...D_BASE,
      gastos: [{ id: 'g-1', concepto: 'factura', monto: 1500, formaPago: '99', pagadoEn: '2026-08-26T10:00:00+00:00' }],
    };
    const html = renderToStaticMarkup(<DetalleLiquidacion {...PROPS_BASE} d={pagado} />);
    expect(html).not.toContain('A crédito (forma de pago 99)');
  });
});
