// ═══════════════════════════════════════════════════════════════════════════
// ÍNDICE DE NORMAS — la única lista de lo que el producto puede citar.
//
// Existe para `guardiaFundamento()`: el modelo solo puede referenciar una norma
// que una tool le devolvió EN ESE TURNO, y el servidor sustituye el texto. Sin
// un índice cerrado, "no alucina el artículo" es una esperanza sobre el prompt;
// con él es una propiedad del código.
//
// LA FUENTE DE VERDAD SIGUEN SIENDO LAS FICHAS de `normas/*.yaml`, que traen el
// texto vigente transcrito y la trazabilidad de verificación. Esto es un índice
// compacto para runtime —serverless no debería parsear 17 YAML por invocación—
// y `normas_sincronizadas.test.ts` falla si se separan.
//
// `jerarquia` NO es decorativa. La escala es la de `normas/README.md`, y
// confundir los niveles es "el error más caro del dominio", ya cometido dos
// veces en este proyecto: una regla de nivel 1 escrita en absoluto puede tener
// una excepción de nivel 3 que vale dinero (el diésel en efectivo no es
// deducible por LISR 27-III... salvo hasta el 15% por RFA 2026 regla 2.9), y al
// revés, un plazo de nivel 6 —"esta gasolinera factura en 7 días"— NO es una
// obligación fiscal y nunca debe presentarse como tal.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cuánto peso legal tiene, de más a menos. Escala de `normas/README.md`:
 *
 *   1  Ley                                    LISR art. 27 fr. III
 *   2  Reglamento                             RLISR
 *   3  Regla general (RMF) o FACILIDAD (RFA)  RFA 2026 regla 2.9
 *   4  Anexo                                  Anexo 3 de la RMF
 *   5  Criterio NO VINCULATIVO                1/LIF/PI
 *   6  Política de un tercero, cero fuerza legal   plazo del portal de una gasolinera
 */
export type Jerarquia = 1 | 2 | 3 | 4 | 5 | 6;

/** `true` si la norma obliga. De 5 para abajo NO: orienta o informa. */
export function esVinculante(j: Jerarquia): boolean {
  return j <= 4;
}

/**
 * Qué tan verificada está la ficha.
 *  - `verificado_fuente_primaria`: se bajó el texto oficial y se transcribió.
 *  - `evidencia_corroborante`: varias fuentes secundarias coinciden.
 *  - `sin_verificar`: NO se ha comprobado. El producto no debería decidir dinero
 *    sobre una de estas sin marcarlo.
 */
export type EstadoVerificacion = 'verificado_fuente_primaria' | 'evidencia_corroborante' | 'sin_verificar';

export interface Norma {
  id: string;
  instrumento?: string;
  articulo?: string;
  fraccion?: string;
  titulo?: string;
  /** Cómo se escribe en el código y en los mensajes ("LISR 27-III"). */
  citas: string[];
  jerarquia: Jerarquia;
  estado: EstadoVerificacion;
  /**
   * Desde cuándo la norma es EXIGIBLE, si alguna fuente lo respalda. Espejo de
   * `fecha_vigencia_desde` en la ficha (ISO YYYY-MM-DD), y `null` cuando NADIE
   * lo ha confirmado.
   *
   * No es adorno: es el interruptor de los veredictos duros. Una regla
   * redactada en futuro —"el complemento que al efecto publique el SAT en su
   * Portal"— puede estar LATENTE y no vigente, y el motor estaba tirando una
   * deducción de $5,800 más su IVA sobre una fecha que ninguna ficha respalda
   * (la de `config.ts`, fundada en una cita —RMF 2.7.1.8— que no tiene ficha).
   *
   * Con `null` el motor puede AVISAR, nunca declarar no deducible. El día que
   * alguien confirme la fecha en el Portal del SAT, se llena aquí y en la ficha
   * —`normas_sincronizadas.test.ts` obliga a que coincidan— y el veredicto duro
   * se enciende solo.
   */
  exigibleDesde?: string | null;
  /** Ruta de la ficha con el texto vigente y la trazabilidad. */
  ficha: string;
}

export const NORMAS: Record<string, Norma> = {
  'cff-69-B': {
    id: 'cff-69-B',
    instrumento: "Código Fiscal de la Federación",
    articulo: "69-B",
    titulo: "EFOS — comprobantes que amparan operaciones inexistentes",
    citas: ["CFF 69-B"],
    jerarquia: 1,
    estado: "verificado_fuente_primaria",
    ficha: "normas/cff-69-B.yaml",
  },
  'cff-30': {
    id: 'cff-30',
    instrumento: "Código Fiscal de la Federación",
    articulo: "30",
    titulo: "Conservación de la contabilidad y de la documentación — el plazo de cinco años",
    citas: ["CFF 30", "CFF art. 30"],
    jerarquia: 1,
    estado: "verificado_fuente_primaria",
    exigibleDesde: null,
    ficha: "normas/cff-30.yaml",
  },
  'cff-89-90': {
    id: 'cff-89-90',
    instrumento: "Código Fiscal de la Federación",
    articulo: "89 y 90",
    titulo: "Infracciones cuya responsabilidad recae sobre TERCEROS, y su multa — la exposición de Likida",
    citas: ["CFF 89", "CFF 90", "CFF arts. 89 y 90"],
    jerarquia: 1,
    estado: "verificado_fuente_primaria",
    exigibleDesde: null,
    ficha: "normas/cff-89-90.yaml",
  },
  'cff-29-A': {
    id: 'cff-29-A',
    instrumento: "Código Fiscal de la Federación",
    articulo: "29-A",
    titulo: "Requisitos de los comprobantes fiscales digitales",
    citas: ["CFF 29-A", "CFF 29 y 29-A"],
    jerarquia: 1,
    estado: "evidencia_corroborante",
    ficha: "normas/cff-29-A.yaml",
  },
  'criterio-1-CFF-PI': {
    id: 'criterio-1-CFF-PI',
    instrumento: "Anexo 3 de la Resolución Miscelánea Fiscal para 2026 (criterios no vinculativos)",
    articulo: "1/CFF/PI",
    titulo: "Entrega o puesta a disposición del CFDI. No se cumple con la obligación cuando el emisor únicamente remite a una página de Internet.",
    citas: ["1/CFF/PI", "CFF art. 89", "artículo 52 del Código Fiscal"],
    jerarquia: 5,
    // Subido de evidencia_corroborante el 26-ago-2026: texto completo
    // transcrito y cotejado contra el Anexo 3 (DOF 9-ene-2026), rescatado de
    // `rutina-fiscal-wip` (investigación del 20-ago-2026, nunca mergeada).
    estado: "verificado_fuente_primaria",
    ficha: "normas/criterio-1-CFF-PI.yaml",
  },
  'criterio-1-LIF-PI': {
    id: 'criterio-1-LIF-PI',
    instrumento: "Anexo 3 de la Resolución Miscelánea Fiscal para 2026",
    articulo: "1/LIF/PI",
    titulo: "Estímulo del IEPS de diésel calculado con la cuota disminuida",
    citas: ["1/LIF/PI"],
    jerarquia: 5,
    estado: "evidencia_corroborante",
    ficha: "normas/criterio-1-LIF-PI.yaml",
  },
  'lfpdppp-2025-art-15-16': {
    id: 'lfpdppp-2025-art-15-16',
    instrumento: "Ley Federal de Protección de Datos Personales en Posesión de los Particulares",
    articulo: "15 y 16",
    titulo: "Contenido del aviso de privacidad y cómo ponerlo a disposición",
    citas: ["LFPDPPP 15", "LFPDPPP 16-II"],
    jerarquia: 1,
    estado: "verificado_fuente_primaria",
    exigibleDesde: "2025-03-21",
    ficha: "normas/lfpdppp-15-16.yaml",
  },
  'lfpdppp-2025-art-2-fr-XII-XX': {
    id: 'lfpdppp-2025-art-2-fr-XII-XX',
    instrumento: "Ley Federal de Protección de Datos Personales en Posesión de los Particulares",
    articulo: "2",
    fraccion: "XII y XX",
    titulo: "Persona encargada, y por qué mandarle datos NO es una transferencia",
    citas: ["LFPDPPP 2-XII", "LFPDPPP 2-XX", "LFPDPPP 35"],
    jerarquia: 1,
    estado: "verificado_fuente_primaria",
    exigibleDesde: "2025-03-21",
    ficha: "normas/lfpdppp-2-XII-XX.yaml",
  },
  'lfpdppp-2025-art-26-fr-II': {
    id: 'lfpdppp-2025-art-26-fr-II',
    instrumento: "Ley Federal de Protección de Datos Personales en Posesión de los Particulares",
    articulo: "26",
    fraccion: "II",
    titulo: "Derecho de OPOSICIÓN al tratamiento automatizado sin intervención humana",
    citas: ["LFPDPPP 26-II"],
    jerarquia: 1,
    estado: "verificado_fuente_primaria",
    exigibleDesde: "2025-03-21",
    ficha: "normas/lfpdppp-26-II.yaml",
  },
  'lfpdppp-2025-art-59': {
    id: 'lfpdppp-2025-art-59',
    instrumento: "Ley Federal de Protección de Datos Personales en Posesión de los Particulares",
    articulo: "59",
    titulo: "Sanciones — los rangos reales de multa",
    citas: ["LFPDPPP 59"],
    jerarquia: 1,
    estado: "verificado_fuente_primaria",
    exigibleDesde: "2025-03-21",
    ficha: "normas/lfpdppp-59.yaml",
  },
  'lft-110-111-263': {
    id: 'lft-110-111-263',
    instrumento: "Ley Federal del Trabajo",
    articulo: "110 fr. I, 111 y 263 fr. I",
    titulo: "Qué se le puede descontar a un operador, y qué se le debe pagar aunque no sea deducible",
    citas: ["LFT 110-I", "LFT 111", "LFT 263-I"],
    jerarquia: 1,
    estado: "verificado_fuente_primaria",
    ficha: "normas/lft-110-111-263.yaml",
  },
  // El registro de jornada (mig. 0241). La fracción XXXIV del 132 es NUEVA —
  // la adicionó el decreto del DOF del 01-05-2026, el mismo de la reducción de
  // jornada— y por eso `exigibleDesde` sí trae fecha: la obligación es
  // exigible, no latente. Los topes de los arts. 61 y 68 son los únicos números
  // de horas que el producto puede citar, y el motor los cita SIEMPRE con su
  // artículo.
  'lft-132-XXXIV-jornada': {
    id: 'lft-132-XXXIV-jornada',
    instrumento: "Ley Federal del Trabajo",
    articulo: "132 fr. XXXIV, 58 a 69, 784, 804, 805 y 994 fr. IV Bis",
    titulo: "El registro electrónico de la jornada, los topes de horas, y qué pasa si el patrón no lo exhibe",
    citas: ["LFT 132-XXXIV", "LFT 58", "LFT 60", "LFT 61", "LFT 63", "LFT 64", "LFT 68", "LFT 69", "LFT 784", "LFT 804", "LFT 805", "LFT 994-IV Bis"],
    jerarquia: 1,
    estado: "verificado_fuente_primaria",
    exigibleDesde: "2026-05-01",
    ficha: "normas/lft-132-XXXIV-jornada.yaml",
  },
  // Nivel 3: una NOM la emite una Secretaría, no el legislador. Está en el
  // índice para que el producto pueda DECIR que no la evalúa —mide conducción,
  // y Likida registra jornada— citando la norma que se está absteniendo de
  // aplicar. Callarse sin nombrar lo que uno calla no es transparencia.
  'nom-087-sct-2-2017': {
    id: 'nom-087-sct-2-2017',
    instrumento: "NOM-087-SCT-2-2017 (Norma Oficial Mexicana)",
    articulo: "numerales 4.1 a 4.7, 8.2.1, 8.3.2 y 8.5",
    titulo: "Tiempos de conducción y pausas del autotransporte federal — y por qué Likida no los evalúa",
    citas: ["NOM-087-SCT-2-2017", "NOM-087 4.1", "NOM-087 4.6", "NOM-087 4.7", "NOM-087 8.5"],
    jerarquia: 3,
    estado: "verificado_fuente_primaria",
    exigibleDesde: "2018-08-27",
    ficha: "normas/nom-087-sct-2-2017.yaml",
  },
  // `exigibleDesde: null` A PROPÓSITO: la reforma del 25-05-2026 sí se verificó,
  // pero el texto CONSOLIDADO del reglamento no se pudo leer (las URLs
  // oficiales devolvieron error), así que no se puede afirmar que no haya
  // reformas intermedias. La regla de la casa manda null cuando nadie lo
  // confirmó — ver la ficha.
  'reglamento-transito-83': {
    id: 'reglamento-transito-83',
    instrumento: "Reglamento de Tránsito en Carreteras y Puentes de Jurisdicción Federal",
    articulo: "83",
    titulo: "La bitácora de horas de servicio y sus diez campos obligatorios",
    citas: ["Reglamento de Tránsito 83", "RTCPJF 83"],
    jerarquia: 2,
    estado: "verificado_fuente_primaria",
    exigibleDesde: null,
    ficha: "normas/reglamento-transito-83.yaml",
  },
  'lif-2026-art-20-A': {
    id: 'lif-2026-art-20-A',
    instrumento: "Ley de Ingresos de la Federación para el Ejercicio Fiscal de 2026",
    articulo: "20, apartado A (estímulos fiscales)",
    titulo: "Estímulo de IEPS de diésel para transporte, y estímulo del 50% de peaje",
    citas: ["LIF 2026 Art. 20", "LIF 2026 Art. 20-A", "LIF Art. 20-A fr. IV"],
    jerarquia: 1,
    estado: "verificado_fuente_primaria",
    ficha: "normas/lif-2026-20-A.yaml",
  },
  'lisr-27-fr-III': {
    id: 'lisr-27-fr-III',
    instrumento: "Ley del Impuesto sobre la Renta",
    articulo: "27",
    fraccion: "III",
    titulo: undefined,
    citas: ["LISR 27-III"],
    jerarquia: 1,
    estado: "evidencia_corroborante",
    ficha: "normas/lisr-27-III.yaml",
  },
  'lisr-28-fr-V': {
    id: 'lisr-28-fr-V',
    instrumento: "Ley del Impuesto sobre la Renta",
    articulo: "28",
    fraccion: "V",
    titulo: "Viáticos y gastos de viaje — no deducibles y tope de alimentación",
    citas: ["LISR 28-V"],
    jerarquia: 1,
    estado: "verificado_fuente_primaria",
    ficha: "normas/lisr-28-V.yaml",
  },
  'lisr-28-fr-XX': {
    id: 'lisr-28-fr-XX',
    instrumento: "Ley del Impuesto sobre la Renta",
    articulo: "28",
    fraccion: "XX",
    titulo: "Consumos en restaurantes — 91.5% no deducible, 0% en bares",
    citas: ["LISR 28-XX"],
    jerarquia: 1,
    estado: "evidencia_corroborante",
    ficha: "normas/lisr-28-XX.yaml",
  },
  'lisr-72-73': {
    id: 'lisr-72-73',
    instrumento: "Ley del Impuesto sobre la Renta",
    articulo: "72 y 73",
    titulo: "Título II, Capítulo VII — Del Régimen de Coordinados",
    citas: ["LISR 72-73", "LISR 72–73", "LISR 72"],
    jerarquia: 1,
    estado: "verificado_fuente_primaria",
    exigibleDesde: null,
    ficha: "normas/lisr-72-73.yaml",
  },
  'liva-art-5': {
    id: 'liva-art-5',
    instrumento: "Ley del Impuesto al Valor Agregado",
    articulo: "5",
    titulo: "Requisitos del acreditamiento del IVA",
    citas: ["LIVA art. 5", "LIVA 5-III"],
    jerarquia: 1,
    estado: "verificado_fuente_primaria",
    ficha: "normas/liva-5.yaml",
  },
  'politica-portales-plazos-facturacion': {
    id: 'politica-portales-plazos-facturacion',
    instrumento: "Portales de autofacturación de comercios (varios)",
    articulo: undefined,
    titulo: "Ventanas de facturación por cadena",
    citas: ["plazoVerificado"],
    jerarquia: 6,
    estado: "sin_verificar",
    ficha: "normas/politica-portales-plazos.yaml",
  },
  'rfa-2026-2.1': {
    id: 'rfa-2026-2.1',
    instrumento: "Resolución de Facilidades Administrativas para 2026",
    articulo: "2.1",
    titulo: "Retención del ISR a operadores, macheteros y maniobristas (7.5%, sobre el SBC)",
    citas: ["RFA 2026 regla 2.1"],
    jerarquia: 3,
    estado: "verificado_fuente_primaria",
    exigibleDesde: "2026-02-18",
    ficha: "normas/rfa-2026-2.1.yaml",
  },
  'rfa-2026-2.2': {
    id: 'rfa-2026-2.2',
    instrumento: "Resolución de Facilidades Administrativas para 2026",
    articulo: "2.2",
    titulo: "Facilidades de comprobación (deducción del 8%, 'gasto ciego')",
    citas: ["RFA 2026 regla 2.2"],
    jerarquia: 3,
    estado: "verificado_fuente_primaria",
    exigibleDesde: "2026-02-18",
    ficha: "normas/rfa-2026-2.2.yaml",
  },
  'rfa-2026-2.3': {
    id: 'rfa-2026-2.3',
    instrumento: "Resolución de Facilidades Administrativas para 2026",
    articulo: "2.3",
    titulo: "Responsabilidad solidaria acotada del coordinado cuando el integrante tributa individual",
    citas: ["RFA 2026 regla 2.3"],
    jerarquia: 3,
    estado: "verificado_fuente_primaria",
    exigibleDesde: "2026-02-18",
    ficha: "normas/rfa-2026-2.3.yaml",
  },
  'rfa-2026-2.5': {
    id: 'rfa-2026-2.5',
    instrumento: "Resolución de Facilidades Administrativas para 2026",
    articulo: "2.5",
    titulo: "Concepto de coordinado (la definición administrativa que completa a LISR 72)",
    citas: ["RFA 2026 regla 2.5"],
    jerarquia: 3,
    estado: "verificado_fuente_primaria",
    exigibleDesde: "2026-02-18",
    ficha: "normas/rfa-2026-2.5.yaml",
  },
  'rfa-2026-2.9': {
    id: 'rfa-2026-2.9',
    instrumento: "Resolución de Facilidades Administrativas para 2026",
    articulo: "2.9",
    titulo: "Adquisición de combustibles",
    citas: ["RFA 2026 regla 2.9"],
    jerarquia: 3,
    estado: "verificado_fuente_primaria",
    exigibleDesde: "2026-02-18",
    ficha: "normas/rfa-2026-2.9.yaml",
  },
  'rlisr-57': {
    id: 'rlisr-57',
    instrumento: "Reglamento de la Ley del Impuesto sobre la Renta",
    articulo: "57",
    titulo: "Establecimiento del contribuyente y viáticos a nombre del trabajador",
    citas: ["RLISR 57"],
    jerarquia: 2,
    estado: "verificado_fuente_primaria",
    ficha: "normas/rlisr-57.yaml",
  },
  'rliva-3-fr-II': {
    id: 'rliva-3-fr-II',
    instrumento: "Reglamento de la Ley del Impuesto al Valor Agregado",
    articulo: "3",
    fraccion: "II",
    titulo: "Retención del 4% de IVA por servicios de autotransporte terrestre de bienes",
    citas: ["RLIVA 3-II"],
    jerarquia: 2,
    estado: "verificado_fuente_primaria",
    ficha: "normas/rliva-3-fr-II.yaml",
  },
  'rmf-2026-2.7.1.21': {
    id: 'rmf-2026-2.7.1.21',
    instrumento: "Resolución Miscelánea Fiscal para 2026",
    articulo: "2.7.1.21",
    titulo: "Expedición de comprobantes en operaciones con el público en general (factura global)",
    citas: ["RMF 2.7.1.21"],
    jerarquia: 3,
    estado: "evidencia_corroborante",
    ficha: "normas/rmf-2026-2.7.1.21.yaml",
  },
  'rmf-2026-2.7.1.29': {
    id: 'rmf-2026-2.7.1.29',
    instrumento: "Resolución Miscelánea Fiscal para 2026",
    articulo: "2.7.1.29",
    titulo: "Forma de pago por definir y complemento de recepción de pagos",
    citas: ["RMF 2.7.1.29"],
    jerarquia: 3,
    estado: "verificado_fuente_primaria",
    exigibleDesde: "2026-01-01",
    ficha: "normas/rmf-2026-2.7.1.29.yaml",
  },
  'rmf-2026-2.7.1.48': {
    id: 'rmf-2026-2.7.1.48',
    instrumento: "Resolución Miscelánea Fiscal para 2026",
    articulo: "2.7.1.48",
    titulo: "Complemento Concepto para la facturación de Hidrocarburos y Petrolíferos",
    citas: ["2.7.1.48"],
    jerarquia: 3,
    estado: "evidencia_corroborante",
    // NADIE HA CONFIRMADO DESDE CUÁNDO SE EXIGE. La ficha trae
    // `fecha_vigencia_desde: null` y lo dice con todas sus letras: la regla,
    // reformada el 09-jul-2026, sigue redactada en futuro, así que la obligación
    // puede estar latente. Mientras esto sea null, `cuadre/engine.ts` avisa pero
    // NO declara no deducible por falta de complemento.
    exigibleDesde: null,
    ficha: "normas/rmf-2026-2.7.1.48.yaml",
  },
  'rmf-2026-9.1.8': {
    id: 'rmf-2026-9.1.8',
    instrumento: "Resolución Miscelánea Fiscal para 2026",
    articulo: "9.1.8 (Título 9, Capítulo 9.1)",
    titulo: "Requisitos operativos del estímulo del 50% de peaje: aviso de marzo, bitácora de viaje conciliada, pago electrónico y factor 0.5 sin IVA",
    citas: ["RMF 9.1.8", "regla 9.1.8"],
    jerarquia: 3,
    estado: "verificado_fuente_primaria",
    // La entrada en vigor de la RMF 2026 (DOF 28-dic-2025, vigor 01-ene-2026).
    // La fr. IV RESUELVE el hallazgo H4 de la ficha LIF: la base del
    // acreditamiento es el importe SIN IVA — lo que el motor ya aplicaba.
    exigibleDesde: '2026-01-01',
    ficha: "normas/rmf-2026-9.1.8.yaml",
  },
  'rmf-2026-2.7.7': {
    id: 'rmf-2026-2.7.7',
    instrumento: "Resolución Miscelánea Fiscal para 2026",
    articulo: "Sección 2.7.7 (2.7.7.1.1, 2.7.7.1.2, 2.7.7.2.1, 2.7.7.2.8)",
    titulo: "Complemento Carta Porte: obligados, traslado local y la excepción del radio de 30 km",
    citas: ["2.7.7.1.1", "2.7.7.2.1", "2.7.7.2.8", "Carta Porte"],
    jerarquia: 3,
    estado: "verificado_fuente_primaria",
    // La fecha es la de la VERSIÓN 3.1 del complemento (obligatoria desde el
    // 17-jul-2024). No hay periodo de gracia en 2026: se leyeron los 25
    // transitorios de la RMF 2026 y la 1a Modificación no tocó la 2.7.7.
    exigibleDesde: '2024-07-17',
    ficha: "normas/rmf-2026-2.7.7.yaml",
  },
  'rmf-2026-3.3.1.7': {
    id: 'rmf-2026-3.3.1.7',
    instrumento: "Resolución Miscelánea Fiscal para 2026",
    articulo: "3.3.1.7",
    titulo: "Comprobación de combustibles adquiridos con monedero electrónico autorizado — la estación no emite CFDI al adquirente",
    citas: ["RMF 3.3.1.7"],
    jerarquia: 3,
    estado: "evidencia_corroborante",
    exigibleDesde: '2026-01-01',
    ficha: "normas/rmf-2026-3.3.1.7.yaml",
  },
  // Rescatadas de `rutina-fiscal-wip` (rama huérfana del 21-ago, nunca
  // mergeada): investigación legal verificada contra fuente primaria que
  // nadie más había escrito. No cambian ningún veredicto del motor —
  // `usado_en_codigo: []` en las cinco fichas— son evidencia para decisiones
  // pendientes (anticipo de ruta vs. salario base de cotización, catálogo de
  // la Red Nacional de Autopistas de Cuota) y corpus de referencia.
  'lss-27': {
    id: 'lss-27',
    instrumento: "Ley del Seguro Social",
    articulo: "27",
    titulo: "Salario base de cotización — y el hallazgo de que los VIÁTICOS no están entre las exclusiones",
    citas: ["LSS 27", "art. 27 LSS", "salario base de cotización"],
    jerarquia: 1,
    estado: "verificado_fuente_primaria",
    exigibleDesde: '2009-01-16',
    ficha: "normas/lss-27.yaml",
  },
  'red-nacional-autopistas': {
    id: 'red-nacional-autopistas',
    instrumento: "Ley de Ingresos de la Federación 2026 / Ley de Caminos, Puentes y Autotransporte Federal",
    articulo: "LIF 2026 art. 20 ap. A fr. V; LCPAF art. 2o. fr. I",
    titulo: "Qué es la Red Nacional de Autopistas de Cuota — y por qué NO se puede resolver con una lista blanca de casetas",
    citas: ["Red Nacional de Autopistas de Cuota"],
    jerarquia: 1,
    estado: "verificado_fuente_primaria",
    exigibleDesde: '2026-01-01',
    ficha: "normas/red-nacional-autopistas.yaml",
  },
  'tesis-autotransporte': {
    id: 'tesis-autotransporte',
    instrumento: "Semanario Judicial de la Federación / Revista del Tribunal Federal de Justicia Administrativa",
    articulo: "Tesis y precedentes aplicables al autotransporte de carga federal",
    titulo: "Lo que los tribunales SÍ han resuelto — y los dos vacíos donde no hay criterio en ningún acervo publicado de México",
    citas: ["2a./J. 54/2022", "VI-P-1aS-383", "VII-TASR-1NOI-18", "VII-CASR-NCIV-18", "1a./J. 49/2019"],
    jerarquia: 5,
    estado: "verificado_fuente_primaria",
    ficha: "normas/tesis-autotransporte.yaml",
  },
  'rmf-2026-9.1.7': {
    id: 'rmf-2026-9.1.7',
    instrumento: "Resolución Miscelánea Fiscal para 2026",
    articulo: "9.1.7",
    titulo: "Carreteras o caminos para acreditamiento del estímulo — la regla cuya remisión apunta a un párrafo inexistente",
    citas: ["RMF 9.1.7", "regla 9.1.7"],
    jerarquia: 3,
    estado: "verificado_fuente_primaria",
    exigibleDesde: '2026-01-01',
    ficha: "normas/rmf-2026-9.1.7.yaml",
  },
  'criterios-imss-sbc': {
    id: 'criterios-imss-sbc',
    instrumento: "Criterios Normativos en materia de Seguridad Social del H. Consejo Técnico del IMSS",
    articulo: "01/2024/NV/SBC-LSS-27-I y 02/2024/NV/SBC-LSS-27-V",
    titulo: "Los dos criterios del IMSS que deciden si un anticipo de ruta integra salario base de cotización — y el que alcanza a quien presta el servicio",
    citas: ["criterio IMSS 01/2024", "criterio IMSS 02/2024"],
    jerarquia: 5,
    estado: "verificado_fuente_primaria",
    exigibleDesde: '2024-07-11',
    ficha: "normas/criterios-imss-sbc.yaml",
  },
};

/** Todas las normas conocidas. */
export const IDS_NORMA = Object.keys(NORMAS);

/** Devuelve la norma o `undefined`. Nunca inventa una. */
export function norma(id: string): Norma | undefined {
  return NORMAS[id];
}

/**
 * Cómo se escribe una norma para un humano. Sale del índice, nunca del modelo.
 */
export function citaDe(id: string): string | undefined {
  const n = NORMAS[id];
  return n?.citas[0];
}
