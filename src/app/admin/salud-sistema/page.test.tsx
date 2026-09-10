import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/salud-sistema — CERO cobertura de la PÁGINA (sentryActivo,
// correoConfigurado, cofreConfigurado, redisConfigurado, envHealth ya tienen
// prueba propia en sus módulos). Sin server actions. Lo real que se vigila:
// esta pantalla existió antes con semáforos FIJOS en verde (auditoría 4, D3)
// — "un semáforo que no puede ponerse en rojo es decoración". Se prueba que
// SÍ se pone en rojo/ámbar cuando falta cada pieza, y el caso más peligroso:
// QStash con token PERO SIN llaves de firma es `bad`, no `warn` como "sin
// configurar" — es peor tener el token a medias que no tenerlo.
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({
  sentryActivo: vi.fn(),
  alertaConfigurada: vi.fn(),
  correoConfigurado: vi.fn(),
  cofreConfigurado: vi.fn(),
  envHealth: vi.fn(),
  faltantes: vi.fn(),
  redisConfigurado: vi.fn(),
  acotada: vi.fn(),
}));

vi.mock('@/lib/observability/sentry', () => ({ sentryActivo: dobles.sentryActivo }));
vi.mock('@/lib/observability/alerta', () => ({ alertaConfigurada: dobles.alertaConfigurada }));
vi.mock('@/lib/correo/enviar', () => ({ correoConfigurado: dobles.correoConfigurado }));
vi.mock('@/lib/likida/conectores/cofre', () => ({ cofreConfigurado: dobles.cofreConfigurado }));
vi.mock('@/lib/env', () => ({ envHealth: dobles.envHealth, faltantes: dobles.faltantes }));
vi.mock('@/lib/ratelimit', () => ({ redisConfigurado: dobles.redisConfigurado }));
vi.mock('@/lib/likida/presupuesto', () => ({ acotada: dobles.acotada }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: () => ({ select: () => 'query-fantasma' }) }) }));

import SaludSistemaPage from './page';

async function renderizar() { return renderToStaticMarkup(await SaludSistemaPage()); }

const ENV_ORIGINAL = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ENV_ORIGINAL };
  delete process.env.CRON_SECRET;
  delete process.env.UPSTASH_QSTASH_TOKEN;
  delete process.env.QSTASH_CURRENT_SIGNING_KEY;
  delete process.env.QSTASH_NEXT_SIGNING_KEY;
  delete process.env.ALERTA_EMAIL;

  dobles.sentryActivo.mockReturnValue(true);
  dobles.alertaConfigurada.mockReturnValue(false);
  dobles.correoConfigurado.mockReturnValue(true);
  dobles.cofreConfigurado.mockReturnValue(true);
  dobles.redisConfigurado.mockReturnValue(true);
  dobles.envHealth.mockReturnValue({ llm: true, whatsapp: true, supabase: true });
  dobles.faltantes.mockReturnValue({});
  dobles.acotada.mockResolvedValue({ error: null });
});

afterEach(() => { process.env = ENV_ORIGINAL; });

it('Sentry sin DSN se marca "ciego", nunca un verde fijo (auditoría 4, D3)', async () => {
  dobles.sentryActivo.mockReturnValue(false);
  const html = await renderizar();
  expect(html).toContain('Sin DSN — ciego');
});

it('una base de Supabase caída se DICE — la consulta real comprueba el error por valor', async () => {
  dobles.acotada.mockResolvedValue({ error: { message: 'la base no respondió' } });
  const html = await renderizar();
  expect(html).toContain('No respondió');
  expect(html).toContain('la base no respondió');
});

it('si supabaseAdmin() lanza (faltan sus variables), también se lee como "no respondió"', async () => {
  dobles.acotada.mockRejectedValueOnce(new Error('faltan variables de Supabase'));
  const html = await renderizar();
  expect(html).toContain('No respondió');
});

it('sin CRON_SECRET, dice que NINGÚN cron corre — la cuenta sale de CRONS, no de un número escrito a mano', async () => {
  const { CRONS } = await import('@/lib/admin/salud');
  const html = await renderizar();
  expect(html).toContain('Sin CRON_SECRET — los crons no corren');
  expect(html).toContain(`Los ${CRONS.length} crons devuelven 500`);
});

it('con CRON_SECRET, dice que los crons SÍ lo exigen', async () => {
  process.env.CRON_SECRET = 'un-secreto';
  const html = await renderizar();
  expect(html).toContain('CRON_SECRET');
  const idx = html.indexOf('Crons — CRON_SECRET');
  expect(html.slice(idx, idx + 400)).toContain('Configurado');
});

it('QStash con token PERO sin llaves de firma es BAD (peor que sin configurar), no warn', async () => {
  process.env.UPSTASH_QSTASH_TOKEN = 'tok_123';
  const html = await renderizar();
  expect(html).toContain('Token SIN llaves de firma');
  expect(html).toContain('el callback lo rechaza con 503');
});

it('QStash sin nada es "sin configurar" (warn) — distinto del caso token-sin-llaves', async () => {
  const html = await renderizar();
  expect(html).toContain('Cola de facturación — QStash');
  const idx = html.indexOf('Cola de facturación');
  expect(html.slice(idx, idx + 300)).toContain('Sin configurar');
});

it('QStash con token Y las dos llaves es OK', async () => {
  process.env.UPSTASH_QSTASH_TOKEN = 'tok_123';
  process.env.QSTASH_CURRENT_SIGNING_KEY = 'k1';
  process.env.QSTASH_NEXT_SIGNING_KEY = 'k2';
  const html = await renderizar();
  const idx = html.indexOf('Cola de facturación');
  expect(html.slice(idx, idx + 300)).toContain('Token y llaves de firma presentes');
});

it('sin Redis distribuido, el límite de tasa se marca BAD (no protege entre instancias) — mismo peso que Sentry', async () => {
  dobles.redisConfigurado.mockReturnValue(false);
  const html = await renderizar();
  expect(html).toContain('Sin configurar — límite solo por instancia');
});

it('sin cofre (LIKIDA_COFRE_LLAVE ausente o corta), lo dice: no se puede guardar credenciales de conectores', async () => {
  dobles.cofreConfigurado.mockReturnValue(false);
  const html = await renderizar();
  expect(html).toContain('Ausente o demasiado corta');
});

it('un correo de alerta configurado se muestra OFUSCADO (j***@dominio), no completo', async () => {
  process.env.ALERTA_EMAIL = 'javier@likida.ai';
  dobles.alertaConfigurada.mockReturnValue(true);
  const html = await renderizar();
  expect(html).toContain('j***@likida.ai');
  expect(html).not.toContain('javier@likida.ai');
});

it('ALERTA_EMAIL puesto pero Resend sin configurar: dice que la alerta no puede salir, no que ya está lista', async () => {
  process.env.ALERTA_EMAIL = 'javier@likida.ai';
  dobles.alertaConfigurada.mockReturnValue(false);
  const html = await renderizar();
  expect(html).toContain('Correo sin configurar');
  expect(html).toContain('la alerta no puede salir');
});

it('un grupo de variables (llm/whatsapp/supabase) incompleto lista EXACTAMENTE las que faltan', async () => {
  dobles.envHealth.mockReturnValue({ llm: false, whatsapp: true, supabase: true });
  dobles.faltantes.mockReturnValue({ llm: ['OPENROUTER_API_KEY'] });
  const html = await renderizar();
  expect(html).toContain('Faltan: OPENROUTER_API_KEY');
});

it('Vercel siempre se marca "No medido" — nunca un verde de adorno que sólo prueba que la página renderizó', async () => {
  const html = await renderizar();
  const idx = html.indexOf('Uptime y deploys — Vercel');
  expect(html.slice(idx, idx + 500)).toContain('No medido');
});
