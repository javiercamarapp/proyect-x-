# Revisión de CodeQL del PR 332

Fecha: 5 de septiembre de 2026. Check inicial: `101386370150`, sobre el candidato `8439e2d9`. El análisis terminó correctamente, pero su control de alertas falló; no se presenta como aprobación de seguridad.

## Flujos revisados individualmente

| Alerta | Evidencia y decisión |
| --- | --- |
| 180 — metadatos de red escritos a archivo | La API fija de Vercel devuelve metadatos públicos. El candidato se valida por proyecto, SHA, ID, estado READY, target y URL; el baseline también exige IDs sin saltos de línea antes de generar outputs. El archivo destino es `GITHUB_OUTPUT` del runner. Es el canal intencional de tres outputs, no una ruta elegida por HTTP ni contenido ejecutable. Clasificación residual: falso positivo. Refuerzo en `0d00f90d`; 26 pruebas del pipeline aprobadas. |
| 226 — archivo usado por petición TLS de prueba | La fuente es un certificado sintético creado con OpenSSL en un directorio temporal propio. Se usa como CA de confianza, no como cuerpo, cabecera o clave privada de cliente. El transporte de prueba conecta a loopback después de ejecutar la validación de DNS y mantiene la verificación TLS. Ocho canarios TLS aprobados. Clasificación: falso positivo para exfiltración. |
| 227 — datos de archivos de pruebas hacia logger | Las tres fuentes señaladas pertenecen a pruebas; el sink es el POST relativo fijo `/api/client-error`, que además retorna sin hacer red en servidor. No hay destino HTTP elegido por el contenido de un archivo. Clasificación de ese flujo: falso positivo. La revisión sí encontró un defecto distinto: el mensaje no se redactaba como los metadatos. `ec88509c` lo corrige antes de consola, Sentry y POST, con RED reproducido y GREEN independiente. La redacción cubre los patrones soportados; no promete anonimizar cualquier texto arbitrario. |

Los tres casos tuvieron revisión independiente y se clasificaron individualmente en GitHub con su justificación. No se desactiva CodeQL, no se excluyen archivos ni reglas y no se eluden los checks requeridos.

## Correcciones adicionales

Los avisos de escape y controles redundantes se simplificaron manteniendo contratos existentes y comparando resultados. Los imports de Vitest preceden a su uso y el monitor se lee directamente, sin una comprobación separada de existencia. `e0d68db2` fija destinos literales del proxy para no depender de resolver `localhost`: dos RED pasaron a GREEN y la cohorte de proxy/frontera completó 33 pruebas. Las pruebas ya rechazaban destinos externos; no se afirma una SSRF externa reproducida.

Los hallazgos administrativos 167, 169 y 179 se verificaron y corrigieron en `c8d9821e`, `27be178b` y `a5cbf435`. El interceptor distingue el host exacto de Meta, incluido su punto DNS terminal, y respeta método/cuerpo de Request sin consumir el original. La extracción omite script/style respetando comillas y cierres HTML; es extracción de texto, no un sanitizador DOM. Los filtros usan un diccionario sin prototipo y conservan claves propias en JSON. La revisión independiente encontró tres bordes adicionales y confirmó su corrección: 67 pruebas del lote más seis canarios propios aprobados, con TypeScript y lint sin errores. No hubo llamadas reales a proveedores.

Esta nota no equivale a declarar resuelto todo el inventario histórico de alertas ni a haber desplegado producción. Los resultados finales del reanálisis remoto y la publicación se registran en `EVIDENCIA-CANDIDATO-2026-09-05.json`.

## Corrección posterior de IPv6

CodeQL remoto de `26ef75d3` pasó, pero el navegador privado encontró502 al conectar con Next escuchando sólo en `::1`. El primer refuerzo había elegido siempre IPv4 para `localhost`. Se conserva el fallo en la evidencia privada y se corrige el proxy con un catálogo fijo, lookup propio de las dos IP loopback y selección de familia para HTTP/CONNECT. Las IP explícitas no cambian de familia; no se consulta DNS del sistema. Constructor y revisor:37pruebas PASS; root:12,071 en cobertura y72 en navegador. No se cambió el binding de Next ni se ocultó la regresión con configuración de pruebas. Reanálisis del nuevo commit pendiente.
