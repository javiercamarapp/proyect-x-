import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 21, ALTO — REINCIDENTE (c18, c19, c20). `repo.ts`/`pg.ts` dejaron
// de ser "el único punto de acceso a datos" (MAPA.md, CLAUDE.md) hace tres
// rondas: 128 → 171 → 186 → 243 archivos de producción llaman a Supabase
// directo, y el guardia que debía crecer con el árbol (`acotada_guardiana.
// test.ts`, una allowlist literal de rutas) no se enteró ni una vez — los
// módulos más nuevos (el MCP entero, `agentes/*`, `marketing/*`,
// `sat_descarga/*`) nunca entraron a ninguna lista.
//
// Migrar los ~240 de golpe es demasiado riesgoso para hacerlo en esta pasada.
// ESTO ES EL MECANISMO DE CONTENCIÓN, NO LA MIGRACIÓN: congela el número
// medido HOY (barriendo `src/` completo, no una lista literal — el error que
// ya mató al guardia anterior) y hace que la suite se ponga roja si el
// conteo SUBE sin que alguien lo note y mueva la constante a mano, con un
// commit que lo explique. Bajarlo (migrar código a `repo.ts`) es bienvenido:
// el techo se ajusta hacia abajo el mismo día.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Medido a mano el 29-ago-2026 (auditoría 21), con el mismo método que la
 * serie de la auditoría: archivos de producción — sin `.test.`/`.fixture.`/
 * `pruebas-manuales` — con al menos un `.from(`/`.rpc(`, SIN contar
 * `repo.ts` ni `pg.ts` (la frontera declarada). Es un TECHO, no un objetivo:
 * si sube, actualiza este número en el mismo commit que explica por qué.
 *
 * AUDITORÍA 24 — 241 → 251 tras fusionar las 15 ramas (medido con el
 * barrido completo sobre el árbol integrado, no sumando los deltas
 * parciales que cada constructor midió contra su propia base). Los diez
 * módulos nuevos: `repo_paginado.ts` (frontend-op, FE-2/3/6), `revision.ts`
 * (revision, cierre humano de liquidaciones), `gasto_correccion.ts`
 * (agentico, WA-3), `interruptor_tenant.ts` (integración, ADM-6),
 * `importacion/unidades.ts`, `importacion/operadores.ts`, `terminales.ts`
 * (masivo, alta masiva para 800 tractos), y tres más del mismo patrón
 * (un módulo más con acceso directo, no un reemplazo de `repo.ts`/`pg.ts`)
 * en los carriles de `datos`/`auth`/`admin`. Ninguno migra código YA
 * existente fuera de la frontera; todos son funcionalidad nueva del
 * piloto que cuenta contra el techo como cualquier otro módulo directo.
 *
 * AUDITORÍA 25 — 251 → 252 (BE-C1a/BE-C1b/DATOS-C1). Un módulo nuevo,
 * `revision_recalculo.ts`: sube/archiva el PDF regenerado en Storage
 * (`.storage.from(...)`, que la misma regexp de este guardia cuenta —
 * "`.from(`" sin distinguir tabla de bucket) y llama la RPC dedicada
 * `agregar_pdf_historial`. Ninguno de los dos cabe en `repo.ts` como un
 * wrapper más sin que `repo.ts` empiece a saber de PDFs y de la ruta del
 * bucket de `liquidaciones` — el mismo molde que ya siguen `tools.ts` y
 * `processor.ts` (ambos fuera de la frontera, ambos suben a ese bucket
 * directo). Funcionalidad nueva, no código migrado.
 *
 * AUDITORÍA 28, ARQ-M1 (LA UNIDAD EQUIVOCADA): hasta aquí el techo vivía en
 * ARCHIVOS — y con 252 archivos medidos contra un techo de 252, este guardia
 * llevaba CERO margen: cualquier archivo nuevo con un solo `.from(`/`.rpc(`
 * lo rompía, aunque fuera trivial, mientras que quien quisiera colar código
 * de verdad arriesgado —cientos de consultas nuevas sin `traerTodo`/`acotada`
 * dentro de un archivo YA listado, como `processor.ts` o `analytics.ts`—
 * pasaba invisible: el conteo de archivos no se mueve un ápice si el bulto
 * crece DENTRO de un archivo que ya estaba fuera de la frontera. Contar
 * archivos mide "cuántos lugares nuevos violan la regla", no "cuánto código
 * la viola" — y es el código, no el archivo, el que se recorta a 1,000 filas
 * en silencio cuando le falta paginar (la misma familia de bug que ARQ-A1
 * encontró en `lineasEccParaCuadre`, cuadre/desde_db.ts).
 *
 * El techo ahora es la SUMA de `.from(`/`.rpc(` en esos mismos archivos:
 * medido hoy en 1,278 (barrido completo, mismo método, mismo commit que este
 * cambio). El margen (50) es deliberadamente angosto por la misma razón que
 * el de archivos lo era: un techo que absorbe crecimiento grande sin
 * pestañear deja de medir nada — igual que el de arriba, se sube a mano, en
 * el commit que explica por qué.
 */
const TECHO_ARCHIVOS_FUERA_DE_LA_FRONTERA = 252;
const TECHO_LLAMADAS_FUERA_DE_LA_FRONTERA = 1_328;

const RAIZ_SRC = new URL('../../', import.meta.url).pathname;

/** La frontera declarada — los dos únicos archivos donde `.from(`/`.rpc(`
 *  directo está permitido sin contar contra el techo. */
const FRONTERA = new Set(['lib/likida/repo.ts', 'lib/likida/pg.ts']);

/** Todos los `.ts`/`.tsx` de `src/`, excluyendo pruebas, fixtures y el
 *  directorio de pruebas manuales — EL BARRIDO, no una lista literal. La
 *  lista literal es exactamente lo que dejó ciego al guardia anterior
 *  (`acotada_guardiana.test.ts` cita esa lección: un módulo nuevo que no se
 *  da de alta a mano no lo ve nadie). */
function fuentesDeProduccion(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'pruebas-manuales') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { fuentesDeProduccion(p, acc); continue; }
    if (!/\.(ts|tsx)$/.test(e)) continue;
    if (/\.test\.tsx?$/.test(e) || /\.fixture\.tsx?$/.test(e)) continue;
    acc.push(p);
  }
  return acc;
}

function tieneAccesoDirecto(ruta: string): boolean {
  return /\.(from|rpc)\(/.test(readFileSync(ruta, 'utf8'));
}

/** Cuántas llamadas `.from(`/`.rpc(` trae un archivo — la UNIDAD que de
 *  verdad mide cuánto código bypasea `repo.ts`/`pg.ts`, no cuántos archivos
 *  lo hacen (ver AUDITORÍA 28 arriba). */
function llamadasDirectas(ruta: string): number {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- ruta sale de fuentesDeProduccion()/readdirSync sobre RAIZ_SRC, un directorio fijo del repo; ninguna entrada de usuario.
  return (readFileSync(ruta, 'utf8').match(/\.(from|rpc)\(/g) ?? []).length;
}

describe('la frontera de datos (repo.ts/pg.ts) — el número medido no puede subir en silencio', () => {
  const archivos = fuentesDeProduccion(RAIZ_SRC)
    .map((p) => relative(RAIZ_SRC, p))
    .filter((rel) => !FRONTERA.has(rel))
    .filter((rel) => tieneAccesoDirecto(join(RAIZ_SRC, rel)))
    .sort();

  it('el barrido encuentra archivos conocidos con acceso directo (si esto falla, el barrido se quedó ciego)', () => {
    // Los dos ejemplos más nuevos que la c21 citó: el MCP OAuth entero nació
    // sin pasar por repo.ts, y el pipeline entrante sigue haciendo `.from(`
    // inline desde hace varias rondas.
    expect(archivos).toContain('lib/mcp/oauth.ts');
    expect(archivos).toContain('lib/likida/processor.ts');
  });

  it(`no hay más de ${TECHO_ARCHIVOS_FUERA_DE_LA_FRONTERA} archivos con acceso directo a Supabase fuera de repo.ts/pg.ts`, () => {
    const mensaje = archivos.length > TECHO_ARCHIVOS_FUERA_DE_LA_FRONTERA
      ? [
        `El conteo SUBIÓ de ${TECHO_ARCHIVOS_FUERA_DE_LA_FRONTERA} a ${archivos.length}.`,
        'Si el crecimiento es real y ya se revisó, sube TECHO_ARCHIVOS_FUERA_DE_LA_FRONTERA',
        'en este archivo, en el MISMO commit que lo explica. Si no, alguien metió',
        'una consulta directa nueva por fuera de repo.ts/pg.ts — muévela ahí.',
      ].join('\n')
      : `${archivos.length} de ${TECHO_ARCHIVOS_FUERA_DE_LA_FRONTERA} — dentro del techo.`;
    expect(archivos.length, mensaje).toBeLessThanOrEqual(TECHO_ARCHIVOS_FUERA_DE_LA_FRONTERA);
  });

  it('si el conteo BAJÓ (código migrado a repo.ts), hay que bajar el techo también', () => {
    // Este test no puede fallar solo — es la nota que explica por qué el de
    // arriba no debe quedarse verde "de sobra": un techo que nunca se ajusta
    // hacia abajo deja de medir nada. Si `archivos.length` queda muy por
    // debajo de TECHO_ARCHIVOS_FUERA_DE_LA_FRONTERA por varias rondas, es
    // señal de que el techo quedó obsoleto, no de que el problema mejoró.
    expect(archivos.length).toBeGreaterThan(0);
  });

  // ── AUDITORÍA 28, ARQ-M1: el techo que de verdad importa — LLAMADAS ──────
  const totalLlamadas = archivos.reduce((n, rel) => n + llamadasDirectas(join(RAIZ_SRC, rel)), 0);

  it('el barrido cuenta más llamadas que archivos (si no, esto no mide nada distinto)', () => {
    // Si algún día coincidieran, contar llamadas dejaría de aportar sobre
    // contar archivos — la señal de que el guardia de archivos se quedó
    // ciego a este tipo de crecimiento (varias consultas nuevas en un mismo
    // archivo ya listado) es precisamente que este número sea MAYOR.
    expect(totalLlamadas).toBeGreaterThan(archivos.length);
  });

  it(`no hay más de ${TECHO_LLAMADAS_FUERA_DE_LA_FRONTERA} llamadas .from(/.rpc( fuera de repo.ts/pg.ts`, () => {
    const mensaje = totalLlamadas > TECHO_LLAMADAS_FUERA_DE_LA_FRONTERA
      ? [
        `El conteo de LLAMADAS subió de ${TECHO_LLAMADAS_FUERA_DE_LA_FRONTERA} a ${totalLlamadas}.`,
        'Si el crecimiento es real y ya se revisó, sube TECHO_LLAMADAS_FUERA_DE_LA_FRONTERA',
        'en este archivo, en el MISMO commit que lo explica. Si no, alguien metió',
        'consultas directas nuevas por fuera de repo.ts/pg.ts — muévelas ahí, o revisa que',
        'las nuevas paginen con traerTodo/acotada igual que el resto del archivo.',
      ].join('\n')
      : `${totalLlamadas} de ${TECHO_LLAMADAS_FUERA_DE_LA_FRONTERA} — dentro del techo.`;
    expect(totalLlamadas, mensaje).toBeLessThanOrEqual(TECHO_LLAMADAS_FUERA_DE_LA_FRONTERA);
  });

  it('si las llamadas BAJARON (código migrado o simplificado), hay que bajar ese techo también', () => {
    // Misma nota que la de archivos, mismo motivo: un techo que se queda muy
    // por encima de lo medido deja de ser un techo.
    expect(totalLlamadas).toBeGreaterThan(0);
  });
});
