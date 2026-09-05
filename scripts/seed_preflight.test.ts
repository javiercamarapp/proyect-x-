/* eslint-disable security/detect-non-literal-fs-filename -- fixtures propias bajo mkdtemp; nunca usa una base real */
import { afterEach, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function run(options: { failPreflight?: boolean; schema?: boolean; tenant?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'seed-preflight-')); dirs.push(dir);
  for (const sub of ['scripts/ci', 'supabase/migrations', 'bin']) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, 'scripts/seed.sh'), readFileSync('scripts/seed.sh'));
  for (const name of ['0001_init.sql', '0331_capacidad.sql', '0332_db_retencion_producto.sql', '0347_revision.sql']) {
    writeFileSync(join(dir, 'supabase/migrations', name), '-- fixture');
  }
  writeFileSync(join(dir, 'scripts/ci/0335_preflight_retencion_indices.sql'), '-- fixture');
  writeFileSync(join(dir, 'supabase/seed.sql'), '-- fixture');
  const fake = join(dir, 'bin/psql');
  writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const sql = args.join(' ');
const options = JSON.parse(process.env.SEED_TEST_OPTIONS);
if (sql.includes('information_schema.tables')) { if (options.schema || options.tenant) console.log('1'); process.exit(0); }
if (sql.includes('select nombre from tenant')) { console.log(options.tenant || 'Flota Demo'); process.exit(0); }
const file = args.includes('-f') ? args[args.indexOf('-f') + 1] : 'bucket';
fs.appendFileSync('calls.jsonl', JSON.stringify({file, args:args.filter(a => !a.startsWith('postgres'))})+'\\n');
if (file.endsWith('0335_preflight_retencion_indices.sql')) {
  if (!args.includes('-X') || args.includes('--single-transaction') || args.includes('-1')) process.exit(8);
  if (options.failPreflight) process.exit(7);
  fs.writeFileSync('preflight-ok','1');
}
if (file.includes('/0332_') && !fs.existsSync('preflight-ok')) { console.error('55000: preflight requerido'); process.exit(9); }
`);
  chmodSync(fake, 0o755);
  const result = spawnSync('bash', ['scripts/seed.sh'], {
    cwd: dir, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, DATABASE_URL: 'postgresql://localhost:1/synthetic', SUPABASE_DB_URL: '', SEED_TEST_OPTIONS: JSON.stringify(options) },
  });
  let calls: Array<{ file: string; args: string[] }> = [];
  try { calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { /* guard antes de escribir */ }
  return { ...result, calls };
}

it('prepara índices en autocommit después de0331 y antes de0332, y termina el seed', () => {
  const r = run();
  expect(r.status, r.stderr).toBe(0);
  expect(r.calls.map(c => c.file)).toEqual([
    'supabase/migrations/0001_init.sql', 'supabase/migrations/0331_capacidad.sql',
    'scripts/ci/0335_preflight_retencion_indices.sql', 'supabase/migrations/0332_db_retencion_producto.sql',
    'supabase/migrations/0347_revision.sql', 'bucket', 'supabase/seed.sql',
  ]);
});
it('fallo del preflight impide0332, bucket y seed', () => {
  const r = run({ failPreflight: true });
  expect(r.status).toBe(7);
  expect(r.calls.at(-1)?.file).toBe('scripts/ci/0335_preflight_retencion_indices.sql');
});
it('esquema existente conserva política de sólo datos sin reaplicar DDL', () => {
  const r = run({ schema: true });
  expect(r.status).toBe(0);
  expect(r.calls.map(c => c.file)).toEqual(['bucket', 'supabase/seed.sql']);
});
it('el guard de nombre continúa frenando antes de cualquier preflight o escritura', () => {
  const r = run({ tenant: 'Cliente sintético ajeno' });
  expect(r.status).toBe(1);
  expect(r.stdout).toContain('REHUSADO');
  expect(r.calls).toEqual([]);
});
