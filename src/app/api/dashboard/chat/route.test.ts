import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const dobles = vi.hoisted(() => ({ analista: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/logger', async (original) => ({
  ...await original<Record<string, unknown>>(),
  logger: { info: vi.fn(), warn: vi.fn(), error: dobles.error },
}));
vi.mock('@/lib/auth/session', () => ({
  getSessionTenant: async () => ({ userId: 'u1', tenantId: 'tenant-fixture', rol: 'flota_admin', nombre: 'Ana' }),
}));
vi.mock('@/lib/auth/api-superadmin', () => ({ rechazoMfaSuperadminApi: async () => null }));
vi.mock('@/lib/auth/visibilidad', () => ({ puedeVerArea: () => true }));
vi.mock('@/lib/auth/csrf', () => ({ vieneDeNuestroSitio: () => true }));
vi.mock('@/lib/ratelimit', () => ({ rateLimit: async () => true }));
vi.mock('./tenant', () => ({ tenantEfectivoChat: async () => ({ tenantId: 'tenant-fixture', nombreFlota: 'Fixture' }) }));
vi.mock('./tope', () => ({ gastoChatHoyUsd: async () => 0, topeDiaUsd: () => 1 }));
vi.mock('@/lib/agents/analista', () => ({ ejecutarAnalista: (...args: unknown[]) => dobles.analista(...args) }));
vi.mock('@/lib/likida/costos', () => ({ registrarCosto: vi.fn(), faseDeModelo: () => 'chat' }));
vi.mock('@/lib/likida/chat/conversaciones', () => ({ guardarIntercambio: async () => null }));

import { POST } from './route';
import { PartialExecutionError } from '@/lib/llm/openrouter';
import { codigoDeError, sanitizarEventoSentry } from '@/lib/observability/sentry';

function peticion(): NextRequest {
  const url = 'https://likida.test/api/dashboard/chat';
  return Object.assign(new Request(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mensajes: [{ rol: 'usuario', texto: 'consulta privada canary@example.invalid' }] }),
  }), { nextUrl: new URL(url) }) as NextRequest;
}

beforeEach(() => { dobles.analista.mockReset(); dobles.error.mockReset(); });

describe('chat: la causa técnica sobrevive al saneador de Sentry sin prosa privada', () => {
  const causaTecnica = Object.assign(new Error('timeout al consultar canary@example.invalid'), { code: 'ETIMEDOUT' });
  const causaSinCodigo = new Error('falló consulta de canary@example.invalid');
  it.each([
    ['error técnico', causaTecnica, causaTecnica],
    ['error sin código', causaSinCodigo, causaSinCodigo],
    ['ejecución parcial', new PartialExecutionError('falló el analista', causaTecnica, [], 0, 0, 0), causaTecnica],
  ])('%s conserva tenant, ruta y código pero no mensaje ni documento', async (_nombre, error, causa) => {
    dobles.analista.mockRejectedValue(error);
    const res = await POST(peticion());
    const cuerpo = await res.text(); // consume el stream: incluye su catch
    expect(cuerpo).toContain('el analista no pudo responder');
    expect(cuerpo).not.toContain('canary@example.invalid');
    const llamada = dobles.error.mock.calls.find(([evento]) => evento === 'chat.analista.fallo');
    expect(llamada).toBeDefined();
    const limpio = sanitizarEventoSentry({ extra: llamada![1] }) as { extra?: Record<string, unknown> };
    expect(limpio.extra).toMatchObject({
      tenantId: 'tenant-fixture', ruta: '/api/dashboard/chat', codigo: codigoDeError(causa),
    });
    expect(JSON.stringify(limpio)).not.toMatch(/canary@example\.invalid|consulta privada/);
    expect(limpio.extra).not.toHaveProperty('err');
  });
});
