\set ON_ERROR_STOP on
-- GPS ronda 5: lote atomico, T2 monotono y reconciliacion acotada.
begin;

-- Un webhook reintentado o fuera de orden no puede hacer retroceder la hora
-- durable cuando el estado si progresa delivered -> read.
do $$
declare
  v_estado text;
  v_t2 timestamptz;
begin
  perform public.registrar_estado_wa_meta(
    'wamid.r5.t2-monotono', 'delivered', null, '2026-09-04T12:00:00Z'
  );
  perform public.registrar_estado_wa_meta(
    'wamid.r5.t2-monotono', 'read', null, '2025-01-01T00:00:00Z'
  );

  select provider_status, recibido_en
    into v_estado, v_t2
    from public.wa_meta_receipt
    where wamid = 'wamid.r5.t2-monotono';

  if v_estado <> 'read' or v_t2 <> '2026-09-04T12:00:00Z'::timestamptz then
    raise exception 'RED R5-T2: estado=% T2=% (esperado read sin retroceso)', v_estado, v_t2;
  end if;
end $$;

-- Todo el arreglo cruza una sola frontera transaccional. Duplicados del mismo
-- wamid se reducen de forma estable: mayor estado y, a igualdad, mayor T2.
do $$
declare
  v_procesados integer;
  v_estado text;
  v_t2 timestamptz;
begin
  if to_regprocedure('public.registrar_estados_wa_meta_lote(jsonb)') is null then
    raise exception 'RED R5-LOTE: falta registrar_estados_wa_meta_lote(jsonb)';
  end if;

  select public.registrar_estados_wa_meta_lote(jsonb_build_array(
    jsonb_build_object('wamid','wamid.r5.lote.duplicado','estado','delivered','error',null,'ahora','2026-09-04T14:00:00Z'),
    jsonb_build_object('wamid','wamid.r5.lote.duplicado','estado','read','error',null,'ahora','2026-09-04T12:00:00Z'),
    jsonb_build_object('wamid','wamid.r5.lote.duplicado','estado','read','error',null,'ahora','2026-09-04T13:00:00Z'),
    jsonb_build_object('wamid','wamid.r5.lote.unico','estado','delivered','error',null,'ahora','2026-09-04T13:30:00Z')
  )) into v_procesados;

  select provider_status, recibido_en into v_estado, v_t2
    from public.wa_meta_receipt where wamid='wamid.r5.lote.duplicado';
  if v_procesados<>2 or v_estado<>'read' or v_t2<>'2026-09-04T14:00:00Z'::timestamptz then
    raise exception 'RED R5-LOTE: procesados=% estado=% T2=%',v_procesados,v_estado,v_t2;
  end if;
end $$;

-- Una entrada invalida revierte tambien las entradas validas del mismo lote.
do $$
declare v_fallo boolean:=false; v_mensaje text;
begin
  begin
    perform public.registrar_estados_wa_meta_lote(jsonb_build_array(
      jsonb_build_object('wamid','wamid.r5.rollback.valido','estado','delivered','error',null,'ahora','2026-09-04T13:00:00Z'),
      jsonb_build_object('wamid','','estado','read','error',null,'ahora','2026-09-04T13:01:00Z')
    ));
  exception when others then
    v_fallo:=true;
    get stacked diagnostics v_mensaje=message_text;
  end;
  if not v_fallo
     or v_mensaje<>'estado Meta invalido en lote'
     or exists(select 1 from public.wa_meta_receipt where wamid='wamid.r5.rollback.valido') then
    raise exception 'RED R5-ATOMICIDAD: validacion=% mensaje=% o cambios parciales',v_fallo,v_mensaje;
  end if;

  -- Un estado ausente tambien debe caer en la validacion previa del lote, no
  -- llegar a la funcion unitaria despues de empezar a recorrerlo.
  v_fallo:=false;
  v_mensaje:=null;
  begin
    perform public.registrar_estados_wa_meta_lote(jsonb_build_array(
      jsonb_build_object('wamid','wamid.r5.rollback.sin-estado','error',null,'ahora','2026-09-04T13:02:00Z')
    ));
  exception when others then
    v_fallo:=true;
    get stacked diagnostics v_mensaje=message_text;
  end;
  if not v_fallo or v_mensaje<>'estado Meta invalido en lote' then
    raise exception 'RED R5-VALIDACION: estado ausente paso o fallo tarde: %',v_mensaje;
  end if;
end $$;

-- La cota acepta un lote operativo grande, pero rechaza cardinalidad abusiva
-- antes de tocar el ledger.
do $$
declare v_procesados integer; v_fallo boolean:=false;
begin
  select public.registrar_estados_wa_meta_lote(
    (select jsonb_agg(jsonb_build_object(
      'wamid','wamid.r5.grande.'||g,'estado','delivered','error',null,
      'ahora','2026-09-04T13:00:00Z'
    )) from generate_series(1,2000) g)
  ) into v_procesados;
  if v_procesados<>2000 then
    raise exception 'RED R5-COTA: lote de 2000 proceso %',v_procesados;
  end if;

  begin
    perform public.registrar_estados_wa_meta_lote(
      (select jsonb_agg(jsonb_build_object(
        'wamid','wamid.r5.exceso.'||g,'estado','read','error',null,
        'ahora','2026-09-04T13:00:00Z'
      )) from generate_series(1,10001) g)
    );
  exception when others then v_fallo:=true;
  end;
  if not v_fallo or exists(select 1 from public.wa_meta_receipt where wamid like 'wamid.r5.exceso.%') then
    raise exception 'RED R5-COTA: el exceso no fue rechazado atomicamente';
  end if;
end $$;

rollback;
