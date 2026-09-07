import { describe, it, expect, vi, beforeEach } from 'vitest';

// ADM-8 (auditoría 24, MEDIO) — el server action re-gatea superadmin y sanea
// lo que pasa a la bitácora antes de delegar en registrarExportacionProspectos.

const llamadas: Array<{ actorId: string | null; n: number; filtros: Record<string, unknown> }> = [];

vi.mock('@/lib/auth/guard', () => ({
  requireSuperadmin: vi.fn(async () => ({ userId: 'u1', tenantId: null, rol: 'superadmin', nombre: 'Javier', operadorId: null, avatarUrl: null })),
}));
vi.mock('@/lib/admin/prospectos-mapa', () => ({
  registrarExportacionProspectos: async (actorId: string | null, n: number, filtros: Record<string, unknown>) => {
    llamadas.push({ actorId, n, filtros });
  },
}));

const { accionRegistrarExportacion } = await import('./acciones-exportar');
const { requireSuperadmin } = await import('@/lib/auth/guard');

beforeEach(() => { llamadas.length = 0; vi.clearAllMocks(); });

describe('accionRegistrarExportacion', () => {
  it('re-gatea superadmin antes de escribir', async () => {
    await accionRegistrarExportacion(10, {});
    expect(requireSuperadmin).toHaveBeenCalledTimes(1);
  });

  it('pasa el actorId de la sesión, no uno inventado', async () => {
    await accionRegistrarExportacion(10, {});
    expect(llamadas[0].actorId).toBe('u1');
  });

  it('un n negativo o no finito se sanea a 0 antes de escribir', async () => {
    await accionRegistrarExportacion(-5, {});
    expect(llamadas[0].n).toBe(0);
    await accionRegistrarExportacion(Number.NaN, {});
    expect(llamadas[1].n).toBe(0);
  });

  it('redondea un n fraccionario', async () => {
    await accionRegistrarExportacion(12.7, {});
    expect(llamadas[0].n).toBe(13);
  });

  it('trunca un filtro de texto largo a 200 caracteres — la bitácora no es un segundo almacén de lo que alguien escribió', async () => {
    const largo = 'x'.repeat(500);
    await accionRegistrarExportacion(1, { busqueda: largo });
    expect((llamadas[0].filtros.busqueda as string).length).toBe(200);
  });

  it('descarta claves reservadas por no estar en el allowlist, sin alterar el prototipo del filtro (alerta CodeQL 179)', async () => {
    const entrada = JSON.parse('{"__proto__":{"administrador":true},"constructor":"filtro","busqueda":"texto"}');
    await accionRegistrarExportacion(1, entrada);
    const filtros = llamadas[0].filtros;
    expect(Object.getPrototypeOf(filtros)).toBeNull();
    // __proto__ y constructor no son llaves de filtro reales: el allowlist las
    // descarta (antes solo se evitaba que contaminaran el prototipo, pero
    // igual quedaban como dato propio). busqueda SÍ es una llave real y pasa.
    expect(Object.hasOwn(filtros, '__proto__')).toBe(false);
    expect(Object.hasOwn(filtros, 'constructor')).toBe(false);
    expect(filtros).toEqual({ busqueda: 'texto' });
    expect(Object.getPrototypeOf({})).not.toHaveProperty('administrador');
  });

  it('descarta cualquier llave fuera del allowlist de filtros conocidos', async () => {
    await accionRegistrarExportacion(1, { giros: ['carga'], zzz: 'ajeno', otraLlave: 123 });
    expect(llamadas[0].filtros).toEqual({ giros: ['carga'] });
  });

  it('sin sesión privilegiada no registra ningún filtro', async () => {
    vi.mocked(requireSuperadmin).mockRejectedValueOnce(new Error('sesión denegada'));
    await expect(accionRegistrarExportacion(1, { busqueda: 'texto' })).rejects.toThrow('sesión denegada');
    expect(llamadas).toEqual([]);
  });

  it('conserva valores no-string tal cual (arrays, booleanos, números)', async () => {
    await accionRegistrarExportacion(1, { giros: ['carga', 'refrigerado'], soloTel: true, minUrgencia: 70 });
    expect(llamadas[0].filtros).toEqual({ giros: ['carga', 'refrigerado'], soloTel: true, minUrgencia: 70 });
  });
});
