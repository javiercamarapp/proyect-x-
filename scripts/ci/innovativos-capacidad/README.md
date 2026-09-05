# Capacidad SQL local para Transportes Innovativos

Este arnés mide SQL y recuperación lógica con datos sintéticos. No envía HTTP a proveedores, no carga archivos a Storage y no ejecuta OCR. No certifica viajes mensuales, comportamiento E2E, costos productivos ni RTO/RPO de infraestructura.

## Requisitos y aislamiento

- PostgreSQL 17 con `psql`, `createdb`, `pgbench`, `pg_dump` y `pg_restore` en PATH; Python 3.9 o superior.
- Cluster **local de auditoría**, accesible mediante socket UNIX. `--host` exige una ruta absoluta con `.s.PGSQL.<puerto>` de tipo socket. TCP remoto se rechaza.
- Rol local autorizado para crear bases. La preparación crea una base nueva; nunca reemplaza una existente ni termina conexiones ajenas.
- Base plantilla con las migraciones locales hasta 0339 y andamio de `supabase/pruebas-aislamiento/andamio_ci.sql`. `--template` permite indicar esa base. Se exige la FK `jornada_trabajo_operador_tenant_fkey` de 0339.
- Al menos 5 GiB libres para la prueba; el dataset observado consume aproximadamente 484 MB por copia, más dump y logs.
- Todas las bases destino deben comenzar con `innovativos_cap_`. Los comandos posteriores exigen además el marcador de propiedad creado durante el seed.

No usar el cluster compartido de desarrollo ni un proxy hacia producción. El socket usado durante esta auditoría fue `/private/tmp/likida-db-r3.d0fCDX`, puerto `55501`, con plantilla local `likida_sql339_root`. Las bases de prueba y sus archivos se conservan para revisión; su eliminación es manual y fuera del arnés.

## Reproducción

Ejecutar desde la raíz del repositorio, sustituyendo socket, puerto, plantilla y nombres por los de un cluster local de auditoría. Usar un nombre nuevo y un directorio de salida nuevo por corrida.

```sh
python3 scripts/ci/innovativos-capacidad/run.py seed --db innovativos_cap_ejemplo --out /private/tmp/innovativos-ejemplo --host /ruta/socket/local --port 55459 --template plantilla_0339
python3 scripts/ci/innovativos-capacidad/run.py bench --db innovativos_cap_ejemplo --out /private/tmp/innovativos-ejemplo --host /ruta/socket/local --port 55459
python3 scripts/ci/innovativos-capacidad/run.py explain --db innovativos_cap_ejemplo --out /private/tmp/innovativos-ejemplo --host /ruta/socket/local --port 55459
python3 scripts/ci/innovativos-capacidad/run.py fairness --db innovativos_cap_ejemplo --out /private/tmp/innovativos-ejemplo --host /ruta/socket/local --port 55459
python3 scripts/ci/innovativos-capacidad/fairness_concurrent.py --db innovativos_cap_ejemplo --out /private/tmp/innovativos-ejemplo --host /ruta/socket/local --port 55459
python3 scripts/ci/innovativos-capacidad/run.py restore --db innovativos_cap_ejemplo --out /private/tmp/innovativos-ejemplo --host /ruta/socket/local --port 55459
```

`seed` crea cinco tenants: el primero tiene 800 unidades, 800 operadores, 15,000 viajes y 45,000 gastos-documentos; los otros cuatro tienen cada uno 1,050 unidades/operadores, 8,750 viajes y 26,250 documentos. Total: 5,000 unidades, 5,000 operadores, 50,000 viajes y 150,000 documentos. Los viajes se insertan en lotes de 250 y los gastos en lotes de 500; no se promete una transacción de 50,000 viajes. Los viajes sintéticos tienen estado liquidado sin una liquidación fiscal emitida: no representan el proceso de liquidación completo.

`bench` realiza 25,000 transacciones con diez conexiones: cada una inserta un metadato sintético de imagen en `comprobante_huerfano` y lee cien documentos. Las rutas `synthetic://` no contienen archivos reales. No repetir `bench` sobre la misma base: el conteo de aceptación espera exactamente 25,000 filas de esa ráfaga.

`fairness` demuestra dos claims secuenciales de diez con dos filas por tenant y leases sin solape. `fairness_concurrent.py` exige una cola propia inicialmente vacía, siembra 5,000 trabajos, sostiene locks un segundo en dos sesiones simultáneas y comprueba veinte claims distintos con cuatro por tenant en el agregado. `SKIP LOCKED` puede repartirlos de forma desigual entre cada worker (incluso cuatro/cero para un tenant); no se afirma igualdad por worker concurrente.

`restore` crea `<db>_restored` sin reemplazar ninguna base. El dump comprende la base lógica, pero la comparación de todas las columnas se limita exactamente a `tenant`, `app_user`, `unidad`, `operador`, `viaje`, `gasto` y `comprobante_huerfano` del dataset sintético. Se comprueban conteos y hashes de filas ordenadas. RLS usa los cinco usuarios `authenticated` y verifica unidades, viajes, documentos y cero documentos ajenos. No valida blobs de Storage, Supabase Auth real, PostgREST, PITR ni copia externa.

## Upgrade histórico sintético

```sh
python3 scripts/ci/innovativos-capacidad/upgrade.py --db innovativos_cap_upgrade_ejemplo --out /private/tmp/innovativos-upgrade-ejemplo --host /ruta/socket/local --port 55459
```

Crea una base vacía, aplica el andamio y las 281 migraciones locales hasta 0303, siembra 800 unidades/operadores, 15,000 viajes y 45,000 documentos, y aplica las 33 migraciones posteriores hasta 0339. Ejecuta el preflight concurrente de índices antes de 0332. Conserva logs y SHA256 de cada migración nueva. Compara los campos de negocio enumerados en `snapshot()`; no afirma identidad de todas las columnas ni ausencia de drift productivo. La zona horaria aún no existía en 0303 y no se incluye en la fixture inicial.

## Soak de 24 horas reales

Clonar primero la base preparada a otra base propia para que el soak no comparta escrituras con auditorías/fixtures. Ejecutar un smoke breve antes de la corrida larga:

```sh
python3 scripts/ci/innovativos-capacidad/run.py soak --db innovativos_cap_soak_ejemplo --out /private/tmp/innovativos-soak-smoke --host /ruta/socket/local --port 55459 --seconds 60 --rate 2
python3 scripts/ci/innovativos-capacidad/run.py soak --db innovativos_cap_soak_ejemplo --out /private/tmp/innovativos-soak-24h --host /ruta/socket/local --port 55459 --seconds 86400 --rate 2
python3 scripts/ci/innovativos-capacidad/run.py summary --db innovativos_cap_soak_ejemplo --out /private/tmp/innovativos-soak-24h --host /ruta/socket/local --port 55459 --seconds 86400 --rate 2
```

Cinco conexiones, dos workers, tasa global de dos transacciones por segundo. Mezcla: 80% lecturas de bandeja/deduplicación, 10% actualización de ruta de imagen sintética, 10% alta de metadatos. Los percentiles de pgbench incluyen el transporte por socket y la planificación de la tasa; no son percentiles API ni exclusivamente tiempo del motor SQL. La aceptación exige duración completa, al menos 90% de transacciones objetivo, cero errores/deadlocks, p95 menor a 250 ms y p99 menor a 1,000 ms. No se aumenta la tasa para sustituir el paso de 24 horas.

Telemetría cada 30 segundos: tamaño de base, conexiones, locks, deadlocks, backlog de jornadas y espacio libre. La mezcla no produce ni drena trabajo GPS/OCR; un backlog de jornadas en cero no demuestra drenaje de esos proveedores.

Para detener con seguridad, crear el archivo `STOP` en el directorio de salida. El runner responde aproximadamente en un segundo, interrumpe pgbench y registra el motivo; una interrupción no se califica como 24 horas completas. También se detiene si el espacio libre cae bajo 5 GiB, la base supera `2 × tamaño inicial + 512 MiB` o un lock espera más de cinco segundos. No cambia configuraciones de PostgreSQL.

## Evidencia del 4–5 de septiembre de 2026

Reporte y artefactos completos: `/private/tmp/innovativos-capacidad/REPORT.md`. El soak iniciado el 5 de septiembre a las 02:50:29 UTC utiliza una copia congelada del runtime en `soak24h/runtime`; los cambios posteriores de estos scripts no alteran ese proceso. Fin previsto: 6 de septiembre a las 02:50:29 UTC. Su estado se conserva en `soak24h/soak-process.json`, `soak-telemetry.jsonl` y, cuando termine, `soak-finished.json`.


### Resultado del primer intento largo

El intento iniciado el 5 de septiembre a las 02:50:29 UTC quedó **NO APROBADO** y se detuvo mediante `STOP` aproximadamente a las 20:19:09 UTC. Duró 17 h 28 min 40 s; `completed_full_duration=false`. El Mac entró repetidamente en reposo y la latencia programada final incumplió los umbrales (p95 902,529.732 ms, p99 990,498.052 ms). Se conservaron las muestras originales; la diferencia entre latencia y retraso de planificación se usa sólo para diagnóstico, nunca para aprobar la corrida. La repetición está pendiente de condiciones de energía/host acordadas. No hay otro soak iniciado. Ver el cierre fechado en `RESULTADOS-2026-09-04.md`.
