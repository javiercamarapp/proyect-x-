import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/agentes — CERO cobertura de la PÁGINA (definiciones.ts e
// interruptores.ts ya tienen prueba propia). El layout de /admin ya gatea
// con requireSuperadmin(), pero las DOS server actions lo RE-CHEQUEAN por su
// cuenta (comentario propio del archivo: "el action es un endpoint público
// en la práctica — el layout solo protegió el render").
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({
  requireSuperadmin: vi.fn(),
  validarDefinicion: vi.fn(),
  darDeAltaAgente: vi.fn(),
  apagar: vi.fn(),
  encender: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: (ruta: string) => { throw new Error(`REDIRECT:${ruta}`); } }));
vi.mock('next/cache', () => ({ revalidatePath: dobles.revalidatePath }));
vi.mock('@/lib/auth/guard', () => ({ requireSuperadmin: dobles.requireSuperadmin }));
vi.mock('@/lib/likida/agentes/definiciones', async (importar) => ({
  ...(await importar<typeof import('@/lib/likida/agentes/definiciones')>()),
  validarDefinicion: dobles.validarDefinicion,
  darDeAltaAgente: dobles.darDeAltaAgente,
}));
vi.mock('@/lib/likida/interruptores', () => ({ apagar: dobles.apagar, encender: dobles.encender }));

import { DatoInvalido } from '@/lib/likida/errores';
import PaginaAgentes from './page';

type Accion1 = (previo: unknown, fd: FormData) => Promise<{ ok?: string; error?: string }>;
type PropsAgentes = { accionAlta: Accion1; accionPalanca: Accion1 };
const fd = (campos: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(campos)) f.set(k, v); return f; };
const DEF_VALIDA = { id: 'nuevo_agente', nombre: 'Nuevo agente', departamento: 'exito', descripcion: 'x', disparador: 'manual', presupuestoDiaUsd: 1, promptRef: null };

beforeEach(() => {
  vi.clearAllMocks();
  dobles.requireSuperadmin.mockResolvedValue({ userId: 'u-1', rol: 'superadmin', nombre: 'Javier', avatarUrl: null });
  dobles.validarDefinicion.mockReturnValue(DEF_VALIDA);
});

it('un no-superadmin es redirigido por el propio requireSuperadmin al renderizar', async () => {
  dobles.requireSuperadmin.mockImplementationOnce(() => { throw new Error('REDIRECT:/dashboard'); });
  await expect(PaginaAgentes()).rejects.toThrow('REDIRECT:/dashboard');
});

it('alta de agente: llega DISEÑADO, sin migración — usa el userId del actor real', async () => {
  dobles.darDeAltaAgente.mockResolvedValue(undefined);
  const pagina = await PaginaAgentes() as unknown as { props: PropsAgentes };
  const r = await pagina.props.accionAlta(null, fd({
    id: 'nuevo_agente', nombre: 'Nuevo agente', departamento: 'exito', descripcion: 'x',
    disparador: 'manual', presupuestoDiaUsd: '1',
  }));
  expect(dobles.darDeAltaAgente).toHaveBeenCalledWith(DEF_VALIDA, 'u-1');
  expect(r).toEqual(expect.objectContaining({ ok: expect.stringContaining('DISEÑADO') }));
  expect(dobles.revalidatePath).toHaveBeenCalledWith('/admin/agentes');
});

it('alta de agente: un DatoInvalido llega verbatim, no genérico', async () => {
  dobles.validarDefinicion.mockImplementationOnce(() => { throw new DatoInvalido('El id del agente va en minúsculas.'); });
  const pagina = await PaginaAgentes() as unknown as { props: PropsAgentes };
  const r = await pagina.props.accionAlta(null, fd({ id: 'MAL', nombre: 'x', departamento: 'exito', descripcion: 'x', disparador: 'manual', presupuestoDiaUsd: '1' }));
  expect(r).toEqual(expect.objectContaining({ error: expect.stringContaining('minúsculas') }));
  expect(dobles.darDeAltaAgente).not.toHaveBeenCalled();
});

it('alta de agente: la server action re-chequea superadmin, aunque el render haya sido autorizado', async () => {
  const pagina = await PaginaAgentes() as unknown as { props: PropsAgentes };
  dobles.requireSuperadmin.mockImplementationOnce(() => { throw new Error('REDIRECT:/dashboard'); });
  await expect(pagina.props.accionAlta(null, fd({ id: 'x', nombre: 'x', departamento: 'exito', descripcion: 'x', disparador: 'manual', presupuestoDiaUsd: '1' })))
    .rejects.toThrow('REDIRECT:/dashboard');
  expect(dobles.darDeAltaAgente).not.toHaveBeenCalled();
});

it('palanca: apagar manda motivo y el actorId real, revalida las DOS pantallas (agentes y observabilidad, misma palanca)', async () => {
  dobles.apagar.mockResolvedValue(undefined);
  const pagina = await PaginaAgentes() as unknown as { props: PropsAgentes };
  const r = await pagina.props.accionPalanca(null, fd({ id: 'cazador', operacion: 'apagar', motivo: 'ruido en producción' }));
  expect(dobles.apagar).toHaveBeenCalledWith('cazador', 'ruido en producción', 'u-1');
  expect(r).toEqual({ ok: '"cazador" quedó APAGADO.' });
  expect(dobles.revalidatePath).toHaveBeenCalledWith('/admin/agentes');
  expect(dobles.revalidatePath).toHaveBeenCalledWith('/admin/observabilidad');
});

it('palanca: encender manda el actorId real', async () => {
  dobles.encender.mockResolvedValue(undefined);
  const pagina = await PaginaAgentes() as unknown as { props: PropsAgentes };
  const r = await pagina.props.accionPalanca(null, fd({ id: 'cazador', operacion: 'encender' }));
  expect(dobles.encender).toHaveBeenCalledWith('cazador', 'u-1');
  expect(r).toEqual({ ok: '"cazador" quedó encendido.' });
});

it('palanca: una operación desconocida no se adivina — error explícito, ninguna palanca se mueve', async () => {
  const pagina = await PaginaAgentes() as unknown as { props: PropsAgentes };
  const r = await pagina.props.accionPalanca(null, fd({ id: 'cazador', operacion: 'reiniciar' }));
  expect(r).toEqual({ error: 'Operación desconocida: "reiniciar".' });
  expect(dobles.apagar).not.toHaveBeenCalled();
  expect(dobles.encender).not.toHaveBeenCalled();
});

it('palanca: re-chequea superadmin de forma independiente al render', async () => {
  const pagina = await PaginaAgentes() as unknown as { props: PropsAgentes };
  dobles.requireSuperadmin.mockImplementationOnce(() => { throw new Error('REDIRECT:/dashboard'); });
  await expect(pagina.props.accionPalanca(null, fd({ id: 'cazador', operacion: 'apagar', motivo: 'x' })))
    .rejects.toThrow('REDIRECT:/dashboard');
  expect(dobles.apagar).not.toHaveBeenCalled();
});
