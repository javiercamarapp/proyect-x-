// ═══════════════════════════════════════════════════════════════════════════
// GESTIÓN DEL EQUIPO (auditoría 24, SEG-1 / H5).
//
// Lo que se fija NO es que el mock de Supabase funcione: es lo que el motor
// le MANDA y a qué reacciona —
//   · todo UPDATE va anclado a `tenant_id` y comprueba filas devueltas;
//   · la baja escribe `activo=false` + sello + BAN en Auth + bitácora;
//   · nadie se toca a sí mismo, ni al superadmin, ni al último dueño;
//   · un ban que falla se DICE (`sesionRevocada:false`), no se finge.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Registro = {
  tabla: string; op: string | null; payload: unknown;
  eq: Array<[string, unknown]>; neq: Array<[string, unknown]>; select: string | null; head: boolean;
};
type Respuesta = { data?: unknown; error?: { message: string } | null; count?: number | null };

const llamadas: Registro[] = [];
const colas = new Map<string, Respuesta[]>();

function contestar(tabla: string): Respuesta {
  const cola = colas.get(tabla) ?? [];
  const r = cola.length > 1 ? cola.shift() : cola[0];
  return r ?? { data: null, error: null };
}

function builder(tabla: string) {
  const r: Registro = { tabla, op: null, payload: null, eq: [], neq: [], select: null, head: false };
  llamadas.push(r);
  const b: Record<string, unknown> = {};
  b.update = (p: unknown) => { r.op = 'update'; r.payload = p; return b; };
  b.select = (cols: string, opts?: { head?: boolean }) => { r.select = cols; r.head = !!opts?.head; if (!r.op) r.op = 'select'; return b; };
  b.eq = (c: string, v: unknown) => { r.eq.push([c, v]); return b; };
  b.neq = (c: string, v: unknown) => { r.neq.push([c, v]); return b; };
  b.maybeSingle = async () => contestar(tabla);
  b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(contestar(tabla)).then(res, rej);
  return b;
}

const updateUserById = vi.fn(async (..._a: unknown[]): Promise<{ error: { message: string } | null }> => ({ error: null }));
// SEC-3 (auditoría 25, MEDIO, re-auditoría): `revocar_mcp_oauth_usuario` —
// la RPC hermana de `mcp_oauth_usuario_vigente` (0265) que tumba de un tiro
// TODOS los tokens MCP vivos de un usuario en su tenant.
const rpc = vi.fn(async (..._a: unknown[]): Promise<{ data?: unknown; error: { message: string } | null }> => ({ data: 0, error: null }));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: (t: string) => builder(t),
    auth: { admin: { updateUserById: (...a: unknown[]) => updateUserById(...a) } },
    rpc: (...a: unknown[]) => rpc(...a),
  }),
}));
const anotarBitacora = vi.fn(async () => true);
vi.mock('@/lib/likida/bitacora_escritura', () => ({ anotarBitacora: (...a: unknown[]) => anotarBitacora(...(a as [])) }));
const enviarCorreo = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: true, id: 'm-1' }));
vi.mock('@/lib/correo/enviar', () => ({ enviarCorreo: (...a: unknown[]) => enviarCorreo(...(a as [])) }));
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger }));

const {
  cambiarRolUsuario, desactivarUsuario, reactivarUsuario, reenviarAcceso, enviarCorreoDeAcceso, BAN_PERMANENTE,
} = await import('./usuarios_escritura');
const { DatoInvalido } = await import('@/lib/likida/errores');

const TENANT = 't-flota-1';
const U = '11111111-2222-4333-8444-555555555555';
const OTRO = '22222222-2222-4333-8444-555555555555';
const ACTOR = { id: OTRO, email: 'duena@flota.mx' };

const fila = (extra: Record<string, unknown> = {}) =>
  ({ id: U, email: 'conta@flota.mx', nombre: 'Ana', rol: 'contador', activo: true, ...extra });

function updatesDe(tabla: string) { return llamadas.filter((l) => l.tabla === tabla && l.op === 'update'); }

beforeEach(() => {
  llamadas.length = 0;
  colas.clear();
  updateUserById.mockClear();
  updateUserById.mockResolvedValue({ error: null });
  rpc.mockClear();
  rpc.mockResolvedValue({ data: 2, error: null });
  anotarBitacora.mockClear();
  enviarCorreo.mockClear();
  enviarCorreo.mockResolvedValue({ ok: true, id: 'm-1' });
  logger.error.mockClear();
});

describe('cambiarRolUsuario', () => {
  it('actualiza anclado a tenant y al rol actual, y anota de→a en bitácora', async () => {
    colas.set('app_user', [{ data: fila() }, { data: [{ id: U }] }]);
    const r = await cambiarRolUsuario(TENANT, U, 'encargado', ACTOR);
    expect(r).toEqual({ de: 'contador', a: 'encargado' });
    const [up] = updatesDe('app_user');
    expect(up.payload).toEqual({ rol: 'encargado' });
    expect(up.eq).toEqual(expect.arrayContaining([['id', U], ['tenant_id', TENANT], ['rol', 'contador']]));
    expect(anotarBitacora).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, accion: 'usuario.rol_cambiado', entidad: 'app_user', entidadId: U, detalle: { de: 'contador', a: 'encargado' } }),
      expect.anything(),
    );
  });

  it('rechaza roles fuera del catálogo (superadmin, operador, basura) ANTES de leer nada', async () => {
    for (const rol of ['superadmin', 'operador', 'vendedor', 'x']) {
      await expect(cambiarRolUsuario(TENANT, U, rol, ACTOR)).rejects.toBeInstanceOf(DatoInvalido);
    }
    expect(llamadas).toHaveLength(0);
  });

  it('nadie se cambia el rol a sí mismo', async () => {
    await expect(cambiarRolUsuario(TENANT, U, 'contador', { id: U })).rejects.toThrow(/a ti mismo/);
    expect(llamadas).toHaveLength(0);
  });

  it('una cuenta de otra flota (o inexistente) es «no está en tu equipo»: no toca nada', async () => {
    colas.set('app_user', [{ data: null }]);
    await expect(cambiarRolUsuario(TENANT, U, 'encargado', ACTOR)).rejects.toThrow(/no está en tu equipo/);
    expect(updatesDe('app_user')).toHaveLength(0);
    const [lectura] = llamadas;
    expect(lectura.eq).toEqual(expect.arrayContaining([['id', U], ['tenant_id', TENANT]]));
  });

  it('un superadmin no se administra desde el panel del cliente', async () => {
    colas.set('app_user', [{ data: fila({ rol: 'superadmin' }) }]);
    await expect(cambiarRolUsuario(TENANT, U, 'contador', ACTOR)).rejects.toThrow(/de Likida/);
    expect(updatesDe('app_user')).toHaveLength(0);
  });

  it('el ÚLTIMO dueño activo no se degrada (count real, no .length)', async () => {
    colas.set('app_user', [{ data: fila({ rol: 'flota_admin' }) }, { count: 0, data: null }]);
    await expect(cambiarRolUsuario(TENANT, U, 'contador', ACTOR)).rejects.toThrow(/único dueño/);
    const conteo = llamadas.find((l) => l.head);
    expect(conteo?.eq).toEqual(expect.arrayContaining([['tenant_id', TENANT], ['rol', 'flota_admin'], ['activo', true]]));
    expect(conteo?.neq).toEqual([['id', U]]);
    expect(updatesDe('app_user')).toHaveLength(0);
  });

  it('con otro dueño activo sí se degrada', async () => {
    colas.set('app_user', [{ data: fila({ rol: 'flota_admin' }) }, { count: 1, data: null }, { data: [{ id: U }] }]);
    await expect(cambiarRolUsuario(TENANT, U, 'contador', ACTOR)).resolves.toEqual({ de: 'flota_admin', a: 'contador' });
  });

  it('0 filas en el update (cambió mientras tanto) NO es éxito y no anota bitácora', async () => {
    colas.set('app_user', [{ data: fila() }, { data: [] }]);
    await expect(cambiarRolUsuario(TENANT, U, 'encargado', ACTOR)).rejects.toThrow(/cambió mientras tanto/);
    expect(anotarBitacora).not.toHaveBeenCalled();
  });

  it('una cuenta dada de baja no cambia de rol: primero se reactiva', async () => {
    colas.set('app_user', [{ data: fila({ activo: false }) }]);
    await expect(cambiarRolUsuario(TENANT, U, 'encargado', ACTOR)).rejects.toThrow(/dada de baja/);
  });

  it('un error de lectura LANZA (no es DatoInvalido): la base caída no se disfraza de captura', async () => {
    colas.set('app_user', [{ data: null, error: { message: 'fetch failed' } }]);
    const p = cambiarRolUsuario(TENANT, U, 'encargado', ACTOR);
    await expect(p).rejects.toThrow('fetch failed');
    await expect(p).rejects.not.toBeInstanceOf(DatoInvalido);
  });
});

describe('desactivarUsuario — la baja en tres capas', () => {
  it('activo=false + sello + BAN permanente en Auth + bitácora', async () => {
    colas.set('app_user', [{ data: fila() }, { data: [{ id: U }] }]);
    const r = await desactivarUsuario(TENANT, U, ACTOR);
    expect(r).toEqual({ sesionRevocada: true });
    const [up] = updatesDe('app_user');
    expect(up.payload).toMatchObject({ activo: false, desactivado_por: OTRO });
    expect(String((up.payload as Record<string, unknown>).desactivado_en)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(up.eq).toEqual(expect.arrayContaining([['id', U], ['tenant_id', TENANT], ['activo', true]]));
    expect(updateUserById).toHaveBeenCalledWith(U, { ban_duration: BAN_PERMANENTE });
    expect(anotarBitacora).toHaveBeenCalledWith(
      expect.objectContaining({ accion: 'usuario.desactivado', entidadId: U, detalle: { rol: 'contador', sesion_revocada: true } }),
      expect.anything(),
    );
  });

  it('si el ban falla, la fila queda de baja pero se DICE (sesionRevocada=false) y queda en log y bitácora', async () => {
    colas.set('app_user', [{ data: fila() }, { data: [{ id: U }] }]);
    updateUserById.mockResolvedValueOnce({ error: { message: 'auth caído' } });
    const r = await desactivarUsuario(TENANT, U, ACTOR);
    expect(r).toEqual({ sesionRevocada: false });
    expect(logger.error).toHaveBeenCalledWith('equipo.ban_fallo', expect.objectContaining({ usuario: U }));
    expect(anotarBitacora).toHaveBeenCalledWith(
      expect.objectContaining({ detalle: expect.objectContaining({ sesion_revocada: false }) }), expect.anything(),
    );
  });

  it('nadie se da de baja a sí mismo', async () => {
    await expect(desactivarUsuario(TENANT, U, { id: U })).rejects.toThrow(/a ti mismo/);
    expect(llamadas).toHaveLength(0);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('el último dueño activo no se da de baja', async () => {
    colas.set('app_user', [{ data: fila({ rol: 'flota_admin' }) }, { count: 0, data: null }]);
    await expect(desactivarUsuario(TENANT, U, ACTOR)).rejects.toThrow(/único dueño/);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('ya de baja: se rechaza sin tocar Auth', async () => {
    colas.set('app_user', [{ data: fila({ activo: false }) }]);
    await expect(desactivarUsuario(TENANT, U, ACTOR)).rejects.toThrow(/ya está dada de baja/);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('0 filas en el update: ni ban ni bitácora', async () => {
    colas.set('app_user', [{ data: fila() }, { data: [] }]);
    await expect(desactivarUsuario(TENANT, U, ACTOR)).rejects.toBeInstanceOf(DatoInvalido);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(anotarBitacora).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SEC-3 (auditoría 25, MEDIO, re-auditoría). El ban en Auth mata el
  // REFRESH de la cookie del panel, pero un token MCP de acceso sigue vivo
  // hasta 8h y su refresco hasta 60 días (0265) — sin esto, la baja no
  // tumbaba esos tokens de inmediato: dependía de que el próximo refresco
  // topara con `mcp_oauth_usuario_vigente()` (que además, antes de la
  // migración 0318, ni siquiera preguntaba por `activo`).
  // ═══════════════════════════════════════════════════════════════════════
  it('también tumba de un tiro los tokens MCP vivos del usuario (revocar_mcp_oauth_usuario)', async () => {
    colas.set('app_user', [{ data: fila() }, { data: [{ id: U }] }]);
    await desactivarUsuario(TENANT, U, ACTOR);
    expect(rpc).toHaveBeenCalledWith('revocar_mcp_oauth_usuario', { p_tenant: TENANT, p_usuario: U });
  });

  it('si revocar los tokens MCP falla, la baja NO se revierte — se loguea y sigue', async () => {
    colas.set('app_user', [{ data: fila() }, { data: [{ id: U }] }]);
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc caída' } });
    const r = await desactivarUsuario(TENANT, U, ACTOR);
    expect(r).toEqual({ sesionRevocada: true });
    expect(logger.error).toHaveBeenCalledWith('equipo.mcp_revocar_fallo',
      expect.objectContaining({ usuario: U, err: 'rpc caída' }));
  });
});

describe('reactivarUsuario', () => {
  it('activo=true, limpia el sello, levanta el ban y anota', async () => {
    colas.set('app_user', [{ data: fila({ activo: false }) }, { data: [{ id: U }] }]);
    const r = await reactivarUsuario(TENANT, U, ACTOR);
    expect(r).toEqual({ accesoRestaurado: true });
    const [up] = updatesDe('app_user');
    expect(up.payload).toEqual({ activo: true, desactivado_en: null, desactivado_por: null });
    expect(up.eq).toEqual(expect.arrayContaining([['tenant_id', TENANT], ['activo', false]]));
    expect(updateUserById).toHaveBeenCalledWith(U, { ban_duration: 'none' });
    expect(anotarBitacora).toHaveBeenCalledWith(expect.objectContaining({ accion: 'usuario.reactivado' }), expect.anything());
  });

  it('si levantar el ban falla, se dice: la persona sigue sin poder entrar', async () => {
    colas.set('app_user', [{ data: fila({ activo: false }) }, { data: [{ id: U }] }]);
    updateUserById.mockRejectedValueOnce(new Error('timeout'));
    await expect(reactivarUsuario(TENANT, U, ACTOR)).resolves.toEqual({ accesoRestaurado: false });
    expect(logger.error).toHaveBeenCalledWith('equipo.desban_fallo', expect.objectContaining({ err: 'timeout' }));
  });

  it('ya activa: se rechaza', async () => {
    colas.set('app_user', [{ data: fila() }]);
    await expect(reactivarUsuario(TENANT, U, ACTOR)).rejects.toThrow(/ya está activa/);
  });
});

describe('el correo de acceso — avisoInvitacion por fin tiene quien lo emita', () => {
  it('sale de acceso@, con el nombre legible del rol y la flota, y se dice `enviado`', async () => {
    const r = await enviarCorreoDeAcceso('nuevo@flota.mx', 'contador', { flotaNombre: 'Fletes del Golfo', invitaNombre: 'Ana' });
    expect(r).toEqual({ enviado: true });
    const [para, correo, op] = enviarCorreo.mock.calls[0] as [string, { asunto: string; parrafos: string[] }, { remitenteLocal: string }];
    expect(para).toBe('nuevo@flota.mx');
    expect(correo.asunto).toContain('Fletes del Golfo');
    expect(correo.parrafos[0]).toContain('Ana');
    expect(correo.parrafos[0]).toContain('Contador');
    expect(correo.parrafos[0]).not.toContain('contador,');
    expect(op).toEqual({ remitenteLocal: 'acceso' });
  });

  it('sin canal configurado NO es un fallo: motivo sin_configurar, sin log de error', async () => {
    enviarCorreo.mockResolvedValueOnce({ ok: false, motivo: 'sin_configurar' });
    await expect(enviarCorreoDeAcceso('x@flota.mx', 'encargado', { flotaNombre: null, invitaNombre: null }))
      .resolves.toEqual({ enviado: false, motivo: 'sin_configurar' });
  });

  it('un rechazo de Resend es `fallo` y queda en el log', async () => {
    enviarCorreo.mockResolvedValueOnce({ ok: false, motivo: 'rechazado', detalle: '422' });
    await expect(enviarCorreoDeAcceso('x@flota.mx', 'encargado', { flotaNombre: null, invitaNombre: null }))
      .resolves.toEqual({ enviado: false, motivo: 'fallo' });
    expect(logger.warn).toHaveBeenCalledWith('equipo.correo_acceso_fallo', expect.objectContaining({ motivo: 'rechazado' }));
  });

  it('reenviarAcceso: solo a activos, al correo de la FILA (no del formulario), y anota', async () => {
    colas.set('app_user', [{ data: fila() }]);
    const r = await reenviarAcceso(TENANT, U, ACTOR, { flotaNombre: 'F', invitaNombre: 'Ana' });
    expect(r).toEqual({ enviado: true, email: 'conta@flota.mx' });
    expect(enviarCorreo.mock.calls[0][0]).toBe('conta@flota.mx');
    expect(anotarBitacora).toHaveBeenCalledWith(expect.objectContaining({ accion: 'usuario.acceso_reenviado' }), expect.anything());
  });

  it('reenviarAcceso a una cuenta de baja se rechaza sin mandar nada', async () => {
    colas.set('app_user', [{ data: fila({ activo: false }) }]);
    await expect(reenviarAcceso(TENANT, U, ACTOR, { flotaNombre: null, invitaNombre: null })).rejects.toThrow(/dada de baja/);
    expect(enviarCorreo).not.toHaveBeenCalled();
  });

  it('un envío fallido no se anota como reenviado', async () => {
    colas.set('app_user', [{ data: fila() }]);
    enviarCorreo.mockResolvedValueOnce({ ok: false, motivo: 'red', detalle: 'timeout' });
    await expect(reenviarAcceso(TENANT, U, ACTOR, { flotaNombre: null, invitaNombre: null }))
      .resolves.toEqual({ enviado: false, motivo: 'fallo', email: 'conta@flota.mx' });
    expect(anotarBitacora).not.toHaveBeenCalled();
  });
});
