# Operabilidad y DX — auditoría 26

**Nota: 5/10** (antes 5). Razón del movimiento: **se mantiene**. Cinco
hallazgos de la 25 se cerraron de verdad y con prueba (el fallo solo-de-cliente
tiene ruta al servidor, `pdf.no_entregado` ya alerta, la compuerta ya no se
vuelve permisiva con un 429, `repair_migrations` tiene guarda real,
`DEPLOY.md` dejó de prometer un backup que no existe). Contra eso, el CRÍTICO
reincidente **creció un orden de magnitud** —de «9 commits y 2 migraciones» a
**290 commits, 12 merges de mainline y 17 migraciones**— y apareció un modo de
falla nuevo y ya ocurrido: **toda la capa de operación vive en GitHub Actions,
y Actions estuvo apagado por límite de gasto**. La subida que ganó el código
observable se la comió la capa de despliegue.

**El riesgo mayor del rubro, hoy:** producción corre el binario del 2-sep con
la base en la 0301, mientras `master` trae los arreglos de los CRÍTICOS de
seguridad de la 25 **y** `docs/auditoria-25/seguridad.md`, que describe esos
mismos agujeros paso a paso, en un repositorio que el 4-sep se puso público.

---

## Hallazgos

### [CRÍTICO · REINCIDENTE de la 23, 24, 25 y 26] Producción lleva 290 commits, 12 merges de mainline y 17 migraciones sobre el último `[deploy]` efectivo — y entre ellos van los arreglos de seguridad que el repo publica como pendientes

`vercel.json:3` · `scripts/ci/compuerta-deploy.mjs:110-113` ·
`supabase/APLICAR-EN-PRODUCCION.md:3`

Medido hoy, en el árbol:

```
$ git log --format='%H%x1f%s' | awk -F'\x1f' 'tolower($2)~/\[deploy(:forzar)?\]/'   # primer asunto con bandera EN mainline
3cc8ead  2026-09-02  [deploy] docs: confirma migraciones 0272→0301 aplicadas

$ git rev-list --count 3cc8ead..HEAD                 → 290
$ git rev-list --count --first-parent 3cc8ead..HEAD  →  12
$ git diff --diff-filter=A --name-only 3cc8ead..HEAD -- supabase/migrations | grep -c '\.sql$'  → 17   (0302 … 0318)
```

`ce6f462`, el tip de `master` y merge del PR #322 («resolución integral,
~80 hallazgos cerrados»), tiene por asunto `Merge pull request #322 from
javiercamarapp/claude/auditoria-25-resolucion-integrada`. Sin bandera →
`decidir()` devuelve `construir:false` → Vercel no construyó.

**Escenario, con valores.** Son las 03:00 del 5-sep. El contralor de la flota
piloto entra a `/dashboard/facturacion`. Corre el bundle del 2-sep. En él
**no** está `c3e52ac` (`/api/admin` y `?tenant=` sin gate de segundo factor),
ni `725eae7`/`fa787c0`/`ed64ca9` (el token MCP de un usuario dado de baja
sigue leyendo el dinero de la flota por `service_role`), ni `822b55d`, ni
`d6058df`. Los cinco están en `master` desde el 3-sep. Y
`docs/auditoria-25/seguridad.md:27` y `:88` describen esos dos agujeros con
nombre de tabla y de ruta, en un repo que `20977c7` («ci: reintentar tras
poner el repo publico — Actions estaba bloqueado por limite de gasto») declara
público desde el 4-sep a las 00:11.

**Consecuencia.** Cualquiera que lea el repo tiene el mapa exacto de lo que
sigue vivo en `app.likida.ai`, con la confirmación de que no se ha desplegado
(el propio `/api/health` publica `version` sin auth). Y por el lado del
producto: los 80 arreglos de la 25 —incluidos FIS-C1/C2, la proporción del
15 %— no le llegaron a nadie; el contralor sigue viendo la cifra vieja.

**Nota adicional:** la salida no es solo pushear con la bandera. La compuerta
está fail-closed correctamente y bloqueará el `[deploy]` mientras la base siga
en 0301 y el código pida 0318. Publicar exige aplicar las 17 migraciones
primero. Producción está **congelada**, no solo atrasada.

**Causa raíz probable:** el único punto donde la bandera se lee es el asunto
del commit que queda como tip de `master`, y el flujo real del proyecto
(PR + merge commit de GitHub) nunca produce ese asunto; ninguna pieza vigila
«`master` acumuló N merges sin un `[deploy]`» antes de que sean 12.

---

### [CRÍTICO] Toda la capa de operación —pulso, compuerta en rojo, rollback y respaldo— vive en GitHub Actions, y el 3-4 sep Actions estuvo bloqueado por límite de gasto: la ausencia de corridas es indistinguible de verde

`.github/workflows/salud-produccion.yml:26-31,157-167` ·
`.github/workflows/rollback-production.yml:18-39` ·
`.github/workflows/backup-storage.yml:12` · `src/app/api/health/route.ts:18`

Las cuatro piezas que responden «¿qué pasó anoche?» y «¿cómo lo deshago?» son
workflows:

| Pieza | Dónde vive | Qué pasa si Actions no corre |
|---|---|---|
| Pulso de producción cada 30 min | `salud-produccion.yml:28` | nadie pega a `/api/health` |
| Compuerta de migraciones en rojo | `salud-produccion.yml:84-95` | el veredicto vuelve a ser mudo |
| Rollback de Vercel | `rollback-production.yml` | no hay botón de deshacer |
| Respaldo de Storage | `backup-storage.yml:12` | no hay respaldo |

Y `src/app/api/health/route.ts:18` dice, en el comentario del propio endpoint,
que el detector previsto es «un UptimeRobot (o el cron de un tercero)». Grep
por `uptime|betterstack|pingdom|checkly|cronitor|healthchecks.io|statuscake`
en todo el repo (fuera de `node_modules`) devuelve **solo esa línea de
comentario**: ese monitor externo nunca se contrató.

**Escenario, con valores.** 3-sep, tarde. `20977c7` documenta que Actions
estaba bloqueado por límite de gasto —y `406ac5f` y `b833e4b` documentan
corridas canceladas «sin causa clara» las horas previas. Durante esa ventana,
`salud-produccion` no corrió ni una vez. Supongamos que en ese hueco Supabase
devuelve 500 a las 03:00: `checks.crons` se degrada, `/api/health` contesta
503 — y no hay nadie del otro lado. `gh issue create` (`:167`) nunca se
ejecuta porque el job nunca arranca. A la mañana siguiente el operador abre
GitHub, ve la etiqueta `salud-produccion` **sin ningún issue abierto**, y esa
es exactamente la misma imagen que produce una noche sin incidentes.

**Consecuencia.** El único detector de producción es un dead-man's-switch sin
detección del dead man: su modo de falla (no correr) se ve idéntico a su modo
sano (correr y salir verde). Y el episodio no es hipotético: quedó escrito en
el mensaje de un commit de ayer.

**Causa raíz probable:** el diseño confía en «GitHub manda correo cuando un
workflow programado falla» (comentario de `salud-produccion.yml:19-23`), que
solo cubre el fallo, nunca la ausencia; y no hay un segundo canal fuera del
mismo proveedor de CI.

---

### [ALTO · REINCIDENTE de la 25] El ancla del detector de deriva sigue cayendo en un commit que Vercel no pudo construir — y ahora es peor: cae en uno cuyo asunto solo *menciona* `[deploy]`

`scripts/ci/compuerta-deploy.mjs:57` (`FLAG_DEPLOY_RE`) ·
`scripts/ci/ultimo-deploy-en-asunto.mjs:16-22` ·
`.github/workflows/salud-produccion.yml:141-150`

La 25 arregló que `git log --grep` casara contra asunto **y** cuerpo. El
arreglo cambió el ancla de `4f94490` a la primera línea. Corrido hoy contra el
repo real:

```
$ node scripts/ci/ultimo-deploy-en-asunto.mjs
311adddc643793dadea9657b1f54861efa727d5d

$ git log -1 --format='%s' 311addd
fix(ci): OP-2 indenta el heredoc del aviso de [deploy] para que sea YAML valido
```

`311addd` **no es un deploy**: es el arreglo de indentación de un heredoc en un
workflow, y su asunto casa porque `FLAG_DEPLOY_RE = /\[deploy(?::forzar)?\]/i`
no ancla ni exige que la bandera sea la bandera. Además `311addd` está dentro
de la rama del PR #322 (`git rev-list --first-parent HEAD | grep -c 311addd`
→ **0**): igual que `4f94490` y que `5a14012`, es un commit que Vercel nunca
tuvo como tip de `master`.

Y la misma regex gobierna `decidir()`. Verificado:

```js
decidir({ asunto:'fix(ci): OP-2 indenta el heredoc del aviso de [deploy] para que sea YAML valido',
          codigo:'0318', health:{migracion:{base:'0318'}} })
→ { construir: true, nivel: 'ok', … }
```

**Escenario, con valores.** 03:00. `salud-produccion` corre por schedule.
`version` de producción es `3cc8ead`. La línea 146 pregunta
`git merge-base --is-ancestor 311addd 3cc8ead` → falso → `::error::Producción
corre 3cc8ead y el último commit con [deploy] en master es 311addd`. El
operador abre `311addd`, lee «indenta el heredoc… para que sea YAML valido», y
no puede distinguir «producción está atrás de verdad» de «el detector se
enredó otra vez» — que es exactamente lo que le pasó con `4f94490` hace dos
días. El issue queda abierto y se aprende a ignorarlo.

El espejo del mismo bug: un commit con ese asunto empujado directo a `master`
**sí construye producción**. `CLAUDE.md` § Despliegue y `DEPLOY.md:428-430`
dicen que se lee solo el asunto precisamente «porque con el mensaje completo,
cualquier commit que *mencionara* la palabra disparaba un build». Leer solo el
asunto no arregla eso: lo reduce de superficie, no lo elimina.

**Consecuencia.** El detector nombra el commit equivocado en la única alarma
que existe para la deriva, y la compuerta puede publicar un commit que solo
hablaba de publicar.

**Causa raíz probable:** «último `[deploy]`» se sigue implementando como
«primer asunto que casa una regex sobre `git log` completo», cuando la
propiedad que importa es «último commit que fue **tip de `master`**», es decir
`--first-parent`, con la bandera reconocida como token y no como subcadena.

---

### [ALTO] El canal de madrugada del dinero puede estar apagado y las tres superficies que deberían decirlo dicen lo contrario

`src/lib/observability/alerta.ts:198-203, 260` ·
`src/lib/observability/arranque.ts:44-79` ·
`src/app/admin/salud-sistema/page.tsx:105-125` ·
`docs/conocimiento/DEPLOY.md:231`

`ALERTA_WA` es el canal WhatsApp que la auditoría 24 (OP-P5) creó para que un
evento del camino del dinero suene en un teléfono a las 3am
(`alerta.ts:174-191`). Su ausencia no rompe nada: `alerta.ts:260` calcula
`porWhatsApp = alertaWhatsAppConfigurada() && esEventoDeDinero(evento)` y, si
la variable no está, manda solo el correo. Es la definición literal de una
variable «silenciosa». Y sin embargo:

1. **No está en `SILENCIOSAS`** (`arranque.ts:44-79`: `DEMO_TENANT_ID`,
   `LIKIDA_WHATSAPP_MSG_USD`, `NEXT_PUBLIC_APP_URL`, `ALERTA_EMAIL`,
   `LIKIDA_FLOTA_COOKIE_LLAVE`, `UPSTASH_REDIS_REST_URL`,
   `UPSTASH_REDIS_REST_TOKEN`). Con `ALERTA_WA` vacía, `arranque.ts:102` emite
   `startup.config_silenciosa {ok:true, revisadas:7}`.
2. **La pantalla no la mira.** `alerta.ts:198` documenta
   `alertaWhatsAppConfigurada()` como «Para `/admin/salud-sistema`», pero
   `grep -rn alertaWhatsAppConfigurada src/` devuelve **un solo llamador**, el
   de `alerta.ts:260`. `renglonAlerta()` (`salud-sistema/page.tsx:105-125`)
   solo lee `ALERTA_EMAIL` y pinta `estado:'ok'` con la etiqueta «Alertas de
   cron a j…@gmail.com».
3. **El runbook dice que no existe.** `DEPLOY.md:231` llama a `ALERTA_EMAIL`
   «**El único canal push del sistema.**», y `ALERTA_WA` no aparece en esa
   tabla. `runbook.test.ts` solo falla si una entrada de `SILENCIOSAS` no está
   en la tabla — y como `ALERTA_WA` no está en `SILENCIOSAS`, la suite tampoco
   lo ve.

**Escenario, con valores.** `ALERTA_WA` está en blanco en Vercel
(`.env.example:108` la trae vacía). A las 03:14 `carta_porte_timbre.ts`
dispara `timbre.emitido_sin_persistir`: el PAC timbró el CFDI y el `update` de
`uuid_fiscal` falló, así que existe un comprobante ante el SAT que Likida no
puede nombrar. `alertarOperador` manda el correo y nada más. El operador lo lee
a las 09:00, casi seis horas después, y en `/admin/salud-sistema` el renglón
«Canal de alerta al operador» está en verde diciendo que las alertas salen.

**Consecuencia.** El arreglo de OP-P5 se revierte por omisión de una variable,
y las tres superficies que existen para vigilar la configuración —arranque,
panel y runbook— afirman que el canal está bien.

**Causa raíz probable:** `ALERTA_WA` se añadió como canal opcional sin
inscribirse en la lista que hace obligatorio declararlo en las otras dos
superficies.

---

### [ALTO] No hay ningún respaldo corriendo: el `schedule` se quitó y el entorno que lo habilita nunca se configuró

`.github/workflows/backup-storage.yml:3-12,26,30-41` ·
`docs/conocimiento/DEPLOY.md:93,140-148`

La parte documental del hallazgo de la 25 **sí se cerró**: `DEPLOY.md:93` hoy
dice «Este proyecto no tiene respaldo automático ni PITR». Lo que queda es el
hueco que esa frase describe. `backup-storage.yml` tiene solo
`workflow_dispatch` (`:12`) y su propio comentario (`:4-11`) explica por qué:
«el entorno `production-backup` (secretos + bucket remoto) sigue sin
configurarse». Los tres guardas de `:37-39` (`NEXT_PUBLIC_SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `RESPALDO_S3_DESTINO`) son fail-closed, así que
una corrida manual hoy tampoco pasaría del primer paso.

**Escenario, con valores.** 03:00. Un `delete` mal filtrado —o el cron
`purgar` (`vercel.json`, `15 4 * * *`) sobre un `tenant_id` equivocado— borra
objetos del bucket privado `liquidaciones`. Las filas de `liquidacion` siguen
apuntando a rutas que ya no existen. `DEPLOY.md:108` describe exactamente ese
resultado: «la liquidación existe y el papel que el contralor cruza, no». A la
mañana siguiente la única recuperación documentada es
`bash scripts/respaldo-storage.sh` — un script que nadie ha corrido nunca en
verde y cuyo destino remoto no está configurado.

**Consecuencia.** Un borrado de Storage a las 3am es irreversible. Para un
producto cuya promesa es «el PDF que el contralor cruza contra su contador»,
eso es pérdida total del entregable, no degradación.

**Causa raíz probable:** el respaldo se implementó completo (script idempotente
con manifiesto y SHA-256, más `restore-storage-drill.sh`) y se dejó a un paso
de la primera corrida verde; sin esa corrida el `schedule` no vuelve, y sin
`schedule` nadie se acuerda de la corrida.

---

### [MEDIO · REINCIDENTE de la 25] `APLICAR-EN-PRODUCCION.md` documenta hasta la 0303; el repo llega a la 0318 — y ese documento es el techo que autoriza `repair_migrations`

`supabase/APLICAR-EN-PRODUCCION.md:3,13-21,76-77` ·
`scripts/ci/verificar-huerfanas-repair.mjs:28-39,51-57`

El commit `7f0ea11` («ya nombra 0302 y 0303») dejó el documento en 0303. Hoy
`supabase/migrations` llega a **0318**: quedan quince migraciones (0304…0318)
sin una línea que diga qué hacen ni qué se rompe si no se aplican, incluidas
`0316`/`0317` (gastos fiscales agregados, cierre de FIS-REAUD-1/2) y `0318`
(`mcp_oauth_usuario_vigente`, cierre de SEC-3).

Esto **no es solo documentación**: `verificar-huerfanas-repair.mjs:51-57` lee
ese mismo markdown como la única autoridad de «qué corrió de verdad».
Ejecutado hoy:

```
$ node scripts/ci/verificar-huerfanas-repair.mjs
compuerta de bookkeeping: las 279 entrada(s) … están todas por debajo o a la
par del techo declarado (0301). OK para repair.
```

El guarda funciona (el ALTO de la 25 sobre `repair_migrations` **está cerrado**:
0302/0303 hoy quedarían fuera). Pero su techo es una línea de prosa que un
humano edita, y el documento ya demostró que se queda atrás en cuanto la ronda
de migraciones va rápido.

**Escenario, con valores.** 5-sep, el operador va a destrabar el despliegue.
Aplica `supabase db push`, ve `atras:0`, y para dejar `migration list` limpio
corre `repair_migrations`. Como el techo sigue diciendo 0301, el guarda le
niega cualquier entrada 0302-0318 y le pide «actualiza primero el techo con
evidencia». Edita la línea a `0272→0318` a mano. A partir de ahí el guarda que
existe para impedir el sello de goma **es** el sello de goma: la evidencia es
la frase que acaba de escribir.

**Consecuencia.** Quince migraciones sin runbook, en el momento en que
publicar exige aplicarlas exactamente en orden — y `APLICAR-EN-PRODUCCION.md`
existe precisamente porque aplicar en desorden puede revertir un CRÍTICO ya
cerrado (`:34-46`, el caso `ejecutar_arco_cancelacion` 0273↔0275).

**Causa raíz probable:** el estado real de la base y su declaración viven en
dos lugares distintos (`schema_migrations` y un markdown), y solo el segundo
tiene efecto sobre el CI.

---

### [MEDIO] El único rastro de un fallo solo-de-cliente se cierra a sí mismo cuando Upstash parpadea

`src/app/api/client-error/route.ts:42-44` · `src/lib/ratelimit.ts:61-72` ·
`src/lib/logger.ts:162-174`

`ce70854` cerró bien el ALTO reincidente: `logger.ts:165` hace un POST
best-effort a `/api/client-error`, y esa ruta corre `logger.error` de servidor
con réplica a Sentry. Lo verifiqué línea por línea; el canal existe.

Lo que queda es su puerta de entrada. `route.ts:42` llama
`rateLimit('client-error:'+ip, 20, 60_000)` **sin** `{ fallaCerrado: false }`,
y el default desde la auditoría 24 (SEG-4) es fail-**closed**
(`ratelimit.ts:61-72`): con credenciales de Upstash presentes y el intento
fallando, `rateLimit` devuelve `false`.

**Escenario, con valores.** 03:00. Upstash tiene un blip de dos minutos —el
mismo que `ratelimit.ts:66` documenta como ya ocurrido. Ese blip es también lo
que hace que el panel truene después de hidratar en el navegador del contralor:
`dashboard/error.tsx` se pinta, `logger.error` corre en el cliente, y el POST
a `/api/client-error` recibe **429** en la línea 43 antes de escribir una sola
línea de log. `onRequestError` no se entera (no hubo petición de servidor que
fallara). Sentry no se entera (`SENTRY_DSN` no es `NEXT_PUBLIC_*`, a
propósito). A la mañana siguiente el contralor dice «anoche se cayó el panel» y
no existe ni una línea que lo confirme.

**Consecuencia.** El canal construido para que un fallo de cliente deje rastro
está apagado exactamente durante la clase de avería que más fallos de cliente
produce.

**Causa raíz probable:** se le aplicó a un endpoint de telemetría el default de
protección de abuso, cuando el criterio del propio módulo
(`ratelimit.ts:73-79`) es que fail-open acotado al Map es lo razonable para un
llamador que no puede quedarse fuera por un blip ajeno.

---

### [MEDIO · REINCIDENTE de la 25] `npm run setup` sigue sin dejar el proyecto corriendo, y su camino recomendado pide un binario que el repo nunca instala

`package.json:22` · `scripts/seed.sh:22-28,38,53-64,183`

`df18af9` mejoró el diagnóstico de verdad: hoy comprueba `psql`, detecta una
pila local, y copia `.env.example` a `.env.local` rellenando las tres llaves.
Pero el contrato del hallazgo era «dejar el proyecto corriendo», y no lo hace.

En una máquina limpia, `npm run setup` (= `npm install && npm run seed`) tiene
tres salidas y ninguna es un proyecto que arranca:

- sin `psql` → `exit 2` (`seed.sh:22-28`);
- con `psql`, sin `DATABASE_URL` y sin CLI de Supabase → `exit 1`
  (`seed.sh:53-64`) recomendando `supabase start`;
- con todo puesto → siembra y termina con «Siguiente: pon las llaves en
  `.env.local` … y corre `npm run dev`» (`seed.sh:183`).

Y el camino A que el propio script recomienda es inalcanzable de fábrica:
`seed.sh:38` hace `command -v supabase`, pero
`Object.keys({...dependencies, ...devDependencies}).filter(k=>k.includes('supabase'))`
da `['@supabase/ssr','@supabase/supabase-js']` — **el CLI no es dependencia del
repo**. En este entorno, `command -v supabase` → no existe.

**Escenario, con valores.** Entra un segundo desarrollador (o una rutina en un
clon nuevo). Clona, corre `npm run setup`, ve «❌ Falta DATABASE_URL … A) LOCAL:
`supabase start`», teclea `supabase start` y recibe `command not found`. El
mensaje no menciona `npx supabase start` ni `brew install supabase/tap/supabase`
—los menciona para `psql`, no para el CLI—, así que el camino sin credenciales
que el script anuncia como «cualquiera sirve» no sirve.

**Consecuencia.** A las 3am, reproducir localmente el fallo que se está viendo
en producción sigue dependiendo de que quien lo intente ya tenga la máquina de
Javier.

**Causa raíz probable:** cierre parcial — se arregló el diagnóstico (por qué
falla) y no el arranque (que no falle).

---

### [MEDIO] El runbook describe un procedimiento de publicación que no es como aterriza el código en este repo, y omite la trampa que ya costó las dos últimas publicaciones

`docs/conocimiento/DEPLOY.md:375-381,392-396` ·
`.github/workflows/aviso-deploy-en-pr.yml:47-50`

`DEPLOY.md:379` enseña el procedimiento como
`git commit -m 'fix(x): … [deploy]' && git push`, y `:392-396` da la tabla de
«construye / no construye» con dos ejemplos de commit directo. Pero el código
de este repo aterriza por PR y merge commit: de los 12 merges de mainline desde
`3cc8ead`, **12** llevan por asunto `Merge pull request #NNN from …`. El
runbook no menciona ni una vez que un merge commit normal borra la bandera, ni
que la salida es squash-merge.

La salvaguarda que la 25 construyó para esto (`aviso-deploy-en-pr.yml`) solo se
dispara cuando el **título del PR** ya trae `[deploy]` (`:47-50`). PR #322 —el
que traía los 80 arreglos que había que publicar— no lo traía, así que no hubo
aviso, y su merge `ce6f462` no publicó nada.

**Escenario, con valores.** 03:00, hay que publicar un hotfix. El operador
abre `DEPLOY.md`, sigue los tres pasos literales, y el paso 3 no aplica porque
su cambio va en la rama `claude/...` que hay que mergear. Mergea con el botón
verde por omisión. `ce6f462` otra vez: GitHub se ve normal, Vercel no
construye, y la única señal aparece 30 minutos después en un issue que apunta a
`311addd`.

**Consecuencia.** El documento que se lee bajo presión describe un flujo que
este repo no usa; el flujo que sí usa tiene un modo de falla silencioso que el
documento no nombra.

**Causa raíz probable:** el runbook se escribió cuando se pusheaba directo a
`master` (5-ago) y no se actualizó cuando el trabajo pasó a PRs.

---

### [BAJO · REINCIDENTE de la 25] La prueba del ancla de deriva afirma el veredicto correcto quitando del fixture el commit que hace que el sistema real conteste otra cosa

`scripts/ci/compuerta_deploy_aud24.test.ts:132-139` ·
`scripts/ci/ultimo-deploy-en-asunto.mjs:16`

La prueba se titula «el commit efectivo real de la ronda 25: `3cc8ead`, no
`4f94490` ni `5a14012` (que nunca fue tip)» y construye la lista con tres
entradas: `4f94490`, `9d8fea4` («algo intermedio sin bandera») y `3cc8ead`.
**`5a14012` —el commit cuyo asunto sí trae `[deploy]` y que está entre los dos—
no aparece en el fixture.** En el `git log` real sí aparece, y por eso el
script devuelve otra cosa.

```
$ npx vitest run scripts/ci/compuerta_deploy_aud24.test.ts
Tests  22 passed (22)

$ node scripts/ci/ultimo-deploy-en-asunto.mjs
311adddc643793dadea9657b1f54861efa727d5d      ← ni 3cc8ead ni 5a14012
```

La 25 anotó exactamente esta forma: «la prueba de la compuerta afirma la regla
que el sistema acaba de violar». Sigue igual, un nivel más arriba: ahora la
prueba nombra en su propio título la propiedad que falta («que nunca fue tip»)
y no la ejercita, porque `ultimoConDeployEnAsunto` no tiene noción de tip
—recibe una lista, no el grafo—.

**Consecuencia.** 22 pruebas en verde sobre la pieza que decide si producción
está atrás, mientras esa pieza contesta mal en el repo real.

---

### [BAJO] `npm audit` degradado deja el CI verde sin haber preguntado, y el aviso es un `::warning::` que nadie recoge

`.github/workflows/ci.yml:107-114`

Tras cuatro intentos sin reporte, el paso imprime `::warning::… Esto NO es un
veredicto de "sin vulnerabilidades": es "no se pudo preguntar"` y hace
`exit 0`. Es una decisión tomada a la vista y autorizada (`4b30bfa`), y el
resto del job sí corre, que era el objetivo. Lo que falta es el recordatorio:
un `::warning::` vive en la pestaña de una corrida y desaparece con ella; no
abre issue, no comenta el PR, no deja artefacto. `982b0d1` demuestra que el
mecanismo ya se rompió una vez por un `bash -e` (el `salida=$(cmd)` suelto
abortaba el script antes de llegar al reintento).

**Escenario, con valores.** `registry.npmjs.org` vuelve a caerse cinco horas.
Se mergean seis PRs con el paso degradado. Cuando el registro se recupera,
nadie corre `npm audit --omit=dev` a mano —el commit que lo pide es el mismo
que ya está mergeado— y la ventana de seis PRs sin auditar no queda anotada en
ningún sitio recuperable.

**Consecuencia.** Una puerta de supply chain que se abre sola y se cierra sola
sin dejar registro de cuándo estuvo abierta.

---

### [BAJO] Tres identidades distintas del repositorio conviven en el árbol

`src/app/admin/dev/page.tsx:15` · `scripts/mejora-diaria/correr.sh:158`

`git remote -v` apunta a `https://github.com/javiercamarapp/cuadra`, que
responde **301** hacia `javiercamarapp/proyect-x-` (renombrado). Y el código
enlaza a un tercer nombre:

```
src/app/admin/dev/page.tsx:15   const REPO_URL = 'https://github.com/javiercamarapp/likida.ai';
scripts/mejora-diaria/correr.sh:158   Apruébalos en: https://github.com/javiercamarapp/likida.ai/pulls
```

**Escenario, con valores.** La rutina de mejora diaria abre un PR y manda el
aviso «Apruébalos en: …/likida.ai/pulls». Javier abre ese enlace y no ve el PR,
porque el PR está en el repo que hoy se llama `proyect-x-`. El PR se queda
abierto sin que nadie sepa que existe.

**Consecuencia.** Menor, pero es un enlace de operación que lleva al sitio
equivocado, y `/admin/dev` es una pantalla que se usa cuando algo va mal.

---

## Lo que revisé y está bien

- **`src/lib/logger.ts` (completo).** La huella FNV estable en vez de `[UUID]`
  sigue siendo la decisión correcta y está bien argumentada: un
  `pdf.no_entregado` a las 3am trae `tenant: id:9f2c…` y `viaje: id:…`, y
  `huellaId(fila.id)` los cruza contra Postgres. `CLAVES_NO_PII` conserva el
  `digest` de Next, que es el único puente entre lo que el contralor ve en
  pantalla y la línea del servidor. Una sola pasada de regex, sin encadenar.
- **`src/instrumentation.ts` (completo).** `onRequestError` registra ruta,
  tipo, método, `digest` y el error, reporta a Sentry y hace `flush` antes de
  que la invocación muera — correcto para serverless. El orden de `register()`
  (observabilidad → config silenciosa → migraciones) está razonado y es el
  correcto. El `await` selectivo sobre `verificarSondeoEscritura0172` (el único
  sondeo que escribe) está bien puesto.
- **Sentry está cableado, no solo instalado.** `sentry.ts` expone `reportar`,
  `reportarExcepcion`, `sanitizarEventoSentry`, `flushObservabilidad`,
  `avisarObservabilidad`; el DSN se lee en `:241`; `logger.ts:188` replica warn
  y error **ya redactados**, por un solo camino.
- **CERRADO de la 25 — el fallo solo-de-cliente.** `/api/client-error` existe,
  corre `logger.error` de servidor, sanea `msg`, acota el body a 4 KB, valida
  `meta` como objeto plano y nunca lanza. `logger.ts:169` usa `keepalive`.
  (Su rate limit es el MEDIO de arriba, no el canal.)
- **CERRADO de la 25 — `pdf.no_entregado`.** Los cuatro sitios de
  `processor.ts` que lo emiten llaman también a `alertarOperador`, y el evento
  entró a `EVENTOS_DE_DINERO` (`alerta.ts:191`), así que sale por WhatsApp
  cuando hay número.
- **CERRADO de la 25 — la compuerta y el 429.** `leerHealth()` solo acepta 200
  y 503 como «health leído», reintenta el 429 con backoff y devuelve `null` en
  cualquier otro caso, que `decidir()` trata como bloqueo. Fail-closed real, y
  con prueba (`leer_health.test.ts`).
- **CERRADO de la 25 — `repair_migrations`.** El guarda
  `verificar-huerfanas-repair.mjs` corre **antes** del `repair`, es fail-closed
  si no puede parsear el techo, y hoy rechazaría 0302/0303. Verificado
  ejecutándolo.
- **CERRADO de la 25 — el runbook y el backup.** `DEPLOY.md:93` ya no promete
  un respaldo programado.
- **`alertarOperador` en general.** Piso por `evento|huellaDeDetalle` (no por
  nombre de evento), marca puesta antes del envío, `LLAVES_SIN_REDACTAR` para
  el folio fiscal, `redactarConservandoFolio` para eventos `timbre.`, y nunca
  propaga al cron. 60+ llamadores cubriendo los once crons.
- **`.env.example` está completo.** De las 125 `process.env.*` que aparecen en
  `src/`, las únicas ausentes son internas (`NODE_ENV`, `NEXT_RUNTIME`, `PATH`,
  `LIKIDA_COBERTURA`, `TICKET_*`, `VERCEL_GIT_*`).
- **`auto-merge-rutina.yml`** exige `head_repository.full_name ==
  github.repository` en el job que mergea, y espera a que **todos** los checks
  terminen (no solo CI). Bien para un repo público. El job `rojo-avisa` no
  lleva ese guarda pero solo comenta.
- **`ci-postgres.yml`** corre las 296 migraciones sobre Postgres virgen y los
  292 bloques de `verificaciones.sql` en cada push, con pgTAP en el servidor.

## Lo que NO alcancé a revisar

- **El estado real de producción.** Sin credenciales ni salida a
  `app.likida.ai`, no pude leer `/api/health` para confirmar `version`,
  `migracion.base` ni `checks.crons`. Todo lo que afirmo sobre producción se
  deriva del repo (último `[deploy]` en mainline, contenido de
  `APLICAR-EN-PRODUCCION.md`) y de los mensajes de commit.
- **La visibilidad del repo.** El proxy de este entorno bloquea GitHub (403).
  «Repo público» lo tomo del texto de `20977c7` y del 301 hacia
  `javiercamarapp/proyect-x-`; no lo pude confirmar contra la API.
- **El historial de corridas de Actions** (cuántas ventanas sin pulso hubo, si
  el issue `salud-produccion` está abierto hoy): requiere la API de GitHub.
- **Si `ALERTA_EMAIL`, `ALERTA_WA` y `SENTRY_DSN` están puestas en Vercel.** El
  hallazgo es que su ausencia no se anunciaría, no que estén ausentes.
- **`e2e-navegador.yml`, `codeql.yml`, `deploy-preview-promote.yml`** más allá
  del job `repair_migrations`.
- **La ruta de logs de Vercel** (retención, si alguien los consulta): fuera del
  repo.
