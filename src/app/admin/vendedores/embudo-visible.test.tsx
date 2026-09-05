import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const ESTADOS_PERSISTIDOS = [
  'nuevo', 'contactado', 'appointment', 'rescheduled', 'cancelled', 'no-show',
  'demo', 'proposal', 'pilot', 'won', 'lost',
  'negociacion', 'cerrado', 'perdido',
] as const;

const prospectos = ESTADOS_PERSISTIDOS.map((estado, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  empresa: `Empresa ${estado}`,
  contactoNombre: null,
  telefono: null,
  correo: null,
  ciudad: null,
  vacante: null,
  fuente: 'prueba',
  estado,
  vendedorId: 'v-1',
  tenantId: null,
  notas: null,
  cerradoEn: estado === 'won' || estado === 'cerrado' ? '2026-09-03T00:00:00.000Z' : null,
  createdAt: '2026-09-03T00:00:00.000Z',
}));

vi.mock('@/lib/likida/vendedores', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/likida/vendedores')>();
  return {
    ...real,
    listarProspectos: async () => prospectos,
    listarVendedores: async () => [],
  };
});
vi.mock('@/lib/likida/agentes/corridas', () => ({
  ultimasCorridasNegocio: async () => [],
  duracionLegible: () => '',
}));
vi.mock('./acciones', () => ({
  accionMover: async () => ({ ok: true }),
  accionAsignar: async () => ({ ok: true }),
  accionNota: async () => ({ ok: true }),
  accionRedactar: async () => ({ ok: true }),
  accionCrearProspecto: async () => ({ ok: true }),
  accionInvitar: async () => ({ ok: true }),
  accionRepartir: async () => ({ ok: true }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { ConsolaVendedores } = await import('./consola-vendedores');
const { PanelVendedor } = await import('../../vendedor/panel-vendedor');

describe('FUNC-P1-01: ningún estado válido desaparece del embudo', () => {
  it.each([
    ['administrador', async () => ConsolaVendedores({ nombre: 'Admin', sp: {} })],
    ['vendedor', async () => PanelVendedor({ userId: 'v-1', nombre: 'Vendedor', rol: 'vendedor' })],
  ] as const)('%s ve los 11 estados canónicos y las filas históricas', async (_vista, construir) => {
    const html = renderToStaticMarkup(await construir());

    for (const estado of ESTADOS_PERSISTIDOS) {
      expect(html, `${estado} debe conservar su tarjeta visible`).toContain(`Empresa ${estado}`);
    }
    for (const rotulo of [
      'Nuevo', 'Contactado', 'Cita agendada', 'Cita reprogramada',
      'Cita cancelada', 'No se presentó', 'Demo', 'Propuesta', 'Piloto',
      'Ganado', 'Perdido',
    ]) {
      expect(html, `debe existir la columna ${rotulo}`).toContain(rotulo);
    }
  });
});
