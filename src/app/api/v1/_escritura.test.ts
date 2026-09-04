// ═══════════════════════════════════════════════════════════════════════════
// LAS ESCRITURAS DE /v1, FIJADAS.
//
// Se prueba contra las RUTAS REALES (`POST /v1/viajes`, `POST /v1/unidades`) y
// no contra `_escritura.ts` a solas, porque las tres promesas que hay que
// sostener son de punta a punta y una prueba del módulo suelto no las tocaría:
//
//   1. EL TENANT SALE DE LA CREDENCIAL. El doble de `crearViaje` guarda con qué
//      tenant lo llamaron, así que la prueba falla si alguien lee el `tenant_id`
//      del cuerpo — se comprobó mutando la ruta para que lo leyera y viendo
//      caer la prueba (mismo método que la de IDOR en `_comun.test.ts`).
//   2. UN REINTENTO NO DUPLICA. Con el recuerdo en memoria BORRADO —que es lo
//      que pasa cuando el reintento cae en otra instancia de Vercel— la red que
//      queda es el unique de la base, y se prueba que ahí se atrapa.
//   3. UN AUSENTE NO SE VUELVE CERO. Se mira el ARGUMENTO con el que se llamó a
//      `crearViaje`, no la respuesta: un `null` que se convierte en 0 dentro del
//      motor no se vería desde afuera.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Los dobles ─────────────────────────────────────────────────────────────

/** La sesión por cookie, con la misma forma que `ResultadoTenantApi`. */
let sesion: { tenantId: string | null; rol: string } | null = { tenantId: 't-mia', rol: 'flota_admin' };
const resolverTenantApi = vi.fn(async (): Promise<
  { ok: true; tenantId: string; rol: string } | { ok: false; status: 401 | 403 | 503; motivo: string }
> => {
  if (!sesion || !sesion.tenantId) return { ok: false, status: 401, motivo: 'Necesitas iniciar sesión.' };
  return { ok: true, tenantId: sesion.tenantId, rol: sesion.rol };
});

/** El área de la llave de API, cuando la petición trae `Authorization`. */
let areaDeLaLlave = 'administracion';
const resolverLlave = vi.fn(async () => ({ ok: true as const, tenantId: 't-mia', area: areaDeLaLlave, llaveId: 'l-1' }));

vi.mock('@/lib/auth/tenant-api', () => ({ resolverTenantApi: () => resolverTenantApi() }));
vi.mock('@/lib/auth/llave-api', () => ({
  // Fiel al real: sin él, una petición con `Authorization` no tomaría la rama
  // de la llave y el caso "una llave de tablero no escribe" no se probaría.
  llaveDelHeader: (auth: string | null) => {
    if (!auth) return null;
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    return m ? m[1].trim() : null;
  },
  resolverLlave: () => resolverLlave(),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// El motor. La FIRMA importa tanto como el valor que devuelve: es lo que hace
// que `mock.calls` guarde con qué tenant y con qué campos se le llamó, que es
// donde se comprueban las dos reglas caras (el tenant y el vacío ≠ cero).
const crearViaje = vi.fn(async (tenantId: string, v: Record<string, unknown>): Promise<string> => {
  void tenantId; void v;
  return 'v-nuevo';
});
const crearUnidad = vi.fn(async (tenantId: string, u: Record<string, unknown>): Promise<string> => {
  void tenantId; void u;
  return 'u-nueva';
});
vi.mock('@/lib/likida/operacion', () => ({
  crearViaje: (t: string, v: Record<string, unknown>) => crearViaje(t, v),
  crearUnidad: (t: string, u: Record<string, unknown>) => crearUnidad(t, u),
  // El `GET` del mismo archivo lo importa: sin este export, vitest truena al
  // importar la ruta y ninguna prueba de este archivo llegaría a correr.
  getUnidades: vi.fn(async () => []),
}));
vi.mock('@/lib/likida/analytics', () => ({
  getViajes: vi.fn(async () => []),
  contarViajes: vi.fn(async () => 0),
}));

// ── La base, para las búsquedas por llave natural ──────────────────────────

type Respuesta = { data: Record<string, unknown> | null; error: { message: string } | null };
const respuestas: Record<string, Respuesta> = {
  viaje: { data: null, error: null },
  unidad: { data: null, error: null },
};

// ── La tabla `api_idempotencia` (mig. 0098), la capa durable ───────────────
//
// Se modela con filas de verdad y no con un `maybeSingle` fijo porque lo que
// hay que poder representar es el caso que motivó la tabla: la llave existe
// en la BASE aunque el Map de ESTA instancia esté vacío. Ese es literalmente
// el escenario de dos instancias de Vercel.
interface FilaIdem { tenant_id: string; ruta: string; llave: string; huella: string; status: number; cuerpo: unknown }
const durables: FilaIdem[] = [];
/** Para simular una base que no contesta. */
const fallas = { leer: false, guardar: false };

interface Consulta {
  select: (...a: unknown[]) => Consulta;
  eq: (col: string, val: unknown) => Consulta;
  maybeSingle: () => Promise<Respuesta>;
  upsert: (fila: Record<string, unknown>, o?: unknown) => Promise<{ error: { message: string } | null }>;
}
function consulta(tabla: string): Consulta {
  const filtros: Record<string, unknown> = {};
  const q: Consulta = {
    select: () => q,
    eq: (col, val) => { filtros[col] = val; return q; },
    maybeSingle: async () => {
      if (tabla !== 'api_idempotencia') return respuestas[tabla] ?? { data: null, error: null };
      if (fallas.leer) return { data: null, error: { message: 'PostgREST 503' } };
      const f = durables.find((d) => d.tenant_id === filtros.tenant_id && d.ruta === filtros.ruta && d.llave === filtros.llave);
      return { data: f ? { huella: f.huella, status: f.status, cuerpo: f.cuerpo } as Record<string, unknown> : null, error: null };
    },
    upsert: async (fila) => {
      if (fallas.guardar) return { error: { message: 'no se pudo escribir' } };
      const f = fila as unknown as FilaIdem;
      // `ignoreDuplicates: true`: la primera gana y la segunda no corrige.
      const ya = durables.some((d) => d.tenant_id === f.tenant_id && d.ruta === f.ruta && d.llave === f.llave);
      if (!ya) durables.push({ ...f });
      return { error: null };
    },
  };
  return q;
}
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: (t: string) => consulta(t) }) }));

const { reiniciarLimites } = await import('@/lib/ratelimit');
const {
  reiniciarIdempotencia, leerLlaveIdempotencia, leerCuerpo, huella,
  CABECERA_IDEMPOTENCIA, LARGO_MIN_LLAVE, MAX_CUERPO_BYTES,
} = await import('./_escritura');
const { logger } = await import('@/lib/logger');
const { DatoInvalido } = await import('@/lib/likida/errores');
const { POST: postViaje } = await import('./viajes/route');
const { POST: postUnidad } = await import('./unidades/route');

// ── Utilidades de las pruebas ──────────────────────────────────────────────

const OPERADOR = '11111111-2222-3333-4444-555555555555';
const UNIDAD = '99999999-8888-7777-6666-555555555555';

let n = 0;
interface Opciones {
  cuerpo?: unknown;
  llave?: string | null;
  bearer?: boolean;
  crudo?: string;
}
function peticion(ruta: string, o: Opciones = {}): Request {
  const cabeceras: Record<string, string> = { 'x-forwarded-for': `10.1.0.${++n % 250}.${n}` };
  if (o.llave !== null) cabeceras[CABECERA_IDEMPOTENCIA] = o.llave ?? `idem-${n}-aaaaaaaa`;
  if (o.bearer) cabeceras.authorization = 'Bearer lk_live_abcdef0123456789';
  return new Request(`https://app.likida.ai/api/v1/${ruta}`, {
    method: 'POST',
    headers: cabeceras,
    body: o.crudo ?? JSON.stringify(o.cuerpo ?? {}),
  });
}

/** El cuerpo mínimo que SÍ crea un viaje: folio y operador. */
function viajeMinimo(extra: Record<string, unknown> = {}) {
  return { folio: 'F-001', operadorId: OPERADOR, ...extra };
}

/** La fila que `buscar` encuentra en la base para `viajeMinimo()`: el acuse
 *  MÁS el contenido que ahora viaja en la misma consulta para decidir si la
 *  petición coincide (uuid en minúsculas, como los guarda Postgres). */
function filaViajeMinimo(extra: Record<string, unknown> = {}) {
  return {
    id: 'v-nuevo', folio: 'F-001', estatus: 'abierto',
    operador_id: OPERADOR.toLowerCase(), origen: null, destino: null, fecha_inicio: null,
    unidad_id: null, cliente_id: null, ingreso_flete: null, km_recorridos: null, anticipo: 0,
    ...extra,
  };
}

interface CuerpoLeido {
  error?: { codigo: string; mensaje: string };
  dato?: Record<string, unknown>;
  idempotente?: boolean;
}
async function cuerpoDe(r: Response): Promise<CuerpoLeido> {
  return await r.json();
}

/** Con qué llamaron a `crearViaje` la última vez. */
function argsViaje(): { tenant: string; v: Record<string, unknown> } {
  const c = crearViaje.mock.calls.at(-1);
  if (!c) throw new Error('nunca se llamó a crearViaje');
  return { tenant: c[0], v: c[1] };
}

beforeEach(() => {
  reiniciarLimites();
  reiniciarIdempotencia();
  crearViaje.mockClear();
  crearUnidad.mockClear();
  crearViaje.mockImplementation(async () => 'v-nuevo');
  crearUnidad.mockImplementation(async () => 'u-nueva');
  respuestas.viaje = { data: null, error: null };
  respuestas.unidad = { data: null, error: null };
  durables.length = 0;
  fallas.leer = false;
  fallas.guardar = false;
  sesion = { tenantId: 't-mia', rol: 'flota_admin' };
  areaDeLaLlave = 'administracion';
});

// ═══════════════════════════════════════════════════════════════════════════

describe('el tenant sale de la credencial, JAMÁS del cuerpo', () => {
  it('un `tenant_id` en el JSON se ignora: el viaje se crea en la flota de la credencial', async () => {
    const r = await postViaje(peticion('viajes', {
      cuerpo: viajeMinimo({ tenant_id: 't-otra', tenantId: 't-otra', tenant: 't-otra' }),
    }));
    expect(r.status).toBe(201);
    // La prueba de verdad: con QUÉ tenant se llamó al motor.
    expect(argsViaje().tenant).toBe('t-mia');
    expect(JSON.stringify(argsViaje().v)).not.toContain('t-otra');
  });

  it('lo mismo en unidades', async () => {
    const r = await postUnidad(peticion('unidades', { cuerpo: { numeroEconomico: 'C2-08', tenant_id: 't-otra' } }));
    expect(r.status).toBe(201);
    expect((crearUnidad.mock.calls.at(-1) as unknown as [string, unknown])[0]).toBe('t-mia');
  });

  it('el `tenant_id` del cuerpo tampoco cambia la HUELLA — o sea, no existe para la idempotencia', async () => {
    // Si la huella lo tomara en cuenta, el reintento de un TMS que a veces
    // manda el campo y a veces no se leería como "otra operación" y devolvería
    // un 400 en vez del eco. Que no cambie es la otra cara de que se ignore.
    const llave = 'la-misma-llave-1';
    const a = await postViaje(peticion('viajes', { cuerpo: viajeMinimo(), llave }));
    const b = await postViaje(peticion('viajes', { cuerpo: viajeMinimo({ tenant_id: 't-otra' }), llave }));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(crearViaje).toHaveBeenCalledTimes(1);
  });

  it('la búsqueda por llave natural también se hace contra el tenant de la credencial', async () => {
    // Un viaje con el mismo folio EN OTRA FLOTA no puede aparecer aquí: la
    // consulta lleva `.eq('tenant_id', …)` con el tenant de `abrir()`. Se fija
    // por el lado observable: el doble devuelve fila y el acuse la devuelve
    // como propia sólo porque la consulta ya venía acotada.
    respuestas.viaje = { data: filaViajeMinimo({ id: 'v-ya', estatus: 'liquidado' }), error: null };
    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo() }));
    expect(r.status).toBe(200);
    expect(await cuerpoDe(r)).toEqual({
      dato: { id: 'v-ya', folio: 'F-001', estatus: 'liquidado' }, idempotente: true,
    });
    expect(crearViaje).not.toHaveBeenCalled();
  });
});

describe('escribir NO es leer: el área es `administracion`', () => {
  it('el jefe de tráfico (área operacion) NO puede crear viajes', async () => {
    sesion = { tenantId: 't-mia', rol: 'encargado' };
    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo() }));
    expect(r.status).toBe(403);
    expect((await cuerpoDe(r)).error?.codigo).toBe('sin_permiso');
    expect(crearViaje).not.toHaveBeenCalled();
  });

  it('el contador (área dinero) tampoco', async () => {
    sesion = { tenantId: 't-mia', rol: 'contador' };
    expect((await postViaje(peticion('viajes', { cuerpo: viajeMinimo() }))).status).toBe(403);
    expect((await postUnidad(peticion('unidades', { cuerpo: { numeroEconomico: 'C2-08' } }))).status).toBe(403);
  });

  it('una LLAVE de tablero (área operacion) puede leer viajes pero no meterlos', async () => {
    areaDeLaLlave = 'operacion';
    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo(), bearer: true }));
    expect(r.status).toBe(403);
    expect(crearViaje).not.toHaveBeenCalled();
  });

  it('una llave de `administracion` sí escribe', async () => {
    areaDeLaLlave = 'administracion';
    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo(), bearer: true }));
    expect(r.status).toBe(201);
    expect(argsViaje().tenant).toBe('t-mia');
  });

  it('sin credencial no se escribe nada', async () => {
    sesion = null;
    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo() }));
    expect(r.status).toBe(401);
    expect(crearViaje).not.toHaveBeenCalled();
  });
});

describe('la idempotencia se exige, no se ofrece', () => {
  it(`sin \`${CABECERA_IDEMPOTENCIA}\` no se crea nada, y el 400 dice qué falta`, async () => {
    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo(), llave: null }));
    expect(r.status).toBe(400);
    const c = await cuerpoDe(r);
    expect(c.error?.codigo).toBe('parametro_invalido');
    expect(c.error?.mensaje).toContain(CABECERA_IDEMPOTENCIA);
    expect(crearViaje).not.toHaveBeenCalled();
  });

  it('una llave demasiado corta se rechaza: "1" colisiona entre operaciones distintas', async () => {
    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo(), llave: '1' }));
    expect(r.status).toBe(400);
    expect((await cuerpoDe(r)).error?.mensaje).toContain(String(LARGO_MIN_LLAVE));
  });

  it('una llave con caracteres de control se rechaza (inyección en cabeceras)', () => {
    // Se llama a la función directo: `new Request` ni siquiera deja construir
    // una cabecera con salto de línea, así que por la ruta no se podría probar.
    const fingida = { headers: { get: () => 'abc\ndef-larga' } } as unknown as Request;
    const r = leerLlaveIdempotencia(fingida);
    expect(r.ok).toBe(false);
  });

  it('la MISMA llave con el MISMO cuerpo devuelve la MISMA respuesta y crea UNA sola vez', async () => {
    const llave = 'reintento-del-tms-1';
    const primera = await postViaje(peticion('viajes', { cuerpo: viajeMinimo(), llave }));
    const segunda = await postViaje(peticion('viajes', { cuerpo: viajeMinimo(), llave }));

    expect(primera.status).toBe(201);
    expect(segunda.status).toBe(201);
    expect(await cuerpoDe(segunda)).toEqual(await cuerpoDe(primera));
    expect(crearViaje).toHaveBeenCalledTimes(1);
    // El eco se puede distinguir sin que el cuerpo cambie.
    expect(segunda.headers.get('Idempotent-Replayed')).toBe('true');
    expect(primera.headers.get('Idempotent-Replayed')).toBeNull();
  });

  it('la misma llave con OTRO cuerpo es un 400, no la respuesta vieja', async () => {
    const llave = 'llave-reusada-mal';
    await postViaje(peticion('viajes', { cuerpo: viajeMinimo(), llave }));
    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo({ folio: 'F-002' }), llave }));
    expect(r.status).toBe(400);
    expect((await cuerpoDe(r)).error?.codigo).toBe('parametro_invalido');
    expect(crearViaje).toHaveBeenCalledTimes(1);
  });

  it('EL CASO DEL TIMEOUT: el reintento en otra instancia recibe la MISMA respuesta (capa 3)', async () => {
    // Primera petición: se crea, y la respuesta queda anotada en la tabla.
    const primera = await postViaje(peticion('viajes', { cuerpo: viajeMinimo(), llave: 'timeout-del-tms-1' }));
    expect(primera.status).toBe(201);
    expect(crearViaje).toHaveBeenCalledTimes(1);

    // El TMS no recibió la respuesta y reintenta. Su reintento cae en OTRA
    // instancia de Vercel: memoria vacía, misma llave, mismo cuerpo. La tabla
    // sí la ven las dos.
    reiniciarIdempotencia();
    respuestas.viaje = { data: filaViajeMinimo(), error: null };

    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo(), llave: 'timeout-del-tms-1' }));
    // 201 Y `idempotente: false`: la MISMA respuesta, byte por byte, que la
    // primera vez. Antes de la mig. 0098 aquí llegaba un 200 con
    // `idempotente: true` — no duplicaba (eso lo impide la llave natural) pero
    // tampoco cumplía lo que `Idempotency-Key` promete, que es que reintentar
    // sea indistinguible de haber recibido la respuesta original.
    expect(r.status).toBe(201);
    expect(await cuerpoDe(r)).toEqual({ dato: { id: 'v-nuevo', folio: 'F-001', estatus: 'abierto' }, idempotente: false });
    expect(r.headers.get('Idempotent-Replayed')).toBe('true');
    // LO QUE IMPORTA Y NO CAMBIÓ: no hubo un segundo viaje.
    expect(crearViaje).toHaveBeenCalledTimes(1);
  });

  it('con el recuerdo durable YA PURGADO, el unique de la base sigue evitando el duplicado (capa 2)', async () => {
    // Es el caso real de un reintento que llega días después: la fila de
    // `api_idempotencia` ya se purgó. La capa que queda es la llave natural, y
    // tiene que bastar ella sola — es la única de las tres de la que depende
    // que no haya dos viajes con el mismo folio.
    await postViaje(peticion('viajes', { cuerpo: viajeMinimo(), llave: 'reintento-tardio-1' }));
    expect(crearViaje).toHaveBeenCalledTimes(1);

    reiniciarIdempotencia();
    durables.length = 0;
    respuestas.viaje = { data: filaViajeMinimo(), error: null };

    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo(), llave: 'reintento-tardio-1' }));
    expect(r.status).toBe(200);
    expect(await cuerpoDe(r)).toEqual({ dato: { id: 'v-nuevo', folio: 'F-001', estatus: 'abierto' }, idempotente: true });
    expect(crearViaje).toHaveBeenCalledTimes(1);
  });

  it('la misma llave con OTRO cuerpo es 400 TAMBIÉN cruzando instancias — el hueco que cerró la 0098', async () => {
    // Éste es el caso que motivó la tabla. Antes, con la memoria perdida, la
    // segunda petición encontraba el viaje por su folio y recibía 200 con
    // `idempotente: true`: el integrador se iba convencido de que su
    // corrección se había guardado, y no se había guardado nada.
    await postViaje(peticion('viajes', { cuerpo: viajeMinimo(), llave: 'llave-cruzada-1' }));
    reiniciarIdempotencia();

    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo({ folio: 'F-002' }), llave: 'llave-cruzada-1' }));
    expect(r.status).toBe(400);
    expect((await cuerpoDe(r)).error?.codigo).toBe('parametro_invalido');
    expect(crearViaje).toHaveBeenCalledTimes(1);
  });

  it('si la tabla de idempotencia no se puede LEER, la petición no revienta: cae a la llave natural', async () => {
    // Degradar así es deliberado y es la única vez en el repo que un error de
    // lectura se trata como "no hay nada": esta capa es de conveniencia, y la
    // conducta a la que cae es exactamente la que había antes de que existiera
    // —que no puede duplicar nada—. Fallar cerrado aquí cambiaría un reintento
    // que funciona por uno que devuelve 500.
    await postViaje(peticion('viajes', { cuerpo: viajeMinimo(), llave: 'base-caida-11' }));
    reiniciarIdempotencia();
    fallas.leer = true;
    respuestas.viaje = { data: filaViajeMinimo(), error: null };

    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo(), llave: 'base-caida-11' }));
    expect(r.status).toBe(200);
    expect(crearViaje).toHaveBeenCalledTimes(1);
  });

  it('si el recuerdo no se puede GUARDAR, la creación que YA ocurrió se contesta igual', async () => {
    // Cuando esto corre, el viaje ya está en la base. Dejar que un fallo al
    // anotar el recibo tumbe la respuesta convertiría una creación exitosa en
    // un 500 — y el TMS, obediente, reintentaría una escritura que ya ocurrió.
    fallas.guardar = true;
    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo(), llave: 'no-se-anota-1' }));
    expect(r.status).toBe(201);
    expect((await cuerpoDe(r)).dato).toEqual({ id: 'v-nuevo', folio: 'F-001', estatus: 'abierto' });
    expect(durables).toHaveLength(0);
  });

  it('la respuesta se anota UNA sola vez: la segunda no reescribe la canónica', async () => {
    await postViaje(peticion('viajes', { cuerpo: viajeMinimo(), llave: 'anota-una-vez-1' }));
    reiniciarIdempotencia();
    await postViaje(peticion('viajes', { cuerpo: viajeMinimo(), llave: 'anota-una-vez-1' }));
    expect(durables).toHaveLength(1);
    expect(durables[0].status).toBe(201);
  });

  it('dos llaves DISTINTAS con el mismo folio y el MISMO contenido tampoco duplican — manda la llave natural', async () => {
    await postViaje(peticion('viajes', { cuerpo: viajeMinimo(), llave: 'llave-una-aaaa' }));
    respuestas.viaje = { data: filaViajeMinimo(), error: null };
    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo(), llave: 'llave-dos-bbbb' }));
    expect(r.status).toBe(200);
    expect(crearViaje).toHaveBeenCalledTimes(1);
  });

  it('EL HALLAZGO A8: mismo folio, OTRO contenido, llave NUEVA → 409 que dice que NO se guardó', async () => {
    // Antes: el TMS mandaba el folio existente con montos corregidos y una
    // llave nueva, recibía `200 {idempotente:true}` con la fila VIEJA, y sus
    // montos se descartaban sin log. Se iba convencido de que se guardaron.
    await postViaje(peticion('viajes', { cuerpo: viajeMinimo(), llave: 'primer-alta-aa' }));
    respuestas.viaje = { data: filaViajeMinimo(), error: null };

    const r = await postViaje(peticion('viajes', {
      cuerpo: viajeMinimo({ ingresoFlete: 18500, anticipo: 2500 }),
      llave: 'correccion-bb',
    }));
    expect(r.status).toBe(409);
    const c = await cuerpoDe(r);
    expect(c.error?.codigo).toBe('conflicto');
    expect(c.error?.mensaje).toContain('F-001');
    expect(c.error?.mensaje).toContain('NO se guardaron');
    // No se creó un segundo viaje NI se fingió que se guardó nada.
    expect(crearViaje).toHaveBeenCalledTimes(1);
    // El 409 NO se recuerda: si alguien corrige la fila en el panel, el
    // siguiente POST idéntico del TMS tiene que poder recibir su 200.
    expect(durables.some((d) => d.llave === 'correccion-bb')).toBe(false);
  });

  it('el contenido igual escrito distinto NO es conflicto: uuid en mayúsculas y $500 contra $500.00', async () => {
    respuestas.viaje = {
      data: filaViajeMinimo({ origen: 'CDMX', anticipo: 500 }),
      error: null,
    };
    const r = await postViaje(peticion('viajes', {
      cuerpo: viajeMinimo({ operadorId: OPERADOR.toUpperCase(), origen: 'CDMX', anticipo: 500.0 }),
      llave: 'reintento-formato-cc',
    }));
    expect(r.status).toBe(200);
    expect((await cuerpoDe(r)).idempotente).toBe(true);
    expect(crearViaje).not.toHaveBeenCalled();
  });

  it('la CARRERA con contenido distinto también es 409, no la fila ajena disfrazada de acuse', async () => {
    crearViaje.mockImplementationOnce(async () => {
      throw new Error('crearViaje: duplicate key value violates unique constraint "viaje_folio_unico"');
    });
    let vuelta = 0;
    Object.defineProperty(respuestas, 'viaje', {
      configurable: true,
      get: () => (vuelta++ === 0
        ? { data: null, error: null }
        : { data: filaViajeMinimo({ id: 'v-gano', origen: 'Monterrey' }), error: null }),
      set: () => {},
    });

    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo({ origen: 'Saltillo' }) }));
    expect(r.status).toBe(409);
    expect((await cuerpoDe(r)).error?.codigo).toBe('conflicto');

    Object.defineProperty(respuestas, 'viaje', { configurable: true, writable: true, value: { data: null, error: null } });
  });

  it('una unidad con el mismo número económico y OTRO contenido también es 409', async () => {
    respuestas.unidad = {
      data: { id: 'u-vieja', numero_economico: 'C2-08', placas: 'ABC1234', marca: null, modelo: null, anio: 2019 },
      error: null,
    };
    const r = await postUnidad(peticion('unidades', {
      cuerpo: { numeroEconomico: 'C2-08', placas: 'XYZ9876', anio: 2022 },
      llave: 'unidad-conflicto-dd',
    }));
    expect(r.status).toBe(409);
    const c = await cuerpoDe(r);
    expect(c.error?.codigo).toBe('conflicto');
    expect(c.error?.mensaje).toContain('C2-08');
    expect(crearUnidad).not.toHaveBeenCalled();
  });

  it('la CARRERA: dos peticiones a la vez, la que pierde recibe la fila que ganó, no un 500', async () => {
    // El `buscar` previo dice que no hay; el insert choca contra
    // `viaje_folio_unico` porque la otra petición insertó en medio.
    crearViaje.mockImplementationOnce(async () => {
      throw new Error('crearViaje: duplicate key value violates unique constraint "viaje_folio_unico"');
    });
    let vuelta = 0;
    Object.defineProperty(respuestas, 'viaje', {
      configurable: true,
      get: () => (vuelta++ === 0
        ? { data: null, error: null }
        : { data: filaViajeMinimo({ id: 'v-gano' }), error: null }),
      set: () => {},
    });

    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo() }));
    expect(r.status).toBe(200);
    expect(await cuerpoDe(r)).toEqual({ dato: { id: 'v-gano', folio: 'F-001', estatus: 'abierto' }, idempotente: true });

    // Se devuelve el descriptor normal para las pruebas que siguen.
    Object.defineProperty(respuestas, 'viaje', { configurable: true, writable: true, value: { data: null, error: null } });
  });

  it('si choca contra el unique y la fila NO aparece, se falla ruidoso: no se inventa un id', async () => {
    crearViaje.mockImplementationOnce(async () => {
      throw new Error('crearViaje: duplicate key value violates unique constraint "viaje_folio_unico"');
    });
    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo() }));
    expect(r.status).toBe(500);
    expect(JSON.stringify(await cuerpoDe(r))).not.toContain('duplicate key');
  });

  it('la huella no depende del orden de las llaves del JSON', () => {
    expect(huella({ a: '1', b: null })).toBe(huella({ b: null, a: '1' }));
    expect(huella({ a: '1' })).not.toBe(huella({ a: '2' }));
    // Y un ausente (null) no es un cero: dos operaciones distintas.
    expect(huella({ ingresoFlete: null })).not.toBe(huella({ ingresoFlete: 0 }));
  });
});

describe('validación en el borde: un 400 que dice QUÉ campo', () => {
  const malos: ReadonlyArray<[string, Record<string, unknown>, string]> = [
    ['folio ausente', { operadorId: OPERADOR }, 'folio'],
    ['folio que es un objeto', { folio: { n: 1 }, operadorId: OPERADOR }, 'folio'],
    ['folio vacío', { folio: '   ', operadorId: OPERADOR }, 'folio'],
    ['operadorId ausente', { folio: 'F-1' }, 'operadorId'],
    ['operadorId que no es uuid', { folio: 'F-1', operadorId: 'el-de-siempre' }, 'operadorId'],
    ['unidadId que no es uuid', { folio: 'F-1', operadorId: OPERADOR, unidadId: '123' }, 'unidadId'],
    ['fechaInicio con hora', { folio: 'F-1', operadorId: OPERADOR, fechaInicio: '2026-08-14T23:00:00Z' }, 'fechaInicio'],
    ['fechaInicio que no existe', { folio: 'F-1', operadorId: OPERADOR, fechaInicio: '2026-02-30' }, 'fechaInicio'],
    ['anticipo negativo', { folio: 'F-1', operadorId: OPERADOR, anticipo: -1 }, 'anticipo'],
    ['anticipo con tres decimales', { folio: 'F-1', operadorId: OPERADOR, anticipo: 1234.567 }, 'anticipo'],
    ['anticipo que es texto', { folio: 'F-1', operadorId: OPERADOR, anticipo: 'mucho' }, 'anticipo'],
    ['anticipo booleano', { folio: 'F-1', operadorId: OPERADOR, anticipo: true }, 'anticipo'],
    ['ingresoFlete booleano', { folio: 'F-1', operadorId: OPERADOR, ingresoFlete: true }, 'ingresoFlete'],
  ];

  for (const [nombre, cuerpo, campo] of malos) {
    it(`${nombre} → 400 nombrando \`${campo}\`, y NADA se crea`, async () => {
      const r = await postViaje(peticion('viajes', { cuerpo }));
      expect(r.status).toBe(400);
      const c = await cuerpoDe(r);
      expect(c.error?.codigo).toBe('parametro_invalido');
      expect(c.error?.mensaje).toContain(campo);
      expect(crearViaje).not.toHaveBeenCalled();
    });
  }

  it('un viaje completo llega al motor con TODOS sus campos, tal cual', async () => {
    const cliente = '33333333-4444-5555-6666-777777777777';
    await postViaje(peticion('viajes', {
      cuerpo: viajeMinimo({
        origen: 'Nuevo Laredo', destino: 'Querétaro', fechaInicio: '2026-08-14',
        unidadId: UNIDAD, clienteId: cliente, anticipo: 5000, ingresoFlete: 38500, kmRecorridos: 780,
      }),
    }));
    expect(argsViaje().v).toEqual({
      folio: 'F-001', operadorId: OPERADOR, origen: 'Nuevo Laredo', destino: 'Querétaro',
      fechaInicio: '2026-08-14', unidadId: UNIDAD, clienteId: cliente,
      ingresoFlete: 38_500, kmRecorridos: 780, anticipo: 5_000,
    });
  });

  it('un folio numérico se acepta y se normaliza a texto (un TMS manda las dos formas)', async () => {
    const r = await postViaje(peticion('viajes', { cuerpo: { folio: 12345, operadorId: OPERADOR } }));
    expect(r.status).toBe(201);
    expect(argsViaje().v.folio).toBe('12345');
  });

  it('un folio larguísimo se rechaza en vez de recortarse (un folio truncado dedupea mal)', async () => {
    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo({ folio: 'F'.repeat(65) }) }));
    expect(r.status).toBe(400);
    expect(crearViaje).not.toHaveBeenCalled();
  });

  it('los topes de cordura del motor se enseñan tal cual (son texto escrito para una persona)', async () => {
    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo({ ingresoFlete: 9_000_000 }) }));
    expect(r.status).toBe(400);
    expect((await cuerpoDe(r)).error?.mensaje).toMatch(/cero de más/i);
    expect(crearViaje).not.toHaveBeenCalled();
  });
});

describe('el cuerpo de la petición', () => {
  it('lo que no es JSON es un 400, no un 500', async () => {
    const r = await postViaje(peticion('viajes', { crudo: 'esto no es json' }));
    expect(r.status).toBe(400);
    expect((await cuerpoDe(r)).error?.codigo).toBe('parametro_invalido');
  });

  it('una lista o un valor suelto tampoco son un cuerpo', async () => {
    expect((await postViaje(peticion('viajes', { crudo: '[{"folio":"F-1"}]' }))).status).toBe(400);
    expect((await postViaje(peticion('viajes', { crudo: '"F-1"' }))).status).toBe(400);
    expect((await postViaje(peticion('viajes', { crudo: 'null' }))).status).toBe(400);
  });

  it('un cuerpo más grande que el tope se corta', async () => {
    const gigante = JSON.stringify({ folio: 'F-1', operadorId: OPERADOR, origen: 'x'.repeat(MAX_CUERPO_BYTES) });
    const r = await postViaje(peticion('viajes', { crudo: gigante }));
    expect(r.status).toBe(400);
    expect((await cuerpoDe(r)).error?.mensaje).toContain(String(MAX_CUERPO_BYTES));
    expect(crearViaje).not.toHaveBeenCalled();
  });

  it('un body chunked excesivo se corta durante la lectura, no después de materializarlo', async () => {
    let pedidos = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controlador) {
        pedidos += 1;
        if (pedidos > 20) { controlador.close(); return; }
        controlador.enqueue(new Uint8Array(2_000).fill(120));
      },
    });
    const req = new Request('https://app.likida.ai/api/v1/viajes', {
      method: 'POST', body,
      // @ts-expect-error Node exige duplex para construir Request con stream.
      duplex: 'half',
    });

    const r = await leerCuerpo(req);

    expect(r.ok).toBe(false);
    expect(pedidos).toBeLessThanOrEqual(10);
  });

  it('un `content-length` declarado por encima del tope se corta ANTES de leer el cuerpo', async () => {
    let leido = false;
    const fingida = {
      headers: new Headers({ 'content-length': String(MAX_CUERPO_BYTES + 1) }),
      text: async () => { leido = true; return '{}'; },
    } as unknown as Request;
    const r = await leerCuerpo(fingida);
    expect(r.ok).toBe(false);
    expect(leido).toBe(false);
  });
});

describe('NUNCA inventar una cifra', () => {
  it('un `ingresoFlete` AUSENTE entra como null, no como 0', async () => {
    await postViaje(peticion('viajes', { cuerpo: viajeMinimo() }));
    expect(argsViaje().v.ingresoFlete).toBeNull();
    // Explícito: un 0 aquí diría que el viaje no produjo nada, y su margen
    // saldría -100% con una cifra que se ve plausible.
    expect(argsViaje().v.ingresoFlete).not.toBe(0);
    expect(argsViaje().v.kmRecorridos).toBeNull();
    expect(argsViaje().v.clienteId).toBeNull();
  });

  it('un `ingresoFlete` VACÍO (`""` o `null`) también entra como null', async () => {
    await postViaje(peticion('viajes', { cuerpo: viajeMinimo({ ingresoFlete: '', kmRecorridos: null }) }));
    expect(argsViaje().v.ingresoFlete).toBeNull();
    expect(argsViaje().v.kmRecorridos).toBeNull();
  });

  it('un 0 TECLEADO sí es cero: es una medición (viaje de cortesía, tramo que se factura aparte)', async () => {
    await postViaje(peticion('viajes', { cuerpo: viajeMinimo({ ingresoFlete: 0 }) }));
    expect(argsViaje().v.ingresoFlete).toBe(0);
  });

  it('un monto con formato mexicano se lee entero, no a medias', async () => {
    await postViaje(peticion('viajes', { cuerpo: viajeMinimo({ ingresoFlete: '38,500.00', kmRecorridos: '1200' }) }));
    expect(argsViaje().v.ingresoFlete).toBe(38_500);
    expect(argsViaje().v.kmRecorridos).toBe(1_200);
  });

  it('el anticipo ausente entra como 0 — y es correcto: la columna es NOT NULL DEFAULT 0', async () => {
    // Es el único campo donde ausente se vuelve un número, porque `viaje.anticipo`
    // (0001) no puede guardar "no sé": un viaje sin anticipo declarado es un
    // viaje donde la empresa no adelantó efectivo.
    await postViaje(peticion('viajes', { cuerpo: viajeMinimo() }));
    expect(argsViaje().v.anticipo).toBe(0);
  });

  it('un anticipo con centavos se conserva exacto', async () => {
    await postViaje(peticion('viajes', { cuerpo: viajeMinimo({ anticipo: 1234.56 }) }));
    expect(argsViaje().v.anticipo).toBe(1234.56);
  });
});

describe('nada de lo que pasa por dentro cruza al cuerpo', () => {
  it('un error de Postgres NO sale en la respuesta', async () => {
    crearViaje.mockImplementationOnce(async () => {
      throw new Error('crearViaje: null value in column "operador_id" violates not-null constraint');
    });
    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo() }));
    expect(r.status).toBe(500);
    const cuerpo = await cuerpoDe(r);
    for (const filtrado of ['operador_id', 'not-null', 'violates', 'crearViaje']) {
      expect(JSON.stringify(cuerpo)).not.toContain(filtrado);
    }
    expect(cuerpo.error?.codigo).toBe('error_interno');
  });

  it('una referencia de OTRA flota es un 404 que nombra el campo, no un 500 opaco', async () => {
    crearViaje.mockImplementationOnce(async () => {
      throw new Error('crearViaje: el operador no pertenece a esta flota');
    });
    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo() }));
    expect(r.status).toBe(404);
    const c = await cuerpoDe(r);
    expect(c.error?.codigo).toBe('no_encontrado');
    expect(c.error?.mensaje).toContain('operadorId');
    // El mensaje interno NO se copia: se escribe uno nuevo.
    expect(c.error?.mensaje).not.toContain('crearViaje');
    expect(c.error?.mensaje).not.toContain('no pertenece');
  });

  it('lo mismo para la unidad y para el cliente', async () => {
    crearViaje.mockImplementationOnce(async () => { throw new Error('crearViaje: la unidad no pertenece a esta flota'); });
    expect((await cuerpoDe(await postViaje(peticion('viajes', { cuerpo: viajeMinimo() })))).error?.mensaje).toContain('unidadId');

    crearViaje.mockImplementationOnce(async () => { throw new Error('crearViaje: el cliente no pertenece a esta flota'); });
    expect((await cuerpoDe(await postViaje(peticion('viajes', { cuerpo: viajeMinimo() })))).error?.mensaje).toContain('clienteId');
  });

  it('el invariante "un operador, un viaje abierto" (0029) se explica, no se filtra', async () => {
    crearViaje.mockImplementationOnce(async () => {
      throw new Error('crearViaje: duplicate key value violates unique constraint "uq_viaje_abierto_por_operador"');
    });
    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo() }));
    expect(r.status).toBe(400);
    const c = await cuerpoDe(r);
    expect(c.error?.codigo).toBe('parametro_invalido');
    expect(c.error?.mensaje).toMatch(/viaje abierto/i);
    // Ni el nombre del índice ni el vocabulario de Postgres.
    expect(c.error?.mensaje).not.toContain('uq_viaje');
    expect(c.error?.mensaje).not.toContain('duplicate key');
  });

  // AUDITORÍA 24, BE-13: los candados de baja (`operadorDeBaja`,
  // `unidadDeBaja`, auditoría 20 H2/H4) lanzan `DatoInvalido` con el mensaje ya
  // escrito para una persona. `traducirFalla` no lo distinguía: salía 500
  // `error_interno` con «vuelve a intentar en un momento». El TMS del cliente
  // reintentaba un error que nunca se va a arreglar solo.
  it('BE-13: un operador dado de baja es 400 con SU mensaje, no un 500 «vuelve a intentar»', async () => {
    (logger.error as ReturnType<typeof vi.fn>).mockClear();
    crearViaje.mockImplementationOnce(async () => {
      throw new DatoInvalido('Ese operador está dado de baja en tu flota. Vuelve a marcarlo como activo en Operadores, o asigna el viaje a otro chofer.');
    });

    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo() }));
    const c = await cuerpoDe(r);

    expect(r.status).toBe(400);
    expect(c.error?.codigo).toBe('parametro_invalido');
    expect(c.error?.mensaje).toContain('dado de baja');
    expect(c.error?.mensaje).not.toMatch(/vuelve a intentar/i);
    // Y no ensucia el log de errores: esto es validación, no una falla nuestra.
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('BE-13: lo mismo para una unidad dada de baja', async () => {
    crearViaje.mockImplementationOnce(async () => {
      throw new DatoInvalido('Esa unidad está dada de baja. Si volvió al parque, vuelve a ponerla disponible en Unidades antes de asignarla.');
    });
    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo() }));
    expect(r.status).toBe(400);
    expect((await cuerpoDe(r)).error?.mensaje).toContain('dada de baja');
  });

  it('si la BÚSQUEDA por llave natural falla, se falla cerrado: no se lee como "no existe"', async () => {
    respuestas.viaje = { data: null, error: { message: 'relation "viaje" does not exist' } };
    const r = await postViaje(peticion('viajes', { cuerpo: viajeMinimo() }));
    expect(r.status).toBe(500);
    // No se insertó a ciegas ni se filtró el mensaje.
    expect(crearViaje).not.toHaveBeenCalled();
    expect(JSON.stringify(await cuerpoDe(r))).not.toContain('relation');
  });
});

describe('POST /v1/unidades', () => {
  it('crea la unidad y devuelve su id', async () => {
    const r = await postUnidad(peticion('unidades', {
      cuerpo: { numeroEconomico: 'C2-08', placas: 'ABC-123-4', marca: 'Kenworth', modelo: 'T680', anio: 2019 },
    }));
    expect(r.status).toBe(201);
    expect(await cuerpoDe(r)).toEqual({ dato: { id: 'u-nueva', numeroEconomico: 'C2-08' }, idempotente: false });
    const llamada = crearUnidad.mock.calls.at(-1);
    expect(llamada?.[1]).toEqual({ numeroEconomico: 'C2-08', placas: 'ABC-123-4', marca: 'Kenworth', modelo: 'T680', anio: 2019 });
  });

  it('sin `numeroEconomico` no se crea nada', async () => {
    const r = await postUnidad(peticion('unidades', { cuerpo: { placas: 'ABC-123-4' } }));
    expect(r.status).toBe(400);
    expect((await cuerpoDe(r)).error?.mensaje).toContain('numeroEconomico');
    expect(crearUnidad).not.toHaveBeenCalled();
  });

  it('un `anio` fuera de rango se rechaza (1919 o 2200 son dedazos)', async () => {
    for (const anio of [1919, 2200, 'ayer', 2019.5]) {
      const r = await postUnidad(peticion('unidades', { cuerpo: { numeroEconomico: 'C2-09', anio } }));
      expect(r.status, String(anio)).toBe(400);
    }
    expect(crearUnidad).not.toHaveBeenCalled();
  });

  it('el número económico que YA existe devuelve la unidad de siempre, no una segunda', async () => {
    respuestas.unidad = { data: { id: 'u-vieja', numero_economico: 'C2-08' }, error: null };
    const r = await postUnidad(peticion('unidades', { cuerpo: { numeroEconomico: 'C2-08' } }));
    expect(r.status).toBe(200);
    expect(await cuerpoDe(r)).toEqual({ dato: { id: 'u-vieja', numeroEconomico: 'C2-08' }, idempotente: true });
    expect(crearUnidad).not.toHaveBeenCalled();
  });

  it('el choque contra `unidad_economico_unico` en carrera se resuelve con la fila que ganó', async () => {
    crearUnidad.mockImplementationOnce(async () => {
      throw new Error('crearUnidad: duplicate key value violates unique constraint "unidad_economico_unico"');
    });
    let vuelta = 0;
    Object.defineProperty(respuestas, 'unidad', {
      configurable: true,
      get: () => (vuelta++ === 0
        ? { data: null, error: null }
        : { data: { id: 'u-gano', numero_economico: 'C2-08' }, error: null }),
      set: () => {},
    });

    const r = await postUnidad(peticion('unidades', { cuerpo: { numeroEconomico: 'C2-08' } }));
    expect(r.status).toBe(200);
    expect(await cuerpoDe(r)).toEqual({ dato: { id: 'u-gano', numeroEconomico: 'C2-08' }, idempotente: true });

    Object.defineProperty(respuestas, 'unidad', { configurable: true, writable: true, value: { data: null, error: null } });
  });

  it('también exige la llave de idempotencia', async () => {
    const r = await postUnidad(peticion('unidades', { cuerpo: { numeroEconomico: 'C2-08' }, llave: null }));
    expect(r.status).toBe(400);
    expect(crearUnidad).not.toHaveBeenCalled();
  });
});
