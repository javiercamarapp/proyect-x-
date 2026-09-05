-- 0344 — BE-2: un rechazo invalida los importes operativos agregados.
-- Mantiene pendientes/aprobadas/ajustadas (paridad CSV sin_rechazadas);
-- las cifras fiscales firmadas usan su propio contrato. No toca el historial.
-- Misma firma, owner, ACL, SECURITY INVOKER, estabilidad y forma de respuesta.
begin;
CREATE OR REPLACE FUNCTION public.kpis_liquidacion_tenant(p_tenant uuid, p_desde timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  with base as (
    select
      total_comprobado,
      estatus,
      (
        select coalesce(sum(abs((d->>'monto')::numeric)), 0)
        from jsonb_array_elements(coalesce(diferencias, '[]'::jsonb)) as d
        where d->>'tipo' in ('sobre_politica', 'duplicado')
      ) as dinero_observado_fila
    from liquidacion
    where tenant_id = p_tenant
      and revision <> 'rechazada'
      and (p_desde is null or created_at >= p_desde)
  )
  select jsonb_build_object(
    'viajesLiquidados', count(*),
    'montoComprobado', coalesce(sum(total_comprobado), 0),
    'diferenciaDetectada', coalesce(sum(dinero_observado_fila), 0),
    'conDiferencias', count(*) filter (where estatus = 'con_diferencias'),
    'porRevisar', count(*) filter (where estatus = 'revisar'),
    'tasaCuadre', case when count(*) = 0 then 0
      else round((count(*) filter (where estatus = 'cuadrada'))::numeric * 100 / count(*))::int end
  )
  from base;
$function$;

CREATE OR REPLACE FUNCTION public.dinero_observado_por_tipo_tenant(p_tenant uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  with d as (
    select
      case when jsonb_typeof(e->'tipo') = 'string' then e->>'tipo' else 'otro' end as tipo,
      case when jsonb_typeof(e->'monto') = 'number' then abs((e->>'monto')::numeric) else 0 end as monto
    from liquidacion l
    cross join lateral jsonb_array_elements(l.diferencias) as e
    where l.tenant_id = p_tenant and l.revision <> 'rechazada' and jsonb_typeof(l.diferencias) = 'array'
  )
  select coalesce(jsonb_agg(jsonb_build_object('tipo', tipo, 'monto', monto, 'n', n) order by monto desc, tipo), '[]'::jsonb)
  from (
    select tipo, coalesce(sum(monto), 0) as monto, count(*) as n
    from d
    group by tipo
  ) s;
$function$;

comment on function public.kpis_liquidacion_tenant(uuid,timestamptz) is
  '0344: KPI operativos de una flota, excluyendo revisiones rechazadas. Incluye pendientes, aprobadas y ajustadas; p_desde conserva el corte created_at. Historial sin mutar. SECURITY INVOKER.';
comment on function public.dinero_observado_por_tipo_tenant(uuid) is
  '0344: dinero observado por tipo de una flota, excluyendo revisiones rechazadas, misma forma y valor absoluto. Historial sin mutar. SECURITY INVOKER.';
commit;
