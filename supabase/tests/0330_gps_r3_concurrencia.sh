#!/usr/bin/env bash
# Prueba local desechable con sesiones PostgreSQL reales. Verifica el orden
# global advisory(wamid) -> row(outbox) y que la purga salte filas bloqueadas.
set -euo pipefail

pg_host=${1:?uso: 0330_gps_r3_concurrencia.sh HOST PORT DB}
pg_port=${2:?uso: 0330_gps_r3_concurrencia.sh HOST PORT DB}
pg_db=${3:?uso: 0330_gps_r3_concurrencia.sh HOST PORT DB}
psql_cmd=(psql -h "$pg_host" -p "$pg_port" -d "$pg_db" -X -v ON_ERROR_STOP=1 -Atq)
outdir=$(mktemp -d /private/tmp/likida-gps-r3-conc.XXXXXX)
out_blocker="$outdir/blocker.log"
out_finalizer="$outdir/finalizer.log"
out_receipt="$outdir/receipt.log"
out_purge_lock="$outdir/purge-lock.log"
out_purge="$outdir/purge.log"
pid_blocker=''
pid_finalizer=''
pid_receipt=''
pid_purge_lock=''
pid_purge=''
outbox_id='33000000-0000-4000-8000-000000000030'
token='33000000-0000-4000-8000-000000000031'
wamid='wamid.r3.concurrente'

cleanup() {
  for pid in "$pid_blocker" "$pid_finalizer" "$pid_receipt" "$pid_purge_lock" "$pid_purge"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  done
  "${psql_cmd[@]}" -c "set statement_timeout='5s'; delete from public.wa_meta_receipt where wamid='$wamid' or wamid like 'wamid.r3.purge.concurrente.%'; delete from public.wa_outbox where id='$outbox_id';" >/dev/null 2>&1 || true
  rm -rf "$outdir"
}
trap cleanup EXIT

"${psql_cmd[@]}" -c "delete from public.wa_meta_receipt where wamid='$wamid'; delete from public.wa_outbox where id='$outbox_id'; insert into public.wa_outbox(id,dedupe_key,payload,estado,intentos,lease_token,lease_expires_at) values ('$outbox_id','gps:r3:concurrente','{}','sending',1,'$token',clock_timestamp()+interval '1 minute');"

"${psql_cmd[@]}" -c "set application_name='0330-r3-blocker'; begin; select id from public.wa_outbox where id='$outbox_id' for update; select pg_sleep(3); commit;" >"$out_blocker" 2>&1 &
pid_blocker=$!
sleep 0.2
"${psql_cmd[@]}" -c "set application_name='0330-r3-finalizer'; set statement_timeout='8s'; select 'pid='||pg_backend_pid(); select ok||':'||muerta from public.finalizar_wa_outbox('$outbox_id','$token','$wamid',null);" >"$out_finalizer" 2>&1 &
pid_finalizer=$!
sleep 0.2
"${psql_cmd[@]}" -c "set application_name='0330-r3-receipt'; set statement_timeout='8s'; select 'pid='||pg_backend_pid(); select public.registrar_estado_wa_meta('$wamid','delivered',null,clock_timestamp());" >"$out_receipt" 2>&1 &
pid_receipt=$!
sleep 0.3

estado_finalizer=$("${psql_cmd[@]}" -F '|' -c "select state||':'||coalesce(wait_event_type,'-')||':'||coalesce(wait_event,'-') from pg_stat_activity where application_name='0330-r3-finalizer';")
estado_receipt=$("${psql_cmd[@]}" -F '|' -c "select state||':'||coalesce(wait_event_type,'-')||':'||coalesce(wait_event,'-') from pg_stat_activity where application_name='0330-r3-receipt';")
advisory_finalizer=$("${psql_cmd[@]}" -c "select count(*) from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name='0330-r3-finalizer' and l.locktype='advisory' and l.granted;")
case "$estado_finalizer" in active:Lock:*) ;; *) echo "finalizer no espera row lock: $estado_finalizer" >&2; exit 1;; esac
test "$estado_receipt" = 'active:Lock:advisory'
test "$advisory_finalizer" = '1'

if ! wait "$pid_blocker"; then cat "$out_blocker" >&2; exit 1; fi
pid_blocker=''
if ! wait "$pid_finalizer"; then cat "$out_finalizer" >&2; exit 1; fi
pid_finalizer=''
if ! wait "$pid_receipt"; then cat "$out_receipt" >&2; exit 1; fi
pid_receipt=''
grep -q '^true:false$' "$out_finalizer"
grep -q '^t$' "$out_receipt"
estado_final=$("${psql_cmd[@]}" -F '|' -c "select estado||':'||provider_status from public.wa_outbox where id='$outbox_id';")
test "$estado_final" = 'sent:delivered'
echo "0330_gps_lock_order: PASS (finalizer=$estado_finalizer receipt=$estado_receipt advisory=$advisory_finalizer final=$estado_final)"

"${psql_cmd[@]}" -c "delete from public.wa_meta_receipt where wamid like 'wamid.r3.purge.concurrente.%'; insert into public.wa_meta_receipt(wamid,provider_status,recibido_en,reconciliado_en) values ('wamid.r3.purge.concurrente.1','delivered',clock_timestamp()-interval '103 days',clock_timestamp()),('wamid.r3.purge.concurrente.2','delivered',clock_timestamp()-interval '102 days',clock_timestamp()),('wamid.r3.purge.concurrente.3','delivered',clock_timestamp()-interval '101 days',clock_timestamp());"
"${psql_cmd[@]}" -c "set application_name='0330-r3-purge-lock'; begin; select wamid from public.wa_meta_receipt where wamid='wamid.r3.purge.concurrente.1' for update; select pg_sleep(2); commit;" >"$out_purge_lock" 2>&1 &
pid_purge_lock=$!
sleep 0.2
"${psql_cmd[@]}" -c "set application_name='0330-r3-purge'; set statement_timeout='1s'; select 'pid='||pg_backend_pid(); select public.purgar_wa_meta_receipts(2);" >"$out_purge" 2>&1 &
pid_purge=$!
if ! wait "$pid_purge"; then cat "$out_purge" >&2; exit 1; fi
pid_purge=''
pid_purge_db=$(sed -n 's/^pid=//p' "$out_purge")
test -n "$pid_purge_db"
grep -q '^2$' "$out_purge"
restantes=$("${psql_cmd[@]}" -c "select count(*) from public.wa_meta_receipt where wamid like 'wamid.r3.purge.concurrente.%';")
test "$restantes" = '1'
if ! wait "$pid_purge_lock"; then cat "$out_purge_lock" >&2; exit 1; fi
pid_purge_lock=''
echo "0330_gps_purga_skip_locked: PASS (purger_pid=$pid_purge_db borradas=2 restantes=$restantes)"
