-- 0335 · Corrección forward-only de 0332 (DB R3).
-- No toca GPS, capacidad ni seguridad.
--
-- ROLLOUT OBLIGATORIO ANTES DE 0332/0335 EN PRODUCCIÓN:
--   psql "$DATABASE_URL" -X -f scripts/ci/0335_preflight_retencion_indices.sql
-- El preflight crea los índices sin bloquear escritores y en autocommit. Esta
-- migración transaccional sólo comprueba los índices; nunca intenta DDL concurrente ni
-- introduce DDL bloqueante sobre las dos tablas operativas.

do $indices_preflight$
begin
  if not exists (
    select 1
      from pg_index i
      join pg_class c on c.oid=i.indexrelid
      join pg_am am on am.oid=c.relam
     where c.oid='public.wa_conversacion_purga_idx'::regclass
       and i.indrelid=to_regclass('public.wa_conversacion')
       and i.indisvalid and i.indisready
       and am.amname='btree'
       and i.indnkeyatts=2 and i.indnatts=2
       and i.indpred is null and i.indexprs is null
       and i.indoption='0 0'::int2vector
       and not i.indisunique
       and (select array_agg(a.attname::text order by k.ord)
              from unnest(i.indkey) with ordinality k(attnum,ord)
              join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
             where k.ord<=i.indnkeyatts)=array['updated_at','id']
  ) or not exists (
    select 1
      from pg_index i
      join pg_class c on c.oid=i.indexrelid
      join pg_am am on am.oid=c.relam
     where c.oid='public.codigo_pendiente_purga_idx'::regclass
       and i.indrelid=to_regclass('public.codigo_pendiente')
       and i.indisvalid and i.indisready
       and am.amname='btree'
       and i.indnkeyatts=2 and i.indnatts=2
       and i.indpred is null and i.indexprs is null
       and i.indoption='0 0'::int2vector
       and not i.indisunique
       and (select array_agg(a.attname::text order by k.ord)
              from unnest(i.indkey) with ordinality k(attnum,ord)
              join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
             where k.ord<=i.indnkeyatts)=array['creado_en','id']
  ) then
    raise exception '0335: falta preflight de índices; ejecute scripts/ci/0335_preflight_retencion_indices.sql antes de migrar'
      using errcode='55000';
  end if;
end
$indices_preflight$;

-- Un INSERT toma ROW EXCLUSIVE. SHARE ROW EXCLUSIVE espera escritores ya en
-- vuelo y hace esperar a los nuevos hasta el commit que publica snapshot y
-- watermark. Los SELECT siguen pasando. El lock se toma una sola vez al día
-- y la purga posterior queda acotada a 5,000 filas para no retenerlo 60 s.
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
  corte_purga timestamptz;
  consolidados bigint := 0;
  borradas bigint := 0;
  borradas_tanda bigint := 0;
  pendientes boolean := false;
  watermark timestamptz;
  restante_ms bigint;
  limite_sentencia integer := 5000;
begin
  if p_dias is null or p_dias < 62 then
    raise exception 'mantener_producto_evento: % días es demasiado poco; el mínimo es 62 (el mes debe cerrar y consolidarse antes de morir su detalle)', p_dias
      using errcode='PU001';
  end if;
  if p_ahora is null then
    raise exception 'mantener_producto_evento: p_ahora no puede ser NULL' using errcode='PU002';
  end if;

  if p_vence is not null then
    restante_ms := floor(extract(epoch from (p_vence-clock_timestamp()))*1000);
    if restante_ms <= 0 then
      select detalle_desde into watermark from public.producto_evento_estado where singleton;
      return jsonb_build_object('mesesConsolidados',0,'detalleBorrado',0,
        'parcial',true,'agotado',false,'detalleDesde',watermark);
    end if;
    perform set_config('lock_timeout', least(restante_ms,5000)::text || 'ms', true);
  end if;

  lock table public.producto_evento in share row exclusive mode;

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

  corte_purga := p_ahora - make_interval(days=>p_dias);
  loop
    exit when borradas>=5000;
    if p_vence is not null then
      restante_ms := floor(extract(epoch from (p_vence-clock_timestamp()))*1000);
      exit when restante_ms<=25;
      -- No se puede cancelar desde PL/pgSQL el DELETE actual: cada sentencia
      -- recibe sólo las filas compatibles con el tiempo que aún queda.
      limite_sentencia := least((5000-borradas)::integer,
        greatest(1,floor((restante_ms-25)/15.0)::integer));
    else
      limite_sentencia := (5000-borradas)::integer;
    end if;
    with candidatos as materialized (
      select pe.ctid
        from public.producto_evento pe
       where pe.created_at < corte_purga
       order by pe.created_at, pe.id
       limit limite_sentencia
    ), borrado as (
      delete from public.producto_evento pe
       using candidatos c
       where pe.ctid=c.ctid
       returning 1
    )
    select count(*) into borradas_tanda from borrado;
    borradas:=borradas+borradas_tanda;
    exit when borradas_tanda<limite_sentencia;
  end loop;

  select exists(select 1 from public.producto_evento where created_at < corte_purga)
    into pendientes;
  return jsonb_build_object(
    'mesesConsolidados',consolidados,'detalleBorrado',borradas,
    'parcial',pendientes,'agotado',not pendientes,'detalleDesde',watermark);
end;
$$;
comment on function public.mantener_producto_evento(integer,timestamptz,timestamptz) is
  '0335: serializa escritores antes del snapshot+watermark. Antes de cada DELETE, p_vence se traduce en filas (reserva 25 ms, 15 ms/fila); el total por RPC nunca excede 5000.';
revoke all on function public.mantener_producto_evento(integer,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.mantener_producto_evento(integer,timestamptz,timestamptz) to service_role;

-- PostgreSQL no permite que una función reduzca statement_timeout para cancelar
-- la sentencia que ya la está ejecutando. p_vence se convierte por eso en una
-- frontera efectiva de filas antes del DELETE, además de acotar locks.
create or replace function public.purgar_wa_conversacion(
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
  borradas_tanda bigint := 0;
  pendientes boolean := false;
  restante_ms bigint;
  limite_sentencia integer := 5000;
  lock_timeout_anterior text := current_setting('lock_timeout');
begin
  if p_dias is null or p_dias < 30 then
    raise exception 'purgar_wa_conversacion: % días es demasiado poco; el mínimo es 30', p_dias using errcode='PU001';
  end if;
  if p_ahora is null then
    raise exception 'purgar_wa_conversacion: p_ahora no puede ser NULL' using errcode='PU002';
  end if;
  corte := p_ahora - make_interval(days=>p_dias);

  if p_vence is not null then
    restante_ms := floor(extract(epoch from (p_vence-clock_timestamp()))*1000);
    if restante_ms <= 0 then
      select exists(select 1 from public.wa_conversacion where updated_at < corte) into pendientes;
      return jsonb_build_object('borradas',0,'parcial',pendientes,'agotado',not pendientes);
    end if;
    perform set_config('lock_timeout', least(restante_ms,1000)::text || 'ms', true);
  end if;

  loop
    exit when borradas>=5000;
    if p_vence is not null then
      restante_ms:=floor(extract(epoch from (p_vence-clock_timestamp()))*1000);
      exit when restante_ms<=25;
      limite_sentencia:=least((5000-borradas)::integer,
        greatest(1,floor((restante_ms-25)/15.0)::integer));
    else
      limite_sentencia:=(5000-borradas)::integer;
    end if;
    with candidatos as materialized (
      select c.id from public.wa_conversacion c
       where c.updated_at < corte
       order by c.updated_at,c.id
       for update skip locked limit limite_sentencia
    ), borrado as (
      delete from public.wa_conversacion c using candidatos x
       where c.id=x.id returning 1
    )
    select count(*) into borradas_tanda from borrado;
    borradas:=borradas+borradas_tanda;
    exit when borradas_tanda<limite_sentencia;
  end loop;
  select exists(select 1 from public.wa_conversacion where updated_at < corte) into pendientes;
  perform set_config('lock_timeout',lock_timeout_anterior,true);
  return jsonb_build_object('borradas',borradas,'parcial',pendientes,'agotado',not pendientes);
end;
$$;
comment on function public.purgar_wa_conversacion(integer,timestamptz,timestamptz) is
  '0335: antes de cada DELETE, p_vence se traduce en filas (reserva 25 ms, 15 ms/fila); total máximo 5000. Orden estable, SKIP LOCKED y lock_timeout.';
revoke all on function public.purgar_wa_conversacion(integer,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.purgar_wa_conversacion(integer,timestamptz,timestamptz) to service_role;

create or replace function public.purgar_codigo_pendiente(
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
  borradas_tanda bigint := 0;
  pendientes boolean := false;
  restante_ms bigint;
  limite_sentencia integer := 5000;
  lock_timeout_anterior text := current_setting('lock_timeout');
begin
  if p_dias is null or p_dias < 30 then
    raise exception 'purgar_codigo_pendiente: % días es demasiado poco; el mínimo es 30', p_dias using errcode='PU001';
  end if;
  if p_ahora is null then
    raise exception 'purgar_codigo_pendiente: p_ahora no puede ser NULL' using errcode='PU002';
  end if;
  corte := p_ahora - make_interval(days=>p_dias);

  if p_vence is not null then
    restante_ms := floor(extract(epoch from (p_vence-clock_timestamp()))*1000);
    if restante_ms <= 0 then
      select exists(select 1 from public.codigo_pendiente where creado_en < corte) into pendientes;
      return jsonb_build_object('borradas',0,'parcial',pendientes,'agotado',not pendientes);
    end if;
    perform set_config('lock_timeout', least(restante_ms,1000)::text || 'ms', true);
  end if;

  loop
    exit when borradas>=5000;
    if p_vence is not null then
      restante_ms:=floor(extract(epoch from (p_vence-clock_timestamp()))*1000);
      exit when restante_ms<=25;
      limite_sentencia:=least((5000-borradas)::integer,
        greatest(1,floor((restante_ms-25)/15.0)::integer));
    else
      limite_sentencia:=(5000-borradas)::integer;
    end if;
    with candidatos as materialized (
      select c.id from public.codigo_pendiente c
       where c.creado_en < corte
       order by c.creado_en,c.id
       for update skip locked limit limite_sentencia
    ), borrado as (
      delete from public.codigo_pendiente c using candidatos x
       where c.id=x.id returning 1
    )
    select count(*) into borradas_tanda from borrado;
    borradas:=borradas+borradas_tanda;
    exit when borradas_tanda<limite_sentencia;
  end loop;
  select exists(select 1 from public.codigo_pendiente where creado_en < corte) into pendientes;
  perform set_config('lock_timeout',lock_timeout_anterior,true);
  return jsonb_build_object('borradas',borradas,'parcial',pendientes,'agotado',not pendientes);
end;
$$;
comment on function public.purgar_codigo_pendiente(integer,timestamptz,timestamptz) is
  '0335: antes de cada DELETE, p_vence se traduce en filas (reserva 25 ms, 15 ms/fila); total máximo 5000. Orden estable, SKIP LOCKED y lock_timeout.';
revoke all on function public.purgar_codigo_pendiente(integer,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.purgar_codigo_pendiente(integer,timestamptz,timestamptz) to service_role;

-- Conserva íntegro el contrato 0289/0332; sólo hace explícitos el SQLSTATE y
-- mensaje de cada 0104. Una excepción implica parcial=true, nunca agotado.
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
  fallos text[] := '{}'; conv_error text := null; codigos_error text := null;
  estado_sql text; mensaje_sql text;
begin
  begin wa:=public.purgar_wa_mensaje_procesado(p_dias_wa,p_ahora,vence); exception when others then fallos:=fallos||('wa_mensaje_procesado: '||sqlerrm); end;
  begin ia_consolidados:=public.consolidar_llm_costo_mensual(p_ahora); exception when others then fallos:=fallos||('consolidar_llm_costo: '||sqlerrm); end;
  begin idem_purgadas:=public.purgar_api_idempotencia(7,p_ahora); exception when others then fallos:=fallos||('api_idempotencia: '||sqlerrm); end;
  begin correo_purgado:=public.purgar_correo_procesado(90,p_ahora); exception when others then fallos:=fallos||('correo_procesado: '||sqlerrm); end;
  begin corridas_purgadas:=public.purgar_agente_corrida(180,p_ahora); exception when others then fallos:=fallos||('agente_corrida: '||sqlerrm); end;
  begin
    conv:=public.purgar_wa_conversacion(180,p_ahora,vence);
  exception when query_canceled or others then
    get stacked diagnostics estado_sql=returned_sqlstate,mensaje_sql=message_text;
    conv_error:=estado_sql||': '||mensaje_sql; fallos:=fallos||('wa_conversacion: '||mensaje_sql);
  end;
  begin
    codigos:=public.purgar_codigo_pendiente(180,p_ahora,vence);
  exception when query_canceled or others then
    get stacked diagnostics estado_sql=returned_sqlstate,mensaje_sql=message_text;
    codigos_error:=estado_sql||': '||mensaje_sql; fallos:=fallos||('codigo_pendiente: '||mensaje_sql);
  end;
  begin prospectos:=public.purgar_prospecto_persona(365,p_ahora); exception when others then fallos:=fallos||('prospecto_persona: '||sqlerrm); end;
  begin comercial_anonimizados:=public.purgar_comercial_evento(365,p_ahora); exception when others then fallos:=fallos||('comercial_evento: '||sqlerrm); end;
  begin eventos:=public.purgar_wa_evento_pendiente(30,90,p_ahora,vence); exception when others then fallos:=fallos||('wa_evento_pendiente: '||sqlerrm); end;
  begin posiciones:=public.purgar_posicion(90,p_ahora,vence); exception when others then fallos:=fallos||('posicion: '||sqlerrm); end;
  begin llm:=public.purgar_llm_costo(13,p_ahora,vence); exception when others then fallos:=fallos||('llm_costo: '||sqlerrm); end;
  begin bitacora:=public.purgar_bitacora_auditoria(365,p_ahora,vence); exception when others then fallos:=fallos||('bitacora_auditoria: '||sqlerrm); end;
  begin cobranza:=public.purgar_cobranza_contacto(180,p_ahora,vence); exception when others then fallos:=fallos||('cobranza_contacto: '||sqlerrm); end;
  begin storage_huerfano:=public.limpiar_storage_huerfano(7,500,p_ahora,vence); exception when others then fallos:=fallos||('storage_huerfano: '||sqlerrm); end;
  begin outbox:=public.purgar_wa_outbox(90,p_ahora,vence); exception when others then fallos:=fallos||('wa_outbox: '||sqlerrm); end;
  begin seguridad:=public.purgar_evento_seguridad_flota(180,365,p_ahora,vence); exception when others then fallos:=fallos||('evento_seguridad_flota: '||sqlerrm); end;
  begin geo_incidencia:=public.purgar_geolocalizacion_incidencia(90,p_ahora); exception when others then fallos:=fallos||('incidencia_geolocalizacion: '||sqlerrm); end;

  return jsonb_build_object(
    'waPurgados',coalesce((wa->>'borradas')::bigint,0),'diasWa',p_dias_wa,
    'iaConsolidados',ia_consolidados,'llmCostoPurgado',coalesce((llm->>'borradas')::bigint,0),
    'idempotenciaPurgada',idem_purgadas,'correoPurgado',correo_purgado,'corridasPurgadas',corridas_purgadas,
    'conversacionesPurgadas',coalesce((conv->>'borradas')::bigint,0),'codigosPurgados',coalesce((codigos->>'borradas')::bigint,0),
    'conversacionesParcial',conv_error is not null or coalesce((conv->>'parcial')::boolean,false),
    'codigosParcial',codigos_error is not null or coalesce((codigos->>'parcial')::boolean,false),
    'conversacionesError',conv_error,'codigosError',codigos_error,
    'prospectoPersonasPurgadas',coalesce((prospectos->>'personasBorradas')::bigint,0),
    'prospectoCorreosPurgados',coalesce((prospectos->>'correosBorrados')::bigint,0),
    'prospectoPiezasPurgadas',coalesce((prospectos->>'piezasBorradas')::bigint,0),
    'prospectoDossiersAnonimizados',coalesce((prospectos->>'dossiersAnonimizados')::bigint,0),
    'prospectoToquesAnonimizados',coalesce((prospectos->>'toquesAnonimizados')::bigint,0),
    'comercialEventosAnonimizados',comercial_anonimizados,
    'waEventosPurgados',coalesce((eventos->>'borradas')::bigint,0),'posicionesPurgadas',coalesce((posiciones->>'borradas')::bigint,0),
    'bitacoraPurgada',coalesce((bitacora->>'borradas')::bigint,0),'cobranzaContactosPurgados',coalesce((cobranza->>'borradas')::bigint,0),
    'storageHuerfanoMarcado',coalesce((storage_huerfano->>'marcados')::bigint,0),'storageHuerfanoRevisado',coalesce((storage_huerfano->>'revisados')::bigint,0),
    'waOutboxPurgado',coalesce((outbox->>'borradas')::bigint,0),'eventosSeguridadPurgados',coalesce((seguridad->>'borradas')::bigint,0),
    'incidenciaGeoPurgada',coalesce((geo_incidencia->>'incidencias')::bigint,0),'incidenciaEventoGeoPurgado',coalesce((geo_incidencia->>'eventos')::bigint,0),
    'otrasPurgasParcial',coalesce((wa->>'parcial')::boolean,false)
      or coalesce((eventos->>'parcial')::boolean,false) or coalesce((posiciones->>'parcial')::boolean,false)
      or coalesce((llm->>'parcial')::boolean,false) or coalesce((bitacora->>'parcial')::boolean,false)
      or coalesce((cobranza->>'parcial')::boolean,false) or coalesce((storage_huerfano->>'parcial')::boolean,false)
      or coalesce((outbox->>'parcial')::boolean,false) or coalesce((seguridad->>'parcial')::boolean,false)
      or cardinality(fallos)>0,
    'fallos',to_jsonb(fallos),'parcial',coalesce((wa->>'parcial')::boolean,false)
      or conv_error is not null or codigos_error is not null
      or coalesce((conv->>'parcial')::boolean,false) or coalesce((codigos->>'parcial')::boolean,false)
      or coalesce((eventos->>'parcial')::boolean,false) or coalesce((posiciones->>'parcial')::boolean,false)
      or coalesce((llm->>'parcial')::boolean,false) or coalesce((bitacora->>'parcial')::boolean,false)
      or coalesce((cobranza->>'parcial')::boolean,false) or coalesce((storage_huerfano->>'parcial')::boolean,false)
      or coalesce((outbox->>'parcial')::boolean,false) or coalesce((seguridad->>'parcial')::boolean,false)
      or cardinality(fallos)>0,'corridaEn',p_ahora);
end;
$$;
comment on function public.mantenimiento_de_datos(integer,timestamptz) is
  '0335: conserva todas las purgas/llaves 0289 y propaga conversacionesError/codigosError con SQLSTATE; un fallo 0104 siempre queda parcial para que el cron drene y responda 5xx.';
revoke all on function public.mantenimiento_de_datos(integer,timestamptz) from public, anon, authenticated;
grant execute on function public.mantenimiento_de_datos(integer,timestamptz) to service_role;
