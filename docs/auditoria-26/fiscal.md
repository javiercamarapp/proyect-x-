# Cumplimiento fiscal — auditoría 26

**Nota: 5/10** (antes 4). Razón del movimiento: **el código cambió, y mucho** —
de los nueve hallazgos abiertos de la 25 verifiqué ocho cerrados de verdad
(FIS-P1, FIS-P2 *parcial*, FIS-P3, FIS-P4, FIS-P5, FIS-REAUD-1/2/3), la
disciplina de fichas subió (ficha nueva `rliva-3-fr-II` en
`verificado_fuente_primaria`, el 4º párrafo de la LIF 20-A-IV por fin
transcrito, `normalizarRfc`/`rfcsUtilizablesDe`/`UMBRAL_RENGLONES_AJENOS`
exportados del motor para que el panel no reinvente el criterio) y la
migración 0317 restauró **íntegro** lo que su propio `drop+create` se llevó
—lo verifiqué campo por campo contra la 0282 y la 0192: no falta nada más
(ver «Lo que revisé»). Lo que impide llegar a 6 es que el arreglo de
FIS-C1/FIS-C2 (`0e4c0d7`) movió la frontera del medio de pago **en SQL** y
dejó la resta que la compensa **en TypeScript** con la forma cruda: la regla
2.9 sigue dando dos cifras sobre el mismo UUID, solo que ahora el PDF es el
que está mal y en la dirección que le **quita** al cliente la deducción. Una
puerta en vez de cuatro, pero sigue siendo una puerta, y el ancla del rubro es
explícita.

**El riesgo mayor del rubro, hoy:** un CFDI de diésel a crédito cuyo
complemento de pago llegó (el caso rutinario de la flota con línea en la
estación) sale del motor con **«No deducible $150,000.00»** en rojo y **$0.00**
de IVA cuando la RFA 2.9 le concede la deducción entera —y el panel del
contador, sobre el MISMO comprobante, imprime **$24,000.00** de IVA
acreditable. Está verificado corriendo `cuadrarViaje`, no leído.

---

## Hallazgos

### [CRÍTICO, REINCIDENTE de la 23, la 24 y la 25 — cierre PARCIAL de FIS-C2] El contador del 15% cuenta DOS VECES el efectivo que el REP reveló en este mismo viaje: el PDF niega una deducción que la regla concede

`src/lib/likida/cuadre/desde_db.ts:143-147` (`efectivoDeEsteViaje` sigue
filtrando con `medioNoAdmitidoCombustible(g.formaPago)` — la forma **cruda**) ·
`desde_db.ts:147` (`efectivoPrevEjercicio = totalesEjercicio.efectivo −
efectivoDeEsteViaje`) · contra
`supabase/migrations/0305_15pct_efectivo_forma_pago_efectiva.sql:47-51`
(el arreglo: `when forma_pago = '99' and pagado_en is not null then
pagado_forma`, o sea la RPC **sí** cuenta ese efectivo) ·
`src/lib/likida/cuadre/engine.ts:195-199` (`medioNoAdmitidoCombustible`
devuelve `false` para `'99'`, así que la resta vale 0) ·
`engine.ts:763-772` (`previoSinEste` → `cupoRestante` → `dentro` →
`proporcionDeducible`) · el otro lado: `src/lib/likida/fiscal.ts:524-535`
(`proporcionCombustible15` NO resta nada y sale correcto) ·
`src/lib/likida/repo.ts:995-996` (el `Gasto` que llega a `desde_db` **SÍ**
trae `pagadoEn`/`pagadoForma`, contra lo que afirma el comentario de la 0305
en sus líneas 12-16).

Norma: `normas/rfa-2026-2.9.yaml`, **`verificado_fuente_primaria`**, literal:

> «…considerarán cumplida la obligación establecida en el artículo 27,
> fracción III, segundo párrafo de la Ley del ISR, cuando los pagos por
> consumo de combustible se realicen con medios distintos a cheque nominativo
> de la cuenta del contribuyente; tarjeta de crédito, de débito o de
> servicios; o monederos electrónicos autorizados por el SAT, **siempre que
> estos no excedan el 15 por ciento del total de los pagos efectuados por
> consumo de combustible** para realizar su actividad.»

**Escenario (corrido, no razonado).** Flota `facilidad15: true`. En todo el
ejercicio 2026 el único combustible pagado con un medio que la 27-III no
admite es **un** CFDI de diésel: SubTotal $150,000, IVA $24,000,
`FormaPago '99'`, `MetodoPago PPD`, REP con `FormaDePagoP '01'` y
`pagadoEn 2026-02-15`, XML verificado, SAT vigente. Total de combustible del
ejercicio: $1,000,000 → tope 15% = **$150,000**. El efectivo es exactamente
el 15%: **no excede**, así que la facilidad aplica entera.

- `sumar_combustible_ejercicio` (0305) devuelve `efectivo = 150,000`.
- `efectivoDeEsteViaje` = **0** (`medioNoAdmitidoCombustible('99') === false`).
- `efectivoPrevEjercicio` = 150,000 − 0 = **150,000** → el propio comprobante
  ya consumió el cupo antes de evaluarse.
- `cupoRestante = max(0, 150,000 − 150,000) = 0` → `dentro = 0` →
  `excedenteDeEste = 150,000` → `proporcionDeducible = 0`.

| | motor / PDF | panel del contador y `resumen_fiscal` |
|---|---|---|
| Deducible ISR | **$0.00** | — |
| No deducible | **$150,000.00** (`efectivo_sobre_15`) | — |
| IVA acreditable | **$0.00** | **$24,000.00** |

Corrido con el motor real (`cuadrarViaje`, mismo input salvo el previo):
con `efectivoPrevEjercicio: 150000` → `{deducible: 0, noDeducible: 150000,
iva: 0}`; con el previo correcto `0` → `{deducible: 150000, noDeducible: 0,
iva: 24000}`. La diferencia entre los dos es todo el hallazgo.

**Consecuencia:** la flota pierde $150,000 de deducción (~$45,000 de ISR) y
$24,000 de IVA que la RFA 2.9 le concede, con «No deducible» impreso en rojo
en el PDF que archiva. Y vuelve la divergencia que FIS-C1 vino a cerrar: el
mismo UUID vale $0.00 en el papel y $24,000.00 en la pantalla —solo que
invertida respecto de la 25, porque el arreglo tocó la RPC y no la resta. Con
varios comprobantes '99'+REP en el mismo viaje el efecto escala: **todo** el
efectivo del viaje entra al previo y se vuelve a sumar en
`efectivoAcumuladoEjercicio`.

**Causa raíz probable:** la 0305 movió el numerador a la forma EFECTIVA y su
cabecera declara que «ese lado no se toca aquí porque `Gasto` no trae
`pagadoForma` en ese tipo» — y sí lo trae (`repo.ts:957` lo selecciona,
`:995-996` lo mapea). Ninguna prueba ata la RPC con su término de resta:
`src/lib/likida/cuadre/` no tiene un solo test de `desde_db` fuera de
`desde_db_override.test.ts`, que es de otra cosa.

---

### [ALTO, REINCIDENTE — cierre PARCIAL de FIS-P1] La póliza contable —el documento cuyo oficio ES asentar— asienta el IVA acreditable de liquidaciones que nadie ha firmado

`supabase/migrations/0307_poliza_y_viaje_respetan_rechazada.sql:119`
(`and l.revision <> 'rechazada'` — solo la rechazada) ·
`src/app/api/export/poliza/route.ts:299` (la llamada a `poliza_datos_tenant`) ·
`src/lib/likida/contabilidad/poliza.ts:175-184` (el movimiento:
`cuenta: catalogo.ivaAcreditable, cargo: REDONDEO(liq.ivaAcreditable)`) ·
contra `supabase/migrations/0308_acreditables_solo_firmadas.sql:52`
(`and revision in ('aprobada', 'ajustada')`) y
`supabase/migrations/0316_gastos_fiscales_agregados_solo_liquidacion_firmada.sql:82`
(mismo criterio) — las dos puertas que SÍ se cerraron en esta ronda.

Norma: `normas/liva-5.yaml`, **`verificado_fuente_primaria`**, art. 5, literal:

> «Artículo 5o.- **Para que sea acreditable** el impuesto al valor agregado
> **deberán reunirse los siguientes requisitos**: I. Que el impuesto al valor
> agregado corresponda a bienes, servicios o al uso o goce temporal de bienes,
> **estrictamente indispensables** […] se consideran estrictamente
> indispensables las erogaciones efectuadas por el contribuyente **que sean
> deducibles** para los fines del impuesto sobre la renta…»

Y lo que el propio repo declara sobre el mismo dato, literal
(`src/app/api/v1/openapi/route.ts:616`):

> `revision: … '`pendiente`' = nadie la ha firmado: **no la asientes**.`

La 0316 escribió el argumento correcto en su propia cabecera —«una rechazada o
pendiente no sostiene todavía el requisito de deducibilidad de LIVA 5-I»— y la
0307, del mismo bloque de arreglos, dejó `pendiente` dentro del único
consumidor que de verdad **asienta**.

**Escenario.** Ejercicio 2026. El viaje 4471 cierra con
`iva_acreditable = 16,000.00` y queda en `revision = 'pendiente'` (nadie la ha
abierto todavía; el trigger de la 0299 solo autoaprueba las que cuadran sin
diferencias). El contador entra a `/dashboard/contador`, exporta la póliza del
mes desde el mismo botón, y el archivo trae
`IVA acreditable — viaje 4471 · cargo 16,000.00` contra la cuenta del catálogo.
En la misma pantalla, la tarjeta «IVA acreditable de tus liquidaciones — LIVA
art. 5» **no** cuenta esos $16,000 (0308) y «IVA acreditable documentado»
tampoco (0316). Tres cifras sobre el mismo hecho, y la que entra al sistema
contable es la única que no se abstiene.

**Consecuencia:** el asiento se importa al ERP del cliente y de ahí sale la
declaración. Si el contralor luego rechaza esa liquidación (el motivo es
obligatorio, constraint `liquidacion_revision_motivo`), el IVA ya está
cargado y nadie lo reversa: la póliza no se regenera sola. Va en la dirección
cara —acreditar de más— con el artículo citado en el concepto del movimiento.

**Causa raíz probable:** el hallazgo de la 25 nombraba la tarjeta y la
herramienta de chat; el arreglo cerró esas dos y la 0307 se escribió desde el
hallazgo de *backend* («rechazada»), no desde el fiscal («firmada»). Dos
commits, dos criterios, sobre la misma columna.

---

### [ALTO, REINCIDENTE — cierre PARCIAL de FIS-P2] Una nota de crédito con más de un concepto sigue entrando: `TipoDeComprobante='E'` se atajó en UNA de las tres puertas de XML del intake

`src/lib/likida/processor.ts:3050-3056` (la Regla nueva de `f37172f`: rechaza
`'E'` — pero **solo** en el camino del operador con viaje abierto, y **antes**
de `esConsolidado`, `:3067`) · `processor.ts:1416` (puerta de OFICINA: va
directo a `esConsolidado`, sin mirar el tipo) · `processor.ts:1770` (puerta
de OPERADOR SIN VIAJE ABIERTO: idéntica) ·
`src/lib/likida/intake/cfdi_xml.ts:185-187` (`esConsolidado` = `lineas.length
> 1`, no mira `tipoComprobante`) ·
`src/lib/likida/intake/consolidado.ts:281` (`ligarLineaAGasto`:
`{ cfdi_uuid, cfdi_orden, xml_verificado: true }`) ·
`consolidado.ts:302` (`ocrExtra.litros = diesel.litros`).

Norma: `normas/liva-5.yaml`, **`verificado_fuente_primaria`**, art. 5 fr. I —
el acreditamiento y la deducción exigen una **erogación**; un CFDI de egreso
documenta su devolución, descuento o bonificación. Y
`normas/lif-2026-20-A.yaml`, **`verificado_fuente_primaria`**,
`estimulo_diesel_transporte.texto_vigente`, literal:

> «Se otorga un estímulo fiscal a las personas contribuyentes que importen o
> **adquieran** diésel o biodiésel y sus mezclas para su consumo final […] el
> monto que se podrá acreditar será el que resulte de multiplicar la cuota
> […] por **el número de litros importados o adquiridos**.»

Una nota de crédito documenta litros **devueltos o bonificados**, no
adquiridos.

**Escenario.** El emisor del monedero de combustible emite una **nota de
crédito consolidada** por el mes en disputa: `TipoDeComprobante="E"`, tres
conceptos ECC de $10,000.00, $8,000.00 y $6,000.00 (400 L, 320 L y 240 L),
receptor = el RFC de la flota. La oficina la reenvía por WhatsApp desde su
número (`processor.ts:1416`) —o el chofer, ya cerrado su viaje
(`processor.ts:1770`)—. `esConsolidado` dice «sí» (3 líneas > 1) y
`guardarYConciliarConsolidado` la cruza contra los tickets sin CFDI por monto
y fecha; los tres casan con los tickets originales del mes.

Resultado: los tres gastos pasan de `sin_cfdi` (**por confirmar**, ámbar,
recuperable) a `cfdi_uuid` + `xml_verificado: true`. En el siguiente cuadre el
PDF imprime **«Deducible para ISR $24,000.00»** en verde sobre tres tickets
cuyo único comprobante es un papel de EGRESO, y como `xml_verificado` es la
puerta del bloque de acreditamiento (`engine.ts`, `if (!g.xmlVerificado)
continue`), los **960 L** escritos en `ocr_extra.litros` entran a
`litrosDieselAcreditables` y salen impresos en «Diésel elegible para el
estímulo de IEPS (LIF 2026 art. 20, ap. A)» y en la tarjeta homónima del
panel. El signo es el contrario: ese papel **resta** $24,000 de deducción y
**resta** 960 L del estímulo.

**Consecuencia:** el error es de signo, así que el desplazamiento contra la
realidad es de ~$48,000 de base y 1,920 L de estímulo. Y ensucia el PDF
archivado *y* la póliza. `decidirCruce` (`sat_descarga/cruce.ts:102`) sí
aprendió la regla —ahí el arreglo quedó bien— lo que confirma que el hueco es
de cobertura, no de criterio.

**Causa raíz probable:** el hallazgo de la 25 enumeraba el camino 1:1 y el
cruce automático del buzón; el arreglo cubrió exactamente esos dos y no
preguntó cuántas puertas de XML tiene `processor.ts` (son tres) ni si el
camino del consolidado también da de alta deducibilidad (sí:
`xml_verificado: true`).

---

### [MEDIO] El PDF imprime una leyenda que cita «LIVA 5-III» y la ficha verificada de la LIVA art. 5 no transcribe ninguna fracción III

`src/lib/likida/cuadre/engine.ts:1644` (la nota que sale impresa: *«Su IVA se
acredita en ESE mes (LIVA 5-III), no en el del comprobante […] — asiéntalo en
el periodo del pago»*) · `engine.ts:1617` y `:148` (los comentarios que la
fundan) · `src/lib/likida/fiscal.ts:972-980` (la misma cita gobernando
`ivaSostenible`) · `src/lib/likida/intake/rep.ts:250` (el mensaje de WhatsApp
al operador: *«su IVA se acredita en el mes del pago (LIVA 5-III)»*) ·
`src/lib/likida/normas/por_diferencia.ts:37` ·
`src/lib/likida/normas/consulta.ts:64` (el tema `iva_acreditable` sirve
`['liva-art-5', 'lif-2026-art-20-A', 'rliva-3-fr-II']`).

Ficha: `normas/liva-5.yaml`, **`verificado_fuente_primaria`**. Su
`texto_vigente` transcribe el encabezado y **exactamente dos fracciones**:

> «Artículo 5o.- Para que sea acreditable el impuesto al valor agregado
> deberán reunirse los siguientes requisitos: **I.** Que el impuesto al valor
> agregado corresponda a bienes, servicios o al uso o goce temporal de
> bienes, estrictamente indispensables […] **II.** Que el impuesto al valor
> agregado haya sido trasladado expresamente al contribuyente y que conste
> por separado en los comprobantes fiscales…»

No hay fracción III en el corpus. Es el mismo defecto que la 25 reportó como
FIS-P5 sobre el 4º párrafo de la LIF 20-A-IV —y que esta ronda cerró
transcribiéndolo (`13a4311`)—, solo que aquí la cita **sale impresa en el
papel del contralor y en un mensaje de WhatsApp**, no solo en un comentario.

**Escenario.** CFDI de refacciones de $58,000 (SubTotal $50,000 + IVA $8,000),
`FormaPago '99'`, REP del 2026-03-04. El PDF de la liquidación de febrero
imprime la observación citando «LIVA 5-III» y difiere los $8,000 al mes de
marzo. Si el contralor le pide al agente el fundamento, `consulta.ts` le
entrega `liva-5.yaml` — donde esa fracción no existe. Por el método de este
rubro, la condición que hoy mueve $8,000 de un mes a otro queda **no
verificable en esta ronda**.

**Consecuencia:** menor en dinero (la regla es conservadora y muy
probablemente correcta), grave en trazabilidad: es la única cifra del papel
cuyo artículo citado no se puede abrir en `normas/`. El propio
`normas/README.md` lo prohíbe: *«Ninguna ficha `sin_verificar` debe sostener
una cifra que el producto imprima»* — y una fracción ausente es menos que
`sin_verificar`.

**Causa raíz probable:** la ficha se cerró el 28-jul-2026 sobre las dos
fracciones que el hallazgo de entonces necesitaba (la proporción de la fr. I);
la regla del REP entró después y nadie volvió a la ficha.

---

### [MEDIO] La cartera no puede representar la retención del 4% que el propio Likida timbra: `factura_emitida` obliga `total = subtotal + IVA`

`src/lib/likida/facturacion_escritura.ts:154`
(`const total = Math.round((subtotal + iva) * 100) / 100`) ·
`supabase/migrations/0049_cobranza_factura_emitida_pago.sql:54-55`
(`constraint factura_total_cuadra check (abs(total - (subtotal + iva)) <= 0.01)`;
la tabla no tiene columna de retenciones) · contra
`src/lib/likida/carta_porte_cfdi.ts:171-172`
(`const ret = esMoral ? dinero(sub * 0.04) : null;` /
`const total = dinero(sub + iva - (ret ?? 0));`).

Norma: `normas/rliva-3-fr-II.yaml`, **`verificado_fuente_primaria`** (la ficha
que esta misma ronda creó, `cccee88`), literal:

> «II. **La retención se hará por el 4% del valor de la contraprestación
> pagada efectivamente**, cuando reciban los servicios de autotransporte
> terrestre de bienes que sean considerados como tales en los términos de las
> leyes de la materia.»

**Escenario.** Flete de $10,000 a un cliente persona moral. El CFDI real —el
que Likida timbra por el otro camino— es: SubTotal $10,000.00, IVA $1,600.00,
**Retención $400.00**, Total **$11,200.00**. El contralor lo registra en
`/dashboard/facturacion` para cobrarlo: teclea subtotal 10,000 e IVA 1,600, y
el sistema calcula y guarda **$11,600.00**. La antigüedad de saldos y el
«total por cobrar» de `/dashboard/facturacion` quedan $400 arriba en cada
factura a persona moral, para siempre — el cliente pagará $11,200 porque los
$400 los entera él al SAT. La alternativa que el constraint deja es teclear
IVA $1,200 para que el total cuadre, y entonces la columna `iva` de la
factura miente en $400.

**Consecuencia:** sobre una flota que factura $3,000,000 al mes a clientes
morales son **$120,000 mensuales** de saldo fantasma en la cartera que el
contralor mira todos los días, y ninguna de las dos salidas que el sistema
permite es correcta. No es un caso de borde: la retención del 4% aplica a
**todo** flete a persona moral, que es el grueso del mercado.

**Causa raíz probable:** `factura_emitida` (0049) se diseñó como cuenta por
cobrar genérica, antes de que `carta_porte_cfdi.ts` timbrara retenciones; el
arreglo de FIS-P4 documentó la tasa con ficha y no revisó quién más en el
producto tiene que representarla.

---

### [BAJO, efecto lateral de FIS-P3] «Por confirmar» explica el gasto de otro ejercicio con un pie que dice dos cosas falsas sobre él

`src/lib/likida/liquidacion/deducibilidad.ts:87-94` (el pie de la cubeta:
*«Falta timbrar la factura o acreditar el medio de pago. Se puede
recuperar.»*) · `src/lib/likida/cuadre/engine.ts:351`
(`gasto_otro_ejercicio` ahora en `POR_CONFIRMAR`, el arreglo `a8f1acb`) ·
`engine.ts:977-983` (el comentario del propio bloque sigue diciendo *«Tipo
propio, en NO_DEDUCIBLE_ISR»*, que dejó de ser cierto) ·
`src/lib/likida/liquidacion/pdf.ts:355` (`filasDeducibilidad`, quien lo
dibuja).

Norma: ninguna — y ése es el punto. `src/lib/likida/normas/por_diferencia.ts:113`
declara la diferencia, literal:

> `gasto_otro_ejercicio: 'Calidad del dato: la fecha, no un veredicto de qué
> norma exacta rige el periodo fiscal.'`

El arreglo de la 25 fue correcto (sacarlo de `NO_DEDUCIBLE_ISR`), pero el pie
de la cubeta de destino no se generalizó.

**Escenario.** El CFDI del hallazgo de la 25: diésel de **$116,000** (SubTotal
$100,000 + IVA $16,000), `FormaPago '03'`, XML verificado, receptor correcto,
fechado 2025-12-30, cuadrado el 2026-02-20. El PDF ya no dice «No deducible»
—bien—: ahora dice **«Por confirmar $116,000.00 · Falta timbrar la factura o
acreditar el medio de pago. Se puede recuperar.»** La factura **está**
timbrada y el medio de pago **es** de la lista de la LISR 27-III; lo que pasa
es lo que dice la otra línea, la de la diferencia: es de otro ejercicio. El
contralor sale a pedir una factura que ya tiene.

**Consecuencia:** no mueve dinero (el peso está en la cubeta correcta), pero
la única frase que el papel da como *razón* de $116,000 es falsa en sus dos
mitades. Un rótulo tiene que ser verdad.

**Causa raíz probable:** `gasto_otro_ejercicio` es el primer miembro de
`POR_CONFIRMAR` cuyo motivo no es «falta timbrar» ni «falta acreditar el
medio»; el pie de `filasDeducibilidad` se escribió cuando la cubeta solo
tenía esos dos.

---

## Lo que revisé y está bien

**El `drop+create` de la 0317 — la pregunta que el encargo pedía verificar.**
Comparé campo por campo el cuerpo de `0317` contra `0282` (que ya incluía
`0192` y `0151`):

```
en 0282 y no en 0317: []            ← nada más se perdió
nuevas en 0317: complementoHidrocarburosFalta, consumoBar, liquidacionFirmada,
                monedaExtranjera, otroEjercicio, renglonesAjenos, rfcReceptor
```

y el `diff` del cuerpo completo solo muestra los 6 parámetros nuevos, el
`left join liquidacion`, las 7 dimensiones y los dos comentarios de
restauración. `pagado`/`pagado_forma` (0282) y el `upper(trim(...))` del
emisor (0192, `0317:189`) están de vuelta. **`a864b9d` cerró la fuga entera**;
lo que sí conviene anotar es que la **0316** también los había perdido (su
`create or replace` salió de la misma copia vieja), pero como la 0317 corre
después y los restaura, el estado final de una base migrada en orden es
correcto.

**Paridad de las 7 causas de FIS-REAUD-2, leídas contra el motor.** Las
comparé una por una:
- `moneda_extranjera`: `0317:99` vs `engine.ts:916-917` — idénticas.
- `otro_ejercicio`: `0317:150-154` vs `cuadre/fecha_dudosa.ts:97-103` —
  idénticas, incluida la tolerancia de enero.
- `renglones_ajenos`: `0317:104-124` vs `engine.ts:938-949` — mismo umbral
  (`UMBRAL_RENGLONES_AJENOS`, importado, no copiado) y misma condición
  `g.monto > 0`. SQL acepta además un `importe` que venga como *string* JSON
  donde el motor exige `number`: la divergencia va hacia **negar** el
  acreditamiento, nunca a concederlo.
- `consumo_bar`: `0317:127-132` vs `engine.ts:265`/`pareceBar`, con la
  traducción `\b → \y` en `fiscal.ts:1639` porque en el ARE de Postgres `\b`
  es BACKSPACE. Ese detalle está bien visto.
- `complemento_hidrocarburos`: `0317:138-147` replica el NIVEL 2 de
  `engine.ts:1099-1131`, y como `NORMAS['rmf-2026-2.7.1.48'].exigibleDesde`
  es `null` (`normas/indice.ts`), el veredicto duro es siempre `false` en los
  dos lados — es la abstención correcta, y `rmf-2026-2.7.1.48.yaml` sigue en
  `evidencia_corroborante`, así que no podría ser otra.
- `rfc_receptor` / `rfc_receptor_no_verificable`: `fiscal.ts:998-1015` falla
  **cerrado** donde no puede replicar la excepción del RLISR 57 (necesita el
  RFC del operador del viaje, que la vista agregada no conserva). Declarado en
  el código y correcto: nunca acredita más que el motor.

**FIS-P1 cerrado.** `0308_acreditables_solo_firmadas.sql:52` —
`revision in ('aprobada','ajustada')`— con el mismo criterio que
`?revision=firmadas` de la API. La tarjeta «IVA acreditable de tus
liquidaciones — LIVA art. 5» (`inicio-contador.tsx:443-445`), «Estímulo de
peaje 50%» (`:451`) y «Diésel elegible» (`:468`) salen todas de esa RPC.

**FIS-REAUD-1 y -2 cerrados de verdad.** `ivaSostenible`
(`fiscal.ts:938-1022`) exige liquidación firmada (`:946`) y niega las 7 causas
(`:998-1020`); la 0316/0317 le dan los campos. `resumirPerdidas` sigue viendo
todos los comprobantes (join LEFT) — la decisión de alcance está argumentada
en la cabecera de la 0316 y es correcta: un INNER habría puesto «recuperable
pidiendo factura» en cero para toda flota con viajes abiertos.

**FIS-REAUD-3 cerrado.** `combustible15SujetoADeriva` (`fiscal.ts:1152`) y sus
dos consumidores (`inicio-contador.tsx:551-559` y `mcp/herramientas/dinero.ts:183-185`)
dicen que la cifra recalcula contra el acumulado de HOY y apuntan a la cifra
archivada. Es el patrón de `derivoLaConfig`, bien trasladado.

**FIS-P3 cerrado en lo que importa.** `gasto_otro_ejercicio` salió de
`NO_DEDUCIBLE_ISR` (`engine.ts:351`) y se quedó en `SIN_IVA_ACREDITABLE`
(`:377`) — que es lo correcto por LIVA 5-I: la proporción deducible *en este
ejercicio* es cero. (El pie de la cubeta es el BAJO de arriba.)

**FIS-P4 cerrado.** Ficha nueva `normas/rliva-3-fr-II.yaml`,
**`verificado_fuente_primaria`**, transcrita del `Reg_LIVA_250914.pdf`
oficial; el comentario de `carta_porte_cfdi.ts:19-23` ya no cita la regla
3.1.2 de la RMF y distingue la **obligación** (LIVA 1-A fr. II inc. c) de la
**tasa** (RLIVA 3-II). El cálculo `esMoral ? sub * 0.04 : null` coincide con
la fracción, que solo alcanza a personas morales.

**FIS-P5 cerrado.** `normas/lif-2026-20-A.yaml:107-123` transcribe ahora el 3er
y el 4º párrafo de la fracción IV; el 4º nombra exactamente los medios que
`engine.ts:1708` exige (`MEDIOS_LISR_27_III`). La cita del código ya se puede
abrir en el corpus.

**Lo que sigue bien de antes, reverificado:** el estímulo de IEPS **nunca se
imprime en pesos** (`engine.ts`, `iepsAcreditable = 0`; litros con la
verificación de desviación 0.5×–2×, `engine.ts:1719-1729`;
`acreditable.ts:NOTA_LITROS_DIESEL`), contra
`normas/lif-2026-20-A.yaml`: *«cuota IEPS vigente al momento de la compra ×
LITROS. No es el IEPS trasladado en el CFDI.»* · la base del peaje es el
SubTotal sin IVA × 0.5 con `elegiblePeaje === true`, contra
`normas/rmf-2026-9.1.8.yaml` fr. IV, *«sin incluir el IVA, el factor de 0.5»*
· `CONDICIONES_ESTIMULO_PEAJE` (`acreditable.ts:83-93`) nombra las cuatro
condiciones de la LIF y las tres de la 9.1.8 y dice cuál cierra el motor · el
EFOS nunca se declara fraude desde `intake/sat.ts:80-84`, contra
`normas/cff-69-B.yaml` (el efecto de «sin efecto fiscal alguno» es solo del
listado DEFINITIVO) · `LECTURA_RFA_29_PRORRATEO` (`engine.ts:334-337`)
declara en el papel cuál de las dos lecturas del «siempre que» se aplicó, que
es lo que la propia ficha exige.

**Fichas que abrí, completas:** `rfa-2026-2.9`, `liva-5`, `lif-2026-20-A`,
`lisr-27-III`, `rliva-3-fr-II`, `lisr-28-V` (vía corpus), `cff-30`,
`cff-69-B`, `criterio-1-CFF-PI`, `politica-portales-plazos` (vía `TITULOS`),
`rmf-2026-9.1.8` y `rmf-2026-2.7.1.48` (vía `indice.ts`). De las 38 fichas,
**30 están en `verificado_fuente_primaria`**; 7 en `evidencia_corroborante`
y 1 (`politica-portales-plazos`, jerarquía 6) en `sin_verificar`, declarada
como política de tercero y tratada como tal (`fiscal.ts:621-626`, gravedad
`en_riesgo`, no `perdida`).

**El techo de la nota, dicho:** `normas/lisr-27-III.yaml` sigue en
`evidencia_corroborante` («NO se leyó en diputados.gob.mx… PARA CERRAR: leer
el PDF vigente»), y es la ficha detrás del veredicto rojo más frecuente del
motor (`efectivo_sobre_tope`, `medio_pago_no_admitido`) y del importe de
**$2,000**. El README lo permite («Sí, condicionado»), así que no lo levanto
como hallazgo — pero mientras esa ficha no se cierre, el ancla de 8+ («cada
cifra fiscal impresa rastrea a una ficha `verificado_fuente_primaria`») es
inalcanzable por construcción. Lo mismo con `cff-29-A` (la cita del renglón
«CFDI cancelado») y `rmf-2026-2.7.1.21`.

---

## Lo que NO alcancé a revisar

- **Nada que requiera base viva.** No hay `.env` ni Postgres: la equivalencia
  real de las RPC 0305/0307/0308/0316/0317 contra datos no se puede correr
  aquí (los bloques 123/229 de `supabase/verificaciones.sql` la miden en CI
  con Postgres efímero — y son los que atraparon la fuga de `a864b9d`, lo que
  dice que esa red sí funciona). El CRÍTICO de arriba **no** necesita base:
  se reproduce con `cuadrarViaje` puro, y así lo verifiqué.
- **`intake/desglose_peaje.ts`** (la bitácora de la RMF 9.1.8 fr. II) — la 25
  la revisó y la declaró bien; no la re-abrí.
- **`revision_recalculo.ts` / `0306_ajustar_regenera_desglose_y_pdf.sql`** — el
  recálculo tras un ajuste manual toca `iva_acreditable`; lo leí por encima y
  reusa `cuadrarViaje` (`revision_recalculo.ts:106`), así que hereda el
  CRÍTICO de arriba pero no añade uno propio que yo pudiera probar sin base.
- **El IVA de las facturas EMITIDAS más allá del total** (`factura_emitida.iva`
  no lo consume hoy ninguna cifra fiscal impresa — solo `total`, para la
  cartera). Si alguna pantalla empieza a sumarlo, el MEDIO de arriba se vuelve
  ALTO.
- **`criterios-imss-sbc`, `lss-27`, `lft-*`** — nómina y laboral; fuera del
  rubro fiscal de esta ronda.
