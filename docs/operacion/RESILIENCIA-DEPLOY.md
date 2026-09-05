# Resiliencia, backup y deploy

Este runbook cubre únicamente Storage, recuperación y despliegue. No sustituye
el contrato de datos ni autoriza una restauración destructiva.

## Objetivos RPO/RTO

Son objetivos operativos hasta que exista evidencia de una ejecución externa.

| Servicio | RPO objetivo | RTO objetivo | Evidencia requerida |
|---|---:|---:|---|
| Base de datos | 24 h mientras no haya PITR | 4 h | dump + restore drill |
| Supabase Storage | 24 h | 8 h | manifiesto + checksum + copia remota |
| Vercel | 0–15 min durante promoción | 15 min | Production staged smoke + rollback |

Un objetivo no es un SLA. Hasta ejecutar la primera corrida programada y un
restore drill con cronómetro, el estado contractual es **no demostrado**.

## Backup programable de Storage

El workflow `.github/workflows/backup-storage.yml` está pensado para correr
diariamente a las 03:17 UTC, pero **el `schedule` está apagado a propósito**
(OPERABILIDAD-19C2-2) hasta que se complete la configuración de abajo: sin
ella fallaba cada noche sobre el único buzón de alertas. Por ahora solo se
dispara con `workflow_dispatch`; reactivar el `schedule` es el último paso
de la lista de "Primera configuración externa pendiente". Usa el environment
de GitHub `production-backup`, no sube comprobantes como artifacts de GitHub
y sincroniza solo hacia el destino remoto configurado. El `aws s3 sync` no
usa `--delete`.

El script canónico es:

```bash
bash scripts/respaldo-storage.sh /ruta/backup
```

Cada corrida produce:

- `MANIFIESTO.json`: formato versionado, bucket, ruta, bytes y SHA-256.
- `MANIFIESTO.tsv`: formato legible para revisión.
- `MANIFIESTO.sha256`: lista estándar de hashes.
- `RESPALDO_COMPLETADO_UTC`: marca de finalización.

El script vuelve a comprobar el tamaño y el SHA-256 aunque el archivo local ya
existiera. Falla si Storage responde cero objetos, salvo que se configure
explícitamente `RESPALDO_ALLOW_EMPTY=true`.
En el remoto los objetos se sincronizan primero, después los tres manifiestos,
se vuelve a descargar y comparar `MANIFIESTO.json`, y solo al final se publica
`RESPALDO_COMPLETADO_UTC`. La presencia de esa marca es la señal de corrida
completa; un prefijo sin ella no se restaura.

### Variables del backup

| Variable | Dónde | Requerida | Uso |
|---|---|---:|---|
| `NEXT_PUBLIC_SUPABASE_URL` | GitHub secret/local | Sí | Proyecto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | GitHub secret/local | Sí | Lectura administrativa de Storage |
| `RESPALDO_S3_DESTINO` | GitHub secret/local | CI | `s3://bucket/prefijo` o R2 compatible |
| `AWS_ACCESS_KEY_ID` | GitHub secret | Si S3 | Credencial de escritura limitada |
| `AWS_SECRET_ACCESS_KEY` | GitHub secret | Si S3 | Credencial de escritura limitada |
| `AWS_SESSION_TOKEN` | GitHub secret | Opcional | Credencial temporal |
| `AWS_REGION` | GitHub variable | No | Default `us-east-1` |
| `AWS_ENDPOINT_URL` | GitHub secret | Solo R2/S3 compatible | Endpoint HTTPS del proveedor |
| `RESPALDO_BUCKETS` | GitHub variable | No | Default: `comprobantes liquidaciones avatares bus` |
| `RESPALDO_REQUIRE_REMOTE` | Entorno | CI | Debe ser `true` en el workflow |
| `RESPALDO_ALLOW_EMPTY` | GitHub variable | No | Default `false`; cambiarlo requiere justificarlo |
| `RESPALDO_ROOT` | Runner | No | Directorio temporal/local |

La llave de Supabase debe ser de solo lectura efectiva para Storage cuando la
política de operación lo permita, y la identidad S3 debe poder escribir solo
el prefijo de backup. El bucket remoto debe tener cifrado, versioning y una
cuenta separada; Object Lock/WORM es recomendado para evidencia fiscal.

### Primera configuración externa pendiente

Antes de llamar “verde” al backup programado, un administrador debe:

1. Crear el environment `production-backup`.
2. Cargar los secretos y configurar revisores si la política lo exige.
3. Crear el bucket remoto con versioning, cifrado, lifecycle y retención.
4. Probar el workflow manualmente.
5. Comprobar que `MANIFIESTO.json` y `MANIFIESTO.sha256` existan en el remoto.
6. Registrar el tamaño, cantidad de objetos, hora y duración.
7. Reactivar el `schedule` en `backup-storage.yml` (se apagó a propósito en
   OPERABILIDAD-19C2-2 para no fallar cada noche mientras esto seguía
   pendiente).

Si falta una credencial, el workflow falla cerrado. No se debe poner una llave
real en `.env`, logs, artifacts o comentarios de PR.

## Restore drill seguro

Por defecto solo valida y no escribe:

```bash
bash scripts/restore-storage-drill.sh /ruta/backup
```

Para copiar a un destino local nuevo, explícito y no destructivo:

```bash
bash scripts/restore-storage-drill.sh /ruta/backup \
  --apply --destination /ruta/restauracion
```

Reglas:

- No existe modo de escribir directamente a Supabase.
- `--apply` exige `--destination`.
- El destino no puede ser el backup original ni `/`.
- Un archivo existente con el mismo hash se conserva.
- Un conflicto existente falla; `--overwrite` es una decisión separada y explícita.
- Nunca se borra un archivo del destino.
- Rutas absolutas, `..`, buckets inválidos, escapes por symlink y tamaños/hash inconsistentes detienen la prueba.

El restore drill de producción debe ejecutarse en un proyecto o volumen
aislado, cotejar las rutas referenciadas por la base y registrar el RTO. La
primera prueba externa sigue pendiente porque este entorno no tiene credenciales
ni un Supabase local disponible.

## Preview, candidato Production, smoke y promoción

`.github/workflows/deploy-preview-promote.yml` es manual. Recibe un SHA revisado,
lo fija una sola vez y usa ese mismo commit en todos los jobs. Serializa el
release completo (`vercel-release-likida`, sin cancelar la ejecución anterior).
Los pushes de Git pueden crear intentos separados en Vercel; la compuerta
`scripts/ci/compuerta-deploy.mjs` conserva su política de mensajes y migraciones.
Este workflow no desactiva esa integración ni autoriza usar `[deploy:forzar]`.

El grafo es:

1. SHA inmutable → calidad completa (npm ci, auditoría runtime estricta (`audit-runtime.mjs`), typecheck,
   lint ratchet, resiliencia, cobertura y build).
2. Staging autorizado: comprobar ref → `supabase link` → preflight concurrente 0335
   → `db push --dry-run` → `db push`. Se aplica primero en la rama existente
   `dmhhygwzgudwgcbixuwp`, separada de Production `gngoqsvrxdguxvsizpbw`.
3. Preview prebuilt con metadata `releaseSha` → smoke de navegador protegido,
   sólo GET/HEAD sobre `/`, `/terminos` y `/privacidad`.
4. Sólo con `promote=true` y `APPLY_MIGRATIONS_AND_PROMOTE`: consultar backups
   SQL gestionados → exigir uno `COMPLETED` de las últimas 24 h → link Production
   → preflight 0335 → dry-run → aplicar migraciones.
5. Capturar ID actual y destino Cron → `pull --environment=production` →
   validar URL/ref/roles Supabase de Production →
   `build --prod` → `deploy --prebuilt --prod --skip-domain`. Inspeccionar
   proyecto, target Production, estado READY y SHA; conservar el ID devuelto.
6. Comprobar que alias y destino Cron no cambiaron durante la creación.
   Ejecutar smoke de navegador sobre ese ID y `/api/health`: requiere estado
   sano, versión del SHA revisado y migraciones al día.
7. Revalidar ID y alias anterior → `promote` del mismo ID → comprobar que
   `app.likida.ai` y `likidaai.vercel.app` resuelven exactamente a ese ID. No se promueve una Preview.

La distinción importa: [promover una Preview reconstruye con entorno
Production](https://vercel.com/docs/deployments/promoting-a-deployment);
un [Production staged](https://vercel.com/docs/cli/deploying-from-cli)
se activa sin reconstrucción. `--skip-domain` evita asignar los dominios al
crear el candidato, pero **no convierte Production en una base aislada**.
Usa secretos y datos reales. Los smokes no ejecutan acciones humanas, ingesta,
OCR, SAT/PAC, envíos ni llamadas manuales a Cron.

La [documentación de Cron](https://vercel.com/docs/cron-jobs) señala que usa la
URL de Production, pero no garantiza expresamente la ausencia de efectos de
un staged deployment. La comparación de `project.crons.deploymentId` detecta
un cambio después de ocurrir; no previene una ejecución que ya haya empezado.
Si cambia, el pipeline se detiene y requiere revisar logs/efectos antes de
continuar. No se eliminan los crons del artefacto para simular aislamiento.
Antes de construir Preview, el pipeline comprueba el URL y el ref/rol JWT de
las dos credenciales Supabase descargadas por `vercel pull`: deben pertenecer
al staging autorizado. Si las entradas siguen compartidas con Production,
falla antes del build. No basta con que el environment se llame Preview.
Las credenciales opacas nuevas requieren actualizar esta comprobación con un
mecanismo verificable; no se aceptan sin poder vincularlas al ref esperado.

### Credenciales y preflight SQL

Staging necesita los secretos existentes `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_DB_PASSWORD` y `SUPABASE_PROJECT_REF_STAGING`; Production usa los
mismos dos primeros y `SUPABASE_PROJECT_REF_PRODUCTION`. Los secretos
`SUPABASE_DB_URL_STAGING` y `SUPABASE_DB_URL_PRODUCTION` son opcionales.
Después de `link`, el helper lee `.temp/project-ref` y `.temp/pooler-url`.
Acepta sólo el session pooler Supabase en puerto 5432, base postgres y rol
`postgres.<ref>`; la alternativa directa exige `db.<ref>.supabase.co` y
rol postgres. Rechaza hosts externos, transaction pooler 6543 y parámetros que
puedan cambiar host/rol. La contraseña va en `PGPASSWORD`, nunca en argv,
logs ni outputs. El preflight usa `sslmode=verify-full&sslrootcert=system`:
[libpq 16 soporta CA del sistema y verifica hostname](https://www.postgresql.org/docs/16/libpq-connect.html).
Si el runner o la cadena de confianza no lo soporta, falla; no rebaja TLS.

Vercel CLI está fijada en 59.1.4 y lee `VERCEL_TOKEN` del entorno. Preview y
Production requieren ese secreto. Los identificadores públicos del proyecto
verificado están fijados en el workflow y en la guarda:
`prj_OnrG9eY8WQzj35I3jtAZX2wTJ2sn`, team
`team_uelpa362TxivuQUHNzTGLWNv`. El repositorio canónico es
`javiercamarapp/proyect-x-`; los dominios son `app.likida.ai` y
`likidaai.vercel.app`. El apex `likida.ai` pertenece al proyecto landing.

El smoke usa el mecanismo de [bypass de automatización de
Vercel](https://vercel.com/docs/cli/curl), implementado con fetch para evitar
pasar el token a argv de curl. Reutiliza un bypass existente sin modificarlo;
si falta, el workflow autorizado crea uno propio y lo revoca en `finally`,
aunque falle la creación o el smoke. Una revocación fallida bloquea el job y
emite un error administrativo. Un runner terminado abruptamente puede impedir
el `finally`: revisar entonces los bypass del proyecto. La cookie privada 0600
se limita al host exacto, se borra al terminar y nunca se sube como artifact.
No se desactiva Deployment Protection. La pantalla de login de Vercel, un
redirect a otro origin o un navegador con errores no cuentan como PASS.

### Alcance de backup y evidencia externa

El GET [Management API de backups](https://supabase.com/docs/reference/api/v1-list-all-backups)
comprueba existencia/frescura mínima: estado COMPLETED y fecha pasada dentro
de 24 h. Un flag PITR sin backup fresco no pasa. Esto **no demuestra restore,
RPO aceptado ni respaldo de objetos Storage**. No descarga ni restaura datos.
Si el destino S3/R2 de Storage no está configurado y verificado, el respaldo
completo sigue pendiente; este gate SQL no permite declararlo listo.

Configurar revisores y restricciones de environments según la política de
operación: el nombre `production` por sí solo no implica aprobación humana.
Conservar como evidencia del release el SHA, ID anterior/candidato/final,
fecha del backup SQL, estado de migraciones, smoke y alias final; jamás secretos.
Antes de ejecutar, revisar sólo nombres de secretos:

```bash
gh secret list --repo javiercamarapp/proyect-x- --env staging
gh secret list --repo javiercamarapp/proyect-x- --env production
```

Una falla después de migrar conserva las migraciones ya aplicadas y el dominio
anterior; no existe rollback SQL automático. Revisar compatibilidad hacia
atrás antes de autorizar el release y registrar cualquier efecto de Cron.

## Rollback

`.github/workflows/rollback-production.yml` es manual y requiere:

- `deployment_url` HTTPS exacta del deployment estable.
- Confirmación literal `ROLLBACK_PRODUCTION`.
- Aprobación del environment `production`.
- `VERCEL_TOKEN` válido.

El rollback no adivina “el anterior” ni recibe una URL vacía. Después de usarlo,
verificar `/api/health`, el digest desplegado, logs y el flujo crítico. Registrar
la causa y la migración asociada antes de reintentar la promoción.

## Supply chain

Las Actions de los workflows se fijan por SHA completo con comentario de
versión. El servicio de Postgres de CI usa la imagen multi-arquitectura
`postgres:16.4` fijada al digest `sha256:e62fbf9d3e2b49816a32c400ed2dba83e3b361e6833e624024309c35d334b412`.
Dependabot mantiene los SHA y abre PRs agrupados semanalmente; el comentario de
versión debe actualizarse en el mismo PR. No se deben reintroducir tags mutables
como `@v4` o `postgres:16` sin una excepción documentada.

## Validación local

```bash
bash -n scripts/respaldo-storage.sh scripts/restore-storage-drill.sh \
  scripts/test-resiliencia.sh
bash scripts/test-resiliencia.sh
```

Si está instalado, ejecutar también `shellcheck` sobre los tres scripts. La
validación contra Supabase, AWS, Vercel, GitHub environments y el restore real
es deliberadamente externa y debe quedar registrada como evidencia de release.
