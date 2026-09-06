import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recover, STAGING } from './staging-recovery.mjs';

function fixture() {
  const branch = { id: 'f4996abd-1c9b-46e3-89d9-91a2d2053f03', project_ref: STAGING, parent_project_ref: 'gngoqsvrxdguxvsizpbw', name: 'staging', is_default: false, persistent: false, with_data: false, preview_project_status: 'ACTIVE_HEALTHY' };
  const schemas = ['auth', 'extensions', 'graphql', 'graphql_public', 'net', 'public', 'realtime', 'storage', 'supabase_functions', 'supabase_migrations', 'vault'].map(name => ({ name }));
  const tables = [{ name: 'plan', kind: 'r' }, ...Array.from({ length: 58 }, (_, i) => ({ name: `table_${i}`, kind: 'r' }))];
  const counts = tables.map(t => ({ name: t.name, rows: t.name === 'plan' ? '3' : '0' }));
  const plans = [['demo', 'Demo', 50, 5, 0], ['empresa', 'Empresa', null, null, 2], ['flota', 'Flota', 500, 50, 1]].map(([clave, nombre, limite_viajes_mes, limite_operadores, orden]) => ({ clave, nombre, limite_viajes_mes, limite_operadores, orden, activo: true, moneda: 'MXN', precio_mensual: null, stripe_price_id: null, precio_iva_incluido: null }));
  const privateCounts = [{ users: '0', objects: '0', secrets: '0' }];
  const physical = [{ tables: 154, rep_columns: 3, cfdi_pago: true, valid_indexes: 2 }];
  const migrations = readdirSync('supabase/migrations');
  const history = migrations.filter(x => /^\d{4}_.+\.sql$/.test(x)).map(x => ({ version: x.slice(0, 4) })).sort((a, b) => a.version.localeCompare(b.version));
  const files = new Map<string, string>([['supabase/.temp/project-ref', STAGING]]);
  const env = { NODE_ENV: 'test' as const, SUPABASE_ACCESS_TOKEN: 'synthetic-token', SUPABASE_DB_PASSWORD: 'synthetic-password', SUPABASE_PROJECT_REF: STAGING, RECOVERY_SOURCE_SHA: 'a'.repeat(40), RECOVERY_CONFIRM: 'RESET_EMPTY_STAGING', STAGING_WRITES_PAUSED: 'true', REVIEWED_BACKUP_RUN_ID: '123' };
  const fetch = vi.fn(async (url: string, options: { body?: string; method: string }) => {
    if (!options.body) {
      expect(url).toBe('https://api.supabase.com/v1/projects/gngoqsvrxdguxvsizpbw/branches/staging');
      expect(options.method).toBe('GET');
      return { ok: true, json: async () => branch };
    }
    expect(url).toBe(`https://api.supabase.com/v1/projects/${STAGING}/database/query`);
    const body = JSON.parse(options.body);
    expect(body.read_only).toBe(true);
    expect(body.query).toMatch(/^select\s/);
    const sql: string = body.query;
    const result = sql.includes('nspname as name') ? schemas : sql.includes('c.relname as name') ? tables : sql.includes('union all') ? counts
      : sql.includes('as users') ? privateCounts : sql.includes('select * from public.plan') ? plans : sql.includes('as metadata') ? [{ metadata: { history, policies: [], triggers: [], default_acls: [], storage_buckets: [] } }]
      : sql.includes('select version') ? history : physical;
    return { ok: true, json: async () => result };
  });
  const spawn = vi.fn((_command: string, args: string[]) => {
    if (args.includes('dump')) files.set(args[args.indexOf('--file') + 1], `CREATE TABLE public.plan (clave text);\n${'-- schema\n'.repeat(20)}`);
    return { status: 0 };
  });
  const deps = { directory: '/owned-backup', fetch, spawn, mkdir: vi.fn(), read: (path: string) => {
    const value = files.get(path); if (value === undefined) throw new Error('fixture missing'); return value;
  }, write: (path: string, content: string) => { files.set(path, content); }, readdir: () => migrations };
  return { branch, schemas, tables, counts, privateCounts, plans, physical, history, files, env, deps, spawn, fetch, migrations };
}

describe('recuperación excepcional de staging vacío', () => {
  it('preparar nunca alcanza reset y conserva esquema, planes y metadata con hashes', async () => {
    const f = fixture();
    await recover('capture', f.env, f.deps);
    expect(f.spawn.mock.calls.map(([, args]) => args.slice(2, 4))).toEqual([['link', '--project-ref'], ['db', 'dump']]);
    expect([...f.files.keys()]).toEqual(expect.arrayContaining(['/owned-backup/public.sql', '/owned-backup/plan.json', '/owned-backup/metadata.json', '/owned-backup/snapshot.json', '/owned-backup/manifest.json']));
    expect(f.files.get('/owned-backup/metadata.json')).toContain('storage_buckets');
    expect(f.files.get('/owned-backup/manifest.json')).not.toContain('synthetic');
  });
  it.each(['project_ref', 'parent_project_ref', 'id', 'name', 'is_default', 'persistent', 'with_data', 'preview_project_status'] as const)('rechaza identidad de rama alterada: %s', async key => {
    const f = fixture(); Object.assign(f.branch, { [key]: 'wrong' });
    await expect(recover('capture', f.env, f.deps)).rejects.toThrow('RECOVERY_BRANCH_IDENTITY');
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it.each(['public', 'users', 'objects', 'secrets', 'plans', 'schema', 'foreign', 'omitted-count'])('rechaza datos o inventario inseguro: %s', async mode => {
    const f = fixture();
    if (mode === 'public') f.counts[1].rows = '1';
    else if (mode === 'users' || mode === 'objects' || mode === 'secrets') f.privateCounts[0][mode] = '1';
    else if (mode === 'plans') f.plans[0].nombre = 'Modified';
    else if (mode === 'schema') f.schemas.push({ name: 'business' });
    else if (mode === 'foreign') f.tables[0].kind = 'f';
    else f.counts.pop();
    await expect(recover('capture', f.env, f.deps)).rejects.toThrow('RECOVERY_');
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it.each(['missing-confirm', 'wrong-sha', 'corrupt-backup', 'new-data', 'future-migration'])('no ejecuta reset con %s', async mode => {
    const f = fixture(); await recover('capture', f.env, f.deps); f.spawn.mockClear();
    if (mode === 'missing-confirm') f.env.RECOVERY_CONFIRM = '';
    else if (mode === 'wrong-sha') f.env.RECOVERY_SOURCE_SHA = 'b'.repeat(40);
    else if (mode === 'corrupt-backup') f.files.set('/owned-backup/metadata.json', '{}');
    else if (mode === 'new-data') f.counts[1].rows = '1';
    else f.migrations.push('0350_unreviewed.sql');
    await expect(recover('execute', f.env, f.deps)).rejects.toThrow('RECOVERY_');
    expect(f.spawn.mock.calls.some(([, args]) => args.includes('reset'))).toBe(false);
  });
  it.each(['20260905000000_unreviewed.sql', '999_unknown.sql', 'bad.sql'])('rechaza toda migración SQL fuera del manifiesto: %s', async name => {
    const f = fixture(); f.migrations.push(name);
    await expect(recover('capture', f.env, f.deps)).rejects.toThrow('RECOVERY_LOCAL_MIGRATIONS');
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it('con respaldo revisado, el orden es reset0331 → preflight → push y comprueba esquema físico', async () => {
    const f = fixture(); await recover('capture', f.env, f.deps); f.spawn.mockClear();
    await recover('execute', f.env, f.deps);
    expect(f.spawn.mock.calls.map(([, args]) => args)).toEqual([
      ['--yes', 'supabase@2.115.0', 'link', '--project-ref', STAGING],
      ['--yes', 'supabase@2.115.0', 'db', 'reset', '--linked', '--no-seed', '--version', '0331', '--yes'],
      ['scripts/ci/supabase-preflight.mjs', 'preflight'],
      ['--yes', 'supabase@2.115.0', 'db', 'push', '--linked', '--yes'],
    ]);
    expect(f.files.has('/owned-backup/physical.json')).toBe(true);
  });
  it.each(['reset', 'preflight', 'push'])('propaga fallo de %s y detiene fases posteriores', async phase => {
    const f = fixture(); await recover('capture', f.env, f.deps); f.spawn.mockClear();
    f.spawn.mockImplementation((_command, args) => ({ status: args.includes(phase) ? 1 : 0 }));
    await expect(recover('execute', f.env, f.deps)).rejects.toThrow(phase === 'preflight' ? 'RECOVERY_INDEX_PREFLIGHT_FAILED' : `RECOVERY_${phase.toUpperCase()}_FAILED`);
    expect(f.spawn.mock.calls.at(-1)?.[1]).toContain(phase);
    expect(f.files.has('/owned-backup/applied.json')).toBe(false);
  });
  it('historial verde con columnas REP ausentes nunca es esquema verde', async () => {
    const f = fixture(); await recover('capture', f.env, f.deps); f.physical[0].rep_columns = 0;
    await expect(recover('execute', f.env, f.deps)).rejects.toThrow('RECOVERY_FINAL_SCHEMA');
  });
  it('workflow sólo staging, preparación por defecto y descarga del respaldo revisado', () => {
    const text = readFileSync('.github/workflows/recover-empty-staging.yml', 'utf8');
    expect(text).toContain('environment: staging');
    expect(text).not.toMatch(/environment: production|PROJECT_REF_PRODUCTION|DB_PASSWORD_PRODUCTION/);
    expect(text).toContain('default: false');
    expect(text).toContain('inputs.execute_reset == false');
    expect(text).toContain('gh run download "$BACKUP_RUN_ID"');
    expect(text.indexOf('gh run download')).toBeLessThan(text.indexOf('staging-recovery.mjs execute'));
    expect(text).toContain('cancel-in-progress: false');
  });
});
