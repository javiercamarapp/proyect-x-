-- Regresión: la retención no puede convertir trabajo recuperable en
-- una poison pill sin identidad que derribe todos los barridos posteriores.

begin;
set local statement_timeout = '5s';

do $$
declare
  p constant uuid := '32390000-0000-4000-8000-000000000012';
  clave constant text := 'calcom:BOOKING_CANCELLED:uid:PURGA-POISON-RED';
  r record;
begin
  delete from public.comercial_evento where prospecto_id=p or clave_idempotencia=clave;
  delete from public.prospecto where id=p;
  insert into public.prospecto(id,empresa,correo,estado)
    values(p,'Purga poison RED','purga-poison-red@example.test','contactado');

  select * into r from public.aplicar_evento_calcom_tx(
    clave, 'BOOKING_CANCELLED', 'uid:PURGA-POISON-RED', p,
    '{"uid":"PURGA-POISON-RED","attendees":[{"email":"purga-poison-red@example.test"}]}'::jsonb,
    '2020-01-02 00:00:00+00', null,
    array['uid:PURGA-POISON-RED'], '{}'::text[], null,
    'purga-poison-red@example.test', null
  );
  if r.resultado <> 'ignorado' then
    raise exception 'precondición: evento fuera de retención no quedó ignorado: %', r.resultado;
  end if;

  perform public.purgar_comercial_evento(365, '2026-09-04 00:00:00+00');

  begin
    perform * from public.reconciliar_eventos_calcom_pendientes(250);
  exception when others then
    raise exception 'RED purga/poison: el barrido falló SQLSTATE=% error=%', sqlstate, sqlerrm;
  end;

  if exists (
    select 1 from public.comercial_evento
     where prospecto_id=p
       and estado_proceso in ('pendiente','esperando_vinculo','sin_prospecto','cuarentena')
       and (externo_id is null or cardinality(externo_aliases)=0)
  ) then
    raise exception 'RED purga/poison: quedó recuperable sin identidad';
  end if;
end $$;

rollback;
