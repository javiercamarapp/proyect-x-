# Cumplimiento legal — auditoría 26

**Nota: 6/10** (antes 5). Razón del movimiento: **se arregló de verdad**. De los
seis abiertos, LEG-1 y LEG-6 quedaron cerrados; LEG-2 y LEG-5 se movieron mucho
pero incompletos; LEG-3 se cerró en su texto y se rompió en su entrega; LEG-4 lo
**reabrió su propio arreglo de seguimiento** (`5c9c1cd`), exactamente como se
sospechaba. La subida es de 5 a 6 y no más porque el mecanismo que hace llegar
los avisos —lo único que convierte un texto legal en cumplimiento— resultó estar
ciego a la mitad del documento que publica.

**Riesgo mayor de hoy:** el aviso integral promete por escrito que un cambio en
él llega solo por WhatsApp, y el hash que dispara ese reenvío nunca ha visto el
texto del integral — así que la cláusula de transferencia que esta misma ronda
añadió (nombre del operador + anticipo hacia un modelo externo) está publicada y
no la ha recibido ni un titular.

---

## Verificación de los abiertos de la 25

| Hallazgo | Commit | Veredicto |
|---|---|---|
| LEG-1 aviso de prospectos ↔ investigador | `b734426` | **CERRADO**. `privacidad.ts:1001` y `:1032` describen el flujo real de `investigador.ts:352-364` (páginas completas al modelo, correos/teléfonos sin seudonimizar). |
| LEG-2 «BAJA borra» | `3fde880` | **REINCIDENTE (parcial)** — ver LEG-26-3. |
| LEG-3 chat del panel | `0dab70e` | Texto **CERRADO** (`privacidad.ts:820`); entrega **ROTA** — ver LEG-26-1. |
| LEG-4 unidad sin viaje vivo | `6ebfa53` + `5c9c1cd` | **REINCIDENTE (reabierto)** — ver LEG-26-2. |
| LEG-5 salud y familia | `97c019a` | **REINCIDENTE (parcial)** — ver LEG-26-4. |
| LEG-6 anexo de subencargados | `6040958` | **CERRADO** en el anexo (Stripe y Cal.com con su plazo). El hueco que el propio commit anotó sigue abierto en el aviso — ver LEG-26-5. |

---

## Hallazgos

### [ALTO] El procedimiento de comunicación de cambios del art. 15 fr. VI no puede dispararse para el aviso integral

`src/lib/likida/privacidad.ts:844-846` · `src/lib/likida/processor.ts:397,402,419`
· `src/app/aviso/[tenant]/page.tsx:37`

**Escenario (con valores).** El 3-sep-2026 el commit `0dab70e` añadió a
`avisoIntegral()`, sección «Transferencias a terceros», el párrafo de
`privacidad.ts:820`:

> «Y cuando alguien de tu empresa usa el **asistente del panel** para preguntar
> por los viajes de la flota, ese modelo también puede recibir tu **nombre**
> junto con **montos de tus viajes** —el anticipo, por ejemplo—…»

Es la declaración de una salida de datos personales que ya ocurre
(`src/lib/agents/chat-tools.ts:170-173`: `operador: v.operadorNombre` +
`anticipo: v.anticipo` → `generateWithTools` → OpenRouter).

Ahora el mecanismo. `ponerAvisoADisposicion` calcula la versión así:

```
397   const texto = avisoSimplificado(datos);
402   if (!(await reclamarEnvioAviso(tenantId, operadorId, versionAviso(texto)))) return 'puesto';
419   await confirmarEnvioAviso(tenantId, operadorId, versionAviso(texto));
```

`versionAviso` se computa **siempre** sobre `avisoSimplificado`, nunca sobre
`avisoIntegral` (comprobado: los únicos dos llamadores en producción son
`processor.ts:402/419` y `qa-motor.ts:276-281`; `avisoIntegral()` solo lo consume
la página pública). El commit `0dab70e` no tocó una sola línea de
`avisoSimplificado`, así que para el operador Juan Pérez —`aviso_privacidad_en`
del 20-ago, `aviso_privacidad_version` = hash del simplificado— el hash del
4-sep es **idéntico** al del 20-ago: `reclamarEnvioAviso` devuelve `false`, se
retorna `'puesto'`, y no sale ningún mensaje. Juan sigue con el aviso de agosto,
que no menciona esa transferencia.

Y el propio integral, en la sección «Cómo te avisamos si este aviso cambia»
(`privacidad.ts:844-846`), afirma lo contrario con todas sus letras:

> «Cuando este aviso cambie, **recibes el aviso nuevo por el mismo WhatsApp**…
> **No es una promesa:** el sistema calcula una firma del texto y reenvía en
> cuanto deja de coincidir con la última que se te entregó.»

Segunda evidencia del mismo desfase, en la misma página: `VIGENTE_DESDE =
'2026-09-01'` (`page.tsx:37`, con el comentario «Actualizar junto con el texto»)
mientras el texto cambió el 3-sep. La página le dice al titular que lo que lee
está vigente desde antes de que existiera.

**Consecuencia.** Titular afectado: todo operador con aviso ya entregado en
cualquier flota. Se incumple el **art. 15 fr. VI LFPDPPP** (el responsable debe
comunicar los cambios *por el procedimiento y medio declarados*): el
procedimiento está declarado y es estructuralmente insatisfacible para el
documento donde está escrito. Y con ello el **art. 16** para el tratamiento
nuevo: la salida de `viajes_flota` hacia el modelo opera bajo una cobertura que
no se puso a disposición de nadie. La flota es la responsable sancionable; el
mecanismo roto es de Likida.

**Causa raíz probable.** `versionAviso` se diseñó como firma del *mensaje de
WhatsApp*, y cuando el integral se separó en su propia función nadie extendió el
hash ni le puso una prueba que ligara los dos textos.

---

### [ALTO] El evento GRAVE de cámara vuelve a guardarse sin aviso previo — incluso con el operador plenamente identificado (LEG-4 reabierto por `5c9c1cd`)

`src/lib/likida/conectores/sincronizar_eventos.ts:162-188` ·
`src/lib/likida/asistencia_camara.ts:178-179,233-243` ·
`src/lib/likida/conectores/sincronizar_eventos_leg_op1.test.ts:165`

**Escenario (con valores).** Flota T, unidad `u-1` (`gps_device_id`
`SAM-88213`), **viaje `v-1` abierto** con `operador_id = op-1` (Juan Pérez), y
`operador.aviso_privacidad_en = NULL` — Juan nunca ha escrito por WhatsApp, así
que la compuerta del `processor.ts` jamás corrió para él. La cámara Samsara
reporta un evento con `etiquetas: ['crash']`, `url_evento:
'https://cloud.samsara.com/o/1234/fleet/events/998877'` (el video de Juan al
volante), `lat/lng` y `max_g: 6.4`.

El poller filtra la compuerta **solo sobre lo rutinario**:

```
162   const rutinarios = eventos.filter((e) => !esEventoGrave(e.etiquetas));
163   const conUnidadRutinaria = [...]                       // u-1 NO entra: su evento es grave
188   if (!grave && unidadId && sinAviso.has(unidadId)) continue;   // los graves nunca se saltan
```

Resultado: la fila entra a `evento_seguridad_flota` con `url_evento`, `lat`,
`lng` y `unidad_id`; el barrido llama `dispararAsistenciaPorEventoCamara`, que
resuelve `viajeVigenteDeUnidad` → `operadorId = 'op-1'`
(`asistencia_camara.ts:178-179`) y crea la incidencia **con ese `operadorId`**
(`:233-243`), con la liga al video dentro de `descripcion`
(`descripcionDelEvento`, `:166`); y sale un WhatsApp al jefe con la URL del video
(`:302`). Su propia prueba lo fija: *«GRAVE + CON viaje vivo pero SIN aviso del
operador: se guarda y dispara IGUAL»* (`sincronizar_eventos_leg_op1.test.ts:165`).

La justificación escrita en `5c9c1cd` —*«sin viaje vivo el expediente ya se abre
por unidad, sin `operador_id`, sin atar el evento a una persona identificada»*—
**no aplica a este cuadrante**: aquí sí hay viaje vivo y sí se ata a `op-1`. Y el
bypass no se acota a la urgencia: la fila queda 365 días
(`purgar_evento_seguridad_flota`, mig. 0288) disponible para la finalidad que el
propio aviso declara **oponible** — *«quedan disponibles para que tu empresa
revise cómo conduces»* (`privacidad.ts:646`) — de un titular que nunca recibió el
aviso y por tanto nunca supo que tenía ese derecho.

**Consecuencia.** Titular: el operador de cualquier flota con cámara conectada
cuyo alta no haya pasado aún por el chat. Se incumple el **art. 16 LFPDPPP**
(poner el aviso a disposición antes de tratar, por medio electrónico) y el **art.
26 fr. II** (oposición al uso no necesario, que no puede ejercerse sobre un
tratamiento que no se conoce). La emergencia justifica atender el choque; no
justifica la conservación a un año ni la finalidad de evaluación de conducta.

**Causa raíz probable.** El arreglo de la urgencia física se aplicó al evento
completo en vez de a la acción urgente, y no distinguió el cuadrante donde el
titular sí está identificado.

---

### [ALTO] «Contesta BAJA y se borran tus datos de persona» sigue siendo falso para cuatro tablas — y la BAJA les regala otros 365 días

`src/lib/correo/respuesta_campana.ts:101-132` y `:214-218` ·
`src/lib/likida/privacidad.ts:1009-1010` ·
`supabase/migrations/0258_purga_satelites_prospecto.sql:141-152,183-205`

**Escenario (con valores).** 10-sep-2026: el investigador corre sobre el
prospecto `p-77` (Transportes del Bajío). Deja
`prospecto_dossier.telefonos = ['81 1234 5678']` y
`prospecto_dossier.datos = [{dato: 'Correo hallado con dominio ajeno … :
ramon.trevino@fletesbajio.mx'}]` (`investigador.ts:418-429`), y el redactor deja
una pieza `correo_frio` en `cola_aprobacion` con `cuerpo` = «Hola Ramón, …».
11-sep: Ramón Treviño contesta «BAJA» desde `ramon.trevino@fletesbajio.mx`.

`borrarDatosPersonaPorBaja` toca exactamente **tres** cosas
(`respuesta_campana.ts:105`, `:112`, `:122`): `prospecto_persona`,
`prospecto_correo` y las columnas de cabecera de `prospecto`. La purga de 12
meses que el aviso invoca toca **seis** (mig. 0258): las tres anteriores **más**
`cola_aprobacion` (`:188`), `prospecto_dossier.telefonos/datos` (`:194`) y
`prospecto_toque.resumen` (`:201`). El comentario del propio arreglo afirma
«Mismo criterio de columnas que `purgar_prospecto_persona`»
(`respuesta_campana.ts:90-91`): no lo es.

Y el remate. Doce líneas después del borrado, el mismo flujo inserta el historial:

```
214   await supabaseAdmin().from('prospecto_contacto').insert({
216     resumen: `Contestó${baja ? ' pidiendo BAJA' : ''}: «${asunto || 'sin asunto'}»`…
```

El filtro de frialdad de la purga es
`not exists (select 1 from prospecto_contacto c where c.prospecto_id = p.id and
c.ocurrio_en >= limite)` (0258:146-149). Esa fila recién insertada mantiene a
`p-77` **caliente hasta el 11-sep-2027**: el nombre de Ramón dentro del borrador
de `cola_aprobacion`, su teléfono en el dossier y su correo en `datos` sobreviven
un año más **por haber ejercido el derecho**. Es literalmente el defecto que
`3fde880` decía cerrar, desplazado a las tablas que el borrado manual no cubre.

A eso se suma `comercial_evento`: si Ramón agendó demo, su nombre, correo y
respuestas libres viven en `payload` (webhook de Cal.com, `route.ts:71`,
`payload: evt.payload ?? {}`) y solo se vacían por **edad del evento** a los 365
días (`purgar_comercial_evento`, 0245:138-142). La BAJA no lo alcanza.

**Consecuencia.** Titular: cualquier persona física del censo de prospección —
aquí Likida es **responsable**, no encargada. Se incumple el **art. 15 fr. IV y
V** (las opciones y medios que el aviso ofrece tienen que ser los que el
responsable de verdad ejecuta) y el **art. 11** (conservar solo lo necesario y
suprimir cuando deja de serlo); la confirmación «se te confirma por escrito»
convierte el incumplimiento en constancia firmada.

**Causa raíz probable.** El borrado se escribió enumerando columnas a mano en
lugar de invocar el mismo inventario de tablas que la purga ya tiene decidido y
verificado por el bloque 206.

---

### [ALTO] El parte de incidente ya no *dice* si hay lesionados, pero lo *revela* por construcción

`src/lib/likida/agentes/direccion.ts:537-553` y `:634-643` (con `:612-614`)

**Escenario (con valores).** Incidencia `inc-4b2` de la flota «Fletes del
Norte», `tipo = 'siniestro'`, `operador_id = op-9` (Juan Pérez López),
`hay_lesionados = true`; `contacto_emergencia` de `op-9` = {nombre: 'María López
Ruiz', parentesco: 'esposa', telefono: '5533221100', avisar_si_lesionados:
true}. Corre `correrEspecialistasIncidente`.

`aQuienLlamar` solo emite la entrada familiar **si `hayLesionados === true`**
(`:537`). `armarParteIncidente` imprime, en el cuerpo que se encola:

```
636   ·  1. Contacto de emergencia — familia de Juan Pérez López (nombre y parentesco: en el expediente, no reproducidos aquí)
638   ·     tel: disponible en el panel de tu flota — este parte no lo reproduce (expediente inc-4b2).
```

Dos líneas antes, `:614` se niega a afirmar el dato: *«¿Hay lesionados? Ya se
contestó en el expediente — este parte no reproduce el dato de salud.»* Pero la
sola presencia del renglón 1 lo reproduce: la rama es un `if
(hayLesionados === true)`, así que **familia en la lista ⟺ hay lesionados**. El
lector de `/admin` —bandeja interna de Likida, `cola_aprobacion`— sabe, sin
abrir el panel del tenant, que Juan Pérez López tuvo un accidente **con personas
lesionadas**.

La redacción de `97c019a` sacó el valor literal y dejó el canal de inferencia. Y
`cola_aprobacion` sigue sin FK a `operador` ni a `contacto_emergencia`, sin
purga para piezas con `prospecto_id` nulo y fuera de `ejecutar_arco_cancelacion`
(0286, que no la nombra) — el mismo argumento que originó LEG-5.

**Consecuencia.** Titular: el operador (dato de salud) y, de rebote, su
familiar. Es dato **sensible** (art. 3 fr. VI LFPDPPP); se incumple el **art. 8
párrafo segundo** (tratamiento de sensibles sin consentimiento expreso ni
justificación) y el **art. 22/25** (la cancelación no alcanza la copia), con el
agravante del **art. 59 fr. IV** (sanción incrementable hasta el doble por
sensibles).

**Causa raíz probable.** Se redactó el texto sin volver a mirar qué implica la
condición que decide si la línea existe.

---

### [MEDIO] El aviso de prospectos no enumera las respuestas libres de la demo, ni a Cal.com entre las encargadas — y su plazo no es el que el aviso promete

`src/lib/likida/privacidad.ts:977-985` y `:1027-1032` ·
`src/app/api/webhook/calcom/route.ts:71` ·
`supabase/migrations/0245_…:138-142` ·
`docs/conocimiento/52-anexo-subencargados.md` (párrafo «Sobre Stripe y Cal.com»)

**Escenario (con valores).** Ramón Treviño agenda una demo en Cal.com y escribe
en el campo libre «¿algo que debamos saber?»: «Somos 40 unidades, mi socio no
quiere que se enteren los operadores; mi celular directo es 81 1234 5678». El
webhook guarda `evt.payload` **íntegro y sin filtrar** en
`comercial_evento.payload` (`route.ts:71`) — nombre, correo, zona horaria y esa
respuesta libre — durante **365 días** (`purgar_comercial_evento`).

En `/aviso/prospectos`, la sección «Qué datos tenemos y de dónde salieron»
(`privacidad.ts:977-985`) enumera nombre, puesto, correo, teléfono, perfil,
datos de la empresa y los identificadores de campaña (`fbclid`/`gclid`) — **no
las respuestas libres de la reserva**. La sección «Con quién se comparten»
(`:1027`) nombra «alojamiento de la base de datos, envío de correo y mensajería,
y los modelos de lenguaje» — **ni Cal.com ni Stripe**, que son las dos filas que
`6040958` acaba de añadir al anexo al que esta misma página remite por escrito.
Y la sección de baja (`:1010`) afirma que a los 12 meses «lo único que queda es
el registro de la empresa», cuando `comercial_evento` corre por su propio reloj
de edad del evento y `prospecto_contacto` no se purga nunca.

El propio commit lo dejó anotado —«Este plazo de 365 días no está en
`/aviso/prospectos` … revisión legal humana recomendada»—, así que el hueco está
identificado; lo que falta es que llegue al documento que el titular lee.

**Consecuencia.** Titular: el prospecto (Likida responsable). **Art. 15 fr. II**
(enumerar los datos sometidos a tratamiento) y **fr. VI/art. 11** (la promesa de
supresión tiene que corresponder al plazo real).

**Causa raíz probable.** El anexo interno y el aviso público se mantienen por
separado y solo el primero tiene dueño.

---

### [MEDIO] `prospecto_contacto` está exenta de toda purga porque «no lleva datos de persona» — y la respuesta de campaña le escribe el asunto que la persona redactó

`src/lib/correo/respuesta_campana.ts:214-218` ·
`supabase/migrations/0258_…:47-49` y `:218` · `supabase/verificaciones.sql:14120`

**Escenario (con valores).** Ramón contesta al correo frío con el asunto:
«RE: liquidación — soy Ramón Treviño, gerente de flotilla, escríbanme a
ramon.trevino@fletesbajio.mx». `procesarRespuestaCampana` inserta
`resumen = 'Contestó pidiendo BAJA: «RE: liquidación — soy Ramón Treviño,
gerente de flotilla, escríbanme a ramon.trevino@fletesbajio.mx»'` (300 chars).

La 0258 exime a `prospecto_contacto` de la purga con esta razón escrita:
*«índice de la relación SIN datos de persona POR DISEÑO … medido: 0 resúmenes
con '@'»*. La medición fue del 28-ago-2026; el escritor de `:216` copia texto
libre del titular sin filtro alguno. La exención es estructural (bloque 206 de
`verificaciones.sql:14120`, `exentas = ['prospecto_contacto','comercial_evento']`),
así que esa fila **no la borra ninguna purga, ni la BAJA, ni nada**.

**Consecuencia.** Titular: el prospecto. **Art. 11 LFPDPPP** (supresión cuando
deja de ser necesario) y **art. 15 fr. IV**: el aviso promete que a los 12 meses
solo queda el registro de la empresa.

**Causa raíz probable.** Una exención justificada por una medición puntual, no
por una invariante que el escritor respete.

---

### [MEDIO] La cancelación ARCO no puede alcanzar los eventos de cámara del titular: la tabla no tiene por dónde ligarlos a él

`supabase/migrations/0286_arco_por_telefono_normalizado.sql:40-157` ·
`supabase/migrations/0203_eventos_seguridad_flota.sql` ·
`src/lib/likida/privacidad.ts:646`

**Escenario (con valores).** Juan Pérez presenta cancelación.
`ejecutar_arco_cancelacion` seudonimiza `operador`, borra `wa_conversacion` y
`envio_mensaje`, anonimiza `incidencia` e `incidencia_evento` y **devuelve
`ok: true`** con la resolución «datos personales anonimizados». Sus filas de
`evento_seguridad_flota` —`url_evento:
'https://cloud.samsara.com/o/1234/fleet/events/998877'` (video de Juan
conduciendo), `lat/lng`, `ocurrido_en`— siguen intactas hasta 365 días
(`purgar_evento_seguridad_flota`, 0288), porque la tabla cuelga de `unidad_id` y
la función no la nombra. El aviso sí las declara como dato suyo: *«la conducta
al volante que reporta la cámara … y una liga al video»* (`privacidad.ts:646`).

**Consecuencia.** Titular: el operador. **Art. 22 y 25 LFPDPPP** (derecho de
cancelación) y **art. 28** (el responsable debe hacerla efectiva); la resolución
que se archiva afirma una anonimización que no ocurrió — evidencia escrita de lo
contrario.

**Causa raíz probable.** El esquema del conector se modeló por vehículo y la
función de cancelación se modeló por `operador_id`; nada las une.

---

### [BAJO] El aviso integral afirma que los eventos de cámara «no tienen fecha de borrado automático» y la mig. 0288 los borra a 180/365 días

`src/lib/likida/privacidad.ts:646` y `:649` ·
`supabase/migrations/0288_…:82-112` (llamada desde `mantenimiento_de_datos`,
`:174`, cron `/api/cron/purgar`)

Los dos párrafos que declaran los eventos de cámara cierran con «**Hoy no tienen
una fecha de borrado automático.**». `purgar_evento_seguridad_flota(180, 365)`
corre cada noche desde la 0288. El aviso declara **peor** de lo que el producto
hace, así que el daño al titular es nulo, pero es una afirmación falsa en un
documento legal firmado y va en contra de la regla del proyecto: un rótulo tiene
que ser verdad. Se anota sin severidad mayor porque no expone ningún dato.

---

## Lo que revisé y está bien

- **La compuerta del canal de WhatsApp.** `processor.ts:1711-1732` bloquea todo
  tratamiento sin aviso puesto, y `:1551-1569` la evalúa **antes** de transcribir
  la nota de voz. La sección «Lo que NO está cerrado» del anexo
  (`52-anexo-subencargados.md`) todavía afirma que «la foto se descarga y se
  manda a Gemini igual» — eso ya no es cierto; es documentación caducada, no un
  hallazgo.
- **LEG-1 cerrado.** `privacidad.ts:1001` y `:1032` describen el flujo real de
  `investigador.ts:352-364`, incluida la asimetría con la redacción del primer
  mensaje (que sí va seudonimizada: `seudonimo.ts`, `lineaDecisor`/`notasSinPersona`
  con prueba que exige que el nombre no viaje).
- **El cofre de credenciales.** AES-256-GCM con llave derivada de entorno, IV
  nuevo por guardado, falla cerrada sin `LIKIDA_COFRE_LLAVE`
  (`conectores/cofre.ts:38-73`). Una credencial de conector se revoca borrando
  la fila o rotando la llave; no hay copia en claro.
- **Seudonimización por defecto del ranking de operadores.**
  `analytics.ts:247-275`: `getStatsPorOperador` devuelve `Operador ·A3F9C1` salvo
  que el llamador pase `{nominal:true}`, y hoy ningún llamador lo hace. Es
  exactamente lo que el aviso promete («estadísticas de uso, sin identificarte»).
- **El pie del aviso de prospectos viaja en los dos primeros toques**
  (`agentes/cola.ts:127` para correo, `mapa-prospectos/mensaje/route.ts:123-129`
  para el borrador de WhatsApp).
- **La degradación honesta del aviso simplificado** cuando falta la liga del
  integral (`privacidad.ts:229-235,332-334`) y `revisarAvisoIntegral` con
  frontera de palabra (`:159-162`).
- **Anexo de subencargados (LEG-6) cerrado**: Stripe y Cal.com están en la tabla
  con la fila que faltaba y con el plazo de 365 días.
- **`ejecutar_arco_cancelacion`** sí alcanza `wa_conversacion` por
  `telefono_normalizado()` (0286) e `incidencia`/`incidencia_evento` acotado al
  titular — lo que la 24 encontró roto está arreglado.

## Lo que NO alcancé a revisar

- **`facturacion/adaptadores/piloto_vision.ts` y `computer_use.ts`**: mandan
  capturas de pantalla del portal del comercio al modelo. `/privacidad:124` las
  declara para el cliente, pero no verifiqué si una captura puede contener datos
  de una persona física distinta del contratante (p. ej. un CFDI a nombre del
  operador visible en la pantalla del portal). Requiere un portal real.
- **Retención efectiva del lado de OpenRouter y de sus subproveedores**: sigue
  siendo el pendiente 1 y 3 del anexo, y no es verificable desde el repo.
- **`logger.info('voz.transcrita', { texto })`** (`processor.ts:1583-1586`)
  escribe la transcripción íntegra de la nota de voz del operador a los logs de
  la plataforma. `redactarTexto` quita RFC y teléfono, pero no nombres ni
  menciones de salud. No pude medir la retención de esos logs ni si algo los
  purga: sin base ni entorno, queda como *no verificable en esta ronda*.
- **`/api/export/jornada` y `/api/export/liquidaciones`**: quién puede
  descargarlos es rubro de seguridad; solo verifiqué que la finalidad de jornada
  esté declarada (`privacidad.ts:738`).
- **La base está en cero** (0 viajes, 0 clientes): nada de lo anterior se pudo
  confirmar contra filas reales. Todo escenario está construido desde el código y
  el esquema.
