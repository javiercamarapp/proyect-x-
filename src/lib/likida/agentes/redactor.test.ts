import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

// ═══════════════════════════════════════════════════════════════════════════
// EL REDACTOR (C5) — los contratos que el código debe sostener:
//  · Su ÚNICA salida es encolarPieza — jamás toca el canal de envío.
//  · Apagado (kill switch) o con historial ilegible: NO gasta en el modelo.
//  · La cadencia se lee ANTES de redactar (censo finito) y una pieza
//    pendiente del mismo prospecto frena la duplicada.
//  · La variante A va LISTA PARA SALIR en el cuerpo; B/C y los datos usados
//    viajan en `fuentes`. Sin correo capturado, el AVISO viaja con la pieza.
// ═══════════════════════════════════════════════════════════════════════════

const respuestas = new Map<string, Array<{ data: unknown; error: { message: string } | null }>>();
function builder(tabla: string) {
  const responder = () => {
    const cola = respuestas.get(tabla);
    return cola && cola.length > 0 ? cola.shift()! : { data: [], error: null };
  };
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: () => b, eq: () => b, is: () => b, gte: () => b, limit: () => b,
    maybeSingle: () => b, order: () => b, range: () => b, insert: () => b,
    then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve().then(responder).then(res, rej),
  });
  return b;
}
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: (t: string) => builder(t) }) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

let apagado = false;
vi.mock('../interruptores', () => ({ estaApagado: async () => apagado }));

// La salida REALISTA del modelo: desde la primera pasada real del runner el
// Redactor pide JSON por schema, no markdown parseado con regex.
const SALIDA_MODELO = {
  variante_a: {
    asunto: 'El cierre del viaje, sin liquidador',
    cuerpo: 'Buen día. Le escribo de Likida: trabajamos el cierre administrativo del viaje.\n¿Le vienen bien 15 minutos el jueves?',
  },
  variante_b: {
    asunto: 'El IEPS del diésel y el peaje',
    cuerpo: 'Buen día. ¿Hoy están recuperando el IEPS del diésel y el 50% del peaje?\n¿Le vienen bien 15 minutos el jueves?',
  },
  variante_c: 'No aplica: la variante C solo se usa después de un sí.',
  datos_usados: 'ninguno específico de esta empresa.',
};
const respuestaModelo = (data: unknown) => ({
  data, raw: JSON.stringify(data), model: 'prueba', tokensIn: 100, tokensOut: 200, cost: 0.001,
});

// La réplica de los errores de `openrouter` (el módulo entero está mockeado,
// así que la clase del `instanceof` del redactor es ESTA — misma forma que la
// real: mensaje, raw y usage).
class StructuredError extends Error {
  constructor(
    message: string,
    public cause?: unknown,
    public raw?: string,
    public usage?: { model: string; tokensIn: number; tokensOut: number; cost: number },
  ) { super(message); this.name = 'StructuredError'; }
}
class TruncatedError extends StructuredError {
  constructor(message: string, raw?: string, usage?: { model: string; tokensIn: number; tokensOut: number; cost: number }) {
    super(message, undefined, raw, usage); this.name = 'TruncatedError';
  }
}

const generateStructured = vi.fn(async (..._a: unknown[]) => respuestaModelo(SALIDA_MODELO));
vi.mock('@/lib/llm/openrouter', () => ({
  generateStructured: (...a: unknown[]) => generateStructured(...a),
  StructuredError,
}));

const encolarPieza = vi.fn(async (..._a: unknown[]) => 'pieza-1');
vi.mock('./cola', async () => {
  const { DatoInvalido: DI } = await import('../errores');
  return {
    encolarPieza: (...a: unknown[]) => encolarPieza(...(a as [])),
    // La réplica del verificador (el real vive en cola.ts desde c5-14 y
    // tiene sus pruebas allá): mismos guardarraíles, mismo tipo de error.
    verificarFormatoCampana: (texto: string) => {
      if (/clientes?\s+reales/i.test(texto)) throw new DI('El correo dice "clientes reales" — Pieza descartada.');
      if (texto.includes('—')) throw new DI('El correo trae guion largo (—) — Pieza descartada.');
      // AGB-2: réplica del candado de tracción — TRACCION_PUBLICABLE vacía.
      for (const nombre of ['Grupo GAL', 'Transportes Innovativos', 'Innovativos']) {
        if (texto.includes(nombre)) throw new DI(`El correo nombra a "${nombre}" como tracción — no autorizado. Pieza descartada.`);
      }
    },
  };
});
const registrarCorrida = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('./corridas', () => ({ registrarCorrida: (...a: unknown[]) => registrarCorrida(...a) }));

const { redactarCorreoFrio, variantesDeSalida, primerNombreDelContacto, sustituirMarcador, pasaCompuertaIcp } = await import('./redactor');
const CONTEXTO = { tenantId: 'tenant-redactor-a', runId: '00000000-0000-4000-8000-000000000001' };
const { DatoInvalido } = await import('../errores');

const PROSPECTO = {
  id: 'pr-1', empresa: 'Transportes X', contacto_nombre: null, correo: 'c@x.mx',
  ciudad: 'Apodaca', estado: 'nuevo', fuente: 'censo', notas: null,
  // AGB-6: SCIAN 484 = "Autotransporte de carga" (INEGI) — pasa la compuerta
  // de ICP de por sí, para que el resto de este archivo (que prueba OTRA
  // cosa) no tenga que preocuparse por ella. La compuerta en sí tiene sus
  // propias pruebas más abajo con perfiles que NO la pasan.
  scian: '484110', similitud_icp_pct: null,
};

beforeEach(() => {
  respuestas.clear();
  apagado = false;
  generateStructured.mockClear();
  encolarPieza.mockClear();
  registrarCorrida.mockClear();
});

describe('variantesDeSalida — la frontera entre el modelo y la cola', () => {
  it('toma A/B/C y los datos usados del schema', () => {
    const v = variantesDeSalida(SALIDA_MODELO, JSON.stringify(SALIDA_MODELO));
    expect(v.a.asunto).toBe('El cierre del viaje, sin liquidador');
    expect(v.a.cuerpo).toContain('cierre administrativo');
    expect(v.b?.asunto).toContain('IEPS');
    expect(v.c).toContain('No aplica');
    expect(v.datosUsados).toContain('ninguno específico');
  });

  it('B/C ausentes son null, no un hueco: la pieza sale igual con solo la A', () => {
    const v = variantesDeSalida(
      { ...SALIDA_MODELO, variante_b: null, variante_c: null, datos_usados: null },
      '{}',
    );
    expect(v.b).toBeNull();
    expect(v.c).toBeNull();
    expect(v.datosUsados).toBeNull();
    expect(v.a.cuerpo).toContain('cierre administrativo');
  });

  // ── PRIMERA PASADA REAL DEL RUNNER (18:03): los 3 fallos del Redactor ──
  it('sin variante A legible, LANZA — y el error trae el texto EXACTO del modelo', () => {
    const crudo = '{"variante_a":{"asunto":"","cuerpo":""}}';
    expect(() => variantesDeSalida(
      { ...SALIDA_MODELO, variante_a: { asunto: '', cuerpo: '' } }, crudo,
    )).toThrow(DatoInvalido);
    expect(() => variantesDeSalida(
      { ...SALIDA_MODELO, variante_a: { asunto: '', cuerpo: '' } }, crudo,
    )).toThrow(crudo);
  });

  it('un cuerpo en blanco cumple el schema pero NO se encola: correo vacío no es correo', () => {
    expect(() => variantesDeSalida(
      { ...SALIDA_MODELO, variante_a: { asunto: 'Un asunto', cuerpo: '   \n  ' } }, 'crudo-del-modelo',
    )).toThrow(/sin variante A legible/);
  });

  it('el modelo que no devolvió NADA se dice con palabras, no con un error mudo', () => {
    expect(() => variantesDeSalida(
      { ...SALIDA_MODELO, variante_a: { asunto: '', cuerpo: '' } }, '',
    )).toThrow(/vacío — el modelo no devolvió texto/);
  });
});

describe('redactarCorreoFrio', () => {
  it('sin tenant explícito falla cerrado antes de leer prospectos o llamar al modelo', async () => {
    await expect(redactarCorreoFrio('pr-1', 'Javier')).rejects.toThrow(/tenant requerido/);
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it('apagado (kill switch): no gasta en el modelo ni encola', async () => {
    apagado = true;
    await expect(redactarCorreoFrio('pr-1', 'Javier', 'manual', CONTEXTO)).rejects.toThrow(/apagado/);
    expect(generateStructured).not.toHaveBeenCalled();
    expect(encolarPieza).not.toHaveBeenCalled();
  });

  it('contactado hace <48h: la cadencia frena ANTES del modelo (censo finito)', async () => {
    respuestas.set('prospecto', [{ data: PROSPECTO, error: null }]);
    respuestas.set('prospecto_contacto', [{ data: [{ ocurrio_en: 'ayer' }], error: null }]);
    await expect(redactarCorreoFrio('pr-1', 'Javier', 'manual', CONTEXTO)).rejects.toThrow(/48 horas/);
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it('con el historial ILEGIBLE no se redacta — fail closed, como el envío', async () => {
    respuestas.set('prospecto', [{ data: PROSPECTO, error: null }]);
    respuestas.set('prospecto_contacto', [{ data: null, error: { message: 'db down' } }]);
    await expect(redactarCorreoFrio('pr-1', 'Javier', 'manual', CONTEXTO)).rejects.toThrow(/historial/);
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it('una pieza PENDIENTE del mismo prospecto frena la duplicada', async () => {
    respuestas.set('prospecto', [{ data: PROSPECTO, error: null }]);
    respuestas.set('prospecto_contacto', [{ data: [], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: [{ id: 'pieza-vieja' }], error: null }]);
    await expect(redactarCorreoFrio('pr-1', 'Javier', 'manual', CONTEXTO)).rejects.toThrow(/esperando aprobación/);
    expect(generateStructured).not.toHaveBeenCalled();
  });

  // AUDITORÍA 21 (agéntico, MEDIO): la lectura previa (arriba) basta contra
  // UN disparador, no contra dos en carrera — el botón del tablero y el cron
  // nivel 2 pueden pasar la lectura de `pendientes` a la vez, ambas ven cero,
  // y las dos intentan `encolarPieza`. El índice único parcial de la 0270
  // (`cola_correo_frio_por_prospecto`) es el árbitro real: la perdedora
  // rebota con 23505 y debe verse en pantalla EXACTAMENTE como el freno de
  // lectura de arriba — no como un error crudo de Postgres.
  it('carrera ganada por otra invocación: 23505 del índice 0270 se traduce al MISMO mensaje del freno', async () => {
    respuestas.set('prospecto', [{ data: PROSPECTO, error: null }]);
    respuestas.set('prospecto_contacto', [{ data: [], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: [], error: null }]); // la lectura no vio nada pendiente
    encolarPieza.mockRejectedValueOnce(
      new Error('encolarPieza: duplicate key value violates unique constraint "cola_correo_frio_por_prospecto"'),
    );
    await expect(redactarCorreoFrio('pr-1', 'Javier', 'manual', CONTEXTO)).rejects.toThrow(/esperando aprobación/);
    expect(registrarCorrida).toHaveBeenCalledWith(null, 'redactor', expect.objectContaining({
      estado: 'fallo',
      error: expect.stringMatching(/esperando aprobación/),
    }));
  });

  it.each(['cerrado', 'perdido', 'won', 'lost'])('a un %s no se le redacta correo frío', async (estado) => {
    respuestas.set('prospecto', [{ data: { ...PROSPECTO, estado }, error: null }]);
    await expect(redactarCorreoFrio('pr-1', 'Javier', 'manual', CONTEXTO)).rejects.toThrow(new RegExp(estado));
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it('AGB-6: un prospecto del censo sin SCIAN de autotransporte, fuente vetada ni similitud ICP se rechaza ANTES del modelo', async () => {
    respuestas.set('prospecto', [{ data: { ...PROSPECTO, scian: null, fuente: 'censo', similitud_icp_pct: null }, error: null }]);
    await expect(redactarCorreoFrio('pr-1', 'Javier', 'manual', CONTEXTO)).rejects.toThrow(/compuerta de ICP/);
    expect(generateStructured).not.toHaveBeenCalled();
    expect(encolarPieza).not.toHaveBeenCalled();
  });

  it('AGB-6: un SCIAN fuera de 48-49 (p. ej. restaurantes) tampoco pasa', async () => {
    respuestas.set('prospecto', [{ data: { ...PROSPECTO, scian: '722511', fuente: 'censo', similitud_icp_pct: null }, error: null }]);
    await expect(redactarCorreoFrio('pr-1', 'Javier', 'manual', CONTEXTO)).rejects.toThrow(/compuerta de ICP/);
  });

  it('AGB-6: una similitud ICP alta (scorer) basta aunque el SCIAN no conste', async () => {
    respuestas.set('prospecto', [{ data: { ...PROSPECTO, scian: null, fuente: 'censo', similitud_icp_pct: 75 }, error: null }]);
    respuestas.set('prospecto_contacto', [{ data: [], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: [], error: null }]);
    const r = await redactarCorreoFrio('pr-1', 'Javier', 'manual', CONTEXTO);
    expect(r.piezaId).toBe('pieza-1');
  });

  it('AGB-6: una fuente ya vetada a mano (p. ej. "manual") basta aunque falte el SCIAN', async () => {
    respuestas.set('prospecto', [{ data: { ...PROSPECTO, scian: null, fuente: 'manual', similitud_icp_pct: null }, error: null }]);
    respuestas.set('prospecto_contacto', [{ data: [], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: [], error: null }]);
    const r = await redactarCorreoFrio('pr-1', 'Javier', 'manual', CONTEXTO);
    expect(r.piezaId).toBe('pieza-1');
  });

  it('el camino feliz: encola la variante A como cuerpo, B/C en fuentes, agente redactor — y corrida ok', async () => {
    respuestas.set('prospecto', [{ data: PROSPECTO, error: null }]);
    respuestas.set('prospecto_contacto', [{ data: [], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: [], error: null }]);
    const r = await redactarCorreoFrio('pr-1', 'Javier', 'manual', CONTEXTO);
    // 0217: el asunto de la campaña se IMPONE en código — el del modelo no sale.
    expect(r).toMatchObject({ piezaId: 'pieza-1', asunto: 'Automatizar la liquidación de viajes, antes de contratar para el puesto', aviso: null });

    expect(encolarPieza).toHaveBeenCalledTimes(1);
    const pieza = encolarPieza.mock.calls[0][0] as {
      tipo: string; prioridad: string; agente: string; prospectoId: string;
      titulo: string; cuerpo: string; fuentes: Record<string, unknown>;
    };
    expect(pieza).toMatchObject({ tipo: 'correo_frio', prioridad: 'normal', agente: 'redactor', prospectoId: 'pr-1' });
    expect(pieza.cuerpo).toContain('cierre administrativo');
    expect(pieza.cuerpo).not.toContain('Variante B');
    expect(pieza.fuentes.variante_b).toBeTruthy();
    expect(registrarCorrida).toHaveBeenCalledWith(null, 'redactor', expect.objectContaining({ estado: 'ok' }));
    expect(generateStructured).toHaveBeenCalledWith(expect.objectContaining({ budget: expect.objectContaining({ tenantId: 'tenant-redactor-a' }) }));
  });

  it('sin correo capturado: la pieza entra IGUAL pero el aviso viaja con ella', async () => {
    respuestas.set('prospecto', [{ data: { ...PROSPECTO, correo: null }, error: null }]);
    respuestas.set('prospecto_contacto', [{ data: [], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: [], error: null }]);
    const r = await redactarCorreoFrio('pr-1', 'Javier', 'manual', CONTEXTO);
    expect(r.aviso).toMatch(/no tiene correo capturado/);
    const pieza = encolarPieza.mock.calls[0][0] as { fuentes: Record<string, unknown> };
    expect(String(pieza.fuentes.aviso)).toMatch(/correo/);
  });

  it('el modelo caído: corrida en fallo, error de pantalla, nada encolado', async () => {
    respuestas.set('prospecto', [{ data: PROSPECTO, error: null }]);
    respuestas.set('prospecto_contacto', [{ data: [], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: [], error: null }]);
    generateStructured.mockRejectedValueOnce(new Error('timeout'));
    await expect(redactarCorreoFrio('pr-1', 'Javier', 'manual', CONTEXTO)).rejects.toThrow(/no pudo escribir/);
    expect(encolarPieza).not.toHaveBeenCalled();
    expect(registrarCorrida).toHaveBeenCalledWith(null, 'redactor', expect.objectContaining({ estado: 'fallo' }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 19 (legal C2, CRÍTICO) — el aviso de privacidad del Cerebro de
// ventas promete «tu nombre no sale de Likida: la ficha que recibe el modelo
// lleva un marcador en lugar de tu nombre... tu nombre de pila se pone
// después, dentro de Likida» (privacidad.ts:757). El código mandaba el
// nombre COMPLETO tal cual al modelo — el mecanismo del aviso nunca existió.
// ═══════════════════════════════════════════════════════════════════════════
describe('pasaCompuertaIcp — AGB-6, PURA', () => {
  it('SCIAN 48 o 49 pasa', () => {
    expect(pasaCompuertaIcp({ scian: '484110', fuente: 'censo', similitudIcpPct: null })).toBe(true);
    expect(pasaCompuertaIcp({ scian: '493', fuente: 'censo', similitudIcpPct: null })).toBe(true);
  });
  it('sin señal alguna, NO pasa (fail closed)', () => {
    expect(pasaCompuertaIcp({ scian: null, fuente: 'censo', similitudIcpPct: null })).toBe(false);
    expect(pasaCompuertaIcp({ scian: '', fuente: 'censo', similitudIcpPct: null })).toBe(false);
  });
  it('un SCIAN de otro giro no pasa aunque no esté vacío', () => {
    expect(pasaCompuertaIcp({ scian: '722511', fuente: 'censo', similitudIcpPct: null })).toBe(false);
  });
  it('una fuente vetada pasa aunque el SCIAN falte', () => {
    for (const fuente of ['canacar', 'aaag', 'manual', 'landing']) {
      expect(pasaCompuertaIcp({ scian: null, fuente, similitudIcpPct: null })).toBe(true);
    }
  });
  it('similitud_icp_pct ≥ 60 pasa; por debajo, no', () => {
    expect(pasaCompuertaIcp({ scian: null, fuente: 'censo', similitudIcpPct: 60 })).toBe(true);
    expect(pasaCompuertaIcp({ scian: null, fuente: 'censo', similitudIcpPct: 59 })).toBe(false);
  });
});

describe('primerNombreDelContacto — el ÚNICO dato que se sustituye de vuelta', () => {
  it('toma solo la primera palabra — "de pila", no el nombre completo', () => {
    expect(primerNombreDelContacto('Juan Pérez López')).toBe('Juan');
  });
  it('sin contacto capturado, null — no hay nada que sustituir', () => {
    expect(primerNombreDelContacto(null)).toBeNull();
  });
  it('espacios sueltos no cuentan como nombre', () => {
    expect(primerNombreDelContacto('   ')).toBeNull();
  });
});

describe('sustituirMarcador — el modelo nunca ve el nombre real', () => {
  it('con nombre: reemplaza cada aparición del marcador', () => {
    expect(sustituirMarcador('Hola {{NOMBRE}}, ¿cómo va {{NOMBRE}}?', 'Juan'))
      .toBe('Hola Juan, ¿cómo va Juan?');
  });
  it('sin nombre: limpia el saludo en vez de dejar el marcador visible', () => {
    expect(sustituirMarcador('Hola {{NOMBRE}}, le escribo de Likida.', null))
      .toBe('Hola, le escribo de Likida.');
  });
  it('sin nombre y sin coma: el marcador se retira igual, sin dejarlo huérfano', () => {
    expect(sustituirMarcador('Buen día {{NOMBRE}} espero le sirva.', null))
      .toBe('Buen día  espero le sirva.');
  });
});

describe('redactarCorreoFrio — el modelo NUNCA ve el nombre real del contacto', () => {
  const SALIDA_CON_MARCADOR = {
    variante_a: {
      asunto: 'El cierre del viaje, sin liquidador',
      cuerpo: 'Hola {{NOMBRE}}, le escribo de Likida sobre el cierre administrativo del viaje.\n¿Le vienen bien 15 minutos el jueves?',
    },
    variante_b: {
      asunto: 'El IEPS del diésel y el peaje',
      cuerpo: 'Hola {{NOMBRE}}, ¿hoy están recuperando el IEPS del diésel?\n¿Le vienen bien 15 minutos el jueves?',
    },
    variante_c: 'No aplica: la variante C solo se usa después de un sí.',
    datos_usados: 'ninguno específico de esta empresa.',
  };

  it('el dossier que recibe el modelo lleva el marcador, NUNCA el nombre real', async () => {
    respuestas.set('prospecto', [{ data: { ...PROSPECTO, contacto_nombre: 'Juan Pérez López' }, error: null }]);
    respuestas.set('prospecto_contacto', [{ data: [], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: [], error: null }]);
    generateStructured.mockResolvedValueOnce(respuestaModelo(SALIDA_CON_MARCADOR));

    await redactarCorreoFrio('pr-1', 'Javier', 'manual', CONTEXTO);

    const llamada = generateStructured.mock.calls[0][0] as { messages: Array<{ content: string }> };
    const dossierEnviado = llamada.messages[0].content;
    expect(dossierEnviado).toContain('{{NOMBRE}}');
    expect(dossierEnviado).not.toContain('Juan');
    expect(dossierEnviado).not.toContain('Pérez');
  });

  it('la pieza encolada (la que un humano aprueba) SÍ trae el nombre de pila real, sustituido después', async () => {
    respuestas.set('prospecto', [{ data: { ...PROSPECTO, contacto_nombre: 'Juan Pérez López' }, error: null }]);
    respuestas.set('prospecto_contacto', [{ data: [], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: [], error: null }]);
    generateStructured.mockResolvedValueOnce(respuestaModelo(SALIDA_CON_MARCADOR));

    await redactarCorreoFrio('pr-1', 'Javier', 'manual', CONTEXTO);

    const pieza = encolarPieza.mock.calls[0][0] as { titulo: string; cuerpo: string; fuentes: { variante_b: { cuerpo: string } | null } };
    expect(pieza.cuerpo).toContain('Hola Juan,');
    expect(pieza.cuerpo).not.toContain('{{NOMBRE}}');
    expect(pieza.fuentes.variante_b?.cuerpo).toContain('Hola Juan,');
  });

  it('sin contacto capturado: el dossier dice "no capturado" y no hay marcador que sustituir', async () => {
    respuestas.set('prospecto', [{ data: PROSPECTO, error: null }]); // contacto_nombre: null
    respuestas.set('prospecto_contacto', [{ data: [], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: [], error: null }]);

    await redactarCorreoFrio('pr-1', 'Javier', 'manual', CONTEXTO);

    const llamada = generateStructured.mock.calls[0][0] as { messages: Array<{ content: string }> };
    expect(llamada.messages[0].content).toContain('Contacto: no capturado');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // AUDITORÍA 19, CRÍTICO (legal C2 / C.18), sexta pasada: el nombre se
  // cerró con el marcador y las NOTAS siguieron saliendo crudas por la misma
  // puerta — con el correo, el teléfono y el nombre que un vendedor (o el
  // formulario público de /api/lead, vía la mezcla que anota lo rechazado)
  // hubiera dejado en `prospecto.notas`. Estas pruebas fijan la puerta única:
  // lo que llega al modelo pasó por `notasSinPersona`.
  // ═══════════════════════════════════════════════════════════════════════
  it('las notas del vendedor llegan al modelo SIN correo, SIN teléfono y SIN el nombre del contacto', async () => {
    respuestas.set('prospecto', [{
      data: {
        ...PROSPECTO,
        contacto_nombre: 'Ing. Ramón Treviño',
        notas: 'Hablar con Ramón Treviño al 8112345678 o a ramon.trevino@perla.mx; urge antes del cierre.',
      },
      error: null,
    }]);
    respuestas.set('prospecto_contacto', [{ data: [], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: [], error: null }]);
    generateStructured.mockResolvedValueOnce(respuestaModelo(SALIDA_CON_MARCADOR));

    await redactarCorreoFrio('pr-1', 'Javier', 'manual', CONTEXTO);

    const llamada = generateStructured.mock.calls[0][0] as { messages: Array<{ content: string }> };
    const dossierEnviado = llamada.messages[0].content;
    // Lo que la nota decía de la persona, fuera:
    expect(dossierEnviado).not.toContain('8112345678');
    expect(dossierEnviado).not.toContain('ramon.trevino@perla.mx');
    expect(dossierEnviado).not.toMatch(/Ramón|Trevi/);
    // Lo que la nota decía del NEGOCIO, intacto — la puerta reduce, no borra:
    expect(dossierEnviado).toContain('urge antes del cierre');
    // Y el nombre dentro de la nota quedó como EL MISMO marcador del saludo,
    // para que `sustituirMarcador` lo resuelva de vuelta si el modelo lo copia.
    expect(dossierEnviado).toContain('Notas del vendedor:');
    expect(dossierEnviado).toContain('{{NOMBRE}}');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EL FORMATO DE CAMPAÑA (0217) — los guardarraíles cazados EN VIVO en la
// campaña real, ahora código: jamás "clientes reales" (nadie ha firmado),
// jamás guion largo, y el asunto único de la campaña se impone tras el parseo.
// ═══════════════════════════════════════════════════════════════════════════
describe('verificarFormatoCampana — los guardarraíles son código, no prompt', () => {
  it('rechaza "clientes reales" — ninguna empresa ha firmado', async () => {
    const { verificarFormatoCampana } = await import('./redactor');
    expect(() => verificarFormatoCampana('Trabajamos con clientes reales como GAL.')).toThrow(DatoInvalido);
  });

  it('rechaza el guion largo', async () => {
    const { verificarFormatoCampana } = await import('./redactor');
    expect(() => verificarFormatoCampana('Liquidamos viajes — sin liquidador.')).toThrow(/guion largo/);
  });

  it('deja pasar la frase permitida sin nombrar a nadie ("en pláticas con transportistas del centro y norte del país")', async () => {
    const { verificarFormatoCampana } = await import('./redactor');
    expect(() => verificarFormatoCampana('Estamos en pláticas con transportistas del centro y norte del país.')).not.toThrow();
  });

  it('AGB-2: rechaza nombrar al prospecto del piloto o a Grupo GAL como tracción, aunque la plática sea real', async () => {
    const { verificarFormatoCampana } = await import('./redactor');
    expect(() => verificarFormatoCampana('Estamos en pláticas con transportistas como Grupo GAL y Transportes Innovativos.')).toThrow(/tracción/);
    expect(() => verificarFormatoCampana('Ya trabajamos con Transportes Innovativos.')).toThrow(DatoInvalido);
  });

  it('un correo del modelo que viole el formato NO entra a la cola y la corrida queda en fallo', async () => {
    respuestas.set('prospecto', [{ data: PROSPECTO, error: null }]);
    respuestas.set('prospecto_contacto', [{ data: [], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: [], error: null }]);
    generateStructured.mockResolvedValueOnce(respuestaModelo({
      ...SALIDA_MODELO,
      variante_a: { ...SALIDA_MODELO.variante_a, cuerpo: 'Buen día. Ya lo usan clientes reales.' },
    }));
    await expect(redactarCorreoFrio('pr-1', 'Javier', 'manual', CONTEXTO)).rejects.toThrow(/clientes reales/);
    expect(encolarPieza).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PRIMERA PASADA REAL DEL RUNNER (18:03, producción) — el Redactor falló las
// TRES veces con «devolvió una salida sin variante A legible». La causa: pedía
// markdown y lo desarmaba con regex, mientras el rol `back_office` corre con
// un modelo de razonamiento que se comía los 900 tokens de tope antes de
// escribir la primera letra visible. Un regex no distingue "truncado" de
// "ilegible", y la corrida no guardaba NADA de lo que el modelo contestó: el
// fallo era indiagnosticable desde la bandeja.
// ═══════════════════════════════════════════════════════════════════════════
describe('el Redactor pide SCHEMA, no markdown (los 3 fallos de la primera pasada)', () => {
  const listo = () => {
    respuestas.set('prospecto', [{ data: PROSPECTO, error: null }]);
    respuestas.set('prospecto_contacto', [{ data: [], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: [], error: null }]);
  };

  it('la llamada lleva schema, nombre de schema y tope holgado para los tokens de razonamiento', async () => {
    listo();
    await redactarCorreoFrio('pr-1', 'Javier', 'manual', CONTEXTO);
    const llamada = generateStructured.mock.calls[0][0] as {
      schema: unknown; schemaName: string; maxTokens: number; role: string; system: string;
    };
    expect(llamada.schemaName).toBe('variantes_correo_frio');
    expect(llamada.schema).toBeTruthy();
    expect(llamada.role).toBe('back_office');
    // 900 era el tope que mató las tres corridas: no alcanzaba ni para abrir
    // la llave del JSON después del razonamiento invisible.
    expect(llamada.maxTokens).toBeGreaterThan(900);
    // El prompt ya no puede pedir markdown: sería un contrato contra el otro.
    expect(llamada.system).not.toContain('## Variante A');
    expect(llamada.system).toContain('JSON');
  });

  it('AGB-2: el SYSTEM no nombra a ningún prospecto ("Innovativos", "Grupo GAL")', () => {
    const fuente = readFileSync('src/lib/likida/agentes/redactor.ts', 'utf8');
    expect(fuente).not.toContain('Innovativos');
    expect(fuente).not.toContain('Grupo GAL');
  });

  it('el archivo ya no parsea markdown con regex — esa frontera se fue al schema (estructural)', () => {
    const fuente = readFileSync('src/lib/likida/agentes/redactor.ts', 'utf8');
    expect(fuente).not.toMatch(/\\\*\\\*Asunto:\\\*\\\*/);
    expect(fuente).not.toMatch(/generateResponse/);
    expect(fuente).toMatch(/generateStructured/);
  });

  it('TRUNCADO (el fallo real): corrida en FALLO con el texto EXACTO del modelo, y NADA encolado', async () => {
    listo();
    generateStructured.mockRejectedValueOnce(new TruncatedError(
      'Respuesta truncada: se agotaron los 900 tokens de salida (usó 900) antes de cerrar el JSON',
      '{"variante_a":{"asunto":"El cierre del via',
      { model: 'openai/gpt-oss-120b', tokensIn: 1200, tokensOut: 900, cost: 0.0007 },
    ));

    await expect(redactarCorreoFrio('pr-1', 'Javier', 'cron', CONTEXTO)).rejects.toThrow(/no pudo escribir/);
    expect(encolarPieza).not.toHaveBeenCalled();
    const corrida = registrarCorrida.mock.calls[0][2] as { estado: string; error: string; costoUsd: number };
    expect(corrida.estado).toBe('fallo');
    // Lo que contestó el modelo, TAL CUAL — es lo único que permite el diagnóstico.
    expect(corrida.error).toContain('{"variante_a":{"asunto":"El cierre del via');
    // Y el gasto de la llamada fallida NO se tira: el techo diario lo vigila.
    expect(corrida.costoUsd).toBe(0.0007);
  });

  it('el modelo que contesta VACÍO se registra como vacío, no como un misterio', async () => {
    listo();
    generateStructured.mockRejectedValueOnce(new StructuredError('JSON parse falló', undefined, '', {
      model: 'openai/gpt-oss-120b', tokensIn: 1200, tokensOut: 0, cost: 0.0004,
    }));
    await expect(redactarCorreoFrio('pr-1', 'Javier', 'cron', CONTEXTO)).rejects.toThrow(/no pudo escribir/);
    const corrida = registrarCorrida.mock.calls[0][2] as { error: string };
    expect(corrida.error).toContain('vacío — el modelo no devolvió texto');
    expect(encolarPieza).not.toHaveBeenCalled();
  });

  it('una variante A vacía que SÍ cumple el schema tampoco se encola — jamás basura en la cola', async () => {
    listo();
    generateStructured.mockResolvedValueOnce(respuestaModelo({
      ...SALIDA_MODELO, variante_a: { asunto: '', cuerpo: '' },
    }));
    await expect(redactarCorreoFrio('pr-1', 'Javier', 'cron', CONTEXTO)).rejects.toThrow(/sin variante A legible/);
    expect(encolarPieza).not.toHaveBeenCalled();
    expect(registrarCorrida).toHaveBeenCalledWith(null, 'redactor', expect.objectContaining({ estado: 'fallo' }));
  });

  it('modo PLATAFORMA (c5-10): sin ledger por tenant, pero la pieza se encola igual', async () => {
    listo();
    const r = await redactarCorreoFrio('pr-1', 'Javier', 'cron', { plataforma: true });
    expect(r.piezaId).toBe('pieza-1');
    const llamada = generateStructured.mock.calls[0][0] as { budget: unknown };
    expect(llamada.budget).toBeUndefined();
    expect(encolarPieza).toHaveBeenCalledTimes(1);
  });
});
