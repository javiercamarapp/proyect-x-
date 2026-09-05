import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA 18, MEDIO (M22) + ALTO (A23): la bandeja durable insertaba N veces
// en serie, sin techo, ANTES de contestarle a Meta. 22 fotos = 22 viajes de
// red antes del 200; uno colgado se llevaba la invocación. Ahora es UN upsert
// del lote, con `ignoreDuplicates` (la reentrega de Meta no es pérdida) y bajo
// `acotada`.
// ═══════════════════════════════════════════════════════════════════════════

const upsert = vi.fn();
const rpc = vi.fn();
const from = vi.fn((_t: string) => ({ upsert: (...a: unknown[]) => upsert(...a) }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: (t: string) => from(t), rpc: (...a: unknown[]) => rpc(...a) }) }));
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger }));

const { guardarEventosPendientes, pendientesPorDrenar } = await import('./wa_pendientes');

const msgs = Array.from({ length: 22 }, (_, i) => ({ from: '521999', type: 'image' as const, mediaId: `m${i}`, waMessageId: `wamid.${i}` }));

beforeEach(() => { vi.clearAllMocks(); upsert.mockResolvedValue({ data: null, error: null }); rpc.mockResolvedValue({ data: [], error: null }); });

describe('guardarEventosPendientes', () => {
  it('22 mensajes = UN viaje de red, no 22', async () => {
    const r = await guardarEventosPendientes(msgs);
    expect(from).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    const [filas, opts] = upsert.mock.calls[0] as [Array<{ id: string }>, Record<string, unknown>];
    expect(filas).toHaveLength(22);
    expect(filas[5].id).toBe('wamid.5');
    // La reentrega de Meta choca con la PK y NO es error: DO NOTHING.
    expect(opts).toMatchObject({ onConflict: 'id', ignoreDuplicates: true });
    expect(r).toMatchObject({ guardados: 22, fallidos: 0 });
    expect(r.filas.every((f) => f.guardado)).toBe(true);
  });

  it('si el lote falla, TODOS cuentan como no guardados (el webhook contesta 503 y Meta reentrega)', async () => {
    upsert.mockResolvedValue({ data: null, error: { message: 'conexión rechazada' } });
    const r = await guardarEventosPendientes(msgs.slice(0, 3));
    expect(r).toMatchObject({ guardados: 0, fallidos: 3 });
    expect(r.filas.every((f) => !f.guardado)).toBe(true);
    expect(logger.error).toHaveBeenCalledWith('wa.pendiente_no_guardado', expect.objectContaining({ ids: ['wamid.0', 'wamid.1', 'wamid.2'] }));
  });

  it('una excepción tampoco lanza: se reporta como fallidos', async () => {
    upsert.mockRejectedValue(new Error('boom'));
    await expect(guardarEventosPendientes(msgs.slice(0, 1))).resolves.toMatchObject({ guardados: 0, fallidos: 1 });
  });

  it('con lote vacío no toca la base', async () => {
    await guardarEventosPendientes([]);
    expect(from).not.toHaveBeenCalled();
  });
});

describe('leases/fencing del inbox', () => {
  it('lista por RPC con reloj PostgreSQL y conserva remitente Y tipo para armar la cadena', async () => {
    // `tipo` (mig. 0194, AGEN-19C2-1 corregido): el drenado lo necesita para
    // saber cuáles mensajes de la cadena de un chofer son FOTOS.
    rpc.mockResolvedValue({ data: [{ id: 'wamid.1', intentos: 2, remitente: '521999', tipo: 'image' }], error: null });
    await expect(pendientesPorDrenar(999)).resolves.toEqual([
      { id: 'wamid.1', intentos: 2, remitente: '521999', tipo: 'image' },
    ]);
    expect(rpc).toHaveBeenCalledWith('listar_wa_pendientes', { p_limite: 200 });
  });

  it('sin `tipo` en la fila (RPC vieja o base de mock antigua), cae a "other" en vez de reventar', async () => {
    rpc.mockResolvedValue({ data: [{ id: 'wamid.2', intentos: 0, remitente: '521999' }], error: null });
    await expect(pendientesPorDrenar(999)).resolves.toEqual([
      { id: 'wamid.2', intentos: 0, remitente: '521999', tipo: 'other' },
    ]);
  });

  it('reclama mediante la RPC compatible de 0177 y devuelve token y owner', async () => {
    rpc.mockResolvedValue({ data: [{ id: 'wamid.1', evento: msgs[0], intentos: 1, claim_token: 'tok-1' }], error: null });
    const { reclamarPendiente } = await import('./wa_pendientes');
    await expect(reclamarPendiente('wamid.1', 0, 'worker-1')).resolves.toMatchObject({
      id: 'wamid.1', intentos: 1, leaseToken: 'tok-1', leaseOwner: 'worker-1',
    });
    expect(rpc).toHaveBeenCalledWith('reclamar_wa_pendiente', expect.objectContaining({
      p_id: 'wamid.1', p_intentos: 0, p_owner: 'worker-1',
    }));
  });

  it('complete, fail y renew siempre llevan el token', async () => {
    const { marcarPendienteProcesado, anotarFalloPendiente, renovarLeasePendiente } = await import('./wa_pendientes');
    rpc.mockResolvedValue({ data: true, error: null });
    await marcarPendienteProcesado('wamid.1', 'tok-1', 'worker-1');
    await anotarFalloPendiente('wamid.1', 'fallo', 'tok-1', 'worker-1');
    await expect(renovarLeasePendiente('wamid.1', 'tok-1', 'worker-1')).resolves.toBe(true);
    expect(rpc).toHaveBeenNthCalledWith(1, 'completar_wa_pendiente', expect.objectContaining({ p_claim_token: 'tok-1', p_owner: 'worker-1' }));
    expect(rpc).toHaveBeenNthCalledWith(2, 'fallar_wa_pendiente', expect.objectContaining({ p_claim_token: 'tok-1', p_owner: 'worker-1' }));
    expect(rpc).toHaveBeenNthCalledWith(3, 'renovar_wa_pendiente', expect.objectContaining({ p_claim_token: 'tok-1', p_owner: 'worker-1' }));
  });
});

describe('lease singleton de la cadena QStash', () => {
  it('abre una cadena con lease y conserva `null` cuando otra ya está activa', async () => {
    const { iniciarCadenaWa } = await import('./wa_pendientes');
    rpc
      .mockResolvedValueOnce({ data: '11111111-1111-4111-8111-111111111111', error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    await expect(iniciarCadenaWa()).resolves.toBe('11111111-1111-4111-8111-111111111111');
    await expect(iniciarCadenaWa()).resolves.toBeNull();
    expect(rpc).toHaveBeenNthCalledWith(1, 'iniciar_cadena_wa', { p_lease_seconds: 180 });
  });

  it('renueva y finaliza siempre cercado por el UUID vigente', async () => {
    const { renovarCadenaWa, finalizarCadenaWa } = await import('./wa_pendientes');
    rpc.mockResolvedValue({ data: true, error: null });
    await expect(renovarCadenaWa('11111111-1111-4111-8111-111111111111')).resolves.toBe(true);
    await expect(finalizarCadenaWa('11111111-1111-4111-8111-111111111111')).resolves.toBe(true);
    expect(rpc).toHaveBeenNthCalledWith(1, 'renovar_cadena_wa', expect.objectContaining({
      p_cadena_id: '11111111-1111-4111-8111-111111111111', p_lease_seconds: 180,
    }));
    expect(rpc).toHaveBeenNthCalledWith(2, 'finalizar_cadena_wa', {
      p_cadena_id: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('falla cerrado al no poder validar la renovación', async () => {
    const { renovarCadenaWa } = await import('./wa_pendientes');
    rpc.mockResolvedValue({ data: null, error: { message: 'base caída' } });
    await expect(renovarCadenaWa('11111111-1111-4111-8111-111111111111')).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith('wa.cadena_no_renovada', expect.anything());
  });
});
