import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/comunicacion — CERO cobertura. Página síncrona, sin datos ni server
// actions, gateada sólo por admin/layout.tsx. Su único contrato real es el
// rótulo honesto: NO existe broadcast interno hoy, y no debe confundirse con
// el estudio de marketing (crecimiento hacia afuera), que es un dominio
// distinto.
// ═══════════════════════════════════════════════════════════════════════════

import ComunicacionPage from './page';

it('declara honestamente que no hay sistema de comunicación masiva interna', () => {
  const html = renderToStaticMarkup(ComunicacionPage());
  expect(html).toContain('Likida no tiene un sistema de comunicación masiva INTERNA hoy');
  expect(html).toContain('bot de WhatsApp conversando 1 a 1');
});

it('distingue este dominio del estudio de marketing (crecimiento hacia afuera), con su liga', () => {
  const html = renderToStaticMarkup(ComunicacionPage());
  expect(html).toContain('href="/admin/marketing"');
  expect(html).toContain('un dominio distinto');
});
