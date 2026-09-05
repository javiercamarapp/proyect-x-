// Ajuste firmado: publicar ambos PDF bajo una versión inmutable con CAS (0346).
// El fallo del papel no revierte cifras ni firma; el puntero permanece pendiente.

import { supabaseAdmin } from '@/lib/supabase/admin';
import { acotada } from './presupuesto';
import { getGastos, getViaje, getOperador } from './repo';
import { cuadrarDesdeDB } from './cuadre/desde_db';
import { generarLiquidacionPDF } from './liquidacion/pdf';
import { getDatosFiscales } from '@/lib/saas/fiscal';
import { rutasPdfVersionadas, rutaPdfOperador } from './liquidacion/rutas_pdf';
import { logger } from '@/lib/logger';
import type { Gasto, Liquidacion } from '@/types/likida';

export interface AjustePedido { gastoId: string; montoNuevo: number }

/** Lo que `p_recalculo` de `revisar_liquidacion` (mig. 0306) espera, en el
 *  mismo `camelCase` que el resto de este módulo — se serializa a JSON tal
 *  cual al llamar la RPC. */
export interface RecalculoAjuste {
  totalComprobado: number;
  diferencia: number;
  estatus: string;
  diferencias: unknown[];
  iepsAcreditable: number;
  litrosDieselAcreditables: number;
  ivaAcreditable: number;
  peajeAcreditable: number;
}

export interface ResultadoRecalculo {
  recalculo: RecalculoAjuste;
  /** El cuadre completo — lo necesita `regenerarPdfTrasAjuste` para imprimir. */
  cuadre: Omit<Liquidacion, 'id' | 'creadaEn'>;
}

/**
 * Vuelve a correr el motor sobre los gastos VIVOS del viaje, con los ajustes
 * pedidos ya aplicados en memoria — nada se escribe en la base.
 *
 * Lanza si el viaje no existe o si alguno de los `ajustes` no corresponde a
 * un comprobante real del viaje: la RPC ya lo iba a rechazar (LR017), mejor
 * fallar aquí que gastar el recálculo completo del motor para nada.
 */
export async function recalcularParaAjuste(
  tenantId: string,
  viajeId: string,
  ajustes: AjustePedido[],
): Promise<ResultadoRecalculo> {
  const gastos = await getGastos(viajeId, tenantId);
  const porId = new Map(gastos.map((g) => [g.id, g]));
  for (const a of ajustes) {
    if (!porId.has(a.gastoId)) {
      throw new Error(`recalcularParaAjuste: el comprobante ${a.gastoId} no es de este viaje`);
    }
  }
  const nuevos = new Map(ajustes.map((a) => [a.gastoId, a.montoNuevo]));
  const gastosAjustados: Gasto[] = gastos.map((g) => (
    nuevos.has(g.id) ? { ...g, monto: nuevos.get(g.id)! } : g
  ));
  const cuadre = await cuadrarDesdeDB(tenantId, viajeId, gastosAjustados);
  return {
    cuadre,
    recalculo: {
      totalComprobado: cuadre.totalComprobado,
      diferencia: cuadre.diferencia,
      estatus: cuadre.estatus,
      diferencias: cuadre.diferencias,
      iepsAcreditable: cuadre.iepsAcreditable,
      litrosDieselAcreditables: cuadre.litrosDieselAcreditables ?? 0,
      ivaAcreditable: cuadre.ivaAcreditable,
      peajeAcreditable: cuadre.peajeAcreditable,
    },
  };
}

const BUCKET = 'liquidaciones';

export function cifrasPdf(cuadre: Omit<Liquidacion, 'id' | 'creadaEn'>) {
  return {
    totalComprobado: cuadre.totalComprobado, totalAnticipo: cuadre.totalAnticipo,
    diferencia: cuadre.diferencia, estatus: cuadre.estatus, diferencias: cuadre.diferencias,
    iepsAcreditable: cuadre.iepsAcreditable, litrosDieselAcreditables: cuadre.litrosDieselAcreditables ?? 0,
    ivaAcreditable: cuadre.ivaAcreditable, peajeAcreditable: cuadre.peajeAcreditable,
  };
}

async function filaPdf(tenantId: string, liquidacionId: string) {
  const { data, error } = await acotada(supabaseAdmin().from('liquidacion')
    .select('id,viaje_id,pdf_url,pdf_versionada,revision,revisada_en,revisada_por_email,total_comprobado,total_anticipo,diferencia,estatus,diferencias,ieps_acreditable,litros_diesel_acreditables,iva_acreditable,peaje_acreditable')
    .eq('tenant_id', tenantId).eq('id', liquidacionId).maybeSingle(), 'revision.pdf_fila');
  if (error || !data) throw new Error('No se pudo leer la liquidación para conservar/publicar sus PDF');
  return data;
}

/** Antes de la firma: congelar el legacy. Un writer viejo ya no puede publicar
 * una ruta canónica en esta fila (0346), ni sobrescribir estos objetos nuevos. */
export async function conservarPdfAntesDeAjuste(tenantId: string, liquidacionId: string): Promise<void> {
  const f = await filaPdf(tenantId, liquidacionId);
  if (!f.pdf_url || f.pdf_versionada) return;
  const viajeId = String(f.viaje_id);
  const paths = rutasPdfVersionadas(tenantId, viajeId);
  const storage = supabaseAdmin().storage.from(BUCKET);
  const copies = await Promise.all([
    acotada(storage.copy(String(f.pdf_url), paths.contralor), 'revision.legacy_contralor'),
    acotada(storage.copy(rutaPdfOperador(String(f.pdf_url), tenantId, viajeId), paths.operador), 'revision.legacy_operador'),
  ]);
  if (copies.some((r) => r.error)) throw new Error('No se pudieron conservar ambos PDF anteriores; el ajuste no se aplicó. Reintenta.');
  const { data, error } = await acotada(supabaseAdmin().rpc('publicar_pdf_liquidacion', {
    p_tenant: tenantId, p_liquidacion: liquidacionId, p_viaje: viajeId,
    p_revision: f.revision, p_revisada_en: f.revisada_en, p_anterior: f.pdf_url, p_pdf: paths.contralor,
    p_cifras: {
      totalComprobado: Number(f.total_comprobado), totalAnticipo: Number(f.total_anticipo), diferencia: Number(f.diferencia),
      estatus: f.estatus, diferencias: f.diferencias, iepsAcreditable: Number(f.ieps_acreditable),
      litrosDieselAcreditables: Number(f.litros_diesel_acreditables ?? 0), ivaAcreditable: Number(f.iva_acreditable), peajeAcreditable: Number(f.peaje_acreditable),
    },
  }), 'revision.conservar_legacy');
  if (error || data !== true) throw new Error('La liquidación cambió o no se pudo conservar su PDF anterior; el ajuste no se aplicó. Reintenta.');
}

async function subir(path: string, bytes: Uint8Array): Promise<boolean> {
  const { error } = await acotada(supabaseAdmin().storage.from(BUCKET).upload(path, Buffer.from(bytes), {
    contentType: 'application/pdf', upsert: false,
  }), 'revision.pdf_subir');
  if (error) logger.warn('revision_recalculo.pdf_upload', { path, err: error.message });
  return !error;
}

/** Publica una pareja completa sólo si siguen vigentes firma y cifras. */
export async function regenerarPdfTrasAjuste(
  tenantId: string, viajeId: string, liquidacionId: string,
  cuadre: Omit<Liquidacion, 'id' | 'creadaEn'>, revisadaPor: string, revisadaEn: string,
): Promise<{ regenerado: boolean }> {
  try {
    const [viaje, razon] = await Promise.all([
      getViaje(viajeId, tenantId),
      getDatosFiscales(tenantId).then((d) => d?.razonSocial ?? undefined).catch(() => undefined),
    ]);
    if (!viaje) return { regenerado: false };
    const operador = viaje.operadorId ? await getOperador(viaje.operadorId, tenantId) : null;
    if (!operador) return { regenerado: false };
    const full: Liquidacion = { ...cuadre, id: liquidacionId, creadaEn: new Date().toISOString(), revision: 'ajustada', revisadaPor, revisadaEn };
    const paths = rutasPdfVersionadas(tenantId, viajeId);
    const uploads = await Promise.all([
      generarLiquidacionPDF(full, viaje, operador, razon, 'contralor').then((b) => subir(paths.contralor, b)),
      generarLiquidacionPDF(full, viaje, operador, razon, 'operador').then((b) => subir(paths.operador, b)),
    ]);
    if (!uploads.every(Boolean)) return { regenerado: false };
    const { data, error } = await acotada(supabaseAdmin().rpc('publicar_pdf_liquidacion', {
      p_tenant: tenantId, p_liquidacion: liquidacionId, p_viaje: viajeId,
      p_revision: 'ajustada', p_revisada_en: revisadaEn, p_anterior: null,
      p_pdf: paths.contralor, p_cifras: cifrasPdf(cuadre),
    }), 'revision.publicar_pdf');
    if (error || data !== true) {
      logger.warn('revision_recalculo.publicacion_rechazada', { tenantId, liquidacionId, error: error?.message ?? 'revisión o cifras cambiaron' });
      return { regenerado: false };
    }
    return { regenerado: true };
  } catch (error) {
    logger.error('revision_recalculo.pdf_gen', { tenantId, viajeId, liquidacionId, err: error instanceof Error ? error.message : String(error) });
    return { regenerado: false };
  }
}

/** Reintenta sólo el papel. La RPC vuelve a comparar el cuadre reconstruido
 * con las cifras firmadas; no ajusta, no firma otra vez y no toca el dinero. */
export async function reintentarPdfAjustado(tenantId: string, liquidacionId: string): Promise<{ regenerado: boolean }> {
  const f = await filaPdf(tenantId, liquidacionId);
  if (f.revision !== 'ajustada' || !f.revisada_en) throw new Error('Esta liquidación no tiene un ajuste firmado pendiente de PDF');
  if (f.pdf_url) return { regenerado: true };
  const cuadre = await cuadrarDesdeDB(tenantId, String(f.viaje_id));
  return regenerarPdfTrasAjuste(tenantId, String(f.viaje_id), liquidacionId, cuadre,
    String(f.revisada_por_email ?? 'Responsable de la flota'), String(f.revisada_en));
}
