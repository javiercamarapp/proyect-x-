import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 26 · CONTINUACIÓN, FIS-A3 (ALTO, REINCIDENTE). EL CUARTO SITIO QUE
// MIDE EL CUBO DEL 15 % — Y LO MIDE CON OTRO DENOMINADOR.
//
// `getAcumuladoCombustible(tenant, ejercicio, claves)` tiene tres llamadores.
// Dos pasan las claves del SAT de la config:
//     cuadre/desde_db.ts:128   → el motor que arma el PDF
//     fiscal.ts:487            → el panel del contador y `resumen_fiscal`
// y `tools.ts:200` no las pasaba. La RPC de la 0305 sin claves cuenta SOLO
// `concepto = 'diesel'`:
//     and (concepto = 'diesel' or (p_claves is not null and cardinality(...) > 0
//          and clave_prod_serv = any(p_claves)))
//
// Es alcanzable: `conceptoDesdeClave` —lo único que traduce la clave SAT a
// `concepto = 'diesel'`— solo corre en el alta por XML sin foto previa
// (`processor.ts:3179`). El camino normal —foto primero, XML después— escribe
// `clave_prod_serv` sin recalcular el concepto (`repo.ts:802`,
// `intake/consolidado.ts:297`), así que un ticket de gasolinera clasificado
// `otro` con CFDI posterior queda con `concepto != 'diesel'` Y la clave puesta.
//
// Con $700,000 de diésel por concepto y $300,000 por clave (de los cuales
// $160,000 en efectivo), el motor mide 16 % → `excedido` y el PDF quita
// deducción; `tools.ts` medía 0 % → `holgado` con $105,000 de margen. Y como
// `tools.ts:220` solo agrega `rfa-2026-2.9` a `fundamentos` cuando el estado no
// es `holgado`, el agente ni siquiera podía citar la regla: le contestaba al
// contralor por WhatsApp que le sobra margen sobre la liquidación cuyo papel
// dice lo contrario. Es «una cifra fiscal que se lee distinto en dos
// pantallas», y las dos pantallas son el PDF archivado y el chat que lo
// explica, en el mismo minuto.
// ═══════════════════════════════════════════════════════════════════════════

const CLAVES = ['15101505', '15101514'];

const acum = vi.hoisted(() => vi.fn(async () => ({ efectivo: 160_000, totalCombustible: 1_000_000 })));

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./interruptores', () => ({ estaApagado: vi.fn(async () => false) }));
vi.mock('./agentes/corridas', () => ({ registrarCorrida: vi.fn(async () => {}) }));
vi.mock('./cuadre/desde_db', () => ({
  cuadrarDesdeDB: vi.fn(async () => ({
    viajeId: 'v-1', totalComprobado: 0, totalAnticipo: 0, diferencia: 0,
    estatus: 'revisar', diferencias: [], gastos: [],
  })),
}));
vi.mock('./config', () => ({
  getConfig: vi.fn(async () => ({
    politica: [],
    hidrocarburos: { claves: CLAVES },
    facilidadCombustibleEfectivo: { dedicacionExclusivaCarga: true, regimenElegible: true },
  })),
}));
vi.mock('./repo', () => ({
  getAcumuladoCombustible: acum,
  getViaje: vi.fn(async () => ({ fechaInicio: '2026-07-15', destino: 'Cancún', anticipo: 0 })),
  getOperador: vi.fn(async () => null),
  saveLiquidacion: vi.fn(async () => {}),
  conteoDeGastosCambio: vi.fn(async () => false),
}));

await import('./tools');
const { executeTool } = await import('@/lib/llm/tool-executor');

const CTX = { tenantId: 't-1', viajeId: 'v-1', runId: '00000000-0000-4000-8000-0000000000e1' };

describe('FIS-A3 · los tres llamadores del cubo del 15% miden el MISMO universo', () => {
  beforeEach(() => acum.mockClear());

  it('`cuadrar_viaje` pide el acumulado CON las claves de la config, como el motor y el panel', async () => {
    const r = await executeTool('cuadrar_viaje', {}, CTX);
    expect(r.error, r.error).toBeUndefined();

    expect(acum, 'el tool tiene que consultar el acumulado del ejercicio').toHaveBeenCalled();
    // El tercer argumento es lo que separa «el total de los pagos por consumo
    // de combustible» (RFA 2026 regla 2.9) de «solo lo que alguien tecleó
    // como diesel».
    expect(acum).toHaveBeenCalledWith('t-1', 2026, CLAVES);
  });
});
