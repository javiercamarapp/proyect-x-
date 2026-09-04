import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 3, OP-C1 (CRÍTICO): este cron respondía 200 con un motor entero
// reventado — así acumuló ~216 corridas "verdes" mientras el embed roto de
// la 0075 tumbaba la escalación cada hora. Estas pruebas fijan el contrato:
// motor caído = 500 (la plataforma cuenta el cron como FALLIDO); los dos
// motores corren AUNQUE el primero truene.
// ═══════════════════════════════════════════════════════════════════════════

const escalarViajesSinAceptar = vi.fn();
const ejecutarCobranzaGlobal = vi.fn();

vi.mock('@/lib/likida/escalar_viaje', () => ({
  escalarViajesSinAceptar: (...a: unknown[]) => escalarViajesSinAceptar(...a),
  // ESC-3: el cron reparte su reloj entre los dos motores con esta constante.
  PLAZO_ESCALACION_MS: 40_000,
}));
// FASE 6: los relojes legales corren dentro de este cron. Aquí se doblan
// en cero para que las pruebas del reparto del reloj y los interruptores
// sigan midiendo SOLO a sus dos motores — los relojes tienen su propia
// suite (relojes_legales.test.ts).
// AUDITORÍA 24 (BE-7): son `vi.fn` para poder mirar el reloj que reciben y
// para colgar uno en la prueba del techo duro.
const avisarRelojesLegales = vi.fn(async (..._a: unknown[]) => ({ revisadas: 0, avisadas: 0, fallos: 0, cortadasPorReloj: 0 }));
const avisarVencimientos = vi.fn(async (..._a: unknown[]) => ({ candidatos: 0, avisados: 0, fallos: 0, cortadosPorReloj: 0 }));
vi.mock('@/lib/likida/relojes_legales', () => ({
  avisarRelojesLegales: (...a: unknown[]) => avisarRelojesLegales(...a),
  avisarVencimientos: (...a: unknown[]) => avisarVencimientos(...a),
}));
vi.mock('@/lib/likida/agentes/cobranza', () => ({
  ejecutarCobranzaGlobal: (...a: unknown[]) => ejecutarCobranzaGlobal(...a),
}));
// A19 (0229): el cuarto barrido — las reglas que la flota declaró. Se dobla en
// cero por lo mismo que los relojes: aquí se mide el reparto del reloj y los
// interruptores de los DOS motores, no el vigilante (que tiene su propia
// suite, reglas/vigilante.test.ts).
const vigilarReglas = vi.fn(async () => ({ reglas: 0, disparadas: 0, avisos: 0, fallos: 0 }));
vi.mock('@/lib/likida/reglas/vigilante', () => ({
  vigilarReglas: (...a: unknown[]) => vigilarReglas(...(a as [])),
}));
// 0323: el mismo cron horario hospeda el barrido durable de Cal.com para no
// sumar otra invocación facturable ni depender de reintentos del proveedor.
const ejecutarMantenimientoCalcom = vi.fn(async () => ({ configured: true, completa: true, revisadas: 0 }));
vi.mock('@/lib/admin/calcom', () => ({
  ejecutarMantenimientoCalcom: (...a: unknown[]) => ejecutarMantenimientoCalcom(...(a as [])),
}));
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger }));

// El canal de alerta al operador (auditoría 4, D1) se mockea: aquí se prueba
// que el cron LO DISPARA al fallar, no el canal mismo (ese vive en
// observability/alerta.test.ts).
const alertarOperador = vi.fn(async () => {});
vi.mock('@/lib/observability/alerta', () => ({
  alertarOperador: (...a: unknown[]) => alertarOperador(...(a as [])),
}));

// El kill switch (0110). Default: sin fila = encendido (false) — así TODAS
// las pruebas existentes prueban de paso que sin interruptor el cron corre.
const estaApagado = vi.fn(async (nombre: string) => nombre === '__ninguno_apagado__');
/** AUDITORÍA 18 (A17): los crons leen `leerInterruptor`, que distingue
 *  apagado de ILEGIBLE. `estaApagado` sigue siendo la palanca de las pruebas
 *  viejas (true = apagado); `ilegibles` marca qué lecturas fallan. */
const ilegibles = new Set<string>();
// c5-CRON: fallos TRANSITORIOS — la primera lectura sale ilegible y la
// segunda (el reintento del cron) ya contesta.
const ilegiblesUnaVez = new Set<string>();
vi.mock('@/lib/likida/interruptores', () => ({
  leerInterruptor: async (nombre: string) => {
    if (ilegiblesUnaVez.has(nombre)) { ilegiblesUnaVez.delete(nombre); return 'ilegible'; }
    return ilegibles.has(nombre) ? 'ilegible' : (await estaApagado(nombre)) ? 'apagado' : 'encendido';
  },
}));

// El latido (RES-7) se prueba en src/lib/admin/salud.test.ts; aquí se mockea
// para que la racha de cortes (RES-6) sea observable sin tocar la base.
const registrarLatido = vi.fn(async () => {});
let latidoPrevio: { ultimoLatido: string; estado: string; detalle: Record<string, unknown> } | null = null;
vi.mock('@/lib/admin/salud', () => ({
  registrarLatido: (...a: unknown[]) => registrarLatido(...(a as [])),
  leerLatido: async () => latidoPrevio,
  puertaCron: async (_c: string, req: Request) =>
    req.headers.get('authorization') === 'Bearer secreto-de-prueba' ? null : new Response(null, { status: 401 }),
}));

process.env.CRON_SECRET = 'secreto-de-prueba';
const { GET } = await import('./route');

const peticion = (auth?: string) => new Request('http://likida.test/api/cron/escalar', {
  headers: auth ? { authorization: auth } : {},
}) as never;

describe('GET /api/cron/escalar — el cron ya no miente en verde', () => {
  beforeEach(() => {
    escalarViajesSinAceptar.mockReset().mockResolvedValue({ escalados: 0 });
    ejecutarCobranzaGlobal.mockReset().mockResolvedValue({ tenants: 0, contactados: 0, fallos: [] });
    alertarOperador.mockClear();
    logger.error.mockClear();
    logger.warn.mockClear();
    estaApagado.mockReset().mockResolvedValue(false);
    ejecutarMantenimientoCalcom.mockClear();
  });

  it('con los dos motores sanos responde 200 y no molesta al operador', async () => {
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    expect(res.status).toBe(200);
    expect(alertarOperador).not.toHaveBeenCalled();
    expect(ejecutarMantenimientoCalcom).toHaveBeenCalledTimes(1);
    expect(ejecutarMantenimientoCalcom).toHaveBeenCalledWith(expect.objectContaining({
      callbackUrl: 'https://app.likida.ai/api/webhook/calcom',
      venceEn: expect.any(Number),
    }));
    expect(escalarViajesSinAceptar.mock.invocationCallOrder[0])
      .toBeLessThan(ejecutarMantenimientoCalcom.mock.invocationCallOrder[0]);
    expect(ejecutarCobranzaGlobal.mock.invocationCallOrder[0])
      .toBeLessThan(ejecutarMantenimientoCalcom.mock.invocationCallOrder[0]);
  });

  it('si la ESCALACIÓN revienta: 500, el error viaja en el cuerpo, y la cobranza CORRE igual', async () => {
    escalarViajesSinAceptar.mockRejectedValue(new Error('more than one relationship'));
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    expect(res.status).toBe(500);
    const cuerpo = await res.json();
    expect(String((cuerpo.aceptacion as { error?: string }).error)).toContain('relationship');
    expect(ejecutarCobranzaGlobal).toHaveBeenCalledTimes(1);
    expect(cuerpo.comprobacion).toEqual({ tenants: 0, contactados: 0, fallos: [] });
    // D2: el fallo lleva `codigo` estable (discrimina la causa en el
    // fingerprint de Sentry). D1: la alerta al operador se dispara.
    expect(logger.error).toHaveBeenCalledWith('cron.escalar.falló', expect.objectContaining({ codigo: expect.stringMatching(/./) }));
    expect(alertarOperador).toHaveBeenCalledWith('cron.escalar', expect.objectContaining({ codigo: expect.any(String) }));
  });

  it('si la COBRANZA revienta: 500 también, con su propia alerta', async () => {
    ejecutarCobranzaGlobal.mockRejectedValue(new Error('se cayó'));
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    expect(res.status).toBe(500);
    expect(alertarOperador).toHaveBeenCalledWith('cron.cobranza', expect.objectContaining({ codigo: expect.any(String) }));
  });

  it('sin el secreto correcto no corre nada', async () => {
    const res = await GET(peticion('Bearer equivocado'));
    expect(res.status).toBe(401);
    expect(escalarViajesSinAceptar).not.toHaveBeenCalled();
  });
});

describe('el kill switch (0110)', () => {
  beforeEach(() => {
    // El beforeEach del describe de arriba no alcanza a éste: se re-arman los
    // motores aquí o los conteos arrastran las llamadas de las pruebas previas.
    escalarViajesSinAceptar.mockReset().mockResolvedValue({ escalados: 0 });
    ejecutarCobranzaGlobal.mockReset().mockResolvedValue({ tenants: 0, contactados: 0, fallos: [] });
    logger.warn.mockClear();
    estaApagado.mockReset().mockResolvedValue(false);
    ilegibles.clear();
  });

  it("con 'global' ILEGIBLE: 500 con `codigo`, y NINGÚN motor corre (A17)", async () => {
    // No es el 200 `saltado` del apagado a propósito: no haber podido leer
    // la palanca es un fallo, y el cron tiene que salir ROJO en Vercel.
    ilegibles.add('global');
    const res = await GET(peticion('Bearer secreto-de-prueba'));

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ corrio: false, codigo: 'interruptor_ilegible', interruptor: 'global' });
    expect(escalarViajesSinAceptar).not.toHaveBeenCalled();
    expect(ejecutarCobranzaGlobal).not.toHaveBeenCalled();
  });

  it("con 'agente:conductores' ILEGIBLE: la cobranza CORRE, pero la corrida sale 500 (A17)", async () => {
    ilegibles.add('agente:conductores');
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    const cuerpo = await res.json();

    expect(res.status).toBe(500);
    expect(cuerpo.aceptacion).toMatchObject({ codigo: 'interruptor_ilegible', interruptor: 'agente:conductores' });
    expect(escalarViajesSinAceptar).not.toHaveBeenCalled();
    expect(ejecutarCobranzaGlobal).toHaveBeenCalledTimes(1);
    expect(cuerpo.comprobacion).toEqual({ tenants: 0, contactados: 0, fallos: [] });
  });

  it("con 'global' apagado: 200 con {saltado}, y NINGÚN motor corre", async () => {
    // 200 y no 500: apagado a propósito no es fallo — un 500 mandaría a
    // alguien a investigar la decisión de Javier como si fuera incidente.
    estaApagado.mockImplementation(async (n: string) => n === 'global');
    const res = await GET(peticion('Bearer secreto-de-prueba'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ corrio: false, saltado: 'interruptor global' });
    expect(escalarViajesSinAceptar).not.toHaveBeenCalled();
    expect(ejecutarCobranzaGlobal).not.toHaveBeenCalled();
    // Y lo dice en el log: el salto no puede pasar desapercibido.
    expect(logger.warn).toHaveBeenCalledWith('cron.escalar.saltado', { interruptor: 'global' });
  });

  it("con 'agente:cobranza' apagado: la aceptación CORRE, la cobranza salta Y LO DICE", async () => {
    estaApagado.mockImplementation(async (n: string) => n === 'agente:cobranza');
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    const cuerpo = await res.json();

    expect(res.status).toBe(200);
    expect(escalarViajesSinAceptar).toHaveBeenCalledTimes(1);
    expect(ejecutarCobranzaGlobal).not.toHaveBeenCalled();
    expect(cuerpo.comprobacion).toEqual({ saltado: 'interruptor agente:cobranza' });
    // La aceptación reporta normal: la palanca de cobranza no la toca.
    expect(cuerpo.aceptacion).toEqual({ escalados: 0 });
  });

  it("con 'agente:conductores' apagado: la aceptación salta Y LO DICE, la cobranza CORRE", async () => {
    // Fase 1 del blueprint (15-ago-2026): este interruptor existía en el
    // catálogo (0110) y NINGÚN call site lo preguntaba — apagar al Agente de
    // Conductores no apagaba nada. Ahora sí, y con la misma forma que el de
    // cobranza: 200, `saltado` en el cuerpo, y el otro motor sigue.
    //
    // "No se pudo leer" también detiene el motor, pero por OTRO cable: es
    // la prueba ILEGIBLE de arriba (A17), que sale 500.
    estaApagado.mockImplementation(async (n: string) => n === 'agente:conductores');
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    const cuerpo = await res.json();

    expect(res.status).toBe(200);
    expect(escalarViajesSinAceptar).not.toHaveBeenCalled();
    expect(ejecutarCobranzaGlobal).toHaveBeenCalledTimes(1);
    expect(cuerpo.aceptacion).toEqual({ saltado: 'interruptor agente:conductores' });
    expect(logger.warn).toHaveBeenCalledWith('cron.conductores.saltado', { interruptor: 'agente:conductores' });
  });

  it('sin fila (el default del catálogo) el cron corre entero', async () => {
    // `estaApagado` en false ES "sin fila = encendido" — el contrato del
    // default seguro, probado desde el cable.
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    expect(res.status).toBe(200);
    expect(escalarViajesSinAceptar).toHaveBeenCalledTimes(1);
    expect(ejecutarCobranzaGlobal).toHaveBeenCalledTimes(1);
  });

  it('el interruptor se consulta DESPUÉS de la puerta: sin bearer válido ni se lee', async () => {
    // Si se consultara antes, cualquiera sin secreto podría sondear con el
    // reloj si el sistema está apagado.
    await GET(peticion('Bearer equivocado'));
    expect(estaApagado).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ESC-3 / ESC-4 / RES-6 — el reparto del reloj entre los dos motores, y la
// racha de corridas que dejan trabajo sin hacer.
// ═══════════════════════════════════════════════════════════════════════════
describe('el reloj se reparte y los cortes repetidos se gritan', () => {
  beforeEach(() => {
    escalarViajesSinAceptar.mockReset().mockResolvedValue({ escalados: 0, cortadosPorReloj: 0 });
    ejecutarCobranzaGlobal.mockReset().mockResolvedValue({ tenants: 0, contactados: 0, cortadosPorReloj: 0, fallos: [] });
    alertarOperador.mockClear();
    registrarLatido.mockClear();
    latidoPrevio = null;
    estaApagado.mockReset().mockResolvedValue(false);
  });

  it('a cada motor le pasa SU vencimiento, y el de la cobranza es más tarde', async () => {
    await GET(peticion('Bearer secreto-de-prueba'));
    const { venceEn: venceEscalacion } = escalarViajesSinAceptar.mock.calls[0][0] as { venceEn: number };
    const { venceEn: venceCobranza } = ejecutarCobranzaGlobal.mock.calls[0][1] as { venceEn: number };
    expect(venceEscalacion).toBeGreaterThan(Date.now());
    // La escalación cede el resto: si se comiera los 120 s, la cobranza no
    // llegaba ni a leer su cola — cada hora y sin una línea que lo dijera.
    expect(venceCobranza).toBeGreaterThan(venceEscalacion);
  });

  it('una corrida con cortes lo dice y suma a la racha, sin molestar al operador', async () => {
    ejecutarCobranzaGlobal.mockResolvedValue({ tenants: 3, contactados: 5, cortadosPorReloj: 2, fallos: [] });
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    expect((await res.json()).cortadosPorReloj).toBe(2);
    expect(registrarLatido).toHaveBeenCalledWith('escalar', 'parcial', { cortesSeguidos: 1, cortados: 2 });
    expect(alertarOperador).not.toHaveBeenCalled();
  });

  it('TRES corridas seguidas con cortes: el trabajo ya no cabe en la cadencia, y se avisa', async () => {
    latidoPrevio = { ultimoLatido: new Date().toISOString(), estado: 'parcial', detalle: { cortesSeguidos: 2 } };
    ejecutarCobranzaGlobal.mockResolvedValue({ tenants: 9, contactados: 5, cortadosPorReloj: 4, fallos: [] });
    await GET(peticion('Bearer secreto-de-prueba'));
    expect(alertarOperador).toHaveBeenCalledWith('cron.escalar', expect.objectContaining({ codigo: 'corte_por_reloj_repetido' }));
    expect(registrarLatido).toHaveBeenCalledWith('escalar', 'parcial', { cortesSeguidos: 3, cortados: 4 });
  });

  it('una corrida completa REINICIA la racha: el latido vuelve a `ok` en cero', async () => {
    latidoPrevio = { ultimoLatido: new Date().toISOString(), estado: 'parcial', detalle: { cortesSeguidos: 5 } };
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    expect(res.status).toBe(200);
    expect(registrarLatido).toHaveBeenCalledWith('escalar', 'ok', { cortesSeguidos: 0, cortados: 0 });
    expect(alertarOperador).not.toHaveBeenCalled();
  });
});

describe('c5-CRON — el reintento único ante timeout, solo donde es idempotente', () => {
  beforeEach(() => {
    escalarViajesSinAceptar.mockReset().mockResolvedValue({ escalados: 0 });
    ejecutarCobranzaGlobal.mockReset().mockResolvedValue({ tenants: 0, contactados: 0, fallos: [] });
    alertarOperador.mockClear();
    estaApagado.mockReset().mockResolvedValue(false);
    ilegibles.clear();
    ilegiblesUnaVez.clear();
  });

  it('el interruptor ilegible UNA vez (la estampida) se reintenta y el cron corre — el fallo 11:07 muere aquí', async () => {
    ilegiblesUnaVez.add('global');
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    expect(res.status).toBe(200);
    expect(escalarViajesSinAceptar).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('un TimeoutError del motor de escalación se reintenta UNA vez (claim-first: lo reclamado no se repite)', async () => {
    escalarViajesSinAceptar
      .mockRejectedValueOnce(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))
      .mockResolvedValueOnce({ escalados: 2 });
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    expect(res.status).toBe(200);
    expect(escalarViajesSinAceptar).toHaveBeenCalledTimes(2);
    expect(alertarOperador).not.toHaveBeenCalled();
  }, 15_000);

  it('un error que NO es timeout jamás se reintenta: 500 a la primera', async () => {
    escalarViajesSinAceptar.mockRejectedValue(new Error('column does not exist'));
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    expect(res.status).toBe(500);
    expect(escalarViajesSinAceptar).toHaveBeenCalledTimes(1);
  });

  it('el timeout del tope de acotada ("sin respuesta en N ms") también cuenta como timeout', async () => {
    ejecutarCobranzaGlobal
      .mockRejectedValueOnce(new Error('ejecutarCobranzaGlobal: sin respuesta en 8000 ms (tope de consulta)'))
      .mockResolvedValueOnce({ tenants: 1, contactados: 1, fallos: [] });
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    expect(res.status).toBe(200);
    expect(ejecutarCobranzaGlobal).toHaveBeenCalledTimes(2);
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// A19 (0229) — EL CUARTO BARRIDO: LAS REGLAS DE LA FLOTA.
//
// El vigilante entró a este cron y no a uno propio. Lo que estas pruebas
// fijan es lo mismo que ya se le exige a los otros tres: que corra, que su
// fallo pinte la corrida en 500 (un barrido caído no puede salir verde) y
// que NO le quite el turno a nadie — una regla rota no deja sin escalar los
// viajes de nadie.
// ═══════════════════════════════════════════════════════════════════════════
describe('el vigilante de reglas (A19) corre aquí, y falla como los demás', () => {
  beforeEach(() => {
    escalarViajesSinAceptar.mockReset().mockResolvedValue({ escalados: 0 });
    ejecutarCobranzaGlobal.mockReset().mockResolvedValue({ tenants: 0, contactados: 0, fallos: [] });
    alertarOperador.mockClear();
    logger.error.mockClear();
    estaApagado.mockReset().mockResolvedValue(false);
    vigilarReglas.mockReset().mockResolvedValue({ reglas: 0, disparadas: 0, avisos: 0, fallos: 0 });
  });

  it('se despacha en cada corrida y su resultado viaja en el cuerpo', async () => {
    vigilarReglas.mockResolvedValue({ reglas: 3, disparadas: 1, avisos: 2, fallos: 0 });
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    expect(res.status).toBe(200);
    expect(vigilarReglas).toHaveBeenCalledTimes(1);
    expect((await res.json()).reglas).toEqual({ reglas: 3, disparadas: 1, avisos: 2, fallos: 0 });
  });

  it('una regla que falló pinta la corrida en 500 — no se sale en verde con un barrido a medias', async () => {
    vigilarReglas.mockResolvedValue({ reglas: 4, disparadas: 0, avisos: 0, fallos: 1 });
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    expect(res.status).toBe(500);
  });

  it('si el barrido entero revienta: 500, el error en el cuerpo, y los otros motores CORRIERON igual', async () => {
    vigilarReglas.mockRejectedValue(new Error('reglasActivas: relation does not exist'));
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    expect(res.status).toBe(500);
    const cuerpo = await res.json();
    expect(String((cuerpo.reglas as { error?: string }).error)).toContain('relation does not exist');
    expect(escalarViajesSinAceptar).toHaveBeenCalledTimes(1);
    expect(ejecutarCobranzaGlobal).toHaveBeenCalledTimes(1);
    expect(alertarOperador).toHaveBeenCalledWith('cron.reglas', expect.objectContaining({ codigo: expect.stringMatching(/./) }));
  });

  it('con el interruptor global apagado NO corre: no tiene palanca propia porque no es un agente', async () => {
    estaApagado.mockImplementation(async (n: string) => n === 'global');
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    expect(res.status).toBe(200);
    expect(vigilarReglas).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24, BE-7 (ALTO): los barridos de después de la cobranza corrían
// sin reloj y el latido era la última línea. Con la cobranza gastando sus
// 105 s, `avisarVencimientos` arrancaba a t=105 mandando WhatsApp y sellando
// después; Vercel mataba la lambda a los 120 s con flotas avisadas sin sello
// (reenvío la hora siguiente) y sin latido («escalar no late», sin causa).
// ═══════════════════════════════════════════════════════════════════════════
describe('BE-7 — los barridos ven el reloj y la corrida tiene techo duro', () => {
  beforeEach(() => {
    escalarViajesSinAceptar.mockReset().mockResolvedValue({ escalados: 0, cortadosPorReloj: 0 });
    ejecutarCobranzaGlobal.mockReset().mockResolvedValue({ tenants: 0, contactados: 0, cortadosPorReloj: 0, fallos: [] });
    avisarRelojesLegales.mockReset().mockResolvedValue({ revisadas: 0, avisadas: 0, fallos: 0, cortadasPorReloj: 0 });
    avisarVencimientos.mockReset().mockResolvedValue({ candidatos: 0, avisados: 0, fallos: 0, cortadosPorReloj: 0 });
    alertarOperador.mockClear();
    registrarLatido.mockClear();
    logger.error.mockClear();
    latidoPrevio = null;
    estaApagado.mockReset().mockResolvedValue(false);
  });

  it('los relojes legales y los vencimientos reciben el MISMO vencimiento que la cobranza', async () => {
    await GET(peticion('Bearer secreto-de-prueba'));
    const { venceEn: venceCobranza } = ejecutarCobranzaGlobal.mock.calls[0][1] as { venceEn: number };
    expect((avisarRelojesLegales.mock.calls[0][1] as { venceEn: number }).venceEn).toBe(venceCobranza);
    expect((avisarVencimientos.mock.calls[0][1] as { venceEn: number }).venceEn).toBe(venceCobranza);
  });

  it('un barrido que cortó por reloj cuenta en la racha y el latido sale `parcial`', async () => {
    avisarVencimientos.mockResolvedValue({ candidatos: 9, avisados: 2, fallos: 0, cortadosPorReloj: 7 });
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    expect(res.status).toBe(200);
    expect((await res.json()).cortadosPorReloj).toBe(7);
    expect(registrarLatido).toHaveBeenCalledWith('escalar', 'parcial', { cortesSeguidos: 1, cortados: 7 });
  });

  it('si un barrido se cuelga más allá del techo, la ruta responde y LATE igual — `parcial`, con el motor en vuelo nombrado', async () => {
    vi.useFakeTimers();
    try {
      // `avisarVencimientos` no contesta nunca: un `fetch` sin tope, un motor
      // que ignoró su reloj. Antes esto era una lambda muerta a los 120 s sin
      // latido; ahora la ruta gana la carrera a los 110 s.
      avisarVencimientos.mockImplementation(() => new Promise(() => {}));
      const pendiente = GET(peticion('Bearer secreto-de-prueba'));
      await vi.advanceTimersByTimeAsync(111_000);
      const res = await pendiente;
      const cuerpo = await res.json();
      expect(cuerpo.corteDuro).toMatchObject({ motorEnVuelo: 'relojes' });
      expect(registrarLatido).toHaveBeenCalledTimes(1);
      expect(registrarLatido).toHaveBeenCalledWith('escalar', 'parcial', expect.objectContaining({ corteDuro: 'relojes', cortesSeguidos: 1 }));
      expect(logger.error).toHaveBeenCalledWith('cron.escalar.corte_duro', expect.objectContaining({ enVuelo: 'relojes' }));
      // Los dos motores de antes SÍ corrieron y su parte viaja en el cuerpo.
      expect(cuerpo.aceptacion).toEqual({ escalados: 0, cortadosPorReloj: 0 });
      expect(cuerpo.comprobacion).toEqual({ tenants: 0, contactados: 0, cortadosPorReloj: 0, fallos: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('con todos los motores a tiempo el techo duro nunca gana: latido `ok` en cero, una sola vez', async () => {
    const res = await GET(peticion('Bearer secreto-de-prueba'));
    expect(res.status).toBe(200);
    expect(registrarLatido).toHaveBeenCalledTimes(1);
    expect(registrarLatido).toHaveBeenCalledWith('escalar', 'ok', { cortesSeguidos: 0, cortados: 0 });
  });

  it('el latido se escribe aunque la corrida reviente fuera de los try de los motores (finally)', async () => {
    // `leerLatido` sí está protegido; lo que no lo estaba era el cuerpo entero.
    // Un `NextResponse.json` que no puede serializar el resultado es la clase
    // de fallo que antes salía sin latido.
    const ciclico: Record<string, unknown> = {};
    ciclico.yo = ciclico;
    escalarViajesSinAceptar.mockResolvedValue(ciclico);
    await expect(GET(peticion('Bearer secreto-de-prueba'))).rejects.toThrow();
    expect(registrarLatido).toHaveBeenCalledTimes(1);
    expect(registrarLatido).toHaveBeenCalledWith('escalar', 'fallo', { codigo: 'corrida_sin_cerrar' });
  });
});
