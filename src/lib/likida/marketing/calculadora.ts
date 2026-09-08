// ═══════════════════════════════════════════════════════════════════════════
// LA CALCULADORA DE RECUPERACIÓN FISCAL — el motor puro del lead magnet.
//
// Blueprint: Documentos Likida/13-Agentes-de-AI/05-Marketing-y-Contenido/
// agente-lead-magnet.md. Es la única pieza de contenido que un facturador
// genérico no puede copiar, y su diferenciador NO es calcular más: es
// calcular menos y decirlo (la regla de honestidad, seis candados).
//
// LOS SEIS CANDADOS, aplicados aquí y verificados por prueba:
//  1. Ningún número sin su supuesto en la misma línea (`supuestos` viaja en
//     el resultado y la página lo pinta junto a la cifra).
//  2. El IEPS jamás en pesos sin fecha de cuota — el dato duro son LITROS
//     (la misma decisión D2 del producto: cuadre/engine.ts deliberadamente
//     entrega `litrosDieselAcreditables`, no pesos; la cuota pasó de $7.3634
//     a $2.0925 en cinco meses y en bruto inflaba ~30%).
//  3. "El estímulo es ingreso acumulable" siempre visible, nunca en tooltip.
//  4. Cero "hasta un X%" (guia-de-marca §4; hay prueba estructural).
//  5. Si un dato falta, se dice qué falta (bloque ausente CON motivo).
//  6. No se promete que Likida recupera ese dinero: quien acredita es su
//     contador — Likida entrega el dato y la bitácora.
//
// PURO A PROPÓSITO: cero red, cero base. Corre igual en el servidor y en el
// navegador (la página pública lo importa directo — el resultado se enseña
// ANTES de pedir el contacto, que es la regla anti-abandono del blueprint).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * La cuota DISMINUIDA del estímulo IEPS de diésel (LIF 2026 art. 20 ap. A),
 * REGISTRADA con fecha. La publica el DOF cada semana y cambia — por eso el
 * resultado siempre la muestra fechada y con liga, y por eso existe
 * `cuotaVencida()`: pasado el plazo, la calculadora deja de estimar pesos de
 * IEPS y entrega solo litros (el dato que no cambia).
 *
 * AUDITORÍA 20, FISC-C1 (CRÍTICO). Este par estuvo mal apareado: $2.0925 es la
 * cuota del 25-31 de JULIO y venía sellada `registradaEl: '2026-08-27'`. El
 * sello de agosto impedía que `cuotaVencida()` disparara, así que la única
 * superficie pública que imprime pesos de IEPS publicaba una cifra de más de
 * un mes atrás como si fuera la vigente.
 *
 * FUENTE ÚNICA: `normas/datos/cuota-ieps-diesel.yaml`, la tabla que la rutina
 * del DOF escribe y que el repo cotejó dígito por dígito contra sus acuerdos.
 * El valor de abajo es la última semana verificada ahí (2026-09-05 a 09-11,
 * DOF 04-sep-2026 vespertina, codNota 5798037).
 * Quien lo actualice actualiza TAMBIÉN `registradaEl`, y
 * `calculadora.test.ts` lo cruza contra esa tabla con el lector fail-closed de
 * `cuadre/cuota_diesel.ts`: si el par deja de corresponder a una semana real,
 * falla en CI en vez de publicarse.
 */
export const CUOTA_DOF = {
  pesosPorLitro: 0.6787,
  registradaEl: '2026-09-05',
  fuenteUrl: 'https://www.dof.gob.mx/#gsc.tab=0',
} as const;

/** Días de gracia antes de considerar vencida la cuota registrada. Dos
 *  semanas: la cuota es semanal, así que a los 14 días ya hubo al menos dos
 *  publicaciones que no vimos. */
const DIAS_VIGENCIA_CUOTA = 14;

/** Precio de referencia del litro de diésel para convertir "gasto en pesos"
 *  a litros cuando la flota no tiene el dato en litros. Es un DEFAULT
 *  EDITABLE en la página — nunca una afirmación: el usuario lo ajusta al
 *  suyo y el supuesto viaja declarado en el resultado. */
export const PRECIO_DIESEL_REFERENCIA = 26.0;

/** IVA estándar para estimar el subtotal de casetas cuando el usuario da el
 *  gasto con IVA incluido (lo normal en un total de TAG). Declarado como
 *  supuesto en el resultado. */
const IVA = 0.16;

/** Factor del estímulo de peaje: 50% del subtotal (LIF 2026 art. 20-A fr. V
 *  + RMF 2026 regla 9.1.8) — el mismo factor que usa el motor del producto
 *  (`peajeFactor` en cuadre/engine.ts). */
const FACTOR_PEAJE = 0.5;

export interface EntradaCalculadora {
  /** Litros de diésel al mes. Si viene null se intenta convertir del gasto. */
  litrosDieselMes: number | null;
  /** Gasto de diésel al mes en MXN (solo si no saben los litros). */
  gastoDieselMesMxn: number | null;
  /** Precio por litro que el usuario declaró para la conversión (default
   *  PRECIO_DIESEL_REFERENCIA, editable en la página). */
  precioLitro: number | null;
  /** Gasto en casetas al mes, MXN, IVA incluido. */
  gastoCasetasMesMxn: number | null;
  /** Unidades de la flota — escala y califica; no cambia la aritmética. */
  unidades: number | null;
  /** Fecha "hoy" (ISO yyyy-mm-dd) — inyectada para que el motor sea puro. */
  hoy: string;
}

export interface BloqueDiesel {
  litrosMes: number;
  litrosAnio: number;
  /** Estimación mensual en pesos CON la cuota registrada — null si la cuota
   *  venció (candado 2: jamás pesos sin fecha defendible). */
  estimacionMesMxn: number | null;
  cuota: { pesosPorLitro: number; registradaEl: string; fuenteUrl: string };
  cuotaVencida: boolean;
  /** Presente solo si hubo conversión de pesos → litros. */
  conversion: { gastoMxn: number; precioLitro: number } | null;
}

export interface BloquePeaje {
  gastoMesMxn: number;
  /** gasto / 1.16 — supuesto declarado. */
  subtotalEstimadoMes: number;
  estimuloMesMxn: number;
  estimuloAnioMxn: number;
  condiciones: string[];
}

export interface ResultadoCalculadora {
  diesel: BloqueDiesel | { faltante: string };
  peaje: BloquePeaje | { faltante: string };
  /** Suma anual de lo estimable en pesos — null si NADA fue estimable en
   *  pesos (nunca un 0 que parezca medición). */
  totalAnualMxn: number | null;
  /** Qué entra al total y qué no (si la cuota venció, el diésel va en litros
   *  y el total lo dice). */
  notaDelTotal: string;
  supuestos: string[];
  /** El bloque que vende: acumulable + lo que NO incluye. Siempre presente. */
  advertencias: string[];
}

function esPositivo(n: number | null): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function diasEntre(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

export function cuotaVencida(hoy: string): boolean {
  return diasEntre(CUOTA_DOF.registradaEl, hoy) > DIAS_VIGENCIA_CUOTA;
}

/** Redondeo a peso entero: la calculadora estima, y los centavos fingirían
 *  una precisión que una estimación declarada no tiene. */
const pesos = (n: number) => Math.round(n);

export function calcularEstimacion(e: EntradaCalculadora): ResultadoCalculadora {
  const supuestos: string[] = [];
  const vencida = cuotaVencida(e.hoy);

  // ── Diésel: litros primero, pesos solo con cuota fechada y viva ──────────
  let diesel: ResultadoCalculadora['diesel'];
  let litrosMes: number | null = null;
  let conversion: BloqueDiesel['conversion'] = null;

  if (esPositivo(e.litrosDieselMes)) {
    litrosMes = e.litrosDieselMes;
  } else if (esPositivo(e.gastoDieselMesMxn)) {
    const precio = esPositivo(e.precioLitro) ? e.precioLitro : PRECIO_DIESEL_REFERENCIA;
    litrosMes = e.gastoDieselMesMxn / precio;
    conversion = { gastoMxn: e.gastoDieselMesMxn, precioLitro: precio };
    supuestos.push(
      `Litros estimados de tu gasto de diésel con un precio de $${precio.toFixed(2)} por litro (ajustable — usa el tuyo).`,
    );
  }

  if (litrosMes === null) {
    diesel = { faltante: 'Sin litros ni gasto de diésel no estimamos este bloque. Es el dato que tu flota sí tiene a la mano.' };
  } else {
    supuestos.push('Todos los litros capturados son de diésel para tus unidades (el estímulo es solo diésel, no gasolina).');
    diesel = {
      litrosMes: Math.round(litrosMes),
      litrosAnio: Math.round(litrosMes * 12),
      estimacionMesMxn: vencida ? null : pesos(litrosMes * CUOTA_DOF.pesosPorLitro),
      cuota: { ...CUOTA_DOF },
      cuotaVencida: vencida,
      conversion,
    };
  }

  // ── Peaje: pesos sí — sale de importes impresos en CFDI ──────────────────
  let peaje: ResultadoCalculadora['peaje'];
  if (!esPositivo(e.gastoCasetasMesMxn)) {
    peaje = { faltante: 'Sin el gasto mensual de casetas no estimamos el 50% de peaje.' };
  } else {
    const subtotal = e.gastoCasetasMesMxn / (1 + IVA);
    supuestos.push('El gasto de casetas que capturaste incluye IVA; el estímulo se calcula sobre el subtotal (gasto ÷ 1.16).');
    peaje = {
      gastoMesMxn: pesos(e.gastoCasetasMesMxn),
      subtotalEstimadoMes: pesos(subtotal),
      estimuloMesMxn: pesos(subtotal * FACTOR_PEAJE),
      estimuloAnioMxn: pesos(subtotal * FACTOR_PEAJE * 12),
      condiciones: [
        'Aplica en la Red Nacional de Autopistas de Cuota (término fiscal — no cualquier caseta).',
        'Pagado con medios electrónicos (TAG / tarjeta), no en efectivo.',
        'Requiere la bitácora de casetas conciliada — la que casi nadie arma es dinero que casi nadie acredita.',
      ],
    };
  }

  // ── El total, presentado como lo que es ──────────────────────────────────
  const partes: number[] = [];
  if ('estimuloAnioMxn' in peaje) partes.push(peaje.estimuloAnioMxn);
  if ('estimacionMesMxn' in diesel && diesel.estimacionMesMxn !== null) partes.push(diesel.estimacionMesMxn * 12);
  const totalAnualMxn = partes.length > 0 ? pesos(partes.reduce((a, b) => a + b, 0)) : null;

  const notaDelTotal =
    'estimacionMesMxn' in diesel && diesel.estimacionMesMxn === null
      ? 'El total no incluye el IEPS de diésel en pesos: la cuota que tenemos registrada ya venció, así que te damos el dato que no cambia — tus litros elegibles.'
      : 'litrosMes' in diesel && 'estimuloAnioMxn' in peaje
        ? 'Suma del 50% de peaje anual y el estímulo IEPS anual con la cuota registrada y fechada.'
        : 'El total solo suma los bloques que sí pudimos estimar con tus datos.';

  return {
    diesel,
    peaje,
    totalAnualMxn,
    notaDelTotal,
    supuestos,
    advertencias: [
      'El estímulo es ingreso acumulable: tu neto real es estímulo × (1 − tu tasa de ISR).',
      'Esta estimación NO incluye el IVA acreditable de tu combustible (ese sale de tus CFDI reales) ni lo que dependa de tu régimen.',
      'La cuota del IEPS la publica el DOF cada semana y cambia; tu contador la calcula con la de la semana en que cargaste. Nosotros entregamos el dato que no cambia: cuántos litros son elegibles.',
      'Likida entrega el dato y la bitácora; quien acredita es tu contador.',
    ],
  };
}
