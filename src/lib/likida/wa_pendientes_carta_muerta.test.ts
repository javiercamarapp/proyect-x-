import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28 · BE-A3 (ALTO) — `descartarCartaMuerta`.
//
// Sella UNA fila que ya agotó `MAX_INTENTOS_PENDIENTE` intentos como
// descartada, tras avisar al chofer y al operador (processor.ts). El
// `.update` va DIRECTO, sin RPC, así que el propio filtro
// (`procesado_en is null and intentos >= MAX`) es la única barrera que
// impide sellar por accidente una fila viva.
// ═══════════════════════════════════════════════════════════════════════════

let llamadas: Array<{ metodo: string; args: unknown[] }> = [];
let respuesta: { data: unknown; error: unknown } = { data: [{ id: 'wamid.MUERTA' }], error: null };

const from = vi.fn((_tabla: string) => {
  const enlace: Record<string, unknown> = {};
  for (const m of ['update', 'eq', 'is', 'gte', 'select']) {
    enlace[m] = (...a: unknown[]) => { llamadas.push({ metodo: m, args: a }); return enlace; };
  }
  enlace.then = (r: (v: unknown) => unknown) => Promise.resolve(respuesta).then(r);
  return enlace;
});
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from }) }));
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger }));

const { descartarCartaMuerta, MAX_INTENTOS_PENDIENTE } = await import('./wa_pendientes');

beforeEach(() => {
  llamadas = [];
  respuesta = { data: [{ id: 'wamid.MUERTA' }], error: null };
  from.mockClear();
  logger.warn.mockReset(); logger.error.mockReset();
});

describe('descartarCartaMuerta', () => {
  it('sella con procesado_en/ultimo_error, filtrando por procesado_en is null e intentos >= MAX', async () => {
    const ok = await descartarCartaMuerta('wamid.MUERTA', 'descartada: motivo de prueba');
    expect(ok).toBe(true);

    const update = llamadas.find((l) => l.metodo === 'update')?.args[0] as Record<string, unknown>;
    expect(update.ultimo_error).toBe('descartada: motivo de prueba');
    expect(typeof update.procesado_en).toBe('string');

    expect(llamadas.filter((l) => l.metodo === 'eq').map((l) => l.args)).toContainEqual(['id', 'wamid.MUERTA']);
    expect(llamadas.filter((l) => l.metodo === 'is').map((l) => l.args)).toContainEqual(['procesado_en', null]);
    expect(llamadas.filter((l) => l.metodo === 'gte').map((l) => l.args)).toContainEqual(['intentos', MAX_INTENTOS_PENDIENTE]);
  });

  it('trunca el motivo a 500 caracteres (mismo tope que anotarFalloPendiente)', async () => {
    await descartarCartaMuerta('wamid.MUERTA', 'x'.repeat(600));
    const update = llamadas.find((l) => l.metodo === 'update')?.args[0] as Record<string, unknown>;
    expect((update.ultimo_error as string).length).toBe(500);
  });

  it('devuelve false si NO selló ninguna fila (ya estaba sellada, o era una foto viva) — no lanza', async () => {
    respuesta = { data: [], error: null };
    expect(await descartarCartaMuerta('wamid.X', 'motivo')).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith('wa.carta_muerta_no_sellada', expect.anything());
  });

  it('FAIL-CLOSED: un error de la base devuelve false y no lanza', async () => {
    respuesta = { data: null, error: { message: 'tope de consulta' } };
    expect(await descartarCartaMuerta('wamid.MUERTA', 'motivo')).toBe(false);
    expect(logger.error).toHaveBeenCalledWith('wa.carta_muerta_sello_fallo', expect.anything());
  });
});
