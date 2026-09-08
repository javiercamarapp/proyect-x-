-- 0350 — DAT-M2, mitad SQL (auditoría 28): `chat_conversacion.tenant_id` y
-- `cobranza_contacto.tenant_id` no tenían `on delete cascade`. La mitad de
-- código (orden de `limpiarTenant`, qa-motor.ts) ya se corrigió en el PR #403
-- (T3-04): Storage se borra ANTES del `delete from tenant`, y esas dos tablas
-- se listaban entre "las sobras" que había que barrer a mano precisamente
-- porque el borrado del tenant no se las llevaba solo.
begin;

alter table public.chat_conversacion drop constraint chat_conversacion_tenant_id_fkey;
alter table public.chat_conversacion
  add constraint chat_conversacion_tenant_id_fkey
  foreign key (tenant_id) references public.tenant(id) on delete cascade;

alter table public.cobranza_contacto drop constraint cobranza_contacto_tenant_id_fkey;
alter table public.cobranza_contacto
  add constraint cobranza_contacto_tenant_id_fkey
  foreign key (tenant_id) references public.tenant(id) on delete cascade;

commit;
