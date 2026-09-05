import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// EL DERIVADOR — lo que esta suite se niega a dejar pasar.
//
// Este motor convierte hechos que Likida YA tenía (la hora en que el operador
// aceptó su viaje por WhatsApp, las posiciones de su unidad) en marcas del
// registro de jornada del art. 132 fr. XXXIV de la LFT. O sea: escribe un
// documento laboral. Las cuatro cosas que se fijan aquí son las cuatro maneras
// en que ese documento podría salir MINTIENDO sin que nadie se entere:
//
//   1. EL RELOJ. `venceEn` no solo se recibe: se CONSULTA antes de tomar
//      trabajo nuevo, y lo que no alcanzó se cuenta en `cortadosPorReloj` sin
//      dejar nada a medias.
//   2. EL TOPE. `listaTruncada` distingue «no había más» de «queda otra
//      página». La RPC mueve un cursor rotativo bajo lock, así que ninguna
//      página queda enterrada detrás de los mismos 400 viajes.
//   3. LA LISTA ILEGIBLE LANZA. Un resultado en ceros se leería como «no había
//      nada que hacer», y el cron pintaría verde sobre un expediente vacío.
//   4. `ya_estaba` NO ES UN FALLO. Es el resultado esperado del índice único de
//      la 0241 cuando el operador YA había declarado su marca: la precedencia
//      del declarado sobre el derivado es una restricción de la base, no un
//      `if`, y contarla como fallo pondría el cron en rojo por funcionar bien.
// ═══════════════════════════════════════════════════════════════════════════

const { logger } = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/logger', () => ({ logger }));
// `acotada` solo pone un tope de tiempo a la consulta; aquí estorba y no es lo
// que se está probando (tiene su propia suite).
vi.mock('@/lib/likida/presupuesto', () => ({ acotada: async (p: unknown) => p }));

// ── LA BASE DOBLADA ────────────────────────────────────────────────────────
// Solo dos tablas: `viaje` (la lista de trabajo) y `posicion` (los extremos de
// GPS del día). El escritor —`asegurarDiaJornada` / `asentarMarca`— se dobla
// aparte, más abajo: tiene su propio contrato y su propia suite.
interface FilaViaje {
  id: string;
  tenant_id: string;
  operador_id: string;
  unidad_id: string | null;
  aceptado_en: string;
}
let viajes: FilaViaje[] = [];
let errorViajes: { message: string } | null = null;
interface TrabajoFake {
  fila: FilaViaje;
  unidadIds: string[];
  inputVersion: string;
  dia: string;
  hecho: boolean;
  claimToken: string | null;
  claimOwner: string | null;
  intentos: number;
}
let trabajos = new Map<string, TrabajoFake>();
let secuenciaClaim = 0;
let fallarAckUnaVez = false;
let lotesProcesados = 0;
let alTerminarLote: (() => void) | null = null;
/** `${unidadId}|${dia}` → los `medida_en` de ese día, en orden ascendente. */
let posiciones = new Map<string, string[]>();
let errorGps: { message: string } | null = null;
// ── AUDITORÍA 22, LEG-C1 ───────────────────────────────────────────────────
// Qué operadores YA recibieron el aviso de privacidad. El motor se niega a
// derivar el expediente laboral de quien no está aquí: tratar antes de avisar
// es lo que el art. 16 prohíbe. Por default todos lo tienen, para que las demás
// pruebas de esta suite sigan midiendo lo suyo.
let conAviso: Set<string> | null = null;   // null = todos
let errorAviso: { message: string } | null = null;

interface Estado { tabla: string; ascendente: boolean; unidades: string[]; dia: string; operador: string }

function resolver(e: Estado): { data: unknown; error: { message: string } | null } {
  if (e.tabla === 'operador') {
    if (errorAviso) return { data: null, error: errorAviso };
    const ok = conAviso === null || conAviso.has(e.operador);
    return { data: { aviso_privacidad_en: ok ? '2026-08-01T00:00:00.000Z' : null }, error: null };
  }
  if (e.tabla === 'viaje') {
    return errorViajes ? { data: null, error: errorViajes } : { data: viajes, error: null };
  }
  if (errorGps) return { data: null, error: errorGps };
  const lista = e.unidades.flatMap((unidadId) =>
    (posiciones.get(`${unidadId}|${e.dia}`) ?? []).map((momento) => ({ momento, unidadId })),
  ).sort((a, b) => a.momento.localeCompare(b.momento) || a.unidadId.localeCompare(b.unidadId));
  if (lista.length === 0) return { data: null, error: null };
  // El motor pide la primera y la última con dos consultas que solo difieren en
  // el `order`; el doble contesta según esa misma bandera.
  const punto = e.ascendente ? lista[0] : lista[lista.length - 1];
  return { data: { medida_en: punto.momento, unidad_id: punto.unidadId }, error: null };
}

function sincronizarTrabajos(): void {
  const grupos = new Map<string, FilaViaje[]>();
  for (const v of [...viajes].sort((a, b) => a.aceptado_en.localeCompare(b.aceptado_en) || a.id.localeCompare(b.id))) {
    const dia = v.aceptado_en.slice(0, 10);
    const llave = `${v.tenant_id}|${v.operador_id}|${dia}`;
    grupos.set(llave, [...(grupos.get(llave) ?? []), v]);
  }
  for (const [llave, filas] of grupos) {
    const fila = filas[0];
    const dia = fila.aceptado_en.slice(0, 10);
    const unidadIds = [...new Set(filas.flatMap((v) => v.unidad_id ? [v.unidad_id] : []))].sort();
    const puntos = unidadIds.flatMap((u) => posiciones.get(`${u}|${dia}`) ?? []).sort();
    const inputVersion = JSON.stringify({
      viajes: filas.map((v) => [v.id, v.unidad_id, v.aceptado_en]),
      unidadIds,
      primera: puntos[0] ?? null,
      ultima: puntos.at(-1) ?? null,
      posiciones: puntos.length,
    });
    const previo = trabajos.get(llave);
    if (!previo) {
      trabajos.set(llave, { fila, unidadIds, inputVersion, dia, hecho: false, claimToken: null, claimOwner: null, intentos: 0 });
    } else if (previo.inputVersion !== inputVersion) {
      previo.fila = fila;
      previo.unidadIds = unidadIds;
      previo.inputVersion = inputVersion;
      previo.hecho = false;
    }
  }
}

function resolverClaimJornada(args: { p_limite?: number; p_owner?: string }): { data: unknown; error: { message: string } | null } {
  if (errorViajes) return { data: null, error: errorViajes };
  const candidatos = [...trabajos.values()]
    .filter((t) => !t.hecho && t.claimToken === null)
    .sort((a, b) => a.fila.aceptado_en.localeCompare(b.fila.aceptado_en) || a.fila.id.localeCompare(b.fila.id));
  const limite = Math.max(1, Number(args.p_limite ?? 400));
  const pagina = candidatos.slice(0, limite);
  for (const t of pagina) {
    t.claimToken = `00000000-0000-4000-8000-${String(++secuenciaClaim).padStart(12, '0')}`;
    t.claimOwner = String(args.p_owner);
    t.intentos++;
  }
  return {
    data: pagina.map((t) => ({
      ...t.fila, unidad_ids: t.unidadIds, input_version: t.inputVersion,
      dia: t.dia, claim_token: t.claimToken, intentos: t.intentos,
      zona_horaria: 'America/Mexico_City',
      hay_mas: candidatos.length > pagina.length,
    })),
    error: null,
  };
}

async function resolverProceso(args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> {
  const tokens = new Set(args.p_claim_tokens as string[]);
  const lote = [...trabajos.values()].filter((t) => t.claimOwner === args.p_owner && t.claimToken && tokens.has(t.claimToken));
  const filas: Array<Record<string, unknown>> = [];

  for (const t of lote) {
    const claimToken = t.claimToken as string;
    let asentados = 0;
    let yaEstaban = 0;
    let diaSinGps = false;
    let sinAviso = false;
    let fallo: string | null = null;

    if (errorAviso) {
      logger.error('privacidad.aviso_previo_ilegible', expect.anything());
      sinAviso = true;
    } else if (conAviso !== null && !conAviso.has(t.fila.operador_id)) {
      sinAviso = true;
    } else {
      try {
        const expediente = await asegurarDiaJornada(t.fila.tenant_id, t.fila.operador_id, t.dia);
        if ('error' in expediente) fallo = `expediente ${t.fila.operador_id}/${t.dia}: ${expediente.error}`;
        else {
          const contar = (r: 'asentado' | 'ya_estaba' | 'fallo', etiqueta: string) => {
            if (r === 'asentado') asentados++;
            else if (r === 'ya_estaba') yaEstaban++;
            else fallo = etiqueta;
          };
          contar(await asentarMarca({
            jornadaId: expediente.id, tenantId: t.fila.tenant_id, tipo: 'inicio_jornada',
            momento: new Date(t.fila.aceptado_en), procedencia: 'hito_viaje',
            origenRef: `viaje:${t.fila.id}:aceptado_en`, viajeId: t.fila.id,
            unidadId: t.fila.unidad_id,
          }), `inicio hito ${t.fila.id}`);

          if (t.unidadIds.length > 0) {
            if (errorGps) fallo = `gps ${t.unidadIds.join(',')}/${t.dia}: ${errorGps.message}`;
            else {
              const puntos = t.unidadIds.flatMap((unidadId) =>
                (posiciones.get(`${unidadId}|${t.dia}`) ?? []).map((momento) => ({ momento, unidadId })),
              ).sort((a, b) => a.momento.localeCompare(b.momento) || a.unidadId.localeCompare(b.unidadId));
              if (puntos.length === 0) diaSinGps = true;
              else {
                const primera = puntos[0];
                const ultima = puntos[puntos.length - 1];
                contar(await asentarMarca({
                  jornadaId: expediente.id, tenantId: t.fila.tenant_id, tipo: 'inicio_jornada',
                  momento: new Date(primera.momento), procedencia: 'gps',
                  origenRef: `gps:${primera.unidadId}:${t.dia}:primera:${primera.momento}`,
                  unidadId: primera.unidadId, viajeId: t.fila.id,
                }), `inicio gps ${t.fila.unidad_id}/${t.dia}`);
                if (ultima.momento !== primera.momento) {
                  contar(await asentarMarca({
                    jornadaId: expediente.id, tenantId: t.fila.tenant_id, tipo: 'fin_jornada',
                    momento: new Date(ultima.momento), procedencia: 'gps',
                    origenRef: `gps:${ultima.unidadId}:${t.dia}:ultima:${ultima.momento}`,
                    unidadId: ultima.unidadId, viajeId: t.fila.id,
                  }), `fin gps ${t.fila.unidad_id}/${t.dia}`);
                }
              }
            }
          }
        }
      } catch (e) {
        fallo = `trabajo ${t.fila.operador_id}/${t.dia}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    if (fallarAckUnaVez) {
      fallarAckUnaVez = false;
      return { data: null, error: { message: 'ACK interrumpido' } };
    }
    t.hecho = fallo === null && !sinAviso;
    t.claimToken = null;
    t.claimOwner = null;
    filas.push({
      claim_token: claimToken,
      exito: fallo === null && !sinAviso,
      asentados, ya_estaban: yaEstaban, dia_sin_gps: diaSinGps,
      sin_aviso: sinAviso, error: fallo ?? (sinAviso ? 'aviso de privacidad pendiente' : null),
    });
  }
  return { data: filas, error: null };
}

async function resolverRpc(nombre: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> {
  if (nombre === 'sincronizar_jornadas_por_derivar') {
    if (errorViajes) return { data: null, error: errorViajes };
    sincronizarTrabajos();
    return { data: trabajos.size, error: null };
  }
  if (nombre === 'reclamar_jornadas_por_derivar') return resolverClaimJornada(args);
  if (nombre === 'procesar_jornadas_derivadas') {
    const resultado = await resolverProceso(args);
    lotesProcesados++;
    alTerminarLote?.();
    return resultado;
  }
  if (nombre === 'finalizar_jornada_derivacion') {
    if (fallarAckUnaVez) {
      fallarAckUnaVez = false;
      return { data: null, error: { message: 'ACK interrumpido' } };
    }
    const t = [...trabajos.values()].find((x) => x.claimToken === args.p_claim_token && x.claimOwner === args.p_owner);
    if (!t) return { data: false, error: null };
    if (args.p_exito === true) t.hecho = true;
    t.claimToken = null;
    t.claimOwner = null;
    return { data: true, error: null };
  }
  if (nombre === 'liberar_jornadas_por_derivar') {
    const tokens = new Set(args.p_claim_tokens as string[]);
    let n = 0;
    for (const t of trabajos.values()) {
      if (t.claimOwner === args.p_owner && t.claimToken && tokens.has(t.claimToken)) {
        t.claimToken = null;
        t.claimOwner = null;
        t.intentos--;
        n++;
      }
    }
    return { data: n, error: null };
  }
  throw new Error(`RPC no doblada: ${nombre}`);
}

function expirarLeasesFake(): void {
  for (const t of trabajos.values()) {
    t.claimToken = null;
    t.claimOwner = null;
  }
}

function builder(tabla: string) {
  const e: Estado = { tabla, ascendente: true, unidades: [], dia: '', operador: '' };
  const b: Record<string, unknown> = {};
  const igual = () => b;
  Object.assign(b, {
    select: igual, not: igual, lte: igual, limit: igual, is: igual, maybeSingle: igual,
    in: (col: string, v: unknown[]) => {
      if (col === 'unidad_id') e.unidades = v.map(String);
      return b;
    },
    eq: (col: string, v: unknown) => {
      if (col === 'unidad_id') e.unidades = [String(v)];
      if (col === 'id' && tabla === 'operador') e.operador = String(v);
      return b;
    },
    // El `gte` de posiciones lleva `inicioDiaMx(dia)`: de ahí sale el día.
    gte: (_col: string, v: unknown) => { e.dia = String(v).slice(0, 10); return b; },
    order: (_col: string, o?: { ascending?: boolean }) => { e.ascendente = o?.ascending !== false; return b; },
    then: (res: (x: unknown) => unknown, rej: (x: unknown) => unknown) =>
      Promise.resolve(resolver(e)).then(res, rej),
  });
  return b;
}
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (t: string) => builder(t),
    rpc: (nombre: string, args: Record<string, unknown>) => resolverRpc(nombre, args),
  }),
}));

// ── EL ESCRITOR DOBLADO ────────────────────────────────────────────────────
// `diaMxDe` queda REAL a propósito: agrupar por el día del CHOFER (no por el
// UTC del servidor) es parte de lo que esta suite comprueba en la deduplicación.
const asegurarDiaJornada = vi.fn(async (_t: string, o: string, d: string) =>
  ({ id: `j-${o}-${d}` }) as { id: string } | { error: string });
let resultadoAsiento: 'asentado' | 'ya_estaba' | 'fallo' = 'asentado';
const asentarMarca = vi.fn(async (_m: unknown) => resultadoAsiento);
vi.mock('./repo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./repo')>()),
  asegurarDiaJornada: (t: string, o: string, d: string) => asegurarDiaJornada(t, o, d),
  asentarMarca: (m: unknown) => asentarMarca(m),
}));

import { derivarJornadas, diaEnZona, TOPE_VIAJES_POR_CORRIDA } from './derivar';

/** Mediodía de México del 20-ago-2026: el ancla de toda la suite. */
const AHORA = new Date('2026-08-20T18:00:00Z');
const DIA = '2026-08-20';
const T = 't-1';

function viaje(n: number, operador: string, unidad: string | null, hora = '15:00'): FilaViaje {
  return {
    id: `v-${n}`, tenant_id: T, operador_id: operador, unidad_id: unidad,
    aceptado_en: `${DIA}T${hora}:00.000Z`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  viajes = [];
  errorViajes = null;
  trabajos = new Map();
  secuenciaClaim = 0;
  fallarAckUnaVez = false;
  lotesProcesados = 0;
  alTerminarLote = null;
  posiciones = new Map();
  errorGps = null;
  conAviso = null;
  errorAviso = null;
  resultadoAsiento = 'asentado';
});

describe('diaEnZona — bucket IANA del tenant', () => {
  it('separa Tijuana y Sonora alrededor de medianoche invernal', () => {
    const instante = new Date('2026-01-01T07:30:00.000Z');
    expect(diaEnZona(instante, 'America/Tijuana')).toBe('2025-12-31');
    expect(diaEnZona(instante, 'America/Hermosillo')).toBe('2026-01-01');
  });

  it('aplica la regla IANA de horario estacional, no un offset inventado', () => {
    expect(diaEnZona(new Date('2026-07-01T06:30:00.000Z'), 'America/Tijuana')).toBe('2026-06-30');
    expect(diaEnZona(new Date('2026-07-01T06:30:00.000Z'), 'America/Hermosillo')).toBe('2026-06-30');
  });
});

describe('derivarJornadas — el reloj de la corrida', () => {
  it('con `venceEn` YA VENCIDO no asienta nada y lo cuenta todo como cortado', async () => {
    // La prueba de que el motor CONSULTA el reloj, no solo lo recibe: sin la
    // consulta barrería la lista entera hasta que Vercel lo matara a media
    // escritura, y el latido nunca se escribiría.
    viajes = [viaje(1, 'op-a', 'u-1'), viaje(2, 'op-b', 'u-2'), viaje(3, 'op-c', 'u-3')];
    const r = await derivarJornadas({ ahora: AHORA, venceEn: Date.now() - 1_000 });

    expect(r.revisados).toBe(3);
    expect(r.cortadosPorReloj).toBe(3);
    expect(r.asentados).toBe(0);
    // El corte va ANTES de tocar un par (operador, día), nunca a medias: lo que
    // no alcanzó queda intacto y la corrida siguiente lo encabeza.
    expect(asegurarDiaJornada).not.toHaveBeenCalled();
    expect(asentarMarca).not.toHaveBeenCalled();
  });

  it('con `venceEn` futuro no corta nada y sí asienta', async () => {
    viajes = [viaje(1, 'op-a', 'u-1')];
    posiciones.set(`u-1|${DIA}`, [`${DIA}T14:00:00.000Z`, `${DIA}T23:00:00.000Z`]);
    const r = await derivarJornadas({ ahora: AHORA, venceEn: Date.now() + 60_000 });

    expect(r.cortadosPorReloj).toBe(0);
    // Tres marcas: el inicio derivado del hito de aceptación, y las dos puntas
    // del GPS de la unidad.
    expect(r.asentados).toBe(3);
    expect(r.fallos).toEqual([]);
  });

  it('si el reloj vence después del primer RPC no arranca un segundo lote y libera el resto', async () => {
    viajes = Array.from({ length: 101 }, (_, i) => viaje(i, `op-${i}`, null));
    let reloj = 0;
    const ahora = vi.spyOn(Date, 'now').mockImplementation(() => reloj);
    alTerminarLote = () => { reloj = 2; };
    try {
      const r = await derivarJornadas({ ahora: AHORA, venceEn: 1 });
      expect(r.revisados).toBe(101);
      expect(r.cortadosPorReloj).toBe(51);
      expect(r.asentados).toBe(50);
      expect(lotesProcesados).toBe(1);
      expect([...trabajos.values()].filter((t) => t.claimToken !== null)).toEqual([]);
    } finally {
      ahora.mockRestore();
    }
  });

  it('sin `venceEn` el motor NO corta — el reloj es del llamador, no del motor', async () => {
    viajes = [viaje(1, 'op-a', null)];
    const r = await derivarJornadas({ ahora: AHORA });
    expect(r.cortadosPorReloj).toBe(0);
    expect(r.asentados).toBe(1);
  });
});

describe('derivarJornadas — la ventana que no cupo', () => {
  it('muchos viajes del MISMO expediente no consumen el tope de pares', async () => {
    viajes = Array.from({ length: TOPE_VIAJES_POR_CORRIDA }, (_, i) => viaje(i, 'op-a', null));
    const r = await derivarJornadas({ ahora: AHORA, venceEn: Date.now() + 60_000 });

    expect(r.listaTruncada).toBe(false);
    expect(r.revisados).toBe(1);
  });

  it('`listaTruncada` declara que quedan más pares, con cursor ya avanzado', async () => {
    viajes = Array.from({ length: TOPE_VIAJES_POR_CORRIDA + 1 }, (_, i) => viaje(i, `op-${i}`, null));
    const r = await derivarJornadas({ ahora: AHORA, venceEn: Date.now() + 60_000 });
    expect(r.listaTruncada).toBe(true);
    expect(r.revisados).toBe(TOPE_VIAJES_POR_CORRIDA);
    expect(logger.warn).toHaveBeenCalledWith('jornada.derivar.lista_truncada', expect.anything());
  });

  it('`listaTruncada` es false cuando la consulta trajo MENOS que el tope', async () => {
    viajes = Array.from({ length: TOPE_VIAJES_POR_CORRIDA - 1 }, (_, i) => viaje(i, `op-${i}`, null));
    const r = await derivarJornadas({ ahora: AHORA, venceEn: Date.now() + 60_000 });
    expect(r.listaTruncada).toBe(false);
  });

  it('1,500 pares más llegadas nuevas convergen sin quedar detrás del top-400', async () => {
    viajes = Array.from({ length: 1_500 }, (_, i) => viaje(i, `op-${i}`, null));
    await derivarJornadas({ ahora: AHORA, venceEn: Date.now() + 60_000 });
    viajes.push(...Array.from({ length: 20 }, (_, i) => viaje(1_500 + i, `op-${1_500 + i}`, null)));

    for (let i = 0; i < 4; i++) {
      await derivarJornadas({ ahora: AHORA, venceEn: Date.now() + 60_000 });
    }

    const operadores = new Set(asegurarDiaJornada.mock.calls.map((c) => String(c[1])));
    expect(operadores.size).toBe(1_520);
  });

  it('consumir sólo el primer batch de 50 converge y libera los 350 no iniciados', async () => {
    // El deadline ahora se consulta por RPC/lote, que es la unidad atómica.
    // Cada corrida procesa 50 y libera cercadamente los otros 350 claims.
    viajes = Array.from({ length: 1_520 }, (_, i) => viaje(i, `op-${i}`, null));
    const reloj = vi.spyOn(Date, 'now');
    try {
      for (let corrida = 0; corrida < 15; corrida++) {
        let consultas = 0;
        reloj.mockImplementation(() => consultas++ < 1 ? 0 : 2);
        await derivarJornadas({ ahora: AHORA, venceEn: 1 });
      }
      const operadores = new Set(asegurarDiaJornada.mock.calls.map((c) => String(c[1])));
      expect(operadores.size).toBe(750);
      for (let corrida = 0; corrida < 16; corrida++) {
        let consultas = 0;
        reloj.mockImplementation(() => consultas++ < 1 ? 0 : 2);
        await derivarJornadas({ ahora: AHORA, venceEn: 1 });
      }
    } finally {
      reloj.mockRestore();
    }

    const operadores = new Set(asegurarDiaJornada.mock.calls.map((c) => String(c[1])));
    expect(operadores.size).toBe(1_520);
  });

  it.each([0, 1, 399, 400, 401, 1_520])('respeta el borde de lote con %i expedientes', async (cantidad) => {
    viajes = Array.from({ length: cantidad }, (_, i) => viaje(i, `op-${i}`, null));
    const r = await derivarJornadas({ ahora: AHORA, venceEn: Date.now() + 60_000 });
    expect(r.revisados).toBe(Math.min(cantidad, TOPE_VIAJES_POR_CORRIDA));
    expect(r.listaTruncada).toBe(cantidad > TOPE_VIAJES_POR_CORRIDA);
  });

  it('una caída durante el ACK conserva el claim y, al vencer el lease, se recupera', async () => {
    viajes = [viaje(1, 'op-a', null)];
    fallarAckUnaVez = true;
    const primera = await derivarJornadas({ ahora: AHORA });
    expect(primera.fallos.some((f) => f.startsWith('ack '))).toBe(true);
    expect(asegurarDiaJornada).toHaveBeenCalledTimes(1);

    expirarLeasesFake();
    const segunda = await derivarJornadas({ ahora: AHORA });
    expect(segunda.fallos).toEqual([]);
    expect(asegurarDiaJornada).toHaveBeenCalledTimes(2);
  });

  it('una caída antes del ACK se anota como fallo y vuelve a ser elegible', async () => {
    viajes = [viaje(1, 'op-a', null)];
    asentarMarca.mockRejectedValueOnce(new Error('proceso muerto'));
    const primera = await derivarJornadas({ ahora: AHORA });
    expect(primera.fallos.some((f) => f.includes('proceso muerto'))).toBe(true);
    const segunda = await derivarJornadas({ ahora: AHORA });
    expect(segunda.asentados).toBe(1);
    expect(asegurarDiaJornada).toHaveBeenCalledTimes(2);
  });

  it('dos workers solapados reclaman conjuntos disjuntos y no dejan hambre', async () => {
    viajes = Array.from({ length: 1_520 }, (_, i) => viaje(i, `op-${i}`, null));
    await Promise.all([derivarJornadas({ ahora: AHORA }), derivarJornadas({ ahora: AHORA })]);
    expect(new Set(asegurarDiaJornada.mock.calls.map((c) => String(c[1]))).size).toBe(800);
    await Promise.all([derivarJornadas({ ahora: AHORA }), derivarJornadas({ ahora: AHORA })]);
    expect(new Set(asegurarDiaJornada.mock.calls.map((c) => String(c[1]))).size).toBe(1_520);
  });
});

describe('derivarJornadas — la lista de trabajo ilegible', () => {
  it('LANZA en vez de devolver ceros: un cero se leería como «no había nada que hacer»', async () => {
    errorViajes = { message: 'la base no contestó' };
    await expect(derivarJornadas({ ahora: AHORA })).rejects.toThrow(/no se pudo leer la lista de trabajo/);
    // Y no toca el expediente de nadie con la base en ese estado.
    expect(asegurarDiaJornada).not.toHaveBeenCalled();
  });
});

describe('derivarJornadas — un expediente por (tenant, operador, día)', () => {
  it('dos viajes del mismo operador el mismo día producen UN solo expediente', async () => {
    viajes = [viaje(1, 'op-a', 'u-1', '13:00'), viaje(2, 'op-a', 'u-1', '20:00')];
    const r = await derivarJornadas({ ahora: AHORA, venceEn: Date.now() + 60_000 });

    expect(r.revisados).toBe(1);
    expect(asegurarDiaJornada).toHaveBeenCalledTimes(1);
    expect(asegurarDiaJornada).toHaveBeenCalledWith(T, 'op-a', DIA);
  });

  it('usa los extremos de TODAS las unidades que el operador manejó ese día', async () => {
    viajes = [viaje(1, 'op-a', 'u-manana', '13:00'), viaje(2, 'op-a', 'u-tarde', '20:00')];
    posiciones.set(`u-manana|${DIA}`, [`${DIA}T14:00:00.000Z`, `${DIA}T16:00:00.000Z`]);
    posiciones.set(`u-tarde|${DIA}`, [`${DIA}T20:00:00.000Z`, `${DIA}T23:00:00.000Z`]);

    await derivarJornadas({ ahora: AHORA, venceEn: Date.now() + 60_000 });

    expect(asentarMarca).toHaveBeenCalledWith(expect.objectContaining({
      tipo: 'fin_jornada',
      momento: new Date(`${DIA}T23:00:00.000Z`),
      unidadId: 'u-tarde',
    }));
  });

  it('reabre el trabajo cuando una posición posterior cambia el watermark del día', async () => {
    viajes = [viaje(1, 'op-a', 'u-1')];
    posiciones.set(`u-1|${DIA}`, [`${DIA}T14:00:00.000Z`, `${DIA}T16:00:00.000Z`]);
    await derivarJornadas({ ahora: AHORA, venceEn: Date.now() + 60_000 });

    posiciones.set(`u-1|${DIA}`, [
      `${DIA}T14:00:00.000Z`, `${DIA}T16:00:00.000Z`, `${DIA}T23:00:00.000Z`,
    ]);
    const segunda = await derivarJornadas({ ahora: AHORA, venceEn: Date.now() + 60_000 });

    expect(segunda.revisados).toBe(1);
    expect(asentarMarca).toHaveBeenCalledWith(expect.objectContaining({
      tipo: 'fin_jornada',
      momento: new Date(`${DIA}T23:00:00.000Z`),
    }));
  });

  it('dos operadores distintos el mismo día son DOS expedientes', async () => {
    viajes = [viaje(1, 'op-a', null), viaje(2, 'op-b', null)];
    const r = await derivarJornadas({ ahora: AHORA, venceEn: Date.now() + 60_000 });
    expect(r.revisados).toBe(2);
    expect(asegurarDiaJornada).toHaveBeenCalledTimes(2);
  });

  it('el expediente que no se pudo abrir es un fallo con nombre, y no detiene a los demás', async () => {
    asegurarDiaJornada.mockResolvedValueOnce({ error: 'se cayó' });
    viajes = [viaje(1, 'op-a', null), viaje(2, 'op-b', null)];
    const r = await derivarJornadas({ ahora: AHORA, venceEn: Date.now() + 60_000 });

    expect(r.fallos).toHaveLength(1);
    expect(r.fallos[0]).toContain('op-a');
    expect(r.asentados).toBe(1);   // el segundo operador sí se derivó
  });
});

describe('derivarJornadas — la marca que ya estaba', () => {
  it('`ya_estaba` cuenta como `yaEstaban`, NUNCA como fallo', async () => {
    // Es el índice único de la 0241 haciendo su trabajo: el operador ya había
    // declarado su marca y la derivada rebota. Contarlo como fallo pondría el
    // cron en rojo justo cuando la precedencia del declarado funcionó.
    resultadoAsiento = 'ya_estaba';
    viajes = [viaje(1, 'op-a', 'u-1')];
    posiciones.set(`u-1|${DIA}`, [`${DIA}T14:00:00.000Z`, `${DIA}T23:00:00.000Z`]);
    const r = await derivarJornadas({ ahora: AHORA, venceEn: Date.now() + 60_000 });

    expect(r.yaEstaban).toBe(3);
    expect(r.asentados).toBe(0);
    expect(r.fallos).toEqual([]);
  });

  it('un `fallo` de escritura sí se cuenta como fallo', async () => {
    resultadoAsiento = 'fallo';
    viajes = [viaje(1, 'op-a', null)];
    const r = await derivarJornadas({ ahora: AHORA, venceEn: Date.now() + 60_000 });
    expect(r.fallos).toHaveLength(1);
    expect(r.yaEstaban).toBe(0);
  });
});

describe('derivarJornadas — el día sin GPS', () => {
  it('unidad asignada y CERO posiciones sube `diasSinGps`, y no inventa una marca', async () => {
    // «No hubo de dónde derivar» no es «no hubo jornada»: se cuenta y se dice.
    viajes = [viaje(1, 'op-a', 'u-1')];
    posiciones = new Map();   // la unidad no reportó una sola posición ese día
    const r = await derivarJornadas({ ahora: AHORA, venceEn: Date.now() + 60_000 });

    expect(r.diasSinGps).toBe(1);
    // Solo la marca del hito de aceptación: del GPS no salió ninguna.
    expect(r.asentados).toBe(1);
    expect(r.fallos).toEqual([]);
  });

  it('varios días sin GPS se suman, uno por par (operador, día)', async () => {
    viajes = [viaje(1, 'op-a', 'u-1'), viaje(2, 'op-b', 'u-2')];
    const r = await derivarJornadas({ ahora: AHORA, venceEn: Date.now() + 60_000 });
    expect(r.diasSinGps).toBe(2);
  });

  it('un viaje SIN unidad no cuenta como día sin GPS: no había unidad que consultar', async () => {
    viajes = [viaje(1, 'op-a', null)];
    const r = await derivarJornadas({ ahora: AHORA, venceEn: Date.now() + 60_000 });
    expect(r.diasSinGps).toBe(0);
    expect(r.asentados).toBe(1);
  });

  it('el GPS ilegible es un fallo con nombre — no se confunde con «no hubo posiciones»', async () => {
    errorGps = { message: 'la base no contestó' };
    viajes = [viaje(1, 'op-a', 'u-1')];
    const r = await derivarJornadas({ ahora: AHORA, venceEn: Date.now() + 60_000 });

    expect(r.diasSinGps).toBe(0);
    expect(r.fallos).toHaveLength(1);
    expect(r.fallos[0]).toContain('gps u-1');
  });

  it('una sola posición en el día da inicio y NO un fin igual al inicio', async () => {
    // Un fin idéntico al inicio se leería como una jornada de cero minutos —
    // una afirmación sobre la jornada del trabajador que nadie hizo.
    viajes = [viaje(1, 'op-a', 'u-1')];
    posiciones.set(`u-1|${DIA}`, [`${DIA}T14:00:00.000Z`]);
    const r = await derivarJornadas({ ahora: AHORA, venceEn: Date.now() + 60_000 });

    expect(r.asentados).toBe(2);   // hito + primera posición, sin fin
    const tipos = asentarMarca.mock.calls.map((c) => (c[0] as { tipo: string }).tipo);
    expect(tipos).not.toContain('fin_jornada');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 22 · LEG-C1 (CRÍTICO) — no se trata antes de avisar.
//
// `ponerAvisoADisposicion` cuelga del camino del MENSAJE ENTRANTE. Un chofer
// que recibe sus viajes por radio puede no escribir nunca: su
// `operador.aviso_privacidad_en` se queda en NULL mientras este cron le
// construye un expediente laboral —horas, banderas del art. 61 y del 68— que él
// nunca supo que existía. El art. 16 de la LFPDPPP obliga a poner el aviso a
// disposición ANTES del tratamiento, y el propio `privacidad.ts` ya escribe ese
// principio: «esperar a que haya filas sería avisar después de tratar».
// ═══════════════════════════════════════════════════════════════════════════
describe('LEG-C1: sin aviso previo no se deriva expediente laboral', () => {
  it('el operador que nunca recibió el aviso no obtiene expediente ni marcas', async () => {
    viajes = [viaje(1, 'op-sin-aviso', 'u-1')];
    posiciones.set(`u-1|${DIA}`, [`${DIA}T14:00:00.000Z`, `${DIA}T23:00:00.000Z`]);
    conAviso = new Set();   // nadie tiene aviso

    const r = await derivarJornadas({ ahora: AHORA });

    expect(r.sinAvisoPrevio).toBe(1);
    expect(r.asentados).toBe(0);
    // Ni siquiera se abre el expediente: crearlo ya es tratamiento.
    expect(asegurarDiaJornada).not.toHaveBeenCalled();
    expect(asentarMarca).not.toHaveBeenCalled();
  });

  it('el que sí lo recibió se deriva normal, en la misma corrida', async () => {
    viajes = [viaje(1, 'op-con', 'u-1'), viaje(2, 'op-sin', 'u-2')];
    conAviso = new Set(['op-con']);

    const r = await derivarJornadas({ ahora: AHORA });

    expect(r.sinAvisoPrevio).toBe(1);
    expect(asegurarDiaJornada).toHaveBeenCalledTimes(1);
    expect(asegurarDiaJornada).toHaveBeenCalledWith(T, 'op-con', DIA);
  });

  // Fallar cerrado en los dos bordes: un error de red no puede volverse permiso
  // para construirle a alguien un expediente laboral sin haberle avisado.
  it('si la lectura del aviso falla, NO se deriva', async () => {
    viajes = [viaje(1, 'op-1', 'u-1')];
    errorAviso = { message: 'PostgREST 500' };

    const r = await derivarJornadas({ ahora: AHORA });

    expect(r.sinAvisoPrevio).toBe(1);
    expect(asegurarDiaJornada).not.toHaveBeenCalled();
    // AUDITORÍA 24, LEG-1: la compuerta se extrajo a `privacidad.ts` para que
    // el poller de GPS y el de cámara pasen por la MISMA pregunta, así que el
    // evento ya no lleva prefijo de jornada — lo comparten los tres.
    expect(logger.error).toHaveBeenCalledWith('privacidad.aviso_previo_ilegible', expect.anything());
  });
});
