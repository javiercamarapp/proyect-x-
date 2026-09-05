import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MEDIOS_LISR_27_III, FORMA_PAGO_SIN_PAGAR } from './cuadre/engine';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 20, ARQ-C1 (CRÍTICO). Este archivo lo PROMETÍA la migración 0190,
// por su nombre, y no existía:
//
//   "Si `MEDIOS_LISR_27_III` (engine.ts:126) cambia, esta lista tiene que
//    cambiar con ella — no hay forma de importar la constante de TS a SQL, así
//    que `fiscal_agregado_15pct.test.ts` fija ambas listas lado a lado para que
//    una diferencia falle ruidoso en CI, no en silencio en producción."
//                    — 0190_15pct_efectivo_lista_lisr27iii.sql:22-25
//
// Sin él, la lista que decide qué combustible entra al cubo del 15% de la RFA
// 2026 regla 2.9 vivía tecleada TRES veces —`engine.ts`, el `.sql`, y una
// tercera copia dentro del mock de `repo_acumulado.test.ts`— y ninguna prueba
// cruzaba la frontera TypeScript↔SQL: `repo_acumulado` compara TS contra su
// propia copia en TS, y `migraciones_verificadas` delega en `repo_acumulado`.
//
// El modo de falla que esto ataca: alguien agrega una forma de pago a
// `MEDIOS_LISR_27_III` y no toca el `.sql`. TS deja de contar ese gasto en el
// 15%; la RPC lo sigue contando. El panel y el acumulado del ejercicio informan
// dos cifras distintas del MISMO cubo fiscal, y la suite pasa verde.
//
// Se lee el `.sql` como texto a propósito: es la única forma de comprobar,
// sin una base de datos, que las dos implementaciones dicen lo mismo.
//
// AUDITORÍA 25, FIS-C1/FIS-C2 (CRÍTICO): la RPC vigente sustituyó a la 0190 —el
// `.sql` que se lee cambió de archivo— para juzgar la forma de pago EFECTIVA
// (`pagado_forma` del REP cuando `forma_pago = '99'` y hay `pagado_en`), no
// la cruda. El `not in (...)` ya no cuelga de `forma_pago` sino de la
// expresión derivada `forma_pago_efectiva`, así que el patrón de abajo
// también cambió; el resto de las aserciones —la lista, y que un '99' sin
// REP no cuenta— se conservan sobre la nueva forma.
// ═══════════════════════════════════════════════════════════════════════════

const RUTA_SQL = 'supabase/migrations/0345_combustible_rep_por_definir.sql';
const sql = readFileSync(RUTA_SQL, 'utf8');

/** El `not in (...)` del `filter` que define el numerador del 15%. */
function listaDelSql(): string[] {
  const m = sql.match(/forma_pago_efectiva\s+not\s+in\s*\(([^)]*)\)/i);
  if (!m) throw new Error(`${RUTA_SQL}: no se encontró el \`forma_pago_efectiva not in (...)\` que define el cubo del 15%`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('el cubo del 15% (RFA 2026 regla 2.9) dice lo mismo en TS y en SQL', () => {
  it('la lista de medios admitidos por la LISR 27-III es la MISMA en engine.ts y en la definición vigente', () => {
    expect([...listaDelSql()].sort()).toEqual([...MEDIOS_LISR_27_III].sort());
  });

  it("la RPC vigente excluye '99 Por definir' del numerador cuando no hay REP, igual que el motor", () => {
    // La forma cruda sin REP queda NULL; la forma REP 99 también se
    // excluye explícitamente, pues sigue sin definir un medio de pago.
    expect(FORMA_PAGO_SIN_PAGAR).toBe('99');
    expect(sql).toMatch(/when\s+forma_pago\s*=\s*'99'\s+then\s+null/i);
    expect(sql).toMatch(/forma_pago_efectiva\s*<>\s*'99'/i);
  });

  it("la RPC vigente juzga un '99' con REP (`pagado_en`) por `pagado_forma` — la forma EFECTIVA, no la cruda", () => {
    // FIS-C1/FIS-C2: el mismo criterio que `formaPagoJuzgable` (engine.ts:636)
    // y `formaPagoEfectiva` (fiscal.ts). Antes (0190) un '99' con REP se
    // excluía del numerador igual que uno sin pagar — dos hechos distintos
    // que la 0190 trataba idéntico.
    expect(sql).toMatch(/when\s+forma_pago\s*=\s*'99'\s+and\s+pagado_en\s+is\s+not\s+null\s+then\s+pagado_forma/i);
  });

  it('la RPC vigente no cuenta un gasto sin forma de pago (NULL no es efectivo)', () => {
    // Mismo criterio que `causasDe` y que `getAcumuladoCombustible`: suponer
    // efectivo donde no se sabe le quita al cliente una deducción que sí tiene.
    expect(sql).toMatch(/forma_pago_efectiva\s+is\s+not\s+null/i);
  });
});
