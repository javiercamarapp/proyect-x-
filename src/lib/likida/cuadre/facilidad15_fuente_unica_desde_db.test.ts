import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28, FIS-A3 — ver el docstring hermano en
// `../facilidad15_fuente_unica.test.ts`. Aquí se prueba que `cuadrarDesdeDB`
// (el motor/PDF) recibe el veredicto CORRECTO de `facilidad15Vigente` cuando
// el perfil trae una corrección del superadmin ("Régimen: No") que pisa una
// declaración vieja ("Régimen: Sí") — y que gana aunque `tenant.config` (el
// legado) NO se haya corregido.
// ═══════════════════════════════════════════════════════════════════════════

const getViaje = vi.fn();
const getGastos = vi.fn();
const getOperador = vi.fn();
const getAcumuladoCombustible = vi.fn();
const getPerfilCrudo = vi.fn();
const getConfig = vi.fn();
const cuadrarViaje = vi.fn();
let eccRespuesta: { data: unknown; error: null | { message: string } } = { data: [], error: null };
const eccCadena: Record<string, unknown> = {};
for (const metodo of ['select', 'eq', 'not', 'gte', 'lte']) {
  eccCadena[metodo] = () => eccCadena;
}
eccCadena.then = (resolve: (valor: unknown) => unknown) => Promise.resolve(eccRespuesta).then(resolve);

vi.mock('../repo', () => ({
  getViaje: (...a: unknown[]) => getViaje(...a),
  getGastos: (...a: unknown[]) => getGastos(...a),
  getOperador: (...a: unknown[]) => getOperador(...a),
  getAcumuladoCombustible: (...a: unknown[]) => getAcumuladoCombustible(...a),
  getPerfilCrudo: (...a: unknown[]) => getPerfilCrudo(...a),
}));
vi.mock('../config', () => ({ getConfig: (...a: unknown[]) => getConfig(...a) }));
vi.mock('./engine', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  cuadrarViaje: (...a: unknown[]) => cuadrarViaje(...a),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: () => eccCadena }) }));
vi.mock('../presupuesto', () => ({ acotada: (q: unknown) => q }));

const { cuadrarDesdeDB } = await import('./desde_db');
const { declararFacilidad15 } = await import('../perfil/preguntas');

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const PERFIL_VIEJO = {
  dedicacionExclusivaCarga: { valor: true, procedencia: 'declarado' as const },
  regimenElegible: { valor: true, procedencia: 'declarado' as const },
};
/** La misma fusión que `tenant_perfil_merge` (mig. 0296): reemplaza SOLO las
 *  llaves del patch, deja el resto intacto. */
const perfilTrasCorreccion = (patch: Record<string, unknown>) => ({ ...PERFIL_VIEJO, ...patch });

beforeEach(() => {
  vi.clearAllMocks();
  getViaje.mockResolvedValue({ id: U(9), anticipo: 9000, operadorId: U(5) });
  getOperador.mockResolvedValue({ id: U(5), nombre: 'Juan', rfc: undefined });
  getConfig.mockResolvedValue({
    politica: [], agentes: { liquidacion: { umbralConfianza: 0.85 } }, empresa: {},
    hidrocarburos: undefined, estimulos: undefined, validacion: { fechaToleranciaDiasAntes: 3 },
    // El legado SIGUE diciendo "sí" a propósito: lo que se prueba es que el
    // perfil (la fuente única) gana de todas formas.
    facilidadCombustibleEfectivo: { dedicacionExclusivaCarga: true, regimenElegible: true },
  });
  getAcumuladoCombustible.mockResolvedValue({ efectivo: 0, totalCombustible: 0 });
  getGastos.mockResolvedValue([]);
  eccRespuesta = { data: [], error: null };
  cuadrarViaje.mockReturnValue({ viajeId: U(9), totalComprobado: 0, diferencia: 0, estatus: 'cuadrada', diferencias: [], gastos: [] });
});

describe('FIS-A3 · desde_db.ts (el motor/PDF) refleja la corrección del superadmin', () => {
  it('con el perfil corregido a "Régimen: No", el motor recibe `facilidad15: false` aunque config diga "sí"', async () => {
    getPerfilCrudo.mockResolvedValue(perfilTrasCorreccion(declararFacilidad15(true, false)));

    await cuadrarDesdeDB('t1', U(9));

    expect(cuadrarViaje).toHaveBeenCalledTimes(1);
    expect(cuadrarViaje.mock.calls[0][0]).toMatchObject({ facilidad15: false });
  });

  it('control: SIN la corrección (perfil todavía "sí"), el motor recibe `facilidad15: true` — confirma que la prueba de arriba mide lo que dice medir', async () => {
    getPerfilCrudo.mockResolvedValue(PERFIL_VIEJO);

    await cuadrarDesdeDB('t1', U(9));

    expect(cuadrarViaje.mock.calls[0][0]).toMatchObject({ facilidad15: true });
  });
});
