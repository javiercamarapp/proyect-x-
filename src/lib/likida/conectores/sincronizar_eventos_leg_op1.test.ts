import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Http } from './tipos';

// Merge LEG-OP-1 + privacidad histórica: la asistencia conserva sólo los
// metadatos operativos mínimos cuando no puede acreditarse el aviso previo.
// La cuarentena conserva la referencia opaca para revisar el dato original.

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../presupuesto', () => ({ acotada: (q: unknown) => q }));
vi.mock('./cofre', () => ({ descifrar: (v: string) => JSON.parse(v) }));

const disparar = vi.hoisted(() => vi.fn(async () => ({ resultado: 'abierta' as const, incidenciaId: 'inc-1', avisoEstado: 'no_requerido' as const })));
vi.mock('../asistencia_camara', () => ({ dispararAsistenciaPorEventoCamara: disparar }));

const UNIDADES = vi.hoisted(() => [
  { id: 'u-1', tenant_id: 't-1', gps_proveedor: 'samsara', gps_device_id: 'dev-1' },
]);

const estado = vi.hoisted(() => ({
  guardados: new Map<string, Record<string, unknown>>(),
  sellados: new Set<string>(),
  sellos: [] as Array<Record<string, unknown>>,
  cuarentena: [] as Array<Record<string, unknown>>,
  errorViaje: false,
  viajes: [] as Array<Record<string, unknown>>,
  operadores: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api: any = {};
      const filtros: Record<string, unknown> = {};
      let esUpdate = false;
      api.select = () => api;
      api.eq = (c: string, v: unknown) => { filtros[c] = v; return api; };
      api.in = (c: string, v: unknown[]) => { filtros[`in:${c}`] = v; return api; };
      api.not = () => api;
      api.is = () => api;
      api.order = () => api;
      api.limit = () => api;
      api.or = () => api;
      api.maybeSingle = () => Promise.resolve({ data: { zona_horaria: 'America/Mexico_City' }, error: null });

      if (tabla === 'unidad') {
        api.then = (res: (v: unknown) => unknown) => res({
          data: UNIDADES.filter((u) =>
            u.tenant_id === filtros.tenant_id && u.gps_proveedor === filtros.gps_proveedor &&
            (filtros['in:gps_device_id'] as unknown[]).includes(u.gps_device_id)),
          error: null,
        });
      } else if (tabla === 'evento_seguridad_flota') {
        api.upsert = (filas: Array<Record<string, unknown>>) => ({
          select: () => {
            const nuevas = filas.filter((fila) => {
              const llave = `${fila.tenant_id}|${fila.proveedor}|${fila.evento_id_externo}`;
              if (estado.guardados.has(llave)) return false;
              estado.guardados.set(llave, fila);
              return true;
            });
            return Promise.resolve({ data: nuevas.map((fila) => ({ id: `fila-${fila.evento_id_externo}`, evento_id_externo: fila.evento_id_externo })), error: null });
          },
        });
        api.update = (cambios: Record<string, unknown>) => { esUpdate = true; estado.sellos.push(cambios); return api; };
        api.then = (res: (v: unknown) => unknown) => {
          if (esUpdate) {
            estado.sellados.add(`${filtros.tenant_id}|${filtros.proveedor}|${filtros.evento_id_externo}`);
            return res({ data: null, error: null });
          }
          // El barrido de graves pendientes: grave, con unidad, sin sellar.
          const pendientes = [...estado.guardados.entries()]
            .filter(([llave, f]) =>
              f.tenant_id === filtros.tenant_id && f.proveedor === filtros.proveedor &&
              f.grave === true && f.unidad_id !== null && !estado.sellados.has(llave))
            .map(([, f]) => f);
          return res({ data: pendientes, error: null });
        };
      } else if (tabla === 'viaje') {
        api.then = (res: (v: unknown) => unknown) => res({
          data: estado.viajes.filter((v) =>
            v.tenant_id === filtros.tenant_id &&
            (filtros['in:unidad_id'] as string[]).includes(v.unidad_id as string)),
          error: estado.errorViaje ? { message: 'historia no disponible' } : null,
        });
      } else if (tabla === 'operador') {
        api.then = (res: (v: unknown) => unknown) => res({
          data: estado.operadores.filter((o) =>
            o.tenant_id === filtros.tenant_id && (filtros['in:id'] as string[]).includes(o.id as string)),
          error: null,
        });
      } else if (tabla === 'evento_seguridad_cuarentena') {
        api.upsert = (filas: Array<Record<string, unknown>>) => ({ select: () => { estado.cuarentena.push(...filas); return Promise.resolve({ data: filas, error: null }); } });
      } else {
        api.then = (res: (v: unknown) => unknown) => res({ data: [], error: null });
      }
      return api;
    },
  }),
}));

import { sincronizarEventosDeFlota } from './sincronizar_eventos';

const CRED = JSON.stringify({ token: 'tok-1' });
const AHORA = new Date('2026-09-03T18:00:00Z');

const samsaraCon = (eventos: unknown[]): Http => async () => ({
  estado: 200,
  cuerpo: JSON.stringify({ data: eventos, pagination: { hasNextPage: false } }),
});

const CHOQUE = {
  id: 'evt-choque',
  startMs: '2026-09-03T17:55:00Z',
  asset: { id: 'dev-1' },
  location: { latitude: 20.97, longitude: -89.62 },
  behaviorLabels: [{ label: 'Crash' }, { label: 'Driver CANARIO' }],
  inboxEventUrl: 'https://video.test/privado-CANARIO',
  maxAccelerationGForce: 8.7,
};
const FRENADO = {
  id: 'evt-frenado',
  startMs: '2026-09-03T17:56:00Z',
  asset: { id: 'dev-1' },
  behaviorLabels: [{ label: 'Braking' }],
};

/** `u-1` lleva viaje vivo; `aviso` decide si su operador ya recibió el aviso. */
function conViajeVivo(aviso: boolean) {
  estado.viajes.push({ id: 'v-1', folio: 'F-1', tenant_id: 't-1', unidad_id: 'u-1', operador_id: 'op-1', estatus: 'abierto', fecha_inicio: '2026-09-01', fecha_fin: null });
  estado.operadores.push({ id: 'op-1', tenant_id: 't-1', aviso_privacidad_en: aviso ? '2026-08-01T00:00:00Z' : null });
}

beforeEach(() => {
  vi.clearAllMocks();
  estado.guardados.clear();
  estado.sellados.clear();
  estado.sellos = [];
  estado.cuarentena = [];
  estado.errorViaje = false;
  estado.viajes = [];
  estado.operadores = [];
});

describe('LEG-OP-1 · un evento GRAVE no depende del aviso previo', () => {
  it('GRAVE + CON viaje vivo y aviso: se guarda y dispara (control)', async () => {
    conViajeVivo(true);
    const r = await sincronizarEventosDeFlota('t-1', 'samsara', CRED, samsaraCon([CHOQUE]), AHORA);
    expect(r.guardados).toBe(1);
    expect(r.disparos).toBe(1);
    expect(r.sinAvisoPrevio).toBeUndefined();
    expect(disparar).toHaveBeenCalledTimes(1);
  });

  it('GRAVE + SIN viaje histórico: asistencia mínima y cuarentena sin datos de cámara', async () => {
    // Sin conViajeVivo(): u-1 no tiene viaje abierto ni en_cuadre.
    const r = await sincronizarEventosDeFlota('t-1', 'samsara', CRED, samsaraCon([CHOQUE]), AHORA);
    expect(r.guardados).toBe(1);
    expect(r.disparos).toBe(1);
    expect(r.sinAvisoPrevio).toBe(1);
    expect(disparar).toHaveBeenCalledTimes(1);
    comprobarMinimo();
    expect(disparar).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't-1', unidadId: 'u-1', eventoIdExterno: 'evt-choque',
    }));
  });

  it('GRAVE + CON viaje pero SIN aviso: asistencia mínima sin vincular al conductor', async () => {
    conViajeVivo(false);
    const r = await sincronizarEventosDeFlota('t-1', 'samsara', CRED, samsaraCon([CHOQUE]), AHORA);
    expect(r.guardados).toBe(1);
    expect(r.disparos).toBe(1);
    expect(r.sinAvisoPrevio).toBe(1);
    expect(disparar).toHaveBeenCalledTimes(1);
    comprobarMinimo();
  });

  it('RUTINARIO + CON viaje vivo pero SIN aviso: NO se guarda — LEG-1 se mantiene', async () => {
    conViajeVivo(false);
    const r = await sincronizarEventosDeFlota('t-1', 'samsara', CRED, samsaraCon([FRENADO]), AHORA);
    expect(r.guardados).toBe(0);
    expect(r.sinAvisoPrevio).toBe(1);
    expect(r.disparos).toBe(0);
    expect(disparar).not.toHaveBeenCalled();
  });

  it('RUTINARIO + SIN viaje vivo: NO se guarda — LEG-1 se mantiene', async () => {
    const r = await sincronizarEventosDeFlota('t-1', 'samsara', CRED, samsaraCon([FRENADO]), AHORA);
    expect(r.guardados).toBe(0);
    expect(r.sinAvisoPrevio).toBe(1);
    expect(r.disparos).toBe(0);
    expect(disparar).not.toHaveBeenCalled();
  });

  it('mezcla grave + rutinario en la misma corrida: el grave entra, el rutinario se bloquea', async () => {
    // u-1 sin viaje vivo: el rutinario se bloquea, pero el grave de la MISMA
    // unidad en la MISMA corrida no debe quedar rehén de esa compuerta.
    const r = await sincronizarEventosDeFlota(
      't-1', 'samsara', CRED, samsaraCon([CHOQUE, FRENADO]), AHORA,
    );
    expect(r.leidos).toBe(2);
    expect(r.guardados).toBe(1);
    expect(r.sinAvisoPrevio).toBe(1);
    expect(r.disparos).toBe(1);
    expect(disparar).toHaveBeenCalledTimes(1);
    comprobarMinimo();
    const filas = [...estado.guardados.values()];
    expect(filas).toHaveLength(1);
    expect(filas[0].evento_id_externo).toBe('evt-choque');
  });
});

function comprobarMinimo() {
  const fila = [...estado.guardados.values()][0];
  expect(fila).toMatchObject({ privacidad_minima: true, grave: true, unidad_id: 'u-1',
    asset_id: null, etiquetas: [], lat: null, lng: null, url_evento: null, max_g: null,
    viaje_id: null, operador_id: null, viaje_folio: null, ocurrido_en: '2026-09-03T17:00:00.000Z' });
  expect(disparar).toHaveBeenCalledWith(expect.objectContaining({
    tenantId: 't-1', unidadId: 'u-1', eventoIdExterno: 'evt-choque',
    etiquetas: [], lat: null, lng: null, urlEvento: null, maxG: null,
    viajeId: null, operadorId: null, viajeFolio: null, ocurridoEn: '2026-09-03T17:00:00.000Z',
  }));
  expect(estado.cuarentena.length).toBeGreaterThan(0);
  for (const referencia of estado.cuarentena) {
    expect(referencia.evento_id_externo).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (const campo of ['lat', 'lng', 'url_evento', 'etiquetas', 'unidad_id', 'operador_id']) expect(referencia).not.toHaveProperty(campo);
  }
  expect(JSON.stringify([fila, disparar.mock.calls])).not.toContain('CANARIO');
}

it('el mismo grave autorizado después no duplica asistencia ni restaura datos en la fila mínima', async () => {
  await sincronizarEventosDeFlota('t-1', 'samsara', CRED, samsaraCon([CHOQUE]), AHORA);
  comprobarMinimo();
  conViajeVivo(true);
  const r = await sincronizarEventosDeFlota('t-1', 'samsara', CRED, samsaraCon([CHOQUE]), AHORA);
  expect(r.guardados).toBe(0);
  expect(r.disparos).toBe(0);
  expect(estado.guardados.size).toBe(1);
  expect(disparar).toHaveBeenCalledTimes(1);
  comprobarMinimo();
});

it('historia ilegible: asistencia mínima grave, rutinario cerrado y watermark con error', async () => {
  estado.errorViaje = true;
  const r = await sincronizarEventosDeFlota('t-1', 'samsara', CRED, samsaraCon([CHOQUE, FRENADO]), AHORA);
  expect(r.error).toContain('conductor histórico');
  expect(r.backlog).toBe(true);
  expect(r.guardados).toBe(1);
  expect(r.disparos).toBe(1);
  comprobarMinimo();
});
