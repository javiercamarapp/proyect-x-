// ═══════════════════════════════════════════════════════════════════════════
// LEDGER DE GASTO — el dinero del loop, contado en REAL, no en tabla.
//
// Cada llamada registra su costo REAL (costoReal del proveedor — descuentos,
// caché y todo) en docs/auditoria-N/ledger.json. Si una ronda pasa su tope,
// la ronda se ABORTA con un error que dice cuánto gastó y en qué.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirRonda, topeRonda } from './config.audit';

export interface LedgerRow {
  t: string;
  ronda: number;
  quien: string;
  modelo: string;
  tokIn: number;
  tokOut: number;
  cost: number;
}

export interface Ledger {
  ronda: number;
  tope: number;
  filas: LedgerRow[];
}

export function ledgerPath(n: number): string {
  return `${dirRonda(n)}/ledger.json`;
}

export function leerLedger(n: number): Ledger {
  const p = ledgerPath(n);
  if (!existsSync(p)) return { ronda: n, tope: topeRonda(n), filas: [] };
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Ledger;
  } catch {
    return { ronda: n, tope: topeRonda(n), filas: [] };
  }
}

export function totalLedger(l: Ledger): number {
  return l.filas.reduce((a, f) => a + f.cost, 0);
}

/** Registra una llamada y valida el tope de la ronda. Lanza si se rebasa. */
export function registrarUso(n: number, quien: string, modelo: string, tokIn: number, tokOut: number, cost: number): void {
  const l = leerLedger(n);
  l.filas.push({ t: new Date().toISOString(), ronda: n, quien, modelo, tokIn, tokOut, cost });
  writeFileSync(ledgerPath(n), JSON.stringify(l, null, 2));
  const total = totalLedger(l);
  if (total > l.tope) {
    throw new Error(
      `TOPE DE RONDA ${n} EXCEDIDO: $${total.toFixed(4)} > $${l.tope} (última: ${quien} @ ${modelo})`,
    );
  }
}

export function resumenLedger(n: number): string {
  const l = leerLedger(n);
  const por = new Map<string, number>();
  for (const f of l.filas) por.set(f.modelo, (por.get(f.modelo) ?? 0) + f.cost);
  const detalle = [...por.entries()]
    .map(([m, c]) => `    ${m.padEnd(40)} $${c.toFixed(4)}`)
    .join('\n');
  return `Ronda ${n}: $${totalLedger(l).toFixed(4)} de $${l.tope} tope\n${detalle}`;
}