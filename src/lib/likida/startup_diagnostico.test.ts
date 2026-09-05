import { describe, it, expect, vi, beforeEach } from 'vitest';

// EL FALLO QUE ESTO FIJA — leído en los logs de producción del 28-jul-2026.
//
//   [error] startup.migraciones
//   "FALTA la migración 0005 (try_lock_viaje / unique(viaje_id)):
//    la protección de doble liquidación NO está activa."
//   err: "TypeError: fetch failed"
//
// Las cuatro migraciones estaban aplicadas. Se comprobó llamando a los RPC
// directamente contra Supabase: `try_lock_viaje` → true, `intake_delta` → 0,
// `enriquecer_gasto_codigo` → false, `codigo_pendiente` → 200.
//
// El chequeo trataba CUALQUIER error como "falta la migración", incluido un
// fallo de red. Eso convierte el aviso que protege el dinero —doble
// liquidación— en uno que se aprende a ignorar.

const rpc = vi.fn();
const from = vi.fn();
const metodoTabla = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ rpc, from }) }));

const error = vi.fn();
const warn = vi.fn();
const info = vi.fn();
vi.mock('@/lib/logger', () => ({ logger: { error: (...a: unknown[]) => error(...a), warn: (...a: unknown[]) => warn(...a), info: (...a: unknown[]) => info(...a) } }));

const { verificarMigracionesCriticas } = await import('./startup');

// Stub encadenable: el sondeo de la 0016 usa `.select().limit()` y el de la 0019
// `.select().not().limit()`. Un stub que solo soporta una de las dos cadenas hace
// que la otra lance, el `catch` general se lo trague como `migraciones_skip`, y
// las pruebas midan cualquier cosa menos lo que dicen medir.
const tabla = (resultado: { error: unknown; data?: unknown } = { error: null }) => {
  const enlace: Record<string, unknown> = {};
  for (const m of ['select', 'not', 'eq', 'limit', 'insert', 'delete']) {
    enlace[m] = () => { metodoTabla(m); return enlace; };
  }
  // `await` sobre el enlace resuelve al resultado (igual que el query builder real).
  enlace.then = (r: (v: unknown) => unknown) => Promise.resolve(resultado).then(r);
  return enlace;
};
// El probe del mutex (0005) ahora lee un viaje REAL primero: el UUID de ceros
// choca con la FK viaje_lock→viaje (migración 0075) y daba falso positivo.
const okTabla = tabla({ data: [{ id: 'viaje-real-1' }], error: null });

beforeEach(() => {
  rpc.mockReset(); from.mockReset(); metodoTabla.mockReset(); error.mockReset(); warn.mockReset(); info.mockReset();
  from.mockReturnValue(okTabla);
});

describe('diagnóstico de migraciones', () => {
  it('un fallo de RED no se reporta como migración faltante', async () => {
    // Así lo entrega supabase-js: sin código, con el TypeError envuelto.
    rpc.mockResolvedValue({ error: { code: '', message: 'TypeError: fetch failed' } });
    await verificarMigracionesCriticas();

    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('startup.migraciones_sin_verificar', expect.anything());
    const [, meta] = warn.mock.calls[0] as [string, { msg: string }];
    expect(meta.msg).toContain('NO se pudo verificar');
    expect(meta.msg).not.toContain('FALTA');
  });

  it('si falta el lector catalogal 0326 SÍ se reporta como error', async () => {
    // PostgREST contesta con código cuando la función no existe: hubo respuesta.
    rpc.mockImplementation(async (nombre: string) => (nombre === 'garantias_arranque_faltantes'
      ? { error: { code: 'PGRST202', message: 'Could not find the function public.garantias_arranque_faltantes' } }
      : { data: [], error: null }));
    await verificarMigracionesCriticas();

    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('startup.migraciones', expect.objectContaining({ code: 'PGRST202' }));
    const mensajes = error.mock.calls.map((c) => (c[1] as { msg: string }).msg).join(' | ');
    expect(mensajes).toContain('0326');
  });

  it('con todo aplicado, dice que está bien y no grita', async () => {
    rpc.mockResolvedValue({ error: null });
    await verificarMigracionesCriticas();

    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('startup.migraciones', { ok: true });
  });

  it('el arranque no invoca ninguna RPC de negocio ni escribe filas', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await verificarMigracionesCriticas();

    const invocadas = rpc.mock.calls.map((c) => c[0] as string);
    expect(invocadas).toContain('garantias_arranque_faltantes');
    expect(invocadas).toEqual(expect.arrayContaining(['indices_faltantes', 'triggers_faltantes']));
    expect(invocadas).not.toEqual(expect.arrayContaining([
      'try_lock_viaje', 'unlock_viaje', 'intake_delta',
      'enriquecer_gasto_codigo', 'confirmar_aviso_privacidad',
      'liberar_aviso_privacidad', 'guardar_liquidacion_tx',
    ]));
    expect(metodoTabla).not.toHaveBeenCalledWith('insert');
    expect(metodoTabla).not.toHaveBeenCalledWith('delete');
  });

  // El límite: un error CON código, aunque el mensaje suene a red, es una
  // respuesta de la base. No se puede perder por parecerse a un fallo de red.
  it('un error con código nunca se degrada a "no se pudo verificar"', async () => {
    rpc.mockResolvedValue({ error: { code: '42883', message: 'function does not exist (socket)' } });
    await verificarMigracionesCriticas();

    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it('si un sondeo LANZA, registra diagnóstico inconcluso y nunca dice ok', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    from.mockImplementation((nombre: string) => {
      if (nombre === 'codigo_pendiente') throw new Error('query builder roto');
      return okTabla;
    });

    await verificarMigracionesCriticas();

    expect(warn).toHaveBeenCalledWith('startup.migraciones_sondeo_fallo', {
      err: 'query builder roto',
    });
    expect(info).not.toHaveBeenCalledWith('startup.migraciones', { ok: true });
  });
});

// CRÍTICO de la auditoría 5 (modelo de datos): la migración 0022 estaba aplicada
// en producción y NO existía en el repo — `git log --all --diff-filter=A` sobre
// `supabase/migrations/0022*` sale vacío. Cualquier `supabase db push` sobre un
// proyecto limpio nace con las dos firmas de `guardar_liquidacion_tx` y ninguna
// liquidación cierra. Y este chequeo no la sondeaba: decía `ok: true`.
describe('la sobrecarga ambigua de guardar_liquidacion_tx', () => {
  it('con DOS firmas vivas, el arranque lo grita en vez de decir ok', async () => {
    rpc.mockImplementation(async (nombre: string) => (nombre === 'garantias_arranque_faltantes'
      ? { data: ['0022:guardar_liquidacion_tx'], error: null }
      : { data: [], error: null }));
    await verificarMigracionesCriticas();

    expect(info).not.toHaveBeenCalledWith('startup.migraciones', { ok: true });
    expect(error).toHaveBeenCalledWith('startup.migraciones', expect.anything());
    const [, meta] = error.mock.calls[0] as [string, { msg: string }];
    expect(meta.msg).toContain('0022');
    expect(meta.msg).toContain('NINGUNA liquidación puede cerrar');
  });

  it('una firma exacta no se confunde con una sobrecarga', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await verificarMigracionesCriticas();
    expect(info).toHaveBeenCalledWith('startup.migraciones', { ok: true });
  });
});

// ALTO de la auditoría 5 (operabilidad): el arranque salía al PRIMER fallo, así
// que con dos migraciones ausentes solo se veía UNA por ciclo de despliegue: se
// arreglaba, se volvía a desplegar, y aparecía la siguiente. Y la 0019 no se
// sondeaba: sin `uq_gasto_cfdi_uuid` el mismo CFDI de diésel entra dos veces, se
// cuenta doble en el comprobado y su IVA se acredita por duplicado.
describe('el arranque dice TODO lo que falta, no lo primero', () => {
  it('con dos migraciones ausentes, reporta las dos', async () => {
    rpc.mockImplementation(async (nombre: string) => (nombre === 'garantias_arranque_faltantes'
      ? { data: ['0005:try_lock_viaje', '0011:intake_delta'], error: null }
      : { data: [], error: null }));
    await verificarMigracionesCriticas();

    const mensajes = error.mock.calls.map((c) => (c[1] as { msg: string }).msg).join(' | ');
    expect(mensajes).toContain('0005');
    expect(mensajes).toContain('0011');
  });

  it('con algo faltando NO dice ok', async () => {
    rpc.mockResolvedValue({ error: { code: 'PGRST202', message: 'nada existe' } });
    await verificarMigracionesCriticas();
    expect(info).not.toHaveBeenCalledWith('startup.migraciones', { ok: true });
  });

  // REESCRITA EN LA AUDITORÍA 6. Antes esta prueba pasaba haciendo fallar la
  // TABLA `gasto` entera, que es un fallo de otra cosa. El sondeo real
  // —`select cfdi_uuid ... limit 1`— no podía detectar la ausencia del ÍNDICE:
  // `cfdi_uuid` es una columna de `0001_init.sql` y la consulta responde igual
  // de bien sin la 0019. La prueba verde daba por cubierto lo que no lo estaba.
  it('el índice de la 0019 se sonda contra el catálogo, no contra la columna', async () => {
    rpc.mockResolvedValue({ data: ['uq_gasto_cfdi_uuid'], error: null });
    await verificarMigracionesCriticas();

    const mensajes = error.mock.calls.map((c) => (c[1] as { msg: string }).msg).join(' | ');
    expect(mensajes).toContain('uq_gasto_cfdi_uuid');
    expect(mensajes).toContain('mismo CFDI se liquida dos veces');
  });

  it('y el de la 0024, que evita cargarle el gasto a quien no fue', async () => {
    rpc.mockResolvedValue({ data: ['uq_operador_telefono_activo'], error: null });
    await verificarMigracionesCriticas();
    expect(error.mock.calls.map((c) => (c[1] as { msg: string }).msg).join(' | '))
      .toContain('uq_operador_telefono_activo');
  });

  it('si falta la función que los sonda, se dice ESO y no "falta la 0019"', async () => {
    // La distinción que costó un diagnóstico falso en producción: "no pude
    // preguntar" no es "no está".
    rpc.mockResolvedValue({ error: { code: 'PGRST202', message: 'Could not find the function public.indices_faltantes' } });
    await verificarMigracionesCriticas();
    const mensajes = error.mock.calls.map((c) => (c[1] as { msg: string }).msg).join(' | ');
    expect(mensajes).toContain('0030');
  });

  it('con todos los índices puestos no inventa un faltante', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await verificarMigracionesCriticas();
    expect(info).toHaveBeenCalledWith('startup.migraciones', { ok: true });
  });
});

// AUDITORÍA 9, CRÍTICO (operabilidad) — "0036/0037, el trigger que blinda el
// peor bug histórico del camino del dinero, y ninguna línea de este archivo
// lo sondeaba." PostgREST no expone `pg_trigger`, así que el sondeo pasa por
// `triggers_faltantes` (migración 0043), mismo patrón que `indices_faltantes`.
describe('los triggers de "nada entra ni se reescribe tras liquidar" (0036/0037)', () => {
  it('si el trigger de INSERT falta, lo dice con la migración y la consecuencia', async () => {
    rpc.mockResolvedValue({ data: ['trg_gasto_no_tras_liquidar'], error: null });
    await verificarMigracionesCriticas();

    const mensajes = error.mock.calls.map((c) => (c[1] as { msg: string }).msg).join(' | ');
    expect(mensajes).toContain('trg_gasto_no_tras_liquidar');
    expect(mensajes).toContain('0036');
    expect(mensajes).toContain('cifras contrarias');
  });

  it('si el trigger de UPDATE falta, lo dice con las dos migraciones que lo escribieron', async () => {
    rpc.mockResolvedValue({ data: ['trg_gasto_no_tras_liquidar_update'], error: null });
    await verificarMigracionesCriticas();

    const mensajes = error.mock.calls.map((c) => (c[1] as { msg: string }).msg).join(' | ');
    expect(mensajes).toContain('trg_gasto_no_tras_liquidar_update');
    expect(mensajes).toContain('0037');
    expect(mensajes).toContain('0042');
  });

  it('con algo faltando NO dice ok, ni siquiera si el resto de migraciones están', async () => {
    rpc.mockResolvedValue({ data: ['trg_gasto_no_tras_liquidar'], error: null });
    await verificarMigracionesCriticas();
    expect(info).not.toHaveBeenCalledWith('startup.migraciones', { ok: true });
  });

  it('si falta la función que los sonda, se dice ESO y no "falta el trigger"', async () => {
    // Misma distinción que ya existe para índices: "no pude preguntar" no es
    // "no está" — un diagnóstico falso manda a correr `db push` contra un
    // problema que no existe.
    rpc.mockResolvedValue({ error: { code: 'PGRST202', message: 'Could not find the function public.triggers_faltantes' } });
    await verificarMigracionesCriticas();
    const mensajes = error.mock.calls.map((c) => (c[1] as { msg: string }).msg).join(' | ');
    expect(mensajes).toContain('0043');
  });

  it('con los dos triggers puestos no inventa un faltante', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await verificarMigracionesCriticas();
    expect(info).toHaveBeenCalledWith('startup.migraciones', { ok: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RONDA 7 · EL CONTADOR DE LA BARRERA NO SABÍA OLVIDAR (migración 0031).
//
// La 0011 dejó un contador puro: `+1` al entrar la foto, `-1` en el `finally`
// del OCR. Un `finally` no corre cuando el proceso no vuelve, y la función del
// webhook tiene `maxDuration = 120`: si Vercel la mata por tope, por memoria o
// por un despliegue a media ráfaga, el `+1` queda y el `-1` no llega nunca.
//
// A partir de ahí ese viaje queda averiado PARA SIEMPRE: cada "listo" espera los
// 20s completos de la barrera y termina avisándole al operador que se cuadró con
// gastos parciales sobre una liquidación que estaba entera. El aviso que existe
// para advertir de dinero perdido se vuelve permanente y falso justo en el viaje
// que ya sufrió una caída — el mejor sitio para enseñar a ignorarlo.
// ═══════════════════════════════════════════════════════════════════════════
describe('el TTL del contador de la barrera (0031)', () => {
  /** `from` por tabla: el sondeo de la 0031 lee `viaje`, el de la 0016 `codigo_pendiente`. */
  const porTabla = (mapa: Record<string, { error: unknown }>) =>
    from.mockImplementation((t: string) => tabla(mapa[t] ?? { error: null }));

  it('sin la columna, el arranque lo dice — y dice qué se rompe', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    // 42703 es el `undefined_column` de Postgres, que es como contesta PostgREST
    // a un `select` de una columna que no existe.
    porTabla({ viaje: { error: { code: '42703', message: 'column viaje.intake_pendientes_en does not exist' } } });
    await verificarMigracionesCriticas();

    const mensajes = error.mock.calls.map((c) => (c[1] as { msg: string }).msg).join(' | ');
    expect(mensajes).toContain('0031');
    // La consecuencia, no solo el número: un mensaje que solo dice "falta la
    // 0031" no le dice a quien lo lee de madrugada si puede esperar al lunes.
    expect(mensajes).toContain('liquidación corta');
    expect(info).not.toHaveBeenCalledWith('startup.migraciones', { ok: true });
  });

  it('un fallo de RED en ese sondeo tampoco se reporta como migración faltante', async () => {
    // El mismo criterio que ya rige a los otros cinco: "no pude preguntar" no es
    // "no está". Sin código de error no hubo respuesta de la base.
    rpc.mockResolvedValue({ data: [], error: null });
    porTabla({ viaje: { error: { code: '', message: 'TypeError: fetch failed' } } });
    await verificarMigracionesCriticas();

    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('startup.migraciones_sin_verificar', expect.anything());
  });

  it('con la 0031 aplicada no inventa nada', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    porTabla({});
    await verificarMigracionesCriticas();
    expect(info).toHaveBeenCalledWith('startup.migraciones', { ok: true });
  });
});

// AUDITORÍA PROD (22-ago-2026), RES-2 + RES-9: los sondeos corren EN PARALELO
// y acotados, y la lista alcanza a las migraciones de las que depende el
// código vivo (0119 bandeja durable, 0132 ciclo del evento de Stripe, 0149
// claim completado), que hasta hoy nadie sondeaba.
describe('los sondeos corren en paralelo y cubren las migraciones recientes', () => {
  it('una RPC que no contesta no retiene a las demás: todas se disparan de una vez', async () => {
    let resolverColgada: (() => void) | undefined;
    rpc.mockImplementation((nombre: string) => (nombre === 'garantias_arranque_faltantes'
      ? new Promise((r) => { resolverColgada = () => r({ error: null }); })
      : Promise.resolve({ error: null })));
    const corrida = verificarMigracionesCriticas();
    // Sin esperar a que la colgada conteste, las otras RPC ya se llamaron.
    await new Promise((r) => setTimeout(r, 0));
    const nombres = rpc.mock.calls.map((c) => c[0] as string);
    expect(nombres).toContain('indices_faltantes');
    expect(nombres).toContain('triggers_faltantes');
    expect(nombres).not.toContain('confirmar_aviso_privacidad');
    expect(nombres).not.toContain('guardar_liquidacion_tx');
    resolverColgada!();
    await corrida;
    expect(info).toHaveBeenCalledWith('startup.migraciones', { ok: true });
  });

  it('sonda las columnas que nacen en 0119, 0132 y 0149', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    const { COLUMNAS_RECIENTES } = await import('./startup');
    expect(Object.keys(COLUMNAS_RECIENTES)).toEqual(expect.arrayContaining(['0119', '0132', '0149', '0168', '0169', '0171']));
    await verificarMigracionesCriticas();
    const tablas = from.mock.calls.map((c) => c[0] as string);
    expect(tablas).toEqual(expect.arrayContaining(['wa_evento_pendiente', 'evento_stripe', 'wa_mensaje_procesado']));
  });

  it('si falta la columna de la 0149, lo dice con la migración y la consecuencia', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    from.mockImplementation((tabla: string) => (tabla === 'wa_mensaje_procesado'
      ? tabla_({ error: { code: '42703', message: 'column wa_mensaje_procesado.completado_en does not exist' } })
      : okTabla));
    await verificarMigracionesCriticas();
    const mensajes = error.mock.calls.map((c) => (c[1] as { msg: string }).msg).join(' | ');
    expect(mensajes).toContain('0149');
    expect(mensajes).toContain('completado_en');
    expect(info).not.toHaveBeenCalledWith('startup.migraciones', { ok: true });
  });
});
const tabla_ = tabla;
