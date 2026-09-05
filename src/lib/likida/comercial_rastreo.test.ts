import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// ESC-11 · getEstadoRastreo ya no se trae `posicion` entera.
//
// Eran dos escalares —cuántas unidades tienen posición y cuál fue la última—
// calculados sobre TODAS las filas de `posicion` de la flota, traídas con
// `traerTodo`. `posicion` recibe una fila por ping por unidad en cuanto el
// rastreo esté conectado, y `traerTodo` LANZA a las 100,000: esta pantalla
// habría sido la primera del panel en dejar de cargar.
//
// Lo que se fija aquí:
//   · la agregación va por `estado_rastreo_tenant()` (mig. 0162), con SU
//     tenant, y `posicion` NO se pagina;
//   · el catálogo de credenciales SÍ se sigue trayendo (es una lista, no un
//     número) y el token NUNCA sale — solo los últimos 4;
//   · fallar cerrado por partida doble: el error POR VALOR y la FORMA. Un
//     "0 unidades con posición" inventado diría que el rastreo no está
//     midiendo nada cuando lo que pasó es que no se pudo preguntar.
// ═══════════════════════════════════════════════════════════════════════════

type Resp = { data: unknown; error: { message: string } | null };

let respRpc: Resp;
let respPosiciones: Resp;
let respPoll: Resp;
let respCredenciales: Resp;
const llamadas: Array<{ tipo: 'rpc' | 'from'; nombre: string; args?: unknown }> = [];
let paginasServidas = 0;

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    rpc: (fn: string, args: unknown) => {
      llamadas.push({ tipo: 'rpc', nombre: fn, args });
      const r = fn === 'ultimas_posiciones_tenant'
        ? respPosiciones
        : fn === 'estado_poll_gps_tenant'
          ? respPoll
          : respRpc;
      return { then: (res: (v: Resp) => unknown) => Promise.resolve(r).then(res) };
    },
    from: (tabla: string) => {
      llamadas.push({ tipo: 'from', nombre: tabla });
      const api: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'not', 'in']) api[m] = () => api;
      // `traerTodo` pagina, y llama a `.from()` DE NUEVO en cada página: el
      // contador tiene que vivir fuera del builder o la primera página se
      // serviría para siempre. Página 0 = los datos; página 1 = vacía, y ahí
      // termina (sin `count`, una página vacía es la prueba del final).
      api.range = () => Promise.resolve(
        paginasServidas++ === 0 ? respCredenciales : { data: [], error: null },
      );
      return api;
    },
  }),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { getEstadoRastreo, getUltimasPosiciones } = await import('./comercial');

beforeEach(() => {
  llamadas.length = 0;
  paginasServidas = 0;
  respRpc = { data: { unidadesConPosicion: 0, ultimaPosicion: null }, error: null };
  respPosiciones = { data: [], error: null };
  respPoll = { data: [], error: null };
  respCredenciales = { data: [], error: null };
});

describe('getEstadoRastreo — los dos escalares salen de la base, no de las filas', () => {
  it('agrega por RPC con su tenant y NUNCA pagina `posicion`', async () => {
    respRpc = { data: { unidadesConPosicion: 12, ultimaPosicion: '2026-08-22T15:00:00+00:00' }, error: null };
    const r = await getEstadoRastreo('t-1');
    expect(r.unidadesConPosicion).toBe(12);
    expect(r.ultimaPosicion).toBe('2026-08-22T15:00:00+00:00');
    expect(llamadas).toContainEqual({ tipo: 'rpc', nombre: 'estado_rastreo_tenant', args: { p_tenant: 't-1' } });
    expect(llamadas).toContainEqual({ tipo: 'rpc', nombre: 'estado_poll_gps_tenant', args: { p_tenant: 't-1' } });
    expect(llamadas.some((l) => l.tipo === 'from' && l.nombre === 'posicion')).toBe(false);
  });

  it('distingue la recepción del poll, la medición del dispositivo y el backlog', async () => {
    respPoll = { data: [{
      proveedor: 'samsara', recurso: 'posiciones',
      ultimoPoll: '2026-09-03T10:05:00Z', ultimoCompleto: '2026-09-03T10:00:00Z',
      ultimaMedida: '2026-09-03T09:58:00Z', backlogPendiente: true,
      paginas: 11, elementos: 5100, error: 'deadline',
      eventosInvalidosUltima: 2, eventosInvalidosTotal: 9,
      eventosEnCuarentena: 4, eventosCuarentenaMuertos: 1,
      eventosOutboxPendientes: 3, eventosOutboxMuertos: 2,
      avisosPendientes: 1, avisosMuertos: 1,
    }], error: null };
    const r = await getEstadoRastreo('t-1');
    expect(r.polls[0]).toMatchObject({
      ultimoPoll: '2026-09-03T10:05:00Z', ultimaMedida: '2026-09-03T09:58:00Z',
      backlogPendiente: true, paginas: 11, elementos: 5100,
      eventosInvalidosUltima: 2, eventosInvalidosTotal: 9,
      eventosEnCuarentena: 4, eventosCuarentenaMuertos: 1,
      eventosOutboxPendientes: 3, eventosOutboxMuertos: 2,
      avisosPendientes: 1, avisosMuertos: 1,
    });
    expect(r.ultimaPosicion).toBeNull();
  });

  it('sin una sola posición, `ultimaPosicion` es null — no una fecha inventada', async () => {
    const r = await getEstadoRastreo('t-1');
    expect(r).toMatchObject({ unidadesConPosicion: 0, ultimaPosicion: null });
  });

  it('el token no sale: solo los últimos 4 del proveedor configurado', async () => {
    respCredenciales = {
      data: [{ proveedor: 'wialon', token_ultimos4: '9821', activo: true, probada_en: '2026-08-20T00:00:00Z', ultimo_error: null }],
      error: null,
    };
    const r = await getEstadoRastreo('t-1');
    expect(r.proveedores).toEqual([
      { proveedor: 'wialon', ultimos4: '9821', activo: true, probadaEn: '2026-08-20T00:00:00Z', ultimoError: null },
    ]);
    expect(JSON.stringify(r)).not.toContain('token');
  });

  it('error POR VALOR de la RPC: LANZA — "no pude preguntar" no es "cero unidades"', async () => {
    respRpc = { data: null, error: { message: 'fetch failed' } };
    await expect(getEstadoRastreo('t-1')).rejects.toThrow(/getEstadoRastreo\.posicion: fetch failed/);
  });

  it('la 0162 sin aplicar (otra forma) también LANZA, con la migración en el mensaje', async () => {
    respRpc = { data: { unidadesConPosicion: 'doce' }, error: null };
    await expect(getEstadoRastreo('t-1')).rejects.toThrow(/0162 sin aplicar/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 20 (H5) · getUltimasPosiciones — el GPS que estaba y no se veía.
//
// `posicion` tenía dos escritores reales (el pin del chofer por WhatsApp y el
// poller del conector GPS) y NINGUNA pantalla enseñaba una sola posición:
// /dashboard/mapa declaraba, en comentario y en leyenda, que la tabla estaba
// vacía. Esta es la lectura que faltaba, y lo que se fija aquí es lo que la
// hace segura de pintar:
//
//   · va por RPC con SU tenant — nunca un `from('posicion')` que se traiga la
//     tabla de más escritura del producto para filtrar en JS;
//   · falla CERRADO: un arreglo vacío afirma "todavía no llega ninguna
//     posición", y eso no se puede decir cuando no se pudo preguntar;
//   · `velocidad` ausente es `null`, no 0. Cero es "parado" y es un dato
//     distinto: un camión "a 0 km/h" en pantalla es una afirmación.
// ═══════════════════════════════════════════════════════════════════════════

const FILA = {
  unidad_id: 'u-1', numero_economico: 'C2-08', placas: 'ABC-123-A', estado: 'en_ruta',
  lat: 19.4326, lng: -99.1332, velocidad: 82.5,
  medida_en: '2026-08-29T18:00:00+00:00', proveedor: 'wialon',
};

describe('getUltimasPosiciones — la posición medida, sin traerse `posicion`', () => {
  it('llama a la RPC de la 0269 con su tenant y NO pagina la tabla', async () => {
    respPosiciones = { data: [FILA], error: null };
    const r = await getUltimasPosiciones('t-1');
    expect(llamadas).toContainEqual({ tipo: 'rpc', nombre: 'ultimas_posiciones_tenant', args: { p_tenant: 't-1' } });
    expect(llamadas.some((l) => l.tipo === 'from' && l.nombre === 'posicion')).toBe(false);
    expect(r).toEqual([{
      unidadId: 'u-1', numeroEconomico: 'C2-08', placas: 'ABC-123-A', estadoUnidad: 'en_ruta',
      lat: 19.4326, lng: -99.1332, velocidadKmh: 82.5,
      medidaEn: '2026-08-29T18:00:00+00:00', proveedor: 'wialon',
    }]);
  });

  it('sin velocidad, `null` — no un cero que se leería como "parado"', async () => {
    // El pin de WhatsApp nunca trae velocidad: es una coordenada y ya.
    respPosiciones = { data: [{ ...FILA, velocidad: null, proveedor: 'whatsapp', placas: null }], error: null };
    const [p] = await getUltimasPosiciones('t-1');
    expect(p.velocidadKmh).toBeNull();
    expect(p.placas).toBeNull();
    expect(p.proveedor).toBe('whatsapp');
  });

  it('flota sin una sola posición: arreglo vacío, sin inventar filas', async () => {
    await expect(getUltimasPosiciones('t-1')).resolves.toEqual([]);
  });

  it('error POR VALOR: LANZA — "no pude preguntar" no es "no hay GPS"', async () => {
    respPosiciones = { data: null, error: { message: 'fetch failed' } };
    await expect(getUltimasPosiciones('t-1')).rejects.toThrow(/getUltimasPosiciones: fetch failed/);
  });

  it('la 0269 sin aplicar (otra forma) LANZA con la migración en el mensaje', async () => {
    respPosiciones = { data: { filas: [] }, error: null };
    await expect(getUltimasPosiciones('t-1')).rejects.toThrow(/0269 sin aplicar/);
  });

  it('una fila sin lat/lng LANZA: un 0,0 por defecto pondría el camión en el Golfo de Guinea', async () => {
    respPosiciones = { data: [{ ...FILA, lat: null }], error: null };
    await expect(getUltimasPosiciones('t-1')).rejects.toThrow(/sin lat\/lng\/medida_en/);
  });
});
