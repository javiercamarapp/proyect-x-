import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger, huellaId } from './logger';

// ═══════════════════════════════════════════════════════════════════════════
// Auditoría 5 · CRÍTICO «El redactor de PII borra todos los identificadores del
// camino del dinero».
//
// El escenario que estas pruebas fijan es el de las 3 a.m.: un fallo de PDF de
// la flota A y uno de la flota B producían la MISMA línea, carácter por
// carácter, porque `tenant`, `viaje`, `operador` y `gasto` son UUID v4 de
// Postgres y caían en el mismo regex que el folio fiscal del CFDI.
// ═══════════════════════════════════════════════════════════════════════════

function ultimaLinea(spy: ReturnType<typeof vi.spyOn>): string {
  const calls = spy.mock.calls;
  return calls[calls.length - 1][0] as string;
}

describe('logger — trazabilidad del camino del dinero', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('dos fallos de tenants distintos NO producen la misma línea', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.error('pdf.no_entregado', {
      tenant: '11111111-1111-1111-1111-111111111111',
      viaje: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      pdfGenerado: false,
      err: 'storage no devolvió URL firmada',
    });
    const flotaA = ultimaLinea(spy);

    logger.error('pdf.no_entregado', {
      tenant: '22222222-2222-2222-2222-222222222222',
      viaje: 'ffffffff-1111-2222-3333-444444444444',
      pdfGenerado: false,
      err: 'storage no devolvió URL firmada',
    });
    const flotaB = ultimaLinea(spy);

    expect(flotaA).not.toEqual(flotaB);
  });

  it('el mismo tenant produce la MISMA huella en dos líneas distintas', () => {
    // Sin estabilidad no hay agrupación: es lo que permite juntar todos los
    // fallos de una flota sin tener el UUID delante.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tenant = '11111111-1111-1111-1111-111111111111';

    logger.error('agent.fail', { tenant, err: 'timeout' });
    const primera = ultimaLinea(spy);
    logger.error('pdf.gen', { tenant, err: 'x' });
    const segunda = ultimaLinea(spy);

    const huella = huellaId(tenant);
    expect(primera).toContain(huella);
    expect(segunda).toContain(huella);
  });

  it('la huella es derivable desde el UUID: se puede cruzar contra la base', () => {
    // A las 3 a.m. el ingeniero tiene el log y la base. `huellaId` es la función
    // que convierte un `viaje.id` de Postgres en lo que dice el log.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const viaje = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    logger.error('processInbound.fail', { viaje, err: 'boom' });
    expect(ultimaLinea(spy)).toContain(huellaId(viaje));
  });

  it('el UUID crudo NUNCA sale en la línea', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    logger.error('foto.cfdi', { cfdiUuid: uuid });
    expect(ultimaLinea(spy)).not.toContain(uuid);
  });

  it('el path del PDF conserva dos huellas distinguibles', () => {
    // `pdf.upload` salía como "[UUID]/[UUID].pdf": inservible para saber de qué
    // liquidación era el PDF que no subió.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tenant = '11111111-1111-1111-1111-111111111111';
    const liq = '99999999-8888-7777-6666-555555555555';
    logger.warn('pdf.upload', { path: `${tenant}/${liq}.pdf`, err: 'x' });
    expect(ultimaLinea(spy)).toContain(`${huellaId(tenant)}/${huellaId(liq)}.pdf`);
  });
});

describe('logger — lo que sí es dato personal se borra entero', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('el RFC se borra, no se huella', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('prueba', { rfc: 'XAXX010101000' });
    const salida = ultimaLinea(spy);
    expect(salida).toContain('[RFC]');
    expect(salida).not.toContain('XAXX010101000');
  });

  it('el wa_id mexicano de 13 dígitos se redacta', () => {
    // `wa.ratelimit` en el webhook emitía "from":"5219993700779" SIN redactar:
    // el wa_id que entrega Meta lleva el "1" y no cabía en \b\+?52\d{10}\b.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.warn('wa.ratelimit', { from: '5219993700779' });
    const salida = ultimaLinea(spy);
    expect(salida).toContain('[TEL]');
    expect(salida).not.toContain('5219993700779');
  });

  it('el teléfono de 12 dígitos con y sin + sigue redactándose', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.warn('wa.send', { to: '+525512345678', otro: '525512345678' });
    const salida = ultimaLinea(spy);
    expect(salida).not.toContain('525512345678');
  });

  it('el digest de Next sobrevive: son 10 dígitos, como un celular sin lada', () => {
    // Sin esta excepción, el hash que el usuario ve en pantalla sale como [TEL]
    // y el puente pantalla↔log del servidor deja de existir.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('request.fail', { digest: '3155718393', ruta: '/dashboard' });
    expect(ultimaLinea(spy)).toContain('3155718393');
  });

  it('un teléfono en otra clave se sigue redactando', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('request.fail', { digest: '3155718393', from: '9993700779' });
    const salida = ultimaLinea(spy);
    expect(salida).toContain('3155718393');
    expect(salida).not.toContain('9993700779');
  });

  it('una CLABE de 18 dígitos se redacta como [CLABE]', () => {
    // Auditoría 11 · ALTO (legal): antes de este test, un log de pago que
    // trajera la CLABE la emitía en claro.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('pago.devolucion', { clabe: '012345678901234567' });
    const salida = ultimaLinea(spy);
    expect(salida).toContain('[CLABE]');
    expect(salida).not.toContain('012345678901234567');
  });

  it('un PAN de tarjeta de 16 dígitos se redacta como [TARJETA]', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('pago.tarjeta', { pan: '4111111111111111' });
    const salida = ultimaLinea(spy);
    expect(salida).toContain('[TARJETA]');
    expect(salida).not.toContain('4111111111111111');
  });

  it('un epoch en milisegundos NO se confunde con un teléfono', () => {
    // Falso positivo caro: si `Date.now()` sale como [TEL] se pierde la hora,
    // que es justo lo único con lo que hoy se cruzan las líneas (t va vacío).
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('presupuesto', { ahora: 1785312000000 });
    expect(ultimaLinea(spy)).toContain('1785312000000');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 25, ALTO REINCIDENTE — un fallo SOLO-DE-CLIENTE (el layout raíz
// truena después de hidratar) no dejaba rastro en ninguna parte: la réplica a
// Sentry vive tras SENTRY_DSN, que en el bundle de cliente es `undefined`
// (no es NEXT_PUBLIC_*). `reportarAlServidor` es el puente: solo EN EL
// NAVEGADOR (`typeof window !== 'undefined'`), un warn/error hace un POST
// best-effort a `/api/client-error` — la única ruta que la CSP
// `connect-src 'self'` permite.
// ═══════════════════════════════════════════════════════════════════════════
describe('logger — un fallo de CLIENTE llega también al servidor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('redacta datos sensibles también en el mensaje antes de consola y del POST', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('window', {});
    const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    logger.error(`Fallo XAXX010101000 525500000000 ${uuid}`);
    const mensaje = `Fallo [RFC] [TEL] ${huellaId(uuid)}`;
    expect(JSON.parse(ultimaLinea(consoleSpy)).msg).toBe(mensaje);
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)).msg).toBe(mensaje);
  });

  it('en el navegador (window existe), un error hace POST a /api/client-error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('window', {});
    const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    logger.error('app.global_error', { digest: 'abc123' });
    await Promise.resolve(); // el fetch es fire-and-forget: deja correr el microtask

    expect(fetchSpy).toHaveBeenCalledWith('/api/client-error', expect.objectContaining({
      method: 'POST',
      keepalive: true,
    }));
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const enviado = JSON.parse(String(init.body));
    expect(enviado).toMatchObject({ level: 'error', msg: 'app.global_error', meta: { digest: 'abc123' } });
  });

  it('SIN window (servidor), no hace ningún fetch — ya se logueó por la vía normal', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    logger.error('server.fallo', { x: 1 });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('en el navegador, info/debug NO disparan el POST — solo warn/error merecen el viaje', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('window', {});
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    logger.info('algo.normal', {});
    await Promise.resolve();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('un fetch que lanza (red caída) no revienta el logger — best-effort, nunca lanza', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('window', {});
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('red caída'); }));

    expect(() => logger.error('app.global_error', {})).not.toThrow();
  });
});
