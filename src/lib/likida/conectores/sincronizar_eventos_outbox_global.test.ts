import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Http } from './tipos';

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../presupuesto', () => ({ acotada: (q: unknown) => q }));

const disparar = vi.hoisted(() => vi.fn(async () => ({
  resultado: 'abierta' as const, incidenciaId: 'inc-global', avisado: true,
})));
vi.mock('../asistencia_camara', () => ({ dispararAsistenciaPorEventoCamara: disparar }));

const estado = vi.hoisted(() => ({ reclamado: false }));
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
        claim_token: 'claim-evento',
      }],
      error: null,
    };
  }
  if (nombre === 'finalizar_evento_seguridad') return { data: true, error: null };
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
  });

  it('dispara lo ya durable aunque la credencial esté inactiva y no exista un poll', async () => {
    const http = vi.fn<Http>(async () => ({ estado: 500, cuerpo: '' }));

    const resultados = await sincronizarEventosTodas(http, {
      ahora: () => Date.parse('2026-09-03T12:00:00Z'),
    });

    expect(http).not.toHaveBeenCalled();
    expect(disparar).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-inactivo', eventoIdExterno: 'evt-credencial-inactiva',
    }));
    expect(resultados).toEqual([expect.objectContaining({
      tenantId: 'tenant-inactivo', proveedor: 'samsara', disparos: 1,
    })]);
  });
});
