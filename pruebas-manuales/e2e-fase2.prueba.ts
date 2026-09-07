// TEMPORAL — fase 2 e2e: siembra, alta de gastos, cierre, casos feos. Se borra.
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';

for (const l of readFileSync('.env.local', 'utf8').split('\n')) {
  const i = l.indexOf('=');
  if (i > 0 && !l.startsWith('#')) process.env[l.slice(0, i)] ||= l.slice(i + 1).split('#')[0].trim();
}
// NO SE MANDA WHATSAPP: sin token, `enviarTexto` falla y el camino lo traga.
process.env.WHATSAPP_ACCESS_TOKEN = '';
process.env.WHATSAPP_PHONE_NUMBER_ID = '';
delete process.env.FACTURACION_MODO;

const OUT = process.env.E2E_OUT!;
const DIR = process.env.E2E_DIR!;

describe('fase 2 · siembra + alta + cierre', () => {
  it('corre', async () => {
    const { crearFlota, crearOperador } = await import('@/lib/likida/administracion');
    const { guardarDatosFiscales, getDatosFiscales } = await import('@/lib/saas/fiscal');
    const { crearViaje, crearUnidad } = await import('@/lib/likida/operacion');
    const { addGasto, getGastos, gastoExistePorHash, saveLiquidacion } = await import('@/lib/likida/repo');
    const { subirComprobante } = await import('@/lib/likida/intake/almacen');
    const { decidirFoto } = await import('@/lib/likida/intake/decidir');
    const { decidirAcuse } = await import('@/lib/likida/acuse_ticket');
    const { cuadrarDesdeDB, ventanaDesdeDB } = await import('@/lib/likida/cuadre/desde_db');
    const { getConfig } = await import('@/lib/likida/config');
    const { generarLiquidacionPDF } = await import('@/lib/likida/liquidacion/pdf');
    const { supabaseAdmin } = await import('@/lib/supabase/admin');
    const { estadoDelViaje } = await import('@/lib/likida/consulta_chofer');
    const { randomUUID } = await import('node:crypto');

    const ids: Record<string, unknown> = {};

    // ── 1. SIEMBRA ────────────────────────────────────────────────────────
    const { tenantId } = await crearFlota({ nombre: 'Transportes Prueba E2E SA de CV', rfc: 'CCO8605231N4', ciudad: 'Mérida' });
    ids.tenantId = tenantId;
    console.log('tenant', tenantId);

    await guardarDatosFiscales(tenantId, {
      rfc: 'CCO8605231N4',
      razonSocial: 'TRANSPORTES PRUEBA E2E SA DE CV',
      regimenFiscal: '601',
      codigoPostal: '97000',
      usoCfdi: 'G03',
    });
    console.log('fiscales', JSON.stringify(await getDatosFiscales(tenantId)));

    const operadorId = await crearOperador(tenantId, { nombre: 'Juan Pérez Prueba', telefono: '9991234567', numeroEmpleado: 'E2E-01' });
    ids.operadorId = operadorId;
    const unidadId = await crearUnidad(tenantId, { numeroEconomico: 'E2E-100', placas: 'AAA-111-A', marca: 'Kenworth', modelo: 'T680', anio: 2022 });
    ids.unidadId = unidadId;

    const ANTICIPO = 2500;
    const viajeId = await crearViaje(tenantId, {
      folio: 'V-E2E-001', origen: 'Mérida', destino: 'Cancún',
      fechaInicio: '2026-08-02', anticipo: ANTICIPO, operadorId, unidadId,
    });
    ids.viajeId = viajeId;
    console.log('viaje', viajeId, 'anticipo', ANTICIPO);

    const cfg = await getConfig(tenantId);
    console.log('config.empresa.rfc =', cfg.empresa.rfc, '| topes:', JSON.stringify(cfg.politica));

    // ── 2. ALTA DE LOS GASTOS por el camino real ──────────────────────────
    const ocr = JSON.parse(readFileSync(`${OUT}/ocr.json`, 'utf8')) as Array<Record<string, unknown>>;
    const ventana = await ventanaDesdeDB(tenantId, viajeId);
    console.log('ventana del viaje:', JSON.stringify(ventana));

    const acuses: unknown[] = [];
    const altas: string[] = [];
    for (const r of ocr) {
      const foto = r.foto as string;
      const gasto = r.gasto as Record<string, unknown>;
      const imgHash = r.imgHash as string;
      const dataUrl = `data:image/jpeg;base64,${readFileSync(`${DIR}/${foto}`).toString('base64')}`;

      const yaEsta = await gastoExistePorHash(viajeId, imgHash, tenantId);
      const gastosPrevios = await getGastos(viajeId, tenantId);
      const decision = decidirFoto(r as never, gastosPrevios, ventana);
      const acuse = decidirAcuse({
        montoMxn: gasto.monto as number,
        concepto: gasto.concepto as string,
        fecha: (gasto.fecha as string) ?? null,
        confianza: (gasto.ocrConfianza as number) ?? null,
        deCfdi: Boolean(gasto.cfdiUuid),
        esRepeticion: false,
      });
      acuses.push({ foto, decision, acuse, dedupHash: yaEsta });
      console.log(`${foto}: dedupHash=${yaEsta} decision=${decision.accion} acuse=${acuse.peldano} (${acuse.porque})`);
      if (yaEsta || decision.accion !== 'alta') continue;

      const ruta = await subirComprobante(tenantId, viajeId, imgHash, dataUrl);
      try {
        await addGasto(tenantId, viajeId, { ...gasto, imgHash, imagenUrl: ruta } as never);
        altas.push(gasto.id as string);
      } catch (e) {
        console.log(`  !! addGasto rechazó ${foto}: ${(e as Error).message} code=${(e as { code?: string }).code}`);
      }
    }
    ids.altas = altas;

    // ── 3. VERIFICAR EN LA BASE ───────────────────────────────────────────
    const { data: filas } = await supabaseAdmin().from('gasto').select('*').eq('viaje_id', viajeId);
    writeFileSync(`${OUT}/gastos_db.json`, JSON.stringify(filas, null, 2));
    console.log(`\nGASTOS EN BASE: ${filas?.length}`);
    for (const f of (filas ?? []) as Array<Record<string, unknown>>) {
      console.log(`  ${f.concepto} $${f.monto} fecha=${f.fecha} folio=${f.folio} conf=${f.ocr_confianza} img=${f.imagen_url ? 'sí' : 'NO'} hash=${f.img_hash ? 'sí' : 'NO'} extra=${f.ocr_extra ? Object.keys(f.ocr_extra as object).length + ' campos' : 'NULL'} raw=${f.ocr_raw ?? 'null'}`);
    }

    // ── 4. CONSULTA "¿cuánto llevo?" ──────────────────────────────────────
    const estado = await estadoDelViaje(tenantId, viajeId);
    console.log('\nESTADO (¿cuánto llevo?):', JSON.stringify(estado));

    // ── 5. CIERRE ─────────────────────────────────────────────────────────
    const liq = await cuadrarDesdeDB(tenantId, viajeId);
    writeFileSync(`${OUT}/liquidacion.json`, JSON.stringify(liq, null, 2));
    console.log('\n═══ LIQUIDACIÓN ═══');
    console.log('comprobado', liq.totalComprobado, '| anticipo', liq.totalAnticipo, '| diferencia', liq.diferencia, '| estatus', liq.estatus);
    console.log('deducible', liq.totalDeducible, '| no deducible', liq.totalNoDeducible, '| por confirmar', liq.totalPorConfirmar);
    console.log('IVA acred', liq.ivaAcreditable, '| peaje', liq.peajeAcreditable, '| litros diésel', liq.litrosDieselAcreditables);
    console.log(`observaciones (${liq.diferencias?.length ?? 0}):`);
    for (const d of liq.diferencias ?? []) console.log(`  · [${d.tipo}] ${d.nota ?? ''}`);

    const full = { ...liq, id: randomUUID(), creadaEn: new Date().toISOString() };
    const viaje = { id: viajeId, anticipo: ANTICIPO };
    const op = { id: operadorId, nombre: 'Juan Pérez Prueba', telefono: '5219991234567' };
    let pdfPath: string | undefined;
    try {
      const bytes = await generarLiquidacionPDF(full as never, viaje as never, op as never, undefined, 'contralor');
      const up = await supabaseAdmin().storage.from('liquidaciones').upload(`${tenantId}/${viajeId}.pdf`, Buffer.from(bytes), { contentType: 'application/pdf', upsert: true });
      pdfPath = up.error ? undefined : `${tenantId}/${viajeId}.pdf`;
      writeFileSync(`${OUT}/liquidacion.pdf`, Buffer.from(bytes));
      console.log('PDF contralor:', bytes.length, 'bytes | subido:', pdfPath ?? `FALLÓ ${up.error?.message}`);
      const bytesOp = await generarLiquidacionPDF(full as never, viaje as never, op as never, undefined, 'operador');
      writeFileSync(`${OUT}/liquidacion-operador.pdf`, Buffer.from(bytesOp));
      console.log('PDF operador:', bytesOp.length, 'bytes');
    } catch (e) {
      console.log('PDF FALLÓ:', (e as Error).message);
    }
    const liqId = await saveLiquidacion(tenantId, liq, pdfPath);
    ids.liquidacionId = liqId;
    const { data: vFinal } = await supabaseAdmin().from('viaje').select('estatus').eq('id', viajeId).single();
    console.log('viaje tras cierre:', JSON.stringify(vFinal), '| liquidacion', liqId);

    writeFileSync(`${OUT}/ids.json`, JSON.stringify(ids, null, 2));
    writeFileSync(`${OUT}/acuses.json`, JSON.stringify(acuses, null, 2));
    expect(tenantId).toBeTruthy();
  }, 600_000);
});
