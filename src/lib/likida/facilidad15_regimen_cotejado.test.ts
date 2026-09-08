import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 29 · FIS-C1 [CRÍTICO] — el sí/no del superadmin le gana a la clave
// del SAT, y el arreglo de FIS-A3 (auditoría 28) lo ASCENDIÓ de `tenant.config`
// (legado) a `tenant.perfil` (la fuente que decide).
//
// Antes de `b877f2f`, `actualizarFacilidad15` escribía SOLO `tenant.config`, así
// que un «Régimen: Sí» del panel PERDÍA contra cualquier declaración del perfil.
// Desde `b877f2f` escribe el perfil PRIMERO con `procedencia: 'declarado'` — la
// única procedencia que `decidir()` obedece — y por tanto le gana a todo,
// incluida la derivación correcta desde la clave `c_RegimenFiscal`.
//
// La norma es una CLAVE DEL SAT, no una opinión. `normas/rfa-2026-2.9.yaml`
// (`verificado_fuente_primaria`, líneas 9-12), literal:
//
//   «Los contribuyentes personas físicas o morales, dedicados exclusivamente al
//    autotransporte terrestre de carga federal, QUE TRIBUTEN CONFORME AL TÍTULO
//    II, CAPÍTULO VII O TÍTULO IV, CAPÍTULO II, SECCIÓN I DE LA LEY DEL ISR,
//    considerarán cumplida la obligación establecida en el artículo 27, fracción
//    III, segundo párrafo de la Ley del ISR…»
//
// Título II Capítulo VII = coordinados = clave 624. Título IV Cap. II Secc. I =
// PF con actividad empresarial = clave 612. El Título II a secas (la S.A. de
// C.V. ordinaria) es la clave 601 y NO entra — es exactamente lo que
// `administracion.ts` ya dice en su comentario `FISC-C2-1`: «Se falla cerrado a
// propósito: conceder de más imprime en el PDF, citando el artículo, una
// deducción que la norma niega».
//
// El escenario medido por la auditoría: flota S.A. de C.V. con `regimen_fiscal
// = '601'`, un CFDI de diésel de $11,600 en efectivo. Con el «Régimen: Sí» del
// panel, el motor pasa de $0.00 deducible / $0.00 de IVA acreditable a
// $11,600.00 deducible / $1,600.00 acreditable, y el PDF lo imprime citando la
// RFA 2026 regla 2.9.
//
// Lo que se fija aquí es el COTEJO: la declaración manual solo puede ir en la
// dirección conservadora. Conceder de más contra una clave que la niega se
// rechaza y NO se escribe nada — ni perfil ni config.
// ═══════════════════════════════════════════════════════════════════════════
const rpc = vi.fn();
const from = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ from: (...a: unknown[]) => from(...(a as [])), rpc: (...a: unknown[]) => rpc(...a) }),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/likida/bitacora_escritura', () => ({ anotarBitacora: vi.fn() }));

const { actualizarFacilidad15 } = await import('./repo');
const { DatoInvalido } = await import('./errores');

/** El `from('tenant').select('regimen_fiscal').eq('id', …).maybeSingle()` que
 *  hace el cotejo. Devuelve la clave que se le pida. */
function tenantConClave(regimenFiscal: string | null, error: { message: string } | null = null) {
  return () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: error ? null : { regimen_fiscal: regimenFiscal }, error }),
      }),
    }),
  });
}

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: {}, error: null });
  from.mockReset();
});

describe('FIS-C1 · la declaración manual del 15% se coteja contra la clave del SAT', () => {
  it('CLAVE 601 + «Régimen: Sí» → se rechaza y NO se escribe ni perfil ni config', async () => {
    from.mockImplementation(tenantConClave('601'));

    await expect(actualizarFacilidad15('t-9', true, true, 'u-super'))
      .rejects.toBeInstanceOf(DatoInvalido);

    // Lo que hace CRÍTICO al hallazgo no es el mensaje: es que la escritura
    // ocurra. Si `tenant_perfil_merge` corre, el motor ya deduce los $11,600.
    expect(rpc, 'ninguna escritura debe salir con la declaración contradictoria').not.toHaveBeenCalled();
  });

  it('el mensaje nombra la clave y la regla, para que el superadmin sepa qué corregir', async () => {
    from.mockImplementation(tenantConClave('601'));

    await expect(actualizarFacilidad15('t-9', true, true, 'u-super'))
      .rejects.toThrow(/601/);
    await expect(actualizarFacilidad15('t-9', true, true, 'u-super'))
      .rejects.toThrow(/2\.9/);
  });

  it('CLAVE 624 (coordinado) + «Régimen: Sí» → pasa: la clave y la declaración coinciden', async () => {
    from.mockImplementation(tenantConClave('624'));

    await actualizarFacilidad15('t-1', true, true, 'u-super');

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][0]).toBe('tenant_perfil_merge');
    expect(rpc.mock.calls[1][0]).toBe('tenant_config_merge');
  });

  it('CLAVE 612 (PF actividad empresarial) + «Régimen: Sí» → pasa', async () => {
    from.mockImplementation(tenantConClave('612'));
    await actualizarFacilidad15('t-1', true, true, 'u-super');
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('CLAVE 601 + «Régimen: No» → pasa: negar de más es la dirección segura', async () => {
    from.mockImplementation(tenantConClave('601'));

    await actualizarFacilidad15('t-9', true, false, 'u-super');

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_patch: { regimenElegible: { valor: false, procedencia: 'declarado' } },
    });
  });

  it('SIN clave en el tenant → pasa: no hay contradicción que cotejar, no se inventa una', async () => {
    from.mockImplementation(tenantConClave(null));
    await actualizarFacilidad15('t-1', true, true, 'u-super');
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('«sin declarar» (undefined/undefined) no coteja nada: es un BORRADO, no una concesión', async () => {
    from.mockImplementation(tenantConClave('601'));

    await actualizarFacilidad15('t-9', undefined, undefined, null);

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_borrar: ['facilidadCombustibleEfectivo'] });
  });

  it('si la lectura de la clave falla, se falla CERRADO: no se escribe a ciegas', async () => {
    from.mockImplementation(tenantConClave(null, { message: 'timeout' }));

    await expect(actualizarFacilidad15('t-9', true, true, 'u-super')).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
});
