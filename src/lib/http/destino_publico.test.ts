import { describe, expect, it } from 'vitest';
import { esIpPublica, hostNoPublico } from './destino_publico';

describe('destinos públicos por familia y CIDR', () => {
  it.each(['8.8.8.8', '172.15.0.1', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888'])('acepta %s', ip => expect(esIpPublica(ip)).toBe(true));
  it.each([
    '0.0.0.0', '10.0.0.1', '127.255.255.254', '100.64.0.1', '169.254.169.254', '172.31.255.255',
    '192.168.1.1', '192.0.0.1', '192.0.2.5', '192.88.99.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b:1::a00:1',
    '100::1', '2001::1', '2001:db8::1', '2001:20::1', '2002:7f00:1::', '3fff::1', 'fc00::1', 'fdff::1', 'fe80::1', 'febf::1', 'ff02::1', 'fe80::1%en0', 'no-ip', '1.2.3.999',
  ])('rechaza %s', ip => expect(esIpPublica(ip)).toBe(false));
  it.each(['localhost.', 'foo.local.', 'foo.internal', 'home.arpa', '[::ffff:7f00:1]', '127.0.0.1'])('bloquea host %s', host => expect(hostNoPublico(host)).toBe(true));
});
