import { describe, expect, it } from 'vitest';
import { leerTextoAcotado } from './cuerpo_acotado';

function peticionDeStream(
  trozos: Uint8Array[],
  headers: Record<string, string> = {},
  alPedir?: () => void,
): Request {
  let indice = 0;
  return new Request('https://app.likida.ai/api/prueba', {
    method: 'POST',
    headers,
    body: new ReadableStream<Uint8Array>({
      pull(controlador) {
        alPedir?.();
        const trozo = trozos[indice++];
        if (trozo) controlador.enqueue(trozo);
        else controlador.close();
      },
    }),
    // @ts-expect-error Node exige duplex para construir Request con stream.
    duplex: 'half',
  });
}

describe('leerTextoAcotado', () => {
  it('corta un cuerpo chunked por bytes mientras se lee, antes de consumir el resto', async () => {
    let pedidos = 0;
    const trozos = Array.from({ length: 100 }, () => new Uint8Array(1024).fill(120));
    const resultado = await leerTextoAcotado(peticionDeStream(trozos, {}, () => { pedidos += 1; }), 4 * 1024);

    expect(resultado).toEqual({ ok: false, motivo: 'demasiado_grande' });
    expect(pedidos).toBeLessThanOrEqual(6);
  });

  it('rechaza un content-length declarado excesivo sin consumir el stream', async () => {
    let pedidos = 0;
    const resultado = await leerTextoAcotado(
      peticionDeStream([new Uint8Array([123, 125])], { 'content-length': '9000' }, () => { pedidos += 1; }),
      1024,
    );

    expect(resultado).toEqual({ ok: false, motivo: 'demasiado_grande' });
    // Web Streams puede precargar un trozo al construir Request, pero el
    // lector no debe consumir nada adicional cuando la cabecera ya rebasa.
    expect(pedidos).toBeLessThanOrEqual(1);
  });

  it('preserva exactamente el texto UTF-8 que después firma el proveedor', async () => {
    const crudo = '{"mensaje":"camión 🚚"}\n';
    const bytes = new TextEncoder().encode(crudo);
    const resultado = await leerTextoAcotado(peticionDeStream([
      bytes.slice(0, 7),
      bytes.slice(7, 18),
      bytes.slice(18),
    ]), bytes.byteLength);

    expect(resultado).toEqual({ ok: true, texto: crudo, bytes: bytes.byteLength });
  });

  it('cuenta bytes UTF-8 y no unidades UTF-16', async () => {
    const crudo = '🚚'.repeat(3); // 6 unidades UTF-16, 12 bytes reales.
    const resultado = await leerTextoAcotado(
      peticionDeStream([new TextEncoder().encode(crudo)]),
      8,
    );

    expect(resultado).toEqual({ ok: false, motivo: 'demasiado_grande' });
  });
});
