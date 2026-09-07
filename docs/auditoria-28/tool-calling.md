# Tool calling — auditoría 28

**Nota: 5/10** (antes 6). Razón del movimiento: **mirada más profunda — no es
que empeorara, es que se vio mejor.** El código del rubro no cambió (lo verifiqué
commit por commit: `git log 06b2eca4..HEAD -- src/` son 3 commits y 6 archivos,
los cuatro de producto en `src/app/dashboard/`; ni uno toca `src/lib/llm/`,
`src/lib/agents/` ni `src/lib/likida/tools.ts`), y la suite del rubro mide
IDÉNTICA a la 26 y a la 27 — `npx vitest run src/lib/llm src/lib/agents
src/lib/likida/tools_invariantes.test.ts
src/lib/likida/tools_estado_viaje_aud24.test.ts` → **53 archivos, 321 pruebas, 0
fallos**, tercera ronda con los mismos números. El catálogo también: **33 tools
registradas**, las mismas 33 (14 `copiloto-tools.ts` + 12 `chat-tools.ts` + 4
`tools.ts` + `entregar_respuesta` + `proponer_accion` +
`entregar_respuesta_admin`), ninguna nueva.

Lo que baja la nota es un camino que nadie había abierto en siete rondas y que
mide, no opina: **cuando `guardar_liquidacion` falla a medias, el registro
sintético que lo sustituye NO es equivalente al resultado de la tool — le falta
justo el campo (`liq`) que existe para que el PDF archivado y el WhatsApp del
chofer no puedan narrar dos cuadres distintos.** La red que el repo construyó
tras el CRÍTICO AG-3 tiene el agujero de AG-3 adentro. El 6 anterior decía
«correcto donde importa, sin red en la periferia»; con esto la lectura honesta es
el 5: **el camino feliz funciona y el borde es fe** — y la única prueba que
cubre ese borde (`processor_cierre_parcial.test.ts:142`, `:148`) mockea
`cuadrarDesdeDB` a una constante y `resumenCuadre` a un string fijo, o sea, borra
las dos mitades cuya discrepancia ES el defecto.

**Riesgo mayor hoy:** el chofer y el contralor pueden recibir dos cuadres
distintos del MISMO cierre irreversible, y el disparo no es exótico — es el modo
de falla que el propio repo documentó como real (`guardar_liquidacion` no lee
`ctx.signal`, la tool devuelve `Timeout` y el RPC commitea después). El TC-1 de
tres rondas sigue vivo debajo.

## Hallazgos

### [ALTO] NUEVO — el registro sintético del cierre recuperado tira el snapshot `liq`, y la guardia vuelve a calcular el cuadre en modo degradado: el PDF y el WhatsApp del mismo cierre pueden decir cosas distintas

`src/lib/likida/processor.ts:1216` · `:3989` · `:4108` ·
`src/lib/likida/cuadre/guardia.ts:70-73` · `:107` · `:116` ·
`src/lib/likida/tools.ts:342` · `:511` ·
`src/lib/likida/cuadre/desde_db.ts:57` · `:65` · `:132` · `:205` ·
`src/lib/likida/cuadre/engine.ts:776-790`

La cadena, línea por línea:

1. En el camino feliz, `guardar_liquidacion` devuelve `liq` (`tools.ts:511`): la
   MISMA fotografía que se imprimió en los dos PDF y que `saveLiquidacion`
   archivó, calculada con `{ modo: 'cierre' }` (`tools.ts:342`).
   `guardiaCifras` la usa tal cual (`guardia.ts:70-73` → `:107`) y **no toca la
   base**. Eso es el arreglo del CRÍTICO AG-3 (auditoría 7), y funciona.
2. Cuando la tool reporta `error` con el RPC ya commiteado, `confirmarCierreEnBase`
   fabrica un registro sintético cuyo `result` es
   `{ liquidacion_id, pdf_url, pdf_generado, pdf_contralor_generado }`
   (`processor.ts:1216`). **No lleva `liq`.**
3. Ese registro reemplaza al de la tool en `agentTools` en los DOS caminos de
   recuperación (`:3989` camino feliz, `:4108` camino del `catch`), y llega a
   `guardiaCifras` (`:4234`).
4. `cerro` es `true` (el registro no tiene `error`), pero `snapshotCierre` sale
   `undefined` → `guardia.ts:107` cae al `?? (await cuadrarDesdeDB(tenantId,
   viajeId))` **sin `opciones`**, es decir en `best_effort` (`desde_db.ts:57`),
   mientras lo archivado se calculó en `cierre`.
5. La diferencia entre los dos modos no es cosmética: en `best_effort` tres
   lecturas **degradan en silencio** en vez de lanzar — el perfil (`:65` →
   `{}` → `elegiblePeaje` indefinido), el acumulado del ejercicio (`:132` →
   `{ efectivo: 0, totalCombustible: 0 }`) y las líneas ECC (`:205` → `[]`).
6. `guardia.ts:116` **sustituye la respuesta** por `resumenCuadre(liq, …)` y
   devuelve `forzado: true`, así que ese texto degradado es el que sale por
   WhatsApp.

Escenario, con valores. Anticipo **$12,000.00**. El chofer manda diésel en
efectivo **$6,500.00** (dos cargas), casetas $1,800.00 y viáticos $900.00. La
flota declaró la facilidad del 15% (RFA 2026 regla 2.9) y el ejercicio lleva
$480,000.00 de combustible con $62,000.00 en medios no admitidos. **T1**, dentro
de la tool y en modo `cierre`: `total = 480,000`, tope $72,000, el efectivo cabe
→ `engine.ts:810-822` emite `combustible_efectivo_dentro15` con monto **0** y la
nota *«deducible por la facilidad del 15% … el ejercicio lleva $68,500.00 de
$480,000.00 (14% del total, tope 15%)»*. Ese es el PDF que se archiva y que el
contralor descarga. La tool se pasa de los 40 s en la segunda subida a Storage,
`raceAbort` devuelve `Timeout`, el RPC commitea 400 ms después. **T2**, en la
guardia y en `best_effort`: `getAcumuladoCombustible` —que barre el ejercicio
entero y va bajo `acotada` de 8 s, en el minuto en que la base ya venía
lenta— truena; el `catch` de `desde_db.ts:132` deja `totalCombustible = 0`;
`engine.ts:776-790` entra por `!(total > 0)` y emite `combustible_efectivo` con
la nota *«no se pudo calcular el total de combustible del ejercicio (el contador
no respondió) — la facilidad del 15% no se evaluó. No se afirma deducible ni no
deducible»*, y hace `continue` sin registrar `proporcionDeducible`. Ninguno de
los dos tipos está en `SOLO_CONTRALOR` (`resumen.ts:24-33`), así que la
diferencia sale impresa al chofer bajo «Ojo con esto» (`resumen.ts:65-70`). Con
el perfil caído en vez del contador, lo que cambia es la línea de dinero
**«Peaje 50%: $X (sujeto a elegibilidad)»** (`resumen.ts:96`): está en el PDF y
desaparece del WhatsApp.

Consecuencia: **el contralor** archiva un PDF que dice «deducible» y **el
chofer** tiene en el celular, del mismo cierre y del mismo minuto, un mensaje que
dice «no se evaluó / se revisa aparte» — capturable en pantalla, sobre un cierre
que los triggers 0036/0037 ya hicieron irreversible; **la flota** no tiene forma
de saber cuál de los dos vale; **el equipo** no ve nada: los tres `catch` que
producen la divergencia escriben `logger.warn` con texto de infraestructura
(`desde_db.perfil_no_disponible`, `desde_db.contador_15_no_disponible`,
`desde_db.ecc_no_disponible`), ninguno dice que acaba de narrarse un cierre
distinto del archivado.

Refutación intentada, y falla: (a) no lo tapa que el viaje quede `liquidado` —el
recálculo lee los mismos `gasto`, el problema no son las filas sino los tres
insumos del ejercicio; (b) no lo tapa el `catch` de `guardia.ts:117`, porque en
`best_effort` estas tres lecturas **no lanzan**, ese es justamente el modo; (c)
no lo tapa la prueba: `processor_cierre_parcial.test.ts:142` fija
`cuadrarDesdeDB` en `{ totalComprobado: 1234 }` y `:148` fija `resumenCuadre` en
`CUADRE REAL (cerrado=…)`, así que T1 y T2 son la misma constante por
construcción y la divergencia es invisible para la suite.

Causa raíz probable: `confirmarCierreEnBase` lee la fila de `liquidacion` (`:1193`)
pidiendo solo `id, pdf_url, revision` cuando esa MISMA fila ya guarda el cuadre
archivado completo —`total_comprobado`, `total_anticipo`, `diferencia`,
`estatus`, `diferencias`, `ieps`, `litros_diesel`, `iva`, `peaje`
(`repo.ts:1146-1162`)—, así que el snapshot que la guardia necesita estaba a un
`select` de distancia y se prefirió recalcularlo.

### [MEDIO] NUEVO — el mismo camino calcula el cuadre DOS veces y tira el primero, en el turno que acaba de quedarse sin reloj

`src/lib/likida/processor.ts:3991` · `:4126` · `:4234-4239` ·
`src/lib/likida/cuadre/guardia.ts:107` · `:116` ·
`src/lib/likida/cuadre/desde_db.ts:58-70` · `:130` · `:205`

Los dos caminos de recuperación arman su propia respuesta con
`reply = resumenCuadre(await cuadrarDesdeDB(op.tenantId, viajeId), true,
'operador')` (`:3991` y `:4126`). Ochenta líneas después, `guardiaCifras`
(`:4234`) recibe ese texto con el registro sintético, no encuentra
`snapshotCierre`, **vuelve a llamar `cuadrarDesdeDB`** (`guardia.ts:107`) y
devuelve `forzado: true`, así que `:4237` **descarta el primer texto** y se queda
con el segundo.

Escenario, con valores. Un cierre recuperado por timeout: cada `cuadrarDesdeDB`
son `getViaje` + `getGastos` + `getConfig` + `getPerfilCrudo` + `getOperador` +
`getAcumuladoCombustible` (barrido del ejercicio completo del tenant, la consulta
más cara del cuadre) + `lineasEccParaCuadre`. Se pagan **dos veces seguidas**,
y ocurre justo después de que `:4221` haya escrito `cierre.sin_margen` porque a
la invocación ya no le queda margen contra `maxDuration`. El primer resultado no
se lee nunca. Y como los dos son `best_effort`, pueden **diferir entre sí**: gana
el segundo, sin que nadie compare.

Consecuencia: **el chofer** espera el doble en el turno que ya iba tarde y es el
que más riesgo tiene de que Vercel mate el proceso antes del PDF (el escenario
que `:4200-4212` describe); **la flota** paga dos barridos del ejercicio por
cierre recuperado; **el equipo** lee `agent.cifras_forzadas` (`:4235`) sobre un
texto que ya era determinístico del motor — la guardia «forzando» un texto que
nadie inventó.

Causa raíz probable: los dos caminos se escribieron para reparar el texto sin
saber que la guardia de abajo iba a sustituirlo igual; el registro sintético sin
`liq` es lo que hace que la guardia no pueda distinguir «este texto ya viene del
motor» de «este texto lo escribió el modelo».

### [ALTO] REINCIDENTE (TC-1, 4ª ronda consecutiva) — el cuarto lector de `gasto` sigue sin `copiasDeComprobante`, y le dice al chofer que ya puede cerrar

`src/lib/likida/consulta_chofer.ts:180` · `:186` · `:222-236` ·
`src/lib/likida/processor.ts:3388`

Reabierto y leído entero: `estadoDelViaje` sigue con
`const comprobado = lista.reduce((s, g) => s + Number(g.monto ?? 0), 0)`
(`:180`) y `comprobantes: lista.length` (`:186`) — sin el predicado del motor y
sin el filtro `monto > 0` que `engine.ts` aplica; el `select` de `:161` ni
siquiera pide `folio_norm`/`cfdi_uuid`, así que no podría deduplicar. El
`case 'faltantes'` (`:222-236`) sigue terminando en
`'Por mi parte no falta nada. Cuando acabes, escribe que terminaste y cierro tu
liquidación.'`

Escenario, con valores (idéntico al de la 27, verificado que sigue vivo):
anticipo $12,000.00; tres comprobantes reales por $6,100.00 mandados con el
protocolo de dos fotos que el repo documenta como normal
(`acuse_ticket.ts:341-346`) → seis filas de `gasto`. `estadoDelViaje` devuelve
`comprobado = $12,200.00` y `comprobantes = 6`; el chofer escribe «¿me falta
algo?» y `responderConsulta` (`processor.ts:3388`) contesta **sin modelo** y hace
`return`: `falta = −200` → sale la frase de arriba con $5,900.00 del anticipo sin
comprobar.

Consecuencia: el chofer cierra creyendo que cubrió el anticipo; el contralor
recibe un PDF que contradice el hilo de WhatsApp. Causa raíz: `62c44f2` arregló
los tres lectores que el hallazgo enumeraba y nadie barrió `from('gasto')`
buscando quién más suma un «comprobado»; el que falta es el único que corre sin
modelo, y por eso ninguna guardia de cifras lo mira.

### [ALTO] REINCIDENTE (5ª ronda) — `generateResponse` trata una respuesta truncada como completa

`src/lib/llm/openrouter.ts:413` · `src/lib/likida/perfil/entrevista-agente.ts:46`
· `:56` · `:61` · `:66-77`

Intacto: `:413` sigue devolviendo
`text: (res.choices[0]?.message?.content ?? '').trim()` **sin mirar
`finish_reason`**, frente a `:695` (`generateStructured`) y `:1147` (el ciclo de
tools, que sí lanza `TruncatedError` y además lo hace ANTES de mirar
`tool_calls`). Sigue sin una sola prueba.

Escenario, con valores: el turno de onboarding (`entrevista-agente.ts:46`,
`maxTokens: 400`, `role: 'chat'`) contesta *«…el estímulo del artículo 20-A de la
LIF 2026 sí aplica al diésel pagado en efectivo siempre que»* con
`finish_reason: 'length'`; no hay excepción, así que el `catch` de `:66` —el que
dice *«No pude explicar con el modelo en este momento, y no voy a inventar la
norma»*— nunca corre, y `:61` devuelve la media frase a
`onboarding-chat/route.ts`. Que el modo de falla es real lo documenta el propio
archivo (`openrouter.ts:288-297`, producción 28-ago-2026). Consecuencia: el
prospecto lee una afirmación fiscal a la que le falta la condición, en la primera
pantalla del producto.

### [MEDIO] REINCIDENTE — una tool terminal que devuelve `ok:false` en la ÚLTIMA ronda tira `LoopGuardError` y se lleva la tarjeta de acción

`src/lib/llm/openrouter.ts:1183-1186` · `:1238` · `:1252` ·
`src/lib/agents/copiloto.ts:210` · `:300-301` · `:311-315` ·
`src/app/api/admin/copiloto/route.ts:317`

Verificado línea por línea, idéntico: en `round === maxRounds - 1` se filtra a
solo terminales (`:1184`); si la terminal devuelve `{ok:false}`,
`entregaTerminalAterrizo` (`:1238`) deja `entregada` en `false`, el `for`
termina y cae en `throw new LoopGuardError(maxRounds)` (`:1252`). El copiloto no
envuelve su primer `generateWithTools` en un `catch`, y el `get` de
`ACCIONES_PROPUESTAS` (`:300`) vive DENTRO del `try`, así que el `finally`
(`:314`) lo borra sin que nadie lo lea: la tarjeta con el botón de apagar nunca
se pinta y el route contesta «el copiloto no pudo responder». Las dos pruebas de
`130e2c7` ponen la falla en la ronda 1, que es donde el arreglo sí funciona.

### [MEDIO] REINCIDENTE — dos `proponer_accion` en un turno: el modelo recibe `ok:true` las dos veces y solo la ÚLTIMA llega a la tarjeta

`src/lib/agents/copiloto.ts:52` · `:86` · `:300-301` ·
`src/app/api/admin/copiloto/route.ts:268-273`

Intacto. `ACCIONES_PROPUESTAS` es un `Map<string, BloqueAccion>` llaveado por
`conversationId` (= `runId`): un cajón por turno. El handler hace `set` (`:86`) y
devuelve el MISMO `ok:true` + *«La previsualización quedó armada»* para la
segunda llamada que para la primera, aunque acabe de sobrescribir la primera.
«apaga el agente de cobranza y el redactor» → dos llamadas con `objetivo`
distinto (así que `inRound`, que llavea por `nombre:JSON.stringify(args)`, no las
dedupea), texto del modelo que afirma las dos, UNA tarjeta en pantalla
(`agente:redactor`), y `agente:cobranza` sigue encendido con su cron despachando.

### [MEDIO] REINCIDENTE (TC-3, 7ª ronda) — `estado_viaje` sigue invisible para `guardiaCifras`

`src/lib/likida/cuadre/guardia.ts:39-41` · `:53` · `:84` · `:116` ·
`src/lib/agents/prompts.ts:79`

Sin cambios: `cuadro` mira solo `cuadrar_viaje` y `guardar_liquidacion`
(`:39-41`), `consultoPolitica` solo `consultar_politica` (`:53`), y el prompt
sigue ORDENANDO la tool en el turno más común («MENSAJE ABIERTO = LLAMA
"estado_viaje" ANTES DE CONTESTAR … ÁBRELE con los números», `prompts.ts:79`). El
chofer escribe «hola» → `estado_viaje` devuelve `copias_excluidas`,
`por_concepto` y `litros_diesel_leidos` → `cuadro=false`,
`consultoPolitica=false`, `tieneCifrasDeDinero=true` → no sale por `:84` y cae al
`try` de `:104`, que sustituye TODO por `resumenCuadre(liq, false, 'operador')`
(`:116`). Se paga la tool por turno abierto para tirar su resultado; y si el
modelo hubiera llamado ADEMÁS `consultar_politica`, `:89-98` sí cotejaría contra
los resultados de todas las tools y el desglose sobreviviría: que el detalle se
conserve depende de una segunda tool que no tiene nada que ver.

### [MEDIO] REINCIDENTE — el chat del panel corre en el carril de FONDO, contra el dominio que el propio módulo declara

`src/lib/llm/budget.ts:17-21` · `src/lib/agents/analista.ts:327` ·
`src/lib/agents/copiloto.ts:188` · `src/lib/agents/run.ts:65`

`budget.ts:18-19` pone «los chats del dashboard» en `'interactivo'` («hay una
persona esperando AHORA») y `:21` pone «analista» en `'fondo'`.
`analista.ts:327` es `createLlmBudget(opts.tenantId, runId, 'fondo')`, mientras
el turno de WhatsApp (`run.ts:65`) y el copiloto de Javier (`copiloto.ts:188`)
sí corren en `'interactivo'`. El único carril de fondo entre los tres canales con
una persona esperando es el del cliente que paga: cuando el día toca
`tope_tenant − reserva_interactivo`, el contralor lee «el analista no pudo
responder» con presupuesto disponible del lado que su panel debería estar usando.

### [BAJO] REINCIDENTE — el reintento del copiloto pierde el gasto del primer ciclo cuando truena

`src/lib/agents/copiloto.ts:248-270` · `src/lib/agents/analista.ts:448-456` ·
`src/app/api/admin/copiloto/route.ts:311-316`

Confirmado abriendo los dos gemelos lado a lado: `analista.ts:448-456` cierra su
segundo `generateWithTools` con `.catch(e => { if (e instanceof
PartialExecutionError) { e.tokensIn += res.tokensIn; e.cost += res.cost; … }
throw e; })`; el bloque equivalente del copiloto (`:248-270`) no lo tiene — solo
suma en el camino de éxito (`:270`). Si el segundo ciclo aborta, el
`PartialExecutionError` que llega a `route.ts:311` trae solo lo del segundo
ciclo, y como el copiloto tampoco escribe en `llm_costo`, ese `logger.info` es el
ÚNICO registro del gasto.

## Reincidentes menores, reabiertos uno por uno — los seis siguen vivos

El detalle vive en `docs/auditoria-26/` y `docs/auditoria-25/`; aquí solo la
verificación de que no se movieron.

- **[BAJO] `FaseCosto` no tiene renglón para el copiloto ni para el runner.**
  `costos.ts:41` sigue con `'ocr' | 'cuadre' | 'escalacion' | 'chat' | 'router' |
  'whatsapp' | 'transcripcion'`. La tool `costo_por_fase_modelo` lee `llm_costo`:
  la herramienta con la que Javier pregunta cuánto cuesta la IA no se cuenta a sí
  misma.
- **[BAJO] El `break` por presupuesto del runner es código muerto.**
  `runner.ts:559` espera `LlmBudgetExceededError` y `redactor.ts:439` lanza
  `DatoInvalido` sin `cause`; la alerta AGB-11 sigue culpando al modelo de un
  tope de dinero.
- **[BAJO] `BOTON_DE_EMISION` mira el SELECTOR y el inventario ya trae el TEXTO.**
  `computer_use.ts:114`, `:380`. Sigue con la reserva de la 27: el adaptador no
  está cableado (`registro.ts:459` registra `crearPilotoVision`).
- **[BAJO] `generateStructured` etiqueta todo el turno con un solo modelo.**
  `openrouter.ts:716` (`model: usage.model`, el del último intento) y `:731`, con
  `gastado` acumulando los tres intentos: los dólares están bien, el reparto por
  modelo no.
- **[BAJO] `guardar_liquidacion` devuelve el expediente completo al modelo.**
  `tools.ts:511` (`liq`) → `repo.ts` → 32 columnas por comprobante con
  `rfc_emisor`, `rfc_receptor`, `cfdi_uuid` e `imagen_url`, serializadas como
  `content` del mensaje `role:'tool'` (`openrouter.ts:1240`). Como `run.ts:72` no
  pasa `terminalTools`, el ciclo sigue y la ronda siguiente reenvía el expediente
  al proveedor. El único lector real es `guardia.ts:70-73`, en memoria del mismo
  proceso. **Nota de esta ronda:** es el mismo campo `liq` cuya ausencia produce
  el ALTO de arriba — hoy viaja de más al proveedor y de menos a la recuperación.
- **[BAJO] `copiloto-acciones.ts:165`** sigue diciendo «Se enciende desde
  Observabilidad (doble confirmación)» en el mensaje de éxito, catorce líneas
  debajo del `revertir` ya corregido, y `encender()` no pide segunda puerta.

## Lo que revisé y está bien

- **La regla estructural, en las 33 tools.** `tools.ts:39`, `:101`, `:181`,
  `:261` — `properties: {}` + `additionalProperties: false`, con
  `tenantId`/`viajeId` desde `ctx`. `chat-tools.ts` y `copiloto-tools.ts` igual,
  con enums cerrados donde hay parámetro y validación antes de tocar la base en
  las tres de texto libre. Ninguna tool decide qué fila se escribe.
- **Corrección a la 27, que declaraba `computer_use` como «la única excepción»:
  son DOS.** `copiloto.ts:62-66` — `proponer_accion` declara `accion` (enum del
  catálogo), `objetivo` (string libre) y `motivo` (string libre). Lo abrí para
  ver si el `objetivo` puede decidir un efecto y **no puede**: el handler solo
  arma una previsualización (`:71-83`), la confirmación exige un `intentId`
  emitido por el servidor con `hashArgsAccion` (`admin/copiloto/route.ts:159-165`)
  y `ejecutarAccionCopiloto:157-160` revalida el `objetivo` contra
  `INTERRUPTORES` antes de apagar nada. Se anota para que el inventario del rubro
  deje de decir «ninguna tool recibe datos del modelo»: una sí, y lo que la
  sostiene es la puerta humana + la revalidación, no el schema.
- **El corte del loop-guard ANTES del `Promise.all`** (`openrouter.ts:1181-1186`):
  una `guardar_liquidacion` pedida en la última ronda no se ejecuta — mutación no
  pagada por un resultado que nadie leería. Comprobado que para el agente de
  dinero `terminales` queda vacío (`run.ts:72` no pasa `terminalTools`), así que
  ahí el corte es total y `executed` no la contiene: los dos caminos de
  recuperación del processor (`:3982`, `:4089`) no se disparan sobre un cierre que
  no ocurrió.
- **Idempotencia por EFECTO, releída entera.** `tool-executor.ts:385-408` cachea
  la PROMESA antes del `await`; `:164-167` rechaza cerrado una mutación sin
  `runId`; `:204-231` pone techo de 10 renovaciones al lease con `.unref()`;
  `:266-270` sella el éxito FUERA del `try` que decide el resultado de la tool
  (un sello perdido degrada a repetir trabajo, no a perder el efecto); `:279-289`
  mantiene el lease cuando el handler siguió vivo tras el timeout y confirma o
  falla con el resultado tardío. Verifiqué además que `guardar_liquidacion` **no**
  matchea `READ_PREFIXES` (`openrouter.ts:819`), así que no entra por el atajo de
  la caché de lectura.
- **La reentrada del mismo mensaje está cerrada aguas arriba**, que es lo que
  hace inofensivo que `mutationEffectKey` lleve `runId` (`tool-executor.ts:353`)
  y que `run.ts:64` genere uno nuevo por turno: el claim atómico de
  `wa_mensaje_procesado` (`conv.ts:571`, RPC `claim_wa_mensaje_procesado` con
  lease/renew/fail) y el mutex de cierre (`processor.ts:3829`, con el tercer
  estado `indeterminado` fallando CERRADO) serializan dos «listo» concurrentes, y
  `:3860` re-verifica que el viaje siga abierto DESPUÉS de tomar el lock.
- **El error crudo de Postgres no cruza al modelo** (`tool-executor.ts:140-147`,
  `VOCABULARIO_POSTGRES`), con el detalle completo en el log.
- **Truncamiento en las dos hermanas que sí lo miran**: `openrouter.ts:695-702`
  (con reintento al doble de tope) y `:1147-1155`, ANTES de mirar `tool_calls`.
- **Atribución de costo por ronda con el modelo que de verdad respondió**
  (`acumularCosto`, `:1130`), consumido por `processor.ts:4019-4027`, que
  escribe una fila de `llm_costo` POR MODELO cuando el ciclo cruzó al fallback.
- **La reserva no se cobra ante un error de red** en las tres funciones (`:423`,
  `:677`, `:1075-1080`), y `settle` conserva la reserva cuando el proveedor omite
  `usage` en vez de liquidar a cero.
- **Los dos candados de `guardar_liquidacion` viven en la tool, no en el prompt**
  (`tools.ts:284-291` y `:361-369`), los dos LANZAN —así que el error viaja al
  modelo como resultado de tool— y el kill switch (`:300-305`) falla cerrado.

## Lo que NO alcancé a revisar

- **Nada contra Postgres real ni contra los proveedores.** Sin `.env`, sin base y
  sin red: la RPC `reservar_presupuesto_llm` bajo concurrencia, `provider: {
  data_collection: 'deny' }` y `reasoning: { enabled: false }` siguen siendo
  contrato declarado. Mismo hueco que la 24, 25, 26 y 27.
- **Ningún hallazgo está reproducido con una prueba EJECUTADA**: el encargo
  prohíbe tocar archivos del repo y vitest no recoge un archivo fuera de la raíz,
  así que las cadenas salen de leer el camino completo. Las dos del ALTO nuevo
  (`processor.ts:1216` → `guardia.ts:70` → `:107` → `desde_db.ts:132` →
  `engine.ts:776`) las recorrí archivo por archivo.
- **La divergencia del ALTO nuevo no está cuantificada en producción**: cuántas
  veces al mes cae un cierre en el camino de recuperación, y con qué frecuencia
  una de las tres lecturas degrada en ese mismo minuto, no se puede medir aquí.
  Lo que sí está medido es que cuando pasa, nadie se entera.
- **`piloto_vision.ts`** (610 líneas) sigue leído solo por encima: usa
  `generateStructured`, no el ciclo de tools, y su veto de emisión está en la
  cabecera. Tercera ronda que se queda pendiente.
- **`generateStructured` con audio** (`:579`, el cast a `input_audio`): el
  fallback de `transcripcion` hacia un modelo sin oído sigue sin prueba.
- **`processor.ts:3860`** — el `return` de «Ese viaje ya quedó cerrado 👍» es el
  único de esa función que no pasa por `soltarClaim()` (el de `:4590` está en el
  `catch`, y el `finally` de `:4600` solo suelta el lock del viaje). No lo reporto
  como hallazgo del rubro —es el claim del mensaje, no la frontera modelo/mundo—
  pero queda anotado para backend.
