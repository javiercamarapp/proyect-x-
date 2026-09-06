import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { prepareBuild, sanitizeBuildLog } from './prepare-build-env.mjs';
import { PROJECT, TEAM, STAGING_REF, PRODUCTION_REF, validateSupabaseEnv } from './production-candidate.mjs';

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
  it.each(['missing', 'empty', 'admin'])('rechaza archivo %s antes de red/build', async kind => {
    const f = fixture('preview', kind === 'missing' ? masked.split('\n').slice(1).join('\n')
      : kind === 'empty' ? masked.replace('[SENSITIVE]', '') : `${masked}SUPABASE_ACCESS_TOKEN="synthetic-admin"\n`);
    await expect(prepareBuild('preview', env, f)).rejects.toThrow('BUILD_ENV_PULLED_ENV');
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
  });
  it('diagnóstico de salida mantiene error útil, redacta valores y limita tail', async () => {
    const secret = 'canary "private" value+with/slash';
    const token = 'vcp_abcdefghijabcdefghij';
    const unknownJwt = 'abcdefghij.klmnopqrst.uvwxyzABCD';
    const safe = sanitizeBuildLog(`Compile error\n${secret}\n${encodeURIComponent(secret)}\n${JSON.stringify(secret)}\n${token}\n${unknownJwt}`, [secret]);
    expect(safe).toContain('Compile error');
    expect(safe).not.toContain('private'); expect(safe).not.toContain(token); expect(safe).not.toContain(unknownJwt);
    expect(sanitizeBuildLog('x'.repeat(100_000), []).length).toBe(65_536);
    expect(sanitizeBuildLog('DB password=p4ss12', ['p4ss12'])).not.toContain('p4ss12');
    const f = fixture();
    const spawn = vi.fn(() => ({ status: 2, stdout: `Build failed ${jwt(STAGING_REF, 'service_role')}`, stderr: env.SUPABASE_ACCESS_TOKEN }));
    await expect(prepareBuild('preview', env, { ...f, spawn })).rejects.toThrow('BUILD_ENV_BUILD_EXIT_2');
    const log = readFileSync(join(f.cwd, '.vercel/build-preview.sanitized.log'), 'utf8');
    expect(log).toContain('Build failed'); expect(log).not.toContain(jwt(STAGING_REF, 'service_role'));
    expect(log).not.toContain(env.SUPABASE_ACCESS_TOKEN);
    expect(readFileSync(f.file, 'utf8')).toBe(masked);
  });
});
