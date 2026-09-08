# Seguridad — auditoría 29

**Nota: 7/10** (antes 7). Razón del movimiento: **se atacó y subió, y la deuda
del mismo módulo cobró factura — se compensan exactamente**, y el ancla
estructural del rubro no se movió ni un milímetro.

Las tres piezas del cálculo, medidas hoy y no recordadas:

1. **Cuatro de los cinco hallazgos abiertos de la 28 están CERRADOS de verdad**,
   verificados abriendo el archivo y la prueba y preguntando si la prueba
   fallaría con el arreglo revertido (SEG-M1, SEG-M2, SEG-M3, SEG-B1; el
   detalle, abajo). SEG-M3 lo verifiqué **ejecutando** la función real, no
   leyéndola. Eso solo empuja a 8.
2. **El ancla del rubro sigue diciendo 7 y sigue siendo literalmente este
   repo.** `src/proxy.ts:177` sigue excluyendo `api` del matcher entero y
   `src/proxy.ts:123` (`RUTAS_CON_SESION = ['/dashboard','/admin','/vendedor']`)
   sigue siendo todo lo que la primera capa cubre. Conté hoy con
   `find src/app -name route.ts`: **72** `route.ts`, **67** bajo `src/app/api`
   y **5** fuera. La ventana **no agregó ni quitó ninguna** (la cifra de 67 de
   la 28 no envejeció). Las 72 tienen **exactamente una** capa: la que cada
   handler escribe adentro. `inventario_rutas.test.ts:26-28` lo dice con todas
   sus letras — «Esta prueba NO agrega una segunda capa de gate». Un mecanismo
   de contención no es una capa.
3. **El módulo que cerró el ALTO de la 28 produjo un ALTO nuevo, y la causa raíz
   que la 28 nombró sobrevivió intacta.** La 28 escribió: «la contención de la
   corrida se implementó como estado global mutable del proceso
   (`globalThis.fetch`, `logger.*`) en vez de inyectarse por el borde del
   motor». El arreglo (`59ab4e2`) le puso un guardia de `AsyncLocalStorage` al
   interceptor y cerró el escenario que la 28 nombró — pero **dejó el estado
   global mutable exactamente donde estaba**, y ahora falla por el otro lado:
   dos corridas de QA solapadas se desinstalan el interceptor la una a la otra.
   El MAPA de esta ronda es explícito sobre cómo se dictamina esto: «Un arreglo
   que cierra el síntoma y deja la causa raíz es un hallazgo nuevo, no un
   cierre».

Lo que **no** cambia la nota pero sí la confianza: **busqué activamente el caso
de «4 o menos» —un camino de acceso sin autenticar a datos de un tenant— sobre
cinco superficies enteras y no existe.** Las 72 rutas (una por una, con su
puerta identificada), las **169** acciones `'use server'` inline más los 3
archivos con la directiva a nivel de módulo, las **152** tablas de
`supabase/migrations` (cero sin `enable row level security`), las **219**
funciones y sus `grant`/`revoke`, y el servidor OAuth completo del MCP. El
detalle está abajo; incluye **una hipótesis de fuga que construí y refuté yo
mismo con la evidencia del propio repo**.

**Riesgo mayor del rubro, hoy:** dos corridas de QA que se solapan en la misma
instancia tibia se apagan el interceptor de salida a Meta la una a la otra, y
la que sigue viva manda sus WhatsApp **de verdad** a `graph.facebook.com` con
el token real — que es exactamente el desastre que el interceptor existe para
impedir, ahora sin ninguna prueba que lo mire.

---

## Estado de los hallazgos abiertos de la 28

| # | Hallazgo de la 28 | Dictamen |
|---|---|---|
| ALTO | QA parcha `globalThis.fetch` y se traga los WhatsApp de producción | **CERRADO el escenario · MUTADA la causa raíz** → SEG-A1 nuevo |
| MEDIO | El `search` del MCP entra crudo en la expresión `or=` de PostgREST | **CERRADO** |
| MEDIO | El redactor del logger no conoce el correo (dos call sites) | **CERRADO** |
| MEDIO | `sanitizeBuildLog` redacta `CI=true` y borra números de línea | **CERRADO** (verificado ejecutando) |
| BAJO | El inventario de rutas solo mira `src/app/api` | **CERRADO** |

### ALTO — el interceptor de QA · CERRADO el escenario, MUTADA la causa raíz

`59ab4e2` hizo dos cosas y las dos son reales:

- `qa-motor.ts:144` declara `contextoQa` (`AsyncLocalStorage`) y `:196` es el
  guardia: `if (contextoQa.getStore()?.corridaId !== corridaId) return original(input, init)`.
  **Lo probé con un servidor HTTP real** (Node v22, dos peticiones concurrentes
  al mismo proceso, una entrando al contexto y otra no): la petición
  independiente ve `getStore() === undefined` en las tres corridas. El cron
  real llegando a la instancia tibia **ya no se intercepta**. Revertir `:196`
  pone en rojo `qa-motor.test.ts:831` y `:854`: la prueba muerde.
- Defensa en profundidad en `wa-outbox/route.ts:146-151`: un `id` con prefijo
  `qa_` se degrada a `sin_wamid` y **nunca** se sella como entrega. Anclada en
  `wa-outbox/route.test.ts:139-148`. Es una segunda capa independiente de
  verdad, y es lo que impide que el fallo sea silencioso aunque el aislamiento
  falle.

Pero la causa raíz que la 28 nombró —«estado global mutable del proceso… en vez
de inyectarse por el borde del motor»— **no se tocó**: `qa-motor.ts:191` sigue
haciendo `const original = globalThis.fetch` y `:227` sigue devolviendo
`() => { globalThis.fetch = original; }`. Con **una** corrida eso basta; con
**dos**, no. Ver SEG-A1.

### MEDIO — el `or=` de PostgREST · CERRADO

`mcp/herramientas/viajes.ts:108-110`: el saneador ahora es
`.slice(0, 80).replace(/[,()]/g, ' ').replace(/[%_\\]/g, m => \`\\${m}\`)`. Los
metacaracteres del `or` mueren **antes** de escapar los del `ILIKE`, que es el
orden correcto (al revés, el `\` inyectado volvería a entrar). Los dos
escenarios de la 28 se reescriben hoy y ninguno sirve: `"Monterrey, NL"` →
`"Monterrey  NL"` (un solo término, 200 y resultados), y
`"z,folio.not.is.null,origen.ilike.z"` → `"z folio.not.is.null origen.ilike.z"`,
un único `ilike` que no casa con nada en vez de un `or` de tres patas.
`viajes.test.ts` pasa 22/22. Revertir `.replace(/[,()]/g, ' ')` rompe las
pruebas del caso con coma.

### MEDIO — el correo en claro hacia Sentry · CERRADO

`logger.ts:71` agrega la regla `EMAIL` al catálogo `SENSIBLE` (`:80`) y
`:112` la resuelve **primero**, antes que UUID y RFC, con la razón escrita (un
dominio con guión también cumple `includes('-')`). Los **dos** call sites que
la 28 encontró —`calcom_webhook.ts:238` (heredado de `route.ts:219`) e
`investigador.ts:278`— pasan por `redactMeta` (`:148`) y salen como
`[EMAIL]`. `emit()` (`:191`) redacta **también** el `msg`, así que el camino a
Sentry (`:189-191` de la 28) está cubierto por la misma función. Probé el regex
contra seis formas reales (`contralor@transportesinnovativos.mx`, `+alias`,
subdominios, mayúsculas, TLD `.com.mx`): redacta las seis. Único hueco residual,
y no lo reporto porque no es un dato de negocio de este producto:
`usuario@localhost` (sin TLD) se cuela.

### MEDIO — la sobre-redacción del log de build · CERRADO, verificado ejecutando

`9c3ed2f` mete `MIN_REDACTABLE_SECRET_LENGTH = 8` (`prepare-build-env.mjs:23`) y
el filtro pasa a `value.length >= MIN_REDACTABLE_SECRET_LENGTH` (`:27`).
**Ejecuté `sanitizeBuildLog` real** con el `env` sintético del runner (`CI=true`,
`RUNNER_OS=Linux`, `RUNNER_ARCH=X64`, `GITHUB_RUN_ATTEMPT=1`, `LANG=C.UTF-8`,
`HOME`, `GITHUB_WORKSPACE`, `NODE_OPTIONS`, `VERCEL_CLI_VERSION` y un
service_role largo) sobre el mismo log de ejemplo de la 28. Salida literal:

```
./src/app/dashboard/rentabilidad/vista.tsx:41:12
Build error occurred (exit 1) at [REDACTED]/node_modules/next/dist/build/index.js
service_role usado: [REDACTED]
```

El número de línea, la columna y el exit code **sobreviven**; el secreto real
muere. Además `:28` cubre ahora las formas codificadas del secreto
(`encodeURIComponent` y el escape JSON), que la versión anterior no miraba.
Queda `GITHUB_WORKSPACE` redactado (12+ caracteres) — el prefijo de la ruta
absoluta desaparece pero el resto de la línea se lee, así que el daño que el
hallazgo describía ya no existe.

### BAJO — el inventario de rutas · CERRADO

`inventario_rutas.test.ts:98-103` escanea `join(process.cwd(),'src','app')` con
`readdirSync(..., { recursive: true })` y compara contra
`RUTAS_APP_REVISADAS = 72` (`:90`), que es exactamente lo que devuelve
`find src/app -name route.ts | wc -l` hoy. Las cinco que quedaban fuera
(`auth/callback`, las tres de `.well-known/` y `pago/[token]/complemento/[uuid]`)
están enumeradas con su puerta justificada una por una en `:47-73`. Si mañana
alguien pone `src/app/reportes/[token]/route.ts`, el conteo da 73 y la suite se
pone roja. Revertir la raíz del escaneo a `src/app/api` deja la constante en 72
contra 67 encontradas → también rojo. La prueba muerde en las dos direcciones.

---

## Hallazgos

### SEG-C1 — no hay

No encontré ningún CRÍTICO. Lo digo por escrito porque lo busqué en serio y en
las superficies donde vive: ninguna de las 72 rutas, ninguna de las 169
acciones de servidor, ninguna de las 152 tablas y ninguna de las 219 funciones
abre un camino sin autenticar a datos de un tenant. El detalle de cómo lo medí
está en «Lo que revisé y está bien».

---

### [ALTO] Dos corridas de QA solapadas se desinstalan el interceptor de salida a Meta la una a la otra, y la que sigue viva manda WhatsApp reales — NUEVO

`src/lib/admin/qa-motor.ts:191` (`const original = globalThis.fetch`) y `:227`
(`return () => { globalThis.fetch = original; }`) · instalado en `:629`
(`ejecutarCorridaRapida`) y `:1038` (`ejecutarPasada`) · restaurado en `:910` y
`:1605` · `src/app/api/admin/qa/lanzar/route.ts:104` (`after`, `maxDuration` 120)
y `src/app/api/admin/qa/[id]/continuar/route.ts:53` (`maxDuration` 300)

`instalarInterceptorSalidaMeta` captura el `fetch` que había al instalarse y lo
repone al terminar. Eso es correcto para **una** instalación y está roto para
dos: el restaurador no comprueba que el `globalThis.fetch` actual siga siendo el
suyo, así que el primero en terminar pisa al segundo. Y **nada impide dos
corridas vivas a la vez**: `lanzar/route.ts` valida origen (`:38`), sesión
superadmin con MFA (`:43`), tope de dinero del día (`:64`) y banco de fotos
(`:74`) — pero no pregunta jamás si ya hay una corrida corriendo.
`tomarPasada`/`soltarPasada` (`qa-storage.ts:983`, `:1018`) arbitran la carrera
**dentro de una misma `corridaId`**, no entre corridas distintas. Y
`lanzar-form.tsx:337` deshabilita el botón solo mientras el POST está en vuelo
(`lanzando`), no mientras una corrida vive — que es justo la trampa que ese
mismo archivo advierte 40 líneas antes: «la restricción de interfaz no es el
candado» (`lanzar/route.ts:63`).

**Escenario, con valores:**

- `t=0` — Javier aprieta «Lanzar corrida» sobre el escenario A, carril
  `rapido`. `after()` (`lanzar/route.ts:104`) corre `ejecutarCorridaRapida`,
  que en `:629` instala **interceptorA** capturando `originalA = realFetch`.
  Techo: `TECHO_CORRIDA_MS = 110_000` (`qa-motor.ts:75`).
- `t=5 s` — en la misma pantalla aprieta «Continuar» sobre la corrida B, carril
  `completo`. `POST /api/admin/qa/<B>/continuar` corre `ejecutarPasada`, que en
  `:1038` instala **interceptorB** capturando `originalB = interceptorA`.
  Techo: `maxDuration = 300`.
- `t=110 s` — A se acaba y su `finally` (`:910`) llama `restaurarFetch()`:
  `globalThis.fetch = originalA = realFetch`. **El interceptor de B queda
  desinstalado con B viva otros ~190 s.**
- `t=110…300 s` — cada respuesta que `processInbound` genera para B sale por
  `fetch` sin interceptar: `POST https://graph.facebook.com/v21.0/<WHATSAPP_PHONE_NUMBER_ID>/messages`
  con el `WHATSAPP_ACCESS_TOKEN` real y `to: "5215559900001"` (el número
  sintético que siembra `sembrarChofer`). **Cero filas** nuevas en `wa_outbox`
  con `estado='dead'` y `ultimo_error LIKE 'QA:%'` para esos envíos.
- `t≈300 s` — B se acaba y su `finally` (`:1605`) hace
  `globalThis.fetch = originalB = interceptorA`: la instancia queda vestida con
  el interceptor de una corrida terminada, permanentemente. (Gracias al guardia
  ALS de `:196` ese zombi reenvía todo a `realFetch`, así que no corrompe nada
  — pero es un closure que ya no se puede quitar, y cada par de corridas
  solapadas añade una capa más.)

Lo verifiqué con el modelo exacto de las tres líneas (captura, reasigna,
restaura a lo capturado). Salida:

```
t=0   fetch global = interceptor(B) sobre [interceptor(A) sobre [fetch REAL]]
t=110 fetch global = fetch REAL              <-- B sigue viva 190 s más
t=300 fetch global = interceptor(A) sobre [fetch REAL]
```

**Consecuencia.** Es el modo de falla que la cabecera de
`instalarInterceptorSalidaMeta` (`qa-motor.ts:178-182`) declara como su razón de
existir: «la ÚNICA barrera era que el número de PRUEBA de Meta rechazara al
destinatario sintético (#131030). En cuanto la WABA del piloto pase a
producción esa barrera desaparece y cada corrida intenta mandar WhatsApp de
verdad a números `5215559…`». Hoy, con la WABA todavía en modo prueba, el daño
es que la corrida B queda **sin evidencia**: los oráculos leen `wa_outbox`
buscando las filas `QA:` que nunca se escribieron y juzgan una corrida que
gastó dinero de modelo contra una base incompleta, sin que nada avise. El día
que la WABA pase a producción —el día del piloto— el mismo par de clics manda
WhatsApp reales, contra la calidad de la WABA de la que depende el producto
entero.

**Por qué no lo vio nadie.** Las nueve pruebas del interceptor
(`qa-motor.test.ts:797-880`) instalan **un solo** interceptor cada una. La que
se llama «SEG-A1: **dos corridas** con contextoQa distinto no se cruzan»
(`:854`) instala únicamente `instalarInterceptorSalidaMeta('corrida-A')` y luego
cambia de **contexto** — nunca instala el segundo interceptor. El nombre promete
la cobertura del caso de dos corridas y la prueba cubre otra cosa; es
exactamente por eso que este ALTO sobrevivió al commit que decía cerrar SEG-A1.

**Causa raíz probable:** la contención sigue siendo estado global mutable del
proceso con restauración LIFO por captura, y no hay ningún candado —ni en la
ruta ni en la base— que limite a una corrida viva por instancia; el guardia de
`AsyncLocalStorage` resolvió *quién* se intercepta pero no *cuántos parches*
pueden estar apilados sobre `globalThis` a la vez.

---

### [MEDIO] El aislamiento de la corrida entra con `enterWith`, pero las nueve pruebas que lo certifican usan `run` — una garantía distinta y medible

`src/lib/admin/qa-motor.ts:627` y `:1036` (`contextoQa.enterWith({ corridaId })`)
· `:193` (el comentario que dice `contextoQa.run`) ·
`src/lib/admin/qa-motor.test.ts:804`, `:863`, `:870`, `:886`, `:907`, `:920`,
`:935`, `:952` (todas `contextoQa.run(...)`)

El código de producción **nunca** llama `contextoQa.run`. Llama `enterWith`, en
`:627` y `:1036`. El comentario del propio guardia (`:193`) dice «una invocación
concurrente que no entró a `contextoQa.run` de ESTA corrida», y las **ocho**
llamadas a `contextoQa` que hay en la suite son `run`. La suite prueba, con
rigor, una propiedad del mecanismo que la producción no usa.

No son intercambiables, y la diferencia se mide. La corrí en Node v22.22.2:

```
1) sibling awaited desde el mismo Promise.all  -> { id: 'A' }   ← ve la tienda ajena
2) el llamador después de await               -> { id: 'A' }   ← la tienda sobrevive al retorno
```

Con `run(store, fn)` los dos dan `undefined`: el contexto se abre y se cierra.
`enterWith` **no se puede cerrar** —persiste hasta el final de la cadena async,
más allá del `finally` que restaura los parches (`:908-910`, `:1603-1605`)— y se
propaga a hermanos esperados desde el mismo `Promise.all`.

**Escenario, con valores.** Hoy no es explotable y lo digo antes de la
consecuencia: monté un servidor HTTP real con el patrón exacto (un handler que
hace `await`, luego `enterWith({corridaId:'QA-1'})`, y sigue vivo 300 ms;
peticiones independientes llegando en medio) y las peticiones independientes ven
`store: null` en las tres. **El escenario del cron real está cerrado.** Lo que
la asimetría cambia es el margen: el día que `/api/admin/qa/lanzar` registre un
segundo `after()` —o que un `after()` de otra parte del código corra en el mismo
`Promise.all` que el de la corrida— ese callback verá `getStore().corridaId ===
'<id de la corrida>'` y quedará dentro del contexto de QA sin haber entrado
nunca. Si ese callback manda un WhatsApp, se lo traga el interceptor y recibe
`{"messages":[{"id":"qa_<uuid>"}]}`. Y ninguna prueba lo detectaría, porque
ninguna prueba usa `enterWith`.

**Consecuencia.** El repo cree tener una garantía verificada (`AsyncLocalStorage`
acota el parche) y tiene dos cosas distintas: un guardia verificado (`:196`, y sí
muerde) y un mecanismo de entrada no verificado. Es el mismo patrón que produjo
el ALTO de arriba: la prueba mira una parte y el nombre promete el todo.

**Causa raíz probable:** `enterWith` se eligió porque `ejecutarCorridaRapida` y
`ejecutarPasada` son funciones largas con el cuerpo ya escrito y envolverlo en
`run(store, async () => { … })` exigía re-indentar 300 líneas; el comentario se
escribió describiendo `run` (la API que se tenía en la cabeza) y las pruebas se
escribieron contra el comentario, no contra el código.

---

### [BAJO] La captura de bitácora tiene el mismo defecto LIFO, y le corta la evidencia a la corrida que sigue viva

`src/lib/admin/qa-motor.ts:150-166` (`capturarBitacora`: `:152` captura
`originales`, `:162-164` los repone) · instalada en `:628` y `:1037`,
restaurada en `:909` y `:1604`

Mismo mecanismo que SEG-A1 sobre otro objeto: `capturarBitacora` guarda
`{ info, warn, error }` del `logger` de módulo y los repone tal cual. Con las
dos corridas solapadas del escenario de SEG-A1:

- A envuelve: `logger.warn = wrapperA` (con `originalWarnA` = el real).
- B envuelve: `logger.warn = wrapperB` (con `originalWarnB` = `wrapperA`).
- `t=110 s`, A termina (`:909`): `logger.warn = originalWarnA` = el real.
  **A partir de aquí `bit.eventos` de B deja de recibir nada**, con B viva otros
  190 s.
- `t≈300 s`, B termina (`:1604`): `logger.warn = originalWarnB = wrapperA`. El
  logger de módulo queda envuelto para siempre por el wrapper de una corrida
  terminada. (No acumula: `:155` compara `getStore()?.corridaId === corridaId`
  y el id de A ya no aparece nunca, así que el array no crece — pero el wrapper
  no se puede desinstalar.)

**Consecuencia.** `corrida.memoria.eventos` de B se corta a la mitad sin decirlo,
y esa es la evidencia que se le enseña a los oráculos y la que Javier lee cuando
una corrida falla. Una corrida que salió mal después del minuto 110 se ve como
una corrida que no registró nada, que es el peor estado: no dice «me quedé
ciego», dice «no pasó nada». No afecta a ningún cliente —la bitácora de QA es
interna— por eso es BAJO y no ALTO.

**Causa raíz probable:** la misma que SEG-A1; `capturarBitacora` y
`instalarInterceptorSalidaMeta` se escribieron con el mismo patrón («instala,
corre, `restaurar()` en el `finally`», dicho así en `:177-179`) y heredan el
mismo supuesto de que solo hay una corrida viva.

---

## CVEs revisados y descartados por escrito

**No hay ninguno que descartar, porque no hay ninguno.** Corrí `npm audit` yo
mismo esta ronda, las dos formas, sobre el `package-lock.json` de
`claude/auditoria-29`:

```
npm audit --json            → {"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}
npm audit --omit=dev --json → {"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}
dependencias: 751 total (215 prod, 415 dev, 161 optional, 43 peer)
```

Son 751 y no 752 como en la 28: una dependencia menos, cero avisos. **No hay un
solo CVE con o sin camino de explotación**, así que la sección de «descartar por
escrito» no tiene sujeto. El rubro de dependencias queda verde y no consumió
más tiempo del que costó medirlo.

Lo que **sí** descarto por escrito, porque lo construí como hipótesis de fuga y
lo refuté con evidencia del propio repo, está en la sección siguiente
(«el GRANT implícito de Supabase»).

---

## Lo que revisé y está bien

### El webhook nuevo de Cal.com — la frontera de confianza que nadie había auditado

`src/lib/admin/calcom_webhook.ts` (+242, nuevo) es una frontera de confianza
correcta en las cuatro cosas que importan:

- **Firma antes que nada.** `:137` corta con 503 si
  `secretoCalcomConfigurado(config.webhookSecret)` no pasa —*fail closed* ante un
  secreto ausente, no «si no hay secreto, confía»—, y `:152` verifica antes de
  `JSON.parse` (`:158`). `verificarFirmaCalcom` (`calcom.ts:78-84`) hace
  HMAC-SHA256 sobre el cuerpo **crudo**, valida la forma
  (`/^[a-f0-9]{64}$/`) antes de convertir a Buffer —sin eso `timingSafeEqual`
  lanzaría por longitud desigual y el 500 filtraría el largo— y compara con
  `timingSafeEqual`. El secreto exige `secretoEntornoSeguro` (`env.ts:62-66`):
  ≥32 caracteres y ≥10 distintos, y `valorEntornoReal` (`:55`) rechaza el
  marcador `[SENSITIVE]` y las plantillas sin llenar.
- **Límite de cuerpo aplicado en la lectura, no en la cabecera.** `:26`
  (`MAX_BODY = 256 KiB`) + `:140` (`leerTextoAcotado`). `cuerpo_acotado.ts:29-38`
  cuenta bytes **durante** el streaming y hace `lector.cancel()` al pasarse: un
  `Transfer-Encoding: chunked` sin `content-length` no materializa nada. Anclado
  en `webhook/calcom/route.test.ts:105-124` («un body chunked excesivo se corta
  durante la lectura, antes de verificar firma o tocar CRM») y `:349-353`.
- **El reloj sale del sobre firmado.** `:128-130` solo acepta `evt.createdAt`,
  nunca `startTime` ni un reloj local, y `:167` rechaza con 400 antes del lookup
  y de la RPC — así no quedan efectos parciales de un evento sin orden.
- **La entrega local pasa por el MISMO handler.** `calcom.ts:497` fabrica el
  `Request` con su HMAC calculado con el mismo secreto y llama
  `procesarWebhookCalcom` — no un atajo que repita la validación a mano.
  `calcom_webhook.test.ts:115` ancla que `route.ts` re-exporta **exactamente** esa
  función como `POST`, sin envoltura que pueda divergir. La ruta plural
  `api/webhooks/calcom/route.ts` re-exporta el mismo `POST` y **redeclara**
  `runtime`/`dynamic` literalmente (Next no los reconoce re-exportados) — el
  autor lo sabía y lo escribió.
- El correo ambiguo (`:238`) sale ya redactado como `[EMAIL]` — ver SEG-M2
  arriba. Y `route.ts` bajó de 225 a 10 líneas sin perder ninguna comprobación:
  las 18 pruebas de `route.test.ts` siguen ahí y siguen pasando.

Lo único que le falta es un `rateLimit` (todas las demás rutas públicas lo
traen). No lo reporto: la firma se verifica antes de tocar la base y el cuerpo
está acotado a 256 KiB, así que el costo de una ráfaga sin firma es un HMAC —
no hay escenario con valores que escribir.

### El aislamiento entre flotas, atacado por las cinco superficies

- **Las 72 rutas, una por una.** Escaneé `src/app` completo y clasifiqué cada
  `route.ts` por su puerta. Las **6** familias de `/api/admin/*` pasan por
  `sesionSuperadmin` (`lib/auth/api-superadmin.ts:37-45`), que es sesión **+
  rol + veredicto de MFA** (`rechazoMfaSuperadminApi`, `:30`) y contesta 401/403
  sin cuerpo; los tres `puerta.ts` (`copiloto`, `mapa-prospectos`, `qa`) ya no
  son copias, son un `export { sesionSuperadmin } from '@/lib/auth/api-superadmin'`
  de una línea. Los **12** crons pasan por `puertaCron` (`admin/salud.ts:80-97`):
  sin `CRON_SECRET` responden 500 **con alerta al operador** en vez de correr, y
  con secreto comparan en tiempo constante sobre digests SHA-256 del header
  completo (`auth/cron.ts:44-48`) para que ni el largo sea observable. Las dos
  colas (`facturar/cola`, `wa-pendientes/cola`) verifican firma de QStash con
  las dos signing keys y acotan el cuerpo antes de firmar
  (`facturar/cola/route.ts:35-58`). `/api/v1/*` va por `abrir()`; `/api/export/*`
  por `resolverTenantApi` + `puedeVerArea` + `puedeExportar`; `/api/demo`,
  `/api/lead`, `/api/marketing/*` y `/api/client-error` traen rate limit por IP
  y tope de cuerpo antes de leer nada.
- **Las 169 acciones `'use server'` inline (más 3 archivos a nivel de módulo).**
  Es la superficie que el inventario de rutas **no** cubre y que el matcher de
  `proxy.ts` **no puede** cubrir: una server action se invoca por POST contra
  cualquier ruta con su `Next-Action`, así que el gate de `/admin` en el
  middleware no la protege. Las escaneé todas y revisé a mano las 30 que mi
  detector no resolvió. **Todas re-gatean.** No es accidente, es doctrina
  escrita: `dashboard/agentes/peajes/page.tsx:137` («EL CHEQUEO SE REPITE
  ADENTRO (patrón del repo): POST directo posible»),
  `mapa-prospectos/acciones-exportar.ts:15` («la acción es un endpoint público
  en la práctica»), `llaves-api/page.tsx:36-39` («una server action es un
  endpoint alcanzable por POST directo… el `tenantId` va por CLOSURE desde la
  sesión re-resuelta: nada del formulario decide de quién es la llave»). Los
  tres archivos a nivel de módulo —los más expuestos, porque toman argumentos
  planos— van por `ejecutarComoSuperadmin` con rol **y** MFA
  (`admin/crecimiento/acciones.ts:11-22`, `admin/vendedores/acciones.ts:36-56`) o
  por `requireSuperadmin` (`acciones-exportar.ts:41`). Y `acciones-exportar.ts:33-38`
  además acota a 15 llaves conocidas lo que entra a `bitacora_auditoria`.
- **Las 152 tablas.** Parseé todas las migraciones, incluidos los bucles `DO`
  con `execute format(...)` que mi primer barrido no vio (`0001:112` cubre
  siete tablas, `0047:160-176` cubre cuatro). Resultado: **cero tablas sin
  `enable row level security`**. Importa exactamente porque el default del
  proyecto Supabase concede `select/insert/update/delete` a `anon` y
  `authenticated` sobre toda tabla nueva —lo que el propio repo dejó medido en
  `verificaciones.sql:1145-1147`, «8 grants… porque es el default del
  proyecto»—: sin RLS, la anon key que viaja en el bundle del navegador lee la
  tabla entera.
- **La única vista del repo.** `factura_saldo` es la única `create view` que
  existe, y lleva `security_invoker = true` puesto **dos veces**: en `0054:42`
  y otra vez en `0161:104` y `:131`, con la advertencia de por qué
  (`0161:92`: «`create or replace view` SIN la cláusula RESETEA las reloptions»).
  Una vista sin `security_invoker` se evalúa con los permisos del dueño y salta
  la RLS de las tablas base; el repo ya lo pisó una vez y lo dejó documentado
  con la medición («via-tabla=1, via-vista=2»).
- **El servidor OAuth del MCP.** PKCE S256 **obligatorio** y verificado
  (`mcp/oauth.ts:341-346`, con el rango 43-128 del verifier); código de un solo
  uso marcado con la condición **en la base** (`:352-357`, `.is('usado_en', null)`),
  y su reuso **tumba la familia entera** (`:334-337`); `redirect_uri` comparada
  exacta con la excepción de puerto solo para loopback (`:106-123`, RFC 8252
  §7.3) y re-verificada en el server action (`autorizar/page.tsx:183`);
  `resource` validada contra el canónico en los dos lados; la identidad
  **releída de la sesión en el momento de firmar** (`:177-181`) y no del render;
  el superadmin **excluido a propósito** del flujo (`:154`) porque su sesión
  cruza tenants; y el consentimiento anotado en `bitacora_auditoria` (`:212-223`).
  La pantalla incluso dice que el nombre del cliente «lo declaró quien se
  registró, no Likida» (`:242`) — que es la mitigación correcta de un registro
  dinámico abierto.

### El GRANT implícito de Supabase — hipótesis construida y REFUTADA

Construí esta hipótesis de fuga y la escribo aunque no prosperó, porque es
justo el caso que el rubro nombra: Supabase instala
`alter default privileges in schema public grant all on functions to postgres,
anon, authenticated, service_role`, así que un `revoke execute … from public`
**no** quitaría el grant explícito a `anon`. Y hay tres funciones que revocan
solo de `public`: `try_lock_viaje`, `unlock_viaje` y `wa_orden_evento`
(`0280:90-93`, `:115-116`) — mientras el mismo archivo, 40 líneas después,
revoca `listar_wa_pendientes` `from public, anon, authenticated` (`:158`).

**Se refuta con la medición del propio repo.** `verificaciones.sql:22` guarda la
salida REAL del bloque 16 del 31-jul-2026 contra el proyecto Likida:
`anon-lock=f  anon-unlock=f`. En esa fecha el bloque interrogaba la firma
**vieja** `try_lock_viaje(uuid,integer)`, que la `0012:13` había revocado
**solo de `public`** — y aun así `has_function_privilege('anon', …)` dio
**false**. O sea: en este proyecto el `revoke from public` **sí** basta para
funciones, y el comentario de `verificaciones.sql:857-858` es correcto. La
hipótesis muere ahí y no la reporto.

Queda una nota operativa sin severidad, no un hallazgo: esa medición es de
antes de la `0280`, que cambió las dos firmas del mutex y creó `wa_orden_evento`.
Volver a correr el bloque 16 (ya está actualizado a las firmas nuevas,
`:873-874`) lo re-ancla en un minuto. Y aunque diera `t`, el daño sería nulo:
las tres son SECURITY **INVOKER**, `viaje_lock` tiene RLS sin policy (`0005:27`)
y `wa_orden_evento` es una función pura que no toca datos. Las **219**
funciones del repo, revisadas una por una: solo dos SECURITY DEFINER quedan
ejecutables por `anon` —`is_operador` y `get_user_operador_id` (`0045`)— y
tienen que estarlo, porque son las ayudantes que evalúan los predicados de RLS
en el rol del que consulta; para un `anon` devuelven `false`/`null`.

### Cerrado de mi propia lista de «no alcancé» de la 28

- **El bucket `bus` y su `contentType`.** Lo dejé abierto en la 28 y hoy lo
  cierro: **no es un hueco.** `worker/bus/[accion]/route.ts:107` sí sube con el
  `mediaMime` que manda el worker sobre el único bucket sin
  `allowed_mime_types`, pero el único consumidor de esas URLs firmadas es
  `admin/tu-turno/vista.tsx:109`, y las pinta como `<img src={p.mediaUrl}>` —
  jamás como `<a href>` ni en un iframe. Un `text/html` subido ahí no se ejecuta:
  se queda como una imagen rota. Además el path lo arma el **servidor**
  (`:104-105`, nombre saneado a `[^A-Za-z0-9._-]` y `..` neutralizado), el
  base64 se valida por round-trip (`:100`) y todo exige una llave con capacidad
  `bus.pieza` (`:35`). La firma dura una hora (`bus.ts:99`, `HORA_FIRMA_S`),
  que es lo que dura la pantalla abierta.
- **Los TTL de URLs firmadas, todos.** Recorrí los 14 call sites de
  `createSignedUrl`/`createSignedUrls`/`getPublicUrl`. `export/pdf/[id]:125` →
  **60 s** (el navegador redirige en el acto); `processor.ts` (`:1184`, `:1223`,
  `:4796`, `:4889`) → `TTL_FIRMA_PDF_SEGUNDOS = 900` (`:1307`), el tiempo que
  Meta tarda en bajar el PDF para entregarlo por WhatsApp; `oficina_wa.ts:163`
  → 300 s; `qa-storage.ts:435`, `:466` → 60 s; `bus.ts:169` e `insumos.ts:287`,
  `:302` → 3600 s, ambos para pantallas del panel que viven abiertas.
  `estudio.ts:78` (`createSignedUploadUrl`) firma un path que genera el
  **servidor** (`crypto.randomUUID()`) con el MIME de una allowlist. Y los dos
  `getPublicUrl` son del bucket `avatares`, que es público a propósito con el
  path anclado a `auth.uid()` (`0046:43-45`). **Ninguno excede lo que dura su
  necesidad.**
- **La liga del portal de pago**, que no es una URL firmada de Storage sino un
  token en el path: 90 días por omisión, tope 365, mínimo 1
  (`portal_pago.test.ts:85-102`) y revocable — la vigencia correcta para una
  factura que puede tardar en pagarse, no un «para siempre».

### Otras fronteras reabiertas y limpias

- **La firma del correo entrante** (`correo/firma_entrante.ts`): cuerpo crudo,
  ventana de ±5 min contra replay (`:32`, `:95-97`), comparación en tiempo
  constante, **todas** las firmas de la cabecera recorridas aunque una cuadre
  («salir temprano volvería medible cuántas venían», `:105-107`), y sin secreto
  → `sin_secreto`, nunca «confía». `correo/entrante/route.ts:26-32` documenta el
  orden: firma → tenant **desde el destinatario, nunca desde el `from`** →
  idempotencia.
- **CSRF explícito** donde la cookie sola no basta: `vieneDeNuestroSitio`
  (`auth/csrf.ts`) en `qa/lanzar:38` y `qa/[id]/continuar` — la ruta que gasta
  dinero real de modelo.
- **El rate limit falla CERRADO** por omisión (`ratelimit.ts:272-274`,
  `:291-295`): si Redis está configurado y no contesta, se niega la petición y
  se loguea, en vez de degradar a un Map local que en Vercel es por instancia.
  Solo `RATELIMIT_REDIS_FALLA_CERRADO=false` lo abre, a propósito y por escrito.
- **Ningún secreto con fallback derivado de otro secreto, salvo uno declarado y
  acotado.** Busqué el patrón en todo `src/`: el único es
  `sat_descarga/index.ts:132` (`LIKIDA_SAT_PASSWORD || LIKIDA_PAC_PASSWORD`), y
  está acotado por `hostSwSinVerificar` (`:69-78`), que ante contraseña
  heredada **exige** que `LIKIDA_SAT_URL` apunte a `api.sw.com.mx` y falla
  cerrado ante una URL ilegible. `meta/client.ts:79`,
  `pac/index.ts:44` y `calcomConfig` (`calcom.ts:16-28`) caen a `''`, que
  `valorEntornoReal` rechaza — un hueco, no una herencia.

---

## Lo que NO alcancé a revisar

- **El borde de Vercel con `x-forwarded-for`.** `ratelimit.ts:311-312` sigue
  tomando el PRIMER elemento. Si el borde APPEND-ea en vez de sobrescribir, todo
  límite por IP (login, `/api/lead`, `/api/demo`, `mcp/oauth/token`,
  `export-pdf`) se evade rotando la cabecera. Abierto y sin verificar desde la
  25; se cierra con un `curl -H 'x-forwarded-for: 1.2.3.4'` contra
  `/api/health` en producción mirando qué llave se cuenta. No hay red a Vercel
  desde este contenedor.
- **`supabase/verificaciones.sql` no se ejecutó.** No hay base aquí. Los dos
  bloques que más valdría re-correr son el **16** (permisos de `anon` sobre las
  RPC, cuya última salida real es del 31-jul y anterior a la `0280` — ver la
  hipótesis refutada arriba) y el **18** (barrido de tablas sin RLS y policies
  que dicen `true`). Leí las 73 `create policy` como predicado y no hay un solo
  `using (true)`, pero cómo evalúa `get_user_tenant_ids()` bajo el rol real no
  se ve desde el SQL.
- **`NEXT_PUBLIC_*` marcadas Sensitive en Vercel.** Sigue abierto de la 28:
  `prepare-build-env.mjs` hidrata tres claves y deja el resto del archivo con
  `[SENSITIVE]` literal; `NEXT_PUBLIC_APP_URL` y `NEXT_PUBLIC_SENTRY_DSN` se
  inlinean en el bundle en build. Se resuelve con un `vercel env ls`.
- **La concurrencia real de dos corridas de QA en la MISMA instancia de Vercel.**
  El escenario de SEG-A1 lo verifiqué sobre el mecanismo (la restauración LIFO
  es determinista y la modelé), no sobre Vercel. Se comprueba lanzando una
  corrida `rapido` y continuando una `completo` a los cinco segundos, y mirando
  si `wa_outbox` deja de recibir filas `ultimo_error LIKE 'QA:%'` de la segunda
  corrida a partir del minuto ~2.
- **La ejecución real de `deploy-preview-promote.yml`.** Leí el workflow y
  ejecuté `sanitizeBuildLog` con un `env` sintético fiel a las variables por
  defecto de Actions; no puedo correr el job, así que el orden real de variables
  en el runner sigue inferido.
- **El pipeline del OCR y del LLM como frontera** (`intake/`, `agents/`): lo
  miré solo desde el gateo de las rutas. La inyección de prompt y lo que vuelve
  del modelo son del auditor agéntico y del de tool calling.
