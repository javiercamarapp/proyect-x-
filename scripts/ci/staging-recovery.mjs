#!/usr/bin/env node
// Recuperación excepcional de la rama staging vacía; nunca producción.
// Contratos: /docs/reference/api/v1-list-all-branches y v1-run-a-query.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateDatabase } from './supabase-preflight.mjs';

export const STAGING = 'dmhhygwzgudwgcbixuwp';
const PARENT = 'gngoqsvrxdguxvsizpbw';
const BRANCH = 'f4996abd-1c9b-46e3-89d9-91a2d2053f03';
const SCHEMAS = ['auth', 'extensions', 'graphql', 'graphql_public', 'net', 'public', 'realtime', 'storage', 'supabase_functions', 'supabase_migrations', 'vault'];
// Capturado de PostgreSQL17 propio tras aplicar0046+0126; no copiar las
// expresiones viejas de staging al reconstruir las policies.
const STORAGE_POLICIES = JSON.parse(readFileSync(new URL('./fixtures/staging-storage-policies.json', import.meta.url), 'utf8'));
// Management API puede serializar name[] como literal PostgreSQL. JSON fija
// el contrato de roles como array, igual al catálogo canónico capturado.
const POLICIES_QUERY = "select schemaname,tablename,policyname,permissive,to_json(roles) as roles,cmd,qual,with_check from pg_policies where schemaname <> 'public' order by schemaname,tablename,policyname";
const schemaOwner = (name) => ({ public: 'pg_database_owner', extensions: 'postgres', supabase_migrations: 'postgres', pgbouncer: 'pgbouncer' }[name] ?? 'supabase_admin');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const fail = (code) => { throw new Error(code); };
const PLAN = [
  ['demo', 'Demo', 50, 5, 0], ['empresa', 'Empresa', null, null, 2], ['flota', 'Flota', 500, 50, 1],
].map(([clave, nombre, limite_viajes_mes, limite_operadores, orden]) => ({ clave, nombre, limite_viajes_mes, limite_operadores, orden,
  activo: true, moneda: 'MXN', precio_mensual: null, stripe_price_id: null, precio_iva_incluido: null }));

export function validateBranch(branch) {
  // Sólo comparaciones booleanas: nunca valores o configuración recibidos.
  const checks = {
    id: branch?.id === BRANCH, ref: branch?.project_ref === STAGING,
    parent: branch?.parent_project_ref === PARENT, name: branch?.name === 'staging',
    default: branch?.is_default === false, persistent: branch?.persistent === false,
    with_data: branch?.with_data === false,
    // Campo opcional de BranchResponse_Output. La salud obligatoria se
    // consulta después en GET projects/{ref}; un valor conflictivo sí bloquea.
    status: branch?.preview_project_status === undefined || branch.preview_project_status === 'ACTIVE_HEALTHY',
  };
  const failed = Object.entries(checks).find(([, passed]) => !passed);
  if (failed) {
    console.error(JSON.stringify({ branch_identity_checks: checks }));
    fail(`RECOVERY_BRANCH_IDENTITY_${failed[0].toUpperCase()}`);
  }
}

export async function inspectEmpty(env, deps = {}) {
  if (env.SUPABASE_PROJECT_REF !== STAGING || !env.SUPABASE_ACCESS_TOKEN) fail('RECOVERY_STAGING_CREDENTIALS');
  const request = async (path, query) => {
    const response = await (deps.fetch ?? fetch)(`https://api.supabase.com${path}`, {
      method: query ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, ...(query ? { 'Content-Type': 'application/json' } : {}) },
      ...(query ? { body: JSON.stringify({ query, read_only: true }) } : {}),
    });
    if (!response.ok) fail('RECOVERY_METADATA_HTTP');
    return response.json();
  };
  const query = (sql) => request(`/v1/projects/${STAGING}/database/query`, sql);
  const branches = await request(`/v1/projects/${PARENT}/branches`);
  if (!Array.isArray(branches)) fail('RECOVERY_BRANCH_LIST_FORMAT');
  // Una colisión parcial también es ambigua: no elegir silenciosamente un
  // registro correcto si otro comparte su id o project_ref.
  const matches = branches.filter((entry) => entry?.id === BRANCH || entry?.project_ref === STAGING);
  if (!matches.length) fail('RECOVERY_BRANCH_MISSING');
  if (matches.length !== 1) fail('RECOVERY_BRANCH_AMBIGUOUS');
  const branch = matches[0];
  validateBranch(branch);
  const project = await request(`/v1/projects/${STAGING}`);
  const projectChecks = { id: project?.id === STAGING, ref: project?.ref === STAGING, status: project?.status === 'ACTIVE_HEALTHY' };
  const projectFailure = Object.entries(projectChecks).find(([, passed]) => !passed);
  if (projectFailure) {
    console.error(JSON.stringify({ project_identity_checks: projectChecks }));
    fail(`RECOVERY_PROJECT_IDENTITY_${projectFailure[0].toUpperCase()}`);
  }
  const schemas = await query("select nspname as name, nspowner::regrole::text as owner from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema' order by nspname");
  if (!Array.isArray(schemas) || canonical(schemas.filter((s) => s.name !== 'pgbouncer').map((s) => s.name)) !== canonical(SCHEMAS)
    || schemas.filter((s) => s.name === 'pgbouncer').length > 1) fail('RECOVERY_UNKNOWN_SCHEMA');
  if (schemas.some((s) => s.owner !== schemaOwner(s.name))) fail('RECOVERY_SCHEMA_OWNER');
  const tables = await query("select c.relname as name, c.relkind as kind from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','m','f') order by c.relname");
  if (!Array.isArray(tables) || tables.length !== 59 || tables.some((t) => !/^[a-z_][a-z0-9_]*$/.test(t.name) || !['r', 'p'].includes(t.kind))
    || new Set(tables.map((t) => t.name)).size !== tables.length || !tables.some((t) => t.name === 'plan')) fail('RECOVERY_UNEXPECTED_TABLES');
  const counts = await query(tables.map((t) => `select '${t.name}' as name, count(*)::text as rows from public."${t.name}"`).join(' union all '));
  if (!Array.isArray(counts) || counts.length !== tables.length || new Set(counts.map((r) => r.name)).size !== tables.length
    || counts.some((r) => !tables.some((t) => t.name === r.name) || String(r.rows) !== (r.name === 'plan' ? '3' : '0'))) fail('RECOVERY_PUBLIC_DATA');
  const privateCounts = await query('select (select count(*)::text from auth.users) as users, (select count(*)::text from storage.objects) as objects, (select count(*)::text from vault.secrets) as secrets');
  if (!Array.isArray(privateCounts) || privateCounts.length !== 1
    || ['users', 'objects', 'secrets'].some((key) => String(privateCounts[0][key]) !== '0')) fail('RECOVERY_PRIVATE_DATA');
  const truncated = await query("select n.nspname as schema, c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and ((n.nspname='auth' and c.relname<>'schema_migrations') or (n.nspname='supabase_functions' and c.relname<>'migrations')) order by n.nspname,c.relname");
  if (!Array.isArray(truncated) || !truncated.length || truncated.some((t) => !['auth', 'supabase_functions'].includes(t.schema) || !/^[a-z_][a-z0-9_]*$/.test(t.name)
    || t.name === (t.schema === 'auth' ? 'schema_migrations' : 'migrations'))
    || new Set(truncated.map((t) => `${t.schema}.${t.name}`)).size !== truncated.length) fail('RECOVERY_TRUNCATED_INVENTORY');
  const truncatedCounts = await query(truncated.map((t) => `select '${t.schema}.${t.name}' as truncated_table, count(*)::text as rows from "${t.schema}"."${t.name}"`).join(' union all '));
  if (!Array.isArray(truncatedCounts) || truncatedCounts.length !== truncated.length
    || new Set(truncatedCounts.map((t) => t.truncated_table)).size !== truncated.length
    || truncatedCounts.some((r) => !truncated.some((t) => `${t.schema}.${t.name}` === r.truncated_table) || String(r.rows) !== '0')) fail('RECOVERY_TRUNCATED_DATA');
  const policies = await query(POLICIES_QUERY);
  const policyIdentity = (p) => ({ schemaname: p.schemaname, tablename: p.tablename, policyname: p.policyname, roles: p.roles, cmd: p.cmd, permissive: p.permissive });
  if (!Array.isArray(policies) || canonical(policies.map(policyIdentity)) !== canonical(STORAGE_POLICIES.map(policyIdentity))) fail('RECOVERY_UNEXPECTED_POLICIES');
  const plans = await query('select * from public.plan order by clave');
  if (canonical(plans) !== canonical(PLAN)) fail('RECOVERY_PLAN_DRIFT');
  return { branch: { id: BRANCH, project_ref: STAGING, parent_project_ref: PARENT }, project: { id: STAGING, ref: STAGING, status: 'ACTIVE_HEALTHY' }, schemas, tables,
    counts: counts.sort((a, b) => a.name.localeCompare(b.name)), privateCounts, plans, policies,
    truncated, truncatedCounts: truncatedCounts.sort((a, b) => a.truncated_table.localeCompare(b.truncated_table)) };
}

export async function recover(mode, env = process.env, deps = {}) {
  if (!['capture', 'execute'].includes(mode)) fail('RECOVERY_MODE');
  if (env.SUPABASE_PROJECT_REF !== STAGING || !env.SUPABASE_DB_PASSWORD) fail('RECOVERY_STAGING_CREDENTIALS');
  if (env.SUPABASE_DB_URL) validateDatabase(env.SUPABASE_DB_URL, STAGING);
  if (!/^[0-9a-f]{40}$/.test(env.RECOVERY_SOURCE_SHA ?? '')) fail('RECOVERY_SOURCE_SHA');
  const migrationFiles = (deps.readdir ?? readdirSync)('supabase/migrations').filter((name) => /\.sql$/i.test(name));
  if (migrationFiles.some((name) => !/^\d{4}_.+\.sql$/.test(name))) fail('RECOVERY_LOCAL_MIGRATIONS');
  const expected = migrationFiles.map((name) => name.slice(0, 4)).sort();
  if (expected.length !== 324 || new Set(expected).size !== 324 || expected.at(-1) !== '0347') fail('RECOVERY_LOCAL_MIGRATIONS');
  const directory = deps.directory ?? resolve('staging-recovery-backup');
  const read = deps.read ?? readFileSync;
  const write = deps.write ?? writeFileSync;
  const cli = (phase, args) => {
    const result = (deps.spawn ?? spawnSync)('npx', ['--yes', 'supabase@2.115.0', ...args], {
      env, encoding: 'utf8', stdio: 'pipe', timeout: 1_200_000, maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status !== 0 || result.error) fail(`RECOVERY_${phase}_FAILED`);
  };
  const query = async (sql) => {
    const response = await (deps.fetch ?? fetch)(`https://api.supabase.com/v1/projects/${STAGING}/database/query`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql, read_only: true }),
    });
    if (!response.ok) fail('RECOVERY_METADATA_HTTP');
    return response.json();
  };
  const linked = () => { if (read('supabase/.temp/project-ref', 'utf8').trim() !== STAGING) fail('RECOVERY_LINK_MISMATCH'); };
  if (mode === 'capture') {
    const snapshot = await inspectEmpty(env, deps);
    (deps.mkdir ?? mkdirSync)(directory, { recursive: true, mode: 0o700 });
    cli('LINK', ['link', '--project-ref', STAGING]);
    linked();
    cli('DUMP', ['db', 'dump', '--linked', '--schema', 'public', '--file', join(directory, 'public.sql')]);
    const schema = read(join(directory, 'public.sql'), 'utf8');
    if (schema.length < 100 || !schema.includes('CREATE TABLE')) fail('RECOVERY_BACKUP_EMPTY');
    const metadata = await query(`select jsonb_build_object(
      'history', (select jsonb_agg(to_jsonb(m) order by version) from supabase_migrations.schema_migrations m),
      'policies', (select jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname) from pg_policies p),
      'triggers', (select jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'definition',pg_get_triggerdef(t.oid))) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname in ('auth','storage')),
      'default_acls', (select jsonb_agg(to_jsonb(a)) from pg_default_acl a),
      'roles', (select jsonb_agg(jsonb_build_object('name',rolname,'superuser',rolsuper,'inherit',rolinherit,'create_role',rolcreaterole,'create_db',rolcreatedb,'login',rolcanlogin,'replication',rolreplication,'bypass_rls',rolbypassrls) order by rolname) from pg_roles),
      'role_memberships', (select jsonb_agg(jsonb_build_object('role',roleid::regrole::text,'member',member::regrole::text,'admin_option',admin_option)) from pg_auth_members),
      'storage_buckets', (select jsonb_agg(to_jsonb(b) order by id) from storage.buckets b)
    ) as metadata`);
    if (!Array.isArray(metadata) || metadata.length !== 1 || !metadata[0].metadata) fail('RECOVERY_METADATA_FORMAT');
    write(join(directory, 'snapshot.json'), canonical(snapshot), { mode: 0o600 });
    write(join(directory, 'plan.json'), canonical(snapshot.plans), { mode: 0o600 });
    write(join(directory, 'metadata.json'), canonical(metadata), { mode: 0o600 });
    write(join(directory, 'manifest.json'), canonical({ schema_sha256: hash(schema), snapshot_sha256: hash(canonical(snapshot)),
      plan_sha256: hash(canonical(snapshot.plans)), metadata_sha256: hash(canonical(metadata)), source_sha: env.RECOVERY_SOURCE_SHA,
      captured_at: new Date().toISOString(), staging_ref: STAGING }), { mode: 0o600 });
    console.log('RECOVERY_BACKUP_READY: esquema y tres planes guardados; todavía no se ejecutó reset.');
    return;
  }
  if (env.RECOVERY_CONFIRM !== 'RESET_EMPTY_STAGING' || env.STAGING_WRITES_PAUSED !== 'true'
    || !/^[0-9]+$/.test(env.REVIEWED_BACKUP_RUN_ID ?? '')) fail('RECOVERY_CONFIRMATION');
  // Otro runner descarga el artefacto revisado: volver a enlazar sólo staging.
  cli('LINK', ['link', '--project-ref', STAGING]);
  linked();
  const manifest = JSON.parse(read(join(directory, 'manifest.json'), 'utf8'));
  const before = read(join(directory, 'snapshot.json'), 'utf8');
  if (manifest.staging_ref !== STAGING || manifest.source_sha !== env.RECOVERY_SOURCE_SHA || hash(before) !== manifest.snapshot_sha256
    || hash(read(join(directory, 'public.sql'))) !== manifest.schema_sha256
    || hash(read(join(directory, 'plan.json'))) !== manifest.plan_sha256
    || hash(read(join(directory, 'metadata.json'))) !== manifest.metadata_sha256) fail('RECOVERY_BACKUP_INTEGRITY');
  const age = Date.now() - Date.parse(manifest.captured_at);
  if (!Number.isFinite(age) || age < 0 || age > 3_600_000) fail('RECOVERY_BACKUP_STALE');
  if (canonical(await inspectEmpty(env, deps)) !== before) fail('RECOVERY_CHANGED_AFTER_BACKUP');
  // Esta comprobación inmediata no bloquea escritores externos. El operador
  // debe mantener staging sin escrituras durante toda la recuperación.
  cli('RESET', ['db', 'reset', '--linked', '--no-seed', '--version', '0331', '--yes']);
  linked();
  const preflight = (deps.spawn ?? spawnSync)(process.execPath, ['scripts/ci/supabase-preflight.mjs', 'preflight'], {
    env, encoding: 'utf8', stdio: 'pipe', timeout: 750_000,
  });
  if (preflight.status !== 0 || preflight.error) fail('RECOVERY_INDEX_PREFLIGHT_FAILED');
  cli('PUSH', ['db', 'push', '--linked', '--yes']);
  const applied = await query('select version from supabase_migrations.schema_migrations order by version');
  if (canonical(applied) !== canonical(expected.map((version) => ({ version })))) fail('RECOVERY_FINAL_HISTORY');
  const physical = await query(`select
    (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')) as tables,
    (select count(*) from information_schema.columns where table_schema='public' and table_name='gasto' and (column_name,data_type) in (('metodo_pago','text'),('pagado_en','date'),('pagado_forma','text'))) as rep_columns,
    to_regclass('public.cfdi_pago') is not null as cfdi_pago,
    (select count(*) from pg_index where indexrelid in (to_regclass('public.wa_conversacion_purga_idx'),to_regclass('public.codigo_pendiente_purga_idx')) and indisvalid and indisready) as valid_indexes`);
  if (!Array.isArray(physical) || physical.length !== 1 || Number(physical[0].tables) !== 154
    || Number(physical[0].rep_columns) !== 3 || physical[0].cfdi_pago !== true || Number(physical[0].valid_indexes) !== 2) fail('RECOVERY_FINAL_SCHEMA');
  const policiesAfter = await query(POLICIES_QUERY);
  const normalizePolicies = (rows) => rows.map((p) => ({ ...p,
    qual: p.qual?.replace(/\s+/g, ' ').trim() ?? null,
    with_check: p.with_check?.replace(/\s+/g, ' ').trim() ?? null,
  }));
  if (!Array.isArray(policiesAfter) || canonical(normalizePolicies(policiesAfter)) !== canonical(normalizePolicies(STORAGE_POLICIES))) fail('RECOVERY_FINAL_POLICIES');
  write(join(directory, 'policies-after.json'), canonical(policiesAfter), { mode: 0o600 });
  write(join(directory, 'physical.json'), canonical(physical), { mode: 0o600 });
  write(join(directory, 'applied.json'), canonical(applied), { mode: 0o600 });
  console.log('RECOVERY_MIGRATIONS_COMPLETE: historial reconstruido hasta 0347; verificar catálogo, permisos API y Preview antes del release.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  recover(process.argv[2]).catch((error) => {
    console.error(/^RECOVERY_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'RECOVERY_FAILED_SAFE');
    process.exitCode = 1;
  });
}
