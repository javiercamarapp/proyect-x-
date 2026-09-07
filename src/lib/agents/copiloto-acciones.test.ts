import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// LAS ACCIONES DEL COPILOTO — el ejecutor determinista. Lo que se fija:
// el catálogo rechaza lo desconocido y lo no implementado CON PALABRAS,
// apagar_agente valida el interruptor y delega en la MISMA función del ⌘K
// (que ya exige motivo y ya anota bitácora — una puerta más, un mecanismo),
// y correr_runner CUMPLE su contrato: el motivo que exige llega de verdad a
// bitacora_auditoria (P2 de la auditoría externa del 16-ago: el comentario
// lo prometía y la implementación no escribía nada).
// ═══════════════════════════════════════════════════════════════════════════

const apagar = vi.fn(async () => {});
vi.mock('@/lib/likida/interruptores', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, apagar };
});

const correrRunner = vi.fn(async () => ({
  apagadoGlobal: false,
  agentes: [{ agente: 'redactor', resultado: 'corrio' as const, piezas: 2, saltados: 1, costoUsd: 0.0123 }],
}));
vi.mock('@/lib/likida/agentes/runner', () => ({ correrRunner }));

// La bitácora del copiloto se escribe directo (patrón de interruptores.ts);
// `insertBitacora` captura la fila para poder afirmar qué se anotó.
const insertBitacora = vi.fn((_fila: Record<string, unknown>) => ({ error: null as { message: string } | null }));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => ({ insert: (fila: Record<string, unknown>) => insertBitacora({ tabla, ...fila }) }),
  }),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { ejecutarAccionCopiloto, CATALOGO_ACCIONES, accionDelCatalogo } = await import('./copiloto-acciones');
const { DatoInvalido } = await import('@/lib/likida/errores');

beforeEach(() => {
  apagar.mockClear(); correrRunner.mockClear(); insertBitacora.mockClear();
  insertBitacora.mockImplementation(() => ({ error: null }));
});

describe('el catálogo de acciones', () => {
  it('las 10 acciones del catálogo existen, y SOLO apagar_agente y correr_runner están implementadas', () => {
    expect(CATALOGO_ACCIONES).toHaveLength(10);
    const implementadas = CATALOGO_ACCIONES.filter((a) => a.implementada).map((a) => a.id);
    expect(implementadas).toEqual(['apagar_agente', 'correr_runner']);
  });

  it('toda acción 🔴 del diseño está marcada doble — el gateo es contrato, no default', () => {
    for (const id of ['encender_agente', 'aprobar_pendiente', 'rechazar_pendiente', 'marcar_pago_conciliado', 'reabrir_liquidacion']) {
      expect(accionDelCatalogo(id)?.gateo, id).toBe('doble');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA E.28, H4 — LA TARJETA DE `correr_runner` YA NO PUEDE DECIR
// "jamás envía nada".
//
// La tarjeta es lo que Javier lee para FIRMAR la ejecución (previsualización
// del copiloto / ⌘K). Antes de este arreglo decía que `correr_runner`
// "fabrica borradores hacia Aprobaciones — jamás envía nada", pero
// `AGENTES_DESPACHABLES` (runner.ts) incluye `enviador`, que se auto-aprueba
// y manda correo real por Resend sin que ningún humano lo revise primero
// (`enviador.ts`, orden del 27-ago-2026). Es la MISMA clase de bug que M30
// (auditoría 18) ya corrigió una vez: una compuerta de agente que describe
// mal su propio efecto.
//
// Esta prueba fija DOS cosas para que no se puedan deshacer a medias:
//  · el hecho de dominio que hace falsa la frase vieja — `enviador` SIGUE
//    despachable por el runner (si algún día deja de estarlo, esta prueba lo
//    dice, y ahí sí la tarjeta podría volver a simplificarse);
//  · que la tarjeta ACTUAL ya no promete lo que no cumple, y sí nombra la
//    excepción real.
// ═══════════════════════════════════════════════════════════════════════════
describe('H4 — la tarjeta de correr_runner no miente sobre el envío autónomo', () => {
  it('"enviador" sigue en AGENTES_DESPACHABLES del runner (el hecho que la tarjeta tiene que reflejar)', async () => {
    // `@/lib/likida/agentes/runner` está mockeado arriba para el resto de este
    // archivo; `importActual` trae el módulo real solo para esta afirmación.
    const real = await vi.importActual<typeof import('@/lib/likida/agentes/runner')>('@/lib/likida/agentes/runner');
    expect(real.AGENTES_DESPACHABLES).toContain('enviador');
  });

  it('la tarjeta de correr_runner ya no promete "jamás envía nada"', () => {
    const tarjeta = accionDelCatalogo('correr_runner')!;
    expect(tarjeta.efecto).not.toMatch(/jamás env[ií]a nada/i);
    expect(tarjeta.efecto + ' ' + tarjeta.revertir).not.toMatch(/nunca env[ií]a/i);
  });

  it('la tarjeta nombra a "enviador" como la excepción que SÍ manda correo autónomo', () => {
    const tarjeta = accionDelCatalogo('correr_runner')!;
    expect(tarjeta.efecto).toContain('enviador');
    expect(tarjeta.efecto).toMatch(/manda correo|env[ií]a correo/i);
    expect(tarjeta.efecto).toMatch(/auto-aprob/i);
    // Y deja claro que lo mandado no se puede deshacer — a diferencia de un
    // borrador, que sí se rechaza desde la bandeja.
    expect(tarjeta.revertir).toMatch(/no se deshace|NO se deshace/);
  });
});

describe('ejecutarAccionCopiloto', () => {
  it('una acción fuera del catálogo se rechaza con texto para pantalla', async () => {
    await expect(ejecutarAccionCopiloto('borrar_todo', {}, 'u-1')).rejects.toThrow(DatoInvalido);
    expect(apagar).not.toHaveBeenCalled();
  });

  it('una acción del catálogo NO implementada se rechaza diciéndolo con esas palabras', async () => {
    await expect(ejecutarAccionCopiloto('encender_agente', { id: 'agente:cobranza' }, 'u-1'))
      .rejects.toThrow(/no está implementada/);
  });

  it('apagar_agente con un interruptor que no existe se rechaza sin tocar la palanca', async () => {
    await expect(ejecutarAccionCopiloto('apagar_agente', { id: 'agente:inventado', motivo: 'x' }, 'u-1'))
      .rejects.toThrow(/no es un interruptor/);
    expect(apagar).not.toHaveBeenCalled();
  });

  it('apagar_agente delega en apagar() con el interruptor, el motivo y el userId DE LA SESIÓN', async () => {
    const r = await ejecutarAccionCopiloto('apagar_agente', { id: 'agente:cobranza', motivo: 'está mandando de más' }, 'u-javier');
    expect(r.ok).toBe(true);
    expect(apagar).toHaveBeenCalledWith('agente:cobranza', 'está mandando de más', 'u-javier');
  });

  // TC-M2 (auditoría 28, mitad): el mensaje de éxito de apagar_agente decía
  // "Se enciende desde Observabilidad (doble confirmación)" — la MISMA
  // promesa falsa que ADM-13 (auditoría 24) ya había corregido en el campo
  // `revertir` del catálogo, pero que se quedó viva aquí, por fuera. Ni
  // /admin/observabilidad ni el ⌘K piden una segunda confirmación para
  // ENCENDER: solo APAGAR pide motivo.
  it('el mensaje de éxito NO promete una doble confirmación para encender que no existe', async () => {
    const r = await ejecutarAccionCopiloto('apagar_agente', { id: 'agente:cobranza', motivo: 'está mandando de más' }, 'u-javier');
    expect(r.mensaje).not.toMatch(/doble confirmaci[oó]n/i);
    expect(r.mensaje).toMatch(/un clic/i);
  });

  it('el motivo vacío VIAJA a apagar() — quien lo rebota es la función real, no una copia de su regla', async () => {
    apagar.mockRejectedValueOnce(new DatoInvalido('Apagar exige un motivo.'));
    await expect(ejecutarAccionCopiloto('apagar_agente', { id: 'agente:cobranza' }, 'u-1'))
      .rejects.toThrow(/motivo/);
  });
});

describe('correr_runner y su bitácora — el contrato que el comentario declara', () => {
  it('sin motivo se rechaza SIN correr el runner ni tocar la bitácora', async () => {
    await expect(ejecutarAccionCopiloto('correr_runner', {}, 'u-1')).rejects.toThrow(/motivo/);
    expect(correrRunner).not.toHaveBeenCalled();
    expect(insertBitacora).not.toHaveBeenCalled();
  });

  it('escribe SU entrada en bitacora_auditoria: el motivo, el userId de la sesión y qué corrió', async () => {
    const r = await ejecutarAccionCopiloto('correr_runner', { motivo: 'demo con GAL en una hora' }, 'u-javier');
    expect(r.ok).toBe(true);
    expect(insertBitacora).toHaveBeenCalledTimes(1);
    const fila = insertBitacora.mock.calls[0][0];
    expect(fila).toMatchObject({
      tabla: 'bitacora_auditoria',
      tenant_id: null, // el runner es de PLATAFORMA, no de una flota
      actor_id: 'u-javier',
      accion: 'runner.corrida_manual',
      entidad: 'runner',
    });
    const detalle = fila.detalle as Record<string, unknown>;
    expect(detalle.motivo).toBe('demo con GAL en una hora');
    expect(detalle.apagado_global).toBe(false);
    expect(detalle.agentes).toEqual([{ agente: 'redactor', resultado: 'corrio' }]);
  });

  it('la vuelta que el kill switch global dejó en nada TAMBIÉN se firma — la acción confirmada fue correr', async () => {
    correrRunner.mockResolvedValueOnce({ apagadoGlobal: true, agentes: [] });
    const r = await ejecutarAccionCopiloto('correr_runner', { motivo: 'probar tras el incidente' }, 'u-1');
    expect(r.ok).toBe(true);
    expect(insertBitacora).toHaveBeenCalledTimes(1);
    const detalle = insertBitacora.mock.calls[0][0].detalle as Record<string, unknown>;
    expect(detalle.apagado_global).toBe(true);
  });

  it('la bitácora es best-effort: si no escribe, la acción NO se cae (el runner ya corrió)', async () => {
    insertBitacora.mockReturnValueOnce({ error: { message: 'la base se cayó' } });
    const r = await ejecutarAccionCopiloto('correr_runner', { motivo: 'una razón' }, 'u-1');
    expect(r.ok).toBe(true);
    expect(r.mensaje).toContain('runner');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 18 · M30 — la previsualización enseñaba "Voy a ejecutar
// `redactor`" y el ejecutor tiraba el objetivo: `correrRunner()` sin
// argumentos despachaba a TODOS los habilitados. Ahora el objetivo que la
// tarjeta enseñó es el que corre.
// ═══════════════════════════════════════════════════════════════════════════
const { objetivoDelRunner } = await import('./copiloto-acciones');

describe('M30 — correr_runner respeta el objetivo que Javier confirmó', () => {
  // AUDITORÍA 24, AGB-7 (integración): `correrRunner` ahora recibe un tercer
  // argumento con `venceEn` (la ruta del copiloto tiene maxDuration=60; sin
  // reloj el runner podía correr más de lo que la invocación aguanta). El
  // objetivo (primer argumento) sigue siendo lo que este bloque prueba —
  // `expect.any(Number)` en el tercer argumento no ancla un instante exacto
  // de `Date.now()`, ancla que SE MANDÓ un reloj.
  it('objetivo "redactor" → correrRunner("redactor"), y la bitácora lo anota', async () => {
    await ejecutarAccionCopiloto('correr_runner', { id: 'redactor', motivo: 'adelantar la demo' }, 'u-javier');
    expect(correrRunner).toHaveBeenCalledWith('redactor', undefined, { venceEn: expect.any(Number) });
    const detalle = insertBitacora.mock.calls[0][0].detalle as Record<string, unknown>;
    expect(detalle.objetivo).toBe('redactor');
  });

  it('"agente:redactor" (la forma del catálogo de interruptores) también acota', async () => {
    await ejecutarAccionCopiloto('correr_runner', { id: 'agente:redactor', motivo: 'x' }, 'u-1');
    expect(correrRunner).toHaveBeenCalledWith('redactor', undefined, { venceEn: expect.any(Number) });
  });

  it('"runner" / vacío = la vuelta completa (lo que describe `efecto`)', async () => {
    await ejecutarAccionCopiloto('correr_runner', { id: 'runner', motivo: 'x' }, 'u-1');
    expect(correrRunner).toHaveBeenCalledWith(undefined, undefined, { venceEn: expect.any(Number) });
    await ejecutarAccionCopiloto('correr_runner', { motivo: 'x' }, 'u-1');
    expect(correrRunner).toHaveBeenLastCalledWith(undefined, undefined, { venceEn: expect.any(Number) });
  });

  it('un agente que no está habilitado para el runner se DICE, no se finge una vuelta', async () => {
    correrRunner.mockResolvedValueOnce({ apagadoGlobal: false, agentes: [] });
    const r = await ejecutarAccionCopiloto('correr_runner', { id: 'cobranza', motivo: 'x' }, 'u-1');
    expect(r.ok).toBe(true);
    expect(r.mensaje).toContain('"cobranza" no está habilitado');
  });

  it('objetivoDelRunner normaliza', () => {
    expect(objetivoDelRunner(undefined)).toBeUndefined();
    expect(objetivoDelRunner('  Todos ')).toBeUndefined();
    expect(objetivoDelRunner('AGENTE:Redactor')).toBe('redactor');
  });
});
