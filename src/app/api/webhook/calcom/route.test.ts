import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RpcArgs = {
  p_clave: string;
  p_tipo: string;
  p_externo: string;
  p_prospecto: string | null;
  p_payload: Record<string, unknown>;
  p_creado_en: string | null;
  p_externo_anterior: string | null;
};

const db = vi.hoisted(() => ({
  prospecto: { id: 'p-landing-1' } as { id: string } | null,
  lookupError: false,
  rpcFailures: 0,
  rpcResultado: 'aplicado',
  rpcVacio: false,
  keys: new Set<string>(),
  rpcCalls: [] as Array<{ nombre: string; args: RpcArgs }>,
}));

function prospectoBuilder() {
  const b = {
    select: () => b,
    eq: () => b,
    is: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: async () => db.lookupError
      ? { data: null, error: { message: 'CRM read failed' } }
      : { data: db.prospecto, error: null },
  };
  return b;
}

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => prospectoBuilder(),
    rpc: async (nombre: string, args: RpcArgs) => {
      db.rpcCalls.push({ nombre, args });
      if (db.rpcFailures > 0) {
        db.rpcFailures -= 1;
        return { data: null, error: { message: 'transaction rolled back' } };
      }
      if (db.rpcVacio) return { data: [], error: null };
      if (db.keys.has(args.p_clave)) {
        return { data: [{ resultado: 'repetido', estado_prospecto: 'appointment' }], error: null };
      }
      // La clave sólo existe después de una RPC exitosa: simula el COMMIT
      // atómico que garantiza 0323, no una reclamación previa separada.
      db.keys.add(args.p_clave);
      return { data: [{ resultado: db.rpcResultado, estado_prospecto: 'appointment' }], error: null };
    },
  }),
}));
vi.mock('@/lib/ratelimit', () => ({ bodyExcede: vi.fn(() => false) }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const { POST } = await import('./route');

const SECRET = 'calcom-test-secret';

function firmar(cuerpo: string): string {
  return createHmac('sha256', SECRET).update(cuerpo).digest('hex');
}

function postear(cuerpo: string, firma = firmar(cuerpo)) {
  return POST(new Request('https://app.likida.ai/api/webhook/calcom', {
    method: 'POST',
    headers: { 'x-cal-signature-256': firma, 'content-type': 'application/json' },
    body: cuerpo,
  }));
}

const EVENTO = JSON.stringify({
  triggerEvent: 'BOOKING_CREATED',
  bookingId: 'booking-1',
  payload: { attendees: [{ email: '  lead@landing.mx ' }] },
});

beforeEach(() => {
  process.env.CALCOM_WEBHOOK_SECRET = SECRET;
  db.prospecto = { id: 'p-landing-1' };
  db.lookupError = false;
  db.rpcFailures = 0;
  db.rpcResultado = 'aplicado';
  db.rpcVacio = false;
  db.keys.clear();
  db.rpcCalls.length = 0;
});

afterEach(() => { delete process.env.CALCOM_WEBHOOK_SECRET; });

describe('POST /api/webhook/calcom — frontera de la transacción 0323', () => {
  it('firma inválida responde 401 y no toca CRM', async () => {
    expect((await postear(EVENTO, '00'.repeat(32))).status).toBe(401);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('enlaza el lead y delega ledger + estado a una sola RPC', async () => {
    const r = await postear(EVENTO);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, resultado: 'aplicado', prospectoId: 'p-landing-1' });
    expect(db.rpcCalls).toEqual([{
      nombre: 'aplicar_evento_calcom_tx',
      args: {
        p_clave: 'calcom:BOOKING_CREATED:booking-1',
        p_tipo: 'BOOKING_CREATED',
        p_externo: 'booking-1',
        p_prospecto: 'p-landing-1',
        p_payload: { attendees: [{ email: '  lead@landing.mx ' }] },
        p_creado_en: null,
        p_externo_anterior: null,
      },
    }]);
  });

  it.each([
    'BOOKING_CREATED',
    'BOOKING_RESCHEDULED',
    'BOOKING_CANCELLED',
    'BOOKING_NO_SHOW',
  ])('%s llega a la RPC canónica sin rutas de escritura paralelas', async (triggerEvent) => {
    const cuerpo = JSON.stringify({
      triggerEvent,
      bookingId: `booking-${triggerEvent}`,
      createdAt: '2026-08-20T12:00:00.000Z',
      payload: { attendees: [{ email: 'lead@landing.mx' }] },
    });
    expect((await postear(cuerpo)).status).toBe(200);
    expect(db.rpcCalls[0].args).toMatchObject({
      p_tipo: triggerEvent,
      p_creado_en: '2026-08-20T12:00:00.000Z',
    });
  });

  it('RESCHEDULED conserva el uid anterior para enlazar la reserva vigente', async () => {
    const cuerpo = JSON.stringify({
      triggerEvent: 'BOOKING_RESCHEDULED', bookingId: 'B',
      payload: { rescheduleUid: 'A', attendees: [{ email: 'lead@landing.mx' }] },
    });
    expect((await postear(cuerpo)).status).toBe(200);
    expect(db.rpcCalls[0].args).toMatchObject({ p_externo: 'B', p_externo_anterior: 'A' });
  });

  it('createdAt futuro se pasa firmado y la cuarentena durable sigue siendo 200 procesado', async () => {
    db.rpcResultado = 'cuarentena';
    const cuerpo = JSON.stringify({
      triggerEvent: 'BOOKING_CREATED', bookingId: 'futuro',
      createdAt: '2099-01-01T00:00:00.000Z',
      payload: { attendees: [{ email: 'lead@landing.mx' }] },
    });
    const r = await postear(cuerpo);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, resultado: 'cuarentena' });
    expect(db.rpcCalls[0].args.p_creado_en).toBe('2099-01-01T00:00:00.000Z');
  });

  it('createdAt inválido no se convierte en hora local ni hora de la cita', async () => {
    const cuerpo = JSON.stringify({
      triggerEvent: 'BOOKING_CREATED', bookingId: 'sin-reloj', createdAt: 'no-es-fecha',
      payload: { startTime: '2099-01-01T00:00:00Z', attendees: [{ email: 'lead@landing.mx' }] },
    });
    expect((await postear(cuerpo)).status).toBe(200);
    expect(db.rpcCalls[0].args.p_creado_en).toBeNull();
  });

  it('un duplicado confirmado por la RPC responde repetido sin segunda mutación', async () => {
    expect((await postear(EVENTO)).status).toBe(200);
    const r = await postear(EVENTO);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, repetido: true, resultado: 'repetido' });
    expect(db.rpcCalls).toHaveLength(2);
  });

  it('rollback de la RPC nunca contesta 200 falso y el reintento puede aplicar', async () => {
    db.rpcFailures = 1;
    expect((await postear(EVENTO)).status).toBe(500);
    expect(db.keys).not.toContain('calcom:BOOKING_CREATED:booking-1');

    const reintento = await postear(EVENTO);
    expect(reintento.status).toBe(200);
    expect(await reintento.json()).toMatchObject({ resultado: 'aplicado' });
  });

  it('dos CAS perdidos ya no existen: una respuesta vacía de DB falla fuerte', async () => {
    db.rpcVacio = true;
    expect((await postear(EVENTO)).status).toBe(500);
  });

  it('fallo del lookup responde 500 para que Cal.com reintente', async () => {
    db.lookupError = true;
    expect((await postear(EVENTO)).status).toBe(500);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('JSON inválido firmado responde 400', async () => {
    expect((await postear('{')).status).toBe(400);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('evento no soportado responde 400 y no ensucia el ledger', async () => {
    const cuerpo = JSON.stringify({ triggerEvent: 'MEETING_STARTED', bookingId: 'x' });
    expect((await postear(cuerpo)).status).toBe(400);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('payload sobredimensionado responde 413 antes de consultar CRM', async () => {
    const cuerpo = JSON.stringify({
      triggerEvent: 'BOOKING_CREATED', bookingId: 'big', payload: { blob: 'x'.repeat(256 * 1024) },
    });
    expect((await postear(cuerpo)).status).toBe(413);
    expect(db.rpcCalls).toHaveLength(0);
  });
});
