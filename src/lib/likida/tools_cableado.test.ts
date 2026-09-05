import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./liquidacion/rutas_pdf', async (original) => ({
  ...await original<typeof import('./liquidacion/rutas_pdf')>(),
  rutasPdfVersionadas: (tenant: string, viaje: string) => ({
    contralor: `${tenant}/${viaje}-version-00000000-0000-4000-8000-000000000046.pdf`,
    operador: `${tenant}/${viaje}-version-00000000-0000-4000-8000-000000000046-operador.pdf`,
  }),
}));
// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 5 · ALTO REINCIDENTE — el arreglo de la ronda 4 quedó anclado en la
// función y no en el cableado.
//
// La ronda 4 encontró que `sendDocument(msg.from, …)` le mandaba al chofer un PDF
// con los veredictos que `resumen.ts` le oculta en el texto (EFOS, CFDI
// cancelado, RFC receptor). Se arregló generando DOS ejemplares, y
// `pdf.test.ts:131-158` prueba muy bien que `generarLiquidacionPDF(…, 'operador')`
// filtra y `'contralor'` no.
//
// MUTACIÓN M19 (`tools.ts:139`): el auditor cambió el argumento en el ÚNICO sitio
// que elige el destinatario —
//
//     - generarLiquidacionPDF(full, v, o, undefined, 'operador')
//     + generarLiquidacionPDF(full, v, o, undefined, 'contralor')
//
// — y las 628 pruebas siguieron verdes. El hallazgo ALTO de la ronda anterior
// vuelve a estar vivo sin que nada falle, porque `tools.ts` no lo ejecuta ninguna
// prueba: los dos tests del processor hacen `vi.mock('@/lib/likida/tools', …)`.
//
// La regla del rubro: un arreglo histórico está anclado cuando su prueba FALLA si
// alguien lo revierte. Aquella se probó un nivel más abajo del que tenía el bug.
//
// Por eso aquí el PDF se genera DE VERDAD (nada de espiar el argumento: espiar el
// argumento vuelve a probar la intención y no el resultado) y se lee el texto de
// los bytes que se suben a storage, cada uno en su ruta.
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import type { Liquidacion, Viaje, Operador } from '@/types/likida';

// El cuadre que el cierre va a imprimir. Trae un veredicto SOLO-CONTRALOR (EFOS)
// y uno que el operador SÍ puede arreglar (el XML del complemento): el primero
// tiene que faltar en su ejemplar y el segundo tiene que estar.
const LIQ: Omit<Liquidacion, 'id' | 'creadaEn'> = {
  viajeId: 'v1', totalComprobado: 8000, totalAnticipo: 8000, diferencia: 0, estatus: 'revisar',
  totalDeducible: 0, totalNoDeducible: 8000, totalPorConfirmar: 0,
  iepsAcreditable: 0, litrosDieselAcreditables: 0, ivaAcreditable: 0, peajeAcreditable: 0,
  gastos: [{ id: 'g1', concepto: 'diesel', monto: 8000, folio: 'A1', fecha: '2026-05-01', cfdiUuid: 'u1' }],
  diferencias: [
    { tipo: 'cfdi_efos', concepto: 'diesel', monto: 8000, gastoId: 'g1',
      nota: 'El emisor del CFDI de Diésel está en lista negra del SAT (EFOS) — no deducible.' },
    { tipo: 'complemento_no_verificable', concepto: 'diesel', monto: 0, gastoId: 'g1',
      nota: 'La factura de Diésel es de combustible: reenvía el XML para verificar el complemento.' },
  ],
};

const VIAJE: Viaje = { id: 'v1', folio: 'VJ-1', origen: 'Mérida', destino: 'Cancún', anticipo: 8000 };
const OPERADOR: Operador = { id: 'o1', nombre: 'Juan Pérez', telefono: '5219993700779', terminal: 'Mérida' };

/** Lo que se subió a storage, por ruta. El PDF es real. */
const subidos = new Map<string, Uint8Array>();
const saveLiquidacion = vi.fn(async () => 'liq-1');
/** Rutas que el `upload` de storage debe fallar en la prueba de arriba. */
const fallaEnRuta = new Set<string>();

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// El kill switch (0110): sin este mock corre el REAL, que falla CERRADO contra
// el supabase de mentira de abajo (solo tiene storage) y el cierre se niega por
// una razón distinta de la que estas pruebas miden. Su comportamiento se prueba
// en tools_apagado.test.ts; aquí queda ENCENDIDO.
vi.mock('./interruptores', () => ({ estaApagado: vi.fn(async () => false) }));
// La bitácora de corridas (0115) se anota best-effort al cerrar; aquí solo se
// registra que se llamó — lo que mide es tools_apagado.test.ts.
vi.mock('./agentes/corridas', () => ({ registrarCorrida: vi.fn(async () => {}) }));
vi.mock('./cuadre/desde_db', () => ({ cuadrarDesdeDB: vi.fn(async () => LIQ) }));
vi.mock('./config', () => ({ getConfig: vi.fn(async () => ({ politica: [] })) }));
vi.mock('./repo', () => ({
  getViaje: vi.fn(async () => VIAJE),
  getOperador: vi.fn(async () => OPERADOR),
  saveLiquidacion,
  leerSnapshotInsumosCierre: vi.fn(async () => ({ version: 1, hash: 'a'.repeat(64) })),
  insumosDeCierreCambiaron: vi.fn(() => false),
  getAcumuladoCombustible: vi.fn(async () => { throw new Error('sin base en pruebas'); }),
}));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    storage: {
      from: () => ({
        upload: async (path: string, buf: Buffer) => {
          if (fallaEnRuta.has(path)) return { error: { message: 'storage caído' } };
          subidos.set(path, new Uint8Array(buf));
          return { error: null };
        },
      }),
    },
  }),
}));

// Importar `tools.ts` REGISTRA las tools. `executeTool` es la única puerta.
await import('./tools');
const { executeTool } = await import('@/lib/llm/tool-executor');

/** Texto imprimible del PDF: infla los streams y junta lo que va a `Tj`. */
async function textoDelPdf(bytes: Uint8Array): Promise<string> {
  const { inflateSync } = await import('node:zlib');
  const buf = Buffer.from(bytes);
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x73 && buf.subarray(i, i + 6).toString('latin1') === 'stream') {
      let ini = i + 6;
      while (buf[ini] === 0x0d || buf[ini] === 0x0a) ini++;
      const fin = buf.indexOf(Buffer.from('endstream'), ini);
      if (fin < 0) continue;
      try { out += inflateSync(buf.subarray(ini, fin)).toString('latin1'); } catch { /* no comprimido */ }
      i = fin;
    }
  }
  return out.replace(/<([0-9A-Fa-f]+)>\s*Tj/g, (_m, hex: string) =>
    Buffer.from(hex, 'hex').toString('latin1'));
}

// DAT-22: el cierre exige que el operador lo haya pedido EN ESTE TURNO
// (`cierrePedidoPorTexto`, que el processor calcula con `pidioCerrar`). Estos
// archivos prueban otras cosas del cierre, así que dan por hecho el escenario
// normal —el chofer escribió "listo"— y el candado propio se prueba en
// `tools_cierre_pedido.test.ts`.
const CTX = { tenantId: 't1', viajeId: 'v1', operadorId: 'o1', telefono: '5219993700779', cierrePedidoPorTexto: true };
const cerrar = () => executeTool('guardar_liquidacion', {}, { ...CTX, runId: randomUUID() });

beforeEach(() => { subidos.clear(); fallaEnRuta.clear(); saveLiquidacion.mockClear(); });

describe('guardar_liquidacion — el cierre genera DOS ejemplares y cada uno es el suyo', () => {
  it('sube el ejemplar del contralor y el del operador, en rutas distintas', async () => {
    const r = await cerrar();
    expect(r.success, r.error).toBe(true);
    expect([...subidos.keys()].sort()).toEqual(['t1/v1-version-00000000-0000-4000-8000-000000000046-operador.pdf', 't1/v1-version-00000000-0000-4000-8000-000000000046.pdf']);
  });

  // CONTROL de la de abajo: si el PDF del contralor no trajera el veredicto, la
  // prueba del operador pasaría por vacío.
  it('el ejemplar del CONTRALOR trae el veredicto fiscal completo', async () => {
    await cerrar();
    expect(await textoDelPdf(subidos.get('t1/v1-version-00000000-0000-4000-8000-000000000046.pdf')!)).toMatch(/lista negra|EFOS/);
  });

  // MUTACIÓN M19. Con `'contralor'` en la línea del ejemplar del operador, el
  // chofer recibe por WhatsApp un PDF que dice que su proveedor está en la lista
  // negra del SAT — algo que él no puede arreglar, que lo señala, y que puede
  // reenviar. Es el hallazgo ALTO de la ronda 4, resucitado.
  it('el ejemplar del OPERADOR no trae lo que él no puede arreglar (M19)', async () => {
    await cerrar();
    expect(await textoDelPdf(subidos.get('t1/v1-version-00000000-0000-4000-8000-000000000046-operador.pdf')!)).not.toMatch(/lista negra|EFOS/);
  });

  // El otro lado del filtro: sin esto, "arreglar" M19 generando un PDF vacío para
  // el operador dejaría la prueba de arriba verde y al chofer sin su papel.
  it('pero SÍ trae lo que él puede arreglar y su liquidación completa', async () => {
    await cerrar();
    const t = await textoDelPdf(subidos.get('t1/v1-version-00000000-0000-4000-8000-000000000046-operador.pdf')!);
    expect(t).toMatch(/XML/);
    expect(t).toMatch(/Juan/);
    expect(t).toMatch(/Total comprobado/);
  });

  it('en `liquidacion.pdf_path` se guarda el ejemplar del CONTRALOR, que es el registro', async () => {
    await cerrar();
    // El 4º argumento es el conteo de comprobantes que la 0158 compara dentro
    // del candado del viaje (DAT-02); el 5º sella los insumos bajo el candado.
    expect(saveLiquidacion).toHaveBeenCalledWith(
      't1', LIQ, 't1/v1-version-00000000-0000-4000-8000-000000000046.pdf', LIQ.gastos.length,
      { version: 1, hash: 'a'.repeat(64) },
    );
  });

  it('el resultado declara que el PDF del operador se generó (de eso depende el envío)', async () => {
    const r = await cerrar();
    expect((r.result as { pdf_generado: boolean }).pdf_generado).toBe(true);
  });

  // AUDITORÍA 8/9, MEDIO REINCIDENTE — `pdf_generado` solo reflejaba el
  // ejemplar del OPERADOR. El del CONTRALOR —quien decide la compra, y cuyo
  // ejemplar es el que queda en `liquidacion.pdf_path` y el botón de descarga
  // del panel— podía fallar sin que el resultado de la tool dijera nada
  // distinto del camino feliz.
  it('el resultado declara POR SEPARADO si el PDF del contralor se generó', async () => {
    const r = await cerrar();
    expect((r.result as { pdf_contralor_generado: boolean }).pdf_contralor_generado).toBe(true);
  });

  it('si falla el contralor, ninguna mitad queda publicada como pareja', async () => {
    fallaEnRuta.add('t1/v1-version-00000000-0000-4000-8000-000000000046.pdf'); // el del contralor; el del operador es 't1/v1-version-00000000-0000-4000-8000-000000000046-operador.pdf'
    const r = await cerrar();
    const res = r.result as { pdf_generado: boolean; pdf_contralor_generado: boolean };
    expect(res.pdf_contralor_generado, 'el del contralor falló y el campo tiene que decirlo').toBe(false);
    expect(res.pdf_generado, 'la mitad subida no queda publicada para entrega').toBe(false);
  });
});
