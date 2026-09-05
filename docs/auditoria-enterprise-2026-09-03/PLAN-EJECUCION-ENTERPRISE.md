# Plan de ejecución enterprise de Likida

## Restricciones globales

- Objetivo: al menos 5 tenants, 5,000 camiones/operadores y 50,000 viajes/mes.
- No quedan P0/P1 abiertos al promover.
- Auditor, constructor y reauditor no comparten el veredicto de una tarea.
- Un reporte del constructor es evidencia inferida hasta que root repite dos o
  tres comandos y un reauditor independiente aprueba.
- Producción y proveedores reales son sólo lectura salvo autorización expresa.
- No se borran, relajan ni omiten pruebas para obtener verde.
- Se preserva la historia con commits legítimos; no hay commits vacíos.
- Cada resultado usa PASS, FAIL, TRUNCATED, NO-ARTIFACT o SKIPPED.

## Task 1 — GPS, cámaras y entrega crítica

Cerrar el P0/P1 de identidad de activo, asociación histórica viaje/operador,
privacidad pre-aviso, intención WhatsApp durable, receipt, DLQ y salud del cron.
Probar migración 0324 desde PostgreSQL 17 limpio, dos workers, reintentos y flujo
evento→persistencia→incidencia→outbox→receipt. Samsara/Meta reales son SKIPPED
sin credenciales autorizadas.

## Task 2 — CRM y Cal.com

Cerrar terminales sin CREATED, estados oficiales, límite temporal por elemento,
secreto/SSRF, retención e idempotencia, poison pills y watermark durable. Probar
snapshot→ledger→prospecto, reentrega después de purga, evento futuro, correo aún
sin prospecto, segundo barrido lento, IPv4/IPv6 privadas, 429/5xx controlados y
concurrencia PostgreSQL 17.

## Task 3 — Capacidad WhatsApp y jornada laboral

Cerrar reapertura histórica después de retención, atribución GPS de unidad
compartida, invalidación/versionado de cierre y conformidad, procedencia
multiunidad y equidad del drenado. Probar DST, tenant cruzado, 13k mensajes,
5,000 trabajos completos y concurrencia con fencing.

## Task 4 — PostgreSQL, almacenamiento y rendimiento

Clasificar advisors por riesgo y workload; no añadir índices a ciegas. Reproducir
las consultas con spill observadas, medir EXPLAIN/BUFFERS, conexiones, tamaño,
retención y aislamiento. Probar base limpia, upgrade desde la versión de
producción, `verificaciones.sql`, backup y restore con RPO/RTO medidos.

## Task 5 — Auth, permisos y seguridad de aplicación

Construir matriz allow/deny por rol y tenant. Auditar RLS, helpers SECURITY
DEFINER, MFA/AAL2, CSRF, SSRF, webhooks, secretos, rate limiting distribuido,
caché por tenant, headers, supply chain y redacción de PII. Cero efecto lateral
en 401/403 y cero acceso cruzado.

## Task 6 — Observabilidad y operación

Eliminar falsos verdes de crons, colas y proveedores. Distinguir sano, parcial,
no configurado, degradado, muerto y sin artefacto. Probar correlación, backlog,
DLQ, alerta, runbook y recuperación; incluir `facturar`, `portales-vivos`, GPS,
SAT, WA, QStash y Sentry. Servicios sin conector quedan SKIPPED/NO-ARTIFACT.

## Task 7 — Producto, frontend y responsabilidades

Inventariar rutas, server actions, botones, formularios y estados por operador,
encargado, contador, administrador, vendedor y superadmin. Probar navegación,
vacío/carga/error/éxito, accesibilidad y rechazo de acciones prohibidas. La
verificación visual usa únicamente el navegador elegido por Javier.

## Task 8 — Diseño de sistema y arquitectura

Documentar límites, fuentes de verdad, consistencia, colas, contratos, regiones,
cuotas, puntos únicos de falla y degradación. Entregar diagramas/ADR vinculados
a invariantes ejecutables, no descripciones aspiracionales.

## Task 9 — Flujo operacional, fiscal y terceros

Ejecutar WhatsApp→OCR→cuadre→cierre→revisión→PDF→entrega→export/timbrado con
fallos en cada frontera. Probar CFDI/Carta Porte, snapshots, duplicados,
reconciliación, GPS, PAC, SAT, Meta, correo y ERP con dobles. Separar validación
técnica de opinión fiscal/legal y contratos externos.

## Task 10 — Escala, soak, recuperación y release

Ejecutar 5 tenants, 5,000 camiones, 50,000 viajes, escenario central de 150,000
documentos y ráfaga de 25,000 imágenes. Medir p50/p95/p99, error, conexiones,
spill, backlog y recuperación 24h. Después correr typecheck, lint, build, suite,
cobertura, SCA, migraciones, E2E, restore, canary y rollback.

## Task 11 — Revisión transversal y calificación

Un revisor con contexto limpio audita el diff completo de la rama, el ledger y
los gates. Corregir una sola ola final, reauditarla y calificar del 1 al 10 por
rubro, preparación de piloto, escala enterprise y diligencia YC/a16z. La nota
debe incluir qué está verificado, inferido e incierto y qué evidencia externa
falta.
