-- 0334 R4: un cambio de huella nunca conserva un sello viejo ni se pierde
-- por mutar la PK que empareja las tablas de transicion.
begin;

insert into public.tenant(id,nombre,zona_horaria) values
 ('33300000-0000-4000-8000-000000000001','Capacidad R4','UTC');
insert into public.operador(id,tenant_id,nombre,telefono,aviso_privacidad_en) values
 ('33310000-0000-4000-8000-000000000001','33300000-0000-4000-8000-000000000001','Operador R4','529333000001','2026-01-01');
insert into public.unidad(id,tenant_id,numero_economico) values
 ('33330000-0000-4000-8000-000000000001','33300000-0000-4000-8000-000000000001','R4-01');

-- Un cierre heredado puede no tener asientos automaticos. La version
-- canonica es evidencia suficiente para invalidarlo; confirmarla sin reabrir
-- dejaria el sello aplicado a una entrada distinta de la durable.
insert into public.jornada_dia(
  id,tenant_id,operador_id,dia,estado,cerrado_en,cerrado_por_email
) values (
  '33340000-0000-4000-8000-000000000001',
  '33300000-0000-4000-8000-000000000001',
  '33310000-0000-4000-8000-000000000001',
  '2026-08-01','cerrado',
  '2026-08-02 12:00+00','contralor@r4.test'
);
update public.jornada_dia
   set input_version='jornada-input:v1:legacy-unverified'
 where id='33340000-0000-4000-8000-000000000001';

do $$
declare v_reconciliada boolean;
begin
  v_reconciliada:=public.reconciliar_input_version_jornada(
    '33300000-0000-4000-8000-000000000001',
    '33310000-0000-4000-8000-000000000001',
    '2026-08-01','R4 legacy sin asientos'
  );
  if not v_reconciliada then
    raise exception 'R4-01: la huella legacy sin asientos no se reconcilio';
  end if;
  if not exists (
    select 1 from public.jornada_dia
     where id='33340000-0000-4000-8000-000000000001'
       and estado='abierto'
       and cerrado_en is null
       and cerrado_por_email is null
       and input_version='jornada-input:v1:sin-viajes'
  ) then
    raise exception 'R4-02: se avanzo/conservo el sello sin reabrir legacy sin asientos';
  end if;
  if not exists (
    select 1 from public.jornada_revision_historial
     where jornada_id='33340000-0000-4000-8000-000000000001'
       and input_version_anterior='jornada-input:v1:legacy-unverified'
       and input_version_nueva='jornada-input:v1:sin-viajes'
       and estado_anterior='cerrado'
       and cerrado_por_email_anterior='contralor@r4.test'
  ) then
    raise exception 'R4-03: falta historial del cierre legacy sin asientos';
  end if;
end $$;

-- Si la invalidacion no puede demostrar una transicion automatica, el cierre
-- humano se conserva y la version durable tampoco puede adelantarse sola.
insert into public.jornada_dia(
  id,tenant_id,operador_id,dia,estado,cerrado_en,cerrado_por_email
) values (
  '33340000-0000-4000-8000-000000000002',
  '33300000-0000-4000-8000-000000000001',
  '33310000-0000-4000-8000-000000000001',
  '2026-08-02','cerrado','2026-08-03 12:00+00','humano@r4.test'
);
update public.jornada_dia set input_version='version-humana-sin-contrato'
 where id='33340000-0000-4000-8000-000000000002';

do $$
declare v_reconciliada boolean;
begin
  v_reconciliada:=public.reconciliar_input_version_jornada(
    '33300000-0000-4000-8000-000000000001',
    '33310000-0000-4000-8000-000000000001',
    '2026-08-02','R4 rechazo atomico'
  );
  if v_reconciliada then
    raise exception 'R4-04: reconciliador confirmo version aunque no invalido sello';
  end if;
  if not exists (
    select 1 from public.jornada_dia
     where id='33340000-0000-4000-8000-000000000002'
       and estado='cerrado'
       and cerrado_por_email='humano@r4.test'
       and input_version='version-humana-sin-contrato'
  ) then
    raise exception 'R4-05: rechazo de invalidacion no conservo sello+version atomicos';
  end if;
  if exists (
    select 1 from public.jornada_revision_historial
     where jornada_id='33340000-0000-4000-8000-000000000002'
  ) then
    raise exception 'R4-06: rechazo de invalidacion creo historial espurio';
  end if;
end $$;

-- El contrato del journal empareja OLD/NEW por id. Mutar esa PK debe quedar
-- prohibido explicitamente, no convertirse en un UPDATE invisible.
insert into public.viaje(
  id,tenant_id,operador_id,unidad_id,avisado_en,aceptado_en,estatus
) values (
  '33320000-0000-4000-8000-000000000001',
  '33300000-0000-4000-8000-000000000001',
  '33310000-0000-4000-8000-000000000001',
  '33330000-0000-4000-8000-000000000001',
  '2026-08-03 09:59+00','2026-08-03 10:00+00','abierto'
);

do $$
begin
  begin
    update public.viaje
       set id='33320000-0000-4000-8000-000000000002'
     where id='33320000-0000-4000-8000-000000000001';
    raise exception 'R4-07: viaje permitio mutar PK y el journal perdio OLD/NEW';
  exception when check_violation then
    null;
  end;
  if not exists (
    select 1 from public.viaje
     where id='33320000-0000-4000-8000-000000000001'
  ) or exists (
    select 1 from public.viaje
     where id='33320000-0000-4000-8000-000000000002'
  ) then
    raise exception 'R4-08: rechazo de PK viaje no fue atomico';
  end if;
end $$;

insert into public.posicion(
  id,tenant_id,unidad_id,lat,lng,medida_en,proveedor
) values (
  333500000001,
  '33300000-0000-4000-8000-000000000001',
  '33330000-0000-4000-8000-000000000001',
  20,-89,'2026-08-03 10:05+00','r4-pk'
);

do $$
begin
  begin
    update public.posicion set id=333500000002 where id=333500000001;
    raise exception 'R4-09: posicion permitio mutar PK y el journal perdio OLD/NEW';
  exception when check_violation then
    null;
  end;
  if not exists (select 1 from public.posicion where id=333500000001)
     or exists (select 1 from public.posicion where id=333500000002) then
    raise exception 'R4-10: rechazo de PK posicion no fue atomico';
  end if;
end $$;

do $$ begin
  if has_function_privilege('anon','public.bloquear_unidad_dia_jornada(uuid,uuid,date)','execute')
     or has_function_privilege('authenticated','public.bloquear_unidad_dia_jornada(uuid,uuid,date)','execute')
     or has_function_privilege('anon','public.prohibir_mutacion_pk_journal()','execute')
     or has_function_privilege('authenticated','public.prohibir_mutacion_pk_journal()','execute') then
    raise exception 'R4-11: helpers internos expuestos a anon/authenticated';
  end if;
end $$;

rollback;
\echo '0334_capacidad_r4_red: PASS (legacy/sin-viajes + avance atomico + PK inmutable + privilegios)'
