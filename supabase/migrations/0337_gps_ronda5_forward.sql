-- 0337 — GPS ronda 5. Forward-only: acuses atomicos, T2 monotono y trabajo
-- acotado del reconciliador. 0335/0336 quedan reservadas a DB/capacidad.

-- La evidencia de lectura puede llegar reintentada o fuera de orden. El estado
-- si progresa delivered -> read, pero la hora durable nunca retrocede.
create or replace function public.registrar_estado_wa_meta(
  p_wamid text, p_estado text, p_error text default null,
  p_ahora timestamptz default clock_timestamp()
) returns boolean language plpgsql security definer set search_path='' as $$
declare n int; r public.wa_meta_receipt%rowtype;
begin
  if nullif(btrim(p_wamid),'') is null or length(btrim(p_wamid))>500
     or p_estado not in ('delivered','read','failed') then
    raise exception 'estado Meta invalido';
  end if;
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
      when wa_meta_receipt.provider_status='delivered' and excluded.provider_status='read'
        then greatest(wa_meta_receipt.recibido_en,excluded.recibido_en)
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
  update public.wa_meta_receipt set reconciliado_en=clock_timestamp()
    where wamid=btrim(p_wamid) and n>0;
  return true;
end $$;
revoke all on function public.registrar_estado_wa_meta(text,text,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.registrar_estado_wa_meta(text,text,text,timestamptz)
  to service_role;

-- Un webhook puede traer miles de statuses. Una RPC por status multiplica la
-- latencia y, si el ultimo falla, Meta reintenta todo el lote. Esta frontera
-- recibe el arreglo completo en una sola transaccion. Ordena los wamid antes
-- de tomar advisory locks para que dos lotes solapados tampoco se interbloqueen.
create or replace function public.registrar_estados_wa_meta_lote(p_estados jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare
  v_total integer;
  v_procesados integer:=0;
  r record;
begin
  if p_estados is null or jsonb_typeof(p_estados)<>'array' then
    raise exception 'lote Meta requiere un arreglo JSON';
  end if;
  v_total:=jsonb_array_length(p_estados);
  if v_total>10000 then
    raise exception 'lote Meta excede 10000 estados';
  end if;

  -- Se valida el lote entero antes de la primera escritura. El cast de ahora
  -- tambien falla aqui, no despues de haber persistido una parte.
  if exists (
    select 1
    from jsonb_array_elements(p_estados) as e(valor)
    where jsonb_typeof(valor)<>'object'
       or nullif(btrim(valor->>'wamid'),'') is null
       or length(btrim(valor->>'wamid'))>500
       or coalesce(valor->>'estado','') not in ('delivered','read','failed')
       or nullif(valor->>'ahora','') is null
       or (valor->>'ahora')::timestamptz is null
  ) then
    raise exception 'estado Meta invalido en lote';
  end if;

  for r in
    with entradas as (
      select
        btrim(valor->>'wamid') as wamid,
        valor->>'estado' as estado,
        left(valor->>'error',500) as error,
        (valor->>'ahora')::timestamptz as ahora
      from jsonb_array_elements(p_estados) as e(valor)
    ), deduplicadas as (
      select
        wamid,
        case
          when bool_or(estado='read') then 'read'
          when bool_or(estado='delivered') then 'delivered'
          else 'failed'
        end as estado,
        case
          when bool_or(estado in ('read','delivered')) then null
          when bool_or(estado='failed' and coalesce(error,'') not like 'retryable:%')
            then max(error) filter(where estado='failed' and coalesce(error,'') not like 'retryable:%')
          else max(error) filter(where estado='failed')
        end as error,
        case
          when bool_or(estado in ('read','delivered'))
            then max(ahora) filter(where estado in ('read','delivered'))
          else max(ahora) filter(where estado='failed')
        end as ahora
      from entradas
      group by wamid
    )
    select wamid,estado,error,ahora from deduplicadas order by wamid
  loop
    perform public.registrar_estado_wa_meta(r.wamid,r.estado,r.error,r.ahora);
    v_procesados:=v_procesados+1;
  end loop;
  return v_procesados;
end $$;
revoke all on function public.registrar_estados_wa_meta_lote(jsonb)
  from public,anon,authenticated;
grant execute on function public.registrar_estados_wa_meta_lote(jsonb)
  to service_role;

-- El segundo campo evita ordenar todo un grupo con el mismo timestamp de Meta
-- antes de poder aplicar LIMIT. Es habitual que un lote comparta el segundo.
drop index if exists public.wa_meta_receipt_backlog_idx;
create index wa_meta_receipt_backlog_idx
  on public.wa_meta_receipt(recibido_en,wamid)
  where reconciliado_en is null and descartado_en is null;

-- Overfetch 4x: suficientes candidatos para saltar contencion normal sin que
-- p_limite=100 pueda recorrer y retener locks de todo el backlog. El techo
-- absoluto sigue siendo 4,000 porque p_limite ya esta validado en 1..1,000.
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
  if p_limite is null or p_limite<1 or p_limite>1000 then
    raise exception 'p_limite fuera de 1..1000';
  end if;
  for v_wamid in
    select wamid from public.wa_meta_receipt
    where reconciliado_en is null and descartado_en is null
    order by recibido_en,wamid
    limit least(4000,p_limite*4)
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
      if exists (select 1 from public.wa_outbox where provider_message_id=v_wamid) then
        continue;
      end if;
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
revoke all on function public.reconciliar_wa_meta_receipts(integer)
  from public,anon,authenticated;
grant execute on function public.reconciliar_wa_meta_receipts(integer)
  to service_role;
