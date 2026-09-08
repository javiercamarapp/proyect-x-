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
//
// AUDITORÍA 28 · BE-A3 (ALTO): `fotoAnteriorSinProcesar` dejó de devolver un
// booleano — una foto que agotó sus intentos (carta muerta) y una foto viva
// esperando su turno son cosas MUY distintas para quien cierra, y el defecto
// exacto de esta suite (línea 71 de la versión anterior: «no se filtra por
// intentos») era el documentado, no el diseño. Ahora vuelve
// `{ vivas, muertas }` (o `null` si la lectura falló).
// ═══════════════════════════════════════════════════════════════════════════

let llamadas: Array<{ tabla: string; metodo: string; args: unknown[] }> = [];
let respuesta: { data: unknown; error: unknown } = { data: [], error: null };

const from = vi.fn((tabla: string) => {
  const enlace: Record<string, unknown> = {};
  for (const m of ['select', 'is', 'lt', 'in', 'eq', 'order', 'limit']) {
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

/** Una fila cualquiera de `wa_evento_pendiente`, con sus valores por defecto. */
const fila = (over: Partial<{ id: string; intentos: number; recibido_en: string | null; timestampMs: number | null }> = {}) => ({
  id: 'wamid.FOTO', intentos: 0, recibido_en: '2026-09-01T10:40:00.200Z', timestampMs: MS - 1000,
  ...over,
});

beforeEach(() => {
  llamadas = [];
  respuesta = { data: [], error: null };
  from.mockClear();
  logger.warn.mockReset();
});

describe('fotoAnteriorSinProcesar', () => {
  it('EL CASO: hay una foto más vieja sin procesar (viva) → vivas=1', async () => {
    respuesta = { data: [fila()], error: null };
    expect(await fotoAnteriorSinProcesar('5219993700779', MS)).toEqual({ vivas: 1, muertas: [] });
  });

  it('sin nada esperando → vivas=0, muertas=[]', async () => {
    expect(await fotoAnteriorSinProcesar('5219993700779', MS)).toEqual({ vivas: 0, muertas: [] });
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

  it('una fila con `intentos: 5` NO cuenta como viva; sí se reporta como muerta', async () => {
    respuesta = { data: [fila({ id: 'foto-dead-intentos-5', intentos: 5, timestampMs: 1_756_000_000_000 })], error: null };
    const r = await fotoAnteriorSinProcesar('5219993700779', MS);
    expect(r).toEqual({
      vivas: 0,
      muertas: [{ id: 'foto-dead-intentos-5', recibidoMs: Date.parse('2026-09-01T10:40:00.200Z'), timestampMs: 1_756_000_000_000 }],
    });
  });

  it('una viva y una muerta → vivas=1 (aplaza), y la muerta aparte', async () => {
    respuesta = {
      data: [
        fila({ id: 'viva-1', intentos: 4 }),
        fila({ id: 'muerta-1', intentos: 7, timestampMs: 1_756_000_000_500 }),
      ],
      error: null,
    };
    const r = await fotoAnteriorSinProcesar('5219993700779', MS);
    expect(r?.vivas).toBe(1);
    expect(r?.muertas).toHaveLength(1);
    expect(r?.muertas[0].id).toBe('muerta-1');
  });

  it('el `.limit()` trae un desempate total (`id`), determinista entre corridas', async () => {
    await fotoAnteriorSinProcesar('5219993700779', MS);
    const columnas = llamadas.filter((l) => l.metodo === 'order').map((l) => l.args[0]);
    expect(columnas).toContain('id');
  });

  it('sin hora de Meta NO se pregunta: no se adivina, y no se toca la base', async () => {
    expect(await fotoAnteriorSinProcesar('5219993700779', 0)).toEqual({ vivas: 0, muertas: [] });
    expect(await fotoAnteriorSinProcesar('5219993700779', Number.NaN)).toEqual({ vivas: 0, muertas: [] });
    expect(from).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED: una lectura caída devuelve indeterminado, no "no hay foto"', async () => {
    respuesta = { data: null, error: { message: 'tope de consulta' } };
    expect(await fotoAnteriorSinProcesar('5219993700779', MS)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith('inbox.foto_anterior_ilegible', expect.anything());
  });
});
