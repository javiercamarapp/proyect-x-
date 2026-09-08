// ═══════════════════════════════════════════════════════════════════════════
// DECODIFICACIÓN DE IMAGEN (CFDI/QR/código de barras) — SOLO server-side.
//
// AUDITORÍA 24 (integración): separado de `cfdi.ts` porque `sharp` y
// `zxing-wasm` tiran módulos de Node (`node:fs`, `node:module`) que rompen
// `next build` en cuanto este archivo se alcanza desde un componente de
// cliente. `cfdi.ts` se quedó con la validación/parseo puro (sin deps de
// Node) para que `cuadre/engine.ts` —que sí llega a bundles de cliente vía
// `vista.tsx`— pueda importar `esRfcValido`/`rfcChecksumOk` sin arrastrar
// esto. Ver la cabecera de `cfdi.ts` para el detalle del error que esto
// arregla.
// ═══════════════════════════════════════════════════════════════════════════

import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { readBarcodes, prepareZXingModule } from 'zxing-wasm/reader';
import { clasificarQr, type CfdiQrData, type QrLeido, type CodigoLeido } from './cfdi';

export type { CfdiQrData, QrLeido, CodigoLeido };

/**
 * zxing es WebAssembly y su cargador por defecto hace `fetch` del `.wasm`, que
 * en Node no existe. Se le pasa el binario ya leído de disco: funciona igual en
 * vitest, en `next dev` y en una función de Vercel, y evita la sorpresa clásica
 * de descubrir el wasm roto el día del deploy. `zxing-wasm` va en
 * `serverExternalPackages` (next.config.ts) para que el paquete —y su `.wasm`—
 * queden en node_modules del deploy en vez de pasar por el bundler.
 *
 * Se prepara UNA sola vez por proceso: en Vercel el contenedor se reutiliza
 * entre invocaciones, así que el costo de arranque se paga una vez, no por foto.
 */
/**
 * Dónde está el `.wasm` en disco.
 *
 * El especificador se ARMA en tiempo de ejecución a propósito. Escrito como
 * literal, Turbopack lo ve, intenta empaquetar el `.wasm` como si fuera un
 * módulo y el build revienta con "Module not found: Can't resolve 'a'" — pasó,
 * está medido. Partido en pedazos el bundler no puede analizarlo y lo deja
 * pasar como lo que es: una lectura de archivo en runtime.
 *
 * Que el archivo LLEGUE al deploy es cosa aparte, y por eso next.config.ts lo
 * mete a la fuerza con `outputFileTracingIncludes`: el tracer sigue imports, y
 * aquí justamente no hay ninguno que seguir.
 */
function rutaDelWasm(): string {
  const partes = ['zxing-wasm', 'reader', 'zxing_reader.wasm'];
  try {
    return createRequire(import.meta.url).resolve(partes.join('/'));
  } catch {
    // Si el `exports` del paquete no deja resolver el subpath, se cae a la ruta
    // física dentro de node_modules del proyecto.
    //
    // La ruta va LITERAL, no armada desde `partes`. Con segmentos variables el
    // tracer no puede saber a dónde apunta, asume que bajo `process.cwd()` se
    // puede leer cualquier cosa y se lleva el proyecto entero al bundle de la
    // función — medido: 348 archivos fuera de node_modules, incluidos `.env.local`
    // y 76 .md. Escrita entera, el destino es un solo archivo conocido.
    //
    // Esto NO reintroduce el problema que documenta el comentario de arriba: allá
    // lo que había que ocultarle al bundler era el ESPECIFICADOR de un módulo;
    // aquí es una ruta de disco, y `join` no es un import.
    return join(process.cwd(), 'node_modules', 'zxing-wasm', 'dist', 'reader', 'zxing_reader.wasm');
  }
}

let zxingPreparado: Promise<void> | null = null;
function prepararZxing(): Promise<void> {
  zxingPreparado ??= (async () => {
    const wasm = await readFile(rutaDelWasm());
    await prepareZXingModule({
      overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) },
      fireImmediately: true,
    });
  })();
  return zxingPreparado;
}

/** El ancho al que se reescala una foto antes de leer sus códigos — la
 *  primera pasada de `decodeCodigosFromImage` y la que `redimensionarParaVision`
 *  reusa para la llamada de visión (ver AUDITORÍA 25, BAJO, REND-A9). Una sola
 *  constante para que las dos no se desincronicen. */
export const ANCHO_PRINCIPAL_PX = 1600;

/** Lo que devuelve `decodificarCodigosYReducir`: los códigos de la foto y,
 *  aparte, el buffer ya reescalado a `ANCHO_PRINCIPAL_PX` — la MISMA pasada de
 *  `sharp` que se usó para buscar códigos, reusable por quien mande la foto a
 *  visión (ver AUDITORÍA 28, REN-A2/REN-B1, más abajo). */
export interface CodigosYReducida {
  codigos: CodigoLeido[];
  /** `null` si la decodificación entera falló (mismo catch de siempre) — en
   *  ese caso tampoco hay reducida que reusar y el llamador cae a su propio
   *  redimensionado. */
  reducida: Buffer | null;
}

/**
 * Lee TODOS los códigos de una foto (QR y códigos de barras 1D) Y CONSERVA la
 * pasada a `ANCHO_PRINCIPAL_PX` para que quien mande la foto a visión no la
 * vuelva a calcular.
 *
 * Por qué zxing y no jsQR: sobre la foto de campo de `__fixtures__` —un
 * acercamiento deliberado al ticket— jsQR falla en 1600, 1200 y 900 px, y aun
 * si leyera el QR no puede ver el Code93, porque jsQR solo lee 2D. El folio de
 * facturación del ticket viaja justo en ese código de barras.
 *
 * AUDITORÍA 28, REN-B1 (BAJO, reincidente de la 25): `extraerComprobante`
 * (ocr.ts) llamaba a esta decodificación Y DESPUÉS, por separado, a
 * `redimensionarParaVision` — la MISMA pasada de `ANCHO_PRINCIPAL_PX` sobre el
 * MISMO buffer, otra vez. Caso común (ticket sin código): 1600 + 1000 + 1600 =
 * 3 pasadas de `sharp` sobre un JPEG de hasta 6 MB. Aquí se conserva el buffer
 * de la primera pasada (`ANCHO_PRINCIPAL_PX`) en vez de tirarlo, así que el
 * llamador puede reusarlo: 1600 + 1000 (o solo 1600 si el CFDI/liga ya salió
 * ahí) — nunca una tercera.
 */
export async function decodificarCodigosYReducir(image: Buffer): Promise<CodigosYReducida> {
  try {
    await prepararZxing();
    // `.rotate()` aplica la orientación EXIF: sharp trabaja sobre píxeles crudos
    // y las fotos de iPhone vienen con orientación 3 (180°). Sin esto el código
    // le llega de cabeza al lector.
    //
    // Dos escalas, no más: sobre una foto de 24 Mpx la pasada a resolución
    // nativa cuesta segundos y no encuentra nada que no encuentre la de 1600 px
    // (medido el 27-jul-2026 con tickets de campo). El presupuesto del request
    // —60 s para TODA la liquidación— vale más que esa cola.
    //
    // zxing-wasm 3.1.3 (bump de zxing-cpp, ago-2026) afinó el umbral del
    // finder-pattern: en un ticket con QR + Code93 (Office Depot), a 1600 px
    // ahora solo lee el Code93 — el QR aparece hasta la pasada de 1000 px. Un
    // `return` en el primer resultado NO VACÍO cortaba ahí y se quedaba solo
    // con el código de barras, sin la liga de facturación. Se acumulan los
    // códigos de las dos pasadas (dedupe por formato+texto) y solo se corta
    // temprano cuando ya apareció el dato que de verdad importa —CFDI o liga—,
    // no con cualquier código.
    //
    // NOTA: la pasada de 1000 px SIEMPRE sale del `image` ORIGINAL, nunca del
    // JPEG ya reducido a 1600: re-codificar a JPEG cambia los píxeles, y hay un
    // ticket real (Office Depot, `codigos.test.ts`) cuyo QR solo se lee a
    // 1000 px exactos. Encadenar las pasadas rompería justo ese caso.
    const vistos = new Map<string, CodigoLeido>();
    let reducida: Buffer | null = null;
    for (const ancho of [ANCHO_PRINCIPAL_PX, 1000]) {
      const buf = await sharp(image).rotate().resize({ width: ancho, withoutEnlargement: true }).jpeg().toBuffer();
      if (ancho === ANCHO_PRINCIPAL_PX) reducida = buf;
      const leidos = await readBarcodes(new Blob([new Uint8Array(buf)]), { tryHarder: true });
      for (const r of leidos) {
        if (!r.text) continue;
        const clave = `${r.format}:${r.text}`;
        if (!vistos.has(clave)) vistos.set(clave, { ...clasificarQr(r.text), formato: r.format });
      }
      if ([...vistos.values()].some((c) => c.cfdi || c.urlFacturacion)) break;
    }
    return { codigos: [...vistos.values()], reducida };
  } catch {
    return { codigos: [], reducida: null };
  }
}

/**
 * Compatibilidad: solo los códigos, sin la reducida. `decodeQrFromImage` y las
 * pruebas de este archivo llaman esta forma; el camino nuevo que sí necesita
 * la reducida (`extraerComprobante`) usa `decodificarCodigosYReducir` directo.
 */
export async function decodeCodigosFromImage(image: Buffer): Promise<CodigoLeido[]> {
  return (await decodificarCodigosYReducir(image)).codigos;
}

/**
 * La foto reescalada a `ANCHO_PRINCIPAL_PX` (jpeg, orientación EXIF aplicada)
 * — la misma pasada que `decodeCodigosFromImage` ya hace, expuesta para que
 * el llamador que manda la foto al modelo de VISIÓN la reuse en vez de
 * mandar el original a resolución nativa.
 *
 * AUDITORÍA 25, BAJO (REND-A9, REINCIDENTE de la 24): `extraerComprobante`
 * (ocr.ts) ya calculaba este mismo buffer reducido dos líneas antes —dentro
 * de `decodeCodigosFromImage`— y lo tiraba, para acto seguido mandar el
 * data-URL ORIGINAL (hasta 6 MB, `MAX_IMAGEN_WHATSAPP_BYTES`) al modelo, y esa
 * misma llamada se reenvía hasta cuatro veces por la escalera de reintentos
 * de `openrouter.ts`.
 */
export async function redimensionarParaVision(image: Buffer): Promise<Buffer> {
  return sharp(image).rotate().resize({ width: ANCHO_PRINCIPAL_PX, withoutEnlargement: true }).jpeg().toBuffer();
}

/**
 * Un solo código de la foto, el más útil de los que haya.
 *
 * Los que fallan en campo fallan por daño FÍSICO —doblez del papel cruzando el
 * código, impresión térmica moteada, código fuera de encuadre— y contra eso
 * ningún preprocesado sirve: se probaron 10 variantes (escalas, normalise,
 * threshold, blur) sobre un recorte limpio y las 10 fallaron; un mosaico de 13
 * recortes costaba 2–4 s por foto y no rescató ni uno. Lo que sí funciona es
 * otra FOTO: el mismo ticket de cerca entra en ~100 ms. Por eso el intake
 * acepta varias imágenes por comprobante en vez de insistir sobre una sola.
 */
export async function decodeQrFromImage(image: Buffer): Promise<QrLeido | null> {
  const codigos = await decodeCodigosFromImage(image);
  if (!codigos.length) return null;
  // Prioridad: datos fiscales del SAT > liga de portal > lo que haya. Un ticket
  // puede traer QR y código de barras a la vez (Office Depot trae los dos).
  return codigos.find((c) => c.cfdi) ?? codigos.find((c) => c.urlFacturacion) ?? codigos[0];
}

/**
 * Compatibilidad: devuelve SOLO los datos fiscales del SAT.
 * Para la liga de autofacturación usar `decodeQrFromImage`.
 */
export async function decodeCfdiFromImage(image: Buffer): Promise<CfdiQrData | null> {
  const qr = await decodeQrFromImage(image);
  return qr?.cfdi && Object.keys(qr.cfdi).length ? qr.cfdi : null;
}
