import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// ÉXITO DEL CLIENTE (0218) — los contratos que el código sostiene:
//  · HONESTIDAD DE VACÍO: con 0 flotas y 0 suscripciones los partes lo DICEN;
//    ninguno finge una lista de nada ni se calla.
//  · NULL ≠ 0: una casilla del checklist que no se pudo medir NO cuenta como
//    atoro, y un conteo que la base no devolvió LANZA en vez de valer cero.
//  · Idempotencia por periodo: el pre-check corta y el rebote del índice
//    único se trata como «ya existía», no como fallo.
//  · Fail closed y DICHO: una lectura caída deja la corrida en 'fallo' y
//    NINGÚN parte.
//  · Los ROJOS (onboarding muerto, SLA vencido) van al operador YA, antes de
//    encolar — si la pieza no pudiera entrar, la alerta ya salió.
//  · El agente prepara, el humano manda: la salida es siempre la bandeja.
// ═══════════════════════════════════════════════════════════════════════════

// Una cola de respuestas por tabla: cada elemento es la respuesta COMPLETA
// que la siguiente consulta a esa tabla se lleva. Vacía ⇒ éxito sin filas.
const respuestas = new Map<string, Array<Record<string, unknown>>>();
function responderDe(tabla: string) {
  const cola = respuestas.get(tabla);
  return cola && cola.length > 0 ? cola.shift()! : { data: [], count: 0, error: null };
}
// AGB-10: registro de `.not(...)` por tabla — para poder afirmar QUÉ filtro
// se mandó (la exclusión de tenants "ZZZ QA …" es del servidor, no del mock).
const llamadasNot: Array<{ tabla: string; args: unknown[] }> = [];
function builder(tabla: string) {
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: () => b, eq: () => b, is: () => b,
    not: (...args: unknown[]) => { llamadasNot.push({ tabla, args }); return b; },
    gte: () => b, lt: () => b,
    in: () => b, limit: () => b, maybeSingle: () => b, order: () => b, range: () => b,
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

const telefonosJefe = vi.fn(async (..._a: unknown[]): Promise<Record<string, string>> => ({}));
vi.mock('../contactos', () => ({ telefonosJefe: (...a: unknown[]) => telefonosJefe(...a) }));

type Ob = { credenciales: { total: number; probadas: number }; avisosConfigurados: number };
const getOnboardingFlotas = vi.fn(async (): Promise<Map<string, Ob>> => new Map());
vi.mock('@/lib/admin/onboarding', () => ({ getOnboardingFlotas: () => getOnboardingFlotas() }));

const getPorCobrar = vi.fn(async (): Promise<unknown[]> => []);
vi.mock('@/lib/saas/transferencia', () => ({ getPorCobrar: () => getPorCobrar() }));

const {
  lunesDeSemana, mesAnterior, diasEntreDias, diasEntreIso,
  PASOS_ONBOARDING, casillaHecha, detectarAtoros, avisosDeHoy, armarParteOnboarding,
  enSilencio, armarParteSilencio, armarReporteValor, tocaReporteMensual,
  evaluarGatillos, armarParteRetencion,
  toquesDeHoy, esToqueAtrasado, tituloToque, textoDelToque, armarPropuestaCobranza, armarParteCobranzaSaas,
  semaforoTicket, armarParteSoporte,
  esAgenteExito, correrAgenteExito, AGENTES_EXITO, leerFlotas, leerValorDelMes,
} = await import('./exito');

const FLOTA = { id: 'aaaaaaaa-1111-2222-3333-444444444444', nombre: 'Transportes GAL', creadaEn: '2026-08-01T10:00:00Z', politicaPropia: false };
const CASILLAS_VACIAS = { telefono: false, conectoresProbados: 0, avisos: 0, politicaPropia: false, viajes: 0 };

beforeEach(() => {
  respuestas.clear();
  llamadasNot.length = 0;
  vi.clearAllMocks();
  telefonosJefe.mockResolvedValue({});
  getOnboardingFlotas.mockResolvedValue(new Map());
  getPorCobrar.mockResolvedValue([]);
  encolarPieza.mockResolvedValue('pieza-1');
});

// ── El catálogo ────────────────────────────────────────────────────────────

describe('el catálogo de los seis', () => {
  it('esAgenteExito reconoce a los seis y a nadie más', () => {
    for (const id of AGENTES_EXITO) expect(esAgenteExito(id)).toBe(true);
    expect(esAgenteExito('redactor')).toBe(false);
    expect(esAgenteExito('cobranza')).toBe(false); // la cobranza a CLIENTES no es la SaaS
  });
});

// ── Fechas ─────────────────────────────────────────────────────────────────

describe('los periodos (aritmética pura, día de México)', () => {
  it('el lunes ancla la semana', () => {
    expect(lunesDeSemana('2026-08-27')).toBe('2026-08-24'); // jueves
    expect(lunesDeSemana('2026-08-24')).toBe('2026-08-24');
    expect(lunesDeSemana('2026-08-30')).toBe('2026-08-24'); // domingo cierra, no abre
  });
  it('el mes anterior cruza el año', () => {
    expect(mesAnterior('2026-01-15')).toBe('2025-12');
    expect(mesAnterior('2026-08-27')).toBe('2026-07');
  });
  it('los días entre fechas cuentan hacia atrás y hacia adelante', () => {
    expect(diasEntreDias('2026-08-01', '2026-08-27')).toBe(26);
    expect(diasEntreDias('2026-09-01', '2026-08-27')).toBe(-5);
    expect(diasEntreIso('2026-08-01T10:00:00Z', '2026-08-27T12:00:00Z')).toBe(26);
  });
  it('el reporte mensual no corre antes del día 3', () => {
    expect(tocaReporteMensual('2026-09-02')).toBe(false);
    expect(tocaReporteMensual('2026-09-03')).toBe(true);
  });
});

// ── 1 · Onboarding ─────────────────────────────────────────────────────────

describe('onboarding — el checklist medible, con null distinto de pendiente', () => {
  it('casillaHecha devuelve null cuando la medición no se pudo hacer', () => {
    const ciega = { ...CASILLAS_VACIAS, telefono: null, conectoresProbados: null, avisos: null };
    expect(casillaHecha(ciega, 'telefono')).toBeNull();
    expect(casillaHecha(ciega, 'conectores')).toBeNull();
    expect(casillaHecha(ciega, 'avisos')).toBeNull();
    // Las dos que no dependen de una lectura ajena sí son booleanas.
    expect(casillaHecha(ciega, 'politica')).toBe(false);
    expect(casillaHecha(ciega, 'primer_viaje')).toBe(false);
  });

  it('una casilla CIEGA no es un atoro — "no se pudo medir" no es "falta"', () => {
    const ciega = { flota: FLOTA, dias: 30, casillas: { ...CASILLAS_VACIAS, telefono: null } };
    expect(detectarAtoros(ciega).map((a) => a.paso.clave)).not.toContain('telefono');
    // Las demás sí, porque su día ya pasó y están medidas como pendientes.
    expect(detectarAtoros(ciega).map((a) => a.paso.clave)).toContain('primer_viaje');
  });

  it('un paso cuyo día NO ha llegado todavía no es atoro', () => {
    const recien = { flota: FLOTA, dias: 0, casillas: CASILLAS_VACIAS };
    const claves = detectarAtoros(recien).map((a) => a.paso.clave);
    expect(claves).toEqual(['telefono']); // solo el día 0
  });

  it('el aviso de la secuencia sale el día exacto, esté o no hecha la casilla', () => {
    expect(avisosDeHoy({ flota: FLOTA, dias: 3, casillas: CASILLAS_VACIAS }).map((p) => p.clave)).toEqual(['politica']);
    expect(avisosDeHoy({ flota: FLOTA, dias: 7, casillas: CASILLAS_VACIAS }).map((p) => p.clave)).toEqual(['avisos', 'primer_viaje']);
    expect(avisosDeHoy({ flota: FLOTA, dias: 5, casillas: CASILLAS_VACIAS })).toEqual([]);
  });

  it('los avisos NO son bloqueantes: se reportan como NOTA, no como atoro que exige acción', () => {
    const avisos = PASOS_ONBOARDING.find((p) => p.clave === 'avisos')!;
    expect(avisos.bloqueante).toBe(false);
    const cuerpo = armarParteOnboarding([{ flota: FLOTA, dias: 30, casillas: CASILLAS_VACIAS }], '2026-08-31', false).cuerpo;
    expect(cuerpo).toContain('[NOTA]');
    expect(cuerpo).toContain('[ATORO]');
  });

  it('con 0 flotas el parte lo DICE — no se calla ni finge una lista', () => {
    const { cuerpo, atoros } = armarParteOnboarding([], '2026-08-27', false);
    expect(atoros).toEqual([]);
    expect(cuerpo).toContain('0 flotas dadas de alta');
    expect(cuerpo).toContain('No es un fallo');
  });

  it('14 días sin un solo viaje es ROJO y lo dice con nombre', () => {
    const { cuerpo, muertas } = armarParteOnboarding(
      [{ flota: FLOTA, dias: 20, casillas: { ...CASILLAS_VACIAS, viajes: 0 } }], '2026-08-27', false);
    expect(muertas).toEqual(['Transportes GAL']);
    expect(cuerpo).toContain('[ROJO]');
  });

  it('el truncado se declara: una lista recortada en silencio es una lista falsa', () => {
    const { cuerpo } = armarParteOnboarding([{ flota: FLOTA, dias: 1, casillas: CASILLAS_VACIAS }], '2026-08-27', true);
    expect(cuerpo).toContain('SOLO LAS PRIMERAS');
  });

  it('la corrida encola el parte, alerta al operador del rojo y anota', async () => {
    respuestas.set('cola_aprobacion', [{ data: null, count: 0, error: null }]);
    respuestas.set('tenant', [{ data: [{ id: FLOTA.id, nombre: FLOTA.nombre, created_at: '2026-07-01T00:00:00Z', config: null }], error: null }]);
    respuestas.set('viaje', [{ data: null, count: 0, error: null }]);
    const r = await correrAgenteExito('onboarding_cliente', 'cron', '2026-08-27');
    expect(r).toMatchObject({ resultado: 'corrio', piezas: 1, costoUsd: 0 });
    expect(alertarOperador).toHaveBeenCalledWith('exito.onboarding_muerto', expect.objectContaining({ codigo: 'exito_onboarding_sin_primer_viaje' }));
    expect(encolarPieza).toHaveBeenCalledWith(expect.objectContaining({ agente: 'onboarding_cliente', tipo: 'parte_onboarding' }));
  });

  it('si el parte de hoy ya está, no se fabrica otro (idempotencia por periodo)', async () => {
    respuestas.set('cola_aprobacion', [{ data: null, count: 1, error: null }]);
    const r = await correrAgenteExito('onboarding_cliente', 'cron', '2026-08-27');
    expect(r.piezas).toBe(0);
    expect(r.motivo).toMatch(/ya está en la bandeja/);
    expect(encolarPieza).not.toHaveBeenCalled();
  });

  it('una lectura caída deja la corrida en fallo y NINGÚN parte', async () => {
    respuestas.set('cola_aprobacion', [{ data: null, count: 0, error: null }]);
    respuestas.set('tenant', [{ data: null, error: { message: 'base caída' } }]);
    await expect(correrAgenteExito('onboarding_cliente', 'cron', '2026-08-27')).rejects.toThrow(/base caída/);
    expect(encolarPieza).not.toHaveBeenCalled();
    expect(registrarCorrida).toHaveBeenCalledWith(null, 'onboarding_cliente', expect.objectContaining({ estado: 'fallo' }));
  });

  it('las lecturas cross-tenant son best-effort: si truenan, las casillas quedan CIEGAS y el parte sale', async () => {
    telefonosJefe.mockRejectedValue(new Error('sin app_user'));
    getOnboardingFlotas.mockRejectedValue(new Error('sin credenciales'));
    respuestas.set('cola_aprobacion', [{ data: null, count: 0, error: null }]);
    respuestas.set('tenant', [{ data: [{ id: FLOTA.id, nombre: FLOTA.nombre, created_at: '2026-08-26T00:00:00Z', config: null }], error: null }]);
    respuestas.set('viaje', [{ data: null, count: 3, error: null }]);
    const r = await correrAgenteExito('onboarding_cliente', 'cron', '2026-08-27');
    expect(r.piezas).toBe(1);
    const cuerpo = (encolarPieza.mock.calls[0][0] as { cuerpo: string }).cuerpo;
    expect(cuerpo).toContain('[CIEGO]');
  });

  it('la política PROPIA se lee del override crudo de tenant.config, no de la fusión', async () => {
    respuestas.set('cola_aprobacion', [{ data: null, count: 0, error: null }]);
    respuestas.set('tenant', [{ data: [{ id: FLOTA.id, nombre: 'Con política', created_at: '2026-08-20T00:00:00Z', config: { politica: [{ concepto: 'diesel' }] } }], error: null }]);
    respuestas.set('viaje', [{ data: null, count: 5, error: null }]);
    await correrAgenteExito('onboarding_cliente', 'cron', '2026-08-27');
    const cuerpo = (encolarPieza.mock.calls[0][0] as { cuerpo: string }).cuerpo;
    expect(cuerpo).not.toContain('Sin política propia');
  });
});

describe('AGB-10 (auditoría 24) — leerFlotas excluye los tenants "ZZZ QA …"', () => {
  it('la consulta manda el filtro not-ilike sobre nombre', async () => {
    respuestas.set('tenant', [{ data: [], error: null }]);
    await leerFlotas();
    const filtro = llamadasNot.find((l) => l.tabla === 'tenant');
    expect(filtro?.args).toEqual(['nombre', 'ilike', 'ZZZ QA %']);
  });
});

// ── 2 · Éxito del cliente ──────────────────────────────────────────────────

describe('éxito del cliente — el silencio y el reporte de valor', () => {
  const base = { flota: FLOTA, viajesVentana: 0, gastosVentana: 0, conversacionesVentana: 0, viajesHistoricos: 40 };

  it('una flota que trabajaba y dejó de aparecer está en silencio', () => {
    expect(enSilencio(base)).toBe(true);
  });
  it('una flota que NUNCA tuvo actividad no está en silencio: está en onboarding', () => {
    expect(enSilencio({ ...base, viajesHistoricos: 0 })).toBe(false);
  });
  it('cualquiera de las tres señales de vida rompe el silencio', () => {
    expect(enSilencio({ ...base, viajesVentana: 1 })).toBe(false);
    expect(enSilencio({ ...base, gastosVentana: 1 })).toBe(false);
    expect(enSilencio({ ...base, conversacionesVentana: 1 })).toBe(false);
  });
  it('el parte declara que WhatsApp global NO se atribuye a una flota', () => {
    expect(armarParteSilencio([base], '2026-08-27')).toContain('wa_mensaje_procesado NO participa');
  });
  it('las flotas que nunca arrancaron se separan y se dice a quién le tocan', () => {
    const cuerpo = armarParteSilencio([base, { ...base, viajesHistoricos: 0 }], '2026-08-27');
    expect(cuerpo).toContain('el agente de onboarding');
  });

  it('un mes sin liquidaciones también es un reporte completo', () => {
    const cuerpo = armarReporteValor(FLOTA, {
      mes: '2026-07', liquidaciones: 0, porEstatus: [], porRevision: [], totalComprobado: 0, diferencia: 0,
      ivaAcreditable: 0, peajeAcreditable: 0, litrosDiesel: 0,
      gastosConCfdiValido: 0, gastosDelMes: 0, incompleto: false,
    });
    expect(cuerpo).toContain('Liquidaciones cerradas en 2026-07: 0');
    expect(cuerpo).toContain('no hay cifras de valor que presumir');
  });

  it('cada cifra del reporte lleva su consulta nombrada en la MISMA línea', () => {
    const cuerpo = armarReporteValor(FLOTA, {
      mes: '2026-07', liquidaciones: 12, porEstatus: [{ estatus: 'cuadrada', n: 10 }, { estatus: 'revisar', n: 2 }],
      porRevision: [{ revision: 'aprobada', n: 10 }, { revision: 'pendiente', n: 2 }],
      totalComprobado: 45_000, diferencia: 1_200, ivaAcreditable: 6_200, peajeAcreditable: 900,
      litrosDiesel: 3_400, gastosConCfdiValido: 30, gastosDelMes: 44, incompleto: false,
    });
    expect(cuerpo).toContain('liquidacion.total_comprobado');
    expect(cuerpo).toContain('liquidacion.iva_acreditable');
    expect(cuerpo).toContain('gasto.cfdi_valido');
    // El «no es inválido, es sin validar» tiene que estar: es la lectura que
    // un cliente haría mal si nadie se la aclara.
    expect(cuerpo).toContain('sin validar todavía');
    expect(cuerpo).toContain('BORRADOR');
    // ARQ-A5: el reporte declara QUÉ POBLACIÓN sostiene las cifras de dinero.
    expect(cuerpo).toContain('liquidacion.revision');
    expect(cuerpo).toContain('aprobada 10');
  });

  it('un mes truncado NO afirma los totales', () => {
    const cuerpo = armarReporteValor(FLOTA, {
      mes: '2026-07', liquidaciones: 5_000, porEstatus: [], porRevision: [], totalComprobado: 1, diferencia: 0,
      ivaAcreditable: 0, peajeAcreditable: 0, litrosDiesel: 0,
      gastosConCfdiValido: 0, gastosDelMes: 1, incompleto: true,
    });
    expect(cuerpo).toContain('[INCOMPLETO]');
    expect(cuerpo).toContain('no se afirman');
  });

  it('AGB-8: leerValorDelMes ya NO tope a 2,000 — un mes con 2,500 liquidaciones (3 páginas) suma completo y no sale incompleto', async () => {
    const fila = {
      estatus: 'cuadrada', revision: 'aprobada', total_comprobado: '10', diferencia: '0',
      iva_acreditable: '0', peaje_acreditable: '0', litros_diesel_acreditables: '0',
    };
    respuestas.set('liquidacion', [
      { data: Array.from({ length: 1_000 }, () => fila), count: 2_500, error: null }, // página 1 (con el total)
      { data: Array.from({ length: 1_000 }, () => fila), error: null },               // página 2
      { data: Array.from({ length: 500 }, () => fila), error: null },                 // página 3 (corta: fin)
    ]);
    respuestas.set('gasto', [{ data: null, count: 0, error: null }, { data: null, count: 0, error: null }]);
    const v = await leerValorDelMes(FLOTA.id, '2026-08');
    expect(v.liquidaciones).toBe(2_500);
    expect(v.incompleto).toBe(false);
    expect(v.totalComprobado).toBe(25_000);
  });

  it('ARQ-A5: el IVA del reporte suma SOLO firmadas (aprobada/ajustada) — pendiente y rechazada NO entran a la suma', async () => {
    const filas = [
      { estatus: 'cuadrada', revision: 'aprobada', total_comprobado: '100', diferencia: '1', iva_acreditable: '16', peaje_acreditable: '2', litros_diesel_acreditables: '30' },
      { estatus: 'cuadrada', revision: 'ajustada', total_comprobado: '200', diferencia: '2', iva_acreditable: '32', peaje_acreditable: '4', litros_diesel_acreditables: '60' },
      { estatus: 'revisar', revision: 'pendiente', total_comprobado: '9999', diferencia: '9999', iva_acreditable: '9999', peaje_acreditable: '9999', litros_diesel_acreditables: '9999' },
      { estatus: 'cuadrada', revision: 'rechazada', total_comprobado: '9999', diferencia: '9999', iva_acreditable: '9999', peaje_acreditable: '9999', litros_diesel_acreditables: '9999' },
    ];
    respuestas.set('liquidacion', [{ data: filas, count: 4, error: null }]);
    respuestas.set('gasto', [{ data: null, count: 0, error: null }, { data: null, count: 0, error: null }]);
    const v = await leerValorDelMes(FLOTA.id, '2026-08');
    // El CONTEO sigue viendo las 4 — no es una cifra de dinero.
    expect(v.liquidaciones).toBe(4);
    // Las SUMAS de dinero solo ven las dos firmadas: 100+200, 16+32, etc.
    expect(v.totalComprobado).toBe(300);
    expect(v.diferencia).toBe(3);
    expect(v.ivaAcreditable).toBe(48);
    expect(v.peajeAcreditable).toBe(6);
    expect(v.litrosDiesel).toBe(90);
    expect(v.porRevision).toEqual(expect.arrayContaining([
      { revision: 'aprobada', n: 1 }, { revision: 'ajustada', n: 1 },
      { revision: 'pendiente', n: 1 }, { revision: 'rechazada', n: 1 },
    ]));
  });

  it('sin flotas en silencio NO se encola nada: un parte que dice «nada» enseña a no leerlo', async () => {
    respuestas.set('tenant', [{ data: [], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: null, count: 0, error: null }]);
    const r = await correrAgenteExito('exito_cliente', 'cron', '2026-08-01');
    expect(r.piezas).toBe(0);
    expect(r.motivo).toMatch(/0 flotas/);
    expect(encolarPieza).not.toHaveBeenCalled();
  });

  it('una flota callada sí produce parte, y con tenant en la pieza del reporte de valor', async () => {
    respuestas.set('tenant', [{ data: [{ id: FLOTA.id, nombre: FLOTA.nombre, created_at: '2026-01-01T00:00:00Z', config: null }], error: null }]);
    respuestas.set('cola_aprobacion', [
      { data: null, count: 0, error: null },  // el parte de silencio no existe
      { data: null, count: 0, error: null },  // el reporte de valor tampoco
    ]);
    respuestas.set('viaje', [
      { data: null, count: 0, error: null },  // ventana
      { data: null, count: 25, error: null }, // histórico
    ]);
    respuestas.set('gasto', [
      { data: null, count: 0, error: null },  // ventana de silencio
      { data: null, count: 8, error: null },  // gastos del mes
      { data: null, count: 6, error: null },  // con cfdi válido
    ]);
    respuestas.set('wa_conversacion', [{ data: null, count: 0, error: null }]);
    // AGB-8: una sola lectura paginada (`traerTodo`) trae las filas Y el
    // conteo exacto a la vez — antes eran dos consultas separadas.
    respuestas.set('liquidacion', [
      { data: [{ estatus: 'cuadrada', total_comprobado: '100.50', diferencia: '0', iva_acreditable: '16', peaje_acreditable: '5', litros_diesel_acreditables: '30' }], error: null },
    ]);
    const r = await correrAgenteExito('exito_cliente', 'cron', '2026-08-05');
    expect(r.piezas).toBe(2);
    const tipos = encolarPieza.mock.calls.map((c) => (c[0] as { tipo: string }).tipo);
    expect(tipos).toEqual(['parte_silencio', 'reporte_valor']);
    // El reporte de valor es DE la flota: lleva su tenant para que la bandeja
    // sepa a quién pertenece.
    expect((encolarPieza.mock.calls[1][0] as { tenantId: string }).tenantId).toBe(FLOTA.id);
  });

  it('antes del día 3 el reporte de valor no corre y se dice por qué', async () => {
    respuestas.set('tenant', [{ data: [], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: null, count: 0, error: null }]);
    const r = await correrAgenteExito('exito_cliente', 'cron', '2026-08-02');
    expect(r.motivo).toMatch(/antes del día 3/);
  });
});

// ── 3 · Retención ──────────────────────────────────────────────────────────

describe('retención — gatillos con base, o sin porcentaje', () => {
  const uso = { flota: FLOTA, estaSemana: 0, semanaPrevia: 0, fallos7d: 0 };

  it('una caída fuerte sobre base suficiente es RIESGO', () => {
    const g = evaluarGatillos({ ...uso, semanaPrevia: 20, estaSemana: 5 });
    expect(g).toHaveLength(1);
    expect(g[0].tipo).toBe('RIESGO');
    expect(g[0].detalle).toContain('75%');
  });

  it('una subida fuerte es EXPANSIÓN', () => {
    const g = evaluarGatillos({ ...uso, semanaPrevia: 10, estaSemana: 20 });
    expect(g[0].tipo).toBe('EXPANSION');
  });

  it('caer de 2 a 1 NO se pinta como −50%: la base es demasiado chica', () => {
    const g = evaluarGatillos({ ...uso, semanaPrevia: 2, estaSemana: 1 });
    expect(g).toHaveLength(1);
    expect(g[0].detalle).toContain('NO se calcula porcentaje');
    // El −50% aparece SOLO como el ejemplo de lo que no se va a afirmar: el
    // gatillo se explica con los absolutos, que es lo que sí se midió.
    expect(g[0].detalle).toContain('2 viajes la semana pasada y 1 esta');
  });

  it('sin base (0 viajes la semana previa) no se enciende ningún gatillo de uso', () => {
    expect(evaluarGatillos({ ...uso, semanaPrevia: 0, estaSemana: 9 })).toEqual([]);
  });

  it('fallos repetidos del producto para esa flota son RIESGO por su cuenta', () => {
    const g = evaluarGatillos({ ...uso, fallos7d: 4 });
    expect(g).toHaveLength(1);
    expect(g[0].detalle).toContain('corridas de agentes terminaron en fallo');
  });

  it('con 0 flotas el parte lo dice y no finge medición', () => {
    expect(armarParteRetencion([], '2026-08-24', false).cuerpo).toContain('0 flotas dadas de alta');
  });

  it('el detalle por flota dice «sin base» en vez de un porcentaje inventado', () => {
    const { cuerpo } = armarParteRetencion([{ ...uso, semanaPrevia: 0, estaSemana: 4 }], '2026-08-24', false);
    expect(cuerpo).toContain('sin base para el porcentaje');
  });

  it('la corrida encola el parte semanal una sola vez por semana', async () => {
    respuestas.set('cola_aprobacion', [{ data: null, count: 0, error: null }]);
    respuestas.set('tenant', [{ data: [{ id: FLOTA.id, nombre: FLOTA.nombre, created_at: '2026-01-01T00:00:00Z', config: null }], error: null }]);
    respuestas.set('viaje', [{ data: null, count: 2, error: null }, { data: null, count: 20, error: null }]);
    respuestas.set('agente_corrida', [{ data: null, count: 0, error: null }]);
    const r = await correrAgenteExito('retencion', 'cron', '2026-08-27');
    expect(r.piezas).toBe(1);
    expect((encolarPieza.mock.calls[0][0] as { titulo: string }).titulo).toBe('Retención — semana del 2026-08-24');
  });

  it('un conteo que la base no devolvió LANZA — no se afirma un 0 que nadie midió', async () => {
    respuestas.set('cola_aprobacion', [{ data: null, count: 0, error: null }]);
    respuestas.set('tenant', [{ data: [{ id: FLOTA.id, nombre: FLOTA.nombre, created_at: '2026-01-01T00:00:00Z', config: null }], error: null }]);
    respuestas.set('viaje', [{ data: null, count: null, error: null }]);
    await expect(correrAgenteExito('retencion', 'cron', '2026-08-27')).rejects.toThrow(/no devolvió el conteo/);
  });
});

// ── 4 · Cobranza SaaS ──────────────────────────────────────────────────────

const FACTURA = {
  id: 'ffffffff-1111-2222-3333-444444444444',
  tenantId: FLOTA.id, tenantNombre: 'Transportes GAL',
  periodoInicio: '2026-08-01', periodoFin: '2026-08-31',
  monto: 11_600, subtotal: 10_000, iva: 1_600, moneda: 'MXN',
  estado: 'pendiente', referencia: 'LKAAAA202608', cfdiUuid: null,
};

describe('cobranza SaaS — la cadencia propone, nadie envía', () => {
  it('un hito ALCANZADO cuenta aunque su día exacto ya haya pasado (c6-14)', () => {
    // Antes del primer hito no hay nada que proponer.
    expect(toquesDeHoy([FACTURA], '2026-07-25')).toEqual([]);
    // El día exacto de cada hito, ese hito y los anteriores.
    expect(toquesDeHoy([FACTURA], '2026-07-29').map((t) => t.hito)).toEqual([-3]);
    expect(toquesDeHoy([FACTURA], '2026-08-01').map((t) => t.hito)).toEqual([-3, 0]);
    // Y un día que no es hito de nadie YA NO se queda mudo: recupera los que
    // se perdieron (el cron pudo no correr esos días).
    expect(toquesDeHoy([FACTURA], '2026-08-05').map((t) => t.hito)).toEqual([-3, 0, 3]);
    expect(toquesDeHoy([FACTURA], '2026-08-16').map((t) => t.hito)).toEqual([-3, 0, 3, 7, 15]);
  });

  it('el toque atrasado se marca y su texto habla del HOY real, no del hito', () => {
    const tarde = toquesDeHoy([FACTURA], '2026-08-21').find((t) => t.hito === -3)!;
    expect(esToqueAtrasado(tarde)).toBe(true);
    expect(tarde.diasVsVencimiento).toBe(20);
    // Nada de "faltan 3 días para el corte" sobre una factura de 20 días.
    expect(textoDelToque(tarde)).not.toContain('faltan');
    expect(textoDelToque(tarde)).toContain('20 días desde el corte');
    const cuerpo = armarPropuestaCobranza(tarde, '2026-08-21');
    expect(cuerpo).toContain('TOQUE ATRASADO');
    expect(cuerpo).toContain('lleva 20 días vencida');
    // El SELLO sigue siendo el del hito: una propuesta por (factura, hito).
    expect(tituloToque(tarde)).toBe('Cobranza SaaS — LKAAAA202608 — D-3');
  });

  it('el título del toque es determinista por factura y hito', () => {
    expect(tituloToque({ factura: FACTURA, diasVsVencimiento: 7, hito: 7 })).toBe('Cobranza SaaS — LKAAAA202608 — D+7');
    expect(tituloToque({ factura: FACTURA, diasVsVencimiento: -3, hito: -3 })).toBe('Cobranza SaaS — LKAAAA202608 — D-3');
  });

  it('sin referencia bancaria el título cae al id corto, nunca a un texto ambiguo', () => {
    const sinRef = { ...FACTURA, referencia: null };
    expect(tituloToque({ factura: sinRef, diasVsVencimiento: 0, hito: 0 })).toBe('Cobranza SaaS — ffffffff — D+0');
  });

  it('el texto propuesto usa el monto de la factura y nunca amenaza con cortar el servicio', () => {
    for (const hito of [-3, 0, 3, 7, 15]) {
      const texto = textoDelToque({ factura: FACTURA, diasVsVencimiento: hito, hito });
      expect(texto).toContain('$11,600.00');
      expect(texto.toLowerCase()).not.toContain('suspend');
      expect(texto.toLowerCase()).not.toContain('cancelar tu cuenta');
    }
  });

  it('una factura sin desglose de IVA lo declara: no se puede timbrar', () => {
    const cuerpo = armarPropuestaCobranza({ factura: { ...FACTURA, subtotal: null, iva: null }, diasVsVencimiento: 0, hito: 0 }, '2026-08-01');
    expect(cuerpo).toContain('SIN desglose de IVA');
  });

  it('la propuesta declara de dónde sale el vencimiento — es interpretación, no dato', () => {
    const cuerpo = armarPropuestaCobranza({ factura: FACTURA, diasVsVencimiento: 3, hito: 3 }, '2026-08-04');
    expect(cuerpo).toContain('vencimiento tomado como periodo_inicio');
    expect(cuerpo).toContain('no sale solo');
  });

  it('con 0 mensualidades por cobrar el parte lo DICE — es el estado real del negocio', () => {
    const cuerpo = armarParteCobranzaSaas([], [], 0, '2026-08-27');
    expect(cuerpo).toContain('0 mensualidades por cobrar');
    expect(cuerpo).toContain('estado real del negocio');
  });

  it('la corrida propone un recordatorio por hito y además deja el parte del día', async () => {
    getPorCobrar.mockResolvedValue([FACTURA]);
    respuestas.set('cola_aprobacion', [
      { data: null, count: 0, error: null },  // el toque no existe
      { data: null, count: 0, error: null },  // el parte tampoco
    ]);
    // 2026-07-29 = D−3 exacto: UN solo hito alcanzado, que es lo que este
    // caso quiere medir (el catch-up tiene su propia prueba arriba).
    const r = await correrAgenteExito('cobranza_saas', 'cron', '2026-07-29');
    expect(r.piezas).toBe(2);
    const tipos = encolarPieza.mock.calls.map((c) => (c[0] as { tipo: string }).tipo);
    expect(tipos).toEqual(['recordatorio_cobranza', 'parte_cobranza_saas']);
    // El recordatorio es DE la flota que debe.
    expect((encolarPieza.mock.calls[0][0] as { tenantId: string }).tenantId).toBe(FLOTA.id);
  });

  it('un toque ya propuesto no se vuelve a proponer (una pieza por factura y hito)', async () => {
    getPorCobrar.mockResolvedValue([FACTURA]);
    respuestas.set('cola_aprobacion', [
      { data: null, count: 1, error: null },  // el toque YA existe
      { data: null, count: 1, error: null },  // el parte también
    ]);
    const r = await correrAgenteExito('cobranza_saas', 'cron', '2026-07-29');
    expect(r.piezas).toBe(0);
    expect(encolarPieza).not.toHaveBeenCalled();
  });

  it('el rebote del índice único se lee como «ya existía», no como fallo', async () => {
    getPorCobrar.mockResolvedValue([FACTURA]);
    respuestas.set('cola_aprobacion', [{ data: null, count: 0, error: null }, { data: null, count: 1, error: null }]);
    encolarPieza.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint "cola_parte_exito_por_periodo"'));
    const r = await correrAgenteExito('cobranza_saas', 'cron', '2026-07-29');
    expect(r.resultado).toBe('corrio');
    expect(r.piezas).toBe(0);
  });
});

// ── 5 · Soporte ────────────────────────────────────────────────────────────

const TICKET = {
  id: 'tttttttt-1111-2222-3333-444444444444', tenantId: FLOTA.id,
  asunto: 'No me llegó el CFDI de la mensualidad', categoria: 'facturacion',
  prioridad: 'alta', estado: 'abierto', abiertoEn: '2026-08-26T10:00:00Z',
  // `respuestas` y no `mensajes` desde c6-14/c6-5: cuenta SOLO los mensajes
  // públicos de alguien distinto del solicitante.
  venceEn: '2026-08-27T10:00:00Z', respuestas: 0,
};
const AHORA = '2026-08-27T18:00:00Z';

describe('soporte — el reloj se deriva, y «sin SLA» no es «vencido»', () => {
  it('los cuatro semáforos', () => {
    expect(semaforoTicket(TICKET, AHORA)).toBe('VENCIDO');
    expect(semaforoTicket({ ...TICKET, venceEn: '2026-08-27T20:00:00Z' }, AHORA)).toBe('POR_VENCER');
    expect(semaforoTicket({ ...TICKET, venceEn: '2026-08-30T10:00:00Z' }, AHORA)).toBe('EN_TIEMPO');
    expect(semaforoTicket({ ...TICKET, venceEn: null }, AHORA)).toBe('SIN_SLA');
  });

  it('un ticket sin SLA pactado se dice así, jamás como incumplimiento', () => {
    const { cuerpo, vencidos } = armarParteSoporte([{ ...TICKET, venceEn: null }], AHORA, '2026-08-27', false);
    expect(vencidos).toEqual([]);
    expect(cuerpo).toContain('sin SLA pactado');
    expect(cuerpo).toContain('no es «vencido»');
  });

  it('con 0 tickets el parte lo dice', () => {
    expect(armarParteSoporte([], AHORA, '2026-08-27', false).cuerpo).toContain('0 tickets abiertos');
  });

  it('un ticket sin una sola respuesta se marca como tal', () => {
    const { sinRespuesta, cuerpo } = armarParteSoporte([TICKET], AHORA, '2026-08-27', false);
    expect(sinRespuesta).toHaveLength(1);
    expect(cuerpo).toContain('SIN RESPUESTA');
  });

  it('el SLA vencido escala al operador ANTES de encolar', async () => {
    respuestas.set('ticket_soporte', [{ data: [{ id: TICKET.id, tenant_id: FLOTA.id, asunto: TICKET.asunto, categoria: 'facturacion', prioridad: 'alta', estado: 'abierto', abierto_en: TICKET.abiertoEn, vence_en: TICKET.venceEn }], error: null }]);
    // El hilo se LEE (autor_id + interna), ya no se cuenta de cabecera.
    respuestas.set('ticket_mensaje', [{ data: [], error: null }]);
    respuestas.set('cola_aprobacion', [{ data: null, count: 0, error: null }]);
    const r = await correrAgenteExito('soporte', 'cron', '2026-08-27', new Date(AHORA));
    expect(alertarOperador).toHaveBeenCalledWith('exito.soporte_sla', expect.objectContaining({ codigo: 'exito_soporte_sla_vencido' }));
    expect(r.piezas).toBe(1);
    // El orden importa: la alerta salió antes de que la pieza entrara.
    expect(alertarOperador.mock.invocationCallOrder[0]).toBeLessThan(encolarPieza.mock.invocationCallOrder[0]);
  });

  it('sin tickets vivos no se encola nada y se dice por qué', async () => {
    respuestas.set('ticket_soporte', [{ data: [], error: null }]);
    const r = await correrAgenteExito('soporte', 'cron', '2026-08-27', new Date(AHORA));
    expect(r.piezas).toBe(0);
    expect(r.motivo).toMatch(/0 tickets vivos/);
    expect(encolarPieza).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EL RELOJ DE LA VUELTA, ADENTRO DE LOS MOTORES (auditoría ciclo 7, c7-1).
//
// LA PRUEBA QUE FALTABA. El auditor lo dijo con todas sus letras: la suite no
// atrapaba c7-1 porque «no hay una sola prueba en la que un agente ya
// despachado se pase del presupuesto». Los cinco motores de este archivo
// iteran listas de trabajo con I/O por elemento y ninguno miraba el reloj: el
// candado 0 del runner preguntaba la hora ANTES de despachar y ya no se volvía
// a preguntar nunca. Resultado en producción, dos veces: Vercel mató la
// función DENTRO del bucle, sin `try` ni `catch` de la ruta y por lo tanto SIN
// LATIDO — el silencio del 25-ago-2026 («Sin latido: runner hace 286 min») y
// el del 28-ago-2026 00:03 UTC, donde la pasada hizo 32 corridas TODAS en `ok`
// y aun así no escribió latido.
//
// Cada prueba de aquí abajo afirma las TRES cosas que separan un corte bueno
// de uno peligroso:
//   1. CORTA — no se come el presupuesto de la vuelta.
//   2. CUENTA — `sinTurno` sube, y por él el runner mete al agente en
//      `saltadosPorReloj` y el latido dice `'parcial'` en vez de `'ok'`. Un
//      corte silencioso es PEOR que no cortar: el runner reportaría una pasada
//      limpia mientras deja trabajo sin hacer.
//   3. NO DEJA EL ESTADO A MEDIAS — y aquí está lo fino: los partes de este
//      archivo son idempotentes POR TÍTULO, así que encolar uno armado con
//      media lista SELLA el periodo y la pasada siguiente encontraría
//      «ya_existia». Un corte a mitad de un parte no puede publicarlo.
// ═══════════════════════════════════════════════════════════════════════════

/** Un instante que YA PASÓ: el reloj de la vuelta agotado antes de empezar. */
const RELOJ_VENCIDO = () => Date.now() - 1;

const OTRA_FLOTA = { ...FLOTA, id: 'bbbbbbbb-1111-2222-3333-444444444444', nombre: 'Fletes del Bajío' };
const DOS_FLOTAS = {
  data: [
    { id: FLOTA.id, nombre: FLOTA.nombre, created_at: '2026-07-01T00:00:00Z', config: null },
    { id: OTRA_FLOTA.id, nombre: OTRA_FLOTA.nombre, created_at: '2026-07-01T00:00:00Z', config: null },
  ],
  error: null,
};

describe('el reloj de la vuelta corta los motores de éxito, y lo DICE (c7-1)', () => {
  it('onboarding: con el reloj vencido no consulta ni una flota, no encola el parte a medias y cuenta las que no miró', async () => {
    respuestas.set('cola_aprobacion', [{ data: null, count: 0, error: null }]);
    respuestas.set('tenant', [DOS_FLOTAS]);
    // Si el bucle corriera, se comería esta respuesta de `viaje`.
    respuestas.set('viaje', [{ data: null, count: 0, error: null }]);

    const r = await correrAgenteExito('onboarding_cliente', 'cron', '2026-08-27', new Date(), RELOJ_VENCIDO());

    expect(r).toMatchObject({ resultado: 'corrio', piezas: 0, sinTurno: true });
    expect(r.motivo).toMatch(/2 flota\(s\) sin mirar/);
    // CORTA de verdad: la consulta por flota NO se gastó.
    expect(respuestas.get('viaje')).toHaveLength(1);
    // NO DEJA EL ESTADO A MEDIAS: el título del día no queda sellado con una
    // lista de 0 flotas, así que la próxima pasada sí puede fabricarlo entero.
    expect(encolarPieza).not.toHaveBeenCalled();
    // Y tampoco escala un «rojo» calculado sobre flotas que no se miraron.
    expect(alertarOperador).not.toHaveBeenCalled();
  });

  it('éxito del cliente: el parte de silencio NO se encola con media lista, y el reporte de valor ni se intenta', async () => {
    respuestas.set('tenant', [DOS_FLOTAS]);
    respuestas.set('cola_aprobacion', [{ data: null, count: 0, error: null }]);
    respuestas.set('viaje', [{ data: null, count: 0, error: null }]);

    const r = await correrAgenteExito('exito_cliente', 'cron', '2026-08-05', new Date(), RELOJ_VENCIDO());

    expect(r).toMatchObject({ resultado: 'corrio', piezas: 0, sinTurno: true });
    expect(r.motivo).toMatch(/sin mirar/);
    expect(r.motivo).toMatch(/reporte de valor ni se intentó/);
    expect(respuestas.get('viaje')).toHaveLength(1);
    expect(encolarPieza).not.toHaveBeenCalled();
  });

  it('retención: el parte SEMANAL no se sella a medias — apagaría los gatillos de las flotas no miradas una semana entera', async () => {
    respuestas.set('cola_aprobacion', [{ data: null, count: 0, error: null }]);
    respuestas.set('tenant', [DOS_FLOTAS]);
    respuestas.set('viaje', [{ data: null, count: 0, error: null }]);

    const r = await correrAgenteExito('retencion', 'cron', '2026-08-27', new Date(), RELOJ_VENCIDO());

    expect(r).toMatchObject({ resultado: 'corrio', piezas: 0, sinTurno: true });
    expect(r.motivo).toMatch(/2 flota\(s\) sin mirar/);
    expect(r.motivo).toMatch(/SEMANAL/);
    expect(respuestas.get('viaje')).toHaveLength(1);
    expect(encolarPieza).not.toHaveBeenCalled();
  });

  it('soporte: un censo de tickets incompleto NI escala NI se encola — una alerta a la baja tranquiliza con un dato falso', async () => {
    respuestas.set('ticket_soporte', [{
      data: [{
        id: TICKET.id, tenant_id: FLOTA.id, asunto: TICKET.asunto, categoria: 'facturacion',
        prioridad: 'alta', estado: 'abierto', abierto_en: TICKET.abiertoEn, vence_en: TICKET.venceEn,
      }],
      error: null,
    }]);
    // El hilo de cada ticket es una consulta por ticket: con el reloj vencido
    // no se gasta ninguna.
    respuestas.set('ticket_mensaje', [{ data: [], error: null }]);

    const r = await correrAgenteExito('soporte', 'cron', '2026-08-27', new Date(AHORA), RELOJ_VENCIDO());

    expect(r).toMatchObject({ resultado: 'corrio', piezas: 0, sinTurno: true });
    expect(r.motivo).toMatch(/cortó la lectura de tickets/);
    expect(respuestas.get('ticket_mensaje')).toHaveLength(1);
    // El ticket del fixture está VENCIDO: sin el corte, esto habría escalado.
    // Escalar «1 vencido» sobre un censo truncado consumiría el piso de la
    // alerta y podría CALLAR la alerta correcta de la pasada que sí termine.
    expect(alertarOperador).not.toHaveBeenCalled();
    expect(encolarPieza).not.toHaveBeenCalled();
  });

  it('cobranza SaaS: las propuestas ya encoladas QUEDAN, pero el parte del día no se sella con las cuentas a medias', async () => {
    getPorCobrar.mockResolvedValue([FACTURA]);
    // 2026-08-01 = dos hitos alcanzados (D−3 y D+0): dos toques, o sea una
    // lista de trabajo de verdad sobre la que se puede cortar A LA MITAD.
    expect(toquesDeHoy([FACTURA], '2026-08-01')).toHaveLength(2);

    // EL RELOJ QUE SE AGOTA A LA MITAD: arranca vivo y se vence en cuanto la
    // primera propuesta entra a la bandeja. Es la forma honesta de reproducir
    // el incidente — la vuelta se muere DENTRO del bucle, no antes de entrar.
    let ahora = 1_000_000;
    const vence = ahora + 10_000;
    const reloj = vi.spyOn(Date, 'now').mockImplementation(() => ahora);
    encolarPieza.mockImplementation(async () => { ahora = vence + 1; return 'pieza-1'; });
    try {
      const r = await correrAgenteExito('cobranza_saas', 'cron', '2026-08-01', new Date(), vence);

      // CORTA y CUENTA.
      expect(r).toMatchObject({ resultado: 'corrio', sinTurno: true });
      expect(r.motivo).toMatch(/1 toque\(s\) sin mirar/);
      // NO DEJA EL ESTADO A MEDIAS, en sus dos mitades:
      //  · lo ya fabricado QUEDA — cada propuesta tiene su propio título, así
      //    que no estorba a nadie y no hay que rehacerla;
      //  · y lo único que se encoló es esa propuesta: NI el segundo toque NI
      //    el parte del día, que habría sellado la fecha diciendo «de 2 toques
      //    se prepararon 1» como si ése fuera el total.
      const tipos = encolarPieza.mock.calls.map((c) => (c[0] as { tipo: string }).tipo);
      expect(tipos).toEqual(['recordatorio_cobranza']);
      expect(tipos).not.toContain('parte_cobranza_saas');
      expect(r.piezas).toBe(1);
    } finally {
      reloj.mockRestore();
    }
  });

  it('sin reloj los cinco se comportan igual que siempre — el parámetro es opcional a propósito', async () => {
    respuestas.set('cola_aprobacion', [{ data: null, count: 0, error: null }]);
    respuestas.set('tenant', [{ data: [{ id: FLOTA.id, nombre: FLOTA.nombre, created_at: '2026-07-01T00:00:00Z', config: null }], error: null }]);
    respuestas.set('viaje', [{ data: null, count: 4, error: null }]);
    const r = await correrAgenteExito('onboarding_cliente', 'cron', '2026-08-27');
    expect(r.piezas).toBe(1);
    expect(r.sinTurno).toBeUndefined();
  });
});
