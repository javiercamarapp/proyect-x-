import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recover, STAGING } from './staging-recovery.mjs';

function fixture() {
  const branch = { id: 'f4996abd-1c9b-46e3-89d9-91a2d2053f03', project_ref: STAGING, parent_project_ref: 'gngoqsvrxdguxvsizpbw', name: 'staging', is_default: false, persistent: false, with_data: false, preview_project_status: 'ACTIVE_HEALTHY' };
  const branches = [branch];
  const project = { id: STAGING, ref: STAGING, status: 'ACTIVE_HEALTHY' };
  const schemas = ['auth', 'extensions', 'graphql', 'graphql_public', 'net', 'public', 'realtime', 'storage', 'supabase_functions', 'supabase_migrations', 'vault'].map(name => ({ name,
    owner: name === 'public' ? 'pg_database_owner' : ['extensions', 'supabase_migrations'].includes(name) ? 'postgres' : 'supabase_admin' }));
  const tables = [{ name: 'plan', kind: 'r' }, ...Array.from({ length: 58 }, (_, i) => ({ name: `table_${i}`, kind: 'r' }))];
  const counts = tables.map(t => ({ name: t.name, rows: t.name === 'plan' ? '3' : '0' }));
  const plans = [['demo', 'Demo', 50, 5, 0], ['empresa', 'Empresa', null, null, 2], ['flota', 'Flota', 500, 50, 1]].map(([clave, nombre, limite_viajes_mes, limite_operadores, orden]) => ({ clave, nombre, limite_viajes_mes, limite_operadores, orden, activo: true, moneda: 'MXN', precio_mensual: null, stripe_price_id: null, precio_iva_incluido: null }));
  const privateCounts = [{ users: '0', objects: '0', secrets: '0' }];
  const truncated = [{ schema: 'auth', name: 'users' }, { schema: 'auth', name: 'flow_state' }, { schema: 'supabase_functions', name: 'hooks' }];
  const truncatedCounts = truncated.map(t => ({ truncated_table: `${t.schema}.${t.name}`, rows: '0' }));
  const policies = JSON.parse(readFileSync('scripts/ci/fixtures/staging-storage-policies.json', 'utf8'));
  const policiesAfter = structuredClone(policies);
  let didReset = false;
  const physical = [{ tables: 154, rep_columns: 3, cfdi_pago: true, valid_indexes: 2 }];
  const migrations = readdirSync('supabase/migrations');
  const history = migrations.filter(x => /^\d{4}_.+\.sql$/.test(x)).map(x => ({ version: x.slice(0, 4) })).sort((a, b) => a.version.localeCompare(b.version));
  const files = new Map<string, string>([['supabase/.temp/project-ref', STAGING]]);
  const env = { NODE_ENV: 'test' as const, SUPABASE_ACCESS_TOKEN: 'synthetic-token', SUPABASE_DB_PASSWORD: 'synthetic-password', SUPABASE_PROJECT_REF: STAGING, RECOVERY_SOURCE_SHA: 'a'.repeat(40), RECOVERY_CONFIRM: 'RESET_EMPTY_STAGING', STAGING_WRITES_PAUSED: 'true', REVIEWED_BACKUP_RUN_ID: '123' };
  const fetch = vi.fn(async (url: string, options: { body?: string; method: string }) => {
    if (!options.body) {
      expect(options.method).toBe('GET');
      if (url === `https://api.supabase.com/v1/projects/${STAGING}`) return { ok: true, json: async () => project };
      expect(url).toBe('https://api.supabase.com/v1/projects/gngoqsvrxdguxvsizpbw/branches');
      return { ok: true, json: async () => branches };
    }
    expect(url).toBe(`https://api.supabase.com/v1/projects/${STAGING}/database/query`);
    const body = JSON.parse(options.body);
    expect(body.read_only).toBe(true);
    expect(body.query).toMatch(/^select\s/);
    const sql: string = body.query;
    if (sql.includes("schemaname <> 'public'")) expect(sql).toContain('to_json(roles) as roles');
    const result = sql.includes('nspname as name') ? schemas : sql.includes('n.nspname as schema') ? truncated : sql.includes('as truncated_table') ? truncatedCounts
      : sql.includes("schemaname <> 'public'") ? (didReset ? policiesAfter : policies) : sql.includes('c.relname as name') ? tables : sql.includes('union all') ? counts
      : sql.includes('as users') ? privateCounts : sql.includes('select * from public.plan') ? plans : sql.includes('as metadata') ? [{ metadata: { history, policies: [], triggers: [], default_acls: [], storage_buckets: [] } }]
      : sql.includes('select version') ? history : physical;
    return { ok: true, json: async () => result };
  });
  const spawn = vi.fn((_command: string, args: string[]) => {
    if (args.includes('dump')) files.set(args[args.indexOf('--file') + 1], `CREATE TABLE public.plan (clave text);\n${'-- schema\n'.repeat(20)}`);
    if (args.includes('reset')) didReset = true;
    return { status: 0 };
  });
  const deps = { directory: '/owned-backup', fetch, spawn, mkdir: vi.fn(), read: (path: string) => {
    const value = files.get(path); if (value === undefined) throw new Error('fixture missing'); return value;
  }, write: (path: string, content: string) => { files.set(path, content); }, readdir: () => migrations };
  return { branch, branches, project, schemas, tables, counts, privateCounts, truncated, truncatedCounts, policies, policiesAfter, plans, physical, history, files, env, deps, spawn, fetch, migrations };
}

describe('recuperación excepcional de staging vacío', () => {
  it('listado selecciona la identidad exacta entre otras ramas sin consultar detalle/config', async () => {
    const f = fixture(); f.branches.unshift({ ...f.branch, id: 'other', project_ref: 'another', name: 'production', is_default: true });
    await expect(recover('capture', f.env, f.deps)).resolves.toBeUndefined();
    expect(f.fetch.mock.calls.filter(([, opts]) => opts.method === 'GET')).toHaveLength(2);
  });
  it.each(['absent', 'duplicate', 'ref-collision'])('listado rechaza selección %s antes de SQL o CLI', async mode => {
    const f = fixture();
    if (mode === 'absent') f.branches.splice(0);
    else f.branches.push({ ...f.branch, id: mode === 'ref-collision' ? 'wrong-id' : f.branch.id });
    await expect(recover('capture', f.env, f.deps)).rejects.toThrow(mode === 'absent' ? 'RECOVERY_BRANCH_MISSING' : 'RECOVERY_BRANCH_AMBIGUOUS');
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it('listado no toma una respuesta de detalle como lista ni publica su configuración', async () => {
    const f = fixture();
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ...f.branch, private_config: 'synthetic-secret' }) }));
    await expect(recover('capture', f.env, { ...f.deps, fetch })).rejects.toThrow('RECOVERY_BRANCH_LIST_FORMAT');
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it('identidad fallida informa todas las comparaciones sin valores del proveedor', async () => {
    const f = fixture(); f.branch.name = 'synthetic-secret'; f.branch.preview_project_status = 'private-config';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(recover('capture', f.env, f.deps)).rejects.toThrow('RECOVERY_BRANCH_IDENTITY_NAME');
      expect(JSON.parse(log.mock.calls[0][0])).toEqual({ branch_identity_checks: { id: true, ref: true, parent: true, name: false, default: true, persistent: true, with_data: true, status: false } });
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/synthetic-secret|private-config/);
    } finally { log.mockRestore(); }
  });
  it('campo preview opcional ausente requiere salud activa del proyecto exacto', async () => {
    const f = fixture(); Reflect.deleteProperty(f.branch, 'preview_project_status');
    await expect(recover('capture', f.env, f.deps)).resolves.toBeUndefined();
    expect(f.fetch).toHaveBeenCalledWith(`https://api.supabase.com/v1/projects/${STAGING}`, expect.objectContaining({ method: 'GET', redirect: 'error' }));
  });
  it.each(['id', 'ref', 'status'] as const)('proyecto con %s conflictivo bloquea aunque branch diga healthy', async key => {
    const f = fixture(); f.project[key] = 'wrong';
    await expect(recover('capture', f.env, f.deps)).rejects.toThrow(`RECOVERY_PROJECT_IDENTITY_${key.toUpperCase()}`);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
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
    else if (mode === 'schema') f.schemas.push({ name: 'business', owner: 'postgres' });
    else if (mode === 'foreign') f.tables[0].kind = 'f';
    else f.counts.pop();
    await expect(recover('capture', f.env, f.deps)).rejects.toThrow('RECOVERY_');
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it.each(['auth.flow_state', 'supabase_functions.hooks'])('rechaza datos auxiliares truncables aunque auth.users=0: %s', async table => {
    const f = fixture(); f.truncatedCounts.find(r => r.truncated_table === table)!.rows = '1';
    await expect(recover('capture', f.env, f.deps)).rejects.toThrow('RECOVERY_TRUNCATED_DATA');
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it('rechaza un conteo omitido de tabla truncable', async () => {
    const f = fixture(); f.truncatedCounts.pop();
    await expect(recover('capture', f.env, f.deps)).rejects.toThrow('RECOVERY_TRUNCATED_DATA');
  });
  it('pgbouncer opcional sólo con su owner protegido; auth requiere supabase_admin', async () => {
    const f = fixture(); f.schemas.push({ name: 'pgbouncer', owner: 'pgbouncer' });
    await expect(recover('capture', f.env, f.deps)).resolves.toBeUndefined();
    f.schemas.at(-1)!.owner = 'postgres';
    await expect(recover('capture', f.env, f.deps)).rejects.toThrow('RECOVERY_SCHEMA_OWNER');
    f.schemas.pop(); f.schemas[0].owner = 'supabase_auth_admin';
    await expect(recover('capture', f.env, f.deps)).rejects.toThrow('RECOVERY_SCHEMA_OWNER');
  });
  it('policy ajena no reconstruida exige revisión antes de reset', async () => {
    const f = fixture(); f.policies.push({ ...f.policies[0], schemaname: 'auth', policyname: 'custom' });
    await expect(recover('capture', f.env, f.deps)).rejects.toThrow('RECOVERY_UNEXPECTED_POLICIES');
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it('una policy final con nombre correcto y permiso ampliado no obtiene verde', async () => {
    const f = fixture(); await recover('capture', f.env, f.deps); f.policiesAfter[1].qual = 'true';
    await expect(recover('execute', f.env, f.deps)).rejects.toThrow('RECOVERY_FINAL_POLICIES');
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
