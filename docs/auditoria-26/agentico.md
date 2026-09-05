# Sistema agéntico y orquestación — auditoría 26

**Nota: 6/10** (antes 5). Razón del movimiento: **se atacó y subió.** Ocho de
los diez hallazgos abiertos están cerrados **de verdad** —los verifiqué uno por
uno contra el fuente, no contra el mensaje del commit—, incluidos los dos ALTO
que llevaban dos rondas verbatim desde la 24. Es el mejor resultado que ha
tenido este rubro. Sube UN punto y no dos porque el patrón de la casa volvió a
aparecer en una variante nueva: `908d69b` arregló la línea que el hallazgo
señalaba (no sellar `avisada_oficina_en` sin PDF) y **no contestó la pregunta
que venía detrás** —«¿y qué pasa la próxima vez que este camino corra?»—, así
que cambió un PDF que no se reintentaba nunca por un aviso de cierre que se
reintenta **sin techo**. Y al recorrer dos ciclos que ninguna ronda había
caminado (la coordinación de proveedor en emergencia, y el reloj de SLA de
soporte) aparecieron dos bordes de la misma familia.

Riesgo mayor hoy: la emergencia de carretera. Cuando el dueño toma un ámbar que
se le escaló porque el jefe de tráfico no contestó, autoriza la grúa y Likida le
dice **«te lo paso con botones»**, la cotización del gruero —con precio y con la
firma que compromete el dinero— se le manda al **jefe de tráfico**, no a él; y si
ese número tiene la ventana de 24 h cerrada, **nadie la recibe, nadie se entera y
el expediente no lo registra** (`asistencia_coordinacion.ts:645-666`).

---

## Verificación de lo que venía abierto

| Hallazgo de la 25 | Commit | Veredicto |
|---|---|---|
| ALTO · las DOS salidas de CORREO (`flota_fiscal`, `usuariosAvisables`) | `c75320d` | **CERRADO** |
| MEDIO · el filtro de la BASE sin prueba | `2879462` | **CERRADO** |
| ALTO · el resumen de la ráfaga cuenta copias (REINC. de la 24) | `62c44f2` | **CERRADO** |
| ALTO · «tu jefe ya tiene la solicitud» (REINC. de la 24) | `46b12e2` | **CERRADO** |
| MEDIO · el prompt dice «páginas en reconstrucción» | `d65c286` | **CERRADO** |
| MEDIO · firma de PDF fallida sella `avisada_oficina_en` | `908d69b` | **CERRADO, y abrió otro** (ver ALTO-1) |
| MEDIO · `prompt_ref` NULL → alarma insatisfacible | `5ff4155` | **CERRADO** |
| MEDIO · tenant fantasma, la otra rama | `1c1211d` | **CERRADO** |
| MEDIO · el sondeo de la 0172 inserta un `tenant` | `497bc97` | **PARCIAL → REINCIDENTE** (MEDIO-2) |
| BAJO · `telefonosJefe` sin techo | `2f35dfb` | **CERRADO** |
| BAJO · resumen de ráfaga y corte por `sendText` | — | **REINCIDENTE, 3ª ronda** (BAJO-1) |

Lo que comprobé para no firmar un cierre de papel:

- **Correo.** Rehice el barrido por la PREGUNTA («quién resuelve un destinatario
  desde `app_user`»), no por la columna: `grep -rn "from('app_user')"` da 34
  consultas; las seis que resuelven a-quién-se-le-escribe filtran `activo` en la
  base y en TS (`contactos.ts:73,159,204`, `asistencia_escalamiento.ts:123`,
  `flota_fiscal.ts:120`, `notificaciones.ts:720`). Las otras 28 son perfil,
  actor o rótulo (`interruptores.ts:336`, `mcp/sesiones.ts:214`,
  `agentes/cola.ts:279`), no destinatario. No hay una séptima puerta.
- **La prueba del filtro en la base** (`activo_filtro_en_base.test.ts`) corre en
  verde (7/7) y además tiene el candado que faltaba: si aparece una consulta más
  a `app_user` en cualquiera de esos cuatro archivos, la prueba se pone roja.
- **Ráfaga.** `processor.ts:2946-2949` calcula `comprobantes` y `total` con
  `copiasDeComprobante` y el mismo filtro `monto > 0` que `engine.ts:640-644`.
  Es la misma aritmética, no una segunda.
- **Talacha.** La 0305 añadió `incidencia.avisada_jefe_en` y las tres frases se
  bifurcan sobre el HECHO persistido (`talacha_wa.ts:264-284` y `:307-329`), con
  reintento del aviso en la rama que antes mentía.

---

## Hallazgos

### [ALTO] El arreglo del sello convirtió «un PDF que no se reintenta nunca» en «un aviso de cierre que se reintenta sin techo»: el contralor recibe la misma liquidación una vez por cada mensaje del chofer
`src/lib/likida/processor.ts:1076-1098` (`entregarCierrePendiente`) ·
`src/lib/likida/processor.ts:4386-4390` · `src/lib/likida/avisar_cierre.ts:162-238`

`908d69b` hizo lo correcto en la línea que el hallazgo señalaba: si había PDF del
contralor y no llegó, ya no se sella `avisada_oficina_en`. Lo que no miró es qué
corre después. `avisarCierreAlJefe` **no consulta el sello ni ningún otro hecho
persistido**: cada vez que se la llama vuelve a armar el resumen completo, vuelve
a mandar el texto por `avisarOficina` (`:186`) y vuelve a mandar el
`sendDocument` (`:222`). Y `entregarCierrePendiente` se dispara desde
`processor.ts:1993`, que está en la rama «no hay viaje abierto» — o sea, **con
CUALQUIER texto del chofer** dentro de las 24 h de `VENTANA_LIQUIDACION_RECIENTE_MS`
(`conv.ts:242`), no solo con un «listo».

Escenario, con valores: 18:02, el chofer Juan cierra el viaje `V-4412` de la flota
Innovativos. El texto le llega al contralor («Liquidación LIQ-000412: requiere tu
decisión — anticipo $12,000.00, comprobado $9,681.50, diferencia $2,318.50»). El
`sendDocument` del `innovativos/V-4412.pdf` se cae por un blip de red:
`meta/client.ts:524-531` **encola el payload entero** para el outbox y devuelve
`{ok:false}` → `pdfEnviado = false` → `pdfJefeOk = false` → no se sella. 18:07 el
outbox reintenta y **el contralor recibe su PDF**. 18:09 Juan escribe «gracias» —
no tiene viaje abierto, cae en `:1988`, `avisadaOficinaEn` sigue NULL →
`avisarCierreAlJefe` corre otra vez → el contralor recibe **el mismo texto de
decisión y una segunda copia del mismo PDF**. Juan escribe «¿y mi caseta?» a las
18:12 → tercera copia. Nada acota esto salvo que un `sendDocument` termine en
`ok:true` o que pasen 24 h.

La variante persistente es peor y es la del demo: si Meta rechaza el documento
con un código NO reintentable —131030, «ese número no está en la lista de pruebas
de la cuenta», que es exactamente el estado en que está la cuenta hoy— y la
liquidación es `cuadrada` (`requiereDecision === false`, así que
`avisar_cierre.ts:185` **no manda texto** y la función devuelve `enviado: true`
igual), entonces `pdfEnviado` es `false` para siempre: cada mensaje del chofer
durante 24 h vuelve a leer `app_user`, vuelve a firmar Storage y vuelve a pegarle
a la Graph API, con un `cierre.pdf_al_jefe_falló` por vuelta y sin que nadie lo
escale.

Consecuencia: el contralor ve la misma liquidación anunciada tres o cuatro veces
—«se duplicó el sistema» es literalmente lo que `avisar_cierre.ts:145` dice que ya
se vio en producción el 24-ago y que este archivo existe para evitar— y, en la
rama persistente, el ciclo de cierre queda en bucle silencioso. Antes del arreglo
el aviso salía UNA vez y el PDF se perdía; ahora el PDF se recupera al precio de
un efecto duplicado sin cota.

Causa raíz probable: el sello `avisada_oficina_en` es de grano grueso —cubre
texto Y documento— y el arreglo lo condicionó al documento sin darle al texto su
propia idempotencia. Las pruebas que acompañan el commit
(`processor_cierre_parcial.test.ts:399-430`) verifican que **no se sella**;
ninguna verifica qué pasa en el turno siguiente.

(Nuevo, nacido del cierre de un MEDIO de la 25.)

---

### [ALTO] La cotización de la grúa se le manda al jefe de tráfico aunque la haya pedido el dueño, y si no sale nadie se entera: ni el que autorizó, ni el chofer varado, ni el expediente
`src/lib/likida/asistencia_coordinacion.ts:645-666` ·
`src/lib/likida/asistencia_coordinacion.ts:372` ·
`src/lib/likida/contactos.ts:116-123`

`iniciarContacto` guarda `autorizada_por: cuenta.userId` (`:335`) y le contesta a
ESE humano «Le escribí a X ✅ — en cuanto responda con tiempo y precio, **te lo
paso** con botones para confirmar» (`:372`). Cuando el proveedor contesta, el
destinatario **no** sale de `autorizada_por`: sale de `telefonoJefeDe(c.tenantId)`
(`:647`), que es `telefonosJefe` con `ORDEN_AVISO = ['encargado','flota_admin']`
(`contactos.ts:116`) — el encargado primero.

Escenario, con valores: 23:38, el chofer Juan reporta «se me ponchó, estoy en la
150D km 210». `avisarAlJefe` manda el ⚠️ con botón a Beto, el `encargado`
(`asistencia_wa.ts:401` → `telefonoJefeDe`). Beto duerme. 23:53
`escalarAsistenciasPendientes` sube a nivel 2 y manda el 🚨 al **dueño Luis**
(`asistencia_escalamiento.ts:290`, `telefonoDeRol(tenantId,'flota_admin')`). Luis
aprieta «Ya lo atiendo» → `reconocida_en` queda puesta y **la escalada se apaga
para siempre** (`reclamarEscalacionAsistencia:96`). Luis escribe «contactar 1»;
`puedeAsignar('flota_admin')` lo deja (`:170`) y Likida le contesta a él «te lo
paso con botones». 00:11 el gruero contesta «45 min, $2,400».
`atenderRespuestaProveedor` sella `cotizada` y manda los botones… **al teléfono de
Beto**, que sigue dormido y lleva días sin escribirle al número de Likida: Meta
contesta 131047 (fuera de ventana), que **no** está en
`CODIGOS_META_REINTENTABLES` (`meta/client.ts:186`), así que `sendButtons`
devuelve `null` sin encolar nada y `avisadoJefe` queda `false`.

Lo que pasa entonces, en los tres frentes:
- al **proveedor** se le contesta «Gracias — recibimos su respuesta. El jefe de
  tráfico le confirma directamente en breve» (`:665`) — nadie va a confirmarle;
- a **Luis**, que es quien está atendiendo la emergencia y a quien se le prometió
  «te lo paso», no le llega absolutamente nada;
- al **chofer** tampoco;
- y el **expediente** solo anota `cotizacion_recibida` (`:642`). No existe un
  evento «aviso al jefe fallido» para coordinación —`mesa_control.ts:347-355` no
  lo tiene—, así que el panel enseña «El proveedor respondió con su cotización» y
  nada dice que nadie lo supo. El único rastro es un `logger.info` con
  `avisadoJefe: false` (`:661`): ni `warn`, ni `alertarOperador`.

Consecuencia: un tracto parado de madrugada con la grúa cotizada y esperando un
«sí» que nadie va a dar, sobre una emergencia que la base marca como reconocida y
en gestión. Es el estado que este rubro puntúa más bajo: la base dice una cosa y
el humano cree otra.

Causa raíz probable: el destinatario de la respuesta se resuelve por ROL por
defecto en vez de por `autorizada_por`, que es el dato que la propia fila ya
guarda; y a diferencia de la escalada de asistencia
(`asistencia_escalamiento.ts:311-320`, que dispara `alertarOperador` ante
CUALQUIER aviso que no salió) este camino no tiene fallback declarado.

*(Nota lateral del mismo sitio, no la cuento aparte: el cuerpo lleva `Precio
leído: $2,400` y «¿Confirmas el servicio? Tu confirmación queda firmada» — una
decisión de dinero enrutada por `ORDEN_AVISO`, que arranca en `encargado`, el rol
que `visibilidad.ts:41` excluye del área `dinero`. Es el mismo cruce que
`ORDEN_AVISO_DINERO` se creó para cerrar en el cierre de liquidación,
`contactos.ts:125-137`.)*

---

### [MEDIO] El reloj de SLA de soporte no tiene escritor: `vence_en` es NULL en todo ticket que el producto puede crear, así que `exito.soporte_sla` es una alarma insatisfacible por construcción y dos pantallas prometen un reloj que nunca corre
`src/lib/likida/comercial.ts:652-658` (`abrirTicket`, único INSERT en
`ticket_soporte` de todo `src/`) · `src/lib/likida/agentes/exito.ts:1345,1487-1493`
· `src/app/dashboard/soporte/page.tsx:188,203` · `src/app/admin/soporte/page.tsx:43-48`

`abrirTicket` inserta `tenant_id, abierto_por, asunto, descripcion, categoria,
prioridad` y **nada más**. `sla_horas` y `vence_en` no se escriben, el formulario
de `/dashboard/soporte:371` solo pide categoría y prioridad, y la 0051 no tiene
default ni trigger para ninguna de las dos (`0051:34-39`: `sla_horas int`,
`vence_en timestamptz`, ambas nulas). `grep -rn "sla_horas" src/` no devuelve un
solo escritor de esta tabla — los hits son de `incidencia.sla_horas`, que es otra
tabla.

Con eso, en cadena:
- `semaforoTicket` (`exito.ts:1345`) devuelve `'SIN_SLA'` para el 100 % de los
  tickets, nunca `'VENCIDO'`;
- `vencidos` sale siempre vacío, así que `alertarOperador('exito.soporte_sla', …)`
  (`:1490`) **no puede dispararse jamás**;
- `slaDe` en `/admin/soporte:44` pinta «sin SLA» en todas las filas y
  `/dashboard/soporte:188,203` le promete al cliente «Tickets, prioridad, **reloj
  de SLA** y la conversación con Likida».

Escenario, con valores: el contralor de Innovativos abre a las 09:14 el ticket
«No puedo timbrar la carta porte» con `prioridad: 'urgente'`. `vence_en` queda
NULL. A las 13:00 corre el agente `soporte`: `armarParteSoporte` lo cuenta en
«sin SLA pactado 1» y en «sin una sola respuesta 1», encola el parte a la bandeja
de Aprobaciones… y **no escala nada**, porque `vencidos.length === 0`. La única
vía inmediata hacia Javier —`alertarOperador`— está muerta por construcción, y el
parte compite con la contrapresión de la bandeja (`runner.ts:118-131`, tope 40
pendientes / 7 días). El cliente, mientras tanto, mira en su panel una columna
rotulada «reloj de SLA» que dice «sin SLA» sobre su ticket urgente.

Consecuencia: dos rótulos que no son verdad (el «reloj de SLA» de las dos
pantallas) y la ruta de escalamiento de soporte apagada de fábrica — la misma
trampa que el CLAUDE.md ya nombra con `ticket_mensaje` («una alarma
insatisfacible por construcción») y que la 0268 acaba de cerrar por el otro lado.
Lo grave no es que falte la política de SLA: es que el consumidor la lee como si
existiera y la pantalla la anuncia.

Causa raíz probable: la 0051 razonó `vence_en` como «se escribe al abrir» y el
escritor se construyó después (la puerta de PMF, ago-2026) sin ese campo; nadie
cruzó el escritor con sus dos lectores.

---

### [MEDIO · REINCIDENTE] El sondeo de escritura de la 0172 dejó de dejar fantasmas… bloqueando el arranque en frío que este mismo archivo prohíbe bloquear, y la fila fantasma sigue sin filtrarse ni comprobarse
`src/instrumentation.ts:33-40` · `src/lib/likida/startup.ts:248-290` ·
`src/lib/admin/negocio.ts:384`

`497bc97` extrajo el sondeo a `verificarSondeoEscritura0172()` y lo puso detrás de
un `await` en `register()`. Cierra la mitad del hallazgo (la carrera del `delete`
en vuelo) y abre dos costuras que el hallazgo también preguntaba:

1. **Ahora bloquea el arranque en frío.** Ocho líneas arriba, el mismo archivo
   explica por qué los otros diez sondeos van con `void` («`register()` retenía la
   primera petición de la instancia fría», RES-2), y treinta líneas abajo lo
   repite para el aviso de privacidad («una instancia fría del webhook pagaba ese
   sondeo ANTES del primer 200 a Meta», B11). Este `await` son **tres viajes a la
   base, dos de ellos ESCRITURAS** (`delete` + `insert` + `delete`), cada uno bajo
   `acotada` — hasta 24 s en el peor caso antes de que la función atienda su
   primera petición. En una instancia fría del webhook de WhatsApp, eso es Meta
   reintentando el mismo mensaje.
2. **El fantasma sigue sin cierre.** Los tres `acotada(...delete...)` de
   `startup.ts:252, 279, 285` **descartan su resultado**: un `delete` que se rinde
   en el tope devuelve `{data:null,error}` por valor y aquí nadie lo mira, así que
   la fila `__likida_probe_624__` queda viva sin un solo log. Y
   `negocio.ts:384` —el consumidor que el propio mensaje del commit nombra como
   la razón del hallazgo— **no se tocó**: sigue filtrando solo
   `.not('nombre','ilike','ZZZ %')`, así que ese fantasma se pinta en `/admin`
   como una flota más con plan `demo` y suma en el conteo hasta el siguiente
   arranque en frío. Con 0 clientes reales, sigue siendo la mitad de la lista.

Escenario, con valores: Supabase va lento a las 10:58 del día del demo. La
instancia fría del webhook paga 8 s en el `delete` previo, inserta el probe, y el
`delete` del `finally` se rinde en su tope: `register()` devuelve a los ~18 s, el
`insert` quedó, el `error` del `delete` se tiró. Javier abre `/admin` a las 11:02
y su lista de flotas trae `__likida_probe_624__` junto a la única flota de la
demo.

Causa raíz probable: se movió el sondeo de sitio (que era lo que el hallazgo
enumeraba) en vez de quitarle la ESCRITURA del camino de arranque o filtrar el
nombre donde se lee, que es lo que el hallazgo preguntaba.

---

### [BAJO · REINCIDENTE, 3ª ronda] El resumen de la ráfaga y el cierre por corte siguen saliendo por `sendText`, no por `say`: su costo de WhatsApp no se cuenta
`src/lib/likida/processor.ts:2960` (contra `:2931`, que sí usa `say` treinta
líneas arriba en el mismo bloque) · `src/lib/likida/processor.ts:1219`

Sin tocar desde la 24. `say` (`:2023-2028`) es «enviar + contar el costo» y el
propio comentario de `:2922-2924` explica por qué la foto suelta va por ahí. El
resumen consolidado —el único mensaje de un fajo de 22 fotos— y
`cerrarRafagasPorCorte` —el final NORMAL de un fajo grande, `:1252`— salen por
`sendText` crudo, así que `registrarCostoWhatsApp` no corre. En un negocio que
cobra POR LIQUIDACIÓN, el costo unitario se subestima justo en el camino más
transitado. (`cerrarRafagasPorCorte` está a nivel de módulo y no alcanza el `say`
del turno, pero `registrarCostoWhatsApp` sí es importable ahí.)

---

### [BAJO] La previsualización del copiloto puede prometer una acción que el ejecutor va a rechazar, y el intent se gasta igual
`src/lib/agents/copiloto.ts:81` · `src/lib/agents/copiloto-acciones.ts:156-159` ·
`src/app/api/admin/copiloto/route.ts:196-207`

`proponer_accion` valida el `id` de la acción contra el catálogo (`:74-75`) pero
toma el `objetivo` **del modelo**, crudo: `String(a.objetivo ?? '').slice(0, 80)`.
La tarjeta lo pinta tal cual («Voy a apagar `agente:cobranzas`»,
`copiloto.tsx:272`) y `crearIntent` lo hashea. La validación real —
`INTERRUPTORES.includes(id)`— vive solo en el ejecutor
(`copiloto-acciones.ts:158`), y para entonces `reclamarIntent` **ya gastó el
intent** (`copiloto-intents.ts:255`).

Escenario, con valores: Javier escribe «apaga el de cobranza». El modelo propone
`objetivo: 'cobranzas'` (plural, o sin el prefijo `agente:`). La tarjeta se pinta
con botón, Javier escribe el motivo y aprieta: 400 «"cobranzas" no es un
interruptor del catálogo», y el intent ya no sirve — hay que pedirle la acción al
copiloto otra vez, con otro turno de modelo pagado. En `gateo: 'doble'` cuesta dos
POSTs antes de morir.

Consecuencia: menor (Javier ve el objetivo y el fallo es ruidoso), pero es una
previsualización que afirma ser ejecutable sin haberlo comprobado, en la única
superficie del repo donde un modelo propone escrituras.

---

## Lo que revisé y está bien

- **Los ocho cierres de la tabla de arriba**, cada uno contra el fuente y no
  contra el mensaje del commit. Los dos que más costaban:
  - `talacha_wa.ts` ahora persiste el hecho (`avisada_jefe_en`, 0305) y las
    **tres** frases se bifurcan sobre él, con reintento del aviso en las dos
    ramas que antes mentían (`:264-284`, `:307-329`). El sello va después de que
    Meta acepta (`:196-206`) y su fallo se declara con la razón correcta («mejor
    un jefe avisado dos veces que uno que se queda sin avisar»).
  - `5ff4155` corrigió el CONSUMIDOR y no el dato: `modeloRol` es la columna que
    de verdad dice si hay prompt que documentar, y verifiqué que los nueve
    graduados por la 0303 tienen `modelo_rol = null` en 0230/0234/0235 — la deuda
    documental vuelve a ser satisfacible.
- **El resumen de la ráfaga narra la MISMA aritmética que el motor.**
  `processor.ts:2946-2949` y `engine.ts:636-644` aplican `copiasDeComprobante` y
  `monto > 0` idénticos. La cifra del fajo y la del «listo» ya no pueden divergir.
- **El mutex falla cerrado también en el caso raro que la 25 dejó abierto**:
  `382365e` quitó la caída por gravedad a `return 'obtenido'` cuando la SEGUNDA
  llamada del reintento sin token falla por un error transitorio
  (`conv.ts:866-885`); solo se abre si las dos firmas están ausentes.
- **La barrera de ráfaga sigue fallando cerrado**: `intakePendientes` devuelve
  `null` = «no sé» y `esperarIntake` no abre con `null` (`conv.ts:1030-1054`,
  `:1099`); el sondeo dejó de ser escritura y aplica el TTL de la 0031 del lado
  del cliente; la gracia anti-carrera de 2 s sigue configurable.
- **`entregarCierrePendiente` no repite lo ya sellado** y `mensajeCierreConfirmado`
  (`processor.ts:1109-1117`) no afirma ninguna entrega que Meta no aceptó — las
  cuatro ramas dicen exactamente lo que pasó.
- **`escalarViajesSinAceptar` es el modelo de cómo se hace**: el claim va ANTES de
  cualquier mensaje, un rechazo REINTENTABLE de Meta libera el sello en vez de
  quemarlo (`escalar_viaje.ts:389-400`), cinco rechazos seguidos cortan la corrida
  y gritan, y el corte por reloj ocurre antes del claim.
- **La escalada de asistencia cierra todos sus puntos de muerte hacia un humano**:
  claim atómico por `nivel_escalado` exacto + `reconocida_en is null`
  (`asistencia_escalamiento.ts:87-101`), y CUALQUIER aviso que no sale dispara
  `alertarOperador('asistencia.escalamiento', … 'aviso_escalada_fallido')`
  (`:311-320`). Es justo el patrón que le falta a la coordinación de proveedor.
- **Ninguna ruta del chofer recibe veredictos de contralor**: los llamadores de
  `resumenCuadre` pasan `'operador'` explícito, y `guardiaCifras` (`guardia.ts:84`)
  sustituye SIEMPRE el texto cuando hubo cuadre, reusando el snapshot de la tool
  (AG-3) y fallando cerrado si no puede calcular.
- **El prompt del panel ya no miente sobre el producto** (`prompts.ts:24-25`: «el
  menú completo está activo», y las altas descritas como el panel las hace), con
  `prompts.test.ts` atándolo al repo.
- **El copiloto no ejecuta**: `proponer_accion` solo arma la previsualización, el
  `AdminActionIntent` se valida por actor + `argsHash` + un solo uso, `gateo:
  'doble'` exige AAL2 + motivo + dos POSTs, y el consumo del intent es un UPDATE
  condicional (dos POSTs simultáneos no ejecutan dos veces).
  `correr_runner` describe con todas sus letras que `enviador` manda correo
  autoaprobado — la tarjeta dice la verdad de lo que puede pasar.

## Lo que NO alcancé a revisar

- **La contrapresión de la bandeja bajo carga real** (`agentes/cola.ts`,
  `runner.ts:118-131`): sigue sin medir qué le pasa al tope de 40 pendientes / 7
  días ahora que los 9 graduados de la 0303 encolan. Es la segunda ronda que
  queda pendiente y es el mecanismo del que cuelga el hallazgo del SLA de soporte
  (el parte compite por ese cupo).
- **El ciclo completo de `copiloto-tools.ts`** (las 411 líneas de tools
  cross-tenant) y `copiloto-historial.ts`. Solo recorrí el orquestador, el
  catálogo de acciones, los intents y el route.
- **`relojes_legales.ts` y `reglas/vigilante.ts` por dentro**: los abrí solo lo
  justo para confirmar que consumen `telefonosJefe`. Qué pasa si mueren a media
  corrida no lo recorrí.
- **`agentes/notificaciones.ts` completo** (`repartoDe`, anti-ruido, rachas): solo
  verifiqué `usuariosAvisables`.
- **No corrí más que una prueba** (`activo_filtro_en_base.test.ts`, 7/7 verde).
  Todo lo demás es lectura del fuente, de las migraciones y de los diffs; los
  conteos salen de `grep` y `git show`, no de una corrida.
