\set ON_ERROR_STOP on
-- GPS ronda 3: RED antes de 0330. Ejecutar sobre una base con 0328 aplicada.
begin;
do $$
begin
  if to_regclass('public.wa_meta_receipt') is null then
    raise exception 'RED R3-1: falta ledger durable de receipts Meta';
  end if;
end $$;
-- Un estado ajeno y sin outbox debe quedar durable, no depender de retry HTTP.
select public.registrar_estado_wa_meta('wamid.r3.ajeno', 'delivered', null, '2026-09-04T12:00:00Z');
do $$ begin
  if not exists (select 1 from public.wa_meta_receipt where wamid='wamid.r3.ajeno' and provider_status='delivered') then
    raise exception 'RED R3-2: receipt ajeno no durable';
  end if;
end $$;
-- El vínculo posterior debe reconciliar el receipt anterior.
do $$
declare o uuid;
begin
  insert into public.wa_outbox(dedupe_key,payload,estado,provider_message_id,provider_status)
  values ('gps:r3:link','{"to":"529999999999","type":"template","template":{"name":"gps_alerta_critica","language":{"code":"es_MX"},"components":[{"type":"button","sub_type":"quick_reply","index":"0"}]}}','sent','wamid.r3.ajeno','accepted') returning id into o;
  perform public.reconciliar_wa_meta_receipts(10);
  if not exists (select 1 from public.wa_meta_receipt where wamid='wamid.r3.ajeno' and reconciliado_en is not null) then raise exception 'RED R3-3: receipt no reconciliado'; end if;
end $$;
do $$ begin
  perform public.registrar_estado_wa_meta('wamid.r3.ajeno','failed','tardío','2026-09-04T12:01:00Z');
  if (select provider_status from public.wa_meta_receipt where wamid='wamid.r3.ajeno') <> 'delivered' then raise exception 'monotonicidad delivered→failed rota'; end if;
  perform public.registrar_estado_wa_meta('wamid.r3.ajeno','read',null,'2026-09-04T12:02:00Z');
  if (select provider_status from public.wa_meta_receipt where wamid='wamid.r3.ajeno') <> 'read' then raise exception 'failed/read no recupera'; end if;
end $$;

-- Los prefijos terminales son absorbentes; retryable sí puede recuperarse
-- cuando Meta confirma después la entrega real. T1 y T2 son relojes distintos.
do $$
declare o uuid; token uuid := '33000000-0000-4000-8000-000000000001'; ok boolean; muerta boolean;
begin
  insert into public.wa_outbox(dedupe_key,payload,estado,intentos,lease_token,lease_expires_at)
  values ('gps:r3:terminal','{}','sending',1,token,clock_timestamp()+interval '1 minute') returning id into o;
  select f.ok,f.muerta into ok,muerta from public.finalizar_wa_outbox(o,token,null,'terminal:HTTP 400') f;
  if not ok or not muerta or (select estado from public.wa_outbox where id=o) <> 'dead' then
    raise exception 'RED R3-5: rechazo terminal se reencolo';
  end if;

  token := '33000000-0000-4000-8000-000000000002';
  insert into public.wa_outbox(dedupe_key,payload,estado,intentos,lease_token,lease_expires_at)
  values ('gps:r3:sin-wamid','{}','sending',1,token,clock_timestamp()+interval '1 minute') returning id into o;
  select f.ok,f.muerta into ok,muerta from public.finalizar_wa_outbox(o,token,null,'sin_wamid:r3') f;
  if not ok or not muerta or (select estado from public.wa_outbox where id=o) <> 'dead' then
    raise exception 'RED R3-6: 200 sin wamid no quedo dead';
  end if;
end $$;

do $$
declare o uuid;
begin
  insert into public.wa_outbox(dedupe_key,payload,estado,provider_message_id,provider_status,
                               provider_status_en,enviada_en)
  values ('gps:r3:t1-t2','{}','sent','wamid.r3.t1-t2','accepted',
          '2026-09-04T12:00:00Z','2026-09-04T12:00:00Z') returning id into o;
  perform public.registrar_estado_wa_meta('wamid.r3.t1-t2','failed','retryable:temporal','2026-09-04T12:01:00Z');
  perform public.registrar_estado_wa_meta('wamid.r3.t1-t2','delivered',null,'2026-09-04T12:05:00Z');
  if not exists (select 1 from public.wa_outbox where id=o and estado='sent' and provider_status='delivered'
      and enviada_en='2026-09-04T12:00:00Z' and provider_status_en='2026-09-04T12:05:00Z'
      and delivered_en='2026-09-04T12:05:00Z' and ultimo_error is null) then
    raise exception 'RED R3-7: failed-delivered falsifico T1/T2 o dejo error';
  end if;
  if not exists (select 1 from public.wa_meta_receipt where wamid='wamid.r3.t1-t2'
      and provider_status='delivered' and recibido_en='2026-09-04T12:05:00Z' and error is null) then
    raise exception 'RED R3-8: ledger no conserva el evento efectivo de entrega';
  end if;
end $$;

do $$
declare o uuid;
begin
  insert into public.wa_outbox(dedupe_key,payload,estado,provider_message_id,provider_status)
  values ('gps:r3:terminal-absorbe','{}','sent','wamid.r3.terminal','accepted') returning id into o;
  perform public.registrar_estado_wa_meta('wamid.r3.terminal','failed','terminal:destinatario','2026-09-04T12:10:00Z');
  perform public.registrar_estado_wa_meta('wamid.r3.terminal','failed','retryable:duplicado','2026-09-04T12:11:00Z');
  if not exists (select 1 from public.wa_outbox where id=o and estado='dead'
      and provider_status='failed' and ultimo_error='terminal:destinatario') then
    raise exception 'RED R3-9: terminal revivio con un failed retryable tardio';
  end if;
  perform public.registrar_estado_wa_meta('wamid.r3.terminal','delivered',null,'2026-09-04T12:12:00Z');
  if not exists (select 1 from public.wa_outbox where id=o and estado='dead' and provider_status='failed') then
    raise exception 'RED R3-10: terminal revivio con estado incompatible tardio';
  end if;
end $$;

-- Si Meta entregó antes de vincular el evento, el vínculo usa T2 y un failed
-- retryable pendiente no se convierte en dead por el trigger legacy.
do $$
declare o uuid; c uuid := '33000000-0000-4000-8000-000000000021'; ok boolean;
begin
  insert into public.tenant(id,nombre) values ('33000000-0000-4000-8000-000000000020','GPS R3 T2 link');
  insert into public.wa_outbox(dedupe_key,payload,estado,provider_message_id,provider_status,
                               provider_status_en,enviada_en,delivered_en)
  values ('gps:samsara:33000000-0000-4000-8000-000000000020:t2-before-link','{}','sent',
          'wamid.r3.t2-before-link','delivered','2026-09-04T12:31:00Z',
          '2026-09-04T12:30:00Z','2026-09-04T12:31:00Z') returning id into o;
  insert into public.evento_seguridad_flota(tenant_id,proveedor,evento_id_externo,grave,ocurrido_en,
      claim_token,claim_worker,claim_expires_at,intentos)
  values ('33000000-0000-4000-8000-000000000020','samsara','t2-before-link',true,
          '2026-09-04T12:29:00Z',c,'r3-test',clock_timestamp()+interval '1 minute',1);
  ok := public.finalizar_evento_seguridad('33000000-0000-4000-8000-000000000020','samsara',
    't2-before-link',c,true,null,'pending',o,null,null,'2026-09-04T12:32:00Z');
  if not ok or not exists (select 1 from public.evento_seguridad_flota where evento_id_externo='t2-before-link'
      and aviso_estado='sent' and procesado_en='2026-09-04T12:31:00Z') then
    raise exception 'RED R3-17: receipt-before-link sello con T1 o no convergio';
  end if;

  c := '33000000-0000-4000-8000-000000000022';
  insert into public.wa_outbox(dedupe_key,payload,estado,provider_message_id,provider_status,ultimo_error)
  values ('gps:samsara:33000000-0000-4000-8000-000000000020:retryable-before-link','{}','pending',
          'wamid.r3.retryable-before-link','failed','retryable:temporal') returning id into o;
  insert into public.evento_seguridad_flota(tenant_id,proveedor,evento_id_externo,grave,ocurrido_en,
      claim_token,claim_worker,claim_expires_at,intentos)
  values ('33000000-0000-4000-8000-000000000020','samsara','retryable-before-link',true,
          '2026-09-04T12:29:00Z',c,'r3-test',clock_timestamp()+interval '1 minute',1);
  ok := public.finalizar_evento_seguridad('33000000-0000-4000-8000-000000000020','samsara',
    'retryable-before-link',c,true,null,'pending',o,null,null,'2026-09-04T12:32:00Z');
  if not ok or not exists (select 1 from public.evento_seguridad_flota where evento_id_externo='retryable-before-link'
      and aviso_estado='pending' and procesado_en is null) then
    raise exception 'RED R3-18: failed retryable se convirtio en dead al vincular';
  end if;
end $$;

-- El batch es un backstop real: delivered/read siempre deja la salida sent.
do $$
declare o uuid; n integer;
begin
  insert into public.wa_outbox(dedupe_key,payload,estado,provider_message_id,provider_status)
  values ('gps:r3:batch','{}','pending','wamid.r3.batch','accepted') returning id into o;
  insert into public.wa_meta_receipt(wamid,provider_status,recibido_en)
  values ('wamid.r3.batch','delivered','2026-09-04T12:20:00Z');
  n := public.reconciliar_wa_meta_receipts(10);
  if n < 1 or not exists (select 1 from public.wa_outbox where id=o and estado='sent'
      and provider_status='delivered' and delivered_en='2026-09-04T12:20:00Z') then
    raise exception 'RED R3-11: batch delivered no forzo sent/T2';
  end if;
end $$;

-- Un evento no puede enlazar el outbox durable de otro tenant aunque conozca UUID.
do $$
declare o uuid; rechazo boolean := false;
begin
  insert into public.tenant(id,nombre) values
    ('33000000-0000-4000-8000-000000000010','GPS R3 tenant A'),
    ('33000000-0000-4000-8000-000000000011','GPS R3 tenant B');
  insert into public.wa_outbox(dedupe_key,payload)
  values ('gps:samsara:33000000-0000-4000-8000-000000000010:cross-r3','{}') returning id into o;
  begin
    insert into public.evento_seguridad_flota(tenant_id,proveedor,evento_id_externo,grave,ocurrido_en,aviso_outbox_id,aviso_estado)
    values ('33000000-0000-4000-8000-000000000011','samsara','cross-r3',true,clock_timestamp(),o,'pending');
  exception when others then rechazo := true;
  end;
  if not rechazo then raise exception 'RED R3-12: evento acepto outbox de otro tenant'; end if;
end $$;

-- Purga acotada: respeta límite y nunca toca backlog vivo ni receipts recientes.
do $$
declare n integer;
begin
  insert into public.wa_meta_receipt(wamid,provider_status,recibido_en,reconciliado_en)
  values ('wamid.r3.purge.1','delivered',clock_timestamp()-interval '100 days',clock_timestamp()),
         ('wamid.r3.purge.2','delivered',clock_timestamp()-interval '100 days',clock_timestamp()),
         ('wamid.r3.purge.3','delivered',clock_timestamp()-interval '100 days',clock_timestamp()),
         ('wamid.r3.purge.recent','delivered',clock_timestamp()-interval '10 days',clock_timestamp()),
         ('wamid.r3.purge.live','delivered',clock_timestamp()-interval '100 days',null);
  n := public.purgar_wa_meta_receipts(2);
  if n <> 2 then raise exception 'RED R3-13: purga ignoro limite, elimino %',n; end if;
  if (select count(*) from public.wa_meta_receipt where wamid like 'wamid.r3.purge.%') <> 3 then
    raise exception 'RED R3-14: cardinalidad de purga incorrecta';
  end if;
  if not exists (select 1 from public.wa_meta_receipt where wamid='wamid.r3.purge.recent')
     or not exists (select 1 from public.wa_meta_receipt where wamid='wamid.r3.purge.live') then
    raise exception 'RED R3-15: purga borro receipt reciente o backlog vivo';
  end if;
end $$;
do $$ declare accepted boolean:=false; begin
  begin perform public.encolar_wa_outbox_dedupe('gps:r3:bad','{"to":"1","type":"template","template":{"name":"otro","language":{"code":"es_MX"},"components":[{"type":"body"},{"type":"button","sub_type":"quick_reply","index":"0"}]}}'::jsonb); accepted:=true; exception when others then null; end;
  if accepted then raise exception 'plantilla inválida aceptada'; end if;
  accepted:=false;
  begin perform public.encolar_wa_outbox_dedupe('gps:r3:bad-shape','{"messaging_product":"whatsapp","to":"","type":"template","template":{"name":"gps_alerta_critica","language":{"code":"es_MX"},"components":[{"type":"body"},{"type":"button","sub_type":"quick_reply","index":"0"},{"type":"header"}]}}'::jsonb); accepted:=true; exception when others then null; end;
  if accepted then raise exception 'RED R3-25: plantilla GPS acepto destinatario/componentes sin contrato exacto'; end if;
end $$;
-- No debe existir índice no único redundante al único por wamid.
do $$ begin
  if to_regclass('public.wa_outbox_provider_message_idx') is not null then raise exception 'RED R3-4: índice redundante'; end if;
  if to_regclass('public.wa_meta_receipt_purga_idx') is null then raise exception 'RED R3-16: falta indice parcial de purga'; end if;
end $$;

-- Defensa en profundidad: ledger sin políticas = acceso sólo por RPC definer.
do $$ begin
  if not coalesce((select relrowsecurity from pg_class where oid='public.wa_meta_receipt'::regclass),false)
     or exists (select 1 from pg_policy where polrelid='public.wa_meta_receipt'::regclass)
     or has_table_privilege('anon','public.wa_meta_receipt','select')
     or has_table_privilege('authenticated','public.wa_meta_receipt','select') then
    raise exception 'RED R3-19: ledger no aplica RLS deny-all a clientes';
  end if;
end $$;

-- NULL no puede degradar LIMIT a ilimitado, ni un caller ampliar el lote.
do $$
declare rechazo boolean;
begin
  rechazo:=false;
  begin perform public.reconciliar_wa_meta_receipts(null); exception when others then rechazo:=true; end;
  if not rechazo then raise exception 'RED R3-20: reconciliar acepto limite NULL'; end if;
  rechazo:=false;
  begin perform public.reconciliar_wa_meta_receipts(1001); exception when others then rechazo:=true; end;
  if not rechazo then raise exception 'RED R3-21: reconciliar acepto lote >1000'; end if;
  rechazo:=false;
  begin perform public.purgar_wa_meta_receipts(null); exception when others then rechazo:=true; end;
  if not rechazo then raise exception 'RED R3-22: purga acepto limite NULL'; end if;
  rechazo:=false;
  begin perform public.purgar_wa_meta_receipts(5001); exception when others then rechazo:=true; end;
  if not rechazo then raise exception 'RED R3-23: purga acepto lote >5000'; end if;
  rechazo:=false;
  begin perform public.registrar_estado_wa_meta(repeat('x',501),'delivered'); exception when others then rechazo:=true; end;
  if not rechazo then raise exception 'RED R3-24: ledger acepto wamid sin cota'; end if;
end $$;
rollback;
