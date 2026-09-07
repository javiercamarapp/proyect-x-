import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseRepXml, mensajeRepRecibido } from './rep';
import type { RepXmlData } from './rep';
import { parseCfdiXml, metodoPagoSat } from './cfdi_xml';

// ═══════════════════════════════════════════════════════════════════════════
// FASE 7 (mig. 0199) — EL REP QUE NADIE INGERÍA.
//
// El motor excluye el IVA de un CFDI con FormaPago 99 (LIVA 5-III) y promete
// que se acreditará "el mes en que se pague (con su complemento de pago)".
// Este archivo fija el complemento de esa promesa: el parser del REP
// (estructura verificada contra Pagos20.xsd del SAT, 26-ago-2026), la
// idempotencia de su ingesta, y la regla fail-closed del sello (solo un
// docto TOTALMENTE pagado sella; una parcialidad se registra sin sellar).
//
// El fixture es SINTÉTICO — armado a mano contra el XSD, no un REP timbrado
// real. Lo que fija es el CONTRATO del parser con esa estructura; el día que
// haya un REP real de una estación, se agrega como segundo fixture.
// ═══════════════════════════════════════════════════════════════════════════

const UUID_REP = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEFFFF0001';
const UUID_PPD = '11111111-2222-3333-4444-555566660001';

const REP_SINTETICO = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:pago20="http://www.sat.gob.mx/Pagos20"
  Version="4.0" TipoDeComprobante="P" Fecha="2026-09-03T10:00:00" Total="0" SubTotal="0" Moneda="XXX">
  <cfdi:Emisor Rfc="EST010101AB1" Nombre="ESTACION DE CASA SA" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="GMX0902279I1" Nombre="TRANSPORTES DEL BAJIO" UsoCFDI="CP01" DomicilioFiscalReceptor="37000" RegimenFiscalReceptor="601"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="84111506" Cantidad="1" ClaveUnidad="ACT" Descripcion="Pago" ValorUnitario="0" Importe="0" ObjetoImp="01"/>
  </cfdi:Conceptos>
  <cfdi:Complemento>
    <pago20:Pagos Version="2.0">
      <pago20:Totales MontoTotalPagos="11600.00"/>
      <pago20:Pago FechaPago="2026-09-02T12:00:00" FormaDePagoP="03" MonedaP="MXN" Monto="11600.00">
        <pago20:DoctoRelacionado IdDocumento="${UUID_PPD}" MonedaDR="MXN" EquivalenciaDR="1"
          NumParcialidad="1" ImpSaldoAnt="11600.00" ImpPagado="11600.00" ImpSaldoInsoluto="0" ObjetoImpDR="02">
          <pago20:ImpuestosDR>
            <pago20:TrasladosDR>
              <pago20:TrasladoDR BaseDR="10000.00" ImpuestoDR="002" TipoFactorDR="Tasa" TasaOCuotaDR="0.160000" ImporteDR="1600.00"/>
            </pago20:TrasladosDR>
          </pago20:ImpuestosDR>
        </pago20:DoctoRelacionado>
      </pago20:Pago>
    </pago20:Pagos>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="1.1" UUID="${UUID_REP}"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;

describe('parseRepXml — fixture sintético contra Pagos20.xsd', () => {
  it('lee el pago, su fecha, su forma real y el docto que liquida', () => {
    const r = parseRepXml(REP_SINTETICO);
    expect(r).not.toBeNull();
    expect(r!.uuid).toBe(UUID_REP.toLowerCase());
    expect(r!.pagos).toHaveLength(1);
    const pago = r!.pagos[0];
    expect(pago.fechaPago).toBe('2026-09-02T12:00:00');
    expect(pago.formaDePagoP).toBe('03');
    expect(pago.doctos).toHaveLength(1);
    expect(pago.doctos[0]).toMatchObject({
      idDocumento: UUID_PPD.toLowerCase(),
      impPagado: 11600,
      impSaldoInsoluto: 0,
      numParcialidad: 1,
      ivaPagado: 1600,
    });
  });

  it('un CFDI que NO es tipo P devuelve null — el camino 1:1 sigue siendo suyo', () => {
    const ingreso = REP_SINTETICO.replace('TipoDeComprobante="P"', 'TipoDeComprobante="I"');
    expect(parseRepXml(ingreso)).toBeNull();
  });

  it('un IdDocumento en el formato viejo (no UUID) se ignora sin tirar la ingesta', () => {
    const viejo = REP_SINTETICO.replace(`IdDocumento="${UUID_PPD}"`, 'IdDocumento="003-02-000000000001"');
    expect(parseRepXml(viejo)).toBeNull(); // era el único docto → sin pagos legibles
  });

  it('sin ImporteDR el IVA queda undefined — no se recalcula con una tasa asumida', () => {
    const sinImporte = REP_SINTETICO.replace(' ImporteDR="1600.00"', '');
    const r = parseRepXml(sinImporte);
    expect(r!.pagos[0].doctos[0].ivaPagado).toBeUndefined();
  });

  it('parseCfdiXml sigue reconociendo el tipo P (para el enrutamiento del processor)', () => {
    const x = parseCfdiXml(REP_SINTETICO);
    expect(x?.tipoComprobante).toBe('P');
  });
});

describe('metodoPagoSat — el atributo que dice si un CFDI espera un REP', () => {
  it('PUE y PPD pasan, con normalización de caja', () => {
    expect(metodoPagoSat('PPD')).toBe('PPD');
    expect(metodoPagoSat('pue')).toBe('PUE');
  });
  it('basura y ausencia van a undefined — mejor perder el accesorio que el CFDI', () => {
    expect(metodoPagoSat('XXX')).toBeUndefined();
    expect(metodoPagoSat(undefined)).toBeUndefined();
    expect(metodoPagoSat('')).toBeUndefined();
  });
  it('parseCfdiXml lo extrae del comprobante', () => {
    const cfdi = `<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" TipoDeComprobante="I"
      Fecha="2026-08-01T10:00:00" Total="1160" SubTotal="1000" MetodoPago="PPD" FormaPago="99" Moneda="MXN">
      <cfdi:Conceptos><cfdi:Concepto ClaveProdServ="15101505" Cantidad="40" ClaveUnidad="LTR" Importe="1000"/></cfdi:Conceptos>
      <cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="${UUID_PPD}"/></cfdi:Complemento>
    </cfdi:Comprobante>`;
    const x = parseCfdiXml(cfdi);
    expect(x?.metodoPago).toBe('PPD');
    expect(x?.formaPago).toBe('99');
  });
});

// ── La ingesta: idempotencia y la regla fail-closed del sello ──────────────

const upsert = vi.hoisted(() => vi.fn(async () => ({ error: null })));
const update = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => tabla === 'cfdi_pago'
      ? { upsert }
      : tabla === 'cfdi_xml'
        ? { upsert: async () => ({ error: null }) }
        : { // gasto
            update: (fila: Record<string, unknown>) => {
              update(fila);
              return { eq: () => ({ eq: () => ({ is: () => ({ select: async () => ({ data: [{ id: 'g1' }], error: null }) }) }) }) };
            },
            select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
          },
  }),
}));
vi.mock('@/lib/likida/presupuesto', () => ({ acotada: (q: unknown) => q }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

describe('ingerirRep — registro idempotente y sello fail-closed', () => {
  beforeEach(() => { upsert.mockClear(); update.mockClear(); });

  it('registra el docto con la llave de idempotencia y sella el gasto liquidado', async () => {
    const { ingerirRep } = await import('./rep');
    const rep = parseRepXml(REP_SINTETICO)!;
    const r = await ingerirRep('t-1', rep, REP_SINTETICO);
    expect(upsert).toHaveBeenCalledTimes(1);
    const [fila, opts] = upsert.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(opts).toMatchObject({ onConflict: 'tenant_id,cfdi_uuid,docto_relacionado_uuid', ignoreDuplicates: true });
    expect(fila).toMatchObject({
      tenant_id: 't-1',
      cfdi_uuid: UUID_REP.toLowerCase(),
      docto_relacionado_uuid: UUID_PPD.toLowerCase(),
      fecha_pago: '2026-09-02',
      forma_pago_p: '03',
      iva_pagado: 1600,
    });
    // El sello: pagado_en con la FECHA DEL PAGO y la forma real del REP.
    expect(update).toHaveBeenCalledWith({ pagado_en: '2026-09-02', pagado_forma: '03' });
    expect(r).toMatchObject({ doctos: 1, sellados: 1, parciales: 0 });
  });

  it('una PARCIALIDAD (ImpSaldoInsoluto > 0) se registra pero NO sella — fail-closed', async () => {
    const { ingerirRep } = await import('./rep');
    const parcial = REP_SINTETICO
      .replace('ImpPagado="11600.00" ImpSaldoInsoluto="0"', 'ImpPagado="5800.00" ImpSaldoInsoluto="5800.00"');
    const rep = parseRepXml(parcial)!;
    const r = await ingerirRep('t-1', rep, parcial);
    expect(upsert).toHaveBeenCalledTimes(1);   // el rastro SÍ queda
    expect(update).not.toHaveBeenCalled();     // el gasto NO se sella
    expect(r).toMatchObject({ doctos: 1, sellados: 0, parciales: 1 });
  });

  it('un ImpSaldoInsoluto ilegible NO es cero: tampoco sella', async () => {
    const { ingerirRep } = await import('./rep');
    const roto = REP_SINTETICO.replace('ImpSaldoInsoluto="0"', 'ImpSaldoInsoluto="no-numero"');
    const rep = parseRepXml(roto)!;
    const r = await ingerirRep('t-1', rep, roto);
    expect(update).not.toHaveBeenCalled();
    expect(r.sellados).toBe(0);
  });

  it('si el registro en cfdi_pago falla, ese docto NO se sella — sellar sin rastro sería un pago sin evidencia', async () => {
    upsert.mockResolvedValueOnce({ error: { message: 'boom' } as never });
    const { ingerirRep } = await import('./rep');
    const rep = parseRepXml(REP_SINTETICO)!;
    const r = await ingerirRep('t-1', rep, REP_SINTETICO);
    expect(update).not.toHaveBeenCalled();
    expect(r).toMatchObject({ doctos: 0, sellados: 0 });
  });
});

describe('mensajeRepRecibido — el acuse dice exactamente lo que pasó', () => {
  it('sellado completo', () => {
    const m = mensajeRepRecibido({ doctos: 1, ligados: 1, sellados: 1, parciales: 0, pendientes: 0 });
    expect(m).toContain('pagada');
    expect(m).toContain('LIVA 5-III');
  });
  it('parcialidad: no promete un IVA que aún no se libera', () => {
    const m = mensajeRepRecibido({ doctos: 1, ligados: 1, sellados: 0, parciales: 1, pendientes: 0 });
    expect(m).toContain('saldo pendiente');
    expect(m).not.toContain('quedó marcada como pagada');
  });
  it('sin factura que liquidar: la verdad, con el dato conservado', () => {
    const m = mensajeRepRecibido({ doctos: 1, ligados: 0, sellados: 0, parciales: 0, pendientes: 0 });
    expect(m).toContain('No encontré facturas');
  });
  // AUDITORÍA 28 (AG-C1/REN-C1): documentos que no dio tiempo de procesar.
  it('con pendientes: pide reenviar el mismo complemento, sin decir "no encontré facturas"', () => {
    const m = mensajeRepRecibido({ doctos: 3, ligados: 3, sellados: 2, parciales: 0, pendientes: 5 });
    expect(m).toContain('5 documentos');
    expect(m).toContain('reenvía el mismo complemento');
    expect(m).not.toContain('No encontré facturas');
  });
  it('con pendientes y sin ningún sello/parcial: tampoco dice "no encontré facturas"', () => {
    const m = mensajeRepRecibido({ doctos: 0, ligados: 0, sellados: 0, parciales: 0, pendientes: 1 });
    expect(m).toContain('1 documento');
    expect(m).not.toContain('No encontré facturas');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28 (AG-C1/REN-C1, CRÍTICO): `ingerirRep` no miraba el reloj — un
// complemento consolidado con muchos doctos (un fajo real de una estación)
// podía cortarse a la mitad cuando Vercel mata la invocación, perdiendo en
// silencio el resto sin registro ni aviso. `venceEn` corta ANTES de arrancar
// un docto nuevo (nunca a medias), y el registro en `cfdi_pago` es
// idempotente: reenviar el MISMO REP más tarde retoma justo donde se cortó.
// ═══════════════════════════════════════════════════════════════════════════
describe('ingerirRep — corte por reloj (venceEn) y reanudación sin duplicar', () => {
  beforeEach(() => { upsert.mockClear(); update.mockClear(); });

  /** 150 doctos sintéticos, cada uno liquidado por completo (impSaldoInsoluto=0). */
  const repDeNDoctos = (n: number, prefijoUuid: string): RepXmlData => ({
    uuid: UUID_REP.toLowerCase(),
    pagos: [{
      fechaPago: '2026-09-02T12:00:00',
      formaDePagoP: '03',
      doctos: Array.from({ length: n }, (_, i) => ({
        idDocumento: `${prefijoUuid}${String(i).padStart(4, '0')}`,
        impPagado: 100,
        impSaldoInsoluto: 0,
        numParcialidad: 1,
        ivaPagado: 16,
      })),
    }],
  });

  it('corta ANTES del docto 64 cuando venceEn ya pasó — 63 procesados, 87 pendientes, nada a medias', async () => {
    const { ingerirRep } = await import('./rep');
    // Date.now() solo lo llama el chequeo de venceEn en este camino (acotada,
    // logger y los mocks de supabase están sustituidos sin reloj real) — la
    // n-ésima llamada devuelve n-1, así que con venceEn=63 la llamada #64
    // (valor 63) es la primera que corta.
    let llamada = 0;
    const relojFalso = vi.spyOn(Date, 'now').mockImplementation(() => llamada++);
    try {
      const rep = repDeNDoctos(150, 'aaaaaaaa-0000-0000-0000-000000000');
      const r = await ingerirRep('t-1', rep, 'xml-crudo', 63);
      expect(r.doctos).toBe(63);
      expect(r.sellados).toBe(63);
      expect(r.pendientes).toBe(87);
      expect(upsert).toHaveBeenCalledTimes(63);
      expect(update).toHaveBeenCalledTimes(63);
    } finally {
      relojFalso.mockRestore();
    }
  });

  it('una segunda llamada sin corte completa el resto sin duplicar lo ya sellado (idempotencia real del upsert)', async () => {
    const { ingerirRep } = await import('./rep');
    const rep = repDeNDoctos(150, 'bbbbbbbb-0000-0000-0000-000000000');
    // Primera pasada: sin venceEn, todos los 150 se intentan de una vez —
    // el `upsert` real (mockeado aquí) es ON CONFLICT DO NOTHING, así que
    // reenviar el MISMO rep una segunda vez no duplica nada nuevo: cada
    // docto ya existente vuelve a pasar por upsert (idempotente) y su gasto
    // ya está sellado (`pagado_en` no es null), así que `update` no vuelve a
    // encontrar filas para ese docto en un REP real — aquí el mock de
    // `update` siempre "encuentra" fila, así que lo que se verifica es que
    // NINGÚN docto se pierde entre las dos pasadas, no el conteo de sellados
    // de la segunda (eso depende del estado real de `gasto`, fuera del mock).
    const r1 = await ingerirRep('t-1', rep, 'xml-crudo');
    expect(r1.doctos).toBe(150);
    expect(r1.pendientes).toBe(0);
    upsert.mockClear(); update.mockClear();
    const r2 = await ingerirRep('t-1', rep, 'xml-crudo');
    expect(r2.doctos).toBe(150); // upsert es ON CONFLICT DO NOTHING: reenviar no falla ni se salta
    expect(upsert).toHaveBeenCalledTimes(150);
  });

  it('sin venceEn (uso interno/pruebas) no corta nunca, aunque el reloj avance', async () => {
    const { ingerirRep } = await import('./rep');
    vi.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER);
    try {
      const rep = repDeNDoctos(5, 'cccccccc-0000-0000-0000-000000000');
      const r = await ingerirRep('t-1', rep, 'xml-crudo');
      expect(r.doctos).toBe(5);
      expect(r.pendientes).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
