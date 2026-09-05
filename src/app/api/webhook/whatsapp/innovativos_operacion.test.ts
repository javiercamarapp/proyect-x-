// Ensayo de fronteras Innovativos: entradas HTTP firmadas y motor/PDF reales.
// Sólo I/O externo y persistencia se sustituyen; nunca se llama a proveedores.
// Desde POST con HMAC real: foto → OCR sintético → persistencia doble →
// reenvío por hash sin duplicar → cierre con motor determinístico y PDF real.
// También captura el prompt que llega al SDK e inyecta fallos de Storage y DB.
// DB/repositorios, OCR y transportes son dobles; no certifica proveedores reales.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type { Gasto, Viaje, Operador } from '@/types/likida';
import { hoyMx } from '@/lib/formato';

// DAT-28: el día de MÉXICO, como el que `ventanaDelViaje` usa desde el
// arreglo. Con el día UTC, corriendo la prueba después de las 18:00 hora local
// los comprobantes quedaban fechados MAÑANA y el motor los marcaba —con razón—
// como del futuro.
const HOY = hoyMx();
const VIAJE: Viaje = { id: 'v1', folio: 'VJ-1', origen: 'Mérida', destino: 'Cancún', anticipo: 8000, fechaInicio: HOY };
const OPERADOR: Operador = { id: 'o1', nombre: 'Juan Pérez', telefono: '5219993700779', terminal: 'Mérida' };
const GASTOS: Gasto[] = [
  {
    id: 'g-caseta', concepto: 'caseta', monto: 800, fecha: HOY,
    folio: 'C-778', cfdiUuid: '22222222-2222-2222-2222-222222222222',
    rfcEmisor: 'CAP980713RG9', rfcReceptor: 'CCO8605231N4',
    claveProdServ: '95111602', tipoComprobante: 'I', xmlVerificado: true, formaPago: '03',
    subTotal: 689.66, ivaTraslado: 110.34, ocrConfianza: 0.95, estadoSat: 'vigente', efos: false,
  },
  {
    id: 'g-diesel', concepto: 'diesel', monto: 3500, fecha: HOY,
    folio: 'A-10231', cfdiUuid: '11111111-1111-1111-1111-111111111111',
    rfcEmisor: 'PEP970101P77', rfcReceptor: 'CCO8605231N4',
    claveProdServ: '15101505', claveUnidad: 'LTR', tipoComprobante: 'I',
    complementoHidrocarburos: true, xmlVerificado: true, formaPago: '03',
    subTotal: 2426.72, ivaTraslado: 388.28, iepsTraslado: 685,
    ocrExtra: { litros: 130 }, ocrConfianza: 0.96, estadoSat: 'vigente', efos: false,
  },
];

const GASTOS_BASE = [...GASTOS];
const TENANT = 't1';
const DESDE_META = '5219993700779';

// ── BORDE 1: el LLM ─────────────────────────────────────────────────────────
const create = vi.fn();
vi.mock('openai', () => ({
  default: class { chat = { completions: { create: (...a: unknown[]) => create(...a) } }; },
}));

// ── BORDE 2: Supabase (datos) — el mismo doble que processor_cadena ─────────
const saveLiquidacion = vi.fn(async (..._args: unknown[]) => 'L1');
vi.mock('@/lib/likida/repo', () => ({
  ubicarGastoPorHash: vi.fn(async () => null),
  getHuerfanos: vi.fn(async () => []), guardarHuerfano: vi.fn(async () => true),
  resolverHuerfanos: vi.fn(), marcarHuerfanosOfrecidos: vi.fn(),
  getViaje: vi.fn(async () => VIAJE),
  getOperador: vi.fn(async () => OPERADOR),
  getGastos: vi.fn(async () => GASTOS),
  saveLiquidacion: (...a: unknown[]) => saveLiquidacion(...(a as [])),
  leerSnapshotInsumosCierre: vi.fn(async () => ({ version: 1, hash: 'a'.repeat(64) })),
  insumosDeCierreCambiaron: (e: unknown) => ['CU003', 'CU006'].includes(String((e as { code?: string } | null)?.code ?? '')),
  getLiquidacionDeViaje: vi.fn(async () => undefined),
  getAcumuladoCombustible: vi.fn(async () => ({ efectivo: 0, totalCombustible: 0 })),
  // FASE 3: perfil vacío = sin declarar; desde_db.ts lo envuelve en catch.
  getPerfilCrudo: vi.fn(async () => ({})),
  addGasto: vi.fn(async (_t: string, _v: string, gasto: Gasto) => { GASTOS.push({ ...gasto, id: 'g-image' }); }), updateGastoCfdiXml: vi.fn(), saveCfdiXmlRaw: vi.fn(),
  gastoExistePorHash: vi.fn(async () => GASTOS.some(g => g.imgHash === 'HASH-IMAGE')), enriquecerGastoConCodigo: vi.fn(),
  guardarCodigoPendiente: vi.fn(), getCodigosPendientes: vi.fn(async () => []),
  reclamarCodigoPendiente: vi.fn(),
  gastoPorHash: vi.fn(async () => GASTOS.find(g => g.imgHash === 'HASH-IMAGE')),
  existeFotoPendiente: vi.fn(async () => false), guardarFotoPendiente: vi.fn(async () => null), reclamarFotoPendiente: vi.fn(async () => null),
  getDatosResponsable: vi.fn(async () => ({
    razonSocial: 'TRANSPORTES DEL SURESTE SA DE CV',
    domicilio: 'Av. Itzáes 500, Mérida, Yucatán',
    urlAvisoIntegral: 'https://transportesdelsureste.mx/privacidad',
  })),
  reclamarEnvioAviso: vi.fn(async () => false), liberarEnvioAviso: vi.fn(),
}));
vi.mock('@/lib/likida/conv', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveOperador: vi.fn(async () => ({ tenantId: TENANT, operadorId: 'o1' })),
  getOpenViaje: vi.fn(async () => 'v1'),
  viajeAbiertoDesdeMs: vi.fn(async () => 1_700_000_000_000),
  loadConversation: vi.fn(async () => ({ id: 'c1', turns: [] })),
  saveConversation: vi.fn(),
  claimMessage: vi.fn(async () => 'nuevo'),
  acquireViajeLock: vi.fn(async () => true), intentarLockViaje: vi.fn(async () => 'obtenido' as const),
  releaseViajeLock: vi.fn(), releaseMessageClaim: vi.fn(), completarMessageClaim: vi.fn(),
  intakeDelta: vi.fn(async () => 0), esperarIntake: vi.fn(async () => true),
}));
vi.mock('@/lib/likida/costos', () => ({
  registrarCosto: vi.fn(), registrarCostoWhatsApp: vi.fn(),
  faseDeModelo: vi.fn(() => 'cuadre'), vincularCostosALiquidacion: vi.fn(),
}));

// ── BORDE 3: Supabase (storage + tablas genéricas) ─────────────────────────
let falloStorage = false;
const subidos = new Map<string, Uint8Array>();
const URL_FIRMADA = 'https://sb.test/firmada/liq-operador.pdf?token=abc';
/** Las corridas que la bitácora recibió — el eslabón 0115 del canal. */
const corridas: Array<Record<string, unknown>> = [];
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      const b: Record<string, unknown> = {};
      const self = () => b;
      for (const m of ['select', 'eq', 'gte', 'lte', 'lt', 'or', 'order', 'in', 'is', 'not', 'limit']) b[m] = self;
      b.range = async () => ({ data: [], error: null, count: 0 });
      // `interruptor` responde SIN FILA = encendido: el route y tools.ts
      // consultan el estaApagado REAL a través de este builder — el kill
      // switch corre de verdad en este E2E, no como doble.
      b.maybeSingle = async () => (tabla === 'tenant'
        ? { data: { nombre: 'Transportes Innovativos — sintético', rfc: 'CCO8605231N4', config: null }, error: null }
        : { data: null, error: null });
      b.insert = async (fila: Record<string, unknown>) => {
        if (tabla === 'agente_corrida') corridas.push(fila);
        return { error: null };
      };
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
      return b;
    },
    storage: {
      from: () => ({
        upload: async (path: string, buf: Buffer) => {
          if (falloStorage) return { error: { message: 'Storage unavailable synthetic' } };
          subidos.set(path, new Uint8Array(buf));
          return { error: null };
        },
        createSignedUrl: async (path: string) => (subidos.has(path)
          ? { data: { signedUrl: URL_FIRMADA }, error: null }
          : { data: null, error: { message: `no existe: ${path}` } }),
      }),
    },
  }),
}));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger }));
vi.mock('@/lib/observability/sentry', () => ({
  flushObservabilidad: vi.fn(async () => {}), codigoDeError: () => 'x',
}));
// La bandeja del apagado no participa: el sistema está ENCENDIDO en este E2E
// (su propio contrato vive en apagado.test.ts + wa-pendientes).
const { bandejaInbox } = vi.hoisted(() => ({ bandejaInbox: new Map<string, unknown>() }));
vi.mock('@/lib/likida/wa_pendientes', () => ({
  // DAT-34: la deduplicación previa al rate limit. Vacío = ninguno de estos
  // wamids estaba ya en la bandeja, que es el caso de una entrega normal.
  pendientesYaConocidos: async () => new Set<string>(),
  // El inbox general (16-ago-2026): el E2E pasa por persistir → reclamar →
  // procesar, como producción.
  guardarEventosPendientes: vi.fn(async (ms: Array<{ waMessageId?: string }>) => {
    const filas = ms.map((m, i) => {
      const id = m.waMessageId ?? `f-${i}`;
      bandejaInbox.set(id, m);
      return { id, evento: m, guardado: true };
    });
    return { guardados: filas.length, fallidos: 0, filas };
  }),
  reclamarPendiente: async (id: string) =>
    (bandejaInbox.has(id) ? { id, evento: bandejaInbox.get(id), intentos: 1 } : null),
  marcarPendienteProcesado: async () => undefined,
  anotarFalloPendiente: async () => undefined,
  devolverIntentoPendiente: async () => undefined,
  iniciarRenovacionLease: () => () => {},
}));

// ── BORDE 4: la Graph API ───────────────────────────────────────────────────
type Salida = { url: string; body: Record<string, unknown> };
const salientes: Salida[] = [];
const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
  salientes.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
  return new Response(JSON.stringify({ messages: [{ id: 'wamid.TEST' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
});

// ── El ROUTE con su after() capturado (patrón apagado.test.ts) ──────────────
const SECRETO_APP = 'app-secret-e2e';
process.env.WHATSAPP_APP_SECRET = SECRETO_APP;
const pendientes: Array<() => unknown> = [];
vi.mock('next/server', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, after: (fn: () => unknown) => { pendientes.push(fn); } };
});

const extraer = vi.fn(async (..._args: unknown[]) => ({ legible: true, gasto: { concepto: 'alimentacion', monto: 900, fecha: HOY, folio: 'IMG-1', ocrConfianza: 0.99 }, costo: { modelo: 'sintetico', tokensIn: 1, tokensOut: 1, costoUsd: 0 } }));
vi.mock('@/lib/likida/intake/ocr', () => ({ extraerComprobante: (...args: unknown[]) => extraer(...args), tieneCodigoLegible: async () => false }));
vi.mock('@/lib/likida/intake/hash', () => ({ hashImagen: async () => 'HASH-IMAGE' }));
vi.mock('@/lib/likida/intake/almacen', () => ({ subirComprobante: async () => 't1/v1/HASH-IMAGE.jpg', ligaComprobante: async () => null }));
vi.mock('@/lib/meta/client', async original => ({ ...(await original<Record<string, unknown>>()), downloadMediaAsDataUrl: async () => 'data:image/jpeg;base64,AAAA' }));
const { POST } = await import('./route');

const firmar = (body: string) => 'sha256=' + crypto.createHmac('sha256', SECRETO_APP).update(body).digest('hex');
const payloadMeta = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ id: '1395114249160000', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    messages: [{
      from: DESDE_META, id: 'wamid.E2E', timestamp: '1800000000',
      type: 'text', text: { body: 'listo' },
    }],
  } }] }],
});

const conTool = (nombre: string) => ({
  choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: nombre, arguments: '{}' } }] } }],
  usage: { prompt_tokens: 900, completion_tokens: 60 },
  model: 'anthropic/claude-sonnet-5',
});
const final = (texto: string) => ({
  choices: [{ finish_reason: 'stop', message: { content: texto, tool_calls: [] } }],
  usage: { prompt_tokens: 1200, completion_tokens: 90 },
  model: 'anthropic/claude-sonnet-5',
});

beforeEach(() => {
  falloStorage = false;
  GASTOS.splice(0, GASTOS.length, ...GASTOS_BASE);
  extraer.mockClear();
  subidos.clear();
  bandejaInbox.clear();
  salientes.length = 0;
  corridas.length = 0;
  pendientes.length = 0;
  create.mockReset();
  saveLiquidacion.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
  fetchSpy.mockClear();
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.WHATSAPP_ACCESS_TOKEN = 'tok-de-prueba';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
  create.mockResolvedValueOnce(conTool('guardar_liquidacion')).mockResolvedValueOnce(final('Listo, cerré tu viaje.'));
});

async function postearFirmado(payload = payloadMeta) {
  const res = await POST(new Request('https://app.likida.ai/api/webhook/whatsapp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': firmar(payload) },
    body: payload,
  }) as never);
  while (pendientes.length) await pendientes.shift()!();
  return res;
}

describe('Innovativos: fronteras encadenadas desde HTTP firmado', () => {
  it('el system enviado al SDK es el prompt registrado real, con tenant y guardas, sin prompt alterno', async () => {
    await postearFirmado();
    expect(create).toHaveBeenCalledTimes(2);
    const first = create.mock.calls[0][0];
    const systems = first.messages.filter((m: { role: string }) => m.role === 'system');
    expect(systems).toHaveLength(1);
    const serialized = JSON.stringify(systems[0].content);
    expect(serialized).toContain('Transportes Innovativos — sintético');
    expect(serialized).toContain('NUNCA inventes ni narres los números');
    expect(serialized).toContain('Tú NO autorizas dinero');
    const names = first.tools.map((t: { function: { name: string } }) => t.function.name).sort();
    expect(names).toEqual(['consultar_politica', 'cuadrar_viaje', 'estado_viaje', 'guardar_liquidacion']);
    expect(corridas.filter(c => c.agente === 'liquidacion')).toHaveLength(1);
  });
  it('Storage caído preserva cierre contable y comunica PDF faltante sin entregar documento ficticio', async () => {
    falloStorage = true;
    await postearFirmado();
    expect(saveLiquidacion).toHaveBeenCalledTimes(1);
    expect(subidos.size).toBe(0);
    expect(salientes.filter(s => s.body.type === 'document')).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith('pdf.no_entregado', expect.anything());
    expect(salientes.filter(s => s.body.type === 'text').map(s => JSON.stringify(s.body)).join(' ')).toMatch(/no pude generarte el PDF/);
  });
  it('fallo de persistencia no inventa cierre ni entrega PDF como liquidación cerrada', async () => {
    saveLiquidacion.mockRejectedValueOnce(new Error('synthetic database write failure'));
    await postearFirmado();
    expect(saveLiquidacion).toHaveBeenCalledTimes(1);
    expect(salientes.filter(s => s.body.type === 'document')).toHaveLength(0);
    expect(salientes.filter(s => s.body.type === 'text').map(s => JSON.stringify(s.body)).join(' ')).not.toContain('cerré tu viaje');
  });
});

function fotoMeta(id: string): string {
  const payload = JSON.parse(payloadMeta);
  payload.entry[0].changes[0].value.messages[0] = {
    from: DESDE_META, id, timestamp: '1800000000', type: 'image',
    image: { id: 'media-1', mime_type: 'image/jpeg' },
  };
  return JSON.stringify(payload);
}

describe('Innovativos: foto a cierre por el mismo canal', () => {
  it('la foto se captura una vez, replay de foto no paga OCR ni duplica gasto y cierre incluye monto exacto', async () => {
    await postearFirmado(fotoMeta('wamid.IMG1'));
    expect(extraer).toHaveBeenCalledTimes(1);
    expect(GASTOS).toHaveLength(3);
    expect(create).not.toHaveBeenCalled();
    await postearFirmado(fotoMeta('wamid.IMG2'));
    expect(extraer).toHaveBeenCalledTimes(1);
    expect(GASTOS).toHaveLength(3);
    await postearFirmado();
    expect(saveLiquidacion).toHaveBeenCalledTimes(1);
    const liq = saveLiquidacion.mock.calls[0][1] as unknown as { totalComprobado: number };
    expect(liq.totalComprobado).toBe(5200);
    expect(salientes.filter(s => s.body.type === 'document')).toHaveLength(1);
  });
});
