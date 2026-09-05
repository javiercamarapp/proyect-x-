#!/usr/bin/env bash
# Gate reproducible de upgrade: verifica que 0329 se puede aplicar sobre una
# base con el esquema previo y repetir de forma idempotente. No modifica repo.
set -euo pipefail
host="${1:?uso: $0 HOST PORT DB [MIGRATIONS_DIR]}"
port="${2:?uso: $0 HOST PORT DB [MIGRATIONS_DIR]}"
database="${3:?uso: $0 HOST PORT DB [MIGRATIONS_DIR]}"
migrations_dir="${4:-supabase/migrations}"
psql_cmd=(psql -h "$host" -p "$port" -d "$database" -X -v ON_ERROR_STOP=1 -qAt)
migration="$migrations_dir/0329_capacidad_ronda2_forward.sql"
test -s "$migration"

# La prueba es forward-only: sólo aplica el archivo versionado; una segunda
# aplicación debe ser limpia gracias a IF NOT EXISTS/CREATE OR REPLACE.
"${psql_cmd[@]}" -f "$migration" >/dev/null
"${psql_cmd[@]}" -f "$migration" >/dev/null
"${psql_cmd[@]}" -c "select to_regclass('public.jornada_derivacion_invalida'), to_regclass('public.jornada_revision_historial'), to_regprocedure('public.reclamar_jornadas_por_derivar(integer,text,integer)');" \
  | awk -F'|' '$1 != "" && $2 != "" && $3 != "" {ok=1} END {exit(ok ? 0 : 1)}'
echo "0329_upgrade_forward_only: PASS (aplicación doble idempotente)"
