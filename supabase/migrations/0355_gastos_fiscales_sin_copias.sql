-- 0355 — FIS-A3 (auditoría 28): `gastos_fiscales_agregados_tenant` (0151 y
-- sucesivas) agrupa por 26 dimensiones fiscales pero NUNCA por identidad de
-- comprobante (folio/cfdi_uuid) — dos fotos del MISMO ticket, o el mismo CFDI
-- leído dos veces, caen en la MISMA celda (coinciden en las 26 dimensiones) y
-- se SUMAN: el panel del contador cuenta la copia como un comprobante real.
-- `copiasDeComprobante` (engine.ts) ya resuelve esto para el motor, y 0349 ya
-- portó el MISMO criterio a `sumar_combustible_ejercicio`. Esta migración lo
-- aplica aquí: filtra las copias ANTES de agregar, con el idéntico criterio
-- (row_number particionado por identidad, desempate por id) — ni un
-- parámetro, ni una columna de salida, ni un tipo de TS cambia. `resumirFiscal`
-- sigue recibiendo exactamente la misma forma de celda que antes; ahora sus
-- sumas ya no incluyen copias.
--
-- FUERA DE ALCANCE A PROPÓSITO: ninguna de las 26 dimensiones de agrupación
-- ni ninguna fórmula fiscal cambia. Esto no es una interpretación nueva —es
-- el MISMO criterio de "foto repetida no es gasto" que ya rige en
-- `copiasDeComprobante` y en 0349, aplicado al último lugar del repo donde
-- todavía faltaba.
begin;

CREATE OR REPLACE FUNCTION public.gastos_fiscales_agregados_tenant(p_tenant uuid, p_desde date, p_hasta date, p_tope_efectivo numeric, p_tope_alimentacion numeric, p_conceptos_alimentacion text[], p_cortes date[], p_claves_combustible text[], p_vigente_desde date, p_exigible_desde date, p_umbral_renglones_ajenos numeric, p_patron_bar text, p_hoy date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  with base_cruda as (
    select
      g.id, g.viaje_id, g.concepto, g.monto, g.fecha,
      nullif(g.rfc_emisor, '')      as rfc_emisor,
      nullif(g.cfdi_uuid, '')       as cfdi_uuid,
      g.cfdi_orden,
      nullif(g.folio, '')           as folio,
      nullif(g.folio_norm, '')      as folio_norm,
      nullif(g.estado_sat, '')      as estado_sat,
      g.efos, g.efos_revisar,
      nullif(g.forma_pago, '')      as forma_pago,
      (g.pagado_en is not null)     as pagado,
      nullif(g.pagado_forma, '')    as pagado_forma,
      g.sub_total, g.iva_traslado, g.ieps_traslado,
      nullif(g.clave_prod_serv, '') as clave_prod_serv,
      (nullif(g.cfdi_uuid, '') is not null) as tiene_cfdi,
      coalesce(g.fecha::text, 'sin-fecha:' || g.id::text) as dia,
      (g.monto > p_tope_efectivo) as sobre_tope,
      case when g.iva_traslado is null then 'nulo'
           when g.iva_traslado > 0 then 'positivo'
           else 'no_positivo' end as iva_estado,
      g.ocr_extra,
      (l.id is not null) as liquidacion_firmada,
      nullif(g.rfc_receptor, '') as rfc_receptor,
      (nullif(g.ocr_extra->>'moneda', '') is not null and g.ocr_extra->>'moneda' <> 'MXN') as moneda_extranjera,
      (
        g.monto > 0
        and coalesce((
          select sum((r->>'importe')::numeric)
          from jsonb_array_elements(
            case when jsonb_typeof(g.ocr_extra->'renglones') = 'array'
                 then g.ocr_extra->'renglones' else '[]'::jsonb end
          ) r
          where (r->>'ajenoAlViaje') = 'true'
            and (r->>'importe') ~ '^-?[0-9]+(\.[0-9]+)?$'
        ), 0) > 0
        and coalesce((
          select sum((r->>'importe')::numeric)
          from jsonb_array_elements(
            case when jsonb_typeof(g.ocr_extra->'renglones') = 'array'
                 then g.ocr_extra->'renglones' else '[]'::jsonb end
          ) r
          where (r->>'ajenoAlViaje') = 'true'
            and (r->>'importe') ~ '^-?[0-9]+(\.[0-9]+)?$'
        ), 0) / g.monto >= p_umbral_renglones_ajenos
      ) as renglones_ajenos,
      (
        g.concepto = 'alimentacion' and p_patron_bar is not null and (
          coalesce(g.ocr_extra->>'emisor', '') ~* p_patron_bar
          or coalesce(g.ocr_extra->>'producto', '') ~* p_patron_bar
        )
      ) as consumo_bar,
      (
        (g.concepto = 'diesel' or g.clave_prod_serv = any (coalesce(p_claves_combustible, '{}'::text[])))
        and g.tipo_comprobante in ('I', 'E')
        and (g.fecha is null or p_vigente_desde is null or g.fecha >= p_vigente_desde)
        and not coalesce(g.cfdi_esquema_alterno, false)
        and not coalesce(g.complemento_hidrocarburos, false)
        and g.xml_verificado is true
        and p_exigible_desde is not null
        and (g.fecha is null or g.fecha >= p_exigible_desde)
      ) as complemento_hidrocarburos_falta,
      (
        g.fecha is not null and p_hoy is not null
        and extract(year from g.fecha)::int < extract(year from p_hoy)::int
              - (case when extract(month from p_hoy)::int = 1 then 1 else 0 end)
      ) as otro_ejercicio
    from gasto g
    left join liquidacion l on l.viaje_id = g.viaje_id and l.revision in ('aprobada', 'ajustada')
    where g.tenant_id = p_tenant
      and (p_desde is null or g.fecha >= p_desde)
      and (p_hasta is null or g.fecha <= p_hasta)
  ),
  -- FIS-A3 (0355): mismo criterio que copiasDeComprobante (engine.ts) y
  -- sumar_combustible_ejercicio (0349) — dedup por (cfdi_uuid, cfdi_orden) si
  -- hay CFDI, si no por (concepto sin acentos, folio_norm/folio, monto); sin
  -- ninguno de los dos, nunca es copia. Desempate por id, determinista.
  marcadas as (
    select bc.*,
      case
        when bc.cfdi_uuid is not null then
          row_number() over (partition by lower(bc.cfdi_uuid), coalesce(bc.cfdi_orden, 1) order by bc.id)
        when bc.folio is not null then
          row_number() over (partition by unaccent(lower(bc.concepto)), coalesce(bc.folio_norm, bc.folio), bc.monto order by bc.id)
        else 1
      end as orden_copia
    from base_cruda bc
  ),
  base as (
    select id, viaje_id, concepto, monto, fecha, rfc_emisor, cfdi_uuid, estado_sat,
      efos, efos_revisar, forma_pago, pagado, pagado_forma, sub_total, iva_traslado,
      ieps_traslado, clave_prod_serv, tiene_cfdi, dia, sobre_tope, iva_estado,
      ocr_extra, liquidacion_firmada, rfc_receptor, moneda_extranjera,
      renglones_ajenos, consumo_bar, complemento_hidrocarburos_falta, otro_ejercicio
    from marcadas
    where orden_copia = 1
  ),
  dias as (
    select viaje_id, dia, sum(monto) filter (where tiene_cfdi) as total_timbrado
    from base
    where p_tope_alimentacion is not null
      and concepto = any (coalesce(p_conceptos_alimentacion, '{}'::text[]))
      and monto > 0
    group by viaje_id, dia
    having sum(monto) filter (where tiene_cfdi) > p_tope_alimentacion
  ),
  filas as (
    select
      b.*,
      case when not b.tiene_cfdi and b.fecha is not null
           then (select count(*) from unnest(coalesce(p_cortes, '{}'::date[])) c where b.fecha < c)
      end as banda,
      case when not b.tiene_cfdi then b.rfc_emisor end as rfc_sin_cfdi,
      case when not b.tiene_cfdi
           then substring(lower(b.ocr_extra->>'urlFacturacion') from '^(?:[a-z][a-z0-9+.-]*://)?([^/?#]+)')
      end as host,
      case when not b.tiene_cfdi then nullif(upper(trim(b.ocr_extra->>'emisor')), '') end as emisor,
      d.viaje_id      as dia_viaje,
      d.dia           as dia_dia,
      d.total_timbrado as total_timbrado_dia
    from base b
    left join dias d
      on d.viaje_id = b.viaje_id and d.dia = b.dia
     and b.tiene_cfdi and b.monto > 0
     and b.concepto = any (coalesce(p_conceptos_alimentacion, '{}'::text[]))
  ),
  celdas as (
    select
      concepto, clave_prod_serv, forma_pago, pagado, pagado_forma, efos, efos_revisar, estado_sat, tiene_cfdi,
      (fecha is null) as sin_fecha, iva_estado, sobre_tope,
      banda, rfc_sin_cfdi, host, emisor,
      dia_viaje, dia_dia, total_timbrado_dia, liquidacion_firmada,
      rfc_receptor, moneda_extranjera, renglones_ajenos, consumo_bar,
      complemento_hidrocarburos_falta, otro_ejercicio,
      count(*)                                        as n,
      sum(monto)                                      as monto,
      coalesce(sum(iva_traslado), 0)                  as iva,
      coalesce(sum(ieps_traslado), 0)                 as ieps,
      count(*) filter (where ieps_traslado is null)   as ieps_nulos,
      coalesce(sum(sub_total), 0)                     as sub_total,
      count(*) filter (where sub_total is null)       as sub_total_nulos,
      min(id::text)                                   as muestra_id,
      min(cfdi_uuid)                                  as muestra_cfdi,
      max(fecha)                                      as fecha_max
    from filas
    group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'concepto', concepto,
    'claveProdServ', clave_prod_serv,
    'formaPago', forma_pago,
    'pagado', pagado,
    'pagadoForma', pagado_forma,
    'efos', efos,
    'efosRevisar', efos_revisar,
    'estadoSat', estado_sat,
    'tieneCfdi', tiene_cfdi,
    'sinFecha', sin_fecha,
    'ivaEstado', iva_estado,
    'sobreTopeEfectivo', sobre_tope,
    'banda', banda,
    'rfcEmisor', rfc_sin_cfdi,
    'host', host,
    'emisor', emisor,
    'totalTimbradoDia', total_timbrado_dia,
    'liquidacionFirmada', liquidacion_firmada,
    'rfcReceptor', rfc_receptor,
    'monedaExtranjera', moneda_extranjera,
    'renglonesAjenos', renglones_ajenos,
    'consumoBar', consumo_bar,
    'complementoHidrocarburosFalta', complemento_hidrocarburos_falta,
    'otroEjercicio', otro_ejercicio,
    'n', n,
    'monto', monto,
    'iva', iva,
    'ieps', ieps,
    'iepsNulos', ieps_nulos,
    'subTotal', sub_total,
    'subTotalNulos', sub_total_nulos,
    'muestraId', muestra_id,
    'muestraCfdi', muestra_cfdi,
    'fechaMax', to_char(fecha_max, 'YYYY-MM-DD')
  ) order by concepto, n desc, muestra_id), '[]'::jsonb)
  from celdas;
$function$;

comment on function public.gastos_fiscales_agregados_tenant(uuid, date, date, numeric, numeric, text[], date[], text[], date, date, numeric, text, date) is
  'FIS-A3 (0355, auditoría 28): filtra copias del mismo comprobante (mismo criterio que copiasDeComprobante en engine.ts y sumar_combustible_ejercicio en 0349) ANTES de agregar por celda — misma forma de salida, sin cambio de firma. Historial: 0151 (creación), 0192/0282/0305/0308/0316/0317 (dimensiones y filtros agregados, ninguno tocaba identidad de comprobante).';

revoke all on function public.gastos_fiscales_agregados_tenant(uuid, date, date, numeric, numeric, text[], date[], text[], date, date, numeric, text, date) from public, anon, authenticated;
grant execute on function public.gastos_fiscales_agregados_tenant(uuid, date, date, numeric, numeric, text[], date[], text[], date, date, numeric, text, date) to service_role;

commit;
