# Seguridad — auditoría 30

**Nota: 6/10** (antes 7). Razón del movimiento: **deuda que cobró factura, y
mirada más profunda sobre el único commit de seguridad de la ventana.**

Las tres piezas del cálculo, medidas hoy:

1. **Mi rubro no recibió una sola línea en 38 commits**, salvo `0754652`.
   Medido: `git log 7bcc319..HEAD -- src/lib/auth/ src/proxy.ts src/lib/env.ts
   src/lib/ratelimit.ts src/app/api/webhook*` → **vacío**. Los **tres**
   hallazgos que la 29 dejó abiertos (un ALTO, un MEDIO, un BAJO, los tres en
   `qa-motor.ts`) están **intactos, línea por línea**: `:191`, `:196`, `:227`,
   `:627`, `:1036`, `:909`, `:1604`. Los tres son **REINCIDENTES** en su 2ª
   ronda. Un ALTO que sobrevive una ventana entera sin que nadie lo mire no
   sostiene la misma nota que cuando era nuevo.
2. **El único commit de seguridad cerró 8 de 22 salidas de su propia clase.**
   `0754652` puso `Cache-Control: no-store` en las 7 rutas de `export/` — y es
   verdad, lo verifiqué una por una. Pero la marca se aplicó **ruta por ruta**,
   y la misma clase de respuesta (GET, 200, datos de UN tenant, autenticada por
   **cookie**, URL idéntica entre flotas) vive en **13 salidas más** que siguen
   sin ella, incluidas las dos del dinero de la API pública
   (`/v1/liquidaciones`, `/v1/viajes/{id}/contribucion`) y las dos de los
   historiales de WhatsApp. El sitio que gobierna a todas —`next.config.ts:246`,
   que ya publica cinco cabeceras de seguridad sobre `/api/:path*`— no la lleva.
   Ver SEG-30-M1.
3. **Lo que sí levanta y lo digo con el mismo peso:** las **nueve** migraciones
   nuevas (0348–0356) reescriben **12 funciones** con `CREATE OR REPLACE` y
   **ninguna** pierde su `search_path`, **ninguna** gana un `SECURITY DEFINER`,
   **ninguna** cambia de firma (o sea: ninguna se convirtió en función nueva con
   el `EXECUTE to PUBLIC` por default de Supabase). Nueve oportunidades de
   escalada y cero tomadas — el veredicto una por una está abajo. Y `npm audit`
   vuelve a dar **0 vulnerabilidades sobre 751 dependencias**. Eso es lo que
   impide que la nota baje a 5.

El ancla estructural del rubro **no se movió**: `src/proxy.ts:177` sigue
excluyendo `api` del matcher entero y `:123` sigue cubriendo solo
`['/dashboard','/admin','/vendedor']`. Conté hoy con `find src/app -name
route.ts`: **72** (67 bajo `src/app/api`, 5 fuera) — la misma cifra de la 28 y
la 29, la ventana no agregó ni quitó ninguna. Las 72 tienen **una** capa: la que
cada handler escribe adentro. Eso solo puede valer 7, nunca 8.

**Busqué el caso de «4 o menos» —un camino sin autenticar a datos de un
tenant— y no existe.** Lo verifiqué por dos superficies nuevas esta ronda: las
**47** páginas de `/dashboard` (46 con puerta propia, la 47ª es un `redirect`
que gatea en el destino) y las **124** llamadas a
`resolverTenantEfectivo`/`requireSessionTenant` de ese árbol, **cero** con un
`destino` distinto de su propia ruta — que es la única forma de que
`puedeVerRuta` gatee la ruta equivocada.

**Riesgo mayor del rubro, hoy:** el mismo que hace una ronda — dos corridas de
QA solapadas en la misma instancia tibia se apagan el interceptor de salida a
Meta la una a la otra, y la que sigue viva manda sus WhatsApp de verdad a
`graph.facebook.com` con el token real; una ventana entera después, sin una sola
línea tocada y sin prueba que lo mire.

---

## Estado de los hallazgos abiertos de la 29

| # | Hallazgo de la 29 | Dictamen |
|---|---|---|
| ALTO | Dos corridas de QA solapadas se desinstalan el interceptor de Meta | **REINCIDENTE** (2ª ronda, archivo intacto) → SEG-30-A1 |
| MEDIO | `enterWith` en producción, `run` en las nueve pruebas | **REINCIDENTE** → SEG-30-M2 |
| BAJO | `capturarBitacora` con el mismo defecto LIFO | **REINCIDENTE** → SEG-30-B1 |

`git log 7bcc319..HEAD -- src/lib/admin/qa-motor.ts` devuelve **vacío**: el
último commit de ese archivo (`42bfa2b`) es anterior a la ventana. No hubo
intento, no hay mutación que dictaminar: los escenarios de la 29 se releen hoy
palabra por palabra y siguen siendo ciertos.

---

## Hallazgos

### SEG-30-C1 — no hay CRÍTICO

Lo digo por escrito porque lo busqué en las superficies donde vive y con dos
barridos que la 29 no hizo: las 47 páginas de `/dashboard` con su puerta
identificada, y las 124 llamadas al resolvedor de tenant contra la ruta real de
cada archivo. Ninguna de las 72 rutas, ninguna de las 47 páginas y ninguna de
las 12 funciones reescritas esta ventana abre un camino sin autenticar a datos
de un tenant.

---

### [ALTO] Dos corridas de QA solapadas se desinstalan el interceptor de salida a Meta la una a la otra — REINCIDENTE (2ª ronda, sin un solo commit encima)

`src/lib/admin/qa-motor.ts:191` (`const original = globalThis.fetch`) y `:227`
(`return () => { globalThis.fetch = original; }`) · instalado en `:629` y
`:1038` · restaurado en `:910` y `:1605` ·
`src/app/api/admin/qa/lanzar/route.ts` (sin candado de corrida viva) y
`src/app/api/admin/qa/[id]/continuar/route.ts`

Releído hoy, línea por línea: el restaurador **sigue sin comprobar** que el
`globalThis.fetch` actual siga siendo el suyo, y **sigue sin existir** ningún
candado —ni en la ruta ni en la base— que impida dos corridas vivas en la misma
instancia.

**Escenario, con los valores de hoy:**

- `t=0` — Javier lanza la corrida A, carril `rapido`. `:629` instala
  **interceptorA** capturando `originalA = realFetch`. Techo
  `TECHO_CORRIDA_MS = 110_000` (`qa-motor.ts:75`).
- `t=5 s` — en la misma pantalla aprieta «Continuar» sobre la corrida B, carril
  `completo`. `:1038` instala **interceptorB** capturando
  `originalB = interceptorA`. Techo `maxDuration = 300`.
- `t=110 s` — A termina y su `finally` (`:910`) hace
  `globalThis.fetch = originalA = realFetch`. **El interceptor de B queda
  desinstalado con B viva otros ~190 s.**
- `t=110…300 s` — cada respuesta que B genera sale por `fetch` sin interceptar:
  `POST https://graph.facebook.com/v21.0/<WHATSAPP_PHONE_NUMBER_ID>/messages`
  con el `WHATSAPP_ACCESS_TOKEN` real y `to: "5215559900001"`. **Cero filas**
  nuevas en `wa_outbox` con `estado='dead'` y `ultimo_error LIKE 'QA:%'`.
- `t≈300 s` — B termina y repone `originalB = interceptorA`: la instancia queda
  vestida con el interceptor de una corrida muerta, para siempre.

**Consecuencia.** Hoy, con la WABA en modo prueba, la corrida B queda **sin
evidencia**: los oráculos leen `wa_outbox` buscando filas `QA:` que nunca se
escribieron y juzgan una corrida que gastó dinero de modelo contra una base
incompleta, sin que nada avise. El día que la WABA pase a producción —el día
del piloto— el mismo par de clics manda WhatsApp reales contra la calidad de la
WABA de la que depende el producto entero. Es exactamente el desastre que la
cabecera de `instalarInterceptorSalidaMeta` (`:178-182`) declara como su razón
de existir.

**Causa raíz probable:** la contención sigue siendo estado global mutable del
proceso con restauración LIFO por captura; el guardia de `AsyncLocalStorage`
(`:196`) resolvió *quién* se intercepta, nunca *cuántos parches* pueden estar
apilados sobre `globalThis` a la vez.

---

### [MEDIO] `no-store` se aplicó ruta por ruta: 13 salidas 200 con datos de un tenant, autenticadas por cookie, siguen sin la marca — NUEVO

Sin la cabecera (todas GET, 200, cuerpo de UN tenant, URL idéntica entre
flotas):

- `src/app/api/v1/liquidaciones/route.ts:193` — área `dinero`
- `src/app/api/v1/viajes/[id]/contribucion/route.ts:104` — área `dinero`
- `src/app/api/v1/clientes/route.ts:95` — área `dinero`
- `src/app/api/v1/viajes/route.ts:174`, `src/app/api/v1/viajes/[id]/route.ts:85`
- `src/app/api/v1/operadores/route.ts:141`, `src/app/api/v1/unidades/route.ts:122`
- `src/app/api/dashboard/conversaciones/route.ts:31` y
  `src/app/api/dashboard/conversaciones/[id]/route.ts:36` — transcripción de la
  conversación de la flota
- `src/app/api/admin/copiloto/conversaciones/route.ts:18` y `[id]/route.ts:22` —
  superadmin, **cruza tenants a propósito**
- `src/app/api/admin/qa/[id]/estado/route.ts:83`

Con la cabecera: las **8** salidas exitosas de `export/` (una excepción, ver
SEG-30-B2), `admin/mapa-prospectos/route.ts:30`, `dashboard/chat/route.ts:179`,
`mcp/oauth/token/route.ts:45`.

**Por qué no lo tapa nada de lo que ya hay.** `src/proxy.ts:170` sí pone
`no-store` en toda respuesta de `/dashboard`, `/admin` y `/vendedor` — pero su
matcher (`:177`) **excluye `api`**, así que no alcanza a ninguna de estas 13.
`next.config.ts:246` sí alcanza a `/api/:path*` y publica CSP, X-Frame-Options,
nosniff, Referrer-Policy, Permissions-Policy y HSTS — **y no `Cache-Control`**.
Y el `export const dynamic = 'force-dynamic'` que `v1/viajes/route.ts:38`
declara con la razón escrita («una API multi-tenant que cachea es una API que le
sirve la flota A a la flota B») **no emite ninguna cabecera**: lo verifiqué en
`node_modules/next/dist/server/route-modules/app-route/module.js` — en el camino
dinámico el `Response` del handler se devuelve tal cual, y
`node_modules/next/dist/server/send-payload.js:59-61` solo inyecta
`Cache-Control` cuando hay metadatos de `cacheControl`, que para un route
handler dinámico no existen. `force-dynamic` apaga el caché **de Next**, no el
HTTP.

**Escenario, con valores.** Dos flotas del mismo cliente comparten el proxy de
salida de la oficina (o el contralor y el jefe de tráfico comparten la máquina
de la caseta). `GET https://app.likida.ai/api/v1/liquidaciones?limite=50` es la
**misma URL** para las dos, y lo único que las distingue es la cookie de sesión
— que no está en la clave de caché y de la que no hay `Vary` (el único `Vary`
del repo es `Vary: Origin` en `api/lead/route.ts:67`). Una respuesta 200 sin
`Cache-Control`, sin `Expires` y sin directivas es almacenable por un caché
compartido con frescura heurística (RFC 9111 §4.2.2): la siguiente petición
devuelve la lista de liquidaciones de la flota A —folio, anticipo, comprobado,
diferencia— dentro de la sesión de la flota B.

**Me refuté a mí mismo la mitad del hallazgo y lo escribo:** por el camino de la
**llave** (`Authorization: Bearer lk_live_…`, `v1/_comun.ts:206`) esto **no
aplica** — RFC 9111 §3.5 prohíbe a un caché compartido reusar una respuesta a
una petición con `Authorization` salvo que la respuesta traiga directivas
explícitas. El hallazgo vive **solo** por el segundo camino de autenticación de
`/v1`, la **cookie**, que el propio `_comun.ts:30-34` declara soportada («lo
consume tanto un TMS headless con llave como un navegador con sesión del
panel»). Para `dashboard/conversaciones` y `admin/copiloto/*` no hay
`Authorization` posible: ahí solo hay cookie.

**Consecuencia.** La transcripción de WhatsApp de una flota, o su lista de
liquidaciones con importes, servida dentro de la sesión de otra. Es el mismo
daño que `0754652` describe en su propio mensaje de commit —«un caché
intermedio podría reutilizar la respuesta entre sesiones o tenants»— sobre 13
respuestas que el commit no miró.

**Causa raíz probable:** la marca se trató como una propiedad de siete archivos
en vez de como una propiedad de la frontera `/api`, que es donde ya viven las
otras seis cabeceras de seguridad; el inventario del arreglo salió del hallazgo
viejo que lo motivó (`ESTADO-2026-09-04.md`, rubro 9, que hablaba de PDF y URL
firmada), no de un barrido por la propiedad.

---

### [MEDIO] El aislamiento de la corrida entra con `enterWith` y las ocho pruebas que lo certifican usan `run` — REINCIDENTE

`src/lib/admin/qa-motor.ts:627` y `:1036` (`contextoQa.enterWith({ corridaId })`)
· `:193` (el comentario que dice `contextoQa.run`) ·
`src/lib/admin/qa-motor.test.ts:804`, `:863`, `:870`, `:886`, `:907`, `:920`,
`:935`, `:952` (todas `contextoQa.run(...)`)

Verificado hoy: el código de producción **sigue** sin llamar `contextoQa.run` ni
una vez, y las ocho llamadas de la suite **siguen** siendo `run`. No son
intercambiables: `run(store, fn)` abre y cierra el contexto; `enterWith` no se
puede cerrar —persiste hasta el final de la cadena async, más allá del `finally`
que restaura los parches (`:908-910`, `:1603-1605`)— y se propaga a hermanos
esperados desde el mismo `Promise.all`.

**Escenario, con valores, y digo antes la parte que no es explotable hoy:** una
petición independiente que llega a la instancia tibia ve `getStore() ===
undefined` (lo midió la 29 con un servidor HTTP real) — ese escenario está
cerrado. Lo que la asimetría cambia es el margen: el día que
`/api/admin/qa/lanzar` registre un segundo `after()`, o que un `after()` de otra
parte corra en el mismo `Promise.all` que el de la corrida, ese callback verá
`getStore().corridaId === '<id de la corrida>'` sin haber entrado nunca; si
manda un WhatsApp se lo traga el interceptor y recibe
`{"messages":[{"id":"qa_<uuid>"}]}` — una entrega que nunca ocurrió, sellada
como ocurrida. Ninguna prueba lo detectaría: ninguna usa `enterWith`.

**Consecuencia.** El repo cree tener una garantía verificada y tiene dos cosas
distintas: un guardia verificado (`:196`, y sí muerde) y un mecanismo de entrada
que ninguna prueba toca.

**Causa raíz probable:** `enterWith` se eligió para no re-indentar 300 líneas
dentro de un `run(store, async () => …)`; el comentario se escribió describiendo
`run` y las pruebas se escribieron contra el comentario, no contra el código.

---

### [BAJO] La captura de bitácora tiene el mismo defecto LIFO y le corta la evidencia a la corrida que sigue viva — REINCIDENTE

`src/lib/admin/qa-motor.ts:150-166` (`:152` captura `originales`, `:162-164` los
repone) · instalada en `:628` y `:1037`, restaurada en `:909` y `:1604`

Con las dos corridas solapadas de SEG-30-A1: A envuelve `logger.warn = wrapperA`
(con `originalWarnA` = el real); B envuelve `logger.warn = wrapperB` (con
`originalWarnB = wrapperA`); en `t=110 s` A repone el real y **`bit.eventos` de
B deja de recibir nada** con B viva 190 s más; en `t≈300 s` B repone `wrapperA`
y el logger de módulo queda envuelto para siempre por el wrapper de una corrida
terminada.

**Consecuencia.** `corrida.memoria.eventos` de B se corta a la mitad sin
decirlo, y esa es la evidencia que se le enseña a los oráculos y la que Javier
lee cuando una corrida falla: una corrida que salió mal después del minuto 110
se ve como una que no registró nada. No afecta a ningún cliente —la bitácora de
QA es interna— por eso es BAJO.

**Causa raíz probable:** la misma que SEG-30-A1; los dos se escribieron con el
patrón «instala, corre, `restaurar()` en el `finally`» y heredan el supuesto de
que solo hay una corrida viva.

---

### [BAJO] El preflight de la póliza es la única salida 200 de `export/` que quedó sin `no-store` — NUEVO

`src/app/api/export/poliza/route.ts:410-422` (`if (preflight) { return
NextResponse.json({ … }) }`), contra `:442` (contpaqi) y `:466` (sap_b1), que sí
la llevan.

Las otras seis rutas de `export/` tienen una sola salida exitosa cada una y las
siete la marcan. `poliza` tiene **tres**, y el arreglo tocó dos.
`rutas_export.test.ts:195-200` afirma «la respuesta exitosa nunca es cacheable»
sobre `RUTAS` (`:134-139`), que son `pdf/[id]`, `liquidaciones`,
`facturas-proveedor` y `bitacora-peaje` — `poliza` no está en esa lista. Y su
propia prueba de caché (`salida.test.ts:113-124`) cubre contpaqi y sap_b1; el
preflight sí se ejercita en el archivo, pero **solo por su rama 409**
(`:168-171`, un periodo sin firma), nunca por la que contesta 200.

**Escenario, con valores.** `GET
/api/export/poliza?formato=contpaqi&desde=2026-08-01&hasta=2026-08-31&preflight=1`
contesta 200 con `{ listo: true, polizas: 47, plantillaConfirmadaEn: "…",
rango: {…} }`. Mismo mecanismo que SEG-30-M1: cookie fuera de la clave de caché,
URL idéntica entre flotas, 200 sin directivas → un caché compartido puede
contestarle a la flota B que tiene 47 pólizas listas y una plantilla confirmada
en tal fecha, cuando son de la flota A. Es menos daño que las otras dos salidas
(un conteo y una fecha, no el asiento) y hoy **ninguna pantalla llama al
preflight** —el único `?preflight=1` de `src/` fuera de la ruta está en
`salida.test.ts:170`—, por eso es BAJO y no MEDIO.

**Causa raíz probable:** la cabecera se puso en los `return` que el diff tocaba
(los dos que arman archivo), no en la propiedad «toda salida 200 de esta ruta».

---

### [BAJO] `0353` y `0356` dejan de declarar `SECURITY INVOKER` en `ejecutar_arco_cancelacion`, y ninguna prueba lo afirma — NUEVO

`supabase/migrations/0353_revisar_liquidacion_arco_cuerpos_completos.sql:230-233`
y `supabase/migrations/0356_arco_borra_contacto_emergencia.sql:21-24`

Las **cinco** definiciones anteriores de esta función (`0173`, `0262`, `0264`,
`0273`, `0286`) escribían `security invoker` explícito. Las dos nuevas lo
omiten. **No es una escalada**: `CREATE OR REPLACE` sin cláusula de seguridad
asigna el default, que es INVOKER, así que la función se comporta exactamente
igual — lo verifiqué comparando las siete cabeceras. Lo que se perdió es el
**marcador**, en la función que anonimiza RFC y licencia del operador, borra sus
conversaciones y ahora también su contacto de emergencia.

**Escenario, con valores.** La próxima migración de esta función se escribe como
se han escrito las últimas cinco: copiando el cuerpo de la anterior. En `0353`,
40 líneas arriba, está `revisar_liquidacion` con `SECURITY DEFINER` (`:22`);
copiar «para que queden iguales» convierte a `ejecutar_arco_cancelacion` en
DEFINER y **nada se pone rojo**: `arco_search_path.test.ts` solo exige que el
`search_path` de la última definición traiga `extensions` (`:115-120`), el
bloque E de `capa1_auditoria_estatica.sql` solo comprueba que exista *algún*
`search_path=`, y `migraciones_verificadas.test.ts` solo exige una exención
escrita. Este repo ya pisó exactamente esta piedra una vez: `0273` revirtió el
`search_path` de `0264` por partir de un cuerpo viejo, y el arreglo (`0275`)
tuvo que escribir una prueba en TS para que no volviera a pasar. La prueba que
se escribió cubre el `search_path`; la cláusula de seguridad quedó fuera.

**Consecuencia hoy: ninguna.** La función solo la ejecuta `service_role`
(`0356:131-132`), que ya salta RLS. Lo reporto porque el marcador que un
auditor lee para contestar «¿esto corre como el dueño?» dejó de estar en la
definición vigente, y porque la red que existe mira al lado.

---

### [BAJO] La prueba nueva de `/dashboard/suscripcion` afirma «renderiza para cualquier rol» después de doblar el único gate de vista — NUEVO

`src/app/dashboard/suscripcion/page.test.tsx:36`
(`vi.mock('@/lib/auth/tenant-efectivo', () => ({ resolverTenantEfectivo: async
() => sesion }))`) y `:102` («la página renderiza para cualquier rol (la puerta
real está en las server actions)»)

La afirmación del paréntesis es falsa. La puerta de vista de esta página **sí
existe** y vive en `src/lib/auth/tenant-efectivo.ts:171`
(`if (!puedeVerRuta(sesion.rol, destino)) redirect(...)`), con
`visibilidad.ts:214` clasificando `/dashboard/suscripcion` como área `dinero`:
un `encargado` (áreas `['operacion']`, `:41`) y un `vendedor` (sin entrada en
`AREAS_POR_ROL`, `:301-303`) rebotan. La prueba sustituye esa función por una
que devuelve la sesión sin mirar la ruta, y después declara el resultado como el
diseño. Es la única de las seis páginas nuevas donde pasa: las otras cinco
tienen además un gate propio dentro de `page.tsx` que la prueba sí ejercita
(`llaves-api/page.test.tsx:58`, `reglas:64`, `emergencias:101`,
`asistencia:67`, `sesiones-mcp:52`).

**Escenario, con valores.** Alguien reclasifica `'/dashboard/suscripcion':
'dinero'` → `'operacion'` en `visibilidad.ts:214` (o mueve la entrada al
clasificar una ruta hermana). El jefe de tráfico pasa a ver la facturación de
Likida a su flota: plan contratado, importe pendiente, lista de facturas SaaS y
los datos fiscales de la empresa (`page.tsx:104-111`). **Las 13 pruebas nuevas
de esa página siguen verdes**, y la que se leería como la cobertura del caso
—«renderiza para cualquier rol»— es la que afirma que eso está bien. Borrar la
entrada entera sí falla cerrado (`puedeVerRuta` niega con `area === undefined`),
así que el único agujero es el cambio de área, no el olvido.

**Causa raíz probable:** el archivo se escribió copiando el andamio de
`llaves-api` —donde el gate de rol sí vive en `page.tsx` y el mock del
resolvedor es inofensivo— sin notar que en esta página el gate vive del otro
lado del mock.

---

## CVEs revisados y descartados por escrito

**No hay ninguno que descartar, porque no hay ninguno.** Corrí `npm audit` yo
mismo esta ronda, las dos formas, sobre el `package-lock.json` de
`claude/auditoria-30`:

```
npm audit --json            → {"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}
npm audit --omit=dev --json → {"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}
dependencias: 751 total (215 prod, 415 dev, 161 optional, 43 peer)
```

Mismas 751 que la 29, mismo cero. El egress **sí** funcionó para el registro
(la consulta de avisos contestó); no hay que anotar INFRA aquí. `next` va en
**16.3.4**. **No hay un solo CVE con o sin camino de explotación en esta app**,
así que la sección de «descartar uno por uno» no tiene sujeto.

---

## Lo que revisé y está bien

### Las nueve migraciones, una por una (foco obligatorio (b))

El método: por cada función reescrita, extraje la cabecera de **todas** sus
definiciones históricas y comparé cláusula de seguridad, `search_path` y firma
exacta; y comparé la firma vieja contra la nueva **argumento por argumento**,
porque una firma distinta no reemplaza — **crea** una función nueva, y una
función nueva en `public` nace con `EXECUTE to PUBLIC` más los grants por
default que Supabase instala para `anon`/`authenticated`. Ése era el modo de
falla que había que buscar, y no ocurre en ninguna.

| Mig. | Qué reescribe | SECURITY | `search_path` | Firma | ACL | Veredicto |
|---|---|---|---|---|---|---|
| **0348** | 6 funciones de analytics (`liquidaciones_por_dia_tenant`, `liquidado_semanal_tenant`, `operadores_detalle_tenant`, `rentabilidad_tenant`, `serie_comparativa_tenant`, `stats_operador_tenant`) | INVOKER en las 6, igual que 0150/0152/0112/0174 (ninguna versión llevó `definer`) | `public, pg_catalog` conservado en las 6 (`:14`, `:29`, `:45`, `:84`, `:114`, `:170`) | idéntica; los «diffs» (`timestamptz`→`timestamp with time zone`, `int`→`integer`) son alias del mismo tipo | no se reemite, y **no hace falta**: `CREATE OR REPLACE` conserva dueño y permisos | **limpia** |
| **0349** | `sumar_combustible_ejercicio` | INVOKER (igual que 0084/0305/0345) | `public, pg_catalog` conservado (`:44`) | `(uuid, int, text[])` idéntica | conservada de `0112:166-167` | **limpia** |
| **0350** | nada de SQL ejecutable: dos FK a `on delete cascade` | — | — | — | — | **limpia** (sin superficie de seguridad) |
| **0351** | nada: amplía el CHECK `llm_costo_fase_dominio` | — | — | — | — | **limpia** |
| **0352** | nada: columna `retencion_iva` + dos CHECK | — | — | — | — | **limpia** (RLS de `factura_emitida` intacta; una columna nueva hereda la policy de la tabla) |
| **0353** | `revisar_liquidacion` **y** `ejecutar_arco_cancelacion` | `revisar_liquidacion` **conserva `SECURITY DEFINER`** (`:22`, igual que 0299/0306); `ejecutar_arco_cancelacion` queda INVOKER por default — mismo efecto, marcador perdido (SEG-30-B3) | conservados y **literales**: `'public','pg_catalog','pg_temp'` (`:23`) y `public, extensions, pg_catalog` (`:233`) — el `extensions` que `arco_search_path.test.ts` exige sigue ahí (corrí la prueba: verde) | ambas idénticas (8 y 2 args) | conservada | **sin escalada** |
| **0354** | `cierre_insumos_hash`, `cierre_insumos_snapshot`, `guardar_liquidacion_tx` | INVOKER las tres, igual que 0321 | conservados los tres (`:39`, `:155`, `:182`), incluido el `extensions` del hash | idénticas | **reemitida** explícitamente (`:149-150`, `:170-171`, `:301-305`) | **limpia** |
| **0355** | `gastos_fiscales_agregados_tenant` | INVOKER, igual que 0316/0317 | conservado (`:25`) | 13 args idénticos a 0317 | **reemitida** (`:216-217`) | **limpia** |
| **0356** | `ejecutar_arco_cancelacion` | INVOKER por default (SEG-30-B3) | `public, extensions, pg_catalog` conservado (`:24`) | `(uuid, uuid)` idéntica | **reemitida** (`:131-132`) | **sin escalada** |

Además: el diff completo de `supabase/` en la ventana **no contiene una sola**
`create policy`, `alter … enable row level security`, tabla nueva, ni un `grant`
a `anon`/`authenticated` (`git diff 7bcc319..HEAD -- supabase/ | grep -i
'^+.*\(policy\|grant\|revoke\|row level security\|security definer\)'` → 10
líneas, todas `revoke … from public, anon, authenticated` + `grant … to
service_role`, más el `SECURITY DEFINER` que `0353` **conserva**).

### Las 7 rutas de export (foco obligatorio (a))

Son **exactamente 7** (`find src/app/api/export -name route.ts`), y verifiqué
las tres preguntas:

- **¿Las 7 la llevan?** Sí: `bitacora-peaje:65`, `carta-porte-xml:85` y `:126`
  (las dos salidas: timbre guardado y XML generado), `facturas-proveedor:110`,
  `jornada:128`, `liquidaciones:209`, `pdf/[id]:177` (sobre el 302, que es su
  única salida exitosa), `poliza:442` y `:466`.
- **¿Queda alguna ruta de export sin ella?** Ninguna en `src/app/api/export`. La
  otra ruta del repo que sirve un `Content-Disposition: attachment` está fuera
  de ese árbol —`src/app/pago/[token]/complemento/[uuid]/route.ts:84`, el XML
  del complemento de pago— y **ya la traía** desde antes, en su forma más fuerte
  (`private, no-store`, `:86`). El barrido fue por la propiedad, no por el
  directorio: `grep -rn 'Content-Disposition' src/app`.
- **¿En todas las salidas, incluidas error y 304?** En las de **error**, no —y
  no hace falta: los estatus que devuelven (400, 403, 404, 409, 413, 429, 500,
  502, 503) o no son almacenables por default (RFC 9110 §15.1 lista 200, 203,
  204, 206, 300, 301, 308, 404, 405, 410, 414, 501) o llevan cuerpo genérico sin
  dato de flota; el único 404 con texto es «No hay liquidaciones cerradas en ese
  periodo», que no nombra nada. En **304**, no existe el caso: ninguna de las 7
  emite `ETag` ni `Last-Modified` (`grep -rn 'ETag' src/app/api/export` → vacío),
  y Next no los añade a un route handler dinámico. La única salida 200 sin la
  marca es el preflight de `poliza` — SEG-30-B2.

### La cobertura nueva de las seis páginas (foco obligatorio (c))

**Sí afirma el control de acceso; no es decoración.** Las seis prueban las
**dos** capas —la de vista y la de la server action invocada directo— y la
segunda con el patrón correcto: renderizan la página autorizadas para extraer la
action real cerrada por closure, **luego cambian el rol**, y comprueban que la
action re-resuelve la sesión en el momento de la llamada:
`llaves-api/page.test.tsx:93-104` y `:132-143`, `sesiones-mcp:111`,
`emergencias:201`, `reglas:127`, `asistencia:120`, `suscripcion:106`, `:176`,
`:197`. Y verifican lo que de verdad importa del IDOR: que el `tenantId` sale
del **closure de la sesión** y que el del formulario se ignora —
`llaves-api:82-88` manda `tenantId: 'OTRO-TENANT'` y comprueba que llegó `'t-1'`;
`emergencias:126`, `:140`, `:178` hacen lo mismo; `suscripcion:165` cubre
incluso el superadmin «viendo como» otra flota. La única grieta es la de
SEG-30-B4, y es de una sola de las seis. Corrí los seis archivos más
`src/app/api/export`: **15 archivos, 213 pruebas, verde**.

### El aislamiento entre flotas, por dos superficies que la 29 no midió

- **Las 47 páginas de `/dashboard`.** Escaneé todos los `page.tsx` del árbol:
  **46** llaman `resolverTenantEfectivo`/`requireSessionTenant`/`exigirVer`
  directamente. La 47ª, `dashboard/integraciones/page.tsx`, es un `redirect` a
  `/dashboard/conexiones` que no gatea **a propósito y por escrito** («el gateo
  NO se repite aquí: `puedeVerRuta` decide en el destino, que es
  `administracion` igual que ésta»), y el destino es de la misma área.
- **Las 124 llamadas con `destino` literal.** Comparé el string que cada archivo
  le pasa al resolvedor contra su ruta real en disco: **cero** discrepancias. Es
  la única forma de que `puedeVerRuta` gatee la ruta equivocada, y el modo de
  falla del typo es **cerrado** (`areaDeRuta` devuelve `undefined` →
  `puedeVerRuta` niega, `visibilidad.ts:286`). La única variante peligrosa es
  reclasificar el área de una ruta existente — SEG-30-B4.

### La puerta de las llaves de API, releída entera

`src/lib/auth/llave-api.ts` es correcto en las seis cosas que importan y lo
verifico porque `/dashboard/llaves-api` fue una de las páginas cubiertas:
SHA-256 del secreto y nunca el claro (`:70`, con el CHECK de 64 hex de la 0093);
`randomBytes(32)` (`:60`); `timingSafeEqual` con comparación de largo previa
justificada (`:113-116`); **se recorren todas las candidatas del prefijo aunque
la primera cuadre** (`:153`, «salir temprano volvería medible cuántas comparten
prefijo»); una llave vencida devuelve **el mismo 401 y el mismo texto** que una
inexistente y se comprueba **después** del `timingSafeEqual` (`:173`); y un
error de lectura es **503, nunca 401** (`:149`) para que el TMS del cliente
no borre una llave buena por un bache de red. El sello de último uso es
best-effort y no tumba la petición (`:184`).

### Ningún secreto con fallback derivado de otro

Rebarrido el patrón en `src/`: el único sigue siendo
`sat_descarga/index.ts:132` (`LIKIDA_SAT_PASSWORD || LIKIDA_PAC_PASSWORD`),
acotado por `hostSwSinVerificar` (`:69-78`), que ante contraseña heredada exige
que `LIKIDA_SAT_URL` apunte a `api.sw.com.mx` y falla cerrado ante una URL
ilegible. `env.ts` no cambió en la ventana.

---

## Lo que NO alcancé a revisar

- **El borde de Vercel con `x-forwarded-for`.** `ratelimit.ts:311-312` sigue
  tomando el PRIMER elemento. Si el borde APPEND-ea en vez de sobrescribir, todo
  límite por IP (login, `/api/lead`, `/api/demo`, `mcp/oauth/token`,
  `export-pdf`) se evade rotando la cabecera. Abierto sin verificar desde la 25;
  se cierra con un `curl -H 'x-forwarded-for: 1.2.3.4'` contra `/api/health` en
  producción mirando qué llave se cuenta. No hay red a Vercel desde aquí.
- **El comportamiento REAL del caché de Vercel sobre las 13 rutas de
  SEG-30-M1.** El escenario lo construí sobre la semántica HTTP y sobre el
  código (verificado en el `dist` de Next 16.3.4 que `force-dynamic` no emite
  cabecera). Lo que no pude medir es qué `Cache-Control` por default pone el
  borde de Vercel cuando la función no pone ninguno: un `curl -i` contra
  `https://app.likida.ai/api/v1/viajes` en producción lo contesta en un minuto y
  decide si el daño es «CDN de Vercel» o solo «proxy del cliente».
- **`supabase/verificaciones.sql` no se ejecutó** (no hay base). El bloque
  **16** —permisos de `anon` sobre las RPC— sigue con su última salida real del
  **31-jul-2026**, anterior a la 0280 y ahora también a las nueve de esta
  ventana; la 29 lo dejó anotado y la ventana no lo re-corrió (el diff de
  `verificaciones.sql` añade los bloques 144 y 267, ninguno de permisos).
  Mientras no se re-corra, mi veredicto sobre las 12 funciones es **estático**:
  leí los `CREATE OR REPLACE` y las firmas, no el `pg_proc` de producción.
- **`NEXT_PUBLIC_*` marcadas Sensitive en Vercel.** Abierto desde la 28;
  `prepare-build-env.mjs` hidrata tres claves y deja el resto con `[SENSITIVE]`
  literal. Se resuelve con un `vercel env ls`.
- **La concurrencia real de dos corridas de QA en la MISMA instancia de
  Vercel.** SEG-30-A1 está verificado sobre el mecanismo (restauración LIFO
  determinista), no sobre Vercel.
- **El pipeline de OCR y LLM como frontera** (`intake/`, `agents/`): lo miré
  solo desde el gateo de las rutas. La inyección de prompt es del auditor
  agéntico.
