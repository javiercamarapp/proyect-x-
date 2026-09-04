#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# LA SECUENCIA COMPLETA: migraciones pendientes → humos → listo para [deploy].
# (16-ago-2026 — el desbloqueo que todo el día estuvo esperando.)
#
# Uso: SUPABASE_DB_URL='postgresql://...' bash scripts/aplicar-migraciones-y-humos.sh
#
# Qué hace, en orden, parándose en el primer fallo:
#  1. `db push` de TODAS las migraciones pendientes (0115–0125) con el CLI
#     oficial vía npx — no instala nada global.
#  2. Verificaciones post-migración contra la base real: los bloques de
#     `supabase/verificaciones.sql` son del CI efímero; aquí se verifican las
#     piezas NUEVAS con consultas de presencia (tablas, columnas, RPC, CHECK).
#  3. Humos de la app contra la base ya migrada (pruebas-manuales/humo-*).
#  4. NO hace el [deploy]: lo imprime como siguiente paso — el deploy es un
#     commit con la bandera en el ASUNTO y esa tecla es consciente.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

REF="$(grep '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | head -1 | sed -E 's#.*//([a-z0-9]+)\.supabase\.co.*#\1#')"
[ -n "$REF" ] || { echo "No pude leer el project ref de .env.local"; exit 2; }

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "Falta SUPABASE_DB_URL. El rollout de 0332 es fail-closed: necesita una"
  echo "conexión SQL directa para crear/verificar los índices CONCURRENTLY antes"
  echo "de que Supabase abra la transacción de migraciones. Un token solo no basta."
  echo "Dashboard → Project Settings → Database → Connection string (URI)"
  echo "SUPABASE_DB_URL='postgresql://...' bash scripts/aplicar-migraciones-y-humos.sh"
  exit 2
fi

command -v psql >/dev/null || { echo "Falta psql para el preflight concurrente de 0332."; exit 2; }
echo "═══ Preflight · índices concurrentes de retención antes de 0332 ═══"
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f scripts/ci/0335_preflight_retencion_indices.sql

echo "═══ 1/3 · Aplicando migraciones pendientes (project: $REF) ═══"
npx --yes supabase@latest db push --db-url "$SUPABASE_DB_URL" --include-all

echo "═══ 2/3 · Verificación de las piezas nuevas en la base real ═══"
npx tsx - <<'TSX'
import { readFileSync } from 'node:fs';
for (const l of readFileSync('.env.local','utf8').split('\n')) {
  const m = l.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/\s+#.*$/,'').trim().replace(/^["']|["']$/g,'');
}
const { createClient } = await import('@supabase/supabase-js');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
let fallos = 0;
const ok = (nombre: string, cond: boolean, detalle = '') => {
  console.log(`${cond ? '✅' : '❌'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  if (!cond) fallos++;
};
// Tablas nuevas responden (un select head vacío basta para probar existencia):
for (const t of ['agente_definicion','cola_aprobacion','prospecto_contacto','wa_evento_pendiente','copiloto_conversacion','copiloto_mensaje','campana']) {
  const { error } = await db.from(t).select('*', { head: true, count: 'exact' });
  ok(`tabla ${t}`, !error, error?.message ?? '');
}
// Columnas de alters clave:
const { error: eCosto } = await db.from('agente_corrida').select('costo_usd', { head: true });
ok('agente_corrida.costo_usd (0123)', !eCosto, eCosto?.message ?? '');
const { error: eRol } = await db.from('agente_definicion').select('modelo_rol', { head: true });
ok('agente_definicion.modelo_rol (0125)', !eRol, eRol?.message ?? '');
// La siembra del catálogo:
const { count } = await db.from('agente_definicion').select('*', { head: true, count: 'exact' });
ok('catálogo sembrado (≥50 agentes)', (count ?? 0) >= 50, `${count} filas`);
// La RPC de cadencia atómica (0124): llamarla con uuid imposible debe dar
// respuesta de función (null/exception de negocio), no "function not found":
const { error: eRpc } = await db.rpc('reservar_envio_prospecto', {
  p_prospecto: '00000000-0000-4000-8000-000000000000', p_pieza: '00000000-0000-4000-8000-000000000000',
  p_actor: null, p_resumen: 'humo', p_horas: 48,
});
ok('RPC reservar_envio_prospecto (0124)', !eRpc || !/could not find|does not exist/i.test(eRpc.message), eRpc?.message ?? 'respondió');
if (fallos > 0) { console.error(`\n${fallos} verificación(es) fallaron`); process.exit(1); }
console.log('\nTodas las piezas nuevas responden en la base real.');
TSX

echo "═══ 3/3 · Humos de la app ═══"
if ls pruebas-manuales/humo-*.prueba.ts >/dev/null 2>&1; then
  npx vitest run --config vitest.manual.config.ts pruebas-manuales/humo-*.prueba.ts 2>/dev/null \
    || npx vitest run pruebas-manuales/humo-*.prueba.ts
else
  echo "(sin archivos humo-*.prueba.ts — se omite)"
fi

echo ""
echo "════════════════════════════════════════════════════════════"
echo "✅ MIGRACIONES APLICADAS Y VERIFICADAS."
echo "El siguiente paso es consciente y es UNO:"
echo "  git commit --allow-empty -m '[deploy] producción al día: migraciones 0115-0125 + todo lo del 16-ago' && git push origin master"
echo "════════════════════════════════════════════════════════════"
