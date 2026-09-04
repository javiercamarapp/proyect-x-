#!/usr/bin/env bash
# Una fila del outbox bloqueada no puede detener la reconciliación de las demás.
set -euo pipefail

pg_host=${1:?uso: 0333_gps_r4_concurrencia.sh HOST PORT DB}
pg_port=${2:?uso: 0333_gps_r4_concurrencia.sh HOST PORT DB}
pg_db=${3:?uso: 0333_gps_r4_concurrencia.sh HOST PORT DB}
psql_cmd=(psql -h "$pg_host" -p "$pg_port" -d "$pg_db" -X -v ON_ERROR_STOP=1 -Atq)
outdir=$(mktemp -d /private/tmp/likida-gps-r4-conc.XXXXXX)
blocker_log="$outdir/blocker.log"
reconciler_log="$outdir/reconciler.log"
starve_blocker_log="$outdir/starve-blocker.log"
starve_reconciler_log="$outdir/starve-reconciler.log"
pid_blocker=''
pid_starve_blocker=''

cleanup() {
  if [[ -n "$pid_blocker" ]]; then kill "$pid_blocker" 2>/dev/null || true; wait "$pid_blocker" 2>/dev/null || true; fi
  if [[ -n "$pid_starve_blocker" ]]; then kill "$pid_starve_blocker" 2>/dev/null || true; wait "$pid_starve_blocker" 2>/dev/null || true; fi
  "${psql_cmd[@]}" -c "delete from public.wa_meta_receipt where wamid like 'wamid.r4.hol.%'; delete from public.wa_outbox where id in ('33300000-0000-4000-8000-000000000010','33300000-0000-4000-8000-000000000011');" >/dev/null 2>&1 || true
  "${psql_cmd[@]}" -c "delete from public.wa_meta_receipt where wamid like 'wamid.r4.starve.%'; delete from public.wa_outbox where id in ('33300000-0000-4000-8000-000000000020','33300000-0000-4000-8000-000000000021','33300000-0000-4000-8000-000000000022');" >/dev/null 2>&1 || true
  rm -rf "$outdir"
}
trap cleanup EXIT

"${psql_cmd[@]}" -c "
  delete from public.wa_meta_receipt where wamid like 'wamid.r4.hol.%';
  delete from public.wa_outbox where id in ('33300000-0000-4000-8000-000000000010','33300000-0000-4000-8000-000000000011');
  insert into public.wa_outbox(id,dedupe_key,payload,estado,provider_message_id,provider_status) values
    ('33300000-0000-4000-8000-000000000010','gps:r4:hol:1','{}','sent','wamid.r4.hol.1','accepted'),
    ('33300000-0000-4000-8000-000000000011','gps:r4:hol:2','{}','sent','wamid.r4.hol.2','accepted');
  insert into public.wa_meta_receipt(wamid,provider_status,recibido_en) values
    ('wamid.r4.hol.1','delivered','2026-09-04T15:00:00Z'),
    ('wamid.r4.hol.2','delivered','2026-09-04T15:00:01Z');"

"${psql_cmd[@]}" -c "set application_name='0333-r4-blocker'; begin; select id from public.wa_outbox where id='33300000-0000-4000-8000-000000000010' for update; select pg_sleep(3); rollback;" >"$blocker_log" 2>&1 &
pid_blocker=$!
sleep 0.2

set +e
"${psql_cmd[@]}" -c "set statement_timeout='800ms'; select public.reconciliar_wa_meta_receipts(2);" >"$reconciler_log" 2>&1
status=$?
set -e
if [[ "$status" -ne 0 ]]; then cat "$reconciler_log" >&2; exit 1; fi
grep -q '^1$' "$reconciler_log"
estado_libre=$("${psql_cmd[@]}" -c "select provider_status from public.wa_outbox where id='33300000-0000-4000-8000-000000000011';")
test "$estado_libre" = 'delivered'

wait "$pid_blocker"
pid_blocker=''
echo "0333_gps_reconciliador_skip_locked: PASS (reconciliadas=1 libre=$estado_libre)"
"${psql_cmd[@]}" -c "delete from public.wa_meta_receipt where wamid like 'wamid.r4.hol.%'; delete from public.wa_outbox where id in ('33300000-0000-4000-8000-000000000010','33300000-0000-4000-8000-000000000011');"

# Dos advisory locks ocupados llenan por sí solos p_limite=2. La tercera fila
# libre debe progresar igual; limitar candidatos ANTES de try-lock la inaniza.
"${psql_cmd[@]}" -c "
  delete from public.wa_meta_receipt where wamid like 'wamid.r4.starve.%';
  delete from public.wa_outbox where id in ('33300000-0000-4000-8000-000000000020','33300000-0000-4000-8000-000000000021','33300000-0000-4000-8000-000000000022');
  insert into public.wa_outbox(id,dedupe_key,payload,estado,provider_message_id,provider_status) values
    ('33300000-0000-4000-8000-000000000020','gps:r4:starve:1','{}','sent','wamid.r4.starve.1','accepted'),
    ('33300000-0000-4000-8000-000000000021','gps:r4:starve:2','{}','sent','wamid.r4.starve.2','accepted'),
    ('33300000-0000-4000-8000-000000000022','gps:r4:starve:3','{}','sent','wamid.r4.starve.3','accepted');
  insert into public.wa_meta_receipt(wamid,provider_status,recibido_en) values
    ('wamid.r4.starve.1','delivered','2026-09-04T16:00:00Z'),
    ('wamid.r4.starve.2','delivered','2026-09-04T16:00:01Z'),
    ('wamid.r4.starve.3','delivered','2026-09-04T16:00:02Z');"

"${psql_cmd[@]}" -c "set application_name='0333-r4-starve-blocker'; begin; select pg_advisory_xact_lock(hashtextextended(w,0)) from (values ('wamid.r4.starve.1'),('wamid.r4.starve.2')) t(w); select pg_sleep(3); rollback;" >"$starve_blocker_log" 2>&1 &
pid_starve_blocker=$!
sleep 0.2

"${psql_cmd[@]}" -c "set statement_timeout='800ms'; select public.reconciliar_wa_meta_receipts(2);" >"$starve_reconciler_log" 2>&1
grep -q '^1$' "$starve_reconciler_log"
estado_starve_libre=$("${psql_cmd[@]}" -c "select provider_status from public.wa_outbox where id='33300000-0000-4000-8000-000000000022';")
test "$estado_starve_libre" = 'delivered'

wait "$pid_starve_blocker"
pid_starve_blocker=''
echo "0333_gps_reconciliador_sin_inanicion: PASS (ocupadas=2 limite=2 libre=$estado_starve_libre)"
