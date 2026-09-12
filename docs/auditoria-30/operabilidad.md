# Operabilidad y DX — auditoría 30

**Nota: 7/10** (antes 6). Razón del movimiento: **se atacó y subió** — pero
subió por un eje solo, y no es el del CRÍTICO. Lo que se atacó y cerró de
verdad es **el modo de falla silencioso de la publicación**, que era la herida
mayor de la 29 (43 commits sin publicar, cero `[deploy]`): esta ventana trae
**7 commits con `[deploy]` en el asunto**, y producción corre hoy `cfa00ab`,
que es exactamente el último de ellos. Lo medí en el cuerpo vivo de
`/api/health`, no lo inferí. **OP-C1, en cambio, no movió una línea:**
`git diff 7bcc319..HEAD -- src/app/api/health/ .github/ scripts/ vercel.json`
son **seis líneas, todas en `ci-postgres.yml`**, y ninguna toca el veredicto ni
el pulso.

**El riesgo mayor del rubro, hoy:** producción está verde y coherente, pero su
diagnóstico sigue cabiendo en una palabra — y esta ventana midió cuánto cuesta
esa palabra: **104 corridas rojas consecutivas del pulso, 57 h, una sola
notificación**, para descubrir al final que faltaba una variable de entorno.

---

## Estado de publicación (medido, no inferido)

**Los 7 commits con la bandera en el asunto** (`git log 7bcc319..HEAD` filtrado
por `\[deploy(:forzar)?\]` en la primera línea — la misma regla que aplica
`scripts/ci/ultimo-deploy-en-asunto.mjs`):

| Sha | Asunto | Qué cubre (todo lo anterior a él) |
|---|---|---|
| `3269a7c` | `chore(deploy): publicar serie de migraciones auditoria-28 (0348-0356) [deploy]` | las 9 migraciones `0348`–`0356` |
| `b9908ed` | `[deploy] publicar auditoría 29, dof-diario y latido 08-sep` | `8fc2fa7` (FIS-C1, LEG-C1), `31638fd`, `03bd4e8` |
| `933ead4` | `[deploy] publicar Cache-Control: no-store …` | `0754652` (SEG) |
| `a6f924f` | `[deploy] publicar detalle real de crons parciales en /admin/crons` | `94de18f` (mi rubro) |
| `7ed8920` | `[deploy] publicar fix de Cal.com config_ausente + campaña de pruebas E2E` | `15fd8d3` (mi rubro) + los ~20 commits de cobertura |
| `a13aed9` | `[deploy] publicar REN-C1 (reintento de consolidado ECC)` | `d0db998` |
| `cfa00ab` | `[deploy] publicar fix de integridad de REN-C1 (keyset en candidatosDb)` | `e2038a5` |

**El MAPA dice «5 commits `[deploy]`»; son 7.** Los dos que se le escapan son
`3269a7c` (lleva la bandera al FINAL del asunto, que el `grep -qiE` acepta
igual) y `b9908ed`. La diferencia no cambia el veredicto, pero la cifra que se
cita de memoria no es la que devuelve el filtro.

**Qué quedó SIN cubrir: un commit, un archivo.**

```
git log cfa00ab..HEAD  →  4e36c82 chore(normas): latido de vigilancia — 10-sep-2026
git diff --stat cfa00ab..HEAD  →  normas/.latido-vigilancia | 61 ++++---  (1 archivo)
```

Es un archivo de latido de la vigilancia normativa, sin código y sin ficha
cambiada. **Cobertura efectiva de arreglos en esta ventana: 100 %.**

**Confirmado contra producción, no contra el repo.** Corrida `34687967901`
(`schedule`, hoy `2026-09-12T10:15:36Z`), paso 4 y paso 7:

```
http=200 estado=ok crons=config_ausente migracion={"base":"0356","codigo":"0356","atras":0,"adelante":0,"aplicados":[…"0356"]}
desplegado=cfa00ab ultimo_[deploy]=cfa00ab
Producción corre el último [deploy] (cfa00ab) o uno posterior.
cadencia: declarada=30min real=256min (corrida anterior: 2026-09-12T05:59:27Z)
```

Tres cosas que ese cuerpo cierra y que hay que anotar en su favor:

1. **El campo `adelante` YA está publicado.** La 29 lo reportó como la prueba
   de que el arreglo de la observabilidad no podía surtir efecto porque su
   publicación dependía del mecanismo que venía a arreglar. Hoy el JSON vivo lo
   trae. Ese círculo se rompió.
2. **`base=0356`, `codigo=0356`, `atras=0`, `adelante=0`.** Nueve migraciones
   nuevas entraron y la base va a la par del código. La compuerta funcionó de
   punta a punta (`compuerta: CONSTRUIR` en el log de la corrida 34437455166).
3. **Producción lleva verde desde `2026-09-10T05:51Z`** (corrida `#617`);
   ~53 h al momento de escribir esto.

**Lo que NO pude medir — INFRA.** El egress de red de este contenedor está
bloqueado: **no pegué ni una vez a `https://app.likida.ai/api/health`**. Todo lo
de arriba sale de los logs de GitHub Actions vía MCP, que sí respondieron. Si
producción cambió de estado después de las `10:15:36Z` de hoy, mis cifras son
ciertas para esa hora y no para ahora. Tampoco alcanzo el panel de Vercel, así
que `ALERTA_EMAIL`, `ALERTA_WA`, `SENTRY_DSN` y `LEGAL_ENFORCE_DOCS` siguen sin
verificarse — **cuarta ronda consecutiva**, y es INFRA del entorno, no del repo.

---

## Dictamen sobre `94de18f` — el arreglo que cita OP-C1

**No hace visible cuál cron cayó. Pinta mejor una pantalla que a las 3 a.m. no
va a estar abierta.** El commit toca dos archivos y ninguno es el que OP-C1
nombra:

- `src/app/admin/crons/vista.tsx:108-120` añade `resumenDetalle()`, y `:170-172`
  lo cuelga de la columna «Por qué» para `parcial` y para `fallo` sin `codigo`.
  **El arreglo es real y su prueba muerde**: `vista.test.tsx` monta
  `wa-outbox` con `{enviadas: 5, fallidas: 3}` y exige `toContain('fallidas')`;
  con el cambio revertido esa celda imprime `—` y la prueba se pone roja. Lo
  verifiqué corriendo la suite: 6 archivos, 95 pruebas, 0 fallos.
- Pero la columna que mejoró es la del **«por qué»**. La del **«cuál»** ya
  existía desde siempre: la tabla siempre imprimió el nombre del cron. **OP-C1
  nunca fue sobre esta pantalla.** Fue sobre los dos artefactos que sí existen a
  las 3 a.m.: el issue de `salud-produccion` y el log de la corrida.

Y esos dos no cambiaron una línea:

- `src/app/api/health/route.ts:45-46` y `:189-190` siguen negándose a publicar
  el nombre **a propósito** («el detalle de qué cron fue vencido queda en el log
  privado»), y `:192-202` arma un cuerpo sin un solo identificador de cron.
- `.github/workflows/salud-produccion.yml:81` sigue imprimiendo
  `echo "http=$status estado=$estado crons=$crons …"`, y `:85` sigue siendo el
  único `::error::`.
- `salud-produccion.yml:217` sigue abriendo el mismo issue de cuatro líneas que
  remite a «el cuerpo de `/api/health` … está en el log de la corrida».

El propio `vista.tsx:16-20` lo dice en su encabezado, y es la mejor prueba de
que la asimetría es deliberada y conocida: «`/api/health` … contesta un booleano
agregado … porque es un endpoint público: a quien pregunta desde fuera no se le
dice qué reloj se paró».

**La pantalla es una cosa; el veredicto y el pulso son otra.** El arreglo cayó
del lado que ya veía.

---

## Hallazgos

### [CRÍTICO] `OP-C1` — `crons=degraded` sigue sin decir cuál, y esta ventana midió el precio: 104 corridas rojas, 57 h, una notificación, para descubrir una variable de entorno que faltaba (REINCIDENTE, 4ª ronda; cero líneas cambiadas)

`.github/workflows/salud-produccion.yml:81`, `:85`, `:203-217` ·
`src/app/api/health/route.ts:45-46`, `:107-117`, `:189-190`, `:192-202`

**Escenario, ya ocurrido, con valores.** El `2026-09-07T19:20:34Z` el pulso pasa
a rojo (corrida `#513`). Se abre el issue **#365** once segundos después. A
partir de ahí, cada corrida imprime exactamente esto y nada más:

```
http=503 estado=degraded crons=degraded migracion={"base":"0347","codigo":"0347","atras":0,…}
```

**La última roja es la `#616`**, `2026-09-10T04:33:27Z`. Entre `#513` y `#616`
hay **104 corridas consecutivas en `failure`** a lo largo de **57 h 13 min**, y
`salud-produccion.yml:203-206` garantiza por diseño que produzcan **una sola
notificación**: la del minuto cero. En una bandeja, 30 minutos de caída y 57
horas se ven idénticos.

**Qué era, al final.** Faltaban `CALCOM_API_KEY` / `CALCOM_WEBHOOK_SECRET` en
Vercel, `ejecutarMantenimientoCalcom()` lanzaba, y el cron `escalar` reportaba
`fallo` cada hora. Lo dice el mensaje de `15fd8d3`. Para llegar ahí hubo que
**leer el código**: ni el issue, ni el log, ni el endpoint nombraron `escalar`
una sola vez en 104 corridas. El nombre existía —`route.ts:107-109`
(`logger.error('health.cron_vencido', {crons, …})`) y `:151-154`
(`alertarOperador('cron.estado_no_ok', {error: 'Cron con resultado no sano:
escalar (fallo)'})`)— pero vive en Sentry y en `ALERTA_EMAIL`, dos canales cuya
existencia efectiva en producción no es verificable desde aquí (4ª ronda).

**Consecuencia para alguien real.** Esta vez el cron caído era Cal.com, que no
toca dinero, y no había clientes. Los crons del camino del dinero son
`wa-outbox` (cadencia 60 s, `salud.ts:35`) y `facturar` (15 min, `:42`), y
producen **el mismo texto**: `degraded`. Con el primer cliente dentro, una
liquidación se cierra, el PDF se genera, el WhatsApp no sale, y lo que queda por
la mañana es un issue de cuatro líneas y una palabra en un log. El
descubrimiento es la pregunta del contralor.

**Causa raíz probable:** el endpoint decide su cardinalidad por privacidad
(público, sin auth) y el workflow hereda esa decisión como si fuera suya; entre
los dos no hay un canal autenticado que sí pueda nombrar el reloj, así que la
privacidad del endpoint acaba siendo la ceguera del operador.

---

### [ALTO] `OP-A1` — `15fd8d3` sí apagó una alarma legítima: `configAusente: true` se estampa sobre el latido ENTERO de `escalar`, y `esHuecoDeConfiguracion` lee ese booleano antes que nada — un corte por reloj real sale en 200 verde

`src/app/api/cron/escalar/route.ts:415-425` · `src/lib/admin/salud.ts:211-219` ·
`src/app/api/health/route.ts:127-132`, `:185-188` ·
`src/lib/admin/calcom.ts:530-533`

La reclasificación en sí es correcta y defendible: faltar una API key **es** un
hueco de configuración, y `descarga-sat` ya resolvía el mismo caso así. El
problema es el **alcance**. `escalar` corre seis motores; la marca se pone sobre
el latido de los seis:

```ts
:415  const calcomSinConfigurar = (resultado.calcom as {configured?: boolean}|undefined)?.configured === false;
:416  const configAusente = !huboFallo && calcomSinConfigurar;
:419  estado: huboFallo ? 'fallo' : (cortados > 0 || corteDuro || configAusente) ? 'parcial' : 'ok',
:421  detalle: corteDuro ? { cortesSeguidos, cortados, corteDuro: enVuelo }
:423        : configAusente ? { cortesSeguidos, cortados, configAusente: true, motivo: 'Cal.com no configurado: …' }
:424        : { cortesSeguidos, cortados },
```

Y `salud.ts:215` es una puerta que se cierra antes de mirar nada más:

```ts
if (typeof detalle.configAusente === 'boolean') return detalle.configAusente;
```

**Escenario, con valores.** Una hora cargada. `escalar` corre; ningún motor
lanza (`huboFallo = false`); el reloj blando corta **5 comprobaciones y
vencimientos** (`cortados = 5`, `corteDuro = false`); Cal.com sigue sin
configurar.

- `configAusente = true` → `detalle = {cortesSeguidos: 1, cortados: 5,
  configAusente: true, motivo: 'Cal.com no configurado: …'}`.
- `health/route.ts:127` mete `escalar` en `configAusente`, `regresiones` queda
  vacío, `:132` fija `cronCheck = 'config_ausente'`, `:185-188` deja
  `status = 'ok'` → **HTTP 200**.
- `salud-produccion.yml:82-84` imprime un `::warning::` y **el job pasa en
  verde**. No se abre issue. `route.ts:151` no llama a `alertarOperador`.

**La misma corrida con `CALCOM_API_KEY` puesta:** `detalle = {cortesSeguidos: 1,
cortados: 5}`, sin `configAusente` y sin `motivo` → `esHuecoDeConfiguracion`
devuelve `false` → **regresión → `degraded` → 503 → job rojo → issue**.

O sea: **el mismo hecho operativo —5 flotas sin su corte de reloj— sale verde o
rojo según esté puesta una variable de una integración de calendario que no
tiene nada que ver.** El único aviso que sobrevive es el de RES-6
(`route.ts:392-398`, `alertarOperador` al tercer corte seguido), por los canales
no verificables.

**Y ya no puede volver a `ok`.** Medido hoy en producción: `crons=config_ausente`
con el `::warning::` de `:83` disparando en **todas** las corridas desde el
10-sep. Un aviso que sale el 100 % de las veces dejó de ser un aviso; el campo
`checks.crons` perdió uno de sus tres valores.

**Consecuencia.** Los cortes de `escalar` son los relojes de incidencias,
vencimientos, comprobación y aceptación — el trabajo legal que se escala. Se
pueden acumular indefinidamente sin que el único detector externo cambie de
color.

**Causa raíz probable:** la señal de «hueco declarado» se modeló como un
booleano del latido (del CRON) cuando el hecho que describe es de un MOTOR; con
un solo bit para seis motores, el más benigno gana.

---

### [ALTO] `OP-A2` — No hay log drain, y el propio runbook lo dice: el artefacto de la mañana siguiente puede no existir

`docs/conocimiento/DEPLOY.md:33-36` · `:354-356`

Es la pregunta que ordena el rubro, y el repo la contesta él mismo:

> «Ojo: **la retención de esa vista es corta y no hay ningún log drain
> configurado** — un fallo del sábado de madrugada puede no existir el lunes. Si
> el incidente importa, copia las líneas antes de cerrar la pestaña.»

Y en § «Lo que este runbook NO cubre»: «**La retención exacta de los runtime
logs** en este plan, ni si hace falta un log drain antes del demo».

Repetí el barrido (`log.?drain|logtail|axiom|datadog|betterstack|papertrail`
sobre `src/ .github/ docs/conocimiento/ vercel.json`): **dos resultados, los dos
son esas dos frases de prosa.** Ni una variable, ni un secreto, ni un paso.

**Escenario, con valores.** Sábado 03:12. `wa-outbox` falla al mandar el PDF de
la liquidación `id:a3f21c9e4b70`. `logger.error` emite la línea con su huella
—`logger.ts:99-107` la construye bien y `DEPLOY.md:38-49` explica cómo cruzarla
contra Postgres, que es exactamente lo que hace falta—. El lunes a las 09:00 el
operador corre `vercel logs --since 1h`: esa ventana ya pasó. `--since 48h` no
está garantizado por el plan y el propio runbook se niega a prometerlo. El único
destino durable es Sentry, cuyo DSN no es verificable desde aquí.

**Consecuencia.** El ancla del rubro dice «8+ si cada fallo del camino del
dinero genera alerta con identificador suficiente **para reconstruirlo**». El
identificador existe y es bueno; el sitio donde vivía puede haberse vaciado. Es
el techo duro de esta nota.

**Causa raíz probable:** la persistencia del log se delegó al plan del
proveedor, y el plan del proveedor no es un requisito escrito en ningún sitio.

---

### [ALTO] `OP-A3` — Sigue sin haber monitor externo, y hoy el propio pulso midió que corre cada 256 min, no cada 30 (REINCIDENTE, 4ª ronda)

`src/app/api/health/route.ts:18` · `.github/workflows/salud-produccion.yml:29-34`,
`:173-201`

Repetí el grep de la 27/28/29
(`uptimerobot|betterstack|cronitor|healthchecks\.io|pingdom|cron-job\.org|dead.?man`):
**el único resultado sigue siendo prosa**, `route.ts:18`. Ni una variable, ni un
secreto, ni un paso.

**Medido hoy**, corrida `34687967901`:

```
cadencia: declarada=30min real=256min (corrida anterior: 2026-09-12T05:59:27Z)
##[warning]La cadencia real del pulso se degradó: 256 min … (~4.3 h de hueco)
```

Conté las corridas `schedule` de las últimas 24 h en la API: `#632`…`#637` =
**6 corridas**, no 48. El paso de medición de la 28 funciona y dice la verdad;
lo que dice es que **la ventana de detección real de un cron muerto del camino
del dinero es de hasta 4.3 h**, y que la medición sale del mismo `gh run list`
que moriría con Actions.

**Consecuencia.** Un pulso *degradado* es visible desde dentro. Un pulso
*muerto* sigue viéndose idéntico a «todo verde».

**Causa raíz probable:** el vigilante y lo vigilado comparten plano de control.

---

### [ALTO] `OP-A4` — La válvula `LEGAL_ENFORCE_DOCS` sigue activándose por PRESENCIA de un valor y el vigilante solo sabe mirar AUSENCIAS (REINCIDENTE de la 29 `OP-A2`; código idéntico)

`src/lib/legal/config.ts:104-110` · `src/lib/observability/arranque.ts:44-78`,
`:100` · `.env.example:61`

`git diff 7bcc319..HEAD -- src/lib/legal/config.ts src/lib/observability/` está
**vacío**. La línea sigue siendo la misma:

```ts
:109  const exigirDocs = process.env.LEGAL_ENFORCE_DOCS !== 'false';
```

y el modelo de vigilancia sigue siendo `arranque.ts:100`,
`SILENCIOSAS.filter((v) => !envPuesta(v.nombre))` — una lista de variables que
**faltan**. Una variable cuya **presencia con el valor `'false'`** retira cuatro
documentos legales de la lista bloqueante no cabe ahí por construcción.

**Escenario, con valores.** El `2026-09-07` entre las 18:00Z y las 18:12Z esa
guardia dejó de bloquear el build (lo dice el comentario del dueño en el issue
#344). Hoy, `2026-09-12T10:15:36Z`, el cuerpo vivo de `/api/health` es
`{"ok":true,"status":"ok","checks":{"db":"ok","crons":"config_ausente"},
"version":"cfa00ab","migracion":{…},"hora":…}` — **ningún campo legal**.
`estadoLegalProduccion()` (`config.ts:88-100`) calcula justo el dato que haría
falta y **ninguna ruta de salud lo llama**.

**Consecuencia.** «El DPA existe y está firmado» y «alguien apagó la exigencia
una noche para desatascar un build» no se distinguen desde ningún artefacto que
el operador pueda mirar. No afirmo que la válvula esté puesta: afirmo que
**nadie puede saberlo**.

**Causa raíz probable:** `SILENCIOSAS` modela «variable que falta» y ésta es
«variable que sobra»; una válvula documentada como temporal no tiene caducidad
ni superficie de observación.

---

### [MEDIO] `OP-M1` — `DEPLOY.md` documenta un `/api/health` que no existe: el operador que siga el runbook a las 3 a.m. busca dos campos que el endpoint ya no devuelve

`docs/conocimiento/DEPLOY.md:472-473` · `:494` ·
`src/app/api/health/route.ts:192-202`

El runbook dice, textual:

```
:473  … `/api/health` devuelve `version` (los 7 primeros caracteres del sha desplegado), `db` y `sentry`, …
:494  curl -s https://app.likida.ai/api/health   # {"ok":true,"db":"ok","sentry":"configurado","version":"553bee7",...}
```

El cuerpo que arma `route.ts:192-202` es
`{ ok, status, checks: { db, crons }, version, migracion, hora }`. **No hay
campo `sentry`** —en ninguna parte del archivo— **y `db` no es de primer nivel**,
vive dentro de `checks`. El cuerpo real, medido hoy, empieza
`{"ok":true,"status":"ok","checks":{"db":"ok","crons":"config_ausente"},…}`.

**Escenario, con valores.** El punto 3 del mismo runbook (`:51-54`) instruye:
«`startup.observabilidad` — `{"sentry":false}` … significa que **nadie va a
recibir el siguiente fallo**. Es lo primero que hay que arreglar si aparece». A
las 3 a.m., sin acceso al panel de Vercel, el operador hace lo que el runbook le
enseñó dos secciones más abajo: `curl -s …/api/health | jq .sentry` → `null`.
`jq .db` → `null`. Lee «no hay dato» donde debería leer «ese campo se quitó hace
rondas», y se queda sin poder responder la pregunta que el propio runbook marcó
como la primera.

**Consecuencia.** El único documento que el issue de `salud-produccion` cita por
nombre miente sobre el único endpoint que ese issue manda mirar. Ninguna prueba
lo ancla: `runbook.test.ts` verifica `.env.example` y `SILENCIOSAS` contra el
código, pero nadie coteja el ejemplo de `curl` contra la forma de `cuerpo`.
Corrí `runbook.test.ts` entero: 543 pruebas verdes con el documento así.

**Causa raíz probable:** el cuerpo del health se rediseñó (status/checks,
`migracion`, `adelante`) y su documentación quedó como una cadena literal que
ninguna red estructural toca.

---

### [MEDIO] `OP-M2` — En el push que publica la reparación, el paso que mide la salud corre ANTES del que espera al despliegue: el commit que arregla el rojo se reporta rojo

`.github/workflows/salud-produccion.yml:71-85` (paso 4) vs `:109-129` (paso 6)

**Escenario, ya ocurrido, con valores.** Corrida `34437455166`, push de
`7ed8920` («`[deploy]` publicar fix de Cal.com…»), `2026-09-10T04:30:34Z`:

```
04:30:48  compuerta: CONSTRUIR
04:30:49  intento 1: esperado=7ed8920 desplegado=a6f924f
   …
04:33:23  intento 6: esperado=7ed8920 desplegado=7ed8920     ← paso 6 en VERDE
04:33:27  Ya hay un issue abierto (#365); no se duplica.     ← paso 9, if: failure()
```

El paso 6 confirmó que el despliegue aterrizó correctamente. El job terminó en
**`failure`** porque el paso 4 le pegó a `/api/health` **14 segundos después del
push**, cuando producción todavía corría `a6f924f` y todavía estaba `degraded`
por el defecto que ese mismo commit venía a arreglar.

**Consecuencia.** El único evento en que se sabe con certeza que el estado va a
cambiar es justo aquel en que se mide antes de que cambie. La corrida que
publica el arreglo queda marcada en rojo en el historial, y el paso «Cerrar el
issue al recuperarse» (`:228-229`, `if: success() && github.event_name !=
'push'`) no puede intervenir ni aunque estuviera verde. Quien publica un hotfix
a las 3 a.m. ve un workflow rojo sobre el commit que acaba de reparar la cosa, y
tiene que abrir el log para descubrir que el paso que importaba salió bien.

**Causa raíz probable:** el orden de los pasos es el histórico (salud, compuerta,
cotejo) y no el causal (compuerta, cotejo, salud) en el único evento donde el
orden importa.

---

### [MEDIO] `OP-M3` — El invariante del cotejo sigue siendo «el último `[deploy]`», no «el tip de `master`»: hoy sale verde con `master` por delante de producción (REINCIDENTE de la 29 `OP-A1`; síntoma mínimo por disciplina humana, causa raíz intacta)

`.github/workflows/salud-produccion.yml:136-158` · `scripts/ci/ultimo-deploy-en-asunto.mjs`

Medido hoy: `desplegado=cfa00ab ultimo_[deploy]=cfa00ab` → **verde**. Al mismo
tiempo `master` es `4e36c82`, un commit por delante. Esta ventana el hueco son
**32 líneas de un archivo de latido** y por eso no es ALTO. Pero el mecanismo es
el mismo que en la 29 produjo 43 commits invisibles: el paso no responde
«¿producción está al día?», responde «¿aterrizó lo último que alguien pidió
publicar?».

**Escenario.** Basta con que los próximos veinte commits no lleven la bandera
—exactamente lo que pasó entre el 7 y el 9 de septiembre— para que el cotejo
siga en verde mientras la deriva crece. «No quise publicar» y «olvidé publicar»
siguen siendo indistinguibles por construcción, porque la intención vive como
una subcadena en prosa libre.

**Lo que cambió, y hay que decirlo:** esta ventana la disciplina humana sí
funcionó (7 banderas, 100 % de arreglos cubiertos). La causa raíz no se tocó;
lo que mejoró es el operador, no el detector.

**Causa raíz probable:** el invariante está mal elegido.

---

### [MEDIO] `OP-M4` — El candado de conteo literal de `staging-recovery` ahora es demostrablemente falso: el repo va en 0356 y el script afirma «hasta 0347» y resetea a `0331` (REINCIDENTE de la 29 `OP-M1`, ahora con migraciones reales)

`scripts/ci/staging-recovery.mjs:200`, `:214`, `:225`, `:87`

La 29 lo dejó como residuo teórico porque no había migraciones nuevas. **Esta
ventana entraron nueve** (`0348`–`0356`, `supabase/migrations/` de 324 a 333
`.sql`), y los tres literales del tramo destructivo no se movieron:

```js
:200  cli('RESET', ['db','reset','--linked','--no-seed','--version','0331','--yes']);
:214  if (… || Number(physical[0].tables) !== 154 || …) fail('RECOVERY_FINAL_SCHEMA');
:225  console.log('RECOVERY_MIGRATIONS_COMPLETE: historial reconstruido hasta 0347; …');
```

(más `:87`, `tables.length !== 59`).

**Escenario, con valores.** `:225` ya imprime una frase falsa hoy: el historial
que reconstruye llega a **0356**, no a 0347 — un rótulo que no puede ser verdad,
en el peor día del proyecto. Y la próxima migración que cree una tabla —ninguna
de las nueve lo hace, lo verifiqué con `grep -il 'create table'` sobre
`0348`–`0356`, que da cero— hará que `:214` compare `155` contra `154` y lance
`RECOVERY_FINAL_SCHEMA`: **nueve caracteres, después de haber vaciado y
repoblado staging**, sin decir que la diferencia es una tabla que alguien añadió
a propósito.

**Consecuencia.** El script existe para la recuperación de desastre y su
enclavaje final se rompe por un motivo que no es un riesgo, en el punto de menor
reversibilidad. Sigue en MEDIO porque el camino solo se recorre con credenciales
de staging que aquí no existen.

**Causa raíz probable:** un valor derivado del repo guardado como literal, en el
tramo donde el `fail()` de arriba lo ocultaba.

---

### [MEDIO] `OP-M5` — El backup de Storage sigue sin haber corrido en verde ni una sola vez en su historia, y van 17 días desde el último intento (REINCIDENTE, 4ª ronda)

`.github/workflows/backup-storage.yml:3-12`

**Medido hoy** por la API (`actions_list` sobre `backup-storage.yml`):
`total_count` = **2**. Las dos corridas de toda su existencia son
`2026-08-25T03:59:52Z` y `2026-08-26T04:03:50Z`, ambas `conclusion: failure`,
ambas `event: schedule`. **Cero corridas de `workflow_dispatch`, nunca.** El
propio comentario del workflow (`:10-11`) pone la condición para reactivar el
`schedule`: «hasta la primera corrida MANUAL verde». Esa corrida lleva **17
días** sin intentarse (la 29 midió 13, la 28 midió 13; la cifra solo crece).

**Escenario.** Se pierde el bucket de Supabase Storage. Ahí viven las fotos de
ticket y los PDF de liquidación: la evidencia que el contralor cruza y la que
sostiene una deducción ante el SAT. No existe una copia verificada fuera de
Supabase y ningún workflow programado lo va a decir.

**Consecuencia.** `docs/operacion/RESILIENCIA-DEPLOY.md` publica objetivos
RPO/RTO; el RPO real de Storage es *indefinido*, no un número. Sigue en MEDIO
—y no sube— porque el repo lo declara por escrito y `runbook.test.ts:186-193` lo
ancla. Se vuelve ALTO el día que exista el primer cliente.

**Causa raíz probable:** el environment `production-backup` nunca se configuró y
nada calendariza esa tarea.

---

### [BAJO] `OP-B1` — El trinquete de `.limit()` sigue guardando el derivado junto a sus partes (REINCIDENTE; hoy consistente, 188 = 188)

`ci/limite-sin-orden-baseline.json` · `src/lib/likida/limite_con_orden.test.ts:93-95`

Medido hoy: `total` declarado = **188**, suma de las 82 entradas de `porArchivo`
= **188**. Consistente, así que nadie está bloqueado ahora mismo. Pero el patrón
no cambió: `:93` calcula `suma` y `:95` usa `BASELINE.total` para el aserto
final, teniendo el derivado a mano.

**Escenario, ya ocurrido una vez.** Un lote arregla un `.limit()` real y baja el
contador de ese archivo en `porArchivo` sin tocar `total`. A partir de ese merge,
**cualquier PR de cualquier rubro** falla en `limite_con_orden.test.ts`. Hizo
falta un commit dedicado (`70821b2`, un archivo, `-189/+188`) para desbloquear el
repo.

**Consecuencia.** Un peaje sobre todo el equipo cobrado en el momento de menos
contexto. Es BAJO y no más porque el mensaje de fallo es excelente: nombra el
archivo, el número viejo, el nuevo, y qué editar.

**Causa raíz probable:** un artefacto de trinquete guarda un valor derivado junto
a sus partes en vez de derivarlo al leer.

---

## Lo que revisé y está bien

- **La disciplina de publicación se corrigió de verdad, y es lo que mueve la
  nota.** Siete `[deploy]`, cada arreglo de la ventana cubierto por uno
  posterior, y el único commit sin publicar toca un archivo de latido.
  Producción corre `cfa00ab` = último `[deploy]`, confirmado en el paso 7 de la
  corrida de hoy. En la 29 esto eran 43 commits y cero banderas.
- **La coherencia base↔código funcionó de punta a punta con nueve migraciones
  nuevas.** `compuerta: CONSTRUIR` en el log de la corrida `34437455166`
  («base 0356 tiene aplicado el CONJUNTO completo de migraciones del código
  (333)»), y el health vivo confirma `base=0356 codigo=0356 atras=0 adelante=0`.
  Es el cotejo por **conjunto** de `compuerta-deploy.mjs:125-135`, no máximo
  contra máximo, haciendo exactamente lo que promete.
- **El campo `adelante` está publicado.** El círculo que la 29 señaló —«la
  reparación de la observabilidad no puede surtir efecto porque depende del
  mismo mecanismo que venía a arreglar»— se rompió, y se comprueba sin
  credenciales leyendo el JSON vivo.
- **El incidente se cerró con la causa raíz, no callándola.** `15fd8d3` no puso
  un `catch` vacío: fue a `calcom.ts` y convirtió un `throw` en un estado. Ese
  es el arreglo correcto; lo que le sobra es alcance (`OP-A1`).
- **La prueba de `94de18f` muerde.** `vista.test.tsx` monta un latido `parcial`
  real y exige `toContain('fallidas')`: con el cambio revertido la celda es `—`
  y la suite se pone roja. El arreglo es genuino aunque caiga del lado que ya
  veía.
- **`resumenDetalle` no inventa nada.** `vista.tsx:108-120` filtra `undefined`,
  `null`, `0`, `''` y arrays vacíos, y la prueba «un detalle vacío (`{}`) sigue
  mostrando el guion» fija que no se rellena con cifras que parezcan medición.
  Cumple la regla del producto.
- **La pantalla falla cerrado.** `crons/page.tsx` captura el error, loguea
  `admin.crons.sin_latidos` y devuelve `null`; `vista.tsx:209` pinta «No se pudo
  leer el pulso … Esto NO significa que estén corriendo». No una tabla gris.
- **El logger sigue siendo el mejor archivo del rubro.** `logger.ts:99-107`
  (`huellaId`, FNV-1a truncado a 12 hex), `:110-123` (`redactarTexto`), `:79-82`
  (una sola pasada con reglas alternadas) y `:146` (protege `digest`). Sin tocar
  esta ventana y sigue contestando la pregunta que define el rubro — cuando el
  log existe (`OP-A2`).
- **`onRequestError` y el fallo solo-de-cliente.** `instrumentation.ts:70-97`
  emite `request.fail` con `ruta`, `tipo`, `metodo`, `digest` y `err`, y hace
  `flush` antes de morir la invocación; `logger.ts:177-189` + `:211-213` mandan
  el error de `error.tsx` a `/api/client-error` con `keepalive`.
- **`ci.yml` — lo abrí por fin (5ª ronda pendiente).** El orden es correcto y no
  tiene escapes: `typecheck` → `lint:ratchet` → resiliencia offline →
  `test:coverage` → las pruebas de tiempo sin instrumentar → `build` → arrancar
  el servidor y `test:smoke` de Playwright → puertas de supply chain. Tres cosas
  bien hechas: el smoke arranca el build que acaba de pasar y falla ante overlay
  de Next o error de consola (`:110-123`); `Logs del smoke si falla` (`:126-133`)
  vuelca el log del servidor en vez de dejar un exit code pelón; y las puertas de
  `npm audit` van **después** de las de código (`:141-145`), con la runtime
  bloqueante y fail-closed y la de desarrollo `continue-on-error` — una caída del
  servicio de advisories no vuelve a saltarse typecheck/tests/build.
  `pruebas_en_ci.test.ts` ancla que lo que se salta bajo `--coverage` sí corre en
  el paso sin instrumentar, leyendo `ci.yml` de verdad.
- **Las nueve migraciones entraron a `ci-postgres.yml`.** Las seis que traen
  `supabase/tests/*.sql` (`0348`, `0349`, `0350`, `0351`, `0352`, `0354`) están
  cableadas con `ON_ERROR_STOP=1`; las tres restantes (`0353`, `0355`, `0356`) no
  tienen archivo de prueba, así que no hay huérfanos. Lo verifiqué archivo por
  archivo.
- **La suite del rubro, verde, medida hoy:** `npx vitest run scripts/
  src/lib/likida/runbook.test.ts src/lib/observability` → **37 archivos, 543
  pasan, 5 saltadas, 0 fallos, 7.43 s**. Y `npx vitest run src/app/admin/crons
  src/app/api/health src/app/api/cron/escalar src/lib/admin/salud.test.ts` → **6
  archivos, 95 pruebas, 0 fallos**. Las 5 saltadas son las de `proxy-local`
  (IPv6): **tercera ronda sin fallar**, el `6beb5f5` aguanta.
- **La compuerta sigue fail-closed donde importa.**
  `compuerta-deploy.mjs:104-106` (health ilegible → no se construye),
  `:174-194` (`leerHealth`: solo 200 y 503 cuentan), y `FLAG_DEPLOY_RE` se lee
  solo del asunto en los tres sitios (`salud-produccion.yml:97` y `:116` hacen
  `head -n1`).
- **`DEPLOY.md` § «Algo se rompió» es un buen runbook** —salvo `OP-M1`—: los
  cinco puntos están ordenados por probabilidad, explican `huellaId`, mandan
  pedirle al contralor el `Digest:` de pantalla, y § «Lo que este runbook NO
  cubre» declara por escrito lo que no cubre en vez de fingirlo.

---

## Lo que NO alcancé a revisar / INFRA

Sin esto la nota es una mentira por omisión.

1. **INFRA — egress bloqueado.** No pegué ni una sola vez a
   `https://app.likida.ai/api/health`. Cada cifra de producción de este
   documento sale de los logs de GitHub Actions vía MCP, que **sí** respondieron
   (`actions_list`, `get_job_logs`, `issue_read`). Eso es INFRA del contenedor,
   no «el sistema está caído»: el sistema está verde, y lo está según su propio
   pulso de las `10:15:36Z` de hoy.
2. **INFRA — clon superficial.** `.git/shallow` presente, `git rev-list --count
   HEAD` = **51**. Cualquier afirmación mía sobre historia anterior al 7-sep
   sale de la API, no de git local. Las cifras de publicación de esta ventana sí
   salen de git local, porque la ventana entera cabe en los 51 commits.
3. **`ALERTA_EMAIL`, `ALERTA_WA`, `SENTRY_DSN`, `LEGAL_ENFORCE_DOCS`** — viven
   en el panel de Vercel. **Cuarta ronda consecutiva sin poder responderlo.**
   `alertaConfigurada()` (`alerta.ts:37-39`) exige `ALERTA_EMAIL` **y**
   `correoConfigurado()`; sin ellas cada `alertarOperador(...)` es un no-op
   silencioso por diseño. Si están vacías, `OP-C1` y `OP-A1` son peores de lo
   que los escribí y esta nota debería bajar a 5.
4. **Si Sentry tiene DSN real y reglas de alerta.** El cableado del repo
   (`logger.ts:204-206`, `observability/sentry.ts`) es correcto; el efecto vive
   fuera. Y `OP-M1` impide preguntárselo al endpoint.
5. **No ejecuté `staging-recovery.mjs` ni `aplicar-migraciones-y-humos.sh`.**
   Requieren credenciales de staging. `OP-M4` sale de leer el código y de contar
   los `.sql` del repo, no de correrlo.
6. **`deploy-preview-promote.yml`** (el job «Crear Preview inmutable» con
   `environment: production`, `OP-M2` de la 28): **sigue sin revisarse, tercera
   ronda.** No lo abrí.
7. **`rollback-production.yml`, `recover-empty-staging.yml`, `e2e-navegador.yml`,
   `codeql.yml`, `auto-merge-rutina.yml`** — no los abrí. `ci-postgres.yml` solo
   lo leí en el tramo de las migraciones nuevas.
8. **No corrí la compuerta completa** (`npm test`, `tsc`, `lint`). Corrí las
   suites del rubro (37 + 6 archivos, 638 pruebas, 0 fallos) y me apoyé en la
   línea base del `MAPA.md` (984 archivos / 12,931 pruebas, tsc 0, lint 0
   errores / 154 avisos) para lo demás.
9. **`scripts/seed.sh` no lo ejecuté** (no hay `psql` ni Supabase local aquí).
   La 29 lo verificó por lectura y el archivo no cambió esta ventana
   (`git diff 7bcc319..HEAD -- scripts/` está vacío salvo lo ya dicho).
