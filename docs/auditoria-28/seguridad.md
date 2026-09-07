# Seguridad — auditoría 28

**Nota: 7/10** (antes 8). Razón del movimiento: **mirada más profunda — el
código no cambió, la nota anterior estaba inflada**. No es que empeorara: es
que se vio mejor. Tres cosas lo sostienen, y ninguna es "encontré más
hallazgos":

1. **El ancla del rubro pone este repo en 7, y la nota 27 lo documentó y
   calificó 8 igual.** El texto es: *«8+ si toda ruta privilegiada tiene dos
   capas independientes … 7 si el diseño es correcto y las capas son una sola
   en algún punto»*. Abrí el matcher y la lista, no la cita: `src/proxy.ts:177`
   excluye `api` del matcher entero y `src/proxy.ts:123`
   (`RUTAS_CON_SESION = ['/dashboard','/admin','/vendedor']`) es todo lo que la
   primera capa cubre. Las **67** `route.ts` bajo `src/app/api` —incluidas
   `/api/export/pdf/[id]`, `/api/admin/*` y `/api/v1/*`, que entregan dinero de
   una flota— tienen **exactamente una** capa: la que cada handler escribe
   adentro. Las otras **5** `route.ts` fuera de `/api`
   (`src/app/pago/[token]/complemento/[uuid]/route.ts`,
   `src/app/auth/callback/route.ts` y las tres de `.well-known/`) tampoco están
   en `RUTAS_CON_SESION`. Eso es literalmente el caso que el rubro llama 7. La
   27 escribió esa misma frase en su propio encabezado («cada `route.ts` es su
   única capa») y puso 8.
2. **El ALTO abierto sigue vivo, palabra por palabra.** `qa-motor.ts:169` sigue
   reasignando `globalThis.fetch` del proceso; `wa-outbox/route.ts:145-157`
   sigue sellando como entregado cualquier cuerpo con un `messages[0].id` no
   vacío. Nadie lo tocó (la ventana son 3 commits de producto y ninguno cae
   aquí).
3. **El MEDIO del redactor es más ancho de lo que la 27 midió.** La 27 reportó
   **un** call site que emite un correo en claro. Buscando por clave y no por
   ruta aparece un **segundo**, en un agente que corre por cron
   (`investigador.ts:278`). La promesa de la cabecera de `logger.ts` —«lo que
   sale del sistema va anonimizado por una sola función»— falla en dos sitios,
   no en uno. Esa es evidencia nueva sobre código idéntico, que es exactamente
   la forma "mirada más profunda".

Lo que **sí** subió y no alcanza a compensar: `npm audit` corrió esta ronda
(la 27 lo dejó explícitamente sin veredicto) y da **0 vulnerabilidades**,
runtime y dev — `npm audit --omit=dev` y `npm audit` completo, 752
dependencias, `{info:0, low:0, moderate:0, high:0, critical:0}`. El rubro de
dependencias queda cerrado y verde. Y la superficie nueva de la ventana
(`prepare-build-env.mjs`) es, en lo que toca a *credenciales*, correcta: no
filtra el token de administración al hijo, valida ref y rol de cada JWT contra
el proyecto autorizado, y falla cerrado en siete puntos antes de tocar la red.

Riesgo mayor del rubro, hoy: una corrida de QA lanzada desde `/admin` sigue
parchando `globalThis.fetch` del proceso durante ~110 s, y en una instancia
reutilizada se traga los WhatsApp reales del cron que corre cada minuto
devolviendo un acuse falso que la base sella como entrega.

## Hallazgos

### [ALTO] Una corrida de QA parcha `globalThis.fetch` del proceso y se traga los WhatsApp de producción con un acuse falso — REINCIDENTE

`src/lib/admin/qa-motor.ts:167-201` (instalado en `:559` y `:966`;
`src/app/api/admin/qa/lanzar/route.ts:104-105` lo corre dentro de `after()`)

Escenario, verificado línea por línea otra vez esta ronda: Javier aprieta
«Lanzar corrida» en `/admin/qa`. `ejecutarCorridaRapida` corre en `after()` y
su primera línea útil es `qa-motor.ts:169`,
`globalThis.fetch = (async (input, init) => …)` — mutación **global del
proceso**, no del cliente Meta. `vercel.json:15-16` programa
`/api/cron/wa-outbox` con `"schedule": "* * * * *"` — cada minuto — y ese cron
envía con el `fetch` global: `wa-outbox/route.ts:130` hace
`fetch(\`${GRAPH}/${phoneId}/messages\`, { method: 'POST', … })` contra
`https://graph.facebook.com/v21.0`. Si esa invocación aterriza en la misma
instancia tibia que la corrida (reutilización que el propio repo afirma por
escrito en `likida/config.ts:250` para justificar OTRO arreglo de fuga entre
tenants), el interceptor:

1. inserta el payload REAL del cliente en `wa_outbox` con `estado: 'dead'` y
   `ultimo_error: 'QA: corrida <id> — interceptado…'` (`qa-motor.ts:187-191`);
2. devuelve un `Response` 200 sintético
   `{"messages":[{"id":"qa_<uuid>"}]}` (`qa-motor.ts:196-198`).

El cron lee ese cuerpo en `:144`, obtiene `id = 'qa_3f2a…'` y, como **no** está
vacío, se salta la rama defensiva de `:145-157` («sin wamid → dead + alerta») y
llama `finalizarYAvisarSiMurio(s, 'qa_3f2a…')`: la fila queda **sellada como
enviada** con un wamid que Meta nunca emitió. `enviadas++`. Ni el latido del
cron ni Sentry registran un fallo.

Entra: una corrida de QA de 110 s + un tick del cron en la misma instancia.
Sale: `wa_outbox` con la fila del cliente en `dead` y la fila original marcada
entregada con `qa_3f2a…`; el chofer sin su PDF de liquidación; `wa_meta_receipt`
sin acuse posible para ese id.

El mismo patrón afecta a `capturarBitacora()` (`qa-motor.ts:127-145`), que
reasigna `logger.info/warn/error` del módulo: durante esos 110 s los eventos de
peticiones concurrentes de flotas reales se acumulan en `bit.eventos`, se
persisten en `corrida.memoria.eventos` y se le enseñan a los oráculos de la
corrida.

Consecuencia: es el modo de falla del 28-jul-2026 que
`webhook/whatsapp/route.ts:473-487` documenta como «veinte minutos
reconstruyendo a mano», pero peor: esta vez la base afirma «entregado», así que
no queda ni el `wa.no_entregado` que aquel arreglo introdujo. Para el
contralor: liquidación cerrada, chofer que jura que no le llegó nada, y una
bitácora que le dice que sí.

Causa raíz probable: la contención de la corrida se implementó como estado
global mutable del proceso (`globalThis.fetch`, `logger.*`) en vez de
inyectarse por el borde del motor — el `Http` inyectable de
`conectores/tipos.ts:334` existe para exactamente este problema; el `finally`
restaura pero no acota la concurrencia mientras corre.

Caveat honesto, igual que en la 27: depende de que una invocación de
`wa-outbox` comparta instancia con la corrida. No es verificable desde este
contenedor (sin Vercel); se comprueba lanzando una corrida y mirando si
aparecen filas `wa_outbox` con `ultimo_error LIKE 'QA:%'` cuyo payload NO sea
del tenant sintético.

---

### [MEDIO] El texto de `search` del MCP entra crudo en la expresión `or=` de PostgREST: una coma rompe la búsqueda y reescribe el filtro — REINCIDENTE

`src/lib/mcp/herramientas/viajes.ts:103` (el saneador) y `:111` (el `.or(...)`)

Escenario: el contralor le pide a su Claude conectado por MCP «busca los viajes
a Monterrey, NL». El modelo llama `search({ query: "Monterrey, NL" })`.
`buscarViajesTexto` escapa **solo** `%`, `_` y `\`
(`.replace(/[%_\\]/g, (m) => \`\\${m}\`)`, `:103`) y concatena en `:111`:

```
or=(folio.ilike.%Monterrey, NL%,origen.ilike.%Monterrey, NL%,destino.ilike.%Monterrey, NL%)
```

PostgREST separa la lista de `or` por comas de primer nivel: el segundo término
es ` NL%`, que no es `columna.op.valor`. Contesta **400 PGRST100**;
`exigir(res, 'mcp.buscar_viajes')` lanza (`likida/pg.ts:34`) y
`api/mcp/route.ts:212-215` lo convierte en «No se pudo completar la consulta».
Entra `"Monterrey, NL"` → sale «Likida está fallando».

La otra mitad es reescritura del filtro, no solo ruptura: con
`query = "z,folio.not.is.null,origen.ilike.z"` los tres términos resultantes son
sintácticamente válidos y el `or` pasa a ser
`folio.ilike.%z OR folio.not.is.null OR …`, es decir **todos los viajes** en vez
de los que coinciden. El aislamiento entre flotas NO se rompe (el
`eq('tenant_id', …)` de `:110` es otro parámetro y se combina con AND; lo fija
`src/lib/mcp/aislamiento.test.ts:133-144`), pero lo que el modelo cita como «los
viajes que coinciden con tu búsqueda» ya no es lo que se pidió.

Consecuencia: el contralor pregunta por una plaza con coma —la forma normal de
escribir una plaza en México— y su asistente le contesta que el sistema falló; o
le devuelve una lista que no corresponde a la búsqueda y él la lee como verdad.
Es el rótulo-que-tiene-que-ser-verdad, en la superficie que se vende como
integración enterprise.

Causa raíz probable: el repo ya tiene la regla escrita y aplicada en dos sitios
—`sat_descarga/bandeja.ts:484` (`t.replace(/[%,()]/g, ' ')`) y
`api/v1/_comun.ts:449-458` / `revision.ts:159-167` (rechazan `["(),]` en el
cursor)— y este call site, el único alimentado por texto libre del modelo, se
quedó con el saneador de LIKE en vez del de la expresión `or`.

---

### [MEDIO] El redactor del logger no conoce el correo electrónico, y hay DOS call sites que lo emiten en claro hacia Sentry — REINCIDENTE (ampliado)

`src/app/api/webhook/calcom/route.ts:219` · **`src/lib/likida/agentes/investigador.ts:278` (nuevo esta ronda)** ·
`src/lib/logger.ts:72` (el catálogo `SENSIBLE`), `:100-108` (`redactarTexto`) y `:133-141` (`redactMeta`)

Escenario A (el de la 27, sigue intacto): un prospecto agenda el demo desde
Cal.com con `contralor@transportesinnovativos.mx` y en `prospecto` hay dos filas
vivas con ese `correo_normalizado` (posible: la 0327 crea un índice **no único**,
`0327_calcom_retencion_forward.sql:29-31`, y `route.ts:213-221` trata la
ambigüedad como estado esperado, con `limit(2)` para detectarla). Se ejecuta
`logger.warn('calcom.webhook.correo_ambiguo', { correo, coincidencias: 2 })`.

Escenario B (**el que la 27 no vio**): el agente investigador corre por cron
sobre el mapa de prospectos. `correosVerificados` descarta un correo que el
modelo extrajo pero que no aparece literalmente en ninguna página descargada y
emite `logger.warn('investigador.correo_descartado_sin_fuente_literal', { correo })`
(`investigador.ts:278`). El correo descartado es igualmente PII: o es real y la
compuerta lo tiró por encoding, o el modelo lo compuso a partir del nombre y
apellido reales de una persona.

En los dos casos `redactMeta` (`logger.ts:133`) pasa el objeto por `SENSIBLE`
(`logger.ts:72`), que solo alterna UUID · RFC · teléfono · CLABE · tarjeta. **No
hay regla de correo**, y un correo en minúsculas tampoco cae en el regex de RFC
(`^[A-ZÑ&]{3,4}\d{6}…`). Sale a stdout y, con `SENTRY_DSN` puesto, a Sentry
(`logger.ts:189-191`):

```
{"t":"…","level":"warn","msg":"calcom.webhook.correo_ambiguo",
 "meta":{"correo":"contralor@transportesinnovativos.mx","coincidencias":2}}
```

Consecuencia: un dato personal identificable de un prospecto sale del sistema
hacia un encargado externo por el único camino que la cabecera de
`logger.ts:1-8` promete que va anonimizado («así lo que sale del sistema va
anonimizado por una sola función y no por dos configuraciones»). El commit de la
ronda 27 que decía cerrar justo esto (`ec88509c`) cubrió el `msg` (`logger.ts:177`)
y no tocó el catálogo de reglas. El texto legal es de otro auditor; el control
técnico —el redactor— es lo que aquí no cubre la clase de dato.

Causa raíz probable: `SENSIBLE` enumera datos fiscales y patrimoniales
mexicanos; el correo, que es la llave del CRM y de todo el circuito de campaña,
nunca entró a la lista, y ningún test escanea los call sites por claves
`correo`/`email` — por eso el segundo call site llevaba abierto todo este tiempo
sin que nadie lo contara.

---

### [MEDIO] La redacción del único artefacto de diagnóstico del build lo vuelve ilegible: `CI=true` es un "secreto" y se borra de todo el log — NUEVO (superficie del PR #341)

`scripts/ci/prepare-build-env.mjs:18` (el filtro `value.length > 0`) ·
`:83-85` (el call site que le pasa `...Object.values(env)`) ·
`.github/workflows/deploy-preview-promote.yml:277-285` y `:388-396` (el artefacto)

Escenario, **ejecutado** contra la función exportada real (no leído):
`sanitizeBuildLog` construye su lista de secretos con
`knownValues.filter(value => typeof value === 'string' && value.length > 0)` —
sin longitud mínima— y el call site le pasa `...Object.values(env)`, o sea el
`process.env` completo del runner. Y el propio script **exige** `env.CI === 'true'`
en `:30`, así que la cadena `"true"` está garantizada en la lista de todas las
corridas. En un runner de GitHub también están `RUNNER_OS=Linux`,
`RUNNER_ARCH=X64`, `HOME=/home/runner`, `GITHUB_WORKSPACE=/home/runner/work/cuadra/cuadra`,
`LANG=C.UTF-8`, `NODE_OPTIONS=--max-old-space-size=6144` (lo pone el workflow en
`:380`), `VERCEL_CLI_VERSION=59.1.4` (`:65`) y `GITHUB_RUN_ATTEMPT=1` —una
variable por defecto de Actions cuyo valor es **un solo carácter**.

Entra el log de un `next build` que falla por un error de tipos. Sale esto
(salida literal de `node -e` sobre `scripts/ci/prepare-build-env.mjs`):

```
Failed to compile.

./src/app/dashboard/rentabilidad/vista.tsx:[REDACTED]4[REDACTED]:[REDACTED]2
Type error: Property 'margen' does not exist on type 'Fila'.

  [REDACTED]39 |   const total = filas.reduce((a, f) => a + f.margen, 0);
> [REDACTED]4[REDACTED] |   return <td>{f.margen}</td>;
Build error occurred (exit [REDACTED]) at [REDACTED]/node_modules/next/dist/build/index.js
```

Cada `1` del log desapareció (`GITHUB_RUN_ATTEMPT`), y con él el número de línea,
el número de columna y el exit code. Con la lista garantizada mínima
(`CI=true`) desaparecen además todos los `true` del log; con las de runner,
todos los `Linux`, `X64` y rutas absolutas. Y como `[REDACTED]` son 10
caracteres donde había 1, el `slice(-65_536)` de `:24` recorta bastante más
contexto del que el autor pensó.

Consecuencia: `deploy-preview-promote.yml:388-396` sube ese archivo como
`production-build-sanitized` (retención 3 días) **solo `if: failure()`** — es
decir, existe exclusivamente para el post-mortem de un build de producción que
se cayó, y es justo ahí donde no dice dónde. El equipo se queda sin el
diagnóstico del pipeline de release, o —peor— alguien concluye que la redacción
estorba y la quita, que es como se pierde la protección de verdad.

Causa raíz probable: el saneador confunde "valores que conozco" con "valores
secretos" y no filtra por longitud ni por lista de claves sensibles; y su
prueba lo esconde porque el `env` sintético de
`scripts/ci/prepare-build-env.test.ts:11` tiene **cinco** variables
(`NODE_ENV`, `CI`, y tres secretos largos) y el log de la aserción
(`:104-107`, `'Build failed …'`) no contiene ninguna de las cadenas cortas —
la única aserción del caso es `expect(log).toContain('Build failed')`.

No coincide con ninguno de los 12 PRs `codeql/lote-*` (#346-#357): los revisé
por título y ninguno toca `scripts/ci/`.

---

### [BAJO] El mecanismo que impide que la superficie de rutas crezca en silencio solo mira `src/app/api` — REINCIDENTE

`src/app/api/inventario_rutas.test.ts:57` (la constante) y `:60-64` (`rutasApi()`)

Escenario: `rutasApi()` hace `readdirSync(join(process.cwd(), 'src','app','api'))`
y compara contra `RUTAS_API_REVISADAS = 67`. Hoy hay **72** `route.ts` en
`src/app` y **67** bajo `src/app/api` (contados con
`find src/app -name route.ts | wc -l` y `find src/app/api …`): la constante
cuadra, y por eso la suite está verde — pero los **cinco** que quedan fuera del
escaneo nadie los cuenta: `src/app/pago/[token]/complemento/[uuid]/route.ts`
(público, autenticado solo por un token en el path),
`src/app/auth/callback/route.ts` y las tres de `.well-known/` (incluida
`.well-known/oauth-protected-resource/api/mcp/route.ts`, que **tiene `/api/` en
la ruta y aun así vive fuera de la raíz escaneada**). Si mañana alguien
agrega `src/app/reportes/[token]/route.ts`, la cuenta sigue en 67, la suite
sigue verde, y nadie hace la revisión consciente que la cabecera de este archivo
promete. `src/proxy.ts:177` tampoco los cubre: el matcher excluye `api` y
`RUTAS_CON_SESION` (`:123`) solo nombra `/dashboard`, `/admin` y `/vendedor`.

Consecuencia: el equipo que mantiene esto cree tener una contención completa de
la superficie sin autenticar y tiene una parcial. El daño no es hoy; es la
primera ruta pública que alguien ponga fuera de `/api`.

Causa raíz probable: el inventario se escribió cuando todos los handlers vivían
bajo `/api`, y los cinco de fuera (OAuth well-known, portal de pago) aparecieron
después sin que nadie ampliara la raíz del escaneo.

## Lo que revisé y está bien

**La superficie nueva de la ventana (`prepare-build-env.mjs`, +110 líneas), atacada:**

- **El token de administración no llega al hijo.** `:67-68`:
  `childEnv = { ...env, ...values }` y luego `delete childEnv[key]` para
  `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` y `SUPABASE_DB_URL`; la
  prueba lo ancla en `prepare-build-env.test.ts:29-30`. `vercel build` corre sin
  la llave que puede revelar credenciales de cualquier proyecto Supabase.
- **Las tres credenciales se validan contra el proyecto autorizado, no contra el
  que conteste.** `validateSupabaseEnv` (`production-candidate.mjs:16-31`)
  decodifica el payload de cada JWT y exige `payload.ref === expectedRef` **y**
  `payload.role === role`, con `expectedRef` sacado de constantes del repo
  (`STAGING_REF`/`PRODUCTION_REF`, `:13-14`), no del entorno. Se corre **dos
  veces**: sobre los valores recién traídos (`:60`) y sobre el archivo ya
  hidratado (`:73`). Una respuesta cruzada (anon de producción + service_role de
  staging) aborta antes del build — `prepare-build-env.test.ts:52-58`.
- **La máscara se hidrata; un valor real contrario NO se tapa.** `:63-66`: si
  `pulled[key]` no es `'[SENSITIVE]'` y difiere del valor traído, `PULLED_CONFLICT`;
  si `process.env` trae el key con otro valor, `PROCESS_CONFLICT` (`:65`). Es la
  diferencia entre "rellenar un hueco" y "pisar una decisión", y está del lado
  correcto.
- **Ninguna llave administrativa puede entrar por el archivo.** `:41`
  (`ADMIN_KEYS.some(key => pulled[key] !== undefined)` ⇒ aborta) y `:42-45`
  (cada uno de los tres KEYS tiene que aparecer **exactamente una vez**, con
  `^\s*(?:export\s+)?KEY\s*=` — la forma `export` también cuenta, así que no se
  puede colar un duplicado que el filtro deje pasar y `parseEnv` no vea; el
  mismo regex reconstruye el archivo en `:71`, así que filtro y validador no se
  pueden desincronizar).
- **El orden de las siete compuertas es el correcto:** target allowlisted + `CI`
  + token (`:30`) → `project.json` contra `PROJECT`/`TEAM` (`:36`) → `lstat`
  contra symlink (`:38`) → contenido del env (`:41-45`) → HTTP (`:47`) →
  validación de claves → conflicto → escritura. La red **no se toca** si algo
  anterior falla, y
  las pruebas lo comprueban con `expect(f.fetch).not.toHaveBeenCalled()`
  (`:70`, `:73`, `:86`, `:92`).
- **El error que sale nunca lleva contenido del proveedor.** `:99-101`: el
  `catch` final descarta el error real y lanza `BUILD_ENV_${stage}` con `stage`
  de un enum interno. Ni URL, ni cuerpo, ni stdout del hijo. Comprobado en
  `prepare-build-env.test.ts:75-79`: un `spawn` que lanza con el secreto como
  mensaje sale como `BUILD_ENV_BUILD` exacto (`/^BUILD_ENV_BUILD$/`).
- **La restauración es real.** El `finally` (`:92-97`) reescribe el archivo
  original en éxito y en fallo; cuatro aserciones lo verifican leyendo el
  archivo después (`prepare-build-env.test.ts:49`, `:57`, `:78`, `:109`).
  `chmodSync` (`:76`) antes de `writeFileSync`
  porque `mode` en `writeFileSync` no aplica a un archivo que ya existe — el
  autor lo sabía.
- **La salida del hijo no se imprime.** `stdio: 'pipe'` (`:81`, con
  `timeout: 1_200_000` y `maxBuffer: 64 MiB`): el log del
  build no llega al job log de Actions ni siquiera sin redactar; solo al archivo
  que el `if: failure()` sube. El único defecto del saneador es que redacta de
  MÁS, no de menos (ver el MEDIO).
- **El artefacto que se sube es solo el log.** `deploy-preview-promote.yml:282`
  y `:393` apuntan a `.vercel/build-*.sanitized.log`, no a `.vercel/`: el
  `.env.production.local` hidratado —que durante el build tiene el
  `SUPABASE_SERVICE_ROLE_KEY` de producción en claro con modo `0600`— no viaja a
  ningún artifact, y `vercel deploy --prebuilt` sube `.vercel/output`, no el
  archivo de entorno.

**Fronteras de confianza reabiertas y limpias:**

- `?tenant=` — reconté los call sites de `resolverTenantPedido`: son **14**,
  todos precedidos sin excepción por `s.rol === 'superadmin' && sp?.tenant`
  (verificados uno a uno: `dashboard/[id]/page.tsx:84,119,153,187,216,264`,
  `politicas/page.tsx:96-97`, `combustible-casetas/page.tsx:71-72`,
  `suscripcion/page.tsx:44-45`, `arco/page.tsx:68-70,99-101,132-134`).
  `resolverTenantApi` (`tenant-api.ts:74-91`) valida contra `tenant`, mira
  `error` explícitamente y contesta 503 en vez de caer al tenant de sesión.
- **Intenté y refuté un bypass del MFA de superadmin.**
  `guard.ts:53` exime la ruta de inscripción con
  `destino.startsWith('/dashboard/mi-perfil')`, y `destino` es user-influenced
  en un solo sitio: `dashboard/[id]/page.tsx:63`,
  `requireSessionTenant(\`/dashboard/${id}\`, sp)` con `id` del segmento
  dinámico. Un `id` de `mi-perfil%2Fx` sí salta el `exigirMfaSuperadmin`. **No
  es explotable:** lo único que la página hace con ese `id` es
  `getLiquidacionDetalle(id, tenantId)` (`:99`), que exige un uuid de
  liquidación — y ninguna cadena que empiece con `mi-perfil` lo es, así que la
  única página que la exención abre contesta `notFound()`. Las demás páginas
  pasan literales fijos. Queda como forma frágil, no como hallazgo.
- **RLS**, leída como *predicado* y no solo como `enable`/`revoke` (que es lo
  que midió la 27): las **73** `create policy` del repo. Cero `using (true)` /
  `with check (true)` en todo `supabase/migrations/`. El patrón es uniforme —
  `tenant_id = any(get_user_tenant_ids()) and not is_operador() or is_superadmin()`
  — y las tablas sin `tenant_id` propio resuelven por `exists` contra el padre
  en vez de duplicar la columna (`factura_viaje`, `0049:150-156`;
  `ticket_mensaje`, `0051:128-134`), que es justo donde nace la fuga cuando se
  copia. `bitacora_auditoria` es append-only por ausencia deliberada de policy
  de UPDATE/DELETE (`0053:195-200`). Las dos policies más abiertas que existen
  son `plan_lectura ... using (auth.uid() is not null)` (`0052:127-128`, expone
  el catálogo de precios de Likida a cualquier sesión — no hay dato de flota) y
  `avatares_lectura_publica` (`0046:43-45`, bucket de avatares con lectura
  pública y path anclado a `auth.uid()`): ninguna de las dos deja ver dato de
  otro tenant.
- **Dependencias — veredicto que la 27 dejó pendiente.** `npm audit --omit=dev
  --json` y `npm audit --json` completos, esta ronda, sobre el
  `package-lock.json` de la rama: `{"info":0,"low":0,"moderate":0,"high":0,
  "critical":0,"total":0}` sobre 752 dependencias (215 prod). Cero CVEs; no hay
  nada que descartar por falta de camino de explotación porque no hay nada.
- El portal de pago sin sesión — `pago/[token]/complemento/[uuid]/route.ts:36-88`:
  rate limit por IP antes de todo (`:36`), `resolverLiga(token)` resuelve el
  token **entero contra la base en cada petición** (no confía en que "venía de
  la página"), distingue `no_disponible` (503) de token inválido (404) para no
  afirmar un hecho falso, y `xmlDelRep(liga, uuid)` ancla al `factura_id` +
  `tenant_id` de la liga resuelta — el `uuid` del path elige cuál complemento de
  ESA factura, nunca el alcance. El `Content-Disposition` usa un uuid ya
  validado contra `rep_emitido_uuid_forma` (0228), así que no puede inyectar la
  cabecera.
- El bus de workers (`api/worker/bus/[accion]/route.ts:31-113`): capacidad por
  acción resuelta antes de leer el cuerpo (`:33-36`), cuerpo acotado por bytes
  (`:39`), tipos comprobados campo por campo (`:53-61`), base64 validado por
  round-trip (`:99`) y el path de storage armado por el SERVIDOR con el nombre
  saneado a `[^A-Za-z0-9._-]` y `..` neutralizado (`:104-105`). Queda el
  `contentType` que manda el worker (`:107`) sobre el único bucket sin
  `allowed_mime_types` — lo dejo abajo, en lo que no cerré, porque exige una
  llave `bus.pieza` válida y no llegué a comprobar quién firma URLs de ese
  bucket.
- `src/proxy.ts:100-176` — HSTS solo en producción, cookies de sesión con
  `httpOnly` repuesto sobre `options` en el camino que de verdad sale al
  navegador (`:148`), y el redirect a `/login` arrastra las cookies que el SDK
  pidió borrar (`:165-168`), que es lo que evitaba el bucle de refresh muerto.

## Lo que NO alcancé a revisar

- **`NEXT_PUBLIC_*` marcadas Sensitive en Vercel.** `prepare-build-env.mjs`
  hidrata **tres** claves y deja el resto del archivo tal cual, o sea con
  `[SENSITIVE]` literal. El repo usa dos `NEXT_PUBLIC_*` más —
  `NEXT_PUBLIC_APP_URL` y `NEXT_PUBLIC_SENTRY_DSN` — y esas se **inlinean en el
  bundle de cliente en build**: si alguna está marcada Sensitive en Vercel, el
  prebuilt sale con la cadena `[SENSITIVE]` horneada y el runtime ya no puede
  corregirla (con `NEXT_PUBLIC_APP_URL` eso es exactamente el modo de falla que
  CLAUDE.md describe: la cookie de login en otro dominio). No puedo verificar el
  flag Sensitive de esas dos variables desde aquí; se resuelve con un
  `vercel env ls` o mirando el panel.
- **El borde de Vercel con `x-forwarded-for`.** `ratelimit.ts:311` y
  `auth/reenvio_enlace.ts:91` toman el PRIMER elemento. Si el borde APPEND-ea en
  vez de sobrescribir, todo límite por IP (login, `/api/lead`, `/api/demo`,
  `mcp/oauth/token`) se evade rotando la cabecera. Abierto y sin verificar desde
  la 25; se cierra con un `curl -H 'x-forwarded-for: 1.2.3.4'` contra
  `/api/health` en producción, mirando qué llave se cuenta. No hay red a Vercel
  aquí.
- **Las policies de RLS corriendo contra Postgres real.** Esta ronda las leí
  como predicado (arriba), pero `supabase/verificaciones.sql` no se ejecutó: no
  hay base en este contenedor. Un `grant` implícito heredado de una migración
  vieja, o una policy que en la práctica no filtra por cómo se evalúa
  `get_user_tenant_ids()` en el rol real, no se ve desde el SQL.
- **`storage.objects` del bucket `bus`.** Sigue siendo el único bucket sin
  `file_size_limit` ni `allowed_mime_types` (contrastar `0147:112` para
  `avatares` y `0155:427` para `comprobantes`), y `worker/bus/[accion]/route.ts:107`
  sube con el `contentType` que manda el worker. Un `text/html` servido por URL
  firmada sería XSS en el origen de Storage — otro origen que el panel, y exige
  una llave `bus.pieza` válida. No perseguí quién firma esas URLs ni si alguna
  pantalla las embebe.
- **La ejecución real del pipeline de `deploy-preview-promote.yml`.** Leí el
  workflow y el script; no puedo correr el job, así que el orden real de
  variables en el runner (y por tanto el alcance exacto de la sobre-redacción)
  está inferido de las variables por defecto documentadas de Actions y de las
  que el propio workflow declara, no observado.
- **El pipeline del OCR y del LLM como frontera** (`intake/`, `agents/`): lo
  miré solo desde el gateo de las rutas. La inyección de prompt y el contenido
  que vuelve del modelo son del auditor agéntico y de tool calling.
