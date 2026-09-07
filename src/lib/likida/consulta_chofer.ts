import { supabaseAdmin } from '@/lib/supabase/admin';
import { mxn } from '@/lib/formato';
import { acotada } from './presupuesto';
import { copiasDeComprobante } from './cuadre/engine';
import type { ConceptoGasto } from '@/types/likida';

// ═══════════════════════════════════════════════════════════════════════════
// LO QUE EL CHOFER PREGUNTA A MEDIO VIAJE.
//
// Hoy el agente entiende fotos y "ya acabé". Si el chofer escribe "¿cuánto
// llevo?" o "¿me falta algo?", no hay respuesta — y ese chofer levanta el
// teléfono y le pregunta a la oficina, que es exactamente lo que el producto
// vende evitar.
//
// ── SIN MODELO, Y NO POR AHORRAR ─────────────────────────────────────────
//
// Contestar "llevas $8,400 de $10,600" no requiere razonar: requiere una
// consulta y una plantilla. Un modelo aquí costaría dinero, agregaría latencia
// y —lo peor— podría INVENTAR la cifra. En un producto cuya regla número uno es
// no inventar números, meter un modelo entre la base y el chofer es exponerse
// gratis.
//
// El reconocimiento va por expresión regular porque un chofer pregunta de cinco
// formas, no de mil. Lo que la regla no entienda cae al agente de siempre, que
// ya existe: esto es un ATAJO delante de él, no un reemplazo.
//
// ── POR QUÉ EL SALDO CORRIENTE CAMBIA EL PRODUCTO ────────────────────────
//
// Con el saldo a la mano, el chofer sabe que le falta comprobar MIENTRAS sigue
// en ruta y todavía trae los tickets en la guantera. Hoy se entera al cerrar,
// cuando ya no puede hacer nada y la conversación se vuelve un reclamo. Es la
// misma información un día antes, y cambia quién resuelve el problema.
// ═══════════════════════════════════════════════════════════════════════════

export type TipoConsulta = 'saldo' | 'faltantes' | 'ultimo' | 'ayuda';

/**
 * ¿Qué está preguntando el chofer?
 *
 * Devuelve `null` cuando no es una consulta — y ese `null` importa tanto como
 * los aciertos: si esto se traga un mensaje que era otra cosa, el agente de
 * verdad nunca lo ve. Ante la duda, no se contesta aquí.
 */
export function interpretarPregunta(texto: string): TipoConsulta | null {
  const t = normalizar(texto);
  // Una consulta de estado es CORTA. El chatter de un chofer no lo es, y esa
  // diferencia hace casi todo el trabajo de separar los dos.
  if (!t || t.length > 45) return null;

  for (const [tipo, patron] of PATRONES) {
    if (patron.test(t)) return tipo;
  }
  return null;
}

/**
 * Minúsculas, sin acentos, sin puntuación y sin cortesías.
 *
 * SIN ACENTOS a propósito, y no por comodidad: `\b` en JavaScript se calcula con
 * [A-Za-z0-9_], así que una "ú" NO cuenta como letra y `\búltimo\b` jamás casa
 * con la forma acentuada — que es la correcta. Es la misma trampa que ya se
 * pisó con "terminé" en el procesador. Quitando el acento de una vez, el
 * problema deja de existir en lugar de esquivarse patrón por patrón.
 */
function normalizar(texto: string): string {
  let t = texto
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[¿?¡!.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // EN LAZO, no en una pasada. Con un solo `replace`, "oye jefe cuanto llevo"
  // perdía "oye" y se quedaba con "jefe cuanto llevo" — sin reconocer. Y
  // "buenas tardes jefe, ¿cuánto llevo?" fallaba por lo mismo: es la forma
  // EDUCADA de preguntar, o sea la que más escribe un operador a su patrón, y
  // era justo la que no funcionaba.
  for (let i = 0; i < 3; i++) {
    const antes = t;
    t = t
      .replace(/^(oye|hola|hey|jefe|patron|disculpa|perdon|buenas|buenos|dias|tardes|noches|que onda|una pregunta|pregunta|amigo)\s+/, '')
      .replace(/\s+(porfa|por favor|porfavor|gracias|plis|bro|jefe)$/, '');
    if (t === antes) break;
  }
  return t.trim();
}

/**
 * Colas que no cambian la pregunta: "cuánto llevo **en total**", "**hasta
 * ahorita**", "**del anticipo**".
 *
 * LISTA CERRADA, nunca `.*`. Una cola libre reabriría justo lo que el anclaje
 * cerró: "cuanto llevo de camino" no es una consulta de saldo, y con un comodín
 * lo sería. Cada sufijo está aquí porque alguien lo escribe, no por si acaso.
 */
const COLA = '(?: (hasta ahorita|hasta ahora|hasta el momento|en total|total|hoy|acumulado|comprobado|gastado|abonado|de gasto|de gastos|de dinero|del viaje|del anticipo|de anticipo|con el anticipo|en el viaje|por comprobar|por mandar|mas))*';

/**
 * Patrones ANCLADOS AL MENSAJE COMPLETO, no buscados dentro de él.
 *
 * Esta es la decisión que define el módulo. La primera versión buscaba palabras
 * sueltas —"falta", "saldo", "llegó"— y se tragaba veinticinco frases reales de
 * operador que nunca llegaban al agente: "ya me falta poco para llegar",
 * "se me acabó el saldo del celular", "no llego a tiempo". La peor contestaba
 * "el último que recibí fue diesel por $400" a un chofer que estaba avisando
 * que no llegaba.
 *
 * El daño de un falso positivo es asimétrico: un mensaje que este módulo
 * atiende por error NUNCA llega al agente, así que el chofer se queda sin
 * respuesta a lo que de verdad preguntó. Perder una consulta legítima solo
 * cuesta que la conteste el agente — más caro, pero correcto. Por eso se ancla.
 *
 * NO SE RECONOCEN "ayudame" NI "necesito ayuda", y es deliberado: en boca de un
 * operador de carretera eso es un auxilio, no una petición de menú. Contestarle
 * con la lista de opciones a alguien que se quedó tirado sería el peor mensaje
 * que este producto puede mandar. Van al agente, que sí puede leer el contexto.
 */
const PATRONES: Array<[TipoConsulta, RegExp]> = [
  ['faltantes', new RegExp(
    `^(y )?(que |algo )?me (falta|hace falta)(n)?( algo| alguno| alguna)?${COLA}$`
    + `|^(y )?falta algo( mas)?$`
    + `|^(y )?que me (falta|hace falta)${COLA}$`
    + `|^tengo (algo )?pendiente$`
    + `|^me falta(n)? (comprobantes?|tickets?)$`)],
  ['saldo', new RegExp(
    `^(y )?(cuanto|cuanto dinero|que tanto|que) (llevo|voy|vamos)${COLA}$`
    + `|^(y )?(como|que tal) (voy|vamos|va)${COLA}$`
    + `|^(y )?(mi |cual es mi |el )?saldo( actual| del viaje| del anticipo)?$`
    + `|^(y )?cuanto (me falta|me queda|llevo|voy)${COLA}$`
    + `|^(y )?cuanto he (comprobado|gastado|mandado|abonado)${COLA}$`)],
  ['ultimo', new RegExp(
    `^(y )?(cual (fue|es) )?(el )?ultimo( comprobante| ticket| gasto| que te mande)?$`
    + `|^que (recibiste|te llego|tienes)$`
    + `|^(ya )?(te )?llego( mi| el| la)? (ticket|foto|comprobante|xml)$`
    + `|^(ya )?te llego$`
    + `|^(y )?cuantos( comprobantes| tickets| gastos)? (llevo|van|tengo|llevamos)$`
    + `|^(y )?cuantas fotos (van|llevo|tengo)$`)],
  ['ayuda', new RegExp(
    `^(ayuda|menu|opciones|help)$`
    + `|^(el |un )?menu de opciones$`
    + `|^que (puedo (hacer|preguntar|mandar)|opciones tengo)$`
    + `|^como (funciona|le hago)$`)],
];

export interface EstadoViaje {
  anticipo: number;
  comprobado: number;
  comprobantes: number;
  ultimoConcepto: string | null;
  ultimoMonto: number | null;
  /** Comprobantes que el motor mandó a revisar. */
  enRevision: number;
}

export async function estadoDelViaje(tenantId: string, viajeId: string): Promise<EstadoViaje | null> {
  const admin = supabaseAdmin();
  // AUDITORÍA 18, ALTO (A23): con techo — esto contesta una pregunta del
  // chofer dentro del presupuesto del webhook; sin `acotada` un socket colgado
  // gastaba los 300 s de undici contra los 120 de la función.
  const [rViaje, rGastos] = await Promise.all([
    acotada(admin.from('viaje').select('anticipo').eq('id', viajeId).eq('tenant_id', tenantId).maybeSingle(),
      'estadoDelViaje.viaje'),
    // AUDITORÍA 28, TC-A2 (ALTO, mismo patrón que TC-1 en tools.ts): trae los
    // campos que `copiasDeComprobante` necesita (folio/folioNorm/cfdiUuid/
    // cfdiOrden) y en orden ASCENDENTE — la función marca la PRIMERA aparición
    // como el original, así que el orden decide cuál copia se cuenta. Antes
    // esta consulta sumaba CADA fila (foto ticket + foto acercamiento son el
    // flujo normal, no el caso raro) y podía decirle al chofer "no te falta
    // nada" con comprobantes de verdad sin mandar.
    acotada(admin.from('gasto').select('id, concepto, monto, ocr_confianza, folio, folio_norm, cfdi_uuid, cfdi_orden, created_at')
      .eq('viaje_id', viajeId).eq('tenant_id', tenantId).order('created_at', { ascending: true }),
    'estadoDelViaje.gastos'),
  ]);

  // FALLAR CERRADO. supabase-js reporta el error POR VALOR, así que sin
  // comprobarlo una base caída se lee como "no hay gastos" — y este módulo le
  // diría al chofer "llevas $0.00 de $10,600, te faltan $10,600" habiendo
  // mandado veinte tickets. Es la peor forma de equivocarse que tiene el
  // producto: una cifra falsa que suena a medición. Se lanza y quien llama
  // decide qué decir; callar es preferible a mentir.
  if (rViaje.error) throw new Error(`estadoDelViaje/viaje: ${rViaje.error.message}`);
  if (rGastos.error) throw new Error(`estadoDelViaje/gastos: ${rGastos.error.message}`);

  const viaje = rViaje.data;
  if (!viaje) return null;

  // Misma forma que consume `copiasDeComprobante` en tools.ts/engine.ts.
  const gastos = (rGastos.data ?? []).map((g) => ({
    id: String(g.id),
    concepto: g.concepto as ConceptoGasto,
    monto: typeof g.monto === 'number' ? g.monto : Number(g.monto ?? 0),
    folio: (g.folio as string | null) || undefined,
    folioNorm: (g.folio_norm as string | null) || undefined,
    cfdiUuid: (g.cfdi_uuid as string | null) || undefined,
    cfdiOrden: g.cfdi_orden != null ? Number(g.cfdi_orden) : undefined,
    ocrConfianza: (g.ocr_confianza as number | null) ?? undefined,
    createdAt: g.created_at as string,
  }));
  const copias = copiasDeComprobante(gastos);
  // Misma regla que `totalComprobado` en engine.ts: ni copias ni montos <= 0.
  const originales = gastos.filter((g) => !copias.has(g.id) && g.monto > 0);
  const comprobado = originales.reduce((s, g) => s + g.monto, 0);
  // El orden de la consulta es ascendente (lo exige copiasDeComprobante), así
  // que "el último" es el ÚLTIMO elemento de la lista completa, no el primero
  // — y se busca sobre TODOS los gastos (no solo `originales`): una copia
  // recién llegada sigue siendo lo último que mandó el chofer, aunque no
  // sume al comprobado.
  const ultimo = gastos.at(-1);

  return {
    anticipo: Number(viaje.anticipo ?? 0),
    comprobado,
    comprobantes: originales.length,
    ultimoConcepto: ultimo?.concepto ?? null,
    ultimoMonto: ultimo ? ultimo.monto : null,
    // Confianza baja = el motor lo va a mandar a revisión. Decírselo ahora le
    // da la oportunidad de reenviar la foto mientras sigue en ruta.
    enRevision: gastos.filter((g) => g.ocrConfianza !== undefined && Number(g.ocrConfianza) < 0.7).length,
  };
}

/**
 * La respuesta, armada con datos y sin adornos.
 *
 * NUNCA se dice "vas bien" ni "todo en orden": eso es una interpretación, y la
 * hace el motor de cuadre con la política de la flota, no un mensaje de estado.
 * Aquí solo se reportan cifras que existen.
 */
export function armarRespuesta(tipo: TipoConsulta, e: EstadoViaje | null): string {
  if (!e) return 'Todavía no tienes un viaje abierto. En cuanto te asignen uno te aviso.';

  const falta = e.anticipo - e.comprobado;

  switch (tipo) {
    case 'saldo': {
      if (e.anticipo <= 0) {
        // Un anticipo en 0 puede ser "no le dieron nada" o "nadie lo capturó".
        // No se afirma ninguna de las dos: se dice lo que sí se sabe.
        return `Llevas ${e.comprobantes} comprobante(s) por ${mxn(e.comprobado)}. Este viaje no tiene anticipo registrado, así que no te puedo decir cuánto te falta.`;
      }
      const linea = falta > 0
        ? `Te faltan ${mxn(falta)} por comprobar.`
        : falta < 0
          ? `Comprobaste ${mxn(-falta)} más que el anticipo.`
          : 'Vas justo con el anticipo.';
      return `Llevas ${mxn(e.comprobado)} de ${mxn(e.anticipo)} — ${e.comprobantes} comprobante(s). ${linea}`;
    }

    case 'faltantes': {
      const partes: string[] = [];
      if (e.anticipo > 0 && falta > 0) partes.push(`Te faltan ${mxn(falta)} por comprobar.`);
      if (e.enRevision > 0) partes.push(`${e.enRevision} foto(s) se leyeron mal; si puedes, vuelve a mandarlas.`);
      if (partes.length > 0) return partes.join(' ');

      // SIN ANTICIPO NO SE AFIRMA QUE NO FALTA NADA. "Por mi parte no falta
      // nada" es una afirmación sobre el saldo, y con `anticipo === 0` no hay
      // saldo contra qué medirlo — la rama de arriba lo reconoce explícitamente.
      // Decir las dos cosas en la misma conversación es contradecirse, y el
      // chofer cerraría el viaje creyendo que comprobó todo.
      if (e.anticipo <= 0) {
        return `Llevo ${e.comprobantes} comprobante(s) tuyos por ${mxn(e.comprobado)}. Este viaje no tiene anticipo registrado, así que no te puedo decir si te falta algo — eso lo revisa tu oficina.`;
      }
      return 'Por mi parte no falta nada. Cuando acabes, escribe que terminaste y cierro tu liquidación.';
    }

    case 'ultimo': {
      if (!e.ultimoConcepto) return 'Todavía no me llega ningún comprobante de este viaje.';
      // Sin monto NO se imprime `$0.00`: un cero que parece medición es
      // justamente la cifra inventada que este producto no imprime. Se dice el
      // concepto y se calla lo que no se sabe.
      const cuanto = e.ultimoMonto !== null && Number.isFinite(e.ultimoMonto)
        ? ` por ${mxn(e.ultimoMonto)}`
        : ' (sin monto legible)';
      return `El último que recibí fue ${e.ultimoConcepto}${cuanto}. Van ${e.comprobantes} en total.`;
    }

    case 'ayuda':
      // ARRANCA RECONOCIENDO LA OTRA LECTURA, y no es adorno.
      //
      // "ayuda" a secas se reconoce como petición de menú, pero en boca de un
      // operador en carretera puede ser un auxilio — y contestarle una lista de
      // opciones a alguien que se quedó tirado sería el peor mensaje que este
      // producto puede mandar. Las formas explícitas ("ayúdame", "auxilio",
      // "ayuda me quedé tirado") ya caen al agente a propósito; lo que queda es
      // el "ayuda" pelón, que es ambiguo de verdad.
      //
      // En lugar de apostar por una de las dos lecturas, se atienden las dos en
      // dos renglones. Cuesta una línea y quita el único caso donde este atajo
      // podía hacer daño de verdad.
      return 'Si traes una emergencia en carretera, háblale directo a tu jefe de flota — por aquí no te puedo auxiliar. 🚨\n\n'
        + 'Si querías saber qué hago: mándame la foto de cada ticket y te los voy acusando. '
        + 'Puedes preguntarme "¿cuánto llevo?" cuando quieras. '
        + 'Cuando acabes, escribe que terminaste y te mando tu liquidación en PDF.';
  }
}

/** El atajo completo: interpreta, consulta y contesta. `null` = no era consulta. */
export async function responderConsulta(
  texto: string,
  tenantId: string,
  viajeId: string | null,
): Promise<string | null> {
  const tipo = interpretarPregunta(texto);
  if (!tipo) return null;
  const estado = viajeId ? await estadoDelViaje(tenantId, viajeId) : null;
  return armarRespuesta(tipo, estado);
}
