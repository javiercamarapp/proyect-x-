-- Prueba real de la garantía CRM 0323. Ejecutar tras las migraciones:
--   psql -X -v ON_ERROR_STOP=1 -f supabase/tests/0323_calcom_atomico.sql
-- Todo queda dentro de una transacción revertida.

begin;

do $$
declare
  p constant uuid := '32300000-0000-4000-8000-000000000001';
  r record;
  e text;
  n integer;
  seguro boolean;
begin
  delete from public.comercial_evento where prospecto_id = p;
  delete from public.prospecto where id = p;
  insert into public.prospecto(id, empresa, correo, estado)
    values (p, 'Prueba Cal.com 0323', 'calcom-0323@example.test', 'contactado');

  -- Sin timestamp, CREATED establece inequívocamente la reserva B. Una
  -- cancelación tardía de A no puede cancelar B aunque llegue después.
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:BOOKING_CREATED:B', 'BOOKING_CREATED', 'B', p, '{}'::jsonb, null, null
  );
  if r.resultado <> 'aplicado' then raise exception 'CREATED(B) no aplicó: %', r.resultado; end if;
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:BOOKING_CANCELLED:A', 'BOOKING_CANCELLED', 'A', p, '{}'::jsonb, null, null
  );
  if r.resultado <> 'ignorado' then raise exception 'CANCELLED(A) no fue ignorado: %', r.resultado; end if;
  if not exists (
    select 1 from public.prospecto where id = p and estado = 'appointment' and calcom_booking_id = 'B'
  ) then raise exception 'CANCELLED(A) pisó la reserva B'; end if;
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:BOOKING_CREATED:A-TARDIO', 'BOOKING_CREATED', 'A', p, '{}'::jsonb, null, null
  );
  if r.resultado <> 'ignorado' or not exists (
    select 1 from public.prospecto where id = p and estado = 'appointment' and calcom_booking_id = 'B'
  ) then raise exception 'CREATED(A) sin reloj reemplazó la reserva B'; end if;

  -- Un reloj futuro queda registrado/cuarentenado, pero no cambia estado ni
  -- el marcador de secuencia vigente.
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:BOOKING_CREATED:FUTURO', 'BOOKING_CREATED', 'FUTURO', p, '{}'::jsonb,
    clock_timestamp() + interval '1 day', null
  );
  if r.resultado <> 'cuarentena' then raise exception 'futuro no fue a cuarentena: %', r.resultado; end if;
  if not exists (
    select 1 from public.prospecto where id = p and estado = 'appointment' and calcom_booking_id = 'B'
  ) then raise exception 'evento futuro envenenó prospecto/secuencia'; end if;
  if not exists (
    select 1 from public.comercial_evento
     where clave_idempotencia = 'calcom:BOOKING_CREATED:FUTURO'
       and estado_proceso = 'cuarentena' and orden_en is null
  ) then raise exception 'evento futuro no quedó auditable y fuera de secuencia'; end if;
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:BOOKING_RESCHEDULED:B-VALIDO', 'BOOKING_RESCHEDULED', 'B', p, '{}'::jsonb,
    clock_timestamp(), null
  );
  if r.resultado <> 'aplicado' or not exists (
    select 1 from public.prospecto where id = p and estado = 'rescheduled' and calcom_booking_id = 'B'
  ) then raise exception 'evento futuro envenenó el siguiente evento válido'; end if;

  -- Idempotencia durable: una sola fila y ninguna segunda mutación.
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:BOOKING_CREATED:B', 'BOOKING_CREATED', 'B', p, '{}'::jsonb, null, null
  );
  select count(*) into n from public.comercial_evento
   where clave_idempotencia = 'calcom:BOOKING_CREATED:B';
  if r.resultado <> 'repetido' or n <> 1 then
    raise exception 'duplicado resultado=% filas=%', r.resultado, n;
  end if;

  -- El orden firmado no depende del orden de entrega: cancelar a las 12 y
  -- recibir después CREATED de las 10 conserva cancelled.
  update public.prospecto
     set estado = 'contactado', calcom_booking_id = null,
         calcom_evento_en = null, calcom_evento_precedencia = null
   where id = p;
  perform public.aplicar_evento_calcom_tx(
    'calcom:BOOKING_CANCELLED:ORDEN', 'BOOKING_CANCELLED', 'ORDEN', p, '{}'::jsonb,
    '2026-08-20 12:00:00+00', null
  );
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:BOOKING_CREATED:ORDEN', 'BOOKING_CREATED', 'ORDEN', p, '{}'::jsonb,
    '2026-08-20 10:00:00+00', null
  );
  if r.resultado <> 'ignorado' or not exists (
    select 1 from public.prospecto where id = p and estado = 'cancelled'
  ) then raise exception 'CREATED tardío resucitó CANCELLED'; end if;

  -- Los cuatro nombres terminales se normalizan antes de cualquier mutación.
  foreach e in array array['won', 'cerrado', 'lost', 'perdido'] loop
    update public.prospecto
       set estado = e,
           cerrado_en = case when e in ('won', 'cerrado') then clock_timestamp() else null end,
           calcom_booking_id = null, calcom_evento_en = null, calcom_evento_precedencia = null
     where id = p;
    select * into r from public.aplicar_evento_calcom_tx(
      'calcom:BOOKING_CREATED:terminal-' || e,
      'BOOKING_CREATED', 'terminal-' || e, p, '{}'::jsonb,
      clock_timestamp(), null
    );
    if r.resultado <> 'ignorado' then raise exception 'terminal % mutó: %', e, r.resultado; end if;
  end loop;

  select p.prosecdef
      and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute')
      and has_function_privilege('service_role', p.oid, 'execute')
    into seguro
    from pg_proc p
   where p.oid = 'public.aplicar_evento_calcom_tx(text,text,text,uuid,jsonb,timestamptz,text)'::regprocedure;
  if seguro is not true then raise exception 'RPC sin SECURITY DEFINER/search_path vacío/permisos mínimos'; end if;
end $$;

rollback;
