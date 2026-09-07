# Cumplimiento fiscal — auditoría 27

**Nota: 4/10** (antes 4). Razón del movimiento: **las dos fuerzas se cancelan y
se dicen las dos**, porque una sola sería mentira.

- *Se atacó y subió*: los **cinco** hallazgos abiertos que el encargo me dio a
  verificar **cerraron de verdad**, y aguantaron el cotejo término por término
  (no solo las líneas que enumeraban). Es la primera ronda de esta serie en que
  ningún arreglo se cae al reauditarlo. Eso vale **+1**.
- *Mirada más profunda*: el mismo cubo del 15 % tiene **un quinto término sin
  espejar** que nadie había mirado —la COPIA de un comprobante—, y produce el
  mismo modo de falla que el CRÍTICO de la 26, **medido**: el mismo CFDI de
  diésel pasa de `{deducible $11,600 · IVA $1,600}` a `{deducible $0 ·
  noDeducible $11,600 · IVA $0}` solo porque unos tickets se fotografiaron dos
  veces. El ancla del rubro («3 o menos si el producto imprime una cifra fiscal
  equivocada») se vuelve a rozar. Eso gasta el **+1**.

**El riesgo mayor del rubro, hoy:** el denominador del 15 % (RFA 2026 regla 2.9)
lo mide una RPC que **no deduplica y no distingue pagado de no pagado**, mientras
el motor que imprime el PDF **sí** deduplica — así que el papel presenta un
cociente cuyo numerador y denominador salen de dos universos distintos, otra vez,
por un término distinto del de la ronda anterior.

| Severidad | # |
|---|---|
| CRÍTICO | 1 (nuevo) |
| ALTO | 2 (nuevos) |
| MEDIO | 1 (REINCIDENTE) |
| BAJO | 1 |

Lo medido va marcado *(medido)*: corrido con `cuadrarViaje` REAL sobre una copia
del árbol fuera del repo (`tar` al scratchpad, `node_modules` por symlink);
`/home/user/cuadra` intacto — `git status --porcelain` vacío al terminar.

---

## Veredicto sobre los arreglos que el encargo mandó verificar

| Hallazgo de la 26 | Commit | ¿Cerró? | Comprobado hoy |
|---|---|---|---|
| **CRÍTICO FIS-C2c** — el gasto sin fecha entra al numerador y no al denominador | `2a58e075` | **SÍ** | `engine.ts:775` dice hoy `const mismoEjercicio = anioComprobante != null && anioComprobante === input.anioEjercicio` — el `!anioComprobante ||` ya no está, y el gasto sin año cae en la rama de abstención de `:777-787` con su motivo propio («no trae fecha legible… se revisa aparte»). El `pct` de `:803` perdió su guarda `total > 0` porque el `if (!mismoEjercicio \|\| !(total > 0)) continue` de `:777` ya la hace. Correcto. |
| **ALTO FIS-A3** — el cuarto sitio medía el cubo sin las claves del SAT | `8c72f7bd` | **SÍ** | `tools.ts:215-216` lee `getConfig` ANTES y llama `getAcumuladoCombustible(ctx.tenantId, ejercicio, cfg.hidrocarburos?.claves ?? [])`, el mismo tercer argumento que `desde_db.ts:130` y `fiscal.ts:487`. Los tres llamadores coinciden. |
| **ALTO** — el REP con `FormaDePagoP = '99'` | `6cbac00f` + `f85e68f3` | **SÍ** | La 0345 (`0345_combustible_rep_por_definir.sql:30`) agrega `and forma_pago_efectiva <> '99'` al `filter` del numerador, que es exactamente lo que `medioNoAdmitidoCombustible` (`engine.ts:222`) hace en TS. Y **la prueba de paridad se volteó**: `fiscal_agregado_15pct.test.ts:38` lee ahora la 0345 y `:62` **exige** `forma_pago_efectiva <> '99'` donde antes exigía lo contrario. El commit hizo lo que el hallazgo decía que había que hacer. |
| **ALTO** — la póliza asienta IVA de liquidaciones sin firmar | `42f93f91` | **SÍ** | `src/app/api/export/poliza/route.ts:354-360`: `const sinFirma = filas.filter((f) => f.revision !== 'aprobada' && f.revision !== 'ajustada')` → 409 `liquidaciones_sin_firma` con los folios, ANTES de armar nada. La 0342 conserva las pendientes en el insumo a propósito («para que la ruta bloquee el periodo completo con sus folios, en lugar de omitirlas silenciosamente») y sube `version` a 342, con `RPC_VERSION_MINIMA = 342` (`route.ts:105`) fallando cerrado si la base va atrás. Y comprobé que **es la única puerta**: `polizaDeLiquidacion` y `poliza_datos_tenant` no tienen otro llamador en `src/`. |
| **ALTO** — la nota de crédito multi-concepto por dos de las tres puertas | `80692404` | **SÍ** | El corte se hizo en el sitio que el hallazgo señalaba: `intake/cfdi_xml.ts:185-186`, `esConsolidado` = `xml.tipoComprobante !== 'E' && xml.lineas.length > 1`. Y además las **tres** puertas de `processor.ts` tienen su rama explícita antes del consolidado: `:1451` (oficina), `:1809` (operador sin viaje abierto) y `:3120` (operador con viaje abierto), las tres llamando `conservarNotaCredito` y devolviendo. |
| **MEDIO** — la RMF 2.7.1.29 fr. II sin ficha | `f85e68f3` | **SÍ** | `normas/rmf-2026-2.7.1.29.yaml` existe, `estado_verificacion: verificado_fuente_primaria`, con el fragmento literal («indicar la clave 99 "Por definir" en el caso de no haberse recibido el pago de la contraprestación»), su `alcance_extracto` honesto («no es la transcripción completa») y un `limite_interpretacion` que es exactamente el que faltaba. `normas/` pasó de 38 a 39. |
| **MEDIO** — el PDF cita «LIVA 5-III» y la ficha no traía fracción III | `f85e68f3` | **SÍ** | `normas/liva-5.yaml:30-31` transcribe hoy la fr. III («Que el impuesto al valor agregado trasladado al contribuyente haya sido efectivamente pagado en el mes de que se trate»), cotejada contra la página 10 del PDF de diputados.gob.mx. |

**Siete de siete.** Es un resultado que esta serie no había tenido.

### Las implementaciones del predicado del 15 %, contadas hoy

El encargo pedía contarlas. Eran cuatro; hoy son **cinco vivas y una muerta**, y
el arreglo de `8c72f7bd` **bajó una** (`tools.ts` dejó de tener criterio propio y
pasó a delegar en la RPC con las claves).

1. `supabase/migrations/0345_combustible_rep_por_definir.sql:19-33` — SQL:
   numerador **y** denominador del ejercicio.
2. `src/lib/likida/cuadre/desde_db.ts:171-174` — el `.filter` que resta este
   viaje; espejo **manual** del `where` de la 0345.
3. `src/lib/likida/cuadre/engine.ts:752-812` — el numerador por comprobante, el
   tope y el prorrateo (la cifra que se imprime).
4. `src/lib/likida/fiscal.ts:229` (`formaPagoEfectiva`, **segunda
   implementación** de `formaPagoJuzgableDe`) + `:723`, `:971`, `:1096`, `:1211`
   — el panel del contador.
5. `supabase/migrations/0317_gastos_fiscales_agregados_paridad_engine.sql:66-155`
   — el agregado SQL del panel, que reimplementa fila por fila `sobreTopeEfectivo`,
   `pareceBar`, `renglonesAjenos` y `otroEjercicio`.

Muerta: `fiscal.ts:1205` `tope15DeGastos` — **cero llamadores en producción**
(solo `fiscal.test.ts:493` y `fiscal_agregado.test.ts:328`), aunque
`normas/rfa-2026-2.9.yaml → usado_en_codigo` la cita como si estuviera viva.

**Los hallazgos 1 y 3 de abajo son el mismo término faltando en (1), (2), (4) y
(5) a la vez.** Es la causa raíz que la 26 documentó, un nivel más afuera.

---

## Hallazgos

### [CRÍTICO] La COPIA de un comprobante entra al cubo del 15 % por la RPC y no por el motor: el mismo diésel imprime «deducible $11,600» o «no deducible $11,600» según si el operador fotografió un ticket dos veces

`src/lib/likida/cuadre/engine.ts:662-663` y `:687` (`const originalDe =
copiasDeComprobante(input.gastos)` / `if (duplicados.has(g.id)) continue;` — el
motor **salta** las copias antes de llegar al 15 %) · `engine.ts:800`
(`efectivoAcumuladoEjercicio += g.monto`) · `engine.ts:802` (`const tope = 0.15 *
total`, con `total = input.totalCombustibleEjercicio`) · contra
`supabase/migrations/0345_combustible_rep_por_definir.sql:19-24` (el `where`:
`from gasto where tenant_id … and monto > 0 and fecha … and (concepto = 'diesel'
or clave_prod_serv = any(p_claves))` — **ni una palabra de copias**) y `:27`
(`coalesce(sum(monto), 0) as total`) · `src/lib/likida/cuadre/desde_db.ts:171-174`
(el `.filter` que resta este viaje, **tampoco** salta copias) ·
`src/lib/likida/repo.ts:1418-1454` (`getAcumuladoCombustible`, que solo envuelve
la RPC).

**Norma** — `normas/rfa-2026-2.9.yaml`, **`verificado_fuente_primaria`**, literal:

> «…siempre que estos no excedan el **15 por ciento del total de los pagos
> efectuados por consumo de combustible** para realizar su actividad.»

Dos fotos del mismo ticket son **un** pago, no dos. Un peso que el motor no
cuenta arriba no puede contarse abajo.

**Que las copias EXISTEN en la base no es hipótesis, es diseño reconocido**: el
índice único es `uq_gasto_cfdi_uuid on (tenant_id, cfdi_uuid, cfdi_orden)`
(`0065:69`) y `uq_gasto_img_hash on (tenant_id, img_hash)` (`0027:132`) — dos
fotos DISTINTAS del MISMO ticket **sin timbrar** pasan las dos. Por eso existe la
rama por folio de `copiasDeComprobante` (`engine.ts:528-549`), cuyo propio
comentario dice: «Encontrado el 1-ago con un fajo real de 17 comprobantes: el
mismo folio aparecía como `286188` y como `059286188`». Y las filas **se quedan**:
`0299:377` y `0306:202` rechazan ajustar «el comprobante que está fuera del total
(duplicado o monto inválido)» — o sea, sigue ahí con su `monto`.

**Escenario A — la copia está en un viaje YA LIQUIDADO** *(medido)*. Flota
`facilidad15: true`, ejercicio 2026. Compras reales de combustible del ejercicio:
**$1,000,000**, de los cuales **$138,400** en efectivo. Durante el año se
duplicaron fotos de tickets de diésel en efectivo por **$60,000** en viajes ya
cerrados. Este viaje trae **un** CFDI de diésel de **$11,600** (SubTotal $10,000 +
IVA $1,600) pagado en efectivo (`'01'`), XML verificado.

| | lo que imprime el PDF hoy | lo que la regla arroja |
|---|---|---|
| Deducible para ISR | **$0.00** | $11,600.00 |
| No deducible | **$11,600.00** | $0.00 |
| IVA acreditable | **$0.00** | $1,600.00 |
| Diferencia emitida | `efectivo_sobre_15` por $11,600 | `combustible_efectivo_dentro15` |

Y la frase impresa, verbatim de la corrida:

> «Combustible pagado en EFECTIVO — el ejercicio lleva **$210,000.00** de
> combustible pagado con medios que la LISR 27-III no admite, contra un tope de
> **$159,000.00 (15% de $1,060,000.00)**; el excedente de $11,600.00 de ESTE
> comprobante NO se deduce…»

contra la que le corresponde:

> «…deducible por la facilidad del 15%: el ejercicio lleva **$150,000.00** de
> **$1,000,000.00** (15% del total, tope 15%).»

La flota **compró $1,000,000** de combustible, no $1,060,000, y **pagó $150,000**
en efectivo, no $210,000. Ninguna de las dos cifras del renglón existe.

**Escenario B — la copia está en ESTE viaje, y el mismo PDF la denuncia**
*(medido)*. Mismos totales previos. El operador fotografía **dos veces** un
ticket de diésel de **$23,200** (SubTotal $20,000 + IVA $3,200) en efectivo.
`copiasDeComprobante` marca `g2` como copia y el PDF **imprime la diferencia
`duplicado` por $23,200** — o sea, el papel dice «esto es una copia» y en el
mismo papel usa un denominador que la cuenta:

| | PDF hoy (denominador $1,046,400) | con el denominador real ($1,023,200) |
|---|---|---|
| `efectivo_sobre_15` | **$4,640.00** | $8,120.00 |
| IVA acreditable | **$2,560.00** | $2,080.00 |

Aquí el error va **al otro lado**: se deducen **$3,480** y se acreditan **$480**
de IVA que la regla no concede, porque la copia solo infló el denominador (el
numerador la salta, la resta de `desde_db.ts` la resta doble y cancela).

**Consecuencia.** Las dos direcciones le cuestan al mismo cliente. En A el
contralor archiva un PDF que le niega $11,600 de deducción (~$3,480 de ISR) y
$1,600 de IVA que la RFA 2.9 sí le concede, y si su contador cruza el renglón
contra la RFA no puede reconstruir ni el 19.8 % impreso ni el total de
$1,060,000 contra sus compras reales. En B el papel sostiene una deducción y un
acreditamiento que en una revisión no se defienden, **con el artículo citado al
lado y con la palabra «duplicado» impresa dos renglones más arriba**. La
liquidación cierra en verde en los dos casos.

**Causa raíz probable:** `copiasDeComprobante` es la disciplina de todo el resto
del repo —`engine.ts:662`, `pdf.ts:452`, `analytics.ts:1617`, `tools.ts:144`,
`omitidos.ts:93`, `processor.ts:3016/3623`, `api/export/poliza/route.ts:119/179`—
y es exactamente el término que ni la 0345, ni la 0317, ni el `.filter` de
`desde_db.ts` conocen: el `where` de la RPC nunca se comparó contra el
`continue` de la línea 687.

---

### [ALTO] El denominador del 15 % suma combustible COMPRADO, y la norma dice «pagos EFECTUADOS»: un CFDI PPD sin pagar agranda el tope

`supabase/migrations/0345_combustible_rep_por_definir.sql:27`
(`coalesce(sum(monto), 0) as total`, sobre el `where` de `:19-24`, que **no mira
la forma de pago ni el complemento**) · contra `:28-32`, donde el numerador sí
exige `forma_pago_efectiva is not null` — o sea, el mismo comprobante «no pagado»
está **fuera** del numerador y **dentro** del denominador ·
`src/lib/likida/cuadre/engine.ts:802` (`const tope = 0.15 * total`) ·
`src/lib/likida/cuadre/engine.ts:222-224` (`medioNoAdmitidoCombustible` devuelve
`false` para `'99'`) · la cabecera de la 0305 lo declara a propósito: «`total` NO
cambia: sigue sumando TODO el combustible del ejercicio sin filtrar por forma de
pago — ese denominador nunca dependió del medio» (`0305:31-32`).

**Norma** — `normas/rfa-2026-2.9.yaml`, **`verificado_fuente_primaria`**, literal:

> «…siempre que estos no excedan el 15 por ciento del total de los **pagos
> efectuados** por consumo de combustible para realizar su actividad.»

Y `normas/rmf-2026-2.7.1.29.yaml`, **`verificado_fuente_primaria`**, literal:

> «indicar la clave 99 "Por definir" en el caso de **no haberse recibido el pago**
> de la contraprestación»

El propio repo usa esa segunda ficha para decir que un `'99'` sin REP **no es un
pago** (`engine.ts:198`, `fiscal.ts:222`). Si no es un pago, no es «un pago
efectuado por consumo de combustible», y no pertenece al denominador de la 2.9.
La cabecera de la 0305 razonó sobre el MEDIO del pago; el término que la regla
pone en el denominador es que el pago **haya ocurrido**.

**Escenario.** Flota `facilidad15: true`, ejercicio 2026. Compras de combustible
del año: **$1,000,000**, de los cuales **$300,000** es una factura de monedero
`MetodoPago PPD` / `FormaPago '99'` **todavía sin REP al 31 de diciembre** (crédito
a 60 días de la estación, lo corriente). Pagos en efectivo: **$140,000**.

- Lo que hace el código: `total = 1,000,000`, `efectivo = 140,000` → **14 %**,
  dentro del 15 %. El PDF imprime «el ejercicio lleva $140,000.00 de
  $1,000,000.00 (14% del total, tope 15%)» y **todo el efectivo es deducible**,
  con su IVA acreditable completo.
- Lo que arroja el texto: pagos efectuados por combustible = $700,000; el 15 % es
  **$105,000**; el efectivo de $140,000 excede en **$35,000**.

**Consecuencia.** $35,000 de deducción (~$10,500 de ISR) y el IVA proporcional
(~$4,827 sobre un traslado de $19,310 en esos $35,000) sostenidos por un PDF que
cita la RFA 2.9 y un cociente cuyo denominador incluye lo que la propia flota
todavía no ha pagado. Es un error hacia **arriba**: el cliente lo cobra en una
revisión, no en la liquidación, y el papel que lo respalda lo firmó Likida. La
`fecha_vigencia_hasta: 2026-12-31` de la ficha hace que el cierre de ejercicio
sea justo el momento en que más PPD sin liquidar hay abierto.

**Causa raíz probable:** el numerador se refinó tres veces (0190 → 0305 → 0345)
para juzgar la forma **efectiva** del pago, y el denominador se declaró explícita
y razonadamente exento de ese refinamiento — pero la exención que se escribió es
sobre el *medio*, no sobre la *existencia* del pago.

---

### [ALTO] El panel del contador cuenta las copias que el PDF descarta: la misma flota lee dos cifras del mismo comprobante

`src/lib/likida/fiscal.ts:1081` (`gastoTotal += g.monto`, sin filtrar copias) ·
`fiscal.ts:829` (`montoPerdido += f.gasto.monto` en `resumirPerdidas`) ·
`fiscal.ts:1211` (`if (medioNoAdmitidoCombustible(formaPagoEfectiva(g))) efectivo
+= g.monto`) · `supabase/migrations/0317_gastos_fiscales_agregados_paridad_engine.sql:66-155`
(`from gasto g`, agrupado por dimensiones fiscales; **no selecciona `folio` ni
`folio_norm`** y no tiene ninguna noción de copia) · contra `engine.ts:662-663`,
`liquidacion/pdf.ts:452` (`idsDuplicados: new Set(copiasDeComprobante(liq.gastos).keys())`)
y `analytics.ts:1617`, que sí la tienen. **`copiasDeComprobante` no aparece una
sola vez en `fiscal.ts`** (grep sobre todo `src/`).

**Norma** — `normas/liva-5.yaml`, **`verificado_fuente_primaria`**: el
acreditamiento se mide sobre **«las erogaciones efectuadas por el
contribuyente»**; y `normas/lisr-27-III.yaml`, sobre pagos **amparados con un
comprobante fiscal**. Un comprobante, una erogación. Además la regla del producto
que este rubro custodia: *una cifra fiscal que se lee distinto en dos pantallas
se lee como dos cálculos.*

**Escenario.** El mismo ticket de diésel de **$23,200** en efectivo del escenario
B de arriba, fotografiado dos veces (`folio` `T-9`, sin CFDI todavía).

| | PDF de la liquidación (`engine.ts`) | `/dashboard` → Motor fiscal (`fiscal.ts`) |
|---|---|---|
| Comprobantes de diésel | 1 (+ la diferencia `duplicado`) | **2** |
| Gasto total del periodo | $23,200.00 | **$46,400.00** |
| «Combustible pagado en efectivo» (causa `combustible_efectivo`) | $23,200.00 | **$46,400.00** |

El contralor tiene enfrente un PDF que dice $23,200 y un panel que dice $46,400
sobre el mismo día y el mismo ticket, sin ninguna pantalla que explique la
diferencia — el panel ni siquiera tiene el concepto de «copia» para nombrarla.
Y como `proporcionCombustible15` (`fiscal.ts:525-534`) parte el IVA con el
acumulado de la RPC, el mismo defecto le mueve además el IVA acreditable del
panel.

**Consecuencia.** Es el modo de falla que el rubro tiene prohibido por
definición, y llega antes que el CRÍTICO de arriba: no hace falta que el cubo del
15 % se cruce, basta con que alguien mire el panel y el PDF el mismo día. Un
contralor que ve dos cifras del mismo hecho deja de creerle a las dos.

**Causa raíz probable:** la 0317 se escribió para **espejar `engine.ts` regla por
regla** (su cabecera enumera las 7 causas que replicó) y se saltó la única que no
es una regla de la ley sino de conteo — el paso 0 del motor.

---

### [MEDIO · REINCIDENTE, sin tocar] `factura_emitida` obliga `total = subtotal + IVA` y no puede representar la retención del 4 % que el propio Likida timbra

`src/lib/likida/facturacion_escritura.ts:154` (`const total = Math.round((subtotal
+ iva) * 100) / 100`) ·
`supabase/migrations/0049_cobranza_factura_emitida_pago.sql:54-55` (`constraint
factura_total_cuadra check (abs(total - (subtotal + iva)) <= 0.01)`; la tabla no
tiene columna de retenciones — reverificado hoy contra la 0049 y contra las siete
migraciones posteriores que tocan `factura_emitida`: 0159, 0161, 0166, 0228,
0237, 0284, 0292, 0314; ninguna la agrega) · contra
`src/lib/likida/carta_porte_cfdi.ts:197-199` (`const esMoral = re.rfc.length ===
12; const ret = esMoral ? dinero(sub * 0.04) : null; const total = dinero(sub +
iva - (ret ?? 0));`).

**Norma** — `normas/rliva-3-fr-II.yaml`, **`verificado_fuente_primaria`**:

> «II. **La retención se hará por el 4% del valor de la contraprestación pagada
> efectivamente**, cuando reciban los servicios de autotransporte terrestre de
> bienes que sean considerados como tales en los términos de las leyes de la
> materia.»

**Escenario.** Flete de $10,000 a cliente persona moral. El CFDI que Likida
timbra por el otro camino es SubTotal $10,000.00 · IVA $1,600.00 · **Retención
$400.00** · Total **$11,200.00**. El contralor lo registra en
`/dashboard/facturacion`: teclea 10,000 y 1,600, y el sistema guarda
**$11,600.00**. La antigüedad de saldos queda $400 arriba por cada factura a
moral. La otra salida que el constraint permite —teclear IVA $1,200— hace que la
columna `iva` mienta en $400.

**Consecuencia.** Sobre una flota que factura $3,000,000/mes a morales son
**$120,000 mensuales** de saldo fantasma en la cartera, y ninguna de las dos
salidas posibles es correcta. La retención aplica a **todo** flete a persona
moral: es el grueso del mercado, no un borde.

**Causa raíz probable:** la 0049 se diseñó como cuenta por cobrar genérica antes
de que `carta_porte_cfdi.ts` timbrara retenciones. (REINCIDENTE de la 26,
hallazgo 7; y de la 25.)

---

### [BAJO] `normas/rfa-2026-2.9.yaml` declara viva una función que no tiene llamador

`normas/rfa-2026-2.9.yaml → usado_en_codigo`: «fiscal.ts — **tope15DeGastos** y
las causas combustible_efectivo / efectivo_no_elegible del panel del contador» ·
contra `src/lib/likida/fiscal.ts:1205`, cuyo único uso en todo `src/` son
`fiscal.test.ts:493` y `fiscal_agregado.test.ts:328` (grep completo).

No es un defecto de cifra —la causa `combustible_efectivo` sí existe y sí la
gobierna esa ficha—, pero el campo `usado_en_codigo` es el índice que un
fiscalista usa para saber **qué línea auditar** cuando quiere confirmar la
regla, y lo manda a una función muerta en vez de a `causasDe` (`:723`) o a la
RPC 0345. Lo registro porque la trazabilidad ficha↔código es la mitad del método
de este rubro.

---

## Lo que revisé y está bien

- **Los siete arreglos de la tabla de arriba, uno por uno**, abiertos y leídos —
  no inferidos del asunto del commit. Los `archivo:línea` están en la tabla.
- **La lista de medios sigue siendo una sola.** `MEDIOS_LISR_27_III =
  ['02','03','04','05','28','29']` (`engine.ts:126`) contra `0345:31`, atada por
  `fiscal_agregado_15pct.test.ts:48-50`, y contra `normas/lisr-27-III.yaml`
  («cheque nominativo de la cuenta del contribuyente, tarjeta de crédito, de
  débito, de servicios, o los denominados monederos electrónicos autorizados por
  el SAT»). Correcta.
- **El tope de $2,000 es el de la norma y se compara como la norma.**
  `TOPE_EFECTIVO_LISR_27_III = 2000` (`engine.ts:140`), aplicado en `:843` con
  `g.monto > topeEfectivo` — la ficha dice «los pagos cuyo monto **exceda** de
  $2,000.00», y `>` es exceder, no `>=`. Y **no lo aplica al combustible**
  (`!esCombustible` en la misma línea), que es lo que el 2º párrafo de la
  fracción ordena.
- **Los topes de la LEY no son configurables por el cliente.**
  `ajustes_operativos.ts:14-29` corta explícitamente entre «parámetros del
  negocio» y «parámetros de la ley», y `administracion.ts:884-887`
  (`guardarAjustesOperativos`) solo mezcla `tabulador`, `catalogoCuentas` y
  `salida` — `validarAjustes` (`:186`) no puede devolver otra llave. Intenté
  llegar a `estimulos.viaticosTopeFiscalDiarioMxn` o a `peajeFactor` desde el
  panel y no hay camino. Bien cerrado.
- **`esCombustible` dice lo mismo en los tres sitios**: `engine.ts:694`
  (`g.concepto === 'diesel' || h.claves.includes(claveProdServ)`), `fiscal.ts:679`
  (idéntico, con `o.clavesCombustible = cfg.hidrocarburos.claves`,
  `fiscal.ts:547`) y `0345:24`. Los tres beben de `config.hidrocarburos.claves`.
- **El estímulo del IEPS no se imprime en pesos y sigue exigiendo el 4º párrafo.**
  `engine.ts:1744` condiciona los litros a `MEDIOS_LISR_27_III` sobre la forma
  **efectiva**, `iepsAcreditable` queda en 0 y solo salen litros — contra
  `normas/lif-2026-20-A.yaml` («el monto que se podrá acreditar será el que
  resulte de multiplicar la cuota… por el número de litros… adquiridos», con el
  párrafo del medio de pago ya transcrito y verificado el 3-sep). Y
  `cuadre/cuota_diesel.ts:128-133` (`cuotaDieselVigente`) es fail-closed real:
  fuera del rango cubierto devuelve `null`, nunca la última conocida ni la cuota
  completa; `validarCuotasDiesel` (`:105-125`) exige sábado→viernes, empalme sin
  hueco y `reducción + disminuida = cuota completa`.
- **El peaje se acredita sobre la base que la regla fija.** `engine.ts:1708-1709`
  (`baseDelEstimulo = max(0, subTotal − descuento)`, `× peajeFactor`) contra
  `normas/rmf-2026-9.1.8.yaml` fr. IV, `verificado_fuente_primaria`: «se aplicará
  al importe pagado… **sin incluir el IVA**, el factor de 0.5». Y `MEDIOS_ELECTRONICOS_PEAJE`
  (`engine.ts:256`) es la lista cerrada de la fr. III, no «todo lo que no sea
  efectivo». La condición de elegibilidad (< $300M, no partes relacionadas) sale
  de una declaración del perfil (`desde_db.ts:76-77`, `calificaEstimuloPeaje`) y
  `undefined` cierra la puerta (`engine.ts:1707`).
- **La póliza no puede inventar una cuenta ni salir descuadrada.**
  `contabilidad/poliza.ts:140-170` devuelve `falta[]` en vez de elegir cuenta
  plausible, y `api/export/poliza/route.ts:395-402` niega el periodo ENTERO si
  una sola liquidación no se puede asentar. `repartirPorCubeta` (`route.ts:167-203`)
  **sí** llama `copiasDeComprobante` y `proporcionesDeducibles` — es el único de
  los cinco sitios del 15 % que hereda la dedup, precisamente porque reusa el
  motor en vez de reimplementarlo.
- **`gasto_otro_ejercicio` sí es un guardarraíl real.** `engine.ts:1011-1019`
  emite el tipo cuando `fechaDudosa` devuelve `'otro_ejercicio'`, y está en
  `POR_CONFIRMAR` (`:377`) **y** en `SIN_IVA_ACREDITABLE` (`:403`). Esto refuta
  la versión «cruce de ejercicio» del hallazgo que iba a levantar sobre la fecha
  de la póliza (`0342`/`0307` fechan cada asiento con `l.created_at`): un gasto
  de diciembre liquidado en enero **no** entra como deducible de enero, cae a
  «por confirmar» y no acredita IVA. Lo anoto porque es exactamente el tipo de
  auto-refutación que el encargo pide. *(Nota menor: el comentario de `:373`
  dice «Sigue SIN entrar a SIN_IVA_ACREDITABLE» y el código lo tiene en la lista
  — el comentario está al revés de su propia justificación, que es la correcta;
  el comportamiento es el bueno.)*
- **El CHECK que ya me refutó una vez sigue en pie.** `monto > 0` en `0345:21`
  no tiene contraparte en el `.filter` de `desde_db.ts:172`, pero
  `gasto_monto_no_negativo` (`0070:41`, `check (monto >= 0)`) y
  `gasto_monto_no_nan` (`0025:104`) hacen imposible el único valor que
  divergiría; con `monto = 0` la resta aporta $0. No es hallazgo, y no lo cuento
  como tal.

## Lo que NO alcancé a revisar

- **Nada que requiera base viva.** Sin `.env` ni Postgres no corrí las RPC 0345,
  0307, 0308, 0316 ni 0317 contra datos; su equivalencia se mide en CI con
  Postgres efímero (`supabase/verificaciones.sql`, 308 bloques). Los tres
  hallazgos nuevos **no** necesitan base: el 1 lo medí con `cuadrarViaje` real y
  los 2 y 3 son cotejos de texto SQL contra texto TS, con las líneas citadas.
- **El escenario del hallazgo 3 no lo corrí**: `getGastosFiscales` exige la RPC
  0317 contra Postgres. Está verificado por lectura de los cuatro sitios
  (`fiscal.ts:1081`, `:829`, `:1211`, `0317:66-155`) y por la ausencia total de
  `copiasDeComprobante` en `fiscal.ts`; las cifras salen de la aritmética
  explícita de esas líneas, no de una corrida.
- **`intake/sat.ts` (69-B / estado del CFDI) y `intake/cfdi.ts`** no los abrí:
  el encargo fijó como prioridad los cinco hallazgos abiertos y el cubo del
  15 %, y ahí se fue la ronda. La descarga masiva del SAT (0231) y `decidirCruce`
  quedan sin auditar esta vez.
- **`normas/lisr-27-III.yaml` sigue en `evidencia_corroborante`** («NO se leyó en
  diputados.gob.mx»), y es la ficha detrás del veredicto rojo más frecuente del
  motor y del importe de $2,000. Igual `normas/lisr-28-XX.yaml` (el 91.5 % de
  restaurantes) y `cff-29-A`. Mientras esas tres no se cierren, **el ancla de 8+
  es inalcanzable por construcción**, con independencia del código.
- **El 8.5 % / 0 % de la LISR 28-XX sigue sin implementar** y la propia ficha lo
  declara (`hallazgos_que_el_codigo_NO_implementa → H4`,
  `estado: PARCIAL_CONSERVADOR`): el intake no distingue bar / restaurante /
  viático, así que toda `alimentacion` recibe el tratamiento de la fracción V.
  No lo levanto como hallazgo nuevo porque está declarado, con su `para_cerrarlo`,
  y porque su ficha es `evidencia_corroborante` — por el método de este rubro,
  **no verificable en esta ronda**. Lo mismo con H5 de `lif-2026-20-A` (el 50 %
  se aplica a toda caseta, no solo a la Red Nacional): declarado en la ficha, y
  además dicho en pantalla (`dashboard/[id]/detalle.tsx:268`, «autopistas de
  cuota, que el motor no verifica»).
- **El mes del acreditamiento del IVA en la póliza.** `0342:107` fecha cada
  asiento con `l.created_at`, y `engine.ts:1677-1685` emite `iva_mes_del_pago`
  como NOTA cuando el REP paga en otro mes que el del comprobante — esa nota
  **no viaja al archivo del ERP**. Dentro del mismo ejercicio no pude construir
  un escenario en cifras que no dependiera de suposiciones sobre cómo asienta el
  contador un gasto por comprobar, así que **no lo reporto**: lo dejo anotado
  para la ronda siguiente, con el `archivo:línea`, en vez de publicarlo sin
  escenario.
