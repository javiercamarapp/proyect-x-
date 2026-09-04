/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SESIÓN POR MAGIC LINK — el login real, correo incluido.
 *
 * Nada aquí se salta la autenticación: la prueba llena el formulario de
 * /login, el server action llama a `signInWithOtp` contra el GoTrue local,
 * Mailpit captura el correo que GoTrue mandó, y la prueba navega el enlace
 * del correo — el mismo recorrido del contralor real, menos el SMTP de
 * producción. Inyectar cookies a mano probaría otra cosa.
 *
 * PRESUPUESTO DE CORREOS: el login de la app admite 10 envíos / 5 min por IP
 * (login/page.tsx). La suite entera gasta 7 —3 del proyecto `preparar` y 4 de
 * login.nav.ts— así que quien agregue pruebas que manden correo debe contar
 * contra ese techo o el exceso se verá como el error genérico del login.
 *
 * TODA espera es por condición (expect.poll contra la API de Mailpit, y
 * expectativas de Playwright con reintento): cero `waitForTimeout`.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { entornoLocalE2E, enlaceLocalE2E, protegerPaginaLocalE2E } from '../../scripts/ci/e2e/entorno-local.mjs';

/** API de Mailpit, la trampa de correo del Supabase local ([local_smtp]). */
export const MAILPIT = entornoLocalE2E().mailpit;

/** Identidades sembradas por scripts/ci/e2e/sembrar-e2e.mjs — nunca reales. */
export const CORREOS = {
  superadmin: 'superadmin.e2e@likida.test',
  duena: 'duena.e2e@likida.test',
  intrusa: 'intrusa.e2e@likida.test',
} as const;

export const ESTADOS = {
  superadmin: 'pruebas-navegador/.estado/superadmin.json',
  duena: 'pruebas-navegador/.estado/duena.json',
  intrusa: 'pruebas-navegador/.estado/intrusa.json',
} as const;

/**
 * Llena y manda el formulario de correo de /login, y afirma la confirmación
 * — que es idéntica exista o no la cuenta (anti-oráculo, auditoría 18 M24).
 */
export async function pedirEnlace(page: Page, correo: string): Promise<void> {
  await page.goto('/login');
  const forma = page.locator('form:has(input[type="email"])');
  await forma.locator('input[type="email"]').fill(correo);
  await forma.locator('button[type="submit"]').click();
  await expect(page.getByText('Te mandamos un enlace a tu correo.')).toBeVisible();
}

interface MensajeMailpit {
  ID: string;
  Created: string;
  To: Array<{ Address: string }>;
}

/** Los mensajes de un buzón que llegaron DESPUÉS de `desdeMs` (más nuevos
 *  primero). El filtro temporal evita leer el enlace de una prueba anterior:
 *  un enlace de OTP viejo ya fue consumido y GoTrue lo rechaza. */
export async function mensajesDe(
  req: APIRequestContext,
  correo: string,
  desdeMs: number,
): Promise<MensajeMailpit[]> {
  const r = await req.get(`${MAILPIT}/api/v1/search`, {
    params: { query: `to:"${correo}"`, limit: '20' },
    maxRedirects: 0,
  });
  if (!r.ok()) throw new Error(`Mailpit respondió ${r.status()} — ¿está arriba el Supabase local?`);
  const cuerpo = (await r.json()) as { messages?: MensajeMailpit[] };
  return (cuerpo.messages ?? []).filter((m) => new Date(m.Created).getTime() >= desdeMs);
}

/** Espera (por condición) el correo del magic link y devuelve su enlace de
 *  verificación (`/auth/v1/verify?...` del GoTrue local). */
export async function enlaceDelCorreo(
  req: APIRequestContext,
  correo: string,
  desdeMs: number,
): Promise<string> {
  let id = '';
  await expect
    .poll(async () => {
      const lista = await mensajesDe(req, correo, desdeMs);
      id = lista[0]?.ID ?? '';
      return id;
    }, {
      message: `el correo del magic link para ${correo} nunca llegó a Mailpit`,
      timeout: 30_000,
    })
    .not.toBe('');

  const r = await req.get(`${MAILPIT}/api/v1/message/${encodeURIComponent(id)}`, { maxRedirects: 0 });
  if (!r.ok()) throw new Error(`Mailpit no entregó el mensaje ${id}: HTTP ${r.status()}`);
  const mensaje = (await r.json()) as { Text?: string; HTML?: string };
  // El cuerpo de texto trae la URL limpia; el HTML la trae con &amp;.
  const texto = `${mensaje.Text ?? ''}\n${(mensaje.HTML ?? '').replace(/&amp;/g, '&')}`;
  const enlace = texto.match(/https?:\/\/[^\s"'<>)\]]*\/auth\/v1\/verify[^\s"'<>)\]]*/)?.[0];
  if (!enlace) throw new Error(`el correo para ${correo} no trae enlace /auth/v1/verify`);
  return enlaceLocalE2E(enlace);
}

/**
 * El login completo: formulario → correo en Mailpit → navegar el enlace.
 * Devuelve cuando la app ya aterrizó en /dashboard o /admin (según el rol,
 * `puertaDeEntrada`). El enlace se abre EN EL MISMO contexto que pidió el
 * correo: el flujo PKCE de @supabase/ssr deja el code_verifier en una cookie
 * y el canje del callback lo necesita — igual que el dispositivo del usuario.
 */
export async function entrar(page: Page, correo: string): Promise<void> {
  await protegerPaginaLocalE2E(page);
  const desde = Date.now();
  await pedirEnlace(page, correo);
  const enlace = await enlaceDelCorreo(page.request, correo, desde);
  await page.goto(enlace);
  await page.waitForURL(/\/(dashboard|admin)([/?]|$)/);
}
