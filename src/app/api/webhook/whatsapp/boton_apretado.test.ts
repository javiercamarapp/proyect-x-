// ═══════════════════════════════════════════════════════════════════════════
// EL CHOFER APRETÓ UN BOTÓN — que la respuesta llegue al procesador.
//
// Antes de esto, `extractMessages` solo miraba `text`, `image` y `document`: un
// `type: 'interactive'` caía en `other`, el webhook devolvía 200 y nadie
// contestaba nunca. El chofer aprieta, la pantalla no dice nada y él supone que
// el sistema está pensando.
//
// La respuesta entra como TEXTO con el `id` del botón por cuerpo: el id es el
// dato que elegimos nosotros, y el procesador ya recorre ese camino cuando el
// operador teclea a mano. Aquí se afirma exactamente eso, con el payload REAL
// de Meta (documentación de Cloud API, "Interactive reply buttons messages"),
// y también el límite: un `list_reply` NO se traga como si fuera un botón.
//
// Se ejercita el POST REAL con `verifySignature` REAL, como en
// `route_cableado.test.ts`; solo se sustituyen el procesador y `after()`.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

const SECRETO = 'app-secret-de-prueba';
process.env.WHATSAPP_APP_SECRET = SECRETO;

const processInbound = vi.fn(async () => {});
// Solo el mensaje: el segundo argumento de `processInbound` es el reloj de la
// invocación (auditoría 18, C4) y lo prueba `route_pospuesto.test.ts`; aquí se
// afirma QUÉ mensaje llega, no cuándo arrancó la invocación.
vi.mock('@/lib/likida/processor', () => ({ processInbound: (m: unknown) => (processInbound as (m: unknown) => Promise<void>)(m) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
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

// `after()` fuera de una petición de Next lanza. Se recogen las tareas y se
// corren a mano para poder AFIRMAR qué llegó al procesador.
const pendientes: Array<() => unknown> = [];
vi.mock('next/server', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, after: (fn: () => unknown) => { pendientes.push(fn); } };
});


// El inbox durable GENERAL (16-ago-2026): todo permitido se persiste antes
// del 200 y se procesa reclamando su fila — el doble minimo que deja pasar
// el flujo feliz sin base real.
const { bandejaInbox } = vi.hoisted(() => ({ bandejaInbox: new Map<string, unknown>() }));
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
  reclamarPendiente: async (id: string) =>
    (bandejaInbox.has(id) ? { id, evento: bandejaInbox.get(id), intentos: 1 } : null),
  marcarPendienteProcesado: async () => undefined,
  anotarFalloPendiente: async () => undefined,
}));

const { POST } = await import('./route');

const firmar = (body: string) => 'sha256=' + crypto.createHmac('sha256', SECRETO).update(body).digest('hex');

async function postear(body: string) {
  const res = await POST(new Request('https://app.likida.ai/api/webhook/whatsapp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': firmar(body) },
    body,
  }) as never);
  while (pendientes.length) await pendientes.shift()!();
  return res;
}

/**
 * El payload tal como lo entrega Meta cuando alguien aprieta un botón — misma
 * forma que el ejemplo de la documentación, con `metadata`, `contacts` y
 * `timestamp` incluidos: un parseo que solo funcione con el sobre recortado de
 * una prueba no prueba nada del sobre real.
 *
 * El TELÉFONO va distinto en cada prueba: el rate limit vive en memoria del
 * módulo y es por teléfono, así que reusarlo acopla las pruebas entre sí.
 */
const payloadInteractivo = (from: string, waMessageId: string, interactive: Record<string, unknown>) =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: '1395114249160000',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '5215500000000', phone_number_id: '123456789' },
          contacts: [{ profile: { name: 'Pablo Morales' }, wa_id: from }],
          messages: [{
            from,
            id: waMessageId,
            timestamp: '1714510003',
            type: 'interactive',
            interactive,
          }],
        },
      }],
    }],
  });

beforeEach(() => {
  processInbound.mockReset(); processInbound.mockImplementation(async () => {});
  pendientes.length = 0;
});

describe('un button_reply llega al procesador como texto con el id del botón', () => {
  it('el id del botón es el text que recibe el procesador', async () => {
    const res = await postear(payloadInteractivo('5219990001001', 'wamid.BTN1', {
      type: 'button_reply',
      button_reply: { id: 'cerrar_si', title: 'Sí, ya terminé' },
    }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ received: 1 });
    expect(processInbound).toHaveBeenCalledWith({
      from: '5219990001001',
      waMessageId: 'wamid.BTN1',
      // DAT-38: la hora de META, no la del procesamiento. Va en TODO mensaje —
      // el `timestamp` del sobre real de arriba, en segundos, ×1000.
      timestampMs: 1714510003000,
      type: 'text',
      text: 'cerrar_si',
    });
  });

  // Lo que NO debe pasar: quedarse con el rótulo. `title` es lo que le
  // enseñamos al chofer y puede cambiar de redacción sin avisar; el `id` es el
  // contrato. Decidir por el título sería decidir por la copy.
  it('es el id, NO el title, lo que viaja como texto', async () => {
    await postear(payloadInteractivo('5219990001002', 'wamid.BTN2', {
      type: 'button_reply',
      button_reply: { id: 'cerrar_no', title: 'Falta un gasto' },
    }));
    const [msg] = processInbound.mock.calls[0] as unknown as [{ text: string }];
    expect(msg.text).toBe('cerrar_no');
    expect(msg.text).not.toBe('Falta un gasto');
  });

  // La idempotencia del procesador se apoya en `waMessageId`. Si el botón
  // entrara sin él, un reintento de Meta cerraría el viaje dos veces.
  it('conserva el waMessageId, que es de lo que cuelga la idempotencia', async () => {
    await postear(payloadInteractivo('5219990001003', 'wamid.BTN3', {
      type: 'button_reply',
      button_reply: { id: 'cerrar_si', title: 'Sí' },
    }));
    const [msg] = processInbound.mock.calls[0] as unknown as [{ waMessageId: string }];
    expect(msg.waMessageId).toBe('wamid.BTN3');
  });

  it('sin firma válida el botón tampoco entra (la puerta sigue cerrada)', async () => {
    const cuerpo = payloadInteractivo('5219990001004', 'wamid.BTN4', {
      type: 'button_reply', button_reply: { id: 'cerrar_si', title: 'Sí' },
    });
    const res = await POST(new Request('https://app.likida.ai/api/webhook/whatsapp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
      body: cuerpo,
    }) as never);
    expect(res.status).toBe(401);
    expect(processInbound).not.toHaveBeenCalled();
  });
});

describe('un interactivo que NO es button_reply no se traga como si lo fuera', () => {
  it('un list_reply entra como other, no como texto', async () => {
    await postear(payloadInteractivo('5219990001010', 'wamid.LST1', {
      type: 'list_reply',
      list_reply: { id: 'fila_3', title: 'Diésel', description: 'Carga de combustible' },
    }));
    expect(processInbound).toHaveBeenCalledWith({
      from: '5219990001010', waMessageId: 'wamid.LST1', timestampMs: 1714510003000, type: 'other', subtipo: 'interactive',
    });
  });

  // El caso venenoso: `list_reply` también trae `id` y `title`. Leer el id sin
  // mirar `interactive.type` haría pasar una fila de lista por un botón.
  it('el id de un list_reply NO se cuela como texto', async () => {
    await postear(payloadInteractivo('5219990001011', 'wamid.LST2', {
      type: 'list_reply',
      list_reply: { id: 'cerrar_si', title: 'Sí' },
    }));
    const [msg] = processInbound.mock.calls[0] as unknown as [{ type: string; text?: string }];
    expect(msg.type).toBe('other');
    expect(msg.text).toBeUndefined();
  });

  // Quién decide es `interactive.type`, NO la presencia del campo. Medido: con
  // los payloads reales de hoy, quitar la comprobación de `type` deja las otras
  // pruebas verdes —un `list_reply` real no trae `button_reply`—, así que esta
  // es la única que la sostiene. Es defensa a futuro y por eso el payload es
  // artificial: Meta agrega campos a los interactivos sin avisar, y el día que
  // uno nuevo cargue un `button_reply` de cortesía, leerlo sin mirar el `type`
  // convertiría ese mensaje en una respuesta que el chofer nunca dio.
  it('el tipo manda: un interactivo declarado list_reply no pasa por botón aunque traiga button_reply', async () => {
    await postear(payloadInteractivo('5219990001014', 'wamid.MIX', {
      type: 'list_reply',
      list_reply: { id: 'fila_3', title: 'Diésel' },
      button_reply: { id: 'cerrar_si', title: 'Sí' },
    }));
    expect(processInbound).toHaveBeenCalledWith({
      from: '5219990001014', waMessageId: 'wamid.MIX', timestampMs: 1714510003000, type: 'other', subtipo: 'interactive',
    });
  });

  it('un interactivo sin button_reply no revienta el parseo', async () => {
    await postear(payloadInteractivo('5219990001012', 'wamid.INT1', { type: 'button_reply' }));
    expect(processInbound).toHaveBeenCalledWith({
      from: '5219990001012', waMessageId: 'wamid.INT1', timestampMs: 1714510003000, type: 'other', subtipo: 'interactive',
    });
  });

  // Un id vacío no es una respuesta: mandarlo como texto le llegaría al
  // procesador como un mensaje en blanco del operador.
  it('un button_reply con id vacío entra como other', async () => {
    await postear(payloadInteractivo('5219990001013', 'wamid.INT2', {
      type: 'button_reply', button_reply: { id: '', title: 'Sí' },
    }));
    const [msg] = processInbound.mock.calls[0] as unknown as [{ type: string }];
    expect(msg.type).toBe('other');
  });
});

describe('el botón convive con lo que ya entraba', () => {
  // Meta puede entregar varios mensajes en UN POST. El botón no puede desplazar
  // ni tapar a la foto que viene con él.
  it('un POST con foto y botón entrega los dos, en orden', async () => {
    const cuerpo = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: '1395114249160000', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp',
        messages: [
          { from: '5219990001020', id: 'w1', timestamp: '1714510003', type: 'image', image: { id: 'MEDIA-1' } },
          { from: '5219990001020', id: 'w2', timestamp: '1714510004', type: 'interactive',
            interactive: { type: 'button_reply', button_reply: { id: 'cerrar_si', title: 'Sí, ya terminé' } } },
        ],
      } }] }],
    });
    const res = await postear(cuerpo);
    await expect(res.json()).resolves.toMatchObject({ received: 2 });
    expect(processInbound).toHaveBeenNthCalledWith(1, {
      from: '5219990001020', waMessageId: 'w1', timestampMs: 1714510003000, type: 'image', mediaId: 'MEDIA-1',
    });
    expect(processInbound).toHaveBeenNthCalledWith(2, {
      from: '5219990001020', waMessageId: 'w2', timestampMs: 1714510004000, type: 'text', text: 'cerrar_si',
    });
  });

  // CONTROL de que el cambio no rompió el camino de siempre.
  it('un texto tecleado sigue llegando igual que antes', async () => {
    const cuerpo = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [
        { from: '5219990001021', id: 'w9', type: 'text', text: { body: 'ya no tengo más tickets' } },
      ] } }] }],
    });
    await postear(cuerpo);
    expect(processInbound).toHaveBeenCalledWith({
      from: '5219990001021', waMessageId: 'w9', type: 'text', text: 'ya no tengo más tickets',
      // BE-A4: sin `timestamp` en el payload, `timestampMs` sale undefined y
      // `recibidoMs` (la hora de recepción) lo suple — ver route_timestamp_ilegible.test.ts.
      recibidoMs: expect.any(Number),
    });
  });
});
