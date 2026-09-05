# CA pública para PostgreSQL Supabase

`supabase-root-2021.crt` contiene únicamente el certificado público **Supabase
Root 2021 CA**, sin clave privada. El preflight verifica sus bytes contra un
SHA-256 fijado y su vigencia antes de ejecutar `psql`. La URL de conexión fija
esta ruta absoluta desde el módulo, conserva `sslmode=verify-full` y no permite
que parámetros de entrada o `PGSSLROOTCERT` elijan otra CA.

- Fuente oficial: [Supabase Studio, custom-content.json](https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json), que enlaza el [certificado público](https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt).
- SHA-256 del archivo PEM: `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7`.
- Huella SHA-256 DER: `807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA`.
- Sujeto y emisor: `CN=Supabase Root 2021 CA, O=Supabase Inc, L=New Castle, ST=Delware, C=US`.
- Vigencia UTC: 2021-04-28 10:56:53 a 2031-04-26 10:56:53.

El 2026-09-05 se verificó el handshake PostgreSQL/TLS del pooler
`aws-0-us-east-2.pooler.supabase.com:5432` con SNI y validación del hostname:
el almacén del sistema rechazó la cadena y esta CA, usada aisladamente,
la verificó. La cadena fue hoja `*.pooler.supabase.com` → Supabase Intermediate
2021 → Supabase Root 2021. También se verificó el host directo de staging.
Estas comprobaciones no autentican una sesión de base de datos; el modo
`connection` verifica por separado autenticación y `SELECT 1`.

No hay descarga de certificados durante el pipeline. Una rotación requiere
verificar la nueva CA con una fuente oficial, revisar los destinos y actualizar
el archivo y el pin en un cambio revisado. Si falta, cambia o vence el certificado,
se detiene la conexión; no se vuelve a `require`, `system` ni a una CA arbitraria.
