import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// LOS TRES CANDADOS ANTI-CARRERA DEL REGISTRO DE JORNADA (auditoría 28,
// PRU-M5 — tercera vez que se señala). El código YA los tiene bien puestos:
// `anularAsiento` ancla `.is('anulado_en', null)`, `cerrarDia` ancla
// `.eq('estado', 'abierto')` y `sellarConformidad` ancla
// `.is('conforme_operador_en', null)`. Lo que faltaba era una prueba que se
// muera si alguien los quita: sin ella, la suite queda verde con o sin el
// candado, y un refactor de buena fe puede borrarlo sin que nada avise.
//
// El mock registra la CADENA armada (tabla, operación, cada `eq`/`is` con su
// argumento): es lo único que distingue "el filtro vive en la consulta" de
// "el filtro vive en memoria" — y el candado, por diseño, tiene que vivir en
// la consulta (dos instancias serverless pueden pisarse sin memoria compartida).
// ═══════════════════════════════════════════════════════════════════════════

type Resp = { data: unknown; error: { message: string } | null };
/** Respuesta por `tabla#operacion`. Sin entrada: fila afectada (candado libre). */
const respuestas = new Map<string, Resp>();

interface Llamada {
  tabla: string;
  op: 'select' | 'update';
  fila: Record<string, unknown> | null;
  eq: Array<[string, unknown]>;
  is: Array<[string, unknown]>;
}
const llamadas: Llamada[] = [];

function crearBuilder(tabla: string) {
  const l: Llamada = { tabla, op: 'select', fila: null, eq: [], is: [] };
  llamadas.push(l);
  const resp = (): Resp => respuestas.get(`${tabla}#${l.op}`) ?? { data: [{ id: 'fila-1' }], error: null };
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: () => b,
    update: (fila: Record<string, unknown>) => { l.op = 'update'; l.fila = fila; return b; },
    eq: (c: string, v: unknown) => { l.eq.push([c, v]); return b; },
    is: (c: string, v: unknown) => { l.is.push([c, v]); return b; },
    then: (res: (x: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve().then(() => resp()).then(res, rej),
  });
  return b;
}

vi.mock('../presupuesto', () => ({ acotada: <T,>(q: T) => q }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: (t: string) => crearBuilder(t) }) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { anularAsiento, cerrarDia, sellarConformidad } = await import('./repo');

const TENANT = 'tenant-1';

beforeEach(() => { llamadas.length = 0; respuestas.clear(); });

describe('anularAsiento — el candado is(anulado_en, null)', () => {
  const args = { tenantId: TENANT, asientoId: 'as-1', motivo: 'se equivocó de kilometraje', usuarioId: 'u1', usuarioEmail: 'u@x.com' };

  it('ancla la consulta con eq(id), eq(tenant_id) e is(anulado_en, null) — EN LA BASE, no en memoria', async () => {
    const r = await anularAsiento(args);
    expect(r).toEqual({ ok: true });
    expect(llamadas).toHaveLength(1);
    const l = llamadas[0];
    expect(l.tabla).toBe('jornada_asiento');
    expect(l.op).toBe('update');
    expect(l.eq).toContainEqual(['id', 'as-1']);
    expect(l.eq).toContainEqual(['tenant_id', TENANT]);
    // EL CANDADO: si esta línea desaparece de la producción, la prueba se
    // muere aquí — es la mutación que PRU-M5 pide demostrar.
    expect(l.is).toContainEqual(['anulado_en', null]);
  });

  it('sin candado libre (data: []) — ya estaba anulada y NO reescribe autor/hora', async () => {
    respuestas.set('jornada_asiento#update', { data: [], error: null });
    const r = await anularAsiento(args);
    expect(r).toEqual({ ok: false, error: 'Esa marca no existe en tu flota o ya estaba anulada.' });
  });

  it('motivo vacío no llega a consultar la base', async () => {
    const r = await anularAsiento({ ...args, motivo: '   ' });
    expect(r.ok).toBe(false);
    expect(llamadas).toHaveLength(0);
  });

  it('error de la base se dice tal cual, por valor', async () => {
    respuestas.set('jornada_asiento#update', { data: null, error: { message: 'timeout' } });
    const r = await anularAsiento(args);
    expect(r).toEqual({ ok: false, error: 'timeout' });
  });
});

describe('cerrarDia — el candado eq(estado, abierto)', () => {
  const args = { tenantId: TENANT, jornadaId: 'jd-1', usuarioId: 'u1', usuarioEmail: 'u@x.com' };

  it('ancla eq(id), eq(tenant_id) y eq(estado, abierto)', async () => {
    const r = await cerrarDia(args);
    expect(r).toEqual({ ok: true });
    const l = llamadas[0];
    expect(l.tabla).toBe('jornada_dia');
    expect(l.eq).toContainEqual(['id', 'jd-1']);
    expect(l.eq).toContainEqual(['tenant_id', TENANT]);
    // EL CANDADO: quitar este eq deja que un día cerrado se vuelva a cerrar
    // con otro autor — «ya estaba cerrado» quedaría inalcanzable.
    expect(l.eq).toContainEqual(['estado', 'abierto']);
  });

  it('data: [] — ya estaba cerrado', async () => {
    respuestas.set('jornada_dia#update', { data: [], error: null });
    const r = await cerrarDia(args);
    expect(r).toEqual({ ok: false, error: 'Ese día no existe en tu flota o ya estaba cerrado.' });
  });
});

describe('sellarConformidad — el candado is(conforme_operador_en, null)', () => {
  const args = { tenantId: TENANT, jornadaId: 'jd-1', waMessageId: 'wamid.1' };

  it('ancla is(conforme_operador_en, null) — el reenvío de Meta no mueve la hora del acuerdo', async () => {
    const r = await sellarConformidad(args);
    expect(r).toBe('sellada');
    const l = llamadas[0];
    expect(l.tabla).toBe('jornada_dia');
    // EL CANDADO: sin él, el mismo webhook reentregado por Meta reescribe
    // `conforme_operador_en` — LFT 132-XXXIV exige que la hora sea la del
    // acuerdo real, no la del último reintento de la Graph API.
    expect(l.is).toContainEqual(['conforme_operador_en', null]);
  });

  it('data: [] — ya estaba sellada, devuelve "ya_estaba" y NO "sellada"', async () => {
    respuestas.set('jornada_dia#update', { data: [], error: null });
    const r = await sellarConformidad(args);
    expect(r).toBe('ya_estaba');
  });

  it('error de la base devuelve "fallo"', async () => {
    respuestas.set('jornada_dia#update', { data: null, error: { message: 'caída' } });
    const r = await sellarConformidad(args);
    expect(r).toBe('fallo');
  });
});
