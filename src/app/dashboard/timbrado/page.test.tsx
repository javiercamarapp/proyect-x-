import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /dashboard/timbrado — CERO cobertura de la PÁGINA índice (el detalle
// [viajeId], que sí timbra, ya tiene prueba propia: timbrar_aud24.test.ts).
// Esta página no muta nada — es de sólo lectura — pero sus rótulos son
// exactamente el tipo de promesa que este repo vigila: "sandbox" vs
// "producción", "sin timbre" vs "a medio registrar" vs "timbrado", y el
// null-vs-vacío de una cola caída.
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({
  listarTimbrado: vi.fn(),
  estadoPac: vi.fn(),
}));

let sesion: { tenantId: string; rol: string; userId: string } = { tenantId: 't-1', rol: 'flota_admin', userId: 'u-1' };

vi.mock('@/lib/auth/tenant-efectivo', () => ({ resolverTenantEfectivo: async () => sesion }));
vi.mock('next/navigation', () => ({ redirect: (ruta: string) => { throw new Error(`REDIRECT:${ruta}`); } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/likida/pac', () => ({ estadoPac: dobles.estadoPac }));
vi.mock('@/lib/likida/carta_porte_timbre', async (importar) => ({
  ...(await importar<typeof import('@/lib/likida/carta_porte_timbre')>()),
  listarTimbrado: dobles.listarTimbrado,
}));

import PaginaTimbrado from './page';

const SP = Promise.resolve({});
async function renderizar() { return renderToStaticMarkup(await PaginaTimbrado({ searchParams: SP })); }

beforeEach(() => {
  vi.clearAllMocks();
  sesion = { tenantId: 't-1', rol: 'flota_admin', userId: 'u-1' };
  dobles.listarTimbrado.mockResolvedValue([]);
  dobles.estadoPac.mockReturnValue({ configurado: true, proveedor: 'sw', pareceSandbox: false });
});

it.each(['encargado', 'vendedor'])('%s no puede ver la página: redirect antes de tocar la base', async (rol) => {
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  await expect(PaginaTimbrado({ searchParams: SP })).rejects.toThrow('REDIRECT:/dashboard');
  expect(dobles.listarTimbrado).not.toHaveBeenCalled();
});

it('sin PAC configurado, dice EXACTAMENTE eso — nunca finge que sí timbra', async () => {
  dobles.estadoPac.mockReturnValue({ configurado: false, proveedor: null, pareceSandbox: null });
  const html = await renderizar();
  expect(html).toContain('Sin PAC configurado');
  expect(html).toContain('jamás simula un timbre');
});

it('con PAC de sandbox, avisa que los timbres NO amparan nada — no se confunde con producción', async () => {
  dobles.estadoPac.mockReturnValue({ configurado: true, proveedor: 'sw', pareceSandbox: true });
  const html = await renderizar();
  expect(html).toContain('PRUEBAS');
  expect(html).toContain('no amparan nada');
  expect(html).not.toContain('ambiente de PRODUCCIÓN');
});

it('con PAC de producción, lo dice sin la advertencia de sandbox', async () => {
  const html = await renderizar();
  expect(html).toContain('PRODUCCIÓN');
  expect(html).not.toMatch(/PRUEBAS|no amparan nada/);
});

// Hoy quien VE esta cola (área "dinero": superadmin/flota_admin/contador) es
// exactamente el mismo conjunto que SÍ puede timbrar (TIMBRA, permisos.ts) —
// el aviso "no puedes timbrar" está escrito para un rol futuro con más
// separación entre las dos áreas; con los roles de hoy nunca se dispara.
it.each(['superadmin', 'flota_admin', 'contador'])('%s puede ver Y timbrar: no ve el aviso de "no puedes"', async (rol) => {
  sesion = { tenantId: 't-1', rol, userId: 'u-1' };
  const html = await renderizar();
  expect(html).not.toContain('emitir el CFDI es del dueño');
});

it('una cola caída dice "no se pudo mirar" — nunca se confunde con "nada pendiente"', async () => {
  dobles.listarTimbrado.mockRejectedValueOnce(new Error('caída'));
  const html = await renderizar();
  expect(html).toContain('No se pudo leer la cola');
  expect(html).not.toContain('Nada en la cola todavía');
});

it('cola vacía DE VERDAD (lectura ok, cero filas) sí dice "nada todavía"', async () => {
  const html = await renderizar();
  expect(html).toContain('Nada en la cola todavía');
});

it('un timbre a medio registrar bloquea con su folio y manda a soporte, no invita a reintentar solo', async () => {
  dobles.listarTimbrado.mockResolvedValue([{
    viajeId: 'v-1', folio: 'V-100', origen: 'Mérida', destino: 'CDMX', xmlGeneradoEn: '2026-01-01T00:00:00Z',
    timbre: { estado: 'pendiente', uuidFiscal: 'uuid-parcial-123', modo: 'produccion', fechaTimbrado: null },
  }]);
  const html = await renderizar();
  expect(html).toContain('A MEDIO REGISTRAR');
  expect(html).toContain('uuid-parcial-123');
  expect(html).toContain('avisa a soporte');
});

it('un timbre completo de sandbox dice "DE PRUEBA (no ampara nada)" en el renglón, no sólo en el encabezado', async () => {
  dobles.listarTimbrado.mockResolvedValue([{
    viajeId: 'v-2', folio: 'V-200', origen: 'Mérida', destino: 'CDMX', xmlGeneradoEn: '2026-01-01T00:00:00Z',
    timbre: { estado: 'vigente', uuidFiscal: 'uuid-real-456', modo: 'sandbox', fechaTimbrado: '2026-01-01T00:00:00Z' },
  }]);
  const html = await renderizar();
  expect(html).toContain('DE PRUEBA (no ampara nada)');
  expect(html).toContain('uuid-real-456');
});
