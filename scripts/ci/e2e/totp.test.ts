import { expect, it } from 'vitest';
import { codigoTotp } from './totp.mjs';

// Vectores SHA-1 del apéndice B de RFC 6238, reducidos a seis dígitos.
// https://www.rfc-editor.org/rfc/rfc6238#appendix-B
it.each([[59, '287082'], [1111111109, '081804'], [1111111111, '050471'],
  [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']])(
  'coincide con el vector RFC en %s segundos', (segundos, esperado) => {
    expect(codigoTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', Number(segundos) * 1000)).toBe(esperado);
  },
);
