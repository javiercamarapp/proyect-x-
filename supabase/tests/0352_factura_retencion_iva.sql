\set ON_ERROR_STOP on
-- AUDITORÍA 28, FIS-M3: factura_emitida puede representar la retención de
-- IVA; sin ella (default 0) el CHECK sigue exigiendo total=subtotal+iva
-- exacto, igual que siempre.
begin;
insert into public.tenant(id,nombre) values ('35200000-0000-4000-8000-000000000001','Retencion352 A');
insert into public.cliente(id,tenant_id,nombre) values
 ('35200000-0000-4000-8000-000000000001','35200000-0000-4000-8000-000000000001','Cliente sintético 352');
set local role service_role;
-- Sin retención: comportamiento idéntico al de siempre.
insert into public.factura_emitida(id,tenant_id,cliente_id,fecha,subtotal,iva,total,moneda,estatus) values
 ('35200000-0000-4000-8000-000000000001','35200000-0000-4000-8000-000000000001','35200000-0000-4000-8000-000000000001','2026-03-01',10000,1600,11600,'MXN','borrador');
-- Con retención del 4%: total = subtotal + iva - retencion.
insert into public.factura_emitida(id,tenant_id,cliente_id,fecha,subtotal,iva,retencion_iva,total,moneda,estatus) values
 ('35200000-0000-4000-8000-000000000002','35200000-0000-4000-8000-000000000001','35200000-0000-4000-8000-000000000001','2026-03-02',10000,1600,400,11200,'MXN','borrador');
do $$ begin
 if (select retencion_iva from public.factura_emitida where id='35200000-0000-4000-8000-000000000001') <> 0 then
  raise exception '0352: el default de retencion_iva no es 0';
 end if;
 if (select total from public.factura_emitida where id='35200000-0000-4000-8000-000000000002') <> 11200 then
  raise exception '0352: el total con retención no cuadra';
 end if;
 -- El CHECK sigue rechazando un total que no cuadre con la retención.
 begin
  insert into public.factura_emitida(id,tenant_id,cliente_id,fecha,subtotal,iva,retencion_iva,total,moneda,estatus) values
   ('35200000-0000-4000-8000-000000000003','35200000-0000-4000-8000-000000000001','35200000-0000-4000-8000-000000000001','2026-03-03',10000,1600,400,11600,'MXN','borrador');
  raise exception '0352: el CHECK dejó pasar un total que ignora la retención';
 exception when check_violation then
  null; -- esperado
 end;
 -- Retención negativa sigue rechazada.
 begin
  insert into public.factura_emitida(id,tenant_id,cliente_id,fecha,subtotal,iva,retencion_iva,total,moneda,estatus) values
   ('35200000-0000-4000-8000-000000000004','35200000-0000-4000-8000-000000000001','35200000-0000-4000-8000-000000000001','2026-03-04',10000,1600,-1,11601,'MXN','borrador');
  raise exception '0352: el CHECK dejó pasar una retención negativa';
 exception when check_violation then
  null; -- esperado
 end;
end $$;
reset role;
rollback;
