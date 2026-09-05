-- 0342 — La póliza conoce la revisión humana y los tributos del comprobante.
-- Se conservan las pendientes en los insumos para que la ruta bloquee el
-- periodo completo con sus folios, en lugar de omitirlas silenciosamente.
-- No cambia importes, revisiones, permisos ni documentos históricos.
begin;
CREATE OR REPLACE FUNCTION public.poliza_datos_tenant(p_tenant uuid, p_desde date, p_hasta date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'version',        342,
    'liquidacionId',  l.id,
    'revision',      l.revision,
    'folioViaje',     coalesce(v.folio, ''),
    'operador',       coalesce(o.nombre, ''),
    'fecha',          (l.created_at at time zone 'America/Mexico_City')::date,
    'anticipo',       coalesce(l.total_anticipo, 0),
    'comprobado',     coalesce(l.total_comprobado, 0),
    'diferencia',     coalesce(l.diferencia, 0),
    'ivaAcreditable', coalesce(l.iva_acreditable, 0),
    'porConcepto',    coalesce(g.desglose, '[]'::jsonb),
    'baseDesconocida', coalesce(g.sin_subtotal, 0),
    'gastos',         coalesce(gd.por_gasto, '[]'::jsonb),
    'diferencias',    coalesce(l.diferencias, '[]'::jsonb),
    -- Compatibilidad: la suma cruda. La ruta la recalcula SIN copias a partir
    -- de `ivaRetenido`/`isrRetenido` por gasto.
    'retenciones',    coalesce(gd.retenciones, 0)
  ) order by l.created_at), '[]'::jsonb)
  from liquidacion l
  join viaje v on v.id = l.viaje_id
  left join operador o on o.id = v.operador_id
  left join lateral (
    select
      jsonb_agg(jsonb_build_object(
        'concepto', t.concepto,
        'subtotal', case when t.base_conocida then t.base else null end,
        'baseConocida', t.base_conocida
      ) order by t.concepto) as desglose,
      sum(t.sin_sub) as sin_subtotal
    from (
      select gg.concepto,
             sum(gg.sub_total) filter (where gg.sub_total is not null) as base,
             bool_and(gg.sub_total is not null) as base_conocida,
             count(*) filter (where gg.sub_total is null) as sin_sub
        from gasto gg
       where gg.tenant_id = p_tenant and gg.viaje_id = l.viaje_id
       group by gg.concepto
    ) t
  ) g on true
  left join lateral (
    select jsonb_agg(jsonb_build_object(
             'id',          gg.id,
             'concepto',    gg.concepto,
             'monto',       gg.monto,
             'fecha',       gg.fecha,
             'subtotal',    gg.sub_total,
             'descuento',   gg.descuento,
             'tieneCfdi',   gg.cfdi_uuid is not null,
             'cfdiUuid',    gg.cfdi_uuid,
             'cfdiOrden',   gg.cfdi_orden,
             'folio',       gg.folio,
             'folioNorm',   gg.folio_norm,
             'formaPago',   nullif(gg.forma_pago, ''),
             'pagadoEn',    gg.pagado_en,
             'pagadoForma', nullif(gg.pagado_forma, ''),
             'ivaRetenido', gg.iva_retenido,
             'isrRetenido', gg.isr_retenido,
             'ivaTraslado', gg.iva_traslado,
             'iepsTraslado', gg.ieps_traslado
           ) order by gg.created_at, gg.id) as por_gasto,
           sum(coalesce(gg.iva_retenido, 0) + coalesce(gg.isr_retenido, 0)) as retenciones
      from gasto gg
     where gg.tenant_id = p_tenant and gg.viaje_id = l.viaje_id
  ) gd on true
 where l.tenant_id = p_tenant
   and (l.created_at at time zone 'America/Mexico_City')::date >= p_desde
   and (l.created_at at time zone 'America/Mexico_City')::date <= p_hasta
   -- AUDITORÍA 25 (backend.md MEDIO línea 226): el MISMO criterio que ya
   -- declara `api/export/liquidaciones` (`sin_rechazadas` por omisión) y
   -- `api/v1/openapi` («solo lo asentable») — una liquidación rechazada no
   -- se asienta en la contabilidad del cliente.
   and l.revision <> 'rechazada';
$function$;
comment on function public.poliza_datos_tenant(uuid,date,date) is
  'Insumos de póliza v342: revisión humana y traslados IVA/IEPS originales por comprobante. La ruta exige firma y bloquea ajustes incompatibles con el desglose sin inventar impuestos ni exportar el periodo parcialmente. Excluye rechazadas; conserva pendientes para informar el bloqueo. SECURITY INVOKER; sólo service_role.';
commit;
