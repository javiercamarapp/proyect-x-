import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 4 · ALTO — el cierre sin PDF era invisible para todos.
//
// `guardar_liquidacion` devuelve `pdf_generado: Boolean(pdfPath)` y pone
// `pdfPath = undefined` si `generarLiquidacionPDF` lanza o si el upload a storage
// falla. La liquidación se guarda IGUAL. Pero el processor solo miraba `closed` y
// nunca leía `pdf_generado`: pedía una URL firmada de un objeto inexistente,
// `createSignedUrl` devolvía `{data:null,error}` —y el error se descartaba en el
// destructuring—, `data?.signedUrl` era falsy, no había `else`, y el `catch` no se
// disparaba.
//
// Resultado: la liquidación queda cerrada, el operador espera el documento que
// `prompts.ts` le prometió ("Avísale que le llega su liquidación en PDF"), no
// llega, y en los logs no hay `pdf.send`, ni warn, ni nada. En el demo es el paso
// 3 del guion fallando en silencio.
// ═══════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────────
// AUDITORÍA 5 · ALTO — este archivo mockeaba `@/lib/likida/tools` y
// `@/lib/meta/client` ENTEROS, así que el camino real de envío no se ejecutaba
// nunca y `tools.ts` tenía cobertura cero. Ahora los dos módulos corren de
// verdad: el único borde mockeado es `fetch` hacia la Graph API, y lo que se
// afirma es el SOBRE que sale hacia Meta, no una llamada a un espía.
//
// Ganancia concreta: con el espía, `sendDocument(msg.from, …)` se veía igual
// mandando al `521…` que Meta rechaza que al `52…` que acepta. Ahora no.
// ───────────────────────────────────────────────────────────────────────────

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
const documentos = () => salientes.filter((s) => s.body.type === 'document');

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
  // FASE 3: perfil vacío = sin declarar → calificaEstimuloPeaje da null, el
  // motor preserva la conducta de siempre. Mismo criterio best-effort que
  // getAcumuladoCombustible: desde_db.ts ya lo envuelve en catch.
  getPerfilCrudo: vi.fn(async () => ({})),
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

// AUDITORÍA 25, MEDIO REINCIDENTE — una liquidación CERRADA cuyo PDF no llegó
// al chofer solo producía un `logger.error`: el camino del dinero (la cifra
// ya se afirmó, `pdf_url` ya quedó escrito) sin ninguna alerta real.
// `importOriginal`: el módulo tiene otros exports que sí se usan de verdad
// más abajo en la cadena de imports (p.ej. `contadorDeFallos` en
// `intake/ocr.ts`) — solo se espía `alertarOperador`, todo lo demás real.
const alertarOperador = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@/lib/observability/alerta', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  alertarOperador: (...a: unknown[]) => alertarOperador(...(a as [string, Record<string, unknown>])),
}));

const { processInbound } = await import('./processor');
const { PartialExecutionError } = await import('@/lib/llm/openrouter');

const listo = { from: '5219993700779', type: 'text' as const, text: 'listo', timestampMs: 1788534000000, waMessageId: 'wa1' };

const cierre = (pdf_generado: boolean, pdf_contralor_generado = pdf_generado) => ({
  finalText: 'Listo, cerré tu viaje',
  toolCalls: [{ toolName: 'guardar_liquidacion', args: {}, result: { liquidacion_id: 'L1', pdf_generado, pdf_contralor_generado }, durationMs: 5 }],
  model: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0,
});

beforeEach(() => {
  salientes.length = 0; media.clear();
  runAgent.mockReset(); createSignedUrl.mockReset();
  logger.info.mockReset(); logger.warn.mockReset(); logger.error.mockReset();
  alertarOperador.mockReset();
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

describe('cierre sin PDF: ni se manda un documento que no existe, ni se calla', () => {
  beforeEach(() => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://x/liq.pdf' }, error: null });
  });

  // AUDITORÍA 9, MEDIO REINCIDENTE ×4 (rondas 5, 6, 8 y 9) — el TTL de la liga
  // firmada seguía en 3600s aunque el único consumidor es Meta, que descarga
  // en segundos, y el objeto lleva folio y montos de un ticket. La línea se
  // tocó la ronda pasada (se le puso `acotada`) y el 3600 se dejó intacto —
  // lo que convirtió el hallazgo de "pendiente" a "revisado y no arreglado".
  //
  // AUDITORÍA 24 · AGEN-9 (MEDIO): 60 s dejó de alcanzar cuando se vio lo que
  // hace el OUTBOX. `sendDocument` encola el payload ENTERO —`link` incluido—
  // si el POST a Meta se cae por red, y el cron lo reintenta a los 5 minutos:
  // a esa hora la firma llevaba 240 s vencida, Meta contestaba «medio no
  // descargable» (no reintentable) y el mensaje moría a la octava con su
  // alerta de `salida_muerta`. Ocho intentos garantizados de fallar por cada
  // PDF que tocó una red mala. 15 minutos cubren el reintento de los 5 y los
  // tres siguientes del backoff; sigue siendo una liga corta de un bucket
  // privado, no la hora que las rondas 5-9 quitaron.
  it('la liga firmada del PDF vive 15 min: lo que tarda el outbox en reintentarla, no una hora', async () => {
    runAgent.mockResolvedValue(cierre(true));
    await processInbound(listo);
    expect(createSignedUrl).toHaveBeenCalledWith(expect.any(String), 900);
    // El reintento del outbox (RETRASO_AMBIGUO_SEGUNDOS = 300) tiene que caer
    // DENTRO de la ventana: ese es todo el hallazgo.
    const [, ttl] = createSignedUrl.mock.calls[0] as [string, number];
    expect(ttl).toBeGreaterThan(300);
  });

  it('con pdf_generado=true manda el documento (control: sin esto lo de abajo no prueba nada)', async () => {
    runAgent.mockResolvedValue(cierre(true));
    await processInbound(listo);
    expect(documentos()).toHaveLength(1);
  });

  // Con el cliente real, este `to` es el que de verdad viaja a Meta. Con el
  // espía se veía igual el número que rebota que el que se acepta (M1b).
  it('y lo manda al número que Meta acepta, no al que Meta entregó', async () => {
    runAgent.mockResolvedValue(cierre(true));
    await processInbound(listo);
    expect(documentos()[0].body.to).toBe('529993700779');
    expect(documentos()[0].body.to).not.toBe(listo.from);
  });

  it('con pdf_generado=false NO pide una URL de un objeto que no existe', async () => {
    runAgent.mockResolvedValue(cierre(false));
    await processInbound(listo);
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(documentos()).toHaveLength(0);
  });

  it('con pdf_generado=false deja rastro en el log — antes no había ni una línea', async () => {
    runAgent.mockResolvedValue(cierre(false));
    await processInbound(listo);
    expect(logger.error).toHaveBeenCalledWith('pdf.no_entregado', expect.objectContaining({ viaje: 'v1', pdfGenerado: false }));
  });

  // AUDITORÍA 25, MEDIO REINCIDENTE — el log solo no bastaba: una liquidación
  // CERRADA (la cifra ya se afirmó, `pdf_url` ya quedó escrito) cuyo PDF no
  // llega al chofer es el camino del dinero. Antes de este arreglo, NADA
  // llamaba a `alertarOperador` para `pdf.no_entregado` — `grep -n
  // "alertarOperador" processor.ts` no devolvía nada.
  it('con pdf_generado=false TAMBIÉN dispara una alerta real al operador, no solo el log', async () => {
    runAgent.mockResolvedValue(cierre(false));
    await processInbound(listo);
    expect(alertarOperador).toHaveBeenCalledWith('pdf.no_entregado', expect.objectContaining({ viaje: 'v1', pdfGenerado: false }));
  });

  it('con pdf_generado=false se lo dice al operador, en vez de dejarlo esperando', async () => {
    runAgent.mockResolvedValue(cierre(false));
    await processInbound(listo);
    expect(textos().join('\n')).toMatch(/no pude generarte el PDF|panel/i);
  });

  it('si storage falla al firmar, tampoco se calla', async () => {
    runAgent.mockResolvedValue(cierre(true));
    createSignedUrl.mockResolvedValue({ data: null, error: { message: 'Object not found' } });
    await processInbound(listo);
    expect(documentos()).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith('pdf.no_entregado', expect.objectContaining({ err: 'Object not found' }));
    expect(alertarOperador).toHaveBeenCalledWith('pdf.no_entregado', expect.objectContaining({ err: 'Object not found' }));
    // Y con `codigo` estable (AUDITORÍA 18, M14): es lo que separa esta causa
    // de la siguiente en el fingerprint de Sentry — sin él, la segunda cae en
    // el issue viejo y no notifica.
    expect(logger.error).toHaveBeenCalledWith('pdf.no_entregado', expect.objectContaining({ codigo: expect.stringMatching(/^err:[0-9a-f]{12}$/) }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 8/9 · MEDIO REINCIDENTE — el ejemplar del CONTRALOR podía fallar
// sin que nada se enterara. `pdf_generado` (arriba) refleja SOLO el ejemplar
// del OPERADOR: con el del contralor fallido y el del operador exitoso, el
// operador recibía su PDF normal y el contralor se quedaba sin botón de
// descarga en el panel, sin ningún log que lo distinguiera del camino feliz.
// ═══════════════════════════════════════════════════════════════════════════
describe('el PDF del contralor puede fallar sin que el del operador se entere, pero ya no en silencio', () => {
  beforeEach(() => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://x/liq.pdf' }, error: null });
  });

  it('con pdf_contralor_generado=false (y el del operador en true), deja rastro propio en el log', async () => {
    runAgent.mockResolvedValue(cierre(true, false));
    await processInbound(listo);
    expect(logger.error).toHaveBeenCalledWith('pdf.contralor_no_generado', expect.objectContaining({ viaje: 'v1', liqId: 'L1' }));
  });

  it('con pdf_contralor_generado=false, el operador SIGUE recibiendo su propio PDF sin problema', async () => {
    // El fallo es del ejemplar del contralor, no del operador: los dos se
    // suben por separado (tools.ts) y uno puede fallar sin el otro.
    runAgent.mockResolvedValue(cierre(true, false));
    await processInbound(listo);
    expect(documentos()).toHaveLength(1);
  });

  it('control: con los dos en true, no se agrega ningún log de contralor', async () => {
    runAgent.mockResolvedValue(cierre(true, true));
    await processInbound(listo);
    expect(logger.error).not.toHaveBeenCalledWith('pdf.contralor_no_generado', expect.anything());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 4 · ALTO — el producto pedía el XML y luego se negaba a recibirlo.
//
// `complemento_no_verificable` no está en SOLO_CONTRALOR a propósito: su nota le
// dice al operador "reenvía el XML (el que te manda la gasolinera por correo)".
// Ese texto llega en el MISMO mensaje de cierre, cuando guardar_liquidacion ya
// puso el viaje en 'liquidado'.
//
// El operador obedecía, el corte por "sin viaje abierto" lo mandaba de vuelta, y
// el XML se descartaba SIN GUARDARSE EN NINGÚN LADO. Con él se va el
// acreditamiento de IVA de ese CFDI y los litros que alimentan el estímulo del
// LIF 20-A. Mismo error que ya se corrigió para el medio ARCO: se arregló el caso
// y no la clase.
// ═══════════════════════════════════════════════════════════════════════════
describe('el XML que llega después del cierre no se pierde', () => {
  const xmlDoc = { from: '5219993700779', type: 'document' as const, mediaId: 'm1', waMessageId: 'wa9' };

  // El XML ya no se le sirve al processor desde un espía: se descarga por el
  // camino real (`downloadMediaAsText` → metadatos → contenido), y este mapa es
  // lo que Meta tendría del otro lado.
  beforeEach(() => { getOpenViaje.mockResolvedValue(null); media.set('m1', '<cfdi/>'); });

  it('sin viaje abierto, el XML se conserva por UUID en vez de descartarse', async () => {
    await processInbound(xmlDoc);
    expect(saveCfdiXmlRaw).toHaveBeenCalledWith('t1', 'uuid-abc', null, '<cfdi/>');
  });

  it('y se le dice al operador que sí llegó, no "no tienes viaje abierto"', async () => {
    await processInbound(xmlDoc);
    const dicho = textos().join('\n');
    expect(dicho).toMatch(/Recib.* tu XML/i);
    expect(dicho).not.toMatch(/No tienes un viaje abierto/i);
  });

  // Si la descarga del media falla —el token de WhatsApp vencido el 28-jul—, el
  // XML no existe y NO se puede afirmar que se guardó. Este caso no se podía
  // probar con el espía: `downloadMediaAsText` devolvía lo que el test quisiera.
  it('si Meta no entrega el media, no se inventa un XML guardado', async () => {
    media.delete('m1');
    await processInbound(xmlDoc);
    expect(saveCfdiXmlRaw).not.toHaveBeenCalled();
    expect(textos().join('\n')).toMatch(/No tienes un viaje abierto/i);
  });

  it('un TEXTO sin viaje abierto sigue recibiendo el mensaje de siempre (regresión)', async () => {
    await processInbound({ from: '5219993700779', type: 'text', text: 'hola', waMessageId: 'wa10' });
    expect(textos().join('\n')).toMatch(/No tienes un viaje abierto/i);
    expect(saveCfdiXmlRaw).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 4 · ALTO — el fail-closed del claim se apoyaba en un retry inexistente.
//
// `claimMessage` trataba CUALQUIER error de DB como duplicado, con el argumento
// escrito de que "el retry de Meta lo reprocesará cuando la DB responda". Ese
// retry no existe: `route.ts` responde 200 y trabaja en `after()`, así que Meta
// ya tiene su acuse y no reintenta nunca.
//
// Un blip de Supabase en el insert —pool agotado, 503, timeout— y el "listo" del
// operador desaparecía para siempre: cero mensajes salientes, y un log de nivel
// info que encima mentía llamándolo duplicado. A las 3 a.m. nadie encuentra eso.
// ═══════════════════════════════════════════════════════════════════════════
describe('un claim que no se pudo determinar no puede tragarse el mensaje', () => {
  beforeEach(() => {
    runAgent.mockResolvedValue({ finalText: 'Listo', toolCalls: [], model: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0 });
  });

  it('un DUPLICADO de verdad se sigue descartando', async () => {
    claimMessage.mockResolvedValue('duplicado');
    await processInbound(listo);
    expect(runAgent).not.toHaveBeenCalled();
    expect(salientes, 'salió un mensaje por un duplicado').toHaveLength(0);
  });

  it('un INDETERMINADO se procesa: perder el mensaje es peor que reprocesarlo', async () => {
    claimMessage.mockResolvedValue('indeterminado');
    await processInbound(listo);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(textos().length).toBeGreaterThan(0);
  });

  it('y queda anotado como lo que es, no como un duplicado', async () => {
    claimMessage.mockResolvedValue('indeterminado');
    await processInbound(listo);
    expect(logger.warn).toHaveBeenCalledWith('wa.claim_indeterminado', expect.objectContaining({ id: 'wa1' }));
    expect(logger.info).not.toHaveBeenCalledWith('wa.duplicate', expect.anything());
  });
});

// ── AUDITORÍA 6 · CRÍTICO (rubro agéntico) + CRÍTICO (rubro pruebas) ────────
//
// `guardiaEstado` tenía 17 pruebas como función pura y CERO sobre su cableado.
// El bug vivía justo ahí: `processor.ts` la llamaba con `entrego: false` fijo,
// así que un cierre REAL narrado en pretérito se tachaba y el operador recibía
// "Todavía no he cerrado tu liquidación" seguido del PDF de su liquidación
// cerrada. Las pruebas puras no podían verlo porque usaban `entrego: true`, un
// estado que el cableado nunca produce.
//
// Es la quinta vez en este repo que un mecanismo correcto falla por el cable.
// Por eso estas pruebas van por `processInbound`, no por la guardia.

describe('el cierre real narrado en pretérito no se desmiente a sí mismo', () => {
  beforeEach(() => {
    createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://x/liq.pdf' }, error: null });
  });

  const enPreterito = {
    ...cierre(true),
    finalText: 'Comprobaste $4,850.00 contra un anticipo de $5,000.00. Te quedan $150.00 a tu favor. Ya te envié tu liquidación, en un momento te llega el PDF. 🚛',
  };

  it('NUNCA le dice "todavía no he cerrado" mientras le manda el PDF', async () => {
    runAgent.mockResolvedValue(enPreterito);
    await processInbound(listo);
    // La contradicción que la auditoría 6 dio por viva: el texto negando el
    // cierre y el documento de ese mismo cierre saliendo a continuación.
    expect(textos().join(' ')).not.toContain('Todavía no he cerrado');
    expect(documentos()).toHaveLength(1);
  });

  it('no registra un estado falso que no ocurrió', async () => {
    runAgent.mockResolvedValue(enPreterito);
    await processInbound(listo);
    expect(logger.error).not.toHaveBeenCalledWith('agent.estado_falso', expect.anything());
  });

  // POR QUÉ NO OCURRÍA, y es lo que el hallazgo no vio: en todo cierre real
  // `guardiaCifras` sustituye el texto (`guardia.ts:37-38` cuenta
  // `guardar_liquidacion` como cuadre, y la línea 79 devuelve `forzado: true`
  // SIEMPRE que hubo cuadre). Eso deja `textoDeterminista` en true y el
  // `if (!textoDeterminista)` de `processor.ts` impide que `guardiaEstado`
  // corra. La rama del falso positivo era inalcanzable.
  //
  // Esta prueba fija ese acoplamiento, que hasta hoy no lo fijaba nadie: si
  // alguien hace que `guardiaCifras` deje de forzar en el cierre, `guardiaEstado`
  // empieza a correr con `cerro=true` y este archivo lo dice de inmediato.
  it('en el cierre el texto lo escribe el motor, no el modelo', async () => {
    runAgent.mockResolvedValue(enPreterito);
    await processInbound(listo);
    expect(textos()[0]).not.toBe(enPreterito.finalText);
    expect(textos()[0]).toContain('Listo, cuadré tu viaje');
  });

  it('pero SÍ desmiente el cierre inventado, que es para lo que existe la guardia', async () => {
    // Sin `guardar_liquidacion` en las tool calls, `closed` es false: el modelo
    // está afirmando un hecho que nadie ejecutó.
    runAgent.mockResolvedValue({
      finalText: 'Ya quedó cerrada tu liquidación ✅. En un momento te llega el PDF.',
      toolCalls: [], model: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0,
    });
    await processInbound(listo);
    expect(textos()[0]).toContain('Todavía no he cerrado');
    expect(documentos()).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith('agent.estado_falso', expect.anything());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 7 · ALTO REINCIDENTE de ronda 6 — `ctxCerro` no se actualiza en la
// recuperación de cierre parcial.
//
// `ctxCerro` es el Único campo que el log de fallo trae para distinguir "no pasó
// nada" de "la liquidación YA se cerró y el operador se quedó sin nada". La
// rama de recuperación de cierre parcial (activa con
// LIKIDA_RECUPERAR_CIERRE_PARCIAL=1, que .env.example recomienda ENCENDIDA)
// ponía `closed = true` pero nunca tocaba `ctxCerro`: si algo tronaba DESPUÉS
// de la recuperación (p. ej. `saveConversation`), el log del catch general
// decía `cerroSinEntregar: false` sobre una liquidación que SÍ se cerró.
//
// Se fuerza el escenario completo: `runAgent` lanza `PartialExecutionError` con
// `guardar_liquidacion` YA ejecutado en las tool calls parciales, y
// `saveConversation` (lo Último que corre en el camino feliz) truena. El único
// rastro que puede decir la verdad es el log del catch general.
// ═══════════════════════════════════════════════════════════════════════════
describe('ctxCerro en la recuperación de cierre parcial (AUD-7 ALTO-1)', () => {
  beforeEach(() => {
    process.env.LIKIDA_RECUPERAR_CIERRE_PARCIAL = '1';
    createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://x/liq.pdf' }, error: null });
  });

  it('el log del catch general dice la verdad: la liquidación SÍ se cerró', async () => {
    const parcial = [{ toolName: 'guardar_liquidacion', args: {}, result: { liquidacion_id: 'L1', pdf_generado: true }, durationMs: 5 }];
    runAgent.mockRejectedValue(new PartialExecutionError('boom', new Error('boom'), parcial, 10, 10, 0));
    // Lo último del camino feliz truena DESPUÉS de que la recuperación ya marcó
    // el cierre: aquí es donde `ctxCerro` tenía que haber quedado en `true`.
    saveConversation.mockRejectedValue(new Error('db down'));
    await processInbound(listo);
    expect(logger.error).toHaveBeenCalledWith('processInbound.fail', expect.objectContaining({ cerroSinEntregar: true }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 3 · ALTO AG-A1 — el "ya" pelón era orden de cierre irreversible.
//
// El escenario del hallazgo: chofer a mitad de ruta con 8 tickets registrados
// recibe el mensaje de cobranza ("Si el viaje ya terminó y falta cerrarlo,
// dime y seguimos con eso") y contesta "ya voy". `pareceCierre` empataba `ya`
// seguido de CUALQUIER cosa, y el prompt listaba "ya" pelón como disparador de
// cierre inmediato → `guardar_liquidacion` cerraba a mitad de viaje, los
// triggers 0036/0037 bloqueaban todo lo posterior, los tickets del regreso
// caían a huérfanos `tras_liquidar` y el PDF salía con una diferencia en
// contra del operador que no es la del viaje.
//
// El arreglo es determinístico, no de prompt: "ya" solo cuenta acompañado de
// su forma fuerte ("ya está", "ya quedó", "ya terminé"...). Estas pruebas van
// por `processInbound` con el freno ACTIVO (cierreSinComprobantes: false y
// cero gastos), donde la clasificación de `pareceCierre` es observable: si el
// texto parece cierre, el freno contesta y el agente NO corre; si no lo
// parece, el mensaje sigue su camino normal al agente.
// ═══════════════════════════════════════════════════════════════════════════
describe('AUD3 AG-A1: "ya" pelón y "ya voy" NO son cierre; las formas fuertes sí', () => {
  beforeEach(() => {
    // El freno queda ACTIVO: aún no se le ha preguntado nada a este chofer.
    loadConversation.mockResolvedValue({ id: 'c1', turns: [], cierreSinComprobantes: false });
    // Texto neutro a propósito: no afirma un cierre, para no despertar guardias.
    runAgent.mockResolvedValue({
      finalText: 'Aquí sigo, mándame tus comprobantes cuando puedas.',
      toolCalls: [], model: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0,
    });
  });

  /** El aviso del freno de cierre sin comprobantes, si salió. */
  const avisosDelFreno = () => textos().filter((t) => /ning[úu]n comprobante/i.test(t));

  it.each(['ya', 'ya voy'])(
    '"%s" NO dispara el freno de cierre: sigue su camino al agente',
    async (texto) => {
      await processInbound({ from: '5219993700779', type: 'text', text: texto, timestampMs: 1788534000000, waMessageId: `wa-${texto}` });
      expect(avisosDelFreno(), `el freno trató "${texto}" como cierre`).toHaveLength(0);
      expect(runAgent).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['ya está', 'ya quedó', 'listo', 'terminé', 'ya terminé', 'ya no tengo más'])(
    '"%s" SÍ parece cierre: con cero comprobantes el freno pregunta antes de cerrar',
    async (texto) => {
      await processInbound({ from: '5219993700779', type: 'text', text: texto, timestampMs: 1788534000000, waMessageId: `wa-${texto}` });
      expect(avisosDelFreno(), `"${texto}" dejó de contar como cierre`).toHaveLength(1);
      expect(runAgent).not.toHaveBeenCalled();
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 18, MEDIO (M26 + M27): el jefe recibía el ejemplar del OPERADOR
// (los veredictos SOLO_CONTRALOR recortados) y, si el PDF del operador no se
// generaba, no recibía NADA — el aviso vivía dentro del try del papel del chofer.
// ═══════════════════════════════════════════════════════════════════════════
describe('el aviso al jefe: con el PDF completo y aunque el del operador falle', () => {
  beforeEach(() => {
    avisarCierreAlJefe.mockClear();
    createSignedUrl.mockImplementation(async (path: string) => ({ data: { signedUrl: `https://x/${path}` }, error: null }));
  });

  it('M26: el PDF que se le manda al jefe es el COMPLETO (`viaje.pdf`), no el `-operador.pdf`', async () => {
    runAgent.mockResolvedValue(cierre(true));
    await processInbound(listo);
    expect(avisarCierreAlJefe).toHaveBeenCalledTimes(1);
    const { urlPdf } = avisarCierreAlJefe.mock.calls[0][0] as { urlPdf: string };
    expect(urlPdf).toMatch(/\/v1\.pdf$/);
    expect(urlPdf).not.toContain('-operador');
    // Y el chofer sigue recibiendo el suyo: dos firmas, una por ejemplar, y
    // el documento que sale hacia su número es el `-operador`.
    const rutas = createSignedUrl.mock.calls.map((c) => c[0] as string);
    expect(rutas).toContain('t1/v1-operador.pdf');
    expect(rutas).toContain('t1/v1.pdf');
    expect(JSON.stringify(documentos()[0].body)).toContain('v1-operador.pdf');
  });

  it('M27: con pdf_generado=false el jefe RECIBE el aviso igual (sin adjunto si tampoco hay ejemplar completo)', async () => {
    runAgent.mockResolvedValue(cierre(false));
    await processInbound(listo);
    expect(avisarCierreAlJefe).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', viajeId: 'v1', urlPdf: null }));
  });

  it('M27: el del operador falló pero el completo existe → el jefe recibe aviso Y su PDF', async () => {
    runAgent.mockResolvedValue(cierre(false, true));
    await processInbound(listo);
    const { urlPdf } = avisarCierreAlJefe.mock.calls[0][0] as { urlPdf: string | null };
    expect(urlPdf).toMatch(/\/v1\.pdf$/);
  });
});
