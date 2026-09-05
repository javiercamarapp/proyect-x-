-- 0322 — Registrar o vincular un comprobante huérfano por hash es una sola
-- transacción. Antes, el cliente interpretaba el 23505 del índice 0164 como
-- éxito y podía dejar viaje_id NULL; el cierre no veía el fallo OCR conocido.

create or replace function public.guardar_comprobante_huerfano_tx(
  p_tenant uuid,
  p_operador uuid,
  p_gasto jsonb,
  p_motivo text,
  p_ruta_imagen text default null,
  p_viaje uuid default null
)
returns uuid
language plpgsql
set search_path = public, pg_catalog, pg_temp
as $$
declare
  v_hash text := nullif(p_gasto ->> 'imgHash', '');
  v_id uuid;
  v_existente public.comprobante_huerfano%rowtype;
begin
  if p_viaje is not null and not exists (
    select 1 from public.viaje
    where id = p_viaje
      and tenant_id = p_tenant
      and operador_id = p_operador
      and estatus in ('abierto', 'en_cuadre')
  ) then
    raise exception 'el viaje no está abierto o no pertenece al operador y flota indicados'
      using errcode = 'HU003';
  end if;

  -- Sin hash no existe una llave segura de deduplicación. Se conserva el
  -- contrato anterior: una fila nueva, pero dentro de la misma RPC.
  if v_hash is null then
    insert into public.comprobante_huerfano (
      tenant_id, operador_id, gasto, motivo, ruta_imagen, viaje_id
    ) values (
      p_tenant, p_operador, p_gasto, p_motivo, p_ruta_imagen, p_viaje
    ) returning id into v_id;
    return v_id;
  end if;

  insert into public.comprobante_huerfano (
    tenant_id, operador_id, gasto, motivo, ruta_imagen, viaje_id
  ) values (
    p_tenant, p_operador, p_gasto, p_motivo, p_ruta_imagen, p_viaje
  )
  on conflict (tenant_id, (gasto ->> 'imgHash'))
    where resuelto_en is null and gasto ->> 'imgHash' is not null
  do nothing
  returning id into v_id;

  if v_id is not null then return v_id; end if;

  -- ON CONFLICT espera al ganador concurrente. El FOR UPDATE hace que sólo un
  -- viaje pueda convertir NULL en un vínculo; los demás ven el valor sellado.
  select * into v_existente
  from public.comprobante_huerfano
  where tenant_id = p_tenant
    and gasto ->> 'imgHash' = v_hash
    and resuelto_en is null
  for update;

  if not found then
    raise exception 'el comprobante duplicado dejó de estar pendiente durante el vínculo'
      using errcode = 'HU004';
  end if;
  if v_existente.operador_id <> p_operador then
    raise exception 'el comprobante ya pertenece a otro operador de la flota'
      using errcode = 'HU002';
  end if;
  if p_viaje is not null then
    if v_existente.viaje_id is null then
      update public.comprobante_huerfano
        set viaje_id = p_viaje
        where id = v_existente.id;
    elsif v_existente.viaje_id <> p_viaje then
      raise exception 'el comprobante ya está vinculado a otro viaje'
        using errcode = 'HU001';
    end if;
  end if;
  return v_existente.id;
end $$;

revoke all on function public.guardar_comprobante_huerfano_tx(
  uuid, uuid, jsonb, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.guardar_comprobante_huerfano_tx(
  uuid, uuid, jsonb, text, text, uuid
) to service_role;

comment on function public.guardar_comprobante_huerfano_tx(
  uuid, uuid, jsonb, text, text, uuid
) is '0322: registro/vínculo idempotente por tenant+imgHash. NULL se asigna una sola vez; un operador o viaje distinto recibe HU002/HU001. SECURITY INVOKER, sólo service_role.';
