import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

const dobles = vi.hoisted(() => ({
  rpc: vi.fn(), enviar: vi.fn(),
  solicitud: { id: 's-1', tipo: 'cancelacion', estado: 'recibida', recibidaEn: '2026-08-01', venceEn: '2026-08-30', operadorNombre: 'Titular sintético', titularRef: '529999990111', resolucion: null },
}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => {
  const cadena = { select: () => cadena, eq: () => cadena, maybeSingle: async () => ({ data: { titular_ref: '529999990111', tipo: 'cancelacion' }, error: null }) };
  return { from: () => cadena, rpc: dobles.rpc };
} }));
vi.mock('@/lib/meta/client', async importar => ({ ...await importar<typeof import('@/lib/meta/client')>(), enviarRespuestaArco: dobles.enviar }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth/guard', () => ({ requireSessionTenant: async () => ({ userId: 'u-1', tenantId: 't-1', rol: 'flota_admin' }) }));
vi.mock('@/lib/auth/tenant-efectivo', () => ({ resolverTenantEfectivo: async () => ({ tenantId: 't-1', rol: 'flota_admin' }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/likida/repo', async importar => ({
  ...await importar<typeof import('@/lib/likida/repo')>(),
  listarSolicitudesArco: async () => [dobles.solicitud],
}));
import { ejecutarCancelacionArco } from '@/lib/likida/repo';
import ArcoPage from './page';

type Accion = (previo: null, fd: FormData) => Promise<{ ok?: string; error?: string }>;
function accionCancelacion(nodo: ReactNode): Accion | undefined {
  if (Array.isArray(nodo)) return nodo.map(accionCancelacion).find(Boolean);
  if (!isValidElement<{ boton?: string; accion?: Accion; children?: ReactNode }>(nodo)) return;
  if (nodo.props.boton === 'Ejecutar cancelación') return nodo.props.accion;
  return accionCancelacion(nodo.props.children);
}
function exigirAlcance(texto: string) {
  expect(texto).toMatch(/nombre.*teléfono/);
  expect(texto).toMatch(/conversaciones/);
  for (const dato of ['identificador', 'correo', 'referencia', 'documentación fiscal', 'privacidad']) expect(texto).toContain(dato);
  expect(texto).not.toMatch(/quedó anonimizado|desligad[ao]s?.*(?:persona|titular)|sin vincularse a tu persona|ya no están ligados/);
}
beforeEach(() => {
  vi.clearAllMocks();
  dobles.rpc.mockResolvedValue({ data: { ok: true, evidencia: { operador_anonimizado: 1, wa_conversacion: 1, evidencia_fiscal_retenida: true }, seudonimo: 'Operador ABC123' }, error: null });
  dobles.enviar.mockResolvedValue({ ok: true });
});
it('RPC sintética exitosa produce aviso al titular con alcance y datos conservados', async () => {
  expect(await ejecutarCancelacionArco('t-1', 's-1')).toEqual({ ok: true, avisada: true });
  expect(dobles.rpc).toHaveBeenCalledWith('ejecutar_arco_cancelacion', { p_tenant: 't-1', p_solicitud: 's-1' });
  expect(dobles.enviar).toHaveBeenCalledTimes(1);
  exigirAlcance(dobles.enviar.mock.calls[0][1]);
});
it.each([true, false])('acción real informa alcance conservado, WhatsApp enviado=%s', async enviado => {
  dobles.enviar.mockResolvedValue(enviado ? { ok: true } : { ok: false, error: 'fallo sintético' });
  const pagina = await ArcoPage({ searchParams: Promise.resolve({}) });
  const accion = accionCancelacion(pagina);
  expect(accion).toBeTypeOf('function');
  const fd = new FormData(); fd.set('solicitudId', 's-1');
  const r = await accion!(null, fd);
  exigirAlcance(r.ok!);
  expect(r.ok).toContain(enviado ? 'WhatsApp' : 'NO');
});
it('la advertencia previa al botón no promete desvinculación irreversible', async () => {
  const html = renderToStaticMarkup(await ArcoPage({ searchParams: Promise.resolve({}) }));
  exigirAlcance(html);
  expect(html).toContain('No se puede deshacer la eliminación de conversaciones.');
});
it('RPC rechazada no fabrica aviso ni éxito', async () => {
  dobles.rpc.mockResolvedValue({ data: { ok: false, motivo: 'ya estaba cerrada' }, error: null });
  expect(await ejecutarCancelacionArco('t-1', 's-1')).toEqual({ ok: false, motivo: 'ya estaba cerrada', avisada: false });
  expect(dobles.enviar).not.toHaveBeenCalled();
});
