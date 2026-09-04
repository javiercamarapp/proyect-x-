-- 0326 — Probes de arranque puramente catalogales.
--
-- Antes, verificar que una RPC existía significaba ejecutarla con UUID falsos:
-- se tomaban leases, se actualizaban contadores y se intentaban cierres. El
-- CHECK 624 incluso insertaba/borraba un tenant por arranque. Este lector solo
-- consulta pg_proc/pg_constraint; no invoca ninguna función auditada.

create or replace function public.garantias_arranque_faltantes()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  with esperadas(clave, nombre, firma, argumentos, defaults, retorno) as (
    values
      ('0005:try_lock_viaje',
       'try_lock_viaje',
       'public.try_lock_viaje(uuid,integer,uuid)',
       array['p_viaje','p_ttl_ms','p_token']::text[], 1, 'boolean'),
      ('0280:unlock_viaje',
       'unlock_viaje',
       'public.unlock_viaje(uuid,uuid)',
       array['p_viaje','p_token']::text[], 1, 'void'),
      ('0011:intake_delta',
       'intake_delta',
       'public.intake_delta(uuid,integer)',
       array['p_viaje','p_delta']::text[], 0, 'integer'),
      ('0017:enriquecer_gasto_codigo',
       'enriquecer_gasto_codigo',
       'public.enriquecer_gasto_codigo(uuid,uuid,jsonb,text)',
       array['p_gasto','p_tenant','p_extra','p_cfdi_uuid']::text[], 1, 'boolean'),
      ('0033:confirmar_aviso_privacidad',
       'confirmar_aviso_privacidad',
       'public.confirmar_aviso_privacidad(uuid,uuid,text)',
       array['p_operador','p_tenant','p_version']::text[], 0, 'boolean'),
      ('0033:liberar_aviso_privacidad',
       'liberar_aviso_privacidad',
       'public.liberar_aviso_privacidad(uuid,uuid)',
       array['p_operador','p_tenant']::text[], 0, 'boolean'),
      ('0022:guardar_liquidacion_tx',
       'guardar_liquidacion_tx',
       'public.guardar_liquidacion_tx(uuid,uuid,numeric,numeric,numeric,text,jsonb,numeric,numeric,numeric,text,numeric,integer,text,integer)',
       array[
         'p_tenant','p_viaje','p_total_comprobado','p_total_anticipo',
         'p_diferencia','p_estatus','p_diferencias','p_ieps','p_iva',
         'p_peaje','p_pdf_url','p_litros_diesel','p_n_gastos',
         'p_insumos_hash','p_insumos_hash_version'
       ]::text[], 4, 'uuid')
  ),
  funciones_faltantes as (
    select e.clave
      from esperadas e
     where (
       select pg_catalog.count(*)
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = e.nombre
     ) <> 1
        or not exists (
          select 1
            from pg_catalog.pg_proc p
            join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname = e.nombre
             and p.oid = pg_catalog.to_regprocedure(e.firma)
             and p.prokind = 'f'
             and p.prorettype = pg_catalog.to_regtype(e.retorno)
             and p.proargnames::text = e.argumentos::text
             and p.pronargdefaults = e.defaults
             and p.proargmodes is null
             and p.proallargtypes is null
             and p.provariadic = 0
        )
  ),
  check_624_faltante as (
    select '0172:tenant_regimen_fiscal_dominio:624'::text as clave
     where not exists (
       select 1
         from pg_catalog.pg_constraint c
         join pg_catalog.pg_class t on t.oid = c.conrelid
         join pg_catalog.pg_namespace n on n.oid = t.relnamespace
        cross join lateral (
          select pg_catalog.pg_get_expr(c.conbin, c.conrelid, true) as expresion
        ) d
        where n.nspname = 'public'
          and t.relname = 'tenant'
          and c.conname = 'tenant_regimen_fiscal_dominio'
          and c.contype = 'c'
          and c.convalidated
          -- pg_get_expr cambia paréntesis/espacios entre versiones. Se exigen
          -- las piezas semánticas positivas y se rechaza la negación explícita,
          -- sin comparar una serialización pretty-print completa.
          and d.expresion ~* $re$regimen_fiscal[[:space:]]+IS[[:space:]]+NULL$re$
          and d.expresion ~* $re$regimen_fiscal[[:space:]]*=[[:space:]]*ANY[[:space:]]*\($re$
          and d.expresion ~ $re$'624'::text$re$
          and d.expresion !~* $re$regimen_fiscal[[:space:]]*(<>|!=)[[:space:]]*'624'::text$re$
     )
  ),
  faltantes as (
    select clave from funciones_faltantes
    union all
    select clave from check_624_faltante
  )
  select coalesce(
    pg_catalog.array_agg(clave order by clave),
    array[]::text[]
  )
  from faltantes;
$$;

revoke all on function public.garantias_arranque_faltantes()
  from public, anon, authenticated;
grant execute on function public.garantias_arranque_faltantes()
  to service_role;

comment on function public.garantias_arranque_faltantes() is
  '0326: lector SECURITY DEFINER, solo service_role. Verifica en catálogos firmas exactas/sobrecargas de RPC críticas y que el CHECK fiscal validado admita 624; no ejecuta negocio ni muta datos.';
