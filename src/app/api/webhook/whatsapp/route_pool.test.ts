// ═══════════════════════════════════════════════════════════════════════════
// CRÍTICO — NADA ACOTABA CUÁNTOS MENSAJES PROCESA UNA INVOCACIÓN.
//
// `Promise.all(permitidos.map(processInbound))`. Meta puede entregar la ráfaga
// entera en UN POST: un chofer fotografía sus ~22 tickets en la gasolinera y los
// manda de golpe. Las 22 arrancaban a la vez y se repartían los 120 s de UNA
// invocación, cada una pidiendo su tope de 25 s de OCR como si fuera suyo.
//
// Y cuando Vercel mata la invocación por tope, el final es el peor que tiene
// este producto: no sale nada, el `finally` del intake no corre (el `+1` de la
// barrera queda escrito), el claim de `wa_mensaje_procesado` queda tomado, y
// Meta —que ya recibió su 200— NO reintenta. Veintidós comprobantes perdidos sin
// una línea de log.
//
// Esta prueba mide la CONCURRENCIA REAL de la ruta: cuántos `processInbound` hay
// en vuelo a la vez. Se rompe quitando el pool (volviendo a `Promise.all`) y se
// pone roja al instante — verificado antes de dejarla.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

const SECRETO = 'app-secret-de-prueba-pool';
process.env.WHATSAPP_APP_SECRET = SECRETO;

/** Cuántos `processInbound` corren a la vez, y el pico. */
let enVuelo = 0;
let pico = 0;
const atendidos: string[] = [];

const processInbound = vi.fn(async (m: { waMessageId?: string }) => {
  enVuelo += 1;
  pico = Math.max(pico, enVuelo);
  // Un tick real: sin esperar, cada llamada terminaría antes de que arranque la
  // siguiente y el pico sería 1 con o sin pool — la prueba no mediría nada.
  await new Promise((r) => setTimeout(r, 5));
  atendidos.push(m.waMessageId ?? '?');
  enVuelo -= 1;
});

vi.mock('@/lib/likida/processor', () => ({ processInbound: (m: unknown) => processInbound(m as { waMessageId?: string }) }));

/** Lo que la ruta le manda al operador. `verifySignature` se deja REAL. */
const enviados: Array<{ to: string; texto: string }> = [];
vi.mock('@/lib/meta/client', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendText: vi.fn(async (to: string, texto: string) => { enviados.push({ to, texto }); return 'wamid.x'; }),
}));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger }));
vi.mock('@/lib/observability/sentry', () => ({ flushObservabilidad: vi.fn(async () => {}) }));

// El webhook consulta el interruptor global antes de despachar (mig. 0110,
// cableado el 15-ago-2026). Sin este mock corre el real, que falla CERRADO
// —una base ilegible cuenta como apagado— y estas pruebas verían cero
// mensajes procesados por una razón que no es la que están midiendo.
// AUDITORÍA 24 · AGEN-7: la ruta lee `leerInterruptor` (distingue «apagado»
// de «no pude leer la palanca»); `estaApagado` se conserva para el resto.
vi.mock('@/lib/likida/interruptores', () => ({
  estaApagado: vi.fn(async () => false),
  leerInterruptor: vi.fn(async () => 'encendido' as const),
}));

const pendientes: Array<() => unknown> = [];
vi.mock('next/server', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, after: (fn: () => unknown) => { pendientes.push(fn); } };
});


// El inbox durable GENERAL (16-ago-2026): todo permitido se persiste antes
// del 200 y se procesa reclamando su fila — el doble minimo que deja pasar
// el flujo feliz sin base real.
const { bandejaInbox, fallosClaim } = vi.hoisted(() => ({
  bandejaInbox: new Map<string, unknown>(),
  fallosClaim: new Set<string>(),
}));
vi.mock('@/lib/likida/wa_pendientes', () => ({
  // DAT-34: la deduplicación previa al rate limit. Vacío = ninguno de estos
  // wamids estaba ya en la bandeja, que es el caso de una entrega normal.
  pendientesYaConocidos: async () => new Set<string>(),
  guardarEventosPendientes: async (ms: Array<{ waMessageId?: string }>) => {
    const filas = ms.map((m, i) => {
      const id = m.waMessageId ?? `f-${i}`;
      bandejaInbox.set(id, m);
      return { id, evento: m, guardado: true };
    });
    return { guardados: filas.length, fallidos: 0, filas };
  },
  reclamarPendiente: async (id: string) => {
    if (fallosClaim.has(id)) throw new Error('lectura del claim agotó el tiempo');
    return bandejaInbox.has(id) ? { id, evento: bandejaInbox.get(id), intentos: 1 } : null;
  },
  marcarPendienteProcesado: async () => undefined,
  anotarFalloPendiente: async () => undefined,
}));

const { POST } = await import('./route');

const firmar = (body: string) =>
  'sha256=' + crypto.createHmac('sha256', SECRETO).update(body).digest('hex');

/** Una ráfaga de `n` fotos del MISMO teléfono, como las entrega Meta. */
function rafaga(n: number, telefono: string) {
  return JSON.stringify({
    entry: [{
      changes: [{
        value: {
          messages: Array.from({ length: n }, (_, i) => ({
            id: `wamid.${telefono}.${i}`, from: telefono, type: 'image', image: { id: `media${i}` },
          })),
        },
      }],
    }],
  });
}

/** Una ráfaga repartida entre `choferes` teléfonos distintos. */
function rafagaVarios(porChofer: number, choferes: number, base: string) {
  const mensajes: Array<Record<string, unknown>> = [];
  for (let c = 0; c < choferes; c++) {
    const telefono = `${base}${c}`;
    for (let i = 0; i < porChofer; i++) {
      mensajes.push({ id: `wamid.${telefono}.${i}`, from: telefono, type: 'image', image: { id: `media${c}_${i}` } });
    }
  }
  return JSON.stringify({ entry: [{ changes: [{ value: { messages: mensajes } }] }] });
}

async function postear(body: string) {
  const res = await POST(new Request('https://likida.ai/api/webhook/whatsapp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': firmar(body) },
    body,
  }) as never);
  while (pendientes.length) await pendientes.shift()!();
  return res;
}

beforeEach(() => {
  enVuelo = 0; pico = 0; atendidos.length = 0; enviados.length = 0;
  processInbound.mockClear();
  fallosClaim.clear();
  logger.info.mockClear(); logger.warn.mockClear(); logger.error.mockClear();
});

describe('la ráfaga de un POST se procesa con techo de concurrencia', () => {
  it('22 fotos en un POST NO arrancan 22 OCR a la vez', async () => {
    // El teléfono cambia por prueba: el rate limit vive en memoria del módulo.
    await postear(rafaga(22, '5219990001001'));
    expect(processInbound).toHaveBeenCalledTimes(22);
    expect(pico, `arrancaron ${pico} a la vez: el pool no está puesto`).toBeLessThanOrEqual(5);
  });

  it('y aun así se procesan TODAS: acotar no puede ser descartar', async () => {
    await postear(rafaga(22, '5219990001002'));
    expect(atendidos).toHaveLength(22);
    expect(new Set(atendidos).size).toBe(22);   // ninguna repetida, ninguna perdida
  });

  it('el pool se llena de verdad ENTRE CHOFERES (no degrada a serie)', async () => {
    // 23-ago-2026: el paralelismo pasó a ser POR CHOFER. Con un solo teléfono
    // el pico es 1 A PROPÓSITO —sus mensajes van en orden—, así que medir el
    // pool exige varios choferes. Con `await` por mensaje en vez de pool, el
    // pico sería 1 incluso aquí, y la ráfaga tardaría 22 turnos en vez de 5.
    await postear(rafagaVarios(3, 8, '5218880001'));
    expect(pico, 'se procesó en serie: ocho choferes distintos no se estorban').toBeGreaterThan(1);
    expect(pico, 'el techo del pool sigue puesto').toBeLessThanOrEqual(5);
  });

  it('un mensaje que revienta no cancela a los demás choferes', async () => {
    processInbound.mockImplementationOnce(async () => { throw new Error('boom'); });
    await postear(rafagaVarios(1, 8, '5219990001004'));
    expect(processInbound).toHaveBeenCalledTimes(8);
    expect(atendidos).toHaveLength(7);   // el que reventó no llegó al final
  });

  it('tres choferes distintos no esperan turnos de más', async () => {
    await postear(rafagaVarios(1, 3, '5218880002'));
    expect(pico).toBe(3);
  });
});
// ═══════════════════════════════════════════════════════════════════════════
// LO QUE PASA DEL TECHO SE APLAZA — NO SE DESCARTA (4-ago-2026).
//
// Estos mensajes YA pasaron el HMAC: son de Meta y de un chofer dado de alta.
// La ruta contestaba 200 y los tiraba, y un 200 le dice a Meta que quedaron
// entregados: cada exceso era un comprobante perdido para siempre. La cola que
// hacía falta no había que construirla — es la reentrega de Meta, y usarla solo
// pide no mentirle con un 200. Reentregar es seguro porque `claimMessage` ya
// deduplica por `waMessageId`.
// ═══════════════════════════════════════════════════════════════════════════
describe('el rate limit aplaza con 429 en vez de descartar con 200', () => {
  it('EL FALLO: un 200 le dice a Meta que no lo reintente — ahora contesta 429', async () => {
    // 41 en un POST contra un tope de 40/min: el último no cabe en esta
    // invocación, así que la respuesta entera pide reentrega.
    const res = await postear(rafaga(41, '5219990002001'));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ received: 40, diferidos: 1 });
  });

  it('deja el waMessageId en el log: si Meta acaba rindiéndose, es el único rastro', async () => {
    await postear(rafaga(41, '5219990002002'));
    const aplazados = logger.warn.mock.calls.filter((c) => c[0] === 'wa.ratelimit_diferido');
    expect(aplazados).toHaveLength(1);
    expect(aplazados[0][1]).toMatchObject({ id: 'wamid.5219990002002.40', tipo: 'image' });
  });

  it('lo que SÍ cabía se procesa igual: el 429 no puede volverse un lote que nunca avanza', async () => {
    // Si se devolviera el lote entero sin tocar, un POST con más mensajes que
    // el techo volvería a excederlo en CADA reentrega, para siempre. Avanzando
    // lo que cabe, cada entrega deja menos por hacer.
    await postear(rafaga(45, '5219990002003'));
    expect(atendidos).toHaveLength(40);
  });

  it('y al operador ya no se le pide que reenvíe: sus fotos vuelven solas', async () => {
    // El aviso viejo describía una pérdida que ya no ocurre, y reenviar el fajo
    // es justo lo que vuelve a llenar la ventana del limitador.
    await postear(rafaga(45, '5219990002004'));
    expect(enviados).toHaveLength(0);
  });

  it('CONTROL — una ráfaga que cabe contesta 200 y no aplaza nada', async () => {
    const res = await postear(rafaga(22, '5219990002005'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: 22 });
    expect(enviados).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalledWith('wa.ratelimit_diferido', expect.anything());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EL ORDEN DENTRO DE UNA CONVERSACIÓN (23-ago-2026, P0/P1 auditoría externa)
//
// El camino vivo paralelizaba POR MENSAJE. Un operador que manda foto, foto y
// «listo» podía ver su liquidación CERRADA antes de que terminaran las fotos:
// cierre parcial, gastos que faltan, y una diferencia que se le cobra a él.
//
// El drenado del cron ya serializaba por chofer (ESC-1); esta ruta no. Ahora sí:
// en paralelo ENTRE choferes, en serie DENTRO de cada uno.
// ═══════════════════════════════════════════════════════════════════════════
describe('los mensajes de UN chofer se procesan en orden', () => {
  it('foto, foto y «listo» llegan al motor en el orden en que se mandaron', async () => {
    const body = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [
        { id: 'wamid.orden.1', from: '5217770001', type: 'image', image: { id: 'm1' } },
        { id: 'wamid.orden.2', from: '5217770001', type: 'image', image: { id: 'm2' } },
        { id: 'wamid.orden.3', from: '5217770001', type: 'text', text: { body: 'listo' } },
      ] } }] }],
    });
    await postear(body);
    expect(atendidos).toEqual(['wamid.orden.1', 'wamid.orden.2', 'wamid.orden.3']);
  });

  it('un solo chofer NO arranca dos a la vez: su «listo» no adelanta a sus fotos', async () => {
    await postear(rafaga(6, '5217770002'));
    expect(pico, 'sus mensajes corrieron en paralelo: el orden no está garantizado').toBe(1);
  });

  it('pero DOS choferes sí se atienden a la vez — serializar no puede ser hacer cola', async () => {
    await postear(rafagaVarios(3, 2, '521777001'));
    expect(pico).toBe(2);
  });

  it('y cada uno conserva SU orden aunque se mezclen en la entrega', async () => {
    // Meta puede entregarlos intercalados; lo que no puede es alterar el orden
    // dentro de cada conversación.
    const body = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [
        { id: 'wamid.A.1', from: '5217770005', type: 'image', image: { id: 'a1' } },
        { id: 'wamid.B.1', from: '5217770006', type: 'image', image: { id: 'b1' } },
        { id: 'wamid.A.2', from: '5217770005', type: 'image', image: { id: 'a2' } },
        { id: 'wamid.B.2', from: '5217770006', type: 'image', image: { id: 'b2' } },
      ] } }] }],
    });
    await postear(body);
    const soloA = atendidos.filter((x) => x.startsWith('wamid.A.'));
    const soloB = atendidos.filter((x) => x.startsWith('wamid.B.'));
    expect(soloA).toEqual(['wamid.A.1', 'wamid.A.2']);
    expect(soloB).toEqual(['wamid.B.1', 'wamid.B.2']);
  });
});


describe('fallo de lectura del claim conserva el orden durable', () => {
  it('no adelanta listo al audio pendiente y permite avanzar a otro chofer', async () => {
    const audio = 'wamid.claim-audio';
    const cierre = 'wamid.claim-listo';
    const otro = 'wamid.claim-otro';
    fallosClaim.add(audio);
    const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [
      { id: audio, from: '5219990009901', type: 'audio', audio: { id: 'audio-claim' } },
      { id: cierre, from: '5219990009901', type: 'text', text: { body: 'listo' } },
      { id: otro, from: '5219990009902', type: 'text', text: { body: 'hola' } },
    ] } }] }] });

    const respuesta = await postear(body);

    expect(respuesta.status).toBe(200);
    expect(atendidos).toEqual([otro]);
    expect(processInbound).toHaveBeenCalledTimes(1);
    expect(bandejaInbox.has(audio)).toBe(true);
    expect(bandejaInbox.has(cierre)).toBe(true);
    expect(logger.error).toHaveBeenCalledWith('wa.claim_fallo', expect.objectContaining({ id: audio }));
  });
});
