import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// ADQUISICIÓN (§2/§5 del panel) — lo que se fija:
//  · Costo $0 SOLO por diseño (censo/DENUE); sin integración = `null` y la
//    nota dice por qué — jamás un $0 de encuadre.
//  · Las alertas heredan su umbral (48h, 7 días, ~10%) y llevan el absoluto.
//  · Con el historial de contactos ILEGIBLE, LANZA — el SLA no se calcula a
//    ciegas (marcaría "sin contacto" a leads ya contactados).
// ═══════════════════════════════════════════════════════════════════════════

const AHORA = Date.parse('2026-08-16T18:00:00Z');
const hace = (horas: number) => new Date(AHORA - horas * 3_600_000).toISOString();

let prospectos: Array<Record<string, unknown>> = [];
vi.mock('@/lib/likida/vendedores', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/likida/vendedores')>(),
  listarProspectos: async () => prospectos,
}));

let contactos: Array<{ prospecto_id: string }> | 'error' = [];
vi.mock('@/lib/likida/pg', () => ({
  conteo: () => ({}),
  traerTodo: async () => {
    if (contactos === 'error') throw new Error('base caída');
    return contactos;
  },
}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: () => ({}) }) }));

const { getAdquisicion } = await import('./adquisicion');

const p = (over: Record<string, unknown>) => ({
  id: 'x', empresa: 'X', fuente: 'censo', estado: 'nuevo', createdAt: hace(1), ...over,
});

beforeEach(() => { prospectos = []; contactos = []; });

describe('costo por lead', () => {
  it('$0 SOLO por diseño; sin integración = no disponible con la razón', async () => {
    prospectos = [p({ id: 'a', fuente: 'censo' }), p({ id: 'b', fuente: 'maps' })];
    const r = await getAdquisicion(AHORA);
    const censo = r.porFuente.find((f) => f.fuente === 'censo')!;
    const maps = r.porFuente.find((f) => f.fuente === 'maps')!;
    expect(censo.costo).toEqual({ usd: 0 });
    expect(maps.costo).toBeNull();
    expect(maps.costoNota).toMatch(/falta integración/);
  });
});

describe('alertas con umbral heredado', () => {
  it('fuente muerta: el último capturado pasa los 7 días', async () => {
    prospectos = [p({ id: 'a', createdAt: hace(24 * 10), estado: 'contactado' })];
    const r = await getAdquisicion(AHORA);
    const a = r.alertas.find((x) => x.id === 'fuente_muerta');
    expect(a?.titulo).toMatch(/censo.*10 días/);
  });

  it('SLA de primer toque: solo nuevos >48h SIN contacto en el historial', async () => {
    prospectos = [
      p({ id: 'viejo-sin-toque', createdAt: hace(72) }),
      p({ id: 'viejo-contactado', createdAt: hace(72) }),
      p({ id: 'fresco', createdAt: hace(2) }),
    ];
    contactos = [{ prospecto_id: 'viejo-contactado' }];
    const r = await getAdquisicion(AHORA);
    const a = r.alertas.find((x) => x.id === 'sla_primer_toque');
    expect(a?.titulo).toMatch(/^1 lead /);
  });

  it('quemados: sobre el umbral del 10%, con el absoluto al lado', async () => {
    prospectos = [
      ...Array.from({ length: 8 }, (_, i) => p({ id: `c${i}`, estado: 'contactado' })),
      p({ id: 'p1', estado: 'perdido' }), p({ id: 'p2', estado: 'lost' }),
    ];
    const r = await getAdquisicion(AHORA);
    const a = r.alertas.find((x) => x.id === 'leads_quemados');
    expect(a?.titulo).toContain('2 de 10');
  });

  it('debajo de los umbrales, cero alertas — y las sin-fuente-de-datos se declaran', async () => {
    prospectos = [p({ id: 'a', createdAt: hace(1) })];
    const r = await getAdquisicion(AHORA);
    expect(r.alertas).toEqual([]);
    expect(r.sinFuenteDeDatos.map((s) => s.alerta).join(' ')).toMatch(/caliente.*CPL|CPL.*caliente/s);
  });
});

describe('fallar cerrado', () => {
  it('con el historial de contactos ilegible, LANZA — el SLA no se calcula a ciegas', async () => {
    prospectos = [p({ id: 'a' })];
    contactos = 'error';
    await expect(getAdquisicion(AHORA)).rejects.toThrow();
  });
});
