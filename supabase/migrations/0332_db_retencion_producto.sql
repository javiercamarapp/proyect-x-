-- 0332 — Task4: purgas 0104 acotadas sin degradar privacidad ni analítica.
-- Forward-only posterior a 0331. No toca GPS/capacidad.

-- Watermark durable de la frontera ya consolidada. NULL es el estado seguro de
-- transición: el lector conserva el fallback histórico completo hasta que una
-- corrida de mantener_producto_evento termine la consolidación. El watermark
-- y los snapshots se publican en la MISMA transacción; un lector ve ambos o
-- ninguno. El escritor único no backdatea created_at (contrato de 0259).
create table if not exists public.producto_evento_estado (
  singleton boolean primary key default true
    constraint producto_evento_estado_singleton check (singleton),
  detalle_desde timestamptz,
  actualizado_en timestamptz
);
insert into public.producto_evento_estado(singleton, detalle_desde)
values (true, null)
on conflict (singleton) do nothing;
alter table public.producto_evento_estado enable row level security;
revoke all on table public.producto_evento_estado from public, anon, authenticated;
grant select on table public.producto_evento_estado to service_role;
comment on table public.producto_evento_estado is
  'Singleton de 0332: detalle_desde es el inicio del mes actual cuyos meses anteriores ya tienen snapshot. NULL obliga fallback exacto hasta una consolidación exitosa.';

create or replace function public.uso_producto_mensual()
returns table (tenant_id uuid, mes date, eventos bigint)
language sql stable security invoker
set search_path = public, pg_temp
as $$
  with detalle as (
    select pe.tenant_id,
           date_trunc('month', pe.created_at at time zone 'America/Mexico_City')::date as mes,
           count(*) as eventos
      from public.producto_evento pe
     where pe.created_at >= coalesce(
       (select e.detalle_desde from public.producto_evento_estado e where e.singleton),
       '-infinity'::timestamptz
     )
     group by 1, 2
  )
  select coalesce(m.tenant_id, d.tenant_id),
         coalesce(m.mes, d.mes),
         coalesce(m.eventos, d.eventos)
    from public.producto_evento_mensual m
    full join detalle d on d.tenant_id = m.tenant_id and d.mes = m.mes
   order by 1, 2;
$$;

comment on function public.uso_producto_mensual() is
  'Uso mensual por flota: snapshot para meses consolidados y detalle desde el watermark durable de producto_evento_estado. NULL conserva fallback histórico; mantener_producto_evento publica snapshots+watermark atómicamente.';

-- Redefine 0259 para publicar el horizonte sólo DESPUÉS de consolidar todos
-- los meses cerrados. Si consolidar o purgar lanza, la transacción completa
-- revierte y el lector conserva el watermark anterior/fallback exacto.
create or replace function public.mantener_producto_evento(
  p_dias integer default 92,
  p_ahora timestamptz default now(),
  p_vence timestamptz default null
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  corte_ts timestamptz := date_trunc('month', p_ahora at time zone 'America/Mexico_City')
                            at time zone 'America/Mexico_City';
  consolidados bigint;
  purga jsonb;
  watermark timestamptz;
begin
  if p_dias is null or p_dias < 62 then
    raise exception 'mantener_producto_evento: % días es demasiado poco; el mínimo es 62 (el mes debe cerrar y consolidarse antes de morir su detalle)', p_dias
      using errcode='PU001';
  end if;
  if p_ahora is null then
    raise exception 'mantener_producto_evento: p_ahora no puede ser NULL' using errcode='PU002';
  end if;

  insert into public.producto_evento_mensual as m (tenant_id, mes, eventos, consolidado_en)
  select pe.tenant_id,
         date_trunc('month', pe.created_at at time zone 'America/Mexico_City')::date,
         count(*),
         clock_timestamp()
    from public.producto_evento pe
   where pe.created_at < corte_ts
   group by 1, 2
  on conflict (tenant_id, mes) do nothing;
  get diagnostics consolidados = row_count;

  insert into public.producto_evento_estado as e(singleton, detalle_desde, actualizado_en)
  values (true, corte_ts, clock_timestamp())
  on conflict (singleton) do update
    set detalle_desde = greatest(coalesce(e.detalle_desde, '-infinity'::timestamptz), excluded.detalle_desde),
        actualizado_en = excluded.actualizado_en
  returning detalle_desde into watermark;

  purga := public.purgar_en_tandas(
    'public.producto_evento'::regclass,
    format('created_at < %L', p_ahora - make_interval(days=>p_dias)),
    p_vence);

  return jsonb_build_object(
    'mesesConsolidados',consolidados,
    'detalleBorrado',coalesce((purga->>'borradas')::bigint,0),
    'parcial',coalesce((purga->>'parcial')::boolean,false),
    'detalleDesde',watermark
  );
end;
$$;
comment on function public.mantener_producto_evento(integer,timestamptz,timestamptz) is
  'Consolida meses cerrados, publica producto_evento_estado.detalle_desde en la misma transacción y después purga detalle. NULL previo mantiene fallback exacto; el watermark nunca retrocede.';
revoke all on function public.mantener_producto_evento(integer,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.mantener_producto_evento(integer,timestamptz,timestamptz) to service_role;

-- Estrategia de rollout: estos índices son DDL bloqueante dentro de una
-- migración transaccional. Antes de producción se miden cardinalidad y tiempo
-- de lock. Si exceden el presupuesto, se precrean con CREATE INDEX CONCURRENTLY
-- en una ventana controlada; los IF NOT EXISTS de esta migración quedan no-op.
-- La segunda columna hace determinista ORDER BY y evita sort del lote.
create index if not exists wa_conversacion_purga_idx
  on public.wa_conversacion(updated_at, id);
create index if not exists codigo_pendiente_purga_idx
  on public.codigo_pendiente(creado_en, id);

-- La firma anterior devolvía bigint y ejecutaba un DELETE monolítico.
drop function if exists public.purgar_wa_conversacion(integer, timestamptz);
drop function if exists public.purgar_codigo_pendiente(integer, timestamptz);
drop function if exists public.purgar_wa_conversacion(integer, timestamptz, timestamptz);
drop function if exists public.purgar_codigo_pendiente(integer, timestamptz, timestamptz);

-- UNA tanda por RPC: el cron recibe `parcial=true`, termina la llamada (commit)
-- y repite. Así los locks y WAL no crecen durante un loop largo. SKIP LOCKED
-- permite progresar aunque una conversación elegible esté siendo actualizada.
create function public.purgar_wa_conversacion(
  p_dias integer default 180,
  p_ahora timestamptz default now(),
  p_vence timestamptz default null
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  corte timestamptz;
  borradas bigint := 0;
  pendientes boolean := false;
begin
  if p_dias is null or p_dias < 30 then
    raise exception 'purgar_wa_conversacion: % días es demasiado poco; el mínimo es 30', p_dias using errcode='PU001';
  end if;
  if p_ahora is null then
    raise exception 'purgar_wa_conversacion: p_ahora no puede ser NULL' using errcode='PU002';
  end if;
  corte := p_ahora - make_interval(days=>p_dias);

  if p_vence is not null and clock_timestamp() >= p_vence then
    select exists(select 1 from public.wa_conversacion where updated_at < corte)
      into pendientes;
    return jsonb_build_object('borradas',0,'parcial',pendientes,'agotado',not pendientes);
  end if;

  with candidatos as materialized (
    select c.id
      from public.wa_conversacion c
     where c.updated_at < corte
     order by c.updated_at, c.id
     for update skip locked
     limit 5000
  ), borrado as (
    delete from public.wa_conversacion c
     using candidatos x
     where c.id = x.id
     returning 1
  )
  select count(*) into borradas from borrado;

  select exists(select 1 from public.wa_conversacion where updated_at < corte)
    into pendientes;
  return jsonb_build_object('borradas',borradas,'parcial',pendientes,'agotado',not pendientes);
end;
$$;
comment on function public.purgar_wa_conversacion(integer,timestamptz,timestamptz) is
  'Borra como máximo 5000 conversaciones inactivas por llamada, en orden estable y con SKIP LOCKED. Deadline vencido borra cero. Devuelve {borradas, parcial, agotado}; mantenimiento_de_datos/cron repiten tras commit.';
revoke all on function public.purgar_wa_conversacion(integer,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.purgar_wa_conversacion(integer,timestamptz,timestamptz) to service_role;

create function public.purgar_codigo_pendiente(
  p_dias integer default 180,
  p_ahora timestamptz default now(),
  p_vence timestamptz default null
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  corte timestamptz;
  borradas bigint := 0;
  pendientes boolean := false;
begin
  if p_dias is null or p_dias < 30 then
    raise exception 'purgar_codigo_pendiente: % días es demasiado poco; el mínimo es 30', p_dias using errcode='PU001';
  end if;
  if p_ahora is null then
    raise exception 'purgar_codigo_pendiente: p_ahora no puede ser NULL' using errcode='PU002';
  end if;
  corte := p_ahora - make_interval(days=>p_dias);

  if p_vence is not null and clock_timestamp() >= p_vence then
    select exists(select 1 from public.codigo_pendiente where creado_en < corte)
      into pendientes;
    return jsonb_build_object('borradas',0,'parcial',pendientes,'agotado',not pendientes);
  end if;

  with candidatos as materialized (
    select c.id
      from public.codigo_pendiente c
     where c.creado_en < corte
     order by c.creado_en, c.id
     for update skip locked
     limit 5000
  ), borrado as (
    delete from public.codigo_pendiente c
     using candidatos x
     where c.id = x.id
     returning 1
  )
  select count(*) into borradas from borrado;

  select exists(select 1 from public.codigo_pendiente where creado_en < corte)
    into pendientes;
  return jsonb_build_object('borradas',borradas,'parcial',pendientes,'agotado',not pendientes);
end;
$$;
comment on function public.purgar_codigo_pendiente(integer,timestamptz,timestamptz) is
  'Borra como máximo 5000 códigos sin pareja por llamada, en orden estable y con SKIP LOCKED. Deadline vencido borra cero. Devuelve {borradas, parcial, agotado}; mantenimiento_de_datos/cron repiten tras commit.';
revoke all on function public.purgar_codigo_pendiente(integer,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.purgar_codigo_pendiente(integer,timestamptz,timestamptz) to service_role;

-- Copia íntegra la última definición (0289) y agrega las dos purgas 0104 como
-- jsonb. En particular conserva la purga geográfica y sus dos llaves legales.
create or replace function public.mantenimiento_de_datos(
  p_dias_wa integer default 30,
  p_ahora timestamptz default now()
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  vence timestamptz := clock_timestamp() + interval '60 seconds';
  wa jsonb := '{}'::jsonb; eventos jsonb := '{}'::jsonb; posiciones jsonb := '{}'::jsonb;
  llm jsonb := '{}'::jsonb; bitacora jsonb := '{}'::jsonb; cobranza jsonb := '{}'::jsonb;
  storage_huerfano jsonb := '{}'::jsonb; prospectos jsonb := '{}'::jsonb;
  outbox jsonb := '{}'::jsonb; seguridad jsonb := '{}'::jsonb;
  geo_incidencia jsonb := '{}'::jsonb; conv jsonb := '{}'::jsonb; codigos jsonb := '{}'::jsonb;
  ia_consolidados bigint := 0; idem_purgadas bigint := 0; correo_purgado bigint := 0;
  corridas_purgadas bigint := 0; comercial_anonimizados bigint := 0;
  fallos text[] := '{}';
begin
  begin wa := public.purgar_wa_mensaje_procesado(p_dias_wa,p_ahora,vence); exception when others then fallos:=fallos||('wa_mensaje_procesado: '||sqlerrm); end;
  begin ia_consolidados := public.consolidar_llm_costo_mensual(p_ahora); exception when others then fallos:=fallos||('consolidar_llm_costo: '||sqlerrm); end;
  begin idem_purgadas := public.purgar_api_idempotencia(7,p_ahora); exception when others then fallos:=fallos||('api_idempotencia: '||sqlerrm); end;
  begin correo_purgado := public.purgar_correo_procesado(90,p_ahora); exception when others then fallos:=fallos||('correo_procesado: '||sqlerrm); end;
  begin corridas_purgadas := public.purgar_agente_corrida(180,p_ahora); exception when others then fallos:=fallos||('agente_corrida: '||sqlerrm); end;
  begin conv := public.purgar_wa_conversacion(180,p_ahora,vence); exception when others then fallos:=fallos||('wa_conversacion: '||sqlerrm); end;
  begin codigos := public.purgar_codigo_pendiente(180,p_ahora,vence); exception when others then fallos:=fallos||('codigo_pendiente: '||sqlerrm); end;
  begin prospectos := public.purgar_prospecto_persona(365,p_ahora); exception when others then fallos:=fallos||('prospecto_persona: '||sqlerrm); end;
  begin comercial_anonimizados := public.purgar_comercial_evento(365,p_ahora); exception when others then fallos:=fallos||('comercial_evento: '||sqlerrm); end;
  begin eventos := public.purgar_wa_evento_pendiente(30,90,p_ahora,vence); exception when others then fallos:=fallos||('wa_evento_pendiente: '||sqlerrm); end;
  begin posiciones := public.purgar_posicion(90,p_ahora,vence); exception when others then fallos:=fallos||('posicion: '||sqlerrm); end;
  begin llm := public.purgar_llm_costo(13,p_ahora,vence); exception when others then fallos:=fallos||('llm_costo: '||sqlerrm); end;
  begin bitacora := public.purgar_bitacora_auditoria(365,p_ahora,vence); exception when others then fallos:=fallos||('bitacora_auditoria: '||sqlerrm); end;
  begin cobranza := public.purgar_cobranza_contacto(180,p_ahora,vence); exception when others then fallos:=fallos||('cobranza_contacto: '||sqlerrm); end;
  begin storage_huerfano := public.limpiar_storage_huerfano(7,500,p_ahora,vence); exception when others then fallos:=fallos||('storage_huerfano: '||sqlerrm); end;
  begin outbox := public.purgar_wa_outbox(90,p_ahora,vence); exception when others then fallos:=fallos||('wa_outbox: '||sqlerrm); end;
  begin seguridad := public.purgar_evento_seguridad_flota(180,365,p_ahora,vence); exception when others then fallos:=fallos||('evento_seguridad_flota: '||sqlerrm); end;
  begin geo_incidencia := public.purgar_geolocalizacion_incidencia(90,p_ahora); exception when others then fallos:=fallos||('incidencia_geolocalizacion: '||sqlerrm); end;

  return jsonb_build_object(
    'waPurgados',coalesce((wa->>'borradas')::bigint,0),'diasWa',p_dias_wa,
    'iaConsolidados',ia_consolidados,'llmCostoPurgado',coalesce((llm->>'borradas')::bigint,0),
    'idempotenciaPurgada',idem_purgadas,'correoPurgado',correo_purgado,'corridasPurgadas',corridas_purgadas,
    'conversacionesPurgadas',coalesce((conv->>'borradas')::bigint,0),'codigosPurgados',coalesce((codigos->>'borradas')::bigint,0),
    'conversacionesParcial',coalesce((conv->>'parcial')::boolean,false),'codigosParcial',coalesce((codigos->>'parcial')::boolean,false),
    'prospectoPersonasPurgadas',coalesce((prospectos->>'personasBorradas')::bigint,0),
    'prospectoCorreosPurgados',coalesce((prospectos->>'correosBorrados')::bigint,0),
    'prospectoPiezasPurgadas',coalesce((prospectos->>'piezasBorradas')::bigint,0),
    'prospectoDossiersAnonimizados',coalesce((prospectos->>'dossiersAnonimizados')::bigint,0),
    'prospectoToquesAnonimizados',coalesce((prospectos->>'toquesAnonimizados')::bigint,0),
    'comercialEventosAnonimizados',comercial_anonimizados,
    'waEventosPurgados',coalesce((eventos->>'borradas')::bigint,0),'posicionesPurgadas',coalesce((posiciones->>'borradas')::bigint,0),
    'bitacoraPurgada',coalesce((bitacora->>'borradas')::bigint,0),'cobranzaContactosPurgados',coalesce((cobranza->>'borradas')::bigint,0),
    'storageHuerfanoMarcado',coalesce((storage_huerfano->>'marcados')::bigint,0),
    'storageHuerfanoRevisado',coalesce((storage_huerfano->>'revisados')::bigint,0),
    'waOutboxPurgado',coalesce((outbox->>'borradas')::bigint,0),'eventosSeguridadPurgados',coalesce((seguridad->>'borradas')::bigint,0),
    'incidenciaGeoPurgada',coalesce((geo_incidencia->>'incidencias')::bigint,0),
    'incidenciaEventoGeoPurgado',coalesce((geo_incidencia->>'eventos')::bigint,0),
    'otrasPurgasParcial',coalesce((wa->>'parcial')::boolean,false)
      or coalesce((eventos->>'parcial')::boolean,false) or coalesce((posiciones->>'parcial')::boolean,false)
      or coalesce((llm->>'parcial')::boolean,false) or coalesce((bitacora->>'parcial')::boolean,false)
      or coalesce((cobranza->>'parcial')::boolean,false) or coalesce((storage_huerfano->>'parcial')::boolean,false)
      or coalesce((outbox->>'parcial')::boolean,false) or coalesce((seguridad->>'parcial')::boolean,false)
      or cardinality(fallos)>0,
    'fallos',to_jsonb(fallos),'parcial',coalesce((wa->>'parcial')::boolean,false) or coalesce((conv->>'parcial')::boolean,false)
      or coalesce((codigos->>'parcial')::boolean,false) or coalesce((eventos->>'parcial')::boolean,false)
      or coalesce((posiciones->>'parcial')::boolean,false) or coalesce((llm->>'parcial')::boolean,false)
      or coalesce((bitacora->>'parcial')::boolean,false) or coalesce((cobranza->>'parcial')::boolean,false)
      or coalesce((storage_huerfano->>'parcial')::boolean,false) or coalesce((outbox->>'parcial')::boolean,false)
      or coalesce((seguridad->>'parcial')::boolean,false) or cardinality(fallos)>0,
    'corridaEn',p_ahora);
end;
$$;

comment on function public.mantenimiento_de_datos(integer,timestamptz) is
  'Purga nocturna. Conserva todas las purgas y llaves de 0289, incluida geolocalización de incidencias, y añade conversaciones/códigos en una tanda por invocación con resultado parcial.';
revoke all on function public.mantenimiento_de_datos(integer,timestamptz) from public, anon, authenticated;
grant execute on function public.mantenimiento_de_datos(integer,timestamptz) to service_role;
