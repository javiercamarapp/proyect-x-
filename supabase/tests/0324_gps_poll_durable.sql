\set ON_ERROR_STOP on

begin;

insert into public.tenant (id, nombre) values
  ('a0000000-0000-0000-0000-000000000001', 'GPS 0324 A'),
  ('a0000000-0000-0000-0000-000000000002', 'GPS 0324 B'),
  ('a0000000-0000-0000-0000-000000000003', 'GPS 0324 C'),
  ('a0000000-0000-0000-0000-000000000004', 'GPS 0324 D'),
  ('a0000000-0000-0000-0000-000000000005', 'GPS 0324 E');

insert into public.conector_credencial (tenant_id, conector_id, valores_cifrados)
select id, 'samsara', 'opaque-ciphertext' from public.tenant
where id::text like 'a0000000-0000-0000-0000-00000000000%';

-- Fairness durable: tres reclamos consecutivos de 2 alcanzan los cinco
-- tenants antes de repetir uno; SKIP LOCKED/lease impide solaparlos.
create temporary table audit_claims_pos as
select 1 corrida, * from public.reclamar_polls_conector(
  'posiciones', array['samsara'], 2, 'worker-1', 360, '2026-09-03T12:00:00Z');
insert into audit_claims_pos
select 2, * from public.reclamar_polls_conector(
  'posiciones', array['samsara'], 2, 'worker-2', 360, '2026-09-03T12:00:00Z');
insert into audit_claims_pos
select 3, * from public.reclamar_polls_conector(
  'posiciones', array['samsara'], 2, 'worker-3', 360, '2026-09-03T12:00:00Z');

do $$
begin
  if (select count(*) from audit_claims_pos) <> 5
     or (select count(distinct tenant_id) from audit_claims_pos) <> 5 then
    raise exception 'fairness GPS: algún tenant se repitió antes de atender los cinco';
  end if;
end $$;

-- Dejamos una sola credencial activa para aislar el fence de eventos.
update public.conector_credencial
set activo = tenant_id = 'a0000000-0000-0000-0000-000000000001';
update public.conector_poll_estado
set watermark_en = '2026-08-01T00:00:00Z'
where tenant_id = 'a0000000-0000-0000-0000-000000000001' and recurso = 'eventos';

create temporary table poll_a as
select * from public.reclamar_polls_conector(
  p_recurso => 'eventos', p_proveedores => array['samsara'], p_limite => 1,
  p_worker => 'poll-a', p_lease_segundos => 360, p_ahora => '2026-09-03T12:00:00Z');

do $$
declare n integer;
begin
  select count(*) into n from public.reclamar_polls_conector(
    'eventos', array['samsara'], 1, 'poll-b-121', 360, '2026-09-03T12:02:01Z');
  if n <> 0 then raise exception 'worker B robó poll a +121 s'; end if;

  select count(*) into n from public.reclamar_polls_conector(
    'eventos', array['samsara'], 1, 'poll-b-300', 360, '2026-09-03T12:05:00Z');
  if n <> 0 then raise exception 'worker B robó poll durante maxDuration=300 s'; end if;
end $$;

create temporary table poll_b as
select * from public.reclamar_polls_conector(
  'eventos', array['samsara'], 1, 'poll-b-361', 360, '2026-09-03T12:06:01Z');

do $$
declare ok boolean;
begin
  select public.finalizar_poll_conector(
    tenant_id, proveedor, 'eventos', claim_token, false, null, false, null,
    null, 1, 0, 0, 'stale', '2026-09-03T12:06:02Z') into ok from poll_a;
  if ok then raise exception 'token stale finalizó poll reclamado por B'; end if;

  select public.finalizar_poll_conector(
    tenant_id, proveedor, 'eventos', claim_token, false, null, false, null,
    null, 1, 0, 0, 'scope 403', '2026-09-03T12:06:02Z') into ok from poll_b;
  if not ok then raise exception 'dueño del lease no pudo finalizar incompleto'; end if;
end $$;

-- El bootstrap posterior NO mueve el piso original tras un 403.
create temporary table poll_c as
select * from public.reclamar_polls_conector(
  'eventos', array['samsara'], 1, 'poll-c', 360, '2026-09-04T12:00:00Z');

do $$
declare ok boolean;
begin
  if (select watermark_en from poll_c) <> '2026-08-01T00:00:00Z'::timestamptz then
    raise exception 'el 403 movió el bootstrap durable y perdió historia';
  end if;
  select public.finalizar_poll_conector(
    tenant_id, proveedor, 'eventos', claim_token, true,
    '2026-08-01T06:00:00Z', true, '2026-09-04T12:00:00Z',
    '2026-08-01T05:59:00Z', 11, 5100, 0, null,
    '2026-09-04T12:00:05Z') into ok from poll_c;
  if not ok then raise exception 'no finalizó poll completo'; end if;
  if not exists (
    select 1 from public.conector_poll_estado
    where tenant_id = 'a0000000-0000-0000-0000-000000000001'
      and recurso = 'eventos' and paginas_ultima = 11
      and elementos_ultima = 5100 and not backlog_pendiente
      and watermark_en = '2026-08-01T06:00:00Z'
      and tail_watermark_en = '2026-09-04T12:00:00Z'
      and ultima_medida_en = '2026-08-01T05:59:00Z'
  ) then raise exception 'página 11/5100 o salud no persistieron'; end if;
end $$;

-- Outbox de choque: B no roba a 121/300 s; tras muerte de A puede recuperar
-- a 361 s, y el token viejo no puede sellar el evento.
insert into public.unidad (id, tenant_id, numero_economico)
values ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'GPS-1');
insert into public.evento_seguridad_flota
  (tenant_id, proveedor, evento_id_externo, unidad_id, etiquetas, grave, ocurrido_en)
values
  ('a0000000-0000-0000-0000-000000000001', 'samsara', 'evt-exact',
   'b0000000-0000-0000-0000-000000000001', array['Crash'], true, '2026-09-03T11:59:00Z');

create temporary table evento_a as
select * from public.reclamar_eventos_seguridad(
  'a0000000-0000-0000-0000-000000000001', 'samsara', 1,
  'evento-a', 360, '2026-09-03T12:00:00Z');

do $$
declare n integer;
begin
  select count(*) into n from public.reclamar_eventos_seguridad(
    'a0000000-0000-0000-0000-000000000001', 'samsara', 1,
    'evento-b-121', 360, '2026-09-03T12:02:01Z');
  if n <> 0 then raise exception 'worker B robó choque a +121 s'; end if;
  select count(*) into n from public.reclamar_eventos_seguridad(
    'a0000000-0000-0000-0000-000000000001', 'samsara', 1,
    'evento-b-300', 360, '2026-09-03T12:05:00Z');
  if n <> 0 then raise exception 'worker B robó choque durante maxDuration'; end if;
end $$;

create temporary table evento_b as
select * from public.reclamar_eventos_seguridad(
  'a0000000-0000-0000-0000-000000000001', 'samsara', 1,
  'evento-b-361', 360, '2026-09-03T12:06:01Z');

do $$
declare ok boolean;
begin
  select public.finalizar_evento_seguridad(
    'a0000000-0000-0000-0000-000000000001', 'samsara',
    evento_id_externo, claim_token, true, null, null, '2026-09-03T12:06:02Z')
    into ok from evento_a;
  if ok then raise exception 'token stale selló el choque'; end if;

  select public.finalizar_evento_seguridad(
    'a0000000-0000-0000-0000-000000000001', 'samsara',
    evento_id_externo, claim_token, true, null, null, '2026-09-03T12:06:02Z')
    into ok from evento_b;
  if not ok then raise exception 'dueño del lease no selló el choque'; end if;
  if (select count(*) from public.reclamar_eventos_seguridad(
    'a0000000-0000-0000-0000-000000000001', 'samsara', 1,
    'evento-c', 360, '2026-09-03T12:20:00Z')) <> 0 then
    raise exception 'choque procesado volvió a salir del outbox';
  end if;
end $$;

-- Poison-pill: tras fallar recibe backoff y el evento siguiente sí sale en el
-- mismo reloj. Al quinto fallo queda en DLQ visible y deja de reclamarse.
insert into public.evento_seguridad_flota
  (tenant_id, proveedor, evento_id_externo, unidad_id, etiquetas, grave, ocurrido_en)
values
  ('a0000000-0000-0000-0000-000000000001', 'poison-test', 'evt-poison',
   'b0000000-0000-0000-0000-000000000001', array['Crash'], true, '2026-09-05T10:00:00Z'),
  ('a0000000-0000-0000-0000-000000000001', 'poison-test', 'evt-siguiente',
   'b0000000-0000-0000-0000-000000000001', array['Crash'], true, '2026-09-05T10:01:00Z');

do $$
declare c uuid; id text; i integer; ok boolean; instante timestamptz;
begin
  select evento_id_externo, claim_token into id, c
  from public.reclamar_eventos_seguridad(
    'a0000000-0000-0000-0000-000000000001', 'poison-test', 1,
    'poison-1', 360, '2026-09-05T11:00:00Z');
  if id <> 'evt-poison' then raise exception 'no reclamó poison primero'; end if;
  ok := public.finalizar_evento_seguridad(
    'a0000000-0000-0000-0000-000000000001', 'poison-test', id, c,
    false, null, 'fallo permanente', '2026-09-05T11:00:01Z');
  if not ok then raise exception 'no aplicó backoff al poison'; end if;

  select evento_id_externo, claim_token into id, c
  from public.reclamar_eventos_seguridad(
    'a0000000-0000-0000-0000-000000000001', 'poison-test', 1,
    'siguiente', 360, '2026-09-05T11:00:02Z');
  if id <> 'evt-siguiente' then raise exception 'poison bloqueó evento posterior'; end if;
  perform public.finalizar_evento_seguridad(
    'a0000000-0000-0000-0000-000000000001', 'poison-test', id, c,
    true, null, null, '2026-09-05T11:00:03Z');

  for i in 2..5 loop
    instante := '2026-09-05T11:00:00Z'::timestamptz + i * interval '1 day';
    select evento_id_externo, claim_token into id, c
    from public.reclamar_eventos_seguridad(
      'a0000000-0000-0000-0000-000000000001', 'poison-test', 1,
      'poison-' || i, 360, instante);
    if id <> 'evt-poison' then raise exception 'poison no reintentó intento %', i; end if;
    perform public.finalizar_evento_seguridad(
      'a0000000-0000-0000-0000-000000000001', 'poison-test', id, c,
      false, null, 'fallo permanente', instante + interval '1 second');
  end loop;
  if not exists (
    select 1 from public.evento_seguridad_flota
    where proveedor = 'poison-test' and evento_id_externo = 'evt-poison'
      and intentos = 5 and muerto_en is not null and ultimo_error = 'fallo permanente'
  ) then raise exception 'poison no quedó visible en DLQ al quinto intento'; end if;
  if (select count(*) from public.reclamar_eventos_seguridad(
    'a0000000-0000-0000-0000-000000000001', 'poison-test', 1,
    'poison-6', 360, '2026-10-01T00:00:00Z')) <> 0 then
    raise exception 'DLQ volvió al hot loop';
  end if;
end $$;

-- El catálogo activo no gobierna el outbox ya durable.
insert into public.evento_seguridad_flota
  (tenant_id, proveedor, evento_id_externo, unidad_id, etiquetas, grave, ocurrido_en)
values ('a0000000-0000-0000-0000-000000000001', 'sin-credencial', 'evt-sin-token',
        'b0000000-0000-0000-0000-000000000001', array['Crash'], true, '2026-09-20T00:00:00Z');
do $$ begin
  if not exists (
    select 1 from public.listar_outboxes_eventos_pendientes(100, '2026-09-20T01:00:00Z')
    where proveedor = 'sin-credencial'
  ) then raise exception 'outbox desapareció sin credencial activa'; end if;
end $$;

-- Un conflicto de cuarentena no rejuvenece el backoff; la referencia legacy
-- NULL se puede reparar sobre la misma llave y se vuelve elegible al outbox.
insert into public.evento_seguridad_cuarentena
  (tenant_id, proveedor, evento_id_externo, ocurrido_en, motivo, siguiente_intento_en, intentos)
values ('a0000000-0000-0000-0000-000000000001', 'samsara', 'evt-q',
        '2026-08-01T00:00:00Z', 'unidad_sin_mapear', '2026-09-30T00:00:00Z', 3);
insert into public.evento_seguridad_cuarentena
  (tenant_id, proveedor, evento_id_externo, ocurrido_en, motivo)
values ('a0000000-0000-0000-0000-000000000001', 'samsara', 'evt-q',
        '2026-08-01T00:00:00Z', 'unidad_sin_mapear')
on conflict (tenant_id, proveedor, evento_id_externo, motivo) do update
set asset_id = excluded.asset_id, unidad_id = excluded.unidad_id,
    ocurrido_en = excluded.ocurrido_en, actualizado_en = clock_timestamp();
do $$ begin
  if not exists (
    select 1 from public.evento_seguridad_cuarentena
    where evento_id_externo = 'evt-q' and intentos = 3
      and siguiente_intento_en = '2026-09-30T00:00:00Z'
  ) then raise exception 'upsert rejuveneció cuarentena/backoff'; end if;
end $$;

insert into public.evento_seguridad_cuarentena
  (tenant_id, proveedor, evento_id_externo, ocurrido_en, motivo, siguiente_intento_en)
values
  ('a0000000-0000-0000-0000-000000000001', 'q-lease', 'q-a', '2026-09-01T00:00:00Z', 'unidad_sin_mapear', '2026-09-01T00:00:00Z'),
  ('a0000000-0000-0000-0000-000000000001', 'q-lease', 'q-b', '2026-09-01T00:01:00Z', 'sin_aviso_previo', '2026-09-01T00:00:00Z');
do $$
declare n integer;
begin
  select count(*) into n from public.reclamar_cuarentena_eventos(
    'a0000000-0000-0000-0000-000000000001', 'q-lease', 2,
    'q-worker-a', 360, '2026-09-03T12:00:00Z');
  if n <> 2 then raise exception 'no reclamó las dos referencias'; end if;
  select count(*) into n from public.reclamar_cuarentena_eventos(
    'a0000000-0000-0000-0000-000000000001', 'q-lease', 2,
    'q-worker-b', 360, '2026-09-03T12:05:00Z');
  if n <> 0 then raise exception 'robó cuarentena antes de vencer lease'; end if;
  select count(*) into n from public.reclamar_cuarentena_eventos(
    'a0000000-0000-0000-0000-000000000001', 'q-lease', 2,
    'q-worker-c', 360, '2026-09-03T12:06:01Z');
  if n <> 2 then raise exception 'no recuperó cuarentena tras worker muerto'; end if;
end $$;

-- 250 pendientes, claims de 50: el evento #201 aparece en el quinto lote.
insert into public.evento_seguridad_flota
  (tenant_id, proveedor, evento_id_externo, unidad_id, etiquetas, grave, ocurrido_en)
select 'a0000000-0000-0000-0000-000000000001', 'samsara',
       'evt-' || lpad(g::text, 3, '0'), 'b0000000-0000-0000-0000-000000000001',
       case when g = 201 then array['Crash'] else array['HarshImpact'] end,
       true, '2026-09-03T13:00:00Z'::timestamptz + g * interval '1 second'
from generate_series(1, 250) g;

create temporary table eventos_250 as
select 1 lote, * from public.reclamar_eventos_seguridad(
  'a0000000-0000-0000-0000-000000000001', 'samsara', 50, 'lote-1', 360, '2026-09-03T14:00:00Z');
insert into eventos_250 select 2, * from public.reclamar_eventos_seguridad(
  'a0000000-0000-0000-0000-000000000001', 'samsara', 50, 'lote-2', 360, '2026-09-03T14:00:00Z');
insert into eventos_250 select 3, * from public.reclamar_eventos_seguridad(
  'a0000000-0000-0000-0000-000000000001', 'samsara', 50, 'lote-3', 360, '2026-09-03T14:00:00Z');
insert into eventos_250 select 4, * from public.reclamar_eventos_seguridad(
  'a0000000-0000-0000-0000-000000000001', 'samsara', 50, 'lote-4', 360, '2026-09-03T14:00:00Z');
insert into eventos_250 select 5, * from public.reclamar_eventos_seguridad(
  'a0000000-0000-0000-0000-000000000001', 'samsara', 50, 'lote-5', 360, '2026-09-03T14:00:00Z');

do $$
begin
  if (select count(*) from eventos_250) <> 250 then
    raise exception 'el outbox recortó los 250 eventos';
  end if;
  if exists (select 1 from eventos_250 where evento_id_externo = 'evt-201' and lote < 5)
     or not exists (select 1 from eventos_250 where evento_id_externo = 'evt-201' and lote = 5) then
    raise exception 'evento #201 no llegó exactamente en el quinto lote';
  end if;
end $$;

-- RLS de coordenadas: contador 0; roles operativos sólo propia flota.
insert into public.unidad (id, tenant_id, numero_economico) values
  ('b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', 'GPS-2');
insert into public.posicion (tenant_id, unidad_id, lat, lng, medida_en, proveedor) values
  ('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 20, -89, '2026-09-03T12:00:00Z', 'test'),
  ('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002', 21, -88, '2026-09-03T12:00:00Z', 'test');

insert into public.app_user (id, tenant_id, email, rol) values
  ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'contador-0324@test.invalid', 'contador'),
  ('c0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'encargado-0324@test.invalid', 'encargado'),
  ('c0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'admin-0324@test.invalid', 'flota_admin');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000001', true);
do $$ begin
  if (select count(*) from public.posicion) <> 0 then
    raise exception 'contador leyó coordenadas por REST/RLS';
  end if;
end $$;

select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000002', true);
do $$ begin
  if (select count(*) from public.posicion) <> 1
     or (select tenant_id from public.posicion limit 1) <> 'a0000000-0000-0000-0000-000000000001' then
    raise exception 'encargado no ve exactamente la posición de su tenant';
  end if;
end $$;

select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000003', true);
do $$ begin
  if (select count(*) from public.posicion) <> 1
     or (select tenant_id from public.posicion limit 1) <> 'a0000000-0000-0000-0000-000000000001' then
    raise exception 'flota_admin cruzó tenant o perdió su posición';
  end if;
end $$;
reset role;

rollback;
