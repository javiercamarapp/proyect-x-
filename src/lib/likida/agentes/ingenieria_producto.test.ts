import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// INGENIERÍA (0234) — los cuatro que NO miran el esquema: pruebas,
// auditor_codigo, producto y datos_instrumentacion.
//
// Lo que estas pruebas defienden, antes que nada, es la HONESTIDAD DE ALCANCE:
// que `pruebas` diga en su propio cuerpo que no corrió una sola prueba, que
// `auditor_codigo` diga que no leyó una línea de código, y que los dos dejen
// escrito el encargo de la rutina local. Un parte que afirmara lo contrario
// sería la mentira más cara que este producto puede contar sobre sí mismo.
// ═══════════════════════════════════════════════════════════════════════════

type Resp = { data?: unknown; error?: { message: string } | null; count?: number };
const respuestas = new Map<string, Resp[]>();
const rpcs = new Map<string, Resp[]>();

function builder(tabla: string) {
  const responder = (): Resp => {
    const cola = respuestas.get(tabla);
    return cola && cola.length > 0 ? cola.shift() as Resp : { data: [], error: null, count: 0 };
  };
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: () => b, eq: () => b, is: () => b, neq: () => b, not: () => b,
    gte: () => b, lt: () => b, order: () => b, limit: () => b, range: () => b,
    insert: () => b, update: () => b,
    then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve().then(responder).then(res, rej),
  });
  return b;
}
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (t: string) => builder(t),
    rpc: (fn: string) => {
      const cola = rpcs.get(fn);
      return Promise.resolve(cola && cola.length > 0 ? cola.shift() as Resp : { data: null, error: { message: `sin respuesta encolada para ${fn}` } });
    },
  }),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/likida/presupuesto', () => ({ acotada: (q: unknown) => q }));

const encolar = vi.fn(async (_p: unknown) => 'pieza-1');
vi.mock('./cola', () => ({ encolarPieza: (p: unknown) => encolar(p) }));

const registrar = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('./corridas', () => ({ registrarCorrida: (...a: unknown[]) => registrar(...a) }));

const alertar = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('@/lib/observability/alerta', () => ({ alertarOperador: (...a: unknown[]) => alertar(...a) }));

// La lista de palancas del BUNDLE se controla desde aquí: el drift contra el
// dominio del CHECK es justo lo que `auditor_codigo` existe para cazar.
vi.mock('../interruptores', () => ({
  INTERRUPTORES: ['global', 'agente:migraciones', 'agente:seguridad'],
  estaApagado: async () => false,
}));

// El runner entra por import dinámico dentro del agente. Se mockea para no
// arrastrar el redactor, la prospección y los financieros a esta suite.
let despachables: readonly string[] | undefined = ['migraciones', 'seguridad'];
vi.mock('./runner', () => ({ get AGENTES_DESPACHABLES() { return despachables; } }));

const {
  correrAgenteIngenieriaProducto,
  firmaDeError, patronesDeError, evaluarPruebas, armarPartePruebas, encargoLocal,
  palancasDelCheck, evaluarAuditorCodigo, armarParteAuditor,
  evaluarProducto, armarParteProducto,
  PREGUNTAS, estadoDeFuentes, evaluarInstrumentacion, armarParteInstrumentacion,
} = await import('./ingenieria_producto');

const HOY = '2026-08-27'; // jueves
const LUNES = '2026-08-24';
const SEMANA_AUDITADA = '2026-08-17';

function ultimo(): { titulo: string; cuerpo: string; fuentes: Record<string, unknown> } {
  const p = encolar.mock.calls.at(-1)?.[0] as { titulo: string; cuerpo: string; fuentes: Record<string, unknown> } | undefined;
  return p ?? { titulo: '', cuerpo: '', fuentes: {} };
}

const ficha = (id: string, over: Partial<{ estado: string; runnerHabilitado: boolean; disparador: string }> = {}) => ({
  id, nombre: id, departamento: 'ingenieria', presupuestoDiaUsd: 0.1,
  estado: 'vivo', runnerHabilitado: true, disparador: 'cron', ...over,
});

beforeEach(() => {
  respuestas.clear();
  rpcs.clear();
  encolar.mockClear();
  encolar.mockResolvedValue('pieza-1');
  registrar.mockClear();
  alertar.mockClear();
  despachables = ['migraciones', 'seguridad'];
  vi.unstubAllEnvs();
});

// ── 5 · PRUEBAS ────────────────────────────────────────────────────────────

describe('la firma de un error', () => {
  it('borra folios, fechas y números: dos fallos del mismo bug comparten firma', () => {
    const a = firmaDeError('viaje 3f1b2c4d-1111-2222-3333-444455556666 sin cuadre el 2026-08-01 (12 gastos)');
    const b = firmaDeError('viaje 9a1b2c4d-9999-8888-7777-666655554444 sin cuadre el 2026-08-05 (40 gastos)');
    expect(a).toBe(b);
    expect(a).toContain('<uuid>');
  });

  it('un error vacío no es una firma', () => {
    expect(firmaDeError(null)).toBeNull();
    expect(firmaDeError('   ')).toBeNull();
  });

  it('un fallo ÚNICO no es patrón: solo se agrupa lo que se repite', () => {
    const base = { estado: 'fallo' as const, inicio: '2026-08-18T00:00:00Z', tareasHechas: 0, tareasTotal: 1 };
    const p = patronesDeError([
      { agente: 'a', ...base, error: 'timeout de red' },
      { agente: 'b', ...base, error: 'timeout de red' },
      { agente: 'c', ...base, error: 'algo irrepetible' },
      { agente: 'd', estado: 'ok', inicio: '2026-08-18T00:00:00Z', tareasHechas: 1, tareasTotal: 1, error: null },
    ]);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ veces: 2, agentes: ['a', 'b'] });
  });
});

describe('el detector de pruebas', () => {
  const sinCatalogo = { valor: null, error: 'catálogo' };
  const sinLatidos = { valor: null, error: 'latidos' };
  const AHORA = Date.parse('2026-08-24T00:00:00Z');
  const VENTANA = { desde: '2026-08-17', hasta: '2026-08-23' };
  // Un corte ANTERIOR a la ventana: no excluye nada (el código no cambió).
  const CORTE_VIEJO = { sha: 'abc1234def', primeraVista: '2026-08-10T00:00:00Z' };

  it('fallos absolutos primero; la mayoría en fallo es ROJO, y el conteo lleva su periodo', () => {
    const h = evaluarPruebas([
      { agente: 'x', estado: 'fallo', inicio: '2026-08-20T00:00:00Z', tareasHechas: 0, tareasTotal: 1, error: 'tronó' },
      { agente: 'x', estado: 'fallo', inicio: '2026-08-19T00:00:00Z', tareasHechas: 0, tareasTotal: 1, error: 'tronó' },
    ], false, sinCatalogo, sinLatidos, AHORA, VENTANA, CORTE_VIEJO);
    const t1 = h.find((x) => x.codigo === 'T1');
    expect(t1?.semaforo).toBe('ROJO');
    expect(t1?.evidencia).toContain('prueba de regresión');
    // Nunca un conteo sin periodo: la fecha inicial y la final van escritas.
    expect(t1?.detalle).toContain('entre el 2026-08-17 y el 2026-08-23');
  });

  // ── LA PRUEBA QUE FALTABA (correo en falso #3 del 28-ago-2026) ───────────
  it('un fallo ANTERIOR a la primera vista del SHA vigente NO se cuenta: es historia, y se declara como nota', () => {
    const corte = { sha: 'abc1234def', primeraVista: '2026-08-21T00:00:00Z' };
    const fallo = { estado: 'fallo' as const, tareasHechas: 0, tareasTotal: 1, error: 'firma vieja del bug ya arreglado' };
    const h = evaluarPruebas([
      // 12 fallos del código anterior — el caso real: cerrados por PR y desplegados.
      ...Array.from({ length: 12 }, (_, i) => ({ agente: 'redactor', inicio: `2026-08-18T0${i % 10}:00:00Z`, ...fallo })),
      // Bajo el código vigente, el agente corre en ok.
      { agente: 'redactor', estado: 'ok' as const, inicio: '2026-08-22T00:00:00Z', tareasHechas: 1, tareasTotal: 1, error: null },
    ], false, sinCatalogo, sinLatidos, AHORA, VENTANA, corte);
    // Ni T1 ni T3: ningún fallo es del código vigente.
    expect(h.some((x) => x.codigo === 'T1')).toBe(false);
    expect(h.some((x) => x.codigo === 'T3')).toBe(false);
    // Pero la historia NO desaparece: queda como nota con su conteo y el corte.
    const t6 = h.find((x) => x.codigo === 'T6');
    expect(t6?.semaforo).toBe('NOTA');
    expect(t6?.objeto).toContain('12 fallo(s)');
    expect(t6?.detalle).toContain('abc1234');
  });

  it('el mismo fallo DESPUÉS del corte sí cuenta: la firma reaparecida vuelve sola', () => {
    const corte = { sha: 'abc1234def', primeraVista: '2026-08-21T00:00:00Z' };
    const fallo = { estado: 'fallo' as const, tareasHechas: 0, tareasTotal: 1, error: 'firma que volvió' };
    const h = evaluarPruebas([
      { agente: 'x', inicio: '2026-08-22T00:00:00Z', ...fallo },
      { agente: 'x', inicio: '2026-08-22T01:00:00Z', ...fallo },
    ], false, sinCatalogo, sinLatidos, AHORA, VENTANA, corte);
    expect(h.some((x) => x.codigo === 'T1')).toBe(true);
    const t3 = h.find((x) => x.codigo === 'T3');
    expect(t3?.detalle).toContain('entre el 2026-08-21 y el 2026-08-23');
  });

  it('sin corte de despliegue los conteos no se acotan Y el parte lo declara (T6)', () => {
    const h = evaluarPruebas([], false, sinCatalogo, sinLatidos, AHORA, VENTANA, null);
    const t6 = h.find((x) => x.codigo === 'T6');
    expect(t6?.semaforo).toBe('NOTA');
    expect(t6?.detalle).toContain('no se pudo saber desde cuándo corre el código vigente');
  });

  it('VERDE VACÍO es ROJO aunque no haya un solo fallo — es la lección de las 216 corridas verdes', () => {
    const h = evaluarPruebas([
      { agente: 'y', estado: 'ok', inicio: '2026-08-20T00:00:00Z', tareasHechas: 0, tareasTotal: 5, error: null },
    ], false, sinCatalogo, sinLatidos, AHORA, VENTANA, CORTE_VIEJO);
    const t2 = h.find((x) => x.codigo === 'T2');
    expect(t2?.semaforo).toBe('ROJO');
    expect(t2?.evidencia).toContain('afirma el EFECTO');
  });

  it('una corrida ok con 0 de 0 tareas NO es verde vacío: no se propuso nada', () => {
    const h = evaluarPruebas([
      { agente: 'y', estado: 'ok', inicio: '2026-08-20T00:00:00Z', tareasHechas: 0, tareasTotal: 0, error: null },
    ], false, sinCatalogo, sinLatidos, AHORA, VENTANA, CORTE_VIEJO);
    expect(h.some((x) => x.codigo === 'T2')).toBe(false);
  });

  it('la ventana truncada se DICE, y se dice cuáles faltan (las más viejas)', () => {
    const h = evaluarPruebas([], true, sinCatalogo, sinLatidos, AHORA, VENTANA, CORTE_VIEJO);
    expect(h.find((x) => x.codigo === 'T0')?.evidencia).toContain('MÁS VIEJAS');
  });

  it('un agente vivo SIN una sola corrida no se lee como «no falló»', () => {
    const h = evaluarPruebas([], false, { valor: [ficha('mudo')], error: null }, sinLatidos, AHORA, VENTANA, CORTE_VIEJO);
    const t4 = h.find((x) => x.codigo === 'T4');
    expect(t4?.objeto).toBe('mudo');
    expect(t4?.evidencia).toContain('no consta que se hayan intentado');
  });

  it('un cron mudo hace que TODO conteo de la ventana sea un piso, y el parte lo dice', () => {
    const h = evaluarPruebas([], false, sinCatalogo, {
      valor: [{ id: 'runner', estado: 'ok', ultimo: '2026-08-20T00:00:00Z' }], error: null,
    }, AHORA, VENTANA, CORTE_VIEJO);
    const t5 = h.find((x) => x.codigo === 'T5');
    expect(t5?.semaforo).toBe('ROJO');
    expect(t5?.evidencia).toContain('un piso, no una medida');
  });

  it('un cron con latido fresco y estado ok no dispara nada', () => {
    const h = evaluarPruebas([], false, sinCatalogo, {
      valor: [{ id: 'runner', estado: 'ok', ultimo: '2026-08-23T23:00:00Z' }], error: null,
    }, AHORA, VENTANA, CORTE_VIEJO);
    expect(h.some((x) => x.codigo === 'T5')).toBe(false);
  });
});

describe('el encargo de la rutina local', () => {
  it('nombra los cinco comandos y el commit sobre el que hay que correrlos', () => {
    const texto = encargoLocal('abc1234').join('\n');
    expect(texto).toContain('abc1234');
    expect(texto).toContain('npx tsc --noEmit');
    expect(texto).toContain('npx vitest run');
    expect(texto).toContain('--coverage');
    expect(texto).toContain('correr-verificaciones.mjs');
  });

  it('sin SHA no inventa uno: manda verificar en qué commit está producción', () => {
    expect(encargoLocal(null).join('\n')).toContain('SIN SHA DECLARADO');
  });
});

describe('el parte de pruebas', () => {
  it('dice, con esas palabras, que NO corrió una sola prueba', () => {
    const cuerpo = armarPartePruebas([], 0, 0, SEMANA_AUDITADA, '2026-08-23', 'abc1234', null);
    expect(cuerpo).toContain('no corrió una sola prueba');
    expect(cuerpo).toContain('Un parte que dijera «la suite pasa» sería mentira');
  });

  it('sin hallazgos NO afirma que la suite pase: afirma que producción no se quejó', () => {
    const cuerpo = armarPartePruebas([], 10, 3, SEMANA_AUDITADA, '2026-08-23', null, null);
    expect(cuerpo).toContain('Eso NO dice que la suite pase');
  });

  it('con corte declara desde qué SHA cuenta; sin corte declara que no se acotó', () => {
    const con = armarPartePruebas([], 10, 3, SEMANA_AUDITADA, '2026-08-23', 'abc1234def', null,
      { sha: 'abc1234def', primeraVista: '2026-08-21T05:00:00Z' });
    expect(con).toContain('SE CUENTAN DESDE EL DESPLIEGUE VIGENTE');
    expect(con).toContain('abc1234');
    const sin = armarPartePruebas([], 10, 3, SEMANA_AUDITADA, '2026-08-23', null, null, null);
    expect(sin).toContain('VENTANA SIN ACOTAR AL DESPLIEGUE');
  });
});

describe('la corrida de pruebas', () => {
  it('fabrica el parte de la semana CERRADA y guarda el SHA para que el encargo sea reproducible', async () => {
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'abc1234');
    respuestas.set('cola_aprobacion', [{ data: [], error: null, count: 0 }]);
    respuestas.set('agente_corrida', [{ data: [], error: null, count: 0 }]);
    respuestas.set('agente_definicion', [{ data: [], error: null }]);
    respuestas.set('cron_latido', [{ data: [], error: null }]);
    const r = await correrAgenteIngenieriaProducto('pruebas', 'cron', HOY);
    expect(r).toMatchObject({ resultado: 'corrio', piezas: 1, costoUsd: 0 });
    expect(ultimo().titulo).toBe(`Pruebas — semana del ${SEMANA_AUDITADA}`);
    expect(ultimo().fuentes.sha).toBe('abc1234');
  });

  it('una bitácora ilegible tumba la corrida: un parte sobre una bitácora ciega diría «nadie falló»', async () => {
    respuestas.set('cola_aprobacion', [{ data: [], error: null, count: 0 }]);
    respuestas.set('agente_corrida', [{ data: null, error: { message: 'base caída' } }]);
    await expect(correrAgenteIngenieriaProducto('pruebas', 'cron', HOY)).rejects.toThrow(/base caída/);
    expect(registrar.mock.calls.at(-1)?.[2]).toMatchObject({ estado: 'fallo' });
  });
});

// ── 6 · AUDITOR DE CÓDIGO ──────────────────────────────────────────────────

describe('el dominio del CHECK leído desde la base', () => {
  it('saca las palancas del texto del constraint', () => {
    expect(palancasDelCheck("CHECK ((id = ANY (ARRAY['global'::text, 'agente:x'::text])))"))
      .toEqual(['agente:x', 'global']);
  });

  it('un CHECK ausente o irreconocible devuelve null, NUNCA una lista vacía', () => {
    expect(palancasDelCheck(null)).toBeNull();
    expect(palancasDelCheck('CHECK (id is not null)')).toBeNull();
  });
});

describe('el auditor del artefacto desplegado', () => {
  const CHECK_OK = "CHECK (id = ANY (ARRAY['global'::text, 'agente:migraciones'::text, 'agente:seguridad'::text]))";

  it('un agente vivo que el BUNDLE no sabe despachar es ROJO — vivo en el catálogo, muerto en la práctica', () => {
    const h = evaluarAuditorCodigo([ficha('migraciones'), ficha('rendimiento')], ['migraciones'], ['global', 'agente:migraciones', 'agente:seguridad']);
    const c1 = h.find((x) => x.codigo === 'C1');
    expect(c1?.semaforo).toBe('ROJO');
    expect(c1?.objeto).toContain('rendimiento');
    expect(c1?.evidencia).toContain('la migración se aplicó y el deploy del código no');
  });

  it('una rama del bundle que apunta a un id inexistente en el catálogo es código muerto', () => {
    const h = evaluarAuditorCodigo([ficha('migraciones')], ['migraciones', 'fantasma'], ['global', 'agente:migraciones', 'agente:seguridad']);
    expect(h.find((x) => x.codigo === 'C2')?.objeto).toContain('fantasma');
  });

  it('un agente con rama y APAGADO en la base se lista como nota, no como hallazgo', () => {
    const h = evaluarAuditorCodigo(
      [ficha('migraciones'), ficha('seguridad', { runnerHabilitado: false })],
      ['migraciones', 'seguridad'], ['global', 'agente:migraciones', 'agente:seguridad'],
    );
    const c2 = h.filter((x) => x.codigo === 'C2');
    expect(c2).toHaveLength(1);
    expect(c2[0].semaforo).toBe('NOTA');
    expect(c2[0].objeto).toContain('seguridad');
  });

  it('sin la lista del bundle NO se afirma que estén todos cableados', () => {
    const h = evaluarAuditorCodigo([ficha('migraciones')], null, ['global', 'agente:migraciones']);
    expect(h.find((x) => x.codigo === 'C0')?.evidencia).toContain('NO se afirma');
  });

  it('una palanca del CÓDIGO que la base NO admite es ROJO: rebota justo el día del incidente', () => {
    // El mock de INTERRUPTORES trae `agente:seguridad`; el CHECK de abajo no.
    const h = evaluarAuditorCodigo([ficha('migraciones')], ['migraciones'], ['global', 'agente:migraciones']);
    const c3 = h.find((x) => x.codigo === 'C3');
    expect(c3?.semaforo).toBe('ROJO');
    expect(c3?.objeto).toContain('agente:seguridad');
    expect(c3?.evidencia).toContain('check_violation');
  });

  it('una palanca que la base admite y el bundle no conoce: la base va adelante del código', () => {
    const h = evaluarAuditorCodigo([ficha('migraciones')], ['migraciones'],
      ['global', 'agente:migraciones', 'agente:seguridad', 'agente:nuevo']);
    const c4 = h.find((x) => x.codigo === 'C4');
    expect(c4?.objeto).toContain('agente:nuevo');
    expect(c4?.evidencia).toContain('sin kill switch declarado');
  });

  it('un agente vivo sin palanca en el bundle es ROJO: el candado 1 lo salta en TODAS las vueltas', () => {
    const h = evaluarAuditorCodigo([ficha('rendimiento')], ['rendimiento'], ['global', 'agente:migraciones', 'agente:seguridad']);
    const c5 = h.find((x) => x.codigo === 'C5');
    expect(c5?.semaforo).toBe('ROJO');
    expect(c5?.evidencia).toContain('parecen encendidos y no producen nada');
  });

  it('sin el CHECK de la base NO se grita: es fuente ciega (NOTA), no un drift verificado — 28-ago-2026', () => {
    const h = evaluarAuditorCodigo([ficha('migraciones')], ['migraciones'], null);
    const c3 = h.find((x) => x.codigo === 'C3');
    expect(c3?.semaforo).toBe('NOTA');
    expect(c3?.evidencia).toContain('NO se afirma que haya drift');
  });

  it('todo alineado: ni un hallazgo', () => {
    expect(evaluarAuditorCodigo(
      [ficha('migraciones'), ficha('seguridad')], ['migraciones', 'seguridad'],
      (palancasDelCheck(CHECK_OK) as string[]),
    )).toEqual([]);
  });

  it('el parte declara que NO leyó una línea de código y que la rutina local sigue viva', () => {
    const cuerpo = armarParteAuditor([], [ficha('migraciones')], ['migraciones'], 'abc1234', LUNES, null);
    expect(cuerpo).toContain('No leyó una sola línea de código fuente y no puede');
    expect(cuerpo).toContain('auditor.mjs');
    expect(cuerpo).toContain('ARTEFACTO DESPLEGADO');
  });
});

describe('la corrida del auditor de código', () => {
  it('fabrica el parte y guarda cuántas palancas trae el bundle contra cuántas la base', async () => {
    respuestas.set('cola_aprobacion', [{ data: [], error: null, count: 0 }]);
    respuestas.set('agente_definicion', [{ data: [{ id: 'migraciones', nombre: 'V', departamento: 'ingenieria', estado: 'vivo', runner_habilitado: true, disparador: 'cron', presupuesto_dia_usd: 0.1 }], error: null }]);
    rpcs.set('contrato_de_esquema', [{ data: { interruptor_check: "ARRAY['global'::text, 'agente:migraciones'::text, 'agente:seguridad'::text]", tenant_sin_rls: [], fks_simples_entre_tenantizadas: [], indices_unicos_parciales_cola: [] }, error: null }]);
    const r = await correrAgenteIngenieriaProducto('auditor_codigo', 'cron', HOY);
    expect(r.piezas).toBe(1);
    expect(ultimo().titulo).toBe(`Auditoría del artefacto — semana del ${LUNES}`);
    expect(ultimo().fuentes.palancas_bundle).toBe(3);
    expect(ultimo().fuentes.palancas_base).toBe(3);
  });

  it('un runner que no expone su lista NO se lee como «no despacha nada»', async () => {
    despachables = undefined;
    respuestas.set('cola_aprobacion', [{ data: [], error: null, count: 0 }]);
    respuestas.set('agente_definicion', [{ data: [], error: null }]);
    rpcs.set('contrato_de_esquema', [{ data: { interruptor_check: "ARRAY['global'::text, 'agente:migraciones'::text, 'agente:seguridad'::text]", tenant_sin_rls: [], fks_simples_entre_tenantizadas: [], indices_unicos_parciales_cola: [] }, error: null }]);
    await correrAgenteIngenieriaProducto('auditor_codigo', 'cron', HOY);
    expect(ultimo().cuerpo).toContain('NO se afirma que estén todos cableados');
  });
});

// ── 7 · PRODUCTO ───────────────────────────────────────────────────────────

describe('el traductor de señal a backlog', () => {
  const vacio = { valor: null, error: null };
  const AHORA = Date.parse('2026-08-24T00:00:00Z');

  it('un rechazo suelto NO es backlog; dos ya proponen revisar el criterio', () => {
    const uno = evaluarProducto({ valor: [{ agente: 'a', estado: 'rechazado', titulo: 't', motivo: 'no' }], error: null },
      vacio, vacio, vacio, null, AHORA);
    expect(uno.some((x) => x.codigo === 'P1')).toBe(false);
    const dos = evaluarProducto({ valor: [
      { agente: 'a', estado: 'rechazado', titulo: 't1', motivo: 'cifra sin fuente' },
      { agente: 'a', estado: 'rechazado', titulo: 't2', motivo: 'tono' },
    ], error: null }, vacio, vacio, vacio, null, AHORA);
    const p1 = dos.find((x) => x.codigo === 'P1');
    // ÁMBAR como techo (28-ago-2026): una PROPUESTA no es urgente por
    // definición — jamás correo de medianoche por revisar un criterio.
    expect(p1?.semaforo).toBe('AMBAR');
    expect(p1?.evidencia).toContain('PROPUESTA');
    expect(p1?.evidencia).toContain('cifra sin fuente');
  });

  it('la bandeja atorada se agrupa por tipo y propone las DOS lecturas, sin decidir', () => {
    const h = evaluarProducto(vacio, { valor: [
      { tipo: 'parte_legal', agente: 'legal_compliance', creado: '2026-08-01T00:00:00Z' },
      { tipo: 'parte_legal', agente: 'legal_compliance', creado: '2026-08-02T00:00:00Z' },
      { tipo: 'correo_frio', agente: 'redactor', creado: '2026-08-23T00:00:00Z' },
    ], error: null }, vacio, vacio, null, AHORA);
    const p2 = h.find((x) => x.codigo === 'P2');
    expect(p2?.evidencia).toContain('parte_legal: 2');
    expect(p2?.evidencia).not.toContain('correo_frio');
    expect(p2?.evidencia).toContain('decisiones de producto, no de este agente');
  });

  it('ni la bandeja MUY atorada escala a ROJO: la señal es que el humano no está urgido (28-ago-2026)', () => {
    const muchas = Array.from({ length: 25 }, (_, i) => ({
      tipo: 'parte_legal', agente: 'legal_compliance', creado: `2026-08-0${(i % 9) + 1}T00:00:00Z`,
    }));
    const h = evaluarProducto(vacio, { valor: muchas, error: null }, vacio, vacio, null, AHORA);
    expect(h.find((x) => x.codigo === 'P2')?.semaforo).toBe('AMBAR');
  });

  it('las incidencias se agregan por tipo y sin un solo dato de ninguna flota', () => {
    const h = evaluarProducto(vacio, vacio, { valor: [
      { tipo: 'siniestro', prioridad: 'alta' },
      { tipo: 'siniestro', prioridad: 'media' },
      { tipo: 'retraso', prioridad: 'baja' },
    ], error: null }, vacio, null, AHORA);
    const p4 = h.find((x) => x.codigo === 'P4');
    expect(p4?.semaforo).toBe('AMBAR');
    expect(p4?.evidencia).toContain('siniestro 2');
    expect(p4?.detalle).toContain('1 de prioridad alta o crítica');
  });

  it('el agente vivo que nadie usa se propone para decisión explícita', () => {
    const h = evaluarProducto(vacio, vacio, vacio, { valor: [ficha('mudo')], error: null }, new Set<string>(), AHORA);
    expect(h.find((x) => x.codigo === 'P3')?.evidencia).toContain('decidir explícitamente si siguen');
  });

  it('sin señal, el backlog vacío se declara noticia y no error', () => {
    const cuerpo = armarParteProducto([], '2026-07-27', LUNES, null);
    expect(cuerpo).toContain('Un backlog vacío es una noticia, no un error');
    expect(cuerpo).toContain('PROPUESTA con su evidencia, no una prioridad');
    expect(cuerpo).toContain('Decide Javier');
  });
});

describe('la corrida de producto', () => {
  it('fabrica el backlog con la ventana de 28 días', async () => {
    respuestas.set('cola_aprobacion', [
      { data: [], error: null, count: 0 },  // parteExistente
      { data: [], error: null },            // resueltas
      { data: [], error: null },            // pendientes
    ]);
    respuestas.set('incidencia', [{ data: [], error: null }]);
    respuestas.set('agente_definicion', [{ data: [], error: null }]);
    respuestas.set('agente_corrida', [{ data: [], error: null }]);
    const r = await correrAgenteIngenieriaProducto('producto', 'cron', HOY);
    expect(r.piezas).toBe(1);
    expect(ultimo().fuentes.ventana).toEqual({ desde: '2026-07-27', hasta: LUNES });
  });

  it('una fuente ciega NO tumba el backlog: se dice arriba y el resto sigue', async () => {
    respuestas.set('cola_aprobacion', [
      { data: [], error: null, count: 0 },
      { data: null, error: { message: 'caída' } },  // resueltas ciega
      { data: [], error: null },
    ]);
    respuestas.set('incidencia', [{ data: [], error: null }]);
    respuestas.set('agente_definicion', [{ data: [], error: null }]);
    respuestas.set('agente_corrida', [{ data: [], error: null }]);
    const r = await correrAgenteIngenieriaProducto('producto', 'cron', HOY);
    expect(r.piezas).toBe(1);
    expect(ultimo().cuerpo).toContain('FUENTES QUE NO CONTESTARON');
    expect(ultimo().cuerpo).toContain('piezas resueltas');
  });
});

// ── 8 · DATOS E INSTRUMENTACIÓN ────────────────────────────────────────────

describe('el catálogo de preguntas del negocio', () => {
  it('cada pregunta declara su fuente, su evento propuesto y dónde se emitiría', () => {
    expect(PREGUNTAS.length).toBeGreaterThanOrEqual(6);
    for (const p of PREGUNTAS) {
      expect(p.id).toMatch(/^Q\d+$/);
      expect(p.pregunta.length).toBeGreaterThan(20);
      expect(p.fuente).toMatch(/^[a-z_]+$/);
      expect(p.eventoPropuesto.length).toBeGreaterThan(20);
      expect(p.donde.length).toBeGreaterThan(10);
    }
    expect(new Set(PREGUNTAS.map((p) => p.id)).size).toBe(PREGUNTAS.length);
  });

  // ── LA PRUEBA QUE FALTABA (correo en falso #4 del 28-ago-2026) ───────────
  it('la fuente que NUNCA ha existido es HUECO CONOCIDO (ÁMBAR, backlog) con la spec del evento — no un rojo que despierte a nadie', () => {
    const perfil = { tablas: [], consultas: { disponible: false, motivo: null, filas: [] } };
    const h = evaluarInstrumentacion(estadoDeFuentes(perfil, PREGUNTAS), PREGUNTAS);
    const q3 = h.find((x) => x.codigo === 'Q3');
    expect(q3?.semaforo).toBe('AMBAR');
    expect(q3?.detalle).toContain('NO EXISTE');
    expect(q3?.detalle).toContain('HUECO CONOCIDO');
    expect(q3?.evidencia).toContain('EVENTO MÍNIMO PROPUESTO');
    // El parte lo sigue diciendo entero — lo que cambia es que no escala.
    expect(h.every((x) => x.semaforo !== 'ROJO')).toBe(true);
  });

  it('la fuente que el censo anterior vio EXISTIR y desapareció sí es ROJO: eso es una rotura, no backlog', () => {
    const perfil = { tablas: [], consultas: { disponible: false, motivo: null, filas: [] } };
    const previas = new Map([['sitio_evento', { tabla: 'sitio_evento', existe: true, filas: 120 }]]);
    const h = evaluarInstrumentacion(estadoDeFuentes(perfil, PREGUNTAS), PREGUNTAS, previas);
    const q1 = h.find((x) => x.codigo === 'Q1'); // Q1 lee sitio_evento
    expect(q1?.semaforo).toBe('ROJO');
    expect(q1?.detalle).toContain('REGRESIÓN');
    // Y producto_evento, que nunca existió, sigue siendo ámbar aunque haya censo.
    expect(h.find((x) => x.codigo === 'Q3')?.semaforo).toBe('AMBAR');
  });

  it('la tabla que existe y está VACÍA es una respuesta distinta de «no hay dato»', () => {
    const perfil = {
      tablas: [{ tabla: 'sitio_evento', bytes: 8192, filas_estimadas: 0, seq_scan: 1, seq_tup_read: 0, idx_scan: 0, indices: 1 }],
      consultas: { disponible: false, motivo: null, filas: [] },
    };
    const h = evaluarInstrumentacion(estadoDeFuentes(perfil, PREGUNTAS), PREGUNTAS);
    const q1 = h.find((x) => x.codigo === 'Q1');
    expect(q1?.semaforo).toBe('AMBAR');
    expect(q1?.evidencia).toContain('distinta de «no hay dato»');
  });

  it('reltuples en −1 se dice «no medido», NUNCA «vacía»', () => {
    const perfil = {
      tablas: [{ tabla: 'sitio_evento', bytes: 8192, filas_estimadas: -1, seq_scan: null, seq_tup_read: null, idx_scan: null, indices: 1 }],
      consultas: { disponible: false, motivo: null, filas: [] },
    };
    const h = evaluarInstrumentacion(estadoDeFuentes(perfil, PREGUNTAS), PREGUNTAS);
    const q1 = h.find((x) => x.codigo === 'Q1');
    expect(q1?.semaforo).toBe('NOTA');
    expect(q1?.evidencia).toContain('NO se lee como «vacía»');
  });

  it('la fuente con datos se marca CON DATO y sigue diciendo qué falta', () => {
    const perfil = {
      tablas: [{ tabla: 'sitio_evento', bytes: 8192, filas_estimadas: 4321, seq_scan: 1, seq_tup_read: 1, idx_scan: 1, indices: 1 }],
      consultas: { disponible: false, motivo: null, filas: [] },
    };
    const h = evaluarInstrumentacion(estadoDeFuentes(perfil, PREGUNTAS), PREGUNTAS);
    const q1 = h.find((x) => x.codigo === 'Q1');
    expect(q1?.detalle).toContain('CON DATO');
    expect(q1?.detalle).toContain('4,321');
  });

  const SITIO_OK = { valor: { paginas: ['blog'], eventos: ['pageview'], filas: 12 }, error: null };
  const PRODUCTO_OK = { valor: { pantallas: ['resumen', 'viajes'], filas: 40 }, error: null };

  it('el parte dice el estado ACTUALIZADO del hueco (0251) y aclara que no instrumenta nada', () => {
    const cuerpo = armarParteInstrumentacion([], SITIO_OK, LUNES, null, PRODUCTO_OK);
    // La línea vieja («no existe analítica de producto DENTRO de la app»)
    // hoy sería mentira: la 0251 la creó. Lo que se afirma es lo medido.
    expect(cuerpo).not.toContain('no existe analítica de producto DENTRO de la app');
    expect(cuerpo).toContain('producto_evento cubre HOY');
    expect(cuerpo).toContain('viajes');
    expect(cuerpo).toContain('no instrumenta nada');
    expect(cuerpo).toContain('minimización LFPDPPP');
  });

  it('producto_evento existente pero SIN uso se dice como cable suelto posible, no como flota inactiva', () => {
    const cuerpo = armarParteInstrumentacion([], SITIO_OK, LUNES, null, { valor: { pantallas: [], filas: 0 }, error: null });
    expect(cuerpo).toContain('NO registró uso');
    expect(cuerpo).toContain('cable suelto');
  });

  it('sin poder leer sitio_evento o producto_evento no se afirma qué cubren', () => {
    const cuerpo = armarParteInstrumentacion([], { valor: null, error: 'sitio_evento' }, LUNES, null, { valor: null, error: 'producto_evento' });
    expect(cuerpo).toContain('NO SE PUDO LEER. No se afirma qué cubre');
    expect(cuerpo).toContain('«no se pudo leer» y «cero uso» son cosas distintas');
  });
});

describe('la corrida de instrumentación', () => {
  it('fabrica el parte y deja el estado de cada fuente en fuentes', async () => {
    respuestas.set('cola_aprobacion', [{ data: [], error: null, count: 0 }]);
    respuestas.set('sitio_evento', [{ data: [{ pagina: 'blog', evento: 'pageview' }], error: null }]);
    respuestas.set('producto_evento', [{ data: [{ pantalla: 'viajes' }], error: null }]);
    rpcs.set('perfil_almacenamiento', [{ data: {
      tablas: [{ tabla: 'sitio_evento', bytes: 8192, filas_estimadas: 10, seq_scan: 1, seq_tup_read: 1, idx_scan: 1, indices: 1 }],
      consultas: { disponible: false, motivo: 'no está', filas: [] },
    }, error: null }]);
    const r = await correrAgenteIngenieriaProducto('datos_instrumentacion', 'cron', HOY);
    expect(r.piezas).toBe(1);
    expect(ultimo().titulo).toBe(`Datos e instrumentación — semana del ${LUNES}`);
    expect(Array.isArray(ultimo().fuentes.fuentes)).toBe(true);
  });
});

// ── El despacho ────────────────────────────────────────────────────────────

describe('el despacho del módulo', () => {
  it('un agente que no vive aquí se DICE en vez de fingir una corrida vacía', async () => {
    await expect(correrAgenteIngenieriaProducto('seguridad', 'cron', HOY))
      .rejects.toThrow(/no vive en este módulo/);
  });
});
