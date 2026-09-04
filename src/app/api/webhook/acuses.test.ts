import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// CRÍTICO de la auditoría 5 (agéntico): "El PDF se da por entregado con el 200
// de Meta, y el aviso de que no se entregó se tira sin leerlo."
//
// EL CASO REAL, del 28-jul-2026. Una liquidación cerró, el PDF se generó y se
// subió a storage —comprobado en la base y en el bucket— y el operador no lo
// recibió. No hubo `pdf.no_entregado` ni error de envío: el 200 de Meta
// significa ACEPTADO, no ENTREGADO, y el fallo real llega después por este mismo
// webhook, en `value.statuses`. `extractMessages` solo leía `value.messages`,
// así que ese aviso devolvía `{"received":0}` y se descartaba.
//
// Se perdieron veinte minutos reconstruyendo a mano lo que este log dice en una
// línea.

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const rpc = vi.fn(async () => ({ data: 1, error: null }));
vi.mock('@/lib/logger', () => ({ logger }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ rpc }) }));
vi.mock('@/lib/likida/processor', () => ({ processInbound: vi.fn() }));
vi.mock('@/lib/meta/client', () => ({
  verifyWebhookChallenge: () => false,
  esReintentableMeta: () => false,
  verifySignature: () => true,          // la firma no es lo que se prueba aquí
}));
vi.mock('next/server', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, after: (fn: () => unknown) => fn() };
});

const { POST } = await import('./whatsapp/route');

const pedir = (body: unknown) =>
  POST(new Request('https://likidaai.vercel.app/api/webhook/whatsapp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=x' },
    body: JSON.stringify(body),
  }) as never);

const conStatus = (status: string, extra: Record<string, unknown> = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '1395114249160000', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    statuses: [{ id: 'wamid.PDF123', status, recipient_id: '5219993700779', ...extra }],
  } }] }],
});

const conStatuses = (statuses: Array<Record<string, unknown>>) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '1395114249160000', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    statuses,
  } }] }],
});

beforeEach(() => { logger.info.mockReset(); logger.warn.mockReset(); logger.error.mockReset(); rpc.mockReset(); rpc.mockResolvedValue({ data: 1, error: null }); });
afterEach(() => { vi.useRealTimers(); });

describe('acuses de entrega de WhatsApp', () => {
  it('un mensaje que NO se entregó deja un error con el wamid y la causa', async () => {
    await pedir(conStatus('failed', {
      errors: [{ code: 131026, title: 'Message undeliverable', error_data: { details: 'Receiver incapable' } }],
    }));

    expect(logger.error).toHaveBeenCalledWith('wa.no_entregado', expect.objectContaining({
      id: 'wamid.PDF123', codigo: 131026,
    }));
    const [, meta] = logger.error.mock.calls[0] as [string, { detalle?: string; para?: string }];
    expect(meta.detalle).toBe('Receiver incapable');
    expect(meta.para).toBe('5219993700779');
  });

  it('el wamid del acuse es el mismo que registra el envío: por ahí se atan', async () => {
    // `sendDocument` loguea `wa.sendDocument.ok` con este id. Sin el acuse, ese
    // log dice "salió" y nada dice "no llegó".
    await pedir(conStatus('failed', { errors: [{ code: 131047 }] }));
    const [, meta] = logger.error.mock.calls[0] as [string, { id: string }];
    expect(meta.id).toBe('wamid.PDF123');
  });

  it('los acuses normales se registran sin gritar', async () => {
    await pedir(conStatus('delivered'));
    expect(rpc).toHaveBeenCalledWith('registrar_estados_wa_meta_lote', {
      p_estados: [expect.objectContaining({ wamid: 'wamid.PDF123', estado: 'delivered' })],
    });
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('wa.estado', { id: 'wamid.PDF123', estado: 'delivered' });
  });

  it('GPS R4: usa statuses[].timestamp Unix como T2 del receipt', async () => {
    await pedir(conStatus('delivered', { timestamp: '1700000000' }));

    expect(rpc).toHaveBeenCalledWith('registrar_estados_wa_meta_lote', {
      p_estados: [expect.objectContaining({
        wamid: 'wamid.PDF123',
        ahora: '2023-11-14T22:13:20.000Z',
      })],
    });
  });

  it('GPS R5: persiste 2,000 acuses en una sola RPC atomica', async () => {
    rpc.mockResolvedValueOnce({ data: 2_000, error: null });
    const statuses = Array.from({ length: 2_000 }, (_, i) => ({
      id: `wamid.LOTE.${String(i).padStart(4, '0')}`,
      status: i % 2 === 0 ? 'delivered' : 'read',
      timestamp: '1788534000',
      recipient_id: '5219993700779',
    }));

    const res = await pedir(conStatuses(statuses));

    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    const [nombre, args] = rpc.mock.calls[0] as unknown as [string, { p_estados: unknown[] }];
    expect(nombre).toBe('registrar_estados_wa_meta_lote');
    expect(args.p_estados).toHaveLength(2_000);
  });

  it.each(['-1', '1700000000.5', 'no-es-unix', '999999999999'])('GPS R4: timestamp Meta inválido %s usa un fallback local explícito', async (timestamp) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T15:16:17.000Z'));

    await pedir(conStatus('read', { timestamp }));

    expect(rpc).toHaveBeenCalledWith('registrar_estados_wa_meta_lote', {
      p_estados: [expect.objectContaining({
        wamid: 'wamid.PDF123',
        ahora: '2026-09-04T15:16:17.000Z',
      })],
    });
  });

  it('la respuesta distingue mensajes de acuses', async () => {
    const res = await pedir(conStatus('read'));
    await expect(res.json()).resolves.toEqual({ received: 0, estados: 1 });
  });

  // El límite: un payload de acuses no es un mensaje entrante y no debe procesarse
  // como tal. Antes devolvía received:0 y ESO era lo correcto; lo que faltaba era
  // no tirarlo a la basura.
  it('un acuse no se procesa como mensaje del operador', async () => {
    const { processInbound } = await import('@/lib/likida/processor');
    await pedir(conStatus('failed', { errors: [{ code: 1 }] }));
    expect(processInbound).not.toHaveBeenCalled();
  });

  it.each([
    [{ data: null, error: { message: 'db down' } }],
    [{ data: false, error: null }],
  ])('si el RPC devuelve fallo responde 503 y Retry-After: %o', async (respuesta) => {
    rpc.mockResolvedValueOnce(respuesta as never);
    const res = await pedir(conStatus('read'));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
  });

  it('si el RPC lanza responde 503 reintentable', async () => {
    rpc.mockRejectedValueOnce(new Error('timeout'));
    const res = await pedir(conStatus('delivered'));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
  });
});
