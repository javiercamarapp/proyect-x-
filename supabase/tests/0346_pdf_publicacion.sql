\set ON_ERROR_STOP on
begin;
do $test$
declare
 t uuid := '34600000-0000-4000-8000-000000000001';
 other_t uuid := '34600000-0000-4000-8000-000000000002';
 u uuid := '34600000-0000-4000-8000-000000000003';
 o uuid := '34600000-0000-4000-8000-000000000004';
 v uuid := '34600000-0000-4000-8000-000000000005';
 g uuid := '34600000-0000-4000-8000-000000000006';
 l uuid; r jsonb; reviewed timestamptz;
 old_path text := t::text||'/'||v::text||'.pdf';
 frozen text := t::text||'/'||v::text||'-version-34600000-0000-4000-8000-000000000007.pdf';
 fresh text := t::text||'/'||v::text||'-version-34600000-0000-4000-8000-000000000008.pdf';
 old_figures jsonb := '{"totalComprobado":800,"totalAnticipo":5000,"diferencia":4200,"estatus":"revisar","diferencias":[],"iepsAcreditable":0,"litrosDieselAcreditables":0,"ivaAcreditable":0,"peajeAcreditable":0}';
 new_figures jsonb := '{"totalComprobado":8000,"totalAnticipo":5000,"diferencia":-3000,"estatus":"con_diferencias","diferencias":[],"iepsAcreditable":0,"litrosDieselAcreditables":0,"ivaAcreditable":0,"peajeAcreditable":0}';
 blocked boolean := false;
begin
 insert into tenant(id,nombre) values(t,'PDF346 A'),(other_t,'PDF346 B');
 insert into app_user(id,tenant_id,email,rol) values(u,t,'pdf346@example.invalid','flota_admin');
 insert into operador(id,tenant_id,nombre,telefono) values(o,t,'PDF sintético','529999903461');
 insert into viaje(id,tenant_id,operador_id,folio,anticipo) values(v,t,o,'PDF346',5000);
 insert into gasto(id,tenant_id,viaje_id,concepto,monto) values(g,t,v,'diesel',800);
 l := guardar_liquidacion_tx(t,v,800,5000,4200,'revisar','[]',0,0,0,old_path,0);
 update liquidacion set entregada_operador_en=now(),avisada_oficina_en=now() where id=l;
 insert into storage.buckets(id,name,public) values('liquidaciones','liquidaciones',false) on conflict(id) do nothing;
 insert into storage.objects(bucket_id,name) values('liquidaciones',old_path),('liquidaciones',replace(old_path,'.pdf','-operador.pdf'));

 -- Un ajuste no pierde la versión previa por publicar sobre una ruta legacy.
 begin
   perform revisar_liquidacion(t,l,'ajustar','prueba',jsonb_build_array(jsonb_build_object('gastoId',g,'montoNuevo',8000)),u,null,new_figures);
 exception when sqlstate 'LP002' then blocked:=true;
 end;
 if not blocked or (select monto from gasto where id=g)<>800 then raise exception '0346: ajuste legacy no falló atómicamente'; end if;
 insert into storage.objects(bucket_id,name) values('liquidaciones',frozen);
 if publicar_pdf_liquidacion(t,l,v,'pendiente',null,old_path,frozen,old_figures) then raise exception '0346: publicó sólo una mitad'; end if;
 insert into storage.objects(bucket_id,name) values('liquidaciones',replace(frozen,'.pdf','-operador.pdf'));
 if publicar_pdf_liquidacion(other_t,l,v,'pendiente',null,old_path,frozen,old_figures) then raise exception '0346: publicó en otro tenant'; end if;
 if not publicar_pdf_liquidacion(t,l,v,'pendiente',null,old_path,frozen,old_figures) then raise exception '0346: no conservó legacy'; end if;
 r := revisar_liquidacion(t,l,'ajustar','ticket correcto',jsonb_build_array(jsonb_build_object('gastoId',g,'montoNuevo',8000)),u,null,new_figures);
 reviewed := (r->>'revisada_en')::timestamptz;
 if not exists(select 1 from liquidacion where id=l and pdf_url is null and total_comprobado=8000 and revisada_por=u
   and entregada_operador_en is null and avisada_oficina_en is null and pdf_historial->0->>'url'=frozen) then raise exception '0346: no invalidó PDF sin perder firma/dinero/historial'; end if;
 -- Un worker antiguo puede sobrescribir su objeto legacy, pero no volver a publicarlo.
 blocked:=false;
 begin update liquidacion set pdf_url=old_path where id=l;
 exception when sqlstate 'LP001' then blocked:=true; end;
 if not blocked then raise exception '0346: worker viejo republicó legacy'; end if;
 insert into storage.objects(bucket_id,name) values('liquidaciones',fresh),('liquidaciones',replace(fresh,'.pdf','-operador.pdf'));
 if publicar_pdf_liquidacion(t,l,v,'ajustada',reviewed-interval '1 second',null,fresh,new_figures) then raise exception '0346: publicó revisión anterior'; end if;
 if publicar_pdf_liquidacion(t,l,v,'ajustada',reviewed,null,fresh,old_figures) then raise exception '0346: publicó cifras distintas'; end if;
 if not publicar_pdf_liquidacion(t,l,v,'ajustada',reviewed,null,fresh,new_figures) then raise exception '0346: no publicó pareja completa'; end if;
 if publicar_pdf_liquidacion(t,l,v,'ajustada',reviewed,null,fresh,new_figures) then raise exception '0346: CAS perdedor reportó éxito'; end if;
 if not exists(select 1 from liquidacion where id=l and pdf_url=fresh and revisada_por=u and revisada_en=reviewed and total_comprobado=8000) then raise exception '0346: publicación cambió firma/dinero'; end if;
 if has_function_privilege('authenticated','public.publicar_pdf_liquidacion(uuid,uuid,uuid,text,timestamptz,text,text,jsonb)','execute')
   or not has_function_privilege('service_role','public.publicar_pdf_liquidacion(uuid,uuid,uuid,text,timestamptz,text,text,jsonb)','execute') then raise exception '0346: ACL incorrecta'; end if;
end $test$;
rollback;
