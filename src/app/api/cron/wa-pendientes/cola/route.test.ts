import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// ESC-1 — el callback que encadena vueltas de drenado. Lo que fija:
//  · sin firma válida de QStash no drena (esta ruta manda WhatsApp real);
//  · el kill switch se respeta AQUÍ también, y con 200 (un 5xx haría que
//    QStash reintentara, o sea insistir en correr lo apagado);
//  · la vuelta que llega en el cuerpo se le pasa a `drenarBandeja`, que es lo
//    que corta la cadena en el techo.
// ═══════════════════════════════════════════════════════════════════════════

let firmaValida = true;
vi.mock('@upstash/qstash', () => ({
  Receiver: class { verify = async () => firmaValida; },
}));
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger }));

let interruptor: 'encendido' | 'apagado' | 'ilegible' = 'encendido';
vi.mock('@/lib/likida/interruptores', () => ({ leerInterruptor: async () => interruptor }));

const drenarBandeja = vi.fn(async () => ({ procesados: 3, fallidos: 0, pospuestos: 0, cartasMuertas: 0, encolado: 'msg-2' }));
vi.mock('../drenado', () => ({
  MAX_VUELTAS_QSTASH: 20,
  drenarBandeja: (...a: unknown[]) => drenarBandeja(...(a as [])),
}));

process.env.QSTASH_CURRENT_SIGNING_KEY = 'k1';
process.env.QSTASH_NEXT_SIGNING_KEY = 'k2';
const { POST } = await import('./route');
const CADENA = '11111111-1111-4111-8111-111111111111';

const peticion = (cuerpo: unknown) => new Request('http://likida.test/api/cron/wa-pendientes/cola', {
  method: 'POST',
  headers: { 'upstash-signature': 'firma' },
  body: JSON.stringify(cuerpo),
}) as never;

beforeEach(() => { vi.clearAllMocks(); firmaValida = true; interruptor = 'encendido'; });

describe('POST /api/cron/wa-pendientes/cola', () => {
  it('un body chunked excesivo se corta antes de verificar la firma o drenar', async () => {
    let pedidos = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controlador) {
        pedidos += 1;
        if (pedidos > 20) { controlador.close(); return; }
        controlador.enqueue(new Uint8Array(16 * 1024).fill(120));
      },
    });
    const r = await POST(new Request('http://likida.test/api/cron/wa-pendientes/cola', {
      method: 'POST', headers: { 'upstash-signature': 'firma' }, body,
      // @ts-expect-error Node exige duplex para construir Request con stream.
      duplex: 'half',
    }) as never);

    expect(r.status).toBe(413);
    expect(pedidos).toBeLessThanOrEqual(6);
    expect(drenarBandeja).not.toHaveBeenCalled();
  });

  it('firma inválida: 401 y NI UN mensaje procesado', async () => {
    firmaValida = false;
    const r = await POST(peticion({ vuelta: 1 }));
    expect(r.status).toBe(401);
    expect(drenarBandeja).not.toHaveBeenCalled();
  });

  it('apagado: 200 con `saltado` — un 5xx haría que QStash reintente lo apagado', async () => {
    interruptor = 'apagado';
    const r = await POST(peticion({ vuelta: 2, cadenaId: CADENA }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ corrio: false, saltado: 'interruptor global' });
    expect(drenarBandeja).not.toHaveBeenCalled();
  });

  it('ilegible: 500 con código, y tampoco drena', async () => {
    interruptor = 'ilegible';
    const r = await POST(peticion({ vuelta: 2, cadenaId: CADENA }));
    expect(r.status).toBe(500);
    expect(await r.json()).toMatchObject({ codigo: 'interruptor_ilegible' });
    expect(drenarBandeja).not.toHaveBeenCalled();
  });

  it('firma buena: drena la vuelta que le mandaron y reporta lo que encoló', async () => {
    const r = await POST(peticion({ vuelta: 4, cadenaId: CADENA }));
    expect(r.status).toBe(200);
    expect(drenarBandeja).toHaveBeenCalledWith(expect.any(Number), expect.anything(), 4, CADENA);
    expect(await r.json()).toMatchObject({ corrio: true, vuelta: 4, procesados: 3, encolado: 'msg-2' });
  });

  it.each([
    {},
    { vuelta: 0 },
    { vuelta: -1 },
    { vuelta: 1.5 },
    { vuelta: 21 },
    { vuelta: 'NaN' },
  ])('rechaza generaciones inválidas antes de drenar: %j', async (body) => {
    const r = await POST(peticion(body));
    expect(r.status).toBe(400);
    expect(drenarBandeja).not.toHaveBeenCalled();
  });

  it('rechaza un identificador de cadena no acotado', async () => {
    const r = await POST(peticion({ vuelta: 1, cadenaId: '../otra-cadena' }));
    expect(r.status).toBe(400);
    expect(drenarBandeja).not.toHaveBeenCalled();
  });

  it('rechaza una vuelta válida sin fence de cadena', async () => {
    const r = await POST(peticion({ vuelta: 1 }));
    expect(r.status).toBe(400);
    expect(drenarBandeja).not.toHaveBeenCalled();
  });
});
