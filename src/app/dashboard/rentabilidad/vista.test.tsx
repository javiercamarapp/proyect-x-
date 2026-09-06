import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { VistaRentabilidad } from './vista';
import type { Cobranza, Rentabilidad } from '@/lib/likida/comercial';

// RUBRO 4 (honestidad de datos en UI), semana 36 — la cartera se pagina
// (mig. 0152, `getCobranza`), pero el gate del vacío mira la página que
// llegó (`cobranza.facturas.length === 0`) en vez de si la cartera tiene
// algo de verdad (`cobranza.total === 0`). Un contralor que teclee `?p=99`
// sobre una cartera con 350 facturas ve "Aún no hay facturas emitidas
// registradas" — la afirmación que la propia pantalla se prohíbe hacer sin
// que sea cierta (comentario de cabecera, vista.tsx:23-28).
const RENTABILIDAD: Rentabilidad = {
  ingreso: 500_000, costoComprobado: 300_000, contribucion: 200_000,
  margenPct: 40, viajesConIngreso: 10, viajesSinIngreso: 0,
};

function cobranza(parcial: Partial<Cobranza>): Cobranza {
  return {
    facturas: [], total: 0, pagina: 1, porPagina: 100,
    porCobrar: 0, vencido: 0, sinCondiciones: 0,
    ...parcial,
  };
}

describe('VistaRentabilidad — la cartera paginada no se confunde con una cartera vacía', () => {
  it('página fuera de rango (?p=99) sobre 350 facturas: NO dice "aún no hay facturas" y sigue mostrando lo por cobrar', () => {
    const html = renderToStaticMarkup(
      <VistaRentabilidad rentabilidad={RENTABILIDAD}
        cobranza={cobranza({ facturas: [], total: 350, pagina: 99, porCobrar: 480_000, vencido: 120_000 })} />,
    );
    expect(html).not.toMatch(/Aún no hay facturas emitidas registradas/);
    // Las cifras de la cartera COMPLETA (no de la página) son reales y no
    // dependen de qué página se pidió: deben seguir en pantalla.
    expect(html).toMatch(/Por cobrar/);
    expect(html).toMatch(/350/);
  });

  it('cartera de verdad vacía (total=0) sigue diciendo "aún no hay facturas"', () => {
    const html = renderToStaticMarkup(
      <VistaRentabilidad rentabilidad={RENTABILIDAD} cobranza={cobranza({ total: 0 })} />,
    );
    expect(html).toMatch(/Aún no hay facturas emitidas registradas/);
  });

  it('primera página con facturas reales: se ve la tabla, no el vacío ni el mensaje de página fuera de rango', () => {
    const html = renderToStaticMarkup(
      <VistaRentabilidad rentabilidad={RENTABILIDAD}
        cobranza={cobranza({
          total: 1,
          facturas: [{
            id: 'f-1', folio: 'A-1', cliente: 'Cliente X', fecha: '2026-08-01',
            total: 1000, pagado: 0, saldo: 1000, estatus: 'vigente', venceEn: null, vencida: false,
          }],
        })}
      />,
    );
    expect(html).not.toMatch(/Aún no hay facturas emitidas registradas/);
    expect(html).toMatch(/Cliente X/);
  });
});
