import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 18 · A20 — las dos reglas que impiden cobrar contra nada vivían
// en dos `if` que ninguna prueba tocaba. `evaluarAbono` (pura) SÍ estaba
// probada; lo que no estaba probado era el CABLEADO: ¿registrarPago consulta
// el veredicto? ¿cancelarFactura rechaza con pagos encima? Borrando
// las dos guardas la suite quedaba verde y una factura de $11,600 con $10,000
// pagados aceptaba un abono de $2,000.
//
// No es "probar el mock": la base es un doble mínimo y lo que se afirma es
// qué escrituras NO ocurren cuando la regla dice que no.
// ═══════════════════════════════════════════════════════════════════════════

type Resp = { data?: unknown; error?: { message: string } | null; count?: number | null };
const respuestas = new Map<string, Resp[]>();
const escrituras: Array<{
  tabla: string; op: 'insert' | 'update'; fila: Record<string, unknown>;
  filtros: Array<[string, unknown]>; filtrosIn: Array<[string, unknown[]]>;
}> = [];

// ── ANCLAS DE VERDAD, NO SOLO REGISTRADAS ───────────────────────────────────
//
// Auditoría 21: el mock de arriba solo GUARDABA los filtros en `filtros` para
// que una prueba pudiera afirmar sobre ellos a mano — pero la respuesta que
// `responder()` entregaba salía de `respuestas.get(tabla)` por NOMBRE DE TABLA
// únicamente, sin cruzarla contra esos filtros. Borrar un `.eq('tenant_id',…)`
// de producción dejaba la suite entera en verde porque ninguna prueba sin esa
// aserción explícita podía notarlo.
//
// `filasSimuladas` es la fila que "de verdad" existe en la base para esa
// tabla en la prueba. Cuando una prueba la registra con `establecerFila`, un
// UPDATE que no calce sus anclas (`.eq()`/`.in()` acumulados) contra esa fila
// devuelve 0 filas — SIN IMPORTAR qué respuesta haya en la cola —, tal como
// pasaría contra Postgres real con un WHERE que no aplica. Así, borrar un
// ancla en producción cambia qué filtros SE ACUMULAN (uno menos) y por lo
// tanto si el chequeo de abajo detecta o no el desajuste, sin que la prueba
// tenga que afirmar sobre `filtros` a mano.
const filasSimuladas = new Map<string, Record<string, unknown>>();
function establecerFila(tabla: string, fila: Record<string, unknown>) { filasSimuladas.set(tabla, fila); }
function anclasCalzan(
  fila: Record<string, unknown>,
  filtros: Array<[string, unknown]>,
  filtrosIn: Array<[string, unknown[]]>,
): boolean {
  return filtros.every(([c, v]) => fila[c] === v) && filtrosIn.every(([c, vs]) => vs.includes(fila[c]));
}

function builder(tabla: string) {
  const filtros: Array<[string, unknown]> = [];
  const filtrosIn: Array<[string, unknown[]]> = [];
  let pendiente: { op: 'insert' | 'update'; fila: Record<string, unknown> } | null = null;
  const responder = () => {
    if (pendiente) {
      escrituras.push({ tabla, ...pendiente, filtros, filtrosIn });
      if (pendiente.op === 'update') {
        const fila = filasSimuladas.get(tabla);
        if (fila && !anclasCalzan(fila, filtros, filtrosIn)) return { data: [], error: null };
      }
    }
    const cola = respuestas.get(tabla);
    return cola && cola.length > 0 ? cola.shift()! : { data: null, error: null };
  };
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: () => b,
    eq: (c: string, v: unknown) => { filtros.push([c, v]); return b; },
    // `.is('revocada_en', null)` es un filtro con su propia semántica y cuenta
    // como tal: sin él, cancelar una factura pisaría el sello de una liga ya
    // revocada.
    is: (c: string, v: unknown) => { filtros.push([c, v]); return b; },
    lte: (c: string, v: unknown) => { filtros.push([c, v]); return b; },
    // Antes `in: () => b` no registraba nada: ningún UPDATE con `.in()` podía
    // tener ancla verificable, ni a mano ni por el chequeo de arriba.
    in: (c: string, v: unknown[]) => { filtrosIn.push([c, v]); return b; },
    maybeSingle: () => b,
    single: () => b,
    insert: (fila: Record<string, unknown>) => { pendiente = { op: 'insert', fila }; return b; },
    update: (fila: Record<string, unknown>) => { pendiente = { op: 'update', fila }; return b; },
    then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(responder).then(res, rej),
  });
  return b;
}
const rpc = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ from: (t: string) => builder(t), rpc: (...a: unknown[]) => rpc(...a) }),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./presupuesto', () => ({ acotada: (q: unknown) => q }));

const { registrarPago, cancelarFactura, crearFactura, marcarEmitida } = await import('./facturacion_escritura');
const { DatoInvalido, AbonoYaRegistrado } = await import('./errores');

const T = 't-1';
const FACTURA = 'ad662d33-6934-459c-a128-bdf0393f0f44';
const pago = (monto: number) => ({ facturaId: FACTURA, fecha: '2026-08-20', monto, metodo: 'transferencia', referencia: null });
const escribioEn = (tabla: string) => escrituras.filter((e) => e.tabla === tabla);

beforeEach(() => { respuestas.clear(); escrituras.length = 0; rpc.mockReset(); filasSimuladas.clear(); });

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 18 · DAT-05 — el veredicto se mudó a la base, y por eso este
// bloque cambió de forma.
//
// Antes se comprobaba que `registrarPago` consultara `evaluarAbono` y no
// escribiera cuando el veredicto decía que no. Eso ya no se puede probar aquí
// —ni tiene sentido—: la decisión ocurre DENTRO de `registrar_pago_tx`, con la
// factura tomada `for update`, que es lo único que impide que dos abonos
// simultáneos vean los dos el mismo saldo. Las cuatro reglas viven ahora en
// SQL y se prueban contra Postgres (bloque 131 de verificaciones.sql).
//
// Lo que SÍ es de este lado, y es lo que se prueba: que el rechazo de la base
// llegue traducido a las palabras del contralor con la cifra correcta, que una
// CAÍDA no se lea como un rechazo de negocio, y que ninguna escritura suelta
// haya sobrevivido a la mudanza.
// ═══════════════════════════════════════════════════════════════════════════
describe('registrarPago — la decisión la toma la base; aquí se traduce', () => {
  it('el pago que entra: un solo RPC con los siete parámetros, y la bitácora con el id que devolvió la base', async () => {
    rpc.mockResolvedValue({ data: { pago_id: 'pago-1', saldada: true, saldo_previo: 1600 }, error: null });

    await registrarPago(T, pago(1600), { id: 'u-conta' });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe('registrar_pago_tx');
    expect(rpc.mock.calls[0][1]).toEqual({
      p_tenant: T, p_factura: FACTURA, p_fecha: '2026-08-20',
      p_monto: 1600, p_metodo: 'transferencia', p_referencia: null,
      // El pago TECLEADO no nace de ninguna propuesta y no compite por la
      // llave de idempotencia: `null` explícito, no ausencia.
      p_propuesta: null,
    });
    expect(escribioEn('bitacora_auditoria')[0].fila).toMatchObject({
      accion: 'pago.registrado', actor_id: 'u-conta', entidad_id: 'pago-1',
    });
  });

  // ── `c7-5` · LA LLAVE DE IDEMPOTENCIA LLEGA HASTA LA BASE ───────────────
  it('la propuesta viaja al RPC, que es donde el índice único la vigila', async () => {
    rpc.mockResolvedValue({ data: { pago_id: 'pago-1', saldada: false }, error: null });
    await registrarPago(T, pago(1600), undefined, 'prop-9');
    expect((rpc.mock.calls[0][1] as { p_propuesta: unknown }).p_propuesta).toBe('prop-9');
    expect(escribioEn('bitacora_auditoria')[0].fila).toMatchObject({ accion: 'pago.registrado' });
  });

  it('el 23505 con propuesta es `AbonoYaRegistrado`, y NO se anota un pago que no nació', async () => {
    // Es la base diciendo «ese abono ya está»: quien concilia tiene que poder
    // colgarse del que existe en vez de crear un segundo. Si esto se leyera
    // como un error genérico, la carrera de `c7-5` volvería con otra cara.
    rpc.mockResolvedValue({ data: null, error: { code: '23505', message: 'duplicate key' } });
    const err = await registrarPago(T, pago(1600), undefined, 'prop-9').catch((e) => e);
    expect(err).toBeInstanceOf(AbonoYaRegistrado);
    expect(escrituras).toEqual([]);
  });

  it('un 23505 SIN propuesta no se disfraza: no hay abono del que colgarse', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '23505', message: 'duplicate key' } });
    const err = await registrarPago(T, pago(1600)).catch((e) => e);
    expect(err).not.toBeInstanceOf(AbonoYaRegistrado);
    expect(err).toBeInstanceOf(Error);
  });

  it('NINGUNA escritura suelta sobrevivió: ni el insert del pago ni el update del estatus salen de aquí', async () => {
    // El estatus `pagada` se escribía aquí, en un segundo statement cuyo fallo
    // solo se podía loguear ("el pago quedó pero la factura no pasó a pagada").
    // Ese estado ya no existe: entra en la misma transacción que el pago.
    rpc.mockResolvedValue({ data: { pago_id: 'pago-1', saldada: true }, error: null });
    await registrarPago(T, pago(1600));
    expect(escribioEn('pago_recibido')).toEqual([]);
    expect(escribioEn('factura_emitida')).toEqual([]);
  });

  it('el sobrepago (CU011) le dice al contralor el saldo exacto que sí cabe ($1,600), y no anota nada', async () => {
    // El caso de la auditoría: $11,600 con $10,000 pagados NO acepta $2,000.
    rpc.mockResolvedValue({ data: null, error: { code: 'CU011', message: 'motivo=sobrepago saldo=1600.00' } });

    const err = await registrarPago(T, pago(2000)).catch((e) => e);
    expect(err).toBeInstanceOf(DatoInvalido);
    expect(err.message).toMatch(/1,600/);
    expect(err.message).toMatch(/nota de crédito/);
    expect(escrituras).toEqual([]);
  });

  it('los otros tres motivos llegan con SU texto, no con uno genérico', async () => {
    for (const [motivo, esperado] of [
      ['cancelada', /cancelada/],
      ['borrador', /borrador/],
      ['pagada', /ya está saldada/],
    ] as const) {
      rpc.mockResolvedValue({ data: null, error: { code: 'CU011', message: `motivo=${motivo} saldo=0` } });
      await expect(registrarPago(T, pago(100))).rejects.toThrow(esperado);
    }
  });

  it('una factura de OTRA flota (CU010) se rechaza sin escribir', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'CU010', message: 'factura fuera de la flota' } });
    await expect(registrarPago(T, pago(100))).rejects.toThrow(/no está en tu flota/);
    expect(escrituras).toEqual([]);
  });

  it('la base caída NO se lee como rechazo de negocio: Error, no DatoInvalido', async () => {
    // Es la misma regla de siempre en este archivo, ahora sobre el error del
    // RPC: un timeout de `acotada` llega SIN code, y tratarlo como "la factura
    // no admite el pago" le mentiría al contralor sobre su propia cartera.
    rpc.mockResolvedValue({ data: null, error: { message: 'sin respuesta en 8000 ms (tope de consulta)' } });
    const err = await registrarPago(T, pago(100)).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DatoInvalido);
    expect(escrituras).toEqual([]);
  });

  it('un RPC que dice "ok" sin id de pago es un error, no un pago que se da por bueno', async () => {
    rpc.mockResolvedValue({ data: {}, error: null });
    await expect(registrarPago(T, pago(100))).rejects.toThrow(/no devolvió el id/);
    expect(escribioEn('bitacora_auditoria')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24 · BE-3 — el conteo de pagos y la cancelación se mudaron a la
// base (`cancelar_factura_tx`, 0284), y por eso este bloque cambió de forma.
//
// Antes se comprobaba que `cancelarFactura` contara los pagos ANTES del
// UPDATE. Eso ya no se puede probar aquí —ni tiene sentido—: entre el conteo
// y el UPDATE cabía un abono, y la única forma de que no quepa es que los dos
// ocurran con la factura tomada `for update`, que es lo que hace el RPC y lo
// que el bloque 232 de verificaciones.sql ejecuta contra Postgres.
//
// Lo que SÍ es de este lado: que el rechazo de la base llegue con las palabras
// del contralor, que una CAÍDA no se lea como rechazo de negocio, que ninguna
// escritura suelta (ni conteo, ni UPDATE de factura_emitida) haya sobrevivido
// a la mudanza, y que la liga de pago se revoque DESPUÉS y solo si se canceló.
// ═══════════════════════════════════════════════════════════════════════════
describe('cancelarFactura — la decisión la toma la base; aquí se traduce (BE-3)', () => {
  it('un abono que entró en la ventana NO deja un CFDI cancelado con dinero encima: CU016 con_pagos → DatoInvalido, sin tocar la factura ni la liga', async () => {
    // El escenario de BE-3: el contador concilió $10,000 mientras el contralor
    // pulsaba Cancelar. El RPC lo ve con la fila trabada y rebota.
    rpc.mockResolvedValue({ data: null, error: { code: 'CU016', message: 'motivo=con_pagos pagos=1' } });
    await expect(cancelarFactura(T, FACTURA)).rejects.toThrow(/pagos registrados/);
    expect(escribioEn('factura_emitida')).toEqual([]);
    expect(escribioEn('portal_pago_liga')).toEqual([]);
    expect(escribioEn('bitacora_auditoria')).toEqual([]);
  });

  it('sin pagos cancela por UN solo RPC con tenant y factura, y anota la bitácora', async () => {
    rpc.mockResolvedValue({ data: { factura_id: FACTURA, estatus_previo: 'emitida' }, error: null });
    respuestas.set('portal_pago_liga', [{ data: [], error: null }]);
    await cancelarFactura(T, FACTURA, { id: 'u-1' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('cancelar_factura_tx', { p_tenant: T, p_factura: FACTURA });
    // Ninguna escritura suelta sobrevivió a la mudanza: ni conteo ni UPDATE.
    expect(escribioEn('factura_emitida')).toEqual([]);
    expect(escribioEn('pago_recibido')).toEqual([]);
    expect(escribioEn('bitacora_auditoria')[0].fila).toMatchObject({ accion: 'factura.cancelada' });
  });

  // ── `c7-7` · CANCELAR APAGA EL ENLACE PÚBLICO DE ESA FACTURA ────────────
  it('cancelar REVOCA las ligas vivas: un CFDI cancelado no puede seguir cobrando', async () => {
    // Sin esto, el cliente abría el mismo link y veía «Saldo pendiente
    // $34,800.00» con el formulario activo sobre una factura que ante el SAT ya
    // no existe — `factura_saldo` calcula total − pagos sin mirar el estatus.
    rpc.mockResolvedValue({ data: { factura_id: FACTURA, estatus_previo: 'emitida' }, error: null });
    respuestas.set('portal_pago_liga', [{ data: [{ id: 'liga-1' }], error: null }]);
    await cancelarFactura(T, FACTURA, { id: 'u-1' });

    const rev = escribioEn('portal_pago_liga');
    expect(rev).toHaveLength(1);
    expect(rev[0].fila).toMatchObject({ revocada_por: 'u-1' });
    expect(rev[0].filtros).toEqual(expect.arrayContaining([
      ['tenant_id', T], ['factura_id', FACTURA], ['revocada_en', null],
    ]));
    // El orden importa: la factura se cancela (el RPC) ANTES de matar el
    // enlace. Al revés, un RPC fallido dejaría muerta la liga de una factura viva.
    expect(escribioEn('bitacora_auditoria').map((e) => e.fila.accion))
      .toContain('portal_pago.liga_revocada');
  });

  it('si la revocación falla, se LANZA: no se deja un enlace suelto en silencio', async () => {
    rpc.mockResolvedValue({ data: { factura_id: FACTURA, estatus_previo: 'emitida' }, error: null });
    respuestas.set('portal_pago_liga', [{ data: null, error: { message: 'sin red' } }]);
    await expect(cancelarFactura(T, FACTURA)).rejects.toThrow(/SÍ quedó cancelada/);
    // Y la cancelación queda anotada: pasó de verdad.
    expect(escribioEn('bitacora_auditoria')[0].fila).toMatchObject({ accion: 'factura.cancelada' });
  });

  it('la base caída NO se lee como rechazo de negocio: Error, no DatoInvalido, y la liga no se toca', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'sin respuesta en 8000 ms (tope de consulta)' } });
    const err = await cancelarFactura(T, FACTURA).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DatoInvalido);
    expect(escribioEn('portal_pago_liga')).toEqual([]);
    expect(escribioEn('bitacora_auditoria')).toEqual([]);
  });

  it('ya cancelada o pagada (CU016 motivo=estatus): se dice, sin tocar la liga', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'CU016', message: 'motivo=estatus estatus=cancelada' } });
    await expect(cancelarFactura(T, FACTURA)).rejects.toThrow(/no se pudo cancelar/);
    expect(escribioEn('portal_pago_liga')).toEqual([]);
    expect(escribioEn('bitacora_auditoria')).toEqual([]);
  });

  it('una factura de OTRA flota (CU010) se rechaza sin escribir', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'CU010', message: 'factura fuera de la flota' } });
    await expect(cancelarFactura(T, FACTURA)).rejects.toThrow(/no está en tu flota/);
    expect(escrituras).toEqual([]);
  });

  it('un id que no es uuid se rechaza antes de tocar la base', async () => {
    await expect(cancelarFactura(T, 'x')).rejects.toThrow(DatoInvalido);
    expect(rpc).not.toHaveBeenCalled();
    expect(escrituras).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RES-22 (auditoría prod, mig. 0166) — LA SERIE LLEGA A LA BASE, Y EL CHOQUE
// DE FOLIO DICE CONTRA QUÉ SE COMPARÓ.
//
// La validación pura (normalizar, rechazar) se prueba en
// `facturacion_escritura.test.ts` y la garantía del índice contra Postgres en
// el bloque 138 de `verificaciones.sql`. Lo que falta —y es justo lo que se
// rompe callado— es el CABLEADO: que `serie` viaje en el INSERT (borrarla de
// ahí dejaría la suite verde y todas las facturas sin serie en producción) y
// que el 23505 se traduzca con la llave completa.
// ═══════════════════════════════════════════════════════════════════════════

const CLIENTE = '11111111-2222-3333-4444-555555555555';
const factura = (over: Record<string, unknown> = {}) => ({
  clienteId: CLIENTE, fecha: '2026-01-02', subtotal: 10000, iva: 1600, retencion: 0, total: 11600,
  serie: 'A' as string | null, folio: '1' as string | null, cfdiUuid: null,
  estatus: 'borrador' as const, viajeIds: [] as string[], ...over,
});

describe('crearFactura — la serie viaja con el folio (RES-22)', () => {
  it('el INSERT lleva `serie`, y en NULL cuando la flota no usa series', async () => {
    respuestas.set('cliente', [{ data: { id: CLIENTE, dias_credito: null }, error: null }]);
    respuestas.set('factura_emitida', [{ data: { id: FACTURA }, error: null }]);
    await crearFactura(T, factura({ serie: null }));
    const ins = escribioEn('factura_emitida');
    expect(ins).toHaveLength(1);
    expect(ins[0].fila).toMatchObject({ serie: null, folio: '1', tenant_id: T });
  });

  it('y con serie la manda tal como se capturó', async () => {
    respuestas.set('cliente', [{ data: { id: CLIENTE, dias_credito: null }, error: null }]);
    respuestas.set('factura_emitida', [{ data: { id: FACTURA }, error: null }]);
    await crearFactura(T, factura({ serie: 'A' }));
    expect(escribioEn('factura_emitida')[0].fila).toMatchObject({ serie: 'A' });
  });

  it('el 23505 del consecutivo se cuenta con serie, folio y ejercicio', async () => {
    respuestas.set('cliente', [{ data: { id: CLIENTE, dias_credito: null }, error: null }]);
    respuestas.set('factura_emitida', [{
      data: null,
      error: { message: 'duplicate key value violates unique constraint "factura_folio_unico"' },
    }]);
    const err = await crearFactura(T, factura({ serie: 'A', folio: '1', fecha: '2026-01-02' })).catch((e) => e);
    expect(err).toBeInstanceOf(DatoInvalido);
    expect(err.message).toContain('serie «A»');
    expect(err.message).toContain('ejercicio 2026');
    expect(err.message).toContain('«1»');
  });

  it('el CHECK de la serie se traduce, no sale como error crudo de Postgres', async () => {
    respuestas.set('cliente', [{ data: { id: CLIENTE, dias_credito: null }, error: null }]);
    respuestas.set('factura_emitida', [{
      data: null,
      error: { message: 'new row violates check constraint "factura_serie_btrim"' },
    }]);
    const err = await crearFactura(T, factura()).catch((e) => e);
    expect(err).toBeInstanceOf(DatoInvalido);
    expect(err.message).toMatch(/serie no puede ir vacía/);
  });
});

describe('marcarEmitida — la serie sólo se toca si de verdad viene', () => {
  it('sin serie en el sello, el UPDATE no la nombra: no borra la del borrador', async () => {
    respuestas.set('factura_emitida', [{ data: [{ id: FACTURA }], error: null }]);
    await marcarEmitida(T, FACTURA, { folio: '1', cfdiUuid: FACTURA });
    const upd = escribioEn('factura_emitida');
    expect(upd).toHaveLength(1);
    expect(Object.keys(upd[0].fila)).not.toContain('serie');
  });

  it('con serie en el sello, la escribe normalizada (el CFDI manda)', async () => {
    respuestas.set('factura_emitida', [{ data: [{ id: FACTURA }], error: null }]);
    await marcarEmitida(T, FACTURA, { serie: '  A  ', folio: '1', cfdiUuid: FACTURA });
    expect(escribioEn('factura_emitida')[0].fila).toMatchObject({ serie: 'A' });
  });

  it('con serie vacía la BORRA a propósito: el CFDI se timbró sin serie', async () => {
    respuestas.set('factura_emitida', [{ data: [{ id: FACTURA }], error: null }]);
    await marcarEmitida(T, FACTURA, { serie: '', folio: '1', cfdiUuid: FACTURA });
    expect(escribioEn('factura_emitida')[0].fila).toMatchObject({ serie: null });
  });

  it('el choque al sellar NO inventa el ejercicio: la fecha no viaja en el sello', async () => {
    respuestas.set('factura_emitida', [{
      data: null,
      error: { message: 'duplicate key value violates unique constraint "factura_folio_unico"' },
    }]);
    const err = await marcarEmitida(T, FACTURA, { folio: '1', cfdiUuid: FACTURA }).catch((e) => e);
    expect(err).toBeInstanceOf(DatoInvalido);
    expect(err.message).toContain('ese mismo ejercicio');
    expect(err.message).not.toMatch(/ejercicio \d{4}/);
  });
});

// ── Auditoría 21 · ALTO — las dos anclas del UPDATE de `marcarEmitida` ──────
//
// `.eq('tenant_id', tenantId)` y `.eq('estatus', 'borrador')` no tenían
// ninguna prueba que dependiera de que existieran: las de arriba solo miran
// qué campos trae `fila`. Aquí se registra la fila REAL simulada — de otra
// flota, o ya no en borrador — para que el mock mismo (vía `anclasCalzan`)
// decida si el UPDATE debería tocar 0 filas, en vez de que la cola de
// respuestas lo diga a mano. Si el ancla correspondiente desaparece de
// producción, el filtro deja de acumularse, deja de haber nada que no calce,
// y `marcarEmitida` se lee como éxito sobre una factura ajena o ya sellada:
// exactamente la mutación que describe la auditoría.
describe('marcarEmitida — las anclas del UPDATE (tenant_id + estatus) protegen de verdad', () => {
  it('una factura con el mismo id pero de OTRA flota no se sella (ancla tenant_id)', async () => {
    establecerFila('factura_emitida', { id: FACTURA, tenant_id: 'otro-tenant', estatus: 'borrador' });
    respuestas.set('factura_emitida', [{ data: [{ id: FACTURA }], error: null }]);
    await expect(marcarEmitida(T, FACTURA, { folio: '1', cfdiUuid: FACTURA }))
      .rejects.toThrow(/no está en borrador en tu flota/);
  });

  it('una factura que YA NO está en borrador no se vuelve a sellar (ancla estatus)', async () => {
    establecerFila('factura_emitida', { id: FACTURA, tenant_id: T, estatus: 'cancelada' });
    respuestas.set('factura_emitida', [{ data: [{ id: FACTURA }], error: null }]);
    await expect(marcarEmitida(T, FACTURA, { folio: '1', cfdiUuid: FACTURA }))
      .rejects.toThrow(/no está en borrador en tu flota/);
  });
});
