#!/usr/bin/env bash
# GPS R5: el overfetch permite progreso, pero candidatos/locks quedan O(limite).
set -euo pipefail

pg_host=${1:?uso: 0337_gps_r5_concurrencia.sh HOST PORT DB}
pg_port=${2:?uso: 0337_gps_r5_concurrencia.sh HOST PORT DB}
pg_db=${3:?uso: 0337_gps_r5_concurrencia.sh HOST PORT DB}
psql_cmd=(psql -h "$pg_host" -p "$pg_port" -d "$pg_db" -X -v ON_ERROR_STOP=1 -Atq)
outdir=$(mktemp -d /private/tmp/likida-gps-r5-conc.XXXXXX)
pid_blocker=''

limpiar_prefijo() {
  local prefijo=$1
  "${psql_cmd[@]}" -c "
    delete from public.wa_meta_receipt where wamid like 'wamid.r5.${prefijo}.%';
    delete from public.wa_outbox where dedupe_key like 'gps:r5:${prefijo}:%';" >/dev/null 2>&1 || true
}

cleanup() {
  if [[ -n "$pid_blocker" ]]; then
    kill "$pid_blocker" 2>/dev/null || true
    wait "$pid_blocker" 2>/dev/null || true
  fi
  limpiar_prefijo over
  limpiar_prefijo bound
  rm -rf "$outdir"
}
trap cleanup EXIT

preparar() {
  local prefijo=$1
  limpiar_prefijo "$prefijo"
  "${psql_cmd[@]}" -c "
    insert into public.wa_outbox(dedupe_key,payload,estado,provider_message_id,provider_status)
      select 'gps:r5:${prefijo}:'||g,'{}','sent','wamid.r5.${prefijo}.'||g,'accepted'
      from generate_series(1,401) g;
    insert into public.wa_meta_receipt(wamid,provider_status,recibido_en)
      select 'wamid.r5.${prefijo}.'||g,'delivered','2002-01-01'::timestamptz+g*interval '1 second'
      from generate_series(1,401) g;"
}

bloquear_primeros() {
  local prefijo=$1
  local cuantos=$2
  local log=$3
  "${psql_cmd[@]}" -c "
    begin;
    select pg_advisory_xact_lock(hashtextextended('wamid.r5.${prefijo}.'||g,0))
      from generate_series(1,${cuantos}) g;
    select pg_sleep(3);
    rollback;" >"$log" 2>&1 &
  pid_blocker=$!
  sleep 0.35
}

# 300 bloqueadas con limite=100: el overfetch 4x alcanza la fila 301 y deja
# procesar cien filas libres sin esperar el lock.
preparar over
bloquear_primeros over 300 "$outdir/over-blocker.log"
procesadas=$("${psql_cmd[@]}" -c "set statement_timeout='1200ms'; select public.reconciliar_wa_meta_receipts(100);")
test "$procesadas" = '100'
estado_301=$("${psql_cmd[@]}" -c "select provider_status from public.wa_outbox where provider_message_id='wamid.r5.over.301';")
test "$estado_301" = 'delivered'
wait "$pid_blocker"
pid_blocker=''
echo "0337_gps_overfetch_progreso: PASS (bloqueadas=300 limite=100 procesadas=$procesadas)"
limpiar_prefijo over

# 400 bloqueadas llenan exactamente el overfetch. La 401 no debe visitarse:
# el contrato O(limite) prima sobre escanear todo el backlog en una corrida.
preparar bound
bloquear_primeros bound 400 "$outdir/bound-blocker.log"
procesadas=$("${psql_cmd[@]}" -c "set statement_timeout='1200ms'; select public.reconciliar_wa_meta_receipts(100);")
test "$procesadas" = '0'
estado_401=$("${psql_cmd[@]}" -c "select provider_status from public.wa_outbox where provider_message_id='wamid.r5.bound.401';")
test "$estado_401" = 'accepted'
wait "$pid_blocker"
pid_blocker=''
echo "0337_gps_candidatos_acotados: PASS (candidatos=400 fila_401=$estado_401)"
