import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// `sat_descarga/escritura.ts` NO TENÍA UN SOLO ARCHIVO DE PRUEBA (auditoría
// 28, PRU-B3 — tercera vez). Tres actos sobre el circuito fiscal de la
// flota, y el que más importa cuidar es `pedirRangoManual`:
//
//   · el tope `VENTANA_MAX_DIAS` (partir el año evita que un fallo se lleve
//     el rango entero);
//   · «proveedor sin configurar» antes de tocar la base;
//   · `if (!cfg.activa) return {ok:false, …'pausada'…}` — EL CANDADO de este
//     lote: mutarlo a `if (false)` deja la suite verde y una flota que se
//     pausó A PROPÓSITO vuelve a pedir rangos al SAT, consumiendo el tope
//     diario del RFC;
//   · reserva-antes-de-llamar (la fila existe antes de tocar la red, así que
//     un timeout ambiguo no pide el rango dos veces);
//   · 23505/23P01 (candado único / traslape) → "ya hay una en curso"; otro
//     código se propaga tal cual, sin inventar qué pasó.
//
// Cada escritura acota `tenant_id`: es lo que la prueba registra en la
// cadena, no en memoria.
// ═══════════════════════════════════════════════════════════════════════════

type Resp = { data: unknown; error: unknown };
const respuestas = new Map<string, Resp>();

interface Llamada {
  tabla: string;
  op: 'select' | 'insert' | 'update' | 'upsert';
  fila: Record<string, unknown> | null;
  eq: Array<[string, unknown]>;
}
const llamadas: Llamada[] = [];

function crearBuilder(tabla: string) {
  const l: Llamada = { tabla, op: 'select', fila: null, eq: [] };
  llamadas.push(l);
  const clave = () => `${tabla}#${l.op}#${llamadas.filter((x) => x.tabla === tabla && x.op === l.op).length}`;
  const resp = (): Resp => respuestas.get(clave()) ?? respuestas.get(`${tabla}#${l.op}`) ?? { data: null, error: null };
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: () => b,
    insert: (fila: Record<string, unknown>) => { l.op = 'insert'; l.fila = fila; return b; },
    update: (fila: Record<string, unknown>) => { l.op = 'update'; l.fila = fila; return b; },
    upsert: (fila: Record<string, unknown>) => { l.op = 'upsert'; l.fila = fila; return b; },
    eq: (c: string, v: unknown) => { l.eq.push([c, v]); return b; },
    maybeSingle: () => Promise.resolve(resp()),
    single: () => Promise.resolve(resp()),
    then: (res: (x: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve().then(() => resp()).then(res, rej),
  });
  return b;
}

vi.mock('@/lib/likida/presupuesto', () => ({ acotada: <T,>(q: T) => q }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: (t: string) => crearBuilder(t) }) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const bitacoras: unknown[] = [];
vi.mock('@/lib/likida/bitacora_escritura', () => ({
  anotarBitacora: (e: unknown) => { bitacoras.push(e); return Promise.resolve(); },
}));

let proveedor: {
  nombre: string;
  solicitar: ReturnType<typeof vi.fn>;
  verificar: ReturnType<typeof vi.fn>;
  descargar: ReturnType<typeof vi.fn>;
  credencial: ReturnType<typeof vi.fn>;
} | null = null;
let motivoNoConfigurado = 'La descarga masiva no está configurada.';
vi.mock('./index', () => ({
  resolverDescargaSat: () => proveedor,
  estadoDescargaSat: () => ({ configurado: proveedor !== null, proveedor: proveedor?.nombre ?? null, motivo: proveedor === null ? motivoNoConfigurado : null }),
}));

const { guardarConfigDescarga, verificarCredencial, pedirRangoManual } = await import('./escritura');
const { DatoInvalido } = await import('../errores');

const TENANT = 'tenant-1';

beforeEach(() => {
  llamadas.length = 0;
  respuestas.clear();
  bitacoras.length = 0;
  motivoNoConfigurado = 'La descarga masiva no está configurada.';
  proveedor = {
    nombre: 'sw',
    solicitar: vi.fn(async () => ({ ok: true, requestId: 'req-1' })),
    verificar: vi.fn(async () => ({ ok: true, estado: 'en_proceso', paquetes: [] })),
    descargar: vi.fn(async () => ({ ok: true, xmls: [] })),
    credencial: vi.fn(async () => ({ ok: true, numero: 'cert-1', venceEn: '2027-01-01' })),
  };
});

describe('guardarConfigDescarga', () => {
  const datosValidos = { rfc: 'AAA010101AB1', modo: 'webservice', peajeDiasAviso: 5, activa: true };

  it('camino feliz: upsert con tenant_id y bitácora', async () => {
    await guardarConfigDescarga(TENANT, datosValidos, { id: 'u1' });
    const l = llamadas.find((x) => x.tabla === 'sat_descarga_config' && x.op === 'upsert');
    expect(l?.fila).toMatchObject({ tenant_id: TENANT, rfc: 'AAA010101AB1', modo: 'webservice', activa: true });
    expect(bitacoras).toHaveLength(1);
  });

  it('RFC sin forma de RFC — DatoInvalido, sin tocar la base', async () => {
    await expect(guardarConfigDescarga(TENANT, { ...datosValidos, rfc: 'malo' })).rejects.toThrow(DatoInvalido);
    expect(llamadas).toHaveLength(0);
  });

  it('modo inválido — DatoInvalido', async () => {
    await expect(guardarConfigDescarga(TENANT, { ...datosValidos, modo: 'fax' })).rejects.toThrow(DatoInvalido);
  });

  it('anticipación de peaje fuera de 1-25 — DatoInvalido', async () => {
    await expect(guardarConfigDescarga(TENANT, { ...datosValidos, peajeDiasAviso: 26 })).rejects.toThrow(DatoInvalido);
    await expect(guardarConfigDescarga(TENANT, { ...datosValidos, peajeDiasAviso: 0 })).rejects.toThrow(DatoInvalido);
  });

  it('fallo cerrado: error de la base se propaga', async () => {
    respuestas.set('sat_descarga_config#upsert', { data: null, error: { message: 'timeout' } });
    await expect(guardarConfigDescarga(TENANT, datosValidos)).rejects.toThrow('timeout');
  });
});

describe('verificarCredencial', () => {
  it('proveedor no configurado — {ok:false} con el motivo real, sin tocar la base', async () => {
    proveedor = null;
    motivoNoConfigurado = 'falta variable X';
    const r = await verificarCredencial(TENANT);
    expect(r).toEqual({ ok: false, mensaje: 'falta variable X' });
    expect(llamadas).toHaveLength(0);
  });

  it('sin RFC declarado — pide declarar antes de verificar', async () => {
    respuestas.set('sat_descarga_config#select', { data: null, error: null });
    const r = await verificarCredencial(TENANT);
    expect(r).toEqual({ ok: false, mensaje: 'Todavía no has declarado el RFC del buzón que se va a descargar.' });
  });

  it('camino feliz: guarda certificado y vigencia, con tenant_id acotado', async () => {
    respuestas.set('sat_descarga_config#select', { data: { rfc: 'AAA010101AB1' }, error: null });
    const r = await verificarCredencial(TENANT, { id: 'u1' });
    expect(r.ok).toBe(true);
    const upd = llamadas.find((x) => x.tabla === 'sat_descarga_config' && x.op === 'update' && x.fila?.certificado_numero);
    expect(upd?.fila).toMatchObject({ certificado_numero: 'cert-1', certificado_vence_en: '2027-01-01' });
    expect(upd?.eq).toContainEqual(['tenant_id', TENANT]);
    expect(bitacoras).toHaveLength(1);
  });

  it('el proveedor dice que no hay e.firma en su bóveda: el mensaje TAL CUAL, y se limpia el certificado', async () => {
    respuestas.set('sat_descarga_config#select', { data: { rfc: 'AAA010101AB1' }, error: null });
    proveedor!.credencial.mockResolvedValueOnce({ ok: false, mensaje: 'sin e.firma cargada' });
    const r = await verificarCredencial(TENANT);
    expect(r).toEqual({ ok: false, mensaje: 'sin e.firma cargada' });
    const upd = llamadas.find((x) => x.tabla === 'sat_descarga_config' && x.op === 'update');
    expect(upd?.fila).toMatchObject({ certificado_numero: null, certificado_vence_en: null });
  });
});

describe('pedirRangoManual', () => {
  const rango = { desde: '2026-01-01', hasta: '2026-01-15', tipo: 'recibidos' as const };

  it('rango > VENTANA_MAX_DIAS — DatoInvalido, ANTES de consultar la base', async () => {
    await expect(pedirRangoManual(TENANT, { desde: '2026-01-01', hasta: '2026-03-01', tipo: 'recibidos' }))
      .rejects.toThrow(DatoInvalido);
    expect(llamadas).toHaveLength(0);
  });

  it('fecha final antes que la inicial — DatoInvalido', async () => {
    await expect(pedirRangoManual(TENANT, { desde: '2026-01-15', hasta: '2026-01-01', tipo: 'recibidos' }))
      .rejects.toThrow(DatoInvalido);
  });

  it('formato de fecha inválido — DatoInvalido', async () => {
    await expect(pedirRangoManual(TENANT, { desde: '01-01-2026', hasta: '2026-01-15', tipo: 'recibidos' }))
      .rejects.toThrow(DatoInvalido);
  });

  it('proveedor no configurado — {ok:false}, sin tocar la base', async () => {
    proveedor = null;
    const r = await pedirRangoManual(TENANT, rango);
    expect(r.ok).toBe(false);
    expect(llamadas).toHaveLength(0);
  });

  it('sin RFC declarado — pide declarar antes de reservar', async () => {
    respuestas.set('sat_descarga_config#select', { data: null, error: null });
    const r = await pedirRangoManual(TENANT, rango);
    expect(r).toEqual({ ok: false, mensaje: 'Todavía no has declarado el RFC del buzón que se va a descargar.' });
  });

  it('EL CANDADO: descarga pausada — ok:false con "pausada" y NINGÚN insert', async () => {
    respuestas.set('sat_descarga_config#select', { data: { rfc: 'AAA010101AB1', activa: false }, error: null });
    const r = await pedirRangoManual(TENANT, rango);
    expect(r.ok).toBe(false);
    expect(r.mensaje).toMatch(/pausada/);
    expect(llamadas.some((x) => x.tabla === 'sat_descarga_solicitud')).toBe(false);
    expect(proveedor!.solicitar).not.toHaveBeenCalled();
  });

  it('camino feliz: reserva-antes-de-llamar, luego solicita y actualiza a en_proceso', async () => {
    respuestas.set('sat_descarga_config#select', { data: { rfc: 'AAA010101AB1', activa: true }, error: null });
    respuestas.set('sat_descarga_solicitud#insert', { data: { id: 'sol-1' }, error: null });
    const r = await pedirRangoManual(TENANT, rango, { id: 'u1' });
    expect(r.ok).toBe(true);
    const ins = llamadas.find((x) => x.tabla === 'sat_descarga_solicitud' && x.op === 'insert');
    expect(ins?.fila).toMatchObject({ tenant_id: TENANT, proveedor: 'sw', tipo: 'recibidos', estado: 'solicitada' });
    const upd = llamadas.find((x) => x.tabla === 'sat_descarga_solicitud' && x.op === 'update');
    expect(upd?.fila).toMatchObject({ request_id: 'req-1', estado: 'en_proceso' });
    expect(upd?.eq).toContainEqual(['tenant_id', TENANT]);
    expect(bitacoras).toHaveLength(1);
  });

  it('23505 (índice único) — "ya hay una en curso", sin llamar al proveedor', async () => {
    respuestas.set('sat_descarga_config#select', { data: { rfc: 'AAA010101AB1', activa: true }, error: null });
    respuestas.set('sat_descarga_solicitud#insert', { data: null, error: { code: '23505', message: 'duplicate key' } });
    const r = await pedirRangoManual(TENANT, rango);
    expect(r.ok).toBe(false);
    expect(r.mensaje).toMatch(/ya tiene una solicitud en curso/);
    expect(proveedor!.solicitar).not.toHaveBeenCalled();
  });

  it('23P01 (traslape) — mismo mensaje de "en curso"', async () => {
    respuestas.set('sat_descarga_config#select', { data: { rfc: 'AAA010101AB1', activa: true }, error: null });
    respuestas.set('sat_descarga_solicitud#insert', { data: null, error: { code: '23P01', message: 'exclusion violation' } });
    const r = await pedirRangoManual(TENANT, rango);
    expect(r.ok).toBe(false);
    expect(r.mensaje).toMatch(/ya tiene una solicitud en curso/);
  });

  it('otro código de error en la reserva — se propaga TAL CUAL, no se inventa "ya hay una en curso"', async () => {
    respuestas.set('sat_descarga_config#select', { data: { rfc: 'AAA010101AB1', activa: true }, error: null });
    respuestas.set('sat_descarga_solicitud#insert', { data: null, error: { code: '55000', message: 'object not in prerequisite state' } });
    const r = await pedirRangoManual(TENANT, rango);
    expect(r.ok).toBe(false);
    expect(r.mensaje).not.toMatch(/en curso/);
    expect(r.mensaje).toMatch(/object not in prerequisite state/);
  });

  it('el SAT rechaza la solicitud: NO se reintenta desde aquí, se actualiza a error', async () => {
    respuestas.set('sat_descarga_config#select', { data: { rfc: 'AAA010101AB1', activa: true }, error: null });
    respuestas.set('sat_descarga_solicitud#insert', { data: { id: 'sol-1' }, error: null });
    proveedor!.solicitar.mockResolvedValueOnce({ ok: false, mensaje: 'rango ya bajado', clase: 'rechazado' });
    const r = await pedirRangoManual(TENANT, rango);
    expect(r).toEqual({ ok: false, mensaje: 'rango ya bajado' });
    const upd = llamadas.find((x) => x.tabla === 'sat_descarga_solicitud' && x.op === 'update');
    expect(upd?.fila).toMatchObject({ proveedor_mensaje: 'rango ya bajado', estado: 'error' });
  });
});
