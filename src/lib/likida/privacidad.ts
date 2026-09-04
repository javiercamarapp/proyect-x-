import { appUrl } from '@/lib/env';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { acotada } from './presupuesto';

// ═══════════════════════════════════════════════════════════════════════════
// AVISO DE PRIVACIDAD EN EL CANAL — modalidad simplificada.
//
// QUIÉN lo debe: el RESPONSABLE, y ese es la FLOTA (LFPDPPP art. 14). Likida es
// persona encargada —trata los datos por cuenta de ella (art. 2 fr. XII)— y no
// le toca redactarlo ni responde por su omisión. Este módulo NO es "el aviso de
// Likida": es el mecanismo para que la flota ponga el suyo, que sin producto no
// puede aunque quiera.
//
// QUÉ exige el canal: los datos entran por WhatsApp, o sea por medio
// electrónico, así que aplica el art. 16 fr. II — modalidad SIMPLIFICADA con al
// menos las fracciones I a IV del art. 15, y señalar dónde se consulta el
// integral. El aviso completo NO cabe ni debe ir en un mensaje de WhatsApp.
//
// Verificado contra el texto vigente (DOF 20-mar-2025, últ. reforma 14-nov-2025)
// en normas/lfpdppp-15-16.yaml.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Lo MEDIDO sobre el rastreo GPS de la flota, para que el aviso declare el
 * tratamiento que ESA flota tiene y no el de todas (refinamiento del C.15,
 * 28-ago-2026). Tres caminos reales escriben geolocalización y solo UNO
 * depende de esta señal:
 *
 *   1. El poller del proveedor (sincronizar_gps.ts, cron /api/cron/gps cada
 *      5 min) — SOLO corre con credencial activa en `conector_credencial`.
 *   2. El pin que el chofer manda por el chat (processor.ts →
 *      registrarUbicacionChofer) — NO depende de ningún conector.
 *   3. El pin de asistencia (asistencia_wa.ts → anclarUbicacionIncidencia) —
 *      tampoco.
 *
 * Por eso la señal solo gobierna el RENGLÓN DEL PROVEEDOR: los pines se
 * declaran SIEMPRE, porque el aviso viaja por el mismo chat desde el que
 * cualquier chofer puede mandar uno — la capacidad existe en cuanto existe la
 * conversación, y el aviso informa de lo que puede pasar, no de lo que ya pasó.
 *
 * El criterio de la señal también es de CAPACIDAD, no de hecho: credencial
 * activa = el cron va a intentar traer posiciones, y el consentimiento tiene
 * que ser PREVIO a la primera. Esperar a que haya filas en `posicion` sería
 * avisar después de tratar.
 *
 * `no_medible` = la consulta no contestó, que NO es «sin conector»: se declara
 * el caso amplio (falla cerrado — un aviso que declara de más un rato es
 * inexacto; uno que calla un tratamiento que ocurre es el bug original C.15).
 */
export type SenalGps = 'conectado' | 'sin_conector' | 'no_medible';

/** Los datos de la FLOTA. Sin ellos no hay aviso: el responsable es ella. */
export interface DatosResponsable {
  /** Razón social tal cual está en el RFC. */
  razonSocial: string;
  /** Domicilio fiscal. Art. 15 fr. I lo pide junto con la identidad. */
  domicilio: string;
  /** Dónde vive el aviso integral. Art. 16 fr. II obliga a señalarlo. */
  urlAvisoIntegral: string;
  /**
   * Señal MEDIDA en `conector_credencial` (ver `SenalGps`). Opcional a
   * propósito y con ausencia = `no_medible`: quien no midió recibe el caso
   * amplio, nunca el silencio. `getDatosResponsable` la mide siempre; un
   * llamador que arme este objeto a mano sin medir declara de más, no de menos.
   */
  gps?: SenalGps;
}

/**
 * Estado de la liga al aviso integral.
 *
 * - `ok`        — la liga tiene forma de sitio público consultable.
 * - `ausente`   — la flota no capturó ninguna.
 * - `inservible`— hay algo escrito, pero no es una dirección que alguien pueda
 *                 abrir desde WhatsApp (no parsea, no es http/https, el host no
 *                 tiene dominio de primer nivel, o es un marcador de relleno).
 */
export type EstadoAvisoIntegral = 'ok' | 'ausente' | 'inservible';

/**
 * Marcadores de relleno que la gente deja al configurar un tenant. No es una
 * lista de "dominios prohibidos": es la lista de cosas que NADIE quiso publicar
 * como aviso y que solo llegan aquí porque alguien no terminó de capturar.
 */
/** Dominios enteros de plantilla: se comparan contra el HOST, no contra la URL. */
const HOSTS_DE_RELLENO = [
  'example.com', 'example.org', 'example.net', 'ejemplo.com', 'ejemplo.mx',
  'dominio.com', 'localhost', 'test.com',
];

/**
 * Palabras que solo son marcador de relleno cuando están SUELTAS.
 *
 * ── POR QUÉ NO ES UN `includes` (auditoría 6, legal) ────────────────────────
 *
 * Antes se buscaban como substring sobre la URL completa, y `'pendiente'` y
 * `'todo'` viven dentro de palabras españolas normales. Medido con el módulo
 * real, contra dominios plausibles del sector que el censo de Likida cubre:
 *
 *   https://transportistaindependiente.mx/aviso   → inservible  (in-de-PENDIENTE)
 *   https://autotransportesindependientes.com.mx  → inservible
 *   https://operadorindependiente.mx/aviso        → inservible
 *   https://metodologiatransporte.mx/aviso        → inservible  (me-TODO-logía)
 *
 * "Independiente" es exactamente como se anuncia media flota mexicana. Y el
 * coste no es cosmético: al marcar la liga inservible, el aviso simplificado
 * sale diciendo que la empresa NO ha publicado su aviso integral —una
 * afirmación falsa sobre el cumplimiento del cliente— y el operador se queda
 * sin el canal ARCO que el art. 15 fr. V exige, teniendo uno publicado.
 *
 * Con frontera de palabra, `independiente` y `metodología` pasan, y
 * `/aviso-pendiente` o `?url=todo` siguen cayendo.
 */
const PALABRAS_DE_RELLENO = [
  'tudominio', 'tu-dominio', 'midominio', 'mi-dominio',
  'changeme', 'cambiar', 'pendiente', 'por-definir', 'pordefinir', 'todo',
];

/**
 * ¿La liga del aviso integral sirve para ponerla en un mensaje?
 *
 * ES UNA REVISIÓN DE FORMA, Y HAY QUE LEERLA COMO TAL: dice que la cadena tiene
 * pinta de dirección pública, NO que el sitio exista. Un dominio bien escrito y
 * sin registrar (NXDOMAIN) pasa esta función y el operador igual se topa con un
 * error de red. Lo único que prueba existencia es `sondearAvisoIntegral`, que
 * sale a la red y por eso no puede correr en el camino de cada mensaje.
 *
 * Por qué existe de todos modos: el art. 16 fr. II obliga a "señalar el sitio
 * donde se podrá consultar el aviso integral". Señalar `pendiente` o
 * `www.ejemplo` no es señalar un sitio, y mandarlo como si lo fuera convierte
 * el aviso en una constancia de algo que no ocurrió.
 */
export function revisarAvisoIntegral(url: string | null | undefined): EstadoAvisoIntegral {
  const s = url?.trim();
  if (!s) return 'ausente';

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return 'inservible';
  }
  // Solo web. Un `mailto:` o un `ftp:` no es "el sitio donde se podrá consultar".
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'inservible';

  // El host tiene que tener dominio de primer nivel alfabético: eso descarta de
  // un golpe `localhost`, los nombres internos sin punto y las IP desnudas
  // (cuyo último tramo es numérico), que no son un sitio público consultable.
  const host = u.hostname.toLowerCase();
  if (!/\.[a-z]{2,}$/.test(host)) return 'inservible';

  if (HOSTS_DE_RELLENO.some((r) => host === r || host.endsWith(`.${r}`))) return 'inservible';

  // Frontera de palabra sobre la URL completa: en una dirección los separadores
  // son `/`, `-`, `_`, `.`, `?`, `=`, `&`, así que la palabra cuenta como suelta
  // cuando no está pegada a otras letras. `independiente` deja de disparar
  // `pendiente`; `/aviso-pendiente` y `?url=todo` siguen cayendo.
  const completa = s.toLowerCase();
  const suelta = (r: string) =>
    new RegExp(`(?<![a-z0-9])${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(completa);
  if (PALABRAS_DE_RELLENO.some(suelta)) return 'inservible';

  return 'ok';
}

/** Lo que el sondeo de red encontró. El motivo es para el log, no para el operador. */
export type SondeoAvisoIntegral = { abre: true } | { abre: false; motivo: string };

/**
 * Abre de verdad la liga del aviso integral. Es lo ÚNICO que distingue un
 * dominio bien escrito de un dominio que no existe.
 *
 * NO va en el camino de cada mensaje: es una llamada de red con latencia y con
 * falsos negativos por corte transitorio, y hacer depender de ella el envío del
 * aviso sería cambiar un incumplimiento por otro. Va en un arranque, en un
 * preflight de despliegue o en un cron, donde un fallo se puede mirar.
 *
 * `fetchImpl` se inyecta para poder probarlo sin red.
 */
export async function sondearAvisoIntegral(
  url: string | null | undefined,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<SondeoAvisoIntegral> {
  const estado = revisarAvisoIntegral(url);
  if (estado !== 'ok') return { abre: false, motivo: `liga ${estado}` };

  const f = opts.fetchImpl ?? fetch;
  const destino = (url as string).trim();
  const señal = () => AbortSignal.timeout(opts.timeoutMs ?? 5000);

  try {
    let res = await f(destino, { method: 'HEAD', redirect: 'follow', signal: señal() });
    // Hay servidores que no implementan HEAD y contestan 405/501 teniendo la
    // página. Se reintenta con GET antes de declarar muerta una liga que vive.
    if (res.status === 405 || res.status === 501) {
      res = await f(destino, { method: 'GET', redirect: 'follow', signal: señal() });
    }
    if (!res.ok) return { abre: false, motivo: `http ${res.status}` };
    return { abre: true };
  } catch (e) {
    // Aquí cae el NXDOMAIN: sin zona DNS, `fetch` falla antes de hablar con nadie.
    return { abre: false, motivo: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Arma el aviso simplificado, o devuelve `null` si a la flota le falta la
 * identidad del responsable.
 *
 * Null y no un texto a medias: un aviso con el responsable equivocado —o sin
 * él— es peor que no tenerlo, porque justo lo que el aviso sirve para decir es a
 * quién reclamarle. Que falte se resuelve configurando el tenant; que esté mal
 * no se resuelve, porque nadie lo nota.
 *
 * LA LIGA DEL INTEGRAL NO SE TRATA IGUAL, y es a propósito. Sin razón social o
 * sin domicilio el aviso no puede decir lo único que el art. 15 fr. I persigue.
 * Sin liga utilizable, en cambio, las fracciones I a IV del art. 15 —que son las
 * que el art. 16 fr. II exige en la modalidad simplificada— caben enteras en el
 * mensaje: lo que falta es el puntero al integral, no el aviso. Callarse por eso
 * dejaría al titular sin nada, cuando puede quedarse con casi todo. Así que se
 * manda el aviso completo y se le dice la verdad sobre la liga, en vez de
 * pegarle una dirección que no abre y anotar en la base que se le informó.
 *
 * Efecto secundario buscado: el texto degradado y el texto con liga son
 * distintos, así que `versionAviso` les da hash distinto. El día que la flota
 * publique su integral, el aviso bueno se reenvía solo (art. 15 fr. VI).
 */
export function avisoSimplificado(r: DatosResponsable): string | null {
  const razonSocial = r.razonSocial?.trim();
  const domicilio = r.domicilio?.trim();
  if (!razonSocial || !domicilio) return null;

  const estado = revisarAvisoIntegral(r.urlAvisoIntegral);
  const url = r.urlAvisoIntegral?.trim();
  // Ausente = no medido = caso amplio (ver `SenalGps`). Nunca un default que
  // calle un tratamiento.
  const gps = r.gps ?? 'no_medible';

  // El renglón de la ubicación, POR FLOTA (refinamiento del C.15, 28-ago-2026).
  // Solo varía la mitad del PROVEEDOR: el pin del chat se declara en los tres
  // casos, porque este mismo mensaje viaja por el canal desde el que el chofer
  // puede mandarlo — el tratamiento es posible en cuanto existe la conversación.
  //
  //   · `conectado`    → se afirma: la credencial activa existe y el cron va a
  //                      traer posiciones (o ya las trae).
  //   · `no_medible`   → el texto CONDICIONAL de siempre ("si tu empresa
  //                      tiene GPS…"), que es literalmente cierto en ambos
  //                      casos. Byte-idéntico al que salió a producción el
  //                      22-ago, a propósito: así una falla transitoria de la
  //                      medición no cambia `versionAviso` ni dispara un
  //                      reenvío a media flota.
  //   · `sin_conector` → se dice que por ese medio no entra nada, y que si la
  //                      empresa conecta uno el aviso nuevo llega solo (la
  //                      versión cambia → reenvío del art. 15 fr. VI).
  const sobreUbicacion =
    gps === 'conectado'
      ? `Sobre tu ubicación: tu empresa tiene GPS en sus camiones, así que se recibe la *posición de la unidad* que manejas para medir los tiempos del viaje y enseñárselos a la empresa; si compartes tu ubicación por el chat, también se guarda y la ve tu jefe. Se borra a los 90 días. Tu teléfono no se rastrea.`
      : gps === 'sin_conector'
        ? `Sobre tu ubicación: tu empresa no tiene conectado un GPS con Likida, así que por ese medio no se recibe ninguna posición; si algún día conecta uno, este aviso cambia y el nuevo te llega por aquí. Lo que sí: si compartes tu ubicación por el chat, se guarda y la ve tu jefe. Se borra a los 90 días. Tu teléfono no se rastrea.`
        : `Sobre tu ubicación: si tu empresa tiene GPS en sus camiones, se recibe la *posición de la unidad* que manejas para medir los tiempos del viaje y enseñárselos a la empresa; si compartes tu ubicación por el chat, también se guarda y la ve tu jefe. Se borra a los 90 días. Tu teléfono no se rastrea.`;

  return [
    `🔒 *Aviso de privacidad*`,
    ``,
    // Fr. I — identidad y domicilio del responsable.
    `Responsable de tus datos: *${razonSocial}*, con domicilio en ${domicilio}.`,
    ``,
    // Fr. II — qué datos. En cristiano, no en abstracto: el operador tiene que
    // reconocer lo que va a mandar.
    //
    // AUDITORÍA 3, ALTO (LEG-A1): los avisos del viaje (hitos 0090 — "ya
    // llegué", "estoy descargando", "voy de regreso") se sellan con hora en
    // `viaje.llegada_en/descarga_en/regreso_en` y ningún aviso los enunciaba.
    // Se nombran con las palabras que el chofer de verdad manda, porque eso es
    // lo que tiene que reconocer.
    `Qué se trata: tu nombre y teléfono, las fotos de comprobantes de gasto que envíes por aquí (diésel, casetas, alimentación, hospedaje) con sus montos y fechas, los avisos del viaje que tú mandes ("ya llegué", "estoy descargando", "voy de regreso") con la hora de tu mensaje, y la posición GPS de la unidad que traes asignada.`,
    ``,
    // Fr. III — finalidades, DISTINGUIENDO. La fracción vigente no se conforma
    // con enumerarlas: pide separar las que requieren consentimiento. Y el
    // art. 11 vigente perdió las palabras "compatible o análogo" de la ley
    // abrogada, así que una finalidad que no esté escrita aquí no tiene válvula:
    // exige consentimiento nuevo. Por eso la revisión de comprobantes entre
    // viajes —que corre y que el contralor ve— se enuncia, en vez de esconderse
    // detrás de un "nada más" que el producto desmiente.
    `Para qué, y sin esto no hay liquidación: liquidar tus viajes y comprobar los gastos ante el SAT.`,
    ``,
    `Para qué más: revisar si un comprobante viene repetido o alterado —incluyendo la comparación contra los de tus viajes anteriores— y entregarle ese resultado a la empresa.`,
    ``,
    // AUDITORÍA 3, ALTO (LEG-A1) — la finalidad de los hitos, enunciada. La
    // liquidación cierra igual sin ellos (es seguimiento, no requisito), así
    // que va como finalidad ADICIONAL, no escondida en "liquidar".
    //
    // AUDITORÍA 19, CRÍTICO (legal C1 / C.15): esta línea decía "No hay GPS:
    // solo se anota lo que tú escribes" — y el producto lleva desde la 0050
    // grabando posiciones. Tres caminos reales las escriben en `posicion`:
    // el poller de rastreo (sincronizar_gps.ts, cron /api/cron/gps cada 5
    // min, vercel.json:30), el pin que el chofer manda por WhatsApp
    // (processor.ts → registrarUbicacionChofer) y el pin de asistencia
    // (asistencia_wa.ts). La geolocalización de la unidad mientras el chofer
    // la maneja ES un dato personal suyo (LFPDPPP art. 3 fr. IX: persona
    // identificada o identificable), y un aviso que lo niega es peor que uno
    // que calla. Se declara con su límite verdadero: el rastreado es el
    // camión de la empresa, no el teléfono del chofer, y las posiciones se
    // borran a los 90 días (purgar_posicion, mig. 0155).
    `También: anotar la hora de tus avisos del viaje para medir sus tiempos —como la espera en la descarga— y enseñárselos a la empresa.`,
    ``,
    // AUDITORÍA 19 → refinamiento 28-ago-2026: el renglón ya no es el mismo
    // para toda flota — se arma arriba, MEDIDO contra `conector_credencial`.
    sobreUbicacion,
    ``,
    // Art. 26 fr. II — el derecho de oposición al tratamiento automatizado. Es
    // el elemento 11 del checklist de docs/conocimiento/11-datos-personales.md
    // §5.4, que la tabla ubica en el integral. Se pone aquí igual porque la
    // revisión que lo activa ya corre hoy y porque un derecho que solo vive en
    // un documento que el titular no ha visto no se ejerce nunca.
    `Esa revisión la hace un programa, sin que una persona la mire antes. Tienes derecho a oponerte a que se decida así y a pedir que la revise alguien.`,
    ``,
    // Fr. IV — opciones y medios para limitar el uso o divulgación. Es también
    // el medio para ejercer la oposición del renglón de arriba: un solo camino,
    // el mismo que el operador ya tiene abierto.
    `Cómo limitarlo, oponerte o ejercer tus derechos ARCO: escribe *PRIVACIDAD* por este chat y te pasamos con la empresa.`,
    ``,
    // Encargada. No es transferencia (art. 2 fr. XX excluye a la persona
    // encargada), pero el operador tiene derecho a saber por dónde pasan sus
    // fotos, y decirlo cuesta un renglón.
    `Likida procesa esta información por cuenta de la empresa, siguiendo sus instrucciones.`,
    ``,
    // Art. 16 fr. II — señalar dónde está el integral. Si no hay dónde, se dice
    // que no hay dónde. Prometer una liga rota es peor que reconocer el hueco:
    // el titular pierde el tiempo y la base guarda una constancia falsa.
    estado === 'ok'
      ? `Aviso completo: ${url}`
      : `Aviso completo: la empresa aún no lo publica. Escríbeme *PRIVACIDAD* y queda registrado para que te lo hagan llegar.`,
  ].join('\n');
}

/**
 * Versión del texto, para saber si el operador vio ESTE aviso o uno viejo.
 *
 * Se deriva del contenido, no de un número que alguien tenga que acordarse de
 * subir: si la flota cambia su domicilio o la liga del integral, la versión
 * cambia sola y el aviso se vuelve a enviar. El art. 15 fr. VI obliga a
 * comunicar los cambios, y confiar en que alguien recuerde incrementar un
 * contador es exactamente como no comunicarlos.
 *
 * No es criptografía: solo tiene que cambiar cuando el texto cambia. Un hash
 * corto y determinístico (FNV-1a) basta y no arrastra dependencias.
 */
export function versionAviso(texto: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * Cómo se ejerce la OPOSICIÓN del art. 26 fr. II en un chat.
 *
 * El aviso anuncia el derecho con estas palabras: *"Esa revisión la hace un
 * programa, sin que una persona la mire antes. Tienes derecho a oponerte a que
 * se decida así y a pedir que la revise alguien."* Quien acaba de leer eso no
 * contesta `PRIVACIDAD`: contesta con la frase que acaba de leer. Reconocer
 * solo la palabra clave dejaba el ejercicio del derecho en manos del LLM, que
 * es exactamente lo que el resto de este módulo decidió no hacer. §6 de
 * `docs/conocimiento/11-datos-personales.md` lo pide con todas sus letras: un
 * mecanismo de oposición documentado en el aviso *y accesible desde WhatsApp*.
 *
 * Calibrado a favor de la cobertura y no de la precisión, porque los dos errores
 * no cuestan lo mismo: un falso positivo manda una respuesta que además dice
 * "tu liquidación sigue igual, esto no la afecta" y el operador repite su
 * mensaje; un falso negativo deja sin atender un derecho. Aun así se exige la
 * forma de PETICIÓN ("que lo revise una persona"), no la mención suelta de una
 * persona, para no secuestrar la conversación normal de la caseta.
 */
const OPOSICION: RegExp[] = [
  // AUDITORÍA 6: faltaba la conjugación más natural del español hablado. El
  // detector solo veía el presente ("me opongo") y el infinitivo con clítico
  // pegado ("oponerme"), y la forma que un operador usa de verdad es la
  // perifrástica: "me quiero oponer", "no me quiero oponer" —que también es
  // ejercicio del derecho, aunque la primera lectura despiste—, "quisiera
  // oponerme", "me voy a oponer". Sin esto, el derecho del art. 26 fr. II se
  // pierde sin dejar rastro: el mensaje pasa al agente como una frase normal.
  //
  // El clítico va SUELTO y antes del verbo, que es donde el español lo pone en
  // la perífrasis, así que `\boponerme\b` no puede casarlo.
  /\bme\s+(?:\w+\s+){0,3}opon(?:go|er|ga)\b/,
  // Solo con el clítico. `opongo` a secas no es ejercicio del derecho —"opongo
  // mi camión al muro" lo disparaba— y la forma real siempre lo lleva.
  /\bopon(?:erme|erse)\b/,
  /\boposicion\b/,
  /\bno\s+(?:quiero|autorizo|acepto)\s+que\s+(?:me\s+)?(?:revisen|analicen|usen|traten)\b/,
  /\brevision humana\b/,
];

/**
 * AUDITORÍA 8, ALTO: "que lo revise una persona" es sintácticamente idéntica
 * tanto para oponerse a una decisión automatizada (art. 26 fr. II) como para
 * pedirle a alguien que revise un ticket mal leído por el OCR — el motivo de
 * queja más común de este producto. Estos dos patrones son AMBIGUOS a
 * propósito, y solo cuentan como oposición si el mensaje NO trae vocabulario
 * de "esto es sobre un papel, no sobre mí" (ver `OBJETO_DE_PAPEL` abajo). Se
 * separan de `OPOSICION` —que sigue siendo inequívoca— para no perder
 * cobertura ahí.
 */
const OPOSICION_AMBIGUA: RegExp[] = [
  /\bque (lo |la )?(revise|revisen|vea|vean) (un |una )?(persona|humano|humana|alguien|gente)\b/,
  /\b(un|una) (persona|humano|humana|gente) (lo |la )?(revise|vea|revisara)\b/,
];

/** El objeto de la revisión es un PAPEL, no una decisión sobre la persona. */
const OBJETO_DE_PAPEL = /\b(ticket|folio|comprobante|recibo|factura|foto|imagen|lectura)\b/;

/**
 * AUDITORÍA 9, ALTO: `OBJETO_DE_PAPEL` cerró el falso positivo de la ronda 8
 * (la queja de ticket) abriendo un falso negativo del otro lado — el que el
 * aviso mismo induce con estas palabras: *"Tienes derecho a oponerte a que se
 * decida así [un programa] y a pedir que la revise alguien."* Quien contesta
 * "que lo revise una persona **en vez del programa**" está nombrando lo que
 * se está revisando —es inevitable, la revisión automatizada ES sobre
 * comprobantes— y ESO no puede seguir descalificando la oposición.
 *
 * La distinción no es "menciona un papel", es "rechaza explícitamente lo
 * automatizado". "que revise una persona el folio porque el sistema lo leyó
 * mal" solo describe un error (`sistema` es el sujeto de una queja, no algo
 * que se rechaza); "que lo revise una persona, no el programa" SÍ lo rechaza.
 * Con el contraste explícito presente, `OBJETO_DE_PAPEL` deja de excluir.
 */
const RECHAZA_AUTOMATIZADO = /\b(?:no\s+(?:el\s+|un\s+|confio\s+en\s+el\s+)?(?:programa|sistema|robot|bot)\b|en\s+vez\s+del?\s+(?:programa|sistema))/;

/**
 * ¿El operador está ejerciendo el medio que el aviso le prometió?
 *
 * Determinístico y ANTES del agente, a propósito. Un derecho ARCO no se deja a
 * que el LLM decida si el mensaje "califica": si el aviso dice que escribiendo
 * PRIVACIDAD se le atiende, tiene que atenderse siempre, no casi siempre. Lo
 * mismo vale para la oposición del art. 26 fr. II, que el aviso anuncia con una
 * frase que induce otras palabras (ver `OPOSICION`).
 *
 * Tolerante con cómo se escribe de verdad en WhatsApp: mayúsculas o no, con o
 * sin acento, con signos alrededor. No hace falta que sea el mensaje entero
 * ("quiero privacidad", "PRIVACIDAD porfa").
 */
export function pideAtencionPrivacidad(texto: string): boolean {
  const t = texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // quita acentos
    .toLowerCase();
  return (
    /\b(privacidad|arco|mis datos personales|dar de baja mis datos)\b/.test(t) ||
    OPOSICION.some((r) => r.test(t)) ||
    (OPOSICION_AMBIGUA.some((r) => r.test(t)) && (!OBJETO_DE_PAPEL.test(t) || RECHAZA_AUTOMATIZADO.test(t)))
  );
}

/**
 * Respuesta al ejercicio del medio. Remite al aviso INTEGRAL de la flota, que
 * es donde por ley (art. 15 fr. V) viven los mecanismos y procedimientos ARCO.
 *
 * Likida no puede resolver un ARCO por su cuenta: es persona encargada y actúa
 * por instrucciones del responsable. Prometer aquí que "ya lo dimos de baja"
 * sería mentir sobre quién puede hacerlo.
 *
 * Y si la liga no sirve, NO se manda igual. Este es el único camino que el
 * producto le ofrece a alguien que ejerce un derecho: contestarle con una
 * dirección que no abre es dejarlo sin ejercerlo y creyendo que ya lo hizo. Se
 * le da entonces lo que sí se tiene —a quién reclamarle y dónde emplazarlo,
 * que es lo que el art. 15 fr. I persigue— y se le dice que la liga no existe.
 */
export function respuestaPrivacidad(r: DatosResponsable): string {
  const partes = [
    `Claro. El responsable de tus datos es *${r.razonSocial}*, con domicilio en ${r.domicilio}.`,
    ``,
  ];

  if (revisarAvisoIntegral(r.urlAvisoIntegral) === 'ok') {
    partes.push(
      // La oposición a la revisión automática se nombra aquí también, y no solo
      // en la rama degradada: es el único derecho que este producto activa por
      // sí mismo (art. 26 fr. II), y quien escribe suele estar ejerciéndolo
      // precisamente porque el aviso se lo acaba de anunciar. Si solo se
      // nombrara cuando la liga no sirve, el día que la flota publique su
      // integral el producto diría MENOS sobre ese derecho que hoy.
      `Ahí vienen los pasos para acceder, corregir, cancelar u oponerte al uso de tus datos (derechos ARCO), incluida la revisión automática de tus comprobantes:`,
      r.urlAvisoIntegral.trim(),
    );
  } else {
    partes.push(
      `Puedes pedirle acceder, corregir, cancelar u oponerte al uso de tus datos (derechos ARCO), incluida la revisión automática de tus comprobantes.`,
      ``,
      `La empresa todavía no publica la liga con el procedimiento, así que no tengo a dónde mandarte: te lo digo en vez de darte una dirección que no abre.`,
    );
  }

  partes.push(
    ``,
    // "Queda registrada" y no "ya le avisé": lo que ocurre es un registro que la
    // empresa consulta, no una notificación que salga hacia ella. Decir lo
    // segundo sería afirmar un estado que el producto no produce.
    `Queda registrada tu solicitud para la empresa. Tu liquidación sigue igual, esto no la afecta. 👍`,
  );
  return partes.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// EL AVISO INTEGRAL. 31-jul-2026.
//
// Faltaba entero. `tenant.url_aviso_privacidad` apuntaba a
// `flotademo.mx`, que responde NXDOMAIN: el operador recibía una
// liga rota, y la respuesta a *PRIVACIDAD* tenía que confesar que no había a
// dónde mandarlo. El art. 16 fr. II obliga a "señalar el sitio donde se podrá
// consultar el aviso integral", y no había sitio.
//
// Seis de los once elementos del checklist (docs/conocimiento/11-datos-
// personales.md §5.4) viven SOLO en el integral, así que sin él no existían en
// ningún lado:
//
//     5   procedimiento ARCO ................... art. 15 fr. V
//     6   cómo se comunican los cambios ........ art. 15 fr. VI
//     7   cláusula de transferencias ........... art. 35
//     8   revocación del consentimiento ........ art. 7 último párr.; Regl. 21
//     10  contacto de datos personales ......... art. 29
//     11  oposición al tratamiento automatizado  art. 26 fr. II
//
// ── POR QUÉ LO ALOJA LIKIDA Y NO LA FLOTA ─────────────────────────────────
//
// El responsable es la FLOTA (art. 14) y Likida es persona encargada (art. 2
// fr. XX). Pero el obligado de la fr. II es señalar un sitio, no ser el dueño
// del dominio: alojarlo aquí no traslada la responsabilidad, igual que un
// despacho que publica el aviso de su cliente no se vuelve el responsable. El
// texto lo dice en la primera línea, para que quien lo lea sepa a quién le
// reclama.
//
// La alternativa era esperar a que cada flota publique el suyo. Eso es lo que
// llevaba dos meses sin pasar, y mientras tanto el operador recibía una liga
// muerta — que ante la autoridad es peor que no señalar ninguna, porque
// aparenta cumplimiento.
//
// ── LO QUE ESTE TEXTO NO PUEDE INVENTAR ───────────────────────────────────
//
// El contacto del art. 29 es un dato de la flota. Si no está capturado, la
// sección lo DICE en vez de rellenarla con el chat de WhatsApp y dar por
// cumplido el artículo. Es el mismo criterio que ya rige a la liga rota:
// decirle la verdad al titular cumple más que una dirección que no abre.
// ═══════════════════════════════════════════════════════════════════════════

/** Una sección del integral. `pendiente` = falta un dato de la flota. */
export interface SeccionAviso {
  titulo: string;
  /** Fundamento legal, para que quien lo revise pueda comprobarlo. */
  fundamento: string;
  parrafos: string[];
  /** Cierto cuando la flota no ha capturado lo que la sección necesita. */
  pendiente?: boolean;
}

/** Datos del integral: los del simplificado más el contacto del art. 29. */
export interface DatosIntegral extends DatosResponsable {
  /** Persona o departamento de datos personales. Art. 29. */
  contactoPrivacidad?: string | null;
}

/**
 * El aviso integral de una flota, sección por sección.
 *
 * Devuelve datos y no HTML a propósito: así se puede probar el CONTENIDO —que
 * los once elementos estén, que ninguno se invente— sin renderizar una página.
 * La vista solo lo pinta.
 */
export function avisoIntegral(r: DatosIntegral): SeccionAviso[] {
  const razonSocial = r.razonSocial.trim();
  const domicilio = r.domicilio.trim();
  const contacto = r.contactoPrivacidad?.trim();
  // Mismo criterio que en `avisoSimplificado`: ausente = no medido = caso
  // amplio. El párrafo del proveedor y su finalidad varían por flota; el pin
  // del chat se declara SIEMPRE (ver `SenalGps`).
  const gps = r.gps ?? 'no_medible';

  return [
    {
      titulo: 'Quién es responsable de tus datos',
      fundamento: 'LFPDPPP art. 15 fr. I',
      // AUDITORÍA 19 (legal C3 / C.16): sin domicilio capturado, la sección
      // lo DICE y se marca pendiente — mismo criterio que el contacto del
      // art. 29 más abajo. Antes la ruta entera respondía 404, que es dejar
      // al titular sin nada por faltar un dato de la flota.
      pendiente: !domicilio,
      parrafos: [
        domicilio
          ? `**${razonSocial}**, con domicilio en ${domicilio}, es la responsable de tus datos personales. A ella le reclamas y ante ella ejerces tus derechos.`
          : `**${razonSocial}** es la responsable de tus datos personales. A ella le reclamas y ante ella ejerces tus derechos. **La empresa aún no ha capturado su domicilio fiscal** — se dice aquí en vez de dejarlo en blanco o inventar uno; mientras tanto, el camino que sí funciona es escribir **PRIVACIDAD** por el mismo chat de WhatsApp.`,
        // AUDITORÍA 18 (B6): decía "fr. XX", que es la definición de TRANSFERENCIA.
        // "Persona encargada" es la fr. XII (normas/lfpdppp-2-XII-XX.yaml); la
        // XX se cita bien más abajo, en la sección del art. 35, donde sí toca.
        `Likida opera la herramienta con la que se procesan: es **persona encargada** (art. 2 fr. XII), trata los datos por cuenta de la empresa y siguiendo sus instrucciones, y no decide sobre ellos. Este aviso está alojado en el sitio de Likida por encargo de la empresa; eso no cambia quién responde.`,
      ],
    },
    {
      titulo: 'Qué datos se tratan',
      fundamento: 'LFPDPPP art. 15 fr. II',
      parrafos: [
        `Tu **nombre** y tu **número de teléfono**.`,
        `Las **fotos de comprobantes** que envías por WhatsApp —diésel, casetas, alimentación, hospedaje, refacciones— y lo que viene escrito en ellas: montos, fechas, folios, RFC del establecimiento y datos fiscales del comprobante.`,
        `El **contenido de tus mensajes** en esa conversación, y los **viajes y liquidaciones** en los que participas.`,
        // AUDITORÍA 3, ALTO (LEG-A1): los hitos 0090 como categoría de dato,
        // con su límite dicho — la hora es la del mensaje.
        `Los **avisos del viaje** que decides mandar por el mismo chat —"ya llegué", "estoy descargando", "voy de regreso"— con la hora en que llega tu mensaje.`,
        // AUDITORÍA 19, CRÍTICO (legal C1 / C.15): este párrafo decía "**No
        // hay GPS ni rastreo del teléfono**" mientras el cron de
        // /api/cron/gps (cada 5 minutos) y el pin de WhatsApp escriben
        // `posicion` desde la 0050. La geolocalización de la unidad con un
        // chofer identificado al volante es dato personal del chofer, y la
        // fr. II obliga a enumerarla. Se declara con sus dos límites reales:
        // lo rastreado es el camión (el dispositivo lo instala la empresa,
        // no vive en el teléfono del chofer) y la retención es de 90 días
        // (purgar_posicion, mig. 0155).
        //
        // REFINAMIENTO 28-ago-2026 (por flota): la mitad del PROVEEDOR se
        // declara según lo MEDIDO en `conector_credencial` — declarar un
        // rastreo satelital a una flota que no tiene ninguno conectado es tan
        // inexacto como callarlo. El pin del chat se declara en los tres
        // casos: no depende de conector alguno (ver `SenalGps`). El texto de
        // `no_medible` queda byte-idéntico al desplegado el 22-ago, para que
        // una falla de la medición no dispare reenvíos.
        gps === 'conectado'
          ? `La **posición GPS de la unidad que traes asignada**: tu empresa tiene contratado un rastreo satelital para sus camiones, y la posición del camión se recibe cada pocos minutos, también mientras tú lo manejas. Y la **ubicación que tú decidas compartir** por el chat, que se guarda y se le muestra a tu empresa. **Tu teléfono no se rastrea:** el dispositivo de rastreo es del camión, y de tu teléfono solo sale lo que tú mandes. Las posiciones se conservan **90 días** y después se borran solas.`
          : gps === 'sin_conector'
            ? `La **ubicación que tú decidas compartir** por el chat, que se guarda y se le muestra a tu empresa. Tu empresa **no tiene conectado un rastreo satelital** con Likida, así que por ese medio no se recibe ninguna posición; si algún día lo conecta, este aviso cambia y el nuevo te llega por WhatsApp. **Tu teléfono no se rastrea:** de él solo sale lo que tú decidas mandar. Las ubicaciones que compartas se conservan **90 días** y después se borran solas.`
            : `La **posición GPS de la unidad que traes asignada**, cuando tu empresa tiene contratado un rastreo satelital para sus camiones: la posición del camión se recibe cada pocos minutos, también mientras tú lo manejas. Y la **ubicación que tú decidas compartir** por el chat, que se guarda y se le muestra a tu empresa. **Tu teléfono no se rastrea:** el dispositivo de rastreo es del camión, y de tu teléfono solo sale lo que tú mandes. Las posiciones se conservan **90 días** y después se borran solas.`,
        // AUDITORÍA 24 (LEG-3, ALTO): ningún aviso enumeraba los eventos que
        // la cámara/telemetría del camión reporta — `sincronizar_eventos.ts`
        // los guarda TODOS (no solo los graves) desde la misma credencial y
        // cadencia del GPS (`conector_credencial`; ver el comentario de
        // cabecera de ese archivo: "Eventos y posiciones comparten
        // proveedor, credencial y cadencia"). Se reutiliza la señal `gps`
        // por eso — no es un tratamiento con su propio conector, es el mismo
        // con otro tipo de dato. NO se promete un plazo de borrado fijo para
        // estos eventos: hoy no existe una purga automática que lo ejecute, y
        // este archivo ya tiene un hallazgo (LEG-6) por prometer un "90 días"
        // que ningún código cumplía — no se repite el error aquí. Mismo
        // criterio que la categoría de salud, dos párrafos abajo: se declara
        // la finalidad y el límite reales, no una cifra que nadie ejecuta.
        gps === 'conectado'
          ? `La **conducta al volante que reporta la cámara o el sistema de telemetría de tu camión**, cuando tu empresa tiene ese servicio conectado con Likida: frenadas bruscas, uso del celular al manejar, distracción, colisión, impacto o volcadura, con la hora y la posición del camión en ese momento, y una liga al video en el sistema del proveedor cuando él la entrega. **Se usan para atender un accidente o incidente grave de tu unidad** —abrir el expediente de asistencia y avisar a tu empresa— y, mientras tanto, quedan disponibles para que tu empresa revise cómo conduces. Hoy no tienen una fecha de borrado automático.`
          : gps === 'sin_conector'
            ? `Tu empresa **no tiene conectado un sistema de cámara o telemetría** con Likida, así que por ese medio no se recibe ningún evento sobre cómo conduces; si algún día lo conecta, este aviso cambia y el nuevo te llega por WhatsApp.`
            : `La **conducta al volante que reporta la cámara o el sistema de telemetría de tu camión**, cuando tu empresa tiene ese servicio conectado con Likida: frenadas bruscas, uso del celular al manejar, distracción, colisión, impacto o volcadura, con la hora y la posición del camión en ese momento, y una liga al video en el sistema del proveedor cuando él la entrega. **Se usan para atender un accidente o incidente grave de tu unidad** —abrir el expediente de asistencia y avisar a tu empresa— y, mientras tanto, quedan disponibles para que tu empresa revise cómo conduces. Hoy no tienen una fecha de borrado automático.`,
        // AUDITORÍA EXTERNA 16-AGO-2026 (P2): la versión anterior decía "no
        // se usa para nada", y el flujo real es más matizado — la foto viaja
        // COMPLETA al motor de lectura (no se puede enmascarar una imagen
        // antes de leerla) y el filtro de sanitizar.ts actúa DESPUÉS: impide
        // que lo sensible se guarde o participe del cuadre. El aviso ahora
        // describe exactamente eso; un aviso que promete más de lo que el
        // código hace es un hallazgo de due diligence, no una protección.
        // AUDITORÍA 19 (legal, reincidente #7): decía a secas "puedes pedir
        // que la foto se borre", y la 0178 decidió lo contrario para la foto
        // que YA es comprobante de un gasto: es evidencia fiscal y se
        // conserva (CFF art. 30) — el ejecutor ARCO la desliga del titular,
        // no la borra. Lo que SÍ se borra solo es la imagen que no respalda
        // ningún gasto (cola de huérfanos, mig. 0165). El aviso ahora dice
        // esa frontera con todas sus letras, porque prometer un borrado que
        // la base rechaza es una promesa con evidencia escrita de romperse.
        // AUDITORÍA 22, LEG-A1 (ALTO): la nota de voz viaja ÍNTEGRA al
        // proveedor que la transcribe (`voz_transcrita.ts`) y no estaba
        // enumerada ni como dato ni como salida. La voz es dato personal por
        // sí misma (art. 3 fr. V): identifica a quien habla.
        `Las **notas de voz** que mandas por el chat. Se transcriben a texto para poder atenderlas, y tanto el audio como su transcripción quedan en la conversación.`,
        // AUDITORÍA 22, LEG-A2 (ALTO): el RFC y el número de licencia del
        // operador salen hacia el PAC dentro del Carta Porte
        // (`carta_porte_xml.ts:183-185`) y no estaban en ninguna de las dos
        // listas del aviso. La fr. II obliga a enumerarlos.
        `Tu **RFC** y el **número de tu licencia de conducir**, cuando tu empresa emite un complemento Carta Porte del viaje que traes: el SAT los exige dentro de ese comprobante.`,
        // ── AUDITORÍA 22, LEG-C2 (CRÍTICO) ─────────────────────────────────
        // Este párrafo juraba «No se piden ni se conservan datos sensibles. Ni
        // salud…». El circuito de asistencia guarda `incidencia.hay_lesionados`
        // —columna propia, migración 0198, ligada a `operador_id`— y el texto
        // crudo con el que el chofer describe el accidente
        // (`asistencia_wa.ts:524`). La salud es dato sensible (art. 3 fr. VI) y
        // el art. 59 fr. IV agrava la sanción hasta el doble.
        //
        // Una negativa ABSOLUTA que el código contradice es peor que el
        // silencio: es una afirmación falsa firmada, con evidencia en la base.
        // Se declara lo que sí ocurre, con su finalidad y su límite, y se
        // conserva la promesa que sí es cierta para las demás categorías.
        `**Un dato de salud, y solo uno:** si avisas por el chat de un accidente o una emergencia, se guarda **si hay personas lesionadas** y el texto con el que lo describes, para poder escalarlo a tu empresa y atenderlo. No se usa para tu liquidación ni para evaluarte. **Fuera de ese caso no se piden ni se conservan datos sensibles:** ni origen racial o étnico, ni creencias, ni afiliación sindical, ni preferencias sexuales, ni datos biométricos. Cada foto se procesa completa por el motor de lectura para extraer los campos del comprobante; si en ella aparece por accidente algo sensible (un ticket de farmacia, por ejemplo), un filtro lo detecta y lo excluye: **no se guarda como dato, no participa en tu liquidación**, y la imagen que no respalda ningún gasto se elimina sola del almacenamiento. **Lo que no se puede borrar ni pidiéndolo:** la foto que ya es comprobante de un gasto — esa se conserva por obligación fiscal (CFF art. 30). Lo que sí puedes pedir es que se **desligue de tu persona**, y eso es lo que la cancelación ejecuta.`,
        // AUDITORÍA 24 (LEG-8, MEDIO, reincidente ×3): `grep 'familiar|contacto
        // de emergencia'` en los dos avisos daba 0 — el nombre 24, teléfono y
        // parentesco del contacto de emergencia (`contacto_emergencia`, 0198)
        // no estaban enumerados en ningún lado. No es tu dato: es el de un
        // tercero que tu empresa captura sobre ti, y se declara aquí porque
        // es la única sección donde el operador puede leer qué existe.
        `**El contacto de emergencia que tu empresa capture sobre ti:** si tu empresa registra a alguien —nombre, teléfono y parentesco— para que se le avise en caso de que tengas un accidente, ese dato se guarda con esa sola finalidad. Se le avisa únicamente si tu empresa activa ese aviso para ese contacto, y Likida no le llama por su cuenta.`,
      ],
    },
    {
      titulo: 'Para qué se usan',
      fundamento: 'LFPDPPP art. 15 fr. III',
      // AUDITORÍA 24 (LEG-3): el filtro final quita el `null` de la
      // finalidad de cámara cuando la flota no tiene una conectada — no hay
      // nada que declarar en ese caso, y un párrafo vacío no es honesto.
      parrafos: ([
        `**Finalidades necesarias — sin ellas no puede haber liquidación:**`,
        `· Liquidar tus viajes: cuadrar lo que gastaste contra el anticipo que recibiste y emitir el documento de liquidación.`,
        `· Comprobar los gastos ante el SAT y conservar los comprobantes fiscales el tiempo que la ley obliga (Código Fiscal de la Federación art. 30: al menos cinco años).`,
        `· Responderte por WhatsApp.`,
        `**Finalidades que NO son necesarias, y a las que puedes oponerte sin que eso afecte tu liquidación:**`,
        `· Revisar si un comprobante viene repetido o alterado, comparándolo contra los de tus viajes anteriores, y entregarle ese resultado a la empresa.`,
        // AUDITORÍA 3, ALTO (LEG-A1): la finalidad de los hitos 0090. Va aquí
        // —entre las NO necesarias— porque la liquidación cierra igual sin
        // ellos: es seguimiento pedido por la empresa, y el titular conserva
        // la oposición sin que eso afecte su liquidación.
        `· Anotar la hora de tus avisos del viaje ("ya llegué", "estoy descargando", "voy de regreso") para medir los tiempos de la operación —por ejemplo, cuánto dura la espera en la descarga— y mostrárselos a la empresa.`,
        // AUDITORÍA 19 (legal C1 / C.15): la finalidad del GPS, enunciada
        // donde la ley la pide y con su oposición dicha entera. Va entre las
        // NO necesarias porque la liquidación cierra igual sin posiciones
        // (0207: sin posiciones en el radio no hay fila, es un motivo
        // declarado, no un cero). Y se dice el límite de la oposición: el
        // rastreo del camión lo contrata la empresa; lo que la oposición
        // detiene es el uso de esas posiciones ligado a tu persona, no el
        // dispositivo del camión.
        //
        // REFINAMIENTO 28-ago-2026 (por flota): sin conector, la única fuente
        // de posiciones es el pin que el chofer decide mandar — la finalidad
        // se enuncia sobre ESA fuente, y la cláusula del contrato con el
        // proveedor (que no existe) se cae. Con conector (o sin poder medir,
        // que se trata como el caso amplio), el texto de siempre.
        gps === 'sin_conector'
          ? `· Usar la ubicación que tú compartas por el chat para el seguimiento del viaje y para medir sus tiempos —por ejemplo, cuánto estuvo detenida la unidad en un sitio de carga o descarga— y mostrárselo a la empresa. Puedes oponerte a que esas ubicaciones se usen ligadas a tu persona.`
          : `· Usar las posiciones GPS de la unidad para el seguimiento del viaje y para medir sus tiempos —por ejemplo, cuánto estuvo detenida la unidad en un sitio de carga o descarga— y mostrárselo a la empresa. Puedes oponerte a que esas posiciones se usen ligadas a tu persona; el rastreo del camión es un contrato de tu empresa con su proveedor y no se apaga desde aquí, y decírtelo así es más honesto que prometer lo contrario.`,
        // AUDITORÍA 22, LEG-A3 (ALTO): `jornada/derivar.ts` DERIVA tu registro
        // de jornada laboral a partir de las posiciones GPS. Eso no es
        // "seguimiento del viaje": es una finalidad distinta, con un destino
        // distinto (LFT 132 fr. XXXIV), y el propio aviso declara dos párrafos
        // más abajo que toda finalidad no escrita exige pedir permiso otra vez.
        // Va entre las NO necesarias: la liquidación cierra igual sin ella.
        `· Derivar tu **registro de jornada** —a qué hora empezaste a manejar, cuánto condujiste, cuánto descansaste— a partir de esas mismas posiciones, para que tu empresa cumpla su obligación de llevarlo (Ley Federal del Trabajo art. 132 fr. XXXIV). Puedes oponerte a que se derive ligado a tu persona.`,
        // AUDITORÍA 24 (LEG-3, ALTO): la finalidad de los eventos de cámara.
        // "Atender un accidente" (abrir el expediente de asistencia) es la
        // parte que no admite oposición —es la misma ayuda que se activa
        // cuando ocurre—; revisar la conducta fuera de un accidente sí es
        // oponible, igual que el resto de lo derivado de las posiciones.
        gps === 'conectado'
          ? `· **Atender un accidente o incidente grave de tu unidad** (choque, impacto, volcadura) que la cámara o telemetría reporte, abriendo el expediente de asistencia y avisando a tu empresa. Esta finalidad no admite oposición: es la misma ayuda que se activa cuando ocurre. Fuera de un accidente, tu empresa también puede usar esos eventos para revisar cómo conduces; puedes oponerte a que ese uso quede ligado a tu persona.`
          : gps === 'sin_conector'
            ? null
            : `· Si tu empresa conecta un sistema de cámara o telemetría, **atender un accidente o incidente grave de tu unidad** (choque, impacto, volcadura) que reporte, abriendo el expediente de asistencia y avisando a tu empresa —esta finalidad no admite oposición—, y revisar cómo conduces fuera de un accidente, a lo que sí puedes oponerte.`,
        `· Medir cómo funciona el servicio para mejorarlo (estadísticas de uso, sin identificarte en los reportes).`,
        `Cualquier finalidad que no esté escrita aquí requiere que te vuelvan a pedir permiso. La ley vigente ya no permite ampararse en usos "compatibles o análogos".`,
      ] as Array<string | null>).filter((p): p is string => p !== null),
    },
    {
      titulo: 'Un programa revisa tus comprobantes, y puedes oponerte',
      fundamento: 'LFPDPPP art. 26 fr. II',
      parrafos: [
        `La revisión de tus comprobantes —si están repetidos, si el monto de la foto no coincide con el del comprobante fiscal, si la fecha cae fuera del viaje— **la hace un programa, sin que una persona la mire antes**.`,
        `Ese resultado llega a la empresa y puede influir en cómo te liquidan. Por eso tienes derecho a **oponerte a que se decida así** y a pedir que una persona lo revise.`,
        `Oponerte a esta revisión no detiene tu liquidación: la empresa la hará a mano.`,
      ],
    },
    {
      titulo: 'Cómo limitar el uso de tus datos',
      fundamento: 'LFPDPPP art. 15 fr. IV',
      parrafos: [
        `Escribe **PRIVACIDAD** por el mismo chat de WhatsApp. Tu solicitud queda registrada para la empresa y tu liquidación sigue igual.`,
        `También puedes pedirlo directamente en el domicilio de la empresa que aparece arriba.`,
      ],
    },
    {
      titulo: 'Cómo ejercer tus derechos ARCO',
      fundamento: 'LFPDPPP art. 15 fr. V',
      parrafos: [
        `Tienes derecho a **Acceder** a tus datos, **Rectificarlos** si están mal, **Cancelarlos** cuando ya no deban tratarse y **Oponerte** a un uso concreto.`,
        `**Cómo:** escribe PRIVACIDAD por WhatsApp, o preséntalo por escrito en el domicilio de la empresa. Tu solicitud debe traer tu nombre, un medio para contestarte, copia de una identificación oficial, qué datos son y qué pides que se haga con ellos.`,
        `**Plazos de la ley:** la empresa tiene **20 días hábiles** para contestarte y **15 días hábiles** más para hacerlo efectivo si procede. Ejercerlos es gratuito; solo puedes tener que pagar el envío o la copia.`,
        `Si no te contestan o la respuesta no te satisface, puedes acudir a la autoridad garante en materia de protección de datos personales.`,
      ],
    },
    {
      titulo: 'Cómo revocar tu consentimiento',
      fundamento: 'LFPDPPP art. 7 último párrafo; Reglamento art. 21',
      parrafos: [
        `Puedes retirar tu consentimiento en cualquier momento, por el mismo medio: escribe **PRIVACIDAD** por WhatsApp o preséntalo en el domicilio de la empresa.`,
        `**Lo que la revocación no alcanza:** los comprobantes fiscales que ya se usaron para liquidar viajes pasados. La ley obliga a la empresa a conservarlos al menos cinco años (CFF art. 30), y esa obligación no se puede revocar. Se te dice aquí para que no te sorprenda después.`,
        `Revocar el consentimiento significa dejar de usar este canal para liquidar; la empresa te dirá por qué otro medio hacerlo.`,
      ],
    },
    {
      titulo: 'Transferencias a terceros',
      fundamento: 'LFPDPPP art. 35',
      // AUDITORÍA 8, ALTO: decía "contratados con retención cero", una garantía
      // contractual que nadie negoció con OpenRouter — `data_collection: 'deny'`
      // (openrouter.ts) es una preferencia de ruteo que se PIDE en cada llamada,
      // no un contrato de Zero Data Retention firmado. El texto ahora describe
      // lo que el código hace (pedirlo), no lo que no se ha confirmado (que se
      // cumpla del lado del proveedor).
      //
      // AUDITORÍA 18 (M7): decía "los modelos de lenguaje que leen las fotos",
      // y el camino real (processor.ts → runAgent → generateWithTools) manda el
      // HISTORIAL DE TEXTO del chat, verbatim, al mismo proveedor. El dato ya
      // estaba enumerado en la fr. II ("el contenido de tus mensajes"); lo mal
      // dicho era HACIA DÓNDE sale. El art. 35 y la fr. II del 15 exigen
      // describir el flujo real, no la versión más cómoda de él.
      parrafos: [
        `**Tus datos no se venden, ni se comparten con nadie para que los use por su cuenta.**`,
        `Sí pasan por proveedores que trabajan por instrucción de la empresa y no pueden usarlos para otra cosa —lo que la ley llama personas encargadas, y que **no es una transferencia** (art. 2 fr. XX)—: el proveedor de mensajería de WhatsApp, el de alojamiento de la base de datos, y los modelos de lenguaje: les llegan **las fotos de tus comprobantes** para leerlas y **el texto de tus mensajes** —la conversación completa— para poder contestarte. A esos modelos en cada llamada se les pide explícitamente que no retengan lo que procesan.`,
        // AUDITORÍA 22, LEG-A1: la nota de voz sale ENTERA al mismo proveedor
        // para transcribirse, y no se decía. AUDITORÍA 22, LEG-A2: el PAC no
        // estaba en ninguna lista, y el Carta Porte lleva RFC y licencia del
        // operador.
        `También les llegan **tus notas de voz**, completas, para transcribirlas a texto.`,
        // AUDITORÍA 25 (ALTO, REINCIDENTE de la 24): esta cláusula faltaba.
        // El asistente del panel (`/dashboard`, chat-tools.ts → viajes_flota)
        // le manda al mismo modelo tu nombre junto con el anticipo de tus
        // viajes cuando alguien de tu empresa le pregunta por la flota —un
        // flujo distinto del de arriba (que sale de TU conversación) y que
        // no estaba dicho.
        // revisión legal humana recomendada antes de publicar
        `Y cuando alguien de tu empresa usa el **asistente del panel** para preguntar por los viajes de la flota, ese modelo también puede recibir tu **nombre** junto con **montos de tus viajes** —el anticipo, por ejemplo— para poder contestarle.`,
        `Y cuando tu empresa emite un complemento **Carta Porte**, el comprobante viaja al **proveedor autorizado de certificación (PAC)** que lo timbra ante el SAT, y dentro de él van **tu RFC y el número de tu licencia**: el SAT los exige en ese documento.`,
        `Transferencias que sí lo son y no necesitan tu consentimiento: a la autoridad fiscal cuando la ley lo exige, y al contador de la empresa para cumplir sus obligaciones.`,
        `**Si algún día se quisiera transferir tus datos para algo distinto, se te pedirá permiso antes.** No hacer nada al leer esto no cuenta como haber aceptado.`,
      ],
    },
    {
      titulo: 'A quién dirigirte en la empresa',
      fundamento: 'LFPDPPP art. 29',
      pendiente: !contacto,
      parrafos: contacto
        ? [
            contacto,
            `También puedes escribir **PRIVACIDAD** por WhatsApp y tu solicitud queda registrada.`,
          ]
        : [
            `**La empresa todavía no ha designado a la persona o departamento de datos personales que el art. 29 exige.** Se dice aquí en vez de dejarlo en blanco o de poner un contacto que no existe.`,
            `Mientras tanto, el camino que sí funciona: escribe **PRIVACIDAD** por WhatsApp, o preséntalo en el domicilio de la empresa que aparece arriba.`,
          ],
    },
    {
      titulo: 'Cómo te avisamos si este aviso cambia',
      fundamento: 'LFPDPPP art. 15 fr. VI',
      parrafos: [
        `Cuando este aviso cambie, **recibes el aviso nuevo por el mismo WhatsApp**, sin que tengas que venir a revisarlo.`,
        `No es una promesa: el sistema calcula una firma del texto y reenvía en cuanto deja de coincidir con la última que se te entregó. Por eso un cambio aquí llega solo.`,
        `En esta página siempre está la versión vigente.`,
      ],
    },
  ];
}

/**
 * Clasifica el derecho ARCO que está ejerciendo el texto (auditoría 12, ALTO
 * legal). El aviso promete que la solicitud "queda registrada" y el código no
 * registraba nada — `solicitud_arco` existe (0053) y nadie la insertaba. Sin
 * un tipo no se puede insertar (el CHECK `arco_tipo_dominio` exige uno de los
 * cuatro). La clasificación es por palabras clave, best-effort: ante la duda
 * cae a 'acceso', que es el derecho genérico, y la flota —la responsable— es
 * quien decide la calificación exacta.
 */
export function tipoDeSolicitudArco(texto: string): 'acceso' | 'rectificacion' | 'cancelacion' | 'oposicion' {
  const t = texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/\b(?:borr|elimin|suprim|(?:dar|darme|dame|denme)\s+de\s+baja|quita\s+mis datos|ya\s+no\s+usen|ya\s+no\s+traten)\w*\b/.test(t)) return 'cancelacion';
  if (OPOSICION.some((r) => r.test(t)) || (OPOSICION_AMBIGUA.some((r) => r.test(t)) && (!OBJETO_DE_PAPEL.test(t) || RECHAZA_AUTOMATIZADO.test(t)))) return 'oposicion';
  if (/\b(?:correg|rectific|actualiza\s+mis datos|cambia\s+mi)\w*\b/.test(t)) return 'rectificacion';
  if (/\b(?:ver\s+mis datos|acceder|acceso\s+a\s+mis datos|que\s+datos\s+tienen|que\s+datos\s+guardan)\b/.test(t)) return 'acceso';
  return 'acceso';
}

/** LFPDPPP vigente, art. 31: 20 días hábiles para comunicar la determinación.
 *  La ejecución, cuando procede, tiene otros 15 días hábiles. `vence_en` mide
 *  solo el primer plazo, que es el que la solicitud puede vigilar. */
const DIAS_HABILES_ARCO = 20;

/** Suma `n` días hábiles a `desde` (lunes a viernes). */
export function venceArco(desde: Date, diasHabiles = DIAS_HABILES_ARCO): string {
  const d = new Date(desde);
  let faltan = diasHabiles;
  while (faltan > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dia = d.getUTCDay();
    if (dia !== 0 && dia !== 6) faltan--;
  }
  return d.toISOString().slice(0, 10);
}

// ═══════════════════════════════════════════════════════════════════════════
// EL AVISO DE PROSPECTOS — Likida como RESPONSABLE. Auditoría 18 (C2).
//
// El segundo sombrero del producto. Todo lo de arriba es "Likida encargada de
// la flota"; pero la maquinaria de adquisición (censo, DENUE, bolsas de
// trabajo, LinkedIn → `prospecto.contacto_nombre` y `prospecto_persona`, migs.
// 0105-0141) levanta nombres, puestos y correos de personas físicas que no
// contrataron nada y no saben que Likida existe. Sobre esos datos Likida
// DECIDE: es responsable (art. 14), y el art. 16 fr. II obliga a poner a
// disposición el aviso simplificado cuando el dato se obtiene por medio
// electrónico — raspar un directorio lo es.
//
// Que el dato figure en una fuente de acceso público exime del CONSENTIMIENTO,
// no del aviso: arts. 14 y 16 son obligaciones autónomas, y el plazo de
// conservación y el camino ARCO tampoco se eximen. (La excepción por fuente
// pública se cita como art. 9 siguiendo HALLAZGOS-18 C2; no hay ficha
// verificada en `normas/` para ese artículo — verificar antes de citarlo ante
// un tercero.) Y `origen: 'inferido'` de la 0138 confiesa que parte de los
// correos ni siquiera vienen de una fuente pública: se dedujeron.
//
// Lo que aquí se promete lo EJECUTA código: el nombre no viaja al modelo
// (mapa-prospectos/mensaje/seudonimo.ts), la purga por inactividad es la
// mig. 0148 (`purgar_prospecto_persona`, 365 días sin toque) y el camino ARCO
// es el correo de contacto. Mismo criterio que el resto del aviso: nada que
// no haga el producto.
// ═══════════════════════════════════════════════════════════════════════════

export const RUTA_AVISO_PROSPECTOS = '/aviso/prospectos';

/** Días sin toque tras los cuales la mig. 0148 borra a la persona. El aviso
 *  enseña esta cifra; si la purga cambia, cambia aquí. */
export const DIAS_RETENCION_PROSPECTO_PERSONA = 365;

/** La liga absoluta del aviso de prospectos — la que va en cada primer toque. */
export function urlAvisoProspectos(): string {
  const base = appUrl();
  return `${base}${RUTA_AVISO_PROSPECTOS}`;
}

/** La línea que cierra cada primer toque (correo y WhatsApp): art. 16 fr. II,
 *  "señalar el sitio donde se podrá consultar el aviso de privacidad integral". */
export function pieAvisoProspectos(): string {
  return `Aviso de privacidad para contactos comerciales: ${urlAvisoProspectos()}`;
}

export interface DatosAvisoProspectos {
  razonSocial: string | null;
  domicilio: string | null;
  /** Correo donde se ejercen los ARCO y la baja. */
  contacto: string;
}

/**
 * El aviso de prospectos, sección por sección. Integral (las seis fracciones
 * del art. 15) y, por construcción, también el simplificado: las fracciones
 * I a IV están en las cuatro primeras secciones.
 */
export function avisoProspectos(d: DatosAvisoProspectos): SeccionAviso[] {
  const razonSocial = d.razonSocial?.trim() || null;
  const domicilio = d.domicilio?.trim() || null;
  const meses = Math.round(DIAS_RETENCION_PROSPECTO_PERSONA / 30.4);
  return [
    {
      titulo: 'Quién es responsable, y por qué tienes este aviso',
      fundamento: 'LFPDPPP art. 15 fr. I · art. 14',
      pendiente: !razonSocial || !domicilio,
      parrafos: [
        // AUDITORÍA 24 (LEG-4, ALTO): esta sección sustituía el dato ausente
        // por un marcador rojo (🔴 razón social pendiente 🔴) DENTRO de la
        // misma frase donde iría el nombre real — un documento público, con
        // 33,298 prospectos detrás, que se leía como roto en vez de "en
        // actualización". Mismo criterio que `avisoIntegral`: si falta el
        // dato, se dice en una frase aparte y completa, no se rellena el
        // hueco con un emoji.
        razonSocial && domicilio
          ? `**${razonSocial}** (Likida), con domicilio en ${domicilio}, es la responsable de tus datos personales.`
          : `**Likida** es la responsable de tus datos personales. Este aviso está en actualización: la razón social inscrita y el domicilio de la entidad operadora siguen pendientes de captura — la fr. I del art. 15 los exige y se señalan aquí en vez de quedar en blanco o inventarse.`,
        // AUDITORÍA 19 (legal, reincidente #14): decía "ni nos diste tus
        // datos" a TODO lector — y el lead de /getdemo (api/lead) sí los dio,
        // con su nombre, correo y teléfono en el formulario. Un aviso que le
        // niega al titular su propio acto no describe el tratamiento real
        // (art. 15 fr. II exige decir de dónde salieron). Se dicen los dos
        // orígenes, porque los dos existen.
        `Este aviso es para ti si **trabajas en una empresa de transporte o con flota propia** y Likida te contactó —o piensa hacerlo— para ofrecerle su servicio a tu empresa. Hay dos formas de que tengamos tus datos, y este aviso cubre las dos: **los buscamos nosotros** en fuentes públicas sin que lo supieras, o **tú los dejaste** al usar la calculadora o pedir una demostración en likida.ai. En ambos casos aquí dice qué tenemos y qué hacemos con ello.`,
        `Si ya usas Likida como cliente, tu aviso es la **política de privacidad**; si eres operador de una flota, el aviso que te toca lo publica tu empresa.`,
      ],
    },
    {
      titulo: 'Qué datos tenemos y de dónde salieron',
      fundamento: 'LFPDPPP art. 15 fr. II · art. 16 fr. II',
      parrafos: [
        `Tu **nombre**, tu **puesto**, tu **correo y teléfono de trabajo** y, si lo tienes público, tu **perfil profesional**; junto con el nombre, el giro y la plaza de tu empresa y la vacante que publicó.`,
        `Salieron de **fuentes de acceso público**: el directorio de empresas del INEGI (DENUE), bolsas de trabajo donde tu empresa publicó una vacante, el sitio web de tu empresa y directorios o perfiles profesionales públicos. Algunos correos **no se leyeron en ninguna parte: se dedujeron** del patrón de correos de la empresa, y así quedan marcados —como no verificados— hasta que alguien los confirma.`,
        // AUDITORÍA 19 (legal, reincidente #14): el fbclid del lead no estaba
        // enumerado en ningún aviso. Es un identificador de la persona que
        // llenó el formulario y la fr. II obliga a decirlo. Se purga junto
        // con lo demás (mig. 0243).
        `Si tú dejaste tus datos en likida.ai, además se guarda **de qué anuncio o búsqueda llegaste** (los identificadores de campaña que tu navegador trae en la liga, como el fbclid de Facebook o el gclid de Google). Sirven para saber qué canal funcionó; se borran con el resto de tus datos.`,
        `**No se tratan datos sensibles** ni datos de tu vida privada: solo los de tu papel en la empresa.`,
      ],
    },
    {
      titulo: 'Para qué se usan',
      fundamento: 'LFPDPPP art. 15 fr. III · art. 11',
      parrafos: [
        `**Una sola finalidad comercial:** contactarte, por correo, WhatsApp o teléfono, para ofrecerle a tu empresa el servicio de liquidación de viajes de Likida y, si te interesa, agendar una demostración.`,
        `Para decidir a quién escribirle primero, un programa **ordena la lista de empresas** con un puntaje que cuenta si hay forma de contactarlas y qué tan parecida es la empresa al cliente que Likida busca. Ese puntaje ordena una cola de llamadas; **no decide nada sobre ti** ni produce efectos jurídicos en tu persona.`,
        `Cuando un programa redacta el primer mensaje, **tu nombre no sale de Likida para esa redacción**: la ficha que recibe el modelo de lenguaje para escribir el texto lleva un marcador en lugar de tu nombre, y sin tus datos de contacto; tu nombre de pila se pone después, dentro de Likida.`,
        // AUDITORÍA 25 (ALTO): esta cláusula faltaba. Un programa investigador
        // lee las páginas del sitio de tu empresa y se las manda a un modelo de
        // lenguaje pidiéndole que extraiga nombre, puesto, correo y teléfono de
        // las personas que aparecen — un flujo distinto del de arriba, que sí
        // debe decirse.
        // revisión legal humana recomendada antes de publicar
        `**Para investigar a tu empresa antes del primer contacto, es distinto:** un programa lee las páginas públicas del sitio de tu empresa (por ejemplo, la de contacto) y se las manda completas —incluyendo tu nombre, tu puesto, tu correo y tu teléfono si ahí aparecen— a un modelo de lenguaje, para que arme un resumen y localice esos datos de contacto. Ese modelo es uno de los "proveedores encargados" de la sección "Con quién se comparten", más abajo.`,
        `Cualquier uso que no esté escrito aquí requiere pedirte permiso. La ley vigente ya no admite ampararse en fines "compatibles o análogos".`,
      ],
    },
    {
      titulo: 'Cómo pedir que dejemos de contactarte',
      fundamento: 'LFPDPPP art. 15 fr. IV',
      parrafos: [
        `Contesta **BAJA** al mismo mensaje que recibiste, o escribe a **${d.contacto}**. Se deja de contactarte y se borran tus datos de persona; se te confirma por escrito.`,
        `**Si no contestas nunca, también se borran solos:** a los ${meses} meses sin ningún contacto, tu nombre, puesto, correo y teléfono se eliminan automáticamente. Lo único que queda es el registro de la empresa (nombre, giro, plaza), que no es un dato tuyo.`,
      ],
    },
    {
      titulo: 'Cómo ejercer tus derechos ARCO',
      fundamento: 'LFPDPPP art. 15 fr. V',
      parrafos: [
        `Tienes derecho a **Acceder** a tus datos, **Rectificarlos**, **Cancelarlos** y **Oponerte** a su uso.`,
        `**Cómo:** escribe a **${d.contacto}** con tu nombre, un medio para contestarte, copia de una identificación oficial, y qué datos son y qué pides que se haga con ellos.`,
        `**Plazos de la ley:** 20 días hábiles para contestarte y 15 días hábiles más para hacerlo efectivo si procede. Es gratuito; solo puede haber costo de envío o copia.`,
        `Si no te contestamos o la respuesta no te satisface, puedes acudir a la autoridad garante en materia de protección de datos personales.`,
      ],
    },
    {
      titulo: 'Con quién se comparten',
      fundamento: 'LFPDPPP art. 35 · art. 2 fr. XX',
      parrafos: [
        `**No se venden ni se comparten con nadie para que los use por su cuenta.** Pasan por proveedores que trabajan por instrucción de Likida —alojamiento de la base de datos, envío de correo y mensajería, y los modelos de lenguaje que investigan a tu empresa y redactan el primer contacto—, que la ley llama personas encargadas (art. 2 fr. XII) y cuyo uso **no es una transferencia** (art. 2 fr. XX).`,
        // AUDITORÍA 25 (ALTO): la investigación de tu empresa (ver arriba) le
        // manda al modelo tu nombre, correo y teléfono si aparecen en el
        // sitio de tu empresa — a diferencia de la redacción del primer
        // mensaje, que sí va seudonimizada.
        `**A diferencia de la redacción del primer mensaje, la investigación previa no va seudonimizada:** si tu nombre, correo o teléfono aparecen en el sitio de tu empresa, le llegan al modelo tal cual, para que los localice.`,
      ],
    },
    {
      titulo: 'Cómo se avisan los cambios',
      fundamento: 'LFPDPPP art. 15 fr. VI',
      parrafos: [
        `Los cambios se publican en esta misma página, que es la liga que va en cada mensaje. Aquí siempre está la versión vigente.`,
      ],
    },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// LA COMPUERTA: NO SE TRATA ANTES DE AVISAR.
//
// AUDITORÍA 22 (LEG-C1) la puso en la jornada; AUDITORÍA 24 (LEG-1, CRÍTICO)
// encontró que el TRATAMIENTO PRINCIPAL del piloto —800 tractos × 288
// posiciones/día y los eventos de cámara— corría sin ella: el poller escribe
// contra `unidad_id` y nunca tenía al operador a la mano. Se extrae aquí para
// que jornada, GPS y cámara pasen por la MISMA pregunta con la MISMA
// respuesta: «¿este titular ya recibió el aviso?». El principio está escrito
// arriba (`SenalGps`): el consentimiento tiene que ser PREVIO a la primera.
//
// Fallar cerrado: si la base no contesta, la respuesta es «no» — construir
// un expediente o guardar un pin a ciegas es exactamente lo que el art. 16
// prohíbe, y el expuesto es el operador mientras la sancionable es la flota.
// ═══════════════════════════════════════════════════════════════════════════

/** `.in()` de PostgREST viaja en la URL: 200 UUID son ~7.5 KB, debajo del
 *  techo típico de un proxy (misma cifra que `IDS_POR_TANDA` en pg.ts). */
const IDS_POR_CONSULTA = 200;

/**
 * `true` si el operador ya tiene `aviso_privacidad_en`. El `cache` es por
 * corrida (la lista de trabajo de la jornada trae el mismo operador muchas
 * veces); quien no lo pasa consulta cada vez.
 */
export async function tieneAvisoPrevio(
  tenantId: string,
  operadorId: string,
  cache?: Map<string, boolean>,
): Promise<boolean> {
  const llave = `${tenantId}|${operadorId}`;
  const memo = cache?.get(llave);
  if (memo !== undefined) return memo;

  const { data, error } = await acotada(
    supabaseAdmin().from('operador')
      .select('aviso_privacidad_en')
      .eq('tenant_id', tenantId).eq('id', operadorId)
      .maybeSingle(),
    'privacidad.aviso_previo',
  );
  if (error) {
    logger.error('privacidad.aviso_previo_ilegible', { tenantId, operadorId, err: error.message });
    return false;
  }
  const ok = (data as { aviso_privacidad_en: string | null } | null)?.aviso_privacidad_en != null;
  cache?.set(llave, ok);
  return ok;
}

/**
 * Las unidades cuyo operador ACTUAL no ha recibido el aviso — o, si el
 * llamador trata un dato que identifica a quien va al volante aunque no
 * haya viaje abierto (`sinViajeVivo: 'bloquear'`), las unidades sin forma de
 * saber si su conductor dio ese aviso.
 *
 * «Actual» = el del viaje vivo (`abierto`/`en_cuadre`) que lleva esa unidad.
 * Una unidad sin viaje vivo NO tiene, hoy, otra forma de saber quién la
 * conduce — el esquema no tiene una columna "operador actual" fuera de
 * `viaje`. Para la POSICIÓN eso es aceptable por diseño: su GPS es del
 * camión, no de un titular, y se guarda igual (`sinViajeVivo: 'permitir'`,
 * el default).
 *
 * AUDITORÍA 25 (ALTO): para un EVENTO DE CÁMARA no es aceptable — el evento
 * puede traer una liga al video de quién va al volante, y eso identifica a
 * una persona exista o no un viaje abierto para su unidad. Un llamador que
 * trate ese tipo de dato debe pedir `sinViajeVivo: 'bloquear'`: sin forma de
 * saber si el conductor de hoy dio su aviso, la unidad se trata como
 * sin-aviso y no se persiste nada suyo — el mismo criterio de "fallar
 * cerrado" que ya rige cuando la base no contesta.
 *
 * Devuelve `error` cuando la base no contestó: el llamador debe tratar la
 * corrida entera como no autorizada (fallar cerrado), no como «sin aviso: 0».
 */
export async function unidadesSinAvisoPrevio(
  tenantId: string,
  unidadIds: readonly string[],
  opciones: { sinViajeVivo?: 'permitir' | 'bloquear' } = {},
): Promise<{ sinAviso: Set<string>; error?: string }> {
  const sinAviso = new Set<string>();
  if (unidadIds.length === 0) return { sinAviso };
  const bloquearSinViajeVivo = opciones.sinViajeVivo === 'bloquear';

  const operadoresPorUnidad = new Map<string, Set<string>>();
  for (let i = 0; i < unidadIds.length; i += IDS_POR_CONSULTA) {
    const tanda = unidadIds.slice(i, i + IDS_POR_CONSULTA);
    const { data, error } = await acotada(
      supabaseAdmin().from('viaje')
        .select('unidad_id, operador_id')
        .eq('tenant_id', tenantId)
        .in('estatus', ['abierto', 'en_cuadre'])
        .in('unidad_id', tanda),
      'privacidad.viajes_vivos_por_unidad',
    );
    if (error) return { sinAviso, error: `no se pudo saber qué operador lleva cada unidad: ${error.message}` };
    for (const v of (data ?? []) as Array<{ unidad_id: unknown; operador_id: unknown }>) {
      if (!v.unidad_id || !v.operador_id) continue;
      const unidadId = String(v.unidad_id);
      const operadores = operadoresPorUnidad.get(unidadId) ?? new Set<string>();
      operadores.add(String(v.operador_id));
      operadoresPorUnidad.set(unidadId, operadores);
    }
  }
  if (operadoresPorUnidad.size === 0) {
    if (bloquearSinViajeVivo) for (const unidadId of unidadIds) sinAviso.add(unidadId);
    return { sinAviso };
  }

  // Dos viajes vivos de operadores distintos sobre la misma unidad son una
  // asignación ambigua. No se escoge "el último" por orden accidental: aun
  // cuando ambos tengan aviso, no sabemos quién conduce esta lectura.
  for (const [unidadId, operadores] of operadoresPorUnidad) {
    if (operadores.size !== 1) sinAviso.add(unidadId);
  }

  const operadores = [...new Set([...operadoresPorUnidad.values()].flatMap((ids) => [...ids]))];
  const conAviso = new Set<string>();
  for (let i = 0; i < operadores.length; i += IDS_POR_CONSULTA) {
    const tanda = operadores.slice(i, i + IDS_POR_CONSULTA);
    const { data, error } = await acotada(
      supabaseAdmin().from('operador')
        .select('id, aviso_privacidad_en')
        .eq('tenant_id', tenantId)
        .in('id', tanda),
      'privacidad.aviso_previo_por_operador',
    );
    if (error) return { sinAviso, error: `no se pudo leer el aviso de privacidad de los operadores: ${error.message}` };
    for (const o of (data ?? []) as Array<{ id: unknown; aviso_privacidad_en: unknown }>) {
      if (o.aviso_privacidad_en != null) conAviso.add(String(o.id));
    }
  }

  for (const unidadId of unidadIds) {
    const candidatos = operadoresPorUnidad.get(unidadId);
    if (!candidatos || candidatos.size === 0) {
      // Sin viaje vivo: sin forma de saber quién la conduce hoy.
      if (bloquearSinViajeVivo) sinAviso.add(unidadId);
      continue;
    }
    if (candidatos.size !== 1) continue; // ya quedó bloqueada por ambigüedad
    const operadorId = [...candidatos][0];
    if (!conAviso.has(operadorId)) sinAviso.add(unidadId);
  }
  return { sinAviso };
}
