// ═══════════════════════════════════════════════════════════════════════════
// EL TOPE DE SUBIDA DE UN ARCHIVO
//
// Vive fuera del `route.ts` porque Next.js solo admite sus propios exports en
// un route handler: cualquier otro rompe el TYPECHECK del build (no el lint).
// Aquí, además, queda importable por las pruebas y por quien arme la UI.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El tope del archivo, ya en base64 (auditoría prod 22-ago-2026, ESC-14).
 *
 * ESTABA EN 16 MB CONTRA UN LÍMITE REAL DE 4.5. El cuerpo de una función
 * serverless de Vercel se corta en 4.5 MB en la plataforma, antes de que esta
 * ruta exista: todo lo que pasara de ahí moría con un 413 ajeno, sin nuestro
 * texto y sin log, mientras el número de aquí prometía doce megas.
 *
 * 4 MB de base64 ≈ 3 MB de archivo. Un Excel o un PDF de oficina caben
 * sobrados; lo que no cabe se dice con nuestras palabras y con la salida a
 * mano (partir el archivo), en vez de con una pantalla de la plataforma.
 */
export const MAX_BASE64 = 4_000_000;
// Incluye nombre, prefijo data URL y envoltura JSON; también acota campos
// desconocidos antes de materializarlos. El límite del archivo sigue aparte.
export const MAX_CUERPO_BYTES = MAX_BASE64 + 16_384;

/**
 * Peticiones por minuto por USUARIO al lector (auditoría 21, MEDIO).
 *
 * Mismo valor que `SONDAS_POR_MINUTO` de la sonda de ingesta: son endpoints
 * hermanos con el mismo llamador (un contralor adjuntando cosas al chat) y
 * un humano no pasa de un puñado por minuto. La ruta calcó la autorización
 * de ingesta pero no su límite de tasa — y aquí cada petición puede armar un
 * xlsx ENTERO en memoria (`XLSX.read` descomprime el ZIP sin tope de
 * expansión): el tamaño del cuerpo está acotado, la frecuencia no lo estaba.
 */
export const LECTURAS_POR_MINUTO = 10;
