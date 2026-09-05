import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../presupuesto', () => ({ acotada: (q: unknown) => q }));
const crearIncidencia = vi.hoisted(() => vi.fn(async () => 'inc-minima'));
vi.mock('../operacion', () => ({ crearIncidencia }));
const anotar = vi.hoisted(() => vi.fn(async () => 'anotado'));
vi.mock('../asistencia_wa', () => ({
  anotarEventoIncidencia: anotar,
  TIPOS_ASISTENCIA: ['siniestro', 'robo', 'varado'],
  RANGO_TIPO: { robo: 4, siniestro: 3, varado: 1 },
}));
vi.mock('../contactos', () => ({ telefonoJefeDe: async () => 'responsable-sintetico' }));
const encolar = vi.hoisted(() => vi.fn(async () => ({ id: 'outbox-minimo', estado: 'pending', providerMessageId: null })));
const enviar = vi.hoisted(() => vi.fn());
vi.mock('@/lib/meta/client', () => ({ MAX_CUERPO_BOTONES: 1024, encolarBotonesWhatsApp: encolar, sendButtons: enviar }));
const estado = vi.hoisted(() => ({ reclamado: false }));
const rpc = vi.hoisted(() => vi.fn(async (nombre: string) => {
  if (nombre === 'listar_outboxes_eventos_pendientes') return { data: [{ tenant_id: 't-minimo', proveedor: 'samsara' }], error: null };
  if (nombre === 'reclamar_eventos_seguridad') {
    if (estado.reclamado) return { data: [], error: null };
    estado.reclamado = true;
    return { data: [{ evento_id_externo: 'evt-minimo', unidad_id: 'u-minima', privacidad_minima: true,
      etiquetas: [], lat: null, lng: null, ocurrido_en: '2026-09-03T11:00:00Z',
      url_evento: null, max_g: null, viaje_id: null, operador_id: null, viaje_folio: null,
      claim_token: 'claim-minimo', intentos: 1 }], error: null };
  }
  if (nombre === 'finalizar_evento_seguridad') return { data: true, error: null };
  if (nombre === 'estado_eventos_gps_operativo' || nombre === 'reclamar_polls_conector') return { data: [], error: null };
  throw new Error(`RPC inesperada: ${nombre}`);
}));
const from = vi.hoisted(() => vi.fn((tabla: string) => {
  if (tabla !== 'unidad' && tabla !== 'incidencia') throw new Error(`No debe resolver persona/viaje: ${tabla}`);
  const api = {
    select: () => api, eq: () => api, in: () => api, neq: () => api, order: () => api, limit: () => api,
    maybeSingle: () => Promise.resolve({ data: { numero_economico: 'U-MINIMA' }, error: null }),
    then: (res: (v: unknown) => unknown) => res({ data: [], error: null }),
  };
  return api;
}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ rpc, from }) }));

// Ambos módulos productivos son reales: poller → asistencia_camara. Sólo
// fronteras DB/WhatsApp son dobles; ningún mensaje puede salir de esta prueba.
import { sincronizarEventosTodas } from './sincronizar_eventos';

beforeEach(() => { vi.clearAllMocks(); estado.reclamado = false; });

it('grave mínimo reclamado crea incidencia sin persona y encola aviso operativo con el mismo claim', async () => {
  const http = vi.fn(async () => ({ estado: 500, cuerpo: '' }));
  const r = await sincronizarEventosTodas(http);
  expect(http).not.toHaveBeenCalled();
  expect(crearIncidencia).toHaveBeenCalledExactlyOnceWith('t-minimo', expect.objectContaining({
    unidadId: 'u-minima', viajeId: null, operadorId: null, tipo: 'siniestro', prioridad: 'critica',
    lat: null, lng: null, hayLesionados: null,
  }));
  expect(encolar).toHaveBeenCalledExactlyOnceWith('responsable-sintetico', expect.stringContaining('U-MINIMA'),
    expect.any(Array), 'gps:samsara:t-minimo:evt-minimo');
  const generado = JSON.stringify([crearIncidencia.mock.calls, anotar.mock.calls, encolar.mock.calls]);
  expect(generado).not.toContain('maps.google');
  expect(generado).not.toContain('Video en');
  expect(generado).not.toContain('Fuerza máxima');
  expect(from).not.toHaveBeenCalledWith('viaje');
  expect(from).not.toHaveBeenCalledWith('operador');
  expect(enviar).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledWith('finalizar_evento_seguridad', expect.objectContaining({
    p_claim_token: 'claim-minimo', p_exito: true, p_incidencia_id: 'inc-minima',
    p_aviso_estado: 'pending', p_aviso_outbox_id: 'outbox-minimo',
  }));
  expect(r).toContainEqual(expect.objectContaining({ tenantId: 't-minimo', disparos: 1 }));
});
