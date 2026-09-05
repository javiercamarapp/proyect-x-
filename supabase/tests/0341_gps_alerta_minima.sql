\set ON_ERROR_STOP on
-- Datos sintéticos propios; no HTTP ni Meta. Rollback completo.
begin;
insert into public.tenant(id,nombre) values
 ('34100000-0000-4000-8000-000000000001','GPS341 A'),
 ('34100000-0000-4000-8000-000000000002','GPS341 B');
insert into public.unidad(id,tenant_id,numero_economico) values
 ('34100000-0000-4000-8000-000000000011','34100000-0000-4000-8000-000000000001','MIN-1'),
 ('34100000-0000-4000-8000-000000000012','34100000-0000-4000-8000-000000000002','MIN-2');
insert into public.operador(id,tenant_id,nombre,telefono) values
 ('34100000-0000-4000-8000-000000000021','34100000-0000-4000-8000-000000000001','Sintético','529999903411');
insert into public.viaje(id,tenant_id,unidad_id,operador_id) values
 ('34100000-0000-4000-8000-000000000031','34100000-0000-4000-8000-000000000001','34100000-0000-4000-8000-000000000011','34100000-0000-4000-8000-000000000021');
insert into public.evento_seguridad_flota(tenant_id,proveedor,evento_id_externo,unidad_id,grave,ocurrido_en,privacidad_minima) values
 ('34100000-0000-4000-8000-000000000001','samsara','minimo','34100000-0000-4000-8000-000000000011',true,'2026-09-05T15:00:00Z',true),
 ('34100000-0000-4000-8000-000000000001','samsara','legacy','34100000-0000-4000-8000-000000000011',true,'2026-09-05T15:00:00Z',false),
 ('34100000-0000-4000-8000-000000000002','samsara','otro-tenant','34100000-0000-4000-8000-000000000012',true,'2026-09-05T15:00:00Z',true);
insert into public.evento_seguridad_flota(tenant_id,proveedor,evento_id_externo,unidad_id,viaje_id,operador_id,grave,ocurrido_en) values
 ('34100000-0000-4000-8000-000000000001','samsara','autorizado','34100000-0000-4000-8000-000000000011','34100000-0000-4000-8000-000000000031','34100000-0000-4000-8000-000000000021',true,'2026-09-05T15:01:23Z');

-- Cada mutación debe rebotar por el CHECK, no por una excepción ajena.
do $$
declare cambio text;
begin
 for cambio in select unnest(array[
   'grave=false','asset_id=''sintetico''','etiquetas=array[''Crash'']',
   'lat=1','lng=1','url_evento=''https://example.invalid/video''','max_g=1',
   'viaje_id=''34100000-0000-4000-8000-000000000031''::uuid',
   'operador_id=''34100000-0000-4000-8000-000000000021''::uuid','viaje_folio=''PII''',
   'ocurrido_en=''2026-09-05T15:00:01Z''::timestamptz','ocurrido_en=''infinity''::timestamptz'
 ]) loop
   begin
     execute 'update public.evento_seguridad_flota set '||cambio||' where evento_id_externo=''minimo'' and tenant_id=''34100000-0000-4000-8000-000000000001''';
     raise exception '0341 aceptó mínimo malformado: %',cambio;
   exception when check_violation then null;
   end;
 end loop;
 if not exists(select 1 from public.listar_outboxes_eventos_pendientes(100,'2026-09-05T16:00:00Z') where tenant_id='34100000-0000-4000-8000-000000000002') then
   raise exception '0341 cron global no descubre mínimo sin credencial';
 end if;
end$$;
-- La FK conserva el evento mínimo al borrar la unidad; nunca se drena huérfano.
delete from public.unidad where id='34100000-0000-4000-8000-000000000012';
insert into public.evento_seguridad_flota(tenant_id,proveedor,evento_id_externo,grave,ocurrido_en,privacidad_minima)
values('34100000-0000-4000-8000-000000000002','samsara','huerfano-directo',true,'2026-09-05T15:00:00Z',true);
do $$begin
 if not exists(select 1 from public.evento_seguridad_flota where evento_id_externo='otro-tenant' and tenant_id='34100000-0000-4000-8000-000000000002' and unidad_id is null and privacidad_minima and lat is null and operador_id is null) then raise exception '0341 FK no conserva mínimo privado';end if;
 if exists(select 1 from public.reclamar_eventos_seguridad('34100000-0000-4000-8000-000000000002','samsara',100,'orphan',360,'2026-09-05T16:00:00Z')) then raise exception '0341 reclama huérfano';end if;
 if exists(select 1 from public.listar_outboxes_eventos_pendientes(100,'2026-09-05T16:00:00Z') where tenant_id='34100000-0000-4000-8000-000000000002') then raise exception '0341 lista huérfano';end if;
end$$;
set local role service_role;
create temp table claims341 as select * from public.reclamar_eventos_seguridad('34100000-0000-4000-8000-000000000001','samsara',100,'worker-a',360,'2026-09-05T16:00:00Z');
do $$
declare r record; outbox_a uuid; outbox_b uuid; payload jsonb;
begin
 if (select count(*) from claims341)<>2 or not exists(select 1 from claims341 where evento_id_externo='minimo' and privacidad_minima) or not exists(select 1 from claims341 where evento_id_externo='autorizado' and not privacidad_minima) then raise exception '0341 claim no separa autorizado/mínimo/legacy/tenant';end if;
 if exists(select 1 from public.reclamar_eventos_seguridad('34100000-0000-4000-8000-000000000001','samsara',100,'worker-b',360,'2026-09-05T16:02:01Z')) then raise exception '0341 robó lease a121s';end if;
 if exists(select 1 from public.reclamar_eventos_seguridad('34100000-0000-4000-8000-000000000001','otro',100,'worker-b',360,'2026-09-05T16:00:00Z')) then raise exception '0341 cruzó proveedor';end if;
 select * into r from claims341 where evento_id_externo='minimo';
 if public.finalizar_evento_seguridad('34100000-0000-4000-8000-000000000002','samsara','minimo',r.claim_token,false) then raise exception '0341 finalizó otro tenant';end if;
 if public.finalizar_evento_seguridad('34100000-0000-4000-8000-000000000001','samsara','minimo',gen_random_uuid(),false) then raise exception '0341 aceptó token ajeno';end if;
 payload := '{"messaging_product":"whatsapp","to":"529999903411","type":"template","template":{"name":"gps_alerta_critica","language":{"code":"es_MX"},"components":[{"type":"body","parameters":[{"type":"text","text":"Alerta mínima sintética"}]},{"type":"button","sub_type":"quick_reply","index":"0","parameters":[{"type":"payload","payload":"ok"}]}]}}';
 select id into outbox_a from public.encolar_wa_outbox_dedupe('gps:samsara:34100000-0000-4000-8000-000000000001:minimo',payload);
 select id into outbox_b from public.encolar_wa_outbox_dedupe('gps:samsara:34100000-0000-4000-8000-000000000001:minimo',payload);
 if outbox_a is distinct from outbox_b then raise exception '0341 perdió dedupe';end if;
 if not public.finalizar_evento_seguridad('34100000-0000-4000-8000-000000000001','samsara','minimo',r.claim_token,true,null,'pending',outbox_a) then raise exception '0341 no encoló mínimo';end if;
 if not exists(select 1 from public.evento_seguridad_flota where tenant_id='34100000-0000-4000-8000-000000000001' and evento_id_externo='minimo' and procesado_en is null and aviso_estado='pending' and claim_token is null) then raise exception '0341 confundió encolado con entrega';end if;
 if not exists(select 1 from public.estado_eventos_gps_operativo() where tenant_id='34100000-0000-4000-8000-000000000001' and avisos_pendientes=1) then raise exception '0341 salud no ve outbox mínimo';end if;
 update public.wa_outbox set provider_message_id='wamid.341.minimo',provider_status='accepted',estado='sent' where id=outbox_a;
 if exists(select 1 from public.evento_seguridad_flota where aviso_outbox_id=outbox_a and procesado_en is not null) then raise exception '0341 accepted selló como entregado';end if;
 perform public.registrar_estado_wa_meta('wamid.341.minimo','delivered',null,'2026-09-05T16:01:00Z');
 if not exists(select 1 from public.evento_seguridad_flota where aviso_outbox_id=outbox_a and procesado_en is not null and aviso_estado='sent') then raise exception '0341 receipt no confirmó entrega mínima';end if;
end$$;
reset role;
do $$begin
 if has_function_privilege('anon','public.reclamar_eventos_seguridad(uuid,text,integer,text,integer,timestamptz)','execute') or has_function_privilege('authenticated','public.reclamar_eventos_seguridad(uuid,text,integer,text,integer,timestamptz)','execute') then raise exception '0341 RPC expuesto';end if;
end$$;
rollback;
\echo '0341_gps_alerta_minima: PASS'
