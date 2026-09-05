# Capacidad y recuperación sintética para Transportes Innovativos

Estado: evidencia SQL local aprobada en el alcance descrito. Soak de 24 horas **en curso**, sin calificación final. No constituye autorización de producción ni certificación de 50,000 viajes mensuales E2E.

## Entorno y método

Skills aplicadas: `auditoria-saas-exhaustiva` y `supabase-postgres-best-practices`, con foco en capacidad, concurrencia, aislamiento, índices y recuperación. PostgreSQL local 17, esquema hasta 0339, auth/storage del andamio de CI. Las bases se crearon por este arnés en el cluster UNIX `/private/tmp/likida-db-r3.d0fCDX:55501`; nunca se tocaron datos reales ni las pilas UX compartidas. No se modificaron parámetros de PostgreSQL, migraciones ni código de producto durante estas pruebas.

Base de carga: `innovativos_cap_20260904`. Base restaurada: `innovativos_cap_20260904_restored`. Soak separado: `innovativos_cap_soak_20260904`. Upgrade histórico: `innovativos_cap_upgrade_20260904_r2`.

## Dataset y ráfaga

Cinco tenants sintéticos, 5,000 unidades y operadores, 50,000 viajes y 150,000 gastos-documentos. El tenant piloto representa 800 unidades, 15,000 viajes y 45,000 documentos; los demás completan el escenario de expansión. La preparación tomó 21.405 segundos en lotes de 250 viajes y 500 documentos. RLS para cinco usuarios `authenticated` mostró los conteos esperados y cero documentos ajenos.

La ráfaga de 25,000 transacciones usó diez conexiones y dos workers. Cada transacción agregó **metadatos sintéticos** en `comprobante_huerfano` y leyó cien documentos. Resultado: 25,000 éxitos, cero fallos, 1.504 segundos de corrida, p50 0.504 ms, p95 0.919 ms, p99 1.386 ms, máximo 17.104 ms. Los cinco tenants recibieron 5,108/5,050/4,951/4,968/4,923 metadatos según una semilla aleatoria fija.

Esto no son 25,000 imágenes subidas ni 25,000 inferencias OCR: hubo cero bytes de imagen y cero llamadas a proveedores. El texto OCR de cada documento es sintético. Los viajes usan estado liquidado sin liquidaciones fiscales emitidas; la carga no valida todo el proceso financiero.

## Índices y fairness

Se ejecutaron nueve consultas `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` contra tablas pobladas, sin `enable_seqscan=off` ni índices nuevos. Las consultas de paginación reproducen parte del reporte del bloque 40 de `supabase/verificaciones.sql`; las demás siguen consultas de `getDocumentos`, `gastoExistePorHash`, `getHuerfanos` y la búsqueda de unidad/día usada en claims GPS.

| Consulta | Índice elegido | Ejecución observada |
|---|---|---:|
| Documentos recientes | gasto_reciente_idx | 1.396 ms |
| Duplicado por hash | uq_gasto_img_hash | 0.466 ms |
| Huérfanos por operador | idx_huerfano_pendiente | 0.272 ms |
| Unidad/día | viaje_unidad_dia_ambiguidad_idx | 0.285 ms |
| Página de gastos, offset 1,000 | gasto_paginacion_idx | 1.762 ms |
| Página de gastos, offset 44,000 | gasto_paginacion_idx | 15.038 ms |
| Página de viajes | viaje_paginacion_idx | 1.937 ms |
| Página de huérfanos | comprobante_huerfano_paginacion_idx | 2.993 ms |
| Viajes recientes | viaje_reciente_idx | 0.746 ms |

No se demostró una necesidad de índices adicionales en esas consultas. Las tablas no pobladas de los restantes casos del bloque 40 no se califican con esta carga. Los tiempos cambian entre lecturas calientes y frías; los JSON conservan hits/reads exactos.

Claims secuenciales: dos lotes de diez, dos por tenant en cada lote, sin solape. Claims concurrentes reales: dos sesiones simultáneas sostuvieron locks durante un segundo, obtuvieron veinte trabajos distintos y cuatro por tenant en el agregado. La distribución por worker puede ser desigual por `SKIP LOCKED`, incluso cuatro/cero para un tenant; el arnés no promete igualdad individual. La primera expectativa de dos por tenant por worker concurrente se descartó como más fuerte que el contrato observado; se conservaron los resultados por worker y se verificó la igualdad global sin relajar la prohibición de solape.

## Recuperación lógica

Dump local: 23,234,585 bytes, 1.483 segundos. Restore en base nueva: 4.379 segundos. Ciclo local de crear, restaurar, comparar y verificar RLS: 21.780 segundos.

Se compararon conteos y checksums de **todas las columnas** de las filas sintéticas de estas siete tablas: `tenant`, `app_user`, `unidad`, `operador`, `viaje`, `gasto`, `comprobante_huerfano`. Coincidieron. RLS posterior mostró unidades/viajes/documentos de cada tenant y cero documentos ajenos para los cinco usuarios.

El dump incluye la base lógica; la verificación de hashes no abarca todas sus tablas. No se probaron blobs de Storage, Supabase Auth real, PostgREST, traslado externo, PITR/WAL replay ni reconstrucción de infraestructura. Es recuperación del snapshot local sobre la misma máquina y disco; no es un RTO/RPO productivo.

## Upgrade desde historial 0303

Se aplicaron 281 migraciones locales hasta 0303 en una base vacía, se sembraron 800 unidades/operadores, 15,000 viajes y 45,000 documentos y se aplicaron las 33 migraciones locales posteriores hasta 0339, incluido el preflight concurrente requerido antes de 0332. Upgrade y comprobación: 0.966 segundos observados. Conteos y campos de negocio seleccionados en `snapshot()` se conservaron.

El primer intento de la fixture incluyó `tenant.zona_horaria`, columna inexistente en 0303. Se corrigió la fixture y se creó otra base; no se trató ese fallo de preparación como defecto de producto. Esta prueba reproduce el historial local y datos sintéticos; no demuestra ausencia de drift o datos incompatibles en producción.

## Soak de 24 horas reales

Smoke de 60 segundos: 129 transacciones, cero errores/deadlocks, p95 11.072 ms, p99 14.281 ms, máximo 14.708 ms; sin locks observados. Espacio inicial disponible: aproximadamente 189 GiB. Base del soak: 484,202,163 bytes.

Inicio: **2026-09-05 02:50:29 UTC**. Fin previsto: **2026-09-06 02:50:29 UTC**. En Mérida corresponde al 4 de septiembre a las 20:50:29 y al 5 de septiembre a las 20:50:29. Runner PID 19175, pgbench PID 19208; los PID pueden dejar de existir al terminar y no son una prueba de finalización.

Cinco conexiones/dos workers, tasa global de dos transacciones por segundo, mezcla 80% lectura, 10% actualización de ruta, 10% alta de metadatos. Telemetría cada treinta segundos. Aceptación y límites están en README. El proceso usa runtime congelado y una huella del esquema 0339 conservados en `soak24h/`.

Último muestreo de este reporte, aproximadamente diez minutos tras el inicio: 1,162 transacciones, cero fallos/deadlocks, p95 8.552 ms, p99 11.491 ms, máximo 198.269 ms, cero locks observados. **No se califican todavía las 24 horas.** El backlog de jornadas se observa pero la mezcla no lo produce ni drena; no implica capacidad de procesamiento GPS/WhatsApp/OCR.

Stop seguro: crear `/private/tmp/innovativos-capacidad/soak24h/STOP`. El resultado definitivo debe leerse en `soak-finished.json` y recalcularse con `run.py summary`; un proceso interrumpido o un archivo incompleto no aprueban la corrida.

## Artefactos

- `/private/tmp/innovativos-capacidad/baseline/`: seed, ráfaga, logs pgbench, nueve planes, claims, dump y checksums antes/después.
- `/private/tmp/innovativos-capacidad/upgrade/`: logs por migración, SHA256 y resultados.
- `/private/tmp/innovativos-capacidad/smoke/`: smoke de 60 segundos.
- `/private/tmp/innovativos-capacidad/soak24h/`: runtime congelado, schema, PID, telemetría y resultados al terminar.
- Reproducción versionable: `scripts/ci/innovativos-capacidad/README.md` y sus scripts.

Pendientes fuera de este alcance: finalización de las 24 horas, E2E con proveedores autorizados, imágenes y Storage reales, cuota/costo por flujo, carga HTTP distribuida, backup externo/PITR y verificación de drift productivo antes de un despliegue.
