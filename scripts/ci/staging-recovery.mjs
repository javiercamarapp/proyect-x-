#!/usr/bin/env node
// Recuperación excepcional de la rama staging vacía; nunca producción.
// Contratos: /docs/reference/api/v1-get-a-branch y v1-run-a-query.
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
const hash = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const fail = (code) => { throw new Error(code); };
const PLAN = [
  ['demo', 'Demo', 50, 5, 0], ['empresa', 'Empresa', null, null, 2], ['flota', 'Flota', 500, 50, 1],
].map(([clave, nombre, limite_viajes_mes, limite_operadores, orden]) => ({ clave, nombre, limite_viajes_mes, limite_operadores, orden,
  activo: true, moneda: 'MXN', precio_mensual: null, stripe_price_id: null, precio_iva_incluido: null }));

export function validateBranch(branch) {
  if (branch?.id !== BRANCH || branch.project_ref !== STAGING || branch.parent_project_ref !== PARENT
    || branch.name !== 'staging' || branch.is_default !== false || branch.persistent !== false
    || branch.with_data !== false || branch.preview_project_status !== 'ACTIVE_HEALTHY') fail('RECOVERY_BRANCH_IDENTITY');
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
  const branch = await request(`/v1/projects/${PARENT}/branches/staging`);
  validateBranch(branch);
  const schemas = await query("select nspname as name from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema' order by nspname");
  if (!Array.isArray(schemas) || canonical(schemas.map((s) => s.name)) !== canonical(SCHEMAS)) fail('RECOVERY_UNKNOWN_SCHEMA');
  const tables = await query("select c.relname as name, c.relkind as kind from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','m','f') order by c.relname");
  if (!Array.isArray(tables) || tables.length !== 59 || tables.some((t) => !/^[a-z_][a-z0-9_]*$/.test(t.name) || !['r', 'p'].includes(t.kind))
    || new Set(tables.map((t) => t.name)).size !== tables.length || !tables.some((t) => t.name === 'plan')) fail('RECOVERY_UNEXPECTED_TABLES');
  const counts = await query(tables.map((t) => `select '${t.name}' as name, count(*)::text as rows from public."${t.name}"`).join(' union all '));
  if (!Array.isArray(counts) || counts.length !== tables.length || new Set(counts.map((r) => r.name)).size !== tables.length
    || counts.some((r) => !tables.some((t) => t.name === r.name) || String(r.rows) !== (r.name === 'plan' ? '3' : '0'))) fail('RECOVERY_PUBLIC_DATA');
  const privateCounts = await query('select (select count(*)::text from auth.users) as users, (select count(*)::text from storage.objects) as objects, (select count(*)::text from vault.secrets) as secrets');
  if (!Array.isArray(privateCounts) || privateCounts.length !== 1
    || ['users', 'objects', 'secrets'].some((key) => String(privateCounts[0][key]) !== '0')) fail('RECOVERY_PRIVATE_DATA');
  const plans = await query('select * from public.plan order by clave');
  if (canonical(plans) !== canonical(PLAN)) fail('RECOVERY_PLAN_DRIFT');
  return { branch: { id: BRANCH, project_ref: STAGING, parent_project_ref: PARENT }, schemas, tables,
    counts: counts.sort((a, b) => a.name.localeCompare(b.name)), privateCounts, plans };
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
      'policies', (select jsonb_agg(to_jsonb(p)) from pg_policies p where schemaname in ('auth','storage')),
      'triggers', (select jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'definition',pg_get_triggerdef(t.oid))) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname in ('auth','storage')),
      'default_acls', (select jsonb_agg(to_jsonb(a)) from pg_default_acl a),
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
