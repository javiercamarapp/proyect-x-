-- Task 3 ronda 2: regresiones RED contra la implementación actual.
-- Ejecutar sólo sobre una base PG desechable ya migrada. Todo revierte.
begin;

-- R2-04: invalidar_sellos_jornada no debe reabrir una jornada cuyo único
-- asiento es humano. El caller debe demostrar que cambió una inferencia auto.
do $$
declare
  t uuid := '32700000-0000-4000-8000-000000000001';
  o uuid := '32710000-0000-4000-8000-000000000001';
  j uuid;
begin
  insert into public.tenant(id,nombre,zona_horaria)
  values (t,'R2 sellos humanos','America/Mexico_City');
  insert into public.operador(id,tenant_id,nombre,telefono,aviso_privacidad_en)
  values (o,t,'R2 operador','523270000001','2026-01-01');
  insert into public.jornada_dia(tenant_id,operador_id,dia,estado,cerrado_en,cerrado_por_email)
  values (t,o,'2026-09-01','cerrado','2026-09-02 12:00+00','humano@r2.test')
  returning id into j;
  insert into public.jornada_asiento(tenant_id,jornada_id,tipo,momento,procedencia,registrado_por_email)
  values (t,j,'inicio_jornada','2026-09-01 08:00+00','capturado_contralor','humano@r2.test');
  if public.invalidar_sellos_jornada(j,t,'version-humana-anterior','version-auto-nueva','mutación supuestamente automática') then
    raise exception 'R2-04 RED: invalidación reabrió sello puramente humano aunque no existe asiento automático';
  end if;
  if (select estado from public.jornada_dia where id=j) <> 'cerrado' then
    raise exception 'R2-04 RED: jornada humana dejó de estar cerrada';
  end if;
end;
$$;

-- R2-02: una posición no debe ejecutar un trigger FOR EACH ROW que escriba
-- journal por cada punto. El contrato exige operación set-based/statement-level
-- o invalidación explícita acotada, para que 50k puntos no amplifiquen WAL.
do $$
declare v_row_level boolean;
begin
  select (t.tgtype & 1) = 1 into v_row_level
    from pg_trigger t
   where t.tgrelid='public.posicion'::regclass
     and t.tgname='posicion_journal_jornada'
     and not t.tgisinternal;
  if v_row_level then
    raise exception 'R2-02 RED: posicion_journal_jornada sigue siendo FOR EACH ROW';
  end if;
end;
$$;

-- R2-05: un UPDATE de metadatos de la posición no cambia la clave de
-- evidencia y no debe abrir trabajo de jornada.
do $$
declare p_id bigint; v_n integer; t uuid := '32700000-0000-4000-8000-000000000005'; o uuid := '32710000-0000-4000-8000-000000000005'; u uuid := '32730000-0000-4000-8000-000000000005';
begin
  insert into public.tenant(id,nombre,zona_horaria) values(t,'R2 posición irrelevante','America/Mexico_City');
  insert into public.operador(id,tenant_id,nombre,telefono,aviso_privacidad_en) values(o,t,'R2 op','523270000005','2026-01-01');
  insert into public.unidad(id,tenant_id,numero_economico) values(u,t,'R2-IRREL');
  insert into public.viaje(id,tenant_id,operador_id,unidad_id,avisado_en,aceptado_en) values('32720000-0000-4000-8000-000000000005',t,o,u,'2026-09-01 11:59+00','2026-09-01 12:00+00');
  insert into public.posicion(tenant_id,unidad_id,lat,lng,medida_en,proveedor)
  values (t,u,20,-89,
          '2026-09-01 10:00+00','r2-irrel') returning id into p_id;
  delete from public.jornada_derivacion_invalida
   where tenant_id=t;
  update public.posicion set lat=20.1,lng=-89.1 where id=p_id;
  select count(*) into v_n from public.jornada_derivacion_invalida
   where tenant_id=t;
  if v_n <> 0 then raise exception 'R2-05 RED: update irrelevante creó invalidación'; end if;
end $$;

-- R2-06/R2-07: contratos estructurales que fijan las dos propiedades que no
-- se pueden observar como un orden de locks desde una sola sesión: el lock
-- global incluye el primario y la versión GPS usa sólo unidades exclusivas y
-- sus extremos, nunca el resto de posiciones del tenant.
do $$
declare f text;
begin
  select pg_get_functiondef('public.registrar_clave_jornada_viaje(uuid,uuid,uuid,timestamptz,text)'::regprocedure) into f;
  if f not like '%select distinct q.operador_id%' or f not like '%order by q.operador_id%' then
    raise exception 'R2-06 RED: lock primario/compartidos no tiene orden global';
  end if;
  select pg_get_functiondef('public.sellar_invalidacion_jornada_versionada()'::regprocedure) into f;
  if f not like '%with unidades as%' or f not like '%join unidades u%' then
    raise exception 'R2-07 RED: versión GPS no está acotada a unidades exclusivas';
  end if;
end $$;

rollback;
