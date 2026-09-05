import { describe, it, expect } from 'vitest';
import { cuadrarViaje, cubetaDe, type PoliticaGasto } from './engine';
import type { Gasto, Diferencia } from '@/types/likida';

// AUDITORÍA 8: un CFDI con `cfdiUuid` y sin `rfcReceptor` ahora cuenta como
// "no se puede verificar a nombre de quién está" (el hallazgo que cerró el
// crítico fiscal pendiente). Estos fixtures se escribieron ANTES de esa regla
// y representan, salvo que digan lo contrario, un CFDI ya verificado — así
// que `g()` les pone un receptor por default cuando traen `cfdiUuid` y no lo
// declaran. Un test que sí quiera ejercitar el receptor faltante lo hace
// pasando `rfcReceptor: undefined` explícito, que gana sobre el default.
const RECEPTOR_VERIFICADO_DEFAULT = 'REC010101AA1';
const g = (p: Partial<Gasto>): Gasto => ({
  id: Math.random().toString(36).slice(2),
  concepto: 'diesel',
  monto: 0,
  ocrConfianza: 0.95,
  ...(p.cfdiUuid && !('rfcReceptor' in p) ? { rfcReceptor: RECEPTOR_VERIFICADO_DEFAULT } : {}),
  ...p,
});

const politica: PoliticaGasto[] = [
  { concepto: 'diesel', topeMonto: 2500 },
  { concepto: 'caseta', topeMonto: 1000 },
  { concepto: 'factura', requiereCfdi: true },
];

// Los RFC de estos fixtures pasan el DÍGITO VERIFICADOR a propósito. Desde el
// 28-jul-2026 el motor ignora un RFC de empresa mal formado —lo trata como dato
// que falta, no como algo contra lo que rechazar facturas—, así que un fixture
// inventado apagaba en silencio la validación que la prueba quería ejercer.
describe('cuadrarViaje', () => {
  it('cuadra exacto cuando comprobado = anticipo y todo dentro de política', () => {
    const r = cuadrarViaje({
      viajeId: 'v1', anticipo: 3000, politica,
      gastos: [g({ concepto: 'diesel', monto: 2000, folio: 'A1' }), g({ concepto: 'caseta', monto: 1000, folio: 'C1' })],
    });
    expect(r.totalComprobado).toBe(3000);
    expect(r.diferencia).toBe(0);
    expect(r.estatus).toBe('cuadrada');
    expect(r.diferencias).toHaveLength(0);
  });

  it('detecta sobre-política, faltante de CFDI y diferencia de anticipo', () => {
    const r = cuadrarViaje({
      viajeId: 'v2', anticipo: 5000, politica,
      gastos: [
        g({ concepto: 'diesel', monto: 3000, folio: 'D1' }),          // 500 sobre tope 2500
        g({ concepto: 'caseta', monto: 800, folio: 'C1' }),
        g({ concepto: 'factura', monto: 800, folio: 'F1' }),          // requiere CFDI, sin uuid
      ],
    });
    expect(r.totalComprobado).toBe(4600);
    expect(r.diferencia).toBe(400); // sobró anticipo, a favor empresa
    const tipos = r.diferencias.map((d) => d.tipo).sort();
    expect(tipos).toContain('sobre_politica');
    expect(tipos).toContain('sin_cfdi');
    expect(tipos).toContain('anticipo');
    expect(r.estatus).toBe('revisar'); // sin_cfdi → revisar
  });

  it('detecta comprobantes duplicados (mismo folio+monto)', () => {
    const r = cuadrarViaje({
      viajeId: 'v3', anticipo: 4000, politica,
      gastos: [
        g({ concepto: 'diesel', monto: 2000, folio: 'DUP' }),
        g({ concepto: 'diesel', monto: 2000, folio: 'DUP' }),
      ],
    });
    expect(r.diferencias.some((d) => d.tipo === 'duplicado')).toBe(true);
    expect(r.estatus).toBe('con_diferencias');
  });

  it('marca baja confianza de OCR para revisión', () => {
    const r = cuadrarViaje({
      viajeId: 'v4', anticipo: 1000, politica,
      gastos: [g({ concepto: 'caseta', monto: 1000, folio: 'C9', ocrConfianza: 0.5 })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'ocr_baja_confianza')).toBe(true);
    expect(r.estatus).toBe('revisar');
  });

  it('duplicado por UUID NO infla el total (fix del audit)', () => {
    const r = cuadrarViaje({
      viajeId: 'v5', anticipo: 2000, politica,
      gastos: [
        g({ concepto: 'diesel', monto: 2000, cfdiUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', folio: 'X1' }),
        g({ concepto: 'diesel', monto: 2000, cfdiUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', folio: 'X2' }),
      ],
    });
    expect(r.totalComprobado).toBe(2000); // NO 4000
    expect(r.diferencias.some((d) => d.tipo === 'duplicado')).toBe(true);
  });

  // AUDITORÍA 18, CRÍTICO: la migración 0065 separó por escrito dos hechos que
  // no son el mismo —"este gasto NACIÓ de ese CFDI" (1:1, lo que hay que
  // impedir) y "este gasto está AMPARADO por ese CFDI" (N:1, la factura de
  // CAPUFE)— y movió el índice único a `(tenant_id, cfdi_uuid, cfdi_orden)`.
  // El motor nunca se enteró: deduplicaba SOLO por uuid, así que las ocho
  // casetas de una factura consolidada entraban como una y siete "duplicados".
  it('una factura que AMPARA N casetas (CAPUFE) suma las N — no es un duplicado', () => {
    const uuid = 'ffffffff-1111-2222-3333-444444444444';
    const r = cuadrarViaje({
      viajeId: 'v-capufe', anticipo: 2000, politica,
      gastos: Array.from({ length: 8 }, (_, i) =>
        g({ concepto: 'caseta', monto: 250, cfdiUuid: uuid, cfdiOrden: i + 1, folio: `CAP-${i + 1}` })),
    });
    expect(r.totalComprobado).toBe(2000); // NO 250
    expect(r.diferencias.some((d) => d.tipo === 'duplicado')).toBe(false);
  });

  // El otro lado de la misma moneda: el `cfdi_orden` repetido SÍ es el mismo
  // comprobante dos veces, y la base tampoco lo admite.
  it('mismo uuid y MISMO orden sigue siendo duplicado', () => {
    const uuid = 'ffffffff-5555-6666-7777-888888888888';
    const r = cuadrarViaje({
      viajeId: 'v-dup-orden', anticipo: 500, politica,
      gastos: [
        g({ concepto: 'caseta', monto: 250, cfdiUuid: uuid, cfdiOrden: 2, folio: 'D1' }),
        g({ concepto: 'caseta', monto: 250, cfdiUuid: uuid, cfdiOrden: 2, folio: 'D2' }),
      ],
    });
    expect(r.totalComprobado).toBe(250);
    expect(r.diferencias.some((d) => d.tipo === 'duplicado')).toBe(true);
  });

  it('detecta RFC receptor distinto al de la empresa', () => {
    const r = cuadrarViaje({
      viajeId: 'v6', anticipo: 1000, politica, empresaRfc: 'EMP010101AA2',
      gastos: [g({ concepto: 'factura', monto: 1000, folio: 'F1', cfdiUuid: 'u', rfcReceptor: 'CHOFER800101XY1' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'rfc_receptor')).toBe(true);
    expect(r.estatus).toBe('revisar');
  });

  it('detecta CFDI cancelado ante el SAT', () => {
    const r = cuadrarViaje({
      viajeId: 'v7', anticipo: 1000, politica,
      gastos: [g({ concepto: 'factura', monto: 1000, folio: 'F2', cfdiUuid: 'u2', estadoSat: 'cancelado' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'cfdi_cancelado')).toBe(true);
  });

  it('SAT pendiente NO tumba: continúa como revisar — y NO se afirma deducible (auditoría 12)', () => {
    const r = cuadrarViaje({
      viajeId: 'v8', anticipo: 1000, politica,
      gastos: [g({ concepto: 'factura', monto: 1000, folio: 'F3', cfdiUuid: 'u3', estadoSat: 'pendiente', ivaTraslado: 96.55 })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'cfdi_pendiente')).toBe(true);
    expect(r.estatus).toBe('revisar');
    // AUDITORÍA 12, ALTO (reincidente de la 11): "no se pudo verificar" es el
    // mismo tercer estado que el motor aplica a EFOS/RFC/complemento — nunca
    // deducible, nunca acreditable. Antes caía en deducible con IVA en verde
    // cuando el SAT estaba caído; una tarde con el servicio lento afirmaba
    // liquidaciones enteras sin un solo UUID confirmado.
    const cubetas = r.totalPorConfirmar ?? 0;
    expect(cubetas).toBeGreaterThan(0);
    expect(r.ivaAcreditable ?? 0).toBe(0);
  });

  // 1.9: EFOS con código no concluyente → bandeja, NUNCA fraude.
  it('1.9: EFOS no concluyente → cfdi_efos_indeterminado (revisar, no fraude)', () => {
    const r = cuadrarViaje({
      viajeId: 'e1', anticipo: 1000, politica,
      gastos: [g({ concepto: 'factura', monto: 1000, cfdiUuid: 'u', estadoSat: 'vigente', efosRevisar: true })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'cfdi_efos_indeterminado')).toBe(true);
    expect(r.diferencias.some((d) => d.tipo === 'cfdi_efos')).toBe(false);
    expect(r.estatus).toBe('revisar');
  });

  // AUDITORÍA 21, CRÍTICO (fiscal): desde que la auditoría 9 quitó —con razón—
  // el mapeo `'100' → efos: true` (ConsultaCFDIService no distingue presunto de
  // definitivo), NADA produce `efos: true`, así que un emisor YA publicado en el
  // listado DEFINITIVO del 69-B llega aquí como `efosRevisar: true`... y
  // `cfdi_efos_indeterminado` no estaba en POR_CONFIRMAR ni en
  // SIN_ACREDITAMIENTO. Resultado: el CFDI caía en la cubeta `deducible` y su
  // IVA se acreditaba completo, en verde, citando LIVA 5 — sobre operaciones que
  // el CFF 69-B 4º párrafo declara sin "efecto fiscal alguno". El tercer estado
  // correcto es el de `cfdi_pendiente`: nunca deducible, nunca acreditable,
  // hasta que alguien coteje el listado a mano.
  it('AUD-21: EFOS no concluyente NO se afirma deducible ni acredita IVA (CFF 69-B)', () => {
    const r = cuadrarViaje({
      viajeId: 'e2', anticipo: 9280, politica: [{ concepto: 'diesel', topeMonto: 20000 }],
      gastos: [g({
        concepto: 'diesel', monto: 9280, cfdiUuid: 'efos-1111-2222-3333-444444444444',
        estadoSat: 'vigente', efosRevisar: true, xmlVerificado: true,
        ivaTraslado: 1280, formaPago: '04',
      })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'cfdi_efos_indeterminado')).toBe(true);
    // El escenario del hallazgo: $8,000.00 + $1,280.00 de IVA de un emisor en
    // DEFINITIVA salía "Deducible para ISR" e "IVA acreditable" en verde.
    expect(r.totalDeducible).toBe(0);
    expect(r.totalPorConfirmar).toBe(9280);
    expect(r.ivaAcreditable ?? 0).toBe(0);
    // Sin sobre-bloquear: el servicio no distingue presunto de definitivo, así
    // que NO es un "no deducible" duro (eso sería declarar fraude sobre un
    // presunto con derecho a desvirtuar) — es por confirmar.
    expect(r.totalNoDeducible).toBe(0);
    expect(r.estatus).toBe('revisar');
  });

  // CR-3: un CFDI que el SAT NO reconoce (fabricado) no debe pasar como cuadrado.
  it('CR-3: CFDI no_encontrado se marca no deducible y manda a revisar', () => {
    const r = cuadrarViaje({
      viajeId: 'v9', anticipo: 1000, politica,
      gastos: [g({ concepto: 'factura', monto: 1000, folio: 'F4', cfdiUuid: 'u4', estadoSat: 'no_encontrado' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'cfdi_no_encontrado')).toBe(true);
    expect(r.estatus).toBe('revisar');
  });

  // ME-5: un monto ≤ 0 no debe reducir el total ni sesgar la diferencia.
  it('ME-5: monto negativo no reduce el total y se marca monto_invalido', () => {
    const r = cuadrarViaje({
      viajeId: 'v10', anticipo: 2000, politica,
      gastos: [
        g({ concepto: 'diesel', monto: 2000, folio: 'D2' }),
        g({ concepto: 'caseta', monto: -500, folio: 'C2' }), // OCR erróneo / nota de crédito
      ],
    });
    expect(r.totalComprobado).toBe(2000); // NO 1500
    expect(r.diferencia).toBe(0);
    expect(r.diferencias.some((d) => d.tipo === 'monto_invalido')).toBe(true);
    expect(r.estatus).toBe('revisar');
  });

  // AL-6: con el RFC genérico del SAT NO se valida el receptor (evita falsos positivos).
  it('AL-6: RFC de empresa genérico no marca facturas como no-deducibles', () => {
    const r = cuadrarViaje({
      viajeId: 'v11', anticipo: 1000, politica, empresaRfc: 'XAXX010101000',
      gastos: [g({ concepto: 'factura', monto: 1000, folio: 'F5', cfdiUuid: 'u5', rfcReceptor: 'CUALQUIER800101XY1' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'rfc_receptor')).toBe(false);
  });

  // AL-6 (contraparte): un RFC real SÍ valida el receptor.
  it('AL-6: RFC real de empresa sí valida el receptor', () => {
    const r = cuadrarViaje({
      viajeId: 'v12', anticipo: 1000, politica, empresaRfc: 'TIN950101AB0',
      gastos: [g({ concepto: 'factura', monto: 1000, folio: 'F6', cfdiUuid: 'u6', rfcReceptor: 'TIN950101AB0' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'rfc_receptor')).toBe(false); // coincide → OK
  });

  // ═══ Bloque 1: complemento de hidrocarburos (dos niveles) ═══
  const HC = { claves: ['15101505', '15101514', '15101515'], unidad: 'LTR', vigenteDesde: '2026-04-24' };

  // NIVEL 1: factura de combustible (con UUID) SIN XML → no verificable, a bandeja,
  // NUNCA no deducible.
  it('B1 NIVEL 1: combustible con UUID sin XML → complemento_no_verificable (no no-deducible)', () => {
    const r = cuadrarViaje({
      viajeId: 'h1', anticipo: 4200, politica, hidrocarburos: HC,
      gastos: [g({ concepto: 'diesel', monto: 4200, folio: 'D1', cfdiUuid: 'uuid-diesel', fecha: '2026-05-01' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'complemento_no_verificable')).toBe(true);
    expect(r.diferencias.some((d) => d.tipo === 'complemento_hidrocarburos')).toBe(false);
    expect(r.estatus).toBe('revisar');
  });

  // NIVEL 1: ticket de diésel SIN UUID (no es factura) → NO se marca complemento.
  it('B1 NIVEL 1: diésel sin UUID no dispara complemento (no es CFDI)', () => {
    const r = cuadrarViaje({
      viajeId: 'h2', anticipo: 3800, politica, hidrocarburos: HC,
      gastos: [g({ concepto: 'diesel', monto: 3800, folio: 'D2', fecha: '2026-05-01' })],
    });
    expect(r.diferencias.some((d) => d.tipo.startsWith('complemento'))).toBe(false);
  });

  // NIVEL 2: XML de combustible SIN el nodo del complemento. El HECHO se detecta
  // igual, pero el VEREDICTO depende de que la ficha respalde la exigibilidad.
  // Hoy `normas/rmf-2026-2.7.1.48.yaml` trae `fecha_vigencia_desde: null` —la
  // regla sigue redactada en futuro—, así que se avisa y se manda a revisión sin
  // declarar no deducible. Ver `complemento_exigibilidad.test.ts`.
  it('B1 NIVEL 2: XML sin complemento y exigibilidad SIN confirmar → aviso, no veredicto', () => {
    const r = cuadrarViaje({
      viajeId: 'h3', anticipo: 4200, politica, hidrocarburos: HC,
      gastos: [g({ concepto: 'diesel', monto: 4200, cfdiUuid: 'u', fecha: '2026-05-01', xmlVerificado: true, claveProdServ: '15101505', claveUnidad: 'LTR', tipoComprobante: 'I', complementoHidrocarburos: false })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'complemento_hidrocarburos')).toBe(false);
    expect(r.diferencias.some((d) => d.tipo === 'complemento_no_verificable')).toBe(true);
    expect(r.totalNoDeducible).toBe(0);
    expect(r.estatus).toBe('revisar');
  });

  // NIVEL 2 con la fecha ya confirmada → regla DURA, no deducible.
  it('B1 NIVEL 2: XML sin complemento y exigibilidad CONFIRMADA → complemento_hidrocarburos', () => {
    const r = cuadrarViaje({
      viajeId: 'h3b', anticipo: 4200, politica, hidrocarburos: { ...HC, exigibleDesde: '2026-04-24' },
      gastos: [g({ concepto: 'diesel', monto: 4200, cfdiUuid: 'u', fecha: '2026-05-01', xmlVerificado: true, claveProdServ: '15101505', claveUnidad: 'LTR', tipoComprobante: 'I', complementoHidrocarburos: false })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'complemento_hidrocarburos')).toBe(true);
    expect(r.diferencias.some((d) => d.tipo === 'complemento_no_verificable')).toBe(false);
    expect(r.totalNoDeducible).toBe(4200);
    expect(r.estatus).toBe('revisar');
  });

  // NIVEL 2: XML CON el complemento → sin diferencia.
  it('B1 NIVEL 2: XML de combustible CON complemento → sin diferencia', () => {
    const r = cuadrarViaje({
      viajeId: 'h4', anticipo: 4200, politica, hidrocarburos: HC,
      gastos: [g({ concepto: 'diesel', monto: 4200, cfdiUuid: 'u', fecha: '2026-05-01', xmlVerificado: true, claveProdServ: '15101505', claveUnidad: 'LTR', tipoComprobante: 'I', complementoHidrocarburos: true })],
    });
    expect(r.diferencias.some((d) => d.tipo.startsWith('complemento'))).toBe(false);
  });

  // Vigencia: un CFDI ANTERIOR al 24-abr-2026 no exige complemento.
  it('B1 vigencia: CFDI antes del 24-abr-2026 no exige complemento', () => {
    const r = cuadrarViaje({
      viajeId: 'h5', anticipo: 4200, politica, hidrocarburos: HC,
      gastos: [g({ concepto: 'diesel', monto: 4200, cfdiUuid: 'u', fecha: '2026-03-01', xmlVerificado: true, claveProdServ: '15101505', claveUnidad: 'LTR', tipoComprobante: 'I', complementoHidrocarburos: false })],
    });
    expect(r.diferencias.some((d) => d.tipo.startsWith('complemento'))).toBe(false);
  });

  // Sin config de hidrocarburos, la regla NO corre (retrocompat).
  it('B1: sin config de hidrocarburos la regla no corre', () => {
    const r = cuadrarViaje({
      viajeId: 'h6', anticipo: 4200, politica,
      gastos: [g({ concepto: 'diesel', monto: 4200, cfdiUuid: 'u', fecha: '2026-05-01' })],
    });
    expect(r.diferencias.some((d) => d.tipo.startsWith('complemento'))).toBe(false);
  });

  // Verificación oficial: LTR NO es requisito de la regla → sin complemento, la
  // regla dura corre AUNQUE la unidad no sea LTR (evita falso negativo).
  it('B1 NIVEL 2: sin complemento aplica aunque la unidad no sea LTR', () => {
    const r = cuadrarViaje({
      viajeId: 'h7', anticipo: 4200, politica, hidrocarburos: { ...HC, exigibleDesde: '2026-04-24' },
      gastos: [g({ concepto: 'diesel', monto: 4200, cfdiUuid: 'u', fecha: '2026-05-01', xmlVerificado: true, claveProdServ: '15101505', claveUnidad: 'E48', tipoComprobante: 'I', complementoHidrocarburos: false })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'complemento_hidrocarburos')).toBe(true);
  });

  // Verificación oficial: ECC/Carta Porte quedan EXCLUIDOS de la regla 2.7.1.48.
  it('B1 NIVEL 2: esquema alterno (ECC/Carta Porte) NO dispara la regla', () => {
    const r = cuadrarViaje({
      viajeId: 'h8', anticipo: 4200, politica, hidrocarburos: HC,
      gastos: [g({ concepto: 'diesel', monto: 4200, cfdiUuid: 'u', fecha: '2026-05-01', xmlVerificado: true, claveProdServ: '15101505', claveUnidad: 'LTR', tipoComprobante: 'I', complementoHidrocarburos: false, cfdiEsquemaAlterno: true })],
    });
    expect(r.diferencias.some((d) => d.tipo.startsWith('complemento'))).toBe(false);
  });

  // ═══ NIVEL 1: acreditamiento fiscal ═══
  const EST = { peajeFactor: 0.5, viaticosTopeFiscalDiarioMxn: 750, efectivoTopeMxn: 2000, clavesDieselIeps: ['15101505'] };

  it('7/9: IVA acreditable de un CFDI de diésel deducible (el IEPS ya NO sale en pesos)', () => {
    const r = cuadrarViaje({
      viajeId: 'a1', anticipo: 5000, politica, hidrocarburos: HC, estimulos: EST,
      gastos: [g({ concepto: 'diesel', monto: 5000, cfdiUuid: 'u', fecha: '2026-05-01', xmlVerificado: true, claveProdServ: '15101505', claveUnidad: 'LTR', tipoComprobante: 'I', complementoHidrocarburos: true, formaPago: '03', iepsTraslado: 900, ivaTraslado: 640 })],
    });
    // El IEPS trasladado (900) NO es el estímulo: `normas/lif-2026-20-A.yaml`
    // dice "cuota vigente × LITROS. No es el IEPS trasladado en el CFDI".
    expect(r.iepsAcreditable).toBe(0);
    expect(r.ivaAcreditable).toBe(640);
  });

  it('5: combustible en efectivo NO acredita IEPS/IVA', () => {
    // La facilidad del 15% (RFA 2026 regla 2.9) salva la DEDUCCIÓN de ISR, pero NO
    // habilita el acreditamiento del IEPS. Son dos beneficios distintos, y el
    // efectivo solo conserva uno: el acreditamiento sigue bloqueado.
    const r = cuadrarViaje({
      viajeId: 'a2', anticipo: 5000, politica, hidrocarburos: HC, estimulos: EST,
      gastos: [g({ concepto: 'diesel', monto: 5000, cfdiUuid: 'u', fecha: '2026-05-01', xmlVerificado: true, claveProdServ: '15101505', claveUnidad: 'LTR', tipoComprobante: 'I', complementoHidrocarburos: true, formaPago: '01', iepsTraslado: 900, ivaTraslado: 640 })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'combustible_efectivo')).toBe(true);
    expect(r.iepsAcreditable).toBe(0);
    expect(r.ivaAcreditable).toBe(0);
    expect(r.estatus).toBe('revisar'); // sí se revisa: hay que contarlo contra el 15%
  });

  it('5b: el aviso de combustible en efectivo NO afirma que sea no deducible', () => {
    // Decía "no deducible" a secas. Para el autotransporte de carga federal es
    // FALSO: la RFA 2026 regla 2.9 lo tiene por deducible hasta el 15% del total
    // pagado por combustible en el ejercicio. Un motor que lo declare no deducible
    // le está quitando dinero real a la flota.
    const r = cuadrarViaje({
      viajeId: 'a2b', anticipo: 5000, politica, hidrocarburos: HC, estimulos: EST,
      gastos: [g({ concepto: 'diesel', monto: 5000, cfdiUuid: 'u', fecha: '2026-05-01', xmlVerificado: true, claveProdServ: '15101505', claveUnidad: 'LTR', tipoComprobante: 'I', complementoHidrocarburos: true, formaPago: '01' })],
    });
    const nota = r.diferencias.find((d) => d.tipo === 'combustible_efectivo')!.nota;
    expect(nota).not.toMatch(/no deducible/i);
    expect(nota).toMatch(/15\s*%/);      // dice contra qué se compara
    expect(nota).toMatch(/2\.9/);        // y con qué fundamento
  });

  it('1.6: peaje acreditable = 50% del SubTotal de casetas', () => {
    const r = cuadrarViaje({
      viajeId: 'a3', anticipo: 1160, politica, estimulos: EST,
      // La prueba aísla la base del estímulo; la flota ya declaró elegibilidad.
      elegiblePeaje: true,
      gastos: [g({ concepto: 'caseta', monto: 1160, cfdiUuid: 'u', xmlVerificado: true, formaPago: '04', subTotal: 1000, ivaTraslado: 160 })],
    });
    expect(r.peajeAcreditable).toBe(500); // 1000 * 0.5
    expect(r.ivaAcreditable).toBe(160);
  });

  // Ticket 5 (Cd. Juárez, franja fronteriza): IVA al 8%. El acreditable es el
  // importe LEÍDO del comprobante, NUNCA recomputado con 16%.
  it('IVA 8% fronterizo: se acredita el importe leído, no se recomputa al 16%', () => {
    const r = cuadrarViaje({
      viajeId: 'a7', anticipo: 200, politica, hidrocarburos: HC, estimulos: EST,
      gastos: [g({ concepto: 'diesel', monto: 200, cfdiUuid: 'u', fecha: '2026-05-01', xmlVerificado: true,
        claveProdServ: '15101505', claveUnidad: 'LTR', tipoComprobante: 'I', complementoHidrocarburos: true,
        formaPago: '03', subTotal: 185.65, ivaTraslado: 14.35, iepsTraslado: 120.00 })],
    });
    expect(r.ivaAcreditable).toBe(14.35);  // leído (8%), NO 29.70 (16%)
    // El IEPS trasladado ya no se acredita como estímulo (ver LIF 20-A).
    expect(r.iepsAcreditable).toBe(0);
  });

  // La GASOLINA no tiene el estímulo de IEPS (solo diésel, LIF Art. 20-A fr. IV).
  it('gasolina (15101514) con IEPS desglosado NO acredita IEPS (solo diésel)', () => {
    const r = cuadrarViaje({
      viajeId: 'a9', anticipo: 500, politica, hidrocarburos: HC, estimulos: EST,
      gastos: [g({ concepto: 'diesel', monto: 500, cfdiUuid: 'u', fecha: '2026-05-01', xmlVerificado: true,
        claveProdServ: '15101514', claveUnidad: 'LTR', tipoComprobante: 'I', complementoHidrocarburos: true,
        formaPago: '04', iepsTraslado: 90, ivaTraslado: 65 })],
    });
    expect(r.iepsAcreditable).toBe(0);   // gasolina → sin estímulo IEPS
    expect(r.ivaAcreditable).toBe(65);   // el IVA sí es acreditable
    expect(r.diferencias.some((d) => d.tipo === 'ieps_no_desglosado')).toBe(false);
  });

  // #1: validación de cordura de la fecha (periodo fiscal / plazo / complemento).
  it('#1 fecha muy anterior al viaje → fecha_sospechosa (bandeja)', () => {
    const r = cuadrarViaje({
      viajeId: 'f1', anticipo: 1000, politica, fechaMin: '2026-07-01', fechaMax: '2026-07-25',
      gastos: [g({ concepto: 'caseta', monto: 1000, folio: 'C1', fecha: '2026-05-15' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'fecha_sospechosa')).toBe(true);
    expect(r.estatus).toBe('revisar');
  });

  it('#1 fecha FUTURA → fecha_sospechosa (caso del mes mal leído del ticket 4)', () => {
    const r = cuadrarViaje({
      viajeId: 'f2', anticipo: 1000, politica, fechaMin: '2026-07-01', fechaMax: '2026-07-25',
      gastos: [g({ concepto: 'caseta', monto: 1000, folio: 'C1', fecha: '2026-09-15' })], // futura
    });
    expect(r.diferencias.some((d) => d.tipo === 'fecha_sospechosa')).toBe(true);
  });

  it('#1 fecha dentro de rango NO dispara', () => {
    const r = cuadrarViaje({
      viajeId: 'f3', anticipo: 1000, politica, fechaMin: '2026-07-01', fechaMax: '2026-07-25',
      gastos: [g({ concepto: 'caseta', monto: 1000, folio: 'C1', fecha: '2026-07-10' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'fecha_sospechosa')).toBe(false);
  });

  // #3: folio de combustible con baja confianza (ticket 3 borroso) → avisar, no bloquear.
  it('#3 folio_verificar: folio de combustible con baja confianza avisa', () => {
    const r = cuadrarViaje({
      viajeId: 'f4', anticipo: 1000, politica,
      gastos: [g({ concepto: 'diesel', monto: 1000, folio: '841067', ocrConfianza: 0.6 })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'folio_verificar')).toBe(true);
  });

  // Bonus 0.6: CFDI real de FERRETERÍA (no combustible, tarjeta, IVA 16% exacto,
  // tipo I). El motor NO acredita IEPS donde no aplica, no marca falsos positivos.
  it('0.6 ferretería: no-combustible con IVA 16% → IVA acredita, IEPS no, sin falsos positivos', () => {
    const r = cuadrarViaje({
      viajeId: 'fer1', anticipo: 114.82, politica, hidrocarburos: HC, estimulos: EST,
      gastos: [g({ concepto: 'factura', monto: 114.82, cfdiUuid: '38a50290-59f1-4a48-b886-0a31f938837c', fecha: '2026-05-01', xmlVerificado: true, claveProdServ: '31162800', claveUnidad: 'H87', tipoComprobante: 'I', formaPago: '04', subTotal: 98.98, ivaTraslado: 15.84, estadoSat: 'vigente', efos: false })],
    });
    expect(r.iepsAcreditable).toBe(0);       // NO combustible → sin estímulo de IEPS
    expect(r.ivaAcreditable).toBe(15.84);    // IVA sí es acreditable
    expect(r.diferencias.some((d) => d.tipo.startsWith('complemento'))).toBe(false);
    expect(r.diferencias.some((d) => d.tipo === 'combustible_efectivo' || d.tipo === 'ieps_no_desglosado')).toBe(false);
    expect(r.estatus).toBe('cuadrada');       // anticipo = comprobado, sin diferencias
  });

  // Un ticket sin factura (sin xmlVerificado) NO acredita, aunque traiga montos.
  it('ticket sin CFDI verificado no acredita (necesita timbrarse)', () => {
    const r = cuadrarViaje({
      viajeId: 'a8', anticipo: 400, politica, hidrocarburos: HC, estimulos: EST,
      gastos: [g({ concepto: 'diesel', monto: 400, folio: 'T1', subTotal: 345, ivaTraslado: 55, formaPago: '04' })],
    });
    expect(r.ivaAcreditable).toBe(0);
    expect(r.iepsAcreditable).toBe(0);
  });

  it('7: diésel con XML pero SIN IEPS desglosado → ieps_no_desglosado', () => {
    const r = cuadrarViaje({
      viajeId: 'a4', anticipo: 4000, politica, hidrocarburos: HC, estimulos: EST,
      gastos: [g({ concepto: 'diesel', monto: 4000, cfdiUuid: 'u', fecha: '2026-05-01', xmlVerificado: true, claveProdServ: '15101505', claveUnidad: 'LTR', tipoComprobante: 'I', complementoHidrocarburos: true, formaPago: '03', iepsTraslado: 0 })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'ieps_no_desglosado')).toBe(true);
    expect(r.iepsAcreditable).toBe(0);
  });

  it('7b: el IEPS sin desglosar NO manda la liquidación a revisar POR SÍ SOLO', () => {
    // El gasto SÍ es deducible: lo único que se pierde es el acreditamiento del
    // estímulo. Mandarlo a `revisar` tumbaba TODA liquidación con diésel —y casi
    // ningún CFDI de gasolinera desglosa el IEPS al consumidor final—, con lo que
    // la bandeja de excepciones dejaba de significar algo.
    //
    // AUDITORÍA 8: esta liquidación SÍ queda hoy en 'revisar', pero por una razón
    // AJENA al IEPS — el permiso CRE (`permiso_cre_no_verificable.test.ts`), que
    // se dispara en CUALQUIER diésel con XML verificado, desglose el IEPS o no.
    // Se aísla la causa comparando contra un control con el IEPS SÍ desglosado:
    // si el estatus no cambia entre los dos, el IEPS no es quien lo decide.
    const sinDesglosar = cuadrarViaje({
      viajeId: 'a4b', anticipo: 4000, politica, hidrocarburos: HC, estimulos: EST,
      gastos: [g({ concepto: 'diesel', monto: 4000, cfdiUuid: 'u', fecha: '2026-05-01', xmlVerificado: true, claveProdServ: '15101505', claveUnidad: 'LTR', tipoComprobante: 'I', complementoHidrocarburos: true, formaPago: '03', iepsTraslado: 0 })],
    });
    const desglosado = cuadrarViaje({
      viajeId: 'a4b-control', anticipo: 4000, politica, hidrocarburos: HC, estimulos: EST,
      gastos: [g({ concepto: 'diesel', monto: 4000, cfdiUuid: 'u', fecha: '2026-05-01', xmlVerificado: true, claveProdServ: '15101505', claveUnidad: 'LTR', tipoComprobante: 'I', complementoHidrocarburos: true, formaPago: '03', iepsTraslado: 400 })],
    });
    expect(sinDesglosar.diferencias.some((d) => d.tipo === 'ieps_no_desglosado')).toBe(true); // se sigue avisando
    expect(desglosado.diferencias.some((d) => d.tipo === 'ieps_no_desglosado')).toBe(false);  // el control no lo trae
    expect(sinDesglosar.estatus).toBe(desglosado.estatus); // mismo estatus con o sin el IEPS: no es el IEPS quien lo decide
  });

  it('6: gasto no-combustible en efectivo > $2,000 → no deducible', () => {
    const r = cuadrarViaje({
      viajeId: 'a5', anticipo: 2500, politica: [], estimulos: EST,
      gastos: [g({ concepto: 'otro', monto: 2500, formaPago: '01' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'efectivo_sobre_tope')).toBe(true);
  });

  it('1.10: viático > tope fiscal $750/día, SIN timbrar → avisa, pero el excedente no es deducible de nadie TODAVÍA', () => {
    // AUDITORÍA 9, ALTO (fiscal): sin CFDI, el excedente no puede ser "no
    // deducible" — no es deducción de nadie hasta que se timbre (cae en
    // por_confirmar). `monto` refleja eso; la nota informa igual.
    const r = cuadrarViaje({
      viajeId: 'a6', anticipo: 900, politica, estimulos: EST,
      gastos: [g({ concepto: 'viaticos', monto: 900, folio: 'V1' })],
    });
    const d = r.diferencias.find((x) => x.tipo === 'viatico_excede_fiscal');
    expect(d).toBeTruthy();
    expect(d!.monto).toBe(0);
    expect(d!.nota).toMatch(/por confirmar/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TOTALES DE DEDUCIBILIDAD — la cifra que el contralor de verdad compra.
//
// El motor ya detectaba todo lo necesario y NO lo sumaba: el contralor tenía que
// leer la lista de diferencias y hacer la cuenta a mano. Son tres cubetas, no
// dos, porque el combustible en efectivo NO cae en ninguna de las dos clásicas:
// es deducible hasta el 15% del ejercicio (RFA 2026 regla 2.9) y ese contador
// todavía no existe. Meterlo en "no deducible" le quita dinero al cliente;
// meterlo en "deducible" le promete algo que quizá no tenga.
// ═══════════════════════════════════════════════════════════════════════════
describe('cuadrarViaje — totales de deducibilidad', () => {
  const EST = { peajeFactor: 0.5, viaticosTopeFiscalDiarioMxn: 750, efectivoTopeMxn: 2000, clavesDieselIeps: ['15101505'] };

  it('todo limpio → todo deducible', () => {
    const r = cuadrarViaje({
      viajeId: 't1', anticipo: 3000, politica, estimulos: EST,
      gastos: [g({ concepto: 'diesel', monto: 2000, folio: 'A1', formaPago: '04', cfdiUuid: 'f1' }), g({ concepto: 'caseta', monto: 1000, folio: 'C1', formaPago: '04', cfdiUuid: 'f2' })],
    });
    expect(r.totalDeducible).toBe(3000);
    expect(r.totalNoDeducible).toBe(0);
    expect(r.totalPorConfirmar).toBe(0);
  });

  it('un CFDI cancelado se va entero a no deducible', () => {
    const r = cuadrarViaje({
      viajeId: 't2', anticipo: 3000, politica, estimulos: EST,
      gastos: [
        g({ concepto: 'caseta', monto: 1000, folio: 'C1', formaPago: '04', cfdiUuid: 'f3' }),
        g({ concepto: 'factura', monto: 2000, cfdiUuid: 'u1', estadoSat: 'cancelado', formaPago: '04' }),
      ],
    });
    expect(r.totalNoDeducible).toBe(2000);
    expect(r.totalDeducible).toBe(1000);
  });

  it('del viático solo el EXCEDENTE es no deducible, no el gasto entero', () => {
    // LISR 28-V topa la alimentación en $750/día. Un viático de $900 no se pierde
    // completo: se pierden $150. Mandar los $900 a no deducible es el error que
    // más dinero le cuesta al cliente en esta lista.
    const r = cuadrarViaje({
      viajeId: 't3', anticipo: 900, politica: [], estimulos: EST,
      gastos: [g({ concepto: 'viaticos', monto: 900, folio: 'V1', formaPago: '04', cfdiUuid: 'f4' })],
    });
    expect(r.totalNoDeducible).toBe(150);
    expect(r.totalDeducible).toBe(750);
  });

  it('el combustible en efectivo va a POR CONFIRMAR, ni deducible ni perdido', () => {
    const r = cuadrarViaje({
      viajeId: 't4', anticipo: 1500, politica, estimulos: EST,
      gastos: [g({ concepto: 'diesel', monto: 1500, folio: 'D1', formaPago: '01' })],
    });
    expect(r.totalPorConfirmar).toBe(1500);
    expect(r.totalNoDeducible).toBe(0);
    expect(r.totalDeducible).toBe(0);
  });

  it('un gasto no-combustible en efectivo sobre el tope SÍ es no deducible', () => {
    // Aquí no hay facilidad que valga: LISR 27-III sin excepción para el sector.
    const r = cuadrarViaje({
      viajeId: 't5', anticipo: 2500, politica: [], estimulos: EST,
      gastos: [g({ concepto: 'otro', monto: 2500, folio: 'O1', formaPago: '01', cfdiUuid: 'f5' })],
    });
    expect(r.totalNoDeducible).toBe(2500);
    expect(r.totalPorConfirmar).toBe(0);
  });

  it('las tres cubetas SIEMPRE suman el total comprobado', () => {
    // La invariante que hace confiable la cifra: si no cuadra, el contralor lo
    // nota con una calculadora y pierde la confianza en todo lo demás.
    const r = cuadrarViaje({
      viajeId: 't6', anticipo: 9000, politica, estimulos: EST,
      gastos: [
        g({ concepto: 'diesel', monto: 2000, folio: 'D1', formaPago: '04', cfdiUuid: 'f6' }),
        g({ concepto: 'diesel', monto: 1500, folio: 'D2', formaPago: '01', cfdiUuid: 'f7' }), // por confirmar
        g({ concepto: 'viaticos', monto: 900, folio: 'V1', formaPago: '04', cfdiUuid: 'f8' }),  // 150 fuera
        g({ concepto: 'factura', monto: 2000, cfdiUuid: 'u1', estadoSat: 'cancelado', formaPago: '04' }),
        g({ concepto: 'caseta', monto: 1000, folio: 'C1', formaPago: '04', cfdiUuid: 'f9' }),
      ],
    });
    const suma = r.totalDeducible + r.totalNoDeducible + r.totalPorConfirmar;
    expect(suma).toBeCloseTo(r.totalComprobado, 2);
  });

  it('un duplicado no cuenta en ninguna cubeta', () => {
    const r = cuadrarViaje({
      viajeId: 't7', anticipo: 2000, politica, estimulos: EST,
      gastos: [
        g({ concepto: 'caseta', monto: 1000, cfdiUuid: 'dup', formaPago: '04' }),
        g({ concepto: 'caseta', monto: 1000, cfdiUuid: 'dup', formaPago: '04' }),
      ],
    });
    expect(r.totalComprobado).toBe(1000);
    expect(r.totalDeducible + r.totalNoDeducible + r.totalPorConfirmar).toBe(1000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VIÁTICOS: el tope de $750 es SOLO de alimentación, y es POR DÍA.
//
// LISR 28-V topa la alimentación nacional en $750 por día y por beneficiario.
// Antes el motor lo aplicaba (a) a todo lo etiquetado "viaticos", incluido el
// hospedaje —que NO tiene tope nacional—, y (b) por COMPROBANTE, así que tres
// comidas de $400 el mismo día pasaban limpias mientras una sola de $800 se
// marcaba. Las dos cosas dan cifras falsas al contralor.
// ═══════════════════════════════════════════════════════════════════════════
describe('cuadrarViaje — tope de viáticos', () => {
  const EST = { peajeFactor: 0.5, viaticosTopeFiscalDiarioMxn: 750, efectivoTopeMxn: 2000, clavesDieselIeps: ['15101505'] };

  it('el hospedaje NO tiene tope nacional: $2,000 pasa limpio', () => {
    const r = cuadrarViaje({
      viajeId: 'w1', anticipo: 2000, politica: [], estimulos: EST,
      gastos: [g({ concepto: 'hospedaje', monto: 2000, fecha: '2026-05-01', formaPago: '04' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'viatico_excede_fiscal')).toBe(false);
    expect(r.totalNoDeducible).toBe(0);
  });

  it('la alimentación sí: $900 en un día, CON CFDI, marca $150 no deducibles', () => {
    // AUDITORÍA 9: `cfdiUuid` a propósito — sin timbrar, el excedente no es
    // deducción de nadie todavía (ver "1.10" arriba, que cubre ese caso).
    const r = cuadrarViaje({
      viajeId: 'w2', anticipo: 900, politica: [], estimulos: EST,
      gastos: [g({ concepto: 'alimentacion', monto: 900, fecha: '2026-05-01', formaPago: '04', cfdiUuid: 'u-w2', xmlVerificado: true })],
    });
    const d = r.diferencias.find((x) => x.tipo === 'viatico_excede_fiscal')!;
    expect(d.monto).toBe(150);
  });

  it('el tope es POR DÍA, no por comprobante: tres comidas timbradas de $400 el mismo día exceden', () => {
    // Es el hueco que dejaba pasar el gasto real: partir la cuenta en tres
    // tickets del mismo día burlaba un tope aplicado comprobante por comprobante.
    // Timbradas a propósito (AUDITORÍA 9): sin CFDI el excedente no es
    // deducible de nadie todavía, y esta prueba mide el reparto en dinero.
    const r = cuadrarViaje({
      viajeId: 'w3', anticipo: 1200, politica: [], estimulos: EST,
      gastos: [
        g({ concepto: 'alimentacion', monto: 400, fecha: '2026-05-01', formaPago: '04', cfdiUuid: 'u-w3a', xmlVerificado: true }),
        g({ concepto: 'alimentacion', monto: 400, fecha: '2026-05-01', formaPago: '04', cfdiUuid: 'u-w3b', xmlVerificado: true }),
        g({ concepto: 'alimentacion', monto: 400, fecha: '2026-05-01', formaPago: '04', cfdiUuid: 'u-w3c', xmlVerificado: true }),
      ],
    });
    const total = r.diferencias.filter((x) => x.tipo === 'viatico_excede_fiscal').reduce((s, x) => s + (x.monto ?? 0), 0);
    expect(total).toBe(450); // 1200 - 750
  });

  // AUDITORÍA 9, ALTO (fiscal) — el escenario EXACTO del hallazgo: dos
  // comprobantes SIN timbrar de un día ($1,200 y $800) excedían el tope y el
  // papel imprimía "el excedente de $1,250.00 no es deducible" en la misma
  // hoja donde el desglose decía "No deducible $0.00" — ninguna cubeta
  // contenía esos $1,250, porque nada estaba timbrado.
  it('dos comprobantes SIN timbrar que exceden el tope: el monto de la diferencia ya no contradice el desglose', () => {
    const r = cuadrarViaje({
      viajeId: 'w-sin-timbrar', anticipo: 2000, politica: [], estimulos: EST,
      gastos: [
        g({ concepto: 'alimentacion', monto: 1200, fecha: '2026-07-20', formaPago: '04' }),
        g({ concepto: 'alimentacion', monto: 800, fecha: '2026-07-20', formaPago: '04' }),
      ],
    });
    const d = r.diferencias.find((x) => x.tipo === 'viatico_excede_fiscal')!;
    expect(d, 'sigue avisando: el contralor necesita saber que ese gasto tampoco va a deducir completo').toBeTruthy();
    expect(d.monto, 'nada está timbrado: el excedente no es deducible de NADIE todavía').toBe(0);
    expect(d.nota).not.toMatch(/no es deducible/); // ya no afirma lo que el desglose desmiente
    expect(r.totalNoDeducible, 'el desglose y la diferencia ahora dicen lo mismo').toBe(d.monto);
  });

  it('un día MIXTO (timbrado + sin timbrar): el monto es SOLO el exceso de lo timbrado', () => {
    const r = cuadrarViaje({
      viajeId: 'w-mixto', anticipo: 2700, politica: [], estimulos: EST,
      gastos: [
        g({ concepto: 'alimentacion', monto: 700, fecha: '2026-07-20', formaPago: '04', cfdiUuid: 'u-mixto', xmlVerificado: true }),
        g({ concepto: 'alimentacion', monto: 2000, fecha: '2026-07-20', formaPago: '04' }), // sin timbrar
      ],
    });
    const d = r.diferencias.find((x) => x.tipo === 'viatico_excede_fiscal')!;
    // $700 timbrados NO exceden el tope de $750 por sí solos: nada es no
    // deducible hoy, aunque el día completo ($2,700) sí lo exceda.
    expect(d.monto).toBe(0);
    expect(r.totalNoDeducible).toBe(0);
  });

  it('comidas de días distintos NO se suman entre sí', () => {
    const r = cuadrarViaje({
      viajeId: 'w4', anticipo: 1200, politica: [], estimulos: EST,
      gastos: [
        g({ concepto: 'alimentacion', monto: 600, fecha: '2026-05-01', formaPago: '04' }),
        g({ concepto: 'alimentacion', monto: 600, fecha: '2026-05-02', formaPago: '04' }),
      ],
    });
    expect(r.diferencias.some((x) => x.tipo === 'viatico_excede_fiscal')).toBe(false);
  });

  it('"viaticos" a secas sigue topado: es lo que emitía el OCR viejo', () => {
    // Compatibilidad: los gastos ya guardados con el concepto genérico no se
    // pueden reclasificar solos. Se mantiene el criterio conservador.
    const r = cuadrarViaje({
      viajeId: 'w5', anticipo: 900, politica: [], estimulos: EST,
      gastos: [g({ concepto: 'viaticos', monto: 900, fecha: '2026-05-01', formaPago: '04' })],
    });
    expect(r.diferencias.some((x) => x.tipo === 'viatico_excede_fiscal')).toBe(true);
  });

  it('el transporte del operador no lleva tope de alimentación', () => {
    const r = cuadrarViaje({
      viajeId: 'w6', anticipo: 1500, politica: [], estimulos: EST,
      gastos: [g({ concepto: 'transporte', monto: 1500, fecha: '2026-05-01', formaPago: '04' })],
    });
    expect(r.diferencias.some((x) => x.tipo === 'viatico_excede_fiscal')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EL TICKET QUE SE VA A QUEDAR SIN FACTURA.
//
// Un ticket de gasolinera NO es factura: hay que timbrarlo en el portal del
// emisor, y ese portal cierra su ventana. Si nadie lo hace a tiempo, el gasto
// deja de ser deducible — el dinero ya salió y el IVA se pierde.
//
// Se avisa con la regla GENERAL (dentro del mes natural de la operación), que
// es la documentada. Los plazos por cadena (5-15 días) siguen SIN VERIFICAR y
// por eso no se afirman: se dice que la ventana del comercio puede ser menor.
// ═══════════════════════════════════════════════════════════════════════════
describe('cuadrarViaje — aviso de ticket por facturar', () => {
  const EST = { peajeFactor: 0.5, viaticosTopeFiscalDiarioMxn: 750, efectivoTopeMxn: 2000, clavesDieselIeps: ['15101505'] };
  const conPortal = (over: Partial<Gasto> = {}) => g({
    concepto: 'diesel', monto: 1000, folio: 'T1', formaPago: '04',
    ocrExtra: { urlFacturacion: 'https://facturacion.oxxogas.com/' }, ...over,
  });

  it('avisa cuando el mes está por cerrarse', () => {
    const r = cuadrarViaje({
      viajeId: 'p1', anticipo: 1000, politica: [], estimulos: EST, hoy: '2026-05-30',
      gastos: [conPortal({ fecha: '2026-05-02' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'factura_por_vencer')).toBe(true);
  });

  // Esta prueba decía "no molesta a principio de mes" y exigía SILENCIO. Cambió
  // a propósito el 28-jul-2026: sobre ocho tickets de campo, $9,070 sin timbrar
  // con portal reconocido pasaron a tres días del cierre sin una palabra en la
  // liquidación, que es un documento de una sola vez. Ahora se informa siempre;
  // lo que se reserva para el final es el TONO de urgencia.
  it('a principio de mes informa, pero sin urgencia', () => {
    const r = cuadrarViaje({
      viajeId: 'p2', anticipo: 1000, politica: [], estimulos: EST, hoy: '2026-05-05',
      gastos: [conPortal({ fecha: '2026-05-02' })],
    });
    const a = r.diferencias.filter((d) => d.tipo === 'factura_por_vencer');
    expect(a).toHaveLength(1);
    expect(a[0].nota).toContain('2026-05-31');       // dice hasta cuándo
    expect(a[0].nota).not.toContain('para timbrarlo'); // pero no mete prisa
  });

  it('si ya se timbró, no hay nada que avisar', () => {
    const r = cuadrarViaje({
      viajeId: 'p3', anticipo: 1000, politica: [], estimulos: EST, hoy: '2026-05-30',
      gastos: [conPortal({ fecha: '2026-05-02', cfdiUuid: 'ya-timbrado' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'factura_por_vencer')).toBe(false);
  });

  it('sin liga de portal no aplica: no todo ticket se factura en línea', () => {
    const r = cuadrarViaje({
      viajeId: 'p4', anticipo: 1000, politica: [], estimulos: EST, hoy: '2026-05-30',
      gastos: [g({ concepto: 'diesel', monto: 1000, folio: 'T2', fecha: '2026-05-02', formaPago: '04' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'factura_por_vencer')).toBe(false);
  });

  it('sin fecha confiable NO se afirma un plazo', () => {
    // El OCR ya devolvió 2023 en un ticket de 2026. Decirle a alguien "te
    // quedan 2 días" con una fecha inventada es peor que no decir nada.
    const r = cuadrarViaje({
      viajeId: 'p5', anticipo: 1000, politica: [], estimulos: EST, hoy: '2026-05-30',
      gastos: [conPortal({ fecha: undefined })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'factura_por_vencer')).toBe(false);
  });

  it('el aviso NO afirma un plazo por comercio: dice que puede ser menor', () => {
    const r = cuadrarViaje({
      viajeId: 'p6', anticipo: 1000, politica: [], estimulos: EST, hoy: '2026-05-30',
      gastos: [conPortal({ fecha: '2026-05-02' })],
    });
    const nota = r.diferencias.find((d) => d.tipo === 'factura_por_vencer')!.nota;
    expect(nota).toMatch(/puede ser menor|antes/i);
    expect(nota).not.toMatch(/\b(5|7|15) días\b/); // no inventa el plazo de la cadena
  });

  it('sin `hoy` la regla no corre: no se asume la fecha del servidor', () => {
    const r = cuadrarViaje({
      viajeId: 'p7', anticipo: 1000, politica: [], estimulos: EST,
      gastos: [conPortal({ fecha: '2026-05-02' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'factura_por_vencer')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H1 y RLISR 57 — las dos reglas que le quitaban deducciones legítimas.
// ═══════════════════════════════════════════════════════════════════════════
describe('cuadrarViaje — soporte de la alimentación (LISR 28-V) y RFC del viático (RLISR 57)', () => {
  const EST = { peajeFactor: 0.5, viaticosTopeFiscalDiarioMxn: 750, efectivoTopeMxn: 2000, clavesDieselIeps: ['15101505'] };

  it('H1: alimentación sin hospedaje ni transporte en el viaje se marca', () => {
    // LISR 28-V: el tope de $750 procede "y el contribuyente acompañe el comprobante
    // fiscal... que ampare el hospedaje o transporte". Una comida sola no lo cumple.
    const r = cuadrarViaje({
      viajeId: 'h1a', anticipo: 400, politica: [], estimulos: EST,
      gastos: [g({ concepto: 'alimentacion', monto: 400, fecha: '2026-05-01', formaPago: '04' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'alimentacion_sin_soporte')).toBe(true);
  });

  it('H1: con hospedaje en el viaje, la alimentación queda soportada', () => {
    const r = cuadrarViaje({
      viajeId: 'h1b', anticipo: 1400, politica: [], estimulos: EST,
      gastos: [
        g({ concepto: 'alimentacion', monto: 400, fecha: '2026-05-01', formaPago: '04' }),
        g({ concepto: 'hospedaje', monto: 1000, fecha: '2026-05-01', formaPago: '04' }),
      ],
    });
    expect(r.diferencias.some((d) => d.tipo === 'alimentacion_sin_soporte')).toBe(false);
  });

  it('H1: el transporte también sirve de soporte', () => {
    const r = cuadrarViaje({
      viajeId: 'h1c', anticipo: 700, politica: [], estimulos: EST,
      gastos: [
        g({ concepto: 'alimentacion', monto: 400, fecha: '2026-05-01', formaPago: '04' }),
        g({ concepto: 'transporte', monto: 300, fecha: '2026-05-01', formaPago: '04' }),
      ],
    });
    expect(r.diferencias.some((d) => d.tipo === 'alimentacion_sin_soporte')).toBe(false);
  });

  // AUDITORÍA 10, MEDIO REINCIDENTE — un hospedaje de $1 SIN TIMBRAR bastaba
  // para apagar la advertencia sobre una comida de $700 sin soporte real. El
  // propio motor ya clasificaba ese hospedaje en `por_confirmar` (ver
  // `cubetaDe`) y aun así lo usaba como amparo válido.
  it('H1: un hospedaje de monto TRIVIAL y SIN CFDI no ampara nada — la advertencia sigue', () => {
    const r = cuadrarViaje({
      viajeId: 'h1e', anticipo: 701, politica: [], estimulos: EST,
      gastos: [
        g({ concepto: 'alimentacion', monto: 700, fecha: '2026-05-01', formaPago: '04' }),
        g({ concepto: 'hospedaje', monto: 1, fecha: '2026-05-01', formaPago: '04' }),
      ],
    });
    expect(r.diferencias.some((d) => d.tipo === 'alimentacion_sin_soporte')).toBe(true);
  });

  it('H1: un hospedaje TRIVIAL pero YA TIMBRADO sí ampara (es un CFDI real, aunque chico)', () => {
    const r = cuadrarViaje({
      viajeId: 'h1f', anticipo: 701, politica: [], estimulos: EST,
      gastos: [
        g({ concepto: 'alimentacion', monto: 700, fecha: '2026-05-01', formaPago: '04' }),
        g({ concepto: 'hospedaje', monto: 1, fecha: '2026-05-01', formaPago: '04', cfdiUuid: 'u' }),
      ],
    });
    expect(r.diferencias.some((d) => d.tipo === 'alimentacion_sin_soporte')).toBe(false);
  });

  it('H1: un hospedaje de monto normal SIN TIMBRAR sigue amparando (sigue siendo un comprobante real en tránsito)', () => {
    const r = cuadrarViaje({
      viajeId: 'h1g', anticipo: 1100, politica: [], estimulos: EST,
      gastos: [
        g({ concepto: 'alimentacion', monto: 400, fecha: '2026-05-01', formaPago: '04' }),
        g({ concepto: 'hospedaje', monto: 500, fecha: '2026-05-01', formaPago: '04' }),
      ],
    });
    expect(r.diferencias.some((d) => d.tipo === 'alimentacion_sin_soporte')).toBe(false);
  });

  it('H1: se marca para revisión, NO se declara no deducible', () => {
    // No vemos toda la contabilidad de la flota: el comprobante de hospedaje puede
    // existir fuera de esta liquidación. Declararlo no deducible sería el mismo
    // error al revés — quitarle una deducción que quizá sí tiene.
    const r = cuadrarViaje({
      viajeId: 'h1d', anticipo: 400, politica: [], estimulos: EST,
      gastos: [g({ concepto: 'alimentacion', monto: 400, fecha: '2026-05-01', formaPago: '04', cfdiUuid: 'fa' })],
    });
    expect(r.estatus).toBe('revisar');
    expect(r.totalNoDeducible).toBe(0);
    expect(r.totalDeducible).toBe(400);
  });

  it('RLISR 57: el viático a nombre del OPERADOR es válido', () => {
    // "Si benefician a personas que le prestan servicios personales subordinados,
    // los comprobantes fiscales podrán ser expedidos a nombre de dichas personas."
    const r = cuadrarViaje({
      viajeId: 'r57a', anticipo: 1000, politica: [], estimulos: EST,
      empresaRfc: 'TIN950101AB0', operadorRfc: 'PEJJ800101XY7',
      gastos: [g({ concepto: 'hospedaje', monto: 1000, fecha: '2026-05-01', formaPago: '04', cfdiUuid: 'u', rfcReceptor: 'PEJJ800101XY7' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'rfc_receptor')).toBe(false);
    expect(r.totalNoDeducible).toBe(0);
  });

  it('RLISR 57: sin saber el RFC del operador, se REVISA en vez de rechazar', () => {
    const r = cuadrarViaje({
      viajeId: 'r57b', anticipo: 1000, politica: [], estimulos: EST,
      empresaRfc: 'TIN950101AB0',
      gastos: [g({ concepto: 'hospedaje', monto: 1000, fecha: '2026-05-01', formaPago: '04', cfdiUuid: 'u', rfcReceptor: 'PEJJ800101XY7' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'rfc_receptor')).toBe(false);
    expect(r.diferencias.some((d) => d.tipo === 'viatico_rfc_operador')).toBe(true);
    expect(r.totalNoDeducible).toBe(0); // NO se le quita la deducción
  });

  it('RLISR 57 NO cubre el diésel: ese sí debe ir a nombre de la empresa', () => {
    // El reglamento habla de VIÁTICOS. Una factura de combustible a nombre del
    // chofer sigue siendo un problema.
    const r = cuadrarViaje({
      viajeId: 'r57c', anticipo: 2000, politica: [], estimulos: EST,
      empresaRfc: 'TIN950101AB0', operadorRfc: 'PEJJ800101XY7',
      gastos: [g({ concepto: 'diesel', monto: 2000, formaPago: '04', cfdiUuid: 'u', rfcReceptor: 'PEJJ800101XY7' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'rfc_receptor')).toBe(true);
    expect(r.totalNoDeducible).toBe(2000);
  });

  it('un viático a un RFC que no es ni la empresa ni el operador SÍ se rechaza', () => {
    const r = cuadrarViaje({
      viajeId: 'r57d', anticipo: 1000, politica: [], estimulos: EST,
      empresaRfc: 'TIN950101AB0', operadorRfc: 'PEJJ800101XY7',
      gastos: [g({ concepto: 'hospedaje', monto: 1000, formaPago: '04', cfdiUuid: 'u', rfcReceptor: 'OTRO900101ZZ9' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'rfc_receptor')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// UN TICKET NO ES UNA FACTURA.
//
// LISR 27-III exige que la deducción esté "amparada con un comprobante fiscal".
// Un ticket de gasolinera NO lo es: hay que timbrarlo. Contarlo como deducible
// le promete al contralor una deducción que todavía no existe — y si nadie
// factura a tiempo, nunca existirá.
//
// Tampoco es una pérdida: se puede timbrar. Va a POR CONFIRMAR, como el efectivo.
// ═══════════════════════════════════════════════════════════════════════════
describe('cuadrarViaje — sin CFDI no hay deducción todavía', () => {
  const EST = { peajeFactor: 0.5, viaticosTopeFiscalDiarioMxn: 750, efectivoTopeMxn: 2000, clavesDieselIeps: ['15101505'] };

  it('un ticket sin CFDI va a POR CONFIRMAR, no a deducible', () => {
    const r = cuadrarViaje({
      viajeId: 'sc1', anticipo: 2000, politica: [], estimulos: EST,
      gastos: [g({ concepto: 'diesel', monto: 2000, folio: 'T1', formaPago: '04' })],
    });
    expect(r.totalPorConfirmar).toBe(2000);
    expect(r.totalDeducible).toBe(0);
    expect(r.totalNoDeducible).toBe(0);
  });

  it('con CFDI válido sí es deducible', () => {
    const r = cuadrarViaje({
      viajeId: 'sc2', anticipo: 2000, politica: [], estimulos: EST,
      gastos: [g({ concepto: 'diesel', monto: 2000, cfdiUuid: 'u', estadoSat: 'vigente', formaPago: '04' })],
    });
    expect(r.totalDeducible).toBe(2000);
    expect(r.totalPorConfirmar).toBe(0);
  });

  it('las tres cubetas siguen sumando el total', () => {
    const r = cuadrarViaje({
      viajeId: 'sc3', anticipo: 3000, politica: [], estimulos: EST,
      gastos: [
        g({ concepto: 'diesel', monto: 2000, folio: 'T1', formaPago: '04' }),          // sin CFDI
        g({ concepto: 'caseta', monto: 1000, cfdiUuid: 'u2', estadoSat: 'vigente', formaPago: '04' }),
      ],
    });
    expect(r.totalDeducible + r.totalNoDeducible + r.totalPorConfirmar).toBeCloseTo(3000, 2);
  });
});

// B5: el OCR ya detecta que el total del código y el del texto no coinciden y lo
// guarda en ocrExtra.montoDiscrepante — pero nadie lo miraba. Se quedaba en la
// base sin llegar jamás a la bandeja del contralor.
describe('cuadrarViaje — discrepancia entre el código y el OCR', () => {
  const EST = { peajeFactor: 0.5, viaticosTopeFiscalDiarioMxn: 750, efectivoTopeMxn: 2000, clavesDieselIeps: ['15101505'] };

  it('la discrepancia detectada en el intake SÍ llega a la bandeja', () => {
    const r = cuadrarViaje({
      viajeId: 'd1', anticipo: 4027, politica: [], estimulos: EST,
      gastos: [g({ concepto: 'diesel', monto: 4027.1, cfdiUuid: 'u', estadoSat: 'vigente', formaPago: '04',
        ocrExtra: { montoDiscrepante: true, montoOcr: 4000 } })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'monto_discrepante')).toBe(true);
    expect(r.estatus).toBe('revisar');
  });

  it('sin discrepancia no inventa el aviso', () => {
    const r = cuadrarViaje({
      viajeId: 'd2', anticipo: 4027, politica: [], estimulos: EST,
      gastos: [g({ concepto: 'diesel', monto: 4027.1, cfdiUuid: 'u', estadoSat: 'vigente', formaPago: '04' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'monto_discrepante')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// UN PAPEL QUE LE HABLA AL EXTRACTOR.
//
// El operador que liquida tiene un incentivo económico directo: infla lo
// comprobado y se queda con la diferencia del anticipo. No necesita tocar el
// código — le basta imprimir un renglón que le hable al modelo de visión.
//
// Medido contra el modelo real (pruebas-manuales/inyeccion.prueba.ts): NO
// obedece, captura el total impreso. Pero que el intento no funcione no lo
// vuelve irrelevante: alguien puso ahí ese texto a propósito, y quien decide
// sobre ese gasto merece enterarse.
// ═══════════════════════════════════════════════════════════════════════════
describe('cuadrarViaje — texto dirigido al lector automático', () => {
  it('levanta la observación y manda el viaje a revisar', () => {
    const r = cuadrarViaje({
      viajeId: 'v1', anticipo: 500, politica,
      gastos: [g({ concepto: 'diesel', monto: 487.5, folio: 'A1', cfdiUuid: 'u1',
                   ocrExtra: { textoSospechoso: true } })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'texto_sospechoso')).toBe(true);
    expect(r.estatus).toBe('revisar');
  });

  it('el gasto sigue contando por su monto IMPRESO: no se descarta ni se castiga', () => {
    // El dinero salió de verdad. Tirar el gasto por el texto raro le costaría a
    // la empresa una deducción legítima si el papel era bueno y el renglón lo
    // puso el comercio (un anuncio, una leyenda impresa).
    const r = cuadrarViaje({
      viajeId: 'v1', anticipo: 500, politica,
      gastos: [g({ concepto: 'diesel', monto: 487.5, folio: 'A1', cfdiUuid: 'u1',
                   ocrExtra: { textoSospechoso: true } })],
    });
    expect(r.totalComprobado).toBe(487.5);
    expect(r.totalDeducible).toBe(487.5);
  });

  it('sin la marca no inventa la observación', () => {
    const r = cuadrarViaje({
      viajeId: 'v1', anticipo: 500, politica,
      gastos: [g({ concepto: 'diesel', monto: 487.5, folio: 'A1', cfdiUuid: 'u1' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'texto_sospechoso')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EL ESTÍMULO DE IEPS NO ES EL IEPS TRASLADADO.
//
// `normas/lif-2026-20-A.yaml`, verificada contra fuente primaria, dice literal:
//   "cuota IEPS vigente al momento de la compra × LITROS.
//    No es el IEPS trasladado en el CFDI."
//
// El motor sumaba el trasladado y el PDF lo imprimía en verde citando ese
// artículo. Dos errores encima del otro: la fórmula equivocada, y una cifra en
// pesos que la decisión D2 del roadmap ya había prohibido enseñar —"sin
// discusión"— porque la cuota pasó de $7.3634 a $2.0925 en cinco meses y el
// estímulo es ingreso acumulable (infla la propuesta ~30%).
//
// Sin el acuerdo semanal del DOF no se puede calcular. Lo que SÍ se puede es
// contar los litros elegibles, que es el dato duro que el contador multiplica
// por la cuota que él tenga.
// ═══════════════════════════════════════════════════════════════════════════
describe('cuadrarViaje — estímulo de IEPS de diésel', () => {
  const conIeps = politica;
  const est = { clavesDieselIeps: ['15101514'], peajeFactor: 0.5, viaticosTopeFiscalDiarioMxn: 750, efectivoTopeMxn: 2000 };

  it('NO acredita pesos a partir del IEPS trasladado del CFDI', () => {
    const r = cuadrarViaje({
      viajeId: 'v1', anticipo: 5000, politica: conIeps, estimulos: est,
      gastos: [g({ concepto: 'diesel', monto: 4812, cfdiUuid: 'u1', claveProdServ: '15101514',
                   iepsTraslado: 1200, ocrExtra: { litros: 180 }, xmlVerificado: true, formaPago: '04' })],
    });
    expect(r.iepsAcreditable).toBe(0);
  });

  it('cuenta los LITROS elegibles, que es el dato que el contador sí puede usar', () => {
    const r = cuadrarViaje({
      viajeId: 'v1', anticipo: 5000, politica: conIeps, estimulos: est,
      gastos: [
        g({ concepto: 'diesel', monto: 4812, cfdiUuid: 'u1', claveProdServ: '15101514', ocrExtra: { litros: 180 }, xmlVerificado: true, formaPago: '04' }),
        g({ concepto: 'diesel', monto: 2000, cfdiUuid: 'u2', claveProdServ: '15101514', ocrExtra: { litros: 75 }, xmlVerificado: true, formaPago: '04' }),
      ],
    });
    expect(r.litrosDieselAcreditables).toBe(255);
  });

  it('sin litros leídos no inventa el dato', () => {
    const r = cuadrarViaje({
      viajeId: 'v1', anticipo: 5000, politica: conIeps, estimulos: est,
      gastos: [g({ concepto: 'diesel', monto: 4812, cfdiUuid: 'u1', claveProdServ: '15101514', xmlVerificado: true, formaPago: '04' })],
    });
    expect(r.litrosDieselAcreditables).toBe(0);
  });

  it('el diésel que no cumple el medio de pago NO suma litros', () => {
    // LIF 20-A-IV exige monedero, tarjeta, cheque nominativo o transferencia —
    // SIN la válvula del 15% que sí existe para ISR (RFA 2.9).
    const r = cuadrarViaje({
      viajeId: 'v1', anticipo: 5000, politica: conIeps, estimulos: est,
      gastos: [g({ concepto: 'diesel', monto: 4812, cfdiUuid: 'u1', claveProdServ: '15101514',
                   ocrExtra: { litros: 180 }, xmlVerificado: true, formaPago: '01' })],   // 01 = efectivo
    });
    expect(r.litrosDieselAcreditables).toBe(0);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // AUDITORÍA 8 · CRÍTICO fiscal — los litros salían del OCR sin cotejar contra
  // nada: ni el XML, ni precio×litros≈monto. Un decimal corrido en la lectura
  // (200.00 L leído como 20,000 L) acreditaba 100 VECES el estímulo real.
  // ═════════════════════════════════════════════════════════════════════════
  it('litros que no cuadran con el monto (un decimal corrido) NO se acreditan, y se marca para revisar', () => {
    const r = cuadrarViaje({
      viajeId: 'v1', anticipo: 10000, politica: conIeps, estimulos: est,
      gastos: [g({ concepto: 'diesel', monto: 5800, cfdiUuid: 'u1', claveProdServ: '15101514',
                   ocrExtra: { litros: 20000 }, xmlVerificado: true, formaPago: '04' })],
    });
    expect(r.litrosDieselAcreditables).toBe(0);
    expect((r.diferencias ?? []).map((d) => d.tipo)).toContain('diesel_desviacion');
    expect(r.estatus).toBe('revisar');
  });

  it('control: litros consistentes con el monto (~$27/L) SÍ se acreditan, sin marca', () => {
    // El mismo caso que ya cubre 'cuenta los LITROS elegibles' de arriba,
    // repetido aquí para dejar el contraste con el de encima en el mismo bloque.
    const r = cuadrarViaje({
      viajeId: 'v1', anticipo: 10000, politica: conIeps, estimulos: est,
      gastos: [g({ concepto: 'diesel', monto: 5800, cfdiUuid: 'u1', claveProdServ: '15101514',
                   ocrExtra: { litros: 215 }, xmlVerificado: true, formaPago: '04' })],   // $5800/215 ≈ $27/L
    });
    expect(r.litrosDieselAcreditables).toBe(215);
    expect((r.diferencias ?? []).map((d) => d.tipo)).not.toContain('diesel_desviacion');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// UN TICKET SIN TIMBRAR ES "POR CONFIRMAR", DIGA LO QUE DIGA LA POLÍTICA.
//
// `sin_cfdi` estaba en NO_DEDUCIBLE_ISR, que se evalúa ANTES que la regla de
// "sin cfdiUuid → POR CONFIRMAR". Resultado: el mismo hecho —un ticket sin
// timbrar— salía ROJO si el tenant tenía `requiereCfdi` en su política, y ÁMBAR
// si no. El veredicto dependía de un flag de configuración, no de la ley.
//
// Y el correcto es ámbar: LISR 27-III exige comprobante fiscal, pero el ticket
// TODAVÍA se puede timbrar. No es una deducción perdida, es una pendiente.
// Pintarla de rojo le dice al contralor que dé por perdido un dinero que puede
// recuperar con una llamada al portal.
//
// (Introducido el 28-jul al añadir la regla del ticket.)
// ═══════════════════════════════════════════════════════════════════════════
describe('cuadrarViaje — sin_cfdi no puede significar dos cosas', () => {
  const conRequisito: PoliticaGasto[] = [{ concepto: 'diesel', topeMonto: 9000, requiereCfdi: true }];
  const sinRequisito: PoliticaGasto[] = [{ concepto: 'diesel', topeMonto: 9000 }];
  const ticket = () => g({ concepto: 'diesel', monto: 4812, folio: 'T1', formaPago: '04' });

  it('con requiereCfdi va a POR CONFIRMAR, no a no deducible', () => {
    const r = cuadrarViaje({ viajeId: 'v1', anticipo: 5000, politica: conRequisito, gastos: [ticket()] });
    expect(r.totalPorConfirmar).toBe(4812);
    expect(r.totalNoDeducible).toBe(0);
  });

  it('el veredicto es el MISMO con y sin el flag de política', () => {
    const con = cuadrarViaje({ viajeId: 'v1', anticipo: 5000, politica: conRequisito, gastos: [ticket()] });
    const sin = cuadrarViaje({ viajeId: 'v1', anticipo: 5000, politica: sinRequisito, gastos: [ticket()] });
    expect(con.totalPorConfirmar).toBe(sin.totalPorConfirmar);
    expect(con.totalNoDeducible).toBe(sin.totalNoDeducible);
  });

  it('se sigue avisando: la política no es decorativa', () => {
    // Que no sea "perdido" no lo vuelve invisible. El contralor tiene que verlo
    // en la bandeja para que alguien lo timbre antes de que venza el mes.
    const r = cuadrarViaje({ viajeId: 'v1', anticipo: 5000, politica: conRequisito, gastos: [ticket()] });
    expect(r.diferencias.some((d) => d.tipo === 'sin_cfdi')).toBe(true);
    expect(r.estatus).toBe('revisar');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EL IVA DE UN GASTO PARCIALMENTE DEDUCIBLE SE ACREDITA EN PROPORCIÓN.
//
// LIVA art. 5 fr. I, texto verificado contra fuente primaria el 28-jul-2026:
//
//   "Tratándose de erogaciones PARCIALMENTE DEDUCIBLES para los fines del
//    impuesto sobre la renta, únicamente se considerará para los efectos del
//    acreditamiento... EN LA PROPORCIÓN en la que dichas erogaciones sean
//    deducibles para los fines del impuesto sobre la renta."
//
// El motor acreditaba el traslado COMPLETO. El caso que ocurre a diario: un
// viático de alimentación que excede el tope de LISR 28-V es deducible solo
// hasta el tope, así que su IVA solo se acredita en esa misma proporción.
//
// Acreditar de más es del lado caro: es el cliente quien responde ante una
// revisión, y el papel se lo dio Likida.
// ═══════════════════════════════════════════════════════════════════════════
describe('cuadrarViaje — IVA de gastos parcialmente deducibles (LIVA 5-I)', () => {
  const est = { peajeFactor: 0.5, viaticosTopeFiscalDiarioMxn: 750, efectivoTopeMxn: 2000, clavesDieselIeps: [] };
  const pol: PoliticaGasto[] = [{ concepto: 'alimentacion', topeMonto: 5000 }];

  it('el viático que excede el tope acredita su IVA EN PROPORCIÓN', () => {
    // $900 con tope $750 → deducible 83.33% → IVA acreditable 83.33% de $144.
    const r = cuadrarViaje({
      viajeId: 'v1', anticipo: 1000, politica: pol, estimulos: est,
      gastos: [g({ concepto: 'alimentacion', monto: 900, fecha: '2026-05-01', cfdiUuid: 'u1',
                   xmlVerificado: true, ivaTraslado: 144, formaPago: '04' })],
    });
    expect(r.ivaAcreditable).toBeCloseTo(144 * (750 / 900), 2);
    expect(r.ivaAcreditable).toBeLessThan(144);
  });

  it('un gasto totalmente deducible acredita su IVA completo', () => {
    const r = cuadrarViaje({
      viajeId: 'v1', anticipo: 1000, politica: pol, estimulos: est,
      gastos: [g({ concepto: 'alimentacion', monto: 700, fecha: '2026-05-01', cfdiUuid: 'u1',
                   xmlVerificado: true, ivaTraslado: 112, formaPago: '04' })],
    });
    expect(r.ivaAcreditable).toBe(112);
  });

  it('la proporción se calcula por gasto, no sobre el total del viaje', () => {
    // Uno excede y otro no: el que no excede conserva su IVA íntegro.
    const r = cuadrarViaje({
      viajeId: 'v1', anticipo: 2000, politica: pol, estimulos: est,
      gastos: [
        g({ concepto: 'alimentacion', monto: 900, fecha: '2026-05-01', cfdiUuid: 'u1', xmlVerificado: true, ivaTraslado: 144, formaPago: '04' }),
        g({ concepto: 'alimentacion', monto: 700, fecha: '2026-05-02', cfdiUuid: 'u2', xmlVerificado: true, ivaTraslado: 112, formaPago: '04' }),
      ],
    });
    expect(r.ivaAcreditable).toBeCloseTo(144 * (750 / 900) + 112, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EL EXCEDENTE DEL DÍA NO CABE EN UN SOLO COMPROBANTE.
//
// El exceso de alimentación se colgaba del ÚLTIMO gasto del día porque "tiene
// que vivir en alguno". Si ese último es MÁS CHICO que el exceso, la proporción
// deducible se recorta a 0 y lo que sobra no se descuenta de ningún lado: el
// motor SOBRE-acredita IVA.
//
// Reproducido por la auditoría 3: tres comidas del mismo día por $1,050 con
// tope de $750 → exceso de $300, colgado de un comprobante de $150. El IVA
// acreditado sale $160 cuando lo correcto son $120.
//
// Acreditar de más es del lado caro: responde el cliente ante una revisión.
// ═══════════════════════════════════════════════════════════════════════════
describe('cuadrarViaje — el excedente diario se reparte, no se cuelga de uno', () => {
  const est = { peajeFactor: 0.5, viaticosTopeFiscalDiarioMxn: 750, efectivoTopeMxn: 2000, clavesDieselIeps: [] };
  const pol: PoliticaGasto[] = [{ concepto: 'alimentacion', topeMonto: 5000 }];
  const comida = (monto: number, iva: number) =>
    g({ concepto: 'alimentacion', monto, fecha: '2026-05-01', cfdiUuid: `u${monto}`,
        xmlVerificado: true, ivaTraslado: iva, formaPago: '04' });

  it('el IVA acreditado corresponde a lo REALMENTE deducible del día', () => {
    // $1,050 en tres comidas, tope $750 → deducible el 71.43% del día.
    // IVA total $168 → acreditable $120.
    const r = cuadrarViaje({
      viajeId: 'v1', anticipo: 2000, politica: pol, estimulos: est,
      gastos: [comida(600, 96), comida(300, 48), comida(150, 24)],
    });
    expect(r.ivaAcreditable).toBeCloseTo(168 * (750 / 1050), 2);
  });

  it('el excedente total del día es el correcto, se cuelgue donde se cuelgue', () => {
    const r = cuadrarViaje({
      viajeId: 'v1', anticipo: 2000, politica: pol, estimulos: est,
      gastos: [comida(600, 96), comida(300, 48), comida(150, 24)],
    });
    const exceso = r.diferencias.filter((d) => d.tipo === 'viatico_excede_fiscal').reduce((s, d) => s + (d.monto ?? 0), 0);
    expect(exceso).toBe(300);
    expect(r.totalNoDeducible).toBe(300);
  });

  it('con un solo comprobante del día sigue funcionando igual', () => {
    const r = cuadrarViaje({
      viajeId: 'v1', anticipo: 2000, politica: pol, estimulos: est,
      gastos: [comida(900, 144)],
    });
    expect(r.ivaAcreditable).toBeCloseTo(144 * (750 / 900), 2);
    expect(r.totalNoDeducible).toBe(150);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AUDITORÍA 8 · CRÍTICO fiscal — el tope se repartía contra pesos que
  // TODAVÍA NO SON DEDUCCIÓN DE NADIE. `porDia` sumaba TODOS los gastos con
  // tope del día, timbrados o no, y esos $ sin CFDI diluían la proporción de
  // los que sí amparan. Una comida timbrada de $700 (bajo el tope de $750)
  // salía "$194.44 deducibles" solo porque otro ticket sin timbrar del mismo
  // día se sumó al denominador.
  // ═══════════════════════════════════════════════════════════════════════
  it('un ticket SIN timbrar del mismo día no diluye la proporción del que sí ampara', () => {
    const r = cuadrarViaje({
      viajeId: 'v1', anticipo: 5000, politica: pol, estimulos: est,
      gastos: [
        comida(700, 96.55),                                              // CON CFDI, bajo el tope
        g({ concepto: 'alimentacion', monto: 2000, fecha: '2026-05-01', formaPago: '01' }), // SIN CFDI
      ],
    });
    // $700 está POR DEBAJO del tope de $750 ENTRE LOS TIMBRADOS: deducible
    // completo. El ticket sin timbrar no debe restarle nada — antes salía
    // "$194.44 deducibles" solo porque el total del día lo diluía.
    expect(r.totalDeducible).toBe(700);
    expect(r.ivaAcreditable).toBe(96.55);
    expect(r.totalPorConfirmar).toBe(2000);
    expect(r.totalNoDeducible).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 4 · ALTO — la clasificación de dinero vivía en DOS archivos.
//
// `pdf.ts` reconstruía las cubetas desde `diferencias` con UN criterio (el tipo)
// y se saltaba el segundo (la ausencia de UUID). Como `sin_cfdi` solo se emite si
// la política del tenant trae `requiereCfdi`, y DEMO_CONFIG solo lo pone en
// `factura`, un hospedaje sin timbrar caía en `por_confirmar` para el motor y en
// NINGUNA cubeta para el PDF.
//
// Consecuencia: la sección "LO QUE SE LE REEMBOLSA AL OPERADOR" —que existe para
// impedir la lectura "no deducible ⇒ se lo descuento", que la LFT no permite—
// aparecía o desaparecía según un flag de configuración de la flota, no según la
// ley. Con la config del demo, desaparecía.
// ═══════════════════════════════════════════════════════════════════════════
describe('cubetaDe — la clasificación no depende de la política del tenant', () => {
  const gasto = (over: Partial<Gasto> = {}): Gasto => ({
    id: 'g1', concepto: 'hospedaje', monto: 2000, fecha: '2026-07-20', ...over,
  } as Gasto);

  it('un gasto sin CFDI es POR CONFIRMAR aunque no exista la diferencia `sin_cfdi`', () => {
    // Ese es exactamente el caso del demo: la política no pide CFDI para
    // hospedaje, así que no hay `sin_cfdi` que mirar. El ticket sigue sin timbrar.
    expect(cubetaDe(gasto({ cfdiUuid: undefined }), [])).toBe('por_confirmar');
  });

  it('con CFDI y sin diferencias es DEDUCIBLE', () => {
    expect(cubetaDe(gasto({ cfdiUuid: 'uuid-1' }), [])).toBe('deducible');
  });

  it('un veredicto definitivo manda a NO DEDUCIBLE', () => {
    const d = { tipo: 'cfdi_efos', concepto: 'diesel', monto: 0, nota: 'n', gastoId: 'g1' } as Diferencia;
    expect(cubetaDe(gasto({ cfdiUuid: 'uuid-1' }), [d])).toBe('no_deducible');
  });

  it('el motor y la cubeta cuentan lo mismo: hospedaje de $2,000 sin timbrar', () => {
    const r = cuadrarViaje({
      viajeId: 'v', anticipo: 2000, gastos: [gasto({ cfdiUuid: undefined })],
      politica: [{ concepto: 'hospedaje', topeMonto: 2500 }],   // como DEMO_CONFIG: sin requiereCfdi
    } as Parameters<typeof cuadrarViaje>[0]);
    expect(r.totalPorConfirmar).toBe(2000);
    expect(r.totalDeducible).toBe(0);
    expect(r.totalNoDeducible).toBe(0);
    // Y no hay ninguna diferencia `sin_cfdi` de la que el PDF pudiera enterarse.
    expect(r.diferencias.some((x) => x.tipo === 'sin_cfdi')).toBe(false);
  });
});

describe('ticket_monedero — FASE 2 / RMF 3.3.1.7', () => {
  const diesel = (over: Partial<Gasto> = {}): Gasto => ({
    id: 'g-d', concepto: 'diesel', monto: 5000, fecha: '2026-07-20', ...over,
  } as Gasto);

  it('RFC de emisor en la semilla → diferencia ticket_monedero, cubeta por_confirmar', () => {
    const r = cuadrarViaje({
      viajeId: 'v', anticipo: 5000, gastos: [diesel({ rfcEmisor: 'ASE930924SS7' })],
      politica: [{ concepto: 'diesel' }],
    });
    const d = r.diferencias.find((x) => x.tipo === 'ticket_monedero');
    expect(d).toBeTruthy();
    expect(d?.nota).toMatch(/RMF 3\.3\.1\.7/);
    expect(cubetaDe(diesel({ rfcEmisor: 'ASE930924SS7' }), r.diferencias.filter((x) => x.gastoId === 'g-d'))).toBe('por_confirmar');
    expect(r.totalPorConfirmar).toBe(5000);
  });

  it('línea ECC mismo día/estación/monto, sin padrón → también ticket_monedero', () => {
    const g = diesel({ rfcEmisor: 'EST010101AAA' });
    const r = cuadrarViaje({
      viajeId: 'v', anticipo: 5000, gastos: [g], politica: [{ concepto: 'diesel' }],
      lineasEcc: [{ fecha: '2026-07-20', monto: 5000, estacionRfc: 'EST010101AAA' }],
    });
    expect(r.diferencias.some((x) => x.tipo === 'ticket_monedero')).toBe(true);
  });

  it('ticket de estación (PEMEX) sin ECC → NO se afirma monedero', () => {
    const r = cuadrarViaje({
      viajeId: 'v', anticipo: 5000, gastos: [diesel({ rfcEmisor: 'PEM050101XXX' })],
      politica: [{ concepto: 'diesel' }],
    });
    expect(r.diferencias.some((x) => x.tipo === 'ticket_monedero')).toBe(false);
  });

  it('si ya está ligado al CFDI del emisor, no se emite ticket_monedero', () => {
    const r = cuadrarViaje({
      viajeId: 'v', anticipo: 5000,
      gastos: [diesel({ rfcEmisor: 'ASE930924SS7', cfdiUuid: 'uuid-ecc' })],
      politica: [{ concepto: 'diesel' }],
    });
    expect(r.diferencias.some((x) => x.tipo === 'ticket_monedero')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// UNA FECHA DE OTRO EJERCICIO ES SOSPECHOSA POR SÍ SOLA.
//
// Encontrado con tickets REALES (28-jul-2026): el OCR leyó "2024-07-27" en un
// ticket que dice "2026 07 27". Dos años de error, confianza 95%, y nada lo
// marcó — `fecha_sospechosa` solo salta si el viaje trae rango, y no siempre lo
// trae.
//
// Importa por dinero, no solo por prolijidad: un gasto de un ejercicio anterior
// NO se deduce en este. Si nadie lo mira, entra al total comprobado y a la
// deducción de un año al que no pertenece.
// ═══════════════════════════════════════════════════════════════════════════
describe('cuadrarViaje — comprobante de otro ejercicio', () => {
  const pol: PoliticaGasto[] = [{ concepto: 'diesel', topeMonto: 9000 }];

  it('marca un comprobante de un ejercicio anterior aunque el viaje no traiga rango', () => {
    const r = cuadrarViaje({
      viajeId: 'v1', anticipo: 1000, politica: pol, hoy: '2026-07-28',
      gastos: [g({ concepto: 'diesel', monto: 714.75, fecha: '2024-07-27', cfdiUuid: 'u1' })],
    });
    // FISCAL (rutina-fiscal-wip): tipo propio desde ahora — antes era
    // `fecha_sospechosa` y no excluía el gasto de `totalDeducible`.
    expect(r.diferencias.some((d) => d.tipo === 'gasto_otro_ejercicio')).toBe(true);
    expect(r.estatus).toBe('revisar');
  });

  it('el del ejercicio en curso NO se marca', () => {
    const r = cuadrarViaje({
      viajeId: 'v1', anticipo: 1000, politica: pol, hoy: '2026-07-28',
      gastos: [g({ concepto: 'diesel', monto: 714.75, fecha: '2026-01-15', cfdiUuid: 'u1' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'gasto_otro_ejercicio')).toBe(false);
  });

  it('tampoco se marca uno de diciembre pasado si estamos en enero', () => {
    // Un viaje a caballo entre ejercicios es normal en la última semana del año:
    // marcarlo sería ruido justo cuando más comprobantes hay.
    const r = cuadrarViaje({
      viajeId: 'v1', anticipo: 1000, politica: pol, hoy: '2026-01-05',
      gastos: [g({ concepto: 'diesel', monto: 714.75, fecha: '2025-12-30', cfdiUuid: 'u1' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'gasto_otro_ejercicio')).toBe(false);
  });

  it('sin `hoy` no inventa un veredicto', () => {
    const r = cuadrarViaje({
      viajeId: 'v1', anticipo: 1000, politica: pol,
      gastos: [g({ concepto: 'diesel', monto: 714.75, fecha: '2024-07-27', cfdiUuid: 'u1' })],
    });
    expect(r.diferencias.some((d) => d.tipo === 'gasto_otro_ejercicio')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SI EL TICKET DICE "PLUS", EL PAPEL NO PUEDE DECIR "DIÉSEL".
//
// El OCR mete toda la gasolinera en el concepto `diesel` —es lo que el prompt
// le pide, y para el 15% de la RFA 2.9 está bien porque la regla habla de
// "combustible", no solo de diésel—. Pero el ticket real que lo destapó dice
// PRODUCT: PLUS, o sea gasolina premium, y el PDF lo etiquetaba "Diésel".
//
// Al contralor le chirría, y con razón: el estímulo de IEPS es SOLO diésel
// (LIF 20-A fr. IV). Un papel que llama diésel a una gasolina invita a
// reclamar un estímulo que no aplica.
//
// El dato real ya lo captura el OCR en `ocrExtra.producto`. Solo había que usarlo.
// ═══════════════════════════════════════════════════════════════════════════
describe('etiqueta del combustible', () => {
  it('usa el producto impreso cuando el ticket lo trae', async () => {
    const { etiquetaConcepto } = await import('./engine');
    expect(etiquetaConcepto('diesel', { producto: 'PLUS' })).toMatch(/PLUS/i);
    expect(etiquetaConcepto('diesel', { producto: 'MAGNA' })).toMatch(/MAGNA/i);
  });

  it('sin producto impreso dice "Combustible", que es cierto siempre', async () => {
    const { etiquetaConcepto } = await import('./engine');
    // "Diésel" a secas era una afirmación que el ticket no respalda.
    expect(etiquetaConcepto('diesel', undefined)).toBe('Combustible');
  });

  it('si el producto SÍ es diésel, lo dice', async () => {
    const { etiquetaConcepto } = await import('./engine');
    expect(etiquetaConcepto('diesel', { producto: 'DIESEL' })).toMatch(/di[ée]sel/i);
  });

  it('los demás conceptos no cambian', async () => {
    const { etiquetaConcepto } = await import('./engine');
    expect(etiquetaConcepto('caseta', undefined)).toBe('Caseta');
    expect(etiquetaConcepto('alimentacion', undefined)).toBe('Alimentación');
  });
});

// ── RFA 2026 regla 2.9 — el deber ser completo (matriz del 15%) ─────────────
describe('RFA 2026 regla 2.9 — la matriz del 15% de combustible en efectivo', () => {
  // El escenario de la regla: combustible CON factura (cfdiUuid) pagado en
  // efectivo — sin CFDI, el gasto cae a por_confirmar por la regla del ticket,
  // y la facilidad del 15% no aplica (no hay comprobante que ampare).
  // AUDITORÍA 26 · continuación, FIS-C2c: la fecha y el `anioEjercicio` se
  // declaran EXPLÍCITOS, como ya hacía el bloque de la auditoría 15 más abajo.
  // Estos fixtures no traían ninguna de las dos, y el motor leía «sin año»
  // como «de este año»: la matriz medía su aritmética apoyada en esa lectura.
  // Corregido el motor, un comprobante sin fecha se abstiene, así que un
  // fixture sin fecha ya no puede ejercitar la aritmética del 15%. Ninguna
  // aserción de este bloque cambió — solo se completó la entrada, para que
  // cada prueba mida lo que su título dice y no un caso que producción
  // (`desde_db.ts`, único llamador que enciende `facilidad15`, y que siempre
  // manda `anioEjercicio`) no puede producir.
  const g15 = (p: Partial<Gasto>): Gasto => g({ concepto: 'diesel', monto: 1000, formaPago: '01', fecha: '2026-07-15', cfdiUuid: `u-${Math.random()}`, ...p });

  it('elegible + dentro del 15% → deducible, con el contador del ejercicio', () => {
    const r = cuadrarViaje({
      viajeId: 'v15a', anticipo: 3000, politica,
      facilidad15: true, totalCombustibleEjercicio: 10000, efectivoPrevEjercicio: 500,
      anioEjercicio: '2026',
      gastos: [g15({ id: 'g15a', monto: 1000 })],
    });
    const d = r.diferencias.find((x) => x.tipo === 'combustible_efectivo_dentro15')!;
    expect(d).toBeDefined();
    // efectivo acumulado = 500 previo + 1000 = 1500 ≤ 15%×10000 = 1500 → deducible
    expect(r.totalDeducible).toBe(1000);
    expect(r.totalPorConfirmar).toBe(0);
    expect(d.nota).toContain('$1,500.00 de $10,000.00');
    expect(d.nota).toContain('15%');
  });

  it('elegible + excede el 15% → solo el excedente NO se deduce (proporcional)', () => {
    const r = cuadrarViaje({
      viajeId: 'v15b', anticipo: 3000, politica,
      facilidad15: true, totalCombustibleEjercicio: 10000, efectivoPrevEjercicio: 1400,
      anioEjercicio: '2026',
      gastos: [g15({ id: 'g15b', monto: 1000 })],
    });
    // acumulado = 1400 + 1000 = 2400 > 1500 → de ESTE comprobante caben 100
    // dentro del tope; el excedente 900 no se deduce.
    const d = r.diferencias.find((x) => x.tipo === 'efectivo_sobre_15')!;
    expect(d).toBeDefined();
    expect(d.monto).toBe(900);
    expect(r.totalNoDeducible).toBe(900);
    expect(r.totalDeducible).toBe(100);
  });

  // AUDITORÍA 14, MEDIO: el excedente se reportaba CUMULATIVO (cada gasto
  // posterior colgaba TODO el excedente). Con 3×$1,000 y tope $1,500, la suma
  // de la columna tiene que ser $1,500 (el excedente real), nunca $2,000+.
  it('el excedente es POR COMPROBANTE — la suma de la columna cuadra (auditoría 14)', () => {
    const r = cuadrarViaje({
      viajeId: 'v15f', anticipo: 5000, politica,
      facilidad15: true, totalCombustibleEjercicio: 10000, efectivoPrevEjercicio: 0,
      anioEjercicio: '2026',
      gastos: [
        g15({ id: 'g1', monto: 1000 }),
        g15({ id: 'g2', monto: 1000 }),
        g15({ id: 'g3', monto: 1000 }),
      ],
    });
    const sobre15 = r.diferencias.filter((x) => x.tipo === 'efectivo_sobre_15');
    const suma = sobre15.reduce((s, d) => s + (d.monto ?? 0), 0);
    expect(suma).toBe(1500);                       // el excedente real
    expect(r.totalNoDeducible).toBe(1500);         // lo mismo que resta
    expect(sobre15.every((d) => (d.monto ?? 0) <= 1000)).toBe(true);  // nunca > el gasto
  });

  // AUDITORÍA 14, MEDIO: dinero no deducible no puede salir "cuadrada" (verde).
  it('el excedente del 15% y la flota no elegible NO salen en estatus cuadrada', () => {
    const excede = cuadrarViaje({
      viajeId: 'v15g', anticipo: 3000, politica,
      facilidad15: true, totalCombustibleEjercicio: 10000, efectivoPrevEjercicio: 2000,
      anioEjercicio: '2026',
      gastos: [g15({ id: 'g15g', monto: 1000 })],
    });
    expect(excede.estatus).toBe('revisar');
    const noElegible = cuadrarViaje({
      viajeId: 'v15h', anticipo: 3000, politica, facilidad15: false,
      gastos: [g15({ id: 'g15h' })],
    });
    expect(noElegible.estatus).toBe('revisar');
  });

  it('flota que NO califica → no deducible (27-III sin excepción)', () => {
    const r = cuadrarViaje({
      viajeId: 'v15c', anticipo: 3000, politica,
      facilidad15: false,
      gastos: [g15({ id: 'g15c' })],
    });
    expect(r.diferencias.some((x) => x.tipo === 'efectivo_no_elegible')).toBe(true);
    expect(r.totalNoDeducible).toBe(1000);
    expect(r.totalDeducible).toBe(0);
  });

  it('sin declaración → por confirmar, sin afirmar nada (la nota no promete)', () => {
    const r = cuadrarViaje({
      viajeId: 'v15d', anticipo: 3000, politica,
      facilidad15: undefined,
      gastos: [g15({ id: 'g15d' })],
    });
    expect(r.diferencias.some((x) => x.tipo === 'combustible_efectivo')).toBe(true);
    expect(r.totalPorConfirmar).toBe(1000);
    const d = r.diferencias.find((x) => x.tipo === 'combustible_efectivo')!;
    expect(d.nota).toContain('declare su dedicación');
  });

  it('el efectivo dentro del 15% NO acredita IVA ni IEPS (la facilidad salva UN beneficio)', () => {
    const r = cuadrarViaje({
      viajeId: 'v15e', anticipo: 3000, politica,
      facilidad15: true, totalCombustibleEjercicio: 10000, efectivoPrevEjercicio: 0,
      anioEjercicio: '2026',
      gastos: [g15({ id: 'g15e', monto: 1000, ivaTraslado: 160 })],
    });
    expect(r.ivaAcreditable ?? 0).toBe(0);
    expect(r.litrosDieselAcreditables ?? 0).toBe(0);
  });
});

// ── AUDITORÍA 15 · ALTO: fail-closed real del contador del 15% ──────────────
describe('AUDITORÍA 15 — el contador caído no puede afirmar "excedente contra $0"', () => {
  const g15 = (p: Partial<Gasto>): Gasto => g({ concepto: 'diesel', monto: 1000, formaPago: '01', cfdiUuid: `u-${Math.random()}`, ...p });
  it('contador sin datos (total 0): el efectivo va a POR CONFIRMAR, nunca a "no deducible"', () => {
    const r = cuadrarViaje({
      viajeId: 'v15i', anticipo: 3000, politica,
      facilidad15: true, totalCombustibleEjercicio: 0, efectivoPrevEjercicio: 0,
      gastos: [g15({ id: 'g15i', monto: 1000, cfdiUuid: 'u-15i' })],
    });
    expect(r.diferencias.some((x) => x.tipo === 'combustible_efectivo')).toBe(true);
    expect(r.diferencias.some((x) => x.tipo === 'efectivo_sobre_15')).toBe(false);
    expect(r.totalPorConfirmar).toBe(1000);
    expect(r.totalNoDeducible).toBe(0);
  });

  it('comprobante de OTRO ejercicio no corre contra el contador de este', () => {
    const r = cuadrarViaje({
      viajeId: 'v15j', anticipo: 3000, politica,
      facilidad15: true, totalCombustibleEjercicio: 10000, efectivoPrevEjercicio: 2000,
      anioEjercicio: '2026',
      gastos: [g15({ id: 'g15j', monto: 1000, cfdiUuid: 'u-15j', fecha: '2025-12-20' })],
    });
    // El gasto es de dic-2025, el ejercicio es 2026: no se mezcla.
    expect(r.diferencias.some((x) => x.tipo === 'combustible_efectivo')).toBe(true);
    expect(r.diferencias.some((x) => x.tipo === 'efectivo_sobre_15')).toBe(false);
    expect(r.totalPorConfirmar).toBe(1000);
  });

  it('la nota del contador caído no promete deducción (fail-closed honesto)', () => {
    const r = cuadrarViaje({
      viajeId: 'v15k', anticipo: 3000, politica,
      facilidad15: true, totalCombustibleEjercicio: 0,
      gastos: [g15({ id: 'g15k', monto: 1000, cfdiUuid: 'u-15k' })],
    });
    const d = r.diferencias.find((x) => x.tipo === 'combustible_efectivo')!;
    expect(d.nota).toContain('no se pudo calcular');
    expect(d.nota).not.toContain('NO se deduce');
  });
});
