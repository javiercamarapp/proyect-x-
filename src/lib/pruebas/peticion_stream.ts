/** Petición chunked real, sin precarga: permite observar cuánto leyó la ruta
 * y si canceló antes de consumir el resto del cuerpo. Sólo arneses. */
export function peticionStream(url: string, texto: string, tamanoChunk = 65_536) {
  const bytes = new TextEncoder().encode(texto);
  let leidos = 0;
  let cancelado = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (leidos === bytes.length) { controller.close(); return; }
      const fin = Math.min(leidos + tamanoChunk, bytes.length);
      controller.enqueue(bytes.slice(leidos, fin));
      leidos = fin;
    },
    cancel() { cancelado = true; },
  }, { highWaterMark: 0 });
  const req = Object.assign(new Request(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
    duplex: 'half',
  } as RequestInit), { nextUrl: new URL(url) });
  return { req, estado: () => ({ leidos, total: bytes.length, cancelado }) };
}
