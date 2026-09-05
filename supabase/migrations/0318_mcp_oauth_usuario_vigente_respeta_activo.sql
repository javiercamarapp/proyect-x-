-- ═══════════════════════════════════════════════════════════════════════════
-- 0318 — mcp_oauth_usuario_vigente() TAMBIÉN respeta app_user.activo.
-- (Renumerada de 0316 a 0318: colisión con las migraciones 0316/0317 de la
-- rama paralela claude/audit25-fase3-fiscal, fusionadas en el mismo integrador.)
-- AUDITORÍA 25, SEGURIDAD (MEDIO, re-auditoría). SEC-3.
--
-- `mcp_oauth_usuario_vigente(user, tenant, rol)` (0265) es la RPC que
-- `refrescarTokens` (src/lib/mcp/oauth.ts) llama antes de rotar el par de
-- tokens: si la identidad congelada (tenant_id, rol) ya no calza con la fila
-- REAL de `app_user`, revoca la familia entera. Su propio comentario decía
-- por qué se conformaba con tenant+rol: "app_user no tiene columna de
-- estatus/activo (schema.sql, 0001 en adelante) — no se inventa una aquí".
--
-- Eso dejó de ser cierto el 0294 (BAJA DE USUARIOS): `app_user.activo`
-- existe desde entonces, y la baja NO cambia `tenant_id` ni `rol` — un
-- contador dado de baja sigue teniendo la MISMA identidad congelada, así que
-- `mcp_oauth_usuario_vigente` seguía contestando `true` y su refresco de 60
-- días se renovaba solo, indefinidamente, después de la baja.
--
-- El impacto práctico ya estaba PARCIALMENTE contenido: SEG-A1 (auditoría
-- 25, PR #319) le agregó a `validarAcceso` (oauth.ts) la misma comprobación
-- para el TOKEN DE ACCESO en cada llamada de herramienta MCP — un contador
-- de baja no podía YA ejecutar tools. Pero el refresco (el que le da otros
-- 8 horas de acceso al par siguiente) seguía sin preguntar, así que la
-- ventana de acceso real se cerraba en cuanto el access token de 8h caducaba
-- Y el cliente MCP dejaba de pedir refrescos — no antes. Esta migración
-- cierra el hueco en la raíz, no solo en el síntoma.
--
-- `revocar_mcp_oauth_usuario()` (la RPC hermana de la propia 0265, que tumba
-- de un tiro TODOS los tokens vivos de un usuario) se cablea aparte, desde
-- `desactivarUsuario()` (usuarios_escritura.ts) — no es parte de esta
-- migración, que solo redefine la función SQL.
--
-- Idempotencia: `create or replace function`. Re-aplicarla no cambia nada.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.mcp_oauth_usuario_vigente(
  p_user_id uuid,
  p_tenant_id uuid,
  p_rol text
) returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.app_user
     where id = p_user_id
       and tenant_id = p_tenant_id
       and rol = p_rol
       and activo
  );
$$;

comment on function public.mcp_oauth_usuario_vigente is
  'HALLAZGO 1 (auditoría final 2026-08-29) + SEC-3 (auditoría 25, MEDIO, re-auditoría, 0318): ¿la fila de app_user congelada en un token MCP (tenant_id, rol) sigue siendo cierta AHORA, y sigue activa? refrescarTokens la llama por RPC antes de rotar; false = revoca la familia y niega, igual que el reuso de un refresco. El criterio es identidad + tenant + rol exactos + activo=true — una baja (0294) sin cambiar tenant ni rol también corta el refresco, no solo el access token de 8h (SEG-A1, validarAcceso).';

revoke all on function public.mcp_oauth_usuario_vigente(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.mcp_oauth_usuario_vigente(uuid, uuid, text) to service_role;
