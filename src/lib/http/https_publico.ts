import dns from 'node:dns';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { esIpPublica, hostNoPublico } from './destino_publico';

export const MAX_RESPUESTA_PUBLICA_BYTES = 8 * 1024 * 1024;

interface PeticionPublica {
  url: string;
  metodo: 'GET' | 'POST';
  encabezados?: Record<string, string>;
  cuerpo?: string;
}

/** Sin proxies ni reutilización de sockets: el lookup validado entrega las IP
 * directamente a TLS. Conservamos el hostname para SNI y comprobación del cert.
 * https://nodejs.org/api/https.html#httpsrequestoptions-callback
 * No se siguen redirects. identity es obligatorio; una codificación inesperada
 * se cancela antes de leerla, evitando también bombas de descompresión.
 */
export async function httpsPublico(p: PeticionPublica, timeoutMs: number) {
  let url: URL;
  try { url = new URL(p.url); } catch { throw new Error('Dirección del proveedor inválida.'); }
  if (url.protocol !== 'https:' || url.username || url.password || hostNoPublico(url.hostname)) {
    throw new Error('El proveedor debe usar una dirección HTTPS pública sin credenciales en la URL.');
  }
  return new Promise<{ estado: number; cuerpo: string; encabezados: Record<string, string> }>((resolve, reject) => {
    let terminado = false;
    let req: ClientRequest | undefined;
    let respuesta: IncomingMessage | undefined;
    const partes: Buffer[] = [];
    const fallar = (mensaje: string) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(timer);
      partes.length = 0;
      respuesta?.destroy();
      req?.destroy();
      // Nunca propagar mensajes de DNS/TLS/URL que puedan contener secretos.
      reject(new Error(mensaje));
    };
    const timer = setTimeout(() => fallar('El proveedor no contestó dentro del plazo permitido.'), timeoutMs);
    const lookup: LookupFunction = (hostname, options, callback) => {
      dns.lookup(hostname, { all: true, family: options.family, hints: options.hints }, (error, direcciones) => {
        if (terminado) return; // DNS tardío nunca reanima el socket cancelado.
        if (error || !direcciones?.length || direcciones.some(d => !esIpPublica(d.address) || isIP(d.address) !== d.family)) {
          callback(new Error('El destino DNS del proveedor no es público.'), '');
          return;
        }
        if (options.all) callback(null, direcciones);
        else callback(null, direcciones[0].address, direcciones[0].family);
      });
    };
    try {
      const headers: Record<string, string> = {};
      for (const [clave, valor] of Object.entries(p.encabezados ?? {})) {
        // Host/SNI siempre corresponden al destino validado; no heredar encoding.
        if (!['host', 'accept-encoding'].includes(clave.toLowerCase())) headers[clave] = valor;
      }
      headers['accept-encoding'] = 'identity';
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      req = https.request({
        protocol: 'https:', hostname, port: url.port || 443,
        path: url.pathname + url.search, method: p.metodo, headers,
        lookup, agent: false, rejectUnauthorized: true,
        servername: isIP(hostname) ? undefined : hostname,
      }, r => {
        respuesta = r;
        r.on('error', () => fallar('No se pudo leer la respuesta del proveedor.'));
        r.on('aborted', () => fallar('El proveedor interrumpió la respuesta.'));
        if (terminado) { r.destroy(); return; }
        const encoding = r.headers['content-encoding'];
        if (encoding && encoding.trim().toLowerCase() !== 'identity') {
          fallar('El proveedor devolvió una codificación de respuesta no admitida.');
          return;
        }
        const longitud = Number(r.headers['content-length']);
        if (Number.isFinite(longitud) && longitud > MAX_RESPUESTA_PUBLICA_BYTES) {
          fallar('La respuesta del proveedor supera el límite de 8 MiB.');
          return;
        }
        let total = 0;
        r.on('data', (chunk: Buffer) => {
          if (terminado) return;
          total += chunk.byteLength;
          if (total > MAX_RESPUESTA_PUBLICA_BYTES) {
            fallar('La respuesta del proveedor supera el límite de 8 MiB.');
            return;
          }
          partes.push(chunk);
        });
        r.on('end', () => {
          if (terminado) return;
          terminado = true;
          clearTimeout(timer);
          const encabezados: Record<string, string> = {};
          for (const [clave, valor] of Object.entries(r.headers)) {
            if (valor !== undefined) encabezados[clave.toLowerCase()] = Array.isArray(valor) ? valor.join(', ') : valor;
          }
          resolve({ estado: r.statusCode ?? 0, cuerpo: Buffer.concat(partes, total).toString('utf8'), encabezados });
        });
      });
      req.on('error', () => fallar('No se pudo conectar de forma segura con el proveedor.'));
      req.end(p.cuerpo);
    } catch {
      fallar('No se pudo conectar de forma segura con el proveedor.');
    }
  });
}
