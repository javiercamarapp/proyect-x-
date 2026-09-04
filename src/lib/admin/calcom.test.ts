import { afterEach, describe, expect, it, vi } from 'vitest';
import { provisionarWebhookCalcom, type CalcomConfig } from './calcom';

const CONFIG: CalcomConfig = {
  apiUrl: 'https://api.cal.com',
  apiKey: 'cal_live_test',
  webhookSecret: 'secreto-hmac',
  eventTypeId: '42',
};

afterEach(() => vi.unstubAllGlobals());

describe('provisionarWebhookCalcom — contrato API v2', () => {
  it('crea el webhook del event type con secret, versión y triggers oficiales', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      status: 'success', data: { id: 987 },
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(provisionarWebhookCalcom(
      'https://app.likida.mx/api/webhook/calcom', CONFIG,
    )).resolves.toEqual({ configured: true, id: '987' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.cal.com/v2/event-types/42/webhooks');
    expect(JSON.parse(String(init.body))).toEqual({
      subscriberUrl: 'https://app.likida.mx/api/webhook/calcom',
      triggers: [
        'BOOKING_CREATED',
        'BOOKING_RESCHEDULED',
        'BOOKING_CANCELLED',
        'BOOKING_NO_SHOW_UPDATED',
      ],
      active: true,
      secret: 'secreto-hmac',
      version: '2021-10-20',
    });
  });

  it('sin eventTypeId usa el webhook de usuario y conserva el mismo contrato firmado', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      status: 'success', data: { id: 'wh-user' },
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await provisionarWebhookCalcom('https://app.likida.mx/api/webhooks/calcom', {
      ...CONFIG, eventTypeId: null,
    });

    expect(result).toEqual({ configured: true, id: 'wh-user' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.cal.com/v2/webhooks');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      secret: 'secreto-hmac',
      version: '2021-10-20',
      triggers: expect.arrayContaining(['BOOKING_NO_SHOW_UPDATED']),
    });
  });
});
