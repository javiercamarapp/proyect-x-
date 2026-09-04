import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24 · AGEN-6 (MEDIO) — el «listo» ADELANTADO.
//
// El orden del inbox lo daba `recibido_en`: la hora en que el POST llegó a
// NUESTRO servidor. Meta entrega los mensajes de una ráfaga en POSTs distintos
// y no garantiza el orden: la foto mandada a las 10:40:00.2 puede aterrizar a
// las 10:40:03 y el «listo» de las 10:40:01.1 a las 10:40:01.4. El «listo»
// cerraba primero, `esperarIntake` veía el contador en cero porque la foto
// nunca hizo `+1`, y la liquidación quedaba sin el último ticket —
// irreversible por la 0036/0037.
//
// La 0280 arregla el orden de la COLA (verificado contra Postgres real,
// bloque 227); esta consulta cubre al turno que ya está corriendo.
// ═══════════════════════════════════════════════════════════════════════════

let llamadas: Array<{ tabla: string; metodo: string; args: unknown[] }> = [];
let respuesta: { data: unknown; error: unknown } = { data: [], error: null };

const from = vi.fn((tabla: string) => {
  const enlace: Record<string, unknown> = {};
  for (const m of ['select', 'is', 'lt', 'in', 'eq', 'limit']) {
    enlace[m] = (...a: unknown[]) => { llamadas.push({ tabla, metodo: m, args: a }); return enlace; };
  }
  enlace.then = (r: (v: unknown) => unknown) => Promise.resolve(respuesta).then(r);
  return enlace;
});
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from }) }));
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger }));

const { fotoAnteriorSinProcesar } = await import('./conv');

const MS = 1_756_000_001_100;

beforeEach(() => {
  llamadas = [];
  respuesta = { data: [], error: null };
  from.mockClear();
  logger.warn.mockReset();
});

describe('fotoAnteriorSinProcesar', () => {
  it('EL CASO: hay una foto más vieja sin procesar → true', async () => {
    respuesta = { data: [{ id: 'wamid.FOTO' }], error: null };
    expect(await fotoAnteriorSinProcesar('5219993700779', MS)).toBe(true);
  });

  it('sin nada esperando → false', async () => {
    expect(await fotoAnteriorSinProcesar('5219993700779', MS)).toBe(false);
  });

  it('pregunta por FOTOS sin procesar, más viejas QUE ESTE mensaje', async () => {
    await fotoAnteriorSinProcesar('5219993700779', MS);
    expect(llamadas.find((l) => l.metodo === 'is')?.args).toEqual(['procesado_en', null]);
    expect(llamadas.filter((l) => l.metodo === 'eq').map((l) => l.args))
      .toContainEqual(['evento->>type', 'image']);
    // `->` (jsonb) y no `->>`: como texto, «999…» compararía como cadena.
    expect(llamadas.filter((l) => l.metodo === 'lt').map((l) => l.args))
      .toContainEqual(['evento->timestampMs', MS]);
  });

  it('reconoce el número en TODAS sus formas: el «1» de Telmex y el «+»', async () => {
    await fotoAnteriorSinProcesar('5219993700779', MS);
    const variantes = llamadas.find((l) => l.metodo === 'in')?.args[1] as string[];
    expect(variantes.length).toBeGreaterThan(1);
    expect(variantes).toContain('5219993700779');
  });

  it('una foto agotada sigue siendo evidencia pendiente: no se filtra por intentos', async () => {
    respuesta = { data: [{ id: 'foto-dead-intentos-5' }], error: null };
    expect(await fotoAnteriorSinProcesar('5219993700779', MS)).toBe(true);
    await fotoAnteriorSinProcesar('5219993700779', MS);
    expect(llamadas.filter((l) => l.metodo === 'lt').map((l) => l.args)).not.toContainEqual(['intentos', 5]);
  });

  it('sin hora de Meta NO se pregunta: no se adivina, y no se toca la base', async () => {
    expect(await fotoAnteriorSinProcesar('5219993700779', 0)).toBe(false);
    expect(await fotoAnteriorSinProcesar('5219993700779', Number.NaN)).toBe(false);
    expect(from).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED: una lectura caída devuelve indeterminado, no "no hay foto"', async () => {
    respuesta = { data: null, error: { message: 'tope de consulta' } };
    expect(await fotoAnteriorSinProcesar('5219993700779', MS)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith('inbox.foto_anterior_ilegible', expect.anything());
  });
});
