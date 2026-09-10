import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/conocimiento-rag — CERO cobertura. Página síncrona, sin datos ni
// server actions. Su contrato: declara honestamente que Likida NO tiene RAG
// hoy — nada de widgets que aparenten una feature inexistente.
// ═══════════════════════════════════════════════════════════════════════════

import ConocimientoRagPage from './page';

it('declara honestamente que Likida no usa RAG hoy, sin aparentar la feature', () => {
  const html = renderToStaticMarkup(ConocimientoRagPage());
  expect(html).toContain('Likida no usa RAG');
  expect(html).toContain('no sobre una base de conocimiento documental');
});

it('no hay widgets que aparenten la feature (ni carga de documentos, ni probador de RAG)', () => {
  const html = renderToStaticMarkup(ConocimientoRagPage());
  expect(html).toContain('ni carga de documentos');
  expect(html).toContain('probador de RAG');
});
