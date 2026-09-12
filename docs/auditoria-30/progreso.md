# Progreso — auditoría 30 (12-sep-2026)

Una línea por acción, con su sha. Se escribe MIENTRAS avanza, no al cerrar.

| # | Acción | Resultado | Sha |
|---|---|---|---|
| 1 | `list_pull_requests(open)` → solo #459 (`cuota-diesel`, no es de auditoría) | **no aplica continuación** | — |
| 2 | `git log 7bcc319..HEAD -- src/ supabase/ normas/` → 38 commits, 116 archivos, +7,345/−171 | **RONDA COMPLETA** | — |
| 3 | `git checkout -b claude/auditoria-30` sobre `master`=`4e36c82`; árbol limpio | autofix **habilitado** | — |
| 4 | `npm ci` (la nube no trae `node_modules`) | 613 paquetes, 32 s, exit 0 | — |
| 5 | Compuerta: `vitest run` 984 archivos / 12,931 pasan / 6 saltadas / 0 fallan, exit 0 | **verde** | — |
| 6 | Compuerta: `npm run typecheck` | exit 0 | — |
| 7 | Compuerta: `npm run lint` 0 errores / 154 avisos · `lint:ratchet` 0 nuevos | **verde** | — |
| 8 | `docs/auditoria-30/MAPA.md` escrito | — | — |
| 9 | 12 auditores lanzados en un solo mensaje, contexto fresco, uno por rubro | — | — |
| 10 | `git check-ignore` → `.gitignore:36 docs/auditoria-*/` ignora esta carpeta, **pero** `git ls-files docs/auditoria-29/` devuelve 18 archivos trackeados | los reportes se añaden con **`git add -f`**, como las rondas anteriores | — |
| 11 | Los 12 auditores entregaron sus 12 archivos | 0 relanzados, 0 vacíos | — |
| 12 | **Verificación** de AG-C1 abriendo `sat_descarga/ciclo.ts:335-348` | **CONFIRMADO** — `marcar('ignorado')` dentro de `if (!yaDescargado)`; lo hallaron por separado agéntico y rendimiento | — |
| 13 | Prueba que reproduce AG-C1 (`ciclo_flota.test.ts`) — el arnés no guardaba `estatus`, se extendió | **ROJA**: `expected 'disponible' to be 'ignorado'` | — |
| 14 | Arreglo AG-C1: `marcar` sale del condicional, el contador se queda | verde 195/195 en el rubro; suite **12,932** pasan, 0 fallan | `7d5bcdc` |
| 15 | **Verificación** de ARQ-C2 abriendo `cuadre/desde_db.ts:173-177` contra `0349:54-66` | **CONFIRMADO** — la RPC dedupa copias, la resta no; el par estaba cuadrado ANTES de la 0349 | — |
| 16 | Prueba que reproduce ARQ-C2 (`desde_db_efectivo_previo.test.ts`) | **ROJA**: previo sale **90,600**, el correcto es **95,300** → $4,700 de cupo regalados | — |
| 17 | Arreglo ARQ-C2: reusa `copiasDeComprobante` de `engine.ts`, no reimplementa el predicado | verde 574/574 en `cuadre/`; suite **12,933** pasan, 0 fallan | `b740fe0` |
| 18 | **Verificación** del guardia del 15%: `fiscal_agregado_15pct.test.ts:38` leía `0345`, sustituida por la 0349 en esta ventana | **CONFIRMADO** — validaba SQL muerto; 6 migraciones han definido la RPC | — |
| 19 | Arreglo: la ruta se **deriva** (última migración que define la función), con aserción que ancla. **Mutación**: fijándola de vuelta a 0345 la prueba muere | suite **12,934** pasan, 0 fallan; tsc 0; lint 0 errores/154 avisos; **ratchet 0 nuevos** | `7a9b087` |
| 20 | **Tope de 3 vueltas gastado.** Retenidos 3, revertidos 0 | los críticos restantes quedan pendientes/propuestos con razón escrita | — |
