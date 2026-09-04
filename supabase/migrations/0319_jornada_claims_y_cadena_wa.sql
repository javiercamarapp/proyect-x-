-- 0319 — Capacidad enterprise: trabajo de jornada con ACK durable y una sola
-- cadena de drenado WA. El cursor anterior reconocía una página completa
-- antes de que el proceso la intentara; un corte de reloj podía condenar para
-- siempre los renglones 11..400. Aquí la unidad de progreso es cada claim.

create table if not exists public.jornada_derivacion_trabajo (
  tenant_id uuid not null references public.tenant(id) on delete cascade,
  operador_id uuid not null references public.operador(id) on delete cascade,
  dia date not null,
  viaje_id uuid not null references public.viaje(id) on delete cascade,
  unidad_id uuid,
  aceptado_en timestamptz not null,
  procesado_al_menos_una_vez boolean not null default false,
  siguiente_intento_en timestamptz not null default '-infinity',
  intentos integer not null default 0 check (intentos >= 0),
  ultimo_error text,
  claim_token uuid,
  claim_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, operador_id, dia),
  check ((claim_token is null) = (claim_owner is null)),
  check ((claim_token is null) = (lease_expires_at is null))
);

alter table public.jornada_derivacion_trabajo enable row level security;
revoke all on table public.jornada_derivacion_trabajo from public, anon, authenticated;

create index if not exists jornada_derivacion_elegible_idx
  on public.jornada_derivacion_trabajo
  (procesado_al_menos_una_vez, siguiente_intento_en, aceptado_en, viaje_id)
  where claim_token is null;

create index if not exists jornada_derivacion_lease_vencido_idx
  on public.jornada_derivacion_trabajo (lease_expires_at)
  where claim_token is not null;

-- El cron filtra viaje por una ventana de tres días. Sin este índice el costo
-- crece con toda la historia de viajes aunque el trabajo diario sea constante.
create index if not exists viaje_aceptado_en_derivacion_idx
  on public.viaje (aceptado_en, tenant_id, operador_id, id)
  include (unidad_id)
  where aceptado_en is not null;

comment on table public.jornada_derivacion_trabajo is
  'Cola durable por (tenant,operador,día). Un renglón avanza sólo al finalizar el claim que realmente fue intentado; lease+token cercan crons solapados y recuperan caídas.';

create or replace function public.reclamar_jornadas_por_derivar(
  p_desde timestamptz,
  p_hasta timestamptz,
  p_limite integer,
  p_owner text,
  p_lease_seconds integer default 180
) returns table (
  id uuid,
  tenant_id uuid,
  operador_id uuid,
  unidad_id uuid,
  aceptado_en timestamptz,
  dia date,
  claim_token uuid,
  intentos integer,
  hay_mas boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_desde date;
  v_hasta date;
begin
  if p_desde is null or p_hasta is null or p_desde > p_hasta then
    raise exception 'jornada derivacion window is invalid';
  end if;
  if p_limite < 1 or p_limite > 1000 then
    raise exception 'jornada derivacion claim size must be between 1 and 1000';
  end if;
  if nullif(btrim(p_owner), '') is null then
    raise exception 'jornada derivacion lease owner is required';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'jornada derivacion lease seconds must be between 30 and 900';
  end if;

  v_desde := (p_desde at time zone 'America/Mexico_City')::date;
  v_hasta := (p_hasta at time zone 'America/Mexico_City')::date;

  -- Materializa los expedientes visibles. DISTINCT ON escoge un representante
  -- estable por día; un nuevo representante reinicia el trabajo porque cambió
  -- la evidencia de origen.
  insert into public.jornada_derivacion_trabajo as j (
    tenant_id, operador_id, dia, viaje_id, unidad_id, aceptado_en
  )
  select distinct on (v.tenant_id, v.operador_id,
                      (v.aceptado_en at time zone 'America/Mexico_City')::date)
         v.tenant_id,
         v.operador_id,
         (v.aceptado_en at time zone 'America/Mexico_City')::date,
         v.id,
         v.unidad_id,
         v.aceptado_en
    from public.viaje v
   where v.aceptado_en is not null
     and v.aceptado_en between p_desde and p_hasta
   order by v.tenant_id, v.operador_id,
            (v.aceptado_en at time zone 'America/Mexico_City')::date,
            v.aceptado_en, v.id
  on conflict on constraint jornada_derivacion_trabajo_pkey do update
     set viaje_id = excluded.viaje_id,
         unidad_id = excluded.unidad_id,
         aceptado_en = excluded.aceptado_en,
         procesado_al_menos_una_vez = case
           when (j.viaje_id, j.unidad_id, j.aceptado_en)
                is distinct from
                (excluded.viaje_id, excluded.unidad_id, excluded.aceptado_en)
             then false
           else j.procesado_al_menos_una_vez
         end,
         siguiente_intento_en = case
           when (j.viaje_id, j.unidad_id, j.aceptado_en)
                is distinct from
                (excluded.viaje_id, excluded.unidad_id, excluded.aceptado_en)
             then '-infinity'::timestamptz
           else j.siguiente_intento_en
         end,
         updated_at = clock_timestamp()
   where (j.viaje_id, j.unidad_id, j.aceptado_en)
         is distinct from
         (excluded.viaje_id, excluded.unidad_id, excluded.aceptado_en);

  return query
  with candidatos as materialized (
    select j.tenant_id, j.operador_id, j.dia
      from public.jornada_derivacion_trabajo j
     where (j.claim_token is null or j.lease_expires_at <= clock_timestamp())
       and j.siguiente_intento_en <= clock_timestamp()
       -- Lo jamás completado no caduca al salir de la ventana: ésa es la
       -- propiedad que garantiza convergencia después de un corte prolongado.
       and (not j.procesado_al_menos_una_vez or j.dia between v_desde and v_hasta)
     order by j.procesado_al_menos_una_vez,
              j.siguiente_intento_en, j.aceptado_en, j.viaje_id
     for update skip locked
     limit p_limite
  ), reclamados as (
    update public.jornada_derivacion_trabajo j
       set claim_token = gen_random_uuid(),
           claim_owner = left(p_owner, 100),
           lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
           intentos = j.intentos + 1,
           updated_at = clock_timestamp()
      from candidatos c
     where (j.tenant_id, j.operador_id, j.dia) = (c.tenant_id, c.operador_id, c.dia)
    returning j.*
  )
  select r.viaje_id,
         r.tenant_id,
         r.operador_id,
         r.unidad_id,
         r.aceptado_en,
         r.dia,
         r.claim_token,
         r.intentos,
         exists (
           select 1
             from public.jornada_derivacion_trabajo pendiente
           where (pendiente.claim_token is null
                   or pendiente.lease_expires_at <= clock_timestamp())
              and pendiente.siguiente_intento_en <= clock_timestamp()
              and (not pendiente.procesado_al_menos_una_vez
                   or pendiente.dia between v_desde and v_hasta)
              and not exists (
                select 1 from reclamados ya
                 where (ya.tenant_id, ya.operador_id, ya.dia) =
                       (pendiente.tenant_id, pendiente.operador_id, pendiente.dia)
              )
         ) as hay_mas
    from reclamados r
   order by r.procesado_al_menos_una_vez,
            r.siguiente_intento_en, r.aceptado_en, r.viaje_id;
end;
$$;

create or replace function public.finalizar_jornada_derivacion(
  p_claim_token uuid,
  p_owner text,
  p_exito boolean,
  p_error text default null,
  p_retraso_seconds integer default 3600
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actualizadas integer;
begin
  if p_claim_token is null or nullif(btrim(p_owner), '') is null then
    return false;
  end if;
  if p_retraso_seconds < 0 or p_retraso_seconds > 86400 then
    raise exception 'jornada derivacion retry delay must be between 0 and 86400';
  end if;

  update public.jornada_derivacion_trabajo j
     set procesado_al_menos_una_vez = j.procesado_al_menos_una_vez or p_exito,
         siguiente_intento_en = clock_timestamp() + make_interval(secs => p_retraso_seconds),
         ultimo_error = case when p_exito then null else left(coalesce(p_error, 'fallo sin detalle'), 500) end,
         claim_token = null,
         claim_owner = null,
         lease_expires_at = null,
         updated_at = clock_timestamp()
   where j.claim_token = p_claim_token
     and j.claim_owner = left(p_owner, 100);
  get diagnostics v_actualizadas = row_count;
  return v_actualizadas = 1;
end;
$$;

create or replace function public.liberar_jornadas_por_derivar(
  p_owner text,
  p_claim_tokens uuid[]
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actualizadas integer;
begin
  if nullif(btrim(p_owner), '') is null or coalesce(cardinality(p_claim_tokens), 0) = 0 then
    return 0;
  end if;
  update public.jornada_derivacion_trabajo j
     set claim_token = null,
         claim_owner = null,
         lease_expires_at = null,
         -- Reclamar no fue intentar: devuelve también el contador.
         intentos = greatest(0, j.intentos - 1),
         updated_at = clock_timestamp()
   where j.claim_owner = left(p_owner, 100)
     and j.claim_token = any(p_claim_tokens);
  get diagnostics v_actualizadas = row_count;
  return v_actualizadas;
end;
$$;

revoke all on function public.reclamar_jornadas_por_derivar(timestamptz, timestamptz, integer, text, integer) from public, anon, authenticated;
revoke all on function public.finalizar_jornada_derivacion(uuid, text, boolean, text, integer) from public, anon, authenticated;
revoke all on function public.liberar_jornadas_por_derivar(text, uuid[]) from public, anon, authenticated;
grant execute on function public.reclamar_jornadas_por_derivar(timestamptz, timestamptz, integer, text, integer) to service_role;
grant execute on function public.finalizar_jornada_derivacion(uuid, text, boolean, text, integer) to service_role;
grant execute on function public.liberar_jornadas_por_derivar(text, uuid[]) to service_role;

-- Una sola cadena QStash viva. Dedupe de QStash cubre una generación; este
-- lease cubre crons de minutos distintos, que antes abrían fan-outs paralelos.
create table if not exists public.wa_drenado_cadena (
  singleton boolean primary key default true check (singleton),
  cadena_id uuid,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  check ((cadena_id is null) = (lease_expires_at is null))
);
alter table public.wa_drenado_cadena enable row level security;
revoke all on table public.wa_drenado_cadena from public, anon, authenticated;
insert into public.wa_drenado_cadena(singleton) values (true) on conflict (singleton) do nothing;

create or replace function public.iniciar_cadena_wa(p_lease_seconds integer default 180)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_actual public.wa_drenado_cadena%rowtype;
  v_id uuid := gen_random_uuid();
begin
  if p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'wa chain lease seconds must be between 30 and 900';
  end if;
  select * into v_actual from public.wa_drenado_cadena where singleton for update;
  if v_actual.cadena_id is not null and v_actual.lease_expires_at > clock_timestamp() then
    return null;
  end if;
  update public.wa_drenado_cadena
     set cadena_id = v_id,
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         updated_at = clock_timestamp()
   where singleton;
  return v_id;
end;
$$;

create or replace function public.renovar_cadena_wa(p_cadena_id uuid, p_lease_seconds integer default 180)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_cadena_id is null then return false; end if;
  if p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'wa chain lease seconds must be between 30 and 900';
  end if;
  update public.wa_drenado_cadena
     set lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         updated_at = clock_timestamp()
   where singleton and cadena_id = p_cadena_id;
  return found;
end;
$$;

create or replace function public.finalizar_cadena_wa(p_cadena_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_cadena_id is null then return false; end if;
  update public.wa_drenado_cadena
     set cadena_id = null, lease_expires_at = null, updated_at = clock_timestamp()
   where singleton and cadena_id = p_cadena_id;
  return found;
end;
$$;

revoke all on function public.iniciar_cadena_wa(integer) from public, anon, authenticated;
revoke all on function public.renovar_cadena_wa(uuid, integer) from public, anon, authenticated;
revoke all on function public.finalizar_cadena_wa(uuid) from public, anon, authenticated;
grant execute on function public.iniciar_cadena_wa(integer) to service_role;
grant execute on function public.renovar_cadena_wa(uuid, integer) to service_role;
grant execute on function public.finalizar_cadena_wa(uuid) to service_role;
