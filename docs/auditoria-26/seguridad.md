# Seguridad — auditoría 26

**Nota: 7/10** (antes 6). Razón del movimiento: **el código cambió**, y cambió
donde dolía. Los siete hallazgos abiertos de la 25 los abrí uno por uno y **los
siete están cerrados de verdad** —no a medias—: la 0314 mete `viaje` y
`cfdi_consolidado_linea` bajo `ve_finanzas()` (era el riesgo mayor del rubro),
la 0318 + `validarAcceso` + la llamada nueva a `revocar_mcp_oauth_usuario`
cierran el ciclo de vida del token MCP en TRES puntos y no en uno, y
`api-superadmin.ts` / `tenant-api.ts:55-62` / `chat/tenant.ts:31-38` atan las
cuatro puertas de `/api` al mismo veredicto de MFA que `guard.ts`. Las 15
migraciones nuevas (0304–0318) están limpias: cero `security definer` sin
`search_path`, y las cinco funciones redefinidas conservan firma exacta (así que
`create or replace` conserva su ACL) mientras las de firma NUEVA (0306, 0317)
traen su `revoke ... from public, anon, authenticated`.

No sube a 8 por el ancla textual del rubro: **el diseño es correcto y las capas
son una sola en algún punto**. El punto es el segundo factor. Para el cliente
—el contralor y su equipo— el segundo factor es una promesa impresa en pantalla
que no gatea una sola acción del panel; y dentro de `/admin`, dos archivos de
server actions siguen decidiendo con un `rol === 'superadmin'` pelón, sin
preguntarle al veredicto que el resto de `/admin` sí pregunta.

**El riesgo mayor hoy:** un `flota_admin` que activa el segundo factor en
`/dashboard/mi-perfil` lee «Activo. Las acciones sensibles exigen el código de
tu app» y no gana NADA — firmar una liquidación, timbrar un CFDI, dar de baja a
un usuario o emitir una llave de API siguen pasando con la sola cookie del
enlace mágico. Es el control que el comprador cree que compró.

## Hallazgos

### [ALTO] El segundo factor del panel del cliente no gatea ni una acción: la pantalla dice «las acciones sensibles exigen el código de tu app» y `exigirAal2SiHayFactor` tiene UN solo llamador, en `/admin`
`src/app/dashboard/mi-perfil/page.tsx:310` y `:353` (el texto) ·
`src/lib/auth/mfa.ts:77-83` (`exigirAal2SiHayFactor`, la única implementación de
esa promesa) · `src/app/api/admin/copiloto/route.ts:161-162` (su ÚNICO llamador
en todo `src/`) · `supabase/config.toml:120-122`

Escenario, con valores:

1. Marisol es `flota_admin` de Transportes Innovativos. Su equipo de sistemas le
   pide activar doble factor antes de firmar el contrato. Abre
   `/dashboard/mi-perfil` → «Seguridad — segundo factor» y lee, literal:
   *«Un código de tu teléfono además de tu correo. Al activarlo, las acciones
   sensibles lo van a exigir.»* (`:353`). Activa TOTP con 1Password. La pantalla
   pasa a decir: *«Activo. Las acciones sensibles exigen el código de tu app;
   verifícalo aquí para subir esta sesión al nivel alto.»* (`:310`).
2. Al día siguiente entra por enlace mágico desde otra computadora. Su sesión
   nace en **AAL1** (el magic link no sube el nivel; lo dice el propio
   `mfa.ts:9`). NO escribe el código de seis dígitos en Mi perfil.
3. Con esa sesión AAL1 ejecuta, sin un solo obstáculo:
   `/dashboard/timbrado/<uuid>` → emite el CFDI de un viaje (acto fiscal
   irreversible, `permisos.ts:50` solo mira el ROL); `/dashboard/[id]` →
   `puedeFirmarLiquidacion` firma la liquidación (`[id]/page.tsx:210`);
   `/dashboard/usuarios` → «Dar de baja» a un contador
   (`usuarios_escritura.ts:175`); `/dashboard/llaves-api` → emite una llave
   `lk_live_…` que lee la flota entera desde fuera, sin sesión;
   `/dashboard/conexiones` → guarda o borra credenciales de conector.
4. Lo intenté refutar por los cuatro sitios donde la promesa podría estar
   cumplida, y no está en ninguno:
   - `grep -rn "exigirAal2SiHayFactor\|MSG_STEP_UP" src/` fuera de `mfa.ts` y
     sus pruebas devuelve **exactamente una** línea:
     `api/admin/copiloto/route.ts:162`, y ahí solo corre cuando
     `defAccion?.gateo === 'doble'` (`:161`) — un catálogo
     (`lib/agents/copiloto-acciones.ts`) que vive dentro de la consola de
     Javier, no del panel del cliente.
   - `grep -rn "aal2\|getAuthenticatorAssuranceLevel\|estadoMfa\|veredictoMfaSuperadmin"`
     sobre `src/`: fuera de `mfa.ts` solo hay dos cosas — las cuatro puertas que
     llaman `veredictoMfaSuperadmin` (`guard.ts:53`, `api-superadmin.ts:33`,
     `tenant-api.ts:57`, `chat/tenant.ts:33`), que corren solo para
     `rol === 'superadmin'` **y** solo con `LIKIDA_SUPERADMIN_MFA=obligatorio`
     (`mfa.ts:110-112`, palanca que `.env.example:603` deja vacía), y el
     `estadoMfa` de `mi-perfil/page.tsx:103`, que solo PINTA el estado.
   - RLS tampoco: `grep -rn "aal" supabase/migrations/` → **cero**. Ninguna
     policy mira el nivel de la sesión.
   - `permisos.ts` decide por ROL, nunca por AAL; no existe ninguna
     clasificación 'doble' del lado del cliente.
5. Peor: `supabase/config.toml:120-122` deja `[auth.mfa.totp]
   enroll_enabled = false` / `verify_enabled = false`, y
   `mi-perfil/page.tsx:108-112` traga el error de `mfa.enroll` sin decir nada
   (`if (!eEn && …)`): en un proyecto con TOTP apagado, apretar «Activar
   segundo factor» recarga la misma pantalla con el mismo botón, sin explicar
   por qué.

Consecuencia: la flota cree que sus actos irreversibles —el timbrado, la firma
de la liquidación, la baja de una cuenta, la emisión de una llave de API— están
detrás de dos factores, y están detrás de uno: un correo. Quien robe el enlace
mágico de un `flota_admin` hace todo eso con el factor de esa cuenta activo y
sin tocarlo. Y en la sala del demo esto es peor que la ausencia del control: el
equipo de sistemas del comprador va a leer ese renglón, va a preguntar «¿cuáles
son las acciones sensibles?» y no hay respuesta que no sea «ninguna». Rompe
además la regla del producto: un rótulo tiene que ser verdad.

Causa raíz probable: la fase 7 construyó el step-up genérico y lo cableó al
único consumidor que existía entonces (el copiloto de `/admin`); la pantalla que
lo anuncia se escribió para el mecanismo, no para los llamadores que iba a
tener.

### [MEDIO] Dos archivos de server actions de `/admin` gatean con `rol === 'superadmin'` pelón — el veredicto del segundo factor que SEG-3 puso en `/admin` y en `/api/admin` no llega hasta ahí
`src/app/admin/vendedores/consola-vendedores.tsx:52-53`, `:113-114`, `:132-133`,
`:155-156`, `:178-179` · `src/app/admin/crecimiento/page.tsx:64-65`, `:77-78` —
compárese con `src/lib/auth/api-superadmin.ts:31-38` y
`src/lib/auth/guard.ts:119-127`, que sí preguntan.

Escenario, con valores. Producción con `LIKIDA_SUPERADMIN_MFA=obligatorio`
(la secuencia de encendido está en `DEPLOY.md:245-280`). Un phishing consigue la
cookie de sesión de Javier: sesión válida, **AAL1**, sin factor verificado.

- `GET /admin/vendedores` → el layout llama `requireSuperadmin()` →
  `exigirMfaSuperadmin` → redirect a `/dashboard/mi-perfil?exige=retar`. La
  puerta de PÁGINA funciona.
- `POST /admin/vendedores` con la cabecera `Next-Action: <id de accionInvitar>`
  y `email=backdoor@atacante.mx`: la acción NO pasa por el layout —una server
  action corre ANTES del render— y su única puerta es
  `if (s?.rol !== 'superadmin')` (`:156`). Pasa. `invitarVendedor`
  (`lib/likida/vendedores.ts:561-564`) llama `provisionarUsuario(null, email,
  nombre, 'vendedor')`: se crea una cuenta en `auth.users` y una fila en
  `app_user` con `rol='vendedor'`. El atacante controla ese correo, así que
  tiene acceso propio y persistente aunque Javier rote su sesión.
- Las otras seis acciones de esos dos archivos hacen lo mismo con menos daño:
  mover/anotar prospectos, redactar correo frío con gasto real de modelo
  (`:113-114`), pausar campañas y disparar `refrescarGastoMeta` (`:77-78`).

Me lo refuté a medias y lo digo: el prerequisito es conocer el id de la server
action, que vive en el chunk de cliente de esa página. La página no se puede
renderizar con una sesión AAL1, y el nombre del chunk lleva un hash de build; no
es el `curl` de una línea que era el hallazgo original de SEG-3, y por eso esto
es MEDIO y no ALTO. Lo que sí es cierto sin condiciones: **treinta** server
actions de `/admin` gatean con `requireSuperadmin()` —que pregunta el
veredicto— y estas seis no — la puerta compartida que `d6058df` creó para `/api`
(`api-superadmin.ts`) no tiene equivalente del lado de las actions, así que el
control depende de que quien escriba la próxima acción de `/admin` recuerde cuál
de las dos formas era la buena.

Consecuencia: encender la palanca no compra lo que su documentación promete
(«toda sesión de superadmin necesita AAL2»): compra AAL2 para las páginas y
para `/api`, y deja seis mutaciones —una de ellas creadora de identidades— a un
solo factor.

Causa raíz probable: SEG-3 se pensó como puerta de RUTA (páginas, luego
endpoints). Las server actions no son ninguna de las dos y nadie las contó.

## Lo que revisé y está bien

**Los siete hallazgos abiertos de la 25 — abiertos, leídos y verificados
cerrados. Ninguno es cierre parcial.**

- **SEG-B1 / `viaje` e `ingreso_flete` (ALTO de la 25): cerrado.**
  `0314_viaje_y_cfdi_consolidado_bajo_ve_finanzas.sql:58-64` hace
  `drop policy tenant_data_select on public.viaje` y la recrea con
  `(tenant_id = any(get_user_tenant_ids()) and ve_finanzas()) or is_superadmin()`,
  y lo mismo con `tenant_data` de `cfdi_consolidado_linea`. Comprobé el detalle
  que hacía frágil el arreglo y que el propio archivo documenta (`:41-53`): en
  `viaje` la policy NO se llama `tenant_data` (la 0158 la partió en
  `_select`/`_insert`/`_update`), así que crear una `tenant_data` nueva habría
  dejado las dos permisivas combinándose con OR; el `drop` nombra la correcta.
  Reconstruí además el resto del dominio: recorrí las 19 tablas de la lista de
  `0086:38-42` y las cuatro que quedan con `tenant_data` genérico y datos de
  negocio (`unidad`, `mantenimiento`, `incidencia`, `pod`) **no tienen una sola
  columna de dinero** — `0047:31-52` y `:73-92` lo confirman, y el comentario de
  `0047:55` lo dice explícito («Sin costos: … el dinero del vehículo es de otra
  pantalla y de otro rol»). El `curl` a PostgREST con la cookie de un
  `encargado` ya no devuelve un peso.
- **SEC-3 / el token MCP que sobrevivía a la baja (ALTO de la 25): cerrado en
  TRES puntos, que es lo que el hallazgo pedía.** (1) `oauth.ts:543` mete
  `activo` al embed `app_user:user_id(tenant_id, rol, activo)` y `:569-572` niega
  ANTES de la comparación de identidad; (2) `0318:47-54` le agrega `and activo`
  a `mcp_oauth_usuario_vigente()`, que es lo que consulta `refrescarTokens`, así
  que el refresco de 60 días deja de renovarse solo; (3)
  `usuarios_escritura.ts:227-232` por fin llama
  `rpc('revocar_mcp_oauth_usuario', {p_tenant, p_usuario})` —la RPC que la 0265
  dejó escrita y sin llamador— para tumbar los tokens YA vivos, best-effort y
  con log si falla. Los nombres de los parámetros casan con `0265:116-118`. La
  frase de la pantalla («su sesión quedó revocada») ya es cierta.
- **SEG-3 / `/api` sin segundo factor (ALTO REINCIDENTE de la 25): cerrado.**
  Las cuatro puertas de `/api/admin/*` (`mapa-prospectos`, `qa`, `copiloto`,
  `palette`) son ahora un reexport de `@/lib/auth/api-superadmin`
  (`api-superadmin.ts:31-38` pregunta `veredictoMfaSuperadmin` y contesta 403);
  `tenant-api.ts:55-62` lo pregunta ANTES de honrar `?tenant=`, o sea antes de
  los siete `/api/export/*` y de `/v1`; y `chat/tenant.ts:31-38` cubre las cinco
  rutas del chat, que no pasan por ninguna de las dos. Recorrí los 67
  `route.ts`: los únicos que resuelven sesión por su cuenta son los seis de
  `/api/dashboard/*`, y los cinco que honran `?tenant=` lo hacen vía
  `tenantEfectivoChat`.
- **La válvula del rate limit (ALTO REINCIDENTE): cerrada.**
  `login/page.tsx:91` ya llama `rateLimit(..., { fallaCerrado: false })`, con el
  razonamiento escrito en `:81-90`. El default sigue cerrado para todo lo demás
  (`ratelimit.ts:270-272`), que es lo correcto.
- **`/api/health` (MEDIO REINCIDENTE): cerrado.** `migracion.ts:120-129` loguea
  `error.message` en privado y publica un motivo fijo en español; el tercer caso
  (`r.motivo`, texto de la RPC 0234) se conserva con la razón escrita.
- **La 0296 sin `revoke` (MEDIO REINCIDENTE): cerrada dos veces.** `0312:19` y
  `0315:23-24` revocan `execute` sobre `tenant_perfil_merge(uuid, jsonb, uuid)`
  de `public, anon, authenticated` y reafirman el grant a `service_role`.
- **La contraseña del PAC (BAJO REINCIDENTE): cerrada.**
  `sat_descarga/index.ts:69-78` (`hostSwSinVerificar`) solo permite la herencia
  cuando `LIKIDA_SAT_URL` apunta a `HOST_SW_GESTION`, falla cerrado ante una URL
  ilegible, y `resolverDescargaSat:137` devuelve `null` — no solo la pantalla lo
  dice, el resolutor se niega.

**Las 15 migraciones nuevas (0304–0318) — escaneo completo, no muestreo.**

- Extraje las **152** definiciones de función de las 296 migraciones:
  **cero** `security definer` sin `set search_path`. La clase de crítico de la
  23 no reincidió.
- Mismo escaneo para grants: las únicas `definer` no-trigger sin `revoke` en
  ninguna migración son `is_operador` y `get_user_operador_id` (0045), que la
  `0086:81-82` **elimina**. `indices_faltantes` (0030:48) y `triggers_faltantes`
  (0043:42) sí lo traen (el grep ingenuo los marca por el `public.` ausente).
- **La trampa de firma la busqué expresamente**, porque es la única forma de
  que un `create or replace` estrene una función con `EXECUTE` a `PUBLIC`:
  `sumar_combustible_ejercicio` (0305), `poliza_datos_tenant` (0307) y
  `acreditables_liquidacion_tenant` (0308) conservan firma Y tipo de retorno
  idénticos a 0112/0281/0112, así que heredan el ACL. Las que SÍ cambian de
  firma —`gastos_fiscales_agregados_tenant` de 7 a 13 argumentos (0317:262-263)—
  y las nuevas (`revisar_liquidacion`, `agregar_pdf_historial`, 0306:297-322)
  traen su `revoke ... from public, anon, authenticated` + `grant to
  service_role`.
- Cero policies nuevas salvo las dos de la 0314; cero grants a `anon`; los
  únicos `grant execute … to authenticated` de todo el repo son las cuatro
  funciones que RLS necesita poder ejecutar (`get_user_tenant_ids`,
  `is_superadmin`, `ve_finanzas`, `administra_flota`), y la `0294:62-89` las
  redefinió las cuatro con `and activo` y `set search_path = public, pg_temp`.

**Aislamiento a nivel de base — recorrido, no por muestra.**

- **RLS habilitada en las 147 tablas** (script propio sobre `create table` vs
  `enable row level security`, incluyendo los tres bucles `execute format`).
  Ninguna tabla creada después de la 0163 tiene policy: RLS activa + cero
  policies = deniega todo a `anon`/`authenticated`. Fail closed por
  construcción.
- **Una sola vista** (`factura_saldo`, 0049/0161) y lleva `security_invoker`.
- **Seis buckets de Storage**; el único `public = true` es `avatares` (0046:18),
  con escritura anclada a `(storage.foldername(name))[1] = auth.uid()::text`,
  tope de 2 MB y allowlist de MIME (0147:113-116). `liquidaciones`,
  `comprobantes`, `bus`, `marketing_hooks_video`, `marketing_referencias` y
  `agente-insumos` son privados y sin policies: solo el service role firma.
- **URLs firmadas — TTL revisado uno por uno** (era un punto ciego de la 25):
  60 s para el PDF de export y para las fotos de QA
  (`export/pdf/[id]/route.ts:105`, `qa-storage.ts:435`/`:466`), 300 s para el
  informe por WhatsApp (`oficina_wa.ts:163`), 900 s (`TTL_FIRMA_PDF_SEGUNDOS`,
  `processor.ts:1144`) para los PDF que viajan al chofer y al contralor por
  WhatsApp, 3600 s para el comprobante que se mira desde el panel
  (`almacen.ts:155`) y para los insumos del bus. Ninguna pasa de una hora y
  ninguna se emite sobre un bucket público. Sin hallazgo.
- **`bitacora_auditoria`**: `0195:35-36` revoca el `insert` de tabla **y** tira
  la policy de INSERT — dos capas. UPDATE/DELETE tienen una sola (RLS niega por
  ausencia de policy; los grants de tabla siguen ahí, cosa que la propia
  `0292:50-56` documenta como el segundo candado pendiente). No lo reporto como
  hallazgo porque hoy el `DELETE /rest/v1/bitacora_auditoria?id=eq.<uuid>` con
  el JWT de un `flota_admin` afecta cero filas: no sé escribir «sale esto mal».

**Credenciales, firmas y CSRF.**

- **Ningún secreto con fallback derivado de otro.** El grep de
  `process.env.X || process.env.Y` sobre `src/` da siete resultados: seis son
  `VERCEL_ENV || NODE_ENV` (no son secretos) y el séptimo es la herencia
  PAC→SAT, ahora acotada por host. `LIKIDA_COFRE_LLAVE` (`conectores/cofre.ts`)
  exige ≥32 caracteres y **lanza** en vez de guardar en claro;
  `LIKIDA_FLOTA_COOKIE_LLAVE` (`admin-context.ts:54-57`) no tiene suplente desde
  que se le quitó el fallback a la service role key, y `validarSeleccion:87`
  devuelve `null` sin llave. `SUPABASE_AUTH_HOOK_SECRET`,
  `RESEND_WEBHOOK_SECRET`, `RESEND_EVENTOS_WEBHOOK_SECRET`,
  `CALCOM_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET` y `CRON_SECRET`: los seis
  fallan cerrado y ninguno tiene suplente.
- **Las siete firmas de webhook, leídas una por una.** Meta HMAC con
  `timingSafeEqual` sobre el cuerpo leído con contador
  (`meta/client.ts:84-91` + `webhook/whatsapp/route.ts:26-44`, `:135-139`);
  Cal.com con validación de forma antes del `timingSafeEqual`
  (`admin/calcom.ts:31-36`) y las DOS rutas (`/webhook/` y `/webhooks/`)
  compartiendo el mismo handler exportado; Svix a mano para Resend entrante,
  eventos de Resend y el hook de Auth de Supabase (`firma_entrante.ts:77-115`,
  ±5 min, multi-firma sin salida temprana, y **`{ok:false, motivo:'sin_secreto'}`
  cuando la env falta**); Stripe con `webhookConfigurado()` → 503 antes de nada.
  Los tres primeros acotan el cuerpo ANTES del HMAC (`cuerpoAcotado`,
  `MAX_WEBHOOK_BYTES = 256 KB`, `32 KB` en el hook de Auth), que es donde estaba
  el defecto de la 24.
- **CSRF**: los **catorce** archivos de ruta `/api` que escriben y se autentican
  por cookie llaman `vieneDeNuestroSitio` (`csrf.ts:58-69`) — los nueve de
  `/api/admin/*`, los cinco de `/api/dashboard/*` — y `/v1` vía `_comun.ts:242`.
  No falta ninguno: recorrí los 67 `route.ts` buscando POST/PATCH/DELETE con
  sesión.
- **Server actions**: extraje por llaves balanceadas los cuerpos de las **174**
  funciones `'use server'` de `src/app` (67 archivos) y comprobé el re-gateo
  adentro de cada una. Todas re-resuelven
  la sesión (`resolverTenantEfectivo`, `requireSessionTenant`,
  `requireSuperadmin`, o una ayudante de módulo: `guardiaDespacho`,
  `sesionConPermiso`, `exigirPermiso`, `puertaAdministrar`, `gate`, `puerta`,
  `tenantYUsuarioDelAction`, `ejecutarComoVendedor`). Las únicas que se quedan
  cortas son las seis del hallazgo MEDIO de arriba —y se quedan cortas en el
  FACTOR, no en el rol.
- **`resolverLlave`** (`llave-api.ts:134-190`) y sus dos gemelas
  (`portal_pago_lectura.ts:141-186`, `worker/llaves.ts`) recorren todas las
  candidatas del prefijo sin salir temprano, comparan con `timingSafeEqual`,
  miran la caducidad DESPUÉS de la comparación y contestan 503 —no 401— ante
  error de lectura.
- **Redirects**: `/auth/callback:20-21` admite solo prefijos de ruta propios
  (`/dashboard`, `/mcp/autorizar`) y resuelve con `new URL(dest, req.url)`, que
  normaliza a mismo origen: probé `//evil`, `/dashboard@evil.com` y
  `/dashboard/../evil` — los tres quedan en `app.likida.ai`. Sin open redirect.
- **XSS reflejado**: la única ruta que devuelve HTML propio es
  `/api/correo/baja` (fuera del matcher del proxy, o sea sin CSP), y mete
  `req.url` en un `action="…"`. `esc()` (`correo/plantilla.ts:162-169`) escapa
  `& < > " '`, los cinco. `dangerouslySetInnerHTML` aparece una sola vez en todo
  `src/` y es el script de tema con una constante del propio repo. Sin hallazgo.

**CVE: descartados por escrito.**

- `npm audit`: **0 vulnerabilidades**. Es el insumo, no el veredicto.
- **`xlsx` sigue siendo el punto ciego de ese audit** —hay que repetirlo cada
  ronda—: está vendorizado (`"xlsx": "file:vendor/xlsx-0.20.3.tgz"`,
  `package.json:50`) y una dependencia `file:` no casa contra ningún advisory
  del registro. Comprobado a mano: `node_modules/xlsx/package.json` dice
  **0.20.3**, por encima de 0.20.2, donde SheetJS cerró CVE-2024-22363 (ReDoS) y
  CVE-2023-30533. El camino de explotación existe y sigue vivo
  (`/api/dashboard/archivo` parsea el libro que sube el cliente,
  `intake/archivo.ts`), así que con 0.20.3 queda descartado y el día que alguien
  la baje ninguna herramienta va a avisar.
- Instaladas y sin advisory abierto: `next@16.3.3`, `react@19.2.8`,
  `@supabase/ssr@0.12.5`, `@supabase/supabase-js@2.112.4`, `sharp@0.35.4`,
  `fast-xml-parser@5.11.1`, `pdf-parse@2.4.5`, `zod@4.5.4`, `pdf-lib@1.17.1`,
  `zxing-wasm@3.1.3`, `@upstash/qstash@2.11.3`.
- **XXE / billion-laughs en el CFDI: descartado otra vez.** Los dos `XMLParser`
  corren sobre fast-xml-parser 5.11.1 (no resuelve entidades externas ni
  re-escanea entidades internas, no hace red) y los adjuntos entran con tope
  duro de 4 MB (`correo/entrante/route.ts:78`).
- **No encontré ningún CVE con camino real de explotación en esta app.**

**Residuales que miré y decidí NO reportar (con la razón).**

- **`/api/dashboard/archivo` llama `req.json()` antes de medir nada**
  (`route.ts:45`): el tope de 3 MB se aplica sobre el base64 YA parseado. No lo
  reporto porque el borde de Vercel corta el cuerpo de una función serverless
  muy por debajo del punto donde eso importa, y encima está autenticado, gateado
  a `dinero` y con tope de frecuencia por usuario.
- **`/api/client-error` es público y escribe en el log y en Sentry** con `meta`
  arbitrario de hasta 4 KB. `msg` se sanea a 80 caracteres sin saltos de línea
  (`:30-33`, `:59`), hay tope de cuerpo y 20/min por IP: el techo del daño es
  cuota de Sentry, no una inyección. Sin hallazgo.
- **`clientIp` toma el primer elemento de `x-forwarded-for`**
  (`ratelimit.ts:309-312`, copiado en `login/page.tsx:80`). Sigue sin poder
  confirmarse desde aquí si el borde de Vercel APENDA o REEMPLAZA esa cabecera;
  va abajo, en lo que no alcancé.
- **`Receiver.verify` de QStash se sigue llamando sin `url`**
  (`cron/facturar/cola/route.ts`), o sea sin cotejar el claim `sub`. Mismo
  razonamiento que la 25: no sé escribir el escenario con valores porque el
  cuerpo tiene que venir firmado con nuestras signing keys. Queda anotado para
  el día que haya un tercer callback.
- **El registro dinámico de clientes MCP (RFC 7591) es abierto** por diseño del
  RFC, con tasa y con la advertencia en la pantalla de consentimiento. Sin
  hallazgo.

## Lo que NO alcancé a revisar

- **El SQL solo se leyó; no hay Postgres aquí.** No pude correr
  `select tablename, policyname, cmd, qual from pg_policies` contra la base real,
  que es la única forma de DEMOSTRAR que la 0314 quedó como dice en vez de
  derivarlo del texto. Mi derivación reconstruye 0001 → 0045 → 0078 → 0086 →
  0144/0146 → 0158 → 0292 → 0314 en orden; el propio archivo de la 0314 dice
  haberse verificado en rojo contra Postgres, y el bloque 251 de
  `verificaciones.sql` lo fija — pero no lo ejecuté.
- **El comportamiento del borde de Vercel con `x-forwarded-for`.** Se resuelve
  con un `curl -H 'x-forwarded-for: 1.2.3.4'` contra `/api/health` en producción
  y mirando el log; no tengo red. Lo hereda esta ronda de la 25 sin avance.
- **Las policies de `storage.objects` creadas desde el panel de Supabase**, si
  las hay: no están en `supabase/migrations` y desde aquí no se ven. Revisé las
  cuatro de `avatares` y confirmé que los otros cinco buckets son privados.
- **Si `LIKIDA_SUPERADMIN_MFA` está encendida en producción.** `.env.example:603`
  la deja vacía y no aparece en `vercel.json`; el estado real vive en el panel de
  Vercel. Todo el trabajo de SEG-3 —y el hallazgo MEDIO de esta ronda— es inerte
  mientras no lo esté. Es lo primero que confirmaría quien tome esto.
- **Las tres migraciones ausentes de la numeración (0277, 0293, 0295)** siguen
  sin existir en el árbol (`NUMERACION-SALTADA.md` documenta 0316/0317 pero no
  estas tres); no averigüé si fueron renumeradas por colisión o borradas con
  contenido dentro. Tercera ronda que se hereda.
- **No corrí la compuerta** (`npm test`, `tsc`, `lint`): no toqué código. Solo
  `npm audit` en lectura.
