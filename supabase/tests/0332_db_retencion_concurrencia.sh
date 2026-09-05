#!/usr/bin/env bash
# Una fila elegible queda bloqueada por A. La purga B debe saltarla, borrar
# otros 5,000 candidatos y terminar antes de 1 s; nunca esperar ese lock.
# Uso exclusivo en PostgreSQL local/staging desechable.
set -euo pipefail

host="${1:?uso: $0 HOST PORT DB}"
port="${2:?uso: $0 HOST PORT DB}"
database="${3:?uso: $0 HOST PORT DB}"
tenant='33200000-0000-4000-8000-000000000020'
psql_cmd=(psql -h "$host" -p "$port" -d "$database" -X -v ON_ERROR_STOP=1 -qAt)
salida_dir="$(mktemp -d)"
salida_a="$salida_dir/a.txt"
pid_a=''

limpiar() {
  if [[ -n "$pid_a" ]]; then
    kill "$pid_a" 2>/dev/null || true
    wait "$pid_a" 2>/dev/null || true
  fi
  "${psql_cmd[@]}" -c "set statement_timeout='5s'; delete from public.tenant where id='$tenant';" >/dev/null || true
  rm -rf "$salida_dir"
}
trap limpiar EXIT

limpiar_datos() {
  "${psql_cmd[@]}" -c "set statement_timeout='5s'; delete from public.tenant where id='$tenant';" >/dev/null
}

limpiar_datos
"${psql_cmd[@]}" -c "insert into public.tenant(id,nombre) values('$tenant','Concurrencia 0332'); insert into public.wa_conversacion(tenant_id,telefono,updated_at) select '$tenant','5277'||lpad(g::text,8,'0'),now()-interval '181 days' from generate_series(1,6001) g;"

"${psql_cmd[@]}" -c "set application_name='0332-purge-lock-a'; begin; select id from public.wa_conversacion where tenant_id='$tenant' order by updated_at,id limit 1 for update; select pg_sleep(2); commit;" >"$salida_a" &
pid_a=$!
sleep 0.2

resultado_b="$("${psql_cmd[@]}" -c "set statement_timeout='1s'; select (r->>'borradas')||':'||(r->>'parcial')||':'||(r->>'agotado') from (select public.purgar_wa_conversacion(180,now(),clock_timestamp()+interval '10 seconds') r) q;")"
test "$resultado_b" = '5000:true:false'

wait "$pid_a"
pid_a=''

resultado_final="$("${psql_cmd[@]}" -c "set statement_timeout='1s'; select (r->>'borradas')||':'||(r->>'parcial')||':'||(r->>'agotado') from (select public.purgar_wa_conversacion(180,now(),clock_timestamp()+interval '10 seconds') r) q;")"
restantes="$("${psql_cmd[@]}" -c "select count(*) from public.wa_conversacion where tenant_id='$tenant' and updated_at < now()-interval '180 days';")"
test "$resultado_final" = '1001:false:true'
test "$restantes" = '0'

echo '0332_db_retencion_concurrencia: PASS (lock saltado, B=5000, final=1001)'
