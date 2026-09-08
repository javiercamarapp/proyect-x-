// ═══════════════════════════════════════════════════════════════════════════
// COBERTURA (ronda 16): contactos.ts estaba a 28% — la resolución de la cuenta
// de oficina por teléfono (el "no te tengo registrado" vs la ambigüedad real).
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

const TABLAS: Record<string, unknown[]> = {};
let errorSiguiente: { message: string } | null = null;

function builder() {
  const b: Record<string, unknown> = {};
  const self = () => b;
  // `or` entra con AGEN-1: el filtro de la baja va también en la base. El doble
  // devuelve la tabla entera igual que con los demás encadenados, así que lo que
  // las pruebas de abajo ejercen es la capa de TS — que es donde vive la regla.
  // `range`/`order` entran con el BAJO de la reauditoría 25 (`telefonosJefe`
  // ahora pasa por `traerTodo`) — mismo motivo, no-op en el doble.
  for (const m of ['select', 'in', 'limit', 'eq', 'not', 'or', 'range', 'order']) b[m] = self;
  b.then = (ok: (v: unknown) => unknown) => Promise.resolve({
    data: errorSiguiente ? null : (TABLAS.app_user ?? []), error: errorSiguiente,
  }).then(ok);
  // `telefonoDeUsuario` filtra por `id` exacto y lee una fila (maybeSingle) en
  // vez del patrón array + `.find()` de las demás funciones de este archivo.
  b.maybeSingle = async () => ({
    data: errorSiguiente ? null : ((TABLAS.app_user ?? [])[0] ?? null), error: errorSiguiente,
  });
  return b;
}
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: () => builder() }) }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// `telefonosJefe` (BAJO, reauditoría 25) pasa por `traerTodo` para no
// recortarse en silencio a 1,000 filas. Se mockea como UN solo viaje —la
// paginación real de `pg.ts` tiene su propia suite (`pg.test.ts`)— para que
// estas pruebas sigan ejerciendo el filtro de `activo`, no la paginación; y
// como `vi.fn` para poder comprobar que `telefonosJefe` de verdad pasa por
// aquí y no por un `.limit()` a secas.
const traerTodo = vi.hoisted(() => vi.fn(async (
  construir: (desde: number, hasta: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  consulta: string,
) => {
  const { data, error } = await construir(0, 999);
  if (error) throw new Error(`${consulta}: ${error.message}`);
  return data ?? [];
}));
vi.mock('./pg', () => ({ traerTodo }));

const { resolverCuentaOficina, TelefonoAmbiguo, telefonoJefeDe, telefonoParaDineroDe, telefonosJefe, telefonoDeUsuario } = await import('./contactos');

beforeEach(() => { TABLAS.app_user = []; errorSiguiente = null; traerTodo.mockClear(); });

describe('resolverCuentaOficina — quién es el teléfono', () => {
  const u = (p: Record<string, unknown>) => ({ id: 'u-1', tenant_id: 't-1', rol: 'encargado', nombre: 'Ana', email: 'ana@x.mx', telefono: '529991234567', ...p });

  it('resuelve la cuenta cuando el teléfono coincide', async () => {
    TABLAS.app_user = [u({})];
    const r = await resolverCuentaOficina('529991234567');
    expect(r).toMatchObject({ userId: 'u-1', tenantId: 't-1', rol: 'encargado', nombre: 'Ana' });
  });

  it('null cuando no hay nadie (no es un error: es "no te conozco")', async () => {
    expect(await resolverCuentaOficina('529999999999')).toBeNull();
  });

  it('LANZA TelefonoAmbiguo con dos cuentas (el teléfono de un chofer y de un admin)', async () => {
    TABLAS.app_user = [u({ id: 'u-1' }), u({ id: 'u-2', rol: 'flota_admin' })];
    await expect(resolverCuentaOficina('529991234567')).rejects.toThrow(TelefonoAmbiguo);
  });

  it('LANZA si la base falló (no se afirma "no existe")', async () => {
    errorSiguiente = { message: 'fetch failed' };
    await expect(resolverCuentaOficina('529991234567')).rejects.toThrow(/fetch failed/);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // AUDITORÍA 24 · AGEN-1 — LA BAJA CERRABA EL PANEL Y DEJABA ABIERTO WHATSAPP.
  //
  // La 0294 (SEG-1) le enseñó a la base a dar de baja: `app_user.activo`.
  // `desactivarUsuario` escribe `activo=false`, pone sello, deja bitácora y
  // BANEA la cuenta en Auth. `session.ts:99` la respeta y devuelve `null`.
  //
  // Pero WhatsApp no entra por Auth ni por `session.ts`: entra por
  // `resolverCuentaOficina`, y su `select` no pedía `activo`. O sea que al
  // contador al que la flota le quitó el acceso el viernes le seguía
  // contestando el bot el lunes — y por ese mismo camino pasan los comandos de
  // administración por WhatsApp (`admin_comandos_wa.ts:45`, que declara
  // explícitamente que delega la autenticación en esta función).
  //
  // Escenario medido: `activo=false` y teléfono 529991234567 → antes devolvía
  // la cuenta con rol `flota_admin`; ahora devuelve `null`, que es como esta
  // capa nombra «no te conozco».
  //
  // Solo el `false` EXPLÍCITO da de baja, igual que en `session.ts:99`: una
  // fila sin la columna (base sin la 0294) sigue entrando. La columna nueva no
  // puede dejar fuera a toda la base.
  // ═════════════════════════════════════════════════════════════════════════
  it('una cuenta dada de baja (activo=false) es "no te conozco" también por WhatsApp', async () => {
    TABLAS.app_user = [u({ rol: 'flota_admin', activo: false })];
    expect(await resolverCuentaOficina('529991234567')).toBeNull();
  });

  it('activo=true entra igual que antes', async () => {
    TABLAS.app_user = [u({ activo: true })];
    expect(await resolverCuentaOficina('529991234567')).toMatchObject({ userId: 'u-1' });
  });

  it('la columna ausente (base sin la 0294) NO da de baja a nadie', async () => {
    TABLAS.app_user = [u({})];
    expect(await resolverCuentaOficina('529991234567')).toMatchObject({ userId: 'u-1' });
  });

  it('la ambigüedad se juzga sobre las cuentas VIVAS: una de baja no la provoca', async () => {
    // Si la de baja siguiera contando, dar de baja a alguien rompería el
    // teléfono de quien se quedó: `TelefonoAmbiguo` en vez de su cuenta.
    TABLAS.app_user = [u({ id: 'u-1' }), u({ id: 'u-2', rol: 'flota_admin', activo: false })];
    expect(await resolverCuentaOficina('529991234567')).toMatchObject({ userId: 'u-1' });
  });

  it('telefonoJefeDe devuelve null sin jefe asignado', async () => {
    expect(await telefonoJefeDe('t-1')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 25 · AGEN-C1 — LA BAJA CERRABA LA ENTRADA Y DEJABA ABIERTA LA SALIDA.
//
// El hallazgo de la 24 (AGEN-1) nombraba TRES resolutores de "a qué número se
// le escribe". El arreglo `70dd5c6` tocó UNO: `resolverCuentaOficina`, la
// puerta de ENTRADA. Las dos de SALIDA que viven en este archivo siguieron
// preguntando por `tenant_id` y `rol` sin mirar `activo`, y `desactivarUsuario`
// (`usuarios_escritura.ts:191`) escribe `activo=false` pero NO borra
// `app_user.telefono`: el número se queda ahí para que estas consultas lo
// encuentren.
//
// Escenario medido: a la contadora dada de baja el viernes le seguían saliendo,
// el lunes, el texto con anticipo/comprobado/diferencia y el `sendDocument` del
// ejemplar del CONTRALOR (RFC, folios y los veredictos SOLO_CONTRALOR).
//
// El caso canónico es el CONTADOR, no el dueño: `usuarios_escritura.ts:186`
// impide dar de baja al ÚNICO `flota_admin` activo, pero no hay guarda análoga
// para `contador` — y con dos dueños el `.find()` puede quedarse igual con la
// fila de baja, porque el orden de las filas no está definido.
//
// Misma regla que la 24 y por la misma razón: solo el `false` EXPLÍCITO da de
// baja. Una fila sin la columna (base sin la 0294) sigue entrando; la columna
// nueva no puede dejar sin avisos a toda la base.
// ═══════════════════════════════════════════════════════════════════════════
describe('AGEN-C1 · la salida también respeta la baja', () => {
  const c = (p: Record<string, unknown>) => ({ tenant_id: 't-1', rol: 'contador', telefono: '5219993700779', ...p });

  it('telefonoParaDineroDe NO devuelve el teléfono de una cuenta dada de baja', async () => {
    TABLAS.app_user = [c({ activo: false })];
    expect(await telefonoParaDineroDe('t-1')).toBeNull();
  });

  it('telefonoParaDineroDe prefiere la cuenta VIVA aunque la de baja venga primero', async () => {
    // Sin el filtro, `.find()` se queda con la primera fila del rol y manda las
    // cifras del cierre al ex-empleado teniendo al contador vivo al lado.
    TABLAS.app_user = [
      c({ rol: 'flota_admin', telefono: '5219990000001', activo: false }),
      c({ rol: 'flota_admin', telefono: '5219990000002', activo: true }),
    ];
    expect(await telefonoParaDineroDe('t-1')).toBe('5219990000002');
  });

  // Ojo con el nombre que esta prueba tenía antes («base sin la 0294»): eso NO
  // es lo que ejerce, y la reauditoría de la 25 lo cazó. La 0294 declara
  // `activo boolean not null default true` (`0294:47`), así que una base sin
  // ella no devuelve filas sin la llave: no tiene la columna, el `select` da
  // 42703 y la función LANZA. Lo que esta prueba fija es lo otro, que sigue
  // valiendo: la capa de TS juzga por `!== false`, no por ausencia de `true`,
  // así que un `undefined` no da de baja a nadie por accidente.
  it('un `activo` ausente en la fila NO da de baja: solo el false explícito', async () => {
    TABLAS.app_user = [c({})];
    expect(await telefonoParaDineroDe('t-1')).toBe('5219993700779');
  });

  it('telefonosJefe deja la flota FUERA del mapa si su único contacto está de baja', async () => {
    // Incompleto, no inventado: quien llama ya trata la ausencia como "no hay a
    // quién avisar". Meter al de baja es peor que no tener a nadie.
    TABLAS.app_user = [c({ rol: 'encargado', activo: false })];
    expect(await telefonosJefe(['t-1'])).toEqual({});
  });

  it('telefonosJefe salta al siguiente rol del orden cuando el primero está de baja', async () => {
    TABLAS.app_user = [
      c({ rol: 'encargado', telefono: '5219990000003', activo: false }),
      c({ rol: 'flota_admin', telefono: '5219990000004', activo: true }),
    ];
    expect(await telefonosJefe(['t-1'])).toEqual({ 't-1': '5219990000004' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BAJO (reauditoría 25) — `telefonosJefe` no tenía techo de filas.
// `escalar_viaje.ts` la llama con TODOS los tenants que tienen viajes
// vencidos en una corrida; sin `traerTodo` (o `.limit()`), PostgREST recorta
// a 1,000 filas EN SILENCIO y las flotas fuera del corte desaparecen del mapa
// como si no tuvieran contacto (CLAUDE.md: "PostgREST recorta a 1,000 filas
// en silencio" — la trampa que este archivo evita en el resto de sus
// consultas desde la auditoría 18/A23).
// ═══════════════════════════════════════════════════════════════════════════
describe('BAJO (reauditoría 25) · telefonosJefe pagina en vez de recortarse en silencio', () => {
  it('la consulta pasa por `traerTodo`, no por un `.limit()` a secas', async () => {
    TABLAS.app_user = [{ tenant_id: 't-1', rol: 'flota_admin', telefono: '5219990000005', activo: true }];
    await telefonosJefe(['t-1']);
    expect(traerTodo).toHaveBeenCalledWith(expect.any(Function), 'telefonosJefe');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 28, ALTO (AG-A4) — `telefonoDeUsuario`: el teléfono de UN humano
// puntual (quien autorizó una coordinación de proveedor), con el mismo
// criterio de `activo` que el resto del archivo.
// ═══════════════════════════════════════════════════════════════════════════
describe('telefonoDeUsuario — el teléfono de UN humano puntual', () => {
  it('devuelve el teléfono cuando la cuenta está activa', async () => {
    TABLAS.app_user = [{ telefono: '5219990001111', activo: true }];
    expect(await telefonoDeUsuario('u-1', 't-1')).toBe('5219990001111');
  });

  it('null si la cuenta está dada de baja (activo=false), aunque tenga teléfono capturado', async () => {
    TABLAS.app_user = [{ telefono: '5219990001111', activo: false }];
    expect(await telefonoDeUsuario('u-1', 't-1')).toBeNull();
  });

  it('un `activo` ausente NO da de baja — solo el false explícito', async () => {
    TABLAS.app_user = [{ telefono: '5219990001111' }];
    expect(await telefonoDeUsuario('u-1', 't-1')).toBe('5219990001111');
  });

  it('null si no hay fila (usuario de otro tenant, o inexistente)', async () => {
    TABLAS.app_user = [];
    expect(await telefonoDeUsuario('u-1', 't-1')).toBeNull();
  });

  it('LANZA si la base falló (no se afirma "sin teléfono")', async () => {
    errorSiguiente = { message: 'fetch failed' };
    await expect(telefonoDeUsuario('u-1', 't-1')).rejects.toThrow(/fetch failed/);
  });
});
