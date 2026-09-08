# Backend y API — auditoría 29

**Nota: 6/10** (antes 4). Razón del movimiento: **se atacó y subió**. Cinco de
los seis hallazgos abiertos de la 28 están CERRADOS y —lo que justifica la
subida, no el commit— **cada uno tiene una prueba que se pondría roja si el
arreglo se revirtiera**, y las abrí una por una para comprobarlo. No sube más
porque el hallazgo que toca la cifra que el contralor lee —BE-3, los seis
agregados que suman liquidaciones rechazadas— sigue **idéntico, tercera ronda**,
y porque la superficie nueva trajo dos caminos ALTO donde el producto **sella
como entregado algo que nadie recibió**.

**El riesgo mayor del rubro, hoy:** el sello de entrega dejó de significar
«llegó». Dos caminos nuevos lo ponen sobre un envío que ni se entregó ni quedó
encolado, y como el sello es exactamente lo que apaga el reintento, el PDF de
una liquidación cerrada se pierde sin una sola alerta.

---

## Estado de los hallazgos abiertos de la 28

| # | Hallazgo de la 28 | Veredicto |
|---|---|---|
| 1 | El PDF de una liquidación RECHAZADA se sigue descargando | **CERRADO** |
| 2 | La liquidación rechazada sigue sumando dinero — SEIS agregados | **REINCIDENTE** |
| 3 | Una foto que agotó sus 5 intentos bloquea todos los cierres del chofer | **CERRADO** |
| 4 | Un «listo» sin hora de Meta se aplaza para siempre (y QA lo pinta verde) | **CERRADO** |
| 5 | Un bache de red al leer la revisión pinta una rechazada como vigente | **CERRADO** |
| 6 | `tomarTicket` es el único claim del repo que no está anclado | **CERRADO** |

**(1) CERRADO.** `src/app/api/export/pdf/[id]/route.ts:90` ya trae `revision` en
el `select` y `:113-120` contesta **409 sin firmar la URL**. Prueba que lo
ancla: `src/app/api/export/rutas_export.test.ts:237-245` — `filaPdf =
{ pdf_url:'t-1/v-1.pdf', revision:'rechazada' }` y afirma `createSignedUrl` no
llamado; revertir el `if` la pone roja. El botón también se apagó
(`src/app/dashboard/[id]/page.tsx:313`). Busqué el segundo camino que serviría
el mismo papel (WhatsApp): `entregarCierrePendiente` solo corre en la rama «sin
viaje abierto», y una rechazada devuelve el viaje a `en_cuadre`
(`0306:252`), que `getOpenViaje` sí encuentra (`conv.ts:188`) — no es
alcanzable. Corrida verde en esta ronda.

**(2) REINCIDENTE.** Ver el hallazgo BE-A2 abajo: escenario reescrito con
valores de hoy.

**(3) CERRADO.** `conv.ts:930-1022` ya devuelve `{vivas, muertas}` en vez de un
`true` que las mezclaba, y `processor.ts:4100-4133` avisa al chofer, alerta al
operador y **sella la carta muerta** con un UPDATE anclado y verificado
(`wa_pendientes.ts:344-361`: `.is('procesado_en',null).gte('intentos',MAX)
.select('id')`, y solo devuelve `true` si volvió fila). Pruebas que lo anclan:
`aviso_barrera_cerrado.test.ts:196` (avisa, alerta, sella, aplaza UNA vuelta) y
`:210` (sello fallido ⇒ ni `say` ni alerta). Corridas verdes.

**(4) CERRADO, las dos mitades.** El motor: `processor.ts:3999`
`timestampCierreMs = timestampMetaMs ?? recibidoMs`, y `:4009-4016` **consume el
intento** (`soltarClaim()` sin `true`) cuando no hay ninguna de las dos, con
`logger.error`. El webhook pone la cota: `webhook/whatsapp/route.ts:692-697`.
El arnés: `qa-motor.ts:816`, `:819`, `:1472`, `:1475` ya mandan `timestampMs`.
Pruebas: `aviso_barrera_cerrado.test.ts:162` y `:180` (esta última fija
explícitamente «NO es sin_tiempo»), `route_timestamp_ilegible.test.ts:82-105`.

**(5) CERRADO.** `page.tsx:210-215` separa `null` («no hay») de `revisionIlegible`
(«no se pudo leer») y `:313` apaga `pdfHref` en los dos casos. Prueba:
`src/app/dashboard/[id]/pdf_pendiente.test.tsx`.

**(6) CERRADO.** `soporte.ts:348-353`: el UPDATE ancla
`.or('asignado_a.is.null,asignado_a.eq.<actor>')` y **comprueba con `.select()`**;
sin fila, relee y lanza diciendo quién lo tiene, **sin anotar bitácora**. Prueba
de la carrera: `soporte.test.ts:316` (`update` devuelve `data: []` ⇒ no reporta
éxito y no anota). Corrida verde.

---

## Hallazgos

### [ALTO] `pdfEstadoDe` clasifica como «encolado» un rechazo que NUNCA se encoló — y con eso se sella una entrega que no ocurrió

`src/lib/likida/avisar_cierre.ts:110-117` · `src/lib/meta/client.ts:566-571` ·
`src/lib/likida/processor.ts:1187-1199` (PDF del chofer) ·
`src/lib/likida/processor.ts:4912-4926` (PDF del contralor, camino feliz) ·
`src/lib/likida/avisar_cierre.ts:92-99`.

**Escenario, con valores.** Viaje `F-1042`, cierre a las 10:00, `pdf_url =
't-1/F-1042.pdf'`. `sendDocument` hace POST a la Graph API y el borde de Meta
contesta **HTTP 403 con un cuerpo HTML** (bloqueo de WAF / IP; el mismo caso son
un 400 con cuerpo vacío o cualquier respuesta que no sea el JSON
`{"error":{"code":…}}`).

1. `errorDeMeta` (`client.ts:154-159`) no puede parsear ⇒ **`codigo =
   undefined`**.
2. `client.ts:570`: `esReintentableMeta(undefined, 403)` = `false` (`:195-199`
   solo acepta 429 o ≥500 sin código) ⇒ **NO se encola nada en `wa_outbox`**.
3. Devuelve `{ ok:false, error:'HTTP 403', codigo: undefined }`.
4. `pdfEstadoDe` (`avisar_cierre.ts:110-116`): `if (r.codigo === undefined)
   return 'encolado'` — su comentario afirma que sin código «fue el catch de
   red… y ESE camino ya encola». **Es una de dos causas, no la única.**
5. `processor.ts:1192-1199`: `estado === 'encolado'` ⇒
   `sellarEntregaLiquidacion(..., 'entregada_operador_en', ...)`, `pdf =
   'mandado'`, y el rastro es `logger.info('pdf.encolado')` — **ni warn, ni
   `alertarOperador`**. Idéntico para el contralor por
   `pdfListoParaSellar` (`:4914`).

El sello es justo lo que apaga el reintento: en el siguiente mensaje del chofer,
`processor.ts:2286-2289` ve los dos sellos puestos y contesta
`MENSAJE_CIERRE_YA_ENTREGADO` — «ya te mandé lo tuyo» — sin volver a intentar
nada. El PDF no está en Meta, no está en `wa_outbox` y nadie lo va a mandar.

**Consecuencia.** El chofer se queda sin su ejemplar y el contralor sin el suyo
por WhatsApp, mientras `liquidacion.entregada_operador_en` /
`avisada_oficina_en` afirman lo contrario y el bot se lo confirma por escrito.
No hay alerta: es la única rama de este archivo que ni siquiera loguea en
`warn`. Es exactamente el modo de falla que la 25 cerró («no se sella si no
llegó») reabierto por el arreglo de AG-A1.

**Prueba que lo cubra: ninguna, y las que hay bendicen la suposición.**
`avisar_cierre.test.ts:268` se llama «sendDocument **sin código (fallo de red,
ya encolado por el propio cliente)**» y
`processor_cierre_parcial.test.ts:618-626` monta el caso con
`fetchSpy.mockImplementationOnce(async () => { throw new Error('fetch failed') })`
— el único camino donde la suposición sí se cumple. El par (`codigo`
indefinido, status no reintentable) no se prueba en ningún archivo.

**Causa raíz probable.** `sendDocument` no devuelve **si encoló**; `pdfEstadoDe`
lo infiere del código y no ve el `status`, que es el dato con el que
`esReintentableMeta` de verdad decidió.

---

### [ALTO · REINCIDENTE] Siguen siendo SEIS los agregados que suman dinero de liquidaciones rechazadas — cero cambios en 43 commits

`supabase/migrations/0152_agregados_comercial_operacion.sql:63-68`
(`rentabilidad_tenant`) ·
`0150_agregados_analytics.sql:357-372` (`liquidado_semanal_tenant`), `:418-455`
(`operadores_detalle_tenant`), `:512-527` (`liquidaciones_por_dia_tenant`) ·
`0112_agregados_rpc.sql:243-249` (`serie_comparativa_tenant`) ·
`0174_diferencia_redondeo.sql:45-50` (`stats_operador_tenant`) ·
`src/lib/likida/espejo_0152.pruebas.ts:73-82` (el espejo que bendice el defecto).

**Verificado hoy, no recordado.** Abrí las seis definiciones y busqué un
`create or replace` posterior (`grep -rn "<función>" supabase/migrations/`): la
última definición viva de cada una es la que cita el hallazgo de la 28. La
última migración del repo sigue siendo la **0347** — no entró ninguna en esta
ventana. Ninguna de las seis menciona `revision` ni se une a `viaje.estatus`.

**Escenario, con los mismos valores de la 28 porque siguen escribiéndose igual.**
Flota con dos liquidaciones de la semana: A $50,000 (aprobada) y B $30,000
(**rechazada**, viaje devuelto a `en_cuadre`), `ingreso_flete` de los dos viajes
= $120,000.

- `/dashboard/rentabilidad` → `getRentabilidad` (`comercial.ts:248-256`) →
  `rentabilidad_tenant`: el CTE `l` (`0152:63-68`) suma `total_comprobado` de
  las dos. La pantalla pinta **Costo comprobado $80,000**, **Contribución
  $40,000** y el renglón `vista.tsx:96-98` afirma «Margen: **33.3 %** — medido
  solo sobre los 2 viajes con ingreso capturado». Lo verdadero es
  $50,000 / $70,000 / 58.3 %.
- El banner de `/dashboard` (`liquidado_semanal_tenant`) dice **$80,000**
  mientras `kpis_liquidacion_tenant` —ya corregida por la 0344:23— dice
  **$50,000**: dos cifras del mismo hecho en la misma sesión.
- `serie_comparativa_tenant`, `operadores_detalle_tenant`,
  `stats_operador_tenant` y `liquidaciones_por_dia_tenant` arrastran la misma B.

**La prueba sigue bendiciendo el defecto.** `espejo_0152.pruebas.ts:73-82`
reimplementa `rentabilidad_tenant` en JS con la misma omisión
(`b.liquidacion.filter(x => x.tenant_id === tenant && (!desde || x.created_at >=
desde))`, sin `revision`), y `comercial_equivalencia.test.ts` compara un lado
contra el otro: verde porque los dos están mal.

**Consecuencia.** El margen —la cifra con la que el contralor decide una
tarifa— se calcula con costo que él mismo invalidó, en la pantalla que remata
con «Nada de esta pantalla se estima» (`vista.tsx:60-61`).

**Causa raíz probable.** No existe una vista ni un predicado compartido que
obligue a decidir sobre `revision`; cada arreglo se hizo contra la lista del
hallazgo anterior. **Nota de alcance:** cinco de las seis exigen migración
nueva; la 28 señaló `scripts/ci/staging-recovery.mjs:121` como el bloqueo, y
`861d09d` dice haberlo levantado — si es cierto, ya no hay excusa de
infraestructura.

---

### [ALTO] El corte por presupuesto de `ingerirRep` no deja marcador: el reintento rehace los mismos documentos y un complemento grande NUNCA termina de ingerirse

`src/lib/likida/intake/rep.ts:207-217` (el corte) y `:218-230` (el upsert que
vuelve a pagar por lo ya hecho) · `src/app/api/correo/entrante/route.ts:350-352`
y `:376-384` (el 503 que pide el reintento) · `src/lib/likida/intake/rep.ts:283-288`
(lo que se le promete al chofer).

**Escenario, con valores (son los de la propia prueba del repo).** Un proveedor
de diésel manda por correo un REP consolidado de **150 documentos
relacionados**. `maxDuration = 60` y el presupuesto es
`finPresupuesto = ahora + 57 s` (`route.ts:284-285`).

1. Primera entrega: `ingerirRep` procesa hasta que `Date.now() >= venceEn` y
   corta **antes del docto #64** ⇒ `{ doctos: 63, pendientes: 87 }` — es
   literalmente el caso fijado en `intake/rep.test.ts:244-258`.
2. `route.ts:352`: `pendientes > 0` ⇒ `caidas++` ⇒ `:376-384` libera el claim y
   contesta **503** para que Resend reintente. El comentario de `:346-349`
   afirma que así «retoma justo donde se cortó».
3. **No hay marcador.** El bucle de `rep.ts:207-209` arranca siempre en
   `rep.pagos[0].doctos[0]`. En la segunda pasada los 63 primeros vuelven a
   pagar su `upsert` completo (`:220-230`, ON CONFLICT DO NOTHING **sigue
   siendo un viaje de red**) y, para los que ya quedaron sellados, el
   `update` de `:245-250` devuelve 0 filas y **añade** la consulta
   `rep.buscarGasto` de `:261-262`: la segunda pasada es *más cara por docto*
   que la primera.
4. El corte cae en el mismo punto o antes. Los 87 pendientes no entran nunca;
   Resend agota sus reintentos y el correo se abandona.

Por WhatsApp es peor porque además se promete: `rep.ts:288` le dice al chofer
«*87 documentos de este complemento no me dio tiempo de procesar — reenvía el
mismo complemento para que termine*», y reenviarlo produce exactamente el mismo
corte (`processor.ts:1657`, `:2009`, `:3384` pasan `Date.now() +
reloj.restante()`).

**Consecuencia.** El IVA de esas 87 facturas nunca se sella como pagado
(`gasto.pagado_en`), así que no se acredita en el mes del pago (LIVA 5-III): es
dinero fiscal que se queda fuera del cálculo sin que nadie vea un error — el
único rastro es un `logger.info('correo_entrante.rep')` con `pendientes: 87` y
un 503 que se lee como «se cayó la red». Y cada reintento quema una invocación
completa de 57 s.

**Prueba que lo cubra: ninguna, y la que hay documenta el defecto.**
`intake/rep.test.ts:265-284` («una segunda llamada sin corte completa el resto
sin duplicar») corre la segunda pasada **sin `venceEn`** y afirma
`expect(upsert).toHaveBeenCalledTimes(150)` — o sea, deja escrito que la segunda
pasada rehace los 150. No existe ninguna prueba de dos pasadas *con*
presupuesto donde la segunda avance más que la primera.

**Causa raíz probable.** El corte se implementó como un tope de tiempo sin
estado; reanudar exige leer qué `(cfdi_uuid, docto_relacionado_uuid)` ya está en
`cfdi_pago` y saltarlo, o guardar el índice del corte.

---

### [MEDIO] El sello «encolado» descansa en una URL firmada de 15 min metida en una cola que reintenta hasta ~63 min

`src/lib/likida/processor.ts:1184` (`TTL_FIRMA_PDF_SEGUNDOS` en el `link`) ·
`:1307` (el TTL = 900 s) · `src/lib/meta/client.ts:562` (encola el payload **con
esa misma URL**) · `src/lib/likida/wa_outbox.ts:93`
(`RETRASO_AMBIGUO_SEGUNDOS = 5 min`) ·
`supabase/migrations/0180_reservas_agente_y_outbox_wa.sql:112-113` (backoff
`15 · 2^intentos`, muerte a los 8) · `src/app/api/cron/wa-outbox/route.ts:51`
(«Solo reintenta la misma carga serializada»).

**Escenario, con valores.** 10:00:00 se firma la URL del PDF del chofer (vence
**10:15:00**). `sendDocument` sufre un timeout de socket ⇒ se encola con retraso
ambiguo ⇒ primer intento del outbox **10:05**. Meta contesta 429 (`130429`,
reintentable) en ese intento y en los siguientes: la cola vuelve a intentar a
+30 s, +60 s, +120 s, +240 s… El quinto reintento cae hacia **10:17**, con la
URL ya caducada: a partir de ahí Meta no puede descargar el `link` y el fallo
deja de ser transitorio. La salida muere en `dead` y alerta
(`route.ts:38-46`), pero `entregada_operador_en` **ya se selló a las 10:00**
(`processor.ts:1197-1198`), así que ningún mensaje posterior del chofer vuelve a
firmar una URL nueva.

**Consecuencia.** Un 429 pasajero de Meta se convierte en un PDF perdido para
siempre; la alerta que sí sale (`salida_muerta`) habla de «un mensaje de
WhatsApp», no de que una liquidación quedó marcada como entregada sin estarlo.

**Causa raíz probable.** El sello se pone sobre el ENCOLADO y no sobre la
entrega, mientras la carga encolada lleva una credencial más corta que la vida
de la cola; el outbox no puede re-firmar porque solo reenvía el payload
serializado.

---

### [BAJO] Doce cartas muertas ⇒ doce mensajes casi idénticos al chofer y doce alertas al operador, en el mismo turno

`src/lib/likida/processor.ts:4100-4133` (el `for` sin tope) ·
`src/lib/likida/conv.ts:1003` (`.limit(50)`).

**Escenario, con valores.** OCR caído media hora; el chofer `5219993700779`
mandó **12 fotos** en ese rato y las 12 llegaron a `intentos = 5`. En su
siguiente «listo», `fotoAnteriorSinProcesar` devuelve `muertas.length = 12` y el
bucle de `:4102` manda **12 veces** el mismo texto («Una foto que mandaste (…)
no se pudo procesar…») y dispara **12** `alertarOperador('cierre.carta_muerta')`
— uno por fila, sin agrupar, hasta un tope teórico de 50 por el `.limit(50)` de
la consulta.

**Consecuencia.** El chofer recibe una ráfaga que parece un bot roto justo en el
momento en que se le pide confianza, se paga un envío de WhatsApp por cada uno,
y la alerta útil se diluye en doce copias. El aviso en sí es correcto y nuevo
(cierra BE-A3): lo que falta es agrupar.

**Causa raíz probable.** El aviso se escribió por fila porque el sello es por
fila; el mensaje al humano podía ser uno solo con la cuenta.

---

## Lo que revisé y está bien

- **`export/pdf/[id]`, entero** (`route.ts:33-186`): cuota por IP **y** por
  tenant, área `dinero` antes del rol, filtro de tenant explícito sobre
  service-role, `error` comprobado por valor con 500 propio, 404 indistinguible
  entre «no existe» y «sin papel», 502 si Storage no firma, y la telemetría de
  descarga envuelta en `try` **y** leyendo `error` — nunca impide la descarga.
- **La idempotencia de `/v1`** (`_escritura.ts:699-785`): memoria → capa durable
  (0098) → llave natural, con la carrera resuelta por el unique
  (`:767-777`: si choca contra `viaje_folio_unico` re-busca y devuelve 200
  idempotente; si no aparece, **relanza** en vez de inventar), huella de
  contenido que distingue reintento de reúso de llave (409/400 explícitos), y el
  409 deliberadamente **no** memorizado. `POST /v1/viajes:288-346` exige `folio`
  precisamente porque el unique con NULL no participa.
- **`conciliarPropuesta`** (`portal_pago_escritura.ts:233-330`): el abono usa la
  propuesta como llave de idempotencia y `AbonoYaRegistrado` (23505) se resuelve
  colgándose del abono existente; el sello ancla `.eq('estado','pendiente')` con
  `.select()`, y cuando no aplica **relee** para distinguir «otra sesión ganó con
  el mismo abono» (idempotente, se anota) de «alguien lo descartó» (se anota en
  bitácora con el id del pago y se lanza). El dinero se escribe una vez y el
  caso feo —murió después de crear el abono y antes de sellar— tiene salida.
- **`/api/pago/registrar`** (`route.ts:62-187`): 413 por tamaño declarado antes
  de tocar el limitador, tope de cuerpo en la lectura, honeypot que contesta 200
  sin escribir, token en el body y no en el path, **503 y no 404** cuando no se
  pudo preguntar, 409 explícito para factura cancelada, y la ruta pública no
  puede tocar `pago_recibido`.
- **La coherencia `liquidado`⇄`rechazada` está defendida en los dos extremos.**
  Intenté construir el re-cierre que la rompe (rechazo → «listo» sin comprobantes
  nuevos ⇒ `guardar_liquidacion_tx` hace `on conflict do update` sin tocar
  `revision`, `0321:324-336`) y el trigger diferido lo aborta con 23514
  (`0299:209-212`) — pero el motor **lo narra bien**:
  `confirmarCierreEnBase` (`processor.ts:1352-1356`) lee `revision` y el estatus
  del viaje **en un solo snapshot** y contesta `RESPUESTA_CIERRE_RECHAZADO`
  (`:1331`), que le dice al chofer la verdad y qué hacer. Y el re-cierre que sí
  trae cifras nuevas retira la firma solo (`0299:141-155`).
- **`descartarCartaMuerta`** (`wa_pendientes.ts:344-361`): UPDATE anclado en las
  dos condiciones que definen el estado terminal, `.select('id')` para saber si
  aplicó, y `false` tanto si el WHERE no encontró fila como si la lectura
  falló — el llamador lo trata como indeterminado y no manda nada.
- **`/api/dashboard/ingesta`** (`route.ts:45-104`): CSRF explícito, sesión, MFA
  de superadmin, área `dinero`, cuota por usuario, cuerpo acotado, validación de
  la data URL, y el **tope diario leído antes de gastar, fallando cerrado con
  503** si no se pudo leer. Cada llamada de visión deja su fila de costo.
- **`cron/wa-outbox`** (`route.ts:52-110`): interruptor global antes de reclamar
  (ilegible ⇒ 500 con latido, no «apagado»), canal comprobado **antes** de
  reclamar para no quemar intentos, y un 200 sin wamid tratado como fallo
  observable en vez de entrega inventada.
- **`margenUnidadAtomicaMs`** (`presupuesto.ts:399-401`) aplicado en
  `cron/gps:63` y `cron/descarga-sat:106`: el margen de reloj dejó de ser un
  literal copiado y se deriva de la unidad atómica más cara, con el conteo paso
  por paso en el comentario y la corrección de las cifras viejas dicha en voz
  alta.

Corridas en esta ronda (verdes, **4 archivos / 124 pruebas**):
`aviso_barrera_cerrado.test.ts`, `rutas_export.test.ts`,
`intake/rep.test.ts`, `soporte.test.ts`.

---

## Lo que NO alcancé a revisar

- **~30 rutas de `src/app/api/`**: `mcp` y su OAuth (3 rutas), `marketing/*`,
  `lead`, `admin/copiloto` (3), `admin/mapa-prospectos` (4), `admin/qa/*` (5),
  `webhook/calcom` y `webhooks/calcom` (el primero se vació +6/−219 hacia
  `lib/admin/calcom_webhook.ts`, **+242 líneas nuevas sin leer**),
  `cron/{jornada,portales-vivos,runner,escalar,purgar,asistencia,facturar/cola}`,
  `export/{bitacora-peaje,carta-porte-xml,facturas-proveedor,jornada,poliza}`,
  `stripe/webhook`, `client-error`, `worker/bus/[accion]`.
- **`cron/facturar/lote.ts`** (915 líneas): solo leí el diff de esta ventana
  (+40, el re-armado de `cola_atorada`), no el interior de la sesión de portal.
- **El resto del `+469/−82` de `processor.ts`**: revisé a fondo la cadena de
  cierre (barrera, foto anterior, carta muerta, reentrega, sellos) y
  `confirmarCierreEnBase`; no abrí los bloques de voz, briefing ni ARCO por
  texto (`b6920a5`).
- **`senales_pmf`** (`0162:70`), `poliza_datos_tenant` (`0307:41`) y los cinco
  lectores de `liquidacion` que la 28 dejó sin clasificar respecto de `revision`
  (`auditor_cobranza.ts:584`, `libro_viaje.ts:590`, `avisar_cierre.ts:78`,
  `fiscal.ts:1822`, `agentes/exito.ts:687`) — este último sí lo tocó `0071f06`.
- **Todo lo que exige Postgres vivo.** Cuanto afirmo de SQL sale de leer la
  migración, no de ejecutarla; `supabase/verificaciones.sql` sigue sin correr.
- **No corrí `npm test` completo** (lo corre el orquestador): solo los cuatro
  archivos citados.
