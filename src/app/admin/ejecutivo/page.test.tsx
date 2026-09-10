import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/ejecutivo — CERO cobertura. Sin server actions y sin puerta propia
// (requireSuperadmin() vive en admin/layout.tsx, gatea TODO /admin — no hay
// nada que re-verificar aquí). Lo real a vigilar: `esSoloDemo` se comprueba
// contra el ID real del tenant demo, NUNCA sólo por `tenants === 1`
// (auditoría 10, ALTO) — mismo patrón que consola.tsx pero repetido aparte,
// así que puede driftar; y el MRR nulo (plan sin precio) no se confunde con
// "cero clientes".
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({
  getResumenNegocio: vi.fn(),
  getMrr: vi.fn(),
}));

vi.mock('@/lib/admin/negocio', () => ({ getResumenNegocio: dobles.getResumenNegocio, getMrr: dobles.getMrr }));
vi.mock('@/lib/auth/tenant-demo', () => ({ tenantDemo: () => 'demo-real-id' }));
// ContadorRetro es un "Solari" que anima dígito por dígito en el cliente;
// renderToStaticMarkup no corre esa animación y el marcado no trae el valor
// como texto plano. Se dobla por un stub que expone sus props tal cual,
// para verificar QUÉ valor real recibió sin depender del dibujo animado.
vi.mock('../contador-retro', () => ({
  default: (props: { valor: number | null; sinDato?: string }) =>
    props.valor === null
      ? props.sinDato ?? 'sin dato'
      : `CONTADOR:${props.valor}`,
}));

import EjecutivoPage from './page';

const BASE_RESUMEN = {
  tenants: 0, flotas: [], viajesProcesados: 0, costoIaUsd: 0, tokensIn: 0, tokensOut: 0,
  porFase: [], porModelo: [], porDia: [], facturasPorDia: [], facturasTotal: 0,
  tendenciaCosto: null, tendenciaTokens: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  dobles.getMrr.mockResolvedValue({ totalMxn: 50000, suscripcionesActivas: 3 });
});

async function renderizar() { return renderToStaticMarkup(await EjecutivoPage()); }

it('cero flotas: lo dice explícito, no lo confunde con "solo el demo"', async () => {
  dobles.getResumenNegocio.mockResolvedValue({ ...BASE_RESUMEN, tenants: 0 });
  const html = await renderizar();
  expect(html).toContain('Flotas (ninguna dada de alta)');
  expect(html).not.toContain('solo el demo');
});

it('una sola flota que ES el demo real: lo dice — comprobado contra el ID, no sólo el conteo', async () => {
  dobles.getResumenNegocio.mockResolvedValue({
    ...BASE_RESUMEN, tenants: 1, flotas: [{ id: 'demo-real-id', nombre: 'Demo', plan: 'pro', viajes: 0, costoIaUsd: 0, politicaPropia: false }],
  });
  const html = await renderizar();
  expect(html).toContain('Flota (solo el demo)');
});

it('una sola flota que NO es el demo (cliente real con id distinto): NO dice "solo el demo"', async () => {
  dobles.getResumenNegocio.mockResolvedValue({
    ...BASE_RESUMEN, tenants: 1, flotas: [{ id: 'cliente-real-id', nombre: 'ACME', plan: 'pro', viajes: 5, costoIaUsd: 2, politicaPropia: true }],
  });
  const html = await renderizar();
  expect(html).not.toContain('solo el demo');
  expect(html).toContain('Flotas');
});

it('el MRR es el MISMO valor real de getMrr() — no un número aparte "para el board"', async () => {
  dobles.getResumenNegocio.mockResolvedValue(BASE_RESUMEN);
  dobles.getMrr.mockResolvedValue({ totalMxn: 123456, suscripcionesActivas: 5 });
  const html = await renderizar();
  expect(html).toContain('123');
  expect(html).toContain('456');
});

it('MRR null (plan activo sin precio) se declara — no se ve como $0', async () => {
  dobles.getResumenNegocio.mockResolvedValue(BASE_RESUMEN);
  dobles.getMrr.mockResolvedValue({ totalMxn: null, suscripcionesActivas: 2 });
  const html = await renderizar();
  expect(html).toContain('algún plan activo sin precio configurado');
});

it('declara honestamente qué KPIs de board NO existen todavía (ARR, burn, runway) — no inventa cifras', async () => {
  dobles.getResumenNegocio.mockResolvedValue(BASE_RESUMEN);
  const html = await renderizar();
  expect(html).toContain('ARR, burn total, runway');
  expect(html).toContain('serían números');
});

it('pide getResumenNegocio y getMrr en paralelo — ambos se llaman sin argumentos (cruza TODOS los tenants)', async () => {
  dobles.getResumenNegocio.mockResolvedValue(BASE_RESUMEN);
  await EjecutivoPage();
  expect(dobles.getResumenNegocio).toHaveBeenCalledWith();
  expect(dobles.getMrr).toHaveBeenCalledWith();
});
