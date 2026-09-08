# Sistema agéntico y orquestación — auditoría 29

**Nota: 7/10** (antes 4). Razón del movimiento: **se atacó y subió.** Es el
resultado que el MAPA anticipó como posible y que aquí se cumple con evidencia:
abrí los doce hallazgos que la 28 dejó abiertos, uno por uno, en el fuente y en
su prueba, y **once están cerrados de verdad** — el arreglo se puede revertir y
la prueba se pone roja. Incluye el CRÍTICO que llevaba dos rondas sin recibir
una línea (`ingerirRep` sin reloj). Lo que impide llegar a 8 es que **uno de los
doce está MUTADO**: `escalado` sigue sin re-armar su filo en el único caso que
de verdad ocurre —que el problema se resuelva—, y la pantalla del cliente sigue
prometiendo por escrito lo contrario. Ese es el único sitio donde hoy la base
dice una cosa y el usuario cree otra; en la 28 había nueve.

**El riesgo mayor del rubro hoy:** el aviso «el agente escaló un caso» se apaga
para siempre en cuanto una flota vuelve a la normalidad, porque el cierre del
incidente solo se emite cuando la flota tuvo candidatos Y la base falló al
escribir el claim — o sea, casi nunca.

---

## Estado de los hallazgos abiertos de la 28

Los IDs de la 28 vienen del MAPA de esta ronda; **`AG-A4` aparece citado por dos
commits distintos** (`662518b` y `0688735`), así que los nombro además por su
descripción para que no haya duda de cuál verifiqué.

| Hallazgo de la 28 | Dónde lo verifiqué hoy | Veredicto |
|---|---|---|
| **AG-C1** (CRÍTICO, 3ª ronda) · `ingerirRep` sin reloj ni tope | `intake/rep.ts:199,207-214` · `intake/rep.test.ts:244-293` | **CERRADO** |
| **AG-A1** · el cierre se reentrega sin techo | `processor.ts:1168-1174,1188-1208,1234-1243` · `avisar_cierre.ts:92-117` | **CERRADO** (con residuo, ver AG-B2) |
| **AG-A3** · el varado fuera de ventana salta a nivel 4 | `asistencia_escalamiento.ts:85-94,277-288` | **CERRADO** |
| **AG-A2/A4** (sellos por canal) · los relojes legales sellan con un solo canal | `relojes_legales.ts:222-237,304-330` | **CERRADO** |
| **AG-A4** (grúa) · la cotización de la grúa al jefe equivocado | `asistencia_coordinacion.ts:527-537,673-686` | **CERRADO** |
| **AG-A5** · `escalado`/`cola_atorada` nunca cierran su incidente | `escalar_viaje.ts:274-281,466,497-501` · `cron/facturar/lote.ts:916-919` | **MUTADO** → ver **AG-A1** abajo |
| **AG-M1** · `ticket_soporte.vence_en` sin escritor | `comercial.ts:705-750` | **CERRADO** |
| **AG-M2** · «Tu jefe ya lo sabe» en violencia sin respaldo | `asistencia_wa.ts:566,585,674` | **CERRADO** |
| **AG-M3** · el diferimiento por piso se destruye a sí mismo | `notificaciones.ts:799-812,1006-1010` | **CERRADO** |
| **AG-B1** · el resumen de ráfaga por `sendText` (5ª ronda) | `processor.ts:1439-1459` · `intake/rafaga.ts:104-112,158-170` | **CERRADO** |
| **AG-B3** (copiloto) · previsualización sin validar objetivo | `agents/copiloto.ts:80-103` | **CERRADO** |
| **AG-B3** (`nada()`) · `destinatarios: 0` aunque hubiera reparto | `notificaciones.ts:988-989,1054` | **CERRADO** |

### Lo que ancla cada cierre (no me creo el asunto del commit)

- **AG-C1.** `ingerirRep` acepta `venceEn` y el corte está **antes de arrancar
  cada docto**, no a la mitad (`rep.ts:207-214`), acumulando lo que falta de
  TODOS los pagos restantes. Los cuatro llamadores lo pasan de verdad
  (`processor.ts:1657,2009,3384` con `Date.now() + reloj.restante()`;
  `api/correo/entrante/route.ts:350` con su `finPresupuesto`). La prueba
  (`rep.test.ts:244`) inyecta un reloj falso sobre 150 doctos y exige
  `doctos=63 / pendientes=87`: **revertir `venceEn` la deja en `doctos=150,
  pendientes=0` y falla**. Y el ciclo cierra con el humano: `mensajeRepRecibido`
  (`rep.ts:281-287`) dice cuántos quedaron y pide reenviar el mismo
  complemento, que es idempotente por el `ignoreDuplicates` del upsert. El
  presupuesto que se le entrega es `restante()`, que ya descontó
  `MARGEN_CIERRE_MS` — o sea que **el acuse siempre cabe**. Cerrado de verdad.
- **AG-A3.** `nivelObjetivo` ancla en `max(abiertaEn, notificarDesde)`
  (`:90-91`) y `escalarUna` refresca `notificar_desde` en cada corrida que sigue
  diferida (`:281-285`), con la fila de bitácora una sola vez. Caminé el caso
  nocturno: ámbar en nivel 1, ventana cerrada a las 18:00, cron cada 5 min →
  al reabrir a las 08:00 el ancla está a ≤15 min, `objetivo=0`, y sube un
  peldaño cada `RELOJ_AMBAR_MS`. Ya no salta a 4.
- **AG-A2/A4 (canales).** El sello es por canal (`{dinero, operacion}`,
  `relojes_legales.ts:224-236`) con OR-merge de eventos y trato explícito del
  sello legado sin desglose. El canal que falló **no** se sella
  (`:320-330`): `dinero: yaAvisado.dinero || partesDinero.length===0 ||
  dineroEnviadoAhora` da `false` cuando había partes y el envío rebotó.
- **AG-M3.** La corrección real no es la del prompt de la 28: `guardarMagnitud`
  **dejó de escribir `actualizado_en`** (`:799-812,830-836`) y esa columna queda
  reservada a `cerrarIncidente`, así que `actualizado_en > ultimo.avisadoEn`
  sobrevive corrida tras corrida y no solo la primera. Verifiqué en la 0097 que
  no hay trigger de `updated_at` que la pise. Bonus no pedido y real:
  `revertirAviso` (`:890-905`) deshace el claim cuando Resend rebota, con
  candado sobre los valores que ese mismo intento escribió.

---

## Hallazgos

### [ALTO] `escalado` sigue sin re-armar su filo cuando el problema SE RESUELVE: el único cierre que el arreglo de la 28 alambró exige que la base falle, y la pantalla le sigue prometiendo al dueño que «la cuenta vuelve a cero en cuanto el problema se resuelve»

`src/lib/likida/escalar_viaje.ts:274-281` (`porFlota`/`anota`) · `:466` (`for
(const [tenantId, c] of porFlota)`) · `:497-501` (`avisar(..., { hayProblema:
c.folios.length > 0, magnitud: c.folios.length })`) ·
`src/lib/likida/agentes/notificaciones.ts:990-991` (`cerrarIncidente` solo vive
en la rama `!estado.hayProblema`) · `:513-523` (el corte por marca) ·
`src/app/dashboard/agentes/notificaciones-forma.tsx:302-307` (el rótulo) ·
`src/lib/likida/escalar_viaje.test.ts:650-671` (la prueba que se escribió).

El commit `077ed02` movió el `avisar` de `escalado` fuera del `if
(c.folios.length > 0)` y lo puso a iterar `porFlota`. Pero **`porFlota` solo se
puebla desde `anota(...)`, y `anota` solo se llama DENTRO del `for (const v of
viajes)`** (`:293-438`). Una flota sin ningún viaje vencido esta corrida **no
entra al mapa**, así que `avisar` no se llama para ella y `cerrarIncidente`
nunca corre. Peor: de las seis llamadas a `anota`, cinco pasan `folioAviso`
(`:378,385,405,427,438`) y solo una no lo pasa — la del `claim.error`
(`:314`), que es un fallo de ESCRITURA en Postgres. Y el `if (!claim.ganado)
continue` (`:317-320`) ni siquiera llama a `anota`. **Conclusión mecánica: para
mandar `hayProblema: false` hace falta que la flota tenga ≥1 viaje vencido Y que
TODOS fallen el claim contra la base.** El cierre del incidente está condicionado
a que la base se caiga.

Escenario, con valores. Cron `/api/cron/escalar`, `7 * * * *`. Innovativos
enciende «El agente escaló un caso» en `/dashboard/agentes/conductores`.

- **Lun 10:07** — 2 viajes llevan 5 h sin que ningún chofer los acepte.
  `viajes.length = 2`, ambos ganan su claim, `folios = ['V-4410','V-4411']` →
  `avisar('conductores','escalado',{hayProblema:true, magnitud:2})`. `previo ===
  null` → `debeAvisar` devuelve «es la primera vez» → **correo**. Fila
  `(t, conductores, escalado)`: `magnitud=2`, `avisado_en=Lun 10:07`,
  `magnitud_avisada=2`.
- **Mar a Dom, 168 corridas** — los choferes aceptan a tiempo.
  `viajesSinAceptar` no devuelve ni un viaje de esa flota → `viajes = []` →
  `porFlota` no la contiene → **`avisar` no se llama ni una sola vez** →
  `cerrarIncidente` no corre → `magnitud` sigue en 2 y `actualizado_en` sigue
  siendo el del insert original.
- **Lun siguiente 10:07** — incidente NUEVO: 3 viajes sin aceptar.
  `avisar(..., magnitud: 3)`. `previo.ultimo.avisadoEn` = el lunes pasado,
  `previo.actualizadoEn` < esa fecha → `incidenteCerrado = false` (`:1006-1010`)
  → cae al corte por marca (`:513-515`): `marcaAlcanzada(3) = 0 <=
  marcaAlcanzada(2) = 0` → **no sale nada**. El `porque` que devuelve es,
  literal: *«ya se avisó con 2; el siguiente sale al llegar a 5 o cuando esto se
  resuelva y reaparezca.»* — y «esto se resuelva» es la condición que este
  emisor no puede producir.

El resultado es el mismo estado que la 28 describió: `magnitud_avisada` solo
sube (2 → 5 → 21), tres correos como techo **de por vida**, y después la fila
queda muda. La única diferencia es que ahora hay un camino teórico de re-armado,
y ese camino pide un `deadlock` de Postgres.

Intenté refutarlo por cuatro lados y ninguno sostiene: (1) `grep -n "anota(" `
sobre el archivo da exactamente las seis llamadas de arriba, todas dentro del
bucle de `viajes`; (2) `avisarCorridasPorFlota('conductores', cierre)` (`:509`)
cierra el evento `corrida_fallida`, que es OTRA fila de
`agente_notificacion_estado` — no toca `escalado`; (3) `cerrarIncidente` no
tiene ningún otro llamador (`notificaciones.ts:990` es el único, dentro de
`avisar`); (4) **la prueba que el arreglo añadió confirma el alcance en vez de
desmentirlo**: `escalar_viaje.test.ts:650` monta `resultadosUpdate = [{ error: {
message: 'deadlock' } }]` — es decir, el ÚNICO escenario de cierre que se probó
es el de la base fallando. El caso «la flota se puso al corriente» no tiene
prueba porque no tiene código.

Contraste que lo delimita: `cola_atorada` (`cron/facturar/lote.ts:916-919`) SÍ
quedó cerrado, y por una diferencia real — itera `corridas.keys()`, que se
puebla también con `corridas.set(tenantId, null)` en el camino de éxito
(`:444,651`), así que una corrida que procesa tickets sin bloquear ninguno
manda `hayProblema: false` y re-arma el filo. Ese es exactamente el mecanismo
que a `escalado` le falta.

Consecuencia: el dueño de la flota marca la casilla, la pantalla le contesta
«Hoy le llega a: Ana Pérez», recibe un correo, y a partir de la primera semana
tranquila el canal está apagado — mientras la pantalla le afirma por escrito, en
`notificaciones-forma.tsx:306-307`, que «la cuenta vuelve a cero en cuanto el
problema se resuelve, así que el siguiente incidente te avisa desde el primero».

Causa raíz probable: el emisor deriva «hubo problema» y «la flota existió esta
corrida» de la MISMA estructura (`porFlota`), y esa estructura solo se llena
cuando hubo trabajo — así que «cero problemas» y «cero trabajo» son
indistinguibles desde ahí.

---

### [MEDIO] El prompt del ayudante le ORDENA al modelo decir «cuánto queda», que es la resta que la guardia determinística está construida para rechazar: la respuesta se tira y se escribe un evento de seguridad `cifra_sin_respaldo` en el camino más común del chat

`src/lib/agents/prompts.ts:79` (`ÁBRELE con los números (… cuánto era el
anticipo, cuánto queda)`) · `:77` (`«¿cuánto me queda del anticipo?» → usa
"estado_viaje" y contesta con ESOS números (anticipo, comprobado, desglose,
litros leídos)`) · `src/lib/likida/tools.ts:163-172` (lo que `estado_viaje` de
verdad devuelve) · `src/lib/likida/cuadre/cifras.ts:138-145` (la doctrina) ·
`src/lib/likida/cuadre/guardia.ts:108-121,143,152`.

`estado_viaje` devuelve `{origen, destino, estatus, anticipo, comprobado,
comprobantes, copias_excluidas, por_concepto, litros_diesel_leidos}` — **no
devuelve ningún remanente**. Y `cifrasSinRespaldo` lo dice con todas sus letras
en su doc-comment: *«una cifra DERIVADA por el modelo (restar el anticipo del
comprobado, por ejemplo) no está respaldada aunque sus operandos sí lo estén»*.
O sea: el prompt pide exactamente el número que la guardia declara prohibido.

Escenario, con valores. Viaje abierto con `anticipo = 8000`, `comprobado = 6200`
en 4 comprobantes. El chofer escribe **«hola»** — el caso que el propio prompt
marca como regla y no como gusto (`prompts.ts:79-81`, AGEN-19C2-7).

1. El modelo obedece: llama `estado_viaje` (única tool del turno) y contesta
   *«Llevas 4 comprobantes por $6,200 de un anticipo de $8,000 — **te quedan
   $1,800**.»*
2. `guardiaCifras`: `cuadro = false` (no hubo `cuadrar_viaje` ni
   `guardar_liquidacion`), `consultoEstadoViaje = true` → entra en
   `:108`. `cifrasSinRespaldo` extrae `4, 6200, 8000, 1800`; los tres primeros
   están en el resultado de la tool, **`1800` no** → `fuera = [1800]`.
3. `:118-119` escribe `logger.warn('guardia_cifras_sin_respaldo')` **y**
   `registrarEventoSeguridad({ origen:'chat', tipo:'cifra_sin_respaldo' })`.
4. No hay `return`: cae al `try` de `:123`, `cerro=false`, `snapshotCierre`
   `undefined` → **`cuadrarDesdeDB(tenantId, viajeId)`** (el barrido completo:
   perfil, acumulado del ejercicio, líneas ECC) y `:152` **sustituye la
   respuesta entera** por `resumenCuadre(liq, false, 'operador')`.
5. Lo que el chofer recibe por su «hola» es *«Este es el cuadre de tu viaje 👇 ·
   Comprobado: … · Anticipo: … · Sobró … / Ojo con esto: …»* — no la apertura
   conversacional que el prompt diseñó.

Consecuencia, en dos frentes. **(a) La señal se envenena:**
`cifra_sin_respaldo` existe para detectar que el modelo se inventó dinero, y el
camino más frecuente del chat lo dispara por obedecer el prompt. Quien mire el
panel de seguridad aprende que ese evento es ruido — exactamente el
entrenamiento que hace que el evento real no se mire. **(b) El comportamiento
que la propia auditoría 19 peleó queda muerto:** el prompt razona por escrito
por qué «hola» tiene que abrirse con los números, y la guardia se lleva esa
respuesta cada vez que el modelo incluye el remanente, más un `cuadrarDesdeDB`
completo de sobreprecio por turno.

No es un falso positivo de la guardia: la guardia hace lo correcto. Es que el
prompt y la guardia se contradicen y nadie los cruzó. `cifras.ts:13-17` incluso
declara la asimetría como aceptable («un falso positivo cuesta que se reemplace
el texto…»), pero ese razonamiento se escribió para un modelo que se desvía, no
para uno que cumple la instrucción.

Causa raíz probable: `estado_viaje` se diseñó como foto de solo lectura y el
prompt le pidió después una cifra derivada que nunca se agregó a su salida.

---

### [MEDIO] Una carta muerta que no sea foto no la drena nadie: el latido de `wa-pendientes` se queda en `parcial` y el operador recibe la misma alerta cada hora durante 90 días

`src/lib/likida/wa_pendientes.ts:316-324` (`cartasMuertas`, cuenta TODO
`procesado_en is null and intentos >= 5`) · `:344-357` (`descartarCartaMuerta`,
el único drenador) · `src/lib/likida/conv.ts:990-1003` (el único llamador filtra
`.eq('evento->>type','image')`) · `src/lib/likida/processor.ts:4100-4133` (y
solo se alcanza desde un «listo») · `src/app/api/cron/wa-pendientes/drenado.ts:241-254`
· `supabase/migrations/0155_purgas_y_bucket_comprobantes.sql:147-150` (la purga,
a 90 días) · `vercel.json` (`wa-pendientes`, `* * * * *`).

`cartasMuertas()` cuenta cualquier fila sin procesar al tope de intentos. Lo
único que la saca antes de la purga es `descartarCartaMuerta`, y su **único**
llamador es la rama de cierre del processor, que solo mira filas con
`evento->>type = 'image'` y solo corre cuando ese mismo chofer escribe «listo»
y no le quedan fotos vivas. Cualquier otra carta muerta —un TEXTO, o la foto de
un chofer que nunca vuelve a cerrar— es permanente.

Escenario, con valores. Productor concreto y hoy alcanzable: el «listo» sin
ninguna hora (`processor.ts:4009-4015`) hace `soltarClaim()` → `'reintentable'`
→ `anotarFalloPendiente` consume intento. A los 5 minutos de cron, `intentos = 5`
y la fila es carta muerta de tipo `text`.

- **10:00** — la fila `wamid.HBg…A1` (tipo `text`, «listo») llega a
  `intentos = 5`.
- **10:01 y cada minuto después** — `drenado.ts:241` lee `muertas = 1` →
  `logger.error('cron.wa_pendientes.cartas_muertas')` +
  `alertarOperador('cron.wa_pendientes', { codigo: 'cartas_muertas' })`, y
  `:251-253` calcula `estado = 'parcial'`. `registrarLatido('wa-pendientes',
  'parcial', …)`.
- **Las 129,600 corridas siguientes (90 días)** — idénticas.
  `huellaDeDetalle` (`observability/alerta.ts:129-143`) solo usa `codigo` y los
  UUID del texto, y aquí el detalle es siempre `codigo=cartas_muertas`, así que
  el piso de una hora deja pasar **una alerta por hora: ~2,160 correos por una
  sola fila**, todos con el mismo texto. El latido de `wa-pendientes` **nunca
  vuelve a `ok`** hasta que `purgar_wa_evento_pendiente` la borre a los 90 días.

Y hay un segundo filo, más caro para el humano de este lado: el chofer que
escribió ese «listo» **no recibió ni una palabra**. `processor.ts:4013` hace
`soltarClaim(); return;` sin `say`, y las cinco vueltas del cron son mudas
también. Su liquidación no cierra y para él el sistema simplemente no contestó.

Consecuencia: la alarma que existe para avisar «un mensaje de un chofer se
perdió» se convierte en un correo horario que no cambia nunca y en un tablero
permanentemente ámbar. Quien la mira aprende a filtrarla, y el día que se pierda
un segundo mensaje —de otro chofer, con su comprobante— la alerta es
indistinguible de la de ayer.

Causa raíz probable: `cartasMuertas()` cuenta un universo (toda la bandeja) que
su único drenador solo puede tocar por un camino angosto (foto + «listo» del
mismo chofer), así que el contador es monótono por construcción.

---

### [BAJO] Un PDF que Meta rechaza para siempre sella `avisada_oficina_en` para el contralor y NO sella `entregada_operador_en` para el chofer: la misma condición, dos reglas opuestas, y la del contralor es la que la auditoría 25 había cerrado

`src/lib/likida/avisar_cierre.ts:92-99` (`pdfListoParaSellar` acepta
`'definitivo'`) · `src/lib/likida/processor.ts:1234-1243` y `:4912-4925` (el
jefe sella con `definitivo`) contra `:1200-1208` (el chofer con `definitivo`
**no** sella).

`pdfEstadoDe` (`avisar_cierre.ts:110-117`) devuelve `'definitivo'` cuando Meta
contesta con un código no reintentable. Para el ejemplar del CHOFER eso deja
`pdf = 'fallo'`, no sella, y el texto le dice la verdad («el PDF no se te pudo
entregar… pídeselo a tu contralor»). Para el ejemplar del CONTRALOR, el mismo
estado devuelve `true` en `pdfListoParaSellar` y se estampa
`avisada_oficina_en`.

Escenario, con valores: piloto con el número de oficina fuera de la lista de
pruebas de Meta → `sendDocument` al jefe devuelve `{ok:false, codigo:131030}` →
`pdfEstado = 'definitivo'` → `rj.enviado` es `true` (el TEXTO con anticipo,
comprobado y diferencia sí salió) → se sella. El contralor recibe el resumen en
texto pero **nunca el PDF completo**, que es justamente el ejemplar con los
veredictos `SOLO_CONTRALOR` que su contador tiene que resolver; y el sello hace
que `entregarCierrePendiente` (`:1217-1219`) lea `ya_avisado` y no vuelva a
intentarlo jamás. Es el estado que la auditoría 25 documentó y cerró («el
ejemplar que el contralor necesita se perdía para siempre detrás de un sello que
decía "ya avisado"»).

Lo dejo en BAJO —y no más— porque **el ciclo sí cierra con un humano**:
`:1236-1240` y `:4919-4921` disparan `logger.error('cierre.pdf_jefe_definitivo')`
y `alertarOperador` antes de sellar, así que alguien de Likida se entera. Lo que
no cierra es el ciclo con el CONTRALOR, que es quien necesita el papel, y el
mensaje de commit de `e705d56` afirma que las dos patas sellan igual cuando el
código hace lo contrario en cada una.

Causa raíz probable: `definitivo` significa dos cosas distintas según a quién
no le llegó — «díselo y no lo repitas» para el chofer, «dalo por entregado» para
el contralor— y se resolvió con una sola función compartida.

---

### [BAJO] Un «listo» sin ninguna hora se abandona en silencio y consume sus cinco intentos sin decirle una palabra al chofer

`src/lib/likida/processor.ts:4009-4015`.

`if (cierreSolicitado && timestampCierreMs === null) { logger.error(...); await
soltarClaim(); return; }` — sin `say`. `soltarClaim()` (sin `true`) devuelve
`'reintentable'`, que en `route.ts:418` y en `drenado.ts:165` consume intento.

Escenario: el chofer escribe «listo». Ni `msg.timestampMs` ni `msg.recibidoMs`
llegan (fila de la bandeja anterior al despliegue de `recibidoMs`, o un llamador
interno). Vuelta 1 del cron: `logger.error('cierre.timestamp_indeterminado')`,
`intentos = 1`, cero mensajes. Vueltas 2-5: idénticas. A los cinco minutos la
fila es carta muerta invisible (`0325` filtra `intentos < 5`) y, por ser de tipo
`text`, tampoco la drena la rama de carta muerta (ver el MEDIO de arriba). El
chofer mandó su cierre y **nunca supo que no se hizo**; su viaje sigue abierto.

El propio comentario del arreglo (`:4001-4008`) dice «esta situación no debería
ocurrir con tráfico real del webhook», y es cierto —`route.ts` rellena
`recibidoMs`—, por eso es BAJO. Pero el corte de arriba existe precisamente
porque el caso puede pasar, y cuando pasa es el modo de falla que este rubro
puntúa: el usuario nunca recibe su salida.

Causa raíz probable: la rama se escribió para dejar de aplazar para siempre
(BE-A4) y resolvió el ciclo con la bandeja durable, pero no con el humano.

---

## Lo que revisé y está bien

Abierto en esta ronda, con el fuente delante:

- **El corte por reloj de `ingerirRep` y su acuse** (`intake/rep.ts:199-265`).
  Ver arriba. Además `venceEn = Date.now() + reloj.restante()` deja todo el
  `MARGEN_CIERRE_MS` (~39 s) libre para el `sendText` del acuse, así que el
  corte nunca se queda sin poder hablar.
- **El cierre recuperado narra el snapshot archivado** (TC-A1/TC-M1):
  `confirmarCierreEnBase` (`processor.ts:1377-1395`) lee el snapshot **por
  `liq.id`**, no por `viaje_id` —la fila exacta que ya validó—, y un fallo ahí
  degrada a «cerrado sin snapshot», nunca a «no sé si cerró».
  `replyDeCierreRecuperado` (`:1415-1420`) y `guardia.ts:137-140` cierran el
  círculo: sin snapshot **no se recalcula**, se dice «Ya cerré tu liquidación ✅»
  y se manda el PDF. Ningún camino puede narrar un cuadre distinto del impreso.
- **El presupuesto compartido de la invocación** (`presupuesto.ts:317-335`):
  `restante()` descuenta `MARGEN_CIERRE_MS`, `margenDuro()` no, y la identidad
  `margenDuro() = restante() + MARGEN_CIERRE_MS` está escrita como razonamiento
  y no como suposición. `senal(0)` devuelve una señal **ya abortada**, no una
  agendada.
- **El orden por chofer, en los dos caminos.** El webhook agrupa por `from`
  (`route.ts:361-371`) y el cron por `remitente` (`drenado.ts:108-113`), los dos
  con `break` al perder un claim; y por debajo la 0325 lo hace **estructural**:
  `reclamar_wa_pendiente` rechaza cualquier fila que tenga un anterior vivo del
  mismo `remitente_clave` (`0325:95-106`). Tres capas para la misma garantía, y
  la de la base no depende de que el código de arriba no se equivoque. La
  exclusión `intentos < 5` en esa subconsulta es correcta: una carta muerta no
  puede congelar la cadena de nadie.
- **`sin_tiempo` no cuenta como intento** ni en el webhook (`route.ts:399-412`)
  ni en el cron (`drenado.ts:150-162`), y los dos cortan la cadena en vez de
  adelantar el «listo» sobre sus fotos.
- **`cerrarRafagasPorCorte` cierra SOLO la libreta del teléfono que se quedó sin
  reloj** (`processor.ts:1439-1445`), no la de todos los choferes del proceso, y
  el teléfono y el tenant viajan en la libreta (`rafaga.ts:104-112`) para no
  pagar una consulta justo cuando no queda presupuesto.
- **La barrera de ráfaga falla cerrada:** `intakePendientes` devuelve `null` —no
  cero— ante error, `esperarIntake` trata `null` como «no sé» y no abre
  (`conv.ts:1151-1167`), y el sondeo dejó de ser una escritura sobre la misma
  fila que la ráfaga actualiza.
- **`descartarCartaMuerta` sella ANTES de hablar** (`processor.ts:4103-4116`):
  si el sello no entra, no se manda nada al chofer y el turno se aplaza — el
  orden correcto para no martillarlo en cada vuelta del cron.
- **La puerta de envío de la cola de aprobación** (`agentes/cola.ts:472-698`):
  claim anclado → proveedor → prueba, con compensación en cada rechazo
  definitivo y, sobre todo, con la **ambigüedad de red tratada como ambigüedad**
  (`:665-673`): no se revierte, no se reenvía, se marca «enviada-por-confirmar»
  y la reserva de cadencia se queda puesta. Es el manejo correcto de «no sé si
  salió».
- **El reloj duro del runner** (`agentes/runner.ts:1180-1249`): la ruta espera a
  la CARRERA entre la vuelta y el reloj, no a la vuelta, así que un motor futuro
  que ignore su `venceEn` no puede robarle a la ruta su margen para latir. Y
  `cerrarPorRelojDuro` nombra al que quedó en vuelo y a los que no llegaron a su
  turno, con dedupe para no inventar un agente.
- **`asistencia_camara.ts` de punta a punta** (primera vez que se camina):
  `escala = rangoCamara > rangoAbierto || prioridad !== 'critica'` es idempotente
  —la segunda etiqueta grave del mismo choque ya no escala—, el robo no se
  degrada a siniestro, y `hayLesionados: null` («no preguntado») nunca se
  escribe como `false`.
- **`admin_comandos_wa.ts`**: el candado de rol va ANTES que la forma, así que un
  `flota_admin` no aprende la gramática de una consola que no es suya, y la
  negación deja evento de seguridad.
- **`atenderCoordinacionOficina`**: `puedeAsignar(rol)` antes de tocar nada, todo
  con `tenant_id` en el WHERE, y `destinatarioAvisoCoordinacion` resuelve al
  autorizador **dentro de su tenant** (`telefonoDeUsuario(id, tenantId)`) con
  caída al jefe.

## Lo que NO alcancé a revisar

- **`carta_porte_wa.ts`** (373 líneas): tercera ronda fuera. Su ciclo por botón
  (`ccp_si:`) no lo he caminado.
- **Los 45 motores de agente** (`agentes/{backoffice,direccion,crecimiento,exito,…}.ts`):
  verifiqué el DESPACHO (`runner.ts`) y el reloj duro, no lo que cada motor hace
  con su `venceEn` una vez despachado.
- **`copiloto-tools.ts` (cross-tenant) y `copiloto-historial.ts`**: cuarta ronda
  fuera. Solo abrí `copiloto.ts` para dictaminar el hallazgo de la 28.
- **`agentes/enviador.ts` y la cadencia de campaña bajo concurrencia real**: leí
  la puerta de `cola.ts`, no el motor que la llama en automático.
- **La ráfaga bajo concurrencia real** (mutex de viaje + barrera): leí el
  mecanismo y el fuente de `esperarIntake`/`intentarLockViaje`, pero no monté un
  caso de dos invocaciones solapadas. Quinta ronda sin rehacerlo.
- **No corrí la suite completa** (la corre el orquestador). Corrí puntualmente
  `intake/rep.test.ts` y `agentes/notificaciones_parpadeo.test.ts` (26 pruebas,
  verdes) para confirmar que leo el árbol vivo. Todo lo demás es lectura del
  fuente, de las migraciones y de las pruebas existentes.
