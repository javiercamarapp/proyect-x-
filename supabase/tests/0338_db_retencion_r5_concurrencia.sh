#!/usr/bin/env bash
# R5: el mantenimiento diario de producto no debe bloquear INSERTs cuando el
# mes ya fue publicado. Luego prueba el rollover con 50k eventos reales.
# Uso exclusivo en PostgreSQL local/staging desechable.
set -euo pipefail

host="${1:?uso: $0 HOST PORT DB}"
port="${2:?uso: $0 HOST PORT DB}"
database="${3:?uso: $0 HOST PORT DB}"
tenant='33800000-0000-4000-8000-000000000001'
q=(psql -h "$host" -p "$port" -d "$database" -X -v ON_ERROR_STOP=1 -qAt)
salida_dir="$(mktemp -d)"
salida_writer="$salida_dir/writer.txt"
pid_writer=''

limpiar() {
  if [[ -n "$pid_writer" ]]; then
    kill "$pid_writer" 2>/dev/null || true
    wait "$pid_writer" 2>/dev/null || true
  fi
  "${q[@]}" -c "set statement_timeout='5s'; delete from public.tenant where id='$tenant';" >/dev/null || true
  rm -rf "$salida_dir"
}
trap limpiar EXIT

"${q[@]}" -c "delete from public.tenant where id='$tenant'; insert into public.tenant(id,nombre) values('$tenant','Retención R5'); select public.mantener_producto_evento(365,now(),clock_timestamp()+interval '5 seconds');" >/dev/null

# Un INSERT abierto toma ROW EXCLUSIVE. Con el mes ya publicado, mantenimiento
# no tiene nada que consolidar y debe evitar SHARE ROW EXCLUSIVE por completo.
"${q[@]}" -c "begin; insert into public.producto_evento(tenant_id,pantalla,accion) values('$tenant','viajes','pageview'); select pg_sleep(2); commit;" >"$salida_writer" &
pid_writer=$!
sleep 0.2
resultado_diario="$("${q[@]}" -c "set statement_timeout='500ms'; select (r->>'parcial')||':'||(r->>'agotado') from (select public.mantener_producto_evento(365,now(),clock_timestamp()+interval '300 milliseconds') r) q;")"
test "$resultado_diario" = 'false:true'
wait "$pid_writer"
pid_writer=''

# El rollover no debe pedir un lock de tabla que compita con el equivalente a
# autovacuum (SHARE UPDATE EXCLUSIVE). El gate asesor sí puede cerrar el mes.
"${q[@]}" -c "delete from public.producto_evento_mensual where tenant_id='$tenant'; update public.producto_evento_estado set detalle_desde=(date_trunc('month',now() at time zone 'America/Mexico_City') at time zone 'America/Mexico_City')-interval '1 month' where singleton; delete from public.producto_evento where tenant_id='$tenant'; insert into public.producto_evento(tenant_id,pantalla,accion,created_at) values('$tenant','viajes','pageview',(date_trunc('month',now() at time zone 'America/Mexico_City') at time zone 'America/Mexico_City')-interval '15 days');"
"${q[@]}" -c "begin; lock table public.producto_evento in share update exclusive mode; select pg_sleep(2); commit;" >"$salida_writer" &
pid_writer=$!
sleep 0.2
resultado_sin_lock_tabla="$("${q[@]}" -c "set statement_timeout='500ms'; select (r->>'parcial')||':'||(r->>'agotado') from (select public.mantener_producto_evento(365,now(),clock_timestamp()+interval '300 milliseconds') r) q;")"
test "$resultado_sin_lock_tabla" = 'false:true'
wait "$pid_writer"
pid_writer=''

# Rollover real de 50k: el watermark se retrocede un mes en esta base efímera,
# se carga exactamente el volumen objetivo y se comprueba la cifra publicada.
"${q[@]}" -c "delete from public.producto_evento_mensual where tenant_id='$tenant'; update public.producto_evento_estado set detalle_desde=(date_trunc('month',now() at time zone 'America/Mexico_City') at time zone 'America/Mexico_City')-interval '1 month' where singleton; delete from public.producto_evento where tenant_id='$tenant'; insert into public.producto_evento(tenant_id,pantalla,accion,created_at) select '$tenant','viajes','pageview',(date_trunc('month',now() at time zone 'America/Mexico_City') at time zone 'America/Mexico_City')-interval '15 days' from generate_series(1,50000);"
resultado_50k="$("${q[@]}" -c "set statement_timeout='10s'; select public.mantener_producto_evento(365,now(),clock_timestamp()+interval '8 seconds');")"
uso="$("${q[@]}" -c "select coalesce(sum(eventos),0) from public.uso_producto_mensual() where tenant_id='$tenant';")"
test "$uso" = '50000'
test "$("${q[@]}" -c "select count(*) from public.producto_evento_mensual where tenant_id='$tenant' and eventos=50000;")" = '1'

echo "0338_db_retencion_r5_concurrencia: PASS (diario<500ms; sin lock de tabla; rollover=50000; resultado=$resultado_50k)"
