import { supabaseAdmin } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';
import { numero, fechaHoraMx } from '@/lib/formato';
import { puedeVerRuta } from '@/lib/auth/visibilidad';
import { puedeAdministrar } from '@/lib/auth/permisos';
import { correoConfigurado, enviarCorreo } from '@/lib/correo/enviar';
import { avisoCorridaFallida } from '@/lib/correo/avisos';
import type { Correo } from '@/lib/correo/plantilla';

// ═══════════════════════════════════════════════════════════════════════════
// NOTIFICACIONES DE LOS AGENTES — a QUIÉN se le avisa y DE QUÉ (14-ago-2026).
//
// La pestaña «Notificaciones» del menú de cada uno de los
// seis agentes de Likida. Hasta hoy no se podía construir porque no había canal de
// salida; con `lib/correo/enviar.ts` ya lo hay, y este módulo es lo que
// decide cuándo usarlo.
//
// NO redacta correos. El catálogo de textos vive en `lib/correo/avisos.ts` y
// es puro; aquí solo vive la decisión —encendido, destinatario, anti-ruido—
// y el despacho. Quien avisa pasa el armador del `Correo`; para la corrida
// fallida ya viene cableado (`avisarCorridaFallida`), que es el único aviso
// que los seis agentes comparten palabra por palabra.
//
// ── LAS TRES DECISIONES DE PRODUCTO QUE ESTE ARCHIVO SOSTIENE ─────────────
//
//  1. **No existe el correo de "corrida completada OK".** Un aviso que se
//     manda de más enseña a ignorar los que sí piden algo, y el que enseña
//     más rápido es el que llega cuando todo está bien. Sólo se avisa de lo
//     que pide a una persona: el agente no pudo trabajar, la cola dejó de
//     moverse, un caso se escaló. La corrida buena SÍ se registra —re-arma el
//     filo del anti-ruido, ver abajo— pero no manda nada.
//
//  2. **Anti-ruido por FILO + MARCAS, nunca por cadencia.** Ver
//     `debeAvisar`. Un agente roto 40 corridas seguidas manda 3 correos como
//     mucho, no 40, y ninguno de los 3 repite la noticia del anterior.
//
//  3. **Los destinatarios son gente del panel de ESA flota.** `app_user` con
//     correo, con el rol marcado, y cuyo rol pueda ABRIR la pantalla del
//     agente (`puedeVerRuta`) — un aviso cuyo botón rebota al que lo abre es
//     un regaño con liga rota. Nunca operadores: la tabla `operador` no tiene
//     columna de correo y los choferes no tienen login (0086). Y nunca una
//     dirección tecleada a mano: cada destinatario es alguien que YA puede
//     ver ese dato dentro del panel, así que el correo no abre una puerta
//     nueva a la información de la flota.
//
// TABLAS (pendientes de migración al escribir esto — ver el reporte):
// `agente_notificacion_config` y `agente_notificacion_estado`. Mientras no
// existan, las lecturas fallan y todo esto CALLA y lo dice: sin config legible
// no hay autorización para escribirle a nadie.
// ═══════════════════════════════════════════════════════════════════════════

// ── EL CATÁLOGO: qué agentes hay y qué le puede pasar a cada uno ───────────

export type AgenteId =
  | 'liquidacion' | 'facturas' | 'cobranza' | 'conductores' | 'peajes' | 'proveedores'
  | 'carta_porte';

export type EventoId = 'corrida_fallida' | 'cola_atorada' | 'escalado';

/** Los roles del panel que pueden recibir un aviso. `operador` NO está y no
 *  es un olvido: no tiene login desde la 0086 y su tabla no guarda correo. */
export type RolAvisable = 'flota_admin' | 'encargado' | 'contador';

export const ROLES_AVISABLES: readonly RolAvisable[] = ['flota_admin', 'encargado', 'contador'];

export interface AgenteNotificable {
  id: AgenteId;
  /** Como se llama en el correo y en la pantalla. */
  nombre: string;
  /** Su página. Es la misma llave de `AREA_POR_RUTA` (visibilidad.ts): de ahí
   *  sale qué roles pueden abrirla, y por tanto a quién tiene sentido
   *  avisarle. */
  ruta: string;
  /** Lo que a ESTE agente le puede pasar. No es la lista completa a
   *  propósito: ofrecer un interruptor para un evento que el agente nunca
   *  emite es la misma mentira que un semáforo decorativo. */
  eventos: readonly EventoId[];
}

/**
 * El catálogo NO se importa de `app/dashboard/rutas.ts` (el del sidebar) por
 * dos razones: ese arrastra los íconos de lucide, y este módulo corre en el
 * cron; y sobre todo, `id` es una LLAVE DE BASE DE DATOS. El rótulo del
 * sidebar se puede acortar mañana —ya pasó el 13-ago— y renombrar una llave
 * guardada dejaría la config de las flotas apuntando a un agente que no
 * existe. El rótulo cambia; la llave no.
 */
export const AGENTES_NOTIFICABLES: readonly AgenteNotificable[] = [
  {
    id: 'liquidacion', nombre: 'Agente de Liquidación', ruta: '/dashboard/agentes/liquidacion',
    eventos: ['corrida_fallida', 'cola_atorada'],
  },
  {
    id: 'facturas', nombre: 'Agente de Facturas', ruta: '/dashboard/agentes/facturas',
    eventos: ['corrida_fallida', 'cola_atorada'],
  },
  {
    id: 'cobranza', nombre: 'Agente de Cobranza', ruta: '/dashboard/agentes/cobranza',
    eventos: ['corrida_fallida', 'cola_atorada'],
  },
  {
    // El ÚNICO con `escalado` hoy, y es medido, no supuesto: `escalar_viaje.ts`
    // avisa al jefe a las 5 h del viaje que nadie aceptó. Cuando otro agente
    // estrene su propia escalación, se agrega aquí y la pestaña la ofrece sola.
    id: 'conductores', nombre: 'Agente de Conductores', ruta: '/dashboard/agentes/conductores',
    eventos: ['corrida_fallida', 'cola_atorada', 'escalado'],
  },
  {
    id: 'peajes', nombre: 'Agente de Peajes', ruta: '/dashboard/agentes/peajes',
    eventos: ['corrida_fallida', 'cola_atorada'],
  },
  {
    id: 'proveedores', nombre: 'Agente de Proveedores', ruta: '/dashboard/agentes/proveedores',
    eventos: ['corrida_fallida', 'cola_atorada'],
  },
  {
    // Fases B-C del blueprint (25-ago-2026). Solo `corrida_fallida`: su cola
    // («falta declarar») se mide en el render, no en un cron — listarle
    // `cola_atorada` sin emisor sería el bug original de la pestaña.
    id: 'carta_porte', nombre: 'Agente de Carta Porte', ruta: '/dashboard/agentes/carta-porte',
    eventos: ['corrida_fallida'],
  },
];

export function agentePorId(id: string): AgenteNotificable | null {
  return AGENTES_NOTIFICABLES.find((a) => a.id === id) ?? null;
}

export interface EventoDeclarado {
  id: EventoId;
  titulo: string;
  /** Qué lo dispara, en palabras de persona. Va en la pestaña. */
  cuando: string;
  /** Por qué ESTE sí merece un correo. La pestaña lo enseña porque es la
   *  respuesta a "¿y si lo apago?". */
  porQue: string;
  /** ¿Hay hoy código que lo emita? Lo llena `eventosDe`; `EVENTOS` no lo trae
   *  porque depende del AGENTE, no del evento. */
  conectado?: boolean;
}

export const EVENTOS: Readonly<Record<EventoId, EventoDeclarado>> = {
  corrida_fallida: {
    id: 'corrida_fallida',
    titulo: 'El agente no pudo trabajar',
    cuando: 'Cuando una corrida se detiene antes de terminar.',
    porQue:
      'Es el modo de falla más caro de un agente porque su síntoma es que NO pasa nada: '
      + 'el panel no marca errores, simplemente deja de aparecer trabajo nuevo.',
  },
  cola_atorada: {
    id: 'cola_atorada',
    titulo: 'La cola dejó de moverse',
    cuando: 'Cuando lo que espera a una persona se acumula y deja de bajar.',
    porQue:
      'El agente ya hizo su parte; lo que queda depende de alguien de la oficina. '
      + 'Una cola que crece en silencio se descubre cuando ya costó dinero.',
  },
  escalado: {
    id: 'escalado',
    titulo: 'El agente escaló un caso',
    cuando: 'Cuando el agente se detuvo en un caso concreto y lo pasó a una persona.',
    porQue:
      'No es información: es una decisión que solo una persona puede tomar, '
      + 'y que necesita tiempo para ejecutarse.',
  },
};

/**
 * QUÉ PARES (agente, evento) TIENEN UN EMISOR DE VERDAD HOY.
 *
 * Esta tabla existe porque el 14-ago-2026 se construyó la pestaña con 18
 * interruptores de los que **16 no podían dispararse nunca**: `cola_atorada`
 * estaba declarado para los seis y `escalado` para conductores, y ninguno de
 * los dos tenía una sola línea que los emitiera. Sus plantillas de correo
 * (`avisoColaAtorada`, `avisoEscalados`) se escribieron el mismo día y
 * quedaron sin llamador.
 *
 * El daño no es un correo de menos: el dueño marca la casilla, la pantalla le
 * responde «Hoy le llega a: Juan Pérez», y se queda esperando un aviso que no
 * existe. Es exactamente lo que el catálogo de arriba prohíbe con todas sus
 * letras —«ofrecer un interruptor para un evento que el agente nunca emite es
 * la misma mentira que un semáforo decorativo»— y se incumplió en el mismo
 * archivo que lo escribió.
 *
 * Se declara aparte y no se borran los eventos del catálogo porque el destino
 * es cablearlos: `eventos` dice a qué ASPIRA el agente, esto dice qué CUMPLE.
 * Es el mismo patrón que `FORMATOS.implementado` en `ajustes_operativos.ts`,
 * que nació del mismo error.
 *
 * PARA QUIEN CABLEE UNO NUEVO: agrega aquí el par el mismo commit en que
 * escribas el `avisar(...)`, ni antes ni después. `notificaciones.test.ts`
 * verifica que todo par listado aquí exista en el catálogo.
 */
const CON_EMISOR: ReadonlySet<string> = new Set([
  // `avisarCorridasPorFlota` desde `ejecutarCobranzaGlobal` (cobranza.ts).
  'cobranza:corrida_fallida',
  // íd. desde el `finally` de `procesarLoteEnCola` (api/cron/facturar).
  'facturas:corrida_fallida',
  // `avisar(..., 'cola_atorada', ...)` desde el mismo `finally` del cron de
  // facturación: una llamada por flota con tickets que ESA corrida bloqueó
  // (`bloqueadosPorFlota` — requiere_cuenta, CAPTCHA), con la magnitud MEDIDA.
  // Los otros cinco agentes siguen sin este par a propósito: sus colas solo se
  // miden en el render, no en un cron, y listarlos sin emisor sería el bug
  // original de la pestaña.
  'facturas:cola_atorada',
  // íd. desde `escalarViajesSinAceptar` (escalar_viaje.ts), con el fallo real
  // por flota: la que no tiene teléfono de jefe capturado.
  'conductores:corrida_fallida',
  // `avisar(..., 'escalado', ...)` desde el cierre de `escalarViajesSinAceptar`
  // (escalar_viaje.ts): una llamada por flota con viajes escalados en la
  // corrida, con la magnitud medida y sus folios (`avisoEscalados`).
  'conductores:escalado',
]);

export function tieneEmisor(agente: AgenteNotificable, evento: EventoId): boolean {
  return CON_EMISOR.has(`${agente.id}:${evento}`);
}

/** Solo para la prueba que vigila que esta tabla no cite pares inventados. */
export const PARES_CON_EMISOR: readonly string[] = [...CON_EMISOR];

/** Los eventos que ESTE agente declara, cada uno diciendo si YA está
 *  conectado. La pestaña pinta los que no lo están apagados y lo explica, en
 *  vez de ofrecer un interruptor que no hace nada. */
export function eventosDe(agente: AgenteNotificable): EventoDeclarado[] {
  return agente.eventos.map((e) => ({ ...EVENTOS[e], conectado: tieneEmisor(agente, e) }));
}

/**
 * Los roles a los que tiene sentido ofrecerles este agente.
 *
 * Se filtra por `puedeVerRuta` y no por gusto: los agentes de dinero
 * (liquidación, facturas, cobranza, peajes, proveedores) no existen para el
 * jefe de tráfico, y el de conductores no existe para el contador. Marcarle a
 * un contador el aviso del Agente de Conductores le mandaría un correo cuyo
 * botón lo rebota a /dashboard — un aviso que no lleva a donde se resuelve es
 * exactamente lo que `avisos.ts` prohíbe en su regla 2.
 */
export function rolesQuePueden(agente: AgenteNotificable): RolAvisable[] {
  return ROLES_AVISABLES.filter((rol) => puedeVerRuta(rol, agente.ruta));
}

/**
 * LA PUERTA de la server action que reconfigura los avisos de una flota.
 *
 * Vive aquí, pura y probada, en vez de escrita a mano dentro de cada página de
 * agente. La razón no es ahorrar líneas: escribir a quién le llegan los correos
 * de una empresa es una escritura multi-tenant, y el modo de falla dominante
 * del código escrito por agentes de IA es precisamente el de autorización —
 * gatear el render y olvidar la action, o gatear el rol y olvidar el tenant.
 * Seis copias son seis lugares donde falta una línea; ésta es una, y falla en
 * prueba si alguien la afloja.
 *
 * Devuelve el mensaje para el cliente, o `null` si puede pasar.
 *
 * `superadmin` sí opera sobre otra flota A PROPÓSITO: /admin es su consola y
 * cruza tenants por diseño (la única excepción del repo). Cualquier otro rol
 * que traiga un tenant distinto al suyo es un POST fabricado.
 *
 * FE-27 (auditoría 24): exigía solo `puedeVerRuta`, la misma puerta que abre
 * la PANTALLA — pero VER un agente y decidir A QUIÉN le llegan sus correos son
 * dos cosas distintas. Con eso, cualquier rol que viera la página podía
 * apagar los avisos del DUEÑO: el contador en liquidación/facturas/cobranza/
 * peajes/proveedores, el encargado en conductores/carta-porte. La estrategia
 * del mismo agente (`guardarEstrategiaAgente`) ya exige `puedeAdministrar`
 * (`agentes/conductores/page.tsx`, `agentes/liquidacion/page.tsx`) — quién
 * recibe el correo es la misma clase de decisión que quién opera el agente,
 * y ahora exige lo mismo.
 */
export function puedeConfigurarAvisos(
  sesion: { rol: string; tenantId: string | null },
  tenantIdObjetivo: string,
  agente: AgenteNotificable,
): string | null {
  if (!puedeVerRuta(sesion.rol, agente.ruta)) {
    return 'Tu rol no puede configurar los avisos de este agente.';
  }
  if (sesion.rol === 'superadmin') return null;
  if (!puedeAdministrar(sesion.rol)) {
    return 'Solo el dueño de la flota decide quién recibe los avisos de este agente.';
  }
  if (sesion.tenantId !== tenantIdObjetivo) return 'Este agente no es de tu flota.';
  return null;
}

// ── LA CONFIGURACIÓN POR FLOTA Y POR AGENTE ────────────────────────────────

export interface ConfigNotificaciones {
  /** Los eventos ENCENDIDOS. Vacío = este agente no escribe nunca. */
  eventos: EventoId[];
  /** Los roles que reciben. */
  roles: RolAvisable[];
}

/**
 * El default sin fila: SOLO la corrida fallida, SOLO al dueño.
 *
 * Nace con el único aviso que nadie discute —el agente dejó de trabajar— y
 * con una sola persona. Un default que enciende los tres eventos para los
 * tres roles entrena a ignorar el canal en la primera semana, que es
 * justamente el daño que esta pestaña existe para evitar.
 */
export const CONFIG_NOTIF_DEFAULT: ConfigNotificaciones = {
  eventos: ['corrida_fallida'],
  roles: ['flota_admin'],
};

/** Valida y NORMALIZA lo que viene del formulario. El error va en palabras de
 *  pantalla, como `validarConfigCobranza`. */
export function validarConfigNotificaciones(
  agente: AgenteNotificable,
  cruda: { eventos?: readonly string[]; roles?: readonly string[] },
): { ok: ConfigNotificaciones } | { error: string } {
  // Un evento que este agente no emite se DESCARTA, no se guarda: guardarlo
  // dejaría un interruptor encendido que nunca dispara nada, y el cliente
  // creería estar cubierto de algo que no existe.
  //
  // El segundo filtro (`tieneEmisor`) es el que faltaba, y es el que de verdad
  // muerde: el catálogo declara `cola_atorada` para los seis agentes y hoy
  // solo Facturas lo emite (el cron de facturación; `escalado` lo emite
  // `escalar_viaje.ts` — sus pares viven en CON_EMISOR). Sin esta línea, un
  // POST fabricado —o la propia pantalla antes de que se le pusiera el
  // candado— guardaba encendido un aviso imposible en los cinco restantes.
  const eventos = [...new Set(cruda.eventos ?? [])]
    .filter((e): e is EventoId => agente.eventos.includes(e as EventoId))
    .filter((e) => tieneEmisor(agente, e));

  const permitidos = rolesQuePueden(agente);
  const roles = [...new Set(cruda.roles ?? [])]
    .filter((r): r is RolAvisable => permitidos.includes(r as RolAvisable));

  // EL ÚNICO ERROR DURO: avisos encendidos sin nadie que los reciba. Es la
  // configuración que se ve prendida y no manda nada — la falla silenciosa
  // que esta pestaña combate. Apagar todo sí es una decisión válida.
  if (eventos.length > 0 && roles.length === 0) {
    return { error: 'Marca al menos un rol que reciba estos avisos, o apágalos todos.' };
  }

  return { ok: { eventos, roles } };
}

// ── EL ANTI-RUIDO ──────────────────────────────────────────────────────────

/**
 * LAS MARCAS DE INSISTENCIA. Un incidente manda TRES correos como máximo.
 *
 * ── POR QUÉ NO UNA VENTANA MÍNIMA A SECAS ────────────────────────────────
 * "Máximo uno cada 6 horas" suena razonable hasta que se hace la cuenta: un
 * agente roto un fin de semana largo manda 16 correos que dicen exactamente
 * lo mismo. El lunes ya no se abren, y el que no se abre es el mismo canal
 * por el que va a llegar el aviso que sí importaba. La cadencia mide el
 * RELOJ; lo que hay que medir es si hay NOTICIA.
 *
 * ── POR QUÉ NO SOLO EL FILO ("avisa una vez y cállate") ───────────────────
 * Es lo que hace `escalar_viaje.ts` con `escalado_en`, y ahí está bien: el
 * viaje sin aceptar es un caso puntual que se resuelve o se muere. Un agente
 * caído, no: callarse para siempre tras el primer correo deja el mismo hueco
 * que no avisar. Al tercer día nadie recuerda ese correo del martes.
 *
 * ── LO QUE SÍ ────────────────────────────────────────────────────────────
 * Se avisa cuando la magnitud CRUZA una marca. 1 (pasó), 5 (lleva toda la
 * mañana), 20 (lleva un día y nadie lo ha tocado). Tres correos que dicen
 * tres cosas distintas; el cuarto no diría nada que el tercero no dijera, así
 * que no existe. Y la cuenta vuelve a CERO cuando el problema se resuelve
 * (`hayProblema: false`), así que el siguiente incidente vuelve a avisar
 * desde la marca 1: es un filo re-armable, no un silencio permanente. La
 * huella del último correo NO se borra con la cuenta — es la memoria del
 * piso de abajo, y el piso vale también entre dos incidentes distintos.
 */
export const MARCAS_DE_INSISTENCIA: readonly number[] = [1, 5, 20];

/**
 * El PISO entre dos correos del mismo (agente, evento), pase lo que pase.
 *
 * Las marcas ya limitan a tres correos por incidente, pero no dicen NADA
 * sobre qué tan juntos salen: un agente que corre en bucle y falla 20 veces
 * en dos minutos cruzaría las tres marcas en esos dos minutos. Este piso es
 * el cinturón contra la frecuencia de corrida, que es un dato del cron y no
 * una decisión de producto. No pierde información: la marca cruzada sigue
 * cruzada, así que el aviso sale en la siguiente evaluación pasada la hora.
 *
 * Y el piso SOBREVIVE al cierre del incidente (B7, auditoría 4): un agente
 * que PARPADEA —falla un lote sí y uno no— cierra y reabre su incidente en
 * cada par de corridas, y si el cierre borrara también la huella del último
 * correo, cada reapertura sería «la primera vez» y saldría un correo POR
 * LOTE. La pestaña afirma «entre dos avisos siempre pasan al menos 60
 * minutos» sin excepciones, y este piso es el que lo hace verdad: vale entre
 * dos correos cualesquiera, sean del mismo incidente o de dos distintos.
 */
export const PISO_ENTRE_AVISOS_MS = 60 * 60 * 1000;

/**
 * Tope de destinatarios por correo. Resend rechaza el envío COMPLETO si la
 * lista se pasa de su límite, así que sin tope una flota con muchas cuentas
 * no recibiría el aviso en NINGUNA — el peor final posible para un canal de
 * alertas. Con tope, el aviso llega recortado y la pantalla lo declara.
 */
export const MAX_DESTINATARIOS = 20;

/** En qué escalón de insistencia cae una magnitud. `-1` = por debajo de la
 *  primera marca (todavía no hay nada que contar). */
export function marcaAlcanzada(magnitud: number): number {
  let i = -1;
  for (let k = 0; k < MARCAS_DE_INSISTENCIA.length; k++) {
    if (magnitud >= MARCAS_DE_INSISTENCIA[k]) i = k;
  }
  return i;
}

export interface EstadoEvento {
  /** ¿Hay problema AHORA? `false` re-arma el filo y no manda nada. */
  hayProblema: boolean;
  /**
   * La magnitud MEDIDA por quien llama: piezas atoradas en la cola, viajes
   * escalados. `null` cuando el evento se cuenta por RACHA (la corrida
   * fallida): entonces la magnitud es cuántas veces seguidas ha pasado y la
   * lleva este módulo, porque quien llama solo conoce su propia corrida.
   */
  magnitud: number | null;
}

export interface HuellaAviso {
  /** Cuándo salió el último correo de este (agente, evento). */
  avisadoEn: Date;
  /** Con qué magnitud salió. Es contra esto que se mide si hay noticia. */
  magnitud: number;
}

export interface EntradaDecision {
  /** `correoConfigurado()`. Sin canal no hay aviso, y la pantalla lo dice en
   *  vez de ofrecer un interruptor que no hace nada. */
  canalListo: boolean;
  /** ¿El evento está encendido para este agente en esta flota? */
  eventoEncendido: boolean;
  /** Cuánta gente lo recibiría. 0 = no hay a quién. */
  destinatarios: number;
  hayProblema: boolean;
  /** Ya resuelta (racha o medida). */
  magnitud: number;
  ultimo: HuellaAviso | null;
  /**
   * `true` cuando `ultimo` es la huella de un incidente que YA SE CERRÓ (el
   * cierre pone la magnitud en cero y conserva la huella — `cerrarIncidente`).
   * Cambia la lectura entera de `ultimo`: sus MARCAS son de un problema que ya
   * no existe y no cuentan contra el problema nuevo, pero su RELOJ sí — el
   * piso de una hora vale entre dos correos cualesquiera. Sin esta distinción,
   * un agente que parpadea manda un correo por lote (B7, auditoría 4).
   */
  ultimoDeIncidenteCerrado: boolean;
  ahora: Date;
}

/** `porque` es el texto que la pantalla repite tal cual: el agente que calla
 *  tiene que poder decir por qué calla. */
export interface Veredicto {
  avisar: boolean;
  porque: string;
}

/**
 * ¿ESTE evento, AHORA, amerita un correo? Pura: ni lee la base ni mira el
 * reloj del sistema (`ahora` entra por parámetro).
 *
 * El orden de los cortes no es casual — va del más general al más específico,
 * para que el motivo que devuelve sea el que de verdad le sirve a quien lee:
 * "no hay canal" es más útil que "todavía no llega a la siguiente marca"
 * cuando las dos cosas son ciertas.
 */
export function debeAvisar(e: EntradaDecision): Veredicto {
  if (!e.canalListo) {
    return { avisar: false, porque: 'el correo no está configurado en este entorno: no sale ningún aviso.' };
  }
  if (!e.eventoEncendido) {
    return { avisar: false, porque: 'este aviso está apagado para este agente.' };
  }
  if (e.destinatarios <= 0) {
    return { avisar: false, porque: 'nadie de la flota tiene un correo que pueda recibirlo.' };
  }
  if (!e.hayProblema) {
    // Y aquí NO hay un "todo salió bien" por correo: es el aviso que más
    // rápido enseña a ignorar el resto.
    return { avisar: false, porque: 'no hay nada que avisar ahora mismo.' };
  }

  // `hayProblema` es la autoridad: si quien llama afirma que hay problema
  // pero manda una magnitud de 0, se cuenta como 1. Redondear hacia el
  // silencio callaría un problema real por un contador mal armado.
  const magnitud = Math.max(1, Math.floor(e.magnitud));

  if (e.ultimo === null) {
    return { avisar: true, porque: 'es la primera vez desde la última vez que esto quedó resuelto.' };
  }

  // La huella es de un incidente que YA CERRÓ: el problema de ahora es NUEVO
  // y no se compara contra las marcas de uno que ya no existe — el filo está
  // re-armado. Lo ÚNICO que sobrevive al cierre es el reloj: sin este corte,
  // un agente que parpadea (falla un lote sí y uno no) encontraría el filo
  // re-armado en cada lote y mandaría un correo por lote, con la pestaña
  // jurando que entre dos avisos siempre pasa una hora (B7, auditoría 4).
  if (e.ultimoDeIncidenteCerrado) {
    const desde = e.ahora.getTime() - e.ultimo.avisadoEn.getTime();
    if (desde < PISO_ENTRE_AVISOS_MS) {
      const minutos = Math.max(1, Math.ceil((PISO_ENTRE_AVISOS_MS - desde) / 60_000));
      return {
        avisar: false,
        porque: `es un problema nuevo, pero el aviso anterior salió hace menos de una hora: sale en ${numero(minutos)} min.`,
      };
    }
    return { avisar: true, porque: 'es la primera vez desde la última vez que esto quedó resuelto.' };
  }

  const marcaAhora = marcaAlcanzada(magnitud);
  const marcaAntes = marcaAlcanzada(e.ultimo.magnitud);
  if (marcaAhora <= marcaAntes) {
    const siguiente = MARCAS_DE_INSISTENCIA[marcaAntes + 1];
    return {
      avisar: false,
      porque: siguiente === undefined
        ? `ya se avisó con ${numero(e.ultimo.magnitud)} y no queda nada nuevo que decir; vuelve a avisar cuando esto se resuelva y reaparezca.`
        : `ya se avisó con ${numero(e.ultimo.magnitud)}; el siguiente sale al llegar a ${numero(siguiente)} o cuando esto se resuelva y reaparezca.`,
    };
  }

  const desde = e.ahora.getTime() - e.ultimo.avisadoEn.getTime();
  if (desde < PISO_ENTRE_AVISOS_MS) {
    const minutos = Math.max(1, Math.ceil((PISO_ENTRE_AVISOS_MS - desde) / 60_000));
    return {
      avisar: false,
      porque: `empeoró, pero el aviso anterior salió hace menos de una hora: sale en ${numero(minutos)} min.`,
    };
  }

  return {
    avisar: true,
    porque: `empeoró desde el último aviso (${numero(e.ultimo.magnitud)} → ${numero(magnitud)}).`,
  };
}

/**
 * El motivo de una corrida fallida, en palabras de persona.
 *
 * Un stack trace en el correo del contralor no le dice qué hacer y sí le dice
 * que el producto está roto (`avisos.ts` lo exige ya traducido, y nadie se
 * acuerda de traducirlo en el `catch`). Se queda la PRIMERA línea, se tiran
 * los marcos de pila, y una cadena vacía cae a una frase honesta en vez de a
 * un correo con el renglón "Qué pasó:" en blanco.
 */
export function motivoDeCorrida(crudo: unknown): string {
  const texto = crudo instanceof Error ? crudo.message : typeof crudo === 'string' ? crudo : '';
  const primera = texto
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^at\s/.test(l))[0] ?? '';
  if (primera.length === 0) return 'La corrida se detuvo sin dejar un motivo legible.';
  return primera.length > 160 ? `${primera.slice(0, 157)}…` : primera;
}

// ── LOS DESTINATARIOS ──────────────────────────────────────────────────────

export interface UsuarioAvisable {
  id: string;
  nombre: string | null;
  /** `null` cuando la cuenta no tiene correo utilizable. */
  email: string | null;
  rol: string;
}

export interface Reparto {
  /** A quién le llega, ya con correo garantizado. */
  reciben: Array<{ id: string; nombre: string | null; email: string; rol: string }>;
  /** A quién NO, y por qué. Es la mitad honesta: la pestaña la enseña igual
   *  que el Agente de Cobranza enseña "a quién no puede escribirle". */
  excluidos: Array<{ id: string; nombre: string | null; rol: string; porque: string }>;
}

/**
 * Quién recibe y quién no, con el porqué de cada exclusión. PURA: recibe las
 * filas ya leídas.
 *
 * El orden de las causas importa porque solo se enseña una por persona, y
 * tiene que ser la que la persona pueda accionar: primero la que no depende
 * de nadie (su rol no abre esa pantalla), luego la decisión del cliente (no
 * lo marcó), y al final el dato que falta (no tiene correo).
 */
export function repartoDe(
  usuarios: readonly UsuarioAvisable[],
  config: ConfigNotificaciones,
  agente: AgenteNotificable,
): Reparto {
  const permitidos = rolesQuePueden(agente);
  const r: Reparto = { reciben: [], excluidos: [] };
  const yaPuesto = new Set<string>();

  for (const u of usuarios) {
    if (!permitidos.includes(u.rol as RolAvisable)) {
      r.excluidos.push({ id: u.id, nombre: u.nombre, rol: u.rol, porque: 'su rol no puede abrir la pantalla de este agente' });
      continue;
    }
    if (!config.roles.includes(u.rol as RolAvisable)) {
      r.excluidos.push({ id: u.id, nombre: u.nombre, rol: u.rol, porque: 'su rol no está marcado para recibir' });
      continue;
    }
    const email = u.email?.trim() ?? '';
    if (email.length === 0) {
      r.excluidos.push({ id: u.id, nombre: u.nombre, rol: u.rol, porque: 'su cuenta no tiene correo' });
      continue;
    }
    // Dos cuentas con el mismo correo mandarían el aviso dos veces a la misma
    // bandeja. Se queda la primera; la segunda se declara.
    const llave = email.toLowerCase();
    if (yaPuesto.has(llave)) {
      r.excluidos.push({ id: u.id, nombre: u.nombre, rol: u.rol, porque: 'otra cuenta ya usa ese mismo correo' });
      continue;
    }
    if (r.reciben.length >= MAX_DESTINATARIOS) {
      r.excluidos.push({ id: u.id, nombre: u.nombre, rol: u.rol, porque: `el aviso va a las primeras ${MAX_DESTINATARIOS} cuentas` });
      continue;
    }
    yaPuesto.add(llave);
    r.reciben.push({ id: u.id, nombre: u.nombre, email, rol: u.rol });
  }
  return r;
}

// ── LECTURA Y ESCRITURA ────────────────────────────────────────────────────

export type LecturaConfig = { ok: ConfigNotificaciones } | { error: string };

/**
 * La config de una flota para un agente. Sin fila = defaults del código
 * (nadie estrena una conducta distinta en silencio, mismo criterio que 0089).
 *
 * A DIFERENCIA de `leerConfigCobranza`, una fila ilegible o corrupta NO cae a
 * los defaults: devuelve error. Caer al default aquí encendería un aviso que
 * la flota pudo haber apagado a propósito, y el canal que se pretende cuidar
 * se llenaría por un bug. Sin config legible no hay autorización para
 * escribirle a nadie: se calla, se grita en el log y la pantalla lo dice.
 */
export async function leerConfigNotificaciones(
  tenantId: string,
  agente: AgenteNotificable,
): Promise<LecturaConfig> {
  const { data, error } = await supabaseAdmin()
    .from('agente_notificacion_config')
    .select('eventos, roles')
    .eq('tenant_id', tenantId)
    .eq('agente', agente.id)
    .maybeSingle();

  if (error) {
    logger.error('notificaciones.config_ilegible', { tenantId, agente: agente.id, err: error.message });
    return { error: 'No se pudo leer a quién avisa este agente. Mientras tanto no sale ningún correo.' };
  }
  if (!data) return { ok: CONFIG_NOTIF_DEFAULT };

  const v = validarConfigNotificaciones(agente, {
    eventos: Array.isArray(data.eventos) ? (data.eventos as string[]) : [],
    roles: Array.isArray(data.roles) ? (data.roles as string[]) : [],
  });
  if ('error' in v) {
    logger.error('notificaciones.config_corrupta', { tenantId, agente: agente.id, err: v.error });
    return { error: 'La configuración de avisos guardada no es válida. Vuelve a guardarla para reactivarlos.' };
  }
  return v;
}

export async function guardarConfigNotificaciones(
  tenantId: string,
  agente: AgenteNotificable,
  cruda: { eventos?: readonly string[]; roles?: readonly string[] },
): Promise<{ error?: string }> {
  const v = validarConfigNotificaciones(agente, cruda);
  if ('error' in v) return { error: v.error };

  const { error } = await supabaseAdmin()
    .from('agente_notificacion_config')
    .upsert({
      tenant_id: tenantId,
      agente: agente.id,
      eventos: v.ok.eventos,
      roles: v.ok.roles,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,agente' });

  if (error) {
    logger.error('notificaciones.config_no_guardada', { tenantId, agente: agente.id, err: error.message });
    return { error: 'No se pudo guardar. Inténtalo de nuevo.' };
  }
  return {};
}

/**
 * Las cuentas del panel de una flota. Falla por VALOR como el resto del repo:
 * un error de lectura se lanza, porque "nadie tiene correo" y "no pude
 * preguntar" llevan a decisiones opuestas — la primera se arregla capturando
 * correos, la segunda no se arregla capturando nada.
 */
export async function usuariosAvisables(tenantId: string): Promise<UsuarioAvisable[]> {
  // FE-34: `.limit(200)` sin `.order()` no traía "los primeros 200" —
  // traía 200 cualesquiera, y ninguna pantalla decía que había un tope.
  // `.order('id')` lo vuelve determinista; el reparto real de avisos sigue
  // filtrando por rol después (`repartoDe`), así que el orden no cambia a
  // quién le llega qué.
  //
  // AUDITORÍA 25, ALTO (reauditoría, misma causa raíz que AGEN-C1 en
  // contactos.ts, commit 24ce4c2): `activo`. Esta función alimenta tres
  // consumidores vivos —el reparto de las alarmas de los agentes
  // (`notificaciones.ts:926` → `repartoDe`), el aviso de una propuesta de
  // PAGO (`portal_pago_aviso.ts`) y la pantalla que le enseña a la flota «a
  // quién le llega» (`/dashboard/agentes`)— y ninguno miraba `activo`:
  // `desactivarUsuario` (usuarios_escritura.ts:191) escribe `activo=false`
  // pero NO borra `app_user.email`, así que una cuenta de baja seguía
  // recibiendo alarmas y avisos de dinero, y el panel la pintaba como
  // destinataria en `/dashboard/agentes` mientras `/dashboard/usuarios` la
  // pintaba, dos clics más allá, como dada de baja. Doble capa y misma regla
  // que allá: solo el `false` EXPLÍCITO da de baja, para que una fila sin la
  // columna (base sin la 0294) no se quede sin sus avisos.
  const { data, error } = await supabaseAdmin()
    .from('app_user')
    .select('id, nombre, email, rol, activo')
    .eq('tenant_id', tenantId)
    .or('activo.is.null,activo.eq.true')
    .order('id')
    .limit(200);
  if (error) throw new Error(`usuariosAvisables: ${error.message}`);
  return (data ?? [])
    .filter((u) => (u as { activo?: boolean | null }).activo !== false)
    .map((u) => ({
      id: u.id as string,
      nombre: (u.nombre as string | null) ?? null,
      email: (u.email as string | null) ?? null,
      rol: u.rol as string,
    }));
}

// ── EL ESTADO DEL ANTI-RUIDO (una fila por tenant + agente + evento) ───────

interface FilaEstado {
  magnitud: number;
  ultimo: HuellaAviso | null;
  /**
   * AG-M3 (auditoría 28): cuándo se tocó esta fila por ÚLTIMA VEZ desde
   * `cerrarIncidente` — ver el comentario de `guardarMagnitud` sobre por qué
   * esta función ya NO escribe esta columna. Comparada contra
   * `ultimo.avisadoEn` en `avisar()`, es la señal —durable entre corridas—
   * de que el incidente vigente es NUEVO desde el último correo real.
   */
  actualizadoEn: Date;
}

async function leerEstado(tenantId: string, agente: AgenteId, evento: EventoId): Promise<FilaEstado | null> {
  const { data, error } = await supabaseAdmin()
    .from('agente_notificacion_estado')
    .select('magnitud, avisado_en, magnitud_avisada, actualizado_en')
    .eq('tenant_id', tenantId).eq('agente', agente).eq('evento', evento)
    .maybeSingle();
  if (error) throw new Error(`leerEstado: ${error.message}`);
  if (!data) return null;

  const avisadoEn = data.avisado_en ? new Date(data.avisado_en as string) : null;
  const magnitudAvisada = data.magnitud_avisada as number | null;
  return {
    magnitud: (data.magnitud as number | null) ?? 0,
    // Las dos columnas van JUNTAS o no van: una huella con fecha pero sin
    // magnitud no se puede comparar contra nada y haría que `debeAvisar` la
    // leyera como magnitud 0, es decir, "cualquier cosa es noticia".
    ultimo: avisadoEn && magnitudAvisada !== null ? { avisadoEn, magnitud: magnitudAvisada } : null,
    actualizadoEn: new Date(data.actualizado_en as string),
  };
}

/**
 * El incidente se cerró: la MAGNITUD vuelve a cero y la huella SE QUEDA.
 *
 * Poner la cuenta en cero es lo que re-arma el filo. Sin esto, un agente que
 * se rompe, se arregla y se vuelve a romper en la tarde no avisaría la
 * segunda vez — su marca seguiría "ya alcanzada" desde la mañana.
 *
 * HASTA LA AUDITORÍA 4 (B7) ESTO ERA UN DELETE DE LA FILA ENTERA, y borraba
 * también `avisado_en`: el siguiente incidente encontraba `ultimo === null`,
 * `debeAvisar` lo despachaba como «primera vez» SIN consultar el piso, y un
 * agente que parpadea (falla un lote sí y uno no) mandaba un correo POR
 * LOTE — mientras la pestaña afirmaba «entre dos avisos siempre pasan al
 * menos 60 minutos». La huella se conserva porque es la memoria del piso; la
 * memoria de MARCAS del incidente muerto se degrada cuando el siguiente
 * arranca (ver `guardarMagnitud`).
 */
async function cerrarIncidente(
  tenantId: string, agente: AgenteId, evento: EventoId, ahora: Date,
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('agente_notificacion_estado')
    .update({ magnitud: 0, actualizado_en: ahora.toISOString() })
    .eq('tenant_id', tenantId).eq('agente', agente).eq('evento', evento);
  if (error) logger.warn('notificaciones.estado_no_cerrado', { tenantId, agente, evento, err: error.message });
}

async function guardarMagnitud(
  tenantId: string, agente: AgenteId, evento: EventoId, magnitud: number,
): Promise<void> {
  // Lectura-modificación-escritura: dos corridas simultáneas pueden leer la
  // misma racha y escribir el mismo +1 (una se pierde). Se acepta a
  // conciencia y NO se monta un RPC para esto: el precio de contar 4 donde
  // iban 5 es que la marca se cruza una corrida después, y el aviso sale
  // igual. El error caro sería el contrario —contar de más y avisar de
  // nada—, y ese no puede pasar con esta forma.
  //
  // NO ESCRIBE `actualizado_en` (AG-M3, auditoría 28; antes sí lo hacía, en
  // cada llamada). Esa columna queda RESERVADA para `cerrarIncidente`, que la
  // usa como el sello de "cuándo se cerró por última vez este (agente,
  // evento)". La huella completa —`avisado_en`/`magnitud_avisada`— tampoco se
  // toca aquí: solo un envío REAL la mueve (`reclamarAviso`).
  //
  // POR QUÉ IMPORTA: antes de esto, la primera corrida tras un cierre
  // degradaba `magnitud_avisada` a un valor fijo para "rearmar" el filo, pero
  // la SEGUNDA corrida ya no podía saber que el incidente seguía siendo
  // nuevo —`magnitud` había dejado de ser 0 en la primera escritura—, y caía
  // otra vez al filtro de MARCAS (1/5/20) en vez de al piso de una hora. Un
  // incidente reabierto con poca magnitud (1-4) se quedaba mudo mucho más
  // allá de la hora prometida, esperando alcanzar la marca 5. Al no tocar
  // `actualizado_en` aquí, esa columna se queda plantada en el momento del
  // último cierre durante TODAS las corridas siguientes —sin importar cuánto
  // suba `magnitud`—, así que `avisar()` puede comparar
  // `actualizado_en > ultimo.avisadoEn` en cada una de ellas y seguir
  // sabiendo "esto es nuevo desde el último correo real" hasta que ese correo
  // de verdad salga (momento en el que `reclamarAviso` adelanta `avisado_en`
  // y la comparación deja de ser cierta, como corresponde).
  const { error } = await supabaseAdmin()
    .from('agente_notificacion_estado')
    .upsert({
      tenant_id: tenantId, agente, evento,
      magnitud,
    }, { onConflict: 'tenant_id,agente,evento' });
  if (error) throw new Error(`guardarMagnitud: ${error.message}`);
}

/**
 * RECLAMAR ANTES DE MANDAR — el mismo patrón que `reclamarEscalacion`
 * (escalar_viaje.ts) y que el INSERT del 0089.
 *
 * Vercel Cron entrega *at-least-once*: dos corridas pueden solaparse, leer el
 * mismo estado, pasar las dos por `debeAvisar` y mandar las dos el mismo
 * correo. El UPDATE condicional mueve la decisión a Postgres: la segunda
 * corrida ya no encuentra fila que cumpla la condición y no manda nada.
 *
 * El sello se pone ANTES del envío. Hasta la auditoría 28 (AG-A5b) eso
 * significaba que un envío que falla consumía el turno igual que uno que
 * sale: el problema seguía vivo y el canal quedaba mudo hasta la siguiente
 * marca o el piso completo, por un 429 de Resend que no tiene nada que ver
 * con el incidente. Ahora un envío fallido se REVIERTE (`revertirAviso`,
 * abajo): el claim sigue impidiendo que dos corridas SOLAPADAS manden dos
 * correos —eso no depende de si el envío sale—, pero una corrida
 * SIGUIENTE, ya no solapada, vuelve a encontrar la huella tal como estaba
 * y puede intentarlo de nuevo.
 */
async function reclamarAviso(
  tenantId: string, agente: AgenteId, evento: EventoId, magnitud: number, ahora: Date,
): Promise<boolean> {
  const umbral = new Date(ahora.getTime() - PISO_ENTRE_AVISOS_MS).toISOString();
  const { data, error } = await supabaseAdmin()
    .from('agente_notificacion_estado')
    .update({ avisado_en: ahora.toISOString(), magnitud_avisada: magnitud })
    .eq('tenant_id', tenantId).eq('agente', agente).eq('evento', evento)
    .or(`avisado_en.is.null,avisado_en.lt.${umbral}`)
    .select('tenant_id');
  if (error) {
    logger.error('notificaciones.claim_fallido', { tenantId, agente, evento, err: error.message });
    return false;
  }
  return (data ?? []).length > 0;
}

/**
 * DESHACE el claim de `reclamarAviso` cuando el envío FALLÓ — AG-A5(b),
 * auditoría 28.
 *
 * Restaura la huella al valor que tenía ANTES de este intento (`previoUltimo`,
 * leído por `avisar()` antes de reclamar). El candado —los dos `.eq` sobre
 * `avisado_en`/`magnitud_avisada` con EXACTAMENTE lo que este intento acaba de
 * escribir— es lo que evita pisar el reclamo de una corrida distinta que haya
 * avanzado la huella mientras el envío de ÉSTA fallaba: si otra corrida ya
 * mandó un correo real después de este claim, esos valores ya no coinciden y
 * el `UPDATE` no toca nada.
 *
 * Nunca lanza: revertir es una limpieza de mejor esfuerzo, no el trabajo. Si
 * falla, la huella queda como si el correo hubiera salido —el estado de antes
 * de AG-A5b— y se grita en el log para que se note.
 */
async function revertirAviso(
  tenantId: string, agente: AgenteId, evento: EventoId,
  previoUltimo: HuellaAviso | null, ahora: Date, magnitudReclamada: number,
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('agente_notificacion_estado')
    .update({
      avisado_en: previoUltimo?.avisadoEn.toISOString() ?? null,
      magnitud_avisada: previoUltimo?.magnitud ?? null,
    })
    .eq('tenant_id', tenantId).eq('agente', agente).eq('evento', evento)
    .eq('avisado_en', ahora.toISOString())
    .eq('magnitud_avisada', magnitudReclamada);
  if (error) {
    logger.error('notificaciones.reclamo_no_revertido', { tenantId, agente, evento, err: error.message });
  }
}

/** El nombre de la flota para el correo. `null` si no se pudo leer: el aviso
 *  sale igual diciendo "tu flota" (`avisos.ts` ya lo contempla). Un correo
 *  perdido por no saber cómo se llama la empresa sería el peor intercambio. */
async function nombreDeFlota(tenantId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('tenant').select('nombre').eq('id', tenantId).maybeSingle();
  if (error) return null;
  return (data?.nombre as string | null) ?? null;
}

// ── EL DESPACHO ────────────────────────────────────────────────────────────

/** Lo que el motor le entrega a quien redacta el correo. */
export interface DatosDelAviso {
  flota: string | null;
  /** El nombre del agente tal como lo va a leer el destinatario. */
  agente: string;
  /** Su página, sin dominio: `avisoCorridaFallida` le pone el prefijo. */
  ruta: string;
  /** La magnitud con la que se decidió avisar (racha o medida). */
  magnitud: number;
  /** Ya formateada en hora de México. */
  cuando: string;
}

export interface ResultadoAviso {
  avisado: boolean;
  /** Salió o no salió, y por qué. La pantalla lo repite tal cual. */
  porque: string;
  destinatarios: number;
  magnitud: number;
}

/**
 * Evalúa un evento y, si amerita, manda el correo. Un solo punto de entrada
 * para que nadie pueda mandar saltándose el anti-ruido ni el reparto.
 *
 * SE LLAMA EN TODA CORRIDA, salga bien o mal: con `hayProblema: false` no
 * manda nada y pone la cuenta en cero (conservando la huella del piso), que
 * es lo que re-arma el filo para el siguiente incidente. Un agente que solo
 * llama cuando falla nunca vuelve a avisar de su segundo incidente.
 *
 * NUNCA LANZA. Igual que `enviarCorreo`: el trabajo de fondo del agente ya se
 * hizo, y perderlo porque el aviso no se pudo evaluar sería el peor
 * intercambio posible. Devuelve el porqué y lo grita en el log.
 *
 * AUDITORÍA 28 (AG-A5, AG-M3, AG-B3): esta función solo cierra correctamente
 * su PROPIO estado interno de marcas y piso. Que un (agente, evento) llegue
 * aquí con `hayProblema: false` cuando de verdad ya no hay problema es
 * responsabilidad de QUIEN LLAMA — ver `escalar_viaje.ts` y
 * `cron/facturar/lote.ts`, que hasta esta auditoría solo llamaban con
 * `hayProblema: true` y nunca re-armaban el filo de `escalado`/`cola_atorada`.
 */
export async function avisar(
  tenantId: string,
  agenteId: AgenteId,
  evento: EventoId,
  estado: EstadoEvento,
  armar: (d: DatosDelAviso) => Correo,
  ahora: Date = new Date(),
): Promise<ResultadoAviso> {
  // AG-B3 (auditoría 28): `destinatarios` es opcional y no siempre 0. Un
  // envío que falla SÍ tenía a quién llegarle —el reparto ya se calculó—, y
  // confundir "no hay a quién" con "había gente y rebotó" es la misma mentira
  // que decir "no se avisó a nadie" de un correo que sí se armó y sí se
  // intentó mandar.
  const nada = (porque: string, magnitud = 0, destinatarios = 0): ResultadoAviso =>
    ({ avisado: false, porque, destinatarios, magnitud });

  const agente = agentePorId(agenteId);
  if (!agente) return nada('ese agente no existe en el catálogo de avisos.');
  if (!agente.eventos.includes(evento)) {
    // Bug de quien llama, no estado del negocio: se grita. Fail closed.
    logger.warn('notificaciones.evento_no_declarado', { agente: agenteId, evento });
    return nada('este agente no declara ese evento.');
  }

  try {
    // El cierre del incidente es lo PRIMERO: no depende de config, de canal
    // ni de destinatarios, y tiene que ocurrir aunque todo lo demás esté
    // apagado — si no, el filo no se re-arma cuando el cliente vuelva a
    // encender el aviso.
    if (!estado.hayProblema) {
      await cerrarIncidente(tenantId, agenteId, evento, ahora);
      return nada('no hay nada que avisar ahora mismo.');
    }

    const previo = await leerEstado(tenantId, agenteId, evento);
    // AG-M3 (auditoría 28): el incidente de AHORA es NUEVO —su huella es la
    // de uno YA CERRADO, cuyo reloj (el piso) cuenta pero cuyas marcas no—
    // cuando el último cierre (`actualizado_en`, que SOLO toca
    // `cerrarIncidente`) es más reciente que el último correo REAL
    // (`ultimo.avisadoEn`, que SOLO tocan los envíos que salieron). A
    // diferencia de comparar contra `previo.magnitud === 0` (la versión
    // anterior a esta auditoría): esa comparación se rompía en la corrida
    // SIGUIENTE a la primera tras el cierre, porque `magnitud` tiene que
    // seguir subiendo para reportar la racha real y deja de ser 0 de
    // inmediato. `actualizado_en` no se mueve por eso —`guardarMagnitud` ya
    // no la toca— así que la comparación sigue siendo cierta mientras haga
    // falta, corrida tras corrida, hasta que un correo real la invalide.
    const incidenteCerrado = previo !== null && previo.ultimo !== null
      && previo.actualizadoEn.getTime() > previo.ultimo.avisadoEn.getTime();
    const magnitud = estado.magnitud === null
      ? (previo?.magnitud ?? 0) + 1
      : Math.max(1, Math.floor(estado.magnitud));
    await guardarMagnitud(tenantId, agenteId, evento, magnitud);

    const conf = await leerConfigNotificaciones(tenantId, agente);
    if ('error' in conf) return nada(conf.error, magnitud);

    const reparto = repartoDe(await usuariosAvisables(tenantId), conf.ok, agente);

    const veredicto = debeAvisar({
      canalListo: correoConfigurado(),
      eventoEncendido: conf.ok.eventos.includes(evento),
      destinatarios: reparto.reciben.length,
      hayProblema: true,
      magnitud,
      ultimo: previo?.ultimo ?? null,
      ultimoDeIncidenteCerrado: incidenteCerrado,
      ahora,
    });
    if (!veredicto.avisar) return nada(veredicto.porque, magnitud);

    if (!(await reclamarAviso(tenantId, agenteId, evento, magnitud, ahora))) {
      return nada('otra corrida acaba de mandar este mismo aviso.', magnitud);
    }

    const correo = armar({
      flota: await nombreDeFlota(tenantId),
      agente: agente.nombre,
      ruta: agente.ruta,
      magnitud,
      cuando: fechaHoraMx(ahora.toISOString()),
    });

    const envio = await enviarCorreo(reparto.reciben.map((d) => d.email), correo);
    if (!envio.ok) {
      // AG-A5(b): el claim de `reclamarAviso` ya selló la huella como si el
      // correo hubiera salido. Un envío que rebota (Resend 429, dominio
      // caído) no puede consumir el turno del incidente: se revierte para que
      // la corrida siguiente lo pueda intentar de nuevo en vez de quedarse
      // muda hasta la próxima marca o el piso completo por un fallo del canal
      // que nada tiene que ver con el problema real.
      await revertirAviso(tenantId, agenteId, evento, previo?.ultimo ?? null, ahora, magnitud);
      logger.warn('notificaciones.envio_fallido', { tenantId, agente: agenteId, evento, motivo: envio.motivo });
      return nada(`el aviso no se pudo entregar (${envio.motivo}).`, magnitud, reparto.reciben.length);
    }

    logger.info('notificaciones.aviso', {
      tenantId, agente: agenteId, evento, magnitud, destinatarios: reparto.reciben.length,
    });
    return {
      avisado: true,
      porque: veredicto.porque,
      destinatarios: reparto.reciben.length,
      magnitud,
    };
  } catch (e) {
    const detalle = e instanceof Error ? e.message : String(e);
    logger.error('notificaciones.evaluacion_fallida', { tenantId, agente: agenteId, evento, detalle });
    return nada('no se pudo evaluar el aviso ahora mismo.');
  }
}

/**
 * UN FALLO DE LA PLATAFORMA DE LIKIDA — no de los datos ni de la configuración
 * de la flota (B8, auditoría 4).
 *
 * Quien detecta que la corrida murió por infraestructura NUESTRA —el caso real:
 * Chromium no arranca en el cron de facturación, y hasta 20 flotas reciben el
 * mismo correo a la vez— envuelve el error en esta clase antes de meterlo al
 * mapa de corridas. `avisarCorridaFallida` la reconoce y redacta la variante
 * que NO manda al cliente a revisar nada: decirle «tu agente no pudo trabajar»
 * a secas, por un fallo que es de Likida, es acusarlo de un problema ajeno.
 *
 * Viaja EN el error y no en las firmas a propósito: el mapa de corridas es
 * `Map<string, unknown>` y `avisarCorridasPorFlota`/`avisarCorridaFallida` ya
 * aceptan `unknown` — marcar el origen no le cuesta un parámetro a nadie.
 */
export class FalloDePlataforma extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'FalloDePlataforma';
  }
}

/**
 * El aviso que los seis agentes comparten, ya cableado a `avisoCorridaFallida`.
 *
 * `fallo` ausente (`null` o `undefined`) significa que la corrida SÍ terminó:
 * no manda nada y cierra el incidente. Por eso se llama al final de TODA
 * corrida —el `finally` del agente— y no solo dentro del `catch`.
 *
 * Se comparan las DOS ausencias con `== null` a propósito: quien llama suele
 * pasar el `error` de un resultado (`r.error`, que es `undefined` cuando
 * salió bien), y tratar ese `undefined` como fallo mandaría un correo de
 * "el agente no pudo trabajar" cada vez que el agente trabaja.
 */
export async function avisarCorridaFallida(
  tenantId: string,
  agenteId: AgenteId,
  fallo: unknown,
  ahora: Date = new Date(),
): Promise<ResultadoAviso> {
  const fallo_ = fallo ?? null;
  // La marca viaja en el error mismo (`FalloDePlataforma`): si el fallo fue de
  // la plataforma de Likida, el correo lo dice y no manda al cliente a revisar
  // una información que está bien.
  const plataforma = fallo_ instanceof FalloDePlataforma;
  const motivo = fallo_ === null ? '' : motivoDeCorrida(fallo_);
  return avisar(
    tenantId, agenteId, 'corrida_fallida',
    { hayProblema: fallo_ !== null, magnitud: null },
    (d) => avisoCorridaFallida({
      flota: d.flota,
      agente: d.agente,
      href: d.ruta,
      cuando: d.cuando,
      motivo,
      plataforma,
      // La racha ES el `seguidas` del aviso: con 1 el correo dice "no pudo
      // completar su corrida"; con más, "lleva N corridas sin completarse".
      seguidas: d.magnitud,
    }),
    ahora,
  );
}

/**
 * El cierre de una corrida GLOBAL: una flota por entrada, con su fallo o
 * `null` si salió bien.
 *
 * ── POR QUÉ TAMBIÉN SE AVISA EL ÉXITO ────────────────────────────────────
 *
 * Ésta es la razón de que exista esta función y no un `avisarCorridaFallida`
 * suelto dentro del `catch`. Llamarla solo cuando algo truena parece lo obvio
 * y deja el aviso ROTO de una forma silenciosa: la racha de una flota que se
 * rompió una vez y luego sanó nunca se limpia, así que el contador sigue
 * arriba y el SIGUIENTE incidente —meses después, otro problema— arranca ya
 * pasado de las marcas de insistencia y no manda el primer correo, que es
 * justo el que importa. El éxito con `fallo = null` es lo que rearma el
 * borde. Por eso se llama para TODAS las que corrieron, en el equivalente de
 * un `finally`, no de un `catch`.
 *
 * ── LAS QUE NO CORRIERON NO ENTRAN ───────────────────────────────────────
 *
 * Una flota que el corte por reloj dejó fuera no va en el mapa: ni éxito (que
 * borraría una racha real sin haber arreglado nada) ni fallo (no falló, no le
 * tocó turno). Se calla, y la corrida de la siguiente hora decide.
 *
 * ── NUNCA TUMBA LA CORRIDA ───────────────────────────────────────────────
 *
 * `allSettled` y sin propagar: el aviso es observabilidad del trabajo, no el
 * trabajo. Un Resend caído no puede convertir una corrida que SÍ contactó a
 * 40 choferes en una corrida fallida — que además dispararía el aviso de que
 * falló, cerrando el círculo del absurdo.
 */
export async function avisarCorridasPorFlota(
  agenteId: AgenteId,
  corridas: ReadonlyMap<string, unknown>,
  ahora: Date = new Date(),
): Promise<void> {
  if (corridas.size === 0) return;
  const rs = await Promise.allSettled(
    [...corridas].map(([tenantId, fallo]) => avisarCorridaFallida(tenantId, agenteId, fallo, ahora)),
  );
  const rotos = rs.filter((r) => r.status === 'rejected').length;
  if (rotos > 0) logger.error('notificaciones.cierre_de_corrida_roto', { agente: agenteId, rotos });
}
