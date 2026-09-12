# Pruebas — auditoría 30

**Nota: 6/10** (antes 7). Razón del movimiento: **mirada más profunda — la
campaña de cobertura entró de verdad, pero mide la mitad que no cuesta el
trato, y los 5 hallazgos abiertos que dejé en la 29 siguen exactamente donde
los dejé.** No es «deuda que cobró factura» (nada se rompió) ni «se atacó y
subió» (sí se atacó, y parte subió): es que la 29 se ganó el 7 con 35 de 44
mutaciones muertas sobre un muestreo que yo mismo elegí entre arreglos
recientes, y esta ronda, apuntando a donde el producto se juega el dinero,
**14 de 34 mueren (41 %)**. Los +49 archivos de prueba no cambian ese número
hacia arriba: lo cambian hacia abajo.

**Riesgo mayor del rubro, hoy:** de las once mutaciones que cambian
**la cifra de pesos o dólares que una pantalla imprime** —el ingreso de fletes
por cliente, el precio del plan que la flota paga, el monto de sus facturas,
el desglose base/IVA de una mensualidad emitida, el MRR del board, el costo de
IA por flota— **no muere ni una**: 0 de 11, con las 982 pruebas en verde. La
campaña ancló *quién puede tocar qué*, *de qué tenant sale el dato* y *qué dice
la pantalla cuando la lectura se cae* —y eso muerde bien, 10 de 13—, pero
**nadie mira el número**. El contralor que cruza el panel contra su contador es
exactamente quien ve esa clase de error primero.

---

## Cómo se midió (repetible)

- **Worktree desechable**: `git worktree add --detach <scratchpad>/wt-pru HEAD`
  sobre `4e36c82`, `node_modules` por symlink. **Borrado al terminar**
  (`git worktree list` → una sola entrada) y `git status --porcelain` vacío.
- **34 mutaciones dirigidas**, una corrida acotada cada una. Las que
  sobrevivieron el alcance corto se re-corrieron contra un alcance grande
  (`src/lib/likida/` = 518 arch. / 7,934 pruebas, `src/lib/` = 701 / 10,174,
  `src/app/dashboard/` = 93 / 608, `src/app/admin/` = 58 / 390) para no
  confundir «no la cubre este archivo» con «no la cubre nadie».
- **Inventario propio**: `find src scripts -name '*.test.ts*' | wc -l` → **982**
  (coincide con el MAPA); con `supabase/` incluido, **984**.
  `git diff --name-status 7bcc319..HEAD` → **49 archivos de prueba nuevos**,
  de los cuales **47 son `src/app/**/page.test.tsx`** y 2 son de `src/lib/likida/`.
  `supabase/tests/` → **53 archivos** (35 `.sql`), **29 sin invocador** en
  `ci-postgres.yml` — la misma cifra exacta de la 29.
- **NO corrí** la suite completa, ni `pruebas-manuales/*.prueba.ts`, ni
  `npm run build`.
- **Evidencia de CI leída de las corridas reales**, no del YAML: 60 corridas
  `push` de `ci.yml` sobre `master` vía la API de Actions.

### Un dato de forma que explica el resto

De los 47 `page.test.tsx` nuevos, **30 renderizan** (`renderToStaticMarkup`) y
**17 solo inspeccionan props o invocan las server actions**. El caso extremo es
`/dashboard/clientes`: la prueba (164 líneas, 15 casos) nunca monta
`clientes/vista.tsx` —660 líneas, la que imprime el ingreso por cliente y el
saldo por cobrar— porque la página devuelve `<VistaClientes …/>` y la prueba se
queda en `pagina.props`. No es una omisión de esa prueba sola: es el molde.

---

## La medición por mutación

### **14 de 34 mutaciones mueren (41 %).** Antes: 35 de 44 (80 %).

| # | Archivo mutado | Línea | Qué cambié | Prueba que debía morir | ¿Murió? |
|---|---|---|---|---|---|
| 1 | `src/app/dashboard/clientes/page.tsx` | 184 | `puedeEditar={puedeAdministrar(rol)}` → `={true}` | `clientes/page.test.tsx:78` | **sí** |
| 2 | `src/app/dashboard/clientes/page.tsx` | 122 | `crearCliente(s.tenantId,…)` → `crearCliente(fd.get('tenantId') ?? s.tenantId,…)` | `clientes/page.test.tsx:84` | **sí** |
| 3 | `src/app/dashboard/clientes/vista.tsx` | 110 | `valor={panel.ingresoTotal}` → `valor={0}` | — ninguna | **no** (93 arch. / 608) |
| 4 | `src/app/dashboard/clientes/vista.tsx` | 274 | `mxn(c.ingreso)` → `mxn(0)` | — ninguna | **no** (94 / 658) |
| 5 | `src/app/dashboard/suscripcion/page.tsx` | 345 | `mxn(planActual.precioMensual)` → `mxn(0)` | — ninguna | **no** (17 / 151) |
| 6 | `src/app/dashboard/suscripcion/page.tsx` | 513 | `mxn(f.monto)` → `mxn(0)` | — ninguna | **no** (109 / 746) |
| 7 | `src/app/dashboard/suscripcion/page.tsx` | 168 | `priceId: p.stripePriceId` → `priceId: 'price_OTRO'` | `suscripcion/page.test.tsx:137` | **sí** |
| 8 | `src/app/admin/costos-facturacion/page.tsx` | 125 | borrar `(base ${mxn(r.subtotal)} + IVA ${mxn(r.iva)})` del mensaje | `costos-facturacion/page.test.tsx:139` | **no** (17 / 147) |
| 9 | `src/app/admin/costos-facturacion/page.tsx` | 125 | `mxn(r.monto)` ↔ `mxn(r.subtotal)` intercambiados | idem `:139` | **no** |
| 10 | `src/app/admin/costos-facturacion/page.tsx` | 115 | `Date.UTC(anio, mes, 0)` → `Date.UTC(anio, mes, 1)` | `:129` (DAT-23) | **sí** |
| 11 | `src/app/admin/consumo/page.tsx` | 64 | `valor={r.costoIaUsd}` → `valor={0}` | — ninguna | **no** (58 / 390) |
| 12 | `src/app/admin/consumo/page.tsx` | 184 | `usd(f.costoIaUsd)` → `usd(0)` | — ninguna | **no** (58 / 390) |
| 13 | `src/app/admin/consumo/page.tsx` | 180 | `sort(b.costoIaUsd - a.costoIaUsd)` → ascendente | `consumo/page.test.tsx:97` | **sí** |
| 14 | `src/app/dashboard/timbrado/page.tsx` | 104 | `f.timbre.modo === 'sandbox'` → `false` | `timbrado/page.test.tsx:101` | **sí** |
| 15 | `src/app/dashboard/timbrado/page.tsx` | 104 | `folio ${f.timbre.uuidFiscal ?? '—'}` → `folio —` | idem `:101` | **sí** |
| 16 | `src/app/admin/flotas/page.tsx` | 97 | `actualizarFacilidad15(flotaId, ded, reg, …)` → `(flotaId, reg, ded, …)` | `flotas/page.test.tsx:122` | **sí** |
| 17 | `src/app/admin/flotas/page.tsx` | 230 | `usd(f.costoIaUsd)` → `usd(0)` | — ninguna | **no** (58 / 390) |
| 18 | `src/app/admin/flotas/page.tsx` | 149 | `flotasOrdenadas` por costo desc → asc | — ninguna | **no** |
| 19 | `src/lib/likida/perfil/preguntas.ts` | 362 | `REGIMENES_ELEGIBLES_15 = ['624','612']` → `['624','612','626']` | — ninguna | **no** (518 / 7,934) |
| 20 | `src/lib/likida/perfil/entrevista.ts` | 713 | `v === '612' \|\| v === '624'` → `… \|\| v === '626'` | — ninguna | **no** (701 / 10,174) |
| 21 | `src/lib/likida/processor.ts` | 352 | `if (operadorId) {` → `if (false) {` | — ninguna | **no** (518 / 7,934) |
| 22 | `src/lib/likida/perfil/preguntas.ts` | 400 | `regimenElegible: f15.regimenElegible === true` → `: true` | — ninguna | **no** (518 / 7,934) |
| 23 | `src/app/dashboard/despacho/vista.tsx` | 232 | `0–0 de {numero(activos.total ?? 0)}` → `0–0 de 0` | `despacho/vista.test.tsx:101` | **no** (3 / 19) |
| 24 | `src/app/admin/ejecutivo/page.tsx` | 44 | `valor={mrr.totalMxn}` → `={mrr.totalMxn * 10}` | `ejecutivo/page.test.tsx:71` | **no** (1 / 7) |
| 25 | `src/app/dashboard/conversaciones/page.tsx` | 49 | `getHilosDeFlota(tenantId)` → `(sp.tenant ?? tenantId)` | `conversaciones/page.test.tsx:53` | **no** (1 / 12) |
| 26 | `src/app/admin/analitica/page.tsx` | 103 | `usd(m.costoUsd)` → `usd(0)` | — ninguna | **no** (1 / 6) |
| 27 | `src/app/dashboard/carta-porte/page.tsx` | 51 | `pisaFederal: String(fd.get('pisaFederal') ?? '')` → `: ''` | `carta-porte/page.test.tsx:64` | **sí** (2) |
| 28 | `src/app/dashboard/llaves-api/page.tsx` | 98 | `revocarLlaveApi(s.tenantId,…)` → `(fd.get('tenantId') ?? s.tenantId,…)` | `llaves-api/page.test.tsx:127` | **sí** |
| 29 | `src/app/dashboard/emergencias/page.tsx` | 181 | `borrarContactoEmergencia(g.tenantId,…)` → `(fd.get('tenantId') ?? g.tenantId,…)` | `emergencias/page.test.tsx:198` | **no** (1 / 14) |
| 30 | `src/app/dashboard/asistencia/page.tsx` | 77 | `Number(fd.get('nivel'))` → `1` | `asistencia/page.test.tsx:96` | **sí** |
| 31 | `src/app/admin/compliance/page.tsx` | 57 | `resolverSolicitudArco(sol.tenant_id,…)` → `('t-CUALQUIERA',…)` | `compliance/page.test.tsx:114` | **sí** |
| 32 | `src/app/dashboard/reglas/page.tsx` | 114 | `rol: s.rol` → `rol: 'flota_admin'` | `reglas/page.test.tsx:81` | **no** (1 / 12) |
| 33 | `src/app/admin/equipo/page.tsx` | 42 | anular el `sort` por jerarquía de rol | `equipo/page.test.tsx:44` | **sí** |
| 34 | `src/app/dashboard/chat/page.tsx` | 49 | `getKpis(tenantId)` → `getKpis('t-OTRO')` | `chat/page.test.tsx:71` | **sí** |

### Lectura del patrón — el 41 % no está repartido al azar

| Clase de mutación | Mueren | Total | % |
|---|---|---|---|
| **La cifra de dinero que la pantalla imprime** (#3,4,5,6,8,9,11,12,17,24,26) | **0** | 11 | **0 %** |
| El argumento de una **escritura** (tenant / userId / id / parámetro) (#1,2,7,16,27,28,29,30,31,32,34 + #25) | 9 | 12 | 75 % |
| Rótulo, orden, estado vacío/error (#13,14,15,18,33,23) | 4 | 6 | 67 % |
| **Hallazgos abiertos de la 29** (#19,20,21,22,23 → PRU-A1/A2/A3/M1) | **0** | 5 | **0 %** |

Tres de los 20 sobrevivientes (#25, #29, #32) son mutaciones que **solo un dato
hostil alcanza** —un `?tenant=` ajeno, un `tenantId` inyectado en el `FormData`,
un rol distinto— y la prueba respectiva sí tiene la aserción correcta: lo que
falta es el **caso de borde que la dispare**. Las cuento como sobrevivientes
porque eso es exactamente el modo de falla, y porque la prueba hermana de
`/dashboard/llaves-api` (#28) **sí construye ese caso** (`tenantId: 'OTRO'` en
el form) y por eso muere. Dos archivos del mismo lote, el mismo ataque, distinto
resultado.

---

## Los 9 tests SQL nuevos

Aviso de forma, porque el MAPA da una cifra que no cuadra con el árbol:
**no hay 9 `supabase/tests/*.sql` nuevos, hay 6** (`git diff --name-status
7bcc319..HEAD -- supabase/`), más **1 modificado** (`0340_arco_alcance.sql`).
Las otras tres migraciones se cubren fuera de ese directorio, y las tres
maneras aguantan la lectura. Los seis nuevos **sí están cableados**:
`ci-postgres.yml:193-198` los invoca uno por uno — es la mejora más limpia de
la ventana en mi rubro.

| Migración | Dónde está su prueba | ¿Contiene el caso que hace divergir la función vieja de la nueva? |
|---|---|---|
| **0348** analytics sin rechazadas | `supabase/tests/0348_…sql` (ci-postgres:193) | **Sí.** Siembra las tres revisiones (aprobada 980 / **rechazada 8500** / ajustada 500) el **mismo día**, y cada uno de los 6 agregados tiene su número con el rojo escrito al lado (`1480`, no `10480`; `n=2`, no 3; `diferencias=1`, no 2). Además comprueba que **no** tocó las columnas que vienen de `viaje` (`viajes=3`, `anticipoTotal=900`) — el contra-caso |
| **0349** cubo del 15 % sin copias | `supabase/tests/0349_…sql` (ci-postgres:194) | **Sí.** Dos filas con `folio_norm='59'` y monto 300 en efectivo; verde = `total 3300 / efectivo 300`, rojo = `3600 / 600`. Y **declara por escrito el camino que NO puede ejercitar** (el dedup por `cfdi_uuid`, que `uq_gasto_cfdi_uuid` ya prohíbe) en vez de fingir que lo cubre |
| **0350** cascade chat/cobranza | `supabase/tests/0350_…sql` (ci-postgres:195) | **Sí.** Inserta una fila en cada tabla, borra el tenant y exige `count(*)=0` en las dos. Antes de 0350 el `delete` **reventaba** contra la FK — el commit lo documenta como RED real |
| **0351** `FaseCosto` copiloto/runner | `supabase/tests/0351_…sql` (ci-postgres:196) | **Sí.** Inserta las dos fases nuevas **y** exige que una inventada siga rebotando con `check_violation`. Sin el contra-caso, ampliar el CHECK a `true` pasaría |
| **0352** retención de IVA | `supabase/tests/0352_…sql` (ci-postgres:197) | **Sí.** Cuatro casos: sin retención (comportamiento viejo intacto), con retención al 4 % (`11200`), total que **ignora** la retención → rechazado, retención negativa → rechazada |
| **0353** cuerpos literales de `revisar_liquidacion` / `ejecutar_arco_cancelacion` | Sin test propio; exención razonada en `migraciones_verificadas.test.ts:54` | **N/A, y bien argumentado.** La exención afirma que `pg_get_functiondef()` es **byte-idéntico** antes y después, verificado contra producción con `begin;…rollback;`, y apunta a que las suites de 0347 y 0340 corren **después** en ci-postgres. Es la única de las nueve donde «solo el camino feliz» no aplica porque no hay divergencia que probar |
| **0354** `cierre_insumos_hash` v2 | `supabase/tests/0354_…sql` (ci-postgres:198) | **Sí, y es el mejor de los seis.** Dos viajes idénticos salvo `pagado_forma` (`'99'` vs `'03'`) y exige que **el hash los distinga** — es decir, prueba que la fórmula *cambió*, no solo que el número de versión subió. Encima: `guardar_liquidacion_tx` rebota `version=1` con `CU007`, acepta `version=2`, el CHECK sigue aceptando `1` histórico y rechaza `3` |
| **0355** agregado fiscal sin copias | `supabase/verificaciones.sql` bloque **267** | **Sí.** Dos gastos con el mismo `folio_norm` y monto 348 → `n=1 / monto=348 / iva=48`; y el **contra-caso**: un folio distinto con el mismo monto **sí** suma aparte (`distingue-distinto=t`) |
| **0356** ARCO borra contacto de emergencia | `supabase/verificaciones.sql` bloque **144** (+ el texto de resolución en `supabase/tests/0340_arco_alcance.sql`) | **Sí, pero repartido, y la mitad que se ve es la floja.** El bloque 144 inserta el `contacto_emergencia` del familiar (`:8513-8515`), mide `familia_quedan` (`:8534`) y lo exige en `0` (`:8559`, con el `esperado … / 0 / …`). Lo que el diff de `0340_arco_alcance.sql` cambió fue **solo la frase de la resolución** — la promesa, no el hecho. Quien lea el diff de la migración creerá que el arnés que se movió es el que prueba el borrado, y no lo es |

**Veredicto: 8 de 9 con el caso divergente escrito; la novena (0353) exenta con
razón verificable.** Este es el punto más alto del rubro hoy y lo digo entero:
ninguna de las nueve entró con un test de camino feliz.

---

## Hallazgos

### [CRÍTICO] `PRU-C1` — La campaña de 47 páginas nuevas no tiene ni una aserción sobre una cifra de dinero: 11 mutaciones que cambian el número impreso sobreviven las 982 pruebas

`src/app/dashboard/clientes/vista.tsx:110` y `:274` ·
`src/app/dashboard/suscripcion/page.tsx:345` y `:513` ·
`src/app/admin/consumo/page.tsx:64` y `:184` ·
`src/app/admin/flotas/page.tsx:230` · `src/app/admin/analitica/page.tsx:103` ·
`src/app/admin/ejecutivo/page.tsx:44` ·
`src/app/admin/costos-facturacion/page.tsx:125`

**Escenario, con los valores.** Tres de las once, medidas:

- `clientes/vista.tsx:110`:
  `etiqueta="Ingreso de fletes capturado" valor={panel.ingresoTotal}` →
  `valor={0}` ⇒ `npx vitest run src/app/dashboard/` → **93 archivos, 608
  pruebas, 0 fallos.** El panel de cartera afirma **$0.00 de ingreso de fletes
  capturado** y, dos renglones abajo, la nota sigue diciendo «De 14 viajes con
  el dato capturado». Con `:274` (`mxn(c.ingreso)` → `mxn(0)`) la tabla entera
  de ingreso por cliente sale en ceros: **94 / 658, 0 fallos.**
- `suscripcion/page.tsx:345`: `mxn(planActual.precioMensual)` → `mxn(0)` ⇒
  **17 / 151, 0 fallos.** La flota lee que su plan cuesta **$0.00** al mes. Con
  `:513` (`mxn(f.monto)` → `mxn(0)`), su historial de facturas de Likida sale
  en ceros: **109 / 746, 0 fallos.**
- `ejecutivo/page.tsx:44`: `valor={mrr.totalMxn}` → `valor={mrr.totalMxn * 10}`
  ⇒ **1 / 7, 0 fallos** — y el caso que debía matarlo se llama, literalmente,
  *«el MRR es el MISMO valor real de `getMrr()` — no un número aparte "para el
  board"»* (`ejecutivo/page.test.tsx:71`). Pasa porque sus dos aserciones son
  `toContain('123')` y `toContain('456')`, y `$1,234,560.00` las contiene las
  dos. Es el defecto que reporté como PRU-M1 en la **28** y otra vez en la
  **29**, ahora recién escrito.

**Consecuencia.** La regla que define el producto es «nunca inventar una
cifra». Hoy hay 982 archivos de prueba y **ninguno** se pone rojo si una de
esas cifras se inventa. El contralor cruza el panel contra su PDF y su
contador: `$0.00` de ingreso con «14 viajes con el dato capturado» al lado, o
un MRR diez veces mayor en la lámina del board, es el error que cuesta el trato
— y es justo la clase que la campaña no puede detener.

**Causa raíz (una línea):** el lote se escribió alrededor de la **puerta** (rol,
tenant, estado vacío/error) y no alrededor del **valor**, y en las 17 pruebas
que solo miran `pagina.props` el componente que imprime el valor ni siquiera se
monta.

---

### [ALTO] `PRU-A1` — REINCIDENTE (2.ª ronda): la whitelist del 15 % se unificó en una sola fuente y **nadie fijó su contenido**; meterle `'626'` (RESICO) sobrevive 10,174 pruebas

`src/lib/likida/perfil/preguntas.ts:362` (`REGIMENES_ELEGIBLES_15`) ·
`src/lib/likida/perfil/entrevista.ts:713` (la copia que sigue suelta) ·
`src/lib/likida/facilidad15_regimen_cotejado.test.ts` (las 8 pruebas nuevas)

**Lo que sí se arregló, y lo digo primero.** `administracion.ts:205` dejó de
tener su literal y ahora llama `regimenElegiblePorClave()`; `repo.ts:1628`
**coteja** la declaración manual contra la clave del SAT, y
`facilidad15_regimen_cotejado.test.ts` ancla ese cotejo con la mutación que
importa (clave `601` + «Régimen: Sí» → rechazado, sin `rpc`). Las tres copias de
la 29 bajaron a dos. Eso es trabajo real.

**Lo que no.**

- **Mutación #19** — `preguntas.ts:362`:
  `REGIMENES_ELEGIBLES_15 = ['624', '612']` → `['624', '612', '626']`
  ⇒ `npx vitest run src/lib/likida/` → **518 archivos, 7,934 pruebas, 1
  saltada, 0 fallos.** La fuente única existe y **no hay una sola aserción
  sobre lo que contiene**: `facilidad15_regimen_cotejado.test.ts` prueba `601`,
  `612`, `624` y `null`, nunca `626`.
- **Mutación #20** — `entrevista.ts:713`:
  `const elegible = v === '612' || v === '624';` →
  `… || v === '626';` ⇒ `npx vitest run src/lib/` → **701 archivos, 10,174
  pruebas, 0 fallos.** Es el mismo valor y el mismo escenario que puse en la 29.

**Consecuencia.** La entrevista por WhatsApp es por donde nace una flota real.
Con `'626'` colado en cualquiera de las dos listas, el motor le concede a un
RESICO el diésel pagado en efectivo que la LISR 27-III le niega, y el PDF lo
imprime citando la RFA 2026 regla 2.9 al lado. Ya pasó una vez con `601`
(auditoría 18-c2).

**Causa raíz (una línea):** el arreglo consolidó **de dónde sale** la regla y
dejó sin probar **qué dice**; una whitelist sin un caso negativo por cada clave
excluida no tiene quién la defienda de un refactor de catálogo.

---

### [ALTO] `PRU-A2` — REINCIDENTE (2.ª ronda): el escritor del derecho de oposición ARCO por WhatsApp se puede apagar entero y 7,934 pruebas siguen verdes

`src/lib/likida/processor.ts:351-364` (el `update` de
`operador.oposicion_automatizada`)

**Escenario (mutación #21), sin cambio respecto de la 29.** `processor.ts:352`:
`if (operadorId) {` → `if (false) {` ⇒ `npx vitest run src/lib/likida/` →
**518 archivos, 7,934 pruebas, 0 fallos.** El operador manda «me opongo a que
sigan usando mis datos», la solicitud se registra, **`oposicion_automatizada`
nunca se enciende**, y el operador **tampoco recibe** el «Además, desde ahora
tus liquidaciones las revisa una persona antes de cerrarse» (`:363`). El único
rastro es un `logger.error`.

`git log 7bcc319..HEAD -- src/lib/likida/processor.ts` no trae ningún commit
sobre este bloque. Sigue en pie el agravante de la 29: el comentario de
`processor_talacha_pod.test.ts:301-303` afirma que «el escritor real de
`oposicion_automatizada` ya tiene su propia cobertura de DB», y no la tiene —
un comentario que declara cobertura inexistente apaga la siguiente búsqueda.

**Consecuencia.** El aviso de privacidad le promete a un operador —típicamente
uno dado de baja, que es la población que ejerce ARCO— que una persona revisará
sus liquidaciones. Con el derecho apagado, el pipeline sigue decidiendo solo y
el operador ya recibió un acuse de que su solicitud «quedó registrada».

**Causa raíz (una línea):** el arreglo se probó en la frontera observable (los
argumentos que viajan a `registrarSolicitudArco`) y no en la escritura que hace
efectivo el derecho.

---

### [ALTO] `PRU-A3` — REINCIDENTE (2.ª ronda): la rama legada de `facilidad15Vigente` —la que ve toda flota creada desde `/admin`— puede forzar `regimenElegible: true` con la suite verde

`src/lib/likida/perfil/preguntas.ts:400` (`facilidad15Vigente`) ·
`src/lib/likida/fiscal.ts` y `src/lib/likida/tools.ts` (los dos consumidores)

**Escenario (mutación #22).** En `preguntas.ts:400`:

```
return { dedicacionExclusivaCarga: f15.dedicacionExclusivaCarga === true,
-        regimenElegible: f15.regimenElegible === true };
+        regimenElegible: true };
```

⇒ `npx vitest run src/lib/likida/` → **518 archivos, 7,934 pruebas, 1 saltada,
0 fallos.** Idéntico a la 29.

Las tres pruebas de `facilidad15_fuente_unica*.test.ts` siguen probando **quién
gana** entre perfil y config; ninguna prueba que **un `false` del `config` siga
siendo `false`** al salir. Para una flota `601` nacida en `/admin/flotas` con
`config.regimenElegible = false`, la mutación abre la facilidad en el cuadre.

**Causa raíz (una línea):** el arreglo de FIS-A3 probó la *precedencia* entre
las dos fuentes y dio por probado el *valor* que sale de la fuente perdedora.

---

### [MEDIO] `PRU-M1` — REINCIDENTE (3.ª ronda, y el lote nuevo la volvió a escribir): la aserción por número suelto, otra vez

`src/app/dashboard/despacho/vista.test.tsx:107` (`expect(html).toContain('140')`) ·
`src/app/dashboard/despacho/vista.tsx:232` ·
**y la reincidencia nueva:** `src/app/admin/ejecutivo/page.test.tsx:75-76`
(`toContain('123')` + `toContain('456')`)

**Escenario (mutación #23), sin cambio respecto de la 29.** Con
`{ filas: [], pagina: 8, porPagina: 25, total: 140, paginaMax: 200 }`, cambio
solo `vista.tsx:232`:

```
- <span>0–0 de {numero(activos.total ?? 0)} en curso</span>
+ <span>0–0 de 0 en curso</span>
```

⇒ `npx vitest run src/app/dashboard/despacho/` → **3 archivos, 19 pruebas,
0 fallos.** La pantalla dice, en dos renglones seguidos: «Esta página no tiene
viajes — hay **140** en curso.» y «**0–0 de 0** en curso».

**Lo que lo sube de «abierto» a reincidencia con agravante:** el lote nuevo
repitió la forma exacta. `ejecutivo/page.test.tsx:75-76` verifica un MRR de
`123456` con `toContain('123')` y `toContain('456')`, y por eso la mutación #24
(×10 → `$1,234,560.00`) pasa. Es el mismo defecto, tercera ronda, escrito por
tercera vez en una prueba nueva. El antídoto ya está en el repo y funciona:
`rentabilidad/vista.test.tsx` afirma la **frase completa**
(«Esta página no tiene facturas — hay 350 en la cartera completa.») y por eso
sus mutaciones mueren.

**Causa raíz (una línea):** `toContain` sobre un número suelto en una pantalla
que lo imprime dos veces —o sobre un fragmento de un número formateado— no
distingue cuál de los dos sitios lo imprimió.

---

### [MEDIO] `PRU-M2` — REINCIDENTE: 20 de 60 commits de `master` siguen sin veredicto propio de CI, y los 7 cancelados en bloque son **justo los 7 lotes de la campaña de cobertura**

`.github/workflows/ci.yml:27-29`
(`concurrency: group: ${{ github.workflow }}-${{ github.ref }}` +
`cancel-in-progress: true`)

**Escenario, medido contra la API de Actions (60 corridas `push` de `ci.yml`
sobre `master`, no razonado):** **40 `success` · 18 `cancelled` · 2 `failure`.**
Mejoró frente a la 29 (11 / 26 / 3 de 40), y hay que decirlo. Lo que no mejoró
es el modo de falla, y esta ventana lo exhibe:

| Sha | Asunto | Conclusión |
|---|---|---|
| `56f05ee2` | `test: cobertura de 6 páginas de /admin (lote 1)` | **cancelled** |
| `772c5aa9` | lote 4 | **cancelled** |
| `ada1639b` | lote 7 | **cancelled** |
| `37701412` | lote 3 | **cancelled** |
| `ea3745f8` | lote 6 | **cancelled** |
| `ed8a1b83` | lote 8 | **cancelled** |
| `139e792b` | lote 5 | **cancelled** |
| `8fc2fa7c` | `fix: auditoría 29 — 2 críticos con prueba (FIS-C1, LEG-C1)` | **cancelled** |

Los siete lotes cayeron entre las 01:15:20 y las 01:25:11 UTC del 10-sep y se
cancelaron unos a otros; solo `15fd8d30`, ya de otra cosa, corrió. **Los siete
commits que metieron ~35 de los 47 archivos de prueba nuevos no tienen una
corrida verde propia.** Y el commit que cerró los dos críticos de la 29 tampoco.

**Consecuencia.** `master` es la rama desde la que se publica. Un `git bisect`,
un rollback o un **Redeploy** de Vercel sobre cualquiera de esos 20 shas parte
de un árbol que la compuerta nunca aprobó. Con la bandera `[deploy]` leyéndose
solo del asunto, publicar uno de ellos no enciende ninguna alarma.

**Causa raíz (una línea):** el `concurrency` se agrupa por `github.ref` sin
excluir `master`, así que la rama que sí necesita historial verde es la que más
corridas pierde.

---

### [MEDIO] `PRU-M3` — El mensaje que dice las tres cifras de una mensualidad emitida está probado por su **referencia**, no por sus cifras; la prueba se llama «dice las TRES cifras» y el IVA del lado equivocado la pasa

`src/app/admin/costos-facturacion/page.tsx:121-127` ·
`src/app/admin/costos-facturacion/page.test.tsx:139-147`

**Escenario, dos mutaciones.** El código trae escrito por qué existe ese
mensaje (`:121-123`): *«Se dicen las TRES cifras. […] verlos juntos en la misma
frase es lo que permite cachar el día uno que el IVA quedó del lado
equivocado.»* Con `emitirMensualidad` devolviendo
`{ monto: 2784, subtotal: 2400, iva: 384, referencia: 'REF-1' }`:

- **#8** — borro el desglose entero del mensaje:
  `` `Mensualidad emitida por ${mxn(r.monto)} (base ${mxn(r.subtotal)} + IVA ${mxn(r.iva)}). …` ``
  → `` `Mensualidad emitida. …` `` ⇒ `npx vitest run src/app/admin/costos-facturacion/ src/lib/saas/`
  → **17 archivos, 147 pruebas, 0 fallos.**
- **#9** — el caso exacto que el comentario nombra: intercambio total y base,
  `` por ${mxn(r.subtotal)} (base ${mxn(r.monto)} + IVA …) `` ⇒ el mensaje
  imprime **«Mensualidad emitida por $2,400.00 (base $2,784.00 + IVA
  $384.00)»** ⇒ **1 archivo, 9 pruebas, 0 fallos.**

La prueba se llama *«accionEmitir: dice las TRES cifras (total, base, IVA) y la
referencia — verlas juntas es lo que deja cachar un IVA mal puesto»* y sus tres
aserciones son `r.ok` contiene `'REF-1'` y dos `revalidatePath`. **Ninguna toca
una cifra.**

**Consecuencia.** Es el mensaje que ve Javier al cobrarle a un cliente real, y
el desglose es lo que va a salir en el CFDI de esa flota. El único mecanismo
escrito para cachar un IVA invertido el día uno no tiene quién lo defienda — y
el nombre de la prueba afirma lo contrario, que es lo que apaga la siguiente
revisión.

**Causa raíz (una línea):** se afirmó el identificador (la referencia), que es
lo fácil de comparar, en vez de los tres valores que el propio código declara
como la razón de existir del mensaje.

---

### [BAJO] `PRU-B1` — Dos pruebas del mismo lote, el mismo ataque de tenant cruzado, distinto resultado: falta el caso hostil, no la aserción

`src/app/dashboard/emergencias/page.test.tsx:198` (sin el caso) ·
`src/app/dashboard/conversaciones/page.test.tsx:53` (sin el caso) ·
`src/app/dashboard/llaves-api/page.test.tsx:127` (**con** el caso)

**Escenario.** `llaves-api/page.test.tsx` construye el `FormData` con un
`tenantId: 'OTRO'` inyectado y por eso la mutación #28
(`revocarLlaveApi(fd.get('tenantId') ?? s.tenantId, …)`) **muere**. Sus
hermanas no lo construyen:

- **#29** — `emergencias/page.tsx:181`:
  `borrarContactoEmergencia(g.tenantId, …)` →
  `borrarContactoEmergencia(String(fd.get('tenantId') ?? g.tenantId), …)`
  ⇒ **1 archivo, 14 pruebas, 0 fallos.** Es el borrado del contacto de
  emergencia de un tercero — el mismo dato que la migración 0356 acaba de
  declarar borrable por ARCO.
- **#25** — `conversaciones/page.tsx:49`:
  `getHilosDeFlota(tenantId)` → `getHilosDeFlota(sp.tenant ?? tenantId)`
  ⇒ **1 archivo, 12 pruebas, 0 fallos**, en el archivo cuyo commit se titula
  `test(privacidad): primera cobertura de /dashboard/conversaciones`.

Las dos tienen la aserción correcta (`toHaveBeenCalledWith('t-1', …)`); lo que
no tienen es una entrada que la ponga a prueba. Por eso es BAJO y no más: el
arnés está, falta el caso.

**Causa raíz (una línea):** el lote copió el molde del `FormData` limpio de una
prueba a la siguiente y solo una conservó el campo hostil.

---

## Lo que revisé y está bien

- **Las 9 migraciones entraron con su caso divergente, y las 6 con
  `supabase/tests/*.sql` están cableadas en `ci-postgres.yml:193-198`.** Es lo
  contrario del modo de falla clásico del rubro. `0354` en particular no se
  conforma con comprobar que `insumos_hash_version` subió a 2: siembra dos
  viajes idénticos salvo `pagado_forma` (`'99'` vs `'03'`) y **exige que el
  hash los distinga** — o sea, prueba que la fórmula cambió, que es lo único
  que un `CREATE OR REPLACE` necesita demostrar. `0349` y el bloque 267
  declaran por escrito el camino que **no** pueden ejercitar
  (`uq_gasto_cfdi_uuid` lo impide) en vez de fingirlo.
- **El lote de server actions muerde bien: 9 de 12.** Mueren el swap `ded/reg`
  de `actualizarFacilidad15` (#16), el `priceId` de Stripe (#7), el
  `tenant_id` de `resolverSolicitudArco` (#31), el `nivel` de la reescalada de
  la mesa (#30), el `pisaFederal` de la Carta Porte (#27, 2 rojos), el
  `getKpis(tenantId)` del chat (#34) y la revocación de llave API (#28). El
  patrón correcto está en el repo y se usó: re-resolver la sesión **dentro** de
  la action y afirmar el argumento con `toHaveBeenCalledWith`.
- **`/dashboard/timbrado` es el mejor `page.test.tsx` del lote y lo verifiqué
  mutando dos veces.** Las dos mueren (#14, #15) y mueren por **contenido**:
  falsear el `modo === 'sandbox'` del renglón deja el HTML sin «DE PRUEBA (no
  ampara nada)», y fijar el folio deja el HTML sin `uuid-real-456`. El archivo
  además separa los tres pares que importan (sin PAC / sandbox / producción,
  cola caída / cola vacía, timbre a medio registrar / completo) — es cobertura
  de estados, no de camino feliz.
- **`/admin/consumo` prueba resiliencia POR SECCIÓN, con contra-aserción.** Sus
  cuatro primeros casos tiran `getResumenNegocio`, `getConsumoPorAgente` y
  `getPresupuestoPorProposito` por separado y exigen que la mitad viva siga
  pintada, más `not.toContain('No se pudo leer el costo por flota')` en el caso
  de arreglo vacío. La mutación del orden (#13) muere. Es el patrón
  «null ≠ vacío» bien probado.
- **El cotejo de la clave del SAT tiene arnés de verdad.**
  `facilidad15_regimen_cotejado.test.ts` no se conforma con el mensaje: afirma
  que **`rpc` no se llamó** ante `601` + «Sí» (`:77`, con el comentario
  explicando por qué esa es la aserción que importa), y cubre la dirección
  segura (`601` + «No» pasa), el `null` (no se inventa veredicto) y la lectura
  caída (falla cerrado sin escribir).
- **El trinquete de cobertura sigue mordiendo.** `ci.yml:77` corre
  `npm run test:coverage` en **cada push a toda rama** (`:21-23`) y `:85`
  recupera las dos pruebas de tiempo que `--coverage` salta. Las corridas de
  `ci.yml` sobre `4e36c82` y sobre los commits de la ventana están en
  `success`.
- **`migraciones_verificadas.test.ts` obligó a las 9 nuevas a tomar una
  decisión explícita**, y la exención de la `0353` (`:54`) es el tipo de razón
  que se puede refutar: cita que `pg_get_functiondef()` salió byte-idéntico
  contra producción. No es una lista de excepciones para tapar deuda.
- **La disciplina «commit con prueba» aguanta.** Los commits de arreglo de la
  ventana (`15fd8d3`, `94de18f`, `0754652`, `d0db998`, `e2038a5`) traen su
  archivo de prueba en el mismo commit.
- **El árbol quedó limpio**: worktree desechable borrado (`git worktree list` →
  una sola entrada) y `git status --porcelain` vacío salvo este archivo.

---

## Lo que NO alcancé a revisar

- **Ni un `psql`, quinta ronda seguida.** No hay Postgres en el contenedor.
  Todo lo que digo de los 9 tests SQL y de `verificaciones.sql` es **lectura
  estructural**: cero mutaciones de SQL. Es el hueco más grande del rubro y ya
  no se cierra con más lectura. Lo que sí puedo afirmar es que los seis nuevos
  están **invocados** en `ci-postgres.yml:193-198`.
- **Los 29 arneses huérfanos de `supabase/tests/` siguen ahí, sin cambio.** Los
  volví a contar hoy (53 archivos, 29 sin una sola mención en
  `ci-postgres.yml`) y son **los mismos 29** de la 29 — todos de las series
  0319–0337 (GPS, capacidad, Cal.com). No los abrí uno por uno esta ronda: el
  presupuesto se fue en mutar la campaña nueva, que era el foco.
- **No corrí `--coverage` yo mismo.** Doy por buena la medición vigente porque
  CI la evalúa en cada push y está verde; no es una corrida mía y lo digo aquí.
- **No medí intermitencia.** Una sola corrida por mutación, sin repeticiones ni
  husos horarios distintos. No puedo afirmar nada sobre pruebas que dependan de
  la hora o de la red, salvo que ninguna de mis 34 corridas dio un resultado
  distinto entre el alcance corto y el largo.
- **Muté 20 de los 49 archivos de prueba nuevos**, no los 49. Los 29 restantes
  los leí por encima para clasificarlos (render vs props) pero no los ataqué.
  Si el patrón se sostiene —y las 11 mutaciones de cifra en 7 páginas distintas
  sugieren que sí—, el hueco de PRU-C1 es más grande que las 11 que medí.
- **No toqué la Capa 0 (`wa_leases_fencing.sql`, pgTAP), `playwright-smoke` ni
  `e2e-navegador.yml`.** Séptima ronda fuera por falta de `pg_prove` y
  navegador.
- **No revisé `pruebas-manuales/`** (prohibido correrlas) más allá de confirmar
  que siguen fuera del `include` de vitest.

---

## Árbol limpio

```
$ git status --porcelain
```

*(salida vacía; el único archivo que agrego es este entregable. El worktree
desechable `<scratchpad>/wt-pru` quedó borrado —`git worktree list` devuelve
una sola entrada, `/home/user/cuadra  4e36c82 [claude/auditoria-30]`— y cada
mutación se revirtió con `git checkout --` inmediatamente después de su
corrida.)*
