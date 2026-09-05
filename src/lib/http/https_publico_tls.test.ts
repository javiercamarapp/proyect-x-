import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import dns, { type LookupAddress } from 'node:dns';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpsPublico, MAX_RESPUESTA_PUBLICA_BYTES } from './https_publico';
import { httpReal } from '@/lib/likida/conectores/tipos';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/likida/bitacora_escritura', () => ({ anotarBitacora: vi.fn() }));
import { validarUrlDeCredencial } from '@/lib/likida/conectores/credenciales';

// Certificado efímero y DNS sintético. El dial nunca sale de loopback y no
// se desactiva TLS: sólo este request de prueba confía su CA efímera.
let directory: string | undefined;
let server: ReturnType<typeof https.createServer> | undefined;
let port = 0;
let requests = 0;
let dnsCalls = 0;
let mode: 'private' | 'mixed' | 'public' = 'private';
let permitSyntheticDial = false;
let validatedPublicDials = 0;
const requestOptions: https.RequestOptions[] = [];
const realRequest = https.request;
const mib = 1024 * 1024;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'likida-https-canary-'));
  const keyPath = join(directory, 'synthetic-key.pem');
  const certPath = join(directory, 'synthetic-cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1',
    '-subj', '/CN=connector.test', '-addext', 'subjectAltName=DNS:connector.test',
  ], { stdio: 'ignore', timeout: 15_000 });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Ruta del directorio efímero generado por esta prueba.
  const certificate = readFileSync(certPath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Llave sintética recién creada en ese mismo directorio propio.
  const key = readFileSync(keyPath);
  server = https.createServer({ key, cert: certificate }, (req, res) => {
    requests += 1;
    if (req.url === '/exact' || req.url === '/large') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      for (let i = 0; i < 8; i += 1) res.write(Buffer.alloc(mib, 120));
      if (req.url === '/large') res.write('x');
      res.end();
      return;
    }
    if (req.url === '/gzip') {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end('synthetic');
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'https://never-resolve.invalid/private' });
      res.end('moved');
      return;
    }
    if (req.url === '/slow') {
      res.writeHead(200);
      res.write('a');
      const timer = setInterval(() => res.write('a'), 20);
      res.once('close', () => clearInterval(timer));
      return;
    }
    res.end('LOCAL_CANARY');
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', resolve);
  });
  port = (server.address() as { port: number }).port;

  const syntheticLookup: LookupFunction = (hostname, options, callback) => {
    dnsCalls += 1;
    if (hostname !== 'connector.test') {
      callback(new Error('La prueba prohíbe DNS externo.'), '');
      return;
    }
    const addresses: LookupAddress[] = mode === 'private'
      ? [{ address: '127.0.0.1', family: 4 }]
      : mode === 'mixed'
        ? [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]
        : [{ address: '8.8.8.8', family: 4 }];
    queueMicrotask(() => {
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, 4);
    });
  };
  vi.spyOn(dns, 'lookup').mockImplementation(syntheticLookup as typeof dns.lookup);
  vi.spyOn(https, 'request').mockImplementation(((
    options: https.RequestOptions,
    callback?: (response: IncomingMessage) => void,
  ) => {
    requestOptions.push(options);
    if (!permitSyntheticDial) return realRequest(options, callback);
    const validatedLookup = options.lookup!;
    const localDial: LookupFunction = (hostname, dnsOptions, done) => {
      // Se ejecuta el lookup PRODUCTIVO y exige su IP pública aprobada. Sólo
      // después se sustituye el dial por loopback. Así un corte por DNS no
      // puede hacer pasar falsamente las pruebas de tamaño o de timeout.
      validatedLookup(hostname, dnsOptions, (error, addresses, family) => {
        if (error) {
          done(error, addresses, family);
          return;
        }
        const address = Array.isArray(addresses) ? addresses[0].address : addresses;
        if (address !== '8.8.8.8') {
          done(new Error('El transporte no validó el destino público sintético.'), '');
          return;
        }
        validatedPublicDials += 1;
        if (dnsOptions.all) done(null, [{ address: '127.0.0.1', family: 4 }]);
        else done(null, '127.0.0.1', 4);
      });
    };
    return realRequest({ ...options, ca: certificate, lookup: localDial }, callback);
  }) as typeof https.request);
}, 20_000);

beforeEach(() => {
  mode = 'private';
  permitSyntheticDial = false;
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function url(path: string) {
  return `https://connector.test:${port}/${path}`;
}

it('rechaza IPv6 mapped loopback al guardar la credencial', () => {
  expect(() => validarUrlDeCredencial('base_url', 'https://[::ffff:127.0.0.1]')).toThrow();
});

it('un DNS privado no alcanza el socket', async () => {
  const before = requests;
  await expect(httpReal()({ url: url('private'), metodo: 'GET' })).rejects.toThrow();
  expect(requests - before).toBe(0);
});

it('rechaza todo el DNS mixto público/privado', async () => {
  mode = 'mixed';
  const before = requests;
  await expect(httpReal()({ url: url('private'), metodo: 'GET' })).rejects.toThrow();
  expect(requests - before).toBe(0);
});

it('8 MiB exactos cruzan validación pública y TLS sin truncarse', async () => {
  mode = 'public';
  permitSyntheticDial = true;
  const before = validatedPublicDials;
  const result = await httpReal()({
    url: url('exact'), metodo: 'GET', encabezados: { Host: 'bad.invalid', 'Accept-Encoding': 'gzip' },
  });
  expect(result.estado).toBe(200);
  expect(result.cuerpo.length).toBe(MAX_RESPUESTA_PUBLICA_BYTES);
  expect(validatedPublicDials - before).toBe(1);
  const options = requestOptions.at(-1)!;
  expect(options.servername).toBe('connector.test');
  expect(options.rejectUnauthorized).toBe(true);
  expect(options.agent).toBe(false);
  expect(options.headers).toEqual({ 'accept-encoding': 'identity' });
});

it('8 MiB más un byte chunked falla por tamaño y no por DNS', async () => {
  mode = 'public';
  permitSyntheticDial = true;
  const before = validatedPublicDials;
  await expect(httpReal()({ url: url('large'), metodo: 'GET' })).rejects.toThrow(/límite de 8 MiB/);
  expect(validatedPublicDials - before).toBe(1);
});

it('rechaza encoding comprimido en un transporte permitido', async () => {
  mode = 'public';
  permitSyntheticDial = true;
  await expect(httpReal()({ url: url('gzip'), metodo: 'GET' })).rejects.toThrow(/codificación/);
});

it('no sigue redirects ni resuelve un segundo host', async () => {
  mode = 'public';
  permitSyntheticDial = true;
  const before = dnsCalls;
  const result = await httpReal()({ url: url('redirect'), metodo: 'GET' });
  expect(result.estado).toBe(302);
  expect(dnsCalls - before).toBe(1);
});

it('el plazo total incluye un body que sigue goteando', async () => {
  mode = 'public';
  permitSyntheticDial = true;
  const start = performance.now();
  await expect(httpsPublico({ url: url('slow'), metodo: 'GET' }, 100)).rejects.toThrow(/plazo/);
  expect(performance.now() - start).toBeLessThan(1000);
});
