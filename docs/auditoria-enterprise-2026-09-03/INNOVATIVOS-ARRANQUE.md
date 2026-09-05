# Transportes Innovativos: preparación del arranque

Actualizado el 5 de septiembre de 2026, hora de Mérida. Documento de trabajo; no acredita una puesta en producción. El objetivo técnico de capacidad es **800 unidades y 15,000 viajes al mes**. Es una carga de aceptación sintética, no un inventario ni un volumen mensual confirmado por el cliente.

## Alcance del piloto encontrado en Drive

La [propuesta preliminar del 16 de agosto](https://drive.google.com/file/d/1qnCBHtBkrugYGvjii3uZZWuuhZr1U8UX/view) recoge un PoC de 30 días centrado en dos recorridos:

1. Desglose de peajes → conciliación contra gastos y viajes → tres categorías de discrepancias → confirmación humana del cruce → bitácora CSV.
2. Facturas de proveedor → bandeja de aprobación → exportación CSV para importar en SAP Business One, con marca visible de exportación y control humano de importación.

Ese documento deja para una segunda fase la escritura directa a SAP, el cruce contra GPS del TMS y el canal de WhatsApp. Mientras no llegue una corrección del usuario, éste es el alcance de aceptación del piloto. Se mantiene la auditoría técnica ampliada ya autorizada, pero no se confunde con lo que el cliente aceptó contratar: la propuesta es preliminar.

La carpeta [02-transportes-innovativos](https://drive.google.com/drive/folders/1cSB9T5xpF-d3XmvyiI-QQpq0G4buWJjI) contiene investigación, propuestas, escenarios y mensajes preparados. En sus hijos directos revisados no aparecieron catálogos operativos ni acuerdos firmados. La ficha comercial contiene estimaciones históricas corregidas; no deben convertirse en parámetros productivos sin confirmación del cliente.

## Decisión actual

**No iniciar operación real todavía.** Los permisos financieros de formulario/importación, el fallo de pactos de estadía y el transporte de conectores ya están corregidos y revisados. La suite global posterior pasó **11,748 pruebas, cero fallos y una omitida**; el build privado y las 71 pruebas finales de navegador pasaron sobre la migración 0340. El ensayo de 24 horas se detuvo al confirmar suspensiones repetidas de la Mac y no acredita estabilidad continua. Falta resolver la identidad del despliegue, actualizar el esquema remoto y confirmar los datos y acuerdos del cliente.

Este documento complementa `ESTADO-2026-09-04.md`. La evidencia nueva de dependencias y capacidad de abajo sustituye las cifras anteriores para esos puntos. No se han hecho push, despliegues, cambios productivos, mensajes externos ni pruebas de proveedores de pago.

## Evidencia nueva

| Verificación | Resultado observado | Alcance y límite |
|---|---|---|
| Instalación reproducible | `npm ci --no-audit --no-fund`; `npm ls --depth=0` termina sin errores | Antes había dependencias instaladas distintas del lock. La nueva corrida usa Next 16.3.3 y OpenAI 7.9.0 |
| Suite global con lock exacto | 11,748 aprobadas, 0 fallidas, 1 omitida | JSON local `/private/tmp/innovativos-integracion-ssrf.json`. La omitida requiere ticket real y OCR de pago. Incluye las correcciones de conectores |
| Cobertura global | 11,754 aprobadas, cero fallidas, tres omitidas; umbrales intactos | Statements 82.98%, branches 72.94%, functions 86.44%, lines 85.67%. Incluye ocho canarios TLS añadidos tras la corrida global; las omisiones corresponden a OCR de pago y mediciones no válidas con instrumentación |
| Navegador final | 71/71 aprobadas en 1.5 min; salida cero | Seis sesiones, MFA, HTML/RSC, permisos, importación, peajes, proveedores, caché, móvil y ARCO. Commit `c4c4b76b`; evidencia `/private/tmp/innovativos-rbac/suite-71-final.log` |
| Build privado | Build de producción con Next 16.3.3 y SQL 0340 aprobado | Supabase local desechable, sin secretos de proveedores; advertencia conocida de importación dinámica de CFDI |
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

## Estado remoto comprobado, sólo lectura

- Proyecto Supabase Likida `gngoqsvrxdguxvsizpbw`: activo, región `us-east-2`, PostgreSQL 17.6.1.147. Historial remoto llega a **0303**; local llega a **0340**. La migración 0340 fue aplicada y reaplicada en bases desechables con prueba real de ARCO; la batería general posterior mantiene 242 bloques, 238 aprobados, cero fallos y cuatro reportes.
- La consulta por nombre de tenant que contiene `innovativ` no devolvió filas. No descarta una flota registrada con otro nombre. Antes de cualquier alta se debe resolver su identidad para evitar duplicados.
- Vercel devolvió 404 al consultar los identificadores locales. Hay que confirmar proyecto, equipo y acceso; ese resultado no demuestra que el sitio no exista.
- Las incidencias Sentry registradas en el informe anterior corresponden a una release anterior. No se cerraron ni se atribuyeron al código local sin reproducción.

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

1. Cerrar regresiones locales y revisión independiente; fijar el SHA exacto del candidato, con árbol limpio. Completar navegación por rol y revisar resultado del ensayo de 24 horas.
2. Confirmar identidad de proyectos, ambientes y flota. Revisar nombres de secretos y protecciones sin divulgar valores. Resolver los acuerdos y datos del cliente.
3. Preparar respaldo recuperable de base **y archivos**, con manifiesto, hashes y prueba de restauración aislada. El restore SQL local no acredita recuperación de Storage remoto ni PITR.
4. Revisar la lista concreta de migraciones pendientes y sus precondiciones. El preflight de índices concurrentes realiza escrituras incluso antes del `db push --dry-run`; debe formar parte de la autorización externa.
5. Publicar y ejecutar checks sólo con autorización de la promoción concreta. Usar el workflow manual `deploy-preview-promote.yml` con SHA fijo, ambientes y gates documentados en `docs/operacion/RESILIENCIA-DEPLOY.md`. El script histórico `aplicar-migraciones-y-humos.sh` todavía describe verificaciones de 0115–0125 y no constituye la aceptación de 0340.
6. Validar staging y proveedores de prueba autorizados. Comprobar recepción, duplicado, fallo transitorio, cierre, revisión humana cuando corresponda, PDF y exportación; guardar IDs y resultados sin datos sensibles.
7. Promover únicamente el candidato validado. Migrar antes de activar la aplicación que depende del esquema; registrar inicio, fin, checks y responsable. Un rollback de Vercel no deshace migraciones de base de datos.
8. Importar una muestra aprobada del cliente, cotejar conteos y totales con su fuente, y ejecutar una jornada controlada con el responsable operativo antes de ampliar volumen.

Los límites de SLA, RPO y RTO sólo se aceptan con la evidencia correspondiente. Los objetivos del runbook y las plantillas contractuales no son resultados medidos.

## Condiciones de suspensión del arranque

Detener la ampliación si hay datos de otra flota, permisos financieros indebidos, cierres o gastos duplicados, diferencias de conciliación sin explicar, mensajes críticos sin entrega confirmada, migraciones incompletas, fallos de restauración o ausencia de un responsable que atienda excepciones. Registrar el incidente y preservar la evidencia antes de reintentar.

## Entrega técnica y pendientes externos

Las correcciones de permisos, estadías, DLQ, transporte del worker, conectores HTTPS, integridad de dependencias y alcance de ARCO están integradas en commits locales. Las pruebas de navegador y su sembrador cubren las seis sesiones, MFA, permisos, caché y ambos recorridos del PoC; el último caso ARCO pasó sobre la migración 0340, incluida la lectura inmediata de la resolución y la ausencia de intento de envío de WhatsApp. El candidato local con código y pruebas es `c4c4b76b` en `codex/auditoria-enterprise-fix-ci`.

Para completar el arranque real siguen siendo necesarios: una Mac conectada a corriente y sin suspensión para repetir el ensayo de 24 horas; identificación y acceso al despliegue; datos y responsable operativo del cliente; muestras y mapeos de SAP; acuerdos firmados; recuperación comprobada de archivos; y autorización concreta de promoción. El último estado de energía observado fue batería al 12%, sin cargador. No se inició otra corrida.

## Matriz de cobertura de la auditoría

La calificación de promoción es **NO-GO productivo** mientras sigan abiertos los requisitos externos y la prueba continua. Una prueba local aprobada no acredita un proveedor ni una configuración remota. La tabla distingue lo comprobado del trabajo pendiente; los veinte rubros aplican al servicio.

| Rubro | Evidencia disponible | Cierre pendiente |
|---|---|---|
| 1. Consistencia de negocio | Cierre, idempotencia y fronteras comprobadas; PoC peajes/proveedores focales aprobados | Aceptación de totales, discrepancias y políticas con una muestra del cliente |
| 2. Arquitectura | Invariantes de jornada, aislamiento de persistencia y separación motor/proveedores revisados | Topología e identificación de dependencias remotas del candidato |
| 3. Resiliencia | Fallos de persistencia/Storage sin cierres inventados; restore SQL independiente | Restore de archivos remoto, PITR/RPO y continuidad del entorno real |
| 4. Escala y costo | Dataset de expansión, ráfaga, EXPLAIN y fairness SQL | Repetir 24 horas continuas; tráfico HTTP/proveedores y costo por flujo |
| 5. Frontend | Roles, MFA, importación, estadías, RSC y focos PoC | Aceptación del cliente y accesibilidad integral |
| 6. Backend/API | Cuerpos acotados, autorización previa y contratos de exportación | Verificación de transporte y configuración en el despliegue aprobado |
| 7. Dinero y fiscalidad | Motor/regresiones, decisión humana de proveedores y CSV de contenido exacto | Layout y catálogos SAP, instancia real y validación fiscal competente |
| 8. DB/migraciones/Storage | SQL 0340 y 238 verificaciones; upgrade histórico y restore sintético | Drift/datos reales, backup de archivos y rollout autorizado |
| 9. Caché/CDN | Páginas autenticadas con `no-store`; anónimo sin contenido autenticado; canarios RSC | CDN real; la puerta PDF y URL firmada local no mostraron Cache-Control, no se afirma no-store para ellas ni revocación efectiva del objeto a los 60 segundos de vencer el token |
| 10. Cuotas y abuso | Cuotas previas a lectura, cancelación y equidad SQL de claims | Saturación distribuida y límites efectivos de proveedores |
| 11. Auth/RBAC/tenants | MFA real, seis usuarios y flotas A/B; permisos financieros reparados | Validar invitaciones y responsables del tenant real |
| 12. Seguridad/supply chain | SSRF con TLS real, límites, guard de tarball y lock exacto | Políticas y secretos remotos; la prueba de integridad no es firma del fabricante |
| 13. Privacidad/retención | Retención e integridad SQL revalidadas; ARCO describe datos retenidos sin prometer anonimización total; plantillas localizadas | Inventario específico, acuerdos firmados y aceptación del proceso de privacidad con el responsable |
| 14. Infraestructura | Supabase remoto leído; pila local privada verificada | Identidad/acceso Vercel, ambientes, energía y continuidad para ensayo |
| 15. CI/CD | Commits atómicos, lock, tipos y lint sin relajar gates | Publicación autorizada y checks de promoción sobre SHA fijo |
| 16. Errores/logs | Causas técnicas redactadas y regresiones contra filtración | Observación de la release nueva y correlación real |
| 17. Operación/alertas | DLQ visible en salud, telemetría y runbook de arranque | On-call, alertas verificadas y backup externo operativo |
| 18. Pruebas/arneses | 11,748 tests aprobados; SQL real, navegador y TLS independiente | Repetir ensayo invalidado por suspensión |
| 19. Integraciones/webhooks | Firma, reintentos, causalidad y conectores seguros; PoC de archivos | Credenciales controladas, cuentas de pruebas, mapeos y aceptación SAP/Meta/GPS |
| 20. Agentes/prompts | Prompt efectivo del SDK, herramientas permitidas y motor exacto comprobados | Evaluación con documentos autorizados del cliente y supervisión operativa |

Los informes previos conservan la metodología y evidencias de las rondas anteriores. Esta matriz no asigna una puntuación numérica ficticia a elementos no observados.
