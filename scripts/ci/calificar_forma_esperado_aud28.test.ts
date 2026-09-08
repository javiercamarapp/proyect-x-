import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extraerBloques, calificar } from './calificar-verificacion.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28 · PRU-A3 — el bloque 47 salía `✓ ok` con 8 de 11 mediciones
// SIN CALIFICAR.
//
// `partirEnClavesYEsperado` (en `calificar-verificacion.mjs`) cortaba en el
// PRIMER `(esperado`, pero tomaba TODO lo que seguía —hasta el final del
// mensaje— como el lado derecho (los valores esperados), en vez de detenerse
// en el `)` que cierra ESE grupo. El bloque 47 escribía su `(esperado 100 /
// 100 / 10)` A LA MITAD del mensaje (antes de ocho mediciones más), así que
// esas ocho —incluida `llm_costo INTACTA`, la que prueba que la purga no se
// llevó costo real— se tragaban como parte del TERCER valor esperado, un
// string con espacios → comodín de prosa → `ok:true` sin importar lo que
// dijeran. Medido contra el bloque real: con `llm_intactas` sano (87) Y con
// `llm_intactas` roto (cualquier otro número) el bloque calificaba `✓ ok` —
// exactamente la discrepancia que este archivo prueba que ya no existe.
//
// DISCREPANCIA CON EL RÓTULO DEL PLAN («falla con mediciones sin calificar»):
// `sin_calificar` YA es FALLA con `exit 1` en el runner desde el 1-sep
// (`correr-verificaciones.mjs`, sin lista de excepciones — lo fija
// `calificar_verificacion_aud24.test.ts`, «el runner ya no tiene lista de
// "sin calificar conocidos"»). El defecto de clase no era que `sin_calificar`
// no fallara: era que este caso NUNCA llegaba a `sin_calificar` — caía en el
// comodín de prosa de `ok`, que es un veredicto distinto y peor (no solo "no
// pude leerlo": "leí que está bien" siendo falso).
//
// El arreglo tiene dos mitades, y esta prueba fija las dos:
//   (a) CLASE, en `calificar-verificacion.mjs`: cualquier mensaje con más de
//       un grupo `(esperado …)`, o con un `identificador=` después del `)`
//       que cierra el único grupo, sale `sin_calificar` — no `ok` por
//       comodín. Se prueba con TODOS los bloques reales de `verificaciones.
//       sql` y `capa1_auditoria_estatica.sql`: ninguno debe tener ya esa
//       forma (si un bloque nuevo la reintroduce, esta prueba lo atrapa).
//   (b) INSTANCIA, en `supabase/verificaciones.sql`: el bloque 47 se
//       reescribió a la forma de los demás (un solo `(esperado …)` al final,
//       las 11 mediciones alineadas a sus 11 claves). Se prueba calificando
//       el bloque real con sus valores sanos (→ ok) y con `llm_intactas`
//       roto (→ falla, señalando esa clave).
// ═══════════════════════════════════════════════════════════════════════════

const ARCHIVOS = ['supabase/verificaciones.sql', 'supabase/pruebas-aislamiento/capa1_auditoria_estatica.sql'];

/** El texto del ÚLTIMO `raise exception E'…'` de un bloque, con cada `%`
 * sustituido en orden por `valor` (mismo comodín para todos). */
function mensajeSimulado(bloqueSql: string, valor: string): string | null {
  const m = /raise exception E'((?:[^'\\]|\\.)*)'/g;
  let ultimo: string | null = null;
  let x: RegExpExecArray | null;
  while ((x = m.exec(bloqueSql))) ultimo = x[1];
  if (ultimo === null) return null;
  return ultimo.replace(/\\n/g, ' ').replace(/%/g, valor).replace(/\s+/g, ' ').trim();
}

/** Igual, pero sustituyendo cada `%` EN ORDEN por un valor de `valores`. */
function mensajePorValores(bloqueSql: string, valores: string[]): string {
  const m = /raise exception E'((?:[^'\\]|\\.)*)'/.exec(bloqueSql);
  if (!m) throw new Error('bloque sin raise');
  let i = 0;
  return m[1].replace(/\\n/g, ' ').replace(/%/g, () => valores[i++]).replace(/\s+/g, ' ').trim();
}

describe('PRU-A3 (clase): ningún bloque real deja mediciones fuera del (esperado …)', () => {
  for (const archivo of ARCHIVOS) {
    const sql = readFileSync(archivo, 'utf8');
    const bloques = extraerBloques(sql, archivo);

    it(`${archivo}: cada raise con (esperado tiene un solo grupo y nada tras su cierre`, () => {
      const problemas: string[] = [];
      for (const b of bloques) {
        const msg = mensajeSimulado(b.sql, 't');
        if (msg === null) continue; // bloque sin raise final (no debería pasar, pero no es lo que esta prueba vigila)
        if (!msg.includes('(esperado')) continue; // reporte: nada que calificar

        const r = calificar(msg);
        if (r.tipo === 'sin_calificar') {
          problemas.push(`${archivo}:${b.linea} → sin_calificar (${r.razon})`);
        }
      }
      expect(problemas, `bloques que el calificador ya no puede leer con certeza:\n  ${problemas.join('\n  ')}`).toEqual([]);
    });
  }

  it('control: un mensaje sintético con dos grupos (esperado …) SÍ sale sin_calificar', () => {
    const r = calificar('x a=1 (esperado 1) b=2 (esperado 2)');
    expect(r.tipo).toBe('sin_calificar');
  });

  it('control: un mensaje sintético con mediciones después del cierre SÍ sale sin_calificar (no ok por comodín)', () => {
    const r = calificar('a=1 b=2 (esperado 1 / 2) c=3');
    expect(r.tipo).toBe('sin_calificar');
  });

  it('control: el caso sano (un solo grupo, nada después) sigue calificando normal', () => {
    expect(calificar('a=1 b=2 (esperado 1 / 2)').tipo).toBe('ok');
    expect(calificar('a=1 b=9 (esperado 1 / 2)').tipo).toBe('falla');
  });

  it('control: un valor esperado con paréntesis propios no rompe el conteo de cierre', () => {
    const r = calificar('indice=X (esperado "(a, b)")');
    expect(r.tipo).toBe('ok'); // el único esperado trae espacios (comillas+coma) → comodín de prosa
  });
});

describe('PRU-A3 (instancia): el bloque 47 reescrito califica de verdad', () => {
  const sql = readFileSync('supabase/verificaciones.sql', 'utf8');
  const bloque47 = extraerBloques(sql, 'verificaciones.sql').find((b) => /raise exception E'47 /.test(b.sql));

  it('el bloque existe y trae un solo grupo (esperado …), AL FINAL del mensaje', () => {
    expect(bloque47, 'no encontré el bloque 47').toBeDefined();
    const msg = mensajeSimulado(bloque47!.sql, 't')!;
    const grupos = msg.match(/\(esperado/g) ?? [];
    expect(grupos.length, 'volvió a tener más de un grupo (esperado …)').toBe(1);
    expect(calificar(msg).tipo, 'con todo en t debe poder calificar (no sin_calificar)').not.toBe('sin_calificar');
  });

  // Orden real de los argumentos del raise (ver supabase/verificaciones.sql,
  // bloque 47): viejos_antes, waPurgados, quedan_wa, llm_intactas,
  // consol_suma, cruda_suma, (mes_curso=0), idempotente, guarda_minimo,
  // sqlst, json.
  const VALORES_SANOS = ['100', '100', '10', '87', '2.000000', '2.000000', 't', 't', 't', 'PU001', '{}'];

  it('sano (llm_costo INTACTA=87, todo lo demás en su valor esperado): ok', () => {
    const r = calificar(mensajePorValores(bloque47!.sql, VALORES_SANOS));
    expect(r.tipo).toBe('ok');
  });

  it('roto — llm_intactas=50 en vez de 87 (la purga sí tocó llm_costo): falla, señalando esa clave', () => {
    const valores = [...VALORES_SANOS];
    valores[3] = '50';
    const r = calificar(mensajePorValores(bloque47!.sql, valores));
    expect(r.tipo).toBe('falla');
    expect(r.falla?.map((f: { clave: string }) => f.clave)).toEqual(['llm_costo-intacta']);
  });

  it('roto — consolidado y crudo dejan de coincidir: falla, señalando ambas claves', () => {
    const valores = [...VALORES_SANOS];
    valores[4] = '2.000000'; // consolidado
    valores[5] = '1.500000'; // crudo — ya no coincide
    const r = calificar(mensajePorValores(bloque47!.sql, valores));
    expect(r.tipo).toBe('falla');
    expect(r.falla?.map((f: { clave: string }) => f.clave)).toEqual(['crudo']);
  });

  it('roto — el plazo mínimo NO falló cerrado (guarda_minimo=f, sqlstate vacío): falla', () => {
    const valores = [...VALORES_SANOS];
    valores[8] = 'f'; // plazo-minimo-falla-cerrado
    valores[9] = '<null>'; // sqlstate
    const r = calificar(mensajePorValores(bloque47!.sql, valores));
    expect(r.tipo).toBe('falla');
    expect(r.falla?.map((f: { clave: string }) => f.clave).sort()).toEqual(
      ['plazo-minimo-falla-cerrado', 'sqlstate'].sort(),
    );
  });

  it('el json no se compara por valor (comodín documentado): cualquier forma pasa mientras las demás claves cuadren', () => {
    const valores = [...VALORES_SANOS];
    valores[10] = '{"cualquier":"cosa","distinta":true}';
    const r = calificar(mensajePorValores(bloque47!.sql, valores));
    expect(r.tipo).toBe('ok');
  });
});
