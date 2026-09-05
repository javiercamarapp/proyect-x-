import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';

// ═══════════════════════════════════════════════════════════════════════════
// LA DIRECCIÓN (0216) — lo que estas pruebas fijan:
//  · Los constructores JAMÁS inventan: fuente ciega = "no se pudo leer",
//    nunca un cero que parezca medición; sin denominador no hay porcentaje.
//  · El reloj de México manda: antes de las 8:00 no sale nada; lo semanal
//    corre en lunes y solo en lunes.
//  · Idempotencia: el sello (agente, periodo) hace que correr dos veces
//    produzca UN solo efecto.
//  · Fallar cerrado: el canal que no acepta NO sella — el reporte se
//    reintenta; y el motor caído registra corrida en fallo, no un éxito.
// ═══════════════════════════════════════════════════════════════════════════

const respuestas = new Map<string, Array<{ data?: unknown; error?: { message: string; code?: string } | null; count?: number | null }>>();
const inserts: Array<{ tabla: string; fila: Record<string, unknown> }> = [];
const updates: Array<{ tabla: string; fila: Record<string, unknown> }> = [];
const deletes: string[] = [];
function builder(tabla: string) {
  const responder = () => {
    const cola = respuestas.get(tabla);
    return cola && cola.length > 0 ? cola.shift()! : { data: [], error: null, count: 0 };
  };
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: () => b, eq: () => b, is: () => b, in: () => b, not: () => b, gte: () => b,
    order: () => b, limit: () => b, range: () => b,
    insert: (fila: Record<string, unknown>) => {
      inserts.push({ tabla, fila });
      return {
        then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve().then(responder).then(res, rej),
      };
    },
    update: (fila: Record<string, unknown>) => { updates.push({ tabla, fila }); return b; },
    delete: () => { deletes.push(tabla); return b; },
    then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve().then(responder).then(res, rej),
  });
  return b;
}
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: (t: string) => builder(t) }) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../presupuesto', () => ({ acotada: (q: unknown) => q }));

const registrar = vi.fn(async () => undefined);
vi.mock('../agentes/corridas', () => ({ registrarCorrida: (...a: unknown[]) => registrar(...(a as [])) }));

const listar = vi.fn<() => Promise<unknown[]>>(async () => []);
vi.mock('../interruptores', () => ({ listarInterruptores: () => listar() }));

const resumenNegocio = vi.fn(async () => ({ tenants: 1, costoIaUsd: 12.4, tendenciaCosto: 4 }));
const conteosPlataforma = vi.fn(async () => ({ liquidaciones: 11 }));
const contarRevisar = vi.fn(async () => 3);
vi.mock('@/lib/admin/negocio', () => ({
  getResumenNegocio: () => resumenNegocio(),
  getConteosPlataforma: () => conteosPlataforma(),
  contarLiquidacionesEnRevisar: () => contarRevisar(),
}));

const CONTEOS_VACIOS = {
  arco: 0, corridasFallo: 0, talachas: 0, facturasProveedor: 0,
  ticketsAbiertos: 0, ticketsVencidos: 0, liquidacionesRevisar: 0,
};
const bandeja = vi.fn(async () => ({ fuentes: {}, cola: [], conteos: CONTEOS_VACIOS }));
// Mock a mano (sin importOriginal): el módulo real arrastra los lectores de
// negocio.ts, que aquí están mockeados con menos exports de los que él pide.
vi.mock('@/lib/admin/escalaciones', () => ({
  NOMBRE_FUENTE: {
    arco: 'Solicitudes ARCO',
    corridas: 'Corridas en fallo',
    talachas: 'Talachas por autorizar',
    facturas_proveedor: 'Facturas de proveedor',
    tickets: 'Tickets de soporte',
    liquidaciones: 'Liquidaciones en revisión',
  },
  getBandejaEscalaciones: () => bandeja(),
}));

const latidos = vi.fn(async () => ({}));
vi.mock('@/lib/admin/salud', () => ({ estadoLatidos: () => latidos() }));

const enviar = vi.fn(async () => ({ ok: true as const, id: 'correo-1' }));
vi.mock('@/lib/correo/enviar', () => ({ enviarCorreo: (...a: unknown[]) => enviar(...(a as [])) }));

const mod = await import('./reportes');
const {
  partesMx, lunesDe, diaAnterior, lineaNorte, armarKpiDiario, armarDiagnostico,
  armarSeccionesCiclo, detectarAnomalias, correrAgenteDireccion, contarProspectosPorEstado,
} = mod;

// Lunes 24-ago-2026: 16:00Z = 10:00 de México. Martes 25, misma hora.
const LUNES_10AM = new Date('2026-08-24T16:00:00Z');
const MARTES_10AM = new Date('2026-08-25T16:00:00Z');
const MARTES_2AM = new Date('2026-08-25T08:00:00Z');

const ALERTA_ORIGINAL = process.env.ALERTA_EMAIL;
afterAll(() => {
  if (ALERTA_ORIGINAL === undefined) delete process.env.ALERTA_EMAIL;
  else process.env.ALERTA_EMAIL = ALERTA_ORIGINAL;
});

beforeEach(() => {
  respuestas.clear();
  inserts.length = 0;
  updates.length = 0;
  deletes.length = 0;
  registrar.mockClear();
  enviar.mockClear();
  enviar.mockResolvedValue({ ok: true as const, id: 'correo-1' });
  listar.mockReset();
  listar.mockResolvedValue([]);
  resumenNegocio.mockReset();
  resumenNegocio.mockResolvedValue({ tenants: 1, costoIaUsd: 12.4, tendenciaCosto: 4 });
  conteosPlataforma.mockReset();
  conteosPlataforma.mockResolvedValue({ liquidaciones: 11 });
  contarRevisar.mockReset();
  contarRevisar.mockResolvedValue(3);
  bandeja.mockReset();
  bandeja.mockResolvedValue({ fuentes: {}, cola: [], conteos: { ...CONTEOS_VACIOS } });
  process.env.ALERTA_EMAIL = 'operador@likida.ai';
});

const fuente = <T,>(valor: T) => ({ valor, error: null });
const ciega = (nombre: string) => ({ valor: null, error: nombre });

describe('el reloj de México', () => {
  it('parte el instante en día/hora/lunes de MÉXICO, no de UTC', () => {
    expect(partesMx(LUNES_10AM)).toEqual({ dia: '2026-08-24', hora: 10, esLunes: true });
    // 08:00Z del martes son las 02:00 de México del MISMO martes.
    expect(partesMx(MARTES_2AM)).toEqual({ dia: '2026-08-25', hora: 2, esLunes: false });
  });
  it('lunesDe y diaAnterior operan sobre el calendario', () => {
    expect(lunesDe('2026-08-27')).toBe('2026-08-24');
    expect(lunesDe('2026-08-24')).toBe('2026-08-24');
    expect(diaAnterior('2026-09-01')).toBe('2026-08-31');
  });
});

describe('la métrica norte: tres ramas honestas, siempre absolutos', () => {
  it('fuente ilegible = "no se pudo medir", jamás un 0', () => {
    expect(lineaNorte(ciega('conteos'), fuente(3))).toContain('no se pudo medir');
  });
  it('cero liquidaciones = "aún no hay", que no es una medición', () => {
    expect(lineaNorte(fuente({ liquidaciones: 0 }), fuente(0))).toContain('aún no hay liquidaciones');
  });
  it('con base chica da absolutos y lo dice — sin porcentaje', () => {
    const linea = lineaNorte(fuente({ liquidaciones: 11 }), fuente(3));
    expect(linea).toContain('8 de 11');
    expect(linea).toContain('la base todavía es chica');
    expect(linea).not.toContain('%');
  });
});

describe('el diario corto', () => {
  const datosBase = () => ({
    dia: '2026-08-25',
    interruptores: fuente([] as unknown[]),
    resumen: fuente({ tenants: 1, costoIaUsd: 12.4, tendenciaCosto: 4 }),
    conteos: fuente({ liquidaciones: 11 }),
    revisar: fuente(3),
    bandeja: fuente({ fuentes: {}, cola: [], conteos: { ...CONTEOS_VACIOS } }),
    suscripcionesVivas: fuente(0),
    ayerSalio: true,
  });

  it('una palanca abajo es LA PRIMERA línea, con motivo y desde cuándo', () => {
    const d = datosBase();
    d.interruptores = fuente([{
      id: 'agente:cobranza', apagado: true, motivo: 'picos raros en el dunning',
      cambiadoPor: null, cambiadoPorNombre: null, cambiadoEn: '2026-08-24T18:40:00Z',
    }]);
    const texto = armarKpiDiario(d as never);
    const lineas = texto.split('\n');
    expect(lineas[2]).toContain('agente:cobranza APAGADO');
    expect(lineas[2]).toContain('picos raros en el dunning');
    // Y la decisión de reencenderla queda enfrente.
    expect(texto).toContain('Decide hoy');
  });

  it('el día limpio son TRES líneas, no un reporte igual de largo', () => {
    const texto = armarKpiDiario(datosBase() as never);
    expect(texto).toContain('Todo verde');
    expect(texto.split('\n').filter((l) => l.trim().length > 0)).toHaveLength(2);
  });

  it('una fuente ciega se DICE — un pendiente invisible no es un cero', () => {
    const d = datosBase();
    d.bandeja = ciega('bandeja de escalaciones') as never;
    const texto = armarKpiDiario(d as never);
    expect(texto).toContain('no se pudo leer');
    expect(texto).not.toContain('Todo verde');
  });

  it('con TODAS las fuentes ciegas, el silencio es la noticia y sale en una línea', () => {
    const d = {
      ...datosBase(),
      interruptores: ciega('interruptores'),
      resumen: ciega('resumen'),
      conteos: ciega('conteos'),
      revisar: ciega('revisar'),
      bandeja: ciega('bandeja'),
      suscripcionesVivas: ciega('suscripciones'),
    };
    const texto = armarKpiDiario(d as never);
    expect(texto).toContain('No pude leer nada del sistema hoy');
  });

  it('si ayer no salió el reporte, el de hoy lo dice — no vuelve como si nada', () => {
    const d = datosBase();
    d.ayerSalio = false;
    d.bandeja = fuente({ fuentes: {}, cola: [], conteos: { ...CONTEOS_VACIOS, talachas: 2 } }) as never;
    expect(armarKpiDiario(d as never)).toContain('Ayer no salió el reporte diario');
  });
});

describe('el diagnóstico del desempeño', () => {
  it('mes 0: el reloj no ha empezado, y los dos bloqueantes se nombran', () => {
    const texto = armarDiagnostico({
      dia: '2026-08-24',
      suscripcionesVivas: fuente(0),
      conteos: fuente({ liquidaciones: 0 }),
      revisar: fuente(0),
    } as never);
    expect(texto).toContain('mes 0');
    expect(texto).toContain('de prueba de Meta');
    expect(texto).toContain('Emisión fiscal apagada');
    expect(texto).toContain('Lo que no pude medir: nada');
  });

  it('con suscripciones vivas NO inventa un "vas X% abajo": absolutos y se declara la vara faltante', () => {
    const texto = armarDiagnostico({
      dia: '2026-08-24',
      suscripcionesVivas: fuente(2),
      conteos: fuente({ liquidaciones: 30 }),
      revisar: fuente(5),
    } as never);
    expect(texto).toContain('2 suscripción(es) viva(s)');
    expect(texto).toContain('no se inventa');
    expect(texto).not.toMatch(/vas \d+%/);
  });
});

describe('las 6 secciones del ciclo', () => {
  const datos = (prev: Record<string, number> | null) => ({
    lunes: '2026-08-24',
    prospectos: fuente({ nuevo: 10, contactado: 5, demo: 1, negociacion: 0, cerrado: 0, perdido: 2 }),
    prospectosPrev: prev,
    facturasSaas: fuente({ pendiente: 0, pagada: 0, fallida: 0, cancelada: 0 }),
    piezasSemana: fuente(3),
    pendientesCola: fuente(1),
    conteos: fuente({ liquidaciones: 11 }),
    revisar: fuente(3),
  });

  it('consulta los 14 valores persistidos y entrega 11 etapas canónicas', async () => {
    respuestas.set('prospecto', Array.from({ length: 14 }, () => ({ count: 1, error: null })));
    expect(await contarProspectosPorEstado()).toEqual({
      nuevo: 1, contactado: 1, appointment: 1, rescheduled: 1,
      cancelled: 1, 'no-show': 1, demo: 1, proposal: 2, pilot: 1,
      won: 2, lost: 2,
    });
  });

  it('normaliza también el resumen histórico al calcular deltas', () => {
    const texto = armarSeccionesCiclo({
      ...datos({ cerrado: 2, perdido: 1, negociacion: 3 }),
      prospectos: fuente({ won: 3, lost: 1, proposal: 4 }),
    } as never);
    expect(texto).toContain('proposal 4 (+1)');
    expect(texto).toContain('won 3 (+1)');
    expect(texto).not.toContain('cerrado ');
  });

  it('sin semana anterior NO hay delta, y se dice que empiezan la próxima', () => {
    const texto = armarSeccionesCiclo(datos(null) as never);
    expect(texto).toContain('sin resumen de la semana pasada');
    expect(texto).not.toContain('(+');
  });

  it('con la semana anterior persistida, el delta sale por estado', () => {
    const texto = armarSeccionesCiclo(datos({ nuevo: 7, contactado: 5, demo: 1, negociacion: 0, cerrado: 0, perdido: 2 }) as never);
    expect(texto).toContain('nuevo 10 (+3)');
    expect(texto).not.toContain('contactado 5 (');
  });

  it('lo no instrumentado dice "sin dato esta semana", jamás se rellena', () => {
    const texto = armarSeccionesCiclo(datos(null) as never);
    expect(texto).toContain('2. ATENCIÓN — sin dato esta semana');
    expect(texto).toContain('4. ONBOARDING — sin dato esta semana');
    // Y la base chica del % automatizado se declara con absolutos.
    expect(texto).toContain('solo absolutos');
  });
});

describe('los cuatro detectores del orquestador', () => {
  const AHORA = new Date('2026-08-24T16:00:00Z').getTime();
  it('caza el verde vacío, el parcial crónico, el fallo y el que no corrió', () => {
    const corridas = new Map([
      ['verde_vacio', [{ estado: 'ok' as const, inicio: '2026-08-24T10:00:00Z', tareasHechas: 0, tareasTotal: 5, resumen: null }]],
      ['cronico', [
        { estado: 'parcial' as const, inicio: '2026-08-24T10:00:00Z', tareasHechas: 1, tareasTotal: 2, resumen: null },
        { estado: 'parcial' as const, inicio: '2026-08-23T10:00:00Z', tareasHechas: 1, tareasTotal: 2, resumen: null },
        { estado: 'parcial' as const, inicio: '2026-08-22T10:00:00Z', tareasHechas: 1, tareasTotal: 2, resumen: null },
      ]],
      ['fallado', [{ estado: 'fallo' as const, inicio: '2026-08-24T09:00:00Z', tareasHechas: null, tareasTotal: null, resumen: null }]],
      ['sano', [{ estado: 'ok' as const, inicio: '2026-08-24T08:00:00Z', tareasHechas: 2, tareasTotal: 2, resumen: null }]],
    ]);
    const agentes = [{ id: 'verde_vacio' }, { id: 'cronico' }, { id: 'fallado' }, { id: 'sano' }, { id: 'mudo' }];
    const anomalias = detectarAnomalias(agentes, corridas, AHORA);
    expect(anomalias.join('\n')).toContain('VERDE VACÍO');
    expect(anomalias.join('\n')).toContain('PARCIAL CRÓNICO');
    expect(anomalias.join('\n')).toContain('fallado: la última corrida FALLÓ');
    expect(anomalias.join('\n')).toContain('mudo: NO HA CORRIDO nunca');
    expect(anomalias.join('\n')).not.toContain('sano:');
  });

  it('tareas nulas NO disparan el verde vacío — sin denominador no se afirma', () => {
    const corridas = new Map([
      ['sin_medida', [{ estado: 'ok' as const, inicio: '2026-08-24T10:00:00Z', tareasHechas: null, tareasTotal: null, resumen: null }]],
    ]);
    expect(detectarAnomalias([{ id: 'sin_medida' }], corridas, AHORA)).toEqual([]);
  });
});

describe('el reloj y el sello mandan sobre la corrida', () => {
  it('antes de las 8:00 de México no sale nada — ni a las 2 AM por un cron atrasado', async () => {
    const r = await correrAgenteDireccion('kpi_whatsapp', MARTES_2AM);
    expect(r.resultado).toBe('saltado');
    expect(enviar).not.toHaveBeenCalled();
  });

  it('lo semanal en martes se salta: corre los lunes', async () => {
    for (const agente of ['desempeno_startup', 'orquestador_semanal', 'orquestador'] as const) {
      const r = await correrAgenteDireccion(agente, MARTES_10AM);
      expect(r.resultado).toBe('saltado');
      expect(r.motivo).toContain('lunes');
    }
    expect(enviar).not.toHaveBeenCalled();
  });

  it('correr dos veces produce UN solo correo: el sello del periodo lo frena', async () => {
    // Primera corrida (c5-15): la RESERVA del periodo va ANTES del correo
    // (enviado_en null — el unique arbitra la carrera) y el sello es un
    // UPDATE que solo corre tras la aceptación del canal.
    respuestas.set('reporte_direccion', [
      { data: [], error: null },              // leerReporte (sello)
      { data: [], error: null },              // leerReporte (¿ayer salió?)
      { data: null, error: null },            // insert de la RESERVA
    ]);
    const r1 = await correrAgenteDireccion('kpi_whatsapp', MARTES_10AM);
    expect(r1).toMatchObject({ resultado: 'corrio', piezas: 1 });
    expect(enviar).toHaveBeenCalledTimes(1);
    const sello = inserts.find((i) => i.tabla === 'reporte_direccion');
    expect(sello?.fila.periodo).toBe('dia-2026-08-25');
    expect(sello?.fila.enviado_en).toBeNull();
    const selloUpdate = updates.find((u) => u.tabla === 'reporte_direccion');
    expect(selloUpdate?.fila.enviado_en).toBeTruthy();

    // Segunda corrida: el sello existe con enviado_en → no se manda de nuevo.
    enviar.mockClear();
    respuestas.set('reporte_direccion', [
      { data: [{ cuerpo: 'x', resumen: null, enviado_en: '2026-08-25T16:01:00Z' }], error: null },
    ]);
    const r2 = await correrAgenteDireccion('kpi_whatsapp', MARTES_10AM);
    expect(r2.resultado).toBe('saltado');
    expect(enviar).not.toHaveBeenCalled();
  });

  it("el timeout del canal es AMBIGUO (c5-15): la reserva se queda, nadie reenvía, y se dice", async () => {
    enviar.mockResolvedValue({ ok: false, motivo: 'red', detalle: 'timeout' } as never);
    respuestas.set('reporte_direccion', [
      { data: [], error: null },              // sello
      { data: [], error: null },              // ayer
      { data: null, error: null },            // insert de la RESERVA
    ]);
    const r = await correrAgenteDireccion('kpi_whatsapp', MARTES_10AM);
    expect(r).toMatchObject({ resultado: 'corrio', piezas: 0 });
    // La reserva EXISTE (enviado_en null), no se selló ni se borró: el
    // correo pudo haber salido — reenviar un "no sé" duplica.
    expect(inserts.filter((i) => i.tabla === 'reporte_direccion')).toHaveLength(1);
    expect(updates.filter((u) => u.tabla === 'reporte_direccion')).toHaveLength(0);
    expect(deletes).not.toContain('reporte_direccion');
    expect(registrar).toHaveBeenCalledWith(null, 'kpi_whatsapp', expect.objectContaining({ estado: 'fallo' }));

    // Y la pasada siguiente NO reenvía: ve la reserva y lo dice.
    enviar.mockClear();
    respuestas.set('reporte_direccion', [
      { data: [{ cuerpo: 'x', resumen: null, enviado_en: null }], error: null },
    ]);
    const r2 = await correrAgenteDireccion('kpi_whatsapp', MARTES_10AM);
    expect(r2.resultado).toBe('saltado');
    expect(r2.motivo).toMatch(/por confirmar/);
    expect(enviar).not.toHaveBeenCalled();
  });

  it('el rechazo DEFINITIVO del canal libera la reserva: la siguiente pasada reintenta', async () => {
    enviar.mockResolvedValue({ ok: false, motivo: 'rechazado', detalle: 'HTTP 422' } as never);
    respuestas.set('reporte_direccion', [
      { data: [], error: null },
      { data: [], error: null },
      { data: null, error: null },            // insert de la RESERVA
      { data: null, error: null },            // delete de la reserva
    ]);
    const r = await correrAgenteDireccion('kpi_whatsapp', MARTES_10AM);
    expect(r).toMatchObject({ resultado: 'corrio', piezas: 0 });
    expect(deletes).toContain('reporte_direccion');
    expect(registrar).toHaveBeenCalledWith(null, 'kpi_whatsapp', expect.objectContaining({ estado: 'fallo' }));
  });

  it('sin ALERTA_EMAIL el reporte no tiene canal, la reserva se libera y la corrida lo dice como fallo', async () => {
    delete process.env.ALERTA_EMAIL;
    respuestas.set('reporte_direccion', [
      { data: [], error: null },
      { data: [], error: null },
      { data: null, error: null },            // insert de la RESERVA
      { data: null, error: null },            // delete de la reserva (definitivo)
    ]);
    const r = await correrAgenteDireccion('kpi_whatsapp', MARTES_10AM);
    expect(r.motivo).toContain('ALERTA_EMAIL');
    expect(enviar).not.toHaveBeenCalled();
    expect(deletes).toContain('reporte_direccion');
    expect(registrar).toHaveBeenCalledWith(null, 'kpi_whatsapp', expect.objectContaining({ estado: 'fallo' }));
  });

  it('el productor semanal persiste su artefacto UNA vez y el perdedor del unique no duplica', async () => {
    // Primera: sin artefacto → lo arma y lo guarda (sin enviado_en: no es correo).
    respuestas.set('reporte_direccion', [
      { data: [], error: null },              // leerReporte
      { data: null, error: null },            // insert
    ]);
    const r1 = await correrAgenteDireccion('desempeno_startup', LUNES_10AM);
    expect(r1).toMatchObject({ resultado: 'corrio', piezas: 1 });
    const artefacto = inserts.find((i) => i.tabla === 'reporte_direccion');
    expect(artefacto?.fila.periodo).toBe('lun-2026-08-24');
    expect(artefacto?.fila.enviado_en).toBeNull();
    expect(String(artefacto?.fila.cuerpo)).toContain('mes 0');

    // Carrera: otro ganó el unique → 'ya_existia', sin duplicado ni fallo.
    inserts.length = 0;
    respuestas.set('reporte_direccion', [
      { data: [], error: null },
      { data: null, error: { message: 'duplicate key value violates unique constraint "reporte_direccion_agente_periodo"', code: '23505' } },
    ]);
    const r2 = await correrAgenteDireccion('desempeno_startup', LUNES_10AM);
    expect(r2.resultado).toBe('saltado');
  });

  it('la corrida del lunes del KPI usa el periodo semanal y transporta diagnóstico + secciones', async () => {
    respuestas.set('reporte_direccion', [
      { data: [], error: null },                                                     // sello del kpi (lun)
      { data: [{ cuerpo: '[DIAGNÓSTICO · mes 0 del plan]\nx', resumen: null, enviado_en: null }], error: null }, // artefacto desempeño
      { data: [{ cuerpo: '1. VENTAS — nuevo 1', resumen: null, enviado_en: null }], error: null },               // artefacto ciclo
      { data: [], error: null },                                                     // ¿ayer salió?
      { data: null, error: null },                                                   // insert de la RESERVA
    ]);
    const r = await correrAgenteDireccion('kpi_whatsapp', LUNES_10AM);
    expect(r).toMatchObject({ resultado: 'corrio', piezas: 1 });
    const sello = inserts.find((i) => i.tabla === 'reporte_direccion');
    expect(updates.find((u) => u.tabla === 'reporte_direccion')?.fila.enviado_en).toBeTruthy();
    expect(sello?.fila.periodo).toBe('lun-2026-08-24');
    expect(String(sello?.fila.cuerpo)).toContain('[DIAGNÓSTICO');
    expect(String(sello?.fila.cuerpo)).toContain('1. VENTAS');
    expect(String(sello?.fila.cuerpo)).toContain('[ESTA SEMANA DECIDES]');
  });
});

describe('c5-9 — la columna real de cola_aprobacion es creado_en (estructural)', () => {
  it('este archivo jamás consulta created_at — esa fuente nacía muerta (42703)', () => {
    const fuente = readFileSync('src/lib/likida/direccion/reportes.ts', 'utf8');
    expect(fuente).not.toMatch(/gte\('created_at'/);
    expect(fuente).toMatch(/gte\('creado_en'/);
  });
});

describe('c5-15 — el productor registra corrida al RECOGER su periodo (el detector no acusa en falso)', () => {
  it('artefacto ya generado (p. ej. por el kpi del lunes): saltado, pero CON corrida ok', async () => {
    respuestas.set('reporte_direccion', [
      { data: [{ cuerpo: 'ya estaba', resumen: null, enviado_en: null }], error: null },
    ]);
    const r = await correrAgenteDireccion('desempeno_startup', LUNES_10AM);
    expect(r.resultado).toBe('saltado');
    expect(registrar).toHaveBeenCalledWith(null, 'desempeno_startup', expect.objectContaining({
      estado: 'ok',
      resumen: expect.objectContaining({ recogido: expect.stringMatching(/ya estaba generado/) }),
    }));
  });
});
