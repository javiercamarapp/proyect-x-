import { beforeEach, expect, it, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// /admin/notificaciones — CERO cobertura de la página. calcularAlertas y las
// fuentes (negocio.ts, escalaciones.ts) ya tienen prueba propia. La puerta
// (requireSuperadmin) vive en admin/layout.tsx, no aquí — esta página no
// tiene server actions ni chequeo propio. Lo que sí es suyo: que las CUATRO
// fuentes se lean y se pasen a calcularAlertas con la forma correcta, y que
// use el TOTAL real de conversaciones (FE-9), no el tamaño de una página de 20.
// ═══════════════════════════════════════════════════════════════════════════

const dobles = vi.hoisted(() => ({
  getResumenNegocio: vi.fn(),
  getConversacionesActivas: vi.fn(),
  contarConversacionesActivas: vi.fn(),
  getBandejaEscalaciones: vi.fn(),
  calcularAlertas: vi.fn(),
}));

vi.mock('@/lib/admin/negocio', () => ({
  getResumenNegocio: dobles.getResumenNegocio,
  getConversacionesActivas: dobles.getConversacionesActivas,
  contarConversacionesActivas: dobles.contarConversacionesActivas,
}));
vi.mock('@/lib/admin/escalaciones', () => ({ getBandejaEscalaciones: dobles.getBandejaEscalaciones }));
vi.mock('../calcular-alertas', () => ({ calcularAlertas: dobles.calcularAlertas }));
vi.mock('./lista', () => ({ default: (props: { alertas: unknown }) => props }));

import NotificacionesPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  dobles.getResumenNegocio.mockResolvedValue({ costoHoyUsd: 1 });
  dobles.getConversacionesActivas.mockResolvedValue([{ id: 'c-1' }]);
  dobles.contarConversacionesActivas.mockResolvedValue(37);
  dobles.getBandejaEscalaciones.mockResolvedValue({ conteos: { alto: 2 } });
  dobles.calcularAlertas.mockReturnValue([]);
});

it('lee las cuatro fuentes y las pasa a calcularAlertas con la forma correcta', async () => {
  await NotificacionesPage();
  expect(dobles.getResumenNegocio).toHaveBeenCalled();
  expect(dobles.getConversacionesActivas).toHaveBeenCalled();
  expect(dobles.getBandejaEscalaciones).toHaveBeenCalledWith(expect.any(Number));
  expect(dobles.contarConversacionesActivas).toHaveBeenCalled();
  expect(dobles.calcularAlertas).toHaveBeenCalledWith(
    { costoHoyUsd: 1 }, [{ id: 'c-1' }], { alto: 2 }, 37,
  );
});

it('usa el TOTAL real de conversaciones (FE-9), no la longitud de la página de 20', async () => {
  dobles.getConversacionesActivas.mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({ id: `c-${i}` })));
  dobles.contarConversacionesActivas.mockResolvedValue(153);
  await NotificacionesPage();
  expect(dobles.calcularAlertas).toHaveBeenCalledWith(expect.anything(), expect.any(Array), expect.anything(), 153);
});
