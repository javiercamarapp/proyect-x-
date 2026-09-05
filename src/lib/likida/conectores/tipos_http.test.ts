import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import dns, { type LookupAddress } from 'node:dns';
import https, { type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { httpReal, TIMEOUT_PRUEBA_MS } from './tipos';
import { MAX_RESPUESTA_PUBLICA_BYTES } from '@/lib/http/https_publico';

let direcciones: LookupAddress[];
let conexiones: number;
let opciones: RequestOptions;
let respuesta: PassThrough & { headers: Record<string, string>; statusCode: number };
let peticion: EventEmitter & { destroy: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
let servir: () => void;
let dnsColgado: boolean;
let resolverPendiente: (() => void) | undefined;

beforeEach(() => {
  direcciones = [{ address: '93.184.216.34', family: 4 }];
  conexiones = 0;
  dnsColgado = false;
  resolverPendiente = undefined;
  respuesta = Object.assign(new PassThrough(), { headers: { 'retry-after': '7', 'x-request-id': 'req-1' }, statusCode: 429 });
  servir = () => respuesta.end('{"ok":false}');
  vi.spyOn(dns, 'lookup').mockImplementation(((_host: string, _options: unknown, cb: (e: null, a: LookupAddress[]) => void) => {
    if (!dnsColgado) queueMicrotask(() => cb(null, direcciones));
    else resolverPendiente = () => cb(null, direcciones);
  }) as typeof dns.lookup);
  vi.spyOn(https, 'request').mockImplementation(((opts: RequestOptions, cb: (r: IncomingMessage) => void) => {
    opciones = opts;
    peticion = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() });
    peticion.end.mockImplementation(() => {
      (opts.lookup as LookupFunction)(String(opts.hostname), { all: true }, (error, addresses) => {
        if (error) { peticion.emit('error', error); return; }
        expect(addresses).toEqual(direcciones);
        conexiones++;
        cb(respuesta as unknown as IncomingMessage);
        servir();
      });
    });
    return peticion as unknown as ClientRequest;
  }) as typeof https.request);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); respuesta.destroy(); });

const consultar = () => httpReal()({ url: 'https://api.example.test/x?token=NO_FILTRAR', metodo: 'GET' });

describe('httpReal canónico sin red externa', () => {
  it('preserva Retry-After, TLS/SNI y devuelve redirect sin seguirlo', async () => {
    respuesta.statusCode = 302;
    respuesta.headers.location = 'https://127.0.0.1/secret';
    const r = await httpReal()({ url: 'https://api.example.test/x', metodo: 'POST', cuerpo: 'abc', encabezados: { Host: 'otro.test', 'Accept-Encoding': 'gzip', Authorization: 'Bearer prueba' } });
    expect(r).toMatchObject({ estado: 302, encabezados: { 'retry-after': '7', 'x-request-id': 'req-1' } });
    expect(https.request).toHaveBeenCalledTimes(1);
    expect(opciones).toMatchObject({ hostname: 'api.example.test', servername: 'api.example.test', rejectUnauthorized: true, agent: false, headers: { 'accept-encoding': 'identity', Authorization: 'Bearer prueba' } });
    expect(opciones.headers).not.toHaveProperty('Host');
    expect(opciones).not.toHaveProperty('checkServerIdentity');
    expect(peticion.end).toHaveBeenCalledWith('abc');
  });
  it.each(['127.0.0.1', '10.0.0.1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::'])('bloquea DNS %s antes de conectar', async ip => {
    direcciones = [{ address: ip, family: ip.includes(':') ? 6 : 4 }];
    await expect(consultar()).rejects.toThrow('segura');
    expect(conexiones).toBe(0);
    expect(peticion.destroy).toHaveBeenCalled();
  });
  it.each(['https://[::ffff:127.0.0.1]', 'https://127.1', 'http://api.example.test', 'https://user:secret@api.example.test'])('rechaza URL insegura %s antes del transporte', async url => {
    await expect(httpReal()({ url, metodo: 'GET' })).rejects.toThrow();
    expect(https.request).not.toHaveBeenCalled();
    expect(dns.lookup).not.toHaveBeenCalled();
  });
  it('falla cerrado si DNS devuelve una familia incoherente', async () => {
    direcciones = [{ address: '93.184.216.34', family: 6 }];
    await expect(consultar()).rejects.toThrow();
    expect(conexiones).toBe(0);
  });
  it('rechaza DNS mixto sin elegir sólo la respuesta pública', async () => {
    direcciones.push({ address: '127.0.0.1', family: 4 });
    await expect(consultar()).rejects.toThrow();
    expect(conexiones).toBe(0);
  });
  it('revalida DNS al abrir otra petición después de rebinding', async () => {
    await consultar();
    direcciones = [{ address: '10.0.0.1', family: 4 }];
    await expect(consultar()).rejects.toThrow();
    expect(dns.lookup).toHaveBeenCalledTimes(2);
    expect(conexiones).toBe(1);
  });
  it('acepta exactamente 8 MiB', async () => {
    servir = () => respuesta.end(Buffer.alloc(MAX_RESPUESTA_PUBLICA_BYTES, 120));
    expect((await consultar()).cuerpo.length).toBe(MAX_RESPUESTA_PUBLICA_BYTES);
    expect(conexiones).toBe(1);
  });
  it('cancela chunked al exceder 8 MiB sin devolver contenido parcial', async () => {
    servir = () => {
      for (let i = 0; i < 16 && !respuesta.destroyed; i++) respuesta.write(Buffer.alloc(1024 * 1024, 120));
      respuesta.end();
    };
    await expect(consultar()).rejects.toThrow('8 MiB');
    expect(conexiones).toBe(1);
    expect(respuesta.destroyed).toBe(true);
    expect(peticion.destroy).toHaveBeenCalled();
  });
  it('rechaza Content-Length excesivo sin consumir datos', async () => {
    respuesta.headers['content-length'] = String(MAX_RESPUESTA_PUBLICA_BYTES + 1);
    await expect(consultar()).rejects.toThrow('8 MiB');
    expect(respuesta.destroyed).toBe(true);
  });
  it.each(['gzip', 'br', 'deflate', 'gzip, br'])('cancela encoding %s antes de descomprimir', async encoding => {
    respuesta.headers['content-encoding'] = encoding;
    await expect(consultar()).rejects.toThrow('codificación');
    expect(respuesta.destroyed).toBe(true);
  });
  it.each(['DNS', 'body'])('el plazo total de 15s también corta %s', async frontera => {
    vi.useFakeTimers();
    dnsColgado = frontera === 'DNS';
    servir = () => { respuesta.write('sin terminar'); };
    const resultado = consultar().catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(TIMEOUT_PRUEBA_MS);
    expect((await resultado as Error).message).toContain('plazo');
    expect(peticion.destroy).toHaveBeenCalled();
    if (frontera === 'DNS') {
      resolverPendiente?.();
      expect(conexiones).toBe(0);
    }
  });
  it('propaga interrupción parcial sin convertirla en éxito', async () => {
    servir = () => { respuesta.write('parcial'); respuesta.emit('aborted'); };
    await expect(consultar()).rejects.toThrow('interrumpió');
  });
  it('errores de transporte no muestran URL, query ni secretos', async () => {
    servir = () => peticion.emit('error', new Error('NO_FILTRAR'));
    const error = await consultar().catch((e: Error) => e);
    expect((error as Error).message).not.toContain('NO_FILTRAR');
  });
});
