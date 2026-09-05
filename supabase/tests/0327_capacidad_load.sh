#!/usr/bin/env bash
# Arnés reproducible 5k/50k: registra tiempo, WAL y throughput; no inventa
# umbral PASS/RED cuando el hardware o shared_buffers cambian.
set -euo pipefail
host="${1:?uso: $0 HOST PORT DB [N]}"
port="${2:?uso: $0 HOST PORT DB [N]}"
database="${3:?uso: $0 HOST PORT DB [N]}"
n="${4:-5000}"
case "$n" in 5000|50000) ;; *) echo 'N debe ser 5000 o 50000' >&2; exit 2 ;; esac
psql_cmd=(psql -h "$host" -p "$port" -d "$database" -X -v ON_ERROR_STOP=1 -qAt)
tenant='32700000-0000-4000-8000-000000000500'
trap '"${psql_cmd[@]}" -c "delete from public.tenant where id=\x27$tenant\x27;" >/dev/null 2>&1 || true' EXIT
"${psql_cmd[@]}" -c "delete from public.tenant where id='$tenant'; insert into public.tenant(id,nombre,zona_horaria) values('$tenant','R2 load $n','America/Mexico_City'); insert into public.operador(id,tenant_id,nombre,telefono,aviso_privacidad_en) select md5('327-op-'||g)::uuid,'$tenant','op'||g,'52327'||lpad(g::text,10,'0'),'2026-01-01' from generate_series(1,$n) g; insert into public.viaje(id,tenant_id,operador_id,avisado_en,aceptado_en) select md5('327-v-'||g)::uuid,'$tenant',md5('327-op-'||g)::uuid,'2026-09-03 11:59+00','2026-09-03 12:00+00' from generate_series(1,$n) g;"
before="$(${psql_cmd[@]} -c 'select coalesce(wal_bytes,0) from pg_stat_wal;')"
start="$(date +%s%N)"
"${psql_cmd[@]}" -c "select public.sincronizar_jornadas_por_derivar('2026-09-03 18:00+00',1);" >/dev/null
end="$(date +%s%N)"
after="$(${psql_cmd[@]} -c 'select coalesce(wal_bytes,0) from pg_stat_wal;')"
awk -v n="$n" -v s="$start" -v e="$end" -v b="$before" -v a="$after" 'BEGIN {ms=(e-s)/1000000; printf "0327_load: N=%d ms=%.3f jobs_per_s=%.3f wal_bytes=%d\n",n,ms,n/(ms/1000),a-b}'
