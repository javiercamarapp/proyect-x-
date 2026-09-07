import { beforeEach, expect, it, vi } from 'vitest';
import type { RolAppUser } from '@/lib/auth/provisionar';
import type { PropsDetalle } from './detalle';

const mocks = vi.hoisted(() => ({ session: vi.fn(), retry: vi.fn(), revision: vi.fn(), pdf: null as string | null }));
vi.mock('@/lib/auth/guard', () => ({ requireSessionTenant: mocks.session }));
vi.mock('@/lib/likida/analytics', () => ({ getLiquidacionDetalle: async () => ({
  id: 'liq', folio: 'F-1', viajeId: 'viaje', pdfPath: mocks.pdf, estatus: 'cuadrada',
  viaje: { operadorTelefono: null }, gastos: [],
}) }));
vi.mock('@/lib/likida/repo', () => ({ contarCatalogo: async () => 0 }));
vi.mock('@/lib/likida/revision_recalculo', () => ({ reintentarPdfAjustado: mocks.retry }));
vi.mock('@/lib/likida/revision', async (original) => ({
  ...await original<typeof import('@/lib/likida/revision')>(), leerRevision: mocks.revision,
}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => { throw new Error('DB no esperada'); } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: () => { throw new Error('redirect'); }, notFound: () => { throw new Error('404'); } }));
vi.mock('./detalle', () => ({ DetalleLiquidacion: () => null }));
const { default: Page } = await import('./page');

function session(rol: RolAppUser = 'contador') {
  return { rol, tenantId: 'flota-viva', userId: 'usuario' };
}
async function props() {
  const element = await Page({ params: Promise.resolve({ id: 'liq' }), searchParams: Promise.resolve({}) });
  return element.props as PropsDetalle;
}
beforeEach(() => {
  mocks.session.mockReset().mockResolvedValue(session());
  mocks.retry.mockReset().mockResolvedValue({ regenerado: true });
  mocks.revision.mockReset().mockResolvedValue({ revision: 'ajustada' });
  mocks.pdf = null;
});

it('habilita reintento para ajuste pendiente y usa la sesión vigente', async () => {
  const p = await props();
  expect(p.pdfHref).toBeNull();
  expect(p.reintentarPdf).toBeTypeOf('function');
  const result = await p.reintentarPdf!(null, new FormData());
  expect(result).toEqual({ ok: 'Los dos PDF ya están disponibles. Tu firma y las cifras se conservaron.' });
  expect(mocks.retry).toHaveBeenCalledWith('flota-viva', 'liq');
  expect(mocks.session).toHaveBeenCalledTimes(2);
});
it('rechaza POST manual si cambió a encargado después de abrir la pantalla', async () => {
  const p = await props();
  mocks.session.mockResolvedValue(session('encargado'));
  expect(await p.reintentarPdf!(null, new FormData())).toEqual({ error: 'Tu rol no puede regenerar el PDF de una liquidación firmada.' });
  expect(mocks.retry).not.toHaveBeenCalled();
});
it('el fallo de publicación mantiene un mensaje de pendiente y no un éxito viejo', async () => {
  mocks.retry.mockResolvedValue({ regenerado: false });
  const p = await props();
  expect(await p.reintentarPdf!(null, new FormData())).toEqual({ error: 'El PDF sigue pendiente. Tu firma y las cifras se conservaron; vuelve a intentarlo o avisa a soporte.' });
});
it('no ofrece regenerar una pareja disponible ni una revisión sin ajuste', async () => {
  mocks.pdf = 'flota/viaje-version-uuid.pdf';
  expect((await props()).reintentarPdf).toBeNull();
  mocks.pdf = null;
  mocks.revision.mockResolvedValue({ revision: 'pendiente' });
  expect((await props()).reintentarPdf).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════
// L07 (BE-A1/BE-M1/FE-M2) — "La liquidación rechazada no se sirve como vigente".
//
// Antes `pdfHref` solo miraba `d.pdfPath`, nunca `revisionEstado`: una
// liquidación RECHAZADA con un `pdf_url` viejo (la 0346 no lo anula en ese
// caso) seguía ofreciendo el botón "Descargar PDF". Y `leerRevision().catch(()
// => null)` metía un error REAL de lectura en el mismo balde que "no hay
// revisión" — con eso una rechazada cuya revisión no se pudo confirmar se
// veía vigente en vez de mostrar un aviso.
// ═══════════════════════════════════════════════════════════════════════════
it('revisión RECHAZADA: sin botón de descarga aunque quede un pdf_url viejo (BE-A1)', async () => {
  mocks.pdf = 'flota/viaje.pdf';
  mocks.revision.mockResolvedValue({ revision: 'rechazada' });
  const p = await props();
  expect(p.pdfHref).toBeNull();
  expect(p.revisionIlegible).toBe(false);
});

it('revisión ILEGIBLE (leerRevision lanza, error real): sin botón de descarga + aviso, NO "vigente" (BE-M1/FE-M2)', async () => {
  mocks.pdf = 'flota/viaje.pdf';
  mocks.revision.mockRejectedValue(new Error('revision.leer: la base no contestó'));
  const p = await props();
  expect(p.pdfHref).toBeNull();
  expect(p.revisionIlegible).toBe(true);
});

it('revisión legible y NO rechazada (aprobada) con pdf_url: sí ofrece la descarga', async () => {
  mocks.pdf = 'flota/viaje.pdf';
  mocks.revision.mockResolvedValue({ revision: 'aprobada' });
  const p = await props();
  expect(p.pdfHref).toBe('/api/export/pdf/liq');
  expect(p.revisionIlegible).toBe(false);
});
