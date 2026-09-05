-- Prueba focal de 0326. El probe de arranque debe poder correr en una
-- transacción READ ONLY: inspecciona catálogos, nunca ejecuta las RPC auditadas.

begin;
set transaction read only;

do $$
declare
  v_faltantes text[];
  v_definer boolean;
  v_config text[];
begin
  v_faltantes := public.garantias_arranque_faltantes();
  if cardinality(v_faltantes) <> 0 then
    raise exception 'esquema completo reportado como incompleto: %', v_faltantes;
  end if;

  select p.prosecdef, p.proconfig
    into v_definer, v_config
    from pg_catalog.pg_proc p
   where p.oid = 'public.garantias_arranque_faltantes()'::pg_catalog.regprocedure;

  if not v_definer then raise exception 'el lector 0326 no es SECURITY DEFINER'; end if;
  if v_config is distinct from array['search_path=""']::text[] then
    raise exception 'search_path inseguro: %', v_config;
  end if;
  if pg_catalog.has_function_privilege('anon', 'public.garantias_arranque_faltantes()', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'public.garantias_arranque_faltantes()', 'EXECUTE') then
    raise exception 'anon/authenticated pueden ejecutar el lector privilegiado';
  end if;
  if not pg_catalog.has_function_privilege('service_role', 'public.garantias_arranque_faltantes()', 'EXECUTE') then
    raise exception 'service_role no puede ejecutar el lector 0326';
  end if;
end;
$$;

rollback;

-- Una sobrecarga inesperada debe invalidar la garantía aun si la firma buena
-- sigue viva. Todo se revierte.
begin;

create function public.try_lock_viaje(p_viaje text)
returns boolean language sql immutable set search_path = '' as 'select false';

do $$
declare v_faltantes text[];
begin
  v_faltantes := public.garantias_arranque_faltantes();
  if not ('0005:try_lock_viaje' = any(v_faltantes)) then
    raise exception 'no detectó overload inesperado de try_lock_viaje: %', v_faltantes;
  end if;
end;
$$;

rollback;

-- El CHECK se inspecciona en pg_constraint/pg_get_expr; no se inserta ningún
-- tenant de prueba. Una definición que rechaza 624 debe quedar reportada.
begin;

alter table public.tenant drop constraint tenant_regimen_fiscal_dominio;
alter table public.tenant add constraint tenant_regimen_fiscal_dominio
  check (regimen_fiscal is null or regimen_fiscal <> '624') not valid;

do $$
declare v_faltantes text[];
begin
  v_faltantes := public.garantias_arranque_faltantes();
  if not ('0172:tenant_regimen_fiscal_dominio:624' = any(v_faltantes)) then
    raise exception 'no detectó CHECK que rechaza 624: %', v_faltantes;
  end if;
end;
$$;

rollback;
