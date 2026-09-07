import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { prepareBuild, sanitizeBuildLog } from './prepare-build-env.mjs';
import { PROJECT, TEAM, STAGING_REF, PRODUCTION_REF, validateSupabaseEnv } from './production-candidate.mjs';

// Espejo local de ADMIN_KEYS (no exportado por prepare-build-env.mjs a propósito:
// es una lista interna, no una superficie pública del módulo).
const ADMIN_KEYS = ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'SUPABASE_DB_URL'];
const dirs: string[] = [];
const jwt = (ref: string, role: string) => `header.${Buffer.from(JSON.stringify({ ref, role })).toString('base64url')}.synthetic`;
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', CI: 'true', SUPABASE_ACCESS_TOKEN: 'synthetic-management-secret', SUPABASE_DB_PASSWORD: 'synthetic-db-secret', VERCEL_TOKEN: 'synthetic-vercel-secret' };
const masked = 'NEXT_PUBLIC_SUPABASE_URL="[SENSITIVE]"\nNEXT_PUBLIC_SUPABASE_ANON_KEY="[SENSITIVE]"\nSUPABASE_SERVICE_ROLE_KEY="[SENSITIVE]"\nUNRELATED="keep me"\n';
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(target: 'preview' | 'production' = 'preview', original = masked) {
  const cwd = mkdtempSync(join(tmpdir(), 'build-env-test-')); dirs.push(cwd);
  mkdirSync(join(cwd, '.vercel'));
  writeFileSync(join(cwd, '.vercel/project.json'), JSON.stringify({ projectId: PROJECT, orgId: TEAM }));
  const file = join(cwd, `.vercel/.env.${target}.local`);
  writeFileSync(file, original);
  const ref = target === 'preview' ? STAGING_REF : PRODUCTION_REF;
  const fetch = vi.fn(async () => ({ ok: true, json: async () => [
    { name: 'anon', api_key: jwt(ref, 'anon') }, { name: 'service_role', api_key: jwt(ref, 'service_role') },
  ] }));
  const spawn = vi.fn((_cmd: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
    validateSupabaseEnv(readFileSync(file, 'utf8'), ref);
    expect(parseEnv(readFileSync(file, 'utf8')).UNRELATED).toBe('keep me');
    expect(options.env.NEXT_PUBLIC_SUPABASE_URL).toBe(`https://${ref}.supabase.co`);
    expect(options.env.SUPABASE_SERVICE_ROLE_KEY).toBe(jwt(ref, 'service_role'));
    expect(options.env).not.toHaveProperty('SUPABASE_ACCESS_TOKEN');
    expect(options.env).not.toHaveProperty('SUPABASE_DB_PASSWORD');
    expect(options.env.VERCEL_TOKEN).toBe(env.VERCEL_TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    return { status: 0 };
  });
  return { cwd, file, fetch, spawn, ref };
}

describe('build con credenciales autorizadas y Sensitive preservado', () => {
  it('acredita la causa anterior: la máscara real de pull no supera el guard', () => {
    expect(() => validateSupabaseEnv(masked, STAGING_REF)).toThrow('proyecto Supabase autorizado');
  });
  it.each(['preview', 'production'] as const)('hidrata %s, fuerza variables al hijo y restaura máscara', async target => {
    const f = fixture(target);
    writeFileSync(join(f.cwd, '.env.local'), `NEXT_PUBLIC_SUPABASE_URL=https://wrong.supabase.co\n`);
    expect(await prepareBuild(target, env, f)).toEqual({ target, supabase_ref: f.ref, variables: 3, build: 'passed' });
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.spawn.mock.calls[0][1]).toEqual(['--yes', 'vercel@59.1.4', 'build', ...(target === 'production' ? ['--prod'] : [])]);
    expect(f.fetch).toHaveBeenCalledWith(`https://api.supabase.com/v1/projects/${f.ref}/api-keys?reveal=true`, expect.objectContaining({ method: 'GET', redirect: 'error' }));
    expect(readFileSync(f.file, 'utf8')).toBe(masked);
    expect(readFileSync(join(f.cwd, '.env.local'), 'utf8')).toContain('wrong.supabase.co');
  });
  it('ref/rol equivocado aborta sin build ni escritura', async () => {
    const f = fixture();
    f.fetch.mockResolvedValue({ ok: true, json: async () => [{ name: 'anon', api_key: jwt(PRODUCTION_REF, 'anon') }, { name: 'service_role', api_key: jwt(STAGING_REF, 'service_role') }] });
    await expect(prepareBuild('preview', env, f)).rejects.toThrow('BUILD_ENV_SUPABASE_KEYS');
    expect(f.spawn).not.toHaveBeenCalled();
    expect(readFileSync(f.file, 'utf8')).toBe(masked);
  });
  it('no tapa un valor real contrario descargado ni heredado del proceso', async () => {
    for (const processConflict of [false, true]) {
      const f = fixture('preview', processConflict ? masked : masked.replace('"[SENSITIVE]"', '"https://wrong.supabase.co"'));
      await expect(prepareBuild('preview', { ...env, ...(processConflict ? { NEXT_PUBLIC_SUPABASE_URL: 'https://wrong.supabase.co' } : {}) }, f)).rejects.toThrow('BUILD_ENV_ENV_CONFLICT');
      expect(f.spawn).not.toHaveBeenCalled();
    }
  });
  it('proyecto ajeno o duplicado aborta antes de pedir credenciales', async () => {
    const f = fixture();
    writeFileSync(join(f.cwd, '.vercel/project.json'), JSON.stringify({ projectId: 'other', orgId: TEAM }));
    await expect(prepareBuild('preview', env, f)).rejects.toThrow('BUILD_ENV_PROJECT');
    expect(f.fetch).not.toHaveBeenCalled();
    const duplicate = fixture('preview', `${masked}NEXT_PUBLIC_SUPABASE_URL=""\n`);
    await expect(prepareBuild('preview', env, duplicate)).rejects.toThrow('BUILD_ENV_PULLED_ENV');
    expect(duplicate.fetch).not.toHaveBeenCalled();
  });
  it('un build fallido restaura archivo y no imprime ni interpola secretos del error', async () => {
    const f = fixture(); f.spawn.mockImplementation(() => { throw new Error('synthetic-management-secret'); });
    await expect(prepareBuild('preview', env, f)).rejects.toThrow(/^BUILD_ENV_BUILD$/);
    expect(readFileSync(f.file, 'utf8')).toBe(masked);
  });
  it('sin target/CI/credencial autorizados no hace red ni build', async () => {
    const f = fixture();
    for (const bad of [{ ...env, CI: 'false' }, { ...env, SUPABASE_ACCESS_TOKEN: '' }]) {
      await expect(prepareBuild('preview', bad, f)).rejects.toThrow('BUILD_ENV_INPUT');
    }
    await expect(prepareBuild('other', env, f)).rejects.toThrow('BUILD_ENV_INPUT');
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
  });
  it.each(['missing', 'empty'])('rechaza archivo %s antes de red/build', async kind => {
    const f = fixture('preview', kind === 'missing' ? masked.split('\n').slice(1).join('\n')
      : masked.replace('[SENSITIVE]', ''));
    await expect(prepareBuild('preview', env, f)).rejects.toThrow('BUILD_ENV_PULLED_ENV');
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
  });
  it.each(ADMIN_KEYS)('si %s aparece en el .env pulled, aborta con ADMIN_IN_PULLED_ENV antes de red/build', async adminKey => {
    const f = fixture('preview', `${masked}${adminKey}="synthetic-admin-leak-value"\n`);
    await expect(prepareBuild('preview', env, f)).rejects.toThrow('BUILD_ENV_ADMIN_IN_PULLED_ENV');
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
    expect(readFileSync(f.file, 'utf8')).toContain(adminKey);
  });
  it('un symlink en la ruta del .env no se sigue: falla con FILE y no toca el archivo real', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'build-env-test-')); dirs.push(cwd);
    mkdirSync(join(cwd, '.vercel'));
    writeFileSync(join(cwd, '.vercel/project.json'), JSON.stringify({ projectId: PROJECT, orgId: TEAM }));
    const real = join(cwd, 'real-secrets-fuera-de-vercel.env');
    writeFileSync(real, masked);
    symlinkSync(real, join(cwd, '.vercel/.env.preview.local'));
    const fetch = vi.fn();
    const spawn = vi.fn();
    await expect(prepareBuild('preview', env, { cwd, fetch, spawn })).rejects.toThrow('BUILD_ENV_FILE');
    expect(fetch).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(readFileSync(real, 'utf8')).toBe(masked);
  });
  it('SUPABASE_DB_URL en el entorno no se hereda al proceso hijo del build', async () => {
    const f = fixture('preview');
    const envConDbUrl = { ...env, SUPABASE_DB_URL: 'postgres://synthetic-db-url-secret' };
    const spawn = vi.fn((_cmd: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      expect(options.env).not.toHaveProperty('SUPABASE_DB_URL');
      return { status: 0 };
    });
    await expect(prepareBuild('preview', envConDbUrl, { ...f, spawn })).resolves.toMatchObject({ build: 'passed' });
    expect(spawn).toHaveBeenCalledOnce();
  });
  it('una API key marcada disabled en la respuesta de Supabase se rechaza, no se usa', async () => {
    const f = fixture('preview');
    f.fetch.mockResolvedValue({ ok: true, json: async () => [
      { name: 'anon', api_key: jwt(f.ref, 'anon') },
      { name: 'service_role', api_key: jwt(f.ref, 'service_role'), disabled: true },
    ] });
    await expect(prepareBuild('preview', env, f)).rejects.toThrow('BUILD_ENV_SUPABASE_KEYS');
    expect(f.spawn).not.toHaveBeenCalled();
    expect(readFileSync(f.file, 'utf8')).toBe(masked);
  });
  it('sanitizeBuildLog no corrompe texto común corto (piso de 8 evita redactar basura sin sentido)', () => {
    const log = "Type 'true' is not assignable to type 'never'.\n  src/app/page.tsx:1:5 - error TS2322: mensaje de compilador normal.";
    // 'true', 'test' y '1' son valores típicos de env cortos (CI, NODE_ENV, un
    // puerto): sin el piso de longitud, un replaceAll ciego los reventaría en
    // cualquier parte del log, incluida esta salida de TypeScript sin secretos.
    const safe = sanitizeBuildLog(log, ['true', 'test', '1', 'CI', 'a1b2c3d4']);
    expect(safe).toBe(log);
    // Pero un secreto real (>=8) en la misma llamada sí se redacta.
    const conSecreto = sanitizeBuildLog(`${log}\nDB_URL=a1b2c3d4`, ['a1b2c3d4']);
    expect(conSecreto).not.toContain('a1b2c3d4');
    expect(conSecreto).toContain("Type 'true'");
    expect(conSecreto).toContain('page.tsx:1:5');
  });
  it('diagnóstico de salida mantiene error útil, redacta valores y limita tail', async () => {
    const secret = 'canary "private" value+with/slash';
    const token = 'vcp_abcdefghijabcdefghij';
    const unknownJwt = 'abcdefghij.klmnopqrst.uvwxyzABCD';
    const safe = sanitizeBuildLog(`Compile error\n${secret}\n${encodeURIComponent(secret)}\n${JSON.stringify(secret)}\n${token}\n${unknownJwt}`, [secret]);
    expect(safe).toContain('Compile error');
    expect(safe).not.toContain('private'); expect(safe).not.toContain(token); expect(safe).not.toContain(unknownJwt);
    expect(sanitizeBuildLog('x'.repeat(100_000), []).length).toBe(65_536);
    // 'p4ss12' (6 chars) queda bajo el piso técnico de 8: valores tan cortos no
    // se redactan por valor exacto para no arriesgar basura común del log.
    expect(sanitizeBuildLog('DB password=p4ss12', ['p4ss12'])).toContain('p4ss12');
    expect(sanitizeBuildLog('DB password=p4ss1234', ['p4ss1234'])).not.toContain('p4ss1234');
    const f = fixture();
    const spawn = vi.fn(() => ({ status: 2, stdout: `Build failed ${jwt(STAGING_REF, 'service_role')}`, stderr: env.SUPABASE_ACCESS_TOKEN }));
    await expect(prepareBuild('preview', env, { ...f, spawn })).rejects.toThrow('BUILD_ENV_BUILD_EXIT_2');
    const log = readFileSync(join(f.cwd, '.vercel/build-preview.sanitized.log'), 'utf8');
    expect(log).toContain('Build failed'); expect(log).not.toContain(jwt(STAGING_REF, 'service_role'));
    expect(log).not.toContain(env.SUPABASE_ACCESS_TOKEN);
    expect(readFileSync(f.file, 'utf8')).toBe(masked);
  });
});
