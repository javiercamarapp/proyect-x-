import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Http } from './tipos';

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../presupuesto', () => ({ acotada: (q: unknown) => q }));
vi.mock('./cofre', () => ({ descifrar: (v: string) => JSON.parse(v) }));

const disparar = vi.hoisted(() => vi.fn(async () => ({
  resultado: 'abierta' as const, incidenciaId: 'inc-legacy', avisado: true,
})));
vi.mock('../asistencia_camara', () => ({ dispararAsistenciaPorEventoCamara: disparar }));

const estado = vi.hoisted(() => ({
  legacyReparado: false,
  eventoSellado: false,
  finalizacionesCuarentena: [] as Array<Record<string, unknown>>,
}));

const eventoRecuperado = {
  id: 'evt-legacy-null', startMs: '2026-07-05T18:00:00Z', asset: { id: 'dev-1' },
  behaviorLabels: [{ label: 'Crash' }], location: { latitude: 20.9, longitude: -89.5 },
};

const rpc = vi.hoisted(() => vi.fn(async (nombre: string, args: Record<string, unknown>) => {
  if (nombre === 'reclamar_eventos_seguridad') {
    if (!estado.legacyReparado || estado.eventoSellado) return { data: [], error: null };
    return { data: [{
      evento_id_externo: 'evt-legacy-null', unidad_id: 'u-1', etiquetas: ['Crash'],
      lat: 20.9, lng: -89.5, ocurrido_en: '2026-07-05T18:00:00Z',
      url_evento: null, max_g: null, claim_token: 'claim-outbox',
    }], error: null };
  }
  if (nombre === 'finalizar_evento_seguridad') {
    estado.eventoSellado = true;
    return { data: true, error: null };
  }
  if (nombre === 'reclamar_cuarentena_eventos') return { data: [
    { evento_id_externo: 'evt-legacy-null', ocurrido_en: '2026-07-05T18:00:00Z', motivo: 'legacy_unidad_null', claim_token: 'q-1' },
    { evento_id_externo: 'evt-legacy-null', ocurrido_en: '2026-07-05T18:00:00Z', motivo: 'unidad_sin_mapear', claim_token: 'q-2' },
  ], error: null };
  if (nombre === 'finalizar_cuarentena_evento') {
    estado.finalizacionesCuarentena.push(args);
    return { data: true, error: null };
  }
  return { data: null, error: { message: `rpc inesperado ${nombre}` } };
}));

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    rpc,
    from: (tabla: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api: any = {};
      let actualizandoLegacy = false;
      api.select = () => api;
      api.eq = () => api;
      api.in = () => api;
      api.or = () => api;
      api.is = () => api;
      api.not = () => api;
      api.order = () => api;
      api.limit = () => api;
      api.maybeSingle = () => Promise.resolve({ data: { zona_horaria: 'America/Tijuana' }, error: null });
      api.update = () => { actualizandoLegacy = true; return api; };
      api.upsert = () => ({ select: () => Promise.resolve({ data: [], error: null }) });
      api.then = (res: (v: unknown) => unknown) => {
        if (tabla === 'unidad') return res({ data: [{ id: 'u-1', gps_device_id: 'dev-1' }], error: null });
        if (tabla === 'viaje') return res({ data: [{
          unidad_id: 'u-1', operador_id: 'op-historico',
          fecha_inicio: '2026-07-05', fecha_fin: '2026-07-05', aceptado_en: null,
        }], error: null });
        if (tabla === 'operador') return res({ data: [{
          id: 'op-historico', aviso_privacidad_en: '2026-07-01T00:00:00Z',
        }], error: null });
        if (tabla === 'evento_seguridad_flota' && actualizandoLegacy) {
          estado.legacyReparado = true;
          return res({ data: null, error: null });
        }
        return res({ data: [], error: null });
      };
      return api;
    },
  }),
}));

import { sincronizarEventosDeFlota } from './sincronizar_eventos';

describe('reconciliador de cuarentena GPS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    estado.legacyReparado = false;
    estado.eventoSellado = false;
    estado.finalizacionesCuarentena = [];
  });

  it('relee el huérfano legacy, repara la misma fila NULL y libera todos sus claims por motivo', async () => {
    let llamada = 0;
    const http: Http = async () => {
      llamada += 1;
      return {
        estado: 200,
        cuerpo: JSON.stringify({ data: llamada <= 2 ? [eventoRecuperado] : [], pagination: { hasNextPage: false } }),
      };
    };

    const r = await sincronizarEventosDeFlota(
      't-1', 'samsara', JSON.stringify({ token: 'tok' }), http,
      new Date('2026-09-03T12:00:00Z'),
    );

    expect(estado.legacyReparado).toBe(true);
    expect(estado.finalizacionesCuarentena).toHaveLength(2);
    expect(estado.finalizacionesCuarentena.every((f) => f.p_resuelto === true)).toBe(true);
    expect(disparar).toHaveBeenCalledWith(expect.objectContaining({ eventoIdExterno: 'evt-legacy-null' }));
    expect(r.disparos).toBe(1);
  });
});
