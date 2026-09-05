-- Upgrade forward-only 0327: simula restos de la primera 0323 y comprueba
-- que el contrato vigente se instala sin conservar hash ni índice legacy.
begin;
set local statement_timeout = '5s';

drop index if exists public.comercial_evento_calcom_replay_hash_uidx;
create unique index comercial_evento_calcom_replay_hash_uidx
  on public.comercial_evento (clave_replay_hash)
  where fuente='calcom' and clave_replay_hash is not null;

-- Un nodo que ejecutó la primera 0323 puede conservar un tombstone ya
-- anonimizado cuyo único identificador restante es el hash determinista.
insert into public.comercial_evento (
  clave_idempotencia, fuente, tipo, payload, ocurrido_en,
  estado_proceso, clave_replay_hash
) values (
  'purgado:calcom:upgrade-legacy', 'calcom', 'BOOKING_CREATED', '{}'::jsonb,
  clock_timestamp() - interval '400 days', 'aplicado', repeat('a', 64)
);

\ir ../migrations/0327_calcom_retencion_forward.sql

select public.purgar_comercial_evento(365, clock_timestamp());

do $$
declare
  indice boolean;
  hash text;
begin
  select exists (
    select 1 from pg_indexes
     where schemaname='public' and indexname='comercial_evento_calcom_replay_hash_uidx'
  ) into indice;
  if indice then raise exception '0327 conservó índice replay legacy'; end if;

  select clave_replay_hash into hash
    from public.comercial_evento
   where fuente='calcom' and clave_replay_hash is not null
   limit 1;
  if hash is not null then
    raise exception '0327 conservó hash legacy';
  end if;
end $$;

rollback;
