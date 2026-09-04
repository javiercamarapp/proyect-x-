import { beforeEach, describe, expect, it, vi } from 'vitest';

const veredicto = vi.fn(async (): Promise<string> => 'ok');
vi.mock('./mfa', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  veredictoMfaSuperadmin: () => veredicto(),
}));
vi.mock('@/lib/supabase/server', () => ({ supabaseServer: async () => ({}) }));

const { veredictoMfaDeSesion } = await import('./superadmin-mfa');

describe('veredictoMfaDeSesion — puerta server-safe compartida', () => {
  beforeEach(() => {
    veredicto.mockReset();
    veredicto.mockResolvedValue('ok');
    vi.unstubAllEnvs();
  });

  it('un rol tenant sigue pasando aunque MFA de superadmin esté obligatorio, sin consultar Auth MFA', async () => {
    vi.stubEnv('LIKIDA_SUPERADMIN_MFA', 'obligatorio');
    await expect(veredictoMfaDeSesion({ rol: 'contador' })).resolves.toBe('ok');
    expect(veredicto).not.toHaveBeenCalled();
  });

  it.each(['inscribir', 'retar', 'no_verificable', 'ok'] as const)(
    'superadmin conserva el veredicto %s de Supabase',
    async (resultado) => {
      vi.stubEnv('LIKIDA_SUPERADMIN_MFA', 'obligatorio');
      veredicto.mockResolvedValue(resultado);
      await expect(veredictoMfaDeSesion({ rol: 'superadmin' })).resolves.toBe(resultado);
      expect(veredicto).toHaveBeenCalledTimes(1);
    },
  );
});
