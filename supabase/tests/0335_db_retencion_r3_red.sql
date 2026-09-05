-- 0335 · Error 0104 explícito y rollout sin DDL bloqueante en la migración.
-- Sólo sobre PostgreSQL local/staging desechable con 0335 aplicado.
\set ON_ERROR_STOP on
begin;

do $catalogo$
declare fks_entrantes integer;
begin
  if not exists (
    select 1 from pg_index i join pg_class c on c.oid=i.indexrelid join pg_am am on am.oid=c.relam
     where i.indexrelid='public.wa_conversacion_purga_idx'::regclass
       and i.indrelid='public.wa_conversacion'::regclass
       and i.indisvalid and i.indisready and not i.indisunique
       and am.amname='btree' and i.indnkeyatts=2 and i.indnatts=2
       and i.indpred is null and i.indexprs is null
       and i.indoption='0 0'::int2vector
       and (select array_agg(a.attname::text order by k.ord)
              from unnest(i.indkey) with ordinality k(attnum,ord)
              join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
             where k.ord<=i.indnkeyatts)=array['updated_at','id']
  ) or not exists (
    select 1 from pg_index i join pg_class c on c.oid=i.indexrelid join pg_am am on am.oid=c.relam
     where i.indexrelid='public.codigo_pendiente_purga_idx'::regclass
       and i.indrelid='public.codigo_pendiente'::regclass
       and i.indisvalid and i.indisready and not i.indisunique
       and am.amname='btree' and i.indnkeyatts=2 and i.indnatts=2
       and i.indpred is null and i.indexprs is null
       and i.indoption='0 0'::int2vector
       and (select array_agg(a.attname::text order by k.ord)
              from unnest(i.indkey) with ordinality k(attnum,ord)
              join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
             where k.ord<=i.indnkeyatts)=array['creado_en','id']
  ) then
    raise exception '0335 índices de preflight ausentes o inválidos';
  end if;
  select count(*) into fks_entrantes from pg_constraint
   where contype='f'
     and confrelid in ('public.wa_conversacion'::regclass,'public.codigo_pendiente'::regclass);
  if fks_entrantes<>0 then
    raise exception '0335 la tanda fuente no acota cascadas: % FK(s) entrantes',fks_entrantes;
  end if;
end
$catalogo$;

-- La sustitución vive en esta transacción y rollback restaura 0335.
create or replace function public.purgar_wa_conversacion(
  p_dias integer default 180,
  p_ahora timestamptz default now(),
  p_vence timestamptz default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$ begin perform pg_sleep(1); return '{}'::jsonb; end $$;

create or replace function public.purgar_codigo_pendiente(
  p_dias integer default 180,
  p_ahora timestamptz default now(),
  p_vence timestamptz default null
) returns jsonb language sql security definer set search_path=public,pg_temp
as $$ select '{"borradas":7,"parcial":false,"agotado":true}'::jsonb $$;

set local statement_timeout='100ms';

do $fallo_0104$
declare r jsonb;
begin
  r:=public.mantenimiento_de_datos(30,now());
  if (r->>'conversacionesParcial')::boolean is not true
     or r->>'conversacionesError' not like '57014:%statement timeout%'
     or r->>'codigosError' is not null
     or (r->>'codigosPurgados')::bigint<>7 then
    raise exception '0335 fallo 0104 se confundió con agotado: %',r;
  end if;
end
$fallo_0104$;
set local statement_timeout=0;
rollback;
begin;

-- p_vence no puede ser una comprobación cosmética entre sentencias. Un
-- trigger deliberadamente lento demuestra que cada llamada calcula una tanda
-- compatible con el tiempo restante, tanto en 0104 como en producto.
insert into public.tenant(id,nombre) values
  ('33500000-0000-4000-8000-000000000098','Deadline 0104 0335'),
  ('33500000-0000-4000-8000-000000000099','Deadline producto 0335');
insert into public.wa_conversacion(tenant_id,telefono,updated_at)
select '33500000-0000-4000-8000-000000000098','5299'||lpad(g::text,8,'0'),now()-interval '400 days'
  from generate_series(1,120) g;
insert into public.producto_evento(tenant_id,pantalla,accion,created_at)
select '33500000-0000-4000-8000-000000000099','viajes','pageview',now()-interval '400 days'
  from generate_series(1,120);

create function pg_temp.lento_0335() returns trigger language plpgsql
as $$ begin perform pg_sleep(0.01); return old; end $$;
create trigger lento_wa_0335 before delete on public.wa_conversacion
for each row execute function pg_temp.lento_0335();
create trigger lento_producto_0335 before delete on public.producto_evento
for each row execute function pg_temp.lento_0335();

do $deadline_real$
declare inicio timestamptz; duracion interval; wa jsonb; producto jsonb;
begin
  inicio:=clock_timestamp();
  wa:=public.purgar_wa_conversacion(180,now(),clock_timestamp()+interval '100 milliseconds');
  duracion:=clock_timestamp()-inicio;
  raise notice '0335 deadline 0104: r=% duración=%',wa,duracion;
  if duracion>interval '500 milliseconds'
     or (wa->>'borradas')::integer not between 1 and 10
     or (wa->>'parcial')::boolean is not true then
    raise exception '0335 deadline 0104 no acotó trabajo: r=% duración=%',wa,duracion;
  end if;

  inicio:=clock_timestamp();
  producto:=public.mantener_producto_evento(365,now(),clock_timestamp()+interval '100 milliseconds');
  duracion:=clock_timestamp()-inicio;
  raise notice '0335 deadline producto: r=% duración=%',producto,duracion;
  if duracion>interval '500 milliseconds'
     or (producto->>'detalleBorrado')::integer not between 1 and 10
     or (producto->>'parcial')::boolean is not true then
    raise exception '0335 deadline producto no acotó trabajo: r=% duración=%',producto,duracion;
  end if;
end
$deadline_real$;

rollback;
\echo '0335_db_retencion_r3: PASS (error 0104 explícito, parcial, índices válidos)'
