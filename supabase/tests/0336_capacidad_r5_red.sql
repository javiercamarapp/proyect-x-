-- 0336 R5: el dia operativo actual tambien invalida sellos, pero una jornada
-- abierta no produce journal por actividad normal. Usa zona con DST mientras
-- la sesion corre en otra zona para fijar que la autoridad es el tenant.
begin;
set local timezone='Asia/Tokyo';

create temporary table audit_0336_reloj as
select (clock_timestamp() at time zone 'America/Tijuana')::date as dia,
       (((clock_timestamp() at time zone 'America/Tijuana')::date::timestamp
          + interval '10 hours') at time zone 'America/Tijuana') as hora_10,
       (((clock_timestamp() at time zone 'America/Tijuana')::date::timestamp
          + interval '11 hours') at time zone 'America/Tijuana') as hora_11,
       (((clock_timestamp() at time zone 'America/Tijuana')::date::timestamp
          + interval '12 hours') at time zone 'America/Tijuana') as hora_12;

insert into public.tenant(id,nombre,zona_horaria) values
 ('33600000-0000-4000-8000-000000000001','Capacidad R5 actual','America/Tijuana');
insert into public.operador(id,tenant_id,nombre,telefono,aviso_privacidad_en) values
 ('33610000-0000-4000-8000-000000000001','33600000-0000-4000-8000-000000000001','Primer viaje','529336000001','2026-01-01'),
 ('33610000-0000-4000-8000-000000000002','33600000-0000-4000-8000-000000000001','Jornada abierta','529336000002','2026-01-01'),
 ('33610000-0000-4000-8000-000000000003','33600000-0000-4000-8000-000000000001','Update delete','529336000003','2026-01-01'),
 ('33610000-0000-4000-8000-000000000004','33600000-0000-4000-8000-000000000001','GPS sellado','529336000004','2026-01-01'),
 ('33610000-0000-4000-8000-000000000005','33600000-0000-4000-8000-000000000001','Compartida A','529336000005','2026-01-01'),
 ('33610000-0000-4000-8000-000000000006','33600000-0000-4000-8000-000000000001','Compartida B','529336000006','2026-01-01');
insert into public.unidad(id,tenant_id,numero_economico) values
 ('33630000-0000-4000-8000-000000000001','33600000-0000-4000-8000-000000000001','R5-PRIMERO'),
 ('33630000-0000-4000-8000-000000000002','33600000-0000-4000-8000-000000000001','R5-ABIERTA'),
 ('33630000-0000-4000-8000-000000000003','33600000-0000-4000-8000-000000000001','R5-UPDATE'),
 ('33630000-0000-4000-8000-000000000004','33600000-0000-4000-8000-000000000001','R5-GPS'),
 ('33630000-0000-4000-8000-000000000005','33600000-0000-4000-8000-000000000001','R5-COMPARTIDA');

-- RED principal: jornada actual cerrada sin viajes -> primer viaje actual.
insert into public.jornada_dia(
 id,tenant_id,operador_id,dia,estado,cerrado_en,cerrado_por_email
) select
 '33640000-0000-4000-8000-000000000001','33600000-0000-4000-8000-000000000001',
 '33610000-0000-4000-8000-000000000001',dia,'cerrado',hora_12,'actual@r5.test'
from audit_0336_reloj;
insert into public.viaje(id,tenant_id,operador_id,unidad_id,avisado_en,aceptado_en,estatus)
select '33620000-0000-4000-8000-000000000001','33600000-0000-4000-8000-000000000001',
 '33610000-0000-4000-8000-000000000001','33630000-0000-4000-8000-000000000001',
 hora_10-interval '1 minute',hora_10,'liquidado' from audit_0336_reloj;

do $$ begin
  if not exists (
    select 1 from public.jornada_dia d cross join audit_0336_reloj r
     where d.id='33640000-0000-4000-8000-000000000001'
       and d.dia=r.dia and d.estado='abierto' and d.cerrado_en is null
       and d.input_version<>'jornada-input:v1:sin-viajes'
       and d.input_version=public.calcular_input_version_jornada(d.tenant_id,d.operador_id,d.dia)
  ) then
    raise exception 'R5-01: primer viaje del dia operativo actual no reabrio/convergio';
  end if;
  if not exists (
    select 1 from public.jornada_revision_historial
     where jornada_id='33640000-0000-4000-8000-000000000001'
       and input_version_anterior='jornada-input:v1:sin-viajes'
       and input_version_nueva like 'jornada-input:v1:%'
       and cerrado_por_email_anterior='actual@r5.test'
  ) then raise exception 'R5-02: falta historial del primer viaje actual'; end if;
  if not exists (
    select 1 from public.viaje v cross join audit_0336_reloj r
     where v.id='33620000-0000-4000-8000-000000000001'
       and (v.aceptado_en at time zone 'America/Tijuana')::date=r.dia
  ) then raise exception 'R5-03: fixture no cayo en el dia DST del tenant'; end if;
end $$;

-- Actividad actual sobre una jornada abierta no debe amplificar el journal.
insert into public.jornada_dia(tenant_id,operador_id,dia)
select '33600000-0000-4000-8000-000000000001','33610000-0000-4000-8000-000000000002',dia
from audit_0336_reloj;
delete from public.jornada_derivacion_invalida where tenant_id='33600000-0000-4000-8000-000000000001';
insert into public.viaje(id,tenant_id,operador_id,unidad_id,avisado_en,aceptado_en,estatus)
select md5('336-r5-abierta-'||g)::uuid,'33600000-0000-4000-8000-000000000001',
 '33610000-0000-4000-8000-000000000002',
 case when g=1 then '33630000-0000-4000-8000-000000000002'::uuid else null end,
 r.hora_11-interval '1 minute',r.hora_11+make_interval(secs=>g),'liquidado'
from generate_series(1,500) g cross join audit_0336_reloj r;
update public.viaje set aceptado_en=aceptado_en+interval '1 second'
 where tenant_id='33600000-0000-4000-8000-000000000001'
   and operador_id='33610000-0000-4000-8000-000000000002';
delete from public.viaje
 where tenant_id='33600000-0000-4000-8000-000000000001'
   and operador_id='33610000-0000-4000-8000-000000000002'
   and unidad_id is null;
insert into public.posicion(tenant_id,unidad_id,lat,lng,medida_en,proveedor)
select '33600000-0000-4000-8000-000000000001','33630000-0000-4000-8000-000000000002',
 20,-89,hora_11,'r5-abierta' from audit_0336_reloj;
do $$ begin
  if exists(select 1 from public.jornada_derivacion_invalida
             where tenant_id='33600000-0000-4000-8000-000000000001'
               and operador_id='33610000-0000-4000-8000-000000000002') then
    raise exception 'R5-04: actividad actual abierta genero journal inutil';
  end if;
end $$;

-- UPDATE y DELETE actuales deben invalidar si la jornada si esta sellada.
insert into public.viaje(id,tenant_id,operador_id,unidad_id,avisado_en,aceptado_en,estatus)
select '33620000-0000-4000-8000-000000000003','33600000-0000-4000-8000-000000000001',
 '33610000-0000-4000-8000-000000000003','33630000-0000-4000-8000-000000000003',
 hora_10-interval '1 minute',hora_10,'liquidado' from audit_0336_reloj;
insert into public.jornada_dia(id,tenant_id,operador_id,dia,estado,cerrado_en,cerrado_por_email)
select '33640000-0000-4000-8000-000000000003','33600000-0000-4000-8000-000000000001',
 '33610000-0000-4000-8000-000000000003',dia,'cerrado',hora_12,'update@r5.test'
from audit_0336_reloj;
update public.viaje set aceptado_en=aceptado_en+interval '1 minute'
 where id='33620000-0000-4000-8000-000000000003';
do $$ begin
  if not exists(select 1 from public.jornada_dia d where id='33640000-0000-4000-8000-000000000003'
    and estado='abierto' and input_version=public.calcular_input_version_jornada(d.tenant_id,d.operador_id,d.dia)) then
    raise exception 'R5-05: UPDATE actual sellado no reabrio/convergio';
  end if;
end $$;
update public.jornada_dia set estado='cerrado',cerrado_en=clock_timestamp(),cerrado_por_email='delete@r5.test'
 where id='33640000-0000-4000-8000-000000000003';
delete from public.viaje where id='33620000-0000-4000-8000-000000000003';
do $$ begin
  if not exists(select 1 from public.jornada_dia where id='33640000-0000-4000-8000-000000000003'
    and estado='abierto' and input_version='jornada-input:v1:sin-viajes') then
    raise exception 'R5-06: DELETE actual sellado no reabrio/convergio';
  end if;
end $$;

-- GPS actual y ambiguedad por unidad compartida tambien cambian la huella.
insert into public.viaje(id,tenant_id,operador_id,unidad_id,avisado_en,aceptado_en,estatus)
select '33620000-0000-4000-8000-000000000004','33600000-0000-4000-8000-000000000001',
 '33610000-0000-4000-8000-000000000004','33630000-0000-4000-8000-000000000004',
 hora_10-interval '1 minute',hora_10,'liquidado' from audit_0336_reloj;
insert into public.jornada_dia(id,tenant_id,operador_id,dia,estado,cerrado_en,cerrado_por_email)
select '33640000-0000-4000-8000-000000000004','33600000-0000-4000-8000-000000000001',
 '33610000-0000-4000-8000-000000000004',dia,'cerrado',hora_12,'gps@r5.test'
from audit_0336_reloj;
insert into public.posicion(tenant_id,unidad_id,lat,lng,medida_en,proveedor)
select '33600000-0000-4000-8000-000000000001','33630000-0000-4000-8000-000000000004',
 20,-89,hora_11,'r5-sellada' from audit_0336_reloj;
do $$ begin
  if not exists(select 1 from public.jornada_dia d where id='33640000-0000-4000-8000-000000000004'
    and estado='abierto' and input_version=public.calcular_input_version_jornada(d.tenant_id,d.operador_id,d.dia)) then
    raise exception 'R5-07: GPS actual sellado no reabrio/convergio';
  end if;
end $$;

insert into public.viaje(id,tenant_id,operador_id,unidad_id,avisado_en,aceptado_en,estatus)
select '33620000-0000-4000-8000-000000000005','33600000-0000-4000-8000-000000000001',
 '33610000-0000-4000-8000-000000000005','33630000-0000-4000-8000-000000000005',
 hora_10-interval '1 minute',hora_10,'liquidado' from audit_0336_reloj;
insert into public.posicion(tenant_id,unidad_id,lat,lng,medida_en,proveedor)
select '33600000-0000-4000-8000-000000000001','33630000-0000-4000-8000-000000000005',
 20,-89,hora_11,'r5-compartida' from audit_0336_reloj;
insert into public.jornada_dia(id,tenant_id,operador_id,dia,estado,cerrado_en,cerrado_por_email)
select '33640000-0000-4000-8000-000000000005','33600000-0000-4000-8000-000000000001',
 '33610000-0000-4000-8000-000000000005',dia,'cerrado',hora_12,'compartida@r5.test'
from audit_0336_reloj;
insert into public.jornada_dia(tenant_id,operador_id,dia)
select '33600000-0000-4000-8000-000000000001','33610000-0000-4000-8000-000000000006',dia
from audit_0336_reloj;
delete from public.jornada_derivacion_invalida where tenant_id='33600000-0000-4000-8000-000000000001';
insert into public.viaje(id,tenant_id,operador_id,unidad_id,avisado_en,aceptado_en,estatus)
select '33620000-0000-4000-8000-000000000006','33600000-0000-4000-8000-000000000001',
 '33610000-0000-4000-8000-000000000006','33630000-0000-4000-8000-000000000005',
 hora_11-interval '1 minute',hora_11,'liquidado' from audit_0336_reloj;
do $$ begin
  if not exists(select 1 from public.jornada_dia d where id='33640000-0000-4000-8000-000000000005'
    and estado='abierto' and input_version=public.calcular_input_version_jornada(d.tenant_id,d.operador_id,d.dia)) then
    raise exception 'R5-08: unidad compartida actual no invalido al operador sellado';
  end if;
  if exists(select 1 from public.jornada_derivacion_invalida
    where tenant_id='33600000-0000-4000-8000-000000000001'
      and operador_id='33610000-0000-4000-8000-000000000006') then
    raise exception 'R5-09: unidad compartida creo journal para operador abierto';
  end if;
end $$;

rollback;
\echo '0336_capacidad_r5_red: PASS (actual+DST, no ruido, UPDATE/DELETE, GPS y unidad compartida)'
