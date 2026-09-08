#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# LA SECUENCIA COMPLETA: migraciones pendientes → verificar → humos → listo
# para [deploy].
# (16-ago-2026 — el desbloqueo que todo el día estuvo esperando.
#  7-sep-2026, OP-M4/auditoría 28 — el paso 2/3 verificaba con una lista de
#  tablas/columnas/RPC escrita a mano, congelada desde el día en que se creó
#  este script; cientos de migraciones después seguía "verificando" piezas que
#  llevaban meses en producción y no decía una palabra de todo lo posterior.
#  Ahora verifica TODAS las pendientes según `supabase/migrations/`, con el
#  mismo cotejo por CONJUNTO que ya usa la compuerta de Vercel:
#  `scripts/ci/verificar-migraciones-aplicadas.mjs`.)
#
# Uso: SUPABASE_DB_URL='postgresql://...' bash scripts/aplicar-migraciones-y-humos.sh
#
# Qué hace, en orden, parándose en el primer fallo:
#  1. `db push` de TODAS las migraciones pendientes según `supabase/migrations/`
#     con el CLI oficial vía npx — no instala nada global.
#  2. Verificación contra la base real: el CONJUNTO completo de prefijos del
#     repo tiene que estar en lo que `migraciones_aplicadas()` (0234) registra
#     — `scripts/ci/verificar-migraciones-aplicadas.mjs`, el mismo cotejo que
#     usa la compuerta de Vercel (`compuerta-deploy.mjs`). Paso 2b, opcional:
#     si `/api/health` ya está desplegado con el cotejo de esta ronda (OP-C1),
#     confirma además `migracion.atras === 0 && migracion.adelante === 0`.
#  3. Humos de la app contra la base ya migrada (pruebas-manuales/humo-*).
#  4. NO hace el [deploy]: lo imprime como siguiente paso — el deploy es un
#     commit con la bandera en el ASUNTO y esa tecla es consciente.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

# `REF` es solo informativo (se imprime en el paso 1/3); se deriva de la
# variable de entorno si ya está puesta, o de `.env.local` si el archivo
# existe. Que falte el archivo NO detiene el script: lo que de verdad hace
# falta para migrar es `SUPABASE_DB_URL`, comprobado abajo.
REF_URL="${NEXT_PUBLIC_SUPABASE_URL:-}"
if [ -z "$REF_URL" ] && [ -f .env.local ]; then
  REF_URL="$(grep '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | head -1 | cut -d= -f2-)"
fi
REF="$(printf '%s' "$REF_URL" | sed -E 's#.*//([a-z0-9]+)\.supabase\.co.*#\1#')"
[ -n "$REF" ] || REF="(sin resolver — pon NEXT_PUBLIC_SUPABASE_URL en el entorno o en .env.local; no detiene el script)"

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "Falta SUPABASE_DB_URL. El rollout de 0332/0335 es fail-closed: necesita una"
  echo "conexión SQL directa para crear/verificar los índices CONCURRENTLY antes"
  echo "de que Supabase abra la transacción de migraciones. Un token solo no basta."
  echo "Dashboard → Project Settings → Database → Connection string (URI)"
  echo "SUPABASE_DB_URL='postgresql://...' bash scripts/aplicar-migraciones-y-humos.sh"
  exit 2
fi

# El preflight de la 0335 crea (CONCURRENTLY, fuera de la transacción de `db
# push`) dos índices que la migración 0332 exige YA VÁLIDOS al aplicarse — no
# es opcional para cualquier base que todavía no tenga 0332 aplicada (una base
# nueva, o un clon detrás de esa ronda). En producción, hoy, la 0332/0335 YA
# están aplicadas: el preflight es histórico ahí y se salta con un cotejo
# directo (los dos índices ya existen y son válidos) — no hace falta volver a
# correrlo a ciegas cada vez.
if command -v psql >/dev/null 2>&1; then
  YA_VALIDOS="$(psql "$SUPABASE_DB_URL" -tAqc "select (to_regclass('public.wa_conversacion_purga_idx') is not null) and (to_regclass('public.codigo_pendiente_purga_idx') is not null)" 2>/dev/null || echo f)"
  if [ "$YA_VALIDOS" = "t" ]; then
    echo "(preflight de 0335 histórico: los índices ya existen en esta base — se omite)"
  else
    echo "═══ Preflight · índices concurrentes de retención antes de 0332/0335 ═══"
    psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f scripts/ci/0335_preflight_retencion_indices.sql
  fi
else
  echo "AVISO: sin psql no se puede confirmar si el preflight de la 0335 hace falta."
  echo "Si esta base todavía NO tiene aplicada la 0332, el push de abajo va a fallar:"
  echo "instala psql y vuelve a correr, o corre a mano scripts/ci/0335_preflight_retencion_indices.sql."
fi

echo "═══ 1/3 · Aplicando migraciones pendientes (project: $REF) ═══"
npx --yes supabase@latest db push --db-url "$SUPABASE_DB_URL" --include-all

echo "═══ 2/3 · Verificando el CONJUNTO completo contra migraciones_aplicadas() ═══"
SALIDA_VERIFICADOR="$(node scripts/ci/verificar-migraciones-aplicadas.mjs)" || { echo "$SALIDA_VERIFICADOR"; exit 1; }
echo "$SALIDA_VERIFICADOR"
RANGO_APLICADO="$(printf '%s\n' "$SALIDA_VERIFICADOR" | sed -n 's/^base: //p' | head -1)"

# Paso 2b, opcional: si /api/health ya está desplegado con el cotejo por
# CONJUNTO de esta ronda (OP-C1), confirma que las dos derivas están en cero.
# Puramente informativo: no detiene el script si el health todavía no trae el
# campo (versión anterior a esta ronda) o si es el deploy anterior a migrar.
if command -v curl >/dev/null 2>&1; then
  SALUD="$(curl -fsS --max-time 10 https://app.likida.ai/api/health 2>/dev/null || true)"
  if [ -n "$SALUD" ]; then
    echo "═══ 2b/3 · /api/health: migracion.atras y migracion.adelante ═══"
    printf '%s\n' "$SALUD" | node -e "
let s='';
process.stdin.on('data', d => s += d).on('end', () => {
  try {
    const m = JSON.parse(s).migracion;
    console.log('migracion:', JSON.stringify(m));
    if (m && m.atras === 0 && m.adelante === 0) console.log('✅ base y código a la par.');
    else console.log('⚠️  /api/health no confirma atras=0/adelante=0 todavía (puede ser el deploy anterior a migrar; informativo, no detiene el script).');
  } catch (e) {
    console.log('(no se pudo leer /api/health como JSON:', e.message, ')');
  }
});
"
  fi
fi

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
if [ -n "$RANGO_APLICADO" ]; then
  echo "Base tras esta corrida: $RANGO_APLICADO"
else
  echo "(el verificador no imprimió el resumen de la base — revisa su salida arriba)"
fi
echo "El siguiente paso es consciente y es UNO:"
echo "  git commit --allow-empty -m '[deploy] producción al día tras esta corrida de migraciones' && git push origin master"
echo "════════════════════════════════════════════════════════════"
