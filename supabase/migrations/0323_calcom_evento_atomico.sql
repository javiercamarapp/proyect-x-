-- 0323 — Cal.com: ledger, orden y cambio de embudo en una sola transacción.
-- La 0181 creó el ledger durable, pero el webhook sellaba y mutaba en dos
-- requests PostgREST. Entre ambas podía perderse un evento o contestarse 200
-- tras agotar un CAS sin haber aplicado nada. Este RPC es la única escritura
-- nueva: el INSERT idempotente, el lock del prospecto y el UPDATE comparten
-- COMMIT/ROLLBACK.

alter table public.prospecto
  add column if not exists calcom_booking_id text,
  add column if not exists calcom_evento_en timestamptz,
  add column if not exists calcom_evento_precedencia smallint;

comment on column public.prospecto.calcom_booking_id is
  'Reserva Cal.com vigente. Eventos sin createdAt sólo pueden afectarla; BOOKING_CREATED únicamente establece la primera si aún no hay vínculo.';
comment on column public.prospecto.calcom_evento_en is
  'Último createdAt firmado de Cal.com aplicado a la reserva vigente. NULL si sólo existe orden de llegada no confiable.';
comment on column public.prospecto.calcom_evento_precedencia is
  'Desempate del último createdAt aplicado: CREATED=0, RESCHEDULED=1, CANCELLED/NO_SHOW=2.';

alter table public.comercial_evento
  add column if not exists estado_proceso text not null default 'legado',
  add column if not exists orden_en timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'comercial_evento_estado_proceso_dominio'
       and conrelid = 'public.comercial_evento'::regclass
  ) then
    alter table public.comercial_evento add constraint comercial_evento_estado_proceso_dominio
      check (estado_proceso in ('legado', 'pendiente', 'aplicado', 'ignorado', 'cuarentena'));
  end if;
end $$;

comment on column public.comercial_evento.estado_proceso is
  'Resultado durable: legado (antes de 0323), pendiente dentro de la transacción, aplicado, ignorado o cuarentena.';
comment on column public.comercial_evento.orden_en is
  'createdAt del sobre firmado usado para ordenar. NULL en payload ausente/inválido/futuro; esos eventos no envenenan la secuencia.';

create or replace function public.aplicar_evento_calcom_tx(
  p_clave text,
  p_tipo text,
  p_externo text,
  p_prospecto uuid,
  p_payload jsonb,
  p_creado_en timestamptz default null,
  p_externo_anterior text default null
)
returns table(resultado text, estado_prospecto text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_evento_id uuid;
  v_destino text;
  v_precedencia smallint;
  v_actual text;
  v_actual_canonico text;
  v_booking text;
  v_ultimo_en timestamptz;
  v_ultima_precedencia smallint;
  v_futuro boolean := p_creado_en is not null
    and p_creado_en > clock_timestamp() + interval '5 minutes';
begin
  if nullif(btrim(p_clave), '') is null
      or nullif(btrim(p_tipo), '') is null
      or nullif(btrim(p_externo), '') is null then
    raise exception 'evento Cal.com incompleto' using errcode = 'CR001';
  end if;

  v_destino := case p_tipo
    when 'BOOKING_CREATED' then 'appointment'
    when 'BOOKING_RESCHEDULED' then 'rescheduled'
    when 'BOOKING_CANCELLED' then 'cancelled'
    when 'BOOKING_NO_SHOW' then 'no-show'
    else null
  end;
  v_precedencia := case p_tipo
    when 'BOOKING_CREATED' then 0
    when 'BOOKING_RESCHEDULED' then 1
    when 'BOOKING_CANCELLED' then 2
    when 'BOOKING_NO_SHOW' then 2
    else null
  end;
  if v_destino is null then
    raise exception 'tipo Cal.com no soportado: %', p_tipo using errcode = 'CR002';
  end if;

  -- ON CONFLICT espera al dueño concurrente de la misma clave. Si ese dueño
  -- hace ROLLBACK, este INSERT continúa y se convierte en dueño; si COMMITea,
  -- devuelve cero filas y el duplicado observa el resultado durable.
  insert into public.comercial_evento (
    clave_idempotencia, fuente, tipo, prospecto_id, externo_id, payload,
    ocurrido_en, orden_en, estado_proceso
  ) values (
    p_clave, 'calcom', p_tipo, p_prospecto, p_externo, coalesce(p_payload, '{}'::jsonb),
    case when v_futuro then clock_timestamp() else coalesce(p_creado_en, clock_timestamp()) end,
    case when v_futuro then null else p_creado_en end,
    'pendiente'
  )
  on conflict (clave_idempotencia) do nothing
  returning id into v_evento_id;

  if v_evento_id is null then
    return query select 'repetido'::text,
      (select pr.estado from public.prospecto pr where pr.id = p_prospecto);
    return;
  end if;

  if v_futuro then
    update public.comercial_evento
       set estado_proceso = 'cuarentena', procesado_en = clock_timestamp(),
           error = 'created_at_futuro'
     where id = v_evento_id;
    return query select 'cuarentena'::text,
      (select pr.estado from public.prospecto pr where pr.id = p_prospecto);
    return;
  end if;

  if p_prospecto is null then
    update public.comercial_evento
       set estado_proceso = 'ignorado', procesado_en = clock_timestamp(), error = 'sin_prospecto'
     where id = v_evento_id;
    return query select 'ignorado'::text, null::text;
    return;
  end if;

  -- Un solo lock corto reemplaza los CAS en Node. Todos los eventos del mismo
  -- prospecto se serializan aquí y vuelven a evaluar estado, booking y orden
  -- DESPUÉS de que el ganador anterior hizo COMMIT.
  select pr.estado, pr.calcom_booking_id, pr.calcom_evento_en, pr.calcom_evento_precedencia
    into v_actual, v_booking, v_ultimo_en, v_ultima_precedencia
    from public.prospecto pr
   where pr.id = p_prospecto and pr.duplicado_de is null
   for update;
  if not found then
    raise exception 'prospecto % no existe o es duplicado', p_prospecto using errcode = 'CR003';
  end if;

  v_actual_canonico := case v_actual
    when 'negociacion' then 'proposal'
    when 'cerrado' then 'won'
    when 'perdido' then 'lost'
    else v_actual
  end;

  if v_actual_canonico in ('demo', 'proposal', 'pilot', 'won', 'lost') then
    update public.comercial_evento
       set estado_proceso = 'ignorado', procesado_en = clock_timestamp(),
           error = 'avance_comercial_protegido'
     where id = v_evento_id;
    return query select 'ignorado'::text, v_actual;
    return;
  end if;

  if p_creado_en is not null and v_ultimo_en is not null and (
    p_creado_en < v_ultimo_en
    or (p_creado_en = v_ultimo_en and v_precedencia <= coalesce(v_ultima_precedencia, -1))
  ) then
    update public.comercial_evento
       set estado_proceso = 'ignorado', procesado_en = clock_timestamp(), error = 'evento_fuera_de_orden'
     where id = v_evento_id;
    return query select 'ignorado'::text, v_actual;
    return;
  end if;

  if p_tipo = 'BOOKING_CREATED' then
    -- Sin un reloj firmado, CREATED sólo puede establecer la primera reserva
    -- conocida o confirmar la vigente. Si ya está vinculada B, un CREATED(A)
    -- tardío no tiene prueba suficiente para reemplazarla.
    if p_creado_en is null and v_booking is not null and v_booking <> p_externo then
      update public.comercial_evento
         set estado_proceso = 'ignorado', procesado_en = clock_timestamp(), error = 'reserva_no_vigente_sin_reloj'
       where id = v_evento_id;
      return query select 'ignorado'::text, v_actual;
      return;
    end if;
    -- La misma reserva no resucita tras una cancelación/no-show/reprogramación.
    if v_booking = p_externo and v_actual_canonico in ('rescheduled', 'cancelled', 'no-show') then
      update public.comercial_evento
         set estado_proceso = 'ignorado', procesado_en = clock_timestamp(), error = 'reserva_terminal'
       where id = v_evento_id;
      return query select 'ignorado'::text, v_actual;
      return;
    end if;
  elsif v_booking is null then
    -- Sin vínculo previo, sólo un instante firmado permite adoptar un evento
    -- que no sea CREATED. Un evento sin reloj no sabe qué reserva afecta.
    if p_creado_en is null then
      update public.comercial_evento
         set estado_proceso = 'ignorado', procesado_en = clock_timestamp(), error = 'reserva_no_vinculada'
       where id = v_evento_id;
      return query select 'ignorado'::text, v_actual;
      return;
    end if;
  elsif v_booking <> p_externo
      and not (p_tipo = 'BOOKING_RESCHEDULED' and p_externo_anterior = v_booking) then
    update public.comercial_evento
       set estado_proceso = 'ignorado', procesado_en = clock_timestamp(), error = 'reserva_no_vigente'
     where id = v_evento_id;
    return query select 'ignorado'::text, v_actual;
    return;
  end if;

  update public.prospecto
     set estado = v_destino,
         cerrado_en = null,
         calcom_booking_id = p_externo,
         calcom_evento_en = case
           when p_creado_en is not null then p_creado_en
           when p_tipo = 'BOOKING_CREATED' and v_booking is distinct from p_externo then null
           else calcom_evento_en
         end,
         calcom_evento_precedencia = case
           when p_creado_en is not null then v_precedencia
           when p_tipo = 'BOOKING_CREATED' and v_booking is distinct from p_externo then null
           else calcom_evento_precedencia
         end,
         updated_at = clock_timestamp()
   where id = p_prospecto;

  update public.comercial_evento
     set estado_proceso = 'aplicado', procesado_en = clock_timestamp(), error = null
   where id = v_evento_id;
  return query select 'aplicado'::text, v_destino;
end;
$$;

revoke all on function public.aplicar_evento_calcom_tx(
  text, text, text, uuid, jsonb, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.aplicar_evento_calcom_tx(
  text, text, text, uuid, jsonb, timestamptz, text
) to service_role;

comment on function public.aplicar_evento_calcom_tx(
  text, text, text, uuid, jsonb, timestamptz, text
) is '0323: registra y aplica un webhook Cal.com atómicamente. Serializa por prospecto, ordena sólo por createdAt firmado, cuarentena relojes >5 min futuros y vincula eventos sin timestamp exclusivamente al booking vigente.';
