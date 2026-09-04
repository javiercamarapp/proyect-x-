// ═══════════════════════════════════════════════════════════════════════════
// EL LADO DEL INGRESO — lo que alimenta Clientes, Rentabilidad, Cobranza y
// Cotizador ahora que las tablas de la 0048/0049/0051 existen.
//
// LA REGLA DE ESTE ARCHIVO, que es la del producto: una cifra o es un conteo
// real de la base, o NO SE MUESTRA. Nada de derivar un ingreso del anticipo,
// ni un margen de un costo estimado, ni una concentración sobre una cartera a
// medio capturar. Cuando falta la mitad del dato, se devuelve el conteo de lo
// que falta para que la pantalla lo diga.
//
// ── AGREGADOS EN SQL DESDE EL 22-AGO-2026 (mig. 0152) ──────────────────────
// `getRentabilidad`, `getCartera` y `getCobranza` traían `viaje`,
// `liquidacion`, `factura_emitida`+`factura_saldo` y `cliente` ENTERAS con
// `traerTodo` para reducirlas en JS. `traerTodo` es correcto —lanza en vez de
// truncar— pero lanza a las 100,000 filas: con 50k viajes/mes esas tres
// pantallas caducaban ~mes 2 (docs/escala-50k/MAPA.md #12, #14, #16). Ahora
// cada reducción es UNA RPC (`rentabilidad_tenant`, `cartera_tenant`,
// `cobranza_tenant`) con el mismo criterio que antes —un `ingreso_flete`
// NULL no es cero, una cancelada no es dinero que alguien deba— y el lado JS
// valida la FORMA del jsonb y LANZA si no encaja: un `0` inventado sobre una
// respuesta rota se ve idéntico a una flota sin actividad. Las pruebas de
// equivalencia (comercial_equivalencia.test.ts) comparan la reducción JS
// vieja contra la forma nueva sobre el mismo dataset sintético.
//
// Lo que sigue en JS (`getCotizaciones`, `getTickets`, `getEstadoRastreo`)
// son catálogos chicos por naturaleza y van con `traerTodo` + `acotada()`:
// PostgREST recorta a 1,000 filas EN SILENCIO y una lista recortada se ve
// razonable y está mal; y una consulta sin techo de tiempo cuelga la página.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase/admin';
import { traerTodo } from './pg';
import { acotada } from './presupuesto';
// `round2` se IMPORTA, no se reimplementa: hay una prueba en `formato.test.ts`
// que falla si aparece otra copia. Dos redondeos distintos hacen que la misma
// cifra fiscal se lea diferente en dos pantallas, y eso se lee como dos
// cálculos distintos.
import { round2 } from '@/lib/formato';
import { DatoInvalido } from './errores';

// ── Forma del jsonb: fail-closed ───────────────────────────────────────────

/** Un número de verdad (PostgREST entrega `numeric` como número en jsonb). */
export function esNumero(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** `null` o número: para los campos que la RPC deja en NULL a propósito. */
export function esNumeroONulo(v: unknown): v is number | null {
  return v === null || esNumero(v);
}

/** `null` o string. */
export function esTextoONulo(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

export function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * El mensaje con el que TODAS las lecturas de la 0152 lanzan ante una forma
 * inesperada. Nombra la RPC y la migración: es lo primero que hay que revisar
 * (¿se aplicó la 0152 en ese entorno?).
 */
export function formaInesperada(funcion: string, rpc: string, detalle: string): Error {
  return new Error(`${funcion}: ${rpc} devolvió otra forma (¿migración 0152 sin aplicar?): ${detalle}`);
}

// ── Clientes ───────────────────────────────────────────────────────────────

export interface ClienteRow {
  id: string;
  nombre: string;
  rfc: string | null;
  diasCredito: number | null;
  activo: boolean;
  viajes: number;
  /** Suma de `viaje.ingreso_flete`. Solo de los viajes que lo tienen capturado. */
  ingreso: number;
  /** Viajes de ese cliente SIN ingreso capturado — el tamaño del hueco. */
  viajesSinIngreso: number;
}

export interface Cartera {
  clientes: ClienteRow[];
  ingresoTotal: number;
  /** % del ingreso que depende del cliente más grande. `null` si no hay ingreso capturado. */
  concentracion: number | null;
  /** Viajes sin cliente asignado en toda la flota. */
  viajesSinCliente: number;
}

/**
 * Lo que `cartera_tenant` (0152) devuelve por cliente, ya validado. Es un
 * superconjunto de `ClienteRow`: `getCartera` se queda con la mitad comercial
 * y `getPanelClientes` (clientes.ts) usa también el contacto y el saldo —
 * de UNA sola lectura, para que la concentración y el saldo por cliente no
 * puedan salir de dos consultas distintas.
 */
export interface ClienteCarteraRpc extends ClienteRow {
  contacto: string | null;
  correo: string | null;
  telefono: string | null;
  /** Facturas vivas (ni canceladas ni borradores) del cliente. */
  facturas: number;
  /** `null` cuando no tiene ninguna factura viva: saldo desconocido, no cero. */
  saldoPorCobrar: number | null;
  vencido: number | null;
}

export interface CarteraRpc {
  clientes: ClienteCarteraRpc[];
  viajesSinCliente: number;
  /** Viajes de la flota CON `ingreso_flete` capturado. */
  conIngreso: number;
}

/**
 * UNA llamada a `cartera_tenant` y la validación de su forma, campo por campo.
 * Cualquier cosa que no encaje LANZA: una cartera a medias se ve igual que una
 * cartera entera, solo que más chica.
 */
export async function leerCarteraRpc(tenantId: string): Promise<CarteraRpc> {
  const { data, error } = await acotada(
    supabaseAdmin().rpc('cartera_tenant', { p_tenant: tenantId }),
    'cartera_tenant',
  );
  if (error) throw new Error(`getCartera: ${error.message}`);
  if (!esObjeto(data) || !Array.isArray(data.clientes) || !esNumero(data.viajesSinCliente) || !esNumero(data.conIngreso)) {
    throw formaInesperada('getCartera', 'cartera_tenant', `llegó ${typeof data}`);
  }
  const clientes = (data.clientes as unknown[]).map((c, i): ClienteCarteraRpc => {
    if (!esObjeto(c) || typeof c.id !== 'string' || typeof c.nombre !== 'string'
      || !esTextoONulo(c.rfc) || !esNumeroONulo(c.diasCredito) || typeof c.activo !== 'boolean'
      || !esTextoONulo(c.contacto) || !esTextoONulo(c.correo) || !esTextoONulo(c.telefono)
      || !esNumero(c.viajes) || !esNumero(c.ingreso) || !esNumero(c.viajesSinIngreso)
      || !esNumero(c.facturas) || !esNumeroONulo(c.saldoPorCobrar) || !esNumeroONulo(c.vencido)) {
      throw formaInesperada('getCartera', 'cartera_tenant', `cliente #${i} con campos fuera de forma`);
    }
    return {
      id: c.id,
      nombre: c.nombre,
      rfc: c.rfc,
      diasCredito: c.diasCredito,
      activo: c.activo,
      contacto: c.contacto,
      correo: c.correo,
      telefono: c.telefono,
      viajes: c.viajes,
      ingreso: round2(c.ingreso),
      viajesSinIngreso: c.viajesSinIngreso,
      facturas: c.facturas,
      saldoPorCobrar: c.saldoPorCobrar === null ? null : round2(c.saldoPorCobrar),
      vencido: c.vencido === null ? null : round2(c.vencido),
    };
  });
  return { clientes, viajesSinCliente: data.viajesSinCliente, conIngreso: data.conIngreso };
}

/** La cartera comercial a partir de la lectura ya validada. Pura: es la que
 *  prueba la equivalencia contra la reducción JS vieja. */
export function armarCartera(lectura: CarteraRpc): Cartera {
  // La RPC ya ordena por ingreso desc, nombre, id; se repite aquí para que el
  // contrato no dependa del orden de un jsonb.
  const filas: ClienteRow[] = lectura.clientes.map((c) => ({
    id: c.id,
    nombre: c.nombre,
    rfc: c.rfc,
    diasCredito: c.diasCredito,
    activo: c.activo,
    viajes: c.viajes,
    ingreso: c.ingreso,
    viajesSinIngreso: c.viajesSinIngreso,
  })).sort((x, y) => y.ingreso - x.ingreso || x.nombre.localeCompare(y.nombre, 'es') || x.id.localeCompare(y.id));

  const ingresoTotal = round2(filas.reduce((s, f) => s + f.ingreso, 0));
  // Sin ingreso capturado no hay concentración que calcular. Devolver 0 se
  // leería como "no dependes de nadie", que es la conclusión contraria.
  const concentracion = ingresoTotal > 0 && filas.length
    ? round2((filas[0].ingreso / ingresoTotal) * 100)
    : null;

  return { clientes: filas, ingresoTotal, concentracion, viajesSinCliente: lectura.viajesSinCliente };
}

export async function getCartera(tenantId: string): Promise<Cartera> {
  return armarCartera(await leerCarteraRpc(tenantId));
}

// ── Rentabilidad ───────────────────────────────────────────────────────────

export interface Rentabilidad {
  ingreso: number;
  /** Lo comprobado por los operadores, de `liquidacion.total_comprobado`. */
  costoComprobado: number;
  /**
   * Ingreso menos lo COMPROBADO EN EL VIAJE. Se llamaba `utilidad` y el nombre
   * estaba mal: un dueño de flota lee "utilidad" y entiende ganancia, y este
   * número NO resta sueldo del operador, mantenimiento, llantas, seguro,
   * depreciación, financiamiento ni gastos de administración. Un viaje puede
   * salir con contribución sana y haber perdido dinero.
   *
   * "Contribución" es el término contable exacto —ingreso menos costos
   * variables directos— y además avisa por sí solo que no es la utilidad. El
   * día que exista un motor de costo completo, ESE se podrá llamar utilidad.
   */
  contribucion: number;
  /** `null` cuando no hay ingreso capturado: un margen sobre 0 es división por cero. */
  margenPct: number | null;
  viajesConIngreso: number;
  viajesSinIngreso: number;
}

/** La forma cruda que devuelve `rentabilidad_tenant`, ya validada. */
export interface RentabilidadRpc {
  ingreso: number;
  viajesConIngreso: number;
  viajesSinIngreso: number;
  costoComprobado: number;
}

/** Pura: del agregado a la pantalla. El oráculo de la equivalencia. */
export function armarRentabilidad(r: RentabilidadRpc): Rentabilidad {
  const ingreso = r.ingreso;
  const costoComprobado = r.costoComprobado;
  return {
    ingreso: round2(ingreso),
    costoComprobado: round2(costoComprobado),
    contribucion: round2(ingreso - costoComprobado),
    margenPct: ingreso > 0 ? round2(((ingreso - costoComprobado) / ingreso) * 100) : null,
    viajesConIngreso: r.viajesConIngreso,
    viajesSinIngreso: r.viajesSinIngreso,
  };
}

/**
 * NO calcula el margen con el anticipo haciendo de ingreso. Es la tentación
 * obvia —`viaje.anticipo` siempre está lleno— y produce números que se ven
 * bien y están mal: el anticipo es lo que la empresa le ADELANTA al operador,
 * no lo que le paga el cliente.
 *
 * `desde` (ISO) acota viajes y liquidaciones por `created_at`; `null` = todo
 * el histórico, que es lo que la pantalla enseña hoy (su rótulo no dice
 * "del periodo").
 */
export async function getRentabilidad(tenantId: string, desde: string | null = null): Promise<Rentabilidad> {
  const { data, error } = await acotada(
    supabaseAdmin().rpc('rentabilidad_tenant', { p_tenant: tenantId, p_desde: desde }),
    'rentabilidad_tenant',
  );
  if (error) throw new Error(`getRentabilidad: ${error.message}`);
  if (!esObjeto(data) || !esNumero(data.ingreso) || !esNumero(data.viajesConIngreso)
    || !esNumero(data.viajesSinIngreso) || !esNumero(data.costoComprobado)) {
    throw formaInesperada('getRentabilidad', 'rentabilidad_tenant', `llegó ${typeof data}`);
  }
  return armarRentabilidad({
    ingreso: data.ingreso,
    viajesConIngreso: data.viajesConIngreso,
    viajesSinIngreso: data.viajesSinIngreso,
    costoComprobado: data.costoComprobado,
  });
}

// ── Cobranza ───────────────────────────────────────────────────────────────

export interface FacturaRow {
  id: string;
  folio: string | null;
  cliente: string;
  fecha: string;
  total: number;
  pagado: number;
  saldo: number;
  estatus: string;
  venceEn: string | null;
  vencida: boolean;
}

/** Tope de la página: es lo que cabe en una tabla sin que nadie la lea. */
export const COBRANZA_POR_PAGINA = 100;

export interface OpcionesCobranza {
  /** Acota por `factura_emitida.fecha` (AAAA-MM-DD). `null` = sin cota. */
  desde?: string | null;
  hasta?: string | null;
  /** Desde 1. */
  pagina?: number;
  /** ≤ `COBRANZA_POR_PAGINA`. */
  porPagina?: number;
}

export interface Cobranza {
  /**
   * UNA PÁGINA, no todas (0152): `total` dice cuántas hay en el periodo y
   * `pagina`/`porPagina` de cuál se trata. Orden estable: vencidas primero,
   * luego saldo mayor, fecha más reciente, id. Los tres agregados de abajo
   * son sobre TODO el periodo, no sobre la página.
   */
  facturas: FacturaRow[];
  total: number;
  pagina: number;
  porPagina: number;
  porCobrar: number;
  vencido: number;
  /** Facturas sin fecha de vencimiento porque su cliente no tiene crédito pactado. */
  sinCondiciones: number;
}

/**
 * CAMBIO DE CONTRATO (22-ago-2026, mig. 0152): antes devolvía TODAS las
 * facturas del tenant; ahora devuelve una página (≤100) y el `total`. La vista
 * de Rentabilidad pagina con `?pagina=`. Los agregados se calculan en SQL
 * sobre todas las facturas vivas del periodo (`cobranza_tenant`), y el total
 * sale de un `count` exacto con `head: true` (ni una fila viaja).
 *
 * El saldo se deriva de los pagos, NUNCA de una columna guardada: la vista
 * `factura_saldo` (0049) es la única definición, y la RPC la lee.
 */
export async function getCobranza(tenantId: string, opciones: OpcionesCobranza = {}): Promise<Cobranza> {
  const porPagina = Math.min(Math.max(Math.trunc(opciones.porPagina ?? COBRANZA_POR_PAGINA), 1), COBRANZA_POR_PAGINA);
  const pagina = Math.max(Math.trunc(opciones.pagina ?? 1), 1);
  const desde = opciones.desde ?? null;
  const hasta = opciones.hasta ?? null;
  const admin = supabaseAdmin();

  const [agregados, total] = await Promise.all([
    acotada(admin.rpc('cobranza_tenant', {
      p_tenant: tenantId,
      p_desde: desde,
      p_hasta: hasta,
      p_limite: porPagina,
      p_desplazamiento: (pagina - 1) * porPagina,
    }), 'cobranza_tenant'),
    // El MISMO filtro de fecha que la RPC; sin cota se pide el rango entero
    // de `date` en vez de omitir el filtro, para que la consulta sea una sola
    // y la guardiana de `acotada` la pueda leer.
    acotada(
      admin.from('factura_emitida').select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .gte('fecha', desde ?? '0001-01-01')
        .lte('fecha', hasta ?? '9999-12-31'),
      'getCobranza.total',
    ),
  ]);
  if (agregados.error) throw new Error(`getCobranza: ${agregados.error.message}`);
  if (total.error) throw new Error(`getCobranza.total: ${total.error.message}`);
  // Un conteo que no llegó NO es un conteo de cero.
  if (total.count == null) throw new Error('getCobranza.total: PostgREST no devolvió el conteo');

  const data = agregados.data;
  if (!esObjeto(data) || !esNumero(data.porCobrar) || !esNumero(data.vencido)
    || !esNumero(data.sinCondiciones) || !Array.isArray(data.facturas)) {
    throw formaInesperada('getCobranza', 'cobranza_tenant', `llegó ${typeof data}`);
  }
  const facturas = (data.facturas as unknown[]).map((f, i): FacturaRow => {
    if (!esObjeto(f) || typeof f.id !== 'string' || !esTextoONulo(f.folio) || typeof f.cliente !== 'string'
      || typeof f.fecha !== 'string' || !esNumero(f.total) || !esNumero(f.pagado) || !esNumero(f.saldo)
      || typeof f.estatus !== 'string' || !esTextoONulo(f.venceEn) || typeof f.vencida !== 'boolean') {
      throw formaInesperada('getCobranza', 'cobranza_tenant', `factura #${i} con campos fuera de forma`);
    }
    return {
      id: f.id,
      folio: f.folio,
      cliente: f.cliente,
      fecha: f.fecha,
      total: round2(f.total),
      pagado: round2(f.pagado),
      saldo: round2(f.saldo),
      estatus: f.estatus,
      venceEn: f.venceEn,
      vencida: f.vencida,
    };
  });

  return {
    facturas,
    total: total.count,
    pagina,
    porPagina,
    porCobrar: round2(data.porCobrar),
    vencido: round2(data.vencido),
    sinCondiciones: data.sinCondiciones,
  };
}

// ── Cotizaciones ───────────────────────────────────────────────────────────

export interface CotizacionRow {
  id: string;
  folio: string | null;
  cliente: string | null;
  origen: string;
  destino: string;
  km: number | null;
  costoEstimado: number | null;
  precio: number | null;
  estado: string;
  vigenteHasta: string | null;
}

export async function getCotizaciones(tenantId: string): Promise<CotizacionRow[]> {
  const admin = supabaseAdmin();
  const [cots, clientes] = await Promise.all([
    traerTodo<Record<string, unknown>>(
      (d, h) => acotada(admin.from('cotizacion')
        .select('id, folio, cliente_id, origen, destino, km, costo_estimado, precio, estado, vigente_hasta')
        .eq('tenant_id', tenantId).order('id').range(d, h), 'getCotizaciones'),
      'getCotizaciones',
    ),
    traerTodo<{ id: unknown; nombre: unknown }>(
      (d, h) => acotada(admin.from('cliente').select('id, nombre')
        .eq('tenant_id', tenantId).order('id').range(d, h), 'getCotizaciones.cliente'),
      'getCotizaciones.cliente',
    ),
  ]);

  const nombre = new Map(clientes.map((c) => [c.id as string, c.nombre as string]));
  return cots.map((c) => ({
    id: c.id as string,
    folio: (c.folio as string) ?? null,
    cliente: c.cliente_id ? nombre.get(c.cliente_id as string) ?? null : null,
    origen: String(c.origen),
    destino: String(c.destino),
    km: c.km == null ? null : Number(c.km),
    costoEstimado: c.costo_estimado == null ? null : round2(Number(c.costo_estimado)),
    precio: c.precio == null ? null : round2(Number(c.precio)),
    estado: String(c.estado),
    vigenteHasta: (c.vigente_hasta as string) ?? null,
  }));
}

// ── Soporte ────────────────────────────────────────────────────────────────

export interface TicketRow {
  id: string;
  asunto: string;
  categoria: string;
  prioridad: string;
  estado: string;
  abiertoEn: string;
  venceEn: string | null;
  /** Horas que faltan para el SLA. `null` cuando no hay SLA pactado. */
  horasRestantes: number | null;
}

export async function getTickets(tenantId: string, ahoraMs: number): Promise<TicketRow[]> {
  const admin = supabaseAdmin();
  const filas = await traerTodo<Record<string, unknown>>(
    (d, h) => acotada(admin.from('ticket_soporte')
      .select('id, asunto, categoria, prioridad, estado, abierto_en, vence_en')
      .eq('tenant_id', tenantId).order('id').range(d, h), 'getTickets'),
    'getTickets',
  );

  return filas.map((t) => {
    const vence = (t.vence_en as string) ?? null;
    return {
      id: t.id as string,
      asunto: String(t.asunto),
      categoria: String(t.categoria),
      prioridad: String(t.prioridad),
      estado: String(t.estado),
      abiertoEn: String(t.abierto_en),
      venceEn: vence,
      // Sin SLA pactado no se calcula: un 0 se leería como "vencido".
      horasRestantes: vence ? round2((new Date(vence).getTime() - ahoraMs) / 3_600_000) : null,
    };
  }).sort((a, b) => (a.horasRestantes ?? Infinity) - (b.horasRestantes ?? Infinity));
}

// ── Rastreo ────────────────────────────────────────────────────────────────

export interface EstadoRastreo {
  /** Proveedores configurados, sin el token: solo los últimos 4. */
  proveedores: Array<{ proveedor: string; ultimos4: string | null; activo: boolean; probadaEn: string | null; ultimoError: string | null }>;
  unidadesConPosicion: number;
  ultimaPosicion: string | null;
  polls: Array<{
    proveedor: string;
    recurso: 'posiciones' | 'eventos';
    ultimoPoll: string | null;
    ultimoCompleto: string | null;
    ultimaMedida: string | null;
    backlogPendiente: boolean;
    paginas: number;
    elementos: number;
    error: string | null;
  }>;
}

/**
 * El token NUNCA sale de aquí. La UI enseña "configurado ✓" y los últimos 4;
 * un panel que muestra el token completo lo filtra a cualquiera que mire la
 * pantalla, y un token de rastreo no expira solo.
 */
export async function getEstadoRastreo(tenantId: string): Promise<EstadoRastreo> {
  const admin = supabaseAdmin();
  const [creds, rastreo, polls] = await Promise.all([
    // El catálogo de credenciales SÍ se trae: es una fila por proveedor
    // (dos o tres), y de ella se pinta una lista, no un número.
    traerTodo<Record<string, unknown>>(
      (d, h) => acotada(admin.from('rastreo_credencial')
        .select('proveedor, token_ultimos4, activo, probada_en, ultimo_error')
        .eq('tenant_id', tenantId).order('proveedor').range(d, h), 'getEstadoRastreo.credencial'),
      'getEstadoRastreo.credencial',
    ),
    // ── ESC-11 · DOS ESCALARES NO SE CALCULAN TRAYENDO LA TABLA ──────────
    //
    // Esto era un `traerTodo` de `posicion` ENTERA de la flota para sacar
    // `count(distinct unidad_id)` y `max(medida_en)`. `posicion` recibe una
    // fila por ping por unidad en cuanto el rastreo esté conectado, y
    // `traerTodo` LANZA a las 100,000 filas: esta pantalla habría sido la
    // primera del panel en dejar de cargar. La purga a 90 días y el índice
    // `(tenant_id, medida_en)` ya los puso la 0155; lo que faltaba era no
    // traerse las filas. `estado_rastreo_tenant()` (0162) agrega en la base.
    traerEstadoRastreoSql(tenantId),
    traerEstadoPollGps(tenantId),
  ]);

  return {
    proveedores: creds.map((c) => ({
      proveedor: String(c.proveedor),
      ultimos4: (c.token_ultimos4 as string) ?? null,
      activo: Boolean(c.activo),
      probadaEn: (c.probada_en as string) ?? null,
      ultimoError: (c.ultimo_error as string) ?? null,
    })),
    unidadesConPosicion: rastreo.unidadesConPosicion,
    ultimaPosicion: rastreo.ultimaPosicion,
    polls,
  };
}

async function traerEstadoPollGps(tenantId: string): Promise<EstadoRastreo['polls']> {
  const { data, error } = await acotada(
    supabaseAdmin().rpc('estado_poll_gps_tenant', { p_tenant: tenantId }),
    'getEstadoRastreo.poll',
  );
  if (error) throw new Error(`getEstadoRastreo.poll: ${error.message}`);
  if (!Array.isArray(data)) throw new Error('getEstadoRastreo.poll: estado_poll_gps_tenant devolvió otra forma (¿migración 0324 sin aplicar?)');
  return data.map((fila) => {
    const f = fila as Record<string, unknown>;
    const recurso = f.recurso;
    if ((recurso !== 'posiciones' && recurso !== 'eventos') || typeof f.proveedor !== 'string' ||
        typeof f.backlogPendiente !== 'boolean' || !esNumero(f.paginas) || !esNumero(f.elementos)) {
      throw new Error('getEstadoRastreo.poll: fila inválida de la migración 0324');
    }
    return {
      proveedor: f.proveedor,
      recurso,
      ultimoPoll: esTextoONulo(f.ultimoPoll) ? f.ultimoPoll : null,
      ultimoCompleto: esTextoONulo(f.ultimoCompleto) ? f.ultimoCompleto : null,
      ultimaMedida: esTextoONulo(f.ultimaMedida) ? f.ultimaMedida : null,
      backlogPendiente: f.backlogPendiente,
      paginas: f.paginas,
      elementos: f.elementos,
      error: esTextoONulo(f.error) ? f.error : null,
    };
  });
}

/**
 * `estado_rastreo_tenant()` (mig. 0162) y **fallar cerrado**: el error POR
 * VALOR primero, y luego la FORMA — si la migración no está aplicada, `data`
 * llega como cualquier otra cosa y un `?? 0` pintaría "0 unidades con
 * posición", que es exactamente la mentira que este panel no puede decir.
 */
async function traerEstadoRastreoSql(
  tenantId: string,
): Promise<{ unidadesConPosicion: number; ultimaPosicion: string | null }> {
  const { data, error } = await acotada(
    supabaseAdmin().rpc('estado_rastreo_tenant', { p_tenant: tenantId }),
    'getEstadoRastreo.posicion',
  );
  if (error) throw new Error(`getEstadoRastreo.posicion: ${error.message}`);
  const r = data as Record<string, unknown> | null;
  if (!esObjeto(r) || !esNumero(r.unidadesConPosicion) || !esTextoONulo(r.ultimaPosicion)) {
    // No se reutiliza `formaInesperada`: ése nombra la 0152, y este RPC es de
    // la 0162 — un mensaje que manda a revisar la migración equivocada cuesta
    // más que no tenerlo.
    throw new Error(
      'getEstadoRastreo: estado_rastreo_tenant devolvió otra forma (¿migración 0162 sin aplicar?): '
      + 'unidadesConPosicion/ultimaPosicion',
    );
  }
  return { unidadesConPosicion: r.unidadesConPosicion, ultimaPosicion: r.ultimaPosicion };
}

/** La última posición conocida de UNA unidad activa de la flota. */
export interface UltimaPosicion {
  unidadId: string;
  /** Como la flota llama a la unidad en la radio y en el papel ("C2-08"). */
  numeroEconomico: string;
  placas: string | null;
  /** `unidad.estado` (disponible|en_ruta|taller|baja) — el rótulo lo pone la
   *  pantalla; aquí viaja crudo. */
  estadoUnidad: string;
  lat: number;
  lng: number;
  /** km/h que reportó el proveedor. `null` cuando no lo manda (el pin de
   *  WhatsApp nunca lo trae) — y `null` NO es cero: cero es "parado". */
  velocidadKmh: number | null;
  /** El instante que reporta el GPS (`medida_en`), no el de la inserción. */
  medidaEn: string;
  /** `whatsapp` (pin del chofer) o el nombre del proveedor del conector. */
  proveedor: string;
}

/**
 * La ÚLTIMA posición de cada unidad activa — `ultimas_posiciones_tenant`
 * (mig. 0269).
 *
 * AUDITORÍA 20, hallazgo 5 (MEDIO): `posicion` tenía dos escritores reales
 * (el pin del chofer por WhatsApp en `processor.ts` y el poller del conector
 * GPS en `conectores/sincronizar_gps.ts`) y NINGUNA pantalla enseñaba una
 * sola posición; `/dashboard/mapa` seguía declarando que la tabla estaba
 * vacía. Ésta es la lectura que faltaba.
 *
 * FALLA CERRADO, igual que `traerEstadoRastreoSql`: un arreglo vacío se pinta
 * como "todavía no llega ninguna posición", y esa frase no se puede decir
 * porque no se pudo preguntar. El error sale por valor y la forma se
 * comprueba fila por fila.
 */
export async function getUltimasPosiciones(tenantId: string): Promise<UltimaPosicion[]> {
  const { data, error } = await acotada(
    supabaseAdmin().rpc('ultimas_posiciones_tenant', { p_tenant: tenantId }),
    'getUltimasPosiciones',
  );
  if (error) throw new Error(`getUltimasPosiciones: ${error.message}`);
  if (!Array.isArray(data)) {
    throw new Error(
      'getUltimasPosiciones: ultimas_posiciones_tenant devolvió otra forma (¿migración 0269 sin aplicar?): '
      + 'se esperaba un arreglo de filas',
    );
  }
  return data.map((f: unknown) => {
    const r = f as Record<string, unknown>;
    // Lat/lng son LO ÚNICO no negociable: sin las dos no hay dónde pintar el
    // pin, y un 0,0 por defecto pondría el camión en el Golfo de Guinea.
    if (!esObjeto(r) || !esNumero(r.lat) || !esNumero(r.lng) || typeof r.medida_en !== 'string') {
      throw new Error(
        'getUltimasPosiciones: ultimas_posiciones_tenant devolvió una fila sin lat/lng/medida_en '
        + `(¿migración 0269 sin aplicar?): ${JSON.stringify(r).slice(0, 120)}`,
      );
    }
    return {
      unidadId: String(r.unidad_id),
      numeroEconomico: String(r.numero_economico ?? ''),
      placas: esTextoONulo(r.placas) ? r.placas : null,
      estadoUnidad: String(r.estado ?? ''),
      lat: r.lat,
      lng: r.lng,
      velocidadKmh: esNumero(r.velocidad) ? r.velocidad : null,
      medidaEn: r.medida_en,
      proveedor: String(r.proveedor ?? ''),
    };
  });
}

// ── Abrir un ticket — LA PUERTA de la señal de PMF #3 ──────────────────────
//
// Auditoría externa 16-ago-2026 (P2): la señal "el cliente se queja por su
// cuenta" (`ticket_soporte.abierto_por`, leída por pmf.ts desde la Fase 1)
// estaba instrumentada pero NADA en el producto podía producirla — la
// pantalla de soporte era solo lectura. Esta función es la puerta.
//
// LA CONVENCIÓN DE LA 0051 PROTEGE LA SEÑAL: `abierto_por` NULL = lo abrió
// Likida a nombre de la flota. Por eso el llamador decide `abiertoPor`:
// una sesión superadmin (Javier con ?tenant= en un demo) pasa null y NO
// contamina la señal de PMF; un usuario real de la flota pasa su id.

export const CATEGORIAS_TICKET = ['facturacion', 'operacion', 'tecnico', 'cuenta', 'otro'] as const;
export const PRIORIDADES_TICKET = ['baja', 'media', 'alta', 'urgente'] as const;

export async function abrirTicket(
  tenantId: string,
  /** null = lo abre Likida (superadmin) a nombre de la flota — 0051. */
  abiertoPor: string | null,
  t: { asunto: string; descripcion: string; categoria: string; prioridad: string },
): Promise<string> {
  const asunto = t.asunto.trim();
  if (!asunto || asunto.length > 200) throw new DatoInvalido('El asunto es obligatorio (máx. 200 caracteres).');
  if (!(CATEGORIAS_TICKET as readonly string[]).includes(t.categoria)) {
    throw new DatoInvalido('Esa categoría no existe.');
  }
  if (!(PRIORIDADES_TICKET as readonly string[]).includes(t.prioridad)) {
    throw new DatoInvalido('Esa prioridad no existe.');
  }
  const descripcion = t.descripcion.trim();

  const { data, error } = await acotada(supabaseAdmin().from('ticket_soporte').insert({
    tenant_id: tenantId,
    abierto_por: abiertoPor,
    asunto,
    descripcion: descripcion === '' ? null : descripcion.slice(0, 4000),
    categoria: t.categoria,
    prioridad: t.prioridad,
  }).select('id').single(), 'abrirTicket');
  if (error) throw new Error(`abrirTicket: ${error.message}`);
  const id = (data as { id?: unknown } | null)?.id;
  if (!id) throw new Error('abrirTicket: el insert no devolvió id');
  return id as string;
}
