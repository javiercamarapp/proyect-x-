# Fallo TLS del preflight de despliegue — 5 de septiembre de 2026

El merge del PR #332 quedó en `8d3261146cfa001b6a6c418df3f795f0a11ebd85`, con el mismo árbol que el candidato probado `861a72f9`. No activó un despliegue automático de Vercel.

## Evidencia del entorno real

- [33997900547: primer pipeline de staging](https://github.com/javiercamarapp/proyect-x-/actions/runs/33997900547): calidad completa y build con Node 24 aprobaron; Supabase link terminó correctamente y el preflight psql falló. No se alcanzaron dry-run, aplicación de migraciones, configuración Preview ni despliegue. El helper original descartaba stderr, por lo que ese log aislado no identifica la causa.
- [33998340517: diagnóstico CLI de sólo lectura](https://github.com/javiercamarapp/proyect-x-/actions/runs/33998340517): link y migration list aprobaron. El historial remoto permanecía en 0303. No se reparó ni inventó historial.
- [33998728466: diagnóstico psql de sólo lectura](https://github.com/javiercamarapp/proyect-x-/actions/runs/33998728466), código `19e135abe2613a539b29e55d4cb478ba161b926f`: destino validado `aws-0-us-east-2.pooler.supabase.com`, `verify-full`, consulta fija SELECT 1. Falló con `PREFLIGHT_TLS_CERTIFICATE`, sin publicar credenciales, URL de conexión ni errores crudos. Esta reproducción demuestra el problema TLS; no demuestra todavía que las migraciones remotas puedan aplicarse.

## Corrección del diagnóstico

El helper clasifica fallos de proceso, conexión, autenticación, TLS y SQL con mensajes propios; sólo permite SQLSTATE conocidos. El modo connection no ejecuta el preflight de índices: usa SELECT 1, sesión de sólo lectura, statement_timeout de 15 segundos y límite de proceso de 30 segundos. Un exit 0 sin el resultado exacto 1 también falla.

Validación antes de publicar `19e135ab`: 55 pruebas focales PASS, lint y TypeScript sin errores, revisión independiente con otras 9 comprobaciones de destino, TLS, sólo lectura y ausencia de filtraciones. El certificado y las migraciones aún no se habían modificado en ese commit.

## Comprobación independiente de la cadena

El handshake PostgreSQL STARTTLS de ambos destinos reales, directo de staging y pooler exacto, se probó sin autenticación ni SQL. Con raíces del sistema falla la cadena (OpenSSL verify code 19); con el PEM oficial Supabase Root 2021 pasa la cadena y el nombre del servidor (verify code 0). Para el pooler, la repetición con `-no-CApath -no-CAstore` confirma que basta esa CA, sin un bundle de otras raíces públicas.

La cadena es hoja del destino → Supabase Intermediate 2021 → Supabase Root 2021. La hoja del pooler incluye el SAN `*.pooler.supabase.com`. Huella SHA-256 DER de la raíz: `807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA`. La fuente pública es la [configuración oficial de Studio](https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json), que apunta al certificado hospedado por Supabase. No se modifica el almacén global de confianza.

## Límites de esta evidencia

La conexión satisfactoria del CLI no demuestra que libpq confíe en la misma cadena TLS. El runner anunciado incluye PostgreSQL 16.15; sslrootcert=system existe desde PostgreSQL 16, por lo que no se atribuye el fallo a falta de soporte de esa opción.

La corrección debe mantener verify-full y validar el nombre del servidor con una CA de procedencia verificable. El despliegue sólo puede continuar después de repetir conexión, preflight y migraciones en staging. Un resultado TLS positivo por sí solo no acredita una migración, un backup restaurable ni la activación de producción.
