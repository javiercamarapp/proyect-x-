// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28, MEDIO (REN-A3/REN-A6, REINCIDENTE de REND-A8) — DOS fallas del
// mismo `for` de pasos:
//
//   1. `decidir()` creaba `createLlmBudget(op.tenantId, randomUUID(), …)` EN
//      CADA llamada de visión — un `runId`/`LlmBudget` nuevo por cada uno de
//      los hasta 14 pasos de UNA sola sesión de vuelo — así que el techo
//      `maxRunUsd` (el que de verdad acota el gasto de una sesión) se
//      reiniciaba en cada paso en vez de acumularse. Una sesión de 14 pasos
//      podía reservar hasta 14 veces ese techo, no una.
//
//   2. El paso YA EN VUELO no llevaba `signal`: el reloj de la sesión solo se
//      consultaba ANTES de arrancar el SIGUIENTE paso (`piloto_vision_
//      reloj_aud25.test.ts`), pero una llamada de visión que ya arrancó podía
//      tardar los 120 s del peor caso de la escalera de reintentos de
//      `openrouter.ts` sin que nada la cortara al llegar al presupuesto de la
//      sesión.
//
// Estas pruebas fijan las dos correcciones: UN SOLO presupuesto para TODA la
// sesión, y una señal de aborto acotada a lo que queda de esa sesión.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { crearPilotoVision, PASOS_MAXIMOS } from './piloto_vision';
import type { InventarioPagina } from './playwright_base';
import type { Comercio } from '../comercios';

const decidirMock = vi.fn();
vi.mock('@/lib/llm/openrouter', () => ({
  generateStructured: (...a: unknown[]) => decidirMock(...a),
}));

const createLlmBudgetMock = vi.fn();
vi.mock('@/lib/llm/budget', () => ({
  createLlmBudget: (...a: unknown[]) => createLlmBudgetMock(...a),
}));

const COMERCIO: Comercio = {
  clave: 'enerser', nombre: 'Enerser', portal: 'https://facturacion.enerser.com.mx/',
  requiereCuenta: false, plazo: 'mes_natural', plazoVerificado: false,
  campos: [{ clave: 'webId', etiquetaPortal: 'Web ID', requerido: true }],
  reconocer: { dominios: ['facturacion.enerser.com.mx'] },
};
const RECEPTOR = {
  rfc: 'GMX0902279I1', nombre: 'G3M', codigoPostal: '97000',
  regimenFiscal: '601', usoCfdi: 'G03', correo: 'cfdi@flota.mx',
};
const CAMPOS = [{ clave: 'webId' as const, etiqueta: 'Web ID', valor: '650', requerido: true }];
const TENANT_ID = '11111111-1111-1111-1111-111111111111';

const INVENTARIO: InventarioPagina = {
  url: 'https://facturacion.enerser.com.mx/', titulo: 'Facturación',
  campos: [{ tag: 'input', type: 'text', id: 'webid', name: 'webid', placeholder: '', etiqueta: 'Web ID', visible: true, opciones: [] }],
  botones: [{ tag: 'button', id: 'buscar', name: '', texto: 'Buscar ticket', visible: true }],
  captcha: [], texto: 'Facturación electrónica',
};

/** Un valor DISTINTO cada vez, para que el loop-guard no corte antes de que
 *  el reloj o el conteo de pasos tengan oportunidad de hacerlo. */
const accion = (valor: string) => ({
  data: {
    veo: 'la página', hayCaptcha: false, tipo: 'escribir',
    selector: '#webid', valor, esBotonQueEmite: false, motivo: null,
  },
});

let ahora = 1_000_000;

beforeEach(() => {
  ahora = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => ahora);
  decidirMock.mockReset();
  createLlmBudgetMock.mockReset();
  createLlmBudgetMock.mockImplementation((tenantId: string, runId: string, proposito: string) => ({
    tenantId, runId, proposito, maxRunUsd: 0.5, maxTenantDailyUsd: 5, reservadoRunUsd: 0,
  }));
  let i = 0;
  decidirMock.mockImplementation(async () => accion(`v${i++}`));
});

afterEach(() => { vi.restoreAllMocks(); });

/** Página doble; `msPorPaso` es cuánto avanza el reloj FALSO en cada
 *  `inventario()` — la misma llamada "lenta" que simula `piloto_vision_
 *  reloj_aud25.test.ts`. */
function paginaFalsa(msPorPaso: number) {
  const hechos: string[] = [];
  return {
    hechos,
    abrir: vi.fn(async () => { hechos.push('abrir'); }),
    escribir: vi.fn(async (sel: string, val: string) => { hechos.push(`escribir ${sel}=${val}`); }),
    hacerClic: vi.fn(async (sel: string) => { hechos.push(`clic ${sel}`); }),
    leerTexto: vi.fn(async () => null),
    captura: vi.fn(async () => 'data:image/jpeg;base64,xxxx'),
    inventario: vi.fn(async () => { ahora += msPorPaso; return INVENTARIO; }),
    cerrar: vi.fn(async () => { hechos.push('cerrar'); }),
  };
}

// Nota: NO usar un parámetro con default `= TENANT_ID` aquí — un default de
// JS se dispara también cuando el llamador pasa `undefined` EXPLÍCITO, que es
// exactamente el caso que la prueba "sin tenantId" necesita ejercitar.
function piloto(pagina: ReturnType<typeof paginaFalsa>, tenantId: string | undefined) {
  return crearPilotoVision({
    comercio: COMERCIO, receptor: RECEPTOR, tenantId,
    abrirPagina: async () => pagina as never,
    arrancoConSesion: true,
  });
}

describe('AUD28 REN-A3: un solo LlmBudget por SESIÓN de vuelo, no uno por paso', () => {
  it('createLlmBudget se llama UNA sola vez aunque la sesión corra los 14 pasos', async () => {
    const p = paginaFalsa(1_000); // 1s/paso: de sobra para los 14 pasos completos
    await piloto(p, TENANT_ID).facturar(CAMPOS, 'ensayo');
    expect(decidirMock.mock.calls.length).toBe(PASOS_MAXIMOS);
    expect(createLlmBudgetMock).toHaveBeenCalledTimes(1);
    expect(createLlmBudgetMock).toHaveBeenCalledWith(TENANT_ID, expect.any(String), 'ocr_lote');
  });

  it('las 14 llamadas de visión comparten el MISMO objeto de presupuesto (mismo runId)', async () => {
    const p = paginaFalsa(1_000);
    await piloto(p, TENANT_ID).facturar(CAMPOS, 'ensayo');
    const budgets = decidirMock.mock.calls.map((c) => (c[0] as { budget: { runId: string } }).budget);
    expect(budgets.length).toBe(PASOS_MAXIMOS);
    // Referencia idéntica en las 14 llamadas — no solo mismo valor, el MISMO objeto.
    expect(budgets.every((b) => b === budgets[0])).toBe(true);
    expect(new Set(budgets.map((b) => b.runId)).size).toBe(1);
  });

  it('sin tenantId no se crea presupuesto — el piloto de visión sin flota no manda `budget`', async () => {
    const p = paginaFalsa(1_000);
    await piloto(p, undefined).facturar(CAMPOS, 'ensayo');
    expect(createLlmBudgetMock).not.toHaveBeenCalled();
    const budgets = decidirMock.mock.calls.map((c) => (c[0] as { budget: unknown }).budget);
    expect(budgets.length).toBeGreaterThan(0);
    expect(budgets.every((b) => b === undefined)).toBe(true);
  });
});

describe('AUD28 REN-A6: el paso EN VUELO no puede rebasar el reloj de la sesión', () => {
  it('generateStructured recibe una señal de aborto viva, acotada a lo que queda del presupuesto', async () => {
    const p = paginaFalsa(1_000);
    await piloto(p, TENANT_ID).facturar(CAMPOS, 'ensayo');
    const señales = decidirMock.mock.calls.map((c) => (c[0] as { signal: AbortSignal }).signal);
    expect(señales.length).toBe(PASOS_MAXIMOS);
    for (const s of señales) {
      expect(s).toBeInstanceOf(AbortSignal);
      // Con reloj de sobra, ningún paso arranca ya abortado.
      expect(s.aborted).toBe(false);
    }
  });

  it('con el reloj YA vencido al llegar al paso, la señal llega YA ABORTADA — se corta limpio, no se cuelga', async () => {
    // Un solo `inventario()` avanza el reloj MUCHO más que el presupuesto de
    // la sesión completa: para cuando `decidir()` arma su señal, el
    // presupuesto de la sesión ya se agotó DENTRO del paso en curso — el
    // mismo caso que el chequeo "ANTES del siguiente paso" no puede cubrir.
    const p = paginaFalsa(200_000);
    await piloto(p, TENANT_ID).facturar(CAMPOS, 'ensayo');
    expect(decidirMock).toHaveBeenCalledTimes(1);
    const señal = (decidirMock.mock.calls[0]?.[0] as { signal: AbortSignal }).signal;
    // Ya abortada AL LLEGAR a `generateStructured`, no "se va a abortar en
    // 1ms": un `fetch`/SDK que respeta `signal` corta la llamada de inmediato
    // en vez de quedarse esperando el timeout por defecto del proveedor.
    expect(señal.aborted).toBe(true);
  });
});
