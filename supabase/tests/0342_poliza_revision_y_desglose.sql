-- Datos sintéticos; revisión real por RPC y rollback completo. Sin proveedores.
\set ON_ERROR_STOP on
begin;
create temporary table poliza342_fixture(tenant_id uuid, filas jsonb);
do $fixture$
declare
 t uuid; otro uuid; actor uuid := gen_random_uuid(); op uuid; v uuid; g uuid; l uuid;
 caso record; datos jsonb; fila jsonb; revisada jsonb; numero integer := 0;
begin
 insert into public.tenant(nombre) values ('SINTETICO POLIZA342') returning id into t;
 insert into public.tenant(nombre) values ('SINTETICO POLIZA342 AISLADO') returning id into otro;
 insert into public.app_user(id,tenant_id,email,rol) values (actor,t,'poliza342@example.invalid','flota_admin');
 for caso in select * from (values
   ('PENDIENTE',3480::numeric,null::numeric,'pendiente'),
   ('APROBADA',3480,null,'aprobar'),
   ('RECHAZADA',3480,null,'rechazar'),
   ('AJUSTE-SUBE-INCOMPATIBLE',3480,5480,'ajustar'),
   ('AJUSTE-BAJA-INCOMPATIBLE',3480,1480,'ajustar'),
   ('AJUSTE-SUBE-COHERENTE',2000,3480,'ajustar'),
   ('AJUSTE-BAJA-COHERENTE',4000,3480,'ajustar')
 ) as casos(folio,inicial,final,accion)
 loop
   numero := numero + 1;
   insert into public.operador(tenant_id,nombre,telefono) values
     (t,'Operador sintético '||caso.folio,'52999993420'||numero::text) returning id into op;
   insert into public.viaje(tenant_id,operador_id,folio,anticipo) values (t,op,caso.folio,5000) returning id into v;
   insert into public.gasto(tenant_id,viaje_id,concepto,monto,sub_total,iva_traslado,ieps_traslado,cfdi_uuid,forma_pago)
     values (t,v,'diesel',caso.inicial,3000,480,0,gen_random_uuid()::text,'03') returning id into g;
   l := public.guardar_liquidacion_tx(t,v,caso.inicial,5000,5000-caso.inicial,'con_diferencias','[]',0,480,0,null,0);
   if caso.accion='ajustar' then
     revisada := public.revisar_liquidacion(t,l,'ajustar','Corrección sintética de captura',
       jsonb_build_array(jsonb_build_object('gastoId',g,'montoNuevo',caso.final)),actor,null,
       jsonb_build_object('totalComprobado',caso.final,'diferencia',5000-caso.final,
         'estatus','con_diferencias','diferencias','[]'::jsonb,'iepsAcreditable',0,
         'litrosDieselAcreditables',0,'ivaAcreditable',480,'peajeAcreditable',0));
   elsif caso.accion<>'pendiente' then
     revisada := public.revisar_liquidacion(t,l,caso.accion,'Revisión sintética',null,actor,null);
   end if;
   if not exists(select 1 from public.gasto where id=g and sub_total=3000 and iva_traslado=480 and ieps_traslado=0) then
     raise exception '0342: la revisión alteró el desglose fiscal de %',caso.folio;
   end if;
 end loop;
 datos := public.poliza_datos_tenant(t,current_date-1,current_date+1);
 if jsonb_array_length(datos)<>6 then raise exception '0342: omitió pendientes o incluyó rechazadas: %',datos; end if;
 for fila in select value from jsonb_array_elements(datos) loop
   if (fila->>'version')::integer is distinct from 342 or not(fila ? 'revision') then
     raise exception '0342: contrato no incluye firma/version342: %',fila->>'folioViaje';
   end if;
   if (fila->'gastos'->0->>'ivaTraslado')::numeric is distinct from 480 or
      (fila->'gastos'->0->>'iepsTraslado')::numeric is distinct from 0 then
     raise exception '0342: faltan tributos originales: %',fila->>'folioViaje';
   end if;
   if fila->>'folioViaje'='PENDIENTE' and fila->>'revision'<>'pendiente' then raise exception '0342: inventó firma'; end if;
   if fila->>'folioViaje'='APROBADA' and fila->>'revision'<>'aprobada' then raise exception '0342: perdió firma'; end if;
   if fila->>'folioViaje' like 'AJUSTE-%' and fila->>'revision'<>'ajustada' then raise exception '0342: perdió revisión ajustada'; end if;
   if fila->>'folioViaje' like '%COHERENTE' and fila->>'folioViaje' not like '%INCOMPATIBLE' and
      (fila->'gastos'->0->>'monto')::numeric<>3480 then raise exception '0342: no persistió corrección coherente'; end if;
 end loop;
 if public.poliza_datos_tenant(otro,current_date-1,current_date+1)<>'[]'::jsonb then raise exception '0342: fuga entre tenants'; end if;
 insert into poliza342_fixture values(t,datos);
end
$fixture$;
-- Permisos y características deben coincidir con la RPC vigente de 0341.
do $permisos$
begin
 if has_function_privilege('anon','public.poliza_datos_tenant(uuid,date,date)','execute') or
    has_function_privilege('authenticated','public.poliza_datos_tenant(uuid,date,date)','execute') or
    not has_function_privilege('service_role','public.poliza_datos_tenant(uuid,date,date)','execute') then raise exception '0342: deriva de ACL'; end if;
 if not exists(select 1 from pg_proc where oid='public.poliza_datos_tenant(uuid,date,date)'::regprocedure
   and not prosecdef and provolatile='s' and proparallel='s' and 'search_path=public, pg_catalog'=any(proconfig)) then raise exception '0342: deriva de seguridad/volatilidad'; end if;
end
$permisos$;
-- Permite consumir exactamente este JSON en una prueba local de la ruta real.
select filas as poliza342_json from poliza342_fixture;
rollback;
\echo '0342_poliza_revision_y_desglose: PASS'
