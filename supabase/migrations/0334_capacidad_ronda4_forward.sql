-- 0334 — Capacidad ronda 4, forward-only. No reescribe 0329/0331/0333.
-- Serializa la ambiguedad unidad/dia antes de expandir operadores, hace
-- atomica la invalidacion/version durable y explicita que las PK del journal
-- no son mutables.

-- La regla general de 0329 sigue protegiendo cierres puramente humanos: una
-- llamada con versiones arbitrarias no los toca. Una pareja de versiones
-- canonicas, en cambio, demuestra que el reconciliador detecto una mutacion de
-- su entrada incluso si el dia legacy/sin-viajes nunca produjo asientos auto.
create or replace function public.invalidar_sellos_jornada(
  p_jornada_id uuid,p_tenant_id uuid,p_input_version_anterior text,
  p_input_version_nueva text,p_motivo text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_dia public.jornada_dia%rowtype;
begin
  select * into v_dia from public.jornada_dia
   where id=p_jornada_id and tenant_id=p_tenant_id for update;
  if not found
     or v_dia.estado <> 'cerrado'
        and v_dia.conforme_operador_en is null
        and v_dia.conforme_wa_message_id is null then
    return false;
  end if;
  if p_input_version_anterior is not distinct from p_input_version_nueva then
    return false;
  end if;
  if not exists (
    select 1 from public.jornada_asiento a
     where a.jornada_id=p_jornada_id and a.tenant_id=p_tenant_id
       and a.procedencia in ('hito_viaje','gps')
  ) and not (
    p_input_version_anterior like 'jornada-input:v1:%'
    and p_input_version_nueva like 'jornada-input:v1:%'
  ) then
    return false;
  end if;
  insert into public.jornada_revision_historial(
    tenant_id,jornada_id,input_version_anterior,input_version_nueva,estado_anterior,
    cerrado_en_anterior,cerrado_por_anterior,cerrado_por_email_anterior,
    conforme_operador_en_anterior,conforme_wa_message_id_anterior,invalidado_motivo)
  values(p_tenant_id,p_jornada_id,p_input_version_anterior,p_input_version_nueva,v_dia.estado,
    v_dia.cerrado_en,v_dia.cerrado_por,v_dia.cerrado_por_email,v_dia.conforme_operador_en,
    v_dia.conforme_wa_message_id,left(coalesce(nullif(btrim(p_motivo),''),'cambio la evidencia derivada'),500));
  update public.jornada_dia set estado='abierto',cerrado_en=null,cerrado_por=null,cerrado_por_email=null,
    conforme_operador_en=null,conforme_wa_message_id=null where id=p_jornada_id and tenant_id=p_tenant_id;
  return true;
end $$;

create or replace function public.reconciliar_input_version_jornada(
  p_tenant_id uuid,p_operador_id uuid,p_dia date,p_motivo text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_jornada_id uuid;
  v_anterior text;
  v_nueva text;
  v_tenia_sello boolean;
  v_invalidada boolean;
begin
  select d.id,d.input_version,
         d.estado='cerrado' or d.conforme_operador_en is not null
           or d.conforme_wa_message_id is not null
    into v_jornada_id,v_anterior,v_tenia_sello
    from public.jornada_dia d
   where d.tenant_id=p_tenant_id and d.operador_id=p_operador_id and d.dia=p_dia
   for update;
  if not found then return false; end if;

  v_nueva:=public.calcular_input_version_jornada(p_tenant_id,p_operador_id,p_dia);
  if v_anterior is not distinct from v_nueva then return false; end if;

  v_invalidada:=public.invalidar_sellos_jornada(
    v_jornada_id,p_tenant_id,v_anterior,v_nueva,
    coalesce(nullif(btrim(p_motivo),''),'input_version canonica cambio')
  );
  -- La version y el sello son una sola transicion: si habia sello y no se
  -- pudo archivar/reabrir, se conserva la version anterior para reintentar.
  if v_tenia_sello and not v_invalidada then return false; end if;

  update public.jornada_dia set input_version=v_nueva
   where id=v_jornada_id and tenant_id=p_tenant_id;
  return true;
end $$;

-- Mutex de transaccion exacto en significado (tenant,unidad,dia) y estable
-- entre sesiones. Los callers ordenan primero todas esas ternas; despues
-- adquieren los locks del journal en (tenant,operador,dia).
create or replace function public.bloquear_unidad_dia_jornada(
  p_tenant_id uuid,p_unidad_id uuid,p_dia date
) returns void language sql volatile security definer set search_path = '' as $$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'jornada-unidad-dia:v1:' || p_tenant_id::text || ':'
        || p_unidad_id::text || ':' || p_dia::text,
      0
    )
  )
$$;

create or replace function public.journal_jornada_desde_viajes_insert_stmt()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in
    select distinct n.tenant_id,n.unidad_id,
           (n.aceptado_en at time zone t.zona_horaria)::date as dia
      from new_rows n join public.tenant t on t.id=n.tenant_id
     where n.unidad_id is not null and n.aceptado_en is not null
       and (n.aceptado_en at time zone t.zona_horaria)::date
             < (clock_timestamp() at time zone t.zona_horaria)::date
     order by n.tenant_id,dia,n.unidad_id
  loop
    perform public.bloquear_unidad_dia_jornada(r.tenant_id,r.unidad_id,r.dia);
  end loop;
  for r in
    with fuentes as (
      select n.tenant_id,n.operador_id,n.unidad_id,
             (n.aceptado_en at time zone t.zona_horaria)::date as dia
        from new_rows n join public.tenant t on t.id=n.tenant_id
       where n.aceptado_en is not null
         and (n.aceptado_en at time zone t.zona_horaria)::date
               < (clock_timestamp() at time zone t.zona_horaria)::date
    ), unidades_dia as (
      select distinct tenant_id,unidad_id,dia from fuentes where unidad_id is not null
    ), claves as (
      select tenant_id,operador_id,dia from fuentes
      union
      select v.tenant_id,v.operador_id,u.dia from unidades_dia u
        join public.tenant t on t.id=u.tenant_id
        join public.viaje v on v.tenant_id=u.tenant_id and v.unidad_id=u.unidad_id
         and v.aceptado_en is not null
         and v.aceptado_en >= (u.dia::timestamp at time zone t.zona_horaria)
         and v.aceptado_en < ((u.dia+1)::timestamp at time zone t.zona_horaria)
    ) select tenant_id,operador_id,dia from claves order by tenant_id,operador_id,dia
  loop
    perform public.registrar_invalidacion_jornada(r.tenant_id,r.operador_id,r.dia,'viaje:INSERT');
  end loop;
  return null;
end $$;

create or replace function public.journal_jornada_desde_viajes_delete_stmt()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in
    select distinct o.tenant_id,o.unidad_id,
           (o.aceptado_en at time zone t.zona_horaria)::date as dia
      from old_rows o join public.tenant t on t.id=o.tenant_id
     where o.unidad_id is not null and o.aceptado_en is not null
     order by o.tenant_id,dia,o.unidad_id
  loop
    perform public.bloquear_unidad_dia_jornada(r.tenant_id,r.unidad_id,r.dia);
  end loop;
  for r in
    with fuentes as (
      select o.tenant_id,o.operador_id,o.unidad_id,
             (o.aceptado_en at time zone t.zona_horaria)::date as dia
        from old_rows o join public.tenant t on t.id=o.tenant_id
       where o.aceptado_en is not null
    ), unidades_dia as (
      select distinct tenant_id,unidad_id,dia from fuentes where unidad_id is not null
    ), claves as (
      select tenant_id,operador_id,dia from fuentes
      union
      select v.tenant_id,v.operador_id,u.dia from unidades_dia u
        join public.tenant t on t.id=u.tenant_id
        join public.viaje v on v.tenant_id=u.tenant_id and v.unidad_id=u.unidad_id
         and v.aceptado_en is not null
         and v.aceptado_en >= (u.dia::timestamp at time zone t.zona_horaria)
         and v.aceptado_en < ((u.dia+1)::timestamp at time zone t.zona_horaria)
    ) select tenant_id,operador_id,dia from claves order by tenant_id,operador_id,dia
  loop
    perform public.registrar_invalidacion_jornada(r.tenant_id,r.operador_id,r.dia,'viaje:DELETE');
  end loop;
  return null;
end $$;

create or replace function public.journal_jornada_desde_viajes_update_stmt()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in
    with fuentes as (
      select x.tenant_id,x.unidad_id,
             (x.aceptado_en at time zone t.zona_horaria)::date as dia
        from old_rows o join new_rows n using(id)
        cross join lateral (values
          (o.tenant_id,o.unidad_id,o.aceptado_en),
          (n.tenant_id,n.unidad_id,n.aceptado_en)
        ) x(tenant_id,unidad_id,aceptado_en)
        join public.tenant t on t.id=x.tenant_id
       where (o.tenant_id,o.unidad_id,o.aceptado_en)
               is distinct from (n.tenant_id,n.unidad_id,n.aceptado_en)
         and x.unidad_id is not null and x.aceptado_en is not null
    ) select distinct tenant_id,unidad_id,dia from fuentes
       order by tenant_id,dia,unidad_id
  loop
    perform public.bloquear_unidad_dia_jornada(r.tenant_id,r.unidad_id,r.dia);
  end loop;
  for r in
    with fuentes as (
      select x.tenant_id,x.operador_id,x.unidad_id,
             (x.aceptado_en at time zone t.zona_horaria)::date as dia
        from old_rows o join new_rows n using(id)
        cross join lateral (values
          (o.tenant_id,o.operador_id,o.unidad_id,o.aceptado_en),
          (n.tenant_id,n.operador_id,n.unidad_id,n.aceptado_en)
        ) x(tenant_id,operador_id,unidad_id,aceptado_en)
        join public.tenant t on t.id=x.tenant_id
       where (o.tenant_id,o.operador_id,o.unidad_id,o.aceptado_en)
               is distinct from (n.tenant_id,n.operador_id,n.unidad_id,n.aceptado_en)
         and x.aceptado_en is not null
    ), unidades_dia as (
      select distinct tenant_id,unidad_id,dia from fuentes where unidad_id is not null
    ), claves as (
      select tenant_id,operador_id,dia from fuentes
      union
      select v.tenant_id,v.operador_id,u.dia from unidades_dia u
        join public.tenant t on t.id=u.tenant_id
        join public.viaje v on v.tenant_id=u.tenant_id and v.unidad_id=u.unidad_id
         and v.aceptado_en is not null
         and v.aceptado_en >= (u.dia::timestamp at time zone t.zona_horaria)
         and v.aceptado_en < ((u.dia+1)::timestamp at time zone t.zona_horaria)
    ) select tenant_id,operador_id,dia from claves order by tenant_id,operador_id,dia
  loop
    perform public.registrar_invalidacion_jornada(r.tenant_id,r.operador_id,r.dia,'viaje:UPDATE');
  end loop;
  return null;
end $$;

create or replace function public.journal_jornada_desde_posiciones_insert_stmt()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in
    select distinct n.tenant_id,n.unidad_id,
           (n.medida_en at time zone t.zona_horaria)::date as dia
      from new_rows n join public.tenant t on t.id=n.tenant_id
     where (n.medida_en at time zone t.zona_horaria)::date
             < (clock_timestamp() at time zone t.zona_horaria)::date
     order by n.tenant_id,dia,n.unidad_id
  loop
    perform public.bloquear_unidad_dia_jornada(r.tenant_id,r.unidad_id,r.dia);
  end loop;
  for r in
    with unidades_dia as (
      select distinct n.tenant_id,n.unidad_id,
             (n.medida_en at time zone t.zona_horaria)::date as dia
        from new_rows n join public.tenant t on t.id=n.tenant_id
       where (n.medida_en at time zone t.zona_horaria)::date
               < (clock_timestamp() at time zone t.zona_horaria)::date
    ), claves as (
      select v.tenant_id,v.operador_id,u.dia from unidades_dia u
        join public.tenant t on t.id=u.tenant_id
        join public.viaje v on v.tenant_id=u.tenant_id and v.unidad_id=u.unidad_id
         and v.aceptado_en is not null
         and v.aceptado_en >= (u.dia::timestamp at time zone t.zona_horaria)
         and v.aceptado_en < ((u.dia+1)::timestamp at time zone t.zona_horaria)
    ) select distinct tenant_id,operador_id,dia from claves order by tenant_id,operador_id,dia
  loop
    perform public.registrar_invalidacion_jornada(r.tenant_id,r.operador_id,r.dia,'posicion:INSERT');
  end loop;
  return null;
end $$;

create or replace function public.journal_jornada_desde_posiciones_delete_stmt()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in
    select distinct o.tenant_id,o.unidad_id,
           (o.medida_en at time zone t.zona_horaria)::date as dia
      from old_rows o join public.tenant t on t.id=o.tenant_id
     order by o.tenant_id,dia,o.unidad_id
  loop
    perform public.bloquear_unidad_dia_jornada(r.tenant_id,r.unidad_id,r.dia);
  end loop;
  for r in
    with unidades_dia as (
      select distinct o.tenant_id,o.unidad_id,
             (o.medida_en at time zone t.zona_horaria)::date as dia
        from old_rows o join public.tenant t on t.id=o.tenant_id
    ), claves as (
      select v.tenant_id,v.operador_id,u.dia from unidades_dia u
        join public.tenant t on t.id=u.tenant_id
        join public.viaje v on v.tenant_id=u.tenant_id and v.unidad_id=u.unidad_id
         and v.aceptado_en is not null
         and v.aceptado_en >= (u.dia::timestamp at time zone t.zona_horaria)
         and v.aceptado_en < ((u.dia+1)::timestamp at time zone t.zona_horaria)
    ) select distinct tenant_id,operador_id,dia from claves order by tenant_id,operador_id,dia
  loop
    perform public.registrar_invalidacion_jornada(r.tenant_id,r.operador_id,r.dia,'posicion:DELETE');
  end loop;
  return null;
end $$;

create or replace function public.journal_jornada_desde_posiciones_update_stmt()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in
    with unidades_dia as (
      select distinct x.tenant_id,x.unidad_id,
             (x.medida_en at time zone t.zona_horaria)::date as dia
        from old_rows o join new_rows n using(id)
        cross join lateral (values
          (o.tenant_id,o.unidad_id,o.medida_en),
          (n.tenant_id,n.unidad_id,n.medida_en)
        ) x(tenant_id,unidad_id,medida_en)
        join public.tenant t on t.id=x.tenant_id
       where (o.tenant_id,o.unidad_id,o.medida_en)
               is distinct from (n.tenant_id,n.unidad_id,n.medida_en)
    ) select tenant_id,unidad_id,dia from unidades_dia
       order by tenant_id,dia,unidad_id
  loop
    perform public.bloquear_unidad_dia_jornada(r.tenant_id,r.unidad_id,r.dia);
  end loop;
  for r in
    with unidades_dia as (
      select distinct x.tenant_id,x.unidad_id,
             (x.medida_en at time zone t.zona_horaria)::date as dia
        from old_rows o join new_rows n using(id)
        cross join lateral (values
          (o.tenant_id,o.unidad_id,o.medida_en),
          (n.tenant_id,n.unidad_id,n.medida_en)
        ) x(tenant_id,unidad_id,medida_en)
        join public.tenant t on t.id=x.tenant_id
       where (o.tenant_id,o.unidad_id,o.medida_en)
               is distinct from (n.tenant_id,n.unidad_id,n.medida_en)
    ), claves as (
      select v.tenant_id,v.operador_id,u.dia from unidades_dia u
        join public.tenant t on t.id=u.tenant_id
        join public.viaje v on v.tenant_id=u.tenant_id and v.unidad_id=u.unidad_id
         and v.aceptado_en is not null
         and v.aceptado_en >= (u.dia::timestamp at time zone t.zona_horaria)
         and v.aceptado_en < ((u.dia+1)::timestamp at time zone t.zona_horaria)
    ) select distinct tenant_id,operador_id,dia from claves order by tenant_id,operador_id,dia
  loop
    perform public.registrar_invalidacion_jornada(r.tenant_id,r.operador_id,r.dia,'posicion:UPDATE');
  end loop;
  return null;
end $$;

create or replace function public.prohibir_mutacion_pk_journal()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if to_jsonb(old)->>'id' is distinct from to_jsonb(new)->>'id' then
    raise exception using
      errcode='23514',
      constraint='journal_pk_inmutable',
      message=tg_table_name || '.id es inmutable: identifica OLD/NEW en el journal de jornada';
  end if;
  return new;
end $$;

drop trigger if exists viaje_pk_journal_inmutable on public.viaje;
create trigger viaje_pk_journal_inmutable before update of id on public.viaje
for each row execute function public.prohibir_mutacion_pk_journal();
drop trigger if exists posicion_pk_journal_inmutable on public.posicion;
create trigger posicion_pk_journal_inmutable before update of id on public.posicion
for each row execute function public.prohibir_mutacion_pk_journal();

revoke all on function public.invalidar_sellos_jornada(uuid,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.reconciliar_input_version_jornada(uuid,uuid,date,text) from public,anon,authenticated;
revoke all on function public.bloquear_unidad_dia_jornada(uuid,uuid,date) from public,anon,authenticated;
revoke all on function public.prohibir_mutacion_pk_journal() from public,anon,authenticated;
revoke all on function public.journal_jornada_desde_viajes_insert_stmt() from public,anon,authenticated;
revoke all on function public.journal_jornada_desde_viajes_delete_stmt() from public,anon,authenticated;
revoke all on function public.journal_jornada_desde_viajes_update_stmt() from public,anon,authenticated;
revoke all on function public.journal_jornada_desde_posiciones_insert_stmt() from public,anon,authenticated;
revoke all on function public.journal_jornada_desde_posiciones_delete_stmt() from public,anon,authenticated;
revoke all on function public.journal_jornada_desde_posiciones_update_stmt() from public,anon,authenticated;

comment on function public.bloquear_unidad_dia_jornada(uuid,uuid,date) is
  'Mutex transaccional de ambiguedad GPS por tenant/unidad/dia. Todo trigger ordena estas claves antes de expandir y bloquear tenant/operador/dia.';
