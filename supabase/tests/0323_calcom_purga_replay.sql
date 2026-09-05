-- Regresión RED: una purga de PII no puede olvidar la huella idempotente.
-- Ejecutar contra PostgreSQL 17 después de las migraciones. Todo revierte.

begin;
set local statement_timeout = '5s';

do $$
declare
  p constant uuid := '32390000-0000-4000-8000-000000000011';
  clave constant text := 'calcom:BOOKING_REQUESTED:uid:PURGA-REPLAY-RED';
  clave_nunca_vista constant text := 'calcom:BOOKING_REQUESTED:uid:PURGA-OLD-NEVER-SEEN';
  r record;
  filas integer;
  filas_antes integer;
begin
  delete from public.comercial_evento where prospecto_id=p or clave_idempotencia=clave;
  delete from public.prospecto where id=p;
  insert into public.prospecto(id,empresa,correo,estado)
    values(p,'Purga replay RED','purga-replay-red@example.test','contactado');

  select * into r from public.aplicar_evento_calcom_tx(
    clave, 'BOOKING_REQUESTED', 'uid:PURGA-REPLAY-RED', p,
    '{"uid":"PURGA-REPLAY-RED","attendees":[{"email":"purga-replay-red@example.test"}]}'::jsonb,
    '2026-09-03 00:00:00+00', null,
    array['uid:PURGA-REPLAY-RED'], '{}'::text[], null,
    'purga-replay-red@example.test', null
  );
  if r.resultado <> 'aplicado' then
    raise exception 'precondición: primera entrega no aplicó: %', r.resultado;
  end if;

  -- La fila nació vigente; se envejecen todos sus relojes para simular que
  -- alcanzó retención sin depender del reloj real de la base.
  update public.comercial_evento
     set ocurrido_en='2020-01-01 00:00:00+00',
         creado_en='2020-01-01 00:00:00+00',
         orden_en='2020-01-01 00:00:00+00'
   where clave_idempotencia=clave;

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

  if r.resultado <> 'ignorado' then
    raise exception 'RED purga/privacidad: replay post-retención devolvió %, esperaba ignorado', r.resultado;
  end if;
  if filas <> 1 then
    raise exception 'RED purga/privacidad: reentrega creó % filas, esperaba tombstone único', filas;
  end if;
  if exists (
    select 1 from public.comercial_evento
     where prospecto_id=p and (
       externo_id is not null or externo_aliases <> '{}'::text[]
       or externo_anterior_aliases <> '{}'::text[]
       or clave_idempotencia = clave
       or clave_replay_hash is not null
     )
  ) then
    raise exception 'RED purga/idempotencia: conservó externo_id/aliases/clave original';
  end if;
  if exists (
    select 1 from public.comercial_evento
     where prospecto_id=p and (
       payload <> '{}'::jsonb or vinculo_correo is not null or vinculo_error is not null
     )
  ) then
    raise exception 'RED purga/idempotencia: reentrega restauró PII';
  end if;

  -- Un evento que nunca llegó antes de la retención tampoco puede reabrir el
  -- vínculo ni crear una fila nueva sólo porque conserva un timestamp antiguo.
  update public.prospecto set estado='contactado', calcom_booking_id=null,
    calcom_booking_aliases='{}'::text[] where id=p;
  select count(*) into filas_antes from public.comercial_evento;
  select * into r from public.aplicar_evento_calcom_tx(
    clave_nunca_vista, 'BOOKING_REQUESTED', 'uid:PURGA-OLD-NEVER-SEEN', p,
    '{"uid":"PURGA-OLD-NEVER-SEEN","attendees":[{"email":"purga-replay-red@example.test"}]}'::jsonb,
    '2020-01-01 00:00:00+00', null,
    array['uid:PURGA-OLD-NEVER-SEEN'], '{}'::text[], null,
    'purga-replay-red@example.test', null
  );
  select count(*) into filas from public.comercial_evento;
  if r.resultado <> 'ignorado' or filas <> filas_antes then
    raise exception 'RED purga/privacidad: evento antiguo nunca visto resultado=% filas=%/%',
      r.resultado, filas, filas_antes;
  end if;
  if exists (
    select 1 from public.prospecto
     where id=p and (estado <> 'contactado' or calcom_booking_id is not null)
  ) then
    raise exception 'RED purga/privacidad: evento antiguo nunca visto mutó prospecto';
  end if;
end $$;

rollback;
