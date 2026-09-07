# Cumplimiento legal — auditoría 28

**Nota: 4/10** (antes 5). Razón del movimiento: **mirada más profunda** — el
código no empeoró (el rubro no recibió un solo commit en la ventana), la nota
anterior estaba inflada. Esta ronda hizo lo que ninguna había hecho: **recorrer
un derecho ARCO de punta a punta**, desde el mensaje del chofer hasta la RPC que
lo ejecuta. El recorrido se rompe en el primer eslabón y el resto de la máquina
—ocho migraciones (0053, 0173, 0178, 0262, 0264, 0273, 0286, 0340), dos
auditorías que se acreditaron haberla cableado, dos botones en
`/dashboard/arco`— **es inalcanzable para toda solicitud que el producto crea
por el canal de texto**, que es el canal que el aviso publica.

La 27 midió el ALCANCE de la cancelación (qué tablas toca). Esta midió si la
cancelación **corre**. No corre.

**Riesgo mayor de hoy:** un operador que escribe por WhatsApp «quiero que borren
mis datos» genera una solicitud que su flota **no puede ejecutar** —la RPC la
rechaza con «solicitud sin operador o de otra flota», sobre una solicitud de su
propio operador— y un operador que se opone al tratamiento automatizado
(art. 26 fr. II) **queda sin la bandera que el motor de cuadre lee**, en
silencio, sin log y sin que él se entere: sigue recibiendo «queda registrada tu
solicitud» y sus liquidaciones se siguen cerrando solas.

---

## Verificación de los abiertos de la 27

Ventana de 3 commits, ninguno en código legal. Abrí las nueve líneas citadas por
la 27 y **las nueve siguen ahí, idénticas**. No las re-litigo (la ronda avisó que
repetir la lista no mueve la nota); quedan asentadas como REINCIDENTES con su
`archivo:línea` re-verificado hoy:

| Hallazgo 27 | Sev. | Línea verificada hoy | Veredicto |
|---|---|---|---|
| LEG-27-1 `tenant.url_aviso_privacidad` sin un solo escritor | ALTO | `grep -rn url_aviso_privacidad src/` → solo lecturas: `repo.ts:1240,1248`, `startup.ts:310`, 4 fixtures de prueba | **ABIERTO, intacto** |
| LEG-27-2 el simplificado no enumera voz, chat, salud, RFC/licencia, cámara | ALTO | `privacidad.ts:277` (texto idéntico al citado por la 27) | **ABIERTO, intacto** |
| LEG-27-3 `versionAviso` nunca ve el integral | ALTO | `processor.ts:410,415,432` | **ABIERTO, intacto** |
| LEG-27-4 el parte revela lesionados por construcción | ALTO | `direccion.ts:537,548` (`if (inc.hayLesionados === true)` → renglón con el nombre completo) | **ABIERTO, intacto** |
| LEG-27-5 la resolución de cancelación enumera mal lo conservado | ALTO | `repo.ts:1690-1692`, `dashboard/arco/page.tsx:25,251-255` | **ABIERTO y agravado** — ver LEG-28-1: la enumeración describe una ejecución que en el canal de texto **ni siquiera corre** |
| LEG-27-6 «contesta BAJA y se borran tus datos» falso en 4 tablas | MEDIO | `correo/respuesta_campana.ts:101-132,214-218` | **ABIERTO, intacto** |
| LEG-27-7 el aviso promete que el ticket de farmacia «no se guarda» | MEDIO | `privacidad.ts:687` (frase literal presente hoy) | **ABIERTO, intacto** |
| LEG-27-8 `contacto_emergencia` sin plazo, sin purga, sin ARCO | MEDIO | `0198:93-104`, ausente de `0335:315-342` y de `0286` | **ABIERTO, intacto** |
| LEG-27-9 «los eventos de cámara no tienen fecha de borrado» | BAJO | `privacidad.ts:646,649` vs `0335:341` | **ABIERTO, intacto** |

---

## Hallazgos

### [CRÍTICO] Toda solicitud ARCO nacida del canal de texto se registra con `operador_id = NULL`, y las dos RPC ejecutoras rechazan exactamente esa fila: la cancelación es imposible de ejecutar por el camino que el aviso publica

`src/lib/likida/processor.ts:1385-1396` (en concreto `:1391`) ·
`src/lib/likida/processor.ts:309-315` · `src/lib/likida/repo.ts:1473-1481`
(`:1475`) · `supabase/migrations/0286_arco_por_telefono_normalizado.sql:58-63` ·
`supabase/migrations/0178_fiscal_retencion_arco_y_perfiles_erp.sql:87,152` ·
`supabase/migrations/0173_ejecutor_arco.sql:66` ·
`src/app/dashboard/arco/page.tsx:106-108` · `src/lib/likida/conv.ts:1164-1178`

**Norma** (`normas/lfpdppp-15-16.yaml`, `verificado_fuente_primaria`, texto
literal del art. 15):

> «V. Los mecanismos, medios y procedimientos para ejercer los derechos ARCO, de
> conformidad con lo dispuesto en esta Ley, y»

Y el propio aviso integral que el producto renderiza (`privacidad.ts:774-776`),
bajo el fundamento «LFPDPPP art. 15 fr. V»:

> «**Cómo:** escribe PRIVACIDAD por WhatsApp […] **Plazos de la ley:** la empresa
> tiene **20 días hábiles** para contestarte y **15 días hábiles** más para
> hacerlo efectivo si procede.»

**Escenario (con valores).** Juan Pérez López, operador `op-1` de la flota `t-9`
«Transportes del Bajío SA de CV», teléfono `5215512345678`, dado de alta con ese
teléfono en `operador.telefono`. Manda **un mensaje de texto**: «ya no quiero que
tengan mis datos, denme de baja».

1. `procesarTurno` entra por `processor.ts:1385`: `msg.type === 'text'` y
   `pideAtencionPrivacidad(...)` → `true` (regla `dar de baja mis datos`,
   `privacidad.ts:452`).
2. `buscarTenantPorTelefono('5215512345678')` (`conv.ts:1164-1178`) devuelve
   `t-9`. **Esa consulta lee la fila de `operador` y sólo pide `tenant_id`** —
   tiene el `id` del titular a un `select` de distancia y lo tira.
3. `processor.ts:1391` — literal:
   ```ts
   await atenderPrivacidad(tenantId, null, msg.from, msg.text);
   ```
   El segundo argumento es `operadorId`, y va **`null` fijo**. El bloque
   `return`s en `:1395`, así que el segundo llamador (`:1640`, el único que pasa
   `op.operadorId`) **no se alcanza jamás con un texto**: sólo lo alcanza una
   **nota de voz**, que llega como `type: 'audio'`, esquiva el `if` de `:1385` y
   se convierte en texto en `:1626`.
4. `atenderPrivacidad` → `registrarSolicitudArco` (`processor.ts:309-315`) →
   `repo.ts:1475` `operador_id: opts.operadorId` → se inserta la fila con
   `tipo='cancelacion'`, `titular_ref='5215512345678'`, **`operador_id = NULL`**,
   `vence_en` = hoy + 20 hábiles.
5. Juan recibe «Queda registrada tu solicitud para la empresa» (`privacidad.ts:502`).
6. La contralora abre `/dashboard/arco`, ve el renglón —con **`Titular: —`**,
   porque `listarSolicitudesArco` resuelve el nombre por el join
   `operador:operador_id(nombre)` (`repo.ts:1544`) y ese id es nulo— y aprieta
   **«Ejecutar cancelación»**.
7. `ejecutar_arco_cancelacion` (`0286:58-63`):
   ```sql
   select operador_id, tipo, estado into v_operador, v_tipo, v_estado
     from solicitud_arco where id = p_solicitud and tenant_id = p_tenant;
   if v_operador is null then
     return jsonb_build_object('ok', false, 'motivo', 'solicitud sin operador o de otra flota');
   ```
8. La pantalla imprime (`page.tsx:108`):
   > «No se ejecutó la cancelación: **solicitud sin operador o de otra flota**»

   Sobre la solicitud de su propio operador, de su propia flota. El motivo, además,
   **miente sobre la causa**: manda a la contralora a buscar un problema de
   tenancy que no existe.

El guardarraíl que busqué y no existe: nada más escribe `operador_id`.
`grep -rn "registrarSolicitudArco(" src/` devuelve **un solo llamador**
(`processor.ts:309`); ningún `update` en el repo toca `solicitud_arco.operador_id`
(`repo.ts:1580` fija estado/`resuelta_en`/`resolucion`; `0286:152` fija estado y
evidencia); `/admin/compliance` no tiene un solo `insert` ni `update`. La columna
se escribe una vez, al insertar, y por el canal de texto siempre vale `NULL`.

Y la batería de base **no lo caza porque construye la fila a mano**:
`supabase/verificaciones.sql:8490-8495` inserta
`insert into solicitud_arco (tenant_id, operador_id, tipo, …)` con un
`operador_id` real. El bloque 209 sale verde sobre una forma de fila que la
aplicación nunca produce.

**Consecuencia.** Titular: todo operador que ejerza cancelación por escrito —el
caso normal; escribir es lo que el aviso pide («escribe PRIVACIDAD»). Sus
conversaciones de WhatsApp, su nombre, teléfono, RFC, licencia y el texto libre
de sus incidencias **siguen intactos** después de haber ejercido el derecho.
Responsable sancionable: la flota (art. 22/25 y, por la vía del apercibimiento y
la multa, `normas/lfpdppp-59.yaml` art. 59 fr. I y II, «Multa de 100 a 160,000
veces la Unidad de Medida y Actualización»). Para el equipo: las ocho migraciones
del ejecutor ARCO y las auditorías 19 y 20 —que se acreditaron haber cerrado
«el ARCO que sólo escribe prosa» (`repo.ts:1606-1610`: «Un ARCO que solo escribe
prosa es un ARCO que no se ejerció»)— quedan **revertidas de hecho**: la única
acción que le queda a la flota sobre una solicitud de texto es escribir prosa en
`resolucion` y marcarla `resuelta`.

Detalle que lo vuelve absurdo: **el derecho sí se ejecuta si el chofer lo dice en
una nota de voz.** Ése es el único camino que llega a `processor.ts:1640` con
`op.operadorId`.

**Causa raíz probable.** Al izar el chequeo ARCO por encima de la resolución de
identidad (auditoría 12, para atender al operador dado de baja) se pasó `null`
como identidad, y el comentario de `:1636-1638` declaró redundante al bloque de
abajo —que es el único que sí identifica al titular— sin notar que las dos RPC
ejecutoras exigen esa identidad desde la 0173.

---

### [ALTO] La oposición al tratamiento automatizado no se enciende nunca desde el canal de texto: el `if` que la materializa exige el `operadorId` que ese camino no trae — y falla sin log, sin error y sin decírselo al titular

`src/lib/likida/processor.ts:331-343` · `src/lib/likida/processor.ts:1391` ·
`src/lib/likida/cuadre/desde_db.ts:94` · `src/lib/likida/cuadre/engine.ts:606,430` ·
`supabase/migrations/0100_oposicion_decision_automatizada.sql:28-30` ·
`supabase/migrations/0178_fiscal_retencion_arco_y_perfiles_erp.sql:152`

**Norma** (`normas/lfpdppp-26-II.yaml`, `verificado_fuente_primaria`, texto
literal):

> «Artículo 26. La persona titular tendrá derecho en todo momento y por causa
> legítima a oponerse al tratamiento de sus datos o exigir que se cese en el
> mismo cuando: […] II. Sus datos personales sean objeto de un tratamiento
> automatizado, el cual le produzca efectos jurídicos no deseados o afecte de
> manera significativa sus intereses, derechos o libertades, y estén destinados a
> evaluar, **sin intervención humana**, determinados aspectos personales de la
> misma o analizar o predecir, en particular, su **rendimiento profesional,
> situación económica** […] **fiabilidad o comportamiento**.»

El `impacto_en_producto` de esa misma ficha: «La bandeja del contralor deja de
ser sólo una comodidad: es lo que mantiene el cuadre fuera del supuesto de la
fracción II».

**Escenario (con valores).** Juan Pérez (`op-1`, flota `t-9`) manda **texto**:
«no quiero que un programa decida mis liquidaciones, que las revise una persona,
no el sistema». `pideAtencionPrivacidad` → `true` (`RECHAZA_AUTOMATIZADO`,
`privacidad.ts:431,454`), `tipoDeSolicitudArco` → `'oposicion'`
(`privacidad.ts:864`).

Entra por `processor.ts:1385` → `atenderPrivacidad(tenantId, **null**, …)`. Y en
`processor.ts:331`:

```ts
if (tipo === 'oposicion' && operadorId) {
  const { error } = await supabaseAdmin().from('operador')
    .update({ oposicion_automatizada: new Date().toISOString() })
```

`operadorId` es `null` → **la condición es falsa, no se ejecuta nada, no se
registra nada**. No hay `else`, no hay `logger.warn`. El propio código tiene un
`logger.error('arco.oposicion_no_encendida')` en `:339` para el caso en que el
UPDATE falle — y ese log **es inalcanzable por este camino**, porque nunca se
intenta el UPDATE.

Lo que se pierde, encadenado y verificado línea por línea:

- `operador.oposicion_automatizada` queda `NULL` (0100:28).
- `desde_db.ts:94`: `const oposicionTitular = operador?.oposicionAutomatizada != null;` → `false`.
- `engine.ts:606` no emite la diferencia `oposicion_titular`, que está en
  `REVISAR_OPERATIVO` (`engine.ts:430`) y es lo que obliga a que una persona mire
  la liquidación antes de cerrarla. **El cuadre de Juan se sigue cerrando solo.**
- Juan **no recibe** el mensaje de `:341` («Además, desde ahora tus liquidaciones
  las revisa una persona antes de cerrarse. Queda registrado. 👍»), así que ni
  siquiera puede notar que su derecho no se honró: lo último que leyó fue «Queda
  registrada tu solicitud».
- Y cuando la contralora aprieta «Registrar la oposición» en `/dashboard/arco`,
  `ejecutar_arco_oposicion` (`0178:152`) rebota igual:
  `if v_operador is null or v_tipo <> 'oposicion'` → «solicitud de oposición
  inexistente o de otra flota». Ni la materialización automática ni la constancia
  manual ocurren.

Esto es la **única** de las cuatro letras del ARCO que este producto activa por
sí mismo, y el aviso lo anuncia dos veces (`privacidad.ts:757-759` bajo el
fundamento «LFPDPPP art. 26 fr. II», y `:322` en el simplificado).

**Consecuencia.** Titular: el operador. La flota queda dentro del supuesto de la
fr. II —el cuadre evalúa sus gastos y de ahí sale un descuento de nómina:
«rendimiento profesional», «situación económica» y «fiabilidad» están literales
en el artículo— exactamente sobre el titular que se opuso. Y es **falla
silenciosa**: la base guarda una `solicitud_arco` que acredita que se recibió el
ejercicio, así que la evidencia que queda archivada es la de haber sabido y no
haber hecho.

**Causa raíz probable.** La misma que LEG-28-1: `null` fijo en `processor.ts:1391`.
Aquí, además, el guardarraíl elegido fue `&& operadorId` (saltarse en silencio)
en vez de una rama que grite; en el camino que sí trae identidad ese `&&` nunca
es falso, así que el modo de falla no se veía.

---

### [MEDIO] `acceso` es el tipo por omisión —lo que produce la palabra «PRIVACIDAD» que el aviso manda escribir— y es el único derecho sin ningún camino: se cierra con cinco caracteres y sale una constancia por WhatsApp

`src/lib/likida/privacidad.ts:861-868` (`:867`) ·
`src/app/dashboard/arco/page.tsx:75,257-280` · `src/lib/likida/repo.ts:1569-1599`
(`:1595`) · `supabase/migrations/0286_…sql:64-72`

**Norma** (`normas/lfpdppp-15-16.yaml`, art. 15 fr. V, texto literal): «Los
mecanismos, medios y procedimientos para ejercer los derechos ARCO». Y el aviso
que el producto renderiza (`privacidad.ts:774`): «Tienes derecho a **Acceder** a
tus datos […]».

**Escenario (con valores).** Juan escribe la palabra exacta que el aviso le pide:
`PRIVACIDAD`. `tipoDeSolicitudArco('PRIVACIDAD')` no empata ninguna de las cuatro
reglas y cae al `return 'acceso'` de `:867`. Se inserta `tipo='acceso'`.

En `/dashboard/arco`, para `tipo='acceso'` la pantalla ofrece **sólo** el
formulario de prosa (`page.tsx:257-280`); no hay botón ejecutor —y la propia
`ejecutar_arco_cancelacion` lo rebota a propósito (`0286:64-72`, «esta función
solo ejecuta solicitudes de cancelación»)—. La única validación es
`page.tsx:75`: `if (resolucion.length < 5)`.

La contralora escribe `listo.` (6 caracteres). `resolverSolicitudArco`
(`repo.ts:1580`) pone `estado='resuelta'`, `resuelta_en=now()`, y **manda por
WhatsApp** (`repo.ts:1595`):

> «Tu solicitud de derechos ARCO fue atendida por Transportes del Bajío SA de CV:
> listo.»

Con eso la fila sale de `pendientes` (`page.tsx:161`), del contador de vencidas
(`:166`), de la bandeja de `/admin` (`escalaciones.ts:53-55`, filtro
`.in('estado', ['recibida','en_proceso'])`) y del parte legal semanal
(`backoffice.ts:917`). Nadie —ni la flota, ni Likida, ni la autoridad— puede
distinguir «se le entregaron sus datos» de «se le escribió *listo*»: no existe en
todo `src/` ninguna función que arme el paquete de datos de un titular
(`ls src/app/api/export/` da bitácora-peaje, carta-porte-xml,
facturas-proveedor, jornada, liquidaciones, pdf, poliza — todos de flota, ninguno
de titular).

**Consecuencia.** Titular: todo operador que use la palabra que el aviso publica.
El producto convierte el ejercicio del derecho en una constancia de cumplimiento
—archivada y **notificada al propio titular**— sin ningún acto que la respalde.
Para la flota es peor que no tener registro: es evidencia escrita, con fecha y
con acuse, de una respuesta que no entregó nada.

**Causa raíz probable.** El `'acceso'` se eligió como cajón por omisión de una
clasificación best-effort (`:857-859`, decisión razonada), pero nadie notó que
por omisión cae ahí **la palabra clave que el aviso manda escribir**, y que es el
único de los cuatro tipos sin acto asociado.

---

### [MEDIO] El mecanismo ARCO no atiende el pie de foto: el mismo producto que sí lee captions para una emergencia no los lee para un derecho

`src/lib/likida/processor.ts:1385,1639` (contra `:1666`) ·
`src/lib/likida/processor.ts:106-109`

**Norma:** `normas/lfpdppp-15-16.yaml`, art. 15 fr. V (mecanismos y medios para
ejercer los derechos ARCO), leído contra el aviso: «escribe PRIVACIDAD por el
mismo chat de WhatsApp» (`privacidad.ts:766`).

**Escenario (con valores).** Juan manda una foto de su credencial —lo que el
propio aviso le pide adjuntar, «copia de una identificación oficial»
(`privacidad.ts:775`)— con el pie de foto `PRIVACIDAD, quiero mis datos`. En
WhatsApp eso llega como `type: 'image'` con el caption en `text`
(`processor.ts:106-109`, comentado explícitamente: «o, en una imagen, su
CAPTION»).

Las dos compuertas ARCO exigen `msg.type === 'text'` (`:1385` y `:1639`), así que
**ninguna se activa**. El mensaje sigue de largo y entra al camino de
comprobante: la foto de su identificación se manda al motor de visión como si
fuera un ticket. No se registra ninguna `solicitud_arco` y él no recibe respuesta
al derecho que acaba de ejercer.

Que es un descuido y no un criterio lo demuestra el mismo archivo 280 líneas
abajo: la compuerta de emergencia sí cubre las dos formas —
`if ((msg.type === 'text' || msg.type === 'image') && msg.text)` (`:1666`), con
el comentario «Cubre texto E imagen por su caption».

**Consecuencia.** Titular: el operador que hace justo lo que el aviso le indica
(adjuntar identificación). Su ejercicio se pierde sin acuse y su identificación
oficial acaba procesada como comprobante de gasto por un modelo externo.

**Causa raíz probable.** La compuerta ARCO se escribió antes que la de
emergencia y no se le trasladó la lección del caption cuando ésta se cableó.

---

## Lo que revisé y está bien

- **El gate de rol de las tres server actions.** `dashboard/arco/page.tsx:38-40`
  (`puedeVerRuta && puedeAdministrar`) se comprueba dentro de cada action
  (`:65`, `:96`, `:129`), no sólo en el render: un POST a mano de un `encargado`
  se rechaza. El razonamiento está escrito en `:27-36` y es correcto.
- **Las KPI fallan cerrado.** `page.tsx:191-193`: con `errorCarga` las tres pasan
  `null` (que `KpiTile` pinta «—»), no `0`. «0 vencidas» con la base caída es
  exactamente la mentira que el art. 31 no perdona, y está atendida.
- **La aritmética del plazo.** `dashboard/arco/vencimiento.ts:19-27` distingue
  vencida de «vence pronto», y `venceArco` (`privacidad.ts:876-885`) cuenta sólo
  lunes-viernes. **Ignora los días festivos oficiales**, lo que hace que la fecha
  calculada caiga *antes* que el plazo real: se equivoca contra la flota y a
  favor del titular. Lo verifiqué a propósito y no lo reporto: es conservador.
- **`buscarTenantPorTelefono` se niega ante la ambigüedad.** `conv.ts:1174-1177`:
  `.limit(2)` y `if (filas.length !== 1) return null` — un teléfono en dos flotas
  no elige responsable al azar.
- **El canal responde a quien ya no es operador.** `processor.ts:1385-1394` no
  filtra por `activo`, y sin flota identificable contesta la verdad en vez de
  callar (`:1393`). La población que más ejerce cancelación es justo ésa.
- **`pideAtencionPrivacidad` es tolerante de verdad** (`privacidad.ts:446-456`):
  normaliza acentos y mayúsculas y no exige mensaje exacto.
- **El aislamiento por tenant de la resolución.** `repo.ts:1572-1583`: lee y
  actualiza con `.eq('tenant_id', tenantId)`, y lanza si la solicitud no es de
  esa flota; y `page.tsx:81` **no miente** cuando el WhatsApp no sale («la
  respuesta NO se pudo enviar… entrégala al titular por otro canal»).
- **La nota de voz sí trae identidad.** `processor.ts:1626,1639-1641` es el único
  camino que pasa `op.operadorId`; el gate del aviso corre antes de transcribir
  (`:1589`). Ese camino, y sólo ése, ejecuta ARCO de verdad.
- **`ejecutar_arco_cancelacion` rebota lo que no le toca**: acceso y oposición
  (`0286:64-72`), otra flota y ya cerrada (`:58-63,73-75`), y la app propaga el
  motivo sin convertirlo en éxito (`repo.ts:1680-1685`, fijado en
  `arco_oposicion.test.ts`).

## Lo que NO alcancé a revisar

- **Las transferencias a terceros** (Meta, OpenRouter y sus subproveedores,
  Facturapi/PAC, Stripe, Cal.com). Era el otro tema candidato de la ronda y lo
  dejé entero a propósito para no entregar dos hilos superficiales. Sigue sin ser
  verificable la retención efectiva del lado del proveedor.
- **El ciclo de consentimiento y revocación** (`privacidad.ts:781-787`): qué
  ocurre en el producto cuando alguien revoca. No lo recorrí.
- **La conservación/borrado** más allá de lo que la 27 ya midió
  (`0335`, `mantenimiento_de_datos`).
- **LEG-27-5 en su segundo escalón**: verifiqué que la enumeración sigue igual y
  que ahora describe una ejecución que no corre, pero no re-medí tabla por tabla
  el inventario de `operador_id` que la 27 levantó.
- **Retención de los logs de plataforma** (`processor.ts:1622-1625` escribe la
  transcripción íntegra de la nota de voz; `calcom/route.ts:219` el correo en
  claro). Mismo pendiente de la 26 y la 27: sin panel de Vercel no se mide.
- **La base está en cero** (0 viajes, 0 clientes): ningún escenario se confirmó
  contra filas reales. Todos están construidos leyendo el código y el esquema, y
  cada línea citada la abrí y la leí.
