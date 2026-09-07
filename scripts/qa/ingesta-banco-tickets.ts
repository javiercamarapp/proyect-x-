// ═══════════════════════════════════════════════════════════════════════════
// METE UNA CARPETA DE TICKETS REALES AL BANCO DE QA — bytes al bucket, ficha a
// la tabla, y la VERDAD-DE-TERRENO que un humano leyó mirando cada foto.
//
//   npx tsx scripts/qa/ingesta-banco-tickets.ts <carpeta> <verdad.json>
//   npx tsx scripts/qa/ingesta-banco-tickets.ts <carpeta> <verdad.json> --aplicar
//
// Sin `--aplicar` NO escribe nada: dice exactamente qué haría. El default es el
// ensayo porque esto sube archivos a Storage y ahí no hay deshacer.
//
// ── POR QUÉ LAS IMÁGENES NO ESTÁN EN EL REPO ─────────────────────────────────
//
// Este script recibe la carpeta y el JSON POR ARGUMENTO, nunca por una ruta
// escrita aquí, y ninguno de los dos vive en el árbol de git. No es un detalle
// de comodidad: un ticket real trae RFC, domicilio y a veces el nombre del
// titular (LFPDPPP art. 2 fr. VI), el repo de Likida es PÚBLICO, y el
// `.gitignore` ya excluye imágenes de comprobantes. Codificar la ruta aquí
// sería el primer paso para que alguien "acomode" los archivos dentro del repo
// para que el script funcione sin argumentos.
//
// ── LA IDEMPOTENCIA ES UNA RESTRICCIÓN, NO UN `if` ──────────────────────────
//
// Correrlo dos veces no puede duplicar nada, y quien lo garantiza es el
// `unique` de `qa_foto.hash` (migración 0185), no una comprobación previa de
// este script. `subirFotos` lee el banco antes de subir bytes —eso ahorra red—
// pero cuando el insert choca con el 23505 lo trata como lo que es: un
// duplicado, no un error. Entre la lectura y el insert cabe otra corrida, y ahí
// el `if` pierde y la restricción gana.
//
// El caso está en el material: dos de las 91 fotos son copias byte a byte la
// una de la otra. Entran 91 archivos y quedan 90 filas, y este script lo DICE
// en vez de que el conteo salga cuadrado por accidente.
//
// ── EL RELOJ ────────────────────────────────────────────────────────────────
//
// Itera sobre decenas de archivos subiendo megabytes a Storage. Aunque corre en
// una terminal y no en una función serverless, lleva el mismo presupuesto de
// tiempo que exige el patrón del PR #152 y por la misma razón: un motor que
// itera sin mirar el reloj se muere a la mitad y NO DICE cuáles se quedaron
// fuera. Aquí las que no alcanzan turno se listan por nombre al final, y el
// proceso sale con código 1 para que nadie lea "terminó" donde dice "terminó a
// medias". Volver a correrlo retoma justo ahí, porque el dedup es de la base.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { supabaseAdmin } from '../../src/lib/supabase/admin';
import { subirFotos, confirmarVerdadTerreno, type ArchivoNuevo } from '../../src/lib/admin/qa-storage';
import { validarVerdadTerreno, type VerdadTerreno } from '../../src/lib/admin/qa-tipos';

const APLICAR = process.argv.includes('--aplicar');
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));

/** Presupuesto por default: 10 minutos. Se puede acortar con --minutos=N. */
const MINUTOS = (() => {
  const a = process.argv.find((x) => x.startsWith('--minutos='));
  const n = a ? Number(a.slice('--minutos='.length)) : 10;
  return Number.isFinite(n) && n > 0 && n <= 120 ? n : 10;
})();

/** Los formatos que el flujo real de WhatsApp entrega. Un `.HEIC` NO entra: el
 *  banco tiene que parecerse a producción, y producción nunca ve un HEIC. Se
 *  convierte antes, fuera de aquí: `sips -s format jpeg <in> --out <out>`. */
const EXTENSIONES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

interface FichaCruda { archivo?: unknown }

function di(linea: string): void {
  console.log(linea);
}

function morir(motivo: string): never {
  console.error(`\n✗ ${motivo}\n`);
  process.exit(1);
}

/** Lee el JSON de verdad-de-terreno y lo valida ficha por ficha.
 *
 *  Valida TODO antes de subir un solo byte. Una ficha mal formada a la mitad
 *  del lote dejaría el banco con fotos sin etiqueta y sin forma de saber
 *  cuáles: y una foto sin etiqueta no es "una foto que está bien", es una que
 *  nadie puede usar para medir al OCR. Se cae antes de empezar y se dice qué
 *  ficha está mal. */
function leerVerdad(ruta: string): Map<string, VerdadTerreno> {
  let crudo: unknown;
  try {
    crudo = JSON.parse(readFileSync(ruta, 'utf8'));
  } catch (e) {
    morir(`no se pudo leer ${ruta}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const fotos = (crudo as { fotos?: unknown })?.fotos;
  if (!Array.isArray(fotos)) morir(`${ruta} no trae un arreglo \`fotos\``);

  const porArchivo = new Map<string, VerdadTerreno>();
  const problemas: string[] = [];
  for (const ficha of fotos as FichaCruda[]) {
    const archivo = typeof ficha?.archivo === 'string' ? ficha.archivo : null;
    if (!archivo) { problemas.push('una ficha no dice a qué `archivo` corresponde'); continue; }
    if (porArchivo.has(archivo)) { problemas.push(`${archivo}: dos fichas para el mismo archivo`); continue; }
    const v = validarVerdadTerreno(ficha);
    if (!v.ok) { problemas.push(`${archivo}: ${v.error}`); continue; }
    porArchivo.set(archivo, v.datos);
  }
  if (problemas.length > 0) {
    morir(`la verdad-de-terreno tiene ${problemas.length} ficha(s) inválida(s):\n  - ${problemas.join('\n  - ')}`);
  }
  return porArchivo;
}

function listarImagenes(carpeta: string): string[] {
  let entradas: string[];
  try {
    entradas = readdirSync(carpeta);
  } catch (e) {
    morir(`no se pudo abrir la carpeta ${carpeta}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return entradas
    .filter((n) => !n.startsWith('.'))
    .filter((n) => {
      const ext = extname(n).toLowerCase();
      if (ext === '.heic') {
        // Se DICE, no se ignora en silencio: un HEIC olvidado en la carpeta es
        // una foto que el operador cree que entró al banco y no entró.
        di(`  ⚠ ${n}: HEIC sin convertir — el flujo real entrega JPEG. Conviértelo con \`sips -s format jpeg\` y vuelve a correr.`);
        return false;
      }
      return ext in EXTENSIONES;
    })
    .filter((n) => statSync(join(carpeta, n)).isFile())
    .sort();
}

async function main(): Promise<void> {
  if (ARGS.length < 2) {
    morir('uso: npx tsx scripts/qa/ingesta-banco-tickets.ts <carpeta-de-jpeg> <verdad-terreno.json> [--aplicar] [--minutos=N]');
  }
  const carpeta = resolve(ARGS[0]);
  const rutaVerdad = resolve(ARGS[1]);
  const venceEn = Date.now() + MINUTOS * 60_000;

  di(`\nBANCO DE TICKETS — ${APLICAR ? 'APLICANDO' : 'ENSAYO (nada se escribe; usa --aplicar)'}`);
  di(`  carpeta : ${carpeta}`);
  di(`  verdad  : ${rutaVerdad}`);
  di(`  reloj   : ${MINUTOS} min\n`);

  const verdad = leerVerdad(rutaVerdad);
  const imagenes = listarImagenes(carpeta);
  di(`· ${imagenes.length} imagen(es) legible(s) en la carpeta, ${verdad.size} ficha(s) de verdad-de-terreno.`);

  // Cotejo cruzado ANTES de tocar la red. Los dos huecos importan y son
  // distintos: una foto sin ficha entraría al banco como material que nadie
  // puede usar para medir; una ficha sin foto significa que alguien etiquetó
  // algo que no está, y eso normalmente es un archivo renombrado.
  const sinFicha = imagenes.filter((n) => !verdad.has(n));
  const sinArchivo = [...verdad.keys()].filter((n) => !imagenes.includes(n));
  if (sinFicha.length > 0) di(`  ⚠ ${sinFicha.length} sin verdad-de-terreno: ${sinFicha.join(', ')}`);
  if (sinArchivo.length > 0) di(`  ⚠ ${sinArchivo.length} ficha(s) sin archivo en disco: ${sinArchivo.join(', ')}`);

  if (!APLICAR) {
    di(`\n· ENSAYO: subiría ${imagenes.length} archivo(s) y confirmaría ${imagenes.length - sinFicha.length} ficha(s).`);
    di('  Nada se escribió. Vuelve a correr con --aplicar.\n');
    return;
  }

  const db = supabaseAdmin();

  // ── Los bytes y la fila ───────────────────────────────────────────────────
  // Se sube por tandas para no cargar 300 MB en memoria y para poder mirar el
  // reloj entre una y otra. `subirFotos` ya reporta la suerte de CADA archivo
  // por separado, así que una foto rechazada no tira el lote.
  const TANDA = 10;
  const idPorArchivo = new Map<string, string>();
  const fallos: string[] = [];
  const duplicadas: string[] = [];
  const sinTurno: string[] = [];

  for (let i = 0; i < imagenes.length; i += TANDA) {
    if (Date.now() >= venceEn) { sinTurno.push(...imagenes.slice(i)); break; }
    const tanda = imagenes.slice(i, i + TANDA);
    const archivos: ArchivoNuevo[] = tanda.map((n) => ({
      nombre: n,
      mime: EXTENSIONES[extname(n).toLowerCase()],
      bytes: readFileSync(join(carpeta, n)),
    }));

    const r = await subirFotos(db, archivos);
    if (!r.ok) morir(`la subida se detuvo: ${r.error}`);

    for (const res of r.datos.resultados) {
      if (res.error) { fallos.push(`${res.nombre}: ${res.error}`); continue; }
      if (res.id) idPorArchivo.set(res.nombre, res.id);
      // `duplicadoDe` trae la etiqueta de la foto que YA estaba con ese hash.
      // Cuando esa etiqueta es OTRO nombre de archivo, son dos archivos con los
      // mismos bytes: el `unique` los colapsó, que es exactamente su trabajo.
      if (res.duplicadoDe && res.duplicadoDe !== res.nombre) {
        duplicadas.push(`${res.nombre} ≡ ${res.duplicadoDe}`);
      }
    }
    di(`  · ${Math.min(i + TANDA, imagenes.length)}/${imagenes.length} subidas`);
  }

  di(`\n· bytes: ${idPorArchivo.size} foto(s) con fila en el banco.`);
  if (duplicadas.length > 0) {
    di(`  · ${duplicadas.length} colapsada(s) por hash (mismos bytes, otro nombre): ${duplicadas.join(', ')}`);
  }
  if (fallos.length > 0) di(`  ✗ ${fallos.length} fallo(s):\n    - ${fallos.join('\n    - ')}`);

  // ── La verdad-de-terreno ──────────────────────────────────────────────────
  // Va DESPUÉS y por separado a propósito: los bytes son de la foto y la
  // etiqueta es de la persona que la leyó. Si esto falla, el banco queda con
  // fotos sin confirmar — que es un estado honesto y recuperable (`ocr_esperado
  // is null` significa "nadie lo ha confirmado", no "está bien"). Al revés no:
  // una etiqueta sin bytes no serviría para nada.
  let confirmadas = 0;
  const fallosVerdad: string[] = [];
  for (const [archivo, id] of idPorArchivo) {
    if (Date.now() >= venceEn) { sinTurno.push(`${archivo} (sin confirmar la ficha)`); continue; }
    const v = verdad.get(archivo);
    if (!v) continue;
    // `confirmadoPor` va en null a propósito: esto lo corrió un script, no una
    // persona con sesión. La columna admite null y el CHECK de la 0185 solo
    // exige `confirmado_en`, que sí se escribe. Mentir con el uuid de un
    // superadmin cualquiera sería peor: diría que alguien firmó esta lectura.
    const r = await confirmarVerdadTerreno(db, id, v, null);
    if (r.ok) confirmadas++;
    else fallosVerdad.push(`${archivo}: ${r.error}`);
  }

  di(`· verdad-de-terreno: ${confirmadas} ficha(s) confirmada(s).`);
  if (fallosVerdad.length > 0) di(`  ✗ ${fallosVerdad.length} no se pudo(ieron) escribir:\n    - ${fallosVerdad.join('\n    - ')}`);

  // ── El reloj, dicho ───────────────────────────────────────────────────────
  if (sinTurno.length > 0) {
    di(`\n⚠ SE ACABÓ EL TIEMPO (${MINUTOS} min). ${sinTurno.length} se quedaron sin turno:`);
    for (const n of sinTurno) di(`    - ${n}`);
    di('  Vuelve a correrlo: el dedup es del `unique` de la base, así que retoma donde quedó.');
  }

  const malParado = fallos.length + fallosVerdad.length + sinTurno.length;
  di(malParado === 0 ? '\n✓ Todo entró.\n' : `\n✗ Terminó a medias: ${malParado} pendiente(s).\n`);
  if (malParado > 0) process.exit(1);
}

main().catch((e) => morir(e instanceof Error ? e.message : String(e)));
