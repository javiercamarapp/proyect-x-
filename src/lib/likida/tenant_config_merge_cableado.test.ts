import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 18 · DAT-20 — los CUATRO escritores de `tenant.config`.
//
// Los cuatro hacían lee-mezcla-escribe: `guardarPolitica`,
// `guardarAjustesOperativos` (administracion.ts, probados en su archivo),
// `actualizarFacilidad15` (repo.ts) y `guardarEstrategiaAgente`
// (agentes/estrategia.ts). La mezcla se hacía contra el `config` que se LEYÓ,
// no contra el que hay al escribir: dos ediciones a la vez y la de en medio
// desaparece en silencio. En `tenant.config` viven los topes fiscales, así que
// perder una mezcla no es perder una preferencia — es liquidar con los topes de
// otro.
//
// Aquí van los DOS que viven fuera de administracion.ts. Lo que se prueba no es
// la mezcla (la hace Postgres, y la comprueba el bloque 131 de
// verificaciones.sql): es que estos módulos ya no la armen ellos, que manden su
// parcial, y que "sin declarar" viaje como un BORRADO EXPLÍCITO — mandar `null`
// no serviría, porque `fusionarConfig` lo ignora y la declaración vieja
// seguiría en pie.
// ═══════════════════════════════════════════════════════════════════════════
const rpc = vi.fn();
const from = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ from: (...a: unknown[]) => from(...(a as [])), rpc: (...a: unknown[]) => rpc(...a) }),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const anotarBitacora = vi.fn();
vi.mock('@/lib/likida/bitacora_escritura', () => ({ anotarBitacora: (...a: unknown[]) => anotarBitacora(...a) }));

const { actualizarFacilidad15 } = await import('./repo');
const { guardarEstrategiaAgente } = await import('./agentes/estrategia');
const { DatoInvalido } = await import('./errores');

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: {}, error: null });
  from.mockReset();
  anotarBitacora.mockReset();
});

describe('actualizarFacilidad15 (RFA 2026 regla 2.9)', () => {
  // AUDITORÍA 28, FIS-A3 (fuente única): desde aquí, `actualizarFacilidad15`
  // escribe DOS RPCs — `tenant_perfil_merge` PRIMERO (la fuente que
  // `facilidad15Vigente` prefiere) y `tenant_config_merge` DESPUÉS (el
  // legado) — para que una corrección en `/admin/flotas` no quede tapada por
  // una declaración vieja del perfil en los otros lectores.
  it('declarada: escribe el perfil (fuente) y LUEGO su llave de config (legado), sin leer nada primero', async () => {
    await actualizarFacilidad15('t-1', true, false, 'u-1');

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][0]).toBe('tenant_perfil_merge');
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_tenant_id: 't-1',
      p_patch: {
        dedicacionExclusivaCarga: { valor: true, procedencia: 'declarado' },
        regimenElegible: { valor: false, procedencia: 'declarado' },
      },
      p_actualizado_por: 'u-1',
    });
    expect(rpc.mock.calls[1][0]).toBe('tenant_config_merge');
    expect(rpc.mock.calls[1][1]).toEqual({
      p_tenant: 't-1',
      p_parcial: { facilidadCombustibleEfectivo: { dedicacionExclusivaCarga: true, regimenElegible: false } },
      p_borrar: [],
    });
    expect(from, 'leer la config para mezclarla aquí era la mitad de la carrera').not.toHaveBeenCalled();
  });

  it('SIN declarar: borra la llave de config de verdad (no la pone en null) y marca el perfil AUSENTE', async () => {
    // Un `null` no la quita: `fusionarConfig` lo ignora (config.ts) y el motor
    // seguiría leyendo la declaración vieja. La flota que quiso retirar su
    // declaración se quedaría declarada.
    await actualizarFacilidad15('t-1', undefined, undefined, null);
    expect(rpc.mock.calls[0]).toMatchObject([
      'tenant_perfil_merge',
      {
        p_patch: {
          dedicacionExclusivaCarga: { valor: null, procedencia: 'ausente' },
          regimenElegible: { valor: null, procedencia: 'ausente' },
        },
      },
    ]);
    expect(rpc.mock.calls[1][1]).toEqual({
      p_tenant: 't-1',
      p_parcial: {},
      p_borrar: ['facilidadCombustibleEfectivo'],
    });
  });

  it('una declaración a medias (una sola condición) NO se guarda a medias: se retira en las DOS fuentes', async () => {
    // Las DOS condiciones o ninguna — con una sola, el motor la lee como "no
    // elegible" en silencio (es la regla del CHECK desde la 0083).
    await actualizarFacilidad15('t-1', true, undefined, null);
    expect(rpc.mock.calls[0]).toMatchObject([
      'tenant_perfil_merge',
      { p_patch: { dedicacionExclusivaCarga: { procedencia: 'ausente' }, regimenElegible: { procedencia: 'ausente' } } },
    ]);
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_borrar: ['facilidadCombustibleEfectivo'] });
  });

  it('si la fuente (perfil) falla, lanza y NUNCA llega a tocar el legado', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'timeout perfil' } });
    await expect(actualizarFacilidad15('t-1', true, true, null)).rejects.toThrow(/perfil/);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('si el legado (config) falla tras guardar la fuente, lanza: una facilidad que no se guardó del todo no se da por guardada', async () => {
    rpc
      .mockResolvedValueOnce({ data: {}, error: null }) // tenant_perfil_merge: ok
      .mockResolvedValueOnce({ data: null, error: { message: 'timeout' } }); // tenant_config_merge: falla
    await expect(actualizarFacilidad15('t-1', true, true, null)).rejects.toThrow(/actualizarFacilidad15/);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});

describe('guardarEstrategiaAgente', () => {
  it('manda el parcial bajo `agentes` y deja la mezcla profunda a la base', async () => {
    // El subárbol importa: guardar la estrategia del agente de liquidación no
    // puede borrar la del de conductores, y el `||` de jsonb haría justo eso.
    await guardarEstrategiaAgente('t-1', { liquidacion: { umbralConfianza: 0.85 } });

    expect(rpc.mock.calls[0][0]).toBe('tenant_config_merge');
    expect(rpc.mock.calls[0][1]).toEqual({
      p_tenant: 't-1',
      p_parcial: { agentes: { liquidacion: { umbralConfianza: 0.85 } } },
      p_borrar: [],
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('anota la bitácora DESPUÉS de guardar, con el parcial que se guardó', async () => {
    await guardarEstrategiaAgente('t-1', { conductores: { horasEscalacion: 5 } }, { id: 'u-1' });
    expect(anotarBitacora.mock.calls[0][0]).toMatchObject({
      tenantId: 't-1', accion: 'agente.estrategia', detalle: { conductores: { horasEscalacion: 5 } },
    });
  });

  it('una flota que no existe (CU013) es dato de entrada, no una caída', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'CU013', message: 'flota inexistente' } });
    await expect(guardarEstrategiaAgente('t-fantasma', { conductores: { horasEscalacion: 5 } }))
      .rejects.toThrow(DatoInvalido);
    expect(anotarBitacora, 'lo que no se guardó no se anota').not.toHaveBeenCalled();
  });

  it('la base caída NO se disfraza de dato malo, y no anota nada', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: '57014 statement timeout' } });
    const err = await guardarEstrategiaAgente('t-1', { conductores: { horasEscalacion: 5 } }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DatoInvalido);
    expect(anotarBitacora).not.toHaveBeenCalled();
  });

  // ── El hallazgo que salió al migrarla ─────────────────────────────────────
  //
  // El CHECK `tenant_config_valida` no conocía la llave `agentes`: esta función
  // NUNCA pudo guardar nada: `update tenant set config = '{"agentes":…}'` rebota
  // con "la llave agentes, que CuadraConfig no conoce". La 0159 le da su propio
  // CHECK. Si alguien recrea el constraint sin excluir `agentes`, la pantalla
  // de estrategia vuelve a estar muerta.
  it('la 0159 deja `agentes` fuera del CHECK viejo y le pone el suyo', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync('supabase/migrations/0159_rpcs_atomicas.sql', 'utf8');
    expect(sql).toContain("config_tenant_valida(config - 'agentes')");
    expect(sql).toContain("config_agentes_valida(config -> 'agentes')");
  });
});
