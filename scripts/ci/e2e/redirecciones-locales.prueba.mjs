// Prueba de transporte real, opt-in: node scripts/ci/e2e/redirecciones-locales.prueba.mjs.
// Un servidor loopback; Chromium mapea externo.e2e.invalid a127.0.0.1 sin DNS externo.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { protegerPaginaLocalE2E, fetchLocalE2E } from './entorno-local.mjs';
import { crearProxyLocalE2E } from './proxy-local.mjs';

let entregas = 0;
const servidor = createServer((req, res) => {
  if (req.url === '/destino') {
    entregas++;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<p>Destino ajeno al allowlist</p>');
  } else if (req.url === '/pdf') {
    res.writeHead(200, { 'content-type': 'application/pdf' });
    res.end('%PDF-sintetico');
  } else if (req.url === '/popup') {
    const puerto = servidor.address().port;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<script>window.open('http://externo.e2e.invalid:${puerto}/destino','_blank')</script>`);
  } else {
    const puerto = servidor.address().port;
    const host = req.url === '/seed' ? 'localhost' : 'externo.e2e.invalid';
    res.writeHead(req.url === '/seed' ? 307 : 302, { location: `http://${host}:${puerto}/destino` });
    res.end();
  }
});
await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
let navegador;
try {
  const origen = `http://127.0.0.1:${servidor.address().port}`;
  navegador = await chromium.launch({ headless: true, args: ['--no-proxy-server', '--host-resolver-rules=MAP externo.e2e.invalid 127.0.0.1'] });
  const pagina = await navegador.newPage({ serviceWorkers: 'block' });
  await pagina.goto(`${origen}/otp`);
  assert.ok(entregas > 0, 'sin guard,302 sí alcanza el destino no permitido');
  console.log('RED reproducido: navegador sin guard sigue302');
  await pagina.close();
  entregas = 0;
  const protegida = await navegador.newPage({ serviceWorkers: 'block' });
  await protegerPaginaLocalE2E(protegida);
  await assert.rejects(protegida.goto(`${origen}/otp`));
  assert.equal(entregas, 0, 'CDP debe impedir tráfico al destino del302');
  console.log('GREEN: navegador protegido bloquea302 antes de enviar');
  await fetch(`${origen}/seed`, { method: 'POST', body: '{}', headers: { apikey: 'sintetica' } });
  assert.ok(entregas > 0, 'sin guard,307 sí reenvía el seed');
  console.log('RED reproducido: fetch sin guard sigue307');
  entregas = 0;
  await assert.rejects(fetchLocalE2E(`${origen}/seed`, { method: 'POST', body: '{}', headers: { apikey: 'sintetica' } }));
  assert.equal(entregas, 0, 'fetch protegido no debe seguir307');
  console.log('GREEN: seed bloquea307 sin reenviar payload ni llave');
  const proxy = await crearProxyLocalE2E();
  const browserProxy = await chromium.launch({ headless: true, proxy: { server: proxy.server, bypass: '<-loopback>' } });
  try {
    const contexto = await browserProxy.newContext({ serviceWorkers: 'block', storageState: { cookies: [], origins: [] } });
    const paginaProxy = await contexto.newPage();
    entregas = 0;
    const r = await paginaProxy.goto(`${origen}/otp`);
    assert.equal(r.status(), 403);
    assert.equal(entregas, 0, 'proxyglobal protege también página sin entrar()');
    const popupListo = paginaProxy.waitForEvent('popup');
    await paginaProxy.goto(`${origen}/popup`);
    const popup = await popupListo;
    await popup.waitForLoadState();
    assert.equal(await popup.locator('body').innerText(), 'E2E_LOCAL_REQUERIDO');
    assert.equal(entregas, 0, 'popup no debe enviar a destino ajeno');
    console.log('GREEN: proxyglobal bloquea302 ypopup sin sesión/login/CDP');
    const pdf = await contexto.request.get(`${origen}/pdf`, { maxRedirects: 0 });
    assert.equal(pdf.status(), 200);
    assert.equal((await pdf.body()).subarray(0, 5).toString(), '%PDF-');
    console.log('GREEN: APIRequestContext descargaPDF local por proxy');
    await contexto.request.get(`http://externo.e2e.invalid:${servidor.address().port}/destino`, { maxRedirects: 0 }).then((r) => assert.equal(r.status(), 403), () => {});
    assert.equal(entregas, 0, 'CONNECT externo se niega antes de crear upstream');
    console.log('GREEN: CONNECT externo bloqueado sin upstream');
  } finally { await browserProxy.close(); await proxy.close(); }
} finally {
  await navegador?.close();
  servidor.closeAllConnections();
  await new Promise((resolve) => servidor.close(resolve));
}
