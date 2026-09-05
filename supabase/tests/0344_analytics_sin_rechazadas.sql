\set ON_ERROR_STOP on
-- BE-2: dos flotas, todas las revisiones, corte temporal e historial intacto.
-- Sólo datos sintéticos propios y rollback; ninguna llamada de proveedor.
begin;
insert into public.tenant(id,nombre) values
 ('34400000-0000-4000-8000-000000000001','Analytics344 A'),
 ('34400000-0000-4000-8000-000000000002','Analytics344 B');
insert into public.operador(id,tenant_id,nombre,telefono) values
 ('34400000-0000-4000-8000-000000000001','34400000-0000-4000-8000-000000000001','Operador sintético A','529999903441'),
 ('34400000-0000-4000-8000-000000000002','34400000-0000-4000-8000-000000000002','Operador sintético B','529999903442');
create temporary table fixtures344(n int,tenant uuid,revision text,estatus text,monto numeric,difs jsonb,fecha timestamptz);
insert into fixtures344 values
 (1,'34400000-0000-4000-8000-000000000001','pendiente','revisar',100,'[{"tipo":"sobre_politica","monto":10}]','2026-09-01T00:00:00Z'),
 (2,'34400000-0000-4000-8000-000000000001','aprobada','cuadrada',200,'[]','2026-09-02T00:00:00Z'),
 (3,'34400000-0000-4000-8000-000000000001','ajustada','con_diferencias',300,'[{"tipo":"duplicado","monto":-30}]','2026-09-03T00:00:00Z'),
 (4,'34400000-0000-4000-8000-000000000001','rechazada','cuadrada',9000,'[{"tipo":"sobre_politica","monto":1000}]','2026-09-04T00:00:00Z'),
 (5,'34400000-0000-4000-8000-000000000001','aprobada','cuadrada',50,'[{"tipo":"duplicado","monto":5}]','2026-08-31T23:59:59Z'),
 (6,'34400000-0000-4000-8000-000000000002','aprobada','cuadrada',700,'[{"tipo":"sobre_politica","monto":70}]','2026-09-01T00:00:00Z'),
 (7,'34400000-0000-4000-8000-000000000002','rechazada','revisar',9900,'[{"tipo":"duplicado","monto":990}]','2026-09-02T00:00:00Z');
insert into public.viaje(id,tenant_id,operador_id,folio,estatus)
select ('34400000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,tenant,tenant,'A344-'||n,
 case when revision='rechazada' then 'en_cuadre' else 'liquidado' end from fixtures344;
-- Fixture de estados ya revisados: usa el contexto interno de la RPC sólo
-- al sembrar dentro de esta transacción; no se prueba aquí la autorización de revisión.
set local likida.revision_en_curso='1';
insert into public.liquidacion(id,tenant_id,viaje_id,revision,revisada_en,motivo,estatus,total_comprobado,total_anticipo,diferencias,created_at)
select ('34400000-0000-4000-8000-'||lpad((200+n)::text,12,'0'))::uuid,tenant,
 ('34400000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,revision,
 case when revision='pendiente' then null else fecha end,
 case when revision in ('rechazada','ajustada') then 'Revisión sintética' else null end,
 estatus,monto,monto,difs,fecha from fixtures344;
set local likida.revision_en_curso='';
set constraints all immediate;
create temp table historial344 as select id,md5(to_jsonb(l)::text) huella from public.liquidacion l where tenant_id in
 ('34400000-0000-4000-8000-000000000001','34400000-0000-4000-8000-000000000002');
set local role service_role;
do $$declare k jsonb; d jsonb; begin
 k:=public.kpis_liquidacion_tenant('34400000-0000-4000-8000-000000000001','2026-09-01T00:00:00Z');
 if k <> '{"viajesLiquidados":3,"montoComprobado":600,"diferenciaDetectada":40,"conDiferencias":1,"porRevisar":1,"tasaCuadre":33}'::jsonb then
  raise exception '0344 KPI A incluye rechazo, altera pendientes o cruza corte/tenant: %',k;end if;
 k:=public.kpis_liquidacion_tenant('34400000-0000-4000-8000-000000000001');
 if k <> '{"viajesLiquidados":4,"montoComprobado":650,"diferenciaDetectada":45,"conDiferencias":1,"porRevisar":1,"tasaCuadre":50}'::jsonb then
  raise exception '0344 KPI histórico A incorrecto: %',k;end if;
 k:=public.kpis_liquidacion_tenant('34400000-0000-4000-8000-000000000002');
 if k <> '{"viajesLiquidados":1,"montoComprobado":700,"diferenciaDetectada":70,"conDiferencias":0,"porRevisar":0,"tasaCuadre":100}'::jsonb then
  raise exception '0344 KPI B incorrecto: %',k;end if;
 d:=public.dinero_observado_por_tipo_tenant('34400000-0000-4000-8000-000000000001');
 if d <> '[{"tipo":"duplicado","monto":35,"n":2},{"tipo":"sobre_politica","monto":10,"n":1}]'::jsonb then
  raise exception '0344 dona A incluye rechazo o cruza tenant: %',d;end if;
 d:=public.dinero_observado_por_tipo_tenant('34400000-0000-4000-8000-000000000002');
 if d <> '[{"tipo":"sobre_politica","monto":70,"n":1}]'::jsonb then raise exception '0344 dona B incorrecta: %',d;end if;
 k:=public.kpis_liquidacion_tenant('34400000-0000-4000-8000-000000000001','2026-09-04T00:00:00Z');
 if k <> '{"viajesLiquidados":0,"montoComprobado":0,"diferenciaDetectada":0,"conDiferencias":0,"porRevisar":0,"tasaCuadre":0}'::jsonb then
  raise exception '0344 ventana con sólo rechazada no queda vacía: %',k;end if;
 -- Contrato: no confundir resultados operativos vigentes con importes fiscales firmados.
 if (public.kpis_liquidacion_tenant('34400000-0000-4000-8000-000000000099')->>'viajesLiquidados')::int<>0
 or public.dinero_observado_por_tipo_tenant('34400000-0000-4000-8000-000000000099')<>'[]'::jsonb then raise exception '0344 flota vacía no queda vacía';end if;
end$$;
reset role;
do $$begin
 if exists(select 1 from historial344 h join public.liquidacion l using(id) where h.huella<>md5(to_jsonb(l)::text)) then raise exception '0344 cambió historial';end if;
 if (select count(*) from public.liquidacion where tenant_id='34400000-0000-4000-8000-000000000001' and revision='rechazada' and total_comprobado=9000)<>1 then raise exception '0344 rechazo dejó de estar auditable';end if;
 if has_function_privilege('anon','public.kpis_liquidacion_tenant(uuid,timestamptz)','execute')
 or has_function_privilege('authenticated','public.kpis_liquidacion_tenant(uuid,timestamptz)','execute')
 or has_function_privilege('anon','public.dinero_observado_por_tipo_tenant(uuid)','execute')
 or has_function_privilege('authenticated','public.dinero_observado_por_tipo_tenant(uuid)','execute') then raise exception '0344 RPC expuesto';end if;
end$$;
rollback;
\echo '0344_analytics_sin_rechazadas: PASS'
