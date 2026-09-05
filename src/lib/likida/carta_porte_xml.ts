// ═══════════════════════════════════════════════════════════════════════════
// FASE D DEL AGENTE DE CARTA PORTE — LA VÍA EXPORT XML.
//
// El blueprint 20 planteaba dos caminos para cerrar el ciclo: exportar el XML
// para timbrar en el facturador que la flota ya usa, o timbrar por API con un
// PAC aliado. Javier eligió cerrar el ciclo YA por la vía export (27-ago-2026):
// este módulo convierte el borrador VALIDADO en el XML del CFDI de ingreso con
// su complemento Carta Porte 3.1, listo para que el facturador/PAC de la flota
// lo complete y lo timbre.
//
// La vía PAC-por-API queda como UPGRADE de este módulo, no como reescritura:
// el XML que aquí se arma es el mismo que un PAC recibe — conectar un PAC es
// agregar el transporte (API + credenciales + precio por timbre, decisión de
// la sección E), no otro generador.
//
// ── LO QUE ESTE XML NO ES (y lo dice en su primer comentario) ──────────────
// NO es un CFDI timbrado y NO ampara ningún traslado. Likida JAMÁS timbra
// (0049) ni sella: no tiene el CSD de la flota, y un XML sellado por quien no
// es el emisor sería una falsificación. Los atributos que solo existen al
// emitir quedan FUERA a propósito, cada uno con su porqué:
//
//   · Fecha, Sello, NoCertificado, Certificado — los pone el sistema que
//     firma con el CSD del emisor, en el momento de emitir.
//   · SubTotal, Total, Moneda, FormaPago, MetodoPago, LugarExpedicion,
//     Exportacion y los Conceptos (el flete y sus impuestos) — son de la
//     FACTURA, no del complemento; Likida no captura el precio pactado del
//     flete en este circuito y no lo inventa.
//   · Emisor (RFC/Nombre/Régimen del transportista) — sale del CSD y del
//     perfil fiscal del facturador; no hay casilla en Likida y no se supone.
//   · FechaHoraSalidaLlegada del DESTINO — es ESTIMADA y se declara al
//     emitir (mismo contrato que el checklist y la página del borrador).
//
// El IdCCP sí se genera aquí: es el folio del complemento y lo produce "el
// sistema que expide" (Estándar 3.1) — que para este papel de trabajo es
// Likida. Si el facturador de la flota genera el suyo propio, el suyo manda:
// el IdCCP entra a la cadena original que sella EL EMISOR.
//
// PURO: recibe el ViajeCcp ya leído y el IdCCP ya generado; no toca red ni
// base. El único escritor del sello de bitácora es la ruta de export.
// ═══════════════════════════════════════════════════════════════════════════

import type { ViajeCcp } from './carta_porte_datos';
import { ID_CCP_RE } from './carta_porte';
import { fechaHoraSat } from '@/lib/formato';

export type ResultadoXml =
  | { ok: true; xml: string; nombreArchivo: string; idCcp: string; omitidos: string[] }
  | { ok: false; motivos: string[] };

/** Escapado XML de los CINCO caracteres reservados — en atributos y texto.
 *  Un `&` sin escapar en "Transportes Gómez & Hijos" es un XML que ningún
 *  facturador puede abrir. */
export function escaparXml(v: string): string {
  return v
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Decimal como lo espera el SAT: punto decimal, sin notación científica y
 *  sin ceros de relleno inventando precisión (12.5, no 12.500). Los valores
 *  vienen de `numeric(14,3)` — 3 decimales es el techo real. */
const dec = (n: number): string => {
  const r = Math.round(n * 1000) / 1000;
  return String(r);
};

/**
 * El XML del CFDI de ingreso con complemento Carta Porte 3.1, del borrador
 * VALIDADO. Fail-closed: sin borrador armado o con fallas del validador de
 * rechazo seguro NO hay XML — se devuelven los motivos en el idioma de quien
 * los va a resolver, que son los mismos que la página del borrador ya enseña.
 */
/**
 * El nodo `<cfdi:Complemento>` con la Carta Porte 3.1, extraído para que lo
 * compartan las DOS vías de la Fase D: el export (este archivo) y el CFDI
 * timbrable (carta_porte_cfdi.ts, 0226). Un solo constructor del complemento
 * = una sola verdad de cómo se arma; dos copias serían dos complementos que
 * se desfasan en silencio.
 *
 * Trae sus propios candados (borrador validado, IdCCP con forma, fecha de
 * salida legible, Origen/Destino con distancia) porque NINGÚN camino debe
 * poder armarlo a medias.
 */
export function nodoComplementoCcp(
  v: ViajeCcp,
  idCcp: string,
  opciones?: { fechaLlegadaSat?: string },
):
  | { ok: true; lineas: string[] }
  | { ok: false; motivos: string[] } {
  const b = v.borrador.borrador;
  if (b === null) {
    return { ok: false, motivos: ['El borrador aún no se puede armar.', ...v.borrador.faltantes] };
  }
  if (v.borrador.fallas.length > 0) {
    return {
      ok: false,
      motivos: ['El borrador no pasa el validador de rechazo seguro del PAC.',
        ...v.borrador.fallas.map((f) => `${f.campo}: ${f.detalle}`)],
    };
  }
  if (!ID_CCP_RE.test(idCcp)) {
    return { ok: false, motivos: [`IdCCP inválido: "${idCcp}" no cumple el formato CCC+RFC4122 del Estándar 3.1.`] };
  }

  const d = v.datos;
  const cc = v.datosCliente;
  const salida = d.viaje.fechaInicio === null ? null : fechaHoraSat(d.viaje.fechaInicio);
  if (salida === null) {
    // armarBorrador ya exigió la fecha; esto solo puede ser una fecha ilegible
    // en base — y una fecha ilegible no se rellena con "ahora".
    return { ok: false, motivos: ['La fecha de salida del viaje no se pudo leer como fecha — corrígela antes de exportar.'] };
  }

  const origen = b.ubicaciones.find((x) => x.tipo === 'Origen');
  const destino = b.ubicaciones.find((x) => x.tipo === 'Destino');
  // El validador ya exigió Origen y Destino CON distancia; si aún así faltan,
  // el XML no se arma a medias — se dice, jamás se rellena con un cero.
  if (!origen || !destino || destino.distanciaRecorrida == null) {
    return { ok: false, motivos: ['El borrador no trae Origen y Destino con distancia — vuelve a armar el borrador.'] };
  }
  const llegada = opciones?.fechaLlegadaSat;
  if (llegada !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(llegada)) {
      return { ok: false, motivos: ['La fecha estimada de llegada no tiene el formato requerido por Carta Porte.'] };
    }
    if (llegada <= salida) {
      return { ok: false, motivos: ['La fecha estimada de llegada debe ser posterior a la salida.'] };
    }
  }

  const lineas: string[] = [];
  const abre = (s: string) => lineas.push(s);

  abre('  <cfdi:Complemento>');
  const transp = cc.transpInternac === null ? '' : ` TranspInternac="${cc.transpInternac ? 'Sí' : 'No'}"`;
  abre(`    <cartaporte31:CartaPorte Version="3.1" IdCCP="${escaparXml(idCcp)}"${transp} TotalDistRec="${dec(b.totalDistRec)}">`);

  // ── Ubicaciones ── el RFC del remitente/destinatario y las fechas son los
  // del borrador validado; el domicilio (CP + estado) solo si el cliente los
  // dio — un CP ausente es un hueco del cliente, no un "00000".
  abre('      <cartaporte31:Ubicaciones>');
  abre(`        <cartaporte31:Ubicacion TipoUbicacion="Origen" IDUbicacion="OR000001" RFCRemitenteDestinatario="${escaparXml(origen.rfc)}" FechaHoraSalidaLlegada="${salida}">`);
  abre(domicilio(cc.origenCp, cc.origenEstado, cc.transpInternac));
  abre('        </cartaporte31:Ubicacion>');
  const fechaDestino = llegada === undefined ? '' : ` FechaHoraSalidaLlegada="${llegada}"`;
  abre(`        <cartaporte31:Ubicacion TipoUbicacion="Destino" IDUbicacion="DE000001" RFCRemitenteDestinatario="${escaparXml(destino.rfc)}" DistanciaRecorrida="${dec(destino.distanciaRecorrida)}"${fechaDestino}>`);
  if (llegada === undefined) abre('          <!-- FechaHoraSalidaLlegada: estimada — se declara al emitir -->');
  abre(domicilio(cc.destinoCp, cc.destinoEstado, cc.transpInternac));
  abre('        </cartaporte31:Ubicacion>');
  abre('      </cartaporte31:Ubicaciones>');

  // ── Mercancías ── una por renglón capturado, con los datos QUE DIO el
  // cliente. MaterialPeligroso solo cuando se declaró (NULL = no declarado,
  // contrato de la 0204 — un "No" supuesto decidiría AseguraMedAmbiente).
  abre(`      <cartaporte31:Mercancias PesoBrutoTotal="${dec(b.pesoBrutoTotal)}" UnidadPeso="KGM" NumTotalMercancias="${b.numTotalMercancias}">`);
  for (const m of b.mercancias) {
    const peligroso = m.materialPeligroso === undefined ? '' : ` MaterialPeligroso="${m.materialPeligroso ? 'Sí' : 'No'}"`;
    abre(`        <cartaporte31:Mercancia BienesTransp="${escaparXml(m.bienesTransp)}" Descripcion="${escaparXml(m.descripcion)}" Cantidad="${dec(m.cantidad)}" ClaveUnidad="${escaparXml(m.claveUnidad)}" PesoEnKg="${dec(m.pesoEnKg)}"${peligroso}/>`);
  }

  // ── Autotransporte ── el permiso SICT SOLO si está capturado: un permiso
  // inventado en un complemento es un dato falso ante el SAT (candado de la
  // casa, mismo criterio que el checklist).
  const u = d.unidad;
  const permAttrs = [
    u?.permisoSictTipo == null ? null : `PermSCT="${escaparXml(u.permisoSictTipo)}"`,
    u?.permisoSictNumero == null ? null : `NumPermisoSCT="${escaparXml(u.permisoSictNumero)}"`,
  ].filter((x): x is string => x !== null);
  if (permAttrs.length < 2) {
    abre('        <!-- PermSCT/NumPermisoSCT: sin capturar en Unidades — el complemento los exige; captúralos antes de emitir -->');
  }
  abre(`        <cartaporte31:Autotransporte${permAttrs.length ? ' ' + permAttrs.join(' ') : ''}>`);
  const idVeh = [
    u?.configVehicular == null ? null : `ConfigVehicular="${escaparXml(u.configVehicular)}"`,
    u?.pesoBrutoTon == null ? null : `PesoBrutoVehicular="${dec(u.pesoBrutoTon)}"`,
    `PlacaVM="${escaparXml(b.placaVm)}"`,
    u?.anio == null ? null : `AnioModeloVM="${u.anio}"`,
  ].filter((x): x is string => x !== null);
  abre(`          <cartaporte31:IdentificacionVehicular ${idVeh.join(' ')}/>`);
  if (u?.aseguradoraRc != null && u?.polizaRcNumero != null) {
    const medAmb = b.aseguraMedAmbiente == null ? '' : ` AseguraMedAmbiente="${escaparXml(b.aseguraMedAmbiente)}"`;
    abre(`          <cartaporte31:Seguros AseguraRespCivil="${escaparXml(u.aseguradoraRc)}" PolizaRespCivil="${escaparXml(u.polizaRcNumero)}"${medAmb}/>`);
  } else {
    abre('          <!-- Seguros (AseguraRespCivil/PolizaRespCivil): sin capturar en Unidades — el complemento los exige; captúralos antes de emitir -->');
  }
  abre('        </cartaporte31:Autotransporte>');
  abre('      </cartaporte31:Mercancias>');

  // ── Figura ── el operador del borrador validado (TipoFigura 01 con
  // licencia, ya exigidos por validarComplemento); el RFC solo si existe.
  abre('      <cartaporte31:FiguraTransporte>');
  for (const f of b.figuras) {
    const rfcF = d.operador?.rfc == null ? '' : ` RFCFigura="${escaparXml(d.operador.rfc)}"`;
    const lic = f.numLicencia == null ? '' : ` NumLicencia="${escaparXml(f.numLicencia)}"`;
    abre(`        <cartaporte31:TiposFigura TipoFigura="${f.tipoFigura}" Nombre="${escaparXml(f.nombre)}"${lic}${rfcF}/>`);
  }
  abre('      </cartaporte31:FiguraTransporte>');

  abre('    </cartaporte31:CartaPorte>');
  abre('  </cfdi:Complemento>');

  return { ok: true, lineas };
}

export function generarXmlCcp(v: ViajeCcp, idCcp: string): ResultadoXml {
  const comp = nodoComplementoCcp(v, idCcp);
  if (!comp.ok) return { ok: false, motivos: comp.motivos };

  const d = v.datos;
  const cc = v.datosCliente;

  // Lo que el XML NO trae, dicho por nombre — va como comentario dentro del
  // archivo (citable por el facturador) y en el resultado (para la bitácora).
  const omitidos: string[] = [
    'Fecha, Sello, NoCertificado y Certificado del Comprobante — los pone tu facturador al emitir con el CSD.',
    'SubTotal, Total, Moneda, FormaPago, MetodoPago, LugarExpedicion, Exportacion y los Conceptos (el flete y sus impuestos) — se capturan en tu facturador.',
    'Emisor (RFC, nombre y régimen del transportista) — sale de tu CSD y tu perfil fiscal en el facturador.',
    'FechaHoraSalidaLlegada del Destino — es estimada y se declara al emitir.',
  ];
  if (cc.transpInternac === null) omitidos.push('TranspInternac — sin declarar en el viaje; decláralo antes de emitir.');
  if (cc.transpInternac === true) omitidos.push('EntradaSalidaMerc, PaisOrigenDestino y ViaEntradaSalida — el viaje se declaró internacional y esos datos se capturan al emitir.');

  const receptorNota = d.clienteRfc === null
    ? []
    : ['Receptor: Nombre, DomicilioFiscalReceptor, RegimenFiscalReceptor y UsoCFDI — se completan en tu facturador con la constancia fiscal de tu cliente.'];
  omitidos.push(...receptorNota);

  const lineas: string[] = [];
  const abre = (s: string) => lineas.push(s);

  abre('<?xml version="1.0" encoding="UTF-8"?>');
  abre('<!--');
  abre('  DOCUMENTO DE TRABAJO GENERADO POR LIKIDA — PRE-CFDI, NO TIMBRADO.');
  abre('  No ampara ningún traslado. Se importa/captura en el facturador de la');
  abre('  flota, que completa lo que aquí falta y timbra. Falta a propósito:');
  for (const o of omitidos) abre(`    · ${escaparComentario(o)}`);
  abre('-->');
  abre('<cfdi:Comprobante');
  abre('  xmlns:cfdi="http://www.sat.gob.mx/cfd/4"');
  abre('  xmlns:cartaporte31="http://www.sat.gob.mx/CartaPorte31"');
  abre('  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"');
  abre('  xsi:schemaLocation="http://www.sat.gob.mx/cfd/4 http://www.sat.gob.mx/sitio_internet/cfd/4/cfdv40.xsd http://www.sat.gob.mx/CartaPorte31 http://www.sat.gob.mx/sitio_internet/cfd/CartaPorte/CartaPorte31.xsd"');
  const folio = v.folio === null ? '' : ` Folio="${escaparXml(v.folio)}"`;
  abre(`  Version="4.0" TipoDeComprobante="I"${folio}>`);

  if (d.clienteRfc !== null) {
    const nombre = v.clienteNombre === null ? '' : ` Nombre="${escaparXml(v.clienteNombre)}"`;
    abre(`  <cfdi:Receptor Rfc="${escaparXml(d.clienteRfc)}"${nombre}/>`);
  }

  lineas.push(...comp.lineas);
  abre('</cfdi:Comprobante>');

  const rotulo = v.folio ?? v.viajeId.slice(0, 8);
  return {
    ok: true,
    xml: lineas.join('\n') + '\n',
    // El nombre dice qué es y de qué viaje — sin espacios ni caracteres que
    // un filesystem rechace.
    nombreArchivo: `carta-porte-${rotulo.replace(/[^A-Za-z0-9_-]+/g, '_')}.xml`,
    idCcp,
    omitidos,
  };
}

/** El nodo Domicilio de una ubicación — solo con lo que el cliente dio.
 *  País: MEX únicamente cuando la flota DECLARÓ que no es internacional
 *  (mismo derivado que el checklist: `derivado: MEX si se declaró no
 *  internacional`); sin declarar, el país no se supone. */
function domicilio(cp: string | null, estado: string | null, transpInternac: boolean | null): string {
  if (cp === null && estado === null) {
    return '          <!-- Domicilio: CP y estado sin capturar — datos del cliente; captúralos antes de emitir -->';
  }
  const attrs = [
    estado === null ? null : `Estado="${escaparXml(estado)}"`,
    transpInternac === false ? 'Pais="MEX"' : null,
    cp === null ? null : `CodigoPostal="${escaparXml(cp)}"`,
  ].filter((x): x is string => x !== null);
  const nota = (cp === null || estado === null || transpInternac !== false)
    ? ' <!-- incompleto: lo que falta se captura antes de emitir -->' : '';
  return `          <cartaporte31:Domicilio ${attrs.join(' ')}/>${nota}`;
}

/** Un comentario XML no puede contener `--`; y el texto viene de datos. */
function escaparComentario(s: string): string {
  return s.replaceAll('--', '––');
}
