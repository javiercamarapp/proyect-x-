import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 19 (OP-19c2-3) — el estado 'dead' del outbox de WhatsApp no tenía
// consumidor ni alerta. Un mensaje que agota sus 8 reintentos (0180) se
// enterraba en silencio: el cron seguía en verde porque procesó la fila con
// éxito, solo que el resultado fue matarla. Este es el único de los 6 crons
// que no llamaba `alertarOperador` — se fija que ahora sí, y solo cuando la
// fila de verdad murió (no en cada fallo transitorio, que ya reintenta solo).
// ═══════════════════════════════════════════════════════════════════════════

const puertaCron = vi.fn(async (_a: string, _b: Request, _c: string) => null);
const registrarLatido = vi.fn(async (_id: string, _estado: string, _detalle?: Record<string, unknown>) => {});
vi.mock('@/lib/admin/salud', () => ({
  puertaCron: (a: string, b: Request, c: string) => puertaCron(a, b, c),
  registrarLatido: (a: string, b: string, c?: Record<string, unknown>) => registrarLatido(a, b, c),
}));

const reclamarSalidasWhatsApp = vi.fn();
const finalizarSalidaWhatsApp = vi.fn();
vi.mock('@/lib/likida/wa_outbox', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/likida/wa_outbox')>(),
  reclamarSalidasWhatsApp: () => reclamarSalidasWhatsApp(),
  finalizarSalidaWhatsApp: (s: unknown, messageId?: string, error?: string) => finalizarSalidaWhatsApp(s, messageId, error),
}));

const alertarOperador = vi.fn(async (_e: string, _d: Record<string, unknown>) => {});
vi.mock('@/lib/observability/alerta', () => ({ alertarOperador: (e: string, d: Record<string, unknown>) => alertarOperador(e, d) }));
const rpc = vi.fn(async (): Promise<{ data: number | null; error: { message: string } | null }> => ({ data: 0, error: null }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ rpc }) }));

// BACK-19-1 (CRÍTICO, cherry-pick de dae7f640): el cron ahora consulta el
// kill switch antes de reclamar. Este archivo prueba otra cosa (el aviso de
// muerte), así que el interruptor se mantiene 'encendido' — la puerta no es
// lo que se ejercita aquí, ver route.test.ts para esa garantía.
vi.mock('@/lib/likida/interruptores', () => ({ leerInterruptor: async () => 'encendido' as const }));

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { GET } = await import('./route');
const peticion = () => new Request('https://app.likida.ai/api/cron/wa-outbox');

const salida = (id: string) => ({ id, payload: { to: '5219999999999' }, intentos: 1, leaseToken: 't' });

beforeEach(() => {
  puertaCron.mockClear(); registrarLatido.mockClear();
  reclamarSalidasWhatsApp.mockReset(); finalizarSalidaWhatsApp.mockReset();
  alertarOperador.mockClear(); rpc.mockReset(); rpc.mockResolvedValue({ data: 0, error: null });
  process.env.WHATSAPP_ACCESS_TOKEN = 'token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'phone';
});

describe('el outbox avisa cuando una salida MUERE, no en cualquier fallo', () => {
  // AUDITORÍA 24, BE-15: esta prueba usaba «sin token de Meta» como vehículo
  // para matar la fila. Ya no lo es: un canal no configurado no es culpa de la
  // fila y ahora la ruta se sale ANTES de reclamar (ver route.test.ts). El
  // vehículo pasa a ser lo que sí es de la fila: la red se cae en su envío.
  it('la red se cae en su envío y la fila muere: avisa al operador', async () => {
    reclamarSalidasWhatsApp.mockResolvedValue([salida('a')]);
    finalizarSalidaWhatsApp.mockResolvedValue({ ok: true, muerta: true });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));

    await GET(peticion());

    expect(alertarOperador).toHaveBeenCalledWith('cron.wa_outbox', expect.objectContaining({ codigo: 'salida_muerta' }));
    vi.unstubAllGlobals();
  });

  it('un fallo transitorio que NO mata la fila (va a reintentar sola): sin alerta', async () => {
    reclamarSalidasWhatsApp.mockResolvedValue([salida('b')]);
    finalizarSalidaWhatsApp.mockResolvedValue({ ok: true, muerta: false });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })));

    await GET(peticion());

    expect(alertarOperador).not.toHaveBeenCalled();
    expect(finalizarSalidaWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'b' }), undefined, expect.stringMatching(/^retryable:HTTP 429:/));
    vi.unstubAllGlobals();
  });

  it('Meta acepta con wamid: éxito, sin alerta, sin llamar dos veces', async () => {
    reclamarSalidasWhatsApp.mockResolvedValue([salida('c')]);
    finalizarSalidaWhatsApp.mockResolvedValue({ ok: true, muerta: false });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 })));

    const r = await GET(peticion());

    expect(r.status).toBe(200);
    expect(alertarOperador).not.toHaveBeenCalled();
    expect(finalizarSalidaWhatsApp).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }), 'wamid.1', undefined);
    vi.unstubAllGlobals();
  });

  it('GPS R4: claim perdido al finalizar un 200 no cuenta enviada y deja el cron en fallo', async () => {
    reclamarSalidasWhatsApp.mockResolvedValue([salida('claim-perdido')]);
    finalizarSalidaWhatsApp.mockResolvedValue({ ok: false, muerta: false });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.claim-perdido' }] }), { status: 200 })));

    const r = await GET(peticion());
    const body = await r.json() as { fallidas: number; enviadas: number };

    expect(r.status).toBe(500);
    expect(body).toEqual(expect.objectContaining({ fallidas: 1, enviadas: 0 }));
    expect(registrarLatido).toHaveBeenLastCalledWith('wa-outbox', 'parcial', expect.objectContaining({
      fallidas: 1, enviadas: 0,
    }));
    expect(alertarOperador).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('GPS R4: un receipt terminal anterior al vínculo cuenta fallida y alerta, no enviada', async () => {
    reclamarSalidasWhatsApp.mockResolvedValue([salida('receipt-previo')]);
    // La RPC encuentra el receipt terminal al escribir provider_message_id y
    // el trigger convierte la salida en dead en esa misma sentencia.
    finalizarSalidaWhatsApp.mockResolvedValue({ ok: true, muerta: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.terminal-previo' }] }), { status: 200 })));

    const r = await GET(peticion());
    const body = await r.json() as { fallidas: number; enviadas: number };

    expect(r.status).toBe(500);
    expect(body).toEqual(expect.objectContaining({ fallidas: 1, enviadas: 0 }));
    expect(alertarOperador).toHaveBeenCalledWith('cron.wa_outbox', expect.objectContaining({
      codigo: 'salida_muerta',
      error: expect.stringContaining('ya había reportado un fallo terminal'),
    }));
    expect(finalizarSalidaWhatsApp).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('GPS R4: fallo del reconciliador queda en respuesta y latido sin falso ok', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'reconciliador caído' } });
    reclamarSalidasWhatsApp.mockResolvedValue([]);

    const r = await GET(peticion());
    const body = await r.json() as { fallosBackstop?: string[] };

    expect(r.status).toBe(500);
    expect(body.fallosBackstop).toContain('reconciliacion: reconciliador caído');
    expect(registrarLatido).toHaveBeenLastCalledWith('wa-outbox', 'parcial', expect.objectContaining({
      fallosBackstop: ['reconciliacion: reconciliador caído'],
    }));
  });

  it('GPS R4: respuesta inválida del reconciliador tampoco produce falso ok', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    reclamarSalidasWhatsApp.mockResolvedValue([]);

    const r = await GET(peticion());
    const body = await r.json() as { fallosBackstop?: string[] };

    expect(r.status).toBe(500);
    expect(body.fallosBackstop).toContain('reconciliacion: respuesta inválida');
    expect(registrarLatido).toHaveBeenLastCalledWith('wa-outbox', 'parcial', expect.objectContaining({
      fallosBackstop: ['reconciliacion: respuesta inválida'],
    }));
  });

  it('GPS R4: fallo de la purga también queda visible en respuesta y latido', async () => {
    rpc.mockResolvedValueOnce({ data: 2, error: null });
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'purga caída' } });
    reclamarSalidasWhatsApp.mockResolvedValue([]);

    const r = await GET(peticion());
    const body = await r.json() as { fallosBackstop?: string[] };

    expect(r.status).toBe(500);
    expect(body.fallosBackstop).toContain('purga: purga caída');
    expect(registrarLatido).toHaveBeenLastCalledWith('wa-outbox', 'parcial', expect.objectContaining({
      fallosBackstop: ['purga: purga caída'],
    }));
  });

  it('GPS R3: un 200 sin wamid queda dead/manual-review y alerta, no se reencola', async () => {
    reclamarSalidasWhatsApp.mockResolvedValue([salida('e')]);
    finalizarSalidaWhatsApp.mockResolvedValue({ ok: true, muerta: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: [] }), { status: 200 })));

    const r = await GET(peticion());
    const body = await r.json() as { fallidas: number; enviadas: number };

    expect(alertarOperador).toHaveBeenCalledWith('cron.wa_outbox', expect.objectContaining({ codigo: 'salida_muerta' }));
    expect(body.fallidas).toBe(1);
    expect(body.enviadas).toBe(0);
    expect(finalizarSalidaWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e' }), undefined, 'sin_wamid:e');
    vi.unstubAllGlobals();
  });

  it('un HTTP de error de Meta que SÍ agota reintentos: avisa', async () => {
    reclamarSalidasWhatsApp.mockResolvedValue([salida('d')]);
    finalizarSalidaWhatsApp.mockResolvedValue({ ok: true, muerta: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad request', { status: 400 })));

    await GET(peticion());

    expect(alertarOperador).toHaveBeenCalledWith('cron.wa_outbox', expect.objectContaining({ codigo: 'salida_muerta' }));
    expect(finalizarSalidaWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'd' }), undefined, expect.stringMatching(/^terminal:HTTP 400:/));
    vi.unstubAllGlobals();
  });
});
