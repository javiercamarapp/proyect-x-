import dns from 'node:dns';
import { createServer, request, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { crearProxyLocalE2E } from './proxy-local.mjs';

const limpiezas: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const limpiar of limpiezas.splice(0).reverse()) await limpiar();
});

async function destino(host: string) {
  const recibidas: Array<{ url?: string; host?: string }> = [];
  const servidor = createServer((req, res) => {
    recibidas.push({ url: req.url, host: req.headers.host });
    res.end('canario local');
  });
  await new Promise<void>((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen({ port: 0, host, ipv6Only: host === '::1' }, resolve);
  });
  limpiezas.push(() => cerrar(servidor));
  const direccion = servidor.address();
  if (!direccion || typeof direccion === 'string') throw new Error('Sin puerto');
  return { puerto: direccion.port, recibidas };
}

async function cerrar(servidor: Server) {
  servidor.closeAllConnections();
  await new Promise<void>((resolve) => servidor.close(() => resolve()));
}

async function proxy() {
  const resultado = await crearProxyLocalE2E();
  limpiezas.push(() => resultado.close());
  return new URL(resultado.server);
}

function impedirDNS() {
  // Todos los sockets del arnés usan IP literal. Incluso localhost debe
  // alcanzar el canario sin consultar el resolver del sistema.
  return vi.spyOn(dns, 'lookup').mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error) => void;
    queueMicrotask(() => callback(new Error('DNS prohibido en este canario')));
  }) as typeof dns.lookup);
}

function httpPorProxy(proxyUrl: URL, url: string, host: string) {
  return new Promise<{ estado: number; cuerpo: string }>((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port: proxyUrl.port, path: url,
      headers: { host }, agent: false,
    }, (res) => {
      let cuerpo = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { cuerpo += chunk; });
      res.on('end', () => resolve({ estado: res.statusCode ?? 0, cuerpo }));
    });
    req.setTimeout(2000, () => req.destroy(new Error('Timeout del canario HTTP')));
    req.on('error', reject);
    req.end();
  });
}

function connectPorProxy(proxyUrl: URL, autoridad: string, contenido = '') {
  return new Promise<string>((resolve, reject) => {
    const socket: Socket = connect({ host: '127.0.0.1', port: Number(proxyUrl.port) });
    let recibido = '';
    const terminar = () => { socket.destroy(); resolve(recibido); };
    socket.setEncoding('utf8');
    socket.setTimeout(2000, () => socket.destroy(new Error('Timeout del canario CONNECT')));
    socket.on('error', reject);
    socket.on('end', terminar);
    socket.on('close', terminar);
    socket.on('data', (chunk) => {
      recibido += chunk;
      if (recibido.includes('canario local') || recibido.includes('403 Forbidden')) terminar();
    });
    socket.on('connect', () => socket.write(
      `CONNECT ${autoridad} HTTP/1.1\r\nHost: ${autoridad}\r\n\r\n${contenido}`,
    ));
  });
}

describe('proxy E2E: sockets limitados a IP loopback literal', () => {
  const destinos = [
    ['127.0.0.1', '127.0.0.1'], ['[::1]', '::1'],
    ['localhost', '127.0.0.1'], ['localhost', '::1'],
  ];
  it.each(destinos)('HTTP %s contra servidor exclusivo %s conserva ruta/query sin DNS', async (host, bind) => {
    const backend = await destino(bind);
    const local = await proxy();
    const resolver = impedirDNS();
    const autoridad = `${host}:${backend.puerto}`;
    expect(await httpPorProxy(local, `http://${autoridad}/canario?a=1`, autoridad))
      .toEqual({ estado: 200, cuerpo: 'canario local' });
    expect(backend.recibidas).toEqual([{ url: '/canario?a=1', host: autoridad }]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each(destinos)('CONNECT %s contra servidor exclusivo %s transporta head sin DNS', async (host, bind) => {
    const backend = await destino(bind);
    const local = await proxy();
    const resolver = impedirDNS();
    const autoridad = `${host}:${backend.puerto}`;
    const respuesta = await connectPorProxy(local, autoridad,
      `GET /tunel HTTP/1.1\r\nHost: ${autoridad}\r\nConnection: close\r\n\r\n`);
    expect(respuesta).toContain('200 Connection Established');
    expect(respuesta).toContain('canario local');
    expect(backend.recibidas).toEqual([{ url: '/tunel', host: autoridad }]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each([['127.0.0.1', '::1'], ['[::1]', '127.0.0.1']])
  ('la IP explícita %s no salta al servidor de la otra familia %s', async (host, bind) => {
    const backend = await destino(bind);
    const local = await proxy();
    const resolver = impedirDNS();
    const autoridad = `${host}:${backend.puerto}`;
    expect((await httpPorProxy(local, `http://${autoridad}/canario`, autoridad)).estado).toBe(502);
    expect(await connectPorProxy(local, autoridad)).not.toContain('200 Connection Established');
    expect(backend.recibidas).toEqual([]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each(['http://externo.invalid/', 'http://usuario:clave@127.0.0.1:PUERTO/',
    'https://127.0.0.1:PUERTO/', 'http://127.0.0.1:PUERTO/#fragmento'])
  ('rechaza HTTP %s antes de resolver o reenviar', async (plantilla) => {
    const backend = await destino('127.0.0.1');
    const local = await proxy();
    const resolver = impedirDNS();
    const url = plantilla.replace('PUERTO', String(backend.puerto));
    expect((await httpPorProxy(local, url, `127.0.0.1:${backend.puerto}`)).estado).toBe(403);
    expect(backend.recibidas).toEqual([]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each(['externo.invalid:PUERTO', 'usuario:clave@127.0.0.1:PUERTO', '127.0.0.1:PUERTO/ruta'])
  ('rechaza CONNECT %s antes de resolver o reenviar', async (plantilla) => {
    const backend = await destino('127.0.0.1');
    const local = await proxy();
    const resolver = impedirDNS();
    expect(await connectPorProxy(local, plantilla.replace('PUERTO', String(backend.puerto))))
      .toContain('403 Forbidden');
    expect(backend.recibidas).toEqual([]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('close termina un túnel abierto y permite cerrar el servidor destino', async () => {
    const backend = await destino('127.0.0.1');
    const local = await crearProxyLocalE2E();
    limpiezas.push(() => local.close());
    const socket = connect({ host: '127.0.0.1', port: Number(new URL(local.server).port) });
    limpiezas.push(async () => { socket.destroy(); });
    socket.setTimeout(2000, () => socket.destroy(new Error('Timeout del túnel abierto')));
    const cerrado = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    const respuesta = await new Promise<string>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('data', (datos) => resolve(datos.toString()));
      socket.once('connect', () => socket.write(
        `CONNECT 127.0.0.1:${backend.puerto} HTTP/1.1\r\nHost: localhost\r\n\r\n`,
      ));
    });
    expect(respuesta).toContain('200 Connection Established');
    await local.close();
    await cerrado;
    expect(socket.destroyed).toBe(true);
    expect(backend.recibidas).toEqual([]);
  });
});
