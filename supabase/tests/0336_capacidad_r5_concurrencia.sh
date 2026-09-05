#!/usr/bin/env bash
# Dos primeros viajes del dia actual comparten unidad y GPS. Ambos expedientes
# estan sellados: deben serializarse y converger sin write-skew.
set -euo pipefail

host="${1:?uso: $0 HOST PORT DB}"
port="${2:?uso: $0 HOST PORT DB}"
database="${3:?uso: $0 HOST PORT DB}"
q=(psql -h "$host" -p "$port" -U "${PGUSER:-postgres}" -d "$database" -X -v ON_ERROR_STOP=1 -qAt)
tenant='33600000-0000-4000-8000-000000000010'
op_a='33610000-0000-4000-8000-000000000010'
op_b='33610000-0000-4000-8000-000000000011'
unidad='33630000-0000-4000-8000-000000000010'
salida_a="$(mktemp /tmp/likida-0336-a.XXXXXX)"
salida_b="$(mktemp /tmp/likida-0336-b.XXXXXX)"
pid_a=''; pid_b=''

limpiar() {
  if [[ -n "$pid_a" ]]; then kill "$pid_a" 2>/dev/null || true; wait "$pid_a" 2>/dev/null || true; fi
  if [[ -n "$pid_b" ]]; then kill "$pid_b" 2>/dev/null || true; wait "$pid_b" 2>/dev/null || true; fi
  "${q[@]}" -c "drop trigger if exists zz_audit_0336_overlap on public.jornada_derivacion_invalida; drop function if exists public.audit_0336_overlap(); delete from public.tenant where id='$tenant';" >/dev/null 2>&1 || true
  rm -f "$salida_a" "$salida_b"
}
trap limpiar EXIT

"${q[@]}" -c "
delete from public.tenant where id='$tenant';
insert into public.tenant(id,nombre,zona_horaria) values('$tenant','Capacidad R5 actual concurrente','UTC');
insert into public.operador(id,tenant_id,nombre,telefono,aviso_privacidad_en) values
 ('$op_a','$tenant','Operador A','529336000010','2026-01-01'),
 ('$op_b','$tenant','Operador B','529336000011','2026-01-01');
insert into public.unidad(id,tenant_id,numero_economico) values('$unidad','$tenant','R5-C');
insert into public.posicion(tenant_id,unidad_id,lat,lng,medida_en,proveedor)
 values('$tenant','$unidad',20,-89,(((clock_timestamp() at time zone 'UTC')::date::timestamp+interval '12 hours') at time zone 'UTC'),'r5-current-first');
insert into public.jornada_dia(tenant_id,operador_id,dia,estado,cerrado_en,cerrado_por_email) values
 ('$tenant','$op_a',(clock_timestamp() at time zone 'UTC')::date,'cerrado',clock_timestamp(),'a@r5.test'),
 ('$tenant','$op_b',(clock_timestamp() at time zone 'UTC')::date,'cerrado',clock_timestamp(),'b@r5.test');
delete from public.jornada_derivacion_invalida where tenant_id='$tenant';
create function public.audit_0336_overlap() returns trigger language plpgsql set search_path='' as \$\$
begin
  if new.tenant_id='$tenant' then perform pg_catalog.pg_sleep(1); end if;
  return new;
end \$\$;
create trigger zz_audit_0336_overlap after insert or update on public.jornada_derivacion_invalida
for each row execute function public.audit_0336_overlap();"

"${q[@]}" -c "set application_name='0336-current-a'; set lock_timeout='8s'; set statement_timeout='12s'; insert into public.viaje(id,tenant_id,operador_id,unidad_id,avisado_en,aceptado_en,estatus) values('33620000-0000-4000-8000-000000000010','$tenant','$op_a','$unidad',(((clock_timestamp() at time zone 'UTC')::date::timestamp+interval '9 hours 59 minutes') at time zone 'UTC'),(((clock_timestamp() at time zone 'UTC')::date::timestamp+interval '10 hours') at time zone 'UTC'),'liquidado'); select 'a-ok';" >"$salida_a" 2>&1 &
pid_a=$!
sleep 0.15
"${q[@]}" -c "set application_name='0336-current-b'; set lock_timeout='8s'; set statement_timeout='12s'; insert into public.viaje(id,tenant_id,operador_id,unidad_id,avisado_en,aceptado_en,estatus) values('33620000-0000-4000-8000-000000000011','$tenant','$op_b','$unidad',(((clock_timestamp() at time zone 'UTC')::date::timestamp+interval '10 hours 59 minutes') at time zone 'UTC'),(((clock_timestamp() at time zone 'UTC')::date::timestamp+interval '11 hours') at time zone 'UTC'),'liquidado'); select 'b-ok';" >"$salida_b" 2>&1 &
pid_b=$!

set +e
wait "$pid_a"; estado_a=$?; pid_a=''
wait "$pid_b"; estado_b=$?; pid_b=''
set -e
if [[ "$estado_a" -ne 0 || "$estado_b" -ne 0 ]]; then
  sed -n '1,120p' "$salida_a" >&2; sed -n '1,120p' "$salida_b" >&2; exit 1
fi
test "$(grep -Ec '^a-ok$' "$salida_a")" = '1'
test "$(grep -Ec '^b-ok$' "$salida_b")" = '1'

read -r divergentes cerradas historial journal <<<"$("${q[@]}" -F ' ' -c "select count(*) filter(where d.input_version is distinct from public.calcular_input_version_jornada(d.tenant_id,d.operador_id,d.dia)),count(*) filter(where d.estado='cerrado'),(select count(*) from public.jornada_revision_historial h where h.tenant_id='$tenant'),(select count(*) from public.jornada_derivacion_invalida i where i.tenant_id='$tenant') from public.jornada_dia d where d.tenant_id='$tenant';")"
if [[ "$divergentes" != 0 || "$cerradas" != 0 || "$historial" != 2 || "$journal" != 2 ]]; then
  echo "0336 RED: current-day write-skew (divergentes=$divergentes cerradas=$cerradas historial=$historial journal=$journal)" >&2
  exit 1
fi
echo "0336_capacidad_r5_concurrencia: PASS (A=$estado_a B=$estado_b divergentes=$divergentes cerradas=$cerradas historial=$historial journal=$journal)"
