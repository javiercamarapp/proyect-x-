\set ON_ERROR_STOP on

-- Ronda 2 GPS: regresiones RED contra el contrato de entrega crítica.
-- Se ejecuta después de todas las migraciones y revierte todo al terminar.
begin;

insert into public.tenant (id, nombre)
values ('a3240000-0000-0000-0000-000000000201', 'GPS ronda 2 RED');
insert into public.unidad (id, tenant_id, numero_economico)
values ('b3240000-0000-0000-0000-000000000201',
        'a3240000-0000-0000-0000-000000000201', 'GPS-R2');
insert into public.operador (id, tenant_id, nombre, telefono, aviso_privacidad_en)
values ('c3240000-0000-0000-0000-000000000201',
        'a3240000-0000-0000-0000-000000000201', 'Operador GPS R2',
        '529999999201', '2026-01-01T00:00:00Z');
insert into public.viaje (id, tenant_id, operador_id, unidad_id)
values ('d3240000-0000-0000-0000-000000000201',
        'a3240000-0000-0000-0000-000000000201',
        'c3240000-0000-0000-0000-000000000201',
        'b3240000-0000-0000-0000-000000000201');

-- Hallazgo 1: Meta puede aceptar el envío antes de que el worker consiga
-- vincular aviso_outbox_id. El UPDATE que puso sent ya pasó y el trigger no
-- vuelve a ejecutarse al enlazar el evento.
insert into public.evento_seguridad_flota
  (tenant_id, proveedor, evento_id_externo, unidad_id, viaje_id, operador_id,
   etiquetas, grave, ocurrido_en)
values
  ('a3240000-0000-0000-0000-000000000201', 'samsara', 'r2-sent-before-link',
   'b3240000-0000-0000-0000-000000000201',
   'd3240000-0000-0000-0000-000000000201',
   'c3240000-0000-0000-0000-000000000201', array['Crash'], true,
   '2026-09-04T10:00:00Z');

do $$
declare outbox_id uuid; claim uuid; ok boolean;
begin
  insert into public.wa_outbox (dedupe_key, payload, estado, provider_message_id, provider_status, enviada_en)
  values (
    'gps:samsara:a3240000-0000-0000-0000-000000000201:r2-sent-before-link',
    '{"messaging_product":"whatsapp","to":"529999999201","type":"interactive"}'::jsonb,
    'sent', 'wamid.r2.race', 'delivered', '2026-09-04T10:00:01Z'
  ) returning id into outbox_id;

  select claim_token into claim
  from public.reclamar_eventos_seguridad(
    'a3240000-0000-0000-0000-000000000201', 'samsara', 1,
    'r2-race', 360, '2026-09-04T10:00:02Z')
  where evento_id_externo = 'r2-sent-before-link';

  ok := public.finalizar_evento_seguridad(
    p_tenant => 'a3240000-0000-0000-0000-000000000201',
    p_proveedor => 'samsara', p_evento_id_externo => 'r2-sent-before-link',
    p_claim_token => claim, p_exito => true, p_aviso_estado => 'pending',
    p_aviso_outbox_id => outbox_id, p_ahora => '2026-09-04T10:00:03Z');
  if not ok then raise exception 'ronda 2 race: no finalizó el evento'; end if;

  if not exists (
    select 1 from public.evento_seguridad_flota
    where evento_id_externo = 'r2-sent-before-link'
      and aviso_estado = 'sent'
      and aviso_outbox_id = outbox_id
      and aviso_receipt = 'wamid.r2.race'
      and procesado_en is not null
  ) then
    raise exception 'RED R2-1: sent-before-link dejó el evento pending/no procesado';
  end if;
end $$;

-- Hallazgo 2: una alerta crítica iniciada fuera de la ventana de 24 h debe
-- ser una plantilla aprobada (con quick reply), nunca un interactive libre.
do $$
declare aceptado boolean := false;
begin
  begin
    perform public.encolar_wa_outbox_dedupe(
      'gps:ronda2:interactive-fuera-ventana',
      '{"messaging_product":"whatsapp","to":"529999999201","type":"interactive","interactive":{"type":"button","action":{"buttons":[{"type":"reply","reply":{"id":"acuse","title":"Acusar"}}]}}}'::jsonb,
      'alerta crítica fuera de ventana');
    aceptado := true;
  exception when others then
    -- La excepción es la expectativa correcta: el payload libre se rechaza.
    null;
  end;
  if aceptado then
    raise exception 'RED R2-2: RPC aceptó interactive para alerta crítica fuera de ventana';
  end if;
end $$;

-- Hallazgo 3: provider_message_id/wamid y estado sent sólo prueban aceptación
-- de la API. El evento no se sella hasta un acuse Meta delivered/read.
insert into public.evento_seguridad_flota
  (tenant_id, proveedor, evento_id_externo, unidad_id, viaje_id, operador_id,
   etiquetas, grave, ocurrido_en)
values
  ('a3240000-0000-0000-0000-000000000201', 'samsara', 'r2-accepted-not-delivered',
   'b3240000-0000-0000-0000-000000000201',
   'd3240000-0000-0000-0000-000000000201',
   'c3240000-0000-0000-0000-000000000201', array['Crash'], true,
   '2026-09-04T10:01:00Z');
insert into public.incidencia
  (id, tenant_id, viaje_id, unidad_id, operador_id, tipo, prioridad, descripcion)
values
  ('e3240000-0000-0000-0000-000000000201',
   'a3240000-0000-0000-0000-000000000201',
   'd3240000-0000-0000-0000-000000000201',
   'b3240000-0000-0000-0000-000000000201',
   'c3240000-0000-0000-0000-000000000201',
   'siniestro', 'critica', 'GPS ronda 2 — incidente sintético');
update public.evento_seguridad_flota
set incidencia_id = 'e3240000-0000-0000-0000-000000000201'
where evento_id_externo = 'r2-accepted-not-delivered';

do $$
declare outbox_id uuid; claim uuid;
begin
  insert into public.wa_outbox (dedupe_key, payload)
  values (
    'gps:samsara:a3240000-0000-0000-0000-000000000201:r2-accepted-not-delivered',
    '{"messaging_product":"whatsapp","to":"529999999201","type":"template","template":{"name":"gps_alerta_critica","language":{"code":"es_MX"},"components":[{"type":"button","sub_type":"quick_reply","index":"0"}]}}'::jsonb
  ) returning id into outbox_id;
  select claim_token into claim
  from public.reclamar_eventos_seguridad(
    'a3240000-0000-0000-0000-000000000201', 'samsara', 1,
    'r2-delivery', 360, '2026-09-04T10:01:01Z')
  where evento_id_externo = 'r2-accepted-not-delivered';
  if not public.finalizar_evento_seguridad(
    p_tenant => 'a3240000-0000-0000-0000-000000000201',
    p_proveedor => 'samsara', p_evento_id_externo => 'r2-accepted-not-delivered',
    p_claim_token => claim, p_exito => true, p_aviso_estado => 'pending',
    p_aviso_outbox_id => outbox_id, p_ahora => '2026-09-04T10:01:02Z') then
    raise exception 'ronda 2 delivery: no finalizó el evento';
  end if;
  update public.wa_outbox
     set estado = 'sent', provider_message_id = 'wamid.r2.accepted', provider_status = 'accepted',
         enviada_en = '2026-09-04T10:01:03Z'
   where id = outbox_id;
  if exists (
    select 1 from public.evento_seguridad_flota
    where evento_id_externo = 'r2-accepted-not-delivered'
      and incidencia_id = 'e3240000-0000-0000-0000-000000000201'
      and procesado_en is not null
  ) then
    raise exception 'RED R2-3: sent/wamid selló sin webhook delivered/read';
  end if;
  perform public.registrar_estado_wa_meta('wamid.r2.accepted', 'delivered', null, '2026-09-04T10:05:00Z');
  if not exists (select 1 from public.evento_seguridad_flota
    where evento_id_externo = 'r2-accepted-not-delivered' and procesado_en is not null) then
    raise exception 'GREEN R2-4: delivered no selló el circuito evento→incidencia→outbox';
  end if;
  perform public.registrar_estado_wa_meta('wamid.r2.accepted', 'read', null, '2026-09-04T10:06:00Z');
  perform public.registrar_estado_wa_meta('wamid.r2.accepted', 'delivered', null, '2026-09-04T10:07:00Z');
  perform public.registrar_estado_wa_meta('wamid.r2.accepted', 'failed', 'tardío', '2026-09-04T10:08:00Z');
  if not exists (select 1 from public.wa_outbox where provider_message_id='wamid.r2.accepted' and provider_status='read') then
    raise exception 'GREEN R2-5: estado tardío retrocedió read';
  end if;
end $$;

rollback;
