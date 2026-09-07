// ═══════════════════════════════════════════════════════════════════════════
// TOOLS REALES PARA LOS AUDITORES — la automejora estructural.
//
// Ronda 1 (snapshot): los agentes fabricaron 31/39 `archivo:línea` (la
// adversarial los tiró). La mejora no es de modelo, es de herramientas:
// los auditores ahora leen el repo (leer) y citan SOLO lo que abrieron.
// Acceso restringido a directorios del proyecto: nada de `../`.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';

export const TOOLS_DEF = [
  {
    type: 'function',
    function: {
      name: 'leer',
      description: 'Lee un archivo del repo (ruta relativa a la raíz). Opcional: desde (línea inicial) y lineas (cantidad a mostrar).',
      parameters: {
        type: 'object',
        properties: { ruta: { type: 'string' }, desde: { type: 'number' }, lineas: { type: 'number' } },
        required: ['ruta'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar',
      description: 'Busca una regex dentro de un directorio (default src/) y devuelve hasta N coincidencias archivo:línea: texto.',
      parameters: {
        type: 'object',
        properties: { patron: { type: 'string' }, dir: { type: 'string' }, tope: { type: 'number' } },
        required: ['patron'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listar',
      description: 'Lista archivos/directorios de una ruta relativa.',
      parameters: {
        type: 'object',
        properties: { ruta: { type: 'string' } },
        required: ['ruta'],
      },
    },
  },
] as const;

const RAICES = ['src', 'scripts', 'docs', 'normas', 'supabase', 'pruebas-manuales', 'public', 'lib', 'components'];

function rutaSegura(ruta: string): string {
  const limpia = ruta.replace(/^\/+/, '').replaceAll('..', '').replace(/^\.\//, '');
  if (limpia === '' || RAICES.includes(limpia.split('/')[0]!)) return limpia;
  throw new Error(`ruta no permitida: ${ruta} (permitido: ${RAICES.join(', ')})`);
}

function leerTool(args: { ruta?: string; desde?: number; lineas?: number }): string {
  const p = rutaSegura(args.ruta ?? '');
  const abs = join(process.cwd(), p);
  if (!existsSync(abs)) return `(no existe: ${p})`;
  const lineasArr = readFileSync(abs, 'utf8').split('\n');
  const desde = Math.max(1, args.desde ?? 1);
  const hasta = Math.min(lineasArr.length, desde + (args.lineas ?? 120) - 1);
  let bloque = lineasArr.slice(desde - 1, hasta).map((l, i) => `${desde + i}: ${l}`).join('\n');
  if (bloque.length > 14_000) bloque = bloque.slice(0, 14_000) + '\n…[recorte]';
  return `--- ${p} (${lineasArr.length} líneas, mostrando ${desde}-${hasta}) ---\n${bloque}`;
}

function buscarTool(args: { patron?: string; dir?: string; tope?: number }): string {
  const pat = args.patron ?? '';
  if (!pat) return '(falta patrón)';
  try {
    new RegExp(pat);
  } catch {
    return `(regex inválida: ${pat})`;
  }
  const re = new RegExp(pat);
  const dirBase = (args.dir ?? 'src').replace(/^\/+/, '').replaceAll('..', '');
  const absBase = join(process.cwd(), dirBase);
  if (!existsSync(absBase)) return `(no existe directorio ${dirBase})`;
  const tope = Math.min(args.tope ?? 30, 60);
  const salida: string[] = [];
  const skip = (f: string) => f.includes('node_modules') || f.startsWith('.') || f.includes('/.next');
  const walk = (d: string): void => {
    if (salida.length >= tope) return;
    let items: Dirent[];
    try {
      items = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (salida.length >= tope) return;
      const full = join(d, it.name);
      if (skip(full)) continue;
      if (it.isDirectory()) {
        walk(full);
        continue;
      }
      if (!it.isFile()) continue;
      if (!/\.([jt]sx?|mjs|cjs|yaml|sql|md|css|html)$/.test(it.name)) continue;
      try {
        const lineasArr = readFileSync(full, 'utf8').split('\n');
        for (let i = 0; i < lineasArr.length && salida.length < tope; i++) {
          if (re.test(lineasArr[i]!)) {
            salida.push(`${relative(process.cwd(), full)}:${i + 1}: ${lineasArr[i]!.trim().slice(0, 150)}`);
          }
        }
      } catch {
        /* binario o sin permiso */
      }
    }
  };
  walk(absBase);
  return salida.length ? salida.join('\n') : `(sin coincidencias de /${pat}/ en ${dirBase})`;
}

function listarTool(args: { ruta?: string }): string {
  const p = args.ruta && args.ruta !== '.' ? rutaSegura(args.ruta) : '';
  const abs = join(process.cwd(), p);
  if (!existsSync(abs)) return `(no existe: ${p || '.'})`;
  const items = readdirSync(abs).sort();
  const detalle = items.slice(0, 80).map((it) => {
    const full = join(abs, it);
    let tipo = 'file';
    try {
      tipo = statSync(full).isDirectory() ? 'dir' : 'file';
    } catch {
      /* ignorar */
    }
    return `${tipo}  ${p ? p + '/' : ''}${it}`;
  });
  return detalle.join('\n') || '(vacío)';
}

export function ejecutarTool(nombre: string, argStr: string): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argStr) as Record<string, unknown>;
  } catch {
    /* args vacíos */
  }
  try {
    if (nombre === 'leer') return leerTool(args as { ruta?: string; desde?: number; lineas?: number });
    if (nombre === 'buscar') return buscarTool(args as { patron?: string; dir?: string; tope?: number });
    if (nombre === 'listar') return listarTool(args as { ruta?: string });
    return `(tool desconocida: ${nombre})`;
  } catch (e) {
    return `ERROR: ${String((e as Error).message)}`;
  }
}