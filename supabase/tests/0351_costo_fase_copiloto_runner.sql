\set ON_ERROR_STOP on
-- AUDITORÍA 28, TC-B2: el CHECK llm_costo_fase_dominio admite 'copiloto' y
-- 'runner' (FaseCosto en costos.ts), y sigue rechazando cualquier otro valor.
begin;
insert into public.tenant(id,nombre) values ('35100000-0000-4000-8000-000000000001','Check351 A');
set local role service_role;
insert into public.llm_costo(tenant_id,fase,modelo,tokens_in,tokens_out,costo_usd) values
 ('35100000-0000-4000-8000-000000000001','copiloto','test-model',10,10,0.01),
 ('35100000-0000-4000-8000-000000000001','runner','test-model',10,10,0.01);
do $$ begin
 if (select count(*) from public.llm_costo where tenant_id='35100000-0000-4000-8000-000000000001' and fase in ('copiloto','runner')) <> 2 then
  raise exception '0351: copiloto/runner no se insertaron';
 end if;
 begin
  insert into public.llm_costo(tenant_id,fase,modelo,tokens_in,tokens_out,costo_usd) values
   ('35100000-0000-4000-8000-000000000001','inventada','test-model',1,1,0.01);
  raise exception '0351: el CHECK dejó pasar una fase inventada';
 exception when check_violation then
  null; -- esperado
 end;
end $$;
reset role;
rollback;
