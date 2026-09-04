#!/usr/bin/env bash
# Dos sesiones PostgreSQL reales. A conserva 400 locks durante dos segundos;
# B debe saltarlos y reclamar los otros 400 antes de statement_timeout=1s.
# Uso exclusivo en base local/staging desechable.
set -euo pipefail

host="${1:?uso: $0 HOST PORT DB}"
port="${2:?uso: $0 HOST PORT DB}"
database="${3:?uso: $0 HOST PORT DB}"
tenant='32590000-0000-4000-8000-000000000001'
psql_cmd=(psql -h "$host" -p "$port" -d "$database" -X -v ON_ERROR_STOP=1 -qAt)
salida_dir="$(mktemp -d)"
salida_a="$salida_dir/a.txt"
salida_b="$salida_dir/b.txt"
salida_update="$salida_dir/update.txt"
pid_a=''
pid_update=''

limpiar() {
  if [[ -n "$pid_a" ]]; then
    kill "$pid_a" 2>/dev/null || true
    wait "$pid_a" 2>/dev/null || true
  fi
  if [[ -n "$pid_update" ]]; then
    kill "$pid_update" 2>/dev/null || true
    wait "$pid_update" 2>/dev/null || true
  fi
  "${psql_cmd[@]}" -c "set statement_timeout='10s'; set lock_timeout='2s'; delete from public.tenant where id='$tenant';" >/dev/null || true
  rm -rf "$salida_dir"
}
trap limpiar EXIT

limpiar_datos() {
  "${psql_cmd[@]}" -c "set statement_timeout='10s'; set lock_timeout='2s'; delete from public.tenant where id='$tenant'; insert into public.tenant(id,nombre,zona_horaria) values('$tenant','Concurrencia 0325','America/Mexico_City'); insert into public.operador(id,tenant_id,nombre,telefono,aviso_privacidad_en) select md5('0325-conc-op-'||g)::uuid,'$tenant','Op '||g,'523259'||lpad(g::text,6,'0'),clock_timestamp() from generate_series(1,800) g; insert into public.viaje(id,tenant_id,operador_id,avisado_en,aceptado_en) select md5('0325-conc-v-'||g)::uuid,'$tenant',md5('0325-conc-op-'||g)::uuid,'2026-09-03 11:59+00','2026-09-03 12:00+00'::timestamptz+make_interval(secs=>g) from generate_series(1,800) g; select public.sincronizar_jornadas_por_derivar('2026-09-03 18:00+00',1);" >/dev/null
}

limpiar_datos

"${psql_cmd[@]}" -c "set application_name='0325-worker-a'; begin; set local statement_timeout='5s'; select id from public.reclamar_jornadas_por_derivar(400,'worker-real-a',180); select pg_sleep(2); commit;" >"$salida_a" &
pid_a=$!
sleep 0.2

# Evidencia de que A conserva sus locks pero no está esperando otro
# transactionid. `Timeout:PgSleep` es el sueño deliberado de esta prueba.
estado_a="$("${psql_cmd[@]}" -F '|' -c "set statement_timeout='2s'; select state || ':' || coalesce(wait_event_type, '-') || ':' || coalesce(wait_event, '-') from pg_stat_activity where application_name='0325-worker-a';")"
locks_no_concedidos="$("${psql_cmd[@]}" -c "set statement_timeout='2s'; select count(*) from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name='0325-worker-a' and not l.granted;")"

# Si reclamar aún hiciera el UPSERT previo o esperara el transactionid de A,
# esta sesión moriría al segundo. SKIP LOCKED debe devolver los otros 400.
"${psql_cmd[@]}" -c "begin; set local statement_timeout='1s'; select id from public.reclamar_jornadas_por_derivar(400,'worker-real-b',180); commit;" >"$salida_b"
wait "$pid_a"
pid_a=''

cuantos_a="$(grep -Ec '^[0-9a-f-]{36}$' "$salida_a")"
cuantos_b="$(grep -Ec '^[0-9a-f-]{36}$' "$salida_b")"
repetidos="$(comm -12 <(grep -E '^[0-9a-f-]{36}$' "$salida_a" | sort) <(grep -E '^[0-9a-f-]{36}$' "$salida_b" | sort) | wc -l | tr -d ' ')"

test "$cuantos_a" = '400'
test "$cuantos_b" = '400'
test "$repetidos" = '0'
test "$estado_a" = 'active:Timeout:PgSleep'
test "$locks_no_concedidos" = '0'
echo "0325_jornada_concurrencia: PASS (A=$cuantos_a B=$cuantos_b repetidos=$repetidos, B<1s, A=$estado_a, locks_no_concedidos=$locks_no_concedidos)"

# El procesador cerca la fuente con FOR SHARE. Un corrector que intenta poner
# aceptado_en=NULL mientras el RPC sigue abierto debe esperar; después del
# commit, el sync reconcilia la cola obsoleta sin duplicarla.
limpiar_datos
viaje_fence="$("${psql_cmd[@]}" -c "select md5('0325-conc-v-1')::uuid;")"
operador_fence="$("${psql_cmd[@]}" -c "select md5('0325-conc-op-1')::uuid;")"
"${psql_cmd[@]}" -c "update public.jornada_derivacion_trabajo set siguiente_intento_en='infinity' where tenant_id='$tenant' and operador_id<>'$operador_fence';" >/dev/null
token_fence="$("${psql_cmd[@]}" -c "select claim_token from public.reclamar_jornadas_por_derivar(1,'worker-fence',180);")"
test -n "$token_fence"

"${psql_cmd[@]}" -c "set application_name='0325-processor-fence'; begin; set local statement_timeout='5s'; select exito from public.procesar_jornadas_derivadas('worker-fence',array['$token_fence'::uuid],3600,300); select pg_sleep(2); commit;" >"$salida_a" &
pid_a=$!
sleep 0.2

"${psql_cmd[@]}" -c "set application_name='0325-updater-fence'; set statement_timeout='5s'; update public.viaje set aceptado_en=null where id='$viaje_fence';" >"$salida_update" &
pid_update=$!
sleep 0.2

estado_update="$("${psql_cmd[@]}" -F '|' -c "set statement_timeout='2s'; select state || ':' || coalesce(wait_event_type, '-') || ':' || coalesce(wait_event, '-') from pg_stat_activity where application_name='0325-updater-fence';")"
case "$estado_update" in
  active:Lock:*) ;;
  *) echo "updater no esperó el fence: $estado_update" >&2; exit 1 ;;
esac

wait "$pid_a"
pid_a=''
wait "$pid_update"
pid_update=''

test "$(grep -Ec '^t$' "$salida_a")" = '1'
"${psql_cmd[@]}" -c "select public.sincronizar_jornadas_por_derivar('2026-09-03 18:00+00',1);" >/dev/null
cola_fence="$("${psql_cmd[@]}" -c "select count(*) from public.jornada_derivacion_trabajo where tenant_id='$tenant' and operador_id='$operador_fence';")"
jornadas_fence="$("${psql_cmd[@]}" -c "select count(*) from public.jornada_dia where tenant_id='$tenant' and operador_id='$operador_fence' and dia='2026-09-03';")"
automaticos_vivos="$("${psql_cmd[@]}" -c "select count(*) from public.jornada_asiento a join public.jornada_dia d on d.id=a.jornada_id where d.tenant_id='$tenant' and d.operador_id='$operador_fence' and a.procedencia in ('hito_viaje','gps') and a.anulado_en is null;")"
automaticos_anulados="$("${psql_cmd[@]}" -c "select count(*) from public.jornada_asiento a join public.jornada_dia d on d.id=a.jornada_id where d.tenant_id='$tenant' and d.operador_id='$operador_fence' and a.procedencia in ('hito_viaje','gps') and a.anulado_en is not null and a.anulado_por_email='sistema:derivador-jornada@likida.internal';")"
test "$cola_fence" = '0'
test "$jornadas_fence" = '1'
test "$automaticos_vivos" = '0'
test "$automaticos_anulados" = '1'
echo "0325_jornada_fence: PASS (updater=$estado_update, cola=$cola_fence, jornada=$jornadas_fence, auto_vivos=$automaticos_vivos, auto_anulados=$automaticos_anulados)"
