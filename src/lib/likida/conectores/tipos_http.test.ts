import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpReal } from './tipos';

describe('httpReal canónico', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('preserva encabezados normalizados para Retry-After y fuerza redirect manual', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":false}', {
      status: 429,
      headers: { 'Retry-After': '7', 'X-Request-Id': 'req-1' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const respuesta = await httpReal()({ url: 'https://api.example.test/x', metodo: 'GET' });

    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/x', expect.objectContaining({ redirect: 'manual' }));
    expect(respuesta.encabezados).toMatchObject({ 'retry-after': '7', 'x-request-id': 'req-1' });
  });
});
