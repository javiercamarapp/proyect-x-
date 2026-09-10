import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/flotas — CERO cobertura de la PÁGINA (crearFlota y
// actualizarFacilidad15 ya tienen prueba propia en varios archivos de
// src/lib/likida/). Dos server actions con escritura real: dar de alta una
// flota nueva y editar su declaración del 15% (RFA 2.9). Prioridad sobre las
// de lectura por instrucción explícita del lote.
// ═══════════════════════════════════════════════════════════════════════════

type Elemento = ReactElement<Record<string, unknown>>;

const dobles = vi.hoisted(() => ({
  requireSuperadmin: vi.fn(),
  getResumenNegocio: vi.fn(),
  getOnboardingFlotas: vi.fn(),
  telefonosJefe: vi.fn(),
  getSenalesPmfTodas: vi.fn(),
  crearFlota: vi.fn(),
  actualizarFacilidad15: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/auth/guard', () => ({ requireSuperadmin: dobles.requireSuperadmin }));
vi.mock('next/cache', () => ({ revalidatePath: dobles.revalidatePath }));
vi.mock('@/lib/admin/negocio', () => ({ getResumenNegocio: dobles.getResumenNegocio }));
vi.mock('@/lib/admin/onboarding', () => ({ getOnboardingFlotas: dobles.getOnboardingFlotas }));
vi.mock('@/lib/likida/contactos', () => ({ telefonosJefe: dobles.telefonosJefe }));
vi.mock('@/lib/likida/pmf', async (importar) => ({
  ...(await importar<typeof import('@/lib/likida/pmf')>()),
  getSenalesPmfTodas: dobles.getSenalesPmfTodas,
}));
vi.mock('@/lib/likida/administracion', async (importar) => ({
  ...(await importar<typeof import('@/lib/likida/administracion')>()),
  crearFlota: dobles.crearFlota,
}));
vi.mock('@/lib/likida/repo', async (importar) => ({
  ...(await importar<typeof import('@/lib/likida/repo')>()),
  actualizarFacilidad15: dobles.actualizarFacilidad15,
}));

import { FormaConAviso } from '../ui/forma';
import FlotasPage from './page';

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
const FLOTA = { id: 'tn-1', nombre: 'ACME', plan: 'pro', viajes: 5, costoIaUsd: 10, politicaPropia: false, facilidad15: null };

beforeEach(() => {
  vi.clearAllMocks();
  dobles.requireSuperadmin.mockResolvedValue({ userId: 'u-1', tenantId: null, rol: 'superadmin' });
  dobles.getResumenNegocio.mockResolvedValue({ flotas: [FLOTA], tenants: 1 });
  dobles.telefonosJefe.mockResolvedValue({});
  dobles.getOnboardingFlotas.mockResolvedValue(new Map());
  dobles.getSenalesPmfTodas.mockResolvedValue(new Map());
});

it('accionCrearFlota: no-superadmin — requireSuperadmin ya redirige (guard.test.ts la prueba); confirmamos que se invoca antes de crear', async () => {
  dobles.requireSuperadmin.mockRejectedValueOnce(new Error('REDIRECT:/dashboard'));
  const pagina = await FlotasPage();
  const accion = accionDelBoton(pagina, /Dar de alta/);
  await expect(accion(null, fd({ nombre: 'Nueva', emailAdmin: 'x@x.com', nombreAdmin: 'X' }))).rejects.toThrow('REDIRECT:/dashboard');
  expect(dobles.crearFlota).not.toHaveBeenCalled();
});

it('accionCrearFlota: manda el userId de la SESIÓN como creador', async () => {
  dobles.crearFlota.mockResolvedValue({ userId: 'nuevo-admin-id' });
  const pagina = await FlotasPage();
  const accion = accionDelBoton(pagina, /Dar de alta/);
  await accion(null, fd({ nombre: 'Nueva Flota', emailAdmin: 'x@x.com', nombreAdmin: 'Juan' }));
  expect(dobles.crearFlota).toHaveBeenCalledWith(expect.objectContaining({ nombre: 'Nueva Flota' }), { id: 'u-1' });
});

it('accionCrearFlota: con los 5 datos fiscales completos, NO avisa el hueco de facturación', async () => {
  dobles.crearFlota.mockResolvedValue({ userId: 'nuevo-admin-id' });
  const pagina = await FlotasPage();
  const accion = accionDelBoton(pagina, /Dar de alta/);
  const r = await accion(null, fd({
    nombre: 'Nueva Flota', emailAdmin: 'x@x.com', nombreAdmin: 'Juan',
    rfc: 'ACM010101AB1', razonSocial: 'ACME SA', regimenFiscal: '601', codigoPostalFiscal: '97000', usoCfdi: 'G03',
  }));
  expect(r.ok).not.toContain('no factura ni un ticket');
});

it('accionCrearFlota: SIN los 5 datos fiscales, avisa EXPLÍCITAMENTE que no puede facturar — un "listo" mudo sobre esto ya causó un hueco real semanas después', async () => {
  dobles.crearFlota.mockResolvedValue({ userId: 'nuevo-admin-id' });
  const pagina = await FlotasPage();
  const accion = accionDelBoton(pagina, /Dar de alta/);
  const r = await accion(null, fd({ nombre: 'Nueva Flota', emailAdmin: 'x@x.com', nombreAdmin: 'Juan' }));
  expect(r.ok).toContain('no factura ni un ticket');
});

it('accionCrearFlota: sin admin creado (userId null), dice que la flota nace sin quién entre', async () => {
  dobles.crearFlota.mockResolvedValue({ userId: null });
  const pagina = await FlotasPage();
  const accion = accionDelBoton(pagina, /Dar de alta/);
  const r = await accion(null, fd({ nombre: 'Nueva Flota', emailAdmin: '', nombreAdmin: '' }));
  expect(r.ok).toContain('Todavía no tiene a nadie que pueda entrar');
});

it('accionFacilidad: sin flotaId, error explícito y no llama actualizarFacilidad15', async () => {
  const pagina = await FlotasPage();
  const accion = accionDelBoton(pagina, /^Guardar$/);
  const r = await accion(null, fd({ flotaId: '' }));
  expect(r).toEqual({ error: 'Falta la flota.' });
  expect(dobles.actualizarFacilidad15).not.toHaveBeenCalled();
});

it('accionFacilidad: manda el userId de la SESIÓN, y traduce si/no/vacío a true/false/undefined', async () => {
  dobles.actualizarFacilidad15.mockResolvedValue(undefined);
  const pagina = await FlotasPage();
  const accion = accionDelBoton(pagina, /^Guardar$/);
  const r = await accion(null, fd({ flotaId: 'tn-1', ded: 'si', reg: 'no' }));
  expect(dobles.actualizarFacilidad15).toHaveBeenCalledWith('tn-1', true, false, 'u-1');
  expect(r).toEqual({ ok: 'Declaración del 15% actualizada.' });
});

it('accionFacilidad: sin declarar ninguno de los dos, BORRA la declaración (undefined) — no la deja a medias', async () => {
  dobles.actualizarFacilidad15.mockResolvedValue(undefined);
  const pagina = await FlotasPage();
  const accion = accionDelBoton(pagina, /^Guardar$/);
  const r = await accion(null, fd({ flotaId: 'tn-1', ded: '', reg: '' }));
  expect(dobles.actualizarFacilidad15).toHaveBeenCalledWith('tn-1', undefined, undefined, 'u-1');
  expect(r).toEqual({ ok: 'Declaración del 15% borrada (sin declarar).' });
});

it('onboarding: una lectura de teléfonos caída dice "no se pudo leer" (sin_medir) — NUNCA se confunde con "falta" (pendiente)', async () => {
  dobles.telefonosJefe.mockRejectedValueOnce(new Error('caída'));
  const html = (await import('react-dom/server')).renderToStaticMarkup(await FlotasPage());
  expect(html).toContain('no se pudo leer');
  expect(html).not.toContain('Sin teléfono de jefe ni de dueño');
});

it('onboarding: teléfono realmente ausente (lectura ok, sin dato) SÍ dice "pendiente", distinto de "no se pudo medir"', async () => {
  dobles.telefonosJefe.mockResolvedValue({});
  const html = (await import('react-dom/server')).renderToStaticMarkup(await FlotasPage());
  expect(html).toContain('Sin teléfono de jefe ni de dueño');
});
