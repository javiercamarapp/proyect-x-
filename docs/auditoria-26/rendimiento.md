# Rendimiento y costo — auditoría 26

**Nota: 6/10** (antes 5). Razón del movimiento: **la deuda de la 25 se pagó de
verdad, y con fórmula en vez de número a mano.** Seis de los nueve abiertos
cerraron con la cuenta atada al fuente (`PASOS_CIERRE` en 20 con una prueba que
LEE `processor.ts`; `PRESUPUESTO_MS` de la ruta de QA derivado de
`4 × TIMEOUT_LLM_MS`; `LIQUIDACION_USD` a $0.18 medido y propagado al techo
diario). El costo por operación ya está MEDIDO y las dos cifras que la nota
anterior señalaba como contradictorias hoy concuerdan. Lo que impide subir más:
apareció un **N+1 sin reloj en el camino del webhook** —la misma clase de fallo
que define este rubro— y tres de los cierres son parciales porque el reloj vigila
el ARRANQUE de un eslabón y no su DURACIÓN.

**El riesgo mayor hoy:** `ingerirRep` recorre dos consultas por DoctoRelacionado
sin mirar el reloj ni una vez; ~96 doctos agotan los 57 s del correo entrante y
~134 los 80.4 s utilizables del webhook — y en el correo la muerte deja la fila de
dedup puesta, así que el reintento de Resend rebota por «ya procesado» y el CFDI
se pierde para siempre, en silencio.

---

## Verificación de los abiertos de la 25 (el número contra el número)

| # | Veredicto | La cuenta |
|---|---|---|
| REND-A1 voz por byte | **CERRADO** | `openrouter.ts:525-529`: se estima por duración (16 kbps piso, 100 tok/s). 1.24 MB de base64 → 930 KB → 465 s → 46,500 tokens de reserva, no 1,240,000. Ya no toca el tope de $0.50. |
| REND-A2 `PASOS_CIERRE` | **CERRADO** | Medido en ejecución: `PASOS_CIERRE.length = 20`, `COSTO_CIERRE_MS = 14,600`, `MARGEN_CIERRE_MS = 39,600`. Y `presupuesto.test.ts:164` cuenta los `sellarEntregaLiquidacion(op.tenantId, liqIdCerrada, …)` en el FUENTE de `processor.ts` — el guardarraíl vigila los dos archivos, no uno. |
| REND-A3 `ingerir` sin reloj | **PARCIAL** | El `for` sí mira el reloj (`ciclo.ts:277`). Pero el margen que lo respalda son 20 s y una sola vuelta cuesta hasta ~38 s. Ver hallazgo 2. |
| REND-A4 costo por liquidación | **CERRADO Y CONCORDANTE** | `models.ts:270` = $0.18; la derivación escrita (72,000 × $2/1e6 = $0.144 bruto − $0.0197 de caché = $0.125 + 600 × 8 × $10/1e6 = $0.048 → $0.173) cuadra con la medición citada en `openrouter.ts:960-964`. Y CAP-1 lo propaga: `budget.ts:229` da 500 × $0.1848 × 1.5 = **$138.60**, no el $60 a mano. Las dos cifras concuerdan entre sí y con la medición. |
| REND-A5 `.limit(5000)` | **REINCIDENTE (residual)** | Queda uno: `peaje_cierre.ts:243`. Ver hallazgo 4. |
| REND-A6 QA OCR | **CERRADO** | `route.ts:80`: 300,000 − 4×30,000 − 10,000 = **170,000 ms** de presupuesto. La última foto arranca a 170 s, en su peor caso termina a 290 s y quedan 10 s para escribir: cabe exacto en `maxDuration = 300`. |
| REND-A7 `traerTodo` | **PARCIAL** | El commit tocó 6 consultas (4 de `mantenimiento.ts`, 2 de `mesa_control.ts`). Ver hallazgo 5. |
| REND-A8 piloto de visión | **PARCIAL** | El reloj existe (`piloto_vision.ts:267`) pero mide el arranque del paso, no su duración. Ver hallazgo 3. |
| REND-A9 foto a resolución nativa | **CERRADO** | `ocr.ts:403-409` redimensiona a 1600 px antes de `images: [principal]`. Único otro sitio con `images:` es `piloto_vision.ts:598`, que manda una captura de navegador (ya acotada). Ver nota BAJO. |

---

## Hallazgos

### [CRÍTICO] `ingerirRep` hace 2 consultas por DoctoRelacionado y NUNCA mira el reloj — en el webhook y en el correo entrante

`src/lib/likida/intake/rep.ts:190-192` (los dos `for` anidados), `:205`
(`rep.registrar`), `:225` (`rep.sellar`). Llamadores:
`src/lib/likida/processor.ts:1410`, `:1757`, `:3029` y
`src/app/api/correo/entrante/route.ts:345`.

**Números:**

- Cada `DoctoRelacionado` cuesta **2 consultas secuenciales**: el `upsert` a
  `cfdi_pago` (`:195-205`) y el `update` a `gasto` (`:220-225`). Ninguna de las
  dos está en lote; la segunda solo se salta cuando el docto va en parcialidad.
- Costo unitario de una consulta según la contabilidad del propio repo
  (`presupuesto.ts:37`): **0.3 s**. Techo duro de una: `TECHO_PASO_CONSULTA_MS`
  = **9.5 s**.
- **Webhook** (`maxDuration = 120`): lo utilizable para trabajo nuevo son
  `120,000 − MARGEN_CIERRE_MS(39,600)` = **80,400 ms** (medido en ejecución).
  80,400 / (2 × 300) = **134 doctos** agotan la invocación entera.
- **Correo entrante** (`maxDuration = 60`, `route.ts:284-285`): el presupuesto
  es `60,000 − 3,000` = **57,000 ms**. 57,000 / 600 = **95 doctos**.
- No hay tope de doctos: `parseRepXml` (`rep.ts:114-147`) los acepta todos, y el
  archivo cabe hasta `MAX_XML_BYTES` = 5 MB por WhatsApp y `MAX_ADJUNTO_BYTES` =
  4 MB por correo — del orden de **6,900 doctos** a ~600 B por nodo. El peor caso
  no es 134: es 6,900 doctos × 0.6 s = **4,140 s contra 60**.
- El reloj del correo (`restanteMs()`, `route.ts:287`) se consulta dos veces —
  antes de pedir la URL firmada y antes de bajar el binario— y **nunca** dentro
  ni alrededor de `ingerirRep`, que es la única llamada del bucle cuyo costo no
  está acotado.

**Escenario:** el contador de una flota reenvía por correo el REP mensual de su
cliente grande — un solo XML que ampara 150 facturas. La descarga pasa los dos
chequeos de reloj en 2 s. `ingerirRep` arranca 300 consultas; a los 57 s Vercel
mata la función a media lista.

**Consecuencia:** la ruta ya documenta su propio desenlace
(`correo/entrante/route.ts:274-283`): al morir NO corre el `delete` que libera la
fila de dedup, **el correo queda marcado como procesado sin haberlo sido**, el
reintento de Resend choca con la llave primaria, sale por `ya_procesado` y el
CFDI se pierde para siempre. Y no hay progreso posible: los `upsert` con
`ignoreDuplicates` siguen costando una consulta cada uno, así que un reenvío
recorre exactamente el mismo camino y muere en el mismo punto. Por WhatsApp el
final es el gemelo conocido: Meta ya recibió su 200, no reintenta, y el operador
nunca recibe `mensajeRepRecibido`. El REP es el complemento que libera el IVA
acreditable — el contralor cierra el mes con IVA que sí pagó y no puede acreditar.

**Causa raíz probable:** el bucle se escribió pensando en el REP de un ticket
(1-3 doctos) y nunca se le puso ni tope de cardinalidad ni reloj, en dos rutas
que sí presupuestan todo lo demás que hacen.

---

### [ALTO] El margen del cron del SAT (20 s) es la mitad de lo que cuesta UNA vuelta de sus dos bucles

`src/app/api/cron/descarga-sat/route.ts:82-83` (`MARGEN_MS = 20_000`,
`venceEn = inicio + 280 s`), consumido por
`src/lib/likida/sat_descarga/ciclo.ts:277` y
`src/lib/likida/sat_descarga/peaje_cierre.ts:318`.

**Números:** el reloj corta **antes** de empezar una vuelta, así que el margen
tiene que cubrir el peor caso de UNA vuelta completa.

- `ingerir`, camino `casado` (`ciclo.ts:297-341`): `sat_descarga.sello` +
  `ligar` + `saveCfdiXmlRaw` + `marcar` = 4 consultas envueltas en `acotada`, a
  `TECHO_PASO_CONSULTA_MS` = 9.5 s cada una → **38 s**.
- `avisarCierrePeaje`, una flota (`peaje_cierre.ts:349`, `:365`, `:376`, `:387`):
  `peaje_cierre.reservar` (9.5) + `telefonoParaDineroDe` (9.5) +
  `sendText` (`TECHO_ENVIO_WHATSAPP_MS` = 10) + `soltarReserva` (9.5) =
  **38.5 s**.
- El chequeo pasa a los 279.999 s → la vuelta termina a **~318 s** contra un
  `maxDuration` de **300**. Faltan 18.5 s, y el margen escrito es 20.
- Las dos fases comparten el MISMO `venceEn` a propósito (`route.ts:94` y `:101`),
  así que el desbordamiento de la primera se hereda entero a la segunda.

**Escenario:** un blip de Supabase que no tira la conexión, solo la vuelve lenta.
La última flota del barrido de peaje entra a las 279.9 s, su `reservar` tarda
9 s, su `sendText` 10 s, y Vercel corta antes del `soltarReserva`.

**Consecuencia:** exactamente lo que el margen existía para impedir. El sello
`peaje_cierre_aviso` queda tomado y no soltado (`:387` no llega a correr), así
que esa flota **nunca** recibe el aviso de ese umbral — y el umbral es un día
exacto que no vuelve (`umbralDeHoy`, `:91-96`): el derecho a facturar sus casetas
del mes se extingue. Encima, muerta la función, no se escribe `registrarLatido`
y el tablero no enseña nada: el modo de falla es el mudo, el mismo que los
comentarios de `route.ts:71-81` dicen estar arreglando.

**Causa raíz probable:** el margen se dimensionó contra el costo NOMINAL de una
vuelta (~1-2 s) y no contra los techos que el propio repo impone
(`TOPE_CONSULTA_MS` + gracia, `SEND_TIMEOUT_MS`) — la misma corrección que la
auditoría 21 ya hizo en `MARGEN_CIERRE_MS` y que no se propagó a este cron.

---

### [ALTO · REINCIDENTE] REND-A8: el reloj del piloto de visión vigila el arranque del paso, no su duración — la cadena suma 400 s contra 300

`src/lib/likida/facturacion/adaptadores/piloto_vision.ts:261` y `:267`
(`PRESUPUESTO_SESION_MS = 130_000`), contra
`src/app/api/cron/facturar/lote.ts:80` (`MARGEN_LOTE_MS = 150_000`) y
`src/app/api/cron/facturar/route.ts:32` (`maxDuration = 300`).

**Números:** el arreglo bajó el peor caso con un presupuesto propio de 130 s
dentro de los 150 s que el lote promete — 20 s de holgura. Pero el paso que ese
guardia deja entrar no está acotado:

- `decidir()` (`:592-602`) llama `generateStructured` **sin `signal`**. Su
  escalera es intento + reintento por truncamiento + reintento con nota +
  fallback cross-provider (`openrouter.ts:736-770`) = **4 × TIMEOUT_LLM_MS
  (30 s)** = **120 s**. Es el mismo `4 × 30` que REND-A6 usó para dimensionar la
  ruta de QA, o sea que el repo ya lo tiene por escrito.
- El guardia pasa a los 129.999 s → la sesión termina a **~250 s** contra los
  **150 s** que el lote le promete. Sobra 100 s, cinco veces la holgura.
- Y el lote abre esa sesión hasta el instante `inicioLote + 149.999 s`
  (`lote.ts:453`): **149.999 + 250 = ~400 s contra `maxDuration = 300`**.

**Escenario:** OpenRouter degradado (429 del proveedor primario). Una flota con
un portal lento entra al último hueco del lote; su paso 9 se va por la escalera
completa.

**Consecuencia:** Vercel mata el cron de facturación a los 300 s con el navegador
abierto. Los renglones ya resueltos de las flotas anteriores no llegan al
`resumen`, no se escribe el latido, y el panel de facturación no dice ni que
corrió ni que falló. Los tickets de las flotas que faltaban quedan sin marcar
—eso sí está bien resuelto— pero la corrida siguiente empieza igual de ciega.

**Causa raíz probable:** el arreglo trató el síntoma (no arrancar tarde) sin
tocar la causa (una llamada al proveedor sin `signal` dentro de una función con
`maxDuration`); es el mismo patrón que REND-A6 corrigió en la ruta de QA
reservando el peor caso de UNA unidad, y que aquí no se reservó.

---

### [MEDIO · REINCIDENTE] REND-A5 residual: `.limit(5000)` que PostgREST corta en 1,000, con un detector de truncamiento que no puede dispararse nunca

`src/lib/likida/sat_descarga/peaje_cierre.ts:243` (`.limit(TOPE_GASTOS_PEAJE)`,
`TOPE_GASTOS_PEAJE = 5_000` en `:56`) y `:252` (`const truncado = (gastos ??
[]).length >= TOPE_GASTOS_PEAJE`).

**Números:** `supabase/config.toml:38` fija `max_rows = 1000`, el mismo recorte
que `pg.ts:38-45` documenta para producción. Entonces:

- La consulta pide 5,000 y **jamás recibe más de 1,000**.
- `truncado` compara contra 5,000 → es **falso por construcción**: la condición
  `1000 >= 5000` no se cumple nunca. La alarma que se puso como mitigación es
  insatisfacible, igual que lo era la de «ticket sin respuesta» antes de la 0268.
- El comentario del propio archivo (`:247-251`) calcula el punto de dolor con el
  número equivocado: dice «a 200 flotas con casetas diarias los 5,000 cruces del
  mes se agotan». Con el recorte real de 1,000 y esos mismos ~25 cruces por
  flota al mes, el barrido deja de ver flotas a partir de la **número 40**, no
  de la 200 — **5× antes** de lo que el archivo cree.
- `resumen.gastos` reporta `1000` como si fuera el universo. Es la cifra que un
  tablero lee «todo bien».
- La prueba que respalda el detector (`peaje_cierre.test.ts:413-419`) fabrica
  5,000 filas desde un mock: verifica una rama que la base real no puede
  producir. Está verde sobre nada.

**Escenario:** Likida llega a 40 flotas con casetas. El día 24 del mes corre el
barrido, lee 1,000 gastos ordenados por `tenant_id`, avisa a las primeras ~40 y
reporta `truncado: false`, `gastos: 1000`, latido verde.

**Consecuencia:** las flotas del final del orden por `tenant_id` no reciben el
aviso de que se les vence el derecho a facturar sus casetas, y nada —ni el log,
ni el resumen, ni el latido— lo dice. El síntoma que llegaría meses después es
«a mi flota nunca le avisan», y no habría nada apuntando aquí.

**Causa raíz probable:** el arreglo migró los `.limit(5000)` cross-tenant a
`traerTodo` pero dejó éste, y en su lugar puso un detector calibrado contra el
límite PEDIDO en vez de contra el límite APLICADO. El vecino lo hace bien:
`bandeja.ts` declara truncamiento comparando contra el `count` exacto de
PostgREST, no contra su propio `.limit()`.

---

### [MEDIO · REINCIDENTE] REND-A7 parcial: un `traerTodo` sigue sin desempate único, y ~22 llamadores siguen sin `conteo()`

`src/lib/likida/asistencia_escalamiento.ts:188-198` — `.order('abierta_en',
{ ascending: true })` como orden ÚNICO y `.select()` **sin `conteo()`**.

**Números:** el commit `aa4ac6f` arregló 6 consultas (las 4 de `getTaller` en
`mantenimiento.ts` y las 2 de `listarMesaAsistencia` en `mesa_control.ts`).
Barrido completo de los ~110 sitios de llamada de `traerTodo` hoy:

- **1 caller sin desempate único Y sin `conteo()`** a la vez: el de arriba. Es la
  combinación que el contrato de `pg.ts:132-135` prohíbe explícitamente («la
  consulta tiene que venir ordenada por algo ÚNICO») más la que apaga la única
  red que quedaba: sin `count`, `traerTodo` cae a la prueba de la página vacía
  (`pg.ts:206-209`), que un salto de fila por empate satisface igual de bien que
  una lectura completa.
- **~22 callers sin `conteo()`**: `comercial.ts` (406, 412, 450, 492),
  `importar_viajes.ts` (289, 328, 364), `agentes/ingenieria_producto.ts` (652,
  669, 689, 820, 978, 1002), `agentes/backoffice.ts` (433, 458),
  `agentes/insumos.ts:134`, `contactos.ts` (196, 202), `oficina_wa.ts:119`,
  `crear_viaje_wa.ts:824`. Cada uno paga **un viaje de red extra** (la página
  vacía que demuestra el final) por lectura. Son correctos, pero es el costo que
  el propio contrato dice que se paga por no pedir el `count`.
- El resto de los órdenes «sospechosos» que revisé SÍ son únicos y quedan
  descartados: `numero_economico` (`unidad_economico_unico`, 0047:51), `nombre`
  de cliente (`cliente_nombre_unico`, 0048:87), `nombre` de rutina
  (`rutina_mantenimiento_nombre_unico`, 0209:87), `(factura_id, viaje_id)`,
  `(unidad_id, dia)`.

**Escenario:** `incidencia` acumula más de 1,000 filas abiertas y sin reconocer
(`PAGINA` = 1,000). Dos incidencias abiertas en el mismo `abierta_en` —dos botones
de pánico en la misma ráfaga, o un alta por lote— caen a caballo de la frontera de
página; `range()` por posición devuelve una dos veces y se salta la otra, y sin
`count` `LecturaIncompleta` no se dispara.

**Consecuencia:** una incidencia de asistencia en carretera —la tabla filtra por
`hay_lesionados` entre otras— nunca entra a `escalarAsistenciasPendientes` y no
se escala a ningún nivel. El resultado del cron reporta el mismo número de
`revisadas` sin señal de que faltó una.

**Causa raíz probable:** el arreglo se aplicó a los dos archivos que el hallazgo
enumeraba, no a la pregunta que el hallazgo hacía; es literalmente el sesgo que
el MAPA de esta ronda pide corregir.

---

### [MEDIO] La imagen del piloto de facturación va al modelo sin acotar, en el único otro sitio con `images:` del repo

`src/lib/likida/facturacion/adaptadores/piloto_vision.ts:598` —
`images: captura?.startsWith('data:') ? [captura] : [await comoDataUri(captura)]`.

**Números:** hay exactamente **dos** sitios con `images:` en todo `src/`
(`ocr.ts:417` y éste). El primero ya se acota a 1600 px desde REND-A9; éste manda
la captura de `capturaSegura(pagina)` tal cual, y **la manda hasta 14 veces por
sesión** (`PASOS_MAXIMOS = 14`, `:101`), cada una de ellas con la escalera de
reintentos de `generateStructured` encima (hasta 4 envíos del mismo cuerpo). Peor
caso por sesión: **56 subidas de la captura completa**. La reserva de presupuesto
la cuenta a `TOKENS_POR_IMAGEN` = 4,000 (`openrouter.ts:503`), o sea que el
tamaño real del PNG/JPEG no se refleja en ningún tope ni en ningún log — solo en
el tiempo de subida, que es justo el que el hallazgo 3 dice que no cabe.

**Escenario:** un portal con una página larga produce una captura de varios MB;
cada paso la vuelve a subir entera.

**Consecuencia:** el ancho de banda de la sesión, que es lo que decide si los
130 s del piloto alcanzan, depende de un número que nadie mide ni acota. Suma
directamente al hallazgo 3.

**Causa raíz probable:** REND-A9 se cerró sobre el sitio que el hallazgo nombraba
(`ocr.ts`) sin barrer el otro consumidor de `images:`.

---

### [BAJO] REND-A9 redimensiona por tercera vez en vez de reusar el buffer que el hallazgo decía que ya existía

`src/lib/likida/intake/ocr.ts:405` (`redimensionarParaVision`) contra
`src/lib/likida/intake/cfdi_imagen.ts:115` (el `for (const ancho of
[ANCHO_PRINCIPAL_PX, 1000])` de `decodeCodigosFromImage`).

**Números:** por foto principal se corren ahora **3 pasadas de `sharp`** sobre el
original: 1600 px y 1000 px dentro de `decodeCodigosFromImage` (`:115`), más
1600 px otra vez en `redimensionarParaVision` (`:145`). Los dos primeros
resultados se descartan. Sobre un original de 4032×3024 cada pasada
(`rotate().resize().jpeg()`) es del orden de 150-400 ms de CPU; la tercera es
**~0.15-0.4 s de trabajo idéntico y redundante por comprobante**, dentro de una
invocación de 120 s en la que sólo 80.4 s son utilizables.

**Escenario:** un fajo de 8 fotos en una ráfaga; el decodificado corre en
paralelo (`ocr.ts:389`) pero la tercera pasada corre otra vez, en serie, sobre la
principal.

**Consecuencia:** menor — pero el hallazgo original decía exactamente «el repo ya
calculó la de 1600 px dos líneas antes», y la mitad del hallazgo que era «ya está
calculado, reúsalo» no se cerró: se cerró la mitad de los bytes en el cuerpo JSON.

**Causa raíz probable:** exponer la función fue más barato que devolver el buffer
desde `decodeCodigosFromImage`, y el ahorro de bytes (el efecto grande) tapó el
de CPU (el que el hallazgo nombraba).

---

## Lo que revisé y está bien

- **La contabilidad del cierre.** Verificada en ejecución, no leída: 20 pasos,
  `COSTO_CIERRE_MS = 14,600`, `MARGEN_CIERRE_MS = 39,600`,
  `MARGEN_CIERRE_CRITICO_MS = 29,500`, `TECHO_CIERRE_MS = 192,500` (que
  deliberadamente NO cabe en 120,000 — y por eso existe `margenDuro()`).
  `presupuesto.test.ts` ata cada número a un fuente real: `SEND_TIMEOUT_MS` se
  lee de `meta/client.ts`, el `maxDuration` del `route.ts`, los envíos de
  `avisar_cierre.ts` y los sellos de `processor.ts` por regex sobre el archivo.
  Es el mejor guardarraíl de tiempo del repo.
- **El costo por operación, medido y propagado.** `LIQUIDACION_USD = $0.18`
  reconstruye la medición citada ($0.144 bruto → $0.125 neto + $0.048 de salida
  = $0.173) y de ahí sale, sin número a mano en medio,
  `viajeCompleto = $0.1848` → `techoDerivadoPorDefectoUsd() = $138.60` →
  `topeDerivadoDelPlan`. Las dos cifras que la nota anterior señalaba como
  contradictorias hoy concuerdan. Y `costoReal()` prefiere el `cost` que reporta
  OpenRouter sobre `calcCost`, que es lo único que deja ver el 92 % que ahorra la
  caché de prompt.
- **La reserva de presupuesto ya no cobra por byte.** Ni imagen
  (`TOKENS_POR_IMAGEN`) ni audio (`tokensPorAudioBase64`). El texto sigue a un
  token por carácter, ~4× de más, pero es una cota declarada que `settle`
  corrige al costo real (`budget.ts:456`), y con el peor round medido
  (~21,200 tokens de entrada) la reserva de una vuelta da ~$0.21 contra
  `maxRunUsd` = $0.50: cabe.
- **Las rutas con OCR sí presupuestan.** `/api/dashboard/ingesta` corta a 45 s
  contra `maxDuration = 60`; el processor pasa `reloj.senal(25_000)` a las dos
  llamadas de `extraerComprobante` (`:1817`, `:2250`). La señal cubre la escalera
  entera porque es un plazo único, no uno por intento.
- **`traerTodo` / `traerPorIds` como contrato.** Cursor por filas leídas (no por
  número de página), fail-closed con `LecturaIncompleta`, y `IDS_POR_TANDA = 200`
  con 5 tandas en paralelo para no tocar ni `max_rows` ni el techo de URL del
  proxy. `.limit(5000)` cross-tenant quedó solo uno (hallazgo 4); el resto de los
  `.limit()` del repo resuelven a constantes ≤ 500.
- **N+1 buscados y no encontrados donde importa.** Barrí `src/` por `await` de
  consulta dentro de bucle: los 35 candidatos son casi todos tandas explícitas
  (`IDS_POR_TANDA`, `enTandas`, `enLotes(…, 10)`) o bucles acotados por
  constantes pequeñas. `repo.ts` está limpio. Las excepciones reales son
  `intake/rep.ts` (hallazgo 1) y, en el panel de admin, `qa-motor.ts:376`
  (`select('*')` por tabla sin `.limit()` — fuera del camino del cliente).
- **`/api/admin/qa/fotos/ocr`** ya no es un número fijo: `PRESUPUESTO_MS` se
  deriva de `maxDuration − 4×TIMEOUT_LLM_MS − 10 s`, así que mover
  `TIMEOUT_LLM_MS` mueve el presupuesto solo.

## Lo que NO alcancé a revisar

- **La latencia real Vercel ↔ Supabase.** Todas las sumas de arriba usan los
  techos escritos en el repo (`TOPE_CONSULTA_MS` = 8 s + 1.5 de gracia,
  `SEND_TIMEOUT_MS` = 10 s) porque no hay base ni red en esta ronda. Si el p99
  real fuera peor, los hallazgos 2 y 3 empeoran; si fuera mucho mejor, siguen
  siendo ciertos como peor caso pero menos probables.
- **El tamaño real de la captura del piloto** (hallazgo 6): `capturaSegura`
  depende de Playwright y del portal; no pude medir bytes sin navegador.
- **`guardarYConciliarConsolidado` a escala.** Está batcheado en lotes de 10
  (`consolidado.ts:477`) y no consulta el reloj; el propio archivo dice que un
  consolidado mensual de una flota de 500 viajes/día trae «MILES de líneas». No
  pude fijar cuántas consultas cuesta `ligarLineaAGasto` por línea, así que no
  puedo escribir la suma y no lo reporto.
- **Costo por operación de los agentes de fondo** (`agentes/*.ts`, propósito
  `back_office`): sólo verifiqué que `corridaAgenteSinMedir` los cobre al alza.
  No medí cuánto gastan de verdad ni contra qué techo.
- **El peor caso de una liquidación con muchos más de 21 comprobantes.** La
  medición del repo cubre 21; el costo del cuadre escala con los comprobantes
  (`openrouter.ts:960-964`) y la reserva por ronda también, pero sin una medición
  de un caso grande no puedo decir a partir de cuántos comprobantes la reserva
  toca los $0.50 de `maxRunUsd`.
