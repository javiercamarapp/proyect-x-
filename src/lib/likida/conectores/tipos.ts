// ═══════════════════════════════════════════════════════════════════════════
// EL CONTRATO QUE CUMPLE TODO CONECTOR — ERP, GPS, TAG y monedero.
//
// De qué se trata este directorio: hoy Likida no tiene credenciales de NINGUNA
// instancia real de SAP, de Wialon ni de un TAG. O sea que no hay una sola
// conexión viva que se pueda verificar. Lo que sí se puede —y es lo único
// honesto que se puede hacer antes del primer cliente— es dejar escrito el
// contrato y los adaptadores, para que conectar a una flota sea CAPTURAR
// CREDENCIALES y no escribir código.
//
// Por eso este archivo no define "un cliente de API". Define una FICHA: qué
// pide cada sistema, qué sabe hacer, cómo entra el dato hoy, y de dónde salió
// el endpoint que dice hablar. La ficha es lo que se puede verificar sin
// clientes; la conexión es lo que no.
//
// ── DE DÓNDE VIENE LA FORMA ──────────────────────────────────────────────
//
// `facturacion/adaptadores/registro.ts` ya resolvió este problema una vez para
// portales de facturación, y su lección se copia entera:
//
//   · UNA TABLA declarativa. Agregar un sistema es agregar una entrada, nunca
//     tocar el motor. Una segunda lista escrita a mano se desincroniza.
//   · CENTINELAS en vez de huecos. Un adaptador que no puede operar devuelve
//     un resultado que DICE POR QUÉ, en vez de `null`. Un `null` obliga a la
//     capa de arriba a inventar el mensaje, y el mensaje que inventa es el
//     mismo que se enseña cuando el sistema no está escrito — dos problemas
//     distintos con el mismo texto mandan a buscar al sitio equivocado.
//   · FALLAR CERRADO. Nunca un `catch` que devuelva "conectado".
//
// ── LA REGLA QUE MANDA AQUÍ: NO PROMETER LO QUE NO SE PUEDE VERIFICAR ────
//
// `integraciones.ts` ya estableció que un renglón dice CÓMO conecta hoy y no
// "si está disponible". Aquí se agrega la capa de abajo: de dónde salió el
// endpoint. Un adaptador cuyo endpoint no se pudo confirmar contra la
// documentación del fabricante se declara `fuente: null` y su forma de conectar
// NO puede ser `api_en_vivo` — hay una prueba que lo impide.
//
// El modo de falla que esto evita es concreto y ya tiene fecha: el demo de
// Transportes Innovativos. Un catálogo que dijera "Wialon: disponible" y
// tronara al conectar cuesta el cliente. Uno que diga "Wialon: falta que nos
// des el token de tu cuenta" no cuesta nada, porque es verdad.
//
// ── SECRETOS ─────────────────────────────────────────────────────────────
//
// Aquí NO viven valores. Un conector declara la FORMA de lo que pide
// (`CampoCredencial`), nunca un valor. Los valores llegan como argumento a
// `probar()` y no se copian a ningún log: `logger.ts` redacta RFC y teléfonos,
// pero no sabe que un token de Wialon es un secreto. Por eso el resultado de
// `probar()` trae un `detalle` escrito a mano y no un volcado de la respuesta.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Las familias de sistemas que una flota mexicana ya tiene.
 *
 * Deliberadamente distintas a las de `integraciones.ts`: aquella agrupa lo que
 * ve el cliente en su pantalla (incluye WhatsApp y documentos, que no son
 * "sistemas de terceros con credenciales"); esta agrupa lo que un adaptador
 * puede CONECTAR. Fundirlas obligaría a inventar un conector de WhatsApp que
 * no tiene credenciales por flota.
 *
 * `Hoja de cálculo y archivo` NO es el premio de consuelo, y va primero por
 * eso. Ver `EVIDENCIA_DE_PRIORIDAD`: Excel lo nombra el 36.4% de las flotas del
 * censo, 33 veces más que cualquier TMS. Enterrar esa ruta al final de la lista
 * de ERPs describiría un mercado que no existe.
 */
export type CategoriaConector =
  | 'Hoja de cálculo y archivo'
  | 'ERP y contabilidad'
  | 'Rastreo GPS'
  | 'Peaje y monederos'
  | 'Portal de facturación';

/** El orden en que se enseñan. Escrito, no derivado: es una decisión de venta. */
export const CATEGORIAS: readonly CategoriaConector[] = [
  'Hoja de cálculo y archivo',
  'ERP y contabilidad',
  'Rastreo GPS',
  'Peaje y monederos',
  // Al final a propósito: es la categoría donde el cliente ENTREGA un acceso
  // suyo, y esa decisión se toma después de ver lo que el producto ya hace con
  // lo que no pide contraseñas.
  'Portal de facturación',
];

/**
 * DE DÓNDE SALE EL ORDEN DE ESTE CATÁLOGO. No de intuición.
 *
 * Censo de vacantes de autotransporte en México (`~/javiercamarapp/censo-liquidacion`),
 * 5,056 vacantes de 1,987 empresas distintas, minado el 14-ago-2026. Cuenta
 * cuántas EMPRESAS nombran cada software en sus ofertas de trabajo:
 *
 *     Excel 723 (36.4%) · Carta Porte 205 (10.3%) · SAP 191 (9.6%)
 *     GPS genérico 131 (6.6%) · CFDI 117 (5.9%) · CONTPAQi 110 (5.5%)
 *     Oracle 62 (3.1%) · Power BI 46 (2.3%) · Aspel 36 (1.8%)
 *     TMS 22 (1.1%) · Odoo 22 (1.1%)
 *
 * Por MARCA de GPS el censo casi no dice nada: Samsara 9, Geotab 1,
 * Encontrack 1, Wialon 0, Navixy 0. Esa es la razón de que exista
 * `gps_generico` y de que las cuatro marcas concretas sean implementaciones del
 * mismo contrato y no cuatro proyectos: NINGUNA marca domina, y construir para
 * una sería apostar al 0.2% del censo.
 *
 * Es una cifra medida, no una encuesta de mercado: dice qué software nombran
 * las flotas cuando CONTRATAN gente, que es una señal de qué usan a diario,
 * no cuánto gastan en licencias. Quien la repita tiene que decir de dónde salió.
 */
export const EVIDENCIA_DE_PRIORIDAD = {
  fuente: 'Censo de vacantes de autotransporte MX (censo-liquidacion), 1,987 empresas',
  medidoEn: '2026-08-14',
  /** Empresas del censo que nombran cada software. Solo lo que se usó aquí. */
  empresasQueLoNombran: {
    excel: 723,
    sap: 191,
    gps_generico: 131,
    contpaqi: 110,
    oracle: 62,
    aspel: 36,
    tms: 22,
    odoo: 22,
    samsara: 9,
    geotab: 1,
    wialon: 0,
    navixy: 0,
  },
} as const;

/**
 * CÓMO ENTRA EL DATO HOY. Es el campo que evita la venta mal entendida.
 *
 * Mismo vocabulario que `EstadoIntegracion`, a propósito, para que la pantalla
 * del cliente y el catálogo técnico no se contradigan. La diferencia es que
 * aquí no hay `conectada`: eso es un hecho MEDIDO por flota (¿hay fila en
 * `rastreo_credencial`?), no una propiedad del adaptador. Un adaptador no sabe
 * si alguien lo conectó; meter ese estado aquí sería fingir medición.
 */
export type FormaDeConectar =
  /** Hay API documentada, el adaptador la habla y `probar()` llama de verdad. */
  | 'api_en_vivo'
  /** Funciona hoy y completo, pero el dato entra por archivo. Estado legítimo. */
  | 'por_archivo'
  /** El camino existe; el último tramo necesita una instancia real de un cliente. */
  | 'requiere_piloto'
  /** No está construido. Se dice, no se esconde. */
  | 'no_construido';

export const FORMA_DE_CONECTAR: Record<FormaDeConectar, { rotulo: string; tono: 'ok' | 'neutral' | 'warn' | 'apagado' }> = {
  api_en_vivo: { rotulo: 'API en vivo', tono: 'ok' },
  por_archivo: { rotulo: 'Por archivo', tono: 'neutral' },
  requiere_piloto: { rotulo: 'Requiere piloto', tono: 'warn' },
  no_construido: { rotulo: 'Todavía no', tono: 'apagado' },
};

/**
 * QUÉ SABE HACER un conector una vez conectado.
 *
 * Verbos, no sustantivos, y separando LEER de ESCRIBIR: la diferencia decide
 * cuánto riesgo acepta el cliente al darnos accesos. Un contralor firma
 * `leer_movimientos` sin pensarlo y `escribir_asiento` con su contador presente.
 * Un conector que declarara "integración con SAP" sin distinguir las dos cosas
 * es exactamente el que pierde la reunión de seguridad.
 *
 * ── QUÉ NIVEL DE VERDAD TIENE ESTE CAMPO ────────────────────────────────
 *
 * Una capacidad describe el ALCANCE DEL PRODUCTO del fabricante, no un endpoint
 * que se haya llamado. Lo único que este directorio verifica de verdad es la
 * AUTENTICACIÓN (`fuente` + `probar()`), porque es lo único que se puede
 * comprobar contra documentación sin tener una instancia. Decir que Wialon lee
 * recorridos es tan seguro como decir que un ERP lleva cuentas; decir que ya
 * probamos su endpoint de mensajes sería mentira. Por eso las geocercas —que
 * los cuatro proveedores de rastreo tienen— NO están en este vocabulario: no se
 * investigaron, y un término que nadie declara es un término que alguien usará
 * mal después. Hay una prueba que exige que toda capacidad la use alguien.
 *
 * La capacidad es independiente de `FormaDeConectar`: `escribir_asiento` por
 * archivo sigue siendo escribir el asiento. Son dos ejes, QUÉ y CÓMO, y
 * fundirlos es lo que produce el catálogo que promete de más.
 */
export type Capacidad =
  // ── Rastreo ──
  /** Dónde está la unidad AHORA. Alimenta `posicion`. */
  | 'leer_posiciones'
  /** El histórico entre dos fechas. Es lo que mide esperas y kilómetros reales. */
  | 'leer_recorrido'
  /** El catálogo de unidades del proveedor, para casarlo con `unidad`. */
  | 'leer_unidades'
  /** Los eventos que las cámaras/sensores del PROVEEDOR DEL CLIENTE detectan
   *  (colisión, volcadura, frenado brusco). Solo lectura: Likida no construye
   *  cámaras — lee las del cliente y monta el circuito de asistencia encima.
   *  Un evento grave abre expediente; el resto se registra para coaching. */
  | 'leer_eventos_seguridad'
  // ── ERP y sistemas de operación ──
  /** Los viajes que la flota ya capturó en su TMS, para no recapturarlos. */
  | 'leer_viajes'
  /** El catálogo de cuentas contables, para que la póliza no se adivine. */
  | 'leer_catalogo_cuentas'
  /** Los proveedores dados de alta, para casar el RFC de una factura recibida. */
  | 'leer_proveedores'
  /** Dejar el asiento/póliza de la liquidación en el ERP. ESCRITURA. */
  | 'escribir_asiento'
  /** Dejar la factura de proveedor capturada en el ERP. ESCRITURA. */
  | 'escribir_factura_proveedor'
  // ── Peaje y monederos ──
  /** El saldo y el corte del TAG o del monedero. */
  | 'leer_estado_cuenta'
  /** Los cruces o las cargas, línea por línea. Es lo que concilia contra el viaje. */
  | 'leer_movimientos'
  /** Bajar el CFDI que ampara los consumos del periodo. */
  | 'leer_cfdi'
  // ── Portales de facturación ──
  /**
   * Apretar el botón que CREA un CFDI en el portal del comercio. ESCRITURA, y
   * de la irreversible: cancelar fuera de plazo se le queda al cliente en su
   * contabilidad. Por eso pasa por el candado del mandato
   * (`facturacion/modo.ts`) y el modo por defecto del agente es `ensayo`.
   */
  | 'emitir_factura';

/**
 * El vocabulario completo, enumerable.
 *
 * Existe para que una prueba pueda exigir que TODA capacidad la declare al
 * menos un conector. Sin esa prueba el vocabulario crece con términos que nadie
 * usa, y el primero que los use les dará el significado que se le ocurra.
 */
export const CAPACIDADES: readonly Capacidad[] = [
  'leer_posiciones',
  'leer_recorrido',
  'leer_unidades',
  'leer_eventos_seguridad',
  'leer_viajes',
  'leer_catalogo_cuentas',
  'leer_proveedores',
  'escribir_asiento',
  'escribir_factura_proveedor',
  'leer_estado_cuenta',
  'leer_movimientos',
  'leer_cfdi',
  'emitir_factura',
];

/** La forma de un campo de credencial. No es el valor: es cómo se captura. */
export type FormaCampo =
  /** Texto visible. Aparece en pantalla y puede ir en un log. */
  | 'texto'
  /** URL de la instancia del cliente (SAP y Wialon on-premise cambian de host). */
  | 'url'
  /** SECRETO. No vuelve al panel, no entra a un log, no se imprime en un error. */
  | 'secreto'
  /** Correo. PII: `logger.ts` no lo redacta hoy, así que tampoco se loguea. */
  | 'correo';

/**
 * UN CAMPO QUE HAY QUE PEDIRLE AL CLIENTE.
 *
 * `ejemplo` es la FORMA, jamás un valor real ni verosímil: un ejemplo que
 * parezca un token de verdad acaba copiado a un ticket de soporte.
 */
export interface CampoCredencial {
  clave: string;
  /** Cómo se le pide a una persona, en su idioma, no en el del fabricante. */
  rotulo: string;
  forma: FormaCampo;
  /** Si falta, `probar()` ni siquiera intenta. Ver `faltantes()`. */
  requerida: boolean;
  /** Dónde lo encuentra el cliente. Sin esto, el campo se queda vacío para siempre. */
  ayuda: string;
  /** La FORMA del valor. Nunca algo que se pueda confundir con una credencial. */
  ejemplo?: string;
}

/** Un secreto es exactamente `forma === 'secreto'`. Una sola definición. */
export function esSecreto(campo: CampoCredencial): boolean {
  return campo.forma === 'secreto';
}

/** Los valores capturados. Se pasan a `probar()` y no se guardan aquí. */
export type ValoresCredencial = Readonly<Record<string, string | undefined>>;

/**
 * DE DÓNDE SALIÓ EL ENDPOINT.
 *
 * Existe porque la alternativa es un endpoint plausible inventado por un modelo
 * de lenguaje, que se ve idéntico a uno correcto hasta que alguien lo llama.
 * `queConfirma` obliga a decir qué dice esa página EXACTAMENTE — sin él, una URL
 * de portada de documentación se pasa por evidencia de un endpoint concreto.
 */
export interface Fuente {
  /** Documentación PRIMARIA del fabricante. No un blog, no un wrapper de npm. */
  url: string;
  /** La afirmación concreta que esa página sostiene y que aquí se usa. */
  queConfirma: string;
  /** AAAA-MM-DD. Una doc envejece y un endpoint se mueve. */
  consultadaEn: string;
}

/** Verificado = tiene fuente primaria. No hay término medio a propósito. */
export type NivelDeFuente = 'verificado' | 'sin_verificar';

export function nivelDeFuente(c: Pick<Conector, 'fuente'>): NivelDeFuente {
  return c.fuente === null ? 'sin_verificar' : 'verificado';
}

// ── El transporte ──────────────────────────────────────────────────────────

/**
 * Una petición HTTP mínima. `probar()` recibe el transporte en vez de llamar a
 * `fetch` directo por dos razones que no son de estilo:
 *
 *   1. Se puede probar el adaptador ENTERO sin red y sin credenciales, que es
 *      todo lo que hay hoy. Misma decisión que `abrirPagina` en el registro de
 *      portales: recibir la fábrica en vez de importar Playwright.
 *   2. Un solo sitio para el timeout y para no arrastrar cabeceras de una
 *      llamada a otra. Un token de la flota A en la petición de la flota B es
 *      el mismo bug de tenant cruzado que ya se cerró en facturación.
 */
export interface PeticionHttp {
  url: string;
  metodo: 'GET' | 'POST';
  encabezados?: Record<string, string>;
  /** Ya serializado. El adaptador decide su formato (JSON, form, JSON-RPC). */
  cuerpo?: string;
}

export interface RespuestaHttp {
  estado: number;
  cuerpo: string;
  /** Cabeceras normalizadas a minúsculas. Los pollers usan `retry-after` para
   *  no convertir un 429 del proveedor en una tormenta de reintentos. */
  encabezados?: Record<string, string>;
}

/** Lo que un conector necesita del mundo. En producción, `httpReal()`. */
export type Http = (p: PeticionHttp) => Promise<RespuestaHttp>;

/**
 * Cuánto se espera a un sistema de tercero antes de rendirse.
 *
 * 15 s y no 60: esto lo llama alguien que está mirando la pantalla de
 * configuración. Un minuto en blanco se lee como "se colgó" y la persona
 * recarga, que dispara una segunda prueba contra el mismo proveedor. Un SAP
 * on-premise detrás de una VPN lenta puede pasarse de 15 s, y entonces el
 * mensaje correcto es "no contestó a tiempo", no "la credencial es mala".
 */
export const TIMEOUT_PRUEBA_MS = 15_000;

/**
 * El transporte de verdad. Es lo ÚNICO de este directorio que toca la red.
 *
 * `redirect: 'manual'` a propósito: varios portales contestan 302 a su página
 * de login cuando la credencial no sirve. Siguiendo el redirect se acaba
 * leyendo un 200 de una página HTML de login, y ese 200 se interpreta como
 * credencial buena — el falso positivo más caro que puede tener esta capa.
 */
export function httpReal(): Http {
  return async ({ url, metodo, encabezados, cuerpo }: PeticionHttp): Promise<RespuestaHttp> => {
    const r = await fetch(url, {
      method: metodo,
      headers: encabezados,
      body: cuerpo,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_PRUEBA_MS),
    });
    const respuestaHeaders: Record<string, string> = {};
    r.headers.forEach((valor, llave) => { respuestaHeaders[llave.toLowerCase()] = valor; });
    return { estado: r.status, cuerpo: await r.text(), encabezados: respuestaHeaders };
  };
}

// ── El resultado de probar ─────────────────────────────────────────────────

/**
 * Qué pasó al probar. NO es un booleano con adornos.
 *
 * `ok: true` significa UNA cosa y solo una: el proveedor contestó y reconoció
 * la credencial. Cualquier otra cosa —red caída, DNS, 500 del proveedor, campo
 * faltante, adaptador sin API— es `ok: false` con su motivo. Un error de red NO
 * es "no hay datos" y NO es "conectado": es un error de red, y se dice.
 *
 * `verificadoContra` es la prueba de que se habló con alguien. `null` significa
 * que NO se llamó a nadie, y entonces `ok` no puede ser `true` — hay una prueba
 * que lo exige. Sin ese campo, un adaptador que devolviera `ok: true` sin
 * llamar a nada se vería igual que uno que sí verificó.
 */
/**
 * QUÉ DICE UNA PRUEBA SOBRE LA CREDENCIAL DEL CLIENTE — que no es lo mismo que
 * si la prueba salió bien.
 *
 * AUDITORÍA CICLO 7, c7-12 (alto). `ok: false` juntaba tres cosas con dueños
 * distintos: «el proveedor rechazó tu credencial» (del cliente), «el proveedor
 * está caído» y «no pudimos hablar con él» (nuestros). Como `probarCredencial`
 * sellaba los tres igual, un 503 de Samsara o un `AbortSignal.timeout` por una
 * VPN lenta BORRABAN `probada_en` —el único registro de que esa credencial se
 * verificó alguna vez— y pintaban el badge en «la última prueba FALLÓ», en
 * rojo, mandando al cliente a regenerar un token que estaba bien.
 *
 * `verificadoContra` no alcanzaba para separarlos: `veredictoHttp` lo llena
 * también en el 5xx, cuyo propio texto dice «esto NO dice nada sobre la
 * credencial». Hacía falta decirlo como dato, no como frase.
 *
 *   · `sirve`      — alguien de fuera la aceptó. Se sella.
 *   · `no_sirve`   — alguien de fuera la rechazó. Se sella (es accionable).
 *   · `no_se_sabe` — nadie dio un veredicto sobre ELLA. NO se sella nada.
 */
export type VeredictoCredencial = 'sirve' | 'no_sirve' | 'no_se_sabe';

export interface ResultadoPrueba {
  ok: boolean;
  /** Para una persona: qué se hizo y qué contestó. Sin volcar la respuesta. */
  detalle: string;
  /** El endpoint contra el que se comprobó, o `null` si no se llamó a nadie. */
  verificadoContra: string | null;
  /** Qué campos faltan, cuando ese fue el motivo. Vacío si no aplica. */
  falta?: readonly string[];
  /** Qué se puede afirmar de la CREDENCIAL. Ausente se lee con `veredictoDe`,
   *  que falla del lado seguro. */
  sobreLaCredencial?: VeredictoCredencial;
}

/**
 * El veredicto de un resultado, con el default que NO culpa al cliente.
 *
 * Un resultado sin marcar que además falló se lee `no_se_sabe`: preferimos no
 * sellar un fallo real (el peor caso es que el badge tarde una prueba más en
 * ponerse rojo) antes que sellar como «tu credencial falló» algo que fue
 * nuestro. El costo de los dos errores no es simétrico.
 */
export function veredictoDe(r: Pick<ResultadoPrueba, 'ok' | 'sobreLaCredencial'>): VeredictoCredencial {
  if (r.sobreLaCredencial) return r.sobreLaCredencial;
  return r.ok ? 'sirve' : 'no_se_sabe';
}

/**
 * LA FICHA DE UN SISTEMA DE TERCEROS.
 *
 * Todo lo que hace falta para que conectar a un cliente sea capturar datos.
 */
export interface Conector {
  id: string;
  /** Como lo llama el cliente, no como lo llama su fabricante. */
  nombre: string;
  categoria: CategoriaConector;
  /** Qué resuelve, en una línea, en palabras del dueño de la flota. */
  queHace: string;
  formaDeConectar: FormaDeConectar;
  /** La frase que evita la venta mal entendida. Ver `integraciones.ts`. */
  comoConectaHoy: string;
  /** Qué haría falta para subir de escalón, o `null` si ya está en el tope. */
  paraSubirDeEscalon: string | null;
  /** Qué sabría hacer una vez conectado. Vacío está PROHIBIDO: ver la prueba. */
  capacidades: readonly Capacidad[];
  /** Qué se le pide al cliente. Vacío solo se permite si no hay API que probar. */
  credenciales: readonly CampoCredencial[];
  /** `null` = no se encontró documentación primaria. Bloquea `api_en_vivo`. */
  fuente: Fuente | null;
  /**
   * El valor de `rastreo_credencial.proveedor` con el que se guarda, cuando la
   * tabla lo admite. `null` = todavía no hay dónde guardarlo (ver el reporte:
   * los de ERP y peaje necesitan su propia tabla).
   */
  claveAlmacen: string | null;
  /**
   * Verifica credenciales SIN ESCRIBIR NADA en el sistema del cliente.
   *
   * El contrato es de solo lectura: `GET` de consulta, o el POST de login que
   * el propio fabricante documenta como forma de autenticarse (Geotab y SAP no
   * ofrecen otra). Un login abre sesión, no crea un registro de negocio. Lo que
   * NUNCA hace es dar de alta, modificar ni borrar: la primera impresión que se
   * lleva un contralor al darnos su ERP no puede ser una póliza fantasma.
   */
  probar(valores: ValoresCredencial, http: Http): Promise<ResultadoPrueba>;
}

// ── Utilidades que todo adaptador usa ──────────────────────────────────────

/** Los campos requeridos que vienen vacíos. Vacío = se puede intentar. */
export function faltantes(c: Pick<Conector, 'credenciales'>, v: ValoresCredencial): string[] {
  return c.credenciales
    .filter((campo) => campo.requerida && !(v[campo.clave] ?? '').trim())
    .map((campo) => campo.rotulo);
}

/**
 * El resultado de un conector que no tiene nada que probar, y dice por qué.
 *
 * Es el CENTINELA de `facturacion/adaptadores/registro.ts` traído aquí: no
 * lanza, porque esto no es un error del sistema sino un hecho del catálogo, y
 * el llamador ya sabe leer `ok: false`. Lanzar mandaría el caso normal —"este
 * proveedor no publica API"— por el camino de las excepciones inesperadas.
 */
export function sinApiQueProbar(motivo: string): ResultadoPrueba {
  // Nadie de fuera contestó: esto no dice NADA de la credencial (c7-12).
  return { ok: false, detalle: motivo, verificadoContra: null, sobreLaCredencial: 'no_se_sabe' };
}

/**
 * Envuelve la llamada real de un adaptador para que FALLE CERRADO siempre.
 *
 * Las tres cosas que hace, y las tres existen por un modo de falla concreto:
 *
 *   1. Revisa los campos requeridos ANTES de llamar. Sin esto, un adaptador
 *      manda una petición sin token, el proveedor contesta 200 con una página
 *      de login en HTML, y el `estado === 200` se lee como credencial buena.
 *   2. Atrapa la excepción y devuelve `ok: false`. Un `catch` que devolviera
 *      "conectado" es el bug que esta capa entera existe para impedir; un
 *      `catch` que dejara subir la excepción rompería la pantalla de
 *      configuración por un DNS caído.
 *   3. Nunca copia la respuesta cruda al detalle. El cuerpo de una respuesta de
 *      autenticación trae tokens de sesión, y ese detalle va a la columna
 *      `rastreo_credencial.ultimo_error`, que sí se lee desde el panel.
 */
export async function probarConGuardas(
  c: Pick<Conector, 'credenciales' | 'nombre'>,
  v: ValoresCredencial,
  intento: () => Promise<ResultadoPrueba>,
): Promise<ResultadoPrueba> {
  const falta = faltantes(c, v);
  if (falta.length > 0) {
    return {
      ok: false,
      detalle: `Faltan datos para probar ${c.nombre}: ${falta.join(', ')}.`,
      verificadoContra: null,
      // Ni siquiera se intentó: no hay veredicto que sellar (c7-12).
      sobreLaCredencial: 'no_se_sabe',
      falta,
    };
  }
  try {
    return await intento();
  } catch (e) {
    // El mensaje de la excepción SÍ va: es lo único que distingue "DNS no
    // resuelve" de "certificado vencido" a las 3 a.m. Lo que no va es la
    // respuesta del proveedor, que puede traer el token.
    return {
      ok: false,
      detalle: `No se pudo hablar con ${c.nombre}: ${e instanceof Error ? e.message : String(e)}. Un error de red NO significa que la credencial sea mala; significa que no se pudo comprobar.`,
      verificadoContra: null,
      // El detalle ya lo decía con todas sus letras y el sello lo ignoraba
      // (c7-12). Ahora es un dato: un error de red no es un veredicto.
      sobreLaCredencial: 'no_se_sabe',
    };
  }
}

/**
 * Traduce un código HTTP al veredicto, igual en todos los adaptadores.
 *
 * La distinción que importa: 401/403 dice que la credencial NO sirve (dato
 * útil, accionable por el cliente); un 5xx dice que el proveedor está caído y
 * NO dice nada sobre la credencial. Fundirlos en "falló" mandaría al cliente a
 * regenerar un token que estaba bien.
 */
export function veredictoHttp(
  r: RespuestaHttp,
  endpoint: string,
  nombre: string,
): ResultadoPrueba {
  if (r.estado >= 200 && r.estado < 300) {
    return { ok: true, detalle: `${nombre} contestó ${r.estado} y reconoció la credencial.`, verificadoContra: endpoint, sobreLaCredencial: 'sirve' };
  }
  if (r.estado === 401 || r.estado === 403) {
    return { ok: false, detalle: `${nombre} rechazó la credencial (${r.estado}). Hay que revisarla o generarla de nuevo.`, verificadoContra: endpoint, sobreLaCredencial: 'no_sirve' };
  }
  if (r.estado >= 500) {
    // El 5xx es del PROVEEDOR, no del cliente — y este es el caso que c7-12
    // sellaba en rojo sobre la credencial de una flota que no hizo nada mal.
    return { ok: false, detalle: `${nombre} respondió ${r.estado}: su servicio está fallando. Esto NO dice nada sobre la credencial — hay que volver a probar más tarde.`, verificadoContra: endpoint, sobreLaCredencial: 'no_se_sabe' };
  }
  return { ok: false, detalle: `${nombre} respondió ${r.estado}, que no es lo esperado. No se puede afirmar que la credencial sirva.`, verificadoContra: endpoint, sobreLaCredencial: 'no_se_sabe' };
}
