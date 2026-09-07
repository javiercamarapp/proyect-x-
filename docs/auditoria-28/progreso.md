# Progreso — auditoría 28 (7-sep-2026)

Una línea por acción, escrita **mientras** avanza. Un diario que se escribe al
final no existe cuando se necesita.

| # | Acción | Resultado / sha |
|---|---|---|
| 1 | Decidir tamaño de ronda ANTES de gastar tokens: `list_pull_requests(open)` → 14 PRs, **ninguno de auditoría** (#346-#357 `codeql/lote-*`, #358/#359 dependabot). `git log 06b2eca4..HEAD -- src/ supabase/ normas/` → **3 commits, 7 archivos, +225/−75** | → **RONDA COMPLETA**, 12 auditores, rama nueva |
| 2 | `git checkout -b claude/auditoria-28` sobre `master` = `d56e626`. `git status --porcelain` vacío → **autofix habilitado** | rama creada |
| 3 | `npm ci` — el clon de la nube no traía `node_modules` | exit 0 (INFRA, resuelta) |
| 4 | Compuerta / línea base medida | ver abajo |
| 5 | `docs/auditoria-28/MAPA.md` escrito con la ventana commit por commit | — |
| 6 | 12 auditores lanzados en un solo mensaje, contexto fresco, uno por rubro | — |

## Línea base de la compuerta (salida real, medida a las 11:0x del 7-sep)

```
$ npm test          (vitest run)
 Test Files  1 failed | 907 passed (908)
      Tests  5 failed | 12187 passed | 1 skipped (12193)
TEST_EXIT=1

$ npx tsc --noEmit -p .
TSC_EXIT=0            (sin una sola línea de salida)

$ npm run lint
✖ 156 problems (0 errors, 156 warnings)
LINT_EXIT=0
```

**Los 5 fallos son INFRA, no código** — los mismos 5 de la ronda 27, todos en
`scripts/ci/e2e/proxy-local.test.ts`:

```
× HTTP [::1] contra servidor exclusivo ::1 conserva ruta/query sin DNS
× HTTP localhost contra servidor exclusivo ::1 conserva ruta/query sin DNS
× CONNECT [::1] contra servidor exclusivo ::1 transporta head sin DNS
× CONNECT localhost contra servidor exclusivo ::1 transporta head sin DNS
× la IP explícita 127.0.0.1 no salta al servidor de la otra familia ::1
```

Causa: `Error: listen EAFNOSUPPORT: address family not supported ::1` — el
contenedor de la nube no tiene loopback IPv6 y la prueba exige `::1`. No es un
defecto del repo y **no cuenta contra el rubro de pruebas**.

**Contra esta línea base se mide todo arreglo de la ronda: 5 fallos infra, ni
uno más.** Creció respecto a la 27 (12,174 → 12,193 pruebas, +19) por las
pruebas nuevas de `4de95a0` y `18c7ebd`.
