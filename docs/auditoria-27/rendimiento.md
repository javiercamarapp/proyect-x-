# Rendimiento y costo — auditoría 27

**Nota: 5/10** (antes 6). Razón del movimiento: **deuda que cobró factura.** En
181 commits y +27,031 líneas **no se tocó ni una línea de los siete archivos que
la 26 dejó abiertos** —lo verifiqué con `git diff --numstat a3c1560..HEAD` sobre
`intake/rep.ts`, `cron/descarga-sat/route.ts`, `sat_descarga/peaje_cierre.ts`,
`facturacion/adaptadores/piloto_vision.ts`, `asistencia_escalamiento.ts`,
`intake/ocr.ts`, `presupuesto.ts`, `llm/openrouter.ts`, `llm/budget.ts` y
`llm/models.ts`: **SIN CAMBIOS los diez**— y, mientras el hallazgo estaba
abierto, el patrón defectuoso se **copió literalmente** a un cron nuevo:
`src/app/api/cron/gps/route.ts:32-37` dice «molde de `descarga-sat`» y adopta el
mismo `MARGEN_RELOJ_MS = 20_000` que la 26 había marcado como ALTO por
insuficiente — sobre una unidad atómica que aquí no cuesta 38 s sino ~114 s.
Ésa es exactamente la regla del rubro 8 aplicada a éste: una advertencia que
vuelve a ocurrir no es advertencia, es hallazgo.

**El riesgo mayor hoy:** sigue siendo `ingerirRep` — dos a **tres** consultas
por `DoctoRelacionado`, cero miradas al reloj, en dos rutas donde la muerte por
timeout deja la fila de dedup puesta y el REP se pierde para siempre en
silencio. Un año entero de commits pasó por encima sin tocarlo.

## Hallazgos

### [CRÍTICO · REINCIDENTE] `ingerirRep` hace hasta 3 consultas por DoctoRelacionado y NUNCA mira el reloj

`src/lib/likida/intake/rep.ts:190-241` — los dos `for` anidados; `:195`
(`rep.registrar`), `:220` (`rep.sellar`), `:236` (`rep.buscarGasto`).
Llamadores: `src/lib/likida/processor.ts:1445`, `:1796`, `:3099` y
`src/app/api/correo/entrante/route.ts:345`.

Escenario: el contador de la flota reenvía por correo el REP mensual de su
cliente grande — **un XML que ampara 150 facturas**, todas con
`ImpSaldoInsoluto = 0`, ninguna todavía capturada como `gasto` en Likida (el
caso normal cuando el REP llega antes que la factura, que el propio código
contempla en `:232-238`). Entra ese correo → salen **450 consultas
secuenciales**: `upsert` a `cfdi_pago` + `update` a `gasto` + `select` de
respaldo por docto. A los **0.3 s** por consulta que la contabilidad del repo
declara (`presupuesto.ts:88`), son **135 s** contra los **57,000 ms** de
presupuesto de la ruta (`correo/entrante/route.ts:88` `maxDuration = 60`,
`:284-285` `RESERVA_PARA_LIBERAR_MS = 3_000`). El corte real llega a los
**63 doctos** (57,000 / 900), no a los 95 que la 26 calculó con dos consultas.
Por WhatsApp, contra los 80,400 ms utilizables del webhook
(`maxDuration = 120` − `MARGEN_CIERRE_MS` 39,600 medido), el corte es de **89
doctos**. El techo duro por consulta es `TECHO_PASO_CONSULTA_MS` = 9.5 s
(`presupuesto.ts:83`), así que basta con que la base vaya lenta para que ~7
doctos agoten el correo entero. No hay tope de cardinalidad: `parseRepXml`
(`:114-147`) acepta todos, y a ~600 B por nodo los 4 MB de `MAX_ADJUNTO_BYTES`
(`correo/entrante/route.ts:78`) dan del orden de **6,900 doctos**.

El reloj del correo (`restanteMs()`, `:287`) se consulta exactamente dos veces
—antes de pedir la URL firmada y antes de bajar el binario— y **nunca** dentro
ni alrededor de `ingerirRep`, que es la única llamada del bucle cuyo costo no
está acotado.

Consecuencia: la ruta documenta su propio desenlace (`:271-283`): al morir NO
corre el `delete` que libera la fila de dedup, **el correo queda marcado como
procesado sin haberlo sido**, el reintento de Resend sale por `ya_procesado` y
el CFDI se pierde. Y no hay progreso posible entre intentos: los `upsert` con
`ignoreDuplicates` cuestan una consulta cada uno igual, así que un reenvío
recorre el mismo camino y muere en el mismo punto. El REP es el complemento que
libera el IVA acreditable (LIVA 5-III): el contralor cierra el mes con IVA que
pagó y no puede acreditar, y nada en el log apunta aquí.

Causa raíz probable: el bucle se escribió para el REP de un ticket (1-3 doctos)
y no tiene ni tope de cardinalidad ni reloj, en dos rutas que sí presupuestan
todo lo demás que hacen.

---

### [ALTO] El cron nuevo de GPS copió el margen de 20 s de `descarga-sat` sobre una unidad atómica de ~114 s

`src/app/api/cron/gps/route.ts:37` (`MARGEN_RELOJ_MS = 20_000`), `:84`
(`venceEn = Date.now() + 300_000 − 20_000`), consumido por
`src/lib/likida/conectores/sincronizar_eventos.ts:487` (el chequeo de reloj
dentro de `drenarGravesPersistidos`) y `:507`
(`dispararAsistenciaPorEventoCamara`).

El reloj corta **antes** de despachar cada evento grave, así que el margen tiene
que cubrir el peor caso de UN disparo completo. Lo sumé consulta por consulta
sobre `src/lib/likida/asistencia_camara.ts:128-243`, camino «abre expediente
nuevo», a `TECHO_PASO_CONSULTA_MS` = 9.5 s cada una:

| Paso | `archivo:línea` | Consultas | Techo |
|---|---|---|---|
| `expedienteAbierto` | `asistencia_camara.ts:90` | 1 | 9.5 s |
| `crearIncidencia` (`viajePropio` + `unidadPropia` + `operadorPropio` + insert) | `operacion.ts:1212`, `:1215`, `:1224`, `:1227` | 4 | 38 s |
| `anotarEventoIncidencia` | `asistencia_wa.ts:177` | 1 | 9.5 s |
| `telefonoJefeDe` → `telefonosJefe` (`traerTodo` **sin `conteo()`** = 2 viajes) + `ordenesAvisoDe` | `contactos.ts:202-212`, `:234` | 3 | 28.5 s |
| `rotuloUnidad` | `asistencia_camara.ts:103` | 1 | **sin techo** |
| `encolarSalidaWhatsAppDedupe` | `wa_outbox.ts:20` | 1 | 9.5 s |
| `anotarEventoIncidencia` (aviso) | `asistencia_camara.ts:232` | 1 | 9.5 s |
| `finalizarGrave` (RPC) | `sincronizar_eventos.ts:431` | 1 | 9.5 s |

**Total: 13 consultas, ~114 s acotados más una sin acotar** — `rotuloUnidad`
(`asistencia_camara.ts:103`) es `await supabaseAdmin().from('unidad')…` **sin
`acotada()`**: es la única consulta de la cadena de alerta que no puede
expirar, y si Supabase acepta la conexión y calla, la corrida se cuelga hasta
que la mata Vercel.

Escenario: un blip de Supabase que no tira la conexión, solo la vuelve lenta.
El último choque pendiente pasa el chequeo del reloj a los 279.999 s; su disparo
termina a **~394 s** contra `maxDuration = 300`.

Consecuencia: Vercel mata la función a los 300 s. No se escribe
`registrarLatido` (`route.ts:180-191`) — el modo de falla mudo que el
comentario de `sincronizar_eventos.ts:23-30` dice estar arreglando. Y la fila
del choque quedó arrendada con `p_lease_segundos: 360`
(`sincronizar_eventos.ts:396`) mientras el cron corre **cada 5 minutos**
(`vercel.json:35-36`): la corrida siguiente, a los 300 s, **no puede
reclamarla** porque el lease no ha vencido. El 🚨 de una colisión real espera
como mínimo **10 minutos** y nadie lo sabe. La segunda fase (posiciones,
`route.ts:96`) comparte el mismo `venceEn` y hereda el desbordamiento entero.

Causa raíz probable: el margen se copió del cron que la 26 ya había marcado
como insuficiente, sin recalcularlo contra los techos que el propio repo impone
para la cadena que este cron sí ejecuta.

---

### [ALTO · REINCIDENTE] El margen del cron del SAT (20 s) sigue siendo la mitad de lo que cuesta una vuelta de sus dos bucles

`src/app/api/cron/descarga-sat/route.ts:81-82` (`MARGEN_MS = 20_000`),
consumido por `src/lib/likida/sat_descarga/ciclo.ts:277` y
`peaje_cierre.ts:318`. Verificado sin cambios desde la 26.

Escenario y aritmética, reconfirmados: `ingerir` camino `casado` = 4 consultas
`acotada` × 9.5 s = **38 s**; `avisarCierrePeaje` para una flota =
`peaje_cierre.reservar` (9.5) + `telefonoParaDineroDe` (9.5) + `sendText`
(`TECHO_ENVIO_WHATSAPP_MS` = 10, `presupuesto.ts:47`) + `soltarReserva` (9.5) =
**38.5 s**. El chequeo pasa a los 279.999 s → la vuelta termina a ~318 s contra
`maxDuration = 300`.

Consecuencia: el sello `peaje_cierre_aviso` queda tomado y no soltado
(`peaje_cierre.ts:387` no llega a correr), esa flota nunca recibe el aviso de
ese umbral, y el umbral es un día exacto que no vuelve.

Causa raíz probable: el margen se dimensionó contra el costo nominal de una
vuelta y no contra los techos escritos en `presupuesto.ts`.

---

### [ALTO · REINCIDENTE] El reloj del piloto de visión vigila el arranque del paso, no su duración: la cadena suma ~400 s contra 300

`src/lib/likida/facturacion/adaptadores/piloto_vision.ts:120`
(`PRESUPUESTO_SESION_MS = 130_000`), `:264-269` (el corte), `:592-602`
(`generateStructured` **sin `signal`**), contra
`src/app/api/cron/facturar/lote.ts:80` (`MARGEN_LOTE_MS = 150_000`), `:453` (el
último hueco que abre sesión) y `src/app/api/cron/facturar/route.ts:32`
(`maxDuration = 300`). Verificado sin cambios desde la 26.

Aritmética reconfirmada: la escalera de `generateStructured` es intento +
reintento por truncamiento + reintento con nota + fallback cross-provider =
**4 × `TIMEOUT_LLM_MS` (30_000, `openrouter.ts:29`) = 120 s**, sin señal que la
acote. El guardia pasa a los 129.999 s → la sesión termina a ~250 s contra los
150 s que el lote le promete; y el lote abre esa sesión hasta el instante
`inicioLote + 149.999 s` → **~400 s contra `maxDuration = 300`**.

Consecuencia: Vercel mata el cron de facturación con el navegador abierto; las
flotas ya resueltas no llegan al `resumen`, no se escribe el latido, y el panel
de facturación no dice ni que corrió ni que falló.

Causa raíz probable: se trató el síntoma (no arrancar tarde) sin acotar la
llamada al proveedor con `signal`, que es lo que REND-A6 sí hizo en la ruta de
QA.

---

### [MEDIO] La cola de eventos de seguridad corre hasta 285 s de consultas después del último chequeo de reloj

`src/lib/likida/conectores/sincronizar_eventos.ts:820-854` — el `for` de
`recuperadosUnicos` (`:825`, un `update` + un `finalizarCuarentena` por evento)
y el `for` de `recuperados.claims` (`:848`, un `finalizarCuarentena` por
claim). **Ninguno de los dos consulta el reloj.**

El último chequeo de la función está en `:797`, dentro del bucle de tandas del
`upsert` — y ese bucle **no corre en absoluto** cuando `filas` viene vacío
(`enTandas([], 200)` devuelve `[]`), que es justo el caso cuando todos los
eventos de la ventana quedaron en cuarentena por unidad sin mapear o por
`sin_aviso_previo` (`:729-761`).

Escenario: una flota recién conectada, con las unidades todavía sin
`gps_device_id` capturado. La cuarentena tiene 10 referencias reclamables
(`p_limite: 10`, `:301`). El reloj vence durante `guardarCuarentena` (`:789`).
Entra la vuelta → salen hasta **10 × (`update` 9.5 s + RPC 9.5 s) = 190 s** en
`:825-847` más **10 × 9.5 s = 95 s** en `:848-854`, todo sin preguntar la hora:
**285 s** después de un `venceEn` que dejaba 20 s de margen.

Consecuencia: se suma al hallazgo anterior. Vercel corta la invocación, la fase
de posiciones nunca corre, no hay latido, y los eventos reclamados quedan
arrendados 360 s bloqueando también la corrida siguiente. Además, el `break`
por reloj de `releerCuarentena` (`:352-355`) sale sin llamar
`finalizarCuarentena` sobre los claims restantes, que ya se llevaron su
`intentos + 1` en la RPC (`0324_gps_poll_durable.sql:356`): ocho cortes por
reloj bastan para que el primer `finalizar` los mande a `muerto_en` sin que
nunca se hayan reintentado de verdad.

Causa raíz probable: el reloj se cableó en los tres bucles que iteran datos del
proveedor y no en los dos que iteran claims de reparación, que son los que más
consultas pagan por elemento.

---

### [MEDIO · REINCIDENTE] `.limit(5000)` que PostgREST corta en 1,000, con un detector de truncamiento insatisfacible

`src/lib/likida/sat_descarga/peaje_cierre.ts:243` (`.limit(TOPE_GASTOS_PEAJE)`,
= 5,000) y `:252` (`const truncado = (gastos ?? []).length >= TOPE_GASTOS_PEAJE`).
Verificado sin cambios desde la 26; `supabase/config.toml:38` sigue en
`max_rows = 1000`.

La consulta pide 5,000 y jamás recibe más de 1,000, así que `1000 >= 5000` es
**falso por construcción** y la alarma que se puso como mitigación no puede
dispararse nunca. El comentario del archivo (`:246-252`) calcula el punto de
dolor con el número equivocado: dice «a 200 flotas», y con el recorte real de
1,000 y ~25 cruces por flota al mes el barrido deja de ver flotas a partir de la
**número 40** — 5× antes. `resumen.gastos` reporta 1,000 como si fuera el
universo.

Consecuencia: a partir de ~40 flotas con casetas, las del final del orden por
`tenant_id` no reciben el aviso de que vence su derecho a facturar casetas, y
ni el log ni el latido lo dicen.

Causa raíz probable: el detector se calibró contra el límite PEDIDO en vez del
APLICADO. `bandeja.ts` lo hace bien: declara truncamiento contra el `count`
exacto de PostgREST.

---

### [MEDIO · REINCIDENTE] Un `traerTodo` sigue sin desempate único y sin `conteo()`

`src/lib/likida/asistencia_escalamiento.ts:189-200` — `.order('abierta_en',
{ ascending: true })` como orden ÚNICO y `.select()` sin `conteo()`. Verificado
sin cambios desde la 26. Barrí de nuevo los ~240 sitios de `traerTodo` del repo
y sigue siendo **el único** con las dos carencias a la vez.

El contrato de `pg.ts:132-135` lo prohíbe explícitamente («la consulta tiene que
venir ordenada por algo ÚNICO»), y sin `count` la única red que queda es la
prueba de la página vacía (`pg.ts:206-209`), que un salto de fila por empate
satisface igual de bien que una lectura completa.

Escenario: `incidencia` acumula más de 1,000 filas abiertas y sin reconocer
(`PAGINA` = 1,000). Dos incidencias con el mismo `abierta_en` —dos botones de
pánico en la misma ráfaga— caen a caballo de la frontera de página; el `range()`
por posición devuelve una dos veces y se salta la otra, y `LecturaIncompleta` no
se dispara.

Consecuencia: una incidencia de asistencia en carretera nunca entra a
`escalarAsistenciasPendientes` y no se escala a ningún nivel; el resultado del
cron reporta el mismo número de `revisadas` sin señal de que faltó una.

---

### [MEDIO · REINCIDENTE] La captura del piloto va al modelo sin acotar, hasta 56 veces por sesión

`src/lib/likida/facturacion/adaptadores/piloto_vision.ts:598` —
`images: captura?.startsWith('data:') ? [captura] : [await comoDataUri(captura)]`.
Verificado sin cambios; siguen siendo los **dos únicos** sitios con `images:`
del repo (el otro, `intake/ocr.ts:417`, sí redimensiona a 1600 px).

La captura de `capturaSegura(pagina)` viaja tal cual, **hasta 14 veces por
sesión** (`PASOS_MAXIMOS = 14`, `:101`), cada una con la escalera de 4 envíos de
`generateStructured` encima: **56 subidas del mismo PNG por sesión** en el peor
caso. La reserva de presupuesto la cuenta a `TOKENS_POR_IMAGEN` = 4,000
(`openrouter.ts:503`), o sea que el tamaño real del archivo no se refleja en
ningún tope ni en ningún log — solo en el tiempo de subida, que es justo el que
el hallazgo del piloto dice que no cabe.

Consecuencia: el ancho de banda de la sesión, que es lo que decide si los 130 s
alcanzan, depende de un número que nadie mide ni acota.

---

### [BAJO · REINCIDENTE] La foto principal pasa por `sharp` tres veces; dos resultados se tiran

`src/lib/likida/intake/ocr.ts:405` (`redimensionarParaVision`) contra
`src/lib/likida/intake/cfdi_imagen.ts:115` (el `for (const ancho of
[ANCHO_PRINCIPAL_PX, 1000])` de `decodeCodigosFromImage`). Verificado sin
cambios.

Por foto principal se corren **3 pasadas de `sharp`** sobre el original —1600 px
y 1000 px dentro de `decodeCodigosFromImage`, más 1600 px otra vez en
`redimensionarParaVision`— y las dos primeras se descartan. Sobre un original de
4032×3024 cada `rotate().resize().jpeg()` es del orden de 150-400 ms de CPU: la
tercera es **~0.15-0.4 s de trabajo idéntico y redundante por comprobante**,
dentro de una invocación de 120 s de la que solo 80.4 s son utilizables. Con un
fajo de 8 fotos son ~1.2-3.2 s tirados.

---

## Lo que revisé y está bien

- **El costo por liquidación sigue medido, propagado y concordante — y no
  cambió.** `models.ts:270` `LIQUIDACION_USD = 0.18`; la derivación escrita
  (72,000 tok × $2/1e6 = $0.144 bruto − $0.0197 de caché = $0.125, + 600 × 8 ×
  $10/1e6 = $0.048 → $0.173) reconstruye la medición de `openrouter.ts:958-964`
  sobre 4 liquidaciones reales. `viajeCompleto = $0.18 + 3 × $0.0016 = $0.1848`
  y de ahí sale `techoDerivadoPorDefectoUsd()` sin número a mano en medio.
  **Ni `models.ts`, ni `openrouter.ts`, ni `budget.ts`, ni `presupuesto.ts`
  cambiaron una sola línea en los 181 commits** — así que las nueve
  verificaciones de la 26 sobre esos archivos siguen valiendo tal cual, y las
  volví a confirmar en el fuente.
- **El breakpoint de caché de prompt sigue en el system** (`openrouter.ts:978`),
  que es el bloque grande e invariante; los mensajes que cambian entre vueltas
  no se marcan. Es lo que convierte el reenvío de 72,000 tokens en calderilla.
- **`traerTodo` en los chequeos de propiedad NO paga el viaje de red extra**
  —lo perseguí y me refuté a mí mismo—: `operacion.ts:527`, `:549`, `:561`,
  `:579`, `:589`, `:601` y `:1201` pasan `conteo(d)`, así que un `.eq('id', x)`
  se resuelve con **una** vuelta (`pg.ts:203-207`: `filas.length >= esperadas`
  retorna en la página 0). El que sí paga dos es `contactos.ts:202`
  (`telefonosJefe`), y por eso lo cuento como 2 consultas en la aritmética del
  cron de GPS. `telefonoParaDineroDe` (`contactos.ts:158`) es una sola consulta,
  que es exactamente lo que `PASOS_CIERRE:110` presupuesta.
- **La cuarentena de eventos tiene backoff real, no un reintento sin techo.**
  `0324_gps_poll_durable.sql:386-390`: `siguiente_intento_en = ahora + min(24 h,
  15 min × 2^(intentos−1))` y `muerto_en` a los 8 intentos. La relectura al
  proveedor (`sincronizar_eventos.ts:359`) se autolimita; no es el N+1 de HTTP
  que parecía a primera vista.
- **La escalera de reintentos de Cal.com está acotada y presupuestada.**
  `admin/calcom.ts:109` `REINTENTOS_GET_CALCOM = 1`, `:110` espera máxima 1 s,
  `:156-160` `signalAcotada` deriva el timeout del `venceEn` y lanza si quedan
  menos de 250 ms, `:176-188` la paginación tiene fusible a 10,000 y
  `:350`/`:370`/`:373` chequean el reloj antes de cada página, cada booking y
  cada evento. Solo reintenta GET, y lo dice.
- **El paginador de Samsara mira el reloj por página y sale con `backlog`.**
  `eventos_seguridad.ts:129-191`: fusible `MAX_PAGINAS_DEFENSIVO = 1_000`,
  chequeo de reloj antes de cada página, y los reintentos de 5xx/429 verifican
  `ahora() + espera >= venceEn` antes de dormir (`:161`, `:173`).
- **Los agentes que llaman al modelo en un bucle sí preguntan la hora.**
  `agentes/faq.ts:357-389` corta ANTES de `piezaExistente` y por tanto antes de
  gastar la llamada, con `TOPE_BORRADORES_FAQ` como segundo tope; el comentario
  del propio archivo hace la aritmética (26.95 s por llamada medida, 5 en serie
  = 130 s de 270). Barrí los 16 archivos que llaman `generateStructured` /
  `generateResponse` / `generateWithTools`: ninguno nuevo mete una llamada de
  modelo en un bucle sin reloj ni tope.
- **El cierre no ganó costo de IA con la 0321.** El snapshot nuevo
  (`repo.ts:1163-1174`, `tools.ts:340` y `:457`) es SQL, no modelo, y el
  reintento sigue siendo **uno y no un bucle** (`tools.ts:443-461`): el peor
  caso añade 1 RPC + 1 `computeCuadre` + 2 PDF, cero tokens.
- **El drenado de WhatsApp reparte y acota.** `cron/wa-pendientes/drenado.ts:26`
  `LOTE = 40`, `:29` `ANCHO_POOL = 5`, `:33` `MAX_VUELTAS_QSTASH = 20`, y agrupa
  por chofer para no serializar entre conversaciones distintas.
- **`registrar_estados_wa_meta_lote` no puede entrar en bucle de 503.** Lo
  perseguí como reintento sin techo (`webhook/whatsapp/route.ts:503-505`
  compara `data !== esperados`, y `esperados` es el número de wamids
  DISTINTOS): la RPC deduplica por wamid antes de contar
  (`0337_gps_ronda5_forward.sql:109-136`), así que un lote con `delivered` y
  `read` del mismo mensaje devuelve 1 y coincide. Refutado.
- **El piso de invocaciones ociosas está medido y es deliberado, no un
  hallazgo.** Con `vercel.json` de hoy: 43,200 invocaciones/mes de
  `wa-pendientes`, otras 43,200 de `wa-outbox`, 8,640 de `gps`, 8,640 de
  `asistencia`, 2,880 de `facturar` ≈ **108,000 invocaciones/mes con cero
  clientes**, cada una con al menos `puertaCron` + `leerInterruptor` +
  `registrarLatido`. Es el precio de la compuerta y del latido, y el propio
  `cron/gps/route.ts:87-91` argumenta por qué no se parte en dos crones.

## Lo que NO alcancé a revisar

- **La latencia real Vercel ↔ Supabase.** Todas las sumas usan los techos
  escritos en el repo (`TOPE_CONSULTA_MS` 8 s + 1.5 s de gracia,
  `TECHO_ENVIO_WHATSAPP_MS` 10 s) porque en esta ronda no hay base ni red. Si
  el p99 real fuera mucho mejor, los hallazgos de margen siguen siendo ciertos
  como peor caso pero menos probables.
- **El costo en Postgres del hash de cierre de la 0321.**
  `cierre_insumos_hash` (`0321:90-190`) se calcula **dos veces por cierre** (una
  fuera del lock, `tools.ts:340`, y otra dentro de
  `guardar_liquidacion_tx`), y su CTE `combustible` agrega **todos los gastos de
  diésel del tenant del ejercicio completo** —para una flota de 50 unidades,
  ~15,000 filas— con el `pg_advisory_xact_lock` EXCLUSIVO del tenant tomado.
  Los triggers `trg_00_gasto_serializa_cierre` / `trg_00_ecc_serializa_cierre`
  hacen que TODA escritura de gasto de esa flota espere ese lock. No pude medir
  el plan sin una base viva, así que no puedo decir si un cierre bloquea las
  fotos entrantes 200 ms o los 8 s del `TOPE_CONSULTA_MS`. **Es la primera cosa
  que mediría con la primera flota real dentro.**
- **El tamaño real de la captura del piloto** (hallazgo del piloto): depende de
  Playwright y del portal; sin navegador no pude medir bytes.
- **`guardarYConciliarConsolidado` a escala.** Sigue batcheado en lotes de 10
  (`consolidado.ts:477`) y sin reloj; el archivo dice que un consolidado mensual
  de 500 viajes/día trae «MILES de líneas». No pude fijar cuántas consultas
  cuesta `ligarLineaAGasto` por línea, así que no escribo la suma.
- **Costo por operación de los agentes de fondo** (`agentes/*.ts`, propósito
  `back_office`): solo verifiqué que `corridaAgenteSinMedir` los cobre al alza.
  No medí cuánto gastan de verdad.
- **El peor caso de una liquidación con muchos más de 21 comprobantes.** La
  medición del repo cubre 21; sin una medición de un caso grande no puedo decir
  a partir de cuántos comprobantes la reserva por ronda toca los $0.50 de
  `maxRunUsd`.
- **`npm test` completo.** Me apoyé en la línea base del MAPA (12,168 pasan, 5
  fallos INFRA por falta de loopback IPv6); no volví a correr la suite y no
  toqué código, así que no puedo haberla movido.
