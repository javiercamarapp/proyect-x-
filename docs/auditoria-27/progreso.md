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
- **backend** entregó: 5/10 (antes 6), 3 ALTO · 1 MEDIO, 0 CRÍTICO.

## Fase 2 · Verificación adversarial (abriendo el archivo, uno por uno)

- **BE-1 (ALTO) CONFIRMADO** — la carta muerta que bloquea el cierre para
  siempre. Verificado abriendo los dos lados de la asimetría:
  `conv.ts:952-968` consulta `wa_evento_pendiente` **sin filtrar `intentos`**
  (y su propio comentario lo declara: «incluidas las que agotaron intentos»),
  mientras `0325:56-57` acota `listar_wa_pendientes` a `w.intentos < 5`. Una
  fila con `intentos = 5` es por definición inalcanzable para el procesador y
  eterna para la guardia: **una espera insatisfacible por construcción**.
  `processor.ts:3746-3757` obedece con `soltarClaim(true)` y `return`, sin un
  solo mensaje al chofer.
  → **NO se arregla esta noche.** El comportamiento está fijado a propósito por
  una prueba de la auditoría 24 (`conv_foto_anterior_aud24.test.ts:71-75`,
  «una foto agotada sigue siendo evidencia pendiente»). Cerrarlo exige **voltear
  esa aserción** o darle a la carta muerta un camino de salida, y las dos
  direcciones pierden comportamiento que alguien decidió: es una convención de
  producto, no un cambio quirúrgico. Queda **pendiente con razón escrita**,
  siguiendo el precedente de la 26 con el REP `'99'`.
- **BE-3 (ALTO, REINCIDENTE) CONFIRMADO** — y el auditor acertó al distinguir lo
  cerrado de lo abierto. Verificado que `0344` **sí** cubre las cuatro consultas
  que la 26 enumeró, y que las otras cuatro agregadas sobre `liquidacion`
  **no**: `grep -c revision` sobre la última definición vigente de cada una da
  **0** en `0150` (`liquidado_semanal_tenant`, `operadores_detalle_tenant`),
  `0112` (`serie_comparativa_tenant`) y `0174` (`stats_operador_tenant`).
  `liquidado_semanal_tenant` (`0150:364-371`) suma `total_comprobado` con un
  `where` de solo `tenant_id` y `created_at`.
  → **Candidato a arreglo**: es aplicar el predicado que `0344` ya estableció,
  y el repo tiene idioma para probarlo sin base (`arco_search_path.test.ts`
  ancla propiedades sobre **la última definición vigente**, no sobre una
  migración concreta).

## Fase 4 · Arreglo

### Vuelta 1 — `5569437e` · OP-C2 (CRÍTICO) · **RETENIDO**

`.github/workflows/salud-produccion.yml` — el paso que cierra el issue pasó de
`if: success()` a `if: success() && github.event_name != 'push'`.

- Prueba que lo reproduce: `scripts/ci/compuerta_deploy_aud24.test.ts`, extrae
  la condición del paso «Cerrar el issue al recuperarse». **Rojo medido**
  (`Received: "success()"`) → **verde**.
- Suite completa: **12,169 pasan, 5 fallan** = línea base + la prueba nueva,
  mismas 5 INFRA. Retenido.

### Vuelta 2 — BE-3 (ALTO, REINCIDENTE) · **REVERTIDO**

Se escribió `supabase/migrations/0348_agregados_sin_rechazadas.sql` (las cuatro
agregadas restantes con `revision <> 'rechazada'`, misma decisión que la 0344) y
una prueba de invariante estático anclada a **la última definición vigente**
(idioma de `arco_search_path.test.ts`). La prueba midió **rojo en las cuatro y
verde en las dos que la 0344 ya cubría** —discriminaba bien— y pasó a verde con
la migración.

**Y la suite completa se puso roja: 41 fallos en 3 archivos.** Causa medida, no
supuesta: `scripts/ci/staging-recovery.mjs:121` fija el inventario de
migraciones a la vista —

```
if (expected.length !== 324 || new Set(expected).size !== 324 || expected.at(-1) !== '0347')
  fail('RECOVERY_LOCAL_MIGRATIONS');
```

— así que **cualquier** migración nueva tumba 35 pruebas de
`staging-recovery.test.ts` hasta que alguien suba el número.

**Se revirtió, y la razón importa:** ese `324/'0347'` no es un fixture, es un
**enclavamiento de seguridad** sobre una operación destructiva (el `reset` de
staging del PR #335-337), fijado al conjunto exacto de migraciones contra el que
esa recuperación se diseñó y se revisó. Subirlo a `325/'0348'` de madrugada,
sin que nadie compruebe que la recuperación sigue siendo válida contra el
conjunto nuevo, es **debilitar un candado destructivo** y además salirse del
alcance del hallazgo. La regla de la skill y el encargo coinciden: suite roja →
se revierte, y el arreglo que se sale de su alcance es la causa documentada de
PRs rechazados.

BE-3 vuelve a **pendiente**, con el arreglo ya diseñado y medido para que quien
lo retome no repita el trabajo.

**Y de aquí sale un hallazgo nuevo que no tenía ningún auditor** (OP-C4, ALTO):
el repo **no puede aceptar UNA SOLA migración nueva sin ponerse rojo**. El
próximo que escriba una migración legítima —cualquiera— se encuentra 35 pruebas
en rojo sin relación aparente con lo que tocó. Verificado revirtiendo: al quitar
la 0348, `staging-recovery.test.ts` vuelve a 35/35 en verde.
