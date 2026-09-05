-- 0341 — Una alerta grave puede conservar el mínimo operativo sin permiso
-- para persistir datos del conductor. No se transforma ni habilita ninguna
-- fila legacy: el flag nace false y sólo acepta la forma mínima explícita.
begin;
alter table public.evento_seguridad_flota
  add column if not exists privacidad_minima boolean not null default false;

do $forma$
begin
  if not exists (select 1 from pg_constraint
    where conrelid='public.evento_seguridad_flota'::regclass
      and conname='evento_seguridad_privacidad_minima_check') then
    alter table public.evento_seguridad_flota
      add constraint evento_seguridad_privacidad_minima_check check (
        not privacidad_minima or (
          grave and asset_id is null
          and cardinality(etiquetas)=0
          and lat is null and lng is null and url_evento is null and max_g is null
          and viaje_id is null and operador_id is null and viaje_folio is null
          and isfinite(ocurrido_en)
          and ocurrido_en = (date_trunc('hour', ocurrido_en at time zone 'UTC') at time zone 'UTC')
        )
      );
  end if;
end
$forma$;
comment on column public.evento_seguridad_flota.privacidad_minima is
  'Grave con mínimo operativo: conserva tenant, proveedor, unidad e ID externo para dedupe; sin asset, etiquetas, coordenadas, video, G o referencias al conductor/viaje, y hora UTC truncada. No acredita anonimización total. Legacy false no se habilita por ausencia de referencias.';

-- Se añade un campo de salida al RPC: PostgreSQL exige recrear la firma.
-- Misma transacción, argumentos, orden, lease, tenant/proveedor y SKIP LOCKED.
-- El CHECK de la tabla impide que la rama mínima contenga PII adicional.
-- unidad_id puede quedar NULL por la FK ON DELETE SET NULL. La fila sobrevive,
-- pero tanto el claim como el descubrimiento global exigen unidad presente.
drop function public.reclamar_eventos_seguridad(uuid,text,integer,text,integer,timestamptz);
CREATE OR REPLACE FUNCTION public.reclamar_eventos_seguridad(p_tenant uuid, p_proveedor text, p_limite integer DEFAULT 200, p_worker text DEFAULT 'gps-eventos'::text, p_lease_segundos integer DEFAULT 360, p_ahora timestamp with time zone DEFAULT clock_timestamp())
 RETURNS TABLE(evento_id_externo text, unidad_id uuid, etiquetas text[], lat double precision, lng double precision, ocurrido_en timestamp with time zone, url_evento text, max_g numeric, claim_token uuid, viaje_id uuid, operador_id uuid, viaje_folio text, intentos integer, privacidad_minima boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if p_limite < 1 or p_limite > 1000 then raise exception 'p_limite fuera de 1..1000'; end if;
  if p_lease_segundos < 30 or p_lease_segundos > 600 then raise exception 'lease fuera de 30..600'; end if;
  if btrim(coalesce(p_worker, '')) = '' or length(p_worker) > 120 then raise exception 'worker inválido'; end if;

  return query
  with elegibles as materialized (
    select e.id
      from public.evento_seguridad_flota e
     where e.tenant_id = p_tenant
       and e.proveedor = p_proveedor
       and e.grave
       and e.unidad_id is not null
       and e.procesado_en is null
       and e.muerto_en is null
       and e.aviso_outbox_id is null
       and ((not e.privacidad_minima and e.viaje_id is not null and e.operador_id is not null)
            or e.privacidad_minima)
       and e.siguiente_intento_en <= p_ahora
       and (e.claim_token is null or e.claim_expires_at <= p_ahora)
     order by e.ocurrido_en, e.id
     limit p_limite
     for update skip locked
  )
  update public.evento_seguridad_flota e
     set claim_token = gen_random_uuid(),
         claim_worker = p_worker,
         claim_expires_at = p_ahora + make_interval(secs => p_lease_segundos),
         intentos = e.intentos + 1
    from elegibles x
   where e.id = x.id
  returning e.evento_id_externo, e.unidad_id, e.etiquetas, e.lat, e.lng,
            e.ocurrido_en, e.url_evento, e.max_g, e.claim_token,
            e.viaje_id, e.operador_id, e.viaje_folio, e.intentos, e.privacidad_minima;
end;
$function$;


revoke all on function public.reclamar_eventos_seguridad(uuid,text,integer,text,integer,timestamptz)
  from public,anon,authenticated;
grant execute on function public.reclamar_eventos_seguridad(uuid,text,integer,text,integer,timestamptz)
  to service_role;
-- El cron global también descubre mínimos sin credencial activa.
CREATE OR REPLACE FUNCTION public.listar_outboxes_eventos_pendientes(p_limite integer DEFAULT 100, p_ahora timestamp with time zone DEFAULT clock_timestamp())
 RETURNS TABLE(tenant_id uuid, proveedor text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select e.tenant_id, e.proveedor
  from public.evento_seguridad_flota e
  where e.grave and e.unidad_id is not null and e.procesado_en is null
    and e.muerto_en is null and e.aviso_outbox_id is null
    and ((not e.privacidad_minima and e.viaje_id is not null and e.operador_id is not null)
         or e.privacidad_minima)
    and e.siguiente_intento_en <= p_ahora
  group by e.tenant_id, e.proveedor
  order by min(e.siguiente_intento_en), min(e.ocurrido_en), e.tenant_id, e.proveedor
  limit greatest(1, least(p_limite, 500));
$function$;


commit;
