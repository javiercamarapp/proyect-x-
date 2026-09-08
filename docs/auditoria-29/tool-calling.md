# Tool calling — auditoría 29

**Nota: 7/10** (antes 5). Razón del movimiento: **se atacó y subió.** Es la
primera ronda en cinco que recibe líneas en este rubro y las recibió donde
dolía: de los cuatro ALTOS de la 28, **tres están cerrados con prueba que
falla si se revierte el arreglo** (lo verifiqué abriendo la prueba, no el
asunto del commit), y los dos MEDIOS estructurales —`estado_viaje` invisible
para la guardia (7ª ronda) y el analista en el carril de fondo— también.

Lo medido, no recordado: `npx vitest run src/lib/llm src/lib/agents
src/lib/likida/tools_invariantes.test.ts
src/lib/likida/tools_estado_viaje_aud24.test.ts` → **54 archivos, 339 pruebas,
0 fallos** (eran 53/321 en la 26, la 27 y la 28 — tres rondas con el mismo
número, esta lo mueve: +1 archivo, +18 pruebas). El catálogo sigue en **33
tools** (14 `copiloto-tools.ts` + 12 `chat-tools.ts` + 4 `tools.ts` +
`entregar_respuesta` + `proponer_accion` + `entregar_respuesta_admin`);
**ninguna nueva y ninguna rompe la regla de `properties: {}`** — las cuatro
del agente de dinero siguen con `parameters: { type:'object', properties:{},
additionalProperties:false }` (`tools.ts:40`, `:102`, `:182`, `:268`) y el
`tenantId`/`viajeId` sigue saliendo de `ctx`.

Lo que impide el 8 son dos cosas, y las dos son de esta ventana: **un arreglo
de la 28 que no cerró nada porque el candado es un check-then-act sobre un
`await` que el propio ciclo de tools atraviesa con `Promise.all`** (TC-A1), y
**la red de seguridad que se construyó para el copiloto de Javier y no se
copió al analista del cliente** (TC-A2) — el panel que ve el comprador se
quedó con el modo de falla que la consola interna acaba de perder.

**Riesgo mayor hoy:** el contralor le pregunta a «Pregunta a tus datos», las
tools leen sus cifras reales, y el panel contesta «el analista no pudo
responder en este momento» con el turno ya pagado y la red determinística que
existe justo para eso (`analista.ts:479-497`) inalcanzable detrás de la
excepción.

## Estado de los hallazgos abiertos de la 28

| # | Hallazgo de la 28 | Veredicto | Evidencia |
|---|---|---|---|
| 1 | [ALTO] El registro sintético del cierre recuperado tira el snapshot `liq` | **CERRADO** | `processor.ts:1224-1258` trae el snapshot con `getSnapshotCierreLiquidacion` (`repo.ts:1154-1176`, columnas exactas que `resumenCuadre` lee, tipadas en `resumen.ts:28-32`); `guardia.ts:137-140` ya no recalcula: sin snapshot **falla cerrado** con texto neutro y `logger.error('guardia_cierre_sin_snapshot')`. La prueba nueva `processor_cierre_recuperado_snapshot.test.ts` corre con `resumenCuadre` **real** (:145) y afirma que el WhatsApp narra la nota de la fila archivada. Revertir el arreglo la rompe. |
| 2 | [MEDIO] El mismo camino calcula el cuadre DOS veces y tira el primero | **CERRADO** | `processor.ts:1266-1285` (`replyDeCierreRecuperado`) sustituye los dos `cuadrarDesdeDB` de `:4060` y `:4188`; la prueba afirma `expect(cuadrarDesdeDB).not.toHaveBeenCalled()` en los tres casos (`:205`, `:221`, `:238`). |
| 3 | [ALTO] TC-1, 4ª ronda: `estadoDelViaje` sin `copiasDeComprobante` | **CERRADO** | `consulta_chofer.ts:161-171` pide `folio_norm, cfdi_uuid, cfdi_orden` en orden ascendente, `:201-203` aplica `copiasDeComprobante` **y** el filtro `monto > 0` del motor. Cuatro rondas vivo, cerrado. |
| 4 | [ALTO] 5ª ronda: `generateResponse` trata una respuesta truncada como completa | **CERRADO** (abre TC-M1) | `openrouter.ts:422-430` lanza `TruncatedError` **después** de `settle`, y `:458` lo excluye del fallback antes de `isTransientError` (para que el «500» del mensaje no se lea como un 5xx). Cuatro pruebas nuevas en `openrouter_truncado.test.ts:104-158`. El arreglo es correcto; lo que abrió está abajo. |
| 5 | [MEDIO] Terminal con `ok:false` en la última ronda tira `LoopGuardError` y se lleva la tarjeta | **MUTADO** | El síntoma se cerró **solo en el copiloto** (`copiloto.ts:353-383` rescata la tarjeta y devuelve una respuesta degradada). La causa raíz sigue viva en `openrouter.ts:1255-1257`/`:1310`/`:1324`, y **el analista, que es el mismo patrón sobre el panel del cliente, no recibió la red** → TC-A2. |
| 6 | [MEDIO] Dos `proponer_accion` en un turno: solo la última llega a la tarjeta | **REINCIDENTE** | El candado de `copiloto.ts:85-90` se escribe hoy con los MISMOS valores de la 28 en cuanto las dos llamadas van en la misma ronda → TC-A1. |
| 7 | [MEDIO] TC-3, 7ª ronda: `estado_viaje` invisible para `guardiaCifras` | **CERRADO** | `guardia.ts:67-71`: `consultoRespaldo = consultoPolitica \|\| consultoEstadoViaje`, con el cotejo cifra por cifra intacto en `:108-121`. Siete rondas, cerrado. |
| 8 | [MEDIO] El chat del panel corre en el carril de FONDO | **CERRADO** | `analista.ts:327` es `createLlmBudget(..., 'interactivo')` y `budget.ts:19-21` movió el contrato («los chats del dashboard —incluido el analista—»); `analista_presupuesto_carril.test.ts` lo ancla. |
| 9 | [BAJO] El reintento del copiloto pierde el gasto del primer ciclo | **CERRADO** | `copiloto.ts:296-309`, el gemelo exacto de `analista.ts:455-463`; probado en `copiloto.test.ts:206-240` (`0.01 + 0.002 = 0.012`). |
| 10 | [BAJO] El `break` por presupuesto del runner es código muerto | **CERRADO** | `redactor.ts:449-455` propaga el error **tal cual** y `runner.ts:567-570` lo reconoce con `esErrorDePresupuesto`, que atraviesa `cause`. |
| 11 | [BAJO] `BOTON_DE_EMISION` mira el SELECTOR y el inventario trae el TEXTO | **CERRADO** (abre TC-M3) | `computer_use.ts:353-355`: `esBotonDeEmision` mira el texto del botón del último inventario. Sigue sin cablear (`registro.ts:459` registra `crearPilotoVision`). |
| 12 | [BAJO] `copiloto-acciones.ts:165` promete una «doble confirmación» que no existe | **CERRADO** | `copiloto-acciones.ts:172`. |
| 13 | [BAJO] `generateStructured` etiqueta todo el turno con un solo modelo | **MUTADO** | `openrouter.ts:678-685` ya produce `costoPorModelo`… y **nadie lo consume**: el único llamador que registra costo de OCR sigue en `ocr.ts:775` con `res.model` + `res.cost` → TC-B2. |
| 14 | [BAJO] `FaseCosto` sin renglón para el copiloto ni el runner | **REINCIDENTE** | `costos.ts:41` sigue con `'ocr' \| 'cuadre' \| 'escalacion' \| 'chat' \| 'router' \| 'whatsapp' \| 'transcripcion'`. |
| 15 | [BAJO] TC-B6: `guardar_liquidacion` devuelve el expediente completo al modelo | **REINCIDENTE, declarado** | `tools.ts:511` → `openrouter.ts:1312` serializa `exec.result` como `content` del mensaje `role:'tool'`. El commit `a4e0719` lo dejó fuera **por escrito** y con la razón correcta (exige partir `ToolExecResult`, contrato de todas las tools). Se anota como deuda declarada, no como incumplimiento. |

**Ocho de nueve mayores cerrados con prueba; uno reincidente y uno mutado.**

## Hallazgos

### [ALTO] TC-A1 — REINCIDENTE: el candado de «una sola propuesta por turno» es un check-then-act sobre un `await`, y el ciclo de tools dispara las dos llamadas con `Promise.all`

`src/lib/agents/copiloto.ts:85-90` · `:101` · `:115` · `:116-122` ·
`src/lib/llm/openrouter.ts:1264-1265` · `:1294-1301` ·
`src/lib/llm/tool-executor.ts:392-416` · `:242` ·
`src/lib/llm/runtime-signal.ts:12-14`

La cadena, línea por línea:

1. `copiloto.ts:85` comprueba `ACCIONES_PROPUESTAS.has(ctx.conversationId)` —
   síncrono, sin `await` antes.
2. Para la ÚNICA acción implementada (`apagar_agente`, `copiloto.ts:97`) el
   handler **cede el control** en `await estaApagado(objetivo)` (`:101`);
   `estaApagado` es `async` (`interruptores.ts:258`), así que suspende aunque
   el interruptor venga de caché.
3. El `.set` que cierra el candado ocurre **después** de esa suspensión
   (`:115`).
4. `generateWithTools` lanza todas las tool_calls de la ronda con
   `Promise.all(llamadas.map(async (call) => …))` (`openrouter.ts:1264`), y la
   dedup `inRound` llavea por `nombre:JSON.stringify(args)` (`:1276` →
   `llaveDeCache:931-943`, que solo colapsa a `nombre` las tools **sin**
   `properties`; `proponer_accion` sí las tiene). Dos objetivos distintos = dos
   llaves = dos ejecuciones.
5. `proponer_accion` **no** es `isMutation`, así que `makeExecutor` no la
   serializa (`tool-executor.ts:393` → `:416`), y `executeTool` invoca el
   handler de forma síncrona (`:242` sobre `runWithToolSignal`, que es
   `AsyncLocalStorage.run`). Nada interpone una barrera entre el `has` de A y
   el `set` de A.

Escenario, con valores. Javier escribe **«apaga el agente de cobranza y el
redactor»**. El modelo devuelve en la MISMA ronda dos tool_calls:
`proponer_accion({accion:"apagar_agente", objetivo:"agente:cobranza",
motivo:"manda de más"})` y `proponer_accion({accion:"apagar_agente",
objetivo:"agente:redactor", motivo:"manda de más"})` — los dos están en
`INTERRUPTORES` (`interruptores.ts:38`, `:40`) y los dos están encendidos.
Handler A: `has` → `false`; suspende en `await estaApagado('agente:cobranza')`.
Handler B arranca: `has` → **todavía `false`**; suspende en
`estaApagado('agente:redactor')`. A reanuda y hace `set(runId, cobranza)`,
devuelve `{ok:true, instruccion:'La previsualización quedó armada…'}`. B
reanuda y hace `set(runId, redactor)` — **sobrescribe** — y devuelve el MISMO
`{ok:true}`. `copiloto.ts:342` lee UNA tarjeta: `agente:redactor`.

Consecuencia: **Javier** lee del modelo «armé las dos propuestas» (las dos
tools se lo confirmaron), ve **una** tarjeta, la confirma, y
**`agente:cobranza` sigue encendido** con su cron despachando — el escenario
literal de la 28, con el arreglo puesto. La guardia de cifras no lo tapa:
`cifrasRespaldadas` mira números, no promesas.

Refutación intentada, y falla: (a) para una acción **sin** `await` en el
handler (`correr_runner`) el candado sí funciona, y es justo el caso que la
prueba nueva ejerce — `copiloto.test.ts:125-128` llama al executor **en serie**
(`await` … `await`) con `accion:'correr_runner'`, así que ni la concurrencia ni
la única acción implementada entran en la prueba; (b) no lo tapa `inRound`:
los `args` difieren; (c) no lo tapa el timeout ni la señal: las dos llamadas
son de la misma ronda.

Causa raíz probable: el candado se escribió contra el síntoma observado (dos
`set` seguidos) sin mirar que el mecanismo que produce el par es
`Promise.all`; la única rejilla del repo que sí resuelve esta clase de carrera
—cachear la PROMESA antes del `await`, `tool-executor.ts:391-408`, con su
comentario explicando exactamente esta ventana— vive dos archivos más allá y
solo cubre `isMutation`.

### [ALTO] TC-A2 — MUTADO desde la 28: el analista del panel del CLIENTE se quedó sin la red que el copiloto de Javier acaba de recibir; un tropiezo del primer ciclo tira el turno pagado y hace inalcanzable la red determinística

`src/lib/agents/analista.ts:371-391` · `:479-497` · `:522-525` ·
`src/app/api/dashboard/chat/route.ts:151` · `:172` ·
`src/lib/llm/openrouter.ts:1255-1257` · `:1310` · `:1324` · `:1325-1327` ·
`src/lib/agents/copiloto.ts:353-383` (la red que sí existe, del otro lado)

`ejecutarAnalista` llama `generateWithTools` **sin `catch`** (`:371`) con
`maxToolRounds: 5` y `terminalTools: ['entregar_respuesta']` (`:380`, `:389`).
Si ese primer ciclo lanza, el `finally` (`:522-525`) borra `CAPTURAS` y la
excepción sube al route, que registra el costo como `modelo:'parcial'` y manda
`{t:'error', error:'el analista no pudo responder en este momento'}`
(`route.ts:157-172`). La red determinística de `:479-497` —la que arma una
tabla con lo que las tools SÍ leyeron, «datos reales sin narración le sirven
más al contralor que una disculpa»— está **dentro** del mismo `try`, después
de la llamada: nunca corre.

Escenario, con valores. El contralor pregunta *«¿cómo va mi flota este mes?»*
en `/dashboard`. Rondas 0-3: `kpis_flota` devuelve
`{viajesLiquidados: 128, montoComprobado: 1847320.50, tasaCuadre: 0.94}`,
`serie_gasto`, `top_rutas` y `motor_fiscal` devuelven bien; los cuatro
resultados están en `executed`. Ronda **4** (`round === maxRounds - 1`,
`openrouter.ts:1255`): el modelo pide `entregar_respuesta({bloques:[{tipo:
"texto"}]})` — **permitido por el schema de la tool**, que solo declara
`required: ['tipo']` (`analista.ts:231`). `validarBloques` descarta el
bloque por «texto vacío» (`:63`), `limpios.length === 0` → devuelve `null` →
el handler devuelve `{ok:false, error:'bloques inválidos…'}` (`:242`).
`entregaTerminalAterrizo` lee ese `ok:false` (`openrouter.ts:906-908`),
`entregada` queda en `false` (`:1310`), el `for` termina y sale
`throw new LoopGuardError(5, executed)` (`:1324`), envuelto en
`PartialExecutionError` (`:1327`).

Consecuencia: **el contralor** —el comprador— ve «el analista no pudo
responder en este momento» sobre una pregunta cuyos números el sistema acababa
de leer en ese mismo turno; **la flota** paga cinco completions de un turno que
no entrega nada; **el equipo** ve `chat.analista.fallo` y una fila de
`llm_costo` con `modelo:'parcial'`. Del otro lado del mismo repo, el copiloto
recibió en esta ventana (`23aa775`) exactamente la red que falta aquí
(`copiloto.ts:353-383`: rescatar lo que ya había y devolver una respuesta
degradada honesta), y su propio comentario cita `analista.ts` como el patrón a
imitar — pero solo se copió la mitad del costo (`:296-309`), no la del turno.

Refutación intentada, y falla: (a) no lo tapa el reintento correctivo de
`:414-473`: vive DESPUÉS de la llamada que lanzó; (b) no lo tapa el corte del
loop-guard antes del `Promise.all`, porque aquí la terminal **sí** se ejecuta
(es la excepción A30) y lo que falla es su `ok`; (c) no lo tapa
`fundamentarBloques` ni la guardia: están aguas abajo; (d) no es teórico que
el modelo llegue a la última ronda pidiendo tools — el propio archivo
documenta que flash-lite «a veces contesta en texto plano sin la tool
terminal» (`:409-412`).

Causa raíz probable: `LoopGuardError` se sigue tratando como «el turno no
existió» aunque `executed` traiga lecturas buenas y aunque la tool terminal
haya corrido; el arreglo de la 28 se aplicó al llamador que se estaba
auditando (el copiloto) en vez de a la frontera que los dos comparten.

### [MEDIO] TC-M1 — NUEVO, hijo del arreglo de TC-A3: una respuesta truncada ya no se cree completa, pero ahora se paga y se contabiliza como **cero medido** en los tres agentes de fondo

`src/lib/llm/openrouter.ts:412` · `:422-430` ·
`src/lib/likida/agentes/contenido.ts:316` · `:376-380` · `:410-413` ·
`src/lib/likida/agentes/faq.ts:323` · `:418-422` · `:443-446` ·
`src/lib/likida/agentes/sdr.ts:151-160` · `:227-238` ·
`src/lib/likida/agentes/runner.ts:395-407` · `:752-757` ·
`src/lib/llm/models.ts:278`

`generateResponse` liquida la reserva (`:412`) y **luego** lanza
`TruncatedError` con su `usage` completo (`:428`). Ninguno de los tres
llamadores de fondo lee ese `usage`: los tres tienen un `catch (e)` que anota
`motivoSinModelo = 'el modelo no respondió'` y **no suma nada**
(`contenido.ts:410-413`, `faq.ts:443-446`) o cuenta un `saltado`
(`sdr.ts:236-238`). Los tres corren en modo PLATAFORMA, **sin `budget`**, así
que tampoco hay fila en el ledger: el gasto no queda en ningún lado.

Escenario, con valores. `correrContenidoFiscal` pide un artículo con
`role:'marketing'` (gpt-5.6-luna, `models.ts:112`) y `maxTokens: 1_400`
(`contenido.ts:379`). El modelo escribe 1,400 tokens de salida sobre 2,000 de
entrada y llega al techo: `finish_reason:'length'`,
`usage:{prompt_tokens:2000, completion_tokens:1400}` → `costoContabilizado =
2000×$0.10/1e6 + 1400×$0.60/1e6 = $0.00104`. Antes de `cb6334c` ese texto y ese
costo volvían y `costoUsd` sumaba $0.00104. Hoy sale la excepción: la corrida
se anota con `costoUsd = 0` — **un cero MEDIDO**, no un `null`— y la pieza dice
«el modelo no respondió» sobre una llamada que respondió y se cobró.

Consecuencia: el dinero es de centavos y hay que decirlo; lo que se rompe es la
invariante que estos dos archivos existen para sostener y que citan en sus
propios comentarios («un costo no medido no es cero», ARQ-2,
`faq.ts:423-433`). El repo tiene DOS tratamientos honestos —`null` pegajoso
para «no se midió» y `COSTO_ESTIMADO_USD.corridaAgenteSinMedir = $0.18` para
cargarlo igual (`models.ts:278`)— y el truncamiento no cae en ninguno: entra
como gasto real disfrazado de medición en cero, que es exactamente lo que
`gastoDelDiaUsd` (`runner.ts:395-407`, filtra `.not('costo_usd','is',null)`)
suma contra el techo de `runner.ts:752-757`. Un tema que trunque
sistemáticamente (`sdr.ts` pide asunto **y** cuerpo en 400 tokens) se
reintenta corrida tras corrida, pagando cada vez y anotando cero cada vez.

Refutación intentada, y falla: (a) no lo tapa `noMedido`, que solo se pone
cuando el proveedor omite `usage` — aquí el `usage` viene completo y la
excepción se lo lleva; (b) no lo tapa el ledger, porque en modo plataforma no
hay `budget`; (c) no es hipotético que trunque: el propio `openrouter.ts:290-306`
documenta el caso medido en producción el 28-ago-2026 con `max_tokens: 900`.

Causa raíz probable: el arreglo de TC-A3 cambió el contrato de
`generateResponse` (de «devuelve texto» a «puede lanzar») y se verificó contra
el llamador del hallazgo (`entrevista-agente.ts`, que sí tiene `catch` honesto)
sin barrer los otros cuatro llamadores, tres de los cuales tratan cualquier
excepción como «no hubo llamada».

### [MEDIO] TC-M2 — NUEVO: el piloto de visión es el rol más caro por llamada del repo y no escribe una sola fila en `llm_costo`

`src/lib/likida/facturacion/adaptadores/piloto_vision.ts:620-638` · `:103` ·
`:285-286` · `src/lib/likida/facturacion/adaptadores/registro.ts:459-472` ·
`src/lib/llm/models.ts:140` · `src/lib/likida/costos.ts:41` · `:121`

`decidir()` desestructura **solo** `{ data }` del `generateStructured`
(`:620`): `cost`, `tokensIn`, `tokensOut` y `model` se tiran en la misma
línea. No hay ningún `registrarCosto` en toda la ruta de facturación
(verificado: los 12 llamadores de `registrarCosto` están en `processor.ts`,
`dashboard/chat`, `dashboard/ingesta`, `oficina_wa.ts`, `voz_transcrita.ts` y
`costos.ts`). El ledger de presupuesto sí lo ve —`budget` existe porque
`registro.ts:460` pasa `tenantId`— pero `llm_costo` es otra tabla y es la que
lee todo lo que Javier usa para decidir: `/admin` (`admin/consumo.ts:11`,
`admin/capacidad.ts:40`) y la tool `costo_por_fase_modelo`
(`copiloto-tools.ts:279-293`).

Escenario, con valores. Una flota con 6 portales sin adaptador escrito corre el
lote de facturación. Cada sesión del piloto son hasta **14** llamadas
(`PASOS_MAXIMOS`, `:103`) con `role:'piloto'` = `anthropic/claude-sonnet-5`
($2/$10 por M, `models.ts:140`), cada una con la captura de pantalla adjunta.
Con ~4,500 tokens de entrada (system + inventario + texto de la página +
imagen) y ~400 de salida por paso, son ~$0.013 por paso → **~$0.18 por
portal**, del orden de una liquidación completa
(`COSTO_ESTIMADO_USD.liquidacion = $0.18`). Seis portales = ~$1.10 de una
sola corrida. En `/admin/costo-ia` y en la tool `costo_por_fase_modelo` esa
corrida vale **$0.00**.

Consecuencia: **Javier** —cuya consola existe para responder «¿en qué se me
va el dinero de IA?»— compara el costo por liquidación contra un total que no
incluye el camino más caro por llamada del repo, y la decisión que ese número
alimenta (encender `FACTURACION_PILOTO`, graduar portales a adaptador escrito)
se toma sobre un dato incompleto. `FaseCosto` (`costos.ts:41`) además no tiene
renglón donde ponerlo, así que el hueco no es un olvido de una línea: es el
mismo reincidente #14 de arriba, con un consumidor de verdad detrás.

Refutación intentada, y falla: (a) no lo tapa el ledger de presupuesto: acota
el gasto del tenant, no lo atribuye por fase ni por modelo, y el panel no lo
lee; (b) no lo tapa que el piloto esté detrás de `FACTURACION_PILOTO=si` —
está registrado por flota en `registro.ts:459`, no es código muerto como
`AdaptadorComputerUse`; (c) el copiloto tampoco escribe en `llm_costo` y ahí
**sí** es deliberado y está dicho (`admin/copiloto/route.ts:29`: es gasto de
plataforma, no de una flota) — el piloto es gasto de una flota concreta.

### [MEDIO] TC-M3 — NUEVO: el modo `ensayo` de `AdaptadorComputerUse` no impide el clic físico que emite; solo le quita el nombre a la tool

`src/lib/likida/facturacion/adaptadores/computer_use.ts:368-372` · `:381-393` ·
`:416-424` · `:441-446`

`ensayo` se implementa **quitando `emitir` del catálogo de tools** (`:368`,
y el mensaje al modelo lo dice: *«NO existe herramienta de emitir»*, `:444`).
Pero `clic` sigue en el catálogo con `selector` de texto libre, y el arreglo
de TC-B4 de esta ventana lo enruta a `clicDeEmision` cuando el botón huele a
emisión (`:421`) — que es el camino que de verdad **aprieta** el botón
(`p.hacerClic`, `:385`) y devuelve `EMITIDO` (`:392`). El candado
(`reclamarEmision`) protege contra la emisión **doble**, no contra la emisión
en ensayo: no mira `modo` en ninguna de sus dos ramas.

Escenario, con valores. `facturar(campos, 'ensayo')` sobre un portal con
`<button id="btnSubmit">Timbrar</button>`. El modelo llena los campos y, sin
`emitir` disponible, pide `clic({selector:'#btnSubmit'})` — la única mano que
le queda. `esBotonDeEmision('#btnSubmit')` es `true` por el TEXTO del
inventario (`:355`, el arreglo de TC-B4), entra a `clicDeEmision`, reclama el
candado, **aprieta Timbrar** y le contesta al modelo `EMITIDO`. Se timbra un
CFDI irreversible ante el SAT en el modo cuyo contrato es no emitir.

Consecuencia: la flota queda con un CFDI que nadie pidió (se cancela solo con
acuse del receptor) y el resultado del ensayo miente sobre lo que hizo. **No
está cableado hoy** —`registro.ts:459` registra `crearPilotoVision`, y el
piloto sí veta por código antes de cualquier clic de emisión
(`piloto_vision.ts:488-491`), en los dos modos—, y por eso es MEDIO y no
CRÍTICO; pero es una trampa armada justo debajo del candado que esta ventana
tocó, y `ensayo` es precisamente el modo con el que se estrenaría con el primer
cliente.

Causa raíz probable: el modo se modeló como «qué tools existen» y el veto
físico como «qué botón es», sin cruzarlos: `clicDeEmision` es el único punto
que sabe que un clic emite y es el único que no pregunta en qué modo va.

### [BAJO] TC-B1 — `PartialExecutionError` no lleva `costoPorModelo`: el turno más caro del repo se atribuye a un modelo llamado `parcial`

`src/lib/llm/openrouter.ts:1022-1026` · `:1325-1327` ·
`src/lib/llm/openrouter.ts:853-874` ·
`src/lib/likida/processor.ts:4392-4400` · `:4430-4441` ·
`src/app/api/dashboard/chat/route.ts:157-165`

En el camino de éxito, `processor.ts:4392-4398` escribe **una fila de
`llm_costo` por modelo real** usando `res.costoPorModelo` — el arreglo B23. En
el camino de excepción, `generateWithTools` construye el
`PartialExecutionError` con `(message, err, executed, tokIn, tokOut, costo)`
(`:1327`): los totales viajan, el mapa **no**, porque la clase no tiene el
campo (`:853-874`). El llamador entonces escribe una sola fila con
`modelo:'parcial'` (`processor.ts:4436`, `chat/route.ts:160`).

Escenario, con valores. Cierre de un viaje: rondas 0-2 en
`anthropic/claude-sonnet-5` ($2/$10), la ronda 3 recibe un 503, `complete`
cruza al fallback `openai/gpt-5.6-terra` ($1/$6, `openrouter.ts:97`), la
ronda 4 corre ahí y el turno muere por `LoopGuardError`. `costoPorModelo`
tiene en ese momento `{sonnet-5: $0.121, terra: $0.038}` y se descarta; en
`llm_costo` queda **una** fila `modelo:'parcial', costo_usd: 0.159`.

Consecuencia: el total es correcto (eso ya estaba probado) y la etiqueta es
honesta en el sentido de que no nombra un modelo falso; pero el desglose que la
tool `costo_por_fase_modelo` le enseña a Javier pierde justo el turno en el que
el fallback cross-provider corrió —el único caso donde el desglose importa— y
el dato existía a una asignación de distancia.

### [BAJO] TC-B2 — MUTADO: `generateStructured.costoPorModelo` se produce y no lo consume nadie; el OCR sigue etiquetando el total con el modelo del ÚLTIMO intento

`src/lib/llm/openrouter.ts:678-685` · `:767` ·
`src/lib/likida/intake/ocr.ts:775` · `src/lib/likida/processor.ts:2074` · `:2574`

El arreglo de la 28 (TC-B5) agregó `costoPorModelo` al retorno y a
`StructuredError.usage`, y lo probó en
`openrouter_costo.test.ts:167-197`. Pero un `grep` de `costoPorModelo` sobre
`src/` muestra que **ningún** consumidor de `generateStructured` lo lee: el
OCR —el único camino de este archivo que registra costo— sigue en
`ocr.ts:775` con `costo: { modelo: res.model, …, costoUsd: res.cost }`, donde
`res.model` es `usage.model` del último intento (`openrouter.ts:767`) y
`res.cost` es el acumulado de todos.

Escenario, con valores. Un ticket con `gemini-3.1-flash-lite` ($0.25/$1.50):
intento 1 devuelve JSON malformado (100 in / 400 out = $0.000625), intento 2
recibe 503, el fallback `claude-haiku-4.5` ($1/$5) cierra bien (900 in / 300
out = $0.0024). `processor.ts:2574` escribe **una** fila
`modelo:'anthropic/claude-haiku-4.5', costo_usd: 0.003`, cargándole a Haiku el
gasto de Gemini. Es el mismo renglón que sostiene la decisión medida del
4-ago-2026 («12.5× más barato»), y el que la contamina es el fallback.

Causa raíz probable: se cerró el productor del dato y no el consumidor; la
prueba mide el retorno de la función, no la fila que llega a `llm_costo`.

## Lo que revisé y está bien

- **La regla estructural, en las 33 tools de hoy.** `tools.ts:40`, `:102`,
  `:182`, `:268` (`properties:{}` + `additionalProperties:false`, `tenantId`/
  `viajeId` de `ctx`); `chat-tools.ts:33` (`SIN_PARAMS`), `:63-76`
  (`PARAM_MODO` es un enum cerrado y `modoDe` colapsa cualquier otra cosa a
  `'semanal'`), `:279-284` (`serie` enum), `:372-383` (`tema` sobre
  `TEMAS_NORMATIVOS`); `copiloto-tools.ts:32`. Ninguna tool nueva y ninguna
  decide qué fila se escribe.
- **Las tres tools con texto libre del copiloto validan antes de tocar la
  base.** `copiloto-tools.ts:214-219` (uuid con regex antes del `select`, para
  no mandarle un 22P02 al modelo), `:336-348` (`ficha_cliente` exige ≥2
  letras, desambigua con >1 resultado en vez de adivinar la flota),
  `:308-310` (`bitacora`, filtro opcional sobre una lectura acotada).
- **La segunda puerta del MCP.** `mcp/herramientas.ts:72-101`: el `tenantId`
  sale de la credencial (nunca de los args), el ÁREA se exige **antes** de
  ejecutar (`:83`) y el `safeParse` de zod rechaza los argumentos (`:93`).
  `mcp/herramientas/busqueda.ts:82-88`: `fetch` valida el uuid y lee con
  `getLibroViaje(tenantId, id)` — un id de otra flota no devuelve nada.
- **Idempotencia por EFECTO.** `tool-executor.ts:391-408` cachea la PROMESA
  antes del `await` (con el comentario que explica la ventana exacta que
  TC-A1 vuelve a abrir para las no-mutaciones); `:164-167` rechaza cerrado una
  mutación sin `runId`; `:217-227` techa el lease en 10 renovaciones con
  `.unref()`; `:266-270` sella el éxito FUERA del `try` que decide el resultado
  de la tool; `:279-289` conserva el lease cuando el handler siguió vivo tras
  el timeout.
- **Los dos candados de `guardar_liquidacion` siguen en la tool.**
  `tools.ts:291-298` (`cierrePedidoPorTexto`, calculado por el processor sobre
  el texto, no por el modelo) y `:369-376` (cierre en ceros), los dos LANZAN
  para que el error viaje al modelo; el kill switch de `:307-312` falla
  cerrado.
- **El corte del loop-guard ANTES del `Promise.all`.** `openrouter.ts:1255-1257`:
  con `terminales` vacío —el caso del agente de dinero, `run.ts:72-91` no pasa
  `terminalTools`— una `guardar_liquidacion` pedida en la última ronda no se
  ejecuta. Probado en `openrouter_loopguard.test.ts`, que además ahora afirma
  que el propio `LoopGuardError` carga `executed` (`:66-72`).
- **El error crudo de Postgres no cruza al modelo.**
  `tool-executor.ts:140-147` (`VOCABULARIO_POSTGRES`), con el detalle completo
  en `logger.error`.
- **Truncamiento, ahora en las TRES funciones.** `openrouter.ts:746-754`
  (structured, con reintento al doble de tope), `:1219-1227` (ciclo de tools,
  ANTES de mirar `tool_calls`) y `:422-430` (chat simple, el cierre de esta
  ronda). Las tres lo excluyen del fallback cross-provider a propósito.
- **La reserva no se cobra ante un error de red** en las tres funciones
  (`:404`, `:728`, `:1147-1152`), y `settle` conserva la reserva cuando el
  proveedor omite `usage` (`:411`, `:738`, `:1125-1127`) en vez de liquidar a
  cero.
- **`modelosAisladosDeFallback`** (`openrouter.ts:129-132`) sigue siendo la
  única forma de que un modelo sin plan B se vea; el arreglo de esta ventana
  no tocó `FALLBACK` ni `PRICES`.
- **El piloto de visión, leído entero por primera vez en cuatro rondas.**
  `piloto_vision.ts:453-476` (selector compuesto rechazado, identidad exacta
  contra el inventario, `contar() !== 1` se detiene), `:481-491` (el veto de
  emisión mira `esBotonQueEmite` **y** los cuatro rótulos del botón, en los
  dos modos), `:505-509` (la guarda dura de contraseña, vía `escrituraPermitida`), `:285-286` (un solo
  `LlmBudget` por sesión — cierra L16), `:650-658` (`senalDeSesion` devuelve
  una señal YA abortada si el reloj venció, en vez de agendar un
  `timeout(0)`).

## Lo que NO alcancé a revisar

- **Nada contra Postgres real ni contra los proveedores.** Sin `.env`, sin
  base y sin red: la RPC `reservar_presupuesto_llm` bajo concurrencia,
  `provider:{data_collection:'deny'}` y `reasoning:{enabled:false}` siguen
  siendo contrato declarado. Mismo hueco que la 24, 25, 26, 27 y 28.
- **Ningún hallazgo está reproducido con una prueba EJECUTADA**: el encargo
  prohíbe tocar archivos del repo. TC-A1 lo recorrí paso a paso por el
  interleaving de `Promise.all` → `map` → `executeTool` →
  `AsyncLocalStorage.run` → `await estaApagado`; una prueba que llame al
  executor **sin** `await` entre las dos llamadas (a diferencia de
  `copiloto.test.ts:125-128`) lo reproduce en un archivo.
- **`generateStructured` con audio** (`openrouter.ts:655`, el cast a
  `input_audio`): el fallback de `transcripcion` hacia un modelo sin oído
  sigue sin prueba. Cuarta ronda pendiente.
- **La frecuencia real de TC-A2 y TC-M1**: cuántos turnos del analista mueren
  en la última ronda y cuántas corridas de fondo truncan al mes no se puede
  medir aquí. Lo que sí está leído es que cuando pasa, el panel dice «no pude»
  y la corrida dice «$0.00».
- **`oficina_wa.ts`** (el otro consumidor de `costoPorModelo`, `:256-285`) lo
  leí solo por encima para confirmar que registra por modelo; no audité su
  ciclo completo.
