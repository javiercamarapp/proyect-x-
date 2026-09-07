# Operabilidad y DX — auditoría 28

**Nota: 3/10** (antes 4). Razón del movimiento: **deuda que cobró factura**. La
27 marcó como CRÍTICO que producción llevaba 224 commits congelada y que nadie
se enteraba. Alguien lo atendió a mano el 7-sep (`d56e626`, commit vacío con la
bandera). Medí qué pasó de verdad: **las 43 migraciones sí se aplicaron a la
base de producción, y el código nunca llegó**. Producción sigue sirviendo el
build `4f94490` del 3-sep contra un esquema del 7-sep, y en esa combinación una
RPC que el panel fiscal llama **ya no existe** — la migración 0317 dropeó su
firma. `/api/health` contesta `status: ok` y `atras: 0` sobre ese estado, porque
`cotejar()` clampa la resta a cero y no sabe mirar en la otra dirección.

Lo que sí subió: **OP-C2 está cerrado y verificado** (ver «Lo que revisé y está
bien»). No alcanza a compensar. El ancla del rubro dice «4 o menos si un fallo
en producción es invisible»; hoy hay un fallo en producción, es invisible, y lo
causó la reparación.

**El riesgo mayor hoy:** el commit dice «producción al día: migraciones
0304-0347 aplicadas y verificadas» y el mensaje es cierto solo en su primera
mitad. Quien lea el log de `master` creerá que producción está publicada. Está
peor que antes del arreglo: mismo código viejo, esquema nuevo, una RPC rota.

---

## Hallazgos

### [CRÍTICO] `d56e626` aplicó el esquema y no publicó el código: producción corre `4f94490` (3-sep) contra la base `0347`, y `/api/health` lo llama `ok` (REINCIDENTE, agravado)

`src/app/api/health/migracion.ts:100` · `src/app/api/health/route.ts:174` y `:185` · `.github/workflows/salud-produccion.yml:115-122`

**Medido, no recordado.** Log de la corrida **34092224844**
(`salud-produccion.yml`, `event: push`, `head_sha=d56e626`,
2026-09-07T06:45:06Z → 06:57:04Z), paso a paso:

```
06:46:44  http=200 estado=ok crons=config_ausente migracion={"base":"0347","codigo":"0303","atras":0}
06:46:45  compuerta de despliegue · código=0347 · base=0347
06:46:45  base 0347 a la par del código 0347 (cotejo por máximo…): se construye.
06:46:45  compuerta: CONSTRUIR
06:46:46  intento 1: esperado=d56e626 desplegado=4f94490
   …      (20 intentos, 30 s cada uno)
06:56:29  intento 20: esperado=d56e626 desplegado=4f94490
06:56:59  ::error::Producción sigue en '4f94490' y el push con [deploy] fue d56e626
```

Y 3 h 47 min después, corrida **34111978075** (schedule, 2026-09-07T10:32:41Z):
`desplegado=4f94490 ultimo_[deploy]=d56e626`, misma respuesta de health.

Contra `master` (`d56e626`), medido con git local:

| medida | valor |
|---|---|
| `git rev-list --count 4f94490..d56e626` | **231 commits** |
| `--merges` | **32** |
| migraciones nuevas (`--diff-filter=A`) | **43** (0304 → 0347) |
| antigüedad del build en producción | **4 d 4 h** (`4f94490` = 2026-09-03 00:21:33 -0600) |

**Escenario, con valores.** La compuerta **dejó pasar** (`compuerta: CONSTRUIR`)
porque `migracion.base` ya es `0347`. Vercel, aun así, no publicó: 20 sondeos en
10 minutos y otras 3 h 47 min después, `version` sigue siendo `4f94490`. El
repo no tiene forma de decir por qué —el `ignoreCommand` no habla y el build de
Vercel no deja rastro en Actions—, así que el único mensaje que produce el
sistema es «mira el panel de Vercel». **La causa de que no construya se movió
del repo a un plano que ningún workflow observa.**

**Y `/api/health` no puede denunciarlo.** `cotejar()` calcula
`const atras = Math.max(0, Number(codigo) - Number(base));`
(`migracion.ts:100`). Con `codigo=0303` y `base=0347`, eso es
`Math.max(0, -44) = 0`, sin `motivo`. `route.ts:185` solo degrada cuando
`migracion.atras !== 0`. Resultado: **el estado «el esquema va 44 migraciones
adelante del código que atiende peticiones» se reporta idéntico a «todo al
día»**, con `status: ok` y HTTP 200. El único paso que sí lo ve es el cotejo del
sha (`salud-produccion.yml:129-151`), que es una comparación de commits, no de
esquema, y solo corre por schedule.

**Consecuencia.** El equipo que mantiene esto tiene un commit en `master` que
afirma «producción al día», un `/api/health` en verde y una producción que no
solo está 231 commits atrás sino que ahora corre contra un esquema que no
conoce (ver el CRÍTICO siguiente). Para el contralor: lo que se le enseñe en el
demo no es lo que el equipo cree haberle arreglado, y además está roto de una
forma nueva.

**Causa raíz probable:** `atras` se diseñó como una magnitud con signo único
(«cuánto le falta a la base») y se clampa a cero, así que la deriva inversa —la
que produce exactamente este procedimiento de reparación— es insatisfacible por
construcción.

---

### [CRÍTICO] La migración 0317, ya aplicada en producción, dropeó la firma de `gastos_fiscales_agregados_tenant` que el build vivo llama: el panel fiscal pide una función que ya no existe

`supabase/migrations/0317_gastos_fiscales_agregados_paridad_engine.sql:43` y `:45-58` · `src/lib/likida/fiscal.ts:1620-1629` (en producción, `4f94490:src/lib/likida/fiscal.ts:1337`) · `src/app/dashboard/inicio-contenido.tsx:134` · `src/lib/agents/chat-tools.ts:146`

**Los dos lados, leídos.** La firma que existía en el esquema `0303` —el que el
build de producción conoce— la fija la 0282 (`create or replace function
public.gastos_fiscales_agregados_tenant(p_tenant, p_desde, p_hasta,
p_tope_efectivo, p_tope_alimentacion, p_conceptos_alimentacion, p_cortes)`, 7
parámetros) y la 0316 la reescribe sin cambiarla. La **0317**, línea 43:

```sql
drop function if exists public.gastos_fiscales_agregados_tenant(uuid, date, date, numeric, numeric, text[], date[]);
```

y crea en su lugar una de **13 parámetros** cuyos seis nuevos
(`p_claves_combustible`, `p_vigente_desde`, `p_exigible_desde`,
`p_umbral_renglones_ajenos`, `p_patron_bar`, `p_hoy`) **no tienen `default`**
(líneas 53-58). Producción tiene la 0317 aplicada: `/api/health` reporta
`base: "0347"` desde 2026-09-07T06:46:44Z.

El código que corre en producción (`4f94490`) llama con los **siete** viejos:

```
4f94490:src/lib/likida/fiscal.ts:1337
  supabaseAdmin().rpc('gastos_fiscales_agregados_tenant', {
    p_tenant, p_desde, p_hasta, p_tope_efectivo,
    p_tope_alimentacion, p_conceptos_alimentacion, p_cortes })
```

**Escenario, con valores.** Un usuario abre `/dashboard` en `app.likida.ai` hoy.
`inicio-contenido.tsx:134` llama `getGastosFiscales(tenantId, periodoFiscal)`.
PostgREST resuelve la RPC por nombres de argumento: con solo la función de 13
parámetros viva y siete claves en el cuerpo, no hay candidata → **PGRST202,
«Could not find the function … in the schema cache»**. `getGastosFiscales`
lanza (`fiscal.ts`, `throw new Error('getGastosFiscales: ' + error.message)`).
En `/dashboard` el error lo traga `safe()`
(`4f94490:src/app/dashboard/inicio-contenido.tsx:44-46`,
`catch { return null; }`) y el bloque fiscal queda en «no hay dato» **para
siempre y sin ruido**. En el copiloto no hay `safe()`: `chat-tools.ts:146`
(`perdidas_fiscales`) y `src/lib/mcp/herramientas/dinero.ts:160` propagan el
error al usuario.

**Consecuencia.** El contralor —el comprador— abre el panel y la tarjeta de IVA
acreditable / pérdidas fiscales está vacía, o le pregunta al copiloto por sus
deducciones y recibe un error. No hay alerta: el `catch` es silencioso por
diseño y `/api/health` dice `ok`. Es exactamente el modo de falla que el rubro
llama invisible, y el que se demuestra en la sala.

**Causa raíz probable:** aplicar migraciones a producción sin publicar el código
que las acompaña rompe el contrato en la dirección que nadie prueba; el `drop
function` de la 0317 es correcto en su propio orden (código y esquema juntos) y
letal fuera de él.

---

### [CRÍTICO] Toda la operación sigue dependiendo de GitHub Actions y sigue sin monitor externo (REINCIDENTE)

`src/app/api/health/route.ts:18` · `.github/workflows/salud-produccion.yml:26-31`

Repetí la búsqueda de la 27 con el mismo patrón
(`uptimerobot|betterstack|better-stack|cronitor|healthchecks\.io|pingdom|cron-job\.org|dead.?man`
sobre `docs/ src/ .github/ scripts/`) y **el único resultado sigue siendo
prosa**: `src/app/api/health/route.ts:18` («Un UptimeRobot (o el cron de un
tercero)…»), más las dos auditorías anteriores citándose a sí mismas y un
`dead/manual-review` de `wa-outbox` que es otra cosa. Ni una variable, ni un
secreto, ni un paso de runbook.

**Escenario.** Los tres detectores del sistema —el pulso de `/api/health`, la
compuerta y el cotejo del sha— viven dentro de Actions. Su modo de falla es *no
correr*, y una corrida que no ocurre no manda correo, no abre issue y no
aparece en ningún tablero. «Actions muerto» se ve idéntico a «todo verde». Y
esta ronda hay evidencia de que la cadencia sí se degrada (ver el ALTO de abajo:
20 corridas programadas en 2.46 días contra 118 esperadas).

**Consecuencia.** El día que exista el primer cliente, un cron del camino del
dinero (`wa-outbox` cada minuto, `facturar` cada 15) puede morir y el
descubrimiento será la pregunta del contralor por su PDF.

**Causa raíz probable:** el vigilante y lo vigilado comparten proveedor y plano
de control.

---

### [ALTO] El gate del smoke borra la causa de cualquier fallo y, encima, acusa un bypass fantasma que «requiere revisión administrativa»

`scripts/ci/production-candidate.mjs:180` · `scripts/ci/production-candidate.mjs:100-107`

Línea 180, el manejador de último recurso del script:

```js
main(...process.argv.slice(2)).catch(() => { console.error('Gate del candidato Vercel falló; no promover.'); process.exitCode = 1; });
```

El `catch` **descarta el objeto de error**. Cualquier fallo del gate —HTTP de la
API de Vercel, cookie de Deployment Protection, smoke de navegador, health del
candidato— produce exactamente la misma línea de nueve palabras y nada más.

Y `withProtection` (líneas 92-107) agrava: crea el bypass con un `PATCH`, y su
`finally` intenta revocarlo **incluso si la creación falló**; si esa revocación
falla, el `catch` de la línea 103 imprime
`::error::Falló la revocación del bypass creado por esta ejecución; requiere
revisión administrativa.` y lanza `Cleanup de Deployment Protection falló`,
**que reemplaza al error original en vuelo** (semántica de `try/finally`).

**Escenario, con valores medidos.** Corrida **34031119195**
(`deploy-preview-promote.yml`, `workflow_dispatch` sobre `ebb215c`,
2026-09-06T11:44:45Z), job **101482205894** «Smoke protegido de Preview (GET)».
El paso corre de `11:57:16.68` a `11:57:17.47` — **0.79 s**, imposible para un
smoke de Playwright, así que la falla ocurrió en el `PATCH` de creación del
bypass o antes del `action`. La salida completa del paso es:

```
::error::Falló la revocación del bypass creado por esta ejecución; requiere revisión administrativa.
Gate del candidato Vercel falló; no promover.
##[error]Process completed with exit code 1.
```

Y como `production_migrations`, `production_candidate`, `smoke_production` y
`promote` tienen `needs: [… smoke]`, los cuatro salieron **`skipped`**.
**Resultado del rubro: `deploy-preview-promote.yml` lleva 29 corridas y el job
`promote` no se ha ejecutado ni una vez.** (La 27 midió 28/0; el `preview` ya
pasa desde `ebb215c`, el cuello se movió al smoke.)

**Consecuencia.** El único mecanismo capaz de publicar producción hoy falla y
no dice por qué; el operador a las 3 a.m. recibe una alarma de seguridad
probablemente falsa (un bypass que nunca se creó) y cero información sobre la
causa real. Ese es el rubro entero: «si esto revienta, ¿qué tengo a la mañana
siguiente para saber qué pasó?» — aquí, nada.

**Causa raíz probable:** dos capas de supresión de errores puestas por miedo a
filtrar secretos (`catch` vacío al final, `finally` que lanza) borran también lo
que no es secreto; y el `finally` no distingue «el bypass se creó» de «el PATCH
de creación falló».

---

### [ALTO] El pulso dice «cada 30 minutos» y de hecho corre cada ~3 h, con un hueco nuevo de 5 h 30 min (REINCIDENTE, peor)

`.github/workflows/salud-produccion.yml:28` · `docs/conocimiento/DEPLOY.md:417`

El cron declarado es `*/30 * * * *` = 48 corridas/día. `DEPLOY.md:417` lo
repite («cada 30 minutos pega a …») y `route.ts:19` promete «una alerta de
minutos».

**Medido esta ronda** (`actions_list` sobre `salud-produccion.yml`,
`event: schedule`, corridas 464→493): entre `2026-09-04T23:34:25Z` y
`2026-09-07T10:32:32Z` —**2.457 días**— hubo **20** corridas programadas.
Son **8.1 al día contra 48 declaradas** (factor 5.9). Huecos concretos:

- `2026-09-07T05:02:05Z` → `2026-09-07T10:32:32Z` = **5 h 30 min** (nuevo peor;
  la 27 midió 4 h 47 min como máximo)
- `2026-09-06T00:05:59Z` → `2026-09-06T04:52:48Z` = 4 h 47 min
- `2026-09-07T00:28:13Z` → `2026-09-07T05:02:05Z` = 4 h 34 min

**Escenario.** El deploy de `d56e626` se dio por fallido a las 06:57:00Z del
7-sep. La siguiente evaluación de deriva —la que corre por schedule— no ocurrió
hasta las **10:32:32Z**: **3 h 35 min** en los que el tablero no tenía nada
nuevo que decir sobre una producción recién rota. Con `wa-outbox` (cadencia
60 s, tolerancia 20 min) el cálculo es el mismo: hasta 5 h 30 min entre que
`/api/health` marca `vencido` y alguien pega al endpoint.

**Consecuencia.** El único número de latencia de detección escrito en el repo es
falso por un factor de ~6. Se planean guardias contra un tiempo que no existe.

**Causa raíz probable:** GitHub degrada los `schedule` y no garantiza cadencia;
nada en el repo mide la cadencia real del propio pulso — dead-man's switch sin
detección del dead man.

---

### [ALTO] El invariante del vigilante sigue siendo «el último `[deploy]`», no «el tip de `master`» (REINCIDENTE)

`.github/workflows/salud-produccion.yml:141-151` · `scripts/ci/ultimo-deploy-en-asunto.mjs` · `scripts/ci/compuerta-deploy.mjs:79-84`

Hoy el detector está en rojo **con razón** —`ultimo_[deploy]=d56e626` y
`desplegado=4f94490`, medido en la corrida 34111978075—, lo que resuelve el
«accidente del matcher» que la 27 documentó: el ancla ya no es un `fix(ci)` que
solo *hablaba* del deploy. Pero **el hueco estructural es idéntico**: lo que se
comprueba es «producción contiene el último commit con `[deploy]` en el asunto»,
no «producción contiene el tip de `master`».

**Escenario, con valores.** En el momento en que alguien consiga publicar
`d56e626` —por Redeploy, por el panel, por el pipeline—, `merge-base
--is-ancestor d56e626 <desplegado>` será verdadero y el pulso quedará **VERDE**.
A partir de ahí, `master` puede avanzar los siguientes 231 commits sin que nadie
escriba `[deploy]` en un asunto —que es exactamente lo que pasó entre el 3 y el
7 de septiembre— y el vigilante seguirá verde todo ese tiempo.

**Consecuencia.** El detector no mide lo que el equipo cree que mide, y su
próximo verde no significará «producción está al día» sino «el último deploy que
alguien pidió, aterrizó».

**Causa raíz probable:** el invariante está mal elegido; y mientras la intención
de publicar viva como una **subcadena de prosa libre** en el asunto, «arregla el
aviso de `[deploy]`» y «publica X `[deploy]`» son indistinguibles por
construcción.

---

### [ALTO] `staging-recovery.mjs` congela el inventario de migraciones en `324` / `'0347'`: el repo no acepta una migración nueva sin ponerse rojo (REINCIDENTE)

`scripts/ci/staging-recovery.mjs:121`

```js
if (expected.length !== 324 || new Set(expected).size !== 324 || expected.at(-1) !== '0347') fail('RECOVERY_LOCAL_MIGRATIONS');
```

Verificado hoy: `ls supabase/migrations/*.sql | wc -l` = **324**, última =
**0347**. La prueba que lo fija sigue viva
(`scripts/ci/staging-recovery.test.ts:162`, `rejects.toThrow('RECOVERY_LOCAL_MIGRATIONS')`);
corrí `npx vitest run scripts/ci/staging-recovery.test.ts
scripts/ci/prepare-build-env.test.ts scripts/ci/compuerta_deploy_aud24.test.ts`
→ 3 archivos, **82 pruebas verdes**.

**Escenario.** Alguien añade `supabase/migrations/0348_*.sql`. `expected.length`
pasa a 325 y `expected.at(-1)` a `'0348'`: **la primera condición basta para
poner el repo en rojo**, y ese literal está en un archivo de CI que nadie
relaciona con «agregué una migración». Es la razón por la que la 27 tuvo que
revertir su segundo arreglo.

**Consecuencia.** Cualquier hallazgo de cualquier rubro que necesite esquema
nuevo empieza costando un rojo inexplicable en 35 pruebas. Es un peaje sobre
todo el equipo, cobrado en el momento de menos contexto.

**Causa raíz probable:** un enclavamiento de una operación destructiva se
escribió como igualdad contra un conteo literal en vez de contra un artefacto
que se regenere con el repo.

---

### [MEDIO] `sanitizeBuildLog` redacta cualquier valor de entorno, incluido `true`: el único diagnóstico del build queda ilegible (superficie NUEVA)

`scripts/ci/prepare-build-env.mjs:16-25` (llamado desde `:83-85`)

El log del build se redacta contra
`[...Object.values(env), ...Object.values(values), ...Object.values(pulled)]`,
donde `env` es **`process.env` completo**. En un runner de GitHub eso incluye
`CI=true`, `GITHUB_ACTIONS=true`, `RUNNER_OS=Linux`, `HOME=/home/runner`. El
filtro solo exige `value.length > 0`, y la sustitución es
`safe.replaceAll(secret, '[REDACTED]')` — subcadena cruda, sin límites de
palabra.

**Escenario, ejecutado.** Importé la función exportada y le pasé un log de
compilación de Next con ese entorno:

```
entra:  Build failed because of webpack errors on Linux, CI=true, cwd /home/runner/work/proyect-x-/proyect-x-
        node version 24 is true supported
sale:   Build failed because of webpack errors on [REDACTED], CI=[REDACTED], cwd [REDACTED]
        node version [REDACTED] is [REDACTED] supported
```

**Consecuencia.** El artefacto `production-build-sanitized`
(`deploy-preview-promote.yml:388-396`) existe precisamente para diagnosticar por
qué falló el build de producción, y `true` es una de las palabras más frecuentes
de un error de TypeScript (`Type 'true' is not assignable to…`, `strict: true`).
El equipo se queda con un log picado a `[REDACTED]` justo en el paso que hoy es
el cuello de botella para desatascar producción.

**Causa raíz probable:** la lista de «secretos conocidos» se armó como «todo el
entorno» en vez de las tres claves que el script realmente hidrata (`KEYS`), y
no hay piso de longitud ni exigencia de que el valor parezca una credencial.

---

### [MEDIO] El job «Crear Preview inmutable» pasó a `environment: production`, y el paso que dice verificar las credenciales de Preview no verifica nada (superficie NUEVA)

`.github/workflows/deploy-preview-promote.yml:250` · `:261-268` · `:64-67`

`ebb215c` cambió `environment: preview` → `environment: production` en el job
`preview` (línea 250) y borró el `vercel link`. Dos consecuencias medibles:

1. El paso de la línea 261 se sigue llamando **«Verificar credenciales Vercel
   del environment Preview»** y el job ya no está en ese environment: los
   `secrets.VERCEL_TOKEN` / `SUPABASE_ACCESS_TOKEN` que consume salen ahora del
   environment **production**. El job que construye y despliega un Preview
   corre con las credenciales del entorno productivo, y su nombre dice lo
   contrario.
2. Las dos comprobaciones de las líneas 267-268
   (`[ -n "$VERCEL_ORG_ID" ]`, `[ -n "$VERCEL_PROJECT_ID" ]`) son **tautologías**:
   ambas variables son literales fijados en el `env:` del workflow
   (líneas 66-67, `team_uelpa362TxivuQUHNzTGLWNv` /
   `prj_OnrG9eY8WQzj35I3jtAZX2wTJ2sn`), no secretos de environment. Nunca
   pueden estar vacías, así que el paso solo verifica de verdad `VERCEL_TOKEN`.

**Escenario.** Alguien añade una regla de protección al environment
`production` (aprobación requerida, rama permitida). El job **`preview`** —el
que solo debía tocar staging— empieza a pedir aprobación, y quien la conceda
creerá estar aprobando una Preview. En sentido contrario: si el environment
`preview` tenía un token de menor alcance, ese aislamiento ya no existe.

**Consecuencia.** El rótulo del paso miente sobre qué environment se está
usando, y el aislamiento preview/production que el resto del pipeline defiende
con cuidado (Production **staged**, `--skip-domain`, `verify-alias`) se rompe en
el job de entrada.

**Causa raíz probable:** el cambio de environment se hizo para conseguir
`SUPABASE_ACCESS_TOKEN` en el job de Preview, sin renombrar el paso ni mover el
secreto al environment que le correspondía.

---

### [MEDIO] El backup de Storage sigue sin haber corrido en verde ni una sola vez, ni a mano (REINCIDENTE)

`.github/workflows/backup-storage.yml:3-12`

**Medido hoy** (`actions_list` sobre `backup-storage.yml`): el workflow tiene
**exactamente 2 corridas en toda su historia** —`2026-08-25T03:59:52Z` y
`2026-08-26T04:03:50Z`—, ambas `conclusion: failure`, ambas `event: schedule`.
**Cero corridas manuales**, igual que hace 24 h: la condición que el propio
comentario del workflow pone para reactivar el `schedule` («hasta la primera
corrida MANUAL verde») no se ha intentado nunca en **13 días**.

**Escenario.** El bucket de Supabase Storage se pierde hoy. Ahí viven las fotos
de ticket y los PDFs de liquidación: la evidencia que el contralor cruza y la
que sostiene una deducción ante el SAT. No existe una copia verificada fuera de
Supabase y ningún workflow programado lo va a decir.

**Consecuencia.** `docs/operacion/RESILIENCIA-DEPLOY.md` publica objetivos
RPO/RTO; el RPO real de Storage es *indefinido*, no un número. Sigue en MEDIO y
no en ALTO **solo** porque el propio repo lo declara por escrito; se vuelve ALTO
el día que exista el primer cliente.

**Causa raíz probable:** el environment `production-backup` nunca se configuró y
nada calendariza esa tarea.

---

### [MEDIO] La instrucción que da la compuerta cuando bloquea apunta a un script cuya verificación quedó 222 migraciones atrás (REINCIDENTE)

`scripts/ci/compuerta-deploy.mjs:131` y `:143` · `scripts/aplicar-migraciones-y-humos.sh:9`, `:21`, `:40`

El mensaje bloqueante dice, literal: «Aplícalas primero
(`scripts/aplicar-migraciones-y-humos.sh`), confirma /api/health y vuelve a
pushear con `[deploy]`». Es la única acción que ofrece. Reabrí el script y sigue
igual que en la 27:

- Línea 9, su propio encabezado: «`db push` de TODAS las migraciones pendientes
  (**0115–0125**)».
- Línea 21: `REF="$(grep '^NEXT_PUBLIC_SUPABASE_URL=' .env.local …)"` — exige un
  `.env.local` que no existe en un clon limpio ni en un runner; `exit 2` antes de
  tocar nada.
- Línea 40, «2/3 · Verificación de las piezas nuevas en la base real»: la lista
  de comprobaciones sigue siendo la de la era 0115–0125 (agosto). Nada de
  0126–0347.

**Escenario, ahora con el caso real de esta ronda.** El 7-sep alguien aplicó
0304–0347 a producción. Si lo hizo por esta vía, el paso 2/3 imprimió **siete
✅** habiendo verificado exclusivamente piezas de hace un mes — y **no habría
detectado** que la 0317 dejó a la RPC fiscal con una firma que el código
desplegado no puede llamar (el CRÍTICO nº 2). El commit dice «aplicadas y
verificadas»; el único verificador que el runbook ofrece no mira nada de ese
rango.

**Consecuencia.** El paso de verificación certifica una foto de hace tres
semanas y se lee como si hubiera revisado lo que se acaba de aplicar. Esta ronda
esa lectura costó una rotura en producción.

**Causa raíz probable:** el bloque de verificación es una lista escrita a mano
que nadie ata a `supabase/migrations/`.

---

### [MEDIO] DEPLOY.md § «Publicar un cambio» describe una receta que hoy pasa la compuerta y aun así no publica, y una salida de emergencia que republica lo roto (REINCIDENTE, con causa nueva)

`docs/conocimiento/DEPLOY.md:378-382` y `:409`

La receta de tres pasos termina en
`git commit -m 'fix(x): … [deploy]' && git push   # 3. ahora sí construye`.
La 27 la marcó porque la compuerta bloqueaba; **hoy la compuerta la deja pasar**
(`compuerta: CONSTRUIR`, corrida 34092224844) y el paso 3 sigue sin construir.
El runbook es igual de falso por una causa distinta, y no dice qué mirar.

La salida rápida de la línea 409 —«**Redeploy** en el panel sobre el último
deployment, que no requiere commit nuevo»— reconstruye **el mismo commit**, es
decir vuelve a publicar `4f94490`: el build del 3-sep, que es precisamente el
que hoy está roto contra la base 0347.

**Escenario.** Son las 3 a.m. Se sigue el paso 3 (no publica, sin explicación),
luego el Redeploy (republica exactamente el build defectuoso). Dos callejones
sin salida antes de encontrar `deploy-preview-promote.yml`, que la sección de
publicar no menciona — y que, medido arriba, lleva 29 corridas sin promover
nunca.

**Consecuencia.** El documento que existe para operar a las 3 a.m. cuesta tiempo
en vez de ahorrarlo, y su consejo de emergencia hoy **empeora** el estado.

**Causa raíz probable:** la sección se escribió para el modelo «push con
bandera» del 5-ago y no se ha reescrito desde que el modelo real cambió.

---

## Lo que revisé y está bien

- **OP-C2 está cerrado, y lo verifiqué contra la API de GitHub, no contra el
  commit.** `.github/workflows/salud-produccion.yml:179`
  (`if: success() && github.event_name != 'push'`). Prueba medida: el issue
  **#344** (`salud-produccion`) se abrió el `2026-09-06T12:58:35Z` y **sigue
  OPEN**, con `updated_at` idéntico a su `created_at`. Entre medias hubo **tres
  corridas por push con `conclusion: success`** —34080930407 (`03:49:11Z`),
  34080957316 (`03:49:43Z`), 34080972300 (`03:50:00Z`), todas del 7-sep—, que
  con el código anterior lo habrían cerrado las tres veces. No lo tocaron.
  Además, ningún issue `salud-produccion` se ha cerrado desde `5569437`: el
  último cierre en todo el repo es **#339**, `2026-09-06T11:01:53Z`, anterior al
  arreglo. **El arreglo cerró de verdad.**
- **La compuerta sigue siendo fail-closed donde importa.**
  `scripts/ci/compuerta-deploy.mjs:104-106` (health ilegible → no se construye),
  `:174-194` (`leerHealth`: solo 200 y 503 cuentan; el 429 reintenta y termina en
  `null`), `:125-135` (cotejo por CONJUNTO con `m.aplicados`). Nada de eso se
  rompió; el problema de esta ronda no es que la compuerta falle abierta, es que
  **la publicación no ocurre aunque la compuerta diga que sí**.
- **La degradación de esquema en la dirección esperada sí funciona.**
  `src/app/api/health/migracion.ts:101-103` + `route.ts:174-185`: con la base
  atrás del código, `atras > 0` → `motivo` + `degraded`. El hueco es solo la
  dirección inversa (CRÍTICO nº 1).
- **`prepare-build-env.mjs` (archivo nuevo) es sólido en lo que le toca
  guardar.** `:36` compara `projectId`/`orgId` contra los literales autorizados;
  `:38` rechaza symlinks; `:41` aborta si el `.env` traído contiene claves de
  admin; `:44` exige exactamente una asignación por clave (nada de duplicados
  que se pisen); `:63-66` distingue «máscara `[SENSITIVE]` que se puede
  hidratar» de «valor real contrario que no se tapa»; `:68` borra las
  `ADMIN_KEYS` del entorno del hijo; `:92-97` restaura el archivo original en
  `finally` pase lo que pase. Y funcionó: el job «Crear Preview inmutable» pasó
  por primera vez en la corrida 34031119195 (paso 6, `11:53:42Z → 11:56:08Z`).
  Mi objeción es la redacción del log, no el manejo de credenciales.
- **El artefacto de diagnóstico se sube solo cuando hace falta.**
  `deploy-preview-promote.yml:277-284` y `:388-396`: `if: failure()`,
  `if-no-files-found: ignore`, `retention-days: 3`. La idea es correcta; lo que
  falla es el contenido (MEDIO de `sanitizeBuildLog`).
- **El `[deploy]` se lee solo del asunto en los tres lugares, sin
  reimplementaciones.** `compuerta-deploy.mjs:51` exporta `FLAG_DEPLOY_RE`, y
  `decidir()` (`:95`), `ultimoConDeployEnAsunto()` (`:81`) y los dos pasos de
  `salud-produccion.yml` (`:90`, `:109`) usan `head -n1` / `.split('\n')[0]`. El
  ALTO REINCIDENTE de la 25 (`git log --grep` casando contra el cuerpo) está
  cerrado y verificado en el log de la corrida 34092224844, donde `ASUNTO` llega
  con el cuerpo completo y el `head -n1` lo recorta bien.
- **La suite de CI del rubro está verde.** `npx vitest run
  scripts/ci/staging-recovery.test.ts scripts/ci/prepare-build-env.test.ts
  scripts/ci/compuerta_deploy_aud24.test.ts` → 3 archivos, 82 pruebas, 0 fallos,
  1.02 s.

---

## Lo que NO alcancé a revisar

Sin esto la nota es una mentira por omisión:

1. **Por qué Vercel no construyó `d56e626`.** Es la pregunta central de la ronda
   y no tengo consola de Vercel. Las tres hipótesis que no pude separar:
   (a) el `ignoreCommand` sí bloqueó por una razón que no reprodujo el paso de
   Actions (p. ej. `git log -1 --pretty=%s` sobre el clon superficial de Vercel,
   o `VERCEL_GIT_COMMIT_MESSAGE` con el cuerpo entero); (b) el build arrancó y
   falló; (c) la integración Git del proyecto no está recibiendo pushes. **Las
   tres son verificables en un minuto desde el panel y ninguna deja rastro en el
   repo — eso, por sí solo, es el hueco.**
2. **Si `ALERTA_EMAIL` / `ALERTA_WA` están puestas en producción.** Todo el
   canal «correo a Javier» descansa en `alertaConfigurada()`; sin `ALERTA_EMAIL`
   cada `alertarOperador(...)` es un no-op silencioso y por diseño. No tengo
   consola de Vercel. **Si están vacías, esta nota debería ser menor.**
3. **Si Sentry tiene DSN real y reglas de alerta en producción.** El cableado
   efectivo vive fuera del repo.
4. **El estado real del bypass de Deployment Protection** que la corrida
   34031119195 dijo no haber podido revocar. Mi lectura del código dice que
   probablemente nunca se creó, pero eso hay que confirmarlo en el panel de
   Vercel: si sí se creó, hay un bypass de protección vivo desde el
   2026-09-06T11:57:17Z.
5. **`rollback-production.yml`, `recover-empty-staging.yml`, `e2e-navegador.yml`,
   `codeql.yml`, `ci-postgres.yml`, `auto-merge-rutina.yml`** — no los abrí, por
   tercera ronda consecutiva.
6. **No corrí la compuerta completa** (`npm test`, `tsc`, `lint`). Corrí solo los
   tres archivos de `scripts/ci/` citados arriba y me apoyé en la línea base del
   `MAPA.md` (5 fallos de infra por `::1`). Si esa línea base se movió, mis
   lecturas de código siguen valiendo pero el veredicto de «suite verde» no es
   mío.
7. **No pude ejecutar la llamada RPC contra producción** para ver el texto
   literal del PGRST202 del CRÍTICO nº 2: no hay credenciales aquí y
   `/dashboard` está detrás de sesión. El escenario está construido con las dos
   mitades leídas (el `drop function` de la 0317 y el sitio de llamada en
   `4f94490`) más `base: "0347"` medido en el health.
