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
  -- Todas las unidades que el operador tuvo asignadas ese día. Conservar sólo
  -- la del primer viaje congelaba el fin cuando el turno continuaba en otra.
  unidad_ids uuid[] not null default array[]::uuid[],
  aceptado_en timestamptz not null,
  -- Huella de los viajes y de los extremos GPS que sustentan la derivación.
  -- El ACK reconoce UNA versión concreta; una posición o unidad nueva vuelve
  -- a hacer elegible el expediente aunque una versión anterior ya esté hecha.
  input_version text not null default '',
  processed_version text,
  claim_input_version text,
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
  check ((claim_token is null) = (lease_expires_at is null)),
  constraint jornada_derivacion_claim_version_coherente
    check ((claim_token is null) = (claim_input_version is null))
);

-- La migración aún no se despliega, pero estas adiciones mantienen repetible
-- la verificación sobre un Postgres local que ya ejecutó una revisión previa.
alter table public.jornada_derivacion_trabajo
  add column if not exists unidad_ids uuid[] not null default array[]::uuid[],
  add column if not exists input_version text not null default '',
  add column if not exists processed_version text,
  add column if not exists claim_input_version text;
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid='public.jornada_derivacion_trabajo'::regclass
       and conname='jornada_derivacion_claim_version_coherente'
  ) then
    alter table public.jornada_derivacion_trabajo
      add constraint jornada_derivacion_claim_version_coherente
      check ((claim_token is null) = (claim_input_version is null));
  end if;
end;
$$;

alter table public.jornada_derivacion_trabajo enable row level security;
revoke all on table public.jornada_derivacion_trabajo from public, anon, authenticated;

drop index if exists public.jornada_derivacion_elegible_idx;
create index jornada_derivacion_elegible_idx
  on public.jornada_derivacion_trabajo
  ((processed_version is not null), siguiente_intento_en, aceptado_en, viaje_id)
  include (input_version, processed_version)
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
  'Cola durable y versionada por (tenant,operador,día). Un ACK reconoce sólo la huella de entradas reclamada; posiciones, viajes o unidades posteriores reabren el trabajo. Lease+token cercan crons solapados y recuperan caídas.';

drop function if exists public.reclamar_jornadas_por_derivar(timestamptz, timestamptz, integer, text, integer);

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
  unidad_ids uuid[],
  aceptado_en timestamptz,
  dia date,
  claim_token uuid,
  input_version text,
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

  -- Materializa una versión de las entradas visibles. La huella incluye todos
  -- los viajes/unidades del operador y los extremos GPS del día: agregar una
  -- posición vespertina o cambiar de unidad reabre trabajo ya confirmado.
  -- No usa `recibida_en`: una posición histórica entregada tarde también debe
  -- cambiar la huella por su extremo o por el conteo.
  with viajes_dia as materialized (
    select v.tenant_id,
           v.operador_id,
           (v.aceptado_en at time zone 'America/Mexico_City')::date as dia,
           (array_agg(v.id order by v.aceptado_en, v.id))[1] as viaje_id,
           (array_agg(v.unidad_id order by v.aceptado_en, v.id)
             filter (where v.unidad_id is not null))[1] as unidad_id,
           coalesce(array_agg(distinct v.unidad_id order by v.unidad_id)
             filter (where v.unidad_id is not null), array[]::uuid[]) as unidad_ids,
           min(v.aceptado_en) as aceptado_en,
           string_agg(
             concat_ws(':', v.id::text, coalesce(v.unidad_id::text, '-'), v.aceptado_en::text),
             ',' order by v.aceptado_en, v.id
           ) as viajes_firma
      from public.viaje v
     where v.aceptado_en is not null
       and v.aceptado_en between p_desde and p_hasta
     group by v.tenant_id, v.operador_id,
              (v.aceptado_en at time zone 'America/Mexico_City')::date
  ), fuentes as materialized (
    select vd.*,
           md5(concat_ws('|',
             vd.viajes_firma,
             array_to_string(vd.unidad_ids, ','),
             coalesce(pri.medida_en::text, '-'),
             coalesce(pri.unidad_id::text, '-'),
             coalesce(ult.medida_en::text, '-'),
             coalesce(ult.unidad_id::text, '-')
           )) as input_version
      from viajes_dia vd
      left join lateral (
        select p.medida_en, p.unidad_id
          from public.posicion p
         where p.tenant_id = vd.tenant_id
           and p.unidad_id = any(vd.unidad_ids)
           and p.medida_en >= (vd.dia::timestamp at time zone 'America/Mexico_City')
           and p.medida_en < ((vd.dia + 1)::timestamp at time zone 'America/Mexico_City')
         order by p.medida_en, p.id
         limit 1
      ) pri on true
      left join lateral (
        select p.medida_en, p.unidad_id
          from public.posicion p
         where p.tenant_id = vd.tenant_id
           and p.unidad_id = any(vd.unidad_ids)
           and p.medida_en >= (vd.dia::timestamp at time zone 'America/Mexico_City')
           and p.medida_en < ((vd.dia + 1)::timestamp at time zone 'America/Mexico_City')
         order by p.medida_en desc, p.id desc
         limit 1
      ) ult on true
  )
  insert into public.jornada_derivacion_trabajo as j (
    tenant_id, operador_id, dia, viaje_id, unidad_id, unidad_ids,
    aceptado_en, input_version
  )
  select f.tenant_id, f.operador_id, f.dia, f.viaje_id, f.unidad_id,
         f.unidad_ids, f.aceptado_en, f.input_version
    from fuentes f
  on conflict on constraint jornada_derivacion_trabajo_pkey do update
     set viaje_id = excluded.viaje_id,
         unidad_id = excluded.unidad_id,
         unidad_ids = excluded.unidad_ids,
         aceptado_en = excluded.aceptado_en,
         input_version = excluded.input_version,
         siguiente_intento_en = case
           when j.input_version is distinct from excluded.input_version
             then '-infinity'::timestamptz
           else j.siguiente_intento_en
         end,
         updated_at = clock_timestamp()
   where (j.viaje_id, j.unidad_id, j.unidad_ids, j.aceptado_en, j.input_version)
         is distinct from
         (excluded.viaje_id, excluded.unidad_id, excluded.unidad_ids,
          excluded.aceptado_en, excluded.input_version);

  return query
  with elegibles as materialized (
    select j.tenant_id, j.operador_id, j.dia,
           row_number() over (
             partition by j.tenant_id
             order by (j.processed_version is not null),
                      j.siguiente_intento_en, j.aceptado_en, j.viaje_id
           ) as turno_tenant
      from public.jornada_derivacion_trabajo j
     where (j.claim_token is null or j.lease_expires_at <= clock_timestamp())
       and j.siguiente_intento_en <= clock_timestamp()
       -- Lo no reconocido, incluso si ya salió de la ventana, no caduca. Una
       -- versión confirmada no se repite hasta que cambie su huella.
       and j.processed_version is distinct from j.input_version
  ), candidatos as materialized (
    select j.tenant_id, j.operador_id, j.dia, e.turno_tenant
      from public.jornada_derivacion_trabajo j
      join elegibles e using (tenant_id, operador_id, dia)
     order by e.turno_tenant, j.tenant_id
     for update of j skip locked
     limit p_limite
  ), reclamados as (
    update public.jornada_derivacion_trabajo j
       set claim_token = gen_random_uuid(),
           claim_owner = left(p_owner, 100),
           claim_input_version = j.input_version,
           lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
           intentos = j.intentos + 1,
           updated_at = clock_timestamp()
      from candidatos c
     where (j.tenant_id, j.operador_id, j.dia) = (c.tenant_id, c.operador_id, c.dia)
    returning j.*, c.turno_tenant
  )
  select r.viaje_id,
         r.tenant_id,
         r.operador_id,
         r.unidad_id,
         r.unidad_ids,
         r.aceptado_en,
         r.dia,
         r.claim_token,
         r.claim_input_version,
         r.intentos,
         exists (
           select 1
             from public.jornada_derivacion_trabajo pendiente
           where (pendiente.claim_token is null
                   or pendiente.lease_expires_at <= clock_timestamp())
              and pendiente.siguiente_intento_en <= clock_timestamp()
              and pendiente.processed_version is distinct from pendiente.input_version
              and not exists (
                select 1 from reclamados ya
                 where (ya.tenant_id, ya.operador_id, ya.dia) =
                       (pendiente.tenant_id, pendiente.operador_id, pendiente.dia)
              )
         ) as hay_mas
    from reclamados r
   -- También ENTREGA en round-robin. Si el reloj sólo deja intentar 10 de los
   -- 400 claims, no deben ser los 10 de la misma flota.
   order by r.turno_tenant, r.tenant_id;
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
         -- Reconoce la versión que este claim recibió, no la que pudo llegar
         -- mientras el worker estaba procesando. Si cambió, queda elegible.
         processed_version = case when p_exito then j.claim_input_version else j.processed_version end,
         siguiente_intento_en = case
           -- La entrada cambió mientras este worker sostenía el claim. Su ACK
           -- reconoce la versión vieja, pero no puede imponerle una hora de
           -- espera a la nueva: queda reclamable de inmediato.
           when p_exito and j.input_version is distinct from j.claim_input_version
             then '-infinity'::timestamptz
           else clock_timestamp() + make_interval(secs => p_retraso_seconds)
         end,
         ultimo_error = case when p_exito then null else left(coalesce(p_error, 'fallo sin detalle'), 500) end,
         claim_token = null,
         claim_owner = null,
         claim_input_version = null,
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
         claim_input_version = null,
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

-- Reconcilia un extremo DERIVADO sin editar su hora en silencio. Si aparece
-- evidencia más amplia, anula la versión previa con firma de sistema e inserta
-- otra enlazada por `corrige_a`. Una marca declarada por el operador o
-- capturada por un contralor jamás se toca: la evidencia humana prevalece.
create or replace function public.asentar_extremo_jornada_derivado(
  p_jornada_id uuid,
  p_tenant_id uuid,
  p_tipo text,
  p_momento timestamptz,
  p_procedencia text,
  p_origen_ref text,
  p_viaje_id uuid default null,
  p_unidad_id uuid default null,
  p_detalle jsonb default null
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actual public.jornada_asiento%rowtype;
  v_origen_nuevo text;
begin
  if p_jornada_id is null or p_tenant_id is null or p_momento is null then
    raise exception 'derived journey endpoint requires journey, tenant and timestamp';
  end if;
  if p_tipo not in ('inicio_jornada', 'fin_jornada') then
    raise exception 'derived journey endpoint type is invalid';
  end if;
  if p_procedencia not in ('hito_viaje', 'gps') or nullif(btrim(p_origen_ref), '') is null then
    raise exception 'derived journey endpoint requires a derived source';
  end if;

  -- El lock del expediente serializa inicio/fin derivados concurrentes aun
  -- cuando todavía no exista una marca viva que se pueda bloquear.
  perform 1
    from public.jornada_dia d
   where d.id = p_jornada_id and d.tenant_id = p_tenant_id
   for update;
  if not found then
    raise exception 'journey day does not belong to tenant';
  end if;

  select a.* into v_actual
    from public.jornada_asiento a
   where a.jornada_id = p_jornada_id
     and a.tenant_id = p_tenant_id
     and a.tipo = p_tipo
     and a.anulado_en is null
   for update;

  if not found then
    insert into public.jornada_asiento (
      tenant_id, jornada_id, tipo, momento, procedencia, origen_ref,
      viaje_id, unidad_id, detalle
    ) values (
      p_tenant_id, p_jornada_id, p_tipo, p_momento, p_procedencia,
      p_origen_ref, p_viaje_id, p_unidad_id, p_detalle
    );
    return 'asentado';
  end if;

  -- Ningún dato automático anula una declaración o captura humana.
  if v_actual.procedencia not in ('hito_viaje', 'gps') then
    return 'ya_estaba';
  end if;

  -- Sólo ampliar la cota: inicio más temprano o fin más tarde. Una carga GPS
  -- atrasada nunca puede acortar por accidente la jornada ya observada.
  if (p_tipo = 'inicio_jornada' and p_momento >= v_actual.momento)
     or (p_tipo = 'fin_jornada' and p_momento <= v_actual.momento) then
    return 'ya_estaba';
  end if;

  update public.jornada_asiento
     set anulado_en = clock_timestamp(),
         anulado_por_email = 'sistema:derivador-jornada@likida.internal',
         anulado_motivo = 'Nueva evidencia automática amplió el extremo derivado'
   where id = v_actual.id and tenant_id = p_tenant_id and anulado_en is null;

  -- `origen_ref` es único aun para anulados. Vincularlo a la versión que
  -- corrige permite que un extremo vuelva a una fuente histórica sin colisión.
  v_origen_nuevo := p_origen_ref || ':corrige:' || v_actual.id::text;
  insert into public.jornada_asiento (
    tenant_id, jornada_id, tipo, momento, procedencia, origen_ref,
    viaje_id, unidad_id, detalle, corrige_a
  ) values (
    p_tenant_id, p_jornada_id, p_tipo, p_momento, p_procedencia,
    v_origen_nuevo, p_viaje_id, p_unidad_id,
    coalesce(p_detalle, '{}'::jsonb) || jsonb_build_object(
      'version_anterior_id', v_actual.id,
      'version_anterior_momento', v_actual.momento
    ),
    v_actual.id
  );
  return 'actualizado';
end;
$$;

revoke all on function public.asentar_extremo_jornada_derivado(uuid, uuid, text, timestamptz, text, text, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.asentar_extremo_jornada_derivado(uuid, uuid, text, timestamptz, text, text, uuid, uuid, jsonb) to service_role;

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
   where singleton
     and cadena_id = p_cadena_id
     and lease_expires_at > clock_timestamp();
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
