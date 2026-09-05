import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 26 · CONTINUACIÓN, FE-1b (ALTO). EL ARREGLO LLEGÓ AL CAMINO DE
// RESPALDO Y DEJÓ INTACTO EL QUE DE VERDAD CORRE.
//
// `75ec862` arregló FE-1 agregando `pagado_en` al `select` de `leerGastos`. Es
// correcto y su prueba (`renglon_pagado_en.test.ts`) falla sin él. Pero
// `leerGastos` es, y el propio archivo lo dice en su comentario, «el camino de
// RESPALDO: se usa solo cuando el motor no pudo reconstruir el viaje».
//
// En una liquidación sana gana el otro:
//
//     const crudos  = reconstruida ? null : await leerGastos(...)
//     const gastos  = reconstruida?.filas ?? crudos ?? []
//
// y `reconstruida.filas` sale de un `.map()` cuyo objeto literal enumera once
// claves a mano SIN `pagadoEn`. El dato sí llega hasta ahí —`repo.ts` lo mapea
// desde `pagado_en` y `filasImprimibles` devuelve los `Gasto` del motor tal
// cual—: se pierde en el mapeo. Y como el cast va contra un tipo que tampoco
// declaraba el campo, TypeScript no tenía de qué quejarse.
//
// Efecto: con `pagadoEn` siempre `undefined` en el camino principal,
// `pagoPendiente` colapsa a `formaPago === '99'` y una caseta de $240 a crédito
// con su REP ya ingerido sale «Por confirmar» en ámbar, mientras el bloque de
// Deducibilidad de la MISMA pantalla la cuenta como deducible. Es el defecto
// que FE-1 describía, vivo en el camino común.
//
// Por qué esta prueba mide PARIDAD y no solo la presencia del campo: los dos
// caminos llenan la MISMA tabla. Que uno traiga un campo y el otro no es cómo
// nació este bug, así que lo que hay que anclar es que no vuelvan a divergir.
// ═══════════════════════════════════════════════════════════════════════════

const ANALYTICS = readFileSync('src/lib/likida/analytics.ts', 'utf8');

/** El `select` del camino de RESPALDO (`leerGastos`). */
function selectDeLeerGastos(): string {
  const i = ANALYTICS.indexOf('getLiquidacionDetalle/gastos');
  expect(i, 'no encontré la consulta de gastos del detalle').toBeGreaterThan(-1);
  const desde = ANALYTICS.lastIndexOf(".select('", i);
  expect(desde, 'no encontré el .select de leerGastos').toBeGreaterThan(-1);
  return ANALYTICS.slice(desde + ".select('".length, ANALYTICS.indexOf("')", desde));
}

/**
 * El objeto literal del camino PRINCIPAL: el `.map()` de `reconstruir` que
 * convierte las filas del motor en las filas de la tabla. Se ancla en el cast
 * —la línea que declara «estas son `Gasto` disfrazados»— y se corta en el
 * `return {...}` que le sigue.
 */
function literalDeReconstruir(): string {
  const i = ANALYTICS.indexOf('const x = g as FilaImprimibleConFiscal');
  expect(i, 'no encontré el mapeo de las filas reconstruidas').toBeGreaterThan(-1);
  const abre = ANALYTICS.indexOf('return {', i);
  expect(abre, 'no encontré el return del mapeo').toBeGreaterThan(-1);
  const cierra = ANALYTICS.indexOf('};', abre);
  expect(cierra, 'no encontré el cierre del mapeo').toBeGreaterThan(-1);
  return ANALYTICS.slice(abre, cierra);
}

/** `forma_pago, pagado_en` → `formaPago`, `pagadoEn`. */
function aCamello(col: string): string {
  return col.trim().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

describe('FE-1b · los dos caminos que llenan la tabla del detalle traen los mismos campos', () => {
  it('el camino PRINCIPAL (reconstrucción) trae `pagadoEn`', () => {
    // Sin esto `pagoPendiente` colapsa a `formaPago === '99'` en el caso común.
    expect(literalDeReconstruir()).toContain('pagadoEn');
  });

  it('ningún campo del camino de respaldo se pierde en el principal', () => {
    const literal = literalDeReconstruir();
    // `id` y `concepto` van sin renombre; el resto viaja en camelCase.
    const faltantes = selectDeLeerGastos()
      .split(',')
      .map(aCamello)
      .filter((campo) => !new RegExp(`\\b${campo}\\b`).test(literal));

    expect(
      faltantes,
      `el camino de respaldo trae campos que el principal tira: ${faltantes.join(', ')}`,
    ).toEqual([]);
  });
});
