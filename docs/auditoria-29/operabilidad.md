# Operabilidad y DX — auditoría 29

**Nota: 6/10** (antes 3). Razón del movimiento: **se atacó y subió**. Es la
razón correcta y no la regalo: abrí los ocho hallazgos abiertos de la 28 uno
por uno, y **siete están cerrados de verdad** — no por el asunto del commit,
sino porque reproduje el escenario y ya no sale. El cuello de botella que la 28
señaló como el que mataba tres críticos (`staging-recovery.mjs:121`) **quedó
abierto**: lo verifiqué creando una migración `0348` y corriendo las suites que
la 28 decía que se pondrían rojas — 28 archivos, 452 pruebas, 0 fallos.

Por qué **6 y no más**: el ancla del rubro dice «6 si hay logs pero nadie los
mira y el CI existe», y eso es literalmente el estado de hoy. **Producción está
sirviendo HTTP 503 desde hace 14 h 33 min**, el sistema lo detectó, abrió el
issue **#365**… y ese issue lleva desde el minuto cero sin que nadie lo toque.
El detector funciona; el destinatario no. Y no puedo dar 8 porque las dos
piezas que decidirían si «el camino del dinero genera alerta» —`ALERTA_EMAIL` y
`SENTRY_DSN` en Vercel— siguen sin ser verificables desde aquí, tercera ronda.

**El riesgo mayor hoy:** producción lleva 52 corridas del pulso en rojo
seguidas (`run_number` 513→564 de 564) con `checks.crons=degraded`, y el único
artefacto que existe mañana por la mañana es un issue de cuatro líneas cuyo
cuerpo remite al log de la corrida, donde el diagnóstico entero es **una
palabra**: `degraded`. Ni el endpoint ni el log nombran QUÉ cron murió.

---

## Estado de producción — lo que pude verificar y lo que no

**Sí pude.** Tuve API de GitHub y la usé; nada de esta sección es suposición.

**1. La mano humana SÍ ocurrió.** Issue **#344** está **CLOSED**, cerrado por
`javiercamarapp` el `2026-09-07T18:12:33Z`, con un comentario suyo
(`2026-09-07T18:12:32Z`) que dice, literal:

> «Pulso verde confirmado directamente contra /api/health: version=d56e626,
> migracion.base=0347=codigo, atras=0. Causa real de la deriva: 43 migraciones
> (0304-0347) sin aplicar en producción desde el 3-sep, más una guardia legal
> (LEGAL_ENFORCE_DOCS) sin configurar en Vercel que bloqueaba el build. Ambas
> resueltas.»

Confirmado de forma independiente en el log de la corrida **34212560163**
(`schedule`, hoy `2026-09-08T09:54:26Z`):

```
desplegado=d56e626 ultimo_[deploy]=d56e626
Producción corre el último [deploy] (d56e626) o uno posterior.
```

**Consecuencia directa: los dos primeros CRÍTICOS de la 28 están resueltos en
producción.** Ya no corre `4f94490` (3-sep) contra el esquema `0347`; corre
`d56e626`, y la RPC `gastos_fiscales_agregados_tenant` que la 0317 redefinió a
13 parámetros ahora la llama código que la conoce. El health de hoy lo
confirma: `migracion={"base":"0347","codigo":"0347","atras":0,...}`.

**2. Pero producción está en ROJO ahora mismo, y no por eso.** Del mismo log,
paso 1 de la corrida de las 09:54:25Z de hoy:

```
http=503 estado=degraded crons=degraded migracion={"base":"0347","codigo":"0347","atras":0,"aplicados":[...]}
##[error]/api/health no está healthy (http=503 estado=degraded crons=degraded …)
```

Frontera exacta, medida corrida por corrida:

| | corrida | evento | sha | hora | resultado |
|---|---|---|---|---|---|
| última **verde** | 34153943245 (`#512`) | push | `a1bf665` | `2026-09-07T19:01:11Z` | **success** |
| primera **roja** | 34155211629 (`#513`) | push | `5795ec6` | `2026-09-07T19:20:34Z` | failure |
| última medida | 34212560163 (`#564`) | schedule | `7bcc319` | `2026-09-08T09:54:13Z` | failure |

`total_count` del workflow = **564**. Entre `#513` y `#564` hay **52 corridas
consecutivas en `failure`** (muestreé tres páginas completas: las 50 que vi son
todas `failure`), a lo largo de **14 h 33 min**. El issue **#365** se abrió a
las `19:20:45Z` — 11 segundos después de la primera roja — y su `updated_at`
sigue siendo idéntico a su `created_at`.

**3. El detector que se construyó para el desastre de la 28 NO está en
producción.** El JSON vivo de `/api/health` es
`{"base":"0347","codigo":"0347","atras":0,"aplicados":[…]}`. Falta la clave
**`adelante`**, que `cotejar()` devuelve incondicionalmente
(`src/app/api/health/migracion.ts:113-123`). Producción corre código anterior a
`ddf0131` (el arreglo de OP-C1, que aterrizó en `c7bbb83`). El arreglo existe,
está probado, y no está donde tiene que estar.

**4. Ningún commit de la ventana lleva la bandera.**
`git log --format='%s' c7bbb83..HEAD | grep -ci "deploy"` → **0**. Cero de 52.

**No pude verificar** (todo esto vive en el panel de Vercel, que no alcanzo):

- **Qué cron es el que está `degraded`.** El endpoint no lo publica a propósito
  (`route.ts:45-46`, `:189-190`) y el log de Actions solo imprime la palabra.
- **Si `ALERTA_EMAIL`, `ALERTA_WA` y `SENTRY_DSN` están puestas.** Tercera
  ronda consecutiva sin poder responderlo. Si están vacías, esta nota es menor.
- **Qué valor tiene hoy `LEGAL_ENFORCE_DOCS` en Vercel** (ver `OP-A2`).
- El clon de esta sesión es **superficial** (`.git/shallow`, 52 commits, raíz
  `c7bbb83`) y el ref local `master` apunta a `615496d`, obsoleto: `d56e626` y
  `4f94490` **no existen en este clon**. Ninguna medida de arriba sale de git
  local — todas salen de la API. Eso es INFRA del contenedor, no del repo.

---

## Estado de los hallazgos abiertos de la 28

| # | Hallazgo de la 28 | Veredicto | Evidencia |
|---|---|---|---|
| C1 | `d56e626` aplicó esquema sin publicar código; `/api/health` lo llama `ok` | **CERRADO** (código) / **desplegado no** | `migracion.ts:119-122` añade `adelante`; `route.ts:176`, `:187` degradan con ella. En producción `base=0347=codigo`, así que la condición ya no se da. Pero el JSON vivo no trae `adelante`: el arreglo no está publicado. Ver `OP-A1`. |
| C2 | La 0317 dropeó la firma que el build vivo llama | **CERRADO** | Producción corre `d56e626` (código de la era 0347) contra `base=0347`. El desajuste ya no existe. |
| C3 | Sin monitor externo; el vigilante y lo vigilado comparten proveedor | **REINCIDENTE** (bajado a ALTO) | Repetí el grep de la 27/28: el único resultado sigue siendo prosa en `src/app/api/health/route.ts:18`. Baja de CRÍTICO porque `salud-produccion.yml:173-201` ahora **mide su propia cadencia** y hoy avisó `real=268min` — «Actions degradado» ya es visible desde dentro; «Actions muerto», no. Ver `OP-A3`. |
| A1 | El gate del smoke borra la causa y acusa un bypass fantasma | **CERRADO** | `production-candidate.mjs:190` ahora imprime `error?.message ?? error`; `:93` reutiliza el bypass existente en vez de crear otro; `:97`/`:105`/`:112`/`:115` conservan `originalError` y lo relanzan por encima del fallo de limpieza. El commit es `61e1330`. |
| A2 | El pulso dice «cada 30 min» y corre cada ~3 h, sin medirlo | **CERRADO como instrumentación** | `salud-produccion.yml:173-201` mide y avisa sin tumbar el job. Medido hoy en la corrida 34212560163: `cadencia: declarada=30min real=268min` + `::warning::`. La degradación sigue (4.5 h de hueco), pero ya no es una cifra falsa en un documento: es una medición. |
| A3 | El invariante es «el último `[deploy]`», no «el tip de `master`» | **REINCIDENTE, y la predicción se cumplió** | Ver `OP-A1`. |
| A4 | `staging-recovery.mjs:121` congela el inventario en `324`/`'0347'` | **CERRADO** | Ver el veredicto de abajo. |
| M1 | `sanitizeBuildLog` redacta `true` y deja el log ilegible | **CERRADO** | `prepare-build-env.mjs:24` fija `MIN_REDACTABLE_SECRET_LENGTH = 8` y `:28` filtra por él. `CI=true` (4), `Linux` (5), `22.23.2` (7) ya no se redactan. |
| M2 | El job «Crear Preview inmutable» pasó a `environment: production` | **NO REVISADO** — ver «lo que NO alcancé». |
| M3 | El backup de Storage nunca ha corrido en verde, ni a mano | **REINCIDENTE** | Ver `OP-M2`. |
| M4 | La compuerta manda a un script cuya verificación quedó 222 migraciones atrás | **CERRADO** | `scripts/ci/verificar-migraciones-aplicadas.mjs` (nuevo) coteja el **conjunto** repo↔`migraciones_aplicadas()` en los dos sentidos, y `aplicar-migraciones-y-humos.sh:77` lo llama como paso 2/3. La lista escrita a mano de la era 0115-0125 desapareció, y el `exit 2` por `.env.local` ausente también (`:36-41`: ahora es informativo). |
| M5 | DEPLOY.md § «Publicar un cambio» describe una receta que no publica | **CERRADO** | `docs/conocimiento/DEPLOY.md:360-440`: el paso 4 («COMPROBAR QUE CONSTRUYÓ») es explícito y no opcional; hay una sección «Si la compuerta dijo CONSTRUIR y `version` NO cambió» que manda mirar `migracion.adelante` primero, luego el panel; y sobre `deploy-preview-promote.yml` dice, literal, «**No es un botón que "simplemente funciona"**: la auditoría 28 midió 29 corridas de ese workflow sin promover NUNCA». El runbook dejó de mentir. `runbook.test.ts:195-211` ancla las dos cosas. |

**Bonus verificado, no era mío pero cae en mi terreno:** las 5 pruebas que la
28 dio por INFRA (`proxy-local.test.ts`, `EAFNOSUPPORT ::1`) **ya no fallan**.
`npx vitest run scripts/ci/e2e/proxy-local.test.ts` → 13 pasan, **5 saltadas**,
0 fallos. El commit `6beb5f5` funcionó.

---

## El veredicto sobre `staging-recovery.mjs` — **CERRADO**

Era el encargo más valioso de la ronda y la respuesta es que sí se cerró.

`scripts/ci/staging-recovery.mjs:119-129`. El literal desapareció; lo que queda
es estructural y atemporal:

```js
const expected = migrationFiles.map((name) => name.slice(0, 4)).sort();
if (expected.length === 0 || new Set(expected).size !== expected.length) fail('RECOVERY_LOCAL_MIGRATIONS');
```

Y la protección que el conteo fijo daba *de paso* —que no aparezca una
migración nueva entre `capture` y `execute`— sobrevive, pero cotejada contra lo
que el manifiesto capturó, no contra un número del pasado
(`:171-177` la graba, `:194` la compara).

**No me fié del diff: lo ejecuté.** Creé
`supabase/migrations/0348_auditoria29_sonda.sql` y corrí lo que la 28 dijo que
se pondría rojo:

```
npx vitest run scripts/              → 28 archivos, 452 pasan, 5 saltadas, 0 fallos
npx vitest run src/app/api/health src/lib/admin/salud.test.ts \
   src/lib/likida/startup_diagnostico.test.ts src/lib/likida/normas
                                     → 15 archivos, 205 pasan, 0 fallos
```

Borré la sonda; `git status --porcelain` vacío. **El paso a migraciones nuevas
quedó abierto**, y con él los tres críticos de otros rubros que morían ahí.

Queda un residuo, que reporto como `OP-M1` y no como reincidencia: el mismo
patrón —un número literal en vez de un artefacto derivado— sigue vivo tres
líneas más abajo, en el modo `execute`.

---

## Hallazgos

### [CRÍTICO] `OP-C1` — Producción lleva 14 h 33 min en 503 con un cron caído, y lo único que queda por la mañana es un issue de una línea que nadie ha tocado y un log que dice `degraded` sin decir de quién

`.github/workflows/salud-produccion.yml:85` · `:203-217` ·
`src/app/api/health/route.ts:104-158`, `:180-190` · `src/lib/admin/salud.ts:28`,
`:34-42`, `:73-74`

**Medido, no recordado.** Corrida **34212560163**, `2026-09-08T09:54:25Z`:

```
http=503 estado=degraded crons=degraded migracion={"base":"0347","codigo":"0347","atras":0,…}
```

52 corridas consecutivas iguales desde `2026-09-07T19:20:34Z`. Issue **#365**
abierto `19:20:45Z`, `updated_at == created_at`, **OPEN**.

**Qué significa `degraded`, leído en el código.** `route.ts:104-158` deja
exactamente dos causas: (a) `muertos = [...vencidos, ...sinLatido]` — un cron
que lleva más de `CADENCIA_MS + 20 min` sin latir, o que no latió nunca; o (b)
`regresiones` — un cron cuyo último resultado fue `fallo`/`parcial`/`saltado` y
que **no** es un hueco de configuración declarado. La tercera posibilidad está
excluida por construcción: un hueco declarado (`descarga-sat` sin
`LIKIDA_SAT_PROVEEDOR`) produce `config_ausente`, que `:132` y `:180-188`
deliberadamente **no** degradan. **El ruido conocido no explica esto.** Es un
cron muerto o una regresión real.

**Escenario, con valores.** Son las 3 a.m. y alguien abre el tablero. Ve el
issue #365, cuyo cuerpo dice: «Qué mirar, en este orden: `DEPLOY.md` § "Algo se
rompió". El cuerpo de `/api/health` (status, checks.crons, migracion) está en
el log de la corrida». Abre el log de la corrida. El log dice `crons=degraded`.
Eso es todo. El nombre del cron existe —`logger.error('health.cron_vencido',
{crons, haceMin, sinLatido})` en `:107-109` y
`alertarOperador('cron.sin_latido', {error: 'Sin latido: wa-outbox (hace 47
min)'})` en `:114-117`— pero vive **fuera de GitHub**: en Sentry y en el correo
a `ALERTA_EMAIL`, dos canales cuya existencia efectiva en producción no es
verificable desde aquí. Desde el repo, con el issue delante, **no hay manera de
saber qué cron murió**.

**Y no vuelve a avisar.** `salud-produccion.yml:203-206` lo dice como decisión
de diseño: «Mientras siga rojo no se comenta (48 comentarios al día es la misma
enfermedad que un correo por corrida)». El resultado medido es que **52
corridas rojas producen exactamente una notificación**, la del minuto cero, y
después silencio. En una bandeja, una caída de 30 minutos y una de 14 h 33 min
se ven idénticas: un solo issue, sin actividad.

**Consecuencia para alguien real.** Los crons del camino del dinero son
`wa-outbox` (cadencia 60 s, `salud.ts:35`) —el que de verdad saca los WhatsApp—
y `facturar` (15 min, `:42`). Con el primer cliente dentro, una liquidación se
cierra, el PDF se genera, y el mensaje nunca sale; el descubrimiento es la
pregunta del contralor. Hoy, sin clientes, lo que se cae es el demo: quien abra
`app.likida.ai` para enseñarlo lo hace contra un backend que su propio pulso
declara degradado desde ayer por la tarde.

**Causa raíz probable:** la alarma no escala con la duración. El estado del
incidente vive en un issue cuya regla de «no duplicar» convierte la persistencia
—la señal más informativa que tiene un incidente— en ausencia de señal.

---

### [ALTO] `OP-A1` — El cotejo del sha está en VERDE sobre una producción de 52 commits atrás, y uno de esos 52 es el arreglo del detector de la ronda pasada (REINCIDENTE; la 28 escribió este escenario y se cumplió)

`.github/workflows/salud-produccion.yml:136-158` ·
`scripts/ci/ultimo-deploy-en-asunto.mjs` · `src/app/api/health/migracion.ts:113-123`

La 28 escribió, textual: «En el momento en que alguien consiga publicar
`d56e626` […] el pulso quedará VERDE. A partir de ahí, `master` puede avanzar
los siguientes commits sin que nadie escriba `[deploy]` […] y el vigilante
seguirá verde todo ese tiempo.» **Eso es exactamente lo que pasó, en 14 horas.**

**Escenario, con valores.** Corrida 34212560163, `2026-09-08T09:54:26Z`:

```
desplegado=d56e626 ultimo_[deploy]=d56e626
Producción corre el último [deploy] (d56e626) o uno posterior.
```

Ese paso sale **verde**. Al mismo tiempo, `origin/master` es `7bcc319` y
`git log --format='%s' c7bbb83..HEAD | grep -ci "deploy"` = **0**: ninguno de
los 52 commits de la ventana lleva la bandera en el asunto. Lo que está en
`master` y no en producción incluye `59ab4e2` (SEG-A1: `qa-motor.ts` reasigna
`globalThis.fetch` a nivel de proceso, y un `wa-outbox` real concurrente en la
misma instancia sellaba como entregado un WhatsApp que jamás salió), `a466f9e`
(SEG-M1/M2), `03feb95` (la liquidación rechazada servida como vigente),
`910b755`/`d1cd337`/`b6920a5` (aviso y ARCO).

**La prueba de que el hueco es real y no teórico:** el propio arreglo de OP-C1
—el campo `adelante`, que existe precisamente para que la deriva de la 28 no
vuelva a leerse como «al día»— es uno de los 52. Se comprueba desde fuera sin
credenciales: el JSON que produce `cotejar()` siempre trae la clave
(`migracion.ts:123` devuelve `{ base, codigo, atras: 0, adelante: 0, aplicados }`),
y el JSON vivo de producción, medido hoy, **no la trae**.

**Consecuencia.** El único detector automático de «producción está al día»
seguirá en verde mientras `master` avanza indefinidamente. El próximo verde de
ese paso no significa «producción está al día»: significa «el último deploy que
alguien pidió, aterrizó». Y significa que la reparación de la observabilidad no
puede surtir efecto, porque su publicación depende del mismo mecanismo que ella
venía a arreglar.

**Causa raíz probable:** el invariante está mal elegido —«contiene el último
commit con `[deploy]`» en vez de «contiene el tip de `master`»—, y mientras la
intención de publicar viva como una subcadena en un asunto de prosa libre, «no
quise publicar» y «olvidé publicar» son indistinguibles por construcción.

---

### [ALTO] `OP-A2` — La válvula que apaga la compuerta legal se activa por PRESENCIA de un valor, y el sistema entero solo sabe vigilar AUSENCIAS: nada la registra al arrancar, nada la publica, nadie puede saber si sigue puesta

`src/lib/legal/config.ts:106-115` · `src/app/layout.tsx:55` ·
`src/lib/observability/arranque.ts:44-78`, `:93-111` · `.env.example:61`

`config.ts:109`:

```ts
const exigirDocs = process.env.LEGAL_ENFORCE_DOCS !== 'false';
const bloqueantes = exigirDocs ? estado.faltantes : estado.faltantesEntidad;
```

Poner la variable en `'false'` retira de la lista bloqueante los cuatro
documentos (`dpaVersion`, `slaVersion`, `seguridadVersion`,
`subencargadosVersion`). El propio archivo la describe como una válvula «de
forma explícita y **temporal**» (`:103-105`).

**Escenario, con valores medidos.** El `2026-09-07`, entre las 18:00Z y las
18:12Z, esa guardia dejó de bloquear el build: el comentario del dueño en el
issue #344 (`18:12:32Z`) nombra `LEGAL_ENFORCE_DOCS` como una de las dos causas
de la deriva y la declara «resuelta», y el deployment aterrizó a esa misma hora.
Hoy, `2026-09-08T09:54:25Z`, `/api/health` contesta
`{"ok":false,"status":"degraded","checks":{"db":"ok","crons":"degraded"},"version":"d56e626","migracion":{…}}`
— **ningún campo legal**. Y en el arranque tampoco sale nada: `arranque.ts:100`
es `SILENCIOSAS.filter((v) => !envPuesta(v.nombre))`, es decir, el modelo entero
de «configuración que hay que vigilar» está construido sobre la **ausencia** de
una variable. Una variable cuya **presencia con un valor concreto** apaga un
guardarraíl no cabe en esa lista por construcción, y no está en ella.

**Consecuencia para alguien real.** No puedo afirmar que la válvula esté puesta
—eso vive en el panel de Vercel— y ese es justamente el hallazgo: **nadie
puede**. La diferencia entre «el DPA existe y está firmado» y «alguien apagó la
exigencia una noche para desatascar un build y se le olvidó» no deja rastro en
ningún sitio que el operador pueda mirar: ni en el log de arranque, ni en
`/api/health`, ni en el runbook, ni en una prueba. `estadoLegalProduccion()`
(`config.ts:88-100`) ya calcula exactamente el dato que haría falta y **ninguna
ruta de salud lo llama**.

**Causa raíz probable:** `SILENCIOSAS` modela «variable que falta» y esta es
«variable que sobra»; una válvula documentada como temporal no tiene ni caducidad
ni superficie de observación, así que su estado permanente es el que quedó la
noche del incidente.

---

### [ALTO] `OP-A3` — Sigue sin haber monitor externo: el vigilante y lo vigilado comparten plano de control (REINCIDENTE, tercera ronda)

`src/app/api/health/route.ts:18` · `.github/workflows/salud-produccion.yml:29-34`

Repetí el grep de la 27 y la 28 con el mismo patrón
(`uptimerobot|betterstack|better-stack|cronitor|healthchecks\.io|pingdom|cron-job\.org|dead.?man`
sobre `docs/ src/ .github/ scripts/`, excluyendo las auditorías que se citan a
sí mismas). **El único resultado sigue siendo prosa**: `route.ts:18` («Un
UptimeRobot (o el cron de un tercero)…»), más un `dead/manual-review` de
`wa-outbox` que es otra cosa. Ni una variable, ni un secreto, ni un paso.

**Escenario.** Los tres detectores —el pulso, la compuerta y el cotejo del sha—
viven dentro de Actions. Su modo de falla es *no correr*, y una corrida que no
ocurre no manda correo ni abre issue: «Actions muerto» se ve idéntico a «todo
verde». Lo que sí cambió esta ronda, y por eso baja de CRÍTICO a ALTO: el paso
nuevo de `:173-201` mide la cadencia real del propio pulso y hoy avisó
`cadencia: declarada=30min real=268min` con un `::warning::`. Un pulso
*degradado* ya es visible desde dentro. Un pulso *muerto* sigue sin serlo, y la
medición sale del mismo `gh run list` que moriría con él.

**Consecuencia.** El día que exista el primer cliente, un cron del camino del
dinero puede morir a la vez que Actions y el descubrimiento será la pregunta del
contralor por su PDF.

**Causa raíz probable:** el vigilante y lo vigilado comparten proveedor.

---

### [MEDIO] `OP-M1` — El candado de conteo literal no se eliminó: se movió tres líneas abajo, al modo `execute`, donde falla DESPUÉS de haber vaciado staging

`scripts/ci/staging-recovery.mjs:214` · `:200` · `:87` · `:225`

El literal de `:121` que la 28 denunció está bien resuelto (ver el veredicto
arriba). Pero el mismo patrón —una igualdad contra un número escrito a mano en
vez de contra un artefacto que se regenere con el repo— sobrevive intacto en el
tramo destructivo, y la 28 no lo miró porque el `fail()` de arriba abortaba
antes de llegar ahí:

```js
:200  cli('RESET', ['db', 'reset', '--linked', '--no-seed', '--version', '0331', '--yes']);
:214  if (… || Number(physical[0].tables) !== 154 || …) fail('RECOVERY_FINAL_SCHEMA');
:225  console.log('RECOVERY_MIGRATIONS_COMPLETE: historial reconstruido hasta 0347; …');
```

(y `:87`, `tables.length !== 59`, en `inspectEmpty`).

**Escenario, con valores.** Alguien añade `supabase/migrations/0348_*.sql` con
un `create table`. La recuperación de staging arranca: `capture` pasa (la
validación estructural ya no se opone), `:194` pasa (el manifiesto es de esta
misma corrida), `:200` resetea la base, `:203` corre el preflight, `:206` hace
el `db push` de las 325 migraciones, `:208-209` confirma que el historial
coincide… y entonces `:214` compara `tables` real (**155**) contra el literal
**154** y lanza `RECOVERY_FINAL_SCHEMA`. El punto en el que falla es el peor
posible: **staging ya está vaciada y repoblada**, y el veredicto es un código de
error de nueve caracteres que no dice que la diferencia es «una tabla de más
porque tú la añadiste».

**Consecuencia.** El script existe para el peor día del proyecto y su enclavaje
final se rompe por un motivo que no es un riesgo. Sigue en MEDIO y no en ALTO
porque ya no pone el repo en rojo —eso era `OP-C4` y está cerrado— y porque el
camino solo se recorre con credenciales de staging que aquí no existen. Además
`:225` afirma «historial reconstruido hasta 0347» pase lo que pase: un rótulo
que no puede ser verdad después de la 0348.

**Causa raíz probable:** la misma de `OP-C4`, sin corregir donde el `fail()` de
arriba la ocultaba.

---

### [MEDIO] `OP-M2` — El backup de Storage sigue sin haber corrido en verde ni una vez, ni a mano: 14 días desde el último intento (REINCIDENTE, tercera ronda)

`.github/workflows/backup-storage.yml:3-12`

**Medido hoy** (`actions_list` sobre `backup-storage.yml`): `total_count` = **2**.
Las dos corridas de toda su historia son `2026-08-25T03:59:52Z` y
`2026-08-26T04:03:50Z`, ambas `conclusion: failure`, ambas `event: schedule`.
**Cero corridas de `workflow_dispatch`**, nunca. El propio comentario del
workflow (`:10-11`) pone la condición para reactivar el `schedule`: «hasta la
primera corrida MANUAL verde». Esa corrida no se ha intentado en **13 días**
(la 28 midió 13 y la 27 antes; la cifra solo crece).

**Escenario.** El bucket de Supabase Storage se pierde hoy. Ahí viven las fotos
de ticket y los PDFs de liquidación: la evidencia que el contralor cruza y la
que sostiene una deducción ante el SAT. No existe una copia verificada fuera de
Supabase y ningún workflow programado lo va a decir.

**Consecuencia.** `docs/operacion/RESILIENCIA-DEPLOY.md` publica objetivos
RPO/RTO; el RPO real de Storage es *indefinido*, no un número. Sigue en MEDIO
—y no sube— **solo** porque el repo lo declara por escrito y `runbook.test.ts`
lo ancla (`:186-193` exige que `RESILIENCIA-DEPLOY.md` diga «schedule apagado a
propósito» y que el workflow no tenga `schedule:`). Se vuelve ALTO el día que
exista el primer cliente.

**Causa raíz probable:** el environment `production-backup` nunca se configuró y
nada calendariza esa tarea.

---

### [BAJO] `OP-B1` — El trinquete de `.limit()` guarda el mismo número dos veces, y la copia que se mantiene a mano pone en rojo el CI de todo el mundo cuando alguien arregla un sitio

`ci/limite-sin-orden-baseline.json` · `src/lib/likida/limite_con_orden.test.ts:92-95`

El baseline declara `"total": 188` **y** un mapa `porArchivo` de 82 entradas
cuya suma es 188. La prueba `:92-95` comprueba que coincidan… y en `:95` usa
`BASELINE.total` para el aserto final, teniendo `suma` ya calculado en `:93`.

**Escenario, ya ocurrido, con valores.** Un lote arregla un `.limit()` real y
baja el contador de ese archivo en `porArchivo`, sin tocar `total`. El baseline
queda en `189` declarado contra `188` sumado. A partir de ese merge, **cualquier
PR nuevo** —de cualquier rubro, tocando cualquier archivo— falla en
`limite_con_orden.test.ts` con «el `total` del baseline se quedó atrás de
`porArchivo`». Hizo falta un commit dedicado (`70821b2`, `2026-09-07T20:37:36Z`,
un archivo, `-189/+188`) para desbloquear el repo.

**Consecuencia.** Un peaje sobre todo el equipo cobrado en el momento de menos
contexto, y por una cifra que el propio código puede derivar. Es BAJO y no más
porque el mensaje de fallo es excelente: nombra el archivo, el número viejo, el
nuevo, y qué editar.

**Causa raíz probable:** un artefacto de trinquete guarda un valor derivado
junto a sus partes en vez de derivarlo al leer.

---

## Lo que revisé y está bien

- **El logger contesta la pregunta que define el rubro.** `src/lib/logger.ts:99-107`
  (`huellaId`, FNV-1a 64 truncado a 12 hex) y `:110-123` (`redactarTexto`): un
  UUID **no se borra, se huella**, así que dos fallos de PDF de flotas distintas
  ya no producen la misma línea carácter por carácter, y el ingeniero de guardia
  cruza el log contra Postgres con `huellaId(fila.id)`. El RFC, el teléfono, la
  CLABE, el PAN y el correo sí se borran enteros, con la regla escrita en
  `:42-46`: «se huella lo que no se puede adivinar, se borra lo que sí». Y
  `:79-82` lo hace en **una sola pasada** con las reglas alternadas, para que la
  salida de una no sea entrada de la siguiente. Es el mejor archivo del rubro.
- **`onRequestError` existe y lleva el `digest`.** `src/instrumentation.ts:70-97`:
  cualquier error no atrapado del servidor (Server Components, route handlers,
  acciones, proxy) emite `request.fail` con `ruta`, `tipo`, `metodo`, `digest` y
  `err`, va a Sentry y hace `flush` antes de que muera la invocación. Y
  `logger.ts:146` protege `digest` del redactor (son diez dígitos, o sea la forma
  exacta de un celular sin lada) — es el único puente entre lo que el contralor
  ve en pantalla y la línea del servidor.
- **El fallo solo-de-cliente ya no se pierde.** `logger.ts:177-189` +
  `:211-213`: un `error.tsx` que truena en el navegador hace un `POST` con
  `keepalive` a `/api/client-error` —la única salida que la CSP `connect-src
  'self'` permite— y ahí sí corre el logger de servidor. Best-effort a
  propósito, nunca lanza.
- **El arranque grita lo que arranca mal en silencio.** `observability/arranque.ts:44-78`
  (`SILENCIOSAS`, siete entradas con su consecuencia escrita) y `:93-111`.
  `instrumentation.ts:10-23` fija el orden correcto: primero se dice si hay
  observabilidad, después se enciende, y solo entonces se prueban las
  migraciones — «así el diagnóstico sale por un canal que ya existe». Y
  `runbook.test.ts:139-152` itera sobre **la lista viva**, no sobre un literal
  propio, así que una variable nueva que entre a `SILENCIOSAS` sin entrar a
  `DEPLOY.md` pone la suite en rojo.
- **`.env.example` no se puede quedar atrás del código.** `runbook.test.ts:50-110`:
  tres pruebas que barren `src/` buscando `process.env.X` y exigen que
  `.env.example` documente todas, no documente ninguna muerta, y no declare
  ninguna dos veces. Más `:154-165`: `ANTHROPIC_API_KEY`/`GOOGLE_API_KEY` no
  pueden aparecer si nadie las lee — «el Plan B del demo en vivo» que no
  existía.
- **`npm install` no depende de un host fuera del registry.** `runbook.test.ts:112-134`:
  ninguna dependencia se resuelve por `http(s)` fuera de `registry.npmjs.org`, ni
  en `package.json` ni en el lockfile, y el tarball de `xlsx` está vendorizado y
  fijado por `file:`. Un tercero ya no tiene voto sobre si Likida puede publicar
  un hotfix.
- **`scripts/seed.sh` sí deja el proyecto corriendo en una máquina limpia.**
  `:23-29` comprueba `psql` antes de nada y da la instrucción por plataforma;
  `:32-40` detecta una pila local ya levantada y saca la URL de `supabase status
  -o json` en vez de rendirse cuando falta `DATABASE_URL`; y ofrece las dos
  rutas (local desechable y remota) desde la cabecera.
- **La compuerta sigue siendo fail-closed donde importa.**
  `scripts/ci/compuerta-deploy.mjs:104-106` (health ilegible → no se construye),
  `:125-135` (cotejo por **conjunto** con `m.aplicados`, no máximo contra
  máximo), `:174-194` (`leerHealth`: solo 200 y 503 cuentan). Y el
  `[deploy]` se lee solo del asunto en los tres sitios, sin reimplementaciones
  (`:51` exporta `FLAG_DEPLOY_RE`; `salud-produccion.yml:97` y `:116` hacen
  `head -n1`).
- **El verificador nuevo falla cerrado y no filtra Postgres.**
  `verificar-migraciones-aplicadas.mjs`: sin credenciales, con la RPC caída o con
  `disponible !== true`, el veredicto es «NO se pudo verificar» y `exit 1`, nunca
  «está bien»; y el `error.message` crudo va en una línea aparte marcada
  `detalle (Postgres):`, nunca en la línea de veredicto.
- **El gate del candidato ya conserva la causa.** `production-candidate.mjs:190`
  imprime `error?.message ?? error`; `:93` reutiliza un bypass existente en vez
  de crear uno nuevo (el «bypass fantasma» de la 28); `:97-115` guarda
  `originalError` y lo relanza por encima del fallo de limpieza, en vez de que el
  `finally` se lo coma.
- **La suite del rubro está verde, medida hoy.** `npx vitest run scripts/` → 28
  archivos, 452 pasan, 5 saltadas, 0 fallos, 4.22 s — **con una migración `0348`
  sintética presente**.

---

## Lo que NO alcancé a revisar

Sin esto la nota es una mentira por omisión:

1. **Qué cron concreto está `degraded` en producción.** Es la pregunta central
   del CRÍTICO y no tengo credenciales de Supabase ni sesión de `/admin/salud`.
   La ventana verde→rojo (`19:01:11Z` → `19:20:34Z`, 19 minutos) es compatible
   tanto con un cron de 60 s que dejó de latir hacia las 18:59 y venció a los 21
   min (`CADENCIA_MS + TOLERANCIA_LATIDO_MS`, `salud.ts:35`/`:74`) como con
   cualquier cron que empezara a reportar `fallo`. **No las pude separar y no
   afirmo cuál es.**
2. **Si `ALERTA_EMAIL`, `ALERTA_WA` y `SENTRY_DSN` están puestas en Vercel.**
   Tercera ronda consecutiva. `alertaConfigurada()` (`alerta.ts:37-39`) exige
   `ALERTA_EMAIL` **y** `correoConfigurado()`; sin ellas cada
   `alertarOperador(...)` es un no-op silencioso y por diseño. Si están vacías,
   el CRÍTICO de arriba es peor de lo que lo escribí y esta nota debería bajar.
3. **Si Sentry tiene DSN real y reglas de alerta.** El cableado del repo
   (`logger.ts:204-206`, `observability/sentry.ts`) es correcto; el efecto vive
   fuera.
4. **`OP-M2` de la 28** — el job «Crear Preview inmutable» con
   `environment: production` y el paso tautológico que dice verificar
   credenciales de Preview (`deploy-preview-promote.yml:250`, `:261-268`,
   `:64-67`). No lo reabrí; queda como **NO REVISADO**, no como cerrado.
5. **`rollback-production.yml`, `recover-empty-staging.yml`, `e2e-navegador.yml`,
   `codeql.yml`, `ci-postgres.yml`, `auto-merge-rutina.yml`, `ci.yml`** — no los
   abrí, cuarta ronda consecutiva. `ci.yml` en particular está en mi rubro por
   escrito y no lo miré.
6. **No corrí la compuerta completa** (`npm test`, `tsc`, `lint`). Corrí
   `scripts/` entero, `src/app/api/health`, `salud.test.ts`,
   `startup_diagnostico`, `normas` y `proxy-local.test.ts`. Me apoyé en la línea
   base del `MAPA.md` para todo lo demás.
7. **No pude pegarle a `https://app.likida.ai/api/health` desde aquí.** Todas
   las medidas de producción salen de los logs de GitHub Actions, no de una
   petición mía. Si el estado cambió entre las `09:54:13Z` de hoy y el momento
   en que se lea esto, mis cifras siguen siendo ciertas para esa hora y no para
   ahora.
8. **El clon es superficial** (`.git/shallow`, 52 commits, raíz `c7bbb83`) y el
   ref local `master` está obsoleto (`615496d`). Es INFRA del contenedor, no un
   defecto del repo, pero significa que cualquier afirmación mía sobre historia
   anterior al 7-sep sale de la API de GitHub y no de git local.
