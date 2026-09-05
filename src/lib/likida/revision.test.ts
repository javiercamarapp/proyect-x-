import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24, BLOQUEANTE 6 — la firma humana de la liquidación (mig. 0299).
//
// Lo que la base garantiza (una firma no se pone dos veces, un ajuste
// negativo rebota, rechazar reabre) lo prueban los bloques 246-247 de
// verificaciones.sql contra Postgres real. Aquí se prueba la CAPA DE LA APP:
//   · la cola se lee por llave, por antigüedad, con `count` real y una fila
//     de más para `hayMas` (FE-5: nunca «las 50 más recientes»);
//   · los filtros de la URL se leen sin aplicar nada a medias;
//   · la escritura SIEMPRE va por la RPC, traduce sus SQLSTATE a mensajes para
//     la persona, y al rechazar avisa al chofer (best-effort, sin cifras).
// ═══════════════════════════════════════════════════════════════════════════

const sendText = vi.fn(async () => 'wamid.1');
vi.mock('@/lib/meta/client', () => ({ sendText }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/likida/presupuesto', () => ({ acotada: (q: unknown) => q }));

interface Consulta {
  tabla: string; select: string; opciones: Record<string, unknown> | undefined;
  eq: Array<[string, unknown]>; gte: Array<[string, unknown]>; lte: Array<[string, unknown]>;
  or: string | null; orden: Array<[string, boolean]>; rango: [number, number] | null;
  unaSola: boolean;
}
const consultas: Consulta[] = [];
let filasBase: Array<Record<string, unknown>> = [];
let conteoBase: number | null = 0;
let errorBase: { message: string } | null = null;
// AUDITORÍA 25 (BE-C1a/BE-C1b): `viajeIdDeLiquidacion` lee UNA fila con
// `.maybeSingle()` — distinto de `colaRevision`, que lee un arreglo con
// `.range()`. `filasBase`/`conteoBase` siguen siendo la lista; esto es
// SOLO lo que una consulta `.maybeSingle()` debe devolver — la misma que
// consume `leerRevision` (PRU-ALTO2/PRU-MEDIO).
let filaUnica: Record<string, unknown> | null = null;

const rpc = vi.fn();

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    rpc,
    from: (tabla: string) => {
      const c: Consulta = { tabla, select: '', opciones: undefined, eq: [], gte: [], lte: [], or: null, orden: [], rango: null, unaSola: false };
      consultas.push(c);
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: (cols: string, opt?: Record<string, unknown>) => { c.select = cols; c.opciones = opt; return b; },
        eq: (col: string, v: unknown) => { c.eq.push([col, v]); return b; },
        gte: (col: string, v: unknown) => { c.gte.push([col, v]); return b; },
        lte: (col: string, v: unknown) => { c.lte.push([col, v]); return b; },
        or: (f: string) => { c.or = f; return b; },
        order: (col: string, o?: { ascending?: boolean }) => { c.orden.push([col, o?.ascending !== false]); return b; },
        range: (d: number, h: number) => { c.rango = [d, h]; return b; },
        maybeSingle: () => { c.unaSola = true; return b; },
        then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) => {
          if (errorBase) return Promise.resolve({ data: null, error: errorBase, count: null }).then(res, rej);
          if (c.unaSola) return Promise.resolve({ data: filaUnica, error: null, count: null }).then(res, rej);
          const [d, h] = c.rango ?? [0, filasBase.length - 1];
          return Promise.resolve({ data: filasBase.slice(d, h + 1), error: null, count: conteoBase }).then(res, rej);
        },
      });
      return b;
    },
  }),
}));

const recalcularParaAjuste = vi.fn();
const regenerarPdfTrasAjuste = vi.fn();
const conservarPdfAntesDeAjuste = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('@/lib/observability/alerta', () => ({ alertarOperador: vi.fn(async () => undefined) }));
vi.mock('./revision_recalculo', () => ({
  conservarPdfAntesDeAjuste: (...a: unknown[]) => conservarPdfAntesDeAjuste(...a),
  recalcularParaAjuste: (...a: unknown[]) => recalcularParaAjuste(...a),
  regenerarPdfTrasAjuste: (...a: unknown[]) => regenerarPdfTrasAjuste(...a),
}));

const {
  colaRevision, leerFiltrosCola, hayFiltrosCola, codificarCursorCola, decodificarCursorCola,
  revisarLiquidacion, normalizarAjustes, textoRechazoChofer, contarPendientes, COLA_POR_PAGINA,
  puedeFirmarLiquidacion, leerRevision,
} = await import('./revision');
const { DatoInvalido } = await import('./errores');

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fila = (i: number) => ({
  id: U(i), viaje_id: U(1000 + i), created_at: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00+00:00`,
  total_comprobado: 100 + i, total_anticipo: 500, diferencia: 400 - i, estatus: 'revisar', revision: 'pendiente',
  viaje: { folio: `F-${i}`, operador: { nombre: `Chofer ${i}` }, unidad: { numero_economico: `C-${i}` }, terminal: null },
});

beforeEach(() => {
  consultas.length = 0;
  filasBase = [];
  conteoBase = 0;
  errorBase = null;
  filaUnica = null;
  rpc.mockReset();
  conservarPdfAntesDeAjuste.mockReset();
  sendText.mockClear();
  recalcularParaAjuste.mockReset();
  regenerarPdfTrasAjuste.mockReset();
  regenerarPdfTrasAjuste.mockResolvedValue({ regenerado: true });
});

describe('los filtros de la URL', () => {
  it('por omisión la cola son las pendientes, sin más filtro', () => {
    const f = leerFiltrosCola({});
    expect(f.revision).toBe('pendiente');
    expect(hayFiltrosCola(f)).toBe(false);
  });

  it('un uuid mal formado o una fecha imposible se descartan, no se aplican a medias', () => {
    const f = leerFiltrosCola({ operador: 'no-es-uuid', unidad: U(7), desde: '2026-02-31', hasta: '2026-03-01', estado: 'revisar', rev: 'inventada' });
    expect(f.operadorId).toBeNull();
    expect(f.unidadId).toBe(U(7));
    expect(f.desde).toBeNull();
    expect(f.hasta).toBe('2026-03-01');
    expect(f.estado).toBe('revisar');
    expect(f.revision).toBe('pendiente');
  });

  it('un rango al revés se descarta entero', () => {
    const f = leerFiltrosCola({ desde: '2026-08-20', hasta: '2026-08-01' });
    expect(f.desde).toBeNull();
    expect(f.hasta).toBeNull();
  });
});

describe('el cursor de la cola', () => {
  it('va y vuelve, y la basura no se acepta', () => {
    const c = { creadoEn: '2026-08-22T10:00:00.123456+00:00', id: U(9) };
    expect(decodificarCursorCola(codificarCursorCola(c))).toEqual(c);
    expect(decodificarCursorCola('abc')).toBeNull();
    expect(decodificarCursorCola(Buffer.from('2026-08-22|no-uuid').toString('base64url'))).toBeNull();
    expect(decodificarCursorCola(undefined)).toBeNull();
  });
});

describe('colaRevision', () => {
  it('lee por llave y por antigüedad, con conteo real y una fila de más', async () => {
    filasBase = Array.from({ length: COLA_POR_PAGINA + 1 }, (_, i) => fila(i));
    conteoBase = 340;
    const r = await colaRevision('t-1');
    const c = consultas[0];
    expect(c.tabla).toBe('liquidacion');
    expect(c.opciones).toEqual({ count: 'exact' });
    expect(c.select).toContain('viaje:viaje_id!inner(');
    expect(c.eq).toEqual([['tenant_id', 't-1'], ['revision', 'pendiente']]);
    expect(c.orden).toEqual([['created_at', true], ['id', true]]);
    expect(c.rango).toEqual([0, COLA_POR_PAGINA]);
    expect(r.filas).toHaveLength(COLA_POR_PAGINA);
    expect(r.total).toBe(340);
    expect(r.hayMas).toBe(true);
    expect(r.siguiente).not.toBeNull();
    expect(decodificarCursorCola(r.siguiente!)).toEqual({ creadoEn: filasBase[COLA_POR_PAGINA - 1].created_at, id: filasBase[COLA_POR_PAGINA - 1].id });
    expect(r.filas[0]).toMatchObject({ folio: 'F-0', operadorNombre: 'Chofer 0', unidadEco: 'C-0', terminalNombre: null, comprobado: 100 });
  });

  it('los filtros viajan a la base (operador/unidad/terminal por el join, fechas en día de México, estado, revisión)', async () => {
    filasBase = [fila(1)];
    conteoBase = 1;
    await colaRevision('t-1', {
      revision: 'aprobada', estado: 'con_diferencias', operadorId: U(1), unidadId: U(2), terminalId: U(3),
      desde: '2026-08-01', hasta: '2026-08-31',
    }, { creadoEn: '2026-08-10T00:00:00+00:00', id: U(5) });
    const c = consultas[0];
    expect(c.eq).toEqual([
      ['tenant_id', 't-1'], ['revision', 'aprobada'], ['estatus', 'con_diferencias'],
      ['viaje.operador_id', U(1)], ['viaje.unidad_id', U(2)], ['viaje.terminal_id', U(3)],
    ]);
    expect(c.gte).toEqual([['created_at', '2026-08-01T00:00:00-06:00']]);
    expect(c.lte).toEqual([['created_at', '2026-08-31T23:59:59.999-06:00']]);
    expect(c.or).toBe(`created_at.gt.2026-08-10T00:00:00+00:00,and(created_at.eq.2026-08-10T00:00:00+00:00,id.gt.${U(5)})`);
  });

  it('una lectura caída LANZA — nunca una cola vacía que se lea como «nada que firmar»', async () => {
    errorBase = { message: 'se cayó' };
    await expect(colaRevision('t-1')).rejects.toThrow(/revision.cola: se cayó/);
    errorBase = null;
    conteoBase = null;
    await expect(colaRevision('t-1')).rejects.toThrow(/conteo/);
  });

  it('contarPendientes exige el conteo', async () => {
    conteoBase = 12;
    expect(await contarPendientes('t-1')).toBe(12);
    expect(consultas[0].opciones).toEqual({ count: 'exact', head: true });
  });
});

describe('normalizarAjustes', () => {
  it('acepta «8,000», salta los vacíos y rebota negativo, cero y el cero de más', () => {
    expect(normalizarAjustes([{ gastoId: U(1), montoNuevo: '8,000' }, { gastoId: U(2), montoNuevo: '' }]))
      .toEqual([{ gastoId: U(1), montoNuevo: 8000 }]);
    expect(() => normalizarAjustes([{ gastoId: U(1), montoNuevo: '-5' }])).toThrow(DatoInvalido);
    expect(() => normalizarAjustes([{ gastoId: U(1), montoNuevo: '0' }])).toThrow(DatoInvalido);
    expect(() => normalizarAjustes([{ gastoId: U(1), montoNuevo: '80000000' }])).toThrow(DatoInvalido);
    expect(() => normalizarAjustes([{ gastoId: 'x', montoNuevo: '1' }])).toThrow(DatoInvalido);
    expect(() => normalizarAjustes([{ gastoId: U(1), montoNuevo: 'ocho mil' }])).toThrow(DatoInvalido);
  });
});

describe('puedeFirmarLiquidacion', () => {
  it('dueño y contador firman; el jefe de tráfico y un rol desconocido, no (fallar cerrado)', () => {
    expect(puedeFirmarLiquidacion('flota_admin')).toBe(true);
    expect(puedeFirmarLiquidacion('contador')).toBe(true);
    expect(puedeFirmarLiquidacion('superadmin')).toBe(true);
    expect(puedeFirmarLiquidacion('encargado')).toBe(false);
    expect(puedeFirmarLiquidacion('vendedor')).toBe(false);
    expect(puedeFirmarLiquidacion('lo-que-sea')).toBe(false);
    expect(puedeFirmarLiquidacion('')).toBe(false);
  });
});

describe('leerRevision — firmable', () => {
  const filaBase = {
    revision: 'pendiente' as const, revisada_por: null, revisada_por_email: null,
    revisada_en: null, motivo: null, ajustes: [],
    viaje: { estatus: 'liquidado' }, revisor: null,
  };

  it('sin la liquidación, devuelve null', async () => {
    filaUnica = null;
    expect(await leerRevision('t-1', 'x')).toBeNull();
  });

  it('pendiente y sin firmar por nadie: firmable', async () => {
    filaUnica = { ...filaBase, revision: 'pendiente' };
    const r = await leerRevision('t-1', 'x');
    expect(r?.firmable).toBe(true);
  });

  it('cuadró sola (aprobada por el motor, nadie humano firmó): firmable — la persona la puede corregir', async () => {
    filaUnica = { ...filaBase, revision: 'aprobada', revisada_por: null, revisada_por_email: null };
    const r = await leerRevision('t-1', 'x');
    expect(r?.firmable).toBe(true);
  });

  it('ya la firmó una persona: NO firmable, no se firma dos veces', async () => {
    filaUnica = {
      ...filaBase, revision: 'ajustada', revisada_por: 'u-1',
      revisor: { nombre: 'Contralor', email: 'c@flota.mx' },
    };
    const r = await leerRevision('t-1', 'x');
    expect(r?.firmable).toBe(false);
  });

  it('firmada solo por correo (sin id de usuario): también cuenta como humana, NO firmable', async () => {
    filaUnica = { ...filaBase, revision: 'aprobada', revisada_por: null, revisada_por_email: 'c@flota.mx' };
    const r = await leerRevision('t-1', 'x');
    expect(r?.firmable).toBe(false);
  });

  it('rechazada: NUNCA firmable, aunque nadie humano la haya tocado', async () => {
    filaUnica = { ...filaBase, revision: 'rechazada', revisada_por: null, revisada_por_email: null };
    const r = await leerRevision('t-1', 'x');
    expect(r?.firmable).toBe(false);
  });
});

describe('revisarLiquidacion', () => {
  const actor = { id: U(77), email: 'contralor@flota.mx' };

  it('rechazar o ajustar sin motivo no llega a la base', async () => {
    await expect(revisarLiquidacion({ tenantId: 't', liquidacionId: U(1), accion: 'rechazar', actor })).rejects.toThrow(DatoInvalido);
    await expect(revisarLiquidacion({ tenantId: 't', liquidacionId: U(1), accion: 'ajustar', motivo: 'x', ajustes: [], actor })).rejects.toThrow(DatoInvalido);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('aprobar va por la RPC con el actor, y devuelve lo que la base dejó', async () => {
    rpc.mockResolvedValueOnce({ data: { revision: 'aprobada', viaje_id: U(9), folio: 'F-9', total_comprobado: 4200, diferencia: 800, ajustes: null, operador_telefono: '5215512345678' }, error: null });
    const r = await revisarLiquidacion({ tenantId: 't', liquidacionId: U(1), accion: 'aprobar', actor });
    expect(rpc).toHaveBeenCalledWith('revisar_liquidacion', {
      p_tenant: 't', p_liquidacion: U(1), p_accion: 'aprobar', p_motivo: null, p_ajustes: null, p_actor: U(77), p_actor_email: 'contralor@flota.mx',
      p_recalculo: null,
    });
    expect(r).toMatchObject({ revision: 'aprobada', folio: 'F-9', totalComprobado: 4200, diferencia: 800, ajustes: [], choferAvisado: null });
    expect(sendText).not.toHaveBeenCalled();
  });

  // ── AUDITORÍA 25, BE-C1a/BE-C1b/DATOS-C1 (CRÍTICO) ────────────────────────
  const RECALCULO = {
    totalComprobado: 8000, diferencia: -3000, estatus: 'con_diferencias',
    diferencias: [{ tipo: 'sobre_politica' }], iepsAcreditable: 10, litrosDieselAcreditables: 120,
    ivaAcreditable: 1200, peajeAcreditable: 50,
  };
  const CUADRE_RECALCULADO = { ...RECALCULO, viajeId: U(9), totalAnticipo: 5000, gastos: [], totalDeducible: 0, totalNoDeducible: 0, totalPorConfirmar: 0 };

  it('ajustar RECALCULA el motor sobre los gastos vivos ANTES de llamar a la RPC, y manda el recálculo como p_recalculo', async () => {
    filaUnica = { viaje_id: U(9) };
    recalcularParaAjuste.mockResolvedValueOnce({ recalculo: RECALCULO, cuadre: CUADRE_RECALCULADO });
    rpc.mockResolvedValueOnce({
      data: {
        revision: 'ajustada', viaje_id: U(9), folio: 'F-9', total_comprobado: 8000, diferencia: -3000,
        ajustes: [{ gasto_id: U(3), concepto: 'diesel', monto_anterior: 800, monto_nuevo: 8000 }],
        revisada_por_email: 'contralor@flota.mx', revisada_en: '2026-09-03T10:00:00Z',
      },
      error: null,
    });
    const r = await revisarLiquidacion({ tenantId: 't', liquidacionId: U(1), accion: 'ajustar', motivo: 'el ticket dice 8,000', ajustes: [{ gastoId: U(3), montoNuevo: 8000 }], actor });

    // El recálculo se pidió ANTES de la RPC (viajeId resuelto por fuera) y con
    // los MISMOS ajustes que se le mandan a la base.
    expect(recalcularParaAjuste).toHaveBeenCalledWith('t', U(9), [{ gastoId: U(3), montoNuevo: 8000 }]);
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_accion: 'ajustar', p_motivo: 'el ticket dice 8,000', p_ajustes: [{ gastoId: U(3), montoNuevo: 8000 }],
      p_recalculo: RECALCULO,
    });
    expect(r.ajustes).toEqual([{ gastoId: U(3), concepto: 'diesel', montoAnterior: 800, montoNuevo: 8000 }]);

    // Y DESPUÉS de que la base confirmó, se regenera el papel con el MISMO
    // cuadre recalculado y el sello de quién/cuándo firmó — no un `now()` a
    // ciegas ni el actor que LLEGÓ (el que la RPC resolvió puede ser otro).
    expect(regenerarPdfTrasAjuste).toHaveBeenCalledWith('t', U(9), U(1), CUADRE_RECALCULADO, 'contralor@flota.mx', '2026-09-03T10:00:00Z');
  });

  it('sin liquidación que resolver, ni el recálculo ni la RPC se llaman — no se gasta el motor para nada', async () => {
    filaUnica = null; // viajeIdDeLiquidacion no encuentra la fila
    await expect(revisarLiquidacion({
      tenantId: 't', liquidacionId: U(1), accion: 'ajustar', motivo: 'x', ajustes: [{ gastoId: U(3), montoNuevo: 100 }], actor,
    })).rejects.toThrow(DatoInvalido);
    expect(recalcularParaAjuste).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('si el recálculo del motor falla, la RPC nunca se llama — no se ajusta con un desglose que no se pudo calcular', async () => {
    filaUnica = { viaje_id: U(9) };
    recalcularParaAjuste.mockRejectedValueOnce(new Error('el comprobante no es de este viaje'));
    await expect(revisarLiquidacion({
      tenantId: 't', liquidacionId: U(1), accion: 'ajustar', motivo: 'x', ajustes: [{ gastoId: U(3), montoNuevo: 100 }], actor,
    })).rejects.toThrow(/el comprobante no es de este viaje/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('si no puede conservar la pareja antigua, no ejecuta el ajuste ni firma', async () => {
    filaUnica = { viaje_id: U(9) };
    recalcularParaAjuste.mockResolvedValue({ recalculo: RECALCULO, cuadre: CUADRE_RECALCULADO });
    conservarPdfAntesDeAjuste.mockRejectedValueOnce(new Error('no se pudo conservar la pareja'));
    await expect(revisarLiquidacion({ tenantId: 't', liquidacionId: U(1), accion: 'ajustar', motivo: 'x', ajustes: [{ gastoId: U(3), montoNuevo: 100 }], actor }))
      .rejects.toThrow('no se pudo conservar la pareja');
    expect(rpc).not.toHaveBeenCalled();
    expect(regenerarPdfTrasAjuste).not.toHaveBeenCalled();
  });

  it.each(['LR019', 'LR022'])('conserva el rechazo %s de duplicados sin reintentar', async (code) => {
    filaUnica = { viaje_id: U(9) };
    recalcularParaAjuste.mockResolvedValue({ recalculo: RECALCULO, cuadre: CUADRE_RECALCULADO });
    const message = code === 'LR019' ? 'copia excluida: rechaza y revisa' : 'grupo duplicado cuya identidad depende del monto: rechaza y revisa';
    rpc.mockResolvedValueOnce({ data: null, error: { code, message } });
    const error = await revisarLiquidacion({ tenantId: 't', liquidacionId: U(1), accion: 'ajustar', motivo: 'x', ajustes: [{ gastoId: U(3), montoNuevo: 100 }], actor }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatoInvalido);
    expect((error as Error).message).toBe(message);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(regenerarPdfTrasAjuste).not.toHaveBeenCalled();
  });

  it('un PDF que no se pudo regenerar no tumba el ajuste YA firme en la base — se dice, no se revierte', async () => {
    filaUnica = { viaje_id: U(9) };
    recalcularParaAjuste.mockResolvedValueOnce({ recalculo: RECALCULO, cuadre: CUADRE_RECALCULADO });
    regenerarPdfTrasAjuste.mockResolvedValueOnce({ regenerado: false });
    rpc.mockResolvedValueOnce({
      data: { revision: 'ajustada', viaje_id: U(9), folio: 'F-9', total_comprobado: 8000, diferencia: -3000, ajustes: [] },
      error: null,
    });
    const r = await revisarLiquidacion({ tenantId: 't', liquidacionId: U(1), accion: 'ajustar', motivo: 'x', ajustes: [{ gastoId: U(3), montoNuevo: 8000 }], actor });
    expect(r.revision).toBe('ajustada');
    expect(r.pdfPendiente).toBe(true);
  });

  it('LR020 (el recálculo no coincide con el ajuste — una carrera) sale como mensaje para la persona; LR021 (recálculo faltante) es falla del sistema', async () => {
    filaUnica = { viaje_id: U(9) };
    recalcularParaAjuste.mockResolvedValue({ recalculo: RECALCULO, cuadre: CUADRE_RECALCULADO });

    rpc.mockResolvedValueOnce({ data: null, error: { code: 'LR020', message: 'el recálculo no coincide con el ajuste aplicado: vuelve a intentar' } });
    await expect(revisarLiquidacion({ tenantId: 't', liquidacionId: U(1), accion: 'ajustar', motivo: 'x', ajustes: [{ gastoId: U(3), montoNuevo: 100 }], actor }))
      .rejects.toThrow(/vuelve a intentar/);

    rpc.mockResolvedValueOnce({ data: null, error: { code: 'LR021', message: 'ajustar exige el recálculo del motor' } });
    const e = await revisarLiquidacion({ tenantId: 't', liquidacionId: U(1), accion: 'ajustar', motivo: 'x', ajustes: [{ gastoId: U(3), montoNuevo: 100 }], actor }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(DatoInvalido);
  });

  it('rechazar avisa al chofer DESPUÉS de que la base confirmó, con el folio y el motivo y sin cifras', async () => {
    rpc.mockResolvedValueOnce({ data: { revision: 'rechazada', viaje_id: U(9), folio: 'F-9', total_comprobado: 4900, diferencia: 100, ajustes: null, operador_telefono: '5215512345678' }, error: null });
    const r = await revisarLiquidacion({ tenantId: 't', liquidacionId: U(1), accion: 'rechazar', motivo: 'faltan las casetas del regreso', actor });
    expect(r.revision).toBe('rechazada');
    expect(r.choferAvisado).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
    const [tel, texto] = sendText.mock.calls[0] as unknown as [string, string];
    expect(tel).toBe('5215512345678');
    expect(texto).toContain('F-9');
    expect(texto).toContain('faltan las casetas del regreso');
    expect(texto).not.toMatch(/\$/);
  });

  it('sin teléfono, o si Meta rechaza, la liquidación queda rechazada igual y se dice que el chofer no se enteró', async () => {
    rpc.mockResolvedValueOnce({ data: { revision: 'rechazada', viaje_id: U(9), folio: 'F-9', operador_telefono: null }, error: null });
    let r = await revisarLiquidacion({ tenantId: 't', liquidacionId: U(1), accion: 'rechazar', motivo: 'x', actor });
    expect(r.choferAvisado).toBe(false);
    expect(sendText).not.toHaveBeenCalled();

    rpc.mockResolvedValueOnce({ data: { revision: 'rechazada', viaje_id: U(9), folio: 'F-9', operador_telefono: '5215512345678' }, error: null });
    sendText.mockRejectedValueOnce(new Error('meta caída'));
    r = await revisarLiquidacion({ tenantId: 't', liquidacionId: U(1), accion: 'rechazar', motivo: 'x', actor });
    expect(r.revision).toBe('rechazada');
    expect(r.choferAvisado).toBe(false);
  });

  it('los SQLSTATE de la RPC salen como mensaje para la persona; lo demás es falla del sistema', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'LR010', message: 'la liquidación X ya fue revisada (aprobada) por a@b el hoy: no se firma dos veces' } });
    await expect(revisarLiquidacion({ tenantId: 't', liquidacionId: U(1), accion: 'aprobar', actor })).rejects.toThrow(/no se firma dos veces/);

    rpc.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'duplicate key' } });
    await expect(revisarLiquidacion({ tenantId: 't', liquidacionId: U(1), accion: 'rechazar', motivo: 'x', actor })).rejects.toThrow(/otro viaje abierto/);

    rpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'canceling statement' } });
    const e = await revisarLiquidacion({ tenantId: 't', liquidacionId: U(1), accion: 'aprobar', actor }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(DatoInvalido);
  });

  it('el texto al chofer no inventa cifras: solo el folio y el motivo que escribió la persona', () => {
    const t = textoRechazoChofer('F-1041', 'faltan casetas');
    expect(t).toContain('F-1041');
    expect(t).toContain('faltan casetas');
    // Fuera del folio y del motivo, el aviso no trae NINGÚN número ni signo de
    // peso: las cifras las recalcula el motor cuando el chofer complete.
    const resto = t.replace('F-1041', '').replace('faltan casetas', '');
    expect(resto).not.toMatch(/\d/);
    expect(resto).not.toContain('$');
  });
});
