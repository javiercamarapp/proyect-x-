import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// La coordinación con el proveedor (Capa D, 0213). Lo que estas pruebas
// fijan son los CANDADOS del circuito:
//
//   · sin autorización del jefe, Likida no le escribe a nadie — y el rol que
//     no coordina recibe la verdad, no una acción;
//   · SOLO proveedores verificados del directorio; al "SIN confirmar" le
//     marca el jefe;
//   · en robo/violencia no se coordina nada (el protocolo mudo manda);
//   · la ventana cerrada de Meta deja el estado honesto (pendiente_plantilla)
//     con el mensaje LISTO para que el jefe lo reenvíe él;
//   · el ETA y el precio son LOS QUE DIJO el proveedor, leídos sin
//     ambigüedad o NULL — jamás adivinados;
//   · confirmar/descartar es firma atómica: un ganador, y el segundo tap
//     recibe la verdad.
// ═══════════════════════════════════════════════════════════════════════════

type Resp = { data?: unknown; error?: { message: string } | null };
let respuestas: Record<string, Resp>;
let escrituras: Array<{ clave: string; payload: unknown }>;

function claveDe(tabla: string, verbo: string, selectArg: string | null): string {
  if (verbo === 'update') return `${tabla}.claim`;
  if (verbo === 'insert') return `${tabla}.insert`;
  return `${tabla}.select:${selectArg ?? ''}`;
}

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      let verbo = 'select';
      let selectArg: string | null = null;
      let payload: unknown = null;
      const responder = (): Resp => {
        const clave = claveDe(tabla, verbo, selectArg);
        if (verbo !== 'select') escrituras.push({ clave, payload });
        const r = respuestas[clave];
        if (!r) throw new Error(`sin respuesta preparada para ${clave}`);
        return r;
      };
      const b = {
        select: (arg: string) => { if (verbo === 'select') selectArg = arg; return b; },
        update: (fila: unknown) => { verbo = 'update'; payload = fila; return b; },
        insert: (fila: unknown) => { verbo = 'insert'; payload = fila; return b; },
        eq: () => b, in: () => b, neq: () => b, is: () => b,
        order: () => b, limit: () => b,
        maybeSingle: async () => responder(),
        single: async () => responder(),
        then: (res: (r: Resp) => unknown, rej: (e: unknown) => unknown) => {
          try { return Promise.resolve(responder()).then(res, rej); } catch (e) { return Promise.reject(e).catch(rej); }
        },
      };
      return b;
    },
  }),
}));
vi.mock('./presupuesto', async (orig) => ({
  ...(await orig() as object),
  acotada: (q: unknown) => q,
}));
const telefonoJefeDe = vi.fn();
const telefonoDeUsuario = vi.fn();
vi.mock('./contactos', () => ({
  telefonoJefeDe: (...a: unknown[]) => telefonoJefeDe(...a),
  telefonoDeUsuario: (...a: unknown[]) => telefonoDeUsuario(...a),
}));
const sendText = vi.fn();
const sendButtons = vi.fn();
vi.mock('@/lib/meta/client', () => ({
  MAX_CUERPO_BOTONES: 1024,
  sendText: (...a: unknown[]) => sendText(...a),
  sendButtons: (...a: unknown[]) => sendButtons(...a),
}));
const loggerWarn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: loggerWarn, error: vi.fn() } }));
const alertarOperador = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/observability/alerta', () => ({ alertarOperador: (...a: unknown[]) => alertarOperador(...a) }));
const listarProveedoresEmergencia = vi.fn();
vi.mock('./emergencias', () => ({
  listarProveedoresEmergencia: (...a: unknown[]) => listarProveedoresEmergencia(...a),
  polizaVigenteDe: vi.fn().mockResolvedValue(null),
  // La real: normalizar el teléfono ES lo que el c4-4 prueba.
  telefonoE164Mx: (t: string) => { const d = t.replace(/[^\d]/g, ''); return /^\d{10}$/.test(d) ? `52${d}` : d; },
}));
// El motor de la cascada (armarCascada) es REAL: la lista que el handler
// recorre es la misma que el jefe vio en el 🚨 — mockearla probaría otra cosa.
const anotarEventoIncidencia = vi.fn().mockResolvedValue('anotado');
const cerrarCoordinacionesDeIncidencia = vi.fn().mockResolvedValue(undefined);
vi.mock('./asistencia_wa', () => ({
  anotarEventoIncidencia: (...a: unknown[]) => anotarEventoIncidencia(...a),
  cerrarCoordinacionesDeIncidencia: (...a: unknown[]) => cerrarCoordinacionesDeIncidencia(...a),
  TIPOS_ASISTENCIA: ['siniestro', 'robo', 'emergencia_medica', 'varado', 'bloqueo'] as const,
}));
// talacha_wa se importa por extraerMonto (real); sus dependencias pesadas se
// cortan aquí igual que en asistencia_wa.test.ts.
vi.mock('./operacion', () => ({ crearIncidencia: vi.fn() }));
vi.mock('./mantenimiento', () => ({ abrirOrdenPorAveria: vi.fn() }));

const {
  leerEtaMin, armarMensajeProveedor, leerComandoCoordinacion,
  atenderCoordinacionOficina, atenderMensajeProveedor, atenderMedioProveedorSinTexto,
} = await import('./asistencia_coordinacion');

const INC = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const COO = '11111111-2222-3333-4444-555555555555';
const JEFE = { tenantId: 't1', rol: 'flota_admin' as const, userId: 'u-jefe' };

const SEL_INC = 'incidencia.select:id, tipo, estado, lat, lng, unidad_id, operador_id';
const SEL_ACTIVAS = 'coordinacion_proveedor.select:id, tenant_id, incidencia_id, estado, proveedor_nombre, mensaje_preparado, autorizada_por';

function proveedorVerificado(over: Record<string, unknown> = {}) {
  return {
    id: 'prov-1', tipo: 'grua', nombre: 'Grúas El Güero', telefono: '5299911122233',
    lat: null, lng: null, radioKm: null, verificadoEn: '2026-08-01T00:00:00Z', notas: null,
    ...over,
  };
}

/** El caso feliz de iniciar: incidencia varado legible, directorio con un
 *  verificado, rótulos legibles, Meta acepta. */
function baseIniciar() {
  respuestas = {
    [SEL_INC]: { data: { id: INC, tipo: 'varado', estado: 'abierta', lat: 19.4, lng: -99.1, unidad_id: null, operador_id: 'op-1' }, error: null },
    'coordinacion_proveedor.insert': { data: { id: COO }, error: null },
    'coordinacion_proveedor.claim': { data: [{ id: COO }], error: null },
    'tenant.select:nombre': { data: { nombre: 'Transportes Prueba' }, error: null },
  };
  listarProveedoresEmergencia.mockResolvedValue([proveedorVerificado()]);
  telefonoJefeDe.mockResolvedValue('5215550000009');
  sendText.mockResolvedValue('wamid.TXT');
  sendButtons.mockResolvedValue('wamid.BTN');
}

beforeEach(() => {
  respuestas = {};
  escrituras = [];
  vi.clearAllMocks();
  anotarEventoIncidencia.mockResolvedValue('anotado');
  // c4-2/c4-3: el lado del proveedor y la firma ahora verifican que la
  // incidencia siga VIVA — el default de las pruebas es que sí lo está.
  respuestas['incidencia.select:id, estado'] = { data: [{ id: INC, estado: 'abierta' }], error: null };
  respuestas['coordinacion_proveedor.select:incidencia_id'] = { data: { incidencia_id: INC }, error: null };
  respuestas['incidencia.select:estado'] = { data: { estado: 'abierta' }, error: null };
});

// ── Los puros ──────────────────────────────────────────────────────────────

describe('leerEtaMin — el ETA es el que DIJO, o null', () => {
  it.each([
    ['llego en 40 min', 40],
    ['como 40 minutos', 40],
    ['en 2 horas', 120],
    ['una hora', 60],
    ['hora y media', 90],
    ['media hora', 30],
    ['en 40 minutos, sí, 40 min', 40],       // la misma cifra dos veces no es ambigüedad
    ['puedo en 20 min o hasta en 1 hora', null], // dos lecturas distintas: no se adivina
    ['voy para allá', null],
    ['', null],
    // AUDITORÍA FABLE CICLO 4 (c4-7): el rango y la alternativa son ambiguos
    // — antes "de 40 a 50 minutos" leía 50 y "1 hora si acaso 2" leía 60.
    ['de 40 a 50 minutos', null],
    ['40 o 50 min', null],
    ['como 1 hora si acaso 2', null],
    ['2 horas o 3', null],
    // Y el precio después de la unidad NO es una segunda lectura de ETA.
    ['llego en 40 min, cobro $1,500', 40],
  ])('«%s» → %s', (texto, esperado) => {
    expect(leerEtaMin(texto)).toBe(esperado);
  });
});

describe('armarMensajeProveedor — solo hechos que existen', () => {
  it('con todo: link de ubicación, unidad y contacto del jefe', () => {
    const m = armarMensajeProveedor({
      flota: 'Transportes Prueba', tipoProveedor: 'grua', unidad: 'U-12 · ABC-123',
      lat: 19.4326, lng: -99.1332, telefonoJefe: '5215550000009',
    });
    expect(m).toContain('Transportes Prueba');
    expect(m).toContain('una grúa');
    expect(m).toContain('U-12 · ABC-123');
    expect(m).toContain('https://maps.google.com/?q=19.4326,-99.1332');
    expect(m).toContain('5215550000009');
  });
  it('sin ubicación NO inventa coordenadas: dice que el jefe la comparte', () => {
    const m = armarMensajeProveedor({
      flota: null, tipoProveedor: 'llantera', unidad: null, lat: null, lng: null, telefonoJefe: null,
    });
    expect(m).not.toContain('maps.google');
    expect(m).toContain('se la comparte el jefe de tráfico');
    expect(m).not.toContain('unidad ');
  });
});

describe('leerComandoCoordinacion', () => {
  it('reconoce los tres botones y el mandato cerrado', () => {
    expect(leerComandoCoordinacion(`coo_ir:${INC}`)).toEqual({ clase: 'iniciar_boton', incidenciaId: INC });
    expect(leerComandoCoordinacion(`coo_si:${COO}`)).toEqual({ clase: 'decidir', coordinacionId: COO, decision: 'confirmada' });
    expect(leerComandoCoordinacion(`coo_no:${COO}`)).toEqual({ clase: 'decidir', coordinacionId: COO, decision: 'descartada' });
    expect(leerComandoCoordinacion('contactar')).toEqual({ clase: 'iniciar_palabra', indice: 1 });
    expect(leerComandoCoordinacion('Contactar 2')).toEqual({ clase: 'iniciar_palabra', indice: 2 });
  });
  it('lo que no es del circuito sigue su camino', () => {
    expect(leerComandoCoordinacion('contactar al gruero de siempre')).toBeNull();
    expect(leerComandoCoordinacion('contacta')).toBeNull();
    expect(leerComandoCoordinacion('nuevo viaje para Juan')).toBeNull();
  });
});

// ── Iniciar el contacto ────────────────────────────────────────────────────

describe('atenderCoordinacionOficina — los candados de entrada', () => {
  it('el rol que no coordina recibe la verdad y nada se escribe', async () => {
    const r = await atenderCoordinacionOficina({ tenantId: 't1', rol: 'contador', userId: 'u-c' }, `coo_ir:${INC}`);
    expect(r).toContain('Tu rol no coordina');
    expect(escrituras).toHaveLength(0);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('en robo NO se coordina: el protocolo mudo manda', async () => {
    respuestas[SEL_INC] = { data: { id: INC, tipo: 'robo', estado: 'abierta', lat: null, lng: null, unidad_id: null, operador_id: null }, error: null };
    const r = await atenderCoordinacionOficina(JEFE, `coo_ir:${INC}`);
    expect(r).toContain('NO contacto proveedores');
    expect(escrituras.filter((e) => e.clave === 'coordinacion_proveedor.insert')).toHaveLength(0);
  });

  it('al proveedor SIN confirmar no le escribe Likida — le marca el jefe', async () => {
    baseIniciar();
    listarProveedoresEmergencia.mockResolvedValue([proveedorVerificado({ verificadoEn: null })]);
    const r = await atenderCoordinacionOficina(JEFE, `coo_ir:${INC}`);
    expect(r).toContain('SIN confirmar');
    expect(r).toContain('5299911122233'); // el teléfono para que marque ÉL
    expect(escrituras.filter((e) => e.clave === 'coordinacion_proveedor.insert')).toHaveLength(0);
    expect(sendText).not.toHaveBeenCalled();
  });
});

describe('atenderCoordinacionOficina — el contacto', () => {
  it('feliz: autoriza, escribe al proveedor y sella contactado', async () => {
    baseIniciar();
    const r = await atenderCoordinacionOficina(JEFE, `coo_ir:${INC}`);
    expect(r).toContain('Le escribí a Grúas El Güero');
    // El mensaje salió AL TELÉFONO del directorio, con la ubicación real.
    expect(sendText).toHaveBeenCalledTimes(1);
    const [tel, cuerpo] = sendText.mock.calls[0] as [string, string];
    expect(tel).toBe('5299911122233');
    expect(cuerpo).toContain('https://maps.google.com/?q=19.4,-99.1');
    // Y el sello `contactado` se escribió DESPUÉS de la aceptación.
    expect(escrituras.some((e) => e.clave === 'coordinacion_proveedor.claim'
      && (e.payload as { estado?: string }).estado === 'contactado')).toBe(true);
  });

  it('ventana cerrada (Meta rechaza): estado honesto y el mensaje LISTO para el jefe', async () => {
    baseIniciar();
    sendText.mockResolvedValue(null);
    const r = await atenderCoordinacionOficina(JEFE, `coo_ir:${INC}`);
    expect(r).toContain('plantilla aprobada que está pendiente');
    expect(r).toContain('Le escribimos de Transportes Prueba'); // el texto listo, completo
    // NO se selló contactado: la coordinación queda pendiente_plantilla.
    expect(escrituras.some((e) => e.clave === 'coordinacion_proveedor.claim')).toBe(false);
  });

  it('c4-4: el proveedor capturado a 10 dígitos se contacta y snapshotea en E.164', async () => {
    baseIniciar();
    listarProveedoresEmergencia.mockResolvedValue([proveedorVerificado({ telefono: '5512345678' })]);
    const r = await atenderCoordinacionOficina(JEFE, `coo_ir:${INC}`);
    expect(r).toContain('Le escribí a Grúas El Güero');
    // El envío va CON lada — a 10 dígitos Meta lo rechazaba y el rechazo se
    // diagnosticaba (falso) como "falta la plantilla".
    expect((sendText.mock.calls[0] as [string, string])[0]).toBe('525512345678');
    const alta = escrituras.find((e) => e.clave === 'coordinacion_proveedor.insert');
    expect((alta!.payload as { proveedor_telefono: string }).proveedor_telefono).toBe('525512345678');
  });

  it('doble autorización: el índice único deja UNA gestión viva y el segundo recibe la verdad', async () => {
    baseIniciar();
    respuestas['coordinacion_proveedor.insert'] = { data: null, error: { message: 'duplicate key value violates unique constraint "coordinacion_viva_unica"' } };
    respuestas['coordinacion_proveedor.select:proveedor_nombre, estado'] = { data: [{ proveedor_nombre: 'Grúas El Güero', estado: 'contactado' }], error: null };
    const r = await atenderCoordinacionOficina(JEFE, `coo_ir:${INC}`);
    expect(r).toContain('Ya hay una gestión en curso con Grúas El Güero');
    expect(sendText).not.toHaveBeenCalled(); // al proveedor no se le escribe dos veces
  });
});

// ── El lado del proveedor ──────────────────────────────────────────────────

describe('atenderMensajeProveedor', () => {
  it('un número sin gestión viva NO es de este circuito', async () => {
    respuestas[SEL_ACTIVAS] = { data: [], error: null };
    expect(await atenderMensajeProveedor('5215559999999', 'hola')).toBeNull();
  });

  it('la cotización clara se lee, avanza a cotizada y el jefe recibe botones', async () => {
    respuestas[SEL_ACTIVAS] = {
      data: [{ id: COO, tenant_id: 't1', incidencia_id: INC, estado: 'contactado', proveedor_nombre: 'Grúas El Güero', mensaje_preparado: 'msj' }],
      error: null,
    };
    respuestas['coordinacion_proveedor.claim'] = { data: [{ id: COO }], error: null };
    telefonoJefeDe.mockResolvedValue('5215550000009');
    sendButtons.mockResolvedValue('wamid.BTN');
    const r = await atenderMensajeProveedor('5299911122233', 'sí puedo, llego en 40 min, son 1200 pesos');
    expect(r).toContain('le pasé su tiempo y precio al jefe');
    const cotiza = escrituras.find((e) => e.clave === 'coordinacion_proveedor.claim');
    expect((cotiza!.payload as { eta_min: number | null; precio: number | null }).eta_min).toBe(40);
    expect((cotiza!.payload as { eta_min: number | null; precio: number | null }).precio).toBe(1200);
    const botones = sendButtons.mock.calls[0][2] as Array<{ id: string }>;
    expect(botones.map((b) => b.id)).toEqual([`coo_si:${COO}`, `coo_no:${COO}`]);
  });

  it('la respuesta ambigua guarda el crudo y NO inventa cifras — el jefe la lee', async () => {
    respuestas[SEL_ACTIVAS] = {
      data: [{ id: COO, tenant_id: 't1', incidencia_id: INC, estado: 'contactado', proveedor_nombre: 'Grúas El Güero', mensaje_preparado: 'msj' }],
      error: null,
    };
    respuestas['coordinacion_proveedor.claim'] = { data: [{ id: COO }], error: null };
    telefonoJefeDe.mockResolvedValue('5215550000009');
    sendButtons.mockResolvedValue('wamid.BTN');
    await atenderMensajeProveedor('5299911122233', 'puedo en 20 min o en 1 hora, serían 800 o 1200 según la distancia');
    const cotiza = escrituras.find((e) => e.clave === 'coordinacion_proveedor.claim');
    expect((cotiza!.payload as { eta_min: number | null }).eta_min).toBeNull();
    expect((cotiza!.payload as { precio: number | null }).precio).toBeNull();
    expect((cotiza!.payload as { respuesta_cruda: string }).respuesta_cruda).toContain('según la distancia');
    expect(sendButtons.mock.calls[0][1] as string).toContain('no claro');
  });

  it('pendiente_plantilla + el proveedor escribe = la ventana se abrió: el mensaje preparado sale ahora', async () => {
    respuestas[SEL_ACTIVAS] = {
      data: [{ id: COO, tenant_id: 't1', incidencia_id: INC, estado: 'pendiente_plantilla', proveedor_nombre: 'Grúas El Güero', mensaje_preparado: 'EL MENSAJE PREPARADO' }],
      error: null,
    };
    respuestas['coordinacion_proveedor.claim'] = { data: [{ id: COO }], error: null };
    telefonoJefeDe.mockResolvedValue('5215550000009');
    sendText.mockResolvedValue('wamid.TXT');
    sendButtons.mockResolvedValue('wamid.BTN');
    await atenderMensajeProveedor('5299911122233', 'bueno, ¿quién habla?');
    expect(sendText).toHaveBeenCalledWith('5299911122233', 'EL MENSAJE PREPARADO');
    // Y avanzó: contactado primero, cotizada con su texto después.
    const claims = escrituras.filter((e) => e.clave === 'coordinacion_proveedor.claim');
    expect((claims[0].payload as { estado: string }).estado).toBe('contactado');
    expect((claims[1].payload as { estado: string }).estado).toBe('cotizada');
  });

  it('c4-2/c4-3: la gestión de una incidencia YA RESUELTA no captura al número — se cierra y el processor sigue', async () => {
    respuestas[SEL_ACTIVAS] = {
      data: [{ id: COO, tenant_id: 't1', incidencia_id: INC, estado: 'pendiente_plantilla', proveedor_nombre: 'Grúas El Güero', mensaje_preparado: 'EL MENSAJE PREPARADO' }],
      error: null,
    };
    respuestas['incidencia.select:id, estado'] = { data: [{ id: INC, estado: 'resuelta' }], error: null };
    const r = await atenderMensajeProveedor('5299911122233', 'bueno, ¿quién habla?');
    // NO se autorrepara nada sobre una emergencia muerta, y la gestión
    // huérfana queda cerrada de paso.
    expect(r).toBeNull();
    expect(sendText).not.toHaveBeenCalled();
    expect(cerrarCoordinacionesDeIncidencia).toHaveBeenCalledWith('t1', INC, 'incidencia_ya_resuelta');
  });

  it('c4-5: la nota de voz de un proveedor con gestión viva recibe "¿me lo escribe?" y queda en el expediente', async () => {
    respuestas[SEL_ACTIVAS] = {
      data: [{ id: COO, tenant_id: 't1', incidencia_id: INC, estado: 'contactado', proveedor_nombre: 'Grúas El Güero', mensaje_preparado: 'msj' }],
      error: null,
    };
    const r = await atenderMedioProveedorSinTexto('5299911122233', 'audio');
    expect(r).toContain('¿Me lo escribe por texto');
    expect(anotarEventoIncidencia).toHaveBeenCalledWith('t1', INC, 'proveedor_mensaje',
      expect.objectContaining({ sinTexto: true, tipo: 'audio' }));
  });

  it('c4-5: el audio de un número SIN gestión viva no es de este circuito', async () => {
    respuestas[SEL_ACTIVAS] = { data: [], error: null };
    expect(await atenderMedioProveedorSinTexto('5215559999999', 'audio')).toBeNull();
  });

  it('dos gestiones vivas con el mismo teléfono: no se adivina — bitácora y jefe de CADA una', async () => {
    respuestas[SEL_ACTIVAS] = {
      data: [
        { id: COO, tenant_id: 't1', incidencia_id: INC, estado: 'contactado', proveedor_nombre: 'Grúas El Güero', mensaje_preparado: 'a' },
        { id: 'c2', tenant_id: 't2', incidencia_id: 'i2', estado: 'contactado', proveedor_nombre: 'Grúas El Güero', mensaje_preparado: 'b' },
      ],
      error: null,
    };
    telefonoJefeDe.mockResolvedValue('5215550000009');
    sendText.mockResolvedValue('wamid.TXT');
    const r = await atenderMensajeProveedor('5299911122233', 'llego en 40 min');
    expect(r).toContain('más de una solicitud activa');
    expect(anotarEventoIncidencia).toHaveBeenCalledTimes(2);
    // NADA se cotizó: la atribución es del humano.
    expect(escrituras.filter((e) => e.clave === 'coordinacion_proveedor.claim')).toHaveLength(0);
  });
});

// ── AUDITORÍA 28, ALTO (AG-A4): la cotización va a quien AUTORIZÓ ──────────

describe('atenderMensajeProveedor — el destinatario correcto de la cotización', () => {
  it('autorizó el flota_admin (A): la cotización va a SU teléfono, no al del encargado (jefe por rol)', async () => {
    respuestas[SEL_ACTIVAS] = {
      data: [{
        id: COO, tenant_id: 't1', incidencia_id: INC, estado: 'contactado',
        proveedor_nombre: 'Grúas El Güero', mensaje_preparado: 'msj', autorizada_por: 'u-flota-admin-A',
      }],
      error: null,
    };
    respuestas['coordinacion_proveedor.claim'] = { data: [{ id: COO }], error: null };
    telefonoDeUsuario.mockResolvedValue('5215551110000');   // A: quien autorizó
    telefonoJefeDe.mockResolvedValue('5215552220000');      // B: el encargado — NO debe usarse
    sendButtons.mockResolvedValue('wamid.BTN');
    const r = await atenderMensajeProveedor('5299911122233', 'llego en 40 min, son 1200');
    expect(telefonoDeUsuario).toHaveBeenCalledWith('u-flota-admin-A', 't1');
    const [tel] = sendButtons.mock.calls[0] as [string, string, unknown];
    expect(tel).toBe('5215551110000');
    expect(telefonoJefeDe).not.toHaveBeenCalled();
    expect(r).toContain('le pasé su tiempo y precio al jefe');
  });

  it('autorizada_por sin teléfono o inactivo (null): cae a telefonoJefeDe', async () => {
    respuestas[SEL_ACTIVAS] = {
      data: [{
        id: COO, tenant_id: 't1', incidencia_id: INC, estado: 'contactado',
        proveedor_nombre: 'Grúas El Güero', mensaje_preparado: 'msj', autorizada_por: 'u-de-baja',
      }],
      error: null,
    };
    respuestas['coordinacion_proveedor.claim'] = { data: [{ id: COO }], error: null };
    telefonoDeUsuario.mockResolvedValue(null);              // dado de baja o sin teléfono
    telefonoJefeDe.mockResolvedValue('5215552220000');
    sendButtons.mockResolvedValue('wamid.BTN');
    const r = await atenderMensajeProveedor('5299911122233', 'llego en 40 min, son 1200');
    const [tel] = sendButtons.mock.calls[0] as [string, string, unknown];
    expect(tel).toBe('5215552220000');
    expect(r).toContain('le pasé su tiempo y precio al jefe');
  });

  it('si el aviso de la cotización NO sale: warn, evento cotizacion_no_avisada, alertarOperador — y al proveedor no se le miente', async () => {
    respuestas[SEL_ACTIVAS] = {
      data: [{
        id: COO, tenant_id: 't1', incidencia_id: INC, estado: 'contactado',
        proveedor_nombre: 'Grúas El Güero', mensaje_preparado: 'msj', autorizada_por: null,
      }],
      error: null,
    };
    respuestas['coordinacion_proveedor.claim'] = { data: [{ id: COO }], error: null };
    telefonoJefeDe.mockResolvedValue('5215552220000');
    sendButtons.mockResolvedValue(null);   // Meta rechazó (ventana de 24h cerrada)
    const r = await atenderMensajeProveedor('5299911122233', 'llego en 40 min, son 1200');
    expect(loggerWarn).toHaveBeenCalledWith('coordinacion.cotizacion_no_avisada', expect.objectContaining({ coordinacion: COO }));
    expect(anotarEventoIncidencia).toHaveBeenCalledWith('t1', INC, 'cotizacion_no_avisada', expect.objectContaining({ coordinacionId: COO }));
    expect(alertarOperador).toHaveBeenCalledWith('coordinacion.cotizacion_no_avisada', expect.objectContaining({ codigo: 'cotizacion_no_avisada' }));
    // La verdad, no la promesa vacía de antes.
    expect(r).not.toContain('le confirma en breve');
    expect(r).not.toContain('directamente en breve');
  });
});

// ── La firma del jefe ──────────────────────────────────────────────────────

describe('decidir la cotización — firma atómica', () => {
  function baseDecidir() {
    respuestas['coordinacion_proveedor.claim'] = {
      data: [{
        id: COO, incidencia_id: INC, proveedor_nombre: 'Grúas El Güero',
        proveedor_telefono: '5299911122233', eta_min: 40, precio: 1200, respuesta_cruda: 'llego en 40 min, 1200',
      }],
      error: null,
    };
    respuestas['incidencia.select:operador_id'] = { data: { operador_id: 'op-1' }, error: null };
    respuestas['operador.select:telefono'] = { data: { telefono: '5215558887777' }, error: null };
    sendText.mockResolvedValue('wamid.TXT');
  }

  it('confirmar cierra el loop: proveedor y chofer se enteran, el precio queda firmado', async () => {
    baseDecidir();
    const r = await atenderCoordinacionOficina(JEFE, `coo_si:${COO}`);
    expect(r).toContain('Confirmado ✅ con Grúas El Güero');
    expect(r).toContain('queda firmado');
    const destinos = sendText.mock.calls.map((c) => c[0]);
    expect(destinos).toContain('5299911122233'); // el proveedor
    expect(destinos).toContain('5215558887777'); // el chofer
    const alChofer = sendText.mock.calls.find((c) => c[0] === '5215558887777')![1] as string;
    expect(alChofer).toContain('~40 min'); // el ETA que DIJO el proveedor
    const firma = escrituras.find((e) => e.clave === 'coordinacion_proveedor.claim');
    expect((firma!.payload as { estado: string; decidida_por: string }).estado).toBe('confirmada');
    expect((firma!.payload as { decidida_por: string }).decidida_por).toBe('u-jefe');
  });

  it('el segundo tap pierde la carrera y recibe la verdad', async () => {
    respuestas['coordinacion_proveedor.claim'] = { data: [], error: null };
    respuestas['coordinacion_proveedor.select:estado, proveedor_nombre'] = { data: { estado: 'confirmada', proveedor_nombre: 'Grúas El Güero' }, error: null };
    const r = await atenderCoordinacionOficina(JEFE, `coo_si:${COO}`);
    expect(r).toContain('ya estaba confirmada');
    expect(sendText).not.toHaveBeenCalled(); // nadie recibe un segundo aviso
  });

  it('c4-3: el tap del backlog sobre una emergencia YA RESUELTA no firma ni despierta a nadie', async () => {
    baseDecidir();
    respuestas['incidencia.select:estado'] = { data: { estado: 'resuelta' }, error: null };
    const r = await atenderCoordinacionOficina(JEFE, `coo_si:${COO}`);
    expect(r).toContain('ya está resuelta');
    // Ni firma, ni WhatsApp al proveedor o al chofer.
    expect(escrituras.filter((e) => e.clave === 'coordinacion_proveedor.claim')).toHaveLength(0);
    expect(sendText).not.toHaveBeenCalled();
    expect(cerrarCoordinacionesDeIncidencia).toHaveBeenCalledWith('t1', INC, 'incidencia_ya_resuelta');
  });

  it('c4-3: sin poder leer el estado de la emergencia, NO se firma (fail-closed en dinero)', async () => {
    baseDecidir();
    respuestas['incidencia.select:estado'] = { data: null, error: { message: 'timeout' } };
    const r = await atenderCoordinacionOficina(JEFE, `coo_si:${COO}`);
    expect(r).toContain('No pude verificar');
    expect(escrituras.filter((e) => e.clave === 'coordinacion_proveedor.claim')).toHaveLength(0);
  });

  it('descartar libera y lo dice — al proveedor se le agradece con la verdad', async () => {
    baseDecidir();
    const r = await atenderCoordinacionOficina(JEFE, `coo_no:${COO}`);
    expect(r).toContain('Descartada ❌');
    expect(r).toContain('contactar 2');
    const alProveedor = sendText.mock.calls.find((c) => c[0] === '5299911122233')![1] as string;
    expect(alProveedor).toContain('no vamos a tomar el servicio');
  });
});
