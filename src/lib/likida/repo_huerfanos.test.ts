import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 9, ALTO pruebas — `comprobante_huerfano` (mig. 0040) es dinero
// real (comprobantes de gasto en espera de viaje) y sus cuatro funciones de
// acceso a datos —`guardarHuerfano`/`getHuerfanos`/`resolverHuerfanos`/
// `marcarHuerfanosOfrecidos`—, más `corregirFechaGasto` de la misma familia,
// nunca ejecutaban su cuerpo real en ninguna de las 16 pruebas que las tocan:
// todas reemplazan `@/lib/likida/repo` entero con `vi.fn()`.
//
// El escenario exacto del auditor: alguien cambia `.is('resuelto_en', null)`
// por `.eq('resuelto_en', null)` en un refactor —error fácil, porque el
// resto del archivo usa `.eq()` para casi todo, y las dos formas NO son
// equivalentes en PostgREST (`.eq(col, null)` no encuentra filas con NULL)—.
// `getHuerfanos` no lanza ante un error de lectura (diseño a propósito, para
// no bloquear el cierre del viaje que sí tiene): devuelve `[]`, y el operador
// deja de ver la oferta de sus comprobantes sin ningún aviso, log distinto,
// ni forma de notarlo desde afuera. Ninguna de las 16 pruebas mockeadas
// puede atrapar esto: siempre devuelven exactamente lo que el test ordena.
//
// Mismo patrón ya establecido en este repo para cerrar exactamente este
// hueco (`repo_aviso.test.ts`, `repo_datos_responsable.test.ts`): un
// PostgREST de mentira que SÍ ejecuta la cadena real de métodos y registra
// cuál se llamó, con qué argumentos, en qué orden — para que invertir un
// `.is()` por un `.eq()`, o cambiar la columna del filtro, haga fallar la
// prueba en vez de pasar disfrazado de éxito.
// ═══════════════════════════════════════════════════════════════════════════

import type { Gasto } from '@/types/likida';

/** Lo que se le pidió a la base, en orden: tabla, método, argumentos. */
let llamadas: Array<{ tabla: string; metodo: string; args: unknown[] }> = [];
let respuesta: { data: unknown; error: unknown } = { data: null, error: null };
const rpc = vi.fn(async () => ({ data: 'h1', error: null }));

const from = vi.fn((tabla: string) => {
  const enlace: Record<string, unknown> = {};
  for (const m of ['insert', 'select', 'update', 'eq', 'is', 'order', 'limit', 'in']) {
    enlace[m] = (...a: unknown[]) => { llamadas.push({ tabla, metodo: m, args: a }); return enlace; };
  }
  enlace.then = (r: (v: unknown) => unknown) => Promise.resolve(respuesta).then(r);
  return enlace;
});

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from, rpc }) }));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger }));

const { guardarHuerfano, getHuerfanos, marcarHuerfanosOfrecidos, resolverHuerfanos, corregirFechaGasto } = await import('./repo');

const GASTO: Gasto = { id: 'g1', concepto: 'diesel', monto: 850, fecha: '2026-08-01' };

beforeEach(() => {
  llamadas = [];
  respuesta = { data: null, error: null };
  from.mockClear();
  rpc.mockClear();
  logger.info.mockReset(); logger.warn.mockReset(); logger.error.mockReset();
});

describe('guardarHuerfano — inserta con los datos del gasto y del motivo', () => {
  it('inserta en comprobante_huerfano con la forma exacta que la 0040 espera', async () => {
    respuesta = { data: null, error: null };
    const ok = await guardarHuerfano('t1', 'o1', { gasto: GASTO, motivo: 'sin_viaje', rutaImagen: 't1/v1/h.jpg' });

    expect(ok).toBe(true);
    const insert = llamadas.find((l) => l.tabla === 'comprobante_huerfano' && l.metodo === 'insert');
    expect(insert?.args[0]).toEqual({
      tenant_id: 't1', operador_id: 'o1', gasto: GASTO, motivo: 'sin_viaje', ruta_imagen: 't1/v1/h.jpg',
    });
  });

  it('sin ruta de imagen, la manda como null explícito (no undefined, que PostgREST ignora distinto)', async () => {
    await guardarHuerfano('t1', 'o1', { gasto: GASTO, motivo: 'tras_liquidar' });
    const insert = llamadas.find((l) => l.metodo === 'insert');
    expect((insert?.args[0] as { ruta_imagen: unknown }).ruta_imagen).toBeNull();
  });

  it('«fallo_ocr» llega tal cual a la columna: es `text` a secas, sin CHECK que traducir', async () => {
    // El motivo se agregó el 4-ago-2026 para las dos ramas de `fallo_tecnico`
    // del processor, que escribían `sin_viaje` —el efecto— y escondían la causa
    // (se cayó NUESTRO OCR). La 0040 declara `motivo text not null` sin enum ni
    // constraint, así que el valor honesto entra sin migración; esta prueba es
    // la que se pondrá roja el día que alguien le ponga un CHECK a la columna.
    await guardarHuerfano('t1', 'o1', { gasto: GASTO, motivo: 'fallo_ocr' });
    const insert = llamadas.find((l) => l.metodo === 'insert');
    expect((insert?.args[0] as { motivo: unknown }).motivo).toBe('fallo_ocr');
  });

  it('un fallo de la base se registra y devuelve false — no lanza (best-effort documentado)', async () => {
    respuesta = { data: null, error: { message: 'timeout' } };
    const ok = await guardarHuerfano('t1', 'o1', { gasto: GASTO, motivo: 'sin_viaje' });
    expect(ok).toBe(false);
    expect(logger.error).toHaveBeenCalledWith('huerfano.guardar_error', expect.anything());
  });

  it('con viaje registra o vincula por tenant+hash en una sola RPC atómica', async () => {
    const gasto = { ...GASTO, imgHash: 'a'.repeat(64) };
    const ok = await guardarHuerfano('t1', 'o1', {
      gasto, motivo: 'fallo_ocr', rutaImagen: 't1/v1/a.jpg', viajeId: 'v1',
    });
    expect(ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('guardar_comprobante_huerfano_tx', {
      p_tenant: 't1', p_operador: 'o1', p_gasto: gasto,
      p_motivo: 'fallo_ocr', p_ruta_imagen: 't1/v1/a.jpg', p_viaje: 'v1',
    });
  });
});

describe('getHuerfanos — el escenario exacto del auditor: .is(), no .eq(), para resuelto_en', () => {
  it('filtra con .is(\'resuelto_en\', null), NO con .eq() — PostgREST no trata los dos igual', async () => {
    respuesta = { data: [], error: null };
    await getHuerfanos('t1', 'o1');

    const filtroResuelto = llamadas.find((l) => l.args[0] === 'resuelto_en');
    expect(filtroResuelto, 'no se encontró NINGÚN filtro sobre resuelto_en').toBeTruthy();
    expect(filtroResuelto?.metodo, 'un refactor a .eq() rompería el filtro en silencio (PostgREST no lo detectaría)').toBe('is');
  });

  it('acota por tenant Y por operador — un operador no puede ver los huérfanos de otro', async () => {
    respuesta = { data: [], error: null };
    await getHuerfanos('t1', 'o1');

    const eqs = llamadas.filter((l) => l.metodo === 'eq').map((l) => l.args);
    expect(eqs).toContainEqual(['tenant_id', 't1']);
    expect(eqs).toContainEqual(['operador_id', 'o1']);
  });

  it('mapea la fila cruda de la base (snake_case) al Huerfano del dominio', async () => {
    respuesta = {
      data: [{
        id: 'h1', gasto: GASTO, motivo: 'sin_viaje', creado_en: '2026-08-01T10:00:00Z',
        ruta_imagen: 't1/v1/h.jpg', ofrecido_en: null,
      }],
      error: null,
    };
    const r = await getHuerfanos('t1', 'o1');

    expect(r).toEqual([{
      id: 'h1', gasto: GASTO, motivo: 'sin_viaje', creadoEn: '2026-08-01T10:00:00Z',
      rutaImagen: 't1/v1/h.jpg', ofrecidoEn: undefined,
    }]);
  });

  it('ante un error de la base, devuelve [] — a propósito, no puede bloquear el cierre del viaje', async () => {
    respuesta = { data: null, error: { message: 'PGRST202' } };
    await expect(getHuerfanos('t1', 'o1')).resolves.toEqual([]);
  });
});

describe('marcarHuerfanosOfrecidos — deja constancia sin repetir la oferta', () => {
  it('con ids, hace UPDATE acotado por id Y por tenant', async () => {
    await marcarHuerfanosOfrecidos('t1', ['h1', 'h2']);

    const update = llamadas.find((l) => l.metodo === 'update');
    expect(update).toBeTruthy();
    expect(Object.keys(update!.args[0] as object)).toEqual(['ofrecido_en']);
    const inLlamada = llamadas.find((l) => l.metodo === 'in');
    expect(inLlamada?.args).toEqual(['id', ['h1', 'h2']]);
    const eqTenant = llamadas.find((l) => l.metodo === 'eq');
    expect(eqTenant?.args).toEqual(['tenant_id', 't1']);
  });

  it('con ids vacíos, NO llama a la base — nada que marcar', async () => {
    await marcarHuerfanosOfrecidos('t1', []);
    expect(from).not.toHaveBeenCalled();
  });

  it('un fallo se registra con warn (best-effort: el peor caso es preguntar de más)', async () => {
    respuesta = { data: null, error: { message: 'timeout' } };
    await marcarHuerfanosOfrecidos('t1', ['h1']);
    expect(logger.warn).toHaveBeenCalledWith('huerfano.marcar_ofrecido_error', expect.anything());
  });
});

describe('resolverHuerfanos — cierra la fila con el viaje al que se adjuntó (o null si se descartó)', () => {
  it('adjuntado: guarda resolucion y viaje_id', async () => {
    await resolverHuerfanos('t1', ['h1'], 'adjuntado', 'v9');

    const update = llamadas.find((l) => l.metodo === 'update')?.args[0] as
      { resolucion: string; viaje_id: string | null; resuelto_en: string };
    expect(update.resolucion).toBe('adjuntado');
    expect(update.viaje_id).toBe('v9');
    expect(update.resuelto_en).toBeTruthy();
  });

  it('descartado: viaje_id queda null — no se le puede atribuir a un viaje que no lo recibió', async () => {
    await resolverHuerfanos('t1', ['h1'], 'descartado', null);
    const update = llamadas.find((l) => l.metodo === 'update')?.args[0] as { viaje_id: string | null };
    expect(update.viaje_id).toBeNull();
  });

  it('con ids vacíos, NO llama a la base', async () => {
    await resolverHuerfanos('t1', [], 'adjuntado', 'v9');
    expect(from).not.toHaveBeenCalled();
  });

  it('un fallo se registra como error (a diferencia de "ofrecido", cerrar mal SÍ importa)', async () => {
    respuesta = { data: null, error: { message: 'timeout' } };
    await resolverHuerfanos('t1', ['h1'], 'adjuntado', 'v9');
    expect(logger.error).toHaveBeenCalledWith('huerfano.resolver_error', expect.anything());
  });
});

describe('corregirFechaGasto — de la misma familia, mismo hueco de cobertura', () => {
  it('actualiza SOLO la columna fecha, acotado por gasto y por tenant', async () => {
    await corregirFechaGasto('t1', 'g1', '2026-08-01');

    const update = llamadas.find((l) => l.metodo === 'update');
    expect(update?.args[0]).toEqual({ fecha: '2026-08-01' });
    const eqs = llamadas.filter((l) => l.metodo === 'eq').map((l) => l.args);
    expect(eqs).toContainEqual(['id', 'g1']);
    expect(eqs).toContainEqual(['tenant_id', 't1']);
  });

  it('preserva error.code (CU001 de la 0037/0042) — sin esto, processor.ts no distingue "llegó tarde" de un fallo cualquiera', async () => {
    respuesta = { data: null, error: { message: 'el viaje ya tiene liquidación emitida', code: 'CU001' } };
    const err = await corregirFechaGasto('t1', 'g1', '2026-08-01').catch((e) => e as Error & { code?: string });
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { code?: string }).code).toBe('CU001');
  });

  it('un error sin code no inventa uno', async () => {
    respuesta = { data: null, error: { message: 'timeout' } };
    const err = await corregirFechaGasto('t1', 'g1', '2026-08-01').catch((e) => e as Error & { code?: string });
    expect((err as Error & { code?: string }).code).toBeUndefined();
  });
});
