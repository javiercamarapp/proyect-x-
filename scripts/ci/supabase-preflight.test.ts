import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { run } from './supabase-preflight.mjs';

const ref = 'abcdefghijklmnopqrst';
const url = `postgresql://postgres.${ref}@aws-0-us-east-2.pooler.supabase.com:5432/postgres`;
const env = { NODE_ENV: 'test' as const, SUPABASE_PROJECT_REF: ref, SUPABASE_DB_PASSWORD: 'synthetic-secret-canary' };
const read = (path: string) => path.endsWith('project-ref') ? ref : url;

describe('diagnóstico seguro del preflight PostgreSQL', () => {
  it('connection ejecuta sólo SELECT 1, con destino validado y sesión de sólo lectura', async () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: '1\n' }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run('connection', env, { read, spawn });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith('psql', [expect.stringContaining('sslmode=verify-full&sslrootcert=system'), '-X', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-At', '-c', 'SELECT 1'], expect.objectContaining({ timeout: 30_000, env: expect.objectContaining({ PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=15000' }) }));
      expect(JSON.stringify(log.mock.calls)).toContain('aws-0-us-east-2.pooler.supabase.com');
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/postgresql:|postgres\.|synthetic-secret/);
    } finally { log.mockRestore(); }
  });

  it('connection no acepta un exit 0 sin el resultado esperado ni pierde diagnóstico TLS', async () => {
    await expect(run('connection', env, { read, spawn: () => ({ status: 0, stdout: 'private-wrong-result' }) })).rejects.toThrow('PREFLIGHT_CONNECTION_RESULT');
    await expect(run('connection', env, { read, spawn: () => ({ status: 2, stderr: 'SSL error: certificate verify failed private' }) })).rejects.toThrow('PREFLIGHT_TLS_CERTIFICATE');
  });

  it('connection valida link y destino antes de ejecutar psql', async () => {
    const spawn = vi.fn();
    await expect(run('connection', env, { read: () => 'z'.repeat(20), spawn })).rejects.toThrow('Link de otro proyecto');
    await expect(run('connection', { ...env, SUPABASE_DB_URL: 'postgres://user:secret@external.example/db' }, { read, spawn })).rejects.toThrow('Destino PostgreSQL');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('job diagnóstico ejecuta connection después del listado y nunca preflight/DDL', () => {
    const workflow = readFileSync('.github/workflows/deploy-preview-promote.yml', 'utf8');
    const job = workflow.split('\n  diagnose_migrations:\n')[1].split('\n  repair_migrations:\n')[0];
    expect(job).toContain('ref: ${{ inputs.ref }}');
    expect(job.indexOf('supabase-preflight.mjs connection')).toBeGreaterThan(job.indexOf('migration list\n'));
    expect(job).toContain('SUPABASE_DB_URL:');
    expect(job).not.toMatch(/supabase-preflight\.mjs preflight|db push|migration repair/);
  });

  it.each([
    ['root certificate file "system" does not exist', 'PREFLIGHT_TLS_CA'],
    ['SSL error: certificate verify failed', 'PREFLIGHT_TLS_CERTIFICATE'],
    ['server certificate does not match host name', 'PREFLIGHT_TLS_CERTIFICATE'],
    ['server does not support SSL, but SSL was required', 'PREFLIGHT_TLS'],
    ['FATAL: password authentication failed for user "private-user"', 'PREFLIGHT_AUTH'],
    ['could not translate host name "secret.host" to address', 'PREFLIGHT_DNS'],
    ['connection to server failed: Connection refused', 'PREFLIGHT_CONNECT'],
    ['connection to server failed: timeout expired', 'PREFLIGHT_CONNECT_TIMEOUT'],
    ['psql:script.sql:4: ERROR:  42501: permission denied for relation private_table', 'PREFLIGHT_SQL_PERMISSION; SQLSTATE=42501'],
    ['psql:script.sql:4: ERROR:  42P01: relation private_table does not exist', 'PREFLIGHT_SQL_SCHEMA; SQLSTATE=42P01'],
    ['psql:script.sql:4: ERROR:  42703: column private_column does not exist', 'PREFLIGHT_SQL_SCHEMA; SQLSTATE=42703'],
    ['psql:script.sql:4: ERROR:  55P03: canceling statement due to lock timeout', 'PREFLIGHT_SQL_LOCK; SQLSTATE=55P03'],
    ['psql:script.sql:4: ERROR:  57014: canceling statement due to statement timeout', 'PREFLIGHT_SQL_CANCELLED; SQLSTATE=57014'],
    ['psql:script.sql:4: ERROR:  P0001: private condition', 'PREFLIGHT_SQL_CONDITION; SQLSTATE=P0001'],
    ['psql:script.sql:4: ERROR:  ZZ999: unknown private error', 'PREFLIGHT_SQL_OTHER'],
    ['private arbitrary diagnostic', 'PREFLIGHT_UNKNOWN'],
  ])('clasifica %s sin publicar stderr', async (stderr, code) => {
    const result = run('preflight', env, { read, spawn: () => ({ status: 2, stderr: `${stderr}\n${url}\n${env.SUPABASE_DB_PASSWORD}`, stdout: 'private-output' }) });
    await expect(result).rejects.toThrow(code);
    await expect(result).rejects.not.toThrow(/private|synthetic-secret|postgresql:|pooler\.supabase/);
  });

  it.each([['ENOENT', 'PREFLIGHT_PSQL_MISSING'], ['EACCES', 'PREFLIGHT_PSQL_PERMISSION'], ['ETIMEDOUT', 'PREFLIGHT_PROCESS_TIMEOUT'], ['ENOBUFS', 'PREFLIGHT_OUTPUT_LIMIT']])
  ('clasifica fallo de spawn %s', async (code, diagnostic) => {
    await expect(run('preflight', env, { read, spawn: () => ({ status: null, error: { code, message: url } }) })).rejects.toThrow(diagnostic);
  });

  it('un spawn que lanza tampoco publica su objeto Error', async () => {
    await expect(run('preflight', env, { read, spawn: () => { throw Object.assign(new Error(url), { code: 'ENOENT' }); } })).rejects.toThrow('PREFLIGHT_PSQL_MISSING');
  });

  it('solicita SQLSTATE e idioma estable, conserva TLS y contraseña sólo en entorno', async () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    await run('preflight', env, { read, spawn });
    expect(spawn).toHaveBeenCalledWith('psql', expect.arrayContaining(['VERBOSITY=verbose', expect.stringContaining('sslmode=verify-full&sslrootcert=system')]), expect.objectContaining({ env: expect.objectContaining({ LC_ALL: 'C', PGPASSWORD: env.SUPABASE_DB_PASSWORD }) }));
  });

  it.each(['preflight', 'connection'])('CLI %s con proceso hijo real imprime sólo diagnóstico permitido y sale 1', (mode) => {
    const directory = mkdtempSync(join(tmpdir(), 'preflight-diagnostic-'));
    try {
      /* eslint-disable security/detect-non-literal-fs-filename -- Rutas fijas dentro del directorio efímero propio, sin entradas externas. */
      mkdirSync(join(directory, 'supabase/.temp'), { recursive: true });
      writeFileSync(join(directory, 'supabase/.temp/project-ref'), ref);
      writeFileSync(join(directory, 'supabase/.temp/pooler-url'), url);
      writeFileSync(join(directory, 'psql'), '#!/bin/sh\necho "psql:script.sql:4: ERROR:  42501: secret-table $PGPASSWORD" >&2\nexit 3\n', { mode: 0o700 });
      /* eslint-enable security/detect-non-literal-fs-filename */
      const result = spawnSync(process.execPath, [resolve('scripts/ci/supabase-preflight.mjs'), mode], { cwd: directory, env: { ...env, PATH: directory }, encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('PREFLIGHT_SQL_PERMISSION; SQLSTATE=42501');
      expect(result.stderr).not.toMatch(/secret-table|synthetic-secret|postgresql:|pooler\.supabase/);
      if (mode === 'preflight') expect(result.stdout).toBe('');
      else expect(JSON.parse(result.stdout)).toEqual({ connection_host: 'aws-0-us-east-2.pooler.supabase.com', tls: 'verify-full', read_only: true });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
