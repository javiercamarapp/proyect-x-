\set ON_ERROR_STOP on
-- GPS ronda 4: RED antes de 0333. Ejecutar sobre una base con 0332 aplicada.
begin;

-- El contrato visible de la plantilla de Meta impone las cotas del proveedor:
-- body.text <= 1024 caracteres y quick_reply.payload <= 256.
do $$
declare body_aceptado boolean; payload_aceptado boolean;
begin
  body_aceptado:=false;
  begin
    perform public.encolar_wa_outbox_dedupe(
      'gps:r4:body-grande',
      jsonb_build_object(
        'messaging_product','whatsapp','to','529999999999','type','template',
        'template',jsonb_build_object(
          'name','gps_alerta_critica','language',jsonb_build_object('code','es_MX'),
          'components',jsonb_build_array(
            jsonb_build_object('type','body','parameters',jsonb_build_array(jsonb_build_object('type','text','text',repeat('x',1025)))),
            jsonb_build_object('type','button','sub_type','quick_reply','index','0','parameters',jsonb_build_array(jsonb_build_object('type','payload','payload','ok')))
          )
        )
      )
    );
    body_aceptado:=true;
  exception when others then null;
  end;

  payload_aceptado:=false;
  begin
    perform public.encolar_wa_outbox_dedupe(
      'gps:r4:payload-grande',
      jsonb_build_object(
        'messaging_product','whatsapp','to','529999999999','type','template',
        'template',jsonb_build_object(
          'name','gps_alerta_critica','language',jsonb_build_object('code','es_MX'),
          'components',jsonb_build_array(
            jsonb_build_object('type','body','parameters',jsonb_build_array(jsonb_build_object('type','text','text','ok'))),
            jsonb_build_object('type','button','sub_type','quick_reply','index','0','parameters',jsonb_build_array(jsonb_build_object('type','payload','payload',repeat('x',257))))
          )
        )
      )
    );
    payload_aceptado:=true;
  exception when others then null;
  end;
  if body_aceptado or payload_aceptado then
    raise exception 'RED R4-1/2: fuera de cota aceptado (body=%, payload=%)',body_aceptado,payload_aceptado;
  end if;

  -- Los máximos exactos siguen siendo válidos (evita un off-by-one).
  perform public.encolar_wa_outbox_dedupe(
    'gps:r4:limites-exactos',
    jsonb_build_object(
      'messaging_product','whatsapp','to','529999999999','type','template',
      'template',jsonb_build_object(
        'name','gps_alerta_critica','language',jsonb_build_object('code','es_MX'),
        'components',jsonb_build_array(
          jsonb_build_object('type','body','parameters',jsonb_build_array(jsonb_build_object('type','text','text',repeat('x',1024)))),
          jsonb_build_object('type','button','sub_type','quick_reply','index','0','parameters',jsonb_build_array(jsonb_build_object('type','payload','payload',repeat('x',256))))
        )
      )
    )
  );
end $$;

-- Receipt terminal antes de provider_message_id: la finalización debe observar
-- el dead producido por el trigger, que es lo que el cron contabiliza y alerta.
do $$
declare o uuid; token uuid := '33300000-0000-4000-8000-000000000001'; ok boolean; muerta boolean;
begin
  perform public.registrar_estado_wa_meta(
    'wamid.r4.terminal-previo','failed','terminal:destinatario','2026-09-04T15:00:00Z');
  insert into public.wa_outbox(dedupe_key,payload,estado,intentos,lease_token,lease_expires_at)
  values ('gps:r4:terminal-previo','{}','sending',1,token,clock_timestamp()+interval '1 minute') returning id into o;
  select f.ok,f.muerta into ok,muerta
    from public.finalizar_wa_outbox(o,token,'wamid.r4.terminal-previo',null) f;
  if not ok or not muerta or not exists (
    select 1 from public.wa_outbox where id=o and estado='dead'
      and provider_status='failed' and ultimo_error='terminal:destinatario'
  ) then
    raise exception 'RED R4-3: receipt terminal previo no se propagó como dead/muerta';
  end if;
end $$;

rollback;
