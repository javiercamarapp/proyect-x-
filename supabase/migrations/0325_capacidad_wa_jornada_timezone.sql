-- 0325 — Capacidad del inbox WA y del derivador de jornada.
--
-- WA: el orden causal deja de calcularse sobre JSON durante cada listado y se
-- materializa en columnas generadas. El listado intercala por ronda causal de
-- remitente: conserva fajos multi-foto y evita que una ráfaga de un chofer
-- desplace a todos los demás.
--
-- Jornada: sincronizar fuentes y reclamar trabajo son transacciones distintas.
-- Así un worker nunca espera el UPSERT de otro antes de llegar a SKIP LOCKED.
-- Los extremos se calculan para los claims, en una sola consulta, y el escritor
-- append-only se invoca dentro de un RPC por lote (no por cada viaje de red).

-- ── 1. Inbox WA indexable y justo por remitente ────────────────────────────

alter table public.wa_evento_pendiente
  add column if not exists remitente_clave text
    generated always as (coalesce(nullif(evento ->> 'from', ''), id)) stored,
  add column if not exists tipo_evento text
    generated always as (coalesce(evento ->> 'type', 'other')) stored,
  add column if not exists orden_evento bigint
    generated always as (public.wa_orden_evento(evento, recibido_en)) stored;

create index if not exists wa_pendiente_cabeza_remitente_idx
  on public.wa_evento_pendiente
     (remitente_clave, orden_evento, recibido_en, id)
  include (intentos, lease_expires_at, tipo_evento)
  where procesado_en is null and intentos < 5;

create or replace function public.listar_wa_pendientes(p_limite integer)
returns table (id text, intentos integer, remitente text, tipo text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limite < 1 or p_limite > 200 then
    raise exception 'wa inbox list size must be between 1 and 200';
  end if;

  return query
  with ordenados as materialized (
    select
           w.id, w.intentos, w.remitente_clave, w.tipo_evento,
           w.orden_evento, w.recibido_en, w.lease_expires_at,
           row_number() over (
             partition by w.remitente_clave
             order by w.orden_evento, w.recibido_en, w.id
           ) as ronda,
           coalesce(bool_or(w.lease_expires_at > clock_timestamp()) over (
             partition by w.remitente_clave
             order by w.orden_evento, w.recibido_en, w.id
             rows between unbounded preceding and 1 preceding
           ), false) as anterior_arrendado
      from public.wa_evento_pendiente w
     where w.procesado_en is null
       and w.intentos < 5
  )
  select o.id, o.intentos, o.remitente_clave, o.tipo_evento
    from ordenados o
   -- Un lease vivo corta el prefijo causal del remitente. Sin lease, varias
   -- fotos del mismo fajo sí viajan juntas, pero por rondas: primero una de
   -- cada remitente, después la segunda de cada uno, etcétera.
   where (o.lease_expires_at is null or o.lease_expires_at <= clock_timestamp())
     and not o.anterior_arrendado
   order by o.ronda, o.orden_evento, o.recibido_en, o.id
   limit p_limite;
end;
$$;

create or replace function public.reclamar_wa_pendiente(
  p_id text,
  p_intentos integer,
  p_owner text,
  p_lease_seconds integer default 180
) returns table (id text, evento jsonb, intentos integer, claim_token uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.wa_evento_pendiente%rowtype;
  v_token uuid := gen_random_uuid();
begin
  if nullif(btrim(p_id), '') is null then return; end if;
  if nullif(btrim(p_owner), '') is null then
    raise exception 'wa inbox lease owner is required';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'wa inbox lease seconds must be between 30 and 900';
  end if;

  select w.* into v_row
    from public.wa_evento_pendiente w
   where w.id = p_id
     and w.procesado_en is null
     and w.intentos < 5
     and w.intentos = p_intentos
     and (w.lease_expires_at is null or w.lease_expires_at <= clock_timestamp())
     and not exists (
       select 1
         from public.wa_evento_pendiente anterior
        where anterior.procesado_en is null
          and anterior.intentos < 5
          and anterior.remitente_clave = w.remitente_clave
          and (anterior.orden_evento, anterior.recibido_en, anterior.id)
            < (w.orden_evento, w.recibido_en, w.id)
     )
   for update skip locked;
  if not found then return; end if;

  return query
  update public.wa_evento_pendiente w
     set intentos = v_row.intentos + 1,
         claim_token = v_token,
         claim_owner = left(p_owner, 100),
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
   where w.id = v_row.id
   returning w.id, w.evento, w.intentos, w.claim_token;
end;
$$;

revoke all on function public.listar_wa_pendientes(integer) from public, anon, authenticated;
revoke all on function public.reclamar_wa_pendiente(text, integer, text, integer) from public, anon, authenticated;
grant execute on function public.listar_wa_pendientes(integer) to service_role;
grant execute on function public.reclamar_wa_pendiente(text, integer, text, integer) to service_role;

-- ── 2. Zona horaria IANA por tenant ────────────────────────────────────────

alter table public.tenant
  add column if not exists zona_horaria text not null default 'America/Mexico_City';

create or replace function public.validar_zona_horaria_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from pg_catalog.pg_timezone_names z where z.name = new.zona_horaria
  ) then
    raise exception 'tenant timezone is not a valid IANA zone: %', new.zona_horaria
      using errcode = '22023';
  end if;

  if tg_op = 'UPDATE' and old.zona_horaria is distinct from new.zona_horaria then
    -- Cambiar el bucket de un expediente laboral ya materializado exige una
    -- reconciliación auditada de sus asientos; hacerlo en silencio duplicaría
    -- o movería historia. Sin expediente, la cola sí es reconstruible: se
    -- descarta antes del cambio y el siguiente sync la vuelve a crear.
    if exists (
      select 1 from public.jornada_dia d where d.tenant_id = new.id
    ) then
      raise exception 'tenant timezone with journey records requires audited rebucketing'
        using errcode = '55000';
    end if;
    delete from public.jornada_derivacion_trabajo j where j.tenant_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists tenant_zona_horaria_iana on public.tenant;
create trigger tenant_zona_horaria_iana
before insert or update of zona_horaria on public.tenant
for each row execute function public.validar_zona_horaria_tenant();

revoke all on function public.validar_zona_horaria_tenant() from public, anon, authenticated;

comment on column public.tenant.zona_horaria is
  'Zona IANA usada para agrupar jornadas y posiciones por día natural del operador. Default compatible con el comportamiento histórico.';

-- ── 3. Cola de jornada: sync separado, claim corto, snapshot por claim ─────

alter table public.jornada_derivacion_trabajo
  add column if not exists viajes_version text not null default '',
  add column if not exists claim_zona_horaria text,
  add column if not exists claim_aviso_previo boolean,
  add column if not exists claim_gps_primera_en timestamptz,
  add column if not exists claim_gps_primera_unidad_id uuid,
  add column if not exists claim_gps_ultima_en timestamptz,
  add column if not exists claim_gps_ultima_unidad_id uuid;

drop index if exists public.jornada_derivacion_elegible_idx;
create index jornada_derivacion_elegible_idx
  on public.jornada_derivacion_trabajo
     (procesado_al_menos_una_vez, siguiente_intento_en, aceptado_en, viaje_id)
  include (tenant_id, operador_id, dia, unidad_ids, viajes_version)
  where claim_token is null;

create unique index if not exists jornada_derivacion_claim_token_idx
  on public.jornada_derivacion_trabajo (claim_owner, claim_token)
  where claim_token is not null;

-- La reconciliación consulta una fuente exacta por tenant/operador y rango
-- UTC del día local. El índice anterior empieza por `aceptado_en` y sirve al
-- barrido reciente; éste evita un scan de la historia por cada fila de cola.
create index if not exists viaje_derivacion_fuente_idx
  on public.viaje (tenant_id, operador_id, aceptado_en, id)
  include (unidad_id)
  where aceptado_en is not null;

create index if not exists jornada_derivacion_retencion_idx
  on public.jornada_derivacion_trabajo (dia, tenant_id, operador_id)
  where procesado_al_menos_una_vez and claim_token is null;

create or replace function public.sincronizar_jornadas_por_derivar(
  p_ahora timestamptz default clock_timestamp(),
  p_dias integer default 3
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_afectadas integer;
  v_eliminadas integer;
begin
  if p_ahora is null then raise exception 'jornada sync timestamp is required'; end if;
  if p_dias < 1 or p_dias > 31 then
    raise exception 'jornada sync days must be between 1 and 31';
  end if;

  -- La cola es reconstruible. Una fuente desaparecida (`aceptado_en=NULL`) o
  -- movida de día invalida el trabajo aunque ya haya envejecido fuera del
  -- barrido. Además, una versión ya procesada caduca al salir de la retención:
  -- conserva pendientes válidos tras una caída larga, pero impide acumular
  -- 50k filas por mes para siempre. El lote acota locks/tiempo; ejecuciones
  -- siguientes continúan la purga. Un lease vivo nunca se toca y el procesador
  -- revalida la fuente cercada antes de escribir.
  with obsoletos as materialized (
    select j.tenant_id, j.operador_id, j.dia, j.viajes_version,
           fuente.fuente_obsoleta
      from public.jornada_derivacion_trabajo j
      join public.tenant t on t.id = j.tenant_id
      cross join lateral (
        select not exists (
          select 1
            from public.viaje v
           where v.tenant_id = j.tenant_id
             and v.operador_id = j.operador_id
             and v.aceptado_en is not null
             and v.aceptado_en >= (j.dia::timestamp at time zone t.zona_horaria)
             and v.aceptado_en < ((j.dia + 1)::timestamp at time zone t.zona_horaria)
        ) as fuente_obsoleta
      ) fuente
     where (j.claim_token is null or j.lease_expires_at <= clock_timestamp())
       and (
         (j.procesado_al_menos_una_vez
          and j.dia < (p_ahora at time zone t.zona_horaria)::date - (p_dias - 1))
         or fuente.fuente_obsoleta
       )
     order by j.tenant_id, j.operador_id, j.dia
     for update of j skip locked
     limit 10000
  ), dias_cercados as materialized (
    -- El expediente es el mutex común con el escritor derivado. Se toma en
    -- orden UUID para que sync/proceso concurrentes no inviertan locks.
    select d.id, d.tenant_id, o.viajes_version
      from obsoletos o
      join public.jornada_dia d
        on (d.tenant_id, d.operador_id, d.dia) =
           (o.tenant_id, o.operador_id, o.dia)
     where o.fuente_obsoleta
     order by d.id
     for update of d
  ), asientos_anulados as (
    update public.jornada_asiento a
       set anulado_en = clock_timestamp(),
           anulado_por_email = 'sistema:derivador-jornada@likida.internal',
           anulado_motivo = left(
             'reconciliación automática: la fuente de viajes dejó de sostener el día; versión cola '
             || coalesce(d.viajes_version, 'sin-versión'), 500
           )
      from dias_cercados d
     where a.jornada_id = d.id
       and a.tenant_id = d.tenant_id
       and a.procedencia in ('hito_viaje', 'gps')
       and a.anulado_en is null
    returning a.id
  )
  delete from public.jornada_derivacion_trabajo j
   using obsoletos o
   where (j.tenant_id, j.operador_id, j.dia) =
         (o.tenant_id, o.operador_id, o.dia)
     -- Dependencia explícita: la historia se anula antes de soltar su trabajo.
     and (select count(*) from asientos_anulados) >= 0;
  get diagnostics v_eliminadas = row_count;

  -- El filtro exterior es sargable y acota el índice de viaje. El interior
  -- aplica el día natural de cada tenant; el día UTC nunca es autoridad.
  with viajes_dia as materialized (
    select v.tenant_id,
           v.operador_id,
           (v.aceptado_en at time zone t.zona_horaria)::date as dia,
           (array_agg(v.id order by v.aceptado_en, v.id))[1] as viaje_id,
           (array_agg(v.unidad_id order by v.aceptado_en, v.id)
             filter (where v.unidad_id is not null))[1] as unidad_id,
           coalesce(array_agg(distinct v.unidad_id order by v.unidad_id)
             filter (where v.unidad_id is not null), array[]::uuid[]) as unidad_ids,
           min(v.aceptado_en) as aceptado_en,
           md5(string_agg(
             concat_ws(':', v.id::text, coalesce(v.unidad_id::text, '-'), v.aceptado_en::text),
             ',' order by v.aceptado_en, v.id
           )) as viajes_version
      from public.viaje v
      join public.tenant t on t.id = v.tenant_id
     where v.aceptado_en is not null
       and v.aceptado_en >= p_ahora - make_interval(days => p_dias + 1)
       and v.aceptado_en < p_ahora + interval '1 day'
       and (v.aceptado_en at time zone t.zona_horaria)::date
             between (p_ahora at time zone t.zona_horaria)::date - (p_dias - 1)
                 and (p_ahora at time zone t.zona_horaria)::date
     group by v.tenant_id, v.operador_id,
              (v.aceptado_en at time zone t.zona_horaria)::date
  )
  insert into public.jornada_derivacion_trabajo as j (
    tenant_id, operador_id, dia, viaje_id, unidad_id, unidad_ids,
    aceptado_en, viajes_version, input_version
  )
  select v.tenant_id, v.operador_id, v.dia, v.viaje_id, v.unidad_id,
         v.unidad_ids, v.aceptado_en, v.viajes_version, v.viajes_version
    from viajes_dia v
  on conflict on constraint jornada_derivacion_trabajo_pkey do update
     set viaje_id = excluded.viaje_id,
         unidad_id = excluded.unidad_id,
         unidad_ids = excluded.unidad_ids,
         aceptado_en = excluded.aceptado_en,
         viajes_version = excluded.viajes_version,
         siguiente_intento_en = case
           when j.viajes_version is distinct from excluded.viajes_version
             then '-infinity'::timestamptz
           else j.siguiente_intento_en
         end,
         updated_at = clock_timestamp()
   where (j.claim_token is null or j.lease_expires_at <= clock_timestamp())
     and (j.viaje_id, j.unidad_id, j.unidad_ids, j.aceptado_en, j.viajes_version)
         is distinct from
         (excluded.viaje_id, excluded.unidad_id, excluded.unidad_ids,
          excluded.aceptado_en, excluded.viajes_version);

  get diagnostics v_afectadas = row_count;
  return v_afectadas + v_eliminadas;
end;
$$;

-- El contrato 0319 mezclaba UPSERT de fuentes y claim. El caller vigente usa
-- las dos fases separadas; retirar el overload impide que otro worker vuelva a
-- introducir la espera por transactionid accidentalmente.
drop function if exists public.reclamar_jornadas_por_derivar(
  timestamptz, timestamptz, integer, text, integer
);

create or replace function public.reclamar_jornadas_por_derivar(
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
  zona_horaria text,
  claim_token uuid,
  input_version text,
  aviso_previo boolean,
  gps_primera_en timestamptz,
  gps_primera_unidad_id uuid,
  gps_ultima_en timestamptz,
  gps_ultima_unidad_id uuid,
  intentos integer,
  hay_mas boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limite < 1 or p_limite > 1000 then
    raise exception 'jornada derivacion claim size must be between 1 and 1000';
  end if;
  if nullif(btrim(p_owner), '') is null then
    raise exception 'jornada derivacion lease owner is required';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'jornada derivacion lease seconds must be between 30 and 900';
  end if;

  return query
  with elegibles as materialized (
    select j.tenant_id, j.operador_id, j.dia,
           row_number() over (
             partition by j.tenant_id
             order by j.procesado_al_menos_una_vez, j.siguiente_intento_en,
                      j.aceptado_en, j.viaje_id
           ) as turno_tenant
      from public.jornada_derivacion_trabajo j
     where (j.claim_token is null or j.lease_expires_at <= clock_timestamp())
       and j.siguiente_intento_en <= clock_timestamp()
  ), candidatos as materialized (
    select j.tenant_id, j.operador_id, j.dia, e.turno_tenant
      from public.jornada_derivacion_trabajo j
      join elegibles e using (tenant_id, operador_id, dia)
     order by e.turno_tenant, j.tenant_id
     for update of j skip locked
     limit p_limite
  ), limites as materialized (
    select j.*, c.turno_tenant, t.zona_horaria,
           (j.dia::timestamp at time zone t.zona_horaria) as desde,
           ((j.dia + 1)::timestamp at time zone t.zona_horaria) as hasta,
           (o.aviso_privacidad_en is not null) as aviso_previo
      from candidatos c
      join public.jornada_derivacion_trabajo j
        using (tenant_id, operador_id, dia)
      join public.tenant t on t.id = j.tenant_id
      join public.operador o
        on o.id = j.operador_id and o.tenant_id = j.tenant_id
  ), gps_primero as materialized (
    select distinct on (l.tenant_id, l.operador_id, l.dia)
           l.tenant_id, l.operador_id, l.dia, p.medida_en, p.unidad_id
      from limites l
      join public.posicion p
        on p.tenant_id = l.tenant_id
       and p.unidad_id = any(l.unidad_ids)
       and p.medida_en >= l.desde and p.medida_en < l.hasta
     order by l.tenant_id, l.operador_id, l.dia, p.medida_en, p.id
  ), gps_ultimo as materialized (
    select distinct on (l.tenant_id, l.operador_id, l.dia)
           l.tenant_id, l.operador_id, l.dia, p.medida_en, p.unidad_id
      from limites l
      join public.posicion p
        on p.tenant_id = l.tenant_id
       and p.unidad_id = any(l.unidad_ids)
       and p.medida_en >= l.desde and p.medida_en < l.hasta
     order by l.tenant_id, l.operador_id, l.dia, p.medida_en desc, p.id desc
  ), fuentes as materialized (
    select l.*,
           pri.medida_en as primera_en,
           pri.unidad_id as primera_unidad_id,
           ult.medida_en as ultima_en,
           ult.unidad_id as ultima_unidad_id,
           md5(concat_ws('|', l.viajes_version,
             coalesce(pri.medida_en::text, '-'), coalesce(pri.unidad_id::text, '-'),
             coalesce(ult.medida_en::text, '-'), coalesce(ult.unidad_id::text, '-')
           )) as version_actual
      from limites l
      left join gps_primero pri using (tenant_id, operador_id, dia)
      left join gps_ultimo ult using (tenant_id, operador_id, dia)
  ), reclamados as (
    update public.jornada_derivacion_trabajo j
       set input_version = f.version_actual,
           claim_input_version = f.version_actual,
           claim_token = gen_random_uuid(),
           claim_owner = left(p_owner, 100),
           claim_zona_horaria = f.zona_horaria,
           claim_aviso_previo = f.aviso_previo,
           claim_gps_primera_en = f.primera_en,
           claim_gps_primera_unidad_id = f.primera_unidad_id,
           claim_gps_ultima_en = f.ultima_en,
           claim_gps_ultima_unidad_id = f.ultima_unidad_id,
           lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
           intentos = j.intentos + 1,
           updated_at = clock_timestamp()
      from fuentes f
     where (j.tenant_id, j.operador_id, j.dia) =
           (f.tenant_id, f.operador_id, f.dia)
    returning j.*, f.turno_tenant
  )
  select r.viaje_id, r.tenant_id, r.operador_id, r.unidad_id, r.unidad_ids,
         r.aceptado_en, r.dia, r.claim_zona_horaria, r.claim_token,
         r.claim_input_version, r.claim_aviso_previo,
         r.claim_gps_primera_en, r.claim_gps_primera_unidad_id,
         r.claim_gps_ultima_en, r.claim_gps_ultima_unidad_id, r.intentos,
         exists (
           select 1 from public.jornada_derivacion_trabajo pendiente
            where (pendiente.claim_token is null
                   or pendiente.lease_expires_at <= clock_timestamp())
              and pendiente.siguiente_intento_en <= clock_timestamp()
              and not exists (
                select 1 from reclamados ya
                 where (ya.tenant_id, ya.operador_id, ya.dia) =
                       (pendiente.tenant_id, pendiente.operador_id, pendiente.dia)
              )
         ) as hay_mas
    from reclamados r
   order by r.turno_tenant, r.tenant_id;
end;
$$;

-- La 0319 ya versiona ampliaciones. Esta revisión cubre el camino inverso:
-- después de anular una inferencia contraída, el mismo origen puede reaparecer
-- sin chocar con el índice histórico. Cada restitución recibe identidad propia y
-- apunta a la versión automática anterior; nunca edita `momento` en silencio.
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
  v_previa public.jornada_asiento%rowtype;
  v_nuevo_id uuid := gen_random_uuid();
  v_origen_nuevo text;
  v_resultado text := 'asentado';
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

  perform 1
    from public.jornada_dia d
   where d.id = p_jornada_id and d.tenant_id = p_tenant_id
   for update;
  if not found then raise exception 'journey day does not belong to tenant'; end if;

  select a.* into v_actual
    from public.jornada_asiento a
   where a.jornada_id = p_jornada_id
     and a.tenant_id = p_tenant_id
     and a.tipo = p_tipo
     and a.anulado_en is null
   for update;

  if found then
    if v_actual.procedencia not in ('hito_viaje', 'gps') then return 'ya_estaba'; end if;
    -- Este escritor sigue ampliando por sí solo. Las contracciones sólo se
    -- habilitan tras la comparación completa y cercada del procesador 0325.
    if (p_tipo = 'inicio_jornada' and p_momento >= v_actual.momento)
       or (p_tipo = 'fin_jornada' and p_momento <= v_actual.momento) then
      return 'ya_estaba';
    end if;
    update public.jornada_asiento
       set anulado_en = clock_timestamp(),
           anulado_por_email = 'sistema:derivador-jornada@likida.internal',
           anulado_motivo = 'Nueva evidencia automática amplió el extremo derivado'
     where id = v_actual.id and tenant_id = p_tenant_id and anulado_en is null;
    v_previa := v_actual;
    v_resultado := 'actualizado';
  else
    select a.* into v_previa
      from public.jornada_asiento a
     where a.jornada_id = p_jornada_id
       and a.tenant_id = p_tenant_id
       and a.tipo = p_tipo
       and a.procedencia in ('hito_viaje', 'gps')
     order by coalesce(a.anulado_en, a.created_at) desc, a.id desc
     limit 1;
    if found then v_resultado := 'actualizado'; end if;
  end if;

  if v_previa.id is null
     and not exists (
       select 1 from public.jornada_asiento a
        where a.jornada_id = p_jornada_id and a.origen_ref = p_origen_ref
     ) then
    v_origen_nuevo := p_origen_ref;
  else
    v_origen_nuevo := p_origen_ref || ':version:' || v_nuevo_id::text;
  end if;

  insert into public.jornada_asiento (
    id, tenant_id, jornada_id, tipo, momento, procedencia, origen_ref,
    viaje_id, unidad_id, detalle, corrige_a
  ) values (
    v_nuevo_id, p_tenant_id, p_jornada_id, p_tipo, p_momento, p_procedencia,
    v_origen_nuevo, p_viaje_id, p_unidad_id,
    coalesce(p_detalle, '{}'::jsonb) || case when v_previa.id is null then '{}'::jsonb else jsonb_build_object(
      'version_anterior_id', v_previa.id,
      'version_anterior_momento', v_previa.momento
    ) end,
    v_previa.id
  );
  return v_resultado;
end;
$$;

revoke all on function public.asentar_extremo_jornada_derivado(uuid, uuid, text, timestamptz, text, text, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.asentar_extremo_jornada_derivado(uuid, uuid, text, timestamptz, text, text, uuid, uuid, jsonb) to service_role;

-- Procesa un lote ya cercado. Cada fila tiene subtransacción propia: el fallo
-- de un expediente no revierte los anteriores ni deja el lote completo mudo.
create or replace function public.procesar_jornadas_derivadas(
  p_owner text,
  p_claim_tokens uuid[],
  p_retraso_exito_seconds integer default 3600,
  p_retraso_fallo_seconds integer default 300
) returns table (
  claim_token uuid,
  exito boolean,
  asentados integer,
  ya_estaban integer,
  dia_sin_gps boolean,
  sin_aviso boolean,
  error text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.jornada_derivacion_trabajo%rowtype;
  v_jornada_id uuid;
  v_resultado text;
  v_asentados integer;
  v_ya_estaban integer;
  v_sin_gps boolean;
  v_error text;
  v_viajes_version_actual text;
  v_input_version_actual text;
  v_viaje_id_actual uuid;
  v_unidad_id_actual uuid;
  v_unidad_ids_actual uuid[];
  v_aceptado_en_actual timestamptz;
  v_gps_primera_en_actual timestamptz;
  v_gps_primera_unidad_id_actual uuid;
  v_gps_ultima_en_actual timestamptz;
  v_gps_ultima_unidad_id_actual uuid;
  v_inicio_momento_actual timestamptz;
  v_inicio_procedencia_actual text;
  v_inicio_unidad_id_actual uuid;
begin
  if nullif(btrim(p_owner), '') is null then
    raise exception 'jornada derivacion lease owner is required';
  end if;
  if coalesce(cardinality(p_claim_tokens), 0) < 1
     or cardinality(p_claim_tokens) > 100 then
    raise exception 'jornada derivacion processing batch must be between 1 and 100';
  end if;
  if p_retraso_exito_seconds < 0 or p_retraso_exito_seconds > 86400
     or p_retraso_fallo_seconds < 0 or p_retraso_fallo_seconds > 86400 then
    raise exception 'jornada derivacion retry delay is invalid';
  end if;

  for v in
    select j.*
      from public.jornada_derivacion_trabajo j
     where j.claim_owner = left(p_owner, 100)
       and j.claim_token = any(p_claim_tokens)
       and j.lease_expires_at > clock_timestamp()
     order by j.aceptado_en, j.viaje_id
     for update
  loop
    v_asentados := 0;
    v_ya_estaban := 0;
    v_sin_gps := false;
    v_error := null;

    begin
      -- Orden total: trabajo → viajes → posiciones → expediente. Los
      -- UPDATE/DELETE concurrentes esperan; los INSERT nuevos reabren después.
      perform 1
        from public.viaje fuente
       where fuente.tenant_id = v.tenant_id
         and fuente.operador_id = v.operador_id
         and fuente.aceptado_en is not null
         and fuente.aceptado_en >= (v.dia::timestamp at time zone v.claim_zona_horaria)
         and fuente.aceptado_en < ((v.dia + 1)::timestamp at time zone v.claim_zona_horaria)
       order by fuente.id
       for share;

      select (array_agg(fuente.id order by fuente.aceptado_en, fuente.id))[1],
             (array_agg(fuente.unidad_id order by fuente.aceptado_en, fuente.id)
               filter (where fuente.unidad_id is not null))[1],
             coalesce(array_agg(distinct fuente.unidad_id order by fuente.unidad_id)
               filter (where fuente.unidad_id is not null), array[]::uuid[]),
             min(fuente.aceptado_en),
             md5(string_agg(
               concat_ws(':', fuente.id::text, coalesce(fuente.unidad_id::text, '-'),
                         fuente.aceptado_en::text),
               ',' order by fuente.aceptado_en, fuente.id
             ))
        into v_viaje_id_actual, v_unidad_id_actual, v_unidad_ids_actual,
             v_aceptado_en_actual, v_viajes_version_actual
        from public.viaje fuente
       where fuente.tenant_id = v.tenant_id
         and fuente.operador_id = v.operador_id
         and fuente.aceptado_en is not null
         and fuente.aceptado_en >= (v.dia::timestamp at time zone v.claim_zona_horaria)
         and fuente.aceptado_en < ((v.dia + 1)::timestamp at time zone v.claim_zona_horaria);

      v_gps_primera_en_actual := null;
      v_gps_primera_unidad_id_actual := null;
      v_gps_ultima_en_actual := null;
      v_gps_ultima_unidad_id_actual := null;
      if cardinality(v_unidad_ids_actual) > 0 then
        perform 1
          from public.posicion p
         where p.tenant_id = v.tenant_id
           and p.unidad_id = any(v_unidad_ids_actual)
           and p.medida_en >= (v.dia::timestamp at time zone v.claim_zona_horaria)
           and p.medida_en < ((v.dia + 1)::timestamp at time zone v.claim_zona_horaria)
         order by p.id
         for share;
        select (array_agg(p.medida_en order by p.medida_en, p.id))[1],
               (array_agg(p.unidad_id order by p.medida_en, p.id))[1],
               (array_agg(p.medida_en order by p.medida_en desc, p.id desc))[1],
               (array_agg(p.unidad_id order by p.medida_en desc, p.id desc))[1]
          into v_gps_primera_en_actual, v_gps_primera_unidad_id_actual,
               v_gps_ultima_en_actual, v_gps_ultima_unidad_id_actual
          from public.posicion p
         where p.tenant_id = v.tenant_id
           and p.unidad_id = any(v_unidad_ids_actual)
           and p.medida_en >= (v.dia::timestamp at time zone v.claim_zona_horaria)
           and p.medida_en < ((v.dia + 1)::timestamp at time zone v.claim_zona_horaria);
      end if;

      v_input_version_actual := case when v_viajes_version_actual is null then null else md5(concat_ws('|',
        v_viajes_version_actual,
        coalesce(v_gps_primera_en_actual::text, '-'), coalesce(v_gps_primera_unidad_id_actual::text, '-'),
        coalesce(v_gps_ultima_en_actual::text, '-'), coalesce(v_gps_ultima_unidad_id_actual::text, '-')
      )) end;
      v_inicio_momento_actual := v_aceptado_en_actual;
      v_inicio_procedencia_actual := 'hito_viaje';
      v_inicio_unidad_id_actual := v_unidad_id_actual;
      if v_gps_primera_en_actual is not null
         and v_gps_primera_en_actual < v_aceptado_en_actual then
        v_inicio_momento_actual := v_gps_primera_en_actual;
        v_inicio_procedencia_actual := 'gps';
        v_inicio_unidad_id_actual := v_gps_primera_unidad_id_actual;
      end if;

      v_jornada_id := null;
      select d.id into v_jornada_id
        from public.jornada_dia d
       where d.tenant_id = v.tenant_id and d.operador_id = v.operador_id and d.dia = v.dia
       for update;

      if v_viajes_version_actual is null then
        -- Ya no existe ninguna fuente para este bucket. Conservar el expediente
        -- y anular sólo sus inferencias; una marca humana queda intacta.
        if v_jornada_id is not null then
          update public.jornada_asiento a
             set anulado_en = clock_timestamp(),
                 anulado_por_email = 'sistema:derivador-jornada@likida.internal',
                 anulado_motivo = left(
                   'reconciliación automática: ningún viaje aceptado sostiene ya el día; versión previa '
                   || coalesce(a.detalle ->> 'derivacion_input_version', v.claim_input_version, 'legado'), 500
                 )
           where a.jornada_id = v_jornada_id and a.tenant_id = v.tenant_id
             and a.procedencia in ('hito_viaje', 'gps') and a.anulado_en is null;
        end if;
      elsif v.claim_aviso_previo is not true then
        v_error := 'aviso de privacidad pendiente';
      else
        if v_jornada_id is null then
          insert into public.jornada_dia (tenant_id, operador_id, dia)
          values (v.tenant_id, v.operador_id, v.dia)
          on conflict (tenant_id, operador_id, dia) do nothing;
          select d.id into strict v_jornada_id
            from public.jornada_dia d
           where d.tenant_id = v.tenant_id and d.operador_id = v.operador_id and d.dia = v.dia
           for update;
        end if;

        -- La versión esperada puede contraerse. Anular antes de reconstruir
        -- libera el índice de extremo vivo sin tocar marcas humanas.
        update public.jornada_asiento a
           set anulado_en = clock_timestamp(),
               anulado_por_email = 'sistema:derivador-jornada@likida.internal',
               anulado_motivo = left(
                 'reconciliación automática: cambió la evidencia; versión previa '
                 || coalesce(a.detalle ->> 'derivacion_input_version', 'legado')
                 || ', versión nueva ' || coalesce(v_input_version_actual, 'sin-fuente'), 500
               )
         where a.jornada_id = v_jornada_id and a.tenant_id = v.tenant_id
           and a.procedencia in ('hito_viaje', 'gps') and a.anulado_en is null
           and (
             (a.tipo = 'inicio_jornada' and
               (a.momento, a.procedencia, a.viaje_id, a.unidad_id) is distinct from
               (v_inicio_momento_actual, v_inicio_procedencia_actual,
                v_viaje_id_actual, v_inicio_unidad_id_actual))
             or
             (a.tipo = 'fin_jornada' and
               (v_gps_ultima_en_actual is null
                or v_gps_ultima_en_actual = v_gps_primera_en_actual
                or (a.momento, a.procedencia, a.viaje_id, a.unidad_id) is distinct from
                   (v_gps_ultima_en_actual, 'gps'::text,
                    v_viaje_id_actual, v_gps_ultima_unidad_id_actual)))
           );

        v_resultado := public.asentar_extremo_jornada_derivado(
          v_jornada_id, v.tenant_id, 'inicio_jornada', v_aceptado_en_actual,
          'hito_viaje', 'viaje:' || v_viaje_id_actual::text || ':aceptado_en',
          v_viaje_id_actual, v_unidad_id_actual,
          jsonb_build_object('hecho', 'el operador aceptó el viaje por WhatsApp', 'cota', 'inferior',
                             'derivacion_input_version', v_input_version_actual)
        );
        if v_resultado in ('asentado', 'actualizado') then v_asentados := v_asentados + 1;
        else v_ya_estaban := v_ya_estaban + 1; end if;

        if cardinality(v_unidad_ids_actual) > 0 and v_gps_primera_en_actual is null then
          v_sin_gps := true;
        elsif v_gps_primera_en_actual is not null then
          v_resultado := public.asentar_extremo_jornada_derivado(
            v_jornada_id, v.tenant_id, 'inicio_jornada', v_gps_primera_en_actual,
            'gps', concat('gps:', v_gps_primera_unidad_id_actual, ':', v.dia,
                          ':primera:', v_gps_primera_en_actual),
            v_viaje_id_actual, v_gps_primera_unidad_id_actual,
            jsonb_build_object('hecho', 'primera posición de la unidad ese día', 'cota', 'inferior',
                               'zona_horaria', v.claim_zona_horaria,
                               'derivacion_input_version', v_input_version_actual)
          );
          if v_resultado in ('asentado', 'actualizado') then v_asentados := v_asentados + 1;
          else v_ya_estaban := v_ya_estaban + 1; end if;

          if v_gps_ultima_en_actual is not null
             and v_gps_ultima_en_actual <> v_gps_primera_en_actual then
            v_resultado := public.asentar_extremo_jornada_derivado(
              v_jornada_id, v.tenant_id, 'fin_jornada', v_gps_ultima_en_actual,
              'gps', concat('gps:', v_gps_ultima_unidad_id_actual, ':', v.dia,
                            ':ultima:', v_gps_ultima_en_actual),
              v_viaje_id_actual, v_gps_ultima_unidad_id_actual,
              jsonb_build_object('hecho', 'última posición de la unidad ese día', 'cota', 'inferior',
                                 'zona_horaria', v.claim_zona_horaria,
                                 'derivacion_input_version', v_input_version_actual)
            );
            if v_resultado in ('asentado', 'actualizado') then v_asentados := v_asentados + 1;
            else v_ya_estaban := v_ya_estaban + 1; end if;
          end if;
        end if;
      end if;
    exception when others then
      -- La subtransacción revierte los asientos de esta fila; los contadores
      -- deben reflejar ese rollback y no reportar escrituras fantasma.
      v_asentados := 0;
      v_ya_estaban := 0;
      v_sin_gps := false;
      v_error := left(sqlstate || ': ' || sqlerrm, 500);
    end;

    if not public.finalizar_jornada_derivacion(
      v.claim_token, p_owner, v_error is null, v_error,
      case when v_error is null then p_retraso_exito_seconds else p_retraso_fallo_seconds end
    ) then
      v_error := coalesce(v_error || '; ', '') || 'claim perdido durante ACK';
    end if;

    claim_token := v.claim_token;
    exito := v_error is null;
    asentados := v_asentados;
    ya_estaban := v_ya_estaban;
    dia_sin_gps := v_sin_gps;
    sin_aviso := v.claim_aviso_previo is not true;
    error := v_error;
    return next;
  end loop;
end;
$$;

-- Al liberar/confirmar, borra también el snapshot. El processed_version sigue
-- guardando exactamente la versión cercada por el claim.
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
declare v_actualizadas integer;
begin
  if p_claim_token is null or nullif(btrim(p_owner), '') is null then return false; end if;
  if p_retraso_seconds < 0 or p_retraso_seconds > 86400 then
    raise exception 'jornada derivacion retry delay must be between 0 and 86400';
  end if;
  update public.jornada_derivacion_trabajo j
     set procesado_al_menos_una_vez = j.procesado_al_menos_una_vez or p_exito,
         processed_version = case when p_exito then j.claim_input_version else j.processed_version end,
         siguiente_intento_en = case
           when p_exito and j.input_version is distinct from j.claim_input_version
             then '-infinity'::timestamptz
           else clock_timestamp() + make_interval(secs => p_retraso_seconds)
         end,
         ultimo_error = case when p_exito then null else left(coalesce(p_error, 'fallo sin detalle'), 500) end,
         claim_token = null, claim_owner = null, claim_input_version = null,
         claim_zona_horaria = null, claim_aviso_previo = null,
         claim_gps_primera_en = null, claim_gps_primera_unidad_id = null,
         claim_gps_ultima_en = null, claim_gps_ultima_unidad_id = null,
         lease_expires_at = null, updated_at = clock_timestamp()
   where j.claim_token = p_claim_token and j.claim_owner = left(p_owner, 100);
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
declare v_actualizadas integer;
begin
  if nullif(btrim(p_owner), '') is null or coalesce(cardinality(p_claim_tokens), 0) = 0 then return 0; end if;
  update public.jornada_derivacion_trabajo j
     set claim_token = null, claim_owner = null, claim_input_version = null,
         claim_zona_horaria = null, claim_aviso_previo = null,
         claim_gps_primera_en = null, claim_gps_primera_unidad_id = null,
         claim_gps_ultima_en = null, claim_gps_ultima_unidad_id = null,
         lease_expires_at = null, intentos = greatest(0, j.intentos - 1),
         updated_at = clock_timestamp()
   where j.claim_owner = left(p_owner, 100) and j.claim_token = any(p_claim_tokens);
  get diagnostics v_actualizadas = row_count;
  return v_actualizadas;
end;
$$;

revoke all on function public.sincronizar_jornadas_por_derivar(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.reclamar_jornadas_por_derivar(integer, text, integer) from public, anon, authenticated;
revoke all on function public.procesar_jornadas_derivadas(text, uuid[], integer, integer) from public, anon, authenticated;
revoke all on function public.finalizar_jornada_derivacion(uuid, text, boolean, text, integer) from public, anon, authenticated;
revoke all on function public.liberar_jornadas_por_derivar(text, uuid[]) from public, anon, authenticated;
grant execute on function public.sincronizar_jornadas_por_derivar(timestamptz, integer) to service_role;
grant execute on function public.reclamar_jornadas_por_derivar(integer, text, integer) to service_role;
grant execute on function public.procesar_jornadas_derivadas(text, uuid[], integer, integer) to service_role;
grant execute on function public.finalizar_jornada_derivacion(uuid, text, boolean, text, integer) to service_role;
grant execute on function public.liberar_jornadas_por_derivar(text, uuid[]) to service_role;
