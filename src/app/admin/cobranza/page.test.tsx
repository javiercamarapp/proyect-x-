import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/cobranza — página 100% estática (sin props, sin datos, sin server
// actions; la puerta es sólo la del layout de /admin). Su único contrato es
// de contenido: NO debe fingir que existe dunning automático ni una tabla de
// facturación que ya vive en otro lado — y debe seguir enlazando a donde la
// operación real ocurre.
// ═══════════════════════════════════════════════════════════════════════════

import CobranzaPage from './page';

it('dice la verdad: no hay dunning automático, y manda a Costos & Facturación (donde SÍ se cobra)', () => {
  const html = renderToStaticMarkup(CobranzaPage());
  expect(html).toContain('no</span> tiene es dunning automático');
  expect(html).toContain('href="/admin/costos-facturacion"');
});
