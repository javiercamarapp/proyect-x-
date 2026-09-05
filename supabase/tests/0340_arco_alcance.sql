-- PostgreSQL efímero, datos sintéticos propios, rollback completo.
\set ON_ERROR_STOP on
begin;
insert into public.tenant(id,nombre) values
 ('34000000-0000-4000-8000-000000000001','ARCO340 A'),
 ('34000000-0000-4000-8000-000000000002','ARCO340 B');
insert into public.operador(id,tenant_id,nombre,telefono,rfc,licencia) values
 ('34000000-0000-4000-8000-000000000011','34000000-0000-4000-8000-000000000001','Titular sintético A','529999903401','XAXX010101000','LIC-SINTETICA'),
 ('34000000-0000-4000-8000-000000000012','34000000-0000-4000-8000-000000000002','Titular sintético B','529999903402',null,null);
insert into public.app_user(id,tenant_id,operador_id,email,nombre,rol) values
 ('34000000-0000-4000-8000-000000000021','34000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000011','arco340a@example.invalid','Titular sintético A','encargado');
insert into public.wa_conversacion(id,tenant_id,operador_id,telefono,estado) values
 ('34000000-0000-4000-8000-000000000031','34000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000011','529999903401','{"texto":"Sintético A"}'),
 ('34000000-0000-4000-8000-000000000032','34000000-0000-4000-8000-000000000002','34000000-0000-4000-8000-000000000012','529999903402','{"texto":"Sintético B"}');
insert into public.solicitud_arco(id,tenant_id,operador_id,titular_ref,tipo,vence_en,estado,resuelta_en,resolucion) values
 ('34000000-0000-4000-8000-000000000041','34000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000011','529999903401','cancelacion','2026-10-01','recibida',null,null),
 ('34000000-0000-4000-8000-000000000042','34000000-0000-4000-8000-000000000002','34000000-0000-4000-8000-000000000012','529999903402','cancelacion','2026-10-01','recibida',null,null),
 ('34000000-0000-4000-8000-000000000043','34000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000011','529999903401','cancelacion','2026-10-01','resuelta',now(),'Constancia histórica sintética: conservar literalmente');
insert into public.cfdi_xml(id,tenant_id,cfdi_uuid,xml) values
 ('34000000-0000-4000-8000-000000000051','34000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000061','<Fiscal sintetico="true">Titular sintético A</Fiscal>');

set local role service_role;
do $prueba$
declare
 r jsonb;
 resolucion_nueva text;
begin
 r := public.ejecutar_arco_cancelacion('34000000-0000-4000-8000-000000000002','34000000-0000-4000-8000-000000000041');
 if (r->>'ok')::boolean then raise exception '0340: aceptó solicitud de otro tenant'; end if;
 r := public.ejecutar_arco_cancelacion('34000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000041');
 if not coalesce((r->>'ok')::boolean,false) then raise exception '0340: operación propia falló %',r; end if;
 select resolucion into resolucion_nueva from public.solicitud_arco where id='34000000-0000-4000-8000-000000000041';
 if resolucion_nueva is distinct from 'Se sustituyeron el nombre y el teléfono del registro operativo y se eliminaron sus conversaciones. Se conservan el identificador del operador, el correo de la cuenta, la referencia del titular en la solicitud y la documentación fiscal. Requieren revisión de privacidad para determinar los pasos pendientes.' then
   raise exception '0340: resolución promete más que la operación real: %',resolucion_nueva;
 end if;
 if not exists (select 1 from public.operador where id='34000000-0000-4000-8000-000000000011' and nombre like 'Operador %' and telefono like 'anon:%' and rfc is null and licencia is null) then raise exception '0340: cambió sustitución del operador'; end if;
 if exists (select 1 from public.wa_conversacion where id='34000000-0000-4000-8000-000000000031') then raise exception '0340: no eliminó conversación propia'; end if;
 if not exists (select 1 from public.app_user where id='34000000-0000-4000-8000-000000000021' and email='arco340a@example.invalid' and operador_id='34000000-0000-4000-8000-000000000011') then raise exception '0340: cambió conservación de correo/UUID'; end if;
 if not exists (select 1 from public.solicitud_arco where id='34000000-0000-4000-8000-000000000041' and titular_ref='529999903401' and estado='resuelta') then raise exception '0340: cambió referencia conservada'; end if;
 if not exists (select 1 from public.cfdi_xml where id='34000000-0000-4000-8000-000000000051' and xml='<Fiscal sintetico="true">Titular sintético A</Fiscal>') then raise exception '0340: alteró documentación fiscal'; end if;
 if not exists (select 1 from public.operador where id='34000000-0000-4000-8000-000000000012' and nombre='Titular sintético B' and telefono='529999903402') or not exists (select 1 from public.wa_conversacion where id='34000000-0000-4000-8000-000000000032' and estado->>'texto'='Sintético B') then raise exception '0340: alteró otro tenant'; end if;
 if not exists (select 1 from public.solicitud_arco where id='34000000-0000-4000-8000-000000000043' and resolucion='Constancia histórica sintética: conservar literalmente') then raise exception '0340: alteró resolución histórica'; end if;
 r := public.ejecutar_arco_cancelacion('34000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000041');
 if (r->>'ok')::boolean then raise exception '0340: aceptó ejecutar otra vez una cerrada'; end if;
end
$prueba$;
reset role;
do $permisos$
begin
 if has_function_privilege('anon','public.ejecutar_arco_cancelacion(uuid,uuid)','execute') or has_function_privilege('authenticated','public.ejecutar_arco_cancelacion(uuid,uuid)','execute') then raise exception '0340: RPC ejecutable por rol no autorizado'; end if;
 if not exists (select 1 from pg_proc where oid='public.ejecutar_arco_cancelacion(uuid,uuid)'::regprocedure and not prosecdef and 'search_path=public, extensions, pg_catalog'=any(proconfig)) then raise exception '0340: deriva en security/search_path'; end if;
end
$permisos$;
rollback;
\echo '0340_arco_alcance: PASS'
