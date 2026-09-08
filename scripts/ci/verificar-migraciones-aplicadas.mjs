#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// EL VERIFICADOR REAL DE "¿YA APLIQUÉ TODO?" — OP-M4 (auditoría 28, MEDIO
// REINCIDENTE 27).
//
// `aplicar-migraciones-y-humos.sh` verificaba con una lista escrita a mano de
// la era 0115-0125 (`agente_definicion`, `cola_aprobacion`, …), congelada
// desde el 16-ago-2026: 222 migraciones después seguía "verificando" tablas
// que ya llevaban meses en producción y no decía una palabra de 0126-0347.
//
// Lo que YA existe y sobraba usar: la RPC `migraciones_aplicadas()` (mig.
// 0234) devuelve `{disponible, filas:[{nombre}]}` con TODO lo que la base
// registra aplicado. Este script coteja el CONJUNTO completo de prefijos del
// repo (`supabase/migrations/NNNN_*.sql`, vía `prefijosMigraciones` de
// `compuerta-deploy.mjs` — la misma función que usa la compuerta de Vercel)
// contra ese conjunto real, en vez de una lista de tablas que nadie actualiza.
//
// Detecta los dos sentidos de deriva (el mismo par que `migracion.ts` desde
// OP-C1): `faltantes` = prefijo del repo que la base NO tiene aplicado
// (atrás); `sobrantes` = prefijo que la base tiene y el repo no conoce
// (adelante — la deriva que el 7-sep-2026 dejó el health en verde con el
// clamp de `atras`, ya corregido).
//
// FALLA CERRADO: sin credenciales, con la RPC caída, o con `disponible !==
// true`, el veredicto es "no se pudo verificar" (exit 1), nunca "está bien".
// La línea de veredicto NUNCA lleva el mensaje crudo de Postgres (regla de
// `src/app/api/v1/_comun.ts:74`, que `migracion.ts:141-147` ya sigue para
// `/api/health`): el detalle, si hace falta, va en una línea aparte marcada
// como tal.
// ═══════════════════════════════════════════════════════════════════════════

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { prefijosMigraciones } from './compuerta-deploy.mjs';

const PREFIJO = /^(\d{4})_/;

/**
 * PURA. `repo` y `aplicados` son arreglos de prefijos de cuatro dígitos ya
 * extraídos (no filas crudas). Devuelve qué le falta a la base (`faltantes`,
 * la deriva "atrás") y qué tiene la base que el repo no conoce (`sobrantes`,
 * la deriva "adelante" — OP-C1). `ok` solo es `true` cuando los dos conjuntos
 * coinciden exactamente.
 * @param {{ repo: string[], aplicados: string[] }} p
 */
export function cotejarConjuntos({ repo, aplicados }) {
  const repoSet = new Set(repo);
  const aplicadosSet = new Set(aplicados);
  const faltantes = repo.filter((p) => !aplicadosSet.has(p)).sort();
  const sobrantes = aplicados.filter((p) => !repoSet.has(p)).sort();
  return { faltantes, sobrantes, ok: faltantes.length === 0 && sobrantes.length === 0 };
}

/**
 * Extrae los prefijos de cuatro dígitos de las `filas` que devuelve
 * `migraciones_aplicadas()` (cada una con `nombre`, p. ej.
 * `0271_mcp_oauth_rol`). Una fila con `nombre` ausente o con un formato que
 * no empieza en cuatro dígitos NO inventa un prefijo: se ignora, igual que
 * `prefijosAplicados` en `src/app/api/health/migracion.ts`.
 * @param {Array<{ nombre?: unknown }>} filas
 */
export function prefijosDeFilas(filas) {
  const vistos = new Set();
  for (const f of filas) {
    const p = typeof f?.nombre === 'string' ? PREFIJO.exec(f.nombre)?.[1] : undefined;
    if (p !== undefined) vistos.add(p);
  }
  return [...vistos].sort();
}

/** El mismo parser que `aplicar-migraciones-y-humos.sh` usa hoy (paso 2/3)
 *  para leer `.env.local` sin pisar variables ya puestas por el entorno. */
function cargarEnvLocal(ruta = '.env.local') {
  if (!existsSync(ruta)) return;
  for (const l of readFileSync(ruta, 'utf8').split('\n')) {
    const m = l.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
  }
}

function resumen(prefijos, n = 12) {
  return prefijos.length === 0 ? '(ninguno)' : `${prefijos.slice(0, n).join(', ')}${prefijos.length > n ? '…' : ''}`;
}

async function main() {
  cargarEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const clave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !clave) {
    console.log('verificador de migraciones: NO se pudo verificar — faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY (ni en el entorno ni en .env.local).');
    process.exit(1);
  }

  const repo = prefijosMigraciones();

  let mod;
  try {
    mod = await import('@supabase/supabase-js');
  } catch (e) {
    console.log(`verificador de migraciones: NO se pudo verificar — @supabase/supabase-js no se pudo cargar (${e instanceof Error ? e.message : String(e)}).`);
    process.exit(1);
  }
  const db = mod.createClient(url, clave);

  let data, error;
  try {
    ({ data, error } = await db.rpc('migraciones_aplicadas'));
  } catch (e) {
    console.log(`verificador de migraciones: NO se pudo verificar — migraciones_aplicadas() lanzó (detalle: ${e instanceof Error ? e.message : String(e)}).`);
    process.exit(1);
  }
  if (error) {
    // Detalle en su propia línea, marcado — nunca en la línea de veredicto.
    console.log(`detalle (Postgres): ${error.message}`);
    console.log('verificador de migraciones: NO se pudo verificar — migraciones_aplicadas() no contestó.');
    process.exit(1);
  }
  const r = data;
  if (!r || r.disponible !== true || !Array.isArray(r.filas)) {
    const motivo = typeof r?.motivo === 'string' ? r.motivo : 'migraciones_aplicadas() no devolvió el registro esperado';
    console.log(`detalle: ${motivo}`);
    console.log('verificador de migraciones: NO se pudo verificar — la RPC no está disponible.');
    process.exit(1);
  }

  const aplicados = prefijosDeFilas(r.filas);
  const { faltantes, sobrantes, ok } = cotejarConjuntos({ repo, aplicados });

  console.log(`verificador de migraciones · repo=${repo.length} · base=${aplicados.length}`);
  console.log(`repo: ${resumen(repo)}`);
  console.log(`base: ${resumen(aplicados)}`);

  if (!ok) {
    if (faltantes.length > 0) {
      console.log(`faltantes (el repo las trae y la base NO las tiene aplicadas, ${faltantes.length}): ${resumen(faltantes)}`);
    }
    if (sobrantes.length > 0) {
      console.log(`sobrantes (la base las tiene aplicadas y el repo NO las conoce — deriva "adelante", OP-C1, ${sobrantes.length}): ${resumen(sobrantes)}`);
    }
    console.log('verificador de migraciones: NO ESTÁ AL DÍA.');
    process.exit(1);
  }

  console.log('verificador de migraciones: la base tiene aplicado el CONJUNTO completo de migraciones del repo. OK.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
