# Cumplimiento legal — auditoría 30

**Nota: 4/10** (antes 5). Razón del movimiento: **mirada más profunda — la nota
anterior estaba inflada**. La 29 midió el rubro por el eje «¿está declarado?» y
puntuó el cierre de dos críticos de declaración. Esta ronda midió el otro eje
—«¿qué sobrevive materialmente a un derecho ya ejecutado, y a un plazo ya
prometido?»— y ahí el repo no tiene red: hay un almacén de geolocalización del
operador que **ninguna de las diecinueve purgas toca y que `ejecutar_arco_cancelacion`
tampoco toca**, y que ningún auditor anterior había abierto. Además, el propio
commit que cerró LEG-M5 dejó en la pantalla de ARCO una **cuarta** copia del
alcance que dice exactamente lo contrario de lo que la RPC hace, con una prueba
verde encima. Se atacó de verdad (0356 borra el contacto de emergencia y
`verificaciones.sql` lo comprueba sembrando al familiar), pero seis reincidentes
siguen intactos y el crítico nuevo es peor en especie que el que sustituye: no
es un dato que sale sin estar dicho, es un dato que **se queda después de que el
titular ejerció su cancelación y recibió constancia de que se fue**.

Riesgo mayor hoy: la coordenada exacta que el chofer compartió por el chat vive,
en texto plano y para siempre, dentro de un mensaje archivado que nadie audita,
nadie purga y ninguna cancelación ARCO alcanza.

## Hallazgos

### [CRÍTICO] LEG-C1 — La coordenada exacta del operador queda guardada en texto dentro de `coordinacion_proveedor.mensaje_preparado`: ni la purga de 90 días que el aviso promete la toca, ni la cancelación ARCO

`src/lib/likida/asistencia_coordinacion.ts:122` · `:337` ·
`supabase/migrations/0213_coordinacion_proveedor.sql:68` ·
`supabase/migrations/0289_purga_geolocalizacion_incidencia.sql:54-69` ·
`supabase/migrations/0335_db_retencion_r3_forward.sql:314-343` ·
`supabase/migrations/0356_arco_borra_contacto_emergencia.sql:61-101` ·
`src/lib/likida/privacidad.ts:258` · `:689`

**Norma.** `normas/lfpdppp-15-16.yaml` (art. 15 fr. V, plazo de conservación) y
art. 11: el plazo que el aviso afirma tiene que ejecutarse. Art. 25 y 28 fr. III:
la cancelación obliga a suprimir el dato del titular salvo fundamento que lo
retenga.

**Escenario (con valores).** Juan Pérez, operador `op-1` de `t-9`, se queda
varado en la 57D el 10-mar-2026 y manda su pin: `20.9123, -100.7440`.

1. `anclarUbicacionIncidencia` escribe `incidencia.lat/lng` (`asistencia_wa.ts:328-341`).
2. La contralora aprieta «Contactar 1». `armarMensajeProveedor` (`:118-127`)
   arma, literal en `:122`:
   `Ubicación: https://maps.google.com/?q=20.9123,-100.744`
3. `asistencia_coordinacion.ts:337` **persiste ese texto completo** en
   `coordinacion_proveedor.mensaje_preparado` (`0213:68`, `text not null`).
4. El expediente se resuelve. Pasan 90 días. Corre `mantenimiento_de_datos`:
   `purgar_geolocalizacion_incidencia` (`0289:64-69`) pone `incidencia.lat = null,
   lng = null` y (`:54-61`) quita las llaves `lat`/`lng` de
   `incidencia_evento.detalle`. **`coordinacion_proveedor` no aparece en esa
   función, ni en ninguna otra de las diecinueve purgas de `0335:314-343`.**
   Verificado: `grep -rn "coordinacion_proveedor" supabase/migrations/*.sql`
   devuelve coincidencias **solo en 0213** (su creación).
5. El 1-sep-2026 Juan pide cancelación y la contralora la ejecuta.
   `ejecutar_arco_cancelacion` (`0356:61-101`) toca `wa_conversacion`,
   `envio_mensaje`, `contacto_emergencia`, `incidencia`, `incidencia_evento`,
   `operador`, `app_user`. **`coordinacion_proveedor` no está.** Juan recibe por
   WhatsApp: «se eliminaron tus conversaciones…».
6. Hoy, en la base, sigue existiendo la fila con
   `mensaje_preparado = 'Le escribimos de Transportes del Bajío SA de CV 🚛 …
   Ubicación: https://maps.google.com/?q=20.9123,-100.744 …'`, y se puede
   re-ligar al titular: `coordinacion_proveedor.incidencia_id → incidencia.viaje_id
   → viaje.operador_id`, columna que la cancelación **conserva a propósito** («el
   identificador del operador», `0356:121`).

Contra lo que los dos avisos le dijeron a Juan: el simplificado —el que recibe
por WhatsApp— dice «si compartes tu ubicación por el chat, también se guarda y la
ve tu jefe. **Se borra a los 90 días**» (`privacidad.ts:258`, y `:260`/`:261` en
las otras dos ramas de la señal); el integral repite «Las ubicaciones que
compartas se conservan **90 días** y después se borran solas» (`:689`).

**Intenté refutarlo y no se cae.** (a) ¿Se borra por cascada? No:
`coordinacion_incidencia_tenant_fkey` es `on delete cascade` sobre `incidencia`,
pero la cancelación ARCO **no borra la incidencia**, la anonimiza (`0356:85-89`).
La única cascada real es el borrado del tenant entero. (b) ¿La marca
`descartada`/`cerrarCoordinacionesDeIncidencia` limpia algo? No: cambia `estado`,
la columna `mensaje_preparado` no se toca en ningún `update` del archivo.
(c) ¿Es dato del camión y no de la persona? El propio aviso clasifica el pin del
chat como dato del titular y lo distingue del GPS de la unidad, y aquí lo mandó
él. (d) ¿Está cubierto por el «se conservan… la documentación fiscal»? No es un
comprobante: es el mensaje de una gestión comercial.

**Consecuencia.** El titular ejerció cancelación, tiene un acuse por WhatsApp y
una constancia en `solicitud_arco.resolucion` diciendo qué se conservó, y su
geolocalización precisa —la que el mismo documento prometía borrar a los 90
días— sigue ahí sin plazo. Ante la Secretaría es el peor de los tres supuestos:
promesa escrita, derecho ejercido, dato vivo. Y la infracción se prueba con una
sola consulta.

**Causa raíz probable.** La 0289 se escribió enumerando «los tres almacenes de
geolocalización» (`posicion`, `incidencia.lat/lng`, `incidencia_evento.detalle`)
y no contó el cuarto, porque ahí la coordenada no es una columna `lat/lng` sino
una subcadena dentro de un `text` — invisible a cualquier barrido por nombre de
columna.

---

### [ALTO] LEG-A1 — LEG-C1 de la 29 no cerró, MUTÓ: el párrafo nuevo declara la transferencia solo de «la ubicación que compartiste por el chat», y un siniestro abierto por la cámara le manda a la grúa la coordenada de la TELEMETRÍA, que el operador nunca compartió

`src/lib/likida/privacidad.ts:912` · `:687-690` · `:712` · `:715` ·
`src/lib/likida/asistencia_camara.ts:200-210` (en concreto `:209`) ·
`src/lib/likida/asistencia_proveedor.ts:45-47` ·
`src/lib/likida/asistencia_coordinacion.ts:316-317`

**¿La prueba se pone roja si reviertes el arreglo?** Sí. Corrí el archivo:
`privacidad_asistencia_proveedor.test.ts:59` exige
`/grúa|grua|llantera|auxilio en carretera/` sobre la sección de transferencias, y
sin el párrafo esa sección no contiene ninguna de las cuatro. El arreglo está
anclado de verdad. **¿La lista sigue siendo cerrada, solo que más larga?** Sí:
`:913` sigue siendo una enumeración («a la autoridad fiscal…, y al contador…. La
del proveedor de auxilio del párrafo anterior…») y `:914` sigue rematando con
«**Si algún día se quisiera transferir tus datos para algo distinto, se te pedirá
permiso antes.**». Pasó de dos destinos a tres. Y lo que la hace todavía
insuficiente no es el destinatario, es **el dato**:

**Escenario (con valores).** Juan Pérez (`op-1`, `t-9`) va en la unidad `T-402`
por la 57D con el viaje `v-77` abierto. La flota tiene Samsara conectado. A las
14:02 la telemetría reporta `colisión`, `max_g = 4.8`, `lat = 20.9123`,
`lng = -100.7440`. Juan no escribe nada: está aturdido.

1. `asistencia_camara.ts:200-210` abre la incidencia con `tipo: 'siniestro'`,
   `operadorId: 'op-1'`, `viajeId: 'v-77'` y **`lat: e.lat, lng: e.lng`** (`:209`)
   — la coordenada de la cámara, no un pin del chat.
2. El jefe aprieta el botón. Para `siniestro` la cascada ofrece
   `['grua', 'medico']` (`asistencia_proveedor.ts:46`).
3. `iniciarContacto` lee `inc.lat/inc.lng` (`asistencia_coordinacion.ts:316-317`)
   y `sendText` entrega al WhatsApp de «Grúas del Bajío»:
   `Ubicación: https://maps.google.com/?q=20.9123,-100.744`.

Contra lo que el aviso le dijo a Juan:

- El párrafo nuevo (`:912`) acota el dato con un aposición restrictiva: «tu
  **ubicación** —**la que compartiste por el chat**— se le manda al proveedor de
  auxilio». Esta no la compartió: la tomó el dispositivo de su empresa.
- El aviso **distingue expresamente** las dos cosas como categorías separadas:
  fr. II enumera por un lado «la **posición GPS de la unidad**» y por otro «la
  **ubicación que tú decidas compartir** por el chat» (`:687`, `:690`). No es una
  lectura forzada mía: es la taxonomía del propio documento.
- Y la finalidad declarada del evento de cámara nombra un destinatario cerrado:
  «Se usan para atender un accidente o incidente grave de tu unidad —abrir el
  expediente de asistencia y **avisar a tu empresa**» (`:712`, `:715`).

**Intenté refutarlo y no se cae.** El caso de la telemetría es justo el que más
seguro dispara el circuito (un evento `grave` abre incidencia **solo**), y es el
único en el que el titular puede estar inconsciente, es decir, sin ninguna
posibilidad de haber «compartido» nada. La excepción de emergencia dispensa el
consentimiento, no la declaración del art. 15 fr. II/III.

**Consecuencia.** La transferencia mejor documentada del repo sigue sin cubrir su
población más expuesta. Si el titular compara el aviso con el mensaje que la grúa
recibió, el aviso dice que el dato salió porque él lo compartió; el expediente
dice que salió de la cámara de su patrón.

**Causa raíz probable.** El arreglo se escribió contra el escenario literal que
la 29 redactó (`varado` + pin del chat) en vez de contra el conjunto de entradas
de `incidencia.lat/lng`, que son dos.

---

### [ALTO] LEG-A2 — La pantalla de ARCO le dice a la contralora, ANTES de apretar el botón, que el contacto de emergencia se CONSERVA, y después del mismo clic le dice que se borró. La prueba que dice cubrir los tres textos pasa en verde

`src/app/dashboard/arco/page.tsx:259-264` (en concreto `:262`) · `:33` · `:118-119` ·
`src/app/dashboard/arco/cancelacion_alcance.test.tsx:32-47` (en concreto `:45`)

**Escenario (con valores).** Solicitud `s-1`, cancelación de Juan Pérez. La
contralora abre `/dashboard/arco` y lee, junto al botón «Ejecutar cancelación»
(`page.tsx:259-264`):

> «Sustituye nombre y teléfono del registro operativo y elimina conversaciones.
> **Se conservan** el identificador del operador, el correo de la cuenta, la
> referencia del titular en la solicitud, la documentación fiscal, los eventos de
> cámara y telemetría ligados a su persona (180 días, o 365 si fueron graves),
> **su contacto de emergencia** y su registro de jornada laboral…»

Aprieta el botón. La misma pantalla le contesta con `ALCANCE_CANCELACION`
(`:33`, usado en `:118-119`):

> «Se sustituyeron el nombre y el teléfono …, se eliminaron sus conversaciones **y
> el contacto de emergencia registrado sobre su persona**. Se conservan …»

Dos frases, un clic, sentido opuesto. La que manda es la segunda: `0356:76-78`
hace `delete from contacto_emergencia`. El commit `ad2fb9a` declaró haber
corregido «las **tres** copias» del texto; eran cuatro, y la que quedó sin tocar
es la única que el humano lee **antes** de ejecutar un acto irreversible.

Y el arnés no puede atraparlo: `cancelacion_alcance.test.tsx:45` es
`expect(texto).toMatch(/contacto de emergencia/i)` — una aserción de **substring**
que no distingue «se eliminó el contacto de emergencia» de «se conserva su
contacto de emergencia». Corrido hoy: `1 passed (1) · Tests 5 passed (5)`. La
propia función se anuncia como aplicada «en los TRES textos … incluida la
advertencia previa al botón» (`:39-44`), así que el texto falso **sí** está bajo
prueba: la prueba lo bendice.

**Consecuencia.** El contralor —el comprador— toma una decisión legal irreversible
sobre datos de un tercero (el familiar del chofer) leyendo lo contrario de lo que
va a pasar. En una sala, es la clase de contradicción que se ve en diez segundos
porque las dos frases aparecen en la misma pantalla con un clic de por medio.

**Causa raíz probable.** El alcance de la cancelación vive escrito **cuatro**
veces (RPC, `repo.ts`, `ALCANCE_CANCELACION`, el `<span>` inline) y la única
guardia que las cruza compara por presencia de palabra, no por polaridad.

---

### [ALTO] LEG-A3 — El texto de resolución que la RPC persiste y archiva sigue enumerando cuatro categorías conservadas; el WhatsApp y la pantalla enumeran siete (REINCIDENTE de LEG-A3/29)

`supabase/migrations/0356_arco_borra_contacto_emergencia.sql:121` · `:129` ·
`src/lib/likida/repo.ts:1828` · `src/app/dashboard/arco/page.tsx:33` ·
`supabase/tests/0340_arco_alcance.sql:33`

La 0356 movió **una** categoría de sitio (el contacto de emergencia pasó de
«conservado y no dicho» a «borrado y dicho») y dejó la divergencia de las otras
dos. Hoy:

- `solicitud_arco.resolucion` (`0356:121`): «Se conservan el identificador del
  operador, el correo de la cuenta, la referencia del titular en la solicitud y la
  documentación fiscal.» → **cuatro**.
- El WhatsApp al titular (`repo.ts:1828`): las cuatro **más** «los eventos de
  cámara, telemetría (se borran solos a los 180 días, o 365 si fueron graves) y
  jornada laboral ligados a tu persona» → **siete**.

`solicitud_arco.resolucion` es lo que `page.tsx:249` pinta para toda solicitud
resuelta y lo que la flota exhibiría bajo el art. 31; el WhatsApp no se archiva.
La constancia que sobrevive subdeclara dos categorías que la propia función
reconoce no alcanzar, incluida la **jornada laboral** (texto libre del chofer en
`jornada_asiento.detalle`, `0241:194`) y los **eventos de cámara** con su liga al
video (`evento_seguridad_flota.url_evento`, `0203:32`).

**Consecuencia.** El expediente archivado de la cancelación dice cuatro donde hay
seis. Y si el titular compara su WhatsApp con lo que la flota le enseña, son dos
respuestas distintas al mismo ejercicio del mismo derecho.

**Causa raíz probable.** La migración tenía la oportunidad de alinear el texto —lo
tocó para agregar el contacto de emergencia— y solo copió el cambio que el
hallazgo de la 28 pedía, sin releer la lista completa que `repo.ts` ya tenía al
lado.

---

### [ALTO] LEG-A4 — La solicitud ARCO de una cuenta de oficina sigue naciendo con `operador_id = NULL` y la cancelación sigue siendo inejecutable (REINCIDENTE de LEG-A2/29, intacto)

`src/lib/likida/processor.ts:1595-1600` (en concreto `:1600`) ·
`src/lib/likida/contactos.ts:96` ·
`supabase/migrations/0356_arco_borra_contacto_emergencia.sql:39-41` ·
`src/app/dashboard/arco/page.tsx:115` · `:237`

Reverificado línea por línea: `processor.ts:1600` sigue siendo

```ts
await atenderPrivacidad(tenantId, porOperador?.operadorId ?? null, msg.from, msg.text);
```

y el `tenantId` de la línea anterior se obtiene, cuando no hay operador, de
`resolverCuentaOficina(msg.from)`, que **tiene el `userId` a un campo de
distancia** (`contactos.ts:96`) y se descarta. Ana Rivera, encargada de `t-9` con
`telefono = '5215544332211'`, escribe «ya no trabajo ahí, borren mis datos»; se
inserta `solicitud_arco` con `operador_id = NULL`; `/dashboard/arco` pinta
`Titular: —` y ofrece el botón; `ejecutar_arco_cancelacion` rebota en `0356:39-41`
con «solicitud sin operador o de otra flota» sobre la solicitud de su propia
encargada. El motivo sigue mandando a buscar un problema de tenancy inexistente.

La 0356 tocó esta misma función y no movió el guard. Es la tercera ronda
consecutiva que el defecto sobrevive con la misma forma, solo cambiando de
población.

**Consecuencia.** Todo `flota_admin`, `contador`, `encargado` o `vendedor` que
ejerza cancelación por el canal que el producto le abrió: su nombre, teléfono,
correo y conversación sobreviven al derecho ejercido.

**Causa raíz probable.** `solicitud_arco.operador_id` referencia `operador`, así
que el esquema no tiene dónde poner a un titular que no es chofer, y cada arreglo
se ha hecho sobre el llamador en vez de sobre esa restricción.

---

### [ALTO] LEG-A5 — El teléfono personal del jefe de tráfico se transfiere a la grúa/llantera, y el aviso que Likida le dio a esa persona enumera solo encargados y promete pedir permiso antes de cualquier transferencia

`src/lib/likida/asistencia_coordinacion.ts:125` · `:305` ·
`src/lib/likida/contactos.ts:120-123` · `:185-227` ·
`src/app/privacidad/page.tsx:124` · `:130` · `:132` · `:58`

**Escenario (con valores).** En `t-9`, el dueño Javier Ruiz (`flota_admin`,
`telefono = '5215512345678'`) y la encargada Ana Rivera (`encargado`,
`5215544332211`). Ana —no Javier— aprieta «Contactar 1» sobre un varado.

1. `rotulosMensaje` llama `telefonoJefeDe(tenantId)` (`asistencia_coordinacion.ts:305`),
   que resuelve **por orden de ROL** (`contactos.ts:120-123` → `telefonosJefe`,
   `:214-224`), no por quien autorizó.
2. `armarMensajeProveedor` cierra el mensaje con (`:125`):
   `Contacto directo del jefe de tráfico: 5215512345678.`
3. `sendText` lo entrega al WhatsApp de «Llantas del Centro» y la línea queda
   archivada en `coordinacion_proveedor.mensaje_preparado`.

El número que sale es el celular de **Javier**, que no apretó nada. El aviso que
Likida le dio a él —donde **Likida es la responsable**, `privacidad/page.tsx:58`:
«Likida es responsable de los datos personales de quien contrata y usa el
servicio: la persona que administra la flota, el contralor, quien entra al
panel»— enumera en «Con quién se comparten» **solo personas encargadas**
(alojamiento, mensajería, correo, monitoreo, modelos, Stripe: `:124`, `:130`) y
cierra en `:132` con «**Si algún día quisiéramos transferir tus datos para algo
distinto, te lo pediríamos antes.** No hacer nada al leer esto no cuenta como
haber aceptado.» Cero transferencias declaradas.

Lo delata el propio aviso del operador, que sí lo sabe: «**tu teléfono no va en
ese mensaje**: el contacto que se les da es el del **jefe de tráfico**»
(`privacidad.ts:912`). El documento de un titular declara el dato de otro
titular, cuyo propio documento lo niega.

**Intenté refutarlo y no se cae.** (a) ¿Consentimiento por acción? El que aprieta
el botón puede no ser el que aparece en el mensaje — ése es el punto.
(b) ¿Es dato de contacto corporativo, no personal? `app_user.telefono` es el
celular con el que esa persona recibe los avisos de WhatsApp; es su número, no un
conmutador. (c) ¿Es la flota la responsable aquí? Para el operador sí, pero para
la cuenta de oficina el propio `/privacidad` dice que la responsable es Likida.

**Consecuencia.** Likida —como responsable, no como encargada— transfiere el
móvil de su cliente a un tercero comercial y guarda el acuse, contra un aviso que
promete lo contrario. Es la misma forma de LEG-C1 de la 29 en la población que
paga.

**Causa raíz probable.** El aviso de `/privacidad` se ha mantenido revisando los
flujos de **entrada** (modelos, Stripe, correo) y nadie cruzó los flujos de
**salida** del circuito de asistencia, que se razonó entero como datos del
operador.

---

### [ALTO] LEG-A6 — La oposición al tratamiento automatizado sigue sin poder encenderse cuando la flota no capturó su razón social: el único escritor vive dentro del `if (datos)` (REINCIDENTE de LEG-A1/29, intacto)

`src/lib/likida/processor.ts:341-372` (el `if (datos)` en `:342`, el escritor en
`:352-356`, el `else` con `warn` en `:365-370`) · `:377-380` ·
`supabase/migrations/0178_fiscal_retencion_arco_y_perfiles_erp.sql:152-162`

Reverificado: el bloque que escribe `operador.oposicion_automatizada` —el único
`update` de esa columna en todo `src/`— sigue anidado dentro de
`if (datos)`, y el `logger.warn('arco.oposicion_sin_operador')` que la 29 vio
sigue **un nivel más abajo del que hacía falta**: también está dentro del mismo
`if`. Con `tenant.razon_social` nulo, `getDatosResponsable` devuelve `null`, se
salta todo el bloque, el titular recibe «Tu solicitud quedó registrada. Déjame
checar con la empresa…» (`:379`) y el único log es
`privacidad.solicitud_sin_datos_responsable` (`:377`), que habla del responsable,
no del derecho que no se encendió. `ejecutar_arco_oposicion` (`0178:152-162`)
tampoco escribe la columna, así que no hay salida manual.

**Consecuencia.** Falla silenciosa en sentido estricto: la constancia dice que se
recibió, el motor sigue cerrando liquidaciones solo, y ni el titular ni la flota
tienen forma de saberlo.

---

### [ALTO] LEG-A7 — La anonimización de `incidencia` (0273) es reversible por `viaje_id`: `hay_lesionados` —dato de salud— sobrevive a la cancelación y se vuelve a ligar al titular por el identificador que la propia función conserva

`supabase/migrations/0356_arco_borra_contacto_emergencia.sql:85-89` ·
`supabase/migrations/0047_operacion_encargado.sql:100` ·
`supabase/migrations/0198_asistencia_siniestros.sql:46` ·
`src/lib/likida/asistencia_wa.ts:530-537` · `src/lib/likida/privacidad.ts:746`

**Norma.** `normas/lfpdppp-2-XII-XX.yaml`, art. 2: dato sensible es el que se
refiere al estado de salud. El propio repo lo tiene escrito en
`privacidad.ts:746`. Y art. 2 fr. IX: un dato sigue siendo personal mientras el
titular sea **identificable**.

**Escenario (con valores).** Juan Pérez (`op-1`) choca el 12-may-2026 en el viaje
`v-77`; contesta por WhatsApp que sí hay lesionados.
`asistencia_wa.ts:530-537` crea la incidencia con `viajeId: 'v-77'`,
`operadorId: 'op-1'`, `hayLesionados: true`. El 1-sep pide cancelación y se
ejecuta.

`0356:85-89` hace `update incidencia set descripcion = '[texto retirado…]',
operador_id = null, texto_anonimizado_en = now()`. **No toca `viaje_id`**
(`0047:100`) **ni `hay_lesionados`** (`0198:46`). Y `viaje.operador_id` se
conserva deliberadamente. Entonces:

```sql
select i.hay_lesionados, i.abierta_en, i.unidad_id
  from incidencia i join viaje v on v.id = i.viaje_id
 where v.operador_id = 'op-1';   -- devuelve la fila: true, 12-may-2026, T-402
```

La «anonimización» que la 0273 introdujo para el texto libre es cosmética para
toda incidencia colgada de un viaje, que son todas las que abre el chofer o la
cámara (ambos caminos pasan `viajeId`).

**Intenté refutarlo y no se cae.** No es un dato que el aviso declare conservado:
ni la resolución de la RPC (`0356:121`, cuatro categorías) ni el WhatsApp
(`repo.ts:1828`, siete) mencionan el expediente de asistencia ni el hecho de si
estuvo lesionado. Y el seudónimo no ayuda: la re-identificación no pasa por el
nombre, pasa por el UUID que la función conserva por diseño.

**Consecuencia.** Después de una cancelación ejecutada y acusada, cualquiera con
lectura de la base puede contestar «¿este chofer resultó lesionado en un
accidente, cuándo y en qué unidad?». Es dato sensible, y la constancia dice que
lo único conservado del titular es su identificador, su correo, su referencia y
papel fiscal.

**Causa raíz probable.** La 0273 anonimizó el texto y la llave directa
(`operador_id`) sin revisar la llave indirecta (`viaje_id`), y el diseño de la
cancelación decidió conservar `viaje.operador_id` sin evaluar qué se vuelve
re-identificable a través de él.

---

### [MEDIO] LEG-M1 — El aviso integral público sigue anunciando «Vigente desde el 1 de septiembre de 2026» sobre un texto que el propio arreglo de LEG-C1 cambió el 8 de septiembre (REINCIDENTE de LEG-M1/29)

`src/app/aviso/[tenant]/page.tsx:38` · `:110-111` ·
`src/lib/likida/privacidad.ts:912-913` · `src/app/legal/marco_leg12_aud24.test.ts:25-34`

`VIGENTE_DESDE = '2026-09-01'` (`:38`, con el comentario «Actualizar junto con el
texto»), y la página imprime «Vigente desde el {fechaMx(VIGENTE_DESDE)}»
(`:110-111`). `git log -1 -- src/lib/likida/privacidad.ts` → **8fc2fa7,
2026-09-08**: el commit que añadió el párrafo entero de la transferencia al
proveedor de auxilio y reescribió la enumeración del art. 35. Un titular que abra
la liga hoy lee una sección de transferencias que no existía en la fecha que el
encabezado le declara vigente. El único candado (`marco_leg12_aud24.test.ts:25-34`)
exige que la fecha sea **constante**, no que sea **cierta**.

Duele más esta ronda porque es el arreglo del crítico de la 29 el que dejó la
fecha atrás: la firma que decide el reenvío (`versionAvisoVigente`) sí cambió ese
día; el rótulo que la persona lee, no.

---

### [MEDIO] LEG-M2 — El comprobante que el operador mandó y luego dijo que no era de ese viaje se queda para siempre: `comprobante_huerfano` no tiene purga, no la toca ARCO y no la declara ningún aviso

`supabase/migrations/0040_comprobante_huerfano.sql:28-48` (en concreto `:31`,
`:34`, `:38`, `:48`) · `supabase/migrations/0165_storage_sin_delete_directo.sql:136-140` ·
`supabase/migrations/0335_db_retencion_r3_forward.sql:314-343` ·
`supabase/migrations/0356_arco_borra_contacto_emergencia.sql:61-101`

**Escenario (con valores).** Juan manda una foto de un ticket de la farmacia por
error, sin viaje abierto. Se inserta `comprobante_huerfano` con
`operador_id = 'op-1'` (`not null`, `:31`), `ruta_imagen = 't-9/2026/03/abc.jpg'`
(`:34`) y `gasto` jsonb con la extracción completa del OCR (`:38`). Likida le
pregunta y él contesta que no es de ningún viaje →
`resolucion = 'descartado'`, `viaje_id = NULL` (`:44`, `:48`).

Ese comprobante **nunca entró en una liquidación**, así que no hay CFF art. 30
que lo retenga. Y sin embargo:

- No hay purga: `comprobante_huerfano` no aparece en ninguna de las diecinueve
  llamadas de `mantenimiento_de_datos` (`0335:314-343`).
- La imagen está **protegida a propósito** del barrido de Storage:
  `limpiar_storage_huerfano` hace anti-join contra `comprobante_huerfano.ruta_imagen`
  (`0165:136-140`) — es decir, mientras la fila viva, el archivo es intocable.
- `ejecutar_arco_cancelacion` no la nombra (`0356:61-101`).
- Ningún aviso la declara: ni entre lo conservado tras una cancelación, ni con un
  plazo.

**Consecuencia.** La categoría de comprobante con **menos** base legal de
retención es la única del repo con retención **infinita** por construcción,
ligada por `operador_id` al titular, imagen incluida.

---

### [MEDIO] LEG-M3 — El derecho de acceso sigue siendo el tipo por omisión y el único sin acto asociado: no existe función que arme el paquete de datos de un titular (REINCIDENTE de LEG-M1/29 y LEG-M1/28, tercera ronda)

`src/lib/likida/privacidad.ts:958` (`return 'acceso'`) ·
`src/app/dashboard/arco/page.tsx:20` · `:255-288` ·
`src/app/api/export/` (siete rutas)

`tipoDeSolicitudArco` cae a `'acceso'` ante cualquier texto que no calce
cancelación, oposición o rectificación (`:958`, con el comentario que lo declara).
En `/dashboard/arco`, `cancelacion` tiene ejecutor (`:255-257`) y `oposicion` tiene
constancia (`:274-283`); `acceso` solo ofrece «Responder» con un campo de prosa
(`:284-287`). Y `ls src/app/api/export/`: siete rutas, todas de flota
(`liquidaciones`, `pdf/[id]`, `facturas-proveedor`, `bitacora-peaje`, `jornada`,
`carta-porte-xml`, `poliza`) — ninguna arma el expediente de **un titular**.

**Consecuencia.** El derecho que la ley pone primero, y al que cae por omisión
toda solicitud que la heurística no clasifica, es el único que el producto no
puede ejecutar: solo escribir prosa y marcarla resuelta. Art. 31: 20 días
hábiles para una determinación que aquí no tiene contenido posible.

---

### [MEDIO] LEG-M4 — «Contesta BAJA y se borran tus datos de persona» sigue siendo falso para quien agendó una demo: el payload íntegro de Cal.com queda 365 días y la baja no lo toca por diseño declarado (REINCIDENTE de LEG-M2/29, intacto)

`src/lib/likida/privacidad.ts:1088` ·
`src/lib/correo/respuesta_campana.ts:109-112` (en concreto `:111`) · `:126-181` ·
`src/lib/admin/calcom_webhook.ts:189` ·
`supabase/migrations/0245_purga_prospecto_entera_y_ledger_comercial.sql:139-148`

Reverificado: `respuesta_campana.ts:111` sigue diciendo, literal, que la función
«No toca … `comercial_evento` (la anonimiza `purgar_comercial_evento` **por edad,
no por baja**)». María Fernández agenda el 1-mar-2026; `calcom_webhook.ts:189`
guarda `evt.payload` completo —`attendees[].name`, `.email`, `.phone`,
`.timeZone` y las respuestas libres— en `comercial_evento.payload`; el 10-mar
contesta BAJA y recibe confirmación escrita; sus datos siguen ahí hasta el
1-mar-2027 (`0245:139-142`). Aquí Likida es **responsable**, no encargada: acuse
documentado de un borrado que no ocurrió.

---

### [BAJO] LEG-B1 — Los comentarios que fundamentan datos sensibles, voz y confidencialidad siguen citando la numeración de la ley ABROGADA (REINCIDENTE de LEG-B1/29, intacto)

`src/lib/likida/privacidad.ts:295` · `:322` · `:734` · `:746` ·
`src/lib/meta/client.ts:744`

`grep -rn "art\. 3 fr\." src/` → cuatro coincidencias, las cuatro en
`privacidad.ts`, que es la fuente de verdad del aviso: «Dato SENSIBLE (LFPDPPP
art. 3 fr. VI)», «(LFPDPPP art. 3 fr. IX)», «La voz es dato personal por sí misma
(art. 3 fr. V)», «La salud es dato sensible (art. 3 fr. VI)». Más
`meta/client.ts:744`, «LFPDPPP art. 21». La LFPDPPP vigente es la de marzo 2025:
las definiciones están en el **art. 2** y la confidencialidad en el **art. 20**
(`docs/conocimiento/11-datos-personales.md:37-52`). El archivo hermano lo tiene
bien (`intake/sanitizar.ts:35`, «art. 2 fr. VI»). Lo que el titular lee está
correcto; el daño es de due diligence sobre el archivo que un abogado abriría
primero.

---

## Lo que revisé y está bien

### Qué toca y qué NO toca `ejecutar_arco_cancelacion` (cuerpo vivo: `0356:35-125`)

Cotejé `0353:230-329` contra `0356:21-126`: la única diferencia funcional es el
`delete from contacto_emergencia` y el texto de `resolucion`
(`diff` limpio, sin regresiones).

**SÍ toca (8 escrituras, cada una con su contador en `evidencia`):**

| Tabla | Qué hace | Línea |
|---|---|---|
| `wa_conversacion` | **borra** por `operador_id` **o** por teléfono normalizado | `0356:61-66` |
| `envio_mensaje` | **borra** por teléfono normalizado | `:68-72` |
| `contacto_emergencia` | **borra** (nuevo en 0356 — dato de un tercero, sin fundamento fiscal) | `:76-78` |
| `incidencia` | pisa `descripcion`, pone `operador_id = null`, sella `texto_anonimizado_en` | `:85-89` |
| `incidencia_evento` | pisa `detalle->'texto'`, solo donde la llave existe | `:92-100` |
| `operador` | seudónimo, teléfono `anon:<hash>`, `rfc/licencia/licencia_tipo/licencia_vence = null` | `:103-111` |
| `app_user` | seudónimo, `telefono = null`, `avatar_url = null` (conserva `email` y `operador_id`) | `:114-116` |
| `solicitud_arco` | cierra, sella evidencia y escribe `resolucion` si venía vacía | `:119-122` |

**NO toca — tablas y columnas con dato personal del titular que sobreviven:**

| Tabla / columna | Qué queda | Base declarada |
|---|---|---|
| `gasto`, `cfdi_xml`, imágenes de comprobante | íntegros | **sí**: CFF art. 30, `evidencia_fiscal_retenida` (`:59`) |
| `viaje.operador_id` | el UUID del titular | **sí**: «el identificador del operador» (`:121`) |
| `app_user.email` | el correo | **sí** (`:121`) |
| `solicitud_arco.titular_ref` | el teléfono original | **sí** (`:121`) |
| `jornada_dia` / `jornada_asiento` / `jornada_derivacion_*` | `operador_id not null`, texto libre del chofer en `detalle` (`0241:194`), `wa_message_id` | solo en el WhatsApp y la pantalla, **no** en la constancia → LEG-A3 |
| `evento_seguridad_flota` | `operador_id`, `lat/lng`, `url_evento` (video) | ídem → LEG-A3 (se autopurga 180/365 d) |
| **`coordinacion_proveedor`** | `mensaje_preparado` con la coordenada literal, `proveedor_telefono`, `autorizada_por` | **ninguna** → **LEG-C1** |
| `incidencia.viaje_id`, `.lat/.lng`, `.hay_lesionados`, `.unidad_id` | el expediente y el dato de salud, re-ligables | **ninguna** → LEG-A7 |
| `comprobante_huerfano` | `operador_id not null`, `ruta_imagen`, OCR completo | **ninguna** → LEG-M2 |
| `pod` | `operador_id`, `storage_path`, `lat/lng`, `nota` libre | **ninguna** (no reportado aparte: se pisa con LEG-A7/M2) |
| `posicion` | por `unidad_id`, sin `operador_id` | se autopurga a 90 d (`0335:335`) |
| `wa_mensaje_procesado` | sin `tenant_id`, no atribuible | se autopurga |

- **`contacto_emergencia` sí se borra de verdad, y sí está comprobado.** La prueba
  no está donde el foco la mandaba a buscar: `supabase/tests/0340_arco_alcance.sql`
  **no siembra ninguna fila** de esa tabla —solo se actualizó su literal de
  `resolucion` en `:33`—, así que el `delete` no se ejercita ahí. Quien lo cubre es
  `supabase/verificaciones.sql`, bloque 144: siembra `('Familiar ARCO',
  '+520000017399', 'esposa')` y exige `familia_fuera = 0` después de ejecutar. Es
  cobertura real, contra Postgres real, aunque no corra en la compuerta de aquí.
- **La renuncia declarada de la 0356 está bien escrita**: la purga por antigüedad
  del contacto de emergencia (la otra mitad de LEG-M5) queda *señalada*, con la
  razón —fijar un plazo para el dato de un tercero es decisión de política, no un
  hecho mecánico— en la cabecera y en el `comment on function` (`:14-18`, `:129`).
  Media verdad **dicha** es la forma correcta de dejar una deuda.
- **`0754652` cubre las rutas que exportan dato personal del operador.** Verificado
  uno por uno: `bitacora-peaje/route.ts:65`, `jornada/route.ts:128`,
  `carta-porte-xml/route.ts:85` y `:126`, `facturas-proveedor/route.ts:110`,
  `poliza/route.ts:442` y `:466`, `liquidaciones/route.ts:209`, y el redirect a URL
  firmada de `pdf/[id]/route.ts:177`. Las dos que más dato personal llevan —jornada
  (el registro laboral del chofer) y bitácora de peaje— están dentro, y
  `carta-porte-xml`, que lleva RFC y licencia del operador, marca las **dos**
  salidas. `rutas_export.test.ts` y `poliza/salida.test.ts` lo anclan.
- **`/dashboard/carta-porte` prueba el aislamiento, no el pintado.** Cuatro casos
  (`page.test.tsx:62-64`, `:88-90`, `:97-98`, `:107-109`) meten `tenantId: 'OTRO'`
  y `userId: 'OTRO-U'` en el `FormData` y afirman que la acción llamó con `'t-1'` y
  `{ id: 'u-1' }`: el dato del formulario se ignora y manda la sesión. Eso sí muerde.
- **`/dashboard/conversaciones` gatea el hilo completo del chofer donde debe.**
  `page.test.tsx:43-47` afirma que `encargado`, `contador` y `vendedor` reciben
  `redirect` **antes de tocar la base** (`getHilosDeFlota` no se llamó), y `:54-58`
  que se lee con el tenant de la **sesión**. El filtro real vive en
  `conversaciones.ts:77` y `:107` y tiene su propia prueba de aislamiento
  (`conversaciones_aislamiento.test.ts:67-104`).
- **`/dashboard/timbrado`: la cola no lleva dato personal del operador.**
  `listarTimbrado` (`carta_porte_timbre.ts:456-510`) selecciona `folio, origen,
  destino, uuid_fiscal, estado, modo` y acota con `.eq('tenant_id', tenantId)` en
  las tres consultas. Su prueba de página es de rótulos (sandbox vs producción, cola
  caída vs vacía) y eso es lo correcto **para esta página**: no hay PII que filtrar.
- **La revocación de credenciales de portal sigue destruyendo el secreto.**
  `conectores/credenciales.ts:460-488` pisa `valores_cifrados` con `revocada:<fecha>`
  e invalida la fila `#sesion` (`facturacion/sesion_portal.ts:228-253`). La e.firma
  no se custodia: `sat_descarga/escritura.ts:70-119` guarda referencia y vigencia, no
  la credencial.
- **Toda salida a modelo sigue saliendo por una puerta.** Un solo `baseURL`
  (`openrouter.ts:36`) y los tres cuerpos de petición extienden `PROVIDER_OPTS` con
  `provider: { data_collection: 'deny' }` (`:281-287`). El aviso describe eso
  —pedirlo— y no promete un contrato de retención cero (`privacidad.ts:885-886`).
- **La compuerta «no se trata antes de avisar» sigue fallando cerrada.**
  `privacidad.ts:1161-1184` y `:1210-1279`: sin poder leer, la respuesta es «no»; dos
  viajes vivos de operadores distintos sobre la misma unidad se bloquean por
  ambigüedad; `processor.ts:1802-1820` mete la nota de voz detrás de la compuerta
  **antes** de transcribir.
- **`0350_cascade_chat_cobranza.sql` es una mejora real de retención**:
  `chat_conversacion` y `cobranza_contacto` pasan a cascada al borrar el tenant, que
  era el hueco por el que el borrado de una flota dejaba prosa de personas atrás.
- **`purgar_geolocalizacion_incidencia` hace bien lo que dice hacer** (`0289:54-69`):
  cuenta desde `resuelta_en`, deja `geolocalizacion_purgada_en` para que el hueco no
  se lea como «nunca hubo pin», y protege el hecho operativo. El problema es el
  almacén que no enumeró, no la función.

## Lo que NO alcancé a revisar

- **La retención del lado del proveedor** (Meta, OpenRouter y su cadena,
  Facturapi/PAC, Stripe, Cal.com, Samsara). Cuarto pendiente consecutivo: desde el
  repo se lee lo que se **pide** en cada llamada, no lo que el proveedor cumple.
- **El circuito de soporte (`ticket_mensaje`, 0268)**: sigue sin recorrer. Quién ve
  el texto libre de un ticket, si se purga, si la cancelación ARCO lo alcanza.
  Segundo pendiente consecutivo.
- **`activasDeTelefono` (`asistencia_coordinacion.ts:547-551`) consulta
  `coordinacion_proveedor` por `proveedor_telefono` SIN filtro de tenant** y filtra
  después en TS. Lo anoto para el auditor de seguridad —tenancy es su rubro—, no lo
  dictamino aquí.
- **`pod`** (foto de entrega con `lat/lng`, `nota` libre y `operador_id`): lo
  enumeré en la tabla de arriba pero no reconstruí su escenario ni busqué si algún
  aviso lo declara.
- **La retención de los logs de plataforma** (`processor.ts:1834-1837` escribe la
  transcripción íntegra de la nota de voz en el log). Sin panel de Vercel no se
  mide; quinto pendiente consecutivo.
- **El ARCO de prospectos**, encaminado a un correo (`privacidad.ts:1097`) sin
  código detrás: no verifiqué si ese buzón existe.
- **La base entera está en cero** (0 viajes, 0 clientes): ningún escenario se
  confirmó contra filas reales. Todos están construidos leyendo código, migraciones
  y fichas de `normas/`, y cada línea citada la abrí y la leí. Las dos afirmaciones
  que dependen de una base viva —el `delete` de `contacto_emergencia` y el bloque 144
  de `verificaciones.sql`— las tomo del texto, no de una corrida.
