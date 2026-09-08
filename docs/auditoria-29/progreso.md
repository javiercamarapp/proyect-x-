# Progreso — auditoría 29 (8-sep-2026)

Diario de la ronda. Una línea por acción, con su sha cuando la hay. Se escribe
**mientras** avanza, no al cerrar.

## Fase 0 — anclaje

- `git status --porcelain` vacío al arrancar → **autofix habilitado**.
- `list_pull_requests(javiercamarapp/cuadra, open)` → 1 PR abierto, **#409
  `dof-diario: 2026-09-07`**, no es de auditoría. El de la 28 (**#360**) está
  mergeado como `c7bbb83`. → **no aplica continuación**.
- `git log c7bbb83..HEAD -- src/ supabase/ normas/` → **43 commits, 228
  archivos, +10,376 / −1,399** → **no aplica ronda ligera**. → **RONDA COMPLETA**.
- Rama nueva `claude/auditoria-29` sobre `master` = `7bcc319`.
- `npm ci` → exit 0 (el clon de la nube no traía `node_modules`). INFRA resuelta.
- **Línea base de la compuerta**, medida sobre `7bcc319`:
  - `npm test` → **935 archivos, 12,536 pruebas pasan, 6 saltadas, 0 fallan**,
    exit 0, 138.74s.
    **Las 5 fallas INFRA de la 28 (`listen EAFNOSUPPORT ::1` en
    `scripts/ci/e2e/proxy-local.test.ts`) YA NO OCURREN.** Hay que dictaminar a
    quién se acredita (candidato: `6beb5f5`, «IPv6 selectivo en CI», PRU-B4).
  - `npx tsc --noEmit -p .` → **exit 0**.
  - `npm run lint` → **exit 0, 0 errores, 154 avisos** (eran 156 en la 28).
- `docs/auditoria-29/MAPA.md` escrito con la ventana commit por commit.

## Fase 1 — los 12 auditores

Lanzados en un solo mensaje, contexto fresco, uno por rubro, ninguno toca código.

