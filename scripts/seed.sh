#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Levanta la base de Cuadra con datos de Innovativos en UN comando: `npm run
# setup`. Dos caminos, cualquiera sirve:
#
#   A) LOCAL NUEVA Y DESECHABLE — necesita Docker, Supabase CLI y psql:
#        CI=true node scripts/ci/e2e/iniciar-pila.mjs
#        npm run setup     # este script detecta la pila local sola
#
#   B) REMOTO — contra un proyecto real de Supabase:
#        DATABASE_URL="postgres://..." npm run seed
#        (Supabase → Project Settings → Database → Connection string)
#
# AUDITORÍA 25, MEDIO REINCIDENTE — en un clon limpio `npm run setup` moría
# aquí mismo: sin DATABASE_URL, sin crear `.env.local` (solo existía
# `.env.example`), sin comprobar que `psql` existiera, y sin ofrecer la ruta
# LOCAL que usa `e2e-navegador.yml`. El bootstrap prepara índices concurrentes
# antes de0332; `supabase start` directo sobre el esquema completo no basta.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v psql >/dev/null 2>&1; then
  echo "❌ Falta psql (cliente de PostgreSQL) — este script lo usa para aplicar migraciones y sembrar datos."
  echo "   macOS:          brew install libpq && brew link --force libpq"
  echo "   Debian/Ubuntu:  sudo apt-get install postgresql-client"
  echo "   O usa el que trae el CLI de Supabase: npx supabase db execute … (no lo cubre este script)."
  exit 2
fi

DB="${DATABASE_URL:-${SUPABASE_DB_URL:-}}"
# JSON de `supabase status`, solo si se detectó y se usó una pila LOCAL — se
# reutiliza más abajo para llenar `.env.local` con las llaves reales.
ESTADO_LOCAL=""

# Sin DATABASE_URL: antes de rendirse, ¿ya hay una pila LOCAL corriendo?
# El bootstrap deja la pila en los puertos de supabase/config.toml, igual
# que `e2e-navegador.yml`; aquí se consulta el puerto real con status.
if [ -z "$DB" ] && command -v supabase >/dev/null 2>&1; then
  salida="$(supabase status -o json 2>/dev/null || true)"
  if [ -n "$salida" ]; then
    encontrado="$(printf '%s' "$salida" | node -e "
      let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>{
        try { const j = JSON.parse(s); process.stdout.write(j.DB_URL || ''); } catch { /* deja vacío */ }
      });" 2>/dev/null || true)"
    if [ -n "$encontrado" ]; then
      DB="$encontrado"
      ESTADO_LOCAL="$salida"
      echo "▸ Pila LOCAL de Supabase detectada (supabase status) — usando su DATABASE_URL."
    fi
  fi
fi

if [ -z "$DB" ]; then
  echo "❌ Falta DATABASE_URL. Dos caminos, cualquiera sirve:"
  echo ""
  echo "   A) LOCAL NUEVA Y DESECHABLE — necesita Docker, Supabase CLI y psql:"
  echo "        CI=true node scripts/ci/e2e/iniciar-pila.mjs"
  echo "        # No usar supabase start directo: 0332 requiere índices concurrentes previos."
  echo "        npm run setup       # este script detecta la pila sola en el siguiente intento"
  echo ""
  echo "   B) REMOTO — contra un proyecto real de Supabase:"
  echo "        Cópialo de Supabase → Settings → Database → Connection string (URI)."
  echo "        DATABASE_URL=\"postgres://...\" npm run seed"
  exit 1
fi

# `.env.local` para que `npm run dev` tenga algo que leer después de sembrar
# — antes solo existía `.env.example` (668 líneas) y quien reconstruyera el
# entorno en la ruta LOCAL tenía que armarlo a mano ANTES de que "setup"
# hiciera algo útil. SOLO cuando la pila LOCAL se detectó arriba (nunca con
# un DATABASE_URL puesto a mano, remoto o de una prueba): un DATABASE_URL
# explícito no implica que el que llama quiera que este script le toque
# archivos del repo, y las tres llaves reales solo existen en ese caso.
if [ -n "$ESTADO_LOCAL" ] && [ ! -f .env.local ] && [ -f .env.example ]; then
  cp .env.example .env.local
  echo "▸ Creado .env.local a partir de .env.example."
  node -e "
    const fs = require('node:fs');
    const estado = JSON.parse(process.argv[1]);
    const llaves = {
      NEXT_PUBLIC_SUPABASE_URL: estado.API_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: estado.ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: estado.SERVICE_ROLE_KEY,
    };
    let texto = fs.readFileSync('.env.local', 'utf8');
    for (const [k, v] of Object.entries(llaves)) {
      if (!v) continue;
      const re = new RegExp('^' + k + '=.*$', 'm');
      texto = re.test(texto) ? texto.replace(re, k + '=' + v) : texto + '\n' + k + '=' + v + '\n';
    }
    fs.writeFileSync('.env.local', texto);
  " "$ESTADO_LOCAL" \
    && echo "▸ .env.local llenado con las llaves de la pila LOCAL (NEXT_PUBLIC_SUPABASE_URL, ANON_KEY, SERVICE_ROLE_KEY)." \
    || echo "  ⚠ No se pudieron escribir las llaves locales en .env.local — llénalas a mano con 'supabase status'."
fi

# ═══════════════════════════════════════════════════════════════════════════
# 🛑 DOS GUARDS ANTES DE ESCRIBIR NADA (auditoría 18, DAT-16)
#
# Este script aplica migraciones y siembra datos que SOBRESCRIBEN el tenant
# 11111111-…-111111111111: razón social, domicilio fiscal, liga del aviso de
# privacidad y RFC. En producción ese id es una flota real, y el único paso
# entre "sembrar el demo" y "cambiarle el RFC a un cliente" era acordarse de
# qué DATABASE_URL estaba exportado en esa terminal.
#
#   1. POR HOST — un host de Supabase gestionado (*.supabase.co, *.supabase.com,
#      el pooler) exige --produccion escrito a mano. No distingue prod de
#      staging (no hay forma desde aquí), así que pide la confirmación en los
#      dos: el que siembra en staging teclea seis palabras de más.
#   2. POR NOMBRE — si la flota de ese id ya existe y no se llama "Flota Demo",
#      esta base no es de demo y no se toca. El mismo guard vive en seed.sql
#      (que es lo que protege a quien corra el .sql a mano); aquí se adelanta
#      para no aplicar migraciones sobre una base ajena.
#
# Uso deliberado:  DATABASE_URL="postgres://…" npm run seed -- --produccion
# ═══════════════════════════════════════════════════════════════════════════
PRODUCCION=0
for arg in "$@"; do
  case "$arg" in
    --produccion) PRODUCCION=1 ;;
    *) echo "❌ Opción desconocida: $arg (la única es --produccion)"; exit 1 ;;
  esac
done

# host, sin esquema, sin credenciales, sin puerto ni ruta
HOST=$(printf '%s' "$DB" | sed -E 's#^[a-zA-Z+]+://##; s#^[^@/]*@##; s#[:/?].*$##')

case "$HOST" in
  *.supabase.co|*.supabase.com)
    if [ "$PRODUCCION" != "1" ]; then
      echo "❌ REHUSADO: «${HOST}» es una base de Supabase gestionada, y este seed SOBRESCRIBE"
      echo "   el tenant 11111111-…-111111111111 (razón social, domicilio, aviso de privacidad y RFC)."
      echo "   En una flota real eso apaga o desvía la validación de receptor de CFDI."
      echo ""
      echo "   Si de verdad es lo que quieres, dilo a mano:"
      echo "     DATABASE_URL=\"$DB\" npm run seed -- --produccion"
      exit 1
    fi
    echo "⚠️  Sembrando contra «${HOST}» con --produccion. Sobrescribe el tenant demo si existe."
    ;;
esac

# El guard por nombre solo se puede consultar si el esquema ya está.
if psql "$DB" -q -tAc "select 1 from information_schema.tables where table_schema='public' and table_name='tenant'" | grep -q 1; then
  # `-tA` ya viene sin relleno ni encabezados y `$( )` come el salto final, así
  # que el nombre llega tal cual: colapsar espacios aquí haría que "Flota Demo"
  # y "FlotaDemo" pasaran por lo mismo.
  NOMBRE=$(psql "$DB" -q -tAc "select nombre from tenant where id = '11111111-1111-1111-1111-111111111111'")
  if [ -n "$NOMBRE" ] && [ "$NOMBRE" != "Flota Demo" ]; then
    echo "❌ REHUSADO: el tenant 11111111-…-111111111111 de esta base se llama «${NOMBRE}», no «Flota Demo»."
    echo "   Esta no es una base de demo y el seed le sobrescribiría RFC, razón social, domicilio y aviso de privacidad."
    echo "   Si de verdad querías sembrar aquí, renombra esa flota a «Flota Demo» a mano — a sabiendas — o siembra con otro id."
    exit 1
  fi
fi

# AUDITORÍA 13, ALTO (operabilidad): correr TODAS las migraciones contra una
# base ya migrada reventaba (objetos que ya existen). Si la base ya tiene el
# esquema (migración 0001 aplicada), solo se siembran los DATOS; el esquema se
# aplica con el camino documentado (Supabase MCP / `supabase db push`).
if psql "$DB" -q -tAc "select 1 from information_schema.tables where table_schema='public' and table_name='viaje'" | grep -q 1; then
  echo "▸ Esquema ya aplicado — solo se siembran los DATOS (para el esquema usa el MCP o 'supabase db push')."
else
  echo "▸ Aplicando migraciones…"
  for f in supabase/migrations/*.sql; do
    case "$(basename "$f")" in
      0332_*)
        echo "  → Preflight de índices concurrentes antes de0332"
        # Proceso independiente en autocommit: CONCURRENTLY no puede correr
        # dentro de una transacción; -X evita opciones de .psqlrc heredadas.
        psql "$DB" -X -v ON_ERROR_STOP=1 -q -f scripts/ci/0335_preflight_retencion_indices.sql
        ;;
    esac
    echo "  → $(basename "$f")"
    psql "$DB" -v ON_ERROR_STOP=1 -q -f "$f"
  done
fi

echo "▸ Creando bucket privado 'liquidaciones'…"
psql "$DB" -q -c "insert into storage.buckets (id, name, public) values ('liquidaciones','liquidaciones', false) on conflict (id) do nothing;" \
  || echo "  ⚠ No se pudo crear el bucket por SQL — créalo a mano en Supabase → Storage (privado)."

echo "▸ Sembrando datos de Innovativos (🔴 valores INVENTADOS marcados en seed.sql)…"
psql "$DB" -v ON_ERROR_STOP=1 -q -f supabase/seed.sql

echo ""
echo "✅ Listo. Datos de Innovativos cargados."
echo "   • 3 terminales (Silao, Guadalajara, Nuevo Laredo)"
echo "   • 5 operadores (🔴 teléfonos INVENTADOS — pon el número de prueba de Meta)"
echo "   • Política de gastos (🔴 topes INVENTADOS — ajústalos en seed.sql)"
echo "   • 1 viaje demo abierto (Silao→Laredo) con UNA diferencia: diésel \$200 sobre política"
echo "   • 3 liquidaciones de historial para el dashboard"
echo ""
echo "   Siguiente: pon las llaves en .env.local (ver .env.example) y corre  npm run dev"
