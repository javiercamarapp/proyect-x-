import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/conversaciones — CERO cobertura de la PÁGINA. Sin server actions
// (búsqueda por GET simple) y sin puerta propia — requireSuperadmin() vive en
// el layout de /admin, no aquí. Lo que sí es real y propio de esta página:
// FE-9 (el tope de 20 no puede disfrazarse de total) y ADM-1 (con `?q=` se
// cambia a búsqueda paginada por teléfono en vez de la vista de recientes).
// getConversacionesActivas/contarConversacionesActivas/buscarConversaciones
// ya tienen prueba en src/lib/admin/negocio.test.ts.
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({
  getConversacionesActivas: vi.fn(),
  contarConversacionesActivas: vi.fn(),
  buscarConversaciones: vi.fn(),
}));

vi.mock('@/lib/admin/negocio', async (importar) => ({
  ...(await importar<typeof import('@/lib/admin/negocio')>()),
  getConversacionesActivas: dobles.getConversacionesActivas,
  contarConversacionesActivas: dobles.contarConversacionesActivas,
  buscarConversaciones: dobles.buscarConversaciones,
}));

import ConversacionesPage from './page';

async function renderizar(sp: { q?: string; p?: string } = {}) {
  return renderToStaticMarkup(await ConversacionesPage({ searchParams: Promise.resolve(sp) }));
}
const CONV = { telefono: '5219991234567', tenantId: 't-1', tenantNombre: 'Transportes Uno', turns: [{ role: 'user' as const, content: 'hola' }], actualizadaEn: '2026-01-01T00:00:00Z' };

beforeEach(() => {
  vi.clearAllMocks();
  dobles.getConversacionesActivas.mockResolvedValue([]);
  dobles.contarConversacionesActivas.mockResolvedValue(0);
  dobles.buscarConversaciones.mockResolvedValue({ filas: [], pagina: 1, paginas: 1, total: 0 });
});

it('sin `?q=`, lee las activas y el conteo real por separado (FE-9)', async () => {
  await renderizar();
  expect(dobles.getConversacionesActivas).toHaveBeenCalled();
  expect(dobles.contarConversacionesActivas).toHaveBeenCalled();
  expect(dobles.buscarConversaciones).not.toHaveBeenCalled();
});

it('un conteo real MAYOR al tope se declara como recorte contra el total — nunca se presenta el tope como si fuera todo', async () => {
  dobles.getConversacionesActivas.mockResolvedValue([CONV]);
  dobles.contarConversacionesActivas.mockResolvedValue(4000);
  const html = await renderizar();
  expect(html).toContain('Las 20 más recientes de 4000');
  expect(html).not.toContain('Todas las conversaciones');
});

it('conteo que NO se pudo leer (null) nunca se confunde con cero — no dice "no está hablando con nadie"', async () => {
  dobles.contarConversacionesActivas.mockResolvedValue(null);
  const html = await renderizar();
  expect(html).toContain('No se pudo contar');
  expect(html).not.toContain('Conversaciones activas: 0');
});

it('sin recorte (conteo <= tope) dice "Todas las conversaciones"', async () => {
  dobles.getConversacionesActivas.mockResolvedValue([CONV]);
  dobles.contarConversacionesActivas.mockResolvedValue(1);
  const html = await renderizar();
  expect(html).toContain('Todas las conversaciones');
});

it('cero conversaciones DE VERDAD dice "Sin conversaciones activas"', async () => {
  const html = await renderizar();
  expect(html).toContain('Sin conversaciones activas');
});

it('el ranking de mensajes por conversación sólo aparece con 2+ conversaciones (una barra no compara nada)', async () => {
  dobles.getConversacionesActivas.mockResolvedValue([CONV]);
  dobles.contarConversacionesActivas.mockResolvedValue(1);
  const htmlUna = await renderizar();
  expect(htmlUna).not.toContain('Mensajes por conversación');

  dobles.getConversacionesActivas.mockResolvedValue([CONV, { ...CONV, telefono: '5219990000000' }]);
  dobles.contarConversacionesActivas.mockResolvedValue(2);
  const htmlDos = await renderizar();
  expect(htmlDos).toContain('Mensajes por conversación');
});

it('con `?q=`, busca por teléfono (paginado) en vez de leer las activas', async () => {
  dobles.buscarConversaciones.mockResolvedValue({ filas: [CONV], pagina: 1, paginas: 1, total: 1 });
  await renderizar({ q: '5219991234567' });
  expect(dobles.buscarConversaciones).toHaveBeenCalledWith({ q: '5219991234567', pagina: 1 });
  expect(dobles.getConversacionesActivas).not.toHaveBeenCalled();
});

it('una búsqueda sin resultados dice explícitamente que ese teléfono no aparece, no una lista vacía muda', async () => {
  const html = await renderizar({ q: '0000000000' });
  expect(html).toContain('Ningún teléfono contiene');
  expect(html).toContain('0000000000');
});

it('la página pedida (?p=) viaja a buscarConversaciones; una página inválida cae a 1', async () => {
  dobles.buscarConversaciones.mockResolvedValue({ filas: [CONV], pagina: 3, paginas: 5, total: 100 });
  await renderizar({ q: '999', p: '3' });
  expect(dobles.buscarConversaciones).toHaveBeenCalledWith({ q: '999', pagina: 3 });

  await renderizar({ q: '999', p: 'no-es-numero' });
  expect(dobles.buscarConversaciones).toHaveBeenLastCalledWith({ q: '999', pagina: 1 });
});
