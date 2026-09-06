# Cumplimiento legal — auditoría 27

**Nota: 5/10** (antes 6). Razón del movimiento: **mirada más profunda** — el
código no empeoró, la nota anterior estaba inflada. La 26 bajó su veredicto a 6
porque descubrió que el mecanismo de entrega del aviso «estaba ciego a la mitad
del documento que publica» (el integral no entra en `versionAviso`). Esta ronda
midió un escalón más abajo y encontró que, para **cualquier flota que el
producto pueda crear**, el mecanismo no es que esté ciego a la mitad del
integral: **nunca señala el integral en absoluto**, porque la columna que lo
apunta (`tenant.url_aviso_privacidad`) **no tiene un solo escritor en todo el
repositorio**. Los seis elementos que el propio código dice que viven SOLO en el
integral —procedimiento ARCO, comunicación de cambios, cláusula de
transferencias, revocación, contacto del art. 29 y la identificación del dato
sensible— no llegan hoy a ningún titular por ningún camino. Eso no es un hueco
de periferia: es la fr. II del art. 16 sin cumplir en el único canal por el que
entran los datos.

Se acredita, y se verificó línea por línea, **un cierre real de la 26**:
LEG-26-2 (el evento GRAVE de cámara que se guardaba entero sin aviso previo)
quedó cerrado de verdad con la forma mínima de la 0341. De los siete abiertos
restantes, **seis siguen intactos** y el séptimo se «cerró» reescribiendo el
texto en vez del alcance.

**Riesgo mayor de hoy:** ninguna flota creada por el producto puede señalarle a
su chofer dónde está su aviso integral —aunque Likida ya lo aloja y lo renderiza
completo en `/aviso/<tenant>`—, así que el único documento que el chofer recibe
es el simplificado, y ese no enumera su voz, el contenido de su chat, su dato de
salud, su RFC/licencia ni los eventos de cámara.

---

## Verificación de los abiertos de la 26

| Hallazgo de la 26 | Commit que decía cerrarlo | Veredicto de hoy |
|---|---|---|
| LEG-26-1 `versionAviso` no ve el integral (ALTO) | — | **ABIERTO, intacto** (`processor.ts:410,415,432`) |
| LEG-26-2 evento GRAVE de cámara sin aviso (ALTO) | `5c9c1cdd` + `0341` | **CERRADO, verificado** — ver «Lo que revisé y está bien» |
| LEG-26-3 la BAJA no borra cuatro tablas (ALTO) | — | **ABIERTO, intacto** (`respuesta_campana.ts:101-132,214-218`) |
| LEG-26-4 el parte revela lesionados por construcción (ALTO) | — | **ABIERTO, intacto** (`direccion.ts:537,548,637`) |
| LEG-26-5 aviso de prospectos incompleto (MEDIO) | — | **ABIERTO** (no re-medido a fondo) |
| LEG-26-6 `prospecto_contacto` exenta de purga (MEDIO) | — | **ABIERTO, intacto** (`0258:141-152,218`) |
| LEG-26-7 la cancelación ARCO no alcanza los eventos de cámara (MEDIO) | `be94db90` + `0340` | **REINCIDENTE y agravado** — ver LEG-27-5 |
| LEG-26-8 «sin fecha de borrado automático» (BAJO) | — | **ABIERTO, intacto** (`privacidad.ts:646,649`) |

Y los dos commits que la ronda me mandó abrir:

- **`be94db90`** («describir el alcance real de cancelación ARCO»): cambió el
  texto de la resolución, **no el alcance**. El texto nuevo es una enumeración
  **cerrada** de lo conservado y deja fuera al menos tres categorías reales. Es
  el arreglo que se acredita su propia nota; no se acredita. Ver LEG-27-5.
- **`ec88509c`** («redactar datos sensibles del mensaje antes de emitir logs»):
  el arreglo **sí es correcto y completo para lo que hace** (`logger.ts:177,183,
  190,197`: el `msg` pasa por `redactarTexto` antes de consola, Sentry y del POST
  a `/api/client-error`). La objeción es solo de rótulo: lo que redacta son RFC,
  teléfono, CLABE, PAN y UUID — datos **fiscales y patrimoniales**, no «datos
  sensibles» en el sentido del art. 3 fr. VI. No lo reporto como hallazgo porque
  el nombre del commit no cambia el comportamiento de nada.

---

## Hallazgos

### [ALTO] Ninguna flota que el producto pueda crear puede señalar su aviso integral: la columna que lo apunta no tiene escritor

`src/lib/likida/privacidad.ts:334` · `src/lib/likida/repo.ts:1240,1248` ·
`src/lib/admin/qa-motor.ts:230-241` · `src/lib/likida/privacidad.ts:493` ·
`src/app/aviso/[tenant]/page.tsx:60-75` · `src/app/terminos/page.tsx:182`

**Norma** (`normas/lfpdppp-15-16.yaml`, `verificado_fuente_primaria`, texto
literal del art. 16):

> «II. Cuando los datos personales sean obtenidos por cualquier medio
> electrónico, óptico, sonoro, visual, o a través de cualquier otra tecnología,
> deberá ser proporcionado en su modalidad simplificada la que deberá contener
> al menos la información a que se refieren las fracciones I a IV del artículo
> anterior, **y señalar el sitio donde se podrá consultar el aviso de privacidad
> integral**.»

**Escenario (con valores).** Flota `t-9` «Transportes del Bajío SA de CV», dada
de alta con `razon_social` y `domicilio_fiscal` capturados (sin ellos
`getDatosResponsable` devuelve `null` y el gate bloquea todo, que es correcto).
`tenant.url_aviso_privacidad` queda **NULL**, porque:

- `grep -rn "url_aviso_privacidad" src/` devuelve **cero escrituras**: solo
  `repo.ts:1240` (lectura), `startup.ts:310` (una sonda que pide capturarla) y
  `supabase/seed.sql`.
- el **único** `from('tenant').insert(...)` del repositorio es
  `qa-motor.ts:230-241`, que escribe `razon_social` y `domicilio_fiscal` y **no**
  escribe `url_aviso_privacidad` ni `contacto_privacidad`.
- ninguna pantalla de `/admin` ni de `/dashboard` la escribe:
  `grep -rni "url_aviso|urlAviso|aviso_privacidad" src/app/` → 0 resultados.

Juan Pérez manda su primera foto. `ponerAvisoADisposicion` arma el simplificado
y le llega, con su última línea (`privacidad.ts:334`):

> «Aviso completo: **la empresa aún no lo publica.** Escríbeme *PRIVACIDAD* y
> queda registrado para que te lo hagan llegar.»

Juan escribe PRIVACIDAD. `respuestaPrivacidad` cae a la rama degradada
(`privacidad.ts:493`):

> «La empresa todavía no publica la liga con el procedimiento, así que **no
> tengo a dónde mandarte**.»

Mientras tanto `https://app.likida.ai/aviso/t-9` **renderiza el integral
completo**: `AvisoIntegral` solo exige `razon_social` (`page.tsx:60-75`), pinta
las secciones pendientes y funciona. Y `src/app/terminos/page.tsx:182` —el
documento contractual público de Likida— afirma lo contrario de lo que el chat
hace: «Likida lo aloja en `/aviso/<flota>` **y lo entrega por el chat cuando el
operador escribe PRIVACIDAD**».

**Consecuencia.** Titular: todo operador de toda flota. Se incumple el art. 16
fr. II en su último inciso —no se señala el sitio, existiendo el sitio—, y con
él los seis elementos que el comentario de cabecera de `privacidad.ts:513-521`
enumera como exclusivos del integral: **procedimiento ARCO (art. 15 fr. V),
comunicación de cambios (fr. VI), cláusula de transferencias (art. 35),
revocación del consentimiento (art. 7), contacto del art. 29 y oposición al
tratamiento automatizado (art. 26 fr. II)**. Responsable sancionable: la flota
(art. 59 fr. II/III, 100 a 320,000 UMA según el supuesto). El mecanismo roto es
de Likida, y el hueco de producto es exactamente el que la ficha describe: «sin
el mecanismo, la flota no puede cumplir aunque quiera».

Falla **silenciosa**: la sonda de `startup.ts:310` le dice a la flota «actualiza
`tenant.url_aviso_privacidad`» y no hay ninguna pantalla donde hacerlo; la
constancia del art. 16 (`aviso_privacidad_en` + `aviso_privacidad_version`) se
escribe igual, así que la base guarda evidencia de haber cumplido.

**Causa raíz probable.** El integral se construyó como página alojada por Likida
(«por qué lo aloja Likida y no la flota», `privacidad.ts:508-535`) pero el
puntero se siguió leyendo de una columna pensada para la URL propia de la flota,
y nadie cerró el círculo con la URL calculable `${appUrl}/aviso/${tenantId}`.

---

### [ALTO] El aviso simplificado —el único que el chofer recibe con seguridad— no enumera su voz, el contenido de su chat, su dato de salud, su RFC/licencia ni los eventos de cámara

`src/lib/likida/privacidad.ts:277` (contra `:669`, `:674`, `:687`, `:646`,
`:694`, `:812`, `:821`) · `src/lib/likida/processor.ts:1589-1626`

**Norma** (`normas/lfpdppp-15-16.yaml`, texto literal):

> «Artículo 15. El aviso de privacidad deberá contener, al menos, la siguiente
> información: […] **II. Los datos personales que serán sometidos a tratamiento,
> identificando aquéllos que son sensibles**;»
>
> «Artículo 16 […] II. […] deberá ser proporcionado en su modalidad simplificada
> la que deberá contener **al menos la información a que se refieren las
> fracciones I a IV** del artículo anterior […]»

Y el `contexto_verificado` de la misma ficha: «lo exigible en el canal es la
modalidad SIMPLIFICADA — fracciones I a IV del art. 15».

**Escenario (con valores).** El simplificado dice, entero, en su renglón de la
fr. II (`privacidad.ts:277`):

> «Qué se trata: tu nombre y teléfono, las fotos de comprobantes de gasto que
> envíes por aquí (diésel, casetas, alimentación, hospedaje) con sus montos y
> fechas, los avisos del viaje que tú mandes ("ya llegué", "estoy descargando",
> "voy de regreso") con la hora de tu mensaje, y la posición GPS de la unidad
> que traes asignada.»

Contra lo que el **integral** declara como dato tratado y el simplificado calla:

| Dato que el integral enumera | Línea del integral | ¿En el simplificado? |
|---|---|---|
| Las **notas de voz** (audio + transcripción) | `:669` | **No** |
| El **contenido de los mensajes** del chat | `:604` | **No** |
| El **dato de salud** (`hay_lesionados` + el texto del accidente) | `:687` | **No** |
| El **RFC y el número de licencia** (Carta Porte → PAC) | `:674` | **No** |
| Los **eventos de cámara/telemetría** con liga al video | `:646` | **No** |
| El **contacto de emergencia** del titular | `:694` | **No** |

El caso concreto: Juan manda una **nota de voz**. `processor.ts:1589` evalúa la
compuerta del aviso ANTES de transcribir —correcto y a propósito—, le entrega el
simplificado, y acto seguido `transcribirNotaDeVoz` manda el audio **íntegro** a
OpenRouter (`:1610`). El documento que acaba de recibir no menciona la palabra
«voz» ni una vez. Lo mismo con el dato de salud: la fr. II es la única fracción
que la ley obliga a desagregar («identificando aquéllos que son sensibles») y es
justo la que falta.

Y no es un problema de espacio: la prueba `aviso_gps_por_flota.test.ts:84-88`
fija el simplificado en **< 1,900 caracteres** contra un límite de WhatsApp de
4,096. Sobran más de dos mil.

Combinado con el hallazgo anterior —la liga al integral nunca se señala—, el
resultado es que **estas seis categorías no llegan hoy a ningún titular por
ningún camino**.

**Consecuencia.** Titular: todo operador. Se incumple el art. 15 fr. II vía el
art. 16 fr. II en el único canal por el que entran los datos, y el defecto es
más grave en la única categoría que la fracción nombra aparte (sensibles), con
el art. 59 fr. IV encima («en tratándose de infracciones cometidas en el
tratamiento de datos sensibles, las sanciones podrán incrementarse hasta por dos
veces»).

**Causa raíz probable.** El simplificado se congeló en el 22-ago por una razón
buena y verificable (`aviso_gps_por_flota.test.ts:97-105`: un cambio de texto
dispara reenvío masivo), y desde entonces cada tratamiento nuevo que se auditó
—voz, cámara, Carta Porte, salud— se declaró solo en el integral, donde no
cuesta un reenvío.

---

### [ALTO] La firma que dispara el reenvío del aviso nunca ha visto el texto del integral (REINCIDENTE, LEG-26-1, intacto)

`src/lib/likida/processor.ts:410,415,432` · `src/lib/likida/privacidad.ts:844-845`
· `src/lib/agents/chat-tools.ts:172`

**Norma** (`normas/lfpdppp-15-16.yaml`, art. 15): «VI. El procedimiento y medio
por el cual el responsable comunicará a las personas titulares de cambios al
aviso de privacidad».

**Escenario (con valores).** Verificado hoy sin cambios respecto de la 26:

```
410   const texto = avisoSimplificado(datos);
415   if (!(await reclamarEnvioAviso(tenantId, operadorId, versionAviso(texto)))) return 'puesto';
432   await confirmarEnvioAviso(tenantId, operadorId, versionAviso(texto));
```

`versionAviso` se computa **siempre** sobre `avisoSimplificado`. Los únicos otros
llamadores son `qa-motor.ts:286-291` (que hace lo mismo) y la página pública, que
no calcula versión. Para el operador Juan Pérez con `aviso_privacidad_version` =
hash del simplificado del 20-ago, cualquier cambio del integral deja el hash
**idéntico**, `reclamarEnvioAviso` devuelve `false`, y no sale nada.

El integral, en `privacidad.ts:844-845`, afirma lo contrario con todas sus
letras: «Cuando este aviso cambie, **recibes el aviso nuevo por el mismo
WhatsApp** […] **No es una promesa:** el sistema calcula una firma del texto y
reenvía en cuanto deja de coincidir». La firma que describe no es la de ese
texto.

La consecuencia sigue viva y comprobada: la cláusula del asistente del panel
(`privacidad.ts:817`, «ese modelo también puede recibir tu nombre junto con
montos de tus viajes») declara una salida que **ocurre hoy** —
`chat-tools.ts:172` `{ anticipo: v.anticipo, operador: v.operadorNombre }` →
`generateWithTools` → OpenRouter— y ningún titular la ha recibido.

**Consecuencia.** Titular: todo operador con aviso ya entregado. Art. 15 fr. VI
(el procedimiento declarado es estructuralmente insatisfacible para el documento
donde está escrito) y art. 16 para el tratamiento nuevo.

**Causa raíz probable.** `versionAviso` se diseñó como firma del *mensaje de
WhatsApp*; cuando el integral se separó en su propia función nadie extendió el
hash ni le puso prueba que ligara los dos textos.

---

### [ALTO] El parte de incidente sigue revelando por construcción que hubo lesionados, con el nombre del operador (REINCIDENTE, LEG-26-4, intacto)

`src/lib/likida/agentes/direccion.ts:537,548,612-614,637`

**Norma.** `normas/lfpdppp-59.yaml`, art. 59 fr. IV, texto literal: «En
tratándose de infracciones cometidas en el tratamiento de **datos sensibles**,
las sanciones podrán incrementarse hasta por dos veces, los montos
establecidos.» (El estado de salud es sensible; `normas/lfpdppp-26-II.yaml`
también lo nombra al describir el «estado de salud» entre los aspectos
evaluables.)

**Escenario (con valores).** Sin cambios respecto de la 26, verificado línea por
línea. Incidencia `inc-4b2`, flota «Fletes del Norte», `tipo='siniestro'`,
`operador_id=op-9` (Juan Pérez López), `hay_lesionados=true`;
`contacto_emergencia` de `op-9` = {nombre:'María López Ruiz',
parentesco:'esposa', telefono:'5533221100', avisar_si_lesionados:true}.

`aQuienLlamar` solo emite la entrada familiar dentro de
`if (inc.hayLesionados === true)` (`:537`), y el texto que imprime es
(`:548`):

> `Contacto de emergencia — familia de Juan Pérez López (nombre y parentesco: en el expediente, no reproducidos aquí)`

Dos bloques antes, `:614` se niega a afirmar el dato: «¿Hay lesionados? Ya se
contestó en el expediente — este parte no reproduce el dato de salud.» Pero la
rama es un `if` sobre `hayLesionados === true`, así que **renglón de familia ⟺
hay lesionados**. El lector de `cola_aprobacion` —la bandeja de `/admin`, o sea
personal de Likida, fuera del tenant— lee el **nombre completo** del operador y
deduce con certeza el dato de salud. `cola_aprobacion` sigue sin FK a `operador`
ni a `contacto_emergencia`, sin purga para piezas con `prospecto_id` nulo y fuera
de `ejecutar_arco_cancelacion` (0286, que no la nombra).

**Consecuencia.** Titular: el operador (dato sensible) y su familiar (tercero que
nunca aceptó ningún aviso — lo dice el `comment on column` de
`0198_asistencia_siniestros.sql:103`). Art. 22/25 (la cancelación no alcanza la
copia) con el agravante del art. 59 fr. IV.

**Causa raíz probable.** Se redactó el texto sin volver a mirar qué implica la
condición que decide si la línea existe. (Igual que la 26.)

---

### [ALTO] La resolución de cancelación ARCO enumera lo que se conserva y omite tres categorías — incluidos los eventos de cámara, que desde la 0324 SÍ traen `operador_id` (REINCIDENTE agravado, LEG-26-7)

`src/lib/likida/repo.ts:1690-1692` · `src/app/dashboard/arco/page.tsx:25,251-255`
· `supabase/migrations/0340_arco_alcance_cancelacion.sql:6` ·
`supabase/migrations/0286_arco_por_telefono_normalizado.sql:89-160` ·
`supabase/migrations/0324_gps_poll_durable.sql:413-415`

**Norma.** LFPDPPP art. 15 fr. IV (`normas/lfpdppp-15-16.yaml`): «Las opciones y
medios que el responsable ofrezca a las personas titulares para limitar el uso o
divulgación de los datos». Y la determinación del art. 32 se comunica al
titular: lo que se le dice tiene que ser lo que ocurrió.

**Escenario (con valores).** Juan Pérez (`op-1`, flota `t-9`) presenta
cancelación. El contralor aprieta «Ejecutar cancelación». `ejecutar_arco_
cancelacion` (0286) toca exactamente seis cosas: `wa_conversacion` (`:89`),
`envio_mensaje` (`:96`), `incidencia` (`:116`), `incidencia_evento` (`:123`),
`operador` (`:135`, nombre/teléfono/RFC/licencia) y `app_user` (`:146`). Juan
recibe por WhatsApp, literal (`repo.ts:1691`):

> «Se sustituyeron tu nombre y tu teléfono en el registro operativo y se
> eliminaron tus conversaciones. **Se conservan tu identificador de operador, el
> correo de tu cuenta, la referencia del titular en la solicitud y la
> documentación fiscal.** La flota debe revisar esos datos […]»

Es una enumeración **cerrada** («Se conservan A, B, C y D»), y quedan fuera:

1. **`evento_seguridad_flota`** — y aquí está el agravante: la 0324 (`:413-415`)
   **añadió `viaje_id`, `operador_id` y `viaje_folio` a esa tabla** después de la
   auditoría 26. Cuando la 26 escribió su hallazgo, la tabla colgaba solo de
   `unidad_id` y el argumento era «nada las une». Hoy sí las une: las filas con
   `privacidad_minima = false` llevan `operador_id = 'op-1'`, `lat`, `lng`,
   `max_g` y `url_evento = 'https://cloud.samsara.com/o/1234/fleet/events/998877'`
   —el video de Juan al volante— y siguen ahí hasta 365 días
   (`purgar_evento_seguridad_flota(180,365)`, invocada desde
   `mantenimiento_de_datos`, `0335:341`). El aviso las declara como dato suyo
   (`privacidad.ts:646`). La función de cancelación no nombra la tabla.
2. **`contacto_emergencia`** (0198) — `on delete cascade` sobre `operador`, pero
   la cancelación **anonimiza, no borra** al operador, así que la fila sobrevive
   con `nombre='María López Ruiz'`, `telefono='5533221100'`, `parentesco='esposa'`
   ligada a `operador_id='op-1'`. No hay purga para esa tabla (no aparece en
   `mantenimiento_de_datos`).
3. **`jornada_dia` / `jornada_asiento`** (0241, `operador_id not null`) — el
   registro de jornada derivado de GPS, con «la frase del chofer» en
   `jornada_asiento.detalle` (`0241:192-194`). Ni ARCO ni purga.

La pantalla dice lo mismo (`page.tsx:251-255`) y el `comment on function` de la
0340 lo repite. El propio comentario de la 0273 (`:148`) había dejado escrita la
regla que se rompió: «regla para la próxima TABLA: si guarda texto que el titular
escribió, entra a esta función».

**Consecuencia.** Titular: el operador y, en el punto 2, un tercero (su
familiar). Art. 22/25/28 (hacer efectiva la cancelación) y art. 15 fr. IV: la
resolución que se archiva y se comunica es una constancia escrita de un alcance
que no se ejecutó. `be94db90` cambió la afirmación de «quedó anonimizado» a una
lista cerrada incompleta: pasó de una mentira general a una enumeración falsa,
que es más fácil de contrastar ante la autoridad.

**Causa raíz probable.** El alcance se describe enumerando a mano en el texto en
lugar de derivarse del inventario de tablas con `operador_id` que la propia
función tendría que recorrer.

---

### [MEDIO] «Contesta BAJA y se borran tus datos de persona» sigue siendo falso para cuatro tablas (REINCIDENTE, LEG-26-3, intacto)

`src/lib/correo/respuesta_campana.ts:101-132,214-218` ·
`supabase/migrations/0258_purga_satelites_prospecto.sql:141-152,218`

**Norma.** LFPDPPP art. 15 fr. IV (las opciones y medios que el responsable
*ofrezca* tienen que ser los que ejecuta). Aquí Likida es **responsable**, no
persona encargada.

**Escenario (con valores).** Verificado hoy sin cambios: `borrarDatosPersonaPorBaja`
toca tres cosas —`prospecto_persona` (`:106`), `prospecto_correo` (`:113`) y las
columnas de cabecera de `prospecto` (`:122-129`)— y su propio comentario
(`:90-91`) afirma «Mismo criterio de columnas que `purgar_prospecto_persona`»,
que toca seis. Y doce líneas después (`:214-217`) inserta en `prospecto_contacto`
el resumen con el asunto que la persona escribió; el filtro de frialdad de la
purga (`0258:146-149`, `not exists (… prospecto_contacto c … ocurrio_en >=
limite)`) mantiene al prospecto **caliente 365 días más por haber ejercido el
derecho**. El `comment on function` de `0258:218` sigue exentando
`prospecto_contacto` con la razón «sin datos de persona por diseño».

**Consecuencia.** Titular: cualquier persona física del censo de prospección.
Art. 15 fr. IV y la promesa escrita de supresión.

**Causa raíz probable.** El borrado enumera columnas a mano en lugar de invocar
el inventario que la purga ya tiene decidido.

---

### [MEDIO] El aviso dice que un ticket de farmacia «se excluye: no se guarda como dato, no participa en tu liquidación» — y el gasto entra completo con el nombre y el RFC de la farmacia

`src/lib/likida/privacidad.ts:687` · `src/lib/likida/intake/sanitizar.ts:66-69,111-119`
· `src/lib/likida/intake/ocr.ts:620,644` · `src/lib/likida/repo.ts:348-386` ·
`src/lib/likida/facturacion/pendientes.ts:233`

**Norma.** LFPDPPP art. 15 fr. II (`normas/lfpdppp-15-16.yaml`): «Los datos
personales que serán sometidos a tratamiento, **identificando aquéllos que son
sensibles**». El aviso tiene que describir el tratamiento real, no la versión más
cómoda de él.

**Escenario (con valores).** Juan compra su metformina de camino y manda el
ticket como gasto. `sanitizarProducto` (`sanitizar.ts:111-119`) detecta
`"METFORMINA 850MG 30 TABS"` con dos de sus reglas (`\b\d+\s*mg\b` y
`(^|[^a-z])(tab|tabs)\b`) y devuelve `undefined`: el nombre del medicamento **sí**
se descarta. Lo que se guarda igual, en el mismo `insert` de `addGasto`
(`repo.ts:348-386`):

- `rfc_emisor = 'FGU9705194T2'` (columna propia, sin pasar por ningún filtro de
  sensibles),
- `ocr_extra.emisor = 'FARMACIAS GUADALAJARA SA DE CV'` — `ocr.ts:644` la sanea
  con `sanitizarTexto`, **no** con `sanitizarProducto`,
- `ocr_extra.sucursal`, `monto = 320.00`, `fecha`, `imagen_url`.

El gasto entra al cuadre como cualquier otro y su importe sale en la liquidación;
`facturacion/pendientes.ts:233` lo muestra al contralor como `textoTicket:
'FARMACIAS GUADALAJARA SA DE CV'`. El propio `sanitizar.ts:66-69` lo tiene
escrito: «tampoco cubre lo que llega por OTRO campo: el nombre de una farmacia
viaja en `emisor`».

El aviso integral, en cambio, elige **ese mismo ejemplo** para prometer lo
contrario (`privacidad.ts:687`):

> «si en ella aparece por accidente algo sensible (**un ticket de farmacia, por
> ejemplo**), un filtro lo detecta y lo excluye: **no se guarda como dato, no
> participa en tu liquidación**»

**Consecuencia.** Titular: el operador. El patrón ve en su panel «$320 ·
FARMACIAS GUADALAJARA», que es una inferencia de salud sobre un empleado
identificado, después de leer un aviso que le dijo a ese empleado que el caso
estaba cubierto. Art. 15 fr. II (el aviso describe un tratamiento que no es el
real) y, sobre el dato inferido, el agravante del art. 59 fr. IV.

**Causa raíz probable.** El filtro se diseñó sobre el campo `producto` —donde de
verdad se resolvió el problema— y el aviso se redactó describiendo el filtro con
un ejemplo (el ticket entero) más ancho que el filtro.

---

### [MEDIO] `contacto_emergencia` no tiene plazo declarado, ni purga, ni alcance de ARCO — y es dato de un tercero que nunca aceptó nada

`supabase/migrations/0198_asistencia_siniestros.sql:93-104` ·
`src/lib/likida/privacidad.ts:694` ·
`supabase/migrations/0335_db_retencion_r3_forward.sql:315-342` ·
`supabase/migrations/0286_arco_por_telefono_normalizado.sql:135-160`

**Norma.** LFPDPPP art. 15 fr. II y IV. Y el `comment on column` de la propia
0198 (`:103-104`) que fija el criterio del proyecto: «esta fila guarda a un
familiar que **nunca aceptó ningún aviso de privacidad** […] y el aviso de
privacidad del operador debe declararlo **antes** de que se capture el primero».

**Escenario (con valores).** La flota captura a María López Ruiz, esposa de Juan,
tel. 5533221100. Esa fila:

- no aparece en `mantenimiento_de_datos` (`0335:315-342` lista las 17 purgas; no
  está),
- no la toca `ejecutar_arco_cancelacion` (0286 actualiza `operador` en `:135`, y
  `contacto_emergencia` es otra tabla),
- sobrevive a la cancelación porque el `on delete cascade` de `:96` nunca se
  dispara: la función **anonimiza** al operador, no lo borra.

El aviso la declara como dato (`privacidad.ts:694`) pero sin plazo y sin decir
qué pasa con ella si el titular cancela; y el propio texto dice que se guarda
«con esa sola finalidad», lo que un titular lee como «mientras la finalidad
exista».

**Consecuencia.** Titular indirecto: el familiar (un tercero, sin relación con la
flota ni con Likida) y el operador. Art. 15 fr. II/IV. Es el único dato de
tercero que el sistema guarda y el único al que no llega ninguno de los tres
mecanismos (aviso con plazo, purga, ARCO).

**Causa raíz probable.** La tabla nació con la advertencia escrita en su propio
comentario y el ciclo de retención/ARCO se armó tabla por tabla, sin un
inventario que obligara a decidir sobre cada una (que es justo lo que el bloque
206 de `verificaciones.sql` hace para `prospecto` y nadie hizo para `operador`).

---

### [BAJO] El aviso afirma que los eventos de cámara «no tienen fecha de borrado automático» y la purga los borra a 180/365 días (REINCIDENTE, LEG-26-8, intacto)

`src/lib/likida/privacidad.ts:646,649` ·
`supabase/migrations/0335_db_retencion_r3_forward.sql:341`

Los dos párrafos que declaran los eventos de cámara cierran con «**Hoy no tienen
una fecha de borrado automático.**». `mantenimiento_de_datos` invoca
`purgar_evento_seguridad_flota(180, 365)` cada noche (`0335:341`, cron
`/api/cron/purgar`). El aviso declara **peor** de lo que el producto hace, así
que el daño al titular es nulo; pero es una afirmación falsa en un documento
legal y contradice la regla del proyecto: un rótulo tiene que ser verdad. Se
anota sin severidad mayor porque no expone ningún dato.

---

## Lo que revisé y está bien

- **LEG-26-2 está CERRADO de verdad, y bien.** `sincronizar_eventos.ts:718,741-760`:
  cuando `evaluarPrivacidadHistorica` no autoriza (`:158-252`, que resuelve el
  conductor histórico por viaje y exige `operador.aviso_privacidad_en`), un evento
  GRAVE ya **no** se guarda entero. Se guarda en forma mínima —`privacidad_minima:
  true`, `asset_id`, `etiquetas`, `lat`, `lng`, `url_evento`, `max_g`, `viaje_id`,
  `operador_id` y `viaje_folio` todos nulos, hora truncada a la hora UTC
  (`horaOpaca`)— y la 0341 lo **sostiene desde la base** con un CHECK
  (`0341:11-24`) que hace imposible una fila mínima con PII. La cuarentena
  (`:254-283`) guarda solo un token derivado, la hora opaca y el motivo, con el
  comentario que lo justifica en `:266-268`. Es la clase de arreglo que sube una
  nota: cambió el diseño, no el texto.
- **El commit `ec88509c` hace lo que dice.** `logger.ts:177` redacta el `msg` una
  sola vez y las tres salidas (consola `:185`, Sentry `:190`, POST a
  `/api/client-error` `:197`) consumen el mismo valor redactado. Confirmé además
  que la lista blanca de Sentry (`LLAVES_EXTRA_SEGURAS`, documentada en
  `docs/conocimiento/52-anexo-subencargados.md:107-118`) deja fuera `correo`, así
  que el `logger.warn('calcom.webhook.correo_ambiguo', { correo })` de
  `src/app/api/webhook/calcom/route.ts:219` **no** llega a Sentry (sí a la consola
  de Vercel; ver «no alcancé»).
- **La compuerta del canal de WhatsApp.** `processor.ts:1589-1608` evalúa
  `ponerAvisoADisposicion` **antes** de transcribir la nota de voz, y el bloque de
  ROJO que la salta (`:1666-1679`) está acotado a emergencia con tratamiento
  mínimo y razonado por escrito en `:1650-1658`. Es una decisión defendible, no un
  descuido.
- **`ejecutar_arco_cancelacion` sí alcanza lo que dice alcanzar** en las seis
  tablas que nombra: `wa_conversacion` y `envio_mensaje` por
  `telefono_normalizado()` (0286:89-99) —el defecto de la 24 sigue arreglado—, e
  `incidencia`/`incidencia_evento` acotados a las incidencias de ESE titular
  capturadas antes de soltar `operador_id` (`:111-131`).
- **Seudonimización por defecto del ranking de operadores.** `analytics.ts`
  `getStatsPorOperador` sigue devolviendo `Operador ·A3F9C1` salvo `{nominal:true}`,
  y ningún llamador lo pasa.
- **El cofre de credenciales** (`conectores/cofre.ts:38-73`): AES-256-GCM, IV por
  guardado, falla cerrada sin `LIKIDA_COFRE_LLAVE`. Una credencial de conector se
  revoca borrando la fila o rotando la llave.
- **La degradación honesta del aviso simplificado** cuando falta la liga
  (`privacidad.ts:229-235,332-334`) y `revisarAvisoIntegral` con frontera de
  palabra (`:134-198`): el texto **dice** que la liga no existe en vez de mandar
  una rota. El defecto de LEG-27-1 no es la degradación, es que nadie puede salir
  de ella.
- **La página del integral no filtra por existencia de flota**
  (`page.tsx:66`: un id sin forma de UUID cae en `notFound()` antes de tocar la
  base) y lleva `robots: { index: false }` — no es un enumerador de tenants.
- **`purgar_posicion(90)` corre de verdad** (`0335:335`, dentro de
  `mantenimiento_de_datos`), así que el «se borra a los 90 días» del aviso sobre
  las posiciones GPS es cierto.

## Lo que NO alcancé a revisar

- **Retención de los logs de plataforma.** `processor.ts:1622-1625`
  (`logger.info('voz.transcrita', { texto })`) escribe la transcripción íntegra de
  la nota de voz, y `calcom/route.ts:219` el correo de un prospecto en claro
  (`redactarTexto` no tiene regla de email). Ambos llegan a la consola de Vercel.
  No pude medir cuánto vive ahí ni si algo lo purga: sin entorno ni panel de
  Vercel, queda *no verificable en esta ronda*. Es el mismo pendiente que dejó la
  26.
- **LEG-26-5** (aviso de prospectos: respuestas libres de Cal.com, Cal.com y
  Stripe ausentes de la sección de encargadas, plazo real de `comercial_evento`).
  Lo di por abierto por continuidad, sin re-medirlo párrafo por párrafo; la 0327
  tocó `comercial_evento` y podría haber movido el plazo.
- **`facturacion/adaptadores/piloto_vision.ts` y `computer_use.ts`**: mandan
  capturas del portal del comercio al modelo. No verifiqué si una captura puede
  contener datos de una persona física distinta del contratante. Requiere un
  portal real.
- **Retención efectiva del lado de OpenRouter y sus subproveedores**: sigue sin
  ser verificable desde el repo.
- **`ticket_mensaje` / `/admin/soporte`** (escritor nuevo de la 0268): no revisé
  si un ticket puede arrastrar datos del operador de un tenant a la bandeja
  cross-tenant de Likida, que es exactamente el patrón de LEG-27-4.
- **La base está en cero** (0 viajes, 0 clientes): ningún escenario se pudo
  confirmar contra filas reales. Todos están construidos desde el código y el
  esquema, y las líneas citadas están abiertas y leídas.
