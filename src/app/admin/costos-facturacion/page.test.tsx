import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/costos-facturacion — CERO cobertura de la PÁGINA (getResumenNegocio,
// transferencia.ts y suscripcion.ts ya tienen prueba propia). Tres server
// actions con dinero real: fijar el price de un plan, emitir una mensualidad
// y conciliar/timbrar un pago. La única lógica que vive AQUÍ (no en una lib)
// es el cálculo del periodo del mes en curso — el bug DAT-23 real (usaba
// getUTCMonth() y el 31-dic 18:01 hora MX ya era 1-ene en UTC).
// ═══════════════════════════════════════════════════════════════════════════

type Elemento = ReactElement<Record<string, unknown>>;

const dobles = vi.hoisted(() => ({
  requireSuperadmin: vi.fn(),
  getResumenNegocio: vi.fn(),
  getPlanes: vi.fn(),
  guardarPriceDePlan: vi.fn(),
  stripeConfigurado: vi.fn(),
  modoStripe: vi.fn(),
  webhookConfigurado: vi.fn(),
  datosBancarios: vi.fn(),
  emitirMensualidad: vi.fn(),
  conciliar: vi.fn(),
  timbrarFactura: vi.fn(),
  getPorCobrar: vi.fn(),
  facturapiConfigurado: vi.fn(),
  modoFacturapi: vi.fn(),
  revalidatePath: vi.fn(),
  hoyMx: vi.fn(),
}));

vi.mock('@/lib/auth/guard', () => ({ requireSuperadmin: dobles.requireSuperadmin }));
vi.mock('next/cache', () => ({ revalidatePath: dobles.revalidatePath }));
vi.mock('@/lib/admin/negocio', () => ({ getResumenNegocio: dobles.getResumenNegocio }));
vi.mock('@/lib/saas/suscripcion', async (importar) => ({
  ...(await importar<typeof import('@/lib/saas/suscripcion')>()),
  getPlanes: dobles.getPlanes,
  guardarPriceDePlan: dobles.guardarPriceDePlan,
}));
vi.mock('@/lib/saas/stripe', () => ({
  stripeConfigurado: dobles.stripeConfigurado, modoStripe: dobles.modoStripe, webhookConfigurado: dobles.webhookConfigurado,
}));
vi.mock('@/lib/saas/transferencia', async (importar) => ({
  ...(await importar<typeof import('@/lib/saas/transferencia')>()),
  datosBancarios: dobles.datosBancarios,
  emitirMensualidad: dobles.emitirMensualidad,
  conciliar: dobles.conciliar,
  timbrarFactura: dobles.timbrarFactura,
  getPorCobrar: dobles.getPorCobrar,
}));
vi.mock('@/lib/saas/facturapi', () => ({ facturapiConfigurado: dobles.facturapiConfigurado, modoFacturapi: dobles.modoFacturapi }));
vi.mock('@/lib/formato', async (importar) => ({
  ...(await importar<typeof import('@/lib/formato')>()),
  hoyMx: dobles.hoyMx,
}));

import { FormaConAviso } from '../ui/forma';
import CostosFacturacionPage from './page';

function formasConAviso(nodo: ReactNode, salida: Elemento[] = []): Elemento[] {
  if (Array.isArray(nodo)) { for (const hijo of nodo) formasConAviso(hijo, salida); return salida; }
  if (!isValidElement<Record<string, unknown>>(nodo)) return salida;
  if (nodo.type === FormaConAviso) salida.push(nodo);
  formasConAviso(nodo.props.children as ReactNode, salida);
  return salida;
}
function accionDelBoton(pagina: ReactNode, patron: RegExp) {
  const forma = formasConAviso(pagina).find((f) => patron.test(String(f.props.boton)));
  if (!forma) throw new Error(`No se encontró un FormaConAviso con botón que matchee ${patron}`);
  return forma.props.accion as (previo: unknown, fd: FormData) => Promise<{ ok?: string; error?: string }>;
}

const fd = (campos: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(campos)) f.set(k, v); return f; };
const RESUMEN = { costoIaUsd: 100, viajesProcesados: 10, porDia: [], porFase: [], porModelo: [], flotas: [{ id: 'tn-1', nombre: 'ACME' }] };

beforeEach(() => {
  vi.clearAllMocks();
  dobles.requireSuperadmin.mockResolvedValue({ userId: 'u-1', tenantId: null, rol: 'superadmin' });
  dobles.getResumenNegocio.mockResolvedValue(RESUMEN);
  dobles.stripeConfigurado.mockReturnValue(true);
  dobles.modoStripe.mockReturnValue('produccion');
  dobles.webhookConfigurado.mockReturnValue(true);
  dobles.facturapiConfigurado.mockReturnValue(true);
  dobles.modoFacturapi.mockReturnValue('produccion');
  dobles.getPlanes.mockResolvedValue([]);
  dobles.datosBancarios.mockReturnValue(null);
  dobles.getPorCobrar.mockResolvedValue([]);
  dobles.hoyMx.mockReturnValue('2026-03-15');
});

it('accionPrecio: no-superadmin — requireSuperadmin ya redirige (guard.test.ts la prueba); confirmamos que se invoca antes de tocar Stripe', async () => {
  dobles.getPlanes.mockResolvedValue([{ clave: 'pro', nombre: 'Pro', precioMensual: null, precioIvaIncluido: null, stripePriceId: null }]);
  dobles.requireSuperadmin.mockRejectedValueOnce(new Error('REDIRECT:/dashboard'));
  const pagina = await CostosFacturacionPage();
  const accion = accionDelBoton(pagina, /Guardar price/);
  await expect(accion(null, fd({ plan: 'pro', price: 'price_1' }))).rejects.toThrow('REDIRECT:/dashboard');
  expect(dobles.guardarPriceDePlan).not.toHaveBeenCalled();
});

it('accionPrecio: lee el monto/IVA de Stripe (no se teclea) y avisa si tax_behavior es unspecified', async () => {
  dobles.getPlanes.mockResolvedValue([{ clave: 'pro', nombre: 'Pro', precioMensual: null, precioIvaIncluido: null, stripePriceId: null }]);
  dobles.guardarPriceDePlan.mockResolvedValue({ montoMensual: 2400, moneda: 'MXN', ivaIncluido: null });
  const pagina = await CostosFacturacionPage();
  const accion = accionDelBoton(pagina, /Guardar price/);
  const r = await accion(null, fd({ plan: 'pro', price: 'price_1abc' }));
  expect(dobles.guardarPriceDePlan).toHaveBeenCalledWith('pro', 'price_1abc');
  expect(r).toEqual(expect.objectContaining({ ok: expect.stringContaining('TODAVÍA NO SE PUEDE EMITIR') }));
});

it('accionPrecio: con IVA declarado, dice que ya se puede contratar', async () => {
  dobles.getPlanes.mockResolvedValue([{ clave: 'pro', nombre: 'Pro', precioMensual: null, precioIvaIncluido: null, stripePriceId: null }]);
  dobles.guardarPriceDePlan.mockResolvedValue({ montoMensual: 2400, moneda: 'MXN', ivaIncluido: true });
  const pagina = await CostosFacturacionPage();
  const accion = accionDelBoton(pagina, /Guardar price/);
  const r = await accion(null, fd({ plan: 'pro', price: 'price_1abc' }));
  expect(r).toEqual(expect.objectContaining({ ok: expect.stringContaining('Ya se puede contratar') }));
});

it('accionEmitir: sin flota elegida, error explícito y NO llama emitirMensualidad', async () => {
  const pagina = await CostosFacturacionPage();
  const accion = accionDelBoton(pagina, /^Emitir$/);
  const r = await accion(null, fd({ tenantId: '' }));
  expect(r).toEqual({ error: 'Elige una flota.' });
  expect(dobles.emitirMensualidad).not.toHaveBeenCalled();
});

it('accionEmitir: el periodo es el MES EN CURSO en hora de México, no UTC (regresión DAT-23: 31-dic 18:01 MX ya era 1-ene en UTC)', async () => {
  dobles.hoyMx.mockReturnValue('2026-12-31'); // 31 de diciembre en México
  dobles.emitirMensualidad.mockResolvedValue({ monto: 2784, subtotal: 2400, iva: 384, referencia: 'REF-1' });
  const pagina = await CostosFacturacionPage();
  const accion = accionDelBoton(pagina, /^Emitir$/);
  await accion(null, fd({ tenantId: 'tn-1' }));
  // Debe emitir DICIEMBRE (2026-12-01 al 2026-12-31), nunca enero.
  expect(dobles.emitirMensualidad).toHaveBeenCalledWith('tn-1', '2026-12-01', '2026-12-31');
});

it('accionEmitir: dice las TRES cifras (total, base, IVA) y la referencia — verlas juntas es lo que deja cachar un IVA mal puesto', async () => {
  dobles.emitirMensualidad.mockResolvedValue({ monto: 2784, subtotal: 2400, iva: 384, referencia: 'REF-1' });
  const pagina = await CostosFacturacionPage();
  const accion = accionDelBoton(pagina, /^Emitir$/);
  const r = await accion(null, fd({ tenantId: 'tn-1' }));
  expect(r.ok).toContain('REF-1');
  expect(dobles.revalidatePath).toHaveBeenCalledWith('/admin/costos-facturacion');
  expect(dobles.revalidatePath).toHaveBeenCalledWith('/dashboard/suscripcion');
});

it('accionConciliar: manda el userId de la SESIÓN al conciliar, y timbra DESPUÉS con su propio try', async () => {
  dobles.getPorCobrar.mockResolvedValue([{ id: 'f-1', tenantNombre: 'ACME', periodoInicio: '2026-01-01', periodoFin: '2026-01-31', referencia: 'R', monto: 2784, subtotal: 2400, iva: 384 }]);
  dobles.conciliar.mockResolvedValue(undefined);
  dobles.timbrarFactura.mockResolvedValue({ uuid: 'uuid-real-12345678' });
  const pagina = await CostosFacturacionPage();
  const accion = accionDelBoton(pagina, /Marcar pagada/);
  const r = await accion(null, fd({ facturaId: 'f-1', referenciaBanco: 'MOV-999' }));
  expect(dobles.conciliar).toHaveBeenCalledWith('f-1', 'MOV-999', 'u-1');
  expect(r.ok).toContain('CFDI timbrado: uuid-rea…');
});

it('accionConciliar: un PAC caído NO deshace el pago ya registrado — se dice por separado', async () => {
  dobles.getPorCobrar.mockResolvedValue([{ id: 'f-1', tenantNombre: 'ACME', periodoInicio: '2026-01-01', periodoFin: '2026-01-31', referencia: 'R', monto: 2784, subtotal: 2400, iva: 384 }]);
  dobles.conciliar.mockResolvedValue(undefined);
  dobles.timbrarFactura.mockRejectedValue(new Error('PAC caído'));
  const pagina = await CostosFacturacionPage();
  const accion = accionDelBoton(pagina, /Marcar pagada/);
  const r = await accion(null, fd({ facturaId: 'f-1', referenciaBanco: 'MOV-999' }));
  expect(r.ok).toContain('Factura marcada como pagada');
  expect(r.ok).toContain('NO se timbró');
});

it('un "por cobrar" caído se DICE — nunca se confunde con "nada pendiente"', async () => {
  dobles.getPorCobrar.mockRejectedValueOnce(new Error('caída'));
  const html = (await import('react-dom/server')).renderToStaticMarkup(await CostosFacturacionPage());
  expect(html).toContain('No se pudo leer lo que está por cobrarse');
  expect(html).not.toContain('Nada pendiente de cobro');
});
