\set ON_ERROR_STOP on
-- AUDITORÍA 28, DAT-M2 (mitad SQL): borrar un tenant debe llevarse consigo
-- sus filas de chat_conversacion y cobranza_contacto sin que el borrador
-- tenga que hacerlo a mano (ver PR #403, T3-04, la mitad de código).
begin;
insert into public.tenant(id,nombre) values
 ('35000000-0000-4000-8000-000000000001','Cascade350 A');
insert into public.app_user(id,tenant_id,email,rol) values
 ('35000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001','cascade350@example.invalid','flota_admin');
insert into public.operador(id,tenant_id,nombre,telefono) values
 ('35000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001','Operador sintético 350','529999903501');
insert into public.viaje(id,tenant_id,operador_id,folio,estatus) values
 ('35000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001','A350-1','liquidado');
insert into public.chat_conversacion(id,tenant_id,user_id,titulo) values
 ('35000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001','Conversación sintética 350');
insert into public.cobranza_contacto(id,tenant_id,viaje_id,tier,enviado) values
 ('35000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001',1,false);
set local role service_role;
delete from public.tenant where id='35000000-0000-4000-8000-000000000001';
do $$ begin
 if (select count(*) from public.chat_conversacion where tenant_id='35000000-0000-4000-8000-000000000001') <> 0 then
  raise exception '0350: chat_conversacion sobrevivió al borrado del tenant';
 end if;
 if (select count(*) from public.cobranza_contacto where tenant_id='35000000-0000-4000-8000-000000000001') <> 0 then
  raise exception '0350: cobranza_contacto sobrevivió al borrado del tenant';
 end if;
end $$;
reset role;
rollback;
