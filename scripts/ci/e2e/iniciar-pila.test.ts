import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { iniciarPila } from './iniciar-pila.mjs';

const carpetas: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const p of carpetas.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-contract-')); carpetas.push(root);
  mkdirSync(join(root, 'supabase/migrations'), { recursive: true });
  const config = '[db]\nport = 59322\n[db.migrations]\nenabled = true\n[db.seed]\nenabled = true\nsql_paths = ["./seed.sql"]\n[auth]\nenabled = true\n';
  writeFileSync(join(root, 'supabase/config.toml'), config);
  for (const name of ['0001_init.sql', '0331_capacidad.sql', '0332_retencion.sql', '0347_revision.sql']) writeFileSync(join(root, 'supabase/migrations', name), '-- fixture');
  return { root, config };
}

it('aplica preflight fuera de migraciones antes del resto y conserva la configuración original', () => {
  vi.stubEnv('CI', 'true');
  const { root, config } = fixture();
  const llamadas: Array<{ command: string; args: string[] }> = [];
  let temporal = '';
  iniciarPila(root, (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    llamadas.push({ command, args });
    if (llamadas.length === 1) {
      temporal = args[2];
      expect(readFileSync(join(temporal, 'supabase/config.toml'), 'utf8')).toContain('[db.seed]\nenabled = false');
      expect(readdirSync(join(temporal, 'supabase/migrations'))).toEqual(['0001_init.sql', '0331_capacidad.sql']);
    }
    if (command === 'psql') {
      expect(args.slice(0, 8)).toEqual(['-h', '127.0.0.1', '-p', '59322', '-U', 'postgres', '-d', 'postgres']);
      expect(options.env.PGHOSTADDR).toBe('127.0.0.1');
      expect(args).not.toContain('--single-transaction');
    }
    return { status: 0 };
  });
  expect(llamadas.map(l => l.command)).toEqual(['supabase', 'psql', 'supabase', 'psql', 'psql']);
  expect(llamadas[1].args.at(-1)).toBe(join(root, 'scripts/ci/0335_preflight_retencion_indices.sql'));
  expect(llamadas[2].args).toEqual(['migration', 'up', '--local', '--workdir', root]);
  expect(llamadas[3].args.at(-1)).toBe(join(root, 'supabase/seed.sql'));
  expect(readFileSync(join(root, 'supabase/config.toml'), 'utf8')).toBe(config);
  expect(readdirSync(join(root, 'supabase/migrations'))).toHaveLength(4);
  expect(existsSync(temporal)).toBe(false);
});

it.each([1, 2, 3])('fallo en paso %i impide los posteriores y limpia sólo su copia temporal', fallaEn => {
  vi.stubEnv('CI', 'true');
  const { root, config } = fixture(); let n = 0; let temporal = '';
  expect(() => iniciarPila(root, (_command: string, args: string[]) => {
    n++; if (n === 1) temporal = args[2];
    return { status: n === fallaEn ? 1 : 0 };
  })).toThrow('Falló bootstrap local');
  expect(n).toBe(fallaEn);
  expect(existsSync(temporal)).toBe(false);
  expect(readFileSync(join(root, 'supabase/config.toml'), 'utf8')).toBe(config);
});

it('no arranca ni siembra fuera de un runner CI explícito', () => {
  vi.stubEnv('CI', ''); const run = vi.fn();
  expect(() => iniciarPila('/no-leer', run)).toThrow('runner CI');
  expect(run).not.toHaveBeenCalled();
});
