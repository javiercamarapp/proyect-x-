export type ResultadoTextoAcotado =
  | { ok: true; texto: string; bytes: number }
  | { ok: false; motivo: 'demasiado_grande' | 'lectura_fallida' };

export async function leerTextoAcotado(
  req: Request,
  maxBytes: number,
): Promise<ResultadoTextoAcotado> {
  const declaradoCrudo = req.headers.get('content-length');
  if (declaradoCrudo !== null) {
    const declarado = Number(declaradoCrudo);
    if (Number.isFinite(declarado) && declarado > maxBytes) {
      return { ok: false, motivo: 'demasiado_grande' };
    }
  }

  if (!req.body) return { ok: true, texto: '', bytes: 0 };

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
  return { ok: true, texto: new TextDecoder().decode(bytes), bytes: total };
}
