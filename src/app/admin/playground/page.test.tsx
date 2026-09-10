import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/playground — página 100% estática. Su contrato: NO debe simular un
// chat/caja de prueba que aparente funcionar sin hacerlo (comentario propio
// del archivo) — debe seguir diciendo honestamente que el sandbox no existe
// y enlazar a las páginas de agente reales.
// ═══════════════════════════════════════════════════════════════════════════

import PlaygroundPage from './page';

it('dice honestamente que el sandbox no existe, y no simula un chat/caja de prueba', () => {
  const html = renderToStaticMarkup(PlaygroundPage());
  expect(html).toContain('Esta función no existe en Likida hoy');
  expect(html).not.toMatch(/<textarea|<input[^>]*type="text"/);
});

it('enlaza a las tres páginas de agente reales que SÍ existen', () => {
  const html = renderToStaticMarkup(PlaygroundPage());
  expect(html).toContain('href="/admin/agente-ocr"');
  expect(html).toContain('href="/admin/agente-cuadre"');
  expect(html).toContain('href="/admin/agente-whatsapp"');
});
