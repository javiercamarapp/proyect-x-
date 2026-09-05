import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { armarCfdiTimbrable, type EmisorFiscal, type ReceptorFiscal } from './carta_porte_cfdi';
import { armarBorrador, checklistCcp, necesitaCartaPorte, generarIdCcp, type DatosChecklist } from './carta_porte';
import type { ViajeCcp } from './carta_porte_datos';
import { NORMAS } from './normas/indice';

// ═══════════════════════════════════════════════════════════════════════════
// El CFDI timbrable (0226). Lo que estas pruebas fijan:
//   · con TODO capturado, el XML es un CFDI de ingreso completo: Emisor,
//     Receptor con sus 5 datos, Concepto del flete con IVA 16%, resumen
//     global con el orden del XSD, y el complemento — SIN Sello/Certificado
//     (los pone el PAC);
//   · la retención de IVA del 4% aparece SOLO con receptor persona moral
//     (RFC de 12) — jamás con persona física (13);
//   · cada dato ausente es un renglón de `faltantes`, no un default;
//   · PPD con forma ≠ 99 se rechaza (Anexo 20).
// ═══════════════════════════════════════════════════════════════════════════

function datosCompletos(): DatosChecklist {
  return {
    viaje: { origen: 'Mérida', destino: 'Cancún', fechaInicio: '2026-08-27T15:00:00+00:00', kmRecorridos: 320 },
    clienteRfc: 'AAA010101AAA',
    unidad: {
      placas: 'ABC1234', anio: 2020, configVehicular: 'C2', pesoBrutoTon: 17.5,
      aseguradoraRc: 'Qualitas', polizaRcNumero: 'POL-99',
      permisoSictTipo: 'TPAF01', permisoSictNumero: '123456',
    },
    operador: { nombre: 'Juan Pérez', rfc: 'PEPJ800101AAA', licencia: 'LIC123456' },
    ccpViaje: {
      origenCp: '97000', destinoCp: '77500', origenEstado: 'YUC', destinoEstado: 'ROO',
      rfcDestinatario: 'BBB010101BB8', transpInternac: false,
    },
    mercancias: [
      { descripcion: 'Cemento', bienesTransp: '01010101', cantidad: 10, claveUnidad: 'XBX', pesoKg: 900.5, materialPeligroso: false },
    ],
  };
}

function viajeDe(datos: DatosChecklist): ViajeCcp {
  const cc = datos.ccpViaje ?? {
    origenCp: null, destinoCp: null, origenEstado: null, destinoEstado: null,
    rfcDestinatario: null, transpInternac: null,
  };
  return {
    viajeId: '11111111-2222-4333-8444-555555555555',
    folio: 'F-123',
    origen: datos.viaje.origen, destino: datos.viaje.destino,
    estatus: 'abierto', unidadEconomico: 'T-07',
    operadorNombre: datos.operador?.nombre ?? null,
    clienteNombre: 'Choco',
    declarado: { pisaFederal: true, radioKm: null },
    decision: necesitaCartaPorte({ pisaTramoFederal: true, configVehicular: datos.unidad?.configVehicular ?? null, radioFederalKm: null, materiaExcluida: false }),
    checklist: checklistCcp(datos),
    datosCliente: cc,
    mercancias: (datos.mercancias ?? []).map((m, i) => ({ ...m, id: `m-${i}` })),
    borrador: armarBorrador(datos),
    datos,
  };
}

const EMISOR: EmisorFiscal = {
  rfc: 'EKU9003173C9', razonSocial: 'ESCUELA KEMPER URGATE', regimenFiscal: '601',
  lugarExpedicion: '42501', serie: 'CCP', modo: 'sandbox',
};
// RFC de 12 = persona MORAL (retiene); de 13 = física (no retiene).
const RECEPTOR_MORAL: ReceptorFiscal = {
  rfc: 'AAA010101AAA', razonSocial: 'CLIENTE MORAL SA DE CV', regimenFiscal: '601',
  usoCfdi: 'S01', cpFiscal: '64000',
};
const RECEPTOR_FISICA: ReceptorFiscal = {
  rfc: 'PEPJ800101AA0', razonSocial: 'PERSONA FISICA', regimenFiscal: '612',
  usoCfdi: 'G03', cpFiscal: '64000',
};

const ID = generarIdCcp();
const AHORA = new Date('2026-08-27T18:00:00Z');
const EMI = {
  metodoPago: 'PPD' as const,
  formaPago: '99',
  // Salida 15:00Z = 09:00 hora de México; llegada capturada, no calculada.
  fechaLlegadaEstimada: '2026-08-27T16:00',
};

describe('armarCfdiTimbrable — el CFDI completo sin sellar', () => {
  it('receptor MORAL: comprobante completo con IVA 16% y retención 4%, sin Sello', () => {
    const r = armarCfdiTimbrable(viajeDe(datosCompletos()), ID, EMISOR, RECEPTOR_MORAL, 10000, EMI, AHORA);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.subTotal).toBe(10000);
    expect(r.iva).toBe(1600);
    expect(r.retencionIva).toBe(400);
    expect(r.total).toBe(11200);
    const x = r.xml;
    expect(x).toContain('Serie="CCP" Folio="F-123"');
    // 18:00Z − 2 min = 17:58Z = 11:58 en México (UTC−6, sin DST).
    expect(x).toContain('Fecha="2026-08-27T11:58:00"');
    expect(x).toContain('FormaPago="99"');
    expect(x).toContain('SubTotal="10000.00" Moneda="MXN" Total="11200.00" TipoDeComprobante="I" Exportacion="01" MetodoPago="PPD" LugarExpedicion="42501"');
    expect(x).toContain('<cfdi:Emisor Rfc="EKU9003173C9" Nombre="ESCUELA KEMPER URGATE" RegimenFiscal="601"/>');
    expect(x).toContain('DomicilioFiscalReceptor="64000" RegimenFiscalReceptor="601" UsoCFDI="S01"');
    expect(x).toContain('ClaveProdServ="78101800"');
    expect(x).toContain('ObjetoImp="02"');
    expect(x).toContain('TasaOCuota="0.160000" Importe="1600.00"');
    expect(x).toContain('TasaOCuota="0.040000" Importe="400.00"');
    expect(x).toContain('TotalImpuestosRetenidos="400.00" TotalImpuestosTrasladados="1600.00"');
    // El complemento viaja completo dentro del mismo comprobante.
    expect(x).toContain(`IdCCP="${ID}"`);
    expect(x).toContain('PermSCT="TPAF01"');
    expect(x).toContain('TipoUbicacion="Origen" IDUbicacion="OR000001"');
    expect(x).toContain('TipoUbicacion="Destino" IDUbicacion="DE000001"');
    expect(x).toContain('FechaHoraSalidaLlegada="2026-08-27T16:00:00"');
    expect(x.match(/FechaHoraSalidaLlegada=/g)).toHaveLength(2);
    // SIN sellar: esos tres los pone el PAC con el CSD de su bóveda.
    expect(x).not.toContain('Sello=');
    expect(x).not.toContain('NoCertificado="');
    expect(x).not.toContain('Certificado="');
    // El resumen global respeta el orden del XSD: Retenciones antes que
    // Traslados. Ancladas a inicio de línea (\n + 4 espacios) para no
    // confundirlas con las del Concepto, que van más adentro.
    expect(x.indexOf('<cfdi:Impuestos ')).toBeLessThan(x.indexOf('\n    <cfdi:Retenciones>'));
    expect(x.indexOf('\n    <cfdi:Retenciones>')).toBeLessThan(x.indexOf('\n    <cfdi:Traslados>'));
  });

  it('receptor persona FÍSICA: sin retención — no hay obligación que inventar', () => {
    const r = armarCfdiTimbrable(viajeDe(datosCompletos()), ID, EMISOR, RECEPTOR_FISICA, 10000, EMI, AHORA);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.retencionIva).toBeNull();
    expect(r.total).toBe(11600);
    expect(r.xml).not.toContain('TasaOCuota="0.040000"');
    expect(r.xml).not.toContain('TotalImpuestosRetenidos');
  });

  it('cada faltante es un renglón con dónde se captura — jamás un default', () => {
    const sinNada = armarCfdiTimbrable(
      viajeDe(datosCompletos()), ID,
      { rfc: null, razonSocial: null, regimenFiscal: null, lugarExpedicion: null, serie: null, modo: 'sandbox' },
      { rfc: null, razonSocial: null, regimenFiscal: null, usoCfdi: null, cpFiscal: null },
      null, EMI, AHORA,
    );
    expect(sinNada.ok).toBe(false);
    if (sinNada.ok) return;
    const junto = sinNada.faltantes.join(' | ');
    expect(junto).toContain('RFC del emisor');
    expect(junto).toContain('Razón social del emisor');
    expect(junto).toContain('RFC del cliente');
    expect(junto).toContain('Uso CFDI');
    expect(junto).toContain('ingreso del flete');
    expect(junto).toContain('jamás se inventa');
  });

  it('PPD con forma ≠ 99 se rechaza (Anexo 20); PUE exige la clave real de 2 dígitos', () => {
    const ppdMal = armarCfdiTimbrable(viajeDe(datosCompletos()), ID, EMISOR, RECEPTOR_MORAL, 10000,
      { ...EMI, metodoPago: 'PPD', formaPago: '03' }, AHORA);
    expect(ppdMal.ok).toBe(false);
    if (!ppdMal.ok) expect(ppdMal.faltantes.join(' ')).toContain('99');

    const pueMal = armarCfdiTimbrable(viajeDe(datosCompletos()), ID, EMISOR, RECEPTOR_MORAL, 10000,
      { ...EMI, metodoPago: 'PUE', formaPago: 'efectivo' }, AHORA);
    expect(pueMal.ok).toBe(false);

    const pueBien = armarCfdiTimbrable(viajeDe(datosCompletos()), ID, EMISOR, RECEPTOR_MORAL, 10000,
      { ...EMI, metodoPago: 'PUE', formaPago: '03' }, AHORA);
    expect(pueBien.ok).toBe(true);
    if (pueBien.ok) expect(pueBien.xml).toContain('FormaPago="03"');
  });

  it('lo que el timbre exige y el export dejaba como comentario, aquí es faltante: SICT, seguro, CPs', () => {
    const d = datosCompletos();
    d.unidad = { ...d.unidad!, permisoSictTipo: null, permisoSictNumero: null, aseguradoraRc: null, polizaRcNumero: null };
    d.ccpViaje = { ...d.ccpViaje!, origenCp: null, transpInternac: null };
    const r = armarCfdiTimbrable(viajeDe(d), ID, EMISOR, RECEPTOR_MORAL, 10000, EMI, AHORA);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const junto = r.faltantes.join(' | ');
    expect(junto).toContain('Permiso SICT');
    expect(junto).toContain('responsabilidad civil');
    expect(junto).toContain('CP del origen');
    expect(junto).toContain('TranspInternac');
  });

  // ── Auditoría Fable ciclo 6 ───────────────────────────────────────────────

  it('c6-8: PUE con forma 99 se rebota AQUÍ, con el porqué — no en el PAC', () => {
    const r = armarCfdiTimbrable(viajeDe(datosCompletos()), ID, EMISOR, RECEPTOR_MORAL, 10000,
      { ...EMI, metodoPago: 'PUE', formaPago: '99' }, AHORA);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const junto = r.faltantes.join(' | ');
    expect(junto).toContain('PUE con forma de pago 99');
    // El mensaje explica la contradicción, no solo la prohíbe.
    expect(junto).toContain('el pago YA se hizo');
  });

  it('c6-9: el RFC genérico (XAXX/XEXX) entra a faltantes con su motivo, no rebota en el PAC', () => {
    for (const rfc of ['XAXX010101000', 'XEXX010101000', 'xaxx010101000']) {
      const r = armarCfdiTimbrable(viajeDe(datosCompletos()), ID, EMISOR,
        { ...RECEPTOR_MORAL, rfc }, 10000, EMI, AHORA);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      const junto = r.faltantes.join(' | ');
      expect(junto).toContain('InformacionGlobal');
      expect(junto).toContain('no soportado aún');
    }
    // Y un RFC normal de 12 no se confunde con uno genérico.
    expect(armarCfdiTimbrable(viajeDe(datosCompletos()), ID, EMISOR, RECEPTOR_MORAL, 10000, EMI, AHORA).ok).toBe(true);
  });

  it('los centavos se redondean a 2 decimales coherentes entre sí', () => {
    const r = armarCfdiTimbrable(viajeDe(datosCompletos()), ID, EMISOR, RECEPTOR_MORAL, 3333.33, EMI, AHORA);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.iva).toBe(533.33);       // 3333.33 × 0.16 = 533.3328 → 533.33
    expect(r.retencionIva).toBe(133.33); // × 0.04 = 133.3332 → 133.33
    expect(r.total).toBe(3733.33);    // 3333.33 + 533.33 − 133.33
    expect(r.xml).toContain('SubTotal="3333.33"');
    expect(r.xml).toContain('Total="3733.33"');
  });

  it('falla cerrado sin llegada válida o cuando no es posterior a la salida', () => {
    for (const fechaLlegadaEstimada of [null, '', '2026-02-31T10:00', '2026-08-27T08:59']) {
      const r = armarCfdiTimbrable(viajeDe(datosCompletos()), ID, EMISOR, RECEPTOR_MORAL, 10000,
        { ...EMI, fechaLlegadaEstimada }, AHORA);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.faltantes.join(' ')).toMatch(/llegada/i);
    }
  });

  it('transporte internacional falla cerrado mientras el bloque aduanero no esté modelado', () => {
    const d = datosCompletos();
    d.ccpViaje = { ...d.ccpViaje!, transpInternac: true };
    const r = armarCfdiTimbrable(viajeDe(d), ID, EMISOR, RECEPTOR_MORAL, 10000, EMI, AHORA);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.faltantes.join(' ')).toContain('datos aduaneros');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 25, MEDIO FISCAL, REINCIDENTE de la 23 y la 24 (fiscal.md línea
// 322) — la retención del 4% que Likida TIMBRA no tenía ficha en `normas/`, y
// el comentario que la fundaba citaba la regla equivocada: "la regla 3.1.2 de
// la RMF fija el 4%" — esa regla es del Título 3 (ISR), no del IVA. La tasa
// vive en el art. 3, fracción II del Reglamento de la LIVA.
// ═══════════════════════════════════════════════════════════════════════════
describe('la retención del 4% cita la norma correcta y tiene ficha', () => {
  // URL constante del archivo hermano bajo prueba; no recibe entrada externa.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const fuente = readFileSync(new URL('./carta_porte_cfdi.ts', import.meta.url), 'utf8');

  it('el comentario ya NO cita la regla 3.1.2 de la RMF para la tasa', () => {
    expect(fuente).not.toMatch(/3\.1\.2 de la RMF fija el 4%/);
  });

  it('el comentario cita RLIVA 3-II', () => {
    expect(fuente).toMatch(/RLIVA 3-II/);
  });

  it('existe una ficha verificada para RLIVA 3-II', () => {
    const n = NORMAS['rliva-3-fr-II'];
    expect(n, 'falta la entrada en el índice de normas').toBeDefined();
    expect(n.estado).toBe('verificado_fuente_primaria');
    expect(n.citas).toContain('RLIVA 3-II');
  });
});
