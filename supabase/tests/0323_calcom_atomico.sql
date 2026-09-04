-- Prueba real de la garantía CRM 0323. Ejecutar tras las migraciones:
--   psql -X -v ON_ERROR_STOP=1 -f supabase/tests/0323_calcom_atomico.sql
-- Todo queda dentro de una transacción revertida.

begin;

do $$
declare
  p constant uuid := '32300000-0000-4000-8000-000000000001';
  q constant uuid := '32300000-0000-4000-8000-000000000003';
  r record;
  e text;
  n integer;
  seguro boolean;
begin
  delete from public.comercial_evento where prospecto_id in (p, q)
     or clave_idempotencia like 'calcom:TEST0323:%';
  delete from public.prospecto where id in (p, q);
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
  -- CREATED enlaza la reserva y, dentro de la misma transacción, drena el
  -- CANCELLED más nuevo que estaba esperando. El evento de enlace sí aplicó;
  -- el estado observable al commit sigue siendo cancelled.
  if r.resultado <> 'aplicado' or r.estado_prospecto <> 'cancelled' or not exists (
    select 1 from public.prospecto where id = p and estado = 'cancelled'
  ) then raise exception 'CREATED tardío no drenó CANCELLED'; end if;

  -- Fixture oficial Cal.com: RESCHEDULED identifica la reserva nueva con
  -- uid=B/bookingId=201 y la anterior con rescheduleUid=A/rescheduleId=200.
  -- La cancelación de B puede entregarse antes y debe esperar durablemente;
  -- al llegar A→B se enlaza por UID y se aplica CANCELLED@12 después de
  -- RESCHEDULED@11, sin dejar un `pendiente` huérfano.
  update public.prospecto
     set estado = 'contactado', calcom_booking_id = null,
         calcom_booking_aliases = '{}'::text[], calcom_evento_en = null,
         calcom_evento_precedencia = null, calcom_estado_antes_no_show = null
   where id = p;
  perform public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:CREATED:A', 'BOOKING_CREATED', 'uid:A', p,
    '{"uid":"A","bookingId":200}'::jsonb, '2026-08-20 10:00:00+00', null,
    array['uid:A','id:200'], '{}'::text[], null
  );
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:CANCELLED:B', 'BOOKING_CANCELLED', 'uid:B', p,
    '{"uid":"B","bookingId":201}'::jsonb, '2026-08-20 12:00:00+00', null,
    array['uid:B','id:201'], '{}'::text[], null
  );
  if r.resultado <> 'esperando_vinculo' then
    raise exception 'CANCELLED(B) adelantado no quedó durable: %', r.resultado;
  end if;
  if not exists (
    select 1 from public.comercial_evento
     where clave_idempotencia = 'calcom:TEST0323:CANCELLED:B'
       and estado_proceso = 'esperando_vinculo'
  ) then raise exception 'CANCELLED(B) adelantado no quedó en ledger'; end if;
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:RESCHEDULED:A-B', 'BOOKING_RESCHEDULED', 'uid:B', p,
    '{"uid":"B","bookingId":201,"rescheduleUid":"A","rescheduleId":200}'::jsonb,
    '2026-08-20 11:00:00+00', 'uid:A',
    array['uid:B','id:201'], array['uid:A','id:200'], null
  );
  if r.resultado <> 'aplicado' or r.estado_prospecto <> 'cancelled' then
    raise exception 'A→B no drenó CANCELLED(B): resultado=% estado=%', r.resultado, r.estado_prospecto;
  end if;
  if not exists (
    select 1 from public.prospecto
     where id = p and estado = 'cancelled' and calcom_booking_id = 'uid:B'
       and calcom_booking_aliases @> array['uid:B','id:201']
       and calcom_evento_en = '2026-08-20 12:00:00+00'
  ) then raise exception 'identidad A→B o estado final incorrectos'; end if;
  if exists (
    select 1 from public.comercial_evento
     where prospecto_id = p and estado_proceso = 'pendiente'
  ) then raise exception '0323 dejó un pendiente huérfano'; end if;

  -- Una clave existente sólo es un duplicado final si su resultado ya era
  -- final. `sin_prospecto` se reabre cuando la reentrega ya puede enlazarlo.
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:RECUPERA:SIN_PROSPECTO', 'BOOKING_CREATED', 'uid:Q', null,
    '{"uid":"Q"}'::jsonb, '2026-08-21 10:00:00+00', null,
    array['uid:Q'], '{}'::text[], null
  );
  if r.resultado <> 'sin_prospecto' then raise exception 'sin prospecto no fue recuperable: %', r.resultado; end if;
  insert into public.prospecto(id, empresa, correo, estado)
    values (q, 'Recuperación Cal.com', 'CaseSensitive@Example.Test', 'contactado');
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:RECUPERA:SIN_PROSPECTO', 'BOOKING_CREATED', 'uid:Q', q,
    '{"uid":"Q"}'::jsonb, '2026-08-21 10:00:00+00', null,
    array['uid:Q'], '{}'::text[], null
  );
  if r.resultado <> 'aplicado' or r.estado_prospecto <> 'appointment' then
    raise exception 'reentrega sin_prospecto no recuperó: %/%', r.resultado, r.estado_prospecto;
  end if;
  if (select correo_normalizado from public.prospecto where id = q) <> 'casesensitive@example.test' then
    raise exception 'correo_normalizado no es case-insensitive';
  end if;

  -- Cuarentena también es recuperable: para no dormir el test, la segunda
  -- entrega representa el mismo createdAt una vez que ya dejó de ser futuro.
  update public.prospecto set estado='contactado', calcom_booking_id=null,
    calcom_booking_aliases='{}', calcom_evento_en=null,
    calcom_evento_precedencia=null where id=p;
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:RECUPERA:CUARENTENA', 'BOOKING_CREATED', 'uid:F', p,
    '{"uid":"F"}'::jsonb, clock_timestamp() + interval '1 day', null,
    array['uid:F'], '{}'::text[], null
  );
  if r.resultado <> 'cuarentena' then raise exception 'futuro no quedó recuperable'; end if;
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:RECUPERA:CUARENTENA', 'BOOKING_CREATED', 'uid:F', p,
    '{"uid":"F"}'::jsonb, clock_timestamp(), null,
    array['uid:F'], '{}'::text[], null
  );
  if r.resultado <> 'aplicado' then raise exception 'reentrega de cuarentena quedó como duplicado: %', r.resultado; end if;

  -- BOOKING_NO_SHOW_UPDATED oficial: true marca; false desmarca y restaura el
  -- estado activo anterior. La entrega sin reloj jamás resucita terminales.
  update public.prospecto set estado='contactado', calcom_booking_id=null,
    calcom_booking_aliases='{}', calcom_evento_en=null,
    calcom_evento_precedencia=null, calcom_estado_antes_no_show=null where id=p;
  perform public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:NS:CREATED', 'BOOKING_CREATED', 'uid:NS', p,
    '{"uid":"NS","bookingId":301}'::jsonb, '2026-08-22 10:00:00+00', null,
    array['uid:NS','id:301'], '{}'::text[], null
  );
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:NS:TRUE', 'BOOKING_NO_SHOW_UPDATED', 'uid:NS', p,
    '{"bookingUid":"NS","attendees":[{"email":"lead@example.test","noShow":true}]}'::jsonb,
    '2026-08-22 13:00:00+00', null, array['uid:NS','id:301'], '{}'::text[], true
  );
  if r.estado_prospecto <> 'no-show' then raise exception 'noShow=true no marcó'; end if;
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:NS:FALSE', 'BOOKING_NO_SHOW_UPDATED', 'uid:NS', p,
    '{"bookingUid":"NS","attendees":[{"email":"lead@example.test","noShow":false}]}'::jsonb,
    '2026-08-22 14:00:00+00', null, array['uid:NS','id:301'], '{}'::text[], false
  );
  if r.estado_prospecto <> 'appointment' then raise exception 'noShow=false no restauró appointment'; end if;
  perform public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:NS:CANCEL', 'BOOKING_CANCELLED', 'uid:NS', p,
    '{}'::jsonb, '2026-08-22 15:00:00+00', null,
    array['uid:NS','id:301'], '{}'::text[], null
  );
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:NS:SIN-RELOJ', 'BOOKING_NO_SHOW_UPDATED', 'uid:NS', p,
    '{"attendees":[{"noShow":false}]}'::jsonb, null, null,
    array['uid:NS','id:301'], '{}'::text[], false
  );
  if r.resultado <> 'ignorado' or r.estado_prospecto <> 'cancelled' then
    raise exception 'sin timestamp resucitó cancelled: %/%', r.resultado, r.estado_prospecto;
  end if;

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
   where p.oid = 'public.aplicar_evento_calcom_tx(text,text,text,uuid,jsonb,timestamptz,text,text[],text[],boolean)'::regprocedure;
  if seguro is not true then raise exception 'RPC sin SECURITY DEFINER/search_path vacío/permisos mínimos'; end if;
end $$;

rollback;
