import { createHmac } from 'node:crypto';

/** Autenticador del usuario sintético local. RFC 6238, SHA-1, 30 s, 6 dígitos. */
export function codigoTotp(secreto, ahora = Date.now()) {
  if (!/^[A-Z2-7]+$/.test(secreto)) throw new Error('Secreto TOTP local inválido');
  const alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secreto].map((c) => alfabeto.indexOf(c).toString(2).padStart(5, '0')).join('');
  const clave = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(Math.floor(ahora / 30_000)));
  const hash = createHmac('sha1', clave).update(contador).digest();
  const offset = hash[hash.length - 1] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
