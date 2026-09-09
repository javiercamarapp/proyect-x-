import { isValidElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /dashboard/llaves-api — hasta esta prueba, CERO cobertura: ni un test de
// componente ni una prueba de navegador tocaban esta página, pese a que emite
// y revoca credenciales reales de la API (`tenant_api_key`). Las funciones de
// escritura (`llave-api-escritura.test.ts`) ya están probadas; lo que faltaba
// es la PUERTA — que la página exija el mismo permiso en las dos server
// actions, y que el tenant/usuario que se graba sea el de la SESIÓN, nunca el
// del formulario (mismo patrón de `rutas_export.test.ts`).
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({
  crearLlaveApi: vi.fn(),
  revocarLlaveApi: vi.fn(),
  listarLlavesApi: vi.fn(),
  revalidatePath: vi.fn(),
}));

let sesion: { tenantId: string; rol: string; userId: string } = { tenantId: 't-1', rol: 'flota_admin', userId: 'u-1' };

vi.mock('@/lib/auth/tenant-efectivo', () => ({ resolverTenantEfectivo: async () => sesion }));
vi.mock('next/navigation', () => ({ redirect: (ruta: string) => { throw new Error(`REDIRECT:${ruta}`); } }));
vi.mock('next/cache', () => ({ revalidatePath: dobles.revalidatePath }));
vi.mock('@/lib/auth/llave-api-escritura', async (importar) => ({
  ...(await importar<typeof import('@/lib/auth/llave-api-escritura')>()),
  crearLlaveApi: dobles.crearLlaveApi,
  revocarLlaveApi: dobles.revocarLlaveApi,
  listarLlavesApi: dobles.listarLlavesApi,
}));

import { DatoInvalido } from '@/lib/likida/errores';
import { ListaLlaves } from './vista';
import { FormaEmision, type AccionForma } from './forma';
import PaginaLlavesApi from './page';

/** Busca, en el árbol ya renderizado (sin montar DOM), la primera prop de
 *  nombre `propName` de un elemento cuyo `type` sea `componente` — así se
 *  extraen las server actions reales que la página cerró por CLOSURE, sin
 *  duplicar su lógica en el doble. */
function buscarProp<T>(nodo: ReactNode, componente: unknown, propName: string): T | undefined {
  if (Array.isArray(nodo)) { for (const hijo of nodo) { const r = buscarProp<T>(hijo, componente, propName); if (r !== undefined) return r; } return undefined; }
  if (!isValidElement<Record<string, unknown>>(nodo)) return undefined;
  if (nodo.type === componente && propName in nodo.props) return nodo.props[propName] as T;
  return buscarProp<T>(nodo.props.children as ReactNode, componente, propName);
}

const SP = Promise.resolve({});
const fd = (campos: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(campos)) f.set(k, v); return f; };

beforeEach(() => {
  vi.clearAllMocks();
  sesion = { tenantId: 't-1', rol: 'flota_admin', userId: 'u-1' };
  dobles.listarLlavesApi.mockResolvedValue([]);
});

it.each(['contador', 'encargado', 'vendedor'])('%s no puede ver la página: redirect antes de tocar la base', async (rol) => {
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  await expect(PaginaLlavesApi({ searchParams: SP })).rejects.toThrow('REDIRECT:/dashboard');
  expect(dobles.listarLlavesApi).not.toHaveBeenCalled();
});

it.each(['flota_admin', 'superadmin'])('%s sí puede ver la página', async (rol) => {
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  await expect(PaginaLlavesApi({ searchParams: SP })).resolves.toBeTruthy();
});

it('una base caída se enseña como error, no como "cero llaves" — invitaría a duplicar', async () => {
  dobles.listarLlavesApi.mockRejectedValueOnce(new Error('caída'));
  const pagina = await PaginaLlavesApi({ searchParams: SP });
  const props = buscarProp<{ llaves: unknown }>(pagina, ListaLlaves, 'llaves');
  expect(props).toBeUndefined(); // ListaLlaves ni se monta: se pinta EstadoError en su lugar.
});

it('emitir: manda tenant/usuario de la SESIÓN (no del form) y devuelve el secreto una sola vez', async () => {
  dobles.crearLlaveApi.mockResolvedValue({ enClaro: 'lk_live_secreto123', prefijo: 'lk_live_', expiraEn: '2027-01-01T00:00:00Z' });
  const pagina = await PaginaLlavesApi({ searchParams: SP });
  const emitir = buscarProp<AccionForma>(pagina, FormaEmision, 'accion');
  expect(emitir).toBeTypeOf('function');

  const r = await emitir!(null, fd({ nombre: 'TMS propio', area: 'administracion', vigencia: '1a', tenantId: 'OTRO-TENANT', userId: 'OTRO-USUARIO' }));

  expect(dobles.crearLlaveApi).toHaveBeenCalledWith(
    't-1', // el tenant de la sesión, ignora `tenantId` del form (que ni siquiera existe como campo)
    { nombre: 'TMS propio', area: 'administracion', vigencia: '1a' },
    'u-1', // el usuario de la sesión, ignora `userId` del form
  );
  expect(r).toEqual(expect.objectContaining({ ok: true, secreto: { enClaro: 'lk_live_secreto123', prefijo: 'lk_live_' } }));
  expect(dobles.revalidatePath).toHaveBeenCalledWith('/dashboard/llaves-api');
});

it.each(['contador', 'encargado', 'vendedor'])('emitir: la server action rechaza a %s aunque se invoque directo (segunda puerta, sesión re-resuelta en el momento)', async (rol) => {
  // La página se renderiza autorizada (para poder extraer la action real,
  // cerrada por CLOSURE) y LUEGO cambia el rol: la action vuelve a resolver
  // la sesión en el momento de la llamada, no reutiliza la del render — así
  // es como la 0093 cierra el POST directo a una server action ya conocida.
  const pagina = await PaginaLlavesApi({ searchParams: SP });
  const emitir = buscarProp<AccionForma>(pagina, FormaEmision, 'accion');
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  const r = await emitir!(null, fd({ nombre: 'x', area: 'administracion', vigencia: '1a' }));
  expect(r).toEqual({ ok: false, error: 'Solo el dueño de la flota emite llaves de API.' });
  expect(dobles.crearLlaveApi).not.toHaveBeenCalled();
});

it('emitir: un error del motor (DatoInvalido) llega verbatim, no genérico', async () => {
  dobles.crearLlaveApi.mockRejectedValueOnce(new DatoInvalido('El nombre no puede pasar de 80 caracteres.'));
  const pagina = await PaginaLlavesApi({ searchParams: SP });
  const emitir = buscarProp<AccionForma>(pagina, FormaEmision, 'accion');
  const r = await emitir!(null, fd({ nombre: 'x'.repeat(90), area: 'administracion', vigencia: '1a' }));
  expect(r).toEqual(expect.objectContaining({ ok: false }));
  expect((r as { error: string }).error).toContain('80 caracteres');
});

it('revocar: manda tenant/usuario de la SESIÓN, el id viaja por el form', async () => {
  dobles.revocarLlaveApi.mockResolvedValue(undefined);
  dobles.listarLlavesApi.mockResolvedValue([{
    id: 'll-1', nombre: 'TMS', area: 'administracion', prefijo: 'lk_live_',
    creadaEn: '2026-01-01T00:00:00Z', expiraEn: null, ultimoUsoEn: null, revocadaEn: null,
  }]);
  const pagina = await PaginaLlavesApi({ searchParams: SP });
  const revocar = buscarProp<AccionForma>(pagina, ListaLlaves, 'revocarLlave');
  expect(revocar).toBeTypeOf('function');

  const r = await revocar!(null, fd({ id: 'll-1', tenantId: 'OTRO-TENANT' }));

  expect(dobles.revocarLlaveApi).toHaveBeenCalledWith('t-1', 'll-1', 'u-1');
  expect(r).toEqual({ ok: true, mensaje: 'Llave revocada.' });
  expect(dobles.revalidatePath).toHaveBeenCalledWith('/dashboard/llaves-api');
});

it.each(['contador', 'encargado', 'vendedor'])('revocar: la server action rechaza a %s aunque se invoque directo (segunda puerta, sesión re-resuelta en el momento)', async (rol) => {
  dobles.listarLlavesApi.mockResolvedValue([{
    id: 'll-1', nombre: 'TMS', area: 'administracion', prefijo: 'lk_live_',
    creadaEn: '2026-01-01T00:00:00Z', expiraEn: null, ultimoUsoEn: null, revocadaEn: null,
  }]);
  const pagina = await PaginaLlavesApi({ searchParams: SP });
  const revocar = buscarProp<AccionForma>(pagina, ListaLlaves, 'revocarLlave');
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  const r = await revocar!(null, fd({ id: 'll-1' }));
  expect(r).toEqual({ ok: false, error: 'Solo el dueño de la flota revoca llaves de API.' });
  expect(dobles.revocarLlaveApi).not.toHaveBeenCalled();
});
