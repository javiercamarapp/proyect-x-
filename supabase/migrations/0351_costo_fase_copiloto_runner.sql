-- 0351 — TC-B2 (auditoría 28): `FaseCosto` (costos.ts:41) no tiene renglón
-- para el copiloto ni para el runner de agentes — el CHECK `llm_costo_fase_dominio`
-- (0025) los rechazaría si algún día se intenta registrar su costo. Solo
-- amplía el dominio permitido; no hay llamador todavía que registre costo con
-- estas dos fases (verificado: cero `registrarCosto` con fase 'copiloto' o
-- 'runner' en el repo hoy).
begin;

alter table public.llm_costo drop constraint llm_costo_fase_dominio;
alter table public.llm_costo
  add constraint llm_costo_fase_dominio
  check (fase = any (array['ocr','cuadre','escalacion','chat','router','whatsapp','transcripcion','copiloto','runner']));

commit;
