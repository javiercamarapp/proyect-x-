// ═══════════════════════════════════════════════════════════════════════════
// RE-AUDITORÍA 25, FASE 3 (CAP-2, MEDIO) — el patrón `.limit(5000)`/`.limit(2000)`
// que PostgREST recorta EN SILENCIO a `max_rows` (1,000 por default, `pg.ts`)
// seguía intacto en varias lecturas de los agentes de auditoría, después de
// que la ronda anterior ya lo había arreglado en tres sitios equivalentes
// (`leerCostos` de ingenieria.ts, ver `leer_costos_aud25.test.ts`). El
// hallazgo nombró backoffice.ts:432 e ingenieria_producto.ts:652,666,805 como
// muestra del mismo patrón; se migraron esos Y los demás `.limit(2000|5000)`
// crudos que quedaban en los dos archivos — dejar la mitad migrada habría
// sido la misma trampa a medio pisar.
//
// Esta prueba mira el CÓDIGO (sin comentarios, `sinComentarios`) para que no
// pueda volver a aparecer un `.limit(N)` crudo en `backoffice.ts` /
// `ingenieria_producto.ts` — el mismo estilo de guardia que ya usa
// `formato.test.ts` contra una segunda copia de `toLocaleString('es-MX')`.
// Los `.limit()` que SÍ siguen (p.ej. `leerCorridas`, con `count: 'exact'` y
// una bandera `truncado` explícita) son lecturas deliberadamente acotadas, no
// el bug: por eso el guardia es específico a 2000/5000, los topes que este
// hallazgo señaló, y no a `.limit(` en general.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sinComentarios } from '@/lib/pruebas/codigo';

const ARCHIVOS = [
  'src/lib/likida/agentes/backoffice.ts',
  'src/lib/likida/agentes/ingenieria_producto.ts',
];

describe('CAP-2: sin .limit(N) crudo en las lecturas ya migradas a traerTodo', () => {
  it('backoffice.ts y ingenieria_producto.ts no vuelven a traer con .limit(2000|5000) sin paginar', () => {
    for (const archivo of ARCHIVOS) {
      const codigo = sinComentarios(readFileSync(archivo, 'utf8'));
      const crudos = codigo.match(/\.limit\((2000|5000)\)/g) ?? [];
      expect(crudos, `${archivo} todavía trae con .limit() crudo: ${crudos.join(', ')}`).toEqual([]);
    }
  });

  it('las lecturas migradas usan traerTodo y conservan su nombre de consulta', () => {
    const backoffice = sinComentarios(readFileSync('src/lib/likida/agentes/backoffice.ts', 'utf8'));
    const ingenieria = sinComentarios(readFileSync('src/lib/likida/agentes/ingenieria_producto.ts', 'utf8'));
    expect(/traerTodo/.test(backoffice)).toBe(true);
    expect(/traerTodo/.test(ingenieria)).toBe(true);
    // Cada función sigue leyendo la misma tabla/filtro que antes, ahora vía
    // traerTodo — se comprueba que el nombre de consulta (segundo argumento,
    // el mismo que ya usaban en pg.ts) sigue presente, para que el fix no haya
    // sido borrar la lectura en vez de paginarla.
    expect(backoffice).toContain("'backoffice.calidad_base'");
    expect(backoffice).toContain("'backoffice.calidad_piezas'");
    expect(ingenieria).toContain("'ingenieria.producto_resueltas'");
    expect(ingenieria).toContain("'ingenieria.producto_pendientes'");
    expect(ingenieria).toContain("'ingenieria.producto_incidencias'");
    expect(ingenieria).toContain("'ingenieria.producto_corridas'");
    expect(ingenieria).toContain("'ingenieria.cobertura_sitio'");
    expect(ingenieria).toContain("'ingenieria.cobertura_producto'");
  });
});
