-- 0351 — TC-B2 (auditoría 28): `FaseCosto` (costos.ts:41) no tiene renglón
-- para el copiloto ni para el runner de agentes — el CHECK `llm_costo_fase_dominio`
-- (0025, recreado en 0304 con `transcripcion`) los rechazaría si algún día
-- se intenta registrar su costo. Solo amplía el dominio permitido; no hay
-- llamador todavía que registre costo con estas dos fases (verificado: cero
-- `registrarCosto` con fase 'copiloto' o 'runner' en el repo hoy).
--
-- `fase in (...)`, NO `= any(array[...])`: `costos_dominio.test.ts` (auditoría
-- 25, DATOS-A1) escanea TODAS las migraciones buscando el texto `fase in (...)`
-- que define este CHECK y toma la ÚLTIMA como la que gobierna — la misma
-- convención textual que 0025 y 0304 ya usan.
begin;

alter table public.llm_costo drop constraint llm_costo_fase_dominio;
alter table public.llm_costo
  add constraint llm_costo_fase_dominio
  check (fase in ('ocr', 'cuadre', 'escalacion', 'chat', 'router', 'whatsapp', 'transcripcion', 'copiloto', 'runner'));

comment on constraint llm_costo_fase_dominio on llm_costo is
  'Espeja FaseCosto (src/lib/likida/costos.ts). Seis fases en 0025, transcripcion en 0304, copiloto/runner en 0351 (auditoria 28, TC-B2): sin llamador todavia, solo amplia el dominio. costos_dominio.test.ts cruza las dos listas y falla si divergen.';

commit;
