import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../presupuesto', () => ({ acotada: (q: unknown) => q }));

const estado = vi.hoisted(() => ({
  watermark: null as string | null,
  token: 'claim-a',
  llamadas: [] as Array<{ nombre: string; args: Record<string, unknown> }>,
}));

const rpc = vi.hoisted(() => vi.fn(async (nombre: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> => {
  estado.llamadas.push({ nombre, args });
  if (nombre === 'reclamar_polls_conector') {
    return {
      data: [{
        tenant_id: 't-1', proveedor: 'samsara', valores_cifrados: 'cifrado',
        claim_token: estado.token, watermark_en: estado.watermark,
        tail_watermark_en: null,
      }],
      error: null,
    };
  }
  if (nombre === 'finalizar_poll_conector') {
    if (args.p_claim_token !== estado.token) return { data: false, error: null };
    if (args.p_completo && args.p_watermark_en) estado.watermark = String(args.p_watermark_en);
    return { data: true, error: null };
  }
  return { data: null, error: { message: 'rpc inesperado' } };
}));

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ rpc }) }));

import { finalizarPoll, reclamarPolls } from './poll_durable';

describe('estado durable del poll GPS/eventos', () => {
  beforeEach(() => {
    estado.watermark = null;
    estado.token = 'claim-a';
    estado.llamadas = [];
    rpc.mockClear();
  });

  it('el hot claim no ejecuta provisionamiento ni mueve el bootstrap durable', async () => {
    const original = '2026-08-01T00:00:00.000Z';
    estado.watermark = original; // provisionado por trigger/backfill 0324
    const primero = await reclamarPolls('eventos', ['samsara'], 200, { bootstrapDesde: original });
    await finalizarPoll('eventos', primero[0], { completo: false, error: 'scope 403' });

    const movido = '2026-08-11T00:00:00.000Z';
    const segundo = await reclamarPolls('eventos', ['samsara'], 200, { bootstrapDesde: movido });

    expect(primero[0].watermarkEn).toBe(original);
    expect(segundo[0].watermarkEn).toBe(original);
    const claims = estado.llamadas.filter((l) => l.nombre === 'reclamar_polls_conector');
    expect(claims[0].args).toMatchObject({ p_lease_segundos: 360 });
    expect(claims[0].args).not.toHaveProperty('p_bootstrap_desde');
    expect(claims[1].args).not.toHaveProperty('p_bootstrap_desde');
  });

  it('un resultado incompleto no avanza watermark; uno completo sí', async () => {
    const inicio = '2026-08-01T00:00:00.000Z';
    estado.watermark = inicio;
    const [claim] = await reclamarPolls('eventos', ['samsara'], 200, { bootstrapDesde: inicio });
    await finalizarPoll('eventos', claim, {
      completo: false, watermarkEn: null, paginas: 11, elementos: 250,
      error: 'falló una tanda de Postgres',
    });
    expect(estado.watermark).toBe(inicio);

    const fin = '2026-08-01T06:00:00.000Z';
    await finalizarPoll('eventos', claim, {
      completo: true, watermarkEn: fin, paginas: 11, elementos: 250,
    });
    expect(estado.watermark).toBe(fin);
  });

  it('rechaza un finalizador con token ajeno o vencido', async () => {
    const [claim] = await reclamarPolls('posiciones', ['samsara']);
    await expect(finalizarPoll('posiciones', { ...claim, claimToken: 'ajeno' }, {
      completo: true, paginas: 11, elementos: 5_100,
    })).rejects.toThrow('lease vencido o ajeno');
  });

  it('persiste por separado tail e inválidos observables', async () => {
    estado.watermark = '2026-08-01T00:00:00.000Z';
    const [claim] = await reclamarPolls('eventos', ['samsara']);
    await finalizarPoll('eventos', claim, {
      completo: false,
      tailCompleto: true,
      tailWatermarkEn: '2026-09-03T12:00:00.000Z',
      invalidos: 3,
      elementos: 4,
      error: 'backfill pendiente',
    });
    const fin = estado.llamadas.find((l) => l.nombre === 'finalizar_poll_conector');
    expect(fin?.args).toMatchObject({
      p_completo: false,
      p_tail_completo: true,
      p_tail_watermark_en: '2026-09-03T12:00:00.000Z',
      p_invalidos: 3,
    });
  });
});

describe('frontera de persistencia del poll', () => {
  it('no convierte una respuesta de claim inválida ni un error SQL en cola vacía', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(reclamarPolls('eventos', ['samsara'])).rejects.toThrow('respuesta inválida');
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'sin permisos' } });
    await expect(reclamarPolls('posiciones', ['samsara'])).rejects.toThrow('posiciones.claims: sin permisos');
  });

  it('preserva tenant, proveedor y fencing al finalizar y recorta sólo el diagnóstico', async () => {
    estado.token = 'claim-frontera';
    const [claim] = await reclamarPolls('eventos', ['samsara'], 17);
    await finalizarPoll('eventos', claim, { completo: false, error: 'x'.repeat(1200) });
    expect(rpc).toHaveBeenLastCalledWith('finalizar_poll_conector', expect.objectContaining({
      p_tenant: 't-1', p_proveedor: 'samsara', p_recurso: 'eventos',
      p_claim_token: 'claim-frontera', p_error: 'x'.repeat(1000),
    }));
    expect(rpc).toHaveBeenCalledWith('reclamar_polls_conector', expect.objectContaining({
      p_limite: 17, p_lease_segundos: 360, p_worker: expect.any(String),
    }));
  });
});
