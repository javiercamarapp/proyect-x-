-- 0353 — DAT-M3 (auditoría 28, higiene): `revisar_liquidacion` (0299 y
-- sucesivas) y `ejecutar_arco_cancelacion` (0173 y sucesivas) llevan varias
-- rondas parcheándose con CIRUGÍA DE TEXTO en vez de un `create or replace`
-- literal: 0347 lee `pg_get_functiondef('revisar_liquidacion(...)')` en una
-- variable, le aplica `replace()` sobre el texto fuente y ejecuta el
-- resultado; 0340 hace lo mismo con `ejecutar_arco_cancelacion`. Funciona
-- (cada replay parte de lo que la migración anterior dejó instalado), pero
-- deja el repo sin un solo archivo que muestre el cuerpo COMPLETO vigente de
-- ninguna de las dos — para leerlo hay que reconstruir la cirugía a mano o
-- consultar la base viva. Ningún llamador cambia de comportamiento: esto
-- reemplaza la cirugía por el mismo resultado, escrito literal.
--
-- El cuerpo de cada función es una copia EXACTA, verbatim, de
-- `pg_get_functiondef(...)` contra producción (verificado antes de escribir
-- esta migración) — no una reconstrucción manual. Los `comment on function`
-- documentan el historial real para quien busque por número de migración.
begin;

CREATE OR REPLACE FUNCTION public.revisar_liquidacion(p_tenant uuid, p_liquidacion uuid, p_accion text, p_motivo text DEFAULT NULL::text, p_ajustes jsonb DEFAULT NULL::jsonb, p_actor uuid DEFAULT NULL::uuid, p_actor_email text DEFAULT NULL::text, p_recalculo jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog', 'pg_temp'
AS $function$
declare
  v_viaje     viaje%rowtype;
  v_liq       liquidacion%rowtype;
  v_email     text;
  v_motivo    text := nullif(btrim(coalesce(p_motivo, '')), '');
  v_aj        jsonb;
  v_gasto     gasto%rowtype;
  v_nuevo     numeric;
  v_delta     numeric := 0;
  v_ajustes   jsonb := '[]'::jsonb;
  v_excluido  boolean;
  v_telefono  text;
  v_accion    text;
  v_total_delta numeric;
  v_total_recalculo numeric;
begin
  if p_accion not in ('aprobar', 'ajustar', 'rechazar') then
    raise exception 'acción desconocida: % (aprobar | ajustar | rechazar)', p_accion
      using errcode = 'LR001';
  end if;

  select v.* into v_viaje
    from viaje v
    join liquidacion l on l.viaje_id = v.id
   where l.id = p_liquidacion and l.tenant_id = p_tenant and v.tenant_id = p_tenant
     for update of v;
  if not found then
    raise exception 'la liquidación % no existe o no es de la flota %', p_liquidacion, p_tenant
      using errcode = 'LR002';
  end if;

  select l.* into v_liq from liquidacion l where l.id = p_liquidacion for update;

  if v_liq.revision = 'rechazada' then
    raise exception 'la liquidación % ya está rechazada: espera a que el motor vuelva a cuadrar el viaje', p_liquidacion
      using errcode = 'LR011';
  end if;
  if v_liq.revision <> 'pendiente' and (v_liq.revisada_por is not null or v_liq.revisada_por_email is not null) then
    raise exception 'la liquidación % ya fue revisada (%) por % el %: no se firma dos veces', p_liquidacion, v_liq.revision,
      coalesce(v_liq.revisada_por_email, v_liq.revisada_por::text), v_liq.revisada_en
      using errcode = 'LR010';
  end if;
  if v_viaje.estatus <> 'liquidado' then
    raise exception 'el viaje % no está liquidado (%): no hay cierre que firmar', v_viaje.id, v_viaje.estatus
      using errcode = 'LR012';
  end if;
  if p_accion in ('ajustar', 'rechazar') and v_motivo is null then
    raise exception 'ajustar o rechazar exige un motivo escrito' using errcode = 'LR013';
  end if;

  if p_actor is not null then
    select email into v_email from app_user where id = p_actor;
  end if;
  v_email := coalesce(v_email, nullif(btrim(coalesce(p_actor_email, '')), ''));
  if p_actor is null and v_email is null then
    raise exception 'la revisión la firma una persona: falta el actor' using errcode = 'LR014';
  end if;

  perform set_config('likida.revision_en_curso', '1', true);

  if p_accion = 'ajustar' then
    if p_ajustes is null or jsonb_typeof(p_ajustes) <> 'array' or jsonb_array_length(p_ajustes) = 0 then
      raise exception 'ajustar exige al menos un ajuste [{gastoId, montoNuevo}]' using errcode = 'LR015';
    end if;
    if p_recalculo is null or jsonb_typeof(p_recalculo) <> 'object' then
      raise exception 'ajustar exige el recálculo del motor (p_recalculo): revisarLiquidacion() lo arma con cuadrarDesdeDB antes de llamar a esta RPC'
        using errcode = 'LR021';
    end if;
    for v_aj in select * from jsonb_array_elements(p_ajustes) loop
      if jsonb_typeof(v_aj) <> 'object' or (v_aj ->> 'gastoId') is null or (v_aj ->> 'montoNuevo') is null then
        raise exception 'cada ajuste es {gastoId, montoNuevo}: %', v_aj using errcode = 'LR015';
      end if;
      begin
        v_nuevo := round((v_aj ->> 'montoNuevo')::numeric, 2);
      exception when others then
        raise exception 'montoNuevo no es un número: %', v_aj ->> 'montoNuevo' using errcode = 'LR016';
      end;
      if v_nuevo is null or v_nuevo <= 0 or v_nuevo > 1000000 then
        raise exception 'el monto ajustado tiene que ser mayor a cero y menor a un millón: %', v_nuevo
          using errcode = 'LR016';
      end if;

      select g.* into v_gasto from gasto g
       where g.id = (v_aj ->> 'gastoId')::uuid and g.viaje_id = v_liq.viaje_id and g.tenant_id = p_tenant
         for update;
      if not found then
        raise exception 'el comprobante % no es de este viaje', v_aj ->> 'gastoId' using errcode = 'LR017';
      end if;
      if v_gasto.monto = v_nuevo then
        raise exception 'el comprobante % ya tiene ese monto (%): no hay ajuste que aplicar', v_gasto.id, v_nuevo
          using errcode = 'LR018';
      end if;
      -- 0347: diferencias.duplicado señala al ORIGINAL, nunca a la copia.
      select v_gasto.monto <= 0 or exists (
        select 1 from jsonb_array_elements(coalesce(v_liq.diferencias, '[]'::jsonb)) d
         where d->>'gastoId' = v_gasto.id::text and d->>'tipo' = 'monto_invalido'
      ) or exists (
        select 1
          from jsonb_array_elements(coalesce(v_liq.diferencias, '[]'::jsonb)) d
          join gasto original on original.id::text = d->>'gastoId'
           and original.tenant_id = p_tenant and original.viaje_id = v_liq.viaje_id
         where d->>'tipo' = 'duplicado' and original.id <> v_gasto.id
           and (
             (nullif(v_gasto.cfdi_uuid, '') is not null
               and lower(v_gasto.cfdi_uuid) = lower(original.cfdi_uuid)
               and coalesce(v_gasto.cfdi_orden, 1) = coalesce(original.cfdi_orden, 1))
             or (nullif(v_gasto.cfdi_uuid, '') is null and nullif(original.cfdi_uuid, '') is null
               and nullif(v_gasto.folio, '') is not null and nullif(original.folio, '') is not null
               and v_gasto.concepto = original.concepto
               and coalesce(nullif(v_gasto.folio_norm, ''), v_gasto.folio) = coalesce(nullif(original.folio_norm, ''), original.folio)
               and v_gasto.monto = original.monto)
           )
      ) into v_excluido;
      if v_excluido then
        raise exception 'el comprobante % es una copia excluida o tiene monto inválido: rechaza la liquidación, revisa sus comprobantes y vuelve a calcular antes de ajustar', v_gasto.id
          using errcode = 'LR019';
      end if;
      if nullif(v_gasto.cfdi_uuid, '') is null and exists (
        select 1
          from jsonb_array_elements(coalesce(v_liq.diferencias, '[]'::jsonb)) d
          join gasto copia on copia.tenant_id = p_tenant and copia.viaje_id = v_liq.viaje_id
           and copia.id <> v_gasto.id
         where d->>'tipo' = 'duplicado' and d->>'gastoId' = v_gasto.id::text
           and nullif(copia.cfdi_uuid, '') is null
           and nullif(v_gasto.folio, '') is not null and nullif(copia.folio, '') is not null
           and copia.concepto = v_gasto.concepto
           and coalesce(nullif(copia.folio_norm, ''), copia.folio) = coalesce(nullif(v_gasto.folio_norm, ''), v_gasto.folio)
           and copia.monto = v_gasto.monto
      ) then
        raise exception 'el comprobante % es el original de un grupo duplicado cuya identidad depende del monto: rechaza la liquidación, revisa el grupo y vuelve a calcular antes de ajustar', v_gasto.id
          using errcode = 'LR022';
      end if;

      update gasto set monto = v_nuevo where id = v_gasto.id;
      v_delta := v_delta + (v_nuevo - v_gasto.monto);
      v_ajustes := v_ajustes || jsonb_build_object(
        'gasto_id', v_gasto.id, 'concepto', v_gasto.concepto,
        'monto_anterior', v_gasto.monto, 'monto_nuevo', v_nuevo);
    end loop;

    v_total_delta := round(v_liq.total_comprobado + v_delta, 2);
    v_total_recalculo := round((p_recalculo ->> 'totalComprobado')::numeric, 2);
    if v_total_recalculo is null or abs(v_total_recalculo - v_total_delta) > 0.01 then
      raise exception 'el recálculo (%) no coincide con el ajuste aplicado (%): algo cambió los gastos de este viaje entre el cálculo y el guardado — vuelve a intentar', v_total_recalculo, v_total_delta
        using errcode = 'LR020';
    end if;

    update liquidacion
       set total_comprobado = v_total_recalculo,
           diferencia       = round((p_recalculo ->> 'diferencia')::numeric, 2),
           estatus          = (p_recalculo ->> 'estatus')::text,
           diferencias      = coalesce(p_recalculo -> 'diferencias', '[]'::jsonb),
           ieps_acreditable = round(coalesce((p_recalculo ->> 'iepsAcreditable')::numeric, 0), 2),
           litros_diesel_acreditables = round(coalesce((p_recalculo ->> 'litrosDieselAcreditables')::numeric, 0), 3),
           iva_acreditable  = round(coalesce((p_recalculo ->> 'ivaAcreditable')::numeric, 0), 2),
           peaje_acreditable = round(coalesce((p_recalculo ->> 'peajeAcreditable')::numeric, 0), 2),
           revision = 'ajustada', revisada_por = p_actor, revisada_por_email = v_email,
           revisada_en = now(), motivo = v_motivo, ajustes = v_ajustes
     where id = p_liquidacion;
    v_accion := 'liquidacion.ajustada';

  elsif p_accion = 'aprobar' then
    update liquidacion
       set revision = 'aprobada', revisada_por = p_actor, revisada_por_email = v_email,
           revisada_en = now(), motivo = v_motivo, ajustes = null
     where id = p_liquidacion;
    v_accion := 'liquidacion.aprobada';

  else
    update liquidacion
       set revision = 'rechazada', revisada_por = p_actor, revisada_por_email = v_email,
           revisada_en = now(), motivo = v_motivo, ajustes = null
     where id = p_liquidacion;
    update viaje set estatus = 'en_cuadre' where id = v_viaje.id;
    v_accion := 'liquidacion.rechazada';
  end if;

  insert into bitacora_auditoria (tenant_id, actor_id, actor_email, accion, entidad, entidad_id, detalle)
  values (p_tenant, p_actor, v_email, v_accion, 'liquidacion', p_liquidacion::text,
          jsonb_build_object('viaje_id', v_viaje.id, 'folio', v_viaje.folio, 'motivo', v_motivo,
                             'ajustes', case when p_accion = 'ajustar' then v_ajustes else null end,
                             'delta', case when p_accion = 'ajustar' then v_delta else null end,
                             'recalculo', case when p_accion = 'ajustar' then p_recalculo else null end));

  select o.telefono into v_telefono from operador o where o.id = v_viaje.operador_id;
  select l.* into v_liq from liquidacion l where l.id = p_liquidacion;

  perform set_config('likida.revision_en_curso', '', true);

  return jsonb_build_object(
    'revision', v_liq.revision,
    'viaje_id', v_viaje.id,
    'folio', v_viaje.folio,
    'total_comprobado', v_liq.total_comprobado,
    'diferencia', v_liq.diferencia,
    'ajustes', v_liq.ajustes,
    'operador_telefono', v_telefono,
    'revisada_por_email', v_liq.revisada_por_email,
    'revisada_en', v_liq.revisada_en
  );
end $function$;

comment on function public.revisar_liquidacion(uuid, uuid, text, text, jsonb, uuid, text, jsonb) is
  '0353 (DAT-M3, auditoría 28, higiene): cuerpo completo literal, verbatim de producción — sin cambio de comportamiento. Reemplaza la cirugía de texto que 0347 aplicaba sobre pg_get_functiondef() para agregar la exclusión de copias por identidad (LR019/LR022). Historial: 0299 (creación), 0306 (regenera desglose y PDF al ajustar), 0347 (excluye copias por identidad del gasto).';

CREATE OR REPLACE FUNCTION public.ejecutar_arco_cancelacion(p_tenant uuid, p_solicitud uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path = public, extensions, pg_catalog
AS $function$
declare
  v_operador uuid;
  v_tipo text;
  v_estado text;
  v_telefono text;
  v_incidencias uuid[];
  ev jsonb := '{}'::jsonb;
  n int;
  seudonimo text;
begin
  select operador_id, tipo, estado into v_operador, v_tipo, v_estado
    from solicitud_arco where id = p_solicitud and tenant_id = p_tenant;

  if v_operador is null then
    return jsonb_build_object('ok', false, 'motivo', 'solicitud sin operador o de otra flota');
  end if;
  if v_tipo <> 'cancelacion' then
    return jsonb_build_object(
      'ok', false,
      'motivo', case when v_tipo = 'oposicion'
        then 'la oposición no cancela ni anonimiza datos; conserva la revisión humana de decisiones automatizadas'
        else 'esta función solo ejecuta solicitudes de cancelación'
      end
    );
  end if;
  if v_estado in ('resuelta', 'improcedente') then
    return jsonb_build_object('ok', false, 'motivo', 'ya estaba cerrada');
  end if;

  seudonimo := 'Operador ' || upper(substr(encode(digest(v_operador::text, 'sha256'), 'hex'), 1, 6));

  select telefono into v_telefono from operador where id = v_operador and tenant_id = p_tenant;

  ev := ev || jsonb_build_object('evidencia_fiscal_retenida', true, 'fundamento_retencion', 'CFF art. 30');

  delete from wa_conversacion c
   where c.tenant_id = p_tenant
     and (c.operador_id = v_operador
          or (v_telefono is not null
              and telefono_normalizado(c.telefono) = telefono_normalizado(v_telefono)));
  get diagnostics n = row_count; ev := ev || jsonb_build_object('wa_conversacion', n);

  delete from envio_mensaje e
   where e.tenant_id = p_tenant
     and v_telefono is not null
     and telefono_normalizado(e.telefono) = telefono_normalizado(v_telefono);
  get diagnostics n = row_count; ev := ev || jsonb_build_object('envio_mensaje', n);

  select coalesce(array_agg(i.id), '{}'::uuid[]) into v_incidencias
    from incidencia i
   where i.tenant_id = p_tenant and i.operador_id = v_operador
     and i.texto_anonimizado_en is null;

  update incidencia
     set descripcion = '[texto retirado por cancelación ARCO del titular]',
         operador_id = null,
         texto_anonimizado_en = now()
   where tenant_id = p_tenant and id = any(v_incidencias);
  get diagnostics n = row_count; ev := ev || jsonb_build_object('incidencia_texto_anonimizado', n);

  update incidencia_evento e
     set detalle = jsonb_set(
           coalesce(e.detalle, '{}'::jsonb),
           '{texto}',
           to_jsonb('[texto retirado por cancelación ARCO del titular]'::text),
           true)
   where e.tenant_id = p_tenant
     and e.detalle ? 'texto'
     and e.incidencia_id = any(v_incidencias);
  get diagnostics n = row_count; ev := ev || jsonb_build_object('incidencia_evento_texto_anonimizado', n);

  update operador
     set nombre = seudonimo,
         telefono = 'anon:' || substr(encode(digest(v_operador::text || 'tel', 'sha256'), 'hex'), 1, 16),
         rfc = null,
         licencia = null,
         licencia_tipo = null,
         licencia_vence = null,
         anonimizado_en = now()
   where id = v_operador and tenant_id = p_tenant;
  get diagnostics n = row_count; ev := ev || jsonb_build_object('operador_anonimizado', n);

  update app_user
     set nombre = seudonimo, telefono = null, avatar_url = null
   where operador_id = v_operador;
  get diagnostics n = row_count; ev := ev || jsonb_build_object('app_user_anonimizado', n);

  update solicitud_arco
     set estado = 'resuelta', resuelta_en = now(), ejecutada_en = now(), evidencia = ev,
         resolucion = coalesce(resolucion, 'Se sustituyeron el nombre y el teléfono del registro operativo y se eliminaron sus conversaciones. Se conservan el identificador del operador, el correo de la cuenta, la referencia del titular en la solicitud y la documentación fiscal. Requieren revisión de privacidad para determinar los pasos pendientes.')
   where id = p_solicitud and tenant_id = p_tenant;

  return jsonb_build_object('ok', true, 'evidencia', ev, 'seudonimo', seudonimo);
end;
$function$;

comment on function public.ejecutar_arco_cancelacion(uuid, uuid) is
  '0353 (DAT-M3, auditoría 28, higiene): cuerpo completo literal, verbatim de producción — sin cambio de comportamiento. Reemplaza la cirugía de texto que 0340 aplicaba sobre pg_get_functiondef() para acotar el alcance real de la cancelación. Historial: 0173 (creación), 0262 (anonimiza RFC/licencia), 0264 (digest calificado), 0273 (texto libre de resolución), 0275 (search_path con extensions), 0286 (localiza también por teléfono normalizado), 0290 (forma de teléfono/RFC/placas), 0340 (acota el alcance descrito de la cancelación).';

commit;
