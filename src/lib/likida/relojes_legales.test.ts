import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// FASE 6 — LOS RELOJES LEGALES. Lo que estas pruebas fijan:
//
//   1. Los TEXTOS legales dicen el paso en el ORDEN correcto (la sustitución
//      de CFDI al revés deja a la flota sin comprobante) y NUNCA incluyen un
//      teléfono sin verificar — un número equivocado en una emergencia es
//      peor que ninguno.
//   2. El clasificador de umbrales (30/7/0) es determinista y el vencido no
//      spamea: umbral 0 una vez, no un aviso diario a perpetuidad.
//   3. Los barridos avisan UNA vez (el sello después de mandar, nunca antes)
//      y un envío fallido se reintenta en la siguiente corrida.
// ═══════════════════════════════════════════════════════════════════════════

const sendText = vi.hoisted(() => vi.fn(async () => 'wamid.OK'));
const telefonoJefeDe = vi.hoisted(() => vi.fn(async () => '5210000000001'));
const telefonoParaDineroDe = vi.hoisted(() => vi.fn(async () => '5210000000002'));
const anotarEventoIncidencia = vi.hoisted(() => vi.fn(async () => 'anotado' as const));
const tablas = vi.hoisted(() => ({
  respuestas: new Map<string, unknown[]>(),
  errores: new Map<string, { message: string }>(),
  upserts: [] as Array<{ tabla: string; filas: unknown }>,
  llamadas: [] as Array<{ tabla: string; metodo: string; args: unknown[] }>,
}));

vi.mock('@/lib/meta/client', () => ({
  MAX_CUERPO_BOTONES: 1024, sendText }));
vi.mock('./contactos', () => ({ telefonoJefeDe, telefonoParaDineroDe }));
vi.mock('./asistencia_wa', () => ({ anotarEventoIncidencia }));
vi.mock('./presupuesto', () => ({ acotada: (q: unknown) => q }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      // Builder encadenable que resuelve con la respuesta preparada para esa
      // tabla. `thenable` para que el await funcione en cualquier punto de la
      // cadena — el módulo encadena select/eq/in/gte/neq/lte/or/limit/order/
      // range/maybeSingle. `range` REBANA (traerTodo pagina de verdad — c2-4)
      // y cada método queda registrado en `llamadas` para poder asegurar los
      // filtros de fecha (c2-7) sin fingir un PostgREST completo.
      let rango: [number, number] | null = null;
      // AUDITORÍA 24 (BE-10/BE-31): `limit` también RECORTA, como PostgREST.
      // Sin esto el mock devolvía las 600 unidades aunque el módulo pidiera
      // 500, y la prueba del recorte mudo no podía ponerse en rojo.
      let tope: number | null = null;
      const respuesta = () => {
        const todos = tablas.respuestas.get(tabla) ?? [];
        if (rango === null) return { data: tope === null ? todos : todos.slice(0, tope), error: null };
        return { data: todos.slice(rango[0], rango[1] + 1), error: null, count: todos.length };
      };
      const api: Record<string, unknown> = {
        upsert: (filas: unknown) => { tablas.upserts.push({ tabla, filas }); return Promise.resolve({ error: null }); },
        maybeSingle: () => Promise.resolve(
          tablas.errores.has(tabla)
            ? { data: null, error: tablas.errores.get(tabla) }
            : { data: (tablas.respuestas.get(tabla) ?? [])[0] ?? null, error: null },
        ),
        range: (d: number, h: number) => { rango = [d, h]; return api; },
        limit: (n: number) => { tope = n; tablas.llamadas.push({ tabla, metodo: 'limit', args: [n] }); return api; },
        then: (res: (v: unknown) => unknown) => Promise.resolve(respuesta()).then(res),
      };
      for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'neq', 'or', 'not', 'order']) {
        api[m] = (...args: unknown[]) => { tablas.llamadas.push({ tabla, metodo: m, args }); return api; };
      }
      return api;
    },
  }),
}));

const mod = await import('./relojes_legales');
const {
  AVISO_VALOR_MERCANCIA, mensajeSustitucionCfdi, mensajeRelojesMatpel, mensajeMultasReten,
  umbralCruzado, diasEntreIso, avisarVencimientos, avisarRelojesLegales,
} = mod;

beforeEach(() => {
  tablas.respuestas.clear();
  tablas.errores.clear();
  tablas.upserts.length = 0;
  tablas.llamadas.length = 0;
  sendText.mockClear();
  sendText.mockResolvedValue('wamid.OK');
  telefonoJefeDe.mockClear();
  telefonoJefeDe.mockResolvedValue('5210000000001');
  telefonoParaDineroDe.mockClear();
  anotarEventoIncidencia.mockClear();
});

describe('los textos legales', () => {
  it('la sustitución de CFDI dice TipoRelacion 04 ANTES que la cancelación motivo 01', () => {
    const m = mensajeSustitucionCfdi('V-123', 'F-9');
    expect(m.indexOf('TipoRelacion 04')).toBeGreaterThan(-1);
    expect(m.indexOf('motivo 01')).toBeGreaterThan(-1);
    // El ORDEN es la regla: cancelar primero rompe la relación.
    expect(m.indexOf('TipoRelacion 04')).toBeLessThan(m.indexOf('motivo 01'));
    expect(m).toContain('Likida no timbra ni cancela');
  });

  it('matpel trae los tres relojes con su plazo y SOLO teléfonos verificados', () => {
    const m = mensajeRelojesMatpel('V-123');
    expect(m).toMatch(/3 días hábiles/);
    expect(m).toMatch(/6 h/);
    expect(m).toMatch(/10 días naturales/);
    expect(m).toContain('800 002 1400');   // SETIQ, triple fuente
    expect(m).toContain('55 5128 0000');   // CENACOM
  });

  it('NINGÚN texto incluye los teléfonos sin verificar (088, 078, 800 de PROFEPA)', () => {
    // Un teléfono equivocado en una emergencia es peor que ninguno. Los tres
    // del plan quedaron explícitamente FUERA hasta confirmarse por teléfono.
    const todos = [
      AVISO_VALOR_MERCANCIA.cuerpo,
      mensajeSustitucionCfdi('V', 'F'),
      mensajeRelojesMatpel('V'),
      mensajeMultasReten('V'),
    ].join(' ');
    expect(todos).not.toMatch(/\b088\b/);
    expect(todos).not.toMatch(/\b078\b/);
    expect(todos).not.toMatch(/PROFEPA[^.]*\b800\b/);
  });

  it('el aviso de ValorMercancia dice la cifra y confiesa que no hay ficha verificada', () => {
    expect(AVISO_VALOR_MERCANCIA.cuerpo).toContain('$1,759.65');
    expect(AVISO_VALOR_MERCANCIA.fundamento).toMatch(/sin ficha verificada/);
  });

  it('las multas dicen los dos descuentos y el art. 76', () => {
    const m = mensajeMultasReten(null);
    expect(m).toMatch(/−25%.*−25%/s);
    expect(m).toMatch(/15 días hábiles/);
    expect(m).toMatch(/art\. 76/i);
    expect(m).toMatch(/revocar el permiso/);
  });
});

describe('umbralCruzado — el clasificador de 30/7/0', () => {
  it('clasifica cada franja y el lejano no avisa', () => {
    expect(umbralCruzado(45)).toBeNull();
    expect(umbralCruzado(30)).toBe(30);
    expect(umbralCruzado(15)).toBe(30);
    expect(umbralCruzado(7)).toBe(7);
    expect(umbralCruzado(3)).toBe(7);
    expect(umbralCruzado(0)).toBe(0);
  });

  it('vencido hace días sigue siendo umbral 0 — un aviso, no spam diario', () => {
    expect(umbralCruzado(-1)).toBe(0);
    expect(umbralCruzado(-90)).toBe(0);
  });

  it('diasEntreIso no se corre por husos', () => {
    expect(diasEntreIso('2026-08-26', '2026-09-02')).toBe(7);
    expect(diasEntreIso('2026-08-26', '2026-08-26')).toBe(0);
    expect(diasEntreIso('2026-08-26', '2026-08-20')).toBe(-6);
  });
});

describe('avisarVencimientos — un aviso por umbral, sellado después de mandar', () => {
  const AHORA = new Date('2026-08-26T18:00:00Z'); // hoyMx = 2026-08-26

  it('agrupa los vencimientos de una flota en UN mensaje y sella tras mandar', async () => {
    tablas.respuestas.set('unidad', [
      { id: 'u1', tenant_id: 't1', numero_economico: 'C2-08', poliza_vence: '2026-09-01', permiso_sict_vence: null, verificacion_vence: '2026-08-20' },
    ]);
    tablas.respuestas.set('operador', [
      { id: 'o1', tenant_id: 't1', nombre: 'Juan', licencia_vence: '2026-08-30' },
    ]);
    tablas.respuestas.set('flota_poliza', []);
    tablas.respuestas.set('aviso_vigencia', []);

    const r = await avisarVencimientos(AHORA);
    expect(r.candidatos).toBe(3);
    expect(r.avisados).toBe(3);
    expect(sendText).toHaveBeenCalledTimes(1); // UNA lista, no tres WhatsApps
    const texto = (sendText.mock.calls[0] as unknown as [string, string])[1];
    expect(texto).toContain('C2-08');
    expect(texto).toContain('VENCIÓ');       // la verificación del 20-ago ya venció
    expect(texto).toContain('Juan');
    // El sello, con umbral y fecha en la llave.
    expect(tablas.upserts.filter((u) => u.tabla === 'aviso_vigencia')).toHaveLength(1);
  });

  it('lo ya sellado NO se re-avisa', async () => {
    tablas.respuestas.set('unidad', [
      { id: 'u1', tenant_id: 't1', numero_economico: 'C2-08', poliza_vence: '2026-09-01', permiso_sict_vence: null, verificacion_vence: null },
    ]);
    tablas.respuestas.set('operador', []);
    tablas.respuestas.set('flota_poliza', []);
    tablas.respuestas.set('aviso_vigencia', [
      { tenant_id: 't1', objeto: 'unidad', objeto_id: 'u1', documento: 'poliza', umbral: 7, vence: '2026-09-01' },
    ]);

    const r = await avisarVencimientos(AHORA);
    expect(r.avisados).toBe(0);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('si el WhatsApp NO sale, no se sella — la siguiente corrida reintenta', async () => {
    sendText.mockResolvedValueOnce(null as never);
    tablas.respuestas.set('unidad', [
      { id: 'u1', tenant_id: 't1', numero_economico: 'C2-08', poliza_vence: '2026-09-01', permiso_sict_vence: null, verificacion_vence: null },
    ]);
    tablas.respuestas.set('operador', []);
    tablas.respuestas.set('flota_poliza', []);
    tablas.respuestas.set('aviso_vigencia', []);

    const r = await avisarVencimientos(AHORA);
    expect(r.avisados).toBe(0);
    expect(r.fallos).toBe(1);
    expect(tablas.upserts.filter((u) => u.tabla === 'aviso_vigencia')).toHaveLength(0);
  });

  it('sin teléfono de jefe no se manda a nadie — y cuenta como fallo visible', async () => {
    telefonoJefeDe.mockResolvedValueOnce(null as never);
    tablas.respuestas.set('unidad', [
      { id: 'u1', tenant_id: 't1', numero_economico: 'C2-08', poliza_vence: '2026-09-01', permiso_sict_vence: null, verificacion_vence: null },
    ]);
    tablas.respuestas.set('operador', []);
    tablas.respuestas.set('flota_poliza', []);
    tablas.respuestas.set('aviso_vigencia', []);

    const r = await avisarVencimientos(AHORA);
    expect(r.fallos).toBe(1);
    expect(sendText).not.toHaveBeenCalled();
  });

  // ── AUDITORÍA FABLE CICLO 2 ────────────────────────────────────────────────

  it('c2-4: los sellos se leen COMPLETOS aunque pasen de mil — el sello 1,400 sigue tapando su aviso', async () => {
    // Un select plano PostgREST lo recorta a 1,000 filas en silencio y el
    // vencimiento ya avisado se re-avisaría cada hora. Con traerTodo el mock
    // pagina de verdad (range rebana): el sello en la posición ~1,400 se lee.
    const relleno = Array.from({ length: 1400 }, (_, i) => ({
      tenant_id: 't1', objeto: 'unidad', objeto_id: `relleno-${i}`, documento: 'poliza', umbral: 30, vence: '2026-09-01',
    }));
    tablas.respuestas.set('unidad', [
      { id: 'u1', tenant_id: 't1', numero_economico: 'C2-08', poliza_vence: '2026-09-01', permiso_sict_vence: null, verificacion_vence: null },
    ]);
    tablas.respuestas.set('operador', []);
    tablas.respuestas.set('flota_poliza', []);
    tablas.respuestas.set('aviso_vigencia', [
      ...relleno,
      { tenant_id: 't1', objeto: 'unidad', objeto_id: 'u1', documento: 'poliza', umbral: 7, vence: '2026-09-01' },
    ]);

    const r = await avisarVencimientos(AHORA);
    expect(r.avisados).toBe(0);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('c2-7: las consultas de vencimientos llevan PISO de fecha — lo vencido hace años no come el corte de 500', async () => {
    tablas.respuestas.set('unidad', []);
    tablas.respuestas.set('operador', []);
    tablas.respuestas.set('flota_poliza', []);
    tablas.respuestas.set('aviso_vigencia', []);

    await avisarVencimientos(AHORA); // hoyMx = 2026-08-26 → piso = 2025-08-25
    const gteOperador = tablas.llamadas.find((l) => l.tabla === 'operador' && l.metodo === 'gte');
    expect(gteOperador?.args).toEqual(['licencia_vence', '2025-08-25']);
    const gtePoliza = tablas.llamadas.find((l) => l.tabla === 'flota_poliza' && l.metodo === 'gte');
    expect(gtePoliza?.args).toEqual(['vigencia_hasta', '2025-08-25']);
    // La de unidades va en el `or` (tres columnas): cada rama con su piso.
    const orUnidad = tablas.llamadas.find((l) => l.tabla === 'unidad' && l.metodo === 'or');
    expect(String(orUnidad?.args[0])).toContain('poliza_vence.gte.2025-08-25');
    expect(String(orUnidad?.args[0])).toContain('permiso_sict_vence.gte.2025-08-25');
    expect(String(orUnidad?.args[0])).toContain('verificacion_vence.gte.2025-08-25');
  });

  // ── AUDITORÍA 24 ──────────────────────────────────────────────────────────

  it('BE-10: a 600 unidades, la póliza a 7 días en la posición 550 SÍ entra a candidatos — la lectura no se recorta a 500', async () => {
    // 549 unidades cuya única fecha en ventana ya venció hace meses (umbral 0,
    // ya sellado), y en la posición 550 ECO-114 con la póliza a 7 días. Con
    // `limit(500)` sin `order` ECO-114 no volvía y el latido salía `ok`.
    const relleno = Array.from({ length: 549 }, (_, i) => ({
      id: `u-${i}`, tenant_id: 't1', numero_economico: `R-${i}`,
      poliza_vence: '2026-03-01', permiso_sict_vence: null, verificacion_vence: null,
    }));
    tablas.respuestas.set('unidad', [
      ...relleno,
      { id: 'eco-114', tenant_id: 't1', numero_economico: 'ECO-114', poliza_vence: '2026-09-02', permiso_sict_vence: null, verificacion_vence: null },
      ...Array.from({ length: 50 }, (_, i) => ({
        id: `v-${i}`, tenant_id: 't1', numero_economico: `V-${i}`,
        poliza_vence: '2026-03-01', permiso_sict_vence: null, verificacion_vence: null,
      })),
    ]);
    tablas.respuestas.set('operador', []);
    tablas.respuestas.set('flota_poliza', []);
    // Todos los vencidos ya se avisaron en su momento (sello umbral 0).
    tablas.respuestas.set('aviso_vigencia', [...relleno.map((u) => ({
      tenant_id: 't1', objeto: 'unidad', objeto_id: u.id, documento: 'poliza', umbral: 0, vence: '2026-03-01',
    })), ...Array.from({ length: 50 }, (_, i) => ({
      tenant_id: 't1', objeto: 'unidad', objeto_id: `v-${i}`, documento: 'poliza', umbral: 0, vence: '2026-03-01',
    }))]);

    const r = await avisarVencimientos(AHORA);
    expect(r.candidatos).toBe(600);
    expect(r.avisados).toBe(1);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect((sendText.mock.calls[0] as unknown as [string, string])[1]).toContain('ECO-114');
    // Y las tres lecturas van paginadas con orden único, no topadas a 500.
    expect(tablas.llamadas.some((l) => l.tabla === 'unidad' && l.metodo === 'limit')).toBe(false);
    for (const tabla of ['unidad', 'operador', 'flota_poliza']) {
      expect(tablas.llamadas.some((l) => l.tabla === tabla && l.metodo === 'order' && l.args[0] === 'id')).toBe(true);
    }
  });

  it('BE-7: con el reloj vencido no se manda ni se sella — se cuenta como cortado', async () => {
    tablas.respuestas.set('unidad', [
      { id: 'u1', tenant_id: 't1', numero_economico: 'C2-08', poliza_vence: '2026-09-01', permiso_sict_vence: null, verificacion_vence: null },
    ]);
    tablas.respuestas.set('operador', [{ id: 'o1', tenant_id: 't2', nombre: 'Juan', licencia_vence: '2026-08-30' }]);
    tablas.respuestas.set('flota_poliza', []);
    tablas.respuestas.set('aviso_vigencia', []);

    const r = await avisarVencimientos(AHORA, { venceEn: Date.now() - 1 });
    expect(r.candidatos).toBe(2);
    expect(r.avisados).toBe(0);
    expect(r.cortadosPorReloj).toBe(2);
    expect(sendText).not.toHaveBeenCalled();
    expect(tablas.upserts).toHaveLength(0);
  });

  it('BE-7: sin reloj (la Mac, esta suite) el barrido corre hasta el final', async () => {
    tablas.respuestas.set('unidad', [
      { id: 'u1', tenant_id: 't1', numero_economico: 'C2-08', poliza_vence: '2026-09-01', permiso_sict_vence: null, verificacion_vence: null },
    ]);
    tablas.respuestas.set('operador', []);
    tablas.respuestas.set('flota_poliza', []);
    tablas.respuestas.set('aviso_vigencia', []);
    const r = await avisarVencimientos(AHORA, { venceEn: Date.now() + 60_000 });
    expect(r.avisados).toBe(1);
    expect(r.cortadosPorReloj).toBe(0);
  });
});

describe('avisarRelojesLegales — los relojes colgados de una incidencia', () => {
  const inc = (tipo: string, sobre: Partial<Record<string, unknown>> = {}) => ({
    id: 'i1', tenant_id: 't1', tipo, viaje_id: 'v1', ...sobre,
  });

  it('siniestro con factura timbrada → sustitución al canal de DINERO, y sella', async () => {
    tablas.respuestas.set('incidencia', [inc('siniestro')]);
    tablas.respuestas.set('incidencia_evento', []);
    tablas.respuestas.set('viaje', [{ folio: 'V-9' }]);
    tablas.respuestas.set('factura_emitida', [{ folio: 'F-1', cfdi_uuid: 'uuid-1' }]);
    tablas.respuestas.set('tenant', [{ perfil: {} }]); // sin hazmat declarado

    const r = await avisarRelojesLegales(new Date('2026-08-26T18:00:00Z'));
    expect(r.avisadas).toBe(1);
    expect(telefonoParaDineroDe).toHaveBeenCalledWith('t1');
    const texto = (sendText.mock.calls[0] as unknown as [string, string])[1];
    expect(texto).toContain('TipoRelacion 04');
    expect(anotarEventoIncidencia).toHaveBeenCalledWith('t1', 'i1', 'reloj_legal_avisado', expect.anything());
  });

  it('siniestro SIN factura y SIN hazmat: nada que avisar — sella con la razón, sin WhatsApp', async () => {
    tablas.respuestas.set('incidencia', [inc('siniestro')]);
    tablas.respuestas.set('incidencia_evento', []);
    tablas.respuestas.set('viaje', [{ folio: 'V-9' }]);
    tablas.respuestas.set('factura_emitida', []);
    tablas.respuestas.set('factura_viaje', []);
    tablas.respuestas.set('tenant', [{ perfil: {} }]);

    const r = await avisarRelojesLegales(new Date('2026-08-26T18:00:00Z'));
    expect(r.avisadas).toBe(0);
    expect(sendText).not.toHaveBeenCalled();
    expect(anotarEventoIncidencia).toHaveBeenCalledWith('t1', 'i1', 'reloj_legal_avisado', { aviso: 'sin_relojes_aplicables' });
  });

  it('ALT-176 (auditoría 25, REINCIDENTE): un blip leyendo el perfil NO sella "sin_relojes_aplicables" — cuenta como fallo y reintenta', async () => {
    tablas.respuestas.set('incidencia', [inc('siniestro')]);
    tablas.respuestas.set('incidencia_evento', []);
    tablas.respuestas.set('viaje', [{ folio: 'V-9' }]);
    tablas.respuestas.set('factura_emitida', []);
    tablas.respuestas.set('factura_viaje', []);
    tablas.errores.set('tenant', { message: 'fetch failed' });

    const r = await avisarRelojesLegales(new Date('2026-08-26T18:00:00Z'));
    expect(r.avisadas).toBe(0);
    expect(r.fallos).toBe(1);
    expect(sendText).not.toHaveBeenCalled();
    // NO debe sellar: si sella, la próxima corrida lo descarta por el
    // anti-join y el aviso real (si hazmat era `true`) nunca sale.
    expect(anotarEventoIncidencia).not.toHaveBeenCalled();
  });

  it('la flota que declaró hazmat recibe los relojes matpel por el canal del JEFE', async () => {
    tablas.respuestas.set('incidencia', [inc('siniestro')]);
    tablas.respuestas.set('incidencia_evento', []);
    tablas.respuestas.set('viaje', [{ folio: 'V-9' }]);
    tablas.respuestas.set('factura_emitida', []);
    tablas.respuestas.set('factura_viaje', []);
    // El perfil con procedencia declarada — la forma real de un CampoPerfil.
    tablas.respuestas.set('tenant', [{ perfil: { hazmat: { valor: true, procedencia: 'declarado' } } }]);

    const r = await avisarRelojesLegales(new Date('2026-08-26T18:00:00Z'));
    expect(r.avisadas).toBe(1);
    expect(telefonoJefeDe).toHaveBeenCalledWith('t1');
    const texto = (sendText.mock.calls[0] as unknown as [string, string])[1];
    expect(texto).toContain('800 002 1400');
  });

  it('bloqueo/retén → la información de multas al jefe', async () => {
    tablas.respuestas.set('incidencia', [inc('bloqueo')]);
    tablas.respuestas.set('incidencia_evento', []);
    tablas.respuestas.set('viaje', [{ folio: 'V-9' }]);

    const r = await avisarRelojesLegales(new Date('2026-08-26T18:00:00Z'));
    expect(r.avisadas).toBe(1);
    const texto = (sendText.mock.calls[0] as unknown as [string, string])[1];
    expect(texto).toMatch(/art\. 76/i);
  });

  // AUDITORÍA 28 (REN-M4): con dinero+operación aplicables y UN canal fallido,
  // el sello antes era un booleano único — con que UNO saliera se sellaba la
  // incidencia ENTERA y el canal caído no se reintentaba jamás. El sello va
  // POR CANAL: solo el que falló se reintenta en la siguiente corrida.
  it('REN-M4: dinero falla y operación sale — solo dinero se reintenta en la siguiente corrida', async () => {
    tablas.respuestas.set('incidencia', [inc('siniestro')]);
    tablas.respuestas.set('incidencia_evento', []);
    tablas.respuestas.set('viaje', [{ folio: 'V-9' }]);
    tablas.respuestas.set('factura_emitida', [{ folio: 'F-1', cfdi_uuid: 'uuid-1' }]);
    tablas.respuestas.set('tenant', [{ perfil: { hazmat: { valor: true, procedencia: 'declarado' } } }]);
    sendText.mockResolvedValueOnce(null as never); // el canal de DINERO falla

    const r1 = await avisarRelojesLegales(new Date('2026-08-26T18:00:00Z'));
    expect(r1.avisadas).toBe(1); // operación sí salió: hubo algo nuevo
    expect(telefonoParaDineroDe).toHaveBeenCalledWith('t1');
    expect(telefonoJefeDe).toHaveBeenCalledWith('t1');
    expect(anotarEventoIncidencia).toHaveBeenCalledWith('t1', 'i1', 'reloj_legal_avisado', { dinero: false, operacion: true });

    // La siguiente corrida: el sello parcial de la anterior ya está en la
    // bitácora — solo dinero debe reintentarse.
    vi.clearAllMocks();
    sendText.mockResolvedValue('wamid.OK');
    telefonoJefeDe.mockResolvedValue('5210000000001');
    tablas.respuestas.set('incidencia_evento', [
      { id: 'e1', incidencia_id: 'i1', tenant_id: 't1', detalle: { dinero: false, operacion: true } },
    ]);

    const r2 = await avisarRelojesLegales(new Date('2026-08-26T19:00:00Z'));
    expect(r2.avisadas).toBe(1);
    expect(telefonoParaDineroDe).toHaveBeenCalledWith('t1'); // dinero SÍ se reintenta
    expect(telefonoJefeDe).not.toHaveBeenCalled();            // operación NO se repite: ya salió
    expect(anotarEventoIncidencia).toHaveBeenCalledWith('t1', 'i1', 'reloj_legal_avisado', { dinero: true, operacion: true });
  });

  it('una incidencia ya sellada no vuelve a avisar', async () => {
    tablas.respuestas.set('incidencia', [inc('bloqueo')]);
    tablas.respuestas.set('incidencia_evento', [{ id: 'e1', incidencia_id: 'i1', tenant_id: 't1' }]); // el sello existe

    const r = await avisarRelojesLegales(new Date('2026-08-26T18:00:00Z'));
    expect(r.avisadas).toBe(0);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('si el aviso no llega a nadie, NO se sella — reintento en la siguiente corrida', async () => {
    sendText.mockResolvedValue(null as never);
    tablas.respuestas.set('incidencia', [inc('bloqueo')]);
    tablas.respuestas.set('incidencia_evento', []);
    tablas.respuestas.set('viaje', [{ folio: 'V-9' }]);

    const r = await avisarRelojesLegales(new Date('2026-08-26T18:00:00Z'));
    expect(r.avisadas).toBe(0);
    expect(anotarEventoIncidencia).not.toHaveBeenCalled();
  });

  // ── AUDITORÍA 24 ──────────────────────────────────────────────────────────

  it('BE-31: 130 incidencias en 72 h con 100 ya selladas — las 30 nuevas se revisan y avisan', async () => {
    // Con `limit(100)` sin `order` y el sello comprobado una por una, las 100
    // selladas gastaban las ranuras y las 30 nuevas salían de la ventana en
    // tres días sin aviso, con `revisadas = 100` y latido `ok`.
    const selladas = Array.from({ length: 100 }, (_, i) => inc('bloqueo', { id: `s-${i}` }));
    const nuevas = Array.from({ length: 30 }, (_, i) => inc('bloqueo', { id: `n-${i}` }));
    tablas.respuestas.set('incidencia', [...selladas, ...nuevas]);
    // El sello trae SU flota: el anti-join casa por el par (flota, incidencia).
    tablas.respuestas.set('incidencia_evento', selladas.map((s) => ({ id: `e-${s.id}`, incidencia_id: s.id, tenant_id: s.tenant_id })));
    tablas.respuestas.set('viaje', [{ folio: 'V-9' }]);

    const r = await avisarRelojesLegales(new Date('2026-08-26T18:00:00Z'));
    expect(r.revisadas).toBe(30);
    expect(r.avisadas).toBe(30);
    expect(sendText).toHaveBeenCalledTimes(30);
    // La lectura va paginada con orden único, no topada a 100.
    expect(tablas.llamadas.some((l) => l.tabla === 'incidencia' && l.metodo === 'limit')).toBe(false);
    expect(tablas.llamadas.some((l) => l.tabla === 'incidencia' && l.metodo === 'order' && l.args[0] === 'abierta_en')).toBe(true);
  });

  it('BE-31: el sello de OTRA flota no descuenta a la incidencia homónima de la mía', async () => {
    tablas.respuestas.set('incidencia', [inc('bloqueo', { id: 'i-9', tenant_id: 't1' })]);
    tablas.respuestas.set('incidencia_evento', [{ id: 'e-1', incidencia_id: 'i-9', tenant_id: 't-otra' }]);
    tablas.respuestas.set('viaje', [{ folio: 'V-9' }]);

    const r = await avisarRelojesLegales(new Date('2026-08-26T18:00:00Z'));

    expect(r.revisadas).toBe(1);
    expect(r.avisadas).toBe(1);
  });

  it('BE-7: con el reloj vencido ninguna incidencia se avisa ni se sella, y se cuentan las cortadas', async () => {
    tablas.respuestas.set('incidencia', [inc('bloqueo', { id: 'a' }), inc('bloqueo', { id: 'b' })]);
    tablas.respuestas.set('incidencia_evento', []);
    tablas.respuestas.set('viaje', [{ folio: 'V-9' }]);

    const r = await avisarRelojesLegales(new Date('2026-08-26T18:00:00Z'), { venceEn: Date.now() - 1 });
    expect(r.revisadas).toBe(2);
    expect(r.avisadas).toBe(0);
    expect(r.cortadasPorReloj).toBe(2);
    expect(sendText).not.toHaveBeenCalled();
    expect(anotarEventoIncidencia).not.toHaveBeenCalled();
  });
});
