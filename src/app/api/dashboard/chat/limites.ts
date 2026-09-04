// 12 turnos de 2,000 unidades UTF-16 + extracto de 16,000, nombre y JSON.
// 256 KiB admite también Unicode y la expansión de escapes JSON (hasta6x).
// Acota el transporte antes del parseo; no sustituye las cotas semánticas.
export const MAX_CHAT_BYTES = 256 * 1024;
