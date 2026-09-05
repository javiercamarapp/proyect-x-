#!/usr/bin/env bash
# Carga actual abierta: R5 debe decidir relevancia sin escribir journal. El
# umbral por defecto (10 s y 4 KiB WAL/fila) deja margen amplio sobre PG17 local
# pero detecta loops por fila, timeouts o amplificacion durable accidental.
set -euo pipefail
host="${1:?uso: $0 HOST PORT DB [N] [MAX_MS]}"
port="${2:?uso: $0 HOST PORT DB [N] [MAX_MS]}"
database="${3:?uso: $0 HOST PORT DB [N] [MAX_MS]}"
n="${4:-5000}"
max_ms="${5:-10000}"
case "$n" in 5000|50000) ;; *) echo 'N debe ser 5000 o 50000' >&2; exit 2 ;; esac
q=(psql -h "$host" -p "$port" -U "${PGUSER:-postgres}" -d "$database" -X -v ON_ERROR_STOP=1 -qAt)
tenant='33600000-0000-4000-8000-000000000500'
limpiar() {
  "${q[@]}" -c "delete from public.tenant where id='$tenant'" >/dev/null 2>&1 || true
}
trap limpiar EXIT

"${q[@]}" -c "delete from public.tenant where id='$tenant';
insert into public.tenant(id,nombre,zona_horaria) values('$tenant','R5 load $n','America/Tijuana');
insert into public.operador(id,tenant_id,nombre,telefono,aviso_privacidad_en)
select md5('336-load-op-'||g)::uuid,'$tenant','op'||g,'529336'||lpad(g::text,9,'0'),'2026-01-01'
from generate_series(1,$n) g;
insert into public.jornada_dia(tenant_id,operador_id,dia)
select '$tenant',md5('336-load-op-'||g)::uuid,(clock_timestamp() at time zone 'America/Tijuana')::date
from generate_series(1,$n) g;
delete from public.jornada_derivacion_invalida where tenant_id='$tenant';" >/dev/null

before="$("${q[@]}" -c 'select coalesce(wal_bytes,0) from pg_stat_wal;')"
start="$(date +%s%N)"
"${q[@]}" -c "insert into public.viaje(id,tenant_id,operador_id,avisado_en,aceptado_en,estatus)
select md5('336-load-v-'||g)::uuid,'$tenant',md5('336-load-op-'||g)::uuid,
 (((clock_timestamp() at time zone 'America/Tijuana')::date::timestamp+interval '11 hours 59 minutes') at time zone 'America/Tijuana'),
 (((clock_timestamp() at time zone 'America/Tijuana')::date::timestamp+interval '12 hours') at time zone 'America/Tijuana'),
 'liquidado' from generate_series(1,$n) g;" >/dev/null
end="$(date +%s%N)"
after="$("${q[@]}" -c 'select coalesce(wal_bytes,0) from pg_stat_wal;')"
journal="$("${q[@]}" -c "select count(*) from public.jornada_derivacion_invalida where tenant_id='$tenant';")"
ms="$(( (end-start)/1000000 ))"
wal="$(( after-before ))"
wal_per_row="$(( wal/n ))"
if (( journal != 0 || ms > max_ms || wal_per_row > 4096 )); then
  echo "0336 load FAIL: N=$n ms=$ms max_ms=$max_ms wal_bytes=$wal wal_per_row=$wal_per_row journal=$journal" >&2
  exit 1
fi
echo "0336_capacidad_r5_load: PASS N=$n ms=$ms rows_per_s=$(( n*1000/(ms+1) )) wal_bytes=$wal wal_per_row=$wal_per_row journal=$journal"
