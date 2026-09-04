-- 0331 R3: input_version durable, canónica y locks statement-level.
-- Cada expectativa es conductual: si se restaura NULL, el hash dependiente de
-- TimeZone, la invalidación desde el asiento o un trigger por fila, debe fallar.
begin;

do $$
declare v_triggers integer; v_pos_triggers integer;
begin
  if to_regprocedure('public.calcular_input_version_jornada(uuid,uuid,date)') is null then
    raise exception 'R3-01: falta calcular_input_version_jornada';
  end if;
  if not exists (select 1 from pg_attribute where attrelid='public.jornada_dia'::regclass
                  and attname='input_version' and not attisdropped and attnotnull) then
    raise exception 'R3-02: jornada_dia.input_version debe ser NOT NULL';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.jornada_dia'::regclass) then
    raise exception 'R3-03: jornada_dia perdió RLS';
  end if;
  select count(*) into v_triggers from pg_trigger
   where tgrelid='public.viaje'::regclass and not tgisinternal
     and tgname in ('viaje_journal_jornada_insert_stmt','viaje_journal_jornada_update_stmt','viaje_journal_jornada_delete_stmt')
     and (tgtype & 1)=0;
  if v_triggers<>3 then raise exception 'R3-04: deben existir tres triggers statement-level; hay %',v_triggers; end if;
  if exists(select 1 from pg_trigger where tgrelid='public.viaje'::regclass and not tgisinternal
            and tgname='viaje_journal_jornada') then
    raise exception 'R3-05: sigue activo el trigger row-level legado';
  end if;
  if not exists(select 1 from pg_trigger where tgrelid='public.viaje'::regclass
      and tgname='viaje_journal_jornada_update_stmt' and tgoldtable='old_rows'
      and tgnewtable='new_rows' and (tgtype & 1)=0) then
    raise exception 'R3-06: UPDATE no combina OLD+NEW en tablas de transición';
  end if;
  select count(*) into v_pos_triggers from pg_trigger
   where tgrelid='public.posicion'::regclass and not tgisinternal
     and tgname in ('posicion_journal_jornada_insert_stmt','posicion_journal_jornada_update_stmt','posicion_journal_jornada_delete_stmt')
     and (tgtype & 1)=0;
  if v_pos_triggers<>3 then raise exception 'R3-06b: deben existir tres triggers statement-level de posición; hay %',v_pos_triggers; end if;
  if not exists(select 1 from pg_trigger where tgrelid='public.posicion'::regclass
      and tgname='posicion_journal_jornada_update_stmt' and tgoldtable='old_rows'
      and tgnewtable='new_rows' and (tgtype & 1)=0) then
    raise exception 'R3-06c: UPDATE de posición no combina OLD+NEW';
  end if;
  if has_function_privilege('anon','public.calcular_input_version_jornada(uuid,uuid,date)','EXECUTE')
     or has_function_privilege('authenticated','public.calcular_input_version_jornada(uuid,uuid,date)','EXECUTE')
     or has_function_privilege('anon','public.inicializar_input_version_jornada()','EXECUTE')
     or has_function_privilege('authenticated','public.inicializar_input_version_jornada()','EXECUTE')
     or has_function_privilege('anon','public.reconciliar_input_version_jornada(uuid,uuid,date,text)','EXECUTE')
     or has_function_privilege('authenticated','public.reconciliar_input_version_jornada(uuid,uuid,date,text)','EXECUTE')
     or has_function_privilege('anon','public.materializar_input_version_jornada()','EXECUTE')
     or has_function_privilege('authenticated','public.materializar_input_version_jornada()','EXECUTE') then
    raise exception 'R3-07: funciones internas expuestas a anon/authenticated';
  end if;
end $$;

insert into public.tenant(id,nombre,zona_horaria) values
 ('33100000-0000-4000-8000-000000000001','Capacidad R3','America/Tijuana');
insert into public.operador(id,tenant_id,nombre,telefono,aviso_privacidad_en) values
 ('33100000-0000-4000-8000-000000000002','33100000-0000-4000-8000-000000000001','Operador R3','529331000001','2026-01-01');
insert into public.unidad(id,tenant_id,numero_economico) values
 ('33100000-0000-4000-8000-000000000003','33100000-0000-4000-8000-000000000001','R3-01');

do $$ declare v text; begin
  v:=public.calcular_input_version_jornada('33100000-0000-4000-8000-000000000001',
    '33100000-0000-4000-8000-000000000002','2026-07-15');
  if v is distinct from 'jornada-input:v1:sin-viajes' then
    raise exception 'R3-08: estado sin viajes no tiene sentinel canónica: %',v;
  end if;
end $$;

insert into public.viaje(id,tenant_id,operador_id,unidad_id,avisado_en,aceptado_en,estatus) values
 ('33100000-0000-4000-8000-000000000004','33100000-0000-4000-8000-000000000001',
  '33100000-0000-4000-8000-000000000002','33100000-0000-4000-8000-000000000003',
  '2026-07-15 14:59+00','2026-07-15 15:00+00','liquidado');

create temporary table audit_0331_timezone(version text not null);
set local timezone='UTC';
insert into audit_0331_timezone select public.calcular_input_version_jornada(
 '33100000-0000-4000-8000-000000000001','33100000-0000-4000-8000-000000000002','2026-07-15');
set local timezone='Asia/Tokyo';
insert into audit_0331_timezone select public.calcular_input_version_jornada(
 '33100000-0000-4000-8000-000000000001','33100000-0000-4000-8000-000000000002','2026-07-15');
do $$ begin
  if (select count(*) from audit_0331_timezone)<>2
     or (select count(distinct version) from audit_0331_timezone)<>1
     or exists(select 1 from audit_0331_timezone where version not like 'jornada-input:v1:%') then
    raise exception 'R3-09: input_version cambia con TimeZone de sesión';
  end if;
end $$;

insert into public.jornada_dia(id,tenant_id,operador_id,dia) values
 ('33100000-0000-4000-8000-000000000005','33100000-0000-4000-8000-000000000001',
  '33100000-0000-4000-8000-000000000002','2026-07-15');
insert into public.jornada_asiento(id,tenant_id,jornada_id,tipo,momento,procedencia,origen_ref,viaje_id,unidad_id,detalle) values
 ('33100000-0000-4000-8000-000000000006','33100000-0000-4000-8000-000000000001',
  '33100000-0000-4000-8000-000000000005','inicio_jornada','2026-07-15 15:00+00','hito_viaje',
  'viaje:33100000-0000-4000-8000-000000000004:aceptado_en','33100000-0000-4000-8000-000000000004',
  '33100000-0000-4000-8000-000000000003',jsonb_build_object('derivacion_input_version','legado'));
insert into public.jornada_derivacion_trabajo(
 tenant_id,operador_id,dia,viaje_id,unidad_id,unidad_ids,aceptado_en,input_version,viajes_version
) values (
 '33100000-0000-4000-8000-000000000001','33100000-0000-4000-8000-000000000002','2026-07-15',
 '33100000-0000-4000-8000-000000000004','33100000-0000-4000-8000-000000000003',
 array['33100000-0000-4000-8000-000000000003'::uuid],'2026-07-15 15:00+00','worker-v0','worker-v0');

update public.jornada_dia set input_version='jornada-input:v1:legacy-unverified',
 estado='cerrado',cerrado_en='2026-07-16 12:00+00',cerrado_por_email='contralor@r3.test'
 where id='33100000-0000-4000-8000-000000000005';
update public.jornada_derivacion_trabajo set processed_version='worker-ack-v0'
 where tenant_id='33100000-0000-4000-8000-000000000001'
   and operador_id='33100000-0000-4000-8000-000000000002' and dia='2026-07-15';

create temporary table audit_0331_v0 as select input_version from public.jornada_dia
 where id='33100000-0000-4000-8000-000000000005';
do $$ begin
  if exists(select 1 from public.jornada_dia where id='33100000-0000-4000-8000-000000000005'
            and (estado<>'abierto' or input_version='jornada-input:v1:legacy-unverified')) then
    raise exception 'R3-10: legacy NULL adoptó evidencia sin reabrir';
  end if;
  if not exists(select 1 from public.jornada_revision_historial
     where jornada_id='33100000-0000-4000-8000-000000000005'
       and input_version_anterior='jornada-input:v1:legacy-unverified'
       and input_version_nueva=(select input_version from audit_0331_v0)) then
    raise exception 'R3-11: historial no preservó sentinel legacy y versión canónica';
  end if;
end $$;

update public.jornada_dia set estado='cerrado',cerrado_en='2026-07-16 13:00+00',cerrado_por_email='contralor@r3.test'
 where id='33100000-0000-4000-8000-000000000005';
insert into public.viaje(id,tenant_id,operador_id,unidad_id,avisado_en,aceptado_en,estatus) values
 ('33100000-0000-4000-8000-000000000007','33100000-0000-4000-8000-000000000001',
  '33100000-0000-4000-8000-000000000002','33100000-0000-4000-8000-000000000003',
  '2026-07-15 16:59+00','2026-07-15 17:00+00','liquidado');
create temporary table audit_0331_v1 as select input_version from public.jornada_dia
 where id='33100000-0000-4000-8000-000000000005';
do $$ begin
  if (select input_version from audit_0331_v1)=(select input_version from audit_0331_v0)
     or exists(select 1 from public.jornada_dia where id='33100000-0000-4000-8000-000000000005' and estado<>'abierto') then
    raise exception 'R3-12: V0→V1 no cambió versión/reabrió';
  end if;
  if not exists(select 1 from public.jornada_revision_historial
     where jornada_id='33100000-0000-4000-8000-000000000005'
       and input_version_anterior=(select input_version from audit_0331_v0)
       and input_version_nueva=(select input_version from audit_0331_v1)) then
    raise exception 'R3-13: historial V0→V1 no usa la versión durable';
  end if;
end $$;

update public.jornada_dia set estado='cerrado',cerrado_en='2026-07-16 14:00+00',cerrado_por_email='contralor@r3.test'
 where id='33100000-0000-4000-8000-000000000005';
update public.viaje set aceptado_en=null where id='33100000-0000-4000-8000-000000000007';
do $$ begin
  if exists(select 1 from public.jornada_dia where id='33100000-0000-4000-8000-000000000005'
            and (estado<>'abierto' or input_version is distinct from (select input_version from audit_0331_v0))) then
    raise exception 'R3-14: V1→V0 no recuperó versión/reabrió';
  end if;
  if not exists(select 1 from public.jornada_revision_historial
     where jornada_id='33100000-0000-4000-8000-000000000005'
       and input_version_anterior=(select input_version from audit_0331_v1)
       and input_version_nueva=(select input_version from audit_0331_v0)) then
    raise exception 'R3-15: historial V1→V0 perdió las versiones durables';
  end if;
end $$;

rollback;
