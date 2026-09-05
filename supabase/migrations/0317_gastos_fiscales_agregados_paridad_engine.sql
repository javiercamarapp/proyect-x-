-- ═══════════════════════════════════════════════════════════════════════════
-- RE-AUDITORÍA 25, FIS-REAUD-2 (CRÍTICO). `ivaSostenible` (fiscal.ts) — la
-- función que decide si el panel del contador acredita el IVA de un
-- comprobante — le faltaban 7 de las causas que `cuadrarViaje` (engine.ts, la
-- fuente real del PDF) SÍ excluye de `SIN_IVA_ACREDITABLE`:
--
--   rfc_receptor, rfc_receptor_no_verificable, moneda_extranjera,
--   renglones_ajenos, consumo_bar, complemento_hidrocarburos,
--   gasto_otro_ejercicio.
--
-- La causa raíz es estructural: `gastos_fiscales_agregados_tenant` (0151) no
-- seleccionaba los campos que esas reglas necesitan. Esta migración los
-- agrega como NUEVAS DIMENSIONES del `group by` — SQL sigue sin juzgar nada,
-- solo aplica fila por fila una fórmula cuyos parámetros manda TS (mismo
-- patrón que `p_tope_efectivo` desde la 0151):
--
--   · `rfcReceptor` — columna directa (`gasto.rfc_receptor`).
--   · `monedaExtranjera` — `ocr_extra.moneda` presente y ≠ 'MXN' (DAT-19).
--   · `renglonesAjenos` — la suma de `ocr_extra.renglones[].importe` con
--     `ajenoAlViaje=true` alcanza `p_umbral_renglones_ajenos` (0.15,
--     `UMBRAL_RENGLONES_AJENOS` de engine.ts) del monto del ticket.
--   · `consumoBar` — alimentación cuyo `ocr_extra.emisor`/`producto` hace
--     match con `p_patron_bar` (el `.source` de `SENAL_BAR`, engine.ts).
--   · `complementoHidrocarburosFalta` — el veredicto DURO de engine.ts
--     (NIVEL 2: XML verificado, sin el nodo, con fecha de exigibilidad
--     RESPALDADA por ficha — `p_exigible_desde`, hoy `null` en `NORMAS`, así
--     que esto es siempre `false` mientras nadie confirme esa fecha).
--   · `otroEjercicio` — mismo criterio que `fechaDudosa` → 'otro_ejercicio'
--     (con la tolerancia de enero), contra `p_hoy`.
--
-- FALLA CERRADO, NUNCA AL REVÉS: `rfc_receptor`/`rfc_receptor_no_verificable`
-- son la única de las 7 que `ivaSostenible` no puede replicar exacto (la
-- excepción RLISR 57 del viático a nombre del operador exige el RFC del
-- OPERADOR DEL VIAJE, que esta vista agregada por celda no conserva) — ahí
-- `fiscal.ts` decide NO acreditar en vez de asumir la excepción. Las otras
-- 6 sí se replican al centavo.
--
-- Como la firma gana parámetros, `create or replace` NO basta (Postgres
-- distingue funciones por nombre+tipos: dejaría DOS funciones, la vieja de 7
-- parámetros huérfana). Se DROPEA la vieja primero.
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists public.gastos_fiscales_agregados_tenant(uuid, date, date, numeric, numeric, text[], date[]);

create or replace function public.gastos_fiscales_agregados_tenant(
  p_tenant uuid,
  p_desde date,
  p_hasta date,
  p_tope_efectivo numeric,
  p_tope_alimentacion numeric,
  p_conceptos_alimentacion text[],
  p_cortes date[],
  p_claves_combustible text[],
  p_vigente_desde date,
  p_exigible_desde date,
  p_umbral_renglones_ajenos numeric,
  p_patron_bar text,
  p_hoy date
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
      -- AUDITORÍA 24, FIS-7 (mig. 0282): el sello del complemento de pago.
      -- Solo lo escribe intake/rep.ts cuando un REP liquidó el CFDI entero.
      -- RE-AUDITORÍA 25: restaurado — el `drop`+`create` de esta migración
      -- partió de una copia anterior a la 0282 y se lo había llevado, lo que
      -- dejaba `formaPagoEfectiva` (fiscal.ts) siempre en null.
      (g.pagado_en is not null)     as pagado,
      nullif(g.pagado_forma, '')    as pagado_forma,
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
      -- LEFT a propósito (ver mig. 0316): la fila sigue contando para
      -- gastoTotal/perdidas; solo `ivaSostenible` (fiscal.ts) la usa.
      (l.id is not null) as liquidacion_firmada,
      -- RE-AUDITORÍA 25, FIS-REAUD-2 ─────────────────────────────────────
      nullif(g.rfc_receptor, '') as rfc_receptor,
      (nullif(g.ocr_extra->>'moneda', '') is not null and g.ocr_extra->>'moneda' <> 'MXN') as moneda_extranjera,
      -- La suma de las partidas AJENAS al viaje ('ajenoAlViaje': true, con
      -- 'importe' numérico) frente al monto del ticket — MISMO umbral y
      -- MISMA condición (`g.monto > 0`) que `engine.ts`. `jsonb_typeof` evita
      -- que un `renglones` que no sea arreglo tumbe la función.
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
      -- `pareceBar` (engine.ts): SOLO alimentación, emisor o producto leído
      -- hace match con el patrón de `SENAL_BAR`.
      (
        g.concepto = 'alimentacion' and p_patron_bar is not null and (
          coalesce(g.ocr_extra->>'emisor', '') ~* p_patron_bar
          or coalesce(g.ocr_extra->>'producto', '') ~* p_patron_bar
        )
      ) as consumo_bar,
      -- Veredicto DURO de `complemento_hidrocarburos` (NIVEL 2 de engine.ts):
      -- combustible (por concepto o clave), CFDI de ingreso/egreso, XML
      -- verificado, sin el nodo del complemento, esquema NO alterno, la
      -- fecha ya "mira" el complemento (vigente_desde) y — el interruptor
      -- real — una fecha de EXIGIBILIDAD respaldada por ficha.
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
      -- `fechaDudosa` → 'otro_ejercicio': el ejercicio del comprobante va por
      -- debajo del de `p_hoy` (con la tolerancia de un año extra en enero).
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
      -- AUDITORÍA 19 (REND-19c2-2): normalizado con upper/trim. RE-AUDITORÍA
      -- 25: restaurado — la copia de la que salió esta migración era anterior
      -- a esa normalización (ver la nota de `pagado` arriba).
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
$$;

comment on function public.gastos_fiscales_agregados_tenant(uuid, date, date, numeric, numeric, text[], date[], text[], date, date, numeric, text, date) is
  'Comprobantes de UNA flota en un periodo (fecha del comprobante; nulos = sin cota) AGREGADOS por las dimensiones fiscales que fiscal.ts consulta por fila: concepto, clave, forma de pago, pagado/pagadoForma (el sello del complemento de pago, AUDITORÍA 24 FIS-7 mig. 0282 — restaurado en la RE-AUDITORÍA 25 tras perderse en el drop+create de esta misma migración), estado SAT, EFOS, con/sin CFDI, con/sin desglose de IVA, monto > p_tope_efectivo, banda de fecha (sin CFDI) vs p_cortes + RFC/host/emisor (emisor normalizado upper/trim, AUDITORÍA 19 REND-19c2-2, también restaurado), alimentación timbrada sobre p_tope_alimentacion (viaje+día y su total), liquidación FIRMADA del viaje (RE-AUDITORÍA 25 FIS-REAUD-1, mig. 0316), y las 7 causas de FIS-REAUD-2 (mig. 0317) que completan la paridad con SIN_IVA_ACREDITABLE de engine.ts: rfcReceptor, monedaExtranjera, renglonesAjenos (>= p_umbral_renglones_ajenos), consumoBar (match con p_patron_bar), complementoHidrocarburosFalta (veredicto duro solo con p_exigible_desde no nulo) y otroEjercicio (contra p_hoy). NO evalúa deducibilidad: la ley sigue en resumirFiscal/resumirPerdidas (TS), que pesan cada celda por n. SECURITY INVOKER; p_tenant sin default.';

revoke all on function public.gastos_fiscales_agregados_tenant(uuid, date, date, numeric, numeric, text[], date[], text[], date, date, numeric, text, date) from public, anon, authenticated;
grant execute on function public.gastos_fiscales_agregados_tenant(uuid, date, date, numeric, numeric, text[], date[], text[], date, date, numeric, text, date) to service_role;
