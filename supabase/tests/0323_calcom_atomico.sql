-- Prueba real de la garantía CRM 0323. Ejecutar tras las migraciones:
--   psql -X -v ON_ERROR_STOP=1 -f supabase/tests/0323_calcom_atomico.sql
-- Todo queda dentro de una transacción revertida.

begin;

do $$
declare
  p constant uuid := '32300000-0000-4000-8000-000000000001';
  q constant uuid := '32300000-0000-4000-8000-000000000003';
  s constant uuid := '32300000-0000-4000-8000-000000000004';
  r record;
  e text;
  n integer;
  seguro boolean;
  token uuid;
  ventana timestamptz;
  cursor_guardado text;
  purga_id uuid;
  futuro_lejano timestamptz := clock_timestamp() + interval '180 days';
  estado_antes text;
  procesado_antes timestamptz;
  error_antes text;
  conteo_antes bigint;
begin
  delete from public.comercial_evento where prospecto_id in (p, q)
     or clave_idempotencia like 'calcom:TEST0323:%';
  delete from public.prospecto where id in (p, q, s);
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

  -- Un reloj futuro se rechaza sin crear ledger ni cambiar estado.
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:BOOKING_CREATED:FUTURO', 'BOOKING_CREATED', 'FUTURO', p, '{}'::jsonb,
    clock_timestamp() + interval '1 day', null
  );
  if r.resultado <> 'ignorado' then raise exception 'futuro no fue rechazado: %', r.resultado; end if;
  if not exists (
    select 1 from public.prospecto where id = p and estado = 'appointment' and calcom_booking_id = 'B'
  ) then raise exception 'evento futuro envenenó prospecto/secuencia'; end if;
  if exists (select 1 from public.comercial_evento
     where clave_idempotencia = 'calcom:BOOKING_CREATED:FUTURO')
  then raise exception 'evento futuro creó ledger'; end if;
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

  -- Replay antiguo de una fila final: sólo es repetido, sin reabrir ni tocar
  -- estado/procesado/error aunque el reloj durable ya haya envejecido.
  select estado_proceso, procesado_en, error into estado_antes, procesado_antes, error_antes
    from public.comercial_evento where clave_idempotencia='calcom:BOOKING_CREATED:B';
  select count(*) into conteo_antes from public.comercial_evento;
  update public.comercial_evento set ocurrido_en='2020-01-01 00:00:00+00'
   where clave_idempotencia='calcom:BOOKING_CREATED:B';
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:BOOKING_CREATED:B', 'BOOKING_CREATED', 'B', p, '{}'::jsonb,
    '2020-01-01 00:00:00+00', null
  );
  if r.resultado <> 'repetido' then raise exception 'replay final antiguo no repetido: %', r.resultado; end if;
  if exists (select 1 from public.comercial_evento where clave_idempotencia='calcom:BOOKING_CREATED:B'
    and (estado_proceso <> estado_antes or procesado_en is distinct from procesado_antes
      or error is distinct from error_antes)) then
    raise exception 'replay final antiguo mutó estado/procesado/error';
  end if;
  select count(*) into n from public.comercial_evento;
  if n <> conteo_antes then raise exception 'replay final antiguo cambió conteo: %/%', conteo_antes, n; end if;

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

  -- Dos reprogramaciones consecutivas pueden compartir el mismo createdAt
  -- firmado. La precedencia por tipo no debe convertir B→C en duplicado de
  -- A→B: el alias anterior prueba causalidad estricta. Después, CANCELLED(C)
  -- sigue siendo terminal y ninguna reentrega de B puede resucitarla.
  update public.prospecto
     set estado = 'contactado', calcom_booking_id = null,
         calcom_booking_aliases = '{}'::text[], calcom_evento_en = null,
         calcom_evento_precedencia = null, calcom_estado_antes_no_show = null
   where id = p;
  perform public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:IGUAL:DIRECTO:CREATED:A', 'BOOKING_CREATED', 'uid:A', p,
    '{}'::jsonb, '2026-08-20 10:00:00+00', null,
    array['uid:A'], '{}'::text[], null
  );
  perform public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:IGUAL:DIRECTO:A-B', 'BOOKING_RESCHEDULED', 'uid:B', p,
    '{}'::jsonb, '2026-08-20 11:00:00+00', 'uid:A',
    array['uid:B'], array['uid:A'], null
  );
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:IGUAL:DIRECTO:B-C', 'BOOKING_RESCHEDULED', 'uid:C', p,
    '{}'::jsonb, '2026-08-20 11:00:00+00', 'uid:B',
    array['uid:C'], array['uid:B'], null
  );
  if r.resultado <> 'aplicado' or not exists (
    select 1 from public.prospecto
     where id=p and estado='rescheduled' and calcom_booking_id='uid:C'
  ) then raise exception 'B→C causal con mismo createdAt fue descartado: %/%', r.resultado, r.estado_prospecto; end if;
  perform public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:IGUAL:DIRECTO:CANCEL:C', 'BOOKING_CANCELLED', 'uid:C', p,
    '{}'::jsonb, '2026-08-20 12:00:00+00', null,
    array['uid:C'], '{}'::text[], null
  );
  perform public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:IGUAL:DIRECTO:B-TARDIO', 'BOOKING_RESCHEDULED', 'uid:B', p,
    '{}'::jsonb, '2026-08-20 11:00:00+00', 'uid:A',
    array['uid:B'], array['uid:A'], null
  );
  if not exists (
    select 1 from public.prospecto
     where id=p and estado='cancelled' and calcom_booking_id='uid:C'
  ) then raise exception 'reentrega vieja resucitó cancelled(C)'; end if;
  if (select count(*) from public.comercial_evento
       where clave_idempotencia in (
         'calcom:TEST0323:IGUAL:DIRECTO:A-B',
         'calcom:TEST0323:IGUAL:DIRECTO:B-C',
         'calcom:TEST0323:IGUAL:DIRECTO:CANCEL:C'
       ) and estado_proceso='aplicado') <> 3 then
    raise exception 'cadena directa A→B→C→cancel no terminó aplicada';
  end if;

  -- Mismo grafo, entrega invertida: B→C y CANCELLED(C) esperan en el ledger;
  -- A→B debe drenarlos causalmente aunque A→B/B→C empaten en createdAt.
  delete from public.comercial_evento where prospecto_id=p;
  update public.prospecto
     set estado = 'contactado', calcom_booking_id = null,
         calcom_booking_aliases = '{}'::text[], calcom_evento_en = null,
         calcom_evento_precedencia = null, calcom_estado_antes_no_show = null
   where id = p;
  perform public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:IGUAL:DRENA:CREATED:A', 'BOOKING_CREATED', 'uid:A', p,
    '{}'::jsonb, '2026-08-20 10:00:00+00', null,
    array['uid:A'], '{}'::text[], null
  );
  perform public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:IGUAL:DRENA:CANCEL:C', 'BOOKING_CANCELLED', 'uid:C', p,
    '{}'::jsonb, '2026-08-20 12:00:00+00', null,
    array['uid:C'], '{}'::text[], null
  );
  perform public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:IGUAL:DRENA:B-C', 'BOOKING_RESCHEDULED', 'uid:C', p,
    '{}'::jsonb, '2026-08-20 11:00:00+00', 'uid:B',
    array['uid:C'], array['uid:B'], null
  );
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:IGUAL:DRENA:A-B', 'BOOKING_RESCHEDULED', 'uid:B', p,
    '{}'::jsonb, '2026-08-20 11:00:00+00', 'uid:A',
    array['uid:B'], array['uid:A'], null
  );
  if r.resultado <> 'aplicado' or r.estado_prospecto <> 'cancelled' or not exists (
    select 1 from public.prospecto
     where id=p and estado='cancelled' and calcom_booking_id='uid:C'
       and calcom_evento_en='2026-08-20 12:00:00+00'
  ) then raise exception 'drenaje A→B→C→cancelled falló: %/%', r.resultado, r.estado_prospecto; end if;
  if exists (
    select 1 from public.comercial_evento where prospecto_id=p
      and estado_proceso in ('pendiente','esperando_vinculo')
  ) then raise exception 'cadena causal drenada dejó trabajo recuperable'; end if;
  if (select count(*) from public.comercial_evento
       where clave_idempotencia in (
         'calcom:TEST0323:IGUAL:DRENA:A-B',
         'calcom:TEST0323:IGUAL:DRENA:B-C',
         'calcom:TEST0323:IGUAL:DRENA:CANCEL:C'
       ) and estado_proceso='aplicado') <> 3 then
    raise exception 'cadena drenada A→B→C→cancel no terminó aplicada';
  end if;

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

  -- Todo futuro fuera de tolerancia se rechaza y no puede rehidratarse.
  update public.prospecto set estado='contactado', calcom_booking_id=null,
    calcom_booking_aliases='{}', calcom_evento_en=null,
    calcom_evento_precedencia=null where id=p;
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:RECUPERA:CUARENTENA', 'BOOKING_CREATED', 'uid:F', p,
    '{"uid":"F"}'::jsonb, clock_timestamp() + interval '1 day', null,
    array['uid:F'], '{}'::text[], null
  );
  if r.resultado <> 'ignorado' then raise exception 'futuro no quedó rechazado'; end if;
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:RECUPERA:CUARENTENA', 'BOOKING_CREATED', 'uid:F', p,
    '{"uid":"F"}'::jsonb, clock_timestamp(), null,
    array['uid:F'], '{}'::text[], null
  );
  if r.resultado <> 'aplicado' then raise exception 'reentrega con fecha ya válida no aplicó: %', r.resultado; end if;

  -- Futuro lejano: la misma entrega no debe crear ledger ni conservar PII,
  -- tampoco en una segunda llamada con exactamente el mismo createdAt.
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:FUTURO:LEJANO', 'BOOKING_CREATED', 'uid:F180', p,
    '{"uid":"F180","attendees":[{"email":"futuro-180@example.test"}]}'::jsonb,
    futuro_lejano, null, array['uid:F180'], '{}'::text[], null,
    'futuro-180@example.test', null
  );
  if r.resultado <> 'ignorado' then raise exception 'futuro lejano no fue ignorado: %', r.resultado; end if;
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:FUTURO:LEJANO', 'BOOKING_CREATED', 'uid:F180', p,
    '{"uid":"F180","attendees":[{"email":"futuro-180@example.test"}]}'::jsonb,
    futuro_lejano, null, array['uid:F180'], '{}'::text[], null,
    'futuro-180@example.test', null
  );
  select count(*) into n from public.comercial_evento
   where clave_idempotencia = 'calcom:TEST0323:FUTURO:LEJANO';
  if r.resultado <> 'ignorado' or n <> 0 then
    raise exception 'futuro lejano creó ledger/replay: %/%', r.resultado, n;
  end if;

  -- El barrido propio recupera sin pedirle a Cal.com otra entrega. Un correo
  -- único se enlaza; uno ambiguo queda durable/observable y no se adivina.
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:BARRIDO:SIN', 'BOOKING_CREATED', 'uid:AUTO', null,
    '{}'::jsonb, '2026-08-21 11:00:00+00', null,
    array['uid:AUTO'], '{}'::text[], null, 'auto@example.test', 'sin_prospecto'
  );
  insert into public.prospecto(id, empresa, correo, estado)
    values (s, 'Auto Cal.com', 'AUTO@example.test', 'contactado');
  perform public.reconciliar_eventos_calcom_pendientes(250);
  if not exists (
    select 1 from public.comercial_evento
     where clave_idempotencia='calcom:TEST0323:BARRIDO:SIN'
       and prospecto_id=s and estado_proceso='aplicado'
  ) or not exists (
    select 1 from public.prospecto where id=s and estado='appointment'
      and calcom_booking_id='uid:AUTO'
  ) then raise exception 'barrido propio no recuperó correo único'; end if;

  update public.prospecto set correo='ambiguo@example.test' where id in (q,s);
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:BARRIDO:AMBIGUO', 'BOOKING_CREATED', 'uid:AMB', null,
    '{}'::jsonb, '2026-08-21 12:00:00+00', null,
    array['uid:AMB'], '{}'::text[], null, 'ambiguo@example.test', 'correo_ambiguo'
  );
  perform public.reconciliar_eventos_calcom_pendientes(250);
  if not exists (
    select 1 from public.comercial_evento
     where clave_idempotencia='calcom:TEST0323:BARRIDO:AMBIGUO'
       and prospecto_id is null and estado_proceso='sin_prospecto'
       and error='correo_ambiguo' and vinculo_error='correo_ambiguo'
  ) then raise exception 'correo ambiguo fue elegido o perdió diagnóstico'; end if;

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
   where p.oid = 'public.aplicar_evento_calcom_tx(text,text,text,uuid,jsonb,timestamptz,text,text[],text[],boolean,text,text)'::regprocedure;
  if seguro is not true then raise exception 'RPC sin SECURITY DEFINER/search_path vacío/permisos mínimos'; end if;

  -- Ronda 3: una función SECURITY DEFINER no puede confiar en `public` para
  -- resolver nombres; tampoco puede dejar digest() ambiguo bajo un
  -- search_path controlado. Este contrato evita shadowing de funciones.
  select p.prosecdef
      and coalesce(array_to_string(p.proconfig, ','), '') not like '%public%'
      and p.prosrc not like '%encode(digest(%'
    into seguro
    from pg_proc p
   where p.oid = 'public.purgar_comercial_evento(integer,timestamptz)'::regprocedure;
  if seguro is not true then
    raise exception 'RED ronda3: purga SECURITY DEFINER usa public o digest() sin calificar';
  end if;
  if has_function_privilege('anon', 'public.reconciliar_eventos_calcom_pendientes(integer)', 'execute')
     or has_function_privilege('authenticated', 'public.reconciliar_eventos_calcom_pendientes(integer)', 'execute')
     or not has_function_privilege('service_role', 'public.reconciliar_eventos_calcom_pendientes(integer)', 'execute') then
    raise exception 'barrido Cal.com sin permisos mínimos';
  end if;

  -- Watermark/ventana/cursor sobreviven a un worker caído. El callback stale
  -- no puede avanzar el watermark de un dueño posterior.
  update public.calcom_sincronizacion_estado
     set watermark_en='2026-08-01 00:00:00+00', ventana_hasta_en=null,
         cursor_siguiente=null, claim_token=null, lease_expires_at=null,
         webhook_verificado_en=null, webhook_id=null, ultimo_error=null
   where singleton;
  select claim_token, ventana_hasta_en into token, ventana
    from public.iniciar_sincronizacion_calcom(90);
  if token is null or ventana is null then raise exception 'sync Cal.com no inició'; end if;
  if not public.guardar_cursor_sincronizacion_calcom(token, 'CURSOR-2', 90) then
    raise exception 'cursor durable no se guardó';
  end if;
  if not public.fallar_sincronizacion_calcom(token, 'caída simulada') then
    raise exception 'sync fallida no liberó lease';
  end if;
  select claim_token, cursor_siguiente, ventana_hasta_en
    into token, cursor_guardado, ventana
    from public.iniciar_sincronizacion_calcom(90);
  if cursor_guardado <> 'CURSOR-2' or ventana is null then
    raise exception 'claim nuevo perdió cursor/ventana durable';
  end if;
  if not public.registrar_webhook_sincronizacion_calcom(token, 'wh-0323') then
    raise exception 'provisionamiento no quedó durable';
  end if;
  if not public.finalizar_sincronizacion_calcom(token) then
    raise exception 'sync completa no avanzó watermark';
  end if;
  if exists (
    select 1 from public.calcom_sincronizacion_estado
     where singleton and (
       watermark_en <> ventana or ventana_hasta_en is not null
       or cursor_siguiente is not null or claim_token is not null
       or webhook_id <> 'wh-0323' or webhook_verificado_en is null
     )
  ) then raise exception 'estado final de sync/provisionamiento incorrecto'; end if;
  if public.finalizar_sincronizacion_calcom(token) then
    raise exception 'callback stale avanzó watermark';
  end if;

  -- Status oficiales de Bookings v2: pending/rejected son REQUESTED/REJECTED,
  -- nunca una cita aceptada inventada. El REQUESTED reconstruye el vínculo
  -- base y REJECTED puede cerrar después de una pérdida de webhooks.
  update public.prospecto set estado='contactado', calcom_booking_id=null,
    calcom_booking_aliases='{}', calcom_evento_en=null,
    calcom_evento_precedencia=null, calcom_estado_antes_no_show=null where id=p;
  perform public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:REQUESTED:R', 'BOOKING_REQUESTED', 'uid:R', p,
    '{}'::jsonb, '2026-08-23 10:00:00+00', null,
    array['uid:R','id:901'], '{}'::text[], null
  );
  select * into r from public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:REJECTED:R', 'BOOKING_REJECTED', 'uid:R', p,
    '{}'::jsonb, '2026-08-23 11:00:00+00', null,
    array['uid:R','id:901'], '{}'::text[], null
  );
  if r.resultado <> 'aplicado' or r.estado_prospecto <> 'cancelled' then
    raise exception 'REQUESTED→REJECTED no convergió: %/%', r.resultado, r.estado_prospecto;
  end if;
  if exists (
    select 1 from public.comercial_evento
     where clave_idempotencia in ('calcom:TEST0323:REQUESTED:R','calcom:TEST0323:REJECTED:R')
       and estado_proceso <> 'aplicado'
  ) then raise exception 'status pending/rejected dejó trabajo no final'; end if;

  -- `esperando_vinculo` también es recuperable y tiene que aparecer en
  -- restantes; de otro modo el reconciliador podría avanzar su watermark.
  update public.prospecto set estado='contactado', calcom_booking_id=null,
    calcom_booking_aliases='{}', calcom_evento_en=null,
    calcom_evento_precedencia=null, calcom_estado_antes_no_show=null where id=p;
  perform public.aplicar_evento_calcom_tx(
    'calcom:TEST0323:ESPERA:TERMINAL', 'BOOKING_CANCELLED', 'uid:WAIT', p,
    '{}'::jsonb, '2026-08-24 11:00:00+00', null,
    array['uid:WAIT'], '{}'::text[], null
  );
  if not exists (
    select 1 from public.reconciliar_eventos_calcom_pendientes(250)
     where restantes >= 1
  ) then raise exception 'esperando_vinculo quedó invisible para restantes'; end if;

  -- La retención elimina correo y también todos los alias/identificadores
  -- externos introducidos por 0323; conservarlos haría reversible la purga.
  update public.comercial_evento
     set ocurrido_en='2020-01-01 00:00:00+00',
         vinculo_correo='persona@example.test', vinculo_error='sin_prospecto'
   where clave_idempotencia='calcom:TEST0323:ESPERA:TERMINAL';
  select id into purga_id from public.comercial_evento
   where clave_idempotencia='calcom:TEST0323:ESPERA:TERMINAL';
  perform public.purgar_comercial_evento(365, '2026-09-04 00:00:00+00');
  if exists (
    select 1 from public.comercial_evento
     where id=purga_id and (clave_idempotencia <> 'purgado:calcom:' || purga_id::text
        or vinculo_correo is not null or vinculo_error is not null
        or externo_id is not null or externo_aliases <> '{}'::text[]
        or externo_anterior_aliases <> '{}'::text[])
  ) then raise exception 'purga Cal.com conservó correo/aliases/identificador'; end if;

  -- Contrato de privacidad propuesto (pendiente de decisión): una huella
  -- SHA-256 pública de la clave original sigue siendo verificable por quien
  -- conozca esa clave. La retención fuerte exige que el tombstone no conserve
  -- esa relación determinista; esta RED debe permanecer roja hasta acordar la
  -- estrategia de cierre (p.ej. eliminar el enlace de replay y sellar como
  -- tombstone anónimo, sin introducir otro secreto en la base).
  if exists (
    select 1 from public.comercial_evento
     where id=purga_id and clave_replay_hash is not null
  ) then
    raise exception 'RED privacidad propuesta: tombstone conserva huella SHA-256 verificable';
  end if;
end $$;

rollback;
