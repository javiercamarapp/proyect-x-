// ═══════════════════════════════════════════════════════════════════════════
// EL CICLO DE UN TICKET — responder, tomar, cerrar, reabrir.
//
// ── QUÉ ESTABA ROTO (auditoría de dashboards, 29-ago-2026, H1) ─────────────
//
// `/dashboard/soporte` abría tickets con reloj de SLA desde el 16-ago.
// `/admin/soporte` los MIRABA. Y ahí se acababa el producto:
//
//   · `ticket_mensaje` (0051) — CERO escritores en todo `src/`. Dos lectores
//     (`agentes/faq.ts`, `agentes/exito.ts`) sobre una tabla que nadie llenaba.
//   · `ticket_soporte.estado` — CERO UPDATEs en todo `src/`. Ningún ticket
//     podía salir jamás de 'abierto': el semáforo de la cola llegaba a rojo y
//     se quedaba ahí para siempre.
//   · Y la consecuencia que de verdad dolía: la alarma «sin respuesta» del
//     agente de Éxito (`agentes/exito.ts`, `cuentaComoRespuesta`) se apaga
//     ante un mensaje PÚBLICO de un autor DISTINTO del solicitante. Sin
//     escritores esa condición era INSATISFACIBLE POR CONSTRUCCIÓN — una
//     alarma que no se puede apagar es una alarma que se deja de leer.
//
// Este módulo es el escritor que faltaba. La 0268 puso las dos piezas de
// esquema (`asignado_a` y las policies que esconden la nota interna).
//
// ── POR QUÉ TODO PIDE `tenantId`, INCLUSO EL SUPERADMIN ────────────────────
//
// Ninguna función de aquí cruza flotas. Ni una. El superadmin de
// /admin/soporte tampoco: su página resuelve ANTES a qué flota pertenece el
// ticket (`resolverTicketCruzado`, en `lib/admin/soporte.ts` — el barrio que
// SÍ tiene ese permiso y lo declara) y luego entra por esta puerta con ese
// tenant en la mano. Así el aislamiento es una propiedad de CADA consulta y
// no de quién la llama: un admin de la flota B que teclee el id de un ticket
// de la flota A no encuentra el ticket, y no encontrarlo es lo mismo que no
// poder tocarlo (`ticketNoEncontrado`, probado en soporte.test.ts).
//
// ── LA NOTA INTERNA ES UN CONCEPTO DEL ESQUEMA, NO UN INVENTO ──────────────
//
// `ticket_mensaje.interna` existe desde la 0051 con su razón escrita. Aquí se
// respeta en las DOS direcciones:
//
//   · LECTURA — `getHilo` con `verInternas: false` pone `.eq('interna', false)`
//     EN LA CONSULTA. No se traen y se filtran en memoria: lo que no viaja no
//     se puede pintar por accidente en un render nuevo.
//   · ESCRITURA — un actor `{ tipo: 'flota' }` que pida `interna: true` es
//     rechazado aquí, antes de tocar la base. El cliente no puede fabricar una
//     nota "del equipo" en su propio hilo.
//
// La 0268 repite las dos reglas como policy de RLS. Ésa es la segunda red (el
// producto consulta con `service_role`, que salta RLS); ésta es la primera.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase/admin';
import { acotada } from '@/lib/likida/presupuesto';
import { DatoInvalido } from '@/lib/likida/errores';
import { anotarBitacora } from '@/lib/likida/bitacora_escritura';

/** El dominio de `ticket_soporte.estado` (0051), en el mismo orden del CHECK. */
export const ESTADOS_TICKET = ['abierto', 'en_proceso', 'esperando', 'resuelto', 'cerrado'] as const;
export type EstadoTicket = (typeof ESTADOS_TICKET)[number];

/** Los dos estados que el constraint `ticket_cierre_coherente` liga con
 *  `resuelto_en` NO NULO. Salir de ellos obliga a volver `resuelto_en` a NULL:
 *  un ticket reabierto que conserve su fecha de resolución hace que el tiempo
 *  de respuesta se mida contra un cierre que ya no existe. */
export const ESTADOS_TERMINALES: ReadonlySet<string> = new Set<string>(['resuelto', 'cerrado']);

/** Cuántos mensajes del hilo se traen de una vez. El hilo de un ticket es de
 *  decenas de filas, no de miles — mismo tope que usa `exito.ts` para leerlo. */
export const TOPE_MENSAJES_HILO = 200;

/** Tope del cuerpo de un mensaje. Es el mismo que `abrirTicket` aplica a la
 *  descripción: un hilo no es un adjunto. */
export const LARGO_MAX_MENSAJE = 4000;

/**
 * Quién actúa sobre el ticket.
 *
 * NO es "el rol de la sesión": es de qué LADO del mostrador está. `likida` es
 * el equipo que atiende (superadmin, /admin/soporte); `flota` es el cliente
 * que pidió ayuda (/dashboard/soporte). La distinción decide tres cosas —
 * quién puede escribir una nota interna, quién puede tomar el ticket, y si
 * una respuesta apaga o no la alarma del agente de Éxito— y por eso viaja
 * explícita en vez de deducirse de un string de rol en cada llamada.
 */
export type ActorSoporte =
  | { tipo: 'likida'; userId: string }
  | { tipo: 'flota'; userId: string };

export interface MensajeHilo {
  id: string;
  autorId: string | null;
  /** Nombre de `app_user`. `null` = la cuenta se dio de baja (la FK es
   *  `on delete set null`) o nunca tuvo nombre — se pinta "—", no se inventa. */
  autorNombre: string | null;
  /** `true` si lo escribió el equipo de Likida (superadmin). Es lo que deja
   *  al cliente distinguir su propio mensaje de la respuesta que esperaba. */
  deLikida: boolean;
  cuerpo: string;
  interna: boolean;
  creadoEn: string;
}

export interface TicketDetalle {
  id: string;
  tenantId: string;
  asunto: string;
  descripcion: string | null;
  categoria: string;
  prioridad: string;
  estado: string;
  abiertoPor: string | null;
  asignadoA: string | null;
  asignadoNombre: string | null;
  abiertoEn: string;
  venceEn: string | null;
  resueltoEn: string | null;
}

const CAMPOS_TICKET =
  'id, tenant_id, asunto, descripcion, categoria, prioridad, estado, abierto_por, '
  + 'asignado_a, abierto_en, vence_en, resuelto_en, asignado:asignado_a(nombre)';

function mapearTicket(f: Record<string, unknown>): TicketDetalle {
  return {
    id: String(f.id),
    tenantId: String(f.tenant_id),
    asunto: String(f.asunto),
    descripcion: (f.descripcion as string | null) ?? null,
    categoria: String(f.categoria),
    prioridad: String(f.prioridad),
    estado: String(f.estado),
    abiertoPor: (f.abierto_por as string | null) ?? null,
    asignadoA: (f.asignado_a as string | null) ?? null,
    asignadoNombre: ((f.asignado as { nombre?: string | null } | null)?.nombre) ?? null,
    abiertoEn: String(f.abierto_en),
    venceEn: (f.vence_en as string | null) ?? null,
    resueltoEn: (f.resuelto_en as string | null) ?? null,
  };
}

/**
 * UN ticket, SIEMPRE anclado a su flota.
 *
 * `null` = ese id no existe DENTRO de ese tenant. Es a propósito la misma
 * respuesta que "no existe en ninguna parte": decirle a un admin de otra flota
 * "existe pero no es tuyo" ya le confirma que ese id es un ticket real de
 * alguien más.
 *
 * LANZA si la lectura falla — `null` significa "no está", nunca "no se pudo
 * mirar", que es la confusión con la que se cierra un ticket que sigue vivo.
 */
export async function getTicketDelTenant(ticketId: string, tenantId: string): Promise<TicketDetalle | null> {
  const { data, error } = await acotada(supabaseAdmin()
    .from('ticket_soporte')
    .select(CAMPOS_TICKET)
    .eq('id', ticketId)
    .eq('tenant_id', tenantId)
    .maybeSingle(), 'getTicketDelTenant');
  if (error) throw new Error(`getTicketDelTenant: ${error.message}`);
  if (!data) return null;
  // Doble casteo a propósito: con un embed (`asignado:asignado_a(nombre)`) el
  // tipo que supabase-js infiere para `.maybeSingle()` es una unión con
  // `GenericStringError`, que no solapa con un Record. `mapearTicket` lee campo
  // por campo y tolera lo que falte.
  return mapearTicket(data as unknown as Record<string, unknown>);
}

/** El ticket resuelto o el error de captura que se le enseña a quien lo pidió. */
async function exigirTicket(ticketId: string, tenantId: string): Promise<TicketDetalle> {
  const id = ticketId.trim();
  if (!id) throw new DatoInvalido('Falta decir de qué ticket se trata.');
  const t = await getTicketDelTenant(id, tenantId);
  if (!t) throw new DatoInvalido('Ese ticket no existe en esta flota.');
  return t;
}

/**
 * El hilo del ticket, en orden cronológico.
 *
 * `verInternas` NO tiene valor por omisión A PROPÓSITO. El default seguro
 * sería `false`, pero un default hace que la llamada del cliente y la del
 * equipo se escriban IGUAL — y entonces la diferencia entre enseñar y no
 * enseñar una nota interna deja de verse al leer el código. Aquí se declara
 * en cada llamada, y en la del panel del cliente se lee `verInternas: false`.
 *
 * Devuelve `null` cuando el ticket no es de esa flota: sin ticket no hay hilo,
 * y la comprobación va ANTES de tocar `ticket_mensaje` (que no tiene
 * `tenant_id` propio — su aislamiento es el de su ticket, igual que en RLS).
 */
export async function getHilo(
  ticketId: string,
  tenantId: string,
  opciones: { verInternas: boolean },
): Promise<MensajeHilo[] | null> {
  const ticket = await getTicketDelTenant(ticketId, tenantId);
  if (!ticket) return null;

  let consulta = supabaseAdmin()
    .from('ticket_mensaje')
    .select('id, autor_id, cuerpo, interna, creado_en, autor:autor_id(nombre, rol, tenant_id)')
    .eq('ticket_id', ticket.id);
  // EN LA CONSULTA, no en un `.filter()` de después: lo que no viaja no se
  // puede pintar por accidente el día que alguien agregue una vista nueva.
  if (!opciones.verInternas) consulta = consulta.eq('interna', false);

  const { data, error } = await acotada(
    consulta.order('creado_en', { ascending: true }).order('id').limit(TOPE_MENSAJES_HILO),
    'getHilo',
  );
  if (error) throw new Error(`getHilo: ${error.message}`);

  return (data ?? []).map((f): MensajeHilo => {
    const m = f as Record<string, unknown>;
    const autor = (m.autor as { nombre?: string | null; rol?: string | null } | null) ?? null;
    return {
      id: String(m.id),
      autorId: (m.autor_id as string | null) ?? null,
      autorNombre: autor?.nombre ?? null,
      deLikida: autor?.rol === 'superadmin',
      cuerpo: String(m.cuerpo),
      interna: m.interna === true,
      creadoEn: String(m.creado_en),
    };
  });
}

export interface ResultadoRespuesta {
  mensajeId: string;
  /** El estado en el que quedó el ticket. Puede no ser el que tenía: ver abajo. */
  estado: string;
  /** `true` si esta respuesta movió el ticket de 'abierto' a 'en_proceso'. */
  movioAEnProceso: boolean;
}

/**
 * Escribe un mensaje en el hilo.
 *
 * ── LO QUE APAGA LA ALARMA ────────────────────────────────────────────────
 * `agentes/exito.ts` cuenta como respuesta un mensaje con `interna = false` y
 * `autor_id` NO NULO y DISTINTO de `ticket_soporte.abierto_por`. Este escritor
 * firma SIEMPRE con el `userId` del actor (nunca null), así que:
 *
 *   · respuesta pública de Likida  → apaga la alarma. ✔
 *   · nota interna de Likida       → NO la apaga (es una nota, no una
 *                                     respuesta: el cliente no vio nada).
 *   · mensaje del propio solicitante ("¿alguna novedad?") → NO la apaga.
 *
 * Los tres comportamientos son los que el agente ya afirmaba en su parte; lo
 * único que faltaba era que alguien pudiera producirlos.
 *
 * ── EL ESTADO SE MUEVE SOLO EN UN CASO, Y SE DICE ─────────────────────────
 * Una respuesta PÚBLICA de Likida sobre un ticket que seguía en 'abierto' lo
 * pasa a 'en_proceso'. No es automatismo de más: 'abierto' significa que nadie
 * lo ha tocado, y después de contestarle al cliente esa etiqueta es falsa —
 * un rótulo tiene que ser verdad. Cualquier otro movimiento de estado es
 * explícito (`cambiarEstadoTicket`), y una NOTA INTERNA no mueve nada: nadie
 * de fuera se enteró.
 */
export async function responderTicket(
  ticketId: string,
  tenantId: string,
  actor: ActorSoporte,
  mensaje: { cuerpo: string; interna: boolean },
): Promise<ResultadoRespuesta> {
  const ticket = await exigirTicket(ticketId, tenantId);

  const cuerpo = mensaje.cuerpo.trim();
  if (!cuerpo) throw new DatoInvalido('El mensaje viene vacío: escribe qué le vas a decir.');
  if (cuerpo.length > LARGO_MAX_MENSAJE) {
    throw new DatoInvalido(`El mensaje no puede pasar de ${LARGO_MAX_MENSAJE} caracteres.`);
  }
  // La flota no fabrica notas "del equipo" en su propio hilo. Es la misma
  // regla que la policy de la 0268, dicha del lado que de verdad corre (el
  // producto consulta con service_role, que salta RLS).
  if (mensaje.interna && actor.tipo !== 'likida') {
    throw new DatoInvalido('Una nota interna solo la escribe el equipo de Likida.');
  }
  if (ESTADOS_TERMINALES.has(ticket.estado)) {
    throw new DatoInvalido('Ese ticket ya está cerrado. Reábrelo si hace falta seguir la conversación.');
  }

  const { data, error } = await acotada(supabaseAdmin().from('ticket_mensaje').insert({
    ticket_id: ticket.id,
    autor_id: actor.userId,
    cuerpo,
    interna: mensaje.interna,
  }).select('id').single(), 'responderTicket');
  if (error) throw new Error(`responderTicket: ${error.message}`);
  const mensajeId = (data as { id?: unknown } | null)?.id;
  if (!mensajeId) throw new Error('responderTicket: el insert no devolvió id');

  const movioAEnProceso = actor.tipo === 'likida' && !mensaje.interna && ticket.estado === 'abierto';
  if (movioAEnProceso) {
    const { error: errEstado } = await acotada(supabaseAdmin()
      .from('ticket_soporte')
      .update({ estado: 'en_proceso' })
      .eq('id', ticket.id)
      .eq('tenant_id', tenantId), 'responderTicket.enProceso');
    // NO se lanza: el mensaje YA quedó escrito y es lo que el cliente
    // necesitaba. Tirar la operación aquí borraría de la pantalla una
    // respuesta que sí existe en la base.
    if (errEstado) {
      return { mensajeId: String(mensajeId), estado: ticket.estado, movioAEnProceso: false };
    }
  }

  return {
    mensajeId: String(mensajeId),
    estado: movioAEnProceso ? 'en_proceso' : ticket.estado,
    movioAEnProceso,
  };
}

/**
 * Tomar el ticket: ponerle dueño.
 *
 * `estado='en_proceso'` decía que alguien lo estaba viendo y no decía quién —
 * y una cola donde tres personas creen que lo tiene otra es una cola donde
 * nadie contesta. `asignado_a` (0268) dice quién.
 *
 * Solo el equipo de Likida toma tickets: para el cliente el ticket ya es
 * suyo, y "asignárselo" no querría decir nada.
 */
export async function tomarTicket(
  ticketId: string,
  tenantId: string,
  actor: ActorSoporte,
): Promise<{ estado: string; asignadoA: string; anotado: boolean }> {
  if (actor.tipo !== 'likida') {
    throw new DatoInvalido('Tomar un ticket es del equipo de Likida: para tu flota el ticket ya es tuyo.');
  }
  const ticket = await exigirTicket(ticketId, tenantId);
  if (ESTADOS_TERMINALES.has(ticket.estado)) {
    throw new DatoInvalido('Ese ticket ya está cerrado: reábrelo antes de tomarlo.');
  }

  // 'abierto' significa "nadie lo ha tocado". Tomarlo lo vuelve falso.
  const estado = ticket.estado === 'abierto' ? 'en_proceso' : ticket.estado;
  // BE-B1 (auditoría 28): antes este UPDATE no anclaba el claim en el WHERE —
  // era el único claim del repo así (compárese `cerrarOrden` en
  // mantenimiento.ts, que ancla con `.neq('estado','cerrada')`, y
  // `reclamarIntentos` en facturacion/al_vuelo.ts, con `.is()`/`.or()`). Dos
  // superadmin que pulsan «Tomar» con milisegundos de diferencia recibían
  // AMBOS `{ asignadoA: <el suyo> }` y la base se quedaba con el segundo — la
  // pantalla del primero mentía. Decisión conservadora (la 0268 no dice nada
  // sobre "retomar" un ticket de OTRO): el UPDATE solo aplica si el ticket
  // está libre o YA es del mismo actor — reintentar tu propia toma no es un
  // error, pero quitárselo a otro en silencio si lo era.
  const { data, error } = await acotada(supabaseAdmin()
    .from('ticket_soporte')
    .update({ asignado_a: actor.userId, estado })
    .eq('id', ticket.id)
    .eq('tenant_id', tenantId)
    .or(`asignado_a.is.null,asignado_a.eq.${actor.userId}`)
    .select('id, asignado_a'), 'tomarTicket');
  if (error) throw new Error(`tomarTicket: ${error.message}`);
  const fila = (data ?? [])[0] as { id: string; asignado_a: string | null } | undefined;
  if (!fila) {
    // El WHERE no encontró fila: alguien más ganó la carrera entre la lectura
    // de arriba y este UPDATE. Se relee para decir QUIÉN en vez de afirmar un
    // éxito que no ocurrió — y la bitácora de abajo NO se anota, porque la
    // acción no aplicó.
    const actual = await getTicketDelTenant(ticket.id, tenantId);
    const quien = actual?.asignadoNombre ?? (actual?.asignadoA ? 'otra persona del equipo' : 'alguien más');
    throw new DatoInvalido(`No se pudo tomar: ya lo tiene ${quien}.`);
  }

  // `anotarBitacora` NUNCA lanza: la acción ya ocurrió y tirarla por no poder
  // anotarla deja el sistema peor que sin registro. Pero DEVUELVE si quedó
  // escrita, y ese booleano sube hasta la pantalla: decir "quedó en la
  // bitácora" sin haberlo comprobado es exactamente el tipo de rótulo que este
  // repo no se permite.
  const anotado = await anotarBitacora({
    tenantId,
    actor: { id: actor.userId },
    accion: 'ticket.tomado',
    entidad: 'ticket_soporte',
    entidadId: ticket.id,
    detalle: { estadoPrevio: ticket.estado, estado },
  }, { evento: 'soporte.bitacora_no_escribio' });

  return { estado, asignadoA: actor.userId, anotado };
}

/**
 * Mueve el ticket dentro del dominio de la 0051 — y mantiene `resuelto_en`
 * COHERENTE, que es lo que el constraint `ticket_cierre_coherente` exige.
 *
 * Entrar a un estado terminal escribe `resuelto_en = now()`; salir de él lo
 * vuelve NULL. Sin lo segundo, un ticket reabierto conservaría la fecha de un
 * cierre que ya no existe y el tiempo de respuesta se mediría contra ella —
 * el mismo modo de falla que la 0051 describió al crear el constraint.
 *
 * Quién puede: el equipo de Likida, cualquier estado del dominio. La flota,
 * SOLO cerrar el suyo ("ya quedó") o reabrirlo ("no quedó") — no puede
 * declarar 'en_proceso' ni 'esperando', que son afirmaciones sobre el trabajo
 * de Likida, no sobre lo que le pasa a ella.
 */
export async function cambiarEstadoTicket(
  ticketId: string,
  tenantId: string,
  actor: ActorSoporte,
  nuevo: string,
): Promise<{ estado: EstadoTicket; estadoPrevio: string; anotado: boolean }> {
  if (!(ESTADOS_TICKET as readonly string[]).includes(nuevo)) {
    throw new DatoInvalido('Ese estado no existe para un ticket.');
  }
  const estado = nuevo as EstadoTicket;
  if (actor.tipo === 'flota' && estado !== 'cerrado' && estado !== 'abierto') {
    throw new DatoInvalido('Desde tu panel puedes cerrar el ticket o volver a abrirlo; el resto lo mueve Likida.');
  }

  const ticket = await exigirTicket(ticketId, tenantId);
  if (ticket.estado === estado) {
    throw new DatoInvalido(`El ticket ya estaba en «${estado}»: no hay nada que cambiar.`);
  }

  const entraATerminal = ESTADOS_TERMINALES.has(estado);
  const { error } = await acotada(supabaseAdmin()
    .from('ticket_soporte')
    .update({
      estado,
      // Los dos lados del `⟺` del constraint, escritos a la vez que el estado.
      resuelto_en: entraATerminal ? new Date().toISOString() : null,
    })
    .eq('id', ticket.id)
    .eq('tenant_id', tenantId), 'cambiarEstadoTicket');
  if (error) throw new Error(`cambiarEstadoTicket: ${error.message}`);

  // Mismo criterio que `tomarTicket`: no lanza, pero SÍ dice si quedó escrita.
  const anotado = await anotarBitacora({
    tenantId,
    actor: { id: actor.userId },
    accion: `ticket.${estado}`,
    entidad: 'ticket_soporte',
    entidadId: ticket.id,
    detalle: { estadoPrevio: ticket.estado, estado, porLikida: actor.tipo === 'likida' },
  }, { evento: 'soporte.bitacora_no_escribio' });

  return { estado, estadoPrevio: ticket.estado, anotado };
}
