# Backend y API — continuación de la auditoría 26

**Nota: 6/10** (antes 7). Razón del movimiento: **mirada más profunda — la nota
anterior estaba inflada**. El 7 se justificó con «9 de 11 cerrados, **8 con
prueba propia**». Esta continuación mide qué vale ese crédito: el commit más
reciente del rubro (`75ec8629`) arregló la rama de RESPALDO de una consulta,
dejó viva la rama que corre siempre, y **estrenó una prueba de cuatro casos que
no puede ver la diferencia** — dos de sus casos construyen la fila a mano, que
es exactamente el pecado que el mismo commit le reprocha a la prueba de la 25.
La prueba existía; no medía. Y el barrido que pedía esta ronda encontró la
misma clase de defecto en otras tres funciones del archivo, una de ellas con el
criterio ya escrito en CINCO migraciones y nunca aplicado al panel.

(Ese primer defecto lo parchó otro actor de esta misma corrida mientras yo
escribía, y lo commiteó como `fc98bbf6` — ver la nota dentro de BE-1. No mueve
la nota: lo que se califica es que se envió roto y que la verificación de la
ronda no podía verlo.)

El riesgo mayor del rubro hoy sigue siendo el CRÍTICO de la póliza (4ª
aparición, 3ª ronda cerrado a medias): el único artefacto que sale hacia el ERP
del cliente deriva un «IVA/IEPS no acreditable» de una resta cuyos tres
términos dejan de describir el mismo hecho en cuanto el contralor firma un
ajuste.

> Todo `archivo:línea` de este documento está tomado contra `e37baf96`, el
> árbol con el que arrancó esta continuación. El commit `fc98bbf6` —el arreglo
> ajeno descrito en BE-1, que entró mientras yo escribía— mete 5 líneas en
> `analytics.ts`: sobre él, **todo lo que cito por debajo de
> `analytics.ts:1641` corre +5** (el `catch` de `:1649` queda en `:1654`,
> `getLiquidaciones` de `:1961` en `:1966`). Nada más de lo que reporto cambió.

## Veredicto sobre `75ec8629` y el barrido de `select` incompletos

**`75ec8629` es un cierre en la rama equivocada.** El `select` de `leerGastos`
(`analytics.ts:1450`) quedó bien y el tipo (`:1306`) también — el commit es
correcto en lo que toca. Lo que no verificó es **quién llama a `leerGastos`**:

```
analytics.ts:1375   const crudos = reconstruida ? null : await leerGastos(…);
analytics.ts:1376   const gastos = reconstruida?.filas ?? crudos ?? [];
```

`leerGastos` es el camino de RESPALDO, y su propio encabezado lo dice
(`:1428-1433`: «Es el camino de RESPALDO: se usa solo cuando el motor no pudo
reconstruir»). El camino normal son las `filas` que arma `reconstruir`, y en
todo lo commiteado esa proyección **no copia `pagadoEn`** (`:1546-1548` y
`:1626-1645`). Detalle en BE-1, con la nota de que otro actor de esta corrida lo
parchó (`fc98bbf6`) mientras yo escribía.

**Barrido completo del archivo** (18 `.select(` / `.rpc(`, uno por uno). La
clase de defecto —«la consulta trae menos columnas de las que el criterio
importado necesita»— aparece en cuatro sitios más:

| Función | Consulta | ¿Le falta algo a un consumidor? |
|---|---|---|
| `reconstruir` (`:1626-1645`) | proyección en memoria | **SÍ — `pagadoEn`** (BE-1; parchado por otro actor en `fc98bbf6`, ya durante esta corrida) |
| `getKpis` (`:218`) | `kpis_liquidacion_tenant` (0112:327-329) | **SÍ — `revision`** (BE-2) |
| `getDineroObservadoPorTipo` (`:328`) | `dinero_observado_por_tipo_tenant` (0150:486-488) | **SÍ — `revision`** (BE-2) |
| `getLiquidaciones` (`:1961`) / `getLiquidacionesDeViajes` (`:1045`) | `select` sin `revision` | **SÍ** (BE-2) |
| `getHechosSolos` (`:294`) | `.order('id')` sobre uuid v4 | **SÍ — el orden, no la columna** (BE-5) |
| `getLiquidacionDetalle` (`:1350`) | trae `revision`… no; lo pide aparte `leerRevision` | no |
| `getDocumentos` (`:1073`) → `calcularSinCfdi` | `concepto`+`cfdi_uuid` | no: el predicado solo lee esos dos |
| `getDesglosesRecibidos` (`:1723`) | `created_at` existe (0076:65) | no |
| `getLineasPorConciliar` (`:1852`) | `candidatos` + los tres `traerPorIds` | no |
| `getAcreditables` (`:677`) | `acreditables_liquidacion_tenant` | no: la **0308:50** ya le puso `revision in ('aprobada','ajustada')` |
| resto (`leerRpc0150` ×9, `contarViajes`, `contarEscalados`, `getValorAhorro`, `ventanaComprobantes`) | agregados en SQL | no |

**Refutación que sí prosperó:** busqué la misma falla en la póliza —el otro
consumidor de `pagoPendiente` fuera del motor— y **no está**: la RPC 0281
entrega `pagadoEn` (`0281:129-130`), `route.ts:88` lo declara, `aGasto`
(`route.ts:126`) lo copia, y hay una compuerta de versión que falla cerrado si
la RPC va atrás (`route.ts:100-108`). Ese camino está bien hecho y es el molde
de cómo debería verse el del panel.

## Hallazgos

### [CRÍTICO · REINCIDENTE — 4ª aparición, 3ª ronda con cierre PARCIAL] Tras `ajustar`, la póliza sigue inventando un «IVA/IEPS no acreditable» o tirando el periodo entero con 409

`src/lib/likida/contabilidad/poliza.ts:203-205,230` · `src/app/api/export/poliza/route.ts:170,354-369` · `src/lib/likida/cuadre/engine.ts:1636` · `src/lib/likida/revision_recalculo.ts:16-21`

Verificado línea por línea hoy: **sin cambios**. `poliza.ts:203-204` sigue
sumando `subtotalDeclarado` de `porConcepto[]`, que `route.ts:170` arma con
`montoBase = (g.subTotal ?? 0) − (g.descuento ?? 0)` —el `sub_total` crudo del
CFDI, que un ajuste no mueve—; `poliza.ts:205` sigue derivando
`comprobado = anticipo − diferencia` —que un ajuste SÍ mueve—; y `:230` los
resta contra `liq.ivaAcreditable`, que vuelve al mismo valor porque el motor lo
deriva de `g.ivaTraslado` (`engine.ts:1636`) y la 0306 declara intocable el
hecho del CFDI (`revision_recalculo.ts:16-21`).

Escenario (idéntico al de la ronda, revalidado): V-119, anticipo $10,000,
diésel `sub_total` 6,896.55 / `iva` 1,103.45 / `monto` 8,000 y caseta 1,724.14 /
275.86 / 2,000. Ajuste a la baja 8,000 → 800: `comprobado` = 2,800,
`subtotalDeclarado` = 8,620.69, `ivaAcreditable` = 1,379.31 →
`impuestoNoAcreditado` = **−7,200** → `poliza.ts:249-259` bloquea y
`route.ts:357-369` contesta **409 `polizas_incompletas` tirando el periodo
entero**. Al alza (WA-3, el caso canónico del feature): **+7,200** de «IVA/IEPS
no acreditable — viaje V-119» en el archivo ContPAQi, con status 200.

Consecuencia: el contador de la flota asienta un impuesto de $7,200 que no
existe en ningún CFDI, o no puede exportar el mes; en los dos casos nada nombra
al ajuste que la propia app le ofreció.

Causa raíz probable: la 0306 movió la frontera al desglose de la LIQUIDACIÓN y
dejó intacto el del COMPROBANTE, de donde la póliza saca dos de los tres
términos de su resta.

Prueba que lo cubra: **ninguna nueva**. `grep -rn "ajust"` sobre
`src/lib/likida/contabilidad/*.test.ts` y `src/app/api/export/poliza/*.test.ts`
sigue en 0 resultados.

### [ALTO · REINCIDENTE dentro de la misma ronda — `75ec8629` cerró la rama que no corre] El renglón sigue sin poder contestar «¿ya se pagó?» en el camino normal, y la prueba nueva no puede verlo

`src/lib/likida/analytics.ts:1546-1548` y `:1626-1645` (esp. `:1632`, `:1639`) · contra `:1375-1376` · `src/app/dashboard/[id]/vista.tsx:215` · `src/lib/likida/cuadre/engine.ts:162-163,474`

> **Nota de honestidad, escrita al cerrar:** encontré y verifiqué este hallazgo
> contra el árbol COMMITEADO (`e37baf96`, que en este archivo es idéntico a
> `75ec8629`). Mientras redactaba, **otro actor de esta misma corrida lo cerró
> en el árbol de trabajo**: `git diff src/lib/likida/analytics.ts` muestra
> `pagadoEn?: string` agregado a `FilaImprimibleConFiscal` y
> `pagadoEn: x.pagadoEn || undefined` agregado al literal, más un archivo sin
> seguimiento `renglon_pagado_en_reconstruido.test.ts` que lo rotula FE-1b —
> commiteado como `fc98bbf6` antes de que yo cerrara. Lo
> revisé y lo corrí (43 casos con `renglon_pagado_en.test.ts` y
> `analytics.test.ts`: verdes); el arreglo es el correcto y su segunda prueba
> —**paridad** entre los campos del `select` de respaldo y las claves del
> literal principal— es más fuerte que anclar el campo suelto. Dejo el hallazgo
> escrito entero porque **lo que califica no es si hoy está parchado, sino que
> se envió roto con una prueba nueva que no podía verlo** — y porque el hallazgo
> es la evidencia de por qué la nota baja.

`reconstruir` NO devuelve las filas del motor: las **re-proyecta** a un objeto
literal nuevo (`:1633-1644`) a través del tipo `FilaImprimibleConFiscal`
(`:1546-1548`), que enumera `formaPago, cfdiUuid, estadoSat, cfdiValido` y
**no menciona `pagadoEn`**. Las filas de origen sí lo traen —`repo.ts:957`
selecciona `pagado_en` y `:995` lo mapea, y `filasImprimibles`
(`omitidos.ts:93-95`) solo filtra, no proyecta—, así que el dato llega hasta
`:1632` y se tira ahí. Como `LiquidacionDetalle['gastos'][number].pagadoEn` es
opcional, `tsc` no dice nada: **el mismo mecanismo exacto que el commit
describe, un nivel más arriba.**

Entra: V-119 con una caseta CFDI PPD, `forma_pago = '99'`, monto $240, y su REP
ya ingerido — `intake/rep.ts:221` selló `pagado_en = '2026-08-20'`. Sale mal, en
la MISMA pantalla:

- el bloque de Deducibilidad la cuenta como **deducible**: `cubetaDe` corre
  sobre `liq.gastos` (los `Gasto` completos, `analytics.ts:1603`), ve
  `pagadoEn`, `pagoPendiente` es `false` y cae a `'deducible'`
  (`engine.ts:474,480`);
- el renglón de la tabla dice **«Por confirmar» en ámbar**: `estadoRenglon`
  recibe la fila re-proyectada con `pagadoEn: undefined`, y
  `pagoPendiente({formaPago:'99', pagadoEn:undefined})` es `true`
  (`vista.tsx:215`, `engine.ts:163`).

Es palabra por palabra la contradicción que `75ec8629` dice haber cerrado, y en
la rama que corre en toda liquidación sana. La rama que sí arregló
(`leerGastos`) solo se ejecuta cuando `reconstruir` devuelve `null`
(`:1375`), que es precisamente cuando `comprobantesCuadran = false` y
`deducibilidad = null` (`:1419-1420`): ahí **el bloque de Deducibilidad ni se
dibuja**, así que la contradicción que el commit narra no puede ocurrir en la
única rama que tocó.

Consecuencia: para una flota que compra diésel y casetas con convenio —o sea el
caso común— todos sus comprobantes a crédito ya pagados salen en ámbar
«Por confirmar» en la tabla que el contralor firma, mientras el desglose de
arriba y el PDF los cuentan deducibles. Y el equipo cree que está arreglado.

Causa raíz probable: la re-proyección de `reconstruir` es una lista blanca de
campos escrita a mano, y el arreglo se buscó por el `select` de SQL sin
preguntar cuál de los dos caminos alimenta la pantalla.

Prueba que lo cubra **en el árbol commiteado: ninguna, y hay dos que aparentan
cubrirlo** (la que llegó después es la de la nota de arriba).
`renglon_pagado_en.test.ts` (4 casos, los corrí: verdes) mide el `select` de la
rama de respaldo leyendo el fuente —su propio comentario, `:31`, la llama «la
consulta que llena la tabla del detalle», lo que es falso en el camino
normal— y sus casos 3 y 4 (`:54-71`) construyen la fila a mano, que es el mismo
reproche que el commit le hace a `estado_renglon.test.ts:92`.
`analytics.test.ts:170-260` sí ejercita el camino de `reconstruir` con
`cuadrarDesdeDB` mockeado (63 casos entre los tres archivos, verdes) y **nunca
afirma nada sobre `pagadoEn`**.

### [ALTO · REINCIDENTE de la 25 (backend.md:226), cierre PARCIAL] La liquidación que el contralor RECHAZÓ sigue sumando en los KPI, en la dona y en las dos tablas del panel — mientras el CSV, la API, la póliza y los acreditables ya se abstienen

`src/lib/likida/analytics.ts:218-225` (→ `0112_agregados_rpc.sql:327-329`) · `:328-336` (→ `0150_agregados_analytics.sql:486-488`) · `:1045-1053` · `:1961-1973`

`revisar_liquidacion(… 'rechazar')` deja **todas** las columnas de dinero
intactas y solo escribe `revision`/`revisada_*`/`motivo`, devolviendo el viaje a
`en_cuadre` (`0299:406-415`). El repo ya adoptó cinco veces el criterio «una
rechazada no cuenta»: CSV (`export/liquidaciones/periodo.ts:83`,
`route.ts:122`), API pública (`v1/liquidaciones/route.ts:140,201`), póliza
(0307), acreditables (**0308:50**) y gastos fiscales (0316). Las cuatro puertas de
`analytics.ts` no lo aprendieron: los dos `where` de las RPC filtran solo
`tenant_id` y fecha, y los dos `select` de las tablas ni siquiera piden la
columna.

Entra: el contralor rechaza V-119 el 12-sep con motivo escrito («el CFDI de
diésel no es de este viaje»); la fila conserva `total_comprobado` 10,000,
`diferencia` 2,000, `diferencias: [{tipo:'sobre_politica', monto:2000}]`, y el
viaje vuelve a `en_cuadre`. Sale mal, el mismo día:

- `/dashboard/agentes/liquidacion` sigue pintando «Monto comprobado ·
  histórico» con esos $10,000 dentro y «Tasa de cuadre — N liquidaciones»
  contándola (`vista.tsx:177-178`);
- la dona de dinero observado le suma $2,000 de `sobre_politica`;
- el registro de viajes pinta la fila **«V-119 · en_cuadre · Comprobado
  $10,000 · Diferencia $2,000»** (`viajes/page.tsx:66-70`) — un viaje que no
  está liquidado con las cifras de la liquidación que se invalidó;
- y el CSV del MISMO periodo, exportado desde el mismo panel, **no la trae**.

La cifra además sale del producto: `getKpis` es la fuente de la herramienta MCP
de dinero (`lib/mcp/herramientas/dinero.ts:19`) y del chat del panel
(`dashboard/chat.tsx:98-103`, «Llevas $X comprobados en N viajes»).

Consecuencia: el contralor cruza el tile contra su propio CSV y no cuadran; la
diferencia es exactamente el trabajo de revisión que él firmó. Es la misma
asimetría que la 25 reportó como MEDIO para la póliza, con dos consumidores más
y en la pantalla que se abre primero en un demo.

Causa raíz probable: `revision` (0299) se ha propagado consumidor por
consumidor, en cinco rondas, sin que nadie haya hecho el barrido de «quién
pregunta si esta liquidación cuenta».

Prueba que lo cubra: **ninguna, y el hueco está anotado en el propio arnés**:
`analytics_kpis_acreditables.test.ts:39-41` dice literalmente
«`kpis_liquidacion_tenant` (0112) no toca `revision`, así que no participa en
`sqlKpisEquivalente`». Los casos 276-309 del mismo archivo prueban la
abstención **solo** para `getAcreditables`.

### [ALTO · REINCIDENTE] Si la subida del PDF del contralor falla y la del operador no, los dos ejemplares de la misma liquidación quedan con cifras distintas y nadie se entera

`src/lib/likida/revision_recalculo.ts:188-197` · `src/lib/likida/revision.ts:492-501` · `src/app/dashboard/[id]/page.tsx:242-247`

Verificado hoy: **sin cambios**. Los dos ejemplares se imprimen y suben en un
`Promise.all` (`:188-191`) y el resultado se mira después; si el del contralor
no subió, `return { regenerado: false }` (`:193-197`) sin deshacer el del
operador, que ya se sobrescribió en `${tenant}/${viaje}-operador.pdf`. Entra:
ajuste firmado $800 → $8,000 y un 5xx transitorio de Storage en `subir()` del
contralor. Sale: `${tenant}/${viaje}.pdf` (el que sirve `/api/export/pdf/[id]`)
dice $800 y el ejemplar del chofer dice $8,000. El único rastro es
`logger.warn('revision.pdf_no_regenerado')` (`revision.ts:499`), que no dispara
`alertarOperador`, y la pantalla acusa «se corrigió 1 comprobante. El
comprobado quedó en $8,000.00…» con el enlace al PDF viejo.

Causa raíz probable: `regenerado` se diseñó como valor de retorno para el log y
no como parte del acuse a la persona.

Prueba que lo cubra: `revision.test.ts:332-342` fija el comportamiento y no el
aviso; `revision_recalculo.test.ts:177-189` cubre el `regenerado:false` y no
mira qué quedó en el ejemplar del operador.

### [MEDIO · REINCIDENTE] LR019 apunta al comprobante equivocado, y la otra puerta termina en un LR020 que pide reintentar algo determinista

`supabase/migrations/0306_ajustar_regenera_desglose_y_pdf.sql:200-207` (con `:218-225`) · `src/lib/likida/cuadre/engine.ts:1198-1200` · `src/app/dashboard/[id]/page.tsx:279-282`

Verificado hoy: **sin cambios**. LR019 (`0306:200-203`) busca una diferencia
`duplicado` cuyo `gastoId` sea el que se ajusta; el motor emite esa diferencia
con el id del **original** a propósito y lo documenta («el `gastoId` que se
reporta es el del original: es el que el contralor tiene que abrir»,
`engine.ts:1198-1202`), mientras que del total se excluyen las **copias**. Con
V-207 (mismo ticket de diésel dos veces, $8,000, sin CFDI): ajustar el original
rebota con «está fuera del total (duplicado o monto inválido)» —falso sobre esa
fila—; ajustar la copia pasa LR019, aplica `update gasto set monto = 800`, y el
recálculo deja de ver copias, sube el total a 8,800 contra el
`total_comprobado + delta` = 800 que exige LR020 (`0306:218-225`) → «algo cambió
los gastos… vuelve a intentar», que nunca va a funcionar.

Consecuencia: sobre el escenario más común de una ráfaga de WhatsApp, las dos
puertas de corrección están cerradas y los dos mensajes mienten.

Prueba que lo cubra: **ninguna** (`grep LR019` en `verificaciones.sql` → 0).

### [MEDIO · REINCIDENTE] El único camino del bucle de la cadena del webhook que NO corta es el que no sabe qué pasó con el mensaje anterior

`src/app/api/webhook/whatsapp/route.ts:438-442` (contra `:390`, `:420`, `:425`, `:434`)

Verificado hoy: **sin cambios**. Los cuatro caminos anómalos con información
cortan la cadena (`break`); el `catch` exterior —«ni el claim se pudo leer», el
único caso en el que no consta NADA del mensaje anterior— hace
`logger.error('wa.claim_fallo')` y sigue con el siguiente. Entra: nota de voz
(«la talacha fueron 800») + «listo»; `reclamarPendiente` de la nota lanza
porque `acotada` corta la RPC a los 8 s. Sale: se procesa el «listo» y se cierra
el viaje sin la incidencia. La guardia AGEN-6 (`processor.ts:3653`) solo
pregunta por **fotos** anteriores (`conv.ts:958` filtra
`evento->>type = 'image'`), así que audio, texto y botón no entran.

Prueba que lo cubra: ninguna que fuerce a `reclamarPendiente` a lanzar dentro de
una cadena de dos mensajes; el drenado del cron
(`cron/wa-pendientes/drenado.ts:95-102`) tiene el bucle equivalente y ahí el
`throw` sí sale del worker.

### [MEDIO · NUEVO] El feed «Lo que hizo solo» escoge 60 viajes al azar y jura que son los más recientes

`src/lib/likida/analytics.ts:293-317` (el `.order('id', { ascending: false })` de `:300`, y el comentario de `:316-317`)

`viaje.id` es `uuid primary key default gen_random_uuid()`
(`0001_init.sql:47`): v4, aleatorio. Ordenar por `id desc` no es orden de
inserción ni de nada — es una permutación arbitraria estable. El comentario de
`:316-317` afirma lo contrario («Los 60 viajes más recientes… el feed enseña lo
último, no un archivo»), y `getEventosConductores`, 660 líneas más abajo y
sobre la MISMA tabla, sí ordena por `created_at` (`:957`).

Entra: una flota con 600 viajes que en algún momento tuvieron `escalado_en` o
`recordatorio_comprobacion_en`; anoche el agente escaló V-712. Sale: la
probabilidad de que V-712 caiga en los 60 que Postgres devuelve es ~10%, y el
resto del tiempo la tarjeta de `/dashboard/agentes/liquidacion` presume un
escalado de marzo con su fecha impresa al lado (`vista.tsx:265-277`). El estado
vacío tampoco se activa: hay filas, solo que las equivocadas.

Consecuencia: la tarjeta que existe para demostrar que el agente trabaja de
noche es la que más envejece; y el rótulo «lo último» es falso por
construcción, no por falta de datos.

Causa raíz probable: se buscaba un desempate barato y se tomó `id` como si
fuera secuencial, como en una tabla con `serial`.

Prueba que lo cubra: **ninguna** — `getHechosSolos` no aparece en ningún
`*.test.ts` del repo.

### [MEDIO · NUEVO] El único `catch` de `analytics.ts` se traga el error y borra la diferencia entre «la config derivó» y «la base está caída»

`src/lib/likida/analytics.ts:1649-1651` (contra los `return null` deliberados de `:1559` y `:1594`)

`reconstruir` tiene tres formas de devolver `null`: el portón de total
(`:1559`), la deriva de config (`:1594`) —las dos, decisiones de producto
documentadas— y `catch { return null; }` (`:1649-1651`), **sin `logger`, sin
`id` de la liquidación y sin el error**. Las tres salidas son indistinguibles
río abajo: `deducibilidad: null`, `laboral: null`, `comprobantesCuadran: false`.

Entra: `cuadrarDesdeDB` lanza porque `getConfig` no pudo leer `tenant.config` o
porque `acotada` cortó `getGastos` a los 8 s. Sale: el detalle de la
liquidación se sirve sin el bloque de las tres cubetas —el cálculo que
diferencia al producto— y **no queda ni una línea de log** que diga cuál
liquidación fue ni por qué. Quien opera ve la pantalla degradada y no puede
distinguir un cambio de RFC (comportamiento correcto y esperado) de una base a
medio caer.

Consecuencia: la regla de la casa «fallar cerrado **y decirlo**» se cumple a
medias justo en la pantalla del dinero: se falla cerrado, y no se dice.

Causa raíz probable: el `catch` se escribió para la promesa «la reconstrucción
es un extra y no puede tirar la pantalla», y el «extra» se llevó por delante
también la observabilidad.

Prueba que lo cubra: `analytics.test.ts:252-260` fija que un
`cuadrarDesdeDB.mockRejectedValue` degrada sin tirar la página — o sea, prueba
el silencio, no lo denuncia.

### [BAJO · REINCIDENTE, 4ª ronda] La sonda de OCR del panel no registra el costo cuando aborta

`src/app/api/dashboard/ingesta/route.ts:98,101,124-126`

Verificado hoy: **sin cambios**. `extraerComprobante` corre con
`AbortSignal.timeout(45_000)` (`:98`) y `registrarCosto` está DESPUÉS (`:101`),
así que el `catch` (`:124-126`) contesta 502 sin registrar un gasto de IA que ya
se pagó, y `gastoSondaHoyUsd` (`:87`) no lo ve. Diez sondas que aborten a los
45 s = `$0.00` según el tope. `processor.ts:3929-3936` sí registra el costo del
`PartialExecutionError` antes de decidir nada; esta ruta no.

### [BAJO · REINCIDENTE] `sincronizar_gps` reporta como «guardadas» las filas que mandó, no las que el upsert insertó

`src/lib/likida/conectores/sincronizar_gps.ts:228-234` · `src/app/api/cron/gps/route.ts:97,118,166`

Verificado hoy: **sin cambios**. El upsert lleva `ignoreDuplicates: true` sobre
`(tenant_id, unidad_id, medida_en)` (`:230`) y el worker devuelve
`tanda.length` (`:234`). Entra: 200 unidades paradas con la misma última
posición de la corrida anterior → sale `guardadas: 200` habiendo insertado 0, y
esa cifra viaja al JSON del cron y al latido `gps`, que es justo lo que alguien
mira para decidir si la fuente de GPS está entrando. Mismo patrón que
`b609b22` arregló en `marcarExportadas` con `.select('id')`.

## Lo que revisé y está bien

- **La póliza sí resuelve la pregunta de `pagoPendiente` completa**, y es el
  contraejemplo del BE-1: `0281:129-130` entrega `formaPago`/`pagadoEn`,
  `export/poliza/route.ts:86-90` los declara, `aGasto` (`:115-134`) los copia
  sin inventar campos, y `rpcDesactualizada` (`:104-110`) **falla cerrado** con
  el número de migración si la RPC va atrás. `cubetaDe` no necesita nada más
  que `diferencias` + `pagadoEn` + `cfdiUuid` (`engine.ts:469-481`), así que
  ese camino está completo.
- **`getAcreditables` sí se abstiene** de las rechazadas y de las pendientes
  desde la 0308 (`0308:48-50`), con cuatro casos que lo fijan
  (`analytics_kpis_acreditables.test.ts:276-309`, corridos: verdes).
- **El resto del contrato de `getLiquidacionDetalle`**: `exigir` en las tres
  lecturas (`:1363`, `:1457`, `:1496`), `null` que ya solo significa «no
  existe» (`:1358-1363`), el portón de total con centavo de tolerancia
  (`:1559`) y `derivoLaConfig` (`:1594`) — los dos con prueba
  (`analytics.test.ts:231-249`, `analytics_deriva.test.ts`).
- **`getLineasPorConciliar`** (`:1846-1935`): `count` nulo LANZA en vez de
  inventar un 0 (`:1874-1877`), y los tres `traerPorIds` evitan el recorte
  silencioso de `.in()` a 1,000.
- **`leerRpc0150`** (`:42-49`): valida la FORMA de cada fila y lanza; una
  respuesta inesperada no se lee como cero.
- **`getDesglosesRecibidos`** (`:1723-1731`): `created_at` existe en
  `cfdi_consolidado_linea` (`0076:65`) y el `.order()` + `.limit(1000)`
  declarado corresponden a lo que PostgREST de verdad hace.
- Los seis abiertos que no reaudité de nuevo por dentro siguen con el arreglo
  que la ronda verificó (`382365e`, `670a348`, `893e347`, `5b80e6a`,
  `bcb766b`, `9ed7e78`, `b609b22`, `62840b3`): no los toqué esta vuelta y no
  los cuento a favor ni en contra.

## Lo que NO alcancé a revisar

- **No pude ejecutar la refutación del BE-1 en runtime.** El encargo prohíbe
  tocar archivos del repo salvo el entregable, y sin agregar un caso al arnés
  de `analytics.test.ts` no hay forma de instanciar `reconstruir`. Lo que
  afirmo es lectura de un **objeto literal** (`:1633-1644`) que no menciona
  `pagadoEn`: un literal no puede producir una propiedad que no escribe, y el
  tipo opcional explica por qué `tsc` calla. Es la forma más fuerte de
  verificación disponible sin editar; lo digo para que se lea como lo que es.
  El actor que lo parchó a media redacción llegó a la misma conclusión por su
  cuenta, y su prueba también lee el fuente: **nadie ha ejercitado ese seam en
  runtime todavía**, ni antes ni después del arreglo.
- **`verificaciones.sql` no se corrió** (no hay Postgres aquí): cada vez que
  digo que un bloque prueba o no prueba algo, es lectura del bloque.
- `src/middleware.ts` **sigue sin existir** (tercera ronda que el mapa lo lista
  como superficie de este rubro).
- Sin abrir, otra vez: `api/cron/{descarga-sat,jornada,asistencia,portales-vivos,runner,escalar}`,
  `api/admin/qa/*`, `api/correo/*`, `lib/worker/llaves.ts` y `pg_errores.ts`.
- No reaudité por dentro las otras nueve funciones de `analytics.ts` que corren
  sobre `leerRpc0150`: leí su contrato de forma, no el SQL de cada RPC en
  0150/0151 (salvo `dinero_observado_por_tipo_tenant`, que sí abrí por el
  BE-2).
