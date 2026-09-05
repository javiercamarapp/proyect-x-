// ═══════════════════════════════════════════════════════════════════════════
// MOTOR DE CUADRE (determinístico, sin LLM) — el diferenciador de Likida.
//
// Compara los gastos comprobados contra el anticipo entregado y la política de
// la flota, y detecta: sobre-política, faltante de CFDI, duplicados y baja
// confianza de OCR. Es una función pura → testeable, auditable, sin sorpresas.
// El LLM del agente ORQUESTA (pide fotos, explica), pero la DECISIÓN de dinero
// la toma este motor. Eso es lo que da "sin fallas".
// ═══════════════════════════════════════════════════════════════════════════

import { strip_accents } from './util';
import { diasSobreTope } from './tope_alimentacion';
import { fechaDudosa } from './fecha_dudosa';
import { sanitizarFolio } from '../intake/sanitizar';
import { esRfcValido, rfcChecksumOk } from '../intake/cfdi';
import { calcularCaducidad, type Plazo } from '../facturacion/caducidad';
import { identificarComercio } from '../facturacion/identificar';
import { NORMAS } from '../normas/indice';
import { evidenciaMonedero, notaTicketMonedero, type LineaEccRef } from '../intake/evidencia_monedero';
import type { Gasto, Diferencia, Liquidacion, EstatusLiquidacion, TipoDiferencia } from '@/types/likida';
// `formato.ts` no importa NADA: el motor sigue siendo puro y sin I/O.
import { mxn, round2 } from '@/lib/formato';

export interface PoliticaGasto {
  concepto: string;       // diesel | caseta | viaticos | factura | otro
  ruta?: string;          // aplica a ruta específica (opcional)
  topeMonto?: number;     // tope permitido por comprobante
  requiereCfdi?: boolean; // el concepto exige CFDI válido
}

export interface CuadreInput {
  viajeId: string;
  anticipo: number;
  gastos: Gasto[];
  politica: PoliticaGasto[];
  ruta?: string;
  /** Umbral de confianza de OCR bajo el cual se marca "revisar". Default 0.85. */
  umbralConfianza?: number;
  /** RFC de la empresa: el receptor de cada CFDI debe coincidir (no el chofer). */
  empresaRfc?: string;
  /** RFCs adicionales válidos de la flota (razones sociales múltiples). */
  rfcsAdicionales?: string[];
  /** RFC del operador del viaje. Un viático a SU nombre es válido (RLISR 57):
   *  los comprobantes de quien presta servicios subordinados pueden expedirse a
   *  nombre de esa persona. Sin este dato no se rechaza — se manda a revisar. */
  operadorRfc?: string;
  /** El operador ejerció su derecho de OPOSICIÓN a la decisión automatizada
   *  (LFPDPPP art. 26-II, mig. 0100). Con `true`, la liquidación sale a
   *  revisión humana SIEMPRE: el aviso de privacidad promete que puede pedir
   *  "que la revise alguien", y esta bandera es lo que vuelve cierta esa
   *  promesa. El cálculo se hace igual (números correctos que una persona
   *  revisa), lo que cambia es que ya no se cierra sola. */
  oposicionTitular?: boolean;
  /** Complemento de hidrocarburos (Bloque 1): claves de combustible, unidad,
   *  y desde cuándo se MIRA. Sin esto, la regla no corre.
   *
   *  `vigenteDesde` viene de la configuración y NO decide dinero: es solo el
   *  filtro de ruido que evita pedir el complemento sobre CFDI viejos. La fecha
   *  que decide dinero es `exigibleDesde`, y su fuente es la FICHA. */
  hidrocarburos?: {
    claves: string[];
    unidad: string;
    vigenteDesde: string;
    /** Fecha de EXIGIBILIDAD respaldada por ficha, o `null` si nadie la ha
     *  confirmado. Si se omite, se toma de `normas/rmf-2026-2.7.1.48.yaml` a
     *  través del índice — que hoy dice `null`. Está aquí para poder probar las
     *  dos ramas y para que el día que se confirme entre por configuración sin
     *  tocar el motor. */
    exigibleDesde?: string | null;
  };
  /** Estímulos y topes fiscales (LIF 2026 art. 20, ap. A / LISR). */
  estimulos?: { peajeFactor: number; viaticosTopeFiscalDiarioMxn: number; efectivoTopeMxn: number; clavesDieselIeps?: string[]; precioDieselPorDefecto?: number };
  /** Hoy (ISO YYYY-MM-DD), para el aviso de tickets por facturar. Se INYECTA:
   *  el motor es puro y no lee el reloj del servidor. Sin esto, esa regla no corre. */
  hoy?: string;
  /** Rango de fecha válido para los comprobantes (ISO YYYY-MM-DD). Fuera → sospechosa. */
  fechaMin?: string;
  fechaMax?: string;
  /** RFA 2026 regla 2.9 — la facilidad del 15% de combustible en efectivo.
   *  `true` = flota declaró dedicación exclusiva Y régimen elegible (el motor
   *  abre la válvula y aplica el contador del 15%). `false` = declaró que NO
   *  califica (el efectivo en combustible NO se deduce). `undefined` = sin
   *  declarar (el efectivo sale a revisar, no se afirma nada). */
  facilidad15?: boolean;
  /** FASE 3 (perfil/preguntas.ts, `calificaEstimuloPeaje`) — LIF 2026 art.
   *  20-A exige ingresos < $300M y no ser parte relacionada (LISR art. 179)
   *  para el estímulo de peaje; `config.ts:127` lo aplicaba sin condición.
   *  `undefined` = el perfil no lo declaró todavía: NO se acredita. El
   *  estímulo no se concede por omisión; falta la declaración de elegibilidad.
   *  `false` = el perfil YA CONFIRMÓ que no califica: deja de acreditarse,
   *  no solo de avisarse. */
  elegiblePeaje?: boolean;
  /** Total pagado por combustible de la flota en el EJERCICIO (incluido este
   *  viaje) — la base del 15%. Lo calcula `desde_db.ts` (RFA 2.9). */
  totalCombustibleEjercicio?: number;
  /** Combustible pagado en efectivo de la flota en el ejercicio ANTES de esta
   *  liquidación — el contador ya corrido. El motor suma el de ESTE viaje. */
  efectivoPrevEjercicio?: number;
  /** FASE 2: líneas del complemento ECC ya persistidas (inyectadas por
   *  `desde_db`). Sin ellas el camino B de `evidenciaMonedero` no afirma.
   *  Puro: el motor no lee la base. */
  lineasEcc?: LineaEccRef[];
  /** El año del ejercicio fiscal de esta liquidación (el de los comprobantes,
   *  no el del proceso). Un gasto de otro año no corre contra este contador. */
  anioEjercicio?: string;
}

function politicaPara(concepto: string, ruta: string | undefined, pol: PoliticaGasto[]): PoliticaGasto | undefined {
  const c = strip_accents(concepto.toLowerCase());
  // Preferir una política específica de la ruta; si no, la general del concepto.
  const dela = pol.filter((p) => strip_accents(p.concepto.toLowerCase()) === c);
  return dela.find((p) => p.ruta && ruta && p.ruta === ruta) ?? dela.find((p) => !p.ruta);
}

/** Conceptos que la ley trata como viático (LISR 28-V / RLISR 57). */
const ES_VIATICO = ['alimentacion', 'hospedaje', 'transporte', 'viaticos'];

/** En cuál de las tres cubetas de deducibilidad cae un gasto. */
export type Cubeta = 'deducible' | 'no_deducible' | 'por_confirmar';

// AUDITORÍA 2 (fiscal): los medios de pago que la LISR 27-III / LIF 20-A-IV
// aceptan para acreditar un estímulo. Lista CERRADA (02 cheque, 03 transferencia,
// 04 tarjeta crédito, 05 monedero, 28 débito, 29 servicios) — NO "cualquiera que
// no sea 01 efectivo": eso dejaba pasar 06 dinero electrónico, 08 vales, 30/31 y
// sobre todo '99 Por definir', que la RMF 2.7.1.29 fr. II define como NO PAGADO.
export const MEDIOS_LISR_27_III = ['02', '03', '04', '05', '28', '29'] as const;
/** '99 Por definir' = la contraprestación no se ha pagado (RMF 2.7.1.29 fr. II). */
export const FORMA_PAGO_SIN_PAGAR = '99';
/**
 * El tope de la LISR 27-III, primer párrafo (`normas/lisr-27-III.yaml`):
 * «los pagos cuyo monto exceda de $2,000.00 se efectúen mediante
 * transferencia electrónica…». Es el default cuando la configuración del
 * tenant no trae `estimulos.efectivoTopeMxn`.
 *
 * AUDITORÍA 24, PRU-2 (ALTO): vivía como `?? 2000` suelto en el cuerpo del
 * motor y NINGUNA prueba lo pisaba — `?? 20000` pasaba 10,001 pruebas en
 * verde. Con nombre y exportado, `tope_efectivo_default.test.ts` lo ancla a
 * la ficha en la frontera exacta ($2,000.00 pasa, $2,000.01 no).
 */
export const TOPE_EFECTIVO_LISR_27_III = 2000;

/**
 * ¿Este comprobante está A CRÉDITO y NADIE lo ha pagado todavía? `'99 Por
 * definir'` sin el sello del REP (`pagadoEn`, que solo escribe `intake/rep.ts`
 * cuando un complemento de pago liquidó el CFDI por completo).
 *
 * AUDITORÍA 24, FIS-6 (ALTO). El motor resolvió el `'99'` para el IVA
 * (auditoría 2: LIVA 5-III, «efectivamente pagado en el mes») y para el
 * MEDIO (FIS-1: se juzga la forma del REP), y nunca para la cubeta de ISR:
 * un hospedaje de $58,000 PPD sin REP salía «Deducible para ISR» en verde y
 * la liquidación «Cuadrada». Es afirmar un requisito que todavía no se puede
 * conocer: para los regímenes a los que se vende la facilidad (coordinados y
 * PF con actividad empresarial, `normas/lisr-72-73.yaml` remite a la Sección
 * I del Cap. II del Título IV — flujo de efectivo; el art. 105-I que fija
 * «efectivamente erogadas» NO tiene ficha propia: se anota no verificable)
 * la deducción nace al pagar; y para combustible el 2º párrafo del 27-III
 * condiciona la deducción al MEDIO cualquiera que sea el monto, y con `'99'`
 * el medio no existe aún. La regla de la casa para la AUSENCIA de evidencia
 * es ámbar, no verde: `por_confirmar`, y la liquidación a revisión. Cuando
 * el REP selle `pagadoEn`, el recuadre lo saca solo.
 */
export function pagoPendiente(g: Pick<Gasto, 'formaPago' | 'pagadoEn'>): boolean {
  return g.formaPago === FORMA_PAGO_SIN_PAGAR && !g.pagadoEn;
}

/** La leyenda que lee el contralor sobre un comprobante a crédito sin pagar. */
export const LEYENDA_PAGO_PENDIENTE =
  'A crédito (forma de pago 99) y sin complemento de pago: pendiente de pago comprobado. ' +
  'Se deduce cuando se pague y con el medio con que se pague (LISR 27-III; coordinados y personas físicas: al pago efectivo).';

/**
 * ¿Este pago de COMBUSTIBLE se hizo con «un medio distinto» a los que la LISR
 * 27-III admite? Si sí, entra al cubo del 15% de la RFA 2026 regla 2.9.
 *
 * AUDITORÍA 18-c3, FISC-C3-1 (CRÍTICO). La norma
 * (`normas/rfa-2026-2.9.yaml`, verificado_fuente_primaria) define el cubo por
 * EXCLUSIÓN: «cuando los pagos por consumo de combustible se realicen con
 * medios distintos a cheque nominativo…; tarjeta de crédito, de débito o de
 * servicios; o monederos electrónicos autorizados por el SAT». La regla del
 * motor leía `formaPago === '01'`, o sea UN valor, y `'06' Dinero
 * electrónico`, `'08' Vales`, `'12' Dación en pago`, `'17' Compensación` y
 * `'23' Novación` salían «Deducible para ISR» en verde con su IVA acreditado.
 *
 * Dos fronteras que este predicado sostiene a propósito:
 *
 * - **Sin `formaPago` devuelve `false`.** Desconocido no es «medio distinto»:
 *   suponerlo inflaría el no-deducible contra la flota. Mismo estándar que
 *   `causasDe` en `fiscal.ts` y que `getAcumuladoCombustible` en `repo.ts`.
 * - **`'99'` devuelve `false`.** No es un medio distinto: es que NO se pagó
 *   (RMF 2.7.1.29 fr. II). Ese caso lo juzga la regla de pago efectivo, no
 *   esta, y el tratamiento de ISR para ese caso sigue pendiente de resolver
 *   en el motor — ver el seguimiento interno de auditorías, no se resuelve
 *   en esta función.
 */
export function medioNoAdmitidoCombustible(formaPago: string | null | undefined): boolean {
  if (!formaPago) return false;
  if (formaPago === FORMA_PAGO_SIN_PAGAR) return false;
  return !(MEDIOS_LISR_27_III as readonly string[]).includes(formaPago);
}

/**
 * Cómo se nombra el medio de pago en la nota que lee el contralor. Un rótulo
 * tiene que ser verdad: con `'06'` la nota no puede decir «EFECTIVO».
 */
function comoSePago(formaPago: string | null | undefined, pagadoEn?: string): string {
  // FIS-5: cuando la forma viene del complemento de pago, el papel lo dice —
  // el CFDI decía «99 Por definir» y fue el REP quien reveló el medio real.
  const segunRep = pagadoEn ? ` según su complemento de pago del ${pagadoEn}` : '';
  return formaPago === '01'
    ? `pagado en EFECTIVO${segunRep}`
    : `pagado con la forma de pago «${formaPago}»${segunRep}, que no es de las que la LISR 27-III admite para combustible`;
}
/**
 * Medios que cuentan como "sistema electrónico de pago" para el estímulo de
 * PEAJE. `normas/rmf-2026-9.1.8.yaml` fr. III (verificado_fuente_primaria):
 * "Efectuar los pagos de autopistas mediante la tarjeta de identificación
 * automática vehicular o de cualquier otro sistema electrónico de pago con que
 * cuente la autopista". Es una condición de FORMA sobre cada pago, no una
 * declaración de la flota, y el motor la puede cerrar solo porque `formaPago`
 * ya viene en la fila.
 *
 * AUDITORÍA 18, A7: la puerta era `!== '01' && !== '99'`, o sea "cualquier
 * cosa que no sea efectivo ni no-pagado". Por ahí entraban el cheque (02), la
 * dación en pago (12), la compensación (17) o la novación (23), que no son un
 * sistema electrónico de la autopista. Lista CERRADA: transferencia (03),
 * tarjeta de crédito (04), monedero electrónico (05), dinero electrónico (06),
 * tarjeta de débito (28) y de servicios (29). El TAG (IAVE/PASE/TeleVía) se
 * liquida con alguno de éstos y su CFDI lo declara así.
 */
export const MEDIOS_ELECTRONICOS_PEAJE = ['03', '04', '05', '06', '28', '29'] as const;
/**
 * La LECTURA que el motor aplica al 15% de la RFA 2026 regla 2.9, dicha en el
 * papel. La regla tiene por cumplida la obligación de LISR 27-III "siempre que
 * [los pagos en efectivo] no excedan el 15 por ciento del total de los pagos
 * efectuados por consumo de combustible". Dos lecturas se sostienen del mismo
 * texto: (a) un TOPE prorrateable —solo el excedente pierde la deducción—, la
 * más usada en la práctica y la que aplica el motor; (b) una CONDICIÓN de
 * procedencia —rebasado el 15%, la facilidad no se tiene por cumplida y TODO el
 * efectivo del ejercicio cae bajo LISR 27-III—. Sobre $1,000,000 de combustible
 * con $200,000 en efectivo la diferencia entre ambas son $150,000 de deducción.
 *
 * AUDITORÍA 18, B4: el motor elegía (a) y no lo decía, cuando la regla de este
 * producto es declarar la lectura que usó (`BASE_ESTIMULO_PEAJE` lo hace para el
 * peaje). La ficha `normas/rfa-2026-2.9.yaml` tampoco resuelve la ambigüedad,
 * así que no es un error demostrable: es una interpretación, y va escrita.
 */
/**
 * Señal de que un ticket de "alimentación" es en realidad un BAR.
 *
 * `normas/lisr-28-XX.yaml` (evidencia_corroborante; el PDF de diputados no se
 * pudo leer): "En ningún caso los consumos en bares serán deducibles". Y por
 * LIVA 5-I ("estrictamente indispensable" = deducible para ISR) tampoco
 * acreditan IVA. El OCR agrupa restaurante, fonda, tortas y café bajo una sola
 * etiqueta y no captura si hubo alcohol, así que el motor NO puede afirmar 0%
 * sin inventar; lo que sí puede es NO afirmar "deducible al 100%" cuando la
 * razón social o el producto gritan bar. Se busca por PALABRA completa: "BAR
 * LA OFICINA" o "CANTINA EL GALLO" disparan; "BARBACOA" o "LA BARRA" no.
 *
 * AUDITORÍA 18, M5: un ticket de bar de $600 con CFDI y tarjeta salía
 * "Deducible para ISR $600.00" en verde y acreditaba $82.76 de IVA citando
 * LIVA 5. La ficha lo declaraba NO_IMPLEMENTADO; mientras no exista la
 * clasificación bar/restaurante en el intake, este regex es la lectura
 * conservadora: el gasto va a POR CONFIRMAR (tercer estado), no a deducible.
 */
export const SENAL_BAR = /\b(bar|bares|cantina|cervecer[ií]a|pulquer[ií]a|antro|cabaret|table\s*dance|vinos\s+y\s+licores)\b/i;

/**
 * AUDITORÍA 25 (REAUDITORÍA), FIS-REAUD-2: el umbral de `renglones_ajenos` de
 * abajo, con NOMBRE, para que `fiscal.ts` (y la migración de la RPC agregada
 * que alimenta el panel) lo IMPORTEN y lo pasen a SQL como parámetro en vez
 * de escribir su propio 0.15 — la misma disciplina que ya sigue
 * `MEDIOS_LISR_27_III` y `medioNoAdmitidoCombustible` en este archivo. Un
 * umbral duplicado que se mueve aquí y no allá es la clase exacta de "dos
 * cálculos" que este dominio no puede permitirse.
 */
export const UMBRAL_RENGLONES_AJENOS = 0.15;

/** El RFC de "público en general" del SAT — capturarlo es lo mismo que no
 *  haber capturado un RFC real. */
export const RFC_GENERICO = 'XAXX010101000';

/** El mismo normalizador de RFC que usa la comparación de receptor de abajo:
 *  mayúsculas, sin acentos, sin espacios. Exportado para que `fiscal.ts`
 *  compare el RFC del receptor contra el MISMO criterio (RE-AUDITORÍA 25,
 *  FIS-REAUD-2) sin reinventar la normalización. */
export function normalizarRfc(r: string): string {
  return strip_accents(r.toUpperCase().replace(/\s/g, ''));
}

/**
 * Los RFC de la flota que SÍ sirven para comparar contra el receptor de un
 * CFDI — extraído de `cuadrarViaje` (RE-AUDITORÍA 25, FIS-REAUD-2) para que
 * `fiscal.ts` compare el mismo conjunto en vez de reinventar el filtro:
 * descarta vacíos, el genérico del SAT y cualquiera que no pase el dígito
 * verificador. Vacío = ningún RFC utilizable (sin capturar, o capturado pero
 * inválido/genérico) — `cuadrarViaje` distingue esos dos casos con
 * `empresaRfc` aparte; este conjunto por sí solo no lo dice.
 */
export function rfcsUtilizablesDe(empresaRfc: string | undefined, rfcsAdicionales: string[] | undefined): Set<string> {
  return new Set(
    [empresaRfc, ...(rfcsAdicionales ?? [])]
      .filter(Boolean)
      .map((r) => normalizarRfc(r as string))
      .filter((r) => r !== RFC_GENERICO)
      .filter((r) => esRfcValido(r) && rfcChecksumOk(r)),
  );
}

/** ¿El ticket de alimentación parece un bar? Mira la razón social y el producto leídos del papel. */
export function pareceBar(g: Pick<Gasto, 'concepto' | 'ocrExtra'>): boolean {
  if (g.concepto !== 'alimentacion') return false;
  const x = g.ocrExtra as Record<string, unknown> | undefined;
  const textos = [x?.emisor, x?.producto].filter((v): v is string => typeof v === 'string' && v.length > 0);
  return textos.some((t) => SENAL_BAR.test(t));
}

export const LECTURA_RFA_29_PRORRATEO =
  'Lectura aplicada: el 15% se trata como tope prorrateable (solo el excedente pierde la deducción); ' +
  'la lectura literal del "siempre que" de la regla 2.9 negaría la facilidad a TODO el combustible en efectivo ' +
  'del ejercicio — confírmela con su contador.';

export const NO_DEDUCIBLE_ISR: TipoDiferencia[] = ['rfc_receptor', 'cfdi_cancelado', 'cfdi_efos', 'cfdi_no_encontrado', 'complemento_hidrocarburos', 'efectivo_sobre_tope', 'efectivo_no_elegible'];
// AUDITORÍA 21, CRÍTICO (fiscal): `cfdi_efos_indeterminado` entra a
// POR_CONFIRMAR (y a SIN_IVA_ACREDITABLE, abajo) por el mismo camino que
// `cfdi_pendiente`. Desde que la auditoría 9 quitó —con razón— el mapeo
// `'100' → efos: true` (ConsultaCFDIService no distingue el listado presunto
// del definitivo del CFF 69-B), NADA produce `efos: true`, así que la rama
// `cfdi_efos` de NO_DEDUCIBLE_ISR quedó inalcanzable y el ÚNICO rastro de un
// emisor ya publicado en DEFINITIVA era esta diferencia... que solo movía el
// badge a "revisar". El CFDI caía en la cubeta `deducible` y acreditaba su IVA
// completo, en verde y citando LIVA 5 — sobre operaciones que `cff-69-B.yaml`
// (verificado_fuente_primaria, 4º párrafo) declara sin "efecto fiscal alguno".
// No va a NO_DEDUCIBLE_ISR porque el servicio tampoco distingue al PRESUNTO
// (1er párrafo: solo "se presumirá", con derecho a desvirtuar) — declararlo
// fraude sería el falso positivo que `intake/sat.ts` documenta como peor que
// el falso negativo. Tercer estado: ni deducible ni no-deducible, a cotejar el
// listado del DOF a mano.
//
// AUDITORÍA 25, ALTO FISCAL (fiscal.md línea 282): `gasto_otro_ejercicio`
// entra aquí, no a NO_DEDUCIBLE_ISR. El propio repo declara la diferencia
// como CALIDAD DEL DATO —"la fecha, no un veredicto de qué norma exacta rige
// el periodo fiscal" (`normas/por_diferencia.ts:113`)— y no tiene ficha, pero
// emitía el veredicto MÁS CARO del motor: «No deducible $X.00» en rojo sobre
// un CFDI que sí es deducible, solo que en OTRO ejercicio. El motor no puede
// afirmar la deducción (no es de este año) ni negarla de plano (si es real y
// a tiempo, el contador la toma en el ejercicio correcto) — el tercer estado
// de siempre. Sigue SIN entrar a SIN_IVA_ACREDITABLE (abajo): eso es
// deliberado y no cambia con este hallazgo — LIVA 5-I exige acreditar "en la
// proporción en que las erogaciones sean deducibles", y la proporción de ESTE
// ejercicio sigue siendo cero.
export const POR_CONFIRMAR: TipoDiferencia[] = ['combustible_efectivo', 'rfc_receptor_no_verificable', 'cfdi_pendiente', 'cfdi_efos_indeterminado', 'consumo_bar', 'ticket_monedero', 'renglones_ajenos', 'medio_pago_no_admitido', 'gasto_otro_ejercicio'];

// ── AUDITORÍA 22, FIS-C2 (CRÍTICO): DOS PREGUNTAS, DOS LISTAS ─────────────
// Esto era UNA lista para dos preguntas distintas —«¿acredita IVA?» y
// «¿acredita el estímulo de diésel/peaje?»— y los dos tipos de la RFA 2.9
// entraron para cerrar la segunda y cerraron las dos.
//
// Lo que dicen las fichas, leídas:
//   · `rfa-2026-2.9.yaml` → `limite_importante`: «Conserva la DEDUCCIÓN para
//     ISR. NO habilita el acreditamiento del IEPS». Dice IEPS. NO dice IVA.
//   · `liva-5.yaml` art. 5 fr. I: son indispensables «las erogaciones… que
//     sean deducibles para los fines del impuesto sobre la renta», y las
//     parcialmente deducibles acreditan «en la proporción».
//
// O sea: el mismo CFDI de diésel perdía sus $16,000 de IVA solo por el medio
// de pago, bajo el rótulo «IVA acreditable (LIVA art. 5)» — el artículo que
// lo contradice. Una flota con $5,000,000 de combustible al año y su 15% en
// efectivo perdía ~$103,000 anuales que la ley le concede.
//
// AUDITORÍA 12, ALTO (fiscal, reincidente de la 11): `cfdi_pendiente` entra
// aquí y en POR_CONFIRMAR — con el SAT caído o en timeout, "no se pudo
// verificar" es el MISMO tercer estado que el motor ya aplica a EFOS, al RFC
// y al complemento: nunca deducible, nunca acreditable.
//
// AUDITORÍA 24, ARQ-1: exportadas junto a sus hermanas de arriba, para que
// `contencion_listas.test.ts` pueda exigir la consistencia entre las cinco.
export const SIN_IVA_ACREDITABLE: TipoDiferencia[] = ['rfc_receptor', 'rfc_receptor_no_verificable', 'cfdi_cancelado', 'cfdi_efos', 'cfdi_efos_indeterminado', 'cfdi_no_encontrado', 'complemento_hidrocarburos', 'combustible_efectivo', 'efectivo_no_elegible', 'efectivo_sobre_tope', 'monto_invalido', 'cfdi_pendiente', 'consumo_bar', 'moneda_extranjera', 'gasto_otro_ejercicio', 'renglones_ajenos', 'medio_pago_no_admitido'];
// El estímulo (litros de diésel y peaje) SÍ lo niegan los dos tipos de la RFA
// 2.9: eso es exactamente lo que su `limite_importante` dice. Esta lista es
// la de arriba MÁS esos dos.
export const SIN_ESTIMULO: TipoDiferencia[] = [...SIN_IVA_ACREDITABLE, 'combustible_efectivo_dentro15', 'efectivo_sobre_15'];

/**
 * Los tipos que bajan una liquidación a «Por revisar» por razón OPERATIVA —
 * no por deducibilidad: una foto ilegible, un ticket sin timbrar, un exceso
 * de viático que hay que confirmar, una fecha rara…
 *
 * `ieps_no_desglosado` NO va aquí a propósito: el gasto es deducible y lo único
 * que se pierde es el acreditamiento del estímulo. Casi ningún CFDI de
 * gasolinera desglosa el IEPS al consumidor final, así que tenerlo en REVISAR
 * mandaba TODA liquidación con diésel a la bandeja y la vaciaba de significado.
 * Se sigue avisando en `diferencias`; ya no bloquea.
 *
 * `permiso_cre_no_verificable` TAMPOCO va aquí, por la MISMA razón exacta —y
 * costó un hallazgo verlo: AUDITORÍA 9, ALTO (frontend). Se dispara en TODO
 * CFDI de diésel con XML verificado —el camino de MEJOR calidad de dato que
 * existe hoy—, así que mandarlo a REVISAR volvía "Por revisar" (rojo,
 * `--color-bad` en el panel) el estatus de CUALQUIER liquidación con un
 * diésel bien facturado, incluido el viaje que `seed.sql` sembró como pieza
 * central del demo. El requisito sigue avisado —ahora con tono `condicionado`
 * en el renglón de deducibilidad, ver `liquidacion/deducibilidad.ts`— pero ya
 * no puede bajar un estatus que nunca podría volver a subir.
 */
export const REVISAR_OPERATIVO: TipoDiferencia[] = ['ocr_baja_confianza', 'sin_cfdi', 'monto_invalido', 'complemento_no_verificable', 'efectivo_sobre_15', 'viatico_excede_fiscal', 'factura_por_vencer', 'alimentacion_sin_soporte', 'alimentacion_transporte_sin_tarjeta_credito', 'viatico_rfc_operador', 'monto_discrepante', 'monto_implausible', 'moneda_extranjera', 'texto_sospechoso', 'fecha_sospechosa', 'iva_mes_del_pago', 'folio_verificar', 'comprobante_no_fiscal', 'diesel_desviacion', 'oposicion_titular'];

/**
 * Lo que baja una liquidación a «Por revisar». DERIVADA, no copiada.
 *
 * AUDITORÍA 24, ARQ-1 (ALTO, 6ª caída por el mismo hueco, 22→23→24): esta
 * lista se escribía a mano, con 35 valores, y `rfc_receptor_no_verificable`
 * —que está en POR_CONFIRMAR desde la auditoría 5— nunca entró. Resultado:
 * un CFDI de $11,600 a nombre de un tercero, con el RFC de la flota sin
 * capturar (`XAXX010101000` de la demo), daba `totalDeducible 0 ·
 * totalPorConfirmar 11,600 · estatus 'cuadrada'`: la misma hoja decía
 * «Cuadrada» en verde arriba y «Deducible para ISR: —» abajo, y el contralor
 * que filtra por «Cuadrada» para cerrar su semana se llevaba liquidaciones
 * con deducción cero.
 *
 * TypeScript verifica PERTENENCIA, nunca COBERTURA: nada ataba las listas.
 * La regla que esta derivación fija es la única que tiene sentido: TODO motivo
 * que saque un peso de la cubeta deducible (a `no_deducible` o a
 * `por_confirmar`) merece que una persona mire la liquidación antes de
 * cerrarla. Un tipo nuevo que entre a `NO_DEDUCIBLE_ISR` o a `POR_CONFIRMAR`
 * entra aquí solo; `contencion_listas.test.ts` lo exige contra el fuente.
 */
export const REVISAR: TipoDiferencia[] = [...new Set<TipoDiferencia>([...NO_DEDUCIBLE_ISR, ...POR_CONFIRMAR, ...REVISAR_OPERATIVO])];

/**
 * LA ÚNICA definición de en qué cubeta cae un gasto. Vive aquí, exportada, para
 * que nadie la reconstruya.
 *
 * `pdf.ts` la reconstruía por su cuenta desde `diferencias` con UN solo criterio
 * —el tipo de diferencia— y se saltaba el segundo, la ausencia de UUID. Como
 * `sin_cfdi` solo se emite si la política del tenant trae `requiereCfdi`, y
 * `DEMO_CONFIG` solo lo pone en `factura`, un hospedaje sin timbrar caía en
 * `por_confirmar` para el motor y en ninguna cubeta para el PDF: la sección
 * "LO QUE SE LE REEMBOLSA AL OPERADOR" desaparecía según un flag de
 * configuración, no según la ley. Es la misma contradicción que el comentario de
 * abajo documenta haber eliminado del lado fiscal, resucitada en otro archivo.
 *
 * `diferencias` es una vista PARCIAL de la decisión; esta función es la decisión.
 */
export function cubetaDe(g: Gasto, suyas: Diferencia[]): Cubeta {
  if (suyas.some((d) => NO_DEDUCIBLE_ISR.includes(d.tipo))) return 'no_deducible';
  if (suyas.some((d) => POR_CONFIRMAR.includes(d.tipo))) return 'por_confirmar';
  // A CRÉDITO Y SIN PAGAR NO ES DEDUCIBLE TODAVÍA (FIS-6, ver `pagoPendiente`).
  // Tercer estado: ni se afirma ni se pierde — llega el REP y sube sola.
  if (pagoPendiente(g)) return 'por_confirmar';
  // UN TICKET NO ES UNA FACTURA. LISR 27-III exige que la deducción esté
  // "amparada con un comprobante fiscal", y un ticket de gasolinera no lo es:
  // hay que timbrarlo. Contarlo como deducible le promete al contralor una
  // deducción que todavía no existe — y si nadie factura a tiempo, nunca
  // existirá. Tampoco es pérdida: se puede timbrar. Por eso POR CONFIRMAR.
  if (!g.cfdiUuid) return 'por_confirmar';
  return 'deducible';
}

/**
 * Qué gastos son COPIA de otro, y de cuál.
 *
 * Exportada y única, porque tiene DOS consumidores que se habían separado sin
 * que nadie lo notara: el cuadre —que excluye las copias del total comprobado—
 * y el resumen laboral del PDF, que le dice al contralor cuánto reembolsarle al
 * operador.
 *
 * El segundo recorría TODOS los gastos, copias incluidas. En el primer PDF real
 * (1-ago-2026) eso decía "$19,978.10 no son deducibles todavía, pero el operador
 * puso el dinero: se le reembolsan igual" cuando el total comprobado eran
 * $16,297.05. La diferencia, al centavo, eran las dos copias del mismo ticket de
 * Costco: $15,762.10 que el papel mandaba pagar tres veces.
 *
 * Se detecta primero por UUID del CFDI (regla dura) y si no hay, por
 * concepto+folio+monto. La primera aparición es el ORIGINAL y las siguientes son
 * copias suyas.
 */
export function copiasDeComprobante(gastos: Gasto[]): Map<string, string> {
  const vistoUuid = new Map<string, string>();
  const vistoFolio = new Map<string, string>();
  /** copia → el gasto original del que es copia. */
  const originalDe = new Map<string, string>();
  for (const g of gastos) {
    if (g.cfdiUuid) {
      // POR `(uuid, orden)`, NO POR EL UUID SOLO.
      //
      // La migración 0065 separó "este gasto NACIÓ de ese CFDI" (1:1, el
      // duplicado que hay que impedir) de "este gasto está AMPARADO por ese
      // CFDI" (N:1, la factura consolidada de CAPUFE), y movió el índice único
      // a `(tenant_id, cfdi_uuid, cfdi_orden)`. El dedup se quedó mirando solo
      // el uuid: las ocho casetas de una factura entraban como UNA y las otras
      // siete salían del comprobado como "duplicado". El operador cobraba $250
      // de $2,000 y el PDF lo acusaba de duplicar.
      //
      // El default `1` es lo que conserva la regla vieja intacta: dos fotos del
      // mismo comprobante no traen orden, caen ambas en 1, y siguen siendo
      // copias.
      const u = `${g.cfdiUuid.toLowerCase()}#${g.cfdiOrden ?? 1}`;
      const previo = vistoUuid.get(u);
      if (previo) originalDe.set(g.id, previo);
      else vistoUuid.set(u, g.id);
      continue;
    }
    if (g.folio) {
      // POR `folioNorm`, NO POR EL FOLIO CRUDO.
      //
      // `folioNorm` existe justo para esto —quita los ceros a la izquierda,
      // `05461` → `5461`— y el dedup lo ignoraba. Dos fotos del MISMO ticket
      // leídas una con el cero y otra sin él daban llaves distintas, así que no
      // se veían como copias y el consumo entraba DOS VECES al total.
      //
      // Encontrado el 1-ago con un fajo real de 17 comprobantes: el mismo folio
      // aparecía como `286188` y como `059286188`. Un cero de más en una lectura
      // no es un ticket distinto.
      //
      // El riesgo del otro lado —dos tickets DE VERDAD distintos cuyos folios
      // solo difieran en ceros a la izquierda, con el mismo concepto y el mismo
      // total al centavo— es justo la definición de un duplicado, no un caso
      // legítimo que se pierda.
      const llaveFolio = g.folioNorm || g.folio;
      const key = `${strip_accents(g.concepto.toLowerCase())}|${llaveFolio}|${g.monto}`;
      const previo = vistoFolio.get(key);
      if (previo) originalDe.set(g.id, previo);
      else vistoFolio.set(key, g.id);
    }
  }
  return originalDe;
}

/**
 * Qué FRACCIÓN de cada gasto es deducible, reconstruida desde las diferencias
 * que la liquidación ya guarda. Un gasto que no esté en el mapa es deducible
 * al 100% (o cayó entero en otra cubeta, que `cubetaDe` decide aparte).
 *
 * AUDITORÍA 24, FIS-2 (CRÍTICO, reincidente 23): `proporcionDeducible` vivía
 * solo DENTRO de `cuadrarViaje`; ni la RPC ni la liquidación guardada la
 * exponían, y `repartirPorCubeta` (api/export/poliza) no tenía con qué partir:
 * una comida de $2,000 con tope de $750 salía «$750 deducible» en el PDF y
 * `5020-001 cargo 1,724.14` —la base entera— en la póliza.
 *
 * Las dos reglas que parten un gasto, y de dónde sale cada una:
 *   · RFA 2.9 (`normas/rfa-2026-2.9.yaml`): `efectivo_sobre_15` guarda en
 *     `esperado`/`monto` el excedente de ESTE comprobante → `1 − exc/monto`.
 *   · LISR 28-V (`normas/lisr-28-V.yaml`): `viatico_excede_fiscal` guarda en
 *     `esperado` el tope diario; la proporción del día entre TIMBRADOS la da
 *     `diasSobreTope`, la misma función que el motor llama.
 * `proporciones_deducibles.test.ts` exige que este mapa reproduzca al centavo
 * los totales del motor: si `cuadrarViaje` cambia la regla, ese test cae.
 */
export function proporcionesDeducibles(
  gastos: Gasto[],
  diferencias: Pick<Diferencia, 'tipo' | 'gastoId' | 'esperado' | 'monto'>[],
): Map<string, number> {
  const p = new Map<string, number>();
  for (const d of diferencias) {
    if (d.tipo !== 'efectivo_sobre_15' || !d.gastoId) continue;
    const g = gastos.find((x) => x.id === d.gastoId);
    if (!g || !(g.monto > 0)) continue;
    const excedente = d.esperado ?? d.monto;
    p.set(g.id, Math.max(0, Math.min(1, (g.monto - excedente) / g.monto)));
  }
  const tope = diferencias.find((d) => d.tipo === 'viatico_excede_fiscal')?.esperado;
  if (tope != null && tope > 0) {
    for (const d of diasSobreTope(gastos, tope)) {
      if (d.proporcionTimbrado == null) continue;
      for (const x of d.delDia) if (x.cfdiUuid) p.set(x.id, d.proporcionTimbrado);
    }
  }
  return p;
}

export function cuadrarViaje(input: CuadreInput): Omit<Liquidacion, 'id' | 'creadaEn'> {
  const umbral = input.umbralConfianza ?? 0.85;
  const diferencias: Diferencia[] = [];

  // ── LFPDPPP 26-II: la oposición del titular va PRIMERO ──────────────────
  // No cambia una sola cifra: cambia quién cierra. Con la bandera, la
  // liquidación no puede quedar `cuadrada` sola — sale a revisar y una
  // persona la mira antes de que al operador se le afirme nada.
  if (input.oposicionTitular === true) {
    diferencias.push({
      tipo: 'oposicion_titular',
      monto: 0,
      nota: 'El operador ejerció su derecho de oposición a la decisión automatizada (LFPDPPP art. 26, fr. II): esta liquidación requiere revisión de una persona antes de cerrarse. Los cálculos de abajo son los del motor; la decisión final es humana.',
    });
  }

  const norm = normalizarRfc;
  // Un RFC de empresa MAL FORMADO es un dato que falta, no un dato contra el que
  // comparar. El tenant de demo traía 'TIN010101AAA' —falla el dígito
  // verificador, lo rechaza nuestro propio validador— y `getConfig` lo mete en
  // `empresa.rfc` desde la columna del tenant. Como aquí solo se descartaba el
  // genérico del SAT, ese RFC inventado SÍ se usaba: toda factura legítima cuyo
  // receptor no fuera él salía `rfc_receptor` → NO DEDUCIBLE. Enseñar un CFDI
  // real en una demostración y que el sistema lo declare no deducible es peor
  // que no validar. Se descartan igual que el genérico.
  const rfcsOk = rfcsUtilizablesDe(input.empresaRfc, input.rfcsAdicionales);
  // "No hay RFC configurado" y "hay uno y no sirve" NO son lo mismo, y tratarlos
  // igual fue una regresión mía del 28-jul: al descartar el RFC mal formado,
  // `rfcsOk` quedaba vacía, la comprobación entera se saltaba, y un CFDI de
  // $11,600 timbrado a un TERCERO salía deducible con $1,600 de IVA acreditable,
  // estatus `cuadrada` y cero diferencias. Cambié "rechaza todo" por "aprueba
  // todo", y la segunda dirección es peor: el producto AFIRMA una deducción que
  // no existe, en verde, y el único rastro es un log de servidor.
  //
  // El estado correcto es el tercero: no se puede confirmar NI descartar → a
  // revisión. Nunca deducible, nunca acreditable, y dicho en el informe.
  // EL GENÉRICO ENTRA AQUÍ, y esa es la corrección de la auditoría 6.
  //
  // La exclusión `!== RFC_GENERICO` se escribió cuando la única alternativa era
  // "rechaza todo": si el tenant no había capturado su RFC, validar el receptor
  // marcaba TODA factura como ajena. Con esa disyuntiva, no validar era lo menos
  // malo. Pero ayer se creó el tercer estado —no se puede confirmar NI
  // descartar → a revisión— y el genérico se quedó fuera por inercia.
  //
  // `XAXX010101000` es el RFC de "público en general" del SAT. Que sea el de la
  // FLOTA significa exactamente lo mismo que un RFC mal formado: hay un valor y
  // no sirve para comparar. Tratarlo distinto era aprobar por defecto, y medido
  // con el motor real un CFDI de $11,600 timbrado a un TERCERO salía
  // "Deducible para ISR $11,600.00" en verde, con $1,600 de IVA acreditable y
  // cero diferencias. El mismo daño del crítico de ayer, por la otra puerta.
  //
  // Y no es un caso raro: `DEMO_CONFIG.empresa.rfc` ES el genérico, así que ésta
  // es la ruta de CUALQUIER tenant que todavía no capturó su RFC — el estado
  // normal de un cliente el día uno, justo después de una demo.
  //
  // Sin RFC ninguno (`empresaRfc` ausente) NO entra: ahí no hay dato que
  // interpretar, y meterlo cambiaría el veredicto de todo viaje sin config,
  // incluidos los arneses de prueba. Un valor inservible y la ausencia de valor
  // no son el mismo hecho.
  const rfcEmpresaInservible = rfcsOk.size === 0 && !!input.empresaRfc;
  /** El valor existe pero es el "público en general": nunca se capturó el real. */
  const rfcEmpresaNoCapturado =
    rfcEmpresaInservible && norm(input.empresaRfc as string) === RFC_GENERICO;

  // 0) Duplicados: primero por UUID (regla dura), luego por concepto+folio+monto.
  //    Se EXCLUYEN del total (no lo inflan) — fix del audit.
  const originalDe = copiasDeComprobante(input.gastos);
  const duplicados = new Set(originalDe.keys());

  // Sólo montos > 0 suman al total: un monto negativo/cero (OCR erróneo, nota de
  // crédito) NO debe reducir el comprobado ni sesgar la diferencia. ME-5.
  const totalComprobado = input.gastos.reduce(
    (s, g) => (duplicados.has(g.id) || !(g.monto > 0) ? s : s + g.monto),
    0,
  );

  // AUDITORÍA 9, ALTO (fiscal): el permiso CRE se acumula aquí y se avisa UNA
  // vez, no una por CFDI de combustible — mismo criterio que
  // `alimentacion_sin_soporte` (abajo), después de que el mismo hallazgo
  // midió tres párrafos idénticos de 253 caracteres por tres CFDI de diésel.
  const gastosSinPermisoCre: Gasto[] = [];

  // 1) Por gasto: política, CFDI, confianza, RFC receptor, estatus SAT.
  // Contador del efectivo DENTRO de esta liquidación (RFA 2.9): se suma por
  // orden de comprobantes; el acumulado del ejercicio = previo + este viaje.
  let efectivoAcumuladoEjercicio = 0;
  // gastoId → qué fracción de él es deducible (lo llena el tope de
  // alimentación Y la frontera del 15% de la RFA 2.9; el acreditamiento y la
  // cubeta lo consumen). Un gasto que no esté aquí es deducible al 100%.
  const proporcionDeducible = new Map<string, number>();
  for (const g of input.gastos) {
    if (duplicados.has(g.id)) continue; // los duplicados se reportan aparte (paso 2)
    // Monto inválido: no se evalúa política sobre él, se manda a revisión. ME-5.
    if (!(g.monto > 0)) {
      diferencias.push({ tipo: 'monto_invalido', concepto: g.concepto, monto: 0, nota: `El comprobante de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} tiene un monto inválido (${mxn(g.monto)}) — revisar a mano.`, gastoId: g.id });
      continue;
    }
    const h = input.hidrocarburos;
    const esCombustible = g.concepto === 'diesel' || (!!h && h.claves.includes(g.claveProdServ ?? ''));

    // AUDITORÍA 23, FIS-1 (CRÍTICO). La forma de pago que se puede JUZGAR, que
    // no siempre es la del comprobante: `'99 Por definir'` no es un medio de
    // pago sino la ausencia de uno (RMF 2.7.1.29 fr. II, y `:127-128`). Con su
    // complemento de pago ingerido (FASE 7, mig. 0199), el medio real es el
    // `FormaDePagoP` del REP; sin él, todavía no hay nada que juzgar.
    // `undefined` = «no opino», que es el mismo criterio con el que esta
    // función trata una `formaPago` ausente: desconocido no es «medio
    // distinto», y suponerlo inflaría el no-deducible contra la flota.
    //
    // Es la misma idea que `formaPagoEfectiva` (`:1397`) ya aplica al IVA, al
    // peaje electrónico y al IEPS del diésel; se calcula aquí porque aquella
    // vive en otro recorrido, 800 líneas más abajo.
    const formaPagoJuzgable = g.formaPago === FORMA_PAGO_SIN_PAGAR
      ? (g.pagadoEn ? g.pagadoForma : undefined)
      : g.formaPago;

    // FASE 2 · RMF 3.3.1.7 — ticket de monedero no es factura de estación.
    // Solo con evidencia (padrón o línea ECC día/estación/monto). Sin
    // evidencia no se afirma: un diésel de PEMEX en efectivo sigue siendo
    // un ticket que SÍ puede facturarse. Sin UUID: si ya está ligado al
    // CFDI del emisor, el comprobante deducible ya llegó.
    if (esCombustible && !g.cfdiUuid) {
      const senal = evidenciaMonedero(g, input.lineasEcc);
      if (senal.tipo !== 'ninguna') {
        diferencias.push({
          tipo: 'ticket_monedero', concepto: g.concepto, monto: g.monto,
          nota: notaTicketMonedero(senal), gastoId: g.id,
        });
      }
    }

    // ── REGLA 5 · RFA 2026 regla 2.9 — el 15% de combustible en EFECTIVO ─────
    //
    // El combustible exige pago electrónico (LISR 27-III 2º párrafo) salvo que
    // la flota califique a la facilidad: dedicación EXCLUSIVA al autotransporte
    // terrestre de carga federal Y régimen (Título II Cap. VII o Título IV Cap.
    // II Secc. I), y que el efectivo no exceda el 15% del total pagado por
    // combustible en el ejercicio. El DOF exige además que el CFDI consigne el
    // permiso CRE vigente del proveedor (lo cubre la regla del complemento, B1).
    //
    // Matriz (el deber ser completo, docs/fiscal/rfa-2.9):
    //   elegible + dentro del 15% → deducible (diferencia informativa con el
    //                               contador del ejercicio a la vista)
    //   elegible + excede el 15%  → el EXCEDENTE no deducible
    //   no elegible               → no deducible (27-III sin excepción)
    //   sin declarar              → por confirmar (no se afirma nada)
    //
    // En ningún caso acredita IEPS (la facilidad salva UN beneficio, no dos).
    const topeEfectivo = input.estimulos?.efectivoTopeMxn ?? TOPE_EFECTIVO_LISR_27_III;
    // ── AUDITORÍA 24, FIS-5 (ALTO): LAS TRES RAMAS JUZGAN LA MISMA FORMA ──
    // FIS-1 construyó `formaPagoJuzgable` y lo cableó a UNA de las tres
    // ramas que juzgan el medio. Ésta (el cubo del 15%) y la del tope de
    // $2,000 seguían preguntando por `g.formaPago`, que en un CFDI PPD es
    // siempre `'99'`: un REP con `FormaDePagoP = '01'` —la prueba documental
    // de que se pagó en EFECTIVO— abría el IVA (`pagadoConRep`, abajo) y no
    // cerraba la deducción. Hospedaje de $58,000 a crédito pagado en caja
    // salía «Deducible para ISR $58,000» con «IVA acreditable $8,000», el caso
    // exacto del 27-III presentado como cumplido.
    if (medioNoAdmitidoCombustible(formaPagoJuzgable) && esCombustible) {
      const etiqueta = etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined);
      // El rótulo tiene que ser verdad: «EFECTIVO» solo cuando lo fue — y si
      // lo dijo el REP, se dice que lo dijo el REP.
      const medio = comoSePago(formaPagoJuzgable, g.formaPago === FORMA_PAGO_SIN_PAGAR ? g.pagadoEn : undefined);
      const elegible = input.facilidad15;
      if (elegible === true) {
        // AUDITORÍA 15, ALTO: fail-closed REAL — si el contador del ejercicio no
        // trajo datos (total <= 0: bache de red, best-effort en desde_db) o el
        // comprobante es de OTRO ejercicio (viaje de enero con gasto de dic),
        // NO se puede afirmar "el excedente NO se deduce contra un tope de $0
        // que no se midió". Ese gasto va a revisión con nota honesta; la
        // facilidad solo aplica con la base medida.
        const anioComprobante = g.fecha ? g.fecha.slice(0, 4) : null;
        const mismoEjercicio = !anioComprobante || anioComprobante === input.anioEjercicio;
        const total = input.totalCombustibleEjercicio ?? 0;
        if (!mismoEjercicio || !(total > 0)) {
          const motivo = !(total > 0)
            ? 'no se pudo calcular el total de combustible del ejercicio (el contador no respondió) — la facilidad del 15% (RFA 2026 regla 2.9) no se evaluó'
            : `este comprobante es de ${anioComprobante} y la facilidad se mide contra el ejercicio ${input.anioEjercicio} — se revisa aparte`;
          diferencias.push({
            tipo: 'combustible_efectivo', concepto: g.concepto, monto: 0,
            nota: `${etiqueta} ${medio} — ${motivo}. No se afirma deducible ni no deducible; no acredita IEPS.`,
            gastoId: g.id,
          });
          continue;
        }
        // Contador del ejercicio: previo (otras liquidaciones) + este viaje.
        // AUDITORÍA 14, MEDIO: el EXCEDENTE se reporta POR COMPROBANTE, no
        // acumulativo — antes, cada gasto posterior al cruce colgaba TODO el
        // excedente acumulado (`excedente = acumulado - tope`), la suma de la
        // columna no cuadraba con totalNoDeducible, y un ticket de $1,000
        // imprimía "el excedente de $1,500 NO se deduce". Misma disciplina que
        // viatico_excede_fiscal: el monto de la diferencia es SOLO lo que de
        // verdad resta de totalDeducible, y la frontera se cruza UNA vez.
        const previoSinEste = (input.efectivoPrevEjercicio ?? 0) + efectivoAcumuladoEjercicio;
        efectivoAcumuladoEjercicio += g.monto;
        const acumulado = (input.efectivoPrevEjercicio ?? 0) + efectivoAcumuladoEjercicio;
        const tope = 0.15 * total;
        // Lo que queda del tope para ESTE comprobante (previo sin este ya
        // consumió lo suyo); si ya se cruzó, queda 0.
        const cupoRestante = Math.max(0, tope - previoSinEste);
        const dentro = Math.min(g.monto, cupoRestante);
        const excedenteDeEste = Math.max(0, g.monto - dentro);
        if (g.monto > 0) proporcionDeducible.set(g.id, dentro / g.monto);
        if (excedenteDeEste === 0) {
          const pct = total > 0 ? Math.round((acumulado / total) * 100) : 0;
          diferencias.push({
            tipo: 'combustible_efectivo_dentro15', concepto: g.concepto, monto: 0,
            // FISCAL-19C2-4: `esperado` es lo que `derivoLaConfig` (analytics.ts)
            // compara contra el `acumulado` recalculado del panel para detectar
            // deriva — sin él, si `totalCombustibleEjercicio` cambia después de
            // archivar esta liquidación, el TIPO sigue igual en ambos lados y la
            // deriva pasa desapercibida.
            nota: `${etiqueta} ${medio} — deducible por la facilidad del 15% (RFA 2026 regla 2.9): el ejercicio lleva ${mxn(acumulado)} de ${mxn(total)} de combustible pagado con medios que la LISR 27-III no admite (${pct}% del total, tope 15%). No acredita IEPS.`,
            gastoId: g.id,
            esperado: acumulado,
          });
        } else {
          diferencias.push({
            tipo: 'efectivo_sobre_15', concepto: g.concepto, monto: excedenteDeEste,
            nota: `${etiqueta} ${medio} — el ejercicio lleva ${mxn(acumulado)} de combustible pagado con medios que la LISR 27-III no admite, contra un tope de ${mxn(tope)} (15% de ${mxn(total)}); el excedente de ${mxn(excedenteDeEste)} de ESTE comprobante NO se deduce (RFA 2026 regla 2.9). No acredita IEPS. ${LECTURA_RFA_29_PRORRATEO}`,
            gastoId: g.id,
            esperado: excedenteDeEste,
          });
        }
      } else if (elegible === false) {
        diferencias.push({
          tipo: 'efectivo_no_elegible', concepto: g.concepto, monto: g.monto,
          nota: `${etiqueta} ${medio} — la flota declaró que NO califica a la facilidad del 15% (dedicación exclusiva o régimen), así que el combustible exige uno de los medios de la LISR 27-III (cheque nominativo, tarjeta de crédito/débito/servicios o monedero autorizado) — no deducible.`,
          gastoId: g.id,
        });
      } else {
        diferencias.push({
          tipo: 'combustible_efectivo', concepto: g.concepto, monto: 0,
          nota: `${etiqueta} ${medio} — la facilidad del 15% (RFA 2026 regla 2.9) exige que la flota declare su dedicación y régimen al registrarla; sin esa declaración esto se revisa. No acredita IEPS.`,
          gastoId: g.id,
        });
      }
    } else if (formaPagoJuzgable === '01' && !esCombustible && g.monto > topeEfectivo) {
      // Regla 6: gasto no-combustible en efectivo > tope → no deducible.
      // FIS-5: `formaPagoJuzgable`, no `g.formaPago` — ver arriba.
      const segunRep = g.formaPago === FORMA_PAGO_SIN_PAGAR && g.pagadoEn ? ` (según su complemento de pago del ${g.pagadoEn})` : '';
      diferencias.push({ tipo: 'efectivo_sobre_tope', concepto: g.concepto, monto: 0, nota: `${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} de ${mxn(g.monto)} en efectivo${segunRep} excede el tope de ${mxn(topeEfectivo)} (LISR 27-III) — no deducible.`, gastoId: g.id });
    } else if (
      // ── AUDITORÍA 22, FIS-C3 (CRÍTICO) ──────────────────────────────────
      // La lista del primer párrafo de la fracción es CERRADA, igual que la del
      // segundo. El motor ya la tenía escrita (`MEDIOS_LISR_27_III`) pero la
      // usaba SOLO para combustible: para todo lo demás la frontera era «¿es
      // '01'?», y `'06' Dinero electrónico`, `'08' Vales`, `'12' Dación en
      // pago`, `'17' Compensación`, `'23' Novación` y `'99 Por definir` salían
      // «Deducible para ISR» en verde, con su IVA acreditado y CERO diferencias.
      // Es el mismo defecto que la 18 arregló para el diésel y que aquí se
      // quedó sin generalizar.
      //
      // Va a POR_CONFIRMAR y no a NO_DEDUCIBLE_ISR a propósito: '06' y '08'
      // claramente no están en la lista, pero '12', '17' y '23' EXTINGUEN la
      // obligación y hay criterio en disputa sobre si les aplica el requisito
      // de "pago". La ficha advierte contra citar la fracción sola para negar
      // una deducción, así que se pone la cifra a la vista y la confirma una
      // persona — sin acreditar IVA mientras tanto (LIVA 5-I).
      //
      // Sin `formaPago` NO entra: desconocido no es «medio distinto», el mismo
      // criterio que sostiene `medioNoAdmitidoCombustible`.
      //
      // ── AUDITORÍA 23, FIS-1 (CRÍTICO): SE JUZGA LA FORMA EFECTIVA ────────
      // La primera versión de esta rama juzgaba `g.formaPago` crudo, y con eso
      // metió `'99 Por definir'` en el mismo saco que `'06' Dinero
      // electrónico`. No es lo mismo, y este archivo lo tiene escrito dos
      // veces: `:127-128` («'99' = la contraprestación no se ha pagado, RMF
      // 2.7.1.29 fr. II») y `:148-152` («'99' devuelve false. No es un medio
      // distinto: es que NO se pagó. Ese caso lo juzga la regla de pago
      // efectivo, no esta»). `medioNoAdmitidoCombustible:156` respeta esa
      // frontera; esta rama no la había replicado.
      //
      // Costaba: `MetodoPago 'PPD'` / `FormaPago '99'` es la forma NORMAL de
      // una compra a crédito en México. Todo comprobante a crédito de más de
      // $2,000 salía del deducible, perdía su IVA, bajaba la liquidación a
      // `revisar` y se imprimía «se pagó con la forma «99»» — falso dos veces:
      // no se pagó, y cuando el REP existe dice que se pagó por transferencia,
      // que SÍ está en la lista. Y mataba la FASE 7 (mig. 0199) entera, que
      // ingiere el complemento de pago justamente para recuperar ese IVA.
      //
      // No basta con excluir el '99': eso dejaría pasar un CFDI a crédito cuyo
      // REP dice haberse pagado con '06', que es el hueco que esta rama vino a
      // cerrar. Se juzga la forma EFECTIVA — la misma idea que
      // `formaPagoEfectiva` (`:1397`) ya aplica al IVA, al peaje electrónico y
      // al IEPS del diésel. Sin REP no se opina; con REP se juzga
      // `pagadoForma`; con REP sin `FormaDePagoP` legible tampoco se opina,
      // porque desconocido no es «medio distinto» (mismo criterio de `:1394`).
      formaPagoJuzgable !== undefined && formaPagoJuzgable !== '01' && !esCombustible &&
      g.monto > topeEfectivo && !(MEDIOS_LISR_27_III as readonly string[]).includes(formaPagoJuzgable)
    ) {
      diferencias.push({
        tipo: 'medio_pago_no_admitido', concepto: g.concepto, monto: 0,
        nota: `${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} de ${mxn(g.monto)} se pagó con la forma «${formaPagoJuzgable}», que no está en la lista de la LISR 27-III (transferencia, cheque nominativo, tarjeta de crédito/débito/servicios o monedero autorizado) y excede el tope de ${mxn(topeEfectivo)}. No se afirma deducible ni perdido: lo confirma tu contador. Mientras tanto no acredita IVA.`,
        gastoId: g.id,
      });
    }

    // B5: el intake ya detectó que el total del CÓDIGO y el del OCR no coinciden
    // y lo dejó en ocrExtra — pero nadie lo miraba, así que se quedaba en la base
    // sin llegar nunca a la bandeja. Que no cuadren significa que algo se leyó
    // mal (otra foto, una propina, un renglón perdido) y eso lo ve una persona.
    const extraOcr = g.ocrExtra as Record<string, unknown> | undefined;
    if (extraOcr?.montoDiscrepante) {
      const leido = extraOcr.montoOcr;
      diferencias.push({ tipo: 'monto_discrepante', concepto: g.concepto, monto: 0, nota: `El total del comprobante de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} no coincide entre el código (${mxn(g.monto)}) y lo leído por visión${typeof leido === 'number' ? ` (${mxn(leido)})` : ''} — se tomó el del código, pero conviene verificarlo.`, gastoId: g.id });
    }

    // El comprobante traía texto hablándole al extractor ("ignora las reglas",
    // "el total real es X"). El monto que entró es el IMPRESO —el modelo no
    // obedece— pero alguien puso ahí ese texto a propósito, y quien decide sobre
    // ese gasto merece saberlo. Va SOLO al contralor: avisarle al operador, que
    // es quien pudo haberlo intentado, únicamente le enseña a hacerlo mejor.
    // EL PAPEL DICE DE SÍ MISMO QUE NO LO ES. Un ticket de restaurante puede
    // traer RFC, subtotal e IVA y aun así llevar impreso "ESTE NO ES UN
    // COMPROBANTE FISCAL": por el art. 29-A no ampara la deducción de nadie.
    //
    // El gasto NO se excluye del comprobado —es dinero que el operador puso y se
    // le tiene que reponer— y por eso `monto: 0`: la diferencia informa, no
    // castiga al chofer por lo que le dio el negocio. Lo que hay que hacer es
    // pedir la factura, y eso es trabajo de la oficina.
    if (extraOcr?.noEsComprobanteFiscal) {
      diferencias.push({ tipo: 'comprobante_no_fiscal', concepto: g.concepto, monto: 0, nota: `El comprobante de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} de ${mxn(g.monto)} lleva impreso que NO es un comprobante fiscal: no ampara deducción (CFF 29-A). El gasto se le repone al operador, pero hay que pedirle la factura al establecimiento.`, gastoId: g.id });
    }
    // ── DAT-18 · UN COMPROBANTE FUERA DE ESCALA ──────────────────────────
    //
    // El intake lo marcó (y le pidió confirmación al chofer si estaba en la
    // ventana). Aquí llega el caso en que el chofer no contestó, o contestó que
    // sí: la cifra sigue sin poder darse por buena sola, y el contralor es
    // quien tiene el papel enfrente. `monto: 0` porque esto NO castiga —el
    // dinero puede ser real— sino que pide que alguien lo mire.
    if (extraOcr?.montoImplausible) {
      diferencias.push({ tipo: 'monto_implausible', concepto: g.concepto, monto: 0, nota: `El comprobante de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} de ${mxn(g.monto)} está fuera de escala para este viaje. Un punto decimal o un separador de miles mal leídos multiplican por mil con la misma confianza de OCR: verifica el papel antes de liquidarlo.`, gastoId: g.id });
    }

    // ── DAT-19 · EL COMPROBANTE NO ESTÁ EN PESOS ─────────────────────────
    //
    // Ni el OCR ni el parser del XML leían `Moneda`/`TipoCambio`, así que un
    // CFDI de USD entraba con su `Total` tal cual en la columna de pesos: un
    // diésel de USD 450 se comprobaba como $450.00 MXN contra el anticipo — y
    // su IVA se acreditaba en la misma cifra equivocada.
    //
    // NO se convierte aquí. El motor no inventa cifras, y aplicar un tipo de
    // cambio produciría un número que ni el contralor ni el SAT podrían
    // reproducir sin saber qué fecha se usó. Se declara y se manda a revisar; y
    // sobre todo NO se acredita como pesos (ver SIN_IVA_ACREDITABLE).
    const monedaGasto = typeof extraOcr?.moneda === 'string' ? extraOcr.moneda : undefined;
    if (monedaGasto && monedaGasto !== 'MXN') {
      const tc = typeof extraOcr?.tipoCambio === 'number' ? extraOcr.tipoCambio : undefined;
      diferencias.push({ tipo: 'moneda_extranjera', concepto: g.concepto, monto: 0, nota: `El comprobante de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} viene en ${monedaGasto}${tc ? ` (tipo de cambio ${tc} declarado en el comprobante)` : ' y sin tipo de cambio declarado'}, no en pesos. La cifra ${mxn(g.monto)} NO está convertida: conviértela a mano con el tipo de cambio del día antes de liquidar. Su IVA no se acredita hasta entonces.`, gastoId: g.id });
    }

    // ── LA CANASTA MIXTA: RENGLONES QUE NO SON DEL VIAJE ───────────────────
    //
    // Un ticket de autoservicio no es UN gasto, es una lista. Auditoría del
    // 24-ago-2026 sobre cinco tickets reales: un Walmart de $640.49 traía $299
    // de manguera de jardinería y $258 de dos tapetes —$557 de $640 que no son
    // gasto de un viaje de carga— y entró completo, en silencio. Otro de
    // $261.62 traía $140 de desodorante y crema. El motor marcó la comida de
    // un restaurante por exceder el tope de política y no dijo una palabra de
    // la manguera.
    //
    // ESTO NO DESCUENTA NADA. `monto: 0`, igual que el resto de las
    // observaciones de este bloque: `ajenoAlViaje` es un JUICIO de un modelo
    // de visión sobre qué es plausible en una ruta, no una medición. Un juicio
    // puede señalar; solo una persona puede rechazar un gasto. Lo que sí hace
    // es poner la cifra y los nombres de las partidas a la vista del
    // contralor, que es lo único que le permite decidir en diez segundos.
    const renglones = (g.ocrExtra as Record<string, unknown> | undefined)?.renglones;
    if (Array.isArray(renglones)) {
      const ajenos = renglones.filter((r): r is { descripcion: string; importe: number; ajenoAlViaje: boolean } =>
        Boolean(r) && typeof r === 'object'
        && (r as { ajenoAlViaje?: unknown }).ajenoAlViaje === true
        && typeof (r as { importe?: unknown }).importe === 'number'
        && Number.isFinite((r as { importe: number }).importe));
      const sumaAjena = ajenos.reduce((t, r) => t + r.importe, 0);
      // Un solo renglón de a peso no vale una observación: el ruido le quita
      // autoridad a la señal. El umbral es relativo al propio ticket —lo que
      // importa es qué PARTE del gasto no es del viaje, no el monto absoluto.
      if (ajenos.length > 0 && sumaAjena > 0 && g.monto > 0 && sumaAjena / g.monto >= UMBRAL_RENGLONES_AJENOS) {
        const lista = ajenos.slice(0, 4).map((r) => `${r.descripcion} ${mxn(r.importe)}`).join(', ');
        const mas = ajenos.length > 4 ? ` y ${ajenos.length - 4} más` : '';
        diferencias.push({
          tipo: 'renglones_ajenos', concepto: g.concepto, monto: 0,
          nota: `El comprobante de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} de ${mxn(g.monto)} incluye ${mxn(sumaAjena)} en partidas que no parecen gasto de viaje: ${lista}${mas}. El ticket entró completo — decide si se le repone todo al operador y qué parte es deducible.`,
          gastoId: g.id,
        });
      }
    }

    if (extraOcr?.textoSospechoso) {
      diferencias.push({ tipo: 'texto_sospechoso', concepto: g.concepto, monto: 0, nota: `El comprobante de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} de ${mxn(g.monto)} traía texto dirigido al lector automático. Se capturó el total impreso, pero conviene ver el papel original.`, gastoId: g.id });
    }

    // (El tope fiscal de alimentación se evalúa POR DÍA, después del bucle.)

    // #1: cordura de la FECHA. Una fecha futura o muy anterior al viaje mete el
    // gasto en el periodo fiscal equivocado, rompe el plazo de facturación y
    // puede cruzar la frontera del complemento (24-abr-2026). Fuera de rango → bandeja.
    if (g.fecha) {
      const f = g.fecha.slice(0, 10);
      // La REGLA vive en `fecha_dudosa.ts`, no aquí: el intake tiene que
      // contestar exactamente lo mismo para pedirle otra foto al operador, y dos
      // copias de esta condición se separan en silencio.
      const motivo = fechaDudosa(f, { fechaMin: input.fechaMin, fechaMax: input.fechaMax, hoy: input.hoy });
      if (motivo === 'otro_ejercicio') {
        const ejercicioHoy = input.hoy ? Number(input.hoy.slice(0, 4)) : null;
        // FISCAL (rescatado de rutina-fiscal-wip, 26-ago-2026): iba con el
        // mismo `tipo` que el gasto simplemente "fuera de rango" de abajo —
        // ninguno de los dos buckets de deducibilidad lo excluía, así que
        // `totalDeducible` lo sumaba de todas formas mientras la nota decía
        // "no se deduce en este [ejercicio]". La frase y el dinero no
        // coincidían. Tipo propio, en NO_DEDUCIBLE_ISR.
        diferencias.push({ tipo: 'gasto_otro_ejercicio', concepto: g.concepto, monto: 0, nota: `El comprobante de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} está fechado en ${Number(f.slice(0, 4))} y estamos en ${ejercicioHoy}: un gasto de otro ejercicio no se deduce en este. Puede ser un error de lectura — verifica la fecha impresa.`, gastoId: g.id });
      } else if (motivo === 'fuera_de_rango') {
        diferencias.push({ tipo: 'fecha_sospechosa', concepto: g.concepto, monto: 0, nota: `La fecha del comprobante de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} (${f}) está fuera del rango esperado del viaje — verifícala (afecta periodo fiscal y plazo de facturación).`, gastoId: g.id });
      }
    }

    // #3: folio leído con BAJA CONFIANZA en un ticket de combustible (que se
    // factura en portal) → avisar que lo verifique. NO bloquea, solo advierte.
    if (g.folio && g.concepto === 'diesel' && g.ocrConfianza != null && g.ocrConfianza < umbral) {
      diferencias.push({ tipo: 'folio_verificar', concepto: g.concepto, monto: 0, nota: `El folio del ticket de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} (${sanitizarFolio(g.folio)}) se leyó con baja confianza — verifícalo antes de facturarlo en el portal de la gasolinera.`, gastoId: g.id });
    }

    const pol = politicaPara(g.concepto, input.ruta, input.politica);
    if (pol?.topeMonto != null && g.monto > pol.topeMonto) {
      diferencias.push({
        tipo: 'sobre_politica', concepto: g.concepto, esperado: pol.topeMonto, real: g.monto,
        monto: g.monto - pol.topeMonto,
        nota: `${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} de ${mxn(g.monto)} excede el tope de política (${mxn(pol.topeMonto)}) por ${mxn(g.monto - pol.topeMonto)}.`,
        gastoId: g.id,
      });
    }
    if (pol?.requiereCfdi && !g.cfdiUuid) {
      diferencias.push({ tipo: 'sin_cfdi', concepto: g.concepto, monto: 0, nota: `${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} de ${mxn(g.monto)} requiere factura CFDI y no trae UUID válido.`, gastoId: g.id });
    }
    if (g.ocrConfianza != null && g.ocrConfianza < umbral) {
      diferencias.push({ tipo: 'ocr_baja_confianza', concepto: g.concepto, monto: 0, nota: `El comprobante de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} se leyó con baja confianza — conviene revisarlo a mano.`, gastoId: g.id });
    }
    if (rfcEmpresaInservible && g.rfcReceptor) {
      // El texto distingue los dos motivos porque la acción es distinta: uno se
      // corrige, el otro se captura. Decirle "está mal capturado" a quien nunca
      // lo capturó lo manda a buscar un error que no existe.
      const porQue = rfcEmpresaNoCapturado
        ? 'la flota todavía no tiene su RFC capturado'
        : 'el RFC de la flota está mal capturado';
      const queHacer = rfcEmpresaNoCapturado
        ? 'Captura el RFC de la empresa y vuelve a cuadrar.'
        : 'Corrige el RFC de la empresa y vuelve a cuadrar.';
      diferencias.push({
        tipo: 'rfc_receptor_no_verificable', concepto: g.concepto, monto: 0,
        nota: `No se puede verificar a nombre de quién está la factura de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)}: ${porQue}. Queda a revisión — ${queHacer}`,
        gastoId: g.id,
      });
    }
    // AUDITORÍA 8, CRÍTICO: AL-6 por la puerta que quedó abierta. Las dos
    // validaciones de arriba y de abajo exigen `g.rfcReceptor` truthy — pero el
    // esquema de visión NO tiene campo de receptor (el prompt del OCR pide
    // expresamente el RFC del EMISOR, "no el del cliente"), así que un CFDI
    // leído del QR de un ticket impreso, o un XML cuyo Receptor@Rfc no se
    // parseó, llega aquí con `rfcReceptor` vacío. Sin este tercer camino, "no sé
    // a nombre de quién está" caía en 'deducible' — el mismo daño de AL-6, por
    // otra puerta. Solo aplica con CFDI presente: sin él, `cubetaDe` ya manda a
    // 'por_confirmar' por falta de comprobante, y esta nota confundiría la
    // causa.
    if (g.cfdiUuid && !g.rfcReceptor) {
      diferencias.push({
        tipo: 'rfc_receptor_no_verificable', concepto: g.concepto, monto: 0,
        nota: `No se puede verificar a nombre de quién está la factura de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)}: el receptor no se pudo leer del comprobante. Queda a revisión — reenvía el XML o una foto más clara del QR.`,
        gastoId: g.id,
      });
    }
    if (rfcsOk.size > 0 && g.rfcReceptor && !rfcsOk.has(norm(g.rfcReceptor))) {
      // RLISR 57: "Si benefician a personas que le prestan servicios personales
      // subordinados, los comprobantes fiscales PODRÁN ser expedidos a nombre de
      // dichas personas". El operador de una flota es trabajador subordinado, así
      // que su viático a su propio nombre es VÁLIDO. Rechazarlo le tira al cliente
      // una deducción que el reglamento le concede.
      //
      // No aplica al diésel ni a las facturas: eso sí va a nombre de la empresa.
      const esViatico = ES_VIATICO.includes(g.concepto);
      const rfcOperador = input.operadorRfc ? norm(input.operadorRfc) : null;
      if (esViatico && rfcOperador && norm(g.rfcReceptor) === rfcOperador) {
        // Es del operador: correcto por RLISR 57, no se reporta nada.
      } else if (esViatico && !rfcOperador) {
        // Sin el RFC del operador no se puede confirmar NI descartar. Se revisa,
        // pero no se le quita la deducción por una duda nuestra.
        diferencias.push({ tipo: 'viatico_rfc_operador', concepto: g.concepto, monto: 0, nota: `Viático de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} timbrado al RFC ${g.rfcReceptor}. Si es el del operador es válido (RLISR 57, trabajador subordinado) — captura su RFC para confirmarlo.`, gastoId: g.id });
      } else {
        diferencias.push({ tipo: 'rfc_receptor', concepto: g.concepto, monto: 0, nota: `Factura de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} timbrada al RFC ${g.rfcReceptor} (no es de la empresa) — no deducible.`, gastoId: g.id });
      }
    }
    if (g.estadoSat === 'cancelado') {
      diferencias.push({ tipo: 'cfdi_cancelado', concepto: g.concepto, monto: 0, nota: `El CFDI de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} está CANCELADO ante el SAT — no deducible.`, gastoId: g.id });
    } else if (g.estadoSat === 'no_encontrado' && g.cfdiUuid) {
      diferencias.push({ tipo: 'cfdi_no_encontrado', concepto: g.concepto, monto: 0, nota: `El SAT NO reconoce el CFDI de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} (UUID inexistente o fabricado) — no deducible.`, gastoId: g.id });
    } else if (g.efos === true) {
      diferencias.push({ tipo: 'cfdi_efos', concepto: g.concepto, monto: 0, nota: `El emisor del CFDI de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} está en lista negra del SAT (EFOS) — no deducible.`, gastoId: g.id });
    } else if (g.efosRevisar) {
      diferencias.push({ tipo: 'cfdi_efos_indeterminado', concepto: g.concepto, monto: 0, nota: `La validación EFOS del CFDI de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} no fue concluyente — el gasto queda POR CONFIRMAR (ni deducible ni acreditable) hasta cotejar el listado del art. 69-B a mano.`, gastoId: g.id });
    } else if (g.estadoSat === 'pendiente' && g.cfdiUuid) {
      diferencias.push({ tipo: 'cfdi_pendiente', concepto: g.concepto, monto: 0, nota: `No se pudo validar el CFDI de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} con el SAT — se revisa después.`, gastoId: g.id });
    }

    // Complemento de hidrocarburos (Bloque 1). Regla determinística en DOS
    // NIVELES. Mismo criterio que EFOS: NUNCA se declara no deducible sin
    // verificar — un falso positivo de fraude es peor que un falso negativo.
    // (h y esCombustible se hoistearon arriba del loop.)
    if (h && esCombustible) {
      // DOS FECHAS DISTINTAS, Y SOLO UNA PUEDE DECIDIR DINERO.
      //
      // `h.vigenteDesde` sale de `config.ts` ('2026-04-24') y su comentario la
      // funda en la RMF 2.7.1.8 — una cita que NO tiene ficha. Con ella el motor
      // declaraba no deducible: el MISMO CFDI de diésel de $5,800 movido un día
      // pasaba de "$5,800 deducibles, $689.66 de IVA acreditable, 200 L
      // elegibles" a "$0, $0, 0 L", y el papel afirmaba "obligatorio desde
      // 24-abr-2026" sobre una regla redactada en FUTURO ("el complemento que al
      // efecto publique el SAT en su Portal"), cuya propia ficha dice que la
      // obligación puede estar latente y que esa fecha no está respaldada.
      //
      // Ahora `vigenteDesde` es solo el filtro de ruido —desde cuándo vale la
      // pena mirar el complemento— y la que decide dinero es la de la FICHA. Con
      // `null` el motor avisa y manda a revisión; nunca declara no deducible.
      const miraElComplemento = !g.fecha || g.fecha >= h.vigenteDesde;
      const exigibleDesde = h.exigibleDesde !== undefined
        ? h.exigibleDesde
        : (NORMAS['rmf-2026-2.7.1.48']?.exigibleDesde ?? null);
      const exigible = exigibleDesde != null && (!g.fecha || g.fecha.slice(0, 10) >= exigibleDesde);
      if (g.xmlVerificado) {
        // NIVEL 2: tenemos el XML → se puede AFIRMAR que el complemento falta
        // (regla 2.7.1.48 RMF 2026). La regla obliga solo el ClaveProdServ de
        // combustible en CFDI tipo I/E de un permisionario; la unidad LTR es
        // consistencia esperada, NO requisito de la regla (por eso NO se exige
        // aquí — evita falsos negativos). Se EXCLUYEN los esquemas alternos
        // (monedero ECC / Carta Porte), que no caen en 2.7.1.48.
        const combustibleFiscal = h.claves.includes(g.claveProdServ ?? '');
        const tipoAplica = g.tipoComprobante === 'I' || g.tipoComprobante === 'E';

        // PERMISO CRE (LISR 27-III 2º párrafo / RFA 2026 regla 2.9): el CFDI de
        // combustible debe consignar el permiso vigente del proveedor. El
        // sistema no lo extrae del XML —el atributo exacto dentro del
        // complemento de hidrocarburos no está confirmado contra el esquema
        // oficial del SAT, y afirmar mal ahí es peor que no afirmar nada— así
        // que NUNCA se declara cumplido ni incumplido. No toca la cubeta ni el
        // acreditamiento, mismo criterio que EFOS y el complemento de arriba
        // (nunca declarar sin verificar). Independiente de si el complemento
        // de hidrocarburos está presente: son dos requisitos distintos de la
        // misma compra.
        //
        // AUDITORÍA 9, ALTO: se acumula aquí y se avisa UNA vez al cerrar el
        // loop, no por CFDI — ver `gastosSinPermisoCre` arriba.
        if (combustibleFiscal && tipoAplica) {
          gastosSinPermisoCre.push(g);
        }

        if (combustibleFiscal && tipoAplica && miraElComplemento && !g.cfdiEsquemaAlterno && !g.complementoHidrocarburos) {
          if (exigible) {
            // Solo con una fecha de exigibilidad RESPALDADA se tira la deducción.
            diferencias.push({ tipo: 'complemento_hidrocarburos', concepto: g.concepto, monto: 0, nota: `El CFDI de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} es de combustible y NO trae el complemento de hidrocarburos requerido (obligatorio desde ${exigibleDesde}, regla 2.7.1.48 RMF) — no deducible (CFF 29-A).`, gastoId: g.id });
          } else {
            // El hecho es verificable (el XML no trae el nodo); lo que NO es
            // verificable es que ya se exija. Se reusa `complemento_no_verificable`
            // porque es el tipo que significa "no se puede concluir": queda en
            // REVISAR, fuera de NO_DEDUCIBLE_ISR y fuera de SIN_IVA_ACREDITABLE,
            // que es exactamente el veredicto que el motor puede sostener.
            diferencias.push({ tipo: 'complemento_no_verificable', concepto: g.concepto, monto: 0, nota: `El CFDI de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} es de combustible y no trae el complemento de hidrocarburos de la regla 2.7.1.48 RMF. Pídele a la gasolinera la factura con el complemento. NO se declara no deducible: la fecha desde la que el SAT lo hace exigible no está confirmada — confírmalo con tu contador.`, gastoId: g.id });
          }
        }
      } else if (g.cfdiUuid && miraElComplemento) {
        // NIVEL 1: es una FACTURA de combustible (tiene UUID) pero sin el XML →
        // no se puede verificar el complemento. A la bandeja del liquidador, NO
        // se declara no deducible. Se resuelve cuando reenvíen el XML.
        diferencias.push({ tipo: 'complemento_no_verificable', concepto: g.concepto, monto: 0, nota: `La factura de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} es de combustible: reenvía el XML (el que te manda la gasolinera por correo) para verificar el complemento de hidrocarburos.`, gastoId: g.id });
      }
    }
  }

  // El permiso CRE, UNA sola vez, no una por CFDI de combustible (arriba).
  if (gastosSinPermisoCre.length) {
    const total = gastosSinPermisoCre.reduce((s, g) => s + g.monto, 0);
    const sujeto = gastosSinPermisoCre.length === 1
      ? `El CFDI de ${etiquetaConcepto(gastosSinPermisoCre[0].concepto, gastosSinPermisoCre[0].ocrExtra as Record<string, unknown> | undefined)}`
      : `${gastosSinPermisoCre.length} CFDI de combustible (${mxn(total)})`;
    diferencias.push({
      tipo: 'permiso_cre_no_verificable', concepto: 'diesel', monto: 0,
      nota: `${sujeto} de combustible: LISR 27-III y RFA 2026 regla 2.9 exigen que conste el permiso CRE vigente del proveedor. El sistema todavía no lo valida — confírmalo con tu contador contra el CFDI.`,
      gastoId: gastosSinPermisoCre.length === 1 ? gastosSinPermisoCre[0].id : undefined,
    });
  }

  // 2) Duplicados como diferencia (ya excluidos del total).
  //
  // UNA LÍNEA POR COMPROBANTE REPETIDO, NO UNA POR COPIA. El 1-ago, en el primer
  // ensayo con tickets reales, el mismo Costco entró TRES veces y el cierre le
  // enseñó al operador dos líneas idénticas, palabra por palabra:
  //
  //     • Comprobante duplicado: Alimentación folio 3522 por $7,881.05 aparece
  //       dos veces (excluido del total).
  //     • Comprobante duplicado: Alimentación folio 3522 por $7,881.05 aparece
  //       dos veces (excluido del total).
  //
  // El motor tenía razón —había dos copias sobrantes— pero repetir el mismo
  // texto se lee como un sistema roto justo delante de quien decide la compra. Y
  // "aparece dos veces" era falso: aparecía tres.
  //
  // Se agrupa por el gasto ORIGINAL (el que sí cuenta), y el `gastoId` que se
  // reporta es el del original: es el que el contralor tiene que abrir para
  // decidir cuál se queda. Las copias no le sirven de nada.
  const copiasPorOriginal = new Map<string, Gasto[]>();
  for (const g of input.gastos) {
    if (!duplicados.has(g.id)) continue;
    const original = originalDe.get(g.id);
    if (!original) continue;
    const lista = copiasPorOriginal.get(original) ?? [];
    lista.push(g);
    copiasPorOriginal.set(original, lista);
  }
  for (const [originalId, copias] of copiasPorOriginal) {
    const g = input.gastos.find((x) => x.id === originalId) ?? copias[0];
    const veces = copias.length + 1;   // las copias más el original
    diferencias.push({
      tipo: 'duplicado',
      concepto: g.concepto,
      // El impacto en pesos es lo que se EXCLUYÓ, no el valor de una copia: con
      // tres apariciones se excluyeron dos.
      monto: round2(copias.reduce((a, c) => a + (c.monto > 0 ? c.monto : 0), 0)),
      nota: `Comprobante duplicado: ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)}${g.folio ? ` folio ${sanitizarFolio(g.folio)}` : ''} por ${mxn(g.monto)} aparece ${veces} veces (${copias.length === 1 ? 'una excluida' : `${copias.length} excluidas`} del total).`,
      gastoId: originalId,
    });
  }

  // 3) Diferencia global contra el anticipo
  // diferencia > 0  → sobró anticipo (a favor de la empresa: el operador regresa)
  // diferencia < 0  → el operador gastó de más (a favor del operador)
  const diferencia = round2(input.anticipo - totalComprobado);
  if (Math.abs(diferencia) >= 0.5) {
    diferencias.push({
      tipo: 'anticipo',
      esperado: input.anticipo,
      real: totalComprobado,
      monto: diferencia,
      nota:
        diferencia > 0
          ? `Sobró ${mxn(diferencia)} del anticipo — a favor de la empresa.`
          : `El operador puso ${mxn(-diferencia)} de su bolsa — a favor del operador.`,
    });
  }

  // ── Tickets de portal que se van a quedar sin factura ────────────────────────
  //
  // Un ticket de gasolinera NO es factura: hay que timbrarlo en el portal del
  // emisor. Si nadie lo hace a tiempo, el gasto deja de ser deducible — el
  // dinero ya salió y el IVA se pierde.
  //
  // Se avisa con la regla GENERAL (dentro del mes natural de la operación). Los
  // plazos por cadena que circulan (5-15 días) están SIN VERIFICAR contra los
  // portales, así que NO se afirman: se dice que la ventana puede ser menor.
  //
  // LA LIGA IMPRESA NO PUEDE SER EL ÚNICO DISPARADOR. Lo era, y sobre un ticket
  // real de OXXO ($41.50, 16-jul, tres días de ventana) el aviso no salió: ese
  // papel no trae QR ni URL de facturación, solo el ID de venta. El comercio se
  // reconoce además por RFC —respaldado por dígito verificador— y por la razón
  // social impresa, que es justo para lo que existe `identificarComercio`. Estaba
  // escrito, probado y sin llamar desde ningún lado.
  if (input.hoy) {
    for (const g of input.gastos) {
      if (duplicados.has(g.id) || !(g.monto > 0)) continue;
      if (g.cfdiUuid) continue; // ya timbrado
      const extra = g.ocrExtra as Record<string, unknown> | undefined;
      const liga = extra?.urlFacturacion as string | undefined;
      const comercio = identificarComercio({
        urlFacturacion: liga,
        rfcEmisor: g.rfcEmisor,
        textoTicket: [extra?.emisor, extra?.estacion].filter(Boolean).join(' '),
      });
      // Sin comercio Y sin liga no hay nada que afirmar: no todo ticket es
      // facturable, y prometerle un portal a quien compró en una fonda sin RFC
      // manda a la oficina a buscar algo que no existe.
      if (!liga && !comercio) continue;
      if (!g.fecha) continue; // sin fecha no se afirma nada
      // Un comprobante de otro EJERCICIO ya lleva su `gasto_otro_ejercicio`,
      // que dice que no se deduce en este año. Añadirle el aviso de facturación produce
      // dos frases que se contradicen sobre el mismo ticket: una dice que no se
      // deduce, y la otra ofrece "exigirlo dentro del ejercicio" — un remedio que
      // para un ticket de 2019 mirado en 2026 no existe. Salió sobre cinco
      // tickets viejos el 28-jul-2026, al hacer permanente el aviso.
      const ejercicioHoy = Number(input.hoy.slice(0, 4));
      if (Number(g.fecha.slice(0, 4)) < ejercicioHoy) continue;
      // El plazo del comercio se usa SOLO si está verificado contra su portal.
      // `plazoVerificado: false` es el default del catálogo a propósito: un plazo
      // inventado haría que el sistema jure que un ticket sigue vigente.
      // EL PLAZO IMPRESO EN EL PAPEL GANA. Auditoría del 24-ago-2026 sobre
      // cinco tickets reales: dos traían su plazo impreso —24 hrs y 72 horas—
      // y este renglón, que no lo leía, aplicó `mes_natural` y le dijo al
      // chofer que podía facturar hasta fin de mes. Los dos ya habían vencido.
      //
      // Es el mismo criterio de niveles que el resto del motor: un plazo que
      // el comercio IMPRIME en su propio ticket es evidencia directa suya, y
      // le gana tanto al catálogo como al default. El catálogo es una
      // generalización sobre la cadena; esto es este comercio, este día.
      const horasImpresas = (g.ocrExtra as Record<string, unknown> | undefined)?.plazoFacturacionHoras;
      const plazo: Plazo = typeof horasImpresas === 'number' && Number.isFinite(horasImpresas) && horasImpresas > 0
        ? { horas: horasImpresas }
        : comercio?.plazoVerificado ? comercio.plazo : 'mes_natural';
      const plazoDelTicket = typeof horasImpresas === 'number' && horasImpresas > 0;
      const c = calcularCaducidad({ fechaTicket: g.fecha.slice(0, 10), plazo, hoy: input.hoy });
      // NO se espera a que sea urgente. El umbral de 2 días viene de un panel que
      // alguien mira a diario; la liquidación es un documento de UNA sola vez, y
      // si al generarla quedaban 3 días, el PDF calla y nadie vuelve a abrirlo.
      // Medido el 28-jul-2026 sobre ocho tickets reales: $9,070 sin timbrar, con
      // portal reconocido, a tres días del cierre, y la liquidación en silencio.
      // Ahora se dice siempre, y lo que cambia con la urgencia es el TONO.
      if (c.desconocido) continue;
      // LA FECHA QUE SE DICE ES DE NIVEL 6, Y TIENE QUE SONAR A NIVEL 6.
      //
      // `normas/politica-portales-plazos.yaml` lo dice sin rodeos: "ESTO NO ES
      // UNA NORMA FISCAL… El plazo LEGAL para pedir factura es todo el ejercicio
      // (el SAT lo dice expresamente)… El producto NUNCA debe presentar estos
      // plazos como una obligación fiscal". La rama VENCIDA sí lo decía; las
      // otras dos no, y son las que se leen antes. Un contralor que lee "puedes
      // timbrarlo hasta el 31-ago" concluye que el 1-sep se perdió el CFDI —
      // justo el error de confundir niveles que `normas/README.md` llama el más
      // caro del dominio, esta vez cometido por el papel que vendemos.
      //
      // El matiz cambia según de dónde salga la fecha: sin verificar, la ventana
      // del comercio puede ser MENOR; verificada, la ventana es la del comercio
      // y el ejercicio sigue siendo el plazo de la ley.
      //
      // AUDITORÍA 10, MEDIO REINCIDENTE (fiscal) — el matiz legal ("no es la
      // ley, puedes exigir dentro del ejercicio") solo salía en la rama
      // VERIFICADA, y `plazoVerificado: false` es el default de casi todo el
      // catálogo de comercios (el conteo exacto vive en `comercios.ts`, no
      // aquí: citado en un comentario ya se pudrió una vez): la rama
      // minoritaria era la única que decía la verdad completa. El dato de que el plazo real es el ejercicio no
      // depende de que YA se haya verificado el plazo de ESE comercio — es
      // información fiscal que aplica igual en los dos casos, así que ahora
      // se dice en los dos.
      const cierreComercio = plazoDelTicket
        // El propio ticket lo imprime: es la fuente más fuerte que hay, y hay
        // que decir que salió de ahí para que nadie lo confunda con la ley.
        ? ` (plazo impreso en el propio ticket, no de la ley: legalmente puedes exigir la factura dentro del ejercicio)`
        : comercio?.plazoVerificado
        ? ` (plazo del portal de ${comercio.nombre}, no de la ley: legalmente puedes exigir la factura dentro del ejercicio)`
        : ' (la ventana del comercio no está verificada y puede ser menor; de cualquier forma, legalmente puedes exigir la factura dentro del ejercicio)';
      // SI LA FECHA ESTÁ EN DUDA, EL PLAZO TAMBIÉN. Las dos observaciones salen
      // del MISMO dato, y una de ellas manda a la oficina a hacer algo.
      //
      // Visto el 1-ago con un ticket real: el OCR leyó un 8 como 6 y fechó en
      // junio una compra de agosto. El motor dudó de la fecha —bien— y en la
      // línea siguiente afirmó que el plazo de facturación se había vencido,
      // calculado sobre esa misma fecha. Le habría costado a la oficina pelear
      // por Conciliación de Factura una factura que el portal del comercio
      // habría emitido sin discutir.
      //
      // Dudar de un dato y a la vez actuar sobre él es peor que no dudar: el
      // aviso lleva la autoridad de un cálculo y la fragilidad de una lectura.
      const fechaEnDuda = diferencias.some((d) =>
        (d.tipo === 'fecha_sospechosa' || d.tipo === 'gasto_otro_ejercicio') && d.gastoId === g.id);
      const cuerpo = fechaEnDuda
        ? `no se puede calcular el plazo de facturación: su fecha no cuadra con el viaje y hay que verificarla primero en el papel`
        : c.vencido
        ? `se pasó el plazo de facturación. El comercio ya no suele facturarlo en su portal, pero legalmente puedes exigirlo dentro del ejercicio (Conciliación de Factura del SAT)`
        : c.urgente
          ? `quedan ${c.diasRestantes} día(s) para timbrarlo, hazlo antes${cierreComercio}`
          : `puedes timbrarlo hasta el ${c.fechaLimite} (${c.diasRestantes} días)${cierreComercio}`;
      // Con comercio reconocido el aviso deja de ser genérico: dice a qué portal
      // ir y qué datos hay que teclear, que es la diferencia entre un recordatorio
      // y una instrucción que alguien puede ejecutar.
      // Los campos solo se enumeran si el catálogo los tiene: hay comercios
      // portados de la tabla vieja cuyo portal se conoce pero cuyas etiquetas no
      // están verificadas, y listar nombres inventados en un documento que lee un
      // contralor es el mismo error que citar una ley que no dice lo que se cita.
      const pide = comercio?.campos.filter((k) => k.requerido).map((k) => k.etiquetaPortal) ?? [];
      const donde = comercio
        ? ` Portal de ${comercio.nombre}: ${comercio.portal}${pide.length ? ` — te pedirá ${pide.join(', ')}.` : '.'}`
        : '';
      diferencias.push({
        tipo: 'factura_por_vencer', concepto: g.concepto, monto: 0,
        nota: `${etiquetaConcepto(g.concepto, extra)} de ${mxn(g.monto)} sigue sin factura: ${cuerpo}.${donde}`,
        gastoId: g.id,
      });
    }
  }

  // ── H1: la alimentación necesita hospedaje o transporte que la ampare ────────
  //
  // LISR 28-V: el tope de $750 procede "y el contribuyente acompañe el comprobante
  // fiscal o la documentación comprobatoria que ampare el hospedaje o transporte".
  // Una comida sola no cumple ese párrafo.
  //
  // Se marca para REVISIÓN, no se declara no deducible: no vemos toda la
  // contabilidad de la flota y el comprobante de hospedaje puede existir fuera de
  // esta liquidación. Declararlo perdido sería el mismo error al revés.
  {
    const vivos = input.gastos.filter((g) => !duplicados.has(g.id) && g.monto > 0);
    // `flete` NO cuenta, y por eso existe como concepto aparte. LISR 28-V pide el
    // comprobante que ampare "el hospedaje o transporte" — de la PERSONA. Medido
    // el 28-jul-2026 sobre tickets reales: tres guías de Paquetexpress bastaban
    // para que esta advertencia desapareciera sobre una comida de $1,050. El
    // motor daba por amparado lo que la ley no ampara, y callando.
    // AUDITORÍA 10, MEDIO REINCIDENTE (fiscal) — `haySoporte` miraba solo el
    // concepto, nunca si ese hospedaje/transporte era un gasto real. Un
    // hospedaje de $1 SIN TIMBRAR —que el propio motor ya clasifica en `por
    // confirmar`, ver `cubetaDe` arriba— bastaba para apagar la advertencia
    // sobre una comida de $700 sin soporte de verdad.
    //
    // No basta con exigir CFDI a secas: un hospedaje de $1,000 sin timbrar
    // TODAVÍA es un comprobante real en camino a facturarse (la prueba "con
    // hospedaje en el viaje, la alimentación queda soportada" lo fija así a
    // propósito, y exigir CFDI ahí le quitaría el amparo a la mayoría de los
    // hospedajes reales, que llegan sin timbrar). Lo que NO es real es un
    // monto TRIVIAL sin CFDI: ahí no hay comprobante fiscal ni nada que se
    // pueda llamar de verdad documentación comprobatoria — es un placeholder o
    // un ticket ilegible, y las dos señales (monto trivial Y sin CFDI) tienen
    // que darse juntas para descalificarlo.
    const MONTO_TRIVIAL_MXN = 50; // muy por debajo de cualquier hospedaje/transporte real de los datos vistos
    const esAmparoReal = (g: Gasto) => g.monto > MONTO_TRIVIAL_MXN || Boolean(g.cfdiUuid);
    const haySoporte = vivos.some((g) => (g.concepto === 'hospedaje' || g.concepto === 'transporte') && esAmparoReal(g));
    const comidas = haySoporte ? [] : vivos.filter((g) => g.concepto === 'alimentacion');
    if (comidas.length) {
      // UNA sola observación, no una por comida.
      //
      // La causa es una y es del VIAJE —no hay hospedaje ni transporte en toda
      // la liquidación—, así que repetirla por comprobante no añade
      // información: dice tres veces lo mismo cambiando la cifra. En el PDF del
      // 1-ago eran tres renglones de seis, y al envolverse pasaron a nueve, con
      // la mitad del papel ocupada por una frase idéntica.
      //
      // Lo que el contralor necesita saber es CUÁNTO está en revisión por esta
      // causa, y eso antes tenía que sumarlo él.
      //
      // `monto` sigue en 0 a propósito: es una advertencia para revisar, no
      // dinero perdido. Ponerle el total en la columna de importes lo declararía
      // no deducible, que es justo lo que el comentario de arriba dice que no se
      // puede afirmar sin ver toda la contabilidad de la flota.
      const total = comidas.reduce((s, g) => s + g.monto, 0);
      const sujeto = comidas.length === 1
        ? `Alimentación de ${mxn(total)}`
        : `${mxn(total)} en ${comidas.length} comprobantes de alimentación`;
      diferencias.push({
        tipo: 'alimentacion_sin_soporte', concepto: 'alimentacion', monto: 0,
        nota: `${sujeto} sin comprobante de hospedaje ni de transporte del mismo viaje: LISR 28-V condiciona la deducción a que uno de los dos la ampare. Adjúntalo o confírmalo con tu contador.`,
        // Con una sola comida se conserva a qué comprobante apunta; con varias
        // no hay UNO al que señalar, y apuntar al primero sería mentir sobre los
        // otros.
        gastoId: comidas.length === 1 ? comidas[0].id : undefined,
      });
    }

    // AUDITORÍA 9, ALTO (fiscal) — H1b: cuando lo único que ampara la comida es
    // TRANSPORTE (sin hospedaje en el viaje), LISR 28-V exige ADEMÁS que el
    // pago se haya hecho con tarjeta de crédito de quien viaja (2º párrafo,
    // 3ª oración, verificado_fuente_primaria):
    //
    //   "Cuando a la documentación que ampare el gasto de alimentación el
    //   contribuyente únicamente acompañe el comprobante fiscal relativo al
    //   transporte, la deducción... sólo procederá cuando el pago se efectúe
    //   mediante tarjeta de crédito de la persona que realiza el viaje."
    //
    // Débito ('28') NO cuenta: la ley pide crédito ('04'), no cualquier
    // tarjeta. Con hospedaje presente esta condición no aplica —ya no es
    // "únicamente" transporte— y es exactamente lo que ya cubre H1 arriba.
    //
    // Mismo criterio de severidad que H1 y la misma razón: no vemos toda la
    // contabilidad de la flota (el hospedaje podría existir fuera de esta
    // liquidación), así que se manda a revisión, no se declara no deducible.
    const hayHospedaje = vivos.some((g) => g.concepto === 'hospedaje');
    const hayTransporte = vivos.some((g) => g.concepto === 'transporte');
    if (!hayHospedaje && hayTransporte) {
      const comidasSinTarjeta = vivos.filter((g) => g.concepto === 'alimentacion' && g.formaPago !== '04');
      if (comidasSinTarjeta.length) {
        const total = comidasSinTarjeta.reduce((s, g) => s + g.monto, 0);
        const sujeto = comidasSinTarjeta.length === 1
          ? `Alimentación de ${mxn(total)}`
          : `${mxn(total)} en ${comidasSinTarjeta.length} comprobantes de alimentación`;
        diferencias.push({
          tipo: 'alimentacion_transporte_sin_tarjeta_credito', concepto: 'alimentacion', monto: 0,
          nota: `${sujeto} amparada SOLO por transporte (sin hospedaje en el viaje): LISR 28-V exige que, en ese caso, el pago sea con tarjeta de crédito de quien viaja. Sin esa condición la deducción no procede — confírmalo con tu contador.`,
          gastoId: comidasSinTarjeta.length === 1 ? comidasSinTarjeta[0].id : undefined,
        });
      }
    }
  }

  // ── Consumos en BAR: "en ningún caso" deducibles (LISR 28-XX) ────────────────
  // AUDITORÍA 18, M5. La señal es heurística (ver `pareceBar`), así que no se
  // afirma "no deducible": va a POR CONFIRMAR y a revisión, y la nota dice qué
  // confirmar. Si es restaurante, el contralor lo reclasifica; si es bar, el
  // papel ya no le prometió una deducción que la ley niega.
  for (const g of input.gastos) {
    if (duplicados.has(g.id) || !pareceBar(g)) continue;
    const emisor = (g.ocrExtra as Record<string, unknown> | undefined)?.emisor;
    const quien = typeof emisor === 'string' && emisor ? ` ("${emisor}")` : '';
    diferencias.push({
      tipo: 'consumo_bar', concepto: g.concepto, monto: 0,
      nota: `Alimentación de ${mxn(g.monto)}${quien}: el comprobante parece de un BAR, y los consumos en bares no son deducibles en ningún caso (LISR 28-XX) ni acreditan IVA (LIVA 5-I). Se deja por confirmar: si fue restaurante, reclasifícalo; si fue bar, no se deduce.`,
      gastoId: g.id,
    });
  }

  // ── Tope fiscal de ALIMENTACIÓN: $750 POR DÍA y por beneficiario (LISR 28-V) ──
  //
  // EL CRITERIO NO VIVE AQUÍ. Qué concepto carga el tope, la agrupación por
  // día (y el "sin fecha, cada quien su día"), y la proporción calculada SOLO
  // entre los timbrados —con las auditorías 3 y 8 que lo pagaron— están en
  // `tope_alimentacion.ts`, COMPARTIDO con `resumirFiscal` en `fiscal.ts`.
  // AUDITORÍA 4, E4: este bloque y el panel del contador calculaban cada quien
  // su regla y no coincidían (83.3% contra 100% del IVA sobre el mismo viático
  // de $900 con tope de $750). No dupliques el cálculo aquí: cámbialo allá y
  // los dos consumidores se mueven juntos.
  //
  // El beneficiario es el operador del viaje: la liquidación es de un solo
  // operador, así que pasarle los gastos del viaje ya cumple el "por
  // beneficiario" de la ley.
  const topeAlimentacion = input.estimulos?.viaticosTopeFiscalDiarioMxn;
  if (topeAlimentacion != null) {
    const vivosTope = input.gastos.filter((g) => !duplicados.has(g.id));
    for (const d of diasSobreTope(vivosTope, topeAlimentacion)) {
      // La proporción del día la heredan SOLO los timbrados: `cubetaDe` ya
      // manda los tickets sin CFDI a por_confirmar por su cuenta y nunca lee
      // `proporcionDeducible`. Acreditar de más es del lado caro: responde el
      // cliente ante una revisión.
      if (d.proporcionTimbrado != null) {
        for (const x of d.delDia) if (x.cfdiUuid) proporcionDeducible.set(x.id, d.proporcionTimbrado);
      }

      // AUDITORÍA 9, ALTO (fiscal): el `monto` de esta diferencia CERRABA el
      // dinero (la proporción: solo entre timbrados) pero no la FRASE — seguía
      // colgado de `exceso`, calculado contra `total` (el día completo,
      // timbrado o no). Con dos tickets SIN CFDI de $1,200 y $800, el papel
      // imprimía "el excedente de $1,250.00 no es deducible" en la misma hoja
      // donde el desglose decía "No deducible $0.00" — ninguna cubeta
      // contenía esos $1,250, porque un comprobante sin timbrar no es
      // deducción de nadie todavía (LISR 28-V acota la DEDUCCIÓN, no el gasto
      // crudo). `montoNoDeducible` es SOLO el exceso de lo timbrado —lo
      // mismo que de verdad resta de `totalDeducible`— y la nota distingue el
      // panorama informativo del día (`total`, que sigue avisando ANTES de
      // timbrarse, a propósito) de lo que hoy es una afirmación real.
      //
      // La DIFERENCIA sigue colgada de un comprobante, porque los totales de
      // deducibilidad suman por gastoId y tiene que vivir en alguno. Eso es
      // correcto para el total no deducible del día; lo que no podía ser es que
      // decidiera también el prorrateo del IVA.
      const ancla = d.delDia[d.delDia.length - 1];
      const cuantos = d.delDia.length > 1 ? ` (${d.delDia.length} comprobantes del día)` : '';
      const cuando = d.dia.startsWith('sin-fecha') ? 'sin fecha' : d.dia;
      const nota = d.montoNoDeducible > 0
        ? `Alimentación del ${cuando}: ${mxn(d.total)}${cuantos} excede el tope fiscal de ${mxn(topeAlimentacion)} por día (LISR 28-V) — el excedente de ${mxn(d.montoNoDeducible)} no es deducible.`
        : `Alimentación del ${cuando}: ${mxn(d.total)}${cuantos} excede el tope fiscal de ${mxn(topeAlimentacion)} por día (LISR 28-V). Hoy nada de esto es "no deducible" todavía: lo que falta por timbrar sigue por confirmar — el excedente se calcula cuando llegue la factura.`;
      diferencias.push({
        tipo: 'viatico_excede_fiscal', concepto: ancla.concepto,
        esperado: topeAlimentacion, real: round2(d.total), monto: d.montoNoDeducible,
        nota,
        gastoId: ancla.id,
      });
    }
  }



  // ── Acreditamiento ─────────────────────────────────────────────────────────
  // ESTE BLOQUE VA AL FINAL A PROPÓSITO. Corría antes del tope de alimentación,
  // que es lo que genera `viatico_excede_fiscal`, así que cuando calculaba la
  // proporción deducible de LIVA 5-I esa diferencia todavía no existía y el IVA
  // se acreditaba entero. Mover el bloque es el arreglo: aquí ya están TODAS las
  // diferencias.
  // OJO CON EL NOMBRE: esta lista NO dice qué gasto es deducible para ISR. Dice
  // qué gasto no puede ACREDITAR impuestos, que es otra cosa. Se llamaba
  // NO_DEDUCIBLE y esa confusión casi cuesta un bug caro: `combustible_efectivo`
  // SÍ es deducible hasta el 15% (RFA 2026 regla 2.9), pero NO acredita IEPS —
  // la facilidad salva un beneficio, no los dos. Sacarlo de aquí acreditaría un
  // IEPS que la facilidad no concede.
  // `moneda_extranjera` (DAT-19) entra aquí por la misma razón que
  // `cfdi_pendiente`: el importe de la columna NO son pesos, así que acreditar
  // su IVA sería acreditar una cifra que nadie convirtió. Es el tercer estado
  // de siempre —«no se pudo verificar»— y nunca se resuelve en verde solo.
  // `gasto_otro_ejercicio` entra desde la auditoría Fable ciclo 1 (90-A): el
  // tipo nació en NO_DEDUCIBLE_ISR pero no aquí, así que un diésel del
  // ejercicio pasado con CFDI válido salía con deducible $0 y aun así
  // acreditaba su IVA completo, su peaje y sus litros — contra la LIVA 5-I
  // que este mismo bloque cita ("en la proporción en que las erogaciones
  // sean deducibles": la proporción es cero).
  // `cfdi_efos_indeterminado` (AUDITORÍA 21): mismo tercer estado que
  // `cfdi_pendiente` — con la validación EFOS no concluyente, el emisor puede
  // estar en el listado DEFINITIVO del 69-B ("no producen ni produjeron efecto
  // fiscal alguno", 4º párrafo, ficha verificada) y acreditar su IVA sería
  // afirmar en verde lo que la ley niega de plano. Ver el comentario largo en
  // POR_CONFIRMAR.
  // `renglones_ajenos` entra desde la AUDITORÍA 22 (ARQ-1): el arreglo de
  // FISCAL-19C2-6 lo metió en POR_CONFIRMAR y en REVISAR y se detuvo ahí, así
  // que un CFDI de canasta mixta salía con `totalDeducible 0` /
  // `totalPorConfirmar 1000` y ACREDITABA su IVA completo — la misma
  // contradicción que este bloque ya había corregido dos veces (`cfdi_pendiente`
  // en la 12, `gasto_otro_ejercicio` en el ciclo Fable 1). La proporción
  // deducible de un gasto por confirmar es cero, y cero es lo que LIVA 5-I
  // permite acreditar hasta que una persona lo confirme.
  //
  // `ticket_monedero` es el otro miembro de POR_CONFIRMAR que no está en esta
  // lista, y NO se agrega: es una foto de bomba, nunca trae CFDI, y el
  // `if (!g.xmlVerificado) continue` de abajo ya lo ataja estructuralmente.
  // Meterlo aquí sugeriría que sin esta línea acreditaría, y no es cierto.
  // Las dos listas de acreditamiento (`SIN_IVA_ACREDITABLE`, `SIN_ESTIMULO`)
  // viven arriba, exportadas junto a las de las cubetas (ARQ-1). El
  // `iepsAcreditable` de abajo es `const … = 0`, así que la pertenencia de los
  // dos tipos de la RFA 2.9 a SIN_ESTIMULO no protege una cifra en pesos: lo
  // que protege son los LITROS elegibles y el peaje.
  const peajeFactor = input.estimulos?.peajeFactor ?? 0.5;
  // `iepsAcreditable` se queda en 0 a propósito y por eso es const: el estímulo
  // del LIF 20-A no es una cifra que este motor pueda calcular (necesita la cuota
  // semanal del DOF). Se conserva el campo para no romper los consumidores y la
  // columna de la BD; el dato útil es `litrosDieselAcreditables`.
  const iepsAcreditable = 0;
  let ivaAcreditable = 0, peajeAcreditable = 0;
  let litrosDieselAcreditables = 0;
  for (const g of input.gastos) {
    if (duplicados.has(g.id)) continue;
    // FIS-C2: dos preguntas separadas sobre el MISMO gasto. Un diésel en
    // efectivo dentro del 15% acredita su IVA (es deducible) y NO acredita el
    // estímulo (la RFA 2.9 lo niega). Antes un solo `continue` respondía las
    // dos con «no».
    const misDif = diferencias.filter((d) => d.gastoId === g.id);
    const sinIva = misDif.some((d) => SIN_IVA_ACREDITABLE.includes(d.tipo));
    const sinEstimulo = misDif.some((d) => SIN_ESTIMULO.includes(d.tipo));
    if (sinIva && sinEstimulo) continue;
    // El acreditamiento exige un CFDI VERIFICADO (XML): un ticket de gasolinera
    // sin factura NO es deducible ni acreditable hasta timbrarse. Además, así el
    // IVA/IEPS son SIEMPRE los importes LEÍDOS del XML (nunca recomputados con una
    // tasa asumida: 16% u 8% fronterizo salen tal cual del comprobante).
    if (!g.xmlVerificado) continue;

    // EN PROPORCIÓN A LO DEDUCIBLE. LIVA art. 5 fr. I, verificado contra fuente
    // primaria: "Tratándose de erogaciones PARCIALMENTE DEDUCIBLES para los
    // fines del impuesto sobre la renta, únicamente se considerará para los
    // efectos del acreditamiento... EN LA PROPORCIÓN en la que dichas
    // erogaciones sean deducibles".
    //
    // El caso que ocurre a diario: un viático de alimentación que excede el
    // tope de LISR 28-V es deducible solo hasta el tope, así que su IVA se
    // acredita solo en esa misma proporción. Antes se acreditaba el traslado
    // completo, y acreditar de más es del lado caro: es el cliente quien
    // responde ante una revisión, y el papel se lo dio Likida.
    // La proporción la fijó el tope diario, que es quien sabe repartirla entre
    // los comprobantes del día. Deducirla aquí del monto de la diferencia era lo
    // que colgaba todo el exceso de un solo gasto.
    const proporcion = Math.max(0, Math.min(1, proporcionDeducible.get(g.id) ?? 1));

    // AUDITORÍA 2, CRÍTICO (fiscal): LIVA 5-III exige que el IVA trasladado esté
    // "efectivamente pagado en el mes". Un CFDI con forma de pago '99' (Por
    // definir — la contraprestación no se ha pagado, RMF 2.7.1.29 fr. II) trae
    // IVA trasladado pero NO acreditable aún. Se excluye igual que ya se hace
    // con peaje/diésel en la lógica de forma de pago. Un '99' se acreditará el
    // mes en que se pague (con su complemento de pago), no éste.
    //
    // FASE 7 (mig. 0199): ese complemento de pago YA SE INGIERE. `pagadoEn`
    // solo lo escribe intake/rep.ts cuando un REP liquidó este CFDI POR
    // COMPLETO (ImpSaldoInsoluto = 0) — jamás se infiere. Con el sello, el
    // '99' deja de cerrar la puerta del IVA; sin él, todo queda EXACTAMENTE
    // como antes (el REP solo abre). Y `pagadoForma` (FormaDePagoP del REP,
    // el medio con el que DE VERDAD se pagó) sustituye al '99' en las
    // puertas que juzgan el MEDIO: peaje electrónico e IEPS de diésel. Si el
    // REP no trajo FormaDePagoP legible, esas puertas siguen cerradas —
    // "pagado" no implica "pagado con un medio admitido".
    const pagadoConRep = g.formaPago === FORMA_PAGO_SIN_PAGAR && !!g.pagadoEn;
    const formaPagoEfectiva = pagadoConRep ? g.pagadoForma : g.formaPago;
    if (!sinIva && (g.ivaTraslado ?? 0) > 0 && (g.formaPago !== '99' || pagadoConRep)) {
      ivaAcreditable += (g.ivaTraslado as number) * proporcion;
      // La verdad fiscal completa, no solo la cifra: LIVA 5-III lo acredita
      // EN EL MES DEL PAGO. Si ese mes no es el del comprobante, el contralor
      // tiene que asentarlo en el periodo correcto — esconderlo dejaría una
      // declaración con el IVA en el mes equivocado, firmada por el sistema.
      if (pagadoConRep && g.pagadoEn!.slice(0, 7) !== (g.fecha ?? '').slice(0, 7)) {
        diferencias.push({
          tipo: 'iva_mes_del_pago', concepto: g.concepto, monto: 0,
          nota: `El CFDI de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} era a crédito (forma de pago 99) y su complemento de pago llegó: se pagó el ${g.pagadoEn}. Su IVA se acredita en ESE mes (LIVA 5-III), no en el del comprobante (${g.fecha ?? 'sin fecha'}) — asiéntalo en el periodo del pago.`,
          gastoId: g.id,
        });
      }
    }
    // Peaje (1.6): 50% del SubTotal (sin IVA) de casetas, SOLO con pago
    // electrónico. AUDITORÍA 2 (fiscal): sin forma de pago o con '99' (Por
    // definir = no pagado) no se afirma el estímulo — es el tercer estado, "no se
    // pudo verificar" nunca es "sí". Mismo criterio que diésel e IVA.
    // AUDITORÍA 18, A7: y "electrónico" es la lista cerrada de la RMF 9.1.8
    // fr. III (`MEDIOS_ELECTRONICOS_PEAJE`), no "todo lo que no sea efectivo".
    // FASE 7: la forma EFECTIVA — con un REP que liquidó el CFDI, el medio
    // real es el FormaDePagoP del pago, no el '99' del comprobante.
    const peajePagadoElectronicamente = !!formaPagoEfectiva && (MEDIOS_ELECTRONICOS_PEAJE as readonly string[]).includes(formaPagoEfectiva);
    // Dos condiciones distintas, ambas necesarias — se arreglaron el mismo día
    // por caminos separados y aquí conviven:
    //
    //   1. QUIÉN puede acreditar. `elegiblePeaje === false` es el perfil
    //      confirmando que esta flota no califica (ingresos ≥ $300M o parte
    //      relacionada). Solo `true` es una declaración suficiente;
    //      `undefined` también cierra la puerta.
    //   2. SOBRE QUÉ se acredita. La base es lo que quedó DESPUÉS del
    //      `@Descuento` del emisor — un atributo opcional del CFDI 4.0 que
    //      antes no se leía en ninguna capa, así que una factura de casetas
    //      con descuento acreditaba sobre el SubTotal íntegro. Se acota a 0
    //      por si llega un CFDI mal formado: una base negativa no existe.
    const elegiblePeaje = input.elegiblePeaje === true;
    if (!sinEstimulo && g.concepto === 'caseta' && (g.subTotal ?? 0) > 0 && peajePagadoElectronicamente && elegiblePeaje) {
      const baseDelEstimulo = Math.max(0, (g.subTotal as number) - (g.descuento ?? 0));
      peajeAcreditable += baseDelEstimulo * peajeFactor;
    }
    // IEPS de DIÉSEL (7): el estímulo (LIF 2026 art. 20, ap. A) es SOLO diésel — NO
    // gasolina. Se identifica por la clave de producto del SAT (15101505).
    const clavesDiesel = input.estimulos?.clavesDieselIeps ?? [];
    const esDieselIeps = clavesDiesel.includes(g.claveProdServ ?? '');
    // `!sinEstimulo`: esto es lo que la RFA 2.9 SÍ niega al efectivo, con todas
    // sus letras. Es la mitad que la lista única protegía de verdad (FIS-C2).
    if (!sinEstimulo && esDieselIeps) {
      // EL ESTÍMULO NO ES EL IEPS TRASLADADO. `normas/lif-2026-20-A.yaml`
      // (verificado_fuente_primaria) dice literal: "cuota IEPS vigente al momento
      // de la compra × LITROS. No es el IEPS trasladado en el CFDI."
      //
      // Antes se sumaba el trasladado y el PDF lo imprimía en verde citando ese
      // artículo. Dos errores encima: la fórmula equivocada, y una cifra en pesos
      // que la decisión D2 del roadmap prohibió enseñar "sin discusión" —la cuota
      // pasó de $7.3634 a $2.0925 en cinco meses, y el estímulo es ingreso
      // acumulable, así que en bruto infla la propuesta ~30%.
      //
      // Sin el acuerdo semanal del DOF no se puede calcular. Lo que sí se puede
      // es contar los LITROS elegibles: es el dato duro que el contador
      // multiplica por la cuota que él tenga fechada.
      //
      // El medio de pago es requisito del 4º párrafo de la LIF 20-A-IV (monedero,
      // tarjeta, cheque nominativo o transferencia) — AUDITORÍA 25, BAJO FISCAL
      // (línea 347): re-verificado contra el PDF oficial de diputados.gob.mx,
      // el párrafo existe tal cual y ahora está transcrito en
      // `normas/lif-2026-20-A.yaml` (estimulo_diesel_transporte.texto_vigente).
      // Y NO tiene la válvula del 15% que la RFA 2.9 sí concede para ISR: la
      // facilidad salva la deducción, no el acreditamiento.
      // Los litros los lee el OCR del ticket y viven en `ocrExtra` (el XML del
      // CFDI no siempre trae la cantidad desglosada por concepto).
      const litros = Number((g.ocrExtra as Record<string, unknown> | undefined)?.litros ?? 0);
      // AUDITORÍA 2 (fiscal): lista CERRADA de la LIF 20-A-IV, no "cualquiera !=
      // 01". Antes admitía 06, 08, 30, 31 y 99 (no pagado), que la ley no cubre.
      const pagoElectronico = !!formaPagoEfectiva && (MEDIOS_LISR_27_III as readonly string[]).includes(formaPagoEfectiva);
      if (pagoElectronico && Number.isFinite(litros) && litros > 0) {
        // AUDITORÍA 8, CRÍTICO: los litros salen del OCR y nada los cotejaba —
        // ni contra el XML (no siempre trae la cantidad desglosada), ni contra
        // precio×litros≈monto. Un decimal corrido en la lectura (200.00 L visto
        // como 20,000 L) acreditaba cien veces el estímulo real, y es justo el
        // número que el contador multiplica por la cuota del DOF. Tolerancia
        // amplia (0.5×–2× el precio de referencia) a propósito: no es para fijar
        // el precio del litro, solo para atrapar un error de lectura grosero sin
        // marcar tickets legítimos por variación regional de precio.
        const precioRef = input.estimulos?.precioDieselPorDefecto ?? 27.0;
        const litrosEsperados = precioRef > 0 ? g.monto / precioRef : 0;
        const razon = litrosEsperados > 0 ? litros / litrosEsperados : Infinity;
        if (razon < 0.5 || razon > 2) {
          diferencias.push({
            tipo: 'diesel_desviacion', concepto: g.concepto, monto: 0,
            nota: `Los ${litros} L leídos de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} no cuadran con el monto: ${mxn(g.monto)} ÷ ~$${precioRef}/L ≈ ${Math.round(litrosEsperados)} L esperados. No se acredita el estímulo hasta verificar el ticket.`,
            gastoId: g.id,
          });
        } else {
          litrosDieselAcreditables += litros;
        }
      }
      if (!(g.iepsTraslado ?? 0) && g.xmlVerificado) {
        diferencias.push({ tipo: 'ieps_no_desglosado', concepto: g.concepto, monto: 0, nota: `El CFDI de ${etiquetaConcepto(g.concepto, g.ocrExtra as Record<string, unknown> | undefined)} no desglosa el IEPS — es deducible, pero sin ese desglose se complica documentar el estímulo (LIF 2026 art. 20, ap. A).`, gastoId: g.id });
      }
    }
  }


  // ── Totales de deducibilidad (la cifra que compra el contralor) ──────────────
  // El motor ya detectaba todo lo necesario y no lo sumaba: el contralor tenía que
  // leer la lista de diferencias y hacer la cuenta a mano.
  //
  // Son TRES cubetas, no dos. El combustible en efectivo no cabe en ninguna de las
  // clásicas: es deducible hasta el 15% del combustible del ejercicio (RFA 2026
  // regla 2.9) y ese contador todavía no existe. Ponerlo en "no deducible" le
  // quita dinero al cliente; ponerlo en "deducible" le promete algo que quizá no
  // tenga. Se declara "por confirmar" hasta que exista el contador.
  //
  // OJO: `sobre_politica` NO entra aquí. Exceder la política INTERNA de la flota
  // no vuelve el gasto no deducible ante el SAT: son dos juicios distintos.
  // `sin_cfdi` NO va aquí, y es a propósito. Estuvo, y creaba una contradicción:
  // esta lista se evalúa ANTES que la regla de "sin cfdiUuid → POR CONFIRMAR", así
  // que el mismo hecho —un ticket sin timbrar— salía ROJO si el tenant tenía
  // `requiereCfdi` en su política y ÁMBAR si no. El veredicto dependía de un flag
  // de configuración, no de la ley.
  //
  // El correcto es ámbar. LISR 27-III exige comprobante fiscal, pero el ticket
  // TODAVÍA se puede timbrar: no es deducción perdida, es pendiente. Pintarla de
  // rojo le dice al contralor que dé por perdido un dinero que recupera con una
  // llamada al portal. Se sigue avisando por `diferencias`, que para eso está.

  let totalDeducible = 0, totalNoDeducible = 0, totalPorConfirmar = 0;
  for (const g of input.gastos) {
    // Mismo filtro que `totalComprobado`, para que las tres cubetas SIEMPRE sumen
    // ese total. Si no cuadra, el contralor lo nota con una calculadora.
    if (duplicados.has(g.id) || !(g.monto > 0)) continue;
    const suyas = diferencias.filter((d) => d.gastoId === g.id);
    const cubeta = cubetaDe(g, suyas);
    if (cubeta === 'no_deducible') { totalNoDeducible += g.monto; continue; }
    if (cubeta === 'por_confirmar') { totalPorConfirmar += g.monto; continue; }
    // Parcial: del viático solo se pierde el EXCEDENTE sobre el tope fiscal
    // (LISR 28-V), no el gasto entero. Mandar los $900 completos a no deducible
    // por $150 de exceso es el error que más dinero le cuesta al cliente.
    //
    // El reparto va por PROPORCIÓN del día, la misma que el bloque de
    // acreditamiento usa para el IVA — y por la misma razón que allá se dejó de
    // anclar el exceso a un comprobante. Aquí se seguía anclando, y producía un
    // deducible NEGATIVO: dos comidas del mismo día, $2,000 sin CFDI y $100 con
    // CFDI, tope $750. El exceso del día ($1,350) se colgaba del ancla —el de
    // $100, que es el único en la cubeta deducible— y salía
    // `totalDeducible = -1250` bajo un comprobado de $2,100. Eso se imprime.
    //
    // Con la proporción, cada comprobante del día es deducible en su parte del
    // tope ($750/$2,100 = 35.7%) y no deducible en el resto. Nunca es negativo,
    // no depende del ORDEN del arreglo, y las tres cubetas siguen sumando el
    // comprobado. Los gastos que ya cayeron en `por_confirmar` no arrastran su
    // exceso hasta acá: mientras no estén timbrados no son deducción de nadie.
    const proporcion = Math.max(0, Math.min(1, proporcionDeducible.get(g.id) ?? 1));
    const deducibleDelGasto = round2(g.monto * proporcion);
    totalDeducible += deducibleDelGasto;
    totalNoDeducible += round2(g.monto - deducibleDelGasto);
  }

  // `REVISAR` vive arriba, DERIVADA de las cubetas más lo operativo (ARQ-1).
  // FIS-6: un comprobante a crédito sin pagar cae a `por_confirmar` por el
  // gasto mismo, no por una diferencia — y por la regla de ARQ-1 (todo lo que
  // saca dinero de la cubeta deducible se revisa) también baja el estatus.
  const hayPagoPendiente = input.gastos.some((g) => !duplicados.has(g.id) && g.monto > 0 && pagoPendiente(g));
  const hayRevisar = hayPagoPendiente || diferencias.some((d) => REVISAR.includes(d.tipo));
  const hayDif = diferencias.some((d) => d.tipo === 'sobre_politica' || d.tipo === 'duplicado' || d.tipo === 'diesel_desviacion') || Math.abs(diferencia) >= 0.5;
  const estatus: EstatusLiquidacion = hayRevisar ? 'revisar' : hayDif ? 'con_diferencias' : 'cuadrada';

  return {
    viajeId: input.viajeId,
    totalComprobado: round2(totalComprobado),
    totalAnticipo: round2(input.anticipo),
    diferencia,
    estatus,
    diferencias,
    gastos: input.gastos,
    totalDeducible: round2(totalDeducible),
    totalNoDeducible: round2(totalNoDeducible),
    totalPorConfirmar: round2(totalPorConfirmar),
    iepsAcreditable: round2(iepsAcreditable),
    litrosDieselAcreditables: round2(litrosDieselAcreditables),
    ivaAcreditable: round2(ivaAcreditable),
    peajeAcreditable: round2(peajeAcreditable),
  };
}

/**
 * Cómo se llama un concepto en el papel que ve el contralor.
 *
 * `diesel` es un cajón que el OCR usa para TODA la gasolinera —el prompt se lo
 * pide, y para el 15% de la RFA 2.9 está bien porque la regla habla de
 * "combustible"—. Pero un ticket real de PLUS (gasolina premium) salía
 * etiquetado "Diésel", y eso invita a reclamar un estímulo que NO aplica: el de
 * IEPS es solo diésel (LIF 20-A fr. IV).
 *
 * El producto impreso ya lo captura el OCR; aquí solo se usa. Sin él se dice
 * "Combustible", que es cierto siempre.
 */

export function etiquetaConcepto(c: string, ocrExtra?: Record<string, unknown>): string {
  if (c !== 'diesel') return label(c);
  const producto = typeof ocrExtra?.producto === 'string' ? ocrExtra.producto.trim() : '';
  if (!producto) return 'Combustible';
  // Se respeta lo impreso, con la primera en mayúscula: "PLUS" → "Plus".
  const bonito = producto.charAt(0).toUpperCase() + producto.slice(1).toLowerCase();
  return /diesel|diésel/i.test(producto) ? 'Diésel' : `Combustible ${bonito}`;
}

function label(c: string): string {
  const m: Record<string, string> = { diesel: 'Diésel', caseta: 'Caseta', factura: 'Factura', alimentacion: 'Alimentación', hospedaje: 'Hospedaje', transporte: 'Transporte', flete: 'Flete', viaticos: 'Viáticos', otro: 'Otro' };   // 'Otro' y no 'Gasto': tiene que decir lo MISMO que pdf.ts y el dashboard
  return m[strip_accents(c.toLowerCase())] ?? c;
}
