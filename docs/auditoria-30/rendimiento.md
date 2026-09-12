# Rendimiento y costo — auditoría 30

**Nota: 5/10** (antes 6). Razón del movimiento: **mirada más profunda — el
código que importa no cambió**. Entraron dos commits de REN-C1 y ninguno movió
un solo número del rubro: el margen del cron sigue en 43.5 s, la unidad del
consolidado sigue costando 249 viajes de red, y **los 6 hallazgos que la 29 dejó
abiertos están los 6 idénticos, línea por línea** (los verifiqué con grep contra
el fuente de hoy: `PISO_TOPE_TENANT_USD = 5.00`, `COSTO_MINIMO_TURNO_MS =
15_000`, `RESERVA_PARA_LIBERAR_MS = 3_000`, `MARGEN_LOTE_MS = 150_000`, cero
`registrarCostoWhatsApp` en `avisar_cierre.ts`/`aviso_oficina.ts`,
`PASOS_CIERRE` con 20 renglones). No baja a 4 porque `margenUnidadAtomicaMs`
sigue de pie, la mitad *reintentable* de REN-C1 cerró con una prueba que muere
al revertir, y el cursor de `e2038a5` sí borra un `OFFSET` que crecía — con el
índice que lo sostiene.

**El riesgo mayor hoy:** el botón «Ejecutar ahora» del Agente de Peajes
(`barrerPorConciliar`) es una cadena de **3,047 viajes de red / 914 s
nominales** sin un solo chequeo de reloj, contra un techo de plataforma de
300 s — el contralor lo aprieta en la sala, se queda 5 minutos mirando, recibe
un error, y la cola SÍ bajó ~317 líneas que el acuse nunca le dijo.

---

## Veredicto de REN-C1

**MUTADO.** Cerró la mitad que el commit dice cerrar; la mitad que lo hacía
CRÍTICO —la suma de tiempo— no se tocó, y el arreglo abrió dos huecos nuevos en
el mismo camino.

### Lo que sí cerró, con su ancla

`src/lib/likida/sat_descarga/ciclo.ts:315-354`: el `continue` incondicional del
repetido se partió en `yaDescargado` (`:321`), `decidirCruce` corre siempre
(`:325`), el destino `consolidado` llama a `guardarYConciliarConsolidado`
(`:341`) aunque el sello ya existiera, y el `continue` del repetido se movió
DESPUÉS del bloque (`:354`). La prueba que lo ancla es
`ciclo_flota.test.ts:516-533` («paquete nunca marcado bajado + sello ya
existente: se vuelve a llamar guardarYConciliarConsolidado»): siembra
`db.cfdis.push({cfdi_uuid:'p1-cfdi-1'})` antes de correr y exige
`toHaveBeenCalledTimes(1)`. Revertir `:321` a `if ((metido ?? []).length === 0)
{ …; continue; }` la deja en **0 llamadas** y la prueba muere. Es un mecanismo,
no un asunto de commit. Corrí `pg.test.ts + ciclo_flota.test.ts +
presupuesto.test.ts`: 65 pasan.

### La suma del peor caso: número contra número

`src/app/api/cron/descarga-sat/route.ts:106` sigue diciendo
`margenUnidadAtomicaMs({ consultas: 3, envios: 1 })` = 3 × 9,500 + 1 × 10,000 +
5,000 = **43,500 ms**, y `:90-99` sigue conteniendo el comentario que deja al
consolidado fuera «a propósito». `venceEn` = 300 − 43.5 = **256.5 s**.

La unidad `guardarYConciliarConsolidado` (`intake/consolidado.ts:377-543`),
recontada sobre el código de HOY con L = C = 1,000 líneas y G = 45,000 gastos/mes
(`docs/escala-15k.md:14`):

| paso | archivo:línea | viajes de red |
|---|---|---|
| upsert de `cfdi_xml` | `consolidado.ts:388` | 1 |
| `traerTodo` líneas existentes | `:423` | 1 |
| `traerTodo` gastos ya sellados | `:457` | 1 |
| `candidatosDeGasto` (cursor) | `:342-356` | ⌈45,000/1,000⌉ = **45** |
| `enLotes(porLigar, 10, ligarLineaAGasto)` | `:495` | 100 tandas × 2 = **200** |
| upsert de las líneas | `:527` | 1 |
| **TOTAL** | | **249** |

(Las 2 consultas por línea son reales: `ligarLineaAGasto` lee `ocr_extra`
en `:293` antes del `update` de `:306` siempre que la línea es diésel — y un ECC
de combustible lo es casi entero. `enLotes` corre 10 en paralelo pero **las
tandas en serie**, `lotes.ts:23-30`: 100 esperas encadenadas.)

- **Nominal (0.3 s/consulta, `presupuesto.ts:37`):** 249 × 0.3 = **74.7 s**.
  256.5 + 74.7 = **331.2 s contra `maxDuration = 300`** → **31.2 s de más**. El
  número de la 29 (331.5) no se movió ni un segundo.
- **A techos (`TECHO_PASO_CONSULTA_MS` = 9,500 ms):** 249 × 9.5 = **2,365.5 s**.
  Y lo decisivo: **`candidatosDeGasto` SOLA cuesta 45 × 9.5 = 427.5 s**, o sea
  que a techos ninguna invocación llega jamás al primer `ligarLineaAGasto`
  (`:495`, que es donde se escribe el ÚNICO avance durable de esta función).
  Progreso por corrida a techos: **cero filas**, siempre.

**Cuántas páginas como máximo:** `MAX_PAGINAS = 100` (`pg.ts:48`), o sea 100,000
gastos candidatos; pasado eso `traerTodoDesdeId` lanza `LecturaIncompleta` y el
consolidado falla con error, corrida tras corrida. Con G = 45,000 son 45 páginas
y cabe; con un tenant de 2 meses acumulados sin CFDI (90,000) son 90 y sigue
cabiendo a costa de 855 s a techos.

### Por qué el reintento nuevo no alcanza: el presupuesto es de DOS descargas

El reintento depende de re-bajar el paquete, y el propio archivo escribe su
límite: `ciclo.ts:580-582` — «El paquete del SAT vive 72 h y **se puede bajar 2
veces**, así que re-bajarlo no sólo es trabajo repetido — **a partir de la
tercera vuelta es un RECHAZO del proveedor**» (repetido en `:600-608`). Entonces:

- Corrida N: descarga #1, muere a media conciliación, `bajados.push` no corre
  (`:650`).
- Corrida N+1 (6 h después): descarga #2. **Ésta es la única oportunidad que el
  arreglo compró.** Los CFDI ya sellados cuestan 1 viaje de red cada uno
  (0.3 s), así que para que el consolidado tenga sus 74.7 s hace falta que esté
  dentro de los **primeros 606 XML** del paquete (256.5 − 0.3k ≥ 74.7 → k ≤ 606).
  Un paquete real es «un ZIP con MILES de CFDI» (`ciclo.ts:243`).
- Corrida N+2: `prov.descargar` rebota, `d.ok = false` → `r.errores.push`,
  `todoBien = false` (`:632-635`). La solicitud nunca llega a `'descargada'`, y
  **`ultima_descarga_hasta` nunca avanza** (`:694-699`). La descarga masiva de
  esa flota queda atorada en ese rango **para siempre**, reintentando y
  rebotando cada 6 horas.

O sea: el arreglo convierte «no se concilia nunca» en «se concilia si el ECC cae
en el primer 30 % de un paquete de 2,000, y si no, se lleva por delante la
descarga entera de la flota». Eso es una mutación, no un cierre.

### El hueco nuevo #1: el CFDI recuperado se queda `disponible` para siempre

`ciclo.ts:342-347`: `r.consolidados++` y el `marcar(…, 'ignorado', …)` quedaron
**dentro de `if (!yaDescargado)`**. En el escenario que el arreglo existe para
atender, la corrida que murió era la del CFDI *nuevo* (murió antes de `marcar`),
y la que lo recupera lo ve como *repetido* — así que `marcar` **no corre nunca**.
El `estatus` que quedó puesto en el upsert de `:308` es `'disponible'`, y ahí se
queda. Consecuencia medible: `sat_descarga/bandeja.ts:242-251` lista ese ECC
mensual de $200,000 MXN en la bandeja «disponible» del contador —la cola de
comprobantes que espera que alguien los case 1:1— **indefinidamente**, aunque sus
1,000 líneas ya estén conciliadas; y `r.consolidados` queda en 0, así que el
resumen de la corrida y el latido reportan «0 consolidados» un día en que sí
hubo uno. La regla 3.3.1.7 que este módulo existe para hacer cumplir («nunca
1:1») queda como una invitación en pantalla.

### El hueco nuevo #2 — la respuesta a «¿el cursor evita el `OFFSET` o lo reintrodujo?»

**Lo evita, y hay índice que lo sostiene.** `pg.ts:251-279` pagina con
`.gt('id', cursor).order('id').limit(1000)`; el índice
`public.gasto (tenant_id, id)` de `0061_indices_de_paginacion.sql:84` existe
exactamente para eso. El `range(d, h)` viejo obligaba a Postgres a contar y
tirar `d` filas por página: sobre 45 páginas son ~1,012,500 filas descartadas
(0 + 1,000 + … + 44,000) que ahora no se pagan. El commit es honesto al decir
que **no acelera el total** (siguen siendo 45 vueltas secuenciales) — sí baja el
costo POR página de O(offset) a O(página).

Lo que sí quedó a medias está en los hallazgos de abajo (**REN-30-A1**): el
gemelo exacto de esa consulta, `barrido.candidatos_gasto`
(`consolidado.ts:795-805`), **sigue en `range()`** sobre la misma tabla, el
mismo filtro y la misma carrera. Se arregló una de dos copias.

---

## Hallazgos

### REN-30-C1 · [CRÍTICO] El «Ejecutar ahora» del Agente de Peajes es una cadena de 3,047 viajes de red sin reloj y sin `maxDuration` declarado: 914 s nominales contra un techo de 300 s, y el acuse muere con ella

`src/lib/likida/intake/consolidado.ts:749-912` (`barrerPorConciliar`, cero
referencias a reloj/`venceEn` en todo el cuerpo), `:760` (`.limit(1000)`),
`:795-805` (45 páginas de `traerTodo`), `:832-908` (el `for` que recorre las
1,000 líneas **una por una, `await` por `await`**), `:848`
(`ligarLineaAGasto` → 2 consultas, `consolidado.ts:293` + `:306`), `:855-866`
(el `update` de la línea, 1 consulta más), contra
`src/app/dashboard/agentes/peajes/page.tsx:212-245` (la server action
`ejecutarAhora`, `'use server'` en `:216`, la llamada en `:226`) — **ese archivo
no exporta `maxDuration`**, así que corre con el default de la plataforma y el
techo más alto que cualquier ruta de este repo declara es 300.

**Entra esto → sale esto mal.** El contralor de una flota con 1,000 líneas
`por_conciliar` (el tope literal del `.limit(1000)` de `:760`, alcanzable con un
solo ECC mensual) aprieta el botón. La cadena:

| tramo | viajes de red |
|---|---|
| lectura de la cola (`:755`) | 1 |
| `cfdi_xml` por `.in()` (`:775`) | 1 |
| `barrido.candidatos_gasto` (`:795`, 45,000 filas) | 45 |
| por línea: `ligarLineaAGasto` (2) + `marcar conciliada` (1), **en serie** | 1,000 × 3 = **3,000** |
| **TOTAL** | **3,047** |

Nominal: 3,047 × 0.3 s = **914.1 s**. A techos: 3,047 × 9.5 s = **28,946 s**
(8 h 2 min). Contra 300 s: **614 s de más nominales, 3.05× el límite.**

**Consecuencia para alguien real.** A los 300 s la función muere dentro del
bucle. Para entonces ya cerró (300 − 14.1)/0.9 ≈ **317 líneas** —sellos escritos
en `gasto`, filas marcadas `conciliada`— pero `registrarCorrida(…, 'ok', …)` de
`page.tsx:229` está DESPUÉS del `await` y no corre, y el `catch` de `:238`
tampoco: el proceso ya no existe. El contralor ve un 504 del navegador, la
bitácora de corridas del agente no tiene renglón, `/admin/crons` no tiene nada
que pintar, y el contador de «por revisar» bajó 317 sin que nadie se lo dijera.
Si vuelve a apretar, convergen en ~4 clics de 5 minutos cada uno — y cada clic
miente igual.

**Causa raíz probable:** es el defecto REND-C1 de la auditoría 3 —el mismo que
`lotes.ts:1-7` documenta en su encabezado con estas palabras: «el cruce del
consolidado hacía un UPDATE serial por línea — 1,000 líneas ≈ 300s contra
maxDuration=120s»— **arreglado en `guardarYConciliarConsolidado` (que sí usa
`enLotes`, `:495`) y nunca portado al barrido**, que hace exactamente lo mismo
sobre exactamente el mismo volumen. Nunca se había reportado: `grep` sobre
`docs/` no encuentra `barrerPorConciliar` en ninguna auditoría previa.

---

### REN-30-C2 · [CRÍTICO] A los techos escritos, `candidatosDeGasto` sola (427.5 s) excede el `maxDuration` del cron, y está ANTES del único punto donde el consolidado escribe avance durable: progreso cero por corrida, con el presupuesto de 2 descargas quemándose igual

`src/lib/likida/intake/consolidado.ts:342-356` (45 vueltas a
`TECHO_PASO_CONSULTA_MS` cada una, sin reloj), `:473` (la llamada, sin
`venceEn`), `:495` (`enLotes`, el primer punto que escribe algo que sobreviva a
la muerte del proceso), `src/app/api/cron/descarga-sat/route.ts:13`
(`maxDuration = 300`) y `:106` (margen 43.5 s → `venceEn` 256.5 s),
`src/lib/likida/sat_descarga/ciclo.ts:580-582` (el presupuesto de 2 descargas).

**Entra esto → sale esto mal.** G = 45,000 (`docs/escala-15k.md:14`) → 45 páginas
(`PAGINA = 1,000`, `pg.ts:45`). A `TECHO_PASO_CONSULTA_MS` = 9,500 ms
(`presupuesto.ts:83`), esas 45 páginas son **427.5 s**, contra los **43.5 s** que
le quedan a la unidad si arranca en `venceEn`, y contra los **300 s** de la
invocación entera aunque arrancara en el segundo 0. Como el bloque de sellos
(`:495`) va DESPUÉS, la corrida muere sin dejar **ni una fila** de avance: no hay
`cfdi_consolidado_linea` (`:527` es el último paso) ni sellos en `gasto`. La
reanudación de `:445-470`, que el comentario de `ciclo.ts:331-339` invoca como
garantía del arreglo, **no tiene nada que reanudar**. Y cada intento fallido
consume una de las **dos** descargas permitidas del paquete: dos corridas
después, `prov.descargar` rebota y la solicitud queda atorada.

Basta con que **5 de las 45 páginas** peguen en el tope (5 × 9.5 + 40 × 0.3 =
59.5 s) para comerse los 43.5 s que quedan tras `venceEn`. No hace falta el peor
caso completo.

**Consecuencia para alguien real.** El IVA acreditable del ECC mensual sigue sin
llegar a la cola del contador —$27,600 sobre un estado de cuenta de $200,000
MXN— igual que antes de `d0db998`, y ahora además la flota pierde la descarga
masiva del rango entero. El latido no lo dice: la invocación muere antes de
`registrarLatido` (`route.ts:157`), así que el tablero pinta «no late» sin causa,
y `avisarCierrePeaje` —que corre DESPUÉS en la misma invocación, `route.ts:125`—
no corre para NINGUNA flota ese día.

**Causa raíz probable:** el arreglo de REN-C1 atacó la *idempotencia* del
camino y dejó intacto su *dimensionamiento*: la única unidad atómica del cron
sin techo propio sigue sin techo propio, y sin un chequeo de reloj entre la
página 1 y la 45 no hay forma de que corte limpio. (REINCIDENTE de REN-C1 de la
29 en su mitad de tiempo.)

---

### REN-30-A1 · [ALTO] El cursor se aplicó a una de las dos copias de la misma consulta: `barrido.candidatos_gasto` sigue paginando por `OFFSET` sobre la misma tabla viva, con el mismo filtro

`src/lib/likida/intake/consolidado.ts:795-805` (`traerTodo` con
`.order('id').range(d, h)`) contra su gemela ya migrada, `:342-356`
(`traerTodoDesdeId` con `.gt('id', …)`). Las dos leen `gasto` filtrando
`tenant_id` + `cfdi_uuid IS NULL` + rango de `fecha`, las dos alimentan
`conciliarLineas`, las dos sirven al mismo contador.

**Entra esto → sale esto mal.** Mismos supuestos: G = 45,000 → 45 páginas. Con
`range()`, Postgres cuenta y tira `0 + 1,000 + … + 44,000 = 1,012,500` filas de
más a lo largo de la lectura; con el cursor, cero. Y el defecto de corrección
que motivó `e2038a5` está intacto aquí: la lectura dura ~13.5 s nominales
(45 × 0.3), y un gasto que entra por WhatsApp en esa ventana desplaza las
posiciones — una fila se lee dos veces o se salta, con `leidas === esperadas`,
así que `LecturaIncompleta` no lo nota. En el barrido eso significa que un mismo
`gasto` aparece dos veces en `disponibles` y puede volver **ambigua** (2
candidatos) una línea que era única, o al revés: la lógica de `:211-227` cuenta
candidatos, y un duplicado cambia la decisión de `conciliada` a `por_conciliar`.

**Consecuencia para alguien real.** La línea que el barrido existía para cerrar
vuelve a la mesa del contador con dos candidatos que son el mismo gasto — y el
barrido es precisamente el camino que corre cuando el contador ya intentó todo
lo demás.

**Causa raíz probable:** el arreglo se hizo sobre el llamador que el hallazgo
citaba (`consolidado.candidatos_gasto`), no sobre el *patrón*; el `grep` que
hubiera encontrado al gemelo es el nombre de la consulta, y son distintos por
una palabra.

---

### REN-30-M1 · [MEDIO] El keyset nuevo no tiene índice que cubra su propio predicado: si el planeador prefiere `(tenant_id, fecha)`, cada una de las 45 páginas paga un `Sort` de 45,000 filas

`src/lib/likida/intake/consolidado.ts:345-353` (el `select` con `tenant_id` +
`cfdi_uuid IS NULL` + `fecha` entre dos valores + `id > cursor` +
`ORDER BY id LIMIT 1000`), contra los índices que de verdad existen sobre
`gasto`: `(tenant_id, id)` (`0061_indices_de_paginacion.sql:84`) y
`(tenant_id, fecha)` (`0111_indices_escala.sql:76`). **No hay ninguno que lleve
`fecha` y `id` juntos, ni uno parcial por `cfdi_uuid IS NULL`.**

**Entra esto → sale esto mal.** Dos planes posibles, y el repo no fija cuál:
(a) `(tenant_id, id)` → recorrido por PK filtrando `fecha` en el heap. Con un
tenant de un año (540,000 gastos) y un rango de un mes, hay que tocar ~12 filas
por cada una que sirve: ~540,000 accesos repartidos entre las 45 páginas, pero
**O(N) total** — es el plan que el cursor busca. (b) `(tenant_id, fecha)` →
45,000 filas seleccionadas y un `Sort` para cumplir el `ORDER BY id`, **repetido
en cada página**: 45 × 45,000 = **2,025,000 filas ordenadas** por una lectura de
45,000. El planeador tiene motivos para preferir (b): el rango de `fecha` es
mucho más selectivo que `id > cursor` en las primeras páginas.

**Consecuencia.** Si cae en (b), el cursor no compró nada de tiempo y el
consolidado sigue pesando lo mismo o más — que es justo la diferencia entre
REN-30-C2 siendo un riesgo de techos o un fallo cotidiano. **No verificable en
esta ronda: no hay Postgres aquí**, y es el primer `EXPLAIN` que pediría.

---

### REN-30-M2 · [MEDIO] `traerTodoDesdeId` devuelve una lectura corta en silencio; su propio docblock promete lo contrario

`src/lib/likida/pg.ts:267-273`: `if (esperadas !== null && filas.length >=
esperadas) return filas;` seguido de `if (pag.length === 0) return filas;` **sin
volver a mirar `esperadas`**. El contraste está 50 líneas arriba, en `traerTodo`
(`:206-214`), que ante una página vacía con `count` conocido y filas faltantes
hace `break` y **lanza** `LecturaIncompleta`. El docblock de `:245-246` afirma:
«Mismo contrato de `traerTodo`: se demuestra con el `count` EXACTO de la primera
página, o se LANZA `LecturaIncompleta` — nunca una cifra parcial.»

**Entra esto → sale esto mal.** `count: 'exact'` se toma en la página 0
(`:264`). La lectura de 45 páginas dura ~13.5 s nominales; en esa ventana el
camino de WhatsApp liga gastos (`repo.ts`, `ligar` de `ciclo.ts:214`) y esos
`gasto` dejan de cumplir `cfdi_uuid IS NULL`. Si salen 2 filas, la última página
llega vacía con `filas.length = 44,998 < esperadas = 45,000` y la función
**devuelve 44,998 como si fueran todas**, sin log y sin excepción.

**Consecuencia.** El daño real está acotado —las filas que desaparecen son
justamente las que ya no eran candidatas— pero el contrato escrito y el
contrato ejecutado no son el mismo, y el siguiente llamador de
`traerTodoDesdeId` (que lo habrá elegido leyendo ese docblock) puede estar
sumando dinero. Es la clase de promesa que este repo cobra cara: `pg.ts` existe
porque «una cifra parcial se ve exactamente igual que la entera, solo que más
barata» (`:75-77`).

---

### REN-30-M3 · [MEDIO] `FaseCosto` declara `copiloto` y `runner` y **nadie las escribe**: el gasto del copiloto consume el techo diario del tenant por el ledger de reservas y sale $0.00 en `llm_costo`

`src/lib/likida/costos.ts:41` (las 9 fases, con las dos nuevas) y
`supabase/migrations/0351_costo_fase_copiloto_runner.sql` contra
`src/lib/agents/copiloto.ts:217` (`createLlmBudget(opts.budgetTenantId, runId,
'interactivo')`) y `src/app/api/admin/copiloto/route.ts:252`
(`budgetTenantId: sesion.tenantId`), `:263` y `:312` (el gasto del turno sale
por `logger.info('copiloto.costo', …)` y **nada más**);
`src/lib/likida/agentes/runner.ts:765` (`createLlmBudget(…, 'fondo', …)`, sin
`registrarCosto`). `grep 'registrarCosto('` sobre `src/` da 13 llamadores: cinco
archivos, **ninguno de ellos copiloto ni runner**. El propio commit `04b3705` lo
dice: «Solo amplía el dominio permitido en ambos lados — **no hay llamador
todavía** que registre costo con esas fases».

**Entra esto → sale esto mal.** Un turno del copiloto corre
`openai/gpt-5.6-luna` ($0.10/$0.60 por M, `openrouter.ts:212`) con
`maxToolRounds: 5` y `maxTokens: 900` (`copiloto.ts:239-241`), más un reintento
correctivo: del orden de **$0.005-0.012 por turno**. Ese turno **sí** reserva y
liquida contra `llm_presupuesto_reserva` a nombre de `sesion.tenantId`
(`route.ts:24-30` lo declara), o sea que **come del mismo techo diario de $5.00
que `budget.ts:219` le pone a esa flota** — el techo que compra 27.05
liquidaciones a $0.1848 (REN-A1). Una sesión de 50 turnos del fundador son
**$0.50, el 10 % del día de esa flota, y 2.7 liquidaciones de chofer**, y en
`llm_costo` no queda una sola fila: la fase `copiloto` existe en el CHECK y en
el tipo, y su columna vale $0.00 para siempre.

**Consecuencia.** No es «la cifra se lee más barata» por accidente:
`lib/admin/consumo.ts:166` **lo declara por escrito** («El gasto del COPILOTO va
al log (copiloto.costo), no a una tabla»), y eso salva la regla de la casa. Lo
que no salva es el presupuesto: el techo del tenant se agota con gasto que su
propio panel de costos no puede mostrar, así que el día que una flota se quede
sin IA a media tarde, la explicación no estará en ninguna pantalla. Y
`costos_dominio.test.ts` cruza tipo contra CHECK pero **no exige que una fase
declarada tenga escritor**, así que las dos pueden quedarse en cero
indefinidamente sin que nada salga rojo.

---

### REN-30-B1 · [BAJO] El upsert de `cfdi_xml` reescribe el XML completo en cada reintento del consolidado

`src/lib/likida/intake/consolidado.ts:388-402` (`upsert` con `xml: xmlText`),
alcanzado ahora en cada repetido por `ciclo.ts:341`.

**Entra esto → sale esto mal.** Antes del arreglo, un consolidado repetido no
entraba a esta función; ahora entra siempre. Un ECC12 de 1,000 líneas pesa del
orden de **0.5-2 MB** (cada `ConceptoEstadoDeCuentaCombustible` ronda los 400 B),
y se reescribe íntegro en cada re-ingesta del paquete — antes de que el
early-return de `:440-443` pueda ahorrarlo, porque el `upsert` va **primero**.
Con 2 re-bajadas por paquete y varios emisores de monedero por flota son unos
pocos MB por corrida: no rompe nada, pero es trabajo que el early-return de
idempotencia iba a evitar y no evita.

---

## Hallazgos de la 29 que siguen abiertos — los 6, REINCIDENTES

Los verifiqué uno por uno contra el fuente de hoy, no contra el log de commits:

| ID de la 29 | Veredicto | Evidencia de hoy |
|---|---|---|
| **REN-A1** (techo diario = piso $5.00 para los 3 planes) | **REINCIDENTE** | `budget.ts:219` sigue en `const PISO_TOPE_TENANT_USD = 5.00`; `topeDerivadoDelPlan` sigue con `Math.max(derivado, piso)` y el margen 1.5 sigue aplicándose al techo global, no al derivado. Ninguna migración nueva toca `limite_viajes_mes`. El cruce sigue en **811.7 viajes/mes**, que ningún plan del catálogo vende. |
| **REN-A2** (reentrega: 126 s sin reloj contra `maxDuration = 120`) | **REINCIDENTE** | `webhook/whatsapp/route.ts:117` = 120; `processor.ts:904` `COSTO_MINIMO_TURNO_MS = 15_000`; `:1134` `TECHO_REENTREGAS_POR_PROCESO = 2` sigue siendo un `Map` de módulo. 65.4 + 126.0 = **191.4 s contra 120**, y 126.0 > 120 aun con la invocación recién nacida. |
| **REN-M1** (`correo/entrante`: reserva de 3 s para una cola de 13.5 s) | **REINCIDENTE** | `:88` `maxDuration = 60`, `:284` `RESERVA_PARA_LIBERAR_MS = 3_000`. **70.5 s contra 60.** |
| **REN-M2** (`MARGEN_LOTE_MS` 150 s + cola sin reloj) | **REINCIDENTE** | `cron/facturar/lote.ts:80` sigue en `150_000`. A techos: 150 + 130 + 16 × 9.5 = **432 s contra 300**. |
| **REN-M3** (los 2-3 WhatsApp del aviso a la oficina no pagan su costo) | **REINCIDENTE** | `grep -c registrarCostoWhatsApp` sobre `avisar_cierre.ts` y `aviso_oficina.ts` da **0 y 0**. Siguen siendo **$0.016-$0.024 por liquidación** fuera de `llm_costo`, un 8.7-13 % bajo sobre $0.1848. |
| **REN-B1** (`PASOS_CIERRE` en 20 renglones) | **REINCIDENTE** | Conté los renglones de `presupuesto.ts:87-119`: **20**. `getSnapshotCierreLiquidacion` y `getLiquidacionDeViaje` siguen sin renglón: +19.0 s de techo que `MARGEN_CIERRE_MS` no descuenta. |

---

## Lo que revisé y está bien

- **El reintento de REN-C1 es un mecanismo, no un parche cosmético.**
  `ciclo.ts:315-354` distingue «está en la tabla de dedup» de «terminó de
  procesarse», y `decidirCruce` es de verdad puro (`cruce.ts`, depende solo del
  CFDI) así que sacarlo del `if` no cambia la decisión de ningún otro destino:
  el `if (yaDescargado) continue;` de `:354` preserva el dedup exacto para
  `casado`, `ambiguo` y `disponible`. Comprobé las tres ramas.
- **El cursor de `pg.ts:251-279` es correcto y tiene índice.** El avance por
  `pag[pag.length-1].id` no depende de posición, el `count` solo se pide en la
  página 0 (`:264`, igual que `traerTodo`), el tope de `MAX_PAGINAS` lanza en vez
  de devolver el recorte, y `gasto (tenant_id, id)` de la `0061` es exactamente
  el índice que el predicado necesita. Las pruebas de `pg.test.ts` comparan el
  mismo insert concurrente contra las dos funciones; pasan.
- **La honestidad de `enLotes` está donde debe.** `guardarYConciliarConsolidado`
  lo usa (`:495`) con el comentario que cita el hallazgo original y su número
  (300 s con 1,000 líneas). El problema no es que nadie lo supiera; es que la
  copia del barrido no lo heredó.
- **`margenUnidadAtomicaMs` sigue derivando y no copiando**
  (`presupuesto.ts:394-401`), y sigue moviéndose con `LIKIDA_TOPE_CONSULTA_MS`.
  Rehíce las dos sumas que la 29 dio por buenas y siguen cerrando: `gps`
  190.5 + 104.5 = **295.0 s**, `descarga-sat` camino `casado`
  256.5 + 38.0 = **294.5 s**, los dos contra 300.
- **El cron del SAT sigue sin fingir salud.** `route.ts:154-156`: un barrido
  cortado por reloj (`descarga.sinTurno > 0`) es `'parcial'`, nunca `'ok'`. Eso
  es lo que haría visible REN-30-C2 **si** la invocación llegara viva a
  `registrarLatido` — que es justamente lo que no pasa.
- **`/admin/consumo` declara su hueco de medición en lugar de pintar un cero.**
  `lib/admin/consumo.ts:166` dice con todas sus letras que el copiloto va al log
  y que las corridas anteriores a la 0123 traen `NULL`, no `$0`. Es la regla de
  la casa aplicada a un dato de costo.
- **No existe `src/lib/queue/`** (verificado con `ls`): la deuda de cola sigue
  siendo `wa_outbox` + la bandeja durable. Sin cambios que auditar.

## Lo que NO alcancé a revisar

- **El plan real de `consolidado.candidatos_gasto` y de `barrido.candidatos_gasto`**
  (REN-30-M1). Es el `EXPLAIN` que decide si el cursor compró tiempo o solo
  corrección. Sin Postgres aquí no se mide, y es lo primero que instrumentaría.
- **Cuántos CFDI trae de verdad un paquete del SAT y en qué posición cae el ECC.**
  Toda la aritmética de convergencia de REN-C1 (el umbral de 606) depende de eso.
  El repo solo dice «miles» (`ciclo.ts:243`). Con el ECC en la posición 100 el
  arreglo funciona; en la 1,500 no, y la flota pierde la descarga del rango.
- **Cuántas líneas trae un ECC mensual real.** Sigue siendo el supuesto
  declarado de 1,000 (`consolidado.ts:453-456` habla de «más de 1,000»). Con 200
  el desborde nominal del consolidado desaparece; con 3,000 se triplica.
- **El default real de `maxDuration` de una server action en el plan de Vercel de
  este proyecto.** Uso 300 s como techo porque es el máximo que cualquier ruta de
  este repo declara; si el default fuera menor, REN-30-C1 es peor, no mejor.
- **Cuántas llamadas de modelo gasta una liquidación real de punta a punta.**
  Abierto desde la 27: sin saber cuántos mensajes de TEXTO manda un chofer, no se
  sabe si $0.1848 es el costo de una liquidación o el de una conversación corta.
- **`npm test` completo.** Corrí solo `pg.test.ts`, `ciclo_flota.test.ts` y
  `presupuesto.test.ts` (65 pasan). No toqué código: la línea base de la ronda
  (984 archivos / 12,931 pruebas) no la pude haber movido.
