import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ratelimit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ratelimit')>(),
  rateLimit: vi.fn(), clientIp: () => 'ip-prueba',
}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/likida/vendedores', () => ({ crearProspecto: vi.fn(), validarProspecto: vi.fn() }));
vi.mock('@/lib/observability/alerta', () => ({ alertarOperador: vi.fn() }));
vi.mock('@/lib/likida/portal_pago_lectura', () => ({ resolverLiga: vi.fn(), vistaDelPortal: vi.fn(), anotarAcceso: vi.fn() }));
vi.mock('@/lib/likida/portal_pago_propuesta', () => ({ registrarPropuesta: vi.fn() }));
vi.mock('@/lib/likida/portal_pago_aviso', () => ({ avisarPropuestaAlContralor: vi.fn() }));

import { rateLimit } from '@/lib/ratelimit';
import { POST as demo } from './demo/route';
import { POST as lead } from './lead/route';
import { POST as clientError } from './client-error/route';
import { POST as evento } from './marketing/evento/route';
import { POST as prospecto } from './marketing/prospecto/route';
import { POST as pago } from './pago/registrar/route';

const rutas = [
  { ruta: 'demo', post: demo, limite: 64 * 1024, bloqueado: 429, exceso: 413 },
  { ruta: 'lead', post: lead, limite: 8 * 1024, bloqueado: 429, exceso: 413 },
  { ruta: 'client-error', post: clientError, limite: 4 * 1024, bloqueado: 429, exceso: 413 },
  { ruta: 'marketing/evento', post: evento, limite: 1_000, bloqueado: 204, exceso: 204 },
  { ruta: 'marketing/prospecto', post: prospecto, limite: 10_000, bloqueado: 429, exceso: 413 },
  { ruta: 'pago/registrar', post: pago, limite: 4_000, bloqueado: 429, exceso: 413 },
];

function peticion(ruta: string, body: ReadableStream<Uint8Array>) {
  return new Request(`https://app.likida.ai/api/${ruta}`, {
    method: 'POST', body, duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

beforeEach(() => { vi.mocked(rateLimit).mockReset(); });

describe.each(rutas)('$ruta: protege la lectura con el límite de tasa', ({ ruta, post, limite, bloqueado, exceso }) => {
  it('rechaza una IP bloqueada sin solicitar el primer chunk', async () => {
    vi.mocked(rateLimit).mockResolvedValue(false);
    let lecturas = 0;
    let control!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) { control = c; },
      pull() { lecturas++; },
    }, { highWaterMark: 0 });
    const pendiente = post(peticion(ruta, body));
    // Vacía los microtasks sin entregar datos ni depender del reloj de pared.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const antesDeEntregar = { lecturas, llamadas: vi.mocked(rateLimit).mock.calls.length };
    control.close();
    expect((await pendiente).status).toBe(bloqueado);
    expect(antesDeEntregar).toEqual({ lecturas: 0, llamadas: 1 });
  });

  it('contabiliza y cancela un cuerpo excesivo sin Content-Length', async () => {
    vi.mocked(rateLimit).mockResolvedValue(true);
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(new Uint8Array(limite + 1)); },
      cancel,
    }, { highWaterMark: 0 });
    const req = peticion(ruta, body);
    expect(req.headers.has('content-length')).toBe(false);
    expect((await post(req)).status).toBe(exceso);
    expect(rateLimit).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
