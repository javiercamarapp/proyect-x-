-- 0356 — LEG-M5 (auditoría 28, mitad ARCO): `contacto_emergencia` (0198)
-- guarda el nombre, teléfono y parentesco de un TERCERO —un familiar que
-- nunca aceptó ningún aviso de privacidad— capturado por la flota sobre el
-- operador. `ejecutar_arco_cancelacion` anonimiza al titular y borra su
-- rastro conversacional (wa_conversacion, envio_mensaje) pero nunca tocaba
-- esta tabla: la cancelación del OPERADOR dejaba intacto el dato de su
-- familiar.
--
-- A diferencia de `gasto`/`cfdi` (retenidos por CFF art. 30), no hay
-- fundamento fiscal ni legal para conservar el contacto de emergencia una
-- vez que el titular cancela: se borra, mismo criterio que ya aplica esta
-- función a wa_conversacion/envio_mensaje.
--
-- FUERA DE ALCANCE A PROPÓSITO (mitad de LEG-M5, decisión de Javier): la
-- PURGA por antigüedad (sin que medie una solicitud ARCO) exige fijar un
-- plazo de retención para el dato de un tercero, y ese plazo es una
-- decisión de política de privacidad, no un hecho mecánico — se deja
-- señalada, no se inventa.
begin;

CREATE OR REPLACE FUNCTION public.ejecutar_arco_cancelacion(p_tenant uuid, p_solicitud uuid)
returns jsonb
language plpgsql
set search_path = public, extensions, pg_catalog
as $$
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

  -- LEG-M5 (0356): el contacto de emergencia es dato de un TERCERO sin
  -- fundamento fiscal que lo retenga — se borra, no se anonimiza.
  delete from contacto_emergencia ce
   where ce.tenant_id = p_tenant and ce.operador_id = v_operador;
  get diagnostics n = row_count; ev := ev || jsonb_build_object('contacto_emergencia', n);

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
         resolucion = coalesce(resolucion, 'Se sustituyeron el nombre y el teléfono del registro operativo, se eliminaron sus conversaciones y el contacto de emergencia registrado sobre su persona. Se conservan el identificador del operador, el correo de la cuenta, la referencia del titular en la solicitud y la documentación fiscal. Requieren revisión de privacidad para determinar los pasos pendientes.')
   where id = p_solicitud and tenant_id = p_tenant;

  return jsonb_build_object('ok', true, 'evidencia', ev, 'seudonimo', seudonimo);
end;
$$;

comment on function public.ejecutar_arco_cancelacion(uuid, uuid) is
  'LEG-M5 (0356, auditoría 28, mitad ARCO): además de lo conversacional, borra contacto_emergencia del operador — dato de un tercero sin fundamento fiscal que lo retenga. La purga por antigüedad (sin ARCO) queda pendiente: exige fijar un plazo de retención, decisión de Javier. Historial: 0173 (creación), 0262/0264/0273/0275/0286/0290/0340 (alcance, digest, search_path), 0353 (cuerpo completo literal).';

revoke all on function public.ejecutar_arco_cancelacion(uuid, uuid) from public, anon, authenticated;
grant execute on function public.ejecutar_arco_cancelacion(uuid, uuid) to service_role;

commit;
