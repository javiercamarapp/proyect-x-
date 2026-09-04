-- Sólo base desechable: filas sintéticas, todo se revierte.
\set ON_ERROR_STOP on
begin;
insert into public.tenant(id,nombre) values
  ('33900000-0000-4000-8000-000000000001','Integridad cola A'),
  ('33900000-0000-4000-8000-000000000002','Integridad cola B');
insert into public.operador(id,tenant_id,nombre,telefono) values
  ('33900000-0000-4000-8000-000000000011','33900000-0000-4000-8000-000000000001','Operador A','529999903391'),
  ('33900000-0000-4000-8000-000000000012','33900000-0000-4000-8000-000000000002','Operador B','529999903392');
insert into public.viaje(id,tenant_id,operador_id) values
  ('33900000-0000-4000-8000-000000000021','33900000-0000-4000-8000-000000000001','33900000-0000-4000-8000-000000000011'),
  ('33900000-0000-4000-8000-000000000022','33900000-0000-4000-8000-000000000002','33900000-0000-4000-8000-000000000012');

set local role service_role;
do $$
declare rechazo boolean;
begin
  rechazo := false;
  begin
    insert into public.jornada_derivacion_trabajo(tenant_id,operador_id,viaje_id,dia,aceptado_en)
    values ('33900000-0000-4000-8000-000000000001','33900000-0000-4000-8000-000000000012',
      '33900000-0000-4000-8000-000000000021','2026-09-04',clock_timestamp());
  exception when foreign_key_violation then rechazo := true;
  end;
  if not rechazo then raise exception '0339: service_role acepta operador de otro tenant'; end if;
  rechazo := false;
  begin
    insert into public.jornada_derivacion_trabajo(tenant_id,operador_id,viaje_id,dia,aceptado_en)
    values ('33900000-0000-4000-8000-000000000001','33900000-0000-4000-8000-000000000011',
      '33900000-0000-4000-8000-000000000022','2026-09-04',clock_timestamp());
  exception when foreign_key_violation then rechazo := true;
  end;
  if not rechazo then raise exception '0339: service_role acepta viaje de otro tenant'; end if;
  insert into public.jornada_derivacion_trabajo(tenant_id,operador_id,viaje_id,dia,aceptado_en)
  values ('33900000-0000-4000-8000-000000000001','33900000-0000-4000-8000-000000000011',
    '33900000-0000-4000-8000-000000000021','2026-09-04',clock_timestamp());
  if not exists (select 1 from public.jornada_derivacion_trabajo
    where tenant_id='33900000-0000-4000-8000-000000000001') then
    raise exception '0339: trabajo propio no persistió';
  end if;
end $$;
reset role;

-- DELETE del viaje debe conservar el contrato de cascada de0319.
delete from public.viaje where id='33900000-0000-4000-8000-000000000021';
do $$
declare f text; r text;
begin
  if exists (select 1 from public.jornada_derivacion_trabajo
    where tenant_id='33900000-0000-4000-8000-000000000001') then
    raise exception '0339: la cascada del viaje dejó trabajo huérfano';
  end if;
  foreach f in array array['validar_vinculo_gps_outbox','impedir_sello_por_aceptacion_wa',
    'reconciliar_vinculo_aviso_evento','reconciliar_receipt_wa_outbox'] loop
    foreach r in array array['anon','authenticated'] loop
      if has_function_privilege(r,format('public.%I()',f),'execute') then
        raise exception '0339: % conserva execute para %',f,r;
      end if;
    end loop;
  end loop;
  if exists (select 1 from pg_constraint
    where conrelid='public.jornada_derivacion_trabajo'::regclass
      and conname in ('jornada_trabajo_operador_tenant_fkey','jornada_trabajo_viaje_tenant_fkey')
      and not convalidated) then raise exception '0339: FK sin validar'; end if;
end $$;
rollback;
\echo '0339_jornada_integridad: PASS'
