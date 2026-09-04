import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Gasto, Liquidacion } from '@/types/likida';

// ═══════════════════════════════════════════════════════════════════════════
// LA ESCRITURA DEL DINERO NO TENÍA UN SOLO TEST.
//
// El cálculo está probado a fondo —el motor tiene cientos de casos—, pero
// `addGasto` y `saveLiquidacion`, que son las funciones que de verdad meten el
// dinero en la base, no tenían ninguno. Y son mapeos a mano de camelCase a
// snake_case con ~25 campos cada uno: si uno se escribe mal, el dato se guarda
// como NULL y nadie se entera hasta que el contralor ve un cero.
//
// Lo que se prueba aquí NO es Supabase, es el MAPEO: que cada campo del dominio
// llegue a su columna, y que el 0 y el false no se conviertan en NULL, que es el
// error clásico de `??` mal puesto (`||` lo haría) y el que más caro sale.
// ═══════════════════════════════════════════════════════════════════════════
const insert = vi.fn();
const rpc = vi.fn();
const from = vi.fn(() => ({ insert }));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ from: (...a: unknown[]) => from(...(a as [])), rpc: (...a: unknown[]) => rpc(...a) }),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const {
  addGasto, saveLiquidacion, conteoDeGastosCambio, insumosDeCierreCambiaron,
  leerSnapshotInsumosCierre,
} = await import('./repo');

describe('addGasto — el mapeo a columnas', () => {
  beforeEach(() => { insert.mockReset(); insert.mockResolvedValue({ error: null }); from.mockClear(); });

  const gasto: Gasto = {
    id: 'g1', concepto: 'diesel', monto: 4812.5, fecha: '2026-05-01', folio: 'A-1',
    rfcEmisor: 'XAXX010101000', cfdiUuid: 'u-1', ocrConfianza: 0.93,
    formaPago: '04', subTotal: 4148.71, iepsTraslado: 900, ivaTraslado: 663.79,
    xmlVerificado: true, claveProdServ: '15101514',
  };

  it('escribe en la tabla `gasto` con tenant y viaje', async () => {
    await addGasto('t1', 'v1', gasto);
    expect(from).toHaveBeenCalledWith('gasto');
    expect(insert.mock.calls[0][0]).toMatchObject({ tenant_id: 't1', viaje_id: 'v1', id: 'g1' });
  });

  it('traduce cada campo del dominio a su columna', async () => {
    await addGasto('t1', 'v1', gasto);
    expect(insert.mock.calls[0][0]).toMatchObject({
      concepto: 'diesel', monto: 4812.5, fecha: '2026-05-01', folio: 'A-1',
      rfc_emisor: 'XAXX010101000', cfdi_uuid: 'u-1', ocr_confianza: 0.93,
      forma_pago: '04', sub_total: 4148.71, ieps_traslado: 900, iva_traslado: 663.79,
      xml_verificado: true, clave_prod_serv: '15101514',
    });
  });

  it('un 0 NO se guarda como NULL', async () => {
    // El error clásico: `g.iepsTraslado || null` convierte el 0 legítimo en NULL.
    // Un IEPS de 0 (no desglosado) y un IEPS ausente son cosas distintas.
    await addGasto('t1', 'v1', { ...gasto, iepsTraslado: 0, ivaTraslado: 0, subTotal: 0 });
    const fila = insert.mock.calls[0][0];
    expect(fila.ieps_traslado).toBe(0);
    expect(fila.iva_traslado).toBe(0);
    expect(fila.sub_total).toBe(0);
  });

  // AUDITORÍA 18 · DAT-26. El SAT imprime el folio fiscal en MAYÚSCULAS y el
  // OCR lo lee en minúsculas: `uq_gasto_cfdi_uuid` es un índice sobre `text`,
  // así que el MISMO comprobante entraba dos veces y su IVA se acreditaba dos
  // veces. Esta prueba era ROJA antes de `uuidCfdi()` — el UUID llegaba tal
  // cual venía — y hoy la 0158 lo hace cumplir con un CHECK en la base.
  it('el UUID del CFDI se guarda SIEMPRE en minúsculas', async () => {
    await addGasto('t1', 'v1', { ...gasto, cfdiUuid: 'AD662D33-6934-459C-A128-BDF0393F0F44' });
    expect(insert.mock.calls[0][0].cfdi_uuid).toBe('ad662d33-6934-459c-a128-bdf0393f0f44');
  });

  it('un UUID de puros espacios es NULL, no una cadena vacía', async () => {
    // Cadena vacía en esa columna la haría participar del índice único: dos
    // tickets sin timbrar chocarían entre sí.
    await addGasto('t1', 'v1', { ...gasto, cfdiUuid: '   ' });
    expect(insert.mock.calls[0][0].cfdi_uuid).toBeNull();
  });

  it('un false NO se guarda como NULL', async () => {
    // `xml_verificado: false` significa "se miró y no está verificado";
    // NULL significa "no se miró". No son lo mismo para el acreditamiento.
    await addGasto('t1', 'v1', { ...gasto, xmlVerificado: false });
    expect(insert.mock.calls[0][0].xml_verificado).toBe(false);
  });

  it('lo ausente sí va como NULL, no como undefined', async () => {
    // `undefined` en un insert de supabase-js se omite de la fila y el DEFAULT
    // de la columna gana en silencio. NULL es explícito.
    await addGasto('t1', 'v1', { id: 'g2', concepto: 'caseta', monto: 100 });
    const fila = insert.mock.calls[0][0];
    for (const c of ['fecha', 'folio', 'rfc_emisor', 'cfdi_uuid', 'forma_pago']) {
      expect(fila[c], `${c} debería ser null explícito`).toBeNull();
    }
  });

  it('un error de la base SÍ se lanza: no se pierde un gasto en silencio', async () => {
    insert.mockResolvedValue({ error: { message: 'boom', code: 'XX000' } });
    await expect(addGasto('t1', 'v1', gasto)).rejects.toThrow(/boom/);
  });
});

describe('saveLiquidacion — el cierre', () => {
  beforeEach(() => { rpc.mockReset(); rpc.mockResolvedValue({ data: 'liq-1', error: null }); });

  // AUDITORÍA 7 · CRÍTICO del rubro de pruebas: `iepsAcreditable` valía 0 y
  // `diferencias` iba vacío, así que aunque se hubieran mirado, un parámetro
  // perdido habría dado el mismo 0 y la prueba no habría dicho nada. Los valores
  // de este fixture son distintos entre sí A PROPÓSITO: así una permutación de
  // parámetros —mandar el IVA donde va el IEPS— también se ve.
  const liq: Omit<Liquidacion, 'id' | 'creadaEn'> = {
    viajeId: 'v1', totalComprobado: 4812.5, totalAnticipo: 5000, diferencia: 187.5,
    estatus: 'cuadrada', totalDeducible: 4812.5, totalNoDeducible: 0, totalPorConfirmar: 0,
    diferencias: [{ tipo: 'efectivo_sobre_tope', nota: 'pago en efectivo de $2,400', monto: 2400 }],
    gastos: [], iepsAcreditable: 1477.35, litrosDieselAcreditables: 255,
    ivaAcreditable: 663.79, peajeAcreditable: 240,
  };

  it('cierra por la RPC transaccional, no con un insert suelto', async () => {
    // El insert de la liquidación y el update del viaje TIENEN que ir en la misma
    // transacción: si el segundo falla, el primero debe revertirse. Por eso es
    // una RPC (mig. 0013) y no dos llamadas desde la app.
    await saveLiquidacion('t1', liq);
    expect(rpc).toHaveBeenCalledWith('guardar_liquidacion_tx', expect.any(Object));
  });

  // AUDITORÍA 7 · CRÍTICO del rubro de pruebas: esto miraba 8 de los 12
  // parámetros que `saveLiquidacion` manda. Los cuatro que faltaban eran
  // `p_diferencias`, `p_ieps`, `p_litros_diesel` y `p_pdf_url` — es decir, las
  // dos cifras FISCALES que el producto vende, el motivo por el que una
  // liquidación no cuadra, y la liga al PDF archivado.
  //
  // Verificado: cambiando `p_litros_diesel` por un `0` fijo en repo.ts, los 255
  // litros de diésel del viaje se perdían al escribirse y las 10 pruebas de este
  // archivo seguían verdes. El acreditamiento del IEPS del cliente sale de ese
  // número.
  //
  // Se listan los 12 a propósito: `toMatchObject` solo mira las llaves que se le
  // nombran, así que la única forma de que un parámetro nuevo no nazca ciego es
  // que estén todos escritos.
  it('manda los DOCE parámetros a su lugar, no solo los totales', async () => {
    await saveLiquidacion('t1', liq, 'tenant-1/v1.pdf');
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_tenant: 't1', p_viaje: 'v1',
      p_total_comprobado: 4812.5, p_total_anticipo: 5000, p_diferencia: 187.5,
      p_estatus: 'cuadrada', p_iva: 663.79, p_peaje: 240,
      p_ieps: 1477.35,
      p_litros_diesel: 255,
      p_diferencias: [{ tipo: 'efectivo_sobre_tope', nota: 'pago en efectivo de $2,400', monto: 2400 }],
      p_pdf_url: 'tenant-1/v1.pdf',
    });
  });

  // AUDITORÍA 18 · DAT-02 + DAT-14. Entre el cuadre (que imprime los PDF) y
  // este guardado pasan segundos, y las fotos entrantes NO toman el mutex del
  // viaje: un ticket que entra ahí queda fuera del papel archivado y huérfano
  // para siempre. La 0158 toma el candado del viaje y compara el conteo; si
  // este parámetro no viaja, la base no puede comparar nada y el hallazgo
  // sigue abierto con la migración aplicada.
  it('manda CUÁNTOS comprobantes traía el cuadre que se está archivando', async () => {
    await saveLiquidacion('t1', liq, 'tenant-1/v1.pdf', 6);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_n_gastos: 6 });
  });

  it('manda hash y versión del snapshot económico/fiscal', async () => {
    const snapshot = { version: 1 as const, hash: 'a'.repeat(64) };
    await saveLiquidacion('t1', liq, 'tenant-1/v1.pdf', 6, snapshot);
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_insumos_hash: snapshot.hash,
      p_insumos_hash_version: 1,
    });
  });

  it('sin conteo, la RPC recibe null explícito: «no compruebes»', async () => {
    await saveLiquidacion('t1', liq);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_n_gastos: null });
  });

  it('el CU003 de la base llega arriba CON su código, no como un error liso', async () => {
    // Sin preservar `code`, `cerrarLiquidacion` no puede distinguir «entró una
    // foto, vuelve a fotografiar» de un fallo cualquiera — y se rendiría en el
    // único caso donde reintentar es lo correcto.
    rpc.mockResolvedValue({ data: null, error: { code: 'CU003', message: 'el viaje tenía 1 y ahora tiene 2' } });
    const e = await saveLiquidacion('t1', liq, undefined, 1).catch((x) => x);
    expect(conteoDeGastosCambio(e)).toBe(true);
    expect(conteoDeGastosCambio(new Error('cualquier otra cosa'))).toBe(false);
  });

  it('CU006 snapshot_changed también conserva el código y habilita un solo recálculo', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'CU006', message: 'snapshot_changed' } });
    const e = await saveLiquidacion('t1', liq, undefined, 1, {
      version: 1, hash: 'b'.repeat(64),
    }).catch((x) => x);
    expect(insumosDeCierreCambiaron(e)).toBe(true);
    expect(insumosDeCierreCambiaron(new Error('otro'))).toBe(false);
  });

  it('valida la forma del snapshot antes de confiar en el RPC', async () => {
    rpc.mockResolvedValueOnce({ data: { version: 1, hash: 'c'.repeat(64) }, error: null });
    await expect(leerSnapshotInsumosCierre('t1', 'v1')).resolves.toEqual({
      version: 1, hash: 'c'.repeat(64),
    });
    expect(rpc).toHaveBeenCalledWith('cierre_insumos_snapshot', { p_tenant: 't1', p_viaje: 'v1' });

    rpc.mockResolvedValueOnce({ data: { version: 1, hash: 'roto' }, error: null });
    await expect(leerSnapshotInsumosCierre('t1', 'v1')).rejects.toThrow(/respuesta inválida/);
  });

  it('sin PDF, la liga va null explícito y no undefined', async () => {
    // `undefined` viaja como ausencia en JSON y la RPC lo recibiría como su
    // default, no como "no hubo PDF".
    await saveLiquidacion('t1', liq);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_pdf_url: null });
  });

  it('devuelve el id que da la RPC', async () => {
    expect(await saveLiquidacion('t1', liq)).toBe('liq-1');
  });

  it('un error de la RPC SÍ se lanza: un cierre perdido no puede pasar callado', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'deadlock detectado' } });
    await expect(saveLiquidacion('t1', liq)).rejects.toThrow(/deadlock/);
  });
});
