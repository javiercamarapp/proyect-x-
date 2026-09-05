import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Liquidacion } from '@/types/likida';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA PROD 22-ago-2026 · DAT-22 — `guardar_liquidacion` ESTABA
// DISPONIBLE EN TODOS LOS TURNOS.
//
// Es la única acción irreversible del sistema: después de ella los triggers
// 0036/0037 bloquean cualquier alta o corrección sobre ese viaje. Y el único
// freno que tenía era el del cierre EN CEROS, o sea que un viaje CON
// comprobantes se podía cerrar en el turno de un "¿cuánto llevo?" —bastaba que
// el modelo se adelantara a la conversación— y el chofer se quedaba con la
// mitad del fajo en la mano y el viaje cerrado.
//
// El candado vive en la TOOL y no en el prompt por la misma razón que el del
// cierre en ceros: lo que hay que acotar es el modelo, así que la condición no
// puede depender de que el modelo la respete. La marca la calcula el processor
// sobre el TEXTO del turno (`pidioCerrar`), no el modelo.
//
// La primera prueba de este archivo es la que reproduce el hallazgo: era VERDE
// (el cierre pasaba) antes del candado.
// ═══════════════════════════════════════════════════════════════════════════

const conComprobantes = (): Omit<Liquidacion, 'id' | 'creadaEn'> => ({
  viajeId: 'v1', totalComprobado: 8000, totalAnticipo: 10600, diferencia: 2600, estatus: 'cuadrada',
  totalDeducible: 8000, totalNoDeducible: 0, totalPorConfirmar: 0,
  iepsAcreditable: 0, litrosDieselAcreditables: 0, ivaAcreditable: 0, peajeAcreditable: 0,
  gastos: [{ id: 'g1', concepto: 'diesel', monto: 8000, ocrConfianza: 0.95 }],
  diferencias: [],
});

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./cuadre/desde_db', () => ({ cuadrarDesdeDB: vi.fn(async () => conComprobantes()) }));
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
  supabaseAdmin: () => ({ storage: { from: () => ({ upload: async () => ({ error: null }) }) } }),
}));

await import('./tools');
const { executeTool } = await import('@/lib/llm/tool-executor');
const { pidioCerrar } = await import('./processor');

const BASE = { tenantId: 't1', viajeId: 'v1', operadorId: 'o1', telefono: '5219993700779' };
const contexto = (extras: Record<string, unknown> = {}) => ({ ...BASE, ...extras, runId: randomUUID() });

describe('DAT-22 · el cierre solo corre si el operador lo pidió en este turno', () => {
  beforeEach(() => { saveLiquidacion.mockClear(); });

  it('EL HALLAZGO: sin la marca, la tool se niega y NO persiste nada', async () => {
    // El turno de un "¿cuánto llevo?" con el modelo adelantándose. Antes esto
    // cerraba el viaje del chofer con la mitad de su fajo sin mandar.
    const r = await executeTool('guardar_liquidacion', {}, contexto());
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no pidió cerrar/i);
    expect(saveLiquidacion, 'nada irreversible puede haber ocurrido').not.toHaveBeenCalled();
  });

  it('el error le dice al modelo QUÉ hacer, no solo que no', async () => {
    // El texto viaja al modelo como resultado de la tool y él se lo explica al
    // operador. Un "no" pelón lo deja reintentando la misma tool.
    const r = await executeTool('guardar_liquidacion', {}, contexto());
    expect(r.error).toMatch(/listo/i);
    expect(r.error).toMatch(/contéstale/i);
  });

  it('`false` explícito tampoco cuela (no es solo "undefined")', async () => {
    const r = await executeTool('guardar_liquidacion', {}, contexto({ cierrePedidoPorTexto: false }));
    expect(r.success).toBe(false);
    expect(saveLiquidacion).not.toHaveBeenCalled();
  });

  it('CONTROL — con la marca, el cierre corre completo', async () => {
    const r = await executeTool('guardar_liquidacion', {}, contexto({ cierrePedidoPorTexto: true }));
    expect(r.success, r.error).toBe(true);
    expect(saveLiquidacion).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// `pidioCerrar` — MÁS ANCHO QUE `pareceCierre`, Y A PROPÓSITO.
//
// `pareceCierre` es el freno del cierre en ceros: es estrecho y se equivoca
// hacia NO frenar. Éste decide si la tool existe, y equivocarse hacia el "no"
// deja a un chofer atrapado en un viaje que no puede cerrar porque lo pidió con
// otras palabras. Por eso cubre las formas largas además de las del freno.
// ═══════════════════════════════════════════════════════════════════════════
describe('pidioCerrar', () => {
  it('reconoce las formas del freno', () => {
    for (const t of ['listo', 'ya terminé', 'ya acabé', 'ya quedó', 'es todo', 'cierra']) {
      expect(pidioCerrar(t), t).toBe(true);
    }
  });

  it('y las formas largas que el freno deja pasar', () => {
    for (const t of [
      'ya no traigo más tickets',
      'mándame mi liquidación',
      'ciérrala por favor',
      'ese fue el último ticket',
      'ya estuvo, cuadra mi viaje',
    ]) {
      expect(pidioCerrar(t), t).toBe(true);
    }
  });

  it('NO reconoce el turno en el que el modelo no tiene derecho a cerrar', () => {
    for (const t of ['¿cuánto llevo?', 'hola', 'ya llegué', 'se me ponchó una llanta', 'ok', 'gracias']) {
      expect(pidioCerrar(t), t).toBe(false);
    }
  });

  it('un turno sin texto (una foto, un pin) nunca pide cerrar', () => {
    expect(pidioCerrar(undefined)).toBe(false);
    expect(pidioCerrar('   ')).toBe(false);
  });
});
