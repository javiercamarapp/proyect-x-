-- 0338 · DB retención R5: el lock fuerte y el GROUP BY dejan de ser diarios.
--
-- 0335 cerró la carrera escritor/snapshot con SHARE ROW EXCLUSIVE, pero tomaba
-- ese lock y reagrupaba TODO el detalle cerrado en cada corrida. El watermark
-- ya prueba qué intervalo quedó publicado: si coincide con el mes en curso no
-- hay nada que consolidar; si avanzó el calendario sólo se lee [watermark,
-- inicio_del_mes). La primera corrida con watermark NULL conserva el fallback
-- exacto y hace el único backfill histórico (el detalle ya está acotado por la
-- retención de 92 días de 0259).

-- `now()` es el inicio de TRANSACCIÓN. Un request que abre transacción antes de
-- medianoche y espera el lock del rollover podría insertar después con fecha
-- del mes ya cerrado, justo detrás del watermark. `clock_timestamp()` se evalúa
-- al ejecutar la fila y mantiene el contrato append-only del único escritor.
alter table public.producto_evento
  alter column created_at set default clock_timestamp();

-- El escritor participa en un gate asesor compartido. A diferencia de
-- SHARE ROW EXCLUSIVE, este gate no compite con autovacuum ni con DDL ajeno al
-- contrato de snapshot. Varias inserciones siguen siendo concurrentes; sólo el
-- rollover mensual toma la variante exclusiva para esperar a escritores
-- anteriores y cerrarles el paso hasta publicar snapshot+watermark.
create or replace function public.gate_producto_evento_insert_r5()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(338, 202609);
  return null;
end;
$$;
revoke all on function public.gate_producto_evento_insert_r5() from public, anon, authenticated;

drop trigger if exists gate_producto_evento_insert_r5 on public.producto_evento;
create trigger gate_producto_evento_insert_r5
before insert on public.producto_evento
for each statement execute function public.gate_producto_evento_insert_r5();

create or replace function public.mantener_producto_evento(
  p_dias integer default 92,
  p_ahora timestamptz default now(),
  p_vence timestamptz default null
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  corte_ts timestamptz := date_trunc('month', p_ahora at time zone 'America/Mexico_City')
                            at time zone 'America/Mexico_City';
  corte_purga timestamptz;
  desde_consolidacion timestamptz;
  consolidados bigint := 0;
  borradas bigint := 0;
  borradas_tanda bigint := 0;
  pendientes boolean := false;
  watermark timestamptz;
  requiere_consolidar boolean := false;
  restante_ms bigint;
  limite_sentencia integer := 5000;
begin
  if p_dias is null or p_dias < 62 then
    raise exception 'mantener_producto_evento: % días es demasiado poco; el mínimo es 62 (el mes debe cerrar y consolidarse antes de morir su detalle)', p_dias
      using errcode='PU001';
  end if;
  if p_ahora is null then
    raise exception 'mantener_producto_evento: p_ahora no puede ser NULL' using errcode='PU002';
  end if;

  select e.detalle_desde into watermark
    from public.producto_evento_estado e
   where e.singleton;
  requiere_consolidar := watermark is null or watermark < corte_ts;

  if requiere_consolidar then
    if p_vence is not null then
      restante_ms := floor(extract(epoch from (p_vence-clock_timestamp()))*1000);
      if restante_ms <= 25 then
        return jsonb_build_object('mesesConsolidados',0,'detalleBorrado',0,
          'parcial',true,'agotado',false,'detalleDesde',watermark,
          'consolidacionDesde',watermark,'consolidacionHasta',corte_ts);
      end if;
      perform set_config('lock_timeout', least(restante_ms-25,5000)::text || 'ms', true);
    end if;

    -- Sólo el rollover mensual entra aquí. Espera INSERTs previos y detiene los
    -- nuevos mientras publica snapshot+watermark. Es un gate exclusivo de este
    -- flujo: no bloquea autovacuum ni otros locks de tabla.
    perform pg_catalog.pg_advisory_xact_lock(338, 202609);

    -- Otra corrida pudo avanzar mientras esperábamos el lock. Releer evita
    -- reagrupar o intentar retroceder el watermark.
    select e.detalle_desde into watermark
      from public.producto_evento_estado e
     where e.singleton
     for update;
    if watermark is null or watermark < corte_ts then
      if p_vence is not null and clock_timestamp() >= p_vence-interval '25 milliseconds' then
        return jsonb_build_object('mesesConsolidados',0,'detalleBorrado',0,
          'parcial',true,'agotado',false,'detalleDesde',watermark,
          'consolidacionDesde',watermark,'consolidacionHasta',corte_ts);
      end if;
      desde_consolidacion := coalesce(watermark, '-infinity'::timestamptz);
      insert into public.producto_evento_mensual as m (tenant_id, mes, eventos, consolidado_en)
      select pe.tenant_id,
             date_trunc('month', pe.created_at at time zone 'America/Mexico_City')::date,
             count(*),
             clock_timestamp()
        from public.producto_evento pe
       where pe.created_at >= desde_consolidacion
         and pe.created_at < corte_ts
       group by 1, 2
      on conflict (tenant_id, mes) do nothing;
      get diagnostics consolidados = row_count;

      insert into public.producto_evento_estado as e(singleton, detalle_desde, actualizado_en)
      values (true, corte_ts, clock_timestamp())
      on conflict (singleton) do update
        set detalle_desde = greatest(coalesce(e.detalle_desde, '-infinity'::timestamptz), excluded.detalle_desde),
            actualizado_en = excluded.actualizado_en
      returning detalle_desde into watermark;
    end if;
  end if;

  corte_purga := p_ahora - make_interval(days=>p_dias);
  loop
    exit when borradas>=5000;
    if p_vence is not null then
      restante_ms := floor(extract(epoch from (p_vence-clock_timestamp()))*1000);
      exit when restante_ms<=25;
      limite_sentencia := least((5000-borradas)::integer,
        greatest(1,floor((restante_ms-25)/15.0)::integer));
    else
      limite_sentencia := (5000-borradas)::integer;
    end if;
    with candidatos as materialized (
      select pe.ctid
        from public.producto_evento pe
       where pe.created_at < corte_purga
       order by pe.created_at, pe.id
       for update skip locked
       limit limite_sentencia
    ), borrado as (
      delete from public.producto_evento pe
       using candidatos c
       where pe.ctid=c.ctid
       returning 1
    )
    select count(*) into borradas_tanda from borrado;
    borradas := borradas+borradas_tanda;
    exit when borradas_tanda<limite_sentencia;
  end loop;

  select exists(select 1 from public.producto_evento where created_at < corte_purga)
    into pendientes;
  return jsonb_build_object(
    'mesesConsolidados',consolidados,'detalleBorrado',borradas,
    'parcial',pendientes,'agotado',not pendientes,'detalleDesde',watermark,
    'consolidacionDesde',desde_consolidacion,'consolidacionHasta',
      case when requiere_consolidar then corte_ts else null end);
end;
$$;

comment on function public.mantener_producto_evento(integer,timestamptz,timestamptz) is
  '0338: consolida sólo el intervalo aún no publicado. El gate asesor exclusivo se toma únicamente al cambiar de mes; las corridas diarias purgan por lotes sin bloquear INSERTs ni autovacuum.';
revoke all on function public.mantener_producto_evento(integer,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.mantener_producto_evento(integer,timestamptz,timestamptz) to service_role;
