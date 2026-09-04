import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 19, BACK-19-1 (CRÍTICO) — EL OUTBOX TAMBIÉN OBEDECE LA PALANCA.
//
// El outbox durable es el ÚLTIMO eslabón hacia el teléfono del chofer: no
// encola, MANDA a `graph.facebook.com`. Nació sin leer `leerInterruptor`,
// siendo el único cron del repo que no lo hacía — `escalar`, `facturar`,
// `gps`, `purgar` y `wa-pendientes` sí. El efecto es exactamente el que el
// kill switch existe para impedir: Javier apaga el sistema en medio de un
// incidente, `wa-pendientes` deja de encolar, y el outbox sigue vaciando a
// personas reales lo que ya estaba dentro, cada minuto, hasta que se acabe.
//
// El contrato que fija esta prueba es el de `wa-pendientes`, palabra por
// palabra, porque una segunda forma de obedecer la palanca es una palanca
// que no se puede razonar:
//  · apagado  → 200 con `saltado`, y NADA sale a la red (apagar no es fallo);
//  · ilegible → 500 con `codigo`, y NADA sale a la red (A17: no poder leer
//    el interruptor no es "estaba encendido");
//  · encendido → drena como siempre.
// ═══════════════════════════════════════════════════════════════════════════

let interruptor: 'encendido' | 'apagado' | 'ilegible' = 'encendido';
vi.mock('@/lib/likida/interruptores', () => ({
  leerInterruptor: async () => interruptor,
}));

const { logger } = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/logger', () => ({ logger }));

const registrarLatido = vi.fn(async () => {});
vi.mock('@/lib/admin/salud', () => ({
  registrarLatido: (...a: unknown[]) => registrarLatido(...(a as [])),
  puertaCron: async (_c: string, req: Request) =>
    req.headers.get('authorization') === 'Bearer secreto-de-prueba'
      ? null
      : new Response(null, { status: 401 }),
}));

const reclamarSalidasWhatsApp = vi.fn(async () => [
  { id: 'out-1', payload: { messaging_product: 'whatsapp', to: '5215512345678', text: { body: 'Tu liquidación está lista' } } },
]);
const finalizarSalidaWhatsApp = vi.fn(async () => ({ ok: true, muerta: false }));
vi.mock('@/lib/likida/wa_outbox', () => ({
  reclamarSalidasWhatsApp: (...a: unknown[]) => reclamarSalidasWhatsApp(...(a as [])),
  finalizarSalidaWhatsApp: (...a: unknown[]) => finalizarSalidaWhatsApp(...(a as [])),
}));

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ rpc: async () => ({ data: 0, error: null }) }),
}));

vi.mock('@/lib/likida/lotes', () => ({
  conPool: async <T,>(xs: T[], _n: number, f: (x: T) => Promise<void>) => { for (const x of xs) await f(x); },
}));

import { GET } from './route';

const CON_SECRETO = { headers: { authorization: 'Bearer secreto-de-prueba' } };

describe('cron wa-outbox — el kill switch global (BACK-19-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    interruptor = 'encendido';
    process.env.WHATSAPP_ACCESS_TOKEN = 'token-de-prueba';
    process.env.WHATSAPP_PHONE_NUMBER_ID = '123456';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ messages: [{ id: 'wamid.PRUEBA' }] }), { status: 200 },
    )));
  });

  it('APAGADO: no manda un solo mensaje a Meta, y lo dice sin llamarlo fallo', async () => {
    interruptor = 'apagado';

    const res = await GET(new Request('https://likida.ai/api/cron/wa-outbox', CON_SECRETO));
    const body = await res.json();

    // Lo que de verdad importa: el teléfono del chofer no suena.
    expect(fetch).not.toHaveBeenCalled();
    // Y ni siquiera se reclamó la fila: un lease tomado con el sistema
    // apagado es una salida secuestrada hasta que expire.
    expect(reclamarSalidasWhatsApp).not.toHaveBeenCalled();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ corrio: false, saltado: 'interruptor global' });
  });

  it('ILEGIBLE: tampoco manda, y SÍ es fallo — no poder leer la palanca no es "estaba encendido"', async () => {
    interruptor = 'ilegible';

    const res = await GET(new Request('https://likida.ai/api/cron/wa-outbox', CON_SECRETO));
    const body = await res.json();

    expect(fetch).not.toHaveBeenCalled();
    expect(reclamarSalidasWhatsApp).not.toHaveBeenCalled();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({ corrio: false, codigo: 'interruptor_ilegible', interruptor: 'global' });
  });

  it('ENCENDIDO: drena como siempre — la palanca no rompe el camino feliz', async () => {
    const res = await GET(new Request('https://likida.ai/api/cron/wa-outbox', CON_SECRETO));
    const body = await res.json();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ corrio: true, tomadas: 1, enviadas: 1, fallidas: 0 });
  });

  it('sin secreto no corre, con la palanca en cualquier posición', async () => {
    const res = await GET(new Request('https://likida.ai/api/cron/wa-outbox'));
    expect(res.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  // AUDITORÍA 24, BE-15: un hueco de configuración quemaba un intento de cada
  // salida reclamada por minuto, hasta matarlas todas en ~1 h.
  it('BE-15: sin token de Meta NO se reclama ninguna salida — 500, latido `fallo` y el outbox intacto', async () => {
    delete process.env.WHATSAPP_ACCESS_TOKEN;

    const res = await GET(new Request('https://likida.ai/api/cron/wa-outbox', CON_SECRETO));
    const body = await res.json();

    expect(reclamarSalidasWhatsApp).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
    expect(body).toMatchObject({ corrio: false, codigo: 'canal_no_configurado' });
    expect(registrarLatido).toHaveBeenCalledWith('wa-outbox', 'fallo', { codigo: 'canal_no_configurado' });
  });
});
