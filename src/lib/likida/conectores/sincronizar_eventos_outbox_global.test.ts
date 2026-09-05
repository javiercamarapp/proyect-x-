import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Http } from './tipos';

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../presupuesto', () => ({ acotada: (q: unknown) => q }));

const disparar = vi.hoisted(() => vi.fn(async () => ({
  resultado: 'abierta' as const, incidenciaId: 'inc-global',
  avisoEstado: 'encolado' as const, avisoOutboxId: 'outbox-global',
})));
vi.mock('../asistencia_camara', () => ({ dispararAsistenciaPorEventoCamara: disparar }));

const estado = vi.hoisted(() => ({ reclamado: false, salud: [] as Array<Record<string, unknown>>, minimo: false, override: {} as Record<string, unknown> }));
const rpc = vi.hoisted(() => vi.fn(async (nombre: string) => {
  if (nombre === 'listar_outboxes_eventos_pendientes') {
    return { data: [{ tenant_id: 'tenant-inactivo', proveedor: 'samsara' }], error: null };
  }
  if (nombre === 'reclamar_eventos_seguridad') {
    if (estado.reclamado) return { data: [], error: null };
    estado.reclamado = true;
    return {
      data: [{
        evento_id_externo: 'evt-credencial-inactiva', unidad_id: 'unidad-1',
        etiquetas: ['Crash'], lat: 20.9, lng: -89.5,
        ocurrido_en: '2026-09-03T11:59:00Z', url_evento: null, max_g: 2.1,
        claim_token: 'claim-evento', viaje_id: 'viaje-1', operador_id: 'operador-1',
        viaje_folio: 'F-1', intentos: 1, privacidad_minima: false,
        ...(estado.minimo ? { privacidad_minima: true, etiquetas: [], lat: null, lng: null,
          url_evento: null, max_g: null, viaje_id: null, operador_id: null, viaje_folio: null,
          ocurrido_en: '2026-09-03T11:00:00Z' } : {}),
        ...estado.override,
      }],
      error: null,
    };
  }
  if (nombre === 'finalizar_evento_seguridad') return { data: true, error: null };
  if (nombre === 'estado_eventos_gps_operativo') return { data: estado.salud, error: null };
  // No hay credencial activa: el outbox global debe bastar.
  if (nombre === 'reclamar_polls_conector') return { data: [], error: null };
  return { data: null, error: { message: `rpc inesperado ${nombre}` } };
}));

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ rpc }) }));

import { sincronizarEventosTodas } from './sincronizar_eventos';

describe('outbox global de eventos graves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    estado.reclamado = false;
    estado.salud = [];
    estado.minimo = false;
    estado.override = {};
  });

  it('dispara lo ya durable aunque la credencial esté inactiva y no exista un poll', async () => {
    const http = vi.fn<Http>(async () => ({ estado: 500, cuerpo: '' }));

    const resultados = await sincronizarEventosTodas(http, {
      ahora: () => Date.parse('2026-09-03T12:00:00Z'),
    });

    expect(http).not.toHaveBeenCalled();
    expect(disparar).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-inactivo', eventoIdExterno: 'evt-credencial-inactiva',
      viajeId: 'viaje-1', operadorId: 'operador-1', viajeFolio: 'F-1',
    }));
    expect(rpc).toHaveBeenCalledWith('finalizar_evento_seguridad', expect.objectContaining({
      p_incidencia_id: 'inc-global', p_aviso_estado: 'pending',
      p_aviso_outbox_id: 'outbox-global',
    }));
    expect(resultados).toEqual([expect.objectContaining({
      tenantId: 'tenant-inactivo', proveedor: 'samsara', disparos: 1,
    })]);
  });

  it('reporta un aviso muerto aunque ya no sea reclamable ni tenga credencial activa', async () => {
    estado.reclamado = true;
    estado.salud = [{
      tenant_id: 'tenant-muerto', proveedor: 'samsara',
      eventos_en_cuarentena: 0, eventos_cuarentena_muertos: 0,
      eventos_outbox_pendientes: 0, eventos_outbox_muertos: 0,
      avisos_pendientes: 0, avisos_muertos: 1,
    }];
    const resultados = await sincronizarEventosTodas(async () => ({ estado: 500, cuerpo: '' }));
    expect(resultados).toContainEqual(expect.objectContaining({
      tenantId: 'tenant-muerto', proveedor: 'samsara', avisosMuertos: 1,
    }));
  });
  it('mínimo durable sin credencial genera incidencia/outbox y conserva el claim hasta confirmar entrega', async () => {
    estado.minimo = true;
    const http = vi.fn<Http>(async () => ({ estado: 500, cuerpo: '' }));
    const resultados = await sincronizarEventosTodas(http);
    expect(http).not.toHaveBeenCalled();
    expect(disparar).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      unidadId: 'unidad-1', etiquetas: [], lat: null, lng: null, maxG: null,
      urlEvento: null, viajeId: null, operadorId: null, viajeFolio: null,
      ocurridoEn: '2026-09-03T11:00:00Z',
    }));
    expect(rpc).toHaveBeenCalledWith('finalizar_evento_seguridad', expect.objectContaining({
      p_evento_id_externo: 'evt-credencial-inactiva', p_claim_token: 'claim-evento',
      p_exito: true, p_incidencia_id: 'inc-global', p_aviso_estado: 'pending',
      p_aviso_outbox_id: 'outbox-global',
    }));
    expect(resultados).toContainEqual(expect.objectContaining({ disparos: 1 }));
  });

  it.each([
    { lat: 20.9 }, { lng: -89.5 }, { url_evento: 'https://video.test/privado' },
    { etiquetas: ['Crash', 'Driver CANARIO'] }, { max_g: 8.7 },
    { viaje_id: 'viaje-1' }, { operador_id: 'operador-1' }, { viaje_folio: 'F-1' },
    { unidad_id: null }, { ocurrido_en: '2026-09-03T11:59:00Z' },
    { ocurrido_en: 'infinity' },
    { privacidad_minima: false },
  ])('rechaza claim mínimo malformado sin propagar datos a asistencia: %j', async (override) => {
    estado.minimo = true;
    estado.override = override;
    const resultados = await sincronizarEventosTodas(async () => ({ estado: 500, cuerpo: '' }));
    expect(disparar).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('finalizar_evento_seguridad', expect.objectContaining({
      p_claim_token: 'claim-evento', p_exito: false, p_incidencia_id: null,
      p_aviso_outbox_id: null, p_error: 'el claim no cumple el contrato de privacidad',
    }));
    expect(resultados).toContainEqual(expect.objectContaining({ disparos: 0, backlog: true }));
  });

});
