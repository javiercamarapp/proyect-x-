import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// EL BACK OFFICE RESTANTE (0219) — los contratos que el código sostiene:
//
//  · CERO modelo: cada cifra sale de una lectura real; los constructores son
//    puros y su salida es plantilla fija.
//  · NULL ≠ 0: un `costo_usd` nulo no promedia; un candidato sin vara no
//    saca 0, saca NULL; una fuente ciega se dice, no se colapsa a «no hay».
//  · FAIL CLOSED Y DICHO: la bitácora ilegible ⇒ corrida en fallo y NINGÚN
//    parte — un parte de calidad sobre una base ciega diría «nadie falló».
//  · UN PARTE POR PERIODO: el pre-check corta; el índice único de la 0219 es
//    el árbitro real y su rebote se trata como «ya existía», no como fallo.
//  · EL HUMANO DECIDE: la criba nunca descarta; el legal nunca firma.
//  · Los ROJOS (hallazgo de calidad, ARCO vencida) salen al operador YA.
// ═══════════════════════════════════════════════════════════════════════════

// Una cola de respuestas por tabla: cada elemento es la respuesta COMPLETA
// que la siguiente consulta a esa tabla se lleva. Vacía ⇒ éxito sin filas.
const respuestas = new Map<string, Array<Record<string, unknown>>>();
const updates: Array<{ tabla: string; fila: Record<string, unknown> }> = [];
function responderDe(tabla: string) {
  const cola = respuestas.get(tabla);
  return cola && cola.length > 0 ? cola.shift()! : { data: [], count: 0, error: null };
}
function encolarRespuesta(tabla: string, r: Record<string, unknown>) {
  const cola = respuestas.get(tabla) ?? [];
  cola.push(r);
  respuestas.set(tabla, cola);
}
function builder(tabla: string) {
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: () => b, eq: () => b, neq: () => b, is: () => b, not: () => b,
    gte: () => b, lt: () => b, in: () => b, limit: () => b, order: () => b, range: () => b,
    maybeSingle: () => b,
    update: (fila: Record<string, unknown>) => { updates.push({ tabla, fila }); return b; },
    then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve().then(() => responderDe(tabla)).then(res, rej),
  });
  return b;
}
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: (t: string) => builder(t) }) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const registrarCorrida = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('./corridas', () => ({ registrarCorrida: (...a: unknown[]) => registrarCorrida(...a) }));
const encolarPieza = vi.fn(async (..._a: unknown[]) => 'pieza-1');
vi.mock('./cola', () => ({ encolarPieza: (...a: unknown[]) => encolarPieza(...a) }));
const alertarOperador = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('@/lib/observability/alerta', () => ({ alertarOperador: (...a: unknown[]) => alertarOperador(...a) }));
// La URL base fija: lo que el entorno de CI traiga no puede decidir qué URL
// se pide ni cómo se lee el resultado.
vi.mock('@/lib/env', () => ({ appUrl: () => 'https://app.likida.test' }));
const estadoLegal = vi.fn(() => ({ listo: true, faltantes: [] as string[], faltantesEntidad: [] as string[], faltantesDocumentos: [] as string[], bloqueado: false }));
vi.mock('@/lib/legal/config', () => ({ estadoLegalProduccion: () => estadoLegal() }));

const {
  lunesDe, masDias, diasEntre, esAgenteBackOffice, AGENTES_BACK_OFFICE,
  evaluarCalidad, armarParteCalidad,
  huellaDescripcion, censoDe, compararCatalogo, armarParteDocumentacion,
  comprobarPublicacion, armarParteLegal, RUTAS_LEGALES,
  normalizar, evaluarCandidato, armarParteTalento,
  correrAgenteBackOffice,
} = await import('./backoffice');

type Ficha = Parameters<typeof censoDe>[0][number];
type Corrida = Parameters<typeof evaluarCalidad>[0][number];

const corrida = (p: Partial<Corrida> & { agente: string }): Corrida => ({
  estado: 'ok', inicio: '2026-08-18T10:00:00.000Z', tareasHechas: 1, tareasTotal: 1,
  costoUsd: null, error: null, ...p,
});
const ficha = (p: Partial<Ficha> & { id: string }): Ficha => ({
  nombre: 'Agente', departamento: 'back_office', estado: 'vivo', runnerHabilitado: true,
  descripcion: 'Una descripción suficientemente larga para pasar el mínimo útil.',
  promptRef: 'blueprint.md', modeloRol: 'chat', ...p,
});

beforeEach(() => {
  respuestas.clear();
  updates.length = 0;
  registrarCorrida.mockClear();
  encolarPieza.mockClear();
  encolarPieza.mockImplementation(async () => 'pieza-1');
  alertarOperador.mockClear();
  estadoLegal.mockReturnValue({ listo: true, faltantes: [], faltantesEntidad: [], faltantesDocumentos: [], bloqueado: false });
});
afterEach(() => { vi.unstubAllGlobals(); });

// ── El calendario ─────────────────────────────────────────────────────────

describe('el calendario del back office', () => {
  it('lunesDe ancla la semana y masDias/diasEntre caminan sin cruzar de mes mal', () => {
    expect(lunesDe('2026-08-27')).toBe('2026-08-24'); // jueves → su lunes
    expect(lunesDe('2026-08-24')).toBe('2026-08-24'); // el lunes es su propio lunes
    expect(lunesDe('2026-08-23')).toBe('2026-08-17'); // domingo → el lunes ANTERIOR
    expect(masDias('2026-03-01', -1)).toBe('2026-02-28');
    expect(diasEntre('2026-08-27', '2026-09-03')).toBe(7);
    expect(diasEntre('2026-08-27', '2026-08-20')).toBe(-7);
  });

  it('la lista del motor y el predicado coinciden', () => {
    expect([...AGENTES_BACK_OFFICE]).toEqual(['vigilante_calidad', 'documentacion', 'legal_compliance', 'talento']);
    for (const id of AGENTES_BACK_OFFICE) expect(esAgenteBackOffice(id)).toBe(true);
    expect(esAgenteBackOffice('redactor')).toBe(false);
  });
});

// ── 1 · Vigilante de calidad ──────────────────────────────────────────────

describe('vigilante de calidad: los cuatro detectores, con evidencia', () => {
  it('V1 cuenta fallos en absolutos y cita el error; media docena de ok no dispara nada', () => {
    const h = evaluarCalidad([
      corrida({ agente: 'sdr', estado: 'fallo', error: 'OpenRouter 429' }),
      corrida({ agente: 'sdr' }),
      corrida({ agente: 'sdr' }),
      corrida({ agente: 'redactor' }),
    ], [], []);
    const v1 = h.filter((x) => x.codigo === 'V1');
    expect(v1).toHaveLength(1);
    expect(v1[0].agente).toBe('sdr');
    expect(v1[0].semaforo).toBe('AMBAR'); // 1 de 3 no llega al corte de ROJO
    expect(v1[0].detalle).toContain('1 de 3');
    expect(v1[0].evidencia).toContain('OpenRouter 429');
    // El `redactor` no dispara NINGÚN semáforo: sus corridas son ok. Desde
    // c6-12 sí aparece con la NOTA de «no anotó costo» —esa nota ya no exige
    // que alguna corrida haya medido—, y eso es lo que se quería: un agente
    // que dejó de medir del todo no puede desaparecer del parte.
    expect(h.some((x) => x.agente === 'redactor' && x.semaforo !== 'NOTA')).toBe(false);
    const nota = h.find((x) => x.agente === 'redactor');
    expect(nota?.codigo).toBe('V3');
    expect(nota?.evidencia).toContain('NINGUNA corrida');
  });

  it('V1 es ROJO cuando la mitad o más de las corridas fallan', () => {
    const h = evaluarCalidad([
      corrida({ agente: 'sdr', estado: 'fallo', error: 'a' }),
      corrida({ agente: 'sdr', estado: 'fallo', error: 'b' }),
    ], [], []);
    expect(h.find((x) => x.codigo === 'V1')?.semaforo).toBe('ROJO');
  });

  it('V2 (verde vacío) es ROJO aunque no haya un solo fallo; 0 de 0 NO lo dispara', () => {
    const h = evaluarCalidad([
      corrida({ agente: 'enviador', tareasHechas: 0, tareasTotal: 4 }),
      corrida({ agente: 'talento', tareasHechas: 0, tareasTotal: 0 }),
    ], [], []);
    const v2 = h.filter((x) => x.codigo === 'V2');
    expect(v2).toHaveLength(1);
    expect(v2[0].agente).toBe('enviador');
    expect(v2[0].semaforo).toBe('ROJO');
    expect(v2[0].evidencia).toContain('0 de 4');
  });

  it('V3 compara contra la propia historia y exige base, factor y piso de dinero', () => {
    const semana = [
      corrida({ agente: 'sdr', costoUsd: 0.4 }),
      corrida({ agente: 'sdr', costoUsd: 0.4 }),
    ];
    // Con base suficiente y $0.80 en la ventana (> piso): dispara.
    const conBase = evaluarCalidad(semana, [{ agente: 'sdr', promedioUsd: 0.1, n: 20 }], []);
    expect(conBase.find((x) => x.codigo === 'V3' && x.semaforo === 'AMBAR')?.evidencia).toContain('20');
    // Historia corta: NO se compara contra una anécdota.
    const baseCorta = evaluarCalidad(semana, [{ agente: 'sdr', promedioUsd: 0.1, n: 2 }], []);
    expect(baseCorta.some((x) => x.codigo === 'V3' && x.semaforo === 'AMBAR')).toBe(false);
    // Mismo factor, pero céntimos: el piso de dinero lo calla.
    const centavos = evaluarCalidad(
      [corrida({ agente: 'sdr', costoUsd: 0.02 })],
      [{ agente: 'sdr', promedioUsd: 0.001, n: 20 }], [],
    );
    expect(centavos.some((x) => x.codigo === 'V3' && x.semaforo === 'AMBAR')).toBe(false);
  });

  it('NULL ≠ 0: las corridas sin costo medido no promedian y el parte lo dice', () => {
    const h = evaluarCalidad([
      corrida({ agente: 'sdr', costoUsd: 1 }),
      corrida({ agente: 'sdr', costoUsd: null }),
    ], [{ agente: 'sdr', promedioUsd: 1, n: 20 }], []);
    const nota = h.find((x) => x.codigo === 'V3' && x.semaforo === 'NOTA');
    expect(nota?.detalle).toContain('1 de 2');
    expect(nota?.evidencia).toContain('NO se cuenta como $0');
  });

  it('V4 lee el rechazo humano como señal de calidad del productor y cita el motivo', () => {
    const h = evaluarCalidad([], [], [
      { agente: 'redactor', estado: 'rechazado', titulo: 'Correo a Transportes X', motivoRechazo: 'inventó una cifra' },
      { agente: 'redactor', estado: 'aprobado', titulo: 'Otro', motivoRechazo: null },
      { agente: 'redactor', estado: 'rechazado', titulo: 'Tercero', motivoRechazo: null },
      { agente: 'redactor', estado: 'rechazado', titulo: 'Cuarto', motivoRechazo: 'tono' },
    ]);
    const v4 = h.find((x) => x.codigo === 'V4');
    expect(v4?.semaforo).toBe('ROJO'); // 3 rechazos
    expect(v4?.detalle).toContain('3 de 4');
    expect(v4?.evidencia).toContain('inventó una cifra');
    expect(v4?.evidencia).toContain('sin motivo anotado');
  });

  it('la ventana vacía ES el hallazgo: no se lee como «todo bien»', () => {
    const h = evaluarCalidad([], [], []);
    expect(h).toHaveLength(1);
    expect(h[0].codigo).toBe('V0');
    expect(h[0].evidencia).toContain('o nadie corrió');
  });

  it('el parte sin hallazgos es corto y declara lo que NO audita', () => {
    const cuerpo = armarParteCalidad([], '2026-08-17', '2026-08-23', 12, 4, 3);
    expect(cuerpo).toContain('Nada disparó umbral');
    expect(cuerpo).toContain('LO QUE ESTE PARTE NO AUDITA: el código');
    expect(cuerpo.split('\n').length).toBeLessThan(15);
    // Sin truncar, el parte NO menciona una ventana recortada.
    expect(cuerpo).not.toContain('VENTANA TRUNCADA');
  });

  // c6-12: una ventana recortada en silencio hace que «nadie falló» signifique
  // «nadie falló entre las que alcancé a leer».
  it('la ventana truncada se DICE, con el tope y con qué corridas faltan', () => {
    const cuerpo = armarParteCalidad([], '2026-08-17', '2026-08-23', 5000, 9, 3, true);
    expect(cuerpo).toContain('VENTANA TRUNCADA A 5,000 CORRIDAS');
    expect(cuerpo).toContain('MÁS VIEJAS');
    expect(cuerpo).toContain('NO aparece aquí');
  });
});

describe('vigilante de calidad: la corrida', () => {
  it('lee la semana CERRADA, encola el parte, alerta los rojos y anota 1/1', async () => {
    encolarRespuesta('cola_aprobacion', { count: 0, error: null }); // parteExistente
    encolarRespuesta('agente_corrida', {
      data: [{ agente: 'sdr', estado: 'ok', inicio: '2026-08-18T10:00:00Z', tareas_hechas: 0, tareas_total: 3, costo_usd: null, error: null }],
      error: null,
    });
    encolarRespuesta('agente_corrida', { data: [], error: null }); // base de costo
    encolarRespuesta('cola_aprobacion', { data: [], error: null }); // piezas resueltas

    const r = await correrAgenteBackOffice('vigilante_calidad', 'cron', '2026-08-27');
    expect(r.piezas).toBe(1);
    const pieza = encolarPieza.mock.calls[0][0] as Record<string, unknown>;
    expect(pieza.agente).toBe('vigilante_calidad');
    expect(pieza.titulo).toBe('Calidad — semana del 2026-08-17'); // la semana cerrada
    expect(String(pieza.cuerpo)).toContain('VERDE VACÍO');
    expect(alertarOperador).toHaveBeenCalledTimes(1);
    const corridaAnotada = registrarCorrida.mock.calls[0][2] as Record<string, unknown>;
    expect(corridaAnotada.estado).toBe('ok');
    expect(corridaAnotada.tareasHechas).toBe(1);
  });

  it('c6-12: si el `count` de la base supera lo leído, el parte lo declara', async () => {
    encolarRespuesta('cola_aprobacion', { count: 0, error: null }); // parteExistente
    encolarRespuesta('agente_corrida', {
      data: [{ agente: 'sdr', estado: 'ok', inicio: '2026-08-18T10:00:00Z', tareas_hechas: 1, tareas_total: 1, costo_usd: 0.01, error: null }],
      count: 7321,   // la semana tuvo 7,321 y solo llegó 1: la ventana se cortó
      error: null,
    });
    encolarRespuesta('agente_corrida', { data: [], error: null });
    encolarRespuesta('cola_aprobacion', { data: [], error: null });

    await correrAgenteBackOffice('vigilante_calidad', 'cron', '2026-08-27');
    const pieza = encolarPieza.mock.calls[0][0] as Record<string, unknown>;
    expect(String(pieza.cuerpo)).toContain('VENTANA TRUNCADA');
    expect((pieza.fuentes as Record<string, unknown>).truncado).toBe(true);
  });

  it('el parte del periodo ya en la bandeja no se fabrica dos veces', async () => {
    encolarRespuesta('cola_aprobacion', { count: 1, error: null });
    const r = await correrAgenteBackOffice('vigilante_calidad', 'cron', '2026-08-27');
    expect(r.piezas).toBe(0);
    expect(r.motivo).toContain('ya está en la bandeja');
    expect(encolarPieza).not.toHaveBeenCalled();
  });

  it('el rebote del índice único se trata como «ya existía», no como fallo', async () => {
    encolarRespuesta('cola_aprobacion', { count: 0, error: null });
    encolarPieza.mockImplementation(async () => { throw new Error('duplicate key value violates unique constraint "cola_parte_backoffice_por_periodo"'); });
    const r = await correrAgenteBackOffice('vigilante_calidad', 'cron', '2026-08-27');
    expect(r.piezas).toBe(0);
    expect(r.motivo).toContain('otra corrida ganó el periodo');
    expect((registrarCorrida.mock.calls[0][2] as Record<string, unknown>).estado).toBe('ok');
  });

  it('FAIL CLOSED: bitácora ilegible ⇒ corrida en fallo y NINGÚN parte', async () => {
    encolarRespuesta('cola_aprobacion', { count: 0, error: null });
    encolarRespuesta('agente_corrida', { data: null, error: { message: 'connection reset' } });
    await expect(correrAgenteBackOffice('vigilante_calidad', 'cron', '2026-08-27')).rejects.toThrow(/connection reset/);
    expect(encolarPieza).not.toHaveBeenCalled();
    expect((registrarCorrida.mock.calls[0][2] as Record<string, unknown>).estado).toBe('fallo');
  });

  it('un conteo que PostgREST no devolvió no es un 0 — se falla y se dice', async () => {
    encolarRespuesta('cola_aprobacion', { count: null, error: null });
    await expect(correrAgenteBackOffice('vigilante_calidad', 'cron', '2026-08-27'))
      .rejects.toThrow(/no devolvió el conteo/);
  });
});

// ── 2 · Documentación ─────────────────────────────────────────────────────

describe('documentación: el drift del catálogo contra el censo propio', () => {
  it('sin censo previo NO inventa deltas: es línea base y lo dice', () => {
    const fichas = [ficha({ id: 'a' }), ficha({ id: 'b' })];
    expect(compararCatalogo(fichas, null).filter((c) => c.tipo !== 'sin_descripcion')).toHaveLength(0);
    const cuerpo = armarParteDocumentacion(fichas, [], '2026-08-24', false, null);
    expect(cuerpo).toContain('LÍNEA BASE');
    expect(cuerpo).not.toContain('CAMBIOS:');
  });

  it('caza el flip de estado SIN NOTA: se encendió y la descripción sigue igual', () => {
    const antes = censoDe([ficha({ id: 'talento', estado: 'disenado' })]);
    const cambios = compararCatalogo([ficha({ id: 'talento', estado: 'vivo' })], antes);
    const flip = cambios.find((c) => c.tipo === 'flip_estado');
    expect(flip?.detalle).toContain('disenado → vivo');
    expect(flip?.detalle).toContain('flip sin nota');
  });

  it('el mismo flip CON descripción nueva no se acusa de falta de nota', () => {
    const antes = censoDe([ficha({ id: 'talento', estado: 'disenado', descripcion: 'lo de antes, con largo suficiente para el mínimo' })]);
    const cambios = compararCatalogo([ficha({ id: 'talento', estado: 'vivo', descripcion: 'lo construido, con largo suficiente para el mínimo' })], antes);
    expect(cambios.find((c) => c.tipo === 'flip_estado')?.detalle).toContain('con descripción actualizada');
  });

  it('detecta altas, bajas, flip del runner y cambio de descripción a secas', () => {
    const antes = censoDe([ficha({ id: 'viejo' }), ficha({ id: 'queda', runnerHabilitado: true })]);
    const cambios = compararCatalogo([
      ficha({ id: 'nuevo' }),
      ficha({ id: 'queda', runnerHabilitado: false, descripcion: 'otra descripción, también con largo suficiente' }),
    ], antes);
    expect(cambios.map((c) => c.tipo)).toEqual(
      expect.arrayContaining(['alta', 'baja', 'flip_runner', 'descripcion']),
    );
  });

  it('la deuda documental solo mira a los VIVOS: un «disenado» sin texto es blueprint por escribir', () => {
    const cambios = compararCatalogo([
      ficha({ id: 'vivo_pelon', descripcion: 'corta', promptRef: null }),
      ficha({ id: 'en_diseno', estado: 'disenado', descripcion: null, promptRef: null }),
    ], null);
    const huecos = cambios.filter((c) => c.tipo === 'sin_descripcion');
    expect(huecos).toHaveLength(1);
    expect(huecos[0].agente).toBe('vivo_pelon');
    expect(huecos[0].detalle).toContain('sin prompt_ref');
  });

  it('un VIVO determinista (modeloRol null) sin prompt_ref NO se marca como deuda documental (auditoría 25, DATOS-M1)', () => {
    // 0303 dejó `prompt_ref = NULL` en nueve agentes vivos deterministas a
    // propósito: no llaman a un modelo con un prompt externo, así que no hay
    // referencia que documentar. Antes de este arreglo, esto disparaba una
    // alarma permanente que nadie podía apagar — con descripción útil y todo.
    const cambios = compararCatalogo([
      ficha({ id: 'cazador', promptRef: null, modeloRol: null }),
    ], null);
    expect(cambios.filter((c) => c.tipo === 'sin_descripcion')).toHaveLength(0);
  });

  it('huellaDescripcion distingue textos y trata el nulo como cadena vacía', () => {
    expect(huellaDescripcion('a')).not.toBe(huellaDescripcion('b'));
    expect(huellaDescripcion(null)).toBe(huellaDescripcion(''));
  });

  it('la corrida deja el CENSO en las fuentes — sin él, el parte siguiente sería línea base para siempre', async () => {
    encolarRespuesta('cola_aprobacion', { count: 0, error: null }); // parteExistente
    encolarRespuesta('agente_definicion', {
      data: [{ id: 'talento', nombre: 'Talento', departamento: 'back_office', estado: 'vivo', runner_habilitado: true, descripcion: 'una descripción larga y suficiente para el mínimo declarado', prompt_ref: 'x.md' }],
      error: null,
    });
    encolarRespuesta('cola_aprobacion', { // censo previo
      data: [{ titulo: 'Documentación — semana del 2026-08-17', fuentes: { censo: { talento: { e: 'disenado', r: false, d: 'zzz' } } } }],
      error: null,
    });
    const r = await correrAgenteBackOffice('documentacion', 'cron', '2026-08-27');
    expect(r.piezas).toBe(1);
    const pieza = encolarPieza.mock.calls[0][0] as Record<string, unknown>;
    expect(pieza.titulo).toBe('Documentación — semana del 2026-08-24');
    expect(String(pieza.cuerpo)).toContain('disenado → vivo');
    expect((pieza.fuentes as Record<string, unknown>).censo).toHaveProperty('talento');
  });

  it('un parte previo con fuentes ilegibles se trata como SIN censo, no como catálogo vacío', async () => {
    encolarRespuesta('cola_aprobacion', { count: 0, error: null });
    encolarRespuesta('agente_definicion', {
      data: [{ id: 'talento', nombre: 'T', departamento: 'back_office', estado: 'vivo', runner_habilitado: true, descripcion: 'una descripción larga y suficiente para el mínimo declarado', prompt_ref: 'x.md' }],
      error: null,
    });
    encolarRespuesta('cola_aprobacion', { data: [{ titulo: 'viejo', fuentes: null }], error: null });
    await correrAgenteBackOffice('documentacion', 'cron', '2026-08-27');
    const cuerpo = String((encolarPieza.mock.calls[0][0] as Record<string, unknown>).cuerpo);
    expect(cuerpo).toContain('LÍNEA BASE');
    expect(cuerpo).not.toContain('BAJA:');
  });
});

// ── 3 · Legal y compliance ────────────────────────────────────────────────

describe('legal: los relojes de Likida-empresa', () => {
  it('comprobarPublicacion tiene TRES ramas y la red caída jamás dice «publicado»', async () => {
    const falso = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/privacidad')) return { status: 200 } as Response;
      throw new Error('ECONNREFUSED');
    });
    const r = await comprobarPublicacion(RUTAS_LEGALES, 'https://x.test', falso as unknown as typeof fetch);
    expect(r.find((p) => p.ruta === '/privacidad')?.estado).toBe('publicado');
    const otra = r.find((p) => p.ruta === '/aviso/prospectos');
    expect(otra?.estado).toBe('no_comprobado');
    expect(otra?.detalle).toContain('NO se afirma');
  });

  it('un 404 es «no responde», no «no comprobado»', async () => {
    const falso = vi.fn(async () => ({ status: 404 }) as Response);
    const r = await comprobarPublicacion(['/privacidad'], 'https://x.test', falso as unknown as typeof fetch);
    expect(r[0].estado).toBe('no_responde');
    expect(r[0].detalle).toContain('404');
  });

  it('el parte cita el art. 31, cuenta las vencidas y NO inventa fechas societarias', () => {
    const { cuerpo, vencidas } = armarParteLegal({
      hoy: '2026-08-27', lunes: '2026-08-24',
      publicaciones: { valor: [{ ruta: '/privacidad', estado: 'publicado', detalle: 'ok' }], error: null },
      entidad: { listo: false, faltantes: ['LEGAL_ENTITY_NAME', 'LEGAL_DPA_VERSION'], faltantesEntidad: ['LEGAL_ENTITY_NAME'], faltantesDocumentos: ['LEGAL_DPA_VERSION'], bloqueado: true },
      arco: {
        valor: [
          { id: 'aaaaaaaa-1111-2222-3333-444444444444', tipo: 'acceso', estado: 'recibida', recibidaEn: '2026-07-01T00:00:00Z', venceEn: '2026-08-20' },
          { id: 'bbbbbbbb-1111-2222-3333-444444444444', tipo: 'cancelacion', estado: 'en_proceso', recibidaEn: '2026-08-20T00:00:00Z', venceEn: '2026-09-10' },
        ],
        error: null,
      },
      societarios: { valor: [{ id: 'sapi', titulo: 'Conversión a SAPI', detalle: null, estado: 'bloqueado_por_javier', fechaObjetivo: null }], error: null },
    });
    expect(vencidas).toBe(1);
    expect(cuerpo).toContain('art. 31');
    expect(cuerpo).toContain('VENCIDA hace 7 día(s)');
    expect(cuerpo).toContain('restan 14 día(s)');
    expect(cuerpo).toContain('SIN FECHA DECLARADA');
    expect(cuerpo).toContain('BLOQUEANTE');
    expect(cuerpo).toContain('no firma, no contesta a una autoridad');
  });

  it('una fuente ciega se dice; jamás se escribe como «ninguna pendiente»', () => {
    const { cuerpo, vencidas } = armarParteLegal({
      hoy: '2026-08-27', lunes: '2026-08-24',
      publicaciones: { valor: null, error: 'publicación de los avisos' },
      entidad: { listo: true, faltantes: [], faltantesEntidad: [], faltantesDocumentos: [], bloqueado: false },
      arco: { valor: null, error: 'solicitudes ARCO' },
      societarios: { valor: null, error: 'pendientes societarios' },
    });
    expect(vencidas).toBe(0);
    expect(cuerpo).toContain('NO SE PUDO COMPROBAR');
    expect(cuerpo).toContain('NO SE PUDO LEER solicitud_arco');
    expect(cuerpo).toContain('Es un hallazgo, no un cero');
    expect(cuerpo).not.toContain('Ninguna pendiente');
  });

  it('la corrida alerta al operador cuando hay un plazo ARCO vencido', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 }) as Response));
    encolarRespuesta('cola_aprobacion', { count: 0, error: null }); // parteExistente
    encolarRespuesta('solicitud_arco', {
      data: [{ id: 'aaaaaaaa-1111-2222-3333-444444444444', tipo: 'acceso', estado: 'recibida', recibida_en: '2026-07-01T00:00:00Z', vence_en: '2026-08-01' }],
      error: null,
    });
    encolarRespuesta('pendiente_societario', { data: [], error: null });
    const r = await correrAgenteBackOffice('legal_compliance', 'cron', '2026-08-27');
    expect(r.piezas).toBe(1);
    expect(alertarOperador).toHaveBeenCalledTimes(1);
    expect(String((alertarOperador.mock.calls[0][1] as Record<string, unknown>).error)).toContain('art. 31');
    const pieza = encolarPieza.mock.calls[0][0] as Record<string, unknown>;
    expect(pieza.titulo).toBe('Legal — semana del 2026-08-24');
    expect((pieza.fuentes as Record<string, unknown>).arco_vencidas).toBe(1);
  });

  it('el parte sale IGUAL con una fuente caída, y la corrida deja escrito cuál', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 }) as Response));
    encolarRespuesta('cola_aprobacion', { count: 0, error: null });
    encolarRespuesta('solicitud_arco', { data: null, error: { message: 'timeout' } });
    encolarRespuesta('pendiente_societario', { data: [], error: null });
    const r = await correrAgenteBackOffice('legal_compliance', 'cron', '2026-08-27');
    expect(r.piezas).toBe(1);
    expect(alertarOperador).not.toHaveBeenCalled();
    const resumen = registrarCorrida.mock.calls[0][2] as Record<string, unknown>;
    expect((resumen.resumen as Record<string, unknown>).fuentes_ciegas).toEqual(['solicitudes ARCO']);
  });
});

// ── 4 · Talento ───────────────────────────────────────────────────────────

const correlerTalento = () => correrAgenteBackOffice('talento', 'cron', '2026-08-27');

describe('talento: el registro y la criba', () => {
  it('normalizar ignora acentos y mayúsculas', () => {
    expect(normalizar('Camión Logístico')).toBe('camion logistico');
  });

  it('sin requisitos declarados el puntaje es NULL, jamás 0', () => {
    const c = evaluarCandidato('mucho texto', { obligatorios: [], deseables: [] });
    expect(c.puntaje).toBeNull();
    expect(c.motivo).toContain('no hay vara');
  });

  it('sin perfil capturado tampoco se puntúa', () => {
    const c = evaluarCandidato(null, { obligatorios: ['SAT'], deseables: [] });
    expect(c.puntaje).toBeNull();
    expect(c.faltantes).toEqual(['SAT']);
  });

  it('puntúa por requisitos declarados: los obligatorios pesan doble y el motivo es auditable', () => {
    const req = { obligatorios: ['SAT', 'Excel'], deseables: ['inglés'] };
    const todo = evaluarCandidato('Contadora con experiencia en SAT, Excel avanzado e Inglés', req);
    expect(todo.puntaje).toBe(100);
    expect(todo.cumpleObligatorios).toBe(true);
    const medio = evaluarCandidato('Manejo de excel y algo de ingles', req);
    expect(medio.cumpleObligatorios).toBe(false);
    expect(medio.puntaje).toBe(60); // (2 + 1) de 5
    expect(medio.motivo).toContain('le faltan obligatorios: SAT');
    expect(medio.faltantes).toContain('SAT');
  });

  it('con CERO vacantes abiertas no fabrica pieza: anota la corrida 0/0 y dice que despierta con una vacante', async () => {
    encolarRespuesta('vacante', { data: [], error: null });
    const r = await correrAgenteBackOffice('talento', 'cron', '2026-08-27');
    expect(r.piezas).toBe(0);
    expect(r.motivo).toContain('despierta cuando declares una');
    expect(encolarPieza).not.toHaveBeenCalled();
    const anotada = registrarCorrida.mock.calls[0][2] as Record<string, unknown>;
    // 0/0 a propósito: el detector de «verde vacío» exige tareas_total > 0.
    expect(anotada.tareasHechas).toBe(0);
    expect(anotada.tareasTotal).toBe(0);
    expect(anotada.estado).toBe('ok');
  });

  it('con vacante abierta criba, marca `cribado` (nunca «descartado») y encola la terna', async () => {
    encolarRespuesta('vacante', {
      data: [{ id: 'v1', clave: 'contador', titulo: 'Contador', requisitos: { obligatorios: ['SAT'], deseables: ['Excel'] } }],
      error: null,
    });
    encolarRespuesta('cola_aprobacion', { count: 0, error: null }); // parteExistente
    encolarRespuesta('candidato', {
      data: [
        { id: 'c1', vacante_id: 'v1', nombre: 'Ana', correo: 'ana@x.mx', perfil: 'Auditorías ante el SAT y Excel' },
        { id: 'c2', vacante_id: 'v1', nombre: 'Beto', correo: 'beto@x.mx', perfil: 'Ventas' },
      ],
      error: null,
    });
    encolarRespuesta('candidato', { data: null, error: null }); // update c1
    encolarRespuesta('candidato', { data: null, error: null }); // update c2

    const r = await correrAgenteBackOffice('talento', 'cron', '2026-08-27');
    expect(r.piezas).toBe(1);
    expect(updates).toHaveLength(2);
    for (const u of updates) expect(u.fila.estado).toBe('cribado');
    expect(updates[0].fila.puntaje).toBe(100);
    expect(updates[1].fila.puntaje).toBe(0); // midió y salió 0: eso SÍ es un 0
    const cuerpo = String((encolarPieza.mock.calls[0][0] as Record<string, unknown>).cuerpo);
    expect(cuerpo).toContain('Ana — 100/100');
    expect(cuerpo).toContain('LA CRIBA NO DESCARTA A NADIE');
  });

  it('el parte ordena por puntaje y manda los SIN puntaje al final (un NULL no es un 0)', () => {
    const cuerpo = armarParteTalento(
      [{ id: 'v1', clave: 'k', titulo: 'T', requisitos: { obligatorios: ['SAT'], deseables: [] } }],
      [
        { id: 'a', vacanteId: 'v1', nombre: 'SinPerfil', correo: 'a@x.mx', perfil: null, criba: evaluarCandidato(null, { obligatorios: ['SAT'], deseables: [] }) },
        { id: 'b', vacanteId: 'v1', nombre: 'ConSAT', correo: 'b@x.mx', perfil: 'SAT', criba: evaluarCandidato('SAT', { obligatorios: ['SAT'], deseables: [] }) },
      ],
      3, '2026-08-24',
    );
    expect(cuerpo.indexOf('ConSAT')).toBeLessThan(cuerpo.indexOf('SinPerfil'));
    expect(cuerpo).toContain('Quedan 3 candidato(s) sin cribar');
    expect(cuerpo).toContain('deny-all');
  });

  it('la vacante sin requisitos lo declara en el parte en vez de fingir una vara', () => {
    const cuerpo = armarParteTalento([{ id: 'v1', clave: 'k', titulo: 'T', requisitos: null }], [], 0, '2026-08-24');
    expect(cuerpo).toContain('SIN REQUISITOS DECLARADOS');
    expect(cuerpo).toContain('Sin candidatos nuevos por cribar');
  });

  // ── c6-6: la criba corre en TODA corrida; lo semanal es el parte ────────

  it('con el parte de la semana YA fabricado, la criba SIGUE corriendo', async () => {
    encolarRespuesta('vacante', {
      data: [{ id: 'v1', clave: 'contador', titulo: 'Contador', requisitos: { obligatorios: ['SAT'], deseables: [] } }],
      error: null,
    });
    encolarRespuesta('candidato', {
      data: [{ id: 'c1', vacante_id: 'v1', nombre: 'Ana', correo: 'ana@x.mx', perfil: 'Auditorías ante el SAT' }],
      error: null,
    });
    encolarRespuesta('candidato', { data: null, error: null });      // el UPDATE de la criba
    encolarRespuesta('cola_aprobacion', { count: 1, error: null });  // el parte YA existe

    const r = await correlerTalento();
    // Cero piezas (el parte ya estaba) pero UNA criba escrita: antes de c6-6
    // la corrida se cortaba antes y Ana se quedaba en 'recibido' una semana.
    expect(r.piezas).toBe(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].fila.estado).toBe('cribado');
    expect(r.motivo).toContain('se cribaron 1 candidato(s) nuevo(s)');
    // Y la corrida NO se anota como trabajo vacío: hizo 1 de 1.
    const anotada = registrarCorrida.mock.calls[0][2] as Record<string, unknown>;
    expect(anotada.tareasHechas).toBe(1);
    expect(anotada.tareasTotal).toBe(1);
  });

  it('con el parte ya fabricado y NADIE nuevo, la corrida es 0/0 — no dispara «verde vacío»', async () => {
    encolarRespuesta('vacante', { data: [{ id: 'v1', clave: 'k', titulo: 'T', requisitos: null }], error: null });
    encolarRespuesta('candidato', { data: [], error: null });
    encolarRespuesta('cola_aprobacion', { count: 1, error: null });
    const r = await correlerTalento();
    expect(r.piezas).toBe(0);
    expect(r.motivo).toContain('no había candidatos nuevos por cribar');
    const anotada = registrarCorrida.mock.calls[0][2] as Record<string, unknown>;
    expect(anotada.tareasHechas).toBe(0);
    expect(anotada.tareasTotal).toBe(0);
  });

  it('una escritura de criba que falla tumba la corrida — no se encola un parte sobre datos a medias', async () => {
    encolarRespuesta('vacante', { data: [{ id: 'v1', clave: 'k', titulo: 'T', requisitos: null }], error: null });
    encolarRespuesta('cola_aprobacion', { count: 0, error: null });
    encolarRespuesta('candidato', { data: [{ id: 'c1', vacante_id: 'v1', nombre: 'Ana', correo: 'a@x.mx', perfil: null }], error: null });
    encolarRespuesta('candidato', { data: null, error: { message: 'deadlock detected' } });
    await expect(correrAgenteBackOffice('talento', 'cron', '2026-08-27')).rejects.toThrow(/deadlock/);
    expect(encolarPieza).not.toHaveBeenCalled();
    expect((registrarCorrida.mock.calls[0][2] as Record<string, unknown>).estado).toBe('fallo');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EL RELOJ DE LA VUELTA EN TALENTO (auditoría ciclo 7, c7-1).
//
// `correrTalento` es el único de los cuatro del back office que itera una lista
// de trabajo con I/O por elemento: un UPDATE por candidato, hasta 25 por
// corrida, en serie. Los otros tres arman su parte con un juego fijo de
// consultas y no tienen bucle que cronometrar.
//
// El auditor señaló que la suite no atrapaba c7-1 porque «no hay una sola
// prueba en la que un agente ya despachado se pase del presupuesto». Ésta es
// esa prueba para el back office.
// ═══════════════════════════════════════════════════════════════════════════

describe('el reloj de la vuelta corta la criba de talento, y lo DICE (c7-1)', () => {
  const RELOJ_VENCIDO = () => Date.now() - 1;

  it('con el reloj vencido no escribe ni una criba y NO sella el parte semanal con la lista a medias', async () => {
    encolarRespuesta('vacante', {
      data: [{ id: 'v1', clave: 'contador', titulo: 'Contador', requisitos: { obligatorios: ['SAT'], deseables: ['Excel'] } }],
      error: null,
    });
    encolarRespuesta('cola_aprobacion', { count: 0, error: null }); // parteExistente
    encolarRespuesta('candidato', {
      data: [
        { id: 'c1', vacante_id: 'v1', nombre: 'Ana', correo: 'ana@x.mx', perfil: 'Auditorías ante el SAT y Excel' },
        { id: 'c2', vacante_id: 'v1', nombre: 'Beto', correo: 'beto@x.mx', perfil: 'Ventas' },
      ],
      error: null,
    });

    const r = await correrAgenteBackOffice('talento', 'cron', '2026-08-27', RELOJ_VENCIDO());

    // CORTA: ni un UPDATE de criba.
    expect(updates).toHaveLength(0);
    // CUENTA: `sinTurno` sube y con él el runner mete al agente en
    // `saltadosPorReloj`, que es lo que hace que el latido diga 'parcial'.
    expect(r).toMatchObject({ piezas: 0, sinTurno: true });
    expect(r.motivo).toMatch(/2 candidato\(s\) sin mirar/);
    expect(r.motivo).toMatch(/SEMANAL/);
    // NO DEJA EL ESTADO A MEDIAS: el título de la semana NO queda sellado. Si
    // se sellara, los candidatos que no entraron quedarían invisibles hasta el
    // lunes que viene — el índice único haría «ya_existia» en cada pasada.
    expect(encolarPieza).not.toHaveBeenCalled();
  });

  it('sin reloj la criba corre entera — el parámetro es opcional a propósito', async () => {
    encolarRespuesta('vacante', {
      data: [{ id: 'v1', clave: 'contador', titulo: 'Contador', requisitos: { obligatorios: ['SAT'], deseables: ['Excel'] } }],
      error: null,
    });
    encolarRespuesta('cola_aprobacion', { count: 0, error: null });
    encolarRespuesta('candidato', {
      data: [{ id: 'c1', vacante_id: 'v1', nombre: 'Ana', correo: 'ana@x.mx', perfil: 'Auditorías ante el SAT y Excel' }],
      error: null,
    });
    encolarRespuesta('candidato', { data: null, error: null });

    const r = await correrAgenteBackOffice('talento', 'cron', '2026-08-27');
    expect(r.piezas).toBe(1);
    expect(r.sinTurno).toBeUndefined();
    expect(updates).toHaveLength(1);
  });
});
