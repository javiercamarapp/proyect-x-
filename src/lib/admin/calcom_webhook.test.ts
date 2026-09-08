import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

// ═══════════════════════════════════════════════════════════════════════════
// ARQ-B1 (auditoría 28) — EL CONTRATO COMPARTIDO.
//
// Antes `calcom.ts` entregaba eventos localmente con un `import()` dinámico
// de `route.ts` (lib → app → lib, invisible al grep estático) y fabricaba su
// propio `Request` con el mismo esquema de firma que el webhook público, SIN
// que nada en el repo ejecutara los dos caminos contra el MISMO contrato —
// si alguien endurecía la validación del webhook público, la entrega local
// podía romperse o saltarse el control sin enterarse.
//
// Ahora los dos caminos (la puerta pública en `route.ts` y la entrega local
// en `calcom.ts`) llaman a la MISMA función, `procesarWebhookCalcom`, aquí
// mismo en `lib`. Esta prueba no verifica que un `route.ts` y una copia
// diverjan (ya no hay copia) — verifica que un payload firmado por el
// esquema que la entrega local usa produce, al pasar por esta función, el
// mismo efecto observable (misma RPC, misma clave de idempotencia) que
// produciría si llegara por la ruta pública. Si algún día alguien reintroduce
// una segunda implementación (el motivo original de ARQ-B1), esta prueba dejará
// de tener sentido por construcción — la guarda real es la del comentario en
// `calcom.ts` y `route.test.ts` importando `POST` de la ruta real.
// ═══════════════════════════════════════════════════════════════════════════

const db = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ nombre: string; args: Record<string, unknown> }>,
  prospectos: [] as Array<{ id: string }>,
  keys: new Set<string>(),
}));

function prospectoBuilder() {
  const b = {
    select: () => b, eq: () => b, is: () => b, limit: () => b,
    then: (resolve: (v: unknown) => unknown) => resolve({ data: db.prospectos, error: null }),
  };
  return b;
}

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => prospectoBuilder(),
    rpc: async (nombre: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ nombre, args });
      const clave = args.p_clave as string;
      if (db.keys.has(clave)) {
        return { data: [{ resultado: 'repetido', estado_prospecto: 'appointment' }], error: null };
      }
      db.keys.add(clave);
      return { data: [{ resultado: 'aplicado', estado_prospecto: 'appointment' }], error: null };
    },
  }),
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const { procesarWebhookCalcom } = await import('./calcom_webhook');

const SECRET = '0123456789abcdefghijklmnopqrstuvwxyz-CONTRATO';
function firmar(cuerpo: string): string {
  return createHmac('sha256', SECRET).update(cuerpo).digest('hex');
}

const EVENTO = JSON.stringify({
  triggerEvent: 'BOOKING_CREATED',
  createdAt: '2026-09-01T10:00:00.000Z',
  bookingId: 'booking-contrato',
  payload: { attendees: [{ email: 'lead@contrato.mx' }] },
});

beforeEach(() => {
  process.env.CALCOM_WEBHOOK_SECRET = SECRET;
  db.rpcCalls.length = 0;
  db.prospectos = [];
  db.keys.clear();
});
afterEach(() => { delete process.env.CALCOM_WEBHOOK_SECRET; });

describe('procesarWebhookCalcom — el mismo contrato para la puerta pública y la entrega local', () => {
  it('un payload firmado con el esquema que usa entregarEventoCalcomLocal (Request + x-cal-signature-256) produce el mismo efecto que llegar por la ruta pública', async () => {
    const raw = EVENTO;
    const firma = firmar(raw);

    // Camino 1: como llegaría el webhook público (POST de route.ts).
    const reqPublico = new Request('https://app.likida.ai/api/webhook/calcom', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cal-signature-256': firma },
      body: raw,
    });
    const rPublico = await procesarWebhookCalcom(reqPublico);
    expect(rPublico.status).toBe(200);
    expect(await rPublico.clone().json()).toMatchObject({ ok: true, resultado: 'aplicado' });
    expect(db.rpcCalls).toHaveLength(1);
    const clavePrimeraLlamada = db.rpcCalls[0].args.p_clave;

    // Camino 2: exactamente como `entregarEventoCalcomLocal` en calcom.ts
    // fabrica su Request — mismo raw (JSON.stringify del evento), mismo
    // encabezado de firma HMAC-SHA256.
    const reqLocal = new Request('https://app.likida.ai/api/webhook/calcom', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cal-signature-256': firma },
      body: raw,
    });
    const rLocal = await procesarWebhookCalcom(reqLocal);
    expect(rLocal.status).toBe(200);
    // Misma clave de idempotencia → la RPC ve la clave ya usada y contesta
    // "repetido": es la prueba de que es LA MISMA función/contrato la que
    // procesó los dos caminos, no una segunda validación que "también
    // funciona pero distinto".
    expect(await rLocal.clone().json()).toMatchObject({ ok: true, repetido: true });
    expect(db.rpcCalls).toHaveLength(2);
    expect(db.rpcCalls[1].args.p_clave).toBe(clavePrimeraLlamada);
    expect(db.rpcCalls.map((c) => c.nombre)).toEqual(['aplicar_evento_calcom_tx', 'aplicar_evento_calcom_tx']);
  });

  it('route.ts re-exporta EXACTAMENTE esta función como POST, sin envoltura que pueda divergir', async () => {
    const { POST } = await import('@/app/api/webhook/calcom/route');
    expect(POST).toBe(procesarWebhookCalcom);
  });
});
