import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA PROD (22-ago-2026) · RES-15 — con el LLM caído, el operador
// recibía "¿me reenvías tu último mensaje?".
//
// Es la peor respuesta posible: le pide repetir un trabajo que no era suyo,
// el reenvío vuelve a caer en el mismo proveedor muerto, y sus comprobantes
// YA ESTÁN en la base — el cuadre no necesita al modelo para nada. El motor
// (`cuadrarDesdeDB` + `resumenCuadre`) da los MISMOS números en milisegundos
// y sin proveedor, que es exactamente lo que ya se hace cuando el presupuesto
// no alcanza para el agente (`agente.sin_presupuesto`).
//
// Lo que se fija aquí:
//   1. fallo TRANSITORIO (429, 5xx, provider caído) → sale el cuadre real;
//   2. fallo NO transitorio (un bug nuestro) → NO se disfraza de cuadre;
//   3. el cuadre degradado NO cierra la liquidación (cerrado: false): cerrar
//      es una escritura y decidirlo sin el agente sería inventar la decisión;
//   4. si ni el cuadre se puede calcular, queda el mensaje honesto de antes.
// ═══════════════════════════════════════════════════════════════════════════

const runAgent = vi.fn();
const createSignedUrl = vi.fn();
const saveConversation = vi.fn();
// `cierreSinComprobantes: true` simula que el freno de "cierre sin
// comprobantes" (processor.ts) ya preguntó una vez: la mayoría de estas
// pruebas cubren lo que pasa DESPUÉS del cierre (PDF, log, lock), no el freno
// mismo, y con `false` el "listo" nunca llegaba al agente que dicen probar.
// Las pruebas de AUD3 AG-A1 (abajo) lo ponen en `false` a propósito: ahí el
// freno ES el sujeto.
const loadConversation = vi.fn(async () => ({
  id: 'c1',
  turns: [] as { role: 'user' | 'assistant'; content: string }[],
  cierreSinComprobantes: true,
}));
const getOpenViaje = vi.fn<(tenantId: string, operadorId: string) => Promise<string | null>>(async () => 'v1');
const saveCfdiXmlRaw = vi.fn();
const claimMessage = vi.fn<(id: string) => Promise<'nuevo' | 'duplicado' | 'indeterminado'>>(async () => 'nuevo');
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// ── EL ÚNICO BORDE: la Graph API ────────────────────────────────────────────
type Salida = { url: string; body: Record<string, unknown> };
const salientes: Salida[] = [];
/** Contenido de cada media entrante, por `mediaId`. */
const media = new Map<string, string>();

const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
  const u = String(url);
  const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/messages')) {
    salientes.push({ url: u, body: JSON.parse(String(init?.body ?? '{}')) });
    return ok({ messages: [{ id: 'wamid.TEST' }] });
  }
  if (u.startsWith('https://media.test/')) {
    const id = u.slice('https://media.test/'.length);
    return media.has(id)
      ? new Response(media.get(id)!, { status: 200 })
      : new Response('no existe', { status: 404 });
  }
  // Metadatos del media: Meta devuelve la URL real de descarga.
  const id = u.split('/').pop()!;
  return ok({ url: `https://media.test/${id}`, mime_type: 'text/xml' });
});

/** Los mensajes de texto que salieron hacia Meta, en orden. */
const textos = () => salientes.filter((s) => s.body.type === 'text').map((s) => String((s.body.text as { body: string }).body));

vi.mock('@/lib/agents/run', () => ({ runAgent: (...a: unknown[]) => runAgent(...a) }));
vi.mock('@/lib/likida/conv', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveOperador: vi.fn(async () => ({ tenantId: 't1', operadorId: 'o1' })),
  getOpenViaje: (t: string, o: string) => getOpenViaje(t, o),
  getTenantContext: vi.fn(async () => ({ nombre: 'Flota' })),
  loadConversation: (...a: unknown[]) => loadConversation(...(a as [])),
  saveConversation: (...a: unknown[]) => saveConversation(...a),
  claimMessage: (...a: unknown[]) => claimMessage(...(a as [string])),
  acquireViajeLock: vi.fn(async () => true), intentarLockViaje: vi.fn(async () => 'obtenido' as const),
  releaseViajeLock: vi.fn(), releaseMessageClaim: vi.fn(),
  fotoAnteriorSinProcesar: vi.fn(async () => false),
  intakeDelta: vi.fn(async () => 0), esperarIntake: vi.fn(async () => true),
}));
vi.mock('@/lib/likida/repo', () => ({
  ubicarGastoPorHash: vi.fn(async () => null),
  // Sala de espera de comprobantes sin viaje (mig. 0040). Sin estas cuatro,
  // `getHuerfanos` llega `undefined` y el processor truena en el `.length`.
  getHuerfanos: vi.fn(async () => []), guardarHuerfano: vi.fn(async () => true),
  resolverHuerfanos: vi.fn(), marcarHuerfanosOfrecidos: vi.fn(),
  addGasto: vi.fn(), getGastos: vi.fn(async () => []), updateGastoCfdiXml: vi.fn(),
  saveCfdiXmlRaw: (...a: unknown[]) => saveCfdiXmlRaw(...a), gastoExistePorHash: vi.fn(async () => false),
  enriquecerGastoConCodigo: vi.fn(), guardarCodigoPendiente: vi.fn(),
  getCodigosPendientes: vi.fn(async () => []), reclamarCodigoPendiente: vi.fn(),
  // Con datos de responsable y el aviso ya puesto a disposición: sin esto el
  // processor bloquea el tratamiento (LFPDPPP art. 16) y nada de lo de abajo
  // llega a correr.
  getDatosResponsable: vi.fn(async () => ({
    razonSocial: 'FLOTA SA DE CV', domicilio: 'Calle 1, Mérida',
    urlAvisoIntegral: 'https://flota.mx/privacidad',
  })),
  reclamarEnvioAviso: vi.fn(async () => false), liberarEnvioAviso: vi.fn(),
  // `tools.ts` ahora se importa DE VERDAD y estos son sus accesos a datos.
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
    from: (_tabla: string) => {
      const b: Record<string, unknown> = {};
      const self = () => b;
      for (const m of ['select', 'eq', 'gte', 'lte', 'or', 'order', 'in', 'is', 'limit']) b[m] = self;
      b.range = async () => ({ data: [], error: null, count: 0 });
      b.maybeSingle = async () => ({ data: null, error: null });
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
      return b;
    },
    storage: { from: () => ({ createSignedUrl: (...a: unknown[]) => createSignedUrl(...a), upload: async () => ({ error: null }) }) },
  }),
}));
vi.mock('@/lib/logger', () => ({ logger }));
vi.mock('@/lib/likida/intake/cfdi_xml', () => ({
  // `lineas: []` — un CFDI de un solo concepto, NO consolidado (auditoría 10).
  // Sin este campo `esConsolidado` (que sí es real, no mockeado) truena contra
  // `undefined.length` y el processor cae al catch genérico.
  parseCfdiXml: () => ({ uuid: 'uuid-abc', total: 100, fecha: '2026-05-01', lineas: [] }),
  esConsolidado: (xml: { lineas: unknown[] }) => xml.lineas.length > 1,
}));

const avisarCierreAlJefe = vi.fn(async (_a: unknown) => ({ enviado: true }));
vi.mock('./avisar_cierre', () => ({ avisarCierreAlJefe: (a: unknown) => avisarCierreAlJefe(a) }));


// ── EL MOTOR DETERMINÍSTICO, mockeado en su borde ──────────────────────────
// Lo que se prueba es que el processor LO LLAMA cuando el modelo se cae, no
// la aritmética del cuadre (que tiene sus propias pruebas en cuadre/).
const cuadrarDesdeDB = vi.fn(async () => ({ totalComprobado: 1234 }));
vi.mock('@/lib/likida/cuadre/desde_db', () => ({
  cuadrarDesdeDB: (...a: unknown[]) => cuadrarDesdeDB(...(a as [])),
  ventanaDesdeDB: vi.fn(async () => null),
}));
vi.mock('@/lib/likida/cuadre/resumen', () => ({
  resumenCuadre: (_liq: unknown, cerrado: boolean) => `CUADRE REAL (cerrado=${cerrado})`,
}));

const { LlmBudgetExceededError } = await import('@/lib/llm/budget');
const { PartialExecutionError } = await import('@/lib/llm/openrouter');
const { processInbound } = await import('./processor');

/** El tope de $/día TAL COMO LLEGA AL PROCESSOR en producción: `generateWithTools`
 *  envuelve cualquier excepción del ciclo en `PartialExecutionError` con la
 *  causa real en `.cause` (`openrouter.ts`). AUDITORÍA 24, TC-N1: la prueba
 *  anterior rechazaba con el error DESNUDO, que en producción nunca llega así,
 *  y por eso estaba verde sobre una rama muerta. */
const presupuestoAgotadoEnvuelto = () => new PartialExecutionError(
  'presupuesto de IA del día agotado para esta flota: se requieren $0.056 USD y el techo diario es $5.000000 USD',
  new LlmBudgetExceededError('tenant', 5.2, 5.0),
  [], 0, 0, 0,
);
const listo = { from: '5219993700779', type: 'text' as const, text: 'listo', timestampMs: 1788534000000, waMessageId: 'wa1' };

beforeEach(() => {
  salientes.length = 0; media.clear();
  runAgent.mockReset(); createSignedUrl.mockReset();
  logger.info.mockReset(); logger.warn.mockReset(); logger.error.mockReset();
  getOpenViaje.mockReset(); getOpenViaje.mockResolvedValue('v1');
  claimMessage.mockReset(); claimMessage.mockResolvedValue('nuevo');
  saveCfdiXmlRaw.mockReset();
  saveConversation.mockReset(); saveConversation.mockResolvedValue(undefined);
  loadConversation.mockReset();
  loadConversation.mockResolvedValue({ id: 'c1', turns: [], cierreSinComprobantes: true });
  vi.stubGlobal('fetch', fetchSpy);
  fetchSpy.mockClear();
  process.env.WHATSAPP_ACCESS_TOKEN = 'tok-de-prueba';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
  delete process.env.LIKIDA_RECUPERAR_CIERRE_PARCIAL;
});


/** Un fallo TRANSITORIO tal como lo entrega el SDK: el detalle vive en
 *  `.cause` y el nombre es el que `isTransientError` reconoce por tipo. */
const provedorCaido = () => Object.assign(new Error('Connection error.'), {
  name: 'APIConnectionError',
  cause: Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }),
});

describe('RES-15 — el LLM caído no puede dejar al operador sin su cuadre', () => {
  beforeEach(() => { cuadrarDesdeDB.mockClear(); cuadrarDesdeDB.mockResolvedValue({ totalComprobado: 1234 }); });

  it('con el proveedor caído contesta el CUADRE REAL, no "reenvíame el mensaje"', async () => {
    runAgent.mockRejectedValue(provedorCaido());
    await processInbound(listo);

    expect(cuadrarDesdeDB).toHaveBeenCalledWith('t1', 'v1');
    const dichos = textos().join(' | ');
    expect(dichos).toContain('CUADRE REAL');
    expect(dichos).not.toContain('reenvías');
    expect(logger.warn).toHaveBeenCalledWith('agent.degradado_a_cuadre', expect.objectContaining({ viaje: 'v1' }));
  });

  it('y NO lo da por cerrado: cerrar es una escritura, y esa decisión era del agente', async () => {
    runAgent.mockRejectedValue(provedorCaido());
    await processInbound(listo);
    expect(textos().join(' | ')).toContain('cerrado=false');
  });

  it('AUDITORÍA 24, AGEN-10: el cuadre degradado DICE que no cerró y qué hacer (reincidente desde la 22)', async () => {
    runAgent.mockRejectedValue(provedorCaido());
    await processInbound(listo);
    const dichos = textos().join(' | ');
    expect(dichos).toMatch(/NO\*? cerré/);
    expect(dichos).toMatch(/sigue abierto/);
    expect(dichos).toMatch(/\*listo\*/);
  });

  it('un 429 también degrada (es el caso de todos los días, no el exótico)', async () => {
    runAgent.mockRejectedValue(Object.assign(new Error('Rate limited'), { status: 429 }));
    await processInbound(listo);
    expect(textos().join(' | ')).toContain('CUADRE REAL');
  });

  it('un error NUESTRO no se disfraza de cuadre: sigue diciendo la verdad', async () => {
    runAgent.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'x')"));
    await processInbound(listo);

    expect(cuadrarDesdeDB).not.toHaveBeenCalled();
    expect(textos().join(' | ')).toContain('reenvías');
    expect(logger.error).toHaveBeenCalledWith('agent.fail', expect.objectContaining({ transitorio: false }));
  });

  it('AUDITORÍA 19 (tool-calling CRÍTICO): el tope de $/día agotado también degrada — no es un bug, es un freno de dinero, y el motor puede cuadrar solo', async () => {
    // AUDITORÍA 24, TC-N1: el error ENVUELTO, como llega de verdad.
    runAgent.mockRejectedValue(presupuestoAgotadoEnvuelto());
    await processInbound(listo);

    expect(cuadrarDesdeDB).toHaveBeenCalledWith('t1', 'v1');
    const dichos = textos().join(' | ');
    expect(dichos).toContain('CUADRE REAL');
    expect(dichos).not.toContain('reenvías');
    expect(logger.error).toHaveBeenCalledWith('agent.fail', expect.objectContaining({ transitorio: true, agotoPresupuesto: true }));
  });

  it('TC-N1: con el tope agotado el chofer recibe un mensaje HONESTO — no cerré, tus comprobantes quedan, mañana o que suban el tope', async () => {
    runAgent.mockRejectedValue(presupuestoAgotadoEnvuelto());
    await processInbound(listo);
    const dichos = textos().join(' | ');
    expect(dichos).toMatch(/cupo de IA/);
    expect(dichos).toMatch(/NO\*? cerré/);
    expect(dichos).toMatch(/contralor/);
    expect(dichos, 'le pidió reenviar: reenviar falla igual el resto del día').not.toContain('reenvías');
  });

  it('TC-N1: el desnudo sigue reconociéndose (defensa en profundidad), y un envoltorio de un TypeError NO se disfraza de cuadre', async () => {
    runAgent.mockRejectedValue(new LlmBudgetExceededError('tenant', 5.2, 5.0));
    await processInbound(listo);
    expect(logger.error).toHaveBeenCalledWith('agent.fail', expect.objectContaining({ agotoPresupuesto: true }));

    salientes.length = 0; cuadrarDesdeDB.mockClear(); logger.error.mockReset();
    runAgent.mockRejectedValue(new PartialExecutionError('boom', new TypeError('x is undefined'), [], 0, 0, 0));
    await processInbound({ ...listo, waMessageId: 'wa2' });
    expect(cuadrarDesdeDB).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('agent.fail', expect.objectContaining({ transitorio: false, agotoPresupuesto: false }));
  });

  it('TC-N1: un proveedor caído ENVUELTO también degrada — `isTransientError` mira la causa de fondo', async () => {
    runAgent.mockRejectedValue(new PartialExecutionError('ciclo abortado', provedorCaido(), [], 0, 0, 0));
    await processInbound(listo);
    expect(textos().join(' | ')).toContain('CUADRE REAL');
    expect(logger.error).toHaveBeenCalledWith('agent.fail', expect.objectContaining({ transitorio: true }));
  });

  it('si ni el cuadre se puede calcular, queda el mensaje honesto de antes', async () => {
    runAgent.mockRejectedValue(provedorCaido());
    cuadrarDesdeDB.mockRejectedValue(new Error('base caída'));
    await processInbound(listo);

    expect(textos().join(' | ')).toContain('reenvías');
    expect(logger.error).toHaveBeenCalledWith('agent.degradado_fallo', expect.objectContaining({ viaje: 'v1' }));
  });
});
