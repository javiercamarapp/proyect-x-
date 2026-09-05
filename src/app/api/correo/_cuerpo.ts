/**
 * Leer el cuerpo de un webhook SIN pasarse del tope, aunque el emisor mienta.
 *
 * Vivía como función privada de `correo/entrante/route.ts`. Sube aquí por la
 * AUDITORÍA 24 (BE-21): `correo/eventos` hacía `await req.text()` y MEDÍA
 * DESPUÉS, así que un POST `chunked` sin `content-length` —y sin ninguna
 * cabecera svix, o sea sin haber demostrado nada— materializaba en memoria lo
 * que quisiera antes de que el 413 llegara. El tope tiene que aplicarse
 * mientras se lee, no cuando ya está adentro.
 *
 * Devuelve `null` cuando el cuerpo se pasa: quien llama contesta 413. Las dos
 * rutas necesitan el cuerpo CRUDO (un `JSON.parse` + `stringify` reordena
 * llaves y la firma dejaría de cuadrar), por eso devuelve texto y no un objeto.
 */
import { leerTextoAcotado } from '@/lib/http/cuerpo_acotado';

export async function cuerpoAcotado(req: Request, maxBytes: number): Promise<string | null> {
  const resultado = await leerTextoAcotado(req, maxBytes);
  if (resultado.ok) return resultado.texto;
  if (resultado.motivo === 'demasiado_grande') return null;
  throw new Error('No se pudo leer el cuerpo del webhook.');
}
