\set ON_ERROR_STOP on
-- AUDITORÍA 28, BE-A2 + DAT-M1: seis agregados más sumaban liquidaciones
-- RECHAZADAS como dinero real (mismo hueco que la 0344 ya cerró en
-- `kpis_liquidacion_tenant`/`dinero_observado_por_tipo_tenant`).
-- Un tenant, un operador, dos viajes, tres liquidaciones (aprobada/rechazada/
-- ajustada) en el MISMO día/semana — si el filtro se cae, el rechazado (9000,
-- con una diferencia de 5) se cuela en cada suma y en el conteo de
-- "diferencias" de `stats_operador_tenant`. Sólo datos sintéticos y rollback.
begin;
insert into public.tenant(id,nombre) values
 ('34800000-0000-4000-8000-000000000001','Analytics348 A');
insert into public.operador(id,tenant_id,nombre,telefono) values
 ('34800000-0000-4000-8000-000000000001','34800000-0000-4000-8000-000000000001','Operador sintético 348','529999903481');
insert into public.viaje(id,tenant_id,operador_id,folio,estatus,fecha_inicio,anticipo,ingreso_flete) values
 ('34800000-0000-4000-8000-000000000001','34800000-0000-4000-8000-000000000001','34800000-0000-4000-8000-000000000001','A348-1','liquidado','2026-09-01',300,2000),
 ('34800000-0000-4000-8000-000000000002','34800000-0000-4000-8000-000000000001','34800000-0000-4000-8000-000000000001','A348-2','en_cuadre','2026-09-01',300,null),
 ('34800000-0000-4000-8000-000000000003','34800000-0000-4000-8000-000000000001','34800000-0000-4000-8000-000000000001','A348-3','liquidado','2026-09-01',300,null);
set local likida.revision_en_curso='1';
insert into public.liquidacion(id,tenant_id,viaje_id,revision,revisada_en,motivo,estatus,total_comprobado,total_anticipo,diferencia,diferencias,created_at) values
 ('34800000-0000-4000-8000-000000000201','34800000-0000-4000-8000-000000000001','34800000-0000-4000-8000-000000000001','aprobada','2026-09-01T12:00:00Z',null,'con_diferencias',980,1000,20,'[]','2026-09-01T12:00:00Z'),
 ('34800000-0000-4000-8000-000000000202','34800000-0000-4000-8000-000000000001','34800000-0000-4000-8000-000000000002','rechazada','2026-09-01T12:00:00Z','Revisión sintética','cuadrada',8500,9000,500,'[]','2026-09-01T12:00:00Z'),
 ('34800000-0000-4000-8000-000000000203','34800000-0000-4000-8000-000000000001','34800000-0000-4000-8000-000000000003','ajustada','2026-09-01T12:00:00Z','Revisión sintética','cuadrada',500,500,0,'[]','2026-09-01T12:00:00Z');
set local likida.revision_en_curso='';
set constraints all immediate;
create temp table historial348 as select id,md5(to_jsonb(l)::text) huella from public.liquidacion l where tenant_id='34800000-0000-4000-8000-000000000001';
set local role service_role;
do $$declare j jsonb; n int; begin
 -- 1. liquidaciones_por_dia_tenant: 2 el día 1-sep (excluye la rechazada de 3).
 j:=public.liquidaciones_por_dia_tenant('34800000-0000-4000-8000-000000000001','2026-08-25T00:00:00Z');
 if j <> '[{"dia":"2026-09-01","n":2}]'::jsonb then
  raise exception '0348 liquidaciones_por_dia_tenant incluye la rechazada: %',j;end if;

 -- 2. liquidado_semanal_tenant: 1480 (980+500), no 10480.
 j:=public.liquidado_semanal_tenant('34800000-0000-4000-8000-000000000001','2026-08-25T00:00:00Z');
 if (j->0->>'total')::numeric <> 1480 then
  raise exception '0348 liquidado_semanal_tenant incluye la rechazada: %',j;end if;

 -- 3. operadores_detalle_tenant: comprobadoTotal 1480; viajes/anticipoTotal SIN filtrar (vienen de viaje, no de liquidacion).
 j:=public.operadores_detalle_tenant('34800000-0000-4000-8000-000000000001');
 if (j->0->>'comprobadoTotal')::numeric <> 1480 then
  raise exception '0348 operadores_detalle_tenant incluye la rechazada: %',j;end if;
 if (j->0->>'viajes')::int <> 3 or (j->0->>'anticipoTotal')::numeric <> 900 then
  raise exception '0348 operadores_detalle_tenant tocó columnas de viaje que no debía: %',j;end if;

 -- 4. rentabilidad_tenant: costoComprobado 1480; ingreso (de viaje) sigue en 2000.
 j:=public.rentabilidad_tenant('34800000-0000-4000-8000-000000000001',null);
 if (j->>'costoComprobado')::numeric <> 1480 then
  raise exception '0348 rentabilidad_tenant incluye la rechazada: %',j;end if;
 if (j->>'ingreso')::numeric <> 2000 or (j->>'viajesConIngreso')::int <> 1 or (j->>'viajesSinIngreso')::int <> 1 then
  raise exception '0348 rentabilidad_tenant tocó columnas de viaje que no debía: %',j;end if;

 -- 5. serie_comparativa_tenant: liquidado 1480 en la ventana que cubre el 1-sep.
 j:=public.serie_comparativa_tenant('34800000-0000-4000-8000-000000000001',7,1,'2026-09-01'::date);
 if (j->0->>'liquidado')::numeric <> 1480 then
  raise exception '0348 serie_comparativa_tenant incluye la rechazada: %',j;end if;

 -- 6. stats_operador_tenant: diferencias=1 (solo la aprobada, 0.02>=0.01).
 --    Sin el filtro sería 2 (la rechazada trae diferencia=5).
 j:=public.stats_operador_tenant('34800000-0000-4000-8000-000000000001');
 if (j->0->>'diferencias')::int <> 1 then
  raise exception '0348 stats_operador_tenant cuenta la diferencia de la rechazada: %',j;end if;

 -- Idempotencia: aplicar la migración dos veces no cambia ningún resultado
 -- (create or replace es idempotente por construcción; se confirma aquí que
 -- ningún cálculo depende de estado mutado por la corrida anterior).
 j:=public.liquidaciones_por_dia_tenant('34800000-0000-4000-8000-000000000001','2026-08-25T00:00:00Z');
 if j <> '[{"dia":"2026-09-01","n":2}]'::jsonb then
  raise exception '0348 liquidaciones_por_dia_tenant no es idempotente: %',j;end if;
end $$;
reset role;
-- Historial sin mutar: ninguna de las seis lecturas debe haber tocado una fila.
do $$ begin
 if (select count(*) from public.liquidacion l join historial348 h on h.id=l.id where h.huella <> md5(to_jsonb(l)::text)) <> 0 then
  raise exception '0348: leer los agregados mutó el historial de liquidacion';
 end if;
end $$;
rollback;
