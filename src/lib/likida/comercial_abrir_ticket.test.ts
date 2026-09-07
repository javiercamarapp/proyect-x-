import { describe, it, expect, vi, beforeEach } from 'vitest';

// PRUEBAS (barrido MEDIO/BAJO): `abrirTicket` no tenía ni una prueba. Es la
// PUERTA de la señal de PMF #3 (auditoría externa 16-ago-2026, P2):
// `ticket_soporte.abierto_por` distingue "el cliente se quejó por su cuenta"
// (un id real) de "Likida lo abrió a nombre de la flota" (NULL, convención de
// la 0051) — un superadmin en un demo con `?tenant=` que colara su propio id
// ahí contaminaría para siempre la métrica que ese ticket alimenta.

const insertado = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      insert: (fila: Record<string, unknown>) => {
        insertado(fila);
        return { select: () => ({ single: () => Promise.resolve({ data: { id: 'ticket-1' }, error: null }) }) };
      },
    }),
  }),
}));
// `importOriginal` en vez de un mock cerrado: `agentes/exito.ts` (importado
// más abajo solo para reusar `semaforoTicket`, la prueba de verdad de AG-M1)
// arrastra `contactos.ts` → `conv.ts`, que lee OTRAS constantes de este mismo
// módulo (`PRESUPUESTO_WEBHOOK_MS`). Un mock cerrado a `{ acotada }` las deja
// undefined y tira el import entero.
vi.mock('@/lib/likida/presupuesto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/likida/presupuesto')>();
  return { ...actual, acotada: (q: unknown) => q };
});

const { abrirTicket, SLA_HORAS_POR_PRIORIDAD, PRIORIDADES_TICKET } = await import('./comercial');
// AG-M1: `semaforoTicket` es la prueba de verdad de que `vence_en` quedó
// escrito de forma que el reloj de SLA funciona — no solo que la columna
// tenga un valor, sino que ESE valor deja de leerse como SIN_SLA.
const { semaforoTicket } = await import('./agentes/exito');

describe('abrirTicket: la puerta de abierto_por (señal de PMF #3)', () => {
  beforeEach(() => insertado.mockReset());

  it('un usuario real de la flota deja su id en abierto_por', async () => {
    await abrirTicket('t-1', 'usuario-real', { asunto: 'a', descripcion: 'd', categoria: 'tecnico', prioridad: 'baja' });
    expect(insertado).toHaveBeenCalledWith(expect.objectContaining({ abierto_por: 'usuario-real' }));
  });

  it('un superadmin (demo con ?tenant=) pasa null — NO contamina la señal', async () => {
    await abrirTicket('t-1', null, { asunto: 'a', descripcion: 'd', categoria: 'tecnico', prioridad: 'baja' });
    expect(insertado).toHaveBeenCalledWith(expect.objectContaining({ abierto_por: null }));
  });

  it('rechaza asunto vacío o mayor a 200 caracteres, sin llegar a insertar', async () => {
    await expect(abrirTicket('t-1', null, { asunto: '  ', descripcion: '', categoria: 'tecnico', prioridad: 'baja' }))
      .rejects.toThrow(/asunto es obligatorio/);
    await expect(abrirTicket('t-1', null, { asunto: 'x'.repeat(201), descripcion: '', categoria: 'tecnico', prioridad: 'baja' }))
      .rejects.toThrow(/asunto es obligatorio/);
    expect(insertado).not.toHaveBeenCalled();
  });

  it('rechaza categoría o prioridad fuera del catálogo', async () => {
    await expect(abrirTicket('t-1', null, { asunto: 'a', descripcion: '', categoria: 'inventada', prioridad: 'baja' }))
      .rejects.toThrow(/categoría no existe/);
    await expect(abrirTicket('t-1', null, { asunto: 'a', descripcion: '', categoria: 'tecnico', prioridad: 'inventada' }))
      .rejects.toThrow(/prioridad no existe/);
  });

  it('descripción vacía se guarda como null, no como cadena vacía', async () => {
    await abrirTicket('t-1', 'u1', { asunto: 'a', descripcion: '   ', categoria: 'otro', prioridad: 'media' });
    expect(insertado).toHaveBeenCalledWith(expect.objectContaining({ descripcion: null }));
  });

  it('descripción se recorta a 4000 caracteres', async () => {
    await abrirTicket('t-1', 'u1', { asunto: 'a', descripcion: 'x'.repeat(4200), categoria: 'otro', prioridad: 'media' });
    expect(insertado).toHaveBeenCalledWith(expect.objectContaining({ descripcion: 'x'.repeat(4000) }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AG-M1 (auditoría 28) — `ticket_soporte.vence_en` sin escritor: `abrirTicket`
// insertaba seis columnas y ni `sla_horas` ni `vence_en`. Consecuencia real:
// `semaforoTicket` (agentes/exito.ts) devolvía SIN_SLA para el 100% de los
// tickets y la alarma de SLA vencido era insatisfacible por construcción.
// ═══════════════════════════════════════════════════════════════════════════
describe('abrirTicket: el SLA se escribe al abrir (AG-M1)', () => {
  beforeEach(() => insertado.mockReset());

  for (const prioridad of PRIORIDADES_TICKET) {
    it(`prioridad «${prioridad}» inserta sla_horas=${SLA_HORAS_POR_PRIORIDAD[prioridad]} y vence_en = abierto_en + esas horas`, async () => {
      await abrirTicket('t-1', 'u1', { asunto: 'a', descripcion: 'd', categoria: 'tecnico', prioridad });
      const fila = insertado.mock.calls[0][0] as Record<string, unknown>;
      const slaHoras = SLA_HORAS_POR_PRIORIDAD[prioridad];
      expect(fila.sla_horas).toBe(slaHoras);
      expect(typeof fila.abierto_en).toBe('string');
      expect(typeof fila.vence_en).toBe('string');
      const horas = (Date.parse(fila.vence_en as string) - Date.parse(fila.abierto_en as string)) / 3_600_000;
      expect(horas).toBeCloseTo(slaHoras, 6);
      // El CHECK `ticket_sla_sano` de la 0051 exige 1..720 horas.
      expect(slaHoras).toBeGreaterThan(0);
      expect(slaHoras).toBeLessThanOrEqual(720);
    });
  }

  it('el ticket recién abierto YA NO es SIN_SLA para el semáforo del agente de Éxito', async () => {
    // «baja» (168 h) para que el instante de abrirlo quede lejos del umbral
    // POR_VENCER (≤4 h) de `semaforoTicket` — lo que esta prueba verifica es
    // que el reloj EXISTE, no el valor exacto del semáforo en el borde.
    await abrirTicket('t-1', 'u1', { asunto: 'a', descripcion: 'd', categoria: 'tecnico', prioridad: 'baja' });
    const fila = insertado.mock.calls[0][0] as Record<string, unknown>;
    const semaforo = semaforoTicket(
      { id: 't', tenantId: 't-1', asunto: 'a', categoria: 'tecnico', prioridad: 'baja', estado: 'abierto', abiertoEn: fila.abierto_en as string, venceEn: fila.vence_en as string, respuestas: 0 },
      fila.abierto_en as string,
    );
    expect(semaforo).not.toBe('SIN_SLA');
    expect(semaforo).toBe('EN_TIEMPO');
  });
});
