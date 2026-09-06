# Sistema agéntico y orquestación — auditoría 27

**Nota: 5/10** (antes 6). Razón del movimiento: **deuda que cobró factura.**
La 26 subió a 6 sobre la fuerza de ocho cierres verificados. Desde entonces
`git log a3c1560..HEAD -- src/lib/agents/ src/lib/likida/{processor,avisar_cierre,asistencia_coordinacion,comercial}.ts`
da **seis commits y ninguno de este rubro**: de los seis hallazgos que la 26
dejó abiertos, **cinco están intactos, línea por línea** —los dos ALTO
incluidos— y el único que cerró (el sondeo 0172) cerró de rebote, porque el
código se borró entero. El CRÍTICO heredado (`ingerirRep` sin reloj) sigue vivo.
Y al caminar dos ciclos que ninguna ronda había recorrido —el escalamiento de
asistencia **con su ventana horaria** y los relojes legales por incidencia—
salieron **dos ALTO nuevos de la misma familia que los viejos**: un efecto que
persiste como completo sin haberlo sido, y un texto que le llega al humano
equivocado diciendo algo que no es verdad. Una ronda sin trabajo sobre un rubro
que ya tenía dos ALTO abiertos no se queda en 6.

**El riesgo mayor hoy:** el ciclo de cierre sigue reenviando la misma
liquidación —texto Y PDF— una vez por cada mensaje que el chofer escriba
durante 24 h, y eso es lo primero que un contralor ve en el demo.

---

## Verificación de lo que venía abierto

| Hallazgo | Dónde | Veredicto hoy |
|---|---|---|
| CRÍTICO (26, rendimiento) · `ingerirRep` sin reloj | `intake/rep.ts:190-241` | **REINCIDENTE** (CRIT-1) |
| ALTO (26) · el cierre se reentrega sin techo | `processor.ts:1058-1118` · `avisar_cierre.ts:162-238` | **REINCIDENTE, sin tocar** (ALTO-1) |
| ALTO (26) · la cotización de la grúa al jefe equivocado | `asistencia_coordinacion.ts:645-666` | **REINCIDENTE, sin tocar** (ALTO-2) |
| MEDIO (26) · `ticket_soporte.vence_en` sin escritor | `comercial.ts:713-720` | **REINCIDENTE, sin tocar** (MEDIO-1) |
| MEDIO REINC. (26) · el sondeo 0172 | `instrumentation.ts` · `startup.ts` | **CERRADO** (ver abajo) |
| BAJO REINC. (24/25/26) · resumen de ráfaga por `sendText` | `processor.ts:3031` · `processor.ts:1252` | **REINCIDENTE, 4ª ronda** (BAJO-1) |
| BAJO (26) · previsualización del copiloto sin validar objetivo | `copiloto.ts:81` · `copiloto-acciones.ts:156-159` | **REINCIDENTE, sin tocar** (BAJO-2) |

**El único cierre, y lo comprobé abierto:** `verificarSondeoEscritura0172` ya no
existe en `src/` (`grep -rn "verificarSondeoEscritura0172\|__likida_probe" src/`
→ un solo hit, y es una prueba). `instrumentation.ts:26-47` ya no la importa ni
la espera, y `instrumentation.test.ts:117-136` deja el candado puesto: si
alguien vuelve a cablear un probe mutativo en `register()`, la prueba se pone
roja. Esto cierra **las dos** costuras que el hallazgo preguntaba (el `await`
que bloqueaba el arranque en frío Y la fila fantasma), porque ya no hay
escritura que fantasmear — `negocio.ts:384` sigue filtrando solo `ZZZ %` y da
igual. Cierre real, no de papel.

**Conté las funciones, como se me pidió.** El patrón que la 26 avisó vuelve a
aparecer en un sitio distinto: `avisarOficina` (`meta/aviso_oficina.ts`) se
escribió en la 24 con esta frase en su encabezado — *«Esto es ese mismo patrón
en UN solo lugar, para que los caminos escritos después no lo vuelvan a
olvidar»*. Hoy `grep -rn "avisarOficina(" src/` da **tres** llamadores
(`asistencia_wa.ts:688`, `avisar_cierre.ts:186`, `processor.ts:207`). Los demás
mensajes que Likida INICIA hacia la oficina siguen saliendo por `sendText`
crudo, sin cascada a plantilla: `relojes_legales.ts:272,277,554`,
`asistencia_coordinacion.ts:676`, y el `sendText` de tirantes del 🚨 original
(`asistencia_wa.ts:451`). Los que van por `sendButtons` (talacha, escalamiento,
cotización) no tienen esa salida por construcción y no los cuento. De los que
SÍ podían usarla, **tres de siete**. Eso alimenta directo a ALTO-4.

---

## Hallazgos

### [CRÍTICO · REINCIDENTE] `ingerirRep` sigue sin reloj y sin tope de doctos: el REP muere a la mitad, la mitad de las facturas queda sellada como pagada, y quien lo mandó no recibe una sola palabra
`src/lib/likida/intake/rep.ts:190-241` (los dos `for` anidados) · `:195`
(`rep.registrar`) · `:220` (`rep.sellar`) · `:236` (`rep.buscarGasto`).
Llamadores: `src/app/api/correo/entrante/route.ts:345`,
`src/lib/likida/processor.ts:1445`, `:1796`, `:3099`.

Lo abrí. **No cambió nada**: no hay chequeo de reloj dentro ni alrededor del
bucle, no hay tope de cardinalidad (`parseRepXml:114-147` acepta todos los
`DoctoRelacionado` que traiga el XML, y el archivo llega hasta `MAX_XML_BYTES`
= 5 MB por WhatsApp / `MAX_ADJUNTO_BYTES` = 4 MB por correo), y son **2-3
consultas secuenciales por docto**, no 2: la tercera (`rep.buscarGasto`, `:236`)
corre justo en el caso más común de una flota que aún no capturó la factura.

Escenario, con valores y desde MI rubro (el de rendimiento ya midió el reloj):
la contadora de Innovativos reenvía a su buzón el REP mensual de su cliente
grande — un XML con 150 `DoctoRelacionado`. El correo pasa los dos chequeos de
`restanteMs()` (`route.ts:298`, `:308`) en 2 s, y entra a `ingerirRep`. A los 57 s
Vercel mata la función en el docto ~95. Lo que queda:

- **En la base, medio REP aplicado.** Los doctos 1..95 tienen su fila en
  `cfdi_pago` y los que venían con `ImpSaldoInsoluto = 0` tienen su
  `gasto.pagado_en` sellado (`:220-225`). Los 96..150 no. El motor va a
  acreditar el IVA de la primera mitad y a seguir excluyendo el de la segunda
  (LIVA 5-III), sin que nada en pantalla diga que el REP se aplicó a medias.
- **Hacia el humano, silencio absoluto.** El `sendText(mensajeRepRecibido(...))`
  de los tres llamadores de WhatsApp (`processor.ts:1447`, `:1798`, y `say(...)` en `:3101`)
  está DESPUÉS del `await` que murió: nunca corre. Por correo no hay acuse
  siquiera. Quien mandó el complemento de pago no recibe ni «lo recibí» ni
  «se me trabó».
- **Y no hay progreso posible.** Los `upsert` con `ignoreDuplicates` cuestan
  una consulta cada uno aunque no inserten nada, así que cada reintento recorre
  exactamente el mismo camino y muere en el mismo docto. Por correo, el lease
  de 90 s de `reclamar_correo` (`route.ts:220-222`) libera el claim y Resend
  reintenta — y vuelve a morir; por WhatsApp lo redrena `wa-pendientes` hasta
  que la carta se declara muerta a los 5 intentos
  (`cron/wa-pendientes/drenado.ts:238-244`) y se le grita a Javier, que es el
  único que se entera.

*(Corrección a la 26, que sí verifiqué: el comentario del propio archivo
—`correo/entrante/route.ts:274-283`— sigue diciendo que el reintento «choca con
la llave primaria y sale por ya_procesado». Eso describe el mundo anterior a la
RPC `reclamar_correo` de la 0177; hoy el lease lo salva. El CFDI se sigue
perdiendo, pero por agotamiento de reintentos, no por colisión de llave. El
comentario está desactualizado y manda a razonar mal.)*

Consecuencia: el REP es el complemento que libera el IVA acreditable de todo lo
que se pagó a crédito. El contralor cierra el mes con la mitad de sus facturas
marcadas como pagadas y la otra mitad no, sin un aviso, sin un acuse, y sin
poder distinguir «el REP no llegó» de «el REP llegó y no cupo».

Causa raíz probable: el bucle se escribió para el REP de un ticket (1-3 doctos)
y nunca se le puso reloj ni tope, en dos rutas que presupuestan todo lo demás
que hacen.

---

### [ALTO · REINCIDENTE, sin tocar] El aviso de cierre al contralor se rearma completo en cada mensaje del chofer: mismo texto y misma copia del PDF, una vez por «gracias»
`src/lib/likida/processor.ts:1058-1118` (`entregarCierrePendiente`) ·
`src/lib/likida/processor.ts:2031-2039` (el llamador) ·
`src/lib/likida/avisar_cierre.ts:162-238`

Verbatim desde la 26. `avisarCierreAlJefe` no consulta ningún hecho persistido:
cada llamada vuelve a leer `resumenDeCierre` (`:162`), vuelve a mandar el texto
por `avisarOficina` (`:186`) y vuelve a mandar el `sendDocument` (`:222`). El
único freno es el sello `avisada_oficina_en`, y `processor.ts:1105` solo lo pone
si `rj.enviado && (!liq.pdfUrl || rj.pdfEnviado === true)`. El llamador está en
la rama «no hay viaje abierto» (`:2031`), o sea **cualquier texto** del chofer
dentro de las 24 h de `VENTANA_LIQUIDACION_RECIENTE_MS` (`conv.ts:244`).

Escenario, con valores: 18:02, Juan cierra `V-4412`. El contralor recibe el
texto («Liquidación LIQ-000412: requiere tu decisión…») y el `sendDocument` de
`innovativos/V-4412.pdf` se cae por un blip: `pdfEnviado = false` → no se sella.
18:07 el outbox reintenta y el PDF llega. 18:09 Juan escribe «gracias»: no tiene
viaje abierto, `avisadaOficinaEn` sigue NULL, `avisarCierreAlJefe` corre otra
vez → **segunda copia del texto y del PDF**. 18:12 «¿y mi caseta?» → tercera.

La variante permanente es la del demo: con la cuenta de Meta en modo pruebas,
un `sendDocument` a un número no listado devuelve 131030 —no reintentable— y si
la liquidación es `cuadrada` (`requiereDecision === false`, así que
`avisar_cierre.ts:185` ni siquiera manda texto y devuelve `enviado: true`),
`pdfEnviado` es `false` para siempre: cada mensaje del chofer durante 24 h
vuelve a leer `app_user`, a firmar Storage y a pegarle a la Graph API.

Consecuencia: el contralor ve su liquidación anunciada tres o cuatro veces —«se
duplicó el sistema», que es literalmente lo que `avisar_cierre.ts:145` dice que
ya pasó en producción el 24-ago y que ese archivo existe para evitar—.

Causa raíz probable: el sello es de grano grueso (cubre texto Y documento) y el
arreglo de la 25 lo condicionó al documento sin darle al texto su propia
idempotencia.

---

### [ALTO · NUEVO] Un varado reportado fuera de la ventana horaria despierta al DUEÑO el lunes con el texto de nivel 4 —«nadie ha atendido esta emergencia en ~20 minutos… si hay riesgo de vida, marca 911»— y se salta los tres niveles intermedios
`src/lib/likida/asistencia_escalamiento.ts:72-79` (`nivelObjetivo`) ·
`:243-256` (el diferimiento) · `:261` (el claim) · `:165` (el texto de nivel 4) ·
`:196` (`.lt('nivel_escalado', NIVEL_MAXIMO)`) · `:313-322` (la alerta a Javier)

`nivelObjetivo` deriva el nivel de **reloj de pared desde `abierta_en`**:
`Math.min(4, Math.floor(transcurrido / RELOJ_AMBAR_MS))`, con
`RELOJ_AMBAR_MS = 15 min`. El diferimiento por ventana horaria escribe
`notificar_desde` (`:249`) y **nada más**: esa columna solo se vuelve a leer en
`:246`, para no reescribirla. No rebasa el reloj, no lo pausa, no lo consulta al
volver. La ventana por defecto es `horaInicio 9 / horaFin 18 / diasSemana
[1..6]` (`cobranza_pura.ts:30-38`) — o sea, **la noche entera y el domingo
completo están fuera**.

Escenario, con valores: sábado 18:05, el chofer Juan escribe «me quedé varado,
se ponchó la llanta en la 57 km 120». Ámbar, prioridad `alta`. El ⚠️ síncrono
sale a Beto (encargado) y Beto no lo ve. 18:20 el cron corre:
`objetivo = floor(15/15) = 1`, no es crítica, `dentroDeVentana(18)` es `false`
(18 no es `< 18`) → **diferida**, `notificar_desde = sáb 18:20`. Domingo entero:
diferida (día 7 no está en `diasSemana`). **Lunes 09:00**: transcurrido =
38 h 55 min = 2,335 min; `floor(2335/15) = 155` → `min(4, 155) = 4`. El claim
salta de `nivel_escalado 0` directo a **4** en un solo UPDATE, y por
`objetivo >= 2` el destinatario es el DUEÑO. Lo que Luis lee el lunes a las 9 de
la mañana es, literal:

> 🚨 NADIE HA ATENDIDO ESTA EMERGENCIA en ~20 minutos: «me quedé varado, se
> ponchó la llanta…» Si hay riesgo de vida, marca 911 AHORA. Este es el último
> aviso automático — el equipo de Likida también fue alertado.

Y en paralelo `alertarOperador('asistencia.escalamiento', … codigo:
'escalada_nivel_maximo')` le entra a Javier. Después de eso la fila queda con
`nivel_escalado = 4` y el `.lt('nivel_escalado', NIVEL_MAXIMO)` de `:196` la
excluye del barrido **para siempre**: ese fue el único mensaje que esa
emergencia va a generar.

Lo que se pierde, además del susto: los niveles 1, 2 y 3 no ocurren. El nivel 3
(`:158-163`) es el que pone el **800 de siniestros de la aseguradora en la mano
de quien puede marcar** — el dato que el módulo entero existe para entregar.

Consecuencia: tres rótulos falsos en un mensaje («~20 minutos» por 39 horas,
«riesgo de vida» por una ponchadura, «nadie la ha atendido» sobre algo que se
resolvió por teléfono el sábado), un dueño despertado por la ventana horaria que
la flota configuró precisamente para no ser despertada, y una alerta de nivel
máximo a Javier que es ruido puro — la clase de alerta que enseña a ignorar las
alertas. La ventana horaria, que se puso para respetar al humano, es justo lo
que arma la bomba.

Causa raíz probable: el reloj de escalación se mide contra `abierta_en` y el
diferimiento no lo rebasa; `notificar_desde` se escribe como marca visible y
nunca se usa como origen del reloj.

---

### [ALTO · NUEVO] Los relojes legales sellan «avisado» cuando salió UNO de los dos canales: el aviso de materiales peligrosos —3 días hábiles, hasta 500 UMA de multa— se pierde para siempre y el expediente dice que se mandó
`src/lib/likida/relojes_legales.ts:269-289` (`avisarRelojesDeIncidencia`,
el `alguienRecibio` compartido) · `:272` (canal dinero) · `:277` (canal
operación) · `:283-286` (el sello) · `:203-213` (el anti-join que lo consume)

`avisarRelojesDeIncidencia` arma DOS mensajes con DOS destinatarios distintos:
`partesDinero` (la sustitución de CFDI) va a `telefonoParaDineroDe` y
`partesOperacion` (los relojes matpel, o el de multas de retén) va a
`telefonoJefeDe`. Los dos comparten **una sola bandera**, `alguienRecibio`
(`:269`), y el sello `reloj_legal_avisado` se escribe si esa bandera es `true`
(`:283`). El sello es **por incidencia**, y `avisarRelojesLegales:203-213` lo
usa como anti-join: una incidencia sellada no vuelve a mirarse jamás.

Escenario, con valores: Innovativos declaró hazmat en su perfil. El viaje
`V-4412` ya tiene su CFDI timbrado (factura `F-1180`). 03:12, el chofer reporta
«chocamos en la 150D, se volcó la pipa» → `incidencia` tipo `siniestro`. 04:00
corre el barrido:
- `partesDinero` = [`mensajeSustitucionCfdi`] → `telefonoParaDineroDe` devuelve
  el número de la contadora Ana, que escribió ayer → `sendText` acepta →
  `alguienRecibio = true`.
- `partesOperacion` = [`mensajeRelojesMatpel`] → `telefonoJefeDe` devuelve el de
  Beto (encargado), que lleva tres días sin escribirle al número de Likida →
  Meta contesta 131047, que **no** está en `CODIGOS_META_REINTENTABLES`
  (`meta/client.ts:189-191`), así que `sendText` devuelve `null`, no encola nada,
  y —a diferencia de `avisar_cierre`— este camino **no** pasa por `avisarOficina`,
  o sea que ni siquiera intenta la plantilla.
- `alguienRecibio` ya era `true` → se sella
  `anotarEventoIncidencia(… EVENTO_RELOJ, { dinero: 1, operacion: 1 })` (`:284-286`).

A las 05:00 y en todas las corridas siguientes la incidencia sale por el
anti-join. **Nadie de esa flota va a recibir nunca** el texto que dice: «SICT +
SEMARNAT: aviso en ≤3 días hábiles (RTTMRP 57 Bis; omitirlo alcanza multa de
hasta 500 UMA)» y «ASEA: informe inicial en 6 h (Tipo 3) o 12 h (Tipo 2)»
(`:88-98`). Y el `detalle` que quedó anotado cuenta lo que se ARMÓ, no lo que
salió: el expediente que el panel pinta afirma `operacion: 1`.

Que esto es un defecto y no el estilo de la casa lo prueba el **otro barrido del
mismo archivo**: `avisarVencimientos` (`:553-559`) hace `if (!enviado) { …
continue; // sin sello: se reintenta a la siguiente corrida }`, un sello por
ítem y solo tras el envío.

Consecuencia: una volcadura de pipa con material peligroso donde la flota nunca
se entera de que corre un reloj de 6 horas con ASEA y de 3 días hábiles con
SICT/SEMARNAT — 500 UMA son ~$58,655 con la UMA 2026 que el propio archivo
cita— y el expediente de esa incidencia dice que sí se avisó. Es el estado que
este rubro puntúa más bajo: la base afirma una cosa y el humano nunca supo la
otra.

Causa raíz probable: una bandera booleana única para dos canales con dos
destinatarios independientes, y un sello de grano incidencia sobre un efecto de
grano canal.

---

### [ALTO · REINCIDENTE, sin tocar] La cotización de la grúa se le manda al jefe de tráfico aunque la haya autorizado el dueño, y si no sale nadie se entera
`src/lib/likida/asistencia_coordinacion.ts:645-666` ·
`:372` (la promesa) · `:335` (`autorizada_por`) · `contactos.ts:116`

Verbatim desde la 26; lo verifiqué línea por línea y no hay un solo carácter
distinto. `iniciarContacto` guarda `autorizada_por: cuenta.userId` y le contesta
a ESE humano «te lo paso con botones». Cuando el proveedor cotiza, el
destinatario sale de `telefonoJefeDe(c.tenantId)` (`:647`) —`ORDEN_AVISO`
arranca en `encargado`—, no de `autorizada_por`. Si ese número tiene la ventana
de 24 h cerrada, `sendButtons` devuelve `null` sin encolar, `avisadoJefe` queda
`false`, al proveedor se le contesta «El jefe de tráfico le confirma
directamente en breve» (`:665`), a quien autorizó no le llega nada, al chofer
tampoco, y el expediente solo anota `cotizacion_recibida`. El único rastro es un
`logger.info` con `avisadoJefe: false` (`:661`): ni `warn`, ni `alertarOperador`
—justo lo que `asistencia_escalamiento.ts:313-322` sí hace ante CUALQUIER aviso
que no salió—.

Consecuencia: un tracto parado de madrugada con la grúa cotizada esperando un
«sí» que nadie va a dar, sobre una emergencia que la base marca como reconocida
y en gestión.

Causa raíz probable: el destinatario se resuelve por ROL por defecto en vez de
por `autorizada_por`, que la propia fila ya guarda.

---

### [MEDIO · REINCIDENTE, sin tocar] `ticket_soporte.vence_en` sigue sin escritor: `exito.soporte_sla` es insatisfacible por construcción y dos pantallas prometen un reloj que nunca corre
`src/lib/likida/comercial.ts:713-720` (`abrirTicket`, único INSERT en
`ticket_soporte` de todo `src/`) · `src/lib/likida/agentes/exito.ts:1344`,
`:1490` · `src/app/dashboard/soporte/page.tsx:188,203` ·
`src/app/admin/soporte/page.tsx:44`

Sin tocar. `abrirTicket` sigue insertando seis columnas y ni `sla_horas` ni
`vence_en`; `0051:39` las declara sin default y `grep -rn "vence_en"
supabase/migrations/` no muestra trigger ni default posterior. Con eso
`semaforoTicket` devuelve `'SIN_SLA'` para el 100 % de los tickets, `vencidos`
sale siempre vacío y `alertarOperador('exito.soporte_sla', …)` (`exito.ts:1490`)
**no puede dispararse jamás**, mientras `/dashboard/soporte:188` le promete al
cliente «Tickets, prioridad, **reloj de SLA** y la conversación con Likida».

Añado lo que la 26 no vio: `exito.ts:1379`, la línea de FUENTES del parte que se
encola a la bandeja, afirma literalmente *«ticket_soporte (estados vivos,
`vence_en` escrito al abrir)»*. Ese rótulo es falso hoy y lo lee quien va a
decidir si el parte importa.

Escenario, con valores: el contralor abre a las 09:14 «No puedo timbrar la carta
porte» con `prioridad: 'urgente'`. `vence_en` = NULL. A las 13:00 el agente
`soporte` lo cuenta en «sin SLA pactado 1», encola el parte y **no escala nada**
porque `vencidos.length === 0`. El cliente mira una columna rotulada «reloj de
SLA» que dice «sin SLA» sobre su ticket urgente.

Causa raíz probable: la 0051 razonó `vence_en` como «se escribe al abrir» y el
escritor se construyó después sin ese campo; nadie cruzó el escritor con sus
dos lectores.

---

### [MEDIO · NUEVO] En violencia en curso, el chofer recibe «Tu jefe ya lo sabe» aunque el aviso al jefe haya rebotado — el mismo archivo prohíbe esa frase en otras tres ramas
`src/lib/likida/asistencia_wa.ts:463` (`RESPUESTA_MUDA`) · `:574` (el `return`
que la usa con `avisado` en la mano, calculado en `:556` y persistido en `:567`) ·
`:661` (la misma frase en la rama de escalada) — contra `:576-581` y `:633-642`,
que sí dicen la verdad

`atenderAsistenciaChofer` calcula `avisado` (`:556`), lo persiste como
`aviso_jefe_fallido` (`:567`)… y en modo mudo devuelve `RESPUESTA_MUDA` —
«**Recibido. Tu jefe ya lo sabe.**» — sin mirarlo. La rama no-muda de tres
líneas abajo hace exactamente lo contrario y con el argumento escrito:
«Registré tu emergencia 🚨 pero NO pude avisarle a tu jefe — márcale DIRECTO
ahora mismo», y el comentario de `:634-635` lo repite: *«jamás un "ya lo sabe" sin
respaldo»*.

Escenario, con valores: 02:40, Juan escribe la palabra que `esViolencia`
reconoce → `{ nivel: 'rojo', modoMudo: true }`. `avisarAlJefe` resuelve el
número de Beto; Beto lleva días sin escribir al número de Likida, así que
`sendButtons` rebota 131047 y el `sendText` de tirantes (`:451` — este camino
tampoco pasa por `avisarOficina`) rebota igual. `avisado = false`. A Juan, que
está bajo un asalto y decidiendo si arriesgarse a hacer una llamada, se le
contesta que su jefe ya lo sabe. El reloj rojo lo reintenta a los 5 min
(`asistencia_escalamiento.ts:49`, cron `*/5`), pero en ese momento el humano ya
tomó su decisión con información falsa.

Consecuencia: la única frase que Likida le manda a alguien en peligro es la que
puede hacer que se quede quieto esperando ayuda que nadie despachó.

Causa raíz probable: se confundió «no darle detalle» (correcto: menos texto es
menos vibración) con «afirmar lo contrario». «Recibido.» a secas cumple la
regla de brevedad sin mentir.

---

### [BAJO · REINCIDENTE, 4ª ronda] El resumen de la ráfaga y el cierre por corte siguen saliendo por `sendText`: su costo de WhatsApp no se cuenta
`src/lib/likida/processor.ts:3031` (contra `:3001`, que sí usa `say` treinta
líneas arriba en el mismo bloque) · `src/lib/likida/processor.ts:1252`

Sin tocar desde la 24. `say` es «enviar + contar el costo», y el comentario de
`:2989-2994` explica por qué la foto suelta va por ahí. El resumen consolidado
—el único mensaje de un fajo de 22 fotos— y `cerrarRafagasPorCorte` —el final
NORMAL de un fajo grande— salen por `sendText` crudo, así que
`registrarCostoWhatsApp` no corre. En un negocio que cobra POR LIQUIDACIÓN, el
costo unitario se subestima justo en el camino más transitado.

---

### [BAJO · REINCIDENTE, sin tocar] La previsualización del copiloto puede prometer una acción que el ejecutor va a rechazar, y el intent se gasta igual
`src/lib/agents/copiloto.ts:81` · `src/lib/agents/copiloto-acciones.ts:156-159`

`proponer_accion` valida el `id` contra el catálogo (`:74-75`) pero toma el
`objetivo` del modelo crudo: `String(a.objetivo ?? '').slice(0, 80)`. La
validación real (`INTERRUPTORES.includes(id)`) vive solo en
`ejecutarAccionCopiloto:156-159`, y para entonces `reclamarIntent` ya gastó el
intent. Javier escribe «apaga el de cobranza», el modelo propone
`objetivo: 'cobranzas'`, la tarjeta se pinta con botón, él teclea el motivo, y
recibe un 400 con el intent ya quemado. En `gateo: 'doble'` son dos POSTs antes
de morir.

---

## Lo que revisé y está bien

- **El cierre del sondeo 0172, abierto y comprobado** (ver arriba): borrado del
  fuente y con prueba de candado en `instrumentation.test.ts:117-136`.
- **`conRelojDuro` del runner** (`agentes/runner.ts:1169-1195` + `cerrarPorRelojDuro`
  `:1204-1240`) es el mejor mecanismo de punto-de-muerte del repo: la ruta no
  espera a la vuelta sino a la CARRERA entre la vuelta y el reloj, así que un
  motor futuro que ignore su `venceEn` ya no puede robarle el latido. Cubre
  justo los cuatro que hoy se despachan **sin** pasarles `venceEn`
  (`:800` financieros, `:815` dirección, `:958` crecimiento, `:988` ingeniería):
  son cooperativamente sordos y la restricción de fuera los tapa igual.
- **La contrapresión global de la bandeja** (`runner.ts:75-129`), que la 26 dejó
  pendiente: `leerBandejaGlobalSinAtender` resuelve las dos preguntas —¿hay
  ≥40 pendientes? ¿la más vieja pasa de 7 días?— con UNA consulta ordenada y
  topada, y falla cerrado si no puede leerla. La parte pura está separada y es
  probable sin base.
- **El drenado del outbox de WhatsApp** (`api/cron/wa-outbox/route.ts`): el kill
  switch va ANTES de reclamar (un lease tomado con el sistema apagado
  secuestraría la salida), el canal se comprueba antes de quemar un intento por
  fila, un 200 sin `wamid` NO se marca `sent` sino `dead` con alerta, y el peor
  caso del pool cabe (`reclamarSalidasWhatsApp` limita a 25, pool de 4, 10 s por
  POST → ~70 s contra `maxDuration = 300`).
- **`enviarPiezaPorCorreo`** (`agentes/cola.ts:472-520`): claim → proveedor →
  prueba, con compensación que revierte `enviado_en` y deja `envio_error`
  visible, y la ventana honesta (muerte entre envío y prueba = «enviada sin
  provider id») declarada en el encabezado en vez de escondida.
- **El ciclo del analista del panel** (`agents/analista.ts:307-518` +
  `api/dashboard/chat/route.ts`): gate por `puedeVerArea(rol,'dinero')` antes de
  gastar un token, tope diario que falla cerrado, el canal lateral `CAPTURAS` se
  borra tanto en el reintento (`:422`) como en el `finally` (`:517`), el costo
  del turno que truena se registra desde `PartialExecutionError`, y la última red
  es determinística (tabla con lo que las tools leyeron) en vez de una disculpa.
- **`decidirCotizacion`** (`asistencia_coordinacion.ts:386-500`): candado de
  emergencia viva antes de firmar, claim atómico `.eq('estado','cotizada')` con
  exactamente un ganador, relectura honesta para el perdedor, y la respuesta al
  jefe enumera pata por pata lo que de verdad salió («NO le pude avisar al
  proveedor — márcale tú»). Es el contraejemplo exacto de ALTO-2, en el mismo
  archivo.
- **El ciclo de soporte** (`likida/soporte.ts` completo): `getHilo` filtra
  `interna` EN LA CONSULTA, la flota no puede fabricar notas del equipo, los dos
  lados del constraint `ticket_cierre_coherente` se escriben juntos, y el fallo
  de `anotarBitacora` sube como booleano hasta la pantalla. Y los dos server
  actions no prometen de más: `/admin/soporte:130` dice «el cliente la ve en su
  panel de Soporte», no «se le notificó».
- **El barrido de vencimientos** (`relojes_legales.ts:529-566`): sella por ítem
  y solo después de que Meta aceptó. Es la referencia contra la que ALTO-4 se
  lee como defecto.
- **`avisarOficina`** (`meta/aviso_oficina.ts`) hace exactamente lo que promete:
  texto → plantilla solo ante los tres códigos de ventana, `fueraDeVentana`
  viaja al llamador para que no diga «ya se la pasé», y fail-closed si la
  plantilla no está aprobada. El problema es cuántos lo llaman, no cómo está
  escrito.

## Lo que NO alcancé a revisar

- **`copiloto-tools.ts` (412 líneas de tools cross-tenant) y
  `copiloto-historial.ts`.** Segunda ronda que quedan fuera; solo recorrí el
  orquestador, el catálogo de acciones y el ejecutor.
- **`agentes/notificaciones.ts` completo** (1,300+ líneas: `repartoDe`,
  anti-ruido, rachas, `magnitud_avisada`). Solo miré el sello `avisado_en`
  (`:841-843`) de lejos. Tercera ronda pendiente.
- **`asistencia_camara.ts`, `carta_porte_wa.ts` y `admin_comandos_wa.ts`**: los
  abrí solo para contar sus salidas a `telefonoJefeDe`. Sus ciclos completos
  —qué pasa si mueren a la mitad— no los caminé.
- **Los 45 motores de agente** (`agentes/{backoffice,direccion,crecimiento,
  ingenieria,exito,leads,finanzas}.ts`, ~500 KB): audité el DESPACHO, no lo que
  cada motor hace adentro con su `venceEn`.
- **La ráfaga bajo concurrencia real** (`conv.ts` mutex + barrera): reusé la
  verificación de la 26 en vez de rehacerla; no la volví a leer entera.
- **No corrí la suite.** Todo lo de arriba es lectura del fuente, de las
  migraciones y de `git log`/`git show`; los conteos salen de `grep`, no de una
  corrida. La línea base de la compuerta es la del MAPA.
