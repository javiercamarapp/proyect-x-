import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fuentesDeProduccion, sinComentarios } from '@/lib/pruebas/codigo';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28, ARQ-B4 (BAJO, reincidente 26/27) — `revision.ts` decía ser
// «el ÚNICO lector/escritor de `liquidacion.revision` en la app» y solo la
// mitad era verdad: LECTOR no lo es (siete archivos de producción leen
// `revision` para decidir dinero o pintura — ver el encabezado de
// `revision.ts`), pero ESCRITOR sí — `revisarLiquidacion` es el único
// llamador de la RPC `revisar_liquidacion` (la tabla rebota cualquier otro
// camino, LR003).
//
// Esta prueba vigila la mitad que SÍ es cierta: si mañana otro archivo llama
// `rpc('revisar_liquidacion'` a mano (saltándose `revisarLiquidacion` y su
// aviso al chofer), se pone roja.
// ═══════════════════════════════════════════════════════════════════════════

describe('revisar_liquidacion tiene UN solo llamador', () => {
  it('ningún archivo de producción fuera de revision.ts llama rpc(\'revisar_liquidacion\'', () => {
    const archivos = fuentesDeProduccion('src').filter((f) => !f.endsWith('/revision.ts'));
    // `f` sale del propio barrido de `fuentesDeProduccion` sobre `src/`.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const culpables = archivos.filter((f) => sinComentarios(readFileSync(f, 'utf8')).includes("rpc('revisar_liquidacion'"));
    expect(culpables, `estos archivos llaman la RPC directo, saltándose revisarLiquidacion(): ${culpables.join(', ')}`).toEqual([]);
  });

  it('revision.ts SÍ la llama (que la prueba de arriba no esté vigilando el vacío)', () => {
    const fuente = sinComentarios(readFileSync('src/lib/likida/revision.ts', 'utf8'));
    expect(fuente).toContain("rpc('revisar_liquidacion'");
  });
});
