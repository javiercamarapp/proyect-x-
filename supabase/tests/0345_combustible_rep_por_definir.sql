\set ON_ERROR_STOP on
begin;
-- Ejercicio sintético: la forma 99 aún sin definir no puede convertirse
-- en efectivo sólo porque el REP tenga fecha. No cambia el denominador.
do $$
declare ta uuid; tb uuid; oa uuid; ob uuid; va uuid; vb uuid; r record;
begin
 insert into tenant(nombre) values('ZZZ 0345 A') returning id into ta;
 insert into tenant(nombre) values('ZZZ 0345 B') returning id into tb;
 insert into operador(tenant_id,nombre,telefono) values(ta,'0345 A','529999903451') returning id into oa;
 insert into operador(tenant_id,nombre,telefono) values(tb,'0345 B','529999903452') returning id into ob;
 insert into viaje(tenant_id,operador_id) values(ta,oa) returning id into va;
 insert into viaje(tenant_id,operador_id) values(tb,ob) returning id into vb;
 insert into gasto(tenant_id,viaje_id,concepto,monto,fecha,forma_pago,pagado_en,pagado_forma) values
 (ta,va,'diesel',10000,'2026-05-01','99','2026-05-02','99'),
 (ta,va,'diesel',20000,'2026-05-01','99','2026-05-02',null),
 (ta,va,'diesel',30000,'2026-05-01','99',null,'01'),
 (ta,va,'diesel',40000,'2026-05-01','99','2026-05-02','01'),
 (ta,va,'diesel',50000,'2026-05-01','99','2026-05-02','06'),
 (ta,va,'diesel',60000,'2026-05-01','99','2026-05-02','03'),
 (ta,va,'diesel',70000,'2025-05-01','01',null,null),
 (tb,vb,'diesel',999999,'2026-05-01','01',null,null);
 insert into gasto(tenant_id,viaje_id,concepto,clave_prod_serv,monto,fecha,forma_pago)
 values(ta,va,'otro','15101505',123,'2026-05-01','01');
 select * into r from public.sumar_combustible_ejercicio(ta,2026,array['15101505']);
 if r.total<>210123 or r.efectivo<>90123 then
  raise exception '0345 discrepancia: total %, efectivo %; esperado 210123/90123',r.total,r.efectivo;
 end if;
 select * into r from public.sumar_combustible_ejercicio(tb,2026,array['15101505']);
 if r.total<>999999 or r.efectivo<>999999 then raise exception '0345 aislamiento B'; end if;
 if has_function_privilege('anon','public.sumar_combustible_ejercicio(uuid,integer,text[])','execute')
 or has_function_privilege('authenticated','public.sumar_combustible_ejercicio(uuid,integer,text[])','execute')
 or not has_function_privilege('service_role','public.sumar_combustible_ejercicio(uuid,integer,text[])','execute')
 then raise exception '0345 permisos'; end if;
end $$;
rollback;
\echo '0345_combustible_rep_por_definir: PASS'
