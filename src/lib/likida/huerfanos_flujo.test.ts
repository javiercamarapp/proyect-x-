import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// EL CHOFER QUE NO DICE «HOLA». 1-ago-2026.
//
// Termina la ruta, saca el fajo y manda once fotos de golpe, sin viaje abierto.
// Hasta hoy se le contestaba «No tienes un viaje abierto para liquidar ahorita»
// y sus once comprobantes se tiraban — mientras que el XML del CFDI, en ese
// MISMO corte, sí se conservaba. El producto pedía un documento y se negaba a
// recibir justo el que importa.
//
// Se ejercita `processInbound` de verdad. Las funciones puras ya se prueban en
// `intake/huerfanos.test.ts`; lo que ha fallado hoy siete veces es el cableado.
// ═══════════════════════════════════════════════════════════════════════════

const addGasto = vi.fn();
const guardarHuerfano = vi.fn();
const getHuerfanos = vi.fn();
const resolverHuerfanos = vi.fn();
const marcarHuerfanosOfrecidos = vi.fn();
const getOpenViaje = vi.fn();
const getGastos = vi.fn();
const extraerComprobante = vi.fn();
const subirComprobante = vi.fn();
const runAgent = vi.fn();

vi.mock('@/lib/agents/run', () => ({ runAgent: (...a: unknown[]) => runAgent(...a) }));
vi.mock('@/lib/likida/intake/ocr', () => ({
  extraerComprobante: (...a: unknown[]) => extraerComprobante(...a),
  tieneCodigoLegible: vi.fn(async () => false),
}));
vi.mock('@/lib/likida/intake/hash', () => ({ hashImagen: vi.fn(async () => 'HASH') }));
vi.mock('@/lib/likida/intake/almacen', () => ({
  subirComprobante: (...a: unknown[]) => subirComprobante(...a),
  ligaComprobante: vi.fn(),
}));
vi.mock('@/lib/likida/conv', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveOperador: vi.fn(async () => ({ tenantId: 't1', operadorId: 'o1' })),
  getOpenViaje: (...a: unknown[]) => getOpenViaje(...a),
  getTenantContext: vi.fn(async () => ({ nombre: 'Flota' })),
  loadConversation: vi.fn(async () => ({ id: 'c1', turns: [] })),
  saveConversation: vi.fn(), claimMessage: vi.fn(async () => 'nuevo' as const),
  acquireViajeLock: vi.fn(async () => true), intentarLockViaje: vi.fn(async () => 'obtenido' as const), releaseViajeLock: vi.fn(),
  releaseMessageClaim: vi.fn(),
  intakeDelta: vi.fn(async () => 1), esperarIntake: vi.fn(async () => true),
}));
vi.mock('@/lib/likida/repo', () => ({
  ubicarGastoPorHash: vi.fn(async () => null),
  addGasto: (...a: unknown[]) => addGasto(...a),
  guardarHuerfano: (...a: unknown[]) => guardarHuerfano(...a),
  getHuerfanos: (...a: unknown[]) => getHuerfanos(...a),
  resolverHuerfanos: (...a: unknown[]) => resolverHuerfanos(...a),
  marcarHuerfanosOfrecidos: (...a: unknown[]) => marcarHuerfanosOfrecidos(...a),
  getGastos: (...a: unknown[]) => getGastos(...a), updateGastoCfdiXml: vi.fn(), saveCfdiXmlRaw: vi.fn(),
  gastoExistePorHash: vi.fn(async () => false), gastoPorHash: vi.fn(async () => null),
  corregirFechaGasto: vi.fn(),
  enriquecerGastoConCodigo: vi.fn(), guardarCodigoPendiente: vi.fn(),
  getCodigosPendientes: vi.fn(async () => []), reclamarCodigoPendiente: vi.fn(),
  guardarFotoPendiente: vi.fn(async () => null), existeFotoPendiente: vi.fn(async () => false),
  reclamarFotoPendiente: vi.fn(async () => null),
  getDatosResponsable: vi.fn(async () => ({
    razonSocial: 'FLOTA SA DE CV', domicilio: 'Calle 1, Mérida', urlAvisoIntegral: 'https://flota.mx/p',
  })),
  reclamarEnvioAviso: vi.fn(async () => false), liberarEnvioAviso: vi.fn(),
  getViaje: vi.fn(async () => ({ id: 'v1', anticipo: 3000, origen: 'Silao', destino: 'N. Laredo', fechaInicio: '2026-08-01' })),
  getOperador: vi.fn(async () => ({ id: 'o1', nombre: 'Operador', telefono: '5219993700779' })),
  saveLiquidacion: vi.fn(async () => 'L1'),
  getAcumuladoCombustible: vi.fn(async () => { throw new Error('sin base'); }),
}));
vi.mock('@/lib/likida/config', () => ({
  getConfig: vi.fn(async () => ({
    politica: [], hidrocarburos: { claves: [] }, estimulos: { clavesPeaje: [] },
    validacion: { fechaToleranciaDiasAntes: 30 },
  })),
}));
vi.mock('@/lib/likida/costos', () => ({
  registrarCosto: vi.fn(), registrarCostoWhatsApp: vi.fn(),
  faseDeModelo: vi.fn(() => 'cuadre'), vincularCostosALiquidacion: vi.fn(),
}));
vi.mock('@/lib/meta/client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  downloadMediaAsDataUrl: vi.fn(async () => 'data:image/jpeg;base64,AAAA'),
}));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    storage: { from: () => ({ upload: async () => ({ error: null }), createSignedUrl: async () => ({ data: null, error: { message: 'x' } }) }) },
  }),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { processInbound } = await import('./processor');

const salientes: string[] = [];
const fetchSpy = vi.fn(async (_u: string, init?: RequestInit) => {
  const b = JSON.parse(String(init?.body ?? '{}'));
  salientes.push(String((b.text as { body?: string } | undefined)?.body ?? ''));
  return new Response(JSON.stringify({ messages: [{ id: 'w' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
});

const foto = { from: '5219993700779', type: 'image' as const, mediaId: 'm1', waMessageId: 'wa1' };
const texto = (t: string) => ({ from: '5219993700779', type: 'text' as const, text: t, waMessageId: `wa-${t}` });

const HUERFANO = (id: string, monto: number, ofrecido = false) => ({
  id, gasto: { id: `g-${id}`, concepto: 'diesel', monto, ocrExtra: {} },
  motivo: 'sin_viaje' as const, creadoEn: '2026-07-31T10:00:00Z',
  ofrecidoEn: ofrecido ? '2026-08-01T10:00:00Z' : undefined,
});

describe('el chofer que manda fotos sin viaje abierto', () => {
  beforeEach(() => {
    salientes.length = 0;
    for (const m of [addGasto, guardarHuerfano, getHuerfanos, resolverHuerfanos,
                     marcarHuerfanosOfrecidos, getOpenViaje, extraerComprobante, subirComprobante, runAgent, getGastos]) m.mockReset();
    vi.stubGlobal('fetch', fetchSpy); fetchSpy.mockClear();
    process.env.WHATSAPP_ACCESS_TOKEN = 'tok'; process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
    getOpenViaje.mockResolvedValue(null);          // ← SIN viaje
    getHuerfanos.mockResolvedValue([]);
    getGastos.mockResolvedValue([]);
    guardarHuerfano.mockResolvedValue(true);
    subirComprobante.mockResolvedValue('t1/sin-viaje/HASH.jpg');
    addGasto.mockResolvedValue(undefined);
    runAgent.mockResolvedValue({ finalText: 'ok', toolCalls: [], model: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0 });
    extraerComprobante.mockResolvedValue({
      legible: true,
      gasto: { concepto: 'diesel', monto: 2890, fecha: '2026-07-31', ocrExtra: {} },
      costo: { modelo: 'm', tokensIn: 1, tokensOut: 1, costoUsd: 0 },
    });
  });

  it('EL FALLO: su foto ya no se tira, se guarda', async () => {
    await processInbound(foto);
    expect(guardarHuerfano).toHaveBeenCalledWith('t1', 'o1', expect.objectContaining({ motivo: 'sin_viaje' }));
    expect(salientes.join(' ')).toMatch(/no se pierden/i);
    expect(salientes.join(' '), 'ya no puede ser la única respuesta').not.toMatch(/^No tienes un viaje abierto/);
  });

  it('la imagen se archiva, no solo el número: el OCR se puede discutir, el papel no', async () => {
    await processInbound(foto);
    expect(subirComprobante).toHaveBeenCalled();
    expect(guardarHuerfano.mock.calls[0][2]).toMatchObject({ rutaImagen: 't1/sin-viaje/HASH.jpg' });
  });

  it('en una ráfaga de once NO acusa once veces', async () => {
    // Mismo criterio que el acuse de ráfaga y el aviso de acercamiento: tres
    // mensajes idénticos seguidos hacen ver el producto roto.
    getHuerfanos.mockResolvedValue([HUERFANO('a', 100), HUERFANO('b', 200)]);
    await processInbound(foto);
    expect(salientes).toHaveLength(0);
  });

  it('si no se puede guardar, se lo DICE en vez de dejarlo creer que sí', async () => {
    guardarHuerfano.mockResolvedValue(false);
    await processInbound(foto);
    expect(salientes.join(' ')).toMatch(/no pude guardar/i);
  });

  // ── LA RAMA GEMELA DEL `avisar_falla` (4-ago-2026) ────────────────────────
  //
  // El camino CON viaje abierto ya guardaba el comprobante cuando el que falla
  // es NUESTRO OCR; éste, el de sin viaje, seguía tirándolo con el mensaje de
  // «reenvíamela con buena luz», que le echa al chofer la culpa de un 429
  // nuestro y lo manda a repetir una foto que va a fallar igual.
  const falloTecnico = () => extraerComprobante.mockResolvedValue({
    legible: false, motivo: 'fallo_tecnico',
    gasto: { concepto: 'otro', monto: 0, ocrConfianza: 0 },
    costo: { modelo: 'm', tokensIn: 1, tokensOut: 1, costoUsd: 0 },
  });

  it('si el que se cae es NUESTRO OCR, el comprobante se guarda — no se tira', async () => {
    falloTecnico();
    await processInbound(foto);
    expect(guardarHuerfano).toHaveBeenCalledWith('t1', 'o1', expect.objectContaining({
      motivo: 'fallo_ocr', rutaImagen: 't1/sin-viaje/HASH.jpg',
    }));
    // La imagen viaja DENTRO del gasto también: es la única evidencia que queda
    // de un papel cuyo monto no se pudo leer.
    expect(guardarHuerfano.mock.calls[0][2].gasto).toMatchObject({ imagenUrl: 't1/sin-viaje/HASH.jpg' });
  });

  it('y no le echa la culpa a su foto ni le pide completar un ticket que no leímos', async () => {
    falloTecnico();
    await processInbound(foto);
    const m = salientes.join(' ');
    expect(m, 'la foto está bien: el 429 es nuestro').not.toMatch(/difícil de leer|buena luz/i);
    expect(m).toMatch(/no es tu foto/i);
    expect(m, 'lo único que recupera el monto es el reenvío').toMatch(/reenv/i);
  });

  it('si además NO se pudo guardar, se lo dice en vez de dejarlo creer que sí', async () => {
    falloTecnico();
    guardarHuerfano.mockResolvedValue(false);
    await processInbound(foto);
    expect(salientes.join(' ')).toMatch(/tampoco lo pude guardar/i);
  });

  it('en una ráfaga no da once explicaciones del mismo 429', async () => {
    // `fallo_tecnico` es sistémico —proveedor caído, truncamiento—: si falló
    // una foto del fajo, fallaron todas. Mismo criterio que el acuse normal.
    falloTecnico();
    getHuerfanos.mockResolvedValue([HUERFANO('a', 0), HUERFANO('b', 0)]);
    await processInbound(foto);
    expect(guardarHuerfano).toHaveBeenCalled();
    expect(salientes).toHaveLength(0);
  });

  it('una foto ilegible se pide otra vez, no se guarda basura', async () => {
    extraerComprobante.mockResolvedValue({
      legible: false, motivo: 'ilegible',
      gasto: { concepto: 'otro', monto: 0, ocrExtra: {} },
      costo: { modelo: 'm', tokensIn: 1, tokensOut: 1, costoUsd: 0 },
    });
    await processInbound(foto);
    expect(guardarHuerfano).not.toHaveBeenCalled();
    expect(salientes.join(' ')).toMatch(/difícil de leer/i);
  });

  it('un texto sin viaje sigue contestando lo de siempre', async () => {
    await processInbound(texto('hola'));
    expect(salientes.join(' ')).toMatch(/No tienes un viaje abierto/);
  });
});

describe('cuando por fin hay viaje, se pregunta antes de adjuntar', () => {
  beforeEach(() => {
    salientes.length = 0;
    for (const m of [addGasto, guardarHuerfano, getHuerfanos, resolverHuerfanos,
                     marcarHuerfanosOfrecidos, getOpenViaje, extraerComprobante, subirComprobante, runAgent, getGastos]) m.mockReset();
    vi.stubGlobal('fetch', fetchSpy); fetchSpy.mockClear();
    process.env.WHATSAPP_ACCESS_TOKEN = 'tok'; process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
    getOpenViaje.mockResolvedValue('v1');          // ← CON viaje
    getGastos.mockResolvedValue([]);
    guardarHuerfano.mockResolvedValue(true);
    addGasto.mockResolvedValue(undefined);
    resolverHuerfanos.mockResolvedValue(true);
    subirComprobante.mockResolvedValue('ruta');
    runAgent.mockResolvedValue({ finalText: 'ok', toolCalls: [], model: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0 });
  });

  it('un fallo OCR con viaje queda ligado al viaje y conserva el hash de la foto', async () => {
    getHuerfanos.mockResolvedValue([]);
    extraerComprobante.mockResolvedValue({
      legible: false, motivo: 'fallo_tecnico',
      gasto: { concepto: 'otro', monto: 0, ocrConfianza: 0 },
      costo: { modelo: 'm', tokensIn: 1, tokensOut: 1, costoUsd: 0 },
    });

    await processInbound(foto);

    expect(guardarHuerfano).toHaveBeenCalledWith('t1', 'o1', expect.objectContaining({
      motivo: 'fallo_ocr', viajeId: 'v1',
      gasto: expect.objectContaining({ imgHash: 'HASH' }),
    }));
  });

  it('al reintentar y guardar la misma foto, resuelve durablemente su incidente OCR', async () => {
    getHuerfanos.mockImplementation(async (_t, _o, opciones) =>
      opciones?.soloFalloOcr
        ? [{ id: 'ocr-1', gasto: { id: 'x', concepto: 'otro', monto: 0, imgHash: 'HASH' }, motivo: 'fallo_ocr' }]
        : []);
    extraerComprobante.mockResolvedValue({
      legible: true,
      gasto: { id: 'nuevo', concepto: 'diesel', monto: 1000, fecha: '2026-09-03', ocrConfianza: 0.95 },
      costo: { modelo: 'm', tokensIn: 1, tokensOut: 1, costoUsd: 0 },
    });

    await processInbound(foto);

    expect(addGasto).toHaveBeenCalled();
    expect(resolverHuerfanos).toHaveBeenCalledWith('t1', ['ocr-1'], 'adjuntado', 'v1');
  });

  it('ofrece con la lista y la ruta, y NO adjunta nada todavía', async () => {
    getHuerfanos.mockResolvedValue([HUERFANO('a', 2890), HUERFANO('b', 980)]);
    await processInbound(texto('hola'));
    const m = salientes.join(' ');
    expect(m).toMatch(/¿Los agrego a este viaje\?/);
    expect(m).toContain('$3,870.00');
    expect(m).toContain('Silao→N. Laredo');
    expect(addGasto, 'preguntar no es adjuntar').not.toHaveBeenCalled();
    expect(marcarHuerfanosOfrecidos).toHaveBeenCalledWith('t1', ['a', 'b']);
  });

  it('el huérfano SIN monto (el del OCR caído) no se ofrece: sería una línea de $0.00', async () => {
    // Adjuntarlo metería «• Otro · $0.00» en la liquidación que lee el
    // contralor — una cifra que nadie midió. Se conserva (la fila y la foto son
    // la evidencia) y se recupera reenviando la foto, que es lo que su propio
    // mensaje le pidió.
    getHuerfanos.mockResolvedValue([HUERFANO('a', 0)]);
    await processInbound(texto('hola'));
    expect(marcarHuerfanosOfrecidos).not.toHaveBeenCalled();
    expect(salientes.join(' ')).not.toMatch(/¿Los agrego/);
    expect(salientes.join(' ')).not.toContain('$0.00');
  });

  it('y si hay uno con monto y otro sin él, solo se ofrece el que se pudo leer', async () => {
    getHuerfanos.mockResolvedValue([HUERFANO('a', 0), HUERFANO('b', 2890)]);
    await processInbound(texto('hola'));
    expect(marcarHuerfanosOfrecidos).toHaveBeenCalledWith('t1', ['b']);
    expect(salientes.join(' ')).toContain('$2,890.00');
  });

  it('con un «sí» los adjunta y los marca DESPUÉS de insertarlos', async () => {
    getHuerfanos.mockResolvedValue([HUERFANO('a', 2890, true), HUERFANO('b', 980, true)]);
    await processInbound(texto('sí'));
    expect(addGasto).toHaveBeenCalledTimes(2);
    expect(resolverHuerfanos).toHaveBeenCalledWith('t1', ['a', 'b'], 'adjuntado', 'v1');
    expect(salientes.join(' ')).toContain('$3,870.00');
  });

  it('y el acuse dice el NETO, calculado con el mismo dedup que el cuadre', async () => {
    // El acuse decía «$28,041.15» y la liquidación «$12,388.05». Los dos ciertos,
    // y el operador entendiendo que le recortaron. Ahora sale la resta ahí mismo.
    getHuerfanos.mockResolvedValue([HUERFANO('a', 100, true)]);
    getGastos.mockResolvedValue([
      { id: 'x', concepto: 'diesel', monto: 100, folio: 'F1', folioNorm: 'F1' },
      { id: 'y', concepto: 'diesel', monto: 100, folio: 'F1', folioNorm: 'F1' },  // copia
    ]);
    await processInbound(texto('sí'));
    const m = salientes.join(' ');
    expect(m).toContain('1 repetido');
    expect(m, 'el comprobado real, no la suma del papel').toContain('$100.00');
  });

  it('si no se puede leer el viaje, el acuse NO promete un total', async () => {
    getHuerfanos.mockResolvedValue([HUERFANO('a', 100, true)]);
    getGastos.mockRejectedValue(new Error('base caída'));
    await processInbound(texto('sí'));
    expect(salientes.join(' ')).not.toMatch(/llevas/i);
    expect(addGasto, 'y los comprobantes sí entraron').toHaveBeenCalled();
  });

  it('si uno falla al insertarse, NO se marca como puesto', async () => {
    // Marcar primero dejaría un comprobante contado como agregado que no está
    // en ningún lado, y nadie volvería a ofrecerlo.
    getHuerfanos.mockResolvedValue([HUERFANO('a', 100, true), HUERFANO('b', 200, true)]);
    addGasto.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('boom'));
    await processInbound(texto('sí'));
    expect(resolverHuerfanos).toHaveBeenCalledWith('t1', ['a'], 'adjuntado', 'v1');
  });

  it('con un «no» los descarta sin tocar el viaje', async () => {
    getHuerfanos.mockResolvedValue([HUERFANO('a', 100, true)]);
    await processInbound(texto('no'));
    expect(addGasto).not.toHaveBeenCalled();
    expect(resolverHuerfanos).toHaveBeenCalledWith('t1', ['a'], 'descartado', null);
  });

  it('«listo» NO dispara la oferta: cerrar no puede costarle dos intentos', async () => {
    // Interceptar un cierre con una pregunta lo obligaría a escribir `listo` dos
    // veces, y en una sala eso se lee como que el sistema no entendió.
    getHuerfanos.mockResolvedValue([HUERFANO('a', 100)]);
    await processInbound(texto('listo'));
    expect(marcarHuerfanosOfrecidos).not.toHaveBeenCalled();
    expect(salientes.join(' ')).not.toMatch(/¿Los agrego/);
  });

  it('sin nada esperando, el flujo normal no se entera de que esto existe', async () => {
    getHuerfanos.mockResolvedValue([]);
    await processInbound(texto('hola'));
    expect(marcarHuerfanosOfrecidos).not.toHaveBeenCalled();
    expect(runAgent, 'el mensaje tiene que llegar al agente como siempre').toHaveBeenCalled();
  });

  it('un error leyendo la sala de espera no le impide usar su viaje', async () => {
    // `getHuerfanos` devuelve [] ante un fallo de lectura, a propósito.
    getHuerfanos.mockResolvedValue([]);
    // La frase era "cuánto llevo" y dejó de servir aquí: ahora ESA pregunta se
    // contesta desde la base sin pasar por el agente (`consulta_chofer.ts`), así
    // que el test se caía por la razón equivocada. Lo que prueba —que un fallo
    // leyendo la sala de espera no bloquea el camino normal— no cambió; hacía
    // falta un mensaje sin significado propio para poder seguir probándolo.
    await processInbound(texto('hola, una pregunta'));
    expect(runAgent).toHaveBeenCalled();
  });
});
