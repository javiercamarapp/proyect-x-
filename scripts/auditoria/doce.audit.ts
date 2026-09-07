// ═══════════════════════════════════════════════════════════════════════════
// FASE 1 — LOS DOCE AUDITORES EN PARALELO.
//
// Un agente por rubro, cada uno con su modelo (modelos.audit.ts), corriendo
// con concurrencia acotada (AUDIT_CONCURRENCIA, default 3) para no tumbar
// la máquina ni morir de rate limit. Cada uno escribe UN archivo.
// ═══════════════════════════════════════════════════════════════════════════

import { RUBROS } from './config.audit';
import { correrUnAuditor } from './agente.audit';
import { leerLedger, totalLedger, resumenLedger } from './ledger.audit';
import type { ResultadoAuditor } from './agente.audit';

function piscina<T>(items: T[], con: number, fn: (item: T) => Promise<void>): Promise<void> {
  const cola = [...items];
  const manos = Math.max(1, Math.min(con, items.length));
  const trabajador = async (): Promise<void> => {
    for (;;) {
      const item = cola.shift();
      if (item === undefined) return;
      await fn(item);
    }
  };
  return Promise.all(Array.from({ length: manos }, trabajador)).then(() => undefined);
}

export async function correrDoceAuditores(n: number): Promise<ResultadoAuditor[]> {
  const con = Math.max(1, Math.min(Number(process.env.AUDIT_CONCURRENCIA ?? '3') || 3, 12));
  const soloRubros = (process.env.AUDIT_RUBROS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const lista = soloRubros.length ? [...RUBROS].filter((r) => soloRubros.includes(r)) : [...RUBROS];
  const resultados: ResultadoAuditor[] = [];
  await piscina(lista, con, async (r) => {
    process.stderr.write(`[audit] → auditor-${r} (ronda ${n})\n`);
    const res = await correrUnAuditor(n, r);
    resultados.push(res);
    process.stderr.write(
      `[audit] ✓ auditor-${r}: nota=${res.nota ?? '?'} · $${res.cost.toFixed(4)} · ${res.tokIn.toLocaleString()} in / ${res.tokOut.toLocaleString()} out\n`,
    );
  });
  return resultados;
}

export function resumenFase1(n: number): string {
  const l = leerLedger(n);
  const total = totalLedger(l);
  return `${resumenLedger(n)}\nRonda ${n}: $${total.toFixed(4)} de $${l.tope} tope`;
}