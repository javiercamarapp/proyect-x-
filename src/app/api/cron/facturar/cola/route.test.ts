import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

// AUDITORÍA 24, BE-6 (b): las salidas 503/401 de este callback eran MUDAS.
const registrarLatido = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@/lib/admin/salud', () => ({ registrarLatido: (...a: unknown[]) => registrarLatido(...a) }));
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger }));
let firmaValida = true;
vi.mock('@upstash/qstash', () => ({
  Receiver: class { verify = async () => firmaValida; },
}));
const procesarLoteEnCola = vi.fn(async () => new Response(JSON.stringify({ corrio: true }), { status: 200 }));
vi.mock('../lote', () => ({ procesarLoteEnCola: (...a: unknown[]) => procesarLoteEnCola(...(a as [])) }));
vi.mock('@/lib/likida/interruptores', () => ({ estaApagado: async () => false }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: () => ({ select: () => ({ in: () => ({ is: async () => ({ data: [], error: null }) }) }) }) }) }));
const { POST } = await import('./route');

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 18 (M2, B12): la cola declaraba maxDuration = 600 contra un techo
// de plataforma verificado en 300, y el corte real del lote se deriva del
// maxDuration de `../route.ts`. Los dos números tienen que ser el MISMO: si
// se separan, el que lee la ruta de la cola dimensiona contra un presupuesto
// que no existe. Next exige literales estáticos, así que se leen del fuente.
// ═══════════════════════════════════════════════════════════════════════════
const leerMax = (ruta: string) => Number(readFileSync(ruta, 'utf8').match(/export const maxDuration = (\d+);/)?.[1]);

describe('el presupuesto de la cola de facturación', () => {
  it('la cola y el cron declaran el MISMO maxDuration (el corte del lote se deriva del cron)', () => {
    expect(leerMax('src/app/api/cron/facturar/cola/route.ts')).toBe(leerMax('src/app/api/cron/facturar/route.ts'));
  });

  it('y no rebasa el techo del plan (pro: 300s)', () => {
    expect(leerMax('src/app/api/cron/facturar/cola/route.ts')).toBeLessThanOrEqual(300);
  });
});

describe('BE-6 (b) — el callback LATE en sus salidas de puerta', () => {
  const pedir = () => POST(new Request('https://app.likida.ai/api/cron/facturar/cola', {
    method: 'POST', headers: { 'upstash-signature': 'x' }, body: JSON.stringify({ lote: [{ id: 'g-1' }], quedaron: 0 }),
  }) as never);

  beforeEach(() => {
    registrarLatido.mockClear();
    procesarLoteEnCola.mockClear();
    firmaValida = true;
    process.env.UPSTASH_QSTASH_TOKEN = 'tok';
    process.env.QSTASH_CURRENT_SIGNING_KEY = 'cur';
    process.env.QSTASH_NEXT_SIGNING_KEY = 'nxt';
  });

  it('sin una signing key: 503 Y latido `fallo` — antes el cron latía `ok` por encolar y esto callaba', async () => {
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    const res = await pedir();
    expect(res.status).toBe(503);
    expect(registrarLatido).toHaveBeenCalledWith('facturar', 'fallo', expect.objectContaining({ codigo: 'qstash_config_ausente', current: false }));
    expect(procesarLoteEnCola).not.toHaveBeenCalled();
  });

  it('un body chunked excesivo se corta antes de verificar la firma', async () => {
    let pedidos = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controlador) {
        pedidos += 1;
        if (pedidos > 20) { controlador.close(); return; }
        controlador.enqueue(new Uint8Array(64 * 1024).fill(120));
      },
    });
    const res = await POST(new Request('https://app.likida.ai/api/cron/facturar/cola', {
      method: 'POST', headers: { 'upstash-signature': 'x' }, body,
      // @ts-expect-error Node exige duplex para construir Request con stream.
      duplex: 'half',
    }) as never);

    expect(res.status).toBe(413);
    expect(pedidos).toBeLessThanOrEqual(6);
    expect(procesarLoteEnCola).not.toHaveBeenCalled();
  });

  it('firma inválida (llave rotada en QStash y no en Vercel): 401 Y latido `fallo`', async () => {
    firmaValida = false;
    const res = await pedir();
    expect(res.status).toBe(401);
    expect(registrarLatido).toHaveBeenCalledWith('facturar', 'fallo', { codigo: 'qstash_firma_invalida' });
    expect(procesarLoteEnCola).not.toHaveBeenCalled();
  });

  it('con la firma buena el lote se procesa y el latido lo pone `procesarLoteEnCola`, no esta puerta', async () => {
    const res = await pedir();
    expect(res.status).toBe(200);
    expect(procesarLoteEnCola).toHaveBeenCalledTimes(1);
    expect(registrarLatido).not.toHaveBeenCalled();
  });
});
