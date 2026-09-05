-- 0329 — Task 3 ronda 2, forward-only.
-- Endurece el contrato creado por 0325 sin editar migraciones previas:
-- locks deterministas, journal GPS statement-level y versiones auditables.

-- La misma unidad puede aparecer en varios operadores. Un orden estable evita
-- que dos escritores adquieran los mutex de operadores en orden inverso.
create or replace function public.registrar_clave_jornada_viaje(
  p_tenant_id uuid, p_operador_id uuid, p_unidad_id uuid,
  p_aceptado_en timestamptz, p_motivo text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_zona text; v_dia date; v_operador uuid;
begin
  if p_tenant_id is null or p_operador_id is null or p_aceptado_en is null then return; end if;
  select zona_horaria into v_zona from public.tenant where id=p_tenant_id;
  if v_zona is null then return; end if;
  v_dia := (p_aceptado_en at time zone v_zona)::date;
  for v_operador in
    select distinct q.operador_id from (
      select p_operador_id as operador_id
      union all
      select v.operador_id from public.viaje v
       where p_unidad_id is not null and v.tenant_id=p_tenant_id and v.unidad_id=p_unidad_id
         and v.aceptado_en is not null
         and v.aceptado_en >= (v_dia::timestamp at time zone v_zona)
         and v.aceptado_en < ((v_dia+1)::timestamp at time zone v_zona)
    ) q order by q.operador_id
  loop
    perform public.registrar_invalidacion_jornada(p_tenant_id,v_operador,v_dia,
      case when v_operador=p_operador_id then p_motivo else p_motivo||':unidad-compartida' end);
  end loop;
end $$;

create or replace function public.registrar_clave_jornada_posicion(
  p_tenant_id uuid, p_unidad_id uuid, p_medida_en timestamptz, p_motivo text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_zona text; v_dia date; v_operador uuid;
begin
  if p_tenant_id is null or p_unidad_id is null or p_medida_en is null then return; end if;
  select zona_horaria into v_zona from public.tenant where id=p_tenant_id;
  if v_zona is null then return; end if;
  v_dia := (p_medida_en at time zone v_zona)::date;
  for v_operador in
    select distinct v.operador_id
      from public.viaje v
     where v.tenant_id=p_tenant_id and v.unidad_id=p_unidad_id
       and v.aceptado_en is not null
       and v.aceptado_en >= (v_dia::timestamp at time zone v_zona)
       and v.aceptado_en < ((v_dia+1)::timestamp at time zone v_zona)
     order by v.operador_id
  loop
    perform public.registrar_invalidacion_jornada(p_tenant_id,v_operador,v_dia,p_motivo);
  end loop;
end $$;

-- Una posición no genera una escritura de journal por fila. Las tablas de
-- transición permiten deduplicar la unidad/día una vez por sentencia.
create or replace function public.journal_jornada_desde_posiciones_insert_stmt()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record; v_zona text;
begin
  for r in select distinct on (n.tenant_id,n.unidad_id,(n.medida_en at time zone t.zona_horaria)::date) n.tenant_id,n.unidad_id,n.medida_en from new_rows n join public.tenant t on t.id=n.tenant_id order by n.tenant_id,n.unidad_id,(n.medida_en at time zone t.zona_horaria)::date,n.medida_en loop
    select zona_horaria into v_zona from public.tenant where id=r.tenant_id;
    if v_zona is null or (r.medida_en at time zone v_zona)::date < (clock_timestamp() at time zone v_zona)::date then
      perform public.registrar_clave_jornada_posicion(r.tenant_id,r.unidad_id,r.medida_en,'posicion:INSERT');
    end if;
  end loop;
  return null;
end $$;

create or replace function public.journal_jornada_desde_posiciones_delete_stmt()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select distinct on (o.tenant_id,o.unidad_id,(o.medida_en at time zone t.zona_horaria)::date) o.tenant_id,o.unidad_id,o.medida_en from old_rows o join public.tenant t on t.id=o.tenant_id order by o.tenant_id,o.unidad_id,(o.medida_en at time zone t.zona_horaria)::date,o.medida_en loop
    perform public.registrar_clave_jornada_posicion(r.tenant_id,r.unidad_id,r.medida_en,'posicion:DELETE');
  end loop;
  return null;
end $$;

create or replace function public.journal_jornada_desde_posiciones_update_stmt()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in
    select distinct on (x.tenant_id,x.unidad_id,(x.medida_en at time zone t.zona_horaria)::date) x.tenant_id,x.unidad_id,x.medida_en
      from old_rows o join new_rows n using (id)
      cross join lateral (select o.tenant_id,o.unidad_id,o.medida_en
                          union all
                          select n.tenant_id,n.unidad_id,n.medida_en) x
      join public.tenant t on t.id=x.tenant_id
     where (o.tenant_id,o.unidad_id,o.medida_en) is distinct from
           (n.tenant_id,n.unidad_id,n.medida_en)
     order by x.tenant_id,x.unidad_id,(x.medida_en at time zone t.zona_horaria)::date,x.medida_en
  loop
    perform public.registrar_clave_jornada_posicion(r.tenant_id,r.unidad_id,r.medida_en,'posicion:UPDATE');
  end loop;
  return null;
end $$;

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

-- No reabrir un expediente sólo humano (ni registrar una revisión si la
-- versión realmente no cambió). Los callers que ya anularon inferencias pasan
-- una versión nueva distinta y conservan el sello anterior.
create or replace function public.invalidar_sellos_jornada(
  p_jornada_id uuid,p_tenant_id uuid,p_input_version_anterior text,
  p_input_version_nueva text,p_motivo text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_dia public.jornada_dia%rowtype;
begin
  select * into v_dia from public.jornada_dia where id=p_jornada_id and tenant_id=p_tenant_id for update;
  if not found or v_dia.estado <> 'cerrado' and v_dia.conforme_operador_en is null and v_dia.conforme_wa_message_id is null then return false; end if;
  if p_input_version_anterior is not distinct from p_input_version_nueva then return false; end if;
  -- Una firma humana no puede ser invalidada por una mutación automática si
  -- el expediente jamás tuvo evidencia derivada. Las inferencias anuladas
  -- también cuentan: preservan el vínculo histórico de la revisión.
  if not exists (
    select 1 from public.jornada_asiento a
     where a.jornada_id=p_jornada_id and a.tenant_id=p_tenant_id
       and a.procedencia in ('hito_viaje','gps')
  ) then return false; end if;
  insert into public.jornada_revision_historial(
    tenant_id,jornada_id,input_version_anterior,input_version_nueva,estado_anterior,
    cerrado_en_anterior,cerrado_por_anterior,cerrado_por_email_anterior,
    conforme_operador_en_anterior,conforme_wa_message_id_anterior,invalidado_motivo)
  values(p_tenant_id,p_jornada_id,p_input_version_anterior,p_input_version_nueva,v_dia.estado,
    v_dia.cerrado_en,v_dia.cerrado_por,v_dia.cerrado_por_email,v_dia.conforme_operador_en,
    v_dia.conforme_wa_message_id,left(coalesce(nullif(btrim(p_motivo),''),'cambió la evidencia derivada'),500));
  update public.jornada_dia set estado='abierto',cerrado_en=null,cerrado_por=null,cerrado_por_email=null,
    conforme_operador_en=null,conforme_wa_message_id=null where id=p_jornada_id and tenant_id=p_tenant_id;
  return true;
end $$;

-- La invalidación sobrevive a la purga de la cola. Recupera la versión
-- confirmada desde el último asiento automático y calcula la nueva versión
-- desde las fuentes actuales antes de guardar el historial.
-- La versión nueva se captura al crear la clave del journal, antes de que la
-- cola pueda ser purgada. Así 0325 puede seguir haciendo la sincronización
-- completa y este trigger sólo añade el sello durable que le faltaba.
create or replace function public.sellar_invalidacion_jornada_versionada()
returns trigger language plpgsql security definer set search_path = '' as $$
declare j uuid; prev text; nuevo text; zona text;
begin
  select d.id into j from public.jornada_dia d
   where d.tenant_id=new.tenant_id and d.operador_id=new.operador_id and d.dia=new.dia for update;
  if j is null then return new; end if;
  select a.detalle->>'derivacion_input_version' into prev
    from public.jornada_asiento a where a.jornada_id=j and a.tenant_id=new.tenant_id
      and a.procedencia in ('hito_viaje','gps') order by a.created_at desc,a.id desc limit 1;
  select t.zona_horaria into zona from public.tenant t where t.id=new.tenant_id;
  with unidades as (
    select distinct v.unidad_id from public.viaje v
     where v.tenant_id=new.tenant_id and v.operador_id=new.operador_id
       and v.unidad_id is not null and v.aceptado_en is not null
       and v.aceptado_en >= (new.dia::timestamp at time zone zona)
       and v.aceptado_en < ((new.dia+1)::timestamp at time zone zona)
       and not exists (select 1 from public.viaje otro where otro.tenant_id=v.tenant_id
         and otro.unidad_id=v.unidad_id and otro.operador_id<>v.operador_id
         and otro.aceptado_en is not null
         and otro.aceptado_en >= (new.dia::timestamp at time zone zona)
         and otro.aceptado_en < ((new.dia+1)::timestamp at time zone zona))
  ), gps as (
    select (array_agg(p.medida_en order by p.medida_en,p.id))[1] primera_en,
           (array_agg(p.unidad_id order by p.medida_en,p.id))[1] primera_unidad,
           (array_agg(p.medida_en order by p.medida_en desc,p.id desc))[1] ultima_en,
           (array_agg(p.unidad_id order by p.medida_en desc,p.id desc))[1] ultima_unidad
      from public.posicion p join unidades u on u.unidad_id=p.unidad_id
     where p.tenant_id=new.tenant_id
       and p.medida_en >= (new.dia::timestamp at time zone zona)
       and p.medida_en < ((new.dia+1)::timestamp at time zone zona)
  )
  select md5(concat_ws('|',
    coalesce((select md5(string_agg(concat_ws(':',v.id::text,coalesce(v.unidad_id::text,'-'),v.aceptado_en::text),',' order by v.aceptado_en,v.id))
      from public.viaje v where v.tenant_id=new.tenant_id and v.operador_id=new.operador_id
       and v.aceptado_en is not null and v.aceptado_en >= (new.dia::timestamp at time zone zona)
       and v.aceptado_en < ((new.dia+1)::timestamp at time zone zona)), '-'),
    coalesce((select primera_en::text from gps),'-'),coalesce((select primera_unidad::text from gps),'-'),
    coalesce((select ultima_en::text from gps),'-'),coalesce((select ultima_unidad::text from gps),'-'))) into nuevo;
  if prev is not null and nuevo is not null and prev is distinct from nuevo then
    perform public.invalidar_sellos_jornada(j,new.tenant_id,prev,nuevo,new.motivo);
  end if;
  return new;
end $$;

drop trigger if exists jornada_invalida_versionada on public.jornada_derivacion_invalida;
create trigger jornada_invalida_versionada after insert or update of creado_en on public.jornada_derivacion_invalida
for each row execute function public.sellar_invalidacion_jornada_versionada();

revoke all on function public.journal_jornada_desde_posiciones_insert_stmt() from public,anon,authenticated;
revoke all on function public.journal_jornada_desde_posiciones_delete_stmt() from public,anon,authenticated;
revoke all on function public.journal_jornada_desde_posiciones_update_stmt() from public,anon,authenticated;
revoke all on function public.sellar_invalidacion_jornada_versionada() from public,anon,authenticated;
