import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 18 · A21 — las cuatro rutas de export tenían CERO líneas
// ejecutadas, y una de ellas documenta un IDOR ya corregido: la ruta
// autorizaba por SESIÓN y por TENANT y ahí se detenía; cualquier usuario de
// la flota —un OPERADOR incluido— bajaba el PDF de la liquidación de
// cualquier compañero con el id en la URL. El arreglo son tres cosas
// encadenadas (área `dinero`, `puedeExportar`, `.eq('tenant_id')`) y ninguna
// se ejercía. Aquí se anclan las tres en las cuatro rutas, con los módulos
// REALES de permisos y visibilidad — lo que se dobla es la base y la sesión.
// ═══════════════════════════════════════════════════════════════════════════

let tenant: { ok: true; tenantId: string; rol: string } | { ok: false; status: 401 | 403 | 503; motivo: string } =
  { ok: true, tenantId: 't-1', rol: 'flota_admin' };
vi.mock('@/lib/auth/tenant-api', () => ({ resolverTenantApi: async () => tenant }));
vi.mock('@/lib/ratelimit', () => ({ rateLimit: async () => true, clientIp: () => '1.2.3.4' }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// La base: una consulta a `liquidacion` que registra sus filtros, y el
// storage que firma. `filaPdf` es lo que devuelve `.maybeSingle()`.
// `revision` es opcional a propósito: una fila de antes de la 0299 no la
// trae, y eso NO debe leerse como "rechazada".
let filaPdf: { pdf_url: string | null; revision?: string } | null = { pdf_url: 't-1/v-1.pdf' };
const filtros: Array<[string, unknown]> = [];
/** Los `range(d, h)` que pidió el export de liquidaciones, en orden. */
const rangos: Array<[number, number]> = [];
/** La "base" recorta a max_rows como PostgREST: nunca más de 1,000 por página. */
const MAX_ROWS = 1_000;
const createSignedUrl = vi.fn(async () => ({ data: { signedUrl: 'https://storage/firmada' }, error: null }));
const rpc = vi.fn(async () => ({ error: null }));
function builderLiquidacion() {
  // Estado POR CONSULTA (el cursor `.or`, el rango, si pidió count) — la
  // "base" de esta prueba interpreta DE VERDAD el filtro keyset que manda la
  // ruta, igual que `paginacion.test.ts` de /v1/viajes: si el cursor se arma
  // mal, aquí se repiten o se pierden filas.
  const c = { or: null as string | null, rango: null as [number, number] | null, conteo: false };
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: (_cols: string, opt?: { count?: string }) => { c.conteo = opt?.count === 'exact'; return b; },
    eq: (col: string, v: unknown) => { filtros.push([col, v]); return b; },
    // BLOQ-6 (0299): la ruta acota por `revision` — por omisión deja fuera las
    // rechazadas (`neq`), y con `?revision=firmadas` usa `in`. La "base" de
    // esta prueba tiene que conocer los dos verbos o la cadena se rompe.
    neq: (col: string, v: unknown) => { filtros.push([`${col}<>`, v]); return b; },
    in: (col: string, v: unknown) => { filtros.push([`${col} in`, v]); return b; },
    gte: (col: string, v: unknown) => { filtros.push([`${col}>=`, v]); return b; },
    lt: (col: string, v: unknown) => { filtros.push([`${col}<`, v]); return b; },
    or: (f: string) => { c.or = f; return b; },
    order: () => b,
    range: (d: number, h: number) => { c.rango = [d, h]; rangos.push([d, h]); return b; },
    maybeSingle: async () => ({ data: filaPdf, error: null }),
    then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) => {
      if (errorLiquidacion) return Promise.resolve({ data: null, error: errorLiquidacion, count: null }).then(res, rej);
      paginasServidas += 1;
      let filas = [...liquidaciones];
      if (c.or) {
        // El MISMO filtro que manda la ruta, interpretado de verdad:
        // `created_at.lt.X,and(created_at.eq.X,id.lt.Y)`
        const m = /^created_at\.lt\.(.+),and\(created_at\.eq\.(.+),id\.lt\.(.+)\)$/.exec(c.or);
        if (!m) throw new Error(`filtro de cursor irreconocible: ${c.or}`);
        const [, menor, igual, id] = m;
        filas = filas.filter((v) =>
          (v.created_at as string) < menor || ((v.created_at as string) === igual && (v.id as string) < id));
      }
      const [d, h] = c.rango ?? [0, MAX_ROWS - 1];
      const data = paginasServidas > seCallaDesde ? [] : filas.slice(d, Math.min(h + 1, d + MAX_ROWS));
      const count = c.conteo ? filas.length : null;
      // LA ESCRITURA CONCURRENTE del hallazgo 21-b2: después de servir esta
      // página, un chofer cierra su viaje y entra una liquidación NUEVA — la
      // más reciente de la flota, arriba de todas en el orden descendente.
      if (paginasServidas === insertarTrasPagina) liquidaciones.unshift(FILA_NUEVA);
      return Promise.resolve({ data, error: null, count }).then(res, rej);
    },
  });
  return b;
}
let liquidaciones: Array<Record<string, unknown>> = [];
let errorLiquidacion: { message: string } | null = null;
/** A partir de esta página la base contesta vacío aunque el count diga más. */
let seCallaDesde = Infinity;
/** Cuántas consultas de página ha contestado la "base". */
let paginasServidas = 0;
/** Tras servir esta página entra la liquidación nueva (Infinity = nunca). */
let insertarTrasPagina = Infinity;
/** La liquidación que se escribe a media descarga: más nueva que todas. */
const FILA_NUEVA = {
  id: '00000000-0000-4000-8000-999999999999',
  created_at: '2026-08-22T13:00:00+00:00',
  total_comprobado: 999, total_anticipo: 999, diferencia: 0, estatus: 'cerrada',
  diferencias: [], viaje: { folio: 'V-NUEVA', operador: { nombre: 'Recién' } },
};
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => builderLiquidacion(),
    storage: { from: () => ({ createSignedUrl }) },
    rpc,
  }),
}));
vi.mock('@/lib/likida/presupuesto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/likida/presupuesto')>()),
  acotada: (q: unknown) => q,
}));

// Los generadores de las otras dos rutas: dobles que registran el tenant con
// el que se les llamó — lo que importa es que sea el de la SESIÓN.
const exportarAprobadas = vi.fn(async (_t: string, _f: string) => ({ filas: [{ a: 1 }], ids: ['f-1'], recortado: false }));
const marcarExportadas = vi.fn(async () => ({ error: null }));
vi.mock('@/lib/likida/proveedores', () => ({
  exportarAprobadas: (...a: [string, string]) => exportarAprobadas(...a),
  marcarExportadas: () => marcarExportadas(),
}));
vi.mock('@/lib/likida/agentes/corridas', () => ({ registrarCorrida: async () => {} }));
const bitacoraRmf918 = vi.fn(async (_t: string, _d: string): Promise<unknown> => ({ cruces: [] }));
vi.mock('@/lib/likida/intake/desglose_peaje', () => ({
  bitacoraRmf918: (...a: [string, string]) => bitacoraRmf918(...a),
  bitacoraACsv: () => 'csv-bitacora',
}));

const { LecturaIncompleta } = await import('@/lib/likida/pg');
const pdf = await import('./pdf/[id]/route');
const liq = await import('./liquidaciones/route');
const prov = await import('./facturas-proveedor/route');
const bit = await import('./bitacora-peaje/route');

const req = (url: string) => new Request(url);
const LIQ = '11111111-2222-3333-4444-555555555555';
const GET_PDF = () => pdf.GET(req(`https://app.likida.ai/api/export/pdf/${LIQ}`), { params: Promise.resolve({ id: LIQ }) });
const PERIODO = '?desde=2026-06-01&hasta=2026-08-31';
const GET_LIQ = (q = PERIODO) => liq.GET(req(`https://app.likida.ai/api/export/liquidaciones${q}`));
const GET_PROV = (f = '') => prov.GET(req(`https://app.likida.ai/api/export/facturas-proveedor${f ? `?formato=${f}` : ''}`));
const GET_BIT = (d = 'd-1') => bit.GET(req(`https://app.likida.ai/api/export/bitacora-peaje${d ? `?desglose=${d}` : ''}`));

const RUTAS = [
  ['pdf/[id]', GET_PDF],
  ['liquidaciones', () => GET_LIQ()],
  ['facturas-proveedor', GET_PROV],
  ['bitacora-peaje', GET_BIT],
] as const;

beforeEach(() => {
  tenant = { ok: true, tenantId: 't-1', rol: 'flota_admin' };
  filaPdf = { pdf_url: 't-1/v-1.pdf' };
  filtros.length = 0;
  rangos.length = 0;
  liquidaciones = [];
  errorLiquidacion = null;
  seCallaDesde = Infinity;
  paginasServidas = 0;
  insertarTrasPagina = Infinity;
  createSignedUrl.mockClear(); rpc.mockClear();
  exportarAprobadas.mockClear(); bitacoraRmf918.mockClear();
});

describe.each(RUTAS)('export/%s — las tres puertas del IDOR documentado', (_nombre, GET) => {
  it('sin credencial: el status de resolverTenantApi, sin tocar base ni storage', async () => {
    tenant = { ok: false, status: 401, motivo: 'No autorizado' };
    const r = await GET();
    expect(r.status).toBe(401);
    expect(filtros).toEqual([]);
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(exportarAprobadas).not.toHaveBeenCalled();
    expect(bitacoraRmf918).not.toHaveBeenCalled();
  });

  it('OPERADOR (solo lo suyo): 403 — el IDOR original', async () => {
    tenant = { ok: true, tenantId: 't-1', rol: 'operador' };
    const r = await GET();
    expect(r.status).toBe(403);
    expect(filtros).toEqual([]);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it('ENCARGADO (puede exportar pero NO ve dinero): 403 por área, con el mismo texto que la pantalla', async () => {
    tenant = { ok: true, tenantId: 't-1', rol: 'encargado' };
    const r = await GET();
    expect(r.status).toBe(403);
    expect(await r.text()).toContain('no ve las cifras de dinero');
  });

  it('un rol desconocido falla CERRADO: 403', async () => {
    tenant = { ok: true, tenantId: 't-1', rol: 'rol_inventado' };
    expect((await GET()).status).toBe(403);
  });

  it.each(['contador', 'flota_admin', 'superadmin'])('%s (dinero + exporta) pasa la puerta', async (rol) => {
    tenant = { ok: true, tenantId: 't-1', rol };
    const r = await GET();
    expect([200, 302]).toContain(r.status);
  });

  // Cada documento es de un tenant/liquidación concreto: un caché intermedio
  // (proxy, CDN, o el propio navegador tras cerrar sesión) que reutilice la
  // respuesta para otra sesión filtraría dinero/fiscal entre flotas.
  it('la respuesta exitosa nunca es cacheable', async () => {
    tenant = { ok: true, tenantId: 't-1', rol: 'flota_admin' };
    const r = await GET();
    expect([200, 302]).toContain(r.status);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('export/pdf/[id] — el tenant es el de la SESIÓN, no el de la URL', () => {
  it('la lectura de la liquidación va acotada a tenant_id de la sesión y al id pedido', async () => {
    const r = await GET_PDF();
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://storage/firmada');
    expect(filtros).toEqual(expect.arrayContaining([['id', LIQ], ['tenant_id', 't-1']]));
  });

  it('un id de OTRA flota (la consulta acotada no lo encuentra) es 404, no la URL firmada', async () => {
    filaPdf = null;
    const r = await GET_PDF();
    expect(r.status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it('fila sin PDF también es 404: no se distingue "no existe" de "existe sin papel"', async () => {
    filaPdf = { pdf_url: null };
    expect((await GET_PDF()).status).toBe(404);
  });

  it('la descarga se registra con el rol real (0114) y nunca impide la descarga', async () => {
    rpc.mockRejectedValueOnce(new Error('rpc caída'));
    const r = await GET_PDF();
    expect(r.status).toBe(302);
    tenant = { ok: true, tenantId: 't-1', rol: 'superadmin' };
    await GET_PDF();
    expect(rpc).toHaveBeenLastCalledWith('registrar_descarga_liquidacion', expect.objectContaining({ p_tenant: 't-1', p_rol: 'superadmin', p_liquidacion: LIQ }));
  });

  it('si storage no firma, 502 y nada de redirigir a una URL vacía', async () => {
    createSignedUrl.mockResolvedValueOnce({ data: { signedUrl: '' }, error: null });
    expect((await GET_PDF()).status).toBe(502);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L07 (BE-A1) — la liquidación rechazada NO se sirve como vigente.
//
// El `select` no traía `revision`: la ruta firmaba y redirigía al PDF viejo
// sin poder preguntarse si la liquidación seguía siendo la vigente. La 0346
// anula `pdf_url` cuando la revisión pasa a 'ajustada' pero NO cuando pasa a
// 'rechazada' — así que una fila rechazada con un `pdf_url` de ANTES del
// rechazo la ruta la servía igual que una aprobada.
// ═══════════════════════════════════════════════════════════════════════════
describe('export/pdf/[id] — revisión rechazada: no se sirve como vigente (BE-A1)', () => {
  it('revision === rechazada: 409 con motivo, sin firmar URL ni redirigir', async () => {
    filaPdf = { pdf_url: 't-1/v-1.pdf', revision: 'rechazada' };
    const r = await GET_PDF();
    expect(r.status).toBe(409);
    expect(await r.text()).toContain('rechazada');
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(r.headers.get('location')).toBeNull();
  });

  it('una fila SIN `revision` (de antes de la 0299) no se confunde con rechazada: sigue sirviendo', async () => {
    filaPdf = { pdf_url: 't-1/v-1.pdf' };
    const r = await GET_PDF();
    expect(r.status).toBe(302);
  });

  it.each(['pendiente', 'aprobada', 'ajustada'])('revision === %s: sigue sirviendo el PDF', async (revision) => {
    filaPdf = { pdf_url: 't-1/v-1.pdf', revision };
    const r = await GET_PDF();
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://storage/firmada');
  });
});

describe('export/liquidaciones — CSV acotado al tenant', () => {
  // `id` y `created_at` bajan ESTRICTAMENTE con `i` — el mismo orden
  // (`created_at desc, id desc`) que pide la ruta — para que el filtro
  // `.or()` del cursor, aplicado sobre este arreglo ya "ordenado", recorte
  // exactamente el sufijo que serviría Postgres. Antes `created_at` ciclaba
  // cada 28 días (montones de empates) y no había `id`: el cursor keyset no
  // podía distinguir filas del mismo instante — se necesitaba esto para
  // poder escribir la prueba de la escritura concurrente de abajo.
  const BASE_MS = Date.parse('2026-08-22T12:00:00Z');
  const fila = (i: number) => ({
    id: `id-${String(900_000 - i).padStart(6, '0')}`,
    created_at: new Date(BASE_MS - i * 1_000).toISOString(),
    total_comprobado: 100 + i, total_anticipo: 120, diferencia: 20 - i,
    estatus: 'cerrada', diferencias: i % 2 ? [{}] : [], viaje: { folio: `V-${i}`, operador: { nombre: 'Juan' } },
  });

  it('consulta con tenant_id de la sesión y sale como CSV adjunto', async () => {
    liquidaciones = [fila(1)];
    const r = await GET_LIQ();
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toContain('liquidaciones_likida.csv');
    expect(filtros).toEqual(expect.arrayContaining([['tenant_id', 't-1']]));
    expect(await r.text()).toContain('V-1');
  });

  // ── ESC-8 (escala 50k): periodo obligatorio ≤ 3 meses + archivo en stream ──
  it('sin ?desde=&hasta= es 400 con la forma del parámetro, y NO se toca la base', async () => {
    const r = await GET_LIQ('');
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('desde=YYYY-MM-DD');
    expect(rangos).toEqual([]);
  });

  it.each([
    ['solo desde', '?desde=2026-06-01'],
    ['fecha que no existe', '?desde=2026-02-30&hasta=2026-03-01'],
    ['formato raro', '?desde=01/06/2026&hasta=2026-06-30'],
    ['hasta antes de desde', '?desde=2026-06-10&hasta=2026-06-01'],
    ['3 meses y un día', '?desde=2026-06-01&hasta=2026-09-01'],
  ])('periodo inválido (%s) es 400', async (_n, q) => {
    expect((await GET_LIQ(q)).status).toBe(400);
    expect(rangos).toEqual([]);
  });

  it('3 meses justos (1-jun..31-ago) pasan; el rango va a la base como [desde, hasta+1) en hora de México', async () => {
    const r = await GET_LIQ('?desde=2026-06-01&hasta=2026-08-31');
    expect(r.status).toBe(200);
    await r.text();
    expect(filtros).toEqual(expect.arrayContaining([
      ['created_at>=', '2026-06-01T00:00:00-06:00'],
      ['created_at<', '2026-09-01T00:00:00-06:00'],
    ]));
  });

  it('REPRO: 2,345 liquidaciones salen las 2,345, página por página, y el CSV es BYTE POR BYTE el de toCsv de la lista entera', async () => {
    liquidaciones = Array.from({ length: 2_345 }, (_, i) => fila(i));
    const r = await GET_LIQ();
    expect(r.status).toBe(200);
    const texto = await r.text();
    const { toCsv, toLiquidacionRows } = await import('@/lib/likida/export');
    expect(texto).toBe(toCsv(toLiquidacionRows(liquidaciones as never)));
    expect(texto.split('\n').length).toBe(2_345 + 2); // encabezado + filas + salto final
    // KEYSET, no posición: cada página pide `range(0, 999)` — el cursor va en
    // el `.or()`, no en el rango — así que las tres páginas piden el MISMO
    // rango. La firma de que en verdad se avanzó es `filtros`/`rangos.length`,
    // no un rango creciente como el de antes del arreglo.
    expect(rangos).toEqual([[0, 999], [0, 999], [0, 999]]);
  });

  it('una página exacta (1,000) no paga un viaje extra: el count dice que ya está', async () => {
    liquidaciones = Array.from({ length: 1_000 }, (_, i) => fila(i));
    await (await GET_LIQ()).text();
    expect(rangos).toEqual([[0, 999]]);
  });

  it('sin liquidaciones en el periodo el archivo sale vacío (como antes), no un encabezado suelto', async () => {
    const r = await GET_LIQ();
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('');
  });

  it('si la base falla en la PRIMERA página es un 500 con texto, no un archivo a medias', async () => {
    errorLiquidacion = { message: 'relation liquidacion does not exist' };
    const r = await GET_LIQ();
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain('relation');
  });

  it('si la base deja de entregar A MEDIO archivo, la descarga se ABORTA — jamás un CSV corto cerrado limpio', async () => {
    liquidaciones = Array.from({ length: 1_500 }, (_, i) => fila(i));
    seCallaDesde = 1;
    const r = await GET_LIQ();
    expect(r.status).toBe(200);
    await expect(r.text()).rejects.toThrow(/incompleta/);
  });

  // ── AUDITORÍA 21 · BACKEND · MEDIO (REINCIDENTE 18-c4) ────────────────────
  //
  // Antes cada página se pedía con `range(d, d+999)`: posición sobre un orden
  // (`created_at desc`) que CAMBIA entre página y página. Un chofer que cierra
  // su viaje por WhatsApp a media descarga escribe la liquidación MÁS NUEVA de
  // la flota — entra en la posición 0 del orden descendente y desplaza a todas
  // las demás un lugar. Con `count` ya congelado desde la primera página, la
  // página 2 pedía `range(1000, 1999)`: ahora esa ventana trae la ÚLTIMA fila
  // de la página 1 REPETIDA (se corrió una posición) y NUNCA trae la fila que
  // antes vivía en la posición 1999 — y como `leidas` llega exacto a
  // `esperadas`, el corte no lo nota: el CSV sale "completo" con una fila de
  // más y otra de menos.
  //
  // El arreglo cambia el cursor de POSICIÓN a FILA: `(created_at, id) <
  // (última vista)`. Una fila más nueva que el cursor nunca puede colarse
  // antes de él, así que insertarla a mitad de la descarga no mueve a nadie.
  it('REPRO 21-b2: una liquidación nueva escrita ENTRE páginas ya no duplica una fila ni pierde otra', async () => {
    const N = 1_200; // > PAGINA: obliga a una segunda vuelta de página
    liquidaciones = Array.from({ length: N }, (_, i) => fila(i));
    insertarTrasPagina = 1; // el chofer cierra su viaje justo después de la 1ª página

    const r = await GET_LIQ();
    expect(r.status).toBe(200);
    const texto = await r.text();
    const cuerpo = texto.trim().split('\n').slice(1); // sin encabezado

    // Ni una fila de más: el folio de la escritura concurrente (la más nueva,
    // fuera del cursor de la primera página) no aparece — el corte quedó
    // congelado al instante de la primera página, como documenta el código.
    expect(texto).not.toContain('V-NUEVA');

    // Ni una fila de menos, ni una repetida: las N originales, cada una UNA
    // sola vez — el bug viejo dejaba N+1 líneas (una duplicada) con una de las
    // N faltando.
    const folios = cuerpo.map((linea) => linea.split(',')[0]);
    expect(folios).toHaveLength(N);
    expect(new Set(folios).size).toBe(N); // sin duplicados
    const esperados = new Set(Array.from({ length: N }, (_, i) => `V-${i}`));
    expect(new Set(folios)).toEqual(esperados); // sin faltantes

    // Y sí se pidieron (al menos) dos páginas: la escritura concurrente pasó
    // DE VERDAD entre una y otra, no antes de la primera.
    expect(rangos.length).toBeGreaterThanOrEqual(2);
  });
});

describe('export/facturas-proveedor — el tenant viaja al generador y el formato se valida', () => {
  it('exporta con el tenant de la sesión y el formato pedido', async () => {
    const r = await GET_PROV('sap_b1');
    expect(r.status).toBe(200);
    expect(exportarAprobadas).toHaveBeenCalledWith('t-1', 'sap_b1');
    expect(r.headers.get('content-disposition')).toContain('facturas_proveedor_sap_b1_likida.csv');
  });

  it('un formato inventado es 400, no un default silencioso', async () => {
    const r = await GET_PROV('xml_raro');
    expect(r.status).toBe(400);
    expect(exportarAprobadas).not.toHaveBeenCalled();
  });
});

describe('export/bitacora-peaje — el desglose se busca acotado al tenant', () => {
  it('pasa el tenant de la sesión junto al id de la URL', async () => {
    const r = await GET_BIT('d-9');
    expect(r.status).toBe(200);
    expect(bitacoraRmf918).toHaveBeenCalledWith('t-1', 'd-9');
  });

  it('un desglose de otra flota (null) es 404', async () => {
    bitacoraRmf918.mockResolvedValueOnce(null);
    expect((await GET_BIT('ajeno')).status).toBe(404);
  });

  it('sin ?desglose= es 400', async () => {
    expect((await GET_BIT('')).status).toBe(400);
  });

  // AUDITORÍA 24, BE-24: una lectura que no puede demostrar que trajo todos
  // los cruces salía como «Intenta de nuevo en un momento» — mandaba al
  // contralor a reintentar un error determinista creyendo que fue mala suerte.
  it('BE-24: `LecturaIncompleta` se nombra, no se disfraza de bache pasajero', async () => {
    bitacoraRmf918.mockRejectedValueOnce(new LecturaIncompleta('peaje.cruces', 1_000, 1_400));
    const r = await GET_BIT('d-9');
    const texto = await r.text();
    expect(r.status).toBe(500);
    expect(texto).not.toContain('Intenta de nuevo');
    expect(texto).toContain('más cruces de los que');
  });
});
