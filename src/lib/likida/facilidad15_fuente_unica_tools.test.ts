import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28, FIS-A3 — ver el docstring hermano en
// `./facilidad15_fuente_unica.test.ts`. Aquí se prueba que `cuadrar_viaje`
// (la tool que el agente dicta por WhatsApp), invocada por su camino REAL
// (`executeTool`, no reconstruida a mano — mismo patrón que
// `tools_camino_real.test.ts`), calcula el MISMO veredicto que el motor
// cuando el perfil trae una corrección del superadmin ("Régimen: No") que
// pisa una declaración vieja ("Régimen: Sí") — y que gana aunque
// `tenant.config` (el legado) NO se haya corregido.
// ═══════════════════════════════════════════════════════════════════════════

const cuadrarDesdeDB = vi.fn();
const getConfig = vi.fn();
const getAcumuladoCombustible = vi.fn();
const getViaje = vi.fn();
const getPerfilCrudo = vi.fn();
const avisoTope15 = vi.fn((..._a: unknown[]) => null as string | null);

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./interruptores', () => ({ estaApagado: vi.fn(async () => false) }));
vi.mock('./agentes/corridas', () => ({ registrarCorrida: vi.fn(async () => {}) }));
vi.mock('./cuadre/desde_db', () => ({ cuadrarDesdeDB: (...a: unknown[]) => cuadrarDesdeDB(...a) }));
vi.mock('./config', () => ({ getConfig: (...a: unknown[]) => getConfig(...a) }));
vi.mock('./periodo/aviso', () => ({ avisoTope15: (...a: unknown[]) => avisoTope15(...a) }));
vi.mock('./repo', () => ({
  getViaje: (...a: unknown[]) => getViaje(...a),
  getOperador: vi.fn(async () => null),
  saveLiquidacion: vi.fn(async () => {}),
  conteoDeGastosCambio: vi.fn(async () => false),
  getAcumuladoCombustible: (...a: unknown[]) => getAcumuladoCombustible(...a),
  getPerfilCrudo: (...a: unknown[]) => getPerfilCrudo(...a),
}));

await import('./tools');
const { executeTool } = await import('@/lib/llm/tool-executor');
const { declararFacilidad15 } = await import('./perfil/preguntas');

const CTX = { tenantId: 't-1', viajeId: 'v-1', runId: '00000000-0000-4000-8000-0000000000e1' };

const PERFIL_VIEJO = {
  dedicacionExclusivaCarga: { valor: true, procedencia: 'declarado' as const },
  regimenElegible: { valor: true, procedencia: 'declarado' as const },
};
/** La misma fusión que `tenant_perfil_merge` (mig. 0296): reemplaza SOLO las
 *  llaves del patch, deja el resto intacto. */
const perfilTrasCorreccion = (patch: Record<string, unknown>) => ({ ...PERFIL_VIEJO, ...patch });

beforeEach(() => {
  vi.clearAllMocks();
  avisoTope15.mockReturnValue(null);
  cuadrarDesdeDB.mockResolvedValue({
    viajeId: 'v-1', totalComprobado: 0, totalAnticipo: 0, diferencia: 0,
    estatus: 'cuadrada', diferencias: [], gastos: [],
  });
  getViaje.mockResolvedValue({ fechaInicio: '2026-07-15', destino: 'Cancún', anticipo: 0 });
  getAcumuladoCombustible.mockResolvedValue({ efectivo: 0, totalCombustible: 1_000_000 });
  // El legado SIGUE diciendo "sí" a propósito — igual que en la prueba
  // hermana de `desde_db.ts`.
  getConfig.mockResolvedValue({
    politica: [], hidrocarburos: { claves: [] },
    facilidadCombustibleEfectivo: { dedicacionExclusivaCarga: true, regimenElegible: true },
  });
});

describe('FIS-A3 · tools.ts (`cuadrar_viaje`, lo que dicta el agente) refleja la corrección del superadmin', () => {
  it('con el perfil corregido a "Régimen: No", la tool calcula `elegible: false` para el aviso — como el motor', async () => {
    getPerfilCrudo.mockResolvedValue(perfilTrasCorreccion(declararFacilidad15(true, false)));

    const r = await executeTool('cuadrar_viaje', {}, CTX);

    expect(r.error, r.error).toBeUndefined();
    expect(avisoTope15).toHaveBeenCalledTimes(1);
    // Tercer argumento de `avisoTope15(t, ejercicio, elegible)` en tools.ts.
    expect(avisoTope15.mock.calls[0][2]).toBe(false);
  });

  it('control: SIN la corrección (perfil todavía "sí"), la tool calcula `elegible: true` — confirma que la prueba de arriba mide lo que dice medir', async () => {
    getPerfilCrudo.mockResolvedValue(PERFIL_VIEJO);

    const r = await executeTool('cuadrar_viaje', {}, CTX);

    expect(r.error, r.error).toBeUndefined();
    expect(avisoTope15.mock.calls[0][2]).toBe(true);
  });
});
