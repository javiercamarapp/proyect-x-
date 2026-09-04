#!/usr/bin/env node
/**
 * Clasifica el JSON de `npm audit --omit=dev` sin confundir una vulnerabilidad
 * real con una caída del registry. Exit 0 = runtime limpio, 1 = high/critical,
 * 2 = reporte no concluyente (red, timeout o JSON inválido; el workflow reintenta).
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function clasificarAuditoriaRuntime(reporte) {
  const conteos = reporte?.metadata?.vulnerabilities;
  if (!conteos || typeof conteos !== 'object') {
    const codigo = reporte?.error?.code ?? reporte?.code ?? 'sin-codigo';
    const resumen = reporte?.error?.summary ?? reporte?.error?.detail ?? reporte?.message ?? 'reporte sin metadata.vulnerabilities';
    return { tipo: 'inconclusa', codigo: String(codigo), resumen: String(resumen) };
  }

  const high = Number(conteos.high) || 0;
  const critical = Number(conteos.critical) || 0;
  if (high + critical > 0) return { tipo: 'vulnerable', high, critical };
  return { tipo: 'limpia', high: 0, critical: 0 };
}

function main() {
  const archivo = process.argv[2];
  if (!archivo) {
    console.error('Uso: node scripts/ci/audit-runtime.mjs <npm-audit.json>');
    process.exit(2);
  }

  let reporte;
  try {
    reporte = JSON.parse(readFileSync(archivo, 'utf8'));
  } catch (error) {
    console.error(`Auditoría runtime inconclusa: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  const resultado = clasificarAuditoriaRuntime(reporte);
  if (resultado.tipo === 'limpia') {
    console.log('Auditoría runtime: 0 vulnerabilidades high/critical.');
    process.exit(0);
  }
  if (resultado.tipo === 'vulnerable') {
    console.error(`Auditoría runtime: ${resultado.high} high, ${resultado.critical} critical.`);
    process.exit(1);
  }
  console.error(`Auditoría runtime inconclusa (${resultado.codigo}): ${resultado.resumen}`);
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
