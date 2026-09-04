export type ResultadoTextoAcotado =
  | { ok: true; texto: string; bytes: number }
  | { ok: false; motivo: 'demasiado_grande' | 'lectura_fallida' };

export type ResultadoBytesAcotados =
  | { ok: true; datos: Uint8Array<ArrayBuffer>; bytes: number }
  | { ok: false; motivo: 'demasiado_grande' | 'lectura_fallida' };

/** Conserva bytes binarios; el límite incluye campos y envoltura multipart. */
export async function leerBytesAcotados(
  req: Request,
  maxBytes: number,
): Promise<ResultadoBytesAcotados> {
  const declaradoCrudo = req.headers.get('content-length');
  if (declaradoCrudo !== null) {
    const declarado = Number(declaradoCrudo);
    if (Number.isFinite(declarado) && declarado > maxBytes) {
      return { ok: false, motivo: 'demasiado_grande' };
    }
  }

  if (!req.body) return { ok: true, datos: new Uint8Array(0), bytes: 0 };

  const lector = req.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await lector.cancel().catch(() => undefined);
        return { ok: false, motivo: 'demasiado_grande' };
      }
      partes.push(value);
    }
  } catch {
    return { ok: false, motivo: 'lectura_fallida' };
  } finally {
    lector.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const parte of partes) {
    bytes.set(parte, offset);
    offset += parte.byteLength;
  }
  return { ok: true, datos: bytes, bytes: total };
}

export async function leerTextoAcotado(
  req: Request,
  maxBytes: number,
): Promise<ResultadoTextoAcotado> {
  const resultado = await leerBytesAcotados(req, maxBytes);
  if (!resultado.ok) return resultado;
  return { ok: true, texto: new TextDecoder().decode(resultado.datos), bytes: resultado.bytes };
}
