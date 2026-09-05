-- Un puntero selecciona dos objetos inmutables. No modifica dinero ni firmas.
alter table public.liquidacion add column if not exists pdf_versionada boolean not null default false;

create or replace function public.liquidacion_pdf_versionada_regla()
returns trigger language plpgsql set search_path = public, pg_catalog as $$
declare v_base text := new.tenant_id::text || '/' || new.viaje_id::text;
begin
  if tg_op='UPDATE' and old.pdf_versionada and new.pdf_url is not null
     and new.pdf_url !~ ('^' || v_base || '-version-[0-9a-f-]{36}\.pdf$') then
    raise exception 'Un escritor anterior intentó sustituir un PDF versionado por una ruta legacy' using errcode='LP001';
  end if;
  if tg_op='UPDATE' and new.revision='ajustada'
     and (new.revision,new.revisada_en) is distinct from (old.revision,old.revisada_en) then
    if old.pdf_url is not null then
      if not old.pdf_versionada then
        raise exception 'Conservar primero ambos PDF legacy en una versión inmutable' using errcode='LP002';
      end if;
      new.pdf_historial := old.pdf_historial || jsonb_build_array(jsonb_build_object(
        'url',old.pdf_url,'operadorUrl',regexp_replace(old.pdf_url,'\.pdf$','-operador.pdf'),
        'archivadaEn',now()));
    end if;
    new.pdf_url := null;
    new.pdf_versionada := true;
    new.entregada_operador_en := null;
    new.avisada_oficina_en := null;
  end if;
  if new.pdf_url ~ ('^' || v_base || '-version-[0-9a-f-]{36}\.pdf$') then new.pdf_versionada:=true; end if;
  if tg_op='UPDATE' and old.pdf_versionada then new.pdf_versionada:=true; end if;
  return new;
end $$;
-- Orden posterior a trg_liquidacion_revision_regla: ve la revisión definitiva.
drop trigger if exists zzz_liquidacion_pdf_versionada on public.liquidacion;
create trigger zzz_liquidacion_pdf_versionada before insert or update on public.liquidacion
for each row execute function public.liquidacion_pdf_versionada_regla();

create or replace function public.publicar_pdf_liquidacion(
 p_tenant uuid,p_liquidacion uuid,p_viaje uuid,p_revision text,p_revisada_en timestamptz,
 p_anterior text,p_pdf text,p_cifras jsonb
) returns boolean language plpgsql security definer set search_path=public,pg_catalog as $$
declare l public.liquidacion%rowtype; v_base text := p_tenant::text || '/' || p_viaje::text;
begin
  -- Orden global: viaje antes de liquidación, como revisar/guardar_liquidacion.
  perform 1 from public.viaje where id=p_viaje and tenant_id=p_tenant for update;
  if not found then return false; end if;
  select * into l from public.liquidacion where id=p_liquidacion and tenant_id=p_tenant and viaje_id=p_viaje for update;
  if not found or l.revision is distinct from p_revision or l.revisada_en is distinct from p_revisada_en
     or l.pdf_url is distinct from p_anterior then return false; end if;
  if p_pdf !~ ('^' || v_base || '-version-[0-9a-f-]{36}\.pdf$') then return false; end if;
  if p_anterior is null and (l.revision<>'ajustada' or l.revisada_en is null) then return false; end if;
  if p_anterior is not null and (l.pdf_versionada or p_anterior<>v_base||'.pdf') then return false; end if;
  if p_cifras is distinct from jsonb_build_object(
    'totalComprobado',l.total_comprobado,'totalAnticipo',l.total_anticipo,'diferencia',l.diferencia,
    'estatus',l.estatus,'diferencias',l.diferencias,'iepsAcreditable',l.ieps_acreditable,
    'litrosDieselAcreditables',coalesce(l.litros_diesel_acreditables,0),
    'ivaAcreditable',l.iva_acreditable,'peajeAcreditable',l.peaje_acreditable) then return false; end if;
  -- Storage confirma los dos objetos antes de hacer visible el puntero.
  if not exists(select 1 from storage.objects where bucket_id='liquidaciones' and name=p_pdf)
     or not exists(select 1 from storage.objects where bucket_id='liquidaciones' and name=regexp_replace(p_pdf,'\.pdf$','-operador.pdf')) then return false; end if;
  update public.liquidacion set pdf_url=p_pdf,pdf_versionada=true where id=p_liquidacion and tenant_id=p_tenant;
  return true;
end $$;
revoke all on function public.publicar_pdf_liquidacion(uuid,uuid,uuid,text,timestamptz,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.publicar_pdf_liquidacion(uuid,uuid,uuid,text,timestamptz,text,text,jsonb) to service_role;
comment on function public.publicar_pdf_liquidacion(uuid,uuid,uuid,text,timestamptz,text,text,jsonb) is
'0346: CAS de revisión/cifras/puntero y verificación de ambos objetos; no cambia firma ni dinero. Ruta legacy sólo se copia a versión inmutable antes del ajuste.';
