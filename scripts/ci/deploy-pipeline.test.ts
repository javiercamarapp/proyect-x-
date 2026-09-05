import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { validateDatabase, freshBackup, run } from './supabase-preflight.mjs';
import { validateDeployment, validateBaseline, validateCron, parseCookie, withProtection, validateBrowserCookie, validateLanding, validatePreviewEnv, validateSupabaseEnv, main, STAGING_REF, PRODUCTION_REF, PROJECT, DOMAINS } from './production-candidate.mjs';

const workflow = readFileSync('.github/workflows/deploy-preview-promote.yml', 'utf8');
function job(name: string) {
  return workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z_-]+:\n/)[0] ?? '';
}

describe('promoción del artefacto Production probado', () => {
  it('prueba y construye los artefactos con el mismo major Node del runtime Vercel', () => {
    for (const name of ['quality', 'preview', 'production_candidate']) {
      expect(job(name)).toContain('node-version: 24');
    }
  });
  it('rechaza identidades de baseline que podrían inyectar líneas en los outputs de Actions', () => {
    expect(validateBaseline({ current: 'dpl_old', cron: null })).toEqual({ current: 'dpl_old', cron: null });
    for (const value of [null, {}, { current: 'dpl_old\nid=dpl_other', cron: null }, { current: 'dpl_old', cron: 'arbitrary' }]) {
      expect(() => validateBaseline(value)).toThrow('baseline');
    }
  });
  it('construye Production y evita asignar dominios al crear el candidato', () => {
    const candidate = job('production_candidate');
    expect(candidate).toContain('inputs.promote == true');
    expect(candidate).toContain('--environment=production');
    expect(candidate).toContain('build --prod');
    expect(candidate).toContain('deploy --prebuilt --prod --skip-domain');
    expect(candidate).toContain('needs.preflight.outputs.sha');
    expect(candidate.indexOf('production-candidate.mjs production-env')).toBeGreaterThan(candidate.indexOf('pull --yes --environment=production'));
    expect(candidate.indexOf('production-candidate.mjs production-env')).toBeLessThan(candidate.indexOf('build --prod'));
  });
  it('migra antes del candidato y prueba ese ID antes de promoverlo', () => {
    expect(job('production_candidate')).toContain('production_migrations');
    expect(job('production_smoke')).toContain('needs.production_candidate.outputs.id');
    expect(job('promote')).toContain('production_smoke');
    expect(job('promote')).toContain('promote "$DEPLOYMENT_ID"');
    expect(job('promote')).not.toContain('needs.preview.outputs.url');
    expect(job('promote')).toContain('verify-alias');
  });
  it('conserva calidad/staging y consulta backup antes de cualquier DDL productivo', () => {
    expect(job('preview')).toContain('supabase-dry-run');
    expect(job('quality')).toContain('npm run test:coverage');
    expect(job('quality')).toContain('node scripts/ci/audit-runtime.mjs');
    const migrations = job('production_migrations');
    expect(migrations.indexOf('supabase-preflight.mjs backup')).toBeGreaterThan(-1);
    expect(migrations.indexOf('supabase-preflight.mjs backup')).toBeLessThan(migrations.indexOf('supabase-preflight.mjs preflight'));
    expect(job('supabase-dry-run')).toContain(STAGING_REF);
    expect(job('supabase-dry-run')).toMatch(/db push --dry-run\n\s+npx[^\n]+ db push\n/);
    expect(migrations).toContain(PRODUCTION_REF);
    const preview = job('preview');
    expect(preview.indexOf('production-candidate.mjs preview-env')).toBeGreaterThan(preview.indexOf('pull --yes --environment=preview'));
    expect(preview.indexOf('production-candidate.mjs preview-env')).toBeLessThan(preview.indexOf(' build\n'));
  });
  it('serializa releases completos y no pasa credenciales por argv', () => {
    expect(workflow).toContain('group: vercel-release-likida');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).not.toMatch(/--token\s+"\$VERCEL_TOKEN"|--password\s+"\$SUPABASE_DB_PASSWORD"/);
  });
});

describe('destino y credenciales del preflight SQL', () => {
  const ref = 'abcdefghijklmnopqrst';
  const good = `postgresql://postgres.${ref}@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
  it('deriva session pooler y elimina password de la URL/argv', async () => {
    expect(validateDatabase(good, ref)).toBe(`${good}?sslmode=verify-full&sslrootcert=system`);
    const spawn = vi.fn((_command: string, _args: string[], _options: { env: NodeJS.ProcessEnv }) => ({ status: 0 }));
    const password = 'synthetic-secret@:/';
    await run('preflight', { NODE_ENV: 'test', SUPABASE_PROJECT_REF: ref, SUPABASE_DB_PASSWORD: password }, {
      read: (path: string) => path.endsWith('project-ref') ? ref : good,
      spawn,
    });
    expect(spawn.mock.calls[0][1].join(' ')).not.toContain(password);
    expect(spawn.mock.calls[0][2].env.PGPASSWORD).toBe(password);
    expect(validateDatabase(good.replace('@aws', ':not-in-argv@aws'), ref)).not.toContain('not-in-argv');
  });
  it.each([
    good.replace(':5432', ':6543'), good.replace(ref, 'z'.repeat(20)),
    good.replace('.supabase.com', '.supabase.com.evil.test'),
    good.replace('postgresql:', 'https:'), `${good}?host=127.0.0.1`,
    `${good}?sslmode=disable`, good.replace('/postgres', '/other'),
    `postgresql://postgres@127.0.0.1:5432/postgres`,
  ])('rechaza destino/rol/transacción manipulados: %s', (url) => expect(() => validateDatabase(url, ref)).toThrow());
  it('rechaza link de otro proyecto antes de psql', async () => {
    const spawn = vi.fn();
    await expect(run('preflight', { NODE_ENV: 'test', SUPABASE_PROJECT_REF: ref, SUPABASE_DB_PASSWORD: 'synthetic' }, { read: () => 'z'.repeat(20), spawn })).rejects.toThrow('otro proyecto');
    expect(spawn).not.toHaveBeenCalled();
  });
  it('backup sólo acepta COMPLETED pasado dentro de24h; PITR aislado no inventa backup', () => {
    const now = Date.parse('2026-09-05T12:00:00Z');
    const backup = { id: 7, status: 'COMPLETED', inserted_at: '2026-09-05T11:00:00Z' };
    expect(freshBackup({ backups: [backup] }, now).age_hours).toBe(1);
    for (const change of [{ status: 'FAILED' }, { inserted_at: '2026-09-04T11:00:00Z' }, { inserted_at: '2026-09-06T00:00:00Z' }]) {
      expect(() => freshBackup({ backups: [{ ...backup, ...change }] }, now)).toThrow();
    }
    expect(() => freshBackup({ pitr_enabled: true, backups: [] }, now)).toThrow();
  });
  it('consulta backup con GET, token sólo en header y sin seguir redirects', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 403 }));
    await expect(run('backup', { NODE_ENV: 'test', SUPABASE_PROJECT_REF: ref, SUPABASE_ACCESS_TOKEN: 'synthetic-api-token' }, { fetch })).rejects.toThrow('HTTP 403');
    expect(fetch).toHaveBeenCalledWith(`https://api.supabase.com/v1/projects/${ref}/database/backups`, expect.objectContaining({ method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer synthetic-api-token' } }));
  });
});

describe('identidad, protección y limpieza del candidato', () => {
  const sha = 'a'.repeat(40);
  const deployment = { id: 'dpl_test', projectId: PROJECT, readyState: 'READY', target: 'production', meta: { releaseSha: sha }, url: 'candidate-likida.vercel.app' };
  it('Preview sólo usa URL y ambas credenciales del staging autorizado, antes de construir', () => {
    const jwt = (ref: string, role: string) => `header.${Buffer.from(JSON.stringify({ ref, role })).toString('base64url')}.synthetic`;
    const env = `NEXT_PUBLIC_SUPABASE_URL="https://${STAGING_REF}.supabase.co"\nNEXT_PUBLIC_SUPABASE_ANON_KEY="${jwt(STAGING_REF, 'anon')}"\nSUPABASE_SERVICE_ROLE_KEY="${jwt(STAGING_REF, 'service_role')}"`;
    expect(() => validatePreviewEnv(env)).not.toThrow();
    expect(() => validatePreviewEnv(env.replace(STAGING_REF, PRODUCTION_REF))).toThrow();
    expect(() => validatePreviewEnv(env.replace(jwt(STAGING_REF, 'service_role'), jwt(PRODUCTION_REF, 'service_role')))).toThrow();
    expect(() => validatePreviewEnv(env.replace(jwt(STAGING_REF, 'anon'), 'opaque-unverified'))).toThrow();
    const production = `NEXT_PUBLIC_SUPABASE_URL="https://${PRODUCTION_REF}.supabase.co"\nNEXT_PUBLIC_SUPABASE_ANON_KEY="${jwt(PRODUCTION_REF, 'anon')}"\nSUPABASE_SERVICE_ROLE_KEY="${jwt(PRODUCTION_REF, 'service_role')}"`;
    expect(() => validateSupabaseEnv(production, PRODUCTION_REF)).not.toThrow();
    expect(() => validateSupabaseEnv(env, PRODUCTION_REF)).toThrow();
    expect(() => validateSupabaseEnv(production.replace(jwt(PRODUCTION_REF, 'service_role'), jwt(STAGING_REF, 'service_role')), PRODUCTION_REF)).toThrow();
  });
  it('verifica los dos alias finales y rechaza divergencia del segundo', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => deployment })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: deployment.id }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'dpl_other' }) });
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(main('verify-alias', deployment.id, sha, undefined, { NODE_ENV: 'test', VERCEL_TOKEN: 'synthetic' })).rejects.toThrow('Alias');
      expect(fetch.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining(DOMAINS.map((domain) => expect.stringContaining(`/deployments/${domain}?`))));
    } finally { vi.unstubAllGlobals(); }
  });
  it('rechaza Preview, otro SHA/proyecto/ID o deployment no READY', () => {
    expect(validateDeployment(deployment, sha, 'production', 'dpl_test').id).toBe('dpl_test');
    for (const drift of [{ target: 'preview' }, { projectId: 'other' }, { readyState: 'BUILDING' }, { meta: { releaseSha: 'b'.repeat(40) } }]) {
      expect(() => validateDeployment({ ...deployment, ...drift }, sha, 'production')).toThrow();
    }
    expect(() => validateDeployment(deployment, sha, 'production', 'dpl_other')).toThrow();
    expect(() => validateCron('dpl_old', 'dpl_new')).toThrow();
  });
  it('cookie sólo al host exacto, sin ampliar Domain ni admitir otro sitio', () => {
    const cookie = parseCookie(['__vercel_live_token=synthetic; Domain=.vercel.app; Secure'], 'https://candidate-likida.vercel.app');
    expect(cookie).toMatchObject({ url: 'https://candidate-likida.vercel.app', secure: true });
    expect(cookie).not.toHaveProperty('domain');
    expect(validateBrowserCookie(cookie, cookie.url)).toBe(cookie);
    expect(() => validateBrowserCookie(cookie, 'https://other.vercel.app')).toThrow();
    expect(() => validateBrowserCookie({ ...cookie, domain: '.vercel.app' }, cookie.url)).toThrow();
    expect(() => validateBrowserCookie({ ...cookie, path: '/' }, cookie.url)).toThrow();
    expect(() => parseCookie([], 'https://candidate-likida.vercel.app')).toThrow();
    expect(() => parseCookie(['__vercel_live_token=x'], 'https://evil.test')).toThrow();
  });
  it('no toma la página de login protegida ni un redirect externo por smoke verde; conserva local', () => {
    expect(() => validateLanding('https://vercel.com/login', 'https://candidate.vercel.app', 'login')).toThrow();
    expect(() => validateLanding('https://candidate.vercel.app', 'https://candidate.vercel.app', 'Authentication Required')).toThrow();
    expect(() => validateLanding('http://127.0.0.1:3000/terminos', 'http://127.0.0.1:3000', 'Términos de servicio')).not.toThrow();
  });
  it('nunca revoca token existente', async () => {
    const request = vi.fn();
    await withProtection({ protectionBypass: { existing: { scope: 'automation-bypass' } } }, request, async (token: string) => expect(token).toBe('existing'));
    expect(request).not.toHaveBeenCalled();
  });
  it.each([false, true])('revoca sólo el token propio incluso si falla el smoke: %s', async (fail) => {
    const request = vi.fn(async (_options: { body: string }) => ({}));
    const result = withProtection({}, request, async () => { if (fail) throw new Error('smoke'); });
    if (fail) await expect(result).rejects.toThrow('smoke'); else await result;
    const created = JSON.parse(request.mock.calls[0][0].body).generate.secret;
    expect(JSON.parse(request.mock.calls[1][0].body)).toEqual({ revoke: { secret: created, regenerate: false } });
  });
  it('una respuesta de creación incierta también limpia; cleanup fallido no da PASS', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({});
    await expect(withProtection({}, request, vi.fn())).rejects.toThrow('network');
    expect(request).toHaveBeenCalledTimes(2);
    const cleanupFail = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('revoke'));
    await expect(withProtection({}, cleanupFail, async () => {})).rejects.toThrow('Cleanup');
  });
});
