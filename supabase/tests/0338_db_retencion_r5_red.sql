-- 0338 · El timestamp de ingesta se evalúa al ejecutar INSERT, no al abrir una
-- transacción que podría cruzar el cambio de mes mientras espera un lock.
-- Uso exclusivo en PostgreSQL local/staging desechable.
\set ON_ERROR_STOP on
begin;

insert into public.tenant(id,nombre)
values ('33800000-0000-4000-8000-000000000002','Reloj producto R5');

do $reloj$
declare creado timestamptz; edad interval;
begin
  perform pg_sleep(0.25);
  insert into public.producto_evento(tenant_id,pantalla,accion)
  values ('33800000-0000-4000-8000-000000000002','viajes','pageview')
  returning created_at into creado;
  edad:=clock_timestamp()-creado;
  if edad>interval '100 milliseconds' then
    raise exception '0338 created_at conserva timestamp de transacción y puede caer en el mes anterior: edad=%',edad;
  end if;
end
$reloj$;

-- El escritor real no debe poder saltarse el gate aunque la función del trigger
-- no sea ejecutable directamente por roles de cliente.
set local role service_role;
do $service_role$
declare creado timestamptz;
begin
  insert into public.producto_evento(tenant_id,pantalla,accion)
  values ('33800000-0000-4000-8000-000000000002','viajes','pageview')
  returning created_at into creado;
  if clock_timestamp()-creado>interval '100 milliseconds' then
    raise exception '0338 service_role no recibió timestamp de sentencia: %',creado;
  end if;
end
$service_role$;
reset role;

do $gate$
declare configuracion text[]; expresion text;
begin
  select p.proconfig into configuracion
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='gate_producto_evento_insert_r5';
  if configuracion is distinct from array['search_path=pg_catalog'] then
    raise exception '0338 gate sin search_path cerrado: %',configuracion;
  end if;
  if has_function_privilege('anon','public.gate_producto_evento_insert_r5()','execute')
     or has_function_privilege('authenticated','public.gate_producto_evento_insert_r5()','execute') then
    raise exception '0338 gate ejecutable por rol de cliente';
  end if;
  select pg_get_expr(d.adbin,d.adrelid) into expresion
    from pg_attrdef d join pg_attribute a
      on a.attrelid=d.adrelid and a.attnum=d.adnum
   where d.adrelid='public.producto_evento'::regclass and a.attname='created_at';
  if expresion !~ '^clock_timestamp\(\)$' then
    raise exception '0338 default created_at no usa reloj de sentencia: %',expresion;
  end if;
end
$gate$;

rollback;
\echo '0338_db_retencion_r5: PASS (created_at usa reloj de sentencia)'
