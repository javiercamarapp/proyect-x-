import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { acotada } from '../presupuesto';

export type RecursoPoll = 'posiciones' | 'eventos';

export interface PollReclamado {
  tenantId: string;
  proveedor: string;
  valoresCifrados: string;
  claimToken: string | null;
  watermarkEn: string | null;
  /** Cursor independiente del carril reciente. Nunca espera al backfill. */
  tailWatermarkEn: string | null;
}

/**
 * Obtiene trabajo con fairness durable. El fallback existe únicamente para
 * los dobles antiguos de Vitest que todavía no modelan RPC; en producción la
 * ausencia de `.rpc` es un fallo, no una degradación silenciosa.
 */
export async function reclamarPolls(
  recurso: RecursoPoll,
  proveedores: string[],
  limite = 200,
  _opciones: { bootstrapDesde?: string } = {},
): Promise<PollReclamado[]> {
  const admin = supabaseAdmin();
  const etiqueta = recurso === 'posiciones' ? 'gps' : 'eventos';
  const rpc = (admin as unknown as { rpc?: (nombre: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> }).rpc;
  if (!rpc) {
    if (process.env.NODE_ENV !== 'test') throw new Error(`${recurso}.claims: el cliente Supabase no expone rpc`);
    const { data, error } = await acotada(
      admin.from('conector_credencial')
        .select('tenant_id, conector_id, valores_cifrados')
        .eq('activo', true)
        .in('conector_id', proveedores),
      `${etiqueta}.credenciales`,
    );
    if (error) throw new Error(`${etiqueta}.credenciales: ${error.message}`);
    return (data ?? []).map((c) => ({
      tenantId: String(c.tenant_id), proveedor: String(c.conector_id),
      valoresCifrados: String(c.valores_cifrados), claimToken: null,
      watermarkEn: null, tailWatermarkEn: null,
    }));
  }

  const worker = `${process.env.VERCEL_REGION ?? 'local'}:${process.pid}:${randomUUID()}`;
  const { data, error } = await acotada(rpc.call(admin, 'reclamar_polls_conector', {
    p_recurso: recurso,
    p_proveedores: proveedores,
    p_limite: limite,
    p_worker: worker,
    // La ruta tiene maxDuration=300 s. 360 s deja un minuto de margen para
    // finalizar y recupera un worker muerto antes de la siguiente decena de
    // minutos, sin permitir que B robe trabajo legalmente en vuelo.
    p_lease_segundos: 360,
  }), `${recurso}.claims`);
  if (error) throw new Error(`${recurso}.claims: ${error.message}`);
  if (!Array.isArray(data)) throw new Error(`${recurso}.claims: respuesta inválida`);
  return data.map((fila) => {
    const f = fila as Record<string, unknown>;
    if (!f.tenant_id || !f.proveedor || !f.valores_cifrados || !f.claim_token) {
      throw new Error(`${recurso}.claims: fila incompleta`);
    }
    return {
      tenantId: String(f.tenant_id), proveedor: String(f.proveedor),
      valoresCifrados: String(f.valores_cifrados), claimToken: String(f.claim_token),
      watermarkEn: typeof f.watermark_en === 'string' ? f.watermark_en : null,
      tailWatermarkEn: typeof f.tail_watermark_en === 'string' ? f.tail_watermark_en : null,
    };
  });
}

export async function finalizarPoll(
  recurso: RecursoPoll,
  claim: PollReclamado,
  resultado: {
    completo: boolean;
    watermarkEn?: string | null;
    tailCompleto?: boolean;
    tailWatermarkEn?: string | null;
    ultimaMedidaEn?: string | null;
    paginas?: number;
    elementos?: number;
    invalidos?: number;
    error?: string;
  },
): Promise<void> {
  // Los tests legacy que pasaron por el fallback no tienen un lease real.
  if (!claim.claimToken) return;
  const admin = supabaseAdmin();
  const { data, error } = await acotada(admin.rpc('finalizar_poll_conector', {
    p_tenant: claim.tenantId,
    p_proveedor: claim.proveedor,
    p_recurso: recurso,
    p_claim_token: claim.claimToken,
    p_completo: resultado.completo,
    p_watermark_en: resultado.watermarkEn ?? null,
    p_tail_completo: resultado.tailCompleto ?? false,
    p_tail_watermark_en: resultado.tailWatermarkEn ?? null,
    p_ultima_medida_en: resultado.ultimaMedidaEn ?? null,
    p_paginas: resultado.paginas ?? 0,
    p_elementos: resultado.elementos ?? 0,
    p_invalidos: resultado.invalidos ?? 0,
    p_error: resultado.error?.slice(0, 1000) ?? null,
  }), `${recurso}.finalizar`);
  if (error) throw new Error(`${recurso}.finalizar: ${error.message}`);
  if (data !== true) throw new Error(`${recurso}.finalizar: lease vencido o ajeno`);
}
