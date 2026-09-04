import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Liquidacion } from '@/types/likida';

// ═══════════════════════════════════════════════════════════════════════════
// EL CANDADO DEL CIERRE EN CEROS — hallazgo CRÍTICO del ejército QA
// (16-ago-2026, semilla `2026-08-16|nivel3|operador|texto_sin_fotos|0`,
// reproducido 5/6): "ya subí todo" sin una sola foto no disparaba
// `pareceCierre`, el freno del processor nunca corría, y el LLM cerraba la
// liquidación con `total_comprobado: 0` — el anticipo ENTERO contra el
// chofer, irreversible (triggers 0036/0037).
//
// La PRIMERA prueba de este archivo es la que reproduce el ataque: era ROJA
// antes del candado (el cierre pasaba) y hoy afirma que la tool se niega.
// El candado vive en la TOOL, no en la detección de frases, porque las
// frases son exactamente lo que el ataque esquiva.
// ═══════════════════════════════════════════════════════════════════════════

/** El cuadre programable por caso: el candado cuenta gastos de ESTE. */
let liq: Omit<Liquidacion, 'id' | 'creadaEn'>;
const enCeros = (): typeof liq => ({
  viajeId: 'v1', totalComprobado: 0, totalAnticipo: 10600, diferencia: 10600, estatus: 'cuadrada',
  totalDeducible: 0, totalNoDeducible: 0, totalPorConfirmar: 0,
  iepsAcreditable: 0, litrosDieselAcreditables: 0, ivaAcreditable: 0, peajeAcreditable: 0,
  gastos: [], diferencias: [],
});
const conComprobantes = (): typeof liq => ({
  ...enCeros(), totalComprobado: 8000, diferencia: 2600,
  gastos: [{ id: 'g1', concepto: 'diesel', monto: 8000, ocrConfianza: 0.95 }],
});

const logs = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger: logs }));
vi.mock('./cuadre/desde_db', () => ({ cuadrarDesdeDB: vi.fn(async () => liq) }));
vi.mock('./config', () => ({ getConfig: vi.fn(async () => ({ politica: [] })) }));
vi.mock('./interruptores', () => ({ estaApagado: vi.fn(async () => false) }));
vi.mock('./agentes/corridas', () => ({ registrarCorrida: vi.fn(async () => undefined) }));
vi.mock('./liquidacion/pdf', () => ({ generarLiquidacionPDF: vi.fn(async () => new Uint8Array([1])) }));
const saveLiquidacion = vi.fn(async () => 'liq-1');
vi.mock('./repo', () => ({
  getViaje: vi.fn(async () => ({ id: 'v1', folio: 'VJ-1', anticipo: 10600 })),
  getOperador: vi.fn(async () => ({ id: 'o1', nombre: 'Juan', telefono: '5219993700779' })),
  saveLiquidacion,
  leerSnapshotInsumosCierre: vi.fn(async () => ({ version: 1, hash: 'a'.repeat(64) })),
  insumosDeCierreCambiaron: vi.fn(() => false),
  getAcumuladoCombustible: vi.fn(async () => { throw new Error('sin base en pruebas'); }),
}));
vi.mock('@/lib/saas/fiscal', () => ({ getDatosFiscales: vi.fn(async () => null) }));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  }),
}));

await import('./tools');
const { executeTool } = await import('@/lib/llm/tool-executor');
// DAT-22: el cierre exige que el operador lo haya pedido EN ESTE TURNO
// (`cierrePedidoPorTexto`, que el processor calcula con `pidioCerrar`). Estos
// archivos prueban otras cosas del cierre, así que dan por hecho el escenario
// normal —el chofer escribió "listo"— y el candado propio se prueba en
// `tools_cierre_pedido.test.ts`.
const BASE = { tenantId: 't1', viajeId: 'v1', operadorId: 'o1', telefono: '5219993700779', cierrePedidoPorTexto: true };
const contexto = (extras: Record<string, unknown> = {}) => ({ ...BASE, ...extras, runId: randomUUID() });

beforeEach(() => {
  saveLiquidacion.mockClear();
  liq = enCeros();
});

describe('guardar_liquidacion se niega a cerrar en ceros sin confirmación expresa', () => {
  it('EL ATAQUE del QA: cero comprobantes y sin marca → la tool LANZA y nada persiste', async () => {
    const r = await executeTool('guardar_liquidacion', {}, contexto());
    expect(r.success).toBe(false);
    expect(String(r.error)).toMatch(/comprobante/);
    expect(String(r.error)).toMatch(/irreversible/);
    expect(saveLiquidacion).not.toHaveBeenCalled();
  });

  it('gastos que son puro $0 tampoco cuentan como comprobantes', async () => {
    liq = { ...enCeros(), gastos: [{ id: 'g0', concepto: 'diesel', monto: 0, ocrConfianza: 0.95 }] };
    const r = await executeTool('guardar_liquidacion', {}, contexto());
    expect(r.success).toBe(false);
    expect(saveLiquidacion).not.toHaveBeenCalled();
  });

  it('con la confirmación del freno (el operador dijo "listo" dos veces) el cierre en ceros SÍ procede', async () => {
    const r = await executeTool('guardar_liquidacion', {}, contexto({ cierreEnCerosConfirmado: true }));
    expect(r.success).toBe(true);
    expect(saveLiquidacion).toHaveBeenCalledTimes(1);
  });

  it('con comprobantes reales el candado ni se nota — cierra como siempre', async () => {
    liq = conComprobantes();
    const r = await executeTool('guardar_liquidacion', {}, contexto());
    expect(r.success).toBe(true);
    expect(saveLiquidacion).toHaveBeenCalledTimes(1);
  });
});
