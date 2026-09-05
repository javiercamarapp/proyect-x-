import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// EL CRON DE GPS — el reloj que la ruta le presta a sus DOS fases.
//
// Auditoría 21, CRÍTICO de rendimiento: este era el único cron de los diez sin
// reloj duro, con su propia medición (posiciones solas ~180 s de un techo de
// 300, RENDIMIENTO-19C2-4) avisando que el kill de Vercel a media fase de
// eventos era cuestión de que N creciera — y lo que se quedaba sin correr era
// el barrido de graves (choque/volcadura), sin latido y sin alerta: el mismo
// silencio que mató al runner el 25 y el 28-ago-2026. Lo que se fija aquí:
//
//   · `venceEn` = ahora + maxDuration − margen SE LE PASA a las dos fases —
//     regla de la casa (PR #152 / ESC-3): todo motor que itere recibe el reloj;
//   · es EL MISMO instante para posiciones y eventos (molde de `descarga-sat`:
//     dos fases en serie comparten UN reloj, ninguna se come a ciegas el
//     presupuesto de la otra);
//   · flotas sin turno → latido `parcial` y el número VIAJA EN EL CUERPO, no
//     solo en el log;
//   · una corrida limpia sigue latiendo `ok`: el campo nuevo no la ensucia.
// ═══════════════════════════════════════════════════════════════════════════

let interruptor: 'encendido' | 'apagado' | 'ilegible' = 'encendido';
vi.mock('@/lib/likida/interruptores', () => ({
  leerInterruptor: async () => interruptor,
}));

const { logger } = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/logger', () => ({ logger }));

const registrarLatido = vi.fn(async () => {});
vi.mock('@/lib/admin/salud', () => ({
  registrarLatido: (...a: unknown[]) => registrarLatido(...(a as [])),
  puertaCron: async (_c: string, req: Request) =>
    req.headers.get('authorization') === 'Bearer secreto-de-prueba'
      ? null
      : new Response(null, { status: 401 }),
}));

interface FlotaFalsa {
  tenantId: string; proveedor: string;
  leidas: number; guardadas: number; huerfanas: number;
  sinTurno?: boolean; error?: string;
}
interface EventosFalsos {
  tenantId: string; proveedor: string;
  leidos: number; guardados: number; huerfanos: number; disparos: number;
  sinTurno?: boolean; sinPermiso?: boolean; error?: string;
  eventosEnCuarentena?: number; eventosCuarentenaMuertos?: number;
  eventosOutboxPendientes?: number; eventosOutboxMuertos?: number;
  avisosPendientes?: number; avisosMuertos?: number;
}
const flotaOk = (t: string): FlotaFalsa =>
  ({ tenantId: t, proveedor: 'samsara', leidas: 2, guardadas: 2, huerfanas: 0 });
const flotaSinTurno = (t: string): FlotaFalsa =>
  ({ tenantId: t, proveedor: 'samsara', leidas: 0, guardadas: 0, huerfanas: 0, sinTurno: true });
const eventosOk = (t: string): EventosFalsos =>
  ({ tenantId: t, proveedor: 'samsara', leidos: 1, guardados: 1, huerfanos: 0, disparos: 0 });
const eventosSinTurno = (t: string): EventosFalsos =>
  ({ tenantId: t, proveedor: 'samsara', leidos: 0, guardados: 0, huerfanos: 0, disparos: 0, sinTurno: true });

const sincronizarGpsTodas = vi.fn(async (..._a: unknown[]): Promise<FlotaFalsa[]> => []);
vi.mock('@/lib/likida/conectores/sincronizar_gps', () => ({
  sincronizarGpsTodas: (...a: unknown[]) => sincronizarGpsTodas(...a),
  httpReal: async () => ({ estado: 500, cuerpo: '' }),
}));
const sincronizarEventosTodas = vi.fn(async (..._a: unknown[]): Promise<EventosFalsos[]> => []);
vi.mock('@/lib/likida/conectores/sincronizar_eventos', () => ({
  sincronizarEventosTodas: (...a: unknown[]) => sincronizarEventosTodas(...a),
}));

const alertarOperador = vi.fn(async () => {});
vi.mock('@/lib/observability/alerta', () => ({
  alertarOperador: (...a: unknown[]) => alertarOperador(...(a as [])),
}));
vi.mock('@/lib/observability/sentry', () => ({ codigoDeError: () => 'codigo-prueba' }));

import { GET, maxDuration } from './route';

const peticion = () =>
  new Request('https://app.likida.ai/api/cron/gps', {
    headers: { authorization: 'Bearer secreto-de-prueba' },
  });

beforeEach(() => {
  vi.clearAllMocks();
  interruptor = 'encendido';
  sincronizarGpsTodas.mockResolvedValue([]);
  sincronizarEventosTodas.mockResolvedValue([]);
});

describe('el reloj que la ruta les presta a las dos fases', () => {
  it('les pasa un `venceEn` = ahora + maxDuration − margen, no un reloj infinito', async () => {
    const antes = Date.now();
    await GET(peticion());

    const optsGps = sincronizarGpsTodas.mock.calls[0][1] as { venceEn: number };
    // 300 s de techo menos los 20 s que la ruta se guarda para latir y responder.
    expect(optsGps.venceEn).toBeGreaterThanOrEqual(antes + maxDuration * 1000 - 20_000);
    expect(optsGps.venceEn).toBeLessThanOrEqual(Date.now() + maxDuration * 1000 - 20_000);
  });

  it('es EL MISMO instante para posiciones y eventos: un solo presupuesto, dos fases en serie', async () => {
    await GET(peticion());
    const optsGps = sincronizarGpsTodas.mock.calls[0][1] as { venceEn: number };
    const optsEventos = sincronizarEventosTodas.mock.calls[0][1] as { venceEn: number };
    expect(optsGps.venceEn).toEqual(expect.any(Number));
    expect(optsEventos.venceEn).toBe(optsGps.venceEn);
  });

  it('prioriza seguridad: eventos corre antes que la telemetría de posiciones', async () => {
    await GET(peticion());
    expect(sincronizarEventosTodas.mock.invocationCallOrder[0])
      .toBeLessThan(sincronizarGpsTodas.mock.invocationCallOrder[0]);
  });
});

describe('el corte por reloj se late y se dice, no se calla', () => {
  it('flotas sin turno en cualquiera de las dos fases → latido `parcial` y el número en el cuerpo', async () => {
    sincronizarGpsTodas.mockResolvedValue([flotaOk('t-1'), flotaSinTurno('t-2')]);
    sincronizarEventosTodas.mockResolvedValue([eventosSinTurno('t-1'), eventosSinTurno('t-2')]);

    const res = await GET(peticion());
    const cuerpo = await res.json() as {
      corrio: boolean; sinTurnoPorReloj: number; conError: number;
      eventos: { sinTurnoPorReloj: number };
    };

    // Termina LIMPIA (200): el punto entero es responder y latir ANTES de que
    // Vercel mate la función — pero sin mentir `ok`.
    expect(res.status).toBe(200);
    expect(cuerpo.corrio).toBe(true);
    expect(cuerpo.sinTurnoPorReloj).toBe(1);
    expect(cuerpo.eventos.sinTurnoPorReloj).toBe(2);
    // `sinTurno` NO es un error de flota: es trabajo declarado pendiente.
    expect(cuerpo.conError).toBe(0);

    expect(registrarLatido).toHaveBeenCalledTimes(1);
    const [cron, estado, detalle] = registrarLatido.mock.calls[0] as unknown as
      [string, string, Record<string, unknown>];
    expect(cron).toBe('gps');
    expect(estado).toBe('parcial');
    expect(detalle.sinTurnoPorReloj).toBe(3);
  });

  it('una corrida completa y sin errores sigue latiendo `ok`: el reloj no ensucia lo limpio', async () => {
    sincronizarGpsTodas.mockResolvedValue([flotaOk('t-1'), flotaOk('t-2')]);
    sincronizarEventosTodas.mockResolvedValue([eventosOk('t-1'), eventosOk('t-2')]);

    const res = await GET(peticion());
    const cuerpo = await res.json() as { sinTurnoPorReloj: number; eventos: { sinTurnoPorReloj: number } };

    expect(cuerpo.sinTurnoPorReloj).toBe(0);
    expect(cuerpo.eventos.sinTurnoPorReloj).toBe(0);
    const [, estado] = registrarLatido.mock.calls[0] as unknown as [string, string];
    expect(estado).toBe('ok');
  });

  it('DLQ, cuarentena u aviso muerto impiden verde falso y alertan al operador', async () => {
    sincronizarEventosTodas.mockResolvedValue([{
      ...eventosOk('t-1'), eventosEnCuarentena: 3, eventosCuarentenaMuertos: 1,
      eventosOutboxPendientes: 2, eventosOutboxMuertos: 1,
      avisosPendientes: 1, avisosMuertos: 1,
    }]);

    const res = await GET(peticion());
    const cuerpo = await res.json() as { eventos: Record<string, number> };

    expect(cuerpo.eventos).toMatchObject({
      enCuarentena: 3, cuarentenaMuertos: 1, outboxPendientes: 2,
      outboxMuertos: 1, avisosPendientes: 1, avisosMuertos: 1,
    });
    expect(registrarLatido).toHaveBeenCalledWith('gps', 'parcial', expect.objectContaining({
      eventosMuertos: 3,
    }));
    expect(alertarOperador).toHaveBeenCalledWith('cron.gps.dlq', expect.objectContaining({
      afectados: expect.stringContaining('t-1'), eventosMuertos: 3,
    }));
  });
});
