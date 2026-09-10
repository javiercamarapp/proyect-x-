import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/escalaciones — CERO cobertura. Puerta en el layout de /admin, no
// aquí. getBandejaEscalaciones ya tiene prueba propia (escalaciones.test.ts).
// Lo que se vigila aquí es el patrón "items === null ⟺ error !== null" (una
// fuente caída se DICE, nunca se colapsa a cero) y el fix ADM-4 (auditoría
// 24): las tarjetas de conteo usan el total REAL de cada fuente, no el
// tamaño de una lista topada.
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({ getBandejaEscalaciones: vi.fn() }));
vi.mock('@/lib/admin/escalaciones', async (importar) => ({
  ...(await importar<typeof import('@/lib/admin/escalaciones')>()),
  getBandejaEscalaciones: dobles.getBandejaEscalaciones,
}));

import type { BandejaEscalaciones, FuenteEscalacion } from '@/lib/admin/escalaciones';
import EscalacionesPage from './page';
async function renderizar() { return renderToStaticMarkup(await EscalacionesPage()); }

const FUENTES: FuenteEscalacion[] = ['arco', 'corridas', 'talachas', 'facturas_proveedor', 'tickets', 'liquidaciones'];
function bandejaVacia(): BandejaEscalaciones {
  const fuentes = {} as BandejaEscalaciones['fuentes'];
  for (const f of FUENTES) fuentes[f] = { items: [], error: null };
  return {
    fuentes, cola: [],
    conteos: { arco: 0, corridasFallo: 0, talachas: 0, facturasProveedor: 0, ticketsAbiertos: 0, ticketsVencidos: 0, liquidacionesRevisar: 0 },
  };
}

beforeEach(() => { vi.clearAllMocks(); });

it('las seis fuentes leídas y sin nada pendiente: dice "la cola está vacía de verdad"', async () => {
  dobles.getBandejaEscalaciones.mockResolvedValue(bandejaVacia());
  const html = await renderizar();
  expect(html).toContain('La cola está vacía de verdad');
});

it('una fuente caída se DICE y NO se cuenta como 0 en su tarjeta — no se pinta como si no hubiera pendientes ahí', async () => {
  const b = bandejaVacia();
  b.fuentes.arco = { items: null, error: 'timeout leyendo solicitud_arco' };
  dobles.getBandejaEscalaciones.mockResolvedValue(b);
  const html = await renderizar();
  expect(html).toContain('Solicitudes ARCO: no se pudo leer.');
  expect(html).toContain('timeout leyendo solicitud_arco');
  expect(html).not.toContain('la cola está vacía de verdad');
});

it('con una fuente ilegible y las demás vacías: NO afirma "vacía de verdad" — deja la duda explícita', async () => {
  const b = bandejaVacia();
  b.fuentes.tickets = { items: null, error: 'caída' };
  dobles.getBandejaEscalaciones.mockResolvedValue(b);
  const html = await renderizar();
  expect(html).toContain('una fuente quedó');
  expect(html).toContain('sin leer (arriba)');
  expect(html).toContain('NO afirma que no haya pendientes en total');
});

it('el conteo de la tarjeta es el TOTAL real (ADM-4), no el tamaño de una lista de items topada', async () => {
  const b = bandejaVacia();
  // 300 corridas en fallo reales, pero la lista de items sólo trae 20 (topada).
  b.conteos.corridasFallo = 300;
  b.fuentes.corridas = { items: Array.from({ length: 20 }, (_, i) => ({
    fuente: 'corridas' as const, titulo: `Corrida ${i}`, detalle: null, tenantNombre: 'x', desde: '2026-01-01T00:00:00Z', vence: null, href: null,
  })), error: null };
  b.cola = b.fuentes.corridas.items!;
  dobles.getBandejaEscalaciones.mockResolvedValue(b);
  const html = await renderizar();
  expect(html).toContain('300');
});

it('la cola se recorta a 50 y lo declara contra el total real — sin ocultar cuántas hay de más', async () => {
  const b = bandejaVacia();
  b.cola = Array.from({ length: 75 }, (_, i) => ({
    fuente: 'liquidaciones' as const, titulo: `Liquidación ${i}`, detalle: null, tenantNombre: 'x',
    desde: new Date(Date.now() - i * 3_600_000).toISOString(), vence: null, href: `/dashboard/viajes?tenant=x&id=${i}`,
  }));
  dobles.getBandejaEscalaciones.mockResolvedValue(b);
  const html = await renderizar();
  expect(html).toContain('Se listan las 50 más urgentes de 75');
  expect(html).toContain('Los conteos de arriba SÍ son de toda la cola');
});

it('un item sin pantalla a la que llevar dice "sin ficha" — nunca un link que rebote', async () => {
  const b = bandejaVacia();
  b.cola = [{ fuente: 'talachas', titulo: 'Talacha X', detalle: null, tenantNombre: 'Flota Y', desde: '2026-01-01T00:00:00Z', vence: null, href: null }];
  dobles.getBandejaEscalaciones.mockResolvedValue(b);
  const html = await renderizar();
  expect(html).toContain('sin ficha');
});
