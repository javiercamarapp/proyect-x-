-- Prueba hostil de 0319. Ejecutar después de las migraciones con:
--   psql -X -v ON_ERROR_STOP=1 -f supabase/tests/0319_capacidad_jornada_wa.sql
-- Todo ocurre en una transacción que se revierte.

begin;

create or replace function pg_temp.preparar_jornadas(p_cantidad integer)
returns void language plpgsql as $$
declare
  v_tenant constant uuid := '31900000-0000-4000-8000-000000000001';
begin
  delete from public.jornada_derivacion_trabajo where tenant_id = v_tenant;
  delete from public.viaje where tenant_id = v_tenant;
  delete from public.operador where tenant_id = v_tenant;
  delete from public.tenant where id = v_tenant;
  insert into public.tenant(id, nombre) values (v_tenant, 'Prueba capacidad 0319');
  insert into public.operador(id, tenant_id, nombre, telefono)
  select md5('0319-operador-' || g)::uuid, v_tenant, 'Operador ' || g, '52999' || lpad(g::text, 8, '0')
    from generate_series(1, p_cantidad) g;
  insert into public.viaje(id, tenant_id, operador_id, avisado_en, aceptado_en)
  select md5('0319-viaje-' || g)::uuid,
         v_tenant,
         md5('0319-operador-' || g)::uuid,
         '2026-09-02 11:59:00+00'::timestamptz + make_interval(secs => g),
         '2026-09-02 12:00:00+00'::timestamptz + make_interval(secs => g)
    from generate_series(1, p_cantidad) g;
  perform public.sincronizar_jornadas_por_derivar('2026-09-02 18:00:00+00', 1);
end;
$$;

-- Bordes exactos del lote.
do $$
declare
  n integer;
  obtenidos integer;
  quedan boolean;
  tokens uuid[];
begin
  foreach n in array array[0, 1, 399, 400, 401, 1520] loop
    perform pg_temp.preparar_jornadas(n);
    select count(*), coalesce(bool_or(r.hay_mas), false), array_agg(r.claim_token)
      into obtenidos, quedan, tokens
      from public.reclamar_jornadas_por_derivar(400, 'borde-' || n, 180) r;
    if obtenidos <> least(n, 400) then
      raise exception 'borde %: obtuvo %, esperaba %', n, obtenidos, least(n, 400);
    end if;
    if quedan is distinct from (n > 400) then
      raise exception 'borde %: hay_mas %, esperaba %', n, quedan, n > 400;
    end if;
    perform public.liberar_jornadas_por_derivar('borde-' || n, tokens);
  end loop;
end;
$$;

-- El caso que rompió el cursor original: se reclaman 400 pero el reloj sólo
-- deja intentar/ACKear 10; los otros 390 se liberan. Debe converger a 1,520,
-- no girar para siempre sobre los mismos 190.
select pg_temp.preparar_jornadas(1520);
create temporary table audit_consumidos(id uuid primary key) on commit drop;
create temporary table audit_lote(
  id uuid, claim_token uuid, aceptado_en timestamptz
) on commit drop;

do $$
declare
  corrida integer;
  r record;
  v_owner text;
  v_tokens uuid[];
begin
  for corrida in 1..152 loop
    v_owner := 'parcial-' || corrida;
    truncate audit_lote;
    insert into audit_lote(id, claim_token, aceptado_en)
    select x.id, x.claim_token, x.aceptado_en
      from public.reclamar_jornadas_por_derivar(400, v_owner, 180) x;

    for r in select * from audit_lote order by aceptado_en, id limit 10 loop
      if not public.finalizar_jornada_derivacion(r.claim_token, v_owner, true, null, 3600) then
        raise exception 'ACK parcial cercado inesperadamente en corrida %', corrida;
      end if;
      insert into audit_consumidos values (r.id) on conflict do nothing;
    end loop;
    select array_agg(l.claim_token) into v_tokens
      from audit_lote l
     where not exists (select 1 from audit_consumidos a where a.id = l.id);
    perform public.liberar_jornadas_por_derivar(v_owner, v_tokens);
  end loop;
end;
$$;

do $$
declare n integer;
begin
  select count(*) into n from audit_consumidos;
  if n <> 1520 then raise exception 'consumo parcial dejó hambre: % de 1520', n; end if;
end;
$$;

-- Caída antes/durante ACK: mientras el lease vive nadie roba el claim; al
-- expirar, reaparece con un token distinto y el fence viejo ya no puede ACKear.
select pg_temp.preparar_jornadas(1);
create temporary table audit_crash as
select * from public.reclamar_jornadas_por_derivar(1, 'muerto', 30);

do $$
declare n integer;
begin
  select count(*) into n from public.reclamar_jornadas_por_derivar(1, 'prematuro', 30);
  if n <> 0 then raise exception 'otro worker robó un lease vivo'; end if;
end;
$$;

update public.jornada_derivacion_trabajo
   set lease_expires_at = clock_timestamp() - interval '1 second'
 where claim_owner = 'muerto';
create temporary table audit_recuperado as
select * from public.reclamar_jornadas_por_derivar(1, 'recuperador', 30);

do $$
declare viejo uuid; nuevo uuid;
begin
  select claim_token into viejo from audit_crash;
  select claim_token into nuevo from audit_recuperado;
  if nuevo is null or nuevo = viejo then raise exception 'la caída no produjo un fence nuevo'; end if;
  if public.finalizar_jornada_derivacion(viejo, 'muerto', true, null, 0) then
    raise exception 'un ACK tardío atravesó el fence';
  end if;
  if not public.finalizar_jornada_derivacion(nuevo, 'recuperador', true, null, 0) then
    raise exception 'el worker recuperador no pudo ACKear';
  end if;
end;
$$;

-- Dos workers solapados: SKIP LOCKED entrega 400 disjuntos a cada uno.
select pg_temp.preparar_jornadas(1520);
create temporary table audit_worker_a as
select * from public.reclamar_jornadas_por_derivar(400, 'worker-a', 180);
create temporary table audit_worker_b as
select * from public.reclamar_jornadas_por_derivar(400, 'worker-b', 180);

do $$
declare repetidos integer; total integer; r record;
begin
  select count(*) into repetidos from audit_worker_a a join audit_worker_b b using(id);
  select count(*) into total from (
    select id from audit_worker_a union select id from audit_worker_b
  ) u;
  if repetidos <> 0 or total <> 800 then
    raise exception 'claims solapados: repetidos %, total %', repetidos, total;
  end if;
  for r in select claim_token from audit_worker_a loop
    perform public.finalizar_jornada_derivacion(r.claim_token, 'worker-a', true, null, 3600);
  end loop;
  for r in select claim_token from audit_worker_b loop
    perform public.finalizar_jornada_derivacion(r.claim_token, 'worker-b', true, null, 3600);
  end loop;
end;
$$;

create temporary table audit_worker_c as
select * from public.reclamar_jornadas_por_derivar(400, 'worker-c', 180);
create temporary table audit_worker_d as
select * from public.reclamar_jornadas_por_derivar(400, 'worker-d', 180);

do $$
declare total integer;
begin
  select count(*) into total from (
    select id from audit_worker_a union select id from audit_worker_b
    union select id from audit_worker_c union select id from audit_worker_d
  ) u;
  if total <> 1520 then raise exception 'dos workers dejaron hambre: % de 1520', total; end if;
end;
$$;

-- El lease singleton acota el fan-out incluso entre minutos; los fences
-- incorrectos no renuevan ni finalizan la cadena vigente.
do $$
declare primera uuid; segunda uuid; tercera uuid;
begin
  update public.wa_drenado_cadena set cadena_id = null, lease_expires_at = null where singleton;
  primera := public.iniciar_cadena_wa(180);
  segunda := public.iniciar_cadena_wa(180);
  if primera is null or segunda is not null then raise exception 'se abrieron dos cadenas WA'; end if;
  if public.renovar_cadena_wa(gen_random_uuid(), 180) then raise exception 'renovó fence WA ajeno'; end if;
  if not public.renovar_cadena_wa(primera, 180) then raise exception 'no renovó fence WA vigente'; end if;
  if public.finalizar_cadena_wa(gen_random_uuid()) then raise exception 'finalizó fence WA ajeno'; end if;
  if not public.finalizar_cadena_wa(primera) then raise exception 'no finalizó fence WA vigente'; end if;
  tercera := public.iniciar_cadena_wa(180);
  if tercera is null or tercera = primera then raise exception 'no reabrió cadena WA con UUID nuevo'; end if;
end;
$$;

rollback;
