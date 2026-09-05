import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24 — LO QUE EL POLLER DE GPS **NO** DEBE HACER.
//
// Tres hallazgos, un solo archivo porque comparten arnés:
//
//  · LEG-1 (CRÍTICO) — no se rastrea a quien nunca recibió el aviso de
//    privacidad (LFPDPPP art. 16). El poller escribe contra `unidad_id` y
//    nunca tenía al operador a la mano: 800 tractos × 288 posiciones/día
//    corrían sin la compuerta que la jornada sí tiene desde la auditoría 22.
//    Y si la base no contesta la pregunta, NO se guarda nada: «no sé si avisé»
//    no es permiso para rastrear.
//
//  · REN-2 (ALTO) — el tope de 500 lecturas por flota era un `.slice()` mudo.
//    Con las 800 unidades de Innovativos, las MISMAS 300 quedaban fuera en las
//    288 corridas del día y el cron latía «ok». Ahora el recorte se cuenta, se
//    loguea como error y el cron lo pinta `parcial`.
//
//  · REN-7 (MEDIO) — `.in()` viaja en la URL: 800 ids son ~30 KB y un 414 del
//    borde dejaba `gps_visto_en` nulo para la flota entera sin que nadie
//    mirara el error. Ahora va en tandas de 200 y el error se devuelve.
// ═══════════════════════════════════════════════════════════════════════════

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/likida/presupuesto', () => ({ acotada: (q: unknown) => q }));
vi.mock('../presupuesto', () => ({ acotada: (q: unknown) => q }));

/** 900 unidades de la misma flota: por encima de las 800 del piloto y de las
 *  200 de una tanda de `.in()`, que es justo lo que se quiere ejercitar. */
const UNIDADES = Array.from({ length: 900 }, (_, i) => ({
  id: `u-${i}`, tenant_id: 't-1', gps_proveedor: 'samsara', gps_device_id: `dev-${i}`,
}));

/** Viajes vivos y avisos: los pone cada prueba. */
let viajesVivos: Array<{ tenant_id: string; unidad_id: string; operador_id: string; estatus: string }> = [];
let operadores: Array<{ id: string; tenant_id: string; aviso_privacidad_en: string | null }> = [];
let errorViaje: { message: string } | null = null;
let errorOperador: { message: string } | null = null;
let errorSello: { message: string } | null = null;

let upserts: Array<Array<Record<string, unknown>>> = [];
let sellos: Array<{ ids: string[] }> = [];
/** Cuántos ids pidió cada `.in()`, por tabla: la prueba de REN-7 mide esto. */
let tamanosIn: Array<{ tabla: string; col: string; n: number }> = [];

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      const f: Record<string, unknown> = {};
      const filtros: Array<[string, unknown]> = [];
      const dentro: Array<{ col: string; vals: unknown[] }> = [];
      let modo: 'select' | 'upsert' | 'update' = 'select';
      let payload: unknown = null;

      const casa = (fila: Record<string, unknown>) =>
        filtros.every(([c, v]) => fila[c] === v) &&
        dentro.every((d) => d.vals.includes(fila[d.col]));

      const resolver = () => {
        for (const d of dentro) tamanosIn.push({ tabla, col: d.col, n: d.vals.length });

        if (tabla === 'unidad' && modo === 'update') {
          if (errorSello) return { data: null, error: errorSello };
          sellos.push({ ids: (dentro[0]?.vals ?? []) as string[] });
          return { data: null, error: null };
        }
        if (modo === 'upsert') {
          upserts.push(payload as Array<Record<string, unknown>>);
          return {
            data: (payload as Array<Record<string, unknown>>).map((_, i) => ({ id: `p-${i}` })),
            error: null,
          };
        }
        if (tabla === 'unidad') {
          return { data: UNIDADES.filter(casa).map((u) => ({ id: u.id, gps_device_id: u.gps_device_id })), error: null };
        }
        if (tabla === 'viaje') {
          if (errorViaje) return { data: null, error: errorViaje };
          return { data: viajesVivos.filter(casa).map((v) => ({ unidad_id: v.unidad_id, operador_id: v.operador_id })), error: null };
        }
        if (tabla === 'operador') {
          if (errorOperador) return { data: null, error: errorOperador };
          return { data: operadores.filter(casa).map((o) => ({ id: o.id, aviso_privacidad_en: o.aviso_privacidad_en })), error: null };
        }
        return { data: [], error: null };
      };

      Object.assign(f, {
        select: () => f,
        eq: (c: string, v: unknown) => { filtros.push([c, v]); return f; },
        in: (c: string, vals: unknown[]) => { dentro.push({ col: c, vals }); return f; },
        upsert: (filas: unknown) => { modo = 'upsert'; payload = filas; return f; },
        update: (v: unknown) => { modo = 'update'; payload = v; return f; },
        then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve(resolver()).then(res, rej),
      });
      return f;
    },
  }),
}));

vi.mock('./cofre', () => ({ descifrar: (s: string) => JSON.parse(s) as Record<string, string> }));

import { sincronizarGpsDeFlota } from './sincronizar_gps';
import type { Http } from './tipos';

const CRED = JSON.stringify({ token: 'tok' });
const AHORA = Date.parse('2026-09-01T18:00:00Z');
const ahora = () => AHORA;

/** `n` lecturas válidas, una por unidad, todas fechadas ahora. */
const lecturas = (n: number, desde = 0) =>
  JSON.stringify({
    data: Array.from({ length: n }, (_, i) => ({
      id: `dev-${i + desde}`,
      gps: { latitude: 20.9 + i * 0.0001, longitude: -89.5, time: new Date(AHORA - 60_000).toISOString() },
    })),
  });

const httpQue = (cuerpo: string): Http => async () => ({ estado: 200, cuerpo });

/** Todas las unidades tocadas por `n` lecturas, con viaje vivo y aviso dado. */
function conAvisoTodos(n: number) {
  viajesVivos = Array.from({ length: n }, (_, i) => ({
    tenant_id: 't-1', unidad_id: `u-${i}`, operador_id: `op-${i}`, estatus: 'abierto',
  }));
  operadores = Array.from({ length: n }, (_, i) => ({
    id: `op-${i}`, tenant_id: 't-1', aviso_privacidad_en: '2026-08-01T00:00:00Z',
  }));
}

const filasGuardadas = () => upserts.flat();

beforeEach(() => {
  upserts = []; sellos = []; tamanosIn = [];
  viajesVivos = []; operadores = [];
  errorViaje = null; errorOperador = null; errorSello = null;
});

// ─────────────────────────────────────────────────────────────────────────
describe('LEG-1 · no se rastrea antes de avisar', () => {
  it('la unidad cuyo operador NO tiene aviso no deja ni una posición', async () => {
    viajesVivos = [
      { tenant_id: 't-1', unidad_id: 'u-0', operador_id: 'op-sin', estatus: 'abierto' },
      { tenant_id: 't-1', unidad_id: 'u-1', operador_id: 'op-con', estatus: 'abierto' },
    ];
    operadores = [
      { id: 'op-sin', tenant_id: 't-1', aviso_privacidad_en: null },
      { id: 'op-con', tenant_id: 't-1', aviso_privacidad_en: '2026-08-01T00:00:00Z' },
    ];

    const r = await sincronizarGpsDeFlota('t-1', 'samsara', CRED, httpQue(lecturas(2)), ahora);

    expect(r.error).toBeUndefined();
    expect(r.sinAvisoPrevio).toBe(1);
    const unidades = filasGuardadas().map((f) => f.unidad_id);
    expect(unidades).toEqual(['u-1']);
    expect(unidades).not.toContain('u-0');
    // Y tampoco se sella `gps_visto_en` de la que no se guardó: el panel no
    // puede decir «la fuente ya entra» de un camión que no estamos leyendo.
    expect(sellos.flatMap((s) => s.ids)).toEqual(['u-1']);
  });

  it('una unidad SIN viaje vivo sí se guarda: es un camión, no un titular', async () => {
    // Nadie va al volante: la posición no es dato personal de nadie.
    const r = await sincronizarGpsDeFlota('t-1', 'samsara', CRED, httpQue(lecturas(1)), ahora);
    expect(r.sinAvisoPrevio).toBeUndefined();
    expect(filasGuardadas().map((f) => f.unidad_id)).toEqual(['u-0']);
  });

  it('el viaje CERRADO no ata a nadie: se consulta sólo abierto/en_cuadre', async () => {
    viajesVivos = [{ tenant_id: 't-1', unidad_id: 'u-0', operador_id: 'op-sin', estatus: 'liquidado' }];
    operadores = [{ id: 'op-sin', tenant_id: 't-1', aviso_privacidad_en: null }];
    const r = await sincronizarGpsDeFlota('t-1', 'samsara', CRED, httpQue(lecturas(1)), ahora);
    expect(r.sinAvisoPrevio).toBeUndefined();
    expect(filasGuardadas()).toHaveLength(1);
  });

  it('si la base no dice quién va al volante, NO se guarda nada (fallar cerrado)', async () => {
    errorViaje = { message: 'timeout' };
    const r = await sincronizarGpsDeFlota('t-1', 'samsara', CRED, httpQue(lecturas(3)), ahora);
    expect(r.error).toMatch(/no se guardó ninguna posición/);
    expect(r.guardadas).toBe(0);
    expect(upserts).toHaveLength(0);
  });

  it('si no se puede leer el aviso de los operadores, tampoco se guarda nada', async () => {
    conAvisoTodos(3);
    errorOperador = { message: 'conexión caída' };
    const r = await sincronizarGpsDeFlota('t-1', 'samsara', CRED, httpQue(lecturas(3)), ahora);
    expect(r.error).toMatch(/no se guardó ninguna posición/);
    expect(upserts).toHaveLength(0);
  });

  it('dos operadores vivos en la misma unidad fallan cerrado aunque ambos tengan aviso', async () => {
    viajesVivos = [
      { tenant_id: 't-1', unidad_id: 'u-0', operador_id: 'op-a', estatus: 'abierto' },
      { tenant_id: 't-1', unidad_id: 'u-0', operador_id: 'op-b', estatus: 'en_cuadre' },
    ];
    operadores = [
      { id: 'op-a', tenant_id: 't-1', aviso_privacidad_en: '2026-08-01T00:00:00Z' },
      { id: 'op-b', tenant_id: 't-1', aviso_privacidad_en: '2026-08-01T00:00:00Z' },
    ];

    const r = await sincronizarGpsDeFlota('t-1', 'samsara', CRED, httpQue(lecturas(1)), ahora);

    expect(r.sinAvisoPrevio).toBe(1);
    expect(r.guardadas).toBe(0);
    expect(filasGuardadas()).toEqual([]);
    expect(sellos).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('REN-2 · el tope deja de ser mudo', () => {
  it('las 800 unidades del piloto caben enteras: nada se recorta', async () => {
    conAvisoTodos(800);
    const r = await sincronizarGpsDeFlota('t-1', 'samsara', CRED, httpQue(lecturas(800)), ahora);
    expect(r.error).toBeUndefined();
    expect(r.recortadas).toBeUndefined();
    expect(r.leidas).toBe(800);
    expect(r.guardadas).toBe(800);
    expect(filasGuardadas()).toHaveLength(800);
  });

  it('descarta la lectura fechada en el futuro y LO DICE, sin tumbar la tanda', async () => {
    // Un GPS con el reloj en 2030 reventaría el CHECK de la 0287 y se llevaría
    // por delante el upsert de la flota entera.
    const cuerpo = JSON.stringify({
      data: [
        { id: 'dev-0', gps: { latitude: 20.9, longitude: -89.5, time: new Date(AHORA - 60_000).toISOString() } },
        { id: 'dev-1', gps: { latitude: 21.0, longitude: -89.4, time: '2030-01-01T00:00:00Z' } },
      ],
    });
    const r = await sincronizarGpsDeFlota('t-1', 'samsara', CRED, httpQue(cuerpo), ahora);
    expect(r.descartadas).toBe(1);
    expect(r.leidas).toBe(1);
    expect(filasGuardadas().map((f) => f.unidad_id)).toEqual(['u-0']);
  });

  it('velocidad 257.5 se descarta sola y las otras 499 sí llegan a Postgres', async () => {
    conAvisoTodos(500);
    const cuerpo = JSON.stringify({
      data: Array.from({ length: 500 }, (_, i) => ({
        id: `dev-${i}`,
        gps: {
          latitude: 20.9 + i * 0.00001,
          longitude: -89.5,
          time: new Date(AHORA - 60_000).toISOString(),
          // 160 mph normaliza a 257.5 km/h: viola exactamente CHECK < 250.
          speedMilesPerHour: i === 201 ? 160 : 10,
        },
      })),
    });

    const r = await sincronizarGpsDeFlota('t-1', 'samsara', CRED, httpQue(cuerpo), ahora);

    expect(r.descartadas).toBe(1);
    expect(r.leidas).toBe(499);
    expect(r.guardadas).toBe(499);
    expect(filasGuardadas()).toHaveLength(499);
    expect(filasGuardadas().some((f) => f.unidad_id === 'u-201')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('REN-7 · las listas que viajan en la URL van en tandas', () => {
  it('ni una consulta `.in()` pide más de 200 ids, con 800 unidades', async () => {
    conAvisoTodos(800);
    await sincronizarGpsDeFlota('t-1', 'samsara', CRED, httpQue(lecturas(800)), ahora);
    expect(tamanosIn.length).toBeGreaterThan(0);
    const excesivas = tamanosIn.filter((t) => t.n > 200);
    expect(excesivas).toEqual([]);
  });

  it('el upsert va en tandas de 500, no en una sola de 800', async () => {
    conAvisoTodos(800);
    await sincronizarGpsDeFlota('t-1', 'samsara', CRED, httpQue(lecturas(800)), ahora);
    expect(upserts.length).toBe(2);
    expect(upserts.every((t) => t.length <= 500)).toBe(true);
  });

  it('un fallo al sellar `gps_visto_en` se DICE: no se tira el error', async () => {
    conAvisoTodos(1);
    errorSello = { message: '414 URI Too Long' };
    const r = await sincronizarGpsDeFlota('t-1', 'samsara', CRED, httpQue(lecturas(1)), ahora);
    expect(r.error).toMatch(/no se pudo sellar gps_visto_en/);
    // Las posiciones sí se guardaron: el resultado no lo niega.
    expect(r.guardadas).toBe(1);
  });
});
