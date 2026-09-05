import { beforeEach, describe, expect, it, vi } from 'vitest';

type Sesion = {
  userId: string;
  tenantId: string | null;
  rol: string;
  nombre: string | null;
  operadorId: string | null;
  avatarUrl: string | null;
};

let sesion: Sesion | null = null;
let veredicto: 'ok' | 'inscribir' | 'retar' | 'no_verificable' = 'ok';

const consultarMfa = vi.fn(async () => veredicto);
const revalidatePath = vi.fn();
const pausarCampana = vi.fn(async () => ({ mensaje: 'Campaña pausada.' }));
const refrescarGastoMeta = vi.fn(async () => ({
  configurada: true,
  medidas: 1,
  fallidas: [],
}));

vi.mock('@/lib/auth/session', () => ({ getSessionTenant: async () => sesion }));
vi.mock('@/lib/auth/superadmin-mfa', () => ({
  veredictoMfaDeSesion: () => consultarMfa(),
}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('@/lib/admin/campanas', () => ({ pausarCampana, refrescarGastoMeta }));
vi.mock('@/lib/likida/errores', () => ({
  mensajeParaPantalla: (error: unknown, operacion: string) => `${operacion}: ${String(error)}`,
}));

const { accionPausarCampana, accionRefrescarGasto } = await import('./acciones');

async function ejecutarLasDos() {
  return Promise.all([
    accionPausarCampana('campana-1'),
    accionRefrescarGasto(),
  ]);
}

describe('acciones de /admin/crecimiento', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sesion = {
      userId: 'u-super',
      tenantId: null,
      rol: 'superadmin',
      nombre: 'Javier',
      operadorId: null,
      avatarUrl: null,
    };
    veredicto = 'ok';
  });

  it.each(['inscribir', 'retar', 'no_verificable'] as const)(
    'superadmin con MFA %s: rechaza y produce cero DB/Meta',
    async (resultadoMfa) => {
      veredicto = resultadoMfa;
      const resultados = await ejecutarLasDos();

      expect(resultados.every((r) => r.ok === false)).toBe(true);
      expect(pausarCampana).not.toHaveBeenCalled();
      expect(refrescarGastoMeta).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
      expect(consultarMfa).toHaveBeenCalledTimes(2);
    },
  );

  it('superadmin AAL2 ejecuta cada efecto exactamente una vez tras la puerta', async () => {
    const resultados = await ejecutarLasDos();

    expect(resultados.every((r) => r.ok)).toBe(true);
    expect(pausarCampana).toHaveBeenCalledOnce();
    expect(pausarCampana).toHaveBeenCalledWith('campana-1', 'u-super');
    expect(refrescarGastoMeta).toHaveBeenCalledOnce();
    expect(revalidatePath).toHaveBeenCalledTimes(2);
    expect(consultarMfa.mock.invocationCallOrder[0]).toBeLessThan(
      pausarCampana.mock.invocationCallOrder[0],
    );
  });

  it.each(['flota_admin', 'contador', 'encargado', 'vendedor', 'operador', 'sin_rol'])(
    'rol %s: rechaza ambas con cero efectos y ni consulta MFA',
    async (rol) => {
      sesion = { ...sesion!, rol };
      const resultados = await ejecutarLasDos();

      expect(resultados.every((r) => r.ok === false)).toBe(true);
      expect(pausarCampana).not.toHaveBeenCalled();
      expect(refrescarGastoMeta).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
      expect(consultarMfa).not.toHaveBeenCalled();
    },
  );
});
