-- 0323 — Cal.com: ledger recuperable, identidad de reserva y embudo en una
-- sola transacción. Esta migración todavía no está desplegada en producción;
-- por eso se corrige aquí, sin crear una numeración posterior.

alter table public.prospecto
  add column if not exists calcom_booking_id text,
  add column if not exists calcom_booking_aliases text[] not null default '{}'::text[],
  add column if not exists calcom_evento_en timestamptz,
  add column if not exists calcom_evento_precedencia smallint,
  add column if not exists calcom_estado_antes_no_show text,
  add column if not exists correo_normalizado text
    generated always as (lower(btrim(correo))) stored;

comment on column public.prospecto.calcom_booking_id is
  'Identidad canónica namespaced de la reserva vigente: uid:<uid> preferido; id:<bookingId> sólo como fallback.';
comment on column public.prospecto.calcom_booking_aliases is
  'Identidades equivalentes namespaced de la reserva vigente (p. ej. uid:B e id:201). Nunca compara un bookingId numérico con un UID sin namespace.';
comment on column public.prospecto.calcom_evento_en is
  'Último createdAt firmado de Cal.com aplicado a la reserva vigente. NULL si sólo existe orden de llegada no confiable.';
comment on column public.prospecto.calcom_evento_precedencia is
  'Desempate del último createdAt: CREATED=0, RESCHEDULED=1, NO_SHOW false=2, true=3, CANCELLED=4.';
comment on column public.prospecto.calcom_estado_antes_no_show is
  'Estado activo que BOOKING_NO_SHOW_UPDATED debe restaurar cuando noShow cambia de true a false.';
comment on column public.prospecto.correo_normalizado is
  'Correo trim/lower generado para lookup exacto case-insensitive de webhooks; no depende de que el importador haya normalizado la fila.';

create index if not exists prospecto_correo_normalizado_vivo_idx
  on public.prospecto (correo_normalizado, updated_at desc)
  where duplicado_de is null and correo_normalizado is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'prospecto_calcom_estado_antes_no_show_dominio'
       and conrelid = 'public.prospecto'::regclass
  ) then
    alter table public.prospecto add constraint prospecto_calcom_estado_antes_no_show_dominio
      check (calcom_estado_antes_no_show is null or calcom_estado_antes_no_show in ('appointment', 'rescheduled'));
  end if;
end $$;

alter table public.comercial_evento
  add column if not exists estado_proceso text not null default 'legado',
  add column if not exists orden_en timestamptz,
  add column if not exists externo_aliases text[] not null default '{}'::text[],
  add column if not exists externo_anterior_aliases text[] not null default '{}'::text[],
  add column if not exists calcom_no_show boolean,
  add column if not exists orden_original_en timestamptz,
  add column if not exists vinculo_correo text,
  add column if not exists vinculo_error text,
  add column if not exists reintentos smallint not null default 0,
  add column if not exists reintentar_despues timestamptz not null default clock_timestamp(),
  add column if not exists clave_replay_hash text;

-- La clave operativa contiene el UID de Cal.com. Se conserva únicamente una
-- huella irreversible para que una reentrega posterior a la retención siga
-- siendo idempotente sin volver a guardar UID, correo ni payload.
update public.comercial_evento ce
   set clave_replay_hash = pg_catalog.encode(digest(
     pg_catalog.convert_to('calcom-replay:v1' || chr(10) || ce.clave_idempotencia, 'UTF8')
   , 'sha256'), 'hex')
 where ce.fuente = 'calcom'
   and ce.clave_replay_hash is null;

create unique index if not exists comercial_evento_calcom_replay_hash_uidx
  on public.comercial_evento (clave_replay_hash)
  where fuente = 'calcom' and clave_replay_hash is not null;

alter table public.comercial_evento
  drop constraint if exists comercial_evento_estado_proceso_dominio;
alter table public.comercial_evento add constraint comercial_evento_estado_proceso_dominio
  check (estado_proceso in (
    'legado', 'pendiente', 'esperando_vinculo', 'sin_prospecto',
    'aplicado', 'ignorado', 'cuarentena'
  ));

comment on column public.comercial_evento.estado_proceso is
  'Resultado durable. Sólo aplicado/ignorado/legado son finales; pendiente, esperando_vinculo, sin_prospecto y cuarentena pueden recuperarse por reentrega.';
comment on column public.comercial_evento.orden_en is
  'createdAt del sobre firmado. NULL no puede resucitar una reserva cancelada/no-show ni ordenar eventos entre reservas.';
comment on column public.comercial_evento.externo_aliases is
  'UID e id numérico namespaced que identifican la misma reserva Cal.com.';
comment on column public.comercial_evento.externo_anterior_aliases is
  'En RESCHEDULED, rescheduleUid y rescheduleId namespaced de la reserva anterior.';
comment on column public.comercial_evento.orden_original_en is
  'createdAt firmado aun durante cuarentena; permite reintentar al vencer sin pedir otra entrega a Cal.com.';
comment on column public.comercial_evento.vinculo_correo is
  'Correo normalizado del attendee para que el barrido durable resuelva sin depender del webhook original.';
comment on column public.comercial_evento.vinculo_error is
  'Diagnóstico durable del vínculo (sin_correo, sin_prospecto o correo_ambiguo).';
comment on column public.comercial_evento.clave_replay_hash is
  'SHA-256 con separación de dominio de la clave Cal.com original. Preserva idempotencia tras retención sin conservar el UID reversible.';

-- 0323 no está desplegada; DROP permite corregir también bases locales que
-- alcanzaron a crear la primera versión del índice bajo el mismo nombre.
drop index if exists public.comercial_evento_calcom_recuperable_idx;
create index comercial_evento_calcom_recuperable_idx
  on public.comercial_evento (reintentar_despues, creado_en, id)
  where fuente = 'calcom'
    and estado_proceso in ('pendiente', 'esperando_vinculo', 'sin_prospecto', 'cuarentena');

-- 0245 no conocía todavía los identificadores/correos añadidos por 0323. Una
-- purga que vacía payload pero conserva UID, aliases y correo sigue siendo
-- reversible. Tras el plazo se conserva el hecho/tipo/instante, no la llave
-- que permite volver a identificar la reserva en Cal.com.
create or replace function public.purgar_comercial_evento(
  p_dias integer default 365,
  p_ahora timestamptz default now()
) returns bigint
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  anonimizadas bigint;
  limite timestamptz := p_ahora - make_interval(days => p_dias);
begin
  if p_dias < 30 then
    raise exception 'purgar_comercial_evento: % días es demasiado poco; el mínimo es 30', p_dias using errcode = 'PU001';
  end if;
  update public.comercial_evento ce
     set payload = '{}'::jsonb,
         error = null,
         vinculo_correo = null,
         vinculo_error = null,
         externo_id = case when ce.fuente='calcom' then null else ce.externo_id end,
         externo_aliases = case when ce.fuente='calcom' then '{}'::text[] else ce.externo_aliases end,
         externo_anterior_aliases = case when ce.fuente='calcom' then '{}'::text[] else ce.externo_anterior_aliases end,
         clave_replay_hash = case when ce.fuente='calcom' then coalesce(
           ce.clave_replay_hash,
           pg_catalog.encode(digest(pg_catalog.convert_to(
             'calcom-replay:v1' || chr(10) || ce.clave_idempotencia, 'UTF8'
           ), 'sha256'), 'hex')
         ) else ce.clave_replay_hash end,
         clave_idempotencia = case when ce.fuente='calcom' then 'purgado:calcom:' || ce.id::text else ce.clave_idempotencia end,
         -- Un evento que ya excedió la retención no puede conservar identidad
         -- para ser reintentado. Se sella de forma final antes de anonimizarlo,
         -- evitando una poison pill recuperable sin UID/aliases.
         estado_proceso = case when ce.fuente='calcom' and ce.estado_proceso in (
           'pendiente','esperando_vinculo','sin_prospecto','cuarentena'
         ) then 'ignorado' else ce.estado_proceso end,
         procesado_en = case when ce.fuente='calcom' and ce.estado_proceso in (
           'pendiente','esperando_vinculo','sin_prospecto','cuarentena'
         ) then p_ahora else ce.procesado_en end
   where ce.ocurrido_en < limite
     and (
       ce.payload <> '{}'::jsonb or ce.error is not null
       or ce.vinculo_correo is not null or ce.vinculo_error is not null
       or (ce.fuente='calcom' and (
         ce.externo_id is not null or ce.externo_aliases <> '{}'::text[]
         or ce.externo_anterior_aliases <> '{}'::text[]
         or ce.clave_idempotencia not like 'purgado:calcom:%'
         or ce.clave_replay_hash is null
         or ce.estado_proceso in ('pendiente','esperando_vinculo','sin_prospecto','cuarentena')
       ))
     );
  get diagnostics anonimizadas = row_count;
  return anonimizadas;
end;
$$;

revoke all on function public.purgar_comercial_evento(integer,timestamptz) from public, anon, authenticated;
grant execute on function public.purgar_comercial_evento(integer,timestamptz) to service_role;

comment on function public.purgar_comercial_evento(integer,timestamptz) is
  '0323: anonimiza payload/error/correo y, para Cal.com, UID/aliases/clave después de la retención; conserva una huella SHA-256 no reversible para replay idempotente y sella cualquier estado ya irrecuperable.';

-- Durabilidad del reconciliador Bookings v2. Una ventana conserva límites
-- estables mientras el cursor avanza; sólo al consumirla completa se mueve el
-- watermark. Un crash conserva ventana/cursor y el lease fencing evita que el
-- worker viejo cierre el trabajo del nuevo.
create table if not exists public.calcom_sincronizacion_estado (
  singleton boolean primary key default true check (singleton),
  watermark_en timestamptz not null default (clock_timestamp() - interval '30 days'),
  ventana_hasta_en timestamptz,
  cursor_siguiente text,
  claim_token uuid,
  lease_expires_at timestamptz,
  webhook_verificado_en timestamptz,
  webhook_id text,
  ultimo_error text,
  updated_at timestamptz not null default clock_timestamp(),
  check ((claim_token is null) = (lease_expires_at is null))
);

alter table public.calcom_sincronizacion_estado enable row level security;
revoke all on table public.calcom_sincronizacion_estado from public, anon, authenticated;
insert into public.calcom_sincronizacion_estado(singleton) values (true)
on conflict (singleton) do nothing;

create or replace function public.iniciar_sincronizacion_calcom(
  p_lease_seconds integer default 100
)
returns table(
  claim_token uuid,
  desde_en timestamptz,
  ventana_hasta_en timestamptz,
  cursor_siguiente text,
  debe_provisionar boolean
)
language plpgsql
security definer
set search_path=''
as $$
declare
  v public.calcom_sincronizacion_estado%rowtype;
  v_token uuid := gen_random_uuid();
begin
  if p_lease_seconds < 10 or p_lease_seconds > 300 then
    raise exception 'lease Cal.com fuera de rango' using errcode='CR004';
  end if;
  select * into v from public.calcom_sincronizacion_estado where singleton for update;
  if v.claim_token is not null and v.lease_expires_at > clock_timestamp() then
    return;
  end if;
  update public.calcom_sincronizacion_estado s
     set claim_token=v_token,
         lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
         ventana_hasta_en=coalesce(s.ventana_hasta_en, clock_timestamp()),
         ultimo_error=null,
         updated_at=clock_timestamp()
   where s.singleton
   returning s.* into v;
  return query select v_token,
    greatest(v.watermark_en-interval '5 minutes', 'epoch'::timestamptz),
    v.ventana_hasta_en, v.cursor_siguiente,
    v.webhook_verificado_en is null
      or v.webhook_verificado_en < clock_timestamp()-interval '24 hours';
end;
$$;

create or replace function public.guardar_cursor_sincronizacion_calcom(
  p_claim_token uuid,
  p_cursor text,
  p_lease_seconds integer default 100
) returns boolean
language plpgsql security definer set search_path=''
as $$
begin
  if p_claim_token is null or nullif(btrim(p_cursor),'') is null
     or p_lease_seconds < 10 or p_lease_seconds > 300 then return false; end if;
  update public.calcom_sincronizacion_estado
     set cursor_siguiente=p_cursor,
         lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
         updated_at=clock_timestamp()
   where singleton and claim_token=p_claim_token
     and lease_expires_at > clock_timestamp();
  return found;
end;
$$;

create or replace function public.registrar_webhook_sincronizacion_calcom(
  p_claim_token uuid, p_webhook_id text
) returns boolean
language plpgsql security definer set search_path=''
as $$
begin
  update public.calcom_sincronizacion_estado
     set webhook_id=p_webhook_id, webhook_verificado_en=clock_timestamp(),
         updated_at=clock_timestamp()
   where singleton and claim_token=p_claim_token
     and lease_expires_at > clock_timestamp();
  return found;
end;
$$;

create or replace function public.pausar_sincronizacion_calcom(
  p_claim_token uuid
) returns boolean
language plpgsql security definer set search_path=''
as $$
begin
  update public.calcom_sincronizacion_estado
     set claim_token=null, lease_expires_at=null, updated_at=clock_timestamp()
   where singleton and claim_token=p_claim_token
     and lease_expires_at > clock_timestamp();
  return found;
end;
$$;

create or replace function public.fallar_sincronizacion_calcom(
  p_claim_token uuid, p_error text
) returns boolean
language plpgsql security definer set search_path=''
as $$
begin
  update public.calcom_sincronizacion_estado
     set claim_token=null, lease_expires_at=null,
         ultimo_error=left(coalesce(p_error,'fallo desconocido'),1000),
         updated_at=clock_timestamp()
   where singleton and claim_token=p_claim_token;
  return found;
end;
$$;

create or replace function public.finalizar_sincronizacion_calcom(
  p_claim_token uuid
) returns boolean
language plpgsql security definer set search_path=''
as $$
begin
  update public.calcom_sincronizacion_estado
     set watermark_en=greatest(watermark_en, ventana_hasta_en),
         ventana_hasta_en=null, cursor_siguiente=null,
         claim_token=null, lease_expires_at=null, ultimo_error=null,
         updated_at=clock_timestamp()
   where singleton and claim_token=p_claim_token
     and lease_expires_at > clock_timestamp()
     and ventana_hasta_en is not null;
  return found;
end;
$$;

revoke all on function public.iniciar_sincronizacion_calcom(integer) from public, anon, authenticated;
revoke all on function public.guardar_cursor_sincronizacion_calcom(uuid,text,integer) from public, anon, authenticated;
revoke all on function public.registrar_webhook_sincronizacion_calcom(uuid,text) from public, anon, authenticated;
revoke all on function public.pausar_sincronizacion_calcom(uuid) from public, anon, authenticated;
revoke all on function public.fallar_sincronizacion_calcom(uuid,text) from public, anon, authenticated;
revoke all on function public.finalizar_sincronizacion_calcom(uuid) from public, anon, authenticated;
grant execute on function public.iniciar_sincronizacion_calcom(integer) to service_role;
grant execute on function public.guardar_cursor_sincronizacion_calcom(uuid,text,integer) to service_role;
grant execute on function public.registrar_webhook_sincronizacion_calcom(uuid,text) to service_role;
grant execute on function public.pausar_sincronizacion_calcom(uuid) to service_role;
grant execute on function public.fallar_sincronizacion_calcom(uuid,text) to service_role;
grant execute on function public.finalizar_sincronizacion_calcom(uuid) to service_role;

-- Si una base local alcanzó a ejecutar la primera versión no desplegada de
-- 0323, se elimina su overload de siete argumentos: conservar dos máquinas de
-- estado bajo el mismo nombre haría que un llamador antiguo siguiera sellando
-- eventos recuperables como repetidos.
drop function if exists public.aplicar_evento_calcom_tx(
  text, text, text, uuid, jsonb, timestamptz, text
);
drop function if exists public.aplicar_evento_calcom_tx(
  text, text, text, uuid, jsonb, timestamptz, text, text[], text[], boolean
);

create or replace function public.aplicar_evento_calcom_tx(
  p_clave text,
  p_tipo text,
  p_externo text,
  p_prospecto uuid,
  p_payload jsonb,
  p_creado_en timestamptz default null,
  p_externo_anterior text default null,
  p_externos text[] default '{}'::text[],
  p_externos_anteriores text[] default '{}'::text[],
  p_no_show boolean default null,
  p_vinculo_correo text default null,
  p_error_vinculo text default null
)
returns table(resultado text, estado_prospecto text)
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_evento_id uuid;
  v_evento_estado text;
  v_evento_prospecto uuid;
  v_tipo text := upper(btrim(coalesce(p_tipo, '')));
  v_destino text;
  v_precedencia smallint;
  v_actual text;
  v_actual_canonico text;
  v_booking text;
  v_booking_aliases text[];
  v_ultimo_en timestamptz;
  v_ultima_precedencia smallint;
  v_antes_no_show text;
  v_aliases text[];
  v_aliases_anteriores text[];
  v_futuro boolean := p_creado_en is not null
    and p_creado_en > clock_timestamp() + interval '5 minutes';
  v_misma_reserva boolean;
  v_reserva_anterior boolean;
  v_pend record;
  v_pend_precedencia smallint;
  v_pend_destino text;
  v_replay_hash text;
begin
  if nullif(btrim(p_clave), '') is null
      or nullif(v_tipo, '') is null
      or nullif(btrim(p_externo), '') is null then
    raise exception 'evento Cal.com incompleto' using errcode = 'CR001';
  end if;
  v_replay_hash := pg_catalog.encode(digest(pg_catalog.convert_to(
    'calcom-replay:v1' || chr(10) || p_clave, 'UTF8'
  ), 'sha256'), 'hex');

  if v_tipo = 'BOOKING_NO_SHOW' then
    p_no_show := true;
  end if;
  if v_tipo = 'BOOKING_NO_SHOW_UPDATED' and p_no_show is null then
    raise exception 'BOOKING_NO_SHOW_UPDATED sin noShow' using errcode = 'CR002';
  end if;

  v_destino := case v_tipo
    when 'BOOKING_REQUESTED' then 'appointment'
    when 'BOOKING_CREATED' then 'appointment'
    when 'BOOKING_RESCHEDULED' then 'rescheduled'
    when 'BOOKING_CANCELLED' then 'cancelled'
    when 'BOOKING_REJECTED' then 'cancelled'
    when 'BOOKING_NO_SHOW' then 'no-show'
    when 'BOOKING_NO_SHOW_UPDATED' then case when p_no_show then 'no-show' else null end
    else null
  end;
  if v_destino is null and not (v_tipo = 'BOOKING_NO_SHOW_UPDATED' and p_no_show = false) then
    raise exception 'tipo Cal.com no soportado: %', v_tipo using errcode = 'CR002';
  end if;
  v_precedencia := case v_tipo
    when 'BOOKING_REQUESTED' then 0
    when 'BOOKING_CREATED' then 0
    when 'BOOKING_RESCHEDULED' then 1
    when 'BOOKING_NO_SHOW_UPDATED' then case when p_no_show then 3 else 2 end
    when 'BOOKING_NO_SHOW' then 3
    when 'BOOKING_CANCELLED' then 4
    when 'BOOKING_REJECTED' then 4
  end;

  select coalesce(array_agg(distinct btrim(x) order by btrim(x)), '{}'::text[])
    into v_aliases
    from unnest(coalesce(p_externos, '{}'::text[]) || array[p_externo]) x
   where nullif(btrim(x), '') is not null;
  select coalesce(array_agg(distinct btrim(x) order by btrim(x)), '{}'::text[])
    into v_aliases_anteriores
    from unnest(coalesce(p_externos_anteriores, '{}'::text[]) || array[p_externo_anterior]) x
   where nullif(btrim(x), '') is not null;

  insert into public.comercial_evento (
    clave_idempotencia, fuente, tipo, prospecto_id, externo_id, payload,
    ocurrido_en, orden_en, estado_proceso, externo_aliases,
    externo_anterior_aliases, calcom_no_show, orden_original_en,
    vinculo_correo, vinculo_error, clave_replay_hash
  ) values (
    p_clave, 'calcom', v_tipo, p_prospecto, p_externo, coalesce(p_payload, '{}'::jsonb),
    case when v_futuro then clock_timestamp() else coalesce(p_creado_en, clock_timestamp()) end,
    case when v_futuro then null else p_creado_en end,
    'pendiente', v_aliases, v_aliases_anteriores, p_no_show, p_creado_en,
    nullif(lower(btrim(p_vinculo_correo)), ''), p_error_vinculo, v_replay_hash
  )
  on conflict do nothing
  returning id into v_evento_id;

  if v_evento_id is null then
    select ce.id, ce.estado_proceso, ce.prospecto_id
      into v_evento_id, v_evento_estado, v_evento_prospecto
      from public.comercial_evento ce
     where ce.clave_idempotencia = p_clave
        or (ce.fuente = 'calcom' and ce.clave_replay_hash = v_replay_hash)
     order by (ce.clave_idempotencia = p_clave) desc, ce.creado_en, ce.id
     limit 1
     for update;

    if v_evento_estado in ('aplicado', 'ignorado', 'legado') then
      return query select 'repetido'::text,
        (select pr.estado from public.prospecto pr where pr.id = coalesce(v_evento_prospecto, p_prospecto));
      return;
    end if;
    if v_evento_prospecto is not null and p_prospecto is not null
       and v_evento_prospecto <> p_prospecto then
      update public.comercial_evento
         set estado_proceso = 'ignorado', procesado_en = clock_timestamp(),
             error = 'prospecto_conflictivo_en_reentrega'
       where id = v_evento_id;
      return query select 'ignorado'::text,
        (select pr.estado from public.prospecto pr where pr.id = v_evento_prospecto);
      return;
    end if;

    p_prospecto := coalesce(v_evento_prospecto, p_prospecto);
    update public.comercial_evento
       set prospecto_id = p_prospecto,
           tipo = v_tipo,
           externo_id = p_externo,
           payload = coalesce(p_payload, '{}'::jsonb),
           ocurrido_en = case when v_futuro then clock_timestamp() else coalesce(p_creado_en, clock_timestamp()) end,
           orden_en = case when v_futuro then null else p_creado_en end,
           estado_proceso = 'pendiente', procesado_en = null, error = null,
           externo_aliases = v_aliases,
           externo_anterior_aliases = v_aliases_anteriores,
           calcom_no_show = p_no_show,
           orden_original_en = p_creado_en,
           vinculo_correo = coalesce(nullif(lower(btrim(p_vinculo_correo)), ''), vinculo_correo),
           vinculo_error = p_error_vinculo
     where id = v_evento_id;
  end if;

  if v_futuro then
    update public.comercial_evento
       set estado_proceso = 'cuarentena', procesado_en = clock_timestamp(),
           error = 'created_at_futuro'
     where id = v_evento_id;
    return query select 'cuarentena'::text,
      (select pr.estado from public.prospecto pr where pr.id = p_prospecto);
    return;
  end if;

  if p_prospecto is null then
    update public.comercial_evento
       set estado_proceso = 'sin_prospecto', procesado_en = clock_timestamp(),
           error = coalesce(nullif(p_error_vinculo, ''), 'sin_prospecto'),
           vinculo_error = coalesce(nullif(p_error_vinculo, ''), 'sin_prospecto')
     where id = v_evento_id;
    return query select 'sin_prospecto'::text, null::text;
    return;
  end if;

  select pr.estado, pr.calcom_booking_id, pr.calcom_booking_aliases,
         pr.calcom_evento_en, pr.calcom_evento_precedencia,
         pr.calcom_estado_antes_no_show
    into v_actual, v_booking, v_booking_aliases, v_ultimo_en,
         v_ultima_precedencia, v_antes_no_show
    from public.prospecto pr
   where pr.id = p_prospecto and pr.duplicado_de is null
   for update;
  if not found then
    update public.comercial_evento
       set prospecto_id = null, estado_proceso = 'sin_prospecto',
           procesado_en = clock_timestamp(), error = 'prospecto_no_disponible'
     where id = v_evento_id;
    return query select 'sin_prospecto'::text, null::text;
    return;
  end if;

  select coalesce(array_agg(distinct btrim(x) order by btrim(x)), '{}'::text[])
    into v_booking_aliases
    from unnest(coalesce(v_booking_aliases, '{}'::text[]) || array[v_booking]) x
   where nullif(btrim(x), '') is not null;
  v_misma_reserva := v_booking_aliases && v_aliases;
  v_reserva_anterior := v_booking_aliases && v_aliases_anteriores;
  v_actual_canonico := case v_actual
    when 'negociacion' then 'proposal'
    when 'cerrado' then 'won'
    when 'perdido' then 'lost'
    else v_actual
  end;

  if v_actual_canonico in ('demo', 'proposal', 'pilot', 'won', 'lost') then
    update public.comercial_evento
       set estado_proceso = 'ignorado', procesado_en = clock_timestamp(),
           error = 'avance_comercial_protegido'
     where id = v_evento_id;
    return query select 'ignorado'::text, v_actual;
    return;
  end if;

  if p_creado_en is not null and v_ultimo_en is not null and (
    p_creado_en < v_ultimo_en
    or (
      p_creado_en = v_ultimo_en
      and v_precedencia <= coalesce(v_ultima_precedencia, -1)
      -- Cal.com puede emitir A→B y B→C con el mismo createdAt. No es un
      -- empate ambiguo si la reserva anterior del segundo evento es EXACTAMENTE
      -- la vigente y su reserva nueva es distinta: los aliases forman una
      -- arista causal. Esta excepción no admite CREATED ni una reentrega de A→B
      -- sobre C, por lo que un terminal posterior no puede resucitar.
      and not (
        v_tipo = 'BOOKING_RESCHEDULED'
        and v_precedencia = coalesce(v_ultima_precedencia, -1)
        and v_reserva_anterior
        and not v_misma_reserva
      )
    )
  ) then
    update public.comercial_evento
       set estado_proceso = 'ignorado', procesado_en = clock_timestamp(), error = 'evento_fuera_de_orden'
     where id = v_evento_id;
    return query select 'ignorado'::text, v_actual;
    return;
  end if;

  if p_creado_en is null and v_actual_canonico in ('cancelled', 'no-show') and (
    v_tipo in ('BOOKING_CREATED', 'BOOKING_RESCHEDULED')
    or (v_tipo = 'BOOKING_NO_SHOW_UPDATED' and p_no_show = false)
  ) then
    update public.comercial_evento
       set estado_proceso = 'ignorado', procesado_en = clock_timestamp(),
           error = 'terminal_sin_reloj'
     where id = v_evento_id;
    return query select 'ignorado'::text, v_actual;
    return;
  end if;

  if v_tipo in ('BOOKING_CREATED', 'BOOKING_REQUESTED') then
    if p_creado_en is null and v_booking is not null and not v_misma_reserva then
      update public.comercial_evento
         set estado_proceso = 'ignorado', procesado_en = clock_timestamp(),
             error = 'reserva_no_vigente_sin_reloj'
       where id = v_evento_id;
      return query select 'ignorado'::text, v_actual;
      return;
    end if;
    if v_misma_reserva and v_actual_canonico in ('rescheduled', 'cancelled', 'no-show') then
      update public.comercial_evento
         set estado_proceso = 'ignorado', procesado_en = clock_timestamp(), error = 'reserva_terminal'
       where id = v_evento_id;
      return query select 'ignorado'::text, v_actual;
      return;
    end if;
  elsif v_tipo = 'BOOKING_RESCHEDULED' then
    if v_booking is null or not (v_misma_reserva or v_reserva_anterior) then
      update public.comercial_evento
         set estado_proceso = case when p_creado_en is null then 'ignorado' else 'esperando_vinculo' end,
             procesado_en = clock_timestamp(),
             error = case when p_creado_en is null then 'reserva_no_vinculada_sin_reloj' else 'esperando_reserva_anterior' end
       where id = v_evento_id;
      return query select case when p_creado_en is null then 'ignorado' else 'esperando_vinculo' end,
        v_actual;
      return;
    end if;
  elsif v_booking is null or not v_misma_reserva then
    update public.comercial_evento
       set estado_proceso = case when p_creado_en is null then 'ignorado' else 'esperando_vinculo' end,
           procesado_en = clock_timestamp(),
           error = case when p_creado_en is null then 'reserva_no_vinculada_sin_reloj' else 'esperando_reserva' end
     where id = v_evento_id;
    return query select case when p_creado_en is null then 'ignorado' else 'esperando_vinculo' end,
      v_actual;
    return;
  end if;

  if v_tipo in ('BOOKING_NO_SHOW', 'BOOKING_NO_SHOW_UPDATED') then
    if coalesce(p_no_show, true) then
      if v_actual_canonico = 'cancelled' then
        update public.comercial_evento
           set estado_proceso = 'ignorado', procesado_en = clock_timestamp(), error = 'reserva_cancelada'
         where id = v_evento_id;
        return query select 'ignorado'::text, v_actual;
        return;
      end if;
      v_destino := 'no-show';
      if v_actual_canonico <> 'no-show' then
        v_antes_no_show := case when v_actual_canonico = 'rescheduled' then 'rescheduled' else 'appointment' end;
      end if;
    else
      if v_actual_canonico = 'cancelled' then
        update public.comercial_evento
           set estado_proceso = 'ignorado', procesado_en = clock_timestamp(), error = 'reserva_cancelada'
         where id = v_evento_id;
        return query select 'ignorado'::text, v_actual;
        return;
      end if;
      v_destino := case
        when v_actual_canonico = 'no-show' then coalesce(v_antes_no_show, 'appointment')
        when v_actual_canonico = 'rescheduled' then 'rescheduled'
        else 'appointment'
      end;
      v_antes_no_show := null;
    end if;
  elsif v_tipo in ('BOOKING_CANCELLED', 'BOOKING_REJECTED') then
    v_antes_no_show := null;
  else
    v_antes_no_show := null;
  end if;

  update public.prospecto
     set estado = v_destino,
         cerrado_en = null,
         calcom_booking_id = p_externo,
         calcom_booking_aliases = v_aliases,
         calcom_evento_en = case when p_creado_en is not null then p_creado_en else calcom_evento_en end,
         calcom_evento_precedencia = case when p_creado_en is not null then v_precedencia else calcom_evento_precedencia end,
         calcom_estado_antes_no_show = v_antes_no_show,
         updated_at = clock_timestamp()
   where id = p_prospecto;
  v_actual := v_destino;
  v_actual_canonico := v_destino;
  v_booking := p_externo;
  v_booking_aliases := v_aliases;
  if p_creado_en is not null then
    v_ultimo_en := p_creado_en;
    v_ultima_precedencia := v_precedencia;
  end if;

  update public.comercial_evento
     set estado_proceso = 'aplicado', procesado_en = clock_timestamp(), error = null
   where id = v_evento_id;

  -- Drena uno por uno lo que llegó antes de que conociéramos su vínculo. El
  -- SELECT se repite porque aplicar A→B puede volver elegible B→C y luego una
  -- cancelación de C. Todos comparten el lock del prospecto de esta transacción.
  loop
    v_pend := null;
    select ce.id, ce.tipo, ce.externo_id, ce.externo_aliases,
           ce.externo_anterior_aliases, ce.orden_en, ce.calcom_no_show
      into v_pend
      from public.comercial_evento ce
     where ce.prospecto_id = p_prospecto
       and ce.id <> v_evento_id
       and ce.estado_proceso in ('pendiente', 'esperando_vinculo')
       and (
         (ce.tipo = 'BOOKING_RESCHEDULED' and ce.externo_anterior_aliases && v_booking_aliases)
         or (ce.tipo <> 'BOOKING_RESCHEDULED' and ce.externo_aliases && v_booking_aliases)
       )
     order by ce.orden_en asc nulls last, ce.creado_en, ce.id
     limit 1
     -- Orden global efectivo: el camino directo puede poseer evento y pedir
     -- prospecto; este drenaje ya posee prospecto, por lo que JAMÁS espera un
     -- evento en vuelo. El dueño del evento lo reevalúa al obtener prospecto.
     -- Sin SKIP LOCKED ambas sesiones formaban el ciclo 40P01.
     for update skip locked;
    exit when not found;

    v_pend_precedencia := case v_pend.tipo
      when 'BOOKING_REQUESTED' then 0
      when 'BOOKING_RESCHEDULED' then 1
      when 'BOOKING_NO_SHOW_UPDATED' then case when v_pend.calcom_no_show then 3 else 2 end
      when 'BOOKING_NO_SHOW' then 3
      when 'BOOKING_CANCELLED' then 4
      when 'BOOKING_REJECTED' then 4
      else 0
    end;

    if v_pend.orden_en is null then
      update public.comercial_evento set estado_proceso='ignorado',
        procesado_en=clock_timestamp(), error='reserva_no_vinculada_sin_reloj'
       where id=v_pend.id;
      continue;
    end if;
    if v_ultimo_en is not null and (
      v_pend.orden_en < v_ultimo_en
      or (
        v_pend.orden_en = v_ultimo_en
        and v_pend_precedencia <= coalesce(v_ultima_precedencia, -1)
        and not (
          v_pend.tipo = 'BOOKING_RESCHEDULED'
          and v_pend_precedencia = coalesce(v_ultima_precedencia, -1)
          and v_pend.externo_anterior_aliases && v_booking_aliases
          and not (v_pend.externo_aliases && v_booking_aliases)
        )
      )
    ) then
      update public.comercial_evento set estado_proceso='ignorado',
        procesado_en=clock_timestamp(), error='evento_fuera_de_orden'
       where id=v_pend.id;
      continue;
    end if;

    v_pend_destino := case v_pend.tipo
      when 'BOOKING_REQUESTED' then 'appointment'
      when 'BOOKING_RESCHEDULED' then 'rescheduled'
      when 'BOOKING_CANCELLED' then 'cancelled'
      when 'BOOKING_REJECTED' then 'cancelled'
      when 'BOOKING_NO_SHOW' then 'no-show'
      when 'BOOKING_NO_SHOW_UPDATED' then case when v_pend.calcom_no_show then 'no-show' else null end
      else null
    end;
    if v_pend_destino is null and not (
      v_pend.tipo = 'BOOKING_NO_SHOW_UPDATED' and v_pend.calcom_no_show = false
    ) then
      update public.comercial_evento set estado_proceso='ignorado',
        procesado_en=clock_timestamp(), error='tipo_pendiente_no_soportado'
       where id=v_pend.id;
      continue;
    end if;

    if v_pend.tipo in ('BOOKING_NO_SHOW', 'BOOKING_NO_SHOW_UPDATED') then
      if coalesce(v_pend.calcom_no_show, true) then
        if v_actual_canonico = 'cancelled' then
          update public.comercial_evento set estado_proceso='ignorado',
            procesado_en=clock_timestamp(), error='reserva_cancelada' where id=v_pend.id;
          continue;
        end if;
        if v_actual_canonico <> 'no-show' then
          v_antes_no_show := case when v_actual_canonico='rescheduled' then 'rescheduled' else 'appointment' end;
        end if;
        v_pend_destino := 'no-show';
      else
        if v_actual_canonico = 'cancelled' then
          update public.comercial_evento set estado_proceso='ignorado',
            procesado_en=clock_timestamp(), error='reserva_cancelada' where id=v_pend.id;
          continue;
        end if;
        v_pend_destino := case
          when v_actual_canonico='no-show' then coalesce(v_antes_no_show, 'appointment')
          when v_actual_canonico='rescheduled' then 'rescheduled'
          else 'appointment'
        end;
        v_antes_no_show := null;
      end if;
    elsif v_pend.tipo in ('BOOKING_CANCELLED', 'BOOKING_REJECTED') then
      v_antes_no_show := null;
    elsif v_pend.tipo = 'BOOKING_RESCHEDULED' then
      v_antes_no_show := null;
    end if;

    update public.prospecto
       set estado = v_pend_destino,
           cerrado_en = null,
           calcom_booking_id = v_pend.externo_id,
           calcom_booking_aliases = v_pend.externo_aliases,
           calcom_evento_en = v_pend.orden_en,
           calcom_evento_precedencia = v_pend_precedencia,
           calcom_estado_antes_no_show = v_antes_no_show,
           updated_at = clock_timestamp()
     where id = p_prospecto;
    update public.comercial_evento set estado_proceso='aplicado',
      procesado_en=clock_timestamp(), error=null where id=v_pend.id;

    v_actual := v_pend_destino;
    v_actual_canonico := v_pend_destino;
    v_booking := v_pend.externo_id;
    v_booking_aliases := v_pend.externo_aliases;
    v_ultimo_en := v_pend.orden_en;
    v_ultima_precedencia := v_pend_precedencia;
  end loop;

  return query select 'aplicado'::text, v_actual;
end;
$$;

revoke all on function public.aplicar_evento_calcom_tx(
  text, text, text, uuid, jsonb, timestamptz, text, text[], text[], boolean, text, text
) from public, anon, authenticated;
grant execute on function public.aplicar_evento_calcom_tx(
  text, text, text, uuid, jsonb, timestamptz, text, text[], text[], boolean, text, text
) to service_role;

comment on function public.aplicar_evento_calcom_tx(
  text, text, text, uuid, jsonb, timestamptz, text, text[], text[], boolean, text, text
) is '0323: registra/aplica Cal.com atómicamente; UID e id numérico son aliases namespaced, los eventos adelantados esperan vínculo, y reentregas recuperan sin_prospecto/cuarentena/pendiente.';

drop function if exists public.reconciliar_eventos_calcom_pendientes(integer);

create or replace function public.reconciliar_eventos_calcom_pendientes(
  p_limite integer default 250
)
returns table(revisados integer, recuperados integer, restantes integer, elegibles integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_prospecto uuid;
  v_coincidencias integer;
  v_resultado text;
  v_revisados integer := 0;
  v_recuperados integer := 0;
begin
  if p_limite < 1 or p_limite > 1000 then
    raise exception 'límite Cal.com fuera de rango' using errcode='CR003';
  end if;

  -- Claim no bloqueante. La fila permanece lockeada hasta resolverla; otro
  -- barrido la salta y no repite la misma transición.
  for v in
    select ce.*
      from public.comercial_evento ce
     where ce.fuente='calcom'
       and ce.estado_proceso in ('esperando_vinculo','sin_prospecto','cuarentena')
       and ce.reintentar_despues <= clock_timestamp()
       and (
         ce.estado_proceso in ('sin_prospecto','esperando_vinculo')
         or ce.orden_original_en is null
         or ce.orden_original_en <= clock_timestamp() + interval '5 minutes'
       )
     order by ce.reintentar_despues, ce.creado_en, ce.id
     limit p_limite
     for update skip locked
  loop
    v_revisados := v_revisados + 1;
    v_prospecto := null;
    v_coincidencias := 0;

    -- Defensa adicional para datos heredados ya anonimizados por una versión
    -- anterior: nunca se invoca el aplicador con identidad incompleta ni se
    -- derriba el lote entero por una sola poison pill.
    if nullif(btrim(v.clave_idempotencia), '') is null
       or nullif(btrim(v.externo_id), '') is null
       or cardinality(v.externo_aliases) = 0 then
      update public.comercial_evento
         set estado_proceso='ignorado', procesado_en=clock_timestamp(),
             error='identidad_irrecuperable_anonimizada'
       where id=v.id;
      v_recuperados := v_recuperados + 1;
      continue;
    end if;

    if v.prospecto_id is not null and exists (
      select 1 from public.prospecto p
       where p.id=v.prospecto_id and p.duplicado_de is null
    ) then
      v_prospecto := v.prospecto_id;
      v_coincidencias := 1;
    elsif v.vinculo_correo is not null then
      select count(*), min(p.id::text)::uuid
        into v_coincidencias, v_prospecto
        from public.prospecto p
       where p.correo_normalizado=v.vinculo_correo
         and p.duplicado_de is null;
    end if;

    if v_coincidencias <> 1 then
      update public.comercial_evento
         set vinculo_error = case when v_coincidencias > 1 then 'correo_ambiguo'
                                  when v.vinculo_correo is null then 'sin_correo'
                                  else 'sin_prospecto' end,
             error = case when v_coincidencias > 1 then 'correo_ambiguo'
                          when v.vinculo_correo is null then 'sin_correo'
                          else 'sin_prospecto' end,
             reintentos = least(reintentos + 1, 32767)::smallint,
             reintentar_despues = clock_timestamp() + interval '15 minutes'
       where id=v.id;
      continue;
    end if;

    select a.resultado into v_resultado
      from public.aplicar_evento_calcom_tx(
        v.clave_idempotencia, v.tipo, v.externo_id, v_prospecto, v.payload,
        v.orden_original_en, null, v.externo_aliases,
        v.externo_anterior_aliases, v.calcom_no_show,
        v.vinculo_correo, null
      ) a;
    if v_resultado in ('aplicado','ignorado','repetido') then
      v_recuperados := v_recuperados + 1;
    elsif v_resultado = 'esperando_vinculo' then
      update public.comercial_evento
         set reintentos=least(reintentos+1,32767)::smallint,
             reintentar_despues=clock_timestamp()+interval '15 minutes'
       where id=v.id;
    end if;
  end loop;

  select count(*)::integer into restantes
    from public.comercial_evento ce
   where ce.fuente='calcom'
     and ce.estado_proceso in ('esperando_vinculo','sin_prospecto','cuarentena');
  select count(*)::integer into elegibles
    from public.comercial_evento ce
   where ce.fuente='calcom'
     and ce.estado_proceso in ('esperando_vinculo','sin_prospecto','cuarentena')
     and ce.reintentar_despues <= clock_timestamp()
     and (
       ce.estado_proceso in ('sin_prospecto','esperando_vinculo')
       or ce.orden_original_en is null
       or ce.orden_original_en <= clock_timestamp() + interval '5 minutes'
     );
  revisados := v_revisados;
  recuperados := v_recuperados;
  return next;
end;
$$;

revoke all on function public.reconciliar_eventos_calcom_pendientes(integer)
  from public, anon, authenticated;
grant execute on function public.reconciliar_eventos_calcom_pendientes(integer)
  to service_role;

comment on function public.reconciliar_eventos_calcom_pendientes(integer) is
  '0323: reclama con SKIP LOCKED esperando_vinculo/sin_prospecto/cuarentena; restantes observa toda la deuda y elegibles sólo la deuda vencida reclamable, para no congelar el watermark por backoff o reloj futuro.';
