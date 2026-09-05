import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// EL DISPARO POR CÁMARA — lo que más importa:
//  · la incidencia nace con la VERDAD de la cámara (siniestro/critica,
//    lesionados NULL — la cámara no da partes médicos);
//  · el aviso al jefe DICE la fuente y que el chofer no ha reportado;
//  · un expediente ya abierto recibe la detección como evidencia, sin un
//    segundo 🚨 — y la carrera contra el chofer la resuelve el índice 0201.
// ═══════════════════════════════════════════════════════════════════════════

const crearIncidencia = vi.hoisted(() => vi.fn(async () => 'inc-1'));
vi.mock('./operacion', () => ({ crearIncidencia }));

const anotarEventoIncidencia = vi.hoisted(() => vi.fn(async () => 'anotado' as const));
vi.mock('./asistencia_wa', () => ({
  anotarEventoIncidencia,
  TIPOS_ASISTENCIA: ['siniestro', 'robo', 'emergencia_medica', 'varado', 'bloqueo'],
  RANGO_TIPO: { robo: 4, emergencia_medica: 3, siniestro: 3, bloqueo: 2, varado: 1 },
}));

const telefonoJefeDe = vi.hoisted(() => vi.fn(async () => '+5215512345678'));
vi.mock('./contactos', () => ({ telefonoJefeDe }));

const sendButtons = vi.hoisted(() => vi.fn(async () => 'wamid.1'));
const encolarBotonesWhatsApp = vi.hoisted(() => vi.fn(async () => ({
  id: 'outbox-camara-1', estado: 'pending' as const, providerMessageId: null,
})));
vi.mock('@/lib/meta/client', () => ({
  MAX_CUERPO_BOTONES: 1024, sendButtons, encolarBotonesWhatsApp }));

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./presupuesto', () => ({ acotada: (q: unknown) => q }));

// La "base": viajes vigentes de la unidad, expediente abierto, rótulo de
// unidad. El builder es THENABLE (como el real de supabase-js):
// `expedienteAbierto` encadena `.eq()` DESPUÉS de `.limit(1)`, así que ningún
// método puede ser el que "cierra" — cierra el await. `abierta.cola` permite
// que lecturas sucesivas del expediente devuelvan cosas distintas (la carrera
// del 0201/0206). `viajes.filas` es LISTA: la ambigüedad de c2-6 son dos
// viajes cubriendo el mismo instante. `updates` registra los UPDATE a
// incidencia (la escalada de c2-3).
const viajes = vi.hoisted(() => ({ filas: [] as Array<Record<string, unknown>> }));
type Abierta = { id: string; tipo?: string; prioridad?: string };
const abierta = vi.hoisted(() => ({
  v: null as Abierta | null,
  cola: [] as Array<Abierta | null>,
}));
const updates = vi.hoisted(() => ({ incidencia: [] as Array<Record<string, unknown>>, fallaProximo: false }));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api: any = {};
      for (const m of ['select', 'eq', 'neq', 'in', 'order', 'limit', 'or', 'not', 'is']) api[m] = () => api;
      let esUpdate = false;
      api.update = (patch: Record<string, unknown>) => {
        esUpdate = true;
        if (tabla === 'incidencia') updates.incidencia.push(patch);
        return api;
      };
      api.maybeSingle = () => Promise.resolve({
        data: tabla === 'unidad' ? { numero_economico: 'T-12', placas: 'ABC-123' } : null,
        error: null,
      });
      api.then = (res: (v: unknown) => unknown) => {
        if (esUpdate) {
          const err = updates.fallaProximo ? { message: 'update caído' } : null;
          updates.fallaProximo = false;
          return res({ data: null, error: err });
        }
        if (tabla === 'viaje') return res({ data: viajes.filas, error: null });
        if (tabla === 'incidencia') {
          const f = abierta.cola.length > 0 ? abierta.cola.shift() : abierta.v;
          return res({ data: f ? [f] : [], error: null });
        }
        return res({ data: [], error: null });
      };
      return api;
    },
  }),
}));

import { dispararAsistenciaPorEventoCamara } from './asistencia_camara';

const EVENTO = {
  tenantId: 't-1',
  unidadId: 'u-1',
  proveedor: 'samsara',
  eventoIdExterno: 'evt-1',
  etiquetas: ['Crash'],
  lat: 20.97,
  lng: -89.62,
  ocurridoEn: '2026-08-26T18:00:00.000Z',
  urlEvento: 'https://cloud.samsara.com/x/evt-1',
  maxG: 2.4,
  viajeId: null,
  operadorId: null,
  viajeFolio: null,
  reintento: false,
};

describe('dispararAsistenciaPorEventoCamara', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    viajes.filas = [];
    abierta.v = null;
    abierta.cola = [];
    updates.incidencia = [];
    updates.fallaProximo = false;
  });

  it('abre siniestro crítico con lesionados NULL — la cámara no da partes médicos', async () => {
    viajes.filas = [{ id: 'v-equivocado', operador_id: 'op-equivocado', folio: 'F-MAL', estatus: 'abierto' }];
    const r = await dispararAsistenciaPorEventoCamara({
      ...EVENTO, viajeId: 'v-9', operadorId: 'op-9', viajeFolio: 'F-104',
    });
    expect(r.resultado).toBe('abierta');
    expect(crearIncidencia).toHaveBeenCalledWith('t-1', expect.objectContaining({
      tipo: 'siniestro',
      prioridad: 'critica',
      viajeId: 'v-9',
      operadorId: 'op-9',
      unidadId: 'u-1',
      hayLesionados: null,
      lat: 20.97,
      lng: -89.62,
    }));
    expect(r).toMatchObject({ avisoEstado: 'encolado', avisoOutboxId: 'outbox-camara-1' });
    expect(sendButtons).not.toHaveBeenCalled();
  });

  it('el aviso al jefe dice la FUENTE y que el chofer NO ha reportado', async () => {
    await dispararAsistenciaPorEventoCamara({ ...EVENTO, viajeId: 'v-9', operadorId: 'op-9', viajeFolio: 'F-104' });
    expect(encolarBotonesWhatsApp).toHaveBeenCalledTimes(1);
    const [tel, cuerpo, botones, dedupe] = encolarBotonesWhatsApp.mock.calls[0] as unknown as [string, string, Array<{ id: string }>, string];
    expect(tel).toBe('+5215512345678');
    expect(cuerpo).toContain('cámara');
    expect(cuerpo).toContain('T-12');
    expect(cuerpo).toContain('NO ha reportado');
    expect(cuerpo).toContain('viaje F-104');
    expect(botones[0].id).toBe('asi_ok:inc-1');
    expect(dedupe).toBe('gps:samsara:t-1:evt-1');
  });

  it('con expediente YA abierto e YA crítico, la detección se anota como evidencia — sin segundo 🚨', async () => {
    viajes.filas = [{ id: 'v-9', operador_id: 'op-9', folio: null, estatus: 'abierto' }];
    abierta.v = { id: 'inc-previa', tipo: 'siniestro', prioridad: 'critica' };
    const r = await dispararAsistenciaPorEventoCamara(EVENTO);
    expect(r).toMatchObject({ resultado: 'anotada_en_existente', incidenciaId: 'inc-previa' });
    expect(crearIncidencia).not.toHaveBeenCalled();
    expect(encolarBotonesWhatsApp).not.toHaveBeenCalled();
    expect(anotarEventoIncidencia).toHaveBeenCalledWith('t-1', 'inc-previa', 'deteccion_camara', expect.objectContaining({
      evento: 'evt-1', proveedor: 'samsara',
    }));
  });

  it('sin viaje abierto, la incidencia nace sin operador pero CON la unidad', async () => {
    const r = await dispararAsistenciaPorEventoCamara(EVENTO);
    expect(r.resultado).toBe('abierta');
    expect(crearIncidencia).toHaveBeenCalledWith('t-1', expect.objectContaining({
      viajeId: null, operadorId: null, unidadId: 'u-1',
    }));
  });

  it('la carrera contra el reporte del chofer: unique_violation → anota en el ganador', async () => {
    viajes.filas = [{ id: 'v-9', operador_id: 'op-9', folio: null, estatus: 'abierto' }];
    crearIncidencia.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint "incidencia_asistencia_abierta_unica"'));
    // Primera lectura: nadie ha abierto. Segunda (tras perder la carrera): el
    // expediente del ganador ya está ahí.
    abierta.cola = [null, { id: 'inc-ganadora' }];
    const r = await dispararAsistenciaPorEventoCamara(EVENTO);
    expect(r).toMatchObject({ resultado: 'anotada_en_existente', incidenciaId: 'inc-ganadora' });
    expect(sendButtons).not.toHaveBeenCalled();
  });

  it('un fallo NO lanza — la corrida de sincronización no muere por un disparo', async () => {
    viajes.filas = [{ id: 'v-9', operador_id: 'op-9', folio: null, estatus: 'abierto' }];
    crearIncidencia.mockRejectedValueOnce(new Error('base caída'));
    const r = await dispararAsistenciaPorEventoCamara(EVENTO);
    expect(r.resultado).toBe('fallo');
  });

  it('si el aviso al jefe falla, se dice en la bitácora — no se finge', async () => {
    viajes.filas = [{ id: 'v-9', operador_id: 'op-9', folio: null, estatus: 'abierto' }];
    encolarBotonesWhatsApp.mockResolvedValueOnce(null as never);
    const r = await dispararAsistenciaPorEventoCamara(EVENTO);
    expect(r.resultado).toBe('fallo');
    expect(anotarEventoIncidencia).toHaveBeenCalledWith('t-1', 'inc-1', 'aviso_jefe_fallido', expect.anything());
  });

  // ── AUDITORÍA FABLE CICLO 2 ────────────────────────────────────────────────

  it('c2-3: el varado de ayer NO se traga la colisión — escala en la misma fila y el jefe recibe el 🚨', async () => {
    viajes.filas = [{ id: 'v-9', operador_id: 'op-9', folio: 'F-104', estatus: 'abierto' }];
    abierta.v = { id: 'inc-varado', tipo: 'varado', prioridad: 'alta' };
    const r = await dispararAsistenciaPorEventoCamara(EVENTO);
    expect(r).toMatchObject({
      resultado: 'anotada_en_existente', incidenciaId: 'inc-varado',
      avisoEstado: 'encolado', avisoOutboxId: 'outbox-camara-1',
    });
    expect(crearIncidencia).not.toHaveBeenCalled();
    // La fila se actualizó: siniestro crítico, reconocimiento borrado.
    expect(updates.incidencia[0]).toMatchObject({
      tipo: 'siniestro', prioridad: 'critica', reconocida_en: null, reconocida_por: null,
    });
    // Y el 🚨 salió — anotar en silencio era el bug.
    expect(encolarBotonesWhatsApp).toHaveBeenCalledTimes(1);
    expect(anotarEventoIncidencia).toHaveBeenCalledWith('t-1', 'inc-varado', 'escalada', expect.objectContaining({
      de: 'varado', a: 'siniestro', fuente: 'camara',
    }));
  });

  it('c2-3: un ROBO crítico abierto NO se degrada a siniestro — la violencia manda y solo se anota', async () => {
    viajes.filas = [{ id: 'v-9', operador_id: 'op-9', folio: null, estatus: 'abierto' }];
    abierta.v = { id: 'inc-robo', tipo: 'robo', prioridad: 'critica' };
    const r = await dispararAsistenciaPorEventoCamara(EVENTO);
    expect(r).toMatchObject({ resultado: 'anotada_en_existente', incidenciaId: 'inc-robo' });
    expect(updates.incidencia).toHaveLength(0);
    expect(encolarBotonesWhatsApp).not.toHaveBeenCalled();
  });

  it('c2-3: si la escalada no se pudo escribir, el resultado es FALLO — el barrido lo reintenta', async () => {
    viajes.filas = [{ id: 'v-9', operador_id: 'op-9', folio: null, estatus: 'abierto' }];
    abierta.v = { id: 'inc-varado', tipo: 'varado', prioridad: 'alta' };
    updates.fallaProximo = true;
    const r = await dispararAsistenciaPorEventoCamara(EVENTO);
    expect(r.resultado).toBe('fallo');
    expect(encolarBotonesWhatsApp).not.toHaveBeenCalled();
  });

  it('c2-6: dos viajes con choferes DISTINTOS cubriendo el instante = ambiguo — expediente por unidad, no se adivina chofer', async () => {
    viajes.filas = [
      { id: 'v-b', operador_id: 'op-b', folio: 'F-2', estatus: 'abierto' },
      { id: 'v-a', operador_id: 'op-a', folio: 'F-1', estatus: 'en_cuadre' },
    ];
    const r = await dispararAsistenciaPorEventoCamara(EVENTO);
    expect(r.resultado).toBe('abierta');
    expect(crearIncidencia).toHaveBeenCalledWith('t-1', expect.objectContaining({
      viajeId: null, operadorId: null, unidadId: 'u-1',
    }));
  });

  it('c2-6: el viaje recién cerrado (en_cuadre) del MISMO chofer sigue siendo la ruta al operador', async () => {
    viajes.filas = [{ id: 'v-a', operador_id: 'op-a', folio: 'F-1', estatus: 'en_cuadre' }];
    const r = await dispararAsistenciaPorEventoCamara({
      ...EVENTO, viajeId: 'v-a', operadorId: 'op-a', viajeFolio: 'F-1',
    });
    expect(r.resultado).toBe('abierta');
    expect(crearIncidencia).toHaveBeenCalledWith('t-1', expect.objectContaining({
      viajeId: 'v-a', operadorId: 'op-a', unidadId: 'u-1',
    }));
  });
});
