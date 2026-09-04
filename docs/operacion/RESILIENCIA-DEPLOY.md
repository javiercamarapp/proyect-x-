# Resiliencia, backup y deploy

Este runbook cubre únicamente Storage, recuperación y despliegue. No sustituye
el contrato de datos ni autoriza una restauración destructiva.

## Objetivos RPO/RTO

Son objetivos operativos hasta que exista evidencia de una ejecución externa.

| Servicio | RPO objetivo | RTO objetivo | Evidencia requerida |
|---|---:|---:|---|
| Base de datos | 24 h mientras no haya PITR | 4 h | dump + restore drill |
| Supabase Storage | 24 h | 8 h | manifiesto + checksum + copia remota |
| Vercel | 0–15 min durante promoción | 15 min | Preview smoke + rollback |

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

## Preview, smoke y promote

`.github/workflows/deploy-preview-promote.yml` implementa:

1. Solo arranca por `workflow_dispatch`; abrir o actualizar un PR jamás expone
   secretos ni despliega automáticamente.
2. Resuelve `ref` una vez a un SHA de 40 caracteres y usa ese mismo SHA en todos
   los jobs, aunque la rama avance mientras corre el workflow.
3. Repite `npm ci`, auditoría runtime, typecheck, lint ratchet, resiliencia,
   cobertura y build antes de obtener credenciales de despliegue.
4. En el environment `staging`, enlaza el proyecto de staging y ejecuta
   el preflight de índices concurrentes de 0332 antes de
   `supabase db push --dry-run`; cualquier secreto ausente o drift falla cerrado.
5. Solo después crea una Preview prebuilt y ejecuta el smoke público sobre su
   URL exacta.
6. Con `promote=true` y la confirmación literal
   `APPLY_MIGRATIONS_AND_PROMOTE`, el environment `production` vuelve a hacer
   dry-run y ejecuta las migraciones reales. Vercel se promueve únicamente si
   ese job terminó en verde.

Configurar los environments `staging`, `preview` y `production` con reviewers
y secretos de mínimo alcance. Staging requiere `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF_STAGING` y
`SUPABASE_DB_URL_STAGING`; producción usa los dos primeros,
`SUPABASE_PROJECT_REF_PRODUCTION` y `SUPABASE_DB_URL_PRODUCTION`. Las dos URL
directas son obligatorias desde 0332: permiten a `psql` crear/verificar los
índices con `CONCURRENTLY` antes de que `supabase db push` abra sus migraciones.
No se derivan ni se imprimen desde la contraseña. Verificar sólo sus nombres,
sin revelar valores, antes de promover:

```bash
gh secret list --repo javiercamarapp/proyect-x- --env staging
gh secret list --repo javiercamarapp/proyect-x- --env production
```

Preview requiere `VERCEL_TOKEN`, `VERCEL_ORG_ID` y `VERCEL_PROJECT_ID`. Sin
ellos no se simula éxito. Nunca usar
el ref móvil `master` para una promoción: pegar el SHA ya revisado del PR.

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
