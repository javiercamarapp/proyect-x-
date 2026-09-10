import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /dashboard/chat — CERO cobertura de la PÁGINA. Sin server actions (ChatFlota
// es un client component aparte), pero con una regla de seguridad heredada
// real (inventario §12): getKpis/getAcreditables sólo se piden DESPUÉS de
// puedeVerArea(rol,'dinero') — antes de esa corrección, un encargado podía
// leer cifras de dinero por este camino aunque el resto del panel se las
// negara. Y H13 (auditoría 24): tenantNombre/tenantExiste deben llegar a la
// vista para que un superadmin sepa DE QUÉ flota le contesta la IA.
// ═══════════════════════════════════════════════════════════════════════════

type Elemento = ReactElement<Record<string, unknown>>;

const dobles = vi.hoisted(() => ({
  getKpis: vi.fn(),
  getAcreditables: vi.fn(),
}));

let sesion: { tenantId: string; rol: string; tenantNombre: string | null; tenantExiste: boolean } = {
  tenantId: 't-1', rol: 'flota_admin', tenantNombre: null, tenantExiste: true,
};

vi.mock('@/lib/auth/tenant-efectivo', () => ({ resolverTenantEfectivo: async () => sesion }));
vi.mock('next/navigation', () => ({
  redirect: (ruta: string) => { throw new Error(`REDIRECT:${ruta}`); },
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/likida/analytics', async (importar) => ({
  ...(await importar<typeof import('@/lib/likida/analytics')>()),
  getKpis: dobles.getKpis,
  getAcreditables: dobles.getAcreditables,
}));

import ChatFlota from '../chat';
import { AvisoSinFlota } from '../sin-flota';
import PaginaChat from './page';

function buscar(nodo: ReactNode, componente: unknown, salida: Elemento[] = []): Elemento[] {
  if (Array.isArray(nodo)) { for (const hijo of nodo) buscar(hijo, componente, salida); return salida; }
  if (!isValidElement<Record<string, unknown>>(nodo)) return salida;
  if (nodo.type === componente) salida.push(nodo);
  buscar(nodo.props.children as ReactNode, componente, salida);
  return salida;
}

const SP = Promise.resolve({});

beforeEach(() => {
  vi.clearAllMocks();
  sesion = { tenantId: 't-1', rol: 'flota_admin', tenantNombre: null, tenantExiste: true };
  dobles.getKpis.mockResolvedValue({ porRevisar: 0 });
  dobles.getAcreditables.mockResolvedValue({ litros: 0 });
});

it.each(['encargado', 'vendedor'])('%s no puede preguntarle a la IA por dinero: redirect ANTES de leer KPIs', async (rol) => {
  sesion = { tenantId: 't-1', rol, tenantNombre: null, tenantExiste: true };
  await expect(PaginaChat({ searchParams: SP })).rejects.toThrow('REDIRECT:/dashboard');
  expect(dobles.getKpis).not.toHaveBeenCalled();
  expect(dobles.getAcreditables).not.toHaveBeenCalled();
});

it.each(['flota_admin', 'superadmin', 'contador'])('%s (área dinero) sí puede', async (rol) => {
  sesion = { tenantId: 't-1', rol, tenantNombre: null, tenantExiste: true };
  await expect(PaginaChat({ searchParams: SP })).resolves.toBeTruthy();
});

it('pide los KPIs y acreditables del tenant de la SESIÓN', async () => {
  await PaginaChat({ searchParams: SP });
  expect(dobles.getKpis).toHaveBeenCalledWith('t-1');
  expect(dobles.getAcreditables).toHaveBeenCalledWith('t-1', expect.any(Number));
});

it('un fallo de KPIs no tumba el chat — pasa null, no rompe la página (fail-open del lado de disponibilidad)', async () => {
  dobles.getKpis.mockRejectedValueOnce(new Error('caída'));
  const pagina = await PaginaChat({ searchParams: SP });
  const chat = buscar(pagina, ChatFlota)[0];
  expect(chat.props.kpis).toBeNull();
});

it('superadmin viendo-como otra flota: se le dice CUÁL, para no contestar sobre "mi flota" en el aire', async () => {
  sesion = { tenantId: 't-otra', rol: 'superadmin', tenantNombre: 'Transportes Otra Flota', tenantExiste: true };
  const html = (await import('react-dom/server')).renderToStaticMarkup(await PaginaChat({ searchParams: SP }));
  expect(html).toContain('viendo como superadmin');
  expect(html).toContain('Transportes Otra Flota');
});

it('flota que ya no existe (H13): avisa ANTES de la conversación, no la deja pasar como si fuera real', async () => {
  sesion = { tenantId: 't-borrada', rol: 'superadmin', tenantNombre: null, tenantExiste: false };
  const pagina = await PaginaChat({ searchParams: SP });
  expect(buscar(pagina, AvisoSinFlota)).toHaveLength(1);
});

it('flota que sí existe: no se muestra el aviso de flota inexistente', async () => {
  const pagina = await PaginaChat({ searchParams: SP });
  expect(buscar(pagina, AvisoSinFlota)).toHaveLength(0);
});
