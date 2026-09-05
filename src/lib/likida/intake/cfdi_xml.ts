// ═══════════════════════════════════════════════════════════════════════════
// PARSER DEL XML DEL CFDI — NIVEL 2 de validación (Bloque 1, complemento
// hidrocarburos). El QR NO trae el complemento ni las claves de producto; solo
// el XML. El operador/oficina reenvía por WhatsApp el XML que la gasolinera le
// manda por correo. NO requiere e.firma ni portales.
//
// Extrae, a nivel concepto: ClaveProdServ, ClaveUnidad, y la PRESENCIA del nodo
// raíz `HidroYPetro` v1.0 (estándar CC_HYP_10, ns hidrocarburospetroliferos) del
// "Complemento Concepto para la facturación de Hidrocarburos y Petrolíferos",
// vigente 24-abr-2026 (regla 2.7.1.48 RMF; CFF 29 y 29-A). La DECISIÓN de
// deducibilidad la toma el motor determinístico, no este parser.
//
// ═══ AUDITORÍA 10, CRÍTICO FISCAL — LÍNEAS DE UN CONSOLIDADO ══════════════
//
// Diésel por monedero (Edenred, Efectivale…) y peaje por TAG (IAVE, PASE,
// TeleVía) son, por estimación interna SIN FUENTE CONFIRMADA (no verificado
// contra INEGI, SICT ni CANACAR — no citar la cifra hacia afuera), una
// fracción grande del gasto real de una flota, y llegan como UN SOLO CFDI que
// ampara MUCHAS transacciones de MUCHOS días — no un ticket por transacción. Hasta hoy este parser asumía 1 CFDI = 1 concepto
// "representativo" (`claveProdServ`/`complementoHidrocarburos` de arriba), que
// es correcto para un ticket suelto pero tira al piso la granularidad de un
// consolidado.
//
// `lineas` la agrega SIN inventar lo que el estándar no da. Dos fuentes reales,
// verificadas contra el XSD oficial y guías técnicas de PAC (5-ago-2026), NO
// contra memoria:
//
//   1. ECC12 ("Estado de Cuenta de Combustibles", monedero electrónico) — vive
//      en `cfdi:Comprobante/cfdi:Complemento/ecc12:EstadoDeCuentaCombustible`
//      (HERMANO del Timbre, NO dentro de un Concepto). Cada
//      `ecc12:ConceptoEstadoDeCuentaCombustible` SÍ trae `Fecha` (dateTime real
//      de la compra), `Rfc` (el de la gasolinera real, distinto del emisor —que
//      es el monedero—), `ClaveEstacion`, `Importe` y `FolioOperacion`. Aquí la
//      granularidad por transacción EXISTE en el estándar, completa.
//
//   2. Sin ECC12, con VARIOS `cfdi:Concepto` base (típico de una factura de TAG
//      que agrupa varias casetas en un mismo CFDI, o de un CFDI con "quiero un
//      CFDI por código" desactivado): cada Concepto trae su propio `Importe` y
//      `Descripcion`, pero el estándar CFDI 4.0 **NO declara una fecha por
//      concepto** — solo hay una `Fecha` a nivel comprobante, la de EMISIÓN del
//      documento entero. No se intenta adivinar la fecha de una caseta leyendo
//      texto libre de `Descripcion`: el formato de esa descripción lo decide
//      cada emisor y no hay catálogo del SAT que lo estandarice. `linea.fecha`
//      queda `undefined` a propósito — es la limitación real, no una que este
//      código deba disimular.
//
// Quien concilia estas líneas contra `gasto` (JOIN, no adivinanza) vive en
// `intake/consolidado.ts`, que respeta la ausencia de fecha: sin fecha, nunca
// intenta un match automático.
// ═══════════════════════════════════════════════════════════════════════════

import { XMLParser } from 'fast-xml-parser';

export interface CfdiConceptoXml {
  claveProdServ?: string;
  claveUnidad?: string;
  /** Cantidad de la UNIDAD (ClaveUnidad LTR → litros). Se lee aunque el
   *  camino 1:1 (ticket) no la usara — es el dato que la auditoría 12 pedía:
   *  el XML de la gasolinera dice Cantidad="113.00" y la liquidación salía
   *  con 0 litros. Ahora viaja en `CfdiXmlData.cantidad` y el processor lo
   *  escribe en ocrExtra.litros cuando el concepto es de combustible. */
  cantidad?: number;
  complemento: boolean; // el concepto trae hidrocarburosPetroliferos
}

/** De dónde salió una línea de un consolidado — ver el bloque de arriba. */
export type FuenteLineaCfdi = 'ecc12' | 'concepto_base';

/**
 * Una transacción dentro de un CFDI consolidado. `indice` es 1-based y es el
 * orden en que aparece en el XML — es lo que se vuelve `gasto.cfdi_orden`
 * (migración 0065) cuando la línea concilia contra un gasto real.
 */
export interface CfdiLineaXml {
  indice: number;
  fuente: FuenteLineaCfdi;
  /** ISO. SOLO presente cuando `fuente === 'ecc12'`: el estándar no da fecha
   *  por concepto base (ver el comentario del archivo). */
  fecha?: string;
  monto: number;
  descripcion?: string;
  /** ecc12 únicamente: RFC de la gasolinera REAL (no el del monedero, que es
   *  el emisor del CFDI completo). */
  estacionRfc?: string;
  estacionClave?: string;
  /** ecc12 únicamente: folio de ESA operación individual (no del CFDI). */
  folioOperacion?: string;
  cantidad?: number;
  /** concepto_base únicamente: `@ClaveProdServ` del Concepto — ese esquema SÍ
   *  la trae por transacción. ecc12 NO tiene este campo (ver `tipoCombustible`
   *  abajo): la ECC12 v1.2 no incluye ClaveProdServ por línea. */
  claveProdServ?: string;
  /** ecc12 únicamente: `@TipoCombustible` de `ConceptoEstadoDeCuentaCombustible`
   *  — catálogo cerrado del SAT ("Diesel", "Gasolina Regular (Magna)",
   *  "Gasolina Premium", "Gas Natural", "Gas L.P.", "Otros"). Es el único dato
   *  que ECC12 da para identificar el combustible por línea; no hay
   *  ClaveProdServ que leer aquí. */
  tipoCombustible?: string;
}

export interface CfdiXmlData {
  version?: string;
  tipoComprobante?: string; // I | E | P | N | T
  fecha?: string;           // ISO del atributo Fecha del Comprobante
  formaPago?: string;       // c_FormaPago (01=efectivo, 03=transferencia, 04/28=tarjeta…)
  /**
   * `@MetodoPago` (PUE = pago en una sola exhibición, PPD = pago en
   * parcialidades o diferido). Fase 7: es el atributo que dice si este CFDI
   * ESPERA un complemento de pago — un PPD con FormaPago 99 no acredita su
   * IVA hasta que llegue el REP que lo liquida (LIVA 5-III). Este parser lo
   * tiraba, así que nadie podía distinguir "a crédito" de "sin dato".
   */
  metodoPago?: string;
  subTotal?: number;        // @SubTotal (sin impuestos) — base BRUTA del estímulo de peaje
  /**
   * `@Descuento` del Comprobante. Es OPCIONAL en el CFDI 4.0 y este parser lo
   * tiraba, así que el estímulo del 50% de peaje (RMF 9.1.8) se calculaba sobre
   * el SubTotal íntegro aunque el emisor hubiera descontado parte. Sobre
   * $120,000 de casetas con $18,000 de descuento eso son $60,000 acreditados
   * donde procedían $51,000: nueve mil pesos de estímulo que no existen.
   *
   * `undefined` = el CFDI no lo trae (lo normal), y entonces la base es el
   * SubTotal a secas.
   */
  descuento?: number;
  rfcEmisor?: string;
  rfcReceptor?: string;
  total?: number;
  /**
   * DAT-19 · `@Moneda` del Comprobante (ISO 4217: MXN, USD, EUR…).
   *
   * Es un atributo OBLIGATORIO del CFDI 4.0 y este parser lo tiraba, así que
   * `@Total` viajaba entero a la columna de pesos: una factura de USD 450 se
   * comprobaba como $450.00 MXN contra el anticipo, con su IVA acreditado
   * sobre esa misma cifra equivocada. `undefined` = el archivo no lo trae
   * (CFDI viejo o roto) y se trata como el comportamiento de siempre.
   */
  moneda?: string;
  /** `@TipoCambio` — obligatorio cuando la moneda no es MXN. NO se usa para
   *  convertir (el motor no inventa cifras): se conserva para que la persona
   *  que sí convierte tenga a la vista el dato que el emisor declaró. */
  tipoCambio?: number;
  iepsTraslado: number;     // Σ Traslado[Impuesto=003] Importe → IEPS acreditable
  ivaTraslado: number;      // Σ Traslado[Impuesto=002] Importe → IVA acreditable
  /**
   * Σ Retencion[Impuesto=002] Importe — IVA RETENIDO (AUDITORÍA 22, FIS-A1).
   *
   * El nodo `Retenciones` no se leía: solo se parseaban los `Traslado`. Las
   * columnas `gasto.iva_retenido` / `isr_retenido` existen desde la migración
   * 0063 y nadie las escribía, así que un flete subcontratado a un permisionario
   * persona física —el caso normal en carga federal— llegaba a la póliza sin su
   * retención, y el residuo que ese módulo deriva por resta salía NEGATIVO:
   * el export contestaba «dato de origen roto» y tiraba el periodo entero.
   *
   * Una retención NO es un gasto: es una cuenta POR PAGAR al SAT.
   */
  ivaRetenido: number;
  /** Σ Retencion[Impuesto=001] Importe — ISR retenido. Mismo criterio. */
  isrRetenido: number;
  uuid?: string;
  conceptos: CfdiConceptoXml[];
  // Concepto REPRESENTATIVO (el de combustible si existe, si no el primero):
  claveProdServ?: string;
  claveUnidad?: string;
  /** @Cantidad del concepto representativo — litros cuando ClaveUnidad = LTR.
   *  La auditoría 12 (fiscal, ALTO) lo pidió para el camino 1:1: el XML de
   *  la gasolinera lo trae y la liquidación del demo salía con 0 litros. */
  cantidad?: number;
  complementoHidrocarburos: boolean; // el representativo trae el complemento
  // Esquema ALTERNO (monedero electrónico ECC o Carta Porte): la regla 2.7.1.48
  // NO aplica a estos; el motor NO debe declararlos no deducibles por complemento.
  esquemaAlterno: boolean;
  /** Transacciones del consolidado (ver bloque de arriba). `[]` en un CFDI
   *  normal de un solo concepto — ese caso lo sigue cubriendo `total`/`fecha`
   *  de arriba, sin necesidad de esta lista. */
  lineas: CfdiLineaXml[];
}

/** ¿Este CFDI ampara MÁS de una transacción de gasto? Las notas de crédito
 *  nunca califican aunque tengan varias líneas. `false` en un CFDI normal aunque
 *  traiga 2+ `Concepto` de UN SOLO consumo (p.ej. producto + IEPS desglosado
 *  en conceptos separados es raro pero posible); ese caso lo sigue resolviendo
 *  el camino de ticket 1:1 existente, y forzarlo por la cola de conciliación
 *  sería más trabajo humano, no menos. */
export function esConsolidado(xml: Pick<CfdiXmlData, 'lineas' | 'tipoComprobante'>): boolean {
  return xml.tipoComprobante !== 'E' && xml.lineas.length > 1;
}

// Familia SAT de petrolíferos (pista del parser para elegir el concepto de
// combustible; la DECISIÓN usa las claves de config, no este prefijo).
const PREFIJO_COMBUSTIBLE = '15101';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true, // cfdi:Comprobante → Comprobante, etc.
  isArray: (name) => name === 'Concepto' || name === 'Traslado',
  parseAttributeValue: false, // conservar strings (claves con ceros a la izq.)
});

function toArr<T>(v: T | T[] | undefined): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

/** Parsea el XML de un CFDI 4.0. Demo-safe: devuelve null ante cualquier error. */
/**
 * La `FormaPago` del CFDI, normalizada al catálogo `c_FormaPago` del SAT (dos
 * dígitos) o descartada.
 *
 * ── POR QUÉ NO SE PASA EL ATRIBUTO TAL CUAL (auditoría 6, modelo de datos) ──
 *
 * La migración 0025 puso `gasto_forma_pago_formato` —`forma_pago is null or
 * forma_pago ~ '^[0-9]{2}$'`— para cazar un fallo del mapeo de OCR. Ese camino
 * ya estaba blindado con zod. Pero hay un SEGUNDO escritor que la migración no
 * contempló: este parser, que leía `@_FormaPago` sin validar nada, y cuyo valor
 * llega a `gasto` por los dos únicos caminos de escritura que existen.
 *
 * Un CFDI bien timbrado —UUID válido, RFC, total y fecha correctos— emitido por
 * software de facturación de una gasolinera independiente puede traer
 * `FormaPago="1"` en vez de `"01"`. Un solo dígito. Con eso, el `insert`
 * violaba el CHECK (23514), `pg_errores.ts` no sabe traducir ese código,
 * `processor.ts` solo reconoce los dos índices únicos y el resto cae en
 * `throw e`, y el comprobante se perdía ENTERO — sin guardar siquiera el XML
 * crudo que el CFF art. 30 obliga a conservar cinco años.
 *
 * Perder un dato accesorio es incomparablemente mejor que perder el CFDI. Un
 * dígito suelto se rellena (el catálogo del SAT va de `01` a `99`, así que "1"
 * solo puede querer decir "01"); cualquier otra cosa se descarta a `undefined`,
 * que el CHECK acepta como `null`. La verdad de referencia sigue completa en el
 * XML crudo.
 */
export function formaPagoSat(bruto: string | undefined | null): string | undefined {
  const v = String(bruto ?? '').trim();
  if (!/^\d{1,2}$/.test(v)) return undefined;
  return v.padStart(2, '0');
}

/**
 * `@MetodoPago` normalizado al catálogo c_MetodoPago (PUE/PPD) o descartado.
 * Mismo criterio que `formaPagoSat`: perder un dato accesorio es mejor que
 * perder el CFDI — cualquier valor fuera del catálogo va a `undefined`, que
 * el CHECK de la 0199 acepta como NULL. La verdad queda en el XML crudo.
 */
export function metodoPagoSat(bruto: string | undefined | null): string | undefined {
  const v = String(bruto ?? '').trim().toUpperCase();
  return v === 'PUE' || v === 'PPD' ? v : undefined;
}

export function parseCfdiXml(xml: string): CfdiXmlData | null {
  try {
    const doc = parser.parse(xml) as Record<string, unknown>;
    // Sin nodo Comprobante no es un CFDI → null (no un objeto vacío).
    if (!doc || !doc.Comprobante || typeof doc.Comprobante !== 'object') return null;
    const comp = doc.Comprobante as Record<string, unknown>;

    const emisor = (comp.Emisor ?? {}) as Record<string, string>;
    const receptor = (comp.Receptor ?? {}) as Record<string, string>;
    const conceptosNode = (comp.Conceptos ?? {}) as Record<string, unknown>;
    const conceptosRaw = toArr(conceptosNode.Concepto as Record<string, unknown>[] | undefined);

    // Se define ANTES del map de conceptos porque `cantidad` (abajo) lo usa.
    const num = (v: unknown): number | undefined => {
      if (v == null) return undefined;
      const n = parseFloat(v as string);
      return Number.isNaN(n) ? undefined : n;
    };

    const conceptos: CfdiConceptoXml[] = conceptosRaw.map((c) => {
      const cc = (c.ComplementoConcepto ?? {}) as Record<string, unknown>;
      // El nodo raíz del complemento es `HidroYPetro` (estándar CC_HYP_10,
      // ns hidrocarburospetroliferos). Detección TOLERANTE al nombre (con
      // removeNSPrefix el prefijo se va): cualquier hijo cuyo local-name aluda a
      // hidrocarburos/petrolíferos. Un nombre mal asumido = falso positivo de
      // "no deducible" sobre CFDIs válidos, así que se prefiere tolerar.
      const tieneComplemento =
        cc != null && typeof cc === 'object' && Object.keys(cc).some((k) => /hidro|petro/i.test(k));
      return {
        claveProdServ: (c['@_ClaveProdServ'] as string) || undefined,
        claveUnidad: (c['@_ClaveUnidad'] as string) || undefined,
        cantidad: num(c['@_Cantidad']),
        complemento: tieneComplemento,
      };
    });

    // UUID del Timbre Fiscal Digital (dentro de Complemento del comprobante).
    const complemento = (comp.Complemento ?? {}) as Record<string, unknown>;
    const tfd = toArr(complemento.TimbreFiscalDigital as Record<string, string>[] | undefined)[0]
      ?? (complemento.TimbreFiscalDigital as Record<string, string> | undefined);
    const uuidRaw = tfd?.['@_UUID'];

    // Esquemas alternos que la regla 2.7.1.48 excluye: Carta Porte (transporte)
    // y Estado de Cuenta de Combustibles / monedero electrónico (ECC).
    const compKeys = complemento && typeof complemento === 'object' ? Object.keys(complemento) : [];
    const esquemaAlterno = compKeys.some((k) => /cartaporte|estadodecuentacombustible|consumodecombustibles/i.test(k));

    // Representativo: el primer concepto de combustible; si no hay, el primero.
    const rep = conceptos.find((c) => c.claveProdServ?.startsWith(PREFIJO_COMBUSTIBLE)) ?? conceptos[0];

    // ── LÍNEAS DEL CONSOLIDADO (auditoría 10) ─────────────────────────────
    // ECC12: `EstadoDeCuentaCombustible` es HERMANO del Timbre dentro de
    // `Complemento` — no vive dentro de un `Concepto`. Ver el bloque de
    // arriba del archivo para la cita de dónde salió esta estructura.
    const eccNode = toArr(complemento.EstadoDeCuentaCombustible as Record<string, unknown>[] | undefined)[0]
      ?? (complemento.EstadoDeCuentaCombustible as Record<string, unknown> | undefined);
    const eccConceptosRaw = toArr(
      (eccNode?.Conceptos as Record<string, unknown> | undefined)?.ConceptoEstadoDeCuentaCombustible as Record<string, unknown>[] | undefined,
    );
    const lineasEcc: CfdiLineaXml[] = eccConceptosRaw.map((c, i) => ({
      indice: i + 1,
      fuente: 'ecc12',
      fecha: (c['@_Fecha'] as string) || undefined,
      monto: num(c['@_Importe']) ?? 0,
      descripcion: (c['@_NombreCombustible'] as string) || undefined,
      estacionRfc: (c['@_Rfc'] as string)?.toUpperCase() || undefined,
      estacionClave: (c['@_ClaveEstacion'] as string) || undefined,
      folioOperacion: (c['@_FolioOperacion'] as string) || undefined,
      cantidad: num(c['@_Cantidad']),
      tipoCombustible: (c['@_TipoCombustible'] as string) || undefined,
    }));

    // Sin ECC12: si hay VARIOS Concepto base, cada uno es su propia línea —
    // pero SIN fecha (el estándar no la da a ese nivel; ver el comentario
    // grande de arriba). Con un solo Concepto no hace falta esta lista: el
    // camino de ticket 1:1 ya cubre ese caso con `total`/`fecha` de arriba.
    const lineasConceptoBase: CfdiLineaXml[] = conceptosRaw.length > 1
      ? conceptosRaw.map((c, i) => ({
          indice: i + 1,
          fuente: 'concepto_base' as const,
          monto: num(c['@_Importe']) ?? 0,
          descripcion: (c['@_Descripcion'] as string) || undefined,
          cantidad: num(c['@_Cantidad']),
          claveProdServ: (c['@_ClaveProdServ'] as string) || undefined,
        }))
      : [];

    const lineas: CfdiLineaXml[] = lineasEcc.length > 0 ? lineasEcc : lineasConceptoBase;

    // Impuestos trasladados a nivel comprobante: 002=IVA, 003=IEPS.
    const impuestos = (comp.Impuestos ?? {}) as Record<string, unknown>;
    const traslados = toArr(
      (impuestos.Traslados as Record<string, unknown> | undefined)?.Traslado as Record<string, string>[] | undefined,
    );
    let iepsTraslado = 0;
    let ivaTraslado = 0;
    for (const t of traslados) {
      const imp = t['@_Impuesto'];
      const importe = num(t['@_Importe']) ?? 0;
      if (imp === '003') iepsTraslado += importe;
      else if (imp === '002') ivaTraslado += importe;
    }

    // FIS-A1: las RETENCIONES, que no se leían. 001=ISR, 002=IVA. Mismo nodo
    // `Impuestos` del comprobante, misma forma que los traslados.
    const retenciones = toArr(
      (impuestos.Retenciones as Record<string, unknown> | undefined)?.Retencion as Record<string, string>[] | undefined,
    );
    let ivaRetenido = 0;
    let isrRetenido = 0;
    for (const r of retenciones) {
      const imp = r['@_Impuesto'];
      const importe = num(r['@_Importe']) ?? 0;
      if (imp === '002') ivaRetenido += importe;
      else if (imp === '001') isrRetenido += importe;
    }

    return {
      version: (comp['@_Version'] as string) || undefined,
      tipoComprobante: (comp['@_TipoDeComprobante'] as string) || undefined,
      fecha: (comp['@_Fecha'] as string) || undefined,
      formaPago: formaPagoSat(comp['@_FormaPago'] as string | undefined),
      metodoPago: metodoPagoSat(comp['@_MetodoPago'] as string | undefined),
      subTotal: num(comp['@_SubTotal']),
      descuento: num(comp['@_Descuento']),
      rfcEmisor: (emisor['@_Rfc'] as string)?.toUpperCase() || undefined,
      rfcReceptor: (receptor['@_Rfc'] as string)?.toUpperCase() || undefined,
      total: num(comp['@_Total']),
      // DAT-19: en MAYÚSCULAS y sólo la forma ISO de tres letras — este valor
      // se COMPARA contra 'MXN' para decidir si el importe está en pesos, y un
      // "mxn" en minúsculas o un atributo con basura no puede mandar a revisión
      // una liquidación sana.
      moneda: monedaIso(comp['@_Moneda'] as string | undefined),
      tipoCambio: num(comp['@_TipoCambio']),
      iepsTraslado,
      ivaRetenido,
      isrRetenido,
      ivaTraslado,
      uuid: uuidRaw ? uuidRaw.toLowerCase() : undefined,
      conceptos,
      claveProdServ: rep?.claveProdServ,
      claveUnidad: rep?.claveUnidad,
      cantidad: rep?.cantidad,
      complementoHidrocarburos: rep?.complemento ?? false,
      esquemaAlterno,
      lineas,
    };
  } catch {
    return null;
  }
}

/** DAT-19: `@Moneda` normalizada a ISO 4217, o `undefined` si no se puede leer. */
function monedaIso(bruto: string | undefined): string | undefined {
  const m = (bruto ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  return /^[A-Z]{3}$/.test(m) ? m : undefined;
}

/** ¿La clave de producto es de combustible según el catálogo (config)? */
export function esClaveCombustible(clave: string | undefined, claves: string[]): boolean {
  return !!clave && claves.includes(clave);
}
