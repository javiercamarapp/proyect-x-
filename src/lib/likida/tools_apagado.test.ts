import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./liquidacion/rutas_pdf', async (original) => ({
  ...await original<typeof import('./liquidacion/rutas_pdf')>(),
  rutasPdfVersionadas: (tenant: string, viaje: string) => ({
    contralor: `${tenant}/${viaje}-version-00000000-0000-4000-8000-000000000046.pdf`,
    operador: `${tenant}/${viaje}-version-00000000-0000-4000-8000-000000000046-operador.pdf`,
  }),
}));
import { randomUUID } from 'node:crypto';
import type { Liquidacion } from '@/types/likida';

// ═══════════════════════════════════════════════════════════════════════════
// FASE 1 DEL BLUEPRINT (15-ago-2026) — `agente:liquidacion` deja de ser
// decorativo y el corazón del producto estrena bitácora.
//
// Este archivo usa el `interruptores` REAL a propósito (a diferencia de
// tools_cableado, que lo mockea): así se prueba la CADENA completa —
// apagar la palanca detiene el cierre, y un error de lectura del interruptor
// también lo detiene (fail-closed), no porque alguien lo asuma sino porque
// el módulo real lo hace.
// ═══════════════════════════════════════════════════════════════════════════

const LIQ: Omit<Liquidacion, 'id' | 'creadaEn'> = {
  viajeId: 'v1', totalComprobado: 8000, totalAnticipo: 8000, diferencia: 0, estatus: 'cuadrada',
  totalDeducible: 8000, totalNoDeducible: 0, totalPorConfirmar: 0,
  iepsAcreditable: 0, litrosDieselAcreditables: 0, ivaAcreditable: 0, peajeAcreditable: 0,
  gastos: [{ id: 'g1', concepto: 'diesel', monto: 8000, ocrConfianza: 0.95 }], diferencias: [],
};

/** El interruptor, programable por prueba: sin fila (encendido), apagado, o
 *  la lectura reventada — que por el contrato fail-closed vale lo mismo que
 *  apagado. */
let interruptor: { data: { apagado: boolean } | null; error: { message: string } | null };
/** Lo que llegó a `agente_corrida`. */
const corridas: Array<Record<string, unknown>> = [];
let corridaError: { message: string } | null = null;
const subidos = new Set<string>();
const fallaEnRuta = new Set<string>();

const logs = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger: logs }));
vi.mock('./cuadre/desde_db', () => ({ cuadrarDesdeDB: vi.fn(async () => LIQ) }));
vi.mock('./config', () => ({ getConfig: vi.fn(async () => ({ politica: [] })) }));
// El PDF de verdad se prueba en tools_cableado; aquí el sujeto es la palanca
// y la bitácora, no el papel.
vi.mock('./liquidacion/pdf', () => ({ generarLiquidacionPDF: vi.fn(async () => new Uint8Array([1])) }));
const saveLiquidacion = vi.fn(async () => 'liq-1');
vi.mock('./repo', () => ({
  getViaje: vi.fn(async () => ({ id: 'v1', folio: 'VJ-1', anticipo: 8000 })),
  getOperador: vi.fn(async () => ({ id: 'o1', nombre: 'Juan', telefono: '5219993700779' })),
  saveLiquidacion,
  leerSnapshotInsumosCierre: vi.fn(async () => ({ version: 1, hash: 'a'.repeat(64) })),
  insumosDeCierreCambiaron: vi.fn(() => false),
  getAcumuladoCombustible: vi.fn(async () => { throw new Error('sin base en pruebas'); }),
}));
vi.mock('@/lib/saas/fiscal', () => ({ getDatosFiscales: vi.fn(async () => null) }));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      if (tabla === 'interruptor') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => interruptor }) }) };
      }
      if (tabla === 'agente_corrida') {
        return {
          insert: async (fila: Record<string, unknown>) => {
            if (corridaError) return { error: corridaError };
            corridas.push(fila);
            return { error: null };
          },
        };
      }
      throw new Error(`tabla inesperada en la prueba: ${tabla}`);
    },
    storage: {
      from: () => ({
        upload: async (path: string) => {
          if (fallaEnRuta.has(path)) return { error: { message: 'storage caído' } };
          subidos.add(path);
          return { error: null };
        },
      }),
    },
  }),
}));

await import('./tools');
const { executeTool } = await import('@/lib/llm/tool-executor');
// DAT-22: el cierre exige que el operador lo haya pedido EN ESTE TURNO
// (`cierrePedidoPorTexto`, que el processor calcula con `pidioCerrar`). Estos
// archivos prueban otras cosas del cierre, así que dan por hecho el escenario
// normal —el chofer escribió "listo"— y el candado propio se prueba en
// `tools_cierre_pedido.test.ts`.
const CTX = { tenantId: 't1', viajeId: 'v1', operadorId: 'o1', telefono: '5219993700779', cierrePedidoPorTexto: true };
const cerrar = () => executeTool('guardar_liquidacion', {}, { ...CTX, runId: randomUUID() });

beforeEach(async () => {
  // RES-19: `leerInterruptor` cachea 5 s por instancia y este archivo usa el
  // módulo REAL con una respuesta distinta por prueba — sin tirar la caché, la
  // lectura de una contestaría por la siguiente.
  (await import('@/lib/likida/interruptores')).olvidarInterruptores();
  interruptor = { data: null, error: null }; // sin fila = ENCENDIDO
  corridas.length = 0;
  corridaError = null;
  subidos.clear();
  fallaEnRuta.clear();
  saveLiquidacion.mockClear().mockResolvedValue('liq-1');
  logs.error.mockClear();
});

describe('el kill switch de agente:liquidacion (0110) — antes decorativo, ahora real', () => {
  it('APAGADO: el cierre se niega, no persiste nada, no sube PDFs y NO anota corrida', async () => {
    interruptor = { data: { apagado: true }, error: null };
    const r = await cerrar();
    expect(r.success).toBe(false);
    expect(String(r.error)).toMatch(/apagado/);
    expect(saveLiquidacion).not.toHaveBeenCalled();
    expect(subidos.size).toBe(0);
    // Un cierre que la palanca detuvo NO es una corrida: no corrió.
    expect(corridas).toEqual([]);
  });

  it('FAIL-CLOSED de verdad: la LECTURA del interruptor falla y el cierre también se detiene', async () => {
    // No se mockea estaApagado: el módulo real recibe el error por valor y
    // devuelve apagado, con grito en el log. Si alguien "normaliza" ese
    // contrato (error = encendido, como el resto del repo), esta prueba cae.
    interruptor = { data: null, error: { message: 'fetch failed' } };
    const r = await cerrar();
    expect(r.success).toBe(false);
    expect(saveLiquidacion).not.toHaveBeenCalled();
    expect(logs.error).toHaveBeenCalledWith('interruptores.lectura_fallo',
      expect.objectContaining({ interruptor: 'agente:liquidacion' }));
  });

  it('ENCENDIDO (sin fila, el default del catálogo): el cierre corre completo', async () => {
    const r = await cerrar();
    expect(r.success, r.error).toBe(true);
    // El 4º argumento es el conteo de comprobantes de la 0158 (DAT-02) y el
    // 5º sella la versión/hash de los insumos económicos y fiscales.
    expect(saveLiquidacion).toHaveBeenCalledWith(
      't1', LIQ, 't1/v1-version-00000000-0000-4000-8000-000000000046.pdf', LIQ.gastos.length,
      { version: 1, hash: 'a'.repeat(64) },
    );
  });
});

describe('la bitácora de liquidacion (0102 + 0115) — la primera del corazón del producto', () => {
  it("el cierre anota UNA corrida: agente 'liquidacion', disparo 'whatsapp', estado 'ok'", async () => {
    await cerrar();
    expect(corridas).toHaveLength(1);
    expect(corridas[0]).toMatchObject({
      tenant_id: 't1',
      agente: 'liquidacion',
      disparo: 'whatsapp',
      estado: 'ok',
      resumen: { liquidacionId: 'liq-1', estatus: 'cuadrada', pdfContralor: true, pdfOperador: true },
    });
  });

  it("un ejemplar del PDF caído degrada la corrida a 'parcial' con el motivo redactado", async () => {
    fallaEnRuta.add('t1/v1-version-00000000-0000-4000-8000-000000000046.pdf');
    const r = await cerrar();
    expect(r.success, 'el cierre VALE aunque falte un papel').toBe(true);
    expect(corridas[0]).toMatchObject({ estado: 'parcial' });
    expect(String(corridas[0].error)).toMatch(/PDF/);
  });

  it("si el cierre revienta, la corrida queda como 'fallo' y el error real sube igual", async () => {
    saveLiquidacion.mockRejectedValue(new Error('la base no contestó'));
    const r = await cerrar();
    expect(r.success).toBe(false);
    expect(corridas).toHaveLength(1);
    expect(corridas[0]).toMatchObject({ agente: 'liquidacion', estado: 'fallo', disparo: 'whatsapp' });
  });

  it('registrar la corrida JAMÁS tumba el cierre (estándar §7): con la bitácora caída, el cierre sale ok', async () => {
    corridaError = { message: 'no hay bitácora' };
    const r = await cerrar();
    expect(r.success, r.error).toBe(true);
    expect(logs.error).toHaveBeenCalledWith('corridas.no_registrada',
      expect.objectContaining({ agente: 'liquidacion' }));
  });
});
