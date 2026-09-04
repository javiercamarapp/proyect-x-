import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// EL MUTEX PERDIDO TIENE QUE ABANDONAR EL TURNO.
//
// `acquireViajeLock` devolvía `false` y el processor solo dejaba un warn: seguía
// de largo SIN mutex, que es justo lo que el mutex viene a impedir.
//
// El escenario: dos "listo" seguidos del mismo operador. El primero tarda ≥15s
// en el agente; el segundo agota su ventana de 12s, no consigue el lease, ve el
// viaje todavía abierto y corre el agente TAMBIÉN. La BD impide la doble fila
// (upsert de `guardar_liquidacion_tx`), pero como el upsert no lanza, las dos
// ejecuciones reportan éxito → el operador recibe el cierre y el PDF DOS VECES,
// y se paga el LLM dos veces.
//
// Existía un test del lock aislado, pero ninguno de su INTEGRACIÓN con el
// processor, que es donde vivía el bug. Este es ese test.
//
// Abandonar es seguro porque `false` significa una sola cosa: otro turno tiene el
// lease vigente y ESE va a responder. Los errores de la RPC no llegan aquí —
// `acquireViajeLock` es fail-open y devuelve `true` ante RPC ausente o fallo
// persistente (ver conv.ts y conv_lock.test.ts).
// ═══════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────────
// AUDITORÍA 5 · ALTO — este archivo mockeaba `@/lib/likida/tools` y
// `@/lib/meta/client` enteros. Ahora los dos corren de verdad y el único borde
// mockeado es `fetch` hacia la Graph API: "no le escribe al operador" pasa de
// ser "no se llamó un espía" a "no salió un solo byte hacia Meta", que es la
// afirmación que de verdad importa cuando el otro turno ya le está escribiendo.
// ───────────────────────────────────────────────────────────────────────────

const runAgent = vi.fn();
const fotoAnteriorSinProcesar = vi.fn<() => Promise<boolean | null>>(async () => false);
beforeEach(() => { fotoAnteriorSinProcesar.mockReset(); fotoAnteriorSinProcesar.mockResolvedValue(false); });
// DAT-21: el processor pide el mutex del CIERRE por `intentarLockViaje`, que
// devuelve tres estados. `acquireViajeLock` (booleano) sigue existiendo para
// los otros llamadores y se mockea aparte para que este archivo no dependa de
// cuál de los dos usa cada camino.
const intentarLockViaje = vi.fn<() => Promise<'obtenido' | 'ocupado' | 'indeterminado'>>();
/** DAT-21: desde cuándo está abierto el viaje. `null` = no se supo → fail-open. */
const viajeAbiertoDesdeMs = vi.fn<() => Promise<number | null>>(async () => null);
const getOpenViaje = vi.fn();
const claimMessage = vi.fn<(id: string) => Promise<'nuevo' | 'duplicado' | 'en_curso' | 'indeterminado'>>(async () => 'nuevo');
const releaseMessageClaim = vi.fn();
const completarMessageClaim = vi.fn(async () => {});

/** Todo lo que salió hacia la Graph API. */
const salientes: { url: string; body: Record<string, unknown> }[] = [];
const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
  salientes.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
  return new Response(JSON.stringify({ messages: [{ id: 'wamid.TEST' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
});

vi.mock('@/lib/agents/run', () => ({ runAgent: (...a: unknown[]) => runAgent(...a) }));
vi.mock('@/lib/likida/conv', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveOperador: vi.fn(async () => ({ tenantId: 't1', operadorId: 'o1' })),
  getOpenViaje: (...a: unknown[]) => getOpenViaje(...a),
  viajeAbiertoDesdeMs: () => viajeAbiertoDesdeMs(),
  getTenantContext: vi.fn(async () => ({ nombre: 'Flota' })),
  // `cierreSinComprobantes: true` deja pasar el freno de "cierre sin
  // comprobantes" (processor.ts): este archivo prueba el mutex del viaje, no
  // ese freno, y con `false` el "listo" nunca llegaba a correr el agente.
  loadConversation: vi.fn(async () => ({ id: 'c1', turns: [], cierreSinComprobantes: true })),
  saveConversation: vi.fn(), claimMessage: (...a: unknown[]) => claimMessage(...(a as [string])),
  intentarLockViaje: (...a: unknown[]) => intentarLockViaje(...(a as [])),
  acquireViajeLock: async (...a: unknown[]) => (await intentarLockViaje(...(a as []))) === 'obtenido',
  releaseViajeLock: vi.fn(), releaseMessageClaim: (...a: unknown[]) => releaseMessageClaim(...a),
  completarMessageClaim: (...a: unknown[]) => completarMessageClaim(...(a as [])),
  fotoAnteriorSinProcesar: () => fotoAnteriorSinProcesar(),
  intakeDelta: vi.fn(async () => 0), esperarIntake: vi.fn(async () => true),
}));
vi.mock('@/lib/likida/repo', () => ({
  ubicarGastoPorHash: vi.fn(async () => null),
  // Sala de espera de comprobantes sin viaje (mig. 0040). Sin estas cuatro,
  // `getHuerfanos` llega `undefined` y el processor truena en el `.length`.
  getHuerfanos: vi.fn(async () => []), guardarHuerfano: vi.fn(async () => true),
  resolverHuerfanos: vi.fn(), marcarHuerfanosOfrecidos: vi.fn(),
  addGasto: vi.fn(), getGastos: vi.fn(async () => []), updateGastoCfdiXml: vi.fn(),
  saveCfdiXmlRaw: vi.fn(), gastoExistePorHash: vi.fn(async () => false),
  enriquecerGastoConCodigo: vi.fn(), guardarCodigoPendiente: vi.fn(),
  getCodigosPendientes: vi.fn(async () => []), reclamarCodigoPendiente: vi.fn(),
  // El aviso ya se le puso a disposición antes (`reclamarEnvioAviso` → false):
  // no se manda otra vez y no estorba. Sin datos de responsable el processor
  // bloquearía el tratamiento y el mutex ni se consultaría.
  getDatosResponsable: vi.fn(async () => ({
    razonSocial: 'FLOTA SA DE CV', domicilio: 'Calle 1, Mérida',
    urlAvisoIntegral: 'https://flota.mx/privacidad',
  })),
  reclamarEnvioAviso: vi.fn(async () => false), liberarEnvioAviso: vi.fn(),
  // `tools.ts` se importa de verdad: estos son sus accesos a datos.
  getViaje: vi.fn(async () => ({ id: 'v1', anticipo: 0 })),
  getOperador: vi.fn(async () => ({ id: 'o1', nombre: 'Operador', telefono: '5219993700779' })),
  saveLiquidacion: vi.fn(async () => 'L1'),
  getAcumuladoCombustible: vi.fn(async () => { throw new Error('sin base en pruebas'); }),
}));
vi.mock('@/lib/likida/costos', () => ({
  registrarCosto: vi.fn(), registrarCostoWhatsApp: vi.fn(),
  faseDeModelo: vi.fn(() => 'cuadre'), vincularCostosALiquidacion: vi.fn(),
}));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    storage: { from: () => ({ upload: async () => ({ error: null }), createSignedUrl: async () => ({ data: null, error: { message: 'sin storage' } }) }) },
  }),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { processInbound } = await import('./processor');

const listo = { from: '5219993700779', type: 'text' as const, text: 'listo', timestampMs: 1788534000000, waMessageId: 'wa1' };

describe('processInbound — mutex del viaje', () => {
  beforeEach(() => {
    salientes.length = 0;
    runAgent.mockReset(); intentarLockViaje.mockReset(); getOpenViaje.mockReset();
    viajeAbiertoDesdeMs.mockReset(); viajeAbiertoDesdeMs.mockResolvedValue(null);
    vi.stubGlobal('fetch', fetchSpy);
    fetchSpy.mockClear();
    process.env.WHATSAPP_ACCESS_TOKEN = 'tok-de-prueba';
    process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
    getOpenViaje.mockResolvedValue('v1');
    runAgent.mockResolvedValue({ finalText: 'Listo', toolCalls: [], model: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0 });
  });

  it('con el lock TOMADO, corre el agente', () => {
    // Control: sin esto, un test que solo mira el caso de abandono pasaría
    // igual si el processor nunca corriera el agente.
    intentarLockViaje.mockResolvedValue('obtenido');
    return processInbound(listo).then(() => {
      expect(runAgent).toHaveBeenCalledTimes(1);
      // Y el mensaje SÍ sale, por el camino real: sin este contraste, la prueba
      // de abajo pasaría igual si nunca saliera nada.
      expect(salientes).toHaveLength(1);
      expect(salientes[0].body.to).toBe('529993700779');
    });
  });

  it('con el lock OCUPADO, NO corre el agente', async () => {
    intentarLockViaje.mockResolvedValue('ocupado');
    await processInbound(listo);
    expect(runAgent, 'el segundo "listo" no puede correr el agente sin mutex').not.toHaveBeenCalled();
  });

  // AUDITORÍA 7 · ALTO — antes, con el lock ocupado, no salía NADA: el operador
  // veía sus dos palomitas azules y ninguna respuesta a ESE mensaje, "listo"
  // nunca corría el agente, nunca entraba a `wa_conversacion`, y seguía
  // reclamado en `wa_mensaje_procesado` para siempre (el `return` no pasaba por
  // `releaseMessageClaim`). El fix (acotado; la cola de verdad es FASE 3):
  // cuando se pierde el lock, se AVISA que se está procesando el otro mensaje y
  // se libera el claim para no dejarlo atascado.
  it('con el lock OCUPADO, avisa que ya está ocupado (no se calla) y libera el claim', async () => {
    intentarLockViaje.mockResolvedValue('ocupado');
    await processInbound(listo);
    expect(salientes, 'antes se callaba del todo; ahora avisa').toHaveLength(1);
    expect(String((salientes[0].body.text as { body: string }).body)).toMatch(/un momento|espera|proces/i);
    expect(releaseMessageClaim).toHaveBeenCalledWith('wa1');
  });

  it('con el lock OCUPADO, sigue sin correr el agente (no hay doble cuadre)', async () => {
    intentarLockViaje.mockResolvedValue('ocupado');
    await processInbound(listo);
    expect(runAgent, 'el mensaje que pierde el mutex no corre el agente igual').not.toHaveBeenCalled();
  });

  // ── DAT-21 · EL TERCER ESTADO, QUE ANTES SE LEÍA COMO "ES TUYO" ──────────
  //
  // 12 s de timeouts de la RPC devolvían `true`, y con ese `true` este camino
  // cuadraba, imprimía los dos PDFs y CERRABA sin exclusividad ninguna — justo
  // cuando la base estaba peor, que es cuando el doble cierre es más probable.
  it('con el lock INDETERMINADO, NO cierra: falla cerrado', async () => {
    intentarLockViaje.mockResolvedValue('indeterminado');
    await processInbound(listo);
    expect(runAgent, 'no se cierra una liquidación sin saber si otro la está cerrando')
      .not.toHaveBeenCalled();
  });

  it('y se lo dice al operador SIN afirmar lo que no le consta', async () => {
    intentarLockViaje.mockResolvedValue('indeterminado');
    await processInbound(listo);
    const texto = String((salientes[0].body.text as { body: string }).body);
    // «estoy procesando tu mensaje anterior» sería falso: lo que pasa es que
    // no pudimos consultar. El producto no afirma hechos que no le constan.
    expect(texto).toMatch(/conexión falló|no pude apartar/i);
    expect(texto).not.toMatch(/mensaje anterior/i);
    expect(texto, 'y sus comprobantes no se perdieron').toMatch(/guardad/i);
    expect(releaseMessageClaim, 'el claim se suelta: la bandeja lo reintenta')
      .toHaveBeenCalledWith('wa1');
  });

  it('el cierre pide el lease de 120 s, no el default de 60', async () => {
    // El cierre en el peor caso —cuadre + dos PDFs + subida + RPC + envío— no
    // cabe en 60 s, y un lease que vence a media faena deja de ser un mutex.
    intentarLockViaje.mockResolvedValue('obtenido');
    await processInbound(listo);
    expect(intentarLockViaje).toHaveBeenCalledWith('v1', expect.objectContaining({ ttlMs: 120_000 }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DAT-21 · UN "LISTO" VIEJO NO CIERRA EL VIAJE DE HOY.
//
// La bandeja durable puede rescatar un mensaje dos vueltas de cron después de
// que Meta lo recibió. En ese hueco caben las dos cosas que hacen falta para el
// accidente: que la oficina cierre el viaje al que ese "listo" pertenecía, y
// que le abra el SIGUIENTE. Cuando el mensaje por fin corre, `getOpenViaje`
// devuelve el viaje NUEVO y el "listo" del anterior lo cierra: sin
// comprobantes, con el anticipo entero en contra del chofer, e irreversible por
// los triggers 0036/0037.
//
// La prueba de que el mensaje es de otro viaje es la hora de META (DAT-38): un
// operador sólo puede tener UN viaje abierto a la vez (0029), así que un texto
// recibido ANTES de que ESTE viaje se abriera es, por construcción, del anterior.
// ═══════════════════════════════════════════════════════════════════════════
describe('processInbound — el "listo" que llegó tarde', () => {
  const ABIERTO_MS = Date.UTC(2026, 7, 22, 18, 0, 0);
  const listoViejo = { ...listo, waMessageId: 'wa-viejo', timestampMs: ABIERTO_MS - 600_000 };
  const listoDeHoy = { ...listo, waMessageId: 'wa-hoy', timestampMs: ABIERTO_MS + 600_000 };

  beforeEach(() => {
    salientes.length = 0;
    runAgent.mockReset(); intentarLockViaje.mockReset(); getOpenViaje.mockReset();
    viajeAbiertoDesdeMs.mockReset();
    releaseMessageClaim.mockClear(); completarMessageClaim.mockClear();
    vi.stubGlobal('fetch', fetchSpy);
    fetchSpy.mockClear();
    process.env.WHATSAPP_ACCESS_TOKEN = 'tok-de-prueba';
    process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
    getOpenViaje.mockResolvedValue('v1');
    intentarLockViaje.mockResolvedValue('obtenido');
    viajeAbiertoDesdeMs.mockResolvedValue(ABIERTO_MS);
    runAgent.mockResolvedValue({ finalText: 'Listo', toolCalls: [], model: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0 });
  });

  it('un "listo" anterior a la apertura del viaje NO corre el agente', async () => {
    await processInbound(listoViejo);
    expect(runAgent, 'cerrar el viaje de hoy con el "listo" de ayer es irreversible')
      .not.toHaveBeenCalled();
  });

  it('y se le explica al chofer, en vez de dejarlo esperando', async () => {
    await processInbound(listoViejo);
    const texto = String((salientes[0].body.text as { body: string }).body);
    expect(texto).toMatch(/viaje anterior/i);
    expect(texto).toMatch(/viaje nuevo/i);
  });

  it('CONTROL — el "listo" posterior a la apertura sí cierra', async () => {
    await processInbound(listoDeHoy);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it('FAIL-OPEN — sin poder leer la apertura, no se descarta nada', async () => {
    // Tirar un "listo" bueno deja al chofer sin cerrar y sin entender por qué;
    // dejar pasar uno viejo es rarísimo y la re-verificación tras el mutex
    // todavía puede atraparlo.
    viajeAbiertoDesdeMs.mockResolvedValue(null);
    await processInbound(listoViejo);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it('sin hora de Meta aplaza el cierre, no consulta apertura ni ejecuta el agente', async () => {
    expect(await processInbound({ ...listo, timestampMs: undefined, waMessageId: 'wa-sin-hora' })).toBe('sin_tiempo');
    expect(viajeAbiertoDesdeMs, 'la consulta corre SÓLO cuando puede decidir algo')
      .not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    expect(releaseMessageClaim).toHaveBeenCalledWith('wa-sin-hora');
    expect(salientes).toHaveLength(0);
    expect(intentarLockViaje).not.toHaveBeenCalled();
    expect(completarMessageClaim).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 18 (C4/C5/A3/A27): LO QUE `processInbound` LE DICE A LA BANDEJA.
//
// Devolvía `void`, y el cron y el webhook sellaban la fila durable ante
// cualquier retorno sin excepción: el 'duplicado' de un claim huérfano y los
// `return` de abandono (este mutex ocupado, entre ellos) quedaban "procesados".
// ═══════════════════════════════════════════════════════════════════════════
describe('processInbound — el resultado que decide la fila durable', () => {
  beforeEach(() => {
    salientes.length = 0;
    runAgent.mockReset(); intentarLockViaje.mockReset(); getOpenViaje.mockReset();
    viajeAbiertoDesdeMs.mockReset(); viajeAbiertoDesdeMs.mockResolvedValue(null);
    claimMessage.mockReset(); claimMessage.mockResolvedValue('nuevo');
    completarMessageClaim.mockClear(); releaseMessageClaim.mockClear();
    vi.stubGlobal('fetch', fetchSpy);
    process.env.WHATSAPP_ACCESS_TOKEN = 'tok-de-prueba';
    process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
    getOpenViaje.mockResolvedValue('v1');
    runAgent.mockResolvedValue({ finalText: 'Listo', toolCalls: [], model: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0 });
  });

  it('un turno que llega al final es "procesado" y SELLA el claim como completado', async () => {
    intentarLockViaje.mockResolvedValue('obtenido');
    expect(await processInbound(listo)).toBe('procesado');
    expect(completarMessageClaim).toHaveBeenCalledWith('wa1');
  });

  it.each([true, null])('foto anterior pendiente o indeterminada (%s) aplaza sin tomar mutex ni cerrar', async (estadoFoto) => {
    fotoAnteriorSinProcesar.mockResolvedValue(estadoFoto);
    intentarLockViaje.mockResolvedValue('obtenido');
    expect(await processInbound(listo)).toBe('sin_tiempo');
    expect(fotoAnteriorSinProcesar).toHaveBeenCalledTimes(1);
    expect(intentarLockViaje).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    expect(salientes).toHaveLength(0);
    expect(releaseMessageClaim).toHaveBeenCalledWith('wa1');
    expect(completarMessageClaim).not.toHaveBeenCalled();
  });

  it('con el lock OCUPADO es "reintentable": el claim se soltó y NO se completa', async () => {
    intentarLockViaje.mockResolvedValue('ocupado');
    expect(await processInbound(listo)).toBe('reintentable');
    expect(releaseMessageClaim).toHaveBeenCalledWith('wa1');
    expect(completarMessageClaim).not.toHaveBeenCalled();
  });

  it('un claim completado por otro es "duplicado": no corre nada', async () => {
    claimMessage.mockResolvedValue('duplicado');
    expect(await processInbound(listo)).toBe('duplicado');
    expect(runAgent).not.toHaveBeenCalled();
    expect(completarMessageClaim).not.toHaveBeenCalled();
  });

  it('un claim en vuelo en OTRA invocación es "en_curso": ni corre ni se da por hecho', async () => {
    claimMessage.mockResolvedValue('en_curso');
    expect(await processInbound(listo)).toBe('en_curso');
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('sin presupuesto de invocación es "sin_tiempo" y NI SIQUIERA reclama (C4)', async () => {
    // La invocación arrancó hace 118s: quedan 2s de 120. Arrancar un turno
    // aquí es regalárselo a Vercel; se deja entero para el cron.
    expect(await processInbound(listo, { inicioInvocacionMs: Date.now() - 118_000 })).toBe('sin_tiempo');
    expect(claimMessage).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });
});
