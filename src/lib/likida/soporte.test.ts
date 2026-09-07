import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// EL CICLO DEL TICKET — lo que la auditoría del 29-ago-2026 (H1) encontró
// que NADIE podía hacer, y las tres garantías que ahora lo sostienen:
//
//   1. AISLAMIENTO. Ninguna función cruza flotas: `tenant_id` va en la
//      consulta, y un ticket de otra flota no se lee NI se toca — la prueba
//      mira que no se haya emitido un solo insert/update tras el rechazo.
//   2. LA NOTA INTERNA. Se excluye EN LA CONSULTA cuando quien mira es el
//      cliente (no se trae y se esconde al pintar), y la flota no puede
//      escribir una.
//   3. LA ALARMA DEL AGENTE DE ÉXITO. El mensaje que este módulo escribe
//      satisface `cuentaComoRespuesta` de `agentes/exito.ts` cuando —y solo
//      cuando— debe. Esa condición era INSATISFACIBLE por construcción hasta
//      hoy: `ticket_mensaje` no tenía un solo escritor en todo `src/`.
//
// El mock registra la CADENA que se armó (tabla, operación, filtros, fila):
// es lo único que distingue "se acotó en la base" de "se acotó en memoria".
// ═══════════════════════════════════════════════════════════════════════════

type Resp = { data: unknown; error: { message: string } | null };
/** Respuesta por `tabla#operacion`. Sin entrada: `{ data: null, error: null }`. */
const respuestas = new Map<string, Resp>();

interface Llamada {
  tabla: string;
  op: 'select' | 'insert' | 'update';
  fila: Record<string, unknown> | null;
  eq: Array<[string, unknown]>;
  limite: number | null;
}
const llamadas: Llamada[] = [];

function crearBuilder(tabla: string) {
  const l: Llamada = { tabla, op: 'select', fila: null, eq: [], limite: null };
  llamadas.push(l);
  const resp = (): Resp => respuestas.get(`${tabla}#${l.op}`) ?? { data: null, error: null };
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: () => b,
    insert: (fila: Record<string, unknown>) => { l.op = 'insert'; l.fila = fila; return b; },
    update: (fila: Record<string, unknown>) => { l.op = 'update'; l.fila = fila; return b; },
    eq: (c: string, v: unknown) => { l.eq.push([c, v]); return b; },
    // BE-B1: el claim de `tomarTicket` ancla con `.or(asignado_a.is.null,…)`,
    // igual que `reclamarIntentos` en facturacion/al_vuelo.ts — no forma
    // parte del acotamiento por flota que `eq` existe para vigilar, así que
    // es un no-op que solo mantiene la cadena.
    or: () => b,
    order: () => b,
    limit: (n: number) => { l.limite = n; return b; },
    maybeSingle: () => b,
    single: () => b,
    then: (res: (x: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve().then(() => resp()).then(res, rej),
  });
  return b;
}

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: (t: string) => crearBuilder(t) }) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// La bitácora se mockea para que su propio insert no aparezca entre las
// llamadas que estas pruebas cuentan. Que se escriba se comprueba aparte.
const anotarBitacora = vi.fn(async () => true);
vi.mock('@/lib/likida/bitacora_escritura', () => ({ anotarBitacora: (...a: unknown[]) => anotarBitacora(...(a as [])) }));

const {
  getTicketDelTenant, getHilo, responderTicket, tomarTicket, cambiarEstadoTicket,
  ESTADOS_TICKET, LARGO_MAX_MENSAJE,
} = await import('./soporte');

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const ADMIN_LIKIDA = { tipo: 'likida' as const, userId: 'u-likida' };
const DUENO_FLOTA = { tipo: 'flota' as const, userId: 'u-flota' };

function ticketFila(over: Record<string, unknown> = {}) {
  return {
    id: 'tk-1', tenant_id: TENANT_A, asunto: 'No baja el PDF', descripcion: 'desde el martes',
    categoria: 'tecnico', prioridad: 'alta', estado: 'abierto', abierto_por: 'u-flota',
    asignado_a: null, abierto_en: '2026-08-28T12:00:00Z', vence_en: '2026-08-29T12:00:00Z',
    resuelto_en: null, asignado: null,
    ...over,
  };
}

/** Deja el ticket que la consulta de `ticket_soporte` va a devolver. */
function conTicket(over: Record<string, unknown> = {}) {
  respuestas.set('ticket_soporte#select', { data: ticketFila(over), error: null });
}

const escrituras = () => llamadas.filter((l) => l.op !== 'select');

beforeEach(() => {
  respuestas.clear();
  llamadas.length = 0;
  anotarBitacora.mockClear();
  respuestas.set('ticket_mensaje#insert', { data: { id: 'msj-1' }, error: null });
});

describe('AISLAMIENTO — el ticket de otra flota no se lee ni se toca', () => {
  it('getTicketDelTenant ancla el tenant EN LA CONSULTA, no en un filtro de JS', async () => {
    conTicket();
    await getTicketDelTenant('tk-1', TENANT_A);
    const l = llamadas.find((x) => x.tabla === 'ticket_soporte')!;
    expect(l.eq).toEqual([['id', 'tk-1'], ['tenant_id', TENANT_A]]);
  });

  // El escenario del encargo: el admin de la flota B teclea el id de un ticket
  // de la flota A. La consulta lleva su propio tenant, así que no devuelve
  // fila — y "no encontrarlo" es lo mismo que "no poder tocarlo".
  it('un admin de OTRA flota no lo encuentra: null, sin decir que existe', async () => {
    respuestas.set('ticket_soporte#select', { data: null, error: null });
    expect(await getTicketDelTenant('tk-1', TENANT_B)).toBeNull();
  });

  it('responder un ticket ajeno se rechaza y NO escribe una sola fila', async () => {
    respuestas.set('ticket_soporte#select', { data: null, error: null });
    await expect(responderTicket('tk-1', TENANT_B, ADMIN_LIKIDA, { cuerpo: 'hola', interna: false }))
      .rejects.toThrow(/no existe en esta flota/);
    expect(escrituras()).toEqual([]);
  });

  it('tomar y cerrar un ticket ajeno se rechazan y NO escriben una sola fila', async () => {
    respuestas.set('ticket_soporte#select', { data: null, error: null });
    await expect(tomarTicket('tk-1', TENANT_B, ADMIN_LIKIDA)).rejects.toThrow(/no existe en esta flota/);
    await expect(cambiarEstadoTicket('tk-1', TENANT_B, ADMIN_LIKIDA, 'cerrado')).rejects.toThrow(/no existe en esta flota/);
    expect(escrituras()).toEqual([]);
  });

  it('el hilo de un ticket ajeno es null y NI SIQUIERA se consulta ticket_mensaje', async () => {
    respuestas.set('ticket_soporte#select', { data: null, error: null });
    expect(await getHilo('tk-1', TENANT_B, { verInternas: true })).toBeNull();
    expect(llamadas.some((l) => l.tabla === 'ticket_mensaje')).toBe(false);
  });

  it('un fallo de lectura LANZA — "no se pudo mirar" nunca se lee como "no existe"', async () => {
    respuestas.set('ticket_soporte#select', { data: null, error: { message: 'fetch failed' } });
    await expect(getTicketDelTenant('tk-1', TENANT_A)).rejects.toThrow('fetch failed');
  });
});

describe('LA NOTA INTERNA — ni se lee ni se escribe desde el lado del cliente', () => {
  beforeEach(() => {
    conTicket();
    respuestas.set('ticket_mensaje#select', { data: [], error: null });
  });

  it('verInternas:false pone .eq(interna,false) EN LA CONSULTA', async () => {
    await getHilo('tk-1', TENANT_A, { verInternas: false });
    const l = llamadas.find((x) => x.tabla === 'ticket_mensaje')!;
    expect(l.eq).toEqual([['ticket_id', 'tk-1'], ['interna', false]]);
  });

  it('verInternas:true no lo pone — el equipo sí ve su propio lado del hilo', async () => {
    await getHilo('tk-1', TENANT_A, { verInternas: true });
    const l = llamadas.find((x) => x.tabla === 'ticket_mensaje')!;
    expect(l.eq).toEqual([['ticket_id', 'tk-1']]);
    expect(l.limite).toBe(200);
  });

  it('la flota NO puede escribir una nota interna, y no llega a insertar', async () => {
    await expect(responderTicket('tk-1', TENANT_A, DUENO_FLOTA, { cuerpo: 'ojo', interna: true }))
      .rejects.toThrow(/solo la escribe el equipo de Likida/);
    expect(escrituras()).toEqual([]);
  });

  it('el hilo distingue quién escribió: Likida (superadmin) o la flota', async () => {
    respuestas.set('ticket_mensaje#select', {
      data: [
        { id: 'm1', autor_id: 'u-flota', cuerpo: 'no baja', interna: false, creado_en: '2026-08-28T12:05:00Z', autor: { nombre: 'Ana', rol: 'flota_admin', tenant_id: TENANT_A } },
        { id: 'm2', autor_id: 'u-likida', cuerpo: 'ya vamos', interna: false, creado_en: '2026-08-28T13:00:00Z', autor: { nombre: 'Javier', rol: 'superadmin', tenant_id: null } },
        // La cuenta se dio de baja: la FK es `on delete set null`. Se pinta
        // "—", no se inventa un autor.
        { id: 'm3', autor_id: null, cuerpo: 'sistema', interna: true, creado_en: '2026-08-28T13:10:00Z', autor: null },
      ],
      error: null,
    });
    const h = (await getHilo('tk-1', TENANT_A, { verInternas: true }))!;
    expect(h.map((m) => [m.autorNombre, m.deLikida, m.interna])).toEqual([
      ['Ana', false, false], ['Javier', true, false], [null, false, true],
    ]);
  });
});

describe('responderTicket', () => {
  beforeEach(() => conTicket());

  // El escritor firma con el actor de la SESIÓN, nunca con un id que venga del
  // formulario. Es la primera red del hallazgo de Fable (29-ago-2026); la
  // segunda es el ancla `autor_id = (select auth.uid())` que la 0268 pone en la
  // policy de INSERT, demostrada en el bloque 217 de verificaciones.sql.
  it('firma el mensaje con el actor y guarda `interna` tal cual se pidió', async () => {
    await responderTicket('tk-1', TENANT_A, ADMIN_LIKIDA, { cuerpo: '  ya quedó  ', interna: false });
    const ins = llamadas.find((l) => l.op === 'insert' && l.tabla === 'ticket_mensaje')!;
    expect(ins.fila).toEqual({ ticket_id: 'tk-1', autor_id: 'u-likida', cuerpo: 'ya quedó', interna: false });
  });

  // 'abierto' significa "nadie lo ha tocado". Después de contestarle al
  // cliente esa etiqueta es falsa, y un rótulo tiene que ser verdad.
  it('la respuesta PÚBLICA de Likida mueve el ticket de abierto a en_proceso', async () => {
    const r = await responderTicket('tk-1', TENANT_A, ADMIN_LIKIDA, { cuerpo: 'vamos', interna: false });
    expect(r.movioAEnProceso).toBe(true);
    const upd = llamadas.find((l) => l.op === 'update')!;
    expect(upd.fila).toEqual({ estado: 'en_proceso' });
    expect(upd.eq).toEqual([['id', 'tk-1'], ['tenant_id', TENANT_A]]);
  });

  it('una NOTA INTERNA no mueve nada: nadie de fuera se enteró', async () => {
    const r = await responderTicket('tk-1', TENANT_A, ADMIN_LIKIDA, { cuerpo: 'ojo con esta flota', interna: true });
    expect(r.movioAEnProceso).toBe(false);
    expect(llamadas.some((l) => l.op === 'update')).toBe(false);
  });

  it('el mensaje del propio cliente tampoco lo mueve — insistir no es que lo atiendan', async () => {
    const r = await responderTicket('tk-1', TENANT_A, DUENO_FLOTA, { cuerpo: '¿alguna novedad?', interna: false });
    expect(r.movioAEnProceso).toBe(false);
    expect(llamadas.some((l) => l.op === 'update')).toBe(false);
  });

  it('sobre un ticket ya en_proceso no reescribe el estado', async () => {
    conTicket({ estado: 'en_proceso' });
    const r = await responderTicket('tk-1', TENANT_A, ADMIN_LIKIDA, { cuerpo: 'seguimos', interna: false });
    expect(r.estado).toBe('en_proceso');
    expect(llamadas.some((l) => l.op === 'update')).toBe(false);
  });

  it('un ticket cerrado no admite mensajes: primero se reabre', async () => {
    conTicket({ estado: 'cerrado', resuelto_en: '2026-08-28T20:00:00Z' });
    await expect(responderTicket('tk-1', TENANT_A, ADMIN_LIKIDA, { cuerpo: 'hola', interna: false }))
      .rejects.toThrow(/ya está cerrado/);
    expect(escrituras()).toEqual([]);
  });

  it('cuerpo vacío o pasado de largo se rechazan antes de insertar', async () => {
    await expect(responderTicket('tk-1', TENANT_A, ADMIN_LIKIDA, { cuerpo: '   ', interna: false }))
      .rejects.toThrow(/viene vacío/);
    await expect(responderTicket('tk-1', TENANT_A, ADMIN_LIKIDA, { cuerpo: 'x'.repeat(LARGO_MAX_MENSAJE + 1), interna: false }))
      .rejects.toThrow(new RegExp(`${LARGO_MAX_MENSAJE} caracteres`));
    expect(escrituras()).toEqual([]);
  });

  // El mensaje YA quedó escrito y es lo que el cliente necesitaba. Tirar la
  // operación aquí borraría de la pantalla una respuesta que sí existe.
  it('si el UPDATE de estado falla, la respuesta escrita NO se pierde', async () => {
    respuestas.set('ticket_soporte#update', { data: null, error: { message: 'conflicto' } });
    const r = await responderTicket('tk-1', TENANT_A, ADMIN_LIKIDA, { cuerpo: 'vamos', interna: false });
    expect(r.mensajeId).toBe('msj-1');
    expect(r.movioAEnProceso).toBe(false);
    expect(r.estado).toBe('abierto');
  });
});

describe('tomarTicket', () => {
  beforeEach(() => {
    conTicket();
    // BE-B1: el claim ahora exige `.select()` de vuelta para saber si el
    // WHERE aplicó. Por omisión simula que SÍ aplicó (la fila ganó el claim);
    // las pruebas de la carrera lo sobreescriben con `data: []`.
    respuestas.set('ticket_soporte#update', { data: [{ id: 'tk-1', asignado_a: 'u-likida' }], error: null });
  });

  it('le pone dueño y saca el ticket de «abierto»', async () => {
    const r = await tomarTicket('tk-1', TENANT_A, ADMIN_LIKIDA);
    expect(r).toEqual({ estado: 'en_proceso', asignadoA: 'u-likida', anotado: true });
    const upd = llamadas.find((l) => l.op === 'update')!;
    expect(upd.fila).toEqual({ asignado_a: 'u-likida', estado: 'en_proceso' });
    expect(upd.eq).toEqual([['id', 'tk-1'], ['tenant_id', TENANT_A]]);
  });

  it('sobre un ticket en «esperando» cambia el dueño y respeta el estado', async () => {
    conTicket({ estado: 'esperando' });
    const r = await tomarTicket('tk-1', TENANT_A, ADMIN_LIKIDA);
    expect(r.estado).toBe('esperando');
    expect(llamadas.find((l) => l.op === 'update')!.fila).toEqual({ asignado_a: 'u-likida', estado: 'esperando' });
  });

  it('la flota no toma tickets: el suyo ya es suyo', async () => {
    await expect(tomarTicket('tk-1', TENANT_A, DUENO_FLOTA)).rejects.toThrow(/equipo de Likida/);
    expect(escrituras()).toEqual([]);
  });

  it('un ticket cerrado se reabre antes de tomarse', async () => {
    conTicket({ estado: 'resuelto', resuelto_en: '2026-08-28T20:00:00Z' });
    await expect(tomarTicket('tk-1', TENANT_A, ADMIN_LIKIDA)).rejects.toThrow(/reábrelo antes de tomarlo/);
  });

  it('deja el acto en la bitácora — `asignado_a` guarda al dueño de HOY, no la secuencia', async () => {
    await tomarTicket('tk-1', TENANT_A, ADMIN_LIKIDA);
    expect(anotarBitacora).toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'ticket.tomado', entidad: 'ticket_soporte', entidadId: 'tk-1', tenantId: TENANT_A }),
      expect.anything(),
    );
  });

  // La bitácora es best-effort A PROPÓSITO (la acción ya ocurrió; tirarla por
  // no poder anotarla deja el sistema peor). Pero el resultado SUBE: la
  // pantalla decía "Quedó en la bitácora" sin haberlo comprobado nunca.
  it('si la bitácora no se pudo escribir, la operación sigue y lo DICE (anotado:false)', async () => {
    anotarBitacora.mockResolvedValueOnce(false);
    const r = await tomarTicket('tk-1', TENANT_A, ADMIN_LIKIDA);
    expect(r.asignadoA).toBe('u-likida');
    expect(r.anotado).toBe(false);
  });

  // BE-B1: el escenario del hallazgo — dos superadmin pulsan «Tomar» con
  // milisegundos de diferencia. El WHERE (`.or(asignado_a.is.null,…)`) lo
  // decide la base, no la lectura de arriba: el segundo en LLEGAR AL UPDATE
  // (no el segundo en pedir el ticket) no encuentra fila que actualizar.
  it('el claim ancla en el WHERE del UPDATE, no solo en `eq`', async () => {
    await tomarTicket('tk-1', TENANT_A, ADMIN_LIKIDA);
    const upd = llamadas.find((l) => l.op === 'update')!;
    expect(upd.eq).toEqual([['id', 'tk-1'], ['tenant_id', TENANT_A]]);
  });

  it('doble tomarTicket concurrente: el que pierde la carrera del UPDATE NO reporta éxito y NO anota bitácora', async () => {
    // El ticket YA está tomado por otra persona para cuando este UPDATE
    // corre de verdad en la base (la lectura de `exigirTicket` es anterior a
    // la carrera y no lo sabe todavía) — el WHERE no encuentra fila.
    conTicket({ asignado_a: 'u-otro-admin', asignado: { nombre: 'Ana Pérez' } });
    respuestas.set('ticket_soporte#update', { data: [], error: null });
    await expect(tomarTicket('tk-1', TENANT_A, ADMIN_LIKIDA)).rejects.toThrow(/ya lo tiene Ana Pérez/);
    expect(anotarBitacora).not.toHaveBeenCalled();
  });

  it('retomar tu PROPIO ticket (reintento) sí aplica — no es la carrera que se bloquea', async () => {
    conTicket({ asignado_a: 'u-likida' });
    respuestas.set('ticket_soporte#update', { data: [{ id: 'tk-1', asignado_a: 'u-likida' }], error: null });
    const r = await tomarTicket('tk-1', TENANT_A, ADMIN_LIKIDA);
    expect(r.asignadoA).toBe('u-likida');
  });
});

describe('cambiarEstadoTicket — `resuelto_en` coherente con el estado (0051)', () => {
  beforeEach(() => conTicket());

  it('entrar a un estado terminal escribe la fecha de resolución', async () => {
    await cambiarEstadoTicket('tk-1', TENANT_A, ADMIN_LIKIDA, 'cerrado');
    const upd = llamadas.find((l) => l.op === 'update')!;
    expect(upd.fila!.estado).toBe('cerrado');
    expect(typeof upd.fila!.resuelto_en).toBe('string');
  });

  // Sin esto, un ticket reabierto conservaría la fecha de un cierre que ya no
  // existe y el tiempo de respuesta se mediría contra ella.
  it('reabrir la BORRA — no se deja una resolución que ya no ocurrió', async () => {
    conTicket({ estado: 'cerrado', resuelto_en: '2026-08-28T20:00:00Z' });
    await cambiarEstadoTicket('tk-1', TENANT_A, ADMIN_LIKIDA, 'abierto');
    expect(llamadas.find((l) => l.op === 'update')!.fila).toEqual({ estado: 'abierto', resuelto_en: null });
  });

  it('la flota solo cierra o reabre; «en proceso» y «esperando» los declara Likida', async () => {
    await expect(cambiarEstadoTicket('tk-1', TENANT_A, DUENO_FLOTA, 'esperando')).rejects.toThrow(/lo mueve Likida/);
    await expect(cambiarEstadoTicket('tk-1', TENANT_A, DUENO_FLOTA, 'en_proceso')).rejects.toThrow(/lo mueve Likida/);
    expect(escrituras()).toEqual([]);
    await cambiarEstadoTicket('tk-1', TENANT_A, DUENO_FLOTA, 'cerrado');
    expect(llamadas.find((l) => l.op === 'update')!.fila!.estado).toBe('cerrado');
  });

  it('un estado fuera del dominio de la 0051 se rechaza', async () => {
    await expect(cambiarEstadoTicket('tk-1', TENANT_A, ADMIN_LIKIDA, 'archivado')).rejects.toThrow(/no existe para un ticket/);
    expect(escrituras()).toEqual([]);
  });

  it('mover al estado en el que ya estaba se dice, no se hace en silencio', async () => {
    await expect(cambiarEstadoTicket('tk-1', TENANT_A, ADMIN_LIKIDA, 'abierto')).rejects.toThrow(/ya estaba en «abierto»/);
    expect(escrituras()).toEqual([]);
  });

  it('el dominio expuesto es exactamente el de la 0051', () => {
    expect([...ESTADOS_TICKET]).toEqual(['abierto', 'en_proceso', 'esperando', 'resuelto', 'cerrado']);
  });
});
