-- Regresión RED: una purga de PII no puede olvidar la huella idempotente.
-- Ejecutar contra PostgreSQL 17 después de las migraciones. Todo revierte.

begin;
set local statement_timeout = '5s';

do $$
declare
  p constant uuid := '32390000-0000-4000-8000-000000000011';
  clave constant text := 'calcom:BOOKING_REQUESTED:uid:PURGA-REPLAY-RED';
  r record;
  filas integer;
begin
  delete from public.comercial_evento where prospecto_id=p or clave_idempotencia=clave;
  delete from public.prospecto where id=p;
  insert into public.prospecto(id,empresa,correo,estado)
    values(p,'Purga replay RED','purga-replay-red@example.test','contactado');

  select * into r from public.aplicar_evento_calcom_tx(
    clave, 'BOOKING_REQUESTED', 'uid:PURGA-REPLAY-RED', p,
    '{"uid":"PURGA-REPLAY-RED","attendees":[{"email":"purga-replay-red@example.test"}]}'::jsonb,
    '2020-01-01 00:00:00+00', null,
    array['uid:PURGA-REPLAY-RED'], '{}'::text[], null,
    'purga-replay-red@example.test', null
  );
  if r.resultado <> 'aplicado' then
    raise exception 'precondición: primera entrega no aplicó: %', r.resultado;
  end if;

  perform public.purgar_comercial_evento(365, '2026-09-04 00:00:00+00');

  select * into r from public.aplicar_evento_calcom_tx(
    clave, 'BOOKING_REQUESTED', 'uid:PURGA-REPLAY-RED', p,
    '{"uid":"PURGA-REPLAY-RED","attendees":[{"email":"purga-replay-red@example.test"}]}'::jsonb,
    '2020-01-01 00:00:00+00', null,
    array['uid:PURGA-REPLAY-RED'], '{}'::text[], null,
    'purga-replay-red@example.test', null
  );
  select count(*) into filas
    from public.comercial_evento where prospecto_id=p;

  if r.resultado <> 'repetido' then
    raise exception 'RED purga/idempotencia: reentrega devolvió %, no repetido', r.resultado;
  end if;
  if filas <> 1 then
    raise exception 'RED purga/idempotencia: reentrega creó % filas, esperaba 1', filas;
  end if;
  if exists (
    select 1 from public.comercial_evento
     where prospecto_id=p and (
       payload <> '{}'::jsonb or vinculo_correo is not null or vinculo_error is not null
     )
  ) then
    raise exception 'RED purga/idempotencia: reentrega restauró PII';
  end if;
end $$;

rollback;
