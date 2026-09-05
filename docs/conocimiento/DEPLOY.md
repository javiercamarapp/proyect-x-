# Runbook de producción

La operación de resiliencia/deploy automatizada vive en
[`docs/operacion/RESILIENCIA-DEPLOY.md`](../operacion/RESILIENCIA-DEPLOY.md):
backup de Storage **bajo demanda** (`workflow_dispatch`; el `schedule` diario
está apagado a propósito hasta terminar su primera configuración externa — no
hay backup programado corriendo solo todavía), manifiestos y hashes, restore
drill seguro, Preview→smoke→promote, rollback aprobado y objetivos RPO/RTO
—objetivos, no un SLA, hasta la primera corrida programada y un restore drill
con cronómetro—.

Producción: **https://app.likida.ai** — proyecto `likida/likida.ai` en Vercel,
plan Pro. Ya está desplegado y sirviendo WhatsApp real; este documento es para
**operarlo**, no para levantarlo. El apartado de despliegue está al final porque
es lo que menos falta se hace a las 3 a.m.

`https://likidaai.vercel.app` sigue siendo un alias válido (verificado con
`vercel inspect likida.ai` el 4-ago-2026: la lista de Aliases trae los dos, más
`likida.ai` a secas), pero **`app.likida.ai` es el dominio canónico** — el que
exige `NEXT_PUBLIC_APP_URL` (CLAUDE.md) para que la cookie de Supabase Auth no
quede en otro dominio. Usar el alias viejo aquí no rompe nada operativamente,
pero documentar el dominio equivocado como "producción" sí puede llevar a
verificar cosas (Meta, Supabase Site URL) contra el sitio que no es.

---

## Algo se rompió: qué mirar, en este orden

1. **Los logs.** Todo sale como JSON de una línea por `src/lib/logger.ts`.
   ```
   vercel logs https://app.likida.ai --since 1h
   ```
   O el panel: Vercel → proyecto → *Logs* (runtime). Ojo: **la retención de esa
   vista es corta y no hay ningún log drain configurado** — un fallo del sábado
   de madrugada puede no existir el lunes. Si el incidente importa, copia las
   líneas antes de cerrar la pestaña.

2. **Qué buscar en la línea.** Los identificadores del camino del dinero
   (`tenant`, `viaje`, `operador`, `gasto`, `liquidacion`) salen como huella
   `id:xxxxxxxxxxxx`, no como UUID. Para cruzar una huella contra la base:

   ```ts
   import { huellaId } from '@/lib/logger';
   huellaId('<el uuid de la fila>') // === lo que dice el log
   ```

   El porqué está explicado arriba de `src/lib/logger.ts`: el log solo no puede
   revelar a nadie, pero quien tiene la base recorre el camino contrario en un
   segundo. El RFC y los teléfonos sí se borran del todo y no se recuperan.

3. **Los mensajes de arranque.** Cada instancia nueva emite:
   - `startup.observabilidad` — `{"sentry":false}` en `error` significa que
     **nadie va a recibir el siguiente fallo**. Es lo primero que hay que
     arreglar si aparece.
   - `startup.migraciones` — el esquema del camino del dinero.
   - `startup.entorno_grupos` — falta configuración DURA (la que rompe:
     Supabase, OpenRouter, WhatsApp…), agrupada por lo que apaga.
   - `startup.config_silenciosa` — falta una de las variables con las que el
     sistema arranca igual y contesta mal (la tabla de abajo). `ok:false` en
     `error` trae el nombre y la consecuencia de cada una.

4. **Si el panel falló para el contralor.** Pídele el `Digest: <número>` que
   Next enseña en pantalla y busca ese número en los logs: `onRequestError`
   (`src/instrumentation.ts`) emite `request.fail` con `digest`, `ruta` y el
   error. Es el único puente entre lo que él vio y el servidor.

5. **Si las fotos dejaron de llegar.** El sospechoso número uno es el token de
   WhatsApp caducado — ver la sección siguiente.

---

## ¿El costo por liquidación es real o solo parece barato?

Likida cobra **por liquidación**, así que un costo que se subestima en silencio
es el que hace fijar mal el precio. Estas cuatro líneas son las que lo delatan
(`src/lib/likida/costos.ts`):

| Línea | Qué significa |
|---|---|
| `costo.no_registrado` | Un insert a `llm_costo` rebotó (RLS, columna, `check`). Ese gasto **no está contado**: el costo real es más alto que el que se ve. |
| `costo.liquidacion_sin_costo` | Una liquidación se cerró sin **una sola** fila de costo. Su costo unitario es DESCONOCIDO, no cero. |
| `costo.precio_wa_invalido` | `LIKIDA_WHATSAPP_MSG_USD` está puesta y no es un número (típicamente vacía). Se usó el default; sin este aviso cada mensaje habría contado $0. |
| `costo.monto_invalido` | Llegó un costo NaN o negativo y se descartó la fila en vez de escribir un 0 que se leería como barato. |

Regla de lectura: **cero solo es cero cuando alguien lo midió.** `getResumenCosto`
devuelve `estado: 'medido' | 'sin_registros' | 'no_medido'` justamente para que
un fallo de lectura no se pueda pintar como "$0.00".

---

## Respaldo y restauración (RES-8)

**Este proyecto no tiene respaldo automático ni PITR.** Verificado contra la
Management API el 4-ago-2026: el plan de Supabase es free y su propia
documentación es explícita en que los proyectos free exportan por su cuenta. El
mismo día se borró la base entera y lo único que la salvó fue un dump hecho a
mano.

Con el CFF art. 30 de por medio —los comprobantes de las flotas clientes se
conservan **cinco años**— esto no es pérdida de producto: es pérdida de
evidencia fiscal de un tercero.

### Los dos respaldos, y son dos

| Qué | Script | Qué se pierde sin él |
|---|---|---|
| **La base** (filas) | `bash scripts/respaldo.sh [destino]` | Todo: viajes, gastos, liquidaciones, facturación. |
| **Storage** (archivos) | `bash scripts/respaldo-storage.sh [destino]` | Las FOTOS de los comprobantes y los PDF de las liquidaciones. Las filas quedan apuntando a rutas de un bucket vacío: la liquidación existe y el papel que el contralor cruza, no. |

**El segundo no existía hasta el 22-ago-2026** (RES-8). Correr solo el primero
deja un respaldo que *parece* completo — es la forma más cara de este fallo.

```bash
# La base — dump de datos, se comprueba que no venga vacío, 14 días en disco.
bash scripts/respaldo.sh

# Storage — lista con la service role, baja lo que falte, compara CONTEOS y
# deja MANIFIESTO.tsv (bucket, ruta, bytes, sha256). Es IDEMPOTENTE: correrlo
# dos veces no vuelve a bajar nada, y una corrida cortada se retoma.
bash scripts/respaldo-storage.sh

# A S3 o R2 en la misma corrida (sin --delete: nunca borra allá):
RESPALDO_S3_DESTINO=s3://likida-respaldos/storage bash scripts/respaldo-storage.sh
```

Variables de `respaldo-storage.sh`: `NEXT_PUBLIC_SUPABASE_URL` y
`SUPABASE_SERVICE_ROLE_KEY` (las lee de `.env.local` si no están en el
entorno), `RESPALDO_BUCKETS` (default `comprobantes liquidaciones bus`) y
`RESPALDO_S3_DESTINO`. **No hay cron que lo llame**: corre contra producción
con la service role, y esa tecla es consciente. Cadencia recomendada mientras
no haya PITR: **semanal**, y a mano antes de cualquier migración que borre.

### PITR: qué es y qué NO cubre

El Point-in-Time Recovery de Supabase (planes de pago) permite restaurar la
BASE a un instante. Dos cosas que hay que tener claras antes de darlo por
resuelto:

- **PITR no cubre Storage.** Los archivos van por su lado. Aunque se contrate,
  `respaldo-storage.sh` sigue haciendo falta.
- **PITR no protege de un borrado lógico que se replica**: si una migración
  borra filas, PITR sirve para volver atrás *si alguien se da cuenta dentro de
  la ventana*. La ventana y la alerta son parte del plan, no un regalo.

Mientras no se contrate, la ventana de pérdida es **el tiempo desde el último
`respaldo.sh` que alguien haya corrido a mano**. Escribirlo así es el punto:
esa cifra hoy no la sabe nadie.

### La prueba de restauración (lo que convierte un archivo en un respaldo)

Un respaldo que nunca se restauró es una hipótesis. Se prueba **contra una base
nueva, jamás contra producción**:

1. Crear un proyecto de Supabase vacío (o una base local:
   `createdb likida_restauro`).
2. Esquema y datos:
   ```bash
   psql "$URL_RESTAURO" -v ON_ERROR_STOP=1 -f supabase/pruebas-aislamiento/andamio_ci.sql
   for f in supabase/migrations/*.sql; do psql "$URL_RESTAURO" -v ON_ERROR_STOP=1 -q -f "$f"; done
   psql "$URL_RESTAURO" -v ON_ERROR_STOP=1 -f ~/Desktop/likida-respaldos/likida-AAAA-MM-DD_HHMM.sql
   ```
3. **Cotejar contra el manifiesto**, que es la parte que se salta todo el
   mundo: por cada `pdf_url` de `liquidacion` y cada `imagen_url` de `gasto`,
   el archivo tiene que estar en el respaldo de Storage.
   ```sql
   select count(*) from liquidacion where pdf_url is not null;
   select count(*) from gasto      where imagen_url is not null;
   ```
   ```bash
   cut -f2 ~/Desktop/likida-storage/MANIFIESTO.tsv | wc -l
   ```
   Los conteos no tienen por qué coincidir uno a uno (Storage guarda además el
   PDF `-operador` de cada liquidación y los `informes/`), pero **cada ruta de
   la base tiene que aparecer en el manifiesto**. Si falta una, el respaldo no
   está completo y hay que decirlo, no promediarlo.
4. Correr la batería contra la base restaurada:
   `DATABASE_URL=$URL_RESTAURO node scripts/ci/correr-verificaciones.mjs supabase/verificaciones.sql`
5. Borrar la base de prueba.

Anota la fecha de la última prueba de restauración aquí abajo. Sin fecha, no se
ha hecho.

- Última prueba de restauración: **nunca** (22-ago-2026).

### La limpieza de Storage NO libera bytes por sí sola

`limpiar_storage_huerfano()` (mig. 0162) borra del **catálogo**
(`storage.objects`) los objetos cuya flota o cuyo viaje ya no existen; corre
dentro de `mantenimiento_de_datos`, o sea en el cron nocturno `/api/cron/purgar`.
Lo que **no** hace es borrar el blob del almacén S3 —eso solo lo hace la API de
Storage—, así que la factura de almacenamiento no baja sola. Reclamar los bytes
es un barrido aparte con la service role, y hoy no está escrito. La función
nunca toca un objeto de menos de 7 días, ni uno que `comprobante_huerfano` o
`liquidacion_historico` todavía nombren: ver la cabecera de la 0162 y el bloque
134 de `supabase/verificaciones.sql`, que lo demuestra con diez objetos
sembrados.

---

## Rotar el token de WhatsApp

`WHATSAPP_ACCESS_TOKEN` es un token de usuario de sistema de Meta y **caduca**.
Cuando caduca, la Graph API contesta 401 a las descargas de media: el operador
recibe *"No pude descargar tu foto 😕. ¿Me la reenvías?"*, reenvía, y vuelve a
fallar — reenviar no arregla un token vencido, así que el bucle no termina solo.

1. Meta Business Settings → *Usuarios* → *Usuarios del sistema* → el usuario de
   la app → **Generar nuevo token**, con los permisos `whatsapp_business_messaging`
   y `whatsapp_business_management`.
2. ```
   vercel env rm WHATSAPP_ACCESS_TOKEN production
   vercel env add WHATSAPP_ACCESS_TOKEN production
   ```
3. Redespliega (`vercel --prod`): las envs se leen en el arranque de la función.
4. Comprueba con un mensaje de prueba al número de pruebas, no al del cliente.

---

## Variables que deben estar en Vercel

Están todas en `.env.example`, que es el inventario completo y está verificado
contra el código por la suite (`src/lib/observability/runbook.test.ts`). Las
que hay que revisar a mano porque **si faltan el sistema arranca igual** (la
lista viva es `SILENCIOSAS` en `src/lib/observability/arranque.ts`; la suite
falla si entra una ahí y no aquí):

| Variable | Qué pasa si falta |
|---|---|
| `SENTRY_DSN` | No hay alerta de nada. Los errores mueren en el runtime log. |
| `DEMO_TENANT_ID` | El panel consulta el tenant del seed y pinta **cero liquidaciones**, sin log. |
| `ALERTA_EMAIL` | **El único canal push del sistema.** Un cron que falla (`escalar`, `facturar`, `purgar`, `wa-pendientes`, `runner`) y una lectura ilegible del kill switch mandan un correo aquí (`src/lib/observability/alerta.ts`, un correo por evento por hora). Sin ella, el fallo solo existe en Sentry — que notifica una vez por issue y después solo engorda un contador. |
| `NEXT_PUBLIC_APP_URL` | El login arma sus redirects contra `https://app.likida.ai` (el fallback) y no contra el despliegue que los emitió: el magic link y el retorno de Google aterrizan en otro sitio, sin error. |
| `LIKIDA_WHATSAPP_MSG_USD` | El costo por liquidación usa el default 0.008 — y esa cifra decide el precio del producto. |
| `LIKIDA_FLOTA_COOKIE_LLAVE` | El superadmin no puede fijar una flota activa en `/admin` (la cookie no se firma ni se lee: fallar cerrado). Desde la auditoría 18 ya NO cae a la service role key. |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | El límite de tasa cae al Map **por instancia**: 10 intentos de login por 5 min se vuelven 10 × (instancias abiertas en paralelo), y lo mismo el del webhook de WhatsApp, `/v1`, el formulario de leads y los exports. También es el piso de una hora de `alertarOperador`, que sin Redis se cuenta por instancia. **Verificado presente en producción el 22-ago-2026.** El estado vivo se lee en `GET /api/health` → `ratelimit: "redis" \| "memoria"`, y el arranque lo dice en `startup.ratelimit_backend`. |

El gate de `/dashboard` no depende de ninguna variable de entorno: es la
sesión de Supabase Auth, verificada en `proxy.ts` (`RUTAS_CON_SESION`). El
passcode compartido (`DASHBOARD_PASSCODE`/`DASHBOARD_SECRET`, la ruta
`/acceso`) se borró el 5-ago-2026 — llevaba desde que `proxy.ts` se reescribió
sin ningún llamador real (auditoría 10, seguridad).

Para listarlas: `vercel env ls production`.

---

## Auth

### Encender el segundo factor obligatorio del superadmin (SEG-3)

La cuenta de superadmin cruza **todas** las flotas: `is_superadmin()` abre la
RLS entera, `?tenant=` abre el panel de cualquier cliente y `/api/export/*` sus
liquidaciones. Su única puerta es un enlace mágico al correo, así que un
phishing que consiga que pegues un código de seis dígitos entrega la base de
todos los clientes. En producción la protección está **encendida por defecto**;
`LIKIDA_SUPERADMIN_MFA=obligatorio` permite probar el mismo gate fuera de
producción.

La pantalla Mi perfil es la única exenta, así que una cuenta sin factor puede
inscribirlo sin abrir primero datos de una flota. La secuencia, en este orden:

1. **Habilita TOTP en el proyecto de producción**: Supabase → Authentication →
   Multi-Factor → *TOTP: enabled*. (En local es `[auth.mfa.totp]
   enroll_enabled = true` / `verify_enabled = true` en `supabase/config.toml`;
   hoy están en `false`, que es por lo que este paso no se puede saltar.)
2. **Inscribe tu factor** en `https://app.likida.ai/dashboard/mi-perfil` →
   *Seguridad — segundo factor* → «Inscribir». Guarda el secreto en el gestor
   de contraseñas, no solo en el teléfono.
3. **Comprueba que verificas**: escribe el código de la app en esa misma
   pantalla y espera el aviso «Segundo factor verificado».
4. Redespliega y verifica que `/admin` rebota a Mi perfil hasta completar AAL2.
   No hace falta una variable para producción; el default ya es obligatorio.

**Qué cambia con la palanca puesta.** Al abrir `/admin` o cualquier página de
`/dashboard`, una sesión de superadmin sin factor —o con factor pero en AAL1—
rebota a `/dashboard/mi-perfil?exige=…`, con el aviso de qué falta. Esa
pantalla es la **única exenta** (gatearla sería un círculo) y, mientras la
palanca esté puesta, resuelve sin exigir flota elegida. Si Supabase Auth no
contesta, también rebota: fallar cerrado.

**Recuperación de emergencia.** Define temporalmente
`LIKIDA_SUPERADMIN_MFA=desactivado-temporal` en producción y redespliega. Debe
retirarse en cuanto se recupere el factor; dejarla puesta es un hallazgo de
seguridad. La cuenta no queda bloqueada en la base: la exigencia vive en el
código (`src/lib/auth/guard.ts`).

### Dar de baja a alguien de una flota (SEG-1)

La flota lo hace sola desde `/dashboard/usuarios` → «Dar de baja». Son tres
capas y conviene saber qué hace cada una cuando algo se ve raro:

1. `app_user.activo = false` (mig. 0294) — las cuatro funciones de RLS filtran
   por esa columna, así que la base cierra en la siguiente petición aunque el
   JWT siga vigente, y `session.ts` devuelve `null`.
2. **Ban en Supabase Auth** (`ban_duration`) — es lo que mata el *refresh* del
   token: sin él la cookie de 400 días se sigue renovando cada hora. Si el ban
   no entra, la pantalla lo **dice** («la revocación de su sesión no se pudo
   confirmar») y queda `equipo.ban_fallo` en el log; se arregla reactivando y
   volviendo a dar de baja.
3. Bitácora (`usuario.desactivado`) con quién y a quién.

Reactivar levanta el ban. La fila **no se borra nunca**: es el rastro de quién
tuvo acceso y hasta cuándo.

---

## Desplegar

Con el proyecto ya vinculado:

```
vercel --prod
```

Para un entorno nuevo desde cero, `bash scripts/deploy-vercel.sh` vincula el
proyecto, empuja las envs de `.env.local` a production + preview (salta las
`WHATSAPP_*` vacías) y fija `NEXT_PUBLIC_APP_URL` al dominio real.

**No** copies solo "las envs de `.env.example` que tengan valor": ese atajo fue
el que dejó fuera el tenant del demo. El inventario de arriba es el que manda.

### Meta / WhatsApp

- Webhook URL: `https://app.likida.ai/api/webhook/whatsapp`
- Verify token: el valor de `WHATSAPP_VERIFY_TOKEN`.
- El `GET` responde el challenge; el `POST` valida HMAC con `WHATSAPP_APP_SECRET`.
- El webhook responde **200 antes de trabajar** (el trabajo va en `after()`, con
  `maxDuration = 120` en `src/app/api/webhook/whatsapp/route.ts`). Consecuencia
  operativa: **Meta no reintenta**. Un error después del 200 es un mensaje
  perdido, y por eso importa tanto que los errores tengan destino.

---

## Lo que este runbook NO cubre

- **Quién recibe qué cuando algo falla, más allá de un correo.** El canal
  existe: `ALERTA_EMAIL` recibe un correo por cada cron que falla y por cada
  lectura ilegible del kill switch (tabla de arriba), y el monitor de
  `/api/health` (abajo) pinta rojo el workflow si producción no contesta. Lo que
  no hay es guardia ni escalación: si el correo no se lee, nadie más se entera.
- **Qué se hace con una liquidación cerrada cuyo PDF no salió** (`pdf.no_entregado`).
  El operador recibe aviso; el procedimiento de reenvío no está escrito.
- **La retención exacta de los runtime logs** en este plan, ni si hace falta un
  log drain antes del demo.

---

## Publicar un cambio (cambió el 5-ago-2026; compuerta desde el 1-sep-2026)

### El orden es migraciones → verificar → `[deploy]`, y ya no depende de la memoria

Auditoría 24, OP-P1: producción corrió con la base en la migración 0271
mientras `master` pedía la forma 0272 de `poliza_datos_tenant`; publicar sin
migrar rompía el export de póliza y no publicar dejaba 34 arreglos sin vivir.
Ahora hay tres piezas que lo atan:

1. **`/api/health` publica `migracion: {base, codigo, atras, motivo?}`** —
   `base` es la última migración que la base registra aplicada
   (`migraciones_aplicadas()`), `codigo` la última del código que corre
   (`LIKIDA_MIGRACION_CODIGO`, inlineada en build por `next.config.ts`). Con
   `atras > 0` o base ilegible el pulso es `degraded` (503) y `motivo` dice
   qué aplicar.
2. **La compuerta de Vercel.** `vercel.json` corre
   `scripts/ci/compuerta-deploy.mjs` como `ignoreCommand`: lee el asunto del
   commit, la última `supabase/migrations/NNNN_*.sql` del repo y
   `migracion.base` del health de producción. Con `[deploy]` y base atrás
   **no construye**. Health caído o base ilegible tampoco construyen (un cotejo
   que no se hizo no es verde). La única excepción de arranque: si el health
   desplegado todavía no publica `migracion` (versión anterior), construye esa
   vez con aviso. `[deploy:forzar]` en el asunto salta la compuerta a la vista.
3. **El mismo veredicto en rojo, en Actions.** `salud-produccion.yml` corre la
   compuerta en cada push con `[deploy]` (el `ignoreCommand` es mudo; esto no),
   y por `schedule` comprueba además que producción corra el último commit con
   `[deploy]` de `master` (o uno posterior), abre un issue `salud-produccion`
   cuando el pulso pasa a rojo y lo cierra al recuperarse.

El procedimiento, entonces:

```bash
bash scripts/aplicar-migraciones-y-humos.sh   # 1. migraciones a producción
curl -s https://app.likida.ai/api/health | grep -o '"migracion":{[^}]*}'   # 2. atras:0
git commit -m 'fix(x): … [deploy]' && git push   # 3. ahora sí construye
```

**El push a `master` ya no despliega solo.** `vercel.json` trae un
`ignoreCommand` que solo construye cuando **el asunto del commit** —la primera
línea, no el cuerpo— lleva la bandera `[deploy]` (y, desde la auditoría 24,
cuando la compuerta de arriba lo deja pasar).

```
fix(cuadre): redondeo de casetas [deploy]     -> construye y publica
fix(cuadre): redondeo de casetas              -> llega a GitHub, NO publica
```

Antes se redesplegaba en cada push: 30 builds en 12 horas, ~$26 USD/mes de puro
tiempo de build, casi todos publicando arreglos de auditoría que no urgían.
La gráfica de contribuciones de GitHub cuenta commits, no builds, así que
seguir subiendo a `master` todo el día no cuesta nada.

**El modo de falla es silencioso.** Si olvidas la bandera, el push se ve normal
en GitHub y producción se queda atrás sin avisar. Antes de enseñarle el producto
a alguien:

```bash
git log -1 --format='%h %s'                      # tu último commit
vercel inspect likida.ai --scope likida | head   # qué está publicado
```

Si no coinciden, la salida rápida es **Redeploy** en el panel sobre el último
deployment, que no requiere commit nuevo.

**El mismo cotejo, sin ojos:** `/api/health` devuelve `version` (los 7
primeros caracteres del sha desplegado), `db` y `sentry`, sin auth y sin un
solo dato de negocio. El workflow `.github/workflows/salud-produccion.yml` lo
consume de dos formas:

- cada 30 minutos pega a `https://app.likida.ai/api/health` y falla (correo
  de GitHub Actions al dueño del repo, más un issue `salud-produccion` que se
  abre en rojo y se cierra en verde) si no responde 200 con `ok:true`; y
  comprueba que `version` sea el último commit con `[deploy]` de `master` o
  uno posterior;
- tras cada push a `master` cuyo asunto lleve `[deploy]`, corre la compuerta
  de migraciones y luego espera hasta 10 minutos a que `version` coincida con
  el sha pusheado y falla si no — que es exactamente el modo de falla
  silencioso del `ignoreCommand`.

```bash
curl -s https://app.likida.ai/api/health   # {"ok":true,"db":"ok","sentry":"configurado","version":"553bee7",...}
```

Lee solo el asunto a propósito: con el mensaje completo, cualquier commit que
*mencionara* la palabra en el cuerpo disparaba un build. Pasó el mismo día que
se puso la regla.
