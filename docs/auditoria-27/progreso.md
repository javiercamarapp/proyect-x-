# Progreso — auditoría 27

Una línea por acción, con su sha. Se escribe MIENTRAS avanza, no al cerrar.

## Fase 0 · Anclaje

- `git status --porcelain` vacío → **árbol limpio, autofix HABILITADO**.
- `list_pull_requests(open)` → 6 PRs, **ninguno de auditoría**. #326
  (`claude/auditoria-26`) cerrado y mergeado el 2026-09-05T23:08:25Z.
- `git log a3c1560..origin/master -- src/ supabase/ normas/` → **181 commits,
  346 archivos, +27,031/−2,631** → **RONDA COMPLETA**, 12 auditores.
- Rama `claude/auditoria-27` creada sobre `origin/master` = `06b2eca4`.
- `npm ci` → 612 paquetes en 43 s (INFRA, resuelta: el clon no trae
  `node_modules`).
- **Compuerta base:** `tsc --noEmit` exit 0 · `lint` 0 errores / 156 avisos ·
  `vitest run` 905 archivos, 12,174 pruebas, **12,168 pasan, 1 saltada, 5
  fallan**.
- Las 5 fallas son **INFRA**: `scripts/ci/e2e/proxy-local.test.ts`, todas
  `listen EAFNOSUPPORT ::1`. Comprobado aparte: este contenedor no tiene
  loopback IPv6. **No cuentan contra el rubro de pruebas** y son la línea
  contra la que se mide cualquier arreglo.
- `docs/auditoria-27/MAPA.md` escrito.

## Fase 1 · Auditores

- 12 auditores lanzados en un solo mensaje, contexto fresco, un rubro cada uno,
  un archivo cada uno, ninguno toca código.
