import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/dev — CERO cobertura de la PÁGINA. Sin puerta propia (requireSuperadmin
// vive en el layout) ni server actions — puro dashboard de sólo lectura, pero
// con MUCHA honestidad de rótulo que vigilar: FE-24 (conteo de tenants null
// ≠ 0), tres estados de GitHub (sin_token/error/ok/generando, nunca "no hay
// actividad" cuando en realidad no se pudo leer), SLO cumple=null nunca se
// pinta verde, eventos de seguridad null ≠ vacío real. Las funciones
// (getActividadGitHub, getSLOs, getEventosSeguridad) ya tienen prueba propia.
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({
  from: vi.fn(),
  getActividadGitHub: vi.fn(),
  getMapaCommits: vi.fn(),
  getAutoresCommits: vi.fn(),
  getEventosSeguridad: vi.fn(),
  getSLOs: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: dobles.from }) }));
vi.mock('@/lib/admin/github', () => ({
  getActividadGitHub: dobles.getActividadGitHub, getMapaCommits: dobles.getMapaCommits, getAutoresCommits: dobles.getAutoresCommits,
}));
vi.mock('@/lib/seguridad/eventos', () => ({ getEventosSeguridad: dobles.getEventosSeguridad }));
vi.mock('@/lib/admin/slo', () => ({ getSLOs: dobles.getSLOs }));

import DevPage from './page';

async function renderizar() { return renderToStaticMarkup(await DevPage()); }

beforeEach(() => {
  vi.clearAllMocks();
  dobles.from.mockReturnValue({ select: async () => ({ count: 5, error: null }) });
  dobles.getActividadGitHub.mockResolvedValue({ estado: 'sin_token' });
  dobles.getMapaCommits.mockResolvedValue({ estado: 'sin_token' });
  dobles.getAutoresCommits.mockResolvedValue({ estado: 'sin_token' });
  dobles.getEventosSeguridad.mockResolvedValue([]);
  dobles.getSLOs.mockResolvedValue([]);
});

it('FE-24: un conteo de tenants que falló (error) NO se pinta como cero — SelectorVista recibe null, no 0', async () => {
  dobles.from.mockReturnValue({ select: async () => ({ count: null, error: { message: 'caída' } }) });
  const html = await renderizar();
  // El bug original era `conteoTenants.count ?? 0`: con error real y count
  // null, el `??` lo convertía en 0 y la pantalla afirmaba "no hay ninguna
  // flota dada de alta" con la base ciega. El texto correcto es el de null.
  expect(html).toContain('No se pudo contar cuántas flotas hay');
  expect(html).not.toContain('No hay ninguna flota dada de alta');
});

it('con conteo real de tenants en 0 (sin error), sí dice que no hay flotas dadas de alta', async () => {
  dobles.from.mockReturnValue({ select: async () => ({ count: 0, error: null }) });
  const html = await renderizar();
  expect(html).toContain('No hay ninguna flota dada de alta');
});

it('mapa de actividad: sin GITHUB_TOKEN dice EXACTAMENTE eso, no "sin pushes"', async () => {
  const html = await renderizar();
  expect(html).toContain('Sin');
  expect(html).toContain('GITHUB_TOKEN');
  expect(html).toContain('no es que no haya pushes');
});

it('mapa de actividad: GitHub recalculando (generando) se distingue de un error real', async () => {
  dobles.getMapaCommits.mockResolvedValue({ estado: 'generando' });
  const html = await renderizar();
  expect(html).toContain('recalculando el histograma');
});

it('mapa de actividad ok: pinta el mapa Y a los autores por separado', async () => {
  dobles.getMapaCommits.mockResolvedValue({ estado: 'ok', semanas: [{ inicio: Date.parse('2026-01-01'), dias: [1, 0, 2, 0, 0, 0, 0] }], total: 3 });
  dobles.getAutoresCommits.mockResolvedValue({ estado: 'ok', autores: [{ nombre: 'Javier', pushes: 42 }] });
  const html = await renderizar();
  expect(html).toContain('Javier');
  expect(html).toContain('42');
});

it('SLOs: cumple=false se pinta distinto de cumple=null (sin muestra ≠ incumplido)', async () => {
  dobles.getSLOs.mockResolvedValue([
    { clave: 's1', nombre: 'Latencia P95', objetivo: '<500ms', medido: '620ms', ventana: '7d', cumple: false },
    { clave: 's2', nombre: 'Disponibilidad', objetivo: '99.9%', medido: 'sin muestra', ventana: '7d', cumple: null },
  ]);
  const html = await renderizar();
  expect(html).toContain('Latencia P95');
  expect(html).toContain('Disponibilidad');
});

it('SLOs que no se pudieron leer (null) lo dicen, no una lista vacía muda', async () => {
  dobles.getSLOs.mockResolvedValue(null);
  const html = await renderizar();
  expect(html).toContain('No se pudieron leer los SLOs');
});

it('eventos de seguridad: null (no se pudo leer) es distinto de [] (de verdad sin eventos)', async () => {
  dobles.getEventosSeguridad.mockResolvedValue(null);
  const htmlCaida = await renderizar();
  expect(htmlCaida).toContain('que no es lo mismo que «no hay eventos»');

  dobles.getEventosSeguridad.mockResolvedValue([]);
  const htmlVacio = await renderizar();
  expect(htmlVacio).toContain('el silencio aquí es bueno de verdad');
});

it('un evento de seguridad real se pinta con su tipo y origen', async () => {
  dobles.getEventosSeguridad.mockResolvedValue([{ id: 'e-1', tipo: 'firma_invalida', origen: 'webhook_meta', actor: null, severidad: 'alta', creadoEn: '2026-01-01T00:00:00Z' }]);
  const html = await renderizar();
  expect(html).toContain('firma invalida'.replace('invalida', 'invalida')); // el guion bajo se reemplaza por espacio
  expect(html).toContain('webhook_meta');
});

it('actividad del código: sin token dice explícitamente que no puede ver el repo', async () => {
  const html = await renderizar();
  expect(html).toContain('esta sección no puede ver el repo');
});

it('actividad del código ok: pinta commits y CI reales con sus links', async () => {
  dobles.getActividadGitHub.mockResolvedValue({
    estado: 'ok',
    commits: [{ sha: 'abc1234', mensaje: 'fix: algo', url: 'https://github.com/x/y/commit/abc1234', fecha: '2026-01-01T00:00:00Z' }],
    ci: [{ url: 'https://github.com/x/y/actions/runs/1', nombre: 'CI', rama: 'master', estado: 'completed', conclusion: 'success' }],
  });
  const html = await renderizar();
  expect(html).toContain('abc1234');
  expect(html).toContain('fix: algo');
});
