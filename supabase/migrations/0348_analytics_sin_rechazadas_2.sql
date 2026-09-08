-- 0348 — BE-A2 + DAT-M1 (auditoría 28): 6 agregados más suman liquidaciones
-- RECHAZADAS como si fueran dinero real. La 0344 ya cerró este mismo hueco en
-- `kpis_liquidacion_tenant`/`dinero_observado_por_tipo_tenant`; estos seis
-- quedaron fuera de esa ronda. Mismo predicado (`revision <> 'rechazada'`),
-- misma firma/owner/ACL/SECURITY INVOKER/estabilidad/forma de respuesta —
-- verificado contra la definición VIVA de cada función antes de escribir el
-- `create or replace` (no se asume el archivo de migración original).
begin;

CREATE OR REPLACE FUNCTION public.liquidaciones_por_dia_tenant(p_tenant uuid, p_desde timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('dia', dia, 'n', n) order by dia), '[]'::jsonb)
  from (
    select to_char((created_at at time zone 'America/Mexico_City')::date, 'YYYY-MM-DD') as dia, count(*) as n
    from liquidacion
    where tenant_id = p_tenant and created_at >= p_desde and revision <> 'rechazada'
    group by 1
  ) s;
$function$;

CREATE OR REPLACE FUNCTION public.liquidado_semanal_tenant(p_tenant uuid, p_desde timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('semana', semana, 'total', total) order by semana), '[]'::jsonb)
  from (
    select to_char((created_at at time zone 'America/Mexico_City')::date, 'IYYY-"S"IW') as semana,
           coalesce(sum(total_comprobado), 0) as total
    from liquidacion
    where tenant_id = p_tenant and created_at >= p_desde and revision <> 'rechazada'
    group by 1
  ) s;
$function$;

CREATE OR REPLACE FUNCTION public.operadores_detalle_tenant(p_tenant uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  with v as (
    select operador_id, count(*) as viajes, coalesce(sum(anticipo), 0) as anticipo
    from viaje
    where tenant_id = p_tenant
    group by operador_id
  ),
  c as (
    select vi.operador_id, coalesce(sum(l.total_comprobado), 0) as comprobado
    from liquidacion l
    join viaje vi on vi.id = l.viaje_id and vi.tenant_id = p_tenant
    where l.tenant_id = p_tenant and l.revision <> 'rechazada'
    group by vi.operador_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'operadorId', o.id,
    'nombre', o.nombre,
    'telefono', o.telefono,
    'numeroEmpleado', o.numero_empleado,
    'rfc', o.rfc,
    'activo', o.activo,
    'viajes', coalesce(v.viajes, 0),
    'anticipoTotal', coalesce(v.anticipo, 0),
    'comprobadoTotal', coalesce(c.comprobado, 0),
    'licencia', o.licencia,
    'licenciaTipo', o.licencia_tipo,
    'licenciaVence', to_char(o.licencia_vence, 'YYYY-MM-DD')
  ) order by coalesce(v.viajes, 0) desc, o.id), '[]'::jsonb)
  from operador o
  left join v on v.operador_id = o.id
  left join c on c.operador_id = o.id
  where o.tenant_id = p_tenant;
$function$;

CREATE OR REPLACE FUNCTION public.rentabilidad_tenant(p_tenant uuid, p_desde timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  with v as (
    select count(*) filter (where ingreso_flete is not null) as con_ingreso,
           count(*) filter (where ingreso_flete is null)     as sin_ingreso,
           coalesce(sum(ingreso_flete), 0)                   as ingreso
      from viaje
     where tenant_id = p_tenant
       and (p_desde is null or created_at >= p_desde)
  ),
  l as (
    select coalesce(sum(total_comprobado), 0) as costo
      from liquidacion
     where tenant_id = p_tenant
       and (p_desde is null or created_at >= p_desde)
       and revision <> 'rechazada'
  )
  select jsonb_build_object(
    'ingreso',          v.ingreso,
    'viajesConIngreso', v.con_ingreso,
    'viajesSinIngreso', v.sin_ingreso,
    'costoComprobado',  l.costo
  )
  from v, l;
$function$;

CREATE OR REPLACE FUNCTION public.serie_comparativa_tenant(p_tenant uuid, p_ventana_dias integer, p_pasos integer, p_hoy date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  with limites as (
    select
      gs as paso,
      (p_hoy - (gs * p_ventana_dias))::date as hasta,
      (p_hoy - (gs * p_ventana_dias) - (p_ventana_dias - 1))::date as desde
    from generate_series(0, p_pasos - 1) as gs
  ),
  g as (
    select l.paso, round(sum(gasto.monto), 2) as gasto_total
    from limites l
    join gasto on gasto.tenant_id = p_tenant
      and gasto.fecha >= l.desde and gasto.fecha <= l.hasta
    group by l.paso
  ),
  v as (
    select l.paso,
      count(*) as n,
      count(*) filter (where viaje.estatus = 'liquidado') as liquidados
    from limites l
    join viaje on viaje.tenant_id = p_tenant
      and viaje.fecha_inicio >= l.desde and viaje.fecha_inicio <= l.hasta
    group by l.paso
  ),
  liq as (
    select l.paso, round(sum(liquidacion.total_comprobado), 2) as liquidado
    from limites l
    join liquidacion on liquidacion.tenant_id = p_tenant
      and (liquidacion.created_at at time zone 'America/Mexico_City')::date >= l.desde
      and (liquidacion.created_at at time zone 'America/Mexico_City')::date <= l.hasta
      and liquidacion.revision <> 'rechazada'
    group by l.paso
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'desde', to_char(l.desde, 'YYYY-MM-DD'),
      'hasta', to_char(l.hasta, 'YYYY-MM-DD'),
      'gastoTotal', coalesce(g.gasto_total, 0),
      'totalViajes', coalesce(v.n, 0),
      'costoPorViaje', case when coalesce(v.n, 0) = 0 then null
        else round(coalesce(g.gasto_total, 0) / v.n, 2) end,
      'liquidado', coalesce(liq.liquidado, 0),
      'viajesLiquidados', coalesce(v.liquidados, 0)
    ) order by l.paso
  ), '[]'::jsonb)
  from limites l
  left join g on g.paso = l.paso
  left join v on v.paso = l.paso
  left join liq on liq.paso = l.paso;
$function$;

CREATE OR REPLACE FUNCTION public.stats_operador_tenant(p_tenant uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'operadorId', o.id,
    'nombre', o.nombre,
    'viajes', coalesce(d.viajes, 0),
    'dieselTotal', coalesce(d.diesel, 0),
    'diferencias', coalesce(l.n, 0)
  ) order by o.id), '[]'::jsonb)
  from operador o
  left join (
    select v.operador_id, count(distinct g.viaje_id) as viajes, sum(g.monto) as diesel
      from gasto g join viaje v on v.id = g.viaje_id
     where g.tenant_id = p_tenant and g.concepto = 'diesel'
     group by v.operador_id
  ) d on d.operador_id = o.id
  left join (
    select v.operador_id, count(*) as n
      from liquidacion l join viaje v on v.id = l.viaje_id
     where l.tenant_id = p_tenant and abs(coalesce(l.diferencia, 0)) > 0.01
       and l.revision <> 'rechazada'
     group by v.operador_id
  ) l on l.operador_id = o.id
 where o.tenant_id = p_tenant and o.oposicion_automatizada is null;
$function$;

comment on function public.liquidaciones_por_dia_tenant(uuid,timestamptz) is
  '0348: excluye revisiones rechazadas (BE-A2/DAT-M1). Historial sin mutar. SECURITY INVOKER.';
comment on function public.liquidado_semanal_tenant(uuid,timestamptz) is
  '0348: excluye revisiones rechazadas (BE-A2/DAT-M1). Historial sin mutar. SECURITY INVOKER.';
comment on function public.operadores_detalle_tenant(uuid) is
  '0348: comprobadoTotal excluye revisiones rechazadas (BE-A2/DAT-M1); viajes/anticipoTotal siguen sobre viaje, sin cambio. SECURITY INVOKER.';
comment on function public.rentabilidad_tenant(uuid,timestamptz) is
  '0348: costoComprobado excluye revisiones rechazadas (BE-A2/DAT-M1); ingreso sigue sobre viaje, sin cambio. SECURITY INVOKER.';
comment on function public.serie_comparativa_tenant(uuid,int,int,date) is
  '0348: liquidado excluye revisiones rechazadas (BE-A2/DAT-M1). SECURITY INVOKER.';
comment on function public.stats_operador_tenant(uuid) is
  '0348: diferencias excluye revisiones rechazadas (BE-A2/DAT-M1). SECURITY INVOKER.';

commit;
