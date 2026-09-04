-- 0331 — Task 3 ronda 3, forward-only. No reescribe 0329.
-- Una sola versión canónica por expediente y un solo orden global de locks.

alter table public.jornada_dia add column if not exists input_version text;

create or replace function public.calcular_input_version_jornada(
  p_tenant_id uuid,
  p_operador_id uuid,
  p_dia date
) returns text
language sql
stable
security definer
set search_path = ''
as $$
with contexto as (
  select t.zona_horaria
    from public.tenant t
   where t.id=p_tenant_id
), viajes as (
  select v.id,v.unidad_id,v.aceptado_en
    from public.viaje v
    cross join contexto c
   where v.tenant_id=p_tenant_id
     and v.operador_id=p_operador_id
     and v.aceptado_en is not null
     and v.aceptado_en >= (p_dia::timestamp at time zone c.zona_horaria)
     and v.aceptado_en < ((p_dia+1)::timestamp at time zone c.zona_horaria)
), unidades as (
  select distinct v.unidad_id
    from viajes v
    cross join contexto c
   where v.unidad_id is not null
     and not exists (
       select 1
         from public.viaje o
        where o.tenant_id=p_tenant_id
          and o.unidad_id=v.unidad_id
          and o.operador_id<>p_operador_id
          and o.aceptado_en is not null
          and o.aceptado_en >= (p_dia::timestamp at time zone c.zona_horaria)
          and o.aceptado_en < ((p_dia+1)::timestamp at time zone c.zona_horaria)
     )
), gps as (
  select (array_agg(p.medida_en order by extract(epoch from p.medida_en),p.id))[1] as primera_en,
         (array_agg(p.unidad_id order by extract(epoch from p.medida_en),p.id))[1] as primera_unidad,
         (array_agg(p.medida_en order by extract(epoch from p.medida_en) desc,p.id desc))[1] as ultima_en,
         (array_agg(p.unidad_id order by extract(epoch from p.medida_en) desc,p.id desc))[1] as ultima_unidad
    from public.posicion p
    join unidades u on u.unidad_id=p.unidad_id
    cross join contexto c
   where p.tenant_id=p_tenant_id
     and p.medida_en >= (p_dia::timestamp at time zone c.zona_horaria)
     and p.medida_en < ((p_dia+1)::timestamp at time zone c.zona_horaria)
), huella_viajes as (
  select md5(coalesce(string_agg(
           concat_ws(':',v.id::text,coalesce(v.unidad_id::text,'-'),extract(epoch from v.aceptado_en)::text),
           ',' order by extract(epoch from v.aceptado_en),v.id
         ),'')) as valor,
         count(*) as cuantos
    from viajes v
)
select case when h.cuantos=0 then 'jornada-input:v1:sin-viajes'
       else 'jornada-input:v1:' || md5(concat_ws('|',h.valor,
         coalesce(extract(epoch from g.primera_en)::text,'-'),coalesce(g.primera_unidad::text,'-'),
         coalesce(extract(epoch from g.ultima_en)::text,'-'),coalesce(g.ultima_unidad::text,'-')))
       end
  from huella_viajes h cross join gps g
$$;

-- Un expediente cerrado previo a 0331 no puede adoptar como "confirmada" una
-- huella reconstruida hoy. El sentinel obliga a que su primer cambio relevante
-- pase por invalidación y deje el sello anterior en historial.
update public.jornada_dia d
   set input_version=case
     when d.estado='cerrado' or d.conforme_operador_en is not null
       then 'jornada-input:v1:legacy-unverified'
     else public.calcular_input_version_jornada(d.tenant_id,d.operador_id,d.dia)
   end
 where d.input_version is null;

alter table public.jornada_dia alter column input_version set not null;

create or replace function public.inicializar_input_version_jornada()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.input_version:=public.calcular_input_version_jornada(new.tenant_id,new.operador_id,new.dia);
  return new;
end;
$$;

drop trigger if exists jornada_input_version_inicial on public.jornada_dia;
create trigger jornada_input_version_inicial
before insert or update of tenant_id,operador_id,dia on public.jornada_dia
for each row execute function public.inicializar_input_version_jornada();

-- Único punto que compara, invalida y avanza la versión del expediente. La
-- fuente anterior es jornada_dia.input_version, no una cola purgable ni el
-- detalle de un asiento. El lock del expediente se toma después del lock del
-- journal y bajo el mismo orden (tenant,operador,día).
create or replace function public.reconciliar_input_version_jornada(
  p_tenant_id uuid,
  p_operador_id uuid,
  p_dia date,
  p_motivo text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_jornada_id uuid;
  v_anterior text;
  v_nueva text;
begin
  select d.id,d.input_version
    into v_jornada_id,v_anterior
    from public.jornada_dia d
   where d.tenant_id=p_tenant_id and d.operador_id=p_operador_id and d.dia=p_dia
   for update;
  if not found then return false; end if;

  v_nueva:=public.calcular_input_version_jornada(p_tenant_id,p_operador_id,p_dia);
  if v_anterior is not distinct from v_nueva then return false; end if;

  perform public.invalidar_sellos_jornada(
    v_jornada_id,p_tenant_id,v_anterior,v_nueva,
    coalesce(nullif(btrim(p_motivo),''),'input_version canónica cambió')
  );
  update public.jornada_dia set input_version=v_nueva
   where id=v_jornada_id and tenant_id=p_tenant_id;
  return true;
end;
$$;

-- Sustituye la comparación de 0329 basada en el último asiento por la fuente
-- durable. El trigger existente conserva su OID y usa este cuerpo nuevo.
create or replace function public.sellar_invalidacion_jornada_versionada()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.reconciliar_input_version_jornada(
    new.tenant_id,new.operador_id,new.dia,new.motivo
  );
  return new;
end;
$$;

-- Cada función construye primero TODO el conjunto afectado, incluida la
-- ambigüedad por unidad compartida, y sólo después muta el journal en el orden
-- exacto de su llave única (tenant_id,operador_id,dia).
create or replace function public.journal_jornada_desde_viajes_insert_stmt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare r record;
begin
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
      select v.tenant_id,v.operador_id,u.dia
        from unidades_dia u
        join public.tenant t on t.id=u.tenant_id
        join public.viaje v on v.tenant_id=u.tenant_id and v.unidad_id=u.unidad_id
          and v.aceptado_en is not null
          and v.aceptado_en >= (u.dia::timestamp at time zone t.zona_horaria)
          and v.aceptado_en < ((u.dia+1)::timestamp at time zone t.zona_horaria)
    )
    select tenant_id,operador_id,dia from claves
     order by tenant_id,operador_id,dia
  loop
    perform public.registrar_invalidacion_jornada(r.tenant_id,r.operador_id,r.dia,'viaje:INSERT');
  end loop;
  return null;
end;
$$;

create or replace function public.journal_jornada_desde_viajes_delete_stmt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare r record;
begin
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
      select v.tenant_id,v.operador_id,u.dia
        from unidades_dia u
        join public.tenant t on t.id=u.tenant_id
        join public.viaje v on v.tenant_id=u.tenant_id and v.unidad_id=u.unidad_id
          and v.aceptado_en is not null
          and v.aceptado_en >= (u.dia::timestamp at time zone t.zona_horaria)
          and v.aceptado_en < ((u.dia+1)::timestamp at time zone t.zona_horaria)
    )
    select tenant_id,operador_id,dia from claves
     order by tenant_id,operador_id,dia
  loop
    perform public.registrar_invalidacion_jornada(r.tenant_id,r.operador_id,r.dia,'viaje:DELETE');
  end loop;
  return null;
end;
$$;

create or replace function public.journal_jornada_desde_viajes_update_stmt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare r record;
begin
  for r in
    with fuentes as (
      select x.tenant_id,x.operador_id,x.unidad_id,
             (x.aceptado_en at time zone t.zona_horaria)::date as dia
        from old_rows o join new_rows n using(id)
        cross join lateral (values
          (o.tenant_id,o.operador_id,o.unidad_id,o.aceptado_en),
          (n.tenant_id,n.operador_id,n.unidad_id,n.aceptado_en)
        ) as x(tenant_id,operador_id,unidad_id,aceptado_en)
        join public.tenant t on t.id=x.tenant_id
       where (o.tenant_id,o.operador_id,o.unidad_id,o.aceptado_en)
               is distinct from (n.tenant_id,n.operador_id,n.unidad_id,n.aceptado_en)
         and x.aceptado_en is not null
    ), unidades_dia as (
      select distinct tenant_id,unidad_id,dia from fuentes where unidad_id is not null
    ), claves as (
      select tenant_id,operador_id,dia from fuentes
      union
      select v.tenant_id,v.operador_id,u.dia
        from unidades_dia u
        join public.tenant t on t.id=u.tenant_id
        join public.viaje v on v.tenant_id=u.tenant_id and v.unidad_id=u.unidad_id
          and v.aceptado_en is not null
          and v.aceptado_en >= (u.dia::timestamp at time zone t.zona_horaria)
          and v.aceptado_en < ((u.dia+1)::timestamp at time zone t.zona_horaria)
    )
    select tenant_id,operador_id,dia from claves
     order by tenant_id,operador_id,dia
  loop
    perform public.registrar_invalidacion_jornada(r.tenant_id,r.operador_id,r.dia,'viaje:UPDATE');
  end loop;
  return null;
end;
$$;

-- Las posiciones usan el mismo orden global. 0329 ya las hizo statement-level,
-- pero todavía recorría unidad antes que día y cada llamada expandía operadores
-- por separado; dos lotes multidía podían invertir los locks del journal.
create or replace function public.journal_jornada_desde_posiciones_insert_stmt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare r record;
begin
  for r in
    with unidades_dia as (
      select distinct n.tenant_id,n.unidad_id,
             (n.medida_en at time zone t.zona_horaria)::date as dia
        from new_rows n join public.tenant t on t.id=n.tenant_id
       where (n.medida_en at time zone t.zona_horaria)::date
               < (clock_timestamp() at time zone t.zona_horaria)::date
    ), claves as (
      select v.tenant_id,v.operador_id,u.dia
        from unidades_dia u
        join public.tenant t on t.id=u.tenant_id
        join public.viaje v on v.tenant_id=u.tenant_id and v.unidad_id=u.unidad_id
          and v.aceptado_en is not null
          and v.aceptado_en >= (u.dia::timestamp at time zone t.zona_horaria)
          and v.aceptado_en < ((u.dia+1)::timestamp at time zone t.zona_horaria)
    )
    select distinct tenant_id,operador_id,dia from claves
     order by tenant_id,operador_id,dia
  loop
    perform public.registrar_invalidacion_jornada(r.tenant_id,r.operador_id,r.dia,'posicion:INSERT');
  end loop;
  return null;
end;
$$;

create or replace function public.journal_jornada_desde_posiciones_delete_stmt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare r record;
begin
  for r in
    with unidades_dia as (
      select distinct o.tenant_id,o.unidad_id,
             (o.medida_en at time zone t.zona_horaria)::date as dia
        from old_rows o join public.tenant t on t.id=o.tenant_id
    ), claves as (
      select v.tenant_id,v.operador_id,u.dia
        from unidades_dia u
        join public.tenant t on t.id=u.tenant_id
        join public.viaje v on v.tenant_id=u.tenant_id and v.unidad_id=u.unidad_id
          and v.aceptado_en is not null
          and v.aceptado_en >= (u.dia::timestamp at time zone t.zona_horaria)
          and v.aceptado_en < ((u.dia+1)::timestamp at time zone t.zona_horaria)
    )
    select distinct tenant_id,operador_id,dia from claves
     order by tenant_id,operador_id,dia
  loop
    perform public.registrar_invalidacion_jornada(r.tenant_id,r.operador_id,r.dia,'posicion:DELETE');
  end loop;
  return null;
end;
$$;

create or replace function public.journal_jornada_desde_posiciones_update_stmt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
        ) as x(tenant_id,unidad_id,medida_en)
        join public.tenant t on t.id=x.tenant_id
       where (o.tenant_id,o.unidad_id,o.medida_en)
               is distinct from (n.tenant_id,n.unidad_id,n.medida_en)
    ), claves as (
      select v.tenant_id,v.operador_id,u.dia
        from unidades_dia u
        join public.tenant t on t.id=u.tenant_id
        join public.viaje v on v.tenant_id=u.tenant_id and v.unidad_id=u.unidad_id
          and v.aceptado_en is not null
          and v.aceptado_en >= (u.dia::timestamp at time zone t.zona_horaria)
          and v.aceptado_en < ((u.dia+1)::timestamp at time zone t.zona_horaria)
    )
    select distinct tenant_id,operador_id,dia from claves
     order by tenant_id,operador_id,dia
  loop
    perform public.registrar_invalidacion_jornada(r.tenant_id,r.operador_id,r.dia,'posicion:UPDATE');
  end loop;
  return null;
end;
$$;

drop trigger if exists viaje_journal_jornada on public.viaje;
drop trigger if exists viaje_journal_jornada_insert_stmt on public.viaje;
drop trigger if exists viaje_journal_jornada_delete_stmt on public.viaje;
drop trigger if exists viaje_journal_jornada_update_stmt on public.viaje;
create trigger viaje_journal_jornada_insert_stmt after insert on public.viaje
referencing new table as new_rows for each statement
execute function public.journal_jornada_desde_viajes_insert_stmt();
create trigger viaje_journal_jornada_delete_stmt after delete on public.viaje
referencing old table as old_rows for each statement
execute function public.journal_jornada_desde_viajes_delete_stmt();
create trigger viaje_journal_jornada_update_stmt after update on public.viaje
referencing old table as old_rows new table as new_rows for each statement
execute function public.journal_jornada_desde_viajes_update_stmt();

drop trigger if exists posicion_journal_jornada on public.posicion;
drop trigger if exists posicion_journal_jornada_insert_stmt on public.posicion;
drop trigger if exists posicion_journal_jornada_delete_stmt on public.posicion;
drop trigger if exists posicion_journal_jornada_update_stmt on public.posicion;
create trigger posicion_journal_jornada_insert_stmt after insert on public.posicion
referencing new table as new_rows for each statement
execute function public.journal_jornada_desde_posiciones_insert_stmt();
create trigger posicion_journal_jornada_delete_stmt after delete on public.posicion
referencing old table as old_rows for each statement
execute function public.journal_jornada_desde_posiciones_delete_stmt();
create trigger posicion_journal_jornada_update_stmt after update on public.posicion
referencing old table as old_rows new table as new_rows for each statement
execute function public.journal_jornada_desde_posiciones_update_stmt();

create or replace function public.materializar_input_version_jornada()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.tenant_id is not null then
    perform public.reconciliar_input_version_jornada(
      new.tenant_id,new.operador_id,new.dia,'procesamiento de jornada confirmó nueva input_version'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists jornada_input_version_materializada on public.jornada_derivacion_trabajo;
create trigger jornada_input_version_materializada
after update of processed_version on public.jornada_derivacion_trabajo
for each row when (old.processed_version is distinct from new.processed_version)
execute function public.materializar_input_version_jornada();

revoke all on function public.calcular_input_version_jornada(uuid,uuid,date) from public,anon,authenticated;
revoke all on function public.inicializar_input_version_jornada() from public,anon,authenticated;
revoke all on function public.reconciliar_input_version_jornada(uuid,uuid,date,text) from public,anon,authenticated;
revoke all on function public.materializar_input_version_jornada() from public,anon,authenticated;
revoke all on function public.journal_jornada_desde_viajes_insert_stmt() from public,anon,authenticated;
revoke all on function public.journal_jornada_desde_viajes_delete_stmt() from public,anon,authenticated;
revoke all on function public.journal_jornada_desde_viajes_update_stmt() from public,anon,authenticated;
revoke all on function public.journal_jornada_desde_posiciones_insert_stmt() from public,anon,authenticated;
revoke all on function public.journal_jornada_desde_posiciones_delete_stmt() from public,anon,authenticated;
revoke all on function public.journal_jornada_desde_posiciones_update_stmt() from public,anon,authenticated;
revoke all on function public.sellar_invalidacion_jornada_versionada() from public,anon,authenticated;

comment on column public.jornada_dia.input_version is
  'Huella durable jornada-input:v1 de todas las fuentes automáticas del expediente. Nunca NULL; sin viajes usa sentinel explícita y los cierres heredados quedan legacy-unverified hasta su primera reconciliación.';
