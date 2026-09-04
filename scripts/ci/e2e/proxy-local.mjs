import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { exigirUrlLocal } from './entorno-local.mjs';

/** Proxy de pruebas: cada salto y popup usa esta frontera antes del socket.
 * Nunca resuelve ni conecta hosts externos. CONNECT admite sólo loopback:
 * APIRequestContext lo usa incluso para transportar HTTP local.
 */
export async function crearProxyLocalE2E() {
  const tuneles = new Set();
  const servidor = createServer((entrada, salida) => {
    let url;
    try { url = exigirUrlLocal(entrada.url ?? '', 'browser proxy', { ruta: true }); }
    catch { salida.writeHead(403); salida.end('E2E_LOCAL_REQUERIDO'); return; }
    const upstream = request(url, { method: entrada.method, headers: entrada.headers }, (respuesta) => {
      salida.writeHead(respuesta.statusCode ?? 502, respuesta.headers);
      respuesta.pipe(salida);
    });
    upstream.on('error', () => { if (!salida.headersSent) salida.writeHead(502); salida.end(); });
    entrada.on('aborted', () => upstream.destroy());
    entrada.pipe(upstream);
  });
  servidor.on('connect', (entrada, socket, head) => {
    let destino;
    try {
      if (!/^(?:localhost|127\.0\.0\.1|\[::1\]):[0-9]+$/.test(entrada.url ?? '')) throw new Error('destino inválido');
      destino = new URL(exigirUrlLocal(`http://${entrada.url}`, 'CONNECT local'));
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const upstream = connect(Number(destino.port || 80), destino.hostname.replace(/^\[|\]$/g, ''), () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    tuneles.add(socket);
    socket.on('close', () => { tuneles.delete(socket); upstream.destroy(); });
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  await new Promise((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(0, '127.0.0.1', resolve);
  });
  const direccion = servidor.address();
  if (!direccion || typeof direccion === 'string') throw new Error('Proxy local sin puerto');
  return {
    server: `http://127.0.0.1:${direccion.port}`,
    async close() { for (const socket of tuneles) socket.destroy(); servidor.closeAllConnections(); await new Promise((resolve) => servidor.close(resolve)); },
  };
}
