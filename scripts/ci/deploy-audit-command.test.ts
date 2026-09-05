import { it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

it.each([['clean', 0], ['vulnerable', 1], ['invalid', 1]])('el comando REAL del deploy clasifica npm audit %s', (kind, expected) => {
  const workflow = readFileSync('.github/workflows/deploy-preview-promote.yml', 'utf8');
  const step = workflow.split('      - name: Auditoría runtime high/critical')[1].split('\n      - ')[0];
  const command = step.split('        run: |\n')[1].split('\n').map((line) => line.slice(10)).join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'likida-audit-command-'));
  try {
    const report = kind === 'invalid' ? {} : { metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: kind === 'vulnerable' ? 1 : 0, critical: 0, total: kind === 'vulnerable' ? 1 : 0 } } };
    // Dobles sólo de registry/temporizadores; node ejecuta el clasificador real.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- ruta propia mkdtemp; fixture sintética eliminada en finally.
    writeFileSync(join(dir, 'npm'), `#!/bin/sh\nprintf '%s' '${JSON.stringify(report)}'\nexit ${kind === 'vulnerable' ? 1 : 0}\n`, { mode: 0o700 });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- ruta propia mkdtemp; fixture sintética eliminada en finally.
    writeFileSync(join(dir, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o700 });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- ruta propia mkdtemp; fixture sintética eliminada en finally.
    writeFileSync(join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const result = spawnSync('bash', ['-e', '-c', command], { env: { ...process.env, RUNNER_TEMP: dir, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stderr).toBe(expected);
    expect(result.stderr).not.toContain('Uso: node');
    if (kind === 'invalid') expect(result.stdout).toContain('3 intentos');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
