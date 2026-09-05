-- ═══════════════════════════════════════════════════════════════════════════
-- 0324 · POLL GPS DURABLE, JUSTO Y SIN DOBLE DISPARO
--
-- Cierra cuatro pérdidas silenciosas de la auditoría enterprise:
--   1. los cursores de Samsara dejaron de cortarse en la página 10;
--   2. la ventana de eventos sólo avanza cuando TODAS sus páginas terminaron;
--   3. dos workers no reclaman la misma flota ni el mismo choque;
--   4. `contador` ya no puede leer coordenadas crudas por REST. El dueño y el
--      encargado sí ven las de SU flota; service_role conserva la ingesta.
--
-- Los cursores de paginación del proveedor NO se persisten: pertenecen a un
-- snapshot HTTP y reanudarlos horas después podría saltar vehículos que se
-- movieron entre snapshots. Se persiste el watermark temporal de EVENTOS y la
-- ventana sólo se confirma completa al recibir `hasNextPage=false`.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.conector_poll_estado (
  tenant_id          uuid not null references public.tenant(id) on delete cascade,
  proveedor          text not null,
  recurso            text not null,
  watermark_en       timestamptz,
  tail_watermark_en  timestamptz,
  ultimo_inicio_en   timestamptz,
  ultimo_poll_en     timestamptz,
  ultimo_completo_en timestamptz,
  ultima_medida_en   timestamptz,
  paginas_ultima     integer not null default 0,
  elementos_ultima  integer not null default 0,
  eventos_invalidos_ultima integer not null default 0,
  eventos_invalidos_total bigint not null default 0,
  backlog_pendiente  boolean not null default false,
  ultimo_error       text,
  claim_token        uuid,
  claim_worker       text,
  claim_expires_at   timestamptz,
  actualizado_en     timestamptz not null default now(),
  primary key (tenant_id, proveedor, recurso),
  constraint conector_poll_recurso_dominio check (recurso in ('posiciones', 'eventos')),
  constraint conector_poll_conteos_sanos check (
    paginas_ultima >= 0 and elementos_ultima >= 0 and
    eventos_invalidos_ultima >= 0 and eventos_invalidos_total >= 0
  ),
  constraint conector_poll_claim_coherente check (
    (claim_token is null and claim_worker is null and claim_expires_at is null)
    or
    (claim_token is not null and claim_worker is not null and claim_expires_at is not null)
  )
);

alter table public.conector_poll_estado
  add column if not exists tail_watermark_en timestamptz,
  add column if not exists eventos_invalidos_ultima integer not null default 0,
  add column if not exists eventos_invalidos_total bigint not null default 0;
alter table public.conector_poll_estado drop constraint if exists conector_poll_conteos_sanos;
alter table public.conector_poll_estado add constraint conector_poll_conteos_sanos check (
  paginas_ultima >= 0 and elementos_ultima >= 0 and
  eventos_invalidos_ultima >= 0 and eventos_invalidos_total >= 0
);

comment on table public.conector_poll_estado is
  'Estado durable por flota/proveedor/recurso: fairness entre tenants, watermark de eventos, poll vs medida y backlog explícito. Los cursores HTTP de Samsara no se guardan porque no son un snapshot durable.';

create index if not exists conector_poll_reclamo_idx
  on public.conector_poll_estado (recurso, ultimo_inicio_en, tenant_id, proveedor)
  where claim_token is null;
create index if not exists conector_poll_lease_idx
  on public.conector_poll_estado (recurso, claim_expires_at)
  where claim_token is not null;

alter table public.conector_poll_estado enable row level security;
revoke all on public.conector_poll_estado from public, anon, authenticated;
grant select, insert, update on public.conector_poll_estado to service_role;

-- Provisionamiento FUERA del hot claim. Un INSERT/ON CONFLICT dentro del
-- reclamo puede esperar el índice único antes de alcanzar SKIP LOCKED.
create or replace function public.provisionar_estado_poll_credencial()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.activo then
    insert into public.conector_poll_estado (tenant_id, proveedor, recurso, watermark_en)
    values
      (new.tenant_id, new.conector_id, 'posiciones', null),
      (new.tenant_id, new.conector_id, 'eventos', clock_timestamp() - interval '30 days')
    on conflict on constraint conector_poll_estado_pkey do nothing;
  end if;
  return new;
end;
$$;

revoke all on function public.provisionar_estado_poll_credencial() from public, anon, authenticated;
drop trigger if exists conector_credencial_provisiona_poll on public.conector_credencial;
create trigger conector_credencial_provisiona_poll
after insert or update of activo, conector_id on public.conector_credencial
for each row execute function public.provisionar_estado_poll_credencial();

-- Backfill único para credenciales anteriores a 0324. El trigger cubre todas
-- las altas/reactivaciones posteriores; el cron jamás ejecuta este upsert.
insert into public.conector_poll_estado (tenant_id, proveedor, recurso, watermark_en)
select c.tenant_id, c.conector_id, r.recurso,
       case when r.recurso = 'eventos' then clock_timestamp() - interval '30 days' else null end
from public.conector_credencial c
cross join (values ('posiciones'), ('eventos')) r(recurso)
where c.activo
on conflict on constraint conector_poll_estado_pkey do nothing;

-- Inserta los estados faltantes y reclama los menos recientemente atendidos.
-- SKIP LOCKED permite workers paralelos sin solapamiento; el lease recupera un
-- worker muerto. Se devuelven credenciales sólo a service_role.
drop function if exists public.reclamar_polls_conector(
  text, text[], integer, text, integer, timestamptz, timestamptz
);
create or replace function public.reclamar_polls_conector(
  p_recurso text,
  p_proveedores text[],
  p_limite integer default 20,
  p_worker text default 'gps',
  p_lease_segundos integer default 360,
  p_ahora timestamptz default clock_timestamp()
)
returns table (
  tenant_id uuid,
  proveedor text,
  valores_cifrados text,
  claim_token uuid,
  watermark_en timestamptz,
  tail_watermark_en timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_recurso not in ('posiciones', 'eventos') then
    raise exception 'recurso de poll inválido';
  end if;
  if coalesce(array_length(p_proveedores, 1), 0) = 0 then
    return;
  end if;
  if p_limite < 1 or p_limite > 200 then
    raise exception 'p_limite fuera de 1..200';
  end if;
  if p_lease_segundos < 30 or p_lease_segundos > 600 then
    raise exception 'p_lease_segundos fuera de 30..600';
  end if;
  if btrim(coalesce(p_worker, '')) = '' or length(p_worker) > 120 then
    raise exception 'p_worker inválido';
  end if;

  return query
  with elegibles as materialized (
    select s.tenant_id, s.proveedor, s.recurso
      from public.conector_poll_estado s
      join public.conector_credencial c
        on c.tenant_id = s.tenant_id
       and c.conector_id = s.proveedor
       and c.activo
     where s.recurso = p_recurso
       and s.proveedor = any (p_proveedores)
       and (s.claim_token is null or s.claim_expires_at <= p_ahora)
     order by s.ultimo_inicio_en asc nulls first, s.tenant_id, s.proveedor
     limit p_limite
     for update of s skip locked
  ), reclamados as (
    update public.conector_poll_estado s
       set claim_token = gen_random_uuid(),
           claim_worker = p_worker,
           claim_expires_at = p_ahora + make_interval(secs => p_lease_segundos),
           ultimo_inicio_en = p_ahora,
           actualizado_en = p_ahora
      from elegibles e
     where s.tenant_id = e.tenant_id
       and s.proveedor = e.proveedor
       and s.recurso = e.recurso
    returning s.tenant_id, s.proveedor, s.claim_token, s.watermark_en, s.tail_watermark_en
  )
  select r.tenant_id, r.proveedor, c.valores_cifrados, r.claim_token, r.watermark_en, r.tail_watermark_en
    from reclamados r
    join public.conector_credencial c
      on c.tenant_id = r.tenant_id and c.conector_id = r.proveedor
   order by r.tenant_id, r.proveedor;
end;
$$;

comment on function public.reclamar_polls_conector(text, text[], integer, text, integer, timestamptz) is
  'Hot claim durable y justo de polls GPS/eventos: SELECT/UPDATE + SKIP LOCKED, sin INSERT/ON CONFLICT. El trigger provisiona estados.';
revoke all on function public.reclamar_polls_conector(text, text[], integer, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.reclamar_polls_conector(text, text[], integer, text, integer, timestamptz) to service_role;

drop function if exists public.finalizar_poll_conector(
  uuid, text, text, uuid, boolean, timestamptz, timestamptz,
  integer, integer, text, timestamptz
);
create or replace function public.finalizar_poll_conector(
  p_tenant uuid,
  p_proveedor text,
  p_recurso text,
  p_claim_token uuid,
  p_completo boolean,
  p_watermark_en timestamptz default null,
  p_tail_completo boolean default false,
  p_tail_watermark_en timestamptz default null,
  p_ultima_medida_en timestamptz default null,
  p_paginas integer default 0,
  p_elementos integer default 0,
  p_invalidos integer default 0,
  p_error text default null,
  p_ahora timestamptz default clock_timestamp()
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if p_paginas < 0 or p_elementos < 0 or p_invalidos < 0 then
    raise exception 'conteos de poll negativos';
  end if;
  update public.conector_poll_estado
     set watermark_en = case when p_completo and p_watermark_en is not null
                             then greatest(coalesce(watermark_en, '-infinity'::timestamptz), p_watermark_en)
                             else watermark_en end,
         tail_watermark_en = case when p_tail_completo and p_tail_watermark_en is not null
                                  then greatest(coalesce(tail_watermark_en, '-infinity'::timestamptz), p_tail_watermark_en)
                                  else tail_watermark_en end,
         ultimo_poll_en = p_ahora,
         ultimo_completo_en = case when p_completo then p_ahora else ultimo_completo_en end,
         ultima_medida_en = case when p_ultima_medida_en is null then ultima_medida_en
                                 else greatest(coalesce(ultima_medida_en, '-infinity'::timestamptz), p_ultima_medida_en) end,
         paginas_ultima = p_paginas,
         elementos_ultima = p_elementos,
         eventos_invalidos_ultima = p_invalidos,
         eventos_invalidos_total = eventos_invalidos_total + p_invalidos,
         backlog_pendiente = not p_completo,
         ultimo_error = case when p_completo then null else left(coalesce(p_error, 'poll incompleto'), 1000) end,
         claim_token = null,
         claim_worker = null,
         claim_expires_at = null,
         actualizado_en = p_ahora
   where tenant_id = p_tenant
     and proveedor = p_proveedor
     and recurso = p_recurso
     and claim_token = p_claim_token;
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

revoke all on function public.finalizar_poll_conector(uuid, text, text, uuid, boolean, timestamptz, boolean, timestamptz, timestamptz, integer, integer, integer, text, timestamptz) from public, anon, authenticated;
grant execute on function public.finalizar_poll_conector(uuid, text, text, uuid, boolean, timestamptz, boolean, timestamptz, timestamptz, integer, integer, integer, text, timestamptz) to service_role;

-- ── Inbox de reparación sin contenido personal ───────────────────────────
-- Guarda sólo cómo RELEER el evento al proveedor. No guarda coordenadas,
-- etiquetas, liga al video ni fuerza G mientras no exista mapeo/aviso válido.
create table if not exists public.evento_seguridad_cuarentena (
  tenant_id uuid not null references public.tenant(id) on delete cascade,
  proveedor text not null,
  evento_id_externo text not null,
  asset_id text,
  unidad_id uuid,
  ocurrido_en timestamptz not null,
  motivo text not null check (motivo in (
    'payload_invalido', 'unidad_sin_mapear', 'sin_viaje_historico',
    'viaje_ambiguo', 'sin_aviso_previo', 'legacy_unidad_null'
  )),
  intentos integer not null default 0 check (intentos >= 0),
  siguiente_intento_en timestamptz not null default now(),
  ultimo_error text,
  resuelto_en timestamptz,
  muerto_en timestamptz,
  claim_token uuid,
  claim_worker text,
  claim_expires_at timestamptz,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  primary key (tenant_id, proveedor, evento_id_externo, motivo),
  constraint evento_cuarentena_unidad_tenant_fkey
    foreign key (unidad_id, tenant_id) references public.unidad(id, tenant_id)
    on delete set null (unidad_id),
  constraint evento_cuarentena_claim_coherente check (
    (claim_token is null and claim_worker is null and claim_expires_at is null)
    or (claim_token is not null and claim_worker is not null and claim_expires_at is not null)
  )
);
alter table public.evento_seguridad_cuarentena
  drop constraint if exists evento_seguridad_cuarentena_motivo_check;
alter table public.evento_seguridad_cuarentena
  add constraint evento_seguridad_cuarentena_motivo_check check (motivo in (
    'payload_invalido', 'unidad_sin_mapear', 'sin_viaje_historico',
    'viaje_ambiguo', 'sin_aviso_previo', 'legacy_unidad_null',
    'legacy_identidad_null', 'referencia_incompleta'
  ));
comment on column public.evento_seguridad_cuarentena.evento_id_externo is
  'Token opaco sha256 para referencias pre-aviso; valores crudos sólo existen en filas legacy. Permite releer sin persistir una referencia individualizable.';
create index if not exists evento_cuarentena_pendiente_idx
  on public.evento_seguridad_cuarentena
    (tenant_id, proveedor, siguiente_intento_en, ocurrido_en)
  where resuelto_en is null and muerto_en is null;
alter table public.evento_seguridad_cuarentena enable row level security;
revoke all on public.evento_seguridad_cuarentena from public, anon, authenticated;
grant select, insert, update on public.evento_seguridad_cuarentena to service_role;

-- Las versiones anteriores sí podían dejar el huérfano en la tabla principal
-- con unidad_id NULL. La referencia se importa para que el reconciliador lo
-- relea y actualice esa MISMA fila, sin crear duplicado.
insert into public.evento_seguridad_cuarentena
  (tenant_id, proveedor, evento_id_externo, ocurrido_en, motivo)
select tenant_id, proveedor, evento_id_externo, ocurrido_en, 'legacy_unidad_null'
from public.evento_seguridad_flota
where unidad_id is null
on conflict on constraint evento_seguridad_cuarentena_pkey do nothing;

create or replace function public.reclamar_cuarentena_eventos(
  p_tenant uuid,
  p_proveedor text,
  p_limite integer default 10,
  p_worker text default 'gps-cuarentena',
  p_lease_segundos integer default 360,
  p_ahora timestamptz default clock_timestamp()
)
returns table (
  evento_id_externo text,
  ocurrido_en timestamptz,
  motivo text,
  claim_token uuid
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limite < 1 or p_limite > 50 then raise exception 'p_limite fuera de 1..50'; end if;
  if p_lease_segundos < 30 or p_lease_segundos > 600 then raise exception 'lease fuera de 30..600'; end if;
  return query
  with elegibles as materialized (
    select q.tenant_id, q.proveedor, q.evento_id_externo, q.motivo
    from public.evento_seguridad_cuarentena q
    where q.tenant_id = p_tenant
      and q.proveedor = p_proveedor
      and q.motivo <> 'payload_invalido'
      and q.resuelto_en is null and q.muerto_en is null
      and q.siguiente_intento_en <= p_ahora
      and (q.claim_token is null or q.claim_expires_at <= p_ahora)
    order by q.siguiente_intento_en, q.ocurrido_en, q.evento_id_externo
    limit p_limite
    for update skip locked
  )
  update public.evento_seguridad_cuarentena q
  set claim_token = gen_random_uuid(), claim_worker = p_worker,
      claim_expires_at = p_ahora + make_interval(secs => p_lease_segundos),
      intentos = q.intentos + 1, actualizado_en = p_ahora
  from elegibles e
  where q.tenant_id = e.tenant_id and q.proveedor = e.proveedor
    and q.evento_id_externo = e.evento_id_externo and q.motivo = e.motivo
  returning q.evento_id_externo, q.ocurrido_en, q.motivo, q.claim_token;
end;
$$;
revoke all on function public.reclamar_cuarentena_eventos(uuid, text, integer, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.reclamar_cuarentena_eventos(uuid, text, integer, text, integer, timestamptz) to service_role;

create or replace function public.finalizar_cuarentena_evento(
  p_tenant uuid,
  p_proveedor text,
  p_evento_id_externo text,
  p_motivo text,
  p_claim_token uuid,
  p_resuelto boolean,
  p_error text default null,
  p_ahora timestamptz default clock_timestamp()
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare n integer;
begin
  update public.evento_seguridad_cuarentena q
  set resuelto_en = case when p_resuelto then p_ahora else null end,
      ultimo_error = case when p_resuelto then null else left(coalesce(p_error, 'reconciliación pendiente'), 1000) end,
      siguiente_intento_en = case
        when p_resuelto or q.intentos >= 8 then '-infinity'::timestamptz
        else p_ahora + least(interval '24 hours', interval '15 minutes' * power(2, greatest(q.intentos - 1, 0)))
      end,
      muerto_en = case when not p_resuelto and q.intentos >= 8 then p_ahora else q.muerto_en end,
      claim_token = null, claim_worker = null, claim_expires_at = null,
      actualizado_en = p_ahora
  where q.tenant_id = p_tenant and q.proveedor = p_proveedor
    and q.evento_id_externo = p_evento_id_externo and q.motivo = p_motivo
    and q.claim_token = p_claim_token and q.resuelto_en is null;
  get diagnostics n = row_count;
  return n = 1;
end;
$$;
revoke all on function public.finalizar_cuarentena_evento(uuid, text, text, text, uuid, boolean, text, timestamptz) from public, anon, authenticated;
grant execute on function public.finalizar_cuarentena_evento(uuid, text, text, text, uuid, boolean, text, timestamptz) to service_role;

-- ── Outbox/lease de choques ────────────────────────────────────────────────
alter table public.evento_seguridad_flota
  add column if not exists asset_id text,
  add column if not exists claim_token uuid,
  add column if not exists claim_worker text,
  add column if not exists claim_expires_at timestamptz,
  add column if not exists intentos integer not null default 0,
  add column if not exists ultimo_error text,
  add column if not exists siguiente_intento_en timestamptz not null default '-infinity',
  add column if not exists muerto_en timestamptz,
  add column if not exists viaje_id uuid,
  add column if not exists operador_id uuid,
  add column if not exists viaje_folio text,
  add column if not exists aviso_outbox_id uuid references public.wa_outbox(id) on delete set null,
  add column if not exists aviso_estado text,
  add column if not exists aviso_receipt text;

alter table public.evento_seguridad_flota drop constraint if exists evento_seguridad_aviso_estado_check;
alter table public.evento_seguridad_flota add constraint evento_seguridad_aviso_estado_check
  check (aviso_estado is null or aviso_estado in ('no_requerido', 'pending', 'sending', 'sent', 'dead'));

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'evento_seguridad_viaje_tenant_fkey') then
    alter table public.evento_seguridad_flota add constraint evento_seguridad_viaje_tenant_fkey
      foreign key (viaje_id, tenant_id) references public.viaje(id, tenant_id) on delete set null (viaje_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'evento_seguridad_operador_tenant_fkey') then
    alter table public.evento_seguridad_flota add constraint evento_seguridad_operador_tenant_fkey
      foreign key (operador_id, tenant_id) references public.operador(id, tenant_id) on delete set null (operador_id);
  end if;
end $$;

-- Filas creadas por la primera versión de 0324 aún no tienen la identidad
-- histórica autorizada. No se disparan con el viaje de "hoy": se releen por
-- token opaco y sólo entonces se vuelven elegibles.
insert into public.evento_seguridad_cuarentena
  (tenant_id, proveedor, evento_id_externo, ocurrido_en, motivo)
select e.tenant_id, e.proveedor,
       'sha256:' || encode(digest(e.tenant_id::text || E'\n' || e.proveedor || E'\n' || e.evento_id_externo, 'sha256'), 'hex'),
       date_trunc('hour', e.ocurrido_en), 'legacy_identidad_null'
from public.evento_seguridad_flota e
where e.grave and e.unidad_id is not null and e.procesado_en is null
  and (e.viaje_id is null or e.operador_id is null)
on conflict on constraint evento_seguridad_cuarentena_pkey do nothing;

alter table public.evento_seguridad_flota drop constraint if exists evento_seguridad_claim_coherente;
alter table public.evento_seguridad_flota add constraint evento_seguridad_claim_coherente check (
  (claim_token is null and claim_worker is null and claim_expires_at is null)
  or
  (claim_token is not null and claim_worker is not null and claim_expires_at is not null)
);
alter table public.evento_seguridad_flota drop constraint if exists evento_seguridad_intentos_sanos;
alter table public.evento_seguridad_flota add constraint evento_seguridad_intentos_sanos check (intentos >= 0);

drop index if exists public.evento_seguridad_outbox_pendiente_idx;
create index evento_seguridad_outbox_pendiente_idx
  on public.evento_seguridad_flota
    (tenant_id, proveedor, siguiente_intento_en, ocurrido_en, id)
  where grave and unidad_id is not null and procesado_en is null
    and muerto_en is null and aviso_outbox_id is null;

create index if not exists evento_seguridad_aviso_pendiente_idx
  on public.evento_seguridad_flota (aviso_outbox_id)
  where aviso_outbox_id is not null and procesado_en is null;
create index if not exists evento_seguridad_aviso_salud_idx
  on public.evento_seguridad_flota (tenant_id, proveedor, aviso_outbox_id)
  where aviso_outbox_id is not null and procesado_en is null;
create index if not exists evento_seguridad_muerto_salud_idx
  on public.evento_seguridad_flota (tenant_id, proveedor)
  where muerto_en is not null;
create index if not exists evento_cuarentena_muerta_salud_idx
  on public.evento_seguridad_cuarentena (tenant_id, proveedor)
  where muerto_en is not null;

create or replace function public.reclamar_eventos_seguridad(
  p_tenant uuid,
  p_proveedor text,
  p_limite integer default 200,
  p_worker text default 'gps-eventos',
  p_lease_segundos integer default 360,
  p_ahora timestamptz default clock_timestamp()
)
returns table (
  evento_id_externo text,
  unidad_id uuid,
  etiquetas text[],
  lat double precision,
  lng double precision,
  ocurrido_en timestamptz,
  url_evento text,
  max_g numeric,
  claim_token uuid,
  viaje_id uuid,
  operador_id uuid,
  viaje_folio text,
  intentos integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limite < 1 or p_limite > 1000 then raise exception 'p_limite fuera de 1..1000'; end if;
  if p_lease_segundos < 30 or p_lease_segundos > 600 then raise exception 'lease fuera de 30..600'; end if;
  if btrim(coalesce(p_worker, '')) = '' or length(p_worker) > 120 then raise exception 'worker inválido'; end if;

  return query
  with elegibles as materialized (
    select e.id
      from public.evento_seguridad_flota e
     where e.tenant_id = p_tenant
       and e.proveedor = p_proveedor
       and e.grave
       and e.unidad_id is not null
       and e.procesado_en is null
       and e.muerto_en is null
       and e.aviso_outbox_id is null
       and e.viaje_id is not null
       and e.operador_id is not null
       and e.siguiente_intento_en <= p_ahora
       and (e.claim_token is null or e.claim_expires_at <= p_ahora)
     order by e.ocurrido_en, e.id
     limit p_limite
     for update skip locked
  )
  update public.evento_seguridad_flota e
     set claim_token = gen_random_uuid(),
         claim_worker = p_worker,
         claim_expires_at = p_ahora + make_interval(secs => p_lease_segundos),
         intentos = e.intentos + 1
    from elegibles x
   where e.id = x.id
  returning e.evento_id_externo, e.unidad_id, e.etiquetas, e.lat, e.lng,
            e.ocurrido_en, e.url_evento, e.max_g, e.claim_token,
            e.viaje_id, e.operador_id, e.viaje_folio, e.intentos;
end;
$$;

revoke all on function public.reclamar_eventos_seguridad(uuid, text, integer, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.reclamar_eventos_seguridad(uuid, text, integer, text, integer, timestamptz) to service_role;

-- Descubre outboxes pendientes SIN depender de conector_credencial. Una
-- credencial desactivada/eliminada no puede apagar una alerta ya persistida.
-- El claim real sigue siendo por evento y con SKIP LOCKED; dos crons pueden
-- ver el mismo par sin duplicar el efecto.
create or replace function public.listar_outboxes_eventos_pendientes(
  p_limite integer default 100,
  p_ahora timestamptz default clock_timestamp()
)
returns table (tenant_id uuid, proveedor text)
language sql
security definer
set search_path = ''
as $$
  select e.tenant_id, e.proveedor
  from public.evento_seguridad_flota e
  where e.grave and e.unidad_id is not null and e.procesado_en is null
    and e.muerto_en is null and e.aviso_outbox_id is null
    and e.viaje_id is not null and e.operador_id is not null
    and e.siguiente_intento_en <= p_ahora
  group by e.tenant_id, e.proveedor
  order by min(e.siguiente_intento_en), min(e.ocurrido_en), e.tenant_id, e.proveedor
  limit greatest(1, least(p_limite, 500));
$$;
revoke all on function public.listar_outboxes_eventos_pendientes(integer, timestamptz) from public, anon, authenticated;
grant execute on function public.listar_outboxes_eventos_pendientes(integer, timestamptz) to service_role;

-- Inserta la intención antes de cualquier POST a Meta. Un timeout/kill puede
-- repetir esta RPC, pero la llave estable devuelve la misma fila.
create or replace function public.encolar_wa_outbox_dedupe(
  p_dedupe_key text,
  p_payload jsonb,
  p_error text default null
)
returns table (id uuid, estado text, provider_message_id text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if btrim(coalesce(p_dedupe_key, '')) = '' or length(p_dedupe_key) > 300
     or p_dedupe_key not like 'gps:%' then
    raise exception 'dedupe_key GPS inválida';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or p_payload->>'to' is null or p_payload->>'type' <> 'interactive' then
    raise exception 'payload WA GPS inválido';
  end if;
  return query
  insert into public.wa_outbox as o (dedupe_key, payload, ultimo_error)
  values (p_dedupe_key, p_payload, left(coalesce(p_error, 'alerta GPS pendiente'), 500))
  on conflict (dedupe_key) do update set dedupe_key = excluded.dedupe_key
  returning o.id, o.estado, o.provider_message_id;
end;
$$;
revoke all on function public.encolar_wa_outbox_dedupe(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.encolar_wa_outbox_dedupe(text, jsonb, text) to service_role;

drop function if exists public.finalizar_evento_seguridad(uuid, text, text, uuid, boolean, uuid, text, timestamptz);
create or replace function public.finalizar_evento_seguridad(
  p_tenant uuid,
  p_proveedor text,
  p_evento_id_externo text,
  p_claim_token uuid,
  p_exito boolean,
  p_incidencia_id uuid default null,
  p_aviso_estado text default null,
  p_aviso_outbox_id uuid default null,
  p_aviso_receipt text default null,
  p_error text default null,
  p_ahora timestamptz default clock_timestamp()
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  if p_exito and coalesce(p_aviso_estado, '') not in ('no_requerido', 'pending', 'sent', 'dead') then
    raise exception 'estado de aviso exitoso inválido';
  end if;
  if p_exito and p_aviso_estado in ('pending', 'sent', 'dead') and p_aviso_outbox_id is null then
    raise exception 'aviso durable sin outbox';
  end if;
  update public.evento_seguridad_flota
     set procesado_en = case
           when p_exito and p_aviso_estado in ('no_requerido', 'sent') then p_ahora
           else null
         end,
         incidencia_id = coalesce(p_incidencia_id, incidencia_id),
         aviso_estado = case when p_exito then p_aviso_estado else aviso_estado end,
         aviso_outbox_id = case when p_exito then p_aviso_outbox_id else aviso_outbox_id end,
         aviso_receipt = case when p_exito then p_aviso_receipt else aviso_receipt end,
         ultimo_error = case when p_exito then null else left(coalesce(p_error, 'disparo fallido'), 1000) end,
         siguiente_intento_en = case
           when p_exito or intentos >= 5 then '-infinity'::timestamptz
           else p_ahora + least(interval '6 hours', interval '5 minutes' * power(2, greatest(intentos - 1, 0)))
         end,
         muerto_en = case when not p_exito and intentos >= 5 then p_ahora else muerto_en end,
         claim_token = null,
         claim_worker = null,
         claim_expires_at = null
   where tenant_id = p_tenant
     and proveedor = p_proveedor
     and evento_id_externo = p_evento_id_externo
     and claim_token = p_claim_token
     and procesado_en is null;
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

revoke all on function public.finalizar_evento_seguridad(uuid, text, text, uuid, boolean, uuid, text, uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.finalizar_evento_seguridad(uuid, text, text, uuid, boolean, uuid, text, uuid, text, text, timestamptz) to service_role;

-- El receipt de Meta es la evidencia de entrega. Hasta que wa_outbox cambia a
-- sent, el evento queda sin procesado_en. Dead también permanece visible.
create or replace function public.sincronizar_aviso_evento_seguridad()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.estado = 'sent' then
    update public.evento_seguridad_flota
       set aviso_estado = 'sent', aviso_receipt = new.provider_message_id,
           procesado_en = coalesce(new.enviada_en, clock_timestamp()), ultimo_error = null
     where aviso_outbox_id = new.id and procesado_en is null;
  elsif new.estado = 'dead' then
    update public.evento_seguridad_flota
       set aviso_estado = 'dead', ultimo_error = left(coalesce(new.ultimo_error, 'aviso WA agotó reintentos'), 1000)
     where aviso_outbox_id = new.id and procesado_en is null;
  elsif new.estado in ('pending', 'sending') then
    update public.evento_seguridad_flota set aviso_estado = new.estado
     where aviso_outbox_id = new.id and procesado_en is null;
  end if;
  return new;
end;
$$;
revoke all on function public.sincronizar_aviso_evento_seguridad() from public, anon, authenticated;
drop trigger if exists wa_outbox_sincroniza_evento_seguridad on public.wa_outbox;
create trigger wa_outbox_sincroniza_evento_seguridad
after update of estado, provider_message_id on public.wa_outbox
for each row when (old.estado is distinct from new.estado or old.provider_message_id is distinct from new.provider_message_id)
execute function public.sincronizar_aviso_evento_seguridad();

-- ── Salud: poll, medición y backlog son tres relojes distintos ─────────────
create or replace function public.estado_poll_gps_tenant(p_tenant uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'proveedor', proveedor,
    'recurso', recurso,
    'ultimoPoll', ultimo_poll_en,
    'ultimoCompleto', ultimo_completo_en,
    'ultimaMedida', ultima_medida_en,
    'backlogPendiente', backlog_pendiente,
    'paginas', paginas_ultima,
    'elementos', elementos_ultima,
    'eventosInvalidosUltima', eventos_invalidos_ultima,
    'eventosInvalidosTotal', eventos_invalidos_total,
    'eventosEnCuarentena', (
      select count(*) from public.evento_seguridad_cuarentena q
      where q.tenant_id = conector_poll_estado.tenant_id
        and q.proveedor = conector_poll_estado.proveedor
        and q.resuelto_en is null and q.muerto_en is null
    ),
    'eventosCuarentenaMuertos', (
      select count(*) from public.evento_seguridad_cuarentena q
      where q.tenant_id = conector_poll_estado.tenant_id
        and q.proveedor = conector_poll_estado.proveedor
        and q.muerto_en is not null
    ),
    'eventosOutboxPendientes', (
      select count(*) from public.evento_seguridad_flota e
      where e.tenant_id = conector_poll_estado.tenant_id
        and e.proveedor = conector_poll_estado.proveedor
        and e.grave and e.procesado_en is null and e.muerto_en is null
        and e.aviso_outbox_id is null
    ),
    'eventosOutboxMuertos', (
      select count(*) from public.evento_seguridad_flota e
      where e.tenant_id = conector_poll_estado.tenant_id
        and e.proveedor = conector_poll_estado.proveedor
        and e.muerto_en is not null
    ),
    'avisosPendientes', (
      select count(*) from public.evento_seguridad_flota e
      join public.wa_outbox w on w.id = e.aviso_outbox_id
      where e.tenant_id = conector_poll_estado.tenant_id
        and e.proveedor = conector_poll_estado.proveedor
        and e.procesado_en is null and w.estado in ('pending', 'sending')
    ),
    'avisosMuertos', (
      select count(*) from public.evento_seguridad_flota e
      join public.wa_outbox w on w.id = e.aviso_outbox_id
      where e.tenant_id = conector_poll_estado.tenant_id
        and e.proveedor = conector_poll_estado.proveedor
        and e.procesado_en is null and w.estado = 'dead'
    ),
    'error', ultimo_error
  ) order by proveedor, recurso), '[]'::jsonb)
  from public.conector_poll_estado
  where tenant_id = p_tenant;
$$;

revoke all on function public.estado_poll_gps_tenant(uuid) from public, anon, authenticated;
grant execute on function public.estado_poll_gps_tenant(uuid) to service_role;

create or replace function public.estado_eventos_gps_operativo()
returns table (
  tenant_id uuid,
  proveedor text,
  eventos_en_cuarentena bigint,
  eventos_cuarentena_muertos bigint,
  eventos_outbox_pendientes bigint,
  eventos_outbox_muertos bigint,
  avisos_pendientes bigint,
  avisos_muertos bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with pares as (
    select distinct s.tenant_id, s.proveedor
    from public.conector_poll_estado s
    where s.recurso = 'eventos'
    union
    select distinct e.tenant_id, e.proveedor from public.evento_seguridad_flota e
    union
    select distinct q.tenant_id, q.proveedor from public.evento_seguridad_cuarentena q
  )
  select p.tenant_id, p.proveedor,
    (select count(*) from public.evento_seguridad_cuarentena q
      where q.tenant_id=p.tenant_id and q.proveedor=p.proveedor and q.resuelto_en is null and q.muerto_en is null),
    (select count(*) from public.evento_seguridad_cuarentena q
      where q.tenant_id=p.tenant_id and q.proveedor=p.proveedor and q.muerto_en is not null),
    (select count(*) from public.evento_seguridad_flota e
      where e.tenant_id=p.tenant_id and e.proveedor=p.proveedor and e.grave
        and e.procesado_en is null and e.muerto_en is null and e.aviso_outbox_id is null),
    (select count(*) from public.evento_seguridad_flota e
      where e.tenant_id=p.tenant_id and e.proveedor=p.proveedor and e.muerto_en is not null),
    (select count(*) from public.evento_seguridad_flota e join public.wa_outbox w on w.id=e.aviso_outbox_id
      where e.tenant_id=p.tenant_id and e.proveedor=p.proveedor and e.procesado_en is null and w.estado in ('pending','sending')),
    (select count(*) from public.evento_seguridad_flota e join public.wa_outbox w on w.id=e.aviso_outbox_id
      where e.tenant_id=p.tenant_id and e.proveedor=p.proveedor and e.procesado_en is null and w.estado='dead')
  from pares p order by p.tenant_id, p.proveedor;
$$;
revoke all on function public.estado_eventos_gps_operativo() from public, anon, authenticated;
grant execute on function public.estado_eventos_gps_operativo() to service_role;

-- ── Coordenadas por REST: operación sí; contador no ────────────────────────
create or replace function public.ve_operacion()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.app_user
     where id = (select auth.uid())
       and rol in ('superadmin', 'flota_admin', 'encargado')
       and activo
  );
$$;

revoke all on function public.ve_operacion() from public, anon;
grant execute on function public.ve_operacion() to authenticated, service_role;

drop policy if exists tenant_data on public.posicion;
drop policy if exists posicion_lectura_operativa on public.posicion;
create policy posicion_lectura_operativa on public.posicion
  for select to authenticated
  using (
    (tenant_id = any (public.get_user_tenant_ids()) and (select public.ve_operacion()))
    or (select public.is_superadmin())
  );

comment on policy posicion_lectura_operativa on public.posicion is
  'Coordenadas crudas: dueño/encargado de su propia flota y superadmin. Contador queda fuera por REST; service_role opera por bypass RLS.';
