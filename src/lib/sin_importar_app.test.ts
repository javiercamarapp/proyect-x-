/* eslint-disable security/detect-non-literal-fs-filename --
 * Esta prueba ES un barrido del árbol de src/lib: lee archivos cuyo nombre
 * sale de `fuentesDeProduccion` sobre nuestro propio repo, en tiempo de test,
 * sin entrada externa. Mismo patrón que seudonimo_puerta_unica.test.ts. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fuentesDeProduccion, sinComentarios } from './pruebas/codigo';

// ═══════════════════════════════════════════════════════════════════════════
// GUARDIÁN OPCIONAL DE ARQ-B1 (auditoría 28) — `lib` NO IMPORTA DE `app`.
//
// El hallazgo original (`calcom.ts:489` haciendo `await import('@/app/api/
// webhook/calcom/route')`) era invisible al grep estático porque el import
// era DINÁMICO — nadie lo midió hasta que la auditoría lo leyó a mano. Este
// guardián barre TODO `src/lib/**` (sin comentarios, para no reventar con la
// propia explicación del hallazgo) buscando `@/app/` tanto en `from '...'`
// como en `import('...')`, y lo compara contra una lista CERRADA de las
// inversiones YA conocidas y medidas (`oficina_wa.ts`, `mcp/credencial.ts` —
// ninguna de las dos es de este lote). Un archivo nuevo con la misma
// dependencia invertida pone esta prueba en rojo con un mensaje que dice qué
// hacer, en vez de esperar a la próxima auditoría manual.
// ═══════════════════════════════════════════════════════════════════════════

const RAIZ = join(__dirname, '..', '..');
const LIB = __dirname;

/** `@/app/...` citado como especificador de módulo, en `from '...'` o en
 *  `import('...')` — las dos formas que importan de verdad (una cadena en
 *  medio de una frase no matchea: exige la comilla de apertura del import). */
const RE_APP_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*)['"](@\/app\/[^'"]+)['"]/;

/**
 * Inversiones YA conocidas y medidas (auditoría 28, ARQ-B1) — NINGUNA es de
 * este lote:
 *  · `oficina_wa.ts:7` — `gastoChatHoyUsd`/`topeDiaUsd` de
 *    `@/app/api/dashboard/chat/tope` (el tope de gasto del chat vive en la
 *    ruta que lo expone al panel).
 *  · `mcp/credencial.ts:20` — `areaDeLlaveAlcanza` de `@/app/api/v1/_comun`
 *    (el mapa de áreas del API v1 vive junto a las rutas que lo usan).
 * Añadir un archivo aquí exige la misma medición que estas dos, escrita.
 */
const INVERSIONES_CONOCIDAS = [
  'src/lib/likida/oficina_wa.ts',
  'src/lib/mcp/credencial.ts',
];

function archivosConInversion(): string[] {
  return fuentesDeProduccion(LIB)
    .filter((ruta) => RE_APP_IMPORT.test(sinComentarios(readFileSync(ruta, 'utf8'))))
    .map((ruta) => relative(RAIZ, ruta).split(sep).join('/'))
    .sort();
}

describe('src/lib/** no importa de src/app/** fuera de la lista cerrada (ARQ-B1)', () => {
  it('ningún archivo NUEVO de lib importa de app (ni con `from`, ni con `import()` dinámico)', () => {
    const encontradas = archivosConInversion();
    const nuevas = encontradas.filter((r) => !INVERSIONES_CONOCIDAS.includes(r));
    expect(
      nuevas,
      'Un archivo de lib/ importa de app/ — dependencia invertida — y no está en ' +
      'INVERSIONES_CONOCIDAS (este archivo, src/lib/sin_importar_app.test.ts). ' +
      'Si es a propósito y ya la mediste, documenta por qué y añádela a la lista. ' +
      'Si es evitable (el caso de calcom.ts → route.ts, ARQ-B1), extrae la función ' +
      'a lib/ e importa ESTÁTICAMENTE desde ahí, como se hizo con calcom_webhook.ts.\n\n' +
      `Encontradas: ${nuevas.join(', ')}`,
    ).toEqual([]);
  });

  it('las inversiones conocidas siguen existiendo (si una se fue, bájala de la lista)', () => {
    const encontradas = archivosConInversion();
    const desaparecidas = INVERSIONES_CONOCIDAS.filter((r) => !encontradas.includes(r));
    expect(
      desaparecidas,
      `Una inversión conocida ya no importa de app/ — bájala de INVERSIONES_CONOCIDAS: ${desaparecidas.join(', ')}`,
    ).toEqual([]);
  });

  it('el barrido no está ciego: encuentra las dos inversiones conocidas de verdad', () => {
    expect(archivosConInversion()).toEqual(INVERSIONES_CONOCIDAS.slice().sort());
  });
});
