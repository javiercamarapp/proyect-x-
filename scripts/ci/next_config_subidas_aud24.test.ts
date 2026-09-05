import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_ARCHIVO_SUBIDA_BYTES } from '../../src/lib/http/subidas_formulario';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24 · FE-1 (CRÍTICO) — el tope de subida que la pantalla promete
// tiene que caber en el que Next impone ANTES de ejecutar la action.
//
// `next.config.ts` no declaraba `serverActions.bodySizeLimit`, así que el
// runtime cortaba a 1 MB mientras `agentes/peajes` anunciaba 8 MB y
// `viajes` 8 MB: los mensajes «pesa demasiado» de esas pantallas eran
// inalcanzables entre 1 y 8 MB, y el archivo real rebotaba como excepción en
// el error boundary. Esta prueba lee el config y los `MAX_*_BYTES` de
// `src/app/dashboard/**` y falla si alguna pantalla promete más de lo que el
// runtime deja pasar — en cualquiera de las dos direcciones.
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = readFileSync('next.config.ts', 'utf8');

function archivosTsx(dir: string): string[] {
  const out: string[] = [];
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) out.push(...archivosTsx(ruta));
    else if (/\.tsx?$/.test(nombre) && !/\.test\.tsx?$/.test(nombre)) out.push(ruta);
  }
  return out;
}

/** `const MAX_XML_BYTES = 4 * 1024 * 1024;` → 4 MB, con su archivo. */
function topesDePantalla(): Array<{ archivo: string; nombre: string; bytes: number }> {
  const topes: Array<{ archivo: string; nombre: string; bytes: number }> = [];
  for (const archivo of archivosTsx('src/app/dashboard')) {
    const src = readFileSync(archivo, 'utf8');
    const re = /const\s+(MAX_[A-Z_]*BYTES)\s*=\s*([\d_]+)\s*\*\s*1024\s*\*\s*1024/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      topes.push({ archivo, nombre: m[1], bytes: Number(m[2].replace(/_/g, '')) * 1024 * 1024 });
    }
    for (const compartido of src.matchAll(/const\s+(MAX_[A-Z_]*BYTES)\s*=\s*MAX_ARCHIVO_SUBIDA_BYTES\b/g)) {
      topes.push({ archivo, nombre: compartido[1], bytes: MAX_ARCHIVO_SUBIDA_BYTES });
    }
  }
  return topes;
}

function limiteDeNext(): number {
  const m = /bodySizeLimit:\s*'(\d+)(kb|mb)'/i.exec(CONFIG);
  if (!m) throw new Error("next.config.ts no declara serverActions.bodySizeLimit: Next corta en 1 MB (FE-1)");
  return Number(m[1]) * (m[2].toLowerCase() === 'mb' ? 1024 * 1024 : 1024);
}

describe('FE-1 · serverActions.bodySizeLimit cubre los MAX_*_BYTES del panel', () => {
  it('las subidas que atraviesan Functions caben en4.5MB con margen para multipart', () => {
    // Next no puede elevar este límite de la plataforma:
    // https://vercel.com/docs/vercel-blob/server-upload
    for (const tope of topesDePantalla()) {
      expect(tope.bytes + 64 * 1024, `${tope.archivo}: ${tope.nombre}`).toBeLessThanOrEqual(4_500_000);
    }
  });
  it('hay al menos un tope de pantalla que medir (si no, la prueba no vigila nada)', () => {
    expect(topesDePantalla().length).toBeGreaterThanOrEqual(3);
  });

  it('el límite de Next es ≥ el mayor tope anunciado, con margen para la envoltura multipart', () => {
    const topes = topesDePantalla();
    const mayor = topes.reduce((a, b) => (b.bytes > a.bytes ? b : a));
    const limite = limiteDeNext();
    // La doc de Next 16 pide holgura para cabeceras y límites de multipart:
    // 10–20 KB bastan; se exige al menos 64 KB por encima del mayor tope.
    expect(
      limite,
      `${mayor.nombre} (${mayor.archivo}) promete ${mayor.bytes} bytes y next.config.ts solo deja pasar ${limite}`,
    ).toBeGreaterThanOrEqual(mayor.bytes + 64 * 1024);
  });
});

describe('SEG-8 · x-powered-by apagado', () => {
  it('next.config.ts declara poweredByHeader: false', () => {
    expect(CONFIG).toMatch(/poweredByHeader:\s*false/);
  });
});

describe('OP-P1 · la última migración del repo viaja al bundle', () => {
  it('next.config.ts publica LIKIDA_MIGRACION_CODIGO leyendo supabase/migrations en build', () => {
    expect(CONFIG).toMatch(/LIKIDA_MIGRACION_CODIGO:\s*ultimaMigracionDelRepo\(\)/);
    expect(CONFIG).toMatch(/readdirSync\('supabase\/migrations'\)/);
  });
});
