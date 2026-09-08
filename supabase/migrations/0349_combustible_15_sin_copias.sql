-- 0349 — FIS-C2 + ARQ-A3 (auditoría 28): "foto repetida no es gasto" faltaba
-- en el cubo del 15% de combustible en efectivo. `sumar_combustible_ejercicio`
-- (0345) sumaba TODAS las filas de `gasto` sin excluir copias del mismo
-- comprobante (dos fotos del mismo ticket, o el mismo CFDI leído dos veces),
-- inflando tanto el total como el "efectivo" del ejercicio.
--
-- Mismo criterio EXACTO que `copiasDeComprobante` (src/lib/likida/cuadre/
-- engine.ts:514-564), portado a SQL con `row_number() over (partition by ...)`:
--   1. Si trae `cfdi_uuid`: dedup por (uuid, cfdi_orden) — NO por el uuid solo
--      (0065: una factura consolidada de CAPUFE ampara N casetas legítimas).
--   2. Si no, y trae `folio`: dedup por (concepto sin acentos, folio_norm o
--      folio crudo, monto) — el mismo folio con o sin ceros a la izquierda es
--      el mismo ticket.
--   3. Sin ninguno de los dos: nunca se marca copia (no hay con qué comparar).
-- El desempate de "cuál es la original" es por `id` (determinista); no importa
-- CUÁL de las copias se conserva, solo que se conserve exactamente una.
--
-- FUERA DE ALCANCE A PROPÓSITO (FIS-A2, decisión de Javier, §5.11 del plan de
-- auditoría-28): el denominador sigue sumando por `fecha` (cuándo se registró
-- el gasto), no por `pagado_en` (cuándo se liquidó el pago). La RFA 2026 2.9
-- dice "el total de los PAGOS EFECTUADOS por consumo de combustible" — si eso
-- exige usar `pagado_en` en vez de `fecha` para el corte del ejercicio es una
-- interpretación fiscal con efecto real en el monto acreditable, no una
-- corrección mecánica: se deja señalada, no se adivina.
begin;

-- `unaccent` ya está disponible en producción (extensión preinstalada por
-- Supabase, verificado con pg_proc antes de escribir esta migración), pero
-- una base virgen (CI, `ci-postgres.yml`) no la trae por defecto — la
-- migración debe crearla ella misma para ser reaplicable desde cero.
-- CON schema explícito: la función de abajo fija `search_path` a
-- 'public','pg_catalog' — si la extensión cayera en `extensions` (el
-- default de Supabase para varias, ver 0154/0160/0236), `unaccent(text)`
-- no resolvería dentro de la función. Producción ya la tiene en `public`
-- (verificado con pg_proc antes de escribir esta migración); esto solo
-- lo replica para una base virgen.
create extension if not exists unaccent with schema public;

CREATE OR REPLACE FUNCTION public.sumar_combustible_ejercicio(p_tenant uuid, p_anio int, p_claves text[])
returns table (total numeric, efectivo numeric)
language sql
stable
parallel safe
set search_path = public, pg_catalog
as $$
  with candidatos as (
    select
      id, monto, forma_pago, pagado_en, pagado_forma, cfdi_uuid, cfdi_orden, folio, folio_norm, concepto
    from gasto
    where tenant_id = p_tenant
      and monto > 0
      and fecha >= make_date(p_anio, 1, 1)
      and fecha <= make_date(p_anio, 12, 31)
      and (concepto = 'diesel' or (p_claves is not null and cardinality(p_claves) > 0 and clave_prod_serv = any(p_claves)))
  ),
  marcados as (
    select
      monto, forma_pago, pagado_en, pagado_forma,
      case
        when cfdi_uuid is not null then
          row_number() over (partition by lower(cfdi_uuid), coalesce(cfdi_orden, 1) order by id)
        when folio is not null then
          row_number() over (partition by unaccent(lower(concepto)), coalesce(folio_norm, folio), monto order by id)
        else 1
      end as orden_copia
    from candidatos
  ),
  base as (
    select
      monto,
      case
        when forma_pago = '99' and pagado_en is not null then pagado_forma
        when forma_pago = '99' then null
        else forma_pago
      end as forma_pago_efectiva
    from marcados
    where orden_copia = 1
  )
  select
    coalesce(sum(monto), 0) as total,
    coalesce(sum(monto) filter (
      where forma_pago_efectiva is not null
        and forma_pago_efectiva <> '99'
        and forma_pago_efectiva not in ('02', '03', '04', '05', '28', '29')
    ), 0) as efectivo
  from base;
$$;

comment on function public.sumar_combustible_ejercicio(uuid, int, text[]) is
  '0349 (FIS-C2/ARQ-A3): excluye copias del mismo comprobante (mismo criterio que copiasDeComprobante en engine.ts) antes de sumar total/efectivo. FIS-A2 (comprado vs pagos efectuados, fecha vs pagado_en) queda pendiente, es decisión de Javier. Migración 0345 (forma efectiva del REP) intacta.';

commit;
