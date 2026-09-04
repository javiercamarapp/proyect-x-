-- 0332 — contrato funcional de uso_producto_mensual().
-- Ejecutar únicamente sobre una base local/efímera con las migraciones.
--
-- Rompe la mutación peligrosa `created_at >= now() - interval '92 days'`:
-- si el consolidador se retrasa, el lector debe conservar TODO el detalle
-- no consolidado, incluso el mes atravesado por ese corte. Rendimiento no
-- autoriza publicar una cifra parcial o hacer que una cohorte encoja.

\set ON_ERROR_STOP on

begin;

insert into public.tenant(id, nombre) values
  ('33200000-0000-4000-8000-000000000001', 'Producto atrasado 0332'),
  ('33200000-0000-4000-8000-000000000002', 'Producto frontera 0332'),
  ('33200000-0000-4000-8000-000000000003', 'Producto consolidado 0332'),
  ('33200000-0000-4000-8000-000000000004', 'Producto plan 0332');

-- La transición es fail-open para exactitud: antes de la primera
-- consolidación, NULL obliga al fallback histórico completo.
update public.producto_evento_estado set detalle_desde = null where singleton;

insert into public.producto_evento(tenant_id, pantalla, accion, created_at) values
  ('33200000-0000-4000-8000-000000000001', 'viajes', 'pageview', now() - interval '120 days'),
  ('33200000-0000-4000-8000-000000000001', 'resumen', 'pageview', now() - interval '120 days' + interval '1 hour');

-- Los dos lados de la frontera. Ninguno puede desaparecer ni producir un
-- bucket mensual parcialmente contado.
insert into public.producto_evento(tenant_id, pantalla, accion, created_at) values
  ('33200000-0000-4000-8000-000000000002', 'viajes', 'pageview', now() - interval '92 days' - interval '1 second'),
  ('33200000-0000-4000-8000-000000000002', 'resumen', 'pageview', now() - interval '92 days' + interval '1 second');

-- Si ya existe snapshot, conserva precedencia sobre el detalle aún vivo.
insert into public.producto_evento_mensual(tenant_id, mes, eventos)
values (
  '33200000-0000-4000-8000-000000000003',
  date_trunc('month', (now() - interval '120 days') at time zone 'America/Mexico_City')::date,
  7
);
insert into public.producto_evento(tenant_id, pantalla, accion, created_at) values
  ('33200000-0000-4000-8000-000000000003', 'viajes', 'pageview', now() - interval '120 days'),
  ('33200000-0000-4000-8000-000000000003', 'resumen', 'pageview', now() - interval '120 days' + interval '1 hour');

-- Selectividad suficiente para demostrar que, una vez publicado el watermark,
-- el predicado temporal entra por el índice aunque el detalle viejo siga vivo.
insert into public.producto_evento(tenant_id, pantalla, accion, created_at)
select '33200000-0000-4000-8000-000000000004', 'viajes', 'pageview', now() - interval '120 days'
  from generate_series(1, 20000);
insert into public.producto_evento(tenant_id, pantalla, accion, created_at)
select '33200000-0000-4000-8000-000000000004', 'viajes', 'pageview', now()
  from generate_series(1, 10);

do $check$
declare atrasado bigint; frontera bigint; consolidado bigint; antes_watermark timestamptz;
begin
  select detalle_desde into antes_watermark from public.producto_evento_estado where singleton;
  if antes_watermark is not null then raise exception '0332 watermark inicial no fue NULL'; end if;
  select coalesce(sum(eventos), 0) into atrasado
    from public.uso_producto_mensual()
   where tenant_id = '33200000-0000-4000-8000-000000000001';
  select coalesce(sum(eventos), 0) into frontera
    from public.uso_producto_mensual()
   where tenant_id = '33200000-0000-4000-8000-000000000002';
  select coalesce(sum(eventos), 0) into consolidado
    from public.uso_producto_mensual()
   where tenant_id = '33200000-0000-4000-8000-000000000003';

  if atrasado <> 2 then raise exception '0332 producto atrasado: esperado 2, obtenido %', atrasado; end if;
  if frontera <> 2 then raise exception '0332 producto frontera: esperado 2, obtenido %', frontera; end if;
  if consolidado <> 7 then raise exception '0332 consolidado: esperado 7, obtenido %', consolidado; end if;
end
$check$;

-- Conserva detalle para que el plan tenga 20k filas viejas físicamente, pero
-- publica el snapshot+watermark en la misma transacción.
select public.mantener_producto_evento(365, now(), clock_timestamp() + interval '30 seconds');
analyze public.producto_evento;

do $watermark$
declare
  marca timestamptz;
  esperado timestamptz := date_trunc('month', now() at time zone 'America/Mexico_City') at time zone 'America/Mexico_City';
  atrasado bigint; frontera bigint; plan_tenant bigint;
  plan json;
begin
  select detalle_desde into marca from public.producto_evento_estado where singleton;
  if marca is distinct from esperado then raise exception '0332 watermark: esperado %, obtenido %', esperado, marca; end if;

  select coalesce(sum(eventos),0) into atrasado from public.uso_producto_mensual()
   where tenant_id='33200000-0000-4000-8000-000000000001';
  select coalesce(sum(eventos),0) into frontera from public.uso_producto_mensual()
   where tenant_id='33200000-0000-4000-8000-000000000002';
  select coalesce(sum(eventos),0) into plan_tenant from public.uso_producto_mensual()
   where tenant_id='33200000-0000-4000-8000-000000000004';
  if atrasado<>2 or frontera<>2 or plan_tenant<>20010 then
    raise exception '0332 post-watermark perdió verdad: atrasado=% frontera=% plan=%', atrasado, frontera, plan_tenant;
  end if;

  execute $sql$explain (format json)
    select pe.tenant_id,
           date_trunc('month', pe.created_at at time zone 'America/Mexico_City')::date,
           count(*)
      from public.producto_evento pe
      cross join public.producto_evento_estado e
     where e.singleton
       and pe.created_at >= coalesce(e.detalle_desde, '-infinity'::timestamptz)
     group by 1,2$sql$ into plan;
  if plan::text !~ 'producto_evento_creado_idx' then
    raise exception '0332 plan no usa horizonte indexado: %', plan;
  end if;
end
$watermark$;

rollback;
\echo '0332_db_producto_uso: PASS (fallback exacto, watermark atómico, plan indexado)'
