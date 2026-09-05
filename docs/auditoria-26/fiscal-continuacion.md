# Cumplimiento fiscal — continuación de la auditoría 26

**Nota: 4/10** (antes 5). Razón del movimiento: **deuda que cobró factura**.
El patrón que el encargo describía se repitió por tercera vez consecutiva, y
esta vez el término que quedó sin espejar **no está en el `where` de la RPC**:
está en el motor. `8abb5968` alineó la RESTA (`desde_db.ts`) con la fecha de la
0305 y dejó desalineada la SUMA (`engine.ts:790`), que es la que produce el
número impreso. Resultado medido con `cuadrarViaje` real: el mismo comprobante
de diésel imprime **«No deducible $111,000.00 · IVA acreditable $689.66»**
cuando el OCR no pudo leer el año, y **«$93,600.00 / $3,089.66»** cuando sí
pudo. Nada más cambia entre las dos corridas. El ancla del rubro («3 o menos si
el producto imprime una cifra fiscal equivocada») se roza; queda en 4 porque las
dos CRÍTICAS anteriores de esta familia (`abf6921` y `8abb596`) sí cerraron de
verdad, con prueba que falla al revertirlas, y porque todo lo que está fuera del
cubo del 15 % sigue trazando limpio.

**El riesgo mayor del rubro, hoy:** un ticket de diésel cuya fecha el OCR
devolvió `null` —el caso que el propio prompt del intake ordena producir— entra
al NUMERADOR del cubo del 15 % y no al DENOMINADOR, y el PDF imprime en un mismo
renglón un acumulado de **$261,000.00** contra un total de **$1,000,000.00** que
no lo contiene.

| Severidad | # |
|---|---|
| CRÍTICO | 1 |
| ALTO | 4 (los 4 REINCIDENTES) |
| MEDIO | 3 (2 REINCIDENTES) |
| BAJO | 1 |

Todo lo de abajo está **corrido**, no razonado: sobre una copia del árbol fuera
del repo (`cp -r` al scratchpad; `node_modules` por symlink; `/home/user/cuadra`
intacto, `git status --porcelain` sin cambios míos), con `cuadrarViaje` y
`cuadrarDesdeDB` reales. Las cifras van marcadas *(medido: …)*.

---

## Veredicto sobre `8abb5968`: el cotejo término por término RPC 0305 ↔ `.filter` de TS

RPC viva: `supabase/migrations/0305_15pct_efectivo_forma_pago_efectiva.sql:44-66`.
`.filter` de hoy: `src/lib/likida/cuadre/desde_db.ts:169-173`.

| término | RPC (0305) | `.filter` de TS de hoy | ¿espeja? |
|---|---|---|---|
| `tenant_id = p_tenant` | `:51` | `getGastos` filtra `.eq('tenant_id', …)` — `repo.ts:958` | **sí** |
| `monto > 0` | `:52` | **no existe**; el `reduce` de `:173` suma `Number(g.monto ?? 0)` sin filtrar | **NO** — pero inerte (ver BAJO-1) |
| `fecha >= make_date(p_anio,1,1)` | `:53` | `g.fecha != null && g.fecha.slice(0,4) === anioEjercicio` | **sí** ← esto es lo que arregló `8abb596` |
| `fecha <= make_date(p_anio,12,31)` | `:54` | ídem (comparación de año sobre columna `date`, `0001_init.sql:62`) | **sí** |
| `concepto = 'diesel' or clave_prod_serv = any(p_claves)` | `:55` | `g.concepto === 'diesel' \|\| clavesCombustible.includes(g.claveProdServ ?? '')`, con el **mismo** array que se le pasa a la RPC (`desde_db.ts:116` → `:128` → `repo.ts:1364`) | **sí** |
| `forma_pago_efectiva is not null` | `:61` | `formaPagoJuzgableDe` devuelve `undefined` y `medioNoAdmitidoCombustible` corta en `if (!formaPago) return false` (`engine.ts:222`) | **sí** |
| `forma_pago_efectiva not in ('02','03','04','05','28','29')` | `:62` | `medioNoAdmitidoCombustible(...)` con la MISMA lista (`MEDIOS_LISR_27_III`), **salvo** el corte extra `if (formaPago === FORMA_PAGO_SIN_PAGAR) return false` (`engine.ts:223`) | **NO** para `pagado_forma = '99'` — ALTO-1 |

**Respuesta a la pregunta del encargo — qué término queda:** en el `where`, el
único que no se espeja es **`monto > 0`**, y lo refuto yo mismo como hallazgo:
el CHECK `gasto_monto_no_negativo` (`supabase/migrations/0070_montos_no_negativos.sql:41`,
`check (monto >= 0)`) hace imposible el escenario de −$500 que la reauditoría
publicó como su BAJO 5, y con `monto = 0` la resta aporta exactamente $0
*(medido: previo 80,000 con y sin el renglón de $0, acumulado 100,000, gasto
válido de 20,000)*. La 0112 ya lo había escrito así (`0112:113`: «el filtro
`monto > 0` **no corrige nada; es defensa en profundidad**»). Ese BAJO no
existe.

**Pero el patrón se cumplió igual, un nivel más afuera.** El cubo del 15 % no es
`RPC − resta`: es `RPC − resta + suma`, y la tercera pieza es el motor
(`engine.ts:789-790`: `const previoSinEste = (input.efectivoPrevEjercicio ?? 0)
+ efectivoAcumuladoEjercicio; efectivoAcumuladoEjercicio += g.monto;`). Para
decidir si un gasto es del ejercicio, el motor usa **su propio criterio**
(`engine.ts:765-766`), y ése sigue diciendo lo contrario que la 0305:

```ts
const anioComprobante = g.fecha ? g.fecha.slice(0, 4) : null;
const mismoEjercicio = !anioComprobante || anioComprobante === input.anioEjercicio;
```

`!anioComprobante` ⇒ un gasto **sin fecha es del ejercicio** para el motor, y
**no lo es** para la RPC. `8abb596` alineó la resta con la RPC y dejó la suma
con el criterio viejo, así que hoy el comprobante entra al numerador sin entrar
al denominador. Es literalmente el mismo modo de falla que `abf6921` (alineó la
forma de pago, dejó la fecha) y que `8abb596` (alineó la fecha, dejó esto), sobre
el término que el auditor anterior sí nombró —«tres criterios, tres
respuestas»— y que el arreglo no tocó.

**Lo que el arreglo sí cerró, verificado:** con el gasto sin fecha,
`efectivoPrevEjercicio` sale **145,000** y no 65,000 *(medido, corriendo
`cuadrarDesdeDB` real con `getAcumuladoCombustible` en `{efectivo: 145000,
totalCombustible: 1000000}`)*. La dirección «regala cupo» desapareció. Lo que la
prueba nueva (`desde_db_efectivo_previo.test.ts:140-152`) fija es
`efectivoPrevEjercicio`, un **término intermedio**; ninguna prueba mira el número
que sale impreso, y por eso el CRÍTICO de abajo pasa con la suite en verde.

---

## Hallazgos

### 1. [CRÍTICO] El gasto sin fecha entra al NUMERADOR del 15 % y no al DENOMINADOR: el PDF imprime un excedente $17,400 mayor que el que la regla arroja, y una razón aritméticamente imposible

`src/lib/likida/cuadre/engine.ts:765-766` (`const mismoEjercicio =
!anioComprobante || …`) · `engine.ts:790` (`efectivoAcumuladoEjercicio +=
g.monto`) · `engine.ts:794` (`const tope = 0.15 * total`, con `total =
input.totalCombustibleEjercicio`, o sea el `total` de la RPC) · contra
`supabase/migrations/0305_…sql:53-54`, donde una `fecha` NULL queda fuera de
`total` **y** de `efectivo`.

**Norma** — `normas/rfa-2026-2.9.yaml`, **`verificado_fuente_primaria`**, literal:

> «…considerarán cumplida la obligación establecida en el artículo 27, fracción
> III, segundo párrafo de la Ley del ISR, cuando los pagos por consumo de
> combustible se realicen con medios distintos a cheque nominativo de la cuenta
> del contribuyente; tarjeta de crédito, de débito o de servicios; o monederos
> electrónicos autorizados por el SAT, **siempre que estos no excedan el 15 por
> ciento del total de los pagos efectuados por consumo de combustible** para
> realizar su actividad.»

El numerador y el denominador de ese «15 por ciento» son **el mismo universo**:
«los pagos efectuados por consumo de combustible». Un peso que se cuenta arriba
tiene que contarse abajo.

**Escenario (corrido).** Flota `facilidad15: true`, ejercicio 2026. Acumulado
previo del ejercicio: `efectivo = 145,000`, `total = 1,000,000` (la RPC, que ya
no ve el comprobante de este viaje porque no tiene fecha). Este viaje trae **un**
CFDI de diésel de **$116,000** (SubTotal $100,000 + IVA $16,000), pagado en
efectivo (`'01'`), XML verificado, receptor correcto, cuya **fecha el OCR
devolvió `null`**.

| | lo que imprime el PDF hoy | el mismo comprobante con fecha legible | la rama de abstención que el propio bloque declara |
|---|---|---|---|
| Deducible ISR | **$5,000.00** | $22,400.00 | $0.00 (no se afirma nada) |
| No deducible | **$111,000.00** | $93,600.00 | $0.00 |
| IVA acreditable | **$689.66** | $3,089.66 | $0.00 |

*(medido: `{deducible:5000, noDeducible:111000, iva:689.66}` con
`totalCombustibleEjercicio: 1_000_000`; `{deducible:22400,
noDeducible:93600, iva:3089.66}` con `1_116_000`, que es el mismo total una vez
que el comprobante se puede fechar.)* La única diferencia entre las dos corridas
es si el OCR leyó el año.

Y la **frase impresa** delata la aritmética, verbatim de la corrida:

> «Combustible pagado en EFECTIVO — el ejercicio lleva **$261,000.00** de
> combustible pagado con medios que la LISR 27-III no admite, contra un tope de
> **$150,000.00 (15% de $1,000,000.00)**…»

$261,000 = $145,000 + $116,000. El $1,000,000 **no** contiene esos $116,000. El
papel presenta un cociente cuyo numerador y denominador no salen del mismo
conjunto: 261,000/1,000,000 = 26.1 %, un porcentaje que no existe.

**No es un caso de laboratorio, y no hay guardarraíl** (lo busqué, uno por uno):

- El prompt del OCR **ordena** producir este estado: `intake/ocr.ts:171` («Si no
  puedes leer el año con seguridad, devuelve null en vez de adivinar») y `:195`
  («El AÑO se copia de lo impreso. Si está tapado, borroso o cortado, devuelve
  null en "fecha"»).
- Se persiste tal cual: `repo.ts:353` (`fecha: g.fecha ?? null`) sobre una
  columna nullable (`0001_init.sql:62`, `fecha date`).
- **`pedir_fecha` no lo cubre**: `fechaDudosa` (`cuadre/fecha_dudosa.ts:91`)
  abre con `if (!fecha) return null`, y el llamador
  (`processor.ts:2628-2629`) solo anota incidencia si `dudosa` no es null. Sin
  fecha no hay mensaje al operador. Su propio tipo lo dice:
  `pedir_fecha.ts:TicketPorRefotografiar.fecha` es `string` obligatorio.
- El motor tampoco lo marca: `engine.ts:1274` (`if (!g.fecha) continue; // sin
  fecha no se afirma nada`) apaga `fecha_sospechosa` y `gasto_otro_ejercicio`.
  La corrida devolvió **una sola** diferencia, `efectivo_sobre_15`; ninguna
  bandera de calidad de dato acompaña al renglón.
- El fail-closed que existe es para el caso vecino y funciona: con `fecha =
  '2025-05-01'` el motor emite `combustible_efectivo` con monto 0 y la nota «este
  comprobante es de 2025 y la facilidad se mide contra el ejercicio 2026 — se
  revisa aparte. No se afirma deducible ni no deducible» *(medido:
  `{deducible:0, noDeducible:0, iva:0}`)*. El comprobante **sin** año, que se
  sabe *menos*, recibe un veredicto *más* tajante que el de otro ejercicio.

**Consecuencia.** El contralor archiva un PDF que niega $111,000 de deducción
(~$33,300 de ISR) donde la regla, medida coherentemente, niega $93,600, y que
acredita $689.66 de IVA donde corresponden $3,089.66 — $17,400 y $2,400 en
contra del cliente, por un ticket borroso. Si el contador cruza la frase contra
la RFA, el renglón no se puede defender: la razón impresa (26.1 %) no se puede
reconstruir con el total que el mismo renglón declara. Y la liquidación cierra
sin una sola bandera de dato incompleto, así que nadie la mira dos veces.

**Causa raíz probable:** `engine.ts:766` trata «sin año» como «de este año»
mientras la 0305 lo trata como «de ningún año»; el arreglo alineó la resta con la
RPC y no la suma. **¿Quirúrgico? Sí** — es un operando: `!anioComprobante ||`
pasa a `anioComprobante != null &&`, con lo que el gasto sin fecha cae en la rama
de abstención que ya existe cinco líneas más abajo (`engine.ts:769-782`) y que
ya está redactada para esto («no se afirma deducible ni no deducible»). No hay
convención nueva que decidir: la convención está escrita en el comentario de ese
mismo bloque (`engine.ts:760-764`, «fail-closed REAL — … la facilidad solo aplica
con la base medida») y coincide con lo que la RPC hace.

---

### 2. [ALTO · REINCIDENTE] Un REP cuyo `FormaDePagoP` es a su vez `'99'`: la RPC lo cuenta, el motor no lo juzga, la resta no lo resta, y la prueba de paridad fija la asimetría

`src/lib/likida/cuadre/desde_db.ts:170` (`medioNoAdmitidoCombustible(formaPagoJuzgableDe(g))`) ·
`src/lib/likida/cuadre/engine.ts:213-219` (`formaPagoJuzgableDe`, devuelve
`g.pagadoForma` = `'99'`) · `engine.ts:223` (`if (formaPago ===
FORMA_PAGO_SIN_PAGAR) return false`) · contra
`supabase/migrations/0305_…sql:47` (`when forma_pago = '99' and pagado_en is not
null then pagado_forma`) y `:61-62` (`forma_pago_efectiva is not null and …not
in ('02','03','04','05','28','29')` — `'99'` no está en la lista, así que
**cuenta**) · la escritura: `src/lib/likida/intake/rep.ts:146`
(`formaDePagoP: formaPagoSat(p['@_FormaDePagoP'])`) y `rep.ts:221`
(`.update({ pagado_en: fechaPago, pagado_forma: pago.formaDePagoP ?? null })`) ·
`src/lib/likida/intake/cfdi_xml.ts:232-236` (`formaPagoSat` acepta **cualquier**
`^\d{1,2}$`, `'99'` incluido) · el CHECK lo admite
(`supabase/migrations/0199_rep_metodo_pago.sql:41-42`) ·
`src/lib/likida/fiscal_agregado_15pct.test.ts:62`
(`expect(listaDelSql()).not.toContain('99')`).

**Norma** — `normas/rfa-2026-2.9.yaml`, `verificado_fuente_primaria`: «siempre
que **estos** no excedan el 15 por ciento del total de los pagos efectuados por
consumo de combustible». «Estos» son los pagos por medios distintos a los tres
que la regla enumera; un mismo peso no puede estar dentro del numerador para el
SQL y fuera para el TypeScript.

**Escenario (re-medido hoy).** Flota `facilidad15: true`, ejercicio 2026,
`total = 1,000,000` → tope 15 % = **$150,000**. Viajes anteriores: $130,000 de
diésel en efectivo (`'01'`). Este viaje: (a) CFDI de diésel de **$150,000**,
`FormaPago '99'`, `MetodoPago PPD`, REP con `FormaDePagoP '99'` y `pagadoEn
2026-02-20`; (b) ticket de diésel de **$10,000** en efectivo (`'01'`), IVA
$1,600.

- La RPC: `forma_pago_efectiva` de (a) = `'99'` → no es NULL y no está en la
  lista → `efectivo = 130,000 + 150,000 + 10,000 = 290,000`.
- `desde_db.ts:169-173` resta solo (b) → **`efectivoPrevEjercicio = 280,000`**
  *(medido: 280000, con `cuadrarDesdeDB` real)*. El previo verdadero es 130,000.
- `engine.ts:791-798` sobre (b): `cupoRestante = max(0, 150,000 − 280,000) = 0`
  → `efectivo_sobre_15` por **$10,000**, `proporcionDeducible = 0`, IVA
  acreditable **$0**.
- Verdad: efectivo real del ejercicio = 130,000 + 10,000 = **$140,000**, por
  debajo del 15 %. La facilidad aplica entera.

**Consecuencia.** $10,000 de deducción (~$3,000 de ISR) y $1,600 de IVA negados
en rojo en el PDF que el contralor archiva. Y la prueba que dice garantizar
«misma lista, mismo criterio» entre SQL y TS
(`fiscal_agregado_15pct.test.ts:62`) **exige por escrito** que el SQL no excluya
el `'99'`: la divergencia está clavada por una prueba verde, que es por lo que
sobrevive a las rondas.

**Causa raíz probable:** la cabecera de la 0305 (`:26-29`) borró el
`forma_pago_efectiva <> '99'` de la 0190 (`0190:38`) sobre una prueba por
exhaución —«un '99' nunca puede sobrevivir a la sustitución»— que es falsa porque
`pagado_forma` puede valer `'99'`. **¿Quirúrgico? Sí, con una nota**: es una línea
(`and forma_pago_efectiva <> '99'` en una migración nueva que reemplace la
función), y **no hay convención nueva que decidir** porque el propio código ya la
declaró («`'99'` no es un medio de pago sino la ausencia de uno», `engine.ts:198`)
y la aplica en las otras tres ramas. Lo que no es quirúrgico es el commit: hay
que voltear la aserción de `fiscal_agregado_15pct.test.ts:62` y corregir el
párrafo de exhaución de la 0305 en el mismo cambio, o la prueba lo revierte.

---

### 3. [ALTO · REINCIDENTE] El cuarto sitio: `tools.ts:200` mide el MISMO cubo con otro denominador, y el agente contesta «holgado» sobre la corrida cuyo PDF quita deducción

`src/lib/likida/tools.ts:200` (`const acum = await
getAcumuladoCombustible(ctx.tenantId, ejercicio);` — **sin** el tercer
argumento) · `src/lib/likida/repo.ts:1364` (`p_claves: claves?.length ? claves :
null`) · `supabase/migrations/0305_…sql:55` (`p_claves is not null and
cardinality(p_claves) > 0 and …`, o sea: sin claves, **solo** `concepto =
'diesel'`) · contra los otros dos llamadores, que sí las pasan:
`src/lib/likida/cuadre/desde_db.ts:128` y `src/lib/likida/fiscal.ts:487` ·
`tools.ts:220` (`if (periodo && periodo.estado !== 'holgado' &&
!fundamentos.includes('rfa-2026-2.9')) fundamentos.push('rfa-2026-2.9')`).

**Norma** — `normas/rfa-2026-2.9.yaml`: el denominador de la regla es «**el
total** de los pagos efectuados por consumo de combustible para realizar su
actividad». Un total que omite el 30 % del combustible del ejercicio no es ese
total.

**Por qué es alcanzable** (lo verifiqué hoy, porque no basta con que las claves
existan: hace falta un combustible cuyo `concepto` no sea `'diesel'`):
`conceptoDesdeClave` —la única función que traduce la clave SAT a
`concepto = 'diesel'`— tiene **un solo** llamador en producción,
`processor.ts:3179`, el alta por XML sin foto previa. El camino normal —foto
primero, XML después— escribe `clave_prod_serv` **sin recalcular `concepto`**:
`repo.ts:802` (`updateGastoCfdiXml`, `clave_prod_serv: x.claveProdServ ?? null`)
y `intake/consolidado.ts:297` (`cambios.clave_prod_serv = diesel.claveProdServ`).
Un ticket de gasolinera que la visión clasificó `factura` u `otro` y cuyo CFDI
llegó después queda con `concepto != 'diesel'` **y** `clave_prod_serv =
'15101505'`.

**Escenario.** Ejercicio 2026, `facilidad15: true`. $700,000 de combustible con
`concepto = 'diesel'`, todo con tarjeta (`'04'`); $300,000 con `concepto =
'otro'` + `clave_prod_serv = '15101505'`, de los cuales **$160,000** en efectivo.

| | con claves (`desde_db` / panel / `resumen_fiscal`) | sin claves (`tools.ts:200`) |
|---|---|---|
| `total` | $1,000,000 | $700,000 |
| `efectivo` | $160,000 | $0 |
| `razon` | 16 % | 0 % |
| `estado` (`periodo/combustible.ts`) | **`excedido`** | **`holgado`** |
| `margen` | $0 | $105,000 |

El motor marca `efectivo_sobre_15` por **$10,000** y el PDF los imprime como no
deducibles (más $1,600 de IVA fuera). En el **mismo turno**, `cuadrar_viaje`
devuelve `combustible_efectivo_ejercicio: { estado: 'holgado', razon: 0, margen:
105000 }`, y como `tools.ts:220` solo agrega `rfa-2026-2.9` a `fundamentos`
cuando `estado !== 'holgado'`, el agente **ni siquiera tiene permiso de citar la
regla**: le contesta al contralor por WhatsApp que le quedan $105,000 de margen
sobre la liquidación cuyo papel dice lo contrario.

**Consecuencia.** «Una cifra fiscal que se lee distinto en dos pantallas», que
es la regla del producto que este rubro custodia — y aquí las dos pantallas son
el PDF archivado y el chat que lo explica, en el mismo minuto.

**Causa raíz probable:** el bloque de al lado ya armonizó **un** argumento por
esta misma razón (`tools.ts:195-197`, «AUDITORÍA 15… dos barridos con dos
criterios»); se corrigió el año y se dejó las claves. **¿Quirúrgico? Sí**: pasar
el tercer argumento con las claves de la config, que ya se lee cinco líneas
abajo (`tools.ts:205`, `const cfg = await getConfig(ctx.tenantId)`) — hay que
subir esa lectura. Ninguna convención nueva: la fija `desde_db.ts:128`.

---

### 4. [ALTO · REINCIDENTE, sin tocar] La póliza contable asienta el IVA acreditable de liquidaciones que nadie ha firmado

`supabase/migrations/0307_poliza_y_viaje_respetan_rechazada.sql:119`
(`and l.revision <> 'rechazada';` — verificado hoy: es el **único** predicado de
revisión de la RPC) · `src/app/api/export/poliza/route.ts:299` (la llamada;
verificado hoy: **cero** ocurrencias de `revision` en toda la ruta, así que no
filtra después) · `src/lib/likida/contabilidad/poliza.ts:175-180`
(`if (liq.ivaAcreditable > 0) { … cuenta: catalogo.ivaAcreditable, cargo:
REDONDEO(liq.ivaAcreditable) }`) · contra las dos puertas que sí se cerraron:
`0308_acreditables_solo_firmadas.sql:52` y
`0316_…_solo_liquidacion_firmada.sql:82` (`revision in ('aprobada','ajustada')`).

**Norma** — `normas/liva-5.yaml`, **`verificado_fuente_primaria`**, literal:

> «Artículo 5o.- **Para que sea acreditable** el impuesto al valor agregado
> **deberán reunirse los siguientes requisitos**: I. Que el impuesto al valor
> agregado corresponda a bienes, servicios o al uso o goce temporal de bienes,
> **estrictamente indispensables** […] se consideran estrictamente
> indispensables las erogaciones efectuadas por el contribuyente **que sean
> deducibles** para los fines del impuesto sobre la renta…»

Y lo que el propio repo declara sobre el mismo dato
(`src/app/api/v1/openapi/route.ts:616`): «`revision: … 'pendiente'` = nadie la
ha firmado: **no la asientes**».

**Escenario** (el de `fiscal.md`, revalidado línea por línea hoy): el viaje 4471
cierra con `iva_acreditable = 16,000.00` en `revision = 'pendiente'`. El contador
exporta la póliza del mes y el archivo trae `IVA acreditable — viaje 4471 ·
cargo 16,000.00`. En la misma pantalla, «IVA acreditable de tus liquidaciones —
LIVA art. 5» **no** cuenta esos $16,000 (0308) y «IVA acreditable documentado»
tampoco (0316). Tres cifras del mismo hecho; la única que no se abstiene es la
que entra al ERP.

**Consecuencia.** El asiento se importa y de ahí sale la declaración. Si luego se
rechaza la liquidación, el IVA ya está cargado y la póliza no se regenera sola:
acreditar de más, con el artículo citado en el concepto del movimiento.

**Causa raíz probable:** la 0307 se escribió desde el hallazgo de *backend*
(«rechazada») y no desde el fiscal («firmada»). **¿Quirúrgico? Sí en la línea, no
en el commit**: es cambiar `<> 'rechazada'` por `in ('aprobada','ajustada')` en
una migración nueva, pero eso **sí decide una convención de producto** —la
póliza deja de poder exportarse antes de firmar— y hay que decidir qué ve el
contador cuando exporta un mes con liquidaciones pendientes (hoy las ve; después
no las vería, y el rótulo tendría que decirlo).

---

### 5. [ALTO · REINCIDENTE, sin tocar] La nota de crédito multi-concepto sigue entrando por dos de las tres puertas de XML

`src/lib/likida/processor.ts:3050` (`if (xml.tipoComprobante === 'E')` — la
Regla de `f37172f`, **antes** de `esConsolidado` en `:3067`, pero **solo** en el
camino del operador con viaje abierto) · `processor.ts:1416` (puerta de OFICINA:
`if (xml?.uuid && esConsolidado(xml))`, sin mirar el tipo — leída hoy) ·
`processor.ts:1770` (puerta de OPERADOR SIN VIAJE ABIERTO: idéntica) ·
`src/lib/likida/intake/cfdi_xml.ts:185-186` (`esConsolidado` = `lineas.length >
1`, no mira `tipoComprobante`) · `src/lib/likida/intake/consolidado.ts:297,
302` (escribe `clave_prod_serv` y `ocrExtra.litros`, y liga con
`xml_verificado: true`).

**Norma** — `normas/lif-2026-20-A.yaml`, **`verificado_fuente_primaria`**:

> «Se otorga un estímulo fiscal a las personas contribuyentes que importen o
> **adquieran** diésel o biodiésel y sus mezclas para su consumo final […] el
> monto que se podrá acreditar será el que resulte de multiplicar la cuota […]
> por **el número de litros importados o adquiridos**.»

Una nota de crédito documenta litros **devueltos o bonificados**, no adquiridos.
Y `normas/liva-5.yaml` fr. I exige una **erogación**.

**Escenario.** Nota de crédito consolidada del emisor del monedero:
`TipoDeComprobante="E"`, tres conceptos ECC de $10,000, $8,000 y $6,000 (400 L,
320 L y 240 L). La oficina la reenvía desde su número (`:1416`) o el chofer con
el viaje ya cerrado (`:1770`). `esConsolidado` dice «sí» (3 > 1),
`guardarYConciliarConsolidado` la casa contra los tickets sin CFDI del mes, y los
tres gastos pasan de `sin_cfdi` a `cfdi_uuid` + `xml_verificado: true`. El PDF
siguiente imprime **«Deducible para ISR $24,000.00»** en verde y **960 L** en
«Diésel elegible para el estímulo de IEPS (LIF 2026 art. 20, ap. A)». El signo
real es el contrario: ese papel **resta** $24,000 y **resta** 960 L.

**Consecuencia.** El desplazamiento contra la realidad es de ~$48,000 de base y
1,920 L de estímulo, en el PDF archivado y en la póliza. `decidirCruce`
(`sat_descarga/cruce.ts:102`) sí aprendió la regla, lo que confirma que el hueco
es de cobertura, no de criterio.

**Causa raíz probable:** el arreglo cubrió las dos puertas que el hallazgo
enumeraba y no preguntó cuántas tiene `processor.ts`. **¿Quirúrgico? Sí**: el
corte natural no son las tres puertas sino `esConsolidado`
(`cfdi_xml.ts:185`), que ya recibe el XML completo y hoy solo cuenta líneas —
un comprobante de egreso nunca es un consolidado de gastos. Una condición, un
sitio, ninguna convención nueva.

---

### 6. [MEDIO · REINCIDENTE] El PDF cita «LIVA 5-III» y la ficha verificada del art. 5 no transcribe ninguna fracción III

`src/lib/likida/cuadre/engine.ts:1668` (la nota impresa, verbatim: «…Su IVA se
acredita en ESE mes (LIVA 5-III), no en el del comprobante (…) — asiéntalo en el
periodo del pago») · `engine.ts:1643` y `:148` (los comentarios que la fundan) ·
`src/lib/likida/fiscal.ts:972` (la misma cita gobernando `ivaSostenible`) ·
`src/lib/likida/intake/rep.ts:250` (el mensaje de WhatsApp: «su IVA se acredita
en el mes del pago (LIVA 5-III)») · `src/types/likida.ts:75` y `:118`.

**Ficha** — `normas/liva-5.yaml`, **`verificado_fuente_primaria`**. Su
`texto_vigente` transcribe el encabezado y **exactamente dos fracciones**: la I
(«…se consideran estrictamente indispensables las erogaciones… que sean
deducibles para los fines del impuesto sobre la renta…») y la II («Que el
impuesto al valor agregado haya sido trasladado expresamente al contribuyente y
que conste por separado en los comprobantes fiscales…»). **No hay fracción III
en el corpus.**

**Escenario.** CFDI de refacciones de $58,000 (SubTotal $50,000 + IVA $8,000),
`FormaPago '99'`, REP del 2026-03-04. El PDF de la liquidación de febrero
difiere los **$8,000** a marzo citando «LIVA 5-III». Si el contralor pide el
fundamento, `normas/consulta.ts:64` le entrega `liva-5.yaml`, donde esa fracción
no existe. Por el método de este rubro, la condición que mueve $8,000 de un mes
a otro queda **no verificable en esta ronda**.

**Consecuencia.** Menor en dinero (la regla es conservadora y muy probablemente
correcta), grave en trazabilidad: es la única cifra del papel cuyo artículo
citado no se puede abrir en `normas/`, contra `normas/README.md` («ninguna ficha
`sin_verificar` debe sostener una cifra que el producto imprima» — y una
fracción ausente es menos que `sin_verificar`).

**Causa raíz probable:** la ficha se cerró el 28-jul-2026 sobre las dos
fracciones que el hallazgo de entonces necesitaba; la regla del REP entró
después. **¿Quirúrgico? No es de código**: es transcribir la fracción III de la
LIVA (o corregir la cita a la que de verdad rige el «efectivamente pagado») en la
ficha, y eso exige abrir la fuente primaria.

---

### 7. [MEDIO · REINCIDENTE] `factura_emitida` obliga `total = subtotal + IVA` y no puede representar la retención del 4 % que el propio Likida timbra

`src/lib/likida/facturacion_escritura.ts:154` (`const total = Math.round((subtotal
+ iva) * 100) / 100`) · `supabase/migrations/0049_cobranza_factura_emitida_pago.sql:54-55`
(`constraint factura_total_cuadra check (abs(total - (subtotal + iva)) <= 0.01)`;
la tabla no tiene columna de retenciones) · contra
`src/lib/likida/carta_porte_cfdi.ts:171-172` (`const ret = esMoral ? dinero(sub *
0.04) : null; const total = dinero(sub + iva - (ret ?? 0));`).

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
moral, para siempre. La otra salida que el constraint permite —teclear IVA
$1,200— hace que la columna `iva` mienta en $400.

**Consecuencia.** Sobre una flota que factura $3,000,000/mes a morales son
**$120,000 mensuales** de saldo fantasma en la cartera, y ninguna de las dos
salidas posibles es correcta. La retención aplica a **todo** flete a persona
moral: es el grueso del mercado, no un borde.

**Causa raíz probable:** la 0049 se diseñó como cuenta por cobrar genérica antes
de que `carta_porte_cfdi.ts` timbrara retenciones. **¿Quirúrgico? No**: exige
columna nueva (`retencion_iva`), migración del constraint y decidir qué significa
«total» en la cartera (lo facturado o lo cobrable). Es una decisión de modelo.

---

### 8. [MEDIO, nuevo] El criterio que decide TODO el tratamiento del `'99'` cita una regla (RMF 2.7.1.29 fr. II) que no tiene ficha en `normas/`

`src/lib/likida/cuadre/engine.ts:127` (`/** '99 Por definir' = la
contraprestación no se ha pagado (RMF 2.7.1.29 fr. II). */`) · `engine.ts:190`,
`:198`, `:698`, `:862`, `:1643` · `src/lib/likida/fiscal.ts:222` y `:974` ·
contra `ls normas/` — **no existe `rmf-2026-2.7.1.29.yaml`**; el corpus tiene
2.7.1.21, 2.7.1.48 y 2.7.7, y `src/lib/likida/normas/indice.ts` no la registra.

**Escenario.** CFDI de hospedaje de $58,000 (SubTotal $50,000 + IVA $8,000),
`FormaPago '99'`, sin REP. El motor niega el IVA acreditable —**$8,000.00** que
no se imprimen en la sección ACREDITABLE— apoyado en que `'99'` significa «no
pagado». Es la misma premisa que hace que `medioNoAdmitidoCombustible` devuelva
`false` para `'99'` (`engine.ts:223`) y, por tanto, la que decide el hallazgo 2
de arriba. No es una cita impresa —lo verifiqué: «2.7.1.29» aparece solo en
comentarios y pruebas, nunca en una `nota`— pero es la premisa de una cifra que
sí se imprime.

**Consecuencia.** El ancla del rubro pide que cada cifra impresa rastree a una
ficha `verificado_fuente_primaria`; ésta rastrea a una regla que no está en el
corpus. Y en concreto: la discusión sobre cómo arreglar el hallazgo 2 (¿el `'99'`
del REP cuenta o no cuenta?) no se puede cerrar contra el texto porque el texto
no está transcrito.

**Causa raíz probable:** la regla entró como comentario en la auditoría 2 y nunca
pasó por `normas/`. **¿Quirúrgico? No es de código**: es una ficha nueva.

---

### 9. [BAJO] El `where` de la RPC conserva un término sin espejar (`monto > 0`) — y hoy es inerte

`supabase/migrations/0305_…sql:52` (`and monto > 0`) · sin contraparte en
`src/lib/likida/cuadre/desde_db.ts:169-173`.

Lo registro para cerrar la pregunta del encargo, **no como defecto**: lo intenté
refutar y se refuta solo. `supabase/migrations/0070_montos_no_negativos.sql:41`
(`add constraint gasto_monto_no_negativo check (monto >= 0)`) hace imposible un
monto negativo, y `gasto_monto_no_nan` (`0025:104`) el NaN; el único valor que
la RPC excluye y TS no es `monto = 0`, que aporta $0 a la resta *(medido:
acumulado 100,000, un renglón de $0 y otro de $20,000 → previo **80,000**, el
mismo con y sin el renglón de $0)*. La 0112 ya lo había dicho: «el filtro `monto
> 0` **no corrige nada; es defensa en profundidad**» (`0112:113`).

**Esto refuta el hallazgo 5 (BAJO) de `fiscal-reauditoria.md`**, cuyo escenario
—«otro renglón de diésel en efectivo de **−$500**»— no puede existir en la base.
El defecto de clase que ese hallazgo describía (la resta no reproduce el `where`)
sí es real, pero su instancia viva es el hallazgo 1 de este documento, no el
monto.

---

## Lo que revisé y está bien

- **El arreglo `8abb5968` no introdujo ningún defecto y cierra lo que nombraba.**
  `desde_db.ts:170` (`g.fecha != null && g.fecha.slice(0,4) === anioEjercicio`)
  es equivalente término a término a `0305:53-54` sobre una columna `date`
  (`0001_init.sql:62`), incluidas las dos comparaciones que un NULL falla.
  Medido: `efectivoPrevEjercicio = 145,000` (era 65,000).
- **La lista de medios sigue siendo una sola.** `MEDIOS_LISR_27_III` en
  `engine.ts` vs `0305:62`, atada por `fiscal_agregado_15pct.test.ts:48-50`
  (`expect([...listaDelSql()].sort()).toEqual([...MEDIOS_LISR_27_III].sort())`),
  contra `normas/lisr-27-III.yaml` («cheque nominativo de la cuenta del
  contribuyente, tarjeta de crédito, de débito, de servicios, o los denominados
  monederos electrónicos autorizados por el Servicio de Administración
  Tributaria»). Correcta.
- **El término de las claves del SAT sí espeja.** `desde_db.ts:116` pasa
  `config.hidrocarburos?.claves ?? []` a la RPC (`:128`) y usa **el mismo array**
  en el `.filter` (`:171`); `repo.ts:1364` traduce el vacío a `null`, que es el
  criterio angosto de `0305:55`. Los dos lados coinciden por construcción — el
  que diverge es el tercer llamador (hallazgo 3).
- **La rama de abstención del otro ejercicio funciona**, contra
  `normas/rfa-2026-2.9.yaml` («el 15 % se mide contra el total del ejercicio», la
  inferencia declarada en `periodicidad_del_15_no_esta_en_la_norma`): con
  `fecha = 2025-05-01` el motor no afirma nada *(medido: deducible 0, no
  deducible 0, IVA 0)*.
- **El prorrateo se declara en el papel.** `LECTURA_RFA_29_PRORRATEO` sale
  íntegro en la nota impresa (lo leí en la corrida), contra
  `normas/rfa-2026-2.9.yaml → lectura_aplicada_por_el_motor`, que exige
  exactamente eso: «una interpretación callada no se puede discutir».
- **El IEPS sigue sin imprimirse en pesos** y los litros salen a 0 en todas las
  ramas del efectivo *(medido: `litros: 0` en las cuatro corridas)*, contra
  `normas/lif-2026-20-A.yaml` («el monto que se podrá acreditar será el que
  resulte de multiplicar la cuota […] por el número de litros… adquiridos») y
  `normas/rfa-2026-2.9.yaml → limite_importante` («Lo que NO habilita es el
  ESTÍMULO del LIF 20-A»).
- **La proporción del IVA sigue a la del ISR.** IVA acreditable = $689.66 sobre
  un traslado de $16,000 con `proporcionDeducible = 5,000/116,000`, y $3,089.66
  con `22,400/116,000` *(medido)* — exactamente `normas/liva-5.yaml` fr. I:
  «únicamente se considerará […] el monto equivalente al impuesto al valor
  agregado que haya sido trasladado al contribuyente […] **en la proporción en la
  que dichas erogaciones sean deducibles** para los fines del impuesto sobre la
  renta». La mecánica es correcta; lo que está mal es la proporción que la
  alimenta (hallazgo 1).
- **`formaPagoJuzgableDe` (`engine.ts:213-219`) espeja el `case` de `0305:47-49`
  en todos los casos menos uno**, y ese uno es el hallazgo 2. Recorrí la tabla de
  la reauditoría (`'99'`+REP `'01'`/`'06'`/`'03'`/NULL, `'99'` sin REP,
  `forma_pago` NULL, `'01'`, `'06'/'08'/'12'/'17'/'23'`,
  `'02'/'03'/'04'/'05'/'28'/'29'`) contra el código de hoy y sigue siendo
  correcta.

## Lo que NO alcancé a revisar

- **Nada que requiera base viva.** Sin `.env` ni Postgres, la equivalencia real
  de 0305/0307/0308/0316/0317 contra datos no se corre aquí; los bloques de
  `supabase/verificaciones.sql` la miden en CI con Postgres efímero. Los
  hallazgos 1, 2 y 9 **no** necesitan base: se reproducen con `cuadrarViaje` y
  `cuadrarDesdeDB` con `repo` espiado, y así los medí.
- **El hallazgo 3 no lo corrí**: exige espiar la RPC con dos juegos de
  parámetros y `getConfig`/`getViaje` reales. Lo verifiqué por lectura de los
  cuatro sitios (`tools.ts:200`, `repo.ts:1364`, `0305:55`, `desde_db.ts:128`) y
  de la alcanzabilidad (`conceptoDesdeClave` con un solo llamador,
  `repo.ts:802`, `consolidado.ts:297`). La tabla de cifras es la de la
  reauditoría, revalidada contra el código de hoy, no re-medida.
- **Los hallazgos 4, 5, 6 y 7** vienen de `fiscal.md`. Reverifiqué de cada uno
  el `archivo:línea`, el predicado exacto y la ausencia del guardarraíl que los
  cerraría (en el 4, que `route.ts` no tiene una sola mención de `revision`; en
  el 5, que `esConsolidado` no mira `tipoComprobante`; en el 6, que la ficha
  sigue con dos fracciones; en el 7, que el constraint sigue sin columna de
  retención). Los escenarios en pesos son los que `fiscal.md` documentó.
- **`normas/lisr-27-III.yaml` sigue en `evidencia_corroborante`** («NO se leyó en
  diputados.gob.mx»), y es la ficha detrás del veredicto rojo más frecuente del
  motor y del importe de **$2,000**. Mientras no se cierre, el ancla de 8+ es
  inalcanzable por construcción. Igual con `cff-29-A` y `rmf-2026-2.7.1.21`.
- **`intake/sat.ts`, `intake/cfdi.ts` y `facturacion/`** no los reabrí en esta
  continuación: el encargo fijó tres frentes y los tres viven en el cubo del
  15 %, en la póliza y en el intake de XML.
