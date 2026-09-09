import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /dashboard/suscripcion — CERO cobertura de la PÁGINA (las funciones de
// negocio ya tienen 16 archivos de prueba en src/lib/saas/). Lo que falta es
// exactamente lo mismo que en llaves-api/sesiones-mcp/emergencias: que
// `puedeAdministrar` se comprueba DENTRO de cada server action (no solo en el
// render), que el tenant al que se factura/cobra es el de la SESIÓN (con el
// caso especial de superadmin "viendo como" otra flota vía `?tenant=`), y que
// los mensajes de éxito/error no prometen de más sobre dinero real.
// ═══════════════════════════════════════════════════════════════════════════

type Elemento = ReactElement<Record<string, unknown>>;

const dobles = vi.hoisted(() => ({
  getPlanes: vi.fn(),
  getSuscripcion: vi.fn(),
  getFacturasSaas: vi.fn(),
  getUso: vi.fn(),
  cambiarPlan: vi.fn(),
  crearPortal: vi.fn(),
  stripeConfigurado: vi.fn(),
  modoStripe: vi.fn(),
  datosBancarios: vi.fn(),
  getDatosFiscales: vi.fn(),
  guardarDatosFiscales: vi.fn(),
  estanCompletos: vi.fn(),
  resolverTenantPedido: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
}));

let sesion: { tenantId: string; rol: string; userId: string } = { tenantId: 't-1', rol: 'flota_admin', userId: 'u-1' };
let correoCuenta: { email: string | null } | null = { email: 'duena@flota.com' };

vi.mock('@/lib/auth/tenant-efectivo', () => ({ resolverTenantEfectivo: async () => sesion }));
vi.mock('@/lib/auth/guard', () => ({ requireSessionTenant: async () => sesion }));
vi.mock('@/lib/auth/tenant-api', () => ({ resolverTenantPedido: dobles.resolverTenantPedido }));
vi.mock('next/navigation', () => ({ redirect: dobles.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: dobles.revalidatePath }));
vi.mock('@/lib/env', () => ({ appUrl: () => 'https://app.likida.ai' }));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: correoCuenta, error: null }) }) }) }) }),
}));
vi.mock('@/lib/saas/suscripcion', async (importar) => ({
  ...(await importar<typeof import('@/lib/saas/suscripcion')>()),
  getPlanes: dobles.getPlanes,
  getSuscripcion: dobles.getSuscripcion,
  getFacturasSaas: dobles.getFacturasSaas,
  getUso: dobles.getUso,
  cambiarPlan: dobles.cambiarPlan,
}));
vi.mock('@/lib/saas/stripe', () => ({
  crearPortal: dobles.crearPortal, stripeConfigurado: dobles.stripeConfigurado, modoStripe: dobles.modoStripe,
}));
vi.mock('@/lib/saas/transferencia', () => ({ datosBancarios: dobles.datosBancarios }));
vi.mock('@/lib/saas/fiscal', async (importar) => ({
  ...(await importar<typeof import('@/lib/saas/fiscal')>()),
  getDatosFiscales: dobles.getDatosFiscales,
  guardarDatosFiscales: dobles.guardarDatosFiscales,
  estanCompletos: dobles.estanCompletos,
}));

import { FormaConAviso } from '../../admin/ui/forma';
import SuscripcionPage from './page';

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

const SP = Promise.resolve({});
const fd = (campos: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(campos)) f.set(k, v); return f; };
const PLAN = { clave: 'pro', nombre: 'Pro', precioMensual: 999, stripePriceId: 'price_pro' };
const FISCALES_OK = { rfc: 'TIN010101AB1', razonSocial: 'MI FLOTA SA DE CV', regimenFiscal: '601', codigoPostal: '97000', usoCfdi: 'G03', email: null, domicilioFiscal: null };

beforeEach(() => {
  vi.clearAllMocks();
  sesion = { tenantId: 't-1', rol: 'flota_admin', userId: 'u-1' };
  correoCuenta = { email: 'duena@flota.com' };
  dobles.getPlanes.mockResolvedValue([PLAN]);
  dobles.getSuscripcion.mockResolvedValue(null);
  dobles.getFacturasSaas.mockResolvedValue([]);
  dobles.getUso.mockResolvedValue(null);
  dobles.stripeConfigurado.mockReturnValue(true);
  dobles.modoStripe.mockReturnValue('live');
  dobles.datosBancarios.mockReturnValue(null);
  dobles.getDatosFiscales.mockResolvedValue(FISCALES_OK);
  dobles.estanCompletos.mockReturnValue(true);
  dobles.resolverTenantPedido.mockImplementation(async (_admin: unknown, tenantSesion: string) => tenantSesion);
});

it('la página renderiza para cualquier rol (la puerta real está en las server actions)', async () => {
  await expect(SuscripcionPage({ searchParams: SP })).resolves.toBeTruthy();
});

it('contratar: contador/encargado quedan rechazados por la server action, aunque el botón no se le ofrezca en su render', async () => {
  const pagina = await SuscripcionPage({ searchParams: SP }); // renderizado como flota_admin: sí ofrece el botón
  const accion = accionDelBoton(pagina, /Contratar por transferencia/);
  sesion = { tenantId: 't-1', rol: 'contador', userId: 'u-1' }; // pero la sesión, al momento de llamar, es de contador
  const r = await accion(null, fd({ plan: 'pro' }));
  expect(r).toEqual({ error: 'Solo el dueño de la flota puede contratar o cambiar de plan.' });
  expect(dobles.cambiarPlan).not.toHaveBeenCalled();
});

it('contratar: exige datos fiscales completos ANTES de tocar Stripe (defensa en la action, aunque el botón normalmente no se ofrece sin ellos)', async () => {
  // Con `puedeFacturar=false` el botón real ni se pinta (el JSX ofrece
  // "Captura primero tus datos fiscales" en su lugar) — se extrae la action
  // mientras SÍ estaban completos y se vuelve a comprobar en el momento de
  // la llamada, igual que la sesión: la segunda puerta es real.
  const pagina = await SuscripcionPage({ searchParams: SP });
  const accion = accionDelBoton(pagina, /Contratar por transferencia/);
  dobles.estanCompletos.mockReturnValue(false);
  const r = await accion(null, fd({ plan: 'pro' }));
  expect(r).toEqual(expect.objectContaining({ error: expect.stringContaining('datos fiscales') }));
  expect(dobles.cambiarPlan).not.toHaveBeenCalled();
});

it('contratar: un plan sin stripePriceId no se contrata y lo dice, no revienta contra Stripe', async () => {
  dobles.getPlanes.mockResolvedValue([{ ...PLAN, stripePriceId: null }]);
  const pagina = await SuscripcionPage({ searchParams: SP });
  const accion = accionDelBoton(pagina, /Contratar por transferencia/);
  const r = await accion(null, fd({ plan: 'pro' }));
  expect(r).toEqual(expect.objectContaining({ error: expect.stringContaining('no tiene precio configurado') }));
  expect(dobles.cambiarPlan).not.toHaveBeenCalled();
});

it('contratar: manda el tenant y el correo de la SESIÓN a cambiarPlan, ignora lo que venga del form', async () => {
  dobles.cambiarPlan.mockResolvedValue({ urlFactura: null, huboCambioDePrice: false });
  const pagina = await SuscripcionPage({ searchParams: SP });
  const accion = accionDelBoton(pagina, /Contratar por transferencia/);
  const r = await accion(null, fd({ plan: 'pro', tenantId: 'OTRO-TENANT' }));
  expect(dobles.cambiarPlan).toHaveBeenCalledWith(expect.objectContaining({
    priceId: 'price_pro', tenantId: 't-1',
    fiscales: expect.objectContaining({ rfc: FISCALES_OK.rfc, email: 'duena@flota.com' }),
  }));
  expect(r).toEqual({ ok: 'Suscripción creada. Stripe te va a mandar la factura con los datos para la transferencia por correo.' });
});

it('contratar: cambio de price en una suscripción existente NO redirige (no hay URL de pago nueva)', async () => {
  dobles.cambiarPlan.mockResolvedValue({ urlFactura: null, huboCambioDePrice: true });
  const pagina = await SuscripcionPage({ searchParams: SP });
  const accion = accionDelBoton(pagina, /Contratar por transferencia/);
  const r = await accion(null, fd({ plan: 'pro' }));
  expect(r).toEqual({ ok: 'Plan cambiado. El ajuste llega en tu próxima factura de Likida.' });
  expect(dobles.redirect).not.toHaveBeenCalled();
});

it('contratar: con URL de factura, redirige — el redirect NO se atrapa como error', async () => {
  dobles.cambiarPlan.mockResolvedValue({ urlFactura: 'https://stripe.com/factura/x', huboCambioDePrice: false });
  const pagina = await SuscripcionPage({ searchParams: SP });
  const accion = accionDelBoton(pagina, /Contratar por transferencia/);
  await expect(accion(null, fd({ plan: 'pro' }))).rejects.toThrow('REDIRECT:https://stripe.com/factura/x');
});

it('contratar: superadmin viendo-como otra flota (?tenant=) factura a ESA flota, no a la suya', async () => {
  sesion = { tenantId: 't-super', rol: 'superadmin', userId: 'u-1' };
  dobles.resolverTenantPedido.mockResolvedValue('t-vista-como');
  dobles.cambiarPlan.mockResolvedValue({ urlFactura: null, huboCambioDePrice: false });
  const pagina = await SuscripcionPage({ searchParams: Promise.resolve({ tenant: 't-vista-como' }) });
  const accion = accionDelBoton(pagina, /Contratar por transferencia/);
  await accion(null, fd({ plan: 'pro' }));
  expect(dobles.resolverTenantPedido).toHaveBeenCalledWith(expect.anything(), 't-super', 't-vista-como');
  expect(dobles.cambiarPlan).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-vista-como' }));
});

it('guardar datos fiscales: contador queda rechazado por la server action', async () => {
  const pagina = await SuscripcionPage({ searchParams: SP });
  const accion = accionDelBoton(pagina, /Guardar datos fiscales/);
  sesion = { tenantId: 't-1', rol: 'contador', userId: 'u-1' };
  const r = await accion(null, fd({ rfc: 'x', razonSocial: 'x', regimenFiscal: '601', codigoPostal: '97000' }));
  expect(r).toEqual({ error: 'Solo el dueño de la flota puede cambiar los datos fiscales.' });
  expect(dobles.guardarDatosFiscales).not.toHaveBeenCalled();
});

it('guardar datos fiscales: manda el domicilioFiscal (aviso de privacidad, auditoría 19) y el tenant de la SESIÓN', async () => {
  dobles.guardarDatosFiscales.mockResolvedValue(undefined);
  const pagina = await SuscripcionPage({ searchParams: SP });
  const accion = accionDelBoton(pagina, /Guardar datos fiscales/);
  const r = await accion(null, fd({
    rfc: 'TIN010101AB1', razonSocial: 'MI FLOTA SA DE CV', regimenFiscal: '601', codigoPostal: '97000',
    usoCfdi: 'G03', domicilioFiscal: 'Calle 60 #123, Mérida', tenantId: 'OTRO',
  }));
  expect(dobles.guardarDatosFiscales).toHaveBeenCalledWith('t-1', expect.objectContaining({ domicilioFiscal: 'Calle 60 #123, Mérida' }));
  expect(r).toEqual(expect.objectContaining({ ok: expect.stringContaining('CFDI') }));
});

it('portal de cobro: contador queda rechazado', async () => {
  dobles.getSuscripcion.mockResolvedValue({ stripeCustomerId: 'cus_1', estado: 'activa', planClave: 'pro', planNombre: 'Pro', inicio: '2026-01-01', periodoFin: null, vencida: false });
  const pagina = await SuscripcionPage({ searchParams: SP });
  const accion = accionDelBoton(pagina, /Administrar cobro y tarjeta/);
  sesion = { tenantId: 't-1', rol: 'contador', userId: 'u-1' };
  const r = await accion(null, new FormData());
  expect(r).toEqual({ error: 'Solo el dueño de la flota puede administrar el cobro.' });
  expect(dobles.crearPortal).not.toHaveBeenCalled();
});

it('portal de cobro: sin cliente de Stripe, error claro en vez de abrir un portal vacío', async () => {
  dobles.getSuscripcion.mockResolvedValue({ stripeCustomerId: null, estado: 'prueba', planClave: 'pro', planNombre: 'Pro', inicio: '2026-01-01', periodoFin: null, vencida: false });
  // Con stripeCustomerId null el botón no se ofrece en el render — se prueba
  // igual llamando la action que YA se extrajo antes de que faltara el
  // cliente (simula un POST directo con datos obsoletos).
  dobles.getSuscripcion.mockResolvedValueOnce({ stripeCustomerId: 'cus_1', estado: 'activa', planClave: 'pro', planNombre: 'Pro', inicio: '2026-01-01', periodoFin: null, vencida: false });
  const pagina = await SuscripcionPage({ searchParams: SP });
  const accion = accionDelBoton(pagina, /Administrar cobro y tarjeta/);
  const r = await accion(null, new FormData());
  expect(r).toEqual({ error: 'Esta flota todavía no tiene un cliente en Stripe: no hay nada que administrar.' });
});

it('portal de cobro: redirige al portal real de Stripe del tenant de la SESIÓN', async () => {
  dobles.getSuscripcion.mockResolvedValue({ stripeCustomerId: 'cus_1', estado: 'activa', planClave: 'pro', planNombre: 'Pro', inicio: '2026-01-01', periodoFin: null, vencida: false });
  dobles.crearPortal.mockResolvedValue('https://billing.stripe.com/session/x');
  const pagina = await SuscripcionPage({ searchParams: SP });
  const accion = accionDelBoton(pagina, /Administrar cobro y tarjeta/);
  await expect(accion(null, new FormData())).rejects.toThrow('REDIRECT:https://billing.stripe.com/session/x');
  expect(dobles.crearPortal).toHaveBeenCalledWith('cus_1', 'https://app.likida.ai/dashboard/suscripcion');
});
