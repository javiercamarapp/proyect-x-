import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// EL CRON QUE DRENA LA BANDEJA DEL APAGADO — el contrato completo del P1:
//  · sin secreto no corre; apagado NO drena (la pausa sigue) y lo dice;
//  · encendido: reclama, procesa por el motor real, sella;
//  · un evento que falla anota su error, NO se sella, y el cron sale 500;
//  · el claim perdido (otra corrida lo tomó) no procesa ni cuenta;
//  · las cartas muertas se gritan al operador.
// ═══════════════════════════════════════════════════════════════════════════

const processInbound = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
vi.mock('@/lib/likida/processor', () => ({ processInbound: (...a: unknown[]) => processInbound(...a) }));

const estaApagado = vi.fn(async () => false);
/** AUDITORÍA 18 (A17): el cron lee `leerInterruptor`, que distingue apagado
 *  de ILEGIBLE. `estaApagado` sigue siendo la palanca de las pruebas viejas. */
let ilegible = false;
vi.mock('@/lib/likida/interruptores', () => ({
  leerInterruptor: async () => (ilegible ? 'ilegible' : (await estaApagado()) ? 'apagado' : 'encendido'),
}));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger }));
vi.mock('@/lib/observability/sentry', () => ({ codigoDeError: () => 'x' }));
const alertarOperador = vi.fn(async () => {});
vi.mock('@/lib/observability/alerta', () => ({ alertarOperador: (...a: unknown[]) => alertarOperador(...(a as [])) }));

const urgentesVencidas = vi.fn(async (..._a: unknown[]) => 0);
vi.mock('@/lib/likida/agentes/cola', () => ({ urgentesVencidas: (...a: unknown[]) => urgentesVencidas(...a) }));

const pendientesPorDrenar = vi.fn(async (): Promise<Array<{ id: string; intentos: number; remitente: string; tipo?: string }>> => []);
const reclamarPendiente = vi.fn(async (id: string, intentos: number): Promise<{ id: string; evento: object; intentos: number } | null> =>
  ({ id, evento: { from: '521999', type: 'text', waMessageId: id }, intentos: intentos + 1 }));
const marcarPendienteProcesado = vi.fn(async () => {});
const anotarFalloPendiente = vi.fn(async () => {});
const devolverIntentoPendiente = vi.fn(async () => {});
const cartasMuertas = vi.fn(async () => 0);
const iniciarCadenaWa = vi.fn(async () => '11111111-1111-4111-8111-111111111111' as string | null);
const renovarCadenaWa = vi.fn(async () => true);
const finalizarCadenaWa = vi.fn(async () => true);
vi.mock('@/lib/likida/wa_pendientes', () => ({
  crearLeaseOwner: () => 'wa-cron:test',
  iniciarRenovacionLease: () => () => {},
  pendientesPorDrenar: (...a: unknown[]) => pendientesPorDrenar(...(a as [])),
  reclamarPendiente: (...a: unknown[]) => reclamarPendiente(...(a as [string, number])),
  marcarPendienteProcesado: (...a: unknown[]) => marcarPendienteProcesado(...(a as [])),
  anotarFalloPendiente: (...a: unknown[]) => anotarFalloPendiente(...(a as [])),
  devolverIntentoPendiente: (...a: unknown[]) => devolverIntentoPendiente(...(a as [])),
  cartasMuertas: (...a: unknown[]) => cartasMuertas(...(a as [])),
  iniciarCadenaWa: (...a: unknown[]) => iniciarCadenaWa(...(a as [])),
  renovarCadenaWa: (...a: unknown[]) => renovarCadenaWa(...(a as [])),
  finalizarCadenaWa: (...a: unknown[]) => finalizarCadenaWa(...(a as [])),
}));

// QStash (ESC-1): se mira la PUBLICACIÓN, no la red de Upstash.
const publishJSON = vi.fn(async () => ({ messageId: 'msg-1' }));
vi.mock('@upstash/qstash', () => ({
  Client: class { publishJSON = (...a: unknown[]) => publishJSON(...(a as [])); },
}));
// El latido (RES-7) vive en su propio archivo de pruebas.
const registrarLatido = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => {}));
vi.mock('@/lib/admin/salud', () => ({
  registrarLatido: (...a: unknown[]) => registrarLatido(...a),
  puertaCron: async (_c: string, req: Request) =>
    req.headers.get('authorization') === 'Bearer secreto-de-prueba'
      ? null
      : new Response(null, { status: 401 }),
}));

process.env.CRON_SECRET = 'secreto-de-prueba';
const { GET } = await import('./route');
const { LOTE } = await import('./drenado');
const peticion = (auth?: string) => new Request('http://likida.test/api/cron/wa-pendientes', {
  headers: auth ? { authorization: auth } : {},
});

beforeEach(() => {
  vi.clearAllMocks();
  publishJSON.mockResolvedValue({ messageId: 'msg-1' });
  urgentesVencidas.mockResolvedValue(0);
  estaApagado.mockResolvedValue(false);
  ilegible = false;
  pendientesPorDrenar.mockResolvedValue([]);
  cartasMuertas.mockResolvedValue(0);
  iniciarCadenaWa.mockResolvedValue('11111111-1111-4111-8111-111111111111');
  renovarCadenaWa.mockResolvedValue(true);
  finalizarCadenaWa.mockResolvedValue(true);
  processInbound.mockImplementation(async () => {});
  reclamarPendiente.mockImplementation(async (id: string, intentos: number) =>
    ({ id, evento: { from: '521999', type: 'text', waMessageId: id }, intentos: intentos + 1 }));
});

describe('la puerta y la pausa', () => {
  it('sin el secreto: 401 y ni una lectura', async () => {
    const r = await GET(peticion('Bearer equivocado'));
    expect(r.status).toBe(401);
    expect(pendientesPorDrenar).not.toHaveBeenCalled();
  });

  it('APAGADO: la bandeja espera — ese ES el contrato nuevo, y responde 200 con saltado', async () => {
    estaApagado.mockResolvedValue(true);
    const r = await GET(peticion('Bearer secreto-de-prueba'));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ saltado: 'interruptor global' });
    expect(pendientesPorDrenar).not.toHaveBeenCalled();
  });

  it('ILEGIBLE: la bandeja tampoco se drena, pero la corrida sale 500 con `codigo` (A17)', async () => {
    // Cada 5 minutos en 200 `saltado` con un `logger.info` que ni llega a
    // Sentry era la receta para una bandeja sin drenar y un panel en verde.
    ilegible = true;
    const r = await GET(peticion('Bearer secreto-de-prueba'));
    expect(r.status).toBe(500);
    expect(await r.json()).toMatchObject({ corrio: false, codigo: 'interruptor_ilegible', interruptor: 'global' });
    expect(pendientesPorDrenar).not.toHaveBeenCalled();
  });
});

describe('el drenado', () => {
  it('encendido: reclama, procesa por el motor y sella cada evento', async () => {
    pendientesPorDrenar.mockResolvedValue([{ id: 'wamid.1', intentos: 0, remitente: '521999' }, { id: 'wamid.2', intentos: 0, remitente: '521999' }]);
    const r = await GET(peticion('Bearer secreto-de-prueba'));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ corrio: true, procesados: 2, fallidos: 0 });
    expect(processInbound).toHaveBeenCalledTimes(2);
    expect(marcarPendienteProcesado).toHaveBeenCalledTimes(2);
  });

  it('un evento que falla anota su error, NO se sella, y el cron sale 500 — nunca verde con fallos', async () => {
    pendientesPorDrenar.mockResolvedValue([{ id: 'wamid.mal', intentos: 2, remitente: '521999' }]);
    processInbound.mockRejectedValue(new Error('OCR reventó'));
    const r = await GET(peticion('Bearer secreto-de-prueba'));
    expect(r.status).toBe(500);
    expect(marcarPendienteProcesado).not.toHaveBeenCalled();
    expect(anotarFalloPendiente).toHaveBeenCalledWith('wamid.mal', 'OCR reventó');
  });

  // AUDITORÍA 18 (A3/A27): el cron sellaba ante CUALQUIER retorno sin
  // excepción — incluido el 'duplicado' de un claim huérfano y los abandonos.
  it('"duplicado" (ya completado antes) SÍ se sella: el trabajo está hecho', async () => {
    pendientesPorDrenar.mockResolvedValue([{ id: 'wamid.dup', intentos: 1, remitente: '521999' }]);
    processInbound.mockResolvedValue('duplicado' as never);
    const r = await GET(peticion('Bearer secreto-de-prueba'));
    expect(r.status).toBe(200);
    expect(marcarPendienteProcesado).toHaveBeenCalledWith('wamid.dup');
  });

  it.each(['reintentable', 'en_curso'])('"%s" NO se sella: queda pendiente con su motivo, y el cron sigue en 200', async (resultado) => {
    pendientesPorDrenar.mockResolvedValue([{ id: 'wamid.pos', intentos: 1, remitente: '521999' }]);
    processInbound.mockResolvedValue(resultado as never);
    const r = await GET(peticion('Bearer secreto-de-prueba'));
    expect(r.status).toBe(200);
    expect(marcarPendienteProcesado).not.toHaveBeenCalled();
    expect(anotarFalloPendiente).toHaveBeenCalledWith('wamid.pos', `pospuesto: ${resultado}`);
    expect(await r.json()).toMatchObject({ procesados: 0, fallidos: 0, pospuestos: 1 });
  });

  // ESC-1: quedarse sin presupuesto no es un intento fallido — el mensaje ni
  // se miró. Contarlo convertía en carta muerta, a las cinco corridas
  // cargadas, la foto de un chofer que nadie llegó a procesar.
  it('"sin_tiempo" DEVUELVE el intento: no se sella, no se anota fallo, y el cron sigue en 200', async () => {
    pendientesPorDrenar.mockResolvedValue([{ id: 'wamid.pos', intentos: 1, remitente: '521999' }]);
    processInbound.mockResolvedValue('sin_tiempo' as never);
    const r = await GET(peticion('Bearer secreto-de-prueba'));
    expect(r.status).toBe(200);
    expect(marcarPendienteProcesado).not.toHaveBeenCalled();
    expect(anotarFalloPendiente).not.toHaveBeenCalled();
    // El claim reclamó con intentos+1; se devuelve ANCLADO a ese valor.
    expect(devolverIntentoPendiente).toHaveBeenCalledWith('wamid.pos', 2);
    expect(await r.json()).toMatchObject({ procesados: 0, fallidos: 0, pospuestos: 1 });
  });

  // AUDITORÍA 24, BE-14: la vuelta entera pospuesta latía `ok` y la bandeja
  // crecía minuto a minuto con /api/health en verde.
  it('BE-14: si TODO se pospuso por falta de presupuesto, el latido es `parcial`, no `ok`', async () => {
    registrarLatido.mockClear();
    pendientesPorDrenar.mockResolvedValue([
      { id: 'wamid.a', intentos: 1, remitente: '521999' },
      { id: 'wamid.b', intentos: 1, remitente: '521998' },
    ]);
    processInbound.mockResolvedValue('sin_tiempo' as never);
    const r = await GET(peticion('Bearer secreto-de-prueba'));
    expect(r.status).toBe(200);
    expect(registrarLatido).toHaveBeenCalledWith('wa-pendientes', 'parcial', expect.objectContaining({ procesados: 0, fallidos: 0, pospuestos: 2 }));
  });

  // ESC-1: cada chofer es una cadena en serie; choferes distintos, en paralelo.
  it('paraleliza POR CHOFER y conserva el orden dentro de cada conversación', async () => {
    pendientesPorDrenar.mockResolvedValue([
      { id: 'a1', intentos: 0, remitente: '521111' },
      { id: 'b1', intentos: 0, remitente: '522222' },
      { id: 'a2', intentos: 0, remitente: '521111' },
    ]);
    const orden: string[] = [];
    processInbound.mockImplementation(async (evento: unknown) => {
      const id = (evento as { waMessageId: string }).waMessageId;
      orden.push(`inicia:${id}`);
      await new Promise((r) => setTimeout(r, id === 'a1' ? 20 : 1));
      orden.push(`termina:${id}`);
    });
    const r = await GET(peticion('Bearer secreto-de-prueba'));
    expect(r.status).toBe(200);
    // a2 espera a que a1 termine (misma persona)…
    expect(orden.indexOf('inicia:a2')).toBeGreaterThan(orden.indexOf('termina:a1'));
    // …y b1 no espera a a1 (persona distinta).
    expect(orden.indexOf('inicia:b1')).toBeLessThan(orden.indexOf('termina:a1'));
  });

  it('con el lote LLENO encola otra vuelta en QStash; con lote corto, no', async () => {
    process.env.UPSTASH_QSTASH_TOKEN = 'qstash-de-prueba';
    pendientesPorDrenar.mockResolvedValue(
      Array.from({ length: LOTE }, (_, i) => ({ id: `w${i}`, intentos: 0, remitente: `52${i}` })),
    );
    const r = await GET(peticion('Bearer secreto-de-prueba'));
    expect(await r.json()).toMatchObject({ encolado: 'msg-1' });
    expect(publishJSON).toHaveBeenCalledWith(expect.objectContaining({
      url: expect.stringContaining('/api/cron/wa-pendientes/cola'),
      body: { vuelta: 1, cadenaId: '11111111-1111-4111-8111-111111111111' },
      deduplicationId: 'wa-pendientes-11111111-1111-4111-8111-111111111111-1',
    }));

    publishJSON.mockClear();
    pendientesPorDrenar
      .mockResolvedValueOnce([{ id: 'w0', intentos: 0, remitente: '521' }])
      .mockResolvedValueOnce([]);
    await GET(peticion('Bearer secreto-de-prueba'));
    expect(publishJSON).not.toHaveBeenCalled();
    delete process.env.UPSTASH_QSTASH_TOKEN;
  });

  it('un perdedor que vio 40 filas pero ganó CERO claims no publica sucesor', async () => {
    process.env.UPSTASH_QSTASH_TOKEN = 'qstash-de-prueba';
    pendientesPorDrenar.mockResolvedValue(
      Array.from({ length: LOTE }, (_, i) => ({ id: `ocupado-${i}`, intentos: 0, remitente: `52${i}` })),
    );
    reclamarPendiente.mockResolvedValue(null);

    const r = await GET(peticion('Bearer secreto-de-prueba'));

    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ reclamados: 0, backlogDespues: false });
    expect(publishJSON).not.toHaveBeenCalled();
    // Una lectura inicial: sin claims ganados ni siquiera vuelve a sondear el
    // backlog, que pertenece al worker ganador.
    expect(pendientesPorDrenar).toHaveBeenCalledTimes(1);
    delete process.env.UPSTASH_QSTASH_TOKEN;
  });

  it('sin token mide backlog real y declara que continuará por cron, no false', async () => {
    delete process.env.UPSTASH_QSTASH_TOKEN;
    pendientesPorDrenar
      .mockResolvedValueOnce([{ id: 'w0', intentos: 0, remitente: '521' }])
      .mockResolvedValueOnce([{ id: 'w1', intentos: 0, remitente: '522' }]);

    const r = await GET(peticion('Bearer secreto-de-prueba'));

    expect(await r.json()).toMatchObject({
      reclamados: 1,
      backlogDespues: true,
      continuacion: 'cron',
    });
  });

  it('el tope de generación conserva backlog=true, alerta y no finge que terminó', async () => {
    process.env.UPSTASH_QSTASH_TOKEN = 'qstash-de-prueba';
    pendientesPorDrenar
      .mockResolvedValueOnce([{ id: 'w0', intentos: 0, remitente: '521' }])
      .mockResolvedValueOnce([{ id: 'w1', intentos: 0, remitente: '522' }]);
    const { drenarBandeja, MAX_VUELTAS_QSTASH } = await import('./drenado');

    const r = await drenarBandeja(Date.now(), peticion('Bearer secreto-de-prueba'), MAX_VUELTAS_QSTASH, '11111111-1111-4111-8111-111111111111');

    expect(r).toMatchObject({ backlogDespues: true, continuacion: 'tope' });
    expect(publishJSON).not.toHaveBeenCalled();
    expect(alertarOperador).toHaveBeenCalledWith('cron.wa_pendientes', expect.objectContaining({ codigo: 'tope_cadena_con_backlog' }));
    delete process.env.UPSTASH_QSTASH_TOKEN;
  });

  it('un callback con fence vencido no lista ni procesa mensajes', async () => {
    renovarCadenaWa.mockResolvedValue(false);
    const { drenarBandeja } = await import('./drenado');
    const r = await drenarBandeja(Date.now(), peticion('Bearer secreto-de-prueba'), 3, '11111111-1111-4111-8111-111111111111');
    expect(r.continuacion).toBe('cadena_obsoleta');
    expect(pendientesPorDrenar).not.toHaveBeenCalled();
    expect(processInbound).not.toHaveBeenCalled();
  });

  it('dos crons de minutos distintos no abren dos fan-outs si una cadena sigue activa', async () => {
    process.env.UPSTASH_QSTASH_TOKEN = 'qstash-de-prueba';
    iniciarCadenaWa
      .mockResolvedValueOnce('11111111-1111-4111-8111-111111111111')
      .mockResolvedValueOnce(null);
    pendientesPorDrenar.mockResolvedValue([{ id: 'w0', intentos: 0, remitente: '521' }]);

    const primera = await GET(peticion('Bearer secreto-de-prueba'));
    const segunda = await GET(peticion('Bearer secreto-de-prueba'));

    expect((await primera.json()).continuacion).toBe('encolada');
    expect((await segunda.json()).continuacion).toBe('cadena_activa');
    expect(publishJSON).toHaveBeenCalledTimes(1);
    delete process.env.UPSTASH_QSTASH_TOKEN;
  });

  it('un QStash caído NO tumba el drenado: el cron del minuto siguiente es el reintento', async () => {
    process.env.UPSTASH_QSTASH_TOKEN = 'qstash-de-prueba';
    publishJSON.mockRejectedValueOnce(new Error('QStash 503'));
    pendientesPorDrenar.mockResolvedValue(
      Array.from({ length: LOTE }, (_, i) => ({ id: `w${i}`, intentos: 0, remitente: `52${i}` })),
    );
    const r = await GET(peticion('Bearer secreto-de-prueba'));
    expect(r.status).toBe(200);
    expect(await r.json()).not.toHaveProperty('encolado');
    delete process.env.UPSTASH_QSTASH_TOKEN;
  });

  it('un publish aceptado pero con timeout conserva el fence: el cron solapado no abre otra cadena', async () => {
    process.env.UPSTASH_QSTASH_TOKEN = 'qstash-de-prueba';
    // QStash sí pudo aceptar la publicación, pero el cliente perdió la
    // respuesta. Desde este lado es indistinguible de un rechazo real.
    publishJSON.mockRejectedValueOnce(new Error('timeout después de aceptar'));
    iniciarCadenaWa
      .mockResolvedValueOnce('11111111-1111-4111-8111-111111111111')
      .mockResolvedValueOnce(null);
    pendientesPorDrenar.mockResolvedValue([{ id: 'w0', intentos: 0, remitente: '521' }]);

    const primera = await GET(peticion('Bearer secreto-de-prueba'));
    const segunda = await GET(peticion('Bearer secreto-de-prueba'));

    expect((await primera.json()).continuacion).toBe('publicacion_fallida');
    expect((await segunda.json()).continuacion).toBe('cadena_activa');
    expect(publishJSON).toHaveBeenCalledTimes(1);
    // El lease queda vivo durante la ventana ambigua. Si la publicación sí
    // llegó, su callback conserva el único fence; si no llegó, otro cron sólo
    // recupera al vencer el lease.
    expect(finalizarCadenaWa).not.toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    delete process.env.UPSTASH_QSTASH_TOKEN;
  });

  it('le pasa al motor el inicio de ESTA invocación, para que los 10 del lote compartan reloj (C4)', async () => {
    pendientesPorDrenar.mockResolvedValue([{ id: 'wamid.1', intentos: 0, remitente: '521999' }]);
    const antes = Date.now();
    await GET(peticion('Bearer secreto-de-prueba'));
    const opts = processInbound.mock.calls[0][1] as { inicioInvocacionMs: number };
    expect(opts.inicioInvocacionMs).toBeGreaterThanOrEqual(antes);
    expect(opts.inicioInvocacionMs).toBeLessThanOrEqual(Date.now());
  });

  // AGEN-19C2-1 (corrección tras auditoría Fable-5 post-merge PR #72): el
  // drenado también arma `hayFotoAntesEnCadena`/`hayFotoDespuesEnCadena` a
  // partir de `tipo` (mig. 0194) — sin esto, un fajo de fotos recuperado por
  // el cron (en vez de procesado en vivo) seguía produciendo un acuse por
  // foto en vez del resumen consolidado.
  it('arma hayFotoAntesEnCadena/hayFotoDespuesEnCadena por chofer usando `tipo`, contando SOLO fotos', async () => {
    pendientesPorDrenar.mockResolvedValue([
      { id: 'f1', intentos: 0, remitente: '521999', tipo: 'image' },
      { id: 'f2', intentos: 0, remitente: '521999', tipo: 'image' },
      { id: 'listo', intentos: 0, remitente: '521999', tipo: 'text' },
    ]);
    reclamarPendiente.mockImplementation(async (id: string, intentos: number) =>
      ({ id, evento: { from: '521999', type: 'text', waMessageId: id }, intentos: intentos + 1 }));
    const r = await GET(peticion('Bearer secreto-de-prueba'));
    expect(r.status).toBe(200);

    const opts = processInbound.mock.calls.map((c) => c[1] as { hayFotoAntesEnCadena: boolean; hayFotoDespuesEnCadena: boolean });
    expect(opts).toEqual([
      { hayFotoAntesEnCadena: false, hayFotoDespuesEnCadena: true, inicioInvocacionMs: expect.any(Number) },
      { hayFotoAntesEnCadena: true, hayFotoDespuesEnCadena: false, inicioInvocacionMs: expect.any(Number) },
      // El "listo" (no-foto) no cambia la cuenta: ninguna foto queda DESPUÉS
      // de él, y SÍ hay fotos antes.
      { hayFotoAntesEnCadena: true, hayFotoDespuesEnCadena: false, inicioInvocacionMs: expect.any(Number) },
    ]);
  });

  it('el claim perdido (otra corrida lo tomó) no procesa ni cuenta como fallo', async () => {
    pendientesPorDrenar.mockResolvedValue([{ id: 'wamid.ajeno', intentos: 0, remitente: '521999' }]);
    reclamarPendiente.mockResolvedValue(null);
    const r = await GET(peticion('Bearer secreto-de-prueba'));
    expect(r.status).toBe(200);
    expect(processInbound).not.toHaveBeenCalled();
    expect(await r.json()).toMatchObject({ procesados: 0, fallidos: 0 });
  });

  it('un claim perdido corta ESA conversación: nunca adelanta el mensaje siguiente del mismo chofer', async () => {
    pendientesPorDrenar.mockResolvedValue([
      { id: 'a1', intentos: 0, remitente: '521111' },
      { id: 'a2', intentos: 0, remitente: '521111' },
    ]);
    reclamarPendiente.mockImplementation(async (id: string, intentos: number) =>
      id === 'a1'
        ? null
        : { id, evento: { from: '521111', type: 'text', waMessageId: id }, intentos: intentos + 1 });

    const r = await GET(peticion('Bearer secreto-de-prueba'));

    expect(r.status).toBe(200);
    expect(reclamarPendiente).toHaveBeenCalledTimes(1);
    expect(reclamarPendiente).toHaveBeenCalledWith('a1', 0, 'wa-cron:test');
    expect(processInbound).not.toHaveBeenCalled();
    expect(marcarPendienteProcesado).not.toHaveBeenCalled();
  });

  it('el monitor de SLA grita las urgentes vencidas — incluso con el sistema APAGADO', async () => {
    estaApagado.mockResolvedValue(true);
    urgentesVencidas.mockResolvedValue(2);
    await GET(peticion('Bearer secreto-de-prueba'));
    expect(alertarOperador).toHaveBeenCalledWith('aprobaciones.urgentes', expect.objectContaining({ codigo: 'sla_urgente' }));
  });

  it('el monitor de SLA caído NO tumba el drenado — se grita y se sigue', async () => {
    urgentesVencidas.mockRejectedValue(new Error('db down'));
    pendientesPorDrenar.mockResolvedValue([{ id: 'wamid.1', intentos: 0, remitente: '521999' }]);
    const r = await GET(peticion('Bearer secreto-de-prueba'));
    expect(r.status).toBe(200);
    expect(processInbound).toHaveBeenCalledTimes(1);
  });

  it('las cartas muertas se GRITAN al operador', async () => {
    cartasMuertas.mockResolvedValue(3);
    const r = await GET(peticion('Bearer secreto-de-prueba'));
    expect(r.status).toBe(200);
    expect(alertarOperador).toHaveBeenCalledWith('cron.wa_pendientes', expect.objectContaining({ codigo: 'cartas_muertas' }));
    expect(registrarLatido).toHaveBeenCalledWith('wa-pendientes', 'parcial', expect.objectContaining({ cartasMuertas: 3 }));
  });
});
