\set ON_ERROR_STOP on
-- AUDITORÍA 28, FIS-C2 + ARQ-A3: "foto repetida no es gasto" en el cubo del
-- 15%. Dos fotos del mismo ticket de diesel (mismo folio_norm, mismo monto,
-- ambas en efectivo) no deben sumarse dos veces ni en total ni en efectivo.
--
-- NOTA: el dedup por (cfdi_uuid, cfdi_orden) de la migración NO se puede
-- ejercitar aquí — `uq_gasto_cfdi_uuid` ya lo prohíbe a nivel de base (índice
-- único parcial), así que en la práctica solo el camino de FOLIO puede
-- producir una copia real en `gasto`. Se prueba ese camino.
begin;
insert into public.tenant(id,nombre) values
 ('34900000-0000-4000-8000-000000000001','Combustible349 A');
insert into public.operador(id,tenant_id,nombre,telefono) values
 ('34900000-0000-4000-8000-000000000001','34900000-0000-4000-8000-000000000001','Operador sintético 349','529999903491');
insert into public.viaje(id,tenant_id,operador_id,folio,estatus) values
 ('34900000-0000-4000-8000-000000000001','34900000-0000-4000-8000-000000000001','34900000-0000-4000-8000-000000000001','A349-1','liquidado');
insert into public.gasto(id,tenant_id,viaje_id,concepto,monto,fecha,folio,folio_norm,forma_pago) values
 ('34900000-0000-4000-8000-000000000301','34900000-0000-4000-8000-000000000001','34900000-0000-4000-8000-000000000001','diesel',300,'2026-03-01','0059','59','01'),
 ('34900000-0000-4000-8000-000000000302','34900000-0000-4000-8000-000000000001','34900000-0000-4000-8000-000000000001','diesel',300,'2026-03-01','59','59','01'),
 ('34900000-0000-4000-8000-000000000303','34900000-0000-4000-8000-000000000001','34900000-0000-4000-8000-000000000001','diesel',1000,'2026-03-02',null,null,'02'),
 ('34900000-0000-4000-8000-000000000304','34900000-0000-4000-8000-000000000001','34900000-0000-4000-8000-000000000001','diesel',2000,'2026-03-03',null,null,'99');
create temp table historial349 as select id,md5(to_jsonb(g)::text) huella from public.gasto g where tenant_id='34900000-0000-4000-8000-000000000001';
set local role service_role;
do $$declare r record; begin
 -- Rojo esperado si el filtro se cae: total=3600, efectivo=600 (la copia de
 -- 300 en efectivo se cuenta dos veces). Verde: total=3300, efectivo=300.
 select * into r from public.sumar_combustible_ejercicio('34900000-0000-4000-8000-000000000001',2026,null);
 if r.total <> 3300 then
  raise exception '0349: total cuenta la copia por folio: total=% (esperado 3300)',r.total;
 end if;
 if r.efectivo <> 300 then
  raise exception '0349: efectivo cuenta la copia por folio: efectivo=% (esperado 300)',r.efectivo;
 end if;

 -- Idempotencia: dos corridas seguidas dan lo mismo.
 select * into r from public.sumar_combustible_ejercicio('34900000-0000-4000-8000-000000000001',2026,null);
 if r.total <> 3300 or r.efectivo <> 300 then
  raise exception '0349: no es idempotente: total=%, efectivo=%',r.total,r.efectivo;
 end if;
end $$;
reset role;
do $$ begin
 if (select count(*) from public.gasto g join historial349 h on h.id=g.id where h.huella <> md5(to_jsonb(g)::text)) <> 0 then
  raise exception '0349: leer el cubo del 15%% mutó el historial de gasto';
 end if;
end $$;
rollback;
