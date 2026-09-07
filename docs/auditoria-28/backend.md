# Backend y API — auditoría 28

**Nota: 4/10** (antes 5). Razón del movimiento: **mirada más profunda** — el
código del rubro no cambió (los 3 commits de la ventana tocan `/dashboard` y
CI; ni una línea de `src/app/api/`, `processor.ts`, `repo.ts`, `conv.ts` ni
`supabase/migrations/`), **la nota anterior estaba inflada**. Dos cosas que
nadie había abierto lo demuestran: (1) el PDF de una liquidación **rechazada**
sigue descargable y sin marca, mientras el mismo trigger que borra el puntero
al PDF cuando la revisión pasa a `ajustada` deja intacto el caso `rechazada`
(`0346:12-25`) — el producto entrega papel de dinero invalidado y **nada lo
dice en ninguna parte**; y (2) BE-3 no eran «4 de 7 consultas cubiertas»: son
**seis agregados** todavía sin filtro, uno de ellos (`rentabilidad_tenant`) el
que pinta «Costo comprobado» y el **margen %** en la pantalla que esta misma
ventana modificó, y su prueba de equivalencia bendice el defecto porque el
espejo en JS repite la omisión.

En descargo de la 27, y hay que decirlo porque justifica no bajar más: su
afirmación de que BE-1 no deja «una sola señal» **es falsa** —
`drenado.ts:241-247` grita `alertarOperador('cartas_muertas')` en cada corrida
y `slo.ts:76-82` cuenta la fila atorada. El daño de BE-1 sigue, pero es «el
chofer no recibe nada y no hay salida», no «nadie se entera».

**El riesgo mayor del rubro, hoy:** el contralor rechaza una liquidación —el
único acto que existe para invalidarla— y el producto le sigue entregando su
PDF, su banner de «liquidó $X», su tarjeta de KPI y su margen con esa cifra
adentro. La invalidación es real en la base y **parcial en todo lo que sale**.

---

## Hallazgos

### [ALTO] El PDF de una liquidación RECHAZADA se sigue descargando, idéntico al de una vigente

`src/app/api/export/pdf/[id]/route.ts:87-105` (la consulta no selecciona
`revision`), `src/app/dashboard/[id]/page.tsx:285` (`pdfHref` solo mira
`d.pdfPath` y el rol), `supabase/migrations/0306_ajustar_regenera_desglose_y_pdf.sql:249-253`
(el `update` de `rechazar` no toca `pdf_url`),
`supabase/migrations/0346_pdf_publicacion_atomica.sql:12-25` (el trigger que
**sí** anula `pdf_url` — pero solo cuando `new.revision='ajustada'`),
`src/lib/likida/liquidacion/pdf.ts:90-92` (el generador que sí se niega).

**Escenario, con valores.** Viaje `F-1042`. El motor cierra: comprobado
$50,000, anticipo $50,000, estatus `cuadrada`, y `guardar_liquidacion_tx`
deja `pdf_url = '<tenant>/<viaje>.pdf'`. El PDF impreso lleva el sello
«PENDIENTE DE REVISIÓN» (`pdf.ts:93-95`) y ya se le entregó su ejemplar al
chofer.

10:00 — el contralor abre `/dashboard/<id>`, ve que el diésel de $8,000 es un
ticket de otro camión y pulsa **Rechazar** con motivo. `revisar_liquidacion`
escribe `revision='rechazada'` y regresa el viaje a `en_cuadre` (`0306:250-256`).
`pdf_url` **no se toca**: sigue apuntando al mismo objeto del bucket.

10:01 — en la misma pantalla el botón **Descargar PDF** sigue pintado
(`page.tsx:285` no consulta `revisionEstado`). El clic pega en
`/api/export/pdf/<id>`, que hace `select('pdf_url')` — sin `revision` — firma
una URL de 60 s y redirige (`:105-116`). Sale
`liquidacion_ab12cd34.pdf` con **$50,000 comprobados, estatus Cuadrada, sello
«PENDIENTE DE REVISIÓN»** y ni una palabra del rechazo ni del motivo. El
contador lo archiva y `registrar_descarga_liquidacion` lo marca como «el papel
entró al cierre de alguien» (`:135-139`).

Que esto es un defecto y no una decisión lo fija el propio repo en tres sitios:
`pdf.ts:90-92` **lanza** `DatoInvalido` si se le pide generar el PDF de una
rechazada («el PDF emitido antes deja de cuadrar con la base»), pero solo cubre
la generación, no el que ya está en el bucket; el trigger de la 0346 borra
`pdf_url`, archiva el anterior en `pdf_historial` y limpia
`entregada_operador_en`/`avisada_oficina_en` — **únicamente** en la rama
`ajustada` (`:12-25`); y `getLiquidacionesDeViajes` (`analytics.ts:1063-1066`)
ya devuelve importes en `null` para una rechazada. La regla existe en tres
capas y ninguna llegó al endpoint que entrega el papel.

**Consecuencia.** El contralor invalida una liquidación y el sistema le sigue
dando el documento que la afirma. El daño no lo sufre él (sabe que rechazó):
lo sufre su contador, que recibe el PDF por correo, y el chofer, que conserva
su ejemplar entregado. Es el artefacto que el producto promete que se puede
cruzar contra el panel — y aquí panel y papel dicen cosas opuestas.

**Prueba que lo cubra: ninguna.** `rutas_export.test.ts:191-215` prueba el
tenant y el `pdf_url` nulo; nunca `revision`. La ruta ni siquiera lee la
columna.

**Causa raíz probable.** La invalidación se implementó donde se ESCRIBE (RPC,
trigger, generador) y no donde se SIRVE; `rechazar` quedó fuera de la única
rama del trigger que retira el puntero al papel.

---

### [ALTO · REINCIDENTE] La liquidación rechazada sigue sumando dinero — y son SEIS agregados, no los tres que quedaban

`supabase/migrations/0150_agregados_analytics.sql:357-372` (`liquidado_semanal_tenant`),
`:418-455` (`operadores_detalle_tenant`), `:512-527` (`liquidaciones_por_dia_tenant`),
`supabase/migrations/0112_agregados_rpc.sql:243-249` (`serie_comparativa_tenant`),
`supabase/migrations/0174_diferencia_redondeo.sql:45-50` (`stats_operador_tenant`),
`supabase/migrations/0152_agregados_comercial_operacion.sql:63-68` (`rentabilidad_tenant`),
`src/lib/likida/espejo_0152.pruebas.ts:73-82` (el espejo que bendice el defecto),
`src/app/dashboard/rentabilidad/vista.tsx:82-95` (dónde se ve).

**Verificado, no recordado.** Abrí las siete definiciones vivas de funciones
que leen `liquidacion`. La 0344 (`0344_analytics_sin_rechazadas.sql`) toca
exactamente **dos**: `kpis_liquidacion_tenant` y
`dinero_observado_por_tipo_tenant`. Las seis de arriba siguen sumando
`total_comprobado` / contando filas sin mirar `revision` **y sin unirse a
`viaje.estatus`**, que es lo que salva a las demás (una rechazada obliga a
`viaje.estatus <> 'liquidado'` por el constraint diferido
`viaje_revision_coherente`, `0299:209-215`).

**El caso nuevo, con valores.** Flota con dos liquidaciones de la semana: A
$50,000 (aprobada) y B $30,000 (**rechazada**, viaje de vuelta en `en_cuadre`,
`ingreso_flete` de ambos viajes = $120,000).

- `/dashboard/rentabilidad` llama `getRentabilidad` (`comercial.ts:248-256`) →
  `rentabilidad_tenant`, cuyo CTE `l` suma **sin `revision`** (`0152:63-68`).
  La tarjeta «Costo comprobado por operadores» dice **$80,000**, «Contribución
  (ingreso − comprobado)» dice **$40,000**, y el renglón de abajo afirma
  «Margen: **33.3 %**». Los números verdaderos son $50,000 / $70,000 / 58.3 %.
  La pantalla remata con «Nada de esta pantalla se estima: si el dato no está,
  se dice» (`vista.tsx:60-61`) — y está estimando con $30,000 invalidados.
- `liquidado_semanal_tenant` devuelve $80,000 al banner de `/dashboard`
  mientras `kpis_liquidacion_tenant` (ya corregida por la 0344) dice $50,000:
  **dos cifras del mismo hecho en la misma sesión**.
- `serie_comparativa_tenant` (`liq`, `0112:244-249`), `operadores_detalle_tenant`
  (`c`, `0150:433-437`), `stats_operador_tenant` (`0174:45-50`) y
  `liquidaciones_por_dia_tenant` (`0150:518-525`) arrastran la misma B.

**La prueba bendice el defecto.** `espejo_0152.pruebas.ts:73-82` reimplementa
`rentabilidad_tenant` en JS **con la misma omisión**, y
`comercial_equivalencia.test.ts:129` compara el uno contra el otro: pasa en
verde porque los dos lados están mal. `analytics_rechazadas.test.ts` (4
pruebas, corridas: verdes) cubre solo las consultas JS.

**Consecuencia.** Además de la contradicción de la 27 (banner vs. KPI), ahora
está medido que el **margen** —la cifra con la que un contralor decide una
tarifa— se calcula con costo invalidado adentro. Y la pantalla que lo enseña es
`rentabilidad/vista.tsx`, el único archivo de producto que esta ventana tocó
(`4de95a0`), o sea que se revisó sin que nadie mirara de dónde salía el número.

**Causa raíz probable.** El arreglo se hizo contra la lista del hallazgo
anterior en vez de contra el inventario de funciones que leen `liquidacion`; no
hay una vista ni un predicado compartido que obligue a decidir sobre `revision`.

**Nota de alcance para quien lo arregle:** cinco de las seis son
`create or replace function` sobre migraciones ya aplicadas, así que **exige una
migración nueva** — y `scripts/ci/staging-recovery.mjs:121` fija el inventario
en `324/'0347'`. Es la razón por la que la 27 revirtió; hay que resolver eso
primero o el repo se pone rojo.

---

### [ALTO · REINCIDENTE] Una foto que agotó sus 5 intentos bloquea para siempre todos los cierres de ese chofer, sin salida y sin una palabra hacia él

`src/lib/likida/conv.ts:952-971` (`consultarFotoAnterior`, sin filtro por
`intentos`), `src/lib/likida/processor.ts:3746-3757` (quien la obedece),
`supabase/migrations/0325_capacidad_wa_jornada_timezone.sql:56` y `:96`
(`w.intentos < 5` en `listar_wa_pendientes`),
`src/app/api/cron/wa-pendientes/drenado.ts:152-161` (el `return` de la cadena).

**Verificado que sigue idéntico.** Reabrí los cuatro sitios: la consulta de
`conv.ts:954-965` filtra `procesado_en is null`, `type='image'` y
`evento->timestampMs < mensajeMs` — **nada de `intentos`**; `processor.ts:3748`
sigue haciendo `if (fotoAnterior !== false) { … soltarClaim(true); return; }`;
y `soltarClaim(true)` sigue devolviendo `'sin_tiempo'` (`processor.ts:1341`), que
en `drenado.ts:157-160` llama a `devolverIntentoPendiente` y hace `return` de la
cadena entera de ese remitente.

**Escenario, con valores.** Chofer `5219993700779`. 1-sep 10:00 manda una foto;
`processInbound` truena 5 veces (media hora de OCR caído): la fila queda
`intentos = 5`, `procesado_en IS NULL` → carta muerta, invisible para
`listar_wa_pendientes`, borrada a los 90 días (`0155:150`). 10:40 escribe
«listo»: `fotoAnteriorSinProcesar` encuentra la carta muerta, devuelve `true`,
el turno se aplaza **sin consumir intento** y **sin mandarle un solo mensaje**.
Cada vuelta del cron repite el ciclo, y como el «listo» es la cabeza de la
cadena, sus fotos nuevas y sus viajes nuevos tampoco avanzan. Busqué otra vez
un reencolado, un `intentos = 0`, un `procesado_en` manual o una pantalla sobre
`wa_evento_pendiente`: los cinco lectores/escritores de la tabla están en
`route.ts`, `wa_pendientes.ts`, `conv.ts`, `slo.ts` y `startup.ts`. **No existe
ninguno.**

**Corrección a la ronda 27:** sí hay señal de operador. `drenado.ts:241-247`
llama `alertarOperador` con `codigo: 'cartas_muertas'` en CADA corrida mientras
la fila exista, y `slo.ts:76-82` la cuenta como «Mensajes de WhatsApp atorados».
Lo que no hay es (a) nada que diga que la cadena de ESE chofer está congelada
detrás de ella, (b) camino de resolución desde el producto, y (c) un solo
mensaje al chofer. Efecto colateral medido: `pospuestos > 0` en cada vuelta
mantiene el latido en `parcial` para siempre (`drenado.ts:250-254`) — una alarma
que nunca se apaga es una alarma que se deja de leer.

**Consecuencia.** El chofer manda comprobantes durante días y el bot no le
contesta; la flota no liquida esos viajes y el anticipo se queda abierto. Sale
por la consola de Supabase o esperando 90 días.

**Prueba que lo cubra:** `conv_foto_anterior_aud24.test.ts:71-75` fija el
comportamiento («una foto agotada sigue siendo evidencia pendiente»), o sea que
está probado el defecto, no el remedio.

**Causa raíz probable.** Se trata un estado **terminal** (carta muerta) como si
fuera transitorio; el aplazamiento no tiene techo, ni caducidad, ni aviso, a
diferencia del fallo de OCR, que sí tiene salida (`resolverIncidenteOcrDeEstaFoto`,
`processor.ts:2218-2239`).

---

### [ALTO · REINCIDENTE] Un «listo» sin hora de Meta se aplaza para siempre — y así el arnés de QA reporta verde un cierre que no ocurrió, quemando OCR y LLM de pago

`src/lib/likida/processor.ts:3688-3703`, `src/lib/admin/qa-motor.ts:745`, `:748`,
`:750`, `:1397`, `:1400`.

**Verificado que sigue idéntico.** `processor.ts:3697-3703`:
`if (cierreSolicitado && timestampCierreMs === null) { logger.warn(…); await
soltarClaim(true); return; }`. Y el único llamador del repo que manda «listo»
sin hora sigue sin ella: `qa-motor.ts:745`
`await processInbound({ from: telefono, type: 'text', text: TEXTO_CIERRE,
waMessageId: \`${prefijo}t1\` })` — sin `timestampMs`. Igual en `:1397`.

**Escenario, con valores.** `TEXTO_CIERRE = 'listo, ya subí todo'`
(`qa-motor.ts:572`). `pidioCerrar` empata (`processor.ts:516`),
`timestampCierreMs = null`, el turno hace `soltarClaim(true); return`: **la
liquidación no se genera**. `hayLiquidacion(...)` → `false`, el arnés insiste
con `t2` (`:748`) — mismo resultado — y en `:750` cierra el paso con
`await cerrarPaso(pC, 'ok', pC.detalle)`: **verde sobre un cierre que no
ocurrió**, con las fotos y las llamadas de visión ya pagadas.

**Consecuencia.** (a) La única corrida punta a punta contra el motor real ya no
puede cerrar nada y lo reporta en verde: cada lanzamiento desde `/admin/qa/lanzar`
gasta OCR y LLM de pago para producir un falso positivo. (b) Fuera de QA:
cualquier mensaje cuyo `timestamp` de Meta llegue ilegible (`route.ts:685` lo
vuelve `undefined` sin ruido) queda aplazado sin consumir intento — otra fila
inmortal y otro chofer sin respuesta.

**Prueba que lo cubra:** `aviso_barrera_cerrado.test.ts:105-108` fija el
comportamiento del motor; `qa-motor.test.ts:286` **mockea `processInbound`**, por
eso `npm test` no ve la rotura del arnés.

**Causa raíz probable.** La guardia resuelve la ausencia de hora con un
aplazamiento sin techo en vez de un número acotado de vueltas o un mensaje al
humano, y el cambio nunca se propagó al llamador interno que siempre llamó sin
hora.

---

### [MEDIO · REINCIDENTE] Un bache de red al leer la revisión pinta una liquidación RECHAZADA como si estuviera vigente

`src/app/dashboard/[id]/page.tsx:198`, `src/app/dashboard/[id]/detalle.tsx:421-424`.

**Verificado que sigue idéntico.** `page.tsx:198`:
`const revisionEstado: RevisionDetalle | null = await leerRevision(tenantId, id).catch(() => null);`
y `detalle.tsx:421` sigue siendo `{revision && (<PanelRevision …/>)}`.

**Escenario, con valores.** Liquidación de $30,000 con `revision='rechazada'` y
su motivo. `leerRevision` está bien construida —usa `exigir(res, 'revision.leer')`
y **lanza** ante error (`revision.ts:318-343`)—, pero el `.catch(() => null)` la
convierte en «no hay». Un timeout de `acotada`, un 503 de PostgREST o un blip
del pool → el panel de revisión **no se pinta**, y queda en pantalla el chip
«Cuadrada», los $30,000 y el botón de PDF, sin una línea que diga que fue
rechazada ni que hubo un error. El `catch` no registra qué fila falló.

**Consecuencia.** El contralor lee como vigente una liquidación que él mismo
invalidó. Es el modo de falla que `exigir()` existe para impedir, anulado por el
llamador en el último metro — y se compone con el hallazgo del PDF de arriba: en
ese estado el botón de descarga también sigue ahí.

**Causa raíz probable.** Un `.catch` defensivo aplicado a un dato que **cambia
el significado de las cifras que tiene debajo**; el resto del archivo sí
distingue «no hay» de «no se pudo» (`totalOperadores`, `:275-277`).

---

### [BAJO] `tomarTicket` es el único claim del repo que no está anclado: dos agentes pueden «tomar» el mismo ticket y los dos leen que es suyo

`src/lib/likida/soporte.ts:322-358` (en particular `:337-342`).

**Escenario, con valores.** Ticket `T-77` en `estado='abierto'`,
`asignado_a = NULL`. Ana (`userId=A`) y Beto (`userId=B`), los dos superadmin en
`/admin/soporte`, pulsan **Tomar** con 200 ms de diferencia. Los dos pasan
`exigirTicket` (leen `estado='abierto'`), y los dos hacen
`update({ asignado_a: <suyo>, estado: 'en_proceso' }).eq('id', …).eq('tenant_id', …)`
— **sin `.is('asignado_a', null)` y sin `.select()` para comprobar si aplicó**.
La función no puede fallar: `error` es `null` en ambos casos y devuelve
`{ estado: 'en_proceso', asignadoA: A }` a Ana y `{ …, asignadoA: B }` a Beto.
La base guarda `B`; la pantalla de Ana dice que el ticket es de ella. La
bitácora registra dos `ticket.tomado`.

**Consecuencia.** Es exactamente el estado que el módulo dice existir para
evitar («una cola donde tres personas creen que lo tiene otra es una cola donde
nadie contesta», `:315-317`), y la alarma de «sin respuesta» del agente de Éxito
tampoco se apaga por tomar. Duele en el equipo que atiende, no en el contralor —
de ahí BAJO.

**Refutación intentada.** Busqué la unique/constraint que lo cubriera: la 0268
solo agrega `asignado_a` y policies de la nota interna; `ticket_soporte` no tiene
índice parcial sobre `asignado_a`. El contraste es del propio repo: TODOS los
demás claims sí anclan y comprueban —`ordenes-claim` con `.eq('estado','pendiente')`
(`worker/bus/[accion]/route.ts:81-193`), `reclamarIntentos` con
`.or('autofactura_intentada_en.is.null,…')` + `.select('id')`
(`al_vuelo.ts:833-845`), `finalizar_poll_conector` con `claim_token`
(`repo.ts:1799-1801`), `cerrarOrden` con `.neq('estado','cerrada')` + `.select()`
(`mantenimiento.ts:420-426`)—; este quedó fuera del patrón.

**Causa raíz probable.** Se escribió como un `update` de campo y no como el
claim que es; el `.select()` de verificación es lo que falta, no una tabla nueva.

---

## Lo que revisé y está bien

- **La cola de autofactura NO emite dos CFDI.** `reclamarIntentos`
  (`al_vuelo.ts:820-851`) es un UPDATE condicional que pisa la misma columna que
  filtra (`autofactura_intentada_en` nula o vencida a los 10 min) y devuelve
  filas: el primero deja a los demás sin nada, y un error de la RPC **falla
  cerrado** (`:846-850`, `return new Set()`). El encolado a QStash no reclama,
  pero el callback sí, y el `deduplicationId` por `(tenant, portal, ranura de 15
  min)` (`cron/facturar/route.ts:457`) cierra el at-least-once de Vercel Cron.
  El cruce «se encoló y nadie procesó» (`:405-416`) cae al camino síncrono con
  alerta en vez de encolar al vacío.
- **`export/liquidaciones`** (`route.ts:95-210`): filtro de revisión explícito
  con default declarado (`sin_rechazadas`, `revision.ts:68-76` rechaza un valor
  desconocido con 400 en vez de recortar), keyset `(created_at, id)` en vez de
  `range` por posición, `count` exacto en la primera página, y **aborta el
  stream** si `leidas < esperadas` o si se agotan las 100 páginas (`:186-193`) —
  un CSV corto nunca cierra en limpio.
- **`/v1/liquidaciones`** (`route.ts:113-158`): mismo filtro, default
  `firmadas`, valor desconocido → 400 con texto, cursor con la rama del empate
  de microsegundo, y `exigir()` en la lectura.
- **`facturacion_clientes_tenant`** (`0152:256-330`) y
  **`casetasMedidasPorRuta`** (`cotizador/lector.ts:145-175`): los dos se anclan
  a `viaje.estatus = 'liquidado'`, que el constraint diferido
  `viaje_revision_coherente` (`0299:209-215`) vuelve incompatible con
  `revision='rechazada'`. Están a salvo del hallazgo BE-3 **por construcción**,
  no por suerte.
- **El fencing de los pollers de conectores** (que la 27 dejó sin leer):
  `reclamar_polls_conector` entrega `claim_token` y la frontera **lanza** si la
  fila viene incompleta (`repo.ts:1753-1757`); `finalizarPollConector` lanza si
  el lease venció o es ajeno (`:1801`). En `sincronizarGpsTodas`
  (`sincronizar_gps.ts:294-328`) solo se reclama lo que el pool puede arrancar,
  el corte por reloj **finaliza el poll** en vez de abandonarlo (`:306`), y
  `conPool` (`lotes.ts:48-68`) escribe en `salida[i]` por índice — así que el
  `credenciales[i]` del camino de error (`:331`) atribuye el fallo a la flota
  correcta. Lo verifiqué porque es justo donde una atribución cruzada sería
  invisible.
- **La compuerta de privacidad del GPS va ANTES del upsert**
  (`sincronizar_gps.ts:206-222`): si `unidadesSinAvisoPrevio` no se puede leer,
  **no se guarda nada de esa flota**. «No sé si avisé» no es permiso.
- **`cerrarOrden`** (`mantenimiento.ts:415-442`): cierre atómico por el WHERE
  (`.neq('estado','cerrada')` + `.select()`), «ya estaba cerrada» se dice, y el
  odómetro solo AVANZA (`or('km_actual.is.null,km_actual.lt.…')`), con el fallo
  del avance registrado sin revertir el cierre.
- **`soporte.getHilo`** (`soporte.ts:196-207`): `interna=false` va **en la
  consulta**, no en un filtro de memoria, y `getTicketDelTenant` lanza ante error
  de lectura para que `null` signifique una sola cosa.
- **`revisar_liquidacion`** (`0306:112-160`): candado del viaje antes que el de
  la liquidación (mismo orden que `guardar_liquidacion_tx`), LR010 impide firmar
  dos veces, LR011 impide re-firmar una rechazada, LR020 exige que el recálculo
  de TypeScript coincida con el ajuste aplicado dentro de la MISMA transacción, y
  la bitácora entra en esa transacción. El 23505 de
  `uq_viaje_abierto_por_operador` se traduce a texto para la persona
  (`revision.ts:464-466`).
- **`pg_errores.ts`** (todo el archivo, 45 líneas): `violaIndice` exige `23505`
  **y** el nombre del índice; no se traga un error real por un mensaje que
  casualmente lo mencione.

Corridas en esta ronda (verdes): `analytics_rechazadas.test.ts`,
`revision.test.ts`, `rutas_export.test.ts` — 87 pruebas, 3 archivos.

---

## Lo que NO alcancé a revisar

- **~35 rutas de `src/app/api/`**: `correo/{entrante,baja,eventos}`, `mcp` y su
  OAuth, `marketing/*`, `lead`, `admin/copiloto`, `admin/mapa-prospectos`,
  `admin/qa/*` (las rutas), `webhook/calcom` y `webhooks/calcom`,
  `cron/{descarga-sat,jornada,portales-vivos,runner,escalar,purgar,asistencia}`,
  `export/{bitacora-peaje,carta-porte-xml,facturas-proveedor,jornada}`,
  `stripe`, `client-error`.
- **`cron/facturar/lote.ts` y `cola/route.ts`** (915 + N líneas): leí el
  despacho y el claim, no el interior de la sesión de portal ni el reloj de
  `procesarLoteEnCola`.
- **`senales_pmf`** (`0162:70`) y `poliza_datos_tenant` (última versión
  `0307:41`): son del inventario de BE-3 y no los abrí; la póliza tiene su
  propia compuerta de firma, `senales_pmf` es telemetría de `/admin`.
- **`auditor_cobranza.ts:584`, `libro_viaje.ts:590`, `avisar_cierre.ts:78`,
  `fiscal.ts:1822`, `agentes/exito.ts:687`**: cinco lectores de `liquidacion`
  que no clasifiqué respecto de `revision`.
- **Todo lo que necesita Postgres vivo.** No hay base aquí: cuanto afirmo de SQL
  sale de leer la migración, no de ejecutarla. `supabase/verificaciones.sql` (308
  bloques) sigue sin correr.
- **No corrí `npm test` completo**: usé la línea base del MAPA (5 fallos INFRA
  por IPv6) y solo las tres suites citadas arriba.
