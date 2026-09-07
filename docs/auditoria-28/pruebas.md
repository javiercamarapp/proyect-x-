# Pruebas — auditoría 28

**Nota: 6/10** (antes 6). **Ninguna de las tres razones aplica, así que la nota se
queda igual y lo digo con esas palabras.** No hubo commits que cerraran ningún
hallazgo del rubro (verifiqué que los **13 archivos** de mis hallazgos abiertos
están **byte a byte idénticos** desde `06b2eca4`, la base de la 27: `git log
06b2eca4..HEAD -- <los 13>` no devuelve un solo commit). Ninguna advertencia
previa cobró factura todavía. Y la mirada más profunda de esta ronda —muté la
superficie nueva, que es la única que existe— **confirma la misma clase que ya
sostenía el 6**, no una peor: los diez sobrevivientes están en honestidad de UI y
en fontanería de CI, y el motor del dinero sigue matando todo lo que le tiro
(sexta ronda seguida).

Riesgo mayor del rubro, hoy: **el único commit de producto de la ventana trajo
las dos únicas pruebas nuevas de UI del mes, y 10 de las 15 mutaciones que le
apliqué a ese código sobrevivieron — las pruebas afirman la ausencia del mensaje
equivocado, nunca la presencia del correcto.**

---

## Cómo se midió (repetible)

Todo en un `git worktree --detach` bajo el scratchpad sobre `d56e626`, con
`node_modules` por symlink. El worktree quedó **borrado** (`git worktree list` →
una sola entrada) y el árbol vivo no se tocó.

- **Inventario propio**: `find src scripts supabase -name '*.test.ts*' | wc -l` →
  **908** archivos de prueba (el MAPA dice 880 midiendo solo `src/`; vitest
  también colecta 908, así que uso ése).
- **Línea base reproducida** (suite completa, worktree limpio): **908 archivos,
  12,193 pruebas, 1 saltada, 5 fallan**, 172 s. Los 5 son los de IPv6 de
  `scripts/ci/e2e/proxy-local.test.ts`, INFRA, tal como dice el encargo.
  Sobrevivir = **exactamente 5 fallos, ni uno más**.
- **Línea base del subárbol `scripts/ci`**: 23 archivos, 359 pruebas, **5 fallan**
  (los mismos). Toda mutación de `prepare-build-env.mjs` se midió contra ésa.
- **15 mutaciones dirigidas**, todas sobre las **tres únicas superficies nuevas de
  la ventana** (`actividad.tsx`, `rentabilidad/vista.tsx`,
  `scripts/ci/prepare-build-env.mjs`). **5 murieron, 10 sobrevivieron.** Los
  siete sobrevivientes de la primera tanda se aplicaron **a la vez** y se
  corrieron contra la **suite entera** para no confundir un alcance corto con
  una prueba floja: 908/12,193, **5 fallos, la línea base**.
- **1 render real** de `VistaRentabilidad` con `?p=99` sobre 350 facturas, para
  leer el texto que ve el contralor en vez de razonarlo.

### Mutaciones

| # | Qué rompí | `archivo:línea` | Resultado |
|---|---|---|---|
| A1 | revierto el arreglo: la guarda vuelve a ser solo `porDia === null` | `actividad.tsx:46` | **muerta** |
| A2 | quito la **otra** mitad: se queda solo `modo === 'historico' && porMes === null` | `actividad.tsx:46` | **SOBREVIVE** (suite completa) |
| A3 | `sinDatos` del histórico → `false` | `actividad.tsx:60` | **muerta** |
| A4 | el histórico deja de dibujar: `<AreaChartSimple/>` → `<></>` | `actividad.tsx:72` | **SOBREVIVE** |
| R1 | revierto el arreglo: el portón vuelve a `cobranza.facturas.length === 0` | `vista.tsx:114` | **muerta** |
| R2 | borro el aviso de página vacía: la tabla se pinta siempre (encabezados y cero filas) | `vista.tsx:139` | **SOBREVIVE** (suite completa) |
| R3 | el aviso miente el total: `numero(cobranza.total)` → `numero(cobranza.facturas.length)` | `vista.tsx:145` | **SOBREVIVE** (suite completa) |
| R5 | «Por cobrar» imprime **$0** en vez de los $480,000 reales | `vista.tsx:125` | **SOBREVIVE** |
| R6 | el renglón de paginación miente el total: `de ${numero(cobranza.total)}` → `de 0` | `vista.tsx:189` | **SOBREVIVE** sobre `d56e626` (la ve morir el arreglo FE-2 que entró al árbol vivo mientras yo medía — ver abajo) |
| P1 | fuera el candado de symlink del `.env` que se va a hidratar | `prepare-build-env.mjs:37` | **SOBREVIVE** (suite completa) |
| P2 | el hijo hereda `SUPABASE_DB_URL`: `ADMIN_KEYS` → `ADMIN_KEYS.slice(0, 2)` | `prepare-build-env.mjs:64` | **SOBREVIVE** (suite completa) |
| P3 | fuera el filtro `!item.disabled` al elegir la llave `service_role` | `prepare-build-env.mjs:56` | **SOBREVIVE** (suite completa) |
| P4 | el rechazo de llaves admin en el `.env` descargado solo mira 1 de las 3 | `prepare-build-env.mjs:40` | **SOBREVIVE** (suite completa) |
| P5 | `redirect: 'error'` → `'follow'` y fuera el timeout | `prepare-build-env.mjs:50` | **muerta** |
| P6 | el `finally` deja de restaurar la máscara del `.env` | `prepare-build-env.mjs:96` | **muerta** |

**Lectura**: 1 de 5 en `vista.tsx`, 2 de 4 en `actividad.tsx`, 2 de 6 en
`prepare-build-env.mjs`. El patrón no es aleatorio: **muere todo lo que revierte
el bug original** (A1, R1) y **sobrevive todo lo que rompe el camino nuevo**.

---

## Hallazgos

### [MEDIO] `vista.test.tsx` renderiza el escenario `?p=99` exacto y sus tres aserciones son ciegas a la cifra inventada que produce

`src/app/dashboard/rentabilidad/vista.test.tsx:27-37` (el caso) ·
`vista.test.tsx:32-36` (las tres aserciones) ·
`src/app/dashboard/rentabilidad/vista.tsx:45` (`hasta`) y `:189` (el renglón)

**Escenario (renderizado, no razonado).** Renderé `VistaRentabilidad` con
exactamente el caso de la prueba nueva —`{ facturas: [], total: 350, pagina: 99,
porPagina: 100, porCobrar: 480_000 }`— y leí el texto plano:

```
Por cobrar (facturas vivas) $480,000.00   Vencido $120,000.00
Esta página no tiene facturas — hay 350 en la cartera completa.
Facturas 0–9,800 de 350, las vencidas primero. …   Anteriores
```

**«Facturas 0–9,800 de 350».** `desde` sí tiene portón para la página vacía
(`vista.tsx:43`, `cobranza.facturas.length ? … : 0`); `hasta` no lo tiene
(`:45`, `(99−1)·100 + 0 = 9800`). Antes de `4de95a0` ese renglón era inalcanzable
con `?p=` fuera de rango porque el `EstadoVacio` sustituía la sección entera: el
commit **destapó** la cifra inventada, y la prueba que llegó con él pasa por
encima. Sus tres aserciones son `not.toMatch(/Aún no hay facturas/)`,
`toMatch(/Por cobrar/)` y `toMatch(/350/)`; ninguna mira el rango. Peor, `/350/`
se satisface desde **dos** sitios distintos y **cada uno puede mentir por
separado**: lo medí con R3 (el aviso imprime `facturas.length` en vez del total)
y R6 (el renglón imprime `de 0`), y las dos mutaciones pasan.

**Consecuencia.** «Un rótulo tiene que ser verdad» y «nunca inventar una cifra»
son las dos reglas que `CLAUDE.md` pone primero, y la pantalla imprime un rango
27 veces mayor que la cartera completa. El contralor que pagina y se pasa lee
«9,800» en la pantalla donde va a cruzar su cartera contra su contador.

**Causa raíz probable:** la prueba se escribió para fijar el portón del vacío
(`total === 0`) y se dio por terminada ahí; nadie leyó el render completo del
caso que ella misma construye.

**Nota de honestidad, importante:** mientras yo medía, el rubro de **frontend**
metió al árbol vivo (sin commit todavía) el arreglo `AUD28 FE-2` que corrige
`hasta`/`hayMas` y **ancla exactamente esto** con `toMatch(/Facturas 0–0 de
350/)` + `not.toMatch(/9,800/)`. Lo encontré por mi cuenta y por otra vía (el
render), y lo dejo escrito porque el hallazgo de **pruebas** no es el bug: es que
**una prueba nueva puede renderizar la mentira y salir verde**. Con el arreglo de
frontend puesto, R6 muere; **R2, R3 y R5 siguen vivas** (el renglón de
paginación sigue trayendo «de 350», que es lo único que `/350/` necesita).

---

### [MEDIO] Las dos pruebas nuevas afirman la **ausencia** del mensaje equivocado y nunca la **presencia** del contenido correcto: la gráfica y la tabla pueden desaparecer enteras con la suite verde

`src/app/dashboard/actividad.test.tsx:30-36` (`not.toMatch` × 2, ninguna
positiva) · `src/app/dashboard/actividad.tsx:72` ·
`src/app/dashboard/rentabilidad/vista.test.tsx:32-36` ·
`src/app/dashboard/rentabilidad/vista.tsx:139-146`

**Escenario.** Dos mutaciones, las dos medidas:

- **A4** — cambio `<AreaChartSimple datos={porMes ?? []} …/>` por `<></>`
  (`actividad.tsx:72`). El modo Histórico deja de dibujar **cualquier cosa**: un
  recuadro en blanco. El tercer caso de la prueba nueva («porMes con datos
  reales») solo exige que **no** aparezcan los dos mensajes de error, y un
  fragmento vacío tampoco los tiene → **verde**, 72 archivos / 411 pruebas del
  subárbol.
- **R2** — cambio `{cobranza.facturas.length === 0 ? (` por `{false ? (`
  (`vista.tsx:139`). Se borra el aviso «Esta página no tiene facturas — hay 350
  en la cartera completa.» que es **la mitad del arreglo del commit**, y vuelve
  la tabla con encabezados y cero filas: el patrón que `estado.ts:57-59` describe
  como el modo de falla que hay que evitar («los KPIs dicen 12 viajes y la tabla
  de abajo sale con encabezados y cero filas»). **Suite completa: 5 fallos, la
  línea base.**
- **R5**, de la misma familia — `valor={cobranza.porCobrar}` → `valor={0}`
  (`vista.tsx:125`). El `it` se llama literalmente «…**y sigue mostrando lo por
  cobrar**», y lo que comprueba es `toMatch(/Por cobrar/)`: la **etiqueta**. Los
  $480,000 pueden salir como **$0** y la prueba que lleva esa promesa en el
  nombre no se entera. Un cero que parece medición es exactamente lo que la regla
  del producto prohíbe.

**Consecuencia.** Las dos pruebas nuevas son la evidencia con la que el equipo va
a creer que estas dos pantallas están cubiertas —son las únicas pruebas de UI que
entraron este mes—, y la mitad del código que dicen cubrir se puede borrar sin
que nada se ponga rojo. Es la misma forma del CRÍTICO de la 27 (una capa verde
sobre algo que no mide), a menor escala y sobre código recién escrito, o sea que
la clase sigue produciendo instancias.

**Causa raíz probable:** `renderToStaticMarkup` + `not.toMatch` es cómodo para
fijar «no digas la mentira» y no obliga a nombrar lo que sí debe verse; falta el
`expect` positivo sobre la cifra o el nodo.

---

### [MEDIO] El blindaje FE-5 de `Actividad` (el que la propia prueba nueva cita como precedente) no tiene una sola prueba: se puede borrar y la suite entera queda verde

`src/app/dashboard/actividad.tsx:46` · `src/app/dashboard/actividad.test.tsx:11-13`
(el comentario que lo cita) · `src/app/dashboard/panel-periodo.test.tsx:31` (la
única otra mención, y es negativa)

**Escenario (A2, medido contra la suite completa).** Dejo la guarda como
`if (modo === 'historico' && porMes === null)`, es decir borro la mitad
`modo !== 'historico' && porDia === null` — el blindaje FE-5 del 22-ago-2026, el
que el comentario de la prueba nueva invoca como el precedente que se estaba
copiando. Con la mutación, `getViajesPorDia` caída (`porDia === null`) en modo
Semanal cae a `serie = []` → `datosBarras = []` → `sinDatos = [].every(…)` =
**vacuamente true** → la pantalla imprime **«Sin viajes iniciados en este
periodo.»**. Es la lectura caída pintada como flota parada: literalmente el bug
que el arreglo de esta ventana vino a corregir, pero en el otro modo.
**908 archivos, 12,193 pruebas, 5 fallos: la línea base.**

Lo intenté refutar: la única otra prueba que toca esta cadena es
`panel-periodo.test.tsx:31`, y su aserción es `not.toContain('No se pudo cargar
esta gráfica')` — comprueba que el mensaje **no** salga cuando no debe, nunca que
salga cuando sí. `actividad.test.tsx` pasa los tres casos con `modo="historico"`
y `porDia={[]}`: no ejercita `porDia === null` ni una vez.

**Consecuencia.** El contralor con la base a medias ve «Sin viajes iniciados en
este periodo» en el recuadro principal del panel y sale a preguntarle a su
despachador por qué la flota no movió nada. Se arregló el caso nuevo y se dejó el
viejo —al que el arreglo se parecía— sin arnés, en el mismo `if`.

**Causa raíz probable:** el caso nuevo se probó por la rama que se agregó; la
rama que ya estaba en ese `||` nunca tuvo prueba y el commit no lo notó porque
tampoco la necesitaba para pasar.

---

### [BAJO] `prepare-build-env.mjs` hidrata la llave `service_role` y cuatro de sus diez candados no tienen una sola aserción

`scripts/ci/prepare-build-env.mjs:37` (symlink) · `:40` (`ADMIN_IN_PULLED_ENV`) ·
`:56` (`!item.disabled`) · `:64` (`delete childEnv[key]`) ·
`scripts/ci/prepare-build-env.test.ts:88-93` (el `it.each` que solo cubre 1 de
las 3 `ADMIN_KEYS`) y `:29-30` (el que solo borra 2 de las 3)

**Escenario.** Cuatro mutaciones, las cuatro contra la **suite completa**, las
cuatro con **5 fallos** (línea base):

- **P1** — quito `|| lstatSync(file).isSymbolicLink()`. El script hace `chmod
  0600` + `writeFileSync` del `.env` **hidratado con la `service_role` real**
  sobre ese path. Si algo dejó ahí un symlink antes del paso (`npm ci` corre
  antes que `vercel pull` en el mismo job — un `postinstall` de dependencia es
  el vector realista, porque `.vercel` está en `.gitignore` y no puede venir del
  checkout), la llave se escribe **a través** del enlace, a un path que el
  atacante eligió. El candado se escribió a propósito, con su `eslint-disable`
  y todo; ninguna prueba crea un symlink.
- **P2** — `for (const key of ADMIN_KEYS.slice(0, 2))`: el hijo `vercel build`
  hereda `SUPABASE_DB_URL` (la cadena de conexión directa con contraseña). El
  test comprueba `SUPABASE_ACCESS_TOKEN` y `SUPABASE_DB_PASSWORD`
  (`:29-30`) y **`SUPABASE_DB_URL` no aparece ni en el `env` del fixture ni en
  ninguna aserción del archivo**.
- **P4** — `ADMIN_KEYS.slice(0, 1)` en el rechazo del `.env` descargado: el
  `it.each(['missing','empty','admin'])` solo siembra `SUPABASE_ACCESS_TOKEN`,
  así que las otras dos patas del mismo `some()` son gratis.
- **P3** — quito `!item.disabled`. Si el proyecto quedara solo con una
  `service_role` deshabilitada (rotación a medias), el build sale con una llave
  muerta y el deploy llega a producción con el panel ciego.

**Consecuencia (y por qué es BAJO y no más).** Fui a refutarlo:
`deploy-preview-promote.yml:270-276` y `:378-387` le pasan al paso **solo**
`VERCEL_TOKEN` y `SUPABASE_ACCESS_TOKEN` — `SUPABASE_DB_URL` y
`SUPABASE_DB_PASSWORD` **no están hoy en el entorno de ese step**, así que P2 y
P4 son defensa en profundidad contra una edición futura del workflow, no una
fuga viva. Por eso BAJO. Lo que sí es del rubro: el archivo de prueba es de los
buenos del repo —111 líneas, 8 casos, cubre conflicto de valores, restauración,
redacción de log y `redirect: 'error'`, y mató P5 y P6— y aun así sus autores
cubrieron el camino de las credenciales y dejaron sin tocar los cuatro candados
que solo actúan cuando el runner ya está sucio. En un script que maneja la
`service_role`, esos son justo los que importan.

**Causa raíz probable:** el fixture define un solo entorno feliz
(`.vercel/.env.*.local` como archivo normal, `env` con dos secretos) y todos los
casos negativos se derivan de él variando el **contenido** del `.env`, nunca su
**forma** ni el resto del entorno.

---

### Hallazgos abiertos de la 27 — verificados uno por uno, los diez REINCIDENTES

`git log 06b2eca4..HEAD -- src/lib/likida/cuadre/engine.ts
src/lib/likida/intake/ocr.ts src/lib/likida/fiscal_agregado.test.ts
supabase/verificaciones.sql src/lib/likida/jornada/repo.ts
src/lib/likida/proveedores.ts src/lib/likida/facturacion/pendientes.ts
src/lib/likida/sat_descarga/escritura.ts vitest.config.ts
.github/workflows/ci-postgres.yml src/lib/likida/migraciones_verificadas.test.ts
scripts/ci/e2e/proxy-local.test.ts scripts/ci/calificar-verificacion.mjs` →
**cero commits**. Los trece archivos están intactos. Siguiendo el MAPA, no los
vuelvo a argumentar; los enumero con su `archivo:línea` y la comprobación que sí
rehice.

| Severidad | Hallazgo (27) | `archivo:línea` | Estado |
|---|---|---|---|
| **CRÍTICO** | tres capas verdes sobre `ocr_extra.renglones`, entrada que producción no puede producir desde `b349b724` | `cuadre/engine.ts:974` · `intake/ocr.ts:62-78` | **REINCIDENTE, reverificado**: `grep -rn renglones src/lib/likida --include=*.ts` sin pruebas → los únicos aciertos son prosa de otros módulos (`pdf.ts`, `bandeja.ts`, `omitidos.ts`); **sigue sin escritor**, y `ocr.ts:64-77` conserva el comentario de la retirada |
| ALTO | 29 de 47 arneses de `supabase/tests/` sin invocador; eximan 11 migraciones | `migraciones_verificadas.test.ts:53-66` · `ci-postgres.yml:175-191` | REINCIDENTE (archivos intactos) |
| ALTO | la paridad que sostiene la exención de la 0317 es `f(x) === f(x)` | `fiscal_agregado.test.ts:125-161` | REINCIDENTE (archivo intacto) |
| ALTO | el bloque 47 de la batería sale `✓ ok` con 8 de 11 mediciones sin calificar | `verificaciones.sql:2735` · `calificar-verificacion.mjs:86-96` | REINCIDENTE (2.ª vez) |
| MEDIO | el trinquete de cobertura con 4.3–7.9 puntos de holgura | `vitest.config.ts:106-123` | REINCIDENTE. **No lo remedí esta ronda**: con 5 fallos de infra vitest no imprime cobertura, y ese fallo es el mismo que la 27 documentó |
| MEDIO | las tres escrituras de jornada pierden sus candados con la suite verde | `jornada/repo.ts:524`, `:556`, `:588` | REINCIDENTE (3.ª vez) |
| MEDIO | `decidirFacturaProveedor` pierde su candado de idempotencia | `proveedores.ts:322` | REINCIDENTE |
| BAJO | `contarConCfdi` puede devolver `0` cuando la base falla | `facturacion/pendientes.ts:221` | REINCIDENTE (3.ª vez) |
| BAJO | `sat_descarga/escritura.ts` sin un solo archivo de prueba | `sat_descarga/escritura.ts:157` | REINCIDENTE (3.ª vez) |
| BAJO | la prueba que exige loopback IPv6, sin `skipIf` ni requisito declarado | `scripts/ci/e2e/proxy-local.test.ts:21` | REINCIDENTE. **Cobró un poco de factura**: el encargado de esta ronda y el MAPA gastan un párrafo cada uno en explicar que esos 5 rojos no cuentan |

---

## Lo que revisé y está bien

- **Los dos arreglos de `4de95a0` sí están anclados y sí llegan a producción.**
  A1 y R1 —las mutaciones que revierten literalmente cada bug— **mueren las dos**.
  Y fui a comprobar que el `null` de verdad viaja, que es la trampa de la 27
  (probar una entrada imposible): `inicio-contenido.tsx:725` ya pasa
  `porMes={viajesPorMes}` **sin** el `?? []`, `panel-periodo.tsx:42` lo tipa
  `| null` y `:101` lo reenvía. La cadena `getViajesPorMes → safe() → null` es
  producible de punta a punta. No es un fixture imposible.
- **A3 muere**: si `sinDatos` deja de mirar el histórico, el caso «vacío real»
  se cae. El portón de las tres situaciones (falló / vacío / con datos) está
  distinguido de verdad en el eje que el commit vino a arreglar.
- **`prepare-build-env.test.ts` mata lo que más importa del script**: P5
  (`redirect: 'error'` → `'follow'`, o sea seguir un redirect del proveedor con
  el `Authorization` puesto) muere en 2 casos, y P6 (el `finally` que restaura la
  máscara del `.env`) muere en 4. La restauración está anclada desde tres
  ángulos distintos (éxito `:49`, aborto `:57`, build fallido `:78/:109`), que es
  cómo se prueba un `finally`.
- **`deploy-pipeline.test.ts` se actualizó con el cambio, no después.** `ebb215c`
  mueve las aserciones de orden (`prepare-build-env.mjs` entre `pull` y `deploy
  --prebuilt`) en el **mismo commit** que mete el script: la prueba de orden del
  pipeline no quedó fijando el mundo viejo. Es lo contrario del anti-patrón que
  reporté en la 27.
- **La disciplina de «commit con prueba» se sostiene en la ventana**: los 3
  commits que tocan `src/`/`scripts/` traen los 3 su archivo de prueba (2 nuevos
  + 1 actualizado). Cero commits de código sin prueba en la ventana.
- **El árbol quedó limpio**: 15 mutaciones en un worktree desechable,
  `git worktree list` con una sola entrada, y `git status --porcelain` del árbol
  vivo sin una sola línea mía (lo que aparece ahí es el arreglo en vuelo del
  rubro de frontend y un `__pycache__/` que ya estaba antes de que yo entrara).

---

## Lo que NO alcancé a revisar

- **Cobertura no se midió esta ronda.** Con los 5 fallos de infra vitest **no
  imprime el reporte ni evalúa los umbrales**, y correr `--coverage` excluyendo
  ese archivo cuesta una corrida larga que preferí gastar en mutaciones. Doy por
  buena la cifra de la 27 (83.22 / 73.31 / 86.64 / 85.91) y **eso es una
  suposición, no una medición de hoy** — es exactamente la trampa contra la que
  el MAPA advierte, y por eso lo digo aquí y no en el hallazgo.
- **Ni un `psql`.** No hay Postgres en el contenedor (la 27 tampoco pudo). Todo
  lo que digo de `verificaciones.sql`, de los 29 arneses huérfanos y de las
  migraciones sigue siendo estructural: **cero mutaciones de SQL, tercera ronda
  seguida.** Es el hueco más grande del rubro y ya no se cierra con más lectura.
- **No volví a barrer las 224 funciones exportadas sin mención en ninguna
  prueba** (la cifra de la 27). Con la ventana en 3 commits el barrido no habría
  cambiado, pero no lo remedí, así que no lo cito como medido.
- **No toqué la Capa 0 (`wa_leases_fencing.sql`, pgTAP), `playwright-smoke` ni
  `e2e-navegador.yml`.** Quinta ronda seguida que quedan fuera por falta de
  `pg_prove` y navegador.
- **No corrí la suite bajo otros husos horarios** ni busqué intermitencia con
  corridas repetidas: una sola corrida completa (más una por mutación acotada).
- **El árbol se movió debajo de mí**: arranqué en `d56e626` y el `HEAD` pasó a
  `93228da` (docs de esta ronda), y el rubro de frontend metió su arreglo FE-2 al
  árbol de trabajo sin commit. **Todas mis cifras de verde y de mutación son de
  `d56e626`**; lo único que reevalué a mano contra el arreglo en vuelo es R6
  (muere) y R2/R3/R5 (siguen vivas, porque el renglón de paginación sigue
  imprimiendo «de 350» y eso es todo lo que `/350/` necesita).
