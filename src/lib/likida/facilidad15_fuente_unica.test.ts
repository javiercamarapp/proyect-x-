import { describe, it, expect } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28, FIS-A3 (fuente única de la facilidad 15%, RFA 2026 regla 2.9).
//
// Antes de este lote había TRES lectores que reimplementaban la MISMA
// precedencia (perfil declarado primero, `tenant.config` como legado) cada
// uno por su cuenta: `cuadre/desde_db.ts` (el motor/PDF), `tools.ts`
// (`cuadrar_viaje`, lo que el agente dicta por WhatsApp) y `admin/negocio.ts`
// (lo que ve/edita el superadmin en `/admin/flotas`). Y el ESCRITOR de
// `/admin/flotas` (`actualizarFacilidad15`, repo.ts) solo tocaba
// `tenant.config` — nunca `tenant.perfil` — así que una corrección del
// superadmin podía quedar TAPADA por una declaración vieja del perfil en los
// lectores que preferían el perfil.
//
// Esta prueba fija el escenario exacto de la reincidencia a nivel del
// helper — `facilidad15Vigente`, la MISMA función que ahora llaman
// `desde_db.ts`, `fiscal.ts`, `tools.ts` y `admin/negocio.ts` — y por eso
// basta con probarla aquí una vez para garantizar que los cuatro coinciden:
// desde_db.ts lo prueba por su cuenta en `cuadre/facilidad15_desde_db.test.ts`
// (que el motor recibe el booleano correcto) y `tools.ts` en
// `facilidad15_fuente_unica_tools.test.ts` (que el camino REAL de la tool,
// invocado por `executeTool`, llega al mismo veredicto).
//
// El escenario: un perfil VIEJO declaró "Régimen: Sí"
// (dedicacionExclusivaCarga=true, regimenElegible=true) — por ejemplo en el
// onboarding. El superadmin, con mejor información, corrige en
// `/admin/flotas` a "Régimen: No" (regimenElegible=false). El legado
// (`tenant.config`) se deja A PROPÓSITO sin corregir en el fixture: lo que se
// prueba es que la fuente única (perfil) gana de todas formas — la corrección
// no se puede quedar tapada por config ni por un perfil desactualizado.
// ═══════════════════════════════════════════════════════════════════════════

import { facilidad15Vigente, declararFacilidad15 } from './perfil/preguntas';

const PERFIL_VIEJO = {
  dedicacionExclusivaCarga: { valor: true, procedencia: 'declarado' as const },
  regimenElegible: { valor: true, procedencia: 'declarado' as const },
};

/** Lo que `actualizarFacilidad15` (repo.ts) escribe en `tenant.perfil` tras la
 *  corrección del superadmin — la MISMA fusión que hace `tenant_perfil_merge`
 *  (mig. 0296): reemplaza SOLO las llaves del patch, deja el resto intacto. */
const perfilTrasCorreccion = (patch: Record<string, unknown>) => ({ ...PERFIL_VIEJO, ...patch });

/** El legado, deliberadamente SIN corregir en todos los fixtures de abajo. */
const CONFIG_LEGADO_SIN_CORREGIR = {
  facilidadCombustibleEfectivo: { dedicacionExclusivaCarga: true, regimenElegible: true },
};

describe('FIS-A3 · la corrección del superadmin en /admin/flotas se ve en la fuente única', () => {
  it('el patch que escribe `actualizarFacilidad15` reemplaza la declaración vieja del perfil', () => {
    // "Régimen: No" — dedicacionExclusivaCarga sigue en true, regimenElegible pasa a false.
    const patch = declararFacilidad15(true, false);
    const perfilNuevo = perfilTrasCorreccion(patch);

    expect(facilidad15Vigente(perfilNuevo, {})).toEqual({
      dedicacionExclusivaCarga: true,
      regimenElegible: false,
    });
  });

  it('la fuente única gana AUNQUE `tenant.config` (legado) siga diciendo "sí" — no hay lector que se quede con el dato viejo', () => {
    const perfilNuevo = perfilTrasCorreccion(declararFacilidad15(true, false));

    const par = facilidad15Vigente(perfilNuevo, CONFIG_LEGADO_SIN_CORREGIR);
    expect(par).toEqual({ dedicacionExclusivaCarga: true, regimenElegible: false });
    // El booleano combinado que consumen desde_db.ts/fiscal.ts/tools.ts.
    expect(par && par.dedicacionExclusivaCarga && par.regimenElegible).toBe(false);
  });

  it('retirar la declaración (ambos undefined) marca el perfil AUSENTE, no un "no" inventado', () => {
    const patch = declararFacilidad15(undefined, undefined);
    expect(patch).toEqual({
      dedicacionExclusivaCarga: { valor: null, procedencia: 'ausente' },
      regimenElegible: { valor: null, procedencia: 'ausente' },
    });
    // Sin declaración vigente en ninguna fuente: `undefined`, nunca `false`.
    expect(facilidad15Vigente(perfilTrasCorreccion(patch), {})).toBeUndefined();
  });
});

describe('FIS-A3 · admin/negocio.ts (lo que ve/edita el superadmin) refleja la corrección', () => {
  it('`facilidad15Vigente` es exactamente lo que `getResumenNegocio` publica como `flotas[].facilidad15`', () => {
    // negocio.ts hace: `facilidad15: facilidad15Vigente(t.perfil, cfg)` —
    // aquí se prueba la MISMA llamada con el fixture de la corrección, para
    // que el panel de edición prellene "Carga: Sí" / "Régimen: No" y no la
    // declaración vieja tapada.
    const perfilNuevo = perfilTrasCorreccion(declararFacilidad15(true, false));
    const cfg = { ...CONFIG_LEGADO_SIN_CORREGIR, politica: [] };

    expect(facilidad15Vigente(perfilNuevo, cfg)).toEqual({
      dedicacionExclusivaCarga: true,
      regimenElegible: false,
    });
  });
});
