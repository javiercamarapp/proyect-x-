import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sinComentarios } from '@/lib/pruebas/codigo';

// ═══════════════════════════════════════════════════════════════════════════
// EL TOPE DE CONSULTA PROTEGÍA UN SOLO ARCHIVO. (AUDITORÍA 8, ALTO REINCIDENTE)
//
// `acotada()` nació dentro de `repo.ts`, así que solo cubría lo que pasaba por
// ahí. `conv.ts`, `costos.ts` y `config.ts` llamaban a `supabaseAdmin()` en
// crudo — ONCE de los trece pasos del cierre, incluidos el mutex del viaje, la
// barrera de ráfaga y la conversación.
//
// Una consulta colgada en esos caminos no tenía techo, y el webhook muere a los
// 120 s: la liquidación queda escrita, el operador no recibe ni resumen ni PDF,
// no se alcanza a escribir el `logger.error` porque el proceso muere antes del
// `catch`, y Meta no reintenta porque ya recibió su 200.
//
// Que fuera REINCIDENTE es el dato: el mecanismo era correcto y estaba probado,
// pero vivía en un archivo en vez de en la frontera. Moverlo a `presupuesto.ts`
// no basta — sin esta prueba, el próximo archivo que hable con Supabase nace
// otra vez sin techo, y nada falla hasta que algo se cuelga en producción.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Los archivos por los que pasa el cierre de una liquidación.
 *
 * AUDITORÍA 28, ARQ-M1: esta lista vigilaba solo CUATRO archivos y dejaba
 * fuera exactamente al que orquesta el webhook completo — `processor.ts`
 * importa `cuadrarDesdeDB` y es donde vive cada handler de mensaje entrante
 * (incluida `registrarUbicacionChofer`, que SÍ tenía dos consultas crudas sin
 * `acotada()` hasta esta misma auditoría — ver processor.ts:172/176). Un
 * guardia que no mira el archivo más grande del camino caliente no vigila el
 * camino caliente, vigila una porción arbitraria de él. `cuadre/desde_db.ts`
 * (el cálculo del cuadre en sí, incluida la lectura de líneas ECC de
 * ARQ-A1/ARQ-A2) entra por el mismo motivo: es el módulo que `cierreEstricto`
 * ejecuta en el camino de escritura fiscal.
 */
const CAMINO_DEL_CIERRE = [
  'src/lib/likida/repo.ts',
  'src/lib/likida/conv.ts',
  'src/lib/likida/costos.ts',
  'src/lib/likida/config.ts',
  'src/lib/likida/processor.ts',
  'src/lib/likida/cuadre/desde_db.ts',
];

describe('ninguna consulta del cierre se queda sin techo', () => {
  it.each(CAMINO_DEL_CIERRE)('%s no llama a supabaseAdmin() en crudo', (archivo) => {
    const src = sinComentarios(readFileSync(archivo, 'utf8'));
    // `await supabaseAdmin()` sin `acotada(` delante es una consulta sin tope.
    // Y el ALIAS: `const admin = supabaseAdmin(); await admin.rpc/from(…)` — el
    // patrón que se coló en `acquireViajeLock` (auditoría 2) porque el regex
    // literal no lo veía. Una llamada envuelta es `acotada(admin.rpc(…`, así que
    // `await admin.(rpc|from)(` solo matchea las CRUDAS.
    const crudas = [...src.matchAll(/await supabaseAdmin\(\)/g)].length
      + [...src.matchAll(/await admin\.(rpc|from)\(/g)].length;
    expect(
      crudas,
      `${archivo} tiene consultas sin tope. Envuélvelas: await acotada(supabaseAdmin()…, 'etiqueta'). ` +
      'Sin techo, un cuelgue se come los 120 s de la función y el operador se queda sin PDF ' +
      'sobre una liquidación que SÍ se escribió.',
    ).toBe(0);
  });

  it('y hay consultas de verdad que contar (si no, esto no vigila nada)', () => {
    const total = CAMINO_DEL_CIERRE.reduce(
      (n, f) => n + [...sinComentarios(readFileSync(f, 'utf8')).matchAll(/acotada\(supabaseAdmin\(\)/g)].length, 0)
    expect(total).toBeGreaterThan(20);
  });

  it('`acotada` vive en la frontera, no dentro de un consumidor', () => {
    // La causa de que fuera reincidente: estaba en `repo.ts`, así que "usarla"
    // exigía importar del módulo de acceso a datos, y quien no lo hacía no
    // notaba nada.
    const pres = readFileSync('src/lib/likida/presupuesto.ts', 'utf8');
    expect(pres).toMatch(/export async function acotada/);
    expect(sinComentarios(readFileSync('src/lib/likida/repo.ts', 'utf8')))
      .not.toMatch(/(async )?function acotada/);
  });

  it('el tope y su margen salen del mismo sitio que el presupuesto', () => {
    // Si el tope viviera lejos de `MARGEN_CIERRE_MS` y del `maxDuration`, nadie
    // volvería a cuadrar los tres números entre sí.
    const pres = readFileSync('src/lib/likida/presupuesto.ts', 'utf8');
    expect(pres).toMatch(/TOPE_CONSULTA_MS/);
    expect(pres).toMatch(/GRACIA_TOPE_MS/);
  });
});
