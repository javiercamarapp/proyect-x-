-- AUDITORÍA ENTERPRISE 26 · SEGURIDAD P1.
--
-- La 0294 hizo que las funciones centrales de RLS ignoraran a app_user
-- inactivos. Esta policy de prospección era una excepción: repetía a mano el
-- chequeo de rol y olvidaba `activo`, por lo que un JWT todavía vigente de un
-- superadmin dado de baja conservaba lectura global de PII.
--
-- `app_user_self` también dejaba que una cuenta inactiva leyera su propia
-- fila. No abre otros tenants, pero contradice la garantía de baja a nivel de
-- Data API. El brazo de administradores activos conserva la lectura de filas
-- inactivas para que el roster y la auditoría sigan funcionando.

drop policy if exists prospecto_persona_lee_superadmin on public.prospecto_persona;
create policy prospecto_persona_lee_superadmin on public.prospecto_persona
  for select
  using ((select public.is_superadmin()));

drop policy if exists app_user_self on public.app_user;
create policy app_user_self on public.app_user
  for select
  using (
    (id = (select auth.uid()) and activo)
    or (tenant_id in (select unnest(public.get_user_tenant_ids())))
    or (select public.is_superadmin())
  );

comment on policy prospecto_persona_lee_superadmin on public.prospecto_persona is
  'Solo superadmin ACTIVO mediante is_superadmin(); cierra el JWT residual de una cuenta dada de baja (0320).';
