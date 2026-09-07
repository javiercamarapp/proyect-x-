import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { VistaRentabilidad } from './vista';
import type { Cobranza, Rentabilidad } from '@/lib/likida/comercial';
import { mxn } from '@/lib/formato';

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

  // PRU-M1 (auditoría 28) — la prueba de arriba es CIEGA a la cifra: `/350/`
  // y `/Por cobrar/` se satisfacen con solo la ETIQUETA o con el renglón de
  // paginación, así que R2, R3 y R5 (auditoría de mutación, pruebas.md
  // «Mutaciones») siguen vivas con la suite en verde. Aquí se afirma el
  // mensaje EXACTO (mata R2 y R3, que cambian la condición o cambian
  // `cobranza.total` por `facturas.length` en ese mismo texto) y la cifra
  // FORMATEADA de verdad, no solo su etiqueta (mata R5, que sustituye
  // `cobranza.porCobrar`/`vencido` por `0` sin que ninguna aserción note la
  // diferencia).
  it('página fuera de rango: el texto exacto nombra la cartera completa (350), no la página vacía (mata R2/R3)', () => {
    const html = renderToStaticMarkup(
      <VistaRentabilidad rentabilidad={RENTABILIDAD}
        cobranza={cobranza({ facturas: [], total: 350, pagina: 99, porCobrar: 480_000, vencido: 120_000 })} />,
    );
    expect(html).toContain('Esta página no tiene facturas — hay 350 en la cartera completa.');
    // Ni la tabla vacía ni sus encabezados: el modo de falla que R2 reintroduce
    // es exactamente "página sin filas ⇒ se pinta la tabla con `<tbody>` vacío".
    expect(html).not.toContain('<tbody>');
    expect(html).not.toContain('<th class="px-3 py-2 font-medium">Folio</th>');
  });

  it('página fuera de rango: "Por cobrar" y "Vencido" muestran la cifra REAL formateada, no un $0.00 (mata R5)', () => {
    const html = renderToStaticMarkup(
      <VistaRentabilidad rentabilidad={RENTABILIDAD}
        cobranza={cobranza({ facturas: [], total: 350, pagina: 99, porCobrar: 480_000, vencido: 120_000 })} />,
    );
    expect(html).toContain(mxn(480_000));
    expect(html).toContain(mxn(120_000));
    expect(html).not.toMatch(/\$0\.00/);
  });

  // AUD28 FE-2 — la regresión que destapó `4de95a0`. Antes de ese commit el
  // `EstadoVacio` sustituía la sección entera, así que el renglón de
  // paginación era inalcanzable con `?p=` fuera de rango. Ahora se pinta, y
  // `hasta` no tiene el mismo portón que `desde`: `(99−1)·100 + 0 = 9800`
  // imprime "Facturas 0–9,800 de 350" — un rango inventado, sobre una
  // pantalla cuya regla es no inventar cifras. El comentario de vista.tsx:40-42
  // ya dice que debe decir "0–0 de N"; esto es lo que lo mide.
  it('página fuera de rango: el renglón dice "0–0 de 350", no un rango inventado mayor que la cartera', () => {
    const html = renderToStaticMarkup(
      <VistaRentabilidad rentabilidad={RENTABILIDAD}
        cobranza={cobranza({ facturas: [], total: 350, pagina: 99, porCobrar: 480_000, vencido: 120_000 })} />,
    );
    expect(html).toMatch(/Facturas 0–0 de 350/);
    expect(html).not.toMatch(/9,800/);
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
    // Presencia real de la fila (folio y saldo), no solo del nombre del
    // cliente, y el renglón de paginación con el rango correcto (mata la
    // familia de R2/R3: una página con filas reales nunca debe mostrar el
    // aviso "esta página no tiene facturas").
    expect(html).toContain('A-1');
    expect(html).toContain(mxn(1000));
    expect(html).not.toContain('Esta página no tiene facturas');
    expect(html).toMatch(/Facturas 1–1 de 1/);
  });
});
