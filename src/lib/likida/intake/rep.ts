// ═══════════════════════════════════════════════════════════════════════════
// EL REP — Recibo Electrónico de Pagos (CFDI TipoDeComprobante = P) — que
// nadie ingería (Plan maestro 26-ago, Fase 7).
//
// `engine.ts` excluye el IVA de un CFDI con FormaPago 99 (LIVA 5-III:
// "efectivamente pagado en el mes") y promete que se acreditará "el mes en
// que se pague (con su complemento de pago)". Este módulo es ese complemento:
// parsea el nodo `pago20:Pagos` v2.0, registra cada DoctoRelacionado en
// `cfdi_pago`, y sella `gasto.pagado_en` en el CFDI que el pago liquida.
//
// ── LA REGLA FAIL-CLOSED DEL SELLO ─────────────────────────────────────────
// El sello SOLO se escribe cuando el docto quedó TOTALMENTE pagado
// (ImpSaldoInsoluto = 0 en este pago). Un pago en parcialidades acredita el
// IVA proporcionalmente POR PAGO (LIVA 5-III), y ese reparto no se automatiza
// aquí: la fila queda en `cfdi_pago` (el dato no se pierde) y el gasto sigue
// sin sellar — el motor lo sigue excluyendo, que es el comportamiento de
// siempre. El REP solo ABRE; jamás se infiere un pago.
//
// ── ESTRUCTURA VERIFICADA CONTRA EL XSD OFICIAL ────────────────────────────
// http://www.sat.gob.mx/sitio_internet/cfd/Pagos/Pagos20.xsd (consultado
// 26-ago-2026): raíz `Pagos` (ns http://www.sat.gob.mx/Pagos20), `Pago+` con
// FechaPago/FormaDePagoP/MonedaP/Monto; `DoctoRelacionado+` con IdDocumento,
// NumParcialidad, ImpSaldoAnt, ImpPagado, ImpSaldoInsoluto (todos
// requeridos); `ImpuestosDR/TrasladosDR/TrasladoDR` con BaseDR, ImpuestoDR,
// ImporteDR (ImporteDR es CONDICIONAL — puede no venir, y entonces
// `ivaPagado` queda null: no se recalcula con una tasa asumida).
// ═══════════════════════════════════════════════════════════════════════════

import { XMLParser } from 'fast-xml-parser';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { acotada } from '../presupuesto';
import { saveCfdiXmlRaw } from '../repo';
import { formaPagoSat } from './cfdi_xml';

export interface RepDoctoRelacionado {
  /** UUID (minúsculas) del CFDI PPD que este pago liquida. */
  idDocumento: string;
  impPagado: number;
  /** `undefined` = el atributo no se pudo leer como número (defensivo — el
   *  XSD lo marca requerido, pero un REP mal formado no debe tirar la
   *  ingesta entera). Sin él, el sello NO se escribe. */
  impSaldoInsoluto?: number;
  numParcialidad?: number;
  /** IVA trasladado del docto EN ESTE PAGO (TrasladoDR 002 ImporteDR).
   *  `undefined` = el REP no lo desglosó. */
  ivaPagado?: number;
}

export interface RepPago {
  /** ISO de `FechaPago` (dateTime completo tal cual del XML). */
  fechaPago: string;
  /** c_FormaPago normalizada (dos dígitos) — el medio con el que DE VERDAD
   *  se pagó, contra el "99 por definir" del CFDI original. */
  formaDePagoP?: string;
  doctos: RepDoctoRelacionado[];
}

export interface RepXmlData {
  /** UUID del REP mismo (su Timbre), minúsculas. */
  uuid: string;
  fecha?: string;
  rfcEmisor?: string;
  pagos: RepPago[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true, // pago20:Pagos → Pagos, cfdi:Comprobante → Comprobante
  isArray: (name) => name === 'Pago' || name === 'DoctoRelacionado' || name === 'TrasladoDR',
  parseAttributeValue: false,
});

function toArr<T>(v: T | T[] | undefined): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

/** La misma normalización que el resto del repo (0158: minúsculas en la
 *  escritura, el índice no compara «con criterio»). Local porque la de
 *  `repo.ts` es privada y este módulo solo maneja UUIDs ya validados. */
function uuidCfdi(u: string): string {
  return u.trim().toLowerCase();
}

const num = (v: unknown): number | undefined => {
  if (v == null) return undefined;
  const n = parseFloat(v as string);
  return Number.isNaN(n) ? undefined : n;
};

/**
 * Parsea un CFDI de Pagos (TipoDeComprobante = P). `null` si el documento no
 * es un REP con al menos un pago legible — el llamador decide qué decirle a
 * quien lo mandó. Demo-safe: nunca lanza.
 */
export function parseRepXml(xml: string): RepXmlData | null {
  try {
    const doc = parser.parse(xml) as Record<string, unknown>;
    if (!doc?.Comprobante || typeof doc.Comprobante !== 'object') return null;
    const comp = doc.Comprobante as Record<string, unknown>;
    if ((comp['@_TipoDeComprobante'] as string) !== 'P') return null;

    const complemento = (comp.Complemento ?? {}) as Record<string, unknown>;
    const tfd = toArr(complemento.TimbreFiscalDigital as Record<string, string>[] | undefined)[0]
      ?? (complemento.TimbreFiscalDigital as Record<string, string> | undefined);
    const uuidRaw = tfd?.['@_UUID'];
    if (!uuidRaw) return null; // sin timbre no hay REP que registrar

    const pagosNode = (complemento.Pagos ?? {}) as Record<string, unknown>;
    const pagosRaw = toArr(pagosNode.Pago as Record<string, unknown>[] | undefined);

    const pagos: RepPago[] = [];
    for (const p of pagosRaw) {
      const fechaPago = (p['@_FechaPago'] as string) || undefined;
      if (!fechaPago) continue; // requerido por el XSD; sin fecha no hay mes que acreditar
      const doctosRaw = toArr(p.DoctoRelacionado as Record<string, unknown>[] | undefined);
      const doctos: RepDoctoRelacionado[] = [];
      for (const d of doctosRaw) {
        const idDoc = (d['@_IdDocumento'] as string) || '';
        // Solo UUIDs: el XSD también admite el formato viejo 003-02-…, que no
        // corresponde a ningún `gasto.cfdi_uuid` — se ignora sin fallar.
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idDoc)) continue;
        const impPagado = num(d['@_ImpPagado']);
        if (impPagado == null || impPagado <= 0) continue;
        // IVA de ESTE docto en ESTE pago (ImpuestosDR → TrasladosDR → TrasladoDR 002).
        const trasladosDR = toArr(
          ((d.ImpuestosDR as Record<string, unknown> | undefined)?.TrasladosDR as Record<string, unknown> | undefined)
            ?.TrasladoDR as Record<string, string>[] | undefined,
        );
        let ivaPagado: number | undefined;
        for (const t of trasladosDR) {
          if (t['@_ImpuestoDR'] === '002') {
            const imp = num(t['@_ImporteDR']);
            if (imp != null) ivaPagado = (ivaPagado ?? 0) + imp;
          }
        }
        doctos.push({
          idDocumento: idDoc.toLowerCase(),
          impPagado,
          impSaldoInsoluto: num(d['@_ImpSaldoInsoluto']),
          numParcialidad: num(d['@_NumParcialidad']),
          ivaPagado,
        });
      }
      if (doctos.length > 0) pagos.push({ fechaPago, formaDePagoP: formaPagoSat(p['@_FormaDePagoP'] as string | undefined), doctos });
    }
    if (pagos.length === 0) return null;

    const emisor = (comp.Emisor ?? {}) as Record<string, string>;
    return {
      uuid: uuidRaw.toLowerCase(),
      fecha: (comp['@_Fecha'] as string) || undefined,
      rfcEmisor: (emisor['@_Rfc'] as string)?.toUpperCase() || undefined,
      pagos,
    };
  } catch {
    return null;
  }
}

export interface ResumenIngestaRep {
  /** DoctoRelacionado registrados en `cfdi_pago` (los ya existentes cuentan
   *  como registrados: idempotencia, no error). */
  doctos: number;
  /** Gastos de la flota que este REP encontró por UUID. */
  ligados: number;
  /** Gastos SELLADOS con `pagado_en` (docto totalmente pagado). */
  sellados: number;
  /** Doctos con saldo insoluto > 0: registrados pero SIN sellar (parcialidad). */
  parciales: number;
  /**
   * AUDITORÍA 28 (AG-C1/REN-C1, CRÍTICO): doctos que NO se alcanzaron a
   * procesar porque se acabó `venceEn` a la mitad de un REP con muchos
   * documentos (un consolidado real puede traer cientos). Antes el bucle no
   * miraba el reloj: si la invocación moría a la mitad, los doctos restantes
   * se perdían en silencio y su IVA nunca se liberaba — sin registro, sin
   * aviso, sin reintento. El registro en `cfdi_pago` es idempotente
   * (`ignoreDuplicates`), así que reenviar el MISMO REP más tarde retoma
   * justo donde se cortó, sin duplicar lo ya sellado.
   */
  pendientes: number;
}

/**
 * Ingiere un REP para una flota: conserva el XML (CFF 30), registra cada
 * docto en `cfdi_pago` (idempotente por unique) y sella `pagado_en` en el
 * gasto cuyo `cfdi_uuid` coincide — SOLO si el docto quedó totalmente pagado.
 *
 * El sello no pisa: `pagado_en is null` en el WHERE — el primer REP que
 * liquida por completo manda, un reenvío no reescribe la fecha.
 *
 * `venceEn` (AUDITORÍA 28, AG-C1/REN-C1): timestamp de `Date.now()` a partir
 * del cual esta función deja de arrancar doctos nuevos y devuelve lo que
 * falta en `resumen.pendientes`, en vez de seguir hasta que Vercel mate la
 * invocación a la mitad de un `upsert`/`update`. Sin `venceEn` no hay corte
 * (uso interno/pruebas).
 */
export async function ingerirRep(tenantId: string, rep: RepXmlData, xmlCrudo: string, venceEn?: number): Promise<ResumenIngestaRep> {
  // CFF 30: el REP es un CFDI y se conserva igual que los demás. gasto_id null
  // a propósito — un REP puede liquidar varios gastos.
  await saveCfdiXmlRaw(tenantId, rep.uuid, null, xmlCrudo);

  const resumen: ResumenIngestaRep = { doctos: 0, ligados: 0, sellados: 0, parciales: 0, pendientes: 0 };
  const admin = supabaseAdmin();

  agotarPagos: for (const pago of rep.pagos) {
    const fechaPago = pago.fechaPago.slice(0, 10);
    for (const d of pago.doctos) {
      if (venceEn !== undefined && Date.now() >= venceEn) {
        // No se arrancó ESTE docto ni ninguno después: nada a medias, nada
        // sellado sin registro. `pendientes` cuenta lo que falta en TODOS los
        // pagos restantes, no solo el actual.
        resumen.pendientes += pago.doctos.length - pago.doctos.indexOf(d);
        for (const otro of rep.pagos.slice(rep.pagos.indexOf(pago) + 1)) resumen.pendientes += otro.doctos.length;
        break agotarPagos;
      }
      // Registro idempotente: el mismo (tenant, REP, docto) reenviado no
      // duplica. `ignoreDuplicates` = ON CONFLICT DO NOTHING sobre la unique.
      const { error: errReg } = await acotada(admin.from('cfdi_pago').upsert({
        tenant_id: tenantId,
        cfdi_uuid: uuidCfdi(rep.uuid),
        fecha_pago: fechaPago,
        forma_pago_p: pago.formaDePagoP ?? null,
        docto_relacionado_uuid: uuidCfdi(d.idDocumento),
        imp_pagado: d.impPagado,
        imp_saldo_insoluto: d.impSaldoInsoluto ?? null,
        num_parcialidad: d.numParcialidad ?? null,
        iva_pagado: d.ivaPagado ?? null,
      }, { onConflict: 'tenant_id,cfdi_uuid,docto_relacionado_uuid', ignoreDuplicates: true }), 'rep.registrar');
      if (errReg) {
        // Un docto que no se pudo registrar no tira los demás — pero tampoco
        // se cuenta como registrado ni se intenta sellar su gasto: sellar sin
        // rastro sería un pago sin evidencia.
        logger.error('rep.registro_fallo', { tenant: tenantId, rep: rep.uuid, docto: d.idDocumento, err: errReg.message });
        continue;
      }
      resumen.doctos++;

      // ¿Totalmente pagado? Solo entonces se sella (ver cabecera). Un
      // ImpSaldoInsoluto ilegible NO es cero: defensivo, no se sella.
      const liquidado = d.impSaldoInsoluto != null && d.impSaldoInsoluto === 0;
      if (!liquidado) { resumen.parciales++; continue; }

      const { data: sellados, error: errSello } = await acotada(admin.from('gasto')
        .update({ pagado_en: fechaPago, pagado_forma: pago.formaDePagoP ?? null })
        .eq('tenant_id', tenantId)
        .eq('cfdi_uuid', uuidCfdi(d.idDocumento))
        .is('pagado_en', null)
        .select('id'), 'rep.sellar');
      if (errSello) {
        logger.error('rep.sello_fallo', { tenant: tenantId, docto: d.idDocumento, err: errSello.message });
        continue;
      }
      const n = (sellados ?? []).length;
      if (n > 0) { resumen.ligados += n; resumen.sellados += n; }
      else {
        // Sin gasto que sellar: o el CFDI PPD aún no está en la base (el REP
        // llegó antes que la factura — el registro en cfdi_pago queda y un
        // cruce futuro lo puede aplicar), o ya estaba sellado (reenvío).
        const { data: existentes } = await acotada(admin.from('gasto').select('id')
          .eq('tenant_id', tenantId).eq('cfdi_uuid', uuidCfdi(d.idDocumento)).limit(1), 'rep.buscarGasto');
        if ((existentes ?? []).length > 0) resumen.ligados++;
      }
    }
  }
  logger.info('rep.ingerido', { tenant: tenantId, rep: rep.uuid, ...resumen });
  return resumen;
}

/** El acuse por WhatsApp — dice exactamente qué pasó, sin prometer de más. */
export function mensajeRepRecibido(r: ResumenIngestaRep): string {
  const partes = [`Recibí el complemento de pago ✅ (${r.doctos} documento${r.doctos === 1 ? '' : 's'} de pago registrado${r.doctos === 1 ? '' : 's'}).`];
  if (r.sellados > 0) {
    partes.push(`${r.sellados} factura${r.sellados === 1 ? ' quedó marcada' : 's quedaron marcadas'} como pagada${r.sellados === 1 ? '' : 's'}: su IVA se acredita en el mes del pago (LIVA 5-III).`);
  }
  if (r.parciales > 0) {
    partes.push(`${r.parciales} con saldo pendiente: el IVA se libera hasta la última parcialidad.`);
  }
  if (r.sellados === 0 && r.parciales === 0 && r.pendientes === 0) {
    partes.push('No encontré facturas de esta flota que ese pago liquide — si la factura llega después, el pago ya quedó registrado.');
  }
  if (r.pendientes > 0) {
    // AUDITORÍA 28 (AG-C1/REN-C1): el complemento traía más documentos de los
    // que dio tiempo de procesar en esta invocación. Registrar es idempotente
    // (`ignoreDuplicates`), así que reenviar EL MISMO complemento retoma
    // justo donde se cortó — no hay que fabricar uno nuevo.
    partes.push(`${r.pendientes} documento${r.pendientes === 1 ? '' : 's'} de este complemento no me dio tiempo de procesar — reenvía el mismo complemento para que termine.`);
  }
  return partes.join(' ');
}
