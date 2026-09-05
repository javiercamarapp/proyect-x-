#!/usr/bin/env node
// Supabase inicia hasta 0331; el preflight concurrente va fuera de una
// transacción, antes de aplicar el resto y sembrar el runner desechable.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** @param {string} root
 * @param {(command: string, args: string[], options: {cwd: string, env: NodeJS.ProcessEnv, stdio: 'inherit'}) => {status: number | null, error?: unknown}} run
 */
export function iniciarPila(root = process.cwd(), run = spawnSync) {
  if (process.env.CI !== 'true') throw new Error('Este bootstrap requiere un runner CI desechable');
  const config = readFileSync(join(root, 'supabase/config.toml'), 'utf8');
  const db = config.match(/^\[db\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
  const port = db?.match(/^port\s*=\s*(\d+)\s*$/m)?.[1];
  if (!port || Number(port) < 1024 || Number(port) > 65535) throw new Error('Puerto local de PostgreSQL inválido');
  const seed = /^\[db\.seed\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m;
  if (!seed.test(config) || !/^enabled\s*=\s*true\s*$/m.test(config.match(seed)[1])) throw new Error('Configuración de seed inesperada');
  const parcial = config.replace(seed, block => block.replace(/^enabled\s*=\s*true\s*$/m, 'enabled = false'));
  const temp = mkdtempSync(join(tmpdir(), 'likida-e2e-bootstrap-'));
  const execute = (command, args, env = process.env) => {
    const result = run(command, args, { cwd: root, env, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`Falló bootstrap local: ${command} (salida ${result.status})`);
  };
  const pgEnv = { ...process.env, PGHOSTADDR: '127.0.0.1', PGPASSWORD: 'postgres', PGSSLMODE: 'disable' };
  const psql = ['-h', '127.0.0.1', '-p', port, '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1'];
  try {
    const migrations = join(temp, 'supabase/migrations');
    mkdirSync(migrations, { recursive: true });
    writeFileSync(join(temp, 'supabase/config.toml'), parcial);
    const iniciales = readdirSync(join(root, 'supabase/migrations')).filter(name => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) <= '0331').sort();
    if (!iniciales.some(name => name.startsWith('0331_'))) throw new Error('Falta el corte de migraciones 0331');
    for (const name of iniciales) copyFileSync(join(root, 'supabase/migrations', name), join(migrations, name));
    execute('supabase', ['start', '--workdir', temp]);
    execute('psql', [...psql, '-f', join(root, 'scripts/ci/0335_preflight_retencion_indices.sql')], pgEnv);
    execute('supabase', ['migration', 'up', '--local', '--workdir', root]);
    execute('psql', [...psql, '-f', join(root, 'supabase/seed.sql')], pgEnv);
    execute('psql', [...psql, '-c', "NOTIFY pgrst, 'reload schema';"], pgEnv);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) iniciarPila();
