-- 0332 — contrato funcional de purgas 0104 y composición del mantenimiento.
-- Ejecutar únicamente sobre una base local/efímera con las migraciones.

\set ON_ERROR_STOP on
begin;

insert into public.tenant(id, nombre) values
  ('33200000-0000-4000-8000-000000000010', 'Retención 0332');
insert into public.operador(id, tenant_id, nombre, telefono)
values ('33200000-0000-4000-8000-000000000011', '33200000-0000-4000-8000-000000000010', 'Operador 0332', '529993320011');
insert into public.viaje(id, tenant_id, operador_id, folio)
values ('33200000-0000-4000-8000-000000000012', '33200000-0000-4000-8000-000000000010', '33200000-0000-4000-8000-000000000011', 'RET-0332');

-- Deadline vencido: no autoriza siquiera la primera tanda.
insert into public.wa_conversacion(tenant_id, telefono, updated_at)
select '33200000-0000-4000-8000-000000000010', '5288' || lpad(g::text, 8, '0'), now() - interval '181 days'
  from generate_series(1, 5001) g;

do $deadline$
declare r jsonb; restantes bigint;
begin
  r := public.purgar_wa_conversacion(180, now(), clock_timestamp() - interval '1 second');
  select count(*) into restantes from public.wa_conversacion where tenant_id = '33200000-0000-4000-8000-000000000010';
  if (r->>'borradas')::bigint <> 0 or (r->>'parcial')::boolean is not true
     or (r->>'agotado')::boolean is not false or restantes <> 5001 then
    raise exception '0332 deadline no fue fail-closed: r=% restantes=%', r, restantes;
  end if;
end
$deadline$;

-- Una invocación borra exactamente una tanda y entrega el commit al cron.
do $tanda$
declare r1 jsonb; r2 jsonb; viejas bigint;
begin
  r1 := public.purgar_wa_conversacion(180, now(), clock_timestamp() + interval '30 seconds');
  select count(*) into viejas from public.wa_conversacion
   where tenant_id = '33200000-0000-4000-8000-000000000010' and updated_at < now() - interval '180 days';
  if (r1->>'borradas')::bigint <> 5000 or (r1->>'parcial')::boolean is not true
     or (r1->>'agotado')::boolean is not false or viejas <> 1 then
    raise exception '0332 primera tanda incorrecta: r=% viejas=%', r1, viejas;
  end if;

  r2 := public.purgar_wa_conversacion(180, now(), clock_timestamp() + interval '30 seconds');
  select count(*) into viejas from public.wa_conversacion
   where tenant_id = '33200000-0000-4000-8000-000000000010' and updated_at < now() - interval '180 days';
  if (r2->>'borradas')::bigint <> 1 or (r2->>'parcial')::boolean is not false
     or (r2->>'agotado')::boolean is not true or viejas <> 0 then
    raise exception '0332 segunda tanda incorrecta: r=% viejas=%', r2, viejas;
  end if;
end
$tanda$;

insert into public.codigo_pendiente(tenant_id, viaje_id, monto, creado_en) values
  ('33200000-0000-4000-8000-000000000010', '33200000-0000-4000-8000-000000000012', 100, now() - interval '181 days'),
  ('33200000-0000-4000-8000-000000000010', '33200000-0000-4000-8000-000000000012', 200, now() - interval '1 day');

-- 0289 no se puede perder al redefinir mantenimiento_de_datos.
insert into public.incidencia(id, tenant_id, tipo, estado, resuelta_en, lat, lng)
values ('33200000-0000-4000-8000-000000000013', '33200000-0000-4000-8000-000000000010', 'desvio', 'resuelta', now() - interval '100 days', 20.9, -89.6);
insert into public.incidencia_evento(tenant_id, incidencia_id, tipo, detalle)
values ('33200000-0000-4000-8000-000000000010', '33200000-0000-4000-8000-000000000013', 'ubicacion_anclada', '{"lat":20.9,"lng":-89.6}'::jsonb);

do $mantenimiento$
declare r jsonb; viejos bigint; frescos bigint; geo_ok boolean; evento_geo_ok boolean; llaves_0289 text[];
begin
  r := public.mantenimiento_de_datos(30, now());
  select count(*) filter (where creado_en < now() - interval '180 days'), count(*) filter (where creado_en >= now() - interval '180 days')
    into viejos, frescos from public.codigo_pendiente where tenant_id = '33200000-0000-4000-8000-000000000010';
  select lat is null and lng is null into geo_ok from public.incidencia where id = '33200000-0000-4000-8000-000000000013';
  select not (detalle ? 'lat') and not (detalle ? 'lng') and detalle ? 'geolocalizacion_purgada_en'
    into evento_geo_ok from public.incidencia_evento where incidencia_id = '33200000-0000-4000-8000-000000000013';
  llaves_0289 := array[
    'waPurgados','diasWa','iaConsolidados','llmCostoPurgado','idempotenciaPurgada','correoPurgado',
    'corridasPurgadas','conversacionesPurgadas','codigosPurgados','prospectoPersonasPurgadas',
    'prospectoCorreosPurgados','prospectoPiezasPurgadas','prospectoDossiersAnonimizados',
    'prospectoToquesAnonimizados','comercialEventosAnonimizados','waEventosPurgados','posicionesPurgadas',
    'bitacoraPurgada','cobranzaContactosPurgados','storageHuerfanoMarcado','storageHuerfanoRevisado',
    'waOutboxPurgado','eventosSeguridadPurgados','incidenciaGeoPurgada','incidenciaEventoGeoPurgado',
    'fallos','parcial','corridaEn'
  ];

  if viejos <> 0 or frescos <> 1 then raise exception '0332 codigo_pendiente: viejos=% frescos=%', viejos, frescos; end if;
  if not coalesce(geo_ok, false) or not coalesce(evento_geo_ok, false)
     or not (r ? 'incidenciaGeoPurgada') or not (r ? 'incidenciaEventoGeoPurgado')
     or not (r ?& llaves_0289) or not (r ? 'conversacionesParcial') or not (r ? 'codigosParcial')
     or not (r ? 'otrasPurgasParcial') then
    raise exception '0332 mantenimiento perdió 0289 o llaves nuevas: r=% geo=% evento=%', r, geo_ok, evento_geo_ok;
  end if;
end
$mantenimiento$;

do $catalogo$
declare permisos_ok boolean; indices_ok boolean;
begin
  permisos_ok := not has_function_privilege('public', 'public.purgar_wa_conversacion(integer,timestamptz,timestamptz)', 'execute')
    and not has_function_privilege('anon', 'public.purgar_wa_conversacion(integer,timestamptz,timestamptz)', 'execute')
    and not has_function_privilege('authenticated', 'public.purgar_wa_conversacion(integer,timestamptz,timestamptz)', 'execute')
    and has_function_privilege('service_role', 'public.purgar_wa_conversacion(integer,timestamptz,timestamptz)', 'execute')
    and not has_function_privilege('public', 'public.purgar_codigo_pendiente(integer,timestamptz,timestamptz)', 'execute')
    and has_function_privilege('service_role', 'public.purgar_codigo_pendiente(integer,timestamptz,timestamptz)', 'execute');
  indices_ok := exists (select 1 from pg_indexes where schemaname='public' and tablename='wa_conversacion' and indexdef ~* '\(updated_at, id\)')
    and exists (select 1 from pg_indexes where schemaname='public' and tablename='codigo_pendiente' and indexdef ~* '\(creado_en, id\)');
  if not permisos_ok or not indices_ok then raise exception '0332 catálogo: permisos=% indices=%', permisos_ok, indices_ok; end if;
end
$catalogo$;

rollback;
\echo '0332_db_retencion_0104: PASS (deadline, 5000+1, geo, permisos, índices)'
