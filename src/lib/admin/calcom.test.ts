import { afterEach, describe, expect, it, vi } from 'vitest';
const doubles = vi.hoisted(() => ({
  rpc: vi.fn(),
  postLocal: vi.fn(),
  prospectos: [] as Array<Record<string, unknown>>,
}));
const rpc = doubles.rpc;
function prospectoBuilder() {
  const b = {
    select: () => b, eq: () => b, is: () => b, limit: () => b,
    then: (resolve: (v: unknown) => unknown) => resolve({ data: doubles.prospectos, error: null }),
  };
  return b;
}
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ rpc, from: () => prospectoBuilder() }),
}));
vi.mock('@/app/api/webhook/calcom/route', () => ({
  POST: (...a: unknown[]) => doubles.postLocal(...a),
}));
import {
  ejecutarMantenimientoCalcom,
  provisionarWebhookCalcom,
  reconciliarEventosCalcomPendientes,
  reconciliarReservasCalcom,
  type CalcomConfig,
} from './calcom';

const CONFIG: CalcomConfig = {
  apiUrl: 'https://api.cal.com', apiKey: 'cal_live_test',
  webhookSecret: 'secreto-hmac', eventTypeId: '42',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

afterEach(() => {
  vi.unstubAllGlobals();
  rpc.mockReset();
  doubles.postLocal.mockReset();
  doubles.prospectos = [];
});

describe('provisionarWebhookCalcom — reconciliación idempotente API v2', () => {
  it('si el scope no tiene callback hace GET y luego crea exactamente uno', async () => {
    const respuestas = [json({ status: 'success', data: [] }), json({ status: 'success', data: { id: 987 } }, 201)];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => respuestas.shift()!);
    vi.stubGlobal('fetch', fetchMock);

    await expect(provisionarWebhookCalcom('https://app.likida.mx/api/webhook/calcom', CONFIG))
      .resolves.toEqual({ configured: true, id: '987' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.cal.com/v2/event-types/42/webhooks?take=250&skip=0');
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.cal.com/v2/event-types/42/webhooks');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      subscriberUrl: 'https://app.likida.mx/api/webhook/calcom',
      triggers: ['BOOKING_CREATED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED', 'BOOKING_NO_SHOW_UPDATED'],
      active: true, secret: 'secreto-hmac', version: '2021-10-20',
    });
  });

  it('si ya existe actualiza el mismo id y elimina duplicados del mismo subscriberUrl/scope', async () => {
    const respuestas = [
      json({ status: 'success', data: [
        { id: 90, subscriberUrl: 'https://app.likida.mx/api/webhook/calcom' },
        { id: 91, subscriberUrl: 'https://app.likida.mx/api/webhook/calcom' },
        { id: 92, subscriberUrl: 'https://otro.test/hook' },
      ] }),
      json({ status: 'success', data: { id: 90 } }),
      new Response(null, { status: 204 }),
    ];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => respuestas.shift()!);
    vi.stubGlobal('fetch', fetchMock);

    await expect(provisionarWebhookCalcom('https://app.likida.mx/api/webhook/calcom', CONFIG))
      .resolves.toEqual({ configured: true, id: '90' });
    expect(fetchMock.mock.calls.map(([u, i]) => [u, i?.method ?? 'GET'])).toEqual([
      ['https://api.cal.com/v2/event-types/42/webhooks?take=250&skip=0', 'GET'],
      ['https://api.cal.com/v2/event-types/42/webhooks/90', 'PATCH'],
      ['https://api.cal.com/v2/event-types/42/webhooks/91', 'DELETE'],
    ]);
  });

  it('sin eventTypeId reconcilia dentro del scope de usuario', async () => {
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => init?.method === 'PATCH'
      ? json({ status: 'success', data: { id: 'wh-user' } })
      : json({ status: 'success', data: [{ id: 'wh-user', subscriberUrl: 'https://app.likida.mx/api/webhook/calcom' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(provisionarWebhookCalcom('https://app.likida.mx/api/webhook/calcom', { ...CONFIG, eventTypeId: null }))
      .resolves.toEqual({ configured: true, id: 'wh-user' });
    expect(fetchMock.mock.calls.map(([u]) => u)).toEqual([
      'https://api.cal.com/v2/webhooks?take=250&skip=0',
      'https://api.cal.com/v2/webhooks/wh-user',
    ]);
  });
});

describe('reconciliarReservasCalcom — Bookings v2 real', () => {
  it('pagina por cursor, usa afterUpdatedAt/header obligatorio y emite sólo eventos soportados', async () => {
    const respuestas = [
      json({ status: 'success', data: [
        { id: 10, uid: 'A', status: 'accepted', createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-01T10:00:00Z', attendees: [{ email: 'a@test.mx', absent: false }] },
        { id: 11, uid: 'B', status: 'accepted', createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-02T10:00:00Z', rescheduledFromUid: 'A', attendees: [{ email: 'a@test.mx', absent: false }] },
      ], pagination: { hasMore: true, nextCursor: 'CURSOR-2' } }),
      json({ status: 'success', data: [
        { id: 12, uid: 'C', status: 'cancelled', createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-03T10:00:00Z', attendees: [{ email: 'c@test.mx', absent: false }] },
        { id: 13, uid: 'D', status: 'accepted', createdAt: '2026-08-01T10:00:00Z', updatedAt: '2026-08-04T10:00:00Z', attendees: [{ email: 'd@test.mx', absent: true }] },
      ], pagination: { hasMore: false, nextCursor: null } }),
    ];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => respuestas.shift()!);
    const ingest = vi.fn(async (
      _evento: Record<string, unknown>,
      _meta?: { soloSiNoShowVigente?: boolean },
    ) => {});
    vi.stubGlobal('fetch', fetchMock);

    await expect(reconciliarReservasCalcom('2026-08-01T00:00:00Z', ingest, CONFIG))
      .resolves.toEqual({ configured: true, revisadas: 4, completa: true, cursor: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url1, init1] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    const [url2] = fetchMock.mock.calls[1] as unknown as [URL, RequestInit];
    expect(url1.searchParams.get('afterUpdatedAt')).toBe('2026-08-01T00:00:00Z');
    expect(url1.searchParams.get('eventTypeId')).toBe('42');
    expect(url1.searchParams.get('limit')).toBe('100');
    expect(url1.searchParams.has('cursor')).toBe(false);
    expect(url2.searchParams.get('cursor')).toBe('CURSOR-2');
    expect(new Headers(init1.headers).get('cal-api-version')).toBe('2026-05-01');
    expect(ingest.mock.calls.map(([e]) => e.triggerEvent)).toEqual([
      'BOOKING_CREATED', 'BOOKING_NO_SHOW_UPDATED',
      'BOOKING_RESCHEDULED', 'BOOKING_NO_SHOW_UPDATED',
      'BOOKING_CANCELLED', 'BOOKING_NO_SHOW_UPDATED',
    ]);
    expect(ingest.mock.calls.some(([e]) => e.triggerEvent === 'BOOKING_RECONCILED')).toBe(false);
    expect(ingest.mock.calls[2][0]).toMatchObject({
      createdAt: '2026-08-02T10:00:00Z', payload: { uid: 'B', bookingId: 11, rescheduleUid: 'A' },
    });
    expect(ingest.mock.calls[5][0]).toMatchObject({
      payload: { uid: 'D', attendees: [{ email: 'd@test.mx', absent: true, noShow: true }] },
    });
    expect(ingest.mock.calls[1]).toMatchObject([
      { triggerEvent: 'BOOKING_NO_SHOW_UPDATED', payload: { uid: 'A', attendees: [{ noShow: false }] } },
      { soloSiNoShowVigente: true },
    ]);
  });

  it('rechaza hasMore sin cursor para no truncar en silencio', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [], pagination: { hasMore: true, nextCursor: null } })));
    await expect(reconciliarReservasCalcom('2026-08-01T00:00:00Z', async () => {}, CONFIG))
      .rejects.toThrow(/cursor/i);
  });
});

describe('reconciliarEventosCalcomPendientes — barrido durable', () => {
  it('invoca la RPC claim-first y expone su resultado al cron', async () => {
    rpc.mockResolvedValueOnce({
      data: [{ revisados: 4, recuperados: 3, restantes: 1 }], error: null,
    });
    await expect(reconciliarEventosCalcomPendientes(250, CONFIG)).resolves.toEqual({
      configured: true, revisados: 4, recuperados: 3, restantes: 1,
    });
    expect(rpc).toHaveBeenCalledWith('reconciliar_eventos_calcom_pendientes', { p_limite: 250 });
  });

  it('barre ledger aunque falten credenciales externas', async () => {
    rpc.mockResolvedValueOnce({ data: [{ revisados: 1, recuperados: 1, restantes: 0 }], error: null });
    await expect(reconciliarEventosCalcomPendientes(250, {
      apiUrl: 'https://api.cal.com', apiKey: '', webhookSecret: '', eventTypeId: null,
    })).resolves.toMatchObject({ configured: true, recuperados: 1 });
  });
});

describe('ejecutarMantenimientoCalcom — call-site productivo durable', () => {
  it('claim→provisiona→Bookings→finaliza y nunca avanza watermark antes de terminar', async () => {
    const orden: string[] = [];
    rpc.mockImplementation(async (nombre: string) => {
      orden.push(nombre);
      if (nombre === 'reconciliar_eventos_calcom_pendientes') {
        return { data: [{ revisados: 0, recuperados: 0, restantes: 0 }], error: null };
      }
      if (nombre === 'iniciar_sincronizacion_calcom') return { data: [{
        claim_token: 'claim-1', desde_en: '2026-08-01T00:00:00Z',
        ventana_hasta_en: '2026-08-02T00:00:00Z', cursor_siguiente: null,
        debe_provisionar: true,
      }], error: null };
      return { data: true, error: null };
    });
    const respuestas = [
      json({ data: [] }),
      json({ data: { id: 'wh-1' } }, 201),
      json({ data: [{ id: 10, uid: 'A', status: 'accepted', createdAt: '2026-08-01T12:00:00Z', updatedAt: '2026-08-01T12:00:00Z', attendees: [] }], pagination: { hasMore: false, nextCursor: null } }),
    ];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => respuestas.shift()!);
    vi.stubGlobal('fetch', fetchMock);
    const entregar = vi.fn(async (_evento: Record<string, unknown>) => {});

    await expect(ejecutarMantenimientoCalcom({
      config: CONFIG,
      callbackUrl: 'https://app.likida.mx/api/webhook/calcom',
      venceEn: Date.now() + 30_000,
      entregar,
    })).resolves.toMatchObject({ completa: true, provisionado: true, revisadas: 1 });
    expect(orden).toEqual([
      'reconciliar_eventos_calcom_pendientes',
      'iniciar_sincronizacion_calcom',
      'registrar_webhook_sincronizacion_calcom',
      'finalizar_sincronizacion_calcom',
    ]);
    expect(entregar).toHaveBeenCalledTimes(1);
  });

  it('recupera NO_SHOW_UPDATED(false) perdido y no genera ledger false para una reserva sana', async () => {
    let claim = 0;
    rpc.mockImplementation(async (nombre: string) => {
      if (nombre === 'reconciliar_eventos_calcom_pendientes') {
        return { data: [{ revisados: 0, recuperados: 0, restantes: 0 }], error: null };
      }
      if (nombre === 'iniciar_sincronizacion_calcom') {
        claim += 1;
        return { data: [{
          claim_token: `claim-${claim}`, desde_en: '2026-08-01T00:00:00Z',
          ventana_hasta_en: '2026-08-02T00:00:00Z', cursor_siguiente: null,
          debe_provisionar: false,
        }], error: null };
      }
      return { data: true, error: null };
    });
    const booking = { data: [{
      id: 10, uid: 'A', status: 'accepted', createdAt: '2026-08-01T12:00:00Z',
      updatedAt: '2026-08-01T13:00:00Z', attendees: [{ email: 'a@test.mx', absent: false }],
    }], pagination: { hasMore: false, nextCursor: null } };
    vi.stubGlobal('fetch', vi.fn(async () => json(booking)));
    doubles.postLocal.mockResolvedValue(new Response('{}', { status: 200 }));
    doubles.prospectos = [{
      id: 'p-a', estado: 'no-show', calcom_booking_id: 'uid:A', calcom_booking_aliases: ['uid:A', 'id:10'],
    }];

    await ejecutarMantenimientoCalcom({
      config: CONFIG, callbackUrl: 'https://app.likida.mx/api/webhook/calcom', venceEn: Date.now() + 30_000,
    });
    expect(doubles.postLocal).toHaveBeenCalledTimes(2);
    const cuerpoFalse = JSON.parse(await (doubles.postLocal.mock.calls[1][0] as Request).text());
    expect(cuerpoFalse).toMatchObject({
      triggerEvent: 'BOOKING_NO_SHOW_UPDATED',
      payload: { uid: 'A', attendees: [{ email: 'a@test.mx', noShow: false }] },
    });

    doubles.postLocal.mockClear();
    doubles.prospectos = [{
      id: 'p-a', estado: 'appointment', calcom_booking_id: 'uid:A', calcom_booking_aliases: ['uid:A', 'id:10'],
    }];
    await ejecutarMantenimientoCalcom({
      config: CONFIG, callbackUrl: 'https://app.likida.mx/api/webhook/calcom', venceEn: Date.now() + 30_000,
    });
    expect(doubles.postLocal).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await (doubles.postLocal.mock.calls[0][0] as Request).text()).triggerEvent)
      .toBe('BOOKING_CREATED');
  });
});
