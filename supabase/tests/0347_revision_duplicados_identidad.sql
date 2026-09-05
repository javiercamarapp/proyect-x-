\set ON_ERROR_STOP on
-- RPC real con originales/copias sintéticos; sin relajar FK, índices ni triggers.
begin;
do $prueba$
declare
 t uuid; ajeno uuid; actor uuid := gen_random_uuid(); op uuid; v uuid; original uuid; copia uuid; l uuid;
 ot uuid; ov uuid; og uuid; caso record; numero int := 0; codigo text; mensaje text;
 elegido uuid; difs jsonb; actual jsonb; antes_g jsonb; antes_l jsonb; posterior_g jsonb; posterior_l jsonb;
 fiscal text := 'abcdefab-1234-4567-8901-abcdefabcdef';
begin
 insert into public.tenant(nombre) values ('SINTETICO DUP347') returning id into t;
 insert into public.tenant(nombre) values ('SINTETICO DUP347 AJENO') returning id into ajeno;
 insert into public.app_user(id,tenant_id,email,rol) values(actor,t,'duplicados347@example.invalid','flota_admin');
 insert into public.operador(tenant_id,nombre,telefono) values(ajeno,'Referencia ajena','529999934790') returning id into ot;
 insert into public.viaje(tenant_id,operador_id) values(ajeno,ot) returning id into ov;
 insert into public.gasto(tenant_id,viaje_id,concepto,monto,folio) values(ajeno,ov,'diesel',8000,'TICKET-347') returning id into og;
 for caso in select * from (values
   ('original_ticket','LR022',8800::numeric),
   ('copia_ticket','LR019',8800),
   ('original_uuid',null,800),
   ('referencia_otra_flota',null,800),
   ('referencia_otro_viaje',null,800),
   ('referencia_inexistente',null,800),
   ('uuid_recalculo_incoherente','LR020',9999)
 ) casos(nombre,esperado,total_nuevo)
 loop
   numero:=numero+1;
   insert into public.operador(tenant_id,nombre,telefono) values(t,caso.nombre,'52999993470'||numero::text) returning id into op;
   insert into public.viaje(tenant_id,operador_id,folio,anticipo) values(t,op,caso.nombre,10000) returning id into v;
   -- UUID estable: la unicidad vigente impide copias físicas del mismo
   -- UUID/orden. La diferencia histórica puede seguir señalando al original.
   fiscal := 'abcdefab-1234-4567-8901-'||lpad(numero::text,12,'0');
   insert into public.gasto(tenant_id,viaje_id,concepto,monto,folio,cfdi_uuid,cfdi_orden)
     values(t,v,'diesel',8000,'TICKET-347',case when caso.nombre like '%uuid%' then fiscal else null end,1) returning id into original;
   if caso.nombre in ('original_ticket','copia_ticket') then
     insert into public.gasto(tenant_id,viaje_id,concepto,monto,folio,cfdi_uuid,cfdi_orden)
       values(t,v,'diesel',8000,'TICKET-347',null,1) returning id into copia;
   end if;
   difs := jsonb_build_array(jsonb_build_object('tipo','duplicado','gastoId',case
     when caso.nombre='referencia_otra_flota' then og
     when caso.nombre='referencia_inexistente' then gen_random_uuid()
     when caso.nombre='referencia_otro_viaje' then (select g.id from public.gasto g where g.tenant_id=t and g.viaje_id<>v limit 1)
     else original end,'monto',8000,'nota','Grupo sintético'));
   l:=public.guardar_liquidacion_tx(t,v,8000,10000,2000,'revisar',difs,0,0,0,null,0);
   elegido:=case when caso.nombre like 'copia_%' then copia else original end;
   select jsonb_agg(to_jsonb(g) order by g.id) into antes_g from public.gasto g where viaje_id=v;
   select to_jsonb(x) into antes_l from public.liquidacion x where id=l;
   codigo:=null;mensaje:=null;
   begin
     actual:=public.revisar_liquidacion(t,l,'ajustar','Corrección sintética',
       jsonb_build_array(jsonb_build_object('gastoId',elegido,'montoNuevo',800)),actor,null,
       jsonb_build_object('totalComprobado',caso.total_nuevo,'diferencia',10000-caso.total_nuevo,
         'estatus','revisar','diferencias','[]'::jsonb,'iepsAcreditable',0,'litrosDieselAcreditables',0,'ivaAcreditable',0,'peajeAcreditable',0));
   exception when others then get stacked diagnostics codigo=returned_sqlstate,mensaje=message_text;
   end;
   if codigo is distinct from caso.esperado then
     raise exception '0347 %: esperado %, recibió %: %',caso.nombre,caso.esperado,codigo,mensaje;
   end if;
   if codigo is not null then
     select jsonb_agg(to_jsonb(g) order by g.id) into posterior_g from public.gasto g where viaje_id=v;
     select to_jsonb(x) into posterior_l from public.liquidacion x where id=l;
     if antes_g is distinct from posterior_g or antes_l is distinct from posterior_l then raise exception '0347 rechazo parcial alteró datos: %',caso.nombre;end if;
   else
     if not exists(select 1 from public.gasto where id=elegido and monto=800)
       or not exists(select 1 from public.liquidacion where id=l and total_comprobado=800 and revision='ajustada') then
       raise exception '0347 ajuste permitido no se persistió: %',caso.nombre;end if;
   end if;
   if codigo='LR022' and (mensaje not like '%original%' or mensaje not like '%rechaza%' or mensaje not like '%vuelve a calcular%' or mensaje like '%excluid%') then raise exception '0347 mensaje original engañoso: %',mensaje;end if;
   if codigo='LR019' and mensaje not like '%copia excluida%' then raise exception '0347 mensaje copia ambiguo: %',mensaje;end if;
 end loop;
 if not exists(select 1 from public.gasto where id=og and monto=8000) then raise exception '0347 alteró referencia ajena';end if;
end
$prueba$;
rollback;
\echo '0347_revision_duplicados_identidad: PASS'
