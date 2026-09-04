-- GPS ronda 2: aceptación de Meta no es entrega.
alter table public.wa_outbox
  add column if not exists provider_status text;
alter table public.wa_outbox drop constraint if exists wa_outbox_provider_status_check;
alter table public.wa_outbox add constraint wa_outbox_provider_status_check
  check (provider_status is null or provider_status in ('accepted','delivered','read','failed'));
create index if not exists wa_outbox_provider_message_idx
  on public.wa_outbox(provider_message_id) where provider_message_id is not null;
do $$ begin
  if exists (select 1 from public.wa_outbox where provider_message_id is not null group by provider_message_id having count(*) > 1) then
    raise exception 'wa_outbox tiene provider_message_id duplicado; resolver antes de crear unicidad';
  end if;
end $$;
create unique index if not exists wa_outbox_provider_message_uidx
  on public.wa_outbox(provider_message_id) where provider_message_id is not null;

-- Sólo plantillas aprobadas pueden abrir una conversación. La quick reply es
-- parte del contrato de la plantilla GPS, no un interactive de sesión.
create or replace function public.encolar_wa_outbox_dedupe(
  p_dedupe_key text, p_payload jsonb, p_error text default null
) returns table (id uuid, estado text, provider_message_id text)
language plpgsql security definer set search_path = '' as $$
begin
  if btrim(coalesce(p_dedupe_key, '')) = '' or length(p_dedupe_key) > 300
     or p_dedupe_key not like 'gps:%' then raise exception 'dedupe_key GPS inválida'; end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or p_payload->>'to' is null or p_payload->>'type' <> 'template'
     or p_payload->'template'->>'name' is null
     or not exists (select 1 from jsonb_array_elements(coalesce(p_payload->'template'->'components','[]'::jsonb)) c
                    where c->>'type' = 'button' and c->>'sub_type' = 'quick_reply') then
    raise exception 'payload WA GPS requiere plantilla aprobada con quick reply';
  end if;
  return query insert into public.wa_outbox as o (dedupe_key,payload,ultimo_error)
    values (p_dedupe_key,p_payload,left(coalesce(p_error,'alerta GPS pendiente'),500))
    on conflict (dedupe_key) do update set dedupe_key=excluded.dedupe_key
    returning o.id,o.estado,o.provider_message_id;
end $$;
revoke all on function public.encolar_wa_outbox_dedupe(text,jsonb,text) from public,anon,authenticated;
grant execute on function public.encolar_wa_outbox_dedupe(text,jsonb,text) to service_role;

-- Reconciliación cubre receipt-before-link y sólo sella con delivered/read.
create or replace function public.sincronizar_aviso_evento_seguridad()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.provider_status in ('delivered','read') then
    update public.evento_seguridad_flota set aviso_estado='sent', aviso_receipt=new.provider_message_id,
      procesado_en=coalesce(new.enviada_en,clock_timestamp()), ultimo_error=null
      where aviso_outbox_id=new.id and procesado_en is null;
  elsif new.provider_status='failed' or new.estado='dead' then
    update public.evento_seguridad_flota set aviso_estado='dead', ultimo_error=left(coalesce(new.ultimo_error,'Meta rechazó el mensaje'),1000)
      where aviso_outbox_id=new.id and procesado_en is null;
  elsif new.estado in ('pending','sending') then
    update public.evento_seguridad_flota set aviso_estado=new.estado
      where aviso_outbox_id=new.id and procesado_en is null;
  end if;
  return new;
end $$;
drop trigger if exists wa_outbox_sincroniza_evento_seguridad on public.wa_outbox;
create trigger wa_outbox_sincroniza_evento_seguridad after update of estado,provider_message_id,provider_status on public.wa_outbox
for each row when (old.estado is distinct from new.estado or old.provider_message_id is distinct from new.provider_message_id or old.provider_status is distinct from new.provider_status)
execute function public.sincronizar_aviso_evento_seguridad();

create or replace function public.reconciliar_vinculo_aviso_evento()
returns trigger language plpgsql security definer set search_path = '' as $$
declare w record;
begin
  if new.aviso_outbox_id is not null and old.aviso_outbox_id is distinct from new.aviso_outbox_id then
    select estado, provider_status, provider_message_id, enviada_en, ultimo_error into w
      from public.wa_outbox where id=new.aviso_outbox_id;
    if w.provider_status in ('delivered','read') then
      new.aviso_estado := 'sent'; new.aviso_receipt := w.provider_message_id;
      new.procesado_en := coalesce(w.enviada_en, clock_timestamp()); new.ultimo_error := null;
    elsif w.provider_status='failed' or w.estado='dead' then
      new.aviso_estado := 'dead'; new.ultimo_error := left(coalesce(w.ultimo_error,'Meta rechazó el mensaje'),1000);
    elsif w.estado in ('pending','sending') then new.aviso_estado := w.estado;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists evento_reconcilia_aviso_outbox on public.evento_seguridad_flota;
create trigger evento_reconcilia_aviso_outbox before update of aviso_outbox_id on public.evento_seguridad_flota
for each row execute function public.reconciliar_vinculo_aviso_evento();

create or replace function public.impedir_sello_por_aceptacion_wa()
returns trigger language plpgsql security definer set search_path = '' as $$
declare s text;
begin
  if new.aviso_estado = 'sent' and new.aviso_outbox_id is not null then
    select provider_status into s from public.wa_outbox where id = new.aviso_outbox_id;
    if s not in ('delivered','read') then new.procesado_en := null; end if;
  end if;
  return new;
end $$;
drop trigger if exists evento_no_sella_accepted_wa on public.evento_seguridad_flota;
create trigger evento_no_sella_accepted_wa before update of aviso_estado,aviso_outbox_id on public.evento_seguridad_flota
for each row execute function public.impedir_sello_por_aceptacion_wa();

-- Entrada idempotente del webhook Meta (service_role únicamente).
create or replace function public.registrar_estado_wa_meta(
  p_wamid text, p_estado text, p_error text default null, p_ahora timestamptz default clock_timestamp()
) returns boolean language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if btrim(coalesce(p_wamid,''))='' or p_estado not in ('delivered','read','failed') then raise exception 'estado Meta inválido'; end if;
  update public.wa_outbox set provider_status=p_estado,
    ultimo_error=case when p_estado='failed' then left(coalesce(p_error,'Meta failed'),500) else null end,
    enviada_en=case when p_estado in ('delivered','read') then coalesce(enviada_en,p_ahora) else enviada_en end
    where provider_message_id=p_wamid
      and ((p_estado = 'failed' and provider_status not in ('delivered','read')) or
           coalesce((case provider_status when 'accepted' then 1 when 'delivered' then 2 when 'read' then 3 else 0 end),0)
             <= (case p_estado when 'accepted' then 1 when 'delivered' then 2 when 'read' then 3 else 0 end));
  get diagnostics n=row_count;
  if n = 1 and p_estado in ('delivered','read') then
    update public.evento_seguridad_flota e set aviso_estado='sent', aviso_receipt=p_wamid,
      procesado_en=coalesce(w.enviada_en,p_ahora), ultimo_error=null
      from public.wa_outbox w where e.aviso_outbox_id=w.id and w.provider_message_id=p_wamid
      and e.procesado_en is null;
  elsif n = 1 and p_estado='failed' then
    update public.evento_seguridad_flota e set aviso_estado='dead', ultimo_error=left(coalesce(p_error,'Meta failed'),1000)
      from public.wa_outbox w where e.aviso_outbox_id=w.id and w.provider_message_id=p_wamid
      and e.procesado_en is null;
  end if;
  return n=1;
end $$;
revoke all on function public.registrar_estado_wa_meta(text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.registrar_estado_wa_meta(text,text,text,timestamptz) to service_role;

comment on column public.wa_outbox.provider_status is 'Estado Meta: accepted sólo confirma aceptación; delivered/read confirman entrega.';
