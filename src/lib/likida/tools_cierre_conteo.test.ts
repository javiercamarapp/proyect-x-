import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Liquidacion } from '@/types/likida';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 18 · DAT-02 — EL PDF Y EL WHATSAPP CONTABAN COSAS DISTINTAS.
//
// El cierre son tres pasos con segundos de por medio: `computeCuadre` toma la
// fotografía, se generan los DOS PDF, y hasta entonces se persiste. Las fotos
// entrantes NO toman el mutex del viaje (processor.ts), así que un diésel de
// $800 que entra en esa ventana:
//   · no está en el PDF que se archiva ni en el del operador;
//   · no está en la liquidación que se guarda;
//   · y queda huérfano PARA SIEMPRE — el viaje ya está liquidado y el trigger
//     de la 0036 no deja meterlo después.
//
// La 0158 hace que la base cuente los comprobantes DENTRO del candado del
// viaje y rechace el cierre (CU003) si no coinciden con los que el papel
// imprimió. Este archivo prueba el lado de acá: que el conteo VIAJA, que ante
// el rechazo se vuelve a fotografiar Y a imprimir, y que el reintento es UNO.
//
// La primera prueba era ROJA antes del arreglo: `saveLiquidacion` se llamaba
// sin conteo, así que la base no tenía nada que comparar y el rechazo no
// existía.
// ═══════════════════════════════════════════════════════════════════════════

const conNGastos = (n: number): Omit<Liquidacion, 'id' | 'creadaEn'> => ({
  viajeId: 'v1', totalComprobado: 850 * n, totalAnticipo: 5000, diferencia: 5000 - 850 * n,
  estatus: 'cuadrada', totalDeducible: 850 * n, totalNoDeducible: 0, totalPorConfirmar: 0,
  iepsAcreditable: 0, litrosDieselAcreditables: 0, ivaAcreditable: 0, peajeAcreditable: 0,
  diferencias: [],
  gastos: Array.from({ length: n }, (_, i) => ({
    id: `g${i}`, concepto: 'diesel' as const, monto: 850, ocrConfianza: 0.95,
  })),
});

/** Las fotografías que `computeCuadre` va devolviendo, en orden. */
let fotos: Array<Omit<Liquidacion, 'id' | 'creadaEn'>>;
const cuadrarDesdeDB = vi.fn(async () => fotos.shift() ?? conNGastos(9));

const logs = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger: logs }));
vi.mock('./cuadre/desde_db', () => ({ cuadrarDesdeDB: (...a: unknown[]) => cuadrarDesdeDB(...(a as [])) }));
vi.mock('./config', () => ({ getConfig: vi.fn(async () => ({ politica: [] })) }));
vi.mock('./interruptores', () => ({ estaApagado: vi.fn(async () => false) }));
vi.mock('./agentes/corridas', () => ({ registrarCorrida: vi.fn(async () => undefined) }));

/** Cada llamada al generador de PDF cuenta cuántos gastos traía el cuadre. */
const pdfsImpresos: number[] = [];
vi.mock('./liquidacion/pdf', () => ({
  generarLiquidacionPDF: vi.fn(async (full: Liquidacion) => {
    pdfsImpresos.push(full.gastos.length);
    return new Uint8Array([1]);
  }),
}));

const saveLiquidacion = vi.fn(async (_t: string, _l: unknown, _p?: string, _n?: number, _s?: unknown) => 'liq-1');
const leerSnapshotInsumosCierre = vi.fn(async () => ({ version: 1 as const, hash: 'a'.repeat(64) }));
vi.mock('./repo', async () => {
  const real = await vi.importActual<typeof import('./repo')>('./repo');
  return {
    getViaje: vi.fn(async () => ({ id: 'v1', folio: 'VJ-1', anticipo: 5000 })),
    getOperador: vi.fn(async () => ({ id: 'o1', nombre: 'Juan', telefono: '5219993700779' })),
    saveLiquidacion: (...a: unknown[]) => saveLiquidacion(...(a as Parameters<typeof saveLiquidacion>)),
    leerSnapshotInsumosCierre: (...a: unknown[]) => leerSnapshotInsumosCierre(...(a as [])),
    // El detector de CU003/CU006 es el REAL: si cambia su criterio, esta prueba lo ve.
    insumosDeCierreCambiaron: real.insumosDeCierreCambiaron,
    getAcumuladoCombustible: vi.fn(async () => { throw new Error('sin base en pruebas'); }),
  };
});
vi.mock('@/lib/saas/fiscal', () => ({ getDatosFiscales: vi.fn(async () => null) }));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ storage: { from: () => ({ upload: async () => ({ error: null }) }) } }),
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

/** El error tal como llega de `saveLiquidacion` cuando la 0158 rechaza. */
const cu003 = () => Object.assign(new Error('saveLiquidacion: contó otra cosa'), { code: 'CU003' });
const cu006 = () => Object.assign(new Error('saveLiquidacion: snapshot_changed'), { code: 'CU006' });

beforeEach(() => {
  saveLiquidacion.mockReset();
  saveLiquidacion.mockResolvedValue('liq-1');
  leerSnapshotInsumosCierre.mockReset();
  leerSnapshotInsumosCierre
    .mockResolvedValueOnce({ version: 1, hash: 'a'.repeat(64) })
    .mockResolvedValue({ version: 1, hash: 'b'.repeat(64) });
  cuadrarDesdeDB.mockClear();
  pdfsImpresos.length = 0;
  fotos = [conNGastos(5)];
});

describe('el cierre le dice a la base cuántos comprobantes archivó', () => {
  it('manda el conteo de la MISMA fotografía que se imprimió', async () => {
    const r = await executeTool('guardar_liquidacion', {}, contexto());
    expect(r.success).toBe(true);
    expect(saveLiquidacion).toHaveBeenCalledTimes(1);
    expect(saveLiquidacion.mock.calls[0][3]).toBe(5);
    expect(saveLiquidacion.mock.calls[0][4]).toEqual({ version: 1, hash: 'a'.repeat(64) });
    expect(pdfsImpresos).toEqual([5, 5]);   // contralor + operador
  });
});

describe('si un gasto entra en la ventana, se vuelve a fotografiar UNA vez', () => {
  it('el segundo cuadre se re-imprime y se archiva, y el resultado narra ESE', async () => {
    // La foto tardía: la base ve 6 donde el papel imprimió 5.
    fotos = [conNGastos(5), conNGastos(6)];
    saveLiquidacion.mockRejectedValueOnce(cu003());

    const r = await executeTool('guardar_liquidacion', {}, contexto());

    expect(r.success).toBe(true);
    expect(cuadrarDesdeDB).toHaveBeenCalledTimes(2);
    expect(saveLiquidacion).toHaveBeenCalledTimes(2);
    expect(saveLiquidacion.mock.calls[1][3]).toBe(6);
    expect(saveLiquidacion.mock.calls[1][4]).toEqual({ version: 1, hash: 'b'.repeat(64) });
    // Los PDF se REIMPRIMEN con la fotografía nueva: archivar el papel viejo
    // sería exactamente el hallazgo, movido de sitio.
    expect(pdfsImpresos).toEqual([5, 5, 6, 6]);
    // Y lo que se devuelve —lo que la guardia del processor narra por
    // WhatsApp— es el cuadre que de verdad se archivó, no el primero.
    expect((r.result as { liq: Liquidacion }).liq.gastos).toHaveLength(6);
  });

  it('recalcula también si cambia monto/IVA/UUID aunque el conteo sea idéntico', async () => {
    fotos = [conNGastos(5), conNGastos(5)];
    saveLiquidacion.mockRejectedValueOnce(cu006());

    const r = await executeTool('guardar_liquidacion', {}, contexto());

    expect(r.success).toBe(true);
    expect(cuadrarDesdeDB).toHaveBeenCalledTimes(2);
    expect(saveLiquidacion).toHaveBeenCalledTimes(2);
    expect(leerSnapshotInsumosCierre).toHaveBeenCalledTimes(2);
    expect(saveLiquidacion.mock.calls[0][3]).toBe(5);
    expect(saveLiquidacion.mock.calls[1][3]).toBe(5);
  });

  it('si al segundo intento vuelve a cambiar, NO cierra: se rinde y lo dice', async () => {
    // Dos fotos seguidas en la ventana no son un accidente: es un operador
    // mandando fajo mientras el agente cierra. Insistir le daría un cuadre
    // distinto cada vez, y ninguno más verdadero que el anterior.
    fotos = [conNGastos(5), conNGastos(6)];
    saveLiquidacion.mockRejectedValueOnce(cu003()).mockRejectedValueOnce(cu003());

    const r = await executeTool('guardar_liquidacion', {}, contexto());

    expect(r.success).toBe(false);
    expect(saveLiquidacion).toHaveBeenCalledTimes(2);
  });

  it('un error que NO es el del conteo no se reintenta jamás', async () => {
    // Reintentar un fallo cualquiera sería generar dos veces los PDF y dos
    // veces la carga contra la base por algo que no va a cambiar.
    saveLiquidacion.mockRejectedValue(new Error('se cayó la red'));
    const r = await executeTool('guardar_liquidacion', {}, contexto());
    expect(r.success).toBe(false);
    expect(saveLiquidacion).toHaveBeenCalledTimes(1);
    expect(cuadrarDesdeDB).toHaveBeenCalledTimes(1);
  });
});
