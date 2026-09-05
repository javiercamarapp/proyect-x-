#!/usr/bin/env bash
# Prueba PostgreSQL real de las carreras que no puede simular Vitest:
# 1) duplicado B espera a A; si A hace ROLLBACK, B se vuelve dueño y aplica;
# 2) eventos distintos del mismo prospecto se serializan y reevalúan estado.
# 3) reentrega (evento→prospecto) contra enlazador (prospecto→drenaje) no
#    forma un deadlock 40P01 y el ledger converge.
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

# Contrato oficial y entrega invertida real: CANCELLED de la reserva nueva B
# toma primero el lock y queda esperando; RESCHEDULED A→B debe esperar el
# commit, enlazar por rescheduleUid y drenar la cancelación posterior.
"${psql_cmd[@]}" -c "delete from public.comercial_evento where prospecto_id='$prospecto'; update public.prospecto set estado='contactado',calcom_booking_id=null,calcom_booking_aliases='{}',calcom_evento_en=null,calcom_evento_precedencia=null,calcom_estado_antes_no_show=null where id='$prospecto'; select resultado from public.aplicar_evento_calcom_tx('calcom:CONC:CREATED:A','BOOKING_CREATED','uid:A','$prospecto','{}','2026-08-21 10:00:00+00',null,array['uid:A','id:200'],'{}',null);"
"${psql_cmd[@]}" -c "begin; select resultado from public.aplicar_evento_calcom_tx('calcom:CONC:CANCELLED:B','BOOKING_CANCELLED','uid:B','$prospecto','{}','2026-08-21 12:00:00+00',null,array['uid:B','id:201'],'{}',null); select pg_sleep(1); commit;" &
pid_cancel_b=$!
sleep 0.2
resultado_reagenda=$("${psql_cmd[@]}" -At -c "select resultado || ':' || estado_prospecto from public.aplicar_evento_calcom_tx('calcom:CONC:RESCHEDULED:A-B','BOOKING_RESCHEDULED','uid:B','$prospecto','{}','2026-08-21 11:00:00+00','uid:A',array['uid:B','id:201'],array['uid:A','id:200'],null);")
wait "$pid_cancel_b"
test "$resultado_reagenda" = 'aplicado:cancelled'
"${psql_cmd[@]}" -c "do \$\$ begin if not exists(select 1 from public.prospecto where id='$prospecto' and estado='cancelled' and calcom_booking_id='uid:B' and calcom_booking_aliases @> array['uid:B','id:201'] and calcom_evento_en='2026-08-21 12:00:00+00') then raise exception 'entrega invertida A/B terminó mal'; end if; if exists(select 1 from public.comercial_evento where prospecto_id='$prospecto' and estado_proceso='pendiente') then raise exception 'quedó pendiente huérfano'; end if; if not exists(select 1 from public.comercial_evento where clave_idempotencia='calcom:CONC:CANCELLED:B' and estado_proceso='aplicado') then raise exception 'CANCELLED(B) no se drenó'; end if; end \$\$;"

# Interleaving que antes producía 40P01:
#  * la reentrega conserva el lock de CANCELLED(B) y luego pide prospecto;
#  * A→B conserva prospecto y el drenaje intenta CANCELLED(B).
# Ninguna sesión puede ser víctima; al terminar, CANCELLED(B) queda aplicado.
"${psql_cmd[@]}" -c "delete from public.comercial_evento where prospecto_id='$prospecto'; update public.prospecto set estado='contactado',calcom_booking_id=null,calcom_booking_aliases='{}',calcom_evento_en=null,calcom_evento_precedencia=null,calcom_estado_antes_no_show=null where id='$prospecto'; select resultado from public.aplicar_evento_calcom_tx('calcom:CONC:DEADLOCK:CREATED:A','BOOKING_CREATED','uid:A','$prospecto','{}','2026-08-22 10:00:00+00',null,array['uid:A'],'{}',null); select resultado from public.aplicar_evento_calcom_tx('calcom:CONC:DEADLOCK:CANCEL:B','BOOKING_CANCELLED','uid:B','$prospecto','{}','2026-08-22 12:00:00+00',null,array['uid:B'],'{}',null);"
salida_reentrega=$(mktemp)
salida_enlace=$(mktemp)
trap 'limpiar; rm -f "$salida_reentrega" "$salida_enlace"' EXIT
"${psql_cmd[@]}" -At -c "set lock_timeout='5s'; begin; select id from public.comercial_evento where clave_idempotencia='calcom:CONC:DEADLOCK:CANCEL:B' for update; select pg_sleep(1); select resultado || ':' || estado_prospecto from public.aplicar_evento_calcom_tx('calcom:CONC:DEADLOCK:CANCEL:B','BOOKING_CANCELLED','uid:B','$prospecto','{}','2026-08-22 12:00:00+00',null,array['uid:B'],'{}',null); commit;" >"$salida_reentrega" &
pid_reentrega=$!
sleep 0.2
"${psql_cmd[@]}" -At -c "set lock_timeout='5s'; select resultado || ':' || estado_prospecto from public.aplicar_evento_calcom_tx('calcom:CONC:DEADLOCK:A-B','BOOKING_RESCHEDULED','uid:B','$prospecto','{}','2026-08-22 11:00:00+00','uid:A',array['uid:B'],array['uid:A'],null);" >"$salida_enlace" &
pid_enlace=$!
wait "$pid_reentrega"
wait "$pid_enlace"
grep -q 'aplicado:cancelled' "$salida_reentrega"
grep -q 'aplicado:rescheduled' "$salida_enlace"
"${psql_cmd[@]}" -c "do \$\$ begin if not exists(select 1 from public.prospecto where id='$prospecto' and estado='cancelled' and calcom_booking_id='uid:B' and calcom_evento_en='2026-08-22 12:00:00+00') then raise exception 'carrera reentrega/enlazador no convergió'; end if; if not exists(select 1 from public.comercial_evento where clave_idempotencia='calcom:CONC:DEADLOCK:CANCEL:B' and estado_proceso='aplicado') then raise exception 'reentrega sobrevivió pero no aplicó'; end if; end \$\$;"

echo '0323_calcom_concurrencia: PASS'
