# Tool calling — auditoría 30

**Nota: 5/10** (antes 7). Razón del movimiento: **mirada más profunda — el
código no cambió y la nota anterior estaba inflada**, con una segunda razón que
pesa igual: **deuda que cobró factura** (de los 8 hallazgos abiertos de la 29,
**cero cerrados**).

Lo medido, no recordado. `git log 7bcc319..HEAD -- src/lib/llm src/lib/agents
src/lib/likida/tools.ts src/lib/likida/costos.ts
src/lib/likida/facturacion/adaptadores` devuelve **UN commit**: `04b3705`, que
cambia **una línea** (`costos.ts:41`). `npx vitest run src/lib/llm src/lib/agents
src/lib/likida/tools_invariantes.test.ts
src/lib/likida/tools_estado_viaje_aud24.test.ts` → **54 archivos, 339 pruebas,
0 fallos** — **el número EXACTO de la 29**. La campaña de cobertura de esta
ventana (+49 archivos de prueba) no tocó este rubro ni con una prueba.

La 29 se ganó su 7 porque *«se atacó y subió»*. Esta ventana no atacó nada de lo
que la 29 dejó abierto, y al leer más hondo el catálogo aparece **una tool
cableada, en el camino fiscal, donde el modelo sí decide un dato** —lo que la
regla de `properties: {}` existe para impedir— con un candado que es una línea
del prompt. La 29 leyó ese archivo («el piloto de visión, leído entero por
primera vez en cuatro rondas») y verificó sus cuatro guardas de SELECTOR sin
mirar que el **valor** que se teclea no tiene ninguna.

**Riesgo mayor hoy:** el piloto de visión —registrado por flota en
`registro.ts:459`— teclea en el formulario de autofacturación de un portal el
texto que el modelo escribió, sin cotejarlo contra el ticket ni contra los datos
fiscales de la flota, y devuelve `capturado` como si fuera lo que el sistema
capturó.

## El foco obligatorio: `04b3705` / migración 0351 — el conjunto SÍ coincide

Veredicto: **el cambio es correcto y está anclado.** Lo verifiqué de los tres
lados que pedía el encargo, y hay un cuarto que hay que decir.

1. **TS** — `src/lib/likida/costos.ts:41`: `'ocr' | 'cuadre' | 'escalacion' |
   'chat' | 'router' | 'whatsapp' | 'transcripcion' | 'copiloto' | 'runner'` →
   **9 fases**.
2. **La base** — `supabase/migrations/0351_costo_fase_copiloto_runner.sql:17`:
   `check (fase in ('ocr','cuadre','escalacion','chat','router','whatsapp',
   'transcripcion','copiloto','runner'))` → **las mismas 9, en el mismo orden**.
   Es la ÚLTIMA migración que nombra `llm_costo_fase_dominio` (0025 → 0304 →
   0351), que es la que gobierna. El `fase in (` de
   `0240_qa_carril_completo.sql:72` NO interfiere: `costos_dominio.test.ts:36`
   filtra por el nombre del constraint antes de mirar el texto.
3. **Los llamadores** — los 11 `registrarCosto` con fase literal del repo
   (`ingesta/route.ts:110`, `chat/route.ts:130` y `:160`, `oficina_wa.ts:259` y
   `:280`, `voz_transcrita.ts:118`, `costos.ts:87`, `processor.ts:2074`, `:2574`,
   `:4396`/`:4399`, `:4434`) usan **7** de las 9. **Nadie escribe `'copiloto'` ni
   `'runner'`** — la propia migración lo dice en su encabezado, y es cierto: ni
   `/api/admin/copiloto/route.ts` ni `redactor.ts` llaman `registrarCosto`, y los
   dos lo declaran a propósito (`route.ts:28-30`, `redactor.ts:18`: es gasto de
   plataforma, al log y al ledger, no a `llm_costo`).
4. **La prueba de base existe y muerde en las dos direcciones**:
   `supabase/tests/0351_costo_fase_copiloto_runner.sql` inserta `copiloto` y
   `runner` (tienen que entrar) **y** una fase `'inventada'` esperando
   `check_violation`. `costos_dominio.test.ts:61-81` cruza las dos listas en
   ambos sentidos: revertir solo el TS, o solo el SQL, la pone roja.

Lo que hay que decir, y es lo que baja el valor del commit: **0351 amplía el
dominio para dos fases sin escritor y deja sin renglón la única ruta que sí
gasta dinero de una flota sin dejar fila** — el piloto de visión (TC-M2, abajo,
3ª ronda). Y el asunto del commit cita «TC-B2», que es el ID de la **28**;
**el TC-B2 de la 29** (`costoPorModelo` de `generateStructured` sin consumidor,
`ocr.ts:775`) sigue intacto. Un commit que cita un ID cerró el ID de otra ronda.

## Estado de los hallazgos abiertos de la 29

| # | Hallazgo de la 29 | Veredicto | Evidencia de hoy |
|---|---|---|---|
| TC-A1 | [ALTO] el candado de «una sola propuesta por turno» es check-then-act sobre un `await` | **REINCIDENTE (3ª ronda)** | `copiloto.ts:85` (`has`), `:101` (`await estaApagado`), `:115` (`set`) — los mismos números. El archivo no tiene ni un commit en la ventana. |
| TC-A2 | [ALTO] el analista del panel del cliente sin la red que el copiloto sí tiene | **REINCIDENTE (2ª ronda)** | `analista.ts:371` sigue llamando `generateWithTools` dentro de un `try` que **solo tiene `finally`** (`:522-525`). La red determinística sigue en `:479-497`, después de la llamada. |
| TC-M1 | [MEDIO] el truncamiento se paga y se anota como cero MEDIDO en los agentes de fondo | **REINCIDENTE** | `contenido.ts:410-413` y `faq.ts:443-446` siguen con `catch (e) { motivoSinModelo = 'el modelo no respondió' }` y sin sumar nada. |
| TC-M2 | [MEDIO] el piloto de visión no escribe una sola fila en `llm_costo` | **REINCIDENTE (2ª ronda)** | `piloto_vision.ts:620`: `const { data } = await generateStructured<AccionPiloto>({…})` — `cost`, `model`, `tokensIn/Out` se tiran en la misma línea. Y 0351 **no** le dio fase. |
| TC-M3 | [MEDIO] `ensayo` no impide el clic físico que emite | **REINCIDENTE** | `computer_use.ts:381-393` (`clicDeEmision` no mira `modo` en ninguna rama) + `:421` (`clic` se enruta ahí). El adaptador sigue sin cablear (grep: cero usos de `AdaptadorComputerUse` fuera de su archivo y sus pruebas). |
| TC-B1 | [BAJO] `PartialExecutionError` sin `costoPorModelo` | **REINCIDENTE** | `openrouter.ts:853-874` (la clase no tiene el campo), `:1327` (se construye sin él), `chat/route.ts:157-165` y `processor.ts:4430-4441` escriben `modelo:'parcial'`. |
| TC-B2 (29) | [BAJO] `generateStructured.costoPorModelo` sin consumidor | **REINCIDENTE** | `grep costoPorModelo src/` → 6 consumidores, **todos** de `generateWithTools`. `ocr.ts:775` sigue en `costo: { modelo: res.model, …, costoUsd: res.cost }`. |
| TC-B6 | [BAJO] `guardar_liquidacion` devuelve el expediente completo al modelo | **REINCIDENTE, declarado** | `tools.ts:518` (`liq`) → `openrouter.ts:1312`. Sigue siendo deuda escrita, no incumplimiento. |

**Cero de ocho cerrados.** Dos ALTOS en su 2ª/3ª ronda.

## Hallazgos

### [ALTO] TC30-A1 — NUEVO: el piloto de visión —el adaptador que SÍ está cableado— deja que el modelo escriba el VALOR que se teclea en un formulario fiscal; el único candado es la regla 5 del prompt

`src/lib/likida/facturacion/adaptadores/piloto_vision.ts:150` · `:510-516` ·
`:453-476` y `:505-507` (las cuatro guardas, todas de SELECTOR) · `:586`
(regla 5) ·
`src/lib/likida/facturacion/adaptadores/registro.ts:459-472` (está cableado) ·
frente a `src/lib/likida/facturacion/adaptadores/computer_use.ts:43-50` y
`:401-408` (la regla, enunciada y aplicada, en el adaptador MUERTO)

El esquema de la acción es `Accion` (`:143-154`): `tipo`, `selector`, **`valor:
z.string().nullable()`**. `ejecutar()` somete el **selector** a cuatro guardas
—no compuesto (`:453`), identidad exacta contra el inventario (`:460-462`),
`contar() !== 1` se detiene (`:468-476`), campo `password` rechazado
(`:505-507`)— y luego, sin una sola comprobación sobre el **valor**, hace
`await pagina.escribir(a.selector, a.valor)` y `capturado[a.selector] = a.valor`
(`:510-516`; la única condición sobre el valor es `:496`, que solo exige que no
venga vacío). Los datos verdaderos (RFC, razón social, CP, régimen, uso CFDI,
correo, y los campos del ticket) viajan **dentro del system prompt** (`:588-596`)
y nada los vuelve a mirar después: `grep '\.rfc' piloto_vision.ts` devuelve UNA
línea, y es la del prompt (`:590`).

El repo ya escribió la regla, y la escribió para el adaptador de al lado:
*«EL MODELO NO PUEDE TECLEAR TEXTO LIBRE. Nunca. `escribir` no recibe un valor:
recibe la CLAVE de un valor que el sistema ya tenía»* (`computer_use.ts:43-50`),
implementada en `computer_use.ts:401-408` (`clave` es un `enum` sobre
`Object.keys(valores)` y sin valor conocido la herramienta se niega). Ese
adaptador **no tiene un solo llamador**. El que sí se registra por flota es el
piloto (`registro.ts:459`), y ahí la misma regla es el punto 5 de un prompt:
*«Llena únicamente con los datos de abajo. Un dato que no tengas NO se inventa»*
(`:586`) — exactamente la clase de candado que el propio repo declara inválido
dos archivos más allá: *«Un candado que depende de que el modelo obedezca no es
un candado»* (`computer_use.ts:56`).

Escenario, con valores. Flota con `FACTURACION_PILOTO=si` y sesión vinculada en
el portal de una gasolinera. El ticket llega con
`campos = [{clave:'webId', etiqueta:'Web ID', valor:'A83920', requerido:true},
{clave:'total', etiqueta:'Importe total', valor: null, requerido:true}]` — el
`null` es el estado normal cuando el OCR no leyó ese campo (`CampoListo.valor:
string | null`, `pendientes.ts:36`). El prompt lo renderiza como
`· Importe total (requerido): (sin leer)` (`:573-575`). El modelo, que además ve
la captura de pantalla y el texto de la página, devuelve
`{tipo:'escribir', selector:'#total', valor:'1234.00', esBotonQueEmite:false}`.
Las cuatro guardas pasan (`#total` está en el inventario, casa con un solo
elemento, no es `password`, no es compuesto) y se teclea. El resultado sale con
`ok: true` y `capturado = {'#total':'1234.00', …}` (`:395-409`), que
`unoPorUno` marca como `incluido: true` en modo ensayo
(`facturacion/agente.ts:338`).

Consecuencia: la persona que abre la captura para apretar el botón de timbrar ve
un formulario lleno y tiene que cotejar campo por campo contra el ticket —el
trabajo que el producto existe para quitar— porque **ninguna cifra de esa
pantalla está garantizada como leída**. Si no lo hace, se timbra un CFDI
irreversible con un importe que escribió un modelo. Es la regla de producto que
define a Likida («nunca inventar una cifra») rota en el único camino donde el
resultado lo firma el SAT.

Refutación intentada, y falla parcialmente —por eso es ALTO y no CRÍTICO—:
(a) el piloto **no emite nunca** (`:488-490`, veto en los dos modos), así que
siempre hay una persona entre el valor inventado y el timbre: eso es una
mitigación real y le quita el CRÍTICO; (b) **no** lo tapa `escrituraPermitida`,
que solo mira si el campo es de contraseña (`:504-507`); (c) **no** lo tapa
`capturado`, que es un registro de lo que se escribió, no una verificación —
nada lo compara contra `campos` ni contra `receptor` en todo el camino
(`al_vuelo.ts:279`, `:298`, `:303` solo lo reenvían); (d) **no** es código
muerto, a diferencia de `AdaptadorComputerUse`: `registro.ts:459` lo registra
por flota y por comercio.

Causa raíz probable: los dos adaptadores nacieron del mismo problema y solo uno
heredó la regla; el que la enuncia se quedó sin cablear y el que se cableó
sustituyó la restricción estructural por una instrucción en lenguaje natural.
Cuatro rondas de auditoría verificaron las guardas del **selector** de este
archivo y ninguna preguntó por el **valor**.

### [ALTO] TC-A1 — REINCIDENTE (3ª ronda): el candado de «una sola propuesta por turno» sigue siendo un check-then-act sobre un `await` que `Promise.all` atraviesa

`src/lib/agents/copiloto.ts:85` · `:101` · `:115` ·
`src/lib/llm/openrouter.ts:1264-1265` · `:1276` · `:931-943` ·
`src/lib/llm/tool-executor.ts:392-416`

Reverificado línea por línea sobre el árbol de hoy, sin cambios respecto de la
29: `ACCIONES_PROPUESTAS.has()` en `:85` (síncrono), la única acción implementada
cede el control en `await estaApagado(objetivo)` en `:101`, y el `.set` que
cierra el candado ocurre **después**, en `:115`. `generateWithTools` dispara
todas las tool_calls de la ronda con `Promise.all(llamadas.map(async …))`
(`openrouter.ts:1264`) y la dedup `inRound` llavea por
`nombre:JSON.stringify(args)` (`:1276` → `llaveDeCache:931-943`, que solo
colapsa a `nombre` las tools **sin** `properties`; `proponer_accion` sí las
tiene, `copiloto.ts:60-72`). `proponer_accion` no es `isMutation` —el único
`isMutation:true` del repo es `tools.ts:262`—, así que la rejilla que sí resuelve
esta carrera (cachear la PROMESA antes del `await`, `tool-executor.ts:391-408`)
no la cubre.

Escenario, con los mismos valores de la 28 y la 29. Javier escribe «apaga el
agente de cobranza y el redactor». El modelo devuelve en la MISMA ronda
`proponer_accion({accion:"apagar_agente", objetivo:"agente:cobranza"})` y
`proponer_accion({accion:"apagar_agente", objetivo:"agente:redactor"})` — llaves
distintas, dos ejecuciones. A: `has` → `false`, suspende en
`estaApagado('agente:cobranza')`. B: `has` → **todavía `false`**, suspende. A
reanuda y hace `set(runId, cobranza)`, devuelve `{ok:true, instruccion:'La
previsualización quedó armada…'}` (`:116-122`). B reanuda, **sobrescribe** y
devuelve el mismo `{ok:true}`. `copiloto.ts:342` lee UNA tarjeta:
`agente:redactor`.

Consecuencia: el modelo le confirma a Javier que armó las dos, ve una, la
confirma, y `agente:cobranza` sigue encendido despachando su cron.

Causa raíz probable: sin cambios desde la 29 — el candado se escribió contra el
síntoma (dos `set` seguidos) y no contra el mecanismo que produce el par.

### [ALTO] TC-A2 — REINCIDENTE (2ª ronda): el analista del panel del CLIENTE sigue sin la red que el copiloto tiene desde la 28; un tropiezo del primer ciclo tira el turno pagado

`src/lib/agents/analista.ts:371` · `:479-497` · `:522-525` ·
`src/app/api/dashboard/chat/route.ts:151` · `:172` ·
`src/lib/llm/openrouter.ts:1255-1257` · `:1310` · `:1324` · `:1327` ·
frente a `src/lib/agents/copiloto.ts:353-383` (la red que sí existe)

`ejecutarAnalista` abre `try {` en `:370`, llama `generateWithTools` en `:371`
con `maxToolRounds: 5` y `terminalTools:['entregar_respuesta']`, y ese `try`
**solo tiene `finally`** (`:522`). No hay `catch` en toda la función. El copiloto
—el gemelo que corre la consola interna— recibió exactamente esa red en la
ventana de la 28 (`copiloto.ts:353-383`: rescatar lo que ya había y devolver una
respuesta degradada honesta); el analista lleva dos rondas sin ella.

Escenario, con valores. El contralor pregunta «¿cómo va mi flota este mes?» en
`/dashboard`. Rondas 0-3: `kpis_flota` devuelve `{viajesLiquidados:128,
montoComprobado:1847320.50, tasaCuadre:0.94}`, y `serie_gasto`, `top_rutas` y
`motor_fiscal` devuelven bien — los cuatro están en `executed`. Ronda **4**
(`round === maxRounds - 1`, `openrouter.ts:1255`): el modelo pide
`entregar_respuesta({bloques:[{tipo:"texto"}]})`, que el schema permite porque
solo declara `required:['tipo']` (`analista.ts:231`). `validarBloques` descarta
el bloque por texto vacío, `limpios.length === 0`, y el handler devuelve
`{ok:false, error:'bloques inválidos…'}`. `entregaTerminalAterrizo` lee ese
`ok:false` (`openrouter.ts:906-908`), `entregada` queda en `false` (`:1310`), el
`for` termina y sale `LoopGuardError(5, executed)` (`:1324`), envuelto en
`PartialExecutionError` (`:1327`). La excepción sube al route, que registra una
fila `modelo:'parcial'` (`chat/route.ts:157-165`) y manda
`{t:'error', error:'el analista no pudo responder en este momento'}` (`:172`).

Consecuencia: **el contralor —el comprador— ve «el analista no pudo responder»
sobre una pregunta cuyos números el sistema acababa de leer en ese mismo turno**;
la flota paga cinco completions que no entregan nada; y la red determinística que
existe precisamente para esto (`:479-497`, «datos reales sin narración le sirven
más al contralor que una disculpa») está **dentro** del mismo `try`, después de
la llamada que lanzó: es inalcanzable por construcción. En un demo, esta es la
pantalla que se enseña.

Refutación intentada, y falla: (a) no lo tapa el reintento correctivo de
`:414-473` — vive después de la llamada que lanzó; (b) no lo tapa el corte del
loop-guard antes del `Promise.all`, porque la terminal **sí** se ejecuta (es la
excepción A30) y lo que falla es su `ok`; (c) no lo tapa `fundamentarBloques`
(`:504-511`), que está aguas abajo; (d) no es teórico que el modelo llegue a la
última ronda pidiendo tools: el propio archivo lo documenta («flash-lite a veces
contesta en texto plano sin la tool terminal», `:409-412`).

Causa raíz probable: `LoopGuardError` se sigue tratando como «el turno no
existió» aunque `executed` traiga lecturas buenas; el arreglo de la 28 se aplicó
al llamador que se estaba auditando y no a la frontera que los dos comparten.

### [MEDIO] TC30-M1 — NUEVO: la escalera de truncamiento de `generateStructured` se traga el error del reintento al doble sin una línea de log, y después juzga «¿es transitorio?» sobre un `TruncatedError` — la confusión exacta que su función hermana excluye a propósito

`src/lib/llm/openrouter.ts:794-805` · `:812` ·
frente a `:449-461` (la hermana) y `src/lib/llm/openrouter_truncado.test.ts:133`
(la prueba que ancla la hermana)

Dos defectos en el mismo bloque de once líneas:

```
if (e1 instanceof TruncatedError) {
  try { return await attempt(model, undefined, tope * 2); }
  catch (eT) { if (eT instanceof TruncatedError) { eT.usage = …; throw eT; } }
}                                     // ← si eT NO es truncamiento, se descarta
try { return await attempt(model, note); }
catch (e2) {
  if (fallback && (isTransientError(e1) || isTransientError(e2))) { … }
```

(a) El `catch (eT)` **solo relanza los `TruncatedError`**. Cualquier otra cosa
—un 503 del proveedor, un `JSON parse falló`, un `APIConnectionError`— se pierde
entera: no se relanza, no se loguea, no queda en `logger.warn('llm.truncado')`
(que ya se emitió antes, `:795`). El flujo cae al `attempt(model, note)` de
`:808` con el **tope original**, el que ya se sabe insuficiente.

(b) En `:812`, `isTransientError(e1)` se evalúa sobre un **`TruncatedError`**.
`isTransientError` (`:183-186`) clasifica por texto con
`/(?<![$\-\w])(5\d\d|429|408)(?!\.\d)\b/`, y el mensaje del truncamiento es
`Respuesta truncada: se agotaron los ${maxTokens} tokens de salida (usó
${tokOut}) antes de cerrar el JSON` (`:748`). `generateResponse` excluye
explícitamente ese caso —`if (!fallback || err instanceof TruncatedError ||
!isTransientError(err)) throw err` (`:458`)— y su comentario de `:450-457` dice
por qué, y hay una prueba con nombre propio para ello
(`openrouter_truncado.test.ts:133`: *«un tope de 500 (el default) no confunde el
truncamiento con un 5xx de proveedor»*). `generateStructured` no tiene ni la
exclusión ni la prueba.

Escenario, con valores. El piloto de visión pide su acción con `maxTokens: 700`
(`piloto_vision.ts:627`), rol `piloto` = `anthropic/claude-sonnet-5` ($2/$10,
`models.ts:140`), fallback `openai/gpt-5.6-terra` (`openrouter.ts:97`). Con
~4,500 tokens de entrada (system + inventario + texto de la página + captura):

1. Intento 1 → `finish_reason:'length'`, `completion_tokens: 700` →
   `TruncatedError` (e1). Se pagó ~$0.016.
2. Reintento al doble (`tope 1400`) → el proveedor devuelve **503**. `eT` no es
   `TruncatedError` → **se descarta en silencio**. No hay línea de log: el
   503 nunca existió para nadie.
3. `attempt(model, note)` con tope **700** otra vez → vuelve a truncar, ahora con
   `completion_tokens: 512` (Sonnet corta donde alcanza). e2 = `TruncatedError`
   con el texto «…(usó **512**)…».
4. `:812` → `isTransientError(e2)` ve `512` con frontera de palabra a los dos
   lados → **`true`** → `llm.fallback` a `openai/gpt-5.6-terra` con el MISMO tope
   de 700, que no arregla un problema de techo.
5. `attempt(fallback, note)` trunca igual → `conGastado(e3, 'Falló generación
   estructurada (fallback)')`.

Cuatro completions pagadas y liquidadas contra el presupuesto del tenant
(`cobrar()`, `:741`, cobra ANTES de cualquier salida, correctamente) para un
problema que la línea 2 ya había diagnosticado. Y el diagnóstico que sale al
llamador dice «truncado», con el 503 del paso 2 desaparecido.

Consecuencia: el paso del piloto que más caro sale se paga hasta cuatro veces
por una sola decisión; un proveedor caído a mitad de la escalera de truncamiento
no deja rastro en ningún log (es el modo de falla que `resumenCausa` existe para
impedir); y una corrida de 14 pasos puede multiplicar por 4 su costo sin que
`llm_costo` lo explique — porque, además, el piloto no escribe en `llm_costo`
(TC-M2).

Refutación intentada, y falla: (a) no lo tapa el `budget`: la reserva y la
liquidación son correctas en las cuatro llamadas, lo que se critica es que haya
cuatro; (b) no lo tapa que el fallback de `generateStructured` exija
`isTransientError` — es justo la función que confunde el truncamiento con un
5xx, y el repo lo sabe (por eso la hermana lo excluye); (c) no lo tapa
`openrouter_truncado.test.ts:63` («si el doble tampoco alcanza, falla como
truncamiento»), que ejercita el caso en que `eT` **sí** es `TruncatedError` —
el camino que se traga el error es justamente el que ninguna prueba recorre.

Causa raíz probable: el `catch` se escribió para enriquecer el `usage` del
truncamiento y no para decidir el destino de las demás excepciones; y la
exclusión de `TruncatedError` del fallback se aplicó en las funciones donde se
encontró el hallazgo (la 28 la puso en `generateResponse` y `generateWithTools`
nunca la necesita porque no tiene escalera) sin barrer la tercera.

### [MEDIO] TC-M2 — REINCIDENTE (3ª ronda): el rol más caro por llamada del repo sigue sin una fila en `llm_costo`, y la migración de esta ventana le dio renglón a dos fases sin escritor y a él no

`src/lib/likida/facturacion/adaptadores/piloto_vision.ts:620` · `:103` ·
`:285-286` · `src/lib/likida/costos.ts:41` ·
`supabase/migrations/0351_costo_fase_copiloto_runner.sql:17` ·
`src/lib/llm/models.ts:140` · `src/lib/agents/copiloto-tools.ts:279-293`

`decidir()` sigue desestructurando **solo** `{ data }` (`:620`): `cost`,
`tokensIn`, `tokensOut` y `model` se tiran en esa línea. No hay `registrarCosto`
en toda la ruta de facturación. El ledger de presupuesto sí lo ve (`budget`
existe porque `registro.ts:460` pasa `tenantId`), pero `llm_costo` es otra tabla
y es la que leen `/admin` (`admin/consumo.ts`, `admin/capacidad.ts`) y la tool
`costo_por_fase_modelo` (`copiloto-tools.ts:279-293`).

Lo nuevo de esta ronda: **0351 pasó por `FaseCosto` y no le abrió renglón**.
Agregó `'copiloto'` y `'runner'` —dos fases que su propio encabezado declara sin
llamador, y que siguen sin llamador hoy— y dejó fuera la única ruta que gasta
dinero **de una flota concreta** sin dejar fila. Ese era el argumento de la 26 y
de la 29, y es el que quedó sin atender.

Escenario, con valores. Una flota con 6 portales sin adaptador escrito corre el
lote. Cada sesión son hasta **14** llamadas (`PASOS_MAXIMOS`, `:103`) con
`role:'piloto'` = `anthropic/claude-sonnet-5` ($2/$10, `models.ts:140`), cada una
con la captura adjunta: ~4,500 tokens de entrada y ~400 de salida por paso →
~$0.013 por paso → **~$0.18 por portal**, el costo de una liquidación completa
(`COSTO_ESTIMADO_USD.liquidacion = $0.18`, `models.ts:270`). Seis portales ≈
$1.10 en una corrida. En `/admin/costo-ia` y en `costo_por_fase_modelo`, esa
corrida vale **$0.00**.

Consecuencia: Javier compara el costo por liquidación contra un total que no
incluye el camino más caro por llamada del repo, y la decisión que ese número
alimenta (encender `FACTURACION_PILOTO`, graduar portales a adaptador escrito) se
toma sobre un dato incompleto.

Refutación intentada, y falla: (a) no lo tapa el ledger de presupuesto: acota el
gasto del tenant, no lo atribuye por fase ni por modelo, y el panel no lo lee;
(b) no lo tapa que el piloto esté detrás de `FACTURACION_PILOTO` — está
registrado por flota en `registro.ts:459`, no es código muerto; (c) el copiloto
tampoco escribe en `llm_costo` y ahí **sí** es deliberado y está dicho
(`admin/copiloto/route.ts:28-30`: gasto de plataforma) — el piloto es gasto de
una flota.

### [MEDIO] TC-M1 — REINCIDENTE: una respuesta truncada se paga y se anota como **cero medido** en los tres agentes de fondo

`src/lib/llm/openrouter.ts:412` · `:422-430` ·
`src/lib/likida/agentes/contenido.ts:376-380` · `:410-413` ·
`src/lib/likida/agentes/faq.ts:418-422` · `:443-446` ·
`src/lib/likida/agentes/sdr.ts:227-238` ·
`src/lib/likida/agentes/runner.ts:395-407` · `src/lib/llm/models.ts:278`

`generateResponse` liquida la reserva (`:412`) y **luego** lanza `TruncatedError`
con su `usage` completo (`:428`). Ninguno de los tres llamadores de fondo lee ese
`usage`: los tres tienen un `catch (e)` que anota
`motivoSinModelo = 'el modelo no respondió'` y no suma nada
(`contenido.ts:410-413`, `faq.ts:443-446`) o cuenta un `saltado`
(`sdr.ts:236-238`). Los tres corren en modo plataforma **sin `budget`**, así que
tampoco hay fila en el ledger: el gasto no queda en ningún lado.

Escenario, con valores (sin cambios respecto de la 29, reverificado hoy).
`correrContenidoFiscal` pide un artículo con `role:'marketing'`
(`openai/gpt-5.6-luna`, $0.10/$0.60 por M, `models.ts:112` y `:213`) y
`maxTokens: 1_400` (`contenido.ts:379`). El modelo escribe 1,400 tokens de salida
sobre 2,000 de entrada y llega al techo: `finish_reason:'length'` →
`costoContabilizado = 2000×$0.10/1e6 + 1400×$0.60/1e6 = $0.00104`. La corrida se
anota con `costoUsd = 0` —un **cero MEDIDO**, no un `null`— y la pieza dice «el
modelo no respondió» sobre una llamada que respondió y se cobró.

Consecuencia: son centavos y hay que decirlo; lo que se rompe es la invariante
que estos dos archivos citan en sus propios comentarios («un costo no medido no
es cero», `faq.ts:423-433`). El repo tiene DOS tratamientos honestos —`null`
pegajoso y `COSTO_ESTIMADO_USD.corridaAgenteSinMedir = $0.18` (`models.ts:278`)—
y el truncamiento no cae en ninguno: entra como gasto real disfrazado de medición
en cero, que es justo lo que `gastoDelDiaUsd` (`runner.ts:395-407`, filtra
`.not('costo_usd','is',null)`) suma contra el techo de `runner.ts:752-757`.

### [MEDIO] TC-M3 — REINCIDENTE: el modo `ensayo` no impide el clic físico que emite; solo le quita el nombre a la tool

`src/lib/likida/facturacion/adaptadores/computer_use.ts:368-372` · `:381-393` ·
`:416-424` · `:444`

`ensayo` se implementa quitando `emitir` del catálogo (`:368`, y el mensaje al
modelo lo dice: *«NO existe herramienta de emitir»*, `:444`). Pero `clic` sigue
en el catálogo con `selector` de texto libre (`:365`) y el arreglo de TC-B4 lo
enruta a `clicDeEmision` cuando el botón huele a emisión (`:421`) — el camino
que de verdad aprieta (`p.hacerClic`, `:385`) y devuelve `EMITIDO` (`:392`). El
candado (`reclamarEmision`, `:382`) protege contra la emisión **doble**, no
contra la emisión **en ensayo**: no mira `modo` en ninguna de sus dos ramas.

Escenario, con valores. `facturar(campos, 'ensayo')` sobre un portal con
`<button id="btnSubmit">Timbrar</button>`. Sin `emitir` disponible, el modelo
pide `clic({selector:'#btnSubmit'})`. `esBotonDeEmision('#btnSubmit')` es `true`
por el TEXTO del último inventario (`:353-355`), entra a `clicDeEmision`, reclama
el candado, **aprieta Timbrar** y le contesta al modelo `EMITIDO`.

Consecuencia: un CFDI irreversible en el modo cuyo contrato es no emitir. Sigue
siendo MEDIO y no CRÍTICO porque el adaptador **no está cableado** (`grep -rn
'AdaptadorComputerUse' src/` fuera de su archivo y sus pruebas: cero) y quien sí
corre veta por código antes de cualquier clic de emisión
(`piloto_vision.ts:488-490`, en los dos modos). Pero `ensayo` es precisamente el
modo con el que se estrenaría con el primer cliente.

### [BAJO] TC-B1 — REINCIDENTE: `PartialExecutionError` no lleva `costoPorModelo`; el turno más caro se atribuye a un modelo llamado `parcial`

`src/lib/llm/openrouter.ts:853-874` · `:1327` ·
`src/lib/likida/processor.ts:4392-4400` · `:4430-4441` ·
`src/app/api/dashboard/chat/route.ts:157-165`

En el camino de éxito, `processor.ts:4392-4398` escribe una fila por modelo real
con `res.costoPorModelo`. En el de excepción, `generateWithTools` construye el
`PartialExecutionError` con `(message, err, executed, tokIn, tokOut, costo)`
(`:1327`): los totales viajan, el mapa no, porque la clase no tiene el campo.

Escenario, con valores. Cierre de un viaje: rondas 0-2 en
`anthropic/claude-sonnet-5` ($2/$10), la ronda 3 recibe un 503, `complete` cruza
al fallback `openai/gpt-5.6-terra` ($1/$6, `openrouter.ts:97`), la ronda 4 corre
ahí y el turno muere por `LoopGuardError`. `costoPorModelo` tiene
`{sonnet-5: $0.121, terra: $0.038}` y se descarta; en `llm_costo` queda **una**
fila `modelo:'parcial', costo_usd: 0.159`. El total es correcto; el desglose que
`costo_por_fase_modelo` le enseña a Javier pierde justo el turno en el que el
fallback cross-provider corrió — el único donde el desglose importa.

### [BAJO] TC-B2 (de la 29) — REINCIDENTE: `generateStructured.costoPorModelo` se produce y no lo consume nadie; el OCR sigue etiquetando el total con el modelo del ÚLTIMO intento

`src/lib/llm/openrouter.ts:678-685` · `:767` ·
`src/lib/likida/intake/ocr.ts:775` · `src/lib/likida/processor.ts:2074` · `:2574`

`grep -rn costoPorModelo src/ --include=*.ts` (sin pruebas, sin `openrouter.ts`)
devuelve **6 sitios, todos consumidores de `generateWithTools`**
(`chat/route.ts:128`, `run.ts:29`/`:99`, `analista.ts:258`/`:468-470`/`:517`,
`oficina_wa.ts:256`, `processor.ts:4392-4395`). Ninguno de los 7 llamadores de
`generateStructured` lo lee. `ocr.ts:775` sigue en
`costo: { modelo: res.model, …, costoUsd: res.cost }`, donde `res.model` es el
del último intento (`openrouter.ts:767`) y `res.cost` el acumulado de todos.

Escenario, con valores. Un ticket con `gemini-3.1-flash-lite` ($0.25/$1.50):
intento 1 devuelve JSON malformado (100 in / 400 out = $0.000625), intento 2
recibe 503, el fallback `claude-haiku-4.5` ($1/$5) cierra bien (900 in / 300 out
= $0.0024). `processor.ts:2574` escribe **una** fila
`modelo:'anthropic/claude-haiku-4.5', costo_usd: 0.003`, cargándole a Haiku el
gasto de Gemini — y es el renglón que sostiene la decisión medida del
4-ago-2026 («12.5× más barato»).

### [BAJO] TC30-B1 — NUEVO: la etiqueta `modelo` de `llm_costo` cambia de FORMA según si hubo fallback; el chequeo U1 del parte de costos puede gritar ROJO por eso

`src/lib/likida/processor.ts:4392-4400` · `src/lib/llm/openrouter.ts:1203` ·
`:264-267` · `src/lib/likida/agentes/finanzas.ts:175-181` · `:210-221` ·
`src/lib/admin/negocio.ts:507`

Las dos ramas del mismo `if` etiquetan con cosas distintas. Con **más de un
modelo** (hubo fallback) las filas se etiquetan con las llaves de
`costoPorModelo`, que son `activeModel` — **nuestro** slug canónico
(`openrouter.ts:1202`). Con **uno solo** (el camino normal) la fila se etiqueta
con `res.model` (`processor.ts:4399`), que es `used = res.model || activeModel`
(`openrouter.ts:1203`): **el eco del proveedor**. El propio archivo documenta que
ese eco puede traer sufijo — *«OpenRouter a veces devuelve el slug con sufijo de
proveedor (`:nitro`, `:floor`)»* (`:224-226`)— y `calcCost` lo limpia **solo para
precificar** (`:266`, `model.split(':')[0]`); nada lo limpia para la etiqueta que
se escribe.

Escenario, con valores. Turno normal de cuadre, sin fallback: OpenRouter
responde `model: "anthropic/claude-sonnet-5:floor"`. `modelosDelCiclo.length ===
1` → rama `else` → fila `modelo: 'anthropic/claude-sonnet-5:floor'`. Turno
siguiente, con fallback: filas `anthropic/claude-sonnet-5` y
`openai/gpt-5.6-terra`. En `getCostoPorFaseModelo` (`negocio.ts:507`) el mismo
modelo aparece como dos renglones; y `evaluarUmbralesCostos` compara
`f.modelo !== modeloEsperado('cuadre')` con `esperado =
'anthropic/claude-sonnet-5'` (`finanzas.ts:211-213`) → **ROJO U1**: *«la fase
`cuadre` corrió con un modelo distinto del esperado»*, sobre un override que
nunca existió.

Consecuencia: una alarma ROJA del parte diario de costos que culpa a una
variable de Vercel, y un desglose partido en dos para el mismo modelo justo en
la pantalla que existe para decidir el precio del producto. Depende de que el
proveedor devuelva el sufijo: eso no lo puedo comprobar sin red, pero es el
propio repo quien afirma que pasa, en dos comentarios y en el `split(':')` que
existe por ello.

## Lo que revisé y está bien

- **El catálogo de hoy y la regla de `properties: {}`.** Conteo medido con
  `grep -rn "registerTool(" src --include=*.ts` excluyendo pruebas y la propia
  definición: **33 tools**, el mismo número que la 29, y con el mismo reparto —
  14 `copiloto-tools.ts`, 12 `chat-tools.ts`, 4 `tools.ts`, 1 `analista.ts`
  (`entregar_respuesta`), 2 `copiloto.ts` (`proponer_accion`,
  `entregar_respuesta_admin`). **Ninguna tool nueva.** Las 4 del agente de dinero
  siguen con `parameters: { type:'object', properties:{}, additionalProperties:
  false }` (`tools.ts:40`, `:102`, `:182`, `:268`) y `tenantId`/`viajeId` siguen
  saliendo de `ctx`; `chat-tools.ts:33` (`SIN_PARAMS`), `:63-69` (`PARAM_MODO`,
  enum cerrado) con `modoDe` colapsando cualquier otra cosa a `'semanal'`
  (`:71-75`), `:278-283` (`proyectar_serie`, dos enums), `:374-382`
  (`consultar_normas`, enum sobre `TEMAS_NORMATIVOS`); `copiloto-tools.ts:32`
  (`SIN_PARAMS` en 11 de 14).
- **Hay que decir que 33 no es todo el catálogo, y la diferencia importa.**
  Además del registro hay **8 tools MCP** (`mcp/herramientas/busqueda.ts:58`,
  `:111`; `dinero.ts:89`, `:141`, `:221`, `:258`; `unidades.ts:59`;
  `viajes.ts:163`) y **5 esquemas ad-hoc** que `computer_use.ts:358-372` le pasa
  directo a `generateWithTools` sin pasar por `registerTool`, más el esquema
  `Accion` del piloto (`piloto_vision.ts:143-154`). Las 8 del MCP respetan el
  espíritu de la regla por otra vía (`mcp/herramientas.ts:72-101`: el `tenantId`
  sale de la credencial, el ÁREA se exige antes de ejecutar, `safeParse` de zod
  rechaza los args; `busqueda.ts:82-88` valida el uuid y lee con
  `getLibroViaje(tenantId, id)`). Las 5 de `computer_use.ts` NO, y está
  declarado desde la 27; la del piloto tampoco, y **no** estaba declarado
  (TC30-A1).
- **Las tres tools con texto libre del copiloto validan antes de tocar la base.**
  `copiloto-tools.ts:214-219` (uuid con regex antes del `select`), `:336-348`
  (`ficha_cliente` exige ≥2 letras y desambigua con >1 resultado en vez de
  adivinar la flota), `:303-310` (`bitacora`, filtro opcional sobre una lectura
  acotada). Son de la consola superadmin, que cruza tenants a propósito.
- **El foco de la ronda, verificado de los cuatro lados** (ver la sección de
  arriba): TS 9 fases = CHECK 9 fases, el test SQL cubre el caso que acepta **y**
  el que rechaza, `costos_dominio.test.ts` cruza las dos listas en ambas
  direcciones, y ningún llamador usa una fase fuera del conjunto.
- **`faseDeModelo` sigue acotado a `cuadre`** (`costos.ts:108-111`): el freno
  diario del chat lee `.eq('fase','chat')` y un `LIKIDA_MODEL_CHAT` apuntando a
  Opus no puede volver a archivarse como `escalacion`.
- **`registrarCosto` sigue fallando ruidoso y no mudo.** `costos.ts:126-133`
  (NaN/negativo se descartan con `logger.error` en vez de escribir un cero),
  `:137-147` (`{ error }` desestructurado, como las 19 funciones de `repo.ts`),
  `:219-225` (`costo.liquidacion_sin_costo`: una liquidación cerrada sin una sola
  fila se grita en el momento, no semanas después en el panel).
- **El corte del loop-guard ANTES del `Promise.all`.** `openrouter.ts:1255-1257`:
  con `terminales` vacío —el caso del agente de dinero, `run.ts:72-91` no pasa
  `terminalTools`— una `guardar_liquidacion` pedida en la última ronda **no se
  ejecuta**. `openrouter_loopguard.test.ts` lo ancla y además afirma que el
  `LoopGuardError` carga `executed`.
- **Los dos candados de `guardar_liquidacion` siguen en la TOOL, no en el
  prompt.** `tools.ts:291-298` (`cierrePedidoPorTexto`, calculado por el
  processor sobre el texto del turno) y `:368-376` (cierre en ceros +
  `cierreEnCerosConfirmado`), los dos LANZAN para que el error viaje al modelo;
  el kill switch de `:307-312` falla cerrado.
- **Idempotencia por EFECTO, no por llamada.** `tool-executor.ts:391-408` cachea
  la PROMESA antes del `await` y la llave es **el nombre**, no los args
  (`:394-402`, con el comentario que dice qué revisar el día que una tool sí
  decida sobre datos); `:164-167` rechaza cerrado una mutación sin `runId`;
  `:217-227` techa el lease en 10 renovaciones con `.unref()`; `:266-270` sella
  el éxito FUERA del `try` que decide el resultado de la tool; `:279-289`
  conserva el lease cuando el handler siguió vivo tras el timeout;
  `mutationEffectKey:353-355` lleva `runId` (un viaje reabierto se puede volver
  a liquidar).
- **El error crudo de Postgres no cruza al modelo.** `tool-executor.ts:140-147`
  (`VOCABULARIO_POSTGRES`), con el detalle completo en `logger.error`.
- **La reserva no se cobra ante un error de red** en las tres funciones
  (`openrouter.ts:404`, `:728`, `:1147-1152`), y `settle` conserva la reserva
  cuando el proveedor omite `usage` (`:411`, `:738`, `:1125-1127`) en vez de
  liquidar a cero.
- **`modelosAisladosDeFallback()` sigue vacío.** Recorrí `FALLBACK` (`:82-116`)
  contra `PRICES` (`:190-218`) a mano: los 14 slugs con precio están o como
  llave o como destino de la red. Ningún modelo se quedó sin plan B en silencio.
- **El piloto de visión, en todo lo que NO es el valor.** `piloto_vision.ts:453`
  (selector compuesto rechazado), `:460-462` (identidad exacta contra el
  inventario, no `includes`), `:468-476` (`contar() !== 1` se detiene),
  `:488-490` (el veto de emisión mira `esBotonQueEmite` **y** los cuatro rótulos
  del botón, en los dos modos), `:505-507` (guarda dura de contraseña vía
  `escrituraPermitida`), `:285-286` (un solo `LlmBudget` por sesión),
  `:650-658` (`senalDeSesion` devuelve una señal YA abortada si el reloj venció).
- **El texto de una página ajena viaja como DATO.** `piloto_vision.ts:614-616`,
  con la misma fórmula que `analista.ts` aplica a lo que lee.

## Lo que NO alcancé a revisar

- **Nada contra Postgres real ni contra los proveedores.** Sin `.env`, sin base y
  sin red: la RPC `reservar_presupuesto_llm` bajo concurrencia,
  `provider:{data_collection:'deny'}` y `reasoning:{enabled:false}` siguen siendo
  contrato declarado. El CHECK de la 0351 lo verifiqué **leyendo** el SQL y su
  test, no ejecutándolos: `supabase/tests/0351_*.sql` corre en `ci-postgres`, que
  aquí no existe. Mismo hueco que la 24 a la 29.
- **TC30-B1 depende de que OpenRouter devuelva el sufijo de proveedor.** Lo
  afirma el repo en dos comentarios (`openrouter.ts:224-226`, `:265`) y el
  `split(':')` de `calcCost` existe por eso, pero no lo pude observar en una
  respuesta real.
- **Ningún hallazgo está reproducido con una prueba EJECUTADA**: el encargo
  prohíbe tocar archivos del repo. TC-A1 lo recorrí por el interleaving
  (`Promise.all` → `map` → `executeTool` → `AsyncLocalStorage.run` →
  `await estaApagado`); una prueba que llame al executor **sin** `await` entre
  las dos llamadas (a diferencia de `copiloto.test.ts:125-128`) lo reproduce.
  TC30-M1 se reproduce con un mock que devuelva `finish_reason:'length'`,
  luego un 503, luego `length` con `completion_tokens: 512`.
- **`generateStructured` con audio** (`openrouter.ts:655`, el cast a
  `input_audio`): el fallback de `transcripcion` hacia `openai/gpt-5.6-luna`,
  que no tiene oído (`models.ts:146-148` lo documenta), sigue sin prueba. Quinta
  ronda pendiente.
- **Las 8 tools MCP a fondo.** Verifiqué la puerta común
  (`mcp/herramientas.ts:72-101`) y `busqueda.ts:82-88`; no audité el cuerpo de
  `dinero.ts`, `unidades.ts` ni `viajes.ts`.
- **La frecuencia real de TC-A2, TC-M1 y TC30-M1**: cuántos turnos del analista
  mueren en la última ronda, cuántas corridas de fondo truncan y con qué
  frecuencia el reintento al doble falla por otra cosa no se puede medir aquí.
