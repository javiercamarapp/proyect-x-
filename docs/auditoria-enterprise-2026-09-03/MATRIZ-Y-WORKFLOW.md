# Auditoría enterprise Likida — matriz y workflow continuo

**Fecha de corte:** 2026-09-04

**Objetivo de capacidad:** al menos 5 clientes, 5,000 camiones/operadores y 50,000 viajes/mes
**Estado actual:** NO-GO hasta cerrar los P0/P1 y ejecutar los gates de salida

## Principio de operación

El workflow es un bucle, no una revisión única:

1. El auditor encuentra y reproduce una falla.
2. La clasifica por impacto y escribe un criterio de aceptación verificable.
3. Un constructor distinto implementa la corrección y su prueba de regresión.
4. Se ejecutan pruebas focalizadas y después la batería transversal.
5. El auditor vuelve a intentar romper el flujo corregido.
6. Sólo se promueve si no quedan P0/P1 abiertos y todos los gates aportan evidencia.

Producción, datos de clientes, Supabase, Vercel, QStash, Meta, PAC y Sentry se
mantienen en modo de sólo lectura durante la auditoría. Una migración o un
deployment requieren una promoción separada, reversible y observada.

## Severidad

| Nivel | Definición | Decisión |
| --- | --- | --- |
| P0 | Pérdida/corrupción de dinero o documentos, fuga entre tenants, cierre incompleto afirmado como correcto, indisponibilidad total | Bloquea release |
| P1 | Pérdida recuperable de trabajo, bypass de control privilegiado, cola sin convergencia, operación crítica sin recuperación | Bloquea alta enterprise |
| P2 | Riesgo acotado, observabilidad incompleta, degradación o deuda que requiere condición adicional | Debe tener dueño y fecha |
| P3 | Mantenibilidad, comentario/cobertura o UX sin impacto material inmediato | Backlog priorizado |

## Rubros y agentes

Las dos referencias entregadas el 4-sep hacen explícita la rúbrica completa de
un SaaS real. Ningún rubro se absorbe en un genérico “código”: cada uno obtiene
auditor adversarial, constructor distinto y reauditoría independiente.

| Rubro obligatorio | Qué debe romper/probar | Evidencia mínima para 10/10 |
| --- | --- | --- |
| Diseño de sistema | límites, dependencias, datos fuente, consistencia, fallos y costo | diagrama vigente, ADR y escenarios de degradación demostrados |
| Arquitectura | separación tenant/control-plane, contratos entre módulos, ciclos y puntos únicos | dependencias verificadas, invariantes y recuperación por frontera |
| Frontend/producto | todos los roles, rutas, botones, formularios, carga/vacío/error/éxito y accesibilidad | matriz de navegación más E2E visual en navegador elegido por el usuario |
| APIs y backend | autenticación, validación, idempotencia, timeout, reintento y efectos ambiguos | pruebas de contrato/propiedad y fallos inyectados en cada endpoint crítico |
| Base y almacenamiento | migraciones, constraints, RLS, locks, claims, snapshots, índices, buckets y restore | SQL real PG17, base limpia, upgrade desde prod y restore medido |
| Auth y permisos | sesión, MFA/AAL2, roles, RLS, CSRF, webhooks, SSRF, secretos y tenant cruzado | 401/403, cero efecto lateral y matriz allow/deny por actor |
| Hosting y cloud | Vercel/Supabase, regiones, límites, crons, funciones, cuotas y degradación | configuración cotejada con planes reales, canary y rollback |
| CI/CD y control de versión | supply chain, checks requeridos, previews, migraciones, promoción y rollback | workflow GitHub verde, SHA trazable y despliegue reproducible |
| Seguridad | OWASP, SAST/SCA, secretos, cifrado, abuso, privacidad, auditoría y respuesta | cero P0/P1, advisors tratados y pentest externo identificado como gate |
| Rate limiting | IP/usuario/tenant/proveedor, bursts, cuotas compartidas y bypass distribuido | pruebas paralelas que respetan equidad y devuelven retry observable |
| Caché y CDN | claves por tenant/rol, invalidación, stale data, PII y headers | pruebas de no-fuga, coherencia tras escritura y hit/miss medido |
| Errores y logs | correlación, redacción de PII, códigos accionables, DLQ y retención | un incidente se sigue end-to-end sin exponer secretos |
| Monitoreo y alertas | SLO, métricas, backlog, salud de proveedores, alertas y on-call | alerta disparada/recibida, runbook ejecutado y falsa recuperación impedida |
| Testing | unitario, integración, contrato, SQL, E2E, regresión, property/fuzz y mutación selectiva | cobertura de riesgos, no sólo porcentaje, y pruebas rojas conservadas |
| Escalamiento | 5 tenants, 5,000 unidades, 50k viajes, 150k documentos, burst/soak/backfill | p95/p99, backlog, conexiones, error y costo dentro de umbrales |
| Flujo operacional completo | WhatsApp → OCR → cuadre → cierre → revisión → PDF → entrega → export/timbrado | convergencia sin pérdida/duplicado después de fallar cada frontera |
| Fiscal/legal y terceros | CFDI, Carta Porte, retenciones, DPA/SLA/ARCO, Meta, QStash, PAC, GPS, ERP y correo | reglas versionadas; contrato, reconciliación y aprobación humana externa |

Un “10/10” sólo puede declararse cuando todos los rubros tienen evidencia
vigente y no queda P0/P1 abierto. Las credenciales reales, cuotas contratadas,
pentest, opinión fiscal/legal, on-call y firma del cliente son gates externos:
el repositorio puede prepararlos y detectar que faltan, pero no falsificarlos.

El método y los prompts reproducibles extraídos de ambas referencias están en
`PROMPT-MAESTRO-AUDITORIA-ENTERPRISE.md`. Son parte del criterio de revisión,
en especial la clasificación PASS/FAIL/TRUNCATED/NO-ARTIFACT/SKIPPED y el
control de baseline que evita adjudicar a un cambio una falla concurrente.

## Matriz de cuentas y responsabilidades

La prueba funcional no termina con el camino feliz del operador. Para cada
rol se inventarían navegación, botones, formularios, server actions, APIs,
exports y estados de carga/vacío/error/éxito; después se prueba tanto lo
permitido como el rechazo de lo ajeno.

| Actor | Responsabilidad principal | Pruebas obligatorias |
| --- | --- | --- |
| Operador por WhatsApp | abrir/identificar viaje, enviar comprobantes, corregir datos, confirmar cierre y recibir liquidación | orden, duplicados, foto tardía, OCR fallido, privacidad y entrega |
| Encargado | operación, viajes, unidades, seguimiento y escalaciones sin acceso financiero impropio | botones operativos visibles; dinero/export bloqueados |
| Contador | revisión, ajuste, aprobación, CFDI, póliza, peajes y export | snapshot, doble firma documental, rechazo y reexportación |
| Administrador de flota | usuarios, configuración, integraciones y toda su flota | aislamiento tenant y acciones administrativas auditadas |
| Vendedor | sólo su cartera, notas, toques y avance comercial | cero acceso a cartera ajena o panel cliente |
| Superadmin | soporte cross-tenant y operación global | MFA/AAL2 en toda superficie, selección explícita de flota y bitácora |

Una pantalla visible sin permiso, un permiso sin camino usable o un botón que
confirma antes de completar el efecto se consideran defectos, aunque la función
subyacente tenga pruebas unitarias.

## Diligencia técnica enterprise / inversión

Además del producto, la salida debe resistir una revisión técnica de crecimiento:

- arquitectura y límites conocidos, sin escalado apoyado en comentarios;
- métricas de unidad: costo por viaje/documento, márgenes y sensibilidad de modelo;
- SLO, alertas, on-call, runbooks y propiedad de cada servicio crítico;
- seguridad multitenant, MFA privilegiado, gestión/rotación de secretos y SDLC;
- restore probado, RPO/RTO medidos, rollback y reconciliación de terceros;
- historial reproducible de CI, migraciones y releases;
- deuda P2/P3 explícita con dueño y fecha, sin presentarla como certificación.

SOC 2, pentest independiente, opinión fiscal/legal y contratos firmados son
evidencia externa. El repositorio puede preparar sus controles y bloquear el
alta si faltan, pero no autodeclarar esas aprobaciones.

## Modelo de carga de aceptación

- Volumen medio: 1,667 viajes/día y 69.4 viajes/h.
- Documentos: 100,000–200,000 OCR/mes; escenario central 150,000.
- Ráfaga: 5,000 operadores × 5 fotos en 10 minutos = 25,000 imágenes, 41.67/s.
- GPS cada 5 minutos: 1.44 millones de posiciones/día y 129.6 millones/90 días.
- Multitenancy: la carga se reparte entre al menos 5 clientes y también se
  prueba un tenant dominante, para que la equidad no dependa de una distribución ideal.
- Recuperación: caída de 24 horas seguida por tráfico normal sin hambre de históricos.
- Soak: 24 horas a 2× del promedio, más la ráfaga, con inyección de 429,
  timeout, reinicio de workers y respuestas ambiguas de proveedores.

El ejercicio no se considera aprobado por insertar filas y ejecutar consultas
secuenciales. Debe atravesar las mismas colas, claims, locks, funciones y
fronteras de proveedor que producción, usando dobles controlados cuando llamar
al proveedor real sea destructivo o cobre dinero.

## SLO de salida propuesto

| Señal | Umbral de aceptación |
| --- | --- |
| Integridad financiera | 0 cierres con comprobantes/incidentes pendientes; 0 snapshots divergentes |
| Aislamiento | 0 lecturas/escrituras cross-tenant en la matriz de roles |
| Duplicados | 0 efectos de negocio duplicados bajo reintento/concurrencia |
| Error E2E | <0.1% en soak, con 100% del trabajo preservado para reintento |
| Backlog | vuelve a cero en <30 min después de la ráfaga central |
| Base | conexiones <70% del máximo durante la prueba; sin spill sostenido |
| Lecturas críticas | p95 <500 ms; posición más reciente p95 <100 ms |
| API/webhook | p95 y p99 dentro del presupuesto de la plataforma; acuse no implica entrega |
| Recuperación | RPO y RTO medidos mediante restore, no sólo documentados |

Los umbrales de proveedores y los objetivos contractuales definitivos deben
validarse contra el plan comprado y quedar en el SLA firmado.

## Gates automáticos

1. Dependencias instaladas de forma reproducible y auditoría de vulnerabilidades disponible.
2. TypeScript sin errores.
3. Trinquete ESLint sin nuevos avisos.
4. Suite unitaria completa, sin workers colgados ni exclusiones accidentales.
5. Cobertura por encima del trinquete del repositorio.
6. Migraciones en una base limpia y desde la versión de producción.
7. `supabase/verificaciones.sql` completo.
8. E2E navegador sobre preview con Supabase efímero.
9. Pruebas de carga, ráfaga, concurrencia y recuperación.
10. CodeQL, secret scanning y revisión de permisos/branch protection.
11. Preview → smoke → promote; nunca promoción si el smoke no observa DB y colas.
12. Rollback ensayado y verificado por `/api/health` más un canary funcional.

## Bloqueantes confirmados en esta ronda

- El cierre podía continuar tras timeout/indeterminación de ingesta y afirmar
  que terminó con los documentos alcanzados.
- Una foto anterior entregada tarde o una carta muerta podía quedar fuera del cierre.
- La transacción de liquidación comparaba cantidad de gastos, no el contenido
  económico/fiscal usado para calcular cifras y PDF.
- Un ajuste podía activar cifras nuevas con uno de los dos PDFs todavía viejo.
- Varias rutas privilegiadas permitían a un superadmin AAL1 saltarse el gate MFA.
- Drainers solapados podían autoamplificar callbacks QStash sin trabajo reclamado.
- Jornada podía dejar permanentemente fuera históricos detrás del límite de 400.
- La sincronización de eventos podía truncar después de 200 sin cursor durable.
- No existe todavía evidencia de carga E2E representativa de 5,000 unidades,
  50,000 viajes y 150,000 documentos/mes; éste sigue siendo un gate, no una
  afirmación comercial.

## Evidencia local acumulada antes del segundo ciclo constructor

- 11,224 pruebas unitarias en cuatro shards: todas verdes; una omisión deliberada.
- TypeScript: verde.
- ESLint ratchet: 175/175 avisos heredados, cero nuevos, cero errores.
- Build de producción: verde; queda un warning de dependencia dinámica conocido.
- Trace del webhook: 474 archivos; cero `.env`, tests, docs, scripts o migraciones;
  incluye un binario WASM de lectura de códigos.
- `npm audit`: sin dictamen, porque el endpoint de npm agotó el timeout. No se
  interpreta un fallo de red como “cero vulnerabilidades”.

Esta evidencia se vuelve a generar después de integrar las correcciones. Un
resultado anterior no certifica código que cambió después.

## Evidencia MCP y límites de acceso (corte intermedio)

- GitHub: el conector permite leer commits y checks. La rama remota auditada
  mantiene CI rojo por un `503` del endpoint de `npm audit`; no se confundió
  indisponibilidad del registro con vulnerabilidades ni con un gate verde.
- Supabase: proyecto localizado y consultado en modo lectura. Producción llega
  sólo hasta la migración 0303; las correcciones 0304+ siguen siendo candidatas
  locales y no se desplegarán antes del gate de migraciones/rollback.
- Vercel: el MCP reconoce el equipo `likida`, pero lista cero proyectos y
  devuelve `403 Forbidden` al pedir errores de runtime con el `projectId`
  enlazado en `.vercel/project.json`. Es un hueco de observabilidad/acceso, no
  evidencia de que producción esté libre de errores.
- Sentry y QStash: no hay herramientas MCP expuestas en esta sesión. Su
  comportamiento se inspecciona por configuración/código y dobles controlados;
  la evidencia viva queda pendiente hasta contar con conectores autorizados.
- Advisors Supabase al corte del 4-sep: 111 avisos de seguridad (105 tablas
  internas deny-all sin policy, 4 helpers `SECURITY DEFINER` ejecutables por
  `authenticated`, `unaccent` en `public` y protección de contraseñas filtradas
  desactivada) y 247 de rendimiento (155 FK sin índice, 65 índices sin uso, 24
  policies permisivas duplicadas, 2 `auth_rls_initplan` y Auth con 10 conexiones
  absolutas). Los conteos son inventario, no 111/247 vulnerabilidades: cada
  aviso debe clasificarse por intención y workload antes de modificar esquema.
- `pg_stat_statements` acumula desde 25-jul: la antigua consulta del mapa de
  prospectos escribió 18,175,449 bloques temporales (~145 GB) en 5,632 llamadas;
  una lectura de gasto tenant+fecha ordenada por id promedia 1,093.9 ms y escribió
  4,763,607 bloques (~38 GB). Varias rutas locales ya migraron a agregados/RPC;
  falta demostrar en preview que el código nuevo elimina las firmas, no asumirlo
  a partir del source.
- La salud viva todavía admite verdes no comparables: `facturar=ok` reportó 30
  pendientes, 2 intentados y modo ensayo; `portales-vivos=ok` reportó 13 rotos;
  `gps=ok` reportó cero flotas. El gate de observabilidad debe separar sano,
  parcial, no configurado y sin artefacto.

## Hallazgos de la revisión de constructor en curso

- GPS (NO-GO; nuevo constructor activo): la ola durable quedó en `9d4a808e` y
  pasó 218 pruebas, SQL PG17 y dos workers, pero la segunda reauditoría encontró
  un P0 y cuatro P1. Safety Events no pide `includeAsset=true` —default oficial
  false—, por lo que un `Crash` queda sin unidad y termina en DLQ mientras el
  watermark puede avanzar. La asistencia recalcula con `hoyMx` y sólo viajes
  abiertos; `avisado=false` se sella como éxito; las métricas de cuarentena/DLQ
  se pierden antes del cron/UI; y la cuarentena pre-aviso todavía conserva
  referencias individualizables. Samsara/Meta reales y una carga GPS E2E siguen
  `SKIPPED/BLOCKED`, jamás contadas como verde.
- WhatsApp/jornada (corrección `3e664248`, reauditoría final activa): la fuente
  NULL, cambio de día/unidad, aceptación posterior y contracción GPS ya anulan
  únicamente asientos automáticos, conservan humanos e historia `corrige_a`.
  Root repitió 108 pruebas, typecheck/ESLint, SQL 0325+0319 y dos sesiones.
  Medición raíz: 13,000 WA en 13.399 ms, poda 50,000→1 en 211.355 ms y lote de
  50 en 22.710 ms; 400+400 claims sin repetidos y updater bloqueado por el fence.
- Cal.com (NO-GO; segundo constructor activo): `42c97e0b` cerró causalidad,
  deadlock, caller, cursor y provisioning y pasó 61 pruebas/SQL/concurrencia,
  pero el reauditor reprodujo cinco P1: terminal sin CREATED perdido en
  `esperando_vinculo`; status oficial `rejected` traducido a CREATED; deadline
  rebasado dentro de una página; secretos marcador aceptados por HMAC; y correo
  `vinculo_correo` que evade la purga. El cron tampoco marca incompletitud como
  parcial. Cal.com real, 429/5xx y backlog 24 h siguen omitidos explícitamente.
- CI (cerrado localmente; pendiente de una corrida GitHub): la auditoría
  runtime clasifica CVE vs. caída del registry, reintenta con tiempo acotado y
  corre después de typecheck/tests/build/smoke. Un 503 sigue dejando el job
  rojo, pero ya no oculta la evidencia de las puertas de código.
- Arranque (cerrado localmente; pendiente del gate completo): los probes
  mutativos se sustituyeron por `garantias_arranque_faltantes()`, lector estable
  de catálogo server-only. Sus pruebas focales, firmas/overloads hostiles y PG17
  pasaron; también se corrigió el caso `Promise.allSettled` que antes registraba
  un rechazo pero devolvía `ok: true`.

Todo punto marcado abierto sigue fuera del conteo de aceptación hasta contar
con regresión, PostgreSQL 17 real y reauditoría independiente.
