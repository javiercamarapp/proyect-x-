// ═══════════════════════════════════════════════════════════════════════════
// EL TOPE DE SUBIDA DE UNA FOTO
//
// Vive fuera del `route.ts` porque Next.js solo admite sus propios exports en
// un route handler: cualquier otro rompe el TYPECHECK del build (no el lint).
// Aquí, además, queda importable por las pruebas y por quien arme la UI.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El tope del data-URL que entra por aquí (auditoría prod 22-ago-2026, RES-20).
 *
 * ESTABA EN 9 MB Y ESE LÍMITE NO EXISTÍA. El comentario decía que "Vercel ya
 * corta el cuerpo mucho más arriba" y es al revés: el tope de cuerpo de una
 * función serverless de Vercel es **4.5 MB**, y lo aplica la plataforma ANTES
 * de que este archivo corra. O sea que entre 4.5 y 9 MB el contralor recibía
 * un 413 de Vercel —una página de error ajena, sin nuestro texto y sin una
 * línea en el log— mientras el código creía estar dando el mensaje amable.
 *
 * 4 MB de data-URL, con medio mega de aire para cabeceras y el resto del
 * cuerpo JSON, es lo que de verdad pasa. Y en fotos: base64 infla ~1.37×, así
 * que son ~3 MB de imagen — una foto de celular normal cabe; una de 12 MP en
 * calidad máxima no, y para ésa el mensaje ahora sí llega.
 */
export const MAX_DATAURL = 4_000_000;
export const MAX_CUERPO_BYTES = MAX_DATAURL + 16_384;
