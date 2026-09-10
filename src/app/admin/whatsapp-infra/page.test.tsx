import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/whatsapp-infra — CERO cobertura. Sólo lectura, CRUZADA de TODOS los
// tenants a propósito (es la consola de superadmin viendo TODAS las
// conversaciones de WhatsApp de TODAS las flotas — dato real y sensible).
// FE-9 (ya corregido, se vigila que no regrese): el KPI de "conversaciones
// activas" es el CONTEO real, nunca el tamaño de la página topada.
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({ getConversacionesActivas: vi.fn(), contarConversacionesActivas: vi.fn() }));
vi.mock('@/lib/admin/negocio', async (importar) => ({
  ...(await importar<typeof import('@/lib/admin/negocio')>()),
  getConversacionesActivas: dobles.getConversacionesActivas,
  contarConversacionesActivas: dobles.contarConversacionesActivas,
}));

import { TOPE_CONVERSACIONES } from '@/lib/admin/negocio';
import WhatsappInfraPage from './page';

async function renderizar() { return renderToStaticMarkup(await WhatsappInfraPage()); }
const CONV = (over: Partial<{ tenantId: string | null; tenantNombre: string; telefono: string; turns: { role: string; content: string }[] }>) => ({
  tenantId: 't-1', tenantNombre: 'Flota X', telefono: '5219990001111', turns: [], ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  dobles.getConversacionesActivas.mockResolvedValue([]);
  dobles.contarConversacionesActivas.mockResolvedValue(0);
});

it('FE-9: el KPI de conversaciones activas es el CONTEO real, no el tamaño de la página topada', async () => {
  dobles.getConversacionesActivas.mockResolvedValue(Array.from({ length: TOPE_CONVERSACIONES }, (_, i) => CONV({ telefono: `t${i}` })));
  dobles.contarConversacionesActivas.mockResolvedValue(347);
  const html = await renderizar();
  expect(html).toContain('347');
  expect(html).not.toContain(`las ${TOPE_CONVERSACIONES} más recientes de ${TOPE_CONVERSACIONES}`);
  expect(html).toContain(`las ${TOPE_CONVERSACIONES} más recientes de 347`);
});

it('un conteo que no se pudo leer dice "no se pudo contar" — nunca un cero que parezca medición', async () => {
  dobles.contarConversacionesActivas.mockResolvedValue(null);
  const html = await renderizar();
  expect(html).toContain('no se pudo contar');
});

it('sin recorte (todo cabe en la página), no promete "las N más recientes de N" — sólo dice "Conversaciones"', async () => {
  dobles.getConversacionesActivas.mockResolvedValue([CONV({})]);
  dobles.contarConversacionesActivas.mockResolvedValue(1);
  const html = await renderizar();
  expect(html).not.toContain('más recientes de');
});

it('cero conversaciones DE VERDAD dice "sin conversaciones activas"', async () => {
  const html = await renderizar();
  expect(html).toContain('Sin conversaciones activas');
});

it('cruza TODOS los tenants a propósito: sin argumento de tenant en ninguna de las dos llamadas', async () => {
  await renderizar();
  expect(dobles.getConversacionesActivas).toHaveBeenCalledWith();
  expect(dobles.contarConversacionesActivas).toHaveBeenCalledWith();
});

it('el número real de WhatsApp no se inventa — el texto describe la config de Meta, no un dígito de ejemplo', async () => {
  const html = await renderizar();
  expect(html).toContain('no vive en este código');
  expect(html).not.toMatch(/\+?52\s?1?\s?\d{10}/); // ningún número de 10 dígitos hardcodeado en el HTML
});

it('declara honestamente lo fuera de alcance — no aparenta pool de números ni quality rating', async () => {
  const html = await renderizar();
  expect(html).toContain('Pool de números con rotación/balanceo');
  expect(html).toContain('Quality rating por número');
});
