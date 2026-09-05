// Las Server Actions reciben el archivo dentro de una Vercel Function.
// 4 MiB deja margen para multipart bajo el límite de transporte de4.5MB:
// https://vercel.com/docs/vercel-blob/server-upload
export const MAX_ARCHIVO_SUBIDA_BYTES = 4 * 1024 * 1024;
export const MENSAJE_ARCHIVO_GRANDE = 'Máximo 4 MB por archivo. Divide el archivo en partes más pequeñas o reduce la foto.';

/** La validación nativa evita enviar el archivo excesivo. El servidor repite
 * el límite; la selección de otro archivo limpia el error anterior. */
export function validarArchivoElegido(input: HTMLInputElement): void {
  const archivo = input.files?.[0];
  input.setCustomValidity(archivo && archivo.size > MAX_ARCHIVO_SUBIDA_BYTES ? MENSAJE_ARCHIVO_GRANDE : '');
}
