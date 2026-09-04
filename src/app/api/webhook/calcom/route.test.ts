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
  p_externos: string[];
  p_externos_anteriores: string[];
  p_no_show: boolean | null;
  p_vinculo_correo: string | null;
  p_error_vinculo: string | null;
};

const db = vi.hoisted(() => ({
  prospectos: [{ id: 'p-landing-1' }] as Array<{ id: string }>,
  lookupError: false,
  rpcFailures: 0,
  rpcResultado: 'aplicado',
  rpcVacio: false,
  keys: new Set<string>(),
  rpcCalls: [] as Array<{ nombre: string; args: RpcArgs }>,
  filtrosEq: [] as Array<[string, unknown]>,
}));

function prospectoBuilder() {
  const b = {
    select: () => b,
    eq: (campo: string, valor: unknown) => { db.filtrosEq.push([campo, valor]); return b; },
    is: () => b,
    order: () => b,
    limit: () => b,
    then: (resolve: (value: unknown) => unknown) => resolve(db.lookupError
      ? { data: null, error: { message: 'CRM read failed' } }
      : { data: db.prospectos, error: null }),
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

const SECRET = '0123456789abcdefghijklmnopqrstuvwxyz-CALCOM';

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
  db.prospectos = [{ id: 'p-landing-1' }];
  db.lookupError = false;
  db.rpcFailures = 0;
  db.rpcResultado = 'aplicado';
  db.rpcVacio = false;
  db.keys.clear();
  db.rpcCalls.length = 0;
  db.filtrosEq.length = 0;
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
        p_clave: 'calcom:BOOKING_CREATED:id:booking-1',
        p_tipo: 'BOOKING_CREATED',
        p_externo: 'id:booking-1',
        p_prospecto: 'p-landing-1',
        p_payload: { attendees: [{ email: '  lead@landing.mx ' }] },
        p_creado_en: null,
        p_externo_anterior: null,
        p_externos: ['id:booking-1'],
        p_externos_anteriores: [],
        p_no_show: null,
        p_vinculo_correo: 'lead@landing.mx',
        p_error_vinculo: null,
      },
    }]);
  });

  it.each([
    'BOOKING_CREATED',
    'BOOKING_REQUESTED',
    'BOOKING_RESCHEDULED',
    'BOOKING_CANCELLED',
    'BOOKING_REJECTED',
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

  it('fixture oficial RESCHEDULED usa el UID nuevo y conserva UID/id anteriores en el mismo espacio', async () => {
    const cuerpo = JSON.stringify({
      triggerEvent: 'BOOKING_RESCHEDULED', createdAt: '2026-08-20T11:00:00.000Z',
      payload: {
        uid: 'B', bookingId: 201, rescheduleUid: 'A', rescheduleId: 200,
        attendees: [{ email: 'lead@landing.mx' }],
      },
    });
    expect((await postear(cuerpo)).status).toBe(200);
    expect(db.rpcCalls[0].args).toMatchObject({
      p_externo: 'uid:B',
      p_externo_anterior: 'uid:A',
      p_externos: ['uid:B', 'id:201'],
      p_externos_anteriores: ['uid:A', 'id:200'],
    });
  });

  it('fixture oficial CANCELLED usa uid y no mezcla bookingId numérico con rescheduleUid', async () => {
    const cuerpo = JSON.stringify({
      triggerEvent: 'BOOKING_CANCELLED', createdAt: '2026-08-20T12:00:00.000Z',
      payload: { uid: 'B', bookingId: 201, attendees: [{ email: 'lead@landing.mx' }] },
    });
    expect((await postear(cuerpo)).status).toBe(200);
    expect(db.rpcCalls[0].args).toMatchObject({
      p_externo: 'uid:B',
      p_externos: ['uid:B', 'id:201'],
    });
  });

  it.each([true, false])('fixture oficial NO_SHOW_UPDATED pasa noShow=%s y bookingUid', async (noShow) => {
    const cuerpo = JSON.stringify({
      triggerEvent: 'BOOKING_NO_SHOW_UPDATED', createdAt: noShow
        ? '2026-08-20T13:00:00.000Z' : '2026-08-20T14:00:00.000Z',
      payload: {
        bookingUid: 'B', bookingId: 201,
        attendees: [{ email: 'Lead@Landing.MX', noShow }],
      },
    });
    expect((await postear(cuerpo)).status).toBe(200);
    expect(db.rpcCalls[0].args).toMatchObject({
      p_tipo: 'BOOKING_NO_SHOW_UPDATED',
      p_externo: 'uid:B',
      p_externos: ['uid:B', 'id:201'],
      p_no_show: noShow,
    });
  });

  it('NO_SHOW_UPDATED multiasistente toma email y noShow del mismo attendee', async () => {
    const cuerpo = JSON.stringify({
      triggerEvent: 'BOOKING_NO_SHOW_UPDATED', createdAt: '2026-08-20T13:00:00.000Z',
      payload: {
        bookingUid: 'B', bookingId: 201, email: 'Target@Example.Test',
        attendees: [
          { email: 'otra@example.test', noShow: false },
          { email: 'target@example.test', noShow: true },
        ],
      },
    });
    expect((await postear(cuerpo)).status).toBe(200);
    expect(db.filtrosEq).toContainEqual(['correo_normalizado', 'target@example.test']);
    expect(db.rpcCalls[0].args.p_no_show).toBe(true);
  });

  it('lookup de correo es exacto sobre la forma normalizada, sin depender del casing almacenado', async () => {
    const cuerpo = JSON.stringify({
      triggerEvent: 'BOOKING_CREATED',
      payload: { uid: 'EMAIL', attendees: [{ email: '  Lead@Landing.MX ' }] },
    });
    expect((await postear(cuerpo)).status).toBe(200);
    expect(db.filtrosEq).toContainEqual(['correo_normalizado', 'lead@landing.mx']);
  });

  it('createdAt futuro se acepta tras quedar durable para el barrido propio', async () => {
    db.rpcResultado = 'cuarentena';
    const cuerpo = JSON.stringify({
      triggerEvent: 'BOOKING_CREATED', bookingId: 'futuro',
      createdAt: '2099-01-01T00:00:00.000Z',
      payload: { attendees: [{ email: 'lead@landing.mx' }] },
    });
    const r = await postear(cuerpo);
    expect(r.status).toBe(202);
    expect(r.headers.get('retry-after')).toBeNull();
    expect(db.rpcCalls[0].args.p_creado_en).toBe('2099-01-01T00:00:00.000Z');
  });

  it('sin_prospecto contesta 202 porque el ledger durable tiene barrido propio', async () => {
    const resultado = 'sin_prospecto';
    db.rpcResultado = resultado;
    const r = await postear(EVENTO);
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ ok: true, recuperable: true, resultado });
  });

  it('correo ambiguo nunca elige por updated_at: registra un ledger recuperable y observable', async () => {
    db.prospectos = [{ id: 'p-viejo' }, { id: 'p-nuevo' }];
    db.rpcResultado = 'sin_prospecto';
    const r = await postear(EVENTO);
    expect(r.status).toBe(202);
    expect(db.rpcCalls[0].args).toMatchObject({
      p_prospecto: null,
      p_vinculo_correo: 'lead@landing.mx',
      p_error_vinculo: 'correo_ambiguo',
    });
  });

  it('esperando_vinculo sí confirma 2xx porque una reserva posterior drena el ledger', async () => {
    db.rpcResultado = 'esperando_vinculo';
    const r = await postear(EVENTO);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, resultado: 'esperando_vinculo' });
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
    expect(db.keys).not.toContain('calcom:BOOKING_CREATED:id:booking-1');

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
