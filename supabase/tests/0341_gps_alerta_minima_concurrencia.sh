#!/usr/bin/env bash
# Dos sesiones reales: un mínimo bloqueado no detiene los otros ni se duplica.
set -euo pipefail
pg_host=${1:?uso: 0341_gps_alerta_minima_concurrencia.sh HOST PORT DB}
pg_port=${2:?uso: 0341_gps_alerta_minima_concurrencia.sh HOST PORT DB}
pg_db=${3:?uso: 0341_gps_alerta_minima_concurrencia.sh HOST PORT DB}
psql_cmd=(psql -h "$pg_host" -p "$pg_port" -d "$pg_db" -X -v ON_ERROR_STOP=1 -Atq)
outdir=$(mktemp -d)
pid_a=''
tenant='34100000-0000-4000-8000-000000000099'
cleanup() {
  if [[ -n "$pid_a" ]]; then kill "$pid_a" 2>/dev/null || true; wait "$pid_a" 2>/dev/null || true; fi
  "${psql_cmd[@]}" -c "delete from public.tenant where id='$tenant';" >/dev/null
  rm -rf "$outdir"
}
trap cleanup EXIT
"${psql_cmd[@]}" -c "
insert into public.tenant(id,nombre) values('$tenant','GPS341 concurrencia sintética');
insert into public.unidad(id,tenant_id,numero_economico) values('$tenant','$tenant','MIN-CONC');
insert into public.evento_seguridad_flota(tenant_id,proveedor,evento_id_externo,unidad_id,grave,ocurrido_en,privacidad_minima)
select '$tenant','samsara','min-'||g,'$tenant',true,'2026-09-05T15:00:00Z',true from generate_series(1,3)g;"
"${psql_cmd[@]}" -c "begin;
select evento_id_externo from public.reclamar_eventos_seguridad('$tenant','samsara',1,'worker-a',360,'2026-09-05T16:00:00Z');
select pg_sleep(2); commit;" >"$outdir/a.log" 2>&1 &
pid_a=$!
# Esperar evidencia del lease en la sesión A, no asumir que un sleep lo creó.
ready=false
for _ in $(seq 1 100); do
  if grep -q '^min-' "$outdir/a.log"; then ready=true; break; fi
  sleep 0.02
done
[ "$ready" = true ] || { echo 'No arrancó el claim A'; exit 1; }
"${psql_cmd[@]}" -c "set statement_timeout='1s';
select evento_id_externo from public.reclamar_eventos_seguridad('$tenant','samsara',3,'worker-b',360,'2026-09-05T16:00:00Z');" >"$outdir/b.log"
wait "$pid_a"
pid_a=''
[ "$(grep -c '^min-' "$outdir/a.log")" = 1 ]
[ "$(grep -c '^min-' "$outdir/b.log")" = 2 ]
[ "$(cat "$outdir/a.log" "$outdir/b.log" | grep '^min-' | sort -u | wc -l | tr -d ' ')" = 3 ]
[ "$("${psql_cmd[@]}" -c "select count(*) from public.evento_seguridad_flota where tenant_id='$tenant' and claim_token is not null and intentos=1;")" = 3 ]
echo '0341_gps_alerta_minima_concurrencia: PASS (3 mínimos, sin solape ni espera por fila bloqueada)'
