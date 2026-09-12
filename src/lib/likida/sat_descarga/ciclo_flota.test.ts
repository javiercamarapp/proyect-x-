// ═══════════════════════════════════════════════════════════════════════════
// `correrFlota` — LA MÁQUINA DE ESTADOS QUE NO TENÍA NI UNA PRUEBA.
//
// La auditoría del ciclo 7 lo dijo con todas sus letras: `ciclo.test.ts` cubre
// la función pura `rangoPendiente` y el camino «proveedor no configurado», y
// `correrFlota` —verificar, bajar paquetes, ingerir, dedup, avance del
// calendario, pedir el siguiente rango— no tenía NINGUNA. Cuatro hallazgos
// (c7-2 crítico, c7-13 alto, c7-19 y c7-20 medios) vivían ahí abajo.
//
// POR QUÉ ESTE ARCHIVO NO USA EL MOCK COMPARTIDO DE `supabaseAdmin`. El mock
// de la casa hace que todo método devuelva el builder e IGNORE sus argumentos:
// con él ninguna prueba puede ver un `.limit()` que trunca, un `.eq()` ausente
// ni una fila que no se escribió. Aquí lo que hay que demostrar es justamente
// QUÉ SE ESCRIBIÓ y CUÁNTAS VECES SE LLAMÓ AL PROVEEDOR, así que la base falsa
// guarda estado de verdad: filas en memoria, filtros aplicados, y un registro
// de cada llamada al SAT.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// El XML no es lo que se prueba aquí: cada "xml" es su propio folio fiscal.
vi.mock('../intake/cfdi_xml', () => ({
  parseCfdiXml: (xml: string) => ({
    uuid: xml, total: 100, fecha: '2026-08-10T00:00:00',
    rfcEmisor: 'AAA010101AAA', rfcReceptor: 'EKU9003173C9',
    tipoComprobante: 'I', lineas: [],
  }),
}));
// REN-C1: `vi.hoisted` para poder espiar llamadas Y reconfigurar el destino
// por prueba — el resto del archivo (destino fijo 'disponible') sigue igual,
// las pruebas de REN-C1 son las únicas que llaman a `decidirCruce.mockReturnValueOnce`.
const { guardarYConciliarConsolidado, decidirCruce } = vi.hoisted(() => ({
  guardarYConciliarConsolidado: vi.fn(async () => {}),
  decidirCruce: vi.fn((_cfdi: { uuid?: string }): DestinoCfdi => ({ destino: 'disponible', motivo: 'ningún gasto le corresponde' })),
}));
vi.mock('../intake/consolidado', () => ({ guardarYConciliarConsolidado }));
vi.mock('../repo', () => ({ saveCfdiXmlRaw: vi.fn(async () => {}) }));
vi.mock('./cruce', () => ({
  decidirCruce,
}));

interface Op {
  tabla: string;
  verbo: 'select' | 'insert' | 'update' | 'upsert';
  payload: Record<string, unknown> | null;
  filtros: Record<string, unknown>;
  conteo: boolean;
}

let manejar: (op: Op) => { data: unknown; error: unknown; count?: number };

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from(tabla: string) {
      const op: Op = { tabla, verbo: 'select', payload: null, filtros: {}, conteo: false };
      const b: Record<string, unknown> = {};
      const cadena = () => b;
      Object.assign(b, {
        select: (_c: string, o?: { count?: string; head?: boolean }) => {
          if (o?.count !== undefined) op.conteo = true;
          return cadena();
        },
        insert: (p: Record<string, unknown>) => { op.verbo = 'insert'; op.payload = p; return cadena(); },
        update: (p: Record<string, unknown>) => { op.verbo = 'update'; op.payload = p; return cadena(); },
        upsert: (p: Record<string, unknown>) => { op.verbo = 'upsert'; op.payload = p; return cadena(); },
        eq: (c: string, v: unknown) => { op.filtros[c] = v; return cadena(); },
        in: (c: string, v: unknown) => { op.filtros[c] = v; return cadena(); },
        is: (c: string, v: unknown) => { op.filtros[c] = v; return cadena(); },
        gte: cadena, lte: cadena, order: cadena, limit: cadena, range: cadena,
        single: cadena, maybeSingle: cadena,
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve(manejar(op)).then(res, rej),
      });
      return b;
    },
    rpc: () => ({ then: (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res) }),
  }),
}));

import { correrFlota, paquetesYaBajados, solicitudAtorada } from './ciclo';
import type { ProveedorDescargaSat } from './tipos';
import type { DestinoCfdi } from './cruce';

const TENANT = '11111111-1111-4111-8111-111111111111';

interface FilaSolicitud extends Record<string, unknown> {
  id: string; request_id: string | null; tipo: string; desde: string; hasta: string;
  estado: string; intentos: number; paquetes_bajados: unknown;
  cfdis_nuevos: number | null; cfdis_repetidos: number | null; solicitada_en: string;
}

/** La base falsa: filas de verdad, filtros de verdad. */
function base(solicitudes: FilaSolicitud[]) {
  // `estatus` se guarda de verdad: es la columna que decide si el contralor ve
  // el CFDI en la bandeja «nadie reportó este gasto». Sin ella, una prueba no
  // puede distinguir «se concilió» de «se concilió y además se sacó de la
  // bandeja», que es justo el par que AG-C1 separa.
  const cfdis: { cfdi_uuid: string; solicitud_id: string; estatus?: string }[] = [];
  const errores = new Map<string, { code?: string; message: string }>();
  manejar = (op) => {
    const forzado = errores.get(`${op.tabla}:${op.verbo}`);
    if (forzado !== undefined) return { data: null, error: forzado };

    if (op.tabla === 'sat_descarga_solicitud') {
      if (op.verbo === 'select') {
        return { data: solicitudes.filter((s) => ['solicitada', 'en_proceso', 'lista'].includes(s.estado)), error: null };
      }
      if (op.verbo === 'update') {
        const f = solicitudes.find((s) => s.id === op.filtros.id);
        if (f === undefined) return { data: null, error: null };
        // Los filtros extra del "soltar" son una guardia optimista de verdad.
        if ('request_id' in op.filtros && f.request_id !== op.filtros.request_id) return { data: null, error: null };
        if ('estado' in op.filtros && f.estado !== op.filtros.estado) return { data: null, error: null };
        Object.assign(f, op.payload);
        return { data: null, error: null };
      }
      if (op.verbo === 'insert') {
        const p = op.payload as Record<string, unknown>;
        const viva = solicitudes.some((s) => ['solicitada', 'en_proceso', 'lista'].includes(s.estado)
          && s.tipo === p.tipo && !(String(p.hasta) < s.desde || String(p.desde) > s.hasta));
        if (viva) return { data: null, error: { code: '23P01', message: 'conflicting key value violates exclusion constraint "sat_solicitud_viva_sin_traslape"' } };
        const fila: FilaSolicitud = {
          id: `sol-${solicitudes.length + 1}`, request_id: null,
          tipo: String(p.tipo), desde: String(p.desde), hasta: String(p.hasta),
          estado: String(p.estado), intentos: Number(p.intentos), paquetes_bajados: null,
          cfdis_nuevos: null, cfdis_repetidos: null, solicitada_en: '2026-08-27T00:00:00Z',
        };
        solicitudes.push(fila);
        return { data: { id: fila.id }, error: null };
      }
    }
    if (op.tabla === 'gasto') return { data: [], error: null };
    if (op.tabla === 'sat_cfdi_descargado') {
      if (op.verbo === 'upsert') {
        const p = op.payload as { cfdi_uuid: string; solicitud_id: string; estatus?: string };
        if (cfdis.some((c) => c.cfdi_uuid === p.cfdi_uuid)) return { data: [], error: null }; // el sello de dedup
        cfdis.push({ cfdi_uuid: p.cfdi_uuid, solicitud_id: p.solicitud_id, estatus: p.estatus });
        return { data: [{ id: p.cfdi_uuid }], error: null };
      }
      if (op.verbo === 'update') {
        const f = cfdis.find((c) => c.cfdi_uuid === op.filtros.cfdi_uuid);
        if (f !== undefined) Object.assign(f, op.payload);
        return { data: null, error: null };
      }
      if (op.conteo) {
        return { data: null, error: null, count: cfdis.filter((c) => c.solicitud_id === op.filtros.solicitud_id).length };
      }
      return { data: null, error: null };
    }
    if (op.tabla === 'sat_descarga_config') return { data: null, error: null };
    return { data: null, error: null };
  };
  return { solicitudes, cfdis, errores };
}

/** Un SAT falso que CUENTA cada llamada: es la cifra que más importa aquí. */
function proveedor(paquetes: string[]) {
  const llamadas = { solicitar: 0, verificar: 0, descargar: [] as string[] };
  const prov: ProveedorDescargaSat = {
    nombre: 'sw',
    async solicitar() { llamadas.solicitar++; return { ok: true, requestId: `req-${llamadas.solicitar}` }; },
    async verificar() {
      llamadas.verificar++;
      return { ok: true, estado: 'lista', paquetes, cfdis: null, mensaje: null };
    },
    async descargar(p: string) { llamadas.descargar.push(p); return { ok: true, xmls: [`${p}-cfdi-1`, `${p}-cfdi-2`] }; },
    async credencial() { return { ok: true, numero: '3'.repeat(20), venceEn: null }; },
  };
  return { prov, llamadas };
}

function solicitudViva(over: Partial<FilaSolicitud> = {}): FilaSolicitud {
  return {
    id: 'sol-1', request_id: 'req-sat-1', tipo: 'recibidos',
    desde: '2026-07-01', hasta: '2026-07-31', estado: 'en_proceso', intentos: 1,
    paquetes_bajados: null, cfdis_nuevos: null, cfdis_repetidos: null,
    solicitada_en: '2026-08-01T00:00:00Z', ...over,
  };
}

const CFG = () => ({ tenantId: TENANT, rfc: 'EKU9003173C9', ultimaHasta: '2026-07-31' });
const AHORA = new Date('2026-08-27T12:00:00Z');

beforeEach(() => vi.clearAllMocks());

// ── c7-2 ───────────────────────────────────────────────────────────────────
describe('c7-2 · una solicitud de más de 3 paquetes TERMINA, y no re-baja lo bajado', () => {
  it('reanuda por el pendiente y cierra en la corrida en que se acaban', async () => {
    const db = base([solicitudViva()]);
    const { prov, llamadas } = proveedor(['p1', 'p2', 'p3', 'p4', 'p5']);

    const r1 = await correrFlota(CFG(), prov, '2026-08-27', AHORA);
    expect(llamadas.descargar).toEqual(['p1', 'p2', 'p3']);
    expect(db.solicitudes[0].estado).toBe('lista');             // todavía no cierra
    expect(db.solicitudes[0].paquetes_bajados).toEqual(['p1', 'p2', 'p3']);
    expect(r1.descargadas).toBe(0);

    const r2 = await correrFlota(CFG(), prov, '2026-08-27', AHORA);
    // LO CLAVE: la segunda vuelta NO vuelve a bajar p1/p2/p3.
    expect(llamadas.descargar).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(db.solicitudes[0].estado).toBe('descargada');
    expect(db.solicitudes[0].paquetes_bajados).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(r2.descargadas).toBe(1);
    // Los 5 paquetes traen 2 CFDI cada uno, y ni uno entró dos veces.
    expect(db.cfdis).toHaveLength(10);
  });

  it('antes de la 0236 esto era un bucle infinito: tres corridas, los mismos tres', async () => {
    // La contraprueba del hallazgo. Sin `paquetes_bajados` persistido, la
    // lista de bajados siempre arranca vacía y el orden es siempre el mismo.
    const db = base([solicitudViva()]);
    const { prov, llamadas } = proveedor(['p1', 'p2', 'p3', 'p4', 'p5']);
    await correrFlota(CFG(), prov, '2026-08-27', AHORA);
    db.solicitudes[0].paquetes_bajados = null; // se simula la columna que no existía
    await correrFlota(CFG(), prov, '2026-08-27', AHORA);
    expect(llamadas.descargar).toEqual(['p1', 'p2', 'p3', 'p1', 'p2', 'p3']);
    expect(db.solicitudes[0].estado).toBe('lista'); // nunca cerraría
  });

  it('una solicitud de 2 paquetes cierra en UNA sola corrida', async () => {
    const db = base([solicitudViva()]);
    const { prov, llamadas } = proveedor(['p1', 'p2']);
    const r = await correrFlota(CFG(), prov, '2026-08-27', AHORA);
    expect(llamadas.descargar).toEqual(['p1', 'p2']);
    expect(db.solicitudes[0].estado).toBe('descargada');
    expect(r.descargadas).toBe(1);
  });

  it('si el avance no se puede anotar, se CORTA en vez de quemar cuota del SAT', async () => {
    const db = base([solicitudViva()]);
    const { prov, llamadas } = proveedor(['p1', 'p2', 'p3']);
    // El primer update de avance falla: seguir bajaría paquetes que la vuelta
    // siguiente pediría igual, contra el tope real del SAT.
    let vistos = 0;
    const original = manejar;
    manejar = (op) => {
      if (op.tabla === 'sat_descarga_solicitud' && op.verbo === 'update'
        && op.payload !== null && 'paquetes_bajados' in op.payload && vistos++ === 0) {
        return { data: null, error: { message: 'sin respuesta en 8000 ms (tope de consulta)' } };
      }
      return original(op);
    };
    const r = await correrFlota(CFG(), prov, '2026-08-27', AHORA);
    expect(llamadas.descargar).toEqual(['p1']);
    expect(db.solicitudes[0].estado).toBe('lista');
    expect(r.errores.join(' ')).toMatch(/no se pudo anotar el avance/i);
  });
});

// ── c7-20 ──────────────────────────────────────────────────────────────────
describe('c7-20 · `cfdis_nuevos` es de ESA solicitud, no de la corrida entera', () => {
  it('la segunda solicitud no hereda los folios de la primera', async () => {
    const db = base([
      solicitudViva({ id: 'sol-1', request_id: 'req-a', desde: '2026-06-01', hasta: '2026-06-30' }),
      solicitudViva({ id: 'sol-2', request_id: 'req-b', desde: '2026-07-01', hasta: '2026-07-31' }),
    ]);
    // Dos paquetes por solicitud serían 4 descargas > MAX_PAQUETES: uno cada
    // una, que es justo el caso de dos solicitudes cerradas en la misma pasada.
    const { prov } = proveedor(['pq']);
    // Cada solicitud tiene que traer folios DISTINTOS o el dedup los comería.
    const desc = prov.descargar.bind(prov);
    let n = 0;
    prov.descargar = async () => { n++; return { ok: true, xmls: [`f${n}a`, `f${n}b`, `f${n}c`] }; };
    void desc;

    const r = await correrFlota(CFG(), prov, '2026-08-27', AHORA);
    expect(r.cfdisNuevos).toBe(6);                       // el total de la flota
    expect(db.solicitudes[0].cfdis_nuevos).toBe(3);      // …y 3 en cada una
    expect(db.solicitudes[1].cfdis_nuevos).toBe(3);
  });

  it('cuenta los repetidos por solicitud sin confundir NULL con 0', async () => {
    const db = base([solicitudViva()]);
    const { prov } = proveedor(['pq']);
    prov.descargar = async () => ({ ok: true, xmls: ['mismo-folio', 'mismo-folio'] });
    await correrFlota(CFG(), prov, '2026-08-27', AHORA);
    expect(db.solicitudes[0].cfdis_nuevos).toBe(1);
    expect(db.solicitudes[0].cfdis_repetidos).toBe(1);
  });
});

// ── c7-13 ──────────────────────────────────────────────────────────────────
describe('c7-13 · una solicitud viva SIN folio del SAT no se queda ahí para siempre', () => {
  const atorada = () => solicitudViva({
    id: 'sol-atorada', request_id: null, estado: 'solicitada',
    desde: '2026-08-01', hasta: '2026-08-26', solicitada_en: '2026-08-25T00:00:00Z',
  });

  it('a las 24 h se suelta, se DICE por qué, y el rango se vuelve a pedir', async () => {
    const db = base([atorada()]);
    const { prov, llamadas } = proveedor([]);
    const r = await correrFlota(CFG(), prov, '2026-08-27', AHORA);

    expect(db.solicitudes[0].estado).toBe('error');
    expect(String(db.solicitudes[0].proveedor_mensaje)).toMatch(/sin folio del SAT/);
    // Y dice lo que cuesta, en vez de callárselo.
    expect(String(db.solicitudes[0].proveedor_mensaje)).toMatch(/tope diario del RFC/);
    // El error entra al resumen: el latido tiene que salir 'parcial', no 'ok'.
    expect(r.errores).toHaveLength(1);
    // Soltada la zombi, la flota vuelve a pedir — UNA vez, no en cada corrida.
    expect(llamadas.solicitar).toBe(1);
    expect(r.solicitadas).toBe(1);
  });

  it('antes de las 24 h NO se toca: un timeout de red se resuelve solo', async () => {
    const db = base([solicitudViva({
      id: 'sol-reciente', request_id: null, estado: 'solicitada',
      solicitada_en: '2026-08-27T06:00:00Z', desde: '2026-08-01', hasta: '2026-08-26',
    })]);
    const { prov, llamadas } = proveedor([]);
    const r = await correrFlota(CFG(), prov, '2026-08-27', AHORA);
    expect(db.solicitudes[0].estado).toBe('solicitada');
    expect(llamadas.solicitar).toBe(0);   // sigue bloqueando el rango, a propósito
    expect(r.errores).toEqual([]);
  });

  it('solicitudAtorada no afirma nada sin fecha ni sobre estados que sí avanzan', () => {
    expect(solicitudAtorada('solicitada', null, null, AHORA)).toBe(false);
    expect(solicitudAtorada('solicitada', null, 'no-es-fecha', AHORA)).toBe(false);
    expect(solicitudAtorada('en_proceso', null, '2026-08-01T00:00:00Z', AHORA)).toBe(false);
    expect(solicitudAtorada('solicitada', 'req-1', '2026-08-01T00:00:00Z', AHORA)).toBe(false);
    expect(solicitudAtorada('solicitada', null, '2026-08-01T00:00:00Z', AHORA)).toBe(true);
  });
});

// ── c7-19 ──────────────────────────────────────────────────────────────────
describe('c7-19 · un error del insert no se lee como «ya lo pidió otro»', () => {
  it('el rebote del candado de rango vivo NO es un error', async () => {
    // Hay una viva que cubre el rango que tocaría pedir: rebota y se calla.
    const db = base([solicitudViva({ desde: '2026-08-01', hasta: '2026-08-27', estado: 'en_proceso', request_id: 'req-x' })]);
    const { prov } = proveedor([]);
    prov.verificar = async () => ({ ok: true, estado: 'en_proceso', paquetes: [], cfdis: null, mensaje: null });
    const r = await correrFlota({ ...CFG(), ultimaHasta: '2026-07-31' }, prov, '2026-08-27', AHORA);
    expect(r.errores).toEqual([]);
    expect(db.solicitudes).toHaveLength(1);
  });

  it('cualquier OTRO error se dice, y no se pide nada al SAT', async () => {
    const db = base([]);
    db.errores.set('sat_descarga_solicitud:insert', { message: 'sin respuesta en 8000 ms (tope de consulta)' });
    const { prov, llamadas } = proveedor([]);
    const r = await correrFlota(CFG(), prov, '2026-08-27', AHORA);
    expect(llamadas.solicitar).toBe(0);
    expect(r.errores).toHaveLength(1);
    expect(r.errores[0]).toMatch(/No se pudo reservar la solicitud/);
    // El mensaje del proveedor/base va TAL CUAL.
    expect(r.errores[0]).toMatch(/sin respuesta en 8000 ms/);
  });
});

describe('paquetesYaBajados — reanudar sobre basura sería peor que empezar', () => {
  it('NULL y lo que no sea arreglo de textos se leen como «ninguno»', () => {
    expect(paquetesYaBajados(null)).toEqual([]);
    expect(paquetesYaBajados({ p1: true })).toEqual([]);
    expect(paquetesYaBajados(['p1', 3, '', 'p2'])).toEqual(['p1', 'p2']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EL RELOJ DE LA VUELTA, ADENTRO DEL CICLO DEL SAT (auditoría ciclo 7, c7-1;
// deuda anotada por el fork del #160).
//
// `correrDescargaSat` corría SIN RELOJ PROPIO. La ruta ya calculaba un
// `venceEn` y se lo pasaba a `avisarCierrePeaje`, que corre DESPUÉS — así que
// cuando la descarga se comía la vuelta, el síntoma era el aviso de peaje
// saliendo con `sinTurno` alto y el latido diciendo 'parcial': el problema era
// VISIBLE pero no estaba arreglado, y quien pagaba la factura era el otro
// trabajo, el que sí se había portado bien.
//
// Y aquí el corte tiene un filo que ningún otro motor tiene: BAJAR UN PAQUETE
// GASTA CUOTA DEL SAT. Un paquete se puede bajar dos veces y a la tercera el
// proveedor lo rechaza. Cortar entre `descargar` y el UPDATE del avance
// quemaría el derecho a bajarlo para tirar su contenido.
// ═══════════════════════════════════════════════════════════════════════════

describe('c7-1 · el reloj de la vuelta corta el ciclo del SAT sin quemar cuota ni saltar días', () => {
  const VENCIDO = () => Date.now() - 1;

  it('con el reloj vencido no le pregunta NADA al SAT y cuenta las solicitudes sin turno', async () => {
    const db = base([solicitudViva()]);
    const { prov, llamadas } = proveedor(['p1']);

    const r = await correrFlota(CFG(), prov, '2026-08-27', AHORA, VENCIDO());

    // CORTA: ni una llamada de red, ni de verificar ni de descargar.
    expect(llamadas.verificar).toBe(0);
    expect(llamadas.descargar).toEqual([]);
    // Y tampoco abre trabajo NUEVO: sin tiempo no se pide otro rango.
    expect(llamadas.solicitar).toBe(0);
    // CUENTA: la solicitud que no se miró se dice.
    expect(r.sinTurno).toBe(1);
    // NO DEJA EL ESTADO A MEDIAS: la solicitud queda exactamente como estaba.
    expect(db.solicitudes[0].estado).toBe('en_proceso');
    expect(db.solicitudes[0].paquetes_bajados).toBeNull();
  });

  it('EL CORTE A MITAD DE PAQUETES NO AVANZA EL CALENDARIO — un día saltado no vuelve nunca', async () => {
    // EL PELIGRO QUE ESTA PRUEBA EXISTE PARA CERRAR. Si el corte por reloj
    // dejara `todoBien` en true, la solicitud se marcaría 'descargada' y
    // `ultima_descarga_hasta` avanzaría a 2026-07-31 con paquetes SIN BAJAR.
    // Ese calendario no retrocede jamás: los CFDI de esos días quedarían fuera
    // para siempre y nadie se enteraría — el gasto sin su comprobante, la
    // deducción perdida, y ni un error en ningún log.
    const db = base([solicitudViva()]);
    let ahora = 1_000_000;
    const vence = ahora + 10_000;
    const reloj = vi.spyOn(Date, 'now').mockImplementation(() => ahora);
    try {
      const llamadas = { descargar: [] as string[] };
      const prov: ProveedorDescargaSat = {
        nombre: 'sw',
        async solicitar() { return { ok: true, requestId: 'req-x' }; },
        async verificar() { return { ok: true, estado: 'lista', paquetes: ['p1', 'p2', 'p3'], cfdis: null, mensaje: null }; },
        async descargar(p: string) {
          llamadas.descargar.push(p);
          // El reloj se agota EN CUANTO el primer paquete termina de bajar:
          // la vuelta se muere DENTRO del bucle, que es el caso real.
          ahora = vence + 1;
          return { ok: true, xmls: [`${p}-cfdi-1`, `${p}-cfdi-2`] };
        },
        async credencial() { return { ok: true, numero: '3'.repeat(20), venceEn: null }; },
      };

      const r = await correrFlota(CFG(), prov, '2026-08-27', AHORA, vence);

      // CORTA: solo se bajó el primero; p2 y p3 no gastaron cuota del SAT.
      expect(llamadas.descargar).toEqual(['p1']);
      // NO DEJA EL ESTADO A MEDIAS. AUDITORÍA 25 (REND-A3): ahora `ingerir`
      // TAMBIÉN mira el reloj, así que aquí el corte llega ANTES de ingerir
      // ni un solo CFDI de p1 (el reloj ya estaba vencido cuando `ingerir`
      // hizo su primera pregunta) — p1 se bajó (gastó cuota del SAT) pero no
      // se anota como bajado, así que la próxima corrida lo re-baja y el
      // sello de dedup hace que retomar sea barato.
      expect(db.solicitudes[0].paquetes_bajados).toEqual([]);
      expect(db.cfdis).toHaveLength(0);
      //  · la solicitud NO se cierra…
      expect(db.solicitudes[0].estado).not.toBe('descargada');
      expect(r.descargadas).toBe(0);
      //  · …y por lo tanto EL CALENDARIO NO AVANZA. Éste es el aserto que
      //    protege contra la pérdida silenciosa de datos fiscales.
      const avances = db.solicitudes.filter((s) => s.estado === 'descargada');
      expect(avances).toHaveLength(0);
      // CUENTA: los dos CFDI de p1 que no se ingirieron, más p2 y p3 que ni
      // se intentaron.
      expect(r.sinTurno).toBe(4);
    } finally {
      reloj.mockRestore();
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // AUDITORÍA 25, ALTO (REND-A3) — el reloj ahora también corre DENTRO de
  // `ingerir`, no solo antes de `prov.descargar`. Un paquete real es «un ZIP
  // con MILES de CFDI»: sin este chequeo, un paquete que no cabe en `venceEn`
  // corría completo y Vercel lo mataba a medio bucle sin que nadie tuviera
  // ocasión de anotar nada.
  // ═════════════════════════════════════════════════════════════════════════
  it('REND-A3: un paquete que no cabe entero en el tiempo se ingiere PARCIAL y no se marca bajado', async () => {
    const db = base([solicitudViva()]);
    let llamadasReloj = 0;
    // El reloj sigue dentro de tope mientras se procesan los dos primeros CFDI
    // del paquete, y se vence justo antes del tercero — el caso real de un
    // paquete con más CFDI de los que caben en `venceEn`. Las primeras dos
    // preguntas son las de `correrFlota` (antes de la solicitud y antes del
    // paquete); las siguientes, una por CFDI dentro de `ingerir`.
    const reloj = vi.spyOn(Date, 'now').mockImplementation(() => { llamadasReloj++; return llamadasReloj <= 4 ? 1_000 : 999_999; });
    try {
      const prov: ProveedorDescargaSat = {
        nombre: 'sw',
        async solicitar() { return { ok: true, requestId: 'req-x' }; },
        async verificar() { return { ok: true, estado: 'lista', paquetes: ['p1'], cfdis: null, mensaje: null }; },
        async descargar(p: string) { return { ok: true, xmls: [`${p}-a`, `${p}-b`, `${p}-c`, `${p}-d`] }; },
        async credencial() { return { ok: true, numero: '3'.repeat(20), venceEn: null }; },
      };

      const r = await correrFlota(CFG(), prov, '2026-08-27', AHORA, 500_000);

      // Se ingirieron los CFDI que cupieron antes del corte, ni uno más.
      expect(db.cfdis).toHaveLength(2);
      // El paquete se descargó (gastó cuota) pero no se anota como bajado:
      // la corrida siguiente lo re-baja y retoma barato vía el sello de dedup.
      expect(db.solicitudes[0].paquetes_bajados).toEqual([]);
      // La solicitud no se cierra ni el calendario avanza con CFDI faltantes.
      expect(db.solicitudes[0].estado).not.toBe('descargada');
      // Los dos CFDI que no alcanzaron turno se cuentan, no se pierden mudos.
      expect(r.sinTurno).toBe(2);
    } finally {
      reloj.mockRestore();
    }
  });

  it('sin reloj el ciclo se comporta igual que siempre — el parámetro es opcional', async () => {
    const db = base([solicitudViva()]);
    const { prov, llamadas } = proveedor(['p1']);
    const r = await correrFlota(CFG(), prov, '2026-08-27', AHORA);
    expect(llamadas.descargar).toEqual(['p1']);
    expect(r.sinTurno).toBe(0);
    expect(db.solicitudes[0].estado).toBe('descargada');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// REN-C1 (auditoría 29) · un consolidado con el sello YA puesto (una corrida
// anterior murió a medio conciliar — un corte duro de Vercel, no una
// excepción atrapada) SÍ se reintenta, en vez de saltarse para siempre.
//
// El estado que deja una muerte así: el sello en `sat_cfdi_descargado` YA
// existe (se commitea antes de conciliar), pero el PAQUETE nunca se marcó
// `bajado` (esa anotación es posterior, y la invocación murió antes de
// llegar ahí) — así que la corrida siguiente SÍ vuelve a bajar el paquete y
// a recorrer sus XML, y es ahí donde antes el sello ya puesto hacía `continue`
// sin volver a intentar `guardarYConciliarConsolidado` (que ya es idempotente
// y reanudable por sí sola: la prueba no reimplementa esa parte, solo
// confirma que SE LE VUELVE A DAR LA OPORTUNIDAD DE CORRER).
// ═══════════════════════════════════════════════════════════════════════════
describe('REN-C1 · el sello de dedup ya puesto no debe impedir reintentar un consolidado', () => {
  afterEach(() => {
    decidirCruce.mockImplementation(() => ({ destino: 'disponible' as const, motivo: 'ningún gasto le corresponde' }));
  });

  it('paquete nunca marcado bajado + sello ya existente: se vuelve a llamar guardarYConciliarConsolidado', async () => {
    const db = base([solicitudViva({ paquetes_bajados: null })]);
    // El estado que deja una muerte a medio conciliar: el sello YA está.
    db.cfdis.push({ cfdi_uuid: 'p1-cfdi-1', solicitud_id: 'sol-1' });
    decidirCruce.mockImplementation((cfdi: { uuid?: string }): DestinoCfdi =>
      cfdi.uuid === 'p1-cfdi-1'
        ? { destino: 'consolidado' as const, emisor: 'Banco X (monedero)' }
        : { destino: 'disponible' as const, motivo: 'ningún gasto le corresponde' });
    const { prov } = proveedor(['p1']);

    const r = await correrFlota(CFG(), prov, '2026-08-27', AHORA);

    expect(guardarYConciliarConsolidado).toHaveBeenCalledTimes(1);
    expect(r.errores).toEqual([]);
    // El repetido SÍ cuenta como repetido (el sello ya existía) — lo que
    // cambia no es el conteo, es que la conciliación se reintentó.
    expect(db.solicitudes[0].cfdis_repetidos).toBe(1);
  });

  it('si guardarYConciliarConsolidado sigue sin poder terminar, el error se reporta — no se traga en silencio', async () => {
    const db = base([solicitudViva({ paquetes_bajados: null })]);
    db.cfdis.push({ cfdi_uuid: 'p1-cfdi-1', solicitud_id: 'sol-1' });
    decidirCruce.mockImplementation((cfdi: { uuid?: string }): DestinoCfdi =>
      cfdi.uuid === 'p1-cfdi-1'
        ? { destino: 'consolidado' as const, emisor: 'Banco X (monedero)' }
        : { destino: 'disponible' as const, motivo: 'ningún gasto le corresponde' });
    guardarYConciliarConsolidado.mockRejectedValueOnce(new Error('cfdi_consolidado_linea: la base no contestó'));
    const { prov } = proveedor(['p1']);

    const r = await correrFlota(CFG(), prov, '2026-08-27', AHORA);

    expect(guardarYConciliarConsolidado).toHaveBeenCalledTimes(1);
    expect(r.errores.some((e) => e.includes('El consolidado p1-cfdi-1 no se pudo conciliar'))).toBe(true);
  });

  // ── AG-C1 (auditoría 30) ────────────────────────────────────────────────
  // El arreglo de REN-C1 le devolvió la oportunidad de conciliarse al
  // consolidado con sello previo, pero dejó `marcar(...,'ignorado')` DENTRO de
  // `if (!yaDescargado)`. Consecuencia: el reintento que sí concilia no saca
  // el CFDI de la bandeja. El sello se insertó con `estatus: 'disponible'`, y
  // 'disponible' es literalmente «nadie reportó este gasto»: el contralor ve
  // un ECC de $200,000 ofrecido para ligarlo 1:1 contra un ticket de $1,200,
  // que es lo que la regla 3.3.1.7 prohíbe — y ya se concilió línea por línea,
  // así que ligarlo otra vez mueve el acreditamiento al gasto equivocado.
  //
  // Reintentar y no cerrar el ciclo es peor que no reintentar: antes el
  // consolidado se saltaba y quedaba sin conciliar (visiblemente incompleto);
  // ahora queda conciliado Y ofrecido, que se ve correcto y no lo está.
  it('AG-C1 · el consolidado reintentado con sello previo SÍ sale de la bandeja: estatus queda en ignorado', async () => {
    const db = base([solicitudViva({ paquetes_bajados: null })]);
    // El estado que deja una muerte a medio conciliar: sello puesto, y con el
    // estatus con el que nace todo sello, 'disponible'.
    db.cfdis.push({ cfdi_uuid: 'p1-cfdi-1', solicitud_id: 'sol-1', estatus: 'disponible' });
    decidirCruce.mockImplementation((cfdi: { uuid?: string }): DestinoCfdi =>
      cfdi.uuid === 'p1-cfdi-1'
        ? { destino: 'consolidado' as const, emisor: 'Banco X (monedero)' }
        : { destino: 'disponible' as const, motivo: 'ningún gasto le corresponde' });
    const { prov } = proveedor(['p1']);

    await correrFlota(CFG(), prov, '2026-08-27', AHORA);

    // La conciliación corrió (eso ya lo garantiza REN-C1)...
    expect(guardarYConciliarConsolidado).toHaveBeenCalledTimes(1);
    // ...y el ciclo se cerró: el CFDI ya no se le ofrece a nadie.
    expect(db.cfdis.find((c) => c.cfdi_uuid === 'p1-cfdi-1')?.estatus).toBe('ignorado');
  });

  it('un consolidado genuinamente NUEVO (sin sello previo) sigue contando y marcando como siempre', async () => {
    const db = base([solicitudViva({ paquetes_bajados: null })]);
    decidirCruce.mockImplementation((cfdi: { uuid?: string }): DestinoCfdi =>
      cfdi.uuid === 'p1-cfdi-1'
        ? { destino: 'consolidado' as const, emisor: 'Banco X (monedero)' }
        : { destino: 'disponible' as const, motivo: 'ningún gasto le corresponde' });
    const { prov } = proveedor(['p1']);

    await correrFlota(CFG(), prov, '2026-08-27', AHORA);

    expect(guardarYConciliarConsolidado).toHaveBeenCalledTimes(1);
    // El paquete falso trae DOS xmls (p1-cfdi-1 y p1-cfdi-2); ninguno tenía
    // sello previo, así que los dos cuentan como nuevos — el segundo es
    // 'disponible' (mock por omisión), no otro consolidado.
    expect(db.solicitudes[0].cfdis_nuevos).toBe(2);
    expect(db.solicitudes[0].cfdis_repetidos).toBe(0);
  });
});
