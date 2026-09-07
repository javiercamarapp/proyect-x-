import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GET as getSpec } from '@/app/api/v1/openapi/route';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 18 · M19 — el área de la llave de API se escribe DOS veces: en el
// `abrir(req, '…')` de la ruta y en la `description` del OpenAPI ("Área
// `dinero`"). Nada las unía: cambiar el código a `operacion` dejaba la suite
// verde y el contrato que el integrador descarga prometiendo lo contrario.
// Misma técnica que `ruta_pdf_sincronizada.test.ts`: leer los fuentes como
// texto y comparar.
// ═══════════════════════════════════════════════════════════════════════════

const RAIZ = join(process.cwd(), 'src/app/api/v1');

/** `{ '/v1/clientes': { get: 'dinero' }, … }` leído de los route.ts reales. */
function areasDelCodigo(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  const recorrer = (dir: string, ruta: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const e = d.name;
      const p = join(dir, e);
      if (d.isDirectory()) {
        if (e !== 'openapi') recorrer(p, `${ruta}/${e.startsWith('[') ? `{${e.slice(1, -1)}}` : e}`);
        continue;
      }
      if (!d.isFile() || e !== 'route.ts') continue;
      const src = readFileSync(p, 'utf8');
      // Cada `export async function GET(...)` hasta el siguiente export: el
      // `abrir(req, 'x')` que contiene es el área de ese método.
      const bloques = src.split(/(?=export async function (?:GET|POST|PUT|PATCH|DELETE)\b)/);
      for (const b of bloques) {
        const m = /^export async function (GET|POST|PUT|PATCH|DELETE)\b/.exec(b);
        const a = /abrir\(req, '([a-z]+)'\)/.exec(b);
        if (m && a) (out[ruta] ??= {})[m[1].toLowerCase()] = a[1];
      }
    }
  };
  recorrer(RAIZ, '/v1');
  return out;
}

type Operacion = { description?: string; tags?: string[]; 'x-likida-area'?: string };

async function spec(): Promise<Record<string, Record<string, Operacion>>> {
  const r = await getSpec(new Request('https://app.likida.ai/api/v1/openapi'));
  return ((await r.json()) as { paths: Record<string, Record<string, Operacion>> }).paths;
}

describe('el área que declara el OpenAPI es la que el código pasa a abrir()', () => {
  it('CONTROL: el extractor encuentra las rutas de datos con su abrir()', () => {
    const areas = areasDelCodigo();
    expect(areas['/v1/viajes/{id}/contribucion']?.get).toBe('dinero');
    expect(areas['/v1/viajes']?.post).toBe('administracion');
    expect(Object.keys(areas).length).toBeGreaterThanOrEqual(5);
  });

  it('TODA ruta que llama abrir(req, área) la declara en `x-likida-area`, en la prosa y —si es dinero— en el tag', async () => {
    // Generalizado (M19): antes solo `dinero` estaba obligado a declararse y
    // `POST /v1/viajes` y `POST /v1/unidades` (área `administracion`) no
    // decían nada legible por máquina. Ahora cada operación con `abrir()`
    // lleva `x-likida-area` igual al argumento del código.
    const areas = areasDelCodigo();
    const paths = await spec();
    const faltan: string[] = [];
    for (const [ruta, metodos] of Object.entries(areas)) {
      for (const [metodo, areaCodigo] of Object.entries(metodos)) {
        const op = paths[ruta]?.[metodo];
        const id = `${metodo.toUpperCase()} ${ruta}`;
        if (!op) { faltan.push(`${id}: sin bloque en el spec`); continue; }
        if (op['x-likida-area'] !== areaCodigo) {
          faltan.push(`${id}: x-likida-area dice "${op['x-likida-area'] ?? '(nada)'}" y abrir() pide "${areaCodigo}"`);
        }
        // La prosa también tiene que decirlo, y decir lo mismo: es lo que lee
        // el integrador (y su abogado) al decidir qué llave entregar.
        const declarada = /[Áá]rea `([a-z]+)`/.exec(op.description ?? '')?.[1];
        if (declarada !== areaCodigo) {
          faltan.push(`${id}: la descripción dice "${declarada ?? '(nada)'}" y abrir() pide "${areaCodigo}"`);
        }
        if (areaCodigo === 'dinero' && !(op.tags ?? []).includes('dinero')) {
          faltan.push(`${id}: falta el tag "dinero"`);
        }
      }
    }
    expect(faltan, faltan.join('\n')).toEqual([]);
  }, 30_000);

  it('y al revés: toda `x-likida-area` del spec corresponde a una ruta del código con ese abrir()', async () => {
    // Un área declarada sobre una operación sin `abrir()` (o con otra) sería
    // una promesa del contrato que ningún código respalda.
    const areas = areasDelCodigo();
    const paths = await spec();
    const sobran: string[] = [];
    for (const [ruta, metodos] of Object.entries(paths)) {
      for (const [metodo, op] of Object.entries(metodos)) {
        const declarada = op['x-likida-area'];
        if (declarada === undefined) continue;
        if (areas[ruta]?.[metodo] !== declarada) {
          sobran.push(`${metodo.toUpperCase()} ${ruta}: x-likida-area "${declarada}" sin abrir() que lo respalde`);
        }
      }
    }
    expect(sobran, sobran.join('\n')).toEqual([]);
  }, 30_000);
});
