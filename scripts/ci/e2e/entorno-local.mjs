/** URL local explícita; nunca imprime valores que puedan incluir credenciales.
 * @param {string} valor
 * @param {string} nombre
 * @param {{ruta?: boolean}} opciones
 */
export function exigirUrlLocal(valor, nombre, opciones = {}) {
  let url;
  try { url = new URL(valor); } catch { throw new Error(`E2E_LOCAL_REQUERIDO: ${nombre} inválido`); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.hash
      || (!opciones.ruta && (url.pathname !== '/' || url.search))) {
    throw new Error(`E2E_LOCAL_REQUERIDO: ${nombre} debe apuntar explícitamente a HTTP loopback`);
  }
  return opciones.ruta ? url.href : url.origin;
}

/** @param {Partial<NodeJS.ProcessEnv>} env */
export function entornoLocalE2E(env = process.env) {
  return {
    app: exigirUrlLocal(env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000', 'PLAYWRIGHT_BASE_URL'),
    supabase: exigirUrlLocal(env.SUPABASE_URL ?? 'http://127.0.0.1:54321', 'SUPABASE_URL'),
    mailpit: exigirUrlLocal(env.MAILPIT_URL ?? 'http://127.0.0.1:54324', 'MAILPIT_URL'),
  };
}

/** Valida también el retorno del OTP, antes de navegar un correo.
 * @param {string} valor
 */
export function enlaceLocalE2E(valor) {
  const seguro = exigirUrlLocal(valor, 'magic link', { ruta: true });
  const url = new URL(seguro);
  const retorno = url.searchParams.get('redirect_to');
  if (retorno) exigirUrlLocal(retorno, 'magic link redirect_to', { ruta: true });
  return seguro;
}

/** Transporte del seed: ningún redirect puede reenviar la llave local.
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 */
export async function fetchLocalE2E(input, init) {
  exigirUrlLocal(input instanceof Request ? input.url : String(input), 'seed fetch', { ruta: true });
  return fetch(input, { ...init, redirect: 'error' });
}

/** Chromium pausa CADA request, incluidos los saltos de redirect. page.route
 * sólo ve la primera URL; no sirve de frontera para un OTP que devuelve302.
 * @param {import('@playwright/test').Page} page
 */
export async function protegerPaginaLocalE2E(page) {
  const cdp = await page.context().newCDPSession(page);
  cdp.on('Fetch.requestPaused', async (evento) => {
    try {
      exigirUrlLocal(evento.request.url, 'browser request', { ruta: true });
    } catch {
      await cdp.send('Fetch.failRequest', { requestId: evento.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      return;
    }
    await cdp.send('Fetch.continueRequest', { requestId: evento.requestId }).catch(() => {});
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
}

/** GET con saltos explícitos y revisados, para el302 del PDF hacia Storage.
 * @param {{get: (url: string, opciones: {maxRedirects: number}) => Promise<any>}} req
 * @param {string} valor
 */
export async function getLocalE2E(req, valor) {
  let actual = new URL(valor, entornoLocalE2E().app).href;
  for (let salto = 0; salto < 10; salto++) {
    exigirUrlLocal(actual, 'PDF GET', { ruta: true });
    const respuesta = await req.get(actual, { maxRedirects: 0 });
    if (![301, 302, 303, 307, 308].includes(respuesta.status())) return respuesta;
    const destino = respuesta.headers().location;
    await respuesta.dispose?.();
    if (!destino) throw new Error('E2E_LOCAL_REQUERIDO: redirect sin Location');
    actual = new URL(destino, actual).href;
  }
  throw new Error('E2E_LOCAL_REQUERIDO: demasiados redirects');
}
