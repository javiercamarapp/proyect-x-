-- Verificación funcional/performance de 0325. Sólo Postgres local o staging.
-- EXPLAIN ANALYZE ejecuta la función; toda la prueba revierte al final.
begin;

-- Suite destructiva sólo dentro de ROLLBACK: aislar las colas evita que datos
-- previos del Postgres de prueba alteren conteos, orden o fairness.
delete from public.tenant where id = '32590000-0000-4000-8000-000000000001';
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

-- ── Jornada: NULL/cambio de día/lease y cola envejecida ───────────────
-- Reconciliar fuentes mutadas, incluso fuera de la ventana del barrido.
insert into public.tenant(id, nombre, zona_horaria) values
  ('32500000-0000-4000-8000-000000000060', 'Reconciliación 0325', 'America/Mexico_City');
insert into public.operador(id, tenant_id, nombre, telefono, aviso_privacidad_en) values
  ('32510000-0000-4000-8000-000000000061', '32500000-0000-4000-8000-000000000060', 'Op NULL', '523250000061', '2026-08-01'),
  ('32510000-0000-4000-8000-000000000062', '32500000-0000-4000-8000-000000000060', 'Op movido', '523250000062', '2026-08-01'),
  ('32510000-0000-4000-8000-000000000063', '32500000-0000-4000-8000-000000000060', 'Op lease', '523250000063', '2026-08-01'),
  ('32510000-0000-4000-8000-000000000064', '32500000-0000-4000-8000-000000000060', 'Op viejo obsoleto', '523250000064', '2026-08-01'),
  ('32510000-0000-4000-8000-000000000065', '32500000-0000-4000-8000-000000000060', 'Op backlog válido', '523250000065', '2026-08-01');
insert into public.viaje(id, tenant_id, operador_id, avisado_en, aceptado_en) values
  ('32520000-0000-4000-8000-000000000061', '32500000-0000-4000-8000-000000000060', '32510000-0000-4000-8000-000000000061', '2026-09-02 11:59+00', '2026-09-02 12:00+00'),
  ('32520000-0000-4000-8000-000000000062', '32500000-0000-4000-8000-000000000060', '32510000-0000-4000-8000-000000000062', '2026-09-02 12:59+00', '2026-09-02 13:00+00'),
  ('32520000-0000-4000-8000-000000000063', '32500000-0000-4000-8000-000000000060', '32510000-0000-4000-8000-000000000063', '2026-09-03 13:59+00', '2026-09-03 14:00+00'),
  ('32520000-0000-4000-8000-000000000064', '32500000-0000-4000-8000-000000000060', '32510000-0000-4000-8000-000000000064', '2026-08-19 11:59+00', '2026-08-19 12:00+00'),
  ('32520000-0000-4000-8000-000000000065', '32500000-0000-4000-8000-000000000060', '32510000-0000-4000-8000-000000000065', '2026-08-19 12:59+00', '2026-08-19 13:00+00');

-- Primero materializa dos trabajos fuera de la futura ventana y luego los
-- recientes. El backlog viejo válido debe sobrevivir; el viejo sin fuente no.
select public.sincronizar_jornadas_por_derivar('2026-08-19 18:00+00', 1);
select public.sincronizar_jornadas_por_derivar('2026-09-03 18:00+00', 2);

update public.jornada_derivacion_trabajo
   set siguiente_intento_en = 'infinity'
 where tenant_id = '32500000-0000-4000-8000-000000000060'
   and operador_id <> '32510000-0000-4000-8000-000000000063';
create temporary table audit_claim_obsoleto_0325 as
select * from public.reclamar_jornadas_por_derivar(1, '0325-obsoleto-vivo', 180);

do $$
begin
  if (select count(*) from audit_claim_obsoleto_0325
       where operador_id = '32510000-0000-4000-8000-000000000063') <> 1 then
    raise exception 'no cercó el caso de lease vivo esperado';
  end if;
end;
$$;

-- Cambios de fuente: uno desaparece, otro se mueve de día, el tercero cambia
-- mientras su fila tiene lease vivo, y el cuarto desaparece fuera de p_dias.
update public.viaje set aceptado_en = null
 where id in ('32520000-0000-4000-8000-000000000061',
              '32520000-0000-4000-8000-000000000063',
              '32520000-0000-4000-8000-000000000064');
update public.viaje set aceptado_en = '2026-09-03 13:00+00'
 where id = '32520000-0000-4000-8000-000000000062';

select public.sincronizar_jornadas_por_derivar('2026-09-03 18:00+00', 2);

do $$
declare v_token uuid; v_exito boolean; v_error text;
begin
  if exists (select 1 from public.jornada_derivacion_trabajo
              where operador_id in ('32510000-0000-4000-8000-000000000061',
                                    '32510000-0000-4000-8000-000000000064')) then
    raise exception 'sync conservó fuente NULL, incluso fuera de p_dias';
  end if;
  if (select count(*) from public.jornada_derivacion_trabajo
       where operador_id = '32510000-0000-4000-8000-000000000062') <> 1
     or (select dia from public.jornada_derivacion_trabajo
          where operador_id = '32510000-0000-4000-8000-000000000062') <> date '2026-09-03' then
    raise exception 'cambio de día dejó trabajo viejo/duplicado';
  end if;
  if not exists (select 1 from public.jornada_derivacion_trabajo
                  where operador_id = '32510000-0000-4000-8000-000000000065') then
    raise exception 'purga perdió backlog viejo pero válido';
  end if;

  select claim_token into v_token from audit_claim_obsoleto_0325;
  if not exists (select 1 from public.jornada_derivacion_trabajo
                  where operador_id = '32510000-0000-4000-8000-000000000063'
                    and claim_token = v_token) then
    raise exception 'sync tocó lease vivo ajeno';
  end if;
  select p.exito, p.error into v_exito, v_error
    from public.procesar_jornadas_derivadas(
      '0325-obsoleto-vivo', array[v_token], 3600, 0
    ) p;
  if v_exito is not true or v_error is not null then
    raise exception 'procesador no reconcilió fuente mutada: % / %', v_exito, v_error;
  end if;
  if exists (select 1 from public.jornada_dia
              where operador_id = '32510000-0000-4000-8000-000000000063') then
    raise exception 'fuente mutada bajo lease produjo jornada falsa';
  end if;
end;
$$;

select public.sincronizar_jornadas_por_derivar('2026-09-03 18:00+00', 2);
do $$
begin
  if exists (select 1 from public.jornada_derivacion_trabajo
              where operador_id = '32510000-0000-4000-8000-000000000063') then
    raise exception 'trabajo obsoleto no se recuperó al liberar el lease';
  end if;
end;
$$;

-- Retención: 50k trabajos exitosos no crecen mes tras mes. Cinco lotes
-- acotados los drenan; la fila vigente reconstruida es la única superviviente.
insert into public.tenant(id, nombre, zona_horaria) values
  ('32500000-0000-4000-8000-000000000070', 'Retención 50k 0325', 'America/Mexico_City');
insert into public.operador(id, tenant_id, nombre, telefono, aviso_privacidad_en) values
  ('32510000-0000-4000-8000-000000000070', '32500000-0000-4000-8000-000000000070', 'Op retención', '523250000070', '2026-08-01');
insert into public.viaje(id, tenant_id, operador_id, avisado_en, aceptado_en) values
  ('32520000-0000-4000-8000-000000000070', '32500000-0000-4000-8000-000000000070', '32510000-0000-4000-8000-000000000070', '2026-09-03 11:59+00', '2026-09-03 12:00+00');
insert into public.jornada_derivacion_trabajo (
  tenant_id, operador_id, dia, viaje_id, aceptado_en, viajes_version,
  input_version, processed_version, procesado_al_menos_una_vez
)
select '32500000-0000-4000-8000-000000000070',
       '32510000-0000-4000-8000-000000000070',
       date '1800-01-01' + g,
       '32520000-0000-4000-8000-000000000070',
       ('1800-01-01 12:00+00'::timestamptz + make_interval(days => g)),
       'vieja-' || g, 'vieja-' || g, 'vieja-' || g, true
  from generate_series(0, 49999) g;

do $$
declare i integer; v_inicio timestamptz; v_ms numeric; v_restantes integer;
begin
  v_inicio := clock_timestamp();
  for i in 1..5 loop
    perform public.sincronizar_jornadas_por_derivar('2026-09-03 18:00+00', 1);
  end loop;
  v_ms := extract(epoch from clock_timestamp() - v_inicio) * 1000;
  select count(*) into v_restantes
    from public.jornada_derivacion_trabajo
   where tenant_id = '32500000-0000-4000-8000-000000000070';
  raise notice '0325 retención 50k: % filas restantes en % ms', v_restantes, round(v_ms, 3);
  if v_restantes <> 1 then
    raise exception 'retención 50k dejó % filas (esperada sólo la vigente)', v_restantes;
  end if;
  if v_ms >= 10000 then raise exception 'purga 50k excedió 10s: % ms', v_ms; end if;
end;
$$;

-- ── Lote real de 50: tres asientos potenciales por operador ──────────────
delete from public.jornada_derivacion_trabajo;
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

-- ── RED→GREEN: reconciliación post-éxito, reversible y auditable ────
-- Cinco expedientes ya derivados cambian después: la historia automática se
-- anula, nunca se borra; cualquier marca humana permanece viva.
delete from public.jornada_derivacion_trabajo;
delete from public.tenant where id in (
  '32500000-0000-4000-8000-000000000001',
  '32500000-0000-4000-8000-000000000002',
  '32500000-0000-4000-8000-000000000003',
  '32500000-0000-4000-8000-000000000050',
  '32500000-0000-4000-8000-000000000060',
  '32500000-0000-4000-8000-000000000070'
);
insert into public.tenant(id, nombre, zona_horaria) values
  ('32500000-0000-4000-8000-000000000080', 'Reconciliación post-éxito 0325', 'America/Mexico_City');
insert into public.operador(id, tenant_id, nombre, telefono, aviso_privacidad_en) values
  ('32510000-0000-4000-8000-000000000081', '32500000-0000-4000-8000-000000000080', 'Post NULL', '523250000081', '2026-08-01'),
  ('32510000-0000-4000-8000-000000000082', '32500000-0000-4000-8000-000000000080', 'Post día', '523250000082', '2026-08-01'),
  ('32510000-0000-4000-8000-000000000083', '32500000-0000-4000-8000-000000000080', 'Post tarde', '523250000083', '2026-08-01'),
  ('32510000-0000-4000-8000-000000000084', '32500000-0000-4000-8000-000000000080', 'Post GPS', '523250000084', '2026-08-01'),
  ('32510000-0000-4000-8000-000000000085', '32500000-0000-4000-8000-000000000080', 'Post manual', '523250000085', '2026-08-01');
insert into public.unidad(id, tenant_id, numero_economico) values
  ('32530000-0000-4000-8000-000000000091', '32500000-0000-4000-8000-000000000080', 'REC-A'),
  ('32530000-0000-4000-8000-000000000092', '32500000-0000-4000-8000-000000000080', 'REC-B'),
  ('32530000-0000-4000-8000-000000000093', '32500000-0000-4000-8000-000000000080', 'REC-M');
insert into public.viaje(id, tenant_id, operador_id, unidad_id, avisado_en, aceptado_en, estatus) values
  ('32520000-0000-4000-8000-000000000081', '32500000-0000-4000-8000-000000000080', '32510000-0000-4000-8000-000000000081', null, '2026-09-02 11:59+00', '2026-09-02 12:00+00', 'abierto'),
  ('32520000-0000-4000-8000-000000000082', '32500000-0000-4000-8000-000000000080', '32510000-0000-4000-8000-000000000082', null, '2026-09-02 12:59+00', '2026-09-02 13:00+00', 'abierto'),
  ('32520000-0000-4000-8000-000000000083', '32500000-0000-4000-8000-000000000080', '32510000-0000-4000-8000-000000000083', null, '2026-09-02 13:59+00', '2026-09-02 14:00+00', 'abierto'),
  ('32520000-0000-4000-8000-000000000084', '32500000-0000-4000-8000-000000000080', '32510000-0000-4000-8000-000000000084', '32530000-0000-4000-8000-000000000091', '2026-09-02 14:59+00', '2026-09-02 15:00+00', 'liquidado'),
  ('32520000-0000-4000-8000-000000000085', '32500000-0000-4000-8000-000000000080', '32510000-0000-4000-8000-000000000084', '32530000-0000-4000-8000-000000000092', '2026-09-02 15:59+00', '2026-09-02 16:00+00', 'abierto'),
  ('32520000-0000-4000-8000-000000000086', '32500000-0000-4000-8000-000000000080', '32510000-0000-4000-8000-000000000085', '32530000-0000-4000-8000-000000000093', '2026-09-02 16:59+00', '2026-09-02 17:00+00', 'abierto');
insert into public.posicion(tenant_id, unidad_id, lat, lng, medida_en, proveedor) values
  ('32500000-0000-4000-8000-000000000080', '32530000-0000-4000-8000-000000000091', 20, -89, '2026-09-02 08:00+00', '0325-reconcile'),
  ('32500000-0000-4000-8000-000000000080', '32530000-0000-4000-8000-000000000091', 20, -89, '2026-09-02 09:00+00', '0325-reconcile'),
  ('32500000-0000-4000-8000-000000000080', '32530000-0000-4000-8000-000000000092', 20, -89, '2026-09-02 18:00+00', '0325-reconcile'),
  ('32500000-0000-4000-8000-000000000080', '32530000-0000-4000-8000-000000000092', 20, -89, '2026-09-02 20:00+00', '0325-reconcile'),
  ('32500000-0000-4000-8000-000000000080', '32530000-0000-4000-8000-000000000093', 20, -89, '2026-09-02 10:00+00', '0325-reconcile'),
  ('32500000-0000-4000-8000-000000000080', '32530000-0000-4000-8000-000000000093', 20, -89, '2026-09-02 22:00+00', '0325-reconcile');

select public.sincronizar_jornadas_por_derivar('2026-09-03 18:00+00', 2);
insert into public.jornada_dia(tenant_id, operador_id, dia)
values ('32500000-0000-4000-8000-000000000080', '32510000-0000-4000-8000-000000000085', '2026-09-02');
insert into public.jornada_asiento(
  tenant_id, jornada_id, tipo, momento, procedencia,
  registrado_por_email, nota
)
select '32500000-0000-4000-8000-000000000080', d.id, 'inicio_jornada',
       '2026-09-02 09:30+00', 'capturado_contralor', 'contralor@transportes.test',
       'Marca humana que la reconciliación no puede tocar'
  from public.jornada_dia d
 where d.tenant_id = '32500000-0000-4000-8000-000000000080'
   and d.operador_id = '32510000-0000-4000-8000-000000000085'
   and d.dia = '2026-09-02';
insert into public.jornada_asiento(
  tenant_id, jornada_id, tipo, momento, procedencia, wa_message_id, nota
)
select '32500000-0000-4000-8000-000000000080', d.id, 'inicio_descanso',
       '2026-09-02 12:00+00', 'declarado_operador', 'wamid.0325-manual-preservado',
       'Declaración del operador que tampoco puede tocar el derivador'
  from public.jornada_dia d
 where d.tenant_id = '32500000-0000-4000-8000-000000000080'
   and d.operador_id = '32510000-0000-4000-8000-000000000085'
   and d.dia = '2026-09-02';

create temporary table audit_post_claim_inicial_0325 as
select * from public.reclamar_jornadas_por_derivar(10, '0325-post-inicial', 180);
do $$
declare v_n integer;
begin
  select count(*) into v_n
    from public.procesar_jornadas_derivadas(
      '0325-post-inicial',
      (select array_agg(claim_token) from audit_post_claim_inicial_0325), 0, 0
    ) p where p.exito;
  if v_n <> 5 then raise exception 'precondición post-éxito procesó % de 5', v_n; end if;
end;
$$;

-- Contracciones posteriores a un ACK exitoso.
update public.viaje set aceptado_en = null
 where id in ('32520000-0000-4000-8000-000000000081',
              '32520000-0000-4000-8000-000000000086');
update public.viaje set aceptado_en = '2026-09-03 13:00+00',
                         unidad_id = '32530000-0000-4000-8000-000000000091'
 where id = '32520000-0000-4000-8000-000000000082';
update public.viaje set aceptado_en = '2026-09-02 16:00+00'
 where id = '32520000-0000-4000-8000-000000000083';
delete from public.posicion
 where tenant_id = '32500000-0000-4000-8000-000000000080'
   and ((unidad_id = '32530000-0000-4000-8000-000000000091' and medida_en = '2026-09-02 08:00+00')
     or (unidad_id = '32530000-0000-4000-8000-000000000092' and medida_en = '2026-09-02 20:00+00'));

select public.sincronizar_jornadas_por_derivar('2026-09-03 18:00+00', 2);
update public.jornada_derivacion_trabajo set siguiente_intento_en = '-infinity'
 where tenant_id = '32500000-0000-4000-8000-000000000080';
create temporary table audit_post_claim_final_0325 as
select * from public.reclamar_jornadas_por_derivar(10, '0325-post-final', 180);
do $$
declare v_n integer;
begin
  select count(*) into v_n
    from public.procesar_jornadas_derivadas(
      '0325-post-final',
      (select array_agg(claim_token) from audit_post_claim_final_0325), 3600, 300
    ) p where p.exito;
  if v_n <> 3 then raise exception 'reconciliación final procesó % de 3', v_n; end if;
end;
$$;

do $$
declare v_jornada uuid;
begin
  -- NULL post-éxito: la fila no desaparece, pero ninguna inferencia queda viva.
  select id into v_jornada from public.jornada_dia
   where operador_id = '32510000-0000-4000-8000-000000000081' and dia = '2026-09-02';
  if (select count(*) from public.jornada_asiento where jornada_id=v_jornada) < 1
     or exists (select 1 from public.jornada_asiento where jornada_id=v_jornada
                 and procedencia in ('hito_viaje','gps') and anulado_en is null) then
    raise exception 'NULL post-éxito borró historia o dejó inferencia viva';
  end if;

  -- Cambio de día: el anterior se anula y el nuevo día recibe una sola viva.
  if exists (
    select 1 from public.jornada_asiento a join public.jornada_dia d on d.id=a.jornada_id
     where d.operador_id='32510000-0000-4000-8000-000000000082'
       and d.dia='2026-09-02' and a.anulado_en is null
       and a.procedencia in ('hito_viaje','gps')
  ) or (select count(*) from public.jornada_asiento a join public.jornada_dia d on d.id=a.jornada_id
        where d.operador_id='32510000-0000-4000-8000-000000000082'
       and d.dia='2026-09-03' and a.anulado_en is null) <> 1
     or not exists (
       select 1 from public.jornada_asiento a join public.jornada_dia d on d.id=a.jornada_id
        where d.operador_id='32510000-0000-4000-8000-000000000082'
          and d.dia='2026-09-03' and a.anulado_en is null
          and a.unidad_id='32530000-0000-4000-8000-000000000091'
     ) then
    raise exception 'cambio de día no rebucketizó los asientos vivos';
  end if;

  -- Aceptación posterior: corrige, no sobreescribe ni conserva la hora vieja.
  select id into v_jornada from public.jornada_dia
   where operador_id = '32510000-0000-4000-8000-000000000083' and dia = '2026-09-02';
  if (select momento from public.jornada_asiento where jornada_id=v_jornada
       and tipo='inicio_jornada' and anulado_en is null) <> '2026-09-02 16:00+00'
     or not exists (select 1 from public.jornada_asiento where jornada_id=v_jornada
                     and momento='2026-09-02 14:00+00' and anulado_en is not null)
     or not exists (select 1 from public.jornada_asiento where jornada_id=v_jornada
                     and momento='2026-09-02 16:00+00' and corrige_a is not null) then
    raise exception 'aceptado posterior no produjo corrección auditable';
  end if;

  -- GPS multiunidad contraído: nuevas cotas 09:00/18:00, anteriores anuladas.
  select id into v_jornada from public.jornada_dia
   where operador_id = '32510000-0000-4000-8000-000000000084' and dia = '2026-09-02';
  if (select momento from public.jornada_asiento where jornada_id=v_jornada
       and tipo='inicio_jornada' and anulado_en is null) <> '2026-09-02 09:00+00'
     or (select momento from public.jornada_asiento where jornada_id=v_jornada
          and tipo='fin_jornada' and anulado_en is null) <> '2026-09-02 18:00+00'
     or not exists (select 1 from public.jornada_asiento where jornada_id=v_jornada
                     and momento='2026-09-02 08:00+00' and anulado_en is not null)
     or not exists (select 1 from public.jornada_asiento where jornada_id=v_jornada
                     and momento='2026-09-02 20:00+00' and anulado_en is not null) then
    raise exception 'contracción GPS multiunidad dejó extremos antiguos';
  end if;

  -- Marca humana intacta; sólo el fin GPS automático queda anulado.
  select id into v_jornada from public.jornada_dia
   where operador_id = '32510000-0000-4000-8000-000000000085' and dia = '2026-09-02';
  if (select count(*) from public.jornada_asiento where jornada_id=v_jornada
       and procedencia='capturado_contralor' and anulado_en is null
       and registrado_por_email='contralor@transportes.test') <> 1
     or (select count(*) from public.jornada_asiento where jornada_id=v_jornada
          and procedencia='declarado_operador' and anulado_en is null
          and wa_message_id='wamid.0325-manual-preservado') <> 1
     or exists (select 1 from public.jornada_asiento where jornada_id=v_jornada
                 and procedencia in ('hito_viaje','gps') and anulado_en is null) then
    raise exception 'reconciliación tocó humano o conservó automático obsoleto';
  end if;

  if exists (
    select 1 from public.jornada_asiento
     where anulado_en is not null
       and procedencia in ('hito_viaje','gps')
       and (anulado_por_email <> 'sistema:derivador-jornada@likida.internal'
            or nullif(btrim(anulado_motivo), '') is null)
       and tenant_id = '32500000-0000-4000-8000-000000000080'
  ) then raise exception 'anulación automática sin firma/motivo auditable'; end if;
end;
$$;

rollback;
