// ═══════════════════════════════════════════════════════════════════════════
// EL ESPEJO EN JS DE LAS RPC DE LA 0152 — solo para pruebas (no es *.test.ts
// para que vitest no lo corra solo; lo importan las pruebas de equivalencia).
//
// Cada función de aquí reproduce, de forma INDEPENDIENTE y leyendo la
// migración, lo que `rentabilidad_tenant`, `cartera_tenant`, `cobranza_tenant`,
// `facturacion_clientes_tenant`, `tablero_operacion_tenant`,
// `carga_operadores_tenant` e `incidencias_tenant` devuelven en jsonb a partir
// de una base sintética en memoria. Con él, las pruebas de equivalencia
// comparan la reducción JS VIEJA (copia congelada de antes de la 0152) contra
// la función NUEVA con la RPC doblada — sobre el mismo dataset, con dos
// flotas, para que el aislamiento por `tenant_id` también se pruebe. Es el
// mismo patrón que analytics_kpis_acreditables.test.ts (0112).
//
// El que el espejo coincida con Postgres de verdad lo comprueba el bloque 124
// de supabase/verificaciones.sql contra una siembra a mano.
// ═══════════════════════════════════════════════════════════════════════════

import { hoyMx } from '@/lib/formato';

export interface BaseSintetica {
  tenant: string[];
  cliente: Array<{ id: string; tenant_id: string; nombre: string; rfc?: string | null; dias_credito?: number | null; activo?: boolean; contacto?: string | null; correo?: string | null; telefono?: string | null }>;
  operador: Array<{ id: string; tenant_id: string; nombre: string; telefono?: string | null; activo?: boolean }>;
  unidad: Array<{ id: string; tenant_id: string; numero_economico: string; estado: string; activo?: boolean }>;
  viaje: Array<{ id: string; tenant_id: string; operador_id: string | null; unidad_id?: string | null; cliente_id?: string | null; folio?: string | null; origen?: string | null; destino?: string | null; estatus: string; ingreso_flete?: number | null; fecha_fin?: string | null; created_at?: string }>;
  liquidacion: Array<{ tenant_id: string; viaje_id: string; total_comprobado: number; created_at: string; revision?: string | null }>;
  factura_emitida: Array<{ id: string; tenant_id: string; cliente_id: string; viaje_id?: string | null; folio?: string | null; fecha: string; total: number; estatus: string; vence_en?: string | null }>;
  pago_recibido: Array<{ factura_id: string; monto: number }>;
  factura_viaje: Array<{ factura_id: string; viaje_id: string }>;
  pod: Array<{ tenant_id: string; viaje_id: string; estado: string }>;
  /** Catálogo de tarifas: lo lee `getPanelClientes`, no ninguna RPC. */
  tarifa?: Array<Record<string, unknown>>;
  incidencia: Array<{ id: string; tenant_id: string; viaje_id?: string | null; unidad_id?: string | null; tipo: string; prioridad?: string; estado: string; descripcion?: string | null; sla_horas?: number | null; abierta_en: string; resuelta_en?: string | null }>;
}

export const baseVacia = (): BaseSintetica => ({
  tenant: [], cliente: [], operador: [], unidad: [], viaje: [], liquidacion: [],
  factura_emitida: [], pago_recibido: [], factura_viaje: [], pod: [], incidencia: [], tarifa: [],
});

/** Días entre dos AAAA-MM-DD (b - a), como `date - date` en Postgres. */
export const diasSql = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * El `(created_at at time zone …)::date` de la migración, en JS.
 *
 * Usa `hoyMx` en vez de deletrear la zona: es la MISMA regla que la guardiana
 * de formato.test.ts hace cumplir en todo `src/` —el día de México se calcula
 * en un solo sitio— y aquí importa el doble, porque este espejo existe para
 * decir si el bucketeo de la RPC coincide con el de JS.
 */
export const diaMxSql = (iso: string) => hoyMx(new Date(iso));

const cmpTexto = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** `viaje.created_at` tiene `default now()` en la base: una fila del fixture
 *  que no lo fija es una fila RECIÉN insertada, no una de 1970 — si se leyera
 *  como cadena vacía, cualquier ventana la dejaría fuera y las pruebas del
 *  filtro por periodo pasarían por la razón equivocada. */
const creado = (v: { created_at?: string }) => v.created_at ?? new Date().toISOString();

/** La vista `factura_saldo` (0049) sobre la base sintética, con `current_date = hoy`. */
export function saldoFactura(b: BaseSintetica, f: BaseSintetica['factura_emitida'][number], hoy: string) {
  const pagado = b.pago_recibido.filter((p) => p.factura_id === f.id).reduce((s, p) => s + p.monto, 0);
  const saldo = f.total - pagado;
  const vencida = f.vence_en != null && f.vence_en < hoy && saldo > 0.01 && !['cancelada', 'borrador'].includes(f.estatus);
  return { pagado, saldo, vencida };
}

// ── 1. rentabilidad_tenant ─────────────────────────────────────────────────
export function rentabilidadSql(b: BaseSintetica, tenant: string, desde: string | null) {
  const v = b.viaje.filter((x) => x.tenant_id === tenant && (!desde || creado(x) >= desde));
  // 0348 (BE-A2/DAT-M1): una liquidación rechazada no cuenta como costo comprobado.
  const l = b.liquidacion.filter((x) => x.tenant_id === tenant && (!desde || x.created_at >= desde) && x.revision !== 'rechazada');
  return {
    ingreso: v.reduce((s, x) => s + (x.ingreso_flete ?? 0), 0),
    viajesConIngreso: v.filter((x) => x.ingreso_flete != null).length,
    viajesSinIngreso: v.filter((x) => x.ingreso_flete == null).length,
    costoComprobado: l.reduce((s, x) => s + x.total_comprobado, 0),
  };
}

// ── 2. cartera_tenant ──────────────────────────────────────────────────────
export function carteraSql(b: BaseSintetica, tenant: string, hoy: string) {
  const viajes = b.viaje.filter((v) => v.tenant_id === tenant);
  const clientes = b.cliente.filter((c) => c.tenant_id === tenant).map((c) => {
    const vs = viajes.filter((v) => v.cliente_id === c.id);
    const fs = b.factura_emitida.filter((f) => f.tenant_id === tenant && f.cliente_id === c.id && !['cancelada', 'borrador'].includes(f.estatus))
      .map((f) => saldoFactura(b, f, hoy));
    return {
      id: c.id, nombre: c.nombre, rfc: c.rfc ?? null, diasCredito: c.dias_credito ?? null, activo: c.activo ?? true,
      contacto: c.contacto ?? null, correo: c.correo ?? null, telefono: c.telefono ?? null,
      viajes: vs.length,
      ingreso: vs.reduce((s, v) => s + (v.ingreso_flete ?? 0), 0),
      viajesSinIngreso: vs.filter((v) => v.ingreso_flete == null).length,
      facturas: fs.length,
      saldoPorCobrar: fs.length ? fs.reduce((s, f) => s + f.saldo, 0) : null,
      vencido: fs.length ? fs.filter((f) => f.vencida).reduce((s, f) => s + f.saldo, 0) : null,
    };
  }).sort((x, y) => y.ingreso - x.ingreso || cmpTexto(x.nombre, y.nombre) || cmpTexto(x.id, y.id));
  return {
    clientes,
    viajesSinCliente: viajes.filter((v) => v.cliente_id == null).length,
    conIngreso: viajes.filter((v) => v.ingreso_flete != null).length,
  };
}

// ── 3. cobranza_tenant ─────────────────────────────────────────────────────
export function cobranzaSql(b: BaseSintetica, tenant: string, hoy: string, desde: string | null, hasta: string | null, limite: number, desplazamiento: number) {
  const f = b.factura_emitida
    .filter((x) => x.tenant_id === tenant && (!desde || x.fecha >= desde) && (!hasta || x.fecha <= hasta))
    .map((x) => ({ ...x, ...saldoFactura(b, x, hoy) }));
  const vivas = f.filter((x) => !['cancelada', 'borrador'].includes(x.estatus));
  const orden = [...f].sort((x, y) => Number(y.vencida) - Number(x.vencida) || y.saldo - x.saldo || cmpTexto(y.fecha, x.fecha) || cmpTexto(x.id, y.id));
  const lim = Math.min(Math.max(limite, 1), 100);
  return {
    porCobrar: vivas.reduce((s, x) => s + x.saldo, 0),
    vencido: vivas.filter((x) => x.vencida).reduce((s, x) => s + x.saldo, 0),
    sinCondiciones: vivas.filter((x) => x.vence_en == null).length,
    facturas: orden.slice(Math.max(desplazamiento, 0), Math.max(desplazamiento, 0) + lim).map((x) => ({
      id: x.id, folio: x.folio ?? null,
      cliente: b.cliente.find((c) => c.id === x.cliente_id)?.nombre ?? '—',
      fecha: x.fecha, total: x.total, pagado: x.pagado, saldo: x.saldo, estatus: x.estatus,
      venceEn: x.vence_en ?? null, vencida: x.vencida,
    })),
  };
}

/** `select id, count exact head` sobre factura_emitida con el mismo filtro. */
export function cobranzaTotalSql(b: BaseSintetica, tenant: string, desde: string | null, hasta: string | null) {
  return b.factura_emitida.filter((x) => x.tenant_id === tenant && (!desde || x.fecha >= desde) && (!hasta || x.fecha <= hasta)).length;
}

// ── 4. facturacion_clientes_tenant ─────────────────────────────────────────
export function facturacionClientesSql(b: BaseSintetica, tenant: string, hoy: string, desde: string | null, hasta: string | null, limite: number) {
  type Cubeta = 'corriente' | 'v1_30' | 'v31_60' | 'v60_mas' | 'sin_fecha';
  const fc = b.factura_emitida
    .filter((x) => x.tenant_id === tenant && (!desde || x.fecha >= desde) && (!hasta || x.fecha <= hasta))
    .map((x) => {
      const s = saldoFactura(b, x, hoy);
      const dias = x.vence_en == null ? null : diasSql(x.vence_en, hoy);
      const cubeta: Cubeta = x.vence_en == null ? 'sin_fecha' : dias! <= 0 ? 'corriente' : dias! <= 30 ? 'v1_30' : dias! <= 60 ? 'v31_60' : 'v60_mas';
      return {
        id: x.id, folio: x.folio ?? null, cliente: b.cliente.find((c) => c.id === x.cliente_id)?.nombre ?? '—',
        fecha: x.fecha, total: x.total, pagado: s.pagado, saldo: s.saldo, estatus: x.estatus, venceEn: x.vence_en ?? null,
        viva: !['cancelada', 'borrador'].includes(x.estatus), conSaldo: s.saldo > 0.01, cubeta,
        diasVencida: x.vence_en != null && dias! > 0 ? dias : null,
      };
    });
  const enCubeta = fc.filter((x) => x.viva && x.conSaldo);
  const CLAVES: Cubeta[] = ['corriente', 'v1_30', 'v31_60', 'v60_mas', 'sin_fecha'];
  const sum = (xs: Array<{ saldo: number }>) => xs.reduce((s, x) => s + x.saldo, 0);
  const porCliente = new Map<string, typeof fc>();
  for (const x of fc.filter((y) => y.viva)) porCliente.set(x.cliente, [...(porCliente.get(x.cliente) ?? []), x]);
  const clientes = [...porCliente.entries()].map(([cliente, xs]) => {
    const cs = xs.filter((x) => x.conSaldo);
    const porCubeta = Object.fromEntries(CLAVES.map((k) => [k, sum(cs.filter((x) => x.cubeta === k))]));
    const vencidas = cs.filter((x) => x.diasVencida !== null);
    return {
      cliente,
      facturado: xs.reduce((s, x) => s + x.total, 0),
      cobrado: xs.reduce((s, x) => s + x.pagado, 0),
      saldo: sum(cs), vencido: sum(vencidas), facturas: xs.length,
      porCubeta,
      diasMasVencido: vencidas.length ? Math.max(...vencidas.map((x) => x.diasVencida!)) : null,
    };
  }).sort((x, y) => y.vencido - x.vencido || y.saldo - x.saldo || cmpTexto(x.cliente, y.cliente));
  const ordenF = (x: typeof fc[number], y: typeof fc[number]) =>
    Number(y.viva) - Number(x.viva) || (y.diasVencida ?? -Infinity) - (x.diasVencida ?? -Infinity) || y.saldo - x.saldo || cmpTexto(y.fecha, x.fecha) || cmpTexto(x.id, y.id);
  const pagina = [...fc].sort(ordenF).slice(0, Math.min(Math.max(limite, 1), 100));

  // La mesa.
  const liq = b.viaje.filter((v) => v.tenant_id === tenant && v.estatus === 'liquidado').map((v) => {
    const cierres = b.liquidacion.filter((l) => l.viaje_id === v.id && l.tenant_id === tenant).map((l) => diaMxSql(l.created_at)).sort();
    return { ...v, liquidado_en: cierres[0] ?? v.fecha_fin ?? null };
  });
  const amparo = new Map<string, { viva: boolean; borrador: boolean }>();
  const marcar = (viajeId: string, estatus: string) => {
    const a = amparo.get(viajeId) ?? { viva: false, borrador: false };
    if (!['borrador', 'cancelada'].includes(estatus)) a.viva = true;
    if (estatus === 'borrador') a.borrador = true;
    amparo.set(viajeId, a);
  };
  for (const f of b.factura_emitida.filter((x) => x.tenant_id === tenant)) {
    if (f.viaje_id) marcar(f.viaje_id, f.estatus);
    for (const fv of b.factura_viaje.filter((x) => x.factura_id === f.id)) marcar(fv.viaje_id, f.estatus);
  }
  const mesa = liq.filter((v) => !(amparo.get(v.id)?.viva ?? false)).map((v) => ({
    id: v.id, folio: v.folio ?? null, origen: v.origen ?? null, destino: v.destino ?? null,
    cliente: v.cliente_id ? b.cliente.find((c) => c.id === v.cliente_id)?.nombre ?? null : null,
    ingresoFlete: v.ingreso_flete ?? null, liquidadoEn: v.liquidado_en,
    soloBorrador: amparo.get(v.id)?.borrador ?? false,
    dias: v.liquidado_en == null ? null : diasSql(v.liquidado_en, hoy),
  }));
  const ordenM = (x: typeof mesa[number], y: typeof mesa[number]) =>
    (y.dias ?? -Infinity) - (x.dias ?? -Infinity) || (y.ingresoFlete ?? 0) - (x.ingresoFlete ?? 0)
    || cmpTexto(x.folio ?? x.id.slice(0, 8), y.folio ?? y.id.slice(0, 8)) || cmpTexto(x.id, y.id);
  const conDias = mesa.filter((m) => m.dias !== null);
  return {
    cartera: {
      facturasTotal: fc.length,
      vivas: fc.filter((x) => x.viva).length,
      borradores: fc.filter((x) => x.estatus === 'borrador').length,
      canceladas: fc.filter((x) => x.estatus === 'cancelada').length,
      facturado: fc.filter((x) => x.viva).reduce((s, x) => s + x.total, 0),
      cobrado: fc.filter((x) => x.viva).reduce((s, x) => s + x.pagado, 0),
      porCobrar: sum(enCubeta),
      vencido: sum(enCubeta.filter((x) => x.diasVencida !== null)),
      sinCondiciones: enCubeta.filter((x) => x.cubeta === 'sin_fecha').length,
      cubetas: CLAVES.map((k) => ({ clave: k, saldo: sum(enCubeta.filter((x) => x.cubeta === k)), facturas: enCubeta.filter((x) => x.cubeta === k).length })),
      clientes,
      facturas: pagina.map(({ id, folio, cliente, fecha, total, pagado, saldo, estatus, venceEn }) => ({ id, folio, cliente, fecha, total, pagado, saldo, estatus, venceEn })),
    },
    enLaMesa: {
      total: mesa.length,
      ingresoCapturado: mesa.reduce((s, m) => s + (m.ingresoFlete ?? 0), 0),
      sinIngreso: mesa.filter((m) => m.ingresoFlete == null).length,
      conBorrador: mesa.filter((m) => m.soloBorrador).length,
      diasMasViejo: conDias.length ? Math.max(...conDias.map((m) => m.dias!)) : null,
      viajes: [...mesa].sort(ordenM).slice(0, 25).map(({ id, folio, origen, destino, cliente, ingresoFlete, liquidadoEn, soloBorrador }) =>
        ({ id, folio, origen, destino, cliente, ingresoFlete, liquidadoEn, soloBorrador })),
    },
    viajesLiquidados: liq.length,
  };
}

// ── 5. tablero_operacion_tenant ────────────────────────────────────────────
export function tableroSql(b: BaseSintetica, tenant: string) {
  const enCurso = b.viaje.filter((v) => v.tenant_id === tenant && ['abierto', 'en_cuadre'].includes(v.estatus));
  const conPod = (id: string) => b.pod.some((p) => p.tenant_id === tenant && p.viaje_id === id && p.estado === 'subido');
  const u = b.unidad.filter((x) => x.tenant_id === tenant && (x.activo ?? true));
  return {
    viajesActivos: enCurso.length,
    sinUnidad: enCurso.filter((v) => v.unidad_id == null).length,
    unidadesDisponibles: u.filter((x) => x.estado === 'disponible').length,
    unidadesEnTaller: u.filter((x) => x.estado === 'taller').length,
    incidenciasAbiertas: b.incidencia.filter((i) => i.tenant_id === tenant && i.estado !== 'resuelta').length,
    podPendientes: enCurso.filter((v) => !conPod(v.id)).length,
  };
}

// ── 6. carga_operadores_tenant ─────────────────────────────────────────────
export function cargaOperadoresSql(b: BaseSintetica, tenant: string, desde: string | null) {
  const conPod = (id: string) => b.pod.some((p) => p.tenant_id === tenant && p.viaje_id === id && p.estado === 'subido');
  const conInc = (id: string) => b.incidencia.some((i) => i.tenant_id === tenant && i.viaje_id === id && i.estado !== 'resuelta');
  // El MISMO `where` de la RPC (FE-3): vivos siempre, liquidados desde `desde`.
  return b.operador.filter((o) => o.tenant_id === tenant).map((o) => {
    const vs = b.viaje.filter((v) => v.tenant_id === tenant && v.operador_id === o.id
      && (['abierto', 'en_cuadre'].includes(v.estatus)
        || (v.estatus === 'liquidado' && (!desde || creado(v) >= desde))));
    const curso = vs.filter((v) => ['abierto', 'en_cuadre'].includes(v.estatus));
    return {
      operadorId: o.id, nombre: o.nombre, telefono: o.telefono || null, activo: o.activo ?? true,
      enCurso: curso.length,
      abiertos: vs.filter((v) => v.estatus === 'abierto').length,
      enCuadre: vs.filter((v) => v.estatus === 'en_cuadre').length,
      liquidados: vs.filter((v) => v.estatus === 'liquidado').length,
      sinPod: curso.filter((v) => !conPod(v.id)).length,
      incidenciasAbiertas: vs.filter((v) => conInc(v.id)).length,
    };
  }).sort((x, y) => y.enCurso - x.enCurso || cmpTexto(x.nombre, y.nombre) || cmpTexto(x.operadorId, y.operadorId));
}

// ── 7. incidencias_tenant ──────────────────────────────────────────────────
export function incidenciasSql(b: BaseSintetica, tenant: string, desde: string | null, limite: number) {
  return b.incidencia
    .filter((i) => i.tenant_id === tenant && (i.estado !== 'resuelta' || !desde || i.abierta_en >= desde))
    .sort((x, y) => cmpTexto(y.abierta_en, x.abierta_en) || cmpTexto(x.id, y.id))
    .slice(0, Math.min(Math.max(limite, 1), 500))
    .map((i) => {
      const v = i.viaje_id ? b.viaje.find((x) => x.id === i.viaje_id && x.tenant_id === tenant) : undefined;
      const u = i.unidad_id ? b.unidad.find((x) => x.id === i.unidad_id && x.tenant_id === tenant) : undefined;
      return {
        id: i.id, viajeId: i.viaje_id ?? null, folio: v?.folio || null, unidadId: i.unidad_id ?? null,
        numeroEconomico: u?.numero_economico ?? null, tipo: i.tipo, prioridad: i.prioridad ?? 'media', estado: i.estado,
        descripcion: i.descripcion || null, slaHoras: i.sla_horas ?? null, abiertaEn: i.abierta_en, resueltaEn: i.resuelta_en ?? null,
      };
    });
}

// ── El doble de `supabaseAdmin()` que despacha las 7 RPC sobre la base ─────

export interface Doble {
  base: BaseSintetica;
  hoy: string;
  /** Si se fija, TODA rpc devuelve este error. */
  error: { message: string } | null;
  /** Si no es `undefined`, TODA rpc devuelve esta data (para probar el fail-closed de forma). */
  formaRota: unknown;
  llamadas: Array<{ fn: string; args: Record<string, unknown> }>;
}

export function crearDoble(hoy: string): Doble {
  return { base: baseVacia(), hoy, error: null, formaRota: undefined, llamadas: [] };
}

export function despacharRpc(d: Doble, fn: string, args: Record<string, unknown>): { data: unknown; error: { message: string } | null } {
  d.llamadas.push({ fn, args });
  if (d.error) return { data: null, error: d.error };
  if (d.formaRota !== undefined) return { data: d.formaRota, error: null };
  const t = args.p_tenant as string;
  const b = d.base;
  switch (fn) {
    case 'rentabilidad_tenant': return { data: rentabilidadSql(b, t, (args.p_desde as string | null) ?? null), error: null };
    case 'cartera_tenant': return { data: carteraSql(b, t, d.hoy), error: null };
    case 'cobranza_tenant': return { data: cobranzaSql(b, t, d.hoy, (args.p_desde as string | null) ?? null, (args.p_hasta as string | null) ?? null, args.p_limite as number, args.p_desplazamiento as number), error: null };
    case 'facturacion_clientes_tenant': return { data: facturacionClientesSql(b, t, args.p_hoy as string, (args.p_desde as string | null) ?? null, (args.p_hasta as string | null) ?? null, args.p_limite_facturas as number), error: null };
    case 'tablero_operacion_tenant': return { data: tableroSql(b, t), error: null };
    case 'carga_operadores_tenant': return { data: cargaOperadoresSql(b, t, (args.p_desde as string | null) ?? null), error: null };
    case 'incidencias_tenant': return { data: incidenciasSql(b, t, (args.p_desde as string | null) ?? null, args.p_limite as number), error: null };
    default: return { data: null, error: { message: `rpc desconocida: ${fn}` } };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EL DATASET DE LAS PRUEBAS DE EQUIVALENCIA — dos flotas, y en la flota que se
// mide todos los casos que un `?? 0` convertiría en un número plausible:
// ingreso null, factura sin `vence_en`, cancelada, borrador (que además ampara
// un viaje por `factura_viaje`), pago parcial, POD rechazado, unidad de baja,
// incidencia resuelta vieja, viaje sin cliente y viaje sin operador.
// ═══════════════════════════════════════════════════════════════════════════

export const HOY_PRUEBAS = '2026-08-14';
/** Un ISO a N días de `HOY_PRUEBAS` (a mediodía UTC: el día MX no cambia). */
export const haceDias = (dias: number) =>
  new Date(Date.parse(`${HOY_PRUEBAS}T12:00:00Z`) - dias * 86_400_000).toISOString();
export const fechaHace = (dias: number) => haceDias(dias).slice(0, 10);

export function baseDeDosFlotas(): BaseSintetica {
  const b = baseVacia();
  b.tenant = ['t-1', 't-2'];
  b.cliente = [
    { id: 'c-a', tenant_id: 't-1', nombre: 'Cementos del Norte', rfc: 'CEM010101AAA', dias_credito: 30, activo: true, contacto: 'Lic. Paz', correo: 'paz@cem.mx', telefono: '5215551111111' },
    { id: 'c-b', tenant_id: 't-1', nombre: 'Aceros del Bajío', rfc: null, dias_credito: null, activo: false, contacto: null, correo: null, telefono: null },
    { id: 'c-x', tenant_id: 't-2', nombre: 'FLOTA AJENA', rfc: null, dias_credito: 15, activo: true },
  ];
  b.operador = [
    { id: 'o-1', tenant_id: 't-1', nombre: 'Ana Ruiz', telefono: '5215552222222', activo: true },
    { id: 'o-2', tenant_id: 't-1', nombre: 'Beto Lara', telefono: null, activo: false },
    { id: 'o-x', tenant_id: 't-2', nombre: 'Ajeno', telefono: null, activo: true },
  ];
  b.unidad = [
    { id: 'u-1', tenant_id: 't-1', numero_economico: 'T-01', estado: 'disponible' },
    { id: 'u-2', tenant_id: 't-1', numero_economico: 'T-02', estado: 'taller' },
    { id: 'u-3', tenant_id: 't-1', numero_economico: 'T-03', estado: 'disponible', activo: false },
    { id: 'u-x', tenant_id: 't-2', numero_economico: 'B-01', estado: 'disponible' },
  ];
  b.viaje = [
    { id: 'v-1', tenant_id: 't-1', operador_id: 'o-1', unidad_id: 'u-1', cliente_id: 'c-a', folio: 'VJ-001', origen: 'Monterrey', destino: 'Querétaro', estatus: 'liquidado', ingreso_flete: 10000, fecha_fin: fechaHace(38), created_at: haceDias(40) },
    { id: 'v-2', tenant_id: 't-1', operador_id: 'o-1', cliente_id: 'c-a', folio: 'VJ-002', origen: 'Saltillo', destino: null, estatus: 'liquidado', ingreso_flete: null, fecha_fin: fechaHace(9), created_at: haceDias(10) },
    { id: 'v-3', tenant_id: 't-1', operador_id: 'o-1', unidad_id: 'u-1', cliente_id: 'c-b', folio: 'VJ-003', origen: 'León', destino: 'CDMX', estatus: 'abierto', ingreso_flete: 5000, created_at: haceDias(1) },
    { id: 'v-4', tenant_id: 't-1', operador_id: 'o-2', cliente_id: null, folio: null, estatus: 'en_cuadre', ingreso_flete: null, created_at: haceDias(2) },
    { id: 'v-5', tenant_id: 't-1', operador_id: null, cliente_id: 'c-b', folio: 'VJ-005', estatus: 'abierto', ingreso_flete: 0, created_at: haceDias(3) },
    { id: 'v-6', tenant_id: 't-1', operador_id: 'o-1', cliente_id: 'c-b', folio: 'VJ-006', estatus: 'liquidado', ingreso_flete: 2500, fecha_fin: null, created_at: haceDias(200) },
    { id: 'v-x', tenant_id: 't-2', operador_id: 'o-x', unidad_id: 'u-x', cliente_id: 'c-x', folio: 'AJENO', estatus: 'abierto', ingreso_flete: 99999, created_at: haceDias(5) },
  ];
  b.liquidacion = [
    // Cierre NOCTURNO: 02:30 UTC del día siguiente es todavía el día anterior
    // en México. Es el bug que `diaMx` existe para no repetir.
    { tenant_id: 't-1', viaje_id: 'v-1', total_comprobado: 1500, created_at: `${fechaHace(37)}T02:30:00Z` },
    { tenant_id: 't-1', viaje_id: 'v-2', total_comprobado: 700, created_at: `${fechaHace(8)}T02:30:00Z` },
    { tenant_id: 't-2', viaje_id: 'v-x', total_comprobado: 88888, created_at: haceDias(5) },
  ];
  b.factura_emitida = [
    { id: 'f-1', tenant_id: 't-1', cliente_id: 'c-a', viaje_id: 'v-1', folio: 'A-001', fecha: fechaHace(75), total: 11600, estatus: 'emitida', vence_en: fechaHace(45) },
    { id: 'f-2', tenant_id: 't-1', cliente_id: 'c-b', folio: 'A-002', fecha: fechaHace(3), total: 2320, estatus: 'emitida', vence_en: null },
    { id: 'f-3', tenant_id: 't-1', cliente_id: 'c-a', folio: 'A-003', fecha: fechaHace(2), total: 1000, estatus: 'borrador', vence_en: fechaHace(-28) },
    { id: 'f-4', tenant_id: 't-1', cliente_id: 'c-a', viaje_id: 'v-2', folio: 'A-004', fecha: fechaHace(1), total: 500, estatus: 'cancelada', vence_en: fechaHace(-29) },
    { id: 'f-5', tenant_id: 't-1', cliente_id: 'c-b', viaje_id: 'v-6', folio: 'A-005', fecha: fechaHace(20), total: 2900, estatus: 'pagada', vence_en: fechaHace(5) },
    { id: 'f-x', tenant_id: 't-2', cliente_id: 'c-x', viaje_id: 'v-x', folio: 'B-001', fecha: fechaHace(90), total: 70000, estatus: 'emitida', vence_en: fechaHace(60) },
  ];
  b.pago_recibido = [
    { factura_id: 'f-1', monto: 5000 },
    { factura_id: 'f-5', monto: 2900 },   // saldada al centavo: no tiene antigüedad
  ];
  b.factura_viaje = [{ factura_id: 'f-3', viaje_id: 'v-2' }];   // borrador que NO factura
  b.pod = [
    { tenant_id: 't-1', viaje_id: 'v-3', estado: 'subido' },
    { tenant_id: 't-1', viaje_id: 'v-5', estado: 'rechazado' },  // existe y no sirve
    { tenant_id: 't-2', viaje_id: 'v-x', estado: 'subido' },
  ];
  b.incidencia = [
    { id: 'i-1', tenant_id: 't-1', viaje_id: 'v-4', unidad_id: 'u-1', tipo: 'retraso', prioridad: 'alta', estado: 'abierta', sla_horas: 4, abierta_en: haceDias(0.5) },
    { id: 'i-2', tenant_id: 't-1', viaje_id: 'v-1', unidad_id: null, tipo: 'averia', prioridad: 'media', estado: 'resuelta', sla_horas: 8, abierta_en: haceDias(200), resuelta_en: haceDias(199) },
    { id: 'i-3', tenant_id: 't-1', viaje_id: null, unidad_id: 'u-2', tipo: 'dano', prioridad: 'baja', estado: 'en_proceso', sla_horas: null, abierta_en: haceDias(2) },
    { id: 'i-x', tenant_id: 't-2', viaje_id: 'v-x', unidad_id: 'u-x', tipo: 'averia', prioridad: 'alta', estado: 'abierta', sla_horas: 1, abierta_en: haceDias(1) },
  ];
  return b;
}
