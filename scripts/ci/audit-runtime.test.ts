import { describe, expect, it } from 'vitest';
import { clasificarAuditoriaRuntime } from './audit-runtime.mjs';

describe('clasificador de npm audit para dependencias runtime', () => {
  it('acepta un reporte concluyente sin high ni critical', () => {
    expect(clasificarAuditoriaRuntime({
      metadata: { vulnerabilities: { low: 0, moderate: 2, high: 0, critical: 0 } },
    })).toEqual({ tipo: 'limpia', high: 0, critical: 0 });
  });

  it('bloquea vulnerabilidades high/critical aunque npm termine con exit 1', () => {
    expect(clasificarAuditoriaRuntime({
      metadata: { vulnerabilities: { high: 2, critical: 1 } },
    })).toEqual({ tipo: 'vulnerable', high: 2, critical: 1 });
  });

  it('distingue un 503 del registry para que CI reintente sin fingir verde', () => {
    expect(clasificarAuditoriaRuntime({
      error: { code: 'E503', summary: 'Service Unavailable - POST /-/npm/v1/security/advisories/bulk' },
    })).toEqual(expect.objectContaining({ tipo: 'inconclusa', codigo: 'E503' }));
  });

  it('un objeto inesperado también es inconcluso, nunca limpio', () => {
    expect(clasificarAuditoriaRuntime({})).toEqual(expect.objectContaining({ tipo: 'inconclusa' }));
  });
});
