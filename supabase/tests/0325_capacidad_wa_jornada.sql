-- Verificación funcional/performance de 0325. Sólo Postgres local o staging.
-- EXPLAIN ANALYZE ejecuta la función; toda la prueba revierte al final.
begin;

-- Suite destructiva sólo dentro de ROLLBACK: aislar las colas evita que datos
-- previos del Postgres de prueba alteren conteos, orden o fairness.
delete from public.wa_evento_pendiente;
delete from public.jornada_derivacion_trabajo;

do $$
begin
  if to_regprocedure('public.reclamar_jornadas_por_derivar(timestamptz,timestamptz,integer,text,integer)') is not null then
    raise exception 'el overload 0319 que mezcla sync+claim sigue expuesto';
  end if;
end;
$$;

-- ── WA: 13k pendientes distintos deben listar muy por debajo de 1 segundo ─
delete from public.wa_evento_pendiente where id like '0325-%';
insert into public.wa_evento_pendiente(id, evento, recibido_en)
select '0325-bench-' || lpad(g::text, 5, '0'),
       jsonb_build_object('from', '521' || lpad(g::text, 10, '0'),
                          'type', 'text', 'timestampMs', 1798761600000 + g),
       '2027-01-01 00:00:00+00'::timestamptz + make_interval(secs => g / 1000.0)
  from generate_series(1, 13000) g;
analyze public.wa_evento_pendiente;

explain (analyze, buffers, timing, summary)
select * from public.listar_wa_pendientes(40);

do $$
declare v_inicio timestamptz; v_ms numeric; v_n integer;
begin
  v_inicio := clock_timestamp();
  select count(*) into v_n from public.listar_wa_pendientes(40);
  v_ms := extract(epoch from clock_timestamp() - v_inicio) * 1000;
  raise notice '0325 WA 13k: % filas en % ms', v_n, round(v_ms, 3);
  if v_n <> 40 then raise exception 'WA 13k devolvió % de 40', v_n; end if;
  if v_ms >= 1000 then raise exception 'WA 13k excedió 1s: % ms', v_ms; end if;
end;
$$;

-- ── WA: round-robin conserva el fajo de A sin tapar a los minoritarios ────
delete from public.wa_evento_pendiente where id like '0325-%';
insert into public.wa_evento_pendiente(id, evento, recibido_en)
select '0325-a-' || lpad(g::text, 3, '0'),
       jsonb_build_object('from', 'A', 'type', 'text', 'timestampMs', 1800000000000 + g),
       '2027-01-15 00:00:00+00'::timestamptz + make_interval(secs => g / 1000.0)
  from generate_series(1, 100) g;
insert into public.wa_evento_pendiente(id, evento, recibido_en)
select '0325-' || x, jsonb_build_object('from', x, 'type', 'image', 'timestampMs', 1800000000200),
       '2027-01-15 00:00:00.200+00'::timestamptz
  from unnest(array['B','C','D','E','F']) x;

do $$
declare v_n integer; v_distintos integer; v_otros integer;
begin
  select count(*), count(distinct remitente), count(*) filter (where remitente <> 'A')
    into v_n, v_distintos, v_otros
    from public.listar_wa_pendientes(40);
  if (v_n, v_distintos, v_otros) is distinct from (40, 6, 5) then
    raise exception 'fairness WA falló: total %, remitentes %, otros %', v_n, v_distintos, v_otros;
  end if;
  if exists (
    select 1 from unnest(array['B','C','D','E','F']) esperado
     where not exists (select 1 from public.listar_wa_pendientes(40) p where p.remitente = esperado)
  ) then raise exception 'WA omitió un remitente minoritario'; end if;
  if (select count(*) from public.listar_wa_pendientes(40) where remitente = 'A') <> 35 then
    raise exception 'WA rompió el fajo de fotos de A';
  end if;
  if exists (
    select 1 from public.reclamar_wa_pendiente('0325-a-002', 0, 'fuera-de-orden', 180)
  ) then raise exception 'WA permitió adelantar A2 antes de A1'; end if;
end;
$$;

-- El drenador recibe varias fotos de A en el lote, pero sólo puede reclamar
-- la siguiente después de sellar la anterior. A1→A2→A3 debe avanzar sin salto.
do $$
declare i integer; v_listado text; v_claim record;
begin
  for i in 1..3 loop
    select p.id into v_listado
      from public.listar_wa_pendientes(40) p
     where p.remitente = 'A'
     limit 1;
    if v_listado <> '0325-a-' || lpad(i::text, 3, '0') then
      raise exception 'secuencia WA esperaba A%, obtuvo %', i, v_listado;
    end if;
    select * into v_claim
      from public.reclamar_wa_pendiente(v_listado, 0, '0325-secuencial', 180);
    if v_claim.claim_token is null then raise exception 'no reclamó A%', i; end if;
    if not public.completar_wa_pendiente(v_listado, v_claim.claim_token, '0325-secuencial') then
      raise exception 'no selló A%', i;
    end if;
  end loop;
end;
$$;

-- ── Jornada: bucket IANA distinto alrededor de medianoche ─────────────────
do $$
begin
  begin
    insert into public.tenant(id, nombre, zona_horaria)
    values ('32500000-0000-4000-8000-000000000099', 'Zona inválida', 'GMT-06-inventada');
    raise exception 'aceptó zona no IANA';
  exception when sqlstate '22023' then null;
  end;
end;
$$;

insert into public.tenant(id, nombre, zona_horaria) values
  ('32500000-0000-4000-8000-000000000001', 'Tijuana 0325', 'America/Tijuana'),
  ('32500000-0000-4000-8000-000000000002', 'Sonora 0325', 'America/Hermosillo'),
  ('32500000-0000-4000-8000-000000000003', 'Rebucket 0325', 'America/Mexico_City');
insert into public.operador(id, tenant_id, nombre, telefono, aviso_privacidad_en) values
  ('32510000-0000-4000-8000-000000000001', '32500000-0000-4000-8000-000000000001', 'Op Tijuana', '523250000001', '2026-01-01'),
  ('32510000-0000-4000-8000-000000000002', '32500000-0000-4000-8000-000000000002', 'Op Sonora', '523250000002', '2026-01-01'),
  ('32510000-0000-4000-8000-000000000003', '32500000-0000-4000-8000-000000000003', 'Op Rebucket', '523250000003', '2026-01-01');
insert into public.viaje(id, tenant_id, operador_id, avisado_en, aceptado_en) values
  ('32520000-0000-4000-8000-000000000001', '32500000-0000-4000-8000-000000000001', '32510000-0000-4000-8000-000000000001', '2026-01-01 07:29+00', '2026-01-01 07:30+00'),
  ('32520000-0000-4000-8000-000000000002', '32500000-0000-4000-8000-000000000002', '32510000-0000-4000-8000-000000000002', '2026-01-01 07:29+00', '2026-01-01 07:30+00'),
  ('32520000-0000-4000-8000-000000000003', '32500000-0000-4000-8000-000000000003', '32510000-0000-4000-8000-000000000003', '2026-01-01 07:29+00', '2026-01-01 07:30+00');

select public.sincronizar_jornadas_por_derivar('2026-01-01 07:30+00', 1);

-- El tenant 3 nació con el default histórico: cambiarlo antes de crear un
-- expediente borra la cola reconstruible y evita conservar dos buckets.
update public.tenant set zona_horaria = 'America/Tijuana'
 where id = '32500000-0000-4000-8000-000000000003';
select public.sincronizar_jornadas_por_derivar('2026-01-01 07:30+00', 1);

do $$
declare v_tijuana date; v_sonora date;
begin
  select dia into v_tijuana from public.jornada_derivacion_trabajo
   where tenant_id = '32500000-0000-4000-8000-000000000001';
  select dia into v_sonora from public.jornada_derivacion_trabajo
   where tenant_id = '32500000-0000-4000-8000-000000000002';
  if v_tijuana <> date '2025-12-31' or v_sonora <> date '2026-01-01' then
    raise exception 'bucket IANA incorrecto: Tijuana %, Sonora %', v_tijuana, v_sonora;
  end if;
  if (select count(*) from public.jornada_derivacion_trabajo
       where tenant_id = '32500000-0000-4000-8000-000000000003') <> 1
     or (select dia from public.jornada_derivacion_trabajo
          where tenant_id = '32500000-0000-4000-8000-000000000003') <> date '2025-12-31' then
    raise exception 'rebucket de cola dejó duplicado o día viejo';
  end if;
end;
$$;

create temporary table audit_claim_0325 as
select * from public.reclamar_jornadas_por_derivar(10, '0325-worker', 180)
 where tenant_id::text like '325%';

do $$
declare v_n integer; v_zonas integer; v_proc integer;
begin
  select count(*), count(distinct zona_horaria) into v_n, v_zonas from audit_claim_0325;
  if v_n <> 3 or v_zonas <> 2 then raise exception 'claim IANA obtuvo % filas/% zonas', v_n, v_zonas; end if;
  select count(*) into v_proc from public.procesar_jornadas_derivadas(
    '0325-worker', (select array_agg(claim_token) from audit_claim_0325), 3600, 300
  ) p where p.exito;
  if v_proc <> 3 then raise exception 'proceso por lote confirmó % de 3', v_proc; end if;
end;
$$;

-- Con expediente ya creado, mover zona queda fail-closed: requiere una
-- reconciliación auditada, no una reescritura silenciosa de historia.
do $$
begin
  begin
    update public.tenant set zona_horaria = 'America/Hermosillo'
     where id = '32500000-0000-4000-8000-000000000003';
    raise exception 'cambió zona con expediente laboral existente';
  exception when sqlstate '55000' then null;
  end;
end;
$$;

-- ── Lote real de 50: tres asientos potenciales por operador ───────────────
insert into public.tenant(id, nombre) values
  ('32500000-0000-4000-8000-000000000050', 'Batch 50 0325');
insert into public.operador(id, tenant_id, nombre, telefono, aviso_privacidad_en)
select md5('0325-batch-op-' || g)::uuid,
       '32500000-0000-4000-8000-000000000050', 'Operador batch ' || g,
       '523255' || lpad(g::text, 6, '0'), '2026-09-02 00:00+00'
  from generate_series(1, 50) g;
insert into public.unidad(id, tenant_id, numero_economico)
select md5('0325-batch-unidad-' || g)::uuid,
       '32500000-0000-4000-8000-000000000050', 'B-0325-' || g
  from generate_series(1, 50) g;
insert into public.viaje(id, tenant_id, operador_id, unidad_id, avisado_en, aceptado_en)
select md5('0325-batch-viaje-' || g)::uuid,
       '32500000-0000-4000-8000-000000000050',
       md5('0325-batch-op-' || g)::uuid, md5('0325-batch-unidad-' || g)::uuid,
       '2026-09-02 11:59+00', '2026-09-02 12:00+00'::timestamptz + make_interval(secs => g)
  from generate_series(1, 50) g;
insert into public.posicion(tenant_id, unidad_id, lat, lng, medida_en, proveedor)
select '32500000-0000-4000-8000-000000000050',
       md5('0325-batch-unidad-' || g)::uuid, 20.0, -89.0, momento, '0325-test'
  from generate_series(1, 50) g
 cross join lateral unnest(array[
   '2026-09-02 11:00+00'::timestamptz + make_interval(secs => g),
   '2026-09-02 23:00+00'::timestamptz + make_interval(secs => g)
 ]) momento;

select public.sincronizar_jornadas_por_derivar('2026-09-02 18:00+00', 1);
create temporary table audit_batch_0325 as
select * from public.reclamar_jornadas_por_derivar(50, '0325-batch-50', 180)
 where tenant_id = '32500000-0000-4000-8000-000000000050';

do $$
declare v_inicio timestamptz; v_ms numeric; v_n integer; v_lease numeric;
begin
  select extract(epoch from min(j.lease_expires_at - clock_timestamp()))
    into v_lease
    from public.jornada_derivacion_trabajo j
   where j.claim_owner = '0325-batch-50';
  v_inicio := clock_timestamp();
  select count(*) into v_n
    from public.procesar_jornadas_derivadas(
      '0325-batch-50', (select array_agg(claim_token) from audit_batch_0325), 3600, 300
    ) p where p.exito;
  v_ms := extract(epoch from clock_timestamp() - v_inicio) * 1000;
  raise notice '0325 jornada batch=50: % confirmados en % ms; lease inicial % s',
    v_n, round(v_ms, 3), round(v_lease, 3);
  if v_n <> 50 then raise exception 'batch confirmó % de 50', v_n; end if;
  if v_ms >= 8000 then raise exception 'batch 50 excedió acotada(8s): % ms', v_ms; end if;
  if v_lease < 170 then raise exception 'batch empezó sin margen de lease: % s', v_lease; end if;
end;
$$;

rollback;
