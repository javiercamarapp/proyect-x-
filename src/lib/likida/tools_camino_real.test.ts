// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 10, BAJO (tool-calling) — `cuadrar_viaje` y `consultar_politica`
// seguían sin un arnés que las invocara por su CAMINO REAL.
//
// `command grep -rn "executeTool('cuadrar_viaje'\|executeTool('consultar_politica'"
// src --include="*.test.ts"` no devolvía nada: las dos solo se probaban por
// RECONSTRUCCIÓN A MANO —`permiso_politica.test.ts` rearma a mano el objeto
// que la tool devuelve, llamando `normasDePolitica` directo— o desde el motor
// puro (`arnes_ticket_real.test.ts`, `engine*.test.ts`), nunca desde el
// REGISTRO que el agente en verdad dispara (`REGISTRY.get(name).handler`, en
// `tool-executor.ts`). Una reconstrucción a mano prueba que la fórmula está
// bien escrita dos veces con el mismo error, no que el camino que usa el LLM
// funcione.
//
// Mismo patrón que `tools_cableado.test.ts` ya usa para `guardar_liquidacion`:
// se mockea la CAPA DE DATOS (`cuadre/desde_db`, `config`, `repo`), nunca el
// HANDLER — `executeTool` corre el handler REGISTRADO de verdad, con la misma
// puerta (medición de tiempo, captura de excepción) que usa `openrouter.ts`
// en producción.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi } from 'vitest';
import type { Liquidacion } from '@/types/likida';
import { DEMO_CONFIG } from './config';

/** El cuadre que `cuadrarDesdeDB` devolvería para un viaje real con diésel
 *  pagado en efectivo: la diferencia que más ha costado en este proyecto
 *  (ver el docstring de `NORMA_POR_DIFERENCIA` en `por_diferencia.ts`). */
const LIQ: Omit<Liquidacion, 'id' | 'creadaEn'> = {
  viajeId: 'v1', totalComprobado: 4300, totalAnticipo: 5000, diferencia: 700, estatus: 'con_diferencias',
  totalDeducible: 800, totalNoDeducible: 0, totalPorConfirmar: 3500,
  iepsAcreditable: 0, litrosDieselAcreditables: 0, ivaAcreditable: 110.34, peajeAcreditable: 344.83,
  gastos: [
    { id: 'g-diesel', concepto: 'diesel', monto: 3500, formaPago: '01' },
    { id: 'g-caseta', concepto: 'caseta', monto: 800 },
  ],
  diferencias: [
    { tipo: 'combustible_efectivo', concepto: 'diesel', monto: 0, gastoId: 'g-diesel',
      nota: 'diésel pagado en efectivo, por confirmar contra el tope del 15% del ejercicio' },
  ],
};

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./cuadre/desde_db', () => ({ cuadrarDesdeDB: vi.fn(async () => LIQ) }));
vi.mock('./config', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getConfig: vi.fn(async () => DEMO_CONFIG),
}));
vi.mock('./repo', () => ({
  // El ejercicio sale "holgado" (0/0) a propósito: aquí lo que se prueba es
  // que el permiso de citar viaja con las DIFERENCIAS del cuadre, no con el
  // aviso de periodo — ese tiene su propia cobertura en `periodo/*.test.ts`.
  getAcumuladoCombustible: vi.fn(async () => ({ efectivo: 0, totalCombustible: 0 })),
  // AUDITORÍA 28, FIS-A3: sin perfil, `facilidad15Vigente` cae a
  // `tenant.config` (DEMO_CONFIG, sin la facilidad declarada) — mismo
  // universo "sin declarar" que este archivo ya ejercitaba antes del helper.
  getPerfilCrudo: vi.fn(async () => ({})),
}));

// Importar `tools.ts` REGISTRA las tools (`registerTool`, al importarse).
// `executeTool` es la ÚNICA puerta de entrada — la misma que usa el agente.
await import('./tools');
const { executeTool } = await import('@/lib/llm/tool-executor');

const CTX = { tenantId: 't1', viajeId: 'v1' };

describe('cuadrar_viaje — el handler REAL, invocado por executeTool (no reconstruido a mano)', () => {
  it('devuelve el cuadre real de cuadrarDesdeDB, con sus totales', async () => {
    const r = await executeTool('cuadrar_viaje', {}, CTX);
    expect(r.success, r.error).toBe(true);
    const res = r.result as Record<string, unknown>;
    expect(res.total_comprobado).toBe(4300);
    expect(res.total_anticipo).toBe(5000);
    expect(res.diferencia).toBe(700);
    expect(res.estatus).toBe('con_diferencias');
    expect(res.diferencias).toEqual([
      { tipo: 'combustible_efectivo', monto: 0, nota: LIQ.diferencias![0].nota },
    ]);
  });

  it('emite el permiso de citar (`fundamentos`) para la diferencia que devolvió — no una lista vacía', async () => {
    const r = await executeTool('cuadrar_viaje', {}, CTX);
    const res = r.result as { fundamentos: Array<{ norma_id: string; vinculante: boolean }> };
    // `combustible_efectivo` → LISR 27-III (lo prohíbe) Y RFA 2026 2.9 (la
    // excepción del 15%): el agente necesita las DOS para explicar el
    // veredicto, no solo la que prohíbe.
    const ids = res.fundamentos.map((f) => f.norma_id);
    expect(ids).toContain('lisr-27-fr-III');
    expect(ids).toContain('rfa-2026-2.9');
  });

  it('sin viaje activo, el handler real lanza y executeTool lo captura (no revienta el turno)', async () => {
    const r = await executeTool('cuadrar_viaje', {}, { tenantId: 't1' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('sin viaje activo');
  });
});

describe('consultar_politica — el handler REAL, invocado por executeTool (no reconstruido a mano)', () => {
  it('trae la política configurada del tenant', async () => {
    const r = await executeTool('consultar_politica', {}, CTX);
    expect(r.success, r.error).toBe(true);
    const res = r.result as { politica: unknown };
    expect(res.politica).toBe(DEMO_CONFIG.politica);
  });

  it('emite `norma_id` — la llave que `guardiaFundamento` lee para permitir la cita', async () => {
    const r = await executeTool('consultar_politica', {}, CTX);
    const res = r.result as { fundamentos: Array<{ norma_id: string; cita: string; vinculante: boolean }> };
    expect(res.fundamentos.length).toBeGreaterThan(0);
    // Piso de cualquier política de viáticos (ver permiso_politica.test.ts):
    // efectivo y el tope diario de alimentación.
    const ids = res.fundamentos.map((f) => f.norma_id);
    expect(ids).toContain('lisr-27-fr-III');
    expect(ids).toContain('lisr-28-fr-V');
    for (const f of res.fundamentos) {
      expect(f.cita, f.norma_id).toBeTruthy();
    }
  });
});
