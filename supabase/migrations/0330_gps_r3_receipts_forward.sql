-- 0330 — GPS Task 1 ronda 3. Forward-only; 0329 queda reservado a capacidad.
-- El webhook es una entrada durable: Meta puede avisar antes de que exista el
-- vínculo al outbox y también puede avisar por un wamid que no conocemos aún.
create table if not exists public.wa_meta_receipt (
  wamid text primary key,
  provider_status text not null check (provider_status in ('delivered','read','failed')),
  error text,
  recibido_en timestamptz not null default clock_timestamp(),
  reconciliado_en timestamptz
);
alter table public.wa_meta_receipt add column if not exists intentos integer not null default 0, add column if not exists descartado_en timestamptz;
alter table public.wa_meta_receipt enable row level security;
alter table public.wa_outbox
  add column if not exists provider_status_en timestamptz,
  add column if not exists delivered_en timestamptz;
revoke all on public.wa_meta_receipt from public, anon, authenticated;
grant select, insert, update on public.wa_meta_receipt to service_role;

drop index if exists public.wa_outbox_provider_message_idx;

create or replace function public.encolar_wa_outbox_dedupe(
  p_dedupe_key text, p_payload jsonb, p_error text default null
) returns table(id uuid, estado text, provider_message_id text)
language plpgsql security definer set search_path='' as $$
begin
  if btrim(coalesce(p_dedupe_key,''))='' or length(p_dedupe_key)>300 or p_dedupe_key not like 'gps:%'
     or p_payload is null or jsonb_typeof(p_payload)<>'object'
     or p_payload->>'messaging_product'<>'whatsapp'
     or coalesce(p_payload->>'to','') !~ '^[1-9][0-9]{7,14}$'
     or p_payload->>'type'<>'template'
     or p_payload->'template'->>'name' <> 'gps_alerta_critica'
     or p_payload->'template'->'language'->>'code' <> 'es_MX'
     or (case when jsonb_typeof(p_payload->'template'->'components')='array'
          then jsonb_array_length(p_payload->'template'->'components')<>2 else true end)
     or not exists (
       select 1 from jsonb_array_elements(case when jsonb_typeof(p_payload->'template'->'components')='array'
         then p_payload->'template'->'components' else '[]'::jsonb end) c
       where c->>'type'='body'
         and (case when jsonb_typeof(c->'parameters')='array' then jsonb_array_length(c->'parameters')=1 else false end)
         and c->'parameters'->0->>'type'='text'
         and nullif(btrim(c->'parameters'->0->>'text'),'') is not null)
     or not exists (
       select 1 from jsonb_array_elements(case when jsonb_typeof(p_payload->'template'->'components')='array'
         then p_payload->'template'->'components' else '[]'::jsonb end) c
       where c->>'type'='button' and c->>'sub_type'='quick_reply' and c->>'index'='0'
         and (case when jsonb_typeof(c->'parameters')='array' then jsonb_array_length(c->'parameters')=1 else false end)
         and c->'parameters'->0->>'type'='payload'
         and nullif(btrim(c->'parameters'->0->>'payload'),'') is not null) then
    raise exception 'payload WA GPS requiere plantilla gps_alerta_critica/es_MX/body/quick_reply/0';
  end if;
  return query insert into public.wa_outbox as o(dedupe_key,payload,ultimo_error)
    values(p_dedupe_key,p_payload,left(coalesce(p_error,'alerta GPS pendiente'),500))
    on conflict(dedupe_key) do update set dedupe_key=excluded.dedupe_key
    returning o.id,o.estado,o.provider_message_id;
end $$;
revoke all on function public.encolar_wa_outbox_dedupe(text,jsonb,text) from public,anon,authenticated;
grant execute on function public.encolar_wa_outbox_dedupe(text,jsonb,text) to service_role;

-- La finalización del envío distingue aceptación (accepted) de entrega.
create or replace function public.finalizar_wa_outbox(
  p_id uuid, p_token uuid, p_message_id text default null, p_error text default null
) returns table(ok boolean, muerta boolean)
language plpgsql security invoker set search_path=public,pg_catalog as $$
declare
  v_estado text;
  v_dead boolean := false;
  v_id text := nullif(btrim(p_message_id), '');
  v_ok boolean := false;
  v_rows integer := 0;
begin
  if v_id is not null then
    -- Todos los escritores toman advisory(wamid) antes de cualquier fila del
    -- receipt/outbox. El trigger BEFORE sólo lee: nunca invierte ese orden.
    perform pg_advisory_xact_lock(hashtextextended(v_id,0));
    update wa_outbox set estado='sent', provider_message_id=v_id, provider_status='accepted', provider_status_en=clock_timestamp(), enviada_en=clock_timestamp(),
      lease_token=null, lease_expires_at=null, ultimo_error=null
      where id=p_id and lease_token=p_token and estado='sending' returning estado into v_estado;
    get diagnostics v_rows=row_count;
    v_ok := v_rows=1;
  else
    v_dead := coalesce(p_error,'') like 'sin_wamid:%'
      or coalesce(p_error,'') like 'permanent:%'
      or coalesce(p_error,'') like 'terminal:%';
    update wa_outbox set estado=case when v_dead or intentos >= 8 then 'dead' else 'pending' end,
      proximo_intento_en=case when v_dead then '-infinity'::timestamptz else now()+make_interval(secs=>least(3600,15*power(2,least(intentos,8))::int)) end,
      lease_token=null, lease_expires_at=null, ultimo_error=left(coalesce(p_error,'fallo de envío'),500)
      where id=p_id and lease_token=p_token and estado='sending' returning estado into v_estado;
    get diagnostics v_rows=row_count;
    v_ok := v_rows=1;
  end if;
  return query select v_ok, coalesce(v_estado,'')='dead';
end $$;

-- Un receipt se inserta una sola vez y nunca se degrada read→delivered.
create or replace function public.registrar_estado_wa_meta(
  p_wamid text, p_estado text, p_error text default null, p_ahora timestamptz default clock_timestamp()
) returns boolean language plpgsql security definer set search_path='' as $$
declare n int; r public.wa_meta_receipt%rowtype;
begin
  if nullif(btrim(p_wamid),'') is null or length(btrim(p_wamid))>500
     or p_estado not in ('delivered','read','failed') then raise exception 'estado Meta inválido'; end if;
  perform pg_advisory_xact_lock(hashtextextended(btrim(p_wamid),0));
  insert into public.wa_meta_receipt(wamid,provider_status,error,recibido_en)
  values (btrim(p_wamid),p_estado,left(p_error,500),p_ahora)
  on conflict (wamid) do update set
    provider_status=case
      when wa_meta_receipt.provider_status='read' then 'read'
      when wa_meta_receipt.provider_status='delivered' and excluded.provider_status='read' then 'read'
      when wa_meta_receipt.provider_status='delivered' then 'delivered'
      when wa_meta_receipt.provider_status='failed' and coalesce(wa_meta_receipt.error,'') not like 'retryable:%' then 'failed'
      else excluded.provider_status end,
    error=case
      when wa_meta_receipt.provider_status in ('read','delivered') then null
      when wa_meta_receipt.provider_status='failed' and coalesce(wa_meta_receipt.error,'') not like 'retryable:%' then wa_meta_receipt.error
      when excluded.provider_status='failed' then left(excluded.error,500)
      else null end,
    recibido_en=case
      when wa_meta_receipt.provider_status='read' then wa_meta_receipt.recibido_en
      when wa_meta_receipt.provider_status='delivered' and excluded.provider_status='read' then excluded.recibido_en
      when wa_meta_receipt.provider_status='delivered' then wa_meta_receipt.recibido_en
      when wa_meta_receipt.provider_status='failed' and coalesce(wa_meta_receipt.error,'') not like 'retryable:%' then wa_meta_receipt.recibido_en
      when wa_meta_receipt.provider_status='failed' and excluded.provider_status in ('delivered','read') then excluded.recibido_en
      when wa_meta_receipt.provider_status='failed' and excluded.provider_status='failed'
        and coalesce(excluded.error,'') not like 'retryable:%' then excluded.recibido_en
      else wa_meta_receipt.recibido_en end
  returning * into r;
  update public.wa_outbox w set provider_status=r.provider_status,
    estado=case when r.provider_status in ('delivered','read') then 'sent'
      when r.provider_status='failed' and r.error like 'retryable:%' and w.estado<>'dead' then 'pending'
      when r.provider_status='failed' then 'dead' else w.estado end,
    ultimo_error=case when r.provider_status='failed' then coalesce(r.error,'Meta failed') else null end,
    provider_status_en=r.recibido_en,
    delivered_en=case when r.provider_status in ('delivered','read') then coalesce(w.delivered_en,r.recibido_en) else w.delivered_en end,
    proximo_intento_en=case
      when r.provider_status='failed' and r.error like 'retryable:%' and w.estado not in ('pending','dead')
        then clock_timestamp()+make_interval(secs=>least(3600,15*power(2,least(w.intentos,8))::int))
      when r.provider_status='failed' and r.error not like 'retryable:%' then '-infinity'::timestamptz
      else w.proximo_intento_en end,
    lease_token=case when r.provider_status in ('delivered','read','failed') then null else w.lease_token end,
    lease_expires_at=case when r.provider_status in ('delivered','read','failed') then null else w.lease_expires_at end
  where w.provider_message_id=r.wamid;
  get diagnostics n=row_count;
  update public.wa_meta_receipt set reconciliado_en=clock_timestamp() where wamid=btrim(p_wamid) and n>0;
  return true;
end $$;
revoke all on function public.registrar_estado_wa_meta(text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.registrar_estado_wa_meta(text,text,text,timestamptz) to service_role;

-- Reemplaza el trigger de 0328: `enviada_en` es T1 (aceptación), mientras
-- `delivered_en`/`reconciliado_en` es T2 (evidencia de entrega).
create or replace function public.sincronizar_aviso_evento_seguridad()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.estado in ('pending','sending') then
    update public.evento_seguridad_flota set aviso_estado=new.estado where aviso_outbox_id=new.id and procesado_en is null;
  elsif new.provider_status in ('delivered','read') then
    update public.evento_seguridad_flota set aviso_estado='sent', aviso_receipt=new.provider_message_id,
      procesado_en=coalesce(new.delivered_en,new.provider_status_en,new.enviada_en,clock_timestamp()), ultimo_error=null
      where aviso_outbox_id=new.id and procesado_en is null;
  elsif new.provider_status='failed' or new.estado='dead' then
    update public.evento_seguridad_flota set aviso_estado='dead', ultimo_error=left(coalesce(new.ultimo_error,'Meta rechazó el mensaje'),1000)
      where aviso_outbox_id=new.id and procesado_en is null;
  end if;
  return new;
end $$;

-- El evento también puede enlazarse después del receipt. En ese orden se usa
-- T2 (`delivered_en`), nunca T1 (`enviada_en`), y un failed retryable que ya
-- volvió a pending conserva su capacidad de reintento.
create or replace function public.reconciliar_vinculo_aviso_evento()
returns trigger language plpgsql security definer set search_path='' as $$
declare w record;
begin
  if new.aviso_outbox_id is not null and old.aviso_outbox_id is distinct from new.aviso_outbox_id then
    select estado,provider_status,provider_message_id,provider_status_en,delivered_en,enviada_en,ultimo_error into w
      from public.wa_outbox where id=new.aviso_outbox_id;
    if w.estado in ('pending','sending') then
      new.aviso_estado:=w.estado; new.procesado_en:=null; new.aviso_receipt:=null;
    elsif w.provider_status in ('delivered','read') then
      new.aviso_estado:='sent'; new.aviso_receipt:=w.provider_message_id;
      new.procesado_en:=coalesce(w.delivered_en,w.provider_status_en,w.enviada_en,clock_timestamp());
      new.ultimo_error:=null;
    elsif w.provider_status='failed' or w.estado='dead' then
      new.aviso_estado:='dead'; new.procesado_en:=null;
      new.ultimo_error:=left(coalesce(w.ultimo_error,'Meta rechazó el mensaje'),1000);
    end if;
  end if;
  return new;
end $$;

-- Receipt-before-link y link-before-receipt convergen al mismo estado.
create or replace function public.reconciliar_receipt_wa_outbox()
returns trigger language plpgsql security definer set search_path='' as $$
declare r record;
begin
  if new.provider_message_id is not null then
    select provider_status,error,recibido_en into r from public.wa_meta_receipt where wamid=new.provider_message_id;
    if r.provider_status is not null then
      new.provider_status := r.provider_status;
      new.provider_status_en:=r.recibido_en;
      if r.provider_status in ('delivered','read') then
        new.estado:='sent'; new.delivered_en:=coalesce(new.delivered_en,r.recibido_en);
        new.ultimo_error:=null; new.lease_token:=null; new.lease_expires_at:=null;
      elsif r.provider_status='failed' then
        if not (r.error like 'retryable:%' and new.estado='dead') then
          new.estado:=case when r.error like 'retryable:%' then 'pending' else 'dead' end;
        end if;
        new.ultimo_error:=coalesce(r.error,'Meta failed'); new.lease_token:=null; new.lease_expires_at:=null;
      end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists wa_outbox_reconciliar_receipt on public.wa_outbox;
create trigger wa_outbox_reconciliar_receipt before insert or update of provider_message_id,provider_status on public.wa_outbox
for each row execute function public.reconciliar_receipt_wa_outbox();

create or replace function public.reconciliar_wa_meta_receipts(p_limite integer default 100)
returns integer language plpgsql security definer set search_path='' as $$
declare v_wamid text; r public.wa_meta_receipt%rowtype; n integer:=0; v_rows integer;
begin
  if p_limite is null or p_limite<1 or p_limite>1000 then raise exception 'p_limite fuera de 1..1000'; end if;
  for v_wamid in select wamid from public.wa_meta_receipt where reconciliado_en is null and descartado_en is null order by recibido_en limit p_limite loop
    perform pg_advisory_xact_lock(hashtextextended(v_wamid,0));
    select * into r from public.wa_meta_receipt where wamid=v_wamid and reconciliado_en is null and descartado_en is null for update;
    if not found then continue; end if;
    update public.wa_outbox w set provider_status=x.provider_status,
      delivered_en=case when x.provider_status in ('delivered','read') then coalesce(w.delivered_en,x.recibido_en) else w.delivered_en end,
      estado=case when x.provider_status in ('delivered','read') then 'sent'
        when x.provider_status='failed' and x.error like 'retryable:%' and w.estado<>'dead' then 'pending'
        when x.provider_status='failed' then 'dead' else w.estado end,
      ultimo_error=case when x.provider_status='failed' then coalesce(x.error,'Meta failed') else null end,
      provider_status_en=x.recibido_en,
      proximo_intento_en=case
        when x.provider_status='failed' and x.error like 'retryable:%' and w.estado not in ('pending','dead')
          then clock_timestamp()+make_interval(secs=>least(3600,15*power(2,least(w.intentos,8))::int))
        when x.provider_status='failed' and x.error not like 'retryable:%' then '-infinity'::timestamptz
        else w.proximo_intento_en end,
      lease_token=case when x.provider_status in ('delivered','read','failed') then null else w.lease_token end,
      lease_expires_at=case when x.provider_status in ('delivered','read','failed') then null else w.lease_expires_at end
      from public.wa_meta_receipt x where x.wamid=v_wamid and w.provider_message_id=x.wamid;
    get diagnostics v_rows=row_count;
    if v_rows>0 then update public.wa_meta_receipt set reconciliado_en=clock_timestamp() where wamid=v_wamid; n:=n+1;
    else update public.wa_meta_receipt set intentos=intentos+1, descartado_en=case when intentos>=7 then clock_timestamp() else null end where wamid=v_wamid; end if;
  end loop;
  return n;
end $$;
revoke all on function public.reconciliar_wa_meta_receipts(integer) from public,anon,authenticated;
grant execute on function public.reconciliar_wa_meta_receipts(integer) to service_role;
drop index if exists public.wa_meta_receipt_backlog_idx;
create index wa_meta_receipt_backlog_idx on public.wa_meta_receipt(recibido_en) where reconciliado_en is null and descartado_en is null;
drop index if exists public.wa_meta_receipt_purga_idx;
create index wa_meta_receipt_purga_idx on public.wa_meta_receipt(recibido_en,wamid)
  where reconciliado_en is not null or descartado_en is not null;
create or replace function public.purgar_wa_meta_receipts(p_limite integer default 500)
returns integer language plpgsql security definer set search_path='' as $$
declare n integer; begin
  if p_limite is null or p_limite<1 or p_limite>5000 then raise exception 'p_limite fuera de 1..5000'; end if;
  with d as materialized (
    select wamid from public.wa_meta_receipt
    where (reconciliado_en is not null or descartado_en is not null)
      and recibido_en < clock_timestamp()-interval '90 days'
    order by recibido_en,wamid limit p_limite
    for update skip locked
  )
  delete from public.wa_meta_receipt r using d where r.wamid=d.wamid;
  get diagnostics n=row_count; return n;
end $$;
revoke all on function public.purgar_wa_meta_receipts(integer) from public,anon,authenticated;
grant execute on function public.purgar_wa_meta_receipts(integer) to service_role;

-- El vínculo debe ser del mismo tenant y sólo la dedupe GPS exacta puede unirlo.
create or replace function public.validar_vinculo_gps_outbox()
returns trigger language plpgsql security definer set search_path='' as $$
declare k text;
begin
  if new.aviso_outbox_id is not null then
    select dedupe_key into k from public.wa_outbox where id=new.aviso_outbox_id;
    if k is distinct from format('gps:%s:%s:%s',new.proveedor,new.tenant_id,new.evento_id_externo) then raise exception 'outbox GPS ajeno o dedupe incorrecta'; end if;
  end if;
  if new.aviso_estado='sent' and new.aviso_outbox_id is not null then
    if not exists (select 1 from public.wa_outbox where id=new.aviso_outbox_id and provider_status in ('delivered','read')) then
      new.aviso_estado:='pending'; new.procesado_en:=null; new.aviso_receipt:=null;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists evento_validar_vinculo_gps_outbox on public.evento_seguridad_flota;
create trigger evento_validar_vinculo_gps_outbox before insert or update of aviso_outbox_id,aviso_estado on public.evento_seguridad_flota
for each row execute function public.validar_vinculo_gps_outbox();

comment on table public.wa_meta_receipt is 'Ledger durable de acuses Meta, incluso wamid desconocido o recibido antes del vínculo al outbox.';
