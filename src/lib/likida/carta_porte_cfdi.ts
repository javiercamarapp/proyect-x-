// ═══════════════════════════════════════════════════════════════════════════
// EL CFDI TIMBRABLE (0226) — la segunda vía de la Fase D, decidida el
// 27-ago-2026: "sí al PAC".
//
// La vía export (carta_porte_xml.ts) arma un PRE-CFDI con huecos declarados
// para que el facturador de la flota los complete. Esta vía los completa EN
// LIKIDA — con datos CAPTURADOS, jamás supuestos — y produce el CFDI de
// ingreso completo y SIN sellar que el PAC sella (con el CSD de su bóveda) y
// timbra. El complemento Carta Porte es EL MISMO nodo en ambas vías
// (nodoComplementoCcp): un solo constructor, una sola verdad.
//
// LO QUE ESTE MÓDULO CALCULA Y POR QUÉ ES DETERMINISTA:
//   · SubTotal = `viaje.ingreso_flete` — el precio PACTADO capturado en el
//     viaje (0048). Sin ingreso capturado no hay CFDI: el precio del flete
//     jamás se inventa.
//   · IVA trasladado 16% — tasa general vigente (LIVA 1). El autotransporte
//     de carga NO es tasa 0 ni exento.
//   · Retención de IVA del 4% SOLO cuando el receptor es persona MORAL:
//     LIVA 1-A fracción II inciso c) obliga a las morales que reciben
//     servicios de autotransporte terrestre de bienes a retener; la TASA del
//     4% la fija el art. 3, fracción II del Reglamento de la LIVA (RLIVA 3-II,
//     ficha `normas/rliva-3-fr-II.yaml` — NO la regla 3.1.2 de la RMF, que
//     además es de ISR, no de IVA; auditoría 25, MEDIO fiscal, línea 322).
//     Persona moral = RFC de 12 caracteres (las físicas tienen 13) — es
//     estructura del RFC, no una suposición.
//   · Fecha = ahora en hora de México MENOS 2 minutos: el SAT rechaza fechas
//     futuras y los relojes de servidor difieren en segundos; dos minutos
//     atrás siguen dentro de las 72 h que el timbre admite y nunca caen "en
//     el futuro" del PAC.
//   · MetodoPago PPD obliga FormaPago 99 ("Por definir") — regla dura del
//     Anexo 20; con PUE la forma es la real capturada.
//
// PURO: recibe todo leído (perfil del emisor, receptor fiscal, ingreso) y no
// toca red ni base. Quien lee y quien llama al PAC es carta_porte_timbre.ts.
// ═══════════════════════════════════════════════════════════════════════════

import type { ViajeCcp } from './carta_porte_datos';
import { nodoComplementoCcp, escaparXml } from './carta_porte_xml';
import { fechaHoraSat } from '@/lib/formato';

/** Clave del catálogo c_ClaveProdServ para el flete: «Servicio de transporte
 *  de carga por carretera». Es la clave del SERVICIO facturado (no confundir
 *  con c_ClaveProdServCP de las mercancías, que da el cliente). */
const CLAVE_PROD_SERV_FLETE = '78101800';
/** c_ClaveUnidad E48: «Unidad de servicio». */
const CLAVE_UNIDAD_SERVICIO = 'E48';

export interface EmisorFiscal {
  rfc: string | null;
  razonSocial: string | null;
  regimenFiscal: string | null;
  lugarExpedicion: string | null;
  serie: string | null;
  modo: 'sandbox' | 'produccion';
}

export interface ReceptorFiscal {
  rfc: string | null;
  razonSocial: string | null;
  regimenFiscal: string | null;
  usoCfdi: string | null;
  cpFiscal: string | null;
}

export interface ParametrosEmision {
  metodoPago: 'PUE' | 'PPD';
  /** Clave c_FormaPago (01, 03, 99…). Con PPD se fuerza a 99 — regla del
   *  Anexo 20, no una preferencia. */
  formaPago: string;
  /** Hora LOCAL de México para el destino (`YYYY-MM-DDTHH:mm`) o una fecha
   * RFC3339 con offset. Es obligatoria para timbrar; nunca se estima a partir
   * de kilómetros porque eso inventaría un dato fiscal. */
  fechaLlegadaEstimada?: string | null;
}

export type ResultadoCfdi =
  | {
      ok: true;
      xml: string;
      subTotal: number;
      iva: number;
      /** null = receptor persona física: no hay obligación de retener. */
      retencionIva: number | null;
      total: number;
    }
  | { ok: false; faltantes: string[] };

const dinero = (n: number): number => Math.round(n * 100) / 100;
const attr = (n: number): string => n.toFixed(2);

function fechaLlegadaSat(valor: string | null | undefined): string | null {
  const crudo = valor?.trim();
  if (!crudo) return null;
  // eslint-disable-next-line security/detect-unsafe-regex -- formato fijo, sin cuantificadores anidados ni entrada recursiva
  const local = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?$/.exec(crudo);
  if (local) {
    const canonica = `${local[1]}:${local[2] ?? '00'}`;
    // Likida opera en la zona de Mérida/México (UTC-06, sin horario de
    // verano). El round-trip también rechaza 31-feb y horas imposibles.
    const d = new Date(`${canonica}-06:00`);
    return !Number.isNaN(d.getTime()) && fechaHoraSat(d.toISOString()) === canonica ? canonica : null;
  }
  return fechaHoraSat(crudo);
}

/**
 * El CFDI de ingreso COMPLETO y sin sellar, listo para el `issue` del PAC.
 * Fail-closed: cada dato que falte es un renglón de `faltantes` con dónde se
 * captura — jamás un default silencioso.
 */
export function armarCfdiTimbrable(
  v: ViajeCcp,
  idCcp: string,
  emisor: EmisorFiscal,
  receptor: ReceptorFiscal,
  ingresoFlete: number | null,
  emision: ParametrosEmision,
  ahora: Date = new Date(),
): ResultadoCfdi {
  const faltantes: string[] = [];

  // ── El emisor (flota_fiscal) ─────────────────────────────────────────────
  if (emisor.rfc === null) faltantes.push('RFC del emisor — captúralo en el perfil de timbrado (panel del contador).');
  if (emisor.razonSocial === null) faltantes.push('Razón social del emisor (exacta a tu constancia) — perfil de timbrado.');
  if (emisor.regimenFiscal === null) faltantes.push('Régimen fiscal del emisor (clave de 3 dígitos, p. ej. 601) — perfil de timbrado.');
  if (emisor.lugarExpedicion === null) faltantes.push('CP de expedición (LugarExpedicion) — perfil de timbrado.');

  // ── El receptor (cliente) ────────────────────────────────────────────────
  if (receptor.rfc === null) faltantes.push('RFC del cliente — captúralo en el cliente del viaje.');
  if (receptor.razonSocial === null) faltantes.push('Razón social fiscal del cliente (exacta a SU constancia — el nombre comercial no sirve para timbrar).');
  if (receptor.regimenFiscal === null) faltantes.push('Régimen fiscal del cliente (clave de 3 dígitos).');
  if (receptor.usoCfdi === null) faltantes.push('Uso CFDI que pide el cliente (S01, G03…).');
  if (receptor.cpFiscal === null) faltantes.push('CP del domicilio fiscal del cliente.');
  // RFC GENÉRICOS (c6-9): XAXX010101000 (público en general nacional) y
  // XEXX010101000 (residente en el extranjero). El SAT los admite, pero SOLO
  // con el nodo InformacionGlobal (periodicidad, meses, año) que Likida no
  // arma todavía. Detectarlo AQUÍ convierte un rechazo del PAC sin explicación
  // en un faltante con su porqué; el RFC se compara sin importar mayúsculas
  // porque en la captura entra de las dos formas.
  if (receptor.rfc !== null && /^X[AE]XX010101000$/i.test(receptor.rfc.trim())) {
    faltantes.push('El RFC del cliente es genérico (público en general / residente en el extranjero): ese CFDI requiere el nodo InformacionGlobal, que Likida todavía no arma — no soportado aún. Captura el RFC real del cliente o timbra ese viaje en tu facturador.');
  }

  // ── El precio ────────────────────────────────────────────────────────────
  if (ingresoFlete === null || !Number.isFinite(ingresoFlete) || ingresoFlete <= 0) {
    faltantes.push('El ingreso del flete del viaje (el precio pactado) — captúralo en el viaje; el precio jamás se inventa.');
  }

  // ── La emisión ───────────────────────────────────────────────────────────
  if (emision.metodoPago === 'PPD' && emision.formaPago !== '99') {
    faltantes.push('Con método de pago PPD la forma de pago debe ser 99 «Por definir» (Anexo 20).');
  }
  if (emision.metodoPago === 'PUE' && !/^[0-9]{2}$/.test(emision.formaPago)) {
    faltantes.push('Con PUE la forma de pago es la clave real de 2 dígitos (01 efectivo, 03 transferencia…).');
  }
  // PUE + 99 (c6-8): «Por definir» es la forma de un pago que TODAVÍA no
  // ocurrió, y PUE declara que el pago ya se hizo en una sola exhibición. La
  // combinación se contradice y el PAC la rebota (CFDI40158); decirlo aquí
  // ahorra el viaje y explica el porqué, que el código del PAC no explica.
  if (emision.metodoPago === 'PUE' && emision.formaPago === '99') {
    faltantes.push('PUE con forma de pago 99 «Por definir» se contradice: PUE dice que el pago YA se hizo en una exhibición, y 99 dice que aún no se sabe cómo se pagará. Captura la forma real (01 efectivo, 03 transferencia…) o cambia el método a PPD.');
  }

  // ── Lo que el TIMBRE exige y el pre-CFDI dejaba como comentario ──────────
  // El PAC rebotaría cada uno con su código; decirlos ANTES ahorra el viaje.
  const d = v.datos;
  const cc = v.datosCliente;
  const llegada = fechaLlegadaSat(emision.fechaLlegadaEstimada);
  const salida = d.viaje.fechaInicio === null ? null : fechaHoraSat(d.viaje.fechaInicio);
  if (llegada === null) {
    faltantes.push('Fecha y hora estimada de llegada — captúrala antes de timbrar; Carta Porte la exige en el destino.');
  } else if (salida !== null && llegada <= salida) {
    faltantes.push('La fecha estimada de llegada debe ser posterior a la salida del viaje.');
  }
  if (cc.transpInternac === true) {
    faltantes.push('El transporte internacional todavía no está soportado para timbrado directo: faltan los datos aduaneros obligatorios. Timbra este viaje en tu facturador.');
  }
  if (cc.transpInternac === null) faltantes.push('TranspInternac sin declarar en el viaje — decláralo (el timbre lo exige).');
  if (cc.origenCp === null) faltantes.push('CP del origen (dato del cliente) — sin él, la Ubicación de origen rebota.');
  if (cc.destinoCp === null) faltantes.push('CP del destino (dato del cliente).');
  if (d.unidad?.permisoSictTipo == null || d.unidad?.permisoSictNumero == null) {
    faltantes.push('Permiso SICT de la unidad (tipo y número) — captúralo en Unidades; jamás se inventa.');
  }
  if (d.unidad?.aseguradoraRc == null || d.unidad?.polizaRcNumero == null) {
    faltantes.push('Seguro de responsabilidad civil de la unidad (aseguradora y póliza) — captúralo en Unidades.');
  }
  if (d.unidad?.configVehicular == null) faltantes.push('Configuración vehicular de la unidad (C2, T3S2…) — captúralo en Unidades.');

  // El complemento con sus propios candados (borrador validado, etc.).
  const comp = nodoComplementoCcp(v, idCcp, llegada === null ? undefined : { fechaLlegadaSat: llegada });
  if (!comp.ok) return { ok: false, faltantes: [...faltantes, ...comp.motivos] };

  if (faltantes.length > 0) return { ok: false, faltantes };
  // Tras el gate, los campos son no-nulos; el cast es la afirmación de arriba.
  const em = emisor as { rfc: string; razonSocial: string; regimenFiscal: string; lugarExpedicion: string; serie: string | null };
  const re = receptor as { rfc: string; razonSocial: string; regimenFiscal: string; usoCfdi: string; cpFiscal: string };
  const sub = dinero(ingresoFlete as number);
  const iva = dinero(sub * 0.16);
  const esMoral = re.rfc.length === 12;
  const ret = esMoral ? dinero(sub * 0.04) : null;
  const total = dinero(sub + iva - (ret ?? 0));

  const fecha = fechaHoraSat(new Date(ahora.getTime() - 120_000).toISOString());
  if (fecha === null) return { ok: false, faltantes: ['El reloj del sistema no produjo una fecha legible — reintenta.'] };

  const rotulo = v.folio ?? v.viajeId.slice(0, 8);
  const ruta = v.origen !== null && v.destino !== null ? ` (${v.origen} → ${v.destino})` : '';
  const descripcion = `Servicio de autotransporte federal de carga, viaje ${rotulo}${ruta}`;

  const lineas: string[] = [];
  const abre = (s: string) => lineas.push(s);

  abre('<?xml version="1.0" encoding="UTF-8"?>');
  abre('<cfdi:Comprobante');
  abre('  xmlns:cfdi="http://www.sat.gob.mx/cfd/4"');
  abre('  xmlns:cartaporte31="http://www.sat.gob.mx/CartaPorte31"');
  abre('  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"');
  abre('  xsi:schemaLocation="http://www.sat.gob.mx/cfd/4 http://www.sat.gob.mx/sitio_internet/cfd/4/cfdv40.xsd http://www.sat.gob.mx/CartaPorte31 http://www.sat.gob.mx/sitio_internet/cfd/CartaPorte/CartaPorte31.xsd"');
  const serie = em.serie === null ? '' : ` Serie="${escaparXml(em.serie)}"`;
  const folio = v.folio === null ? '' : ` Folio="${escaparXml(v.folio)}"`;
  // Sello, NoCertificado y Certificado AUSENTES a propósito: el servicio
  // `issue` del PAC exige el CFDI sin sellar y sella con el CSD de su bóveda.
  abre(`  Version="4.0"${serie}${folio} Fecha="${fecha}" FormaPago="${escaparXml(emision.formaPago)}" SubTotal="${attr(sub)}" Moneda="MXN" Total="${attr(total)}" TipoDeComprobante="I" Exportacion="01" MetodoPago="${emision.metodoPago}" LugarExpedicion="${escaparXml(em.lugarExpedicion)}">`);
  abre(`  <cfdi:Emisor Rfc="${escaparXml(em.rfc)}" Nombre="${escaparXml(em.razonSocial)}" RegimenFiscal="${escaparXml(em.regimenFiscal)}"/>`);
  abre(`  <cfdi:Receptor Rfc="${escaparXml(re.rfc)}" Nombre="${escaparXml(re.razonSocial)}" DomicilioFiscalReceptor="${escaparXml(re.cpFiscal)}" RegimenFiscalReceptor="${escaparXml(re.regimenFiscal)}" UsoCFDI="${escaparXml(re.usoCfdi)}"/>`);
  abre('  <cfdi:Conceptos>');
  abre(`    <cfdi:Concepto ClaveProdServ="${CLAVE_PROD_SERV_FLETE}" Cantidad="1" ClaveUnidad="${CLAVE_UNIDAD_SERVICIO}" Descripcion="${escaparXml(descripcion)}" ValorUnitario="${attr(sub)}" Importe="${attr(sub)}" ObjetoImp="02">`);
  abre('      <cfdi:Impuestos>');
  abre('        <cfdi:Traslados>');
  abre(`          <cfdi:Traslado Base="${attr(sub)}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${attr(iva)}"/>`);
  abre('        </cfdi:Traslados>');
  if (ret !== null) {
    abre('        <cfdi:Retenciones>');
    abre(`          <cfdi:Retencion Base="${attr(sub)}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.040000" Importe="${attr(ret)}"/>`);
    abre('        </cfdi:Retenciones>');
  }
  abre('      </cfdi:Impuestos>');
  abre('    </cfdi:Concepto>');
  abre('  </cfdi:Conceptos>');
  // Orden del XSD en el resumen global: Retenciones antes que Traslados.
  const totRet = ret === null ? '' : ` TotalImpuestosRetenidos="${attr(ret)}"`;
  abre(`  <cfdi:Impuestos${totRet} TotalImpuestosTrasladados="${attr(iva)}">`);
  if (ret !== null) {
    abre('    <cfdi:Retenciones>');
    abre(`      <cfdi:Retencion Impuesto="002" Importe="${attr(ret)}"/>`);
    abre('    </cfdi:Retenciones>');
  }
  abre('    <cfdi:Traslados>');
  abre(`      <cfdi:Traslado Base="${attr(sub)}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${attr(iva)}"/>`);
  abre('    </cfdi:Traslados>');
  abre('  </cfdi:Impuestos>');
  lineas.push(...comp.lineas);
  abre('</cfdi:Comprobante>');

  return { ok: true, xml: lineas.join('\n') + '\n', subTotal: sub, iva, retencionIva: ret, total };
}
