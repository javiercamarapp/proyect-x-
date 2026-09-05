import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// EL CRON DE MANTENIMIENTO — no tenía pruebas y BORRA FILAS: era el único de
// los tres crons cuyo contrato (fallar cerrado sin secreto, error por valor
// de la RPC = 500, no un verde vacío) vivía solo en comentarios. Se fijan
// aquí junto con el cable nuevo del kill switch (0110): en un incidente donde
// Javier apaga todo, lo último que quiere es un cron borrando datos mientras
// investiga.
// ═══════════════════════════════════════════════════════════════════════════

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger }));

const alertarOperador = vi.fn(async () => {});
vi.mock('@/lib/observability/alerta', () => ({
  alertarOperador: (...a: unknown[]) => alertarOperador(...(a as [])),
}));

const registrarLatido = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@/lib/admin/salud', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin/salud')>()),
  registrarLatido: (...a: unknown[]) => registrarLatido(...a),
}));

/** Lo que contesta la RPC `mantenimiento_de_datos`. */
let rpcRespuesta: { data: unknown; error: { message: string; code?: string } | null };
/** Lo que contesta la RPC hermana `mantener_producto_evento` (0259). */
let rpcProductoRespuesta: { data: unknown; error: { message: string; code?: string } | null };
/** Lo que contesta la RPC hermana `mantener_mcp_oauth` (0265). */
let rpcMcpOauthRespuesta: { data: unknown; error: { message: string; code?: string } | null };
type RespuestaRpc = { data: unknown; error: { message: string; code?: string } | null };
let rpcConversacionRespuestas: RespuestaRpc[];
let rpcCodigoRespuestas: RespuestaRpc[];
let rpcConversacionDefault: RespuestaRpc;
let rpcCodigoDefault: RespuestaRpc;
const rpc = vi.fn(async (nombre?: unknown) => {
  if (nombre === 'mantener_producto_evento') return rpcProductoRespuesta;
  if (nombre === 'mantener_mcp_oauth') return rpcMcpOauthRespuesta;
  if (nombre === 'purgar_wa_conversacion') return rpcConversacionRespuestas.shift() ?? rpcConversacionDefault;
  if (nombre === 'purgar_codigo_pendiente') return rpcCodigoRespuestas.shift() ?? rpcCodigoDefault;
  return rpcRespuesta;
});
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ rpc: (...a: unknown[]) => rpc(...(a as [])) }),
}));
/** Solo las llamadas a la RPC de borrado principal — el ciclo de vueltas se
 *  cuenta sobre ELLA; la hermana de producto_evento corre una vez al final. */
const llamadasMantenimiento = () => rpc.mock.calls.filter((c) => c[0] === 'mantenimiento_de_datos').length;
const llamadasPurga = (nombre: string) => rpc.mock.calls.filter((c) => c[0] === nombre).length;

// El kill switch (0110). Default: sin fila = encendido (false).
const estaApagado = vi.fn(async (nombre: string) => nombre === '__ninguno_apagado__');
/** AUDITORÍA 18 (A17): los crons leen `leerInterruptor`, que distingue
 *  apagado de ILEGIBLE. `estaApagado` sigue siendo la palanca de las pruebas
 *  viejas (true = apagado); `ilegibles` marca qué lecturas fallan. */
const ilegibles = new Set<string>();
vi.mock('@/lib/likida/interruptores', () => ({
  leerInterruptor: async (nombre: string) =>
    ilegibles.has(nombre) ? 'ilegible' : (await estaApagado(nombre)) ? 'apagado' : 'encendido',
}));

process.env.CRON_SECRET = 'secreto-de-prueba';
const { GET } = await import('./route');

const peticion = (auth?: string) => new Request('http://likida.test/api/cron/purgar', {
  headers: auth ? { authorization: auth } : {},
}) as never;

beforeEach(() => {
  rpcRespuesta = { data: {
    waPurgados: 3,
    llmCostoPurgado: false,
    conversacionesPurgadas: 0,
    codigosPurgados: 0,
    conversacionesParcial: false,
    codigosParcial: false,
    otrasPurgasParcial: false,
    parcial: false,
  }, error: null };
  rpcProductoRespuesta = { data: { mesesConsolidados: 0, detalleBorrado: 0, parcial: false }, error: null };
  rpcMcpOauthRespuesta = { data: { tokensBorrados: 0, codigosBorrados: 0, clientesBorrados: 0, parcial: false }, error: null };
  rpcConversacionRespuestas = [];
  rpcCodigoRespuestas = [];
  rpcConversacionDefault = { data: { borradas: 0, parcial: false, agotado: true }, error: null };
  rpcCodigoDefault = { data: { borradas: 0, parcial: false, agotado: true }, error: null };
  rpc.mockClear();
  alertarOperador.mockClear();
  registrarLatido.mockClear();
  estaApagado.mockReset().mockResolvedValue(false);
  ilegibles.clear();
  for (const f of Object.values(logger)) f.mockReset();
});

describe('GET /api/cron/purgar — la puerta', () => {
  it('sin CRON_SECRET devuelve 500 y NO borra: un 200 dejaría el cron verde para siempre', async () => {
    const antes = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    const res = await GET(peticion());
    process.env.CRON_SECRET = antes;

    expect(res.status).toBe(500);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('con el bearer equivocado, 401 sin cuerpo y sin tocar nada', async () => {
    const res = await GET(peticion('Bearer otro'));
    expect(res.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
    // Ni el interruptor se lee antes de la puerta.
    expect(estaApagado).not.toHaveBeenCalled();
  });
});
describe('la corrida', () => {
  it('con la base sana responde 200 y el detalle de la RPC tal cual', async () => {
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    const cuerpo = await res.json();

    expect(res.status).toBe(200);
    // `storage` entró el 23-ago con el borrador de la cola de Storage: la purga
    // MARCA archivos (Supabase no deja borrarlos desde SQL) y este paso los
    // borra por la API. Se compara por campos y no con `toEqual` entero para
    // que añadir un dato nuevo al informe no rompa esta prueba por su forma.
    expect(cuerpo).toMatchObject({ corrio: true, waPurgados: 3, llmCostoPurgado: false, vueltas: 1 });
    expect(cuerpo).toHaveProperty('storage');
    // 0259: el mantenimiento de producto_evento corre en la misma vuelta y su
    // detalle viaja en el cuerpo — una tabla sin techo no se mantiene a
    // ciegas.
    expect(cuerpo).toMatchObject({ productoEvento: { mesesConsolidados: 0, detalleBorrado: 0, parcial: false } });
    // 0265: el mantenimiento de MCP OAuth (tokens/códigos/clientes DCR) corre
    // en la misma vuelta, misma razón que producto_evento.
    expect(cuerpo).toMatchObject({ mcpOauth: { tokensBorrados: 0, codigosBorrados: 0, clientesBorrados: 0, parcial: false } });
    expect(rpc).toHaveBeenCalledWith('mantenimiento_de_datos', { p_dias_wa: 30 });
    expect(rpc).toHaveBeenCalledWith('mantener_producto_evento', expect.objectContaining({
      p_dias: 92,
      p_ahora: expect.any(String),
      p_vence: expect.any(String),
    }));
    expect(rpc).toHaveBeenCalledWith('mantener_mcp_oauth');
    expect(llamadasPurga('purgar_wa_conversacion')).toBe(0);
    expect(llamadasPurga('purgar_codigo_pendiente')).toBe(0);
    expect(cuerpo).toMatchObject({ estado: 'ok', parcial: false });
  });

  it('si la RPC de mcp_oauth falla, la corrida NO se cae — pero se alerta y el cuerpo dice null, no un 0 inventado', async () => {
    rpcMcpOauthRespuesta = { data: null, error: { message: 'no existe', code: '42883' } };
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    const cuerpo = await res.json();

    expect(res.status).toBe(200);
    expect(cuerpo.corrio).toBe(true);
    expect(cuerpo.mcpOauth).toBeNull();
    expect(alertarOperador).toHaveBeenCalledWith('cron.purgar.mcp_oauth', expect.objectContaining({ error: 'no existe' }));
  });

  it('si producto_evento falla, responde 500, late fallo y conserva la causa', async () => {
    rpcProductoRespuesta = { data: null, error: { message: 'no existe', code: '42883' } };
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    const cuerpo = await res.json();

    expect(res.status).toBe(500);
    expect(cuerpo.corrio).toBe(true);
    expect(cuerpo.productoEvento).toBeNull();
    expect(cuerpo).toMatchObject({ estado: 'fallo', productoEventoError: '42883: no existe' });
    expect(alertarOperador).toHaveBeenCalledWith('cron.purgar.producto_evento', expect.objectContaining({ error: 'no existe' }));
    expect(registrarLatido).toHaveBeenLastCalledWith('purgar', 'fallo', expect.objectContaining({
      productoEventoError: '42883: no existe',
    }));
  });

  it('si producto_evento queda parcial, el estado y latido globales también son parciales', async () => {
    rpcProductoRespuesta = { data: { mesesConsolidados: 1, detalleBorrado: 7, parcial: true, agotado: false }, error: null };
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    const cuerpo = await res.json();

    expect(res.status).toBe(200);
    expect(cuerpo).toMatchObject({ estado: 'parcial', parcial: true, productoEvento: { parcial: true } });
    expect(registrarLatido).toHaveBeenLastCalledWith('purgar', 'parcial', expect.objectContaining({
      productoEventoParcial: true,
    }));
  });

  // ESC-16: la purga borra en tandas y devuelve `parcial` cuando no alcanzó.
  // Antes era UN delete sin tandas bajo maxDuration=120: la primera corrida
  // sobre una tabla grande moría a la mitad, con el lock puesto.
  it('si la RPC vuelve `parcial`, el cron REPITE hasta agotar sus vueltas', async () => {
    rpcRespuesta = { data: { waPurgados: 50000, parcial: true }, error: null };
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    const cuerpo = await res.json();

    expect(res.status).toBe(200);
    // Tres vueltas es el techo duro: lo que no cupo lo levanta mañana.
    expect(llamadasMantenimiento()).toBe(3);
    expect(cuerpo).toMatchObject({ corrio: true, parcial: true, vueltas: 3 });
  });

  it('una corrida completa NO repite: `parcial` false corta en la primera vuelta', async () => {
    rpcRespuesta = { data: { waPurgados: 12, parcial: false }, error: null };
    await GET(peticion('Bearer secreto-de-prueba'));
    expect(llamadasMantenimiento()).toBe(1);
  });

  it('drena cada purga 0104 en RPCs separadas hasta `agotado`, sumando la cardinalidad', async () => {
    rpcRespuesta = { data: {
      conversacionesPurgadas: 5000,
      codigosPurgados: 5000,
      conversacionesParcial: true,
      codigosParcial: true,
      otrasPurgasParcial: false,
      parcial: true,
    }, error: null };
    rpcConversacionRespuestas = [
      { data: { borradas: 5000, parcial: true, agotado: false }, error: null },
      { data: { borradas: 5000, parcial: true, agotado: false }, error: null },
      { data: { borradas: 37, parcial: false, agotado: true }, error: null },
    ];
    rpcCodigoRespuestas = [
      { data: { borradas: 81, parcial: false, agotado: true }, error: null },
    ];

    const res = await GET(peticion('Bearer secreto-de-prueba'));
    const cuerpo = await res.json();

    expect(res.status).toBe(200);
    expect(cuerpo.retencion0104.conversaciones).toMatchObject({
      borradas: 25037, lotes: 6, borradasMantenimiento: 15000, lotesMantenimiento: 3,
      borradasDrenaje: 10037, lotesDrenaje: 3, parcial: false, agotado: true, error: null,
    });
    expect(cuerpo.retencion0104.codigos).toMatchObject({
      borradas: 15081, lotes: 4, borradasMantenimiento: 15000, lotesMantenimiento: 3,
      borradasDrenaje: 81, lotesDrenaje: 1, parcial: false, agotado: true, error: null,
    });
    expect(cuerpo).toMatchObject({ estado: 'ok', parcial: false, erroresRetencion0104: [] });
    expect(llamadasPurga('purgar_wa_conversacion')).toBe(3);
    expect(llamadasPurga('purgar_codigo_pendiente')).toBe(1);
    expect(rpc).toHaveBeenCalledWith('purgar_wa_conversacion', expect.objectContaining({
      p_dias: 180,
      p_ahora: expect.any(String),
      p_vence: expect.any(String),
    }));
  });

  it('corta una purga que siempre vuelve parcial al techo de 20 lotes', async () => {
    rpcRespuesta = { data: {
      conversacionesPurgadas: 5000,
      codigosPurgados: 0,
      conversacionesParcial: true,
      codigosParcial: false,
      otrasPurgasParcial: false,
      parcial: true,
    }, error: null };
    rpcConversacionDefault = { data: { borradas: 5000, parcial: true, agotado: false }, error: null };

    const res = await GET(peticion('Bearer secreto-de-prueba'));
    const cuerpo = await res.json();

    expect(res.status).toBe(200);
    expect(llamadasPurga('purgar_wa_conversacion')).toBe(20);
    expect(cuerpo.retencion0104.conversaciones).toMatchObject({
      borradas: 115000,
      lotes: 23,
      borradasDrenaje: 100000,
      lotesDrenaje: 20,
      parcial: true,
      agotado: false,
    });
    expect(cuerpo).toMatchObject({ estado: 'parcial', parcial: true });
    expect(registrarLatido).toHaveBeenLastCalledWith('purgar', 'parcial', expect.objectContaining({ parcial: true }));
  });

  it('si el deadline no deja iniciar el drenaje, responde y late parcial — nunca ok falso', async () => {
    rpcRespuesta = { data: {
      conversacionesPurgadas: 5000,
      codigosPurgados: 0,
      conversacionesParcial: true,
      codigosParcial: false,
      otrasPurgasParcial: false,
      parcial: false,
    }, error: null };
    const reloj = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValue(106_001);
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    reloj.mockRestore();
    const cuerpo = await res.json();

    expect(llamadasPurga('purgar_wa_conversacion')).toBe(0);
    expect(cuerpo).toMatchObject({ estado: 'parcial', parcial: true });
    expect(cuerpo.retencion0104.conversaciones).toMatchObject({ lotesDrenaje: 0, parcial: true, agotado: false });
    expect(registrarLatido).toHaveBeenLastCalledWith('purgar', 'parcial', expect.objectContaining({ parcial: true }));
  });

  it('si una RPC 0104 falla, el estado y latido globales son fallo con causa observable', async () => {
    rpcRespuesta = { data: {
      conversacionesPurgadas: 5000,
      codigosPurgados: 0,
      conversacionesParcial: true,
      codigosParcial: false,
      otrasPurgasParcial: false,
      parcial: false,
    }, error: null };
    rpcConversacionDefault = { data: null, error: { message: 'timeout 0104', code: '57014' } };

    const res = await GET(peticion('Bearer secreto-de-prueba'));
    const cuerpo = await res.json();
    expect(res.status).toBe(500);
    expect(cuerpo).toMatchObject({ estado: 'fallo', parcial: true });
    expect(cuerpo.erroresRetencion0104).toEqual(['wa_conversacion: timeout 0104']);
    expect(alertarOperador).toHaveBeenCalledWith('cron.purgar.retencion_0104', expect.objectContaining({
      nombre: 'purgar_wa_conversacion',
      error: 'timeout 0104',
    }));
    expect(registrarLatido).toHaveBeenLastCalledWith('purgar', 'fallo', expect.objectContaining({
      parcial: true,
      erroresRetencion0104: ['wa_conversacion: timeout 0104'],
    }));
  });

  it('si 0104 falla dentro de mantenimiento, no se confunde con agotada: drena y conserva la causa', async () => {
    rpcRespuesta = { data: {
      conversacionesPurgadas: 0,
      codigosPurgados: 0,
      conversacionesParcial: true,
      codigosParcial: false,
      conversacionesError: '57014: canceling statement due to statement timeout',
      codigosError: null,
      otrasPurgasParcial: true,
      fallos: ['wa_conversacion: canceling statement due to statement timeout'],
      parcial: true,
    }, error: null };
    rpcConversacionRespuestas = [
      { data: { borradas: 19, parcial: false, agotado: true }, error: null },
    ];

    const res = await GET(peticion('Bearer secreto-de-prueba'));
    const cuerpo = await res.json();

    expect(res.status).toBe(500);
    expect(llamadasPurga('purgar_wa_conversacion')).toBe(1);
    expect(cuerpo.retencion0104.conversaciones).toMatchObject({
      borradasDrenaje: 19,
      agotado: true,
      errorMantenimiento: '57014: canceling statement due to statement timeout',
    });
    expect(cuerpo.erroresRetencion0104).toContain(
      'wa_conversacion (mantenimiento): 57014: canceling statement due to statement timeout',
    );
    expect(alertarOperador).toHaveBeenCalledWith('cron.purgar.purgas_con_fallos', expect.objectContaining({
      fallos: expect.stringContaining('wa_conversacion'),
    }));
    expect(registrarLatido).toHaveBeenLastCalledWith('purgar', 'fallo', expect.objectContaining({
      erroresRetencion0104: expect.arrayContaining([
        'wa_conversacion (mantenimiento): 57014: canceling statement due to statement timeout',
      ]),
    }));
  });

  it('un error POR VALOR de la RPC es 500 con alerta — no una purga verde que "no encontró nada"', async () => {
    rpcRespuesta = { data: null, error: { message: 'relation does not exist', code: '42P01' } };
    const res = await GET(peticion('Bearer secreto-de-prueba'));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('relation does not exist');
    expect(alertarOperador).toHaveBeenCalledWith('cron.purgar', expect.objectContaining({ codigo: expect.any(String) }));
  });
});

describe('el kill switch (0110)', () => {
  it("con 'global' apagado: 200 con {saltado} y la RPC de borrado NI SE LLAMA", async () => {
    estaApagado.mockResolvedValue(true);
    const res = await GET(peticion('Bearer secreto-de-prueba'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ corrio: false, saltado: 'interruptor global' });
    expect(rpc).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('cron.purgar.saltado', { interruptor: 'global' });
  });

  it("con 'global' ILEGIBLE: 500 con `codigo` y la RPC de borrado NI SE LLAMA (A17)", async () => {
    // Fail-closed sigue (no se borra), pero ya no en verde: no saber si está
    // apagado es un fallo de la corrida, no una decisión de Javier.
    ilegibles.add('global');
    const res = await GET(peticion('Bearer secreto-de-prueba'));

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ corrio: false, codigo: 'interruptor_ilegible', interruptor: 'global' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('sin fila (el default) la purga corre — solo se consulta la palanca global', async () => {
    await GET(peticion('Bearer secreto-de-prueba'));
    expect(estaApagado.mock.calls.map((c) => c[0])).toEqual(['global']);
    expect(llamadasMantenimiento()).toBe(1);
  });
});
