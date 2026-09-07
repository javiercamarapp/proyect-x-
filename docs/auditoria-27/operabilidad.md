# Operabilidad y DX — auditoría 27

**Nota: 4/10** (antes 5). Razón del movimiento: **deuda que cobró factura** —
la congelación de producción que la 26 marcó como CRÍTICO pendiente lleva hoy
**tres días y medio más, 224 commits y 43 migraciones**, y en esos días la
única alarma que la denunciaba **se cerró sola cuatro veces**— sumada a una
**mirada más profunda** sobre el vigilante: su invariante no es «producción
está al día», y el rojo que hoy tiene es un **accidente** del matcher de
`[deploy]`; con la regla que el repo cree tener, estaría verde.

El ancla del rubro dice «4 o menos si un fallo en producción es invisible».
Producción corre código del 3-sep, la alarma se auto-resuelve con cada push, y
no hay un segundo canal. Eso es exactamente invisible.

**El riesgo mayor hoy:** el demo se hace contra `app.likida.ai`, que sirve el
build `4f94490` — 224 commits atrás de lo que cualquiera lee en el repo. Lo que
se enseñe no es lo que se auditó.

---

## Hallazgos

### [CRÍTICO] Producción congelada desde el 3-sep: 224 commits, 29 merges, 43 migraciones — y la vía de salida nunca ha llegado al final (REINCIDENTE)

`scripts/ci/compuerta-deploy.mjs:128-143` · `.github/workflows/deploy-preview-promote.yml`

**Los números de hoy, medidos, no recordados.** El log de la corrida
34023480696 (`salud-produccion.yml`, schedule, 2026-09-06T09:01:56Z) trae la
respuesta literal de producción:

```
http=200 estado=ok crons=config_ausente migracion={"base":"0303","codigo":"0303","atras":0}
desplegado=4f94490 ultimo_[deploy]=311addd
```

`4f94490abe4f0f9` es `Merge pull request #318 from javiercamarapp/deploy/trigger-chat-fix`,
**2026-09-03 00:21:33 -0600**. Contra `origin/master` (`06b2eca4`):

| medida | valor |
|---|---|
| `git rev-list --count 4f94490..origin/master` | **224 commits** |
| `--merges` | **29** |
| migraciones nuevas (`--diff-filter=A`) | **43** (0304 → 0347) |
| antigüedad del build en producción | **3 días 12 h** |

La 26 dijo «290 commits, 12 merges, 17 migraciones… la base sigue en 0301». Las
tres cifras eran contra otro ancla y la base **ya no está en 0301, está en
0303**: alguien aplicó 0302–0303 y ahí se detuvo. El cuadro no mejoró: pasó de
17 a **43** migraciones pendientes.

**Escenario, con valores.** Alguien empuja hoy `fix(cuadre): … [deploy]`. El
`ignoreCommand` corre `decidir()`; `prefijosCodigo` llega hasta `0347`,
`m.aplicados` de producción llega hasta `0303`; `compuerta-deploy.mjs:128`
encuentra 43 faltantes y devuelve `construir: false`. Vercel no construye, y lo
hace **en silencio** (el `ignoreCommand` no habla). Producción sigue en
`4f94490`.

**Lo que `6379f0b9` sí cambió, y lo que no.** El commit
«validar staging y promover el candidato Production probado» (5-sep) construyó
un pipeline real y bien cerrado: preflight fail-closed, confirmación mecanografiada
`APPLY_MIGRATIONS_AND_PROMOTE`, `supabase db push --dry-run` antes del push real,
Production **staged** con `--skip-domain`, smoke sobre el ID exacto y solo
entonces `vercel promote`. Es la mano mecánica que la 26 pedía. **Pero nunca ha
llegado al final:** el workflow lleva **28 corridas** y ninguna ha ejecutado el
job `promote`. Las dos últimas: la 34004666614 (06-sep 01:44, sobre `master`)
murió en «Configuración opcional de Preview aislada» con
`{"stage":"VERCEL_PREVIEW_PATCH","reason":"HTTP","http_status":400}`; la
34027507258 (06-sep 10:28) murió en «Crear Preview inmutable». `preview_configuration`
es `needs` de `preview`, así que un 400 al parchar variables de Preview bloquea
la promoción de Production.

**Consecuencia.** Todo lo que se arregló desde el 3-sep está escrito y no está
corriendo. Cinco de esos arreglos son de seguridad y privacidad, y los verifiqué
uno por uno con `git merge-base --is-ancestor <sha> 4f94490` → **ninguno está en
producción**:

- `ec88509c` «Redacta datos sensibles del mensaje antes de emitir logs» → producción
  sigue escribiendo esas líneas sin redactar, hoy.
- `be94db90` «describir el alcance real de cancelación ARCO».
- `c8d9821e` «Intercepta Meta por host exacto y respeta el método de Request».
- `a5cbf435` «Conserva filtros de exportación sin activar setters de prototipo».
- `330e8404` «validar destino de conectores al abrir TLS».

Más los 43 cambios de esquema y todo el bloque fiscal/PDF de la ronda. Para el
contralor: lo que vea en el demo no es lo que el equipo cree haberle arreglado.

**Y `/api/health` no puede decirlo:** `migracion.codigo` sale de
`LIKIDA_MIGRACION_CODIGO`, inlineada **en build** (`next.config.ts:27`,
`src/app/api/health/migracion.ts:59`). El build de producción es de cuando la
última migración era 0303, así que reporta honestamente `0303/0303, atras:0` y
`status: ok`. El endpoint compara el build contra su propio esquema; **por
construcción no puede reportar que `master` se movió**.

**Causa raíz probable:** la compuerta es correcta y bloquea bien, pero la única
acción que la destraba (aplicar 0304–0347 en Production) exige credenciales que
solo existen dentro de un workflow que hoy falla antes de llegar ahí.

---

### [CRÍTICO] La alarma de la congelación se cierra sola en cada push a `master`

`.github/workflows/salud-produccion.yml:129-130` y `:169-178`

El paso que detecta la deriva está condicionado a `if: always() && github.event_name != 'push'`
(línea 130). El paso que **cierra** el issue está condicionado a `if: success()`
(línea 170) y no distingue qué evento lo disparó.

**Escenario, con valores reales de hoy:**

1. `2026-09-06T04:52:48Z` — corrida por schedule 34012605079. El paso de deriva
   corre, imprime `desplegado=4f94490 ultimo_[deploy]=311addd`, sale con
   `exit 1`. Job en rojo → se abre el issue **#339** (`created_at`
   `2026-09-06T04:53:03Z`).
2. `2026-09-06T09:01:45Z` — corrida por schedule 34023480696. Mismo rojo; el
   paso de apertura imprime «Ya hay un issue abierto (#339); no se duplica». Correcto.
3. `2026-09-06T11:01:42Z` — corrida por **push** 34029045759, sobre `06b2eca4`
   («Merge pull request #340 from …», sin `[deploy]` en el asunto). Paso 1:
   `/api/health` contesta 200 `estado=ok` → pasa. Pasos 2 y 3: el asunto no lleva
   la bandera → `exit 0` a propósito. Paso 4 (deriva): **saltado**, porque el
   evento es `push`. Job **verde**.
4. `2026-09-06T11:01:53Z` — el paso «Cerrar el issue al recuperarse» corre y
   cierra **#339** con el comentario «El pulso volvió a verde». Producción sigue
   en `4f94490`.

No es un caso aislado: es el patrón. `#334` abierto `00:06:12Z`, cerrado
`00:30:25Z` por la corrida de push 34001450270 (`00:30:15Z`). `#325` abierto
`2026-09-04T09:46:43Z`, cerrado `2026-09-05T23:08:41Z` por la corrida de push
33997852145 (`23:08:29Z`). Y **las 20 corridas por schedule desde
`2026-09-03T22:40:22Z` han fallado, todas** — mientras tanto, **ahora mismo no
hay ningún issue `salud-produccion` abierto**.

**Consecuencia.** El mecanismo que la auditoría 24 (PRU-3) creó para que «el rojo
tenga dueño» —porque «40 corridas rojas seguidas sin que nadie las atendiera
demostraron que un correo por corrida se aprende a ignorar»— tiene hoy una vida
útil acotada por el siguiente push a `master`, que en este repo son horas. El
equipo que mantiene esto ve la bandeja limpia y el tablero de issues limpio con
producción tres días atrás.

**Causa raíz probable:** `success()` en el camino de push certifica un job que
**nunca evaluó** el invariante cuyo issue está cerrando; cerrar debería exigir
que la comprobación de deriva haya corrido y pasado, no que el job no haya
fallado.

---

### [CRÍTICO] Toda la operación depende de GitHub Actions y sigue sin monitor externo (REINCIDENTE)

`src/app/api/health/route.ts:14-19` · `.github/workflows/salud-produccion.yml:26-31`

El encabezado del endpoint dice, textual: «Un UptimeRobot (o el cron de un
tercero) pegándole a esto cada minuto convierte ese modo de falla en una alerta
de minutos». Repetí la búsqueda de la 26 y amplié el patrón —
`uptimerobot|betterstack|better-stack|cronitor|healthchecks\.io|pingdom|cron-job\.org|dead.?man`
sobre `docs/ src/ .github/ scripts/` — y **el único resultado sigue siendo prosa**:
`src/app/api/health/route.ts:18`, `:39`, `:56`, `src/lib/admin/salud.ts:191`,
`src/app/api/health/route.test.ts:5`. Ni una variable, ni un secreto, ni un paso
de runbook. Ese monitor no se contrató nunca.

**Escenario.** Se agota la cuota de Actions (ya pasó el 3–4 sep, lo documentó la
26) o el schedule deja de dispararse. Los tres detectores del sistema —el pulso
de `/api/health`, la compuerta en rojo, el cotejo del sha— viven **dentro de
Actions**. Su modo de falla es no correr, y una corrida que no ocurre no manda
correo, no abre issue y no aparece en ningún tablero. El estado «Actions muerto»
se ve **idéntico** al estado «todo verde».

**Consecuencia.** El día que un cliente esté adentro, un cron del camino del
dinero (`wa-outbox` cada minuto, `facturar` cada 15) puede morir y el
descubrimiento será la pregunta del contralor por su PDF.

**Causa raíz probable:** el vigilante y lo vigilado comparten proveedor y plano
de control; falta un tercero fuera de GitHub que pegue a `/api/health`.

---

### [ALTO] El pulso dice «cada 30 minutos» y de hecho corre cada 2 h a 4 h 47 min

`.github/workflows/salud-produccion.yml:27-28` · `docs/conocimiento/DEPLOY.md:417`

El cron declarado es `*/30 * * * *` — 48 corridas al día. DEPLOY.md:417 lo
repite («cada 30 minutos pega a …»), y `route.ts:19` promete «una alerta de
minutos».

**Medido** (`actions_list`, `event=schedule`, 40 corridas consecutivas): entre
`2026-08-31T23:58:27Z` y `2026-09-06T09:01:45Z` — **5.38 días** — hubo **40**
corridas programadas. Son **7.4 al día contra 48 declaradas**. Huecos concretos:

- `2026-09-06T00:05:59Z` → `2026-09-06T04:52:48Z` = **4 h 47 min**
- `2026-09-05T01:54:31Z` → `2026-09-05T06:29:12Z` = **4 h 35 min**
- `2026-09-04T00:30:42Z` → `2026-09-04T05:13:10Z` = **4 h 42 min**

**Escenario.** `wa-outbox` (cadencia 60 s, tolerancia 20 min) muere a las 00:10.
`/api/health` lo marca `vencido` a las 00:31. El pulso no vuelve a pegar hasta
las 04:52: **4 h 21 min** sin que nadie se entere, contra los 30 min que el
runbook promete. Y si en ese lapso alguien pushea a `master` sin `[deploy]`, el
issue que se abra a las 04:53 se cierra en la siguiente corrida de push (ver el
CRÍTICO anterior).

**Consecuencia.** El único número de latencia de detección que el equipo tiene
escrito es falso por un factor de ~6.5. Un runbook que promete 30 minutos y
entrega 5 horas hace que se planeen guardias contra un tiempo que no existe.

**Causa raíz probable:** GitHub degrada los `schedule` en repos/cuentas cargadas
y no garantiza la cadencia; nada en el repo mide la cadencia *real* del propio
pulso — es un dead-man's switch sin detección del dead man.

---

### [ALTO] El vigilante no puede detectar «`master` avanzó y nadie pidió deploy»; el rojo de hoy es un accidente del matcher

`.github/workflows/salud-produccion.yml:141-151` · `scripts/ci/ultimo-deploy-en-asunto.mjs:23` · `scripts/ci/compuerta-deploy.mjs:79`

El invariante que se comprueba es «producción contiene el último commit **con
`[deploy]` en el asunto**», no «producción contiene el tip de `master`».

**Lo que eso significa hoy, con valores.** `ultimo-deploy-en-asunto.mjs` devuelve
`311adddc` (verificado en el log: `ultimo_[deploy]=311addd`). Ese commit es
`fix(ci): OP-2 indenta el heredoc del aviso de [deploy] para que sea YAML valido`
— un arreglo de CI que jamás quiso publicar nada; casa porque la palabra aparece
en su asunto. Igual `d2202738`, `fix(ci): OP-C1 — avisar ANTES de que un merge
commit pierda el [deploy]`.

El último commit que **sí** quiso publicar es `5a14012e`
(`[deploy] promueve el fix del chat con tenant fantasma (PR #314)`), y
`git merge-base --is-ancestor 5a14012e 4f94490` → **verdadero**: producción ya lo
tiene. **Es decir: si los dos falsos positivos no existieran, el paso imprimiría
«Producción corre el último [deploy] o uno posterior» y el pulso estaría VERDE**,
con producción 224 commits atrás. Hoy el rojo existe por accidente.

Y la forma general del hueco: si nadie vuelve a escribir `[deploy]` en un asunto
—que es exactamente lo que lleva pasando desde el 3-sep—, el vigilante queda
permanentemente verde por muy lejos que se vaya `master`.

**Consecuencia.** El detector no mide lo que el equipo cree que mide. Cuando el
falso positivo se «arregle» (y hay un workflow entero, `aviso-deploy-en-pr.yml`,
empujando en esa dirección), la señal de la congelación desaparece sin que nadie
haya tocado la congelación.

**Causa raíz probable:** el invariante está mal elegido — mide «¿aterrizó el
último deploy pedido?» en vez de «¿producción está al día con `master`?».

*Sobre el matcher:* no repito el hallazgo léxico que la 26 revirtió con razón
escrita. La convención que habría que **decidir** —y que no es léxica, así que
no cae en la misma trampa— es sacar la intención del texto libre del asunto: un
*trailer* dedicado al final del mensaje (`Deploy: yes`, leído por línea completa,
no por subcadena), o una etiqueta/tag de git, o una rama `deploy/*`. Cualquiera
de las tres es una señal que nadie puede activar por accidente al *hablar* del
deploy. Mientras siga siendo una subcadena de prosa, «…pierda el [deploy]» y
«…arregla X [deploy]» son indistinguibles por construcción.

---

### [MEDIO] El backup de Storage nunca ha corrido en verde — ni una sola vez, ni siquiera a mano

`.github/workflows/backup-storage.yml:3-12`

El `schedule` se retiró a propósito (el comentario lo explica bien: un fallo
diario sobre el único buzón de alertas es ruido que entrena a ignorarlo) y se
dejó solo `workflow_dispatch` «hasta la primera corrida MANUAL verde».

**Medido:** el workflow tiene **exactamente 2 corridas en toda su historia** —
`2026-08-25T03:59:52Z` y `2026-08-26T04:03:50Z`—, ambas con `conclusion: failure`
y ambas con `event: schedule`. **Cero corridas manuales.** La condición para
reactivarlo no ha sido intentada nunca en 12 días.

**Escenario.** El bucket de Supabase Storage se pierde o se corrompe hoy. Ahí
viven las fotos de ticket y los PDFs de liquidación — la evidencia que el
contralor cruza y la que sostiene una deducción ante el SAT. No existe una sola
copia verificada fuera de Supabase, y ningún workflow programado lo va a decir.

**Consecuencia.** `docs/operacion/RESILIENCIA-DEPLOY.md:6-16` publica objetivos
RPO/RTO. Hoy el RPO real de Storage es *indefinido*, no un número. El propio
documento lo declara en su §«Primera configuración externa pendiente» (línea 74)
y `DEPLOY.md:5-7` lo repite, así que **no es silencioso** — por eso MEDIO y no
ALTO. Se vuelve ALTO el día que exista el primer cliente.

**Causa raíz probable:** el environment `production-backup` (secretos +
`RESPALDO_S3_DESTINO`) nunca se configuró, y nada calendariza esa tarea.

---

### [MEDIO] La única instrucción que da la compuerta bloqueante apunta a un script cuya verificación quedó 222 migraciones atrás

`scripts/ci/compuerta-deploy.mjs:131` y `:143` · `scripts/aplicar-migraciones-y-humos.sh:9,21,40`

Cuando la compuerta bloquea, el mensaje que ve el operador dice, literal:
«Aplícalas primero (scripts/aplicar-migraciones-y-humos.sh), confirma
/api/health y vuelve a pushear con [deploy]». Es la única acción que ofrece.

Abrí el script:

- Línea 9, su propio encabezado: «`db push` de TODAS las migraciones pendientes
  (**0115–0125**)».
- Línea 21: `REF="$(grep '^NEXT_PUBLIC_SUPABASE_URL=' .env.local …)"` — exige un
  `.env.local` que **no existe** en un clon limpio ni en un runner de CI (el repo
  solo trae `.env.example`). Falla con `exit 2` antes de tocar nada.
- Línea 40, «2/3 · Verificación de las piezas nuevas en la base real»: comprueba
  `agente_definicion`, `cola_aprobacion`, `prospecto_contacto`,
  `wa_evento_pendiente`, `copiloto_conversacion`, `copiloto_mensaje`, `campana` —
  todas de la era 0115–0125 (agosto). **Nada de 0126–0347.**

Y el repo ya lo sabe: `docs/auditoria-enterprise-2026-09-03/INNOVATIVOS-ARRANQUE.md:112`
dice textual «El script histórico `aplicar-migraciones-y-humos.sh` describe
verificaciones de 0115–0125 y **no acredita el contrato actual hasta 0347**». El
mensaje de la compuerta nunca se actualizó.

**Escenario.** El operador choca con la compuerta, sigue la instrucción, consigue
un `.env.local`, corre el script. `db push --include-all` aplica 0304–0347; el
paso 2/3 imprime **siete ✅** habiendo verificado exclusivamente piezas de hace
un mes. El operador lee «verificado» sobre una migración que nadie miró.

**Consecuencia.** El paso de verificación del runbook certifica una foto de hace
tres semanas y se lee como si hubiera revisado lo que se acaba de aplicar.

**Causa raíz probable:** el script se actualizó por su cabeza (se le añadió el
preflight de 0332/0335) pero no por su cola; el bloque de verificación es una
lista escrita a mano que nadie ata a `supabase/migrations/`.

---

### [MEDIO] DEPLOY.md § «Publicar un cambio» describe dos caminos que hoy no funcionan y omite el único que podría

`docs/conocimiento/DEPLOY.md:376-410`

La receta de tres pasos (línea 378-382) termina en
`git commit -m 'fix(x): … [deploy]' && git push   # 3. ahora sí construye`. Con
43 migraciones pendientes eso no construye: la compuerta lo bloquea.

La salida de emergencia que ofrece la línea 409 —«la salida rápida es **Redeploy**
en el panel sobre el último deployment, que no requiere commit nuevo»— tampoco
sirve para este caso: Redeploy reconstruye **el mismo commit**, es decir vuelve a
publicar `4f94490`. La 26 ya lo había dicho («el Redeploy del panel no basta») y
el runbook sigue proponiéndolo como la salida rápida.

El mecanismo que **sí** puede publicar hoy —`deploy-preview-promote.yml` con
`promote=true` y `production_confirmation=APPLY_MIGRATIONS_AND_PROMOTE`, que
aplica migraciones en Production y promueve el ID probado— aparece en DEPLOY.md
solo como una frase del puntero del encabezado (línea 8, «Preview→smoke→promote»)
y **no aparece en la sección de publicar**.

**Escenario.** Son las 3 a.m., hay que publicar un arreglo. El runbook manda al
paso 3 (bloqueado) y luego a Redeploy (republica lo mismo). Dos callejones sin
salida antes de encontrar el workflow correcto, que no está documentado donde se
busca.

**Consecuencia.** El documento que existe para operar a las 3 a.m. cuesta tiempo
en vez de ahorrarlo, exactamente cuando el tiempo importa.

**Causa raíz probable:** la sección de publicar se escribió para el modelo
«push con bandera» del 5-ago y el modelo real de despliegue cambió el 5-sep sin
que la sección se reescribiera.

---

## Lo que revisé y está bien

- **`src/lib/admin/salud.ts:33-71` — la tabla de cadencias espeja `vercel.json` y
  hay prueba que lo exige.** `salud.test.ts` compara las dos; cambiar
  `facturar: */15` allá y no acá rompe la suite. Sin eso, un cron vivo se
  llamaría muerto (o al revés) sin que nadie lo notara.
- **`src/lib/admin/salud.ts:80-97` — `puertaCron` cierra el modo de falla del
  secreto rotado.** Sin `CRON_SECRET`: 500 + `alertarOperador` con
  `codigo: 'cron_sin_secreto'`. No autorizado: 401 **con log** y `codigo: 'cron_401'`
  estable para que Sentry agrupe por causa. Un 401 silencioso ya no es un cron
  invisible.
- **`src/app/api/health/route.ts:104-113` — el arreglo OP-P4 de la 24 aguanta.**
  `muertos = [...vencidos, ...sinLatido]` se juzga **antes** de la rama de hueco
  de configuración. Reproduje el escenario de la base restaurada: con
  `cron_latido` vacía salvo un `descarga-sat` en `parcial`, el resultado es
  `degraded`, no `ok`. El orden de las ramas es correcto.
- **`scripts/ci/compuerta-deploy.mjs:174-196` (`leerHealth`) — el 429 ya no es una
  puerta de escape.** Solo 200 y 503 cuentan como health leído; el 429 reintenta
  con backoff y termina devolviendo `null`, que `decidir()` trata como «no se
  pudo leer: sin base cotejada no se despliega». Fail-closed de verdad; el
  hallazgo de la 25 está cerrado.
- **`scripts/ci/compuerta-deploy.mjs:120-137` — el cotejo por CONJUNTO cierra el
  fail-open de máximo-contra-máximo.** Con `m.aplicados` presente, cualquier
  prefijo del repo que la base no tenga bloquea, sea o no el más alto. Es
  precisamente lo que hoy bloquea (43 faltantes), y bloquea bien.
- **`src/lib/env.ts:47-70` — los marcadores se rechazan por CONTENIDO.** `MARCADOR`
  atrapa `[SENSITIVE]`, `<...>`, `tu-...`, `changeme`, `xxx+`. El incidente del
  20-ago (seis variables con el valor enmascarado re-guardado, OCR facturando
  cero con el health en verde) no volvería a leerse como «puesta».
- **`.env.example` está completo.** Dif entre los 112 nombres del ejemplo y todos
  los `process.env.X` de `src/`: lo único ausente es lo que inyecta la plataforma
  (`VERCEL_ENV`, `VERCEL_GIT_COMMIT_SHA`, `VERCEL_GIT_COMMIT_REF`, `VERCEL_REGION`,
  `NODE_ENV`, `NEXT_RUNTIME`, `PATH`) y variables de arnés de prueba
  (`TICKET_PATH`, `TICKET_HOY`, `TICKET_ANTICIPO`, `LIKIDA_COBERTURA`). Ninguna
  variable de configuración real queda sin documentar.
- **`.github/workflows/ci.yml:20-30` — CI corre en `push: ['**']` y en
  `pull_request`, con `cancel-in-progress`.** Una rama `claude/*` de una rutina
  autónoma sí se verifica. No necesita secretos, así que no puede fallar por
  configuración.
- **`.github/workflows/aviso-deploy-en-pr.yml` — avisa antes, no bloquea.** Si el
  título del PR lleva `[deploy]`, comenta que un merge commit normal no lo
  conserva. Es comentario, no check requerido: no puede volverse el guardarraíl
  que impide reparar (la lección que dejó escrita el incidente del 24-ago).
- **`.github/workflows/deploy-preview-promote.yml` — el diseño del pipeline es
  correcto,** aunque no haya llegado al final: verificación de que el
  `SUPABASE_PROJECT_REF` es el autorizado (compara contra el literal), dry-run
  antes del push real, backup antes de migrar, Production **staged** con
  `--skip-domain`, smoke sobre el ID que se va a activar y `verify-alias`
  después. `repair_migrations` corre antes `verificar-huerfanas-repair.mjs` para
  no marcar como aplicado lo que nunca corrió. Nada de esto es teatro.
- **`scripts/seed.sh:24-42` — `npm run setup` falla con instrucciones.** Comprueba
  `psql` y da el comando de instalación por sistema; ofrece la ruta local
  (`iniciar-pila.mjs`) y la remota (`DATABASE_URL`). El REINCIDENTE MEDIO de la
  25 está cerrado.
- **`src/lib/observability/alerta.ts:60-95` — el piso entre alertas vive en Redis
  (`SET NX PX`), con respaldo en un Map por instancia, y nunca lanza.** Un fallo
  del canal de alerta no puede tumbar el cron que intenta avisar que falló.

---

## Lo que NO alcancé a revisar

Sin esto la nota es una mentira por omisión:

1. **Si `ALERTA_EMAIL` / `ALERTA_WA` están puestas en producción.** Es lo más
   grave de esta lista. Todo el canal «correo a Javier» descansa en
   `alertaConfigurada()`, que exige `ALERTA_EMAIL` **y** `correoConfigurado()`.
   Si alguna está vacía en Vercel, cada `alertarOperador(...)` del repo es un
   no-op silencioso y por diseño (`alerta.ts:24-26`: «Sin `ALERTA_EMAIL` no manda
   y NO es un error»). No tengo consola de Vercel; no pude comprobarlo. **Si
   están vacías, esta nota debería ser menor.**
2. **Si Sentry tiene DSN real en producción y si hay reglas de alerta
   configuradas.** Leí `observability/sentry.ts` pero el cableado efectivo vive
   fuera del repo.
3. **La retención real de los runtime logs de Vercel.** `DEPLOY.md:33` declara que
   no hay log drain y que «un fallo del sábado de madrugada puede no existir el
   lunes»; no pude medir cuántas horas son.
4. **`rollback-production.yml`, `recover-empty-staging.yml`, `e2e-navegador.yml`,
   `codeql.yml`, `ci-postgres.yml`, `auto-merge-rutina.yml`** — no los abrí. El
   nombre de `recover-empty-staging.yml` sugiere que staging se vació en algún
   momento; no lo investigué.
5. **No corrí la compuerta local (`npm test`, `tsc`, `lint`).** Me apoyé en la
   línea base medida hoy en `MAPA.md` (12,174 pruebas, 5 fallos de infra por
   `::1`). Si esa línea base se movió, mis lecturas de código siguen valiendo pero
   el veredicto de «suite verde» no es mío.
6. **La conducta de `/api/health` bajo una base caída** (`db !== 'ok'` → `fail`,
   503) solo la leí; no la ejecuté contra nada.
