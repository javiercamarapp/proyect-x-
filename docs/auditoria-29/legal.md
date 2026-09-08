# Cumplimiento legal — auditoría 29

**Nota: 5/10** (antes 4). Razón del movimiento: **se atacó y subió**. El CRÍTICO
de la 28 —«toda solicitud ARCO del canal de texto nace con `operador_id = NULL` y
las dos RPC ejecutoras rechazan exactamente esa fila»— **está cerrado de verdad**:
abrí `conv.ts`, `processor.ts` y la prueba, y la prueba falla si se revierte el
arreglo (afirma `operadorId: 'op1'` / `'op-baja'` sobre el argumento que antes iba
`null` fijo). Con él cayeron cinco de los nueve reincidentes que la 27 arrastraba
desde julio. Es la primera ronda en la que este rubro cierra más de lo que abre.

No sube más porque la ventana destapó una **transferencia de dato personal sin
cobertura en el aviso** —el supuesto que las anclas de este rubro castigan
directamente—, y porque el ejecutor ARCO sigue sin camino para dos poblaciones:
la cuenta de oficina (mismo defecto del CRÍTICO de la 28, una capa más abajo) y
el derecho de **acceso**, que sigue sin acto asociado.

**Riesgo mayor de hoy:** cuando el jefe de tráfico autoriza «contactar 1» sobre
una emergencia o un varado, Likida le manda por WhatsApp a un tercero comercial
—una grúa, una llantera— la **coordenada exacta que el chofer compartió por el
chat**, ligada al nombre de la flota y a la unidad. El aviso de privacidad que ese
mismo chofer recibió declara ese pin como dato suyo y dice que «se guarda y se le
muestra a **tu empresa**», enumera una lista **cerrada** de transferencias que no
incluye a ese proveedor, y cierra con «si algún día se quisiera transferir tus
datos para algo distinto, **se te pedirá permiso antes**».

---

## Estado de los hallazgos abiertos de la 28

Verificados uno por uno abriendo archivo y prueba, no leyendo el asunto del commit.

| ID | Qué decía | Veredicto hoy | Evidencia que lo ancla |
|---|---|---|---|
| **LEG-C1** (CRÍTICO) | ARCO por texto nace con `operador_id = NULL`; las dos RPC lo rechazan | **CERRADO** para el operador | `processor.ts:1595-1600` resuelve con `buscarOperadorPorTelefono` (`conv.ts:1242-1256`, sin filtro `activo` — cubre al dado de baja) y pasa el id real; `repo.ts:1547-1555` lo inserta. `processor_talacha_pod.test.ts:287,296-310` **falla si se revierte**. Residual acotado → LEG-A2 |
| **LEG-A1** (ALTO) | La oposición nunca se enciende desde texto | **CERRADO** para su escenario | El `&& operadorId` de `processor.ts:352` ahora sí lo recibe, y la rama sin operador grita (`:369`, `logger.warn('arco.oposicion_sin_operador')`). Residual distinto → LEG-A1 (29) |
| **LEG-A2** (ALTO, desde la 27) | `tenant.url_aviso_privacidad` sin un solo escritor → «la empresa aún no lo publica» | **CERRADO** | `repo.ts:1315-1318`: si la columna no pasa `revisarAvisoIntegral`, se deriva `${appUrl()}/aviso/${tenantId}`, que ya renderizaba |
| **LEG-A3** (ALTO, desde la 27) | El simplificado no enumera voz, chat, salud, RFC/licencia, cámara | **CERRADO** | `privacidad.ts:274-277` (cámara por señal `gps`) y `:293` — el renglón fr. II ya nombra las seis categorías |
| **LEG-A4** (ALTO, desde la 26) | `versionAviso` nunca ve el integral | **CERRADO** | `privacidad.ts:401-416` (`versionAvisoVigente` serializa el integral de forma determinista) y `processor.ts:443-445` lo usa. `privacidad.test.ts:309` fija que dos relojes distintos dan la misma firma |
| **LEG-A5** (ALTO, desde la 27) | El parte revela lesionados por la sola presencia del renglón de familia | **CERRADO** | `direccion.ts:688`: `aQuienLlamar` ya no lee `contacto_emergencia`; el parte imprime la misma línea neutra con y sin lesionados |
| **LEG-A6** (ALTO, desde la 27) | La resolución de cancelación enumera mal lo conservado | **MUTADO** | Los dos textos de TS quedaron completos (`repo.ts:1795`, `arco/page.tsx:32,257-263`), pero el texto que la **RPC escribe** en `solicitud_arco.resolucion` sigue con la lista incompleta → LEG-A3 (29) |
| **LEG-M1** (MEDIO) | `acceso` es el tipo por omisión y es el único derecho sin camino | **REINCIDENTE, intacto** | `privacidad.ts:946` (`return 'acceso'`) · `arco/page.tsx:82` (`resolucion.length < 5`) · `:265-289` no ofrece ejecutor para `acceso` · sigue sin existir ninguna función que arme el paquete de datos de un titular (`ls src/app/api/export/`: siete rutas, todas de flota) |
| **LEG-M2** (MEDIO) | El mecanismo ARCO no atiende el pie de foto | **CERRADO** | Las dos compuertas aceptan imagen con caption: `processor.ts:1588` y `:1851` |
| **LEG-M3** (MEDIO, desde la 27) | «Contesta BAJA y se borran tus datos» falso en 4 tablas | **MUTADO** | `respuesta_campana.ts:126-181` completó las seis tablas de la 0258; queda una séptima, exenta por escrito, que sí guarda datos de persona → LEG-M2 (29) |
| **LEG-M4** (MEDIO, desde la 27) | El aviso promete que el ticket de farmacia «no se guarda» | **CERRADO** | `privacidad.ts:766` describe el tratamiento real y coincide con `intake/sanitizar.ts:111-119` (`sanitizarProducto` solo descarta `producto`) |
| **LEG-M5** (MEDIO, desde la 27) | `contacto_emergencia` sin plazo, sin purga, sin ARCO | **REINCIDENTE, intacto** | Ausente de `mantenimiento_de_datos` (`0335:314-343`, 18 purgas, ninguna es ésta) y de `ejecutar_arco_cancelacion` (`0286:39-158`). Ahora al menos se **declara** conservado (`arco/page.tsx:32`), que es media verdad dicha, no un plazo |
| **LEG-B1** (BAJO, desde la 27) | «Los eventos de cámara no tienen fecha de borrado» | **CERRADO** | `privacidad.ts:712-715` dice 180/365 días, que es lo que `purgar_evento_seguridad_flota` ejecuta (`0335:342`) |

**Saldo: 8 cerrados, 2 mutados, 2 reincidentes intactos.**

---

## Hallazgos

### [CRÍTICO] LEG-C1 — La ubicación que el chofer comparte por el chat se transfiere por WhatsApp a un proveedor comercial externo, y el aviso enumera una lista CERRADA de transferencias que no lo incluye

`src/lib/likida/asistencia_coordinacion.ts:118-128` (en concreto `:122`) ·
`:312-319` · `:364` · `src/lib/likida/asistencia_wa.ts:327-341` ·
`src/lib/likida/asistencia_proveedor.ts:45-46` ·
`src/lib/likida/privacidad.ts:689-690` · `:810` · `:884-902` (en concreto `:902`)

**Norma.** `normas/lfpdppp-15-16.yaml` (`verificado_fuente_primaria`, art. 15
texto literal): «II. Los datos personales que serán sometidos a tratamiento […]
III. Las finalidades del tratamiento». Y `normas/lfpdppp-2-XII-XX.yaml`, art. 35
literal: «Cuando el responsable pretenda transferir los datos personales a
terceros nacionales o extranjeros, **distintos de la persona encargada**, deberá
comunicar a éstos el aviso de privacidad y las finalidades a las que la persona
titular sujetó su tratamiento». Una grúa contratada por evento no es persona
encargada de la flota: no trata los datos por cuenta del responsable, presta su
propio servicio.

**Escenario (con valores).** Juan Pérez, operador `op-1` de `t-9` «Transportes del
Bajío SA de CV», se queda **varado** (llanta ponchada, no hay lesionados) en la
57D. Escribe por WhatsApp y Likida le pide su ubicación; manda el pin.

1. `anclarUbicacionIncidencia(t-9, op-1, 20.9123, -100.7440)`
   (`asistencia_wa.ts:327-341`) escribe `incidencia.lat/lng` sobre la fila que
   tiene `operador_id = op-1`. La coordenada queda ligada a la persona.
2. La contralora aprieta el botón del aviso → `iniciarContacto`
   (`:278`). Para `tipo = 'varado'` la cascada ofrece
   `['llantera','mecanico','grua']` (`asistencia_proveedor.ts:45`).
3. `armarMensajeProveedor` (`:312-319`) arma, literal (`:120-125`):

   > «Le escribimos de **Transportes del Bajío SA de CV** 🚛 — necesitamos un
   > servicio de llantas para la unidad **T-402**.
   > Ubicación: `https://maps.google.com/?q=20.9123,-100.7440`
   > ¿Está disponible? […]
   > Contacto directo del jefe de tráfico: **5214771234567**.»

4. `sendText(telefonoEnvio, mensaje)` (`:364`) lo entrega al WhatsApp de
   «Llantas del Centro», un tercero que no firmó nada con la flota.

Contra lo que el aviso le dijo a Juan:

- fr. II (`privacidad.ts:689-690`): «La **ubicación que tú decidas compartir** por
  el chat, que se guarda y **se le muestra a tu empresa**». Destinatario nombrado:
  la empresa.
- fr. III (`:810`): «Usar las posiciones GPS de la unidad para el seguimiento del
  viaje y para medir sus tiempos […] **y mostrárselo a la empresa**».
- Transferencias (`:901`): «Transferencias que sí lo son y no necesitan tu
  consentimiento: **a la autoridad fiscal** cuando la ley lo exige, **y al
  contador de la empresa**». Lista de dos, cerrada.
- Y el cierre (`:902`): «**Si algún día se quisiera transferir tus datos para algo
  distinto, se te pedirá permiso antes.** No hacer nada al leer esto no cuenta
  como haber aceptado.»

`grep -n "grúa\|llantera\|auxilio\|taller" src/lib/likida/privacidad.ts` → **cero
coincidencias** en los dos avisos.

**Intenté refutarlo y no se cae.** (a) La excepción de emergencia no alcanza:
`varado` y `llantera`/`mecanico` no son riesgo vital, son una llamada comercial —
y aunque lo fueran, la excepción dispensa el *consentimiento*, no la *declaración*
del art. 15 fr. II/III ni la comunicación del art. 35. (b) No es «dato del
camión»: el propio aviso clasifica el pin del chat como dato del titular y lo
distingue del GPS de la unidad, y aquí el pin lo mandó él. (c) No hay compuerta de
aviso previo en este camino: la rama ROJA corre *antes* del gate de privacidad a
propósito (`processor.ts:1860-1874`), así que el circuito puede dispararse para un
operador que nunca recibió el aviso.

**Consecuencia.** Titular: el operador, cuya posición precisa y en tiempo real
—junto con flota y unidad, o sea identificable— llega a una empresa que no está en
ninguna cadena declarada, sin límite de uso pactado ni plazo de borrado. La flota
es la responsable sancionable (`normas/lfpdppp-59.yaml`, art. 59: «Multa de 100 a
160,000 veces la UMA»), y la infracción es de las que se prueban solas: el mensaje
transferido está guardado en `coordinacion_proveedor.mensaje_preparado`
(`:337`), con fecha, destinatario y quién autorizó.

**Causa raíz probable.** El circuito de coordinación se diseñó como un problema de
operación (a quién le escribo, quién autoriza, qué le contesto) y nunca cruzó la
frontera de privacidad: `armarMensajeProveedor` es una función pura sin una sola
mención al aviso, mientras el aviso se escribía en otro archivo enumerando
destinatarios uno por uno.

---

### [ALTO] LEG-A1 — La oposición al tratamiento automatizado sigue sin poder encenderse cuando la flota no ha capturado su razón social: el único escritor de la bandera vive dentro del `if (datos)`, y ninguna pantalla la puede encender a mano

`src/lib/likida/processor.ts:342` · `:351-371` (el escritor, `:353-356`) ·
`:374-380` · `supabase/migrations/0178_fiscal_retencion_arco_y_perfiles_erp.sql:152-162` ·
`src/lib/likida/cuadre/desde_db.ts:86-94` · `supabase/migrations/0018_aviso_privacidad.sql:14`

**Norma.** `normas/lfpdppp-26-II.yaml` (`verificado_fuente_primaria`): derecho a
oponerse cuando los datos «sean objeto de un tratamiento automatizado […]
destinados a evaluar, **sin intervención humana**, […] su **rendimiento
profesional, situación económica** […] **fiabilidad o comportamiento**».

**Escenario (con valores).** La flota `t-7` se dio de alta y capturó RFC y plan,
pero no su **razón social** (`tenant.razon_social` es `text` nullable,
`0018:14`; el repo entero razona sobre ese estado — `avisoIntegral` pinta
secciones «pendiente», `startup.ts` sondea la liga). Su operador Luis Ramírez
(`op-4`, teléfono `5215598765432`, dado de alta) escribe:

> «no quiero que un programa decida mis liquidaciones, que las revise una persona»

1. `processor.ts:1595` resuelve `{tenantId: 't-7', operadorId: 'op-4'}` — el
   arreglo de LEG-C1 funciona: el id **sí** llega.
2. `registrarSolicitudArco` inserta `tipo='oposicion'`, `operador_id='op-4'`,
   `vence_en` = hoy + 20 hábiles. La constancia queda.
3. `getDatosResponsable('t-7')` devuelve **`null`** (`repo.ts:1340`:
   `return r.razonSocial ? r : null`).
4. `processor.ts:342` — `if (datos)` es **falso**. El bloque de las líneas
   351-371, que contiene el **único** `update` de `operador.oposicion_automatizada`
   en todo el repo, **queda fuera del flujo**. El `logger.warn` de `:369` que se
   agregó en esta ventana está **dentro** de ese mismo `if`, así que tampoco
   dispara.
5. Luis recibe (`:379`): «Tu solicitud quedó registrada. Déjame checar con la
   empresa los datos del responsable y te confirmo por aquí. 🙏» El único log es
   `privacidad.solicitud_sin_datos_responsable` (`:377`), que habla del
   responsable, no del derecho que no se encendió.
6. `operador.oposicion_automatizada` queda `NULL` → `desde_db.ts:94`
   `oposicionTitular = false` → `engine.ts` no emite `oposicion_titular` → sus
   liquidaciones se siguen cerrando solas.
7. Y **no hay salida manual**: la contralora aprieta «Registrar la oposición» y
   `ejecutar_arco_oposicion` (`0178:155-162`) **no escribe la columna** — solo
   sella `evidencia.oposicion_automatizada_vigente` y deja la solicitud
   `en_proceso`. Verificado con
   `grep -rn "oposicion_automatizada" src/ supabase/`: el único escritor es
   `processor.ts:354`.

**Consecuencia.** Titular: el operador de toda flota a la que le falte un dato de
alta. Su ejercicio queda archivado —evidencia de que se recibió— y el tratamiento
automatizado sigue corriendo sobre él. Es **falla silenciosa** en el sentido más
estricto: la única traza escrita dice otra cosa, y ni el titular ni la flota
tienen forma de saber que la bandera no se encendió.

**Causa raíz probable.** La auditoría 18 (A10) sacó el **registro** de la
solicitud del `if (datos)` porque ese `if` existía solo para decidir el TEXTO de
la respuesta; la **materialización** del derecho se quedó adentro, y el arreglo de
esta ventana añadió el `else` con `warn` un nivel más abajo del que hacía falta.

---

### [ALTO] LEG-A2 — La solicitud ARCO de una cuenta de oficina sigue naciendo con `operador_id = NULL`: la cancelación es imposible de ejecutar y la pantalla imprime el mismo motivo engañoso que la 28 documentó

`src/lib/likida/processor.ts:1595-1600` (en concreto `:1600`) ·
`src/lib/likida/contactos.ts:94-97` ·
`src/lib/likida/repo.ts:1547-1555` ·
`supabase/migrations/0286_arco_por_telefono_normalizado.sql:58-63` ·
`supabase/migrations/0178_fiscal_retencion_arco_y_perfiles_erp.sql:152` ·
`src/app/dashboard/arco/page.tsx:115` · `:237`

**Escenario (con valores).** Ana Rivera, **encargada** de tráfico de `t-9`,
`app_user` con `telefono = '5215544332211'` y su nombre y correo en la fila.
Renuncia y escribe por el mismo WhatsApp por el que recibía los avisos de Likida:

> «ya no trabajo ahí, borren mis datos»

1. `processor.ts:1588` entra (texto + `pideAtencionPrivacidad` → `true`,
   regla `borr…`).
2. `buscarOperadorPorTelefono` → `null` (no es operador).
3. `resolverCuentaOficina('5215544332211')` (`contactos.ts:57-98`) la encuentra y
   devuelve `{ userId: 'u-31', tenantId: 't-9', rol: 'encargado', … }` —
   `contactos.ts:96` construye el `userId` explícitamente.
4. `processor.ts:1597-1600` **usa solo `.tenantId` y tira el `userId`**:
   ```ts
   await atenderPrivacidad(tenantId, porOperador?.operadorId ?? null, msg.from, msg.text);
   ```
   `porOperador` es `null`, así que el segundo argumento vuelve a ser `null`.
5. Se inserta `solicitud_arco` con `tipo='cancelacion'`,
   `titular_ref='5215544332211'`, **`operador_id = NULL`**. Ana recibe «Queda
   registrada tu solicitud para la empresa».
6. `/dashboard/arco` pinta el renglón con **`Titular: —`** (`page.tsx:237`, el
   join `operador:operador_id(nombre)` no resuelve) y ofrece «Ejecutar
   cancelación».
7. `ejecutar_arco_cancelacion` (`0286:58-63`) rebota:
   `if v_operador is null then return … 'solicitud sin operador o de otra flota'`.
8. La pantalla imprime (`page.tsx:115`): «No se ejecutó la cancelación:
   **solicitud sin operador o de otra flota**» — sobre la solicitud de su propia
   encargada, de su propia flota. El motivo sigue mandando a buscar un problema de
   tenancy que no existe.

Y no hay otra vía: `solicitud_arco.operador_id` referencia `operador`, así que
**el esquema no tiene dónde poner a un titular que no es chofer**; los datos de
Ana viven en `app_user` y `wa_conversacion`, y la RPC solo sabe anonimizar
operadores. `ejecutar_arco_oposicion` (`0178:152`) rebota por la misma condición.

**Consecuencia.** Titular: todo `flota_admin`, `contador`, `encargado` o
`vendedor` que ejerza cancelación por el canal que el producto le abrió. Su nombre,
teléfono, correo y la conversación completa sobreviven al ejercicio del derecho, y
lo único que la flota puede hacer es escribir prosa y marcarla resuelta — el
mismo estado de cosas que las auditorías 19 y 20 dijeron haber cerrado.

**Causa raíz probable.** El arreglo de LEG-C1 resolvió la identidad **solo por la
tabla `operador`** y dejó el fallback de oficina donde estaba: `resolverCuentaOficina`
tiene el `userId` a un campo de distancia y se sigue tirando, igual que
`buscarTenantPorTelefono` tiraba el `operadorId` antes del arreglo. El defecto no
se movió de forma, solo de población.

---

### [ALTO] LEG-A3 — El texto de resolución que la RPC escribe y archiva sigue enumerando cuatro categorías conservadas; el WhatsApp que el titular recibe enumera siete. Los dos documentos de la misma cancelación se contradicen

`supabase/migrations/0340_arco_alcance_cancelacion.sql:8` · `:25-27` ·
`supabase/migrations/0286_arco_por_telefono_normalizado.sql:151-153` ·
`src/lib/likida/repo.ts:1793-1796` · `src/app/dashboard/arco/page.tsx:248`

**Escenario (con valores).** Juan Pérez (`op-1`, `t-9`) pidió cancelación; la
contralora aprieta «Ejecutar cancelación» el 10-sep-2026.

1. La RPC corre y, en `0286:151-153`, escribe:
   ```sql
   update solicitud_arco
      set estado='resuelta', resuelta_en=now(), ejecutada_en=now(), evidencia=ev,
          resolucion = coalesce(resolucion, '<texto por defecto>')
   ```
   El `<texto por defecto>` vigente es el que instaló la 0340 (`:8`):
   > «Se sustituyeron el nombre y el teléfono del registro operativo y se
   > eliminaron sus conversaciones. Se conservan el identificador del operador,
   > el correo de la cuenta, la referencia del titular en la solicitud **y la
   > documentación fiscal**. Requieren revisión de privacidad […]»

   Cuatro categorías.
2. `repo.ts:1795` le manda a Juan por WhatsApp una lista de **siete**: las cuatro
   más «los eventos de cámara y telemetría ligados a tu persona (180 días, o 365
   si fueron graves), tu contacto de emergencia y tu registro de jornada laboral».
3. `solicitud_arco.resolucion` queda con la lista de cuatro. Es lo que
   `page.tsx:248` pinta para toda solicitud resuelta, lo que la flota exhibiría
   ante la Secretaría como la respuesta que dio bajo el art. 31, y lo que
   sobrevive (el WhatsApp no se archiva con la solicitud). El `comment on
   function` de `0340:25-27` repite la misma lista corta.

Que era conocido no lo hace menos falso: el propio commit `910b755` lo dejó
escrito («El `comment on function` de la RPC (0340) repite la lista incompleta;
corregir ese texto es una migración y queda fuera de este lote»). Lo que ese
párrafo no dice es que no es solo el comentario: es el **cuerpo** de la función y
el valor que se persiste.

**Consecuencia.** El expediente archivado de la cancelación —el único documento
que le queda a la flota— declara que se conservan cuatro categorías cuando se
conservan siete, y omite justo las tres que el propio equipo identificó como las
que «la ejecución automática no alcanza». Ante la autoridad no es una omisión: es
una constancia firmada, con fecha y acuse, que subdeclara qué datos personales
sobrevivieron. Y si el titular compara su WhatsApp con lo que la flota le muestra,
son dos respuestas distintas al mismo ejercicio.

**Causa raíz probable.** El alcance de la cancelación está escrito **tres veces**
(RPC, `repo.ts`, `page.tsx`) y solo dos viven en TypeScript, que es donde el
arreglo de la 28 llegó. La tercera necesita migración y la barrera de migraciones
la dejó fuera; el resultado es que la fuente de verdad de la base quedó atrás de
sus dos copias.

---

### [MEDIO] LEG-M1 — El aviso integral público sigue anunciando «Vigente desde el 1 de septiembre de 2026» sobre un texto que cambió el 7 de septiembre

`src/app/aviso/[tenant]/page.tsx:38` · `:104-110` ·
`src/lib/likida/privacidad.ts:712-715` · `:766`

**Norma.** `normas/lfpdppp-15-16.yaml`, art. 15 fr. VI (procedimiento y medio para
comunicar cambios al aviso), y el propio integral (`privacidad.ts:923-925`): «En
esta página siempre está la versión vigente».

**Escenario (con valores).** Juan abre la liga desde WhatsApp el 8-sep-2026. El
encabezado dice, literal:

> «Vigente desde el **1 de septiembre de 2026** · Ley Federal de Protección de
> Datos Personales en Posesión de los Particulares»

Y tres secciones más abajo lee dos párrafos que **no existían el 1 de
septiembre**: la retención de los eventos de cámara «180 días; si el evento fue
grave […] 365 días» (`privacidad.ts:712-715`) y el párrafo de salud reescrito
—«el nombre del comercio, su RFC, el monto, la fecha y la imagen sí se guardan»—
(`:766`). Los dos entraron con `910b755`, fechado **2026-09-07**.
`git log -S"2026-09-01" -- "src/app/aviso/[tenant]/page.tsx"` devuelve un solo
commit, `c7bbb83`, anterior a los cambios.

La constante lleva el comentario «Actualizar junto con el texto» (`:35-37`) y el
único candado que existe (`src/app/legal/marco_leg12_aud24.test.ts:25-34`) exige
que la fecha sea **constante**, no que sea **cierta** — pasa en verde sobre
cualquier valor.

**Consecuencia.** Titular: cualquier operador que consulte el integral. La fecha
es lo único que le dice qué versión estaba en vigor cuando se trataron sus datos,
y es exactamente lo que un procedimiento ante la Secretaría reconstruye. Duele
más aquí porque la ronda automatizó la **firma** que decide el reenvío
(`versionAvisoVigente`, LEG-A4) y dejó manual el rótulo que la persona lee al
lado: la firma cambió el mismo día y la fecha no.

**Causa raíz probable.** Dos relojes para el mismo hecho —uno derivado del texto,
otro tecleado a mano— sin nada que los case; el PR que cambió el texto no tenía
motivo para tocar un archivo distinto.

---

### [MEDIO] LEG-M2 — «Contesta BAJA y se borran tus datos de persona» sigue siendo falso para quien agendó una demo: el payload íntegro de Cal.com queda hasta 365 días, y la baja no lo toca por diseño declarado

`src/lib/likida/privacidad.ts:1088` ·
`src/lib/correo/respuesta_campana.ts:109-112` · `:126-181` ·
`src/lib/admin/calcom_webhook.ts:185-197` (en concreto `:189`) ·
`supabase/migrations/0245_purga_prospecto_entera_y_ledger_comercial.sql:139-148`

**Escenario (con valores).** María Fernández, jefa de tráfico de «Transportes X»,
agenda una demo en Cal.com el 1-mar-2026 con `maria@transportesx.mx`, su teléfono
y una respuesta escrita en el formulario de la reserva.

1. `BOOKING_CREATED` llega al webhook. `calcom_webhook.ts:189` manda
   `p_payload: evt.payload ?? {}` — el sobre **completo** de Cal.com — a
   `aplicar_evento_calcom_tx`, que lo guarda en `comercial_evento.payload`
   (`0323:453-459`). Adentro viajan `attendees[].name`, `.email`, `.phone`,
   `.timeZone` y las respuestas libres.
2. El 10-mar María contesta **BAJA**. `borrarDatosPersonaPorBaja`
   (`respuesta_campana.ts:126-181`) toca seis tablas y le confirma por escrito.
3. `comercial_evento` **no está entre las seis**, y la exención está escrita:
   `:109-112` — «No toca […] `comercial_evento` (la anonimiza
   `purgar_comercial_evento` **por edad, no por baja**)».
4. `purgar_comercial_evento` (`0245:139-142`) vacía `payload` cuando
   `ocurrido_en < ahora - 365 días`. El nombre, correo, teléfono y texto libre de
   María siguen en la base hasta el **1-mar-2027**, casi un año después de haber
   pedido su baja.

Contra lo que el aviso de prospectos le prometió (`privacidad.ts:1088`): «Contesta
**BAJA** […] Se deja de contactarte y **se borran tus datos de persona**; se te
confirma por escrito». Y el párrafo siguiente (`:1089`) refuerza la lectura
equivocada: «**Si no contestas nunca, también se borran solos**: a los N meses…»,
que dibuja la baja como el camino rápido. Para esta tabla es al revés: la baja no
hace nada y solo la edad borra.

**Consecuencia.** Titular: cualquier prospecto que haya agendado por Cal.com y
luego pedido baja — la población con más contacto y más expectativa. Recibe una
confirmación escrita de un borrado que no ocurrió. Para Likida (aquí es
**responsable**, no encargada) es la peor forma del hallazgo: acuse documentado de
haber afirmado un borrado y registro en base de que no se hizo.

**Causa raíz probable.** La exención de `comercial_evento` se razonó contra la
purga **por inactividad** de la 0258 —donde «lo anonimiza la edad» es una respuesta
válida— y se copió tal cual a la baja **a petición del titular**, donde el plazo
del titular no es el plazo del ledger.

---

### [BAJO] LEG-B1 — Los comentarios de `privacidad.ts` y `meta/client.ts` fundamentan datos sensibles, voz y confidencialidad en la numeración de la ley ABROGADA

`src/lib/likida/privacidad.ts:295` · `:322` · `:734` · `:746` ·
`src/lib/meta/client.ts:744`

**Norma.** `docs/conocimiento/11-datos-personales.md:37-52`, tabla de
equivalencias verificada: las definiciones pasaron del **art. 3** (2010) al
**art. 2** (2025); confidencialidad del **art. 21** al **art. 20**.

**Escenario (con valores).** Un abogado externo, o el auditor de la siguiente
ronda, abre el archivo que es la fuente de verdad del aviso y lee:
`:295` «Dato SENSIBLE (LFPDPPP **art. 3 fr. VI**)»; `:322` «(LFPDPPP **art. 3 fr.
IX**: persona identificada o identificable)»; `:734` «La voz es dato personal por
sí misma (**art. 3 fr. V**)»; `:746` «La salud es dato sensible (**art. 3 fr.
VI**)»; y en `meta/client.ts:744` «(LFPDPPP **art. 21**: el responsable debe
guardar confidencialidad)». Las cinco citan artículos de una ley que dejó de
existir el 21-mar-2025. El equivalente vigente es `art. 2` fr. VI/IX/V y `art. 20`
— y el archivo hermano lo tiene bien: `intake/sanitizar.ts:35` dice «art. 2 fr. VI».

**Consecuencia.** Nadie lo lee desde afuera: los `fundamento` que sí ve el titular
están todos en la numeración 2025 (`privacidad.ts:643,661,778,834,843,851,861,870,907,921`).
El daño es de mantenimiento y de due diligence: la próxima decisión que se apoye en
esos comentarios razonará con la ley abrogada, que es exactamente lo que
`11-datos-personales.md:35` advierte que «te descalifica frente a cualquier
contralor que sepa leer».

**Causa raíz probable.** Los comentarios se escribieron antes de que el corpus de
`normas/` se rehiciera sobre el texto vigente (jul-2026) y nadie barrió los
`fundamento` de comentario cuando se barrieron los de pantalla.

---

## Lo que revisé y está bien

- **El camino ARCO por texto, de punta a punta, corre.** `processor.ts:1588-1604`
  resuelve al operador con `buscarOperadorPorTelefono` (`conv.ts:1242-1256`), que
  **no filtra `activo`** —la población que más ejerce cancelación es la que ya no
  trabaja ahí— y devuelve `null` ante dos filas en vez de elegir al azar
  (`:1252`). El id real llega a `repo.ts:1549` y `0286:58` ya no rebota. La prueba
  que lo ancla (`processor_talacha_pod.test.ts:296-310`) afirma el valor del
  argumento, no la llamada: revertir el arreglo la pone en rojo.
- **La firma del aviso ve el integral y no ve el reloj.**
  `privacidad.ts:401-416` serializa las secciones (título, fundamento, `pendiente`,
  párrafos) sin fechas ni contadores, y `privacidad.test.ts:309` fija que dos
  relojes distintos dan la misma firma. `getDatosResponsable` (`repo.ts:1319-1326`)
  sí trae `contactoPrivacidad` y la señal `gps`, así que el integral que se firma
  es el mismo que la página pública renderiza.
- **Revocar una credencial de portal corta el acceso de verdad.**
  `conectores/credenciales.ts:460-488` no solo apaga `activo`: pisa
  `valores_cifrados` con `revocada:<fecha>` (que `descifrar` nunca abrirá) y
  además invalida la fila `#sesion` (`facturacion/sesion_portal.ts:228-253`), que
  es la cookie viva con la que el robot seguiría entrando. Las dos destruyen el
  secreto, no lo archivan.
- **La e.firma no se custodia.** `sat_descarga/escritura.ts:70-119`: se le
  pregunta al PAC si la credencial sigue en **su** bóveda y se guarda solo la
  referencia y la vigencia; `index.ts:100` deja escrito por qué el camino directo
  al SAT está declarado y no construido.
- **Toda salida a modelo sale por una sola puerta, con retención denegada.**
  `grep -rn "api.openai.com\|api.anthropic\|generativelanguage\|deepgram" src/`
  → cero; el único `baseURL` es `openrouter.ts:36`, y los tres cuerpos de petición
  (`:382`, `:709`, `:1172`) extienden `PROVIDER_OPTS` con
  `provider: { data_collection: 'deny' }` (`:281-287`). La nota de voz
  (`voz_transcrita.ts:27`) y el OCR pasan por ahí, y el aviso describe eso mismo
  sin prometer un contrato de retención cero que nadie firmó (`privacidad.ts:871-876`).
- **La compuerta «no se trata antes de avisar» falla cerrada.**
  `privacidad.ts:1149-1172` y `:1198-1267`: sin poder leer, la respuesta es «no»;
  una unidad con dos viajes vivos de operadores distintos se bloquea por ambigüedad
  (`:1235-1237`); y un llamador que trate un dato que identifica al conductor debe
  pedir `sinViajeVivo: 'bloquear'` (`:1187-1193`). `processor.ts:1802-1820` mete la
  nota de voz detrás de esa compuerta **antes** de transcribir.
- **El aviso ya no promete un filtro de salud que no existe.**
  `privacidad.ts:766` describe exactamente lo que `intake/sanitizar.ts:111-119`
  hace —descartar la línea del producto, conservar comercio, RFC, monto, fecha e
  imagen— y añade la recomendación honesta que se sigue de eso.
- **El payload de Cal.com se anonimiza y el comentario dice qué hay adentro.**
  `0245:139-148`: `payload = '{}'` y `error = null` a los 365 días, con mínimo de
  30 días protegido por excepción; el `comment on function` nombra «nombre, correo,
  respuestas» en vez de esconderlo detrás de «datos del evento».
- **La numeración de la ley 2025 está bien en todo lo que el titular lee.** Los
  diecisiete `fundamento` de `privacidad.ts` y los de `/privacidad` y `/terminos`
  usan art. 15/16/26/29/31/35 y art. 2 fr. XII/XX — la numeración vigente. Y
  `docs/conocimiento/11-datos-personales.md` es correcto y explícito sobre la
  abrogación, el INAI extinto y la Secretaría Anticorrupción y Buen Gobierno.
- **La retención está cableada y es amplia.** `0335:314-343`: dieciocho purgas
  dentro de `mantenimiento_de_datos`, cada una en su bloque, acumulando `fallos` y
  marcando `parcial` — nada se da por hecho en silencio.
- **El gate de rol de `/dashboard/arco` y su fail-cerrado** siguen bien
  (`page.tsx:45-47` comprobado dentro de cada action en `:72`, `:103`, `:136`;
  KPI en `null` y no en `0` con `errorCarga`, `:198-200`).

## Lo que NO alcancé a revisar

- **La retención del lado del proveedor** (Meta, OpenRouter y su cadena,
  Facturapi/PAC, Stripe, Cal.com). Sigue sin ser verificable desde el repo: lo que
  se puede leer es lo que se PIDE en cada llamada, no lo que el proveedor cumple.
  Es el mismo pendiente de la 26, 27 y 28.
- **El circuito de soporte (`ticket_mensaje`, 0268)**: tiene escritor desde
  agosto y no lo recorrí — quién ve el texto libre de un ticket, si se purga, si
  la cancelación ARCO lo alcanza.
- **El ARCO de prospectos**, que el aviso encamina a un correo
  (`privacidad.ts:1097`) sin ningún código detrás. No verifiqué si ese buzón
  existe ni si hay procedimiento.
- **`portal_credencial` e `invitacion`**, que siguen sin escritor: no comprobé si
  quedaron como esquema muerto o como deuda pendiente de cablear.
- **La retención de los logs de plataforma** (`processor.ts:1834-1837` escribe la
  transcripción íntegra de la nota de voz en el log). Sin panel de Vercel no se
  mide; cuarto pendiente consecutivo.
- **Los `resolucion` ya escritos en producción** por el texto viejo (LEG-A3): la
  base está en cero, así que no hay filas que contar.
- **La base entera está en cero** (0 viajes, 0 clientes): ningún escenario se
  confirmó contra filas reales. Todos están construidos leyendo el código, las
  migraciones y las fichas de `normas/`, y cada línea citada la abrí y la leí.
