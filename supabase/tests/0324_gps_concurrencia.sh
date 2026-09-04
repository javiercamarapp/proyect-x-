#!/usr/bin/env bash
set -euo pipefail

pg_host=${1:?uso: 0324_gps_concurrencia.sh HOST PORT DB}
pg_port=${2:?uso: 0324_gps_concurrencia.sh HOST PORT DB}
pg_db=${3:?uso: 0324_gps_concurrencia.sh HOST PORT DB}
psql_cmd=(psql -h "$pg_host" -p "$pg_port" -d "$pg_db" -X -v ON_ERROR_STOP=1 -Atq)

tenant=da000000-0000-0000-0000-000000000324
unidad=db000000-0000-0000-0000-000000000324
log_a=$(mktemp /private/tmp/likida-gps-worker-a.XXXXXX)
cleanup() {
  "${psql_cmd[@]}" -c "delete from public.tenant where id = '$tenant'" >/dev/null 2>&1 || true
  rm -f "$log_a"
}
trap cleanup EXIT

"${psql_cmd[@]}" <<SQL
insert into public.tenant(id,nombre) values ('$tenant','GPS concurrencia 0324');
insert into public.conector_credencial(tenant_id,conector_id,valores_cifrados)
values ('$tenant','samsara','opaque-ciphertext');
insert into public.unidad(id,tenant_id,numero_economico)
values ('$unidad','$tenant','GPS-C');
insert into public.evento_seguridad_flota
  (tenant_id,proveedor,evento_id_externo,unidad_id,etiquetas,grave,ocurrido_en)
values ('$tenant','samsara','evt-concurrente','$unidad',array['Crash'],true,clock_timestamp());
SQL

# A mantiene abiertas las transacciones después de reclamar. B entra durante
# esa ventana: debe saltar las filas bloqueadas, nunca esperar ni duplicarlas.
"${psql_cmd[@]}" >"$log_a" <<SQL &
begin;
select 'poll-a=' || count(*) from public.reclamar_polls_conector(
  'eventos',array['samsara'],1,'worker-a',360,clock_timestamp());
select 'evento-a=' || count(*) from public.reclamar_eventos_seguridad(
  '$tenant','samsara',1,'worker-a',360,clock_timestamp());
select pg_sleep(2);
commit;
SQL
pid_a=$!
sleep 0.4

salida_b=$("${psql_cmd[@]}" <<SQL
set statement_timeout='1s';
select 'poll-b=' || count(*) from public.reclamar_polls_conector(
  'eventos',array['samsara'],1,'worker-b',360,clock_timestamp());
select 'evento-b=' || count(*) from public.reclamar_eventos_seguridad(
  '$tenant','samsara',1,'worker-b',360,clock_timestamp());
SQL
)
wait "$pid_a"

grep -q '^poll-a=1$' "$log_a"
grep -q '^evento-a=1$' "$log_a"
grep -q '^poll-b=0$' <<<"$salida_b"
grep -q '^evento-b=0$' <<<"$salida_b"
printf '%s\n' 'GREEN: dos workers no solapan poll ni choque'
