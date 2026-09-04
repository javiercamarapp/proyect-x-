-- 0339 — Fronteras internas descubiertas por la batería SQL general.
-- La cola no permite INSERT a anon/authenticated, pero service_role tampoco
-- debe poder relacionar un trabajo del tenant A con un operador/viaje de B.
-- Se conservan las FK simples y sus cascadas (patrón 0145). No se corrigen ni
-- borran datos históricos: VALIDATE falla si hay referencias cruzadas.
begin;
set local lock_timeout = '3s';

do $$
begin
  if not exists (select 1 from pg_constraint
    where conrelid = 'public.jornada_derivacion_trabajo'::regclass
      and conname = 'jornada_trabajo_operador_tenant_fkey') then
    alter table public.jornada_derivacion_trabajo
      add constraint jornada_trabajo_operador_tenant_fkey
      foreign key (operador_id, tenant_id) references public.operador(id, tenant_id)
      on delete cascade not valid;
  end if;
  if not exists (select 1 from pg_constraint
    where conrelid = 'public.jornada_derivacion_trabajo'::regclass
      and conname = 'jornada_trabajo_viaje_tenant_fkey') then
    alter table public.jornada_derivacion_trabajo
      add constraint jornada_trabajo_viaje_tenant_fkey
      foreign key (viaje_id, tenant_id) references public.viaje(id, tenant_id)
      on delete cascade not valid;
  end if;
end $$;

alter table public.jornada_derivacion_trabajo
  validate constraint jornada_trabajo_operador_tenant_fkey;
alter table public.jornada_derivacion_trabajo
  validate constraint jornada_trabajo_viaje_tenant_fkey;

-- Estas cuatro funciones devuelven TRIGGER y no son RPC invocables normales.
-- Se elimina el EXECUTE heredado de PUBLIC sin afirmar una explotación RPC.
-- Los triggers existentes siguen ejecutándolas; no requieren ese permiso en
-- la sesión que escribe la fila.
revoke all on function public.validar_vinculo_gps_outbox() from public, anon, authenticated;
revoke all on function public.impedir_sello_por_aceptacion_wa() from public, anon, authenticated;
revoke all on function public.reconciliar_vinculo_aviso_evento() from public, anon, authenticated;
revoke all on function public.reconciliar_receipt_wa_outbox() from public, anon, authenticated;
commit;
