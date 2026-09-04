import { randomUUID } from 'node:crypto';
import { reclamarPollsConector, finalizarPollConector } from '../repo';
import type { PollReclamado, RecursoPoll } from '../repo';

export type { PollReclamado, RecursoPoll } from '../repo';

/** Política del worker; la frontera de datos reclama y valida los leases. */
export async function reclamarPolls(
  recurso: RecursoPoll,
  proveedores: string[],
  limite = 200,
  _opciones: { bootstrapDesde?: string } = {},
): Promise<PollReclamado[]> {
  const worker = `${process.env.VERCEL_REGION ?? 'local'}:${process.pid}:${randomUUID()}`;
  return reclamarPollsConector(recurso, proveedores, limite, worker);
}

export async function finalizarPoll(
  recurso: RecursoPoll,
  claim: PollReclamado,
  resultado: Parameters<typeof finalizarPollConector>[2],
): Promise<void> {
  return finalizarPollConector(recurso, claim, resultado);
}
