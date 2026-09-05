# Tool calling — auditoría 26

**Nota: 6/10** (antes 6). Razón del movimiento: **se atacó y subió, y entró
código nuevo que rompió algo — se compensan**. Cuatro de los cinco hallazgos
que la 25 dejó abiertos están cerrados de verdad y con prueba
(`497769a` CAPTURAS, `130e2c7` tool terminal fallida, `99cc86f` toolSchemas,
`4decc63`+`a86958f` el candado de emisión), y dos archivos de prueba nuevos
—`analista_captura_reintento.test.ts`, `copiloto_captura_reintento.test.ts`—
ejercitan por primera vez el handler REAL de la tool terminal, que era el hueco
que la 25 señaló. Eso es una subida.

Lo que la anula: **TC-1 vuelve a estar cerrado a medias, por segunda ronda
consecutiva, y esta vez el residuo dispara MÁS seguido que el hallazgo
original**. `62c44f2` arregló lo que la 25 nombró —el ORDEN en `tools.ts` y
`repo.ts`— y de paso un tercer lector (el resumen de la ráfaga), pero dejó el
CUARTO, que es el que el chofer lee en cada acuse de cada foto y en cada
«¿cuánto llevo?». El de la 25 necesitaba que el OCR leyera dos montos
distintos; éste dispara con el protocolo normal de dos fotos por ticket,
siempre. Y `130e2c7`, al arreglar bien su hallazgo, convirtió un degradado
suave en un error duro en la última ronda del ciclo.

La regla estructural aguanta: recorrí las **34 tools registradas** (eran 31).
Ninguna nueva; ninguna acepta un dato del modelo que decida sobre dinero o
sobre a quién pertenece una fila. Las 4 del agente de dinero siguen con
`properties: {}`; las 13 del analista son `SIN_PARAMS` o enums cerrados; de las
14 del copiloto, las 3 con texto libre son de la consola superadmin y validan
antes de tocar la base.

**Riesgo mayor hoy:** el chofer sigue recibiendo dos «comprobado» distintos del
mismo viaje —ya no por el orden, sino porque el camino que le contesta el
99 % de las veces (el determinista, sin modelo) no pasa por
`copiasDeComprobante`—, y el segundo lo deja creyendo que ya cubrió el
anticipo.

## Hallazgos

### [ALTO] REINCIDENTE (TC-1, 2º cierre parcial) — el CUARTO lector de `gasto` sigue sumando las copias, y es el que el chofer lee en cada acuse

`src/lib/likida/consulta_chofer.ts:180` · `:161-162` ·
`src/lib/likida/acuse_ticket.ts:225` · `:233` ·
`src/lib/likida/processor.ts:2954` · `:2765` · `:2786` · `:3319`

`62c44f2` cerró la pregunta que TC-1 hacía en tres sitios: `tools.ts:113` y
`repo.ts:967` ordenan los dos por `created_at asc` (verificado, el orden ya no
puede divergir) y `processor.ts:2938-2946` pasa el resumen consolidado de la
ráfaga por `copiasDeComprobante`. Falta el cuarto: `estadoDelViaje`
(`consulta_chofer.ts:153`) suma **todas** las filas —
`const comprobado = lista.reduce((s, g) => s + Number(g.monto ?? 0), 0)`
(`:180`)— y cuenta comprobantes con `lista.length` (`:186`), sin el predicado y
sin siquiera el filtro `monto > 0` que el motor aplica.

No es un camino secundario: es el que contesta primero y sin modelo.
`processor.ts:3319` lo llama para «¿cuánto llevo?» ANTES de que el agente
corra, y `:2765`/`:2786` lo llaman para el acuse y la confirmación de **cada
foto**. Peor: en `:2954` la cola de incidencias del MISMO mensaje que sí
deduplica se arma con `mensajeDemasiadasDudas(dudas, await estadoDelViaje(…))`,
que termina en `lineaDeSaldo` (`acuse_ticket.ts:233`).

Escenario, con valores. Viaje con anticipo **$12,000.00**. El chofer manda el
protocolo que el propio repo documenta como normal (`acuse_ticket.ts:341-346`:
ticket completo + acercamiento al QR) de UN ticket de diésel de **$3,400.00**.
Las dos fotos son legibles → `decidirFoto` da `alta` a las dos → dos filas de
`gasto` con el mismo `cfdi_uuid`. Una de las dos sale con confianza 0.62, así
que entra como «duda» y se dispara la cola de `:2954`. El mensaje que le llega
es, literalmente, las dos cifras juntas:

> 📸 Ya revisé tus fotos. En este viaje llevo **1 comprobante** por
> **$3,400.00**. […] Y hay 1 comprobante que no pude leer con seguridad 🔍. […]
> **Llevas $6,800.00 de $12,000.00, te faltan $5,200.00.**

Y al preguntar «¿cuánto llevo?» a media ruta (`:3319`) recibe
*«Llevas $6,800.00 de $12,000.00 — 2 comprobante(s). Te faltan $5,200.00.»*,
mientras `estado_viaje`, el motor y los dos PDF dicen $3,400.00 y $8,600.00 por
comprobar.

Consecuencia: **el chofer** deja de mandar $3,400.00 de comprobantes porque el
sistema le dijo que ya los tenía, y al cierre el PDF lo deja debiendo esa
cantidad del anticipo; **el contralor** recibe un PDF que contradice el hilo de
WhatsApp que su chofer puede capturar en pantalla —y en el mismo mensaje, dos
párrafos abajo del número bueno—; **el equipo** cree que TC-1 está cerrado
porque el commit tocó tres lectores y `repo_get_gastos.test.ts` está en verde.

Causa raíz probable: el arreglo se guió por los archivos que el hallazgo
enumeraba (`tools.ts`, `repo.ts`) más el que salió al pasar, y nadie barrió
`from('gasto')` buscando quién más suma un «comprobado».

### [MEDIO] NUEVO (regresión de `130e2c7`) — una tool terminal que devuelve `ok:false` en la ÚLTIMA ronda ahora tira `LoopGuardError`: se pierden el reintento correctivo Y la red determinística

`src/lib/llm/openrouter.ts:1238` · `:1184-1185` · `:1248` · `:1252` ·
`src/lib/agents/analista.ts:364` · `:515` ·
`src/app/api/dashboard/chat/route.ts:159`

El arreglo es correcto en su intención: `entregaTerminalAterrizo(exec.result)`
(`:1238`) impide que un `{ok:false}` cierre el turno como si hubiera
entregado. Pero en la última ronda permitida el ciclo ya había filtrado las
llamadas a solo las terminales (`:1184`), así que cuando la terminal devuelve
`ok:false` ahí, `entregada` queda en `false`, el `for` termina y se ejecuta
`throw new LoopGuardError(maxRounds)` (`:1252`) — envuelto en
`PartialExecutionError`. Antes de `130e2c7` ese mismo caso salía por `:1248`
con `finalText: ''`.

Escenario, con valores. Chat del panel, `role: 'chat'` =
`google/gemini-3.5-flash-lite`, `maxToolRounds: 5` (`analista.ts:373`). El
contralor pregunta «compárame el gasto de diésel de este mes contra el
anterior». El modelo gasta cuatro rondas en `serie_gasto`, `kpis_flota`,
`top_rutas` y `motor_fiscal`, y en la ronda 5 llama `entregar_respuesta` con
`bloques: [{ tipo:'cifra', valor:'48000' }]` — el valor como string, que es lo
que un modelo chico hace con un schema sin `strict`. `validarBloques`
(`analista.ts:55`) lo descarta, el handler devuelve
`{ ok:false, error:'bloques inválidos…' }` (`:242`), y ahora eso es
`LoopGuardError`.

`ejecutarAnalista` no envuelve su primer `generateWithTools` en un `catch`
—`:364` … `:515` es `try/finally`, sin `catch`—, así que el error sube al
route y el contralor lee *«el analista no pudo responder en este momento»*
(`route.ts:159`). Antes de este commit, `bloques` quedaba `null`, corría el
reintento correctivo (`analista.ts:407`) y, si tampoco, salía la tabla
determinística *«esto es exactamente lo que el sistema leyó»*
(`:479-489`) con las cifras de las cuatro tools que YA se pagaron. Ahora esas
cuatro lecturas se tiran y se registran como `modelo: 'parcial'`
(`route.ts:150`).

Consecuencia: **el contralor** paga cinco rondas y recibe una disculpa donde
antes recibía sus datos; **el equipo** ve `chat.analista.fallo` con
`LoopGuardError` y va a buscar un modelo que se cicló, cuando lo que pasó es
que entregó mal UNA vez en la ronda equivocada.

Causa raíz probable: la excepción A30 de la última ronda supone que una tool
terminal ejecutada siempre entrega; `130e2c7` rompió ese supuesto sin darle una
salida distinta del `LoopGuardError` genérico. Las dos pruebas que el commit
añadió (`openrouter_loopguard.test.ts`, el caso `ok:false`) usan
`maxToolRounds: 5` con la falla en la ronda 1, que es justo la ronda donde el
arreglo sí funciona.

### [MEDIO] NUEVO — dos `proponer_accion` en un turno: el modelo recibe `ok:true` las dos veces y solo la ÚLTIMA llega a la tarjeta que Javier confirma

`src/lib/agents/copiloto.ts:52` · `:86` · `:300` ·
`src/app/api/admin/copiloto/route.ts:263-266`

`ACCIONES_PROPUESTAS` es un `Map<string, BloqueAccion>` llaveado por
`conversationId` (= `runId`, `copiloto.ts:192`): **un solo cajón por turno**.
El handler hace `ACCIONES_PROPUESTAS.set(ctx.conversationId, bloque)` (`:86`) y
devuelve `{ ok: true, instruccion: 'La previsualización quedó armada y Javier
la verá con botón de confirmar…' }` — el mismo texto para la primera llamada
que para la segunda, aunque la primera acabe de ser sobrescrita. Al armar la
respuesta se lee UNA sola vez (`:300`) y el route crea UN solo intent
(`route.ts:263-266`, `r.bloques.map` sobre un único bloque `accion`).

Nada dedupea esto: `proponer_accion` no es `isMutation` (no pasa por
`makeExecutor`), no casa `READ_PREFIXES` ni está en `readOnlyTools` (no entra a
`crossRound`), y `inRound` llavea por `nombre:JSON.stringify(args)` — con
`objetivo` distinto las llaves son distintas y las dos corren.

Escenario, con valores. Javier escribe: «apaga el agente de cobranza y el
redactor, mañana los vuelvo a prender». El modelo llama
`proponer_accion({accion:'apagar_agente', objetivo:'agente:cobranza'})` y
`proponer_accion({accion:'apagar_agente', objetivo:'agente:redactor'})`, recibe
`ok:true` en las dos, y entrega con `entregar_respuesta_admin` un texto que
dice que dejó listas las dos. En pantalla sale UNA tarjeta —`agente:redactor`—
con un botón. Javier confirma, lee *«Listo: agente:redactor quedó apagado»*, y
se va. **`agente:cobranza` sigue encendido** y su cron sigue despachando sobre
flotas reales.

Consecuencia: **Javier** cree haber bajado dos palancas y bajó una, con el
texto del modelo respaldándolo; **la flota** sigue recibiendo las corridas del
agente que se mandó apagar; **el equipo** no tiene señal: `bitacora_auditoria`
registra el apagado que sí ocurrió y ninguna traza del que no.

Causa raíz probable: el canal lateral de `proponer_accion` se copió del de
`entregar_respuesta` (un cajón por corrida, que ahí es correcto porque la
entrega es una sola) sin decidir qué pasa cuando la tool se llama dos veces —
y el resultado que vuelve al modelo afirma un efecto que el cajón no puede
sostener.

### [BAJO] REINCIDENTE parcial (`a86958f`) — `BOTON_DE_EMISION` mira el SELECTOR, y el inventario ya trae el TEXTO del botón: un portal con `id` opaco vuelve a esquivar el candado por la tool `clic`

`src/lib/likida/facturacion/adaptadores/computer_use.ts:114` · `:380` ·
`:163-172` · `:193-197`

Reserva por delante, igual que la 25: **este adaptador no está cableado**
(`crearPilotoVision` es el que se registra, y ese nunca emite). Lo reporto
porque el cierre de `a86958f` deja una mitad abierta que se puede describir con
precisión. `inventario()` construye el selector de un botón así: `#id` si lo
tiene, `tag[name="…"]` si tiene `name`, y **solo si no tiene ninguno de los
dos** cae a `button:has-text("…")` (`:163-172`); el texto visible del botón
viaja aparte, en el campo `texto` (`:196`). El candado prueba la heurística
contra el SELECTOR — `if (BOTON_DE_EMISION.test(selector)) return
clicDeEmision(selector)` (`:380`) — y nunca contra `texto`, que es el único
campo que de verdad dice lo que el botón hace.

Escenario, con valores. Portal de una gasolinera hecho en ASP.NET (el caso
común de los 37 del catálogo). El inventario devuelve
`{ s: "#ctl00_cph_btnAceptar", texto: "Emitir CFDI" }`. El modelo, que ve las
dos cosas, llama `clic({selector:"#ctl00_cph_btnAceptar"})`.
`BOTON_DE_EMISION` (`:114`, `/emitir|timbrar|facturar|generar.{0,3}factura|…/`)
no casa contra `#ctl00_cph_btnAceptar` → se va por `p.hacerClic(selector)`
(`:381`) sin `reclamarEmision`. El portal re-renderiza y el botón sigue en el
inventario nuevo que el propio resultado devuelve; el modelo lo vuelve a
apretar dentro de las 14 vueltas de `MAX_VUELTAS` (`:84`): **dos CFDI timbrados
ante el SAT** por el mismo ticket, que solo se cancelan con acuse del receptor.

Consecuencia (el día que se cablee): **la flota** con un CFDI duplicado a su
nombre; **el equipo** creyendo que `TC-CANDADO-CLIC-BYPASS` quedó cerrado
porque la prueba usa un selector que sí trae la palabra.

Causa raíz probable: la heurística se copió de `PROHIBIDOS`, que también mira
el selector, sin notar que `inventario()` ya separa selector de texto y que el
selector es justo el campo donde el portal decide si la palabra aparece.

### [BAJO] NUEVO — `FaseCosto` no tiene renglón para el copiloto ni para los agentes del runner: la tool con la que Javier pregunta cuánto cuesta la IA no se cuenta a sí misma

`src/lib/likida/costos.ts:41` · `src/app/api/admin/copiloto/route.ts:257` ·
`src/lib/admin/negocio.ts:149` · `src/lib/agents/copiloto-tools.ts:53`

`FaseCosto` es `'ocr' | 'cuadre' | 'escalacion' | 'chat' | 'router' |
'whatsapp' | 'transcripcion'` (`costos.ts:41`) — no hay valor bajo el cual
escribir un turno del copiloto ni una corrida del Redactor/SDR/Investigador. Y
consecuentemente no hay llamador: los 12 `registrarCosto(` del repo son de
ingesta, chat del dashboard, oficina_wa, voz, processor (ocr y cuadre) y
WhatsApp; el turno del copiloto solo deja `logger.info('copiloto.costo', …)`
(`route.ts:257`) y su fila en el ledger de reservas.
`costo_por_fase_modelo` y `metrica_negocio` salen de `resumen_costo_ia`
(`negocio.ts:149`), que lee `llm_costo`.

Escenario, con valores. Javier abre `/admin/copiloto` y escribe «¿cuánto llevo
gastado de IA hoy?». El copiloto corre 3 rondas en `openai/gpt-5.6-luna`
($0.10/$0.60 por M), llama `costo_por_fase_modelo`, y contesta con el total de
`llm_costo` — que no incluye ni ese turno ni ninguno de los anteriores del
copiloto, ni las corridas del runner nivel 2 del día. La respuesta es correcta
para lo que la tabla tiene y falsa para la pregunta que se hizo.

Consecuencia: **Javier** dimensiona el gasto de IA con una cifra que omite dos
de sus tres consumidores, y la omisión crece justo cuando más usa el copiloto;
**el equipo** no puede cruzar la factura de OpenRouter contra `llm_costo` y
cerrar la diferencia.

Causa raíz probable: `llm_costo` nació como el ledger POR TENANT del producto
(su fase describe el pipeline del cliente) y los dos consumidores internos
—copiloto y runner— se colgaron después de otros mecanismos (`agente_corrida`,
el ledger de reservas) sin que nadie decidiera dónde suman.

## Reincidentes de la 25 verificados uno por uno — todos siguen abiertos

Los abrí y los leí; remito al detalle de `docs/auditoria-25/tool-calling.md`
para no repetirlo.

- **[MEDIO · 5ª RONDA] TC-3: `estado_viaje` sigue invisible para
  `guardiaCifras`.** `guardia.ts:39-41` (`cuadro` solo mira `cuadrar_viaje` y
  `guardar_liquidacion`) y `:53` (`consultoPolitica` solo `consultar_politica`)
  están idénticos. Y el prompt sigue ORDENANDO usar la tool en el turno más
  común: «MENSAJE ABIERTO = LLAMA "estado_viaje" ANTES DE CONTESTAR […]
  ÁBRELE con los números» (`prompts.ts:79`). Con esa respuesta,
  `DINERO_EXPLICITO` (`cifras.ts:22`) casa, `cuadro` y `consultoPolitica` son
  `false`, y se cae al `try` de `guardia.ts:104` (`:107`) que sustituye TODO por
  `resumenCuadre(liq, false, 'operador')` — se tira el desglose por concepto y
  los litros de diésel leídos, que es lo único que `estado_viaje` sabe y el
  cuadre no. Se paga la tool para descartar su resultado. **Cinco rondas es, en
  sí mismo, el dato.**
- **[ALTO · 3ª RONDA] `generateResponse` trata una respuesta truncada como
  completa.** `openrouter.ts:395-415`: sigue leyendo
  `res.choices[0]?.message?.content ?? ''` sin mirar `finish_reason`, frente a
  sus dos hermanas (`:695` y `:1147`). Consumidores intactos y uno más que en
  la 25: `faq.ts:418`, `entrevista-agente.ts:46`, `sdr.ts:151`,
  `contador.ts:98`, `contenido.ts:376`. Ni una prueba lo cubre.
- **[ALTO · 3ª RONDA] El `break` por presupuesto del runner es código muerto.**
  `runner.ts:559` sigue con `e instanceof LlmBudgetExceededError`, y
  `redactor.ts:437` sigue lanzando `new DatoInvalido(…)` **sin `cause`**, así
  que ni `esErrorDePresupuesto` (`budget.ts:67-75`) puede rescatarlo. Su único
  consumidor sigue siendo `processor.ts:4014`. La alerta AGB-11 sigue
  culpando al modelo de un tope de dinero.
- **[MEDIO] El chat del panel corre en el carril de FONDO.**
  `analista.ts:327`: `createLlmBudget(opts.tenantId, runId, 'fondo')`, contra
  el dominio del propio `budget.ts:17-19`, que pone «los chats del dashboard»
  en `'interactivo'` — y `:21` los pone también en `'fondo'`. El documento se
  contradice a sí mismo y el código eligió el carril que la reserva NO protege.
- **[MEDIO] `guardar_liquidacion` devuelve el expediente completo al modelo.**
  `tools.ts:490` (`liq`) → `engine.ts:1809` (`gastos: input.gastos`) →
  `repo.ts:957`, 32 columnas por comprobante con `rfc_emisor`, `rfc_receptor`,
  `cfdi_uuid` e `imagen_url`. `openrouter.ts:1240` lo serializa entero como
  `content` del mensaje `role:'tool'`, y como la tool NO es terminal el ciclo
  sigue: la ronda siguiente reenvía ese expediente al proveedor. El único
  lector real es `guardia.ts:70-73`, en memoria del mismo proceso.
- **[BAJO] `generateStructured` etiqueta todo el turno con un solo modelo.**
  `openrouter.ts:716` (`model: usage.model`, el del ÚLTIMO intento) y `:731`
  (el primario en el camino de error), con `gastado` acumulando los tres
  intentos. Sigue sin el `costoPorModelo` que su hermana sí tiene; el consumidor
  que lo escribe en `llm_costo` es `processor.ts:1818` y `:2252` (`fase:'ocr'`).
- **[BAJO] `copiloto-acciones.ts:165`** sigue diciendo «Se enciende desde
  Observabilidad (doble confirmación)» en el mensaje de éxito, catorce líneas
  debajo del `revertir` (`:49`) que ya se corrigió para decir lo contrario —y
  `encender()` (`interruptores.ts:292`) no pide ninguna segunda puerta.

## Cerrados de verdad (verificados, no por el mensaje del commit)

- **`497769a` — CAPTURAS entre los dos ciclos.** `analista.ts:422`
  (`CAPTURAS.delete(runId)` justo antes del reintento) y `copiloto.ts:247`. El
  llaveo del copiloto coincide (`conversationId: runId`, `:192`), así que el
  `set` de `:140` y el `delete` de `:247` tocan la misma entrada. Los dos
  archivos de prueba nuevos invocan el `toolExecutor` real, que es lo que
  faltaba.
- **`130e2c7` — la tool terminal fallida.** `entregaTerminalAterrizo`
  (`openrouter.ts:839-842`) lee `ok` solo cuando existe, y `:1238` lo aplica.
  El caso central queda resuelto; la regresión de la última ronda va arriba
  como hallazgo aparte.
- **`99cc86f` — `toolSchemas` ya no falla abierto.** `tool-executor.ts:107-117`
  compara pedidos contra encontrados y emite `tool.schema_faltante` con los
  nombres exactos.
- **`4decc63` — el candado durable de `emitir`.** `computer_use.ts:246-262`
  (`reclamarEmision`) y `:264-278` (`sellarEmision`), fail-closed fuera de
  pruebas y con la llave del efecto armada de los campos del ticket
  (`efectoEmitir`, `:213-220`). Cubre la tool `emitir` sin reservas.
- **`62c44f2` — el ORDEN de TC-1.** `tools.ts:113` y `repo.ts:967` ordenan los
  dos por `created_at asc`; `gasto.created_at` es `timestamptz not null default
  now()` (mig. 0001) y `addGasto` (`repo.ts:347`) no lo escribe, así que no
  cambia tras el insert. Esa mitad está bien.

## Lo que revisé y está bien

- **La regla estructural, en las 34 tools.** `tools.ts:36`, `:98`, `:178`,
  `:249` — `properties: {}` + `additionalProperties: false`, con
  `tenantId`/`viajeId` desde `ctx`. `chat-tools.ts`: 10 con `SIN_PARAMS`
  (`:32`), `PARAM_MODO` con tres valores cerrados (`:65`), `proyectar_serie`
  (`:273-275`) y `consultar_normas` (`:369-372`, `TEMAS_NORMATIVOS`) con enums.
  `copiloto-tools.ts`: 11 con `SIN_PARAMS` y las 3 con texto libre validadas
  antes de tocar la base. Ninguna decide qué fila se escribe.
- **Los dos candados de `guardar_liquidacion`, en la tool y no en el prompt.**
  `tools.ts:272-279` (`cierrePedidoPorTexto`, calculado por el processor sobre
  el texto del turno, `processor.ts:3833`) y `:345-353` (`comprobantesReales
  === 0` + `cierreEnCerosConfirmado`). Los dos LANZAN, así que el error viaja
  al modelo como resultado de tool; el kill switch (`:288-293`) vive en el
  mismo sitio y falla cerrado.
- **Idempotencia por EFECTO.** `tool-executor.ts:385-408` cachea la PROMESA
  antes del `await`, llavea por NOMBRE con la nota de por qué eso solo vale
  mientras `properties: {}` se sostenga, y borra el fallo. La llave durable
  incluye `runId` (`:353-355`) y el executor rechaza cerrado una mutación sin
  él (`:164-167`). El techo de renovaciones del lease (`:215-227`, con
  `.unref()`) y el sello tardío del handler colgado (`:279-289`) siguen en pie.
- **Loop-guard.** `openrouter.ts:1181-1185`: corta ANTES del `Promise.all`, con
  la excepción de las terminales; `openrouter_loopguard.test.ts` cubre diez
  variantes.
- **Truncamiento en las dos hermanas que sí lo miran.** `:695-702`
  (`generateStructured`, con reintento al doble de tope en `:743-747`) y
  `:1147-1155` (el ciclo de tools, ANTES de mirar `tool_calls`).
- **Atribución de costo en el ciclo de tools.** `acumularCosto` por ronda con
  `activeModel`, que `complete` ya movió al fallback antes de devolver
  (`:1108-1112`); consumido por `processor.ts:3892-3897` y
  `dashboard/chat/route.ts:119-127`, que escriben una fila de `llm_costo` por
  modelo real. El analista además suma `res2.costoPorModelo` del reintento
  (`analista.ts:464-467`).
- **La reserva no se cobra ante un error de red** en las tres funciones:
  `:423`, `:677` y `:1076-1079`.
- **`llaveDeCache`** (`:864-875`) llavea por NOMBRE solo las tools sin
  parámetros, y guarda los args ORIGINALES junto al resultado cacheado
  (`:1212`, `:1239`).
- **El error crudo de Postgres no cruza al modelo.**
  `tool-executor.ts:140-147` (`VOCABULARIO_POSTGRES`), con el detalle completo
  en el log.
- **El piloto de visión no emite.** `piloto_vision.ts:222-226`. El veto
  `HUELE_A_EMITIR` y el loop-guard por firma repetida siguen como estaban.
- **La confirmación de una acción del copiloto no pasa por el modelo.**
  `route.ts:172-175` exige un `intentId` que emitió el servidor y compara
  `hashArgsAccion(accionId, objetivo)`; `ejecutarAccionCopiloto:160-163`
  revalida el objetivo contra `INTERRUPTORES`. Lo que falla es el conteo de
  propuestas (hallazgo arriba), no la puerta.
- **La suite del rubro está verde.** `npx vitest run src/lib/llm
  src/lib/agents src/lib/likida/tools_invariantes.test.ts
  src/lib/likida/tools_estado_viaje_aud24.test.ts` → 53 archivos, 321 pruebas,
  0 fallos.

## Lo que NO alcancé a revisar

- **Nada contra Postgres real ni contra los proveedores.** No hay `.env`, ni
  base, ni red: la RPC `reservar_presupuesto_llm` bajo concurrencia, el
  comportamiento real de `provider: { data_collection: 'deny' }` y de
  `reasoning: { enabled: false }` siguen siendo contrato declarado. Mismo hueco
  que la 24 y la 25.
- **Empates de `created_at` en `gasto`.** El arreglo de TC-1 depende de que dos
  filas del mismo viaje nunca compartan `created_at` al microsegundo; cada
  `addGasto` es su propia transacción, así que en la práctica no empatan, pero
  no pude comprobarlo contra Postgres. Si algún día se inserta un lote en una
  sola transacción, `now()` sería idéntico y el orden entre empatados vuelve a
  ser indefinido — y puede diferir entre las dos consultas, que piden columnas
  distintas.
- **`generateStructured` con audio** (`:579`, el cast a `input_audio`): el
  fallback de `transcripcion` hacia un modelo sin oído sigue sin prueba;
  `models.ts:145-148` reconoce el hueco. La nueva `tokensPorAudioBase64`
  (`:527-531`) sí tiene prueba (`cota_entrada_audio_aud25.test.ts`), pero es
  una cota declarada, no medida contra el proveedor.
- **`ficha_cliente` con comodines.** `copiloto-tools.ts:341` sigue armando
  `ilike('nombre', '%${q}%')` sin sanear `%`/`_`, al revés que `bitacora.ts:52`.
  No lo reporto porque falla seguro (con >1 coincidencia desambigua) y no pude
  construir un turno donde el modelo emita un `%`; queda anotado por la
  asimetría entre dos tools del mismo archivo.
- **No pude reproducir el hallazgo de la última ronda con una prueba
  ejecutada**: el encargo prohíbe tocar archivos del repo y vitest no recoge
  un archivo fuera de la raíz. La afirmación sale de leer el camino completo
  (`openrouter.ts:1184` → `:1238` → `:1248` → `:1252` →
  `analista.ts:364`/`:515` → `route.ts:159`), no de ejecutarlo.
