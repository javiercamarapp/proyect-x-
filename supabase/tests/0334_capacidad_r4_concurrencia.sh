#!/usr/bin/env bash
# Dos primeros viajes concurrentes comparten unidad/dia. Una posicion GPS ya
# existente vuelve observable el write-skew: si ambos se creen exclusivos, las
# input_version durables no convergen con la fuente confirmada tras el commit.
set -euo pipefail

host="${1:?uso: $0 HOST PORT DB}"
port="${2:?uso: $0 HOST PORT DB}"
database="${3:?uso: $0 HOST PORT DB}"
q=(psql -h "$host" -p "$port" -U "${PGUSER:-postgres}" -d "$database" -X -v ON_ERROR_STOP=1 -qAt)
tenant='33300000-0000-4000-8000-000000000010'
op_a='33310000-0000-4000-8000-000000000010'
op_b='33310000-0000-4000-8000-000000000011'
unidad='33330000-0000-4000-8000-000000000010'
salida_a="$(mktemp /tmp/likida-0334-a.XXXXXX)"
salida_b="$(mktemp /tmp/likida-0334-b.XXXXXX)"
pid_a=''
pid_b=''

limpiar() {
  if [[ -n "$pid_a" ]]; then kill "$pid_a" 2>/dev/null || true; wait "$pid_a" 2>/dev/null || true; fi
  if [[ -n "$pid_b" ]]; then kill "$pid_b" 2>/dev/null || true; wait "$pid_b" 2>/dev/null || true; fi
  "${q[@]}" -c "drop trigger if exists zz_audit_0334_overlap on public.jornada_derivacion_invalida; drop function if exists public.audit_0334_overlap(); delete from public.tenant where id='$tenant';" >/dev/null 2>&1 || true
  rm -f "$salida_a" "$salida_b"
}
trap limpiar EXIT

"${q[@]}" -c "
delete from public.tenant where id='$tenant';
insert into public.tenant(id,nombre,zona_horaria) values('$tenant','Capacidad R4 concurrencia','UTC');
insert into public.operador(id,tenant_id,nombre,telefono,aviso_privacidad_en) values
 ('$op_a','$tenant','Operador A','529333000010','2026-01-01'),
 ('$op_b','$tenant','Operador B','529333000011','2026-01-01');
insert into public.unidad(id,tenant_id,numero_economico) values('$unidad','$tenant','R4-C');
insert into public.jornada_dia(tenant_id,operador_id,dia) values
 ('$tenant','$op_a','2026-08-01'),('$tenant','$op_b','2026-08-01');
insert into public.posicion(tenant_id,unidad_id,lat,lng,medida_en,proveedor)
 values('$tenant','$unidad',20,-89,'2026-08-01 12:00+00','r4-first-trip');
delete from public.jornada_derivacion_invalida where tenant_id='$tenant';
create function public.audit_0334_overlap() returns trigger language plpgsql set search_path='' as \$\$
begin
  if new.tenant_id='$tenant' then perform pg_catalog.pg_sleep(1); end if;
  return new;
end \$\$;
create trigger zz_audit_0334_overlap after insert or update on public.jornada_derivacion_invalida
for each row execute function public.audit_0334_overlap();"

"${q[@]}" -c "set application_name='0334-first-a'; set lock_timeout='8s'; set statement_timeout='12s'; insert into public.viaje(id,tenant_id,operador_id,unidad_id,avisado_en,aceptado_en,estatus) values('33320000-0000-4000-8000-000000000010','$tenant','$op_a','$unidad','2026-08-01 09:59+00','2026-08-01 10:00+00','abierto'); select 'a-ok';" >"$salida_a" 2>&1 &
pid_a=$!
sleep 0.15
"${q[@]}" -c "set application_name='0334-first-b'; set lock_timeout='8s'; set statement_timeout='12s'; insert into public.viaje(id,tenant_id,operador_id,unidad_id,avisado_en,aceptado_en,estatus) values('33320000-0000-4000-8000-000000000011','$tenant','$op_b','$unidad','2026-08-01 10:59+00','2026-08-01 11:00+00','abierto'); select 'b-ok';" >"$salida_b" 2>&1 &
pid_b=$!

set +e
wait "$pid_a"; estado_a=$?; pid_a=''
wait "$pid_b"; estado_b=$?; pid_b=''
set -e
if [[ "$estado_a" -ne 0 || "$estado_b" -ne 0 ]]; then
  sed -n '1,120p' "$salida_a" >&2
  sed -n '1,120p' "$salida_b" >&2
  exit 1
fi
test "$(grep -Ec '^a-ok$' "$salida_a")" = '1'
test "$(grep -Ec '^b-ok$' "$salida_b")" = '1'

divergentes="$("${q[@]}" -c "select count(*) from public.jornada_dia d where d.tenant_id='$tenant' and d.dia='2026-08-01' and d.input_version is distinct from public.calcular_input_version_jornada(d.tenant_id,d.operador_id,d.dia);")"
journal="$("${q[@]}" -c "select count(*) from public.jornada_derivacion_invalida where tenant_id='$tenant' and dia='2026-08-01';")"
if [[ "$divergentes" != '0' || "$journal" != '2' ]]; then
  echo "0334 RED: write-skew de primeros viajes+GPS (divergentes=$divergentes journal=$journal)" >&2
  exit 1
fi
echo "0334_capacidad_r4_concurrencia: PASS (primeros viajes+GPS; A=$estado_a B=$estado_b divergentes=$divergentes journal=$journal)"
