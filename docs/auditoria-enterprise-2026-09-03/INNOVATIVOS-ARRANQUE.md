# Transportes Innovativos: preparación del arranque

Actualizado el 5 de septiembre de 2026, hora de Mérida. Documento de trabajo; no acredita una puesta en producción. El objetivo técnico de capacidad es **800 unidades y 15,000 viajes al mes**. Es una carga de aceptación sintética, no un inventario ni un volumen mensual confirmado por el cliente.

## Alcance del piloto encontrado en Drive

La [propuesta preliminar del 16 de agosto](https://drive.google.com/file/d/1qnCBHtBkrugYGvjii3uZZWuuhZr1U8UX/view) recoge un PoC de 30 días centrado en dos recorridos:

1. Desglose de peajes → conciliación contra gastos y viajes → tres categorías de discrepancias → confirmación humana del cruce → bitácora CSV.
2. Facturas de proveedor → bandeja de aprobación → exportación CSV para importar en SAP Business One, con marca visible de exportación y control humano de importación.

Ese documento deja para una segunda fase la escritura directa a SAP, el cruce contra GPS del TMS y el canal de WhatsApp. Mientras no llegue una corrección del usuario, éste es el alcance de aceptación del piloto. Se mantiene la auditoría técnica ampliada ya autorizada, pero no se confunde con lo que el cliente aceptó contratar: la propuesta es preliminar.

La carpeta [02-transportes-innovativos](https://drive.google.com/drive/folders/1cSB9T5xpF-d3XmvyiI-QQpq0G4buWJjI) contiene investigación, propuestas, escenarios y mensajes preparados. En sus hijos directos revisados no aparecieron catálogos operativos ni acuerdos firmados. La ficha comercial contiene estimaciones históricas corregidas; no deben convertirse en parámetros productivos sin confirmación del cliente.

## Decisión actual

**Código del último lote: `27be178b`. El arranque operativo todavía no está acreditado.** La base integrada aplicó 324 migraciones hasta0347 desde cero; pasaron17 contratos SQL,40pgTAP y242 bloques de aislamiento (238 aprobados, cero fallos y cuatro reportes). La cobertura local final pasó12,067 pruebas, sin fallos y con tres omisiones explicadas; la cohorte de tiempo pasó96 sin omisiones. TypeScript y lint (156 advertencias heredadas, ninguna nueva) pasaron. El build local y las72 pruebas de navegador posteriores al recierre corresponden a `7c332786`; los builds/checks del lote posterior se comprobarán en GitHub. El recierre, la privacidad del mensaje de log, el proxy local y los tres defectos administrativos de CodeQL quedaron corregidos con revisión independiente.

El usuario **ya autorizó expresamente push, merge en GitHub y despliegue en Vercel**. No hace falta volver a pedir esa autorización. La publicación corresponde al coordinador y sigue los gates del workflow sobre el SHA validado. Ya se hizo push y se abrió el [PR 332](https://github.com/javiercamarapp/proyect-x-/pull/332). Calidad, PostgreSQL y navegador remotos pasaron en `8439e2d9`. Merge y deployment continúan pendientes de cerrar la revisión del lote posterior de CodeQL. Tener autorización no equivale a tener una ejecución aprobada ni a haber completado el arranque del cliente.

El ensayo continuo de 24 horas no se completó, el backup externo de Storage sigue sin destino/credenciales configurados y faltan datos y acuerdos del cliente. La integración directa con SAP continúa en fase 2; el piloto documentado utiliza CSV e importación humana. Este documento complementa `ESTADO-2026-09-04.md` y conserva abajo los resultados históricos con su alcance original.

## Evidencia actual del candidato

| Verificación o corrección | Resultado comprobado | Límite y evidencia |
|---|---|---|
| SQL integrado hasta 0347 | 324 migraciones desde `template0`, 17 contratos de CI, 40/40 pgTAP y aislamiento 242 bloques: 238 aprobados, 0 fallos, 4 reportes | PostgreSQL 17 local propio. El primer aislamiento falló por expectativa antigua de versión 281; se preservó y se repitió sólo aislamiento tras exigir 342. `/private/tmp/innovativos-capacidad/final-sql347/REPORT.md` |
| 0341: alerta GPS mínima | GO independiente; claim, outbox, leases, aislamiento y concurrencia comprobados | Evento grave sin autorización conserva sólo el mínimo operativo permitido; no se enriquece con conductor/viaje. Unidad huérfana por FK no se reclama. No acredita GPS externo |
| 0342: póliza firmada y comprobable | Pendientes bloquean el periodo completo; ajustes incompatibles indican folio y comprobante; correcciones coherentes sí exportan | Traslados NULL no se convierten en cero; cero documentado sí pasa. 131 pruebas de póliza/contabilidad/parser/persistencia y revisión SQL independiente. `/private/tmp/innovativos-capacidad/poliza342/REPORT.md` |
| 0344: indicadores sin rechazadas | KPI y últimos cierres excluyen rechazadas; registro conserva enlace e importes invalidados como null | Pendientes siguen contando como resultados operativos, no como crédito fiscal firmado. Historial conservado |
| 0345: REP con forma por definir | Forma efectiva 99 no entra en numerador de efectivo; denominador y fechas intactos | SQL RED/GREEN y reaplicación independiente. `/private/tmp/innovativos-capacidad/fiscal344345/REPORT.md` |
| 0346: publicación de PDF | GO independiente de código/SQL; pareja inmutable, publicación por comparación de estado y cifras, reintento sin segunda firma | Legacy incompleto bloquea antes de firmar; no inventa PDF perdido. No revoca enlaces ya entregados ni acredita caché CDN. En Supabase real, el canario de concurrencia pasó pero la limpieza SQL de Storage fue rechazada: no se presenta ese script como éxito integral. `/private/tmp/innovativos-rbac/pdf346/REVIEW.md` |
| 0347: original y copia de comprobante | GO independiente; copias identificadas reciben LR019, original de ticket dependiente del monto recibe LR022 accionable; LR020/candados conservados | Referencias ajenas no crean copias falsas. Se probó rechazar, revisar el grupo y volver a calcular. `/private/tmp/innovativos-capacidad/duplicados347/REPORT.md` |
| WhatsApp: fallo al reclamar inbox | `fd3e32fe`: no se continúa la conversación fuera de orden cuando falla el claim; 22 pruebas de la cohorte del constructor aprobadas | Dobles locales, sin mensajes reales. `/private/tmp/innovativos-root-wa-claim-green.json`; incluido también en la suite global aprobada |
| Actividad reciente | `b1758730`: consulta cada sello por su fecha, une y limita; ya no pierde eventos por ordenar UUID. Desempate secundario por ID corregido en `01473844` | Cohorte previa de 232 pruebas aprobada; la repetición global aprobó el contrato de límite/desempate tras corregir sus dos fallos iniciales. Plan previo con 50.000 viajes totales/cinco tenants: 2,021/1,470 ms; no es latencia HTTP ni capacidad mensual. `/private/tmp/innovativos-capacidad/hechos-recientes/REPORT.md` |
| CI y separación de ambientes | Workflow manual y helpers preparados para SHA fijo, Preview con staging, comprobación de backup SQL y Production staged antes de promoción | Pruebas locales; no equivale a ejecución remota. Preview exige credenciales del staging, sin reutilizar las productivas. `docs/operacion/RESILIENCIA-DEPLOY.md` |
| Suite global, cobertura, build y navegador del SHA final | **Pendientes de resultado final del coordinador** | Completar las casillas de cierre; no usar las cifras de la ronda 0340 como aprobación del candidato final |

## Evidencia histórica conservada: rondas previas hasta 0340

| Verificación | Resultado observado | Alcance y límite |
|---|---|---|
| Instalación reproducible | `npm ci --no-audit --no-fund`; `npm ls --depth=0` termina sin errores | Antes había dependencias instaladas distintas del lock. La nueva corrida usa Next 16.3.3 y OpenAI 7.9.0 |
| Suite global con lock exacto | 11,748 aprobadas, 0 fallidas, 1 omitida | JSON local `/private/tmp/innovativos-integracion-ssrf.json`. La omitida requiere ticket real y OCR de pago. Incluye las correcciones de conectores |
| Cobertura global | 11,754 aprobadas, cero fallidas, tres omitidas; umbrales intactos | Statements 82.98%, branches 72.94%, functions 86.44%, lines 85.67%. Incluye ocho canarios TLS añadidos tras la corrida global; las omisiones corresponden a OCR de pago y mediciones no válidas con instrumentación |
| Navegador de la ronda 0340 | 71/71 aprobadas en 1.5 min; salida cero | Seis sesiones, MFA, HTML/RSC, permisos, importación, peajes, proveedores, caché, móvil y ARCO. Commit `c4c4b76b`; evidencia `/private/tmp/innovativos-rbac/suite-71-final.log` |
| Build privado de la ronda 0340 | Build de producción con Next 16.3.3 y SQL 0340 aprobado | Supabase local desechable, sin secretos de proveedores; advertencia conocida de importación dinámica de CFDI |
| Actualización histórica SQL | Esquema 0303 a 0339 aprobado, 281 migraciones base y 33 nuevas | Dataset sintético de 800 unidades, 15,000 viajes y 45,000 documentos conservado; no es copia exacta de producción |
| Capacidad inicial | 5 tenants, 5,000 unidades, 50,000 viajes, 150,000 documentos | Innovativos sintético tiene 800 unidades y 15,000 viajes |
| Ráfaga de metadatos | 25,000 inserciones en 1.504 s, cero fallos | p95 0.919 ms y p99 1.386 ms. No incluye imágenes, OCR, Storage ni HTTP |
| Equidad de cola | 10 claims: dos por tenant; siguiente tanda sin solape | Ensayo SQL real; no representa toda la cadena de WhatsApp |
| Aislamiento | RLS de cinco tenants aprobado | Base temporal exclusiva |
| Ensayo de 24 horas | Detenido; no aprobado | Suspensiones del host produjeron retrasos que incumplen p95/p99. Se conservan datos originales; una repetición requiere energía y ejecución continua |
| Salud de WhatsApp | Cartas muertas ahora producen estado parcial y conteo explícito | Corrección `d779458c`, reproducción y revisión independiente. Se conserva HTTP 200 para evitar reintentos inútiles y la alerta de intervención |
| Privacidad ARCO | Corrección `be94db90`, migración 0340 | RED/GREEN y reaplicación en tres bases; sólo texto y comentario. ACL, search_path, lógica e historia conservados. No acredita anonimización completa |
| Continuidad del ensayo | Corrección `88d78128` | Siete pruebas sintéticas y tres ejecuciones independientes del resumen: huecos iniciales, intermedios y finales invalidan la corrida, aunque pasen volumen y latencia |
| Roles del panel | Despacho y CSV corregidos en `13b2be0e` | Pruebas por sesión viva, columnas vacías/duplicadas, revocación y navegador real. HTML/RSC del encargado no contienen el monto canario |
| Pactos de estadía | Corrección `7c10b71d` | Función local capturada por Server Actions causaba caída del panel; helper elevado a módulo y regresión real de navegador aprobada |
| Conectores HTTPS | Corrección `330e8404` | IP validada al abrir socket, TLS/SNI intactos, redirects manuales, timeout total 15 s y respuesta máxima 8 MiB. Root: 298 pruebas; revisor: ocho canarios TLS reales |
| Worker | Corrección `fffe12df` | Media de 3 MiB, cuerpo HTTP de 4.4 MB, lotes completos de catálogo, base64 estricto y aviso de vista previa omitida; prueba HTTP local independiente |
| Dependencia vendorizada | Guard `c27fe62d` | Procedencia y hash cotejados con lock; negativos independientes para corrupción, drift y dependencia local sin manifiesto, incluidas opcionales |
| PoC peajes | Focal de navegador aprobado | CSV, tres categorías, cancelar/confirmar cruce, CSV sólo conciliado y aislamiento. Confirmar el cruce no equivale a adjudicar cada discrepancia individual |
| PoC proveedores | Focal de navegador aprobado | Tres documentos sintéticos en bandeja, aprobar/rechazar, CSV SAP de once campos, marca visible y reexportación idéntica con sello inicial preservado |

El ensayo SQL se diseñó con cinco conexiones, dos trabajadores y dos transacciones por segundo durante 24 horas, con mezcla de lecturas, actualizaciones de rutas e inserciones de metadatos. Se detuvo mediante `STOP` tras 62,920 segundos de reloj; el resultado registra `stop-file`, salida -2 y `completed_full_duration: false`. Su evidencia está en `/private/tmp/innovativos-capacidad/soak24h`. Las pausas del host explican el retraso programado observado, pero no se descartan muestras ni se reemplazan los percentiles originales para declarar éxito. Tampoco habría medido capacidad mensual de extremo a extremo.

La repetición independiente de recuperación del coordinador terminó en **20.034 s**, con los mismos conteos y hashes de las siete tablas especificadas en el reporte de capacidad y aislamiento de cinco tenants. Claims secuenciales y concurrentes también se repitieron sin solape en una base propia. Evidencia: `/private/tmp/innovativos-root-capacity/`.

La primera ampliación a 71 casos tuvo un fallo del arnés al comparar un acento en RSC; se conservó ese resultado, se comprobó la pantalla inmediata sin mojibake y se repitió la batería completa con 71 aprobaciones. No se modificó código productivo para ocultarlo. La observación del transporte está guardada con el caso ARCO; no se atribuye a una causa demostrada.

La revisión de caché PDF no reprodujo acceso entre usuarios: la puerta revalida sesión, rol y tenant y el anónimo recibe 401. Las pruebas locales no verifican la caché del CDN remoto. La caducidad del token de URL firmada no acredita por sí sola revocación de un objeto previamente cacheado; queda por verificar su política efectiva antes del arranque.

La exportación de proveedores permite volver a descargar las aprobadas por diseño. La marca de exportación ayuda al control humano; no impide técnicamente importar dos veces el archivo en SAP. El layout deja los códigos propios del ERP para mapear con el cliente y no acredita una importación exitosa en su instancia.

## Estado remoto: última lectura y ejecución pendiente

- La última lectura productiva registrada de Supabase Likida `gngoqsvrxdguxvsizpbw` lo encontró activo, región `us-east-2`, PostgreSQL 17.6.1.147, con historial hasta **0303** (281 migraciones). Es una lectura histórica; el preflight debe volver a comprobarla antes del rollout. El árbol local actual contiene **324 archivos de migración hasta 0347**, incluidos los cambios incorporados de las ramas remotas. No confundir el upgrade sintético anterior 0303→0339 con la aplicación del árbol integrado actual.
- La app candidata requiere contratos posteriores a 0303, incluida la póliza v342. El esquema productivo debe actualizarse antes de activar esa aplicación; no se ha ejecutado esa actualización en esta fase.
- La consulta por nombre de tenant que contiene `innovativ` no devolvió filas. No descarta una flota registrada con otro nombre. Antes de cualquier alta se debe resolver su identidad para evitar duplicados.
- Los identificadores locales consultados en la ronda anterior devolvieron 404. El workflow y la guarda actuales fijan el proyecto `prj_OnrG9eY8WQzj35I3jtAZX2wTJ2sn`, staging Supabase `dmhhygwzgudwgcbixuwp` y Production `gngoqsvrxdguxvsizpbw`. La ejecución remota debe verificar proyecto, SHA, target, alias y destino Cron; su resultado todavía está pendiente.
- Las incidencias Sentry registradas en el informe anterior corresponden a una release anterior. No se cerraron ni se atribuyeron al código local sin reproducción.


## Recuperación y continuidad todavía pendientes

El restore SQL sintético, incluidos los hashes de siete tablas y RLS de cinco tenants, **no es un backup de Storage remoto**. Tampoco prueba PITR ni un RPO/RTO productivo. La promoción exige comprobar el backup SQL gestionado conforme al workflow; su ID, estado y antigüedad deben quedar en el registro de ejecución.

El respaldo externo de archivos permanece sin destino y credenciales configurados. Se necesitan `RESPALDO_S3_DESTINO` y la identidad de acceso correspondiente en `production-backup`, una corrida manual con manifiesto/checksums y marca de finalización, y una restauración aislada comprobada. El schedule continúa desactivado hasta completar ese recorrido. No se inventa un bucket, una cuenta ni un destino del cliente para presentar este punto como terminado. Los nombres y pasos están en `docs/operacion/RESILIENCIA-DEPLOY.md`; ningún secreto debe copiarse aquí.

El ensayo de 24 horas conserva estado **no aprobado**: terminó por `stop-file` antes del plazo, tras suspensiones repetidas de la Mac. No se inició otra corrida. Una repetición requiere alimentación y continuidad del host; la guardia ahora invalida huecos de telemetría mayores de 90 segundos, también en los tramos inicial y final. No se sustituyen sus percentiles ni se comprime un ensayo de 24 horas en una prueba corta.

## Datos de arranque que faltan

| Dato o decisión | Para qué se necesita | Estado |
|---|---|---|
| Responsable operativo y suplente | Validar catálogos, atender excepciones y aprobar la primera jornada | Solicitado al usuario |
| Catálogo de operadores y unidades | Identidad única, teléfonos, placas, asignaciones y detección de duplicados | Solicitado; no cargar datos ficticios como cliente real |
| Catálogo de clientes y reglas financieras | Importación, conciliación, anticipos y exportación contable | Pendiente de datos aprobados por el cliente |
| Intercambio inicial con TMS/SAP | Validar layout y muestra de importación | Propuesta preliminar indica CSV para SAP B1; escritura directa queda en fase posterior salvo instrucción nueva |
| MSA/DPA y anexos firmados | Confirmar instrucciones, alcance y condiciones del servicio | La documentación local contiene plantillas; no se presume firma |
| Proveedores y contactos de incidente | WhatsApp, GPS, fiscalidad y escalamiento | Confirmar cuentas y responsables por canal seguro |

El camino API/CSV existe y debe validarse con una muestra del cliente. La escritura directa a SAP no se ofrece como terminada: requiere instancia, conectividad, permisos y mapeos reales. No incluir contraseñas ni llaves en este documento o en el chat.

## Secuencia de aceptación y promoción

1. Cerrar la navegación completa por rol y registrar la evidencia del candidato; cobertura, desempate, build y calidad local ya están aprobados. Guardar los resultados sobre el SHA exacto y dejar el árbol limpio. Si cambia el código, actualizar el candidato y repetir las verificaciones afectadas. El ensayo de 24 horas sigue pendiente y no se da por aprobado con estos checks.
2. Confirmar identidad de proyectos, ambientes y flota. Revisar nombres de secretos y protecciones sin divulgar valores. Resolver los acuerdos y datos del cliente.
3. Preparar respaldo recuperable de base **y archivos**, con manifiesto, hashes y prueba de restauración aislada. El restore SQL local no acredita recuperación de Storage remoto ni PITR.
4. Revisar la lista concreta de migraciones pendientes y sus precondiciones. El preflight de índices concurrentes realiza escrituras incluso antes del `db push --dry-run`; está comprendido en la promoción ya autorizada y debe registrarse como escritura, no como mera lectura.
5. El coordinador publica e integra los commits conservando su historial y ejecuta la promoción **ya autorizada**. Usar el workflow manual `deploy-preview-promote.yml` con SHA fijo, ambientes y gates documentados en `docs/operacion/RESILIENCIA-DEPLOY.md`. El script histórico `aplicar-migraciones-y-humos.sh` describe verificaciones de 0115–0125 y no acredita el contrato actual hasta 0347.
6. Validar staging y proveedores de prueba autorizados. Comprobar recepción, duplicado, fallo transitorio, cierre, revisión humana cuando corresponda, PDF y exportación; guardar IDs y resultados sin datos sensibles.
7. Promover únicamente el candidato validado. Migrar antes de activar la aplicación que depende del esquema; registrar inicio, fin, checks y responsable. Un rollback de Vercel no deshace migraciones de base de datos.
8. Importar una muestra aprobada del cliente, cotejar conteos y totales con su fuente, y ejecutar una jornada controlada con el responsable operativo antes de ampliar volumen.

Los límites de SLA, RPO y RTO sólo se aceptan con la evidencia correspondiente. Los objetivos del runbook y las plantillas contractuales no son resultados medidos.

## Condiciones de suspensión del arranque

Detener la ampliación si hay datos de otra flota, permisos financieros indebidos, cierres o gastos duplicados, diferencias de conciliación sin explicar, mensajes críticos sin entrega confirmada, migraciones incompletas, fallos de restauración o ausencia de un responsable que atienda excepciones. Registrar el incidente y preservar la evidencia antes de reintentar.

## Entrega técnica y pendientes externos

Las correcciones acumuladas están integradas en commits locales. El build de aplicación probado corresponde a **`e797f364`** y la prueba de navegador corregida a **`e3176ba1`**, sin cambios productivos entre ambos. Se conservan los resultados de `c4c4b76b`/0340 como historia; la evidencia actual se publica en `docs/operacion/EVIDENCIA-CANDIDATO-2026-09-05.json`. La autorización de push, merge y Vercel ya existe; el push y el PR 332 ya existen; merge y activación de Vercel siguen pendientes.

La entrega operativa sigue requiriendo datos y responsable del cliente, muestras y mapeos de SAP, acuerdos firmados, recuperación comprobada de archivos y continuidad para repetir el ensayo. La escritura directa a SAP continúa fuera del piloto CSV. Las lecturas de batería citadas en informes previos son históricas, no un estado de energía actualizado.

### Registro que completará el coordinador al cerrar

No marcar una casilla sin el resultado y su vínculo o ruta de evidencia.

- [x] Autorización explícita del usuario para push, merge GitHub y deployment Vercel recibida.
- [x] Código de aplicación fijado tras desempate: `e797f364`; prueba UI `e3176ba1`. Snapshot con 3,932 archivos regulares cotejados; sólo cinco enlaces locales de skills Claude excluidos. Los commits posteriores de documentación no cambian el código de aplicación.
- [x] SQL integrado: 324 migraciones, 17 contratos CI, 40 pgTAP y 242 bloques de aislamiento, sin fallos finales. Evidencia: `/private/tmp/innovativos-capacidad/final-sql347/`.
- [x] Revisión independiente 0346 y 0347: GO de código/SQL con límites documentados.
- [x] Suite global/cobertura: `e797f364`, 12,010 aprobadas/0 fallidas/3 omitidas. Dos mediciones se recuperan en la cohorte sin instrumentación: 96 PASS/0 omitidas. Un arnés de tickets reales no ejecutado. Cobertura: sentencias83.2%, ramas73.26%, funciones86.64%, líneas85.89%; umbrales intactos. `/private/tmp/innovativos-root-final2-coverage.json`.
- [x] Build final `e797f364`, salida0, `/private/tmp/innovativos-release347/build.log`. Next16.3.3, Node26.7 local, Supabase privado; Node22 de CI y Node24 de Vercel se comprueban en sus ejecuciones. Advertencia heredada de importación dinámica CFDI.
- [x] Navegador del candidato previo al fix de recierre: build `e797f364`, tests `52accdc4`, SQL0347; 72/72 PASS, 1.6min, Chromium/Pixel7. `/private/tmp/innovativos-release347/browser-72-green/browser.log`. Primer intento71PASS/1FAIL de capturaCDP conservado; passthrough de respuesta real corregido. Nueva validación requerida si el fix de recierre afecta estas rutas.
- [x] Push y [PR 332](https://github.com/javiercamarapp/proyect-x-/pull/332); historial y autoría preservados. CI, Postgres y E2E de `8439e2d9` aprobados.
- [ ] Merge GitHub y aprobación de checks sobre el último SHA, incluido el lote CodeQL posterior.
- [ ] Staging/Preview: ejecución workflow __; SHA/ref/ID __; migraciones y smoke __.
- [ ] Production: backup SQL ID/estado/fecha __; migraciones __; deployment staged ID/SHA __; smoke __; promoción/alias/Cron verificados __.
- [ ] Storage externo: destino configurado __; manifiesto y marca de finalización __; restore aislado y hashes __.
- [ ] Ensayo continuo de 24 horas: inicio/fin UTC __; continuidad y percentiles originales __; aceptación __.
- [ ] Datos, responsables, acuerdos y muestra SAP del cliente: referencias de aceptación __.

## Matriz de cobertura de la auditoría

El **arranque operativo del cliente no está acreditado** mientras sigan abiertos los requisitos externos y la prueba continua. La publicación técnica está autorizada y su resultado se registra por separado; no sustituye la aceptación operativa. Una prueba local aprobada no acredita un proveedor ni una configuración remota. La tabla distingue lo comprobado del trabajo pendiente; los veinte rubros aplican al servicio.

| Rubro | Evidencia disponible | Cierre pendiente |
|---|---|---|
| 1. Consistencia de negocio | Cierre, idempotencia y fronteras comprobadas; PoC peajes/proveedores focales aprobados | Aceptación de totales, discrepancias y políticas con una muestra del cliente |
| 2. Arquitectura | Invariantes de jornada, aislamiento de persistencia y separación motor/proveedores revisados | Topología e identificación de dependencias remotas del candidato |
| 3. Resiliencia | Fallos de persistencia/Storage sin cierres inventados; restore SQL independiente | Restore de archivos remoto, PITR/RPO y continuidad del entorno real |
| 4. Escala y costo | Dataset de expansión, ráfaga, EXPLAIN y fairness SQL | Repetir 24 horas continuas; tráfico HTTP/proveedores y costo por flujo |
| 5. Frontend | Roles, MFA, importación, estadías, RSC y focos PoC | Aceptación del cliente y accesibilidad integral |
| 6. Backend/API | Cuerpos acotados, autorización previa y contratos de exportación | Verificación de transporte y configuración en el despliegue aprobado |
| 7. Dinero y fiscalidad | Motor/regresiones, decisión humana de proveedores y CSV de contenido exacto | Layout y catálogos SAP, instancia real y validación fiscal competente |
| 8. DB/migraciones/Storage | 324 migraciones hasta 0347, 17 contratos, 40 pgTAP y 242 bloques de aislamiento sin fallos finales; restore sintético | Drift/datos reales, backup de archivos y resultado del rollout autorizado |
| 9. Caché/CDN | Páginas autenticadas con `no-store`; anónimo sin contenido autenticado; canarios RSC | CDN real; la puerta PDF y URL firmada local no mostraron Cache-Control, no se afirma no-store para ellas ni revocación efectiva del objeto a los 60 segundos de vencer el token |
| 10. Cuotas y abuso | Cuotas previas a lectura, cancelación y equidad SQL de claims | Saturación distribuida y límites efectivos de proveedores |
| 11. Auth/RBAC/tenants | MFA real, seis usuarios y flotas A/B; permisos financieros reparados | Validar invitaciones y responsables del tenant real |
| 12. Seguridad/supply chain | SSRF con TLS real, límites, guard de tarball y lock exacto | Políticas y secretos remotos; la prueba de integridad no es firma del fabricante |
| 13. Privacidad/retención | Retención e integridad SQL revalidadas; ARCO describe datos retenidos sin prometer anonimización total; plantillas localizadas | Inventario específico, acuerdos firmados y aceptación del proceso de privacidad con el responsable |
| 14. Infraestructura | Supabase remoto leído; pila local privada y destinos configurados en guards de release | Verificación remota de ambientes/alias/Cron y continuidad del ensayo |
| 15. CI/CD | Commits atómicos, lock y gates preservados; publicación expresamente autorizada | Resultados de GitHub/Vercel y checks sobre el SHA fijo |
| 16. Errores/logs | Causas técnicas redactadas y regresiones contra filtración | Observación de la release nueva y correlación real |
| 17. Operación/alertas | DLQ visible en salud, telemetría y runbook de arranque | On-call, alertas verificadas y backup externo operativo |
| 18. Pruebas/arneses | SQL integrado aprobado; cohortes y revisiones independientes actuales. Las 11,748 pruebas y 71 casos de navegador son históricos de 0340 | Suite/build/navegador finales del candidato y repetir ensayo invalidado por suspensión |
| 19. Integraciones/webhooks | Firma, reintentos, causalidad y conectores seguros; PoC de archivos | Credenciales controladas, cuentas de pruebas, mapeos y aceptación SAP/Meta/GPS |
| 20. Agentes/prompts | Prompt efectivo del SDK, herramientas permitidas y motor exacto comprobados | Evaluación con documentos autorizados del cliente y supervisión operativa |

Los informes previos conservan la metodología y evidencias de las rondas anteriores. Esta matriz no asigna una puntuación numérica ficticia a elementos no observados.


Actualización del lote CodeQL: cobertura final `27be178b`, 12,067 PASS/0FAIL/3SKIP; líneas85.91%, ramas73.31%, sentencias83.22%, funciones86.64%. TypeScriptPASS y lint156/194sin nuevos. Los resultados anteriores de build/navegador mantienen su SHA y no se atribuyen automáticamente a esta versión. Ver `REVISION-CODEQL-PR332.md` para correcciones y clasificaciones individuales.
