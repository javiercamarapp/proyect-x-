import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('bus real aislado conserva catálogo y avisa cuando omite una vista previa', () => {
  // La fixture copia los dos scripts a un directorio propio con .env.local
  // sintético y HTTP loopback; nunca ejecuta el bus contra credenciales reales.
  const resultado = JSON.parse(execFileSync('python3', [
    'scripts/ci/innovativos-capacidad/worker_wire.py',
  ], { encoding: 'utf8', timeout: 30_000 }));
  expect(resultado.catalog.batch_counts).toEqual([50, 50, 21]);
  expect(resultado.exact3MiB.wire_size).toBeLessThan(4_400_000);
  expect(resultado.over3MiB.stdout).toContain('sin vista previa');
}, 35_000);
