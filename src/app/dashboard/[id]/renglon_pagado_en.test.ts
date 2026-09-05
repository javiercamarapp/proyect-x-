import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { estadoRenglon } from './vista';
import type { LiquidacionDetalle } from '@/lib/likida/analytics';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 26, FE-1 (ALTO). UNA PREGUNTA QUE EL DATO NO PUEDE CONTESTAR.
//
// `74109dd` (ARQ-25) le enseñó a `estadoRenglon` a preguntar `pagoPendiente(g)`
// —`formaPago === '99' && !pagadoEn`— importando el predicado del motor, que es
// lo correcto. Lo que no tocó fue la consulta que alimenta la tabla:
// `leerGastos` no selecciona `pagado_en` y `LiquidacionDetalle['gastos']` ni
// siquiera declaraba el campo. El parámetro de `estadoRenglon` es un tipo
// estructural con campos opcionales, así que TypeScript compilaba tan feliz.
//
// Con `pagadoEn` siempre `undefined`, `pagoPendiente` colapsa a
// `formaPago === '99'`: TODO CFDI a crédito ya pagado con su REP —lo normal en
// una flota que compra diésel y casetas con convenio— sale «Por confirmar» en
// ámbar, mientras el bloque de Deducibilidad de la MISMA pantalla lo cuenta
// como deducible y el PDF también. El contralor firma una hoja que se
// contradice a sí misma.
//
// La prueba de la 25 (`estado_renglon.test.ts:92`) sigue verde y no lo vio:
// le pasa `pagadoEn` a mano, una forma de dato que ningún llamador de
// producción podía producir. Por eso esta prueba mide LOS DOS lados —el
// predicado y su fuente— en vez de solo el predicado.
// ═══════════════════════════════════════════════════════════════════════════

const ANALYTICS = readFileSync('src/lib/likida/analytics.ts', 'utf8');

/** El `select` de la consulta que llena la tabla del detalle. */
function selectDeLeerGastos(): string {
  const i = ANALYTICS.indexOf('getLiquidacionDetalle/gastos');
  expect(i, 'no encontré la consulta de gastos del detalle').toBeGreaterThan(-1);
  const desde = ANALYTICS.lastIndexOf(".select('", i);
  expect(desde, 'no encontré el .select de leerGastos').toBeGreaterThan(-1);
  return ANALYTICS.slice(desde, ANALYTICS.indexOf("')", desde));
}

describe('FE-1 · el renglón puede contestar la pregunta que le hace el predicado del motor', () => {
  it('la consulta que llena la tabla trae `pagado_en`', () => {
    expect(selectDeLeerGastos()).toContain('pagado_en');
  });

  it('el tipo de la fila declara `pagadoEn`, para que TypeScript exija llenarlo', () => {
    // Compila solo si el campo existe en el tipo: es la mitad que el
    // `readFileSync` no puede defender.
    const fila: LiquidacionDetalle['gastos'][number] = {
      concepto: 'diesel', monto: 8000, formaPago: '99', pagadoEn: '2026-08-20',
    };
    expect(fila.pagadoEn).toBe('2026-08-20');
  });

  it('un CFDI a crédito con su REP ya ingerido sale VERDE, no «Por confirmar»', () => {
    const caseta: LiquidacionDetalle['gastos'][number] = {
      id: 'g1', concepto: 'caseta', monto: 240, fecha: '2026-08-20',
      formaPago: '99', pagadoEn: '2026-08-20',
      cfdiUuid: 'UUID-CASETA', estadoSat: 'vigente',
    };
    const e = estadoRenglon(caseta, []);
    expect(e.etiqueta).toBe('CFDI vigente');
    expect(e.estado).toBe('ok');
  });

  it('sin REP sigue saliendo «Por confirmar»: el arreglo no afloja la regla', () => {
    const caseta: LiquidacionDetalle['gastos'][number] = {
      id: 'g2', concepto: 'caseta', monto: 240, fecha: '2026-08-20',
      formaPago: '99', cfdiUuid: 'UUID-SIN-REP', estadoSat: 'vigente',
    };
    expect(estadoRenglon(caseta, []).etiqueta).toBe('Por confirmar');
  });
});
