// ═══════════════════════════════════════════════════════════════════════════
// LO FISCAL DEL GASTO — el módulo que alimenta el panel del CONTADOR.
//
// QUIÉN ES EL LECTOR. El contador DE LA FLOTA que nos compra el servicio, no
// el de Likida. Esa flota no tiene "clientes" en este producto: tiene VIAJES y
// los comprobantes que sus operadores mandan por WhatsApp. Por eso aquí no hay
// una sola consulta a `cliente`, `factura_emitida` ni `pago_recibido`: existen
// en el esquema (0048/0049) y son de otra parte del producto. El trabajo que
// Likida automatiza —y el único del que puede hablar con cifras— es el del
// gasto que entra por el teléfono.
//
// LA REGLA QUE GOBIERNA CADA FUNCIÓN DE ESTE ARCHIVO: nunca inventar una
// cifra. El contador va a cruzar esto contra su papel de trabajo. Donde el
// dato no exista se devuelve `null` y se dice qué falta — nunca un cero, que
// se lee como medición.
//
// Consecuencia concreta y la más importante del archivo: EL IVA DE UN GASTO
// SIN CFDI NO SE ESTIMA. Multiplicar el total por 0.16 daría una cifra
// preciosa y falsa —el total puede traer propina, IEPS, conceptos exentos o
// tasa 0—, y es justo la columna que el contador teclea en su declaración. Se
// reporta el MONTO en juego y se dice que el IVA no se puede afirmar sin el
// comprobante.
//
// LAS REGLAS DE DEDUCIBILIDAD SON LAS MISMAS QUE LAS DEL MOTOR. `engine.ts`
// ya las evalúa por viaje al liquidar; aquí se evalúan por COMPROBANTE y a lo
// largo de un periodo fiscal, que es como las mira el contador. Las citas
// apuntan a las mismas fichas verificadas de `normas/`. Lo que el motor
// resuelve y esto NO intenta resolver está listado en `LIMITES` al final.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase/admin';
import { exigir } from './pg';
import { acotada } from './presupuesto';
import { round2, hoyMx, inicioDiaMx, finDiaMx } from '@/lib/formato';
import { identificarComercio } from './facturacion/identificar';
import { COMERCIOS } from './facturacion/comercios';
import { calcularCaducidad, type Plazo } from './facturacion/caducidad';
import { evaluarTope15, type ResultadoTope15 } from './periodo/combustible';
import {
  proporcionAlimentacionPorGasto, diasSobreTope, CONCEPTOS_CON_TOPE_ALIMENTACION,
} from './cuadre/tope_alimentacion';
// La constante vive en el motor a propósito: el panel y el motor tienen que
// juzgar «no pagado» con el MISMO valor, o vuelven las dos cifras (FISC-C3-2).
// AUDITORÍA 25, FIS-C1/FIS-C2/ARQ-C1 (CRÍTICO): `proporcionesDeducibles` es
// LA MISMA función que usa el motor para partir el IVA del 15% de la RFA 2.9
// — se importa aquí a propósito, en vez de reinventar la fórmula, para que
// el panel y el PDF no vuelvan a decir dos cifras del mismo comprobante.
import {
  FORMA_PAGO_SIN_PAGAR, MEDIOS_LISR_27_III, medioNoAdmitidoCombustible, proporcionesDeducibles,
  SENAL_BAR, UMBRAL_RENGLONES_AJENOS, rfcsUtilizablesDe, normalizarRfc,
} from './cuadre/engine';
import { getConfig, type LikidaConfig } from './config';
import { getAcumuladoCombustible } from './repo';
import { logger } from '@/lib/logger';
// RE-AUDITORÍA 25, FIS-REAUD-2: `complemento_hidrocarburos` (SIN_IVA_ACREDITABLE
// de engine.ts) solo declara no deducible con una fecha de EXIGIBILIDAD
// respaldada por FICHA — la misma que `engine.ts` resuelve de `NORMAS`
// cuando `hidrocarburos.exigibleDesde` no se declara en config. Importado a
// propósito, en vez de copiar la fecha, para que el panel y el PDF prendan
// el veredicto duro el mismo día.
import { NORMAS } from './normas/indice';

// ── La fila de `gasto` leída con ojos de contador ──────────────────────────

/**
 * Un comprobante con los campos que deciden su suerte fiscal.
 *
 * Todo lo opcional es `null` y no `undefined` a propósito: `null` es lo que
 * devuelve PostgREST cuando la columna está vacía, y la diferencia entre "no
 * lo sabemos" y "vale cero" es la que este módulo entero existe para no
 * borrar.
 */
export interface GastoFiscal {
  id: string;
  viajeId: string;
  concepto: string;
  monto: number;
  fecha: string | null;
  folio: string | null;
  rfcEmisor: string | null;
  cfdiUuid: string | null;
  /** `true` = el QR del CFDI se leyó y se pudo parsear (`intake/ocr.ts`). */
  cfdiValido: boolean | null;
  /** Respuesta del servicio de consulta del SAT: vigente | cancelado | … */
  estadoSat: string | null;
  /** `true` = emisor en la lista definitiva del 69-B. */
  efos: boolean | null;
  /** El SAT devolvió un código EFOS no concluyente: no se afirma nada. */
  efosRevisar: boolean | null;
  /** c_FormaPago del SAT. '01' es efectivo. */
  formaPago: string | null;
  /**
   * AUDITORÍA 24, FIS-7: ¿un complemento de pago liquidó este CFDI POR
   * COMPLETO? (`gasto.pagado_en is not null`, mig. 0199; dimensión del
   * agregado desde la 0282). `null`/ausente = no se sabe, y se trata como NO
   * pagado — el lado conservador, el mismo que el panel tenía antes.
   */
  pagado?: boolean | null;
  /** `FormaDePagoP` del REP: el medio con el que DE VERDAD se pagó un '99'. */
  pagadoForma?: string | null;
  subTotal: number | null;
  ivaTraslado: number | null;
  iepsTraslado: number | null;
  claveProdServ: string | null;
  tipoComprobante: string | null;
  xmlVerificado: boolean | null;
  ocrConfianza: number | null;
  /** Contexto que el contador pide para poder ir a buscar el papel. */
  viajeFolio: string | null;
  operadorNombre: string | null;
  /**
   * ¿El PORTAL del comercio ya cerró su plazo? Lo calcula `getGastosFiscales`
   * con el plazo del comercio (`facturacion/caducidad.ts`). Es política de un
   * tercero (nivel 6), no un plazo legal: el derecho de exigir la factura
   * vive todo el ejercicio (`normas/politica-portales-plazos.yaml`).
   *
   * `null` = no se sabe (sin fecha de ticket confiable, o comercio no
   * reconocido). NO es `false`: decirle "todavía te da tiempo" a alguien
   * sobre un ticket cuyo plazo no conocemos es la mentira cara.
   */
  plazoVencido: boolean | null;
  /**
   * RE-AUDITORÍA 25, FIS-REAUD-1 (CRÍTICO): ¿el viaje de este comprobante
   * tiene YA una liquidación FIRMADA (`revision` aprobada|ajustada — mismo
   * criterio que la 0308, `acreditables_liquidacion_tenant`)? `false` cubre
   * tanto "sin liquidación todavía" (viaje abierto/en cuadre) como
   * "liquidación pendiente de firma" o "rechazada". Solo lo consulta
   * `ivaSostenible`: sin liquidación firmada no hay liquidación (con su
   * propio veredicto) que sostenga el acreditamiento de LIVA 5 — el resto de
   * `resumirFiscal`/`resumirPerdidas` (gastoTotal, sinCfdi, "pídelo antes de
   * que venza") NO se filtra por esto, porque existe precisamente para
   * pescar comprobantes de viajes TODAVÍA abiertos.
   */
  liquidacionFirmada: boolean;
  // ── RE-AUDITORÍA 25, FIS-REAUD-2 (CRÍTICO) ──────────────────────────────
  // Las 7 causas de `SIN_IVA_ACREDITABLE` (engine.ts) que `ivaSostenible` no
  // juzgaba: `rfc_receptor`, `rfc_receptor_no_verificable`,
  // `moneda_extranjera`, `renglones_ajenos`, `consumo_bar`,
  // `complemento_hidrocarburos` y `gasto_otro_ejercicio`. Ya vienen
  // PRE-JUZGADAS (booleano/valor, no el JSON crudo) para que `ivaSostenible`
  // se lea igual sobre un comprobante suelto o sobre una celda: quien las
  // llena (`aGastoFiscal` para una celda; un caller directo para un
  // comprobante suelto, como ya hace `plazoVencido`) es quien tiene el
  // contexto para calcularlas una sola vez.
  /** El RFC del RECEPTOR del CFDI (`rfcReceptor` en engine.ts/`Gasto`; no
   *  confundir con `rfcEmisor`, arriba). `null` = no se pudo leer. */
  rfcReceptor: string | null;
  /** `ocr_extra.moneda` presente y distinta de 'MXN' (DAT-19). */
  monedaExtranjera: boolean;
  /** El ticket es una canasta mixta cuyas partidas ajenas al viaje suman
   *  ≥ `UMBRAL_RENGLONES_AJENOS` del total (mismo umbral que engine.ts). */
  renglonesAjenos: boolean;
  /** `pareceBar` (engine.ts, LISR 28-XX): alimentación cuyo emisor/producto
   *  leído hace match con `SENAL_BAR`. */
  consumoBar: boolean;
  /**
   * El CFDI de combustible NO trae el complemento de hidrocarburos exigido
   * (regla 2.7.1.48 RMF) — el veredicto DURO de `engine.ts` (NIVEL 2, con
   * XML verificado y fecha de exigibilidad respaldada por ficha). Mientras
   * `NORMAS['rmf-2026-2.7.1.48'].exigibleDesde` siga en `null`, esto es
   * siempre `false` (el motor tampoco lo declara no deducible) — el
   * interruptor real vive en la ficha, no aquí.
   */
  complementoHidrocarburosFalta: boolean;
  /** El comprobante está fechado en un ejercicio ANTERIOR al corriente
   *  (mismo criterio que `fechaDudosa` → 'otro_ejercicio', con la tolerancia
   *  de enero para el cierre de año). */
  otroEjercicio: boolean;
  /**
   * Presente cuando la fila es una CELDA AGREGADA (mig. 0151): representa
   * `celda.n` comprobantes con EXACTAMENTE las mismas dimensiones fiscales
   * (concepto, clave, forma de pago, estado SAT, EFOS, con/sin CFDI, con/sin
   * desglose de IVA, sobre/bajo el tope de efectivo, plazo del comercio…).
   * En una celda `monto`, `ivaTraslado`, `iepsTraslado` y `subTotal` son
   * SUMAS; `id`/`cfdiUuid` son los de UN comprobante de muestra; `viajeId`,
   * `folio`, `viajeFolio` y `operadorNombre` no existen (la celda cruza
   * viajes). Ausente = un comprobante individual, como siempre.
   */
  celda?: CeldaFiscal;
}

/**
 * Lo que una celda sabe además de sus dimensiones — las sumas y los conteos
 * que la ley de abajo necesita para pesar la celda como si fueran sus `n`
 * comprobantes, uno por uno.
 */
export interface CeldaFiscal {
  /** Comprobantes que la celda representa (≥ 1). */
  n: number;
  /**
   * `monto > efectivoTopeMxn` evaluado FILA POR FILA en SQL con el tope que
   * mandó el llamador (config del tenant). La REGLA (LISR 27-III: efectivo
   * no combustible sobre el tope no deduce) sigue en `causasDe`; SQL solo
   * partió las filas en dos montones. Sobre la SUMA de una celda no se puede
   * evaluar: $3,000 en tres tickets de $1,000 no rebasan un tope de $2,000.
   */
  sobreTopeEfectivo: boolean;
  /** `nulo` = sin desglose; `positivo` = iva > 0; `no_positivo` = iva ≤ 0. Homogéneo por celda. */
  ivaEstado: 'nulo' | 'positivo' | 'no_positivo';
  /** Cuántos de los `n` no traen `ieps_traslado`. */
  iepsNulos: number;
  /** Cuántos de los `n` no traen `sub_total` (la base de casetas que no se afirma). */
  subTotalNulos: number;
  /**
   * Solo en celdas de alimentación TIMBRADA de un (viaje, día) cuyo total
   * timbrado rebasa el tope de LISR 28-V: el total timbrado de ESE día. La
   * proporción `min(1, tope/total)` la calcula `resumirFiscal` con el mismo
   * `diasSobreTope` del motor — SQL no conoce la fórmula, solo partió esos
   * días en celdas propias. `null` = la celda deduce entera (p = 1).
   */
  totalTimbradoDia: number | null;
}

/** Cuántos comprobantes pesa una fila: `n` si es celda, 1 si es un comprobante. */
function pesoDe(g: GastoFiscal): number {
  return g.celda ? g.celda.n : 1;
}

/**
 * La forma de pago que se puede JUZGAR — la misma idea que `formaPagoJuzgable`
 * en cuadre/engine.ts (FIS-1/FIS-5): `'99 Por definir'` no es un medio, es la
 * ausencia de uno (RMF 2.7.1.29 fr. II). Con el REP ingerido, el medio real es
 * su `FormaDePagoP`; sin él, `null` = «no opino» — desconocido no es «medio
 * distinto» ni «efectivo».
 *
 * AUDITORÍA 24, FIS-7 (MEDIO): este módulo era ciego al complemento de pago
 * y el mismo UUID daba $0 en «IVA acreditable documentado» y $8,000 en el PDF.
 */
export function formaPagoEfectiva(g: Pick<GastoFiscal, 'formaPago' | 'pagado' | 'pagadoForma'>): string | null {
  if (g.formaPago !== FORMA_PAGO_SIN_PAGAR) return g.formaPago;
  return g.pagado ? (g.pagadoForma ?? null) : null;
}

/**
 * LISR 27-III, el único juicio POR MONTO de la ley: sobre un comprobante se
 * compara aquí; sobre una celda se lee la partición que SQL hizo con el MISMO
 * tope (ver `CeldaFiscal.sobreTopeEfectivo`).
 */
function sobreTopeEfectivo(g: GastoFiscal, o: OpcionesFiscales): boolean {
  return g.celda ? g.celda.sobreTopeEfectivo : g.monto > o.efectivoTopeMxn;
}

/**
 * AUDITORÍA 22, FIS-C3 (CRÍTICO) — el hermano de `sobreTopeEfectivo` que
 * faltaba. La lista del primer párrafo de la LISR 27-III es CERRADA; el panel
 * medía la frontera como «¿es '01'?», así que `'06' Dinero electrónico`,
 * `'08' Vales`, `'12' Dación en pago`, `'17' Compensación`, `'23' Novación` y
 * `'99 Por definir'` pasaban como deducibles con su IVA.
 *
 * DEBE espejar exactamente `engine.ts` (misma lista, mismo tope, mismas dos
 * exclusiones): el motor y el panel del contador que discrepan sobre el mismo
 * CFDI son dos cálculos, y esa es la falla que el producto no puede permitirse.
 *
 * - `'01'` NO entra: tiene su propia causa (`efectivo_sobre_tope`, perdida).
 * - Sin `formaPago` NO entra: desconocido no es «medio distinto».
 * - Combustible NO entra: lo gobierna la RFA 2.9 con su propia matriz.
 */
function medioFueraDeLista27III(g: GastoFiscal, o: OpcionesFiscales): boolean {
  const forma = formaPagoEfectiva(g);
  if (!forma || forma === '01') return false;
  if (esCombustible(g, o)) return false;
  if (!sobreTopeEfectivo(g, o)) return false;
  return !(MEDIOS_LISR_27_III as readonly string[]).includes(forma);
}

// ── Periodo ────────────────────────────────────────────────────────────────

export type ClavePeriodo = 'mes' | 'mes_anterior' | 'ejercicio' | 'todo';

export interface Periodo {
  clave: ClavePeriodo;
  /** ISO `YYYY-MM-DD` inclusive. `null` en 'todo'. */
  desde: string | null;
  /** ISO `YYYY-MM-DD` inclusive. `null` en 'todo'. */
  hasta: string | null;
  /** Lo que se imprime en pantalla. Tiene que describir el filtro REAL. */
  etiqueta: string;
}

const CLAVES: ClavePeriodo[] = ['mes', 'mes_anterior', 'ejercicio', 'todo'];

/** El periodo que se asume sin `?p=` en la URL. */
export const PERIODO_POR_DEFECTO: ClavePeriodo = 'ejercicio';

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function ultimoDia(anio: number, mes0: number): string {
  const d = new Date(Date.UTC(anio, mes0 + 1, 0));
  return d.toISOString().slice(0, 10);
}

function primerDia(anio: number, mes0: number): string {
  return `${anio}-${String(mes0 + 1).padStart(2, '0')}-01`;
}

/**
 * Traduce `?p=` a un rango de fechas cerrado, con su rótulo.
 *
 * `hoy` se inyecta por la misma razón que en `calcularCaducidad`: una prueba
 * de periodos no puede depender del reloj de la máquina que la corre.
 *
 * El rótulo se construye AQUÍ, junto al rango, y no en la página. Cuando eran
 * dos cosas separadas el encabezado decía "del periodo" sobre una consulta sin
 * filtro — el hallazgo que `corteVentana` en `analytics.ts` ya documentó.
 */
export function resolverPeriodo(crudo: string | undefined, hoy: string): Periodo {
  const clave: ClavePeriodo = CLAVES.includes(crudo as ClavePeriodo)
    ? (crudo as ClavePeriodo)
    : PERIODO_POR_DEFECTO;

  const [a, m] = hoy.split('-').map(Number);
  const anio = a;
  const mes0 = m - 1;

  if (clave === 'todo') {
    return { clave, desde: null, hasta: null, etiqueta: 'Todo el histórico' };
  }
  if (clave === 'ejercicio') {
    return {
      clave,
      desde: `${anio}-01-01`,
      hasta: `${anio}-12-31`,
      etiqueta: `Ejercicio ${anio}`,
    };
  }
  const refAnio = clave === 'mes_anterior' && mes0 === 0 ? anio - 1 : anio;
  const refMes = clave === 'mes_anterior' ? (mes0 === 0 ? 11 : mes0 - 1) : mes0;
  return {
    clave,
    desde: primerDia(refAnio, refMes),
    hasta: ultimoDia(refAnio, refMes),
    etiqueta: `${MESES[refMes]} ${refAnio}`,
  };
}

/**
 * LA VENTANA DE «LITROS ELEGIBLES PARA EL ESTÍMULO» (LIF 2026, 20-A), EN UN
 * SOLO SITIO — con su rótulo.
 *
 * AUDITORÍA 24, FE-8 (ALTO): la MISMA cifra fiscal se medía con dos ventanas
 * distintas en dos pantallas. `contador/inicio-contador.tsx` la pedía con
 * `diasEjercicio` (el ejercicio en curso) y lo rotulaba;
 * `combustible-casetas/page.tsx` y `chat/page.tsx` la pedían SIN ventana
 * —`corteVentana(undefined) = null`, o sea el histórico completo— y la
 * rotulaban «Litros elegibles para el estímulo · LIF 2026, Art. 20-A», sin
 * periodo. El contralor ve dos litrajes bajo la misma cita legal: «una cifra
 * fiscal que se lee distinto en dos pantallas se lee como dos cálculos».
 *
 * El estímulo del 20-A se acredita CONTRA EL EJERCICIO, así que la ventana
 * correcta es la del ejercicio en curso; el histórico completo suma litros de
 * años ya declarados. Aquí va el cálculo Y el rótulo juntos, por la misma
 * razón que en `resolverPeriodo`: cuando eran dos cosas separadas, una
 * pantalla decía un periodo y consultaba otro.
 *
 * `dias` es lo que `getAcreditables(tenantId, dias)` espera (`corteVentana`
 * cuenta el día de hoy dentro, de ahí el `+ 1`).
 */
export function ventanaLitrosElegibles(hoy: string): {
  periodo: Periodo;
  dias: number;
  rotulo: string;
  nota: string;
} {
  const periodo = resolverPeriodo('ejercicio', hoy);
  const desde = periodo.desde ?? `${hoy.slice(0, 4)}-01-01`;
  const dias = Math.floor((Date.parse(`${hoy}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000) + 1;
  return {
    periodo,
    dias,
    rotulo: 'Litros elegibles para el estímulo',
    // La ventana VA EN EL RÓTULO, no en un comentario del código: es la regla
    // «toda ventana declarada en el rótulo».
    nota: `LIF 2026, Art. 20-A — ${periodo.etiqueta.toLowerCase()}, del ${desde} a hoy`,
  };
}

/**
 * El periodo INMEDIATAMENTE anterior al dado, para el comparativo.
 *
 * `null` cuando la comparación no tiene sentido ('todo' no tiene un "antes").
 * Devolver un rango vacío en su lugar produciría un −100% que se leería como
 * una caída medida.
 */
export function periodoAnterior(p: Periodo): Periodo | null {
  if (p.clave === 'todo' || !p.desde) return null;
  const [a, m] = p.desde.split('-').map(Number);
  if (p.clave === 'ejercicio') {
    return {
      clave: 'ejercicio',
      desde: `${a - 1}-01-01`,
      hasta: `${a - 1}-12-31`,
      etiqueta: `Ejercicio ${a - 1}`,
    };
  }
  const mes0 = m - 1;
  const anteriorAnio = mes0 === 0 ? a - 1 : a;
  const anteriorMes = mes0 === 0 ? 11 : mes0 - 1;
  return {
    clave: p.clave,
    desde: primerDia(anteriorAnio, anteriorMes),
    hasta: ultimoDia(anteriorAnio, anteriorMes),
    etiqueta: `${MESES[anteriorMes]} ${anteriorAnio}`,
  };
}

// ── Opciones fiscales (salen de la config del tenant, nunca hardcodeadas) ──

export interface OpcionesFiscales {
  /** LISR 27-III: tope de un gasto NO combustible pagado en efectivo. */
  efectivoTopeMxn: number;
  /** c_ClaveProdServ que cuentan como combustible (RFA 2026 regla 2.9). */
  clavesCombustible: string[];
  /** c_ClaveProdServ con estímulo de IEPS: SOLO diésel (LIF 2026 20-A-IV). */
  clavesDieselIeps: string[];
  /** LISR 28-V: tope diario de alimentación. `null` = tenant sin tope
   *  configurado, y entonces tampoco se prorratea — el MISMO interruptor con
   *  el que el motor decide si aplica la regla (`topeAlimentacion != null`). */
  viaticosTopeFiscalDiarioMxn: number | null;
  /** RFA 2026 regla 2.9: ¿la flota califica a la facilidad del 15%?
   *  true = declaró dedicación exclusiva + régimen; false = declaró que NO;
   *  undefined = sin declarar. AUDITORÍA 14, ALTO: sin esto el panel ofrecía
   *  la válvula a flotas que el motor declara no elegibles. */
  elegible15?: boolean;
  /**
   * AUDITORÍA 25, FIS-C1/FIS-C2/ARQ-C1 (CRÍTICO). El acumulado REAL del
   * ejercicio para el cubo del 15% (RFA 2026 regla 2.9) — el MISMO que
   * `desde_db.ts` le manda al motor (`getAcumuladoCombustible`). Sin esto el
   * panel no tiene con qué partir el IVA del diésel en efectivo y el
   * comprobante se acreditaba COMPLETO así el motor ya lo hubiera negado.
   * `undefined` = no se pudo anclar el periodo a UN solo ejercicio (o la
   * consulta falló): el panel NO acredita ese diésel en vez de adivinar
   * (`proporcionCombustible15`, fail closed).
   */
  combustibleEjercicio?: { efectivo: number; totalCombustible: number };
  /**
   * RE-AUDITORÍA 25, FIS-REAUD-2 (CRÍTICO). RFCs propios de la flota,
   * normalizados y validados — MISMO criterio que `rfcsOk` en engine.ts
   * (descarta el genérico del SAT y cualquiera que no pase el dígito
   * verificador). Vacío/`undefined` = ningún RFC utilizable: `ivaSostenible`
   * entonces solo mira `empresaRfcConfigurado` para decidir si el receptor
   * es "no verificable" o si la validación se salta por completo (sin RFC
   * capturado, como hace engine.ts).
   */
  rfcsPropios?: Set<string>;
  /** ¿El tenant declaró ALGÚN RFC de empresa (aunque no sirva)? Distingue
   *  "sin capturar" (no se juzga el receptor, como engine.ts) de "capturado
   *  y no sirve" (rfc_receptor_no_verificable). */
  empresaRfcConfigurado?: boolean;
  /**
   * RE-AUDITORÍA 25, FIS-REAUD-2. Complemento de hidrocarburos (RMF
   * 2.7.1.48): `vigenteDesde` es el filtro de ruido (desde cuándo se MIRA,
   * `config.ts:hidrocarburos.vigenteDesde`) y `exigibleDesde` es la fecha
   * que DECIDE dinero, resuelta igual que `engine.ts` (`NORMAS` si la config
   * no la declara). `undefined`/`null` en `exigibleDesde` = el motor NUNCA
   * declara `complemento_hidrocarburos` todavía, y el panel tampoco.
   */
  hidrocarburosVigenteDesde?: string;
  hidrocarburosExigibleDesde?: string | null;
}

/**
 * El acumulado del ejercicio para el cubo del 15% (RFA 2026 regla 2.9),
 * anclado al MISMO año que `getAcumuladoCombustible` usa en `desde_db.ts`.
 *
 * El tope es del EJERCICIO, no del periodo que se está mirando: un mes por
 * sí solo no dice si la flota va holgada o al límite. Solo hay un ejercicio
 * que declarar cuando el periodo cae DENTRO de un único año calendario —
 * 'mes', 'mes_anterior' y 'ejercicio' siempre caen; 'todo' (`desde` nulo) o
 * un rango que cruza el 31 de diciembre no, y entonces se devuelve
 * `undefined` a propósito: mejor no acreditar ese diésel que adivinar contra
 * un ejercicio que no es el suyo.
 *
 * Best-effort como el resto de este contador (`desde_db.ts` hace lo mismo):
 * un fallo de la RPC no puede tumbar el panel entero, solo esta cifra.
 */
export async function combustibleEjercicioDe(
  tenantId: string,
  periodo: Pick<Periodo, 'desde' | 'hasta'>,
  clavesCombustible: string[],
): Promise<{ efectivo: number; totalCombustible: number } | undefined> {
  const anio = periodo.desde?.slice(0, 4);
  if (!anio || anio !== periodo.hasta?.slice(0, 4)) return undefined;
  try {
    return await getAcumuladoCombustible(tenantId, Number(anio), clavesCombustible);
  } catch (e) {
    logger.warn('fiscal.combustible_ejercicio_no_disponible', {
      tenantId, err: e instanceof Error ? e.message : String(e),
    });
    return undefined;
  }
}

/** `opcionesDe(cfg)` más el acumulado del ejercicio (ver `combustibleEjercicioDe`). */
export async function opcionesFiscalesDelPeriodo(
  tenantId: string,
  periodo: Periodo,
  cfg: LikidaConfig,
): Promise<OpcionesFiscales> {
  const o = opcionesDe(cfg);
  return { ...o, combustibleEjercicio: await combustibleEjercicioDe(tenantId, periodo, o.clavesCombustible) };
}

/**
 * Qué fracción del IVA de combustible pagado en efectivo (o con un medio que
 * la LISR 27-III no admite) sostiene el acreditamiento — la misma pregunta
 * que `proporcionesDeducibles` (`cuadre/engine.ts`) resuelve por comprobante
 * DENTRO de un viaje, aquí resuelta en AGREGADO sobre el ejercicio completo.
 *
 * Por qué el agregado reproduce la cifra del motor al centavo (y no una
 * aproximación): la asignación del motor es `dentro_i = min(monto_i,
 * tope − previoAcumulado)`, y la SUMA de `dentro_i` sobre cualquier orden de
 * comprobantes es siempre `min(efectivoTotal, tope)` — es aritmética de un
 * acumulador con techo, no depende de en qué orden se cerraron los viajes.
 * Con eso, tratar TODO el efectivo del ejercicio como un solo comprobante
 * sintético y pasarlo por `proporcionesDeducibles` da la MISMA proporción
 * agregada que sumar el resultado real del motor viaje por viaje — exacta
 * cuando `gastos` cubre el ejercicio completo (periodo 'ejercicio', el panel
 * por omisión); una estimación ponderada por el resto de los periodos, que
 * siguen siendo mejores que el `?? 1` que acreditaba el IVA completo.
 */
function proporcionCombustible15(o: OpcionesFiscales): number {
  if (!o.combustibleEjercicio) return 0;
  const { efectivo, totalCombustible } = o.combustibleEjercicio;
  if (!(efectivo > 0)) return 0;
  const tope = 0.15 * Math.max(0, totalCombustible);
  const excedente = Math.max(0, efectivo - tope);
  const mapa = proporcionesDeducibles(
    [{ id: '__ejercicio__', concepto: 'diesel', monto: efectivo }],
    [{ tipo: 'efectivo_sobre_15', gastoId: '__ejercicio__', monto: excedente, esperado: excedente }],
  );
  return mapa.get('__ejercicio__') ?? 0;
}

/**
 * Movida de `dashboard/contador/comun.tsx` el 10-ago-2026: ese panel se borró
 * (rediseño desde cero), pero `dashboard/page.tsx` (Resumen) también la
 * necesita para su Motor fiscal — vivía en un archivo de página en vez de en
 * la capa de datos, así que borrar el panel se la hubiera llevado entre pies.
 */
export function opcionesDe(cfg: LikidaConfig): OpcionesFiscales {
  const f15 = cfg.facilidadCombustibleEfectivo;
  return {
    efectivoTopeMxn: cfg.estimulos.efectivoTopeMxn,
    clavesCombustible: cfg.hidrocarburos.claves,
    clavesDieselIeps: cfg.estimulos.clavesDieselIeps,
    // `?? null` y no un default: si la config del tenant perdió el tope, el
    // motor tampoco lo aplica (lee con `!= null`) — inventar $750 aquí haría
    // que el panel prorratee un tope que la liquidación no aplicó.
    viaticosTopeFiscalDiarioMxn: cfg.estimulos.viaticosTopeFiscalDiarioMxn ?? null,
    // AUDITORÍA 14, ALTO: el panel ofrecía el 15% a flotas no elegibles. La
    // declaración de la flota (al registrarse) llega hasta aquí.
    elegible15: (f15 && f15.dedicacionExclusivaCarga !== undefined && f15.regimenElegible !== undefined)
      ? (f15.dedicacionExclusivaCarga === true && f15.regimenElegible === true)
      : undefined,
    // RE-AUDITORÍA 25, FIS-REAUD-2: el MISMO conjunto que `cuadrarViaje`
    // calcula para validar el receptor — importado, no reinventado.
    rfcsPropios: rfcsUtilizablesDe(cfg.empresa.rfc, cfg.empresa.rfcsAdicionales),
    empresaRfcConfigurado: !!cfg.empresa.rfc,
    hidrocarburosVigenteDesde: cfg.hidrocarburos.vigenteDesde,
    // Mismo criterio de resolución que `engine.ts`: la config puede fijar su
    // propia `exigibleDesde`; sin ella, la ficha de `NORMAS` decide (hoy: null).
    hidrocarburosExigibleDesde: NORMAS['rmf-2026-2.7.1.48']?.exigibleDesde ?? null,
  };
}

// ── Deducibilidad por comprobante ──────────────────────────────────────────

export type CausaPerdida =
  /** El PORTAL del comercio cerró su plazo (política de nivel 6, no la ley):
   *  el derecho legal de exigir la factura vive todo el ejercicio. */
  | 'plazo_vencido'
  /** El emisor canceló el CFDI. */
  | 'cfdi_cancelado'
  /** Emisor en la lista definitiva del 69-B. */
  | 'efos'
  /** El SAT devolvió un código EFOS no concluyente. */
  | 'efos_indeterminado'
  /** Efectivo sobre el tope, gasto NO combustible (LISR 27-III). */
  | 'efectivo_sobre_tope'
  /** Sobre el tope con una forma de pago FUERA de la lista cerrada de LISR 27-III. */
  | 'medio_pago_no_admitido'
  /** Combustible en efectivo: cuenta contra el 15% (RFA 2026 regla 2.9). */
  | 'combustible_efectivo'
  /** La flota no califica a la facilidad del 15% (RFA 2.9) — no deducible. */
  | 'efectivo_no_elegible'
  /** Sin CFDI pero el plazo del comercio sigue abierto. */
  | 'sin_cfdi';

export type Gravedad =
  /** El dinero ya no se recupera. */
  | 'perdida'
  /** Depende de algo que todavía puede moverse (el 15%, una aclaración, la
   *  Conciliación de Factura del SAT). */
  | 'en_riesgo'
  /** Con una gestión se recupera: pedir la factura antes de que venza. */
  | 'recuperable';

export interface Causa {
  causa: CausaPerdida;
  gravedad: Gravedad;
  titulo: string;
  /** La ficha de `normas/` que la sostiene. Sin ficha no se afirma. */
  norma: string;
  detalle: string;
}

/** Exportado para el guardia de exhaustividad de `ORDEN` (AUD20 FISC-C2): es
 *  `Record<CausaPerdida, …>`, así que sus llaves son el union completo. */
export const TITULOS: Record<CausaPerdida, Omit<Causa, 'causa'>> = {
  // AUD3 FI-A2, ALTO: esto era `gravedad: 'perdida'` y el KPI lo sumaba a
  // "monto perdido". La ficha `normas/politica-portales-plazos.yaml`
  // (jerarquía 6) dice lo contrario: el plazo del portal "tiene CERO fuerza
  // legal" y "el plazo LEGAL para pedir factura es todo el ejercicio" — y el
  // motor, sobre el mismo ticket, imprime "legalmente puedes exigirlo dentro
  // del ejercicio" (engine.ts, rama vencida). Dar por perdida una deducción
  // que la Conciliación de Factura recupera es confundir nivel 6 con
  // obligación fiscal: el error más caro del dominio (normas/README.md).
  plazo_vencido: {
    gravedad: 'en_riesgo',
    titulo: 'Plazo del comercio vencido',
    norma: 'LISR 27-III',
    detalle: 'El portal del comercio cerró su plazo — política del comercio, no la ley. El derecho legal vive todo el ejercicio: recuperarlo exige pedir la factura directo al emisor (Conciliación de Factura del SAT). Sin CFDI al cierre, no ampara deducción ni acredita IVA.',
  },
  cfdi_cancelado: {
    gravedad: 'perdida',
    titulo: 'CFDI cancelado',
    norma: 'CFF 29-A',
    detalle: 'Un comprobante cancelado no ampara la deducción. Hay que pedirle al emisor uno de reemplazo.',
  },
  efos: {
    gravedad: 'perdida',
    titulo: 'Emisor en lista EFOS (69-B)',
    norma: 'CFF 69-B',
    detalle: 'Publicado en la lista definitiva: la operación se presume inexistente y el comprobante no produce efecto fiscal.',
  },
  efos_indeterminado: {
    gravedad: 'en_riesgo',
    titulo: 'Emisor con señal EFOS no concluyente',
    norma: 'CFF 69-B',
    detalle: 'El SAT no respondió de forma concluyente. No se afirma que sea EFOS; se marca para que alguien lo revise.',
  },
  efectivo_sobre_tope: {
    gravedad: 'perdida',
    titulo: 'Pagado en efectivo sobre el tope',
    norma: 'LISR 27-III',
    detalle: 'Gasto no-combustible pagado en efectivo por encima del tope: no es deducible aunque tenga CFDI.',
  },
  medio_pago_no_admitido: {
    gravedad: 'en_riesgo',
    titulo: 'Forma de pago fuera de la lista de la LISR 27-III',
    norma: 'LISR 27-III',
    detalle: 'Sobre el tope, la fracción admite una lista cerrada: transferencia, cheque nominativo, tarjeta de crédito/débito/servicios o monedero autorizado. Esta forma de pago no está en ella. No se afirma perdido —hay criterio en disputa para dación en pago, compensación y novación—: lo confirma tu contador.',
  },
  combustible_efectivo: {
    gravedad: 'en_riesgo',
    titulo: 'Combustible pagado en efectivo',
    norma: 'RFA 2026 regla 2.9',
    detalle: 'Cuenta contra el 15% del combustible del ejercicio. Dentro del 15% sigue siendo deducible; el excedente no. No acredita IEPS en ningún caso.',
  },
  efectivo_no_elegible: {
    gravedad: 'perdida',
    titulo: 'Combustible en efectivo sin facilidad',
    norma: 'LISR 27-III / RFA 2026 regla 2.9',
    detalle: 'La flota no califica a la facilidad del 15% (dedicación exclusiva o régimen no declarados), así que el efectivo en combustible no es deducible aunque tenga CFDI.',
  },
  sin_cfdi: {
    gravedad: 'recuperable',
    titulo: 'Sin CFDI todavía',
    norma: 'LISR 27-III',
    detalle: 'El ticket todavía se puede timbrar. Es deducción pendiente, no perdida — mientras no venza el plazo del comercio.',
  },
};

/** ¿El comprobante es de combustible, para la regla del 15%? */
export function esCombustible(g: GastoFiscal, o: OpcionesFiscales): boolean {
  return g.concepto === 'diesel' || o.clavesCombustible.includes(g.claveProdServ ?? '');
}

/** ¿Trae el estímulo de IEPS? Solo diésel — la gasolina NO (LIF 20-A-IV). */
export function esDieselConIeps(g: GastoFiscal, o: OpcionesFiscales): boolean {
  return o.clavesDieselIeps.includes(g.claveProdServ ?? '');
}

/**
 * TODAS las causas que aplican a un comprobante, de la más grave a la menos.
 *
 * Un mismo gasto puede tener varias (sin CFDI *y* pagado en efectivo sobre el
 * tope). Se devuelven todas porque el contador necesita las dos para saber
 * qué gestionar, pero el dinero se cuenta UNA sola vez — de eso se encarga
 * `resumirPerdidas` con la dominante.
 *
 * `sin_cfdi` y `plazo_vencido` son excluyentes: son el mismo hecho en dos
 * momentos. Emitir las dos duplicaría la fila en la pantalla.
 */
export function causasDe(g: GastoFiscal, o: OpcionesFiscales): Causa[] {
  const out: Causa[] = [];
  const push = (c: CausaPerdida) => out.push({ causa: c, ...TITULOS[c] });

  if (g.efos === true) push('efos');
  else if (g.efosRevisar === true) push('efos_indeterminado');

  if (g.estadoSat === 'cancelado') push('cfdi_cancelado');

  if (!g.cfdiUuid) {
    // `plazoVencido === null` es "no se sabe": se trata como recuperable —el
    // camino que le pide a alguien que lo revise— en vez de darlo por vencido.
    if (g.plazoVencido === true) push('plazo_vencido');
    else push('sin_cfdi');
  }

  // El medio de pago solo se juzga cuando se conoce. Un gasto sin `forma_pago`
  // NO se cuenta como efectivo: suponerlo inflaría el numerador contra la
  // flota (mismo criterio que `getAcumuladoCombustible` en repo.ts).
  // AUDITORÍA 18-c3, FISC-C3-1 (CRÍTICO): para COMBUSTIBLE la frontera no es
  // "es '01'" sino "no está en la lista cerrada de la LISR 27-III" — la RFA 2.9
  // define el cubo del 15% por exclusión. `medioNoAdmitidoCombustible` es el
  // MISMO predicado que usa el motor, importado a propósito: si el panel se
  // escribe su copia, vuelven las dos cifras sobre el mismo comprobante.
  if (esCombustible(g, o)) {
    if (medioNoAdmitidoCombustible(formaPagoEfectiva(g))) {
      // AUDITORÍA 14-15, ALTO: mismo estándar que el motor — pero SIN DECLARAR
      // (elegible15 undefined) NO es "deducción perdida": el motor lo mantiene
      // "por confirmar" y el panel debe decir lo mismo (en_riesgo), no perdido.
      if (o.elegible15 === false) push('efectivo_no_elegible');
      else push('combustible_efectivo');
    }
    // El tope de efectivo NO aplica al combustible: su frontera es la lista de
    // la LISR 27-III, arriba. `sobreTopeEfectivo` (de master) prefiere la celda
    // que ya calculó el motor sobre recalcular el monto aquí.
  } else if (formaPagoEfectiva(g) === '01' && sobreTopeEfectivo(g, o)) {
    push('efectivo_sobre_tope');
  } else if (medioFueraDeLista27III(g, o)) {
    push('medio_pago_no_admitido');
  }

  return out;
}

/**
 * La causa por la que este comprobante se contabiliza — una sola, para que la
 * suma por causa siga cuadrando con el total.
 *
 * El orden es por GRAVEDAD DEL DINERO, no por el orden en que se detectan:
 * primero lo que ya no se recupera, luego lo que está en riesgo, al final lo
 * que basta con gestionar.
 */
// `plazo_vencido` bajó del grupo de pérdidas al de riesgo (AUD3 FI-A2): un
// ticket sin CFDI con el portal cerrado cuesta una gestión ante el emisor,
// no el dinero — así que una pérdida dura (efectivo sobre el tope) le gana
// la dominancia.
// AUDITORÍA 20, FISC-C2 (CRÍTICO): faltaba `efectivo_no_elegible`, el cuarto y
// último miembro con `gravedad: 'perdida'`. Al no estar en la lista, un diésel
// en efectivo de una flota que YA declaró NO calificar a la RFA 2.9 quedaba
// dominado por `sin_cfdi` (`recuperable`) y se imprimía en el KPI verde
// "Recuperable pidiendo factura". Va con las pérdidas duras, junto a
// `efectivo_sobre_tope`: son el mismo hecho —efectivo que la LISR 27-III no
// admite— con y sin la facilidad del 15%.
export const ORDEN: CausaPerdida[] = [
  'efos', 'cfdi_cancelado', 'efectivo_sobre_tope', 'efectivo_no_elegible',
  'efos_indeterminado', 'plazo_vencido', 'combustible_efectivo', 'medio_pago_no_admitido', 'sin_cfdi',
];

export function causaDominante(g: GastoFiscal, o: OpcionesFiscales): Causa | null {
  const cs = causasDe(g, o);
  if (!cs.length) return null;
  for (const clave of ORDEN) {
    const hit = cs.find((c) => c.causa === clave);
    if (hit) return hit;
  }
  return cs[0];
}

export interface FilaPerdida {
  gasto: GastoFiscal;
  dominante: Causa;
  /** Todas las causas, para que la fila las pueda enseñar juntas. */
  causas: Causa[];
}

export interface ResumenPerdidas {
  /** Cuánto dinero de gasto está tocado por alguna causa. */
  montoTotal: number;
  /** Lo que ya no se recupera. */
  montoPerdido: number;
  /** Lo que depende de algo que todavía se puede mover. */
  montoEnRiesgo: number;
  /** Lo que se recupera pidiendo la factura. */
  montoRecuperable: number;
  /**
   * IVA que se puede AFIRMAR que se pierde: solo el de comprobantes que SÍ
   * traen el desglose. Nunca una estimación del 16% sobre un total.
   */
  ivaPerdidoDocumentado: number;
  /** Cuántos comprobantes tocados no traen desglose de IVA que citar. */
  sinDesgloseDeIva: number;
  porCausa: Array<{ causa: CausaPerdida; titulo: string; gravedad: Gravedad; norma: string; detalle: string; n: number; monto: number }>;
  /** Ordenadas por monto descendente: lo que más pesa, arriba. */
  filas: FilaPerdida[];
  /** Comprobantes que no se pudieron juzgar por falta de `forma_pago`. */
  sinFormaPago: number;
  /** Comprobantes sin `fecha`: quedan fuera de cualquier corte por periodo. */
  sinFecha: number;
}

export function resumirPerdidas(gastos: GastoFiscal[], o: OpcionesFiscales): ResumenPerdidas {
  const filas: FilaPerdida[] = [];
  for (const g of gastos) {
    const causas = causasDe(g, o);
    if (!causas.length) continue;
    const dominante = causaDominante(g, o)!;
    filas.push({ gasto: g, dominante, causas });
  }
  filas.sort((a, b) => b.gasto.monto - a.gasto.monto);

  const porCausaMapa = new Map<CausaPerdida, { n: number; monto: number }>();
  let montoPerdido = 0, montoEnRiesgo = 0, montoRecuperable = 0;
  let ivaPerdidoDocumentado = 0, sinDesgloseDeIva = 0;

  for (const f of filas) {
    // Una celda pesa sus `n` comprobantes: las causas son las mismas para
    // todos (la celda es homogénea en cada dimensión que `causasDe` mira) y
    // el monto ya viene sumado.
    const peso = pesoDe(f.gasto);
    const prev = porCausaMapa.get(f.dominante.causa) ?? { n: 0, monto: 0 };
    porCausaMapa.set(f.dominante.causa, { n: prev.n + peso, monto: prev.monto + f.gasto.monto });
    if (f.dominante.gravedad === 'perdida') montoPerdido += f.gasto.monto;
    else if (f.dominante.gravedad === 'en_riesgo') montoEnRiesgo += f.gasto.monto;
    else montoRecuperable += f.gasto.monto;

    // EL IVA SOLO SE SUMA SI EL COMPROBANTE LO DESGLOSA. Estimarlo al 16%
    // sobre el total daría una cifra que el contador teclea en su declaración
    // y que no está en ningún papel.
    if (f.gasto.ivaTraslado !== null && f.gasto.ivaTraslado > 0) ivaPerdidoDocumentado += f.gasto.ivaTraslado;
    else sinDesgloseDeIva += peso;
  }

  const porCausa = ORDEN
    .filter((c) => porCausaMapa.has(c))
    .map((c) => ({
      causa: c,
      titulo: TITULOS[c].titulo,
      gravedad: TITULOS[c].gravedad,
      norma: TITULOS[c].norma,
      detalle: TITULOS[c].detalle,
      n: porCausaMapa.get(c)!.n,
      monto: round2(porCausaMapa.get(c)!.monto),
    }))
    .sort((a, b) => b.monto - a.monto);

  return {
    montoTotal: round2(montoPerdido + montoEnRiesgo + montoRecuperable),
    montoPerdido: round2(montoPerdido),
    montoEnRiesgo: round2(montoEnRiesgo),
    montoRecuperable: round2(montoRecuperable),
    ivaPerdidoDocumentado: round2(ivaPerdidoDocumentado),
    sinDesgloseDeIva,
    porCausa,
    filas,
    sinFormaPago: gastos.filter((g) => !g.formaPago).reduce((s, g) => s + pesoDe(g), 0),
    sinFecha: gastos.filter((g) => !g.fecha).reduce((s, g) => s + pesoDe(g), 0),
  };
}

// ── El panel fiscal: IVA, IEPS, deducible / no deducible ───────────────────

export interface ResumenFiscal {
  /** Comprobantes leídos en el periodo. */
  n: number;
  /** Suma de `monto` — lo que salió de la caja, no la base gravable. */
  gastoTotal: number;
  /** Cuántos traen CFDI amarrado. */
  conCfdi: number;
  /** Cuántos NO traen CFDI. */
  sinCfdi: number;
  /**
   * IVA acreditable que se puede DOCUMENTAR: `iva_traslado` de comprobantes
   * con CFDI vigente, emisor limpio y gasto deducible (LIVA 5). En erogaciones
   * PARCIALMENTE deducibles (alimentación sobre el tope de LISR 28-V) entra
   * solo la proporción deducible — LIVA 5-I, el mismo criterio del motor.
   */
  ivaAcreditable: number;
  /**
   * IVA desglosado que NO se acredita: el de comprobantes que no lo sostienen
   * (motivo ya contado en perdidas) MÁS la porción no deducible del IVA de los
   * viáticos sobre el tope. Acreditable + no acreditable siguen sumando todo
   * el IVA desglosado — el contralor lo cruza con una calculadora.
   */
  ivaNoAcreditable: number;
  /**
   * Comprobantes CON CFDI pero SIN desglose de IVA leído. Su IVA existe en el
   * papel; aquí no se puede afirmar porque no se recibió el XML.
   */
  conCfdiSinDesglose: number;
  /** IEPS trasladado en CFDI de diésel con pago electrónico. */
  iepsDieselDocumentado: number;
  /** Base (SubTotal) de casetas — el 50% del estímulo se calcula sobre esto. */
  subTotalCasetas: number;
  /** Casetas sin `sub_total` leído: su base no se puede afirmar. */
  casetasSinSubTotal: number;
  /**
   * Comprobantes con CFDI que NUNCA se validaron contra el SAT
   * (`estado_sat` nulo). No es "inválido": es "no comprobado".
   */
  porValidar: number;
  /** Con CFDI y respuesta del SAT `vigente`. */
  vigentes: number;
  /** Con CFDI y respuesta del SAT `cancelado`. */
  cancelados: number;
  /**
   * RE-AUDITORÍA 25, FIS-REAUD-3 (ALTO). `true` = una parte de
   * `ivaAcreditable` pasó por el prorrateo del 15% de la RFA 2.9 calculado
   * contra el acumulado de combustible del ejercicio A HOY
   * (`combustibleEjercicioDe`/`proporcionCombustible15`). Cada liquidación
   * FIRMADA fijó su propio reparto contra el acumulado que existía AL
   * MOMENTO de cerrarse — uno más chico que el de hoy, casi siempre — así
   * que esta cifra puede "perdonar" retroactivamente un excedente que un PDF
   * más viejo ya negó. El llamador (el panel, la herramienta de chat) tiene
   * que decirlo en vez de imprimir el número solo: mismo espíritu que
   * `derivoLaConfig` en analytics.ts para el detalle de un viaje, adaptado a
   * un periodo con muchas liquidaciones en vez de una.
   */
  combustible15SujetoADeriva: boolean;
}

/**
 * ¿Este comprobante puede sostener el acreditamiento de su IVA?
 *
 * LIVA 5 pide, entre otros requisitos, que el gasto sea deducible para ISR y
 * que el impuesto esté trasladado EXPRESAMENTE y por separado. Se evalúa lo
 * que las columnas permiten evaluar: hay CFDI, no está cancelado, el emisor no
 * está en la lista definitiva del 69-B, y el gasto no cae en el efectivo sobre
 * tope. Lo que las columnas NO permiten evaluar (que sea estrictamente
 * indispensable) no se afirma ni se niega — es juicio del contador.
 */
function ivaSostenible(g: GastoFiscal, o: OpcionesFiscales): boolean {
  if (!g.cfdiUuid) return false;
  // RE-AUDITORÍA 25, FIS-REAUD-1 (CRÍTICO, reincidente de la 0308 por otra
  // puerta): sin una liquidación FIRMADA (aprobada|ajustada) sobre el viaje
  // de este comprobante, no hay liquidación que sostenga el requisito de
  // deducibilidad de LIVA 5 — mismo criterio que ya usa
  // `acreditables_liquidacion_tenant` (0308). Cubre viajes sin liquidación
  // todavía, liquidaciones pendientes de firma y liquidaciones rechazadas.
  if (!g.liquidacionFirmada) return false;
  if (g.estadoSat === 'cancelado') return false;
  if (g.estadoSat === 'pendiente' || g.estadoSat === 'no_encontrado') return false;
  if (g.efos === true) return false;
  if (formaPagoEfectiva(g) === '01' && !esCombustible(g, o) && sobreTopeEfectivo(g, o)) return false;
  // AUDITORÍA 22, FIS-C3: mismo hecho con otra forma de pago. Mientras el
  // contador no confirme, la proporción deducible es cero y LIVA 5-I no acredita.
  if (medioFueraDeLista27III(g, o)) return false;
  // Combustible con un medio que la LISR 27-III no admite.
  //
  // AUDITORÍA 14, ALTO puso esta puerta cerrada del todo, razonando que «la
  // facilidad del 15% solo salva la deducción de ISR». AUDITORÍA 22, FIS-C2
  // (CRÍTICO) la corrige leyendo las dos fichas: `rfa-2026-2.9.yaml` →
  // `limite_importante` dice «NO habilita el acreditamiento del IEPS» —dice
  // IEPS, no dice IVA—, y `liva-5.yaml` art. 5 fr. I ata el acreditamiento a
  // que la erogación sea DEDUCIBLE PARA ISR, que es justo lo que la facilidad
  // conserva. Negar el IVA aquí le costaba a una flota con $5,000,000 de
  // combustible al año unos $103,000 anuales que la ley le concede.
  //
  // La frontera queda en la elegibilidad, igual que en el motor:
  //   · `elegible15 === true`  → hay deducción, luego hay IVA que sostener.
  //   · `false` o sin declarar → no hay deducción (el motor emite
  //     `efectivo_no_elegible` o `combustible_efectivo`), luego no hay IVA.
  // Esta función es un booleano y no reparte proporciones; el motor sí lo hace
  // con `proporcionDeducible`, y él es quien imprime la cifra del PDF.
  if (medioNoAdmitidoCombustible(formaPagoEfectiva(g)) && esCombustible(g, o) && o.elegible15 !== true) return false;
  // AUDITORÍA 18-c3, FISC-C3-2 (CRÍTICO): LIVA 5-III exige que el impuesto esté
  // "efectivamente pagado en el mes". `'99' Por definir` = la contraprestación
  // NO se ha pagado (RMF 2.7.1.29 fr. II), que es el caso normal de un CFDI PPD
  // —la flota con línea de crédito en la refaccionaria—. El motor ya lo negaba
  // (`engine.ts`, el candado de `59c02ec`); este módulo, que es el que alimenta
  // «IVA acreditable documentado» del panel del contador, se había quedado sin
  // él: el MISMO UUID daba $8,000 en la pantalla y $0.00 en el PDF, y el que se
  // teclea en la declaración es el de la pantalla. Se acreditará el mes en que
  // se pague, con su complemento de pago.
  //
  // Ojo con el criterio del módulo: se niega SOLO cuando la columna dice '99'.
  // Un comprobante SIN `forma_pago` es desconocido, no impago (mismo estándar
  // que `causasDe` y que `getAcumuladoCombustible`).
  // AUDITORÍA 24, FIS-7: con el complemento de pago ingerido (`pagado`, mig.
  // 0282 como dimensión del agregado) el '99' deja de cerrar la puerta — igual
  // que `pagadoConRep` en el motor. Sin el sello, todo queda como antes.
  if (g.formaPago === FORMA_PAGO_SIN_PAGAR && !g.pagado) return false;
  // ── RE-AUDITORÍA 25, FIS-REAUD-2 (CRÍTICO) ──────────────────────────────
  // Las 7 causas de `SIN_IVA_ACREDITABLE` (engine.ts) que le faltaban a esta
  // función: `rfc_receptor`, `rfc_receptor_no_verificable`,
  // `moneda_extranjera`, `renglones_ajenos`, `consumo_bar`,
  // `complemento_hidrocarburos` y `gasto_otro_ejercicio`.
  //
  // El receptor: `g.cfdiUuid` ya es verdadero aquí (primera línea de la
  // función), así que el "sin receptor" de abajo replica EXACTO el segundo
  // candado de `cuadrarViaje` (auditoría 8: `g.cfdiUuid && !g.rfcReceptor`).
  if (!g.rfcReceptor) return false;
  const rfcsPropios = o.rfcsPropios ?? new Set<string>();
  if (rfcsPropios.size > 0) {
    // Sin el RFC del OPERADOR del viaje —que esta vista, agregada por
    // celda, no conserva— no se puede aplicar la excepción de RLISR 57
    // (viático a nombre del operador). `cuadrarViaje` sí la aplica por
    // viaje; aquí, sin ese contexto, se falla CERRADO: cualquier receptor
    // que no sea de la empresa no sostiene el acreditamiento en el panel,
    // aunque el PDF de un viaje concreto pudiera acreditarlo por RLISR 57.
    // Nunca al revés (nunca acredita algo que el motor negaría).
    if (!rfcsPropios.has(normalizarRfc(g.rfcReceptor))) return false;
  } else if (o.empresaRfcConfigurado) {
    // RFC de empresa capturado pero inválido/genérico: no hay con qué
    // comparar — mismo tercer estado que `rfc_receptor_no_verificable`.
    return false;
  }
  // Sin `empresaRfcConfigurado` (el tenant no ha capturado su RFC todavía),
  // `cuadrarViaje` tampoco valida el receptor — mismo criterio aquí.
  if (g.monedaExtranjera) return false;
  if (g.renglonesAjenos) return false;
  if (g.consumoBar) return false;
  if (g.complementoHidrocarburosFalta) return false;
  if (g.otroEjercicio) return false;
  return true;
}

export function resumirFiscal(gastos: GastoFiscal[], o: OpcionesFiscales): ResumenFiscal {
  let gastoTotal = 0, ivaAcreditable = 0, ivaNoAcreditable = 0;
  let iepsDieselDocumentado = 0, subTotalCasetas = 0;
  let conCfdi = 0, conCfdiSinDesglose = 0, casetasSinSubTotal = 0;
  let porValidar = 0, vigentes = 0, cancelados = 0;
  // RE-AUDITORÍA 25, FIS-REAUD-3 (ALTO): cuánto de `ivaAcreditable` pasó por
  // la proporción del 15% de la RFA 2.9 EN VIVO (`propCombustible15`, abajo)
  // — la que decide `combustible15SujetoADeriva` al final.
  let ivaViaCombustible15 = 0;

  // AUDITORÍA 4, E4: esto sumaba el IVA COMPLETO de un viático que el motor
  // acreditaba en proporción al tope de LISR 28-V (LIVA 5-I: "en la proporción
  // en la que dichas erogaciones sean deducibles"). Sobre $900 con tope de
  // $750: el panel decía 100% donde la liquidación decía 83.3%. El criterio
  // es EL MISMO módulo que usa el motor (`cuadre/tope_alimentacion.ts`), no
  // una réplica. El tope es por día Y POR BENEFICIARIO: este panel mira un
  // periodo con muchos viajes, así que se parte por viaje —la liquidación es
  // de un solo operador— antes de aplicar el criterio, igual que el motor.
  const proporciones = new Map<string, number>();
  if (o.viaticosTopeFiscalDiarioMxn != null) {
    const porViaje = new Map<string, GastoFiscal[]>();
    for (const g of gastos) {
      if (g.celda) continue; // las celdas traen su día ya partido (abajo)
      porViaje.set(g.viajeId, [...(porViaje.get(g.viajeId) ?? []), g]);
    }
    for (const delViaje of porViaje.values()) {
      for (const [id, p] of proporcionAlimentacionPorGasto(delViaje, o.viaticosTopeFiscalDiarioMxn)) {
        proporciones.set(id, p);
      }
    }
  }
  /**
   * La MISMA proporción para una celda: SQL (mig. 0151) partió en celdas
   * propias los timbrados de alimentación de cada (viaje, día) cuyo total
   * timbrado rebasa el tope, y trae ese total. La fórmula —`min(1,
   * tope/totalTimbrado)`, calculada solo sobre lo timbrado— sigue siendo la
   * de `diasSobreTope`: se le pasa el día como un solo comprobante timbrado
   * por el total y se lee su proporción. Sin tope configurado, 1 (el motor
   * tampoco prorratea).
   */
  const proporcionDeCelda = (g: GastoFiscal): number => {
    const total = g.celda?.totalTimbradoDia;
    if (total == null || o.viaticosTopeFiscalDiarioMxn == null) return 1;
    const dia = diasSobreTope(
      [{ id: 'dia', concepto: CONCEPTOS_CON_TOPE_ALIMENTACION[0], monto: total, fecha: '2000-01-01', cfdiUuid: 'x' }],
      o.viaticosTopeFiscalDiarioMxn,
    )[0];
    return dia?.proporcionTimbrado ?? 1;
  };

  // AUDITORÍA 25, FIS-C1/FIS-C2/ARQ-C1 (CRÍTICO): calculada UNA vez — depende
  // solo de `o`, no de cada gasto — y reutilizada abajo para todo el diésel
  // (o combustible del SAT) pagado con un medio que la LISR 27-III no admite.
  const propCombustible15 = proporcionCombustible15(o);

  for (const g of gastos) {
    const peso = pesoDe(g);
    gastoTotal += g.monto;
    if (g.cfdiUuid) {
      conCfdi += peso;
      if (g.estadoSat === 'vigente') vigentes += peso;
      else if (g.estadoSat === 'cancelado') cancelados += peso;
      else porValidar += peso;
      if (g.ivaTraslado === null) conCfdiSinDesglose += peso;
    }
    if (g.ivaTraslado !== null && g.ivaTraslado > 0) {
      if (ivaSostenible(g, o)) {
        // AUDITORÍA 25, FIS-C1/FIS-C2/ARQ-C1 (CRÍTICO, reincidente 23/24): un
        // diésel en efectivo con `elegible15` pasaba `ivaSostenible` (la
        // facilidad SALVA la deducción) y caía aquí sin proporción — el
        // `?? 1` de antes acreditaba el IVA COMPLETO donde el motor solo
        // acreditaba la fracción dentro del 15% del ejercicio.
        const esCombustibleEfectivo = medioNoAdmitidoCombustible(formaPagoEfectiva(g)) && esCombustible(g, o);
        const proporcion = Math.max(0, Math.min(1, esCombustibleEfectivo
          ? propCombustible15
          : (g.celda ? proporcionDeCelda(g) : (proporciones.get(g.id) ?? 1))));
        ivaAcreditable += g.ivaTraslado * proporcion;
        // El resto del traslado existe en el papel y NO se acredita: va a la
        // otra cubeta para que las dos sigan sumando el IVA desglosado.
        ivaNoAcreditable += g.ivaTraslado * (1 - proporcion);
        // RE-AUDITORÍA 25, FIS-REAUD-3: este crédito depende del acumulado de
        // combustible A HOY (`propCombustible15`/`o.combustibleEjercicio`),
        // que sigue creciendo cada día — una liquidación FIRMADA hace tres
        // meses fijó su reparto contra el acumulado que existía ENTONCES, no
        // contra éste. Se marca aparte para que el llamador lo diga.
        if (esCombustibleEfectivo) ivaViaCombustible15 += g.ivaTraslado * proporcion;
      } else {
        ivaNoAcreditable += g.ivaTraslado;
      }
    }
    // El IEPS del diésel exige pago electrónico y NO tiene la válvula del 15%
    // que la RFA 2.9 concede para ISR: la facilidad salva la deducción, no el
    // acreditamiento (LIF 2026 20-A, 4º párrafo).
    // AUDITORÍA 24, FIS-A2 (ALTO, reincidente 23): era `!== '01'`, que sumaba
    // '06', '99' (no pagado) y cualquier medio fuera de la lista. LIF 20-A
    // (`normas/lif-2026-20-A.yaml`) exige pago con los medios de la LISR
    // 27-III: lista CERRADA y forma EFECTIVA (la del REP, si el CFDI era '99').
    // Sigue siendo el IEPS TRASLADADO documentado, no el estímulo (cuota × litros).
    const formaIeps = formaPagoEfectiva(g);
    if (esDieselConIeps(g, o) && g.iepsTraslado !== null && formaIeps && (MEDIOS_LISR_27_III as readonly string[]).includes(formaIeps)) {
      iepsDieselDocumentado += g.iepsTraslado;
    }
    if (g.concepto === 'caseta') {
      // En una celda `subTotal` es la suma de los que SÍ traen base y
      // `subTotalNulos` cuenta los que no; en un comprobante, uno u otro.
      if (g.subTotal !== null) subTotalCasetas += g.subTotal;
      casetasSinSubTotal += g.celda ? g.celda.subTotalNulos : (g.subTotal === null ? 1 : 0);
    }
  }

  const n = gastos.reduce((s, g) => s + pesoDe(g), 0);
  return {
    n,
    gastoTotal: round2(gastoTotal),
    conCfdi,
    sinCfdi: n - conCfdi,
    ivaAcreditable: round2(ivaAcreditable),
    ivaNoAcreditable: round2(ivaNoAcreditable),
    conCfdiSinDesglose,
    iepsDieselDocumentado: round2(iepsDieselDocumentado),
    subTotalCasetas: round2(subTotalCasetas),
    casetasSinSubTotal,
    porValidar,
    vigentes,
    cancelados,
    // RE-AUDITORÍA 25, FIS-REAUD-3: `> 0` y no `!== 0` — un residuo de
    // redondeo de un centavo no es "hay combustible en efectivo tocando el
    // 15% del ejercicio", y marcar por eso desconfiaría del panel siempre.
    combustible15SujetoADeriva: round2(ivaViaCombustible15) > 0,
  };
}

// ── Combustible y casetas, con ojos fiscales ───────────────────────────────

export interface ResumenCombustible {
  concepto: 'diesel' | 'caseta';
  n: number;
  monto: number;
  conCfdi: number;
  montoConCfdi: number;
  sinCfdi: number;
  montoSinCfdi: number;
  /**
   * % del MONTO pagado con medio electrónico (todo lo que no es '01').
   *
   * `null` cuando no hay un solo comprobante con `forma_pago` conocida: un 0%
   * ahí se leería como "todo se paga en efectivo", que es una acusación.
   */
  pctElectronico: number | null;
  /** Monto cuya forma de pago no se conoce — el denominador que falta. */
  montoSinFormaPago: number;
}

export function resumirCombustibleCasetas(gastos: GastoFiscal[]): ResumenCombustible[] {
  return (['diesel', 'caseta'] as const).map((concepto) => {
    const filas = gastos.filter((g) => g.concepto === concepto);
    const conCfdi = filas.filter((g) => g.cfdiUuid);
    const sinCfdi = filas.filter((g) => !g.cfdiUuid);
    const conFormaPago = filas.filter((g) => g.formaPago);
    const baseConocida = conFormaPago.reduce((s, g) => s + g.monto, 0);
    // FIS-A2: «electrónico» = uno de los medios de la LISR 27-III, con la forma
    // EFECTIVA; un '99' sin pagar no es electrónico todavía.
    const electronico = conFormaPago
      .filter((g) => { const f = formaPagoEfectiva(g); return !!f && (MEDIOS_LISR_27_III as readonly string[]).includes(f); })
      .reduce((s, g) => s + g.monto, 0);
    const cuenta = (xs: GastoFiscal[]) => xs.reduce((s, g) => s + pesoDe(g), 0);
    return {
      concepto,
      n: cuenta(filas),
      monto: round2(filas.reduce((s, g) => s + g.monto, 0)),
      conCfdi: cuenta(conCfdi),
      montoConCfdi: round2(conCfdi.reduce((s, g) => s + g.monto, 0)),
      sinCfdi: cuenta(sinCfdi),
      montoSinCfdi: round2(sinCfdi.reduce((s, g) => s + g.monto, 0)),
      pctElectronico: baseConocida > 0 ? Math.round((electronico / baseConocida) * 100) : null,
      montoSinFormaPago: round2(filas.filter((g) => !g.formaPago).reduce((s, g) => s + g.monto, 0)),
    };
  });
}

/** El 15% de la RFA 2026 regla 2.9, calculado sobre los gastos ya leídos. */
export function tope15DeGastos(gastos: GastoFiscal[], o: OpcionesFiscales): ResultadoTope15 {
  let efectivo = 0, totalCombustible = 0;
  for (const g of gastos) {
    if (!esCombustible(g, o)) continue;
    if (!(g.monto > 0)) continue;
    totalCombustible += g.monto;
    if (medioNoAdmitidoCombustible(formaPagoEfectiva(g))) efectivo += g.monto;
  }
  return evaluarTope15({ efectivo, totalCombustible });
}

// ── Retenciones ────────────────────────────────────────────────────────────

export interface DiagnosticoRetencion {
  /** Siempre `false` hoy. Ver `motivo`. */
  calculable: boolean;
  /** Los campos que harían falta, con nombre exacto. */
  camposFaltantes: string[];
  motivo: string;
  /**
   * Comprobantes que PARECEN servicio de autotransporte subcontratado — el
   * único caso en que la flota es quien retiene. Es una señal para el
   * contador, no un cálculo: sin el nodo de retenciones no hay cifra.
   */
  candidatos: number;
  montoCandidatos: number;
}

/**
 * La retención del 4% de IVA por autotransporte terrestre de carga.
 *
 * QUIÉN RETIENE A QUIÉN. Cuando la flota CONTRATA a un tercero (un fletero,
 * un permisionario) para mover carga, la flota es persona moral que recibe un
 * servicio de autotransporte terrestre de bienes: está obligada a RETENER el
 * IVA correspondiente y enterarlo. Ese es el único lado que este panel podría
 * ver, porque `gasto` es lo que la flota RECIBE de sus proveedores. El otro
 * lado —lo que los clientes de la flota le retienen a ELLA— vive en los CFDI
 * que la flota emite, y eso no es parte de este panel.
 *
 * POR QUÉ NO SE PUEDE CALCULAR HOY, con nombre y apellido:
 *
 *   1. `gasto` no tiene columna de retenciones. Sus 31 columnas incluyen
 *      `iva_traslado` e `ieps_traslado` (impuestos TRASLADADOS) y ninguna de
 *      retenidos.
 *   2. `intake/cfdi_xml.ts` parsea `cfdi:Impuestos/cfdi:Traslados/cfdi:Traslado`
 *      y solo eso: el nodo `cfdi:Retenciones/cfdi:Retencion` con
 *      `Impuesto="002"` —donde vive el importe retenido— no se lee. Aunque el
 *      XML del proveedor lo traiga, hoy se descarta al importarlo.
 *
 * Calcularlo como `sub_total * 0.04` sería inventarlo: la retención efectiva
 * la fija el CFDI del proveedor, puede no existir (si el proveedor es persona
 * moral no aplica la retención), y una cifra así entra directo a una
 * declaración mensual.
 */
export function diagnosticoRetencion(gastos: GastoFiscal[]): DiagnosticoRetencion {
  // `flete` es el concepto con el que el intake etiqueta el pago a un tercero
  // que mueve carga. Es la mejor señal disponible, y se declara como señal.
  const candidatos = gastos.filter((g) => g.concepto === 'flete');
  return {
    calculable: false,
    camposFaltantes: [
      'gasto.iva_retenido (columna inexistente)',
      'intake/cfdi_xml.ts: nodo cfdi:Impuestos/cfdi:Retenciones/cfdi:Retencion[@Impuesto="002"]',
    ],
    motivo:
      'El importe retenido vive en el nodo de Retenciones del CFDI del proveedor. Ese nodo no se parsea al importar el XML y no hay columna donde guardarlo, así que no existe en la base. Derivarlo como 4% del subtotal sería inventar la cifra: la retención la fija el comprobante y no siempre aplica.',
    candidatos: candidatos.reduce((s, g) => s + pesoDe(g), 0),
    montoCandidatos: round2(candidatos.reduce((s, g) => s + g.monto, 0)),
  };
}

// ── Lectura de la base ─────────────────────────────────────────────────────
//
// ── ESCALA 50k VIAJES/MES (mig. 0151): AGREGADO POR DIMENSIONES, LEY EN TS ──
//
// Antes esto traía a JS TODOS los comprobantes del periodo (`traerTodo`, techo
// 100,000 filas → con 'ejercicio' por defecto y 300k gastos/mes, reventaba
// ~día 10) y luego `traerPorIds` sobre los 600k viajes del año para ponerles
// folio y operador — que NINGUNA pantalla lee (Resumen, Contador y el chat
// consumen solo montoPerdido/EnRiesgo/Recuperable, porCausa y ResumenFiscal).
//
// La 0112 NO lo movió a RPC porque `resumirFiscal`/`resumirPerdidas` son LEY
// (deducibilidad por comprobante) y reescribirla en SQL la duplicaría. Esto
// la respeta: SQL NO juzga nada — AGRUPA los comprobantes por las dimensiones
// exactas que la ley de arriba consulta por fila (concepto, clave SAT, forma
// de pago, estado SAT, EFOS, con/sin CFDI, con/sin desglose de IVA, con/sin
// fecha) y devuelve por celda sumas y conteos. Cada celda llega aquí como un
// `GastoFiscal` con `celda.n`, y las MISMAS funciones de la ley la pesan por
// `n` (ver `pesoDe`). Cientos de celdas en vez de millones de filas, y la
// regla sigue viviendo en un solo sitio.
//
// Los DOS juicios que no son categóricos se resuelven sin mover la regla:
//   · `monto > efectivoTopeMxn` (LISR 27-III) — SQL parte cada fila con el
//     tope que ESTA función le manda desde la config del tenant; la regla de
//     qué hacer con ese montón sigue en `causasDe` (`sobreTopeEfectivo`).
//   · La proporción de alimentación por (viaje, día) (LISR 28-V / LIVA 5-I) —
//     SQL parte en celdas propias los timbrados de los días cuyo total
//     timbrado rebasa el tope y trae ese total; `resumirFiscal` calcula la
//     proporción con `diasSobreTope` del motor. Los días que no rebasan no
//     se parten: la proporción sería 1, el mismo resultado.
//   · El plazo del PORTAL (`plazoVencido`): la identificación del comercio
//     (`identificarComercio`) y el reloj (`calcularCaducidad`) siguen siendo
//     los de `facturacion/`. Como `vencido` es monótono en la fecha para un
//     plazo dado, basta con que SQL diga en qué BANDA cae la fecha respecto a
//     los cortes que `cortesDePlazo` calcula aquí con el reloj real (uno por
//     plazo distinto del catálogo) — y agrupe los sin CFDI por (banda, RFC
//     emisor, host del portal, emisor leído), que es lo que el identificador
//     mira. Cardinalidad: comercios × bandas, no tickets.
//
// POR QUÉ SE FILTRA POR `fecha` Y NO POR `created_at`: `fecha` es la del
// COMPROBANTE, la que decide en qué periodo cae para el SAT. Un ticket del 30
// de julio subido el 2 de agosto es de julio para el contador. Los
// comprobantes SIN `fecha` quedan fuera de cualquier corte por periodo, y se
// cuentan y se dicen (`sinFecha`) en vez de meterlos callados al mes actual.

/** Forma EXACTA de una celda tal como la emite `gastos_fiscales_agregados_tenant`. */
interface CeldaCruda {
  concepto: string; claveProdServ: string | null; formaPago: string | null;
  /** FIS-7 (mig. 0282). `null` = la RPC no lo trae (base anterior): no pagado. */
  pagado: boolean | null; pagadoForma: string | null;
  efos: boolean | null; efosRevisar: boolean | null; estadoSat: string | null;
  tieneCfdi: boolean; sinFecha: boolean; ivaEstado: CeldaFiscal['ivaEstado'];
  sobreTopeEfectivo: boolean;
  banda: number | null; rfcEmisor: string | null; host: string | null; emisor: string | null;
  totalTimbradoDia: number | null;
  /** RE-AUDITORÍA 25, FIS-REAUD-1 (mig. 0316): ¿el viaje tiene liquidación FIRMADA? */
  liquidacionFirmada: boolean;
  /** RE-AUDITORÍA 25, FIS-REAUD-2 (mig. 0317): las 7 causas que le faltaban
   *  a `ivaSostenible` frente a `SIN_IVA_ACREDITABLE` de engine.ts. */
  rfcReceptor: string | null;
  monedaExtranjera: boolean;
  renglonesAjenos: boolean;
  consumoBar: boolean;
  complementoHidrocarburosFalta: boolean;
  otroEjercicio: boolean;
  n: number; monto: number; iva: number; ieps: number; iepsNulos: number;
  subTotal: number; subTotalNulos: number;
  muestraId: string; muestraCfdi: string | null; fechaMax: string | null;
}

/**
 * Fail-closed de FORMA: una celda que no encaje LANZA. Un `?? 0` aquí
 * convertiría una migración sin aplicar o una columna renombrada en un panel
 * fiscal en ceros — exactamente la cifra que el contador no debe ver.
 */
function leerCelda(x: unknown, i: number): CeldaCruda {
  const falla = (campo: string) => new Error(
    `getGastosFiscales: la celda ${i} de gastos_fiscales_agregados_tenant no trae \`${campo}\` con la forma esperada (¿migración 0151 sin aplicar?)`,
  );
  if (!x || typeof x !== 'object') throw falla('celda');
  const c = x as Record<string, unknown>;
  const str = (k: string): string | null => {
    const v = c[k];
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') throw falla(k);
    return v || null;
  };
  const strReq = (k: string): string => { const v = str(k); if (v === null) throw falla(k); return v; };
  const num = (k: string): number => {
    const v = c[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw falla(k);
    return v;
  };
  const numOpt = (k: string): number | null => (c[k] === null || c[k] === undefined ? null : num(k));
  const bool = (k: string): boolean | null => {
    const v = c[k];
    if (v === null || v === undefined) return null;
    if (typeof v !== 'boolean') throw falla(k);
    return v;
  };
  const boolReq = (k: string): boolean => { const v = bool(k); if (v === null) throw falla(k); return v; };
  const ivaEstado = strReq('ivaEstado');
  if (ivaEstado !== 'nulo' && ivaEstado !== 'positivo' && ivaEstado !== 'no_positivo') throw falla('ivaEstado');
  const n = num('n');
  if (!Number.isInteger(n) || n < 1) throw falla('n');
  return {
    concepto: strReq('concepto'), claveProdServ: str('claveProdServ'), formaPago: str('formaPago'),
    pagado: bool('pagado'), pagadoForma: str('pagadoForma'),
    efos: bool('efos'), efosRevisar: bool('efosRevisar'), estadoSat: str('estadoSat'),
    tieneCfdi: boolReq('tieneCfdi'), sinFecha: boolReq('sinFecha'), ivaEstado,
    sobreTopeEfectivo: boolReq('sobreTopeEfectivo'),
    banda: numOpt('banda'), rfcEmisor: str('rfcEmisor'), host: str('host'), emisor: str('emisor'),
    totalTimbradoDia: numOpt('totalTimbradoDia'),
    liquidacionFirmada: boolReq('liquidacionFirmada'),
    rfcReceptor: str('rfcReceptor'),
    monedaExtranjera: boolReq('monedaExtranjera'),
    renglonesAjenos: boolReq('renglonesAjenos'),
    consumoBar: boolReq('consumoBar'),
    complementoHidrocarburosFalta: boolReq('complementoHidrocarburosFalta'),
    otroEjercicio: boolReq('otroEjercicio'),
    n, monto: num('monto'), iva: num('iva'), ieps: num('ieps'), iepsNulos: num('iepsNulos'),
    subTotal: num('subTotal'), subTotalNulos: num('subTotalNulos'),
    muestraId: strReq('muestraId'), muestraCfdi: str('muestraCfdi'), fechaMax: str('fechaMax'),
  };
}

/** Un plazo del catálogo como llave de mapa (`{dias: 7}` y `'mes_natural'` son distintos). */
const llavePlazo = (p: Plazo): string => JSON.stringify(p);

/** El default que `armar` (facturacion/pendientes.ts) usa sin comercio reconocido. */
const PLAZO_SIN_COMERCIO: Plazo = 'mes_natural';

/** Hasta dónde se busca el corte de un plazo. Los del catálogo son de semanas;
 *  si alguno llegara a exceder esto, `cortesDePlazo` LANZA en vez de adivinar. */
const BUSQUEDA_CORTE_DIAS = 400;

export interface CortesPlazo {
  /** Fechas ISO ascendentes: el primer día NO vencido de cada plazo distinto. */
  cortes: string[];
  /** ¿Un ticket de este plazo, cuya fecha cae en `banda`, ya venció? */
  vencido(plazo: Plazo, banda: number): boolean;
}

/**
 * Los cortes de fecha que hacen de `plazoVencido` una dimensión agrupable.
 *
 * Para un plazo dado, `calcularCaducidad(fecha).vencido` es monótono: vencido
 * para toda fecha anterior a un día, no vencido de ese día en adelante. Ese
 * día es el CORTE del plazo y se encuentra con el reloj REAL (no con una
 * fórmula propia): caminando hacia atrás desde `hoy` hasta el primer día
 * vencido. Con los cortes ordenados, SQL solo cuenta cuántos quedan por
 * encima de la fecha de cada ticket (`banda`), y aquí se decide: un plazo
 * cuyo corte es el j-ésimo (de k) está vencido si la fecha cae debajo de
 * él, o sea si `banda ≥ k − j`.
 */
export function cortesDePlazo(hoy: string): CortesPlazo {
  const plazos = new Map<string, Plazo>([[llavePlazo(PLAZO_SIN_COMERCIO), PLAZO_SIN_COMERCIO]]);
  for (const c of COMERCIOS) plazos.set(llavePlazo(c.plazo), c.plazo);

  const corteDe = new Map<string, string>();
  for (const [llave, plazo] of plazos) {
    let corte: string | null = null;
    for (let atras = 0; atras <= BUSQUEDA_CORTE_DIAS; atras++) {
      const d = new Date(`${hoy}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - atras);
      const fecha = d.toISOString().slice(0, 10);
      if (calcularCaducidad({ fechaTicket: fecha, plazo, hoy }).vencido) break;
      corte = fecha;
    }
    if (corte === null) throw new Error(`cortesDePlazo: el plazo ${llave} no vence en ${BUSQUEDA_CORTE_DIAS} días desde ${hoy}`);
    corteDe.set(llave, corte);
  }
  const cortes = [...new Set(corteDe.values())].sort();
  return {
    cortes,
    vencido(plazo, banda) {
      const corte = corteDe.get(llavePlazo(plazo));
      if (corte === undefined) throw new Error(`cortesDePlazo: plazo ${llavePlazo(plazo)} fuera del catálogo`);
      return banda >= cortes.length - cortes.indexOf(corte);
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// D.22 (frente de escala) — EL AGREGADO POR EMISOR NO SE QUEDA EN TEXTO LIBRE.
//
// SQL agrupa las celdas sin CFDI por lo que la visión LEYÓ (`ocr_extra->>
// 'emisor'`, con el upper/trim de la 0192). Eso deja "PEMEX", "PEMEX SA DE CV"
// y "PEMEX  SA DE CV" como TRES celdas: la cifra que ve el contador queda
// partida sin que nadie lo note. La 0192 ya lo dijo: unificar variantes de
// fondo exige el matching del catálogo, no una normalización de texto.
//
// Aquí se hace ese matching — en TS, que es donde vive `identificarComercio`
// y el catálogo (`comercios.ts`; NO se toca: otro frente lo está ampliando).
// Dos celdas sin CFDI se funden cuando TODAS sus demás dimensiones coinciden
// y su emisor resuelve a la MISMA identidad canónica:
//   · el COMERCIO del catálogo (por dominio del host → RFC → texto, la misma
//     prioridad de `identificarComercio`), o
//   · el RFC leído y validado, cuando el catálogo no lo conoce.
//
// `null` es `null`: una celda cuyo emisor no resuelve a nada (sin comercio y
// sin RFC) NO se agrupa con nadie — se queda tal como SQL la entregó, jamás
// en un cubo "otros" que mienta una identidad que no existe.
// ═══════════════════════════════════════════════════════════════════════════

/** La identidad canónica del emisor de una celda sin CFDI, o `null`. */
function identidadDeEmisor(c: CeldaCruda): string | null {
  if (c.tieneCfdi) return null;
  const comercio = identificarComercio({
    urlFacturacion: c.host ?? undefined,
    rfcEmisor: c.rfcEmisor ?? undefined,
    textoTicket: c.emisor ?? undefined,
  });
  if (comercio) return `comercio:${comercio.clave}`;
  if (c.rfcEmisor) return `rfc:${c.rfcEmisor.trim().toUpperCase()}`;
  return null;
}

/**
 * Funde las celdas sin CFDI que son EL MISMO emisor con distinta ortografía.
 * Se conservan los datos crudos (rfc/host/emisor) de la PRIMERA celda del
 * grupo: resuelven a la misma identidad por construcción, y `plazoVencido`
 * se calcula después sobre esa resolución — el mismo comercio, el mismo plazo.
 */
function consolidarCeldasPorEmisor(celdas: CeldaCruda[]): CeldaCruda[] {
  const salida: CeldaCruda[] = [];
  const grupos = new Map<string, CeldaCruda>();
  for (const c of celdas) {
    const identidad = identidadDeEmisor(c);
    if (identidad === null) {
      salida.push(c);   // sin identidad no hay con quién agrupar — tal cual
      continue;
    }
    // Las DEMÁS dimensiones tienen que coincidir: fundir a través de bandas o
    // conceptos cambiaría causas fiscales, no solo ortografía.
    const llave = JSON.stringify([
      identidad, c.concepto, c.claveProdServ, c.formaPago, c.pagado, c.pagadoForma, c.efos, c.efosRevisar,
      c.estadoSat, c.sinFecha, c.ivaEstado, c.sobreTopeEfectivo, c.banda, c.totalTimbradoDia,
    ]);
    const previa = grupos.get(llave);
    if (!previa) {
      const copia = { ...c };
      grupos.set(llave, copia);
      salida.push(copia);
      continue;
    }
    previa.n += c.n;
    previa.monto += c.monto;
    previa.iva += c.iva;
    previa.ieps += c.ieps;
    previa.iepsNulos += c.iepsNulos;
    previa.subTotal += c.subTotal;
    previa.subTotalNulos += c.subTotalNulos;
    if (c.muestraId < previa.muestraId) previa.muestraId = c.muestraId;
    if (previa.muestraCfdi === null) previa.muestraCfdi = c.muestraCfdi;
    if (c.fechaMax !== null && (previa.fechaMax === null || c.fechaMax > previa.fechaMax)) {
      previa.fechaMax = c.fechaMax;
    }
  }
  return salida;
}

/**
 * ¿El portal ya cerró su plazo para esta celda sin CFDI? El MISMO camino que
 * `armar` (facturacion/pendientes.ts): identificar el comercio por la liga,
 * el RFC o el texto del emisor —aquí el HOST de la liga, que es lo que los
 * dominios del catálogo describen— y, sin comercio, el default conservador.
 * Sin fecha (`banda` nula) no se afirma nada: `null`.
 */
function plazoVencidoDeCelda(c: CeldaCruda, cortes: CortesPlazo): boolean | null {
  if (c.tieneCfdi || c.banda === null) return null;
  const comercio = identificarComercio({
    urlFacturacion: c.host ?? undefined,
    rfcEmisor: c.rfcEmisor ?? undefined,
    textoTicket: c.emisor ?? undefined,
  });
  return cortes.vencido(comercio?.plazo ?? PLAZO_SIN_COMERCIO, c.banda);
}

function aGastoFiscal(c: CeldaCruda, cortes: CortesPlazo): GastoFiscal {
  return {
    id: c.muestraId,
    viajeId: '',
    concepto: c.concepto,
    monto: c.monto,
    fecha: c.sinFecha ? null : c.fechaMax,
    folio: null,
    rfcEmisor: c.rfcEmisor,
    cfdiUuid: c.tieneCfdi ? c.muestraCfdi : null,
    cfdiValido: null,
    estadoSat: c.estadoSat,
    efos: c.efos,
    efosRevisar: c.efosRevisar,
    formaPago: c.formaPago,
    pagado: c.pagado,
    pagadoForma: c.pagadoForma,
    subTotal: c.subTotalNulos >= c.n ? null : c.subTotal,
    ivaTraslado: c.ivaEstado === 'nulo' ? null : c.iva,
    iepsTraslado: c.iepsNulos >= c.n ? null : c.ieps,
    claveProdServ: c.claveProdServ,
    tipoComprobante: null,
    xmlVerificado: null,
    ocrConfianza: null,
    viajeFolio: null,
    operadorNombre: null,
    plazoVencido: plazoVencidoDeCelda(c, cortes),
    liquidacionFirmada: c.liquidacionFirmada,
    rfcReceptor: c.rfcReceptor,
    monedaExtranjera: c.monedaExtranjera,
    renglonesAjenos: c.renglonesAjenos,
    consumoBar: c.consumoBar,
    complementoHidrocarburosFalta: c.complementoHidrocarburosFalta,
    otroEjercicio: c.otroEjercicio,
    celda: {
      n: c.n,
      sobreTopeEfectivo: c.sobreTopeEfectivo,
      ivaEstado: c.ivaEstado,
      iepsNulos: c.iepsNulos,
      subTotalNulos: c.subTotalNulos,
      totalTimbradoDia: c.totalTimbradoDia,
    },
  };
}

/**
 * Los comprobantes del tenant en un periodo, AGREGADOS por dimensión fiscal
 * (ver el encabezado de esta sección). Misma firma y mismo tipo que siempre:
 * cada elemento es un `GastoFiscal`, y las funciones de la ley de arriba lo
 * pesan por `celda.n`. Un viaje de red, sin techo de páginas.
 *
 * `opciones` son las del tenant (`opcionesDe(getConfig)`): de ahí salen el
 * tope de efectivo y el de alimentación con los que SQL parte las filas.
 * Pasarle opciones de OTRO tenant partiría con un tope que no es el suyo;
 * si el llamador no las manda, se leen aquí.
 *
 * `hoy` se inyecta para que una prueba de plazos no dependa del reloj.
 */
export async function getGastosFiscales(
  tenantId: string,
  periodo: Periodo,
  hoy: string = hoyMx(),
  opciones?: OpcionesFiscales,
): Promise<GastoFiscal[]> {
  const o = opciones ?? opcionesDe(await getConfig(tenantId));
  const cortes = cortesDePlazo(hoy);
  const { data, error } = await acotada(supabaseAdmin().rpc('gastos_fiscales_agregados_tenant', {
    p_tenant: tenantId,
    p_desde: periodo.desde,
    p_hasta: periodo.hasta,
    p_tope_efectivo: o.efectivoTopeMxn,
    p_tope_alimentacion: o.viaticosTopeFiscalDiarioMxn,
    p_conceptos_alimentacion: [...CONCEPTOS_CON_TOPE_ALIMENTACION],
    p_cortes: cortes.cortes,
    // RE-AUDITORÍA 25, FIS-REAUD-2: los parámetros de las 7 causas nuevas —
    // SQL solo los aplica fila por fila, la ley (qué umbral, qué patrón, qué
    // fecha) sigue viniendo de TS, igual que `p_tope_efectivo` de arriba.
    p_claves_combustible: o.clavesCombustible,
    p_vigente_desde: o.hidrocarburosVigenteDesde ?? null,
    p_exigible_desde: o.hidrocarburosExigibleDesde ?? null,
    p_umbral_renglones_ajenos: UMBRAL_RENGLONES_AJENOS,
    // El motor de regex de Postgres (ARE) no entiende `\b` como límite de
    // palabra —ahí `\b` es BACKSPACE—; su equivalente es `\y`. `SENAL_BAR` se
    // sigue definiendo una sola vez en engine.ts; aquí solo se traduce el
    // escape antes de mandarlo como parámetro (mismo patrón, dos motores).
    p_patron_bar: SENAL_BAR.source.replace(/\\b/g, '\\y'),
    p_hoy: hoy,
  }), 'getGastosFiscales');
  if (error) throw new Error(`getGastosFiscales: ${error.message}`);
  if (!Array.isArray(data)) {
    throw new Error(`getGastosFiscales: gastos_fiscales_agregados_tenant devolvió ${typeof data} en vez de un arreglo (¿migración 0151 sin aplicar?)`);
  }
  // D.22: las celdas sin CFDI del MISMO emisor con distinta ortografía se
  // funden por identidad canónica (comercio del catálogo o RFC) ANTES de que
  // el contador las vea partidas. Ver `consolidarCeldasPorEmisor`.
  return consolidarCeldasPorEmisor(data.map((x, i) => leerCelda(x, i)))
    .map((c) => aGastoFiscal(c, cortes));
}

export interface GastosFiscalesSeries {
  semanal: GastoFiscal[];
  mensual: GastoFiscal[];
  historico: GastoFiscal[];
}

/**
 * Las mismas 3 vistas que las flechas ‹ › de las tarjetas de KPI operativas
 * (`getSeriesKpiCards`, `analytics.ts`) — dirección del 8-ago-2026: "En
 * riesgo/perdido" y "Recuperable pidiendo factura" (Motor fiscal) suben al
 * nivel de KPI y ciclan semanal/mensual/histórico igual que las demás.
 *
 * NO son periodos consecutivos que se restan entre sí como `Periodo`
 * ('mes'/'mes_anterior'/'ejercicio') — son ventanas de días desde HOY,
 * calculadas a mano con el mismo criterio que `diasEjercicio` en
 * `dashboard/page.tsx`. `historico` reusa el `Periodo` real ('todo',
 * `desde`/`hasta` ambos `null`): desde la mig. 0151 una lectura sin cota ya
 * no trae la tabla entera sino sus celdas (acotadas por dimensiones, no por
 * volumen), así que la vista se conserva.
 */
export async function getGastosFiscalesSeries(
  tenantId: string,
  hoy: string = hoyMx(),
): Promise<GastosFiscalesSeries> {
  const haceNDias = (n: number): string => {
    const d = new Date(`${hoy}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (n - 1));
    return d.toISOString().slice(0, 10);
  };
  // La config se lee UNA vez para las tres ventanas.
  const o = opcionesDe(await getConfig(tenantId));
  // `clave: 'mes'` es un relleno — `getGastosFiscales` solo lee `desde`/
  // `hasta`, y estas ventanas no son un mes calendario. Se fija a 'mes' en
  // vez de inventar un valor nuevo en `ClavePeriodo` porque esa unión la
  // consume la UI del selector de /dashboard/contador (`SelectorPeriodo`,
  // `urlDePeriodo`) — agregar 'semana' ahí solo para este uso interno habría
  // sido el cambio más grande, no el más chico.
  //
  // ── `allSettled` POR MODO, NO `Promise.all` (FE-4) ───────────────────────
  //
  // No es por rechazos sueltos: `Promise.all` engancha las tres promesas, así
  // que ninguna queda sin escuchar. Es por lo que se puede DECIR después.
  // `Promise.all` se rinde con la PRIMERA que rompe y propaga solo ese error:
  // si la ventana de 7 días truena por un timeout y la histórica truena
  // porque la migración 0151 no está aplicada, el log guarda el timeout y la
  // causa real —la que hay que arreglar— nunca se ve. `allSettled` espera a
  // las tres y nombra TODAS las que fallaron, con la primera razón como
  // `cause` para no perder el stack.
  //
  // Y SIGUE FALLANDO EN BLOQUE A PROPÓSITO: la ventana que no se pudo leer
  // NO se rellena con `[]`. Un arreglo vacío recorre `resumirPerdidas` sin
  // quejarse y sale por pantalla como "$0.00 en riesgo" — una medición que
  // nadie hizo, sobre la cifra que el contador cruza con su papel. Devolver
  // por modo un `null` que la pantalla sepa distinguir exigiría cambiar el
  // tipo de retorno y las dos páginas que lo consumen (Resumen y Contador),
  // que no son de esta pasada. Mientras tanto: las tres o ninguna, con el
  // nombre de la(s) que falló(aron) en el mensaje.
  const modos = ['semanal', 'mensual', 'historico'] as const;
  const r = await Promise.allSettled([
    getGastosFiscales(tenantId, { clave: 'mes', desde: haceNDias(7), hasta: hoy, etiqueta: 'últimos 7 días' }, hoy, o),
    getGastosFiscales(tenantId, { clave: 'mes', desde: haceNDias(30), hasta: hoy, etiqueta: 'últimos 30 días' }, hoy, o),
    getGastosFiscales(tenantId, resolverPeriodo('todo', hoy), hoy, o),
  ]);
  const rotas = r.flatMap((x, i) => (x.status === 'rejected' ? [{ modo: modos[i], razon: x.reason as unknown }] : []));
  if (rotas.length > 0) {
    throw new Error(
      `getGastosFiscalesSeries: ${rotas.map((x) => `${x.modo} (${x.razon instanceof Error ? x.razon.message : String(x.razon)})`).join('; ')}`,
      { cause: rotas[0].razon },
    );
  }
  const [semanal, mensual, historico] = r.map((x) => (x as PromiseFulfilledResult<GastoFiscal[]>).value);
  return { semanal, mensual, historico };
}

/**
 * Cuántos comprobantes con fecha hay FUERA del periodo — la prueba de que el
 * filtro está recortando algo real.
 *
 * Se pregunta por separado porque `getGastosFiscales` ya viene filtrado y no
 * puede saber qué dejó afuera. Sin esto, un periodo vacío se ve idéntico a una
 * flota que nunca ha capturado un gasto, y las dos cosas piden acciones
 * opuestas: cambiar el filtro, o empezar a usar el producto.
 */
export async function contarGastosDelTenant(tenantId: string): Promise<{ total: number; sinFecha: number }> {
  const admin = supabaseAdmin();
  const [todos, sinFecha] = await Promise.all([
    acotada(admin.from('gasto').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId), 'contarGastosDelTenant'),
    acotada(admin.from('gasto').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).is('fecha', null), 'contarGastosDelTenant.sinFecha'),
  ]);
  if (todos.error) throw new Error(`contarGastosDelTenant: ${todos.error.message}`);
  if (sinFecha.error) throw new Error(`contarGastosDelTenant.sinFecha: ${sinFecha.error.message}`);
  return { total: todos.count ?? 0, sinFecha: sinFecha.count ?? 0 };
}

// ── Liquidaciones, en modo lectura ─────────────────────────────────────────

export interface LiquidacionFiscal {
  id: string;
  viajeFolio: string | null;
  operadorNombre: string | null;
  fecha: string;
  totalComprobado: number;
  totalAnticipo: number;
  diferencia: number;
  estatus: string;
  /** Cuántas observaciones levantó el motor. */
  observaciones: number;
  ivaAcreditable: number;
  iepsAcreditable: number;
  peajeAcreditable: number;
  litrosDieselAcreditables: number;
  pdfUrl: string | null;
}

/** El cursor de la lista: la ÚLTIMA fila entregada, no una posición. */
export interface CursorLiquidacionFiscal {
  creadoEn: string;
  id: string;
}

export interface PaginaLiquidacionesFiscales {
  filas: LiquidacionFiscal[];
  /** Con qué seguir, o `null` si esta fue la última página. */
  siguiente: CursorLiquidacionFiscal | null;
  /** Cuántas hay en el periodo ENTERO. Solo viene en la primera página (pedir
   *  el count en cada vuelta haría contar de más); `null` en las siguientes. */
  total: number | null;
}

/** Cuántas filas por página. Tope duro: nadie pide más aunque lo pase. */
export const LIQUIDACIONES_FISCALES_POR_PAGINA = 200;
const MAX_POR_PAGINA = 1_000;

/**
 * Las liquidaciones cerradas del periodo, para amarrar lo contable con lo
 * operativo. SOLO LECTURA: este módulo no expone nada que escriba.
 *
 * Se filtra por `created_at` y no por `fecha` porque una liquidación no tiene
 * fecha de documento: la fecha que le importa al contador es cuándo se cerró.
 * El rótulo de la pantalla lo dice con esas palabras.
 *
 * ── AUDITORÍA 24, REN-6 · UNA PÁGINA, NO EL EJERCICIO ENTERO ───────────────
 *
 * Traía TODO con `traerTodo` y ordenaba en JS. El periodo por default es el
 * EJERCICIO: a 12,000 liquidaciones/mes, el mes 8.3 del año llega a 100,000
 * filas, que es el techo de `traerTodo` (100 páginas × 1,000) — y de ahí en
 * adelante la pantalla del contador dejaba de servir con un `LecturaIncompleta`
 * hasta que él acortara el periodo a mano. Antes de reventar, 100 viajes de red
 * y 13 columnas × 100k filas en memoria de la función.
 *
 * Ahora entrega UNA página con cursor keyset `(created_at, id)` — el mismo
 * patrón que `export/liquidaciones` y `/v1/viajes`, y el mismo índice de la
 * 0157. El cursor es la FILA, no la posición: una liquidación nueva escrita a
 * media lectura (un chofer cierra su viaje por WhatsApp) entra arriba del
 * cursor y no repite ni se salta a nadie.
 *
 * El orden ya viene de la base (`created_at desc, id desc`), no de un `.sort()`
 * en JS: ordenar una página no ordena el conjunto, y el `.sort()` de antes solo
 * era correcto porque se había traído todo.
 */
export async function getLiquidacionesFiscales(
  tenantId: string,
  periodo: Periodo,
  opciones: { despues?: CursorLiquidacionFiscal | null; limite?: number } = {},
): Promise<PaginaLiquidacionesFiscales> {
  const despues = opciones.despues ?? null;
  const limite = Math.max(1, Math.min(opciones.limite ?? LIQUIDACIONES_FISCALES_POR_PAGINA, MAX_POR_PAGINA));

  let q = supabaseAdmin()
    .from('liquidacion')
    .select(
      'id, created_at, total_comprobado, total_anticipo, diferencia, estatus, diferencias, pdf_url, iva_acreditable, ieps_acreditable, peaje_acreditable, litros_diesel_acreditables, viaje:viaje_id(folio, operador:operador_id(nombre))',
      despues ? {} : { count: 'exact' },
    )
    .eq('tenant_id', tenantId);
  // DAT-08 (auditoría prod): el rango se armaba con `Z` —medianoche y
  // último milisegundo de LONDRES—, así que el periodo real iba de las
  // 18:00 del día anterior a las 17:59 del último día, en hora de México.
  // Una liquidación cerrada el 31 de diciembre a las 19:00 se contaba en el
  // ejercicio SIGUIENTE, y el rótulo seguía diciendo "del periodo".
  if (periodo.desde) q = q.gte('created_at', inicioDiaMx(periodo.desde));
  if (periodo.hasta) q = q.lte('created_at', finDiaMx(periodo.hasta));
  // `(created_at, id) < (c, i)` en el dialecto de PostgREST: o es más vieja, o
  // es del mismo instante y su id va después. Sin la segunda rama, dos
  // liquidaciones del mismo microsegundo se pierden o se repiten (pg.ts).
  if (despues) {
    q = q.or(`created_at.lt.${despues.creadoEn},and(created_at.eq.${despues.creadoEn},id.lt.${despues.id})`);
  }

  const res = await acotada(
    q.order('created_at', { ascending: false }).order('id', { ascending: false }).range(0, limite - 1),
    'getLiquidacionesFiscales',
  );
  const crudas = (exigir(res, 'getLiquidacionesFiscales') ?? []) as Array<Record<string, unknown>>;

  const filas = crudas.map((r) => {
    const v = r.viaje as { folio?: string; operador?: { nombre?: string } | null } | null;
    const difs = r.diferencias as unknown[] | null;
    return {
      id: r.id as string,
      viajeFolio: v?.folio ?? null,
      operadorNombre: v?.operador?.nombre ?? null,
      fecha: r.created_at as string,
      totalComprobado: Number(r.total_comprobado ?? 0),
      totalAnticipo: Number(r.total_anticipo ?? 0),
      diferencia: Number(r.diferencia ?? 0),
      estatus: (r.estatus as string) ?? '',
      observaciones: Array.isArray(difs) ? difs.length : 0,
      ivaAcreditable: Number(r.iva_acreditable ?? 0),
      iepsAcreditable: Number(r.ieps_acreditable ?? 0),
      peajeAcreditable: Number(r.peaje_acreditable ?? 0),
      litrosDieselAcreditables: Number(r.litros_diesel_acreditables ?? 0),
      pdfUrl: (r.pdf_url as string) || null,
    };
  });

  // Una página CORTA prueba que no hay nada después. Una página llena no lo
  // prueba: puede que la siguiente venga vacía, y por eso el cursor se
  // entrega igual — quien pagina lo sabrá en el siguiente viaje, que es más
  // barato que mentir con un "ya no hay".
  const ultima = filas[filas.length - 1];
  const siguiente = filas.length === limite && ultima ? { creadoEn: ultima.fecha, id: ultima.id } : null;

  return { filas, siguiente, total: typeof res.count === 'number' ? res.count : null };
}

// ── Export ─────────────────────────────────────────────────────────────────

export interface FilaExportCfdi {
  fecha: string;
  concepto: string;
  viaje: string;
  operador: string;
  folio: string;
  rfc_emisor: string;
  cfdi_uuid: string;
  estado_sat: string;
  efos: string;
  forma_pago: string;
  monto: number;
  sub_total: string;
  iva_traslado: string;
  ieps_traslado: string;
  clave_prod_serv: string;
  situacion_fiscal: string;
  fundamento: string;
}

/**
 * La fila que se lleva a Excel. Las columnas que no existen se van VACÍAS, no
 * en cero: un `0.00` en la columna de IVA de un ticket sin factura se importa
 * al ERP como "este gasto no causó IVA", que es una afirmación que nadie hizo.
 */
export function aFilasExport(gastos: GastoFiscal[], o: OpcionesFiscales): FilaExportCfdi[] {
  // Una celda agregada NO es una fila de Excel: su `monto` suma `n`
  // comprobantes y su `cfdi_uuid` es el de uno de muestra. Exportarla
  // inventaría un comprobante que no existe — se rechaza en vez de callarlo.
  const celdas = gastos.filter((g) => g.celda).length;
  if (celdas > 0) {
    throw new Error(`aFilasExport: ${celdas} fila(s) son celdas agregadas (mig. 0151); el export exige comprobantes individuales`);
  }
  const txt = (v: string | null) => v ?? '';
  const cifra = (v: number | null) => (v === null ? '' : String(round2(v)));
  return gastos.map((g) => {
    const dominante = causaDominante(g, o);
    return {
      fecha: txt(g.fecha),
      concepto: g.concepto,
      viaje: txt(g.viajeFolio),
      operador: txt(g.operadorNombre),
      folio: txt(g.folio),
      rfc_emisor: txt(g.rfcEmisor),
      cfdi_uuid: txt(g.cfdiUuid),
      estado_sat: g.cfdiUuid ? (g.estadoSat ?? 'sin validar') : '',
      efos: g.efos === null ? '' : g.efos ? 'si' : 'no',
      forma_pago: txt(g.formaPago),
      monto: g.monto,
      sub_total: cifra(g.subTotal),
      iva_traslado: cifra(g.ivaTraslado),
      ieps_traslado: cifra(g.iepsTraslado),
      clave_prod_serv: txt(g.claveProdServ),
      situacion_fiscal: dominante ? dominante.titulo : 'Sin observación',
      fundamento: dominante ? dominante.norma : '',
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// LO QUE ESTE MÓDULO NO HACE, PARA QUE NADIE LO SUPONGA
//
// 1. NO evalúa el tope de $750/día de alimentación (LISR 28-V). Es por día y
//    por beneficiario, y el reparto proporcional cuando hay varios
//    comprobantes del mismo día ya está resuelto en `engine.ts` al liquidar.
//    Repetirlo aquí con otra implementación produciría dos cifras distintas
//    para el mismo hecho, que es el modo de falla que `lib/formato.ts` existe
//    para evitar.
// 2. NO calcula el estímulo de IEPS en pesos. El estímulo es cuota del DOF ×
//    litros, no el IEPS trasladado (`normas/lif-2026-20-A.yaml`). Sin el
//    acuerdo semanal del DOF cargado, la cifra en pesos no se puede afirmar.
// 3. NO calcula retenciones. Ver `diagnosticoRetencion`.
// 4. NO toca `cliente`, `factura_emitida`, `pago_recibido` ni `factura_viaje`.
//    El ingreso de la flota no es el trabajo que Likida automatiza.
// ═══════════════════════════════════════════════════════════════════════════
