# Seguridad — auditoría 27

**Nota: 8/10** (antes 7). Razón del movimiento: **se atacó y subió**. Los cinco
commits de seguridad de la ronda se abrieron uno por uno y aguantan el caso
adversarial, no solo el feliz; encima de eso la ronda encendió MFA de superadmin
**por default en producción** (`mfa.ts:110`) y lo llevó a las rutas de `/api`
que antes solo miraban sesión+rol, barrió `req.json()`/`bodyExcede` por lectura
acotada por BYTES en las nueve rutas públicas, y las **29 migraciones nuevas
(0319–0347) traen RLS + `revoke ... from public, anon, authenticated` en las 10
tablas y en cada función nueva** — verificado tabla por tabla y función por
función, no de memoria. Lo que impide un 9 sigue siendo estructural y
documentado: `proxy.ts:177` excluye `/api` entero, así que cada `route.ts` es su
única capa; y esta ronda encontró un ALTO nuevo de **radio de explosión**, no de
control de acceso.

Riesgo mayor de hoy: una corrida de QA lanzada desde `/admin` parcha
`globalThis.fetch` del proceso durante ~110 s, y en una instancia reutilizada
(la reutilización que el propio repo documenta en `config.ts:250`) se traga los
WhatsApp reales del cron que corre cada minuto, devolviendo un acuse falso.

## Hallazgos

### [ALTO] Una corrida de QA parcha `globalThis.fetch` del proceso y se traga los WhatsApp de producción con un acuse falso

`src/lib/admin/qa-motor.ts:167-201` (instalado en `:559` y `:966`;
`src/app/api/admin/qa/lanzar/route.ts` lo corre dentro de `after()`)

Escenario: Javier aprieta «Lanzar corrida» en `/admin/qa`. La ruta contesta
rápido y `ejecutarCorridaRapida` corre en `after()` durante hasta
`TECHO_CORRIDA_MS` (110 s). Su primera línea útil es
`globalThis.fetch = (async (input, init) => { … })` — una mutación **global del
proceso**, no del cliente Meta. Mientras dura, cualquier `fetch` POST a
`graph.facebook.com` que ocurra en esa instancia se desvía.

`vercel.json` programa `/api/cron/wa-outbox` con `schedule: "* * * * *"` —
**cada minuto** —, y ese cron envía con el `fetch` global:
`src/app/api/cron/wa-outbox/route.ts:130` hace
`fetch(\`${GRAPH}/${phoneId}/messages\`, { method: 'POST', … })` contra
`https://graph.facebook.com/v21.0` (`src/lib/meta/client.ts:13`). Si esa
invocación aterriza en la misma instancia tibia que la corrida (Fluid Compute
reutiliza instancias entre peticiones y entre tenants — el repo lo afirma por
escrito en `src/lib/likida/config.ts:250` para justificar OTRO arreglo de fuga
entre tenants), el interceptor:

1. inserta el payload REAL del cliente en `wa_outbox` con
   `estado: 'dead'` y `ultimo_error: 'QA: corrida <id> — interceptado…'`
   (`qa-motor.ts:189-194`);
2. devuelve un `Response` 200 sintético con
   `{"messages":[{"id":"qa_<uuid>"}]}` (`qa-motor.ts:197-199`).

El cron lee ese cuerpo, encuentra `id = 'qa_…'`, y como NO está vacío se salta
la rama defensiva de `wa-outbox/route.ts:144-157` («sin wamid → dead + alerta»)
y llama `finalizarYAvisarSiMurio(s, 'qa_…')`: la fila queda **sellada como
enviada** con un wamid que Meta nunca emitió. El chofer no recibe su PDF de
liquidación, `wa_meta_receipt` nunca recibirá un acuse para `qa_…`, y ni el
latido del cron ni Sentry registran un solo fallo — `enviadas++`.

El mismo patrón afecta a `capturarBitacora()` (`qa-motor.ts:127-145`), que
reasigna `logger.info/warn/error` del módulo: durante esos 110 s los eventos de
otras peticiones concurrentes (de flotas reales) se acumulan en `bit.eventos` y
sus `msg` se persisten en `corrida.memoria.eventos` (`qa-motor.ts:974`,
`:1449-1450`) y se le enseñan a los oráculos de la corrida.

Consecuencia: el chofer manda sus comprobantes, la liquidación cierra, el PDF se
genera y sube — y el mensaje no sale, exactamente el modo de falla del
28-jul-2026 que `webhook/whatsapp/route.ts:473-487` documenta como «veinte
minutos reconstruyendo a mano». Esta vez la base afirma «entregado» con un id
inventado, así que ni siquiera queda el `wa.no_entregado` que aquel arreglo
introdujo. Para el contralor: liquidación cerrada, chofer que jura que no le
llegó nada, y una bitácora que le dice que sí.

Causa raíz probable: la contención de la corrida de QA se implementó como
estado global mutable del proceso (`globalThis.fetch`, `logger.*`) en vez de
inyectarse por el borde del motor (el `Http` inyectable que
`conectores/tipos.ts:334` ya usa para exactamente este problema); un `finally`
restaura, pero no acota la concurrencia mientras corre.

Caveat honesto: depende de que una invocación de `wa-outbox` comparta instancia
con la corrida. No es verificable desde este contenedor (sin Vercel); se comprueba
lanzando una corrida y mirando si aparecen filas `wa_outbox` con
`ultimo_error LIKE 'QA:%'` cuyo payload NO sea del tenant sintético de la corrida.

---

### [MEDIO] El texto de `search` del MCP entra crudo en la expresión `or=` de PostgREST: una coma rompe la búsqueda y reescribe el filtro

`src/lib/mcp/herramientas/viajes.ts:103` y `:111`

Escenario: el contralor le pide a su Claude conectado por MCP «busca los viajes
a Monterrey, NL». El modelo llama `search({ query: "Monterrey, NL" })`
(`src/lib/mcp/herramientas/busqueda.ts:48`). `buscarViajesTexto` escapa **solo**
`%`, `_` y `\` (`:103`) y concatena:

```
or=(folio.ilike.%Monterrey, NL%,origen.ilike.%Monterrey, NL%,destino.ilike.%Monterrey, NL%)
```

PostgREST separa la lista de `or` por comas de primer nivel, así que el segundo
término es ` NL%` — que no es `columna.op.valor`. Contesta **400 PGRST100**;
`exigir(res, 'mcp.buscar_viajes')` lanza (`src/lib/likida/pg.ts:34`), y
`api/mcp/route.ts:212-215` lo convierte en «No se pudo completar la consulta.
El detalle quedó en los registros de Likida». Entra `"Monterrey, NL"` → sale
«Likida está fallando».

La otra mitad es inyección de verdad, no solo ruptura: con
`query = "z,folio.not.is.null,origen.ilike.z"` los términos resultantes son
todos válidos y el `or` pasa a ser `folio.ilike.%z OR folio.not.is.null OR …`,
es decir **todos los viajes** en vez de los que coinciden. El aislamiento entre
flotas NO se rompe (el `eq('tenant_id', …)` de `:110` es otro parámetro y se
combina con AND — lo fija `src/lib/mcp/aislamiento.test.ts:133-144`), pero el
resultado que el modelo cita como «los viajes que coinciden con tu búsqueda» ya
no es el que se pidió.

Consecuencia: el contralor le pregunta por una ciudad con coma —la forma normal
de escribir una plaza en México— y su asistente le contesta que el sistema falló;
o le devuelve una lista que no corresponde a la búsqueda y él la lee como
verdad. Es el rótulo-que-tiene-que-ser-verdad, en la superficie que se vende
como integración enterprise.

Causa raíz probable: el repo tiene la regla escrita y aplicada en dos lugares
—`sat_descarga/bandeja.ts:484` (`t.replace(/[%,()]/g, ' ')`) y
`revision.ts:165` / `api/v1/_comun.ts:456` (`/["(),]/.test(creadoEn)` rechaza el
cursor)— y este call site, que es el único alimentado por texto libre del
modelo, se quedó con el saneador de LIKE en vez del de la expresión `or`.

---

### [MEDIO] El redactor del logger no conoce el correo electrónico, y hay un call site que lo emite en claro hacia Sentry

`src/app/api/webhook/calcom/route.ts:219` · `src/lib/logger.ts:49-72`

Escenario: un prospecto agenda el demo desde Cal.com con
`contralor@transportesinnovativos.mx`, y en `prospecto` existen dos filas vivas
con ese `correo_normalizado` (posible: la 0323/0327 crea un índice **no único**,
`0327_calcom_retencion_forward.sql:29-31`, y el código trata la ambigüedad como
estado esperado). Se ejecuta
`logger.warn('calcom.webhook.correo_ambiguo', { correo, coincidencias: 2 })`.
`redactMeta` pasa el objeto por `SENSIBLE` (`logger.ts:72`), que solo alterna
UUID · RFC · teléfono · CLABE · tarjeta. **No hay regla de correo**, y un correo
en minúsculas tampoco cae en el regex de RFC (`^[A-ZÑ&]{3,4}…`). Sale a stdout
y, con `SENTRY_DSN` puesto, a Sentry:

```
{"t":"…","level":"warn","msg":"calcom.webhook.correo_ambiguo",
 "meta":{"correo":"contralor@transportesinnovativos.mx","coincidencias":2}}
```

Consecuencia: un dato personal identificable de un prospecto sale del sistema
hacia un encargado externo, por el único camino que la cabecera de `logger.ts:1-8`
promete que va anonimizado («así lo que sale del sistema va anonimizado por una
sola función y no por dos configuraciones»). La promesa del archivo deja de ser
cierta, y el commit de esta ronda que dice cerrar justo esto (`ec88509c`,
«Redacta datos sensibles del mensaje antes de emitir logs`) cubrió el `msg` y no
tocó el catálogo de reglas. El texto legal es de otro auditor; el control
técnico —el redactor— es lo que aquí no cubre la clase de dato.

Causa raíz probable: `SENSIBLE` enumera datos fiscales y patrimoniales
mexicanos; el correo, que es la llave del CRM y de todo el circuito de campaña,
nunca entró a la lista, y ningún test escanea los call sites por claves
`correo`/`email`.

---

### [BAJO] El mecanismo que impide que la superficie de rutas crezca en silencio solo mira `src/app/api`

`src/app/api/inventario_rutas.test.ts:60-64`

Escenario: `rutasApi()` hace `readdirSync(join(process.cwd(), 'src','app','api'))`
y compara contra `RUTAS_API_REVISADAS = 67` (`:57`). Hoy hay **72** `route.ts`
en `src/app`: los otros cinco viven fuera de `/api` —
`src/app/pago/[token]/complemento/[uuid]/route.ts` (público, autenticado solo por
un token en el path), `src/app/auth/callback/route.ts`, y los tres de
`.well-known/`. Si mañana alguien agrega `src/app/reportes/[token]/route.ts`, la
cuenta sigue en 67, la suite sigue verde, y nadie hace la revisión consciente que
la cabecera de este archivo promete («la ruta 65 … no tiene ningún gate anterior
que la atrape; se sirve»). El matcher de `proxy.ts:177` tampoco los cubre con el
gate de sesión: solo `/dashboard`, `/admin` y `/vendedor` (`proxy.ts:123`).

Consecuencia: el equipo que mantiene esto cree tener una contención completa de
la superficie sin autenticar y tiene una parcial. El daño no es hoy; es la
primera ruta pública que alguien ponga fuera de `/api`.

Causa raíz probable: el inventario se escribió cuando todos los handlers vivían
bajo `/api`, y los cinco de fuera aparecieron después (OAuth well-known, portal
de pago) sin que nadie ampliara la raíz del escaneo.

## Lo que revisé y está bien

**Los cinco commits de seguridad de la ronda, abiertos y atacados:**

- `ec88509c` — `src/lib/logger.ts:177`: el `msg` ahora pasa por
  `redactarTexto` antes de consola, Sentry y el POST a `/api/client-error`. El
  camino de `meta` ya lo hacía. Correcto para las cinco clases que el redactor
  conoce (ver el MEDIO de arriba para la que no).
- `330e8404` + `3b6db537` — `src/lib/http/https_publico.ts:44-53`: el guardarraíl
  de SSRF valida la IP **en el `lookup` del socket**, no solo la URL: `dns.lookup`
  con `all:true` y rechazo si **cualquiera** de las direcciones no es pública
  (`destino_publico.ts:38-51`, con los registros IANA v4/v6, IPv4-mapped y
  `%zone` cerrados). `redirect: 'error'` implícito (`https.request` no sigue
  redirects), `agent:false` (sin reutilizar sockets), `accept-encoding: identity`
  forzado y `host`/`accept-encoding` del llamador descartados
  (`https_publico.ts:56-61`), tope de 8 MiB por `content-length` y por chunks. Y
  es el ÚNICO transporte: los tres callers de producción
  (`conectores/tipos.ts:357`, `sincronizar_gps.ts:114`, `cron/gps/route.ts:94`)
  pasan por `httpReal()`; no queda ni un `fetch(` con URL de tenant en
  `src/lib/likida/conectores/`. El guardado también valida
  (`credenciales.ts:83`), y los portales de Playwright navegan a URLs del
  catálogo `COMERCIOS`, no del cliente.
- `c8d9821e` — `qa-motor.ts:171-186`: el host se compara **exacto** contra
  `graph.facebook.com` tras `new URL(...).hostname` y quitar el punto final, así
  que `graph.facebook.com.evil.tld` y `evil.tld/?x=graph.facebook.com` ya no
  entran; el método sale de `init.method ?? Request.method`; el cuerpo se lee de
  una **copia** (`solicitud.clone()`), conservando el original. El arreglo hace
  lo que dice. Su problema es otro y está arriba.
- `a5cbf435` — `admin/mapa-prospectos/acciones-exportar.ts:30`: `Object.create(null)`
  impide que `filtros['__proto__']` active el setter de prototipo; comprobé que
  la clave se conserva como dato propio y que el `requireSuperadmin()` de `:28`
  corre ANTES de tocar nada.

**Fronteras de confianza abiertas y limpias:**

- `?tenant=` — `lib/auth/tenant-api.ts:74-91` valida contra `tenant` y solo para
  `superadmin`, con `error` mirado (503, no fallback silencioso); los **14**
  call sites de `resolverTenantPedido` están precedidos, sin excepción, por
  `s.rol === 'superadmin' && sp?.tenant` (`dashboard/[id]/page.tsx:83,118,152,186,215,263`,
  `politicas:96`, `combustible-casetas:71`, `suscripcion:44`, `arco:68,99,132`).
  `/v1` lo BORRA en el borde (`api/v1/_comun.ts:150-154`, `:254`).
- MFA de superadmin — `mfa.ts:110-114` (producción cerrado por default, solo
  `desactivado-temporal` abre), `veredictoMfaSuperadmin` falla cerrado ante
  `no_verificable` (`mfa.ts:127-134`), y esta ronda lo llevó a
  `api-superadmin.ts:28-35`, `tenant-api.ts:55-62`, `chat/tenant.ts:31-38`,
  `guard.ts:51-58` (incluido `/vendedor`, `:148`) y a las server actions de
  `admin/vendedores/acciones.ts:43`, `admin/crecimiento/acciones.ts:18`,
  `vendedor/panel-vendedor.tsx:53`.
- Server actions — recorrí las **34** páginas de `/dashboard` y las **22** de
  `/admin`/`/vendedor` con `'use server'`: todas re-resuelven sesión adentro
  (`requireSessionTenant`/`resolverTenantEfectivo`/`sesionSuperadmin`/
  `ejecutarComoVendedor`), ninguna confía en el gate del layout. El único caso con
  cuenta desalineada, `dashboard/emergencias/page.tsx:87-92`, comparte un `gate()`
  que todas llaman.
- Webhooks — WhatsApp: HMAC sobre el cuerpo crudo con `timingSafeEqual` y cap de
  256 KB leído por stream ANTES del HMAC (`webhook/whatsapp/route.ts:136-143`).
  Cal.com: `verificarFirmaCalcom` exige 64 hex y compara en tiempo constante
  (`admin/calcom.ts:77-83`), y el secreto pasa por `secretoEntornoSeguro`
  (≥32 chars, ≥10 distintos, `env.ts:62`) o la ruta contesta 503. Stripe y Resend
  firman igual. QStash: `Receiver.verify` en `cron/facturar/cola:59` y
  `cron/wa-pendientes/cola:44`. Crons: `puertaCron` → `autorizaCron` con
  SHA-256 + `timingSafeEqual` sobre el header COMPLETO (`auth/cron.ts:40-47`) en
  las **11** rutas de `/api/cron`.
- Multi-tenant por teléfono — `conv.ts:113-157` (`resolveOperador`) y
  `contactos.ts:57-101` (`resolverCuentaOficina`) piden `limit(2)` para DETECTAR
  la ambigüedad y se niegan en vez de adivinar; el correo entrante resuelve el
  tenant por el **destinatario** y `tokenDeDestinatarios` devuelve `null` si hay
  dos buzones (`lib/correo/buzon.ts:113-121`).
- SQL / RLS — de las 29 migraciones nuevas: las 10 tablas creadas llevan
  `enable row level security` **y** `revoke all … from public, anon, authenticated`;
  las funciones nuevas llevan `revoke` explícito antes del `grant … to service_role`
  (comprobado con un cotejo mecánico create↔revoke sobre las 324 migraciones: las
  20 sin `revoke` son triggers y helpers de RLS sin argumentos, ninguna nueva y
  ninguna invocable con provecho por `authenticated`). La única función abierta a
  `authenticated` es `ve_operacion()` (`0324:806-820`), que solo devuelve un
  booleano de la fila propia. Una sola vista en todo el repo (`factura_saldo`) y
  lleva `security_invoker = true` (`0161:104`). `reclamar_eventos_seguridad` se
  `drop`+recrea en la 0341 y el `revoke` va después — el orden correcto.
- Inyección en filtros PostgREST — recorrí los **23** `.or(\`…\`)` del repo: 21
  llevan valores derivados de la base o `ISO` calculados en servidor; los dos
  con texto de usuario son `sat_descarga/bandeja.ts:484` (sanea `%,()`) y el que
  reporto arriba. Los cursores de `/v1`, `export/liquidaciones`, `revision` y
  `fiscal` rechazan `["(),]` y exigen UUID antes de concatenar
  (`api/v1/_comun.ts:449-458`, `revision.ts:159-167`).
- IDOR de descarga — `export/pdf/[id]/route.ts:73-93` exige área `dinero` **y**
  `puedeExportar` **y** `.eq('tenant_id', tenantId)` explícito sobre
  `service_role`; la URL firmada vive 60 s (`:105`). `export/poliza` repite los
  dos guardas (`:243-248`). `/pago/[token]/…` resuelve la liga entera contra la
  base en cada petición y ancla `xmlDelRep` al `factura_id`+`tenant_id` resueltos
  (`portal_pago_lectura.ts:1-56`).
- Llaves y tokens — `tenant_api_key` guarda SHA-256, recorre TODAS las
  candidatas del prefijo y compara con `timingSafeEqual`, con 401 idéntico para
  «no existe», «revocada» y «vencida» (`auth/llave-api.ts:134-176`).
  `worker_llave` no guarda ni seis caracteres de la llave rechazada, guarda 8 del
  hash (`worker/llaves.ts:59`). OAuth MCP: PKCE S256 obligatorio, `redirect_uri`
  exacta con la sola excepción de puerto en loopback
  (`mcp/oauth.ts:106-125`), reuso de código o de refresco tumba la familia
  (`:334`, `:424`), y `validarAcceso` revalida `app_user.activo/tenant/rol` en la
  MISMA consulta (`:540-586`). La pantalla de consentimiento nunca redirige a una
  `redirect_uri` no verificada (`mcp/autorizar/page.tsx:119-130`).
- Rate limit — la válvula quedó cerrada: `fallaCerradoPorDefault()` niega salvo
  `RATELIMIT_REDIS_FALLA_CERRADO=false` (`ratelimit.ts:272`), el script Lua pone
  TTL solo en el primer INCR, y al log solo va la CATEGORÍA de la llave (`:218`).
  Las nueve rutas públicas ahora leen el cuerpo por bytes con
  `leerTextoAcotado` incluso sin `content-length` (`http/cuerpo_acotado.ts:14-51`),
  y `api/rate_antes_cuerpo.test.ts` ancla el orden.
- Secretos sin fallback derivado: `env.ts:50` rechaza marcadores por CONTENIDO
  (`[SENSITIVE]`, `changeme`, `tu-…`); Facturapi tiene el host constante
  (`saas/facturapi.ts:25`); `LIKIDA_BAJA_SECRET` ausente ⇒ no se manda campaña,
  no se manda sin liga (`correo/baja.ts:31-51`); `LIKIDA_COFRE_LLAVE` ausente ⇒
  no se guarda credencial en claro (`conectores/credenciales.ts:112-118`).
- Sin sumideros de XSS: cero `dangerouslySetInnerHTML` fuera de
  `layout.tsx:59` (constante), cero `eval`/`new Function`, un solo
  `NextResponse.redirect` en `/api` y es a una URL firmada de Storage. El `next`
  de `/auth/callback:21-22` está en allowlist de prefijos propios; comprobé que
  `new URL('/dashboard/../..//evil.com', base)` sigue resolviendo al origen
  propio.
- `lib/admin/negocio.ts` sigue siendo la única función que cruza tenants: sus 26
  importadores son páginas de `/admin`, el copiloto (superadmin) y dos agentes
  internos que solo corre el `runner` por cron.

## Lo que NO alcancé a revisar

- **El borde de Vercel con `x-forwarded-for`.** `ratelimit.ts:311` y
  `auth/reenvio_enlace.ts:91` toman el PRIMER elemento. Si el borde APPEND-ea en
  vez de sobrescribir, todo límite por IP (login, `/api/lead`, `/api/demo`,
  `mcp/oauth/token`) se evade rotando la cabecera. Sigue abierto y sin verificar
  desde la 25; **se resuelve con un solo `curl -H 'x-forwarded-for: 1.2.3.4'`
  contra `/api/health` en producción** y mirando qué llave se cuenta. No es
  verificable aquí (sin red a Vercel).
- **Las policies de RLS corriendo contra Postgres real.** Leí las 29 migraciones
  nuevas, pero no hay base en este contenedor: `supabase/verificaciones.sql` (308
  bloques) no se ejecutó. Un `grant` implícito heredado de una migración vieja, o
  una policy que en la práctica no filtra, no se ve desde el SQL.
- **`storage.objects` del bucket `bus`.** Es el único bucket sin
  `file_size_limit` ni `allowed_mime_types` (contrastar `0147:112` para
  `avatares` y `0155:427` para `comprobantes`), y `worker/bus/[accion]/route.ts:107`
  sube con el `contentType` que manda el worker. Un `text/html` servido por URL
  firmada sería XSS en el origen de Storage — otro origen que el panel, y exige
  una llave `bus.pieza` válida. No lo perseguí hasta el final.
- **El pipeline del OCR y del LLM como frontera** (`intake/`, `agents/`): lo miré
  solo desde el gateo de las rutas. La inyección de prompt y el contenido que
  vuelve del modelo son del auditor agéntico y de tool calling.
- **`npm audit` / CVEs de `package-lock.json`.** No se corrió; no hay veredicto
  de dependencias en esta nota.
