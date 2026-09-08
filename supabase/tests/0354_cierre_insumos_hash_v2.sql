-- 0354 — DAT-B1 (auditoría 28): cierre_insumos_hash excluye forma_pago
-- efectiva='99' del combustible en efectivo, igual que sumar_combustible_ejercicio
-- (0345); insumos_hash_version sube a 2 y guardar_liquidacion_tx exige esa
-- versión desde esta migración.
begin;

insert into tenant (id, nombre, rfc, config)
values ('00000000-0354-4000-8000-000000000001', '0354 Test', 'AAA010101AAA', '{}'::jsonb);
insert into app_user (id, tenant_id, email, rol)
values ('00000000-0354-4000-8000-000000000002', '00000000-0354-4000-8000-000000000001', '0354@test.local', 'flota_admin');
insert into operador (id, tenant_id, nombre, telefono)
values ('00000000-0354-4000-8000-000000000003', '00000000-0354-4000-8000-000000000001', 'Op 0354', '5215500000354');

-- Viaje A: el REP conserva FormaDePagoP='99' (mal timbrado, sin corregir).
insert into viaje (id, tenant_id, operador_id, folio, origen, destino, anticipo, fecha_inicio, estatus)
values ('00000000-0354-4000-8000-00000000000a', '00000000-0354-4000-8000-000000000001', '00000000-0354-4000-8000-000000000003', '0354-A', 'A', 'B', 500, '2026-03-01', 'liquidado');
insert into gasto (id, tenant_id, viaje_id, concepto, monto, fecha, forma_pago, pagado_en, pagado_forma)
values ('00000000-0354-4000-8000-0000000000a1', '00000000-0354-4000-8000-000000000001', '00000000-0354-4000-8000-00000000000a', 'diesel', 500, '2026-03-01', '99', '2026-03-02', '99');

-- Viaje B: MISMOS montos/fechas, pero el REP sí declara transferencia ('03').
insert into viaje (id, tenant_id, operador_id, folio, origen, destino, anticipo, fecha_inicio, estatus)
values ('00000000-0354-4000-8000-00000000000b', '00000000-0354-4000-8000-000000000001', '00000000-0354-4000-8000-000000000003', '0354-B', 'A', 'B', 500, '2026-03-01', 'liquidado');
insert into gasto (id, tenant_id, viaje_id, concepto, monto, fecha, forma_pago, pagado_en, pagado_forma)
values ('00000000-0354-4000-8000-0000000000b1', '00000000-0354-4000-8000-000000000001', '00000000-0354-4000-8000-00000000000b', 'diesel', 500, '2026-03-01', '99', '2026-03-02', '03');

do $$
declare
  snap_a jsonb;
  snap_b jsonb;
  version_2_reportada boolean := false;
  hash_distingue_99 boolean := false;
  v1_rebota boolean := false;
  v2_acepta boolean := false;
  version_persistida integer;
begin
  snap_a := public.cierre_insumos_snapshot('00000000-0354-4000-8000-000000000001'::uuid, '00000000-0354-4000-8000-00000000000a'::uuid);
  snap_b := public.cierre_insumos_snapshot('00000000-0354-4000-8000-000000000001'::uuid, '00000000-0354-4000-8000-00000000000b'::uuid);

  version_2_reportada := (snap_a->>'version')::int = 2 and (snap_b->>'version')::int = 2;

  -- El único insumo que difiere entre A y B es pagado_forma ('99' vs '03'):
  -- si el hash distingue los dos casos, la fórmula SÍ mira ese campo (no es
  -- un cambio de versión sin efecto).
  hash_distingue_99 := (snap_a->>'hash') is distinct from (snap_b->>'hash');

  begin
    perform public.guardar_liquidacion_tx(
      '00000000-0354-4000-8000-000000000001'::uuid, '00000000-0354-4000-8000-00000000000a'::uuid,
      500, 500, 0, 'cuadrada', '[]'::jsonb, 0, 0, 0, null, 0, 1,
      snap_a->>'hash', 1
    );
  exception when sqlstate 'CU007' then v1_rebota := true;
  end;

  perform public.guardar_liquidacion_tx(
    '00000000-0354-4000-8000-000000000001'::uuid, '00000000-0354-4000-8000-00000000000a'::uuid,
    500, 500, 0, 'cuadrada', '[]'::jsonb, 0, 0, 0, null, 0, 1,
    snap_a->>'hash', (snap_a->>'version')::int
  );
  v2_acepta := true;

  select insumos_hash_version into version_persistida
    from liquidacion where viaje_id = '00000000-0354-4000-8000-00000000000a';

  if not version_2_reportada then
    raise exception '0354: cierre_insumos_snapshot no reporta version=2';
  end if;
  if not hash_distingue_99 then
    raise exception '0354: el hash NO distingue pagado_forma=99 de 03 (la fórmula quedó igual)';
  end if;
  if not v1_rebota then
    raise exception '0354: guardar_liquidacion_tx aceptó version=1 (debía rebotar CU007)';
  end if;
  if not v2_acepta then
    raise exception '0354: guardar_liquidacion_tx no aceptó version=2';
  end if;
  if version_persistida is distinct from 2 then
    raise exception '0354: insumos_hash_version persistido = %, esperado 2', version_persistida;
  end if;

  raise notice '0354 OK: version_2=% distingue_99=% v1_rebota=% v2_acepta=% persistido=%',
    version_2_reportada, hash_distingue_99, v1_rebota, v2_acepta, version_persistida;
end $$;

-- El CHECK sigue aceptando version=1 para filas históricas (no se angosta
-- hacia atrás) y rechaza cualquier version fuera de {1,2}.
do $$
declare rechaza_v3 boolean := false;
begin
  begin
    insert into liquidacion (tenant_id, viaje_id, total_comprobado, total_anticipo, diferencia, estatus, insumos_hash, insumos_hash_version)
    values ('00000000-0354-4000-8000-000000000001', '00000000-0354-4000-8000-00000000000b', 500, 500, 0, 'cuadrada', repeat('a', 64), 3)
    on conflict (viaje_id) do update set insumos_hash_version = 3;
  exception when check_violation then rechaza_v3 := true;
  end;
  if not rechaza_v3 then
    raise exception '0354: el CHECK aceptó insumos_hash_version=3';
  end if;
  raise notice '0354 OK: CHECK rechaza version=3';
end $$;

rollback;
