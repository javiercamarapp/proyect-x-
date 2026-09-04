#!/usr/bin/env bash
# Prueba PostgreSQL real de las dos carreras que no puede simular Vitest:
# 1) duplicado B espera a A; si A hace ROLLBACK, B se vuelve dueño y aplica;
# 2) eventos distintos del mismo prospecto se serializan y reevalúan estado.
set -euo pipefail

host="${1:?uso: $0 HOST PORT DB}"
port="${2:?uso: $0 HOST PORT DB}"
database="${3:?uso: $0 HOST PORT DB}"
prospecto='32300000-0000-4000-8000-000000000002'
psql_cmd=(psql -h "$host" -p "$port" -d "$database" -X -v ON_ERROR_STOP=1 -q)

limpiar() {
  "${psql_cmd[@]}" -c "delete from public.comercial_evento where prospecto_id = '$prospecto'; delete from public.prospecto where id = '$prospecto';" >/dev/null
}
trap limpiar EXIT

limpiar
"${psql_cmd[@]}" -c "insert into public.prospecto(id,empresa,correo,estado) values('$prospecto','Prueba concurrencia 0323','calcom-concurrente@example.test','contactado');"

# A reclama y aplica dentro de una transacción que finalmente falla. B usa la
# misma clave: el índice único lo hace esperar y, tras el rollback, B inserta.
"${psql_cmd[@]}" -c "begin; select resultado from public.aplicar_evento_calcom_tx('calcom:BOOKING_CREATED:DUP-CONC','BOOKING_CREATED','DUP-CONC','$prospecto','{}',null,null); select pg_sleep(1); rollback;" &
pid_a=$!
sleep 0.2
resultado_b=$("${psql_cmd[@]}" -At -c "select resultado from public.aplicar_evento_calcom_tx('calcom:BOOKING_CREATED:DUP-CONC','BOOKING_CREATED','DUP-CONC','$prospecto','{}',null,null);")
wait "$pid_a"
test "$resultado_b" = 'aplicado'
"${psql_cmd[@]}" -c "do \$\$ begin if (select count(*) from public.comercial_evento where clave_idempotencia='calcom:BOOKING_CREATED:DUP-CONC' and estado_proceso='aplicado') <> 1 then raise exception 'duplicado perdido o doble'; end if; if not exists(select 1 from public.prospecto where id='$prospecto' and estado='appointment' and calcom_booking_id='DUP-CONC') then raise exception 'B no aplicó después del rollback de A'; end if; end \$\$;"

# A aplica CREATED(10) y conserva el lock del prospecto. B registra
# CANCELLED(12), espera, y al obtener el lock ve el booking vigente de A.
"${psql_cmd[@]}" -c "delete from public.comercial_evento where prospecto_id='$prospecto'; update public.prospecto set estado='contactado',calcom_booking_id=null,calcom_evento_en=null,calcom_evento_precedencia=null where id='$prospecto';"
"${psql_cmd[@]}" -c "begin; select resultado from public.aplicar_evento_calcom_tx('calcom:BOOKING_CREATED:AB','BOOKING_CREATED','AB','$prospecto','{}','2026-08-20 10:00:00+00',null); select pg_sleep(1); commit;" &
pid_creado=$!
sleep 0.2
resultado_cancelado=$("${psql_cmd[@]}" -At -c "select resultado from public.aplicar_evento_calcom_tx('calcom:BOOKING_CANCELLED:AB','BOOKING_CANCELLED','AB','$prospecto','{}','2026-08-20 12:00:00+00',null);")
wait "$pid_creado"
test "$resultado_cancelado" = 'aplicado'
"${psql_cmd[@]}" -c "do \$\$ begin if not exists(select 1 from public.prospecto where id='$prospecto' and estado='cancelled' and calcom_booking_id='AB' and calcom_evento_en='2026-08-20 12:00:00+00') then raise exception 'carrera A/B terminó en estado incorrecto'; end if; end \$\$;"

echo '0323_calcom_concurrencia: PASS'
