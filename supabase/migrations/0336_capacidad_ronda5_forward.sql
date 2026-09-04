-- 0336 — Capacidad ronda 5, forward-only. No reescribe 0334 ni toca 0335.
-- El dia operativo actual omite ruido de jornadas abiertas, pero toda clave
-- sellada (o ya invalidada durante el mismo dia) conserva journal durable.

-- Guarda comun para UPDATE/DELETE y para carreras donde una mutacion ya
-- reabrio el expediente antes de que llegue la siguiente. Pasado/futuro
-- conservan el contrato previo; solo el dia local actual se filtra.
create or replace function public.registrar_invalidacion_jornada(
  p_tenant_id uuid,p_operador_id uuid,p_dia date,p_motivo text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_zona text;
begin
  if p_tenant_id is null or p_operador_id is null or p_dia is null then return; end if;
  select t.zona_horaria into v_zona from public.tenant t where t.id=p_tenant_id;
  if v_zona is null then return; end if;

  if p_dia=(clock_timestamp() at time zone v_zona)::date
     and not exists (
       select 1 from public.jornada_dia d
        where (d.tenant_id,d.operador_id,d.dia)=(p_tenant_id,p_operador_id,p_dia)
          and (d.estado='cerrado' or d.conforme_operador_en is not null
               or d.conforme_wa_message_id is not null)
     )
     and not exists (
       select 1 from public.jornada_derivacion_invalida i
        where (i.tenant_id,i.operador_id,i.dia)=(p_tenant_id,p_operador_id,p_dia)
     ) then
    return;
  end if;

  insert into public.jornada_derivacion_invalida as i(
    tenant_id,operador_id,dia,motivo
  ) values (
    p_tenant_id,p_operador_id,p_dia,
    left(coalesce(nullif(btrim(p_motivo),''),'cambio de evidencia'),500)
  )
  on conflict on constraint jornada_derivacion_invalida_clave do update
     set procesado_en=null,creado_en=clock_timestamp(),motivo=left(excluded.motivo,500);
end $$;

-- INSERT de viaje: toda unidad/dia se serializa antes de expandir operadores.
-- Luego solo pasan las claves historicas o las actuales con sello/journal. El
-- segundo query obtiene snapshot nuevo tras esperar el mutex y ve commits
-- concurrentes de viaje/GPS.
create or replace function public.journal_jornada_desde_viajes_insert_stmt()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in
    select distinct n.tenant_id,n.unidad_id,
           (n.aceptado_en at time zone t.zona_horaria)::date as dia
      from new_rows n join public.tenant t on t.id=n.tenant_id
     where n.unidad_id is not null and n.aceptado_en is not null
     order by n.tenant_id,dia,n.unidad_id
  loop
    perform public.bloquear_unidad_dia_jornada(r.tenant_id,r.unidad_id,r.dia);
  end loop;

  for r in
    with fuentes as materialized (
      select n.tenant_id,n.operador_id,n.unidad_id,
             (n.aceptado_en at time zone t.zona_horaria)::date as dia
        from new_rows n join public.tenant t on t.id=n.tenant_id
       where n.aceptado_en is not null
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
    )
    select c.tenant_id,c.operador_id,c.dia from claves c
      join public.tenant t on t.id=c.tenant_id
     where c.dia < (clock_timestamp() at time zone t.zona_horaria)::date
        or exists (
          select 1 from public.jornada_dia d
           where (d.tenant_id,d.operador_id,d.dia)=(c.tenant_id,c.operador_id,c.dia)
             and (d.estado='cerrado' or d.conforme_operador_en is not null
                  or d.conforme_wa_message_id is not null)
        )
        or exists (
          select 1 from public.jornada_derivacion_invalida i
           where (i.tenant_id,i.operador_id,i.dia)=(c.tenant_id,c.operador_id,c.dia)
        )
     order by c.tenant_id,c.operador_id,c.dia
  loop
    perform public.registrar_invalidacion_jornada(r.tenant_id,r.operador_id,r.dia,'viaje:INSERT');
  end loop;
  return null;
end $$;

-- INSERT GPS comparte exactamente el mutex y la seleccion de sellos. Aunque
-- llegue antes del primer viaje, el escritor del viaje ve el punto al tomar el
-- lock; si llega despues, el journal ya existente permite la segunda huella.
create or replace function public.journal_jornada_desde_posiciones_insert_stmt()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in
    select distinct n.tenant_id,n.unidad_id,
           (n.medida_en at time zone t.zona_horaria)::date as dia
      from new_rows n join public.tenant t on t.id=n.tenant_id
     order by n.tenant_id,dia,n.unidad_id
  loop
    perform public.bloquear_unidad_dia_jornada(r.tenant_id,r.unidad_id,r.dia);
  end loop;

  for r in
    with unidades_dia as materialized (
      select distinct n.tenant_id,n.unidad_id,
             (n.medida_en at time zone t.zona_horaria)::date as dia
        from new_rows n join public.tenant t on t.id=n.tenant_id
    ), claves as (
      select v.tenant_id,v.operador_id,u.dia from unidades_dia u
        join public.tenant t on t.id=u.tenant_id
        join public.viaje v on v.tenant_id=u.tenant_id and v.unidad_id=u.unidad_id
         and v.aceptado_en is not null
         and v.aceptado_en >= (u.dia::timestamp at time zone t.zona_horaria)
         and v.aceptado_en < ((u.dia+1)::timestamp at time zone t.zona_horaria)
    )
    select distinct c.tenant_id,c.operador_id,c.dia from claves c
      join public.tenant t on t.id=c.tenant_id
     where c.dia < (clock_timestamp() at time zone t.zona_horaria)::date
        or exists (
          select 1 from public.jornada_dia d
           where (d.tenant_id,d.operador_id,d.dia)=(c.tenant_id,c.operador_id,c.dia)
             and (d.estado='cerrado' or d.conforme_operador_en is not null
                  or d.conforme_wa_message_id is not null)
        )
        or exists (
          select 1 from public.jornada_derivacion_invalida i
           where (i.tenant_id,i.operador_id,i.dia)=(c.tenant_id,c.operador_id,c.dia)
        )
     order by c.tenant_id,c.operador_id,c.dia
  loop
    perform public.registrar_invalidacion_jornada(r.tenant_id,r.operador_id,r.dia,'posicion:INSERT');
  end loop;
  return null;
end $$;

revoke all on function public.registrar_invalidacion_jornada(uuid,uuid,date,text) from public,anon,authenticated;
revoke all on function public.journal_jornada_desde_viajes_insert_stmt() from public,anon,authenticated;
revoke all on function public.journal_jornada_desde_posiciones_insert_stmt() from public,anon,authenticated;

comment on function public.registrar_invalidacion_jornada(uuid,uuid,date,text) is
  'Journal durable: el dia actual solo escribe si la jornada esta sellada o la clave ya fue invalidada; dias no actuales conservan el contrato historico.';
