#!/usr/bin/env bash
# El snapshot espera un INSERT viejo en vuelo antes de publicar watermark.
# Uso exclusivo en PostgreSQL local/staging desechable.
set -euo pipefail

host="${1:?uso: $0 HOST PORT DB}"
port="${2:?uso: $0 HOST PORT DB}"
database="${3:?uso: $0 HOST PORT DB}"
tenant='33500000-0000-4000-8000-000000000030'
q=(psql -h "$host" -p "$port" -d "$database" -X -v ON_ERROR_STOP=1 -qAt)
salida_dir="$(mktemp -d)"
salida_a="$salida_dir/a.txt"
pid_a=''

limpiar() {
  if [[ -n "$pid_a" ]]; then
    kill "$pid_a" 2>/dev/null || true
    wait "$pid_a" 2>/dev/null || true
  fi
  "${q[@]}" -c "set statement_timeout='5s'; delete from public.tenant where id='$tenant';" >/dev/null || true
  rm -rf "$salida_dir"
}
trap limpiar EXIT

"${q[@]}" -c "delete from public.tenant where id='$tenant'; insert into public.tenant(id,nombre) values('$tenant','Concurrencia producto 0335');"
"${q[@]}" -c "set application_name='0335-product-writer-a'; begin; insert into public.producto_evento(tenant_id,pantalla,accion,created_at) values('$tenant','viajes','pageview',now()-interval '2 months'); select pg_sleep(2); commit;" >"$salida_a" &
pid_a=$!
sleep 0.2

"${q[@]}" -c "set statement_timeout='5s'; select public.mantener_producto_evento(365,now(),clock_timestamp()+interval '4 seconds');" >/dev/null
wait "$pid_a"
pid_a=''
uso="$("${q[@]}" -c "select coalesce(sum(eventos),0) from public.uso_producto_mensual() where tenant_id='$tenant';")"
test "$uso" = '1'

echo '0335_db_retencion_r3_concurrencia: PASS (escritor en vuelo precede snapshot/watermark)'
