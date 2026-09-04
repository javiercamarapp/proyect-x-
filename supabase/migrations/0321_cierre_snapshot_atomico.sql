-- 0321 — El cierre solo persiste la MISMA fotografía económica/fiscal que
-- calculó el motor. El conteo de la 0158 no detectaba UPDATE monto/IVA/UUID ni
-- DELETE+INSERT con el mismo número de filas.

alter table public.liquidacion
  add column if not exists insumos_hash text,
  add column if not exists insumos_hash_version smallint;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.liquidacion'::regclass
      and conname = 'liquidacion_insumos_hash_forma'
  ) then
    alter table public.liquidacion add constraint liquidacion_insumos_hash_forma check (
      (insumos_hash is null and insumos_hash_version is null)
      or (insumos_hash ~ '^[0-9a-f]{64}$' and insumos_hash_version = 1)
    );
  end if;
end $$;

comment on column public.liquidacion.insumos_hash is
  'SHA-256 canónico de los insumos económicos/fiscales usados por el cuadre. La RPC 0321 lo recalcula bajo los locks antes de cerrar.';
comment on column public.liquidacion.insumos_hash_version is
  'Versión del contrato canónico de cierre; 1 desde la migración 0321.';

-- Un lock asesor por tenant permite que los INSERT/UPDATE/DELETE de gastos y
-- líneas ECC sigan siendo concurrentes entre sí (todos toman SHARE), pero el
-- commit de un cierre obtiene EXCLUSIVE durante unos milisegundos. Así ninguna
-- mutación fiscal se cuela entre el hash bajo lock y el INSERT de liquidación.
create or replace function public.cierre_tenant_lock_key(p_tenant uuid)
returns bigint
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select ('x' || substr(replace(p_tenant::text, '-', ''), 1, 16))::bit(64)::bigint;
$$;

create or replace function public.serializar_insumo_cierre_tenant()
returns trigger
language plpgsql
set search_path = public, pg_catalog, pg_temp
as $$
declare
  v_old uuid;
  v_new uuid;
begin
  if tg_op <> 'INSERT' then v_old := old.tenant_id; end if;
  if tg_op <> 'DELETE' then v_new := new.tenant_id; end if;

  -- Orden determinista si una corrección excepcional mueve la fila de tenant.
  if v_old is not null and v_new is not null and v_old <> v_new then
    if v_old::text < v_new::text then
      perform pg_advisory_xact_lock_shared(public.cierre_tenant_lock_key(v_old));
      perform pg_advisory_xact_lock_shared(public.cierre_tenant_lock_key(v_new));
    else
      perform pg_advisory_xact_lock_shared(public.cierre_tenant_lock_key(v_new));
      perform pg_advisory_xact_lock_shared(public.cierre_tenant_lock_key(v_old));
    end if;
  else
    perform pg_advisory_xact_lock_shared(public.cierre_tenant_lock_key(coalesce(v_new, v_old)));
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

revoke all on function public.cierre_tenant_lock_key(uuid) from public, anon, authenticated;
revoke all on function public.serializar_insumo_cierre_tenant() from public, anon, authenticated;
grant execute on function public.cierre_tenant_lock_key(uuid) to service_role;

drop trigger if exists trg_00_gasto_serializa_cierre on public.gasto;
create trigger trg_00_gasto_serializa_cierre
  before insert or update or delete on public.gasto
  for each row execute function public.serializar_insumo_cierre_tenant();

drop trigger if exists trg_00_ecc_serializa_cierre on public.cfdi_consolidado_linea;
create trigger trg_00_ecc_serializa_cierre
  before insert or update or delete on public.cfdi_consolidado_linea
  for each row execute function public.serializar_insumo_cierre_tenant();

-- Contrato canónico v1. Incluye:
--   · campos del viaje/operador que usa el cuadre o imprime el PDF;
--   · config y perfil declarados (política y beneficios fiscales versionados
--     por contenido, no por una marca que el caller pudiera inventar);
--   · todos los campos persistidos de los gastos del viaje salvo metadatos
--     puramente operativos;
--   · los dos acumulados anuales de combustible y las líneas ECC de la ventana.
create or replace function public.cierre_insumos_hash(p_tenant uuid, p_viaje uuid)
returns text
language sql
stable
set search_path = public, pg_catalog, pg_temp
as $$
  with base as (
    select
      v.id, v.tenant_id, v.operador_id, v.folio, v.origen, v.destino,
      v.anticipo, v.fecha_inicio, v.fecha_fin, v.demora_no_imputable,
      t.rfc, t.config, t.perfil, t.razon_social, t.regimen_fiscal,
      t.codigo_postal_fiscal, t.uso_cfdi, t.domicilio_fiscal,
      o.nombre as operador_nombre, o.telefono as operador_telefono,
      o.rfc as operador_rfc, o.oposicion_automatizada,
      coalesce(
        extract(year from v.fecha_inicio)::int,
        (select extract(year from min(g.fecha))::int from public.gasto g
          where g.tenant_id = p_tenant and g.viaje_id = p_viaje and g.fecha is not null),
        extract(year from current_date)::int
      ) as anio
    from public.viaje v
    join public.tenant t on t.id = v.tenant_id
    left join public.operador o on o.id = v.operador_id and o.tenant_id = v.tenant_id
    where v.id = p_viaje and v.tenant_id = p_tenant
  ), gastos_viaje as (
    select coalesce(jsonb_agg(
      to_jsonb(g) - array[
        'imagen_url', 'ocr_raw', 'img_hash', 'wa_message_id',
        'autofactura_intentada_en', 'autofactura_bloqueada_en', 'autofactura_bloqueo'
      ]
      order by g.created_at, g.id
    ), '[]'::jsonb) as doc,
    min(g.fecha) as fecha_min,
    max(g.fecha) as fecha_max
    from public.gasto g
    where g.tenant_id = p_tenant and g.viaje_id = p_viaje
  ), combustible as (
    select jsonb_build_object(
      'total', coalesce(sum(g.monto), 0),
      'efectivo', coalesce(sum(g.monto) filter (where
        (case
          when g.forma_pago = '99' and g.pagado_en is not null then g.pagado_forma
          when g.forma_pago = '99' then null
          else g.forma_pago
        end) is not null
        and (case
          when g.forma_pago = '99' and g.pagado_en is not null then g.pagado_forma
          when g.forma_pago = '99' then null
          else g.forma_pago
        end) not in ('02', '03', '04', '05', '28', '29')
      ), 0)
    ) as doc
    from public.gasto g cross join base b
    where g.tenant_id = p_tenant
      and g.monto > 0
      and g.fecha >= make_date(b.anio, 1, 1)
      and g.fecha <= make_date(b.anio, 12, 31)
      and (
        g.concepto = 'diesel'
        or g.clave_prod_serv in (
          select jsonb_array_elements_text(coalesce(
            b.config #> '{hidrocarburos,claves}',
            '["15101505","15101514","15101515"]'::jsonb
          ))
        )
      )
  ), ecc as (
    select coalesce(jsonb_agg(
      jsonb_build_array(l.id, l.fecha, l.monto, l.estacion_rfc)
      order by l.fecha, l.id
    ), '[]'::jsonb) as doc
    from public.cfdi_consolidado_linea l cross join gastos_viaje gv
    where l.tenant_id = p_tenant
      and l.fuente = 'ecc12'
      and l.estacion_rfc is not null
      and l.fecha >= gv.fecha_min - 1
      and l.fecha <= gv.fecha_max + 1
  )
  select encode(digest(jsonb_build_object(
    'version', 1,
    'viaje', jsonb_build_object(
      'id', b.id, 'tenant_id', b.tenant_id, 'operador_id', b.operador_id,
      'folio', b.folio, 'origen', b.origen, 'destino', b.destino,
      'anticipo', b.anticipo, 'fecha_inicio', b.fecha_inicio,
      'fecha_fin', b.fecha_fin, 'demora_no_imputable', b.demora_no_imputable
    ),
    'tenant', jsonb_build_object(
      'rfc', b.rfc, 'config', b.config, 'perfil', b.perfil,
      'razon_social', b.razon_social, 'regimen_fiscal', b.regimen_fiscal,
      'codigo_postal_fiscal', b.codigo_postal_fiscal, 'uso_cfdi', b.uso_cfdi,
      'domicilio_fiscal', b.domicilio_fiscal
    ),
    'operador', jsonb_build_object(
      'nombre', b.operador_nombre, 'telefono', b.operador_telefono,
      'rfc', b.operador_rfc, 'oposicion_automatizada', b.oposicion_automatizada
    ),
    'gastos', gv.doc,
    'combustible_ejercicio', c.doc,
    'lineas_ecc', e.doc
  )::text, 'sha256'), 'hex')
  from base b cross join gastos_viaje gv cross join combustible c cross join ecc e;
$$;

create or replace function public.cierre_insumos_snapshot(p_tenant uuid, p_viaje uuid)
returns jsonb
language plpgsql
set search_path = public, pg_catalog, pg_temp
as $$
declare v_hash text;
begin
  v_hash := public.cierre_insumos_hash(p_tenant, p_viaje);
  if v_hash is null then
    raise exception 'el viaje % no existe o no pertenece a la flota %', p_viaje, p_tenant
      using errcode = 'CU002';
  end if;
  return jsonb_build_object('version', 1, 'hash', v_hash);
end $$;

revoke all on function public.cierre_insumos_hash(uuid, uuid) from public, anon, authenticated;
revoke all on function public.cierre_insumos_snapshot(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cierre_insumos_hash(uuid, uuid) to service_role;
grant execute on function public.cierre_insumos_snapshot(uuid, uuid) to service_role;

-- La firma previa (13 args) se reemplaza, no se sobrecarga. Los dos parámetros
-- nuevos tienen default NULL para conservar llamadas viejas; el camino actual
-- siempre envía ambos y activa las verificaciones CU006/CU007.
drop function if exists public.guardar_liquidacion_tx(
  uuid, uuid, numeric, numeric, numeric, text, jsonb, numeric, numeric,
  numeric, text, numeric, integer
);

create function public.guardar_liquidacion_tx(
  p_tenant uuid, p_viaje uuid, p_total_comprobado numeric, p_total_anticipo numeric,
  p_diferencia numeric, p_estatus text, p_diferencias jsonb, p_ieps numeric,
  p_iva numeric, p_peaje numeric, p_pdf_url text, p_litros_diesel numeric default 0,
  p_n_gastos integer default null, p_insumos_hash text default null,
  p_insumos_hash_version integer default null
)
returns uuid
language plpgsql
set search_path = public, pg_catalog, pg_temp
as $$
declare
  v_id uuid;
  v_viaje public.viaje%rowtype;
  v_n integer;
  v_hash text;
  v_total numeric;
begin
  -- ORDEN GLOBAL: tenant EXCLUSIVE y luego viaje. Los triggers de insumos toman
  -- tenant SHARE y luego viaje, por lo que no hay inversión ni deadlock.
  perform pg_advisory_xact_lock(public.cierre_tenant_lock_key(p_tenant));

  select * into v_viaje
  from public.viaje
  where id = p_viaje and tenant_id = p_tenant
  for update;
  if not found then
    raise exception 'el viaje % no existe o no es de la flota %', p_viaje, p_tenant
      using errcode = 'CU002';
  end if;

  -- Config/perfil y operador tampoco pueden cambiar mientras se recalcula y
  -- persiste el snapshot.
  perform 1 from public.tenant where id = p_tenant for share;
  perform 1 from public.operador
    where id = v_viaje.operador_id and tenant_id = p_tenant for share;

  if p_n_gastos is not null then
    select count(*) into v_n from public.gasto
      where viaje_id = p_viaje and tenant_id = p_tenant;
    if v_n <> p_n_gastos then
      raise exception 'el viaje % tenía % comprobante(s) y ahora tiene %', p_viaje, p_n_gastos, v_n
        using errcode = 'CU003';
    end if;
  end if;

  if p_insumos_hash is not null or p_insumos_hash_version is not null then
    if p_insumos_hash is null
       or p_insumos_hash_version is distinct from 1
       or p_insumos_hash !~ '^[0-9a-f]{64}$' then
      raise exception 'snapshot_invalid: versión/hash de cierre inválidos'
        using errcode = 'CU007';
    end if;

    v_hash := public.cierre_insumos_hash(p_tenant, p_viaje);
    if v_hash is distinct from p_insumos_hash then
      raise exception 'snapshot_changed: cambiaron insumos económicos/fiscales del viaje %', p_viaje
        using errcode = 'CU006';
    end if;

    -- No se confía ni siquiera en los totales que acompañan a un hash válido.
    if round(coalesce(p_total_anticipo, 0), 2) is distinct from round(v_viaje.anticipo, 2) then
      raise exception 'snapshot_invalid: total_anticipo no coincide con viaje.anticipo'
        using errcode = 'CU007';
    end if;

    with rankeados as (
      select g.monto,
        row_number() over (
          partition by case
            when nullif(g.cfdi_uuid, '') is not null
              then 'u|' || lower(g.cfdi_uuid) || '#' || coalesce(g.cfdi_orden, 1)::text
            when nullif(g.folio, '') is not null
              then 'f|' || translate(lower(g.concepto), 'áéíóúüñ', 'aeiouun')
                || '|' || coalesce(nullif(g.folio_norm, ''), g.folio)
                || '|' || g.monto::text
            else 'i|' || g.id::text
          end
          order by g.created_at, g.id
        ) as rn
      from public.gasto g
      where g.tenant_id = p_tenant and g.viaje_id = p_viaje
    )
    select coalesce(round(sum(monto) filter (where rn = 1 and monto > 0), 2), 0)
      into v_total from rankeados;

    if round(coalesce(p_total_comprobado, 0), 2) is distinct from v_total
       or round(coalesce(p_total_anticipo, 0) - coalesce(p_total_comprobado, 0), 2)
          is distinct from round(coalesce(p_diferencia, 0), 2) then
      raise exception 'snapshot_invalid: los totales enviados no se derivan de los insumos bloqueados'
        using errcode = 'CU007';
    end if;
  end if;

  insert into public.liquidacion (
    tenant_id, viaje_id, total_comprobado, total_anticipo, diferencia,
    estatus, diferencias, ieps_acreditable, iva_acreditable, peaje_acreditable,
    pdf_url, litros_diesel_acreditables, insumos_hash, insumos_hash_version
  ) values (
    p_tenant, p_viaje, p_total_comprobado, p_total_anticipo, p_diferencia,
    p_estatus, p_diferencias, p_ieps, p_iva, p_peaje,
    p_pdf_url, p_litros_diesel, p_insumos_hash, p_insumos_hash_version
  )
  on conflict (viaje_id) do update set
    total_comprobado = excluded.total_comprobado,
    total_anticipo = excluded.total_anticipo,
    diferencia = excluded.diferencia,
    estatus = excluded.estatus,
    diferencias = excluded.diferencias,
    ieps_acreditable = excluded.ieps_acreditable,
    iva_acreditable = excluded.iva_acreditable,
    peaje_acreditable = excluded.peaje_acreditable,
    litros_diesel_acreditables = excluded.litros_diesel_acreditables,
    pdf_url = coalesce(excluded.pdf_url, liquidacion.pdf_url),
    insumos_hash = coalesce(excluded.insumos_hash, liquidacion.insumos_hash),
    insumos_hash_version = coalesce(excluded.insumos_hash_version, liquidacion.insumos_hash_version)
  returning id into v_id;

  update public.viaje set estatus = 'liquidado'
    where id = p_viaje and tenant_id = p_tenant;
  return v_id;
end $$;

revoke all on function public.guardar_liquidacion_tx(
  uuid, uuid, numeric, numeric, numeric, text, jsonb, numeric, numeric,
  numeric, text, numeric, integer, text, integer
) from public, anon, authenticated;
grant execute on function public.guardar_liquidacion_tx(
  uuid, uuid, numeric, numeric, numeric, text, jsonb, numeric, numeric,
  numeric, text, numeric, integer, text, integer
) to service_role;

comment on function public.guardar_liquidacion_tx(
  uuid, uuid, numeric, numeric, numeric, text, jsonb, numeric, numeric,
  numeric, text, numeric, integer, text, integer
) is 'Cierre atómico 0321: conteo CU003 + snapshot SHA-256 v1 recalculado bajo locks CU006; totales mínimos verificados CU007. Parámetros nuevos opcionales por compatibilidad.';
