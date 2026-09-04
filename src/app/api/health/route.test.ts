import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readdirSync } from 'node:fs';
import { CRONS } from '@/lib/admin/salud';

// El pulso para el monitor externo (D4): la única promesa es que el status
// HTTP diga la verdad — 200 solo con base y crons sanos, 503 si falla/degrada —
// y que el cuerpo no filtre un solo dato de negocio.

let dbFalla = false;
/** Las filas de `cron_latido` (RES-7), con `detalle` opcional (auditoría prod
 *  29-ago-2026: distinguir un hueco de configuración de una regresión real). */
type Fila = { id: string; ultimo_latido: string; estado: string; detalle?: Record<string, unknown> };
let latidos: Fila[] = [];
/** AUDITORÍA 24, OP-P4: la base solo con UNA fila ya no es «sana con un
 *  hueco»: los otros diez crons nunca latieron. Los fixtures que quieren
 *  medir SOLO el hueco parten de todos frescos y sustituyen el que les toca. */
const frescos = (...cambios: Fila[]): Fila[] => {
  const ahora = new Date().toISOString();
  const base: Fila[] = [...CRONS].map((id) => ({ id, ultimo_latido: ahora, estado: 'ok' }));
  return base.map((f) => cambios.find((c) => c.id === f.id) ?? f);
};
/** OP-P1: lo que `migraciones_aplicadas()` (0234) contesta. Por default la
 *  base va A LA PAR del código: el prefijo más alto del repo. */
const CODIGO = readdirSync('supabase/migrations').map((f) => f.slice(0, 4)).filter((p) => /^\d{4}$/.test(p)).sort().at(-1)!;
let rpcMigraciones: () => { data: unknown; error: { message: string } | null } =
  () => ({ data: { disponible: true, motivo: null, filas: [{ version: '2026', nombre: `${CODIGO}_x` }] }, error: null });
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (tabla: string) => ({
      select: async () => tabla === 'cron_latido'
        ? { data: latidos, error: null }
        : (dbFalla ? { count: null, error: { message: 'caída' } } : { count: 0, error: null }),
    }),
    rpc: async (fn: string) => (fn === 'migraciones_aplicadas' ? rpcMigraciones() : { data: null, error: { message: `rpc desconocida ${fn}` } }),
  }),
}));
vi.mock('@/lib/logger', async (original) => ({
  ...await original<Record<string, unknown>>(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const alertarOperador = vi.fn(async (..._a: unknown[]) => {});
const alertarHuecoConfiguracion = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@/lib/observability/alerta', () => ({
  alertarOperador: (...a: unknown[]) => alertarOperador(...(a as [])),
  alertarHuecoConfiguracion: (...a: unknown[]) => alertarHuecoConfiguracion(...(a as [])),
}));

// OPERABILIDAD-19C2-3: permitido por default en todas las pruebas de este
// archivo — el rate limit tiene su propio caso dedicado abajo.
let permitido = true;
vi.mock('@/lib/ratelimit', () => ({
  rateLimit: async () => permitido,
  clientIp: () => '203.0.113.5',
}));

const { GET } = await import('./route');
const peticion = () => new Request('https://app.likida.ai/api/health') as never;

describe('/api/health', () => {
  it('sin latidos todavía: degraded y el cuerpo solo trae pulso (nada de negocio)', async () => {
    dbFalla = false;
    alertarOperador.mockClear();
    const r = await GET(peticion());
    expect(r.status).toBe(503);
    const c = await r.json();
    expect(c.ok).toBe(false);
    expect(Object.keys(c).sort()).toEqual(['checks', 'hora', 'migracion', 'ok', 'status', 'version']);
    expect(c.status).toBe('degraded');
    // AUDITORÍA 24, OP-P4: once crons que nunca latieron no son «unknown»:
    // son crons muertos, y el operador se entera por su canal.
    expect(c.checks.crons).toBe('degraded');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(alertarOperador).toHaveBeenCalledWith('cron.sin_latido', expect.objectContaining({
      codigo: 'cron_sin_latido', error: expect.stringContaining('nunca latió'),
    }));
    // Ni tablas, ni tenants, ni correos: el health es público a propósito.
    expect(JSON.stringify(c)).not.toMatch(/tenant_id|@|supabase/i);
  });

  it('con todos los latidos frescos: 200 y ok true', async () => {
    dbFalla = false;
    const ahora = new Date().toISOString();
    // La lista REAL de crons, no una copia: la copia se quedó vieja al nacer
    // `asistencia` (Fase 5) y esta prueba llamó enfermo a un sistema sano.
    latidos = [...CRONS].map((id) => ({ id, ultimo_latido: ahora, estado: 'ok' }));
    const r = await GET(peticion());
    const c = await r.json();
    expect(r.status).toBe(200);
    expect(c).toMatchObject({ ok: true, status: 'ok', checks: { db: 'ok', crons: 'ok' } });
  });

  beforeEach(() => { latidos = []; permitido = true; });

  it('OPERABILIDAD-19C2-3: excedido el límite de tasa por IP, 429 sin tocar la base', async () => {
    permitido = false;
    const r = await GET(peticion());
    expect(r.status).toBe(429);
    const c = await r.json();
    expect(c.ok).toBe(false);
  });

  // RES-7: un cron vencido degrada el monitor y el detalle de qué cron fue se
  // queda en logs/alerta privados, no en el endpoint público.
  it('un cron vencido degrada el health y alerta al operador sin fuga pública', async () => {
    dbFalla = false;
    alertarOperador.mockClear();
    latidos = [
      // Tres horas sin latir: vencido con cualquier cadencia de las cortas.
      { id: 'wa-pendientes', ultimo_latido: new Date(Date.now() - 180 * 60_000).toISOString(), estado: 'ok' },
      { id: 'escalar', ultimo_latido: new Date(Date.now() - 30 * 60_000).toISOString(), estado: 'ok' },
    ];
    const r = await GET(peticion());
    expect(r.status).toBe(503);
    const c = await r.json();
    expect(c).toMatchObject({ ok: false, status: 'degraded', checks: { db: 'ok', crons: 'degraded' } });
    expect(JSON.stringify(c)).not.toContain('wa-pendientes');
    expect(alertarOperador).toHaveBeenCalledWith('cron.sin_latido', expect.objectContaining({ codigo: 'cron_sin_latido' }));
    latidos = [];
  });

  it('un latido fresco en fallo también degrada: frescura no oculta el resultado', async () => {
    dbFalla = false;
    alertarOperador.mockClear();
    const ahora = new Date().toISOString();
    latidos = ['wa-pendientes', 'wa-outbox', 'escalar', 'facturar', 'purgar', 'runner', 'gps']
      .map((id) => ({ id, ultimo_latido: ahora, estado: id === 'runner' ? 'fallo' : 'ok' }));

    const r = await GET(peticion());
    const c = await r.json();

    expect(r.status).toBe(503);
    expect(c).toMatchObject({ ok: false, status: 'degraded', checks: { db: 'ok', crons: 'degraded' } });
    expect(JSON.stringify(c)).not.toContain('runner');
    expect(alertarOperador).toHaveBeenCalledWith('cron.estado_no_ok', expect.objectContaining({ codigo: 'cron_estado_no_ok' }));
  });

  // AUDITORÍA PROD 29-ago-2026: ocho correos "Urgente" en doce horas por
  // `descarga-sat` sin LIKIDA_SAT_PROVEEDOR — un hueco de configuración que el
  // propio cron ya declaró con toda precisión, indistinguible de una
  // regresión real porque `alertarOperador('cron.estado_no_ok', ...)` se
  // disparaba en CADA ping de un monitor externo. Fija el comportamiento
  // nuevo: el health sigue diciendo la verdad (503/degraded), pero el hueco
  // declarado ya NO manda el correo urgente repetido.
  // ── AUDITORÍA 22, OP-C1 (CRÍTICO): ESTA PRUEBA CAMBIÓ DE VEREDICTO ───────
  // Antes fijaba `status:'degraded'` + 503 para un hueco de configuración
  // DECLARADO. Esa decisión, tomada de buena fe, tuvo una consecuencia que solo
  // se ve en producción: el watchdog (`salud-produccion.yml`) exige
  // `estado=ok`, así que `descarga-sat` sin LIKIDA_SAT_PROVEEDOR lo dejó rojo
  // 30 corridas seguidas — y una muerte REAL de cron se veía idéntica al ruido
  // conocido. El único detector automático de cron muerto no podía cambiar de
  // color, y de paso arrastraba el cotejo del sha desplegado, que nunca corría.
  //
  // El hueco no se oculta: se publica como `checks.crons='config_ausente'`, un
  // tercer estado propio, y conserva su canal de aviso. Lo que deja de hacer es
  // tumbar el pulso, porque una alarma que no puede apagarse no es una alarma.
  it('hueco de configuración declarado: se DISTINGUE, no tumba el pulso, y conserva su canal', async () => {
    dbFalla = false;
    alertarOperador.mockClear();
    alertarHuecoConfiguracion.mockClear();
    const ahora = new Date().toISOString();
    latidos = frescos({
      id: 'descarga-sat',
      ultimo_latido: ahora,
      estado: 'parcial',
      detalle: {
        motivo: 'La descarga masiva no está configurada: falta LIKIDA_SAT_PROVEEDOR en el servidor. Lo destraba Javier (contrato con el PAC y variables de entorno).',
      },
    });

    const r = await GET(peticion());
    const c = await r.json();

    // El monitor externo sigue viendo la verdad —el cron no está sano— pero
    // ahora puede distinguirla de una regresión: es un estado propio.
    expect(r.status).toBe(200);
    expect(c).toMatchObject({ ok: true, status: 'ok', checks: { db: 'ok', crons: 'config_ausente' } });
    // Pero el canal urgente no se dispara por un hueco ya conocido...
    expect(alertarOperador).not.toHaveBeenCalled();
    // ...se avisa por el canal de "pendiente de configurar", con el motivo tal cual.
    expect(alertarHuecoConfiguracion).toHaveBeenCalledWith(
      'cron.config_ausente:descarga-sat',
      expect.stringMatching(/LIKIDA_SAT_PROVEEDOR/),
      expect.objectContaining({ cron: 'descarga-sat' }),
    );
  });

  it('un hueco declarado y una regresión real a la vez: cada quien su canal', async () => {
    dbFalla = false;
    alertarOperador.mockClear();
    alertarHuecoConfiguracion.mockClear();
    const ahora = new Date().toISOString();
    latidos = frescos(
      {
        id: 'descarga-sat',
        ultimo_latido: ahora,
        estado: 'parcial',
        detalle: { motivo: 'La descarga masiva no está configurada: falta LIKIDA_SAT_PROVEEDOR en el servidor.' },
      },
      // `runner` sí se rompió de verdad: nada en su motivo habla de configurar.
      { id: 'runner', ultimo_latido: ahora, estado: 'fallo', detalle: { codigo: 'timeout_proveedor' } },
    );

    const r = await GET(peticion());
    const c = await r.json();

    expect(r.status).toBe(503);
    expect(c).toMatchObject({ ok: false, status: 'degraded', checks: { db: 'ok', crons: 'degraded' } });
    // La regresión real SIGUE alertando por el canal urgente de siempre.
    expect(alertarOperador).toHaveBeenCalledWith('cron.estado_no_ok', expect.objectContaining({
      error: expect.stringContaining('runner'),
    }));
    expect(alertarOperador).toHaveBeenCalledTimes(1);
    // El nombre del cron que sí se rompió no se cuela en el aviso del hueco.
    const detalleUrgente = alertarOperador.mock.calls[0]?.[1] as { error?: string } | undefined;
    expect(detalleUrgente?.error).not.toContain('descarga-sat');
    // El hueco declarado sigue yendo por su propio canal, no por el urgente.
    expect(alertarHuecoConfiguracion).toHaveBeenCalledWith(
      'cron.config_ausente:descarga-sat',
      expect.stringMatching(/LIKIDA_SAT_PROVEEDOR/),
      expect.anything(),
    );
  });

  // AUDITORÍA 21 (29-ago-2026): antes de `configAusente`, esta redacción — una
  // de las otras tres ramas reales de `estadoDescargaSat()` — no matcheaba el
  // regex viejo ("no está configurado"/"no configurado") y caía como
  // regresión real, disparando el correo "Urgente" cada hora para una
  // variable que ya está parcialmente puesta.
  it('hueco de configuración con una redacción que el regex viejo NO reconocía: la señal estructurada lo salva', async () => {
    dbFalla = false;
    alertarOperador.mockClear();
    alertarHuecoConfiguracion.mockClear();
    const ahora = new Date().toISOString();
    latidos = frescos({
      id: 'descarga-sat',
      ultimo_latido: ahora,
      estado: 'parcial',
      detalle: {
        motivo: 'El camino directo al SAT está declarado pero NO construido: cambia LIKIDA_SAT_PROVEEDOR a «sw».',
        configAusente: true,
      },
    });

    const r = await GET(peticion());
    const c = await r.json();

    // Mismo cambio de veredicto que arriba (auditoría 22, OP-C1): lo que se
    // afirma aquí es que la señal ESTRUCTURADA lo clasifica como hueco, y eso
    // sigue siendo cierto — ahora con su estado propio en vez de `degraded`.
    expect(r.status).toBe(200);
    expect(c).toMatchObject({ ok: true, status: 'ok', checks: { db: 'ok', crons: 'config_ausente' } });
    expect(alertarOperador).not.toHaveBeenCalled();
    expect(alertarHuecoConfiguracion).toHaveBeenCalledWith(
      'cron.config_ausente:descarga-sat',
      expect.stringMatching(/NO construido/),
      expect.objectContaining({ cron: 'descarga-sat' }),
    );
  });

  it('con la base caída: 503 y fail — lo que un monitor entiende sin leer el cuerpo', async () => {
    dbFalla = true;
    const r = await GET(peticion());
    expect(r.status).toBe(503);
    const c = await r.json();
    expect(c.ok).toBe(false);
    expect(c.status).toBe('fail');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA PROD (22-ago-2026) · SEG-1 — ¿el límite de tasa es global o de
// mentira?
//
// Sin `UPSTASH_REDIS_REST_URL`/`TOKEN`, `ratelimit.ts` cuenta en la memoria de
// CADA instancia: 10 intentos de login por 5 minutos se vuelven 10 × las
// lambdas que quien insiste consiga abrir. Eso solo se sabía leyendo la línea
// de arranque de una instancia que ya hubiera atendido algo. Ahora se pregunta
// desde fuera, en cualquier momento.
// ═══════════════════════════════════════════════════════════════════════════
describe('/api/health — no expone configuración interna', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('no expone Sentry, Redis ni nombres de infraestructura', async () => {
    dbFalla = false;
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://fake.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'tok');
    const c = await (await GET(peticion())).json();
    expect(JSON.stringify(c)).not.toMatch(/upstash|sentry|token|wa-pendientes/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 22 · OP-C1 (CRÍTICO) — el detector tiene que poder cambiar de color.
//
// Lo que rompía, medido con la API de GitHub: 30 corridas consecutivas de
// `salud-produccion.yml` en `failure`, incluida la programada del día. La causa
// era un hueco de configuración declarado que degradaba el health para siempre.
// Con el watchdog clavado en rojo, un cron REALMENTE muerto no cambiaba nada en
// pantalla — que es la definición de no tener detector.
// ═══════════════════════════════════════════════════════════════════════════
describe('OP-C1: hueco de configuración y cron muerto ya no se ven igual', () => {
  const conLatidos = async (ls: unknown[]) => {
    dbFalla = false;
    latidos = frescos(...(ls as Fila[]));
    const r = await GET(peticion());
    return { http: r.status, cuerpo: await r.json() };
  };
  const ahora = () => new Date().toISOString();
  const HUECO = {
    id: 'descarga-sat', ultimo_latido: ahora(), estado: 'parcial',
    detalle: { motivo: 'falta LIKIDA_SAT_PROVEEDOR en el servidor' },
  };

  it('solo huecos declarados ⇒ el pulso pasa, marcado como config_ausente', async () => {
    const { http, cuerpo } = await conLatidos([HUECO]);
    expect(http).toBe(200);
    expect(cuerpo.checks.crons).toBe('config_ausente');
  });

  it('un cron VENCIDO sí tumba el pulso, aunque haya un hueco declarado al lado', async () => {
    // Éste es el escenario que el watchdog clavado en rojo no podía distinguir.
    const viejo = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const { http, cuerpo } = await conLatidos([
      HUECO,
      { id: 'gps', ultimo_latido: viejo, estado: 'ok', detalle: {} },
    ]);
    expect(http).toBe(503);
    expect(cuerpo.status).toBe('degraded');
    expect(cuerpo.checks.crons).toBe('degraded');
  });

  it('una REGRESIÓN real junto a un hueco declarado también tumba el pulso', async () => {
    const { http, cuerpo } = await conLatidos([
      HUECO,
      { id: 'gps', ultimo_latido: ahora(), estado: 'fallo', detalle: { motivo: 'timeout del proveedor' } },
    ]);
    expect(http).toBe(503);
    expect(cuerpo.checks.crons).toBe('degraded');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24 · OP-P4 / OP-C2 / PRU-3 (ALTO) — el health de `master` volvía
// verde con crons que NUNCA latieron.
//
// `sinLatido` se consultaba en la tercera rama, después de `noSanos`. Con la
// tabla `cron_latido` vacía salvo `descarga-sat` en `parcial` por un hueco de
// configuración declarado, el endpoint contestaba `config_ausente` → 200 `ok`
// con diez crons que jamás habían corrido. El escenario del piloto es una base
// restaurada: `wa-outbox` no manda, `facturar` no factura, y el watchdog pasa.
// ═══════════════════════════════════════════════════════════════════════════
describe('OP-P4: un cron que nunca latió es degraded aunque haya un hueco declarado', () => {
  beforeEach(() => { dbFalla = false; alertarOperador.mockClear(); alertarHuecoConfiguracion.mockClear(); });

  it('una sola fila (descarga-sat sin proveedor) con los otros diez sin latir: 503, no 200', async () => {
    latidos = [{
      id: 'descarga-sat', ultimo_latido: new Date().toISOString(), estado: 'parcial',
      detalle: { motivo: 'falta LIKIDA_SAT_PROVEEDOR en el servidor', configAusente: true },
    }];
    const r = await GET(peticion());
    const c = await r.json();
    expect(r.status).toBe(503);
    expect(c).toMatchObject({ ok: false, status: 'degraded', checks: { crons: 'degraded' } });
    // El canal urgente nombra a los muertos; el hueco sigue por el suyo.
    expect(alertarOperador).toHaveBeenCalledWith('cron.sin_latido', expect.objectContaining({
      error: expect.stringMatching(/wa-outbox \(nunca latió\)/),
    }));
    expect(alertarHuecoConfiguracion).toHaveBeenCalledWith('cron.config_ausente:descarga-sat', expect.any(String), expect.anything());
    // Y el nombre del cron no se cuela al cuerpo público.
    expect(JSON.stringify(c)).not.toContain('wa-outbox');
  });

  it('el mismo hueco con los diez restantes frescos: config_ausente y 200 (lo que OP-C1 prometió sigue vivo)', async () => {
    latidos = frescos({
      id: 'descarga-sat', ultimo_latido: new Date().toISOString(), estado: 'parcial',
      detalle: { motivo: 'falta LIKIDA_SAT_PROVEEDOR en el servidor', configAusente: true },
    });
    const r = await GET(peticion());
    expect(r.status).toBe(200);
    expect((await r.json()).checks.crons).toBe('config_ausente');
    expect(alertarOperador).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 24 · OP-P1 (BLOQUEANTE) — la base en 0271 y el código en 0276, y
// nada lo decía. El health publica `migracion: { base, codigo, atras }` y se
// degrada cuando la base va atrás o cuando no se pudo leer.
// ═══════════════════════════════════════════════════════════════════════════
describe('OP-P1: el health coteja la migración de la base contra la del código', () => {
  beforeEach(() => { dbFalla = false; latidos = frescos(); });
  afterEach(() => {
    rpcMigraciones = () => ({ data: { disponible: true, motivo: null, filas: [{ version: '2026', nombre: `${CODIGO}_x` }] }, error: null });
  });

  it('a la par: atras=0, sin motivo, y el pulso sigue en 200', async () => {
    const r = await GET(peticion());
    const c = await r.json();
    expect(r.status).toBe(200);
    expect(c.migracion).toEqual({ base: CODIGO, codigo: CODIGO, atras: 0, aplicados: [CODIGO] });
  });

  it('la base va atrás: degraded, con cuántas faltan y qué aplicar', async () => {
    rpcMigraciones = () => ({
      data: { disponible: true, motivo: null, filas: [
        { version: '20260830', nombre: '0271_mcp_oauth_rol' },
        { version: '20260829', nombre: '0270_cola_correo' },
        // Las cuatro primeras entraron sin prefijo: no cuentan.
        { version: '20260701', nombre: 'agente_corrida' },
      ] },
      error: null,
    });
    const r = await GET(peticion());
    const c = await r.json();
    expect(r.status).toBe(503);
    expect(c.status).toBe('degraded');
    expect(c.checks.crons).toBe('ok');
    expect(c.migracion).toMatchObject({ base: '0271', codigo: CODIGO, atras: Number(CODIGO) - 271 });
    expect(c.migracion.motivo).toMatch(/aplica 0272\.\./);
  });

  it('no se pudo leer la base: base null, se dice por qué, y NO es verde', async () => {
    rpcMigraciones = () => ({ data: null, error: { message: 'function migraciones_aplicadas() does not exist' } });
    const r = await GET(peticion());
    const c = await r.json();
    expect(r.status).toBe(503);
    expect(c.migracion).toMatchObject({ base: null, codigo: CODIGO, atras: null });
    expect(c.migracion.motivo).toMatch(/no contestó/);
  });

  // AUDITORÍA 25, SEGURIDAD (MEDIO, línea 194, REINCIDENTE). `/api/health` es
  // público a propósito, y `_comun.ts:74` fija la regla para TODA la API
  // pública: el mensaje que se publica «NUNCA lleva el mensaje de Postgres».
  // Los dos casos de abajo mandaban el `error.message`/la excepción CRUDOS
  // de PostgREST/supabase-js directo al JSON público.
  it('el error de PostgREST NO se publica crudo (solo un motivo fijo, en español)', async () => {
    rpcMigraciones = () => ({
      data: null,
      error: { message: 'password authentication failed for user "postgres" at 10.0.4.17:5432' },
    });
    const c = await (await GET(peticion())).json();
    expect(c.migracion.motivo).not.toMatch(/postgres/i);
    expect(c.migracion.motivo).not.toMatch(/10\.0\.4\.17/);
    expect(c.migracion.motivo).toMatch(/no contestó/);
  });

  it('si la llamada LANZA, tampoco se publica el mensaje crudo de la excepción', async () => {
    rpcMigraciones = (): never => { throw new Error('ECONNREFUSED 10.0.4.17:5432'); };
    const c = await (await GET(peticion())).json();
    expect(c.migracion).toMatchObject({ base: null, codigo: CODIGO, atras: null });
    expect(c.migracion.motivo).not.toMatch(/ECONNREFUSED/);
    expect(c.migracion.motivo).not.toMatch(/10\.0\.4\.17/);
    expect(c.migracion.motivo).toMatch(/lanzó/);
  });

  it('la RPC contesta «no disponible» (CI local sin schema_migrations): mismo trato honesto', async () => {
    rpcMigraciones = () => ({ data: { disponible: false, motivo: 'supabase_migrations.schema_migrations no existe en esta base', filas: [] }, error: null });
    const c = await (await GET(peticion())).json();
    expect(c.status).toBe('degraded');
    expect(c.migracion).toMatchObject({ base: null, atras: null, motivo: expect.stringContaining('schema_migrations no existe') });
  });
});

describe('health: cada hueco conserva correlación técnica en Sentry', () => {
  it('dos crons producen códigos acotados distintos sin exponer motivos al saneador ni al health público', async () => {
    const { logger } = await import('@/lib/logger');
    const { sanitizarEventoSentry } = await import('@/lib/observability/sentry');
    vi.mocked(logger.warn).mockClear();
    dbFalla = false; permitido = true;
    const ahora = new Date().toISOString();
    latidos = frescos(...(['descarga-sat', 'gps'] as const).map((id) => ({
      id, ultimo_latido: ahora, estado: 'parcial',
      detalle: { configAusente: true, motivo: 'configuración pendiente para canary@example.invalid' },
    })));
    const response = await GET(peticion());
    const publico = await response.text();
    expect(response.status).toBe(200);
    expect(publico).not.toContain('canary@example.invalid');
    const eventos = vi.mocked(logger.warn).mock.calls
      .filter(([evento]) => evento === 'health.cron_config_ausente')
      .map(([, extra]) => sanitizarEventoSentry({ extra }) as { extra?: Record<string, unknown> });
    expect(eventos).toHaveLength(2);
    expect(eventos.map((e) => e.extra?.codigo).sort()).toEqual([
      'cron_config_ausente:descarga-sat', 'cron_config_ausente:gps',
    ]);
    expect(eventos.map((e) => e.extra?.ruta).sort()).toEqual(['/api/cron/descarga-sat', '/api/cron/gps']);
    expect(JSON.stringify(eventos)).not.toMatch(/canary@example\.invalid|motivo|crons/);
  });
});
