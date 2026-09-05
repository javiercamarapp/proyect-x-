#!/usr/bin/env bash
set -euo pipefail

h="${1:?HOST}"; p="${2:?PORT}"; d="${3:?DB}"
q=(psql -h "$h" -p "$p" -U "${PGUSER:-postgres}" -d "$d" -X -v ON_ERROR_STOP=1 -qAt)
t='32900000-0000-4000-8000-000000000002'
op_a='32910000-0000-4000-8000-000000000001'
op_b='32910000-0000-4000-8000-000000000002'
u_1='32930000-0000-4000-8000-000000000001'
u_2='32930000-0000-4000-8000-000000000002'
salida_a="$(mktemp /tmp/likida-0329-a.XXXXXX)"
salida_b="$(mktemp /tmp/likida-0329-b.XXXXXX)"
pid_a=''; pid_b=''

limpiar() {
  if [[ -n "$pid_a" ]]; then kill "$pid_a" 2>/dev/null || true; wait "$pid_a" 2>/dev/null || true; fi
  if [[ -n "$pid_b" ]]; then kill "$pid_b" 2>/dev/null || true; wait "$pid_b" 2>/dev/null || true; fi
  "${q[@]}" -c "drop trigger if exists audit_0331_interleaving on public.jornada_derivacion_invalida; drop function if exists public.audit_0331_interleaving(); delete from public.tenant where id='$t';" >/dev/null 2>&1 || true
  rm -f "$salida_a" "$salida_b"
}
trap limpiar EXIT

"${q[@]}" -c "
drop trigger if exists audit_0331_interleaving on public.jornada_derivacion_invalida;
drop function if exists public.audit_0331_interleaving();
delete from public.tenant where id='$t';
insert into public.tenant(id,nombre,zona_horaria) values('$t','shared unit 0331','UTC');
insert into public.operador(id,tenant_id,nombre,telefono,aviso_privacidad_en) values
 ('$op_a','$t','A','529329000001','2026-01-01'),('$op_b','$t','B','529329000002','2026-01-01');
insert into public.unidad(id,tenant_id,numero_economico) values('$u_1','$t','U1'),('$u_2','$t','U2');
insert into public.viaje(id,tenant_id,operador_id,unidad_id,avisado_en,aceptado_en,estatus) values
 ('32920000-0000-4000-8000-000000000001','$t','$op_a','$u_1','2026-08-02 00:00+00','2026-08-02 01:00+00','liquidado'),
 ('32920000-0000-4000-8000-000000000002','$t','$op_a','$u_2','2026-08-01 00:00+00','2026-08-01 01:00+00','liquidado'),
 ('32920000-0000-4000-8000-000000000003','$t','$op_a','$u_1','2026-08-01 02:00+00','2026-08-01 03:00+00','liquidado'),
 ('32920000-0000-4000-8000-000000000004','$t','$op_a','$u_2','2026-08-02 02:00+00','2026-08-02 03:00+00','liquidado'),
 ('32920000-0000-4000-8000-000000000005','$t','$op_b','$u_1','2026-08-01 04:00+00','2026-08-01 05:00+00','liquidado'),
 ('32920000-0000-4000-8000-000000000006','$t','$op_b','$u_1','2026-08-02 04:00+00','2026-08-02 05:00+00','liquidado'),
 ('32920000-0000-4000-8000-000000000007','$t','$op_b','$u_2','2026-08-01 06:00+00','2026-08-01 07:00+00','liquidado'),
 ('32920000-0000-4000-8000-000000000008','$t','$op_b','$u_2','2026-08-02 06:00+00','2026-08-02 07:00+00','liquidado');
insert into public.posicion(id,tenant_id,unidad_id,lat,lng,medida_en,proveedor) values
 (329400000001,'$t','$u_1',20,-89,'2026-08-02 08:00+00','0331-lock'),
 (329400000002,'$t','$u_2',20,-89,'2026-08-01 08:00+00','0331-lock'),
 (329400000003,'$t','$u_1',20,-89,'2026-08-01 09:00+00','0331-lock'),
 (329400000004,'$t','$u_2',20,-89,'2026-08-02 09:00+00','0331-lock');
create function public.audit_0331_interleaving() returns trigger language plpgsql set search_path='' as \$\$
begin
  if new.tenant_id='$t' then perform pg_catalog.pg_sleep(0.35); end if;
  return new;
end \$\$;
create trigger audit_0331_interleaving after insert or update on public.jornada_derivacion_invalida
for each row execute function public.audit_0331_interleaving();"

# Estos dos lotes tocan las mismas cuatro claves (A/B × día 1/2). La versión
# antigua las adquiría U1/día2→U2/día1 contra U1/día1→U2/día2; el trigger de
# sueño vuelve determinista ese interleaving. 0331 debe ordenarlas por la llave.
"${q[@]}" -c "set application_name='0331-lock-a'; set deadlock_timeout='200ms'; set lock_timeout='8s'; set statement_timeout='12s'; update public.viaje set aceptado_en=aceptado_en+interval '1 second' where id in ('32920000-0000-4000-8000-000000000001','32920000-0000-4000-8000-000000000002'); select 'fase1-a-ok';" >"$salida_a" 2>&1 &
pid_a=$!
"${q[@]}" -c "set application_name='0331-lock-b'; set deadlock_timeout='200ms'; set lock_timeout='8s'; set statement_timeout='12s'; update public.viaje set aceptado_en=aceptado_en+interval '1 second' where id in ('32920000-0000-4000-8000-000000000003','32920000-0000-4000-8000-000000000004'); select 'fase1-b-ok';" >"$salida_b" 2>&1 &
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
test "$(grep -c '^fase1-a-ok$' "$salida_a")" -eq 1
test "$(grep -c '^fase1-b-ok$' "$salida_b")" -eq 1

# Swap real simultáneo de unidades en dos días. Los PIDs se esperan por separado:
# cualquier 40P01/timeout de cualquiera de los dos procesos hace fallar el shell.
"${q[@]}" -c "set application_name='0331-swap-a'; set deadlock_timeout='200ms'; set lock_timeout='8s'; set statement_timeout='12s'; update public.viaje set unidad_id=case id when '32920000-0000-4000-8000-000000000001' then '$u_2'::uuid else '$u_1'::uuid end where id in ('32920000-0000-4000-8000-000000000001','32920000-0000-4000-8000-000000000002'); select 'swap-a-ok';" >"$salida_a" 2>&1 &
pid_a=$!
"${q[@]}" -c "set application_name='0331-swap-b'; set deadlock_timeout='200ms'; set lock_timeout='8s'; set statement_timeout='12s'; update public.viaje set unidad_id=case id when '32920000-0000-4000-8000-000000000003' then '$u_2'::uuid else '$u_1'::uuid end where id in ('32920000-0000-4000-8000-000000000003','32920000-0000-4000-8000-000000000004'); select 'swap-b-ok';" >"$salida_b" 2>&1 &
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
test "$(grep -c '^swap-a-ok$' "$salida_a")" -eq 1
test "$(grep -c '^swap-b-ok$' "$salida_b")" -eq 1

# El mismo patrón inverso debe ser seguro para lotes GPS; 0329 ya tenía tablas
# de transición, pero todavía expandía por unidad antes de adquirir cada clave.
"${q[@]}" -c "set application_name='0331-pos-a'; set deadlock_timeout='200ms'; set lock_timeout='8s'; set statement_timeout='12s'; update public.posicion set medida_en=medida_en+interval '1 second' where id in (329400000001,329400000002); select 'pos-a-ok';" >"$salida_a" 2>&1 &
pid_a=$!
"${q[@]}" -c "set application_name='0331-pos-b'; set deadlock_timeout='200ms'; set lock_timeout='8s'; set statement_timeout='12s'; update public.posicion set medida_en=medida_en+interval '1 second' where id in (329400000003,329400000004); select 'pos-b-ok';" >"$salida_b" 2>&1 &
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
test "$(grep -c '^pos-a-ok$' "$salida_a")" -eq 1
test "$(grep -c '^pos-b-ok$' "$salida_b")" -eq 1

journal="$("${q[@]}" -c "select count(*) from public.jornada_derivacion_invalida where tenant_id='$t';")"
swaps="$("${q[@]}" -c "select count(*) from public.viaje where tenant_id='$t' and id in ('32920000-0000-4000-8000-000000000001','32920000-0000-4000-8000-000000000003') and unidad_id='$u_2';")"
posiciones="$("${q[@]}" -c "select count(*) from public.posicion where tenant_id='$t' and proveedor='0331-lock' and extract(second from medida_en)=1;")"
test "$journal" = '4'
test "$swaps" = '2'
test "$posiciones" = '4'
echo "0329_shared_unit_no_deadlock: PASS (viaje inverso + swap + GPS inverso; A=$estado_a B=$estado_b journal=$journal swaps=$swaps posiciones=$posiciones)"
