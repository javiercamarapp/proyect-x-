-- ═══════════════════════════════════════════════════════════════════════════
-- RE-AUDITORÍA 25, FIS-REAUD-1 (CRÍTICO). MISMO hallazgo que la 0308, otra
-- puerta: `gastos_fiscales_agregados_tenant` (0151) — la RPC de la que salen
-- la tarjeta "IVA acreditable documentado" del panel del contador Y la
-- herramienta MCP `resumen_fiscal` (`getGastosFiscales` → `resumirFiscal`) —
-- suma el IVA de TODOS los comprobantes del tenant en el periodo como si su
-- liquidación ya sostuviera el acreditamiento, sin mirar en qué liquidación
-- cayó cada uno. Eso incluye:
--   · gastos de viajes SIN liquidación todavía (en_cuadre/abierto);
--   · gastos de una liquidación PENDIENTE de firma;
--   · gastos de una liquidación RECHAZADA con motivo.
--
-- La 0308 ya resolvió el MISMO hecho para `acreditables_liquidacion_tenant`
-- (que suma columnas de `liquidacion`, no de `gasto`): "solo liquidaciones
-- FIRMADAS (revision aprobada|ajustada) — una rechazada o pendiente no
-- sostiene todavía el requisito de deducibilidad de LIVA 5-I".
--
-- ALCANCE DEL ARREGLO — por qué NO se filtra la fila entera. Esta misma RPC
-- también alimenta `resumirPerdidas` (la tarjeta de "pérdidas de
-- deducibilidad": perdido / en riesgo / RECUPERABLE) en la MISMA llamada de
-- `resumen_fiscal` y del panel. `sin_cfdi` ahí dice literalmente "el ticket
-- TODAVÍA se puede timbrar. Es deducción PENDIENTE, no perdida" — esa
-- tarjeta existe justo para pescar un comprobante que falta ANTES de que el
-- viaje se liquide. Si esta RPC dejara fuera todo gasto sin liquidación
-- firmada, "pérdidas" se quedaría en cero para cualquier tenant con viajes
-- abiertos — la regresión sería peor que el hallazgo que arregla.
--
-- Por eso el join es LEFT, no INNER: cada celda se sigue viendo (gastoTotal,
-- conCfdi, perdidas — sin cambio), pero ahora trae consigo si su viaje tiene
-- una liquidación FIRMADA (`liquidacionFirmada`). `resumirFiscal` (fiscal.ts)
-- usa esa bandera SOLO para la puerta de `ivaSostenible` — el criterio de
-- LIVA 5 que decide "IVA acreditable documentado" — que es la cifra que el
-- hallazgo señala como el daño CRÍTICO (dinero acreditado de más). El resto
-- de la función no cambia.
--
-- `l.id is not null` como bandera homogénea por celda: la restricción de la
-- 0299/0300 (`gasto_no_tras_liquidar`) garantiza que un viaje tiene A LO SUMO
-- una liquidación NO rechazada a la vez, así que el LEFT JOIN nunca duplica
-- un gasto entre dos liquidaciones vivas ni infla `n`.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.gastos_fiscales_agregados_tenant(
  p_tenant uuid,
  p_desde date,
  p_hasta date,
  p_tope_efectivo numeric,
  p_tope_alimentacion numeric,
  p_conceptos_alimentacion text[],
  p_cortes date[]
)
returns jsonb
language sql
stable
parallel safe
set search_path = public, pg_catalog
as $$
  with base as (
    select
      g.id, g.viaje_id, g.concepto, g.monto, g.fecha,
      nullif(g.rfc_emisor, '')      as rfc_emisor,
      nullif(g.cfdi_uuid, '')       as cfdi_uuid,
      nullif(g.estado_sat, '')      as estado_sat,
      g.efos, g.efos_revisar,
      nullif(g.forma_pago, '')      as forma_pago,
      g.sub_total, g.iva_traslado, g.ieps_traslado,
      nullif(g.clave_prod_serv, '') as clave_prod_serv,
      (nullif(g.cfdi_uuid, '') is not null) as tiene_cfdi,
      -- El mismo criterio de día que `diasSobreTope`: sin fecha, cada
      -- comprobante es su propio día (no se inventa una fecha para sumar).
      coalesce(g.fecha::text, 'sin-fecha:' || g.id::text) as dia,
      (g.monto > p_tope_efectivo) as sobre_tope,
      case when g.iva_traslado is null then 'nulo'
           when g.iva_traslado > 0 then 'positivo'
           else 'no_positivo' end as iva_estado,
      g.ocr_extra,
      -- RE-AUDITORÍA 25, FIS-REAUD-1: ¿el viaje de este gasto tiene YA una
      -- liquidación firmada (aprobada|ajustada)? Mismo criterio que la 0308.
      -- LEFT a propósito (ver cabecera): la fila sigue contando para
      -- gastoTotal/perdidas; solo `ivaSostenible` (fiscal.ts) la usa.
      (l.id is not null) as liquidacion_firmada
    from gasto g
    left join liquidacion l on l.viaje_id = g.viaje_id and l.revision in ('aprobada', 'ajustada')
    where g.tenant_id = p_tenant
      and (p_desde is null or g.fecha >= p_desde)
      and (p_hasta is null or g.fecha <= p_hasta)
  ),
  dias as (
    -- Los (viaje, día) de alimentación cuyo total TIMBRADO rebasa el tope.
    -- `monto > 0` y los conceptos vienen del mismo criterio del motor
    -- (`diasSobreTope`): los manda el llamador, no se repiten aquí.
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
      -- El HOST de la liga de facturación: los dominios del catálogo de
      -- comercios describen hosts, y la liga completa suele traer el folio
      -- del ticket (una por comprobante — agrupar por ella no agruparía).
      case when not b.tiene_cfdi
           then substring(lower(b.ocr_extra->>'urlFacturacion') from '^(?:[a-z][a-z0-9+.-]*://)?([^/?#]+)')
      end as host,
      case when not b.tiene_cfdi then nullif(b.ocr_extra->>'emisor', '') end as emisor,
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
      concepto, clave_prod_serv, forma_pago, efos, efos_revisar, estado_sat, tiene_cfdi,
      (fecha is null) as sin_fecha, iva_estado, sobre_tope,
      banda, rfc_sin_cfdi, host, emisor,
      dia_viaje, dia_dia, total_timbrado_dia, liquidacion_firmada,
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
    group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'concepto', concepto,
    'claveProdServ', clave_prod_serv,
    'formaPago', forma_pago,
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
$$;

comment on function public.gastos_fiscales_agregados_tenant(uuid, date, date, numeric, numeric, text[], date[]) is
  'Comprobantes de UNA flota en un periodo (fecha del comprobante; nulos = sin cota) AGREGADOS por las dimensiones fiscales que fiscal.ts consulta por fila (concepto, clave, forma de pago, estado SAT, EFOS, con/sin CFDI, con/sin desglose de IVA, monto > p_tope_efectivo, y para los sin CFDI la banda de fecha vs p_cortes + RFC/host/emisor; para alimentación timbrada sobre p_tope_alimentacion, el (viaje, día) y su total; y si el viaje tiene liquidación FIRMADA — aprobada|ajustada, RE-AUDITORÍA 25 FIS-REAUD-1 — que fiscal.ts usa SOLO para la puerta de ivaSostenible, no para excluir la fila de gastoTotal/perdidas). NO evalúa deducibilidad: la ley sigue en resumirFiscal/resumirPerdidas (TS), que pesan cada celda por n. Reemplaza el traerTodo del ejercicio + traerPorIds de viajes de getGastosFiscales (mig. 0151, escala 50k). SECURITY INVOKER; p_tenant sin default.';

revoke all on function public.gastos_fiscales_agregados_tenant(uuid, date, date, numeric, numeric, text[], date[]) from public, anon, authenticated;
grant execute on function public.gastos_fiscales_agregados_tenant(uuid, date, date, numeric, numeric, text[], date[]) to service_role;
