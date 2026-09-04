# Auditoría enterprise Likida — matriz y workflow continuo

**Fecha de corte:** 2026-09-03

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

| Rubro | Qué debe probar | Evidencia mínima |
| --- | --- | --- |
| Flujo E2E | WhatsApp → persistencia → OCR → cuadre → cierre → revisión → PDF → entrega → export/timbrado | fallos inyectados en cada frontera; convergencia sin duplicar |
| Seguridad e identidad | sesión, MFA/AAL2, roles, RLS, CSRF, webhooks, SSRF, secretos, aislamiento tenant | 401/403 y cero efectos laterales; tests de tenant cruzado |
| Datos/Postgres | migraciones, constraints, RLS, locks, claims, snapshots, índices, restore | SQL transaccional y verificaciones fail-closed |
| Capacidad/concurrencia | 5,000 unidades, 50k viajes, 100k–200k documentos, ráfagas, 429, retries, backpressure | p95/p99, backlog, conexiones, error y costo |
| Fiscal/legal | CFDI, Carta Porte, deducibilidad, retenciones, DPA/SLA/privacidad/ARCO | reglas con fuente/versionado y aprobación humana |
| Vercel/release | preview, smoke, promote, rollback, crons, límites de funciones | workflow verde real y rollback ensayado |
| Observabilidad | Sentry, logs correlacionados, colas, cartas muertas, alertas y SLO | incidente detectable y trazable de entrada a resolución |
| Integraciones | Meta, OpenRouter, QStash, PAC, GPS, ERP y correo | contrato, timeout, idempotencia y reconciliación |

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

## Hallazgos de la revisión de constructor en curso

- GPS (abierto): un fallo al insertar un evento todavía podía terminar la
  ventana como completa y avanzar el watermark; un evento huérfano persistido
  con `unidad_id = NULL` no podía adoptar el mapeo corregido; además, la ingesta
  hacía un round-trip por evento. Los tres regresaron al constructor junto con
  el caso de bootstrap/backfill y recuperación de lease.
- WhatsApp/jornada (en validación): el selector ya fue rediseñado como
  round-robin por remitente, conservando cadenas causales dentro del lote. En
  PostgreSQL 17, 13,000 mensajes se listaron en 13.086 ms y el claim de 50
  jornadas con tres marcas en 12.624 ms; queda resolver el hang del arnés de
  dos sesiones antes de aceptar la ola.
- Cal.com (cerrado en la primera reauditoría): `sin_prospecto` y `cuarentena`
  ahora responden `503` con `Retry-After`; el email y `noShow` salen del mismo
  asistente; UID/id tienen namespace y la máquina de estados drena entregas
  invertidas. Evidencia: 25/25 Vitest, SQL atómico PG17 y concurrencia real.
- CI (cerrado localmente; pendiente de una corrida GitHub): la auditoría
  runtime clasifica CVE vs. caída del registry, reintenta con tiempo acotado y
  corre después de typecheck/tests/build/smoke. Un 503 sigue dejando el job
  rojo, pero ya no oculta la evidencia de las puertas de código.
- Arranque (abierto): los probes de funciones/constraints ejecutaban lógica de
  negocio, tocaban un viaje/tenant y generaban errores artificiales en los logs
  de producción. Se está sustituyendo por inspección de catálogo sin escritura.

Todo punto marcado abierto sigue fuera del conteo de aceptación hasta contar
con regresión, PostgreSQL 17 real y reauditoría independiente.
