# Pruebas — auditoría 29

**Nota: 7/10** (antes 6). **Razón del movimiento: se atacó y subió.** No es un
punto regalado por «hubo commits en mi rubro»: es el resultado de volver a
correr, una por una, las **mutaciones que en la 28 sobrevivieron**, y verlas
morir. De mis **14 hallazgos abiertos** (1 crítico + 3 altos + 4 medios + 3
bajos heredados de la 27, más los 4 nuevos de la 28), **11 están cerrados con
prueba que se pone roja** cuando reviento el arreglo, y lo comprobé
mutando, no leyendo el asunto del commit. La suite pasó de matar 5 de 15
mutaciones (33%) a matar **35 de 44 (80%)**.

No llega a 8 por dos cosas concretas, las dos medidas: **la regla que abre la
facilidad del 15% en efectivo vive en TRES copias y solo UNA quedó anclada** —
las otras dos le conceden la facilidad a un RESICO con 10,146 pruebas en verde—,
y **PRU-C1 cumple su cuarta ronda como REINCIDENTE** (tres capas verdes sobre
una entrada que producción no puede producir).

Riesgo mayor del rubro, hoy: **`9aefea0` ancló la elegibilidad del 15% en el
formulario de onboarding y dejó sin una sola prueba las otras dos copias de la
misma regla —la entrevista por WhatsApp (`entrevista.ts:713`) y el alta de flota
del superadmin (`administracion.ts:200`)—, que son por donde de verdad nace una
flota; meterle `'626'` (RESICO) a cualquiera de las dos sobrevive 699 archivos y
10,146 pruebas.**

---

## Cómo se midió (repetible)

- **Worktree desechable**: `git worktree add --detach <scratchpad>/wt HEAD` sobre
  `7bcc319`, con `node_modules` por symlink. **Borrado al terminar**
  (`git worktree list` → una sola entrada) y `git status --porcelain` del árbol
  vivo **vacío**. Ni un archivo del repo tocado fuera de este entregable.
- **Inventario propio**: `find src scripts -name '*.test.ts*' | wc -l` → **933**
  (coincide con el MAPA). Con `supabase/` incluido, **935** — que es la cifra que
  cita el commit `7bcc319` al medir cobertura, y por eso las dos aparecen aquí.
- **44 mutaciones dirigidas**, cada una con su corrida acotada; las que
  sobrevivieron el alcance corto se re-corrieron contra un alcance grande
  (`src/lib/` = 699 archivos / 10,146 pruebas, o `src/lib/likida/` = 516 / 7,906)
  para no confundir «no la cubre este archivo» con «no la cubre nadie».
- **NO corrí la suite completa** (la corre el orquestador) ni
  `pruebas-manuales/*.prueba.ts` ni `npm run build`.
- **Evidencia de CI leída de las corridas reales**, no del YAML: `ci.yml` y
  `ci-postgres.yml` verdes sobre `7bcc319` (master) y sobre `2dbe2d8`
  (`claude/auditoria-29`), las dos del 8-sep.

### El dato de línea base que me tocaba dictaminar

**Las 5 fallas de `scripts/ci/e2e/proxy-local.test.ts` las cerró `6beb5f5`
(PRU-B4), y no otra cosa.** Lo medí en este contenedor:

```
npx vitest run scripts/ci/e2e/proxy-local.test.ts
Test Files  1 passed (1)      Tests  13 passed | 5 skipped (18)
```

**13 pasan, 5 se saltan** — exactamente el conteo que el commit predijo. El
mecanismo es honesto y lo verifiqué en el fuente: `detectarIpv6Loopback()`
(`scripts/ci/e2e/proxy-local.test.ts:29-36`) consulta `os.networkInterfaces()` y
el `it.skipIf(!ipv6Loopback)` está puesto **solo** en los 5 casos que bindean en
`::1` (`:148`, `:165`, `:181`); los de `127.0.0.1` corren siempre (`:184` es
`it(...)` a secas). No es un `skip` global disfrazado. **Acreditable a
`pruebas`.** Y tiene consecuencia de segundo orden que sí importa: sin esos 5
rojos, `npm run test:coverage` vuelve a **imprimir y evaluar umbrales**, que es
lo que hizo posible cerrar PRU-M4.

---

## Estado de los hallazgos abiertos de la 28

Verificados **uno por uno abriendo el archivo y mutando**, no leyendo el asunto
del commit.

| ID | Hallazgo | Veredicto | Evidencia |
|---|---|---|---|
| **PRU-C1** (CRÍT) | tres capas verdes sobre `ocr_extra.renglones`, entrada que producción no puede producir | **REINCIDENTE (4.ª ronda)** | `engine.ts:986` sigue leyendo `(g.ocrExtra)?.renglones`; `intake/ocr.ts:62-78` conserva intacto el comentario de la retirada del esquema, y `repo.ts:383` escribe `ocr_extra` desde `g.ocrExtra` sin que nadie ponga `renglones`. Cero escritores hoy |
| **PRU-A1** (ALTO) | 29 de 47 arneses de `supabase/tests/` sin invocador; exenciones que los citan | **REINCIDENTE** | Medido hoy: `supabase/tests/` tiene **47 archivos**, **29** no aparecen ni una vez en `ci-postgres.yml`. Y crucé las exenciones: **11 entradas de `EXENTAS`** (`migraciones_verificadas.test.ts:52+`) citan **solo** arneses huérfanos — 0324, 0325, 0327, 0328, 0329, 0330, 0331, 0333, 0334, 0336, 0337; cuatro de ellas ya lo dicen por escrito («no afirma integración en ci-postgres») |
| **PRU-A2** (ALTO) | la paridad que sostiene la exención de la 0317 es `f(x) === f(x)` | **REINCIDENTE** | `git log c7bbb83..HEAD -- src/lib/likida/fiscal_agregado.test.ts` → cero commits. `:125-161` sigue reimplementando en TS las mismas fórmulas que dice verificar |
| **PRU-A3** (ALTO) | el bloque 47 sale `✓ ok` con 8 de 11 mediciones sin calificar | **CERRADO** | Mutación #42: `calificar-verificacion.mjs:133` `if (grupos > 1 \|\| cierre === -1 \|\| clavesTrasCierre.length > 0)` → `if (false)` ⇒ **2 rojos** en `calificar_forma_esperado_aud28.test.ts`. Y `correr-verificaciones.mjs:194` hace `sin_calificar` fatal **sin lista de excepciones**. Confirmado contra Postgres real: `ci-postgres.yml` verde en `7bcc319` (run 34193447143) |
| **PRU-M4** (MEDIO) | trinquete de cobertura con 4.3–7.9 puntos de holgura | **CERRADO** | `vitest.config.ts:129-134` ahora dice `lines 86 / statements 83 / branches 73 / functions 86`, derivados con `floor(medido − 0.5)` de una medición fechada y con sha (84.10/74.05/87.11/86.86 sobre `42bfa2b9`). **La puerta muerde hoy**: `ci.yml` corre `npm run test:coverage` en cada push (`.github/workflows/ci.yml:79-80`) y está **verde** sobre `7bcc319` y sobre esta rama |
| **PRU-M5** (MEDIO) | las tres escrituras de jornada pierden sus candados con la suite verde | **CERRADO** | Mutaciones #10 y #11: quitar `.is('anulado_en', null)` (`jornada/repo.ts:524`) y `.eq('estado','abierto')` (`:556`) ⇒ rojo en `jornada/repo.test.ts`. El mock **registra la cadena** (`repo.test.ts:31-45`), no devuelve lo que la prueba quiere oír |
| **PRU-M6** (MEDIO) | `decidirFacturaProveedor` pierde su candado de idempotencia | **CERRADO** | Mutación #12: borrar `.eq('estado','pendiente')` (`proveedores.ts:322`) ⇒ rojo en `proveedores_decidir.test.ts` |
| **PRU-B2** (BAJO) | `contarConCfdi` puede devolver `0` cuando la base falla | **CERRADO** | Mutación #13: `pendientes.ts:221` `return null` → `return 0` ⇒ rojo en `contar_con_cfdi.test.ts` |
| **PRU-B3** (BAJO) | `sat_descarga/escritura.ts` sin un solo archivo de prueba | **CERRADO** | Existe `escritura.test.ts`, 20 casos. Mutación #14: `escritura.ts:157` `if (!cfg.activa)` → `if (false)` ⇒ rojo |
| **PRU-B4** (BAJO) | la prueba que exige loopback IPv6, sin `skipIf` ni requisito declarado | **CERRADO** | Ver arriba: 13 pasan / 5 se saltan, `skipIf` selectivo y requisito escrito en la cabecera del archivo |
| **PRU-M1** (MEDIO) | `vista.test.tsx` renderiza `?p=99` y sus aserciones son ciegas a la cifra | **CERRADO** | Mutaciones #3, #4, #5: `vista.tsx:139` `{false ? (`, `:145` `numero(cobranza.total)` → `numero(cobranza.facturas.length)`, `:125` `valor={0}` ⇒ **las tres rojas** en `vista.test.tsx` |
| **PRU-M2** (MEDIO) | las pruebas afirman la ausencia del mensaje malo, nunca la presencia del bueno | **CERRADO** | Mutación #2: `actividad.tsx:72` `<AreaChartSimple .../>` → `<></>` ⇒ rojo con `expected '' to contain '<svg'`. Es una aserción **positiva sobre el nodo** |
| **PRU-M3** (MEDIO) | el blindaje FE-5 de `Actividad` sin una sola prueba | **CERRADO** | Mutación #1: `actividad.tsx:46` deja solo `modo === 'historico' && porMes === null` ⇒ **2 rojos** («modo semanal/mensual con porDia=null dice que no pudo cargar») |
| **PRU-B1** (BAJO) | 4 de los 10 candados de `prepare-build-env.mjs` sin una aserción | **CERRADO** | Las cuatro mutaciones ahora mueren: #6 quitar `O_NOFOLLOW` de `openSync` (`:54`) ⇒ rojo «un symlink en la ruta del .env no se sigue»; #7 `ADMIN_KEYS.slice(0,2)` en `:86` ⇒ rojo sobre `SUPABASE_DB_URL`; #8 quitar `!item.disabled` (`:74`) ⇒ rojo; #9 `ADMIN_KEYS.slice(0,1)` en `:59` ⇒ **2 rojos**. Además el candado de symlink dejó de ser un `lstat` (TOCTOU) y pasó a `O_NOFOLLOW`: la causa raíz, no el síntoma |

**11 cerrados · 3 REINCIDENTES.** Los tres reincidentes son los que necesitan
`psql` o una decisión de producto, y son exactamente los que ningún commit de la
ventana tocó (`git log c7bbb83..HEAD` sobre esos archivos: cero).

---

## Mutaciones medidas esta ronda

**44 probadas · 35 muertas · 9 sobrevivientes.**

| # | Mutación literal | Prueba que debía matarla | Resultado |
|---|---|---|---|
| 1 | `actividad.tsx:46` → `if (modo === 'historico' && porMes === null)` | `actividad.test.tsx` (PRU-M3) | **muerta** (2) |
| 2 | `actividad.tsx:72` `<AreaChartSimple …/>` → `<></>` | `actividad.test.tsx` (PRU-M2) | **muerta** |
| 3 | `vista.tsx:139` `{cobranza.facturas.length === 0 ? (` → `{false ? (` | `rentabilidad/vista.test.tsx` | **muerta** |
| 4 | `vista.tsx:145` `numero(cobranza.total)` → `numero(cobranza.facturas.length)` | `rentabilidad/vista.test.tsx` | **muerta** |
| 5 | `vista.tsx:125` `valor={cobranza.porCobrar}` → `valor={0}` | `rentabilidad/vista.test.tsx` | **muerta** |
| 6 | `prepare-build-env.mjs:54` quitar `\| fsConstants.O_NOFOLLOW` | `prepare-build-env.test.ts` | **muerta** |
| 7 | `prepare-build-env.mjs:86` `ADMIN_KEYS` → `ADMIN_KEYS.slice(0, 2)` | idem | **muerta** |
| 8 | `prepare-build-env.mjs:74` quitar `&& !item.disabled` | idem | **muerta** |
| 9 | `prepare-build-env.mjs:59` `ADMIN_KEYS.some` → `ADMIN_KEYS.slice(0,1).some` | idem | **muerta** (2) |
| 10 | `jornada/repo.ts:524` quitar `.is('anulado_en', null)` | `jornada/repo.test.ts` | **muerta** |
| 11 | `jornada/repo.ts:556` quitar `.eq('estado', 'abierto')` | idem | **muerta** |
| 12 | `proveedores.ts:322` quitar `.eq('estado', 'pendiente')` | `proveedores_decidir.test.ts` | **muerta** |
| 13 | `facturacion/pendientes.ts:221` `return null` → `return 0` | `contar_con_cfdi.test.ts` | **muerta** |
| 14 | `sat_descarga/escritura.ts:157` `if (!cfg.activa)` → `if (false)` | `escritura.test.ts` | **muerta** |
| 15 | `dashboard/[id]/page.tsx:310` quitar `revisionEstado?.revision !== 'rechazada' &&` | `pdf_pendiente.test.tsx` (BE-A1) | **muerta** |
| 16 | `dashboard/[id]/page.tsx:310` quitar `&& !revisionIlegible` | idem (BE-M1/FE-M2) | **muerta** |
| 17 | `api/export/pdf/[id]/route.ts:113` `if (data.revision === 'rechazada')` → `if (false)` | `rutas_export.test.ts` | **muerta** |
| 18 | `despacho/vista.tsx` `const activosSinContar = …` → `= false` | `despacho/vista.test.tsx` (FE-M1) | **muerta** |
| 19 | `despacho/vista.tsx` `<span>0–0 de {numero(activos.total ?? 0)} en curso</span>` → `<span>0–0 de 0 en curso</span>` | `despacho/vista.test.tsx` (FE-M1) | **SOBREVIVE** |
| 20 | `despacho/vista.tsx` `activosPuedeAvanzar` sin `activos.pagina < activos.paginaMax` | idem (FE-B1) | **muerta** |
| 21 | `agentes/notificaciones.ts:1052` borrar la línea `await revertirAviso(...)` | `notificaciones_parpadeo.test.ts` (AG-A5b) | **muerta** |
| 22 | `agentes/notificaciones.ts:1009` `previo.actualizadoEn > previo.ultimo.avisadoEn` → `previo.magnitud === 0` (revierte al bug) | idem (AG-M3) | **muerta** |
| 23 | `processor.ts:1600` `porOperador?.operadorId ?? null` → `null` | `processor_talacha_pod.test.ts` (LEG-C1) | **muerta** (2) |
| 24 | `processor.ts:356` borrar `.is('oposicion_automatizada', null)` | — ninguna | **SOBREVIVE** (516 arch. / 7,906 pruebas) |
| 25 | `processor.ts:352` `if (operadorId) {` → `if (false) {` | — ninguna | **SOBREVIVE** (516 / 7,906) |
| 26 | `perfil/onboarding.ts:20` `return clave === '612' \|\| clave === '624'` → `return true` | `onboarding.test.ts` (FIS-C1) | **muerta** (2) |
| 27 | `perfil/onboarding.ts:20` → `return clave === '612'` | idem | **muerta** (2) |
| 28 | `perfil/entrevista.ts:713` `v === '612' \|\| v === '624'` → `… \|\| v === '626'` | — ninguna | **SOBREVIVE** (699 / 10,146) |
| 29 | `perfil/entrevista.ts:713` → `v === '612'` | `entrevista.test.ts` | **muerta** |
| 30 | `administracion.ts:200` `['624','612']` → `['624','612','626']` | — ninguna | **SOBREVIVE** (699 / 10,146) |
| 31 | `administracion.ts:200` `['624','612']` → `['612']` | — ninguna | **SOBREVIVE** (699 / 10,146) |
| 32 | `perfil/preguntas.ts:366-367` borrar la rama de la fuente única | `facilidad15_fuente_unica*.test.ts` (FIS-A3) | **muerta** (4) |
| 33 | `perfil/preguntas.ts:370` `regimenElegible: f15.regimenElegible === true` → `regimenElegible: true` | — ninguna | **SOBREVIVE** (516 / 7,906) |
| 34 | `llm/openrouter.ts:422` `res.choices[0]?.finish_reason === 'length'` → `false` | `openrouter_truncado.test.ts` | **muerta** (3) |
| 35 | `llm/openrouter.ts:829` quitar `err instanceof TruncatedError \|\|` del `throw` | idem | **muerta** |
| 36 | `llm/openrouter.ts:684` `costoPorModelo[u.model] = {prev + …}` → `= {u.…}` | `openrouter_costo.test.ts` | **SOBREVIVE** |
| 37 | `llm/openrouter.ts:682` `gastado.cost += u.cost` → `gastado.cost = u.cost` | `openrouter_costo.test.ts` | **muerta** (2) |
| 38 | `llm/openrouter.ts:1025` `acumularCosto` sin acumular | `openrouter_fallback_costo.test.ts` | **muerta** |
| 39 | `cuadre/desde_db.ts` quitar `.range(d, h)` de `lineasEccParaCuadre` | `desde_db_ecc_paginacion.test.ts` (ARQ-A1) | **muerta** (2) |
| 40 | `admin/qa-motor.ts:816` quitar `timestampMs: Date.now()` | `qa-motor.test.ts` (BE-A4/QA) | **muerta** (3) |
| 41 | `admin/qa-motor.ts` `['chat_conversacion','cobranza_contacto']` → `['chat_conversacion']` | `qa-motor.test.ts` (DAT-M2) | **muerta** (3) |
| 42 | `calificar-verificacion.mjs:133` `if (grupos > 1 \|\| …)` → `if (false)` | `calificar_forma_esperado_aud28.test.ts` (PRU-A3) | **muerta** (2) |
| 43 | `processor.ts:1415-1418` `replyDeCierreRecuperado` → `return 'MUTADO-SIN-CIFRAS';` | `processor_cierre_recuperado_snapshot.test.ts` (TC-A1) | **SOBREVIVE** |
| 44 | `processor.ts:1373` quitar `liq: snapshot` del registro sintético | idem | **muerta** (2) |

**Lectura del patrón.** Al revés que en la 28: ahora **muere casi todo lo que
rompe el camino nuevo**, no solo lo que revierte el bug original. Los 9
sobrevivientes no están repartidos al azar — **7 de 9 caen en dos sitios**: la
regla del 15% (5) y el escritor del derecho de oposición (2). Es decir, la deuda
del rubro dejó de ser «las pruebas son flojas» y pasó a ser **«hay dos módulos
de dinero/derecho sin arnés»**, que es una deuda más chica y más nombrable.

---

## Hallazgos

### [ALTO] `PRU-A1` — La regla que abre la facilidad del 15% vive en tres copias; `9aefea0` ancló una y las otras dos aceptan RESICO con 10,146 pruebas verdes

`src/lib/likida/perfil/onboarding.ts:19-21` (la copia **anclada**) ·
`src/lib/likida/perfil/entrevista.ts:713` (sin arnés para el alta) ·
`src/lib/likida/administracion.ts:200` (sin arnés) ·
`src/lib/likida/perfil/onboarding.test.ts:…` (las 4 pruebas nuevas del commit)

**Escenario, con la mutación exacta y su alcance medido.**

- Mutación **#28**: en `entrevista.ts:713`,
  `const elegible = v === '612' || v === '624';` →
  `const elegible = v === '612' || v === '624' || v === '626';`
  ⇒ `npx vitest run src/lib/` → **699 archivos, 10,146 pruebas, 0 fallos.**
- Mutación **#30**: en `administracion.ts:200`,
  `const REGIMENES_ELEGIBLES = ['624', '612'];` → `['624', '612', '626']`
  ⇒ **699 / 10,146, 0 fallos.**
- Mutación **#31**, la del signo contrario: `['624','612']` → `['612']`
  ⇒ **699 / 10,146, 0 fallos.** `crearFlota` no tiene un solo caso con `624`.

Fui a refutarlo por la vía más obvia: ¿no lo cubre `administracion.test.ts`?
Sí cubre `601` (`:128-142`, con el cálculo de $45,000 de ISR escrito en el
comentario) y `612` (`:144`), y por eso #27 y #29 **mueren**. Lo que no existe es
un caso con **`626`** ni con **`624`** en esos dos archivos: la lista es una
*whitelist*, y **agregarle un régimen es invisible para toda la suite**.

**Consecuencia.** `9aefea0` cerró el CRÍTICO fiscal por el formulario de
`/dashboard/onboarding`, que es la puerta que menos se usa. Una flota real nace
por una de las otras dos: la entrevista por WhatsApp (`entrevista-aplicar.ts:82`
→ `actualizarFacilidad15`) o el alta del superadmin en `/admin/flotas`
(`administracion.ts:210-219`). Un refactor de esa lista —o el mismo error de
catálogo que la auditoría 18-c2 ya cometió una vez con `601`— entra sin ponerse
rojo, y el motor le concede a un RESICO el diésel pagado en efectivo que la LISR
27-III le niega, con el artículo citado al lado en el PDF.

**Causa raíz (una línea):** el arreglo se escribió sobre la copia que el hallazgo
nombraba, no sobre la regla, y la regla tiene tres cuerpos y ningún test de
paridad entre ellos.

---

### [ALTO] `PRU-A2` — La rama legada de `facilidad15Vigente` —la única que ve una flota creada desde `/admin`— puede forzar `regimenElegible: true` con la suite verde

`src/lib/likida/perfil/preguntas.ts:362-373` (`facilidad15Vigente`) ·
`:369-370` (la rama del `tenant.config` legado) ·
`src/lib/likida/administracion.ts:210-215` (`crearFlota`, que escribe **solo**
`config`) · `src/lib/likida/fiscal.ts:584` y `src/lib/likida/tools.ts:227` (los
dos consumidores)

**Escenario (mutación #33).** En `preguntas.ts:370`:

```
return { dedicacionExclusivaCarga: f15.dedicacionExclusivaCarga === true,
-        regimenElegible: f15.regimenElegible === true };
+        regimenElegible: true };
```

⇒ `npx vitest run src/lib/likida/` → **516 archivos, 7,906 pruebas, 1 saltada,
0 fallos.**

**Por qué es alcanzable y no un caso de laboratorio.** `crearFlota` inserta
`...(facilidad15 ? { config: facilidad15 } : {})` (`administracion.ts:215`) y
**nunca escribe `tenant.perfil`**. Así que para toda flota nacida en
`/admin/flotas`, `facilidad15Declarada(perfilCrudo)` devuelve vacío
(`preguntas.ts:366-367`) y el valor sale por la rama del `config` — la que la
mutación falsea. Con una flota `601` (S.A. de C.V. ordinaria) cuyo `config` dice
`regimenElegible: false`, `tools.ts:227` pasaría a evaluar
`dedicacionExclusivaCarga && true` y el cuadre abriría la facilidad.

Lo intenté refutar con las pruebas que `b877f2f` trajo: `facilidad15_fuente_unica.test.ts`,
`facilidad15_fuente_unica_tools.test.ts` y `facilidad15_fuente_unica_desde_db.test.ts`
**sí matan** la mutación #32 (quitar la rama de la fuente única: 4 rojos). Lo que
prueban es *quién gana* entre perfil y config; ninguna prueba que **un `false`
del `config` siga siendo `false`** al salir.

**Consecuencia.** Es el otro extremo del mismo camino que PRU-A1: entre los dos,
la ruta completa «superadmin da de alta una flota → el motor decide si el diésel
en efectivo es deducible» **no tiene una sola aserción que muera** si el valor se
corrompe. Es la cifra que el contralor va a cruzar contra su contador.

**Causa raíz (una línea):** el arreglo de FIS-A3 probó la *precedencia* entre las
dos fuentes y dio por probado el *valor* que sale de la fuente perdedora.

---

### [ALTO] `PRU-A3` — El escritor del derecho de oposición ARCO no tiene un solo arnés: se puede apagar entero y 7,906 pruebas siguen verdes (y la prueba de `b6920a5` afirma lo contrario en su comentario)

`src/lib/likida/processor.ts:351-364` (el `update` de
`operador.oposicion_automatizada`) ·
`src/lib/likida/processor_talacha_pod.test.ts:296-310` (la prueba nueva del
arreglo, y su comentario `:302`)

**Escenario, dos mutaciones, las dos contra `src/lib/likida/` (516 archivos /
7,906 pruebas / 0 fallos, la línea base):**

- **#25** — `processor.ts:352`: `if (operadorId) {` → `if (false) {`. El operador
  manda «me opongo a que sigan usando mis datos»; la solicitud se registra
  (`registrarSolicitudArco`), pero **`oposicion_automatizada` nunca se enciende**
  y el operador **tampoco recibe** el «Además, desde ahora tus liquidaciones las
  revisa una persona antes de cerrarse» (`:363`). El único rastro es un
  `logger.warn`. ⇒ **SOBREVIVE.**
- **#24** — `processor.ts:356`: borrar `.is('oposicion_automatizada', null)`. Cada
  reenvío de «me opongo» **reescribe la fecha de ejercicio**, así que la primera
  —la que demuestra desde cuándo se honra el derecho, según dice el propio
  comentario en `:349-350`— se pierde. ⇒ **SOBREVIVE.**

Lo intenté refutar con un `grep` de todo el repo: `oposicion_automatizada` solo
aparece en pruebas como **dato de entrada** (`analytics_stats_operador.test.ts:81`,
`analytics_agregados_0150.test.ts:40`). El único camino que sí tiene arnés es el
**otro**: la RPC `ejecutar_arco_oposicion` del panel (`arco_oposicion.test.ts:69`).
El de WhatsApp —el que `b6920a5` vino a arreglar— no.

**Y esto es lo que lo sube de MEDIO a ALTO:** el comentario de la prueba nueva
dice literalmente «*El escritor real de `oposicion_automatizada` ya tiene su
propia cobertura de DB; aquí solo se prueba que `operadorId` deja de ser null
fijo en esta ruta*» (`processor_talacha_pod.test.ts:301-303`). La mutación #23
confirma que esa mitad **sí** quedó anclada (2 rojos). La otra mitad, la que el
comentario declara cubierta, **no existe**. Un comentario que afirma cobertura
inexistente es peor que la ausencia: apaga la siguiente búsqueda.

**Consecuencia.** El aviso de privacidad le promete a un operador —típicamente
uno **dado de baja**, que es la población que ejerce ARCO— que sus liquidaciones
las revisará una persona. Con el derecho apagado, el pipeline sigue decidiendo
solo y el operador recibió un acuse de que su solicitud «quedó registrada».

**Causa raíz (una línea):** el arreglo se probó en la frontera que era fácil de
observar (los argumentos que viajan a `registrarSolicitudArco`) y no en la
escritura que hace efectivo el derecho.

---

### [MEDIO] `PRU-M1` — La prueba nueva de FE-M1 repite exactamente el defecto que reporté en la 28: `toContain('140')` se satisface desde dos sitios y uno puede mentir

`src/app/dashboard/despacho/vista.test.tsx:101-110` (el caso) · `:107`
(`expect(html).toContain('140')`) · `src/app/dashboard/despacho/vista.tsx`
(el párrafo «hay {numero(activos.total)} en curso» y, debajo, el renglón
`<span>0–0 de {numero(activos.total ?? 0)} en curso</span>`)

**Escenario (mutación #19).** Con `{ filas: [], pagina: 8, porPagina: 25,
total: 140, paginaMax: 200 }` —el caso exacto que la prueba construye—, cambio
solo el renglón de paginación:

```
- <span>0–0 de {numero(activos.total ?? 0)} en curso</span>
+ <span>0–0 de 0 en curso</span>
```

⇒ `npx vitest run src/app/dashboard/despacho/vista.test.tsx` → **8 pruebas,
0 fallos.** La pantalla queda diciendo, con dos renglones seguidos: «Esta página
no tiene viajes — hay **140** en curso.» y «**0–0 de 0** en curso». `/140/` se
satisface desde el párrafo y la aserción no distingue cuál de los dos sitios lo
imprimió.

Lo intenté refutar: los otros dos casos del `describe` (`:112`, `:120`) son de
`total === 0` y `total === null`, así que no tocan este renglón; y las
mutaciones #18 y #20 **sí mueren**, o sea que el resto del arreglo está anclado.

**Consecuencia.** Es la misma forma exacta del PRU-M1 de la 28 (el `/350/` de
`rentabilidad`), reaparecida **en la prueba escrita para cerrar un hallazgo de
la misma auditoría**, seis commits después. El contralor que pagina y se pasa
leería dos cifras contradictorias en la misma tarjeta, y la regla del producto
(«un rótulo tiene que ser verdad») no tiene quien la defienda ahí.

**Causa raíz (una línea):** una aserción por número suelto (`toContain('140')`)
en una pantalla que imprime ese número dos veces; la de `rentabilidad` ya se
arregló con `toContain` sobre la **frase completa** y aquí no se copió ese
criterio.

---

### [MEDIO] `PRU-M2` — En la ventana, 26 de 40 commits de `master` no tienen un veredicto de CI: `cancel-in-progress` los canceló, y 3 quedaron en rojo

`.github/workflows/ci.yml:26-29` (`concurrency: group: ${{ github.workflow }}-${{ github.ref }}`
+ `cancel-in-progress: true`)

**Escenario, medido contra la API de Actions, no razonado.** Crucé los 51 shas de
`git log c7bbb83..7bcc319` contra las corridas `push` de `ci.yml` en `master`:

| Conclusión | Cuántos | Ejemplos |
|---|---|---|
| `success` | **11** | `7bcc3196`, `42bfa2b9`, `553a767b`, `4c75dd9f`, `cb6334c2` |
| `cancelled` | **26** | `24a99e2e`, `dceb00d4`, `6beb5f5a`, `29354d0f`, `077ed02c`, `388b5d4e`, `03feb952`, `a4e07195`… |
| `failure` | **3** | `910b7557`, `a2246c3c`, `b877f2f3` |

Los tres rojos son reales y los leí: `910b7557` falló con
`AssertionError: el 'total' del baseline se quedó atrás de 'porArchivo': expected
188 to be 189` (`limite_con_orden.test.ts:94`) — lo arregló después `70821b2`—, y
`b877f2f3` (la fuente única del 15%) lo arregló `904d41f`. **Los dos son
conflictos semánticos de merge**: cada PR estaba verde por su lado y el árbol
resultante en `master` no.

Y ahí está el punto: **`cancel-in-progress` es exactamente lo que oculta esa
clase.** Cuando cuatro merges caen en el mismo minuto (`24a99e2e`, `861d09d9`,
`99fba325`, `7292f9dd` a las 02:54:20–02:54:30 UTC), los cuatro se cancelan y
solo el quinto (`553a767b`, 02:54:56) corre. Si el conflicto semántico hubiera
estado entre el segundo y el tercero, nadie lo habría visto.

**Consecuencia.** `master` es la rama desde la que se publica. De sus 40 commits
con corrida, **29 (26 cancelados + 3 rojos) no tienen un verde propio**: un
`git bisect` o un rollback a cualquiera de esos shas parte de un árbol que la
compuerta nunca aprobó, y un `[deploy]` sobre uno de ellos publicaría código sin
veredicto. El comentario del archivo justifica la cancelación con «no sirve de
nada esperar el resultado de un commit que ya quedó atrás» — cierto para una
rama de trabajo, falso para la rama de publicación.

**Causa raíz (una línea):** el `concurrency` se agrupa por `github.ref` sin
excluir `master`, así que la rama que sí necesita historial verde es la que más
corridas pierde.

---

### [BAJO] `PRU-B1` — El desglose por modelo de `generateStructured` no tiene un caso con dos intentos al MISMO modelo, que es justo lo que `cb6334c` acaba de introducir

`src/lib/llm/openrouter.ts:679-686` (`cobrar`) · `:795-798` (el reintento con
`tope * 2`, **mismo modelo**) · `src/lib/llm/openrouter_costo.test.ts:167-205`

**Escenario (mutación #36).** En `openrouter.ts:684`:

```
- costoPorModelo[u.model] = { tokensIn: prev.tokensIn + u.tokensIn, …, cost: prev.cost + u.cost };
+ costoPorModelo[u.model] = { tokensIn: u.tokensIn, tokensOut: u.tokensOut, cost: u.cost };
```

⇒ `npx vitest run src/lib/llm/ src/lib/likida/perfil/` → **41 archivos, 250
pruebas, 0 fallos.** El intento truncado (el caro: se pagó y no sirvió) queda
borrado del desglose por el reintento.

El `describe` de `costoPorModelo` tiene dos casos: dos modelos distintos
(`:170`) y **una sola llamada** (`:200`). La rama `prev` existente —la que el
reintento de truncamiento produce— no se ejercita nunca.

**Por qué es BAJO y no más, y fui a comprobarlo.** El total sí está anclado:
la mutación #37 (`gastado.cost += ` → `=`) **muere en 2 casos**, y el desglose de
`generateWithTools` —el único que llega a `llm_costo` vía
`registrarCosto` (`api/dashboard/chat/route.ts:128-133` y
`oficina_wa.ts:256-262`)— muere con la mutación #38. El `costoPorModelo` de
`generateStructured` hoy no lo consume ningún escritor de costo: viaja en el
`usage` del error. Así que es un hueco de arnés sobre una superficie que **el
propio commit de la ventana volvió alcanzable**, no una fuga viva.

**Causa raíz (una línea):** el caso de prueba se diseñó para el *fallback entre
proveedores* (dos modelos) y el reintento por truncamiento reusa el mismo modelo.

---

### [BAJO] `PRU-B2` — `replyDeCierreRecuperado` es una rama muerta: su salida siempre la sustituye `guardiaCifras`, y el archivo de 258 líneas escrito para ella queda verde aunque devuelva una constante

`src/lib/likida/processor.ts:1415-1418` (`replyDeCierreRecuperado`) ·
`:4605-4611` (`guardiaCifras` sustituye `reply` cuando `g.forzado`) ·
`src/lib/likida/cuadre/guardia.ts:75+` · `src/lib/likida/processor_cierre_recuperado_snapshot.test.ts`
(4 casos, 258 líneas)

**Escenario (mutación #43).** Reemplazo el cuerpo entero por
`return 'MUTADO-SIN-CIFRAS';` ⇒ el archivo de prueba dedicado a TC-A1/TC-M1 pasa
**4/4**. Con la mutación #44 en cambio —quitar `liq: snapshot` del registro
sintético (`:1373`)— **caen 2 de los 4**, con
`expected 'Ya cerré tu liquidación ✅…' to contain 'Diésel en efectivo deducible
por la facilidad del 15 %.'`.

O sea: **el mecanismo que de verdad hace el arreglo es el snapshot metido en el
registro, que `guardiaCifras` lee y narra**; la función que el commit escribió
para narrarlo no llega a usarse porque la guardia siempre pisa el `reply` cuando
hubo cierre. No es un riesgo de comportamiento —lo verifiqué: el resultado es
correcto con y sin la función—, es **código presentado como el arreglo que no lo
es**, y su nombre hará que el próximo lector lo tome por la pieza cargante.

**Causa raíz (una línea):** dos capas hacen el mismo trabajo (la función local y
`guardiaCifras`) y la segunda gana siempre; nadie midió cuál de las dos sostiene
la prueba.

---

## Lo que revisé y está bien

- **El commit `dceb00d` es el mejor trabajo de pruebas de la ventana y lo
  verifiqué mutación por mutación.** Los cuatro candados que ancla mueren
  (#10–#14), y el patrón del mock es el correcto para lo que hay que probar:
  `jornada/repo.test.ts:31-45` **registra la cadena** (`tabla`, `op`, cada `eq`/`is`
  con su argumento) en vez de devolver lo que la prueba quiere oír. Es la única
  forma de distinguir «el filtro vive en la consulta» de «el filtro vive en
  memoria», y está escrito así a propósito (`:12-15`).
- **`4c75dd9` mata las cinco mutaciones que documenté en la 28**, y las mata con
  **aserciones positivas**: `toContain('<svg')` para la gráfica
  (`actividad.test.tsx`), `toContain('$480,000.00')` para la cifra, y la **frase
  completa** «Esta página no tiene facturas — hay 350 en la cartera completa.»
  en vez del `/350/` suelto. Es exactamente el criterio que faltaba.
- **El trinquete de cobertura ya no es una aspiración.** `vitest.config.ts:129-134`
  con `floor(medido − 0.5)`, la medición fechada y con sha en el comentario
  (`:118-128`), y **CI verde corriéndolo hoy**: `ci.yml:79-80` ejecuta
  `npm run test:coverage` en cada push a **todas** las ramas (`:21-23`), y las
  corridas 34193447143 (master `7bcc319`) y 34219755913 (`claude/auditoria-29`)
  están en `success`. Con menos de un punto de margen, un retroceso real ahora
  sí muerde.
- **`ci.yml:82-88` recupera las dos pruebas de tiempo que `--coverage` salta**
  (`npx vitest run fundamento duplicados`), y `pruebas_en_ci.test.ts` es la red
  que falla si alguien mete un `skipIf(LIKIDA_COBERTURA)` fuera de ese alcance.
  Es un mecanismo de contención de verdad, no un comentario.
- **`limite_con_orden.test.ts` es un trinquete bien hecho**, y lo digo después de
  leerlo entero: no solo prohíbe crecer (`:68`), también **exige bajar el
  baseline cuando algo se arregla** (`:77`), comprueba que el extractor **no esté
  ciego** (`:100`: `SITIOS.length > 200` y `filter(cumple).length > 5`), fija la
  alineación línea-a-línea con el fuente (`:108`, con la historia de por qué), y
  trae 9 casos sintéticos incluido «una declaración vacía NO exime» (`:176`).
- **`admin/qa-motor.test.ts` ata los 8 sitios de `processInbound` por texto del
  fuente**, no solo por comportamiento: la mutación #40 tira 3 casos, uno de
  ellos con `expected 'processInbound({ from: telefono, …' to contain
  'timestampMs'`. Un arnés que se verifica a sí mismo.
- **`desde_db_ecc_paginacion.test.ts` prueba la paginación por su consecuencia de
  dinero**, no por la forma de la consulta: al quitar `.range()` el mensaje de
  error dice «el gasto que empareja con la línea ECC #1,500 sale marcado
  `ticket_monedero`, no como CFDI válido». Así se prueba un `traerTodo`.
- **`processor_cierre_recuperado_snapshot.test.ts` usa `resumenCuadre` REAL** y lo
  declara (`:9-13`): distingue «narró la fila archivada» de «narró el recálculo»
  por el **contenido** del texto, con dos notas distintas (`:62`, `:65`). Es el
  antídoto exacto contra el mock que devuelve lo que la prueba quiere oír — y por
  eso pudo detectar la mutación #44.
- **El calificador de la batería SQL falla cerrado sin lista de excepciones**
  (`correr-verificaciones.mjs:173-201`), con la historia de por qué la lista se
  borró en vez de vaciarse. Y el bloque 47 reescrito **sí pasó contra Postgres
  real**: `ci-postgres.yml` verde en `7bcc319`.
- **Disciplina de «commit con prueba» en la ventana**: de los commits que tocan
  `src/` o `scripts/`, todos los que muté traen su archivo de prueba nuevo o
  actualizado en el mismo commit. Cero commits de código sin prueba entre los que
  revisé.
- **El árbol quedó limpio**: worktree desechable borrado (`git worktree list` →
  una sola entrada), `git status --porcelain` vacío salvo este archivo.

---

## Lo que NO alcancé a revisar

- **No corrí `--coverage` yo mismo.** Doy por buena la medición de `7bcc319`
  (84.10/74.05/87.11/86.86) **porque CI la volvió a evaluar hoy en verde con
  umbrales a menos de un punto** — eso es evidencia, no memoria, pero no es una
  corrida mía y lo digo aquí.
- **Ni un `psql`, cuarta ronda seguida.** No hay Postgres en el contenedor.
  Todo lo que digo de `verificaciones.sql`, de los 29 arneses huérfanos y de las
  exenciones de migraciones es **estructural**: cero mutaciones de SQL. Es el
  hueco más grande del rubro y ya no se cierra con más lectura. Lo único que
  cambió es que ahora puedo apoyarme en que `ci-postgres.yml` corrió verde sobre
  el sha de master.
- **No barrí las funciones exportadas sin mención en ninguna prueba** (la cifra de
  la 27 era 224). Gasté el presupuesto en mutar; el barrido habría cambiado con
  +53 archivos de prueba y no lo remedí, así que no cito ninguna cifra.
- **No toqué la Capa 0 (`wa_leases_fencing.sql`, pgTAP), `playwright-smoke` ni
  `e2e-navegador.yml`.** Sexta ronda seguida fuera por falta de `pg_prove` y
  navegador.
- **No busqué intermitencia**: una sola corrida por mutación, sin repeticiones ni
  husos horarios distintos. No puedo afirmar nada sobre pruebas que dependan de
  la hora, salvo que ninguna de mis 44 corridas dio un resultado distinto entre
  el alcance corto y el largo.
- **Los 9 sobrevivientes se midieron contra `src/lib/` o `src/lib/likida/`, no
  contra la suite entera.** Para los 7 que importan (#24, #25, #28, #30, #31,
  #33) lo respaldé además con `grep` de todo `src/` y `scripts/` buscando
  cualquier aserción sobre el símbolo; para #19, #36 y #43 el alcance corto es el
  archivo escrito específicamente para ese código, que es el alcance correcto.
- **No revisé `pruebas-manuales/`** (prohibido correrlas) más allá de confirmar
  que siguen fuera del `include` de vitest.
