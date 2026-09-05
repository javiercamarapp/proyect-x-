-- 0335 · Ejecutar con psql ANTES de `supabase db push` / migraciones 0332+.
--
-- psql debe estar en autocommit: CONCURRENTLY está prohibido dentro de la
-- transacción de una migración. lock_timeout evita que el preflight compita
-- indefinidamente con otro DDL. Si falla, no se aplican migraciones todavía y
-- se puede reintentar sin haber bloqueado INSERT/UPDATE/DELETE de la app.
\set ON_ERROR_STOP on

set lock_timeout = '5s';
set statement_timeout = '10min';

do $tablas$
begin
  if to_regclass('public.wa_conversacion') is null
     or to_regclass('public.codigo_pendiente') is null then
    raise exception '0335 preflight requiere migraciones aplicadas hasta 0331';
  end if;
end
$tablas$;

-- Un intento interrumpido o un índice homónimo con columnas/predicado
-- distintos harían que IF NOT EXISTS mintiera. Se retiran concurrentemente.
select format('drop index concurrently %I.%I', n.nspname, c.relname)
  from pg_index i
  join pg_class c on c.oid=i.indexrelid
  join pg_class t on t.oid=i.indrelid
  join pg_am am on am.oid=c.relam
  join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public'
   and c.relname in ('wa_conversacion_purga_idx','codigo_pendiente_purga_idx')
   and not (
     i.indisvalid and i.indisready and not i.indisunique
     and am.amname='btree'
     and i.indnkeyatts=2 and i.indnatts=2
     and i.indpred is null and i.indexprs is null
     and i.indoption='0 0'::int2vector
     and t.oid=case c.relname
       when 'wa_conversacion_purga_idx' then to_regclass('public.wa_conversacion')
       else to_regclass('public.codigo_pendiente') end
     and (select array_agg(a.attname::text order by k.ord)
            from unnest(i.indkey) with ordinality k(attnum,ord)
            join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
           where k.ord<=i.indnkeyatts)=case c.relname
             when 'wa_conversacion_purga_idx' then array['updated_at','id']
             else array['creado_en','id'] end
   )
\gexec

create index concurrently if not exists wa_conversacion_purga_idx
  on public.wa_conversacion(updated_at, id);
create index concurrently if not exists codigo_pendiente_purga_idx
  on public.codigo_pendiente(creado_en, id);

do $indices$
begin
  if not exists (
    select 1 from pg_index i
      join pg_class c on c.oid=i.indexrelid
      join pg_am am on am.oid=c.relam
     where c.oid=to_regclass('public.wa_conversacion_purga_idx')
       and i.indrelid=to_regclass('public.wa_conversacion')
       and i.indisvalid and i.indisready and not i.indisunique
       and am.amname='btree' and i.indnkeyatts=2 and i.indnatts=2
       and i.indpred is null and i.indexprs is null
       and i.indoption='0 0'::int2vector
       and (select array_agg(a.attname::text order by k.ord)
              from unnest(i.indkey) with ordinality k(attnum,ord)
              join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
             where k.ord<=i.indnkeyatts)=array['updated_at','id']
  ) or not exists (
    select 1 from pg_index i
      join pg_class c on c.oid=i.indexrelid
      join pg_am am on am.oid=c.relam
     where c.oid=to_regclass('public.codigo_pendiente_purga_idx')
       and i.indrelid=to_regclass('public.codigo_pendiente')
       and i.indisvalid and i.indisready and not i.indisunique
       and am.amname='btree' and i.indnkeyatts=2 and i.indnatts=2
       and i.indpred is null and i.indexprs is null
       and i.indoption='0 0'::int2vector
       and (select array_agg(a.attname::text order by k.ord)
              from unnest(i.indkey) with ordinality k(attnum,ord)
              join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
             where k.ord<=i.indnkeyatts)=array['creado_en','id']
  ) then
    raise exception '0335 preflight no dejó ambos índices válidos';
  end if;
end
$indices$;

\echo '0335_preflight_retencion_indices: PASS (CONCURRENTLY; tabla, btree, columnas, orden y ausencia de predicado exactos)'
