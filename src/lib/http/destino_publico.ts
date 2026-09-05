import { isIP } from 'node:net';

function ipv4Numero(ip: string): bigint {
  return ip.split('.').reduce((n, octeto) => (n << 8n) | BigInt(octeto), 0n);
}

function ipv6Numero(ip: string): bigint {
  // isIP valida primero; WHATWG convierte la cola IPv4 y comprime de forma canónica.
  const normal = new URL(`https://[${ip}]/`).hostname.slice(1, -1);
  const [izquierda, derecha] = normal.split('::');
  const a = izquierda ? izquierda.split(':') : [];
  const b = derecha ? derecha.split(':') : [];
  const grupos = normal.includes('::') ? [...a, ...Array<string>(8 - a.length - b.length).fill('0'), ...b] : a;
  return grupos.reduce((n, grupo) => (n << 16n) | BigInt(`0x${grupo}`), 0n);
}

function enRed(ip: bigint, base: bigint, prefijo: number, bits: number): boolean {
  const desplazamiento = BigInt(bits - prefijo);
  return ip >> desplazamiento === base >> desplazamiento;
}

const V4_ESPECIALES = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const;
const V6_ESPECIALES = [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const;

/** Política conservadora para portales HTTPS, no un catálogo de rutas accesibles.
 * IANA special registries (consultados 2026-09-04):
 * https://www.iana.org/assignments/iana-ipv4-special-registry/
 * https://www.iana.org/assignments/iana-ipv6-special-registry/
 * IPv6 sólo unicast global ordinario 2000::/3: excluye mapped, NAT64, 6to4,
 * Teredo, identificadores de protocolo y documentación, aunque algunos especiales
 * tengan excepciones globales. No aceptamos traducción a una IPv4 oculta.
 */
export function esIpPublica(ip: string): boolean {
  if (ip.includes('%')) return false;
  const familia = isIP(ip);
  if (familia === 4) {
    const valor = ipv4Numero(ip);
    return !V4_ESPECIALES.some(([base, prefijo]) => enRed(valor, ipv4Numero(base), prefijo, 32));
  }
  if (familia === 6) {
    const valor = ipv6Numero(ip);
    return enRed(valor, ipv6Numero('2000::'), 3, 128)
      && !V6_ESPECIALES.some(([base, prefijo]) => enRed(valor, ipv6Numero(base), prefijo, 128));
  }
  return false;
}

/** Los nombres se vuelven a validar por su IP al abrir CADA socket. */
export function hostNoPublico(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(h)) return !esIpPublica(h);
  if (h.includes(':') || h.includes('%') || !h.includes('.')) return true;
  return ['localhost', 'internal', 'local', 'localdomain', 'home.arpa']
    .some(sufijo => h === sufijo || h.endsWith(`.${sufijo}`));
}
