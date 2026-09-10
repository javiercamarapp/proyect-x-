import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/consumo — CERO cobertura de la PÁGINA (getResumenNegocio y
// getConsumoPorAgente/getPresupuestoPorProposito ya tienen prueba propia).
// Sin server actions. Lo real que se vigila: resiliencia POR SECCIÓN —
// r/consumo/proposito caen cada uno por su lado, así que con la 0123 o la
// 0244 sin aplicar, la mitad que SÍ funciona sigue viva y lo dice — nunca
// pinta ceros donde en realidad no se pudo leer.
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({
  getResumenNegocio: vi.fn(),
  getConsumoPorAgente: vi.fn(),
  getPresupuestoPorProposito: vi.fn(),
}));

vi.mock('@/lib/admin/negocio', () => ({ getResumenNegocio: dobles.getResumenNegocio }));
vi.mock('@/lib/admin/consumo', () => ({ getConsumoPorAgente: dobles.getConsumoPorAgente, getPresupuestoPorProposito: dobles.getPresupuestoPorProposito }));
vi.mock('../charts', () => ({ AreaChartSimple: () => null }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

import ConsumoPage from './page';

async function renderizar() { return renderToStaticMarkup(await ConsumoPage()); }

const R_OK = {
  costoIaUsd: 120, tokensIn: 1000, tokensOut: 500, tendenciaCosto: -0.1, tendenciaTokens: 0.05,
  porDia: [{ dia: '2026-01-01', costoUsd: 10 }, { dia: '2026-01-02', costoUsd: 12 }],
  porModelo: [{ modelo: 'gpt-5', n: 10, costoUsd: 5 }],
  porFase: [{ fase: 'ocr', n: 10, costoUsd: 5 }],
  flotas: [{ id: 't-1', nombre: 'Flota A', viajes: 10, costoIaUsd: 5 }, { id: 't-2', nombre: 'Flota B', viajes: 20, costoIaUsd: 15 }],
};
const CONSUMO_OK = {
  agentes: [{ agente: 'analista', estado: 'vivo', runnerHabilitado: true, corridas30d: 100, fallos30d: 2, gastado30dUsd: 3, techoDiaUsd: 1, pctTechoHoy: 50 }],
  insights: [{ tipo: 'problema', titulo: 'Techo excedido', detalle: 'x' }, { tipo: 'recomendacion', titulo: 'Baja el modelo', detalle: 'y' }],
};
const PROPOSITO_OK = {
  topeTenantDiaUsd: 10, reservaInteractivoUsd: 7, fraccionReserva: 0.7,
  filas: [{ tenantId: 't-1', tenantNombre: 'Flota A', proposito: 'interactivo', n: 5, liquidadoUsd: 1, reservadoVivoUsd: 0.5 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  dobles.getResumenNegocio.mockResolvedValue(R_OK);
  dobles.getConsumoPorAgente.mockResolvedValue(CONSUMO_OK);
  dobles.getPresupuestoPorProposito.mockResolvedValue(PROPOSITO_OK);
});

it('si TODO falla (resumen y consumo por agente), la página entera dice que no se pudo leer — nunca "$0 gastado"', async () => {
  dobles.getResumenNegocio.mockRejectedValueOnce(new Error('caída'));
  dobles.getConsumoPorAgente.mockRejectedValueOnce(new Error('caída'));
  const html = await renderizar();
  expect(html).toContain('No se pudo leer el consumo');
  expect(html).toContain('NO significa que la IA salga gratis');
});

it('si SOLO el resumen (llm_costo) falla, la sección de agentes sigue viva por su lado', async () => {
  dobles.getResumenNegocio.mockRejectedValueOnce(new Error('caída'));
  const html = await renderizar();
  expect(html).toContain('El gasto del producto (llm_costo) no se pudo leer ahora mismo');
  expect(html).toContain('analista'); // la tabla de agentes sí se pintó
});

it('si SOLO el consumo por agente (migración 0123) falla, el resumen de negocio sigue vivo', async () => {
  dobles.getConsumoPorAgente.mockRejectedValueOnce(new Error('caída'));
  const html = await renderizar();
  expect(html).toContain('Con la migración 0123 sin aplicar a esta base');
  expect(html).toContain('Flota A'); // la tabla por flota (de r) sí se pintó
});

it('si el presupuesto por propósito (migración 0244) falla, el resto de la página sigue viva', async () => {
  dobles.getPresupuestoPorProposito.mockRejectedValueOnce(new Error('caída'));
  const html = await renderizar();
  expect(html).toContain('Con la migración 0244 sin aplicar a esta base');
  expect(html).toContain('analista');
});

it('los insights se separan: "problema" arriba de todo, el resto abajo en su propia sección', async () => {
  const html = await renderizar();
  const idxProblema = html.indexOf('Techo excedido');
  const idxTabla = html.indexOf('Por agente — gasto medido');
  const idxRecomendacion = html.indexOf('Baja el modelo');
  expect(idxProblema).toBeGreaterThan(-1);
  expect(idxProblema).toBeLessThan(idxTabla); // problema va ANTES de la tabla de agentes
  expect(idxRecomendacion).toBeGreaterThan(idxTabla); // recomendación va DESPUÉS
});

it('sin flotas dadas de alta (lectura ok, arreglo vacío) dice eso, no "no se pudo leer"', async () => {
  dobles.getResumenNegocio.mockResolvedValue({ ...R_OK, flotas: [] });
  const html = await renderizar();
  expect(html).toContain('Sin flotas dadas de alta todavía');
  expect(html).not.toContain('No se pudo leer el costo por flota');
});

it('las flotas se ordenan por costo de IA descendente, no por orden de llegada', async () => {
  const html = await renderizar();
  expect(html.indexOf('Flota B')).toBeLessThan(html.indexOf('Flota A')); // B ($15) antes que A ($5)
});

it('sin historial de días suficiente, no intenta pintar una gráfica de un solo punto', async () => {
  dobles.getResumenNegocio.mockResolvedValue({ ...R_OK, porDia: [{ dia: '2026-01-01', costoUsd: 10 }] });
  const html = await renderizar();
  expect(html).toContain('Sin historial suficiente todavía');
});

it('hoy nadie ha gastado por propósito (filas vacías) lo dice explícito, distinto de "no se pudo leer"', async () => {
  dobles.getPresupuestoPorProposito.mockResolvedValue({ ...PROPOSITO_OK, filas: [] });
  const html = await renderizar();
  expect(html).toContain('Hoy nadie ha gastado todavía');
});
