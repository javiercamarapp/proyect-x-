import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/integraciones — CERO cobertura. Puerta en el layout de /admin, no
// aquí. Lo que sí es de esta página, y lo que su propio comentario documenta
// como bug ya corregido (D3/14-ago): CADA pill viene de una medición real —
// nunca "verde de adorno" fijo, y lo que no se mide desde aquí dice "Sin
// medir" en neutro, jamás verde.
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({
  getResumenNegocio: vi.fn(),
  sentryActivo: vi.fn(),
  correoConfigurado: vi.fn(),
  hookDeCorreoConfigurado: vi.fn(),
  envHealth: vi.fn(),
  faltantes: vi.fn(),
}));

vi.mock('@/lib/admin/negocio', () => ({ getResumenNegocio: dobles.getResumenNegocio }));
vi.mock('@/lib/observability/sentry', () => ({ sentryActivo: dobles.sentryActivo }));
vi.mock('@/lib/correo/enviar', () => ({ correoConfigurado: dobles.correoConfigurado }));
vi.mock('@/lib/correo/auth', () => ({ hookDeCorreoConfigurado: dobles.hookDeCorreoConfigurado }));
vi.mock('@/lib/env', () => ({ envHealth: dobles.envHealth, faltantes: dobles.faltantes }));

import IntegracionesPage from './page';
async function renderizar() { return renderToStaticMarkup(await IntegracionesPage()); }

beforeEach(() => {
  vi.clearAllMocks();
  dobles.getResumenNegocio.mockResolvedValue({ porModelo: [] });
  dobles.sentryActivo.mockReturnValue(false);
  dobles.correoConfigurado.mockReturnValue(false);
  dobles.hookDeCorreoConfigurado.mockReturnValue(false);
  dobles.envHealth.mockReturnValue({ supabase: false, whatsapp: false });
  dobles.faltantes.mockReturnValue({ supabase: ['SUPABASE_SERVICE_ROLE_KEY'], whatsapp: ['WHATSAPP_TOKEN'] });
});

it('Vercel SIEMPRE dice "Sin medir" en neutro — nunca un verde fijo (D3, el bug que esta pantalla ya cerró)', async () => {
  const html = await renderizar();
  expect(html).toContain('Sin medir');
});

it('Sentry sin DSN se pinta en rojo con el detalle real, no un "conectado" de adorno', async () => {
  const html = await renderizar();
  expect(html).toContain('Sin DSN');
  expect(html).toContain('runtime log de Vercel');
});

it('con DSN, Sentry se mide como configurado — el rótulo dice lo que se mide, no "conectado" (no se comprueba que reciba)', async () => {
  dobles.sentryActivo.mockReturnValue(true);
  const html = await renderizar();
  expect(html).toContain('DSN configurado');
});

it('Supabase sin llaves completas nombra EXACTAMENTE lo que falta', async () => {
  const html = await renderizar();
  expect(html).toContain('Faltan llaves');
  expect(html).toContain('SUPABASE_SERVICE_ROLE_KEY');
});

it('el hook de correo de acceso avisa el caso caro: encendido en Supabase pero sin secreto aquí = 500 para todos', async () => {
  const html = await renderizar();
  expect(html).toContain('Sin secreto');
  expect(html).toContain('contesta 500');
});

it('los modelos LLM listados son los que YA corrieron (llm_costo), no un catálogo de "podría usarse"', async () => {
  dobles.getResumenNegocio.mockResolvedValue({ porModelo: [{ modelo: 'gpt-5-mini', n: 42, costoUsd: 1.23 }] });
  const html = await renderizar();
  expect(html).toContain('gpt-5-mini');
  expect(html).toContain('42');
});

it('sin llamadas registradas, lo dice — no una tabla vacía sin explicación', async () => {
  const html = await renderizar();
  expect(html).toContain('Sin llamadas registradas todavía');
});
