import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/agente-whatsapp — CERO cobertura. Sin server actions, gate en
// admin/layout.tsx. Real a vigilar: cero gasto/llamadas cuando no hay fase
// 'whatsapp' es un CERO MEDIDO, no un relleno; el recorte de
// TOPE_CONVERSACIONES se declara contra el total real (FE-9); "sin
// conversaciones activas" sólo aparece con la lista de verdad vacía.
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({
  getResumenNegocio: vi.fn(),
  getConversacionesActivas: vi.fn(),
  contarConversacionesActivas: vi.fn(),
}));

vi.mock('@/lib/admin/negocio', async (importar) => ({
  ...(await importar<typeof import('@/lib/admin/negocio')>()),
  getResumenNegocio: dobles.getResumenNegocio,
  getConversacionesActivas: dobles.getConversacionesActivas,
  contarConversacionesActivas: dobles.contarConversacionesActivas,
}));

import { TOPE_CONVERSACIONES } from '@/lib/admin/negocio';
import AgenteWhatsappPage from './page';

const RESUMEN_SIN_WA = { porFase: [{ fase: 'ocr', n: 10, costoUsd: 5 }] };

beforeEach(() => {
  vi.clearAllMocks();
  dobles.getResumenNegocio.mockResolvedValue(RESUMEN_SIN_WA);
  dobles.getConversacionesActivas.mockResolvedValue([]);
  dobles.contarConversacionesActivas.mockResolvedValue(0);
});

async function renderizar() { return renderToStaticMarkup(await AgenteWhatsappPage()); }

it('sin fase "whatsapp" en llm_costo: gasto y llamadas son CERO medido, no un fallo silencioso', async () => {
  const html = await renderizar();
  expect(html).toContain('US$0.00');
  expect(html).toContain('Gastado en WhatsApp');
});

it('con fase "whatsapp" real: usa esas cifras exactas, no las de otra fase', async () => {
  dobles.getResumenNegocio.mockResolvedValue({ porFase: [{ fase: 'whatsapp', n: 42, costoUsd: 7.5 }, { fase: 'ocr', n: 999, costoUsd: 999 }] });
  const html = await renderizar();
  expect(html).toContain('US$7.50');
  expect(html).not.toContain('999');
});

it(`con más conversaciones de las que se listan (recorte de ${TOPE_CONVERSACIONES}, FE-9), lo dice contra el TOTAL real`, async () => {
  dobles.getConversacionesActivas.mockResolvedValue([{ tenantId: 't-1', tenantNombre: 'ACME', telefono: '5219991234567', turns: [] }]);
  dobles.contarConversacionesActivas.mockResolvedValue(30);
  const html = await renderizar();
  expect(html).toContain(`las ${TOPE_CONVERSACIONES} más recientes de 30`);
});

it('sin recorte, título simple "Conversaciones activas"', async () => {
  dobles.getConversacionesActivas.mockResolvedValue([{ tenantId: 't-1', tenantNombre: 'ACME', telefono: '5219991234567', turns: [] }]);
  dobles.contarConversacionesActivas.mockResolvedValue(1);
  const html = await renderizar();
  expect(html).toContain('>Conversaciones activas<');
});

it('cero conversaciones DE VERDAD sí dice "Sin conversaciones activas"', async () => {
  const html = await renderizar();
  expect(html).toContain('Sin conversaciones activas');
});

it('declara honestamente qué falta (entrega, ventana 24h, opt-ins) — no lo simula', async () => {
  const html = await renderizar();
  expect(html).toContain('requiere integrar la Meta WhatsApp Business API');
});
