import { describe, it, expect } from 'vitest';
import { validarUrlDeCredencial } from './credenciales';
import { DatoInvalido } from '../errores';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24, SEG-6 (BAJO) — EL `base_url` NO APUNTA HACIA ADENTRO.
//
// Ocho conectores piden `base_url` y nadie validaba esquema ni host: un
// flota_admin escribía `http://10.0.0.5:9200`, apretaba «Probar» y la función
// de Vercel hacía el POST desde dentro, devolviendo el veredicto por código
// HTTP. Oráculo de estado de la red interna, con la firma de un usuario
// legítimo.
// ═══════════════════════════════════════════════════════════════════════════

const rechaza = (valor: string) => {
  expect(() => validarUrlDeCredencial('base_url', valor)).toThrow(DatoInvalido);
};

describe('SEG-6 · la dirección del proveedor es pública y por https', () => {
  it('acepta el portal real de los proveedores del catálogo', () => {
    for (const ok of [
      'https://api.samsara.com',
      'https://hst-api.wialon.com',
      'https://my.geotab.com/apiv1',
      'https://portal.proveedor.com.mx:8443/api/v2/',
    ]) {
      expect(() => validarUrlDeCredencial('base_url', ok)).not.toThrow();
    }
  });

  it('rechaza la red privada en todas sus formas', () => {
    // El escenario del hallazgo, y sus vecinos de los tres bloques RFC 1918.
    for (const malo of [
      'https://10.0.0.5:9200',
      'https://172.16.0.1',
      'https://172.31.255.254',
      'https://192.168.1.1',
    ]) rechaza(malo);
  });

  it('rechaza la propia máquina', () => {
    for (const malo of [
      'https://localhost:3000',
      'https://127.0.0.1',
      'https://[::1]/api',
      'https://0.0.0.0',
    ]) rechaza(malo);
  });

  it('rechaza el metadata de la nube (169.254.169.254) y el link-local', () => {
    rechaza('https://169.254.169.254/latest/meta-data/');
    rechaza('https://[fe80::1]/api');
  });

  it('rechaza los nombres que sólo resuelven adentro', () => {
    for (const malo of [
      'https://buscador.internal',
      'https://caja.local',
      'https://algo.localhost',
    ]) rechaza(malo);
  });

  it('rechaza http:// — la credencial viajaría sin cifrar', () => {
    rechaza('http://api.samsara.com');
    // Y los esquemas que no son web en absoluto.
    rechaza('file:///etc/passwd');
    rechaza('gopher://api.samsara.com');
  });

  it('rechaza lo que ni siquiera es una dirección', () => {
    rechaza('api.samsara.com');   // sin esquema: `new URL` no lo resuelve
    rechaza('');
    rechaza('   ');
  });

  it('el 172.15 y el 172.32 NO son privados: no se rechaza de más', () => {
    // El rango privado es 172.16-172.31. Rechazar 172.15 sería negarle a una
    // flota el portal legítimo de su proveedor.
    expect(() => validarUrlDeCredencial('base_url', 'https://172.15.0.1')).not.toThrow();
    expect(() => validarUrlDeCredencial('base_url', 'https://172.32.0.1')).not.toThrow();
  });

  it('el mensaje dice QUÉ campo y POR QUÉ — la pantalla lo enseña tal cual', () => {
    expect(() => validarUrlDeCredencial('base_url', 'https://10.0.0.5'))
      .toThrow(/base_url.*red interna.*10\.0\.0\.5/s);
    expect(() => validarUrlDeCredencial('base_url', 'http://api.samsara.com'))
      .toThrow(/https:\/\/|sin cifrar/);
  });
});

it.each([
  'https://[::ffff:127.0.0.1]', 'https://[::ffff:7f00:1]', 'https://[64:ff9b::7f00:1]',
  'https://[2002:7f00:1::]', 'https://127.1', 'https://0x7f000001',
  'https://localhost.', 'https://metadata.local.', 'https://user:secret@portal.proveedor.com',
])('cierra formas alternativas antes de guardar: %s', url => {
  expect(() => validarUrlDeCredencial('base_url', url)).toThrow(DatoInvalido);
});
