-- 0347: distinguir original y copia sin recalcular importes ni relajar LR020.
-- Parche acotado sobre la definición vigente: conserva cambios posteriores
-- de revisión/PDF, firma, ACL, owner y orden de candados. Reaplicable.
begin;
do $migration$
declare
 definicion text := pg_get_functiondef('public.revisar_liquidacion(uuid,uuid,text,text,jsonb,uuid,text,jsonb)'::regprocedure);
 anterior text := $old$      -- Un comprobante que el motor EXCLUYÓ del total (duplicado o monto
      -- inválido) no suma: moverle el monto no movería el total, y la delta
      -- afirmaría lo contrario.
      select exists (
        select 1 from jsonb_array_elements(coalesce(v_liq.diferencias, '[]'::jsonb)) d
         where d ->> 'gastoId' = v_gasto.id::text and d ->> 'tipo' in ('duplicado', 'monto_invalido')
      ) into v_excluido;
      if v_excluido then
        raise exception 'el comprobante % está fuera del total (duplicado o monto inválido): no se ajusta, se rechaza la liquidación', v_gasto.id
          using errcode = 'LR019';
      end if;$old$;
 nuevo text := $new$      -- 0347: diferencias.duplicado señala al ORIGINAL, nunca a la copia.
      -- Sólo una referencia existente del mismo tenant/viaje puede probar
      -- que esta fila es copia. La identidad coincide con copiasDeComprobante.
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

      -- El monto integra la identidad de tickets sin UUID: cambiar el
      -- original separaría sus copias y ya no describe una delta simple.
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
      end if;$new$;
begin
 if strpos(definicion, nuevo)>0 then return; end if;
 if (length(definicion)-length(replace(definicion, anterior, '')))/length(anterior) <> 1 then
   raise exception '0347: la definición de revisar_liquidacion cambió; revisar el bloque de exclusión antes de migrar';
 end if;
 execute replace(definicion, anterior, nuevo);
end
$migration$;
commit;
