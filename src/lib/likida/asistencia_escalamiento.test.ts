import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// EL RELOJ MUERTO (Fase 5). Lo que estas pruebas fijan:
//  · el claim es MONÓTONO y con un solo ganador — dos crons solapados escalan
//    exactamente una vez;
//  · reconocida detiene la escalada (el filtro `reconocida_en is null` va en
//    el WHERE del claim, no en la buena voluntad del código);
//  · lesionados salta directo al dueño (nivel 2), en UN aviso;
//  · ámbar fuera de ventana se DIFIERE con `notificar_desde` — no se tira;
//  · ROJO ni consulta la ventana: a un dueño se le despierta por un choque;
//  · un aviso que no salió alerta al operador — nunca un silencio.
// ═══════════════════════════════════════════════════════════════════════════

// ── Dobles ────────────────────────────────────────────────────────────────

const claimUpdate = vi.hoisted(() => vi.fn());       // update de nivel_escalado
const deferUpdate = vi.hoisted(() => vi.fn());       // update de notificar_desde
let claimGana = true;

/** Cadena flexible: todo método se encadena; `.select()` resuelve el claim;
 *  la cadena entera es awaitable (el update de diferir termina en `.is()`). */
function cadenaIncidencia(payload: Record<string, unknown>) {
  const esClaim = 'nivel_escalado' in payload;
  if (esClaim) claimUpdate(payload); else deferUpdate(payload);
  const res = esClaim
    ? { data: claimGana ? [{ id: 'inc-1' }] : [], error: null }
    : { error: null };
  const cadena: Record<string, unknown> = {};
  for (const m of ['eq', 'is', 'neq']) cadena[m] = () => cadena;
  cadena.select = async () => res;
  cadena.then = (resolve: (v: unknown) => unknown) => Promise.resolve(res).then(resolve);
  return cadena;
}

const telefonoDueno = vi.hoisted(() => vi.fn(async (): Promise<string | null> => '5210000000002'));
// AGEN-C1 (auditoría 25): `null` = base sin la 0294, y esa fila NO está de baja.
const duenoActivo = vi.hoisted(() => ({ valor: null as boolean | null }));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => {
      if (tabla === 'incidencia') return { update: (p: Record<string, unknown>) => cadenaIncidencia(p) };
      if (tabla === 'app_user') {
        const cadena: Record<string, unknown> = {};
        // `or` entra con AGEN-C1 (auditoría 25): el filtro de la baja va también
        // en la base. Igual que en `contactos.test.ts`, el doble devuelve la
        // misma fila con o sin el encadenado, así que lo que estas pruebas
        // ejercen es la capa de TS — que es donde vive la regla.
        for (const m of ['select', 'eq', 'not', 'or']) cadena[m] = () => cadena;
        cadena.limit = async () => {
          const tel = await telefonoDueno();
          return { data: tel ? [{ telefono: tel, activo: duenoActivo.valor }] : [], error: null };
        };
        return cadena;
      }
      if (tabla === 'viaje') {
        const cadena: Record<string, unknown> = {};
        for (const m of ['select', 'eq']) cadena[m] = () => cadena;
        cadena.maybeSingle = async () => ({ data: { operador_id: 'op-1' }, error: null });
        return cadena;
      }
      throw new Error(`tabla inesperada en el doble: ${tabla}`);
    },
  }),
}));
vi.mock('@/lib/likida/presupuesto', () => ({ acotada: (q: unknown) => q }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const filasPendientes = vi.hoisted(() => vi.fn((): Record<string, unknown>[] => []));
vi.mock('./pg', () => ({
  traerTodo: async () => filasPendientes(),
  conteo: (desde: number) => (desde === 0 ? { count: 'exact' } : {}),
}));

const anotarEvento = vi.hoisted(() => vi.fn(async () => 'anotado' as const));
vi.mock('./asistencia_wa', () => ({
  anotarEventoIncidencia: (...a: unknown[]) => anotarEvento(...(a as [])),
  TIPOS_ASISTENCIA: ['siniestro', 'robo', 'emergencia_medica', 'varado', 'bloqueo'],
}));

const telefonoJefeDe = vi.hoisted(() => vi.fn(async (): Promise<string | null> => '5210000000001'));
vi.mock('./contactos', () => ({ telefonoJefeDe: (...a: unknown[]) => telefonoJefeDe(...(a as [])) }));

const polizaVigenteDe = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
const contactoSiLesionadosDe = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
vi.mock('./emergencias', () => ({
  polizaVigenteDe: (...a: unknown[]) => polizaVigenteDe(...(a as [])),
  contactoSiLesionadosDe: (...a: unknown[]) => contactoSiLesionadosDe(...(a as [])),
}));

const enVentana = vi.hoisted(() => ({ valor: true }));
vi.mock('./agentes/cobranza', () => ({ leerConfigCobranza: vi.fn(async () => ({ horaInicio: 9, horaFin: 19, diasSemana: [1, 2, 3, 4, 5] })) }));
vi.mock('./agentes/cobranza_pura', () => ({ dentroDeVentana: () => enVentana.valor }));

const sendButtons = vi.hoisted(() => vi.fn(async (): Promise<string | null> => 'wamid.esc'));
vi.mock('@/lib/meta/client', () => ({
  MAX_CUERPO_BOTONES: 1024, sendButtons: (...a: unknown[]) => sendButtons(...(a as [])) }));

const alertarOperador = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/observability/alerta', () => ({ alertarOperador: (...a: unknown[]) => alertarOperador(...(a as [])) }));

import {
  nivelObjetivo, escalarAsistenciasPendientes, _soloParaTests,
  RELOJ_ROJO_MS, RELOJ_AMBAR_MS, NIVEL_MAXIMO,
} from './asistencia_escalamiento';

const T0 = Date.parse('2026-08-26T18:00:00.000Z');
const abiertaHace = (ms: number) => new Date(T0 - ms).toISOString();
const AHORA = new Date(T0);

const fila = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'inc-1', tenant_id: 't-1', tipo: 'siniestro', prioridad: 'critica',
  nivel_escalado: 0, abierta_en: abiertaHace(6 * 60_000), hay_lesionados: null,
  viaje_id: null, operador_id: 'op-1', notificar_desde: null,
  descripcion: 'chocamos en la caseta km 40',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  claimGana = true;
  enVentana.valor = true;
  filasPendientes.mockReturnValue([]);
  telefonoJefeDe.mockResolvedValue('5210000000001');
  telefonoDueno.mockResolvedValue('5210000000002');
  // Se resetea AQUÍ, no al final de la prueba que lo mueve: si esa prueba falla
  // en su assert, la línea de limpieza no corre y contamina las 16 siguientes.
  duenoActivo.valor = null;
  sendButtons.mockResolvedValue('wamid.esc');
  polizaVigenteDe.mockResolvedValue(null);
  contactoSiLesionadosDe.mockResolvedValue(null);
});

describe('nivelObjetivo — el reloj, puro', () => {
  const base = { prioridad: 'critica', nivelEscalado: 0, abiertaEn: abiertaHace(0), hayLesionados: null as boolean | null };

  it('rojo sube un peldaño por cada 5 minutos sin reconocer, con techo en 4', () => {
    expect(nivelObjetivo({ ...base, abiertaEn: abiertaHace(RELOJ_ROJO_MS - 1) }, AHORA)).toBe(0);
    expect(nivelObjetivo({ ...base, abiertaEn: abiertaHace(RELOJ_ROJO_MS) }, AHORA)).toBe(1);
    expect(nivelObjetivo({ ...base, abiertaEn: abiertaHace(2 * RELOJ_ROJO_MS) }, AHORA)).toBe(2);
    expect(nivelObjetivo({ ...base, abiertaEn: abiertaHace(60 * 60_000) }, AHORA)).toBe(NIVEL_MAXIMO);
  });

  it('ámbar respira más lento: 15 minutos por peldaño', () => {
    expect(nivelObjetivo({ ...base, prioridad: 'alta', abiertaEn: abiertaHace(RELOJ_AMBAR_MS - 1) }, AHORA)).toBe(0);
    expect(nivelObjetivo({ ...base, prioridad: 'alta', abiertaEn: abiertaHace(RELOJ_AMBAR_MS) }, AHORA)).toBe(1);
  });

  it('lesionados salta directo al dueño: el primer peldaño vencido ya es nivel 2', () => {
    expect(nivelObjetivo({ ...base, hayLesionados: true, abiertaEn: abiertaHace(RELOJ_ROJO_MS) }, AHORA)).toBe(2);
    // pero sin peldaño vencido no se inventa urgencia
    expect(nivelObjetivo({ ...base, hayLesionados: true, abiertaEn: abiertaHace(RELOJ_ROJO_MS - 1) }, AHORA)).toBe(0);
  });

  it('una fecha rota o futura no escala: se queda en el nivel actual', () => {
    expect(nivelObjetivo({ ...base, nivelEscalado: 1, abiertaEn: 'no-es-fecha' }, AHORA)).toBe(1);
    expect(nivelObjetivo({ ...base, nivelEscalado: 1, abiertaEn: new Date(T0 + 60_000).toISOString() }, AHORA)).toBe(1);
  });

  // AUDITORÍA 28 (AG-A3): contar SIEMPRE desde `abiertaEn` inflaba el nivel de
  // un caso que llevaba horas DIFERIDO (fuera de ventana) al reabrirse esta:
  // el primer aviso real saltaba directo a nivel 4 aunque nadie hubiera
  // dejado de responder — nunca se le había avisado. El ancla correcta es el
  // más tardío entre `abiertaEn` y `notificarDesde`.
  it('diferido por horas: el nivel se cuenta desde notificar_desde (el último refresh del cron), no desde que se abrió hace horas', () => {
    const abiertaHaceMucho = abiertaHace(5 * 60 * 60_000); // se abrió hace 5 horas
    const notificarDesde = abiertaHace(16 * 60_000); // el último ciclo diferido refrescó la marca hace 16 min
    // Sin el ancla (solo abiertaEn): 5h / 15min = 20 peldaños → tope 4.
    expect(nivelObjetivo({ ...base, prioridad: 'alta', abiertaEn: abiertaHaceMucho }, AHORA)).toBe(NIVEL_MAXIMO);
    // Con el ancla: 16min / 15min = 1 peldaño → nivel 1, no inflado.
    expect(nivelObjetivo({ ...base, prioridad: 'alta', abiertaEn: abiertaHaceMucho, notificarDesde }, AHORA)).toBe(1);
  });

  it('notificar_desde ANTERIOR a abiertaEn no reduce el nivel — se usa el más tardío de los dos', () => {
    expect(nivelObjetivo({
      ...base, prioridad: 'alta',
      abiertaEn: abiertaHace(RELOJ_AMBAR_MS),
      notificarDesde: abiertaHace(10 * RELOJ_AMBAR_MS),
    }, AHORA)).toBe(1);
  });
});

describe('escalarAsistenciasPendientes — claim, destinatarios y ventana', () => {
  it('rojo vencido: claim al nivel 1 y aviso AL JEFE con el botón asi_ok', async () => {
    filasPendientes.mockReturnValue([fila()]);
    const r = await escalarAsistenciasPendientes(AHORA);
    expect(r.escaladas).toBe(1);
    expect(claimUpdate).toHaveBeenCalledWith({ nivel_escalado: 1 });
    expect(telefonoJefeDe).toHaveBeenCalledWith('t-1');
    const [tel, texto, botones] = sendButtons.mock.calls[0] as unknown as [string, string, Array<{ id: string }>];
    expect(tel).toBe('5210000000001');
    expect(texto).toContain('SIGUE SIN ATENDERSE');
    expect(botones[0].id).toBe('asi_ok:inc-1');
    expect(anotarEvento).toHaveBeenCalledWith('t-1', 'inc-1', 'escalada', expect.objectContaining({ nivel: 1 }));
  });

  it('el claim perdido (otro cron ganó) no manda NADA — un solo aviso por peldaño', async () => {
    claimGana = false;
    filasPendientes.mockReturnValue([fila()]);
    const r = await escalarAsistenciasPendientes(AHORA);
    expect(r.escaladas).toBe(0);
    expect(sendButtons).not.toHaveBeenCalled();
    expect(anotarEvento).not.toHaveBeenCalled();
  });

  it('nivel 2 va al DUEÑO; si el dueño no tiene teléfono, cae al jefe y no se calla', async () => {
    filasPendientes.mockReturnValue([fila({ nivel_escalado: 1, abierta_en: abiertaHace(11 * 60_000) })]);
    await escalarAsistenciasPendientes(AHORA);
    expect(claimUpdate).toHaveBeenCalledWith({ nivel_escalado: 2 });
    expect((sendButtons.mock.calls[0] as unknown as [string])[0]).toBe('5210000000002');

    vi.clearAllMocks();
    telefonoDueno.mockResolvedValue(null);
    filasPendientes.mockReturnValue([fila({ nivel_escalado: 1, abierta_en: abiertaHace(11 * 60_000) })]);
    await escalarAsistenciasPendientes(AHORA);
    expect((sendButtons.mock.calls[0] as unknown as [string])[0]).toBe('5210000000001');
  });

  // AGEN-C1 (auditoría 25): el 🚨 de la escalada lleva la UBICACIÓN del chofer.
  // `telefonoDeRol` no miraba `activo`, así que al dueño dado de baja le seguía
  // llegando. Cae al jefe, que es lo que ya hace cuando el dueño no tiene
  // teléfono: no se calla, se lo manda a alguien que sí sigue en la flota.
  it('nivel 2 NO va al dueño dado de baja: cae al jefe con el 🚨 y su ubicación', async () => {
    duenoActivo.valor = false;
    filasPendientes.mockReturnValue([fila({ nivel_escalado: 1, abierta_en: abiertaHace(11 * 60_000) })]);
    await escalarAsistenciasPendientes(AHORA);
    expect((sendButtons.mock.calls[0] as unknown as [string])[0]).toBe('5210000000001');
  });

  it('lesionados: el salto 0→2 va en UN claim y UN aviso, con el contacto de emergencia en el texto', async () => {
    contactoSiLesionadosDe.mockResolvedValue({ nombre: 'María', telefono: '5219999999999', parentesco: 'esposa' });
    filasPendientes.mockReturnValue([fila({ hay_lesionados: true, abierta_en: abiertaHace(6 * 60_000) })]);
    await escalarAsistenciasPendientes(AHORA);
    expect(claimUpdate).toHaveBeenCalledTimes(1);
    expect(claimUpdate).toHaveBeenCalledWith({ nivel_escalado: 2 });
    expect(sendButtons).toHaveBeenCalledTimes(1);
    const texto = (sendButtons.mock.calls[0] as unknown as [string, string])[1];
    expect(texto).toContain('María');
    expect(texto).toContain('Likida no le marca a nadie');
  });

  it('ámbar fuera de ventana se DIFIERE: notificar_desde + bitácora, sin aviso', async () => {
    enVentana.valor = false;
    filasPendientes.mockReturnValue([fila({ prioridad: 'alta', tipo: 'varado', abierta_en: abiertaHace(20 * 60_000) })]);
    const r = await escalarAsistenciasPendientes(AHORA);
    expect(r.diferidas).toBe(1);
    expect(sendButtons).not.toHaveBeenCalled();
    expect(deferUpdate).toHaveBeenCalledWith({ notificar_desde: AHORA.toISOString() });
    expect(anotarEvento).toHaveBeenCalledWith('t-1', 'inc-1', 'aviso_diferido', expect.anything());
  });

  // AUDITORÍA 28 (AG-A3): un segundo diferimiento (ya con `notificar_desde`
  // puesto) REFRESCA la marca — si se quedara fija en la primera vez, el
  // ancla envejecería con el caso y el bug de la inflación reaparecería más
  // tarde, solo que retrasado. La bitácora `aviso_diferido` NO se repite: no
  // hay nada nuevo que contar en la segunda vez.
  it('un segundo diferimiento REFRESCA notificar_desde pero no repite la bitácora', async () => {
    enVentana.valor = false;
    filasPendientes.mockReturnValue([fila({
      prioridad: 'alta', tipo: 'varado',
      abierta_en: abiertaHace(40 * 60_000),
      notificar_desde: abiertaHace(20 * 60_000), // ya se había diferido antes
    })]);
    const r = await escalarAsistenciasPendientes(AHORA);
    expect(r.diferidas).toBe(1);
    expect(deferUpdate).toHaveBeenCalledWith({ notificar_desde: AHORA.toISOString() });
    expect(anotarEvento).not.toHaveBeenCalledWith('t-1', 'inc-1', 'aviso_diferido', expect.anything());
  });

  // El caso completo del hallazgo: un caso ámbar pasa horas diferido y la
  // ventana reabre. Sin el ancla en `notificar_desde`, `nivelObjetivo` habría
  // usado solo `abiertaEn` (horas atrás) y el primer aviso real habría
  // saltado a nivel 4 ("911, riesgo de vida") sin que nadie hubiera dejado de
  // responder — nunca se le avisó. Con el ancla, el nivel es el bajo (1).
  it('el caso vuelve a la ventana tras diferirse: escala al nivel BAJO (1), no al inflado (4)', async () => {
    enVentana.valor = true; // la ventana ya reabrió
    filasPendientes.mockReturnValue([fila({
      prioridad: 'alta', tipo: 'varado',
      abierta_en: abiertaHace(5 * 60 * 60_000), // se abrió hace 5 horas
      notificar_desde: abiertaHace(16 * 60_000), // el último refresh del cron, hace 16 min
    })]);
    const r = await escalarAsistenciasPendientes(AHORA);
    expect(r.escaladas).toBe(1);
    expect(claimUpdate).toHaveBeenCalledWith({ nivel_escalado: 1 });
    expect(claimUpdate).not.toHaveBeenCalledWith({ nivel_escalado: NIVEL_MAXIMO });
  });

  it('ROJO fuera de ventana ESCALA IGUAL — la ventana es de la severidad, no del canal', async () => {
    enVentana.valor = false;
    filasPendientes.mockReturnValue([fila()]);
    const r = await escalarAsistenciasPendientes(AHORA);
    expect(r.escaladas).toBe(1);
    expect(sendButtons).toHaveBeenCalledTimes(1);
  });

  it('el aviso que NO salió alerta al operador y queda en la bitácora — nunca silencio', async () => {
    sendButtons.mockResolvedValue(null);
    filasPendientes.mockReturnValue([fila()]);
    const r = await escalarAsistenciasPendientes(AHORA);
    expect(r.fallosAviso).toBe(1);
    expect(alertarOperador).toHaveBeenCalledWith('asistencia.escalamiento', expect.objectContaining({ codigo: 'aviso_escalada_fallido' }));
    expect(anotarEvento).toHaveBeenCalledWith('t-1', 'inc-1', 'aviso_escalada_fallido', expect.anything());
  });

  it('nivel 4 alerta al operador de Likida aunque el WhatsApp SÍ haya salido', async () => {
    filasPendientes.mockReturnValue([fila({ nivel_escalado: 3, abierta_en: abiertaHace(25 * 60_000) })]);
    await escalarAsistenciasPendientes(AHORA);
    expect(alertarOperador).toHaveBeenCalledWith('asistencia.escalamiento', expect.objectContaining({ codigo: 'escalada_nivel_maximo' }));
  });

  it('el corte por reloj deja el resto a la corrida siguiente y lo cuenta', async () => {
    filasPendientes.mockReturnValue([fila(), fila({ id: 'inc-2' }), fila({ id: 'inc-3' })]);
    const r = await escalarAsistenciasPendientes(AHORA, { venceEn: Date.now() - 1 });
    expect(r.revisadas).toBe(0);
    expect(r.cortadosPorReloj).toBe(3);
  });
});

describe('textoEscalada — lo que cada nivel dice', () => {
  const { textoEscalada } = _soloParaTests;

  it('nivel 3 CON póliza pone el 800 en la mano; SIN póliza dice la verdad', () => {
    const con = textoEscalada({
      nivel: 3, tipo: 'siniestro', descripcion: 'x',
      poliza: { aseguradora: 'Qualitas', numeroPoliza: 'P-99', telefonoSiniestros: '8002888500' },
      contactoLesionados: null,
    });
    expect(con).toContain('Qualitas');
    expect(con).toContain('8002888500');
    expect(con).toContain('Likida no puede marcar por ti');

    const sin = textoEscalada({ nivel: 3, tipo: 'siniestro', descripcion: 'x', poliza: null, contactoLesionados: null });
    expect(sin).toContain('NO tiene póliza capturada');
  });

  it('robo lleva SIEMPRE la advertencia de no marcarle al chofer', () => {
    for (const nivel of [1, 2, 3, 4]) {
      expect(textoEscalada({ nivel, tipo: 'robo', descripcion: 'x', poliza: null, contactoLesionados: null }))
        .toContain('no le marques al chofer');
    }
  });

  it('nivel 4 dice 911 y que Likida fue alertada — y ni ahí marca por nadie', () => {
    const t = textoEscalada({ nivel: 4, tipo: 'siniestro', descripcion: 'x', poliza: null, contactoLesionados: null });
    expect(t).toContain('911');
    expect(t).toContain('último aviso automático');
  });
});
