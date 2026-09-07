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
| 7 | Detritus de un auditor: `scripts/mejora-diaria/__pycache__/…pyc` sin rastrear. Se borró (dos veces; **se regenera solo**, algo corre esos scripts de forma periódica) | ver fila 24 |
| 8 | **FE-2 (ALTO, regresión de `4de95a0`)** verificado abriendo `vista.tsx:45`: `hasta` no tenía el portón que `desde` sí tiene | confirmado real |
| 9 | Prueba que lo reproduce en `vista.test.tsx` → **ROJO medido**: `expected '<main …>' to match /Facturas 0–0 de 350/`, con `Facturas 0–9,800 de 350` literal en el render | rojo |
| 10 | Arreglo: `hasta` clampado a 0 en página vacía; `hayMas` movido a `consumidas` (idéntico al `hasta` viejo) para no ofrecer «Siguientes» hacia otra página vacía | verde (4/4) |
| 11 | Suite completa tras el arreglo: **12,188 pasan / 5 fallan / 1 saltada (12,194)** — línea base + 1 prueba, mismos 5 INFRA | **RETENIDO** |
| 12 | Commit atómico | **`a28c7bb`** |
| 13 | **OP-C1 (CRÍTICO) verificado por mí**, no heredado del auditor: el `DROP` de la firma de 7 args en `0317_…:43`, la firma nueva de 13 en `:45-58`, y el clamp `Math.max(0, Number(codigo) − Number(base))` en `health/migracion.ts:100`. Y contra la API: la corrida **34111978075** de `salud-produccion` en **rojo**, con el issue **#344** abierto («Ya hay un issue abierto (#344); no se duplica») | confirmado real |
| 14 | Aviso al dueño por push: producción con esquema nuevo y código viejo | enviado |

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

## Sigue el diario (vuelta 2 y cierre)

| # | Acción | Resultado / sha |
|---|---|---|
| 15 | **OP-C1 (CRÍTICO)**: prueba nueva `src/app/api/health/migracion.test.ts` → **ROJO medido** (`cotejar('0347','0303')` indistinguible de `cotejar('0303','0303')`) | rojo |
| 16 | Arreglo: `adelante` como magnitud propia con su motivo; `route.ts` degrada con ella; `atras` sin tocar (lo leen `compuerta-deploy.mjs` y `production-candidate.mjs`) | verde (25/25) |
| 17 | `route.test.ts:400` afirmaba la forma exacta con `toEqual` y ganó el campo: se **agregó** `adelante: 0` al caso sano, sin quitar aserciones | verde |
| 18 | Suite completa: **12,191 / 5 / 1 (12,197)**, mismos 5 INFRA · `tsc` exit 0 · `lint` 0 errores/156 avisos | **RETENIDO** |
| 19 | Commit atómico | **`ddf0131`** |
| 20 | Verificación a mano de 7 hallazgos (no de los 130) — ver la tabla en `00-SINTESIS.md` | 7 confirmados, 0 falsos |
| 21 | **FIS-C1 NO se arregló**: exige decidir qué fuente gana (declarada vs. derivada de la clave del SAT) y plomear `regimenFiscal` hasta `desde_db.ts`; la precedencia actual está documentada como deliberada. Queda **propuesto** | propuesto |
| 22 | `tablero.html` + captura headless → `tablero.png`, **mirado**: 12 rubros, notas suman 53, severidades suman 130 | ok |
| 23 | `00-SINTESIS.md` y `RESULTADO.md` escritos, con la reserva sobre la uniformidad del −1 | ok |

**Vueltas de arreglo: 2 de 3.** La tercera no se gastó porque ninguno de los 9
CRÍTICOS restantes era quirúrgico — no por falta de presupuesto.
| 24 | Al cerrar, el `__pycache__` **volvió a aparecer una tercera vez**. Borrarlo era un bucle, así que se atacó la causa: el repo trae **9 scripts Python** y `.gitignore` **no tenía regla para su bytecode**. Se agregó `__pycache__/` + `*.py[cod]`, en **commit aparte** de los dos arreglos con prueba para que se pueda revertir solo. Verificado recreando el directorio: `git status --porcelain` vacío | **`22be35a`** (higiene, no un hallazgo) |
