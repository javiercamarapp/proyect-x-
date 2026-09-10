import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/compliance — CERO cobertura. Única página de este lote con una
// server action real: accionResolver, que cierra una solicitud ARCO (LFPDPPP
// art. 31). La puerta de la PÁGINA (leer solicitudes) vive en el layout de
// /admin, pero la ACTION vuelve a exigir requireSuperadmin() adentro —
// mismo patrón de doble puerta que ya vimos en /dashboard: una server action
// es un endpoint alcanzable por POST directo. También cubre ADM-10
// (auditoría 24): una base caída al leer la solicitud NO se confunde con
// "la solicitud no existe" — son mensajes DISTINTOS a propósito.
// ═══════════════════════════════════════════════════════════════════════════

type Elemento = ReactElement<Record<string, unknown>>;

const dobles = vi.hoisted(() => ({
  requireSuperadmin: vi.fn(),
  resolverSolicitudArco: vi.fn(),
  getSolicitudesArcoPendientes: vi.fn(),
  revalidatePath: vi.fn(),
  getSessionTenant: vi.fn(),
  from: vi.fn(),
}));

vi.mock('@/lib/auth/guard', () => ({ requireSuperadmin: dobles.requireSuperadmin }));
vi.mock('next/cache', () => ({ revalidatePath: dobles.revalidatePath }));
vi.mock('@/lib/likida/repo', async (importar) => ({
  ...(await importar<typeof import('@/lib/likida/repo')>()),
  resolverSolicitudArco: dobles.resolverSolicitudArco,
}));
vi.mock('@/lib/admin/escalaciones', async (importar) => ({
  ...(await importar<typeof import('@/lib/admin/escalaciones')>()),
  getSolicitudesArcoPendientes: dobles.getSolicitudesArcoPendientes,
}));
vi.mock('@/lib/auth/session', () => ({ getSessionTenant: dobles.getSessionTenant }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: dobles.from }) }));

import { DatoInvalido } from '@/lib/likida/errores';
import { FormaConAviso } from '../ui/forma';
import CompliancePage from './page';

function buscar(nodo: ReactNode, componente: unknown, salida: Elemento[] = []): Elemento[] {
  if (Array.isArray(nodo)) { for (const hijo of nodo) buscar(hijo, componente, salida); return salida; }
  if (!isValidElement<Record<string, unknown>>(nodo)) return salida;
  if (nodo.type === componente) salida.push(nodo);
  buscar(nodo.props.children as ReactNode, componente, salida);
  return salida;
}
type AccionForma = (previo: unknown, fd: FormData) => Promise<{ ok?: string; error?: string }>;
const fd = (campos: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(campos)) f.set(k, v); return f; };

const SOLICITUD_PENDIENTE = {
  id: 's-1', tipo: 'acceso', canal: 'whatsapp', estado: 'recibida', titular_ref: '5219991234567',
  recibida_en: '2026-01-01T00:00:00Z', vence_en: '2026-02-01', resuelta_en: null, resolucion: null,
  tenant_id: 't-1', operador: { nombre: 'Juan' }, flota: { nombre: 'Transportes X' },
};

function encadenar(datos: unknown, error: unknown = null) {
  const cadena: Record<string, unknown> = {};
  cadena.select = () => cadena;
  cadena.eq = () => cadena;
  cadena.order = () => cadena;
  cadena.range = async () => ({ data: datos, error, count: Array.isArray(datos) ? datos.length : 0 });
  cadena.maybeSingle = async () => ({ data: datos, error });
  return cadena;
}

beforeEach(() => {
  vi.clearAllMocks();
  dobles.getSessionTenant.mockResolvedValue({ userId: 'u-admin', tenantId: null, rol: 'superadmin' });
  dobles.getSolicitudesArcoPendientes.mockResolvedValue([]);
  dobles.from.mockReturnValue(encadenar([]));
});

it('sin sesión (getSessionTenant null), la página no revienta — pinta cero solicitudes', async () => {
  dobles.getSessionTenant.mockResolvedValue(null);
  const pagina = await CompliancePage();
  const html = (await import('react-dom/server')).renderToStaticMarkup(pagina);
  expect(html).toContain('Ninguna solicitud ARCO registrada');
});

it('resolver: exige requireSuperadmin() DENTRO de la action — un POST directo sin sesión de superadmin se rechaza', async () => {
  dobles.from.mockReturnValue(encadenar([SOLICITUD_PENDIENTE]));
  const pagina = await CompliancePage();
  const accion = buscar(pagina, FormaConAviso)[0].props.accion as AccionForma;

  dobles.requireSuperadmin.mockRejectedValueOnce(new Error('no autorizado'));
  await expect(accion(null, fd({ solicitudId: 's-1', resolucion: 'Se le envió su expediente completo.' })))
    .rejects.toThrow('no autorizado');
  expect(dobles.resolverSolicitudArco).not.toHaveBeenCalled();
});

it('resolver: una resolución de menos de 5 caracteres se rechaza SIN tocar la base', async () => {
  dobles.from.mockReturnValue(encadenar([SOLICITUD_PENDIENTE]));
  dobles.requireSuperadmin.mockResolvedValue(undefined);
  const pagina = await CompliancePage();
  const accion = buscar(pagina, FormaConAviso)[0].props.accion as AccionForma;
  const r = await accion(null, fd({ solicitudId: 's-1', resolucion: 'ok' }));
  expect(r).toEqual({ error: 'Escribe la resolución (a quién se respondió y qué).' });
  expect(dobles.resolverSolicitudArco).not.toHaveBeenCalled();
});

it('resolver: el tenant sale de la SOLICITUD (no del listado ni del form) — evita depender de su orden', async () => {
  dobles.from.mockReturnValue(encadenar([SOLICITUD_PENDIENTE]));
  dobles.requireSuperadmin.mockResolvedValue(undefined);
  dobles.resolverSolicitudArco.mockResolvedValue({ enviada: true });
  const pagina = await CompliancePage();
  const accion = buscar(pagina, FormaConAviso)[0].props.accion as AccionForma;
  // La action hace su PROPIA lectura .maybeSingle() (tenant_id de la
  // solicitud) — se encadena aparte de la del render, con forma singular.
  dobles.from.mockReturnValueOnce(encadenar({ tenant_id: 't-1' }));
  const r = await accion(null, fd({ solicitudId: 's-1', resolucion: 'Se le envió su expediente completo.', tenantId: 'OTRO-TENANT' }));
  expect(dobles.resolverSolicitudArco).toHaveBeenCalledWith('t-1', 's-1', 'Se le envió su expediente completo.');
  expect(r).toEqual(expect.objectContaining({ ok: expect.stringContaining('resuelta') }));
  expect(dobles.revalidatePath).toHaveBeenCalledWith('/admin/compliance');
});

it('resolver: ADM-10 — una base caída leyendo la solicitud da un mensaje DISTINTO de "no existe" (no se confunden)', async () => {
  dobles.from.mockReturnValue(encadenar([SOLICITUD_PENDIENTE]));
  dobles.requireSuperadmin.mockResolvedValue(undefined);
  const pagina = await CompliancePage();
  const accion = buscar(pagina, FormaConAviso)[0].props.accion as AccionForma;

  // Sondeo directo de la action (que hace su PROPIA lectura .maybeSingle()):
  // se fuerza el error en esa lectura puntual, no en la del render.
  dobles.from.mockReturnValueOnce(encadenar(null, { message: 'timeout' }));
  const r1 = await accion(null, fd({ solicitudId: 's-caida', resolucion: 'Se le respondió por WhatsApp.' }));
  expect((r1 as { error: string }).error).toContain('No se pudo leer la solicitud');
  expect((r1 as { error: string }).error).toContain('timeout');

  dobles.from.mockReturnValueOnce(encadenar(null, null));
  const r2 = await accion(null, fd({ solicitudId: 's-inexistente', resolucion: 'Se le respondió por WhatsApp.' }));
  expect(r2).toEqual({ error: 'La solicitud no existe.' });

  expect(dobles.resolverSolicitudArco).not.toHaveBeenCalled();
});

it('resolver: un DatoInvalido del motor llega verbatim, no genérico', async () => {
  dobles.from.mockReturnValue(encadenar([SOLICITUD_PENDIENTE]));
  dobles.requireSuperadmin.mockResolvedValue(undefined);
  dobles.resolverSolicitudArco.mockRejectedValueOnce(new DatoInvalido('El titular ya fue notificado hace menos de 24h.'));
  const pagina = await CompliancePage();
  const accion = buscar(pagina, FormaConAviso)[0].props.accion as AccionForma;
  dobles.from.mockReturnValueOnce(encadenar({ tenant_id: 't-1' }));
  const r = await accion(null, fd({ solicitudId: 's-1', resolucion: 'Se le respondió por WhatsApp.' }));
  expect((r as { error: string }).error).toContain('notificado hace menos de 24h');
});

it('una solicitud ya resuelta NO ofrece el formulario de responder — muestra su resolución', async () => {
  dobles.from.mockReturnValue(encadenar([{ ...SOLICITUD_PENDIENTE, estado: 'resuelta', resolucion: 'Se le envió su expediente el 2-ene.' }]));
  const pagina = await CompliancePage();
  const html = (await import('react-dom/server')).renderToStaticMarkup(pagina);
  expect(html).toContain('Se le envió su expediente el 2-ene.');
  expect(buscar(pagina, FormaConAviso)).toHaveLength(0);
});
