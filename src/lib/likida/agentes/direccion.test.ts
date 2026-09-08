import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// LOS TRES DE DIRECCIÓN QUE VAN A LA BANDEJA (0235).
//
// Lo que estas pruebas defienden es lo que hace peligrosos a estos tres: un
// MRR que se suma a medias acaba citado en una junta de consejo; un teléfono
// que no salió de la base acaba marcado en el peor momento; y un `null` en
// «¿hay lesionados?» que se leyera como `false` convertiría el silencio de un
// chofer en un parte médico.
// ═══════════════════════════════════════════════════════════════════════════

const respuestas = new Map<string, Array<{ data?: unknown; error?: { message: string } | null; count?: number }>>();
function builder(tabla: string) {
  const responder = () => {
    const cola = respuestas.get(tabla);
    return cola && cola.length > 0 ? cola.shift()! : { data: [], error: null, count: 0 };
  };
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: () => b, eq: () => b, is: () => b, neq: () => b, not: () => b,
    in: () => b, gte: () => b, lt: () => b, order: () => b, limit: () => b,
    maybeSingle: () => b,
    then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve().then(responder).then(res, rej),
  });
  return b;
}
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: (t: string) => builder(t) }) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/likida/presupuesto', () => ({ acotada: (q: unknown) => q }));

const encolar = vi.fn(async (_p: unknown) => 'pieza-1');
vi.mock('./cola', () => ({ encolarPieza: (p: unknown) => encolar(p) }));

const registrar = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('./corridas', () => ({ registrarCorrida: (...a: unknown[]) => registrar(...a) }));

// `estadoLatidos` arrastra el juez de cadencias y su propia lectura de base:
// se mockea para que estas pruebas hablen de lo que el parte DICE con cada
// estado, no de cómo se juzga un latido (eso ya lo prueba `salud`).
const latidos = vi.fn(async () => ({}) as Record<string, { estado: string; haceMin: number | null; ultimoEstado: string | null }>);
vi.mock('@/lib/admin/salud', () => ({
  CRONS: ['runner', 'escalar'],
  estadoLatidos: () => latidos(),
}));

const {
  AGENTES_DIRECCION_BANDEJA, esAgenteDireccionBandeja, correrAgenteDireccionBandeja,
  lunesDe, masDias, mesDe,
  saludPorAgente, palancasPropuestas, armarParteAutomejora, UMBRAL_FALLO_PARA_PALANCA, DIAS_TELEMETRIA,
  aQuienLlamar, armarParteIncidente, tituloIncidente, PROVEEDOR_POR_TIPO, TIPOS_EMERGENCIA,
  calcularMrr, armarParteFundraising, HUECOS,
} = await import('./direccion');

const HOY = '2026-08-27'; // jueves
const LUNES = '2026-08-24';

function ultimoTitulo(): string {
  const p = encolar.mock.calls.at(-1)?.[0] as { titulo: string } | undefined;
  return p?.titulo ?? '';
}

/** Un latido sano de los dos crons que el mock declara. */
const LATIDOS_OK = {
  runner: { estado: 'ok', haceMin: 3, ultimoEstado: 'ok' },
  escalar: { estado: 'ok', haceMin: 5, ultimoEstado: 'ok' },
} as Record<string, { estado: string; haceMin: number | null; ultimoEstado: string | null }>;

beforeEach(() => {
  respuestas.clear();
  encolar.mockClear();
  encolar.mockResolvedValue('pieza-1');
  registrar.mockClear();
  latidos.mockClear();
  latidos.mockResolvedValue(LATIDOS_OK);
});

// ── El catálogo y la aritmética ────────────────────────────────────────────

describe('el catálogo de dirección-bandeja', () => {
  it('son exactamente tres y NO incluye a los cuatro que mandan correo (0216)', () => {
    expect(AGENTES_DIRECCION_BANDEJA).toHaveLength(3);
    for (const id of AGENTES_DIRECCION_BANDEJA) expect(esAgenteDireccionBandeja(id)).toBe(true);
    for (const id of ['kpi_whatsapp', 'desempeno_startup', 'orquestador', 'orquestador_semanal']) {
      expect(esAgenteDireccionBandeja(id)).toBe(false);
    }
  });

  it('la aritmética de fechas no cruza de mes ni de fecha', () => {
    expect(lunesDe(HOY)).toBe(LUNES);
    expect(masDias('2026-03-01', -1)).toBe('2026-02-28');
    expect(mesDe(HOY)).toBe('2026-08-01');
  });
});

// ── 1. Automejora ──────────────────────────────────────────────────────────

describe('automejora: la telemetría, con NULL que no se vuelve cero', () => {
  it('un costo NULL NO se suma como 0: se cuenta aparte', () => {
    const s = saludPorAgente([
      { agente: 'a', estado: 'ok', costoUsd: null, error: null },
      { agente: 'a', estado: 'ok', costoUsd: 0.5, error: null },
    ], new Map());
    expect(s[0]).toMatchObject({ costoUsd: 0.5, sinMedir: 1, corridas: 2 });
  });

  it('un agente cuyas corridas NINGUNA midió tiene costo NULL, no 0', () => {
    const s = saludPorAgente([{ agente: 'a', estado: 'ok', costoUsd: null, error: null }], new Map());
    expect(s[0].costoUsd).toBeNull();
  });

  it('el error que reporta es el REAL de la corrida, no un resumen', () => {
    const s = saludPorAgente([
      { agente: 'a', estado: 'fallo', costoUsd: null, error: 'sitio_evento ilegible: connection reset' },
    ], new Map());
    expect(s[0].ultimoError).toBe('sitio_evento ilegible: connection reset');
    expect(armarParteAutomejora(s, [], LATIDOS_OK as never, [], '2026-08-17', '2026-08-23', 1, false))
      .toContain('connection reset');
  });

  it(`solo propone palanca por encima del ${UMBRAL_FALLO_PARA_PALANCA * 100}% de fallos`, () => {
    const mitad = saludPorAgente([
      { agente: 'redactor', estado: 'fallo', costoUsd: null, error: 'x' },
      { agente: 'redactor', estado: 'ok', costoUsd: null, error: null },
    ], new Map());
    expect(palancasPropuestas(mitad)).toHaveLength(0);
    const casiTodo = saludPorAgente([
      { agente: 'redactor', estado: 'fallo', costoUsd: null, error: 'x' },
      { agente: 'redactor', estado: 'fallo', costoUsd: null, error: 'x' },
      { agente: 'redactor', estado: 'ok', costoUsd: null, error: null },
    ], new Map());
    expect(palancasPropuestas(casiTodo)[0]).toMatchObject({ interruptor: 'agente:redactor' });
  });

  it('un agente que falla y NO tiene palanca declarada se marca como el hallazgo mayor', () => {
    const s = saludPorAgente([{ agente: 'no_existe_0235', estado: 'fallo', costoUsd: null, error: 'x' }], new Map());
    const p = palancasPropuestas(s);
    expect(p[0].interruptor).toBeNull();
    expect(p[0].porque).toContain('NO TIENE PALANCA DECLARADA');
  });

  it('cero corridas NO se lee como «todo tranquilo»: nombra las dos causas', () => {
    const c = armarParteAutomejora([], [], LATIDOS_OK as never, [], '2026-08-17', '2026-08-23', 0, false);
    expect(c).toContain('NI UNA SOLA CORRIDA');
    expect(c).toContain('el cron del runner está muerto');
    expect(c).toContain('la telemetría lo está');
  });

  it('«corrió y no produjo» se plantea como PREGUNTA, no como acusación', () => {
    const s = saludPorAgente([{ agente: 'vigia', estado: 'ok', costoUsd: 0, error: null }], new Map());
    const c = armarParteAutomejora(s, [], LATIDOS_OK as never, [], '2026-08-17', '2026-08-23', 1, false);
    expect(c).toContain('esto es una PREGUNTA, no una acusación');
    expect(c).toContain('el comportamiento CORRECTO');
  });

  it('un cron SIN LATIDO se distingue de uno VENCIDO', () => {
    const c = armarParteAutomejora([], [], {
      runner: { estado: 'sin_latido', haceMin: null, ultimoEstado: null },
      escalar: { estado: 'vencido', haceMin: 300, ultimoEstado: 'ok' },
    } as never, [], '2026-08-17', '2026-08-23', 0, false);
    expect(c).toContain('SIN UN SOLO LATIDO REGISTRADO');
    expect(c).toContain('VENCIDO');
  });

  it('declara lo que NO mira (los diffs de rechazo) en vez de callarlo', () => {
    expect(armarParteAutomejora([], [], LATIDOS_OK as never, [], '2026-08-17', '2026-08-23', 0, false))
      .toContain('no lee los diffs');
  });

  it('el parte dice que no ejecutó nada', () => {
    expect(armarParteAutomejora([], [], LATIDOS_OK as never, [], '2026-08-17', '2026-08-23', 0, false))
      .toContain('NO ejecutó nada');
  });

  it('la corrida titula por la semana CERRADA, no por la que va corriendo', async () => {
    respuestas.set('cola_aprobacion', [{ count: 0, error: null }, { data: [], error: null }]);
    respuestas.set('agente_corrida', [{ data: [], error: null, count: 0 }]);
    respuestas.set('interruptor', [{ data: [], error: null }]);
    const r = await correrAgenteDireccionBandeja('automejora', 'cron', HOY);
    expect(r).toMatchObject({ resultado: 'corrio', piezas: 1, costoUsd: 0 });
    expect(ultimoTitulo()).toBe(`Automejora — semana del ${masDias(LUNES, -DIAS_TELEMETRIA)}`);
  });

  it('la telemetría ilegible LANZA en vez de afirmar que no falló nada', async () => {
    respuestas.set('cola_aprobacion', [{ count: 0, error: null }, { data: [], error: null }]);
    respuestas.set('agente_corrida', [{ data: null, error: { message: 'base caída' } }]);
    await expect(correrAgenteDireccionBandeja('automejora', 'cron', HOY)).rejects.toThrow(/base caída/);
  });
});

// ── 2. Especialistas de incidente ──────────────────────────────────────────

describe('especialistas_incidente: ni un teléfono que no esté en la base', () => {
  const inc = {
    id: 'i1', tenantId: 't1', tipo: 'siniestro', prioridad: 'critica', estado: 'abierta',
    descripcion: null, abiertaEn: '2026-08-27T10:00:00Z',
    hayLesionados: null as boolean | null, unidadMovible: null as boolean | null,
    reconocidaEn: null, nivelEscalado: 0,
    operadorId: 'o1', operadorNombre: 'ZZZ Operador', unidadEconomico: 'U-01',
    flota: 'Flota ZZZ', poliza: null, proveedores: [],
  };

  it('sin nada capturado NO inventa un número y dice por qué eso importa', () => {
    expect(aQuienLlamar(inc)).toHaveLength(0);
    const c = armarParteIncidente(inc, [], HOY);
    expect(c).toContain('NO HAY UN SOLO TELÉFONO CAPTURADO');
    expect(c).toContain('Un número inventado aquí sería peor');
  });

  it('`hay_lesionados` NULL se lee como NO PREGUNTADO, jamás como «no hay»', () => {
    const c = armarParteIncidente(inc, [], HOY);
    expect(c).toContain('NO SE PREGUNTÓ');
    expect(c).toContain('no significa «no hay»');
  });

  // AUDITORÍA 25 (ALTO, REINCIDENTE) → AUDITORÍA 28 LEG-A5 (ALTO,
  // REINCIDENTE): el dato de salud (¿hay lesionados?) y el nombre/parentesco
  // del familiar viajaban hacia `cola_aprobacion` — una tabla sin alcance de
  // purga ni de ARCO. La 25 ocultó el VALOR; la 28 corrige que la sola
  // EXISTENCIA de un renglón (que solo aparecía con `hayLesionados === true`)
  // ya delataba el dato de salud. Ahora `aQuienLlamar` ya no conoce a la
  // familia (su único consumidor es este parte, grep verificado) y el parte
  // imprime SIEMPRE la misma línea neutra.
  it('con lesionados confirmados, el parte NO afirma el dato de salud — remite al expediente', () => {
    const c = armarParteIncidente({ ...inc, hayLesionados: true }, [], HOY);
    expect(c).not.toContain('SÍ, CONFIRMADO en el expediente');
    expect(c).toContain('Ya se contestó en el expediente');
    expect(c).not.toMatch(/¿Hay lesionados\? SÍ/);
  });

  it('con lesionados descartados, el parte NO afirma el dato de salud — remite al expediente', () => {
    const c = armarParteIncidente({ ...inc, hayLesionados: false }, [], HOY);
    expect(c).not.toContain('NO, y está confirmado en el expediente');
    expect(c).toContain('Ya se contestó en el expediente');
  });

  it('aQuienLlamar ya NO devuelve contactos familiares bajo NINGÚN valor de hayLesionados (AUD-28 LEG-A5): su único consumidor es el parte, que usa una línea fija', () => {
    for (const hayLesionados of [true, false, null] as const) {
      const t = aQuienLlamar({ ...inc, hayLesionados });
      expect(t.map((x) => x.quien).join(' ')).not.toMatch(/familia/i);
    }
  });

  it('el parte del incidente es TEXTUALMENTE IDÉNTICO con lesionados confirmados o descartados: la sola EXISTENCIA de la línea de contactos no delata el dato de salud (AUD-28 LEG-A5)', () => {
    const base = {
      ...inc,
      poliza: { aseguradora: 'ZZZ Seguros', numeroPoliza: 'P-1', telefono: '+528000000000', vigenciaHasta: '2027-01-01' },
    };
    const conLesionados = { ...base, hayLesionados: true as boolean | null };
    const sinLesionados = { ...base, hayLesionados: false as boolean | null };
    const parteCon = armarParteIncidente(conLesionados, aQuienLlamar(conLesionados), HOY);
    const parteSin = armarParteIncidente(sinLesionados, aQuienLlamar(sinLesionados), HOY);
    // Diff vacío en todo lo que toque a contactos/familia — de hecho, en TODO
    // el parte: nada más depende de `hayLesionados` salvo el renglón «¿Hay
    // lesionados?», que ya dice el mismo texto para true y false (ver arriba).
    expect(parteCon).toEqual(parteSin);
    expect(parteCon).toContain('Contactos de emergencia del operador');
    expect(parteCon).not.toMatch(/familia/i);
  });

  it('un proveedor sin verificar se rotula CAPTURADO PERO NO VERIFICADO', () => {
    const t = aQuienLlamar({
      ...inc,
      proveedores: [{ tipo: 'grua', nombre: 'Grúas ZZZ', telefono: '+523333333333', verificadoEn: null }],
    });
    expect(t[0].respaldo).toContain('CAPTURADO PERO NO VERIFICADO');
  });

  it('una póliza sin fecha de vigencia no se afirma vigente ni vencida', () => {
    const t = aQuienLlamar({
      ...inc,
      poliza: { aseguradora: 'ZZZ', numeroPoliza: 'P-1', telefono: '+528000000000', vigenciaHasta: null },
    });
    expect(t[0].respaldo).toContain('no se puede afirmar que esté vigente, y tampoco que no');
  });

  it('solo se proponen los proveedores que el TIPO de emergencia pide', () => {
    const proveedores = [
      { tipo: 'grua', nombre: 'Grúas ZZZ', telefono: '+523333333333', verificadoEn: '2026-01-01T00:00:00Z' },
      { tipo: 'llantera', nombre: 'Llantas ZZZ', telefono: '+524444444444', verificadoEn: null },
    ];
    // Un siniestro pide grúa y médico, no llantera.
    expect(aQuienLlamar({ ...inc, proveedores }).map((t) => t.quien)).toEqual(['Grúas ZZZ (grua)']);
    // Un varado sí pide llantera.
    expect(aQuienLlamar({ ...inc, tipo: 'varado', proveedores }).map((t) => t.quien))
      .toEqual(['Grúas ZZZ (grua)', 'Llantas ZZZ (llantera)']);
  });

  it('un robo o un bloqueo no piden proveedor, y eso está DECLARADO, no olvidado', () => {
    expect(PROVEEDOR_POR_TIPO.robo).toEqual([]);
    expect(PROVEEDOR_POR_TIPO.bloqueo).toEqual([]);
    for (const t of TIPOS_EMERGENCIA) expect(PROVEEDOR_POR_TIPO[t]).toBeDefined();
  });

  it('el parte declara que Likida no marcó y no va a marcar', () => {
    expect(armarParteIncidente(inc, [], HOY)).toContain('NO MARCÓ Y NO VA A MARCAR');
  });

  it('el título es por EXPEDIENTE: un incidente abierto no genera un parte por día', () => {
    expect(tituloIncidente('i1')).toBe('Incidente — expediente i1');
  });

  // «No hay emergencias» es una frase que TRANQUILIZA. Nadie debería leerla
  // cuando lo que pasó es que no dio tiempo de revisar los expedientes — de ahí
  // que este agente distinga las dos cosas con más cuidado que los demás.
  it('con el reloj vencido dice que quedaron incidentes SIN REVISAR, no que no haya', async () => {
    respuestas.set('incidencia', [{ data: [{ id: 'i1', tenant_id: 't1', tipo: 'siniestro', prioridad: 'critica', estado: 'abierta', abierta_en: '2026-08-27T10:00:00Z', nivel_escalado: 0 }], error: null }]);
    const r = await correrAgenteDireccionBandeja('especialistas_incidente', 'cron', HOY, Date.now() - 1);
    expect(r).toMatchObject({ resultado: 'corrio', piezas: 0, sinTurno: true });
    expect(r.motivo).toContain('NO significa que no haya ninguno abierto');
    expect(encolar).not.toHaveBeenCalled();
  });

  it('sin incidentes abiertos no fabrica nada y lo llama estado normal', async () => {
    respuestas.set('incidencia', [{ data: [], error: null }]);
    const r = await correrAgenteDireccionBandeja('especialistas_incidente', 'cron', HOY);
    expect(r.piezas).toBe(0);
    expect(r.motivo).toContain('estado normal');
    expect(encolar).not.toHaveBeenCalled();
  });

  it('la pieza es URGENTE, lleva el tenant de la flota y NO copia teléfonos al jsonb', async () => {
    respuestas.set('cola_aprobacion', [{ count: 0, error: null }]);
    respuestas.set('incidencia', [{ data: [{
      id: 'i1', tenant_id: 't1', tipo: 'siniestro', prioridad: 'critica', estado: 'abierta',
      descripcion: 'volcadura', abierta_en: '2026-08-27T10:00:00Z',
      hay_lesionados: null, unidad_movible: null, reconocida_en: null, nivel_escalado: 0,
      operador_id: 'o1',
    }], error: null }]);
    respuestas.set('flota_poliza', [{ data: [{ aseguradora: 'ZZZ', numero_poliza: 'P-1', telefono_siniestros: '+528000000000', vigencia_hasta: null }], error: null }]);
    respuestas.set('proveedor_emergencia', [{ data: [], error: null }]);
    await correrAgenteDireccionBandeja('especialistas_incidente', 'cron', HOY);
    const p = encolar.mock.calls.at(-1)?.[0] as { prioridad: string; tenantId: string; fuentes: Record<string, unknown>; cuerpo: string };
    expect(p.prioridad).toBe('urgente');
    expect(p.tenantId).toBe('t1');
    expect(JSON.stringify(p.fuentes)).not.toContain('+52');
    expect(p.cuerpo).toContain('+528000000000');
    // AUDITORÍA 25 (ALTO, REINCIDENTE): `lesionados` (dato de salud) tampoco
    // viaja al jsonb de trazabilidad — mismo criterio que los teléfonos.
    expect(p.fuentes).not.toHaveProperty('lesionados');
  });
});

// ── 3. Fundraising ─────────────────────────────────────────────────────────

describe('fundraising: las cifras reales, y la lista de las que no existen', () => {
  it('una sola activa con precio NULL vuelve el MRR INDETERMINADO, no parcial', () => {
    const m = calcularMrr([
      { plan: 'flota', precio: 17500 },
      { plan: 'empresa', precio: null },
    ]);
    expect(m.mxn).toBeNull();
    expect(m.motivo).toContain('INDETERMINADO');
    expect(m.motivo).toContain('empresa');
  });

  it('cero suscripciones activas NO es «$0 de MRR»', () => {
    const m = calcularMrr([]);
    expect(m.mxn).toBeNull();
    expect(m.motivo).toContain('no es «$0 de MRR»');
  });

  it('con todas las activas con precio, el MRR es la suma exacta', () => {
    const m = calcularMrr([{ plan: 'flota', precio: 17500 }, { plan: 'demo', precio: 1900 }]);
    expect(m).toMatchObject({ mxn: 19400, activas: 2, sinPrecio: 0, motivo: null });
  });

  const cifras = {
    flotas: 3, suscripciones: { porEstado: [], activas: [] },
    facturasPagadas: 0, cobradoMxn: 0, pipeline: [], liquidaciones: 0,
    truncado: false,
  };

  it('el parte SIN cifra de MRR dice por qué, no un cero', () => {
    const c = armarParteFundraising(cifras, calcularMrr([]), '2026-08-01');
    expect(c).toContain('MRR: SIN CIFRA');
    expect(c).not.toContain('MRR: $0');
  });

  it('la lista de huecos va COMPLETA y con su razón, en el cuerpo', () => {
    const c = armarParteFundraising(cifras, calcularMrr([]), '2026-08-01');
    for (const h of HUECOS) {
      expect(c).toContain(h.metrica);
      expect(c).toContain(h.porque.slice(0, 40));
    }
    expect(HUECOS.map((h) => h.metrica)).toContain('Churn');
    expect(HUECOS.map((h) => h.metrica)).toContain('Runway');
  });

  it('explica por qué la lista de huecos va en el parte y no en una nota al pie', () => {
    expect(armarParteFundraising(cifras, calcularMrr([]), '2026-08-01'))
      .toContain('un número inventado no lo es');
  });

  it('cero suscripciones NO se lee como cero clientes de pago', () => {
    expect(armarParteFundraising(cifras, calcularMrr([]), '2026-08-01'))
      .toContain('el alta de una flota y su suscripción son dos cosas distintas');
  });

  it('el pipeline se declara CONTEO, no valor en pesos', () => {
    const c = armarParteFundraising({ ...cifras, pipeline: [{ etapa: 'nuevo', n: 800 }] }, calcularMrr([]), '2026-08-01');
    expect(c).toContain('no valor de pipeline');
  });

  it('una lectura truncada se DICE: una cifra recortada se cita, una ausente se pregunta', () => {
    const c = armarParteFundraising({ ...cifras, truncado: true }, calcularMrr([]), '2026-08-01');
    expect(c).toContain('SE TRUNCÓ');
    expect(c).toContain('un PISO, no el total');
  });

  it('jamás escribe «clientes reales»', () => {
    const c = armarParteFundraising(cifras, calcularMrr([]), '2026-08-01');
    expect(c).toContain('«clientes reales»');
    expect(c).toContain('en pláticas con transportistas');
  });

  it('la corrida titula por MES y anota si el MRR salió indeterminado', async () => {
    respuestas.set('cola_aprobacion', [{ count: 0, error: null }]);
    respuestas.set('tenant', [{ count: 3, error: null }]);
    respuestas.set('liquidacion', [{ count: 0, error: null }]);
    respuestas.set('suscripcion', [{ data: [], error: null }]);
    respuestas.set('factura_saas', [{ data: [], error: null }]);
    respuestas.set('prospecto', [{ data: [], error: null }]);
    await correrAgenteDireccionBandeja('fundraising', 'cron', HOY);
    expect(ultimoTitulo()).toBe('Fundraising — parte de 2026-08');
    expect(encolar.mock.calls.at(-1)?.[0]).toMatchObject({ fuentes: expect.objectContaining({ mrr_indeterminado: true }) });
  });

  it('un conteo que PostgREST no devuelve es fail-closed, no un cero', async () => {
    respuestas.set('cola_aprobacion', [{ count: 0, error: null }]);
    respuestas.set('tenant', [{ count: undefined, error: null }]);
    await expect(correrAgenteDireccionBandeja('fundraising', 'cron', HOY)).rejects.toThrow(/no se afirma un 0/);
  });
});

// ── Lo que gobierna a los tres ─────────────────────────────────────────────

describe('las reglas del departamento', () => {
  it('las corridas van con tenant NULL y costo 0 MEDIDO', async () => {
    respuestas.set('cola_aprobacion', [{ count: 1, error: null }]);
    await correrAgenteDireccionBandeja('automejora', 'cron', HOY);
    const c = registrar.mock.calls.at(-1) as unknown[];
    expect(c[0]).toBeNull();
    expect(c[2]).toMatchObject({ costoUsd: 0 });
  });

  it('un duplicado del índice único se trata como «ya existía», no como fallo', async () => {
    respuestas.set('cola_aprobacion', [{ count: 0, error: null }, { data: [], error: null }]);
    respuestas.set('agente_corrida', [{ data: [], error: null, count: 0 }]);
    respuestas.set('interruptor', [{ data: [], error: null }]);
    encolar.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint "cola_pieza_direccion_por_periodo"'));
    const r = await correrAgenteDireccionBandeja('automejora', 'cron', HOY);
    expect(r).toMatchObject({ resultado: 'corrio', piezas: 0 });
    expect(r.motivo).toContain('otra corrida ganó');
  });

  it('un fallo anota la corrida como fallo antes de propagar', async () => {
    respuestas.set('cola_aprobacion', [{ count: 0, error: null }, { data: [], error: null }]);
    respuestas.set('agente_corrida', [{ data: null, error: { message: 'tabla ilegible' } }]);
    await expect(correrAgenteDireccionBandeja('automejora', 'cron', HOY)).rejects.toThrow();
    const c = registrar.mock.calls.at(-1) as unknown[];
    expect((c[2] as { estado: string }).estado).toBe('fallo');
    expect((c[2] as { error: string }).error).toContain('tabla ilegible');
  });
});
