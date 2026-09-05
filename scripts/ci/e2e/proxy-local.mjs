import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { exigirUrlLocal } from './entorno-local.mjs';

function hostLoopback(hostname) {
  // El nombre entregado al socket procede exclusivamente de este catálogo.
  // localhost usa lookupLoopback: nunca DNS ni /etc/hosts.
  switch (hostname) {
    case 'localhost': return 'localhost';
    case '127.0.0.1': return '127.0.0.1';
    case '[::1]': return '::1';
    default: throw new Error('E2E_LOCAL_REQUERIDO: destino no local');
  }
}

function lookupLoopback(hostname, opciones, callback) {
  if (hostname !== 'localhost') {
    callback(new Error('E2E_LOCAL_REQUERIDO: resolver limitado a localhost'));
    return;
  }
  // autoSelectFamily prueba la otra familia si el servicio local sólo escucha
  // en una de ellas. Ambas direcciones son constantes, sin resolución externa.
  if (opciones.all) {
    callback(null, [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }]);
  } else if (opciones.family === 6) {
    callback(null, '::1', 6);
  } else {
    callback(null, '127.0.0.1', 4);
  }
}

/** Proxy de pruebas: cada salto y popup usa esta frontera antes del socket.
 * Nunca resuelve ni conecta hosts externos. CONNECT admite sólo loopback:
 * APIRequestContext lo usa incluso para transportar HTTP local.
 */
export async function crearProxyLocalE2E() {
  const tuneles = new Set();
  const servidor = createServer((entrada, salida) => {
    let url;
    try { url = new URL(exigirUrlLocal(entrada.url ?? '', 'browser proxy', { ruta: true })); }
    catch { salida.writeHead(403); salida.end('E2E_LOCAL_REQUERIDO'); return; }
    const upstream = request({
      hostname: hostLoopback(url.hostname), port: Number(url.port || 80),
      lookup: lookupLoopback, autoSelectFamily: true,
      path: url.pathname + url.search, method: entrada.method, headers: entrada.headers,
      agent: false,
    }, (respuesta) => {
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
    const upstream = connect({
      port: Number(destino.port || 80), host: hostLoopback(destino.hostname),
      lookup: lookupLoopback, autoSelectFamily: true,
    }, () => {
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
