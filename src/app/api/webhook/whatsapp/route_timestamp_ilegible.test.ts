// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28 · BE-A4 (ALTO) — un `timestamp` de Meta ilegible era SILENCIO
// TOTAL: `timestampMs` salía `undefined` y ni un log decía que Meta mandó
// algo que no se pudo leer. El motor (`processor.ts`) aplazaba el "listo"
// PARA SIEMPRE sobre esa fila, sin presupuesto que agotar.
//
// El arreglo es aditivo: `recibidoMs` (la hora de NUESTRO servidor, cota
// superior honesta de la real) se pone SOLO cuando `timestampMs` no se pudo
// leer, y se deja un `logger.warn('webhook.timestamp_ilegible')` que hoy no
// existía. Mismo arnés que `route_caption.test.ts` (POST real, firma real).
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

const SECRETO = 'app-secret-de-prueba-ts';
process.env.WHATSAPP_APP_SECRET = SECRETO;

const processInbound = vi.fn(async (_m: unknown) => {});
vi.mock('@/lib/likida/processor', () => ({ processInbound: (m: unknown) => (processInbound as (m: unknown) => Promise<void>)(m) }));
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger }));
vi.mock('@/lib/observability/sentry', () => ({ flushObservabilidad: vi.fn(async () => {}) }));
vi.mock('@/lib/likida/interruptores', () => ({
  estaApagado: vi.fn(async () => false),
  leerInterruptor: vi.fn(async () => 'encendido' as const),
}));

const pendientes: Array<() => unknown> = [];
vi.mock('next/server', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, after: (fn: () => unknown) => { pendientes.push(fn); } };
});

const { bandejaInbox } = vi.hoisted(() => ({ bandejaInbox: new Map<string, unknown>() }));
vi.mock('@/lib/likida/wa_pendientes', () => ({
  pendientesYaConocidos: async () => new Set<string>(),
  guardarEventosPendientes: async (ms: Array<{ waMessageId?: string }>) => {
    const filas = ms.map((m, i) => {
      const id = m.waMessageId ?? `f-${i}`;
      bandejaInbox.set(id, m);
      return { id, evento: m, guardado: true };
    });
    return { guardados: filas.length, fallidos: 0, filas };
  },
  reclamarPendiente: async (id: string) =>
    (bandejaInbox.has(id) ? { id, evento: bandejaInbox.get(id), intentos: 1 } : null),
  marcarPendienteProcesado: async () => undefined,
  anotarFalloPendiente: async () => undefined,
}));

const { POST } = await import('./route');

const firmar = (body: string) =>
  'sha256=' + crypto.createHmac('sha256', SECRETO).update(body).digest('hex');

async function postear(body: string) {
  const res = await POST(new Request('https://likidaai.vercel.app/api/webhook/whatsapp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': firmar(body) },
    body,
  }) as never);
  while (pendientes.length) await pendientes.shift()!();
  return res;
}

const payload = (from: string, mensaje: Record<string, unknown>) => JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ id: '1395114249160000', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    messages: [{ from, ...mensaje }],
  } }] }],
});

beforeEach(() => {
  processInbound.mockReset(); processInbound.mockImplementation(async () => {});
  pendientes.length = 0;
  logger.warn.mockReset();
});

describe('DAT-38/BE-A4 · timestamp ilegible de Meta', () => {
  it('`timestamp: "x"` => timestampMs undefined, recibidoMs numérico, y logger.warn', async () => {
    const antes = Date.now();
    const c = payload('5219991110009', { id: 'wamid.TS1', timestamp: 'x', type: 'text', text: { body: 'hola' } });
    expect((await postear(c)).status).toBe(200);

    const msg = processInbound.mock.calls[0][0] as { timestampMs?: number; recibidoMs?: number };
    expect(msg.timestampMs).toBeUndefined();
    expect(typeof msg.recibidoMs).toBe('number');
    expect(msg.recibidoMs).toBeGreaterThanOrEqual(antes);

    expect(logger.warn).toHaveBeenCalledWith('webhook.timestamp_ilegible', expect.objectContaining({ waMessageId: 'wamid.TS1', crudo: 'x' }));
  });

  it('sin `timestamp` en absoluto => mismo comportamiento (undefined, no ausencia silenciosa)', async () => {
    const c = payload('5219991110010', { id: 'wamid.TS2', type: 'text', text: { body: 'hola' } });
    expect((await postear(c)).status).toBe(200);
    const msg = processInbound.mock.calls[0][0] as { timestampMs?: number; recibidoMs?: number };
    expect(msg.timestampMs).toBeUndefined();
    expect(typeof msg.recibidoMs).toBe('number');
  });

  it('con timestamp VÁLIDO no hay `recibidoMs` ni warning — el camino de siempre', async () => {
    const c = payload('5219991110011', { id: 'wamid.TS3', timestamp: '1714510003', type: 'text', text: { body: 'hola' } });
    expect((await postear(c)).status).toBe(200);
    const msg = processInbound.mock.calls[0][0] as { timestampMs?: number; recibidoMs?: number };
    expect(msg.timestampMs).toBe(1714510003000);
    expect(msg.recibidoMs).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalledWith('webhook.timestamp_ilegible', expect.anything());
  });
});
