# Re-auditoría fiscal — el arreglo `abf6921` (FIS-C2)

**Veredicto: cerrado a medias.** El arreglo es correcto en lo que toca —no
introduce ningún defecto nuevo y la prueba que lo ancla falla de verdad al
revertirlo—, pero cierra las **líneas** que el hallazgo enumeraba, no la
**pregunta** que planteaba. La pregunta era: *¿los dos términos del cubo del
15% juzgan con el mismo criterio?* Quedan **tres** criterios distintos vivos
sobre el mismo cubo, dos de ellos en la línea exacta que el arreglo editó
(`desde_db.ts:155`), y uno de ellos —el gasto de combustible **sin fecha**—
falla en la dirección cara: el PDF afirma deducible lo que la regla niega.

| Severidad | # |
|---|---|
| CRÍTICO | 1 |
| ALTO | 2 |
| MEDIO | 1 |
| BAJO | 2 |

Todos los escenarios de abajo están **corridos**, no razonados: sobre una copia
del árbol fuera del repo, con `cuadrarDesdeDB` real y `cuadrarViaje` espiado,
imprimiendo el `efectivoPrevEjercicio` que sale del borde. Las cifras medidas
van marcadas «(medido: …)».

---

## Hallazgos

### 1. [CRÍTICO] Un gasto de combustible **sin fecha** se RESTA de un acumulado que nunca lo contó: el PDF concede una deducción que la RFA 2.9 niega

`src/lib/likida/cuadre/desde_db.ts:155` — el filtro de `efectivoDeEsteViaje`:

```ts
.filter((g) => (g.fecha?.slice(0, 4) ?? anioEjercicio) === anioEjercicio
```

Un gasto sin `fecha` cae en el `?? anioEjercicio`, o sea que el operando de la
izquierda se vuelve el de la derecha y la comparación es **siempre verdadera**:
el gasto entra a la resta. Contra
`supabase/migrations/0305_15pct_efectivo_forma_pago_efectiva.sql:54-55`
(`and fecha >= make_date(p_anio,1,1) and fecha <= make_date(p_anio,12,31)`),
donde un `fecha` NULL evalúa a NULL y **queda fuera** del `sum()`: ni de
`efectivo` ni de `total`. Y `src/lib/likida/cuadre/engine.ts:765-766`
(`const anioComprobante = g.fecha ? … : null; const mismoEjercicio =
!anioComprobante || …`) lo trata como **del ejercicio** y sí lo mete al cubo.
Tres criterios, tres respuestas, sobre el mismo comprobante.

El arreglo `abf6921` tocó el segundo predicado de ese mismo `.filter` y dejó el
primero como estaba.

**No es un caso de laboratorio: es el estado que el intake está diseñado para
producir.** El prompt del OCR ordena literalmente devolver `null` cuando el año
no se lee con seguridad (`src/lib/likida/intake/ocr.ts:171`: «Si no puedes leer
el año con seguridad, devuelve null en vez de adivinar»; `:195`: «El AÑO se
copia de lo impreso. Si está tapado, borroso o cortado, devuelve null»), y
`fechaImposiblePorFutura` (`ocr.ts:299`) descarta a «no leída» cualquier fecha
futura. `addGasto` la persiste tal cual (`src/lib/likida/repo.ts:353`,
`fecha: g.fecha ?? null`; la columna es `fecha date` nullable desde
`supabase/migrations/0001_init.sql:62`) **antes** de que el flujo `pedir_fecha`
alcance al operador. Y nada lo marca: `engine.ts:993` solo emite
`fecha_sospechosa` / `gasto_otro_ejercicio` cuando **sí** hay fecha, así que la
liquidación puede cerrar «cuadrada».

Norma — `normas/rfa-2026-2.9.yaml`, **`verificado_fuente_primaria`**:

> «…considerarán cumplida la obligación establecida en el artículo 27, fracción
> III, segundo párrafo de la Ley del ISR, cuando los pagos por consumo de
> combustible se realicen con medios distintos a cheque nominativo de la cuenta
> del contribuyente; tarjeta de crédito, de débito o de servicios; o monederos
> electrónicos autorizados por el SAT, **siempre que estos no excedan el 15 por
> ciento del total de los pagos efectuados por consumo de combustible** para
> realizar su actividad.»

**Escenario (corrido).** Flota `facilidad15: true`, ejercicio 2026.

- `sumar_combustible_ejercicio` devuelve `total = 1,000,000`,
  `efectivo = 145,000` — todo de viajes ya liquidados, diésel en efectivo
  (`'01'`) con fecha legible. Tope 15% = **$150,000**; quedan $5,000 de cupo.
- Este viaje trae **un** ticket de diésel de **$80,000** pagado en efectivo
  (`'01'`), IVA $12,800, cuya fecha el OCR no pudo leer → `fecha = NULL`.
- 0305: el gasto no entra a `efectivo` **ni** a `total` (fecha NULL).
- `desde_db.ts:155` sí lo cuenta →
  `efectivoPrevEjercicio = max(0, 145,000 − 80,000) = ` **65,000**
  *(medido: 65000)*. El previo correcto es **145,000**.
- `engine.ts:787-793`: `previoSinEste = 65,000`, `tope = 150,000`,
  `cupoRestante = 85,000`, `dentro = min(80,000, 85,000) = 80,000`,
  `excedenteDeEste = 0` → `combustible_efectivo_dentro15`,
  `proporcionDeducible = 1`.

| | lo que imprime el PDF | lo que la regla concede |
|---|---|---|
| Deducible ISR | **$80,000.00** | $5,000.00 |
| No deducible | **$0.00** | $75,000.00 (`efectivo_sobre_15`) |
| IVA acreditable | **$12,800.00** | $800.00 |

**Consecuencia:** $75,000 de deducción y $12,000 de IVA afirmados en verde
sobre un cupo que ya estaba consumido, con la liquidación cerrable como
«cuadrada». Es la dirección cara —el que responde en una revisión es el
cliente, y el papel se lo dio Likida— y es exactamente lo que
`engine.ts:759-777` (el fail-closed de «sin base medida no se afirma nada»)
existe para impedir.

---

### 2. [ALTO] Un REP cuyo `FormaDePagoP` es también `'99'`: la RPC lo cuenta en el cubo, el motor no lo juzga y la resta no lo resta — y la prueba de paridad **fija** la asimetría

`supabase/migrations/0305_…sql:46-49` sustituye la forma cruda por la efectiva:

```sql
when forma_pago = '99' and pagado_en is not null then pagado_forma
when forma_pago = '99' then null
else forma_pago
```

y su cabecera (`:31-34`) justifica haber **borrado** el `forma_pago <> '99'`
que la 0190 sí tenía (`0190_…sql:38`) con esta prueba por exhaución:

> «un '99' nunca puede sobrevivir a la sustitución (o se vuelve `pagado_forma`,
> o se vuelve NULL), así que el `forma_pago_efectiva <> '99'` de la 0190 deja de
> hacer falta».

**Es falsa: `pagado_forma` puede valer `'99'`.** `intake/rep.ts:146` normaliza
el `@FormaDePagoP` del complemento con `formaPagoSat`
(`intake/cfdi_xml.ts:232-236`), que acepta **cualquier** valor de dos dígitos —
`'99'` incluido—, y `rep.ts:221` lo escribe tal cual; el CHECK de la base lo
admite (`supabase/migrations/0199_…sql:41-42`:
`pagado_forma is null or pagado_forma ~ '^[0-9]{2}$'`). Con `pagado_forma =
'99'`, `forma_pago_efectiva` = `'99'`, que **no es NULL** y **no está** en
`('02','03','04','05','28','29')` (`0305:61-62`) → la RPC lo suma a `efectivo`.

Del lado TS, el sitio único que el arreglo creó devuelve `'99'`
(`engine.ts:213-219`) y `medioNoAdmitidoCombustible` lo descarta a propósito
(`engine.ts:221-225`: `if (formaPago === FORMA_PAGO_SIN_PAGAR) return false`).
Así que ese comprobante: **entra** al numerador del cubo, **no** se resta en
`desde_db.ts:156`, y **no** cae en ninguna rama de juicio del motor
(`engine.ts:752` no entra; `:831` y `:882` exigen `!esCombustible`) — sale
«deducible» sin nota, después de haberle comido el cupo a los demás.

Peor: `src/lib/likida/fiscal_agregado_15pct.test.ts:62`
(`expect(listaDelSql()).not.toContain('99')`) es la prueba que dice garantizar
«misma lista, mismo criterio» entre SQL y TS, y lo que hace es **exigir por
escrito** que el SQL no excluya el `'99'`. La divergencia está clavada por una
prueba verde.

**Escenario (corrido).** Flota `facilidad15: true`, ejercicio 2026, total de
combustible $1,000,000 → tope 15% = **$150,000**.

- Viajes anteriores: **$130,000** de diésel en efectivo (`'01'`).
- Este viaje: (a) CFDI de diésel de **$150,000**, `FormaPago '99'`,
  `MetodoPago PPD`, REP con `FormaDePagoP '99'` y `pagadoEn 2026-02-20`;
  (b) ticket de diésel de **$10,000** en efectivo (`'01'`), IVA $1,600.
- 0305: `efectivo = 130,000 + 150,000 + 10,000 = ` **290,000**.
- `desde_db.ts:154-157`: solo resta (b) → `efectivoDeEsteViaje = 10,000` →
  `efectivoPrevEjercicio = ` **280,000** *(medido: 280000)*.
- `engine.ts:787-796` sobre (b): `previoSinEste = 280,000` →
  `cupoRestante = max(0, 150,000 − 280,000) = 0` → `dentro = 0` →
  `efectivo_sobre_15` por **$10,000**, `proporcionDeducible = 0` → IVA
  acreditable de (b) = **$0**.
- Verdad: el efectivo real del ejercicio es $130,000 + $10,000 = **$140,000**,
  por debajo del 15%. La facilidad aplica entera.

**Consecuencia:** $10,000 de deducción (~$3,000 de ISR) y $1,600 de IVA negados
con «No deducible» en rojo en el PDF que el contralor archiva — el mismo daño,
la misma dirección y la misma mecánica que FIS-C2, sobre otro valor de entrada.
Es la reincidencia número cuatro de la misma familia.

---

### 3. [ALTO] El cuarto sitio: `tools.ts:200` mide el MISMO cubo con otro denominador — el agente contesta «holgado» sobre la corrida cuyo PDF quita deducción

`src/lib/likida/tools.ts:200`:

```ts
const acum = await getAcumuladoCombustible(ctx.tenantId, ejercicio);
```

Sin el tercer argumento. `repo.ts:1364` lo traduce a `p_claves: null`, y la RPC
(`0305:56`) cae entonces al criterio angosto: **solo** `concepto = 'diesel'`.
Los otros dos llamadores sí pasan las claves del SAT —`desde_db.ts:128`
(`config.hidrocarburos.claves`) y `fiscal.ts:487` (`clavesCombustible`, la vía
del panel del contador y de `resumen_fiscal`)—, con
`['15101505','15101514','15101515']` por defecto (`config.ts:122`). Tres
llamadores, dos criterios.

La ironía es que ese mismo bloque ya armonizó **un** argumento por esta razón
exacta (`tools.ts:195-197`: «AUDITORÍA 15, MEDIO (arquitectura): tools.ts usaba
el año del PROCESO y desde_db el año del viaje — dos barridos con dos
criterios»). Se corrigió el año y se dejó las claves.

**Por qué la divergencia es alcanzable** (no basta con que las claves existan:
hace falta un gasto de combustible cuyo `concepto` no sea `'diesel'`).
`conceptoDesdeClave` (`intake/concepto.ts:48`, que mapea las tres claves a
`'diesel'`) corre en **un solo** camino: el alta por XML sin foto previa
(`processor.ts:3179`). El camino normal —foto primero, XML después— escribe
`clave_prod_serv` **sin recalcular `concepto`**: `repo.ts:802`
(`updateGastoCfdiXml`) y `intake/consolidado.ts:297`. Un ticket de gasolinera
que la visión clasificó `factura` u `otro` y cuyo CFDI llegó después queda con
`concepto != 'diesel'` **y** `clave_prod_serv = '15101505'`.

**Escenario.** Ejercicio 2026, `facilidad15: true`.

- $700,000 de combustible con `concepto = 'diesel'`, todo con tarjeta (`'04'`).
- $300,000 con `concepto = 'otro'` + `clave_prod_serv = '15101505'` (fotos
  ligadas a su XML por `updateGastoCfdiXml`), de los cuales **$160,000** en
  efectivo (`'01'`).

| | con claves (`desde_db` / panel / `resumen_fiscal`) | sin claves (`tools.ts:200`) |
|---|---|---|
| `total` | $1,000,000 | $700,000 |
| `efectivo` | $160,000 | $0 |
| `razon` | 16 % | 0 % |
| `estado` (`periodo/combustible.ts:85`) | **`excedido`** | **`holgado`** |
| `margen` | $0 | $105,000 |

El motor marca `efectivo_sobre_15` por **$10,000** y el PDF los imprime como no
deducibles (y $1,600 de IVA fuera). En el **mismo turno**, la tool
`cuadrar_viaje` devuelve `combustible_efectivo_ejercicio: { estado: 'holgado',
razon: 0, margen: 105000 }`, y como `tools.ts:220` solo agrega
`rfa-2026-2.9` a `fundamentos` cuando `estado !== 'holgado'`, el agente **ni
siquiera tiene permiso de citar la regla**: contesta por WhatsApp que quedan
$105,000 de margen sobre la liquidación cuyo papel dice lo contrario. Es
literalmente «una cifra fiscal que se lee distinto en dos pantallas».

---

### 4. [MEDIO] El comentario de `desde_db.ts:133-135` describe lo contrario de lo que hace `:155` — y es la razón por la que el hallazgo 1 sobrevivió diez auditorías

```
// el motor; sumarlos doblaría el contador). AUDITORÍA 16, ALTO (datos): solo
// los del MISMO ejercicio — un gasto de otro año (o sin fecha) no está en el
// contador y restarlo fabricaba un previo negativo.
```

El comentario afirma que un gasto **sin fecha** «no está en el contador» y que
por eso no se resta. El código de `:155` lo resta siempre (hallazgo 1). La
mitad de «otro año» sí funciona; la mitad de «sin fecha» dice exactamente lo
opuesto a lo que ejecuta.

Es el mismo modo de falla que la 0305 (`:12-16`, «Gasto no trae `pagadoForma`
en ese tipo») y que este arreglo corrigió: un comentario que declara resuelto
un caso hace que el siguiente lector —humano o agente— no vuelva a mirar la
línea. Es la razón por la que el arreglo `abf6921`, que editó **el predicado de
al lado en el mismo `.filter`**, no vio el `?? anioEjercicio`.

---

### 5. [BAJO] `monto ≤ 0`: la RPC lo ignora, la resta en TS lo suma con signo

`0305:53` filtra `and monto > 0`. `desde_db.ts:157`
(`.reduce((s, g) => s + Number(g.monto ?? 0), 0)`) no filtra nada, y el motor sí
contempla montos no positivos (`monto_invalido` en `engine.ts:430`; la 0112
corrigió este mismo filtro en SQL precisamente por eso).

**Escenario (corrido).** Acumulado del ejercicio $100,000 (RPC). Este viaje:
un diésel en efectivo de **$20,000** y otro renglón de diésel en efectivo de
**−$500** (una nota de crédito / un OCR con el signo mal leído, que el motor ya
marca `monto_invalido`).
`efectivoDeEsteViaje = 20,000 − 500 = 19,500` →
`efectivoPrevEjercicio = 80,500` *(medido: 80500)* donde debería ser **80,000**.

Dirección conservadora (encoge el cupo, no lo agranda), magnitud igual al monto
mal firmado. BAJO por eso, pero es el mismo defecto de clase: la resta no
reproduce el `where` de la RPC.

---

### 6. [BAJO] Tres afirmaciones del comentario y del mensaje de commit que no se sostienen

Verifiqué las del arreglo una por una. **Las cuantitativas son ciertas**
(ver «Lo que salió limpio»). Estas tres, no:

1. **«es la MISMA regla que la 0305 escribió en SQL»** (`engine.ts:207-210` y
   `desde_db.ts:152-153`, repetida en el commit). No lo es en el caso
   `pagado_forma = '99'` (hallazgo 2), donde SQL cuenta y TS no. La afirmación
   de identidad es justamente la que apaga la comparación caso por caso.
2. **«pasa a exportarse … y ahora tiene un solo dueño en TS»** / «la tercera
   copia es la que diverge» (commit y `engine.ts:210`). La tercera y la cuarta
   copia ya existen: `src/lib/likida/fiscal.ts:229-231` (`formaPagoEfectiva`
   sobre `GastoFiscal`, equivalente pero copia aparte) y
   `src/lib/likida/cuadre/engine.ts:1657-1658` — una constante local en el
   segundo recorrido del propio motor que **no** es equivalente: para un `'99'`
   sin REP devuelve `'99'` donde `formaPagoJuzgableDe` devuelve `undefined`.
   Hoy es inocua (sus dos usos son `.includes()` sobre listas que no contienen
   `'99'`, `:1681` y `:1732`), pero «un solo dueño» describe un estado que no
   existe.
3. **«Reincidente de la 23, la 24 y la 25 — las tres lo dieron por cerrado»**
   (commit). Contradicho por el propio repo: `docs/auditoria-24/RESULTADO.md:32`
   lo lista en «**Pendientes con razón escrita: 4** — FIS-C1 y FIS-C2», y
   `docs/auditoria-25/00-SINTESIS.md:100-104` lo encabeza como «REINCIDENTE …
   **Misma familia que FIS-C1: se arreglan juntos o se contradicen**». La 24 y
   la 25 lo dejaron **abierto y declarado**; la 25 sí intentó cerrarlo con la
   0305. Ninguna de las dos «lo dio por cerrado».

---

## Lo que salió limpio (caminos recorridos, no supuestos)

**El arreglo no introdujo ningún defecto.** `formaPagoJuzgableDe`
(`engine.ts:213-219`) es la expresión **idéntica** a la constante local que
sustituyó (`engine.ts:708`, diff de `abf6921`): mismo operando, mismo orden,
mismo `undefined`. El cambio en `engine.ts` es refactor puro, así que ningún
llamador de `cuadrarViaje` (`tools.ts` vía `computeCuadre`, la guardia
determinística del processor) cambia de comportamiento. El único cambio de
valor es `efectivoDeEsteViaje` en `desde_db.ts:156`, y recorrí sus casos
frontera contra `0305:46-49` uno por uno:

| entrada | 0305 (SQL) | `formaPagoJuzgableDe` + `medioNoAdmitidoCombustible` | ¿resta = suma? |
|---|---|---|---|
| `'99'` + `pagado_en` + `pagado_forma='01'` | cuenta (`'01'`) | resta | ✅ |
| `'99'` + `pagado_en` + `pagado_forma='06'` | cuenta (`'06'`) | resta | ✅ |
| `'99'` + `pagado_en` + `pagado_forma='03'` | no cuenta | no resta | ✅ |
| `'99'` + `pagado_en` + `pagado_forma` NULL | NULL → no cuenta | `undefined` → no resta | ✅ |
| `'99'` sin `pagado_en` | NULL → no cuenta | `undefined` → no resta | ✅ |
| `'99'` + `pagado_forma` sin `pagado_en` | rama 2 → NULL → no cuenta | `undefined` → no resta | ✅ |
| `forma_pago` NULL (con o sin REP) | `is not null` → no cuenta | `!formaPago` → no resta | ✅ |
| `'01'` | cuenta | resta | ✅ |
| `'06'`, `'08'`, `'12'`, `'17'`, `'23'` (fuera de LISR 27-III) | cuenta | resta | ✅ |
| `'02'/'03'/'04'/'05'/'28'/'29'` | no cuenta | no resta | ✅ |
| **`'99'` + `pagado_en` + `pagado_forma='99'`** | **cuenta** | **no resta** | ❌ hallazgo 2 |

`forma_pago = ''` no es una divergencia posible: el CHECK
`gasto_forma_pago_formato` (`supabase/migrations/0025_dominios_check.sql:97-98`,
`forma_pago is null or forma_pago ~ '^[0-9]{2}$'`) lo prohíbe, y `formaPagoSat`
(`intake/cfdi_xml.ts:232`) nunca produce cadena vacía. (La `nullif(forma_pago,'')`
de la 0317 es defensiva, no evidencia de que ocurra.)

**Caminos que abrí buscando el cuarto sitio y salieron correctos:**

- `src/lib/likida/fiscal.ts:229-231` (`formaPagoEfectiva`, el panel del
  contador): usa `g.pagado`, que la RPC define como
  `(g.pagado_en is not null)` — `supabase/migrations/0282_…sql:46` y
  `0317_…sql:79`. Es **la misma regla** que el SQL del cubo y que
  `formaPagoJuzgableDe`, caso por caso.
- `src/lib/likida/fiscal.ts:524-535` (`proporcionCombustible15`): consume la
  RPC **directamente**, sin restar ningún término propio, así que no tiene la
  asimetría que define a FIS-C2. Confirmé además la cifra que el commit
  atribuye al panel: con `efectivo = 150,000` y `total = 1,000,000`,
  `excedente = 0` → `proporcionesDeducibles` (`engine.ts:583-584`) devuelve
  `(150,000 − 0)/150,000 = 1` → IVA acreditable completo, **$24,000** sobre un
  IVA trasladado de $24,000 (`fiscal.ts:1096-1100`). El commit dice la verdad.
- `resumen_fiscal` (`src/lib/mcp/herramientas/dinero.ts:166`): pasa por
  `opcionesFiscalesDelPeriodo` → `combustibleEjercicioDe` → `getAcumuladoCombustible`
  **con** las claves. Coincide con el panel y con `desde_db`.
- `src/lib/likida/fiscal.ts:1205-1214` (`tope15DeGastos`): recalcula el cubo
  desde las filas, pero con `formaPagoEfectiva` — mismo criterio. Sin llamadores
  de producción (solo `fiscal.test.ts:493` y `fiscal_agregado.test.ts:328`), así
  que no puede contradecir a nadie hoy.
- `src/lib/likida/cuadre/engine.ts:1657-1658` (la otra constante local, la del
  IVA / peaje electrónico / IEPS): difiere de `formaPagoJuzgableDe` para un
  `'99'` sin REP (`'99'` vs `undefined`), pero sus **dos** usos son
  `MEDIOS_ELECTRONICOS_PEAJE.includes(...)` (`:1681`) y
  `MEDIOS_LISR_27_III.includes(...)` (`:1732`), y `'99'` no está en ninguna de
  las dos listas: mismo resultado en todos los casos. Divergencia latente
  documentada arriba (hallazgo 6.2), no un defecto de dinero hoy.
- Migraciones que suman combustible por forma de pago: solo el linaje
  0084 → 0112 → 0190 → **0305** de `sumar_combustible_ejercicio` (misma firma,
  `create or replace`; la 0305 es la viva). Las 0282/0317
  (`gastos_fiscales_agregados`) parten celdas por dimensión y declaran no
  evaluar deducibilidad — la ley sigue en TS. No hay una quinta suma.

**Las pruebas nuevas (`desde_db_efectivo_previo.test.ts`), verificadas sobre una
copia del árbol fuera del repo** (`cp -r` al scratchpad, `/home/user/cuadra`
intacto), revirtiendo únicamente `formaPagoJuzgableDe(g)` → `g.formaPago` en
`desde_db.ts:156`:

| prueba | con el arreglo | revertido |
|---|---|---|
| `'99'` con REP en efectivo (`:78`) | ✅ 0 | ❌ **falla**: `expected 150000 to be +0` |
| `'99'` sin REP (`:98`) | ✅ 40000 | ✅ pasa igual |
| `'99'` con REP por transferencia (`:112`) | ✅ 40000 | ✅ pasa igual |
| efectivo en mano `'01'` (`:126`) | ✅ 90000 | ✅ pasa igual |

Es decir: **una de las cuatro discrimina**; las otras tres son guardas de no
regresión y pasarían con el código viejo. El mensaje de commit lo dice así
(«la primera pasa de 150,000 a 0 con el arreglo y falla sin él») — no hay
sobreafirmación aquí. Lo que ninguna de las cuatro pisa es
`pagado_forma = '99'` ni el gasto sin fecha, que es por lo que los hallazgos 1
y 2 siguen vivos con la suite en verde.
