import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatoInvalido } from '../errores';
// `@/lib/llm/budget` NO está mockeado en esta suite: `LlmBudgetExceededError`
// es la clase real (TC-B3, auditoría 28).
import { LlmBudgetExceededError } from '@/lib/llm/budget';

const alertarOperador = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('@/lib/observability/alerta', () => ({ alertarOperador: (...a: unknown[]) => alertarOperador(...a) }));

// ═══════════════════════════════════════════════════════════════════════════
// EL RUNNER NIVEL 2 (0123) — los cuatro candados, todos fail-closed:
//  · Global abajo = no corre nada. Agente sin kill switch declarado = no
//    corre. Interruptor ilegible = no corre.
//  · Sin techo declarado NO hay autonomía; techo agotado o gasto ilegible,
//    tampoco.
//  · Backpressure: bandeja llena = no se fabrica encima.
//  · El lote corta por piezas y por presupuesto, y un prospecto que rebota
//    en las guardas NO tumba el lote.
// ═══════════════════════════════════════════════════════════════════════════

const respuestas = new Map<string, Array<{ data?: unknown; error?: { message: string } | null; count?: number }>>();
const llamadasRpc: Array<{ fn: string; args: Record<string, unknown> }> = [];
function builder(tabla: string) {
  const responder = () => {
    const cola = respuestas.get(tabla);
    return cola && cola.length > 0 ? cola.shift()! : { data: [], error: null };
  };
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: () => b, eq: () => b, is: () => b, not: () => b, gte: () => b, order: () => b,
    limit: () => b, range: () => b,
    then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve().then(responder).then(res, rej),
  });
  return b;
}
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({
  from: (t: string) => builder(t),
  rpc: (fn: string, args: Record<string, unknown>) => {
    llamadasRpc.push({ fn, args });
    const cola = respuestas.get(`rpc:${fn}`);
    return Promise.resolve(cola && cola.length ? cola.shift()! :
      (fn === 'reservar_presupuesto_agente'
        ? { data: [{ id: 'reserva-1', disponible_usd: 1 }], error: null }
        : { data: true, error: null }));
  },
}) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// importOriginal (y no un reemplazo total): importar `AGENTES_EXITO` real
// (`./exito`, guardia MEDIO 1 de la auditoría 21) arrastra `../contactos` →
// `conv.ts`, que necesita `PRESUPUESTO_WEBHOOK_MS` real de este módulo.
vi.mock('@/lib/likida/presupuesto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/likida/presupuesto')>()),
  acotada: (q: unknown) => q,
}));

let apagados = new Set<string>();
let interruptorFalla = false;
vi.mock('../interruptores', () => ({
  INTERRUPTORES: ['global', 'agente:redactor', 'agente:kpi_whatsapp',
    'agente:vigilante_calidad', 'agente:documentacion', 'agente:legal_compliance', 'agente:talento',
    'agente:onboarding_cliente', 'agente:atencion_faq',
    // Los dos de abajo solo los usan las pruebas del reloj (25-ago-2026):
    // el corte necesita TRES agentes deterministas seguidos para que haya un
    // «antes del tercero» que verificar.
    'agente:exito_cliente', 'agente:soporte',
    // Crecimiento (0230): el que gasta modelo y dos deterministas.
    'agente:contenido_fiscal', 'agente:lead_magnet', 'agente:promos_diarias',
    // Ingeniería (0234): dos de los ocho, que es lo que la rama necesita.
    'agente:migraciones', 'agente:seguridad',
    // Los nueve de la 0235. `agente:cazador` se deja FUERA a propósito: es el
    // que las pruebas usan para verificar que un agente con motor pero sin
    // palanca declarada tampoco corre (candado 1).
    'agente:automejora', 'agente:especialistas_incidente', 'agente:fundraising',
    'agente:scorer', 'agente:dossier', 'agente:vigia',
    'agente:demo_prep', 'agente:propuestas'],
  estaApagado: async (n: string) => {
    if (interruptorFalla && n !== 'global') throw new Error('base caída');
    return apagados.has(n);
  },
}));

const redactar = vi.fn(async (..._a: unknown[]) => ({ piezaId: 'p', asunto: 'x', aviso: null, costoUsd: 0.001 }));
vi.mock('./redactor', () => ({ redactarCorreoFrio: (...a: unknown[]) => redactar(...a) }));

// El motor de dirección (0216) se despacha por import dinámico; el mock
// aplica igual y evita arrastrar los lectores reales de /admin. La constante
// NO se mockea — es la lista real del motor contra la que se compara la
// literal del runner (mismo trato que el back office restante).
const correrDireccion = vi.fn(async (_a: unknown) => ({ resultado: 'corrio' as const, piezas: 1, costoUsd: 0 }));
const { AGENTES_DIRECCION } = await import('../direccion/reportes');
vi.mock('../direccion/reportes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../direccion/reportes')>()),
  correrAgenteDireccion: (...a: unknown[]) => correrDireccion(...(a as [unknown])),
}));

// El back office restante (0219) entra por el mismo camino: import dinámico
// dentro de su rama. El predicado NO se mockea — es la lista real del motor
// contra la que se compara la literal del runner.
const correrBackOffice = vi.fn(async (..._a: unknown[]): Promise<{ piezas: number; motivo?: string; sinTurno?: boolean }> => ({ piezas: 1 }));
const { AGENTES_BACK_OFFICE, esAgenteBackOffice } = await import('./backoffice');
vi.mock('./backoffice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./backoffice')>()),
  correrAgenteBackOffice: (...a: unknown[]) => correrBackOffice(...(a as [unknown])),
}));

// Éxito del cliente (0218): mismo trato que dirección — import dinámico en el
// runner, mock aquí, y así la vuelta no arrastra los lectores de /admin ni el
// corpus de normas. El predicado y la constante NO se mockean — son la lista
// real del motor contra la que se compara la literal del runner (mismo trato
// que el back office restante y crecimiento).
const correrExito = vi.fn(async (..._a: unknown[]): Promise<{ resultado: 'corrio' | 'saltado'; piezas: number; costoUsd: number; motivo?: string; sinTurno?: boolean }> => ({ resultado: 'corrio', piezas: 1, costoUsd: 0 }));
const { AGENTES_EXITO, esAgenteExito } = await import('./exito');
vi.mock('./exito', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exito')>()),
  correrAgenteExito: (...a: unknown[]) => correrExito(...a),
}));

// Crecimiento (0230): mismo trato que el back office — import dinámico en el
// runner y el predicado REAL (no mockeado), que es contra el que se compara la
// lista literal del despacho. Mockear el motor evita arrastrar la calculadora
// y el índice de normas a esta suite.
const correrCrecimiento = vi.fn(async (..._a: unknown[]) => ({ resultado: 'corrio' as const, piezas: 1, costoUsd: 0 as number | null }));
const { AGENTES_CRECIMIENTO, esAgenteCrecimiento } = await import('./crecimiento');
vi.mock('./crecimiento', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./crecimiento')>()),
  correrAgenteCrecimiento: (...a: unknown[]) => correrCrecimiento(...a),
}));

// Ingeniería (0234): mismo trato que crecimiento — import dinámico en el
// runner y el predicado REAL (no mockeado), que es contra el que se compara la
// lista literal del despacho. Mockear el motor evita arrastrar los lectores del
// catálogo de PostgreSQL y del despliegue a esta suite.
const correrIngenieria = vi.fn(async (..._a: unknown[]) => ({ resultado: 'corrio' as const, piezas: 1, costoUsd: 0 }));
const { AGENTES_INGENIERIA, esAgenteIngenieria } = await import('./ingenieria');
vi.mock('./ingenieria', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ingenieria')>()),
  correrAgenteIngenieria: (...a: unknown[]) => correrIngenieria(...a),
}));

// Los nueve de la 0235, por el mismo camino que el back office y crecimiento:
// import dinámico en el runner, predicado REAL (no mockeado) contra el que se
// compara la lista literal del despacho, y motor mockeado para que esta suite
// no arrastre los lectores de salud, de la cola ni del CRM.
const correrDireccionBandeja = vi.fn(async (..._a: unknown[]) => ({ resultado: 'corrio' as const, piezas: 1, costoUsd: 0 } as { resultado: 'corrio' | 'saltado'; piezas: number; costoUsd: number; motivo?: string; sinTurno?: boolean }));
const { AGENTES_DIRECCION_BANDEJA, esAgenteDireccionBandeja } = await import('./direccion');
vi.mock('./direccion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./direccion')>()),
  correrAgenteDireccionBandeja: (...a: unknown[]) => correrDireccionBandeja(...a),
}));

const correrLeads = vi.fn(async (..._a: unknown[]) => ({ resultado: 'corrio' as const, piezas: 1, costoUsd: 0 } as { resultado: 'corrio' | 'saltado'; piezas: number; costoUsd: number; motivo?: string; sinTurno?: boolean }));
const { AGENTES_LEADS, esAgenteLeads } = await import('./leads');
vi.mock('./leads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./leads')>()),
  correrAgenteLeads: (...a: unknown[]) => correrLeads(...a),
}));

const {
  correrRunner, ordenarPorCosto, llamaAlModelo, AGENTES_DESPACHABLES,
  MARGEN_RELOJ_MS, PLAZO_RUNNER_MS,
  PASOS_LATIDO, COSTO_LATIDO_MS, conRelojDuro, nuevoAvanceRunner, cerrarPorRelojDuro,
  motivoBandejaGlobalSinAtender, topeBandejaGlobal, diasVencimientoPieza,
} = await import('./runner');
type ResultadoRunner = import('./runner').ResultadoRunner;

const REDACTOR = { id: 'redactor', presupuesto_dia_usd: 1.0 };
const TENANT = 'tenant-runner-test';

beforeEach(() => {
  respuestas.clear();
  llamadasRpc.length = 0;
  apagados = new Set();
  interruptorFalla = false;
  redactar.mockClear();
  alertarOperador.mockClear();
  redactar.mockResolvedValue({ piezaId: 'p', asunto: 'x', aviso: null, costoUsd: 0.001 });
  correrDireccion.mockClear();
  correrDireccion.mockResolvedValue({ resultado: 'corrio', piezas: 1, costoUsd: 0 });
  correrBackOffice.mockClear();
  correrBackOffice.mockResolvedValue({ piezas: 1 });
  correrExito.mockClear();
  correrExito.mockResolvedValue({ resultado: 'corrio', piezas: 1, costoUsd: 0 });
  correrCrecimiento.mockClear();
  correrCrecimiento.mockResolvedValue({ resultado: 'corrio', piezas: 1, costoUsd: 0 });
  correrIngenieria.mockClear();
  correrIngenieria.mockResolvedValue({ resultado: 'corrio', piezas: 1, costoUsd: 0 });
  correrDireccionBandeja.mockClear();
  correrDireccionBandeja.mockResolvedValue({ resultado: 'corrio', piezas: 1, costoUsd: 0 });
  correrLeads.mockClear();
  correrLeads.mockResolvedValue({ resultado: 'corrio', piezas: 1, costoUsd: 0 });
});

describe('los cuatro candados', () => {
  it('global abajo: no corre nada y se dice', async () => {
    apagados.add('global');
    const r = await correrRunner(undefined, TENANT);
    expect(r.apagadoGlobal).toBe(true);
    expect(redactar).not.toHaveBeenCalled();
  });

  it('un agente habilitado SIN kill switch declarado no corre — inapagable = inexistente', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'fantasma', presupuesto_dia_usd: 1 }], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0]).toMatchObject({ agente: 'fantasma', resultado: 'saltado' });
    expect(r.agentes[0].motivo).toMatch(/kill switch/);
  });

  it('interruptor apagado o ILEGIBLE: no corre (fail closed)', async () => {
    apagados.add('agente:redactor');
    respuestas.set('agente_definicion', [{ data: [REDACTOR], error: null }]);
    let r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0].motivo).toMatch(/apagado/);

    apagados.clear();
    interruptorFalla = true;
    respuestas.set('agente_definicion', [{ data: [REDACTOR], error: null }]);
    r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0].motivo).toMatch(/fail closed/);
    expect(redactar).not.toHaveBeenCalled();
  });

  it('sin techo declarado NO hay autonomía; techo agotado tampoco', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'redactor', presupuesto_dia_usd: null }], error: null }]);
    let r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0].motivo).toMatch(/sin presupuesto/);

    respuestas.set('agente_definicion', [{ data: [REDACTOR], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: null, error: null, count: 0 }]);
    r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0].resultado).toBe('corrio');
    expect(redactar).not.toHaveBeenCalled();
  });

  it('sin tenant explícito, la corrida es de PLATAFORMA (c5-10): gasto medido vs techo, y el lote corre', async () => {
    respuestas.set('agente_definicion', [{ data: [REDACTOR], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: null, error: null, count: 0 }]);
    respuestas.set('agente_corrida', [{ data: [{ costo_usd: 0.01 }], error: null }]);   // gasto del día
    respuestas.set('prospecto', [{ data: [{ id: 'pr-1', vendedor: null }], error: null }]);
    const r = await correrRunner();
    expect(r.agentes[0].resultado).toBe('corrio');
    // El redactor recibió el contexto de plataforma, no un tenant inventado.
    expect(redactar).toHaveBeenCalledWith('pr-1', 'Javier', 'cron', { plataforma: true });
  });

  it('plataforma con el techo diario ya gastado: saltado con el motivo (c5-10)', async () => {
    respuestas.set('agente_definicion', [{ data: [REDACTOR], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: null, error: null, count: 0 }]);
    respuestas.set('agente_corrida', [{ data: [{ costo_usd: 99 }], error: null }]);
    const r = await correrRunner();
    expect(r.agentes[0].resultado).toBe('saltado');
    expect(r.agentes[0].motivo).toMatch(/techo diario/);
    expect(redactar).not.toHaveBeenCalled();
  });

  it('backpressure: la bandeja llena frena la fábrica', async () => {
    respuestas.set('agente_definicion', [{ data: [REDACTOR], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: null, error: null, count: 25 }]);
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0].motivo).toMatch(/bandeja con 25/);
    expect(redactar).not.toHaveBeenCalled();
  });
});

describe('el lote', () => {
  it('fabrica hasta el tope de piezas y un rebote de guarda NO tumba el lote', async () => {
    respuestas.set('agente_definicion', [{ data: [REDACTOR], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: null, error: null, count: 0 }]);
    respuestas.set('prospecto', [{
      data: Array.from({ length: 8 }, (_, i) => ({ id: `pr-${i}`, vendedor: null })), error: null,
    }]);
    // El segundo candidato rebota en la guarda (cadencia) — el lote sigue.
    redactar.mockImplementation(async (id: unknown) => {
      if (id === 'pr-1') throw new Error('la cadencia lo protege');
      return { piezaId: 'p', asunto: 'x', aviso: null, costoUsd: 0.001 };
    });
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0].motivo).toBeUndefined();
    expect(r.agentes[0]).toMatchObject({ resultado: 'corrio', piezas: 5, saltados: 1 });
  });

  it('el lote recibe un único presupuesto central por toda la corrida', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'redactor', presupuesto_dia_usd: 0.005 }], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: null, error: null, count: 0 }]);
    respuestas.set('prospecto', [{
      data: Array.from({ length: 8 }, (_, i) => ({ id: `pr-${i}`, vendedor: null })), error: null,
    }]);
    redactar.mockResolvedValue({ piezaId: 'p', asunto: 'x', aviso: null, costoUsd: 0.002 });
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0].motivo).toBeUndefined();
    expect(r.agentes[0].piezas).toBe(5);
    expect(redactar.mock.calls.every((call) => (call[3] as { tenantId?: string }).tenantId === TENANT)).toBe(true);
  });

  // AGB-11 (auditoría 24, 1-sep-2026) — 21 de 48 corridas del redactor
  // fallaron con el MISMO error contra el modelo, y el runner las pagaba
  // todas sin cortar: 100 s de reloj por 0 piezas.
  it('AGB-11: tres fallos del modelo SEGUIDOS cortan el lote, con el motivo dicho, y alertan al operador', async () => {
    respuestas.set('agente_definicion', [{ data: [REDACTOR], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: null, error: null, count: 0 }]);
    respuestas.set('prospecto', [{
      data: Array.from({ length: 8 }, (_, i) => ({ id: `pr-${i}`, vendedor: null })), error: null,
    }]);
    redactar.mockRejectedValue(new DatoInvalido('El Redactor no pudo escribir en este momento — inténtalo de nuevo.'));
    const r = await correrRunner(undefined, TENANT);
    expect(redactar).toHaveBeenCalledTimes(3);
    expect(r.agentes[0]).toMatchObject({ resultado: 'corrio', piezas: 0, saltados: 3 });
    expect(r.agentes[0].motivo).toMatch(/3 fallos del modelo SEGUIDOS/);
    expect(alertarOperador).toHaveBeenCalledWith('redactor.fallos_seguidos', expect.objectContaining({ codigo: 'redactor_fallos_modelo_seguidos' }));
  });

  it('AGB-11: un rebote de GUARDA (no del modelo) intercalado no cuenta para la racha — no corta el lote', async () => {
    respuestas.set('agente_definicion', [{ data: [REDACTOR], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: null, error: null, count: 0 }]);
    respuestas.set('prospecto', [{
      data: Array.from({ length: 8 }, (_, i) => ({ id: `pr-${i}`, vendedor: null })), error: null,
    }]);
    let llamada = 0;
    redactar.mockImplementation(async () => {
      llamada += 1;
      // modelo, modelo, GUARDA (rompe la racha), modelo, modelo, GUARDA,
      // modelo, modelo — nunca hay TRES fallos de modelo seguidos.
      if (llamada === 3 || llamada === 6) throw new DatoInvalido('A este prospecto se le escribió hace menos de 48 horas — la cadencia lo protege.');
      throw new DatoInvalido('El Redactor no pudo escribir en este momento — inténtalo de nuevo.');
    });
    const r = await correrRunner(undefined, TENANT);
    // Nadie produjo pieza (piezas nunca llega al tope), así que sin el corte
    // de AGB-11 el lote recorre los 8 candidatos enteros.
    expect(redactar).toHaveBeenCalledTimes(8);
    expect(alertarOperador).not.toHaveBeenCalled();
    expect(r.agentes[0].motivo).toBeUndefined();
    expect(r.agentes[0]).toMatchObject({ piezas: 0, saltados: 8 });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AUDITORÍA 28, TC-B3 — el `break` por presupuesto era código muerto:
  // `redactarCorreoFrio` aplanaba el tope de presupuesto en `DatoInvalido`
  // genérico, y este `catch` solo sabía reconocer ESE mensaje como "fallo del
  // modelo" — sumaba a `fallosModeloSeguidos` y terminaba alertando al
  // operador de que "el modelo no está contestando" cuando en realidad se
  // acabó el dinero. Ahora el redactor propaga el error de presupuesto TAL
  // CUAL y el runner lo reconoce con `esErrorDePresupuesto` para cortar el
  // lote sin culpar al modelo.
  // ═══════════════════════════════════════════════════════════════════════
  it('TC-B3: LlmBudgetExceededError corta el lote (break), no cuenta como fallo del modelo y no alerta', async () => {
    respuestas.set('agente_definicion', [{ data: [REDACTOR], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: null, error: null, count: 0 }]);
    respuestas.set('prospecto', [{
      data: Array.from({ length: 8 }, (_, i) => ({ id: `pr-${i}`, vendedor: null })), error: null,
    }]);
    redactar.mockRejectedValue(new LlmBudgetExceededError('run', 0.05, 0.03));
    const r = await correrRunner(undefined, TENANT);
    // Corta al primer tope de presupuesto: no sigue pagando llamadas contra
    // un techo ya agotado.
    expect(redactar).toHaveBeenCalledTimes(1);
    expect(r.agentes[0]).toMatchObject({ resultado: 'corrio', piezas: 0, saltados: 0 });
    expect(r.agentes[0].motivo).toMatch(/presupuesto/i);
    expect(alertarOperador).not.toHaveBeenCalled();
  });

  it('TC-B3: un DatoInvalido genuino (no de presupuesto) sigue contando como fallo de modelo', async () => {
    // Ya cubierto por AGB-11 arriba, pero se deja explícito aquí el
    // contraste: DatoInvalido con el mensaje de "no pudo escribir" NO es
    // presupuesto y SÍ debe seguir sumando a la racha.
    respuestas.set('agente_definicion', [{ data: [REDACTOR], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: null, error: null, count: 0 }]);
    respuestas.set('prospecto', [{
      data: Array.from({ length: 8 }, (_, i) => ({ id: `pr-${i}`, vendedor: null })), error: null,
    }]);
    redactar.mockRejectedValue(new DatoInvalido('El Redactor no pudo escribir en este momento — inténtalo de nuevo.'));
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0].motivo).toMatch(/3 fallos del modelo SEGUIDOS/);
    expect(alertarOperador).toHaveBeenCalledWith('redactor.fallos_seguidos', expect.objectContaining({ codigo: 'redactor_fallos_modelo_seguidos' }));
  });
});

describe('M30 — correrRunner(soloAgente) acota la vuelta a UN agente', () => {
  it('con dos habilitados y soloAgente="redactor", el otro ni se evalúa', async () => {
    respuestas.set('agente_definicion', [{ data: [REDACTOR, { id: 'cobranza', presupuesto_dia_usd: 1 }], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: null, error: null, count: 0 }]);
    respuestas.set('prospecto', [{ data: [{ id: 'p1', vendedor: null }], error: null }]);
    const r = await correrRunner('redactor', TENANT);
    expect(r.agentes.map((a) => a.agente)).toEqual(['redactor']);
  });

  it('soloAgente que no está habilitado → vuelta vacía, sin despachar nada', async () => {
    respuestas.set('agente_definicion', [{ data: [REDACTOR], error: null }]);
    const r = await correrRunner('cobranza', TENANT);
    expect(r).toEqual({ apagadoGlobal: false, agentes: [], saltadosPorReloj: [] });
    expect(redactar).not.toHaveBeenCalled();
  });
});

describe('el despacho de dirección (0216)', () => {
  // Los ids viven DOS veces —literal en el runner (para no cargar los
  // lectores de /admin y el correo en cada vuelta) y en `AGENTES_DIRECCION`
  // (`reportes.ts`)—. Si divergen, un reportero vivo se queda sin rama de
  // despacho y el runner lo reporta como «sin motor». Misma costura que la
  // del back office, crecimiento, ingeniería, dirección-bandeja y leads.
  it('la lista literal del runner y la del motor son la misma', () => {
    const fuente = readFileSync('src/lib/likida/agentes/runner.ts', 'utf8');
    const linea = /const DIRECCION: readonly string\[\] = \[([^\]]*)\]/.exec(fuente);
    expect(linea, 'la lista literal del runner debe seguir existiendo').not.toBeNull();
    const ids = (linea as RegExpExecArray)[1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
    expect(ids).toEqual([...AGENTES_DIRECCION]);
  });

  it('un agente de dirección habilitado se despacha a su motor, con su resultado tal cual', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'kpi_whatsapp', presupuesto_dia_usd: 0.1 }], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(correrDireccion).toHaveBeenCalledWith('kpi_whatsapp');
    expect(r.agentes).toEqual([{ agente: 'kpi_whatsapp', resultado: 'corrio', motivo: undefined, piezas: 1, costoUsd: 0 }]);
  });

  it('el motor que lanza NO tumba la vuelta: el agente queda saltado con su motivo', async () => {
    correrDireccion.mockRejectedValueOnce(new Error('el sello no se pudo leer'));
    respuestas.set('agente_definicion', [{ data: [{ id: 'kpi_whatsapp', presupuesto_dia_usd: 0.1 }], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0]).toMatchObject({ agente: 'kpi_whatsapp', resultado: 'saltado', motivo: 'el sello no se pudo leer' });
  });

  it('sin techo declarado, dirección tampoco corre — el candado 3 no distingue rubros', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'kpi_whatsapp', presupuesto_dia_usd: null }], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(correrDireccion).not.toHaveBeenCalled();
    expect(r.agentes[0].motivo).toContain('sin presupuesto_dia_usd');
  });
});

describe('el despacho de éxito del cliente (0218)', () => {
  // Los ids viven DOS veces —literal en el runner (para no cargar los
  // lectores de /admin ni el corpus de normas en cada vuelta) y en
  // `AGENTES_EXITO` (`exito.ts`)—. Si divergen, un agente vivo se queda sin
  // rama de despacho y el runner lo reporta como «sin motor». Misma costura
  // que la del back office, crecimiento, ingeniería, dirección-bandeja y leads.
  it('la lista literal del runner y la del motor son la misma', () => {
    const fuente = readFileSync('src/lib/likida/agentes/runner.ts', 'utf8');
    const linea = /const AGENTES_EXITO_CLIENTE: readonly string\[\] = \[([^\]]*)\]/.exec(fuente);
    expect(linea, 'la lista literal del runner debe seguir existiendo').not.toBeNull();
    const ids = (linea as RegExpExecArray)[1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
    expect(ids).toEqual([...AGENTES_EXITO]);
    for (const id of ids) expect(esAgenteExito(id)).toBe(true);
  });

  it('un determinista se despacha a su motor y su resultado sale tal cual', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'onboarding_cliente', presupuesto_dia_usd: 0.1 }], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    // El reloj de la vuelta va como quinto argumento (c7-1): `hoy` y `ahora`
    // quedan en su default y el motor recibe el instante límite. Sin esto, el
    // agente entraba por la puerta del reloj UNA vez y ya no volvía a mirarlo.
    expect(correrExito).toHaveBeenCalledWith('onboarding_cliente', 'cron', undefined, undefined, expect.any(Number));
    expect(r.agentes).toEqual([{ agente: 'onboarding_cliente', resultado: 'corrio', motivo: undefined, piezas: 1, costoUsd: 0 }]);
    // Los cinco deterministas NO pasan por el gasto del día: su gasto de
    // modelo es $0 y leerlo sería una consulta que no decide nada.
    expect(respuestas.get('agente_corrida')).toBeUndefined();
  });

  // ── EL LATIDO SE ENTERA DEL CORTE (c7-1) ─────────────────────────────────
  // Un motor que corta tiene que DECIRLO. Si `sinTurno` no subiera a
  // `saltadosPorReloj`, la ruta calcularía `cortoElReloj = false` y escribiría
  // un latido 'ok' sobre una pasada que dejó trabajo sin hacer. Eso es
  // literalmente el 28-ago-2026: 32 corridas, todas en 'ok', y ni un latido
  // que dijera que algo iba mal.
  it('un agente de éxito cortado por reloj sube a saltadosPorReloj — si no, el latido diría «ok»', async () => {
    correrExito.mockResolvedValueOnce({
      resultado: 'corrio', piezas: 0, costoUsd: 0, sinTurno: true,
      motivo: 'el reloj de la vuelta se agotó con 2 flota(s) sin mirar',
    });
    respuestas.set('agente_definicion', [{ data: [{ id: 'onboarding_cliente', presupuesto_dia_usd: 0.1 }], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0]).toMatchObject({ agente: 'onboarding_cliente', resultado: 'corrio' });
    expect(r.saltadosPorReloj).toEqual(['onboarding_cliente']);
  });

  it('sin corte, saltadosPorReloj queda vacío — no se inventa un corte que no hubo', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'onboarding_cliente', presupuesto_dia_usd: 0.1 }], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(r.saltadosPorReloj).toEqual([]);
  });

  it('el motor que lanza NO tumba la vuelta', async () => {
    correrExito.mockRejectedValueOnce(new Error('la bandeja no contesta'));
    respuestas.set('agente_definicion', [{ data: [{ id: 'onboarding_cliente', presupuesto_dia_usd: 0.1 }], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0]).toMatchObject({ agente: 'onboarding_cliente', resultado: 'saltado', motivo: 'la bandeja no contesta' });
  });

  it('sin kill switch declarado no corre — el candado 1 no distingue rubros', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'retencion', presupuesto_dia_usd: 0.1 }], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(correrExito).not.toHaveBeenCalled();
    expect(r.agentes[0].motivo).toMatch(/kill switch/);
  });

  it('atencion_faq SÍ pasa por el techo de gasto MEDIDO: es el único que gasta modelo', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'atencion_faq', presupuesto_dia_usd: 1 }], error: null }]);
    // AUDITORÍA 24, ARQ-2 (integración): el runner ahora consulta
    // `corridasSinCostoMedidoHoy` (count) ANTES de `gastoDelDiaUsd` (data) —
    // dos llamadas a `agente_corrida`, en ese orden. `count: 0` = nada sin
    // medir hoy, para que el techo compare contra el gasto real.
    respuestas.set('agente_corrida', [
      { count: 0, error: null },
      { data: [{ costo_usd: 0.02 }], error: null },
    ]);
    const r = await correrRunner(undefined, TENANT);
    // `atencion_faq` es el que MÁS necesita el reloj de los seis: gasta modelo
    // por ticket y `ordenarPorCosto` lo despacha al final de la vuelta.
    expect(correrExito).toHaveBeenCalledWith('atencion_faq', 'cron', undefined, undefined, expect.any(Number));
    expect(r.agentes[0].resultado).toBe('corrio');
  });

  it('con el techo de atencion_faq agotado, ni se le pregunta al modelo', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'atencion_faq', presupuesto_dia_usd: 1 }], error: null }]);
    respuestas.set('agente_corrida', [
      { count: 0, error: null },
      { data: [{ costo_usd: 5 }], error: null },
    ]);
    const r = await correrRunner(undefined, TENANT);
    expect(correrExito).not.toHaveBeenCalled();
    expect(r.agentes[0].motivo).toMatch(/techo diario alcanzado/);
  });

  it('gasto del día ilegible: fail closed y dicho', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'atencion_faq', presupuesto_dia_usd: 1 }], error: null }]);
    respuestas.set('agente_corrida', [{ data: null, error: { message: 'base caída' } }]);
    const r = await correrRunner(undefined, TENANT);
    expect(correrExito).not.toHaveBeenCalled();
    expect(r.agentes[0].motivo).toMatch(/fail closed/);
  });
});

describe('el presupuesto central evita un ledger duplicado', () => {
  it('no llama las RPC antiguas del runner', async () => {
    respuestas.set('agente_definicion', [{ data: [REDACTOR], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: null, error: null, count: 0 }]);
    respuestas.set('prospecto', [{ data: [{ id: 'p1', vendedor: null }], error: null }]);
    await correrRunner(undefined, TENANT);
    expect(llamadasRpc).toEqual([]);
  });
});

describe('el despacho del back office restante (0219)', () => {
  // Misma costura del latido que en éxito: talento es el único de los cuatro
  // que itera una lista de trabajo (un UPDATE de criba por candidato), así que
  // es el único que puede cortar — y cortar sin decirlo dejaría al latido
  // pintando de verde una pasada que dejó candidatos sin mirar.
  it('un agente de back office cortado por reloj sube a saltadosPorReloj', async () => {
    correrBackOffice.mockResolvedValueOnce({
      piezas: 0, sinTurno: true,
      motivo: 'el reloj de la vuelta cortó la criba con 2 candidato(s) sin mirar',
    });
    respuestas.set('agente_definicion', [{ data: [{ id: 'vigilante_calidad', presupuesto_dia_usd: 0.1 }], error: null }]);
    respuestas.set('agente_corrida', [{ data: [], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(r.saltadosPorReloj).toEqual(['vigilante_calidad']);
  });

  // Los ids viven DOS veces: literal en el runner (para no cargar el motor en
  // cada vuelta) y en `AGENTES_BACK_OFFICE`. Si divergen, un agente vivo se
  // queda sin rama de despacho y el runner lo reporta como «sin motor». Esta
  // prueba es la costura que impide que la duplicación se pudra.
  it('la lista literal del runner y la del motor son la misma', () => {
    const fuente = readFileSync('src/lib/likida/agentes/runner.ts', 'utf8');
    const linea = /const BACK_OFFICE_RESTANTE: readonly string\[\] = \[([^\]]*)\]/.exec(fuente);
    expect(linea, 'la lista literal del runner debe seguir existiendo').not.toBeNull();
    const ids = (linea as RegExpExecArray)[1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
    expect(ids).toEqual([...AGENTES_BACK_OFFICE]);
    for (const id of ids) expect(esAgenteBackOffice(id)).toBe(true);
  });

  it('un agente de back office habilitado se despacha a su motor con su resultado tal cual', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'vigilante_calidad', presupuesto_dia_usd: 0.1 }], error: null }]);
    // El techo se mide contra el gasto REAL del día: sin corridas, $0.
    respuestas.set('agente_corrida', [{ data: [], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(correrBackOffice).toHaveBeenCalledWith('vigilante_calidad', 'cron', undefined, expect.any(Number));
    expect(r.agentes).toEqual([{ agente: 'vigilante_calidad', resultado: 'corrio', piezas: 1, costoUsd: 0 }]);
  });

  it('techo diario alcanzado: no se despacha y el motivo trae las dos cifras', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'documentacion', presupuesto_dia_usd: 0.1 }], error: null }]);
    respuestas.set('agente_corrida', [{ data: [{ costo_usd: 0.5 }], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(correrBackOffice).not.toHaveBeenCalled();
    expect(r.agentes[0].motivo).toContain('techo diario alcanzado (0.50 de 0.1 USD)');
  });

  it('gasto del día ilegible: fail closed y dicho', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'legal_compliance', presupuesto_dia_usd: 0.1 }], error: null }]);
    respuestas.set('agente_corrida', [{ data: null, error: { message: 'base caída' } }]);
    const r = await correrRunner(undefined, TENANT);
    expect(correrBackOffice).not.toHaveBeenCalled();
    expect(r.agentes[0].motivo).toContain('fail closed');
  });

  it('el motor que lanza NO tumba la vuelta', async () => {
    correrBackOffice.mockRejectedValueOnce(new Error('la bitácora no se pudo leer'));
    respuestas.set('agente_definicion', [{ data: [{ id: 'talento', presupuesto_dia_usd: 0.1 }], error: null }]);
    respuestas.set('agente_corrida', [{ data: [], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0]).toMatchObject({ agente: 'talento', resultado: 'saltado', motivo: 'la bitácora no se pudo leer' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EL PRESUPUESTO DE TIEMPO (alerta de prod 25-ago-2026: "Sin latido: runner
// hace 286 min"). Con 34 agentes en serie la pasada de las 18:00 murió en el
// `maxDuration` con ~15 corridos y sin escribir latido. Lo que se fija aquí:
//  · el reloj se pregunta ANTES de despachar y corta LIMPIO;
//  · los que no alcanzaron turno se DICEN con nombre, no desaparecen;
//  · el orden sacrifica lo caro: los deterministas van primero.
// ═══════════════════════════════════════════════════════════════════════════
describe('el reloj de la vuelta', () => {
  /** Un `Date.now` de mentiras que solo avanza cuando la prueba lo dice. */
  function relojFalso(inicio: number) {
    let ahora = inicio;
    vi.spyOn(Date, 'now').mockImplementation(() => ahora);
    return { avanzar: (ms: number) => { ahora += ms; }, leer: () => ahora };
  }

  afterEach(() => { vi.restoreAllMocks(); });

  it('corta ANTES del tercer agente y los saltados salen con nombre y motivo', async () => {
    const reloj = relojFalso(1_000_000);
    // Cada motor se come 40 s del reloj; la vuelta tiene 60 s.
    correrExito.mockImplementation(async () => { reloj.avanzar(40_000); return { resultado: 'corrio' as const, piezas: 1, costoUsd: 0 }; });
    respuestas.set('agente_definicion', [{ data: [
      { id: 'onboarding_cliente', presupuesto_dia_usd: 0.1 },
      { id: 'exito_cliente', presupuesto_dia_usd: 0.1 },
      { id: 'soporte', presupuesto_dia_usd: 0.1 },
    ], error: null }]);

    const r = await correrRunner(undefined, TENANT, { venceEn: reloj.leer() + 60_000 });

    // Dos alcanzaron turno; el tercero no se despachó — ni se le preguntó al motor.
    expect(correrExito.mock.calls.map((c) => c[0])).toEqual(['onboarding_cliente', 'exito_cliente']);
    expect(r.saltadosPorReloj).toEqual(['soporte']);
    expect(r.agentes.map((a) => a.agente)).toEqual(['onboarding_cliente', 'exito_cliente', 'soporte']);
    expect(r.agentes[2]).toMatchObject({ resultado: 'saltado' });
    expect(r.agentes[2].motivo).toMatch(/saltado por reloj/);
  });

  it('con el reloj ya vencido no se despacha a NADIE, y los 34 se dicen', async () => {
    const reloj = relojFalso(2_000_000);
    respuestas.set('agente_definicion', [{ data: [
      { id: 'onboarding_cliente', presupuesto_dia_usd: 0.1 },
      { id: 'exito_cliente', presupuesto_dia_usd: 0.1 },
    ], error: null }]);
    const r = await correrRunner(undefined, TENANT, { venceEn: reloj.leer() - 1 });
    expect(correrExito).not.toHaveBeenCalled();
    expect(r.saltadosPorReloj).toEqual(['onboarding_cliente', 'exito_cliente']);
  });

  it('una vuelta que cabe entera no reporta ningún saltado por reloj', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'onboarding_cliente', presupuesto_dia_usd: 0.1 }], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(r.saltadosPorReloj).toEqual([]);
    expect(r.agentes[0].resultado).toBe('corrio');
  });

  it('sin `venceEn` del llamador, el default deja margen para el latido', () => {
    // 300 s de `maxDuration` del cron menos los 30 s que la ruta necesita para
    // leer la racha, escribir el latido y alertar (c7-31).
    expect(MARGEN_RELOJ_MS).toBe(30_000);
    expect(PLAZO_RUNNER_MS).toBe(270_000);
  });

  // ── c7-31: EL MARGEN TIENE QUE CUBRIR SU PROPIA COLA ─────────────────────
  // Mismo mecanismo que `MARGEN_CIERRE_MS` vs `COSTO_CIERRE_MS` en
  // `presupuesto.ts`. Eran 20 s contra 25.2 s de cola real: 5.2 s de DEUDA, y
  // el latido —lo último de la fila— era lo primero que se perdía. Meter un
  // paso más a esa cola sin ampliar el margen ahora es una prueba en rojo.
  it('el margen cubre la cola del latido con holgura, no la debe', () => {
    expect(COSTO_LATIDO_MS).toBe(25_200);
    expect(MARGEN_RELOJ_MS).toBeGreaterThan(COSTO_LATIDO_MS);
    // Y la tabla enumera los CUATRO pasos en serie, no un número inventado.
    expect(PASOS_LATIDO).toHaveLength(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EL RELOJ ADENTRO DE LOS MOTORES (auditoría ciclo 7, c7-1).
//
// El reloj de #141 se preguntaba ENTRE agentes y nunca DENTRO de uno. Con 32,996
// prospectos en `nuevo`, `loteRedactor` traía siempre sus 20 candidatos y los
// recorría a ~25 s medidos cada uno: 500 s dentro de un `maxDuration` de 300.
// Vercel mataba la función DENTRO del bucle y la ruta no alcanzaba a latir —
// los silencios del 25-ago-2026 y del 28-ago-2026.
// ═══════════════════════════════════════════════════════════════════════════
describe('el reloj adentro del lote', () => {
  function relojFalso(inicio: number) {
    let ahora = inicio;
    vi.spyOn(Date, 'now').mockImplementation(() => ahora);
    return { avanzar: (ms: number) => { ahora += ms; }, leer: () => ahora };
  }
  afterEach(() => { vi.restoreAllMocks(); });

  function conRedactorHabilitado(candidatos: number) {
    respuestas.set('agente_definicion', [{ data: [REDACTOR], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: null, error: null, count: 0 }]);
    respuestas.set('prospecto', [{
      data: Array.from({ length: candidatos }, (_, i) => ({ id: `pr-${i}`, vendedor: null })), error: null,
    }]);
  }

  it('un candidato que se pasa del presupuesto CORTA el lote — no se despacha el siguiente', async () => {
    const reloj = relojFalso(1_000_000);
    // Cada llamada al modelo cuesta 25 s, como las tres medidas el 28-ago.
    redactar.mockImplementation(async () => {
      reloj.avanzar(25_000);
      return { piezaId: 'p', asunto: 'x', aviso: null, costoUsd: 0.001 };
    });
    conRedactorHabilitado(10);

    // 60 s de vuelta: caben dos candidatos, no diez.
    const r = await correrRunner(undefined, TENANT, { venceEn: reloj.leer() + 60_000 });

    expect(redactar).toHaveBeenCalledTimes(3);   // el tercero arranca en el s 50
    expect(r.agentes[0]).toMatchObject({ agente: 'redactor', resultado: 'corrio', piezas: 3 });
    // Y LO DICE: los que no alcanzaron turno están contados en el motivo.
    expect(r.agentes[0].motivo).toMatch(/cortó el lote con 7 candidato\(s\) sin turno/);
  });

  it('el lote cortado sube a `saltadosPorReloj` — si no, el latido diría `ok` sobre una pasada agonizante', async () => {
    const reloj = relojFalso(1_000_000);
    redactar.mockImplementation(async () => {
      reloj.avanzar(25_000);
      return { piezaId: 'p', asunto: 'x', aviso: null, costoUsd: 0.001 };
    });
    conRedactorHabilitado(10);
    const r = await correrRunner(undefined, TENANT, { venceEn: reloj.leer() + 30_000 });
    // El Redactor es el ÚNICO agente de la vuelta: con el bug, `saltadosPorReloj`
    // salía vacía y la ruta escribía `'ok'`.
    expect(r.saltadosPorReloj).toEqual(['redactor']);
  });

  it('un FALLO del modelo también consume reloj: el lote corta aunque no fabrique nada', async () => {
    const reloj = relojFalso(1_000_000);
    // El modo de falla real del 28-ago: la salida del modelo no se pudo leer.
    // Con el bug esto era `saltados += 1` y seguir, veinte veces, 500 s.
    redactar.mockImplementation(async () => {
      reloj.avanzar(25_000);
      throw new Error('El Redactor devolvió una salida sin variante A legible — no se encoló nada. Reintenta.');
    });
    conRedactorHabilitado(10);
    const r = await correrRunner(undefined, TENANT, { venceEn: reloj.leer() + 60_000 });
    expect(redactar).toHaveBeenCalledTimes(3);
    expect(r.agentes[0]).toMatchObject({ resultado: 'corrio', piezas: 0, saltados: 3 });
    expect(r.saltadosPorReloj).toEqual(['redactor']);
  });

  it('una vuelta que cabe entera NO reporta corte y el lote no lleva motivo', async () => {
    conRedactorHabilitado(6);
    const r = await correrRunner(undefined, TENANT);
    expect(r.saltadosPorReloj).toEqual([]);
    expect(r.agentes[0].motivo).toBeUndefined();
    expect(r.agentes[0]).toMatchObject({ resultado: 'corrio', piezas: 5 });
  });

  // ── LA SOBRE-LECTURA ×4 ──────────────────────────────────────────────────
  it('el overfetch es ×2, no ×4: 10 candidatos para 5 piezas', () => {
    const fuente = readFileSync('src/lib/likida/agentes/runner.ts', 'utf8');
    expect(fuente).toMatch(/\.limit\(tope \* 2\), 'runner\.candidatos'/);
    expect(fuente).not.toMatch(/\.limit\(tope \* 4\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EL TECHO ESTRUCTURAL — `conRelojDuro` (c7-1). Los relojes de arriba son
// COOPERATIVOS: funcionan porque alguien se acordó de preguntar. Esto funciona
// aunque nadie se acuerde, que es lo que hace falta para que el motor número
// once no pueda repetir el 25 y el 28 de agosto.
// ═══════════════════════════════════════════════════════════════════════════
describe('el reloj DURO de la vuelta', () => {
  it('con la vuelta colgada, devuelve el parte de lo que alcanzó a pasar', async () => {
    const avance = nuevoAvanceRunner();
    avance.agentes.push({ agente: 'kpi_whatsapp', resultado: 'corrio', piezas: 1 });
    avance.enVuelo = 'redactor';
    avance.pendientes = ['enriquecedor', 'sdr'];

    const r = await conRelojDuro(
      new Promise<ResultadoRunner>(() => {}),   // el motor jamás vuelve
      Date.now() + 20,
      () => cerrarPorRelojDuro(avance),
    );

    expect(r.cortadaPorRelojDuro).toBe(true);
    expect(r.saltadosPorReloj).toEqual(['redactor', 'enriquecedor', 'sdr']);
    expect(r.agentes.find((a) => a.agente === 'redactor')?.motivo).toMatch(/CORTADO EN VUELO/);
    expect(r.agentes.find((a) => a.agente === 'kpi_whatsapp')?.resultado).toBe('corrio');
  });

  it('con la vuelta puntual, el reloj duro NO se mete: devuelve el resultado tal cual', async () => {
    const propio: ResultadoRunner = { apagadoGlobal: false, agentes: [{ agente: 'talento', resultado: 'corrio' }], saltadosPorReloj: [] };
    const r = await conRelojDuro(
      Promise.resolve(propio),
      Date.now() + 60_000,
      () => { throw new Error('no debió cortar'); },
    );
    expect(r).toBe(propio);
    expect(r.cortadaPorRelojDuro).toBeUndefined();
  });

  it('un `venceEn` ya vencido corta de inmediato en vez de esperar', async () => {
    const avance = nuevoAvanceRunner();
    avance.pendientes = ['redactor'];
    const r = await conRelojDuro(new Promise<ResultadoRunner>(() => {}), Date.now() - 5_000, () => cerrarPorRelojDuro(avance));
    expect(r.saltadosPorReloj).toEqual(['redactor']);
  });

  it('no nombra dos veces al mismo agente: `enVuelo` que ya se reportó no se duplica', () => {
    const avance = nuevoAvanceRunner();
    avance.agentes.push({ agente: 'redactor', resultado: 'saltado', motivo: 'apagado desde Observabilidad/⌘K' });
    avance.enVuelo = 'redactor';          // el corte cayó entre dos iteraciones
    avance.pendientes = ['sdr'];
    const r = cerrarPorRelojDuro(avance);
    expect(r.agentes.filter((a) => a.agente === 'redactor')).toHaveLength(1);
    expect(r.saltadosPorReloj).toEqual(['sdr']);
  });

  it('la vuelta llena el parte en vivo conforme despacha — sin él el corte sería mudo', async () => {
    const avance = nuevoAvanceRunner();
    respuestas.set('agente_definicion', [{ data: [
      { id: 'onboarding_cliente', presupuesto_dia_usd: 0.1 },
      { id: 'exito_cliente', presupuesto_dia_usd: 0.1 },
    ], error: null }]);
    // El primer motor mira el parte JUSTO cuando está en vuelo: es el instante
    // exacto en el que el reloj duro leería, si cortara ahí.
    const visto: Array<{ enVuelo: string | null; pendientes: string[] }> = [];
    correrExito.mockImplementation(async () => {
      visto.push({ enVuelo: avance.enVuelo, pendientes: [...avance.pendientes] });
      return { resultado: 'corrio' as const, piezas: 1, costoUsd: 0 };
    });

    await correrRunner(undefined, TENANT, { avance });

    expect(visto[0]).toEqual({ enVuelo: 'onboarding_cliente', pendientes: ['exito_cliente'] });
    expect(visto[1]).toEqual({ enVuelo: 'exito_cliente', pendientes: [] });
    // Terminada la vuelta, no queda nadie en vuelo: un corte tardío no
    // acusaría de «cortado en vuelo» a un agente que sí terminó.
    expect(avance.enVuelo).toBeNull();
    expect(avance.agentes).toHaveLength(2);
  });
});

describe('el orden de despacho — lo barato primero, lo caro al final', () => {
  it('los que llaman al modelo se van al final; dentro del grupo, orden estable', () => {
    const entrada = [
      { id: 'atencion_faq' }, { id: 'documentacion' }, { id: 'enriquecedor' },
      { id: 'kpi_whatsapp' }, { id: 'redactor' }, { id: 'sdr' }, { id: 'talento' },
    ];
    expect(ordenarPorCosto(entrada).map((a) => a.id)).toEqual([
      'documentacion', 'kpi_whatsapp', 'talento',
      'atencion_faq', 'enriquecedor', 'redactor', 'sdr',
    ]);
  });

  it('sabe cuáles gastan modelo y cuáles no', () => {
    for (const caro of ['redactor', 'enriquecedor', 'sdr', 'atencion_faq']) expect(llamaAlModelo(caro)).toBe(true);
    for (const barato of ['kpi_whatsapp', 'talento', 'soporte', 'enviador', 'cobranza_saas']) expect(llamaAlModelo(barato)).toBe(false);
  });

  it('con el alfabeto en contra, el determinista corre ANTES que el que gasta modelo', async () => {
    // Así llega la lista de la base: `ORDER BY id`, o sea `atencion_faq` primero.
    respuestas.set('agente_definicion', [{ data: [
      { id: 'atencion_faq', presupuesto_dia_usd: 1 },
      { id: 'onboarding_cliente', presupuesto_dia_usd: 0.1 },
    ], error: null }]);
    // Solo `atencion_faq` gasta modelo y consulta `agente_corrida`
    // (`onboarding_cliente` es determinista, no la toca): dos llamadas —
    // `corridasSinCostoMedidoHoy` (count) y `gastoDelDiaUsd` (data) —.
    respuestas.set('agente_corrida', [
      { count: 0, error: null },
      { data: [], error: null },
    ]);
    const r = await correrRunner(undefined, TENANT);
    expect(correrExito.mock.calls.map((c) => c[0])).toEqual(['onboarding_cliente', 'atencion_faq']);
    expect(r.agentes.map((a) => a.agente)).toEqual(['onboarding_cliente', 'atencion_faq']);
  });

  it('el corte de reloj sacrifica lo CARO: el parte determinista sale, el del modelo no', async () => {
    let ahora = 3_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => ahora);
    correrExito.mockImplementation(async () => { ahora += 40_000; return { resultado: 'corrio' as const, piezas: 1, costoUsd: 0 }; });
    respuestas.set('agente_definicion', [{ data: [
      { id: 'atencion_faq', presupuesto_dia_usd: 1 },
      { id: 'onboarding_cliente', presupuesto_dia_usd: 0.1 },
    ], error: null }]);
    respuestas.set('agente_corrida', [{ data: [], error: null }]);

    const r = await correrRunner(undefined, TENANT, { venceEn: ahora + 30_000 });

    expect(correrExito.mock.calls.map((c) => c[0])).toEqual(['onboarding_cliente']);
    expect(r.saltadosPorReloj).toEqual(['atencion_faq']);
    vi.restoreAllMocks();
  });
});

describe('el despacho de crecimiento (0230)', () => {
  // La misma costura que la del back office: los ids viven DOS veces —literal
  // en el runner, para no cargar la calculadora ni el índice de normas en cada
  // vuelta, y en `AGENTES_CRECIMIENTO`—. Si divergen, un agente vivo se queda
  // sin rama y el runner lo reporta como «sin motor despachable».
  it('la lista literal del runner y la del motor son la misma', () => {
    const fuente = readFileSync('src/lib/likida/agentes/runner.ts', 'utf8');
    const linea = /const CRECIMIENTO: readonly string\[\] = \[([^\]]*)\]/.exec(fuente);
    expect(linea, 'la lista literal del runner debe seguir existiendo').not.toBeNull();
    const ids = (linea as RegExpExecArray)[1]
      .split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
    expect(ids).toEqual([...AGENTES_CRECIMIENTO]);
    for (const id of ids) expect(esAgenteCrecimiento(id)).toBe(true);
  });

  it('un determinista se despacha a su motor y su resultado sale TAL CUAL', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'lead_magnet', presupuesto_dia_usd: 0.1 }], error: null }]);
    correrCrecimiento.mockResolvedValue({ resultado: 'corrio', piezas: 1, costoUsd: 0 });
    const r = await correrRunner(undefined, TENANT);
    expect(correrCrecimiento).toHaveBeenCalledWith('lead_magnet', 'cron');
    expect(r.agentes).toEqual([{ agente: 'lead_magnet', resultado: 'corrio', motivo: undefined, piezas: 1, costoUsd: 0 }]);
  });

  it('un determinista NO consulta el gasto del día: no gasta modelo y no hay techo que medir', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'promos_diarias', presupuesto_dia_usd: 0.1 }], error: null }]);
    // Si el runner pidiera el gasto, esta cola contestaría con un fallo y el
    // agente saltaría fail-closed. Que corra prueba que ni la pidió.
    respuestas.set('agente_corrida', [{ data: null, error: { message: 'nadie debería preguntar' } }]);
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0]).toMatchObject({ agente: 'promos_diarias', resultado: 'corrio' });
  });

  it('contenido_fiscal SÍ mide el gasto: techo alcanzado, no se despacha, y el motivo trae las dos cifras', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'contenido_fiscal', presupuesto_dia_usd: 1 }], error: null }]);
    // DOS preguntas, en este orden: ¿hay algo que NO se pudo medir? y ¿cuánto
    // suma lo medido? (c7-11 partió la segunda de la primera).
    respuestas.set('agente_corrida', [
      { count: 0, error: null },
      { data: [{ costo_usd: 1.2 }], error: null },
    ]);
    const r = await correrRunner(undefined, TENANT);
    expect(correrCrecimiento).not.toHaveBeenCalled();
    expect(r.agentes[0].motivo).toContain('techo diario alcanzado (1.20 de 1 USD)');
  });

  it('c7-11 · una corrida de hoy SIN costo medido apaga el despacho: un costo desconocido no es cero', async () => {
    // LA PRUEBA QUE FALTABA. `gastoDelDiaUsd` filtra `.not(costo_usd, is,
    // null)` —no puede sumar lo que no sabe—, así que una corrida sin medir
    // era INVISIBLE para el techo, no incierta: con el proveedor omitiendo
    // `usage` una tarde, el agente redactaba, gastaba de verdad, y el techo
    // comparaba $0.00 contra $1.00 y nunca cortaba.
    respuestas.set('agente_definicion', [{ data: [{ id: 'contenido_fiscal', presupuesto_dia_usd: 1 }], error: null }]);
    respuestas.set('agente_corrida', [
      { count: 2, error: null },
      // Lo medido está muy por debajo del techo, y aun así NO se despacha:
      // el gasto real del día es desconocido.
      { data: [{ costo_usd: 0.01 }], error: null },
    ]);
    const r = await correrRunner(undefined, TENANT);
    expect(correrCrecimiento).not.toHaveBeenCalled();
    expect(r.agentes[0]).toMatchObject({ agente: 'contenido_fiscal', resultado: 'saltado' });
    expect(r.agentes[0].motivo).toContain('costo NO MEDIDO');
    expect(r.agentes[0].motivo).toContain('un costo desconocido no es cero');
  });

  it('c7-11 · sin corridas sin medir, el techo se compara y el agente corre', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'contenido_fiscal', presupuesto_dia_usd: 1 }], error: null }]);
    respuestas.set('agente_corrida', [
      { count: 0, error: null },
      { data: [{ costo_usd: 0.01 }], error: null },
    ]);
    correrCrecimiento.mockResolvedValue({ resultado: 'corrio', piezas: 1, costoUsd: 0.02 });
    const r = await correrRunner(undefined, TENANT);
    expect(correrCrecimiento).toHaveBeenCalledWith('contenido_fiscal', 'cron');
    expect(r.agentes[0]).toMatchObject({ resultado: 'corrio', costoUsd: 0.02 });
  });

  it('c7-11 · el costo NULL del motor viaja NULL al parte del runner, no como 0', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'contenido_fiscal', presupuesto_dia_usd: 1 }], error: null }]);
    respuestas.set('agente_corrida', [
      { count: 0, error: null },
      { data: [], error: null },
    ]);
    correrCrecimiento.mockResolvedValue({ resultado: 'corrio', piezas: 1, costoUsd: null });
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0].costoUsd).toBeNull();
  });

  it('contenido_fiscal con el conteo de lo NO medido ILEGIBLE: fail closed y dicho', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'contenido_fiscal', presupuesto_dia_usd: 1 }], error: null }]);
    respuestas.set('agente_corrida', [{ data: null, error: { message: 'base caída' } }]);
    const r = await correrRunner(undefined, TENANT);
    expect(correrCrecimiento).not.toHaveBeenCalled();
    expect(r.agentes[0].motivo).toMatch(/fail closed/);
  });

  it('contenido_fiscal con el gasto ILEGIBLE: fail closed y dicho', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'contenido_fiscal', presupuesto_dia_usd: 1 }], error: null }]);
    respuestas.set('agente_corrida', [
      { count: 0, error: null },
      { data: null, error: { message: 'base caída' } },
    ]);
    const r = await correrRunner(undefined, TENANT);
    expect(correrCrecimiento).not.toHaveBeenCalled();
    expect(r.agentes[0].motivo).toMatch(/fail closed/);
  });

  it('un motor que truena no tumba la vuelta: se dice y los demás siguen', async () => {
    respuestas.set('agente_definicion', [{ data: [
      { id: 'lead_magnet', presupuesto_dia_usd: 0.1 },
      { id: 'promos_diarias', presupuesto_dia_usd: 0.1 },
    ], error: null }]);
    correrCrecimiento.mockRejectedValueOnce(new Error('sitio_evento ilegible'));
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0]).toMatchObject({ agente: 'lead_magnet', resultado: 'saltado' });
    expect(r.agentes[0].motivo).toContain('sitio_evento ilegible');
    expect(r.agentes[1]).toMatchObject({ agente: 'promos_diarias', resultado: 'corrio' });
  });

  it('contenido_fiscal es CARO: se despacha al final, detrás de los deterministas', () => {
    expect(llamaAlModelo('contenido_fiscal')).toBe(true);
    for (const id of AGENTES_CRECIMIENTO.filter((x) => x !== 'contenido_fiscal')) {
      expect(llamaAlModelo(id), id).toBe(false);
    }
    const orden = ordenarPorCosto([
      { id: 'contenido_fiscal' }, { id: 'lead_magnet' }, { id: 'alianzas' },
    ]).map((a) => a.id);
    expect(orden).toEqual(['lead_magnet', 'alianzas', 'contenido_fiscal']);
  });

  it('sin kill switch declarado no corre, aunque tenga motor', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'visuales', presupuesto_dia_usd: 0.1 }], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(correrCrecimiento).not.toHaveBeenCalled();
    expect(r.agentes[0].motivo).toMatch(/kill switch/);
  });

  it('sin techo declarado no corre: el candado 3 no distingue departamentos', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'lead_magnet', presupuesto_dia_usd: null }], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(correrCrecimiento).not.toHaveBeenCalled();
    expect(r.agentes[0].motivo).toMatch(/sin presupuesto_dia_usd declarado/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AGENTES TEATRO (auditoría 24, 1-sep-2026, migración 0301) — nueve agentes
// del catálogo prometen un motor que el código no tiene todavía. Siguen
// `vivo` + `runner_habilitado` en la base, pero `experimental = true` los
// saca del despacho automático — candado 2, entre el kill switch y el techo.
// ═══════════════════════════════════════════════════════════════════════════
describe('candado 2 — experimental (agentes teatro, 0301)', () => {
  it('experimental=true salta el agente ANTES de tocar su motor, con el motivo dicho', async () => {
    // `promos_diarias` sí tiene kill switch declarado en este arnés — para
    // aislar el candado 2 del candado 1, que ya tiene su propia prueba.
    respuestas.set('agente_definicion', [{ data: [{ id: 'promos_diarias', presupuesto_dia_usd: 0.1, experimental: true }], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(correrCrecimiento).not.toHaveBeenCalled();
    expect(r.agentes[0]).toMatchObject({ agente: 'promos_diarias', resultado: 'saltado' });
    expect(r.agentes[0].motivo).toMatch(/experimental/);
  });

  it('experimental=false (o ausente) NO lo afecta — corre como cualquier agente real', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'promos_diarias', presupuesto_dia_usd: 0.1, experimental: false }], error: null }]);
    respuestas.set('agente_corrida', [{ data: null, error: { message: 'nadie debería preguntar' } }]);
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0]).toMatchObject({ agente: 'promos_diarias', resultado: 'corrio' });
  });

  it('el candado 1 (kill switch) sigue mandando ANTES que el 2: sin interruptor, ni siquiera se mira si es experimental', async () => {
    // `cazador` (LEADS, también experimental) no tiene interruptor declarado
    // en este arnés a propósito — el motivo tiene que seguir siendo el del
    // candado 1, no el del 2, aunque el agente sea de los nueve.
    respuestas.set('agente_definicion', [{ data: [{ id: 'cazador', presupuesto_dia_usd: 0.1, experimental: true }], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0].motivo).toMatch(/kill switch/);
  });
});

describe('el despacho de ingeniería (0234)', () => {
  // La misma costura que la del back office y crecimiento: los ids viven DOS
  // veces —literal en el runner, para no cargar los lectores del catálogo de
  // PostgreSQL en cada vuelta, y en `AGENTES_INGENIERIA`—. Si divergen, un
  // agente vivo se queda sin rama y el runner lo reporta como «sin motor».
  it('la lista literal del runner y la del motor son la misma', () => {
    const fuente = readFileSync('src/lib/likida/agentes/runner.ts', 'utf8');
    const linea = /const INGENIERIA: readonly string\[\] = \[([^\]]*)\]/.exec(fuente);
    expect(linea, 'la lista literal del runner debe seguir existiendo').not.toBeNull();
    const ids = (linea as RegExpExecArray)[1]
      .split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
    expect(ids).toEqual([...AGENTES_INGENIERIA]);
    for (const id of ids) expect(esAgenteIngenieria(id)).toBe(true);
  });

  it('se despacha a su motor y su resultado sale TAL CUAL', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'migraciones', presupuesto_dia_usd: 0.1 }], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(correrIngenieria).toHaveBeenCalledWith('migraciones', 'cron');
    expect(r.agentes).toEqual([{ agente: 'migraciones', resultado: 'corrio', motivo: undefined, piezas: 1, costoUsd: 0 }]);
  });

  it('NINGUNO consulta el gasto del día: los ocho son deterministas y no hay techo que medir', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'seguridad', presupuesto_dia_usd: 0.1 }], error: null }]);
    // Si el runner pidiera el gasto, esta cola contestaría con un fallo y el
    // agente saltaría fail-closed. Que corra prueba que ni la pidió.
    respuestas.set('agente_corrida', [{ data: null, error: { message: 'nadie debería preguntar' } }]);
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0]).toMatchObject({ agente: 'seguridad', resultado: 'corrio' });
  });

  it('ninguno de los ocho es CARO: van con los baratos, delante de los que gastan modelo', () => {
    for (const id of AGENTES_INGENIERIA) expect(llamaAlModelo(id), id).toBe(false);
  });

  it('un motor que truena no tumba la vuelta: se dice y los demás siguen', async () => {
    respuestas.set('agente_definicion', [{ data: [
      { id: 'migraciones', presupuesto_dia_usd: 0.1 },
      { id: 'seguridad', presupuesto_dia_usd: 0.1 },
    ], error: null }]);
    correrIngenieria.mockRejectedValueOnce(new Error('postura_seguridad() no contestó'));
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0]).toMatchObject({ agente: 'migraciones', resultado: 'saltado' });
    expect(r.agentes[0].motivo).toContain('postura_seguridad');
    expect(r.agentes[1]).toMatchObject({ agente: 'seguridad', resultado: 'corrio' });
  });

  it('sin kill switch declarado no corre, aunque tenga motor', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'releases', presupuesto_dia_usd: 0.1 }], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(correrIngenieria).not.toHaveBeenCalled();
    expect(r.agentes[0].motivo).toMatch(/kill switch/);
  });
});

describe('AGENTES_DESPACHABLES — lo que el auditor de código lee del artefacto', () => {
  // NO es decoración: `auditor_codigo` (0234) la lee por import dinámico para
  // comparar el bundle DESPLEGADO contra lo que la base declara vivo. Si esta
  // lista mintiera, el agente acusaría (o absolvería) en falso.
  it('trae los ocho de ingeniería y los diez de crecimiento, sin repetidos', () => {
    for (const id of AGENTES_INGENIERIA) expect(AGENTES_DESPACHABLES, id).toContain(id);
    for (const id of AGENTES_CRECIMIENTO) expect(AGENTES_DESPACHABLES, id).toContain(id);
    for (const id of AGENTES_BACK_OFFICE) expect(AGENTES_DESPACHABLES, id).toContain(id);
    expect(new Set(AGENTES_DESPACHABLES).size).toBe(AGENTES_DESPACHABLES.length);
  });

  it('todo id de la lista tiene rama de verdad: ninguno cae en «sin motor despachable»', async () => {
    // Se despacha la lista COMPLETA en una sola vuelta contra un catálogo que
    // los declara todos vivos. La prueba no es que corran (los motores están
    // mockeados o fallan por falta de datos) sino que NINGUNO caiga en la rama
    // del final, que es exactamente lo que el auditor mide.
    respuestas.set('agente_definicion', [{ data: AGENTES_DESPACHABLES.map((id) => ({ id, presupuesto_dia_usd: 1 })), error: null }]);
    const r = await correrRunner(undefined, TENANT);
    const sinMotor = r.agentes.filter((a) => (a.motivo ?? '').includes('sin motor despachable')).map((a) => a.agente);
    expect(sinMotor).toEqual([]);
  });

  it('un id que NO está en la lista sí cae en «sin motor despachable» — la señal que el auditor busca', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'fantasma_0234', presupuesto_dia_usd: 1 }], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(AGENTES_DESPACHABLES).not.toContain('fantasma_0234');
    // Sin palanca ni siquiera llega a la rama del final: el candado 1 va antes.
    expect(r.agentes[0].motivo).toMatch(/kill switch/);
  });
});


describe('el despacho de dirección-bandeja (0235)', () => {
  // La misma costura que la del back office y la de crecimiento: los ids viven
  // DOS veces —literal en el runner, para no cargar el juez de latidos en cada
  // vuelta, y en `AGENTES_DIRECCION_BANDEJA`—. Si divergen, un agente vivo se
  // queda sin rama y el runner lo reporta como «sin motor despachable».
  it('la lista literal del runner y la del motor son la misma', () => {
    const fuente = readFileSync('src/lib/likida/agentes/runner.ts', 'utf8');
    const linea = /const DIRECCION_BANDEJA: readonly string\[\] = \[([^\]]*)\]/.exec(fuente);
    expect(linea, 'la lista literal del runner debe seguir existiendo').not.toBeNull();
    const ids = (linea as RegExpExecArray)[1]
      .split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
    expect(ids).toEqual([...AGENTES_DIRECCION_BANDEJA]);
    for (const id of ids) expect(esAgenteDireccionBandeja(id)).toBe(true);
  });

  it('NO se lleva a los cuatro de la 0216: aquéllos siguen yendo por su motor de correo', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'kpi_whatsapp', presupuesto_dia_usd: 0.1 }], error: null }]);
    await correrRunner(undefined, TENANT);
    expect(correrDireccion).toHaveBeenCalledWith('kpi_whatsapp');
    expect(correrDireccionBandeja).not.toHaveBeenCalled();
  });

  it('un agente de la ola se despacha a su motor y su resultado sale TAL CUAL', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'automejora', presupuesto_dia_usd: 0.1 }], error: null }]);
    correrDireccionBandeja.mockResolvedValue({ resultado: 'corrio', piezas: 1, costoUsd: 0 });
    const r = await correrRunner(undefined, TENANT);
    expect(correrDireccionBandeja).toHaveBeenCalledWith('automejora', 'cron', undefined, expect.any(Number));
    expect(r.agentes).toEqual([{ agente: 'automejora', resultado: 'corrio', motivo: undefined, piezas: 1, costoUsd: 0 }]);
  });

  it('NO consulta el gasto del día: los tres son deterministas y no hay techo que medir', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'fundraising', presupuesto_dia_usd: 0.1 }], error: null }]);
    // Si el runner pidiera el gasto, esta cola contestaría con un fallo y el
    // agente saltaría fail-closed. Que corra prueba que ni la pidió.
    respuestas.set('agente_corrida', [{ data: null, error: { message: 'nadie debería preguntar' } }]);
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0]).toMatchObject({ agente: 'fundraising', resultado: 'corrio' });
  });

  it('un motor que truena no tumba la vuelta: se dice y los demás siguen', async () => {
    respuestas.set('agente_definicion', [{ data: [
      { id: 'automejora', presupuesto_dia_usd: 0.1 },
      { id: 'fundraising', presupuesto_dia_usd: 0.1 },
    ], error: null }]);
    correrDireccionBandeja.mockRejectedValueOnce(new Error('agente_corrida ilegible'));
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0]).toMatchObject({ agente: 'automejora', resultado: 'saltado' });
    expect(r.agentes[0].motivo).toContain('agente_corrida ilegible');
    expect(r.agentes[1]).toMatchObject({ agente: 'fundraising', resultado: 'corrio' });
  });

  it('el de incidentes que se queda sin reloj sube a saltadosPorReloj', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'especialistas_incidente', presupuesto_dia_usd: 0.1 }], error: null }]);
    correrDireccionBandeja.mockResolvedValue({ resultado: 'corrio', piezas: 0, costoUsd: 0, sinTurno: true, motivo: 'quedaron incidentes sin revisar' });
    const r = await correrRunner(undefined, TENANT);
    expect(r.saltadosPorReloj).toContain('especialistas_incidente');
  });

  it('los tres son BARATOS: se despachan antes que los que gastan modelo', () => {
    for (const id of AGENTES_DIRECCION_BANDEJA) expect(llamaAlModelo(id), id).toBe(false);
    const orden = ordenarPorCosto([{ id: 'contenido_fiscal' }, { id: 'automejora' }]).map((a) => a.id);
    expect(orden).toEqual(['automejora', 'contenido_fiscal']);
  });
});

describe('el despacho de leads (0235)', () => {
  it('la lista literal del runner y la del motor son la misma', () => {
    const fuente = readFileSync('src/lib/likida/agentes/runner.ts', 'utf8');
    const linea = /const LEADS: readonly string\[\] = \[([^\]]*)\]/.exec(fuente);
    expect(linea, 'la lista literal del runner debe seguir existiendo').not.toBeNull();
    const ids = (linea as RegExpExecArray)[1]
      .split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
    expect(ids).toEqual([...AGENTES_LEADS]);
    for (const id of ids) expect(esAgenteLeads(id)).toBe(true);
  });

  it('un agente de leads se despacha a su motor y su resultado sale TAL CUAL', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'vigia', presupuesto_dia_usd: 0.1 }], error: null }]);
    correrLeads.mockResolvedValue({ resultado: 'corrio', piezas: 1, costoUsd: 0 });
    const r = await correrRunner(undefined, TENANT);
    expect(correrLeads).toHaveBeenCalledWith('vigia', 'cron', undefined, expect.any(Number));
    expect(r.agentes).toEqual([{ agente: 'vigia', resultado: 'corrio', motivo: undefined, piezas: 1, costoUsd: 0 }]);
  });

  it('«corrió y no fabricó» llega TAL CUAL a la vuelta: no es un salto', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'demo_prep', presupuesto_dia_usd: 0.1 }], error: null }]);
    correrLeads.mockResolvedValue({ resultado: 'corrio', piezas: 0, costoUsd: 0, motivo: 'no hay demo que preparar' });
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0]).toMatchObject({ resultado: 'corrio', piezas: 0, motivo: 'no hay demo que preparar' });
  });

  it('sin kill switch declarado no corre, aunque tenga motor', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'cazador', presupuesto_dia_usd: 0.1 }], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(correrLeads).not.toHaveBeenCalled();
    expect(r.agentes[0].motivo).toMatch(/kill switch/);
  });

  it('sin techo declarado no corre: el candado 3 no distingue departamentos', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'scorer', presupuesto_dia_usd: null }], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(correrLeads).not.toHaveBeenCalled();
    expect(r.agentes[0].motivo).toMatch(/sin presupuesto_dia_usd declarado/);
  });

  it('apagado desde la pantalla no corre, aunque el catálogo lo tenga vivo', async () => {
    apagados = new Set(['agente:propuestas']);
    respuestas.set('agente_definicion', [{ data: [{ id: 'propuestas', presupuesto_dia_usd: 0.1 }], error: null }]);
    const r = await correrRunner(undefined, TENANT);
    expect(correrLeads).not.toHaveBeenCalled();
    expect(r.agentes[0].motivo).toMatch(/apagado desde/);
  });

  it('un motor que truena no tumba la vuelta', async () => {
    respuestas.set('agente_definicion', [{ data: [
      { id: 'scorer', presupuesto_dia_usd: 0.1 },
      { id: 'vigia', presupuesto_dia_usd: 0.1 },
    ], error: null }]);
    correrLeads.mockRejectedValueOnce(new Error('prospecto ilegible'));
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0]).toMatchObject({ agente: 'scorer', resultado: 'saltado' });
    expect(r.agentes[0].motivo).toContain('prospecto ilegible');
    expect(r.agentes[1]).toMatchObject({ agente: 'vigia', resultado: 'corrio' });
  });

  it('los seis son BARATOS: ninguno llama al modelo', () => {
    for (const id of AGENTES_LEADS) expect(llamaAlModelo(id), id).toBe(false);
  });

  // La regla que la #152 estableció: un motor que ITERA recibe el reloj, y si
  // se queda a medias eso sube a `saltadosPorReloj`. Si no subiera, la ruta
  // escribiría un latido 'ok' sobre una vuelta que dejó empresas sin mirar.
  it('el motor recibe el vencimiento de la vuelta, no uno propio', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'dossier', presupuesto_dia_usd: 0.1 }], error: null }]);
    const vence = Date.now() + 60_000;
    await correrRunner(undefined, TENANT, { venceEn: vence });
    expect(correrLeads).toHaveBeenCalledWith('dossier', 'cron', undefined, vence);
  });

  it('«no alcancé a mirarlos todos» sube a saltadosPorReloj, y no se pinta como vuelta completa', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'dossier', presupuesto_dia_usd: 0.1 }], error: null }]);
    correrLeads.mockResolvedValue({ resultado: 'corrio', piezas: 0, costoUsd: 0, sinTurno: true, motivo: 'el reloj de la vuelta se agotó buscando candidato' });
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0]).toMatchObject({ agente: 'dossier', resultado: 'corrio', piezas: 0 });
    expect(r.saltadosPorReloj).toContain('dossier');
  });

  it('una vuelta que SÍ alcanzó no ensucia saltadosPorReloj', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'dossier', presupuesto_dia_usd: 0.1 }], error: null }]);
    correrLeads.mockResolvedValue({ resultado: 'corrio', piezas: 1, costoUsd: 0 });
    const r = await correrRunner(undefined, TENANT);
    expect(r.saltadosPorReloj).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AGB-5 (auditoría 24, 1-sep-2026) — CONTRAPRESIÓN GLOBAL: antes solo el
// Redactor miraba su propia bandeja; los demás 44 agentes que encolan un
// parte fabricaban sin mirar si alguien las leía (107 pendientes medidas,
// cero resoluciones humanas en 15 días).
// ═══════════════════════════════════════════════════════════════════════════
describe('motivoBandejaGlobalSinAtender — PURA', () => {
  it('sin nada pendiente, no hay motivo', () => {
    expect(motivoBandejaGlobalSinAtender(0, null)).toBeNull();
  });

  it('llegar al tope (la consulta trajo topeBandejaGlobal() filas) sí es motivo', () => {
    expect(motivoBandejaGlobalSinAtender(topeBandejaGlobal(), '2026-09-01T00:00:00Z')).toMatch(/bandeja sin atender/);
  });

  it('por debajo del tope pero con la más vieja pasada de plazo, también es motivo', () => {
    const ahora = new Date('2026-09-01T00:00:00Z').getTime();
    const viejaVencida = new Date(ahora - (diasVencimientoPieza() + 1) * 86_400_000).toISOString();
    expect(motivoBandejaGlobalSinAtender(1, viejaVencida, ahora)).toMatch(/vencida/);
  });

  it('por debajo del tope y la más vieja dentro del plazo: sin motivo', () => {
    const ahora = new Date('2026-09-01T00:00:00Z').getTime();
    const nueva = new Date(ahora - 60_000).toISOString();
    expect(motivoBandejaGlobalSinAtender(1, nueva, ahora)).toBeNull();
  });
});

describe('el candado 5 (AGB-5) en correrRunner', () => {
  it('con la bandeja al tope (o por arriba), un agente que encola un parte (back office) se SALTA con el motivo "bandeja sin atender"', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'talento', presupuesto_dia_usd: 0.1 }], error: null }]);
    respuestas.set('cola_aprobacion', [{
      data: Array.from({ length: topeBandejaGlobal() }, (_, i) => ({ creado_en: `2026-08-${10 + i}T00:00:00Z` })),
      error: null,
    }]);
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0]).toMatchObject({ agente: 'talento', resultado: 'saltado' });
    expect(r.agentes[0].motivo).toMatch(/bandeja sin atender/);
  });

  it('con la bandeja al tope, un agente de LEADS también se salta — el candado es ancho, no solo del Redactor', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'vigia', presupuesto_dia_usd: 0.1 }], error: null }]);
    respuestas.set('cola_aprobacion', [{
      data: Array.from({ length: topeBandejaGlobal() }, (_, i) => ({ creado_en: `2026-08-${10 + i}T00:00:00Z` })),
      error: null,
    }]);
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0]).toMatchObject({ agente: 'vigia', resultado: 'saltado' });
    expect(correrLeads).not.toHaveBeenCalled();
  });

  it('los CUATRO de dirección (correo directo a Javier) NO pasan por este candado — mandan correo, no encolan', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'kpi_whatsapp', presupuesto_dia_usd: 0.1 }], error: null }]);
    respuestas.set('cola_aprobacion', [{
      data: Array.from({ length: topeBandejaGlobal() }, (_, i) => ({ creado_en: `2026-08-${10 + i}T00:00:00Z` })),
      error: null,
    }]);
    const r = await correrRunner(undefined, TENANT);
    expect(correrDireccion).toHaveBeenCalledWith('kpi_whatsapp');
    expect(r.agentes[0]).toMatchObject({ agente: 'kpi_whatsapp', resultado: 'corrio' });
  });

  it('sin poder leer la bandeja, fail closed: se salta igual que si estuviera llena', async () => {
    respuestas.set('agente_definicion', [{ data: [{ id: 'vigilante_calidad', presupuesto_dia_usd: 0.1 }], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: null, error: { message: 'db down' } }]);
    const r = await correrRunner(undefined, TENANT);
    expect(r.agentes[0]).toMatchObject({ agente: 'vigilante_calidad', resultado: 'saltado' });
    expect(r.agentes[0].motivo).toMatch(/no se pudo leer la bandeja global/);
  });

  it('se lee UNA sola vez por vuelta — dos agentes no exentos comparten la misma lectura', async () => {
    // `talento` y `vigilante_calidad`, los dos del back office restante, en
    // la MISMA vuelta: si el candado leyera la bandeja una vez por agente, la
    // cola de `cola_aprobacion` (una sola respuesta) se agotaría en el
    // primero y el segundo caería al default vacío ("bandeja sana"),
    // contradiciendo al primero. Memoizado, los dos ven la MISMA bandeja llena.
    respuestas.set('agente_definicion', [
      { data: [{ id: 'talento', presupuesto_dia_usd: 0.1 }, { id: 'vigilante_calidad', presupuesto_dia_usd: 0.1 }], error: null },
    ]);
    respuestas.set('cola_aprobacion', [{
      data: Array.from({ length: topeBandejaGlobal() }, (_, i) => ({ creado_en: `2026-08-${10 + i}T00:00:00Z` })),
      error: null,
    }]);
    const r = await correrRunner();
    expect(r.agentes.every((a) => a.resultado === 'saltado')).toBe(true);
  });
});
