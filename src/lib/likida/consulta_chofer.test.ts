import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// EL ATAJO QUE CONTESTA "¿CUÁNTO LLEVO?" — y el `null` que lo hace seguro.
//
// El módulo tiene DOS clientes y solo uno se ve:
//
//   · el chofer que pregunta, que recibe cifras;
//   · el AGENTE de siempre, que recibe todo lo demás. Ese cliente no aparece
//     en el archivo, pero cada `null` es un mensaje que le llega. Un mensaje
//     que este atajo atiende POR ERROR nunca llega al agente: no se contesta
//     mal, se contesta OTRA COSA, y ahí se acaba el camino.
//
// LA ASIMETRÍA QUE MANDA EN TODO EL ARCHIVO: un falso positivo deja al chofer
// sin respuesta a lo que de verdad preguntó; una consulta que se escapa solo
// cuesta que la conteste el agente — más caro, pero correcto. Por eso los
// patrones están ANCLADOS al mensaje completo y no buscados dentro de él, y por
// eso este archivo dedica tres bloques a los negativos y uno a los aciertos.
//
// Los bloques 4, 5 y 7 son el trío que hay que leer junto:
//   · el 4 son 25 frases reales de operador que la versión de buscar-la-palabra
//     -dentro se tragaba. Son la suite de regresión del arreglo, y ninguna se
//     puede reabrir: todo patrón nuevo pasa antes por ahí.
//   · el 5 ERA el precio del anclaje —consultas legítimas que dejó de
//     reconocer— y hoy ya no lo es: las cortesías se quitan en lazo, las colas
//     ("en total", "hasta ahorita", "del anticipo") entran por lista cerrada, y
//     se reconocen más formas de contar. Están fijadas CON SU TIPO, no con
//     `null`, porque el hueco se cerró.
//   · el 7 es el hueco que SIGUE abierto, ya corto. Una lista explícita es lo
//     que permite decidir cuáles cerrar en vez de descubrirlos por queja.
//
// La segunda mitad fija que la respuesta NO OPINA. "Vas bien" es un juicio que
// depende de la política de la flota —topes por concepto, CFDI exigido, reglas
// por ruta— y lo emite el motor de cuadre. Un mensaje de estado que se adelanta
// a decirlo le está dando al chofer una absolución que nadie firmó.
// ═══════════════════════════════════════════════════════════════════════════

/** Nodo encadenable: `.select().eq().order()` / `.maybeSingle()` → resultado. */
function cadena(resultado: () => unknown) {
  const nodo: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'not', 'limit', 'order']) nodo[m] = () => nodo;
  nodo.maybeSingle = () => Promise.resolve(resultado());
  nodo.then = (r: (v: unknown) => unknown) => Promise.resolve(resultado()).then(r);
  return nodo;
}

/** Lo que devuelve cada tabla en la prueba en curso. */
const respuesta: Record<string, unknown> = {};
const from = vi.fn((tabla: string) => cadena(() => respuesta[tabla] ?? { data: null, error: null }));

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ from: (...a: unknown[]) => from(...(a as [string])) }),
}));

const { interpretarPregunta, armarRespuesta, estadoDelViaje, responderConsulta } =
  await import('./consulta_chofer');
type TipoConsulta = NonNullable<ReturnType<typeof interpretarPregunta>>;

beforeEach(() => {
  from.mockClear();
  for (const k of Object.keys(respuesta)) delete respuesta[k];
});

// ═══════════════════════════════════════════════════════════════════════════
// 1 · interpretarPregunta — LOS ACIERTOS
// ═══════════════════════════════════════════════════════════════════════════

describe('interpretarPregunta reconoce las formas en que se pregunta de verdad', () => {
  it.each([
    ['¿cuánto llevo?', 'saldo'],
    // Un chofer teclea sin tildes en un teléfono, de pie, junto a la unidad.
    ['cuanto llevo', 'saldo'],
    ['CUÁNTO LLEVO', 'saldo'],
    ['cuanto llevo comprobado', 'saldo'],
    ['cuánto llevo del anticipo', 'saldo'],
    ['como voy', 'saldo'],
    ['como vamos', 'saldo'],
    ['cuánto he comprobado', 'saldo'],
    ['cuanto he gastado', 'saldo'],
    ['cuanto me falta', 'saldo'],
    ['cuanto me falta por comprobar', 'saldo'],
    ['mi saldo', 'saldo'],
    ['saldo del anticipo', 'saldo'],
    ['¿qué me falta?', 'faltantes'],
    ['falta algo', 'faltantes'],
    ['me falta algo', 'faltantes'],
    ['me faltan comprobantes', 'faltantes'],
    ['tengo algo pendiente', 'faltantes'],
    ['qué recibiste', 'ultimo'],
    ['cual fue el ultimo', 'ultimo'],
    ['el ultimo ticket', 'ultimo'],
    ['ya te llego mi ticket', 'ultimo'],
    ['cuantos llevo', 'ultimo'],
    ['cuantos van', 'ultimo'],
    ['ayuda', 'ayuda'],
    ['menu', 'ayuda'],
    ['opciones', 'ayuda'],
    ['qué puedo hacer', 'ayuda'],
    ['como funciona', 'ayuda'],
  ] as ReadonlyArray<[string, TipoConsulta]>)('«%s» → %s', (texto, tipo) => {
    expect(interpretarPregunta(texto)).toBe(tipo);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · LA NORMALIZACIÓN — lo que se quita ANTES de comparar
// ═══════════════════════════════════════════════════════════════════════════

describe('normaliza antes de comparar: acentos, mayúsculas, puntuación, cortesías', () => {
  it('LOS ACENTOS YA NO PARTEN LA REGLA EN DOS', () => {
    // La versión anterior comparaba con `\b`, que en JavaScript se calcula con
    // [A-Za-z0-9_]: entre un espacio y una «ú» NO hay frontera de palabra, así
    // que `\b([úu]ltimo|…|lleg[óo])\b` no casaba NUNCA con la forma acentuada.
    // Resultado: los dos ejemplos que el propio encabezado ponía como atendidos
    // —«llegó mi ticket», «cuál fue el último»— caían al agente, y «menú», que
    // es como se escribe, no abría la ayuda. Quitando el acento antes de
    // comparar, el problema deja de existir en vez de esquivarse patrón a patrón.
    expect(interpretarPregunta('llegó mi ticket')).toBe('ultimo');
    expect(interpretarPregunta('cuál fue el último')).toBe('ultimo');
    expect(interpretarPregunta('el último')).toBe('ultimo');
    expect(interpretarPregunta('menú')).toBe('ayuda');
    expect(interpretarPregunta('cuánto llevo')).toBe('saldo');
  });

  it('la misma frase con y sin acento da lo mismo', () => {
    for (const [con, sin] of [['último', 'ultimo'], ['menú', 'menu'], ['cuánto llevo', 'cuanto llevo']]) {
      expect(interpretarPregunta(con), con).toBe(interpretarPregunta(sin));
    }
  });

  it('mayúsculas, signos y espacios de sobra no cambian nada', () => {
    for (const t of ['  ¿CUÁNTO LLEVO?  ', 'Cuánto Llevo', 'CUANTO LLEVO!!', 'cuanto     llevo', 'cuanto..llevo']) {
      expect(interpretarPregunta(t), t).toBe('saldo');
    }
  });

  it('un salto de línea es un espacio más: la pregunta partida se reconoce igual', () => {
    expect(interpretarPregunta('cuánto\nllevo')).toBe('saldo');
  });

  it('las cortesías de un extremo se quitan', () => {
    for (const t of ['oye cuanto llevo', 'jefe cuanto llevo', 'hola, cuanto llevo',
      'pregunta cuanto llevo', 'una pregunta cuanto llevo', 'que onda cuanto llevo',
      'cuanto llevo porfa', 'cuanto llevo gracias', 'oye cuanto llevo porfa']) {
      expect(interpretarPregunta(t), t).toBe('saldo');
    }
  });

  it('EL SALUDO DE VARIAS PALABRAS: se quita en lazo, no en una pasada', () => {
    // Un solo `replace` quitaba UNA cortesía y se atoraba en la siguiente:
    // «oye jefe cuanto llevo» se quedaba en «jefe cuanto llevo» y no casaba con
    // nada. Y «buenas tardes jefe, ¿cuánto llevo?» fallaba por lo mismo — que es
    // la forma EDUCADA de preguntarle al patrón, o sea la que más se escribe.
    // Un operador que saluda antes de preguntar no es un caso raro: es el caso.
    for (const t of ['oye jefe cuanto llevo', 'buenas tardes jefe cuanto llevo',
      'buenos dias jefe cuanto llevo', 'buenas noches jefe cuanto llevo',
      'hola buenas tardes cuanto llevo', 'que onda jefe cuanto llevo',
      'oye amigo cuanto llevo', 'hey jefe cuanto llevo',
      'Buenas tardes jefe\n¿cuánto llevo comprobado?',
      'cuanto llevo porfa gracias']) {
      expect(interpretarPregunta(t), t).toBe('saldo');
    }
    // Y el saludo no es exclusivo del saldo: envuelve cualquier consulta.
    expect(interpretarPregunta('hola jefe me falta algo')).toBe('faltantes');
    expect(interpretarPregunta('buenas tardes cuantos comprobantes llevo')).toBe('ultimo');
  });

  it('quitar la cortesía NO convierte un mensaje de operador en consulta', () => {
    // El lazo es lo único que se aflojó, y aflojar es exactamente como se
    // reabren los falsos positivos del bloque 4. Las mismas frases, ahora con
    // saludo delante y "jefe" detrás, tienen que seguir llegando al agente.
    for (const t of ['oye jefe ya llego', 'buenas tardes jefe ya llego',
      'hola jefe recibido', 'jefe ya me falta poco para llegar',
      'buenas jefe no llego a tiempo', 'oye jefe me falta diesel',
      'jefe quedo pendiente', 'oye jefe no tengo saldo',
      'que onda jefe ya llego', 'oye jefe ya acabe', 'ya llego jefe',
      'no llego jefe', 'recibido jefe porfa']) {
      expect(interpretarPregunta(t), t).toBeNull();
    }
    // Y una cortesía sola no es una pregunta: al quitarla no queda nada.
    for (const t of ['hola', 'jefe', 'oye', 'buenas tardes', 'gracias jefe']) {
      expect(interpretarPregunta(t), t).toBeNull();
    }
  });

  it('el tope de 45 se mide DESPUÉS de normalizar, así que el saludo no lo gasta', () => {
    const conSaludo = 'oye jefe, ¿cuánto llevo comprobado del anticipo?';
    expect(conSaludo.length).toBe(48);              // crudo se pasaría del tope
    expect(interpretarPregunta(conSaludo)).toBe('saldo');   // normalizado son 36
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · LOS NEGATIVOS de siempre
// ═══════════════════════════════════════════════════════════════════════════

describe('interpretarPregunta devuelve null cuando no es una consulta', () => {
  it.each([
    ['', 'vacío'],
    ['   ', 'solo espacios'],
    ['?', 'solo puntuación — al normalizar no queda nada'],
    ['👍', 'solo emoji'],
    ['👍👍👍', 'solo emojis'],
    ['ya quedó jefe', 'un acuse cualquiera'],
    ['aquí está el ticket de la caseta', 'lo que acompaña a una foto'],
    ['ya acabé', 'el cierre, que lo atiende el agente'],
    ['se me ponchó una llanta en la 57', 'una incidencia'],
  ])('«%s» (%s) → null', (texto) => {
    expect(interpretarPregunta(texto)).toBeNull();
  });

  it('lo que pasa de 45 caracteres ya no es una consulta suelta', () => {
    // Una pregunta de estado es CORTA; el chatter de un chofer no lo es, y esa
    // diferencia hace la mitad del trabajo de separarlos. El tope se mide
    // DESPUÉS de normalizar, así que la cortesía y los signos no lo gastan.
    const largo = 'cuanto llevo y también quería contarte lo de la caseta';
    expect(largo.length).toBeGreaterThan(45);
    expect(interpretarPregunta(largo)).toBeNull();
    expect(interpretarPregunta('  ¿CUÁNTO LLEVO, PORFA?  ')).toBe('saldo');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · LAS 25 FRASES DE OPERADOR QUE LA VERSIÓN ANTERIOR SE TRAGABA.
//
// Todas son mensajes que un chofer manda en ruta y que la regla de buscar-la-
// palabra-dentro atendía como consulta: el chofer recibía un estado de cuenta y
// su mensaje real —«voy llegando», «no llego a tiempo», «recibido»— NUNCA
// llegaba al agente. La peor contestaba con el último ticket a alguien que
// estaba avisando que no llegaba.
//
// Este bloque es la suite de regresión de ese arreglo. Cada renglón tiene que
// seguir devolviendo `null` — o sea, seguir llegando al agente.
// ═══════════════════════════════════════════════════════════════════════════

describe('las 25 frases de operador llegan al agente, no a este atajo', () => {
  it.each([
    // ── las que atrapaba `\bfalta(n|rme)?\b|\bpendiente` ──
    ['ya me falta poco para llegar'],
    ['cuánto me falta de camino'],
    ['me falta diesel, ¿me autorizan carga?'],
    ['falta el sello del cliente en la carta porte'],
    ['me faltan 200 km'],
    ['sigo pendiente de que me carguen'],
    ['quedo pendiente'],
    // ── las que atrapaba `\bsaldo\b` ──
    ['se me acabó el saldo del celular'],
    ['no tengo saldo para llamar'],
    // ── "como" es también conjunción y verbo; "va" es cualquier cosa ──
    ['¿cuánto tiempo va a tardar la descarga?'],
    ['cuánto se va a tardar el cliente'],
    ['como voy saliendo tarde, ¿cancelo el viaje?'],
    ['¿cómo va el trámite del permiso?'],
    ['cuánto peso llevo en la caja'],
    // ── `lleg[óo]` atrapaba el presente "llego", que es media operación ──
    ['ya llego'],
    ['en 20 minutos llego'],
    ['no llego a tiempo'],
    ['no llego al cierre de la gasolinera'],
    ['ya casi llego a la caseta'],
    ['no llego el cliente'],
    ['el ultimo cliente ya me firmo'],
    // ── "recibido" es el acuse de radio de toda la vida ──
    ['recibido'],
    ['recibido jefe'],
    ['recibido, voy en camino'],
    // ── "ayuda" también es un grito ──
    ['ayuda! se me ponchó una llanta'],
  ])('«%s» → null', (texto) => {
    expect(interpretarPregunta(texto)).toBeNull();
  });

  it('el que más dolía, de punta a punta: "no llego a tiempo" ya no se contesta solo', async () => {
    // Antes: el chofer avisaba que iba tarde y recibía "El último que recibí fue
    // diesel por $400". El aviso de retraso no llegaba a nadie. `null` significa
    // que el mensaje sigue su camino al agente, que es quien sabe qué hacer con
    // un retraso.
    expect(interpretarPregunta('no llego a tiempo')).toBeNull();
    expect(await responderConsulta('no llego a tiempo', 't-1', 'v-1')).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it('y ninguna de ellas toca la base', async () => {
    for (const t of ['ya llego', 'recibido jefe', 'se me acabó el saldo del celular']) {
      expect(await responderConsulta(t, 't-1', 'v-1'), t).toBeNull();
    }
    expect(from).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · LO QUE ERA EL HUECO DEL ANCLAJE Y YA NO LO ES.
//
// Anclar al mensaje completo cerró los 25 falsos positivos del bloque 4 y cobró
// su precio: una consulta de verdad que no coincidiera palabra por palabra caía
// al agente. Nunca fue un bug —el agente contesta, nadie recibe una cifra
// falsa— pero era el atajo que no se tomaba, con la latencia y el costo que
// este módulo existe para ahorrar.
//
// El precio ya se pagó de vuelta, por tres caminos y ninguno con comodín:
//   · las cortesías se quitan EN LAZO, así que el saludo largo deja de estorbar;
//   · las colas entran por LISTA CERRADA (`COLA`) — "en total", "hasta ahorita",
//     "del anticipo"— y no por `.*`, que reabriría todo lo que el anclaje cerró;
//   · se reconocen más formas de contar, nombrando lo que se cuenta.
//
// Este bloque era la lista de huecos; ahora es la prueba de que se cerraron.
// Cada renglón está fijado CON SU TIPO: si alguno vuelve a `null`, se perdió
// cobertura que ya se había ganado.
// ═══════════════════════════════════════════════════════════════════════════

describe('YA NO ES HUECO: el reconocedor apretado atiende estas consultas', () => {
  it.each([
    // ── saldo: la cola de lista cerrada ya no lo desarma ──
    ['cuanto llevo hasta ahorita', 'saldo'],
    ['cuanto llevo en total', 'saldo'],
    ['cuanto llevo hoy', 'saldo'],
    ['cuanto llevo acumulado', 'saldo'],
    ['cuánto llevo comprobado hasta ahora', 'saldo'],
    ['cuanto dinero llevo', 'saldo'],
    ['cuanto llevo del viaje', 'saldo'],
    ['cuanto llevo gastado del anticipo', 'saldo'],
    ['como voy con el anticipo', 'saldo'],
    ['como voy en el viaje', 'saldo'],
    ['cual es mi saldo', 'saldo'],
    ['saldo actual', 'saldo'],
    ['y mi saldo?', 'saldo'],
    ['cuanto me queda', 'saldo'],
    ['que llevo', 'saldo'],
    ['que tanto llevo', 'saldo'],
    ['cuanto he abonado', 'saldo'],
    // ── faltantes: "por mandar", "más" y "hace falta" ya casan ──
    ['que me falta por mandar', 'faltantes'],
    ['me falta algo por mandar', 'faltantes'],
    ['me falta algo mas', 'faltantes'],
    ['falta algo mas', 'faltantes'],
    ['que me hace falta', 'faltantes'],
    ['me hace falta algo', 'faltantes'],
    ['y que me falta', 'faltantes'],
    // ── conteo: NOMBRAR lo que se cuenta ya no lo rompe.
    //    Cae en 'ultimo' a propósito: esa respuesta ya dice "van N en total",
    //    que es justo lo que se preguntó.
    ['cuantos comprobantes llevo', 'ultimo'],
    ['cuantos comprobantes van', 'ultimo'],
    ['cuantos comprobantes tengo', 'ultimo'],
    ['cuantos tickets llevo', 'ultimo'],
    ['cuantas fotos van', 'ultimo'],
    // ── último: la liga «mi|el|la» y el acuse sin sujeto ──
    ['te llego la foto', 'ultimo'],
    ['ya te llego?', 'ultimo'],
    ['y el ultimo?', 'ultimo'],
    ['cual fue el ultimo que te mande', 'ultimo'],
    // ── ayuda: ya no tiene que ser la palabra sola ──
    ['menu de opciones', 'ayuda'],
    ['que opciones tengo', 'ayuda'],
  ] as ReadonlyArray<[string, TipoConsulta]>)('«%s» → %s', (texto, tipo) => {
    expect(interpretarPregunta(texto)).toBe(tipo);
  });

  it('LA COLA ES UNA LISTA CERRADA, no un comodín — y ahí está todo el riesgo', () => {
    // `COLA` es lo único que se aflojó del lado del saldo, y un comodín ahí
    // reabre el bloque 4. MEDIDO, no supuesto: sustituyendo `COLA` por
    // `(?: .*)?` se reconocen las mismas frases de arriba y se vuelven a tragar
    // 5 de las 25 —«cuánto me falta de camino», «me falta diesel, ¿me autorizan
    // carga?», «me faltan 200 km», «como voy saliendo tarde, ¿cancelo el
    // viaje?», «¿cómo va el trámite del permiso?»—: mensajes de operación que
    // recibirían un estado de cuenta en lugar de llegar al agente.
    //
    // Estas líneas son el guardián de esa decisión. Si alguna devuelve un tipo
    // en vez de `null`, alguien cambió `COLA` por algo abierto.
    for (const t of ['cuanto llevo de camino', 'cuanto llevo en la caja',
      'cuanto llevo de carga', 'cuanto llevo de retraso', 'cuanto llevo de peso',
      'cuanto llevo esperando', 'que llevo en la caja', 'que llevo de carga',
      'como voy de camino', 'como voy de tiempo', 'cuanto me falta de camino',
      'cuanto me falta de gasolina', 'me falta algo de camino',
      'que me falta de camino', 'cuantos km llevo', 'cuanto tiempo llevo',
      'cuantas horas llevo']) {
      expect(interpretarPregunta(t), t).toBeNull();
    }
  });

  it('la cola no inventa una consulta donde no había pregunta', () => {
    // Los sufijos de `COLA` son palabras comunes ("total", "hoy", "mas"). Solas
    // no son nada, y tienen que seguir sin serlo: la cola es un sufijo de un
    // patrón, no un patrón.
    for (const t of ['total', 'hoy', 'en total', 'hasta ahorita', 'acumulado',
      'del anticipo', 'llevo', 'llego']) {
      expect(interpretarPregunta(t), t).toBeNull();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 · "AYUDA" SÍ ABRE EL MENÚ; "AYÚDAME" NO. Y es a propósito.
//
// La diferencia no es de gramática: es de a quién se le contesta. En boca de un
// operador de carretera «ayúdame» y «necesito ayuda» son un AUXILIO —se quedó
// tirado, se le ponchó, lo pararon— y contestarle con una lista de opciones
// sería el peor mensaje que este producto puede mandar. Van al agente, que sí
// puede leer el contexto y escalar con un humano.
//
// «ayuda» a secas es otra cosa: es la palabra que se teclea para ver qué se
// puede hacer, como en cualquier bot. Se atiende, y se atiende sola.
// ═══════════════════════════════════════════════════════════════════════════

describe('«ayúdame» es un auxilio, no una petición de menú', () => {
  it.each([
    ['ayudame'],
    ['ayúdame'],
    ['necesito ayuda'],
    ['ayudenme'],
    ['me ayudas'],
    ['auxilio'],
    ['ayuda! se me ponchó una llanta'],
    ['ayuda me quede tirado'],
  ])('«%s» → null: lo lee el agente, no el menú', (texto) => {
    expect(interpretarPregunta(texto)).toBeNull();
  });

  it('de punta a punta: un auxilio no recibe el menú y no toca la base', async () => {
    for (const t of ['ayudame', 'necesito ayuda', 'ayuda! se me ponchó una llanta']) {
      expect(await responderConsulta(t, 't-1', 'v-1'), t).toBeNull();
    }
    expect(from).not.toHaveBeenCalled();
  });

  it('la palabra sola SÍ abre el menú, con o sin cortesía alrededor', () => {
    // El otro lado de la decisión, fijado para que se vea que es una línea
    // trazada y no un descuido. OJO: la cortesía en lazo hizo que «oye jefe
    // ayuda» también abra el menú, y esa frase se parece bastante a un auxilio.
    // Queda anotado aquí para que sea una decisión revisable, no un hallazgo.
    for (const t of ['ayuda', 'menu', 'menú', 'opciones', 'help',
      'ayuda porfa', 'hola ayuda', 'oye jefe ayuda']) {
      expect(interpretarPregunta(t), t).toBe('ayuda');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 · EL HUECO QUE SIGUE ABIERTO.
//
// Lo que queda después de apretar: consultas legítimas que todavía caen al
// agente. Sigue siendo el lado barato del error —el agente contesta, nadie
// recibe una cifra falsa— y sigue costando la latencia que este módulo ahorra.
//
// Se fija la lista para que sea una decisión y no un olvido. Cada renglón que
// alguien decida atender se mueve arriba con su tipo — y tiene que pasar antes
// por el bloque 4 y por la prueba de la cola cerrada, que son las dos que
// impiden que la cura reabra el mal.
// ═══════════════════════════════════════════════════════════════════════════

describe('HUECO QUE SIGUE ABIERTO: consultas legítimas que llegan al agente', () => {
  it.each([
    // ── el verbo que introduce la pregunta rompe el anclaje ──
    ['dime cuanto llevo'],
    ['sabes cuanto llevo'],
    ['me puedes decir cuanto llevo'],
    ['checame cuanto llevo'],
    // ── dos preguntas en un mensaje ──
    ['cuanto llevo y cuanto me falta'],
    // ── faltantes: sin «me» delante, o contando lo que falta ──
    ['que falta'],
    ['que tanto me falta'],
    ['cuantos comprobantes me faltan'],
    // ── último: el plural y el «me» en vez del «te» ──
    ['ya te llegaron mis tickets'],
    ['llegaron mis fotos'],
    ['ya me llego'],
    // ── el nombre que le da la oficina, no el chofer ──
    ['mi estado de cuenta'],
    ['estado de cuenta'],
  ])('«%s» debería reconocerse y hoy cae al agente', (texto) => {
    expect(interpretarPregunta(texto)).toBeNull();
  });

  it('el tope de 45 corta una consulta legítima larga', () => {
    // Con la cola encadenable se pueden escribir consultas válidas más largas
    // que el tope. El tope gana, y está bien que gane: es el que separa la
    // consulta del chatter, y aflojarlo cuesta falsos positivos.
    const t = 'cuanto llevo comprobado del anticipo del viaje';
    expect(t.length).toBe(46);
    expect(interpretarPregunta(t)).toBeNull();
    // La misma pregunta sin la última cola —36 caracteres— sí entra.
    expect(interpretarPregunta('cuanto llevo comprobado del anticipo')).toBe('saldo');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8 · armarRespuesta — cifras sí, veredicto no
// ═══════════════════════════════════════════════════════════════════════════

const ESTADO = {
  anticipo: 10600, comprobado: 8400, comprobantes: 6,
  ultimoConcepto: 'diesel', ultimoMonto: 1200, enRevision: 0,
};

describe('armarRespuesta · saldo', () => {
  it('dice comprobado, anticipo, cuántos y cuánto falta', () => {
    const t = armarRespuesta('saldo', ESTADO);
    expect(t).toContain(pesos(8400));
    expect(t).toContain(pesos(10600));
    expect(t).toContain('6 comprobante(s)');
    expect(t).toContain(pesos(2200));
  });

  it('anticipo en 0 NO se imprime como cifra: se dice que no hay dato', () => {
    // Un 0 en `viaje.anticipo` puede ser "no le dieron nada" o "nadie lo
    // capturó", y las dos se ven igual. Restarle lo comprobado daría un
    // "te sobran $8,400" que es pura invención.
    const t = armarRespuesta('saldo', { ...ESTADO, anticipo: 0 });
    expect(t).toMatch(/no tiene anticipo registrado/i);
    expect(t).toMatch(/no te puedo decir cuánto te falta/i);
    expect(t).not.toContain('$0.00');
    expect(t).toContain(pesos(8400));   // lo que sí se sabe, sigue estando
  });

  it('un anticipo negativo se trata igual que el 0, no se resta', () => {
    expect(armarRespuesta('saldo', { ...ESTADO, anticipo: -50 })).toMatch(/no tiene anticipo registrado/i);
  });

  it('sobregiro: lo dice en positivo, sin cifra negativa en pantalla', () => {
    const t = armarRespuesta('saldo', { ...ESTADO, anticipo: 1000, comprobado: 1500 });
    expect(t).toContain('Comprobaste');
    expect(t).toContain(pesos(500));
    // "-$500.00" en el teléfono de un chofer no se lee como sobregiro.
    expect(t).not.toContain('-$');
    expect(t).not.toMatch(/te faltan/i);
  });

  it('exacto: ni faltan ni sobran, y tampoco se felicita a nadie', () => {
    const t = armarRespuesta('saldo', { ...ESTADO, anticipo: 8400, comprobado: 8400 });
    expect(t).toContain('Vas justo con el anticipo');
    expect(t).not.toMatch(/te faltan|comprobaste .* más/i);
  });

  it('sin un solo comprobante dice 0, que ahí sí es una medición', () => {
    const t = armarRespuesta('saldo', { ...ESTADO, comprobado: 0, comprobantes: 0 });
    expect(t).toContain('0 comprobante(s)');
    expect(t).toContain(pesos(10600));
  });
});

describe('armarRespuesta · faltantes', () => {
  it('suma el dinero que falta y las fotos que se leyeron mal', () => {
    const t = armarRespuesta('faltantes', { ...ESTADO, enRevision: 2 });
    expect(t).toContain(pesos(2200));
    expect(t).toMatch(/2 foto\(s\) se leyeron mal/);
  });

  it('sin nada pendiente dice qué hacer para cerrar', () => {
    const t = armarRespuesta('faltantes', { ...ESTADO, comprobado: 10600 });
    expect(t).toMatch(/no falta nada/i);
    expect(t).toMatch(/escribe que terminaste/i);
  });

  it('SIN ANTICIPO no afirma que no falta nada — dice qué sabe y qué no', () => {
    // Las dos preguntas tienen que contar la MISMA historia. Antes, el mismo
    // estado contestaba "no te puedo decir cuánto te falta" a «¿cuánto llevo?»
    // y "Por mi parte no falta nada" a «¿me falta algo?»: la segunda afirmaba
    // sobre el dato que la primera reconocía no tener, y el chofer cerraba el
    // viaje creyendo que había comprobado todo.
    const sinAnticipo = { ...ESTADO, anticipo: 0, comprobado: 8400, comprobantes: 6, enRevision: 0 };
    const t = armarRespuesta('faltantes', sinAnticipo);

    expect(t).not.toMatch(/no falta nada/i);
    expect(t).toMatch(/no tiene anticipo registrado/i);
    expect(t).toMatch(/no te puedo decir si te falta algo/i);
    // Y sigue diciendo lo que sí se sabe: cuántos lleva y por cuánto.
    expect(t).toContain('6 comprobante(s)');
    expect(t).toContain(pesos(8400));
    // Ninguna de las dos versiones se contradice con la otra.
    expect(armarRespuesta('saldo', sinAnticipo)).toMatch(/no te puedo decir/i);
  });

  it('sin anticipo pero con fotos ilegibles, eso sí se dice (es un hecho, no un saldo)', () => {
    const t = armarRespuesta('faltantes', { ...ESTADO, anticipo: 0, enRevision: 2 });
    expect(t).toMatch(/2 foto\(s\) se leyeron mal/);
  });

  it('en sobregiro no reclama dinero que no falta', () => {
    const t = armarRespuesta('faltantes', { ...ESTADO, anticipo: 1000, comprobado: 1500 });
    expect(t).not.toMatch(/te faltan/i);
  });
});

describe('armarRespuesta · último y ayuda', () => {
  it('el último dice concepto, monto y el total que van', () => {
    const t = armarRespuesta('ultimo', ESTADO);
    expect(t).toContain('diesel');
    expect(t).toContain(pesos(1200));
    expect(t).toContain('6 en total');
  });

  it('sin comprobantes lo dice, no inventa uno', () => {
    const t = armarRespuesta('ultimo', { ...ESTADO, ultimoConcepto: null, ultimoMonto: null, comprobantes: 0 });
    expect(t).toMatch(/todavía no me llega ningún comprobante/i);
    expect(t).not.toContain('$');
  });

  it('un comprobante sin monto legible se dice así, NUNCA como $0.00', () => {
    // Un cero que parece medición es la cifra inventada que este producto no
    // imprime: el chofer leería "recibí tu diesel por $0.00" y daría por bueno
    // un comprobante que no vale nada.
    for (const monto of [null, Number.NaN]) {
      const t = armarRespuesta('ultimo', { ...ESTADO, ultimoMonto: monto });
      expect(t).toContain('diesel');
      expect(t).toContain('(sin monto legible)');
      expect(t).not.toContain('$0.00');
      expect(t).not.toMatch(/NaN/);
    }
  });

  it('la ayuda enseña las tres cosas que el chofer puede hacer', () => {
    const t = armarRespuesta('ayuda', ESTADO);
    expect(t).toMatch(/foto/i);
    expect(t).toMatch(/cuánto llevo/i);
    expect(t).toMatch(/terminaste/i);
  });
});

describe('armarRespuesta NUNCA opina', () => {
  const ESTADOS = [
    ESTADO,
    { ...ESTADO, anticipo: 0 },
    { ...ESTADO, comprobado: 10600 },                       // exacto
    { ...ESTADO, anticipo: 1000, comprobado: 1500 },        // sobregiro
    { ...ESTADO, comprobado: 0, comprobantes: 0, ultimoConcepto: null, ultimoMonto: null },
    { ...ESTADO, ultimoMonto: null },
    { ...ESTADO, enRevision: 3 },
  ];

  it('no dice "bien", ni "en orden", ni felicita, en ninguna combinación', () => {
    const juicios = /\bbien\b|todo en orden|vas perfecto|excelente|¡felicidades|correcto\b/i;
    for (const tipo of ['saldo', 'faltantes', 'ultimo', 'ayuda'] as const) {
      for (const e of ESTADOS) {
        const t = armarRespuesta(tipo, e);
        expect(t, `«${t}» opina, y el veredicto lo da el motor de cuadre`).not.toMatch(juicios);
      }
    }
  });

  it('nunca imprime $0.00 salvo donde el 0 es una medición real', () => {
    // El único caso legítimo es "0 comprobante(s) por $0.00" en `saldo`: ahí el
    // cero SÍ se midió —no llegó nada— y es distinto de un dato que nadie
    // capturó. En las demás respuestas no tiene por qué aparecer.
    for (const tipo of ['faltantes', 'ultimo', 'ayuda'] as const) {
      for (const e of ESTADOS) {
        expect(armarRespuesta(tipo, e), tipo).not.toContain('$0.00');
      }
    }
  });

  it('sin viaje abierto contesta lo mismo para cualquier pregunta y no inventa cifras', () => {
    for (const tipo of ['saldo', 'faltantes', 'ultimo', 'ayuda'] as const) {
      const t = armarRespuesta(tipo, null);
      expect(t).toMatch(/no tienes un viaje abierto/i);
      expect(t).not.toContain('$');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9 · estadoDelViaje — la consulta, que ahora falla cerrado
// ═══════════════════════════════════════════════════════════════════════════

describe('estadoDelViaje', () => {
  it('suma lo comprobado, cuenta los comprobantes y toma el más reciente', async () => {
    respuesta.viaje = { data: { anticipo: '10600.00' }, error: null };
    // AUDITORÍA 28, TC-A2: la consulta real ahora pide `created_at` ASCENDENTE
    // (lo exige `copiasDeComprobante`, que marca la PRIMERA aparición como
    // original) — el fixture va en ese mismo orden, y "el más reciente" es el
    // ÚLTIMO elemento de la lista, no el primero.
    respuesta.gasto = {
      data: [
        { id: 'g-1', concepto: 'caseta', monto: '300.50', ocr_confianza: '0.400', created_at: '2026-08-03T10:00:00Z' },
        { id: 'g-2', concepto: 'diesel', monto: '1200.00', ocr_confianza: '0.950', created_at: '2026-08-04T18:00:00Z' },
      ],
      error: null,
    };

    // PostgREST devuelve `numeric` como string: si esto se sumara sin Number,
    // "1200.00" + "300.50" daría la concatenación y nadie lo notaría hasta ver
    // un saldo de siete cifras.
    expect(await estadoDelViaje('t-1', 'v-1')).toEqual({
      anticipo: 10600,
      comprobado: 1500.5,
      comprobantes: 2,
      ultimoConcepto: 'diesel',
      ultimoMonto: 1200,
      enRevision: 1,     // solo el de 0.40; el de 0.95 no
    });
  });

  it('confianza NULA no cuenta como "en revisión": no se sabe nada de ella', async () => {
    respuesta.viaje = { data: { anticipo: 100 }, error: null };
    respuesta.gasto = {
      data: [{ concepto: 'caseta', monto: 50, ocr_confianza: null, created_at: '2026-08-04T18:00:00Z' }],
      error: null,
    };
    expect((await estadoDelViaje('t-1', 'v-1'))!.enRevision).toBe(0);
  });

  it('0.7 exacto NO va a revisión; 0.699 sí', async () => {
    respuesta.viaje = { data: { anticipo: 100 }, error: null };
    respuesta.gasto = {
      data: [
        { concepto: 'a', monto: 1, ocr_confianza: 0.7, created_at: '2026-08-04T18:00:00Z' },
        { concepto: 'b', monto: 1, ocr_confianza: 0.699, created_at: '2026-08-03T18:00:00Z' },
      ],
      error: null,
    };
    expect((await estadoDelViaje('t-1', 'v-1'))!.enRevision).toBe(1);
  });

  it('un viaje que no es de esta flota devuelve null', async () => {
    respuesta.viaje = { data: null, error: null };
    respuesta.gasto = { data: [], error: null };
    expect(await estadoDelViaje('OTRA', 'v-1')).toBeNull();
  });

  it('sin anticipo capturado devuelve 0 sin reventar', async () => {
    respuesta.viaje = { data: { anticipo: null }, error: null };
    respuesta.gasto = { data: [], error: null };
    expect(await estadoDelViaje('t-1', 'v-1')).toMatchObject({
      anticipo: 0, comprobado: 0, comprobantes: 0, ultimoConcepto: null, ultimoMonto: null,
    });
  });

  it('FALLA CERRADO: un error en los gastos LANZA en vez de leerse como "no hay comprobantes"', async () => {
    // supabase-js reporta el error POR VALOR. Sin comprobarlo, una base caída
    // devolvía `data: null` y este módulo le decía al chofer "Llevas $0.00 de
    // $10,600. Te faltan $10,600" habiendo mandado veinte tickets: una cifra
    // falsa que suena a medición, que es la peor forma de equivocarse que tiene
    // el producto.
    respuesta.viaje = { data: { anticipo: 10600 }, error: null };
    respuesta.gasto = { data: null, error: { message: 'timeout' } };

    await expect(estadoDelViaje('t-1', 'v-1')).rejects.toThrow(/estadoDelViaje\/gastos: timeout/);
  });

  it('FALLA CERRADO: un error en el viaje LANZA en vez de decir "no tienes viaje abierto"', async () => {
    // El `!viaje` de abajo no distingue "no existe" de "no se pudo leer", y la
    // segunda le afirmaba algo falso a un chofer que sí tiene viaje.
    respuesta.viaje = { data: null, error: { message: 'connection refused' } };
    respuesta.gasto = { data: [{ concepto: 'diesel', monto: 400, ocr_confianza: 0.9, created_at: 'x' }], error: null };

    await expect(estadoDelViaje('t-1', 'v-1')).rejects.toThrow(/estadoDelViaje\/viaje: connection refused/);
  });

  it('el mensaje dice CUÁL de las dos consultas falló', async () => {
    // Las dos van en paralelo: sin la etiqueta, quien depura no sabe si el
    // problema está en `viaje` o en `gasto`.
    respuesta.viaje = { data: null, error: { message: 'x' } };
    respuesta.gasto = { data: null, error: { message: 'y' } };
    await expect(estadoDelViaje('t-1', 'v-1')).rejects.toThrow(/\/viaje:/);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AUDITORÍA 28, TC-A2 (ALTO): copias del mismo ticket sumaban dos veces.
  //
  // El protocolo normal manda DOS fotos por comprobante (ticket + acercamiento
  // del voucher), así que una foto duplicada no es el caso raro: es el flujo
  // de todos los días. Antes esto sumaba las 6 filas de 3 tickets reales y
  // podía decirle al chofer "no te falta nada" con comprobantes de verdad sin
  // mandar. Misma regla que ya corrige `tools.ts` (TC-1, auditoría 24):
  // `copiasDeComprobante`, exportada del motor, no una copia de la regla.
  // ═══════════════════════════════════════════════════════════════════════
  it('3 tickets con 2 fotos cada uno cuentan UNA vez — no "no te falta nada"', async () => {
    respuesta.viaje = { data: { anticipo: 12000 }, error: null };
    respuesta.gasto = {
      data: [
        // Ticket A: mismo folio, mismo monto → la segunda foto es copia de la primera.
        { id: 'g-a1', concepto: 'caseta', monto: 2000, folio: '00123', folio_norm: '123', ocr_confianza: 0.9, created_at: '2026-08-03T08:00:00Z' },
        { id: 'g-a2', concepto: 'caseta', monto: 2000, folio: '00123', folio_norm: '123', ocr_confianza: 0.9, created_at: '2026-08-03T08:01:00Z' },
        // Ticket B: mismo CFDI uuid (orden 1 por default en ambas) → copia.
        { id: 'g-b1', concepto: 'diesel', monto: 2100, cfdi_uuid: 'AAAA-1111', ocr_confianza: 0.9, created_at: '2026-08-03T09:00:00Z' },
        { id: 'g-b2', concepto: 'diesel', monto: 2100, cfdi_uuid: 'aaaa-1111', ocr_confianza: 0.9, created_at: '2026-08-03T09:01:00Z' },
        // Ticket C: mismo folio, mismo monto → copia.
        { id: 'g-c1', concepto: 'caseta', monto: 2000, folio: '00456', folio_norm: '456', ocr_confianza: 0.9, created_at: '2026-08-03T10:00:00Z' },
        { id: 'g-c2', concepto: 'caseta', monto: 2000, folio: '00456', folio_norm: '456', ocr_confianza: 0.9, created_at: '2026-08-03T10:01:00Z' },
      ],
      error: null,
    };
    const estado = await estadoDelViaje('t-1', 'v-1');
    expect(estado).toMatchObject({ anticipo: 12000, comprobado: 6100, comprobantes: 3 });
    expect(armarRespuesta('faltantes', estado)).toBe('Te faltan $5,900.00 por comprobar.');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10 · responderConsulta — el atajo completo
// ═══════════════════════════════════════════════════════════════════════════

describe('responderConsulta', () => {
  it('lo que no es consulta devuelve null Y NO TOCA LA BASE', async () => {
    expect(await responderConsulta('aquí va el ticket', 't-1', 'v-1')).toBeNull();
    // Que no consulte importa tanto como el null: este atajo corre delante del
    // agente en el presupuesto del webhook de WhatsApp.
    expect(from).not.toHaveBeenCalled();
  });

  it('sin viaje abierto contesta sin consultar nada', async () => {
    const r = await responderConsulta('cuánto llevo', 't-1', null);
    expect(r).toMatch(/no tienes un viaje abierto/i);
    expect(from).not.toHaveBeenCalled();
  });

  it('con viaje abierto contesta con las cifras de ese viaje', async () => {
    respuesta.viaje = { data: { anticipo: 5000 }, error: null };
    respuesta.gasto = {
      data: [{ concepto: 'diesel', monto: 1200, ocr_confianza: 0.95, created_at: '2026-08-04T18:00:00Z' }],
      error: null,
    };
    const r = await responderConsulta('¿cuánto llevo?', 't-1', 'v-1');
    expect(r).toContain(pesos(1200));
    expect(r).toContain(pesos(5000));
    expect(from).toHaveBeenCalledWith('viaje');
    expect(from).toHaveBeenCalledWith('gasto');
  });

  it('si la base falla, PROPAGA el error en vez de contestar una cifra falsa', async () => {
    // Quien llama decide qué decirle al chofer —"ahorita no puedo consultarlo"—
    // pero nunca una cifra que no se midió.
    respuesta.viaje = { data: { anticipo: 5000 }, error: null };
    respuesta.gasto = { data: null, error: { message: 'timeout' } };
    await expect(responderConsulta('cuánto llevo', 't-1', 'v-1')).rejects.toThrow(/timeout/);
  });
});

/**
 * La cifra tal como la imprime `mxn`, sin reimplementar el formato aquí ni
 * escribirlo a mano: un "$8,400.00" literal seguiría verde el día que el
 * formato cambie, mientras el mensaje del chofer ya dice otra cosa.
 */
function pesos(n: number): string {
  return n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
}
