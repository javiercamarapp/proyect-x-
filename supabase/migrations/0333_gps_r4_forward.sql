-- 0333 — GPS ronda 4. Forward-only: cotas de Meta y reconciliador sin HOL.

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
         and nullif(btrim(c->'parameters'->0->>'text'),'') is not null
         and char_length(c->'parameters'->0->>'text')<=1024)
     or not exists (
       select 1 from jsonb_array_elements(case when jsonb_typeof(p_payload->'template'->'components')='array'
         then p_payload->'template'->'components' else '[]'::jsonb end) c
       where c->>'type'='button' and c->>'sub_type'='quick_reply' and c->>'index'='0'
         and (case when jsonb_typeof(c->'parameters')='array' then jsonb_array_length(c->'parameters')=1 else false end)
         and c->'parameters'->0->>'type'='payload'
         and nullif(btrim(c->'parameters'->0->>'payload'),'') is not null
         and char_length(c->'parameters'->0->>'payload')<=256) then
    raise exception 'payload WA GPS requiere plantilla gps_alerta_critica/es_MX/body<=1024/quick_reply<=256/0';
  end if;
  return query insert into public.wa_outbox as o(dedupe_key,payload,ultimo_error)
    values(p_dedupe_key,p_payload,left(coalesce(p_error,'alerta GPS pendiente'),500))
    on conflict(dedupe_key) do update set dedupe_key=excluded.dedupe_key
    returning o.id,o.estado,o.provider_message_id;
end $$;
revoke all on function public.encolar_wa_outbox_dedupe(text,jsonb,text) from public,anon,authenticated;
grant execute on function public.encolar_wa_outbox_dedupe(text,jsonb,text) to service_role;

-- Orden global intacto: advisory(wamid) -> receipt -> outbox. Cada adquisición
-- que podría esperar usa try/skip locked; una fila ocupada queda para el
-- siguiente cron y las posteriores del lote siguen avanzando.
create or replace function public.reconciliar_wa_meta_receipts(p_limite integer default 100)
returns integer language plpgsql security definer set search_path='' as $$
declare
  v_wamid text;
  v_outbox_id uuid;
  r public.wa_meta_receipt%rowtype;
  n integer:=0;
  v_trabajados integer:=0;
  v_rows integer;
begin
  if p_limite is null or p_limite<1 or p_limite>1000 then raise exception 'p_limite fuera de 1..1000'; end if;
  for v_wamid in
    select wamid from public.wa_meta_receipt
    where reconciliado_en is null and descartado_en is null
    order by recibido_en
  loop
    exit when v_trabajados>=p_limite;
    if not pg_try_advisory_xact_lock(hashtextextended(v_wamid,0)) then continue; end if;

    select * into r from public.wa_meta_receipt
      where wamid=v_wamid and reconciliado_en is null and descartado_en is null
      for update skip locked;
    if not found then continue; end if;

    select id into v_outbox_id from public.wa_outbox
      where provider_message_id=v_wamid
      for update skip locked;
    if not found then
      -- Si existe pero está bloqueada, no consume un intento ni detiene el lote.
      if exists (select 1 from public.wa_outbox where provider_message_id=v_wamid) then continue; end if;
      update public.wa_meta_receipt set intentos=intentos+1,
        descartado_en=case when intentos>=7 then clock_timestamp() else null end
        where wamid=v_wamid;
      v_trabajados:=v_trabajados+1;
      continue;
    end if;

    update public.wa_outbox w set provider_status=r.provider_status,
      delivered_en=case when r.provider_status in ('delivered','read') then coalesce(w.delivered_en,r.recibido_en) else w.delivered_en end,
      estado=case when r.provider_status in ('delivered','read') then 'sent'
        when r.provider_status='failed' and r.error like 'retryable:%' and w.estado<>'dead' then 'pending'
        when r.provider_status='failed' then 'dead' else w.estado end,
      ultimo_error=case when r.provider_status='failed' then coalesce(r.error,'Meta failed') else null end,
      provider_status_en=r.recibido_en,
      proximo_intento_en=case
        when r.provider_status='failed' and r.error like 'retryable:%' and w.estado not in ('pending','dead')
          then clock_timestamp()+make_interval(secs=>least(3600,15*power(2,least(w.intentos,8))::int))
        when r.provider_status='failed' and r.error not like 'retryable:%' then '-infinity'::timestamptz
        else w.proximo_intento_en end,
      lease_token=null,
      lease_expires_at=null
      where w.id=v_outbox_id;
    get diagnostics v_rows=row_count;
    if v_rows>0 then
      update public.wa_meta_receipt set reconciliado_en=clock_timestamp() where wamid=v_wamid;
      n:=n+1;
      v_trabajados:=v_trabajados+1;
    end if;
  end loop;
  return n;
end $$;
revoke all on function public.reconciliar_wa_meta_receipts(integer) from public,anon,authenticated;
grant execute on function public.reconciliar_wa_meta_receipts(integer) to service_role;
