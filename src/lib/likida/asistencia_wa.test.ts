import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// El circuito de asistencia/siniestros (0198, Fase 4). Lo que más se prueba
// es lo que más cuesta si falla — y aquí lo que falla cuesta VIDAS, no pesos:
//
//   · el falso NEGATIVO es el caro (la asimetría invertida de talacha): un
//     "chocamos" que no se reconozca es una emergencia tratada como charla;
//   · `hay_lesionados` JAMÁS false por defecto — NULL es "no preguntado";
//   · el modo mudo (violencia activa) contesta UNA sola línea neutra;
//   · el segundo mensaje de la misma emergencia NO duplica el 🚨 al jefe;
//   · la firma del jefe es atómica: dos taps, un ganador, y el segundo
//     recibe la verdad.
// ═══════════════════════════════════════════════════════════════════════════

type Resp = { data?: unknown; error?: { message: string } | null };
let respuestas: Record<string, Resp>;
let escrituras: Array<{ clave: string; payload: unknown }>;

function claveDe(tabla: string, verbo: string, selectArg: string | null): string {
  if (verbo === 'update') return `${tabla}.claim`;
  if (verbo === 'insert') return `${tabla}.insert`;
  return `${tabla}.select:${selectArg ?? ''}`;
}

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      let verbo = 'select';
      let selectArg: string | null = null;
      let payload: unknown = null;
      const responder = (): Resp => {
        const clave = claveDe(tabla, verbo, selectArg);
        if (verbo !== 'select') escrituras.push({ clave, payload });
        const r = respuestas[clave];
        if (!r) throw new Error(`sin respuesta preparada para ${clave}`);
        return r;
      };
      const b = {
        select: (arg: string) => { if (verbo === 'select') selectArg = arg; return b; },
        update: (fila: unknown) => { verbo = 'update'; payload = fila; return b; },
        insert: (fila: unknown) => { verbo = 'insert'; payload = fila; return b; },
        eq: () => b, in: () => b, neq: () => b, is: () => b,
        order: () => b, limit: () => b,
        maybeSingle: async () => responder(),
        then: (res: (r: Resp) => unknown, rej: (e: unknown) => unknown) => {
          try { return Promise.resolve(responder()).then(res, rej); } catch (e) { return Promise.reject(e).catch(rej); }
        },
      };
      return b;
    },
  }),
}));
vi.mock('./presupuesto', async (orig) => ({
  ...(await orig() as object),
  acotada: (q: unknown) => q,
}));
const crearIncidencia = vi.fn();
vi.mock('./operacion', () => ({ crearIncidencia: (...a: unknown[]) => crearIncidencia(...a) }));
const telefonoJefeDe = vi.fn();
vi.mock('./contactos', () => ({ telefonoJefeDe: (...a: unknown[]) => telefonoJefeDe(...a) }));
const sendText = vi.fn();
const sendButtons = vi.fn();
// AGEN-5 / WA-4: el reenvío al jefe sale por `avisarOficina` (texto →
// plantilla fuera de la ventana de 24 h); estos son sus dos bordes.
const enviarTexto = vi.fn();
const sendTemplate = vi.fn();
vi.mock('@/lib/meta/client', () => ({
  MAX_CUERPO_BOTONES: 1024,
  sendText: (...a: unknown[]) => sendText(...a),
  sendButtons: (...a: unknown[]) => sendButtons(...a),
  enviarTexto: (...a: unknown[]) => enviarTexto(...a),
  sendTemplate: (...a: unknown[]) => sendTemplate(...a),
  motivoDeFalloWhatsApp: (e: string) => e,
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// Capa C: la cascada se mockea para probar el CABLEADO (que viaja en el 🚨 y
// que en mudo ni se consulta); el motor tiene sus pruebas propias en
// asistencia_proveedor.test.ts.
const recomendacionCascada = vi.fn();
vi.mock('./asistencia_proveedor', () => ({ recomendacionCascada: (...a: unknown[]) => recomendacionCascada(...a) }));

const {
  interpretarAsistencia, tipoDeAsistencia, lesionadosSegunTexto,
  atenderAsistenciaChofer, atenderReconocimientoAsistencia, atenderAsistenciaOficina,
  cerrarCoordinacionesDeIncidencia, anclarUbicacionIncidencia,
} = await import('./asistencia_wa');

const INC = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const JEFE = { tenantId: 't1', rol: 'flota_admin' as const, userId: 'u-jefe' };

const SELECT_ABIERTA = 'incidencia.select:id, tipo, prioridad, hay_lesionados, abierta_en';

/** Una fila de expediente abierto, fresca por default (ahora mismo). */
function filaAbierta(over: Record<string, unknown> = {}) {
  return {
    id: INC, tipo: 'siniestro', prioridad: 'critica',
    hay_lesionados: null, abierta_en: new Date().toISOString(),
    ...over,
  };
}

/** El caso común: nada abierto, hay jefe, todo se puede leer y escribir. */
function baseFeliz() {
  respuestas = {
    [SELECT_ABIERTA]: { data: [], error: null },
    'incidencia.select:id': { data: [], error: null },
    'incidencia.claim': { data: [], error: null },
    'incidencia_evento.insert': { error: null },
    'operador.select:nombre': { data: { nombre: 'Juan Pérez' }, error: null },
    'viaje.select:folio': { data: { folio: 'VJ-0847' }, error: null },
  };
  telefonoJefeDe.mockResolvedValue('5215550000009');
  sendButtons.mockResolvedValue('wamid.BTN');
  sendText.mockResolvedValue('wamid.TXT');
  enviarTexto.mockReset();
  enviarTexto.mockResolvedValue({ ok: true, id: 'wamid.JEFE' });
  sendTemplate.mockReset();
  sendTemplate.mockResolvedValue({ ok: false, error: 'no aprobada', codigo: 132001 });
  crearIncidencia.mockResolvedValue(INC);
}

beforeEach(() => {
  respuestas = {};
  escrituras = [];
  vi.clearAllMocks();
});

// ── El reconocedor ─────────────────────────────────────────────────────────

describe('interpretarAsistencia — ROJO por familia', () => {
  it.each([
    ['chocamos con un tráiler', false],
    ['se volcó, volcadura en la curva', false],
    ['atropellamos a alguien', false],
    ['se está quemando la unidad, incendio', false],
    ['hay un herido', false],
    ['derrame de diésel en la carretera', false],
    ['márquenle al 911', false],
    ['la vía está bloqueada por un accidente', false],
    ['nos asaltaron en la caseta', true],
    ['me robaron el tráiler', true],
    ['balacera adelante', true],
    ['hay un retén raro', true],
  ])('"%s" es ROJO (mudo=%s)', (texto, mudo) => {
    const r = interpretarAsistencia(texto);
    expect(r).toEqual({ nivel: 'rojo', modoMudo: mudo });
  });

  it('la pregunta NO descarta: "¿qué hago? choqué" es ROJO', () => {
    expect(interpretarAsistencia('¿qué hago? choqué')?.nivel).toBe('rojo');
  });

  it('SIN tope de largo: 500 caracteres con "chocamos" adentro reconocen (talacha corta a 220)', () => {
    const largo = 'te cuento todo lo que pasó porque fue un desastre '.repeat(9) + ' y chocamos contra el muro de contención';
    expect(largo.length).toBeGreaterThan(400);
    expect(interpretarAsistencia(largo)?.nivel).toBe('rojo');
  });

  it('el modo mudo es SOLO violencia — lesionados es ROJO normal (necesita instrucciones)', () => {
    expect(interpretarAsistencia('hay dos lesionados')).toEqual({ nivel: 'rojo', modoMudo: false });
    expect(interpretarAsistencia('nos asaltaron y hay un herido')).toEqual({ nivel: 'rojo', modoMudo: true });
  });

  it.each(['me quedé varado', 'no arranca el camión', 'se me fue el freno', 'sale humo del motor', 'se sobrecalentó'])(
    '"%s" es ÁMBAR', (texto) => {
      expect(interpretarAsistencia(texto)).toEqual({ nivel: 'ambar', modoMudo: false });
    },
  );

  it('lo que no es emergencia sigue su camino: talacha, hitos, charla', () => {
    expect(interpretarAsistencia('se me ponchó una llanta, la talacha son 800')).toBeNull();
    expect(interpretarAsistencia('ya llegué')).toBeNull();
    expect(interpretarAsistencia('¿cuánto llevo?')).toBeNull();
    // "chocolate" no es "choque": la alternancia es explícita, no raíz.
    expect(interpretarAsistencia('me compré un chocolate en el oxxo')).toBeNull();
  });

  // ── AUDITORÍA FABLE CICLO 1 (92-A): las formas del habla real que la
  //    primera lista NO reconocía — cada mensaje es textual del reporte. ──
  it.each([
    ['nos volteamos en la curva', false],
    ['me pegaron por atras', false],
    ['le di a un coche', false],
    ['me di un llegue', false],
    ['nos estrellamos', false],
    ['me estampe', false],
    ['se prendio la caja', false],
    ['se quemo la unidad', false],
    ['hubo un accidente', false],
    ['tuve un accidente en la federal', false],
    ['se murio un señor en el accidente', false],
    ['nos estan disparando', true],
    ['nos pararon unos tipos armados', true],
    ['traen pistolas', true],
    ['nos encañonaron', true],
    ['me bajaron del camion a la fuerza', true],
  ])('92-A: "%s" ahora es ROJO (mudo=%s)', (texto, mudo) => {
    expect(interpretarAsistencia(texto)).toEqual({ nivel: 'rojo', modoMudo: mudo });
  });

  // ── AUDITORÍA FABLE CICLO 1 (92-B): "es un robo" como queja de precio
  //    disparaba el protocolo de violencia completo — la talacha del chofer
  //    se tragaba y al jefe se le ordenaba NO contactarlo. ──
  it.each([
    'la talacha me cobra 800, es un robo',
    'esa caseta es un robo',
    'el diesel esta por los cielos, un robo',
    'ya pasamos el reten sin problema',
  ])('92-B: "%s" NO dispara violencia — sigue su camino', (texto) => {
    expect(interpretarAsistencia(texto)).toBeNull();
  });

  it('92-B: los robos DE VERDAD siguen siendo mudos', () => {
    expect(interpretarAsistencia('nos estan robando')).toEqual({ nivel: 'rojo', modoMudo: true });
    expect(interpretarAsistencia('me robaron el trailer')).toEqual({ nivel: 'rojo', modoMudo: true });
    expect(interpretarAsistencia('robaron la unidad anoche')).toEqual({ nivel: 'rojo', modoMudo: true });
    expect(interpretarAsistencia('hay un reten raro adelante')).toEqual({ nivel: 'rojo', modoMudo: true });
  });
});

describe('tipoDeAsistencia y lesionados', () => {
  it('la violencia manda el protocolo aunque haya heridos: robo + hay_lesionados aparte', () => {
    const texto = 'nos asaltaron y hay un herido';
    expect(tipoDeAsistencia(texto, 'rojo')).toBe('robo');
    expect(lesionadosSegunTexto(texto)).toBe(true);
  });

  it('choque → siniestro; herido solo → emergencia_medica; vía → bloqueo; ámbar → varado', () => {
    expect(tipoDeAsistencia('chocamos feo', 'rojo')).toBe('siniestro');
    expect(tipoDeAsistencia('hay un herido', 'rojo')).toBe('emergencia_medica');
    expect(tipoDeAsistencia('la vía está bloqueada', 'rojo')).toBe('bloqueo');
    expect(tipoDeAsistencia('me quedé varado', 'ambar')).toBe('varado');
  });

  it('hay_lesionados es NULL cuando el texto no lo dice — JAMÁS false', () => {
    // La aserción más importante del circuito: el silencio no es un parte médico.
    expect(lesionadosSegunTexto('chocamos contra el muro')).toBeNull();
    expect(lesionadosSegunTexto('volcadura en la curva')).toBeNull();
  });
});

// ── El lado del chofer ─────────────────────────────────────────────────────

describe('atenderAsistenciaChofer', () => {
  it('abre la incidencia con tipo/prioridad/lesionados correctos y avisa al jefe con 🚨 y botón', async () => {
    baseFeliz();
    const r = await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: 'v1', operadorId: 'o1',
      texto: 'chocamos con un coche, hay un herido',
      asistencia: { nivel: 'rojo', modoMudo: false },
      waMessageId: 'wamid.X1',
    });
    expect(crearIncidencia).toHaveBeenCalledWith('t1', expect.objectContaining({
      viajeId: 'v1', operadorId: 'o1', tipo: 'siniestro', prioridad: 'critica', hayLesionados: true,
    }));
    const [tel, cuerpo, botones] = sendButtons.mock.calls[0] as [string, string, Array<{ id: string }>];
    expect(tel).toBe('5215550000009');
    expect(cuerpo).toContain('🚨');
    expect(cuerpo).toContain('LESIONADOS');
    expect(botones[0].id).toBe(`asi_ok:${INC}`);
    expect(r.respuesta).toContain('911');
  });

  it('Capa C: la cascada del proveedor correcto viaja EN el 🚨 al jefe', async () => {
    baseFeliz();
    recomendacionCascada.mockResolvedValue('\nA quién marcarle (marca un humano, no Likida):\n· Grúas García (grua) 5511112222 — ~12 km');
    await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: 'v1', operadorId: 'o1',
      texto: 'volcadura en la curva del km 40',
      asistencia: { nivel: 'rojo', modoMudo: false },
    });
    expect(recomendacionCascada).toHaveBeenCalledWith('t1', INC, 'siniestro', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), expect.any(Number));
    const cuerpo = (sendButtons.mock.calls[0] as [string, string])[1];
    expect(cuerpo).toContain('Grúas García');
    expect(cuerpo).toContain('marca un humano, no Likida');
  });

  it('Capa C: en modo mudo (violencia) la cascada NI SE CONSULTA — el protocolo manda', async () => {
    baseFeliz();
    await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: 'v1', operadorId: 'o1',
      texto: 'nos asaltaron en la caseta',
      asistencia: { nivel: 'rojo', modoMudo: true },
    });
    expect(recomendacionCascada).not.toHaveBeenCalled();
    expect(sendButtons).toHaveBeenCalled();
  });

  it('Capa C: si la cascada no tiene nada (null), el 🚨 sale igual y completo', async () => {
    baseFeliz();
    recomendacionCascada.mockResolvedValue(null);
    await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: 'v1', operadorId: 'o1',
      texto: 'volcadura en la curva del km 40',
      asistencia: { nivel: 'rojo', modoMudo: false },
    });
    const cuerpo = (sendButtons.mock.calls[0] as [string, string])[1];
    expect(cuerpo).toContain('🚨');
    expect(cuerpo).toContain('aprieta el botón');
  });

  it('sin mención de lesionados, hayLesionados viaja NULL — no false', async () => {
    baseFeliz();
    await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: 'v1', operadorId: 'o1',
      texto: 'volcadura en la curva del km 40',
      asistencia: { nivel: 'rojo', modoMudo: false },
    });
    expect(crearIncidencia).toHaveBeenCalledWith('t1', expect.objectContaining({ hayLesionados: null }));
  });

  it('modo mudo: UNA línea neutra al chofer, y el aviso al jefe trae el "no le marques"', async () => {
    baseFeliz();
    const r = await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: 'v1', operadorId: 'o1',
      texto: 'nos están asaltando',
      asistencia: { nivel: 'rojo', modoMudo: true },
    });
    expect(r.respuesta).toBe('Recibido. Tu jefe ya lo sabe.');
    const cuerpo = String(sendButtons.mock.calls[0][1]);
    expect(cuerpo).toContain('NO le marques');
  });

  // AUDITORÍA 28, MEDIO (AG-M2): antes esta rama devolvía la MISMA línea "ya lo
  // sabe" aunque el aviso al jefe hubiera rebotado — un "más texto es más
  // vibración" que se pasó de la vibración a la mentira. Sigue siendo UNA
  // línea corta y neutra (nada de instrucciones largas al chofer en violencia
  // activa), pero ahora es VERDADERA.
  it('modo mudo SÍ dice la verdad del aviso: si el jefe no lo recibió, otra línea corta (no "ya lo sabe")', async () => {
    baseFeliz();
    sendButtons.mockResolvedValue(null);   // Meta rechazó
    sendText.mockResolvedValue(null);      // y el fallback de texto (c4-1) también
    const r = await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: 'v1', operadorId: 'o1',
      texto: 'nos están asaltando',
      asistencia: { nivel: 'rojo', modoMudo: true },
    });
    expect(r.respuesta).toBe('Recibido. No pude avisar a tu jefe — si puedes, márcale tú.');
    expect(r.respuesta).not.toContain('ya lo sabe');
    // La bitácora también dice la verdad, para el post-mortem y la Fase 5.
    expect(escrituras.some((e) => e.clave === 'incidencia_evento.insert'
      && (e.payload as { tipo?: string }).tipo === 'aviso_jefe_fallido')).toBe(true);
  });

  it('fuera del modo mudo, el aviso fallido se dice con la verdad: "márcale DIRECTO"', async () => {
    baseFeliz();
    sendButtons.mockResolvedValue(null);
    sendText.mockResolvedValue(null);      // botones Y texto caídos: recién ahí es fallo (c4-1)
    const r = await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: 'v1', operadorId: 'o1',
      texto: 'chocamos',
      asistencia: { nivel: 'rojo', modoMudo: false },
    });
    expect(r.respuesta).toContain('NO pude avisarle a tu jefe');
    expect(r.respuesta).toContain('márcale DIRECTO');
  });

  it('la segunda llamada de la misma emergencia NO duplica el 🚨: evento + REENVÍO al jefe (92-D)', async () => {
    baseFeliz();
    respuestas[SELECT_ABIERTA] = { data: [filaAbierta()], error: null };
    const r = await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: 'v1', operadorId: 'o1',
      texto: 'sigue el choque, ya llegó la ambulancia',
      asistencia: { nivel: 'rojo', modoMudo: false },
      waMessageId: 'wamid.X2',
    });
    expect(crearIncidencia).not.toHaveBeenCalled();
    expect(sendButtons).not.toHaveBeenCalled();
    expect(escrituras.some((e) => e.clave === 'incidencia_evento.insert'
      && (e.payload as { tipo?: string }).tipo === 'mensaje_adicional')).toBe(true);
    // 92-D: la bitácora del panel NO basta — el texto se le reenvía al jefe
    // de verdad (antes se prometía "se lo paso" sin pasar nada).
    const [telJefe, textoJefe] = enviarTexto.mock.calls[0] as [string, string];
    expect(telJefe).toBe('5215550000009');
    expect(textoJefe).toContain('sigue el choque');
    expect(r.respuesta).toContain('Le acabo de pasar este mensaje a tu jefe');
  });

  it('92-D: si el reenvío al jefe falla, al chofer NO se le miente', async () => {
    baseFeliz();
    respuestas[SELECT_ABIERTA] = { data: [filaAbierta()], error: null };
    enviarTexto.mockResolvedValue({ ok: false, error: 'número inválido', codigo: 131030 });   // Meta rechazó el reenvío (no es de ventana)
    const r = await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: 'v1', operadorId: 'o1',
      texto: 'sigue el choque',
      asistencia: { nivel: 'rojo', modoMudo: false },
    });
    expect(r.respuesta).toContain('NO pude reenviárselo');
  });

  // AUDITORÍA 28, MEDIO (AG-M2): mismo candado de verdad en la rama de
  // "mensaje adicional" (no escala) — el reenvío es el aviso, aquí.
  it('92-D + AG-M2: en modo mudo, si el reenvío del mensaje adicional falla, NO dice "ya lo sabe"', async () => {
    baseFeliz();
    respuestas[SELECT_ABIERTA] = { data: [filaAbierta()], error: null };
    enviarTexto.mockResolvedValue({ ok: false, error: 'número inválido', codigo: 131030 });
    const r = await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: 'v1', operadorId: 'o1',
      texto: 'sigue el choque',
      asistencia: { nivel: 'rojo', modoMudo: true },
    });
    expect(r.respuesta).toBe('Recibido. No pude avisar a tu jefe — si puedes, márcale tú.');
  });

  it('92-D: "hay dos heridos" tras un "chocamos" sella hay_lesionados y el jefe SÍ se entera', async () => {
    baseFeliz();
    respuestas[SELECT_ABIERTA] = { data: [filaAbierta({ hay_lesionados: null })], error: null };
    await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: 'v1', operadorId: 'o1',
      texto: 'hay dos heridos',
      asistencia: { nivel: 'rojo', modoMudo: false },
    });
    // La columna sube a true (antes el parte médico moría en la bitácora)…
    expect(escrituras.some((e) => e.clave === 'incidencia.claim'
      && (e.payload as { hay_lesionados?: boolean }).hay_lesionados === true)).toBe(true);
    // …y el reenvío al jefe lo dice con todas sus letras.
    const textoJefe = String(enviarTexto.mock.calls[0][1]);
    expect(textoJefe).toContain('LESIONADOS');
  });

  // AUDITORÍA 24 · AGEN-5 / WA-4 (ALTO): el jefe que no ha escrito en 24 h
  // recibía 131047 en silencio y el chofer leía «le acabo de pasar».
  it('AGEN-5: fuera de la ventana de 24 h (131047) el reenvío sale por PLANTILLA y al chofer se le confirma', async () => {
    baseFeliz();
    respuestas[SELECT_ABIERTA] = { data: [filaAbierta()], error: null };
    enviarTexto.mockResolvedValue({ ok: false, error: 'Re-engagement message', codigo: 131047 });
    sendTemplate.mockResolvedValue({ ok: true, id: 'wamid.PLANTILLA' });
    const r = await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: 'v1', operadorId: 'o1',
      texto: 'sigue el choque',
      asistencia: { nivel: 'rojo', modoMudo: false },
    });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    const [tel, nombre, opts] = sendTemplate.mock.calls[0] as [string, string, { parametros: string[] }];
    expect(tel).toBe('5215550000009');
    expect(nombre).toBe('aviso_operacion_v1');
    expect(opts.parametros[1]).toContain('sigue reportando');
    expect(r.respuesta).toContain('Le acabo de pasar este mensaje a tu jefe');
  });

  it('AGEN-5: si NI la plantilla sale, al chofer NO se le miente', async () => {
    baseFeliz();
    respuestas[SELECT_ABIERTA] = { data: [filaAbierta()], error: null };
    enviarTexto.mockResolvedValue({ ok: false, error: 'Re-engagement message', codigo: 131047 });
    const r = await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: 'v1', operadorId: 'o1',
      texto: 'sigue el choque',
      asistencia: { nivel: 'rojo', modoMudo: false },
    });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(r.respuesta).toContain('NO pude reenviárselo');
  });

  it('92-C: un ROJO sobre un expediente ámbar ESCALA la misma fila y el jefe recibe 🚨 nuevo', async () => {
    baseFeliz();
    respuestas[SELECT_ABIERTA] = { data: [filaAbierta({ tipo: 'varado', prioridad: 'alta' })], error: null };
    const r = await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: 'v1', operadorId: 'o1',
      texto: 'chocamos, hay un herido',
      asistencia: { nivel: 'rojo', modoMudo: false },
    });
    // No una fila nueva: el MISMO expediente sube de severidad…
    expect(crearIncidencia).not.toHaveBeenCalled();
    const escalada = escrituras.find((e) => e.clave === 'incidencia.claim'
      && (e.payload as { prioridad?: string }).prioridad === 'critica');
    expect(escalada).toBeDefined();
    expect((escalada!.payload as { tipo?: string }).tipo).toBe('siniestro');
    // …el reconocimiento anterior se borra (era del incidente menor)…
    expect((escalada!.payload as { reconocida_en?: unknown }).reconocida_en).toBeNull();
    // …y el jefe recibe un 🚨 NUEVO con botón (no un eco en la bitácora).
    expect(sendButtons).toHaveBeenCalled();
    expect(r.respuesta).toContain('Subí la gravedad');
  });

  // AUDITORÍA 28, MEDIO (AG-M2): la misma verdad en la rama de ESCALADA — el
  // comentario del código ya prohibía "un ya lo sabe sin respaldo" pero el
  // modo mudo lo devolvía igual.
  it('92-C + AG-M2: escalada en modo mudo, con el aviso nuevo confirmado, dice "ya lo sabe"', async () => {
    baseFeliz();
    respuestas[SELECT_ABIERTA] = { data: [filaAbierta({ tipo: 'varado', prioridad: 'alta' })], error: null };
    const r = await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: 'v1', operadorId: 'o1',
      texto: 'nos están robando',
      asistencia: { nivel: 'rojo', modoMudo: true },
    });
    expect(sendButtons).toHaveBeenCalled();
    expect(r.respuesta).toBe('Recibido. Tu jefe ya lo sabe.');
  });

  it('92-C + AG-M2: escalada en modo mudo, si el aviso NUEVO rebota, dice la verdad (no "ya lo sabe")', async () => {
    baseFeliz();
    respuestas[SELECT_ABIERTA] = { data: [filaAbierta({ tipo: 'varado', prioridad: 'alta' })], error: null };
    sendButtons.mockResolvedValue(null);
    sendText.mockResolvedValue(null);
    const r = await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: 'v1', operadorId: 'o1',
      texto: 'nos están robando',
      asistencia: { nivel: 'rojo', modoMudo: true },
    });
    expect(r.respuesta).toBe('Recibido. No pude avisar a tu jefe — si puedes, márcale tú.');
    expect(r.respuesta).not.toContain('ya lo sabe');
  });

  it('92-C: el expediente con más de 72 h se cierra por antigüedad y el reporte nuevo abre limpio', async () => {
    baseFeliz();
    const hace4Dias = new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString();
    respuestas[SELECT_ABIERTA] = { data: [filaAbierta({ tipo: 'varado', prioridad: 'alta', abierta_en: hace4Dias })], error: null };
    await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: 'v1', operadorId: 'o1',
      texto: 'chocamos con un trailer',
      asistencia: { nivel: 'rojo', modoMudo: false },
    });
    // El varado del lunes que nadie resolvió NO se traga el choque del
    // viernes: se resuelve con nota y el choque abre SU incidencia con SU 🚨.
    expect(escrituras.some((e) => e.clave === 'incidencia.claim'
      && (e.payload as { estado?: string }).estado === 'resuelta')).toBe(true);
    expect(crearIncidencia).toHaveBeenCalledWith('t1', expect.objectContaining({ tipo: 'siniestro', prioridad: 'critica' }));
    expect(sendButtons).toHaveBeenCalled();
  });

  it('92-E: si la carrera la ganó otro webhook (unique de la 0201), el perdedor relee y anota — sin segundo 🚨', async () => {
    baseFeliz();
    // Primer read: nada abierto. El insert rebota con el unique del índice…
    crearIncidencia.mockRejectedValueOnce(new Error('crearIncidencia: duplicate key value violates unique constraint "incidencia_asistencia_abierta_unica"'));
    let lecturas = 0;
    const conCarrera = { ...respuestas };
    respuestas = new Proxy(conCarrera, {
      get(obj, clave: string) {
        if (clave === SELECT_ABIERTA) {
          lecturas += 1;
          // …y la relectura encuentra el expediente que el ganador abrió.
          return lecturas === 1
            ? { data: [], error: null }
            : { data: [filaAbierta()], error: null };
        }
        return obj[clave];
      },
    }) as typeof respuestas;
    const r = await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: 'v1', operadorId: 'o1',
      texto: 'chocamos feo',
      asistencia: { nivel: 'rojo', modoMudo: false },
    });
    expect(sendButtons).not.toHaveBeenCalled();   // el 🚨 ya lo mandó el ganador
    expect(escrituras.some((e) => e.clave === 'incidencia_evento.insert'
      && (e.payload as { tipo?: string }).tipo === 'mensaje_adicional')).toBe(true);
    expect(r.respuesta).not.toContain('No pude registrar');
  });

  it('sin viaje, la incidencia se ata al operador (punto C): la búsqueda no revienta y crea', async () => {
    baseFeliz();
    await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: null, operadorId: 'o1',
      texto: 'chocamos saliendo del patio',
      asistencia: { nivel: 'rojo', modoMudo: false },
    });
    expect(crearIncidencia).toHaveBeenCalledWith('t1', expect.objectContaining({ viajeId: null, operadorId: 'o1' }));
  });

  it('si no se puede saber si ya hay abierta, NO se crea a ciegas y la salida no depende de nosotros', async () => {
    baseFeliz();
    respuestas[SELECT_ABIERTA] = { data: null, error: { message: 'timeout' } };
    const r = await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: 'v1', operadorId: 'o1',
      texto: 'chocamos',
      asistencia: { nivel: 'rojo', modoMudo: false },
    });
    expect(crearIncidencia).not.toHaveBeenCalled();
    expect(r.respuesta).toContain('márcale DIRECTO');
  });
});

// ── El lado del jefe ───────────────────────────────────────────────────────

describe('atenderReconocimientoAsistencia', () => {
  it('firma atómica y avisa al chofer que ya van', async () => {
    respuestas = {
      'incidencia.claim': { data: [{ id: INC, tipo: 'siniestro', viaje_id: 'v1', operador_id: 'o1' }], error: null },
      'incidencia_evento.insert': { error: null },
      'operador.select:telefono': { data: { telefono: '5219990001111' }, error: null },
    };
    sendText.mockResolvedValue('wamid.OK');
    const r = await atenderReconocimientoAsistencia(JEFE, `asi_ok:${INC}`);
    expect(r).toContain('la estás atendiendo ✅');
    expect(r).toContain('le avisé al chofer');
    expect(sendText).toHaveBeenCalledWith('5219990001111', expect.stringContaining('ayuda en camino'));
    const claim = escrituras.find((e) => e.clave === 'incidencia.claim');
    expect((claim?.payload as { reconocida_por?: string }).reconocida_por).toBe('u-jefe');
  });

  it('el segundo tap recibe la verdad, no una re-firma', async () => {
    respuestas = {
      'incidencia.claim': { data: [], error: null },
      'incidencia.select:reconocida_en': { data: { reconocida_en: '2026-08-26T00:00:00Z' }, error: null },
    };
    const r = await atenderReconocimientoAsistencia(JEFE, `asi_ok:${INC}`);
    expect(r).toContain('ya la está atendiendo');
    expect(sendText).not.toHaveBeenCalled();
  });

  it('en robo/violencia el chofer NO recibe nada — el modo mudo no termina con un botón', async () => {
    respuestas = {
      'incidencia.claim': { data: [{ id: INC, tipo: 'robo', viaje_id: 'v1', operador_id: 'o1' }], error: null },
      'incidencia_evento.insert': { error: null },
    };
    const r = await atenderReconocimientoAsistencia(JEFE, `asi_ok:${INC}`);
    expect(sendText).not.toHaveBeenCalled();
    expect(r).toContain('NO le escribimos nada');
  });

  it('el rol sin mando no reconoce, y un texto ajeno devuelve null', async () => {
    expect(await atenderReconocimientoAsistencia({ ...JEFE, rol: 'contador' }, `asi_ok:${INC}`))
      .toContain('Tu rol no atiende');
    expect(await atenderReconocimientoAsistencia(JEFE, 'buenos días')).toBeNull();
  });
});

// ── El lado de la oficina ──────────────────────────────────────────────────

describe('atenderAsistenciaOficina', () => {
  it('un ROJO del dueño abre incidencia de flota (sin viaje ni operador) con prioridad crítica', async () => {
    baseFeliz();
    const r = await atenderAsistenciaOficina(JEFE, 'chocamos saliendo de la bodega', { nivel: 'rojo', modoMudo: false });
    expect(crearIncidencia).toHaveBeenCalledWith('t1', expect.objectContaining({ tipo: 'siniestro', prioridad: 'critica' }));
    expect(r).toContain('crítica');
    expect(r).toContain('911');
  });

  it('el ámbar de oficina NO es de este circuito (el analista puede con "el camión no arranca")', async () => {
    expect(await atenderAsistenciaOficina(JEFE, 'no arranca la 12', { nivel: 'ambar', modoMudo: false })).toBeNull();
  });
});

// ── AUDITORÍA FABLE CICLO 4 ────────────────────────────────────────────────

describe('c4-1: el 🚨 JAMÁS se pierde por la cascada', () => {
  it('la cascada recibe un presupuesto y el cuerpo con botones nunca rebasa 1024', async () => {
    baseFeliz();
    // Una cascada que IGNORA su presupuesto (el peor caso): el cinturón la
    // tira y el aviso sale igual, dentro del límite de Meta.
    recomendacionCascada.mockResolvedValue(`\nA quién marcarle:\n${'· Grúas de nombre larguísimo — 5215550000001\n'.repeat(30)}`);
    const r = await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: 'v1', operadorId: 'op1',
      texto: `chocamos y hay heridos ${'x'.repeat(220)}`,
      asistencia: { nivel: 'rojo', modoMudo: false },
    });
    expect(r.atendida).toBe(true);
    // El presupuesto viajó como 5º argumento y es lo que queda de 1024.
    const args = recomendacionCascada.mock.calls[0] as unknown[];
    expect(typeof args[4]).toBe('number');
    expect(args[4] as number).toBeGreaterThan(0);
    expect(args[4] as number).toBeLessThan(1024);
    // Y el cuerpo mandado cupo — la cascada desobediente no costó el aviso.
    const cuerpo = sendButtons.mock.calls[0][1] as string;
    expect(cuerpo.length).toBeLessThanOrEqual(1024);
    expect(cuerpo).toContain('chocamos');
  });

  it('si los botones fallan, el aviso viaja en texto plano con las salidas dichas', async () => {
    baseFeliz();
    recomendacionCascada.mockResolvedValue(null);
    sendButtons.mockResolvedValue(null);   // Meta rechazó los botones
    sendText.mockResolvedValue('wamid.TXT');
    const r = await atenderAsistenciaChofer({
      tenantId: 't1', viajeId: 'v1', operadorId: 'op1',
      texto: 'chocamos en la carretera',
      asistencia: { nivel: 'rojo', modoMudo: false },
    });
    // El chofer recibe el "tu jefe ya tiene tu reporte" — porque lo tiene.
    expect(r.respuesta).toContain('Tu jefe ya tiene tu reporte');
    const alJefe = sendText.mock.calls.find((c) => c[0] === '5215550000009');
    expect(alJefe).toBeTruthy();
    expect(alJefe![1] as string).toContain('Mesa de control');
  });
});

describe('c4-2: cerrarCoordinacionesDeIncidencia', () => {
  it('cierra las vivas, avisa SOLO al que sí fue contactado y deja la bitácora', async () => {
    respuestas = {
      'coordinacion_proveedor.claim': {
        data: [
          { id: 'c1', estado: 'descartada', proveedor_nombre: 'Grúas A', proveedor_telefono: '525510000001', contactado_en: '2026-08-27T01:00:00Z' },
          { id: 'c2', estado: 'descartada', proveedor_nombre: 'Grúas B', proveedor_telefono: '525510000002', contactado_en: null },
        ],
        error: null,
      },
      'incidencia_evento.insert': { error: null },
    };
    sendText.mockResolvedValue('wamid.TXT');
    await cerrarCoordinacionesDeIncidencia('t1', INC, 'resuelta_desde_mesa');
    // Al contactado se le dice que la emergencia quedó atendida; al de
    // pendiente_plantilla (nunca le escribimos) no se le inicia conversación.
    expect(sendText).toHaveBeenCalledTimes(1);
    expect((sendText.mock.calls[0] as [string, string])[0]).toBe('525510000001');
    expect((sendText.mock.calls[0] as [string, string])[1]).toContain('quedó atendida');
  });

  it('el fallo de lectura no lanza — cerrar el expediente no puede fallar por su limpieza', async () => {
    respuestas = { 'coordinacion_proveedor.claim': { data: null, error: { message: 'timeout' } } };
    await expect(cerrarCoordinacionesDeIncidencia('t1', INC, 'x')).resolves.toBeUndefined();
    expect(sendText).not.toHaveBeenCalled();
  });
});

describe('c4-6: anclarUbicacionIncidencia', () => {
  it('el pin se ancla al expediente vivo del chofer y queda en la bitácora', async () => {
    respuestas = {
      'incidencia.claim': { data: [{ id: INC }], error: null },
      'incidencia_evento.insert': { error: null },
    };
    const id = await anclarUbicacionIncidencia('t1', 'op1', 19.4326, -99.1332);
    expect(id).toBe(INC);
    const ancla = escrituras.find((e) => e.clave === 'incidencia.claim');
    expect(ancla!.payload).toEqual({ lat: 19.4326, lng: -99.1332 });
  });

  it('sin expediente vivo devuelve null y no inventa nada', async () => {
    respuestas = { 'incidencia.claim': { data: [], error: null } };
    expect(await anclarUbicacionIncidencia('t1', 'op1', 19.4, -99.1)).toBeNull();
  });

  it('el fallo de base devuelve null — el flujo de posición no depende del ancla', async () => {
    respuestas = { 'incidencia.claim': { data: null, error: { message: 'timeout' } } };
    expect(await anclarUbicacionIncidencia('t1', 'op1', 19.4, -99.1)).toBeNull();
  });
});
