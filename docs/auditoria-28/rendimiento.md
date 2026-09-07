# Rendimiento y costo — auditoría 28

**Nota: 4/10** (antes 5). Razón del movimiento: **mirada más profunda** — el
código no cambió, la nota anterior estaba inflada. No es que empeorara: es que
se vio mejor. Lo verifiqué antes de escribir nada:
`git diff --numstat 06b2eca4..HEAD` sobre los doce archivos del rubro
(`intake/rep.ts`, `cron/descarga-sat/route.ts`, `cron/gps/route.ts`,
`sat_descarga/peaje_cierre.ts`, `conectores/sincronizar_eventos.ts`,
`facturacion/adaptadores/piloto_vision.ts`, `asistencia_escalamiento.ts`,
`intake/ocr.ts`, `presupuesto.ts`, `llm/openrouter.ts`, `llm/budget.ts`,
`llm/models.ts`) devuelve **vacío**: cero líneas en los 3 commits de la
ventana. Los ocho hallazgos de la 27 son REINCIDENTES por construcción y los
reconfirmé línea por línea (abajo, con su cita).

Lo que mueve la nota es lo que la 27 **no** cruzó. La 27 cerró con «el costo
por liquidación sigue medido, propagado y concordante» y ahí paró: verificó que
`LIQUIDACION_USD = $0.18` reconstruye su propia medición. Lo que no hizo fue
cruzar ese número con **el catálogo de planes que el producto vende**. Al
hacerlo (`budget.ts:256-261` contra `0052_saas_plan_suscripcion.sql:112-114` y
`0136_precios_live.sql:14-16`) sale que el techo derivado del plan —el escalón
3 de los 4 del contrato— **es código muerto para los tres planes del catálogo**,
que el techo real de toda flota es el piso global de **$5.00/día = 27
liquidaciones**, y que el único plan con precio vende **500 viajes/mes = 22.7
por día hábil**: el 84 % del techo antes de que corra un solo agente de fondo.
El costo unitario sí está medido; el **freno construido encima de él nunca se
dimensionó contra lo que el producto vende**, y cuando ese freno se dispara el
camino de las fotos lo reporta como «se cayó el OCR».

Con la escala del rubro, esto es el ancla de 4: el peor caso excede el límite
(los tres desbordes de cron de la 27, intactos) **y falla callado**.

**El riesgo mayor hoy:** una flota que firme el plan «Flota» ($17,500 MXN/mes,
500 viajes/mes) se queda sin IA a media tarde de un día normal, y lo que ve el
chofer es «se me trabó a mí al leer ese comprobante ⚙️ — no es tu foto…
reenvíamela en un momento» sobre una foto que no puede entrar hasta la
medianoche de México.

---

## Hallazgos

### [ALTO] El techo diario de IA por flota está dimensionado al PROMEDIO exacto, y para los tres planes del catálogo la derivación es código muerto

`src/lib/llm/budget.ts:256-261` (`topeDerivadoDelPlan`), `:204`
(`PISO_TOPE_TENANT_USD = 5.00`), `:216-217` + `:228-229` (el margen 1.5 aplicado
al TECHO, no al derivado), `:316` (`origen: 'plan'`), contra
`supabase/migrations/0052_saas_plan_suscripcion.sql:112-114` (los tres planes) y
`supabase/migrations/0136_precios_live.sql:14-16` (el precio y de dónde sale).
`src/lib/llm/models.ts:277` (`viajeCompleto = 0.184800`).
`.env.example:148` (`LIKIDA_LLM_TENANT_DAILY_BUDGET_USD=5.00`).

Escenario, con la aritmética completa. `topeDerivadoDelPlan` calcula
`derivado = (limite_viajes_mes / 30) × 0.1848` y lo acota con
`Math.max(derivado, piso)`. Los planes que existen:

| Plan | `limite_viajes_mes` | `derivado` | Techo aplicado | Origen que reporta |
|---|---|---|---|---|
| demo | 50 | (50/30)×0.1848 = **$0.31** | $5.00 (piso) | `'plan'` |
| flota | 500 | (500/30)×0.1848 = **$3.08** | $5.00 (piso) | `'plan'` |
| empresa | `null` | — (`:258` devuelve el piso) | $5.00 (piso) | `'piso'` |

El punto en que la derivación empieza a mandar es
`limite × 0.1848 / 30 > 5` → **811.7 viajes/mes**. **Ningún plan del catálogo
llega**, así que el escalón 3 del contrato de cuatro que documenta `:171-179`
nunca decide nada: el techo de toda flota nueva es el piso de $5.00, y
`topeDiarioDelTenant` (`:316`) lo etiqueta `origen: 'plan'` — /admin/consumo
pinta «viene de su plan» sobre el piso global.

Qué compran esos $5.00: **$5.00 / $0.1848 = 27.05 viajes completos al día**. El
plan «Flota» vende 500 viajes/mes, que son 16.7/día naturales pero **22.7 por
día hábil** (500/22) — el **84 %** del techo. Y el techo no es solo del chofer:
la reserva interactiva es `0.4 × $5.00 = $2.00` (`:155-158`, `:191`), o sea que
el carril de fondo puede llegar a **$3.00** antes de toparse
(`0244_antijoin_por_igualdad_y_presupuesto_por_proposito.sql:239`) y **ese gasto
cuenta contra el mismo total del tenant** (`0244:228`: `usado_tenant` suma
TODOS los propósitos). Un día en que el fondo use su parte, al camino
interactivo le quedan **$2.00 = 10.8 liquidaciones**. Entra un día hábil normal
de la flota que paga $17,500 MXN → salen entre **11 y 27** liquidaciones con IA
y el resto sin ella.

El comentario de `:207-215` dice que el margen operativo existe justamente para
«picos de fotos por viaje y reintentos»; el código lo aplica sólo al TECHO
global (`techoDerivadoPorDefectoUsd()` = 500 × 0.1848 × 1.5 = $138.60,
`:228-229`) y **nunca al valor derivado por flota**, que queda igual al gasto
medio esperado, sin un centavo de holgura. Un presupuesto puesto en la media
se rebasa la mitad de los días por definición.

Consecuencia: el contralor de la primera flota real ve que a media tarde los
choferes dejan de recibir cuadre y las fotos empiezan a rebotar; la única señal
es un correo (`budget.ts:339-350`) que le pide a Javier subir
`tenant.config.presupuestoLlmUsdDia` — una llave que hay que poner a mano flota
por flota, porque el escalón que debía calcularla nunca alcanza al piso.

Causa raíz probable: el techo por flota se derivó del costo medio por viaje sin
compararlo nunca contra el cupo que los planes del catálogo venden, y el margen
que el propio comentario declara se aplicó al techo global en vez de al
derivado.

---

### [ALTO] Cuando el techo diario se agota, el camino de la FOTO lo reporta como proveedor caído — y le pide al chofer reenviar algo que no puede entrar hasta medianoche

`src/lib/likida/intake/ocr.ts:425-470` (el `catch` de `extraerComprobante`),
`:451` (`vigilante.fallo()`), `:325-326` (`UMBRAL_OCR_CAIDO = 5`),
`:472-476` (`motivo: 'fallo_tecnico'`), contra
`src/lib/likida/processor.ts:4148` (`esErrorDePresupuesto`, el camino del
agente, que sí lo distingue) y `src/lib/likida/processor.ts:2403-2437` (lo que
se le dice al chofer).

Escenario: la flota del hallazgo anterior llega a sus $5.00 del día en la
liquidación #27. La foto #28 entra por `processor.ts:2315` →
`extraerComprobante` → `generateStructured` → `reserveLlmBudget` devuelve
`'tope_tenant'` y lanza `LlmBudgetExceededError` (`budget.ts:429-432`) **antes
de tocar al proveedor**. Ese error cae en el `catch` genérico de `ocr.ts:425`,
que fue escrito para «truncamiento, provider caído, timeout, schema roto»
(`:425-428`, literal). `codigoYStatus(e)` no devuelve 401/402/403 y
`abortado(e, signal)` es `false` (la señal no se abortó: el tope lanzó), así que
el error entra por `:451` → `vigilante.fallo()` → a los **5 seguidos** dispara
`alertarOperador('ocr.caido', { fallosSeguidos, status: null })`. Y como la
flota no dejó de mandar fotos, los 5 seguidos llegan en minutos.

Salida: el gasto se guarda como huérfano con `motivo: 'fallo_ocr'`
(`processor.ts:2412-2422`) y el chofer lee «*Se me trabó a mí al leer ese
comprobante ⚙️ — no es tu foto. Guardé la imagen… reenvíamela en un momento
para poder contarla. 📸*» (`processor.ts:2436`). Reenviarla falla idéntico: el
corte del día es `date_trunc('day', now() at time zone 'America/Mexico_City')`
(`0244:221`), o sea **hasta la medianoche de México**.

La asimetría es la prueba de que esto es una omisión y no un diseño: el camino
del AGENTE, en el mismo archivo, sí distingue el caso —`agotoPresupuesto =
esErrorDePresupuesto(e)` (`processor.ts:4148`), `COLOFON_SIN_PRESUPUESTO` y
cuadre determinístico (`:4173-4182`)— y su comentario dice exactamente por qué
importa: «no es lo mismo agotar el presupuesto que un error de código». El
camino de la foto nunca recibió esa distinción: `esErrorDePresupuesto` aparece
en **un solo sitio** de `processor.ts` y en **ninguno** de `ocr.ts`.

Consecuencia: (a) el chofer pierde comprobantes de su bolsa —el huérfano no
entra a la liquidación y él no sabe por qué—; (b) Javier persigue una caída de
OpenRouter que no ocurrió, porque `ocr.caido` viaja con `status: null` y sin
mención del presupuesto; (c) el aviso que sí describe el problema
(`presupuesto_ia.tope_tenant`, `budget.ts:339-350`) se manda **una vez por
flota por día** y desde un `Map` en memoria (`:326`), o sea una vez **por
instancia**, así que ni siquiera es fiable como contrapeso.

Causa raíz probable: el `catch` del OCR enumera las causas técnicas del
proveedor y el tope de dinero se sumó después, por debajo, sin ampliar esa
enumeración.

---

### [ALTO] El piloto de visión crea un `runId` nuevo en CADA paso: el único tope por corrida ($0.50) no acota una sesión, y una factura puede llevarse el carril de fondo entero del día

`src/lib/likida/facturacion/adaptadores/piloto_vision.ts:601`
(`budget: op.tenantId ? createLlmBudget(op.tenantId, randomUUID(), 'ocr_lote') : undefined`),
dentro de `decidir()` (`:537`), que se llama una vez por paso desde el
`for (let paso = 1; paso <= PASOS_MAXIMOS; paso++)` de `:264`; `:101`
(`PASOS_MAXIMOS = 14`). El tope por corrida vive en
`src/lib/llm/budget.ts:378-380` (`maxRunUsd`, default $0.50) y la RPC lo aplica
**scoped por `run_id`** (`0244:245-250`: `where tenant_id = … and run_id = p_run_id`).

Escenario: una sesión del piloto son hasta 14 pasos; cada paso construye un
budget con `randomUUID()` como `runId`, así que la RPC busca el gasto acumulado
de **ese** run —siempre 0— y el tope de $0.50 se estrena entero 14 veces. El
único freno que queda sobre la sesión es el techo del tenant, que para el
propósito `'ocr_lote'` es `$5.00 − $2.00 = $3.00` (`0244:239`).

Cuánto vale eso en dinero, con las constantes del propio repo: el rol `piloto`
es `anthropic/claude-sonnet-5` a **$2/$10 por millón** (`models.ts:140`,
`openrouter.ts:206`), `maxTokens: 700` (`piloto_vision.ts:599`), una imagen por
paso que la reserva cuenta a `TOKENS_POR_IMAGEN = 4_000` (`openrouter.ts:503`)
y el texto visible de la página **completo** dentro del mensaje
(`piloto_vision.ts:585-587`), que la cota cuenta a un token por carácter
(`openrouter.ts:531-556`). Con una página de portal de 20,000 caracteres:
reserva por paso ≈ (20,000 + 4,000 + system) × $2/1e6 + 700 × $10/1e6 ≈
**$0.06**; y cada paso puede repetirse hasta **4 veces** por la escalera de
`generateStructured` (`openrouter.ts:737-770`: intento + reintento con el tope
al doble + reintento con nota + fallback cross-provider), o sea **hasta 56
llamadas de visión Sonnet por sesión**. Liquidado al costo real (~8,000 tokens
de entrada por paso) son ~$0.023/paso → **~$0.32 por sesión limpia y ~$1.29 en
el peor caso**: entre **2 y 9 facturas** vacían los $3.00 del carril de fondo de
la flota para todo el día.

Consecuencia: el lote de autofactura puede consumir el presupuesto de fondo de
la flota entera antes del mediodía, y el tope por corrida —que existe
precisamente para que una sola operación no se lleve el día, `budget.ts:376-380`
lo dice con esas palabras («Seis rondas de Sonnet con 4k de salida caben en este
techo; el límite sigue siendo duro»)— no puede verlo. Y el mismo `$3.00`
consumido acerca el `tope_tenant` que apaga al chofer (hallazgo 1).

Causa raíz probable: `createLlmBudget` se llamó en el sitio de la llamada al
modelo en vez de al abrir la sesión, y `runId` se rellenó con un UUID nuevo en
vez de con el de la sesión del piloto.

---

### [MEDIO] El chat del panel del contralor corre en el carril de FONDO, que su propio módulo define como el carril donde no hay nadie esperando

`src/lib/agents/analista.ts:327`
(`createLlmBudget(opts.tenantId, runId, 'fondo')`), contra el contrato escrito
en `src/lib/llm/budget.ts:19-22`: «`'interactivo'` — hay una persona esperando
AHORA: el turno de WhatsApp del chofer…, **los chats del dashboard** y las
subidas manuales». Su hermano lo hace bien: `src/lib/agents/copiloto.ts:188`
declara `'interactivo'`.

Escenario: el contralor abre «Pregunta a tus datos» (`/api/dashboard/chat`,
`route.ts:22`) una tarde en que el lote de autofactura ya gastó su parte. Su
turno pide reserva con propósito `'fondo'` → la RPC entra por
`0244:234-241` → `'tope_proposito'` → `LlmBudgetExceededError`. El endpoint no
lee el motivo: `route.ts:172` manda `'el analista no pudo responder en este
momento'`. El mensaje que el error sí traía —«el trabajo de fondo reintenta en
su siguiente corrida», `budget.ts:37-39`— está escrito para un cron, no para una
persona mirando la pantalla.

Consecuencia: la pantalla de análisis del comprador se apaga por el consumo de
un proceso de fondo, que es exactamente lo que la reserva del 40 % existe para
impedir, y sin decir por qué. Es el rubro completo en una línea: la
clasificación de un carril no es una etiqueta, es quién se queda sin servicio.

Causa raíz probable: el analista se escribió antes de la 0244 y heredó el
propósito por defecto que se le puso a los agentes, sin releer el contrato del
módulo.

---

### [CRÍTICO · REINCIDENTE] `ingerirRep` hace hasta 3 consultas por `DoctoRelacionado` y NUNCA mira el reloj

`src/lib/likida/intake/rep.ts:190-241` — reconfirmado hoy, sin cambios: los dos
`for` anidados en `:190-192`, `rep.registrar` (`:195`), `rep.sellar` (`:220`),
`rep.buscarGasto` (`:236`). Llamadores: `processor.ts:1445`, `:1796`, `:3099` y
`src/app/api/correo/entrante/route.ts:345`.

La aritmética de la 27 sigue en pie sin tocar un número: un REP de 150 facturas
→ 450 consultas secuenciales × 0.3 s (`presupuesto.ts:88`) = **135 s** contra
los **57,000 ms** del correo (`correo/entrante/route.ts:88`, `:284-285`); el
corte real llega a los **63 doctos**. Al morir no corre el `delete` que libera
la fila de dedup, el reintento de Resend sale por `ya_procesado` y el REP —el
complemento que libera el IVA acreditable, LIVA 5-III— se pierde en silencio.

Este hallazgo lo encontró también, en paralelo y sin contacto, el auditor de
agéntico de la 27. Lleva **una ronda entera más** sin recibir una línea.

---

### [ALTO · REINCIDENTE] El cron de GPS mantiene el margen de 20 s sobre una unidad atómica de ~114 s

`src/app/api/cron/gps/route.ts:37` (`MARGEN_RELOJ_MS = 20_000`, verificado hoy,
y el comentario de `:32-36` sigue diciendo «molde de `descarga-sat`»), consumido
por `conectores/sincronizar_eventos.ts:487` y `:507`. La suma de 13 consultas
acotadas a `TECHO_PASO_CONSULTA_MS` = 9.5 s de la cadena
`dispararAsistenciaPorEventoCamara` (tabla completa en
`docs/auditoria-27/rendimiento.md`) da **~114 s acotados más una sin acotar**
(`asistencia_camara.ts:103`, `rotuloUnidad`, sin `acotada()`). El chequeo pasa a
los 279.999 s → la vuelta termina a ~394 s contra `maxDuration = 300`, sin
latido, con la fila arrendada 360 s y el cron corriendo cada 5 min: el 🚨 de una
colisión espera **10 minutos como mínimo**.

---

### [ALTO · REINCIDENTE] El margen del cron del SAT (20 s) sigue siendo la mitad de lo que cuesta una vuelta de sus dos bucles

`src/app/api/cron/descarga-sat/route.ts:82` (`MARGEN_MS = 20_000`, verificado
hoy), consumido por `sat_descarga/ciclo.ts:277` y `peaje_cierre.ts:318`.
`ingerir` camino casado = 4 × 9.5 s = **38 s**; `avisarCierrePeaje` = 9.5 + 9.5
+ 10 + 9.5 = **38.5 s**. Vuelta que arranca a los 279.999 s → ~318 s contra 300.
El sello `peaje_cierre_aviso` queda tomado sin soltar (`peaje_cierre.ts:387` no
llega a correr) y esa flota pierde el aviso de un umbral que es un día exacto.

---

### [ALTO · REINCIDENTE] El reloj del piloto de visión vigila el arranque del paso, no su duración: ~400 s contra 300

`facturacion/adaptadores/piloto_vision.ts:120` (`PRESUPUESTO_SESION_MS =
130_000`, verificado hoy), `:264-269`, `:592-602` (`generateStructured` **sin
`signal`**), contra `cron/facturar/lote.ts:80` (`MARGEN_LOTE_MS = 150_000`),
`:453` y `cron/facturar/route.ts:32` (`maxDuration = 300`). La escalera de
`generateStructured` son 4 × `TIMEOUT_LLM_MS` (30 s, `openrouter.ts:29`) = 120 s
sin señal que la acote; el guardia pasa a los 129.999 s → la sesión termina a
~250 s contra los 150 s prometidos, y el lote abre esa sesión hasta el instante
`inicioLote + 149.999 s` → **~400 s contra 300**.

---

### [MEDIO · REINCIDENTE] La cola de eventos de seguridad corre hasta 285 s de consultas después del último chequeo de reloj

`conectores/sincronizar_eventos.ts:820-854` — el `for` de `recuperadosUnicos`
(`:825`) y el de `recuperados.claims` (`:848`), ninguno consulta el reloj; el
último chequeo está en `:797`, dentro de un bucle que no corre cuando `filas`
viene vacío. 10 claims × (9.5 + 9.5) + 10 × 9.5 = **285 s** después de un
`venceEn` que dejaba 20 s.

---

### [MEDIO · REINCIDENTE] `.limit(5000)` que PostgREST corta en 1,000, con un detector de truncamiento insatisfacible

`sat_descarga/peaje_cierre.ts:243` y `:252` — verificado hoy palabra por
palabra: `const truncado = (gastos ?? []).length >= TOPE_GASTOS_PEAJE` con
`TOPE_GASTOS_PEAJE = 5_000` y `supabase/config.toml:38` en `max_rows = 1000`.
`1000 >= 5000` es falso por construcción: la alarma no puede dispararse nunca.
El comentario de `:245-251` calcula el punto de dolor «a 200 flotas»; con el
recorte real de 1,000 y ~25 cruces por flota al mes, el barrido deja de ver
flotas a partir de la **número 40** — 5× antes de lo que el archivo cree.

---

### [MEDIO · REINCIDENTE] Un `traerTodo` sigue sin desempate único y sin `conteo()`

`asistencia_escalamiento.ts:189-200` — verificado hoy:
`.order('abierta_en', { ascending: true })` como orden ÚNICO y `.select()` sin
`conteo()`. `pg.ts:132-135` lo prohíbe explícitamente. Dos incidencias con el
mismo `abierta_en` a caballo de la frontera de página: una se devuelve dos veces
y la otra se pierde, y `LecturaIncompleta` no se dispara.

---

### [MEDIO · REINCIDENTE] La captura del piloto va al modelo sin acotar, hasta 56 veces por sesión

`facturacion/adaptadores/piloto_vision.ts:598` — verificado hoy (la línea es
ahora un ternario de tres ramas, `images: captura?.startsWith('data:') ?
[captura] : captura ? [await comoDataUri(captura)] : undefined`, pero **sigue
sin redimensionar**). Es uno de los dos únicos sitios con `images:` del repo; el
otro (`intake/ocr.ts:405`) sí reduce a 1600 px. 14 pasos × 4 envíos = 56 subidas
del mismo PNG por sesión, y la reserva la cuenta a 4,000 tokens fijos
(`openrouter.ts:503`), así que el tamaño real no aparece en ningún tope ni en
ningún log — solo en el tiempo de subida, que es justo el que no cabe.

---

### [BAJO · REINCIDENTE] La foto principal pasa por `sharp` tres veces; dos resultados se tiran

`intake/ocr.ts:405` (`redimensionarParaVision`) contra
`intake/cfdi_imagen.ts:115` (el `for (const ancho of [ANCHO_PRINCIPAL_PX, 1000])`).
3 pasadas por foto, 2 descartadas: ~0.15-0.4 s de CPU idéntica y redundante por
comprobante, ~1.2-3.2 s por un fajo de 8, dentro de una invocación de la que
solo 80.4 s son utilizables.

---

## Lo que revisé y está bien

- **El costo unitario sigue medido y concordante, y lo reconstruí desde cero.**
  El system del agente de liquidación mide **6,269 caracteres** (`prompts.ts:74-107`,
  contado con `node` sobre el fuente) — a 4 caracteres por token son los **1,560
  tokens** que `models.ts:247-249` declara: la medición del 4-ago cuadra con el
  prompt de hoy. Los cuatro schemas de tools del agente suman **1,497
  caracteres** (`likida/tools.ts:33`, `:95`, `:175`, `:254`), o sea ruido frente
  a la conversación. `viajeCompleto = 0.18 + 3 × 0.0016 = $0.1848`
  (`models.ts:267-277`) sigue derivándose sin ningún número puesto a mano.
- **La reserva del ciclo de tools está bien construida y el número del repo es
  el correcto.** Reserva por ronda = `cotaEntradaEnTokens(messages) +
  JSON.stringify(tools).length` a un token por carácter, × tarifa, + `maxTokens`
  × tarifa de salida (`openrouter.ts:1005-1021`). Con el system de 6,269
  caracteres, las tools de 1,497 y `maxTokens = 4_000` (`agents/run.ts:33`) da
  ~$0.056 — exactamente lo que dice el comentario de `openrouter.ts:1073`. Y
  `settleLlmBudget` reescribe `reservado_usd` al costo real
  (`0186_runtime_idempotencia_y_presupuesto.sql:89-92`), así que la
  sobre-reserva de ~4× es transitoria y no infla el acumulado del día.
- **El loop-guard del cuadre no puede pagar una ronda que nadie va a leer.**
  `openrouter.ts:1165-1186`: en `round === maxRounds - 1` filtra a las
  terminales y, si no hay, lanza **antes** del `Promise.all`. Con
  `maxRondasCuadre() = 6` (`agents/run.ts:39-41`) y sin `terminalTools`
  declaradas en el agente de liquidación, el turno gasta a lo sumo 6
  completions y ejecuta tools en 5 — el techo está donde el comentario dice.
- **El costo de un turno que truena no se pierde.** `PartialExecutionError`
  carga `tokensIn/tokensOut/cost` (`openrouter.ts:786-802`) y los dos
  llamadores lo registran como modelo `'parcial'`
  (`processor.ts:4053-4066`, `api/dashboard/chat/route.ts:158-163`). Lo perseguí
  como fuga y me refuté.
- **El acuse por foto SÍ paga su costo de WhatsApp.** `say()`
  (`processor.ts:2066-2071`) llama `registrarCostoWhatsApp` y sólo cuando
  `sendText` devolvió id — 20 de los `say` del camino con viaje están dentro de
  ese helper. Con Meta cobrando desde el 1-oct-2026 a $0.008
  (`costos.ts:43-46`), un fajo de 21 fotos son $0.168 de acuses, del mismo orden
  que toda la IA de la liquidación: que estén medidos importa. (Lo que **no**
  pasa por `say` es el camino de XML/documento con tenant conocido —
  `processor.ts:3139`, `:3164`, `:3208`, `:3236`, `:3284` — pero ahí es un
  mensaje por documento, no por foto.)
- **La caché de prompt sigue marcada donde sirve y sólo ahí.**
  `openrouter.ts:978-982`: el breakpoint va en el `system`; los mensajes que
  cambian entre rondas no se marcan. `costoReal` (`:251-266`) toma el `cost` del
  proveedor antes que la tabla, que es lo que hace visible el 92 % de ahorro.
- **La RPC de reserva es fail-closed de verdad.**
  `0244:207-216` lanza ante montos inválidos o propósito desconocido en vez de
  devolver un `false` que se lea como «tope»; `budget.ts:435-441` trata
  cualquier respuesta fuera del contrato como error. Y el corte del día es
  medianoche de México (`0244:221`), no UTC.
- **`maxRunUsd` sí acota donde el `runId` es uno solo.** En el cuadre el `runId`
  se crea una vez por turno (`agents/run.ts:64`) y viaja a todas las rondas: ahí
  el tope de $0.50 hace su trabajo. El defecto del piloto es del sitio de la
  llamada, no del mecanismo.

## Lo que NO alcancé a revisar

- **La latencia real Vercel ↔ Supabase.** Todas las sumas usan los techos
  escritos en el repo (`TOPE_CONSULTA_MS` 8 s + 1.5 s de gracia,
  `TECHO_ENVIO_WHATSAPP_MS` 10 s). Sin base ni red, los desbordes de cron son
  ciertos como peor caso; su probabilidad no la puedo medir aquí.
- **El tamaño real del `texto` de un portal en el prompt del piloto.** La
  aritmética del hallazgo del piloto usa 20,000 caracteres como supuesto
  declarado; el valor real depende del portal y sin navegador no lo puedo medir.
  Si un portal trae 60,000, la reserva por paso se triplica.
- **Cuántas llamadas de modelo gasta de verdad una liquidación completa de punta
  a punta.** Conté las piezas (1 `generateStructured` por foto con escalera de
  hasta 4; 1 `runAgent` de hasta 6 completions por cada mensaje de TEXTO del
  chofer, `processor.ts:3948`; 1 transcripción por nota de voz,
  `voz_transcrita.ts:102`), pero **cuántos mensajes de texto manda un chofer
  real en una liquidación no está medido en ninguna parte del repo** — y ése es
  el multiplicador que decide si $0.18 es el costo de una liquidación o el de
  una conversación corta. Es la primera cosa que instrumentaría con la primera
  flota dentro.
- **El costo en Postgres del hash de cierre de la 0321** (`cierre_insumos_hash`
  calculado dos veces por cierre, con el advisory lock exclusivo del tenant
  tomado). Sigue sin base viva para medir el plan; la 27 lo dejó abierto por la
  misma razón.
- **`guardarYConciliarConsolidado` a escala** (`consolidado.ts:477`, lotes de 10
  sin reloj) — no pude fijar cuántas consultas cuesta `ligarLineaAGasto` por
  línea, así que no escribo la suma.
- **`npm test` completo.** Me apoyé en la línea base del MAPA (12,168 pasan, 5
  fallos INFRA por falta de loopback IPv6); no toqué código, así que no puedo
  haberla movido.
