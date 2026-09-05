import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { expect, it } from 'vitest';

it('toda dependencia vendorizada conserva procedencia, bytes verificados e integridad del lock', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const manifest = JSON.parse(readFileSync('vendor/PROVENANCE.json', 'utf8')) as {
    artifacts: Array<{ package: string; version: string; file: string; source: string; sha512: string }>;
  };
  const vendorizadas = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies })
    .filter(([, spec]) => typeof spec === 'string' && spec.startsWith('file:'));
  expect(manifest.artifacts.map(a => a.package).sort()).toEqual(vendorizadas.map(([name]) => name).sort());

  for (const [name, spec] of vendorizadas) {
    const artifact = manifest.artifacts.find(a => a.package === name)!;
    expect(spec).toBe(`file:${artifact.file}`);
    const path = resolve(artifact.file);
    expect(path.startsWith(resolve('vendor') + sep)).toBe(true);
    expect(new URL(artifact.source).protocol).toBe('https:');
    // Ruta del manifiesto versionado, restringida arriba al directorio vendor.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const digest = createHash('sha512').update(readFileSync(path)).digest();
    expect(digest.toString('hex')).toBe(artifact.sha512);
    const locked = lock.packages[`node_modules/${name}`];
    expect(locked.version).toBe(artifact.version);
    expect(locked.resolved).toBe(`file:${artifact.file}`);
    expect(locked.integrity).toBe(`sha512-${digest.toString('base64')}`);
  }
});
