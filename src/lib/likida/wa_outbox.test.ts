import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// AUDITORÍA 19 (OP-19c2-3): `finalizar_wa_outbox` (mig. 0189) pasó de devolver
// `boolean` a `table(ok boolean, muerta boolean)` para que la app sepa cuándo
// una salida agotó sus reintentos y ya no se va a volver a intentar. Esto fija
// el contrato de lectura: PostgREST devuelve una tabla como ARREGLO de filas.

const rpc = vi.hoisted(() => vi.fn());
const insert = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ rpc, from: () => ({ insert }) }) }));
vi.mock('@/lib/likida/presupuesto', () => ({ acotada: (q: unknown) => q }));
const loggerError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({ logger: { error: loggerError } }));

const {
  finalizarSalidaWhatsApp, encolarSalidaWhatsApp, encolarSalidaWhatsAppDedupe,
  reclamarSalidasWhatsApp,
  WA_OUTBOX_LEASE_SECONDS, RETRASO_AMBIGUO_SEGUNDOS,
} = await import('./wa_outbox');

const salida = { id: 'x', payload: {}, intentos: 8, leaseToken: 't' };

describe('encolarSalidaWhatsAppDedupe persiste la intención crítica antes de Meta', () => {
  beforeEach(() => { rpc.mockReset(); loggerError.mockReset(); });

  it('mapea el receipt durable y conserva una llave de idempotencia estable', async () => {
    rpc.mockResolvedValue({
      data: [{ id: 'outbox-1', estado: 'pending', provider_message_id: null }],
      error: null,
    });

    await expect(encolarSalidaWhatsAppDedupe(
      'gps:samsara:tenant-1:evento-1',
      { messaging_product: 'whatsapp', to: '5219990000000' },
      'alerta crítica GPS',
    )).resolves.toEqual({ id: 'outbox-1', estado: 'pending', providerMessageId: null });

    expect(rpc).toHaveBeenCalledWith('encolar_wa_outbox_dedupe', {
      p_dedupe_key: 'gps:samsara:tenant-1:evento-1',
      p_payload: { messaging_product: 'whatsapp', to: '5219990000000' },
      p_error: 'alerta crítica GPS',
    });
  });

  it('falla cerrado ante error o estado fuera del contrato', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    await expect(encolarSalidaWhatsAppDedupe('k', {}, 'm')).resolves.toBeNull();

    rpc.mockResolvedValue({
      data: [{ id: 'outbox-2', estado: 'desconocido', provider_message_id: null }],
      error: null,
    });
    await expect(encolarSalidaWhatsAppDedupe('k', {}, 'm')).resolves.toBeNull();
    expect(loggerError).toHaveBeenCalledTimes(2);
  });
});

// PRUEBAS (barrido MEDIO/BAJO): `encolarSalidaWhatsApp` y `reclamarSalidasWhatsApp`
// no tenían ni una prueba — solo `finalizarSalidaWhatsApp` estaba cubierta, y es
// justo la tercera de tres funciones que este archivo exporta. `reclamarSalidasWhatsApp`
// es la que usa el cron recién recuperado (PR #80, kill switch de wa-outbox).
describe('encolarSalidaWhatsApp nunca lanza (BEST-EFFORT a propósito)', () => {
  beforeEach(() => { insert.mockReset(); loggerError.mockReset(); });

  it('inserta el payload y el motivo recortado a 500 caracteres, sin loggear si sale bien', async () => {
    insert.mockResolvedValue({ error: null });
    await encolarSalidaWhatsApp({ a: 1 }, 'x'.repeat(600));
    expect(insert).toHaveBeenCalledWith({ payload: { a: 1 }, ultimo_error: 'x'.repeat(500) });
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('si el insert devuelve error, lo loggea y no lanza', async () => {
    insert.mockResolvedValue({ error: { message: 'boom' } });
    await expect(encolarSalidaWhatsApp({}, 'motivo')).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalledWith('wa.outbox_no_encolado', { err: 'boom' });
  });

  it('si el insert LANZA (no solo devuelve error), tampoco propaga — es el respaldo del respaldo', async () => {
    insert.mockRejectedValue(new Error('red caída'));
    await expect(encolarSalidaWhatsApp({}, 'motivo')).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalledWith('wa.outbox_no_encolado', { err: 'red caída' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA E.28 (H1, MEDIO) — un timeout donde Meta SÍ entregó podía
// triplicar un aviso: el catch de la red en `client.ts` encolaba el reintento
// con `proximo_intento_en = now()` (el default de la columna), y el cron de
// outbox corre cada minuto — el reintento del mensaje que Meta SÍ había
// aceptado podía salir casi de inmediato. Sin retraso explícito, un timeout
// y un rechazo EXPLÍCITO de Meta (`!res.ok`, donde no hay ambigüedad) se
// encolaban EXACTAMENTE IGUAL, y son riesgos distintos.
// ═══════════════════════════════════════════════════════════════════════════
describe('encolarSalidaWhatsApp — el retraso ambiguo (H1)', () => {
  beforeEach(() => { insert.mockReset(); loggerError.mockReset(); insert.mockResolvedValue({ error: null }); });

  it('sin retraso (el default, para un rechazo EXPLÍCITO de Meta) no manda `proximo_intento_en`: el default de la columna basta', async () => {
    await encolarSalidaWhatsApp({ a: 1 }, 'HTTP 429: rate limit');
    expect(insert).toHaveBeenCalledWith({ payload: { a: 1 }, ultimo_error: 'HTTP 429: rate limit' });
  });

  it('con `RETRASO_AMBIGUO_SEGUNDOS` (un timeout — no se sabe si Meta entregó), `proximo_intento_en` viaja en el futuro', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T12:00:00.000Z'));
    try {
      await encolarSalidaWhatsApp({ a: 1 }, 'timeout de red', RETRASO_AMBIGUO_SEGUNDOS);
    } finally {
      vi.useRealTimers();
    }
    expect(insert).toHaveBeenCalledWith({
      payload: { a: 1 }, ultimo_error: 'timeout de red',
      proximo_intento_en: new Date('2026-08-25T12:05:00.000Z').toISOString(),
    });
  });

  it('el retraso ambiguo es de VARIOS MINUTOS, no segundos — el cron de outbox corre cada minuto (vercel.json)', () => {
    // Con un retraso menor al intervalo del cron, el primer reintento podría
    // seguir cayendo en el mismo minuto que el timeout original: exactamente
    // la ventana que este arreglo busca alejar.
    expect(RETRASO_AMBIGUO_SEGUNDOS).toBeGreaterThanOrEqual(5 * 60);
  });

  it('un retraso negativo o no-numérico nunca manda la salida al pasado', async () => {
    await encolarSalidaWhatsApp({}, 'x', -30);
    expect(insert).toHaveBeenCalledWith({ payload: {}, ultimo_error: 'x' });

    insert.mockReset();
    insert.mockResolvedValue({ error: null });
    await encolarSalidaWhatsApp({}, 'x', NaN);
    expect(insert).toHaveBeenCalledWith({ payload: {}, ultimo_error: 'x' });
  });
});

describe('reclamarSalidasWhatsApp mapea el contrato snake_case → camelCase de la RPC', () => {
  beforeEach(() => rpc.mockReset());

  it('convierte lease_token → leaseToken y castea intentos a número', async () => {
    rpc.mockResolvedValue({
      data: [{ id: 'a1', payload: { x: 1 }, intentos: '3', lease_token: 'tok-1' }],
      error: null,
    });
    const salidas = await reclamarSalidasWhatsApp();
    expect(salidas).toEqual([{ id: 'a1', payload: { x: 1 }, intentos: 3, leaseToken: 'tok-1' }]);
    expect(rpc).toHaveBeenCalledWith('reclamar_wa_outbox', { p_limite: 25, p_lease_seconds: WA_OUTBOX_LEASE_SECONDS });
  });

  it('respeta el límite pasado y no el default cuando se especifica', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await reclamarSalidasWhatsApp(5);
    expect(rpc).toHaveBeenCalledWith('reclamar_wa_outbox', { p_limite: 5, p_lease_seconds: WA_OUTBOX_LEASE_SECONDS });
  });

  it('sin filas reclamadas, devuelve arreglo vacío (no null/undefined)', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await reclamarSalidasWhatsApp()).toEqual([]);
  });

  it('si la RPC falla, lanza — a diferencia de encolar, aquí SÍ debe fallar ruidoso: el kill switch decide si reclama, no este archivo', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    await expect(reclamarSalidasWhatsApp()).rejects.toThrow('reclamarSalidasWhatsApp: timeout');
  });
});

// AUDITORÍA 20 (R-1, CRÍTICO): el lease reclamaba con 120s mientras la
// corrida real (route.ts) mide 155.5s y puede correr hasta 300s de
// `maxDuration` — el lease vencía a media corrida y el cron de al lado
// (corre cada minuto) reenviaba el mismo PDF hasta 8 veces a un teléfono
// real. Esta prueba lee el `maxDuration` REAL del archivo — no una copia —
// así que si alguien lo vuelve a subir sin tocar el lease, o baja el lease
// sin querer, esta prueba se pone roja.
describe('WA_OUTBOX_LEASE_SECONDS sobrevive al maxDuration real del cron (invariante R-1)', () => {
  const RUTA_ROUTE = join(__dirname, '..', '..', 'app', 'api', 'cron', 'wa-outbox', 'route.ts');

  function leerMaxDurationDeclarado(): number {
    const fuente = readFileSync(RUTA_ROUTE, 'utf8');
    const m = fuente.match(/export const maxDuration = (\d+);/);
    if (!m) throw new Error('no se pudo leer maxDuration de wa-outbox/route.ts — el regex de esta prueba quedó desalineado con el archivo');
    return Number(m[1]);
  }

  it('el maxDuration declarado en route.ts sigue siendo 300 (si cambió, hay que revisar el margen de abajo)', () => {
    expect(leerMaxDurationDeclarado()).toBe(300);
  });

  it('el lease es mayor al TECHO real de la corrida (maxDuration), no solo al promedio de 155.5s medido', () => {
    const maxDuration = leerMaxDurationDeclarado();
    expect(WA_OUTBOX_LEASE_SECONDS).toBeGreaterThan(maxDuration);
  });

  it('el lease guarda al menos 1.5× de margen sobre el techo — mismo margen que WA_LEASE_SECONDS en wa_pendientes.ts', () => {
    const maxDuration = leerMaxDurationDeclarado();
    expect(WA_OUTBOX_LEASE_SECONDS).toBeGreaterThanOrEqual(Math.ceil(maxDuration * 1.5));
  });

  it('regresión directa: 120s (el valor viejo, ya roto contra 155.5s medidos) ya no basta', () => {
    expect(WA_OUTBOX_LEASE_SECONDS).toBeGreaterThan(120);
    expect(WA_OUTBOX_LEASE_SECONDS).toBeGreaterThan(155.5);
  });
});

describe('finalizarSalidaWhatsApp lee el contrato de tabla de la 0189', () => {
  beforeEach(() => rpc.mockReset());

  it('muerta: true cuando la fila agotó reintentos', async () => {
    rpc.mockResolvedValue({ data: [{ ok: true, muerta: true }], error: null });
    expect(await finalizarSalidaWhatsApp(salida, undefined, 'fallo')).toEqual({ muerta: true });
  });

  it('muerta: false en un envío exitoso', async () => {
    rpc.mockResolvedValue({ data: [{ ok: true, muerta: false }], error: null });
    expect(await finalizarSalidaWhatsApp(salida, 'wamid.1')).toEqual({ muerta: false });
  });

  it('muerta: false (no true por accidente) si la RPC falla o el claim se perdió', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect(await finalizarSalidaWhatsApp(salida, undefined, 'fallo')).toEqual({ muerta: false });

    rpc.mockResolvedValue({ data: [], error: null });
    expect(await finalizarSalidaWhatsApp(salida, undefined, 'fallo')).toEqual({ muerta: false });
  });
});
