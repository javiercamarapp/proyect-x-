// ═══════════════════════════════════════════════════════════════════════════
// LO QUE SALIÓ MAL EN UNA RÁFAGA SE DICE UNA SOLA VEZ, AL FINAL.
//
// El problema, medido: un chofer fotografía sus ~22 tickets en la gasolinera y
// los manda de golpe. Tres caminos del intake contestaban POR FOTO —el fallo
// técnico del OCR, la foto ilegible y la fecha dudosa— y los tres disparadores
// son SISTÉMICOS: un 429 del proveedor de visión tumba las 22 a la vez, y una
// gasolinera mal iluminada de noche también. O sea que el caso normal no es
// "una de 22 falló": es "las 22 fallaron", y el operador recibe 22 mensajes
// idénticos seguidos.
//
// Este repo ya arregló ese antipatrón tres veces —el acuse de ráfaga, el aviso
// de acercamiento, el acuse de comprobante— y siempre con el mismo mecanismo:
// se calla en el camino de cada foto y se resume al cerrar la ráfaga. Aquí vive
// la libreta donde se anota mientras tanto.
//
// ── POR QUÉ EN MEMORIA Y NO EN LA BASE ─────────────────────────────────────
//
// Las fotos de una ráfaga llegan en UN POST de Meta y se procesan en UN
// `after()` del MISMO proceso (route.ts las corre con un pool), así que un Map
// de módulo las ve todas. Una tabla costaría un viaje de red por foto —en el
// camino que ya es el más caro del sistema— para cubrir un caso que hoy no
// ocurre: la ráfaga repartida entre dos invocaciones.
//
// Y cuando ese caso ocurra, el modo de falla es benigno y conocido: cada
// invocación resume LO SUYO. Son dos mensajes en vez de uno, nunca 22, y nunca
// un silencio. Ese es el peor caso aceptable; el de hoy no lo es.
//
// ── EL CONTADOR NO ES LA BARRERA ───────────────────────────────────────────
//
// `intake_pendientes` (conv.ts / mig. 0031) decide CUÁNDO se cierra la ráfaga;
// esta libreta solo decide QUÉ se dice al cerrarla. Se mantienen separados a
// propósito: aquél es el que protege el dinero —que "listo" no cuadre sobre
// datos parciales— y no puede depender de memoria de proceso.
// ═══════════════════════════════════════════════════════════════════════════

import { mxn } from '@/lib/formato';

/** Qué le pasó a una foto que no terminó bien. */
export type TipoIncidencia =
  /** Falló NUESTRO lado (429, truncamiento, provider caído). Reenviar sirve. */
  | 'fallo_tecnico'
  /** La foto de verdad no se lee. Reenviarla con mejor luz sirve. */
  | 'ilegible'
  /** El gasto entró, pero su fecha no cae en la ventana del viaje. */
  | 'fecha_dudosa'
  /** Se leyó, no se pudo probar, y ya no quedaban botones que gastar. */
  | 'duda'
  /**
   * AUDITORÍA 24 · AGEN-11 (BAJO). La MISMA foto otra vez (dedup por hash).
   * No es un fallo —el comprobante ya está en el viaje— pero sí cuenta en
   * «de tus N fotos», y sin decirlo la cuenta no cierra: el chofer lee
   * «de tus 5 fotos… llevo 4 comprobantes», la reenvía, y vuelve el mismo
   * silencio. No pide nada: no hay nada que hacer con ella.
   */
  | 'repetida';

export interface Incidencia {
  tipo: TipoIncidencia;
  /** Solo cuando se conoce: un fallo técnico no trae monto que enseñar. */
  monto?: number | null;
  etiqueta?: string | null;
  /**
   * El mensaje que se le manda SI resulta que esta foto llegó sola.
   *
   * ── POR QUÉ SE GUARDA EN VEZ DE MANDARSE ─────────────────────────────────
   *
   * El camino de cada foto NO PUEDE SABER si hubo ráfaga. Lo intentaba con
   * «el contador de intake pasó de 0 a 1», y esa condición es verdadera para
   * la PRIMERA foto de toda ráfaga —el incremento es atómico, así que en un
   * fajo de 22 exactamente una ve el 1—. O sea que el fajo entero producía el
   * mensaje individual de esa primera foto Y DESPUÉS el resumen contándola
   * otra vez: el chofer leía «se me trabó ese comprobante» y, debajo, «de tus
   * 22 fotos, 22 se me trabaron». El mismo hecho, dos veces, y la segunda con
   * un número que parecía contradecir a la primera.
   *
   * Quien SÍ lo sabe es el cierre: cuando el contador vuelve a 0, `vistas`
   * dice cuántas pasaron. Así que el detalle que solo este camino conoce —el
   * ticket concreto, si el huérfano se guardó o no— se anota aquí, y el cierre
   * elige: una foto → este texto; varias → el resumen. Nunca los dos.
   */
  mensajeSolo?: string;
}

interface Bandeja {
  /** Fotos que pasaron por aquí en esta ráfaga. Es el "de tus N fotos". */
  vistas: number;
  incidencias: Incidencia[];
  /** Confirmaciones con botón YA enviadas en esta ráfaga (tope de acuse_ticket). */
  confirmaciones: number;
  /** Acuses de las fotos que entraron bien, pendientes de decidir si se mandan. */
  acuses: string[];
  /** A quién contestarle si la ráfaga se cierra POR CORTE (auditoría 22,
   *  AGEN-A2). Se guarda al anotar la foto para no pagar una consulta justo
   *  cuando el corte ocurre por falta de presupuesto. */
  telefono: string | null;
  /**
   * AG-B1 (auditoría 28, agentico.md:38) — el tenant de esta ráfaga, para que
   * `cerrarRafagasPorCorte` (processor.ts) pueda registrar el costo del
   * WhatsApp del cierre por corte. `cerrarRafagasPorCorte` es función de
   * módulo y no tiene `op.tenantId` a la mano; la bandeja sí lo sabe porque
   * `anotarFoto` corre dentro de `processInbound`, con `op` resuelto.
   */
  tenantId: string | null;
}

/**
 * Techo de anotaciones por viaje. Una ráfaga real trae ~22 fotos; 60 es 3× eso.
 * Pasado el techo se deja de anotar el detalle pero se sigue CONTANDO, porque
 * el número es lo que hace que el resumen no mienta.
 */
const MAX_INCIDENCIAS = 60;

/**
 * Techo de viajes con ráfaga abierta a la vez en un proceso. La bandeja se
 * borra al cerrar la ráfaga; esto solo cubre el caso en que el `-1` de la
 * barrera no llegue a devolver 0 (RPC caída) y la bandeja quede huérfana.
 */
const MAX_VIAJES = 200;

const bandejas = new Map<string, Bandeja>();

function abrir(viajeId: string): Bandeja {
  let b = bandejas.get(viajeId);
  if (!b) {
    if (bandejas.size >= MAX_VIAJES) {
      // Se tira la más vieja por orden de alta. Un Map conserva ese orden, y
      // `set` sobre una llave existente NO la mueve al final — que es justo lo
      // que hace fiable este desalojo.
      const vieja = bandejas.keys().next();
      if (!vieja.done) bandejas.delete(vieja.value);
    }
    b = { vistas: 0, incidencias: [], confirmaciones: 0, acuses: [], telefono: null, tenantId: null };
    bandejas.set(viajeId, b);
  }
  return b;
}

/**
 * Una foto más de esta ráfaga. Se llama en cuanto la barrera acepta su `+1`.
 *
 * `empiezaRafaga` = el contador de intake pasó de 0 a 1, o sea que NO había
 * nada en vuelo cuando ésta se registró. Es el único límite fiable entre dos
 * ráfagas, y sirve para tirar lo que haya quedado de una anterior que nunca
 * llegó a cerrarse — pasa cuando una invocación muere entre el `+1` y el `-1`
 * y deja el contador atascado hasta que la 0031 lo olvida (10 min). Sin esto,
 * `vistas` arrastraría fotos de la ráfaga muerta y el resumen diría «de tus 9
 * fotos» a quien mandó tres. Una cifra inventada, que es la regla que no se
 * rompe en este repo.
 */
export function anotarFoto(viajeId: string, empiezaRafaga = false, telefono?: string, tenantId?: string | null): void {
  if (empiezaRafaga) bandejas.delete(viajeId);
  const b = abrir(viajeId);
  b.vistas += 1;
  // AUDITORÍA 22, AGEN-A2: el teléfono se guarda AQUÍ para que un cierre por
  // corte pueda hablarle al chofer sin pagar una consulta — y el corte ocurre
  // justamente cuando ya no queda presupuesto para consultas.
  if (telefono) b.telefono = telefono;
  // AG-B1: mismo criterio que el teléfono — se guarda AQUÍ (con `op.tenantId`
  // en mano) para que el cierre por corte pueda registrar el costo real del
  // WhatsApp sin pagar una consulta.
  if (tenantId) b.tenantId = tenantId;
}

/**
 * Las ráfagas que quedaron ABIERTAS en este proceso, con a quién contestarles.
 *
 * ── AUDITORÍA 22, AGEN-A2 (ALTO) ──────────────────────────────────────────
 * La libreta solo se cierra en la foto que no tiene otra detrás en su cadena.
 * Pero la cadena se corta con `break` cuando `processInbound` devuelve
 * `'sin_tiempo'`, y ese corte es el caso NORMAL del fajo grande: 22 fotos a
 * 8-15 s cada una no caben en una invocación.
 *
 * Resultado: la libreta con `vistas: 6` y tres incidencias nunca se cerraba, y
 * el proceso moría con ella. El chofer mandó seis fotos, tres salieron
 * ilegibles, y no recibió nada — ni el resumen ni el aviso de que tres no se
 * leyeron. El cron levanta el resto en OTRA invocación, con libreta nueva, así
 * que nadie va a decirlo después: se perdió con el proceso.
 */
export function bandejasAbiertas(): Array<{ viajeId: string; telefono: string | null; tenantId: string | null }> {
  return [...bandejas.entries()].map(([viajeId, b]) => ({ viajeId, telefono: b.telefono ?? null, tenantId: b.tenantId ?? null }));
}

/**
 * El acuse de una foto que entró bien: «Anotado ✅ …».
 *
 * SE ANOTA, NO SE MANDA. Si la foto vino sola, al cerrar se envía y el chofer
 * sabe que su ticket llegó — que es el agujero que se midió el 24-ago-2026:
 * fotos espaciadas 10–35 s, cada una cerrando su propia ráfaga de UNA, cada
 * una en silencio, y el chofer preguntando «Que pasó?».
 *
 * Si vino en ráfaga NO se manda ninguno: el resumen consolidado ya dice
 * cuántos comprobantes lleva y por cuánto, y seis acuses más un resumen son
 * los siete mensajes que este módulo entero existe para no mandar.
 */
export function anotarAcuse(viajeId: string, texto: string): void {
  const b = abrir(viajeId);
  if (b.acuses.length < MAX_INCIDENCIAS) b.acuses.push(texto);
}

/** Algo que hay que contarle al operador AL CERRAR, no ahora. */
export function anotarIncidencia(viajeId: string, inc: Incidencia): void {
  const b = abrir(viajeId);
  if (b.incidencias.length < MAX_INCIDENCIAS) b.incidencias.push(inc);
  else b.incidencias.push({ tipo: inc.tipo });   // sin detalle, pero cuenta
}

/**
 * Reserva un turno de confirmación con botón. Devuelve el ORDINAL de esta
 * confirmación dentro de la ráfaga (1, 2, 3…), que es contra lo que el llamador
 * compara `MAX_CONFIRMACIONES_SEGUIDAS`.
 */
export function pedirTurnoDeConfirmacion(viajeId: string): number {
  const b = abrir(viajeId);
  b.confirmaciones += 1;
  return b.confirmaciones;
}

export interface RafagaCerrada {
  vistas: number;
  incidencias: Incidencia[];
  /** Los acuses anotados. Solo se usan si NO hubo ráfaga. */
  acuses: string[];
}

/** Cierra la ráfaga: devuelve lo anotado y OLVIDA el viaje. */
export function cerrarRafaga(viajeId: string): RafagaCerrada {
  const b = bandejas.get(viajeId);
  bandejas.delete(viajeId);
  return { vistas: b?.vistas ?? 0, incidencias: b?.incidencias ?? [], acuses: b?.acuses ?? [] };
}

/** Solo para pruebas: el Map es de módulo y se comparte entre casos. */
export function olvidarRafagas(): void {
  bandejas.clear();
}

/** Los montos de un tipo, ya formateados y sin los que no se conocen. */
function montosDe(incidencias: Incidencia[], tipo: TipoIncidencia): string[] {
  return incidencias
    .filter((i) => i.tipo === tipo && typeof i.monto === 'number' && i.monto > 0)
    .map((i) => mxn(i.monto as number));
}

/** "$1.00 y $2.00" · "$1.00, $2.00 y $3.00". Máximo tres, para no hacer lista. */
function enumerar(partes: string[]): string {
  const vistos = partes.slice(0, 3);
  const cola = partes.length > 3 ? ` y ${partes.length - 3} más` : '';
  if (vistos.length === 1) return `${vistos[0]}${cola}`;
  return `${vistos.slice(0, -1).join(', ')} y ${vistos[vistos.length - 1]}${cola}`;
}

/**
 * El párrafo que resume lo que salió mal en la ráfaga. `null` = no hay nada que
 * decir, y entonces NO se manda nada: el silencio es correcto cuando todo entró.
 *
 * PURA a propósito. Es el texto que decide si un chofer entiende que le faltan
 * tres comprobantes o cree que mandó todo bien, y se tiene que poder probar sin
 * base de datos ni WhatsApp de por medio.
 */
export function lineaIncidencias(vistas: number, incidencias: Incidencia[]): string | null {
  if (!incidencias.length) return null;

  const cuenta = (t: TipoIncidencia) => incidencias.filter((i) => i.tipo === t).length;
  const tecnicos = cuenta('fallo_tecnico');
  const ilegibles = cuenta('ilegible');
  const dudosas = cuenta('fecha_dudosa');
  const repetidas = cuenta('repetida');

  // OJO: `duda` NO tiene frase propia aquí. Su renglón lo escribe
  // `mensajeDemasiadasDudas` (acuse_ticket.ts), que además lleva el saldo del
  // viaje; decirlo en los dos sitios ponía la misma cuenta dos veces en un
  // mismo mensaje. Se cuenta igual —entra en `vistas` y en el log— pero se
  // enuncia una sola vez.
  const frases: string[] = [];
  if (tecnicos) {
    frases.push(`*${tecnicos}* se ${tecnicos === 1 ? 'me trabó' : 'me trabaron'} de mi lado ⚙️ ` +
      `(no ${tecnicos === 1 ? 'es tu foto' : 'son tus fotos'}; ${tecnicos === 1 ? 'la guardé' : 'las guardé'} y no se ${tecnicos === 1 ? 'pierde' : 'pierden'})`);
  }
  if (ilegibles) {
    frases.push(`*${ilegibles}* no ${ilegibles === 1 ? 'la pude leer' : 'las pude leer'} 🔍`);
  }
  if (dudosas) {
    const montos = montosDe(incidencias, 'fecha_dudosa');
    const detalle = montos.length ? `: ${montos.length === 1 ? 'la de' : 'las de'} ${enumerar(montos)}` : '';
    frases.push(`*${dudosas}* ${dudosas === 1 ? 'trae' : 'traen'} fecha dudosa${detalle}`);
  }
  if (repetidas) {
    // AGEN-11: se DICE, no se pide nada. El comprobante ya está contado; lo
    // único que faltaba era que la resta cuadrara con lo que él mandó.
    const montos = montosDe(incidencias, 'repetida');
    const detalle = montos.length ? `: ${montos.length === 1 ? 'la de' : 'las de'} ${enumerar(montos)}` : '';
    frases.push(`*${repetidas}* ${repetidas === 1 ? 'venía repetida (ya la tenía)' : 'venían repetidas (ya las tenía)'}${detalle}`);
  }

  // Solo había dudas de lectura: las dice `mensajeDemasiadasDudas` y aquí no
  // queda nada. Devolver una frase vacía dejaría un párrafo con un punto solo.
  if (!frases.length) return null;

  // ── AUDITORÍA 24 · AGEN-8 (MEDIO): EL TOTAL NO SE AFIRMA ────────────────
  //
  // `vistas` es lo que vio ESTA invocación, no el fajo del chofer. En el
  // piloto la cadena se parte: la foto 1 la toma el webhook y cierra su
  // propia ráfaga de una; las 2-5 esperan al cron, que las lista en lotes de
  // 40 y puede partirlas otra vez. El chofer mandó 5 y leía «Anotado ✅»,
  // «De tus 2 fotos…», «De tus 2 fotos…». Ninguna de las tres era mentira
  // dentro de su proceso, y las tres lo eran para él.
  //
  // Contar bien exigiría un contador durable por chofer; lo que se hace es
  // NO afirmar una cifra que no se midió. El total que sí es verdad —los
  // comprobantes que hay en el viaje, leídos de la base— ya va en el mismo
  // mensaje, y ese sí es el que decide si vuelve a fotografiar un ticket.
  const encabezado = vistas > 1 ? 'De las fotos que me mandaste, ' : '';
  const cuerpo = frases.length === 1
    ? frases[0]
    : `${frases.slice(0, -1).join(', ')} y ${frases[frases.length - 1]}`;
  // LO QUE SE LE PIDE TIENE QUE CUADRAR CON LO QUE FALLÓ. Esto decía siempre
  // «tomadas otra vez, con buena luz», y sobre un `fallo_tecnico` eso
  // CONTRADICE al renglón que acaba de escribirse encima —«no son tus fotos»—
  // y le echa encima la culpa de un 429 nuestro: vuelve a tomar veintidós
  // fotos que estaban bien y vuelven a fallar igual, porque la luz nunca fue
  // el problema. Es la misma mentira que la rama sin-viaje ya había quitado de
  // su mensaje individual (`huerfanos_flujo.test.ts`), viva todavía aquí.
  const uno = (n: number) => n === 1;
  let pide = '';
  if (ilegibles && !tecnicos && !dudosas) {
    pide = uno(ilegibles)
      ? '\n\nReenvíamela con buena luz y la dejo bien. 📸'
      : '\n\nReenvíamelas con buena luz y las dejo bien. 📸';
  } else if (tecnicos && !ilegibles && !dudosas) {
    pide = uno(tecnicos)
      ? '\n\nReenvíamela en un rato —el problema fue mío, no tu foto— y la dejo bien. 📸'
      : '\n\nReenvíamelas en un rato —el problema fue mío, no tus fotos— y las dejo bien. 📸';
  } else if (dudosas && !ilegibles && !tecnicos) {
    pide = uno(dudosas)
      ? '\n\nMándame otra foto de ese ticket donde se alcance a ver la fecha. 📸'
      : '\n\nMándame otra foto de esos tickets donde se alcance a ver la fecha. 📸';
  } else if (ilegibles) {
    // Mezcla CON ilegibles: la luz solo aplica a ésas, y se dice así. Atribuirla
    // a todas volvería a echarle la culpa de un 429 nuestro.
    pide = '\n\nReenvíame esas fotos —las que salieron oscuras, con buena luz— y las dejo bien. 📸';
  } else if (tecnicos || dudosas) {
    // Mezcla SIN ilegibles: ninguna falló por la foto, así que no se menciona
    // la luz por ningún lado.
    pide = '\n\nReenvíame esas fotos y las dejo bien. 📸';
  }
  return `${encabezado}${cuerpo}.${pide}`;
}
