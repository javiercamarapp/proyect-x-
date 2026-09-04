#!/usr/bin/env bash
set -euo pipefail
host="${1:?HOST}"; port="${2:?PORT}"; database="${3:?DB}"; n="${4:-50000}"
test "$n" = 50000
p=(psql -h "$host" -p "$port" -d "$database" -U "${PGUSER:-postgres}" -X -v ON_ERROR_STOP=1 -qAt)
t=32900000-0000-0000-0000-000000000001
trap '"${p[@]}" -c "delete from public.tenant where id=\x27$t\x27" >/dev/null 2>&1 || true' EXIT
"${p[@]}" -c "delete from public.tenant where id='$t'; insert into public.tenant(id,nombre,zona_horaria) values('$t','GPS set based 0329','America/Mexico_City'); insert into public.operador(id,tenant_id,nombre,telefono,aviso_privacidad_en) select md5('329-op-'||g)::uuid,'$t','op'||g,'529329'||lpad(g::text,8,'0'),'2026-01-01' from generate_series(1,5000) g; insert into public.unidad(id,tenant_id,numero_economico) select md5('329-u-'||g)::uuid,'$t','u'||g from generate_series(1,5000) g; insert into public.viaje(id,tenant_id,operador_id,unidad_id,avisado_en,aceptado_en) select md5('329-v-'||g)::uuid,'$t',md5('329-op-'||g)::uuid,md5('329-u-'||g)::uuid,'2026-09-01 11:59+00','2026-09-01 12:00+00' from generate_series(1,5000) g;"
"${p[@]}" -c "delete from public.jornada_derivacion_invalida where tenant_id='$t';"
b=$("${p[@]}" -c 'select wal_bytes from pg_stat_wal;'); s=$(date +%s%N)
"${p[@]}" -c "insert into public.posicion(tenant_id,unidad_id,lat,lng,medida_en,proveedor) select '$t',md5('329-u-'||(g%5000+1))::uuid,20,-89,'2026-09-01 10:00:00+00'::timestamptz+make_interval(secs=>g),'0329-load' from generate_series(1,50000) g;" >/dev/null
e=$(date +%s%N); a=$("${p[@]}" -c 'select wal_bytes from pg_stat_wal;'); c=$("${p[@]}" -c "select count(*) from public.jornada_derivacion_invalida where tenant_id='$t';")
awk -v n="$n" -v s="$s" -v e="$e" -v b="$b" -v a="$a" -v c="$c" 'BEGIN{ms=(e-s)/1000000; printf "0329_gps_load: N=%d ms=%.3f points_per_s=%.3f wal_bytes=%d invalidations=%d\n",n,ms,n/(ms/1000),a-b,c; if(c>5000) exit 1}'
