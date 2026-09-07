# Tool calling — auditoría 27

**Nota: 6/10** (antes 6). Razón del movimiento: **ninguna de las tres — la nota
no se mueve, y eso es el hallazgo.** No hubo *se atacó y subió* (ningún commit
de los 181 tocó el rubro: `git log a3c1560..HEAD` sobre `src/lib/llm/`,
`src/lib/agents/`, `src/lib/likida/tools.ts` y `consulta_chofer.ts` no trae un
solo arreglo — lo último es `497769a`/`130e2c7`/`99cc86f` del 3-sep, que ya
calificó la 26; `tools.ts` solo lo rozó `eeb7709d`, del PDF). No hubo *deuda
que cobró factura* medible: la base sigue en cero, nada de esto ha corrido
delante de un cliente. Y no puedo declarar *mirada más profunda* sobre el rubro
entero: reauditando encontré exactamente lo que la 26 dejó escrito, con dos
escenarios más afilados y un hallazgo nuevo chico. Los cinco hallazgos abiertos
siguen vivos, los siete reincidentes de la 25 también, y los cinco cierres que
la 26 acreditó **sí aguantan** (los abrí uno por uno, abajo).

La suite del rubro mide idéntico a la 26 — `npx vitest run src/lib/llm
src/lib/agents src/lib/likida/tools_invariantes.test.ts
src/lib/likida/tools_estado_viaje_aud24.test.ts` → **53 archivos, 321 pruebas,
0 fallos**, los mismos números — que es otra forma de decir que aquí no pasó
nada en dos rondas.

**Riesgo mayor hoy:** el camino determinístico que existe *para que un modelo no
pueda equivocar la cifra* (`responderConsulta`, `processor.ts:3388`, contesta
sin LLM y hace `return` antes del agente) es el que la equivoca: cuenta las dos
fotos del mismo ticket como dos comprobantes, y con el protocolo normal de la
casa el chofer llega a leer **«Por mi parte no falta nada. Cuando acabes,
escribe que terminaste y cierro tu liquidación»** con la mitad del anticipo sin
comprobar.

## Hallazgos

### [ALTO] REINCIDENTE (TC-1, 3ª ronda consecutiva, 2º cierre parcial) — el cuarto lector de `gasto` sigue sin `copiasDeComprobante`, y ahora se ve que no solo miente el número: le dice al chofer que ya puede cerrar

`src/lib/likida/consulta_chofer.ts:180` · `:186` · `:191` · `:222-236` ·
`src/lib/likida/processor.ts:3388` · `:2835` · `:2856` · `:3024` · `:3337` ·
`src/lib/likida/acuse_ticket.ts:221-233`

`62c44f2` cerró tres de los cuatro lectores y los verifiqué buenos:
`tools.ts:116` y `repo.ts:996` ordenan los dos por `created_at asc`, y
`processor.ts:3016-3021` pasa el resumen de la ráfaga por
`copiasDeComprobante`. El cuarto sigue igual: `estadoDelViaje`
(`consulta_chofer.ts:153`) suma **todas** las filas —
`const comprobado = lista.reduce((s, g) => s + Number(g.monto ?? 0), 0)`
(`:180`)— y cuenta `lista.length` como comprobantes (`:186`), sin el predicado
del motor y sin siquiera el filtro `monto > 0` que `engine.ts` aplica.

Lo que la 26 describió es el mensaje contradictorio. Lo que se ve al abrir
`armarRespuesta` es peor, y está en el caso `faltantes` (`:222-236`):

```ts
if (e.anticipo > 0 && falta > 0) partes.push(`Te faltan ${mxn(falta)} por comprobar.`);
if (e.enRevision > 0) partes.push(...);
if (partes.length > 0) return partes.join(' ');
...
return 'Por mi parte no falta nada. Cuando acabes, escribe que terminaste y cierro tu liquidación.';
```

Escenario, con valores. Anticipo **$12,000.00**. El chofer manda el protocolo
que el propio repo documenta como normal (`acuse_ticket.ts:341-346`: ticket
entero + acercamiento al QR) de **tres** comprobantes: diésel $3,400.00,
casetas $1,800.00, viáticos $900.00. Seis filas de `gasto`, tres comprobantes
reales por **$6,100.00**. `estadoDelViaje` devuelve `comprobado = $12,200.00` y
`comprobantes = 6`. El chofer escribe «¿me falta algo?» →
`responderConsulta` (`processor.ts:3388`) contesta **sin modelo** y hace
`return`: `falta = 12000 − 12200 = −200` → no entra al `if`, `enRevision` es 0
→ sale la frase de arriba. Escribe *listo*, el motor cierra sobre $6,100.00 y
el PDF lo deja debiendo **$5,900.00** del anticipo, irreversible por los
triggers 0036/0037.

Y en el mismo hilo, minutos antes, el resumen de la ráfaga (`:3016-3021`, el
que SÍ deduplica) le había dicho *«llevo 3 comprobantes por $6,100.00»* — con
la cola de dudas de `:3024` (`mensajeDemasiadasDudas` → `lineaDeSaldo`,
`acuse_ticket.ts:233`) contradiciéndolo dos renglones abajo.

Consecuencia: **el chofer** cierra creyendo que cubrió el anticipo y come
$5,900.00; **el contralor** recibe un PDF que contradice el hilo de WhatsApp
que su chofer puede capturar en pantalla; **el equipo** cree TC-1 cerrado
porque el commit tocó tres lectores y las pruebas están en verde.

Causa raíz probable: el arreglo se guió por los archivos que el hallazgo
enumeraba y nadie barrió `from('gasto')` buscando quién más suma un
«comprobado»; el que faltaba es justo el que corre sin modelo y por eso
ninguna guardia de cifras lo mira.

### [ALTO] REINCIDENTE (4ª ronda) — `generateResponse` trata una respuesta truncada como completa, y su consumidor más expuesto es la primera pantalla que ve un prospecto

`src/lib/llm/openrouter.ts:413` ·
`src/lib/likida/perfil/entrevista-agente.ts:46` · `:56` · `:61` · `:66-77` ·
`src/app/api/dashboard/onboarding-chat/route.ts:95` · `:103-110`

`openrouter.ts:413` sigue devolviendo
`text: (res.choices[0]?.message?.content ?? '').trim()` **sin mirar
`finish_reason`**, frente a sus dos hermanas que sí lo miran (`:695` en
`generateStructured` y `:1147` en el ciclo de tools). Ni una prueba lo cubre.

Lo que la 26 no trazó: `entrevista-agente.ts:46` es el turno de **onboarding**
del panel. `maxTokens: 400`, `role: 'chat'` (`gemini-3.5-flash-lite`), y el
resultado se devuelve crudo — `return { texto: r.text, … }` (`:61`) — hasta
`onboarding-chat/route.ts:103` (`manda({ t:'fin', texto: r.texto })`), directo
a la pantalla.

Escenario, con valores. Un contralor recién dado de alta pregunta en el chat de
onboarding: «¿el estímulo del diésel me aplica si pago en efectivo?». El modelo
arranca la explicación y a los 400 tokens de salida OpenRouter devuelve
`finish_reason: 'length'` con el `content` cortado en
*«…el estímulo del artículo 20-A de la LIF 2026 sí aplica al diésel pagado en
efectivo siempre que»* — la condición viene en la palabra siguiente, que nunca
se escribió. No hay excepción, así que el `catch` de `:66` —el que existe
precisamente para decir *«No pude explicar con el modelo en este momento, y no
voy a inventar la norma»*— **nunca corre**. La media frase sale como respuesta
completa.

Que este modo de falla es real y ya ocurrió en producción lo dice el propio
archivo: `openrouter.ts:288-297` documenta el 28-ago-2026, con
`finish_reason:'length'` y `content: null`, y una corrida del contador
calificada 15/23 «abstención» por una respuesta que nunca se escribió. La
mitigación de ese día fue apagarle el razonamiento al rol `contador`
(`:341`), no detectar el truncamiento — así que el hueco sigue abierto para
los otros cinco consumidores: `faq.ts:418` (600 tokens), `sdr.ts:151` (400),
`contenido.ts:376`, `contador.ts:98` (900) y esta entrevista.

Consecuencia: **el prospecto** lee una afirmación fiscal condicional a la que
le falta la condición, en la pantalla que decide si confía en el producto;
**la flota** puede actuar sobre ella; **el equipo** no ve nada — no hay error,
no hay log, y el aviso honesto que el propio módulo escribió es inalcanzable.

Causa raíz probable: `generateResponse` es la más vieja de las tres funciones y
nunca se le retro-aplicó el control que sus dos hermanas ya tienen.

### [MEDIO] REINCIDENTE (regresión de `130e2c7`, sin tocar) — una tool terminal que devuelve `ok:false` en la ÚLTIMA ronda tira `LoopGuardError`; en el copiloto además se lleva la tarjeta de acción que Javier pidió

`src/lib/llm/openrouter.ts:1183-1186` · `:1238` · `:1248-1250` · `:1252` ·
`src/lib/agents/analista.ts:364` · `:515` ·
`src/lib/agents/copiloto.ts:210` · `:300-301` · `:311-315` ·
`src/app/api/dashboard/chat/route.ts:172` ·
`src/app/api/admin/copiloto/route.ts:303` · `:317`

Verificado línea por línea, idéntico a la 26: en la última ronda permitida el
ciclo filtra a solo las terminales (`:1184`); si la terminal devuelve
`{ok:false}`, `entregaTerminalAterrizo` (`:1238`) deja `entregada` en `false`,
el `for` termina y cae en `throw new LoopGuardError(maxRounds)` (`:1252`),
envuelto en `PartialExecutionError`. Antes de `130e2c7` ese caso salía por
`:1248` con `finalText: ''`.

Lo que la 26 no cubrió: **el copiloto tiene la misma forma y pierde más.**
`copiloto.ts:210` tampoco envuelve su primer `generateWithTools` en un `catch`
(`:209`…`:311` es `try/finally`). `proponer_accion` **no** es terminal, así que
ya corrió en una ronda anterior y dejó su bloque en `ACCIONES_PROPUESTAS`
(`:86`); el `get` que lo rescata está en `:300`, **dentro** del `try`.

Escenario, con valores. Javier escribe «apaga el agente de cobranza, lleva dos
días fabricando piezas raras». El copiloto corre `role:'analisis'`
(`gpt-5.6-luna`), `maxToolRounds: 5` (`:217`): rondas 1-3 en `estado_agentes`,
`traza_corrida` y `guardia`, ronda 4 `proponer_accion({accion:'apagar_agente',
objetivo:'agente:cobranza'})` → `ok:true`, previsualización armada. En la ronda
5 llama `entregar_respuesta_admin` con
`bloques:[{tipo:'cifra', valor:'2'}]` — el valor como string, que es lo que un
modelo hace con un schema sin `strict`. `validarBloques` (`analista.ts:67`) lo
descarta, el handler devuelve `{ok:false, …}` (`copiloto.ts:139`), y eso hoy es
`LoopGuardError`. El `finally` borra `ACCIONES_PROPUESTAS` (`:314`) sin que
nadie lo haya leído, el route contesta *«el copiloto no pudo responder en este
momento»* (`route.ts:317`) y **la tarjeta con el botón de apagar nunca se
pinta**. El único registro del gasto es un `logger.info` con
`modelo:'parcial'` (`:312`).

En el analista es lo que la 26 describió: se tiran las cuatro lecturas ya
pagadas y el contralor recibe una disculpa donde antes recibía la tabla
determinística *«esto es exactamente lo que el sistema leyó»*
(`analista.ts:481-486`).

Consecuencia: **Javier** cree que el copiloto se atoró cuando lo que pasó es
que entregó mal UNA vez en la ronda equivocada, y el agente que mandó apagar
sigue corriendo; **el contralor** paga cinco rondas y recibe una disculpa;
**el equipo** ve `LoopGuardError` y va a buscar un modelo ciclado.

Causa raíz probable: la excepción A30 de la última ronda supone que una tool
terminal ejecutada siempre entrega; `130e2c7` rompió ese supuesto sin darle una
salida distinta del `LoopGuardError` genérico. Las dos pruebas que el commit
añadió (`openrouter_loopguard.test.ts`) ponen la falla en la ronda 1 con
`maxToolRounds: 5` — justo la ronda donde el arreglo sí funciona.

### [MEDIO] REINCIDENTE — dos `proponer_accion` en un turno: el modelo recibe `ok:true` las dos veces y solo la ÚLTIMA llega a la tarjeta

`src/lib/agents/copiloto.ts:52` · `:86-93` · `:300-301` ·
`src/app/api/admin/copiloto/route.ts:268-273`

Intacto. `ACCIONES_PROPUESTAS` es un `Map<string, BloqueAccion>` llaveado por
`conversationId` (= `runId`, `:193`): **un cajón por turno**. El handler hace
`set` (`:86`) y devuelve el MISMO texto de éxito para la segunda llamada que
para la primera, aunque la primera acabe de ser sobrescrita. Se lee UNA vez
(`:300`) y el route crea un intent por bloque `accion`, del que solo hay uno
(`route.ts:271`).

Refutación intentada, y falla: `proponer_accion` no es `isMutation` (no pasa
por el `mutacionesHechas` de `makeExecutor`, `tool-executor.ts:387`), no casa
`READ_PREFIXES` (`openrouter.ts:819`) ni está en `readOnlyTools`
(`copiloto.ts:225` pasa solo `TOOLS_COPILOTO_LECTURA`), así que no entra a
`crossRound`; e `inRound` llavea por `nombre:JSON.stringify(args)`
(`openrouter.ts:1204`) — con `objetivo` distinto las llaves difieren y las dos
corren.

Escenario, con valores. Javier: «apaga el agente de cobranza y el redactor,
mañana los vuelvo a prender». El modelo llama
`proponer_accion({accion:'apagar_agente', objetivo:'agente:cobranza'})` y
`proponer_accion({accion:'apagar_agente', objetivo:'agente:redactor'})`, recibe
`ok:true` en las dos y entrega un texto que dice que dejó listas las dos. En
pantalla sale UNA tarjeta —`agente:redactor`—. Javier confirma, lee *«Listo:
agente:redactor quedó apagado»* (`copiloto-acciones.ts:165`) y se va.
**`agente:cobranza` sigue encendido** y su cron sigue despachando.

Consecuencia: **Javier** cree haber bajado dos palancas y bajó una, con el
texto del modelo respaldándolo; **la flota** sigue recibiendo las corridas del
agente que se mandó apagar; **el equipo** no tiene señal: `bitacora_auditoria`
registra el apagado que sí ocurrió y ninguna traza del que no.

Causa raíz probable: el canal lateral se copió del de `entregar_respuesta` (un
cajón por corrida, correcto ahí porque la entrega es una sola) sin decidir qué
pasa con dos llamadas — y el resultado que vuelve al modelo afirma un efecto
que el cajón no puede sostener.

### [MEDIO] REINCIDENTE (TC-3, 6ª ronda) — `estado_viaje` sigue invisible para `guardiaCifras`: se paga la tool para tirar su resultado, y la asimetría que la rescata es un accidente

`src/lib/likida/cuadre/guardia.ts:39-41` · `:53` · `:84` · `:89-102` · `:116` ·
`src/lib/agents/prompts.ts:79` · `src/lib/likida/tools.ts:162-171`

Sin cambios: `cuadro` solo mira `cuadrar_viaje` y `guardar_liquidacion`
(`:39-41`), `consultoPolitica` solo `consultar_politica` (`:53`). Y el prompt
sigue ORDENANDO la tool en el turno más común: «MENSAJE ABIERTO = LLAMA
"estado_viaje" ANTES DE CONTESTAR […] ÁBRELE con los números»
(`prompts.ts:79`).

Escenario, con valores. El chofer escribe «hola». El agente llama
`estado_viaje`, que devuelve `comprobado: 6100`, `copias_excluidas: 3`,
`por_concepto:[{diesel,3400,1},{casetas,1800,1},{viaticos,900,1}]` y
`litros_diesel_leidos: 178.4` (`tools.ts:162-171`). El modelo narra eso. En la
guardia: `cuadro=false`, `consultoPolitica=false`,
`tieneCifrasDeDinero(reply)=true` → no sale por `:84`, no entra al cotejo de
`:89`, y cae al `try` de `:104` que **sustituye TODO** por
`resumenCuadre(liq, false, 'operador')` (`:116`) — se tiran el desglose por
concepto y los 178.4 litros, que es exactamente lo único que `estado_viaje`
sabe y el cuadre no.

Lo que se ve al mirarlo de nuevo: si el modelo hubiera llamado ADEMÁS
`consultar_politica`, `:89` sí corre y `cifrasSinRespaldo(reply, respaldos)`
(`:96-97`) cotejaría contra los resultados de **todas** las tools sin error —
incluida `estado_viaje` — y el texto con el desglose sobreviviría (`:98`). O
sea: que la respuesta del chofer conserve o pierda su detalle depende de si el
modelo llamó de paso una segunda tool que no tiene nada que ver. Seis rondas es
en sí mismo el dato.

Consecuencia: **el chofer** recibe un resumen de cuadre genérico donde el
sistema ya tenía su desglose; **la flota** paga una llamada de tool por turno
abierto cuyo resultado se descarta por construcción; **el equipo** mantiene un
prompt que ordena usar una tool cuyo valor la guardia borra.

Causa raíz probable: la guardia se escribió cuando solo existían `cuadrar_viaje`
y `consultar_politica`; `estado_viaje` (17-ago-2026) entró al catálogo y nadie
la añadió a la lista de tools que respaldan cifras.

### [MEDIO] REINCIDENTE — el chat del panel corre en el carril de FONDO, contra el dominio que el propio módulo declara; el copiloto de Javier sí va en el interactivo

`src/lib/llm/budget.ts:17-21` · `src/lib/agents/analista.ts:327` ·
`src/lib/agents/copiloto.ts:188` · `src/lib/agents/run.ts:65`

`budget.ts:18-19` pone «los chats del dashboard» en `'interactivo'` («hay una
persona esperando AHORA») y `:21` pone «analista» en `'fondo'`. El código eligió
el carril que la reserva NO protege: `analista.ts:327` es
`createLlmBudget(opts.tenantId, runId, 'fondo')`.

El contraste hace visible el sesgo: el turno de WhatsApp (`run.ts:65`) y el
copiloto de Javier (`copiloto.ts:188`) sí corren en `'interactivo'`. El único
carril de fondo entre los tres canales con una persona esperando es el del
**cliente que paga**.

Escenario, con valores. Una flota con `tope_tenant` de $5.00/día pasa la mañana
liquidando: el OCR y los cuadres consumen hasta tocar
`tope_tenant − reserva_interactivo`. A las 15:00 el contralor abre
`/dashboard` y pregunta «compárame el diésel de este mes contra el anterior».
`reserveLlmBudget` devuelve `tope_proposito` y lanza
`LlmBudgetExceededError('proposito', …)` con el mensaje *«presupuesto de IA de
fondo agotado por hoy … la reserva restante es del camino interactivo — el
chofer no se queda sin servicio por un lote de fondo»* (`budget.ts:38-40`). El
ciclo lo envuelve en `PartialExecutionError` y el contralor lee *«el analista no
pudo responder en este momento»* (`chat/route.ts:172`) — con presupuesto
disponible del lado que su propio panel debería estar usando.

Consecuencia: **el contralor** —el comprador— es el primero al que se le apaga
la IA, y es el único de los tres que no está protegido; **el equipo** tiene un
documento que se contradice a sí mismo en cuatro renglones, así que el próximo
llamador va a elegir mal.

Causa raíz probable: `'fondo'` se eligió por «no es el chofer» sin releer el
dominio que el mismo bloque define tres líneas arriba.

### [BAJO] NUEVO — el reintento del copiloto pierde el gasto del primer ciclo cuando truena: el arreglo M28 que su gemelo sí tiene nunca se copió

`src/lib/agents/copiloto.ts:248` · `:272` ·
`src/lib/agents/analista.ts:448-456` ·
`src/app/api/admin/copiloto/route.ts:311-316`

`copiloto.ts` se declara «espejo de analista.ts … mismas garantías» (`:4-5`).
En el camino de éxito lo es (`:272` suma `res2.cost`), pero el reintento
(`:248`) **no lleva el `.catch`** que su gemelo sí tiene:

```ts
// analista.ts:448-456 — ausente en copiloto.ts
}).catch((e: unknown) => {
  if (e instanceof PartialExecutionError) { e.tokensIn += res.tokensIn; e.cost += res.cost; … }
  throw e;
});
```

Escenario, con valores. Javier pregunta algo que dispara el reintento
correctivo (el modelo contestó en texto plano). Primer ciclo: 5 rondas en
`gpt-5.6-luna` ($0.10/$0.60 por M) con `traza_corrida`, `bandeja` y
`metrica_negocio`. Segundo ciclo: se lleva los 40 s del `AbortController`
(`:207`) y aborta. El `PartialExecutionError` que llega al route trae **solo**
lo del segundo ciclo; `route.ts:311` loguea `copiloto.costo` con
`modelo:'parcial'` y una cifra que omite el ciclo entero que ya se pagó.

Consecuencia: **Javier** mide el gasto del copiloto con una cifra que
subcuenta justo en el modo de falla que más consume — y como el copiloto
tampoco escribe en `llm_costo` (reincidente de abajo), ese log es el ÚNICO
registro que existe; **el equipo** no puede cuadrar la factura de OpenRouter
contra nada. El tope duro del tenant sí queda bien: las reservas del primer
ciclo ya se liquidaron en la RPC.

Causa raíz probable: el reintento se copió de `analista.ts` antes de que M28
(auditoría 18) le añadiera el `.catch`, y nadie volvió a sincronizar los dos
gemelos.

## Reincidentes menores verificados uno por uno — todos siguen abiertos

Los abrí y los leí; el detalle vive en `docs/auditoria-26/tool-calling.md` y
`docs/auditoria-25/tool-calling.md`.

- **[BAJO] `FaseCosto` no tiene renglón para el copiloto ni para el runner.**
  `costos.ts:41` sigue siendo `'ocr' | 'cuadre' | 'escalacion' | 'chat' |
  'router' | 'whatsapp' | 'transcripcion'`. Los 12 llamadores de
  `registrarCosto` son de ingesta, chat del dashboard, oficina_wa, voz,
  processor y WhatsApp; el turno del copiloto solo deja
  `logger.info('copiloto.costo')` (`admin/copiloto/route.ts:263`). La tool
  `costo_por_fase_modelo` (`copiloto-tools.ts:288`) lee `llm_costo`: la
  herramienta con la que Javier pregunta cuánto cuesta la IA no se cuenta a sí
  misma.
- **[BAJO] El `break` por presupuesto del runner es código muerto.**
  `runner.ts:559` sigue con `e instanceof LlmBudgetExceededError`, y
  `redactor.ts:439` sigue lanzando `new DatoInvalido('El Redactor no pudo
  escribir en este momento…')` **sin `cause`**. Comprobado el camino completo:
  `generateStructured` SÍ conserva el error de presupuesto (`conGastado`,
  `openrouter.ts:730`, deja el original en `.cause`), así que
  `esErrorDePresupuesto` (`budget.ts:67-75`) lo rescataría — muere en el
  `catch` del redactor. La alerta AGB-11 sigue culpando al modelo de un tope de
  dinero.
- **[BAJO] `BOTON_DE_EMISION` mira el SELECTOR y el inventario ya trae el
  TEXTO.** `computer_use.ts:114`, `:380`. `inventario()` arma el selector con
  `#id` / `tag[name=…]` y solo cae a `button:has-text("…")` si no hay ninguno
  (`:163-169`); el texto visible viaja aparte en `texto` (`:198`). Un
  `{ s:"#ctl00_cph_btnAceptar", texto:"Emitir CFDI" }` esquiva la heurística y
  se va por `p.hacerClic` sin `reclamarEmision`. **Reserva:** verifiqué que
  `AdaptadorComputerUse` (`:291`) no tiene una sola instanciación fuera de
  pruebas — el registrado es `crearPilotoVision` (`registro.ts:459`), y ese no
  emite (`piloto_vision.ts` regla 1).
- **[BAJO] `generateStructured` etiqueta todo el turno con un solo modelo.**
  `openrouter.ts:716` (`model: usage.model`, el del ÚLTIMO intento) y `:731`,
  con `gastado` acumulando los tres. Consecuencia concreta: un OCR que falla
  dos veces en `gemini-3.1-flash-lite` ($0.25/$1.5) y cierra en
  `claude-haiku-4.5` ($1/$5) escribe UNA fila de `llm_costo` con los tres
  intentos etiquetados haiku (`processor.ts:1861`, `:2317`, `fase:'ocr'`) — los
  dólares están bien, el reparto por modelo no, y es justo lo que lee
  `costo_por_fase_modelo`.
- **[BAJO] `guardar_liquidacion` devuelve el expediente completo al modelo.**
  `tools.ts:511` (`liq`) → `engine.ts` → `repo.ts:986`: 32 columnas por
  comprobante con `rfc_emisor`, `rfc_receptor`, `cfdi_uuid` e `imagen_url`.
  `openrouter.ts:1240` lo serializa entero como `content` del mensaje
  `role:'tool'`, y como la tool NO es terminal —`run.ts:72` **no pasa
  `terminalTools`**, así que `terminales` queda vacío— el ciclo sigue y la
  ronda siguiente reenvía el expediente al proveedor. El único lector real es
  `guardia.ts:70-73`, en memoria del mismo proceso. `eeb7709d` le añadió
  `pdf_url` (`tools.ts:485`) y no le quitó nada.
- **[BAJO] `copiloto-acciones.ts:165`** sigue diciendo «Se enciende desde
  Observabilidad (doble confirmación)» en el mensaje de éxito, catorce líneas
  debajo del `revertir` (`:49`) que ya se corrigió para decir lo contrario — y
  `encender()` (`interruptores.ts:292`) no pide ninguna segunda puerta.

## Cierres de la 26, reauditados: los cinco aguantan

Un arreglo no se acredita su propia nota, así que los abrí buscando la
pregunta, no las líneas:

- **`62c44f2` (el ORDEN de TC-1).** `tools.ts:116` y `repo.ts:996` ordenan los
  dos por `created_at asc`. La pregunta era «¿pueden dos caminos elegir un
  original distinto de las mismas filas?» — ya no, mientras `created_at` no
  empate. **La otra mitad (el 4º lector) es el ALTO de arriba.**
- **`497769a` (CAPTURAS entre ciclos).** `analista.ts:422` y `copiloto.ts:247`
  borran antes del reintento; el llaveo del copiloto coincide
  (`conversationId: runId`, `:193`), así que `set` (`:140`) y `delete` (`:247`)
  tocan la misma entrada. Cubre la pregunta entera: probé mentalmente el caso
  inverso (el segundo ciclo SÍ llama la terminal) y el `set` nuevo gana.
- **`130e2c7` (tool terminal fallida).** `entregaTerminalAterrizo`
  (`:839-842`) lee `ok` solo cuando existe y `:1238` lo aplica. El caso central
  queda resuelto; la regresión de la última ronda va arriba como hallazgo
  aparte, no como des-acreditación de este.
- **`99cc86f` (`toolSchemas`).** `tool-executor.ts:106-119` compara pedidos
  contra encontrados y emite `tool.schema_faltante` con los nombres exactos. La
  pregunta era «¿qué señal habría si el import de efecto colateral se pierde?»
  — ahora hay una.
- **`4decc63` + `a86958f` (candado de emisión).** `computer_use.ts:246-262`
  (`reclamarEmision`, fail-closed fuera de pruebas) y `:264-278`
  (`sellarEmision`), con la llave armada de los campos del ticket
  (`efectoEmitir`, `:213-220`). Cubre `emitir` sin reservas; la mitad `clic`
  queda como el BAJO de arriba.

## Lo que revisé y está bien

- **La regla estructural, en las 33 tools registradas** (conté una menos que la
  26; el catálogo es el mismo, ninguna nueva). `tools.ts:39`, `:101`, `:181`,
  `:261` — `properties: {}` + `additionalProperties: false`, con
  `tenantId`/`viajeId` desde `ctx`. `chat-tools.ts`: 8 con `SIN_PARAMS`
  (`:32`), `PARAM_MODO` con tres valores cerrados (`:62-69`),
  `proyectar_serie` (`:272-280`) y `consultar_normas` (`:368-372`) con enums.
  `copiloto-tools.ts`: 11 con `SIN_PARAMS`; las 3 con texto libre validan antes
  de tocar la base (`traza_corrida:217` exige forma de uuid,
  `ficha_cliente:337` exige ≥2 letras y desambigua con >1 coincidencia,
  `bitacora:309` pasa el filtro a `ultimasEntradasBitacora`, que sí escapa).
  Ninguna decide qué fila se escribe.
- **La única excepción a la regla, y está declarada.**
  `computer_use.ts:317-333`: `escribir`/`clic`/`emitir` sí reciben un
  `selector` del modelo, porque el DOM de 37 portales se descubre en vuelo.
  El techo de daño no es el schema sino `PROHIBIDOS` (`:356`), el candado
  durable (`:246`) y que el adaptador no está cableado. Lo anoto para que
  quien lo cablee sepa que aquí la regla del repo no aplica y las mitigaciones
  son heurísticas sobre un string.
- **Los dos candados de `guardar_liquidacion`, en la tool y no en el prompt.**
  `tools.ts:284-291` (`cierrePedidoPorTexto`, calculado por el processor sobre
  el texto del turno) y `:361-369` (`comprobantesReales === 0` +
  `cierreEnCerosConfirmado`). Los dos LANZAN, así que el error viaja al modelo
  como resultado de tool; el kill switch (`:300-305`) vive en el mismo sitio y
  falla cerrado.
- **Idempotencia por EFECTO.** `tool-executor.ts:385-408` cachea la PROMESA
  antes del `await` (no hay ventana check-then-act), llavea por NOMBRE con la
  nota de por qué eso solo vale mientras `properties: {}` se sostenga, y borra
  el fallo. La llave durable incluye `runId` (`:353-355`) y el executor rechaza
  cerrado una mutación sin él (`:164-167`). El techo de renovaciones del lease
  (`:215-227`, con `.unref()`) y el sello del handler colgado (`:279-289`)
  siguen en pie.
- **Loop-guard.** `openrouter.ts:1181-1186` corta ANTES del `Promise.all` —
  incluida una `guardar_liquidacion` pedida en la última ronda, que es una
  mutación que no se paga por un resultado que nadie leería.
- **Truncamiento en las dos hermanas que sí lo miran.** `:695-702` (con
  reintento al doble de tope en `:744-747`) y `:1147-1155` (ANTES de mirar
  `tool_calls`).
- **Atribución de costo en el ciclo de tools.** `acumularCosto` por ronda con
  `activeModel`, que `complete` ya movió al fallback antes de devolver
  (`:1106-1112`); consumido por `processor.ts:4019-4027` y
  `dashboard/chat/route.ts:128-135`, que escriben una fila de `llm_costo` POR
  MODELO real. El analista además suma `res2.costoPorModelo` del reintento
  (`analista.ts:461-464`).
- **La reserva no se cobra ante un error de red** en las tres funciones:
  `:423`, `:677` y `:1075-1080`.
- **`llaveDeCache`** (`:864-876`) llavea por NOMBRE solo las tools con
  `properties` vacío y guarda los args ORIGINALES junto al resultado cacheado
  (`:1212`, `:1239`). Verifiqué que ninguna tool con `properties` no vacío cae
  en el atajo, y que `esLectura` (`:1000`) cubre las cuatro del agente de
  dinero por prefijo aunque `run.ts:72` no pase `readOnlyTools`.
- **El error crudo de Postgres no cruza al modelo.**
  `tool-executor.ts:140-147` (`VOCABULARIO_POSTGRES`), con el detalle completo
  en el log.
- **La confirmación de una acción del copiloto no pasa por el modelo.**
  `admin/copiloto/route.ts:159-165` exige un `intentId` que emitió el servidor
  y compara `hashArgsAccion(accionId, objetivo)`; `:169-180` hace step-up AAL2
  para las acciones `doble`; `ejecutarAccionCopiloto:157-160` revalida el
  objetivo contra `INTERRUPTORES`. Lo que falla es el conteo de propuestas
  (hallazgo arriba), no la puerta.
- **`rutasPdfVersionadas` (lo nuevo desde la 26).** `eeb7709d` cambió el upload
  a `upsert: false`. Busqué el choque en el reintento de CU003
  (`tools.ts:459`, `generarPdfs` puede correr dos veces): no lo hay, porque
  `rutas_pdf.ts:5` genera un `randomUUID()` por llamada. Y el nuevo
  `pdf_url` del resultado sí tiene lector (`processor.ts:4391-4393`).

## Lo que NO alcancé a revisar

- **Nada contra Postgres real ni contra los proveedores.** No hay `.env`, ni
  base, ni red: la RPC `reservar_presupuesto_llm` bajo concurrencia, el
  comportamiento real de `provider: { data_collection: 'deny' }` y de
  `reasoning: { enabled: false }` siguen siendo contrato declarado. Mismo hueco
  que la 24, la 25 y la 26.
- **Ninguno de los hallazgos está reproducido con una prueba EJECUTADA.** El
  encargo prohíbe tocar archivos del repo y vitest no recoge un archivo fuera
  de la raíz, así que las cadenas (`openrouter.ts:1184`→`:1238`→`:1252`→
  `copiloto.ts:210`→`route.ts:317`, y `consulta_chofer.ts:180`→`:220`→
  `processor.ts:3388`) salen de leer el camino completo, no de correrlo.
- **Empates de `created_at` en `gasto`.** El arreglo de TC-1 depende de que dos
  filas del mismo viaje nunca compartan `created_at` al microsegundo. Cada
  `addGasto` es su propia transacción, así que en la práctica no empatan, pero
  no pude comprobarlo contra Postgres; un lote insertado en una sola
  transacción volvería a dejar el orden indefinido, y las dos consultas piden
  columnas distintas.
- **`generateStructured` con audio** (`:579`, el cast a `input_audio`): el
  fallback de `transcripcion` hacia un modelo sin oído sigue sin prueba;
  `models.ts:145-148` reconoce el hueco.
- **El piloto de visión** (`piloto_vision.ts`, 610 líneas) lo leí solo por
  encima: usa `generateStructured`, no el ciclo de tools, y su veto de emisión
  está en la cabecera. Su lógica de pasos y su presupuesto de sesión
  (`PRESUPUESTO_SESION_MS`) merecen una pasada completa que no le di.
- **`valores[clave]` en `computer_use.ts:361`** hace un lookup con llave del
  modelo sobre un objeto literal (`:142`), así que `clave:"constructor"` pasa
  el `if (valor === undefined)`. No lo reporto como hallazgo: el adaptador no
  está cableado y el peor caso es que Playwright reviente con un no-string y el
  ciclo lo lea como error de tool. Queda anotado por si se cablea.
